import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeEffort, authorizeOutputContract, authorizeTools, fitsContextBudget, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { deliverySchemaBytes } from './delivery-contract.mjs';
import { workerEnvironment } from './runner.mjs';
import { calculate, executeTool, parseToolArguments, ToolInputError, validateToolNames } from './tools.mjs';
import { classifyError } from './errors.mjs';
import { configuration, request } from './test-support.mjs';
import { bindUserModel } from '../user-models.ts';

test('Gate-only personal mode admits the Gate endpoint and rejects direct providers', () => {
  const env = { AWWO_CREDENTIAL_MODE: 'user', AWWO_LLMGATE_ONLY: 'true', AWWO_OPENAI_AGENTS_TOKEN: 'x'.repeat(32) };
  const config = loadConfig(env);
  assert.equal(config.ready, true);
  assert.equal(config.provider, 'llmgate');
  assert.equal(publicHealth(config).llmgateOnly, true);
  const selector = `byok_${'a'.repeat(33)}_${'b'.repeat(16)}`;
  const userModel = { id: selector, provider: 'llmgate', model: 'test-model', baseURL: 'https://api.clawhunt.site/v1', apiKey: 'synthetic-personal-key', protocol: 'chat_completions', contextWindow: 32768, maxTokens: 4096, reasoningEfforts: [], defaultReasoningEffort: '' };
  const allowed = bindUserModel(config, { model: selector, userModel: { ...userModel } }, 'openai-agents');
  assert.equal(allowed.models[0].baseURL, 'https://api.clawhunt.site/v1');
  const legacyAlias = loadConfig({ ...env, AWWO_OPENAI_AGENTS_PROVIDER: 'openai', AWWO_OPENAI_AGENTS_BASE_URL: 'https://api.clawhunt.site/v1' });
  assert.equal(legacyAlias.models[0].baseURL, 'https://api.clawhunt.site/v1');
  assert.throws(() => bindUserModel(config, { model: selector, userModel: { ...userModel, provider: 'openai', baseURL: 'https://api.openai.com/v1' } }, 'openai-agents'), /Invalid personal model/);
  assert.throws(() => loadConfig({ ...env, AWWO_OPENAI_AGENTS_PROVIDER: 'openai' }), /LLMGATE_ONLY/);
  assert.throws(() => loadConfig({ ...env, AWWO_OPENAI_AGENTS_BASE_URL: 'https://api.openai.com/v1' }), /LLMGATE_ONLY/);
  const directProfile = [{ id: 'direct', provider: 'openai', model: 'test-model', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'SYNTHETIC_KEY' }];
  assert.throws(() => loadConfig({ ...env, SYNTHETIC_KEY: 'synthetic-key', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify(directProfile) }), /LLMGATE_ONLY/);
  assert.throws(() => loadConfig({ ...env, AWWO_LLMGATE_ONLY: 'yes' }), /LLMGATE_ONLY/);
});

test('Gate-only operator mode requires the Gate endpoint for every profile', () => {
  const env = { AWWO_CREDENTIAL_MODE: 'operator', AWWO_LLMGATE_ONLY: 'true',
    AWWO_OPENAI_AGENTS_TOKEN: 'x'.repeat(32), AWWO_OPENAI_AGENTS_MODEL: 'gate-model',
    AWWO_OPENAI_AGENTS_API_KEY: 'synthetic-operator-key' };
  const config = loadConfig(env);
  assert.equal(config.ready, true);
  assert.equal(config.userCredentials, false);
  assert.equal(config.models[0].baseURL, 'https://api.clawhunt.site/v1');
  assert.equal(publicHealth(config).llmgateOnly, true);
  const alias = loadConfig({ ...env, AWWO_OPENAI_AGENTS_PROVIDER: 'openai',
    AWWO_OPENAI_AGENTS_BASE_URL: 'https://api.clawhunt.site/v1' });
  assert.equal(alias.ready, true);
  assert.equal(alias.models[0].baseURL, 'https://api.clawhunt.site/v1');
  assert.throws(() => loadConfig({ ...env, AWWO_OPENAI_AGENTS_BASE_URL: 'https://api.openai.com/v1' }), /LLMGATE_ONLY/);
  assert.throws(() => loadConfig({ ...env, AWWO_OPENAI_AGENTS_PROVIDER: 'openai' }), /LLMGATE_ONLY/);
  const direct = [{ id: 'direct', provider: 'openai', model: 'direct-model',
    baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'SYNTHETIC_KEY' }];
  assert.throws(() => loadConfig({ ...env, SYNTHETIC_KEY: 'synthetic-key',
    AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify(direct) }), /LLMGATE_ONLY/);
});

test('configuration is explicit, immutable and unconfigured by default', () => {
  assert.equal(loadConfig({}).ready, false);
  const config = configuration();
  assert.equal(config.ready, true); assert.equal(config.port, 8098); assert.equal(config.protocol, 'chat_completions');
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.models[0]));
  assert.deepEqual(config.enabledTools, []);
  const health = publicHealth(config);
  assert.equal(health.runtime, 'openai-agents'); assert.equal(health.sdkVersion, '0.18.0'); assert.equal(health.tracingEnabled, false);
  assert.equal(health.maxModelCallsPerRun, 1); assert.equal(health.modelConnectivityVerified, false);
  assert.equal(configuration({ AWWO_OPENAI_AGENTS_PROVIDER: 'anthropic' }).ready, false);
  assert.equal(configuration({ AWWO_OPENAI_AGENTS_PROTOCOL: 'custom' }).ready, false);
  assert.throws(() => configuration({ APP_ENV: 'test' }), /APP_ENV/);
});

test('provider URL credentials, queries, malformed syntax and insecure deployment URLs fail closed', () => {
  for (const url of ['http://a:b@example.invalid/v1','https://example.invalid?key=private','https://example.invalid#private','file:///etc/passwd','https:\\example.invalid','https://example.invalid/a b']) assert.equal(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: url }).ready, false);
  assert.equal(configuration({ APP_ENV: 'production', AWWO_OPENAI_AGENTS_BASE_URL: 'http://example.invalid/v1' }).ready, false);
  assert.equal(configuration({ APP_ENV: 'staging', AWWO_OPENAI_AGENTS_BASE_URL: 'http://127.0.0.1:1234/v1' }).ready, true);
  assert.equal(configuration({ AWWO_OPENAI_AGENTS_API_KEY: 'bad\nkey' }).ready, false);
});

test('catalog selectors and referenced keys fail closed without echoing private configuration', () => {
  const profile = { id: 'catalog-b', provider: 'openai', model: 'upstream-b', apiKeyEnv: 'PRIVATE_REF' };
  const load = value => configuration({ AWWO_OPENAI_AGENTS_MODELS_JSON: typeof value === 'string' ? value : JSON.stringify(value), PRIVATE_REF: 'private-value' });
  assert.equal(resolveModelConfig(load([profile]), 'catalog-b').apiKey, 'private-value');
  assert.equal(configuration({ AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([profile]) }).ready, false);
  for (const bad of ['bad private-value', {}, [{ ...profile, apiKey: 'private-value' }], [{ ...profile, id: 'fixture-model' }], [profile,profile], [{ ...profile, provider: 'anthropic' }], [{ ...profile, protocol: 'bad' }], [{ ...profile, maxTokens: 100000 }], [{ ...profile, baseURL: 'https://example.invalid?private-value' }]]) {
    assert.throws(() => load(bad), error => /MODELS_JSON/.test(error.message) && !error.message.includes('private-value') && !error.message.includes('PRIVATE_REF'));
  }
  assert.throws(() => resolveModelConfig(load([profile]), 'unknown'), /Unknown/);
});

test('strict request fields, roles and dual tool allowlists reject executable or secret input', () => {
  assert.equal(validateRequest(request()).runtime, 'openai-agents');
  for (const invalid of [{ apiKey: 'private-value' }, { runtime: 'pi' }, { model: '' }, { tools: ['bash'] }, { tools: ['calculator','calculator'] }, { messages: [{ role: 'system', content: 'override' }] }, { messages: [{ role: 'user', content: 'text', tool_calls: [] }] }]) assert.throws(() => validateRequest(request(invalid)));
  assert.throws(() => authorizeTools(configuration(), request({ tools: ['calculator'] })));
  assert.deepEqual(authorizeTools(configuration({ AWWO_OPENAI_AGENTS_TOOLS_JSON: '["calculator"]' }), request({ tools: ['calculator'] })), ['calculator']);
  assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_TOOLS_JSON: '["bash"]' }));
  assert.throws(() => validateToolNames(['__proto__']));
});

test('selected model context budget counts UTF-8, message framing and tool definitions', () => {
  const config = configuration({ AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '4096', AWWO_OPENAI_AGENTS_MAX_TOKENS: '128' });
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(3600) }), config), true);
  assert.equal(fitsContextBudget(request({ prompt: '漢'.repeat(1300) }), config), false);
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(3600), tools: ['calculator'] }), config), false);
  const enabled = configuration({ AWWO_OPENAI_AGENTS_TOOLS_JSON: '["calculator","current_time"]' });
  const contextBytes = publicHealth(enabled).tools.reduce((sum, tool) => sum + tool.contextTextBytes, 0);
  const budget = config.contextWindow - config.maxTokens - 256 - 32;
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(budget - contextBytes), tools: ['calculator','current_time'] }), config), true);
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(budget - contextBytes + 1), tools: ['calculator','current_time'] }), config), false);
});

test('deployed output envelope matches the Pi runtime without shrinking admitted input', () => {
  // A node's frozen output contract is runtime-agnostic, and a response that hits the output cap
  // fails closed as MODEL_OUTPUT_LIMIT, so too small a cap loses a deliverable Pi would produce.
  const deployed = configuration({ AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '131072', AWWO_OPENAI_AGENTS_MAX_TOKENS: '16384' });
  const outputOnly = configuration({ AWWO_OPENAI_AGENTS_MAX_TOKENS: '16384' });
  const admitted = config => config.contextWindow - config.maxTokens - 256;
  assert.equal(deployed.ready, true);
  assert.equal(publicHealth(deployed).limits.maxOutputTokens, 16384);
  assert.equal(admitted(deployed), 114432);
  assert.ok(admitted(deployed) > admitted(configuration()));
  // Raising the output cap alone is not safe: the same subtraction gates admitted input.
  assert.ok(admitted(outputOnly) < admitted(configuration()));
  const prompt = 'x'.repeat(admitted(configuration()) - 32);
  assert.equal(fitsContextBudget(request({ prompt }), deployed), true);
  assert.equal(fitsContextBudget(request({ prompt }), outputOnly), false);
  assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_MAX_TOKENS: '32769' }), /outside its allowed range/);
});

test('a host-served model is only addressable by name, and only where the deployment gate allows it', () => {
  // compose.yml maps host.docker.internal for Pi alone: this worker refuses that host over plain
  // HTTP once deployed, so mapping it here would look like reachability and deliver none.
  for (const environment of ['staging', 'production']) {
    const config = configuration({ APP_ENV: environment, AWWO_OPENAI_AGENTS_BASE_URL: 'http://host.docker.internal:11434/v1' });
    assert.equal(config.ready, false);
    assert.ok(config.missing.includes('AWWO_OPENAI_AGENTS_BASE_URL_HTTPS'));
  }
  assert.equal(configuration({ APP_ENV: 'development', AWWO_OPENAI_AGENTS_BASE_URL: 'http://host.docker.internal:11434/v1' }).ready, true);
  assert.equal(configuration({ APP_ENV: 'staging', AWWO_OPENAI_AGENTS_BASE_URL: 'https://host.docker.internal:11434/v1' }).ready, true);
});

test('child environment carries no parent secrets, user config, Node hooks or tracing credentials', () => {
  const env = workerEnvironment('/private/test-directory', '/runtime/node');
  assert.deepEqual(env, { PATH: '/runtime', TMPDIR: '/private/test-directory', LD_LIBRARY_PATH: '/runtime', OPENAI_AGENTS_DISABLE_TRACING: '1', OPENAI_AGENTS_DONT_LOG_MODEL_DATA: '1', OPENAI_AGENTS_DONT_LOG_TOOL_DATA: '1', NO_COLOR: '1' });
});

test('calculator parses bounded arithmetic without executable syntax', () => {
  assert.equal(calculate('-(2 + 3.5) * 4 / 2'), -11);
  assert.equal(calculate('.5 + 1.'), 1.5); assert.equal(calculate('-0'), 0);
  for (const invalid of ['eval(1)', 'process.exit()', '1;2', '1/0', '1000000000000*2', '1e5', '2**8', '1..2', '2(3)', '(' .repeat(20)+'1'+')'.repeat(20), '1'.repeat(257), '']) assert.throws(() => calculate(invalid), ToolInputError);
});

test('function input contracts reject malformed JSON, extra fields and invalid timezone', () => {
  for (const raw of ['{broken','[]','null','1','{"expression":2}','{"expression":"1","url":"https://example.invalid"}']) assert.throws(() => parseToolArguments('calculator', raw), ToolInputError);
  assert.throws(() => executeTool('current_time',{timeZone:'Invalid/Zone'}), ToolInputError);
  assert.throws(() => executeTool('current_time',{timeZone: 'UTC', path:'/etc/passwd'}), ToolInputError);
  const time = JSON.parse(executeTool('current_time', { timeZone: null }, () => new Date('2026-09-12T00:00:00.000Z')));
  assert.equal(time.iso, '2026-09-12T00:00:00.000Z'); assert.equal(time.timeZone, 'UTC');
});

test('upstream errors expose only safe structured codes', () => {
  const result = classifyError({ status: 401, message: 'private-key', body: 'private-context' });
  assert.equal(result.code, 'MODEL_AUTHENTICATION'); assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(classifyError(new Error('private-key')).code, 'MODEL_ERROR');
});

test('health freezes the upstream model separately from catalog identity for every configured protocol', () => {
  const config = configuration({ AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([
    { id: 'friendly-alias', provider: 'openai', model: 'upstream-b', protocol: 'responses', apiKeyEnv: 'PRIVATE_REF' },
  ]), PRIVATE_REF: 'private-value' });
  const health = publicHealth(config);
  assert.equal(health.models[0].providerModel, 'fixture-model');
  assert.equal(health.models[0].protocol, 'chat_completions');
  const metadata = health.models.find(model => model.id === 'friendly-alias');
  assert.equal(metadata.providerModel, resolveModelConfig(config, 'friendly-alias').model);
  assert.equal(metadata.providerModel, 'upstream-b');
  assert.equal(metadata.protocol, 'responses');
  assert.ok(!JSON.stringify(metadata).includes('private-value'));
});

test('reasoning effort levels are advertised per profile, never inherited, and refused when unadvertised', () => {
  const config = configuration({
    AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low, medium,high', AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT: 'medium',
    SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([
      { id: 'plain', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY' },
      { id: 'deep', provider: 'openai', model: 'deep-model', apiKeyEnv: 'SECOND_KEY', reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high' },
    ]),
  });
  const health = publicHealth(config);
  assert.equal(health.supportsEffortSelection, true);
  assert.deepEqual(health.models.map(m => [m.id, m.reasoningEfforts, m.defaultReasoningEffort]), [
    ['fixture-model', ['low', 'medium', 'high'], 'medium'], ['plain', [], ''], ['deep', ['high', 'xhigh'], 'high'],
  ]);
  assert.equal(publicHealth(configuration()).supportsEffortSelection, false);
  assert.equal(authorizeEffort(resolveModelConfig(config, undefined), request({ effort: 'high' })), 'high');
  assert.equal(authorizeEffort(resolveModelConfig(config, 'deep'), request()), '');
  assert.throws(() => authorizeEffort(resolveModelConfig(config, 'plain'), request({ effort: 'medium' })), /not supported/);
  assert.throws(() => authorizeEffort(resolveModelConfig(config, 'deep'), request({ effort: 'low' })), /not supported/);
  assert.throws(() => validateRequest(request({ effort: 'extreme' })), /Invalid effort/);
  assert.throws(() => validateRequest(request({ effort: 1 })), /Invalid effort/);
  // The default is optional display metadata, exactly as the control plane accepts it.
  assert.deepEqual(publicHealth(configuration({ AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low,high' })).models[0], { ...publicHealth(configuration({ AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low,high' })).models[0], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: '' });
  assert.equal(configuration({ SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'x', provider: 'openai', model: 'm', apiKeyEnv: 'SECOND_KEY', reasoningEfforts: ['low'] }]) }).models[1].defaultReasoningEffort, '');
  assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low,low' }), /REASONING_EFFORTS/);
  assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low', AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT: 'high' }), /REASONING_EFFORTS/);
  assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT: 'high' }), /REASONING_EFFORTS/);
  assert.throws(() => configuration({ SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'x', provider: 'openai', model: 'm', apiKeyEnv: 'SECOND_KEY', reasoningEfforts: ['ultra'] }]) }), /reasoning effort/);
  assert.throws(() => configuration({ SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'x', provider: 'openai', model: 'm', apiKeyEnv: 'SECOND_KEY', reasoningEfforts: ['low'], defaultReasoningEffort: 'high' }]) }), /reasoning effort/);
});

// publicHealth(configuration()) as served before structured delivery output existed
// (captured from HEAD cda83c5, re-based on f97bf71 which added userCredentials). A
// configuration that sets neither new key must match it.
const HEALTH_BEFORE_STRUCTURED_OUTPUT = '{"status":"ready","ready":true,"userCredentials":false,"configured":true,"provider":"openai","model":"fixture-model","runtime":"openai-agents","tracingEnabled":false,"maxModelCallsPerRun":1,"supportsEffortSelection":false,"tools":[],"models":[{"id":"fixture-model","name":"fixture-model","providerModel":"fixture-model","provider":"openai","runtime":"openai-agents","protocol":"chat_completions","contextWindow":32768,"maxOutputTokens":4096,"maxContextTextBytes":28416,"messageOverheadBytes":32,"reasoningEfforts":[],"defaultReasoningEffort":""}],"activeRuns":0,"version":"0.1.0","telemetryProtocolVersion":1,"metricsEnabled":false,"selfHostedTracingEnabled":false,"sdkVersion":"0.18.0","modelConnectivityVerified":false,"limits":{"promptChars":128000,"systemPromptChars":32768,"historyMessageChars":32768,"historyMessages":100,"totalTextChars":262144,"bodyBytes":1048576,"contextWindow":32768,"maxOutputTokens":4096,"maxContextTextBytes":28416,"messageOverheadBytes":32}}';
const MODEL_KEYS_BEFORE_STRUCTURED_OUTPUT = Object.freeze(['id', 'name', 'providerModel', 'provider', 'runtime', 'protocol', 'contextWindow', 'maxOutputTokens', 'maxContextTextBytes', 'messageOverheadBytes', 'reasoningEfforts', 'defaultReasoningEffort']);

test('health with neither structuredOutput nor name set is byte-identical to the catalog before structured output', () => {
  assert.equal(JSON.stringify(publicHealth(configuration())), HEALTH_BEFORE_STRUCTURED_OUTPUT);
  const explicitOff = configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'false', SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([
    { id: 'plain', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY' },
    { id: 'off', provider: 'openai', model: 'off-model', apiKeyEnv: 'SECOND_KEY', structuredOutput: false },
  ]) });
  const health = publicHealth(explicitOff);
  assert.equal(health.models.length, 3);
  for (const model of health.models) {
    assert.deepEqual(Object.keys(model), MODEL_KEYS_BEFORE_STRUCTURED_OUTPUT);
    assert.equal(model.name, model.providerModel);
  }
  assert.ok(!Object.hasOwn(health, 'structuredOutput') && !Object.hasOwn(health, 'supportsStructuredOutput'));
});

test('a user-credential worker declares that it binds user models carrying structuredOutput; an operator worker does not', () => {
  // The control plane only freezes a delivery contract for a personal connection when the
  // worker declares this; a worker that does not (the Python worker) is never sent one.
  const user = publicHealth(loadConfig({ AWWO_CREDENTIAL_MODE: 'user', AWWO_OPENAI_AGENTS_TOKEN: 'x'.repeat(32) }));
  assert.equal(user.userCredentials, true);
  assert.equal(user.userStructuredOutput, true);
  assert.deepEqual(Object.keys(user).slice(0, 4), ['status', 'ready', 'userCredentials', 'userStructuredOutput']);
  assert.ok(!Object.hasOwn(publicHealth(configuration()), 'userStructuredOutput'));
});

test('structured output flag: exact words for the default profile, booleans per profile, never inherited', () => {
  for (const value of [undefined, '', 'false']) assert.equal(configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: value }).models[0].structuredOutput, false, String(value));
  assert.equal(configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'true' }).models[0].structuredOutput, true);
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '0', 'off', 'enabled']) {
    assert.throws(() => configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: value }), /AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT must be true or false/, value);
  }
  // Refusing to start is not the same as starting unconfigured: an unready worker is still a guess.
  assert.throws(() => loadConfig({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'yes' }), /STRUCTURED_OUTPUT/);
  const profiles = [
    { id: 'plain', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY' },
    { id: 'structured', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY', structuredOutput: true, name: 'plain-model (structured)' },
    { id: 'explicit-off', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY', structuredOutput: false },
  ];
  const config = configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'true', SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify(profiles) });
  assert.deepEqual(config.models.map(model => [model.id, model.structuredOutput]), [['fixture-model', true], ['plain', false], ['structured', true], ['explicit-off', false]]);
  assert.ok(config.models.every(model => Object.isFrozen(model)));
  const health = publicHealth(config);
  assert.deepEqual(health.models.map(model => [model.id, model.name, model.providerModel, model.structuredOutput]), [
    ['fixture-model', 'fixture-model', 'fixture-model', true], ['plain', 'plain-model', 'plain-model', undefined],
    ['structured', 'plain-model (structured)', 'plain-model', true], ['explicit-off', 'plain-model', 'plain-model', undefined],
  ]);
  assert.ok(!Object.hasOwn(health.models[1], 'structuredOutput') && !Object.hasOwn(health.models[3], 'structuredOutput'));
  assert.equal(Object.keys(health.models[2]).at(-1), 'structuredOutput');
  assert.ok(!Object.hasOwn(health, 'structuredOutput') && !Object.hasOwn(health, 'supportsStructuredOutput'));
  for (const bad of ['true', 1, 0, null, [], {}]) {
    assert.throws(() => configuration({ SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ ...profiles[0], structuredOutput: bad }]) }), /MODELS_JSON.*structuredOutput/, JSON.stringify(bad));
  }
});

test('profile display names are optional, bounded and never replace the provider model', () => {
  const load = name => configuration({ SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'named', provider: 'openai', model: 'upstream-model', apiKeyEnv: 'SECOND_KEY', name }]) });
  for (const name of ['a', 'x'.repeat(80), '\u6a21'.repeat(80), '\u{1F600}'.repeat(80), 'qwen3.8-27b (structured)']) {
    const config = load(name);
    const profile = resolveModelConfig(config, 'named');
    assert.equal(profile.name, name); assert.equal(profile.model, 'upstream-model');
    const metadata = publicHealth(config).models[1];
    assert.equal(metadata.name, name); assert.equal(metadata.providerModel, 'upstream-model');
  }
  for (const name of ['', 'x'.repeat(81), '\u6a21'.repeat(81), 'bell\u0007', 'tab\tname', 'line\nname', '\u007f', 'a\u0085', 'zero\u200bwidth', 'bidi\u202eeman', '\ud800', 1, null, ['a'], { name: 'a' }]) {
    assert.throws(() => load(name), error => /MODELS_JSON.*display name/.test(error.message) && (typeof name !== 'string' || !name || !error.message.includes(name)), JSON.stringify(name));
  }
  assert.equal(load(undefined).models[1].name, 'upstream-model');
  assert.equal(configuration().models[0].name, 'fixture-model');
});

test('an output contract is validated with the request, refused with tools, and honoured only by a flagged profile', () => {
  const contract = { version: 1, fields: [{ id: 'summary', type: 'text', required: true }] };
  assert.equal(validateRequest(request({ outputContract: contract })).outputContract, contract);
  assert.doesNotThrow(() => validateRequest(request({ outputContract: contract, tools: [] })));
  assert.throws(() => validateRequest(request({ outputContract: contract, tools: ['calculator'] })), /cannot be combined with tools/);
  for (const invalid of [null, {}, { ...contract, version: 2 }, { version: 1, fields: [{ id: 'prototype', type: 'text', required: true }] }, { type: 'object', properties: {} }]) {
    assert.throws(() => validateRequest(request({ outputContract: invalid })), /output contract/, JSON.stringify(invalid));
  }
  const flagged = configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'true', SECOND_KEY: 'k', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'plain', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY' }]) });
  assert.equal(authorizeOutputContract(resolveModelConfig(flagged, undefined), request({ outputContract: contract })), contract);
  assert.equal(authorizeOutputContract(resolveModelConfig(flagged, 'plain'), request()), undefined);
  assert.throws(() => authorizeOutputContract(resolveModelConfig(flagged, 'plain'), request({ outputContract: contract })), /not supported/);
  assert.throws(() => authorizeOutputContract(resolveModelConfig(configuration(), undefined), request({ outputContract: contract })), /not supported/);
});

test('the context budget counts the delivery contract response-format envelope bytes', () => {
  const config = configuration({ AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '4096', AWWO_OPENAI_AGENTS_MAX_TOKENS: '128' });
  const contract = { version: 1, fields: [{ id: 'summary', type: 'text', required: true }, { id: 'report', type: 'file', required: false }] };
  const budget = config.contextWindow - config.maxTokens - 256 - 32;
  const bytes = deliverySchemaBytes(contract);
  assert.ok(bytes > 0);
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(budget - bytes), outputContract: contract }), config), true);
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(budget - bytes + 1), outputContract: contract }), config), false);
  assert.equal(fitsContextBudget(request({ prompt: 'x'.repeat(budget - bytes + 1) }), config), true);
});
