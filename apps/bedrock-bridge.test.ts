import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEDROCK_BRIDGE_API_KEY, BEDROCK_CREDENTIAL_REFRESH_MS, BedrockBridgeError, bedrockBridgeBaseURL, bedrockOrigin, bridgeFailure, chatUsage,
  createBedrockAuthResolver, createBedrockFetch, createChunkMapper, toConverseInput, validBedrockAuth, validBedrockRegion,
  type BedrockSdk,
} from './bedrock-bridge.ts';

const MODEL = 'global.anthropic.claude-opus-5-5';
const REGION = 'us-east-1';
const ENDPOINT = `${bedrockBridgeBaseURL(REGION)}/chat/completions`;
const BEARER = { bearerToken: 'ABSKbedrockkey000000000000000000' };

const request = (overrides: Record<string, unknown> = {}) => ({
  model: MODEL, stream: true, stream_options: { include_usage: true }, store: false, max_tokens: 512,
  messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }], ...overrides,
});
const rejects = (body: unknown, pattern: RegExp) => assert.throws(() => toConverseInput(body, MODEL),
  (error: unknown) => error instanceof BedrockBridgeError && error.status === 400 && pattern.test(error.message));

test('regions are an explicit allowlist and the bridge URL is synthetic on the real origin', () => {
  assert.equal(validBedrockRegion('us-east-1'), true);
  for (const region of ['us-gov-west-1', 'cn-north-1', 'us-east-1 ', '', 'evil.example', undefined]) assert.equal(validBedrockRegion(region), false);
  assert.equal(bedrockOrigin('eu-central-1'), 'https://bedrock-runtime.eu-central-1.amazonaws.com');
  assert.equal(bedrockBridgeBaseURL(REGION), 'https://bedrock-runtime.us-east-1.amazonaws.com/awwo-bedrock-converse/v1');
  assert.throws(() => bedrockOrigin('us-gov-west-1'));
});

test('a chat request maps to Converse: system, alternating merged turns, tools and inference settings', () => {
  const input = toConverseInput(request({
    temperature: 0.2, top_p: 0.9, stop: 'END', parallel_tool_calls: false, tool_choice: 'auto',
    tools: [{ type: 'function', function: { name: 'current_time', description: 'Now', parameters: { type: 'object', properties: { timezone: { type: 'string' } } } } }],
    messages: [
      { role: 'system', content: 'Rule one.' }, { role: 'developer', content: [{ type: 'text', text: 'Rule two.' }] },
      { role: 'user', content: 'First' }, { role: 'user', content: [{ type: 'text', text: 'Second' }] },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'tooluse_1', type: 'function', function: { name: 'current_time', arguments: '{"timezone":"UTC"}' } }] },
      { role: 'tool', tool_call_id: 'tooluse_1', content: '{"utc":"2026-10-03T00:00:00Z"}' },
      { role: 'user', content: 'Thanks' },
    ],
  }), MODEL);
  assert.deepEqual(input.system, [{ text: 'Rule one.' }, { text: 'Rule two.' }]);
  assert.deepEqual(input.messages, [
    { role: 'user', content: [{ text: 'First' }, { text: 'Second' }] },
    { role: 'assistant', content: [{ text: 'Checking.' }, { toolUse: { toolUseId: 'tooluse_1', name: 'current_time', input: { timezone: 'UTC' } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: '{"utc":"2026-10-03T00:00:00Z"}' }] } }, { text: 'Thanks' }] },
  ]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 512, temperature: 0.2, topP: 0.9, stopSequences: ['END'] });
  assert.deepEqual(input.toolConfig, { tools: [{ toolSpec: { name: 'current_time', description: 'Now', inputSchema: { json: { type: 'object', properties: { timezone: { type: 'string' } } } } } }] });
  assert.equal(input.modelId, MODEL);
});

test('max_completion_tokens wins, blank text is dropped, and forced tool choices map to Converse', () => {
  const required = toConverseInput(request({ max_completion_tokens: 64, tool_choice: 'required',
    tools: [{ type: 'function', function: { name: 'calculator' } }],
    messages: [{ role: 'user', content: '   ' }, { role: 'assistant', content: '' }, { role: 'user', content: 'Add' }] }), MODEL);
  assert.deepEqual(required.inferenceConfig, { maxTokens: 64 });
  assert.deepEqual(required.messages, [{ role: 'user', content: [{ text: 'Add' }] }]);
  assert.deepEqual(required.toolConfig, { tools: [{ toolSpec: { name: 'calculator', inputSchema: { json: { type: 'object', properties: {} } } } }], toolChoice: { any: {} } });
  const named = toConverseInput(request({ tool_choice: { type: 'function', function: { name: 'calculator' } }, tools: [{ type: 'function', function: { name: 'calculator' } }] }), MODEL);
  assert.deepEqual((named.toolConfig as { toolChoice: unknown }).toolChoice, { tool: { name: 'calculator' } });
  const none = toConverseInput(request({ tool_choice: 'none', tools: [{ type: 'function', function: { name: 'calculator' } }] }), MODEL);
  assert.equal(none.toolConfig, undefined);
});

test('anything the bridge cannot map faithfully is refused instead of dropped', () => {
  rejects(request({ model: 'other.model' }), /does not match/);
  rejects(request({ stream: false }), /streaming/);
  rejects(request({ reasoning_effort: 'high' }), /Reasoning effort/);
  rejects(request({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } }), /Structured/);
  rejects(request({ frequency_penalty: 0.5 }), /frequency_penalty/);
  rejects(request({ logprobs: true }), /Log probabilities/);
  rejects(request({ n: 2 }), /one choice/);
  rejects(request({ parallel_tool_calls: 'no' }), /parallel_tool_calls/);
  rejects(request({ seed: 7 }), /seed/);
  rejects(request({ verbosity: 'low' }), /Unsupported request field: verbosity/);
  rejects(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }), /Only text/);
  rejects(request({ messages: [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Hello' }] }), /start with a user/);
  rejects(request({ messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Prefill' }] }), /end with a user/);
  rejects(request({ messages: [{ role: 'system', content: 'Only rules' }] }), /start with a user/);
  rejects(request({ messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', tool_calls: [{ id: 'bad id', type: 'function', function: { name: 'calculator', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'bad id', content: '1' }] }), /tool call/);
  rejects(request({ messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: '{' } }] }, { role: 'tool', tool_call_id: 't1', content: '1' }] }), /not JSON/);
  rejects(request({ messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: '1' }, { role: 'user', content: 'go' }] }), /Tool history requires/);
  rejects(request({ tool_choice: 'none', tools: [{ type: 'function', function: { name: 'calculator' } }], messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: '1' }, { role: 'user', content: 'go' }] }), /none/);
  rejects(request({ tool_choice: { type: 'function', function: { name: 'missing' } }, tools: [{ type: 'function', function: { name: 'calculator' } }] }), /unknown tool/);
  rejects(request({ tool_choice: 'required' }), /requires tools/);
  rejects(request({ tools: [{ type: 'function', function: { name: '1bad' } }] }), /tool definition/);
  rejects(request({ stop: ['a', 'b', 'c', 'd', 'e'] }), /stop/);
  rejects(request({ temperature: 3 }), /temperature/);
  rejects(request({ max_tokens: 0 }), /max tokens/);
  rejects([], /JSON object/);
  // Arguments travel as a JSON string; an object or null is not silently replaced by {}.
  const history = (args: unknown) => request({ tools: [{ type: 'function', function: { name: 'calculator' } }], messages: [{ role: 'user', content: 'Q' },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: args } }] }, { role: 'tool', tool_call_id: 't1', content: '2' }, { role: 'user', content: 'go' }] });
  rejects(history({ expression: '1+1' }), /must be a JSON string/);
  rejects(history(null), /must be a JSON string/);
  const toolUse = (body: unknown) => ((toConverseInput(body, MODEL).messages as { content: Record<string, { input?: unknown }>[] }[])[1].content[0].toolUse.input);
  assert.deepEqual(toolUse(history('')), {});
  assert.deepEqual(toolUse(history(undefined)), {});
  // Parallel tool calls are what a Converse model does by default, so true is accepted.
  assert.ok(toConverseInput(request({ parallel_tool_calls: true, tools: [{ type: 'function', function: { name: 'calculator' } }] }), MODEL).toolConfig);
});

test('stream events map to Chat Completions chunks with the OpenAI finish reasons and usage shape', () => {
  const mapper = createChunkMapper(MODEL, { id: 'chatcmpl-test', created: 1 });
  const deltas = [
    { messageStart: { role: 'assistant' } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'thinking' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hi' } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tooluse_a', name: 'calculator' } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"expression"' } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: ':"1+1"}' } } } },
    { contentBlockStop: { contentBlockIndex: 2 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 4 }, metrics: { latencyMs: 9 } } },
  ].flatMap(event => mapper.map(event));
  mapper.finish();
  const choices = deltas.map(chunk => (chunk.choices as { delta: unknown; finish_reason: unknown }[])[0]);
  assert.deepEqual(choices.slice(0, -1).map(choice => [choice.delta, choice.finish_reason]), [
    [{ role: 'assistant', content: '' }, null],
    [{ reasoning_content: 'thinking' }, null],
    [{ content: 'Hi' }, null],
    [{ tool_calls: [{ index: 0, id: 'tooluse_a', type: 'function', function: { name: 'calculator', arguments: '' } }] }, null],
    [{ tool_calls: [{ index: 0, function: { arguments: '{"expression"' } }] }, null],
    [{ tool_calls: [{ index: 0, function: { arguments: ':"1+1"}' } }] }, null],
    [{}, 'tool_calls'],
  ]);
  assert.deepEqual(deltas.at(-1), { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [],
    usage: { prompt_tokens: 14, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } });
  for (const [reason, finish] of [['end_turn', 'stop'], ['stop_sequence', 'stop'], ['max_tokens', 'length'], ['model_context_window_exceeded', 'length'], ['content_filtered', 'content_filter'], ['guardrail_intervened', 'content_filter']]) {
    const [chunk] = createChunkMapper(MODEL).map({ messageStop: { stopReason: reason } });
    assert.equal((chunk.choices as { finish_reason: string }[])[0].finish_reason, finish);
  }
});

test('incomplete, unknown and exception streams are errors, never a quiet success', () => {
  assert.throws(() => createChunkMapper(MODEL).finish(), /ended before/);
  assert.throws(() => createChunkMapper(MODEL).map({ messageStop: { stopReason: 'malformed_tool_use' } }), /unsupported reason/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockDelta: { delta: { toolUse: { input: '{}' } } } }), /outside a tool call/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockStart: { start: { toolUse: { toolUseId: 'x y', name: 'calc' } } } }), /invalid tool call/);
  assert.throws(() => createChunkMapper(MODEL).map({ messageStart: {}, metadata: {} }), /Unexpected/);
  assert.throws(() => createChunkMapper(MODEL).map({ throttlingException: { message: 'slow down' } }),
    (error: unknown) => error instanceof BedrockBridgeError && error.status === 429 && error.type === 'throttlingException');
  const done = createChunkMapper(MODEL);
  done.map({ messageStop: { stopReason: 'end_turn' } });
  done.finish();
  assert.throws(() => done.map({ messageStart: {} }), /Unexpected/);
  // Unknown events and content types may carry content, so they fail instead of vanishing.
  assert.throws(() => createChunkMapper(MODEL).map({ $unknown: ['newEvent', {}] }), /Unexpected/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockDelta: { delta: { citation: { title: 'doc' } } } }), /cannot relay/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockStart: { start: { image: { format: 'png' } } } }), /cannot relay/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockDelta: { delta: { reasoningContent: { summary: 'x' } } } }), /cannot relay/);
  assert.throws(() => createChunkMapper(MODEL).map({ contentBlockDelta: { delta: { text: 7 } } }), /cannot relay/);
  // Empty unions and redacted reasoning carry nothing a reader may see.
  const quiet = createChunkMapper(MODEL);
  for (const event of [{ contentBlockStart: { start: {} } }, { contentBlockStart: {} }, { contentBlockDelta: { delta: {} } },
    { contentBlockDelta: { delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } } } }]) assert.deepEqual(quiet.map(event), []);
});

const twoToolTurn = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Two checks.' } } }, { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_a', name: 'calculator' } } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"expression":"1+1"}' } } } }, { contentBlockStop: { contentBlockIndex: 1 } },
  { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tooluse_b', name: 'current_time' } } } },
  { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"timezone":"UTC"}' } } } }, { contentBlockStop: { contentBlockIndex: 2 } },
  { messageStop: { stopReason: 'tool_use' } }, { metadata: { usage: { inputTokens: 20, outputTokens: 30 } } },
];
const toolCallsOf = (chunks: Record<string, unknown>[]) => chunks.flatMap(chunk => ((chunk.choices as { delta: { tool_calls?: { id?: string }[] } }[])[0]?.delta.tool_calls ?? [])
  .filter(call => call.id).map(call => call.id));

test('parallel_tool_calls: false ends the turn with its first tool call; usage still covers the turn', () => {
  const single = createChunkMapper(MODEL, { singleToolCall: true });
  const chunks = twoToolTurn.flatMap(event => single.map(event));
  single.finish();
  assert.deepEqual(toolCallsOf(chunks), ['tooluse_a']);
  assert.doesNotMatch(JSON.stringify(chunks), /tooluse_b|timezone/);
  assert.ok(JSON.stringify(chunks).includes('Two checks.'), 'text is never dropped');
  assert.equal((chunks.at(-2)!.choices as { finish_reason: string }[])[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks.at(-1)!.usage, { prompt_tokens: 20, completion_tokens: 30 });
  // Without the setting every call the model makes is relayed.
  const all = createChunkMapper(MODEL);
  assert.deepEqual(toolCallsOf(twoToolTurn.flatMap(event => all.map(event))), ['tooluse_a', 'tooluse_b']);
});

test('the fetch applies the parallel_tool_calls setting of each request to its stream', async () => {
  const tools = [{ type: 'function', function: { name: 'calculator' } }, { type: 'function', function: { name: 'current_time' } }];
  const ids = async (parallel: boolean | undefined) => {
    const { sdk } = fakeSdk(twoToolTurn);
    const response = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk })(ENDPOINT, post(request({ tools, ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }) })));
    return toolCallsOf(frames(await response.text()).slice(0, -1).map(frame => JSON.parse(frame)));
  };
  assert.deepEqual(await ids(false), ['tooluse_a']);
  assert.deepEqual(await ids(true), ['tooluse_a', 'tooluse_b']);
  assert.deepEqual(await ids(undefined), ['tooluse_a', 'tooluse_b']);
});

test('usage is reported only when complete and never invents a total', () => {
  assert.equal(chatUsage(undefined), undefined);
  assert.equal(chatUsage({ inputTokens: 1 }), undefined);
  assert.equal(chatUsage({ inputTokens: -1, outputTokens: 2 }), undefined);
  assert.deepEqual(chatUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 99, cacheWriteInputTokens: 5 }), { prompt_tokens: 8, completion_tokens: 2 });
});

test('SDK failures keep only a status and an exception type, never the account-bearing message', () => {
  const denied = bridgeFailure(Object.assign(new Error('User: arn:aws:sts::563688183799:assumed-role/x is not authorized'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.type, 'AccessDeniedException');
  assert.doesNotMatch(denied.message, /arn|563688183799/);
  assert.equal(bridgeFailure({ name: 'ThrottlingException' }).status, 429);
  assert.equal(bridgeFailure({ name: 'Weird', $metadata: { httpStatusCode: 418 } }).status, 418);
  const unknown = bridgeFailure(new Error('socket hang up'));
  assert.equal(unknown.status, 502);
  assert.equal(unknown.type, 'api_error');
});

test('auth records are closed shapes', () => {
  assert.equal(validBedrockAuth(BEARER), true);
  assert.equal(validBedrockAuth({ credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token', expiration: '2026-10-03T12:00:00.000Z' } }), true);
  for (const value of [undefined, {}, { bearerToken: 'short' }, { bearerToken: 'x'.repeat(20), extra: 1 }, { credentials: { accessKeyId: 'lower', secretAccessKey: 'secret-secret-secret-0000' } },
    { credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', region: 'us-east-1' } },
    { credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', expiration: 'not a date' } }]) {
    assert.equal(validBedrockAuth(value), false);
  }
});

test('the auth resolver prefers the API key, caches chain credentials and refreshes them before expiry', async () => {
  let loads = 0, calls = 0;
  const expiration = new Date(Date.now() + 3_600_000);
  const resolve = createBedrockAuthResolver(async () => { loads++; return async () => { calls++; return { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token', expiration }; }; });
  assert.deepEqual(await resolve('ABSKbedrockkey000000000000000000'), { bearerToken: 'ABSKbedrockkey000000000000000000' });
  assert.equal(loads, 0);
  const first = await resolve('');
  assert.deepEqual(first, { credentials: { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token', expiration: expiration.toISOString() } });
  await resolve('');
  assert.equal(calls, 1, 'long-lived credentials are reused');
  assert.equal(loads, 1);
  let nearCalls = 0;
  const near = createBedrockAuthResolver(async () => async () => { nearCalls++; return { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', expiration: new Date(Date.now() + 60_000) }; });
  await near('');
  await near('');
  assert.equal(nearCalls, 2, 'credentials close to expiry are refreshed before the next use');
  // Ten minutes left is outside the SDK's own five-minute window but shorter than a run (600 s plus
  // grace), so the resolver asks the chain to refresh, at most once a minute while it cannot yet.
  const forced: boolean[] = [];
  const soon = createBedrockAuthResolver(async () => async options => { forced.push(options?.forceRefresh === true);
    return { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', expiration: new Date(Date.now() + 10 * 60_000) }; });
  await soon(''); await soon(''); await soon('');
  assert.deepEqual(forced, [false, true, false]);
  // A renewal that fails keeps credentials that still have time left, but never expired ones.
  let left = 10 * 60_000, failing = false;
  const flaky = createBedrockAuthResolver(async () => async () => {
    if (failing) throw new Error('IMDS unavailable');
    return { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', expiration: new Date(Date.now() + left) };
  });
  const kept = await flaky('');
  failing = true;
  assert.deepEqual(await flaky(''), kept);
  const nearlyExpired = createBedrockAuthResolver(async () => async () => {
    if (failing) throw new Error('IMDS unavailable');
    return { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', expiration: new Date(Date.now() + left) };
  });
  failing = false; left = 30_000;
  await nearlyExpired('');
  failing = true;
  await assert.rejects(nearlyExpired(''), /IMDS unavailable/);
  assert.equal(BEDROCK_CREDENTIAL_REFRESH_MS >= 610_000, true, 'the refresh margin outlasts the longest run');
  const broken = createBedrockAuthResolver(async () => async () => ({ accessKeyId: '', secretAccessKey: '' }));
  await assert.rejects(broken(''), /unusable/);
});

type Sent = { config: Record<string, unknown>; input: Record<string, unknown>; signal?: AbortSignal; destroyed: boolean };

function fakeSdk(events: unknown[] | ((signal?: AbortSignal) => AsyncIterable<unknown>), { fail }: { fail?: unknown } = {}) {
  const sent: Sent[] = [];
  class ConverseStreamCommand { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } }
  class BedrockRuntimeClient {
    record: Sent;
    constructor(config: Record<string, unknown>) { this.record = { config, input: {}, destroyed: false }; sent.push(this.record); }
    async send(command: ConverseStreamCommand, options: { abortSignal?: AbortSignal } = {}) {
      this.record.input = command.input;
      this.record.signal = options.abortSignal;
      if (fail) throw fail;
      const stream = typeof events === 'function' ? events(options.abortSignal) : (async function* () { yield* events; })();
      return { stream: stream as AsyncIterable<Record<string, unknown>> };
    }
    destroy() { this.record.destroyed = true; }
  }
  return { sdk: { BedrockRuntimeClient, ConverseStreamCommand } as unknown as BedrockSdk, sent };
}

const post = (body: unknown, init: RequestInit = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${BEDROCK_BRIDGE_API_KEY}` }, ...init });
const frames = (text: string) => text.split('\n\n').filter(Boolean).map(frame => frame.replace(/^data: /, ''));

test('the fetch serves only the pinned endpoint and pins the real Bedrock client configuration', async () => {
  const { sdk, sent } = fakeSdk([{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { text: 'OK' } } }, { messageStop: { stopReason: 'end_turn' } }, { metadata: { usage: { inputTokens: 3, outputTokens: 1 } } }]);
  const fetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk });
  for (const [url, init] of [[`${ENDPOINT}?x=1`, post(request())], [ENDPOINT.replace('/v1/', '/v2/'), post(request())], [ENDPOINT, { method: 'GET' }], ['https://example.com/chat/completions', post(request())]] as const) {
    const response = await fetch(url, init);
    assert.equal(response.status, 404);
  }
  assert.equal(sent.length, 0, 'refused requests never construct a client');
  const response = await fetch(new URL(ENDPOINT), post(request()));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const data = frames(await response.text());
  assert.equal(data.at(-1), '[DONE]');
  const parsed = data.slice(0, -1).map(frame => JSON.parse(frame));
  assert.deepEqual(parsed.map(chunk => chunk.choices[0]?.delta ?? chunk.usage), [{ role: 'assistant', content: '' }, { content: 'OK' }, {}, { prompt_tokens: 3, completion_tokens: 1 }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].config, { region: REGION, endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com', maxAttempts: 1, token: { token: BEARER.bearerToken }, authSchemePreference: ['httpBearerAuth'] });
  assert.deepEqual(sent[0].input.messages, [{ role: 'user', content: [{ text: 'Hello' }] }]);
  assert.equal(sent[0].destroyed, true);
});

test('SigV4 credentials reach the client with a Date expiry, and options cannot override auth or endpoint', async () => {
  const { sdk, sent } = fakeSdk([{ messageStop: { stopReason: 'end_turn' } }]);
  const credentials = { accessKeyId: 'ASIAEXAMPLE000000000', secretAccessKey: 'secret-secret-secret-0000', sessionToken: 'token-token-token-token', expiration: '2026-10-03T12:00:00.000Z' };
  const fetch = createBedrockFetch({ region: 'us-east-2', model: MODEL, auth: { credentials }, sdk, clientOptions: { requestHandler: 'handler' } });
  await (await fetch(`${bedrockBridgeBaseURL('us-east-2')}/chat/completions`, post(request()))).text();
  assert.deepEqual(sent[0].config, { requestHandler: 'handler', region: 'us-east-2', endpoint: 'https://bedrock-runtime.us-east-2.amazonaws.com', maxAttempts: 1,
    credentials: { ...credentials, expiration: new Date(credentials.expiration) } });
  for (const key of ['credentials', 'token', 'endpoint', 'region', 'authSchemePreference']) {
    assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, clientOptions: { [key]: 'x' } }), /cannot override/);
  }
  assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: { bearerToken: 'short' }, sdk }), /Invalid Bedrock credentials/);
  assert.throws(() => createBedrockFetch({ region: 'us-gov-west-1', model: MODEL, auth: BEARER, sdk }), /region/);
});

test('request errors, provider errors and mid-stream failures surface as OpenAI-shaped errors', async () => {
  const quiet = fakeSdk([]);
  const fetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: quiet.sdk });
  const invalid = await fetch(ENDPOINT, post(request({ reasoning_effort: 'high' })));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.type, 'invalid_request_error');
  const notJson = await fetch(ENDPOINT, { method: 'POST', body: '{' });
  assert.equal(notJson.status, 400);
  assert.equal(quiet.sent.length, 0);

  const denied = fakeSdk([], { fail: Object.assign(new Error('arn:aws:iam::563688183799:role/x'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }) });
  const deniedResponse = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: denied.sdk })(ENDPOINT, post(request()));
  assert.equal(deniedResponse.status, 403);
  const deniedText = await deniedResponse.text();
  assert.doesNotMatch(deniedText, /arn|563688183799/);
  assert.equal(JSON.parse(deniedText).error.code, 'AccessDeniedException');
  assert.equal(denied.sent[0].destroyed, true);

  const broken = fakeSdk(async function* () { yield { messageStart: {} }; yield { contentBlockDelta: { delta: { text: 'partial' } } }; throw Object.assign(new Error('boom'), { name: 'ModelStreamErrorException' }); });
  const brokenFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: broken.sdk })(ENDPOINT, post(request()))).text());
  assert.notEqual(brokenFrames.at(-1), '[DONE]');
  // The frame carries the status the workers classify by: the HTTP status is already 200.
  assert.deepEqual(JSON.parse(brokenFrames.at(-1)!), { error: { message: 'The Bedrock request failed', type: 'ModelStreamErrorException', code: 'ModelStreamErrorException', status: 502 } });
  const throttled = fakeSdk([{ messageStart: {} }, { throttlingException: { message: 'slow down' } }]);
  const throttledFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: throttled.sdk })(ENDPOINT, post(request()))).text());
  assert.equal(JSON.parse(throttledFrames.at(-1)!).error.status, 429);
  // A refusal of the bridge's own (content it cannot relay) is not a provider outage: no status.
  const citing = fakeSdk([{ messageStart: {} }, { contentBlockDelta: { delta: { citation: { title: 'doc' } } } }]);
  const citingFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: citing.sdk })(ENDPOINT, post(request()))).text());
  assert.deepEqual(JSON.parse(citingFrames.at(-1)!), { error: { message: 'Bedrock returned content the bridge cannot relay', type: 'api_error', code: 'api_error' } });

  const truncated = fakeSdk([{ messageStart: {} }, { contentBlockDelta: { delta: { text: 'cut' } } }]);
  const truncatedFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: truncated.sdk })(ENDPOINT, post(request()))).text());
  assert.match(truncatedFrames.at(-1)!, /ended before the response was complete/);
});

// Regression: a real stream (reasoning signatures, block stops) delivered events that map to no
// chunk while the reader was already waiting; the pull ended empty and was never called again.
test('events that map to no chunk never stall a reader waiting on a slow stream', { timeout: 5000 }, async () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 5));
  const slow = fakeSdk(async function* () {
    yield { messageStart: { role: 'assistant' } };
    for (const event of [{ contentBlockDelta: { delta: { reasoningContent: { text: 'think' } } } }, { contentBlockDelta: { delta: { reasoningContent: { signature: 'sig' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } }, { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_1', name: 'calculator' } } } },
      { contentBlockDelta: { delta: { toolUse: { input: '' } } } }, { contentBlockDelta: { delta: { toolUse: { input: '{}' } } } }, { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'tool_use' } }, { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]) {
      await pause();
      yield event;
    }
  });
  const response = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: slow.sdk })(ENDPOINT, post(request()));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value);
  }
  const data = frames(text);
  assert.equal(data.at(-1), '[DONE]');
  assert.deepEqual(data.slice(0, -1).map(frame => { const chunk = JSON.parse(frame); return chunk.usage ? 'usage' : chunk.choices[0].finish_reason ?? Object.keys(chunk.choices[0].delta).join(); }),
    ['role,content', 'reasoning_content', 'tool_calls', 'tool_calls', 'tool_calls', 'usage']);
});

test('cancellation aborts the provider request and the stream', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Like the real SDK, the provider stream fails once its request is aborted.
  const slow = fakeSdk(async function* (signal) { yield { messageStart: {} }; await gate; if (signal?.aborted) throw signal.reason; yield { contentBlockDelta: { delta: { text: 'late' } } }; });
  const controller = new AbortController();
  const response = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: slow.sdk })(ENDPOINT, post(request(), { signal: controller.signal }));
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  assert.equal(slow.sent[0].signal?.aborted, true);
  const pending = reader.read();
  release();
  await assert.rejects(pending, /Cancelled|Abort/);

  const already = new AbortController();
  already.abort();
  const before = fakeSdk([], { fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  await assert.rejects(createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: before.sdk })(ENDPOINT, post(request(), { signal: already.signal })));
});
