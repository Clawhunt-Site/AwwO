import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ManagedRun } from './runtime.ts';
import { coreInstalled, loadConfig, type WorkerConfig } from './config.ts';
import { UPSTREAM_REVISION } from './setup.ts';
import { WorkerError, LIMITS, json, parseAnswer, parseRun, readJSON, safeEqual, type WorkerEvent } from './protocol.ts';

const exec = promisify(execFile);
export function createWorkerServer(config: WorkerConfig) {
  const runs = new Map<string, { run: ManagedRun; done: Promise<void>; endedAt?: number }>();
  let stopping = false, healthAt = 0, ready = false, probing: Promise<boolean> | undefined;
  const health = async () => {
    if (!coreInstalled(config)) return false;
    if (Date.now() - healthAt < (ready ? 30_000 : 2000)) return ready;
    if (probing) return probing;
    probing = (async () => {
      try {
        const args = [...(config.sandbox.dockerContext ? ['--context', config.sandbox.dockerContext] : []), 'image', 'inspect', '--format', '{{.Id}}', config.sandbox.image];
        await exec(config.sandbox.dockerExecutable, args, { timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin:/usr/local/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
        ready = !stopping;
      } catch { ready = false; }
      healthAt = Date.now(); probing = undefined; return ready;
    })();
    return probing;
  };
  const server = createServer(async (req, res) => {
    try {
      if (!safeEqual(String(req.headers.authorization || ''), `Bearer ${config.token}`)) return json(res, 401, { error: 'UNAUTHORIZED' });
      if (req.headers.origin) return json(res, 403, { error: 'BROWSER_ACCESS_FORBIDDEN' });
      const url = new URL(req.url || '/', 'http://worker.local');
      if (req.method === 'GET' && url.pathname === '/health') {
        const available = await health();
        return json(res, available ? 200 : 503, { service: 'awwo-openmaus-worker', ready: available, configured: available, status: available ? 'ready' : 'unconfigured',
          ...(!available ? { reason: stopping ? 'worker_stopping' : !coreInstalled(config) ? 'core_not_installed' : 'workspace_unavailable' } : {}),
          capabilities: { workspace: true, approvals: true }, upstreamRevision: UPSTREAM_REVISION });
      }
      for (const [id, entry] of runs) if (entry.endedAt && Date.now() - entry.endedAt > 300_000) runs.delete(id);
      if (req.method === 'POST' && url.pathname === '/internal/runs') {
        if (stopping || !(await health())) throw new WorkerError('WORKER_NOT_READY', 503);
        if ([...runs.values()].filter(entry => !entry.endedAt).length >= config.maxConcurrent || runs.size >= 1000) throw new WorkerError('WORKER_BUSY', 429);
        const request = parseRun(await readJSON(req), config.proxyOrigins);
        // Validate admission again after the asynchronous body read.
        if (runs.has(request.runId)) throw new WorkerError('RUN_ALREADY_EXISTS', 409);
        if (stopping || [...runs.values()].filter(entry => !entry.endedAt).length >= config.maxConcurrent) throw new WorkerError('WORKER_BUSY', 429);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.flushHeaders();
        let bytes = 0, terminal = false;
        const emit = (event: WorkerEvent) => {
          if (res.destroyed || terminal) return;
          const final = ['completed', 'failed', 'cancelled'].includes(event.type);
          const text = `data: ${JSON.stringify(event)}\n\n`, length = Buffer.byteLength(text);
          if (length > LIMITS.event || bytes + length > LIMITS.events || res.writableLength > LIMITS.event) { run.cancel(); res.destroy(); throw new WorkerError('EVENT_BUDGET_EXCEEDED'); }
          bytes += length; res.write(text); if (final) { terminal = true; res.end(); }
        };
        const run = new ManagedRun(request, config, emit);
        const entry: { run: ManagedRun; done: Promise<void>; endedAt?: number } = { run, done: Promise.resolve() };
        runs.set(request.runId, entry);
        res.on('close', () => { if (!terminal) run.cancel(); });
        entry.done = run.execute().catch(() => { run.cancel(); res.destroy(); }).finally(() => { entry.endedAt = Date.now(); });
        return;
      }
      const match = url.pathname.match(/^\/internal\/runs\/([^/]+)(\/respond)?$/);
      if (match) {
        let id: string; try { id = decodeURIComponent(match[1]); } catch { throw new WorkerError('INVALID_REQUEST'); }
        const entry = runs.get(id); if (!entry) throw new WorkerError('RUN_NOT_FOUND', 404);
        if (req.method === 'POST' && match[2]) { await entry.run.respond(parseAnswer(await readJSON(req, 40_000))); return json(res, 200, { accepted: true }); }
        if (req.method === 'DELETE' && !match[2]) { entry.run.cancel(); return json(res, 202, { accepted: true }); }
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) { if (!res.headersSent) json(res, error instanceof WorkerError ? error.status : 500, { error: error instanceof WorkerError ? error.code : 'WORKER_ERROR' }); else res.destroy(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, runs, async close() { stopping = true; for (const entry of runs.values()) if (!entry.endedAt) entry.run.cancel(); await Promise.allSettled([...runs.values()].map(entry => entry.done)); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig(), worker = createWorkerServer(config);
  worker.server.listen(config.port, config.host, () => console.log(`AwwO OpenMaus worker listening on ${config.host}:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.close().then(() => process.exit(0), () => process.exit(1)); });
}
