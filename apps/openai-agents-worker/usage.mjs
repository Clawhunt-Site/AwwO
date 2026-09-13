// Content-free facts only. The SDK's synthesized defaults are never usage evidence.
export const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'providerTotalTokens', 'computedTotalTokens']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function emptyUsage(status = 'unavailable', reason = 'provider_missing') {
  return { status, source: 'none', reason, ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, null])) };
}
export function normalizeUsage(raw, protocol, complete = true) {
  if (!object(raw)) return emptyUsage();
  const result = { ...emptyUsage(), source: 'provider_raw' };
  let invalid = false, present = 0;
  const field = (key, value) => {
    if (value === undefined || value === null) return;
    present++;
    if (!integer(value)) invalid = true;
    else result[key] = value;
  };
  if (protocol === 'anthropic') {
    field('inputTokens', raw.input_tokens);
    field('outputTokens', raw.output_tokens);
    field('cachedInputTokens', raw.cache_read_input_tokens);
    field('cacheWriteTokens', raw.cache_creation_input_tokens);
    // Anthropic's input_tokens excludes cache categories. Missing optional cache
    // categories are absent, while their stored values remain null (never fake 0).
    if (result.inputTokens !== null) result.inputTokens += (result.cachedInputTokens ?? 0) + (result.cacheWriteTokens ?? 0);
    field('providerTotalTokens', raw.total_tokens);
  } else {
    const chat = protocol === 'chat_completions';
    field('inputTokens', raw[chat ? 'prompt_tokens' : 'input_tokens']);
    field('outputTokens', raw[chat ? 'completion_tokens' : 'output_tokens']);
    field('cachedInputTokens', raw[chat ? 'prompt_tokens_details' : 'input_tokens_details']?.cached_tokens);
    field('reasoningTokens', raw[chat ? 'completion_tokens_details' : 'output_tokens_details']?.reasoning_tokens);
    field('providerTotalTokens', raw.total_tokens);
  }
  if (result.inputTokens !== null && result.outputTokens !== null) result.computedTotalTokens = result.inputTokens + result.outputTokens;
  if (TOKEN_FIELDS.some(key => result[key] !== null && !integer(result[key]))
    || (result.cachedInputTokens !== null && result.inputTokens !== null && result.cachedInputTokens > result.inputTokens)
    || (result.reasoningTokens !== null && result.outputTokens !== null && result.reasoningTokens > result.outputTokens)) invalid = true;
  const mismatch = result.providerTotalTokens !== null && result.computedTotalTokens !== null && result.providerTotalTokens !== result.computedTotalTokens;
  for (const key of TOKEN_FIELDS) if (result[key] !== null && !integer(result[key])) result[key] = null;
  result.status = invalid || mismatch ? 'invalid' : !present ? 'unavailable' : complete && result.computedTotalTokens !== null ? 'reported' : 'partial';
  result.reason = mismatch ? 'total_mismatch' : invalid ? 'protocol_invalid' : result.status === 'reported' ? 'none' : !present ? 'provider_missing' : 'field_missing';
  return result;
}

// The parser observes the existing response stream without cloning/tee buffering.
// Oversized/invalid telemetry is ignored; original bytes always reach the SDK.
export function createProviderObserver(protocol, { now = () => performance.now(), fetchImpl = globalThis.fetch, acceptedAtNs } = {}) {
  const born = now();
  let setupMs, started, ended, first, raw, complete = false, invalidFrame = false;
  function consume(value) {
    if (!object(value)) return;
    let found;
    if (protocol === 'anthropic') {
      if (value.type === 'message_start') found = value.message?.usage;
      if (value.type === 'message_delta') found = value.usage;
      if (object(found)) raw = { ...(raw ?? {}), ...found };
      if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta' && value.delta.text) first ??= now();
      if (value.type === 'message_stop') { ended ??= now(); complete = true; }
    } else if (protocol === 'responses') {
      if (value.type === 'response.output_text.delta' && value.delta) first ??= now();
      if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(value.type)) {
        if (object(value.response?.usage)) raw = value.response.usage;
        ended ??= now(); complete = true;
      }
    } else {
      if (value.choices?.some(choice => typeof choice.delta?.content === 'string' && choice.delta.content.length)) first ??= now();
      if (object(value.usage)) raw = value.usage;
    }
  }
  function observe(response) {
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { ended ??= now(); return response; }
    const decoder = new TextDecoder();
    let line = '', skipping = false, skipLF = false;
    let dataLines = [], frameBytes = 0, frameInvalid = false;
    const finishFrame = () => {
      if (!frameInvalid && dataLines.length) {
        const data = dataLines.join('\n');
        if (data.trim() === '[DONE]') { complete = true; ended ??= now(); }
        else if (data) { try { consume(JSON.parse(data)); } catch { /* SDK owns stream validation. */ } }
      }
      dataLines = []; frameBytes = 0; frameInvalid = false;
    };
    const finishLine = () => {
      if (!skipping) {
        if (line === '') finishFrame();
        else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          frameBytes += Buffer.byteLength(value) + 1;
          if (frameBytes > 1_048_576) { dataLines = []; frameInvalid = true; invalidFrame = true; }
          else if (!frameInvalid) dataLines.push(value);
        }
      }
      line = ''; skipping = false;
    };
    const append = part => {
      if (!skipping) line += part;
      if (line.length > 1_048_576) { line = ''; skipping = true; frameInvalid = true; invalidFrame = true; }
    };
    const inspect = text => {
      if (!text) return;
      // SSE joins all data lines within an event before parsing JSON. Handle
      // CR, LF and split CRLF boundaries without changing the SDK's byte stream.
      if (skipLF && text.startsWith('\n')) text = text.slice(1);
      skipLF = false;
      let offset = 0;
      for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        append(text.slice(offset, match.index)); finishLine();
        offset = match.index + match[0].length;
        skipLF = match[0] === '\r' && offset === text.length;
      }
      append(text.slice(offset));
    };
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        try { inspect(decoder.decode(chunk, { stream: true })); } catch { invalidFrame = true; }
        controller.enqueue(chunk);
      },
      flush() { try { inspect(decoder.decode()); finishLine(); finishFrame(); } catch { invalidFrame = true; } ended ??= now(); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return {
    async fetch(input, init) {
      if (started === undefined) {
        started = now();
        setupMs = typeof acceptedAtNs === 'string' && /^[0-9]{1,30}$/.test(acceptedAtNs) ? Math.max(0, Number((process.hrtime.bigint() - BigInt(acceptedAtNs)) / 1_000_000n)) : Math.max(0, Math.floor(started - born));
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const name of ['traceparent', 'tracestate', 'baggage']) headers.delete(name);
      try { return observe(await fetchImpl(input, { ...init, headers, redirect: 'error' })); }
      catch (error) { ended ??= now(); throw error; }
    },
    snapshot(outcome) {
      let usage = normalizeUsage(raw, protocol, complete);
      if (invalidFrame) usage = { ...usage, status: 'invalid', reason: 'protocol_invalid' };
      if (usage.status === 'unavailable' && started !== undefined && outcome !== 'completed') usage = emptyUsage('unknown', 'transport_unknown');
      const elapsed = (a, b) => a === undefined || b === undefined ? null : Math.max(0, Math.floor(b - a));
      return { version: 1, usage, timing: { setupMs: setupMs ?? null, providerMs: elapsed(started, ended), providerTtftMs: elapsed(started, first) } };
    },
  };
}

export function parentObservability(value, { totalMs, firstDeltaMs, outcome }) {
  // IPC is trusted code, but copy only declared fields. Never forward metadata,
  // provider errors or an SDK cost object across the internal terminal protocol.
  let usage = emptyUsage(outcome === 'completed' ? 'unavailable' : 'unknown', outcome === 'completed' ? 'provider_missing' : 'transport_unknown');
  if (value !== undefined && (value?.version !== 1 || !object(value.usage))) usage = emptyUsage('invalid', 'protocol_invalid');
  if (value?.version === 1 && object(value.usage)) {
    const candidate = value.usage;
    const statuses = ['reported', 'partial', 'unavailable', 'invalid', 'unknown'];
    const sources = ['provider_raw', 'sdk_normalized', 'none'];
    const reasons = ['none', 'legacy_worker', 'provider_missing', 'field_missing', 'transport_unknown', 'worker_lost', 'cancelled_after_admission', 'protocol_invalid', 'total_mismatch'];
    if (statuses.includes(candidate.status) && sources.includes(candidate.source)
      && TOKEN_FIELDS.every(key => candidate[key] === null || integer(candidate[key]))) {
      usage = { status: candidate.status, source: candidate.source, reason: reasons.includes(candidate.reason) ? candidate.reason : 'protocol_invalid', ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, candidate[key]])) };
    } else usage = emptyUsage('invalid', 'protocol_invalid');
  }
  const timing = { workerTotalMs: Math.max(0, Math.floor(totalMs)), workerFirstDeltaMs: firstDeltaMs === undefined ? null : Math.max(0, Math.floor(firstDeltaMs)) };
  for (const key of ['setupMs', 'providerMs', 'providerTtftMs']) {
    const n = value?.timing?.[key]; timing[key] = integer(n) && n <= timing.workerTotalMs ? n : null;
  }
  return { version: 1, usage, timing };
}
