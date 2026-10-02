import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bindUserModel } from './user-models.ts';

type ObjectValue = Record<string, any>;
type Message = { role: string; content: string | null; tool_calls?: ObjectValue[]; tool_call_id?: string; reasoning_details?: ObjectValue[] };
type Completion = { messages: Message[]; tools: ObjectValue[] };
type Profile = { model: string; apiKey: string; baseURL: string; protocol: string; provider: string; maxTokens: number; contextWindow: number; reasoningEfforts?: string[]; defaultReasoningEffort?: string };
type Entry = { handle: { cancel(): void }; cancelRequested: boolean; released: Promise<void> };
const MAX_BYTES = 524_288;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const toolName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const fail = (): never => { throw new Error('Invalid model protocol'); };

function opaqueReasoning(value: unknown): ObjectValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) return fail();
  return value.map(item => {
    if (!object(item) || item.type !== 'reasoning.encrypted' || item.format !== 'openai-responses-v1'
      || typeof item.id !== 'string' || item.id.length > 256 || typeof item.data !== 'string' || item.data.length > 131072) return fail();
    return { type: item.type, format: item.format, id: item.id, data: item.data };
  });
}

export function validateComputerCompletion(value: unknown): Completion {
  if (!object(value) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 256) return fail();
  if (value.stream !== undefined && typeof value.stream !== 'boolean') return fail();
  const tools = value.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 64) return fail();
  const names = new Set<string>();
  const cleanTools = tools.map(tool => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !object(fn) || !toolName(fn.name) || names.has(fn.name)
      || !object(fn.parameters) || fn.parameters.type !== 'object' || (fn.description !== undefined && typeof fn.description !== 'string')) return fail();
    names.add(fn.name);
    return { type: 'function', function: { name: fn.name, description: fn.description ?? '', parameters: fn.parameters } };
  });
  const pending = new Set<string>();
  const seen = new Set<string>();
  const messages = value.messages.map((item: unknown): Message => {
    if (!object(item) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(item.role)) return fail();
    if (item.content !== null && typeof item.content !== 'string') return fail();
    const msg: Message = { role: item.role, content: item.content };
    if (msg.role === 'tool') {
      if (typeof item.tool_call_id !== 'string' || !pending.delete(item.tool_call_id) || typeof msg.content !== 'string') return fail();
      msg.tool_call_id = item.tool_call_id;
    } else if (pending.size) return fail();
    if (item.tool_calls !== undefined) {
      if (msg.role !== 'assistant' || !Array.isArray(item.tool_calls) || item.tool_calls.length > 32) return fail();
      msg.tool_calls = item.tool_calls.map((call: ObjectValue) => {
        if (!object(call) || typeof call.id !== 'string' || call.id.length > 256 || !call.id || seen.has(call.id)
          || call.type !== 'function' || !object(call.function) || !names.has(call.function.name)
          || typeof call.function.arguments !== 'string' || !object(JSON.parse(call.function.arguments))) return fail();
        pending.add(call.id); seen.add(call.id);
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    if (item.reasoning_details !== undefined) {
      if (msg.role !== 'assistant') return fail();
      msg.reasoning_details = opaqueReasoning(item.reasoning_details);
    }
    return msg;
  });
  if (pending.size) return fail();
  return { messages, tools: cleanTools };
}

export function providerComputerRequest(completion: Completion, model: Profile, effort?: string): { url: string; headers: Record<string, string>; body: ObjectValue } {
  const base = model.baseURL.replace(/\/+$/, '');
  const common = { model: model.model, stream: false };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (model.protocol === 'anthropic_messages') {
    headers['x-api-key'] = model.apiKey; headers['anthropic-version'] = '2023-06-01';
    const messages: ObjectValue[] = [];
    const system: string[] = [];
    for (const msg of completion.messages) {
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
    return { url: `${base.endsWith('/v1') ? base : base + '/v1'}/messages`, headers, body: { ...common, max_tokens: model.maxTokens, system: system.join('\n\n'), messages,
      ...(completion.tools.length ? { tools: completion.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}) } };
  }
  headers.authorization = `Bearer ${model.apiKey}`;
  if (model.protocol === 'responses') {
    const input: ObjectValue[] = [];
    for (const msg of completion.messages) {
      for (const detail of msg.reasoning_details ?? []) input.push({ type: 'reasoning', id: detail.id, encrypted_content: detail.data, summary: [] });
      if (msg.role === 'tool') input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content });
      else {
        if (msg.content) input.push({ role: msg.role, content: msg.content });
        for (const call of msg.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    return { url: `${base}/responses`, headers, body: { ...common, store: false, include: ['reasoning.encrypted_content'], input, max_output_tokens: model.maxTokens,
      ...(effort && effort !== 'none' ? { reasoning: { effort } } : {}),
      ...(completion.tools.length ? { tools: completion.tools.map(t => ({ type: 'function', ...t.function, strict: false })) } : {}) } };
  }
  if (model.protocol !== 'chat_completions') return fail();
  // Personal OpenAI-compatible providers are normalized to "openai" during
  // binding. Match the existing Agents wire by checking Google's actual origin.
  const google = new URL(base).origin === 'https://generativelanguage.googleapis.com';
  return { url: `${base}/chat/completions`, headers, body: { ...common, messages: completion.messages.map(({ reasoning_details: _, ...msg }) => msg),
    ...(model.provider === 'openai' && !google ? { max_completion_tokens: model.maxTokens, store: false } : { max_tokens: model.maxTokens }),
    ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}),
    ...(completion.tools.length ? { tools: completion.tools } : {}) } };
}

export function computerCompletionResponse(raw: ObjectValue, protocol: string, tools: ObjectValue[]): ObjectValue {
  const calls: ObjectValue[] = [];
  const details: ObjectValue[] = [];
  let text = '';
  let finish = 'stop';
  let declaredTools: boolean | undefined;
  if (protocol === 'responses') {
    if (raw.status !== 'completed' || !Array.isArray(raw.output)) return fail();
    for (const item of raw.output) {
      if (item.type === 'message') {
        if (!Array.isArray(item.content)) return fail();
        for (const part of item.content) {
          if (part.type !== 'output_text' || typeof part.text !== 'string') return fail();
          text += part.text;
        }
      } else if (item.type === 'function_call') calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      else if (item.type === 'reasoning') {
        if (typeof item.encrypted_content === 'string') details.push({ type: 'reasoning.encrypted', format: 'openai-responses-v1', id: item.id, data: item.encrypted_content });
        // Provider summaries and unencrypted chain-of-thought are never forwarded.
      } else return fail();
    }
  } else if (protocol === 'anthropic_messages') {
    declaredTools = raw.stop_reason === 'tool_use';
    if (!['end_turn', 'tool_use'].includes(raw.stop_reason) || !Array.isArray(raw.content)) return fail();
    for (const part of raw.content) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part.type === 'tool_use' && object(part.input)) calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
      else return fail();
    }
  } else {
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1) return fail();
    const choice = raw.choices[0];
    declaredTools = choice.finish_reason === 'tool_calls';
    if (!['stop', 'tool_calls'].includes(choice.finish_reason) || choice.message?.refusal) return fail();
    if (choice.message?.content != null && typeof choice.message.content !== 'string') return fail();
    text = choice.message?.content ?? '';
    if (choice.message?.tool_calls !== undefined) {
      if (!Array.isArray(choice.message.tool_calls)) return fail();
      calls.push(...choice.message.tool_calls);
    }
  }
  if (declaredTools !== undefined && declaredTools !== (calls.length > 0)) return fail();
  if (calls.length) finish = 'tool_calls';
  if (!text && !calls.length) return fail();
  const message: Message = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
  // Validate provider-selected tools before returning them to the executor. Tool
  // execution remains exclusively behind the workspace's approval boundary.
  validateComputerCompletion({ tools, messages: [{ role: 'user', content: 'Validate' }, message, ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: '' }))] });
  return { id: `chatcmpl-awwo-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'awwo-model', choices: [{ index: 0, message, finish_reason: finish }] };
}

async function readJSON(source: AsyncIterable<Uint8Array>): Promise<ObjectValue> {
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of source) { size += chunk.length; if (size > MAX_BYTES) return fail(); chunks.push(chunk); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(value)) return fail();
  return value;
}

export async function handleComputerModel(request: IncomingMessage, response: ServerResponse, options: {
  config: any; runtime: 'pi' | 'openai-agents'; active: Map<string, Entry>; sessions: Set<string>; stopping(): boolean;
  resolveModel(config: any, selector: string): Profile; normalizeUsage(raw: unknown, protocol: string): ObjectValue;
  parentObservability(value: unknown, timing: ObjectValue): ObjectValue; observe(model: Profile, traceparent: unknown): (event: ObjectValue) => void;
}): Promise<void> {
  const reply = (status: number, value: ObjectValue) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); } };
  const reject = (status: number, code: string) => reply(status, { error: { code, message: 'The managed model request could not be completed.' } });
  const { config, active, sessions } = options;
  if (!config.ready || options.stopping()) return reject(503, 'RUNTIME_UNAVAILABLE');
  if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reject(415, 'INVALID_CONTENT_TYPE');
  let body: ObjectValue, completion: Completion;
  try {
    body = await readJSON(request);
    if (![body.runId, body.tenantId, body.sessionId].every(identifier) || typeof body.model !== 'string' || body.model.length > 256) return reject(400, 'INVALID_INPUT');
    completion = validateComputerCompletion(body.completion);
  } catch { return reject(400, 'INVALID_INPUT'); }
  if (response.destroyed) return;
  let model: Profile;
  try { model = options.resolveModel(bindUserModel(config, body as any, options.runtime), body.model); }
  catch { return reject(400, 'MODEL_NOT_FOUND'); }
  const effort = (body.effort === '' ? undefined : body.effort) ?? (model.defaultReasoningEffort || undefined);
  if (effort !== undefined && effort !== 'none' && !model.reasoningEfforts?.includes(effort)) return reject(400, 'EFFORT_NOT_SUPPORTED');
  if (Buffer.byteLength(JSON.stringify(completion)) + completion.messages.length * 32 > model.contextWindow - model.maxTokens - 256) return reject(413, 'CONTEXT_LIMIT');
  const sessionKey = `${body.tenantId}:${body.sessionId}`;
  if (options.stopping()) return reject(503, 'RUNTIME_UNAVAILABLE');
  if (active.has(body.runId)) return reject(409, 'RUN_BUSY');
  if (sessions.has(sessionKey)) return reject(409, 'SESSION_BUSY');
  if (active.size >= config.maxConcurrency) return reject(429, 'CAPACITY_EXCEEDED');
  const controller = new AbortController();
  let release!: () => void;
  const entry: Entry = { handle: { cancel: () => controller.abort() }, cancelRequested: false, released: new Promise(resolve => { release = resolve; }) };
  active.set(body.runId, entry); sessions.add(sessionKey);
  const timer = setTimeout(() => controller.abort(), config.timeoutMs); timer.unref();
  const disconnected = () => { if (!response.writableEnded) controller.abort(); };
  response.once('close', disconnected);
  const started = performance.now();
  const observed = options.observe(model, request.headers.traceparent);
  let terminalObserved = false;
  try {
    const provider = providerComputerRequest(completion, model, effort);
    const upstream = await fetch(provider.url, { method: 'POST', headers: provider.headers, body: JSON.stringify(provider.body), redirect: 'error', signal: controller.signal });
    if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); return reject(502, 'PROVIDER_ERROR'); }
    const raw = await readJSON(upstream.body);
    const result = computerCompletionResponse(raw, model.protocol, completion.tools);
    const usage = options.normalizeUsage(raw.usage, model.protocol === 'anthropic_messages' ? 'anthropic' : model.protocol);
    const elapsed = Math.floor(performance.now() - started);
    const observability = options.parentObservability({ version: 1, usage, timing: { setupMs: 0, providerMs: elapsed, providerTtftMs: null } }, { totalMs: elapsed, outcome: 'completed' });
    if (usage.inputTokens !== null && usage.outputTokens !== null) result.usage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.computedTotalTokens };
    observed({ type: 'completed', observability }); terminalObserved = true;
    reply(200, { completion: result, observability });
  } catch { reject(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'CANCELLED' : 'PROVIDER_ERROR'); }
  finally {
    if (!terminalObserved) observed({ type: controller.signal.aborted ? 'cancelled' : 'failed', observability: options.parentObservability(undefined, { totalMs: performance.now() - started, outcome: 'failed' }) });
    clearTimeout(timer); response.off('close', disconnected);
    active.delete(body.runId); sessions.delete(sessionKey); release();
  }
}
