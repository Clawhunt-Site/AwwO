import assert from 'node:assert/strict';
import { computerCompletionResponse } from './computer-model.ts';
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

async function serve(t: any, protocol: string, handler: (body: any, req: any, res: any) => void, overrides: Record<string, string> = {}) {
  const calls: any[] = [];
  const provider = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ body, headers: req.headers, path: req.url }); handler(body, req, res);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const baseURL = `http://127.0.0.1:${(provider.address() as any).port}`;
  const pi = protocol === 'anthropic_messages';
  const prefix = pi ? 'AWWO_PI' : 'AWWO_OPENAI_AGENTS';
  const config = (pi ? loadPi : loadOpenAI)({ [`${prefix}_TOKEN`]: token, [`${prefix}_MODEL`]: 'fixture-model', [`${prefix}_API_KEY`]: 'secret-provider-key', [`${prefix}_BASE_URL`]: baseURL + (pi ? '' : '/v1'), [`${prefix}_PROVIDER`]: pi ? 'anthropic' : 'openai', [`${prefix}_PROTOCOL`]: protocol, ...overrides });
  const app = (pi ? createPiServer : createOpenAIAgentsServer)(config);
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

test('a Bedrock model is refused for managed execution before any request or key leaves the worker', async t => {
  const bedrockKey = 'ABSKbedrockkey000000000000000000';
  const originalFetch = globalThis.fetch;
  const outbound: string[] = [];
  t.mock.method(globalThis, 'fetch', (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target instanceof Request ? target.url : target);
    if (url.includes('amazonaws')) outbound.push(url);
    return originalFetch(target, init);
  });
  for (const [protocol, model] of [['chat_completions', 'bedrock.glm-5'], ['anthropic_messages', 'bedrock.gemma-3-27b']] as const) {
    const s = await serve(t, protocol, () => assert.fail('No provider request expected'), { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: bedrockKey });
    const response = await s.send(input({ model }));
    assert.equal(response.status, 400, protocol);
    assert.equal((await response.json()).error.code, 'MODEL_NOT_SUPPORTED');
    assert.equal(s.calls.length, 0);
  }
  assert.deepEqual(outbound, []);
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

test('a tool terminal without its tool call cannot become a completed answer', () => {
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: 'I will execute', tool_calls: [] }, finish_reason: 'tool_calls' }] }, 'chat_completions', [tool]));
  assert.throws(() => computerCompletionResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will execute' }] }, 'anthropic_messages', [tool]));
  assert.throws(() => computerCompletionResponse({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'stop' }] }, 'chat_completions', [tool]));
});
