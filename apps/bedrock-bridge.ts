// Amazon Bedrock Converse behind the OpenAI Chat Completions wire format.
//
// Both Node workers already send every model request through one pinned `fetch`.
// For a Bedrock profile that fetch is this bridge: it accepts exactly the request
// the OpenAI SDK sends to `<bridge base URL>/chat/completions`, calls ConverseStream
// once, and streams the answer back as `chat.completion.chunk` SSE. The SDKs, the
// usage observer and the reasoning counter therefore see one more OpenAI-compatible
// endpoint and need no Bedrock-specific code.
//
// Converse is used because it is the one API every popular Bedrock text model
// shares; Claude, for example, has no Chat Completions endpoint on Bedrock.
//
// The AWS SDK is injected by the caller, so this file imports no package and both
// workers can load it with Node's type stripping (erasable syntax only).
//
// Nothing is invented: content the bridge cannot map faithfully (images, JSON-schema
// output, reasoning effort, sampling penalties, seeds) is refused with a 400 instead of
// being dropped, and a stream that ends without a stop reason, or carries an event or
// content type the bridge does not know, is an error. The adaptations it does make are
// deliberate and listed in docs/awwo-bedrock.md: an empty tool result is sent as
// "(empty result)" because Converse rejects blank text; `parallel_tool_calls: false` is
// enforced by relaying only the first tool call of a turn; request metadata such as
// `store`, `user` or `prompt_cache_key` and a tool's `strict` flag have no Converse
// counterpart and do not change the answer (the workers validate tool arguments).

/** Commercial regions with a Bedrock runtime endpoint. GovCloud and China are excluded. */
export const BEDROCK_REGIONS: readonly string[] = Object.freeze([
  'us-east-1', 'us-east-2', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
]);
/** Path of the bridge's synthetic base URL. It names this adapter and is never sent over the network. */
export const BEDROCK_BRIDGE_PATH = '/awwo-bedrock-converse/v1';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validBedrockRegion(region: unknown): region is string {
  return typeof region === 'string' && BEDROCK_REGIONS.includes(region);
}
export function bedrockOrigin(region: string): string {
  if (!validBedrockRegion(region)) throw new Error('Unsupported Bedrock region');
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}
export function bedrockBridgeBaseURL(region: string): string {
  return `${bedrockOrigin(region)}${BEDROCK_BRIDGE_PATH}`;
}

export type BedrockCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: string };
/** A Bedrock API key (bearer), or SigV4 credentials the parent resolved from its AWS credential chain. */
export type BedrockAuth = { bearerToken: string } | { credentials: BedrockCredentials };

export function validBedrockAuth(value: unknown): value is BedrockAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  const keys = Object.keys(auth);
  if (keys.length === 1 && typeof auth.bearerToken === 'string') return /^[\x21-\x7e]{16,8192}$/.test(auth.bearerToken);
  if (keys.length !== 1 || !auth.credentials || typeof auth.credentials !== 'object' || Array.isArray(auth.credentials)) return false;
  const c = auth.credentials as Record<string, unknown>;
  const allowed = new Set(['accessKeyId', 'secretAccessKey', 'sessionToken', 'expiration']);
  return Object.keys(c).every(key => allowed.has(key))
    && typeof c.accessKeyId === 'string' && /^[A-Z0-9]{16,128}$/.test(c.accessKeyId)
    && typeof c.secretAccessKey === 'string' && /^[\x21-\x7e]{16,256}$/.test(c.secretAccessKey)
    && (c.sessionToken === undefined || (typeof c.sessionToken === 'string' && /^[\x21-\x7e]{16,8192}$/.test(c.sessionToken)))
    && (c.expiration === undefined || (typeof c.expiration === 'string' && !Number.isNaN(Date.parse(c.expiration))));
}

/** The OpenAI SDK requires an API key string; the bridge ignores the header it produces. */
export const BEDROCK_BRIDGE_API_KEY = 'awwo-bedrock-bridge';

type ResolvedCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };

/** A child keeps the credentials it starts with for its whole run (at most a 600 s timeout plus
 *  a 10 s cancel grace), so credentials are renewed while more than a run's length remains. */
export const BEDROCK_CREDENTIAL_REFRESH_MS = 15 * 60_000;
/** A source that cannot issue fresher credentials yet is asked again at most this often. */
const FORCED_REFRESH_INTERVAL_MS = 60_000;
type CredentialProvider = (options?: { forceRefresh?: boolean }) => Promise<ResolvedCredentials>;

/**
 * Resolves the auth a Bedrock run carries to its isolated child: the profile's API key, or
 * short-lived SigV4 credentials from the parent's AWS credential chain (an EC2 instance role).
 * Credentials are renewed while they still outlast a run; the AWS SDK's own cache would keep
 * returning them until five minutes before expiry, so the renewal asks it to refresh. The
 * child never reads the chain itself.
 */
export function createBedrockAuthResolver(loadChain: () => Promise<CredentialProvider>) {
  let provider: CredentialProvider | undefined;
  let cached: ResolvedCredentials | undefined;
  let forcedAt = -Infinity;
  return async (apiKey: string): Promise<BedrockAuth> => {
    if (apiKey) return { bearerToken: apiKey };
    const now = Date.now();
    if (!cached || (cached.expiration && cached.expiration.getTime() - now < BEDROCK_CREDENTIAL_REFRESH_MS)) {
      provider ??= await loadChain();
      const force = cached !== undefined && now - forcedAt >= FORCED_REFRESH_INTERVAL_MS;
      if (force) forcedAt = now;
      try { cached = await provider(force ? { forceRefresh: true } : undefined); }
      catch (error) {
        // A renewal that fails while the current credentials still have a minute left keeps them:
        // a short run can still finish, and the next run asks again.
        if (!cached?.expiration || cached.expiration.getTime() - Date.now() < 60_000) throw error;
      }
    }
    const auth: BedrockAuth = { credentials: {
      accessKeyId: cached.accessKeyId, secretAccessKey: cached.secretAccessKey,
      ...(cached.sessionToken ? { sessionToken: cached.sessionToken } : {}),
      ...(cached.expiration ? { expiration: cached.expiration.toISOString() } : {}),
    } };
    if (!validBedrockAuth(auth)) throw new Error('The AWS credential chain returned unusable credentials');
    return auth;
  };
}

/** The two AWS SDK members the bridge uses, injected so tests can supply a fake. */
export interface BedrockSdk {
  BedrockRuntimeClient: new (config: Record<string, unknown>) => {
    send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<{ stream?: AsyncIterable<Record<string, unknown>> }>;
    destroy?(): void;
  };
  ConverseStreamCommand: new (input: Record<string, unknown>) => unknown;
}

export class BedrockBridgeError extends Error {
  status: number;
  type: string;
  /** True when AWS reported the failure; the bridge's own refusals are not provider outages. */
  upstream: boolean;
  constructor(status: number, type: string, message: string, upstream = false) {
    super(message);
    this.status = status;
    this.type = type;
    this.upstream = upstream;
  }
}
const reject = (message: string): never => { throw new BedrockBridgeError(400, 'invalid_request_error', message); };

type Json = Record<string, unknown>;
type ConverseBlock = Json;
type ConverseMessage = { role: 'user' | 'assistant'; content: ConverseBlock[] };

const REQUEST_FIELDS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p',
  'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'stop', 'store', 'user', 'metadata',
  'n', 'seed', 'prompt_cache_key', 'safety_identifier', 'reasoning_effort', 'response_format',
  'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs',
]);

const plain = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function messageText(content: unknown, role: string): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return reject(`Unsupported ${role} message content`);
  return content.map(part => {
    if (!plain(part) || !['text', 'input_text', 'output_text'].includes(part.type as string) || typeof part.text !== 'string') {
      return reject(`Only text content is supported in ${role} messages`);
    }
    return part.text;
  }).join('');
}

function textBlock(text: string): ConverseBlock[] {
  // Converse rejects blank text blocks; an empty turn contributes nothing.
  return text.trim() ? [{ text }] : [];
}

function toolUseBlock(call: unknown): ConverseBlock {
  if (!plain(call) || call.type !== 'function' || !plain(call.function)
    || typeof call.id !== 'string' || !TOOL_USE_ID.test(call.id)
    || typeof call.function.name !== 'string' || !TOOL_NAME.test(call.function.name)) return reject('Invalid assistant tool call');
  const raw = call.function.arguments;
  let input: unknown = {};
  // The wire format carries arguments as a JSON string; an absent or empty one is a call without arguments.
  if (typeof raw === 'string' && raw.trim()) {
    try { input = JSON.parse(raw); } catch { return reject('Assistant tool call arguments are not JSON'); }
  } else if (raw !== undefined && raw !== '') return reject('Assistant tool call arguments must be a JSON string');
  if (!plain(input)) return reject('Assistant tool call arguments must be a JSON object');
  return { toolUse: { toolUseId: call.id, name: call.function.name, input } };
}

/** Translate a Chat Completions request body into ConverseStream input. Throws BedrockBridgeError(400). */
export function toConverseInput(body: unknown, modelId: string): Json {
  if (!plain(body)) return reject('The request body must be a JSON object');
  for (const key of Object.keys(body)) if (!REQUEST_FIELDS.has(key)) reject(`Unsupported request field: ${key}`);
  if (body.model !== modelId) reject('The request model does not match the configured Bedrock model');
  if (body.stream !== true) reject('Only streaming requests are supported');
  if (body.n !== undefined && body.n !== 1) reject('Only one choice is supported');
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) reject('Reasoning effort is not supported for this Bedrock model');
  for (const key of ['frequency_penalty', 'presence_penalty'] as const) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== 0) reject(`${key} is not supported by Bedrock Converse`);
  }
  if (body.logprobs === true || (body.top_logprobs !== undefined && body.top_logprobs !== null)) reject('Log probabilities are not supported');
  if (body.seed !== undefined && body.seed !== null) reject('seed is not supported by Bedrock Converse');
  if (body.response_format !== undefined && body.response_format !== null
    && !(plain(body.response_format) && body.response_format.type === 'text')) reject('Structured response formats are not supported for this Bedrock model');
  // true (or absent) relays every tool call the model makes; false is enforced by the chunk mapper.
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null && typeof body.parallel_tool_calls !== 'boolean') reject('Invalid parallel_tool_calls');
  if (!Array.isArray(body.messages) || body.messages.length === 0) reject('At least one message is required');

  const system: ConverseBlock[] = [];
  const messages: ConverseMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: ConverseBlock[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    // Converse requires alternating roles; adjacent turns of one role are one message.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  let toolBlocks = false;
  for (const message of body.messages as unknown[]) {
    if (!plain(message) || typeof message.role !== 'string') reject('Invalid message');
    const m = message as Json;
    switch (m.role) {
      case 'system':
      case 'developer':
        system.push(...textBlock(messageText(m.content, 'system')));
        break;
      case 'user':
        push('user', textBlock(messageText(m.content, 'user')));
        break;
      case 'assistant': {
        if (m.refusal !== undefined && m.refusal !== null) reject('Assistant refusals cannot be replayed');
        const blocks = textBlock(messageText(m.content, 'assistant'));
        if (m.tool_calls !== undefined && m.tool_calls !== null) {
          if (!Array.isArray(m.tool_calls)) reject('Invalid assistant tool calls');
          for (const call of m.tool_calls as unknown[]) { blocks.push(toolUseBlock(call)); toolBlocks = true; }
        }
        push('assistant', blocks);
        break;
      }
      case 'tool': {
        if (typeof m.tool_call_id !== 'string' || !TOOL_USE_ID.test(m.tool_call_id)) reject('Invalid tool result');
        const text = messageText(m.content, 'tool');
        push('user', [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: text || '(empty result)' }] } }]);
        toolBlocks = true;
        break;
      }
      default:
        reject('Unsupported message role');
    }
  }
  // Converse requires the conversation to open and close on a user turn. Nothing is
  // fabricated to make a request fit: such a request is refused.
  if (!messages.length || messages[0].role !== 'user') reject('The conversation must start with a user message');
  if (messages.at(-1)!.role !== 'user') reject('The conversation must end with a user message');

  const input: Json = { modelId, messages };
  if (system.length) input.system = system;
  const inference: Json = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) reject('Invalid max tokens');
    inference.maxTokens = maxTokens;
  }
  for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'topP']] as const) {
    const value = body[from];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) reject(`Invalid ${from}`);
    inference[to] = value;
  }
  if (body.stop !== undefined && body.stop !== null) {
    const stops = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stops) || stops.length > 4 || stops.some(stop => typeof stop !== 'string' || !stop)) reject('Invalid stop sequences');
    inference.stopSequences = stops;
  }
  if (Object.keys(inference).length) input.inferenceConfig = inference;

  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) reject('Invalid tools');
  const specs = (tools as unknown[]).map(tool => {
    if (!plain(tool) || tool.type !== 'function' || !plain(tool.function)
      || typeof tool.function.name !== 'string' || !TOOL_NAME.test(tool.function.name)) return reject('Invalid tool definition');
    const fn = tool.function;
    const parameters = fn.parameters ?? { type: 'object', properties: {} };
    if (!plain(parameters)) return reject('Invalid tool parameters');
    return { toolSpec: { name: fn.name, ...(typeof fn.description === 'string' && fn.description ? { description: fn.description } : {}), inputSchema: { json: parameters } } };
  });
  const choice = body.tool_choice;
  if (choice === 'none') {
    // Converse has no "none"; it can only be honoured by not offering tools at all.
    if (toolBlocks) reject('tool_choice "none" cannot be combined with tool history');
  } else if (specs.length) {
    const toolConfig: Json = { tools: specs };
    if (choice === 'required') toolConfig.toolChoice = { any: {} };
    else if (plain(choice) && choice.type === 'function' && plain(choice.function) && typeof choice.function.name === 'string') {
      if (!specs.some(spec => spec.toolSpec.name === (choice.function as Json).name)) reject('tool_choice names an unknown tool');
      toolConfig.toolChoice = { tool: { name: choice.function.name } };
    } else if (choice !== undefined && choice !== null && choice !== 'auto') reject('Unsupported tool_choice');
    input.toolConfig = toolConfig;
  } else if (choice !== undefined && choice !== null && choice !== 'auto') reject('tool_choice requires tools');
  if (toolBlocks && !input.toolConfig) reject('Tool history requires tool definitions');
  return input;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls',
  max_tokens: 'length', model_context_window_exceeded: 'length',
  content_filtered: 'content_filter', guardrail_intervened: 'content_filter',
};
const STREAM_EXCEPTIONS: Record<string, number> = {
  internalServerException: 500, modelStreamErrorException: 502, validationException: 400,
  throttlingException: 429, serviceUnavailableException: 503,
};

const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Converse usage → Chat Completions usage. Cache reads are a subset of prompt tokens, as OpenAI reports them. */
export function chatUsage(usage: unknown): Json | undefined {
  if (!plain(usage) || !nonNegative(usage.inputTokens) || !nonNegative(usage.outputTokens)) return undefined;
  const cacheRead = nonNegative(usage.cacheReadInputTokens) ? usage.cacheReadInputTokens : 0;
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens) ? usage.cacheWriteInputTokens : 0;
  // No total is reported: the observer computes it, so a provider total that counts
  // something else can never be mistaken for a mismatch.
  return {
    prompt_tokens: usage.inputTokens + cacheRead + cacheWrite,
    completion_tokens: usage.outputTokens,
    ...(nonNegative(usage.cacheReadInputTokens) ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } } : {}),
  };
}

const unrelayable = () => new BedrockBridgeError(502, 'api_error', 'Bedrock returned content the bridge cannot relay');
/** The one member a Converse union carries, '' for an empty union; more than one is malformed. */
function unionMember(value: Json): string {
  const members = Object.keys(value).filter(key => value[key] !== undefined);
  if (members.length > 1) throw new BedrockBridgeError(502, 'api_error', 'Unexpected Bedrock stream event');
  return members[0] ?? '';
}
const REASONING_MEMBERS = new Set(['text', 'signature', 'redactedContent']);

export type ChunkMapperOptions = {
  id?: string;
  created?: number;
  /** The request set `parallel_tool_calls: false`: relay only the turn's first tool call. */
  singleToolCall?: boolean;
};

/**
 * Maps one Converse stream into Chat Completions chunks. Returned objects are SSE `data:` payloads.
 *
 * Converse has no portable switch for "at most one tool call per turn". When the request asks
 * for that, the turn ends with its first complete tool call: later tool calls are neither
 * relayed nor executed and never enter the conversation, so the model sees a turn that made
 * one call and asks again for anything else it needs. Usage still covers the whole turn.
 */
export function createChunkMapper(model: string, { id = `chatcmpl-bedrock-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000), singleToolCall = false }: ChunkMapperOptions = {}) {
  let toolIndex = -1;
  let toolOpen = false;
  let toolDropped = false;
  let finish: string | undefined;
  let usage: Json | undefined;
  let done = false;
  const chunk = (delta: Json, finishReason: string | null = null): Json => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  return {
    /** Returns the chunks for one event; throws BedrockBridgeError for an exception or a malformed or unknown event. */
    map(event: unknown): Json[] {
      if (done || !plain(event)) throw new BedrockBridgeError(502, 'api_error', 'Unexpected Bedrock stream event');
      const keys = Object.keys(event).filter(key => event[key] !== undefined);
      if (keys.length !== 1) throw new BedrockBridgeError(502, 'api_error', 'Unexpected Bedrock stream event');
      const [key] = keys;
      const value = event[key];
      if (Object.hasOwn(STREAM_EXCEPTIONS, key)) throw new BedrockBridgeError(STREAM_EXCEPTIONS[key], key, 'The Bedrock stream reported an error', true);
      if (!plain(value)) throw new BedrockBridgeError(502, 'api_error', 'Unexpected Bedrock stream event');
      switch (key) {
        case 'messageStart':
          return [chunk({ role: 'assistant', content: '' })];
        case 'contentBlockStart': {
          const start = value.start ?? {};
          if (!plain(start)) throw unrelayable();
          const member = unionMember(start);
          // Text and reasoning blocks may open without a start member; only tool calls carry one.
          if (member === '') return [];
          if (member !== 'toolUse' || !plain(start.toolUse)) throw unrelayable();
          const tool = start.toolUse;
          if (typeof tool.toolUseId !== 'string' || !TOOL_USE_ID.test(tool.toolUseId) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
            throw new BedrockBridgeError(502, 'api_error', 'Bedrock returned an invalid tool call');
          }
          toolOpen = true;
          toolDropped = singleToolCall && toolIndex >= 0;
          if (toolDropped) return [];
          toolIndex += 1;
          return [chunk({ tool_calls: [{ index: toolIndex, id: tool.toolUseId, type: 'function', function: { name: tool.name, arguments: '' } }] })];
        }
        case 'contentBlockDelta': {
          const delta = value.delta ?? {};
          if (!plain(delta)) throw unrelayable();
          switch (unionMember(delta)) {
            case '':
              return [];
            case 'text':
              if (typeof delta.text !== 'string') throw unrelayable();
              return delta.text ? [chunk({ content: delta.text })] : [];
            case 'toolUse': {
              const input = plain(delta.toolUse) ? delta.toolUse.input : undefined;
              if (!toolOpen || typeof input !== 'string') throw new BedrockBridgeError(502, 'api_error', 'Bedrock returned tool input outside a tool call');
              return input && !toolDropped ? [chunk({ tool_calls: [{ index: toolIndex, function: { arguments: input } }] })] : [];
            }
            case 'reasoningContent': {
              // Reasoning is relayed only as text the worker counts; signatures and redacted
              // blocks carry nothing a reader may see and are dropped.
              const reasoning = delta.reasoningContent;
              if (!plain(reasoning) || !REASONING_MEMBERS.has(unionMember(reasoning) || 'text')) throw unrelayable();
              const text = reasoning.text;
              if (text !== undefined && typeof text !== 'string') throw unrelayable();
              return text ? [chunk({ reasoning_content: text })] : [];
            }
            default:
              // Citations, images and future content types are refused rather than dropped.
              throw unrelayable();
          }
        }
        case 'contentBlockStop':
          toolOpen = false;
          toolDropped = false;
          return [];
        case 'messageStop': {
          const reason = value.stopReason;
          if (typeof reason !== 'string' || !Object.hasOwn(STOP_REASONS, reason)) {
            throw new BedrockBridgeError(502, 'api_error', 'Bedrock ended the response for an unsupported reason');
          }
          finish = STOP_REASONS[reason];
          return [chunk({}, finish)];
        }
        case 'metadata':
          usage = chatUsage(value.usage);
          return usage ? [{ id, object: 'chat.completion.chunk', created, model, choices: [], usage }] : [];
        default:
          // An event this bridge does not know (the SDK's $unknown included) may carry content.
          throw new BedrockBridgeError(502, 'api_error', 'Unexpected Bedrock stream event');
      }
    },
    /** Must be called at the end of the stream. A stream without a stop reason is incomplete. */
    finish(): void {
      done = true;
      if (!finish) throw new BedrockBridgeError(502, 'api_error', 'The Bedrock stream ended before the response was complete');
    },
  };
}

const SDK_STATUS: Record<string, number> = {
  AccessDeniedException: 403, UnrecognizedClientException: 401, ExpiredTokenException: 401,
  ValidationException: 400, ResourceNotFoundException: 404, ThrottlingException: 429,
  ServiceQuotaExceededException: 429, ModelTimeoutException: 408, ModelNotReadyException: 503,
  ServiceUnavailableException: 503, InternalServerException: 500, ModelErrorException: 502,
  ModelStreamErrorException: 502,
};

/** Status and type only: SDK messages can carry account IDs and role ARNs, which never leave the worker. */
export function bridgeFailure(error: unknown): BedrockBridgeError {
  if (error instanceof BedrockBridgeError) return error;
  const e = (error ?? {}) as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === 'string' ? e.name : '';
  const httpStatus = Number.isInteger(e.$metadata?.httpStatusCode) ? e.$metadata!.httpStatusCode as number : undefined;
  const status = SDK_STATUS[name] ?? (httpStatus && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 502);
  return new BedrockBridgeError(status, Object.hasOwn(SDK_STATUS, name) ? name : 'api_error', 'The Bedrock request failed', true);
}

const encoder = new TextEncoder();
const sse = (payload: Json | '[DONE]') => encoder.encode(`data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`);
// `status` lets the workers classify an AWS failure that arrives after the stream began, when the
// HTTP status is already 200 (the OpenAI SDKs raise such a frame without a status of their own).
// The bridge's own refusals (an event it cannot relay, a truncated stream) carry none, so they are
// not reported as a provider outage.
const errorBody = (error: BedrockBridgeError) => ({ error: { message: error.message, type: error.type, code: error.type, ...(error.upstream ? { status: error.status } : {}) } });

function jsonError(error: BedrockBridgeError): Response {
  return new Response(JSON.stringify(errorBody(error)), { status: error.status, headers: { 'content-type': 'application/json' } });
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return reject('Unsupported request body');
}

export type BedrockFetchOptions = {
  region: string;
  model: string;
  auth: BedrockAuth;
  sdk: BedrockSdk;
  /** Extra AWS SDK client settings for tests or an explicit request handler. Never credentials or endpoints. */
  clientOptions?: Record<string, unknown>;
};

/**
 * A `fetch` that serves `POST <bridge base URL>/chat/completions` from Bedrock ConverseStream.
 * Any other URL or method is refused before a network call is made.
 */
export function createBedrockFetch({ region, model, auth, sdk, clientOptions = {} }: BedrockFetchOptions) {
  const endpoint = `${bedrockBridgeBaseURL(region)}/chat/completions`;
  if (!validBedrockAuth(auth)) throw new Error('Invalid Bedrock credentials');
  for (const key of ['credentials', 'token', 'endpoint', 'region', 'authSchemePreference']) {
    if (Object.hasOwn(clientOptions, key)) throw new Error('Bedrock client options cannot override the endpoint or credentials');
  }
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== endpoint || (init.method ?? 'GET').toUpperCase() !== 'POST') {
      return jsonError(new BedrockBridgeError(404, 'not_found_error', 'Unknown bridge endpoint'));
    }
    let command: Json;
    let singleToolCall = false;
    try {
      const raw = await bodyText(init.body);
      if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) reject('The request is too large');
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return reject('The request body is not JSON'); }
      command = toConverseInput(body, model);
      singleToolCall = (body as Json).parallel_tool_calls === false;
    } catch (error) { return jsonError(bridgeFailure(error)); }

    const abort = new AbortController();
    const forward = () => abort.abort(init.signal?.reason);
    if (init.signal?.aborted) forward(); else init.signal?.addEventListener('abort', forward, { once: true });
    const client = new sdk.BedrockRuntimeClient({
      ...clientOptions,
      region,
      endpoint: bedrockOrigin(region),
      // One admitted model call is one provider request: the SDK never retries.
      maxAttempts: 1,
      ...('bearerToken' in auth
        ? { token: { token: auth.bearerToken }, authSchemePreference: ['httpBearerAuth'] }
        : { credentials: { ...auth.credentials, ...(auth.credentials.expiration ? { expiration: new Date(auth.credentials.expiration) } : {}) } }),
    });
    const release = () => { init.signal?.removeEventListener('abort', forward); client.destroy?.(); };
    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      const output = await client.send(new sdk.ConverseStreamCommand(command), { abortSignal: abort.signal });
      if (!output?.stream || typeof output.stream[Symbol.asyncIterator] !== 'function') throw new BedrockBridgeError(502, 'api_error', 'Bedrock returned no stream');
      stream = output.stream;
    } catch (error) {
      release();
      if (abort.signal.aborted) throw abort.signal.reason ?? new DOMException('Aborted', 'AbortError');
      return jsonError(bridgeFailure(error));
    }

    const mapper = createChunkMapper(model, { singleToolCall });
    const iterator = stream[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // A pull that enqueues nothing is not pulled again while its reader waits, so
          // events that map to no chunk (block stops, reasoning signatures) are consumed
          // here until one does, or the stream ends.
          for (;;) {
            const next = await iterator.next();
            if (next.done) {
              mapper.finish();
              controller.enqueue(sse('[DONE]'));
              controller.close();
              release();
              return;
            }
            const payloads = mapper.map(next.value);
            for (const payload of payloads) controller.enqueue(sse(payload));
            if (payloads.length) return;
          }
        } catch (error) {
          release();
          if (abort.signal.aborted) { controller.error(abort.signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
          // A failure after the stream began is an SSE error frame, which the OpenAI SDKs raise.
          controller.enqueue(sse(errorBody(bridgeFailure(error))));
          controller.close();
        }
      },
      async cancel(reason) {
        abort.abort(reason);
        await iterator.return?.().catch(() => undefined);
        release();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
  };
}
