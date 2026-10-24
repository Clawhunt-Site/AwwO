import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bedrockFactLine } from '../bedrock-bridge.ts';
import { moduleGuardOptions, resolveBedrockAuth, workerEnvironment } from './runner.mjs';

// The cloud relay's worker side (docs/awwo-cloud-relay.md): AwwO 本地版 calls a Bedrock model through the hosted site,
// whose API has already admitted the call against the linked workspace and sends the person's Chat Completions request
// here as it came. This worker sends it to its own Bedrock model through the Converse bridge, in an isolated child as
// its runs' calls are (bedrock-relay.mjs), and streams the bridge's answer back as it comes: the API reads the usage
// from it to settle the call and passes the stream on to the person's computer.

export const RELAY_CHILD_URL = new URL('./bedrock-relay.mjs', import.meta.url);
/** The largest relay request: the API's own limit for a relayed call (16 MiB) and room for its envelope. */
export const RELAY_BODY_BYTES = 16 * 1024 * 1024 + 64 * 1024;
/** The most one relayed answer may stream. SSE framing costs far more than the text (computer-model.ts). */
const RELAY_STREAM_BYTES = 32 * 1024 * 1024;
/** Output a reader has not taken yet: past this the reader is let go, so a stalled one cannot hold this worker's memory. */
const RELAY_BACKLOG_BYTES = 4 * 1024 * 1024;

const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LABEL = /^[A-Za-z0-9_.:-]{1,120}$/;
const label = (value, fallback = 'unknown') => (typeof value === 'string' && LABEL.test(value) ? value : fallback);

/**
 * The person's request as the bridge takes it for this worker's model: the model's Converse id, streamed with its
 * usage, and no more output than the catalog lets the model write in one call (its limit where the request names none).
 * Everything else goes as it came: what the bridge cannot take faithfully it refuses (docs/awwo-bedrock.md), and the
 * API passes that refusal on to the person's computer. The operator's thinking budget is the planner's alone and is
 * never sent with a relayed call.
 */
export function relayBody(body, profile) {
  const out = { ...body, model: profile.model, stream: true, stream_options: { include_usage: true } };
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (Number.isSafeInteger(out[key]) && out[key] > profile.maxTokens) out[key] = profile.maxTokens;
  }
  if (out.max_tokens == null && out.max_completion_tokens == null) out.max_tokens = profile.maxTokens;
  return out;
}

async function readEnvelope(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > RELAY_BODY_BYTES) throw Object.assign(new Error('Relay request is too large'), { tooLarge: true });
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!plain(value) || Object.keys(value).some((key) => !['relayId', 'tenantId', 'model', 'body'].includes(key))) throw new Error('Invalid relay request');
  return value;
}

/**
 * Starts one relayed call in its isolated child: the credentials are resolved here (a profile's Bedrock key, or this
 * worker's AWS credential chain), and the child gets them and the request over private IPC, with no Node options and
 * only workerEnvironment's variables (AwwO 本地版's module guard aside). Rejects with `reason: 'request'` for a request
 * that cannot be written out again (one nested past what JSON.stringify can follow), and with `reason: 'credentials'`
 * when no credentials can be had, both before any directory or process exists; a child that cannot be sent its request
 * is stopped.
 */
export async function startRelayCall(profile, body, { auth = resolveBedrockAuth, childURL = RELAY_CHILD_URL } = {}) {
  let request;
  try { request = JSON.stringify(body); } catch { throw Object.assign(new Error('The relay request cannot be sent'), { reason: 'request' }); }
  let credentials;
  try { credentials = await auth(profile.apiKey); } catch { throw Object.assign(new Error('Bedrock credentials are unavailable'), { reason: 'credentials' }); }
  const directory = await mkdtemp(join(tmpdir(), 'awwo-pi-relay-'));
  let child;
  try {
    const guard = moduleGuardOptions();
    child = fork(childURL, [], { cwd: directory, env: { ...workerEnvironment(directory), ...guard.env }, execArgv: guard.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw Object.assign(new Error('The relay child could not start'), { reason: 'child-start' });
  }
  child.once('close', () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); });
  // A fork that fails afterwards says so as an 'error' event: heard here from the start, so a call cancelled before its
  // handler listens (the person's computer left while credentials resolved) never takes the worker down with it.
  child.on('error', () => {});
  try {
    child.send({ region: profile.region, model: profile.model, auth: credentials, promptCache: profile.promptCache === true,
      ...(profile.fallbackModel ? { fallbackModel: profile.fallbackModel } : {}),
      url: `${profile.baseURL.replace(/\/+$/, '')}/chat/completions`, body: request }, (error) => { if (error) child.kill('SIGKILL'); });
  } catch {
    child.kill('SIGKILL');
    throw Object.assign(new Error('The relay child could not be sent its request'), { reason: 'child-start' });
  }
  return child;
}

/**
 * POST /internal/relay-model: `{relayId, tenantId, model, body}`, where `model` is one of this worker's Bedrock models and
 * `body` the person's Chat Completions request (stream: true). The answer is the bridge's own: a refusal before any
 * stream as JSON with the bridge's status (`PROVIDER_REFUSED`, its error type, whether AWS answered, and for a request
 * the bridge cannot take its own words), or 200 with its `chat.completion.chunk` stream. A failure after the stream
 * began is an SSE error frame (the bridge's, or this worker's: `timeout`, `output_limit`, `worker_lost`). The call takes
 * one of the relay's own slots (`active`, AWWO_PI_RELAY_MAX_CONCURRENCY), apart from the runs' (AWWO_PI_MAX_CONCURRENCY):
 * however many computers call through the hosted site, its own runs keep theirs. It ends at AWWO_PI_RELAY_TIMEOUT_MS.
 */
export async function handleRelayModel(request, response, { config, active, stopping, observe = () => () => {}, startCall = startRelayCall, graceMs = 2_000 }) {
  const received = performance.now();
  const named = {};
  const line = (fields) => console.error(JSON.stringify({ event: 'relay_model_call', ...named, ...fields, ms: Math.round(performance.now() - received) }));
  const refuse = (status, code, extra = {}) => {
    line({ status, code, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.type ? { type: extra.type } : {}) });
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { code, message: 'The relayed model request could not be completed.', ...extra } }));
  };
  // A worker serving personal connections has no Bedrock model to relay to (assertOperatorOnlyBedrock).
  if (!config.ready || stopping() || config.userCredentials) return refuse(503, 'RUNTIME_UNAVAILABLE');
  if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return refuse(415, 'INVALID_CONTENT_TYPE');
  // A full relay reads no body (Node discards what is left of it once the refusal is sent).
  if (active.size >= config.relayMaxConcurrency) return refuse(429, 'CAPACITY_EXCEEDED');
  let envelope;
  try { envelope = await readEnvelope(request); }
  catch (error) { return error?.tooLarge ? refuse(413, 'REQUEST_TOO_LARGE') : refuse(400, 'INVALID_INPUT'); }
  const { relayId, tenantId, model, body } = envelope;
  if (!identifier(relayId) || !identifier(tenantId) || typeof model !== 'string' || !plain(body)) return refuse(400, 'INVALID_INPUT');
  named.relayId = relayId;
  named.model = label(model, 'invalid');
  const profile = config.models.find((item) => item.provider === 'bedrock' && item.id === model);
  if (!profile) return refuse(400, 'MODEL_NOT_FOUND');
  if (body.stream !== true) return refuse(400, 'STREAM_REQUIRED');
  if (response.destroyed) return;
  const key = `relay:${relayId}`;
  if (stopping()) return refuse(503, 'RUNTIME_UNAVAILABLE');
  if (active.has(key)) return refuse(409, 'RUN_BUSY');
  if (active.size >= config.relayMaxConcurrency) return refuse(429, 'CAPACITY_EXCEEDED');

  // The slot is taken before anything is awaited, so a burst of calls cannot pass the worker's limit.
  // fellBack: the bridge turned to the model's other profile (a fact the child told), so whatever follows is the second
  // request's, never one made before any work: said with the stream (x-awwo-relay-fallback) or with a refusal.
  let child, timer, release, streamed = 0, cut = '', finished = false, fellBack = false;
  const entry = { handle: { cancel: () => stop(stopping() ? 'stopping' : 'cancelled') }, cancelRequested: false, released: new Promise((resolve) => { release = resolve; }) };
  active.set(key, entry);
  const observed = observe(profile, request.headers.traceparent);
  const finish = (outcome, fields = {}) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    response.off('close', disconnected);
    active.delete(key);
    release();
    observed({ type: outcome, observability: { usage: { status: 'unavailable' }, timing: { workerTotalMs: Math.round(performance.now() - received) } } });
    line({ status: response.statusCode, outcome, bytes: streamed, ...fields });
  };
  // Ends a stream that already began with this worker's own error frame, after whatever line the child left open.
  const frame = (type) => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`\n\ndata: ${JSON.stringify({ error: { message: 'The relayed model call did not complete.', type, code: type } })}\n\n`);
      response.end();
    }
  };
  function stop(why) {
    cut ||= why;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, graceMs).unref();
    }
  }
  function disconnected() { if (!response.writableEnded) stop('disconnected'); }
  response.once('close', disconnected);
  timer = setTimeout(() => {
    stop('timeout');
    if (response.headersSent) frame('timeout'); else refuse(504, 'TIMEOUT');
    finish('failed', { reason: 'timeout' });
  }, config.relayTimeoutMs);
  timer.unref();

  try { child = await startCall(profile, relayBody(body, profile)); }
  catch (error) {
    if (error?.reason === 'credentials') refuse(503, 'MODEL_AUTHENTICATION');
    else if (error?.reason === 'request') refuse(400, 'INVALID_INPUT');
    else refuse(502, 'PROVIDER_ERROR', { reason: label(error?.reason, 'child-start') });
    return finish('failed', { reason: label(error?.reason, 'child-start') });
  }
  if (cut) { stop(cut); if (!finished) { refuse(499, 'CANCELLED', { reason: cut }); finish('cancelled', { reason: cut }); } return; }

  child.on('message', (message) => {
    if (!plain(message)) return;
    if (message.type === 'fact') {
      // A switch to the model's other profile, or a failure by AWS error type: for this worker's log only, rebuilt out of
      // closed labels (bedrockFactLine), never relayed.
      if (plain(message.fact) && message.fact.event === 'fallback') fellBack = true;
      const fact = bedrockFactLine('awwo-pi-worker', relayId, message.fact);
      if (fact) console.error(fact);
      return;
    }
    if (finished) return;
    if (message.type === 'refused' && !response.headersSent) {
      const status = Number.isInteger(message.status) && message.status >= 400 && message.status <= 599 ? message.status : 502;
      const error = plain(message.error) ? message.error : {};
      // fallback: the refusal came from the model's other profile, after its first profile refused the call (for
      // capacity, which may follow work): two requests, so never one made before any work.
      refuse(status, 'PROVIDER_REFUSED', { type: label(error.type), upstream: error.upstream === true, ...(error.fallback === true || fellBack ? { fallback: true } : {}),
        ...(typeof error.message === 'string' ? { detail: error.message.slice(0, 300) } : {}) });
      return finish('failed', { reason: `refused:${status}` });
    }
    if (message.type === 'failed') {
      if (response.headersSent) frame('worker_error'); else refuse(502, 'PROVIDER_ERROR', { reason: label(message.reason) });
      return finish('failed', { reason: label(message.reason) });
    }
    if (message.type === 'data' && typeof message.text === 'string') {
      if (!response.headersSent) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
          ...(fellBack ? { 'x-awwo-relay-fallback': '1' } : {}) });
        response.flushHeaders();
      }
      streamed += Buffer.byteLength(message.text);
      if (streamed > RELAY_STREAM_BYTES) { stop('output_limit'); frame('output_limit'); return finish('failed', { reason: 'output_limit' }); }
      response.write(message.text);
      if (response.writableLength > RELAY_BACKLOG_BYTES) { stop('backlog'); response.destroy(); return finish('cancelled', { reason: 'backlog' }); }
      return;
    }
    if (message.type === 'end') {
      if (!response.headersSent) { refuse(502, 'PROVIDER_ERROR', { reason: 'empty' }); return finish('failed', { reason: 'empty' }); }
      response.end();
      return finish('completed');
    }
  });
  child.once('error', () => {
    if (finished) return;
    if (response.headersSent) frame('worker_lost'); else refuse(502, 'PROVIDER_ERROR', { reason: 'child-error' });
    finish('failed', { reason: 'child-error' });
  });
  child.once('close', (code, signal) => {
    if (finished) return;
    const how = signal ?? code;
    if (cut) {
      if (response.headersSent) frame(cut === 'disconnected' ? 'cancelled' : cut); else refuse(499, 'CANCELLED', { reason: cut });
      return finish('cancelled', { reason: cut });
    }
    if (response.headersSent) frame('worker_lost'); else refuse(502, 'PROVIDER_ERROR', { reason: `child-exit:${how}` });
    finish('failed', { reason: `child-exit:${how}` });
  });
}
