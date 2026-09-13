import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderObserver, emptyUsage, normalizeUsage, parentObservability } from './usage.mjs';

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
