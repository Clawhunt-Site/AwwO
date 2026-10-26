import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createProviderObserver, emptyUsage, normalizeUsage, parentObservability } from './usage.mjs';

/** `leaf` (an empty object unless given) inside `depth` objects nested one in another. */
const nested = (depth, leaf = {}) => { let value = leaf; for (let level = 0; level < depth; level++) value = { detail: value }; return value; };

test('provider missing, explicit zero, partial, cache and reasoning have distinct accounting meanings', () => {
  assert.equal(normalizeUsage(undefined, 'chat_completions').status, 'unavailable');
  const zero = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 'chat_completions');
  assert.equal(zero.status, 'reported'); assert.equal(zero.inputTokens, 0); assert.equal(zero.cachedInputTokens, null);
  const partial = normalizeUsage({ prompt_tokens: 23 }, 'chat_completions');
  assert.equal(partial.status, 'partial'); assert.equal(partial.outputTokens, null); assert.equal(partial.computedTotalTokens, null);
  const cached = normalizeUsage({ input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 5 } }, 'responses');
  assert.equal(cached.status, 'reported'); assert.equal(cached.computedTotalTokens, 30); assert.equal(cached.reasoningTokens, 5); assert.equal(cached.cachedInputTokens, 7);
  const anthropic = normalizeUsage({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, 'anthropic');
  assert.equal(anthropic.inputTokens, 30); assert.equal(anthropic.computedTotalTokens, 40); assert.equal(anthropic.providerTotalTokens, null);
  for (const value of [-1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1]) assert.equal(normalizeUsage({ prompt_tokens: value, completion_tokens: 3 }, 'chat_completions').status, 'invalid');
  assert.equal(normalizeUsage({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 9 }, 'chat_completions').reason, 'total_mismatch');
  assert.equal(normalizeUsage({ prompt_tokens: 4, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } }, 'chat_completions').status, 'invalid');
});

test('raw stream observer preserves original chunks, strips W3C only and uses monotonic provider timing', async () => {
  let time = 100, received;
  const original = 'data: {"choices":[{"delta":{"content":"private-output"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7},"choices":[]}\n\ndata: [DONE]\n\n';
  const observer = createProviderObserver('chat_completions', { now: () => time, fetchImpl: async (_input, init) => {
    received = init;
    return new Response(new ReadableStream({ start(controller) {
      time = 145; controller.enqueue(new TextEncoder().encode(original.slice(0, 31))); controller.enqueue(new TextEncoder().encode(original.slice(31))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  time = 120;
  const response = await observer.fetch('http://127.0.0.1/provider', { headers: { authorization: 'Bearer private-key', traceparent: 'client-parent', tracestate: 'private-trace', baggage: 'private-user' } });
  assert.equal(await response.text(), original);
  assert.equal(received.headers.get('authorization'), 'Bearer private-key');
  for (const key of ['traceparent', 'tracestate', 'baggage']) assert.equal(received.headers.get(key), null);
  const observation = observer.snapshot('completed');
  assert.equal(observation.usage.status, 'reported'); assert.equal(observation.usage.computedTotalTokens, 7);
  assert.deepEqual(observation.timing, { setupMs: 20, providerMs: 25, providerTtftMs: 25 });
  assert.ok(!JSON.stringify(observation).includes('private'));
});

test('usage survives unsuccessful response and an interrupted Anthropic stream is partial', async () => {
  const observe = async (protocol, frames, outcome) => {
    const observer = createProviderObserver(protocol, { fetchImpl: async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } }) });
    await (await observer.fetch('http://127.0.0.1/provider')).text();
    return observer.snapshot(outcome);
  };
  const failed = await observe('responses', 'data: {"type":"response.failed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n', 'failed');
  assert.equal(failed.usage.status, 'reported'); assert.equal(failed.usage.computedTotalTokens, 5);
  assert.equal(failed.timing.providerTtftMs, null);
  const partial = await observe('anthropic', 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n', 'cancelled');
  assert.equal(partial.usage.status, 'partial'); assert.equal(partial.usage.inputTokens, 10);
  const lost = await observe('chat_completions', 'data: {"choices":[]}\n\n', 'cancelled');
  assert.equal(lost.usage.status, 'unknown'); assert.equal(lost.usage.inputTokens, null);
});

test('parent cannot leak child metadata, zero cost or secret error fields and missing usage remains unknown', () => {
  const child = { version: 1, usage: { ...emptyUsage(), cost: 0, apiKey: 'private-key' }, timing: { setupMs: 5, providerMs: 999, providerTtftMs: 2 }, prompt: 'private-prompt' };
  const result = parentObservability(child, { totalMs: 20.6, firstDeltaMs: 10.2, outcome: 'failed' });
  assert.equal(result.timing.workerTotalMs, 20); assert.equal(result.timing.providerMs, null); assert.equal(result.timing.workerFirstDeltaMs, 10);
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('cost'));
  assert.equal(parentObservability(undefined, { totalMs: 10, outcome: 'cancelled' }).usage.status, 'unknown');
  assert.equal(parentObservability({ version: 1, usage: { status: 'reported', source: 'provider_raw', inputTokens: 1 } }, { totalMs: 10, outcome: 'completed' }).usage.status, 'invalid');
});

test('oversized telemetry cannot buffer without bound or change business response bytes', async () => {
  const text = `data: ${'x'.repeat(1_048_600)}\ndata: [DONE]\n\n`;
  const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(await (await observer.fetch('http://127.0.0.1/provider')).text(), text);
  assert.equal(observer.snapshot('completed').usage.status, 'invalid');
});

for (const separator of ['\n', '\r\n', '\r']) test(`multiline SSE usage survives byte fragmentation and ${JSON.stringify(separator)} separators`, async () => {
  for (const protocol of ['chat_completions', 'responses', 'anthropic']) {
    const values = protocol === 'chat_completions' ? [{ usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }, choices: [] }]
      : protocol === 'responses' ? [{ type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }]
      : [{ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_stop' }];
    const body = ': heartbeat' + separator + separator + values.map(value => JSON.stringify(value, null, 2).split('\n').map(line => 'data: ' + line).join(separator) + separator + separator).join('') + 'data: [DONE]' + separator + separator;
    const bytes = new TextEncoder().encode(body);
    const observer = createProviderObserver(protocol, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const result = await observer.fetch('http://127.0.0.1/provider');
    assert.equal(await result.text(), body);
    const usage = observer.snapshot('completed').usage;
    assert.equal(usage.status, 'reported'); assert.equal(usage.inputTokens, 4); assert.equal(usage.outputTokens, 3); assert.equal(usage.computedTotalTokens, 7);
  }
});

test('many small data lines share a bounded SSE event budget', async () => {
  const body = 'data: ' + 'x'.repeat(1024) + '\n';
  const text = body.repeat(1025) + '\ndata: [DONE]\n\n';
  const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(await (await observer.fetch('http://127.0.0.1/provider')).text(), text);
  assert.equal(observer.snapshot('completed').usage.status, 'invalid');
});

test('of every status from 400 to 599, only a 400 or 413 refuses a call before any work, as in the other workers', async () => {
  const refusal = JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length is 131072 tokens' } });
  const before = [];
  for (let status = 400; status <= 599; status += 1) {
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(refusal, { status, headers: { 'content-type': 'application/json' } }) });
    await (await observer.fetch('http://127.0.0.1/provider')).text();
    await observer.settled();
    if (observer.refusedBeforeAnyWork()) before.push(status);
  }
  assert.deepEqual(before, [400, 413]);
});

test('a call is refused before any work only by an HTTP 400 or 413 to its one request in a JSON body that carries no work', async () => {
  const json = { 'content-type': 'application/json' };
  const refusal = JSON.stringify({ error: { code: 'context_length_exceeded' } });
  for (const [body, status, headers, before] of [
    [refusal, 400, json, true],
    [refusal, 413, { 'content-type': 'Application/JSON' }, true],
    // Read whatever its type says, as the SDKs read it.
    [refusal, 400, { 'content-type': 'text/plain' }, true],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [] }), 400, json, true],
    // Work anywhere in the body, as the JavaScript worker's twin looks for it: usage beside or inside its error or under
    // a detail of it, under usage_metadata or usageMetadata, or any of an answer; and a body nested past 64 levels. An
    // empty detail carries nothing.
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { prompt_tokens: 11 } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', usage: { input_tokens: 0, cache: { read: 3 } } } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', details: { usage: { prompt_tokens: 123 } } } }), 400, json, false],
    // Inside usage, anywhere: deeper than one object, in an array, in words that are a number.
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { cache: { tokens: { read: 123 } } } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { counts: [0, 0, 7] } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { prompt_tokens: '11' } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: { cache: { tokens: { read: 0 } }, counts: [0], total: '0', model: 'm1' } }), 400, json, true],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage_metadata: { promptTokenCount: 7 } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usageMetadata: { promptTokenCount: 7 } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, choices: [{ message: { content: 'answer' } }] }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', output: [{ type: 'reasoning' }] } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', details: [[{ candidates: [{ index: 0 }] }]] } }), 400, json, false],
    [`{"error":{"code":"context_length_exceeded","details":${'['.repeat(70)}{}${']'.repeat(70)}}}`, 400, json, false],
    [`{"error":{"code":"context_length_exceeded","details":${'['.repeat(50)}{}${']'.repeat(50)}}}`, 400, json, true],
    // (the body is level 0, its error 1, the details 2: nested(63) puts an object at level 65) Words or a number below
    // the last object read count as nothing, in a detail or in usage.
    [JSON.stringify({ error: { code: 'context_length_exceeded', details: nested(63) } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', details: nested(62) } }), 400, json, true],
    [JSON.stringify({ error: { code: 'context_length_exceeded', details: nested(63, 'words') } }), 400, json, true],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: nested(64, 0) }), 400, json, true],
    [JSON.stringify({ error: { code: 'context_length_exceeded' }, usage: nested(70) }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', requestId: '', details: {} } }), 400, json, true],
    // A body that cannot say so: not JSON, or past 64 KiB, counted in bytes (under it, a body is read whole); or JSON typed
    // a stream, in any letters, whose usage is read as a stream's instead.
    [refusal.slice(0, -1), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x'.repeat(70_000) } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', message: '漢'.repeat(30_000) } }), 400, json, false],
    [JSON.stringify({ error: { code: 'context_length_exceeded', message: '漢'.repeat(21_000) } }), 400, json, true],
    [refusal, 400, { 'content-type': 'text/event-stream' }, false],
    [refusal, 413, { 'content-type': 'Text/Event-Stream; charset=utf-8' }, false],
    // Another status (a 422 as in the other workers: owner 2026-10-25), and a stream that answered 200 whatever came
    // inside it.
    [refusal, 422, json, false],
    [refusal, 429, json, false],
    [`data: ${refusal}\n\n`, 200, { 'content-type': 'text/event-stream' }, false],
  ]) {
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(body, { status, headers }) });
    const response = await observer.fetch('http://127.0.0.1/provider');
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type'), headers['content-type']);
    assert.equal(await response.text(), body);
    await observer.settled();
    assert.equal(observer.refusedBeforeAnyWork(), before, `${status} ${body.slice(0, 80)}`);
  }
  // A call sent twice (a retry) may have done work in its first attempt.
  let sent = 0;
  const twice = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(sent++ ? refusal : 'busy', { status: sent === 1 ? 503 : 400, headers: json }) });
  await (await twice.fetch('http://127.0.0.1/provider')).text();
  await (await twice.fetch('http://127.0.0.1/provider')).text();
  await twice.settled();
  assert.equal(twice.refusedBeforeAnyWork(), false);
  // A body the SDK never reads is read all the same; one that never ends cannot say so, after 2 s.
  const unread = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(refusal, { status: 400 }) });
  await unread.fetch('http://127.0.0.1/provider');
  await unread.settled();
  assert.equal(unread.refusedBeforeAnyWork(), true);
  const endless = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); } }), { status: 400 }) });
  await endless.fetch('http://127.0.0.1/provider');
  const started = performance.now();
  await endless.settled();
  assert.ok(performance.now() - started >= 1900);
  assert.equal(endless.refusedBeforeAnyWork(), false);
});

test('a refusal\'s words are the provider\'s own, read from its body\'s error alone: its message, code and type', async () => {
  const json = { 'content-type': 'application/json' };
  for (const [body, words] of [
    [{ error: { message: 'maximum context length', code: 'context_length_exceeded', type: 'invalid_request_error', param: 'messages' } },
      ['maximum context length', 'context_length_exceeded', 'invalid_request_error']],
    // Anthropic's shape, and an error that is only words.
    [{ type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum size' } }, ['Request exceeds the maximum size', 'request_too_large']],
    [{ error: 'prompt is too long' }, ['prompt is too long']],
    // Nothing else in the body, where a provider may echo words of the request: not a detail of its error, not a word
    // beside it, not a message outside it, and no words that are not text.
    [{ error: { code: 'invalid_request', details: { prompt: 'Explain maximum context length' } }, echo: 'prompt is too long' }, ['invalid_request']],
    [{ message: 'maximum context length', detail: 'prompt is too long' }, []],
    [{ error: { message: { text: 'prompt is too long' }, code: 400, type: null } }, []],
    [[{ error: 'prompt is too long' }], []],
  ]) {
    const text = JSON.stringify(body);
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(text, { status: 400, headers: json }) });
    assert.equal(await (await observer.fetch('http://127.0.0.1/provider')).text(), text);
    await observer.settled();
    assert.deepEqual(observer.refusalWords(), words, text);
  }
  // None for a refusal whose body was not JSON, was typed a stream or came without one, nor for an answer.
  for (const answer of [
    () => new Response('{"error":"prompt is too long"', { status: 400, headers: json }),
    () => new Response('{"error":"prompt is too long"}', { status: 400, headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(null, { status: 400 }),
    () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  ]) {
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => answer() });
    await (await observer.fetch('http://127.0.0.1/provider')).text();
    await observer.settled();
    assert.deepEqual(observer.refusalWords(), []);
  }
  // A request answered after a refusal leaves no words of it.
  let sent = 0;
  const answered = createProviderObserver('chat_completions', { fetchImpl: async () => sent++ ? new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : new Response('{"error":"prompt is too long"}', { status: 400, headers: json }) });
  await (await answered.fetch('http://127.0.0.1/provider')).text();
  await (await answered.fetch('http://127.0.0.1/provider')).text();
  await answered.settled();
  assert.deepEqual(answered.refusalWords(), []);
  assert.deepEqual(createProviderObserver('chat_completions').refusalWords(), []);
});

test('a refusal typed a stream keeps the usage it reports and the status it failed with, and is never refused before any work', async () => {
  const frames = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } })}\n\n`;
  for (const [status, type] of [[400, 'text/event-stream'], [429, 'Text/Event-Stream'], [503, 'text/event-stream; charset=utf-8']]) {
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(frames, { status, headers: { 'content-type': type } }) });
    const response = await observer.fetch('http://127.0.0.1/provider');
    assert.equal(response.status, status);
    assert.equal(await response.text(), frames);
    await observer.settled();
    const usage = observer.snapshot('failed').usage;
    assert.deepEqual([usage.status, usage.inputTokens, usage.outputTokens], ['partial', 17, 3], String(status));
    assert.equal(observer.failureStatus(), status);
    assert.equal(observer.refusedBeforeAnyWork(), false);
  }
  // An answer streamed in any letters has its usage read too.
  const answer = `${frames}data: [DONE]\n\n`;
  const shouted = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(answer, { headers: { 'content-type': 'TEXT/EVENT-STREAM' } }) });
  assert.equal(await (await shouted.fetch('http://127.0.0.1/provider')).text(), answer);
  assert.deepEqual([shouted.snapshot('completed').usage.status, shouted.snapshot('completed').usage.computedTotalTokens], ['reported', 20]);
});

test('a status past 599, which fetch passes through and no Response can be made with, reaches the SDK as it came', async () => {
  // As fetch hands one on, typed a stream or not.
  for (const type of ['application/json', 'text/event-stream']) {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"prompt is too long"}}')); controller.close(); } });
    const odd = { ok: false, status: 600, statusText: '', headers: new Headers({ 'content-type': type }), body };
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => odd });
    assert.equal(await observer.fetch('http://127.0.0.1/provider'), odd, type);
    await observer.settled();
    assert.equal(observer.refusedBeforeAnyWork(), false);
    assert.deepEqual(observer.refusalWords(), []);
    assert.equal(observer.failureStatus(), undefined);
  }
  // And from a real server, through the real fetch.
  const server = createServer((_req, res) => { res.writeHead(600, { 'content-type': 'application/json' }); res.end('{"error":{"message":"prompt is too long"}}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const observer = createProviderObserver('chat_completions');
    const response = await observer.fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 600);
    assert.equal(await response.text(), '{"error":{"message":"prompt is too long"}}');
    await observer.settled();
    assert.equal(observer.refusedBeforeAnyWork(), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the SDK done with a refusal\'s body before its end lets it go at once, and a body so cut short says nothing', async () => {
  const json = { 'content-type': 'application/json' };
  let letGo;
  const released = new Promise(resolve => { letGo = resolve; });
  // A whole refusal so far, in a body that has not ended.
  const trickle = () => new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"code":"context_length_exceeded"}}')); },
    cancel() { letGo(); },
  });
  const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(trickle(), { status: 400, headers: json }) });
  const response = await observer.fetch('http://127.0.0.1/provider');
  // The observer has read what came so far.
  for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setImmediate(resolve));
  // A tee's half cancelled alone would wait for the other's read, which waits for a body that never ends; and the body
  // itself is let go.
  const within = (promise, ms) => Promise.race([promise.then(() => 'done'), new Promise(resolve => setTimeout(resolve, ms, 'held'))]);
  assert.equal(await within(response.body.cancel('done with it'), 1000), 'done');
  assert.equal(await within(released, 1000), 'done');
  await observer.settled();
  assert.equal(observer.refusedBeforeAnyWork(), false);
  assert.deepEqual(observer.refusalWords(), []);
  // A body read to its end before the SDK lets its half go keeps what it said.
  const refusal = '{"error":{"code":"context_length_exceeded"}}';
  const whole = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(refusal, { status: 400, headers: json }) });
  const kept = await whole.fetch('http://127.0.0.1/provider');
  await whole.settled();
  await kept.body.cancel();
  assert.equal(whole.refusedBeforeAnyWork(), true);
  assert.deepEqual(whole.refusalWords(), ['context_length_exceeded']);
  // The SDK reads the bytes it always did, and a break in the body reaches it.
  const broken = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); controller.error(new TypeError('terminated')); },
  }), { status: 400, headers: json }) });
  await assert.rejects((await broken.fetch('http://127.0.0.1/provider')).text(), /terminated/);
  await broken.settled();
  assert.equal(broken.refusedBeforeAnyWork(), false);
});

test('a call failed with the status of its last request: its refusal, else an error frame that carries one', async () => {
  const json = { 'content-type': 'application/json' };
  const stream = { 'content-type': 'text/event-stream' };
  const frame = error => `data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: ${JSON.stringify({ error })}\n\n`;
  for (const [body, status, headers, failed] of [
    ['{"error":{"type":"rate_limit_error"}}', 429, json, 429],
    ['{"error":{"type":"overloaded"}}', 503, json, 503],
    // With no body, and with one that is not JSON.
    [null, 502, json, 502],
    ['<html>Forbidden</html>', 403, { 'content-type': 'text/html' }, 403],
    // An error frame inside a stream that answered 200: the status the Bedrock bridge carries in one, and none for a
    // frame without it, or with one out of range or not a number.
    [frame({ type: 'ServiceUnavailableException', status: 503 }), 200, stream, 503],
    [frame({ type: 'ThrottlingException', status: 429 }), 200, stream, 429],
    [frame({ type: 'api_error' }), 200, stream, undefined],
    [frame({ type: 'odd', status: 200 }), 200, stream, undefined],
    [frame({ type: 'odd', status: '503' }), 200, stream, undefined],
    [frame('503'), 200, stream, undefined],
    // An answer that finished, and one that is not a stream.
    ['data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', 200, stream, undefined],
    ['{"choices":[]}', 200, json, undefined],
  ]) {
    const observer = createProviderObserver('chat_completions', { fetchImpl: async () => new Response(body, { status, headers }) });
    assert.equal(observer.failureStatus(), undefined);
    const response = await observer.fetch('http://127.0.0.1/provider');
    assert.equal(await response.text(), body ?? '');
    assert.equal(observer.failureStatus(), failed, `${status} ${String(body).slice(0, 80)}`);
  }
  // Only the last request says: a refusal answered on its retry, an outage after a refusal, a refusal after a broken
  // stream, and a request that never got an answer.
  const answers = [
    () => new Response('{}', { status: 429, headers: json }),
    () => new Response('data: [DONE]\n\n', { headers: stream }),
    () => new Response(frame({ status: 503 }), { headers: stream }),
    () => new Response('{}', { status: 401, headers: json }),
    () => { throw new TypeError('fetch failed'); },
  ];
  const expected = [429, undefined, 503, 401, undefined];
  let call = 0;
  const retried = createProviderObserver('chat_completions', { fetchImpl: async () => answers[call++]() });
  for (const status of expected) {
    try { await (await retried.fetch('http://127.0.0.1/provider')).text(); } catch { /* the last request gets no answer */ }
    assert.equal(retried.failureStatus(), status);
  }
});
