import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGatewayApp } from '../app.js';
import { createCanvasPlannerRouter } from './routes.js';
import { PlannerError, type CanvasPlanner } from './provider.js';

const TOKEN = 'canvas-test-token';
const plan = { version: 1, summary: 'ready', operations: [] };
const headers = { 'Content-Type': 'application/json', 'x-superclaw-gateway-token': TOKEN };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function serve(provider: CanvasPlanner, peer?: string) {
  const upstream = { health: vi.fn(async () => { throw new Error('must not use upstream'); }) };
  const app = express();
  if (peer) app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer }); next(); });
  app.use(createGatewayApp({ upstream, canvasPlannerRouter: createCanvasPlannerRouter({ provider, controlToken: TOKEN }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, upstream };
}
function provider(): CanvasPlanner {
  return { status: vi.fn(async () => ({ available: true, provider: 'codex' })), plan: vi.fn(async () => plan) };
}
describe('canvas planning HTTP API', () => {
  it('rejects a non-loopback peer even with the token and forged proxy headers', async () => {
    const p = provider(); const { base } = await serve(p, '203.0.113.20');
    expect((await fetch(`${base}/api/canvas/planner`, { headers: { ...headers, 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
    expect(p.status).not.toHaveBeenCalled();
  });
  it('rejects missing token and refuses an empty configured token', async () => {
    expect(() => createCanvasPlannerRouter({ provider: provider(), controlToken: '' })).toThrow();
    const p = provider(); const { base } = await serve(p);
    expect((await fetch(`${base}/api/canvas/planner`)).status).toBe(401);
    expect((await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(p.plan).not.toHaveBeenCalled();
  });
  it('reports availability and returns genuine provider JSON without upstream or Agent dispatch', async () => {
    const p = provider(); const { base, upstream } = await serve(p);
    expect(await (await fetch(`${base}/api/canvas/planner`, { headers })).json()).toEqual({ available: true, provider: 'codex' });
    const response = await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'build', context: 'graph' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan, provider: 'codex' });
    expect(p.plan).toHaveBeenCalledWith({ prompt: 'build', context: 'graph' }, expect.any(AbortSignal));
    expect(upstream.health).not.toHaveBeenCalled();
  });
  it('rejects missing, overlong and oversized input before contacting AI', async () => {
    const p = provider(); const { base } = await serve(p);
    for (const body of [{ prompt: '', context: 'x' }, { prompt: 'x', context: '' }, { prompt: 'x'.repeat(8001), context: 'x' }, { prompt: 'x', context: 'x'.repeat(120001) }, { prompt: 'x', context: 'x', cliPath: 'malicious' }]) {
      expect((await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'x', context: '中'.repeat(100000) }) })).status).toBe(413);
    const malformed = await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: '{SECRET-invalid' });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('SECRET');
    expect(p.plan).not.toHaveBeenCalled();
  });
  it('keeps unavailable, timeout and unknown failures friendly and never includes internal errors', async () => {
    for (const [error, status] of [[new PlannerError('unavailable'), 503], [new PlannerError('timeout'), 504], [new Error('SECRET path/key'), 502]] as const) {
      const p = provider(); p.plan = async () => { throw error; };
      const { base } = await serve(p);
      const response = await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: '{"prompt":"x","context":"y"}' });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('SECRET');
    }
  });
  it('bounds concurrency and aborts planning when the browser disconnects', async () => {
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    let aborted!: () => void; const ended = new Promise<void>(resolve => { aborted = resolve; });
    const p = provider();
    p.plan = (_request, signal) => new Promise((_resolve, reject) => { started(); signal?.addEventListener('abort', () => { aborted(); reject(new PlannerError('cancelled')); }); });
    const { base } = await serve(p); const controller = new AbortController();
    const request = fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: '{"prompt":"x","context":"y"}', signal: controller.signal }).catch(() => null);
    await began;
    expect((await fetch(`${base}/api/canvas/plan`, { method: 'POST', headers, body: '{"prompt":"x","context":"y"}' })).status).toBe(429);
    controller.abort(); await request; await ended;
  });
});
