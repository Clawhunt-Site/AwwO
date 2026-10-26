import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bedrockBridgeBaseURL } from './bedrock-bridge.ts';
import {
  DEEPSEEK_BASE_URL, applyBedrockPromptCache, assertDeepSeekProfiles, assertOperatorOnlyBedrock, bedrockApiKey, bedrockCatalogProfiles, bedrockProfile, bedrockPromptCacheModels, bedrockRegion,
  parseBedrockCatalog, parseBedrockCatalogFile, parsePlatformProviders, platformHealth, platformProvidersInUse, readBedrockCatalog, readBedrockCatalogRegions,
  type BedrockCatalogEntry,
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
    catalogOf(entry({ contextWindow: 1000 })), catalogOf(entry({ maxTokens: 70000 })), catalogOf(entry({ contextWindow: 4096, maxTokens: 4000 })),
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
  // builtin offers only models verified with a real call; the rest are not offered yet.
  const verified = bedrockCatalogProfiles('openai-agents', { AWWO_BEDROCK_CATALOG: 'builtin' });
  assert.deepEqual(verified.map(profile => profile.id), entries.filter(item => item.runtime === 'openai-agents' && item.verified).map(item => item.id));
  assert.ok(verified.some(profile => profile.id === 'bedrock.claude-opus-5-5'));
  assert.ok(!verified.some(profile => profile.id === 'bedrock.gpt-6-1-sol'));
  assert.ok(verified.length >= 15);
  const agents = bedrockCatalogProfiles('openai-agents', { AWWO_BEDROCK_CATALOG: 'builtin-all' });
  const pi = bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'builtin-all' });
  assert.deepEqual(agents.map(profile => profile.id), entries.filter(item => item.runtime === 'openai-agents').map(item => item.id));
  assert.deepEqual(pi.map(profile => profile.id), entries.filter(item => item.runtime === 'pi').map(item => item.id));
  assert.equal(agents.length + pi.length, entries.length, 'every catalog model is offered exactly once by default');
  const claude = agents.find(profile => profile.id === 'bedrock.claude-opus-5-5')!;
  assert.deepEqual(claude, { id: 'bedrock.claude-opus-5-5', provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5', name: 'Claude Opus 5.5', vendor: 'anthropic',
    region: 'us-east-1', baseURL: bedrockBridgeBaseURL('us-east-1'), apiKey: '', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'],
    fallbackModel: 'us.anthropic.claude-opus-5-5', proseBytesPerToken: 2.15, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' });
  // A model without a fallback profile has none.
  assert.equal('fallbackModel' in agents.find(profile => profile.id === 'bedrock.kimi-k3')!, false);
  // A model nobody measured has no prose rate: its budget stays counted byte for byte.
  assert.equal('proseBytesPerToken' in agents.find(profile => profile.id === 'bedrock.nova-pro')!, false);
  assert.equal(pi.find(profile => profile.id === 'bedrock.llama-3-3-70b')!.proseBytesPerToken, 2.95);
  // A model the catalog lists as text-only stays so.
  assert.deepEqual(agents.find(profile => profile.id === 'bedrock.deepseek-v3-2')!.input, ['text']);
});

test('a fallback target is the same model through its other inference profile, and every Claude model has one', () => {
  const profile = (target: string, fallbackTarget: unknown) => entry({ target, fallbackTarget });
  // Both directions (global. <-> us.) and any other pair of profile kinds of one model.
  for (const [target, fallback] of [['global.anthropic.claude-x', 'us.anthropic.claude-x'], ['us.anthropic.claude-x', 'global.anthropic.claude-x'], ['eu.meta.llama-y:0', 'global.meta.llama-y:0']]) {
    assert.equal(parseBedrockCatalog(catalogOf(profile(target, fallback)))[0].fallbackTarget, fallback);
  }
  // Never another model, the same profile, an in-region id on either side, or anything but a target string.
  for (const [target, fallback] of [['global.anthropic.claude-x', 'us.anthropic.claude-y'], ['global.anthropic.claude-x', 'global.anthropic.claude-x'],
    ['global.anthropic.claude-x', 'anthropic.claude-x'], ['anthropic.claude-x', 'us.anthropic.claude-x'], ['global.anthropic.claude-x', 'us.anthropic.claude-x https://x'],
    ['global.anthropic.claude-x', ''], ['global.anthropic.claude-x', null], ['global.anthropic.claude-x', ['us.anthropic.claude-x']]] as const) {
    assert.throws(() => parseBedrockCatalog(catalogOf(profile(target, fallback))), /catalog is invalid/, `${target} -> ${fallback}`);
  }
  // Optional: an entry without one is as before, and other unknown fields are still refused.
  assert.equal('fallbackTarget' in parseBedrockCatalog(catalogOf(entry()))[0], false);
  assert.throws(() => parseBedrockCatalog(catalogOf({ ...entry({ target: 'global.a.b' }), fallbackTarget: 'us.a.b', extra: true })), /catalog is invalid/);
  const claude = readBedrockCatalog().filter(item => item.vendor === 'anthropic');
  assert.ok(claude.length >= 7);
  for (const item of claude) assert.equal(item.fallbackTarget, item.target.replace(/^global\./, 'us.'), item.id);
  assert.ok(readBedrockCatalog().every(item => item.vendor === 'anthropic' || item.fallbackTarget === undefined), 'only Claude has a second profile the workers may call');
});

test('a measured prose rate is a number from 1 to 4 in steps of 0.05, carried to the profile only above 1', () => {
  for (const rate of [1.05, 2.15, 4]) {
    const [item] = parseBedrockCatalog(catalogOf(entry({ proseBytesPerToken: rate })));
    assert.equal(item.proseBytesPerToken, rate);
    assert.equal(bedrockProfile(item, 'us-east-1', '').proseBytesPerToken, rate);
  }
  const [one] = parseBedrockCatalog(catalogOf(entry({ proseBytesPerToken: 1 })));
  assert.equal('proseBytesPerToken' in one || 'proseBytesPerToken' in bedrockProfile(one, 'us-east-1', ''), false);
  for (const bad of [0, 0.95, 4.05, 2.13, '2', null, true, [2]]) {
    assert.throws(() => parseBedrockCatalog(catalogOf(entry({ proseBytesPerToken: bad }))), /catalog is invalid/, String(bad));
  }
  // Every rate the built-in catalog carries is one a worker accepts, and only verified models carry one.
  for (const item of readBedrockCatalog()) {
    if (item.proseBytesPerToken !== undefined) assert.ok(item.proseBytesPerToken > 1 && item.proseBytesPerToken <= 4 && item.verified, item.id);
  }
});

test('thinking efforts are a Claude entry\'s own levels with a default among them, carried to its profile', () => {
  const claude = (overrides: Record<string, unknown>) => entry({ vendor: 'anthropic', target: 'global.anthropic.claude-x', ...overrides });
  const [item] = parseBedrockCatalog(catalogOf(claude({ reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' })));
  assert.deepEqual(item.reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(item.defaultReasoningEffort, 'medium');
  assert.equal(Object.isFrozen(item.reasoningEfforts), true);
  const profile = bedrockProfile(item, 'us-east-1', '');
  assert.deepEqual([profile.reasoningEfforts, profile.defaultReasoningEffort], [['low', 'medium', 'high'], 'medium']);
  // Levels without a default are levels; an entry without levels has neither on its profile.
  const [plain] = parseBedrockCatalog(catalogOf(claude({ reasoningEfforts: ['low'] })));
  assert.deepEqual([plain.reasoningEfforts, plain.defaultReasoningEffort], [['low'], undefined]);
  assert.equal('defaultReasoningEffort' in bedrockProfile(plain, 'us-east-1', ''), false);
  const [none] = parseBedrockCatalog(catalogOf(claude({})));
  assert.equal('reasoningEfforts' in none || 'reasoningEfforts' in bedrockProfile(none, 'us-east-1', ''), false);
  // Only the levels the bridge sends, each once, at least one, on a Claude model, with any default among them.
  for (const [label, bad] of [['another vendor', entry({ reasoningEfforts: ['low'] })], ['no level', claude({ reasoningEfforts: [] })],
    ['a level Bedrock refuses', claude({ reasoningEfforts: ['minimal'] })], ['a level not offered', claude({ reasoningEfforts: ['low', 'xhigh'] })],
    ['twice', claude({ reasoningEfforts: ['low', 'low'] })], ['not a list', claude({ reasoningEfforts: 'low' })],
    ['a default not among them', claude({ reasoningEfforts: ['low'], defaultReasoningEffort: 'medium' })],
    ['a default without levels', claude({ defaultReasoningEffort: 'medium' })], ['an empty default', claude({ reasoningEfforts: ['low'], defaultReasoningEffort: '' })]] as const) {
    assert.throws(() => parseBedrockCatalog(catalogOf(bad)), /catalog is invalid/, label);
  }
  // The built-in catalog offers them for Claude Opus 5.5 alone, at its own default.
  const offered = readBedrockCatalog().filter(model => model.reasoningEfforts !== undefined);
  assert.deepEqual(offered.map(model => [model.id, model.reasoningEfforts, model.defaultReasoningEffort]), [['bedrock.claude-opus-5-5', ['low', 'medium', 'high'], 'medium']]);
  const opus = bedrockCatalogProfiles('pi', { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_MODELS: 'bedrock.claude-opus-5-5' })[0];
  assert.deepEqual([opus.reasoningEfforts, opus.defaultReasoningEffort], [['low', 'medium', 'high'], 'medium']);
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

test('DeepSeek is a third platform: canonical in the policy, claimed only when a profile reaches it, at its one URL', () => {
  assert.deepEqual(parsePlatformProviders('deepseek,llmgate'), ['llmgate', 'deepseek']);
  assert.deepEqual(parsePlatformProviders(' deepseek , bedrock , llmgate '), ['llmgate', 'bedrock', 'deepseek']);
  for (const value of ['deepseek', 'llmgate,deepseek,deepseek', 'llmgate,DeepSeek', 'llmgate,deepseek-v4']) {
    assert.throws(() => parsePlatformProviders(value), /AWWO_PLATFORM_PROVIDERS must list distinct values from llmgate, bedrock, deepseek and include llmgate/, value);
  }
  const deepseek = { provider: 'deepseek', baseURL: DEEPSEEK_BASE_URL, protocol: 'chat_completions' };
  const all = ['llmgate', 'bedrock', 'deepseek'];
  assert.deepEqual(platformProvidersInUse(all, [{ provider: 'llmgate' }]), ['llmgate'], 'a policy that allows DeepSeek is not a claim to reach it');
  assert.deepEqual(platformProvidersInUse(all, [{ provider: 'llmgate' }, deepseek]), ['llmgate', 'deepseek']);
  assert.deepEqual(platformProvidersInUse(all, [deepseek, { provider: 'bedrock' }]), ['llmgate', 'bedrock', 'deepseek']);
  assert.deepEqual(platformHealth(true, ['llmgate', 'deepseek']), { platformOnly: true, platformProviders: ['llmgate', 'deepseek'] });
  // Allowed: an operator worker whose policy names deepseek, or one that is not Gate-only.
  assert.doesNotThrow(() => assertDeepSeekProfiles(false, true, ['llmgate', 'deepseek'], [{ provider: 'llmgate' }, deepseek]));
  assert.doesNotThrow(() => assertDeepSeekProfiles(false, false, ['llmgate'], [deepseek]));
  assert.doesNotThrow(() => assertDeepSeekProfiles(true, true, ['llmgate'], [{ provider: 'llmgate' }]), 'no DeepSeek profile, nothing to refuse');
  assert.throws(() => assertDeepSeekProfiles(false, true, ['llmgate', 'bedrock'], [deepseek]), /AWWO_LLMGATE_ONLY allows DeepSeek profiles only when AWWO_PLATFORM_PROVIDERS includes deepseek/);
  assert.throws(() => assertDeepSeekProfiles(true, false, all, [deepseek]), /DeepSeek models use operator credentials.*AWWO_CREDENTIAL_MODE=user/);
  // The name never points anywhere else, in any mode.
  for (const other of [{ baseURL: 'https://api.deepseek.com/v1' }, { baseURL: 'https://api.clawhunt.site/v1' }, { baseURL: 'http://api.deepseek.com' },
    { baseURL: undefined }, { protocol: 'responses' }, { protocol: 'anthropic_messages' }]) {
    assert.throws(() => assertDeepSeekProfiles(false, false, all, [{ ...deepseek, ...other }]), /deepseek model profile must use https:\/\/api\.deepseek\.com with Chat Completions/, JSON.stringify(other));
  }
});

test('catalog entries cannot be mutated through the loaded copy', () => {
  const first = readBedrockCatalog()[0] as BedrockCatalogEntry & { name: string };
  assert.throws(() => { (first as { name: string }).name = 'changed'; });
  assert.equal(readBedrockCatalog()[0].name, raw.models[0].name);
});


test('AWWO_BEDROCK_PROMPT_CACHE_MODELS marks only the named Claude catalog models, and refuses anything else', () => {
  const env = { AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_MODELS: 'bedrock.claude-opus-5-5,bedrock.claude-haiku-4-5,bedrock.kimi-k3' };
  const profiles = bedrockCatalogProfiles('openai-agents', env);
  // Unset or blank: nothing changes, the profiles are the very same objects.
  for (const value of [undefined, '', '  ']) {
    assert.equal(bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: value }).size, 0);
    assert.deepEqual(applyBedrockPromptCache(profiles, bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: value })), profiles);
  }
  const marked = applyBedrockPromptCache(profiles, bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: ' bedrock.claude-haiku-4-5 ' }));
  assert.deepEqual(marked.map(profile => [profile.id, (profile as { promptCache?: boolean }).promptCache ?? false]),
    [['bedrock.claude-opus-5-5', false], ['bedrock.claude-haiku-4-5', true], ['bedrock.kimi-k3', false]]);
  assert.ok(Object.isFrozen(marked) && marked.every(Object.isFrozen));
  // Malformed lists, duplicates, a non-Claude model and a Claude model this worker does not serve all stop the worker.
  for (const value of ['bedrock.claude-opus-5-5,', 'claude-opus-5-5', 'bedrock.claude-opus-5-5,bedrock.claude-opus-5-5']) {
    assert.throws(() => bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: value }), /comma list of distinct Bedrock catalog ids/);
  }
  for (const value of ['bedrock.kimi-k3', 'bedrock.claude-sonnet-4-6', 'bedrock.not-in-catalog']) {
    assert.throws(() => applyBedrockPromptCache(profiles, bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: value })), /not a Claude model this worker serves/);
  }
  // With the catalog off there is nothing to cache, so naming a model is a configuration error.
  assert.throws(() => applyBedrockPromptCache(bedrockCatalogProfiles('openai-agents', {}), bedrockPromptCacheModels({ AWWO_BEDROCK_PROMPT_CACHE_MODELS: 'bedrock.claude-opus-5-5' })));
});
