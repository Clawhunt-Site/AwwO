// The render worker's internal HTTP service. Only the AwwO API calls it, with the shared bearer token:
//   GET    /health                              readiness and limits (no token)
//   POST   /internal/renders                    one render, answered when it is done (JSON with base64 outputs)
//   DELETE /internal/renders/{id}               stops the render in progress
//   POST   /internal/edits                      an edit job from its manifest (edit-timeline.mjs) → 201
//   PUT    /internal/edits/{id}/files/{index}   one of its files, raw bytes → 204
//   POST   /internal/edits/{id}/render          renders it, answered when it is done (JSON report + output list)
//   GET    /internal/edits/{id}/outputs/{name}  one output file
//   DELETE /internal/edits/{id}                 stops and removes the job
// One render or one edit job holds the worker at a time; another is refused with 429 rather than queued, so the
// API's own queue stays the only one. A caller that disconnects stops its render; an edit job left without a
// request for config.editIdleMs is removed.
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { LIMITS, loadConfig, validateRenderRequest } from './config.mjs';
import { EditRequestError, createJob, jobOutput, publicOutputs, receiveFile, removeJob, renderJob, streamOutput, sweepStale } from './edit-jobs.mjs';
import { EditError } from './edit-run.mjs';
import { EDIT_LIMITS, validateEditManifest } from './edit-timeline.mjs';
import { findExecutable } from './ffmpeg.mjs';
import { renderPage } from './render.mjs';

const EDIT_PATH = /^\/internal\/edits(?:\/([A-Za-z0-9_-]{8,80})(?:\/(files|outputs)\/([A-Za-z0-9_.-]{1,200})|\/(render))?)?$/;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function fail(response, status, code, message, extra = {}) {
  json(response, status, { error: { code, message, ...extra } });
}

function authorized(request, token) {
  if (token.length < 32) return false;
  const received = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** What /health reports. ready needs the token, the browser, ffmpeg and ffprobe. */
export function publicHealth(config, busy, exists = findExecutable) {
  const chrome = exists(config.chrome);
  const ffmpeg = exists(config.ffmpeg) && exists(config.ffprobe);
  return {
    ready: config.ready && chrome && ffmpeg,
    service: 'awwo-render',
    version: 1,
    chrome,
    ffmpeg,
    sandbox: config.chromeSandbox,
    limits: {
      maxSeconds: config.maxSeconds, maxFps: LIMITS.maxFps, maxWidth: LIMITS.maxWidth, maxHeight: LIMITS.maxHeight,
      maxFrames: LIMITS.maxFrames, maxHtmlBytes: LIMITS.maxHtmlBytes,
      edit: { maxSeconds: config.editMaxSeconds, maxInputBytes: config.editMaxInputBytes, maxFiles: EDIT_LIMITS.maxFiles },
    },
    busy,
  };
}

// A body over the limit is read to its end and discarded before the 413 is sent: answering while the caller is
// still sending can reset the connection and lose the answer. Past DISCARD_BYTES the connection is dropped.
const DISCARD_BYTES = 64 * 1024 * 1024;

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= limit) chunks.push(chunk);
      else if (chunks.length) chunks.length = 0;
      if (bytes > DISCARD_BYTES) request.destroy();
    });
    request.on('end', () => {
      if (bytes > limit) reject(Object.assign(new Error('Request body too large'), { code: 'TOO_LARGE' }));
      else resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => reject(error));
    request.on('close', () => { if (!request.complete) reject(Object.assign(new Error('Client went away'), { code: 'CLIENT_GONE' })); });
  });
}

export function createRenderServer(config, { render = renderPage, exists = findExecutable, edit } = {}) {
  let active = null;
  let stopping = false;

  async function handleRender(request, response, slot) {
    const media = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (media !== 'application/json') {
      return fail(response, 400, 'INVALID_RENDER', 'Content-Type must be application/json.', { field: 'contentType' });
    }
    let raw;
    try {
      raw = await readBody(request, LIMITS.maxBodyBytes);
    } catch (error) {
      if (error.code !== 'TOO_LARGE' || response.destroyed) return;
      return fail(response, 413, 'TOO_LARGE', 'The render request is larger than 8 MiB.');
    }
    request.setTimeout(0); // the body is in; the render's own limit is config.timeoutMs
    let renderRequest;
    try {
      renderRequest = validateRenderRequest(JSON.parse(raw.toString('utf8')), { maxSeconds: config.maxSeconds });
    } catch (error) {
      const field = error.field ?? 'body';
      return fail(response, 400, 'INVALID_RENDER', error.field ? error.message : 'The body is not valid JSON.', { field });
    }
    slot.renderId = renderRequest.renderId;
    const onClose = () => { if (!response.writableFinished) slot.controller.abort(); };
    response.on('close', onClose);
    try {
      const reply = await render(renderRequest, config, { signal: slot.controller.signal });
      if (!response.destroyed) json(response, 200, reply);
    } catch (error) {
      if (response.destroyed) return;
      const status = error?.status === 503 ? 503 : 422;
      const code = status === 503 ? 'RENDER_UNAVAILABLE' : 'RENDER_FAILED';
      fail(response, status, code, typeof error?.message === 'string' ? error.message : 'The render failed.', { detail: error?.detail ?? 'render_failed' });
    } finally {
      response.off('close', onClose);
    }
  }

  const logLine = (message) => process.stderr.write(`${message}\n`);
  // The edit job holding the slot, if it is the one named; and its idle clock, which runs only between requests.
  const editFor = (id) => (active?.kind === 'edit' && active.editId === id ? active : null);
  function armIdle(job) {
    clearTimeout(job.idleTimer);
    if (active !== job || job.requests > 0 || job.state === 'rendering') return;
    job.idleTimer = setTimeout(() => {
      if (active !== job || job.requests > 0 || job.state === 'rendering') return;
      removeJob(job, logLine).finally(() => { if (active === job) active = null; });
    }, config.editIdleMs);
    job.idleTimer.unref?.();
  }
  async function withJob(job, work) {
    job.requests += 1;
    clearTimeout(job.idleTimer);
    try {
      return await work();
    } finally {
      job.requests -= 1;
      armIdle(job);
    }
  }
  function editFailure(response, error) {
    if (response.destroyed || response.headersSent) return;
    if (error instanceof EditRequestError) {
      const { status, code, message, ...extra } = error;
      return fail(response, status, code, message, extra);
    }
    if (error?.code === 'INVALID_EDIT') return fail(response, 400, 'INVALID_EDIT', error.message, { field: error.field ?? 'timeline' });
    // The worker's own words only (EditError): an unexpected error's message may name paths on this disk.
    const known = error instanceof EditError;
    const status = known && error.status === 503 ? 503 : 422;
    fail(response, status, status === 503 ? 'EDIT_UNAVAILABLE' : 'EDIT_FAILED', known ? error.message : 'The edit failed.', { detail: known ? error.detail : 'edit_failed' });
  }

  async function createEdit(request, response) {
    const media = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (media !== 'application/json') return fail(response, 400, 'INVALID_EDIT', 'Content-Type must be application/json.', { field: 'contentType' });
    let manifest;
    try {
      manifest = validateEditManifest(JSON.parse((await readBody(request, EDIT_LIMITS.maxManifestBytes)).toString('utf8')), { maxInputBytes: config.editMaxInputBytes });
    } catch (error) {
      if (error.code === 'CLIENT_GONE' || response.destroyed) return;
      if (error.code === 'TOO_LARGE') return fail(response, 413, 'TOO_LARGE', 'The edit manifest is larger than 4 MiB.');
      return fail(response, 400, 'INVALID_EDIT', error.field ? error.message : 'The body is not valid JSON.', { field: error.field ?? 'body' });
    }
    if (stopping || !publicHealth(config, false, exists).ready) return fail(response, 503, 'EDIT_UNAVAILABLE', 'The render worker is not ready.', { detail: 'not_ready' });
    if (active) return fail(response, 429, 'WORKER_BUSY', 'A render or an edit is already in progress.');
    let job;
    try {
      job = await createJob(manifest, config);
    } catch (error) {
      return editFailure(response, error);
    }
    if (active) {
      await removeJob(job);
      return fail(response, 429, 'WORKER_BUSY', 'A render or an edit is already in progress.');
    }
    active = job;
    armIdle(job);
    json(response, 201, { editId: job.editId, files: job.files.length, expiresInSeconds: Math.round(config.editIdleMs / 1000) });
  }

  async function putFile(job, index, request, response) {
    const media = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (media !== 'application/octet-stream') return fail(response, 400, 'INVALID_EDIT', 'Content-Type must be application/octet-stream.', { field: 'contentType' });
    if (!/^\d{1,3}$/.test(index)) return fail(response, 404, 'EDIT_FILE_NOT_FOUND', 'The job has no such file.');
    await withJob(job, async () => {
      try {
        await receiveFile(job, Number(index), request);
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
      } catch (error) {
        editFailure(response, error);
      }
    });
  }

  async function renderEdit(job, response) {
    await withJob(job, async () => {
      const onClose = () => { if (!response.writableFinished) job.controller.abort(); };
      response.on('close', onClose);
      try {
        const result = await renderJob(job, config, { log: logLine, ...(edit ? { run: edit } : {}) });
        if (!response.destroyed) json(response, 200, { editId: job.editId, report: result.report, outputs: publicOutputs(result.outputs) });
      } catch (error) {
        editFailure(response, error);
      } finally {
        response.off('close', onClose);
      }
    });
  }

  async function getOutput(job, name, response) {
    await withJob(job, async () => {
      let output;
      try {
        output = jobOutput(job, name);
      } catch (error) {
        return editFailure(response, error);
      }
      response.writeHead(200, { 'Content-Type': output.contentType, 'Content-Length': String(output.size), 'Cache-Control': 'no-store' });
      await pipeline(streamOutput(output), response).catch(() => response.destroy());
    });
  }

  async function handleEdit(request, response, match) {
    const [, id, part, name, render] = match;
    if (!id) return request.method === 'POST' ? createEdit(request, response) : fail(response, 404, 'NOT_FOUND', 'Route not found.');
    const job = editFor(id);
    if (!job) return fail(response, 404, 'EDIT_NOT_FOUND', 'No such edit job.');
    if (request.method === 'PUT' && part === 'files') return putFile(job, name, request, response);
    if (request.method === 'POST' && render) {
      request.setTimeout(0); // the render takes as long as it takes; its own limit is config.editTimeoutMs
      return renderEdit(job, response);
    }
    if (request.method === 'GET' && part === 'outputs') return getOutput(job, name, response);
    if (request.method === 'DELETE' && !part && !render) {
      // The slot is free only once a render in progress has stopped and the job's files are gone.
      await removeJob(job, logLine);
      if (active === job) active = null;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    return fail(response, 404, 'NOT_FOUND', 'Route not found.');
  }

  async function handle(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return fail(response, 400, 'INVALID_REQUEST_TARGET', 'Invalid HTTP request target.');
    }
    // A request that goes quiet for a minute (an upload that stalls) is dropped; the long-running routes switch it off.
    request.setTimeout(60_000, () => request.destroy());
    if (request.method === 'GET' && pathname === '/health') {
      const health = publicHealth(config, active !== null, exists);
      if (stopping) health.ready = false;
      return json(response, health.ready ? 200 : 503, health);
    }
    if (!authorized(request, config.token)) return fail(response, 401, 'UNAUTHORIZED', 'Internal service authentication required.');
    const edit = EDIT_PATH.exec(pathname);
    if (edit) return handleEdit(request, response, edit);
    const cancel = /^\/internal\/renders\/([A-Za-z0-9_-]{8,80})$/.exec(pathname);
    if (request.method === 'DELETE' && cancel) {
      if (!active || active.renderId !== cancel[1]) return fail(response, 404, 'RENDER_NOT_FOUND', 'No such render is in progress.');
      active.controller.abort();
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'POST' || pathname !== '/internal/renders') return fail(response, 404, 'NOT_FOUND', 'Route not found.');
    if (stopping || !publicHealth(config, false, exists).ready) {
      return fail(response, 503, 'RENDER_UNAVAILABLE', 'The render worker is not ready (token, browser or ffmpeg missing).');
    }
    if (active) return fail(response, 429, 'RENDER_BUSY', 'A render is already in progress.');
    const slot = { renderId: null, controller: new AbortController() };
    active = slot;
    try {
      await handleRender(request, response, slot);
    } finally {
      if (active === slot) active = null;
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) fail(response, 500, 'INTERNAL', 'Internal error.');
      else response.destroy();
    });
  });
  // No limit on a whole request: a large file's upload may take minutes. Quiet sockets are dropped (handle()).
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    server,
    busy: () => active !== null,
    async close() {
      stopping = true;
      active?.controller.abort();
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      // A render clears the slot when it ends; an edit job is removed once it is no longer rendering.
      while (active && !(active.kind === 'edit' && active.state !== 'rendering')) await new Promise((resolve) => setTimeout(resolve, 50));
      if (active?.kind === 'edit') {
        const job = active;
        active = null;
        await removeJob(job);
      }
      server.closeAllConnections();
      await stopped;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createRenderServer(config);
  // Nothing runs yet: what a stopped worker left in its temporary root (a crash, an OOM kill) is removed first.
  await sweepStale(config, (message) => process.stderr.write(`${message}\n`));
  app.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ host: config.host, port: config.port, ...publicHealth(config, false) }));
  });
  app.server.on('error', () => { console.error('Render worker could not listen on its configured address.'); process.exitCode = 1; });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
