// The render worker's internal HTTP service. Only the AwwO API calls it, with the shared bearer token:
//   GET    /health                    readiness and limits (no token)
//   POST   /internal/renders          one render, answered when it is done (JSON with base64 outputs)
//   DELETE /internal/renders/{id}     stops the render in progress
// One render runs at a time; another is refused with 429 rather than queued, so the API's own queue stays the
// only one. A caller that disconnects stops its render.
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { LIMITS, loadConfig, validateRenderRequest } from './config.mjs';
import { findExecutable } from './ffmpeg.mjs';
import { renderPage } from './render.mjs';

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

export function createRenderServer(config, { render = renderPage, exists = findExecutable } = {}) {
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

  async function handle(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return fail(response, 400, 'INVALID_REQUEST_TARGET', 'Invalid HTTP request target.');
    }
    if (request.method === 'GET' && pathname === '/health') {
      const health = publicHealth(config, active !== null, exists);
      if (stopping) health.ready = false;
      return json(response, health.ready ? 200 : 503, health);
    }
    if (!authorized(request, config.token)) return fail(response, 401, 'UNAUTHORIZED', 'Internal service authentication required.');
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
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return {
    server,
    busy: () => active !== null,
    async close() {
      stopping = true;
      active?.controller.abort();
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      while (active) await new Promise((resolve) => setTimeout(resolve, 50));
      server.closeAllConnections();
      await stopped;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createRenderServer(config);
  app.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ host: config.host, port: config.port, ...publicHealth(config, false) }));
  });
  app.server.on('error', () => { console.error('Render worker could not listen on its configured address.'); process.exitCode = 1; });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
