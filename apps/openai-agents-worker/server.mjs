import { bindUserModel } from '../user-models.ts';
import { createWorkerObservability } from './observability.mjs';
import { parentObservability } from './usage.mjs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { authorizeEffort, authorizeOutputContract, authorizeTools, fitsContextBudget, INPUT_LIMITS, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request, token) {
  if (token.length < 32) return false;
  const received = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMITS.bodyBytes) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createOpenAIAgentsServer(config, { startRun = startIsolatedRun } = {}) {
  const active = new Map();
  const sessions = new Set();
  const observability = createWorkerObservability(config, () => active.size);
  let shuttingDown = false;
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return json(response, 400, { error: { code: 'INVALID_REQUEST_TARGET', message: 'Invalid HTTP request target.' } });
    }
    if (request.method === 'GET' && pathname === '/health') {
      const health = publicHealth(config, active.size);
      if (shuttingDown) { health.ready = false; health.status = 'stopping'; }
      return json(response, health.ready ? 200 : 503, health);
    }
    if (!authorized(request, config.token)) return json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Internal service authentication required.' } });
    if (request.method === 'DELETE' && /^\/internal\/runs\/[A-Za-z0-9_-]+$/.test(pathname)) {
      const entry = active.get(pathname.slice('/internal/runs/'.length));
      if (!entry) return json(response, 404, { error: { code: 'RUN_NOT_FOUND', message: 'Run not found.' } });
      entry.cancelRequested = true;
      entry.handle?.cancel();
      return json(response, 202, { status: 'cancelling' });
    }
    if (request.method !== 'POST' || pathname !== '/internal/runs') return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    if (!config.ready || shuttingDown) return json(response, 503, { error: { code: 'RUNTIME_UNAVAILABLE', message: 'A real model provider and internal token must be configured.' } });
    if ((request.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim() !== 'application/json') {
      return json(response, 415, { error: { code: 'INVALID_CONTENT_TYPE', message: 'Content-Type must be application/json.' } });
    }
    let body;
    try { body = await readBody(request); } catch {
      if (!response.destroyed) json(response, 400, { error: { code: 'INVALID_INPUT', message: 'Invalid or oversized run request.' } });
      return;
    }
    if (response.destroyed) return;
    if (shuttingDown) return json(response, 503, { error: { code: 'RUNTIME_UNAVAILABLE', message: 'The worker is stopping.' } });
    try { authorizeTools(config, body); } catch {
      return json(response, 400, { error: { code: 'TOOL_DENIED', message: 'Select only tools enabled by the service.' } });
    }
    let runConfig;
    try { runConfig = bindUserModel(config, body, 'openai-agents'); } catch {
      return json(response, 400, { error: { code: 'PERSONAL_CREDENTIAL_REQUIRED', message: 'A verified personal model connection is required.' } });
    }
    let modelConfig;
    try { modelConfig = resolveModelConfig(runConfig, body.model); } catch {
      return json(response, 400, { error: { code: 'MODEL_NOT_FOUND', message: 'Select a model from the configured model catalog.' } });
    }
    try { authorizeEffort(modelConfig, body); } catch {
      return json(response, 400, { error: { code: 'EFFORT_NOT_SUPPORTED', message: 'Select a reasoning effort the configured model advertises, or none.' } });
    }
    // Refused before any session, capacity slot or child process is taken.
    try { authorizeOutputContract(modelConfig, body); } catch {
      return json(response, 400, { error: { code: 'OUTPUT_CONTRACT_NOT_SUPPORTED', message: 'Select a model whose profile enables structured delivery output, or send no output contract.' } });
    }
    if (!fitsContextBudget(body, modelConfig)) return json(response, 413, { error: {
      code: 'CONTEXT_LIMIT', message: 'The prompt and history exceed the configured model context budget. Shorten the conversation or configure a model with a larger supported context window.',
    } });
    const sessionKey = `${body.tenantId}:${body.sessionId}`;
    if (active.has(body.runId)) return json(response, 409, { error: { code: 'RUN_BUSY', message: 'This run is already active.' } });
    // This distinct rejection guarantees the submitted run was never accepted.
    // Go may wait for an older cancelled run's teardown and retry this request.
    if (sessions.has(sessionKey)) return json(response, 409, { error: { code: 'SESSION_BUSY', message: 'This conversation is still active or being cleaned up.' } });
    if (active.size >= config.maxConcurrency) return json(response, 429, { error: { code: 'CAPACITY_EXCEEDED', message: 'The model worker is at capacity.' } });
    let resolveReleased;
    const entry = { handle: undefined, cancelRequested: false, released: new Promise(resolve => { resolveReleased = resolve; }) };
    const observed = observability.begin(modelConfig, request.headers.traceparent);
    active.set(body.runId, entry);
    sessions.add(sessionKey);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const release = () => { active.delete(body.runId); sessions.delete(sessionKey); clearInterval(heartbeat); resolveReleased(); };
    const emit = (event) => {
      observed(event);
      if (response.destroyed || response.writableEnded) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      // A slow client must not create an unbounded process-memory queue.
      if (response.writableLength > 1_048_576) { entry.cancelRequested = true; entry.handle?.cancel(); response.destroy(); }
      if (event.type !== 'text_delta') response.end();
    };
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();
    response.once('close', () => {
      clearInterval(heartbeat);
      if (!response.writableEnded) { entry.cancelRequested = true; entry.handle?.cancel(); }
    });
    try {
      entry.handle = await startRun({ config: runConfig, request: body, onEvent: emit, onExit: release });
      if (entry.cancelRequested || response.destroyed) entry.handle.cancel();
    } catch {
      release();
      emit({ type: 'failed', code: 'WORKER_ERROR', message: 'The model worker could not start.', observability: parentObservability(undefined, { totalMs: 0, outcome: 'failed' }) });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server, observability,
    async close() {
      shuttingDown = true;
      const stopped = new Promise((resolve) => server.close(resolve));
      const waits = [];
      for (const entry of active.values()) {
        entry.cancelRequested = true;
        entry.handle?.cancel();
        // Include runs whose asynchronous temp-directory/fork setup has not
        // returned a handle yet. Their cancellation is applied after launch.
        waits.push(entry.released);
      }
      await Promise.allSettled(waits);
      server.closeAllConnections();
      await stopped;
      await observability.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createOpenAIAgentsServer(config);
  await app.observability.listen();
  app.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ service: 'awwo-openai-agents-worker', host: config.host, port: config.port, ...publicHealth(config) }));
  });
  app.server.on('error', () => { console.error('OpenAI Agents worker could not listen on its configured address.'); process.exitCode = 1; });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
