const businessEvent = ({ observability, ...event }) => event;
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { DEEPSEEK_BASE_URL } from '../bedrock-catalog.ts';
import { loadConfig, publicHealth } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';

const TOKEN = 'local-test-service-token-with-32-characters';
const REQUEST = { runId: 'run_1', tenantId: 'tenant_1', sessionId: 'session_1', prompt: 'current request', messages: [] };
const GATE = { AWWO_PI_TOKEN: TOKEN, AWWO_LLMGATE_ONLY: 'true', AWWO_PI_PROVIDER: 'llmgate', AWWO_PI_MODEL: 'qwen3.8-27b-p6', AWWO_PI_API_KEY: 'gate-key',
  AWWO_DEEPSEEK_API_KEY: 'deepseek-key' };
const FLASH = { id: 'deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', apiKeyEnv: 'AWWO_DEEPSEEK_API_KEY', contextWindow: 1_000_000, maxTokens: 32_768 };
const withProfiles = (profiles, overrides = {}) => loadConfig({ ...GATE, AWWO_PI_MODELS_JSON: JSON.stringify(profiles), ...overrides });

test('a Gate-only Pi worker serves a deepseek profile only where the platform policy names deepseek, and then says so', () => {
  assert.throws(() => withProfiles([FLASH]), /AWWO_LLMGATE_ONLY allows DeepSeek profiles only when AWWO_PLATFORM_PROVIDERS includes deepseek/);
  const config = withProfiles([FLASH], { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' });
  assert.equal(config.ready, true);
  const flash = config.models.find(profile => profile.id === 'deepseek-flash');
  assert.deepEqual({ provider: flash.provider, baseURL: flash.baseURL, apiKey: flash.apiKey, protocol: flash.protocol },
    { provider: 'deepseek', baseURL: DEEPSEEK_BASE_URL, apiKey: 'deepseek-key', protocol: 'chat_completions' });
  const health = publicHealth(config);
  assert.equal(health.platformOnly, true);
  assert.deepEqual(health.platformProviders, ['llmgate', 'deepseek']);
  assert.deepEqual(publicHealth(loadConfig({ ...GATE, AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' })).llmgateOnly, true, 'a policy is not a claim');
  for (const other of [{ baseURL: 'https://api.deepseek.com/v1' }, { baseURL: 'https://api.clawhunt.site/v1' }, { baseURL: 'https://deepseek.example/v1' },
    { baseURL: 'https://api.deepseek.com/' }, { baseURL: 'https://API.DEEPSEEK.COM' }]) {
    assert.throws(() => withProfiles([{ ...FLASH, ...other }], { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' }), /must use https:\/\/api\.deepseek\.com with Chat Completions/, JSON.stringify(other));
  }
  assert.throws(() => withProfiles([FLASH], { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek', AWWO_CREDENTIAL_MODE: 'user' }), /DeepSeek models use operator credentials/);
  // A default model on DeepSeek is held to its URL too, whatever AWWO_PI_BASE_URL says, in every mode.
  for (const llmgateOnly of ['true', 'false']) {
    assert.throws(() => loadConfig({ ...GATE, AWWO_LLMGATE_ONLY: llmgateOnly, AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek', AWWO_PI_PROVIDER: 'deepseek', AWWO_PI_MODEL: 'deepseek-flash',
      AWWO_PI_BASE_URL: 'https://deepseek.example/v1' }), /must use https:\/\/api\.deepseek\.com with Chat Completions/, llmgateOnly);
  }
  // Only the deepseek name reaches the DeepSeek API: any other profile at its URL is outside the LLM Gate, and refused.
  for (const provider of ['openai', 'llmgate']) {
    assert.throws(() => withProfiles([{ id: 'lookalike', provider, model: 'deepseek-flash', baseURL: DEEPSEEK_BASE_URL, apiKeyEnv: 'AWWO_PI_API_KEY' }], { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' }),
      /AWWO_LLMGATE_ONLY requires the LLM Gate endpoint for every model profile/, provider);
  }
  assert.throws(() => loadConfig({ ...GATE, AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek', AWWO_PI_BASE_URL: DEEPSEEK_BASE_URL }), /requires the LLM Gate endpoint/);
});

test('the DeepSeek key is read from its own variable only, and no other Pi profile reads it or holds it', () => {
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock,deepseek' };
  assert.throws(() => withProfiles([{ ...FLASH, apiKeyEnv: 'AWWO_PI_API_KEY' }], policy), /profile 1 is a deepseek profile, which reads its key from AWWO_DEEPSEEK_API_KEY/);
  for (const other of [{ id: 'gate-two', provider: 'llmgate', model: 'gpt-5.5' }, { id: 'bedrock-two', provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }]) {
    assert.throws(() => withProfiles([{ ...other, apiKeyEnv: 'AWWO_DEEPSEEK_API_KEY' }], policy), /profile 1 may not read AWWO_DEEPSEEK_API_KEY, which only a deepseek profile reads/, other.provider);
  }
  // A DeepSeek default model reads the DeepSeek key, never AWWO_PI_API_KEY, though both are set.
  const onDeepSeek = { ...GATE, ...policy, AWWO_PI_PROVIDER: 'deepseek', AWWO_PI_MODEL: 'deepseek-flash' };
  assert.equal(loadConfig(onDeepSeek).models[0].apiKey, 'deepseek-key');
  const keyless = loadConfig({ ...onDeepSeek, AWWO_DEEPSEEK_API_KEY: '' });
  assert.equal(keyless.ready, false);
  assert.ok(keyless.missing.includes('AWWO_DEEPSEEK_API_KEY'));
  assert.equal(keyless.models[0].apiKey, '');
  // The backstop: another profile's key in the DeepSeek variable stops startup, also before any DeepSeek profile exists.
  assert.throws(() => withProfiles([FLASH], { ...policy, AWWO_DEEPSEEK_API_KEY: 'gate-key' }), /AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key/);
  assert.throws(() => loadConfig({ ...GATE, AWWO_DEEPSEEK_API_KEY: 'gate-key' }), /AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key/);
  assert.equal(loadConfig(GATE).ready, true, 'a distinct DeepSeek key without a DeepSeek profile changes nothing');
});

test('only a deepseek profile may switch its own thinking off, and the default model may sit on DeepSeek with the switch', () => {
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' };
  assert.equal(withProfiles([{ ...FLASH, disableThinking: true }], policy).models.find(profile => profile.id === 'deepseek-flash').disableThinking, true);
  assert.equal(withProfiles([{ ...FLASH, disableThinking: false }], policy).models.find(profile => profile.id === 'deepseek-flash').disableThinking, undefined);
  assert.throws(() => withProfiles([{ ...FLASH, disableThinking: 'true' }], policy), /disableThinking flag that only a deepseek profile may carry/);
  assert.throws(() => withProfiles([{ id: 'reviewer', provider: 'llmgate', model: 'review-model', apiKeyEnv: 'AWWO_PI_API_KEY', disableThinking: true }], policy),
    /disableThinking flag that only a deepseek profile may carry/);
  const onDeepSeek = loadConfig({ ...GATE, ...policy, AWWO_PI_PROVIDER: 'deepseek', AWWO_PI_MODEL: 'deepseek-flash', AWWO_PI_DISABLE_THINKING: 'true' });
  assert.deepEqual({ baseURL: onDeepSeek.models[0].baseURL, apiKey: onDeepSeek.models[0].apiKey, disableThinking: onDeepSeek.models[0].disableThinking },
    { baseURL: DEEPSEEK_BASE_URL, apiKey: 'deepseek-key', disableThinking: true });
  assert.deepEqual(publicHealth(onDeepSeek).platformProviders, ['llmgate', 'deepseek']);
  assert.equal(JSON.stringify(publicHealth(onDeepSeek)).includes('hinking'), false, 'never in health');
});

async function provider(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), url: req.url });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    // As the DeepSeek API streams a thinking model: reasoning deltas first, then the answer.
    send({ role: 'assistant', reasoning_content: 'private reasoning' });
    send({ content: 'Hello from Pi' });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

// The config loader holds a deepseek profile to the DeepSeek API's URL, so these runs use the loaded profile with only its
// network destination moved to a local fake: what is under test is what the run's call carries.
test('a deepseek run sends its own thinking field when the profile switches thinking off, and no chat-template switch', { timeout: 40000 }, async (t) => {
  const model = await provider(t);
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek', AWWO_PI_TIMEOUT_MS: '10000', AWWO_PI_CANCEL_GRACE_MS: '100' };
  for (const [disableThinking, expected] of [[true, { type: 'disabled' }], [false, undefined]]) {
    const loaded = withProfiles([{ ...FLASH, disableThinking }], policy);
    const flash = loaded.models.find(profile => profile.id === 'deepseek-flash');
    const config = { ...loaded, models: Object.freeze(loaded.models.map(profile => profile === flash ? Object.freeze({ ...flash, baseURL: model.baseURL }) : profile)) };
    const events = [];
    const handle = await startIsolatedRun({ config, request: { ...REQUEST, model: 'deepseek-flash', runId: `run_${disableThinking}` }, onEvent: (event) => events.push(event) });
    t.after(async () => { handle.cancel(); await handle.done; });
    await handle.done;
    assert.deepEqual(businessEvent(events.at(-1)), { type: 'completed', text: 'Hello from Pi' });
    const body = model.requests.at(-1).body;
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, expected, String(disableThinking));
    assert.equal(body.chat_template_kwargs, undefined);
  }
  assert.equal(model.requests.length, 2);
});
