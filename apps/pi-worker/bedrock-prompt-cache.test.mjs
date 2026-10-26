import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, publicHealth } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';

const base = {
  AWWO_PI_TOKEN: 'x'.repeat(40), AWWO_PI_PROVIDER: 'llmgate', AWWO_PI_MODEL: 'qwen3.8-27b-p6', AWWO_PI_API_KEY: 'gate-key', AWWO_CREDENTIAL_MODE: 'operator',
  AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', AWWO_BEDROCK_CATALOG: 'builtin',
  AWWO_BEDROCK_MODELS: 'bedrock.deepseek-r1,bedrock.claude-haiku-4-5,bedrock.claude-sonnet-4-6', AWWO_PI_CANCEL_GRACE_MS: '100',
};
const cached = (config) => Object.fromEntries(config.models.filter(m => m.provider === 'bedrock').map(m => [m.id, m.promptCache === true]));
const off = { 'bedrock.deepseek-r1': false, 'bedrock.claude-haiku-4-5': false, 'bedrock.claude-sonnet-4-6': false };

test('the prompt cache reaches only the Claude models AWWO_BEDROCK_PROMPT_CACHE_MODELS names, and never the health', () => {
  assert.deepEqual(cached(loadConfig(base)), off);
  assert.deepEqual(cached(loadConfig({ ...base, AWWO_BEDROCK_PROMPT_CACHE_MODELS: '' })), off);
  const config = loadConfig({ ...base, AWWO_BEDROCK_PROMPT_CACHE_MODELS: 'bedrock.claude-haiku-4-5' });
  assert.deepEqual(cached(config), { ...off, 'bedrock.claude-haiku-4-5': true });
  assert.deepEqual(publicHealth(config), publicHealth(loadConfig(base)));
  // It composes with the planner's thinking budget on the same model.
  const both = loadConfig({ ...base, AWWO_BEDROCK_PROMPT_CACHE_MODELS: 'bedrock.claude-haiku-4-5',
    AWWO_PI_BEDROCK_THINKING_BUDGET: '2048', AWWO_PI_BEDROCK_THINKING_MODELS: 'bedrock.claude-haiku-4-5' });
  const haiku = both.models.find(m => m.id === 'bedrock.claude-haiku-4-5');
  assert.equal(haiku.promptCache, true);
  assert.equal(haiku.thinkingBudget, 2048);
});

test('a prompt-cache setting that names anything but a served Claude model stops the worker', () => {
  for (const models of ['bedrock.deepseek-r1', 'bedrock.claude-opus-5-5', 'bedrock.claude-haiku-4-5,', 'claude-haiku-4-5']) {
    assert.throws(() => loadConfig({ ...base, AWWO_BEDROCK_PROMPT_CACHE_MODELS: models }), /AWWO_BEDROCK_PROMPT_CACHE_MODELS/, models);
  }
});

test('the runner hands the prompt-cache setting to a Bedrock child, and only to the model it names', { timeout: 15_000 }, async () => {
  const config = loadConfig({ ...base, AWWO_BEDROCK_PROMPT_CACHE_MODELS: 'bedrock.claude-haiku-4-5' });
  const taskURL = new URL('./bedrock-ipc-fixture.mjs', import.meta.url);
  const bedrockAuth = async () => ({ bearerToken: 'ABSKbedrockkey000000000000000000' });
  const runOnce = async (model) => {
    const events = [];
    const request = { runId: 'run-1', tenantId: 'tenant-1', sessionId: 'session-1', prompt: 'Hello', messages: [], model };
    const handle = await startIsolatedRun({ config, request, onEvent: event => events.push(event), onExit: () => {} }, { taskURL, bedrockAuth });
    await handle.done;
    return JSON.parse(events.find(event => event.type === 'completed').text);
  };
  const logged = [];
  const error = console.error;
  console.error = line => logged.push(String(line));
  try {
    assert.deepEqual(await runOnce('bedrock.claude-haiku-4-5'), { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', region: 'us-east-1',
      apiKey: '', thinkingBudget: null, promptCache: true, fallbackModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', reasoningEfforts: null, effort: null });
    assert.equal((await runOnce('bedrock.claude-sonnet-4-6')).promptCache, null);
    // A model without a second profile gets none.
    assert.equal((await runOnce('bedrock.deepseek-r1')).fallbackModel, null);
  } finally { console.error = error; }
  // The child's content-free facts reach this worker's log, one closed line each, with the run's id.
  assert.deepEqual(logged.map(line => JSON.parse(line)).map(({ from, to }) => [from, to]), [
    ['global.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
    ['global.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6']]);
  assert.deepEqual(JSON.parse(logged[0]), { service: 'awwo-pi-worker', runId: 'run-1', event: 'bedrock_profile_fallback',
    from: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', to: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', after: 'ThrottlingException' });
});
