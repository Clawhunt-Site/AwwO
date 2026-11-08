// The video analysis worker's internal HTTP service. Only the AwwO API calls it, with the shared bearer token:
//   GET    /health                                   readiness and limits (no token)
//   POST   /internal/analyses                        a job from its manifest (config.mjs) → 201
//   PUT    /internal/analyses/{id}/file              its video, raw bytes → 204
//   POST   /internal/analyses/{id}/run               analyses it, answered when done (report, summary, output list)
//   GET    /internal/analyses/{id}/outputs/{name}    one output file (name may be shots/…, packaging/… or stems/…)
//   DELETE /internal/analyses/{id}                   stops and removes the job
// One job holds the worker at a time; another is refused with 429 rather than queued, so the API's own queue stays the
// only one. A caller that disconnects from /run stops the analysis; a job left without a request for config.idleMs
// is removed.
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { LIMITS, loadConfig, validateAnalysisRequest } from './config.mjs';
import { findExecutable } from './children.mjs';
import { AnalysisError, verifyModels } from './analysis-run.mjs';
import { AnalysisRequestError, analyseJob, createJob, jobOutput, publicOutputs, receiveFile, removeJob, streamOutput, sweepStale } from './analysis-jobs.mjs';

const ANALYSIS_PATH = /^\/internal\/analyses(?:\/([A-Za-z0-9_-]{8,80})(?:\/(file|run)|\/outputs\/((?:shots\/|packaging\/|stems\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}))?)?$/;

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

function contentType(request) {
  return String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

/** What /health reports. ready needs the token, rea-video, ffprobe and ffmpeg on the children's PATH, and the models. */
export function publicHealth(config, busy, exists = findExecutable) {
  const rea = exists(config.rea, config.path);
  const ffmpeg = exists('ffmpeg', config.path) && exists(config.ffprobe, config.path);
  return {
    ready: config.ready && rea && ffmpeg && config.modelsOk,
    service: 'awwo-video-analysis',
    version: 1,
    rea,
    ffmpeg,
    models: config.modelsOk,
    limits: { maxInputBytes: config.maxInputBytes, maxSeconds: config.maxSeconds, maxSide: config.maxSide, timeoutMs: config.timeoutMs },
    busy,
  };
}

const DISCARD_BYTES = 1024 * 1024;

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

export function createAnalysisServer(config, { exists = findExecutable, run } = {}) {
  let active = null;
  let stopping = false;
  const logLine = (message) => process.stderr.write(`${message}\n`);
  const jobFor = (id) => (active?.analysisId === id ? active : null);

  function armIdle(job) {
    clearTimeout(job.idleTimer);
    if (active !== job || job.requests > 0 || job.state === 'analysing') return;
    job.idleTimer = setTimeout(() => {
      if (active !== job || job.requests > 0 || job.state === 'analysing') return;
      removeJob(job, logLine).finally(() => { if (active === job) active = null; });
    }, config.idleMs);
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
  function failure(response, error) {
    if (response.destroyed || response.headersSent) return;
    if (error instanceof AnalysisRequestError) {
      const { status, code, message, ...extra } = error;
      return fail(response, status, code, message, extra);
    }
    // The worker's own words only (AnalysisError): an unexpected error's message may name paths on this disk.
    if (error instanceof AnalysisError) {
      if (error.status === 400) return fail(response, 400, 'INVALID_ANALYSIS', error.message, { field: error.field ?? 'file', detail: error.detail });
      const status = error.status === 503 ? 503 : 422;
      return fail(response, status, status === 503 ? 'ANALYSIS_UNAVAILABLE' : 'ANALYSIS_FAILED', error.message, { detail: error.detail });
    }
    fail(response, 422, 'ANALYSIS_FAILED', 'The analysis failed.', { detail: 'analysis_failed' });
  }

  async function create(request, response) {
    if (contentType(request) !== 'application/json') return fail(response, 400, 'INVALID_ANALYSIS', 'Content-Type must be application/json.', { field: 'contentType' });
    let manifest;
    try {
      manifest = validateAnalysisRequest(JSON.parse((await readBody(request, LIMITS.maxManifestBytes)).toString('utf8')), config);
    } catch (error) {
      if (error.code === 'CLIENT_GONE' || response.destroyed) return;
      if (error.code === 'TOO_LARGE') return fail(response, 413, 'TOO_LARGE', 'The analysis manifest is larger than 64 KiB.');
      return fail(response, 400, 'INVALID_ANALYSIS', error.field ? error.message : 'The body is not valid JSON.', { field: error.field ?? 'body' });
    }
    if (stopping || !publicHealth(config, false, exists).ready) return fail(response, 503, 'ANALYSIS_UNAVAILABLE', 'The analysis worker is not ready.', { detail: 'not_ready' });
    if (active) return fail(response, 429, 'WORKER_BUSY', 'An analysis is already in progress.');
    let job;
    try {
      job = await createJob(manifest, config);
    } catch (error) {
      return failure(response, error);
    }
    if (active) {
      await removeJob(job);
      return fail(response, 429, 'WORKER_BUSY', 'An analysis is already in progress.');
    }
    active = job;
    armIdle(job);
    json(response, 201, { analysisId: job.analysisId, expiresInSeconds: Math.round(config.idleMs / 1000) });
  }

  async function putFile(job, request, response) {
    if (contentType(request) !== 'application/octet-stream') return fail(response, 400, 'INVALID_ANALYSIS', 'Content-Type must be application/octet-stream.', { field: 'contentType' });
    await withJob(job, async () => {
      try {
        await receiveFile(job, request);
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
      } catch (error) {
        failure(response, error);
      }
    });
  }

  async function runJob(job, response) {
    await withJob(job, async () => {
      const onClose = () => { if (!response.writableFinished) job.controller.abort(); };
      response.on('close', onClose);
      try {
        const result = await analyseJob(job, config, { log: logLine, ...(run ? { run } : {}) });
        if (!response.destroyed) json(response, 200, { analysisId: job.analysisId, report: result.report, summary: result.summary, outputs: publicOutputs(result.outputs) });
      } catch (error) {
        failure(response, error);
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
        return failure(response, error);
      }
      response.writeHead(200, { 'Content-Type': output.contentType, 'Content-Length': String(output.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      await pipeline(streamOutput(output), response).catch(() => response.destroy());
    });
  }

  async function handleAnalysis(request, response, match) {
    const [, id, action, name] = match;
    if (!id) return request.method === 'POST' ? create(request, response) : fail(response, 404, 'NOT_FOUND', 'Route not found.');
    const job = jobFor(id);
    if (!job) return fail(response, 404, 'ANALYSIS_NOT_FOUND', 'No such analysis job.');
    if (request.method === 'PUT' && action === 'file') return putFile(job, request, response);
    if (request.method === 'POST' && action === 'run') {
      request.setTimeout(0); // the analysis takes as long as it takes; its own limit is config.timeoutMs
      return runJob(job, response);
    }
    if (request.method === 'GET' && name) return getOutput(job, name, response);
    if (request.method === 'DELETE' && !action && !name) {
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
    request.setTimeout(60_000, () => request.destroy());
    if (request.method === 'GET' && pathname === '/health') {
      const health = publicHealth(config, active !== null, exists);
      if (stopping) health.ready = false;
      return json(response, health.ready ? 200 : 503, health);
    }
    if (!authorized(request, config.token)) return fail(response, 401, 'UNAUTHORIZED', 'Internal service authentication required.');
    const match = ANALYSIS_PATH.exec(pathname);
    if (match) return handleAnalysis(request, response, match);
    return fail(response, 404, 'NOT_FOUND', 'Route not found.');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) fail(response, 500, 'INTERNAL', 'Internal error.');
      else response.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    server,
    busy: () => active !== null,
    async close() {
      stopping = true;
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      if (active) {
        const job = active;
        active = null;
        await removeJob(job, logLine);
      }
      server.closeAllConnections();
      await stopped;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  config.modelsOk = await verifyModels(config);
  const app = createAnalysisServer(config);
  await sweepStale(config, (message) => process.stderr.write(`${message}\n`));
  app.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ host: config.host, port: config.port, ...publicHealth(config, false) }));
  });
  app.server.on('error', () => { console.error('Video analysis worker could not listen on its configured address.'); process.exitCode = 1; });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
