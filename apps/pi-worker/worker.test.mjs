import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fitsContextBudget, INPUT_LIMITS, loadConfig, publicHealth, validateRequest } from './config.mjs';
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

async function provider(t, { mode = 'success', protocol = 'openai' } = {}) {
  const requests = [];
  let notifyRequest;
  const received = new Promise((resolve) => { notifyRequest = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body, headers: req.headers, url: req.url });
    notifyRequest();
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

test('request schema rejects runtime overrides, path traversal, non-text input, and excessive history', () => {
  for (const extra of ['model', 'provider', 'baseURL', 'apiKey', 'tools', 'cwd', 'extensions', 'env']) {
    assert.throws(() => validateRequest({ ...REQUEST, [extra]: 'attacker-value' }));
  }
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
  assert.deepEqual(events.at(-1), { type: 'completed', text: 'Hello from Pi' });
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
  assert.deepEqual(events.at(-1), { type: 'completed', text: 'Hello from Pi' });
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
  assert.deepEqual(events.at(-1), { type: 'failed', code: 'DEADLINE_EXCEEDED', message: 'The model request timed out.' });
  assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
});

test('the UTF-8 output limit terminates an actual Pi child without returning an oversized success', { timeout: 20000 }, async (t) => {
  const model = await provider(t, { mode: 'oversize' });
  const { handle, events } = await run(t, configuration(model.baseURL, { AWWO_PI_MAX_OUTPUT_BYTES: '1024' }));
  await handle.done;
  assert.deepEqual(events.at(-1), { type: 'failed', code: 'OUTPUT_LIMIT', message: 'The model output exceeded the configured limit.' });
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
  assert.deepEqual(events.at(-1), { type: 'completed', text: 'Hello from Pi' });
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
