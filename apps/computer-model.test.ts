import assert from 'node:assert/strict';
import { bedrockComputerRequest, computerCompletionResponse, gatherChatStream, providerComputerRequest, threadOpening, validateComputerCompletion } from './computer-model.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createOpenAIAgentsServer } from './openai-agents-worker/server.mjs';
import { createPiServer } from './pi-worker/server.mjs';
import { loadConfig as loadOpenAI } from './openai-agents-worker/config.mjs';
import { loadConfig as loadPi } from './pi-worker/config.mjs';

const token = 'internal-fixture-token-of-at-least-32-bytes';
const tool = { type: 'function', function: { name: 'workspace_exec', description: 'Execute an approved command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
const input = (extra: Record<string, unknown> = {}) => ({ runId: 'run-1', tenantId: 'tenant-1', sessionId: 'session-1', model: 'fixture-model', effort: '', completion: { messages: [{ role: 'user', content: 'Build the project' }], tools: [tool] }, ...extra });
const call = { id: 'call-1', type: 'function', function: { name: 'workspace_exec', arguments: '{"command":"echo verified"}' } };

// Anthropic Messages is served by Pi and Chat Completions by the openai-agents worker, unless `worker` says;
// Pi on Chat Completions binds a Gate model, as the router uses in production.
async function serve(t: any, protocol: string, handler: (body: any, req: any, res: any) => void, overrides: Record<string, string> = {}, worker?: 'pi' | 'openai-agents', serverOptions: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const provider = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ body, headers: req.headers, path: req.url }); handler(body, req, res);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const baseURL = `http://127.0.0.1:${(provider.address() as any).port}`;
  const pi = worker ? worker === 'pi' : protocol === 'anthropic_messages';
  const prefix = pi ? 'AWWO_PI' : 'AWWO_OPENAI_AGENTS';
  const config = (pi ? loadPi : loadOpenAI)({ [`${prefix}_TOKEN`]: token, [`${prefix}_MODEL`]: 'fixture-model', [`${prefix}_API_KEY`]: 'secret-provider-key', [`${prefix}_BASE_URL`]: baseURL + (pi ? '' : '/v1'), [`${prefix}_PROVIDER`]: pi ? (protocol === 'anthropic_messages' ? 'anthropic' : 'llmgate') : 'openai', [`${prefix}_PROTOCOL`]: protocol, ...overrides });
  const app = (pi ? createPiServer : createOpenAIAgentsServer)(config, serverOptions as any);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= app.close();
  t.after(async () => { await close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { calls, origin, baseURL, config, close, send: (body = input(), authorization = `Bearer ${token}`, signal?: AbortSignal) => fetch(`${origin}/internal/computer-model`, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body), signal }) };
}

// The worker's refusals as it logs them: one JSON line each (computer_model_rejected).
function rejections(t: any) {
  const lines: any[] = [];
  t.mock.method(console, 'error', (line: unknown) => {
    let value: any;
    try { value = JSON.parse(String(line)); } catch { return; }
    if (value?.event === 'computer_model_rejected') lines.push(value);
  });
  return lines;
}

test('personal Google binding keeps its compatible Chat wire after provider normalization', async t => {
  const s = await serve(t, 'chat_completions', (_body, _req, res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Verified' }, finish_reason: 'stop' }] })), { AWWO_CREDENTIAL_MODE: 'user' });
  const originalFetch = globalThis.fetch;
  const google = 'https://generativelanguage.googleapis.com/v1beta/openai';
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === `${google}/chat/completions`) return originalFetch(`${s.baseURL}/v1/chat/completions`, init);
    return originalFetch(input, init);
  });
  const selector = `byok_${'a'.repeat(33)}_${'b'.repeat(16)}`;
  const response = await s.send(input({ model: selector, userModel: { id: selector, provider: 'google', model: 'gemini-2.5-flash', baseURL: google, apiKey: 'personal-google-fixture-key', protocol: 'chat_completions', contextWindow: 32768, maxTokens: 4096, reasoningEfforts: [], defaultReasoningEffort: '' } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).completion.choices[0].message.content, 'Verified');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].headers.authorization, 'Bearer personal-google-fixture-key');
  assert.equal(s.calls[0].body.model, 'gemini-2.5-flash');
  assert.ok(!Object.hasOwn(s.calls[0].body, 'store'));
  assert.equal(s.calls[0].body.max_tokens, 4096);
  assert.ok(!Object.hasOwn(s.calls[0].body, 'max_completion_tokens'));
});

test('managed gateway reuses the selected model, accounts real usage and carries tool history across Chat calls', async t => {
  const s = await serve(t, 'chat_completions', (_body, _req, res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call], reasoning_content: 'private reasoning' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } })));
  const first = await s.send(); assert.equal(first.status, 200); const body = await first.json();
  assert.deepEqual(body.completion.choices[0].message.tool_calls, [call]);
  assert.equal(body.observability.usage.inputTokens, 21); assert.equal(body.observability.usage.source, 'provider_raw');
  assert.doesNotMatch(JSON.stringify(body), /secret-provider-key|private reasoning/);
  const second = await s.send(input({ completion: { tools: [tool], messages: [{ role: 'user', content: 'Build' }, body.completion.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'verified' }] } }));
  assert.equal(second.status, 200); await second.body?.cancel();
  assert.equal(s.calls[1].body.model, 'fixture-model'); assert.equal(s.calls[1].body.stream, false);
  assert.equal(s.calls[1].headers.authorization, 'Bearer secret-provider-key');
  assert.equal(s.calls[1].body.messages.at(-1).content, 'verified');
});

test('Responses forwards opaque encrypted state with function results and excludes reasoning summaries', async t => {
  const s = await serve(t, 'responses', (_body, _req, res) => res.end(JSON.stringify({ status: 'completed', output: [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-encrypted-state', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
    { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments },
  ], usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } })));
  const first = await s.send(); assert.equal(first.status, 200); const body = await first.json();
  assert.equal(body.observability.usage.computedTotalTokens, 15); assert.doesNotMatch(JSON.stringify(body), /private reasoning/);
  const second = await s.send(input({ completion: { tools: [tool], messages: [{ role: 'user', content: 'Build' }, body.completion.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'verified' }] } }));
  assert.equal(second.status, 200); await second.body?.cancel();
  assert.equal(s.calls[1].path, '/v1/responses'); assert.equal(s.calls[1].body.store, false);
  assert.deepEqual(s.calls[1].body.input.slice(1), [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-encrypted-state', summary: [] },
    { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments },
    { type: 'function_call_output', call_id: call.id, output: 'verified' },
  ]);
});

test('Anthropic reuses Pi credentials and translates tool_use/tool_result plus raw usage', async t => {
  const s = await serve(t, 'anthropic_messages', (_body, _req, res) => res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 } })));
  const first = await s.send(); assert.equal(first.status, 200); const body = await first.json();
  assert.equal(body.observability.usage.inputTokens, 12); assert.equal(body.observability.usage.outputTokens, 3);
  const second = await s.send(input({ completion: { tools: [tool], messages: [{ role: 'system', content: 'Use tools carefully' }, { role: 'user', content: 'Build' }, body.completion.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'verified' }] } }));
  assert.equal(second.status, 200); await second.body?.cancel();
  assert.equal(s.calls[1].path, '/v1/messages'); assert.equal(s.calls[1].headers['x-api-key'], 'secret-provider-key');
  assert.equal(s.calls[1].body.system, 'Use tools carefully');
  assert.deepEqual(s.calls[1].body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: call.id, content: 'verified' }]);
});

test('admission refuses invalid history, credentials and context before any provider call, naming the check', async t => {
  const s = await serve(t, 'chat_completions', () => assert.fail('No provider request expected'));
  const logged = rejections(t);
  for (const [body, status, code, detail] of [
    [input({ model: 'unknown' }), 400, 'MODEL_NOT_FOUND', 'catalog'],
    [input({ effort: 'high' }), 400, 'EFFORT_NOT_SUPPORTED', undefined],
    [input({ completion: { messages: [{ role: 'assistant', content: null, tool_calls: [call] }], tools: [tool] } }), 400, 'INVALID_INPUT', 'completion:pending'],
    [input({ completion: { messages: [{ role: 'tool', tool_call_id: call.id, content: 'forged result' }] } }), 400, 'INVALID_INPUT', 'completion:tool-result'],
    [input({ completion: { messages: [{ role: 'user', content: 'Build' }, { role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'host_shell', arguments: '{}' } }] }], tools: [tool] } }), 400, 'INVALID_INPUT', 'completion:tool-name'],
    [input({ completion: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Build' }] }] } }), 400, 'INVALID_INPUT', 'completion:content'],
    [input({ runId: '../run' }), 400, 'INVALID_INPUT', 'fields'],
    [input({ completion: { messages: [{ role: 'user', content: '漢'.repeat(20000) }] } }), 413, 'CONTEXT_LIMIT', undefined],
    [input({ completion: { messages: [{ role: 'user', content: 'x'.repeat(600000) }] } }), 400, 'INVALID_INPUT', 'body:size'],
  ] as const) {
    const res = await s.send(body);
    assert.equal(res.status, status);
    const error = (await res.json()).error;
    assert.equal(error.code, code);
    assert.equal(error.detail, detail, code);
    assert.equal(error.reason, undefined);
  }
  const auth = await s.send(input(), 'Bearer wrong'); assert.equal(auth.status, 401); await auth.body?.cancel();
  assert.equal(s.calls.length, 0);
  // One line a refusal, with the call's run and model; the context refusal says by how much, never what the call held.
  assert.deepEqual(logged.map(line => line.code), ['MODEL_NOT_FOUND', 'EFFORT_NOT_SUPPORTED', 'INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT', 'CONTEXT_LIMIT', 'INVALID_INPUT']);
  assert.equal(logged[0].runtime, 'openai-agents');
  assert.equal(logged[0].runId, 'run-1');
  assert.equal(logged[0].model, 'unknown');
  assert.equal(logged[6].runId, undefined);
  const context = logged[7];
  assert.equal(context.status, 413);
  assert.ok(context.bytes > context.limit && context.limit === s.config.models[0].contextWindow - s.config.models[0].maxTokens - 256);
  assert.ok(logged.every(line => Number.isInteger(line.ms) && line.ms >= 0));
  assert.doesNotMatch(JSON.stringify(logged), /漢|forged result|Build|secret-provider-key/);
});

test('a worker without the Converse bridge refuses a Bedrock model before any request or key leaves it', async t => {
  const bedrockKey = 'ABSKbedrockkey000000000000000000';
  const originalFetch = globalThis.fetch;
  const outbound: string[] = [];
  t.mock.method(globalThis, 'fetch', (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target instanceof Request ? target.url : target);
    if (url.includes('amazonaws')) outbound.push(url);
    return originalFetch(target, init);
  });
  // The openai-agents worker has no bridge for managed execution; a Pi worker built without one refuses as before.
  for (const [protocol, model, options] of [['chat_completions', 'bedrock.glm-5', {}], ['anthropic_messages', 'bedrock.gemma-3-27b', { bedrockCall: null }]] as const) {
    const s = await serve(t, protocol, () => assert.fail('No provider request expected'), { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: bedrockKey }, undefined, options);
    const response = await s.send(input({ model }));
    assert.equal(response.status, 400, protocol);
    assert.equal((await response.json()).error.code, 'MODEL_NOT_SUPPORTED');
    assert.equal(s.calls.length, 0);
  }
  assert.deepEqual(outbound, []);
});

// The two AWS SDK members the bridge uses; `turn` yields the Converse stream events of one answer.
function fakeConverse(turn: (input: any) => AsyncIterable<Record<string, unknown>>) {
  const sent: any[] = [];
  class ConverseStreamCommand { input: any; constructor(input: any) { this.input = input; } }
  class BedrockRuntimeClient {
    record: any;
    constructor(clientConfig: any) { this.record = { clientConfig }; sent.push(this.record); }
    async send(command: any) { this.record.input = command.input; return { stream: turn(command.input) }; }
    destroy() {}
  }
  return { sdk: { BedrockRuntimeClient, ConverseStreamCommand }, sent };
}

// The Pi worker's managed-execution Bedrock call (pi-worker/bedrock-call.mjs), made here in-process with a fake SDK
// rather than in its child; the child itself is tested in pi-worker/bedrock-call.test.mjs.
async function inProcessCall(sdk: unknown, seen: any[] = []) {
  const [{ createBedrockFetch }, { bedrockCall }] = await Promise.all([import('./bedrock-bridge.ts'), import('./pi-worker/bedrock-call.mjs')]);
  return async (model: any, body: any) => {
    seen.push(model);
    const answer = await bedrockCall({ region: model.region, model: model.model, auth: { bearerToken: model.apiKey }, url: `${model.baseURL}/chat/completions`, body: JSON.stringify(body) },
      { load: async () => ({ createBedrockFetch, sdk }) });
    if (!answer.ok) throw Object.assign(new Error('The Bedrock call failed'), { reason: answer.reason });
    return answer.raw;
  };
}

test('Pi serves a Bedrock model to managed execution through the Converse bridge and gathers its stream', async t => {
  const turns = [
    async function* () {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Running it. ' } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_Ab12', name: 'workspace_exec' } } } };
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"command":' } } } };
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"echo verified"}' } } } };
      yield { contentBlockStop: { contentBlockIndex: 1 } };
      yield { messageStop: { stopReason: 'tool_use' } };
      yield { metadata: { usage: { inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 2 } } };
    },
    async function* () {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'private reasoning' } } } };
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Verified.' } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 60, outputTokens: 3 } } };
    },
  ];
  const fake = fakeConverse(() => turns[fake.sent.length - 1]());
  const profiles: any[] = [];
  const bedrockCall = await inProcessCall(fake.sdk, profiles);
  const originalFetch = globalThis.fetch;
  const outbound: string[] = [];
  t.mock.method(globalThis, 'fetch', (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target instanceof Request ? target.url : target);
    if (url.includes('amazonaws')) outbound.push(url);
    return originalFetch(target, init);
  });
  const s = await serve(t, 'anthropic_messages', () => assert.fail('No other provider expected'),
    { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' }, 'pi', { bedrockCall });
  const health = await (await fetch(`${s.origin}/health`)).json();
  assert.equal(health.computerBedrock, true);
  // thinking: false is the router's Qwen switch: a Bedrock call never carries it (the bridge would refuse the field).
  const first = await s.send(input({ model: 'bedrock.gemma-3-27b', thinking: false, maxTokens: 900 }));
  assert.equal(first.status, 200);
  const body = await first.json();
  const message = body.completion.choices[0].message;
  assert.equal(body.completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, 'Running it. ');
  assert.deepEqual(message.tool_calls, [{ id: 'tooluse_Ab12', type: 'function', function: { name: 'workspace_exec', arguments: '{"command":"echo verified"}' } }]);
  assert.equal(body.observability.usage.inputTokens, 42);
  assert.equal(body.observability.usage.outputTokens, 9);
  assert.equal(profiles[0].provider, 'bedrock');
  const sent = fake.sent[0].input;
  assert.equal(sent.inferenceConfig.maxTokens, 900);
  assert.deepEqual(sent.messages, [{ role: 'user', content: [{ text: 'Build the project' }] }]);
  assert.equal(sent.toolConfig.tools[0].toolSpec.name, 'workspace_exec');
  // The tool result goes back as Converse expects, and the model's reasoning never comes out.
  const second = await s.send(input({ model: 'bedrock.gemma-3-27b', completion: { tools: [tool], messages: [{ role: 'user', content: 'Build the project' }, message, { role: 'tool', tool_call_id: 'tooluse_Ab12', content: 'verified' }] } }));
  assert.equal(second.status, 200);
  const answer = await second.json();
  assert.equal(answer.completion.choices[0].message.content, 'Verified.');
  assert.doesNotMatch(JSON.stringify(answer), /private reasoning/);
  assert.deepEqual(fake.sent[1].input.messages.at(-1), { role: 'user', content: [{ toolResult: { toolUseId: 'tooluse_Ab12', content: [{ text: 'verified' }] } }] });
  assert.equal(s.calls.length, 0);
  assert.deepEqual(outbound, []);
});

test('a managed-execution thread that opens with the engine\'s greeting reaches Bedrock at its user turn, the greeting as context', async t => {
  const fake = fakeConverse(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '51 JPH.' } } };
    yield { messageStop: { stopReason: 'end_turn' } };
    yield { metadata: { usage: { inputTokens: 30, outputTokens: 4 } } };
  });
  const bedrockCall = await inProcessCall(fake.sdk);
  const s = await serve(t, 'anthropic_messages', () => assert.fail('No other provider expected'),
    { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' }, 'pi', { bedrockCall });
  // The engine's first request of every task on production (2026-10-12): its system prompt, its greeting, the user.
  const greeting = "Hi, I'm AwwO workspace. What would you like me to do?";
  const opened = (messages: unknown[]) => input({ model: 'bedrock.gemma-3-27b', completion: { tools: [tool], messages } });
  const response = await s.send(opened([{ role: 'system', content: 'You are AwwO workspace.' }, { role: 'assistant', content: greeting }, { role: 'user', content: 'Build the project' }]));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).completion.choices[0].message.content, '51 JPH.');
  const sent = fake.sent[0].input;
  assert.deepEqual(sent.messages, [{ role: 'user', content: [{ text: 'Build the project' }] }]);
  assert.deepEqual(sent.system, [{ text: `You are AwwO workspace.\n\nEarlier in this conversation you said:\n${greeting}` }]);
  assert.equal(sent.toolConfig.tools[0].toolSpec.name, 'workspace_exec');
  // An opening that called tools is not rewritten: the bridge refuses it, by kind, before any request is sent.
  const refused = await s.send(opened([{ role: 'assistant', content: null, tool_calls: [{ ...call, id: 'tooluse_Op1' }] },
    { role: 'tool', tool_call_id: 'tooluse_Op1', content: 'done' }, { role: 'user', content: 'Build the project' }]));
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).error.reason, 'bedrock:400:invalid_request_error');
  assert.equal(fake.sent.length, 1);
  // Later calls of the same task keep the greeting as context and replay the tool turns as Converse expects.
  const message = { role: 'assistant', content: null, tool_calls: [{ ...call, id: 'tooluse_Ab12' }] };
  const body = bedrockComputerRequest({ tools: [tool], messages: [{ role: 'system', content: 'S' }, { role: 'assistant', content: greeting },
    { role: 'user', content: 'Build the project' }, message, { role: 'tool', tool_call_id: 'tooluse_Ab12', content: 'verified' }] }, { model: 'm', baseURL: 'http://b', maxTokens: 64 } as any).body;
  assert.deepEqual(body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool']);
  // Nothing to move: a thread that opens on its user turn, or an empty greeting, is sent as it came (less the greeting).
  assert.deepEqual(threadOpening([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]), [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  assert.deepEqual(threadOpening([{ role: 'assistant', content: '  ' }, { role: 'user', content: 'U' }]), [{ role: 'user', content: 'U' }]);
  // Without a system prompt the greeting becomes one; with several, it joins the last.
  assert.deepEqual(threadOpening([{ role: 'assistant', content: 'G' }, { role: 'user', content: 'U' }]),
    [{ role: 'system', content: 'Earlier in this conversation you said:\nG' }, { role: 'user', content: 'U' }]);
  assert.deepEqual(threadOpening([{ role: 'system', content: 'A' }, { role: 'developer', content: 'B' }, { role: 'assistant', content: 'G' }, { role: 'user', content: 'U' }]),
    [{ role: 'system', content: 'A' }, { role: 'developer', content: 'B\n\nEarlier in this conversation you said:\nG' }, { role: 'user', content: 'U' }]);
});

test('every provider gets the thread at its user turn, the engine\'s greeting in its one system prompt', async t => {
  const greeting = "Hi, I'm AwwO workspace. What would you like me to do?";
  const note = `You are AwwO workspace.\n\nEarlier in this conversation you said:\n${greeting}`;
  const opened = input({ completion: { tools: [tool], messages: [{ role: 'system', content: 'You are AwwO workspace.' }, { role: 'assistant', content: greeting }, { role: 'user', content: 'Build the project' }] } });
  // LLM Gate on the Pi worker, as production serves kimi-k3, claude-sonnet-5 and qwen.
  const gate = await serve(t, 'chat_completions', (_body, _req, res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] })), {}, 'pi');
  assert.equal((await gate.send(opened)).status, 200);
  assert.deepEqual(gate.calls[0].body.messages, [{ role: 'system', content: note }, { role: 'user', content: 'Build the project' }]);
  // Sent streaming, answered whole without a content type: read whole, as before.
  assert.equal(gate.calls[0].body.stream, true);
  const anthropic = await serve(t, 'anthropic_messages', (_body, _req, res) => res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] })));
  assert.equal((await anthropic.send(opened)).status, 200);
  assert.equal(anthropic.calls[0].body.system, note);
  assert.deepEqual(anthropic.calls[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Build the project' }] }]);
  const responses = await serve(t, 'responses', (_body, _req, res) => res.end(JSON.stringify({ status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] })));
  assert.equal((await responses.send(opened)).status, 200);
  assert.deepEqual(responses.calls[0].body.input, [{ role: 'system', content: note }, { role: 'user', content: 'Build the project' }]);
});

test('a Bedrock stream that fails or ends early is a failed call, never a partial answer', async t => {
  for (const [turn, reason, detail] of [
    // The bridge ends a stream that stopped early with its own error frame; an AWS failure after the stream began keeps its status.
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial' } } }; }, 'stream:error:api_error', undefined],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { throttlingException: { message: 'slow down' } }; }, 'stream:error:429:throttlingException', undefined],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'cut' } } }; yield { messageStop: { stopReason: 'max_tokens' } }; }, 'answer', 'finish:length'],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'I' } } }; yield { messageStop: { stopReason: 'content_filtered' } }; }, 'answer', 'finish:content_filter'],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'private reasoning' } } } }; yield { messageStop: { stopReason: 'end_turn' } }; }, 'answer', 'empty'],
    [async function* () {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tooluse_Zz9', name: 'host_shell' } } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } };
      yield { messageStop: { stopReason: 'tool_use' } };
    }, 'answer', 'tool-name'],
  ] as const) {
    const fake = fakeConverse(() => turn());
    const s = await serve(t, 'anthropic_messages', () => assert.fail('No other provider expected'),
      { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' }, 'pi',
      { bedrockCall: await inProcessCall(fake.sdk) });
    const response = await s.send(input({ model: 'bedrock.gemma-3-27b' }));
    assert.equal(response.status, 502);
    // The reply says what failed by kind, so a host check can tell a broken stream from a refusal, and which check an
    // answer failed.
    assert.deepEqual((await response.json()).error, { code: 'PROVIDER_ERROR', message: 'The managed model request could not be completed.', reason, ...(detail ? { detail } : {}) });
  }
  // A refusal from AWS is named by its exception, never by its message.
  const denial = Object.assign(new Error('User: arn:aws:sts::000000000000:assumed-role/x is not authorized'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
  class ConverseStreamCommand { input: any; constructor(input: any) { this.input = input; } }
  class BedrockRuntimeClient { async send() { throw denial; } destroy() {} }
  const s = await serve(t, 'anthropic_messages', () => assert.fail('No other provider expected'),
    { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' }, 'pi',
    { bedrockCall: await inProcessCall({ BedrockRuntimeClient, ConverseStreamCommand }) });
  const response = await s.send(input({ model: 'bedrock.gemma-3-27b' }));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.reason, 'bedrock:403:AccessDeniedException');
  assert.doesNotMatch(text, /arn:aws|not authorized/);
});

test('capacity is shared with existing runs and DELETE aborts the provider and frees its session', { timeout: 5000 }, async t => {
  let received!: () => void; const ready = new Promise<void>(resolve => { received = resolve; });
  const s = await serve(t, 'chat_completions', () => received(), { AWWO_OPENAI_AGENTS_MAX_CONCURRENCY: '1' });
  const first = s.send(); await ready;
  for (const [body, code] of [[input(), 'RUN_BUSY'], [input({ runId: 'run-2' }), 'SESSION_BUSY'], [input({ runId: 'run-2', sessionId: 'session-2' }), 'CAPACITY_EXCEEDED']] as const) {
    const res = await s.send(body); assert.equal((await res.json()).error.code, code);
  }
  const stop = await fetch(`${s.origin}/internal/runs/run-1`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(stop.status, 202); await stop.body?.cancel();
  const cut = await first;
  assert.equal(cut.status, 499);
  assert.deepEqual((await cut.json()).error, { code: 'CANCELLED', message: 'The managed model request could not be completed.', reason: 'cancelled' });
  assert.equal((await fetch(`${s.origin}/health`).then(r => r.json())).activeRuns, 0);
});

test('a cut call says what cut it: its own time limit, its caller leaving, or the worker stopping', { timeout: 10000 }, async t => {
  const logged = rejections(t);
  const held: (() => void)[] = [];
  const hold = (_body: any, _req: any, res: any) => { held.push(() => res.destroy()); };
  t.after(() => held.forEach(release => release()));
  const slow = await serve(t, 'chat_completions', hold, { AWWO_OPENAI_AGENTS_TIMEOUT_MS: '100' });
  const timedOut = await slow.send();
  assert.equal(timedOut.status, 499);
  assert.equal((await timedOut.json()).error.reason, 'timeout');
  // The caller (the API, or the task's engine behind it) gives up: nobody reads the reply, the log line says so.
  const s = await serve(t, 'chat_completions', hold);
  const caller = new AbortController();
  const gone = s.send(input(), undefined, caller.signal).catch(() => undefined);
  while (s.calls.length < 1) await new Promise(resolve => setTimeout(resolve, 10));
  caller.abort();
  await gone;
  while (!logged.some(line => line.reason === 'disconnected')) await new Promise(resolve => setTimeout(resolve, 10));
  // A worker that stops (a release, a restart) cuts the calls it holds, and says so.
  const pending = s.send(input({ runId: 'run-2', sessionId: 'session-2' }));
  while (s.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  await s.close();
  // The worker closes its connections as it stops, so the reply may not reach the caller; the log line always says why.
  const stopped = await pending.catch(() => undefined);
  if (stopped) {
    assert.equal(stopped.status, 499);
    assert.equal((await stopped.json()).error.reason, 'stopping');
  }
  assert.deepEqual(logged.map(line => [line.status, line.code, line.reason]), [[499, 'CANCELLED', 'timeout'], [499, 'CANCELLED', 'disconnected'], [499, 'CANCELLED', 'stopping']]);
});

test('a provider that sends an error and stalls is answered in about 2 s, and a cut while its error is read stays a cut', { timeout: 10000 }, async t => {
  const held: (() => void)[] = [];
  t.after(() => held.forEach(release => release()));
  // When the provider sent its stalled error: the worker is reading it from a moment after.
  let wrote!: () => void;
  let sent = new Promise<void>(resolve => { wrote = resolve; });
  const s = await serve(t, 'chat_completions', (_body, _req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.write('{"error":{"type":"overloaded"', () => wrote());
    held.push(() => res.destroy());
  });
  const started = performance.now();
  const stalled = await s.send();
  const waited = performance.now() - started;
  assert.equal(stalled.status, 502);
  assert.equal((await stalled.json()).error.reason, 'provider:503');
  assert.ok(waited >= 1900 && waited < 5000, `answered after ${Math.round(waited)} ms`);
  // The run is cancelled while the stalled error is read: the call ends as cancelled, not as the provider's failure.
  sent = new Promise<void>(resolve => { wrote = resolve; });
  const pending = s.send(input({ runId: 'run-2', sessionId: 'session-2' }));
  await sent;
  await new Promise(resolve => setTimeout(resolve, 50));
  const stop = await fetch(`${s.origin}/internal/runs/run-2`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(stop.status, 202); await stop.body?.cancel();
  const cut = await pending;
  assert.equal(cut.status, 499);
  assert.equal((await cut.json()).error.reason, 'cancelled');
});

test('truncated, invented tools, provider secrets and oversized provider bodies fail closed, by kind', async t => {
  for (const [raw, reason, detail] of [
    [{ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, 'answer', 'finish:length'],
    [{ choices: [{ message: { tool_calls: [{ ...call, function: { name: 'host_shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'answer', 'tool-name'],
    [{ error: { message: 'secret-provider-key' } }, 'provider:200', undefined],
    [{ choices: [{ message: { content: 'x'.repeat(600000) }, finish_reason: 'stop' }] }, 'answer', 'size'],
  ] as const) {
    const s = await serve(t, 'chat_completions', (_body, _req, res) => res.end(JSON.stringify(raw)));
    const result = await s.send(); assert.equal(result.status, 502);
    const text = await result.text();
    assert.doesNotMatch(text, /secret-provider-key/);
    assert.deepEqual(JSON.parse(text).error, { code: 'PROVIDER_ERROR', message: 'The managed model request could not be completed.', reason, ...(detail ? { detail } : {}) });
  }
});

test('a provider\'s refusal or a broken answer is named by its status, the network, or the check it failed, never by its text', async t => {
  const logged = rejections(t);
  const scenarios: Record<string, (res: any, req: any) => void> = {
    'gate-400': res => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'secret-provider-key: your prompt has 99999 tokens', type: 'invalid_request_error', code: 'context_length_exceeded' } })); },
    'gate-anthropic-529': res => { res.writeHead(529, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'secret-provider-key overloaded' } })); },
    'edge-524': res => { res.writeHead(524, { 'content-type': 'text/html' }); res.end('<html>secret-provider-key: a timeout occurred</html>'); },
    'gate-200-error': res => res.end(JSON.stringify({ error: { message: 'secret-provider-key quota', type: 'new_api_error' } })),
    'not-json': res => res.end('secret-provider-key, not json'),
    reset: (_res, req) => req.socket.destroy(),
    empty: res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })),
    filtered: res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I' }, finish_reason: 'content_filter' }] })),
    refused: res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, refusal: 'secret-provider-key refusal' }, finish_reason: 'stop' }] })),
    unfinished: res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: null }] })),
    mismatch: res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'stop' }] })),
    'bad-args': res => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'workspace_exec', arguments: '{"command":' } }] }, finish_reason: 'tool_calls' }] })),
    'two-choices': res => res.end(JSON.stringify({ choices: [{ message: { content: 'a' }, finish_reason: 'stop' }, { message: { content: 'b' }, finish_reason: 'stop' }] })),
  };
  const s = await serve(t, 'chat_completions', (body, req, res) => scenarios[body.messages.at(-1).content](res, req), {}, 'pi');
  for (const [scenario, reason, detail] of [
    ['gate-400', 'provider:400:context_length_exceeded', undefined], ['gate-anthropic-529', 'provider:529:overloaded_error', undefined],
    ['edge-524', 'provider:524', undefined], ['gate-200-error', 'provider:200:new_api_error', undefined], ['not-json', 'body', undefined],
    ['empty', 'answer', 'empty'], ['filtered', 'answer', 'finish:content_filter'], ['refused', 'answer', 'refusal'], ['unfinished', 'answer', 'finish:none'],
    ['mismatch', 'answer', 'tools-mismatch'], ['bad-args', 'answer', 'tool-args'], ['two-choices', 'answer', 'choices'],
  ] as const) {
    const response = await s.send(input({ completion: { messages: [{ role: 'user', content: scenario }], tools: [tool] } }));
    assert.equal(response.status, 502, scenario);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text).error, { code: 'PROVIDER_ERROR', message: 'The managed model request could not be completed.', reason, ...(detail ? { detail } : {}) }, scenario);
  }
  const reset = await s.send(input({ completion: { messages: [{ role: 'user', content: 'reset' }], tools: [tool] } }));
  assert.equal(reset.status, 502);
  assert.match((await reset.json()).error.reason, /^network(:[A-Z0-9_]+)?$/);
  // Each refusal is one log line on the worker, with the call's run and model and nothing the provider or the call said.
  assert.equal(logged.length, 13);
  assert.ok(logged.every(line => line.runtime === 'pi' && line.runId === 'run-1' && line.model === 'fixture-model' && line.status === 502 && line.code === 'PROVIDER_ERROR'));
  assert.deepEqual(logged.slice(0, 3).map(line => line.reason), ['provider:400:context_length_exceeded', 'provider:529:overloaded_error', 'provider:524']);
  assert.doesNotMatch(JSON.stringify(logged), /secret-provider-key|tokens|quota|gate-400|not json/);
});

// An event stream as LLM Gate sends one: each frame a `data:` line (an object as JSON, a string as written), sent in
// pieces of `piece` bytes, so that lines and characters arrive cut apart as a network may deliver them.
async function events(res: any, frames: (object | string)[], { piece = 0, end = true } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const bytes = Buffer.from(frames.map(frame => `${typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}`}\n\n`).join(''));
  for (let at = 0; at < bytes.length; at += piece || bytes.length) {
    res.write(bytes.subarray(at, at + (piece || bytes.length)));
    await new Promise(resolve => setImmediate(resolve));
  }
  if (end) res.end();
}

test('a Chat Completions call through LLM Gate is streamed and gathered into one answer, its hidden reasoning never forwarded', async t => {
  const frames = [
    ': keep-alive',
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' }, finish_reason: '' }] },
    'data:',
    { choices: [{ index: 0, delta: { content: '先看' } }] },
    { choices: [{ index: 0, delta: { content: '一下。' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'workspace_exec', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"echo verified"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: null },
    { choices: [], usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } },
    'data: [DONE]',
  ];
  // Eleven bytes at a time: every line, and the Chinese characters, arrive cut apart.
  const s = await serve(t, 'chat_completions', (_body, _req, res) => void events(res, frames, { piece: 11 }), {}, 'pi');
  const response = await s.send();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(s.calls[0].body.stream, true);
  assert.deepEqual(s.calls[0].body.stream_options, { include_usage: true });
  assert.deepEqual(body.completion.choices[0].message, { role: 'assistant', content: '先看一下。', tool_calls: [call] });
  assert.equal(body.completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.observability.usage.inputTokens, 21); assert.equal(body.observability.usage.source, 'provider_raw');
  assert.equal(body.completion.usage.completion_tokens, 7);
  assert.doesNotMatch(JSON.stringify(body), /private reasoning|secret-provider-key/);
});

test('only a Chat Completions call through LLM Gate streams: a Gate profile named "openai" too, no other provider or protocol', () => {
  const completion = validateComputerCompletion({ messages: [{ role: 'user', content: 'Build the project' }], tools: [tool] });
  const profile = (baseURL: string, provider: string, protocol = 'chat_completions') => ({ model: 'm', apiKey: 'k', baseURL, provider, protocol, maxTokens: 1024, contextWindow: 32768 });
  for (const model of [profile('https://api.clawhunt.site/v1', 'openai'), profile('https://api.clawhunt.site/v1/', 'llmgate'), profile('http://127.0.0.1:9/v1', 'llmgate')]) {
    const call = providerComputerRequest(completion, model);
    assert.equal(call.stream, true, model.baseURL);
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
  }
  // A Gate profile labelled "openai" keeps that wire's own fields beside the stream's.
  const labelled = providerComputerRequest(completion, profile('https://api.clawhunt.site/v1', 'openai')).body;
  assert.equal(labelled.max_completion_tokens, 1024); assert.equal(labelled.store, false); assert.equal('max_tokens' in labelled, false);
  for (const model of [profile('https://api.openai.com/v1', 'openai'), profile('https://generativelanguage.googleapis.com/v1beta/openai', 'openai'),
    profile('http://127.0.0.1:11434/v1', 'ollama'), profile('https://api.clawhunt.site', 'anthropic', 'anthropic_messages'), profile('https://api.clawhunt.site/v1', 'openai', 'responses')]) {
    const call = providerComputerRequest(completion, model);
    assert.equal(call.stream, undefined, `${model.baseURL} ${model.protocol}`);
    assert.equal(call.body.stream, false);
    assert.equal('stream_options' in call.body, false);
  }
});

test('a streamed tool call sent whole without an index is joined by its id; one with neither is a broken stream', async () => {
  const from = (frames: object[]) => (async function* () { for (const frame of frames) yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); })();
  const second = { id: 'call-2', type: 'function', function: { name: 'workspace_exec', arguments: '{"command":"ls"}' } };
  const raw = await gatherChatStream(from([
    { choices: [{ delta: { tool_calls: [call] } }] },
    { choices: [{ delta: { tool_calls: [second] }, finish_reason: 'tool_calls' }] },
  ]));
  assert.deepEqual(raw.choices[0].message.tool_calls, [call, second]);
  await assert.rejects(gatherChatStream(from([{ choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }])),
    (error: any) => error.detail === 'tool-calls');
});

test('a stream line cut across many chunks is joined whole, and no open line may pass 1 MiB', async () => {
  const framed = (content: string) => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const pieces = (bytes: Buffer, size: number) => (async function* () { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size); })();
  // One byte at a time cuts every character of a short answer apart; a long one (900 KB) comes in pieces of odd sizes.
  assert.equal((await gatherChatStream(pieces(framed('完成了 done'), 1))).choices[0].message.content, '完成了 done');
  const long = '长'.repeat(150_000) + 'x'.repeat(300_000);
  for (const size of [4093, 65536]) assert.equal((await gatherChatStream(pieces(framed(long), size))).choices[0].message.content, long, `pieces of ${size}`);
  // Fifteen MiB with no line end, in 64 KiB pieces: refused once the open line passes 1 MiB, without reading the rest.
  const run = Buffer.alloc(64 * 1024, 'a');
  let sent = 0;
  await assert.rejects(gatherChatStream((async function* () { yield Buffer.from('data: {"choices":['); for (; sent < 240; sent++) yield run; })()),
    (error: any) => error.detail === 'size');
  assert.ok(sent <= 17, `read ${sent} pieces`);
});

test('a stream is read to [DONE] and no further, and a tool call keeps the id and name it was given', async () => {
  const from = (lines: string[], hold = false) => (async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n\n`);
    if (hold) await new Promise(() => {}); // a gateway that keeps the connection after its last frame
  })();
  const data = (value: object) => `data: ${JSON.stringify(value)}`;
  const done = await gatherChatStream(from([data({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], error: null }), 'data: [DONE]', 'data: {"not": json'], true));
  assert.equal(done.choices[0].message.content, 'OK');
  const fails = async (lines: string[], detail: string) => assert.rejects(gatherChatStream(from(lines)), (error: any) => error.detail === detail);
  await fails([data({ choices: [{ delta: { content: 'OK' } }] }), 'data: [DONE]'], 'unfinished');
  await fails([data({ choices: [{ delta: { content: 'OK' } }] })], 'truncated');
  // An error said in place of choices (as some providers send a moderation stop) is an error frame, by its code only.
  await fails([data({ choices: [{ delta: { content: 'OK' } }] }), data({ code: 'DataInspectionFailed', message: 'secret-provider-key' })], 'error:DataInspectionFailed');
  await fails([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'workspace_exec', arguments: '' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'host_shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })], 'tool-calls');
  await fails([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'workspace_exec', arguments: '' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })], 'tool-calls');
  // The source breaking after the finish reason keeps the answer; breaking inside a line, or before any finish, does not.
  const breaks = (lines: string[], tail = '') => (async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n\n`);
    if (tail) yield Buffer.from(tail);
    throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  })();
  assert.equal((await gatherChatStream(breaks([data({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })]))).choices[0].message.content, 'OK');
  await assert.rejects(gatherChatStream(breaks([data({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })], 'data: {"usage":')), /terminated/);
  await assert.rejects(gatherChatStream(breaks([data({ choices: [{ delta: { content: 'OK' } }] })])), /terminated/);
  // An empty id or name in a later part says nothing.
  const kept = await gatherChatStream(from([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'workspace_exec', arguments: '{"command":' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"echo verified"}' } }] }, finish_reason: 'tool_calls' }] })]));
  assert.deepEqual(kept.choices[0].message.tool_calls, [call]);
});

test('a Gate stream that breaks is a failed call named by kind, never a partial answer nor provider text', async t => {
  const logged = rejections(t);
  const partial = { choices: [{ index: 0, delta: { content: 'partial' } }] };
  const later = (res: any, then: () => void) => void events(res, [partial], { end: false }).then(() => setTimeout(then, 900));
  const scenarios: Record<string, (res: any, req: any) => void> = {
    'error-frame': res => void events(res, [partial, { error: { message: 'secret-provider-key upstream failed', type: 'upstream_error', code: 'bad_response_status_code' } }]),
    'no-finish': res => void events(res, [partial]),
    unfinished: res => void events(res, [partial, 'data: [DONE]']),
    garbled: res => void events(res, [partial, 'data: {"choices":[{"delta":{"content":"secret-provider-key']),
    reset: (res, req) => void events(res, [partial], { end: false }).then(() => setTimeout(() => req.socket.destroy(), 20)),
    // Silent for longer than the edge's idle limit (shortened to 400 ms here), then closed: the edge's cut.
    'idle-reset': (res, req) => later(res, () => req.socket.destroy()),
    'idle-end': res => later(res, () => res.end()),
    length: res => void events(res, [partial, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }, 'data: [DONE]']),
    filtered: res => void events(res, [partial, { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }, 'data: [DONE]']),
    // Gathered past the size an answer read whole may have.
    huge: res => void events(res, [{ choices: [{ index: 0, delta: { content: 'x'.repeat(600_000) }, finish_reason: 'stop' }] }, 'data: [DONE]']),
    // The connection breaks after the finish reason, before usage and [DONE]: the answer stands (checked below).
    'after-finish': (res, req) => void events(res, [{ choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] }], { end: false })
      .then(() => setTimeout(() => req.socket.destroy(), 20)),
    // A streamed refusal (OpenAI's), refused as one read whole; an error said in place of choices, as a moderation stop.
    refusal: res => void events(res, [{ choices: [{ index: 0, delta: { refusal: 'secret-provider-key: I cannot help' }, finish_reason: 'stop' }] }, 'data: [DONE]']),
    moderation: res => void events(res, [partial, { code: 'DataInspectionFailed', message: 'secret-provider-key inappropriate content' }]),
  };
  const s = await serve(t, 'chat_completions', (body, req, res) => scenarios[body.messages.at(-1).content](res, req), {}, 'pi', { edgeIdleMs: 400 });
  const socket = 'UND_ERR_SOCKET';
  for (const [scenario, reason, detail] of [
    // The gateway's error frame is its refusal inside a 200, as one read whole is (provider:200:<its code or type>).
    ['error-frame', 'provider:200:bad_response_status_code', undefined], ['moderation', 'provider:200:DataInspectionFailed', undefined],
    ['no-finish', 'stream:closed', 'end'], ['unfinished', 'stream:unfinished', undefined],
    ['garbled', 'stream:shape', undefined], ['reset', 'stream:closed', socket], ['idle-reset', 'stream:closed:idle', socket], ['idle-end', 'stream:closed:idle', 'end'],
    ['length', 'answer', 'finish:length'], ['filtered', 'answer', 'finish:content_filter'], ['huge', 'answer', 'size'], ['refusal', 'answer', 'refusal'],
  ] as const) {
    const response = await s.send(input({ completion: { messages: [{ role: 'user', content: scenario }], tools: [tool] } }));
    assert.equal(response.status, 502, scenario);
    const error = (await response.json()).error;
    assert.equal(error.code, 'PROVIDER_ERROR', scenario);
    assert.equal(error.reason, reason, scenario);
    assert.equal(error.detail, detail, scenario);
  }
  const finished = await s.send(input({ completion: { messages: [{ role: 'user', content: 'after-finish' }], tools: [tool] } }));
  assert.equal(finished.status, 200);
  assert.equal((await finished.json()).completion.choices[0].message.content, 'Done.');
  assert.equal(logged.length, 12);
  // Each close's silence is on its log line alone (quietMs), never in the reply.
  const closes = logged.filter(line => String(line.reason).startsWith('stream:closed'));
  assert.equal(closes.length, 4);
  for (const line of closes) assert.ok(line.reason === 'stream:closed:idle' ? line.quietMs >= 400 : line.quietMs < 400, JSON.stringify(line));
  assert.doesNotMatch(JSON.stringify(logged), /secret-provider-key|partial|upstream failed|inappropriate|cannot help|xxxx/);
});

test('a Gate stream that stalls is cut by the call\'s own time limit, and a cancel mid-stream stays a cancel', { timeout: 10000 }, async t => {
  const held: (() => void)[] = [];
  t.after(() => held.forEach(release => release()));
  // The provider tells when its first frame is on the wire: the cuts below come after it, while the stream is read.
  let wrote!: () => void;
  let sent = new Promise<void>(resolve => { wrote = resolve; });
  const stall = (_body: any, _req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`, () => wrote());
    held.push(() => res.destroy());
  };
  const slow = await serve(t, 'chat_completions', stall, { AWWO_PI_TIMEOUT_MS: '800' }, 'pi');
  const started = performance.now();
  const timing = slow.send();
  await sent;
  const timedOut = await timing;
  assert.equal(timedOut.status, 499);
  assert.equal((await timedOut.json()).error.reason, 'timeout');
  assert.ok(performance.now() - started >= 750, 'cut by the time limit, after the stream began');
  sent = new Promise<void>(resolve => { wrote = resolve; });
  const s = await serve(t, 'chat_completions', stall, {}, 'pi');
  const pending = s.send();
  await sent;
  await new Promise(resolve => setTimeout(resolve, 100));
  const stop = await fetch(`${s.origin}/internal/runs/run-1`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(stop.status, 202); await stop.body?.cancel();
  const cut = await pending;
  assert.equal(cut.status, 499);
  assert.equal((await cut.json()).error.reason, 'cancelled');
});

test('a personal LLM Gate connection streams as the operator\'s does, gathered into one answer', async t => {
  const s = await serve(t, 'chat_completions', (_body, _req, res) => void events(res, [{ choices: [{ index: 0, delta: { content: 'Verified' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }, 'data: [DONE]']), { AWWO_CREDENTIAL_MODE: 'user' }, 'pi');
  // The binding pins the Gate's own address; its calls are led to this fixture.
  const originalFetch = globalThis.fetch;
  const gate = 'https://api.clawhunt.site/v1';
  t.mock.method(globalThis, 'fetch', (target: string | URL | Request, init?: RequestInit) =>
    originalFetch(String(target) === `${gate}/chat/completions` ? `${s.baseURL}/v1/chat/completions` : target, init));
  const selector = `byok_${'a'.repeat(33)}_${'c'.repeat(16)}`;
  const response = await s.send(input({ model: selector, userModel: { id: selector, provider: 'llmgate', model: 'qwen3.8-27b-p6', baseURL: gate, apiKey: 'personal-gate-fixture-key',
    protocol: 'chat_completions', contextWindow: 32768, maxTokens: 4096, reasoningEfforts: [], defaultReasoningEffort: '' } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.completion.choices[0].message.content, 'Verified');
  assert.equal(body.observability.usage.inputTokens, 5);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].headers.authorization, 'Bearer personal-gate-fixture-key');
  assert.equal(s.calls[0].body.stream, true);
  assert.deepEqual(s.calls[0].body.stream_options, { include_usage: true });
});

const routing = (extra: Record<string, unknown> = {}) => input({ completion: { messages: [{ role: 'system', content: 'Route the message' }, { role: 'user', content: 'Build the project' }], tools: [] }, ...extra });
const chatReply = (_body: any, _req: any, res: any) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"route":"plan"}' }, finish_reason: 'stop' }] }));

test('a call with thinking off asks a Gate model on the Pi worker to skip its hidden reasoning, and only that call', async t => {
  const s = await serve(t, 'chat_completions', chatReply, {}, 'pi');
  const off = await s.send(routing({ thinking: false }));
  assert.equal(off.status, 200);
  assert.deepEqual(s.calls[0].body.chat_template_kwargs, { enable_thinking: false });
  for (const extra of [{}, { thinking: true }]) {
    const on = await s.send(routing(extra));
    assert.equal(on.status, 200);
    assert.equal('chat_template_kwargs' in s.calls.at(-1).body, false);
  }
});

test('thinking off never reaches a provider that refuses unknown arguments or has no such switch', async t => {
  const openai = await serve(t, 'chat_completions', chatReply);
  assert.equal((await openai.send(routing({ thinking: false }))).status, 200);
  assert.equal('chat_template_kwargs' in openai.calls[0].body, false);
  const anthropic = await serve(t, 'anthropic_messages', (_body, _req, res) => res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"route":"plan"}' }] })));
  assert.equal((await anthropic.send(routing({ thinking: false }))).status, 200);
  assert.equal('chat_template_kwargs' in anthropic.calls[0].body, false);
});

test('a per-call option that is not well formed is refused before any provider call', async t => {
  const s = await serve(t, 'chat_completions', chatReply, {}, 'pi');
  for (const extra of [{ thinking: 'off' }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: '24' }]) {
    const refused = await s.send(routing(extra));
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'INVALID_INPUT');
  }
  assert.equal(s.calls.length, 0);
});

test('maxTokens lowers a call’s output limit and never raises it past the profile', async t => {
  const s = await serve(t, 'chat_completions', chatReply, { AWWO_PI_MAX_TOKENS: '2048' }, 'pi');
  assert.equal((await s.send(routing({ maxTokens: 24 }))).status, 200);
  assert.equal(s.calls[0].body.max_tokens, 24);
  assert.equal((await s.send(routing({ maxTokens: 999_999 }))).status, 200);
  assert.equal(s.calls[1].body.max_tokens, 2048);
  assert.equal((await s.send(routing())).status, 200);
  assert.equal(s.calls[2].body.max_tokens, 2048);
});

test('maxTokens lowers the output limit on the Anthropic Messages and Responses wires as well', async t => {
  const anthropic = await serve(t, 'anthropic_messages', (_body, _req, res) => res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"route":"plan"}' }] })));
  assert.equal((await anthropic.send(routing({ maxTokens: 24 }))).status, 200);
  assert.equal(anthropic.calls[0].body.max_tokens, 24);
  const responses = await serve(t, 'responses', (_body, _req, res) => res.end(JSON.stringify({ status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"route":"plan"}' }] }] })));
  assert.equal((await responses.send(routing({ maxTokens: 24 }))).status, 200);
  assert.equal(responses.calls[0].body.max_output_tokens, 24);
});

test('both workers list the per-call options and their slots in their health, for the API to send only where they hold', async t => {
  for (const worker of ['pi', 'openai-agents'] as const) {
    const s = await serve(t, 'chat_completions', chatReply, {}, worker);
    const health = await (await fetch(`${s.origin}/health`)).json();
    assert.deepEqual(health.completionOptions, ['thinking', 'maxTokens']);
    assert.equal(health.maxConcurrency, 4);
    assert.equal(health.activeRuns, 0);
  }
});

test('an empty encrypted reasoning item is never forwarded, nor taken back', () => {
  const answer = computerCompletionResponse({ status: 'completed', output: [{ type: 'reasoning', id: 'rs_0', encrypted_content: '' },
    { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] }, 'responses', [tool]);
  assert.equal(answer.choices[0].message.reasoning_details, undefined);
  assert.throws(() => validateComputerCompletion({ messages: [{ role: 'user', content: 'Build' },
    { role: 'assistant', content: 'Done.', reasoning_details: [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', id: 'rs_0', data: '' }] }] }),
  (error: any) => error.detail === 'reasoning');
});

test('a tool terminal without its tool call cannot become a completed answer', () => {
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: 'I will execute', tool_calls: [] }, finish_reason: 'tool_calls' }] }, 'chat_completions', [tool]));
  assert.throws(() => computerCompletionResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will execute' }] }, 'anthropic_messages', [tool]));
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'stop' }] }, 'chat_completions', [tool]));
});
