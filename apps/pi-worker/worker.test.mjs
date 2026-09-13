const businessEvent = ({ observability, ...event }) => event;
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fitsContextBudget, INPUT_LIMITS, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { startIsolatedRun, workerEnvironment } from './runner.mjs';
import { createPiServer } from './server.mjs';

const TOKEN = 'local-test-service-token-with-32-characters';
const REQUEST = { runId: 'run_1', tenantId: 'tenant_1', sessionId: 'session_1', prompt: 'current request', messages: [] };
const ENV = { AWWO_PI_TOKEN: TOKEN, AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'test-model', AWWO_PI_API_KEY: 'provider-test-key' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await done;
}

async function provider(t, { mode = 'success', protocol = 'openai', beforeReply, usage, multilineUsage = false } = {}) {
  const requests = [];
  let notifyRequest;
  const received = new Promise((resolve) => { notifyRequest = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body, headers: req.headers, url: req.url });
    notifyRequest();
    await beforeReply?.();
    if (mode === 'error') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'private-provider-key-and-internal-path' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    if (mode === 'stall') return;
    if (protocol === 'anthropic') {
      const send = (event, value) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Pi' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      send('message_stop', { type: 'message_stop' });
    } else {
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (mode === 'tool') {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool_1', type: 'function', function: { name: 'bash', arguments: '{"command":"touch should-never-exist"}' } }] });
        send({}, 'tool_calls');
      } else if (mode === 'oversize') {
        // Fewer than 1024 characters, but more than 1024 UTF-8 bytes.
        send({ role: 'assistant', content: '汉'.repeat(400) });
        send({}, 'stop');
      } else {
        send({ role: 'assistant', content: 'Hello ' });
        send({ content: 'from Pi' });
        send({}, 'stop');
      }
      if (usage !== undefined) res.write(JSON.stringify({ choices: [], usage }, null, multilineUsage ? 2 : undefined).split('\n').map(line => `data: ${line}`).join('\n') + '\n\n');
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  const baseURL = await listen(server);
  t.after(() => close(server));
  return { server, requests, received, baseURL: protocol === 'anthropic' ? baseURL : `${baseURL}/v1` };
}

function configuration(baseURL, overrides = {}) {
  return loadConfig({ ...ENV, AWWO_PI_BASE_URL: baseURL, AWWO_PI_TIMEOUT_MS: '10000', AWWO_PI_CANCEL_GRACE_MS: '100', ...overrides });
}

async function run(t, config, request = REQUEST) {
  const events = [];
  const handle = await startIsolatedRun({ config, request, onEvent: (event) => events.push(event) });
  t.after(async () => { handle.cancel(); await handle.done; });
  return { events, handle };
}

test('configuration requires real model settings and a strong internal token; health never contains secrets', () => {
  assert.equal(loadConfig({}).ready, false);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_API_KEY: '' }).ready, false);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_BASE_URL: '' }).baseURL, 'https://api.openai.com/v1');
  assert.equal(loadConfig({ ...ENV, AWWO_PI_TOKEN: 'short' }).ready, false);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_BASE_URL: 'file:///etc/passwd' }).ready, false);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_BASE_URL: 'https://secret:pass@example.com' }).ready, false);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_PROVIDER: 'ollama', AWWO_PI_API_KEY: '' }).ready, true);
  const health = JSON.stringify(publicHealth(loadConfig(ENV)));
  assert.equal(health.includes(ENV.AWWO_PI_API_KEY), false);
  assert.equal(health.includes(TOKEN), false);
  assert.equal(publicHealth(loadConfig(ENV)).modelConnectivityVerified, false);
});

test('model catalog preserves the default, resolves only IDs, and exposes safe model-specific limits', () => {
  const profile = { id: 'reviewer', provider: 'anthropic', model: 'review-model', baseURL: 'https://model-endpoint.example', apiKeyEnv: 'REVIEW_KEY', contextWindow: 8192, maxTokens: 512 };
  const config = loadConfig({ ...ENV, REVIEW_KEY: 'catalog-provider-secret', AWWO_PI_MODELS_JSON: JSON.stringify([profile]) });
  assert.equal(config.ready, true);
  assert.equal(resolveModelConfig(config).model, ENV.AWWO_PI_MODEL);
  assert.equal(resolveModelConfig(config, ENV.AWWO_PI_MODEL).apiKey, ENV.AWWO_PI_API_KEY);
  assert.equal(resolveModelConfig(config, 'reviewer').apiKey, 'catalog-provider-secret');
  assert.throws(() => resolveModelConfig(config, 'review-model'));
  assert.throws(() => resolveModelConfig(config, 'unknown-model'));
  assert.ok(Object.isFrozen(config.models));
  assert.ok(config.models.every(Object.isFrozen));
  const health = publicHealth(config);
  assert.equal(health.model, ENV.AWWO_PI_MODEL);
  assert.equal(health.models[0].providerModel, ENV.AWWO_PI_MODEL);
  assert.equal(health.models[0].protocol, 'chat_completions');
  assert.equal(resolveModelConfig(config, 'reviewer').protocol, health.models[1].protocol);
  assert.deepEqual(health.models[1], {
    id: 'reviewer', name: 'review-model', providerModel: 'review-model', protocol: 'anthropic_messages', provider: 'anthropic', runtime: 'pi',
    contextWindow: 8192, maxOutputTokens: 512, maxContextTextBytes: 7424, messageOverheadBytes: 32,
  });
  const serialized = JSON.stringify(health);
  for (const secret of [TOKEN, ENV.AWWO_PI_API_KEY, 'catalog-provider-secret', profile.baseURL, 'REVIEW_KEY', 'apiKey', 'baseURL']) {
    assert.equal(serialized.includes(secret), false);
  }
  const unavailable = loadConfig({ ...ENV, AWWO_PI_MODELS_JSON: JSON.stringify([profile]) });
  assert.equal(unavailable.ready, false);
  assert.equal(publicHealth(unavailable).status, 'unconfigured');
  assert.ok(unavailable.missing.includes('AWWO_PI_MODELS_JSON_CREDENTIALS'));
  assert.equal(loadConfig({ ...ENV, AWWO_PI_MODELS_JSON: '[]' }).models.length, 1);
});

test('malformed catalog configuration fails closed with a redacted diagnostic', () => {
  const profile = { id: 'reviewer', provider: 'openai', model: 'review-model', apiKeyEnv: 'REVIEW_KEY' };
  const invalidProfiles = [
    null, [], 'profile', { ...profile, id: '' }, { ...profile, id: ENV.AWWO_PI_MODEL },
    { ...profile, provider: ['openai'] }, { ...profile, provider: 'untrusted' },
    { ...profile, apiKey: 'EMBEDDED_SECRET' }, { ...profile, token: 'EMBEDDED_SECRET' },
    { ...profile, apiKeyEnv: 'KEY=EMBEDDED_SECRET' }, { ...profile, apiKeyEnv: null },
    { ...profile, apiKeyEnv: undefined }, { ...profile, model: 'bad\nmodel' },
    { ...profile, baseURL: 'file:///private/EMBEDDED_SECRET' },
    { ...profile, baseURL: 'https://user:EMBEDDED_SECRET@example.com/v1' },
    { ...profile, baseURL: 'https://example.com/v1?key=EMBEDDED_SECRET' },
    { ...profile, baseURL: 'https://example.com/v1#EMBEDDED_SECRET' },
    { ...profile, baseURL: 'https://example.com/\nEMBEDDED_SECRET' },
    { ...profile, baseURL: 'https:example.com/v1' },
    { ...profile, baseURL: '' }, { ...profile, contextWindow: '8192' },
    { ...profile, contextWindow: 4095 }, { ...profile, maxTokens: 127 },
    { ...profile, contextWindow: 4096, maxTokens: 4096 },
  ];
  for (const serialized of ['{EMBEDDED_SECRET', '{}', 'null', JSON.stringify([profile, profile]), JSON.stringify(Array(33).fill(profile)), ...invalidProfiles.map(value => JSON.stringify([value]))]) {
    assert.throws(() => loadConfig({ ...ENV, REVIEW_KEY: 'catalog-provider-secret', AWWO_PI_MODELS_JSON: serialized }), (error) => {
      assert.match(error.message, /^AWWO_PI_MODELS_JSON must contain/);
      assert.equal(error.message.includes('EMBEDDED_SECRET'), false);
      assert.equal(error.message.includes('catalog-provider-secret'), false);
      return true;
    });
  }
});

test('HTTP rejects unknown models and unavailable catalog credentials before a child or provider starts', async (t) => {
  let starts = 0;
  const app = createPiServer(loadConfig(ENV), { startRun: async () => { starts++; } });
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  for (const [model, code] of [['missing-model', 'MODEL_NOT_FOUND'], ['invalid model', 'INVALID_INPUT'], ['', 'INVALID_INPUT']]) {
    const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, model }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
  assert.equal(starts, 0);
  const unavailable = createPiServer(loadConfig({ ...ENV, AWWO_PI_MODELS_JSON: JSON.stringify([{ id: 'review', provider: 'openai', model: 'review-model', apiKeyEnv: 'MISSING_KEY' }]) }), { startRun: async () => { starts++; } });
  const unavailableURL = await listen(unavailable.server);
  t.after(() => unavailable.close());
  assert.equal((await fetch(`${unavailableURL}/health`)).status, 503);
  assert.equal((await fetch(`${unavailableURL}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) })).status, 503);
  assert.equal(starts, 0);
});

test('concurrent catalog profiles reach separate real Pi providers with independent credentials and output capacity', { timeout: 20000 }, async (t) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const writer = await provider(t, { beforeReply: () => barrier });
  const reviewer = await provider(t, { protocol: 'anthropic', beforeReply: () => barrier });
  const profiles = [
    { id: 'writer', provider: 'openai', model: 'writer-model', baseURL: writer.baseURL, apiKeyEnv: 'WRITER_KEY', contextWindow: 8192, maxTokens: 512 },
    { id: 'reviewer', provider: 'anthropic', model: 'review-model', baseURL: reviewer.baseURL, apiKeyEnv: 'REVIEW_KEY', contextWindow: 16384, maxTokens: 1024 },
  ];
  const config = configuration('http://127.0.0.1:1/v1', { AWWO_PI_MODELS_JSON: JSON.stringify(profiles), WRITER_KEY: 'writer-secret', REVIEW_KEY: 'review-secret' });
  const handles = [];
  const app = createPiServer(config, { startRun: async options => {
    const handle = await startIsolatedRun(options);
    handles.push(handle);
    return handle;
  } });
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const responses = await Promise.all(profiles.map(profile => fetch(`${url}/internal/runs`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...REQUEST, runId: `run_${profile.id}`, sessionId: `session_${profile.id}`, model: profile.id, runtime: 'pi', prompt: `Task for ${profile.id}` }),
  })));
  assert.ok(responses.every(response => response.status === 200));
  await Promise.all([writer.received, reviewer.received]);
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 2);
  assert.equal(handles.length, 2);
  assert.notEqual(handles[0].pid, handles[1].pid);
  assert.notEqual(handles[0].directory, handles[1].directory);
  const written = writer.requests[0];
  const reviewed = reviewer.requests[0];
  assert.equal(written.url, '/v1/chat/completions');
  assert.equal(written.body.model, 'writer-model');
  assert.equal(written.headers.authorization, 'Bearer writer-secret');
  assert.equal(written.body.max_completion_tokens ?? written.body.max_tokens, 512);
  assert.equal(new URL(reviewed.url, reviewer.baseURL).pathname, '/v1/messages');
  assert.equal(reviewed.body.model, 'review-model');
  assert.ok(Object.values(reviewed.headers).some(value => value === 'review-secret' || value === 'Bearer review-secret'));
  assert.equal(reviewed.body.max_tokens, 1024);
  assert.equal(JSON.stringify(written).includes('review-secret'), false);
  assert.equal(JSON.stringify(reviewed).includes('writer-secret'), false);
  assert.equal(JSON.stringify(written).includes('provider-test-key'), false);
  assert.equal(JSON.stringify(reviewed).includes('provider-test-key'), false);
  release();
  for (const response of responses) assert.match(await response.text(), /"type":"completed"/);
  for (const handle of handles) await assert.rejects(access(handle.directory));
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
  assert.equal(config.model, ENV.AWWO_PI_MODEL);
  assert.equal(config.apiKey, ENV.AWWO_PI_API_KEY);
});

test('selected profile context limits apply before starting Pi and do not silently use default capacity', { timeout: 20000 }, async (t) => {
  const model = await provider(t);
  const profiles = [
    { id: 'small', provider: 'openai', model: 'small-model', baseURL: model.baseURL, apiKeyEnv: 'PROFILE_KEY', contextWindow: 4096, maxTokens: 128 },
    { id: 'large', provider: 'openai', model: 'large-model', baseURL: model.baseURL, apiKeyEnv: 'PROFILE_KEY', contextWindow: 65536, maxTokens: 512 },
  ];
  const app = createPiServer(configuration(model.baseURL, { AWWO_PI_MODELS_JSON: JSON.stringify(profiles), PROFILE_KEY: 'profile-secret' }));
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  for (const [selector, prompt] of [['small', 'x'.repeat(4000)], [undefined, 'x'.repeat(32000)]]) {
    const rejected = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, model: selector, prompt }) });
    assert.equal(rejected.status, 413);
    assert.equal((await rejected.json()).error.code, 'CONTEXT_LIMIT');
  }
  assert.equal(model.requests.length, 0);
  const accepted = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, model: 'large', prompt: 'x'.repeat(32000) }) });
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /"type":"completed"/);
  assert.equal(model.requests[0].body.model, 'large-model');
  assert.equal(model.requests[0].headers.authorization, 'Bearer profile-secret');
  assert.equal(model.requests[0].body.max_completion_tokens ?? model.requests[0].body.max_tokens, 512);
});

test('request schema accepts catalog selectors but rejects execution overrides, path traversal, non-text input, and excessive history', () => {
  for (const extra of ['provider', 'baseURL', 'apiKey', 'tools', 'cwd', 'extensions', 'env']) {
    assert.throws(() => validateRequest({ ...REQUEST, [extra]: 'attacker-value' }));
  }
  assert.doesNotThrow(() => validateRequest({ ...REQUEST, model: 'reviewer', runtime: 'pi' }));
  for (const model of ['', ' model', 'model\n', {}, [], null, 123, 'x'.repeat(257)]) assert.throws(() => validateRequest({ ...REQUEST, model }));
  for (const runtime of ['', 'claude', {}, [], null]) assert.throws(() => validateRequest({ ...REQUEST, runtime }));
  assert.throws(() => validateRequest({ ...REQUEST, tenantId: '../../other' }));
  assert.throws(() => validateRequest({ ...REQUEST, prompt: ' ' }));
  assert.throws(() => validateRequest({ ...REQUEST, messages: [{ role: 'system', content: 'override' }] }));
  assert.throws(() => validateRequest({ ...REQUEST, messages: Array(101).fill({ role: 'user', content: 'x' }) }));
  assert.doesNotThrow(() => validateRequest({ ...REQUEST, messages: [{ role: 'assistant', content: '😀'.repeat(16_384) }] }));
  assert.throws(() => validateRequest({ ...REQUEST, messages: [{ role: 'assistant', content: '😀'.repeat(16_385) }] }));
  assert.equal(validateRequest(REQUEST), REQUEST);
});

test('child environment omits inherited host credentials and process hooks', () => {
  const env = workerEnvironment('/isolated-run');
  for (const key of ['HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWWO_PI_API_KEY', 'AWWO_PI_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY']) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  assert.equal(env.PI_CODING_AGENT_DIR, '/isolated-run/agent');
});

test('planner transport boundary accepts 128000 characters and rejects larger or oversized combined history', () => {
  const boundary = { ...REQUEST, prompt: 'x'.repeat(INPUT_LIMITS.promptChars) };
  assert.equal(validateRequest(boundary), boundary);
  assert.throws(() => validateRequest({ ...boundary, prompt: boundary.prompt + 'x' }));
  assert.throws(() => validateRequest({ ...boundary, messages: Array(5).fill({ role: 'user', content: 'x'.repeat(INPUT_LIMITS.historyMessageChars) }) }));
  assert.equal(fitsContextBudget(boundary, loadConfig(ENV)), false);
  assert.equal(fitsContextBudget(boundary, loadConfig({ ...ENV, AWWO_PI_CONTEXT_WINDOW: '200000' })), true);
});

test('context admission counts UTF-8 history bytes and reserves model output capacity', () => {
  const config = loadConfig({ ...ENV, AWWO_PI_CONTEXT_WINDOW: '4096', AWWO_PI_MAX_TOKENS: '128' });
  const bytes = config.contextWindow - config.maxTokens - 256 - 32;
  assert.equal(fitsContextBudget({ ...REQUEST, prompt: 'x'.repeat(bytes) }, config), true);
  assert.equal(fitsContextBudget({ ...REQUEST, prompt: 'x'.repeat(bytes + 1) }, config), false);
  assert.equal(fitsContextBudget({ ...REQUEST, prompt: '汉'.repeat(Math.floor(bytes / 3) + 1) }, config), false);
  assert.equal(fitsContextBudget({ ...REQUEST, prompt: 'x'.repeat(bytes), messages: [{ role: 'user', content: 'previous' }] }, config), false);
});

test('HTTP authentication, unconfigured readiness, and body validation reject before starting a worker', async (t) => {
  let starts = 0;
  const app = createPiServer(loadConfig({ AWWO_PI_TOKEN: TOKEN }), { startRun: async () => { starts++; } });
  const url = await listen(app.server);
  t.after(() => app.close());
  assert.equal((await fetch(`${url}/health`)).status, 503);
  assert.equal((await fetch(`${url}/internal/runs`, { method: 'POST' })).status, 401);
  const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(REQUEST) });
  assert.equal(response.status, 503);
  assert.equal(starts, 0);
});

test('real Pi SDK streams OpenAI-compatible output, restores role-based history, and keeps tools disabled', { timeout: 20000 }, async (t) => {
  const model = await provider(t);
  const request = { ...REQUEST, systemPrompt: 'server-owned assistant instructions', messages: [{ role: 'user', content: 'previous user text' }, { role: 'assistant', content: 'previous assistant text' }] };
  const { handle, events } = await run(t, configuration(model.baseURL), request);
  await handle.done;
  assert.deepEqual(businessEvent(events.at(-1)), { type: 'completed', text: 'Hello from Pi' });
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''), 'Hello from Pi');
  assert.equal(model.requests.length, 1);
  const sent = model.requests[0];
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer provider-test-key');
  assert.equal(sent.body.model, 'test-model');
  assert.deepEqual(sent.body.tools ?? [], []);
  assert.deepEqual(sent.body.messages.map(({ role }) => role), ['system', 'user', 'assistant', 'user']);
  assert.equal(sent.body.messages[0].content, request.systemPrompt);
  assert.equal(sent.body.messages[1].content, 'previous user text');
  assert.deepEqual(sent.body.messages.at(-1).content, [{ type: 'text', text: REQUEST.prompt }]);
  await assert.rejects(access(handle.directory));
});

test('real Pi SDK reaches the configured Anthropic protocol', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { protocol: 'anthropic' });
  const { handle, events } = await run(t, configuration(model.baseURL, { AWWO_PI_PROVIDER: 'anthropic' }));
  await handle.done;
  assert.deepEqual(businessEvent(events.at(-1)), { type: 'completed', text: 'Hello from Pi' });
  assert.equal(model.requests.length, 1);
  assert.equal(new URL(model.requests[0].url, 'http://localhost').pathname, '/v1/messages');
});

test('Ollama uses the OpenAI-compatible path without requiring a remote provider key', { timeout: 20000 }, async (t) => {
  const model = await provider(t);
  const { handle, events } = await run(t, configuration(model.baseURL, { AWWO_PI_PROVIDER: 'ollama', AWWO_PI_API_KEY: '' }));
  await handle.done;
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(model.requests[0].body.max_tokens, 4096);
});

test('provider authentication failures are redacted and do not produce a successful mock answer', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'error' });
  const { handle, events } = await run(t, configuration(model.baseURL));
  await handle.done;
  assert.equal(events.at(-1).type, 'failed');
  assert.equal(JSON.stringify(events).includes('private-provider-key'), false);
  assert.equal(events.some((event) => event.type === 'completed'), false);
});

test('cancellation terminates an actual child and cleans its temporary directory', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  const { handle, events } = await run(t, configuration(model.baseURL));
  await model.received;
  handle.cancel();
  await handle.done;
  assert.equal(events.at(-1).type, 'cancelled');
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
  await assert.rejects(access(handle.directory));
});

test('deadline forcibly bounds an unresponsive model run', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  const { handle, events } = await run(t, configuration(model.baseURL, { AWWO_PI_TIMEOUT_MS: '1000' }));
  await handle.done;
  assert.deepEqual(businessEvent(events.at(-1)), { type: 'failed', code: 'DEADLINE_EXCEEDED', message: 'The model request timed out.' });
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
});

test('the UTF-8 output limit terminates an actual Pi child without returning an oversized success', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'oversize' });
  const { handle, events } = await run(t, configuration(model.baseURL, { AWWO_PI_MAX_OUTPUT_BYTES: '1024' }));
  await handle.done;
  assert.deepEqual(businessEvent(events.at(-1)), { type: 'failed', code: 'OUTPUT_LIMIT', message: 'The model output exceeded the configured limit.' });
  assert.equal(events.some(event => event.type === 'completed'), false);
  assert.ok(events.filter(event => event.type === 'text_delta').reduce((bytes, event) => bytes + Buffer.byteLength(event.delta), 0) <= 1024);
  assert.equal(model.requests.length, 1);
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
  await assert.rejects(access(handle.directory));
});

test('different tenants use separate processes/directories even for the same session id', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  const a = await run(t, configuration(model.baseURL), REQUEST);
  const b = await run(t, configuration(model.baseURL), { ...REQUEST, tenantId: 'tenant_2', runId: 'run_2' });
  assert.notEqual(a.handle.pid, b.handle.pid);
  assert.notEqual(a.handle.directory, b.handle.directory);
  a.handle.cancel();
  b.handle.cancel();
  await Promise.all([a.handle.done, b.handle.done]);
});

test('run-local Pi instructions and extensions are not loaded', { timeout: 20000 }, async (t) => {
  const model = await provider(t);
  const { handle, events } = await run(t, configuration(model.baseURL));
  await mkdir(join(handle.directory, '.pi', 'extensions'), { recursive: true });
  await Promise.all([
    writeFile(join(handle.directory, 'AGENTS.md'), 'SENTINEL_UNTRUSTED_CONTEXT'),
    writeFile(join(handle.directory, '.pi', 'extensions', 'poison.mjs'), 'throw new Error("SENTINEL_EXTENSION_EXECUTED");'),
    writeFile(join(handle.directory, 'agent', 'settings.json'), JSON.stringify({ defaultTools: ['bash'], packages: ['/nonexistent-host-package'] })),
    writeFile(join(handle.directory, 'agent', 'models.json'), '{ definitely invalid model file'),
  ]);
  await handle.done;
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(JSON.stringify(model.requests[0].body).includes('SENTINEL'), false);
  assert.deepEqual(model.requests[0].body.tools ?? [], []);
});

test('model-requested tools cannot execute or create a successful response', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'tool' });
  const { handle, events } = await run(t, configuration(model.baseURL));
  await handle.done;
  assert.equal(events.at(-1).type, 'failed');
  assert.equal(model.requests.length, 1);
});

test('HTTP streaming enforces conversation/run exclusivity, cancellation, and disconnect cleanup', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  const app = createPiServer(configuration(model.baseURL));
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const first = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  assert.equal(first.status, 200);
  const sameRun = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  assert.equal(sameRun.status, 409);
  assert.equal((await sameRun.json()).error.code, 'RUN_BUSY');
  const duplicate = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, runId: 'run_another' }) });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'SESSION_BUSY');
  const cancelled = await fetch(`${url}/internal/runs/${REQUEST.runId}`, { method: 'DELETE', headers });
  assert.equal(cancelled.status, 202);
  assert.match(await first.text(), /"type":"cancelled"/);
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
  const abort = new AbortController();
  const disconnected = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, runId: 'disconnect_1' }), signal: abort.signal });
  assert.equal(disconnected.status, 200);
  abort.abort();
  for (let i = 0; i < 200; i++) {
    if ((await (await fetch(`${url}/health`)).json()).activeRuns === 0) break;
    await sleep(10);
  }
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
});

test('capacity exhaustion rejects an unaccepted conversation and frees capacity after cancellation', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  const app = createPiServer(configuration(model.baseURL, { AWWO_PI_MAX_CONCURRENCY: '1' }));
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const first = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  assert.equal(first.status, 200);
  await model.received;
  const other = { ...REQUEST, runId: 'capacity_other', tenantId: 'other_tenant', sessionId: 'other_session' };
  const rejected = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(other) });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, 'CAPACITY_EXCEEDED');
  assert.equal(model.requests.length, 1);
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 1);
  assert.equal((await fetch(`${url}/internal/runs/${REQUEST.runId}`, { method: 'DELETE', headers })).status, 202);
  assert.match(await first.text(), /"type":"cancelled"/);
  const accepted = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(other) });
  assert.equal(accepted.status, 200);
  assert.equal((await fetch(`${url}/internal/runs/${other.runId}`, { method: 'DELETE', headers })).status, 202);
  assert.match(await accepted.text(), /"type":"cancelled"/);
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
});

test('service shutdown cancels an active real Pi run and waits for child and directory cleanup', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'stall' });
  let handle;
  const app = createPiServer(configuration(model.baseURL), { startRun: async options => {
    handle = await startIsolatedRun(options);
    return handle;
  } });
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  assert.equal(response.status, 200);
  await model.received;
  assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 1);
  const stream = response.text();
  await app.close();
  assert.match(await stream, /"type":"cancelled"/);
  assert.equal(app.server.listening, false);
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
  await assert.rejects(access(handle.directory));
});

test('HTTP to isolated Pi to model protocol returns the documented SSE completion contract', { timeout: 20000 }, async (t) => {
  const model = await provider(t);
  const app = createPiServer(configuration(model.baseURL));
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const rejected = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, tools: ['bash'] }) });
  assert.equal(rejected.status, 400);
  assert.equal(model.requests.length, 0);
  const contextRejected = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, prompt: 'x'.repeat(32_000) }) });
  assert.equal(contextRejected.status, 413);
  assert.equal((await contextRejected.json()).error.code, 'CONTEXT_LIMIT');
  assert.equal(model.requests.length, 0);
  const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(businessEvent(events.at(-1)), { type: 'completed', text: 'Hello from Pi' });
  assert.equal(events.filter((event) => event.type === 'completed').length, 1);
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''), 'Hello from Pi');
  // No sleep or cleanup polling: a terminal response permits the next turn.
  for (let turn = 2; turn <= 4; turn++) {
    const next = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, runId: `consecutive_${turn}` }) });
    assert.equal(next.status, 200);
    assert.ok((await next.text()).includes('"type":"completed"'));
  }
  assert.equal(model.requests.length, 4);
});

test('terminal delivery waits for an actual child to stop and frees the same session without overlapping processes', { timeout: 20000 }, async (t) => {
  const handles = [];
  const terminalStates = [];
  const app = createPiServer(configuration('http://127.0.0.1:1/v1', { AWWO_PI_MAX_CONCURRENCY: '1' }), {
    startRun: async (options) => {
      const handle = await startIsolatedRun({ ...options, onEvent: (event) => {
        if (event.type !== 'text_delta') {
          let alive = true;
          try { process.kill(handle.pid, 0); } catch { alive = false; }
          terminalStates.push({ alive, type: event.type });
        }
        options.onEvent(event);
      } }, { taskURL: new URL('./terminal-exit-fixture.mjs', import.meta.url) });
      handles.push(handle);
      return handle;
    },
  });
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  for (let turn = 0; turn < 3; turn++) {
    const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, runId: `exit_${turn}` }) });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('"type":"completed"'));
    assert.deepEqual(terminalStates.at(-1), { alive: false, type: 'completed' });
    await assert.rejects(access(handles.at(-1).directory));
    assert.equal((await (await fetch(`${url}/health`)).json()).activeRuns, 0);
  }
  assert.equal(handles.length, 3);
  assert.equal(new Set(handles.map(handle => handle.pid)).size, 3);
});

for (const [name, usage, status] of [
  ['missing', undefined, 'unavailable'],
  ['explicit zero', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 'reported'],
  ['partial', { prompt_tokens: 9 }, 'partial'],
  ['cached and reasoning', { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }, 'reported'],
]) test(`real Pi provider usage preserves ${name} across IPC and cleanup`, async t => {
  const fixture = await provider(t, { usage, multilineUsage: name === 'cached and reasoning' });
  const { handle, events } = await run(t, configuration(fixture.baseURL));
  await handle.done;
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'completed');
  const observation = terminal.observability;
  assert.equal(observation.version, 1); assert.equal(observation.usage.status, status);
  assert.equal(observation.usage.inputTokens, usage?.prompt_tokens ?? null);
  assert.equal(observation.usage.outputTokens, usage?.completion_tokens ?? null);
  assert.equal(observation.usage.reasoningTokens, usage?.completion_tokens_details?.reasoning_tokens ?? null);
  assert.ok(observation.timing.workerTotalMs >= observation.timing.setupMs + observation.timing.providerMs - 1);
  assert.ok(observation.timing.providerTtftMs !== null);
  assert.ok(observation.timing.workerFirstDeltaMs >= observation.timing.providerTtftMs);
  assert.equal(fixture.requests.length, 1);
  const metadata = publicHealth(configuration(fixture.baseURL)).models[0];
  assert.equal(metadata.providerModel, fixture.requests[0].body.model);
  assert.equal(metadata.protocol, 'chat_completions');
  assert.equal(fixture.requests[0].url, '/v1/chat/completions');
  for (const key of ['traceparent', 'tracestate', 'baggage']) assert.equal(fixture.requests[0].headers[key], undefined);
  await assert.rejects(access(handle.directory));
});

test('Pi shutdown waits for a pending launch to release capacity and publish its terminal', { timeout: 5000 }, async t => {
  let announce, unblock, cancelled = false, released = false;
  const admitted = new Promise(resolve => { announce = resolve; });
  const launch = new Promise(resolve => { unblock = resolve; });
  const app = createPiServer(loadConfig(ENV), { startRun: async ({ onExit, onEvent }) => {
    announce(); await launch;
    return { done: Promise.resolve(), cancel() { cancelled = true; released = true; onExit(); onEvent({ type: 'cancelled' }); } };
  } });
  const url = await listen(app.server); t.after(() => { unblock(); return app.close(); });
  const response = await fetch(url + '/internal/runs', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(REQUEST) });
  const body = response.text(); await admitted;
  let stopped = false; const closing = app.close().then(() => { stopped = true; });
  await sleep(30); assert.equal(stopped, false); assert.equal(released, false);
  unblock(); await closing;
  assert.equal(cancelled, true); assert.equal(released, true); assert.equal(stopped, true);
  assert.match(await body, /"type":"cancelled"/);
  assert.match(app.observability.metrics(), /outcome="cancelled"/);
  assert.match(app.observability.metrics(), /awwo_worker_active 0/);
});

test('Pi rejects a request whose body finishes after shutdown starts', { timeout: 5000 }, async t => {
  let announce, unblock;
  const admitted = new Promise(resolve => { announce = resolve; });
  const launch = new Promise(resolve => { unblock = resolve; });
  let starts = 0;
  const app = createPiServer(loadConfig(ENV), { startRun: async ({ onExit, onEvent }) => {
    starts++; announce(); await launch;
    return { cancel() { onExit(); onEvent({ type: 'cancelled' }); } };
  } });
  const url = await listen(app.server); t.after(() => { unblock(); return app.close(); });
  const headers = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
  const active = await fetch(url + '/internal/runs', { method: 'POST', headers, body: JSON.stringify(REQUEST) });
  const activeBody = active.text(); await admitted;
  const awaitingBody = once(app.server, 'request');
  const request = httpRequest(url + '/internal/runs', { method: 'POST', headers });
  t.after(() => request.destroy());
  const received = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
  });
  const payload = JSON.stringify({ ...REQUEST, runId: 'late_run', sessionId: 'late_session' });
  request.write(payload.slice(0, 1)); await awaitingBody;
  const closing = app.close();
  request.end(payload.slice(1));
  assert.equal(await received, 503);
  assert.equal(starts, 1);
  unblock(); await closing; await activeBody;
});
