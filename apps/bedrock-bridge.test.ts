import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEDROCK_BRIDGE_API_KEY, BEDROCK_CONNECTION_FAILURE, BEDROCK_CREDENTIAL_REFRESH_MS, BEDROCK_STREAM_IDLE_MS, BedrockBridgeError, bedrockBridgeBaseURL, bedrockFactLine, bedrockOrigin, bridgeFailure, chatUsage,
  childBedrockFetch, createBedrockAuthResolver, createBedrockFetch, createChunkMapper, toConverseInput, validBedrockAuth, validBedrockRegion,
  SUMMARIZED_THINKING_MODELS, validThinkingBudget, withClaudePromptCache, withClaudeThinking, withSummarizedThinking, type BedrockCallFact,
  type BedrockSdk,
} from './bedrock-bridge.ts';

const MODEL = 'global.anthropic.claude-opus-5-5';
const REGION = 'us-east-1';
const ENDPOINT = `${bedrockBridgeBaseURL(REGION)}/chat/completions`;
const BEARER = { bearerToken: 'ABSKbedrockkey000000000000000000' };
// What Claude Opus 5.5 (MODEL) is asked for on every call (withSummarizedThinking), and a Claude model that is not.
const SUMMARY = { thinking: { type: 'adaptive', display: 'summarized' } };
const OPUS_48 = 'global.anthropic.claude-opus-4-8';

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

test('a user turn\'s pictures become Converse image blocks between its text', () => {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const command = toConverseInput(request({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'What is ' }, { type: 'text', text: 'this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' } },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } }, { type: 'text', text: 'And that.' },
  ] }] }), MODEL);
  const content = (command.messages as Array<{ content: Array<Record<string, any>> }>)[0].content;
  assert.equal(content.length, 4);
  assert.deepEqual(content[0], { text: 'What is this?' });
  assert.equal(content[1].image.format, 'png');
  assert.ok(content[1].image.source.bytes instanceof Uint8Array);
  assert.deepEqual([...content[1].image.source.bytes], signature);
  assert.equal(content[2].image.format, 'webp');
  assert.deepEqual(content[3], { text: 'And that.' });
  // A text-only turn maps exactly as before.
  assert.deepEqual((toConverseInput(request(), MODEL).messages as unknown[])[0], { role: 'user', content: [{ text: 'Hello' }] });
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
  const picture = (url: string, extra: Record<string, unknown> = {}) => ({ type: 'image_url', image_url: { url, ...extra } });
  rejects(request({ messages: [{ role: 'user', content: [picture('https://example.test/cat.png')] }] }), /base64 data URLs/);
  rejects(request({ messages: [{ role: 'user', content: [picture('data:image/bmp;base64,AAAA')] }] }), /base64 data URLs/);
  rejects(request({ messages: [{ role: 'user', content: [picture('data:image/png;base64,AAA')] }] }), /base64 data URLs/);
  rejects(request({ messages: [{ role: 'user', content: [picture('data:image/png;base64,AAAA', { size: 1 })] }] }), /Invalid image/);
  rejects(request({ messages: [{ role: 'user', content: [picture('data:image/png;base64,AAAA', { detail: 'max' })] }] }), /Invalid image/);
  rejects(request({ messages: [{ role: 'user', content: [picture('data:image/png;base64,' + 'A'.repeat(5_242_884))] }] }), /larger than 3.75 MiB/);
  rejects(request({ messages: [{ role: 'user', content: Array.from({ length: 21 }, () => picture('data:image/png;base64,AAAA')) }] }), /At most 20 images/);
  rejects(request({ messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: [picture('data:image/png;base64,AAAA')] }, { role: 'user', content: 'go' }] }), /Only text content is supported in assistant/);
  rejects(request({ messages: [{ role: 'system', content: [picture('data:image/png;base64,AAAA')] }, { role: 'user', content: 'Q' }] }), /Only text content is supported in system/);
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
  const denied = bridgeFailure(Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.type, 'AccessDeniedException');
  assert.doesNotMatch(denied.message, /arn|123456789012/);
  assert.equal(bridgeFailure({ name: 'ThrottlingException' }).status, 429);
  assert.equal(bridgeFailure({ name: 'Weird', $metadata: { httpStatusCode: 418 } }).status, 418);
  // Neither an AWS exception nor an HTTP status: the way to AWS failed (a socket's, a stream's or a timer's own error),
  // which AWS never reported.
  for (const error of [new Error('socket hang up'), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }), new TypeError('terminated'), undefined,
    // Every name the process gives its own errors.
    ...['', 'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError'].map(name => Object.assign(new Error('x'), { name }))]) {
    const unknown = bridgeFailure(error);
    assert.deepEqual([unknown.status, unknown.type, unknown.upstream], [502, BEDROCK_CONNECTION_FAILURE, true], `${(error as Error | undefined)?.name}: ${String(error)}`);
  }
  assert.equal(BEDROCK_CONNECTION_FAILURE, 'connection_error');
  // An exception AWS named that the bridge does not know (the SDK throws a stream exception it does not model, or an
  // error message, with AWS's own code as its name) is AWS's failure, as before, with a status the workers read; so is a
  // name that is only an object's own member (no longer a status taken from it).
  for (const error of [Object.assign(new Error('arn:aws:iam::123456789012:role/x'), { name: 'InternalFailure' }), { name: 'Weird', $metadata: { httpStatusCode: 200 } }, { name: 'toString' }]) {
    const named = bridgeFailure(error);
    assert.deepEqual([named.status, named.type, named.upstream], [502, 'api_error', true], JSON.stringify(error));
  }
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
  assert.deepEqual(sent[0].config, { requestHandler: { disableConcurrentStreams: true, sessionTimeout: BEDROCK_STREAM_IDLE_MS }, region: REGION, endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com', maxAttempts: 1, token: { token: BEARER.bearerToken }, authSchemePreference: ['httpBearerAuth'] });
  assert.ok(BEDROCK_STREAM_IDLE_MS > 600_000, 'a silent tool call of a whole output cap fits the idle limit');
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

  const denied = fakeSdk([], { fail: Object.assign(new Error('arn:aws:iam::123456789012:role/x'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }) });
  const deniedResponse = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: denied.sdk })(ENDPOINT, post(request()));
  assert.equal(deniedResponse.status, 403);
  const deniedText = await deniedResponse.text();
  assert.doesNotMatch(deniedText, /arn|123456789012/);
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
  // Nor is a stream lost on its way to AWS, which AWS never reported (a connection reset partway): AWS may already have
  // done, and billed, the work, so the workers must not take it for a refusal that cost nothing. Before the stream
  // began, the same failure keeps the response's own status, as every failure there does.
  const reset = fakeSdk(async function* () { yield { messageStart: {} }; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); });
  const resetFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: reset.sdk })(ENDPOINT, post(request()))).text());
  assert.deepEqual(JSON.parse(resetFrames.at(-1)!), { error: { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' } });
  // A stream exception AWS reports that the SDK does not model is AWS's, and keeps its status.
  const unmodelled = fakeSdk(async function* () { yield { messageStart: {} }; throw Object.assign(new Error('arn:aws:iam::123456789012:role/x'), { name: 'InternalFailure' }); });
  const unmodelledFrames = frames(await (await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: unmodelled.sdk })(ENDPOINT, post(request()))).text());
  assert.deepEqual(JSON.parse(unmodelledFrames.at(-1)!), { error: { message: 'The Bedrock request failed', type: 'api_error', code: 'api_error', status: 502 } });
  const refused = fakeSdk([], { fail: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const refusedResponse = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: refused.sdk })(ENDPOINT, post(request()));
  assert.equal(refusedResponse.status, 502);
  assert.deepEqual(await refusedResponse.json(), { error: { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' } });
  // Lost after AWS answered but before its first event, which the real SDK reads before `send` returns (and stamps the
  // loss with AWS's 200, pi-worker/bedrock-sdk.test.mjs): the stream's failure, inside a 200, its only frame.
  const answered = fakeSdk([], { fail: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', $metadata: { httpStatusCode: 200 } }) });
  const answeredResponse = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: answered.sdk })(ENDPOINT, post(request()));
  assert.equal(answeredResponse.status, 200);
  assert.match(answeredResponse.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.deepEqual(frames(await answeredResponse.text()).map(frame => JSON.parse(frame)), [{ error: { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' } }]);

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

// The model's other inference profile (the catalog's fallbackTarget), asked once when its profile refuses the call.
const FALLBACK = 'us.anthropic.claude-opus-5-5';
const ANSWER = [{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { text: 'OK' } } }, { messageStop: { stopReason: 'end_turn' } }, { metadata: { usage: { inputTokens: 3, outputTokens: 1 } } }];
const awsError = (name: string, status: number) => Object.assign(new Error(`arn:aws:iam::123456789012:user/machine/x is refused (${name})`), { name, $metadata: { httpStatusCode: status } });
type Step = { fail?: unknown; events?: unknown[] | (() => AsyncIterable<unknown>) };

/** An SDK whose sends play `steps` in order, recording each send's input and how many streams were closed early. */
function scriptedSdk(steps: Step[]) {
  const clients: Record<string, unknown>[] = [];
  const inputs: Record<string, unknown>[] = [];
  let closedEarly = 0;
  class ConverseStreamCommand { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } }
  class BedrockRuntimeClient {
    constructor(config: Record<string, unknown>) { clients.push(config); }
    async send(command: ConverseStreamCommand) {
      inputs.push(command.input);
      const step = steps.shift();
      if (!step) throw new Error('an unexpected send');
      if (step.fail) throw step.fail;
      const events = step.events ?? [];
      const source = (typeof events === 'function' ? events() : (async function* () { yield* events; })())[Symbol.asyncIterator]();
      const stream = { [Symbol.asyncIterator]: () => ({ next: () => source.next(), return: async () => { closedEarly += 1; return { done: true, value: undefined }; } }) };
      return { stream: stream as unknown as AsyncIterable<Record<string, unknown>> };
    }
    destroy() {}
  }
  return { sdk: { BedrockRuntimeClient, ConverseStreamCommand } as unknown as BedrockSdk, clients, inputs, closedEarly: () => closedEarly };
}
const fallbackFetch = (steps: Step[], options: { fallbackModel?: string; report?: (fact: BedrockCallFact) => void } = { fallbackModel: FALLBACK }) => {
  const script = scriptedSdk(steps);
  const facts: BedrockCallFact[] = [];
  const fetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: script.sdk, report: fact => facts.push(fact), ...options });
  return { ...script, facts, call: (init: RequestInit = {}) => fetch(ENDPOINT, post(request(), init)) };
};
const answered = async (response: Response) => {
  assert.equal(response.status, 200);
  const data = frames(await response.text());
  assert.equal(data.at(-1), '[DONE]');
  const chunks = data.slice(0, -1).map(frame => JSON.parse(frame));
  assert.ok(chunks.every(chunk => chunk.model === MODEL), 'the chunks name the model the caller asked for');
  return chunks.map(chunk => chunk.choices[0]?.delta ?? chunk.usage);
};
const ANSWERED = [{ role: 'assistant', content: '' }, { content: 'OK' }, {}, { prompt_tokens: 3, completion_tokens: 1 }];

test('a profile refusing the call for capacity or quota turns it to the model\'s other profile, once, on the same client', async () => {
  for (const [name, status] of [['ServiceUnavailableException', 503], ['ThrottlingException', 429], ['InternalServerException', 500],
    ['ModelNotReadyException', 503], ['ServiceQuotaExceededException', 429]] as const) {
    const run = fallbackFetch([{ fail: awsError(name, status) }, { events: ANSWER }]);
    assert.deepEqual(await answered(await run.call()), ANSWERED, name);
    assert.equal(run.clients.length, 1, 'one client; the SDK itself still never retries');
    assert.equal(run.clients[0].maxAttempts, 1);
    assert.deepEqual(run.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
    assert.deepEqual(run.inputs[1], { ...run.inputs[0], modelId: FALLBACK }, 'the same request, only the profile differs');
    assert.deepEqual(run.facts, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: name }]);
  }
});

test('an exception that opens the stream is the profile\'s refusal; any other first event stays where it was', async () => {
  // The exception as the stream's first member, and as the SDK throws it from the stream.
  const member = fallbackFetch([{ events: [{ throttlingException: { message: 'Too many tokens per day' } }] }, { events: ANSWER }]);
  assert.deepEqual(await answered(await member.call()), ANSWERED);
  assert.deepEqual(member.facts, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: 'throttlingException' }]);
  assert.equal(member.closedEarly(), 1, 'the refused stream is closed');
  const thrown = fallbackFetch([{ events: async function* () { throw awsError('ServiceUnavailableException', 503); } }, { events: ANSWER }]);
  assert.deepEqual(await answered(await thrown.call()), ANSWERED);
  assert.deepEqual(thrown.facts, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: 'ServiceUnavailableException' }]);

  // An answer that opens normally is relayed exactly as without a fallback, on the one profile.
  const normal = fallbackFetch([{ events: ANSWER }]);
  assert.deepEqual(await answered(await normal.call()), ANSWERED);
  assert.deepEqual(normal.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(normal.facts, []);
  // Once anything streamed, a refusal is the call's failure: nothing is asked again.
  const late = fallbackFetch([{ events: [{ messageStart: { role: 'assistant' } }, { throttlingException: { message: 'later' } }] }]);
  const lateFrames = frames(await (await late.call()).text());
  assert.equal(JSON.parse(lateFrames.at(-1)!).error.status, 429);
  assert.deepEqual(late.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(late.facts, [{ event: 'failed', model: MODEL, error: 'throttlingException', status: 429, stage: 'stream', upstream: true }]);
  // Another first exception is relayed as the stream's error, as it always was.
  const invalid = fallbackFetch([{ events: [{ validationException: { message: 'bad input' } }] }]);
  const invalidResponse = await invalid.call();
  assert.equal(invalidResponse.status, 200);
  assert.deepEqual(JSON.parse(frames(await invalidResponse.text()).at(-1)!), { error: { message: 'The Bedrock stream reported an error', type: 'validationException', code: 'validationException', status: 400 } });
  assert.deepEqual(invalid.inputs.map(input => input.modelId), [MODEL]);
});

test('no fallback without a fallback model, for any other failure, or a second time', async () => {
  const single = fallbackFetch([{ fail: awsError('ServiceUnavailableException', 503) }], {});
  assert.equal((await single.call()).status, 503);
  assert.deepEqual(single.inputs.map(input => input.modelId), [MODEL]);
  for (const [name, status] of [['AccessDeniedException', 403], ['ValidationException', 400], ['ModelTimeoutException', 408], ['ResourceNotFoundException', 404], ['ModelErrorException', 502]] as const) {
    const run = fallbackFetch([{ fail: awsError(name, status) }]);
    const response = await run.call();
    assert.equal(response.status, status, name);
    assert.deepEqual(run.inputs.map(input => input.modelId), [MODEL], name);
    assert.deepEqual(run.facts, [{ event: 'failed', model: MODEL, error: name, status, stage: 'request', upstream: true }]);
  }
  // A failure on the way to AWS is no profile's refusal, before the stream or as it opens: the call fails as it is, on
  // the way to AWS (upstream), and after the stream began without a status for the workers.
  const unsent = fallbackFetch([{ fail: new Error('socket hang up') }]);
  assert.equal((await unsent.call()).status, 502);
  assert.deepEqual(unsent.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(unsent.facts, [{ event: 'failed', model: MODEL, error: 'connection_error', status: 502, stage: 'request', upstream: true }]);
  const cut = fallbackFetch([{ events: async function* () { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); } }]);
  const cutResponse = await cut.call();
  assert.equal(cutResponse.status, 200);
  assert.equal(JSON.parse(frames(await cutResponse.text()).at(-1)!).error.status, undefined);
  assert.deepEqual(cut.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(cut.facts, [{ event: 'failed', model: MODEL, error: 'connection_error', status: 502, stage: 'stream', upstream: true }]);
  // A stream AWS answered and lost before its first event (the real SDK's rejection, stamped with AWS's 200) is no
  // profile's refusal either: the stream's failure, from the first profile, and from the other one after the first
  // refused.
  const stamped = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', $metadata: { httpStatusCode: 200 } });
  const lostFirst = fallbackFetch([{ fail: stamped() }]);
  const lostFirstResponse = await lostFirst.call();
  assert.equal(lostFirstResponse.status, 200);
  assert.deepEqual(frames(await lostFirstResponse.text()).map(frame => JSON.parse(frame)), [{ error: { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' } }]);
  assert.deepEqual(lostFirst.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(lostFirst.facts, [{ event: 'failed', model: MODEL, error: 'connection_error', status: 502, stage: 'stream', upstream: true }]);
  const lostOther = fallbackFetch([{ fail: awsError('ThrottlingException', 429) }, { fail: stamped() }]);
  const lostOtherResponse = await lostOther.call();
  assert.equal(lostOtherResponse.status, 200);
  assert.equal(JSON.parse(frames(await lostOtherResponse.text()).at(-1)!).error.type, 'connection_error');
  assert.deepEqual(lostOther.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
  assert.deepEqual(lostOther.facts, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: 'ThrottlingException' },
    { event: 'failed', model: FALLBACK, error: 'connection_error', status: 502, stage: 'stream', upstream: true }]);
  // Both profiles refuse: the call fails with the fallback's refusal, its message never relayed, and nothing more is asked.
  const both = fallbackFetch([{ fail: awsError('ThrottlingException', 429) }, { fail: awsError('ServiceUnavailableException', 503) }]);
  const bothResponse = await both.call();
  assert.equal(bothResponse.status, 503);
  const bothText = await bothResponse.text();
  assert.doesNotMatch(bothText, /arn|123456789012/);
  assert.deepEqual(both.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
  assert.deepEqual(both.facts, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: 'ThrottlingException' },
    { event: 'failed', model: FALLBACK, error: 'ServiceUnavailableException', status: 503, stage: 'request', upstream: true }]);
  // The fallback's own stream is relayed as it comes, even an exception that opens it.
  const second = fallbackFetch([{ fail: awsError('ThrottlingException', 429) }, { events: [{ throttlingException: { message: 'also' } }] }]);
  const secondFrames = frames(await (await second.call()).text());
  assert.equal(JSON.parse(secondFrames.at(-1)!).error.status, 429);
  assert.deepEqual(second.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
  assert.deepEqual(second.facts.at(-1), { event: 'failed', model: FALLBACK, error: 'throttlingException', status: 429, stage: 'stream', upstream: true });
});

test('a request AWS refuses as larger than its model\'s window is named so, without AWS\'s message, and not sent to the other profile', async () => {
  const tooLong = Object.assign(new Error('Input is too long for requested model. (arn:aws:iam::123456789012:user/machine/x)'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });
  const refused = bridgeFailure(tooLong);
  assert.deepEqual([refused.status, refused.type, refused.message, refused.upstream], [400, 'context_length_exceeded', 'Input is too long for requested model', true]);
  // Anthropic's words for an input that leaves no room for the output limit are the same refusal.
  assert.equal(bridgeFailure(Object.assign(new Error('input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000'), { name: 'ValidationException' })).type, 'context_length_exceeded');
  // Another refusal of the request, or a throttle that names tokens, is not.
  assert.equal(bridgeFailure(Object.assign(new Error('The provided model identifier is invalid.'), { name: 'ValidationException' })).type, 'ValidationException');
  assert.equal(bridgeFailure(Object.assign(new Error('Too many tokens, please wait before trying again.'), { name: 'ThrottlingException' })).type, 'ThrottlingException');
  const run = fallbackFetch([{ fail: tooLong }]);
  const response = await run.call();
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.doesNotMatch(text, /arn|123456789012/);
  assert.deepEqual(JSON.parse(text).error, { message: 'Input is too long for requested model', type: 'context_length_exceeded', code: 'context_length_exceeded', status: 400 });
  assert.deepEqual(run.inputs.map(input => input.modelId), [MODEL]);
  assert.deepEqual(run.facts, [{ event: 'failed', model: MODEL, error: 'context_length_exceeded', status: 400, stage: 'request', upstream: true }]);
  // From the other profile, after the first one's refusal, it is two requests: not one made before any work, so it goes
  // out as AWS's validation failure.
  const second = fallbackFetch([{ fail: awsError('ThrottlingException', 429) }, { fail: tooLong }]);
  const after = await second.call();
  assert.equal(after.status, 400);
  assert.deepEqual(JSON.parse(await after.text()).error, { message: 'The Bedrock request failed', type: 'ValidationException', code: 'ValidationException', status: 400 });
  assert.deepEqual(second.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
});

test('a failure the bridge itself makes is reported as not AWS\'s, and a child\'s bridge carries its parent\'s settings', async () => {
  const facts: BedrockCallFact[] = [];
  const script = scriptedSdk([]);
  const refused = await createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: script.sdk, report: fact => facts.push(fact) })(ENDPOINT, post(request({ reasoning_effort: 'high' })));
  assert.equal(refused.status, 400);
  assert.deepEqual(facts, [{ event: 'failed', model: MODEL, error: 'invalid_request_error', status: 400, stage: 'request', upstream: false }]);
  const cut = fallbackFetch([{ events: [{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { text: 'cut' } } }] }]);
  await (await cut.call()).text();
  assert.deepEqual(cut.facts, [{ event: 'failed', model: MODEL, error: 'api_error', status: 502, stage: 'stream', upstream: false }]);

  // childBedrockFetch: the settings a parent sends, over the same bridge.
  const child = scriptedSdk([{ fail: awsError('ServiceUnavailableException', 503) }, { events: ANSWER }]);
  const told: BedrockCallFact[] = [];
  const fetch = childBedrockFetch({ region: REGION, model: MODEL, fallbackModel: FALLBACK, promptCache: true, thinkingBudget: 2048 }, BEARER, child.sdk, fact => told.push(fact));
  const turn = request({ max_tokens: 16000, messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Again' }] });
  const answer = await fetch(ENDPOINT, post(turn));
  assert.equal(answer.status, 200);
  await answer.text();
  assert.deepEqual(child.inputs.map(input => input.modelId), [MODEL, FALLBACK]);
  assert.deepEqual(child.inputs[1], { ...child.inputs[0], modelId: FALLBACK });
  assert.ok(JSON.stringify(child.inputs[0]).includes('cachePoint'), 'the prompt cache it was sent');
  assert.ok(JSON.stringify(child.inputs[0]).includes('2048'), 'the thinking budget it was sent');
  assert.deepEqual(told, [{ event: 'fallback', from: MODEL, to: FALLBACK, after: 'ServiceUnavailableException' }]);
  // Settings it was not sent are not applied, and a child that cannot report its calls is refused.
  const bare = scriptedSdk([{ fail: awsError('ServiceUnavailableException', 503) }]);
  assert.equal((await childBedrockFetch({ region: REGION, model: MODEL }, BEARER, bare.sdk, () => {})(ENDPOINT, post(request()))).status, 503);
  assert.deepEqual(bare.inputs.map(input => input.modelId), [MODEL]);
  assert.equal(JSON.stringify(bare.inputs[0]).includes('cachePoint'), false);
  assert.throws(() => childBedrockFetch({ region: REGION, model: MODEL }, BEARER, bare.sdk, undefined as never), /reports its calls/);
});

test('a cancelled call never turns to the other profile, and a failing reporter never fails a call', async () => {
  const already = new AbortController();
  already.abort();
  const before = fallbackFetch([{ fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]);
  await assert.rejects(before.call({ signal: already.signal }));
  assert.equal(before.inputs.length, 1);
  // Cancelled while the first event was awaited: the call ends as cancelled, never as a fallback.
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const waiting = fallbackFetch([{ events: async function* () { await gate; throw awsError('ServiceUnavailableException', 503); } }]);
  const pending = waiting.call({ signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  release();
  await assert.rejects(pending, /Cancelled|Abort/);
  assert.equal(waiting.inputs.length, 1);
  assert.deepEqual(waiting.facts, []);

  const throwing = fallbackFetch([{ fail: awsError('ServiceUnavailableException', 503) }, { events: ANSWER }], { fallbackModel: FALLBACK, report: () => { throw new Error('log down'); } });
  assert.deepEqual(await answered(await throwing.call()), ANSWERED);
  const { sdk } = scriptedSdk([]);
  for (const fallbackModel of [MODEL, '', 'us.anthropic claude', 'x'.repeat(129)]) {
    assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, fallbackModel }), /Invalid Bedrock fallback model/, fallbackModel);
  }
  assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, report: 'log' as never }), /Invalid Bedrock call reporter/);
});

test('a call\'s facts become one closed log line each, and nothing else does', () => {
  const runId = 'run_123-abc';
  assert.deepEqual(JSON.parse(bedrockFactLine('awwo-pi-worker', runId, { event: 'fallback', from: MODEL, to: FALLBACK, after: 'ServiceUnavailableException' })!),
    { service: 'awwo-pi-worker', runId, event: 'bedrock_profile_fallback', from: MODEL, to: FALLBACK, after: 'ServiceUnavailableException' });
  assert.deepEqual(JSON.parse(bedrockFactLine('awwo-pi-worker', undefined, { event: 'failed', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', error: 'ThrottlingException', status: 429, stage: 'request', upstream: true, message: 'secret text' })!),
    { service: 'awwo-pi-worker', event: 'bedrock_call_failed', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', error: 'ThrottlingException', status: 429, stage: 'request', upstream: true });
  // A run id that is not one is left out; anything off the closed shapes is no line at all.
  assert.equal(JSON.parse(bedrockFactLine('s', 'run id with spaces', { event: 'failed', model: MODEL, error: 'x', status: 500, stage: 'stream', upstream: false })!).runId, undefined);
  for (const fact of [undefined, 'fallback', [], { event: 'other' }, { event: 'fallback', from: MODEL, to: FALLBACK }, { event: 'fallback', from: MODEL, to: 'us.x "y"', after: 'x' },
    { event: 'failed', model: MODEL, error: 'x', status: 99, stage: 'request' }, { event: 'failed', model: MODEL, error: 'x', status: 600, stage: 'request' },
    { event: 'failed', model: MODEL, error: 'x', status: 429.5, stage: 'request' }, { event: 'failed', model: MODEL, error: 'x', status: 429, stage: 'later' },
    { event: 'failed', model: MODEL, error: 'line\nbreak', status: 429, stage: 'request', upstream: true },
    // Whether AWS said it is part of the fact: a fact without it is no line.
    { event: 'failed', model: MODEL, error: 'x', status: 429, stage: 'request' }, { event: 'failed', model: MODEL, error: 'x', status: 429, stage: 'request', upstream: 'yes' }]) {
    assert.equal(bedrockFactLine('s', runId, fact), undefined, JSON.stringify(fact));
  }
});

test('an operator thinking budget turns on Claude thinking only for tool-free requests with room for it', () => {
  const plain = toConverseInput(request({ max_tokens: 8000, temperature: 0.3, top_p: 0.9 }), MODEL);
  const thinking = withClaudeThinking(plain, 2048);
  assert.deepEqual(thinking.additionalModelRequestFields, { thinking: { type: 'enabled', budget_tokens: 2048 } });
  // Thinking needs the default sampling: temperature and top_p go, the output limit stays.
  assert.deepEqual(thinking.inferenceConfig, { maxTokens: 8000 });
  assert.deepEqual(thinking.messages, plain.messages);
  assert.equal(plain.additionalModelRequestFields, undefined, 'the input command is not mutated');
  // Offered tools, replayed tool turns, a tight output limit or an invalid budget leave the request unchanged.
  const tools = toConverseInput(request({ max_tokens: 8000, tools: [{ type: 'function', function: { name: 'current_time', parameters: { type: 'object', properties: {} } } }] }), MODEL);
  assert.equal(withClaudeThinking(tools, 2048), tools);
  const history = toConverseInput(request({ max_tokens: 8000, tools: [{ type: 'function', function: { name: 'current_time', parameters: { type: 'object', properties: {} } } }],
    messages: [{ role: 'user', content: 'Time?' }, { role: 'assistant', content: '', tool_calls: [{ id: 'tooluse_1', type: 'function', function: { name: 'current_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tooluse_1', content: 'noon' }] }), MODEL);
  assert.equal(withClaudeThinking({ ...history, toolConfig: undefined }, 2048).additionalModelRequestFields, undefined);
  const tight = toConverseInput(request({ max_tokens: 3000 }), MODEL);
  assert.equal(withClaudeThinking(tight, 2048), tight);
  for (const budget of [0, 1023, 16001, 2048.5, Number.NaN]) assert.equal(validThinkingBudget(budget), false);
  assert.equal(withClaudeThinking(plain, 512), plain);
});

test('the fetch sends the thinking budget it was configured with, and refuses an invalid one', async () => {
  const { sdk, sent } = fakeSdk([{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { reasoningContent: { text: 'plan' } } } },
    { contentBlockDelta: { delta: { text: 'OK' } } }, { messageStop: { stopReason: 'end_turn' } }, { metadata: { usage: { inputTokens: 3, outputTokens: 9 } } }]);
  assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, thinkingBudget: 100 }), /thinking budget/);
  const fetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, thinkingBudget: 2048 });
  const response = await fetch(ENDPOINT, post(request({ max_tokens: 8000 })));
  assert.equal(response.status, 200);
  const chunks = frames(await response.text()).slice(0, -1).map(frame => JSON.parse(frame));
  assert.ok(chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content === 'plan'), 'reasoning streams as reasoning content');
  assert.ok(chunks.some(chunk => chunk.choices?.[0]?.delta?.content === 'OK'));
  assert.deepEqual(sent[0].input.additionalModelRequestFields, { thinking: { type: 'enabled', budget_tokens: 2048 } });
  // Without a budget, Claude Opus 5.5 is asked for its thinking as a summary (withSummarizedThinking), and another model
  // gets no thinking field.
  const plainFetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk });
  await (await plainFetch(ENDPOINT, post(request({ max_tokens: 8000 })))).text();
  assert.deepEqual(sent[1].input.additionalModelRequestFields, SUMMARY);
  const otherFetch = createBedrockFetch({ region: REGION, model: OPUS_48, auth: BEARER, sdk });
  await (await otherFetch(ENDPOINT, post(request({ model: OPUS_48, max_tokens: 8000 })))).text();
  assert.equal(sent[2].input.additionalModelRequestFields, undefined);
});


const CACHE_POINT = { cachePoint: { type: 'default' } };
const TIME_TOOL = [{ type: 'function', function: { name: 'current_time', parameters: { type: 'object', properties: {} } } }];
const TOOL_LOOP = [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'Time?' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'tooluse_1', type: 'function', function: { name: 'current_time', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'tooluse_1', content: 'noon' }];

test('the prompt cache marks a re-sent prefix after the tools, the system prompt and the last message', () => {
  const loop = toConverseInput(request({ tools: TIME_TOOL, messages: TOOL_LOOP }), MODEL);
  const cached = withClaudePromptCache(loop);
  assert.deepEqual((cached.toolConfig as { tools: unknown[] }).tools, [...(loop.toolConfig as { tools: unknown[] }).tools, CACHE_POINT]);
  assert.deepEqual(cached.system, [{ text: 'Use tools.' }, CACHE_POINT]);
  const messages = cached.messages as { role: string; content: unknown[] }[];
  assert.deepEqual(messages.slice(0, -1), (loop.messages as unknown[]).slice(0, -1), 'earlier turns are unchanged');
  assert.deepEqual(messages.at(-1)!.content, [...(loop.messages as { content: unknown[] }[]).at(-1)!.content, CACHE_POINT]);
  // At most three of Claude's four checkpoints, and the input command is not mutated.
  assert.equal(JSON.stringify(cached).split('"cachePoint"').length - 1, 3);
  assert.equal(JSON.stringify(loop).includes('cachePoint'), false);
  // A conversation without tools or system prompt gets only the message checkpoint.
  const chat = toConverseInput(request({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'More' }] }), MODEL);
  const chatCached = withClaudePromptCache(chat);
  assert.equal(chatCached.system, undefined);
  assert.equal(chatCached.toolConfig, undefined);
  assert.deepEqual((chatCached.messages as { content: unknown[] }[]).at(-1)!.content, [{ text: 'More' }, CACHE_POINT]);
});

test('a single-message request is left as it was, so a one-off call never pays for a cache write', () => {
  const single = toConverseInput(request({ tools: TIME_TOOL }), MODEL);
  assert.equal(withClaudePromptCache(single), single);
  // Thinking and caching compose: the thinking request (tool-free, with history) keeps its thinking field.
  const thought = withClaudeThinking(toConverseInput(request({ max_tokens: 8000,
    messages: [{ role: 'user', content: 'Plan' }, { role: 'assistant', content: 'Draft' }, { role: 'user', content: 'Again' }] }), MODEL), 2048);
  const both = withClaudePromptCache(thought);
  assert.deepEqual(both.additionalModelRequestFields, { thinking: { type: 'enabled', budget_tokens: 2048 } });
  assert.deepEqual((both.messages as { content: unknown[] }[]).at(-1)!.content, [{ text: 'Again' }, CACHE_POINT]);
});

test('the fetch sends cache checkpoints only when the operator turned the cache on', async () => {
  const events = [{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { text: 'OK' } } }, { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 2000, cacheWriteInputTokens: 40 } } }];
  const { sdk, sent } = fakeSdk(events);
  assert.throws(() => createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, promptCache: 'yes' as unknown as boolean }), /prompt cache/);
  const body = request({ tools: TIME_TOOL, messages: TOOL_LOOP });
  const cachedFetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, promptCache: true });
  const response = await cachedFetch(ENDPOINT, post(body));
  const chunks = frames(await response.text()).slice(0, -1).map(frame => JSON.parse(frame));
  assert.equal(JSON.stringify(sent[0].input).split('"cachePoint"').length - 1, 3);
  // Usage keeps counting every prompt token, reads and writes included, with the reads as cached tokens.
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 2043, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 2000 } });
  // Off (the default) and false send exactly the request the bridge sent before: a tool loop's history keeps Claude
  // Opus 5.5's request as it was too (withSummarizedThinking).
  for (const options of [{}, { promptCache: false }]) {
    const plainFetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk, ...options });
    await (await plainFetch(ENDPOINT, post(body))).text();
    assert.deepEqual(sent.at(-1)!.input, toConverseInput(body, MODEL));
  }
});

test('Claude Opus 5.5 is asked for its thinking as a summary, on every profile, only in a request of the Python worker\'s shape', () => {
  assert.deepEqual([...SUMMARIZED_THINKING_MODELS], ['anthropic.claude-opus-5-5']);
  const user = { role: 'user', content: [{ text: 'Hello' }] };
  for (const model of [MODEL, 'us.anthropic.claude-opus-5-5', 'eu.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5']) {
    const plain = toConverseInput(request({ model }), model);
    assert.deepEqual(withSummarizedThinking(plain), { modelId: model, messages: [user], system: [{ text: 'Be brief.' }],
      inferenceConfig: { maxTokens: 512 }, additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } } }, model);
    assert.equal(plain.additionalModelRequestFields, undefined, 'the input command is not mutated');
  }
  // Tools offered, with no tool turn yet (a tool loop's first call): asked too, its tools as they were.
  const offered = toConverseInput(request({ tools: TIME_TOOL }), MODEL);
  assert.deepEqual(withSummarizedThinking(offered), { ...offered, additionalModelRequestFields: SUMMARY });
  // A tool loop's history, sampling settings and a forced tool choice keep the request exactly as it was.
  for (const [label, body] of [['tool history', request({ tools: TIME_TOOL, messages: TOOL_LOOP })], ['temperature', request({ temperature: 0.2 })],
    ['top_p', request({ top_p: 0.9 })], ['required tool', request({ tools: TIME_TOOL, tool_choice: 'required' })],
    ['named tool', request({ tools: TIME_TOOL, tool_choice: { type: 'function', function: { name: 'current_time' } } })]] as const) {
    const command = toConverseInput(body, MODEL);
    assert.equal(withSummarizedThinking(command), command, label);
  }
  // Another model, a name that only looks like it, and an operator's thinking budget are left exactly as they were.
  for (const model of [OPUS_48, 'us.anthropic.claude-sonnet-4-5', 'anthropic.claude-opus-5-5-v2', 'xglobal.anthropic.claude-opus-5-5', 'deepseek.v3']) {
    const command = toConverseInput(request({ model }), model);
    assert.equal(withSummarizedThinking(command), command, model);
  }
  const budgeted = withClaudeThinking(toConverseInput(request({ max_tokens: 8000 }), MODEL), 2048);
  assert.equal(withSummarizedThinking(budgeted), budgeted);
  assert.equal(withSummarizedThinking({ messages: [] }).additionalModelRequestFields, undefined, 'a command without a model ID');
});

test('the fetch asks Claude Opus 5.5 for the summary, on its other profile too, relays it as reasoning content, and leaves a tool loop as it was', async () => {
  const events = [{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { delta: { reasoningContent: { text: 'Laying out the islands' } } } },
    { contentBlockDelta: { delta: { reasoningContent: { signature: 'sig' } } } }, { contentBlockStop: {} },
    { contentBlockDelta: { delta: { text: '<!doctype html>' } } }, { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 30, outputTokens: 90 } } }];
  const script = scriptedSdk([{ fail: awsError('ThrottlingException', 429) }, { events }, { events }]);
  const fetch = createBedrockFetch({ region: REGION, model: MODEL, auth: BEARER, sdk: script.sdk, fallbackModel: FALLBACK });
  const response = await fetch(ENDPOINT, post(request({ tools: TIME_TOOL })));
  assert.equal(response.status, 200);
  const deltas = frames(await response.text()).slice(0, -1).map(frame => JSON.parse(frame).choices?.[0]?.delta ?? {});
  assert.deepEqual(script.inputs.map(input => [input.modelId, input.additionalModelRequestFields]), [[MODEL, SUMMARY], [FALLBACK, SUMMARY]]);
  assert.deepEqual(deltas.filter(delta => 'reasoning_content' in delta), [{ reasoning_content: 'Laying out the islands' }], 'the signature is dropped');
  assert.ok(deltas.some(delta => delta.content === '<!doctype html>'));
  // The same model's next call of the loop, with the tool turn in its history, carries no thinking field.
  await (await fetch(ENDPOINT, post(request({ tools: TIME_TOOL, messages: TOOL_LOOP })))).text();
  assert.equal(script.inputs.length, 3);
  assert.equal(script.inputs[2].additionalModelRequestFields, undefined);
  assert.deepEqual(script.inputs[2], toConverseInput(request({ tools: TIME_TOOL, messages: TOOL_LOOP }), MODEL));
});
