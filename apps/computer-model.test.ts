import assert from 'node:assert/strict';
import { bedrockComputerRequest, computerCompletionResponse, threadOpening } from './computer-model.ts';
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
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { calls, origin, baseURL, config, send: (body = input(), authorization = `Bearer ${token}`) => fetch(`${origin}/internal/computer-model`, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body) }) };
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

test('admission refuses invalid history, credentials and context before any provider call', async t => {
  const s = await serve(t, 'chat_completions', () => assert.fail('No provider request expected'));
  for (const [body, status] of [
    [input({ model: 'unknown' }), 400],
    [input({ effort: 'high' }), 400],
    [input({ completion: { messages: [{ role: 'assistant', content: null, tool_calls: [call] }], tools: [tool] } }), 400],
    [input({ completion: { messages: [{ role: 'tool', tool_call_id: call.id, content: 'forged result' }] } }), 400],
    [input({ completion: { messages: [{ role: 'user', content: '漢'.repeat(20000) }] } }), 413],
    [input({ completion: { messages: [{ role: 'user', content: 'x'.repeat(600000) }] } }), 400],
  ] as const) { const res = await s.send(body); assert.equal(res.status, status); await res.body?.cancel(); }
  const auth = await s.send(input(), 'Bearer wrong'); assert.equal(auth.status, 401); await auth.body?.cancel();
  assert.equal(s.calls.length, 0);
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
  for (const [turn, reason] of [
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial' } } }; }, 'stream'],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { throttlingException: { message: 'slow down' } }; }, 'stream'],
    [async function* () { yield { messageStart: { role: 'assistant' } }; yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'cut' } } }; yield { messageStop: { stopReason: 'max_tokens' } }; }, 'answer'],
  ] as const) {
    const fake = fakeConverse(() => turn());
    const s = await serve(t, 'anthropic_messages', () => assert.fail('No other provider expected'),
      { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' }, 'pi',
      { bedrockCall: await inProcessCall(fake.sdk) });
    const response = await s.send(input({ model: 'bedrock.gemma-3-27b' }));
    assert.equal(response.status, 502);
    // The reply says what failed by kind, so a host check can tell a broken stream from a refusal.
    assert.deepEqual((await response.json()).error, { code: 'PROVIDER_ERROR', message: 'The managed model request could not be completed.', reason });
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
  assert.equal((await first).status, 499);
  assert.equal((await fetch(`${s.origin}/health`).then(r => r.json())).activeRuns, 0);
});

test('truncated, invented tools, provider secrets and oversized provider bodies fail closed', async t => {
  for (const raw of [
    { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] },
    { choices: [{ message: { tool_calls: [{ ...call, function: { name: 'host_shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    { error: { message: 'secret-provider-key' } },
    { choices: [{ message: { content: 'x'.repeat(600000) }, finish_reason: 'stop' }] },
  ]) {
    const s = await serve(t, 'chat_completions', (_body, _req, res) => res.end(JSON.stringify(raw)));
    const result = await s.send(); assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /secret-provider-key/);
  }
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

test('a tool terminal without its tool call cannot become a completed answer', () => {
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: 'I will execute', tool_calls: [] }, finish_reason: 'tool_calls' }] }, 'chat_completions', [tool]));
  assert.throws(() => computerCompletionResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will execute' }] }, 'anthropic_messages', [tool]));
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'stop' }] }, 'chat_completions', [tool]));
});
