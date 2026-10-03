import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { bedrockBridgeBaseURL, createBedrockFetch } from '../bedrock-bridge.ts';
import { readBedrockCatalog } from '../bedrock-catalog.ts';
import { executeAgent } from './agent-runtime.mjs';
import { loadConfig, publicHealth, resolveModelConfig } from './config.mjs';
import { classifyError, RuntimeError } from './errors.mjs';
import { startIsolatedRun } from './runner.mjs';
import { createOpenAIAgentsServer } from './server.mjs';
import { createProviderObserver } from './usage.mjs';
import { REASONING_TEXT, request } from './test-support.mjs';

const GATE = {
  AWWO_OPENAI_AGENTS_TOKEN: 'test-only-internal-token-at-least-32-characters',
  AWWO_OPENAI_AGENTS_PROVIDER: 'llmgate', AWWO_OPENAI_AGENTS_MODEL: 'qwen3.8-27b-p6', AWWO_OPENAI_AGENTS_API_KEY: 'sk-llmgate-fixture',
  AWWO_OPENAI_AGENTS_CANCEL_GRACE_MS: '100',
};
const BEDROCK_KEY = 'ABSKbedrockkey000000000000000000';
const config = (overrides = {}) => loadConfig({ ...GATE, ...overrides });
const withCatalog = (overrides = {}) => config({ AWWO_BEDROCK_CATALOG: 'builtin-all', ...overrides });

test('the built-in catalog adds Bedrock profiles to the Agents worker after its own profiles', () => {
  const c = withCatalog();
  const expected = readBedrockCatalog().filter(entry => entry.runtime === 'openai-agents');
  assert.equal(c.ready, true);
  assert.deepEqual(c.models.slice(1).map(profile => profile.id), expected.map(entry => entry.id));
  // builtin alone offers only the models verified with a real call.
  const verified = config({ AWWO_BEDROCK_CATALOG: 'builtin' }).models.slice(1).map(profile => profile.id);
  assert.deepEqual(verified, expected.filter(entry => entry.verified).map(entry => entry.id));
  assert.ok(!verified.includes('bedrock.claude-opus-5-5'));
  const health = publicHealth(c);
  const claude = health.models.find(model => model.id === 'bedrock.claude-opus-5-5');
  assert.deepEqual(claude, { id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5', providerModel: 'global.anthropic.claude-opus-5-5', provider: 'bedrock',
    runtime: 'openai-agents', protocol: 'chat_completions', contextWindow: 200000, maxOutputTokens: 32000, maxContextTextBytes: 167744,
    messageOverheadBytes: 32, reasoningEfforts: [], defaultReasoningEffort: '' });
  // Health never carries a base URL, region or key.
  assert.doesNotMatch(JSON.stringify(health), /amazonaws|ABSK|sk-llmgate/);
  assert.equal(health.supportsEffortSelection, false);
});

test('Gate-only mode accepts Bedrock only where the platform policy names it, and says so in health', () => {
  assert.throws(() => withCatalog({ AWWO_LLMGATE_ONLY: 'true' }), /AWWO_PLATFORM_PROVIDERS includes bedrock/);
  assert.throws(() => withCatalog({ AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'bedrock' }), /include llmgate/);
  const allowed = withCatalog({ AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock' });
  const health = publicHealth(allowed);
  assert.equal(health.llmgateOnly, undefined, 'a worker that can reach Bedrock never claims to be Gate-only');
  assert.equal(health.platformOnly, true);
  assert.deepEqual(health.platformProviders, ['llmgate', 'bedrock']);
  // A Gate-only worker keeps its exact previous health shape.
  const gate = publicHealth(config({ AWWO_LLMGATE_ONLY: 'true' }));
  assert.equal(gate.llmgateOnly, true);
  assert.equal(gate.platformOnly, undefined);
  assert.equal(gate.platformProviders, undefined);
  // Third-party destinations stay refused in Gate-only mode, Bedrock policy or not.
  assert.throws(() => config({ AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', AWWO_OPENAI_AGENTS_BASE_URL: 'https://api.openai.com/v1' }), /LLM Gate endpoint/);
  // A policy that allows Bedrock is not a claim to reach it: health follows the models served.
  const unused = publicHealth(config({ AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock' }));
  assert.equal(unused.llmgateOnly, true);
  assert.equal(unused.platformOnly, undefined);
  const personal = publicHealth(config({ AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', AWWO_CREDENTIAL_MODE: 'user' }));
  assert.equal(personal.llmgateOnly, true, 'a personal-credential worker stays Gate-only whatever the platform policy says');
  // Bedrock uses operator credentials, so a personal-credential worker refuses it outright.
  assert.throws(() => withCatalog({ AWWO_CREDENTIAL_MODE: 'user' }), /operator credentials/);
});

test('explicit Bedrock profiles in MODELS_JSON are closed shapes without URLs, effort or structured output', () => {
  const profile = (value) => JSON.stringify([{ id: 'bedrock-kimi', provider: 'bedrock', model: 'moonshotai.kimi-k2.5', ...value }]);
  const c = config({ AWWO_OPENAI_AGENTS_MODELS_JSON: profile({ region: 'us-east-2', apiKeyEnv: 'BEDROCK_KEY', name: 'Kimi K2.5', contextWindow: 200000, maxTokens: 16000 }), BEDROCK_KEY });
  const kimi = resolveModelConfig(c, 'bedrock-kimi');
  assert.equal(kimi.provider, 'bedrock');
  assert.equal(kimi.region, 'us-east-2');
  assert.equal(kimi.baseURL, bedrockBridgeBaseURL('us-east-2'));
  assert.equal(kimi.apiKey, BEDROCK_KEY);
  assert.equal(kimi.protocol, 'chat_completions');
  assert.deepEqual([...kimi.reasoningEfforts], []);
  assert.equal(kimi.structuredOutput, false);
  // Without an API key the profile signs with the worker's AWS credentials.
  assert.equal(resolveModelConfig(config({ AWWO_OPENAI_AGENTS_MODELS_JSON: profile({}) }), 'bedrock-kimi').apiKey, '');
  assert.equal(resolveModelConfig(config({ AWWO_OPENAI_AGENTS_MODELS_JSON: profile({}), AWWO_BEDROCK_REGION: 'eu-west-1' }), 'bedrock-kimi').region, 'eu-west-1');
  for (const extra of [{ baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com' }, { protocol: 'responses' }, { reasoningEfforts: ['high'] }, { defaultReasoningEffort: 'high' },
    { structuredOutput: true }, { region: 'us-gov-west-1' }, { apiKeyEnv: 'bad name' }, { unknown: 1 }, { contextWindow: 4096, maxTokens: 4000 }]) {
    assert.throws(() => config({ AWWO_OPENAI_AGENTS_MODELS_JSON: profile(extra) }), /not a valid Bedrock profile/, JSON.stringify(extra));
  }
  const missing = config({ AWWO_OPENAI_AGENTS_MODELS_JSON: profile({ apiKeyEnv: 'ABSENT_KEY' }) });
  assert.equal(missing.ready, false);
  assert.ok(missing.missing.includes('AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS'));
  assert.throws(() => withCatalog({ AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'bedrock.glm-5', provider: 'bedrock', model: 'zai.glm-5' }]) }), /unique IDs/);
  assert.throws(() => withCatalog({ AWWO_BEDROCK_REGION: 'mars-1' }), /Bedrock catalog configuration is invalid: AWWO_BEDROCK_REGION/);
});

// A fake of the two AWS SDK members the bridge uses; `script` yields Converse stream events.
function fakeBedrock(script, { fail } = {}) {
  const sent = [];
  class ConverseStreamCommand { constructor(input) { this.input = input; } }
  class BedrockRuntimeClient {
    constructor(clientConfig) { this.record = { clientConfig }; sent.push(this.record); }
    async send(command, { abortSignal } = {}) {
      this.record.input = command.input;
      this.record.signal = abortSignal;
      if (fail) throw fail;
      return { stream: script(command.input) };
    }
    destroy() {}
  }
  return { sdk: { BedrockRuntimeClient, ConverseStreamCommand }, sent };
}
const textTurn = (text, extra = []) => async function* () {
  yield { messageStart: { role: 'assistant' } };
  yield* extra;
  yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text } } };
  yield { contentBlockStop: { contentBlockIndex: 1 } };
  yield { messageStop: { stopReason: 'end_turn' } };
  yield { metadata: { usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, metrics: { latencyMs: 30 } } };
};

async function bridged(modelId, sdk, input) {
  const profile = resolveModelConfig(withCatalog({ AWWO_BEDROCK_API_KEY: BEDROCK_KEY }), modelId);
  const fetchImpl = createBedrockFetch({ region: profile.region, model: profile.model, auth: { bearerToken: BEDROCK_KEY }, sdk });
  const observer = createProviderObserver(profile.protocol, { fetchImpl });
  const events = [];
  const modelConfig = { ...profile, apiKey: 'awwo-bedrock-bridge' };
  let error;
  try { await executeAgent({ request: input, modelConfig, signal: new AbortController().signal, emit: async event => { events.push(event); }, observer }); }
  catch (caught) { error = caught; }
  return { events, error, observer };
}

test('the official Agents SDK completes a turn through the bridge with provider usage and no reasoning text', { timeout: 15_000 }, async () => {
  const bedrock = fakeBedrock(textTurn('你好，来自 Bedrock。', [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: REASONING_TEXT } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
  ]));
  const { events, error, observer } = await bridged('bedrock.kimi-k2-thinking', bedrock.sdk,
    request({ model: 'bedrock.kimi-k2-thinking', systemPrompt: 'You are terse.', messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Earlier answer' }], prompt: 'Say hello' }));
  assert.equal(error, undefined);
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(events.at(-1).text, '你好，来自 Bedrock。');
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), '你好，来自 Bedrock。');
  const reasoning = events.filter(event => event.type === 'reasoning');
  assert.ok(reasoning.length >= 1);
  assert.equal(reasoning.at(-1).characters, [...REASONING_TEXT].length);
  assert.doesNotMatch(JSON.stringify(events), /private ledger|44102/);
  assert.deepEqual(observer.snapshot('completed').usage, { status: 'reported', source: 'provider_raw', reason: 'none', inputTokens: 12, outputTokens: 4,
    cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerTotalTokens: null, computedTotalTokens: 16 });
  // Exactly one provider request, with the conversation and limits the worker admitted.
  assert.equal(bedrock.sent.length, 1);
  const { input, clientConfig } = bedrock.sent[0];
  assert.equal(input.modelId, 'moonshot.kimi-k2-thinking');
  assert.deepEqual(input.system, [{ text: 'You are terse.' }]);
  assert.deepEqual(input.messages.map(message => [message.role, message.content.map(block => block.text).join('')]), [['user', 'Earlier'], ['assistant', 'Earlier answer'], ['user', 'Say hello']]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 32000 });
  assert.equal(input.toolConfig, undefined);
  assert.equal(clientConfig.maxAttempts, 1);
  assert.deepEqual(clientConfig.token, { token: BEDROCK_KEY });
});

test('a Bedrock tool call runs the registered tool once and its result is the turn output', { timeout: 15_000 }, async () => {
  const bedrock = fakeBedrock(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tooluse_calc', name: 'calculator' } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"expression":' } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"(2+3)*4"}' } } } };
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    yield { messageStop: { stopReason: 'tool_use' } };
    yield { metadata: { usage: { inputTokens: 30, outputTokens: 9 } } };
  });
  const { events, error } = await bridged('bedrock.deepseek-v3-2', bedrock.sdk, request({ model: 'bedrock.deepseek-v3-2', tools: ['calculator'], prompt: 'Compute (2+3)*4' }));
  assert.equal(error, undefined);
  assert.equal(events.at(-1).type, 'completed');
  assert.match(events.at(-1).text, /20/);
  assert.equal(bedrock.sent.length, 1);
  assert.deepEqual(bedrock.sent[0].input.toolConfig.tools.map(tool => tool.toolSpec.name), ['calculator']);
});

test('a model that calls two tools at once runs only the first, as the worker asked', { timeout: 15_000 }, async () => {
  // The worker sends parallel_tool_calls: false and refuses a response with two tool calls
  // (TOOL_DENIED); Claude-class models on Bedrock call tools in parallel by default.
  const call = (index, id, expression) => [
    { contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: id, name: 'calculator' } } } },
    { contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify({ expression }) } } } },
    { contentBlockStop: { contentBlockIndex: index } },
  ];
  const bedrock = fakeBedrock(async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield* call(0, 'tooluse_a', '(2+3)*4');
    yield* call(1, 'tooluse_b', '7*6');
    yield { messageStop: { stopReason: 'tool_use' } };
    yield { metadata: { usage: { inputTokens: 30, outputTokens: 12 } } };
  });
  const { events, error } = await bridged('bedrock.deepseek-v3-2', bedrock.sdk, request({ model: 'bedrock.deepseek-v3-2', tools: ['calculator'], prompt: 'Compute two things' }));
  assert.equal(error, undefined);
  assert.equal(events.at(-1).type, 'completed');
  assert.match(events.at(-1).text, /20/);
  assert.doesNotMatch(events.at(-1).text, /42/);
});

test('provider refusals and truncation become the worker failures the control plane already knows', { timeout: 15_000 }, async () => {
  const denied = fakeBedrock(textTurn('unused'), { fail: Object.assign(new Error('User: arn:aws:sts::563688183799:assumed-role/x'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }) });
  const deniedRun = await bridged('bedrock.glm-5', denied.sdk, request({ model: 'bedrock.glm-5' }));
  assert.equal(classifyError(deniedRun.error).code, 'MODEL_AUTHENTICATION');
  const throttled = fakeBedrock(textTurn('unused'), { fail: Object.assign(new Error('Too many'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }) });
  assert.equal(classifyError((await bridged('bedrock.glm-5', throttled.sdk, request({ model: 'bedrock.glm-5' }))).error).code, 'MODEL_RATE_LIMIT');
  const long = fakeBedrock(async function* () { yield { messageStart: {} }; yield { contentBlockDelta: { delta: { text: 'partial' } } }; yield { messageStop: { stopReason: 'max_tokens' } }; });
  const longRun = await bridged('bedrock.glm-5', long.sdk, request({ model: 'bedrock.glm-5' }));
  assert.equal(longRun.error?.code, 'MODEL_OUTPUT_LIMIT');
  const broken = fakeBedrock(async function* () { yield { messageStart: {} }; yield { contentBlockDelta: { delta: { text: 'half' } } }; throw Object.assign(new Error('x'), { name: 'ModelStreamErrorException' }); });
  const brokenRun = await bridged('bedrock.glm-5', broken.sdk, request({ model: 'bedrock.glm-5' }));
  assert.ok(brokenRun.error, 'a broken stream never completes');
  assert.ok(!brokenRun.events.some(event => event.type === 'completed'));
  // A throttle after the stream began keeps its meaning although the HTTP status was already 200.
  const midThrottle = fakeBedrock(async function* () { yield { messageStart: {} }; yield { contentBlockDelta: { delta: { text: 'half' } } }; yield { throttlingException: { message: 'slow' } }; });
  assert.equal(classifyError((await bridged('bedrock.glm-5', midThrottle.sdk, request({ model: 'bedrock.glm-5' }))).error).code, 'MODEL_RATE_LIMIT');
  // Content the bridge cannot relay is a deterministic refusal, not a provider outage.
  const citing = fakeBedrock(async function* () { yield { messageStart: {} }; yield { contentBlockDelta: { delta: { citation: { title: 'doc' } } } }; });
  assert.notEqual(classifyError((await bridged('bedrock.glm-5', citing.sdk, request({ model: 'bedrock.glm-5' }))).error).code, 'MODEL_UNAVAILABLE');
});

test('the runner hands a Bedrock child its auth record and region, never a provider API key', { timeout: 15_000 }, async () => {
  const c = withCatalog({ AWWO_BEDROCK_API_KEY: BEDROCK_KEY });
  const taskURL = new URL('./bedrock-ipc-fixture.mjs', import.meta.url);
  const runOnce = async (bedrockAuth) => {
    const events = [];
    const handle = await startIsolatedRun({ config: c, request: request({ model: 'bedrock.glm-5' }), onEvent: event => events.push(event) }, { taskURL, bedrockAuth });
    await handle.done;
    return JSON.parse(events.at(-1).text);
  };
  assert.deepEqual(await runOnce(async key => ({ bearerToken: key })), { provider: 'bedrock', model: 'zai.glm-5', region: 'us-east-1', baseURL: bedrockBridgeBaseURL('us-east-1'),
    protocol: 'chat_completions', apiKey: '', authKinds: ['bearerToken'], credentialFields: [] });
  const sigv4 = await runOnce(async () => ({ credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token', expiration: '2026-10-03T12:00:00.000Z' } }));
  assert.deepEqual(sigv4.credentialFields, ['accessKeyId', 'expiration', 'secretAccessKey', 'sessionToken']);
  // A credential chain that cannot answer stops the run before any directory or child exists.
  await assert.rejects(startIsolatedRun({ config: c, request: request({ model: 'bedrock.glm-5' }), onEvent: () => {} }, { taskURL, bedrockAuth: async () => { throw new Error('no chain'); } }),
    error => error instanceof RuntimeError && error.code === 'MODEL_AUTHENTICATION');
});

test('the HTTP worker reports an unresolvable Bedrock credential as an authentication failure', { timeout: 5000 }, async t => {
  const c = withCatalog();
  const app = createOpenAIAgentsServer(c, { startRun: async () => { throw new RuntimeError('MODEL_AUTHENTICATION'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/runs`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` }, body: JSON.stringify(request({ model: 'bedrock.glm-5' })) });
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.at(-1).type, 'failed');
  assert.equal(events.at(-1).code, 'MODEL_AUTHENTICATION');
});
