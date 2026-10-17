import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bindUserModel } from './user-models.ts';

type ObjectValue = Record<string, any>;
type Message = { role: string; content: string | null; tool_calls?: ObjectValue[]; tool_call_id?: string; reasoning_details?: ObjectValue[] };
type Completion = { messages: Message[]; tools: ObjectValue[] };
type Profile = { model: string; apiKey: string; baseURL: string; protocol: string; provider: string; maxTokens: number; contextWindow: number; reasoningEfforts?: string[]; defaultReasoningEffort?: string;
  /** Bedrock profiles only: the region the bridge calls and the operator's prompt-cache switch. */
  region?: string; promptCache?: boolean };
type Entry = { handle: { cancel(): void }; cancelRequested: boolean; released: Promise<void> };
/** A worker's way to a Bedrock model for managed execution: one call, sent through the Converse bridge
 *  (bedrock-bridge.ts) and gathered into one Chat Completions answer (gatherChatStream). It rejects with an Error whose
 *  `reason` names what failed. Pi makes the call in an isolated child (pi-worker/bedrock-call.mjs), as its Bedrock runs. */
export type BedrockCall = (model: Profile, body: ObjectValue, signal: AbortSignal) => Promise<ObjectValue>;
const MAX_BYTES = 524_288;
// A streamed answer to one call (the Bedrock bridge's, or LLM Gate's): SSE framing costs far more than the text, so this
// is well above the 2 MiB the API takes back from a worker; the completion gathered from it is what has to fit there.
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
/** The longest line a streamed answer may send (as the Pi worker's usage reader allows): a frame, not a whole answer. */
const MAX_STREAM_LINE = 1_048_576;
/** LLM Gate's origin (the workers' DEFAULTS.llmgate): a Gate profile may carry another provider label (older configs
 *  name it "openai"), and only the URL chooses the destination. */
const LLM_GATE_ORIGIN = 'https://api.clawhunt.site';
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const toolName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
/** What a refusal says of a failure: a label of this module's own, or a provider's error type, never provider text. */
const LABEL = /^[A-Za-z0-9_.:-]{1,120}$/;
const label = (value: unknown, fallback = 'unknown'): string => (typeof value === 'string' && LABEL.test(value) ? value : fallback);
/** A request or an answer that does not hold; `detail` names the check it failed. */
const fail = (detail = 'shape'): never => { throw Object.assign(new Error('Invalid model protocol'), { detail }); };
const detailOf = (error: unknown): string => label((error as ObjectValue | undefined)?.detail, 'shape');
const jsonObject = (text: string, detail: string): ObjectValue => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(detail); }
  return object(value) ? value : fail(detail);
};

function opaqueReasoning(value: unknown): ObjectValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) return fail('reasoning');
  return value.map(item => {
    if (!object(item) || item.type !== 'reasoning.encrypted' || item.format !== 'openai-responses-v1'
      || typeof item.id !== 'string' || item.id.length > 256 || typeof item.data !== 'string' || !item.data || item.data.length > 131072) return fail('reasoning');
    return { type: item.type, format: item.format, id: item.id, data: item.data };
  });
}

export function validateComputerCompletion(value: unknown): Completion {
  if (!object(value) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 256) return fail('messages');
  if (value.stream !== undefined && typeof value.stream !== 'boolean') return fail('stream');
  const tools = value.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 64) return fail('tools');
  const names = new Set<string>();
  const cleanTools = tools.map(tool => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !object(fn) || !toolName(fn.name) || names.has(fn.name)
      || !object(fn.parameters) || fn.parameters.type !== 'object' || (fn.description !== undefined && typeof fn.description !== 'string')) return fail('tool');
    names.add(fn.name);
    return { type: 'function', function: { name: fn.name, description: fn.description ?? '', parameters: fn.parameters } };
  });
  const pending = new Set<string>();
  const seen = new Set<string>();
  const messages = value.messages.map((item: unknown): Message => {
    if (!object(item) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(item.role)) return fail('role');
    if (item.content !== null && typeof item.content !== 'string') return fail('content');
    const msg: Message = { role: item.role, content: item.content };
    if (msg.role === 'tool') {
      if (typeof item.tool_call_id !== 'string' || !pending.delete(item.tool_call_id) || typeof msg.content !== 'string') return fail('tool-result');
      msg.tool_call_id = item.tool_call_id;
    } else if (pending.size) return fail('pending');
    if (item.tool_calls !== undefined) {
      if (msg.role !== 'assistant' || !Array.isArray(item.tool_calls) || item.tool_calls.length > 32) return fail('tool-calls');
      msg.tool_calls = item.tool_calls.map((call: ObjectValue) => {
        if (!object(call) || typeof call.id !== 'string' || call.id.length > 256 || !call.id || seen.has(call.id)) return fail('tool-id');
        if (call.type !== 'function' || !object(call.function) || typeof call.function.arguments !== 'string') return fail('tool-call');
        if (!names.has(call.function.name)) return fail('tool-name');
        jsonObject(call.function.arguments, 'tool-args');
        pending.add(call.id); seen.add(call.id);
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    if (item.reasoning_details !== undefined) {
      if (msg.role !== 'assistant') return fail('reasoning');
      msg.reasoning_details = opaqueReasoning(item.reasoning_details);
    }
    return msg;
  });
  if (pending.size) return fail('pending');
  return { messages, tools: cleanTools };
}

/** The per-call options /internal/computer-model honours, listed in the worker's health so a caller (the API's
 *  assistant router) sends them only to a worker that keeps them; an older worker would ignore them. */
export const COMPUTER_COMPLETION_OPTIONS: readonly string[] = Object.freeze(['thinking', 'maxTokens']);

/** Per-call options. `thinking: false` asks a Chat Completions model served with a chat template (Qwen through
 *  LLM Gate and the like) to skip its hidden reasoning, as the agents workers' disableThinking profiles do;
 *  OpenAI and Google refuse unknown arguments and the other protocols have no such switch, so they never get it.
 *  `maxTokens` lowers the profile's output limit for this call, never raises it. */
export interface ComputerCallOptions { thinking?: boolean; maxTokens?: number }

/** One provider call. `stream` says the call is sent streaming and its answer is to be gathered (gatherChatStream): a
 *  Chat Completions call through LLM Gate, where Cloudflare cuts a response that sends nothing for about 100 s and a call
 *  that is not streamed sends nothing until its last token. Every other call is sent whole, as before. */
export function providerComputerRequest(completion: Completion, model: Profile, effort?: string, options: ComputerCallOptions = {}): { url: string; headers: Record<string, string>; body: ObjectValue; stream?: boolean } {
  const base = model.baseURL.replace(/\/+$/, '');
  const common = { model: model.model, stream: false };
  const maxTokens = options.maxTokens ? Math.min(model.maxTokens, options.maxTokens) : model.maxTokens;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const thread = threadOpening(completion.messages);
  if (model.protocol === 'anthropic_messages') {
    headers['x-api-key'] = model.apiKey; headers['anthropic-version'] = '2023-06-01';
    const messages: ObjectValue[] = [];
    const system: string[] = [];
    for (const msg of thread) {
      if (msg.role === 'system' || msg.role === 'developer') { system.push(msg.content ?? ''); continue; }
      const role = msg.role === 'tool' ? 'user' : msg.role;
      const content: ObjectValue[] = [];
      if (msg.role === 'tool') content.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content });
      else {
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const call of msg.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
      }
      if (!content.length) continue;
      if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
      else messages.push({ role, content });
    }
    return { url: `${base.endsWith('/v1') ? base : base + '/v1'}/messages`, headers, body: { ...common, max_tokens: maxTokens, system: system.join('\n\n'), messages,
      ...(completion.tools.length ? { tools: completion.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}) } };
  }
  headers.authorization = `Bearer ${model.apiKey}`;
  if (model.protocol === 'responses') {
    const input: ObjectValue[] = [];
    for (const msg of thread) {
      for (const detail of msg.reasoning_details ?? []) input.push({ type: 'reasoning', id: detail.id, encrypted_content: detail.data, summary: [] });
      if (msg.role === 'tool') input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content });
      else {
        if (msg.content) input.push({ role: msg.role, content: msg.content });
        for (const call of msg.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    return { url: `${base}/responses`, headers, body: { ...common, store: false, include: ['reasoning.encrypted_content'], input, max_output_tokens: maxTokens,
      ...(effort && effort !== 'none' ? { reasoning: { effort } } : {}),
      ...(completion.tools.length ? { tools: completion.tools.map(t => ({ type: 'function', ...t.function, strict: false })) } : {}) } };
  }
  if (model.protocol !== 'chat_completions') return fail();
  // Personal OpenAI-compatible providers are normalized to "openai" during
  // binding. Match the existing Agents wire by checking Google's actual origin.
  const origin = new URL(base).origin;
  const google = origin === 'https://generativelanguage.googleapis.com';
  const stream = model.provider === 'llmgate' || origin === LLM_GATE_ORIGIN;
  return { url: `${base}/chat/completions`, headers, ...(stream ? { stream } : {}), body: { ...common,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}), messages: thread.map(({ reasoning_details: _, ...msg }) => msg),
    ...(model.provider === 'openai' && !google ? { max_completion_tokens: maxTokens, store: false } : { max_tokens: maxTokens }),
    ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}),
    ...(options.thinking === false && model.provider !== 'openai' && !google ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(completion.tools.length ? { tools: completion.tools } : {}) } };
}

/** The answer of one call as the executor reads it, or a failure whose `detail` names the check the provider's answer
 *  failed: `finish:<reason>` (it stopped short, e.g. finish:length, finish:content_filter, finish:refusal), `refusal`,
 *  `choices`, `content`, `tool-calls`, `tools-mismatch` (it said it called tools and did not, or the other way round),
 *  `empty`, or `tool-id`, `tool-call`, `tool-name` and `tool-args` for a call that does not hold. */
export function computerCompletionResponse(raw: ObjectValue, protocol: string, tools: ObjectValue[]): ObjectValue {
  const calls: ObjectValue[] = [];
  const details: ObjectValue[] = [];
  let text = '';
  let finish = 'stop';
  let declaredTools: boolean | undefined;
  if (protocol === 'responses') {
    if (raw.status !== 'completed') return fail(`finish:${label(raw.status, 'none')}`);
    if (!Array.isArray(raw.output)) return fail('shape');
    for (const item of raw.output) {
      if (item.type === 'message') {
        if (!Array.isArray(item.content)) return fail('content');
        for (const part of item.content) {
          if (part.type !== 'output_text' || typeof part.text !== 'string') return fail(part.type === 'refusal' ? 'refusal' : 'content');
          text += part.text;
        }
      } else if (item.type === 'function_call') calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      else if (item.type === 'reasoning') {
        if (typeof item.encrypted_content === 'string' && item.encrypted_content) details.push({ type: 'reasoning.encrypted', format: 'openai-responses-v1', id: item.id, data: item.encrypted_content });
        // Provider summaries and unencrypted chain-of-thought are never forwarded.
      } else return fail('shape');
    }
  } else if (protocol === 'anthropic_messages') {
    declaredTools = raw.stop_reason === 'tool_use';
    if (!['end_turn', 'tool_use'].includes(raw.stop_reason)) return fail(`finish:${label(raw.stop_reason, 'none')}`);
    if (!Array.isArray(raw.content)) return fail('shape');
    for (const part of raw.content) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part.type === 'tool_use' && object(part.input)) calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
      else return fail('content');
    }
  } else {
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1) return fail('choices');
    const choice = raw.choices[0];
    declaredTools = choice.finish_reason === 'tool_calls';
    if (!['stop', 'tool_calls'].includes(choice.finish_reason)) return fail(`finish:${label(choice.finish_reason, 'none')}`);
    if (choice.message?.refusal) return fail('refusal');
    if (choice.message?.content != null && typeof choice.message.content !== 'string') return fail('content');
    text = choice.message?.content ?? '';
    if (choice.message?.tool_calls !== undefined) {
      if (!Array.isArray(choice.message.tool_calls)) return fail('tool-calls');
      calls.push(...choice.message.tool_calls);
    }
  }
  if (declaredTools !== undefined && declaredTools !== (calls.length > 0)) return fail('tools-mismatch');
  if (calls.length) finish = 'tool_calls';
  if (!text && !calls.length) return fail('empty');
  const message: Message = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
  // Validate provider-selected tools before returning them to the executor. Tool
  // execution remains exclusively behind the workspace's approval boundary.
  validateComputerCompletion({ tools, messages: [{ role: 'user', content: 'Validate' }, message, ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: '' }))] });
  return { id: `chatcmpl-awwo-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'awwo-model', choices: [{ index: 0, message, finish_reason: finish }] };
}

/** The managed-execution engine opens every task's thread with its own greeting, so its first request is the system
 *  prompt, an assistant message ("Hi, I'm AwwO workspace. What would you like me to do?") and only then the user's
 *  message (production, 2026-10-12). Converse refuses a conversation that does not open on a user turn (the bridge
 *  refuses it first), and so may other providers, their chat templates or the gateways in front of them; Qwen through
 *  LLM Gate took it. Such an opening asks nothing, so for every provider its text travels as context at the end of the
 *  system prompt, which stays one message (some chat templates take no second one), and the conversation starts at the
 *  first user message. Only text is moved; an opening with tool calls or tool results stays as it is (the bridge
 *  refuses it). */
export function threadOpening(messages: Message[]): Message[] {
  const first = messages.findIndex(msg => msg.role === 'user');
  if (first <= 0) return messages;
  const opening = messages.slice(0, first);
  if (!opening.some(msg => msg.role === 'assistant') || opening.some(msg => msg.role === 'tool' || msg.tool_calls?.length)) return messages;
  const said = opening.filter(msg => msg.role === 'assistant' && msg.content?.trim()).map(msg => msg.content!.trim());
  const kept = opening.filter(msg => msg.role !== 'assistant');
  if (said.length) {
    const note = `Earlier in this conversation you said:\n${said.join('\n\n')}`;
    const last = kept.findLastIndex(msg => msg.role === 'system' || msg.role === 'developer');
    if (last < 0) kept.unshift({ role: 'system', content: note });
    else kept[last] = { ...kept[last], content: kept[last].content ? `${kept[last].content}\n\n${note}` : note };
  }
  return [...kept, ...messages.slice(first)];
}

/** A Bedrock profile's call goes to the Converse bridge, which answers streaming Chat Completions only: the call is
 *  sent as one streaming request (no reasoning effort and no chat-template switch, which the bridge refuses) and the
 *  stream is gathered back into one completion by gatherChatStream. */
export function bedrockComputerRequest(completion: Completion, model: Profile, options: ComputerCallOptions = {}): { url: string; body: ObjectValue } {
  const maxTokens = options.maxTokens ? Math.min(model.maxTokens, options.maxTokens) : model.maxTokens;
  return { url: `${model.baseURL.replace(/\/+$/, '')}/chat/completions`, body: {
    model: model.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
    messages: threadOpening(completion.messages).map(({ reasoning_details: _, ...msg }) => msg),
    ...(completion.tools.length ? { tools: completion.tools } : {}) } };
}

/** Gathers a streamed Chat Completions answer (`chat.completion.chunk` SSE: the Bedrock bridge's, or LLM Gate's) into
 *  the one non-streaming answer computerCompletionResponse reads: the text, each tool call joined by its index (or, sent
 *  whole without one, by its id), the finish reason and the usage. Hidden reasoning (`reasoning_content` and the like),
 *  comments and empty data lines (keep-alives) are passed over and never forwarded; reading stops at `[DONE]`, which a
 *  gateway may send and then hold the connection open.
 *  An error frame (an `error`, or a `code` or `message` in place of choices), a malformed chunk, or a stream without a
 *  finish reason is a failed call; its `detail` says which: `error:<status>:<type>` (as the bridge names an AWS failure
 *  after the stream began), `error:<type>` (the bridge's own refusal of what the model sent, a gateway's error frame),
 *  `shape`, `content`, `tool-calls`, `size`, `truncated` (it ended without a finish reason) or `unfinished` (`[DONE]`
 *  came without one). */
export async function gatherChatStream(source: AsyncIterable<Uint8Array>): Promise<ObjectValue> {
  type Call = { id: string; name: string; arguments: string };
  const decoder = new TextDecoder();
  const calls: Call[] = [];
  let size = 0, open: string[] = [], opened = 0, text = '', refused = '', finish: string | undefined, usage: ObjectValue | undefined, done = false;
  const kind = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
  // A call's id and name are said once: an empty one says nothing, a different one breaks the call.
  const settle = (slot: Call, key: 'id' | 'name', value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    if (slot[key] && slot[key] !== value) return fail('tool-calls');
    slot[key] = value;
  };
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const chunk = jsonObject(data, 'shape');
    if (chunk.error != null || (chunk.choices == null && (chunk.code != null || chunk.message != null))) {
      const error = object(chunk.error) ? chunk.error : chunk.error != null ? {} : { code: chunk.code };
      const type = kind(error.type) ? error.type : kind(error.code) ? error.code : undefined;
      // `frame` keeps the frame's own code and type, as labels only, for a provider's refusal (a gateway's frame).
      throw Object.assign(new Error('Invalid model protocol'), {
        detail: ['error', ...(Number.isInteger(error.status) ? [error.status] : []), ...(type ? [type] : [])].join(':'),
        frame: { ...(kind(error.code) ? { code: error.code } : {}), ...(kind(error.type) ? { type: error.type } : {}) } });
    }
    if (object(chunk.usage)) usage = chunk.usage;
    if (chunk.choices == null) return;
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) return fail('shape');
    for (const choice of chunk.choices) {
      const delta = object(choice?.delta) ? choice.delta : {};
      if (delta.content != null) { if (typeof delta.content !== 'string') return fail('content'); text += delta.content; }
      // A refusal (OpenAI's) is kept as the answer read whole has it, for computerCompletionResponse to refuse; never forwarded.
      if (delta.refusal != null) { if (typeof delta.refusal !== 'string') return fail('content'); refused += delta.refusal; }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) return fail('tool-calls');
        for (const part of delta.tool_calls) {
          if (!object(part)) return fail('tool-calls');
          let slot: Call | undefined;
          if (part.index !== undefined) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 32) return fail('tool-calls');
            slot = calls[part.index] ??= { id: '', name: '', arguments: '' };
          } else {
            // Sent whole without an index (as some compatible endpoints do): its id says which call it is.
            if (typeof part.id !== 'string' || !part.id) return fail('tool-calls');
            slot = calls.find(known => known?.id === part.id);
            if (!slot) {
              if (calls.length >= 32) return fail('tool-calls');
              slot = calls[calls.length] = { id: '', name: '', arguments: '' };
            }
          }
          settle(slot, 'id', part.id);
          settle(slot, 'name', part.function?.name);
          if (typeof part.function?.arguments === 'string') slot.arguments += part.function.arguments;
        }
      }
      // An empty reason on a chunk before the last one (as some providers send) ends nothing.
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    }
  };
  try {
    read: for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_STREAM_BYTES) return fail('size');
      // The line still open is kept in pieces and joined once it ends, and each chunk is searched once: a stream that
      // sends a long run without a line end costs one pass over it, never one per chunk, and no line may pass 1 MiB.
      const piece = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = piece.indexOf('\n'); end >= 0; end = piece.indexOf('\n', start)) {
        open.push(piece.slice(start, end));
        take(open.join('').replace(/\r$/, ''));
        open = []; opened = 0;
        start = end + 1;
        if (done) break read;
      }
      if (start < piece.length) {
        open.push(piece.slice(start));
        if ((opened += piece.length - start) > MAX_STREAM_LINE) return fail('size');
      }
    }
  } catch (error) {
    // The connection breaking after the answer's finish reason, with no line half read, takes only what comes after
    // the answer (its usage, [DONE]): the answer stands. What the stream said wrong always fails it.
    if (typeof (error as ObjectValue | undefined)?.detail === 'string' || !finish || open.length) throw error;
  }
  if (!done) {
    const rest = open.join('') + decoder.decode();
    if (rest.trim()) take(rest.trim());
  }
  if (!finish) return fail(done ? 'unfinished' : 'truncated');
  // A call whose index skipped another leaves a hole, which some() would pass over.
  if ([...calls].some(call => call === undefined)) return fail('tool-calls');
  const toolCalls = calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
  return { choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(refused ? { refusal: refused } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

async function readJSON(source: AsyncIterable<Uint8Array>, limit = MAX_BYTES): Promise<ObjectValue> {
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of source) { size += chunk.length; if (size > limit) return fail('size'); chunks.push(chunk); }
  return jsonObject(Buffer.concat(chunks).toString('utf8'), 'json');
}

/** Whether a provider answered a streamed call with its stream (Server-Sent Events) rather than one body. */
const eventStream = (upstream: Response): boolean => (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream';

/** A provider request that got no answer: `network`, with the socket's code where it has one (`network:ECONNRESET`). */
function networkFailure(error: unknown): string {
  const code = (error as ObjectValue | undefined)?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? `network:${code}` : 'network';
}

/** How long a stream may send nothing before its close reads as an edge's cut: Cloudflare in front of LLM Gate closes a
 *  response that sends nothing for about 100 s. */
export const EDGE_IDLE_MS = 90_000;

/** A streamed call whose stream closed before its end, on its way (the call's own cuts never come here). Its reason is
 *  `stream:closed:idle` when the stream had sent nothing for `idleMs` or longer first, as an edge's cut of a silent
 *  response ends it, and `stream:closed` for any other close: one the provider or a gateway made at once, which a task's
 *  own words can bring about (a moderation stop, a parser failing on the model's output). Its detail says how: the
 *  socket's code when its connection broke off (`UND_ERR_SOCKET`), `end` when it ended without a finish reason. The
 *  worker's own wait for the next byte running out stays `network:UND_ERR_BODY_TIMEOUT`, as when an answer is read whole. */
function streamClosed(error: unknown, quietMs: number, idleMs: number): { reason: string; detail?: string } {
  const network = error === undefined ? undefined : networkFailure(error);
  if (network === 'network:UND_ERR_BODY_TIMEOUT') return { reason: network };
  return { reason: quietMs >= idleMs ? 'stream:closed:idle' : 'stream:closed',
    detail: network === undefined ? 'end' : network === 'network' ? 'broken' : network.slice('network:'.length) };
}

/** A provider's refusal by its status, and by its own error code or type where its body names one as a label
 *  (`provider:400:context_length_exceeded`, `provider:529:overloaded_error`, `provider:524`); its message is never read. */
function refusal(status: number, body: ObjectValue = {}): string {
  const error = object(body.error) ? body.error : body;
  const kind = [error.code, error.type].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value));
  return `provider:${status}${kind ? `:${kind}` : ''}`;
}

/** The refusal of a provider that answered a non-2xx. Its body is read for its kind only, at most 16 KiB for at most
 *  2 s: a provider that sends an error's headers and then stalls must not hold the call (as computerRefusalWait does in
 *  the API). */
async function providerRefusal(upstream: Response): Promise<string> {
  let body: ObjectValue | undefined;
  const reader = upstream.body?.getReader();
  const stalled = setTimeout(() => { void reader?.cancel().catch(() => {}); }, 2000);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      if ((size += next.value.length) > 16_384) { await reader!.cancel(); break; }
      chunks.push(next.value);
    }
    body = jsonObject(Buffer.concat(chunks).toString('utf8'), 'json');
  } catch { await reader?.cancel().catch(() => {}); }
  finally { clearTimeout(stalled); }
  return refusal(upstream.status, body);
}

export async function handleComputerModel(request: IncomingMessage, response: ServerResponse, options: {
  config: any; runtime: 'pi' | 'openai-agents'; active: Map<string, Entry>; sessions: Set<string>; stopping(): boolean;
  resolveModel(config: any, selector: string): Profile; normalizeUsage(raw: unknown, protocol: string): ObjectValue;
  parentObservability(value: unknown, timing: ObjectValue): ObjectValue; observe(model: Profile, traceparent: unknown): (event: ObjectValue) => void;
  /** The worker's Bedrock call, when it serves Bedrock models to managed execution (it says so on /health as
   *  computerBedrock); without it a Bedrock model is refused as before. */
  bedrockCall?: BedrockCall | null;
  /** How long a stream's silence before its close makes it an edge's cut (EDGE_IDLE_MS); shorter in tests. */
  edgeIdleMs?: number;
}): Promise<void> {
  const received = performance.now();
  const reply = (status: number, value: ObjectValue) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); } };
  // The run and the model a refusal's log line names, once the request has said them.
  const named: { runId?: string; model?: string } = {};
  /** Refuses the call by kind only, in the reply and in one log line: its code and, where they tell more, a reason (what
   *  failed: a provider's status, the network, the model's answer, a cut) and a detail (which check); never provider
   *  text, the call's messages or a key. `counts` go to the log line alone. */
  const reject = (status: number, code: string, reason?: string, detail?: string, counts: Record<string, number> = {}) => {
    const kind = { ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
    console.error(JSON.stringify({ event: 'computer_model_rejected', runtime: options.runtime, ...named, status, code, ...kind, ...counts, ms: Math.round(performance.now() - received) }));
    reply(status, { error: { code, message: 'The managed model request could not be completed.', ...kind } });
  };
  const { config, active, sessions } = options;
  if (!config.ready || options.stopping()) return reject(503, 'RUNTIME_UNAVAILABLE');
  if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reject(415, 'INVALID_CONTENT_TYPE');
  let body: ObjectValue, completion: Completion;
  try { body = await readJSON(request); }
  catch (error) { return reject(400, 'INVALID_INPUT', undefined, `body:${detailOf(error)}`); }
  if (identifier(body.runId)) named.runId = body.runId;
  if (typeof body.model === 'string') named.model = label(body.model, 'invalid');
  if (![body.runId, body.tenantId, body.sessionId].every(identifier) || typeof body.model !== 'string' || body.model.length > 256) return reject(400, 'INVALID_INPUT', undefined, 'fields');
  if ((body.thinking !== undefined && typeof body.thinking !== 'boolean')
    || (body.maxTokens !== undefined && !(Number.isInteger(body.maxTokens) && body.maxTokens >= 1 && body.maxTokens <= 1_000_000))) return reject(400, 'INVALID_INPUT', undefined, 'options');
  try { completion = validateComputerCompletion(body.completion); }
  catch (error) { return reject(400, 'INVALID_INPUT', undefined, `completion:${detailOf(error)}`); }
  if (response.destroyed) return;
  let bound: any, model: Profile;
  try { bound = bindUserModel(config, body as any, options.runtime); }
  catch { return reject(400, 'MODEL_NOT_FOUND', undefined, 'connection'); }
  try { model = options.resolveModel(bound, body.model); }
  catch { return reject(400, 'MODEL_NOT_FOUND', undefined, 'catalog'); }
  // A Bedrock model is served through the worker's Bedrock call (the Converse bridge, which streams only: the call is
  // one streaming request gathered into one answer). A worker without one refuses such a model here, before any
  // capacity is taken or a request leaves the worker.
  const bedrock = model.provider === 'bedrock';
  if (bedrock && !options.bedrockCall) return reject(400, 'MODEL_NOT_SUPPORTED');
  const effort = (body.effort === '' ? undefined : body.effort) ?? (model.defaultReasoningEffort || undefined);
  if (effort !== undefined && effort !== 'none' && !model.reasoningEfforts?.includes(effort)) return reject(400, 'EFFORT_NOT_SUPPORTED');
  const bytes = Buffer.byteLength(JSON.stringify(completion)) + completion.messages.length * 32, limit = model.contextWindow - model.maxTokens - 256;
  if (bytes > limit) return reject(413, 'CONTEXT_LIMIT', undefined, undefined, { bytes, limit });
  const sessionKey = `${body.tenantId}:${body.sessionId}`;
  if (options.stopping()) return reject(503, 'RUNTIME_UNAVAILABLE');
  if (active.has(body.runId)) return reject(409, 'RUN_BUSY');
  if (sessions.has(sessionKey)) return reject(409, 'SESSION_BUSY');
  if (active.size >= config.maxConcurrency) return reject(429, 'CAPACITY_EXCEEDED');
  const controller = new AbortController();
  // Why the call was cut, for its 499: its own time limit, its caller gone, the worker stopping, or a cancel.
  let cut = '';
  const stop = (why: string) => { cut ||= why; controller.abort(); };
  let release!: () => void;
  const entry: Entry = { handle: { cancel: () => stop(options.stopping() ? 'stopping' : 'cancelled') }, cancelRequested: false, released: new Promise(resolve => { release = resolve; }) };
  active.set(body.runId, entry); sessions.add(sessionKey);
  const timer = setTimeout(() => stop('timeout'), config.timeoutMs); timer.unref();
  const disconnected = () => { if (!response.writableEnded) stop('disconnected'); };
  response.once('close', disconnected);
  const started = performance.now();
  const observed = options.observe(model, request.headers.traceparent);
  let terminalObserved = false;
  try {
    let raw: ObjectValue;
    let protocol = model.protocol;
    // An answer gathered from a stream, which readJSON's limit has not held to the size of an answer read whole.
    let gathered = false;
    if (bedrock) {
      const call = bedrockComputerRequest(completion, model, { maxTokens: body.maxTokens });
      try { raw = await options.bedrockCall!(model, call.body, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        // The reason is a label (bedrock-call.mjs), never provider text: safe for the reply and the worker's log.
        return reject(502, 'PROVIDER_ERROR', label((error as ObjectValue)?.reason));
      }
      protocol = 'chat_completions';
      gathered = true;
    } else {
      const provider = providerComputerRequest(completion, model, effort, { thinking: body.thinking, maxTokens: body.maxTokens });
      let upstream: Response;
      try { upstream = await fetch(provider.url, { method: 'POST', headers: provider.headers, body: JSON.stringify(provider.body), redirect: 'error', signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        return reject(502, 'PROVIDER_ERROR', networkFailure(error));
      }
      if (!upstream.ok) {
        const reason = await providerRefusal(upstream);
        // Cut while its error was read: the call is the cut's, not the provider's.
        if (controller.signal.aborted) throw controller.signal.reason;
        return reject(502, 'PROVIDER_ERROR', reason);
      }
      if (!upstream.body) return reject(502, 'PROVIDER_ERROR', 'body');
      if (provider.stream && eventStream(upstream)) {
        // A streamed answer, gathered into one. What broke it is named by kind: the gateway's error frame (provider:200:…,
        // as an error inside a 200 read whole), the stream closed before its end (streamClosed), or what the stream itself
        // said wrong (stream:<detail>: a malformed chunk, more than a stream may carry, [DONE] without a finish reason).
        const events = upstream.body;
        // When the stream last sent anything: the silence before a close tells an edge's cut from the provider's close.
        let heard = performance.now();
        const reading = (async function* () {
          try { for await (const chunk of events) { heard = performance.now(); yield chunk; } }
          catch (cause) { throw Object.assign(new Error('The provider stream broke off'), { broke: cause }); }
        })();
        try { raw = await gatherChatStream(reading); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          const { broke, frame } = (error ?? {}) as ObjectValue;
          // A gateway's error frame is its refusal inside a 200, named as an error inside a 200 read whole is.
          if (frame) return reject(502, 'PROVIDER_ERROR', refusal(200, { error: frame }));
          if (broke === undefined && detailOf(error) !== 'truncated') return reject(502, 'PROVIDER_ERROR', `stream:${detailOf(error)}`);
          const quietMs = Math.round(performance.now() - heard);
          const closed = streamClosed(broke, quietMs, options.edgeIdleMs ?? EDGE_IDLE_MS);
          // The silence goes to the log line alone, so the edge's idle limit can be checked against real closes.
          return reject(502, 'PROVIDER_ERROR', closed.reason, closed.detail, { quietMs });
        }
        gathered = true;
      } else {
        // A call sent whole, or a streamed call answered whole (a gateway's error in a 200, or one that does not stream).
        try { raw = await readJSON(upstream.body); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          // An answer larger than the API takes back is the model's own output; one that is not JSON, or breaks off, is not.
          const detail = detailOf(error);
          if (detail === 'size') return reject(502, 'PROVIDER_ERROR', 'answer', 'size');
          return reject(502, 'PROVIDER_ERROR', detail === 'json' ? 'body' : networkFailure(error));
        }
        // Some gateways answer an error with a 200: it is the provider's refusal, as a non-2xx would have been.
        if (raw.error != null) return reject(502, 'PROVIDER_ERROR', refusal(upstream.status, raw));
      }
    }
    // Past the size of an answer read whole, a gathered answer is the model's own output, refused as that one would be.
    if (gathered && Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES) return reject(502, 'PROVIDER_ERROR', 'answer', 'size');
    let result: ObjectValue;
    try { result = computerCompletionResponse(raw, protocol, completion.tools); }
    catch (error) { return reject(502, 'PROVIDER_ERROR', 'answer', detailOf(error)); }
    const usage = options.normalizeUsage(raw.usage, protocol === 'anthropic_messages' ? 'anthropic' : protocol);
    const elapsed = Math.floor(performance.now() - started);
    const observability = options.parentObservability({ version: 1, usage, timing: { setupMs: 0, providerMs: elapsed, providerTtftMs: null } }, { totalMs: elapsed, outcome: 'completed' });
    if (usage.inputTokens !== null && usage.outputTokens !== null) result.usage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.computedTotalTokens };
    observed({ type: 'completed', observability }); terminalObserved = true;
    reply(200, { completion: result, observability });
  } catch {
    // The provider's and the answer's failures answered above with their reason; what reaches here is a call cut short,
    // or this worker failing on an answer it already held.
    if (controller.signal.aborted) reject(499, 'CANCELLED', cut || 'cancelled');
    else reject(502, 'PROVIDER_ERROR', 'worker');
  }
  finally {
    if (!terminalObserved) observed({ type: controller.signal.aborted ? 'cancelled' : 'failed', observability: options.parentObservability(undefined, { totalMs: performance.now() - started, outcome: 'failed' }) });
    clearTimeout(timer); response.off('close', disconnected);
    active.delete(body.runId); sessions.delete(sessionKey); release();
  }
}
