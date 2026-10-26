import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { effortAllowed, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { runPayloadHook, thinkingOff, withEffort } from './payload-hooks.mjs';
import { startIsolatedRun } from './runner.mjs';
import { createPiServer } from './server.mjs';

// A thinking effort a run may name for Claude Opus 5.5 on Bedrock (2026-10-26): the catalog lists the levels, this worker
// publishes them and checks a run's effort against its model, and the run's call carries it to the bridge, which sends it
// to Claude as output_config.effort.
const TOKEN = 'local-test-service-token-with-32-characters';
const base = {
  AWWO_PI_TOKEN: TOKEN, AWWO_PI_PROVIDER: 'llmgate', AWWO_PI_MODEL: 'qwen3.8-27b-p6', AWWO_PI_API_KEY: 'gate-key', AWWO_CREDENTIAL_MODE: 'operator',
  AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', AWWO_BEDROCK_CATALOG: 'builtin',
  AWWO_BEDROCK_MODELS: 'bedrock.claude-opus-5-5,bedrock.claude-haiku-4-5', AWWO_PI_CANCEL_GRACE_MS: '100',
};
const REQUEST = { runId: 'run_1', tenantId: 'tenant_1', sessionId: 'session_1', prompt: 'Build the page', messages: [] };
const EFFORTS = ['low', 'medium', 'high'];

test('health lists Claude Opus 5.5\'s thinking efforts and its default, and no other model claims any', () => {
  const config = loadConfig(base);
  const models = Object.fromEntries(publicHealth(config).models.map(model => [model.id, [model.reasoningEfforts, model.defaultReasoningEffort]]));
  assert.deepEqual(models, { 'qwen3.8-27b-p6': [undefined, undefined], 'bedrock.claude-opus-5-5': [EFFORTS, 'medium'], 'bedrock.claude-haiku-4-5': [undefined, undefined] });
  assert.deepEqual(resolveModelConfig(config, 'bedrock.claude-opus-5-5').reasoningEfforts, EFFORTS);
  // A Bedrock profile of MODELS_JSON offers none: only the catalog says which levels a model takes.
  const own = loadConfig({ ...base, AWWO_BEDROCK_CATALOG: 'off', AWWO_PI_MODELS_JSON: JSON.stringify([{ id: 'claude', provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5' }]) });
  assert.equal('reasoningEfforts' in publicHealth(own).models[1], false);
});

test('an operator thinking budget never reaches a model that takes an effort, and naming one stops the worker', () => {
  const budget = { AWWO_PI_BEDROCK_THINKING_BUDGET: '2048' };
  // As production names it (2026-10-26): the planner's Haiku thinks, Opus 5.5 keeps its effort.
  const config = loadConfig({ ...base, ...budget, AWWO_PI_BEDROCK_THINKING_MODELS: 'bedrock.claude-haiku-4-5' });
  assert.equal(resolveModelConfig(config, 'bedrock.claude-haiku-4-5').thinkingBudget, 2048);
  assert.equal(resolveModelConfig(config, 'bedrock.claude-opus-5-5').thinkingBudget, undefined);
  assert.throws(() => loadConfig({ ...base, ...budget, AWWO_PI_BEDROCK_THINKING_MODELS: 'bedrock.claude-opus-5-5' }),
    /AWWO_PI_BEDROCK_THINKING_MODELS names bedrock.claude-opus-5-5, which is not a Claude model this worker serves through Bedrock that takes a thinking budget/);
});

test('a run may name one of the bridge\'s levels, and only for a model that offers it', () => {
  for (const effort of EFFORTS) assert.equal(validateRequest({ ...REQUEST, effort }).effort, effort);
  assert.equal(validateRequest(REQUEST).effort, undefined);
  for (const effort of ['minimal', 'none', 'xhigh', 'max', 'LOW', '', null, 3, ['low']]) {
    assert.throws(() => validateRequest({ ...REQUEST, effort }), /Invalid effort selector/, JSON.stringify(effort));
  }
  const config = loadConfig(base);
  const opus = resolveModelConfig(config, 'bedrock.claude-opus-5-5');
  const haiku = resolveModelConfig(config, 'bedrock.claude-haiku-4-5');
  assert.deepEqual([effortAllowed(opus, 'low'), effortAllowed(opus, undefined), effortAllowed(haiku, undefined)], [true, true, true]);
  assert.deepEqual([effortAllowed(haiku, 'low'), effortAllowed(resolveModelConfig(config), 'low')], [false, false]);
});

test('the server refuses an effort its model does not offer before any run starts, and hands the run one it offers', async t => {
  const started = [];
  const app = createPiServer(loadConfig(base), { startRun: async ({ request, onEvent, onExit }) => {
    started.push(request);
    setImmediate(() => { onEvent({ type: 'completed', text: 'done' }); onExit(); });
    return { cancel() {}, done: Promise.resolve(), pid: 0, directory: '' };
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}/internal/runs`;
  const send = body => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [runId, model] of [['run_a', 'bedrock.claude-haiku-4-5'], ['run_b', undefined]]) {
    const refused = await send({ ...REQUEST, runId, model, effort: 'low' });
    assert.equal(refused.status, 400, String(model));
    assert.equal((await refused.json()).error.code, 'EFFORT_NOT_SUPPORTED');
  }
  assert.equal(started.length, 0);
  const accepted = await send({ ...REQUEST, runId: 'run_c', model: 'bedrock.claude-opus-5-5', effort: 'low' });
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /"type":"completed"/);
  assert.equal(started[0].effort, 'low');
});

test('the runner hands a Bedrock child its model\'s efforts and the run\'s effort', { timeout: 15_000 }, async () => {
  const config = loadConfig(base);
  const taskURL = new URL('./bedrock-ipc-fixture.mjs', import.meta.url);
  const bedrockAuth = async () => ({ bearerToken: 'ABSKbedrockkey000000000000000000' });
  const runOnce = async (model, effort) => {
    const events = [];
    const request = { ...REQUEST, model, ...(effort ? { effort } : {}) };
    const handle = await startIsolatedRun({ config, request, onEvent: event => events.push(event), onExit: () => {} }, { taskURL, bedrockAuth });
    await handle.done;
    return JSON.parse(events.find(event => event.type === 'completed').text);
  };
  const error = console.error;
  console.error = () => {};
  try {
    const opus = await runOnce('bedrock.claude-opus-5-5', 'low');
    assert.deepEqual([opus.reasoningEfforts, opus.effort], [EFFORTS, 'low']);
    const plain = await runOnce('bedrock.claude-opus-5-5');
    assert.deepEqual([plain.reasoningEfforts, plain.effort], [EFFORTS, null]);
    assert.deepEqual(Object.values(await runOnce('bedrock.claude-haiku-4-5')).slice(-2), [null, null]);
  } finally { console.error = error; }
});

// The child's own request, through the real Pi SDK (pi-task.mjs installs the hook into its stream), to a model service on
// loopback in place of the bridge, which the run would otherwise call in-process: the effort a run names is the call's
// reasoning_effort, and a run that names none sends no such field. (Which runs may name one is the server's check above.)
test('the isolated child sends the run\'s effort as its call\'s reasoning_effort, and none where the run names none', { timeout: 40_000 }, async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: 'Hello from Pi' });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = loadConfig({ AWWO_PI_TOKEN: TOKEN, AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'test-model', AWWO_PI_API_KEY: 'provider-test-key',
    AWWO_PI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AWWO_PI_TIMEOUT_MS: '20000', AWWO_PI_CANCEL_GRACE_MS: '100' });
  for (const [runId, effort] of [['run_low', 'low'], ['run_none', undefined]]) {
    const events = [];
    const handle = await startIsolatedRun({ config, request: { ...REQUEST, runId, sessionId: runId, ...(effort ? { effort } : {}) }, onEvent: event => events.push(event), onExit: () => {} });
    await handle.done;
    assert.equal(events.at(-1).type, 'completed', JSON.stringify(events.at(-1)));
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.equal('reasoning_effort' in requests[1], false);
  assert.deepEqual(Object.keys(requests[0]).filter(key => key !== 'reasoning_effort').sort(), Object.keys(requests[1]).sort(), 'the call is otherwise the same');
});

test('a run\'s call carries its effort as reasoning_effort after the agent\'s own hook, and the thinking switch is as before', async () => {
  const params = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const agent = async value => ({ ...value, store: false });
  assert.deepEqual(await runPayloadHook(agent, { effort: 'low' })(params, {}), { ...params, store: false, reasoning_effort: 'low' });
  assert.deepEqual(await runPayloadHook(undefined, { effort: 'high' })(params, {}), { ...params, reasoning_effort: 'high' });
  // A hook that returns nothing leaves the request as it was, which the effort then joins.
  assert.deepEqual(await withEffort(async () => undefined, 'medium')(params, {}), { ...params, reasoning_effort: 'medium' });
  // Neither applies: the agent's own hook, or none, exactly.
  assert.equal(runPayloadHook(agent, {}), agent);
  assert.equal(runPayloadHook(undefined, { effort: '' }), undefined);
  // The thinking switch: the DeepSeek API's own field, the chat template's for any other model, then the effort.
  assert.deepEqual(await runPayloadHook(undefined, { disableThinking: true, provider: 'deepseek' })(params, {}), { ...params, thinking: { type: 'disabled' } });
  assert.deepEqual(await thinkingOff(undefined, 'llmgate')({ ...params, chat_template_kwargs: { a: 1 } }, {}), { ...params, chat_template_kwargs: { a: 1, enable_thinking: false } });
  assert.deepEqual(await runPayloadHook(undefined, { disableThinking: true, provider: 'llmgate', effort: 'low' })(params, {}),
    { ...params, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
});
