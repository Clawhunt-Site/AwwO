// Content-free facts only. The SDK's synthesized defaults are never usage evidence.
export const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'providerTotalTokens', 'computedTotalTokens']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failureStatus = value => Number.isInteger(value) && value >= 400 && value <= 599;
export function emptyUsage(status = 'unavailable', reason = 'provider_missing') {
  return { status, source: 'none', reason, ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, null])) };
}
// Whether a provider's usage counts anything (a token read or written, a cost: a positive number, or words that are one,
// anywhere in it, its arrays included): the provider read the request. Usage whose objects or arrays nest past 64
// levels is taken to count. As the JavaScript worker's twin (openai-agents-worker/usage.mjs) counts it.
function countsWork(usage, depth = 0) {
  if (typeof usage === 'number' || typeof usage === 'string') return Number(usage) > 0;
  if (!usage || typeof usage !== 'object') return false;
  return depth > 64 || Object.values(usage).some(value => countsWork(value, depth + 1));
}
// Whether a refusal's body carries anything of the work it refused, anywhere in it (its error, a provider's own
// envelope, a detail under either): usage that counts anything (usage, usage_metadata or Gemini's usageMetadata), or
// any of an answer (Chat Completions, Responses, Anthropic, Gemini), as the JavaScript worker's twin reads it. A body is
// at most 64 KiB here, and one whose objects or arrays nest past 64 levels is taken to carry work.
function carriesWork(value, depth = 0) {
  const answer = item => item != null && item !== '' && !(Array.isArray(item) && item.length === 0) && !(object(item) && Object.keys(item).length === 0);
  if (!value || typeof value !== 'object') return false;
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some(item => carriesWork(item, depth + 1));
  return ['usage', 'usage_metadata', 'usageMetadata'].some(key => countsWork(value[key], depth + 1))
    || ['choices', 'output', 'content', 'candidates'].some(key => answer(value[key]))
    || Object.values(value).some(item => carriesWork(item, depth + 1));
}
// The provider's own words in a refusal's body, as the JavaScript worker reads them from its SDK's error (the body's
// error field, which that SDK keeps alone): the error's message, or the error itself where it is only words, its code
// and its type. Never anything else in the body, where a provider may echo words of the request.
function providerWords(body) {
  const error = object(body) ? body.error : undefined;
  const words = typeof error === 'string' ? [error] : object(error) ? [error.message, error.code, error.type] : [];
  return words.filter(item => typeof item === 'string');
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

// The parser observes the existing response stream without cloning/tee buffering (a refusal's body alone, unless it is
// typed a stream, is read once beside the SDK through a tee). Oversized/invalid telemetry is ignored; original bytes
// always reach the SDK.
export function createProviderObserver(protocol, { now = () => performance.now(), fetchImpl = globalThis.fetch, acceptedAtNs } = {}) {
  const born = now();
  let setupMs, started, ended, first, raw, complete = false, invalidFrame = false;
  // The call's requests (the agent library retries LLM Gate once), its last answer if that was a refusal (its status,
  // whether its body was JSON that carries no work, and the provider's own words in it), and the reads of refusal bodies
  // not yet done.
  let requests = 0, refusal, unsettled = false;
  // The status the call's last request failed with, where the provider gave one (failureStatus): its answer's, when that
  // was a refusal, or the one an error frame inside its stream carried.
  let refusedStatus, frameStatus;
  const reads = [];
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
      // An error frame inside a stream that answered 200, which the OpenAI SDKs raise with no status of their own: the
      // status it carries, as the Bedrock bridge's frame does for an AWS failure (bedrock-bridge.ts errorBody).
      if (object(value.error) && failureStatus(value.error.status)) frameStatus = value.error.status;
    }
  }
  // A refusal's body (any type but a stream: the SDK reads any as JSON it can) is read to its end beside the SDK, through
  // a tee whose other half the SDK reads unchanged, at most 64 KiB of it (counted in bytes) kept and never relayed:
  // refusal says whether it was JSON that carries no work (a body past 64 KiB, or not JSON, cannot say so), and the
  // provider's own words in it. settled() waits for these reads. A tee's half cancelled alone waits for the other's read
  // (the body is let go only once both are), so the SDK's half cancels this read too: an SDK done with the body before
  // its end is never held up by it, and a body cut short so cannot say it carries no work.
  function readRefusal(response) {
    const [mine, theirs] = response.body.tee();
    const answer = refusal = { status: response.status, clean: false, words: [] };
    const reader = mine.getReader(), source = theirs.getReader();
    let dropped = false;
    reads.push((async () => {
      const decoder = new TextDecoder();
      let text = '', bytes = 0;
      try {
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          if ((bytes += next.value.byteLength) > 65_536) { await reader.cancel(); return; }
          text += decoder.decode(next.value, { stream: true });
        }
        if (dropped) return;
        const value = JSON.parse(text + decoder.decode());
        answer.clean = object(value) && !carriesWork(value);
        answer.words = providerWords(value);
      } catch { /* a body that is not JSON, or breaks off, says nothing */ }
    })());
    const body = new ReadableStream({
      async pull(controller) {
        const next = await source.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      cancel(reason) {
        dropped = true;
        return Promise.all([source.cancel(reason), reader.cancel(reason)]).then(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  function observe(response) {
    refusedStatus = response.ok ? undefined : response.status;
    const stream = Boolean(response.body && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'));
    // An HTTP 4xx or 5xx is a refusal (a status past 599, which fetch passes through, could make no Response to read it
    // through: it reaches the SDK as it came, typed a stream or not). One typed a stream has its usage read as any
    // stream's, which a 429 or 5xx answered at once is charged by (plans.go creditCharge), and cannot say it carries no
    // work.
    if (response.status >= 400 && response.status <= 599 && response.body && !stream) { ended ??= now(); return readRefusal(response); }
    refusal = response.ok ? undefined : { status: response.status, clean: false, words: [] };
    if (!stream || response.status > 599) { ended ??= now(); return response; }
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
      requests += 1;
      refusedStatus = frameStatus = undefined;
      if (started === undefined) {
        started = now();
        setupMs = typeof acceptedAtNs === 'string' && /^[0-9]{1,30}$/.test(acceptedAtNs) ? Math.max(0, Number((process.hrtime.bigint() - BigInt(acceptedAtNs)) / 1_000_000n)) : Math.max(0, Math.floor(started - born));
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const name of ['traceparent', 'tracestate', 'baggage']) headers.delete(name);
      try { return observe(await fetchImpl(input, { ...init, headers, redirect: 'error' })); }
      catch (error) { ended ??= now(); throw error; }
    },
    // Whether the call was refused before any work: its one request answered with a 400, 413 or 422 (never a stream:
    // work may come before a refusal inside one, and a refusal typed a stream cannot say it carries none), in a body
    // that was JSON and carries no work. Read after settled().
    refusedBeforeAnyWork() {
      return requests === 1 && !unsettled && refusal?.clean === true && [400, 413, 422].includes(refusal.status);
    },
    // The provider's own words in the call's last refusal (providerWords: its error's message, code and type), which the
    // child reads for a refusal of the request as too large (pi-task.mjs) and which never leave it; none for a refusal
    // whose body was not JSON, was typed a stream or came without one. Read after settled().
    refusalWords() {
      return refusal?.words ?? [];
    },
    // The status the provider failed the call's last request with, where it gave one: the HTTP status of its refusal,
    // else the one an error frame inside its stream carried. Undefined for a request that ended any other way (a stream
    // that broke off, a transport failure), and for one that answered, unless such a frame came.
    failureStatus() {
      return failureStatus(refusedStatus) ? refusedStatus : frameStatus;
    },
    // Waits for every refusal body's read (readRefusal), at most 2 s: one still unread then cannot say it carries no work.
    async settled() {
      let timer;
      const read = await Promise.race([Promise.all(reads).then(() => true), new Promise(resolve => { timer = setTimeout(resolve, 2000, false); })]);
      clearTimeout(timer);
      if (!read) unsettled = true;
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
