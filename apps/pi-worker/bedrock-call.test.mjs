import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childBedrockFetch } from '../bedrock-bridge.ts';
import { bedrockCall } from './bedrock-call.mjs';
import { bedrockComputerCall } from './runner.mjs';

const model = { id: 'bedrock.claude-haiku-4-5', provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', region: 'us-east-1',
  baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/awwo-bedrock-converse/v1', apiKey: '', contextWindow: 200000, maxTokens: 32000 };
const credentials = { credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token' } };
const body = { model: model.model, stream: true, stream_options: { include_usage: true }, max_tokens: 900, messages: [{ role: 'user', content: 'Say OK' }] };
const auth = async () => credentials;

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'awwo-bedrock-call-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.mjs');
  await writeFile(file, source);
  return pathToFileURL(file);
}

test('a managed-execution Bedrock call runs in a child that gets the resolved credentials and the request, never the parent environment or Node options', async t => {
  const childURL = await fixture(t, `process.once('message', m => process.send({ ok: true, raw: { env: Object.keys(process.env), execArgv: process.execArgv, message: m } }, () => process.exit(0)));`);
  // Settings only this process has: the AWS SDK reads such variables from its own process environment.
  const set = { AWS_BEARER_TOKEN_BEDROCK: 'parent-only', AWS_USE_FIPS_ENDPOINT: 'true', AWS_PROFILE: 'parent', NODE_OPTIONS: '--max-old-space-size=64', HTTPS_PROXY: 'http://127.0.0.1:9' };
  const saved = Object.fromEntries(Object.keys(set).map(key => [key, process.env[key]]));
  Object.assign(process.env, set);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const keys = [];
  const raw = await bedrockComputerCall({ ...model, promptCache: true }, body, undefined, { auth: async key => { keys.push(key); return credentials; }, childURL });
  assert.deepEqual(keys, [''], 'the parent resolves the credentials, with the profile key (none: the AWS chain)');
  for (const key of Object.keys(set)) assert.equal(raw.env.includes(key), false, `${key} must not reach the child`);
  // Exactly workerEnvironment's variables; Windows adds its own system ones to every child process.
  const allowed = new Set(['PATH', 'TMPDIR', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'NO_COLOR',
    ...(process.platform === 'win32' ? ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'COMSPEC'] : [])]);
  assert.deepEqual(raw.env.filter(key => !allowed.has(key.toUpperCase())), []);
  assert.deepEqual(raw.execArgv, []);
  assert.deepEqual(raw.message, { region: 'us-east-1', model: model.model, auth: credentials, promptCache: true,
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/awwo-bedrock-converse/v1/chat/completions', body: JSON.stringify(body) });
});

test('in AwwO 本地版 the child loads the runtime\'s module guard first, its one Node option, and no module above AwwO\'s folders', async t => {
  // The layout of an installation: AwwO's folder, and a node_modules another account made above it.
  const top = await mkdtemp(join(tmpdir(), 'awwo-bedrock-guard-test-'));
  t.after(() => rm(top, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(top, 'node_modules', 'planted'), { recursive: true });
  await writeFile(join(top, 'node_modules', 'planted', 'index.js'), "module.exports = 'planted ran';");
  await mkdir(join(top, 'app'), { recursive: true });
  await writeFile(join(top, 'app', 'child.mjs'), [
    "import { createRequire } from 'node:module';",
    "let planted; try { planted = createRequire(import.meta.url)('planted'); } catch (error) { planted = error.code; }",
    "process.once('message', () => process.send({ ok: true, raw: { planted, execArgv: process.execArgv, env: Object.keys(process.env) } }, () => process.exit(0)));",
  ].join('\n'));
  const guard = join(import.meta.dirname, '..', '..', 'scripts', 'awwo-local-module-guard.cjs');
  const set = { AWWO_LOCAL_MODULE_GUARD: guard, AWWO_LOCAL_MODULE_ROOTS: JSON.stringify([join(top, 'app')]) };
  const saved = Object.fromEntries(Object.keys(set).map(key => [key, process.env[key]]));
  Object.assign(process.env, set);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const raw = await bedrockComputerCall(model, body, undefined, { auth, childURL: pathToFileURL(join(top, 'app', 'child.mjs')) });
  assert.deepEqual(raw.execArgv, ['--require', guard]);
  assert.equal(raw.planted, 'MODULE_NOT_FOUND');
  assert.equal(raw.env.includes('AWWO_LOCAL_MODULE_ROOTS'), true);
  assert.equal(raw.env.some(key => ['AWWO_LOCAL_MODULE_GUARD', 'NODE_OPTIONS'].includes(key.toUpperCase())), false, 'the guard reaches the child as its one Node option, not as settings to pass on');
});

test('a managed call hands its child the model\'s other profile, and logs the child\'s facts, closed labels only', async t => {
  const echo = await fixture(t, `process.once('message', m => process.send({ ok: true, raw: { message: m } }, () => process.exit(0)));`);
  const fallbackModel = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  const raw = await bedrockComputerCall({ ...model, fallbackModel }, body, undefined, { auth, childURL: echo });
  assert.equal(raw.message.fallbackModel, fallbackModel);
  assert.equal('fallbackModel' in (await bedrockComputerCall(model, body, undefined, { auth, childURL: echo })).message, false);
  // The child's facts go to this worker's log as rebuilt lines; one off the closed shapes is dropped.
  const facts = [{ event: 'fallback', from: model.model, to: fallbackModel, after: 'ServiceUnavailableException' },
    { event: 'failed', model: fallbackModel, error: 'ThrottlingException', status: 429, stage: 'request', upstream: true },
    { event: 'failed', model: fallbackModel, error: 'Too many tokens per day, arn:aws:iam::0:user/x', status: 429, stage: 'request', upstream: true }];
  const reporting = await fixture(t, `process.once('message', () => process.send({ ok: false, reason: 'bedrock:429:ThrottlingException', facts: ${JSON.stringify(facts)} }, () => process.exit(0)));`);
  const logged = [];
  const error = console.error;
  console.error = line => logged.push(String(line));
  try {
    await assert.rejects(bedrockComputerCall({ ...model, fallbackModel }, body, undefined, { auth, childURL: reporting }), failure => failure.reason === 'bedrock:429:ThrottlingException');
  } finally { console.error = error; }
  assert.deepEqual(logged.map(line => JSON.parse(line)), [
    { service: 'awwo-pi-worker', event: 'bedrock_profile_fallback', from: model.model, to: fallbackModel, after: 'ServiceUnavailableException' },
    { service: 'awwo-pi-worker', event: 'bedrock_call_failed', model: fallbackModel, error: 'ThrottlingException', status: 429, stage: 'request', upstream: true }]);
});

test('a child that answers a failure, or ends without an answer, is a failed call that says why', async t => {
  const failing = await fixture(t, `process.once('message', () => process.send({ ok: false, reason: 'bedrock:403:AccessDeniedException' }, () => process.exit(0)));`);
  await assert.rejects(bedrockComputerCall(model, body, undefined, { auth, childURL: failing }), error => error.reason === 'bedrock:403:AccessDeniedException');
  const silent = await fixture(t, `process.once('message', () => process.exit(3));`);
  await assert.rejects(bedrockComputerCall(model, body, undefined, { auth, childURL: silent }), error => error.reason === 'child-exit:3');
  await assert.rejects(bedrockComputerCall(model, body, undefined, { auth: async () => { throw new Error('IMDS down'); }, childURL: silent }), error => error.reason === 'credentials');
});

test('an abort stops the call and its child', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'awwo-bedrock-call-pid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const hanging = await fixture(t, `import { writeFileSync } from 'node:fs'; process.once('message', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); });`);
  const controller = new AbortController();
  const call = bedrockComputerCall(model, body, controller.signal, { auth, childURL: hanging, graceMs: 200 });
  const { readFile } = await import('node:fs/promises');
  let pid;
  for (let i = 0; i < 100 && !pid; i++) { await new Promise(resolve => setTimeout(resolve, 50)); pid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined; }
  assert.ok(pid, 'the child started');
  controller.abort();
  await assert.rejects(call, error => error.name === 'AbortError');
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) { await new Promise(resolve => setTimeout(resolve, 50)); try { process.kill(pid, 0); } catch { alive = false; } }
  assert.equal(alive, false, 'the child was stopped');
});

// The child is forked with no Node options, as a run's child is: it loads TypeScript (the bridge, the gatherer) only
// where Node strips types by default (22.18+, 23.6+), which the production host does for every Bedrock run.
const [major, minor] = process.versions.node.split('.').map(Number);
const stripsByDefault = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

test('the real child module runs as a child and refuses unusable credentials before any request leaves it',
  { skip: stripsByDefault ? false : `Node ${process.versions.node} does not strip types without flags` }, async () => {
  await assert.rejects(bedrockComputerCall(model, body, undefined, { auth: async () => ({ credentials: { accessKeyId: 'bad', secretAccessKey: 'x' } }) }),
    error => error.reason === 'bridge-error:Error');
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
const message = { region: model.region, model: model.model, auth: credentials, url: `${model.baseURL}/chat/completions`, body: JSON.stringify(body) };
const load = sdk => async () => ({ childBedrockFetch, sdk });

test('the call gathers the answer, and names an AWS refusal, a bridge refusal or a broken stream by kind only', async () => {
  const answered = await bedrockCall(message, { load: load(fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'OK' } } };
    yield { messageStop: { stopReason: 'end_turn' } };
    yield { metadata: { usage: { inputTokens: 3, outputTokens: 1 } } };
  })) });
  assert.equal(answered.ok, true);
  assert.equal(answered.raw.choices[0].message.content, 'OK');
  assert.equal(answered.raw.choices[0].finish_reason, 'stop');
  assert.equal(answered.raw.usage.prompt_tokens, 3);
  const denial = Object.assign(new Error('User: arn:aws:sts::000000000000:assumed-role/x is not authorized to perform bedrock:InvokeModelWithResponseStream'),
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
  // A failed call names its failure by kind, and sends back the bridge's fact of it (closed labels) for the parent's log.
  // upstream: AWS reported the failure; the bridge's own refusals (a request or a stream it cannot take) are not AWS's.
  const failed = (error, status, stage, upstream) => [{ event: 'failed', model: model.model, error, status, stage, upstream }];
  const denied = await bedrockCall(message, { load: load(fakeSdk(null, { fail: denial })) });
  assert.deepEqual(denied, { ok: false, reason: 'bedrock:403:AccessDeniedException', facts: failed('AccessDeniedException', 403, 'request', true) });
  assert.doesNotMatch(JSON.stringify(denied), /arn:aws|not authorized/);
  const refused = await bedrockCall({ ...message, body: JSON.stringify({ ...body, seed: 1 }) }, { load: load(fakeSdk(async function* () {})) });
  assert.deepEqual(refused, { ok: false, reason: 'bedrock:400:invalid_request_error', facts: failed('invalid_request_error', 400, 'request', false) });
  const broken = await bedrockCall(message, { load: load(fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'cut' } } };
  })) });
  // The bridge ends a stream that stopped early with its own error frame, which names no AWS status.
  assert.deepEqual(broken, { ok: false, reason: 'stream:error:api_error', facts: failed('api_error', 502, 'stream', false) });
  const throttled = await bedrockCall(message, { load: load(fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { throttlingException: { message: 'Too many requests from arn:aws:iam::000000000000:user/x' } };
  })) });
  assert.deepEqual(throttled, { ok: false, reason: 'stream:error:429:throttlingException', facts: failed('throttlingException', 429, 'stream', true) });
  assert.doesNotMatch(JSON.stringify(throttled), /arn:aws/);
  // A stream lost on its way to AWS (a connection reset, which AWS never reported) names no AWS status either, though
  // it failed on AWS's side of the bridge.
  const reset = await bedrockCall(message, { load: load(fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  })) });
  assert.deepEqual(reset, { ok: false, reason: 'stream:error:connection_error', facts: failed('connection_error', 502, 'stream', true) });
  // And one lost after AWS answered but before its first event (the SDK stamps it with AWS's 200, bedrock-sdk.test.mjs).
  const lostOnAnswer = await bedrockCall(message, { load: load(fakeSdk(null, { fail: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', $metadata: { httpStatusCode: 200 } }) })) });
  assert.deepEqual(lostOnAnswer, { ok: false, reason: 'stream:error:connection_error', facts: failed('connection_error', 502, 'stream', true) });
  const unloadable = await bedrockCall(message, { load: async () => { throw new TypeError('no SDK'); } });
  assert.deepEqual(unloadable, { ok: false, reason: 'bridge-error:TypeError' });
});

test('a managed call its model\'s profile refuses is asked of the model\'s other profile, and says so', async () => {
  const fallbackModel = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  const asked = [];
  class ConverseStreamCommand { constructor(input) { this.input = input; } }
  class BedrockRuntimeClient {
    async send(command) {
      asked.push(command.input.modelId);
      if (asked.length === 1) throw Object.assign(new Error('Bedrock is unable to process your request.'), { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } });
      return { stream: (async function* () {
        yield { messageStart: { role: 'assistant' } };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'OK' } } };
        yield { messageStop: { stopReason: 'end_turn' } };
      })() };
    }
    destroy() {}
  }
  const answered = await bedrockCall({ ...message, fallbackModel }, { load: load({ BedrockRuntimeClient, ConverseStreamCommand }) });
  assert.equal(answered.ok, true);
  assert.equal(answered.raw.choices[0].message.content, 'OK');
  assert.deepEqual(asked, [model.model, fallbackModel]);
  assert.deepEqual(answered.facts, [{ event: 'fallback', from: model.model, to: fallbackModel, after: 'ServiceUnavailableException' }]);
  // Without a fallback model the refusal is the call's answer, as before.
  asked.length = 0;
  const single = await bedrockCall(message, { load: load({ BedrockRuntimeClient, ConverseStreamCommand }) });
  assert.equal(single.reason, 'bedrock:503:ServiceUnavailableException');
  assert.deepEqual(asked, [model.model]);
});
