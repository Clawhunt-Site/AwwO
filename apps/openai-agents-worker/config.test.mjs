import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeTools, fitsContextBudget, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { workerEnvironment } from './runner.mjs';
import { calculate, executeTool, parseToolArguments, ToolInputError, validateToolNames } from './tools.mjs';
import { classifyError } from './errors.mjs';
import { configuration, request } from './test-support.mjs';

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
