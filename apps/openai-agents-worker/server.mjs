import { authorizeWorkspace, WORKSPACE_BODY_BYTES } from './workspace-protocol.ts';
import { createWorkspaceSandbox } from './workspace-sandbox.ts';
import { bindUserModel } from '../user-models.ts';
import { createWorkerObservability } from './observability.mjs';
import { parentObservability, normalizeUsage } from './usage.mjs';
import { handleComputerModel } from '../computer-model.ts';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { authorizeEffort, authorizeOutputContract, authorizeTools, fitsContextBudget, INPUT_LIMITS, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';
import { failureEvent, sanitizeErrorDiagnostic } from './errors.mjs';

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

async function readBody(request, limit = INPUT_LIMITS.bodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function probeWorkspace(config, signal) {
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'health', runId: 'startup' }, signal);
  try {
    const result = await sandbox.exec('node --version && python3 --version', { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error('Workspace probe failed');
  } finally { await sandbox.close(); }
}

export function createOpenAIAgentsServer(config, { startRun = startIsolatedRun, workspaceProbe = probeWorkspace } = {}) {
  const active = new Map();
  const sessions = new Set();
  const observability = createWorkerObservability(config, () => active.size);
  let shuttingDown = false;
  let workspaceAvailable = false;
  const probeAbort = new AbortController();
  const workspaceReady = config.workspace
    ? workspaceProbe(config.workspace, probeAbort.signal).then(() => { workspaceAvailable = true; }, () => { workspaceAvailable = false; })
    : Promise.resolve();
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return json(response, 400, { error: { code: 'INVALID_REQUEST_TARGET', message: 'Invalid HTTP request target.' } });
    }
    if (request.method === 'GET' && pathname === '/health') {
      const health = publicHealth(config, active.size, workspaceAvailable);
      if (shuttingDown) { health.ready = false; health.status = 'stopping'; }
      return json(response, health.ready ? 200 : 503, health);
    }
    if (!authorized(request, config.token)) return json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Internal service authentication required.' } });
    if (request.method === 'POST' && pathname === '/internal/computer-model') return handleComputerModel(request, response, {
      config, runtime: 'openai-agents', active, sessions, stopping: () => shuttingDown,
      resolveModel: resolveModelConfig, normalizeUsage, parentObservability, observe: (model, trace) => observability.begin(model, trace),
    });
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
    try { body = await readBody(request, config.workspace ? WORKSPACE_BODY_BYTES : INPUT_LIMITS.bodyBytes); } catch {
      if (!response.destroyed) json(response, 400, { error: { code: 'INVALID_INPUT', message: 'Invalid or oversized run request.' } });
      return;
    }
    if (response.destroyed) return;
    if (shuttingDown) return json(response, 503, { error: { code: 'RUNTIME_UNAVAILABLE', message: 'The worker is stopping.' } });
    try { authorizeTools(config, body); } catch {
      return json(response, 400, { error: { code: 'TOOL_DENIED', message: 'Select only tools enabled by the service.' } });
    }
    try { authorizeWorkspace(config.workspace, body); } catch {
      return json(response, 400, { error: { code: 'WORKSPACE_UNAVAILABLE', message: 'Project workspace execution is not configured.' } });
    }
    if (body.workspace && !workspaceAvailable) return json(response, 503, { error: {
      code: 'WORKSPACE_UNAVAILABLE', message: 'The project sandbox is not ready. Restore the configured container service before retrying.',
    } });
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
    // Reasoning activity is a count the caller opts in to with a header. A caller that
    // predates it never asks, so it keeps receiving exactly the stream it always did.
    const reasoningActivity = request.headers['x-awwo-run-activity'] === 'reasoning';
    const release = (result) => {
      if (result?.workspaceCleanupFailed) workspaceAvailable = false;
      active.delete(body.runId); sessions.delete(sessionKey); clearInterval(heartbeat); resolveReleased();
    };
    let runDiagnostic;
    const diagnose = (value) => { runDiagnostic = sanitizeErrorDiagnostic(value); };
    const emit = (event) => {
      // Diagnostics are for the trusted service log only. Revalidate after IPC
      // and strip them before metrics/SSE; never log an Error or arbitrary child data.
      if (event.type === 'failed') {
        const diagnostic = sanitizeErrorDiagnostic(runDiagnostic);
        const failure = failureEvent(event.code);
        console.error(JSON.stringify({ service: 'awwo-openai-agents-worker', runId: body.runId, code: failure.code, ...(diagnostic ? { diagnostic } : {}) }));
        event = { ...failure, ...(event.observability ? { observability: event.observability } : {}) };
      }
      observed(event);
      if (event.type === 'reasoning' && !reasoningActivity) return;
      if (response.destroyed || response.writableEnded) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      // A slow client must not create an unbounded process-memory queue.
      if (response.writableLength > (body.workspace ? WORKSPACE_BODY_BYTES : 1_048_576)) { entry.cancelRequested = true; entry.handle?.cancel(); response.destroy(); }
      if (['completed', 'failed', 'cancelled'].includes(event.type)) response.end();
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
      entry.handle = await startRun({ config: runConfig, request: body, onEvent: emit, onExit: release, onDiagnostic: diagnose });
      if (entry.cancelRequested || response.destroyed) entry.handle.cancel();
    } catch {
      if (body.workspace) workspaceAvailable = false;
      release();
      emit({ type: 'failed', code: 'WORKER_ERROR', message: 'The model worker could not start.', observability: parentObservability(undefined, { totalMs: 0, outcome: 'failed' }) });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server, observability, workspaceReady,
    async close() {
      shuttingDown = true;
      probeAbort.abort();
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
      await workspaceReady;
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
