import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createMissionDispatchRouter, parseDispatchRequest } from './dispatch-routes.js';

const TOKEN = 'test-token';
const roster = [{ id: 'ag-qa', name: 'Nova', title: '质检官', status: 'idle' }];

async function serve(dispatcher: any, fetchImpl: any): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api', express.json(), createMissionDispatchRouter({ dispatcher, upstreamBaseUrl: 'http://up', controlToken: TOKEN, fetchImpl }));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const rosterFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => roster }) as unknown as Response);
const post = (base: string, body: unknown, token = TOKEN) =>
  fetch(`${base}/api/missions/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-superclaw-gateway-token': token } : {}) }, body: JSON.stringify(body) });

describe('parseDispatchRequest', () => {
  it('requires companyId, a valid role, and a non-empty task', () => {
    expect(parseDispatchRequest({ companyId: ' co-B ', role: 'verify', task: ' do it ' })).toEqual({ companyId: 'co-B', role: 'verify', task: ' do it ', agentId: undefined, agentName: undefined, title: undefined, autonomous: false });
    expect(() => parseDispatchRequest({ role: 'verify', task: 'x' })).toThrow(/companyId is required/);
    expect(() => parseDispatchRequest({ companyId: 'c', role: 'nope', task: 'x' })).toThrow(/role must be/);
    expect(() => parseDispatchRequest({ companyId: 'c', role: 'verify', task: '   ' })).toThrow(/task is required/);
    expect(() => parseDispatchRequest({ companyId: 'c', role: 'verify', task: 'a'.repeat(8001) })).toThrow(/exceeds/);
  });
  it('carries an operator agent override', () => {
    expect(parseDispatchRequest({ companyId: 'c', role: 'verify', task: 'x', agentId: 'ag-x', agentName: 'X' })).toMatchObject({ agentId: 'ag-x', agentName: 'X' });
  });
});

describe('P3g — autonomous cross-company dispatch gate', () => {
  async function serveWith(opts: { crossCompanyAutonomy?: boolean; now?: () => number }) {
    const app = express();
    const dispatcher = { dispatch: vi.fn(async () => ({ issueId: 'i-1', runId: 'r-1' })) };
    app.use(
      '/api',
      express.json(),
      createMissionDispatchRouter({
        dispatcher: dispatcher as any,
        upstreamBaseUrl: 'http://up',
        controlToken: TOKEN,
        fetchImpl: rosterFetch() as any,
        ...opts,
      }),
    );
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      dispatcher,
      close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
    };
  }
  const body = (extra: Record<string, unknown> = {}) => ({ companyId: 'co-B', role: 'verify', task: 'check it', ...extra });

  it('refuses a self-declared autonomous dispatch when the flag is OFF (the shipped default)', async () => {
    const s = await serveWith({});
    try {
      const r = await post(s.base, body({ autonomous: true }));
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error?: string }).error).toBe('autonomy_disabled');
      // Nothing was delegated — refused BEFORE any upstream work.
      expect(s.dispatcher.dispatch).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('leaves the operator-approved path untouched whether the flag is on or off', async () => {
    for (const crossCompanyAutonomy of [false, true]) {
      const s = await serveWith({ crossCompanyAutonomy });
      try {
        const r = await post(s.base, body()); // no `autonomous` field = the canvas path
        expect(r.status).toBe(200);
        expect(s.dispatcher.dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await s.close();
      }
    }
  });

  it('allows an autonomous dispatch once the flag is ON', async () => {
    const s = await serveWith({ crossCompanyAutonomy: true });
    try {
      const r = await post(s.base, body({ autonomous: true }));
      expect(r.status).toBe(200);
      expect(s.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it('budgets autonomous dispatch so a looping agent cannot fan out without bound', async () => {
    let t = 0;
    const s = await serveWith({ crossCompanyAutonomy: true, now: () => t });
    try {
      let refused = 0;
      for (let i = 0; i < 25; i += 1) {
        const r = await post(s.base, body({ autonomous: true }));
        if (r.status === 429) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
      // A later window frees the budget again (fixed window, not a permanent ban).
      t += 61_000;
      expect((await post(s.base, body({ autonomous: true }))).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('does not read a truthy non-boolean as autonomy', () => {
    expect(parseDispatchRequest({ companyId: 'c', role: 'verify', task: 'x', autonomous: 'false' }).autonomous).toBe(false);
    expect(parseDispatchRequest({ companyId: 'c', role: 'verify', task: 'x', autonomous: 1 }).autonomous).toBe(false);
    expect(parseDispatchRequest({ companyId: 'c', role: 'verify', task: 'x', autonomous: true }).autonomous).toBe(true);
  });
});

describe('POST /api/missions/dispatch', () => {
  it('constructor refuses an empty control token', () => {
    expect(() => createMissionDispatchRouter({ dispatcher: { dispatch: vi.fn() }, upstreamBaseUrl: 'http://up', controlToken: '' })).toThrow(/controlToken/);
  });

  it('401 without the control token', async () => {
    const { base, close } = await serve({ dispatch: vi.fn() }, rosterFetch());
    try {
      const res = await post(base, { companyId: 'co-B', role: 'verify', task: 'x' }, '');
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('400 on a bad body', async () => {
    const { base, close } = await serve({ dispatch: vi.fn() }, rosterFetch());
    try {
      expect((await post(base, { role: 'verify', task: 'x' })).status).toBe(400); // missing companyId
    } finally {
      await close();
    }
  });

  it('200 dispatched: auto-picks + delegates the task to the matched company agent', async () => {
    const dispatcher = { dispatch: vi.fn(async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-qa', run: { runId: 'r-1' } })) };
    const { base, close } = await serve(dispatcher, rosterFetch());
    try {
      const res = await post(base, { companyId: 'co-B', role: 'verify', task: '验证登录' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'dispatched', companyId: 'co-B', agent: { id: 'ag-qa', name: 'Nova' }, issueId: 'iss-1', runId: 'r-1' });
      expect(dispatcher.dispatch).toHaveBeenCalledWith({ companyId: 'co-B', agentId: 'ag-qa', message: '验证登录', title: undefined });
    } finally {
      await close();
    }
  });

  it('200 no_agent when the target has no staffable agent (honest, nothing dispatched)', async () => {
    const dispatcher = { dispatch: vi.fn() };
    const emptyFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
    const { base, close } = await serve(dispatcher, emptyFetch);
    try {
      const res = await post(base, { companyId: 'co-B', role: 'verify', task: 'x' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('no_agent');
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('502 when the delegation itself errored upstream (honest, not fake-success)', async () => {
    const dispatcher = { dispatch: vi.fn(async () => ({ status: 'error', detail: 'create issue failed (upstream 403)' })) };
    const { base, close } = await serve(dispatcher, rosterFetch());
    try {
      const res = await post(base, { companyId: 'co-B', role: 'verify', task: 'x' });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/create issue failed/);
    } finally {
      await close();
    }
  });
});
