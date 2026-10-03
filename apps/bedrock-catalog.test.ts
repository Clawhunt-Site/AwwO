import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bedrockBridgeBaseURL } from './bedrock-bridge.ts';
import {
  assertOperatorOnlyBedrock, bedrockApiKey, bedrockCatalogProfiles, bedrockRegion, parseBedrockCatalog, parseBedrockCatalogFile, parsePlatformProviders,
  platformHealth, platformProvidersInUse, readBedrockCatalog, readBedrockCatalogRegions, type BedrockCatalogEntry,
} from './bedrock-catalog.ts';

const raw = JSON.parse(readFileSync(new URL('./bedrock-models.json', import.meta.url), 'utf8'));
const entry = (overrides: Record<string, unknown> = {}) => ({ id: 'bedrock.test-model', name: 'Test Model', vendor: 'test', target: 'test.model-v1:0',
  contextWindow: 32768, maxTokens: 4096, input: ['text'], tools: true, runtime: 'openai-agents', verified: '', ...overrides });
const catalogOf = (...models: unknown[]) => ({ version: 1, regions: ['us-east-1'], models });

test('the built-in catalog is valid, ordered and only puts tool-capable models on the Agents runtime', () => {
  const entries = readBedrockCatalog();
  assert.equal(entries.length, raw.models.length);
  assert.ok(entries.length >= 40, 'the catalog covers the popular Bedrock models');
  assert.deepEqual(entries.map(item => item.id), raw.models.map((item: { id: string }) => item.id));
  assert.equal(new Set(entries.map(item => item.target)).size, entries.length);
  for (const item of entries) {
    if (item.runtime === 'openai-agents') assert.equal(item.tools, true, item.id);
    assert.match(item.verified, /^$|^\d{4}-\d{2}-\d{2}$/);
  }
  // Every vendor named in the plan is present.
  const vendors = new Set(entries.map(item => item.vendor));
  for (const vendor of ['anthropic', 'openai', 'xai', 'moonshot', 'deepseek', 'qwen', 'zhipu', 'minimax', 'mistral', 'meta', 'amazon', 'google', 'nvidia']) assert.ok(vendors.has(vendor), vendor);
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(Object.isFrozen(entries[0]), true);
});

test('a malformed catalog stops the worker instead of guessing', () => {
  assert.equal(parseBedrockCatalog(catalogOf(entry())).length, 1);
  const invalid: unknown[] = [
    null, [], { version: 2, models: [entry()] }, catalogOf(),
    catalogOf(entry({ id: 'claude' })), catalogOf(entry(), entry()), catalogOf(entry(), entry({ id: 'bedrock.other' })),
    catalogOf(entry({ name: '' })), catalogOf(entry({ name: 'a\u0000b' })), catalogOf(entry({ vendor: 'Bad Vendor' })),
    catalogOf(entry({ target: 'no-provider' })), catalogOf(entry({ target: 'test.model https://x' })),
    catalogOf(entry({ contextWindow: 1000 })), catalogOf(entry({ maxTokens: 40000 })), catalogOf(entry({ contextWindow: 4096, maxTokens: 4000 })),
    catalogOf(entry({ input: [] })), catalogOf(entry({ input: ['image'] })), catalogOf(entry({ input: ['text', 'audio'] })),
    catalogOf(entry({ tools: 'yes' })), catalogOf(entry({ runtime: 'codex' })), catalogOf(entry({ tools: false })),
    catalogOf(entry({ verified: 'yesterday' })), catalogOf({ ...entry(), extra: true }),
    catalogOf((({ verified: _verified, ...rest }) => rest)(entry())),
    // The regions the entries were verified in are part of the catalog.
    { version: 1, models: [entry()] }, { ...catalogOf(entry()), regions: [] }, { ...catalogOf(entry()), regions: ['us-east-1', 'us-east-1'] },
    { ...catalogOf(entry()), regions: ['us-gov-west-1'] }, { ...catalogOf(entry()), regions: 'us-east-1' },
  ];
  for (const value of invalid) assert.throws(() => parseBedrockCatalog(value), /catalog is invalid/, JSON.stringify(value)?.slice(0, 120));
  assert.equal(parseBedrockCatalog(catalogOf(entry({ tools: false, runtime: 'pi' })))[0].runtime, 'pi');
  assert.deepEqual(parseBedrockCatalogFile({ ...catalogOf(entry()), regions: ['us-east-1', 'us-west-2'] }).regions, ['us-east-1', 'us-west-2']);
  assert.deepEqual(readBedrockCatalogRegions(), raw.regions);
});

test('the catalog is off unless enabled, and contributes each worker only its own runtime by default', () => {
  assert.deepEqual(bedrockCatalogProfiles('openai-agents', {}), []);
  assert.deepEqual(bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'off' }), []);
  assert.throws(() => bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'all' }), /off, builtin or builtin-all/);
  const entries = readBedrockCatalog();
  // builtin offers only models verified with a real call; the rest need cross-region permission.
  const verified = bedrockCatalogProfiles('openai-agents', { AWWO_BEDROCK_CATALOG: 'builtin' });
  assert.deepEqual(verified.map(profile => profile.id), entries.filter(item => item.runtime === 'openai-agents' && item.verified).map(item => item.id));
  assert.ok(!verified.some(profile => profile.id === 'bedrock.claude-opus-5-5'));
  assert.ok(verified.length >= 15);
  const agents = bedrockCatalogProfiles('openai-agents', { AWWO_BEDROCK_CATALOG: 'builtin-all' });
  const pi = bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'builtin-all' });
  assert.deepEqual(agents.map(profile => profile.id), entries.filter(item => item.runtime === 'openai-agents').map(item => item.id));
  assert.deepEqual(pi.map(profile => profile.id), entries.filter(item => item.runtime === 'pi').map(item => item.id));
  assert.equal(agents.length + pi.length, entries.length, 'every catalog model is offered exactly once by default');
  const claude = agents.find(profile => profile.id === 'bedrock.claude-opus-5-5')!;
  assert.deepEqual(claude, { id: 'bedrock.claude-opus-5-5', provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5', name: 'Claude Opus 5.5', vendor: 'anthropic',
    region: 'us-east-1', baseURL: bedrockBridgeBaseURL('us-east-1'), apiKey: '', contextWindow: 200000, maxTokens: 32000 });
});

test('an explicit model list selects in catalog order and refuses unknown or tool-less Agents models', () => {
  const env = { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_REGION: 'us-east-1', AWWO_BEDROCK_API_KEY: 'ABSKbedrockkey000000000000000000' };
  const selected = bedrockCatalogProfiles('openai-agents', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.kimi-k3, bedrock.claude-opus-5-5' });
  assert.deepEqual(selected.map(profile => profile.id), ['bedrock.claude-opus-5-5', 'bedrock.kimi-k3']);
  assert.ok(selected.every(profile => profile.region === 'us-east-1' && profile.apiKey === env.AWWO_BEDROCK_API_KEY && profile.baseURL === bedrockBridgeBaseURL('us-east-1')));
  // Pi has no tools, so it may host any catalog model when an operator asks for it.
  assert.deepEqual(bedrockCatalogProfiles('pi', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.claude-opus-5-5,bedrock.gemma-3-27b' }).map(profile => profile.id), ['bedrock.claude-opus-5-5', 'bedrock.gemma-3-27b']);
  assert.throws(() => bedrockCatalogProfiles('openai-agents', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.gemma-3-27b' }), /without tool support/);
  assert.throws(() => bedrockCatalogProfiles('pi', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.unknown' }), /not in the Bedrock catalog/);
  assert.throws(() => bedrockCatalogProfiles('pi', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.glm-5,bedrock.glm-5' }), /distinct/);
  assert.throws(() => bedrockCatalogProfiles('pi', { ...env, AWWO_BEDROCK_MODELS: 'bedrock.glm-5,' }), /distinct/);
});

test('the built-in catalog is offered only in the regions it was verified in', () => {
  // us-east-2, for example, lacks qwen3-coder-next, and an EU region would need other inference profiles.
  for (const region of ['us-east-2', 'eu-central-1']) {
    assert.throws(() => bedrockCatalogProfiles('openai-agents', { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_REGION: region }), /verified for us-east-1; for .* explicit MODELS_JSON profiles/, region);
  }
  const entries = readBedrockCatalog();
  assert.equal(bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'builtin-all', AWWO_BEDROCK_REGION: 'us-west-2' }, entries, ['us-west-2']).length,
    entries.filter(item => item.runtime === 'pi').length);
  // Off is off in any region.
  assert.deepEqual(bedrockCatalogProfiles('pi', { AWWO_BEDROCK_REGION: 'eu-central-1' }), []);
  // A worker without Bedrock never depends on the catalog file: entries are only read when enabled.
  const source = readFileSync(new URL('./bedrock-catalog.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function bedrockCatalogProfiles'));
  assert.ok(body.indexOf("if (mode === '' || mode === 'off') return") < body.indexOf('readBedrockCatalog()'));
});

test('region and API key settings are validated, and an absent key means AWS credential signing', () => {
  assert.equal(bedrockRegion({}), 'us-east-1');
  assert.equal(bedrockRegion({ AWWO_BEDROCK_REGION: ' eu-central-1 ' }), 'eu-central-1');
  assert.throws(() => bedrockRegion({ AWWO_BEDROCK_REGION: 'us-gov-west-1' }), /AWWO_BEDROCK_REGION/);
  assert.equal(bedrockApiKey({}), '');
  assert.equal(bedrockApiKey({ KEY: '  ABSKbedrockkey000000000000000000  ' }, 'KEY'), 'ABSKbedrockkey000000000000000000');
  assert.throws(() => bedrockApiKey({ AWWO_BEDROCK_API_KEY: 'short' }), /not a valid Bedrock API key/);
  assert.throws(() => bedrockApiKey({ AWWO_BEDROCK_API_KEY: 'has space in the middle of it' }), /not a valid/);
});

test('the platform policy always keeps LLM Gate and reports a Gate-only worker exactly as before', () => {
  assert.deepEqual(parsePlatformProviders(undefined), ['llmgate']);
  assert.deepEqual(parsePlatformProviders(' '), ['llmgate']);
  assert.deepEqual(parsePlatformProviders('bedrock, llmgate'), ['llmgate', 'bedrock']);
  for (const value of ['bedrock', 'llmgate,llmgate', 'llmgate,openai', 'llmgate,,bedrock']) assert.throws(() => parsePlatformProviders(value), /AWWO_PLATFORM_PROVIDERS/, value);
  assert.deepEqual(platformHealth(false, ['llmgate', 'bedrock']), {});
  assert.deepEqual(platformHealth(true, ['llmgate']), { llmgateOnly: true });
  assert.deepEqual(platformHealth(true, ['llmgate', 'bedrock']), { platformOnly: true, platformProviders: ['llmgate', 'bedrock'] });
});

test('health claims the destinations the models reach, and personal workers refuse Bedrock', () => {
  const gate = [{ provider: 'llmgate' }, { provider: 'openai' }];
  assert.deepEqual(platformProvidersInUse(['llmgate', 'bedrock'], gate), ['llmgate'], 'a policy that allows Bedrock is not a claim to reach it');
  assert.deepEqual(platformProvidersInUse(['llmgate', 'bedrock'], [...gate, { provider: 'bedrock' }]), ['llmgate', 'bedrock']);
  assert.deepEqual(platformProvidersInUse(['llmgate'], []), ['llmgate']);
  assert.deepEqual(platformHealth(true, platformProvidersInUse(['llmgate', 'bedrock'], gate)), { llmgateOnly: true });
  assert.doesNotThrow(() => assertOperatorOnlyBedrock(false, [{ provider: 'bedrock' }]));
  assert.doesNotThrow(() => assertOperatorOnlyBedrock(true, gate));
  assert.throws(() => assertOperatorOnlyBedrock(true, [{ provider: 'bedrock' }]), /operator credentials.*AWWO_CREDENTIAL_MODE=user/);
});

test('catalog entries cannot be mutated through the loaded copy', () => {
  const first = readBedrockCatalog()[0] as BedrockCatalogEntry & { name: string };
  assert.throws(() => { (first as { name: string }).name = 'changed'; });
  assert.equal(readBedrockCatalog()[0].name, raw.models[0].name);
});
