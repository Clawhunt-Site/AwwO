import assert from 'node:assert/strict';
import test from 'node:test';
import { DEEPSEEK_BASE_URL } from '../bedrock-catalog.ts';
import { executeAgent } from './agent-runtime.mjs';
import { loadConfig, publicHealth } from './config.mjs';
import { configuration, fixture, request } from './test-support.mjs';

const GATE = {
  AWWO_OPENAI_AGENTS_TOKEN: 'test-only-internal-token-at-least-32-characters',
  AWWO_LLMGATE_ONLY: 'true', AWWO_CREDENTIAL_MODE: 'operator',
  AWWO_OPENAI_AGENTS_PROVIDER: 'llmgate', AWWO_OPENAI_AGENTS_MODEL: 'qwen3.8-27b-p6', AWWO_OPENAI_AGENTS_API_KEY: 'sk-llmgate-fixture',
  AWWO_DEEPSEEK_API_KEY: 'sk-deepseek-fixture',
};
const FLASH = { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', provider: 'deepseek', model: 'deepseek-flash', apiKeyEnv: 'AWWO_DEEPSEEK_API_KEY',
  contextWindow: 1_000_000, maxTokens: 32_768 };
const withProfiles = (profiles, overrides = {}) => loadConfig({ ...GATE, AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify(profiles), ...overrides });

test('a Gate-only worker serves a deepseek profile only where the platform policy names deepseek, and then says so', () => {
  assert.throws(() => withProfiles([FLASH]), /AWWO_LLMGATE_ONLY allows DeepSeek profiles only when AWWO_PLATFORM_PROVIDERS includes deepseek/);
  assert.throws(() => withProfiles([FLASH], { AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock' }), /AWWO_PLATFORM_PROVIDERS includes deepseek/);
  const config = withProfiles([FLASH], { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' });
  assert.equal(config.ready, true);
  const flash = config.models.find(profile => profile.id === 'deepseek-flash');
  assert.deepEqual({ provider: flash.provider, baseURL: flash.baseURL, apiKey: flash.apiKey, protocol: flash.protocol, structuredOutput: flash.structuredOutput },
    { provider: 'deepseek', baseURL: DEEPSEEK_BASE_URL, apiKey: 'sk-deepseek-fixture', protocol: 'chat_completions', structuredOutput: false });
  const health = publicHealth(config);
  assert.equal(health.llmgateOnly, undefined);
  assert.equal(health.platformOnly, true);
  assert.deepEqual(health.platformProviders, ['llmgate', 'deepseek']);
  assert.deepEqual(health.models.find(model => model.id === 'deepseek-flash').reasoningEfforts, []);
  // A policy that names deepseek is not a claim to reach it: without a deepseek profile, health is exactly Gate-only.
  assert.deepEqual(publicHealth(loadConfig({ ...GATE, AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' })).llmgateOnly, true);
  // With Bedrock too, the claim is canonical.
  const both = withProfiles([FLASH], { AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock,deepseek', AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' });
  assert.deepEqual(publicHealth(both).platformProviders, ['llmgate', 'bedrock', 'deepseek']);
});

test('the deepseek name reaches only the DeepSeek API: another URL, protocol, a personal worker or a missing key stop it', () => {
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' };
  for (const other of [{ baseURL: 'https://api.deepseek.com/v1' }, { baseURL: 'https://api.clawhunt.site/v1' }, { baseURL: 'https://deepseek.example/v1' },
    { baseURL: 'https://api.deepseek.com/' }, { baseURL: 'https://API.DEEPSEEK.COM' }, { protocol: 'responses' }]) {
    assert.throws(() => withProfiles([{ ...FLASH, ...other }], policy), /deepseek model profile must use https:\/\/api\.deepseek\.com with Chat Completions/, JSON.stringify(other));
  }
  // Outside Gate-only mode the name is held to its URL all the same.
  assert.throws(() => withProfiles([{ ...FLASH, baseURL: 'https://deepseek.example/v1' }], { AWWO_LLMGATE_ONLY: 'false' }), /must use https:\/\/api\.deepseek\.com/);
  assert.equal(withProfiles([FLASH], { AWWO_LLMGATE_ONLY: 'false' }).models.find(profile => profile.id === 'deepseek-flash').baseURL, DEEPSEEK_BASE_URL);
  // A default profile on DeepSeek is held to the same rules.
  assert.throws(() => loadConfig({ ...GATE, AWWO_OPENAI_AGENTS_PROVIDER: 'deepseek', AWWO_OPENAI_AGENTS_MODEL: 'deepseek-flash' }), /AWWO_PLATFORM_PROVIDERS includes deepseek/);
  const onDeepSeek = loadConfig({ ...GATE, ...policy, AWWO_OPENAI_AGENTS_PROVIDER: 'deepseek', AWWO_OPENAI_AGENTS_MODEL: 'deepseek-flash' });
  assert.equal(onDeepSeek.baseURL, DEEPSEEK_BASE_URL);
  assert.deepEqual(publicHealth(onDeepSeek).platformProviders, ['llmgate', 'deepseek']);
  assert.throws(() => loadConfig({ ...GATE, ...policy, AWWO_OPENAI_AGENTS_PROVIDER: 'deepseek', AWWO_OPENAI_AGENTS_MODEL: 'deepseek-flash',
    AWWO_OPENAI_AGENTS_BASE_URL: 'https://deepseek.example/v1' }), /must use https:\/\/api\.deepseek\.com/);
  // Operator credentials only.
  assert.throws(() => withProfiles([FLASH], { ...policy, AWWO_CREDENTIAL_MODE: 'user' }), /DeepSeek models use operator credentials/);
  // A missing key is a missing credential, never a request without one.
  const keyless = withProfiles([FLASH], { ...policy, AWWO_DEEPSEEK_API_KEY: '' });
  assert.equal(keyless.ready, false);
  assert.ok(keyless.missing.includes('AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS'));
});

test('the DeepSeek key is read from its own variable only, and no other profile reads it or holds it', () => {
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock,deepseek' };
  assert.throws(() => withProfiles([{ ...FLASH, apiKeyEnv: 'AWWO_OPENAI_AGENTS_API_KEY' }], policy), /profile 1 is a deepseek profile, which reads its key from AWWO_DEEPSEEK_API_KEY/);
  for (const other of [{ id: 'gate-two', provider: 'llmgate', model: 'gpt-5.5' }, { id: 'bedrock-two', provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }]) {
    assert.throws(() => withProfiles([{ ...other, apiKeyEnv: 'AWWO_DEEPSEEK_API_KEY' }], policy), /profile 1 may not read AWWO_DEEPSEEK_API_KEY, which only a deepseek profile reads/, other.provider);
  }
  // A DeepSeek default model reads the DeepSeek key, never the worker's own key variable, though both are set.
  const onDeepSeek = { ...GATE, ...policy, AWWO_OPENAI_AGENTS_PROVIDER: 'deepseek', AWWO_OPENAI_AGENTS_MODEL: 'deepseek-flash' };
  assert.equal(loadConfig(onDeepSeek).models[0].apiKey, 'sk-deepseek-fixture');
  const keyless = loadConfig({ ...onDeepSeek, AWWO_DEEPSEEK_API_KEY: '' });
  assert.equal(keyless.ready, false);
  assert.ok(keyless.missing.includes('AWWO_DEEPSEEK_API_KEY'));
  assert.equal(keyless.models[0].apiKey, '');
  // The backstop: another profile's key in the DeepSeek variable stops startup, whichever model is the default, and
  // also before any DeepSeek profile exists (the key would otherwise reach the other service).
  assert.throws(() => withProfiles([FLASH], { ...policy, AWWO_DEEPSEEK_API_KEY: 'sk-llmgate-fixture' }), /AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key/);
  assert.throws(() => loadConfig({ ...GATE, AWWO_DEEPSEEK_API_KEY: 'sk-llmgate-fixture' }), /AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key/);
  assert.equal(loadConfig(GATE).ready, true, 'a distinct DeepSeek key without a DeepSeek profile changes nothing');
  const gate = { id: 'qwen3.8-27b', provider: 'llmgate', model: 'qwen3.8-27b', apiKeyEnv: 'AWWO_OPENAI_AGENTS_API_KEY' };
  assert.throws(() => loadConfig({ ...onDeepSeek, AWWO_DEEPSEEK_API_KEY: 'sk-llmgate-fixture', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([gate]) }),
    /AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key/);
});

test('a deepseek profile here offers no thinking level but none, no json_schema output, and under Gate-only no lookalike reaches its URL', () => {
  const policy = { AWWO_PLATFORM_PROVIDERS: 'llmgate,deepseek' };
  // Project execution and managed execution never let DeepSeek think, so a level it advertised would only be refused.
  for (const efforts of [{ reasoningEfforts: ['none', 'high'] }, { reasoningEfforts: ['low'] }, { reasoningEfforts: ['none', 'high'], defaultReasoningEffort: 'high' }]) {
    assert.throws(() => withProfiles([{ ...FLASH, ...efforts }], policy), /deepseek model profile on this worker lists no thinking level but none/, JSON.stringify(efforts));
  }
  assert.throws(() => loadConfig({ ...GATE, ...policy, AWWO_OPENAI_AGENTS_PROVIDER: 'deepseek', AWWO_OPENAI_AGENTS_MODEL: 'deepseek-flash',
    AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'none,high' }), /lists no thinking level but none/);
  const none = withProfiles([{ ...FLASH, reasoningEfforts: ['none'], defaultReasoningEffort: 'none', disableThinking: true }], policy).models.find(profile => profile.id === 'deepseek-flash');
  assert.deepEqual({ efforts: none.reasoningEfforts, fallback: none.defaultReasoningEffort, quiet: none.disableThinking }, { efforts: ['none'], fallback: 'none', quiet: true });
  assert.throws(() => withProfiles([{ ...FLASH, structuredOutput: true }], policy), /cannot enable structuredOutput: the DeepSeek API has no json_schema response format/);
  // Only the deepseek name reaches the DeepSeek API: any other profile at its URL is outside the LLM Gate, and refused.
  for (const provider of ['openai', 'llmgate']) {
    assert.throws(() => withProfiles([{ id: 'lookalike', provider, model: 'deepseek-flash', baseURL: DEEPSEEK_BASE_URL, apiKeyEnv: 'AWWO_OPENAI_AGENTS_API_KEY' }], policy),
      /AWWO_LLMGATE_ONLY requires the LLM Gate endpoint for every model profile/, provider);
  }
  assert.throws(() => loadConfig({ ...GATE, ...policy, AWWO_OPENAI_AGENTS_BASE_URL: DEEPSEEK_BASE_URL }), /requires the LLM Gate endpoint/);
});

test('a deepseek profile that disables thinking sends the DeepSeek API its own thinking field, never the chat-template switch', { timeout: 15_000 }, async t => {
  const f = await fixture(t, { text: 'Direct answer' });
  const flash = { ...configuration().models[0], provider: 'deepseek', model: 'deepseek-flash', baseURL: DEEPSEEK_BASE_URL };
  const qwen = { ...configuration().models[0], disableThinking: true };
  for (const profile of [{ ...flash, disableThinking: true }, flash, qwen]) {
    const events = [];
    await executeAgent({ request: request(), modelConfig: profile, signal: new AbortController().signal, emit: event => events.push(event), observer: {
      fetch(input, init) {
        assert.equal(String(input), `${profile.baseURL}/chat/completions`);
        return fetch(`${f.baseURL}/chat/completions`, init);
      },
      snapshot: () => ({}),
    } });
    assert.equal(events.at(-1).type, 'completed');
  }
  assert.equal(f.calls.length, 3);
  const [quiet, plain, chatTemplate] = f.calls.map(call => call.body);
  assert.deepEqual(quiet.thinking, { type: 'disabled' });
  assert.ok(!('chat_template_kwargs' in quiet));
  assert.ok(!('thinking' in plain) && !('chat_template_kwargs' in plain), 'without the flag the provider default applies');
  assert.deepEqual(chatTemplate.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!('thinking' in chatTemplate), 'other profiles keep the chat-template switch alone');
});
