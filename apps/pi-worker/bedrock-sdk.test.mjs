import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockBridgeBaseURL, createBedrockFetch } from '../bedrock-bridge.ts';

// The shared Converse bridge over the real AWS SDK this worker installs: its client, its reading of the event stream and
// its errors, with only the HTTP exchange scripted (clientOptions.requestHandler), so no request leaves the process. The
// SDK reads a stream's first event before `send` returns, which the bridge's own tests' fake SDKs do not.

const REGION = 'us-east-1';
const MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const ENDPOINT = `${bedrockBridgeBaseURL(REGION)}/chat/completions`;
const REQUEST = { method: 'POST', body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }) };

/** One AWS event-stream message: its prelude (total and header lengths, their CRC), string headers, payload and CRC. */
function message(headers, payload) {
  const encoded = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(Buffer.byteLength(value));
    return Buffer.concat([Buffer.from([Buffer.byteLength(name)]), Buffer.from(name), Buffer.from([7]), length, Buffer.from(value)]);
  }));
  const body = Buffer.from(payload);
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(12 + encoded.length + body.length + 4, 0);
  prelude.writeUInt32BE(encoded.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const whole = Buffer.concat([prelude, encoded, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(whole));
  return Buffer.concat([whole, crc]);
}
const event = (type, value) => message({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }, JSON.stringify(value));
const exception = type => message({ ':message-type': 'exception', ':exception-type': type, ':content-type': 'application/json' },
  JSON.stringify({ message: 'arn:aws:iam::123456789012:role/x is refused' }));
const START = event('messageStart', { role: 'assistant' });
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' });

/** A request handler that answers the call with HTTP 200 and `chunks` as its body, which then fails with `fail` (a
 *  connection lost) or ends; or, with `refuse`, fails the call before any answer. */
function scripted({ chunks = [], fail, refuse }) {
  return {
    async handle() {
      if (refuse) throw refuse;
      const body = Readable.from((async function* () {
        for (const chunk of chunks) yield chunk;
        if (fail) throw fail;
      })(), { objectMode: false });
      return { response: { statusCode: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'stub' }, body } };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() { return {}; },
    destroy() {},
  };
}

async function call(script) {
  const facts = [];
  const bridge = createBedrockFetch({ region: REGION, model: MODEL, auth: { bearerToken: `ABSK${'k'.repeat(28)}` },
    sdk: { BedrockRuntimeClient, ConverseStreamCommand }, clientOptions: { requestHandler: scripted(script) }, report: fact => facts.push(fact) });
  const response = await bridge(ENDPOINT, REQUEST);
  const text = await response.text();
  assert.doesNotMatch(text, /arn:aws|123456789012/);
  const frames = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text.split('\n\n').filter(Boolean).map(frame => frame.replace(/^data: /, '')) : [];
  return { status: response.status, json: frames.length ? undefined : JSON.parse(text), frames, facts };
}
const lastError = frames => JSON.parse(frames.at(-1)).error;
const fact = (error, status, stage, upstream = true) => ({ event: 'failed', model: MODEL, error, status, stage, upstream });

test('through the real SDK, an answer streams as before', async () => {
  const done = await call({ chunks: [START, event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'OK' } }),
    event('messageStop', { stopReason: 'end_turn' }), event('metadata', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, metrics: { latencyMs: 1 } })] });
  assert.equal(done.status, 200);
  assert.equal(done.frames.at(-1), '[DONE]');
  assert.equal(done.frames.map(frame => frame === '[DONE]' ? '' : JSON.parse(frame).choices[0]?.delta?.content ?? '').join(''), 'OK');
  assert.deepEqual(done.facts, []);
});

test('through the real SDK, a stream AWS answered and lost before or after its first event is the stream\'s failure, inside a 200 and without a status', async () => {
  // Lost before its first event (the SDK reads it before `send` returns, and stamps the loss with AWS's 200), with its
  // first message cut off, and after it: each is a failure after AWS took the call.
  for (const [label, script] of [['before the first event', { fail: reset() }], ['in the first message', { chunks: [START.subarray(0, 20)], fail: reset() }],
    ['cut off in the first message', { chunks: [START.subarray(0, 20)] }], ['after the first event', { chunks: [START], fail: reset() }]]) {
    const lost = await call(script);
    assert.equal(lost.status, 200, label);
    assert.deepEqual(lastError(lost.frames), { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' }, label);
    assert.deepEqual(lost.facts, [fact('connection_error', 502, 'stream')], label);
  }
});

test('through the real SDK, AWS\'s own refusal as the stream opens keeps its status, and a call AWS never answered is refused before any stream', async () => {
  // A modelled exception (its name and status), and one the SDK does not model (AWS's code as the error's name: AWS's
  // failure, 502), as the stream's first event: answered before any stream, as before.
  const throttled = await call({ chunks: [exception('throttlingException')] });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.json.error.status, 429);
  assert.deepEqual(throttled.facts, [fact('ThrottlingException', 429, 'request')]);
  const unknown = await call({ chunks: [exception('someNewException')] });
  assert.equal(unknown.status, 502);
  assert.deepEqual(unknown.json.error, { message: 'The Bedrock request failed', type: 'api_error', code: 'api_error', status: 502 });
  assert.deepEqual(unknown.facts, [fact('api_error', 502, 'request')]);
  // A connection that never got AWS's answer is no stream at all: the response's own 502, as an outage before any work.
  const refused = await call({ refuse: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.json.error, { message: 'The Bedrock request failed', type: 'connection_error', code: 'connection_error' });
  assert.deepEqual(refused.facts, [fact('connection_error', 502, 'request')]);
});
