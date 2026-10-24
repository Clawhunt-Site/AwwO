import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childBedrockFetch } from '../bedrock-bridge.ts';
import { relayCall } from './bedrock-relay.mjs';
import { loadConfig, publicHealth } from './config.mjs';
import { relayBody, startRelayCall } from './relay.mjs';
import { createPiServer } from './server.mjs';

const TOKEN = 'local-test-service-token-with-32-characters';
const ENV = { AWWO_PI_TOKEN: TOKEN, AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'test-model', AWWO_PI_API_KEY: 'provider-test-key',
  AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_MODELS: 'bedrock.claude-opus-5-5,bedrock.deepseek-r1' };
const credentials = { credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token' } };
const request = { model: 'bedrock.claude-opus-5-5', stream: true, max_tokens: 900, messages: [{ role: 'user', content: 'Say OK' }] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'awwo-relay-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.mjs');
  await writeFile(file, source);
  return pathToFileURL(file);
}

// A child that answers as bedrock-relay.mjs does: `script` is the messages it sends, in order, each once the last has gone.
const scripted = (messages, { hang = false } = {}) => `
  const send = m => new Promise(done => process.send(m, () => done()));
  process.once('message', async () => {
    for (const m of ${JSON.stringify(messages)}) await send(m);
    ${hang ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
  });
  process.once('disconnect', () => process.exit(0));`;

async function serve(t, config, startCall) {
  const app = createPiServer(config, { relayCall: startCall });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  return { app, port: app.server.address().port };
}

function post(port, body, { token = TOKEN, contentType = 'application/json', path = '/internal/relay-model' } = {}) {
  return new Promise((resolve, reject) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'content-length': Buffer.byteLength(raw) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}
const envelope = (extra = {}) => ({ relayId: 'c0123456789', tenantId: 'tenant_1', model: 'bedrock.claude-opus-5-5', body: request, ...extra });
const errorOf = (response) => JSON.parse(response.text).error;

test('a relayed request goes to the model by its Converse id, streamed with its usage, within the catalog\'s output limit', () => {
  const profile = { model: 'global.anthropic.claude-opus-5-5', maxTokens: 64000 };
  assert.deepEqual(relayBody(request, profile), { ...request, model: profile.model, stream_options: { include_usage: true } });
  assert.equal(relayBody({ ...request, max_tokens: 100000 }, profile).max_tokens, 64000);
  assert.equal(relayBody({ ...request, max_tokens: undefined, max_completion_tokens: 70000 }, profile).max_completion_tokens, 64000);
  const unnamed = relayBody({ ...request, max_tokens: undefined }, profile);
  assert.equal(unnamed.max_tokens, 64000, 'a request that names no limit gets the model\'s own');
  // What the bridge cannot take goes as it came, for the bridge to refuse in its own words.
  assert.equal(relayBody({ ...request, seed: 7 }, profile).seed, 7);
});

test('the worker says it relays, and which of its Bedrock models take tools, only where it has Bedrock models', () => {
  const config = loadConfig(ENV);
  const health = publicHealth(config);
  const bedrock = health.models.filter((model) => model.provider === 'bedrock');
  assert.deepEqual(bedrock.map((model) => [model.id, model.tools]), [['bedrock.claude-opus-5-5', true], ['bedrock.deepseek-r1', false]]);
  assert.equal(health.models.find((model) => model.id === 'test-model').tools, undefined, 'another profile says nothing new');
  assert.equal(loadConfig(ENV).relayTimeoutMs, 1_500_000);
  assert.equal(loadConfig({ ...ENV, AWWO_PI_RELAY_TIMEOUT_MS: '60000' }).relayTimeoutMs, 60000);
  assert.throws(() => loadConfig({ ...ENV, AWWO_PI_RELAY_TIMEOUT_MS: '1800001' }), /AWWO_PI_RELAY_TIMEOUT_MS/);
});

test('/health names the relay where the worker has a Bedrock model, and is unchanged without one', async (t) => {
  const { port } = await serve(t, loadConfig(ENV));
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.relayBedrock, true);
  const { port: plain } = await serve(t, loadConfig({ ...ENV, AWWO_BEDROCK_CATALOG: 'off', AWWO_BEDROCK_MODELS: '' }));
  const without = await fetch(`http://127.0.0.1:${plain}/health`).then((response) => response.json());
  assert.equal('relayBedrock' in without, false);
});

test('a relayed call streams the bridge\'s answer as it comes and frees its slot', async (t) => {
  const pieces = ['data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\nda',
    'ta: [DONE]\n\n'];
  const child = await fixture(t, scripted([...pieces.map((text) => ({ type: 'data', text })), { type: 'end' }]));
  const calls = [];
  const { port } = await serve(t, loadConfig(ENV), async (profile, body) => {
    calls.push({ profile: profile.id, body });
    return startRelayCall(profile, body, { auth: async () => credentials, childURL: child });
  });
  const response = await post(port, envelope());
  assert.equal(response.status, 200);
  assert.match(response.type, /^text\/event-stream/);
  assert.equal(response.text, pieces.join(''), 'the stream reaches the API byte for byte, a line split across pieces included');
  assert.deepEqual(calls, [{ profile: 'bedrock.claude-opus-5-5', body: { ...request, model: 'global.anthropic.claude-opus-5-5', stream_options: { include_usage: true } } }]);
  // The slot is free again: one call after another on a worker whose limit is one.
  const { port: single } = await serve(t, loadConfig({ ...ENV, AWWO_PI_MAX_CONCURRENCY: '1' }), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: child }));
  assert.equal((await post(single, envelope())).status, 200);
  assert.equal((await post(single, envelope({ relayId: 'c0123456790' }))).status, 200);
});

test('a refusal before any stream keeps the bridge\'s status and says it by kind, with the bridge\'s own words for a request it cannot take', async (t) => {
  const throttled = await fixture(t, scripted([{ type: 'refused', status: 429, error: { type: 'ThrottlingException', upstream: true } }]));
  const { port } = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: throttled }));
  const response = await post(port, envelope());
  assert.equal(response.status, 429);
  assert.deepEqual(errorOf(response), { code: 'PROVIDER_REFUSED', message: 'The relayed model request could not be completed.', type: 'ThrottlingException', upstream: true });
  const invalid = await fixture(t, scripted([{ type: 'refused', status: 400, error: { type: 'invalid_request_error', upstream: false, message: 'seed is not supported by Bedrock Converse' } }]));
  const { port: second } = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: invalid }));
  const refused = await post(second, envelope());
  assert.equal(refused.status, 400);
  assert.equal(errorOf(refused).detail, 'seed is not supported by Bedrock Converse');
});

test('a call is refused before any child for what it is not: a request, a model, a stream, a slot', async (t) => {
  let starts = 0;
  const { port } = await serve(t, loadConfig({ ...ENV, AWWO_PI_RELAY_MAX_CONCURRENCY: '1' }), async () => { starts++; throw Object.assign(new Error('x'), { reason: 'never' }); });
  assert.equal((await post(port, envelope(), { token: 'wrong-token-wrong-token-wrong-token-00' })).status, 401);
  assert.equal((await post(port, envelope(), { contentType: 'text/plain' })).status, 415);
  assert.equal((await post(port, '{"relayId":')).status, 400);
  assert.equal(errorOf(await post(port, envelope({ extra: 1 }))).code, 'INVALID_INPUT');
  assert.equal(errorOf(await post(port, envelope({ relayId: 'no spaces' }))).code, 'INVALID_INPUT');
  assert.equal(errorOf(await post(port, envelope({ model: 'test-model' }))).code, 'MODEL_NOT_FOUND', 'only a Bedrock model of this worker is relayed');
  assert.equal(errorOf(await post(port, envelope({ model: 'bedrock.claude-haiku-4-5' }))).code, 'MODEL_NOT_FOUND', 'nor a catalog model this worker does not serve');
  assert.equal(errorOf(await post(port, envelope({ body: { ...request, stream: false } }))).code, 'STREAM_REQUIRED');
  const big = await post(port, envelope({ body: { ...request, messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }] } }));
  assert.equal(big.status, 413);
  assert.equal(starts, 0);
  // A request that cannot be written out again is refused before any child or directory (the API bounds how deeply a
  // request nests; a value JSON.stringify refuses stands for one nested past what it follows).
  const markers = await mkdtemp(join(tmpdir(), 'awwo-relay-marker-'));
  t.after(() => rm(markers, { recursive: true, force: true }));
  const marker = join(markers, 'started');
  const recording = await fixture(t, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(0);`);
  const profile = loadConfig(ENV).models.find((item) => item.id === 'bedrock.claude-opus-5-5');
  await assert.rejects(startRelayCall(profile, { ...request, metadata: { unwritable: 1n } }, { auth: async () => credentials, childURL: recording }),
    (error) => error.reason === 'request');
  await sleep(200);
  await assert.rejects(readFile(marker), /ENOENT/, 'no child was started');
  const unsendable = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, { ...body, metadata: { unwritable: 1n } }, { auth: async () => credentials, childURL: recording }));
  const unwritable = await post(unsendable.port, envelope());
  assert.equal(unwritable.status, 400, unwritable.text);
  assert.equal(errorOf(unwritable).code, 'INVALID_INPUT');
  await assert.rejects(readFile(marker), /ENOENT/, 'nor through the handler');
  const control = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: recording }));
  await post(control.port, envelope());
  assert.equal(await readFile(marker, 'utf8'), '1', 'a request that can be sent starts a child');
  const credentialsDown = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => { throw new Error('IMDS down'); } }));
  const down = await post(credentialsDown.port, envelope());
  assert.equal(down.status, 503);
  assert.equal(errorOf(down).code, 'MODEL_AUTHENTICATION');
  // A worker serving personal connections has nothing to relay to.
  const personal = await serve(t, loadConfig({ AWWO_CREDENTIAL_MODE: 'user', AWWO_PI_TOKEN: TOKEN }), async () => { starts++; });
  assert.equal(errorOf(await post(personal.port, envelope())).code, 'RUNTIME_UNAVAILABLE');
  assert.equal(starts, 0);
});

test('a worker at its limit refuses another relayed call, and a call that ends mid-stream says so in a frame', async (t) => {
  const hanging = await fixture(t, scripted([{ type: 'data', text: 'data: {"choices":[{"index":0,"delta":{"content":"par' }], { hang: true }));
  // One relay slot, and one run slot the relay never takes.
  const { port } = await serve(t, loadConfig({ ...ENV, AWWO_PI_MAX_CONCURRENCY: '1', AWWO_PI_RELAY_MAX_CONCURRENCY: '1' }), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: hanging }));
  const first = new Promise((resolve, reject) => {
    const raw = JSON.stringify(envelope());
    const req = httpRequest({ host: '127.0.0.1', port, path: '/internal/relay-model', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, (res) => {
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
    req.end(raw);
  });
  const { req } = await first;
  const busy = await post(port, envelope({ relayId: 'c0123456790' }));
  assert.equal(busy.status, 429);
  assert.equal(errorOf(busy).code, 'CAPACITY_EXCEEDED');
  // A full relay refuses before it reads a body: a request past the size limit is refused as busy, not as too large.
  const unread = await post(port, envelope({ relayId: 'c0123456792', body: { ...request, messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }] } }));
  assert.equal(errorOf(unread).code, 'CAPACITY_EXCEEDED');
  // The runs' slot is free while the relay is full: the relay's calls are not the runs'.
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.activeRuns, 0);
  req.destroy();
  await sleep(300);
  assert.equal((await post(port, envelope({ relayId: 'c0123456791', body: { ...request, stream: false } }))).status, 400, 'the slot came back once its caller left');
  const dying = await fixture(t, `process.once('message', () => process.send({ type: 'data', text: 'data: {"choices":[{"index":0,"delta":{"content":"cut' }, () => process.exit(4)));`);
  const lost = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: dying }));
  const response = await post(lost.port, envelope());
  assert.equal(response.status, 200);
  assert.match(response.text, /\n\ndata: \{"error":\{"message":"The relayed model call did not complete\.","type":"worker_lost","code":"worker_lost"\}\}\n\n$/);
});

test('a relayed call ends at its time limit, before its stream or within it, and its child is stopped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'awwo-relay-pid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const silent = await fixture(t, `import { writeFileSync } from 'node:fs'; process.once('message', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); });`);
  const { port } = await serve(t, loadConfig({ ...ENV, AWWO_PI_RELAY_TIMEOUT_MS: '1000' }), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: silent }));
  const before = await post(port, envelope());
  assert.equal(before.status, 504);
  assert.equal(errorOf(before).code, 'TIMEOUT');
  const pid = Number(await readFile(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) { await sleep(50); try { process.kill(pid, 0); } catch { alive = false; } }
  assert.equal(alive, false, 'the child was stopped');
  const started = await fixture(t, scripted([{ type: 'data', text: 'data: {"choices":[]}\n\n' }], { hang: true }));
  const within = await serve(t, loadConfig({ ...ENV, AWWO_PI_RELAY_TIMEOUT_MS: '1000' }), async (profile, body) => startRelayCall(profile, body, { auth: async () => credentials, childURL: started }));
  const cut = await post(within.port, envelope());
  assert.equal(cut.status, 200);
  assert.match(cut.text, /"type":"timeout"/);
});

test('the relay child gets the resolved credentials and the request, never the parent\'s environment or Node options', async (t) => {
  const echo = await fixture(t, `process.once('message', m => process.send({ type: 'data', text: JSON.stringify({ env: Object.keys(process.env), execArgv: process.execArgv, message: m }) }, () => process.send({ type: 'end' }, () => process.exit(0))));`);
  const set = { AWS_BEARER_TOKEN_BEDROCK: 'parent-only', AWS_PROFILE: 'parent', NODE_OPTIONS: '--max-old-space-size=64', HTTPS_PROXY: 'http://127.0.0.1:9' };
  const saved = Object.fromEntries(Object.keys(set).map((key) => [key, process.env[key]]));
  Object.assign(process.env, set);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const config = loadConfig({ ...ENV, AWWO_BEDROCK_PROMPT_CACHE_MODELS: 'bedrock.claude-opus-5-5' });
  const keys = [];
  const { port } = await serve(t, config, async (profile, body) => startRelayCall(profile, body, { auth: async (key) => { keys.push(key); return credentials; }, childURL: echo }));
  const seen = JSON.parse((await post(port, envelope())).text);
  assert.deepEqual(keys, [''], 'the parent resolves the credentials, with the profile key (none: the AWS chain)');
  for (const key of Object.keys(set)) assert.equal(seen.env.includes(key), false, `${key} must not reach the child`);
  assert.deepEqual(seen.execArgv, []);
  assert.deepEqual(seen.message, { region: 'us-east-1', model: 'global.anthropic.claude-opus-5-5', auth: credentials, promptCache: true,
    fallbackModel: 'us.anthropic.claude-opus-5-5', url: 'https://bedrock-runtime.us-east-1.amazonaws.com/awwo-bedrock-converse/v1/chat/completions',
    body: JSON.stringify({ ...request, model: 'global.anthropic.claude-opus-5-5', stream_options: { include_usage: true } }) });
});

// The two AWS SDK members the bridge uses; `turn` yields the Converse stream events of one answer, `fail` is a refusal.
function fakeSdk(turn, { fail } = {}) {
  class ConverseStreamCommand { constructor(input) { this.input = input; } }
  class BedrockRuntimeClient {
    async send() { if (fail) throw fail; return { stream: turn() }; }
    destroy() {}
  }
  return { BedrockRuntimeClient, ConverseStreamCommand };
}
const message = { region: 'us-east-1', model: 'global.anthropic.claude-opus-5-5', auth: credentials,
  url: 'https://bedrock-runtime.us-east-1.amazonaws.com/awwo-bedrock-converse/v1/chat/completions',
  body: JSON.stringify({ ...request, model: 'global.anthropic.claude-opus-5-5', stream_options: { include_usage: true } }) };
const load = (sdk) => async () => ({ childBedrockFetch, sdk });
async function relayed(msg, sdk) {
  const sent = [];
  await relayCall(msg, async (m) => { sent.push(m); }, { load: load(sdk) });
  return sent;
}

test('the child passes the bridge\'s stream on as it comes, its usage and end included', async () => {
  const sent = await relayed(message, fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'OK' } } };
    yield { messageStop: { stopReason: 'end_turn' } };
    yield { metadata: { usage: { inputTokens: 3, outputTokens: 1 } } };
  }));
  assert.equal(sent.at(-1).type, 'end');
  const text = sent.filter((m) => m.type === 'data').map((m) => m.text).join('');
  const frames = text.split('\n\n').filter(Boolean).map((frame) => frame.slice('data: '.length));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join(''), 'OK');
  assert.equal(chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 1 });
});

test('the child names a refusal by kind, AWS\'s words never, and a stream AWS broke off ends with the bridge\'s frame', async () => {
  const denial = Object.assign(new Error('User: arn:aws:sts::000000000000:assumed-role/x is not authorized to perform bedrock:InvokeModelWithResponseStream'),
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
  const denied = await relayed(message, fakeSdk(null, { fail: denial }));
  assert.deepEqual(denied.filter((m) => m.type !== 'fact'), [{ type: 'refused', status: 403, error: { type: 'AccessDeniedException', upstream: true } }]);
  assert.doesNotMatch(JSON.stringify(denied), /arn:aws|not authorized/);
  const refused = await relayed({ ...message, body: JSON.stringify({ ...JSON.parse(message.body), seed: 1 }) }, fakeSdk(async function* () {}));
  assert.deepEqual(refused.filter((m) => m.type !== 'fact'), [{ type: 'refused', status: 400, error: { type: 'invalid_request_error', upstream: false, message: 'seed is not supported by Bedrock Converse' } }]);
  const throttled = await relayed(message, fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { throttlingException: { message: 'Too many requests from arn:aws:iam::000000000000:user/x' } };
  }));
  assert.equal(throttled.at(-1).type, 'end');
  const text = throttled.filter((m) => m.type === 'data').map((m) => m.text).join('');
  assert.match(text, /"error":\{"message":"The Bedrock stream reported an error","type":"throttlingException","code":"throttlingException","status":429\}/);
  assert.doesNotMatch(JSON.stringify(throttled), /arn:aws/);
  const unloadable = [];
  await relayCall(message, async (m) => { unloadable.push(m); }, { load: async () => { throw new TypeError('no SDK'); } });
  assert.deepEqual(unloadable, [{ type: 'failed', reason: 'bridge-error:TypeError' }]);
});

// The child is forked with no Node options: it loads TypeScript (the bridge) only where Node strips types by default.
const [major, minor] = process.versions.node.split('.').map(Number);
const stripsByDefault = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

test('the real relay child runs as a child and refuses unusable credentials before any request leaves it',
  { skip: stripsByDefault ? false : `Node ${process.versions.node} does not strip types without flags` }, async (t) => {
  const { port } = await serve(t, loadConfig(ENV), async (profile, body) => startRelayCall(profile, body, { auth: async () => ({ credentials: { accessKeyId: 'bad', secretAccessKey: 'x' } }) }));
  const response = await post(port, envelope());
  assert.equal(response.status, 502);
  assert.deepEqual(errorOf(response), { code: 'PROVIDER_ERROR', message: 'The relayed model request could not be completed.', reason: 'bridge-error:Error' });
});

test('a refusal from the model\'s other profile says it followed the first profile\'s refusal', async () => {
  const failures = () => [
    Object.assign(new Error('Too many requests'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }),
    Object.assign(new Error('Malformed input request'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }),
  ];
  const sdk = (queue) => {
    class ConverseStreamCommand { constructor(input) { this.input = input; } }
    class BedrockRuntimeClient { async send() { throw queue.shift(); } destroy() {} }
    return { BedrockRuntimeClient, ConverseStreamCommand };
  };
  const twice = await relayed({ ...message, fallbackModel: 'us.anthropic.claude-opus-5-5' }, sdk(failures()));
  assert.deepEqual(twice.filter((m) => m.type === 'refused'), [{ type: 'refused', status: 400, error: { type: 'ValidationException', upstream: true, fallback: true } }]);
  assert.ok(twice.some((m) => m.type === 'fact' && m.fact?.event === 'fallback'));
  const once = await relayed(message, sdk(failures().slice(1)));
  assert.deepEqual(once.filter((m) => m.type === 'refused'), [{ type: 'refused', status: 400, error: { type: 'ValidationException', upstream: true } }]);
});

test('a relay child is heard for errors from the moment it is forked', async (t) => {
  const quiet = await fixture(t, `process.once('message', () => process.exit(0));`);
  const profile = loadConfig(ENV).models.find((item) => item.id === 'bedrock.claude-opus-5-5');
  const child = await startRelayCall(profile, request, { auth: async () => credentials, childURL: quiet });
  assert.ok(child.listenerCount('error') >= 1);
  // A fork that fails after it returned, before any handler listens, does not throw in the worker.
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await once(child, 'close');
});
