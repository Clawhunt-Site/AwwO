import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayApp } from '../app.js';
import type { UpstreamClient } from '../upstream.js';
import type { Request } from 'express';
import { buildAutomation, createAutomationRouter, isLoopbackRequest } from './routes.js';
import { InMemoryAutomationStore, PERSONAL_CHAT_COMPANY_ID } from './store.js';

const NOW = 1_000_000;
const TOKEN = 'test-control-token';
const SESSION = '11111111-1111-4111-8111-111111111111'; // a valid uuid chat session id
const stubUpstream: UpstreamClient = {
  health: async () => ({ reachable: true, status: 200 }) as never,
};
const AUTH = { 'x-superclaw-gateway-token': TOKEN };

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function startApp(store: InMemoryAutomationStore) {
  const router = createAutomationRouter({ store, controlToken: TOKEN, now: () => NOW, idGen: () => 'fixed-id' });
  const app = createGatewayApp({ upstream: stubUpstream, automationRouter: router });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe('createAutomationRouter — auth invariant', () => {
  it('refuses to construct without a control token (never unauthenticated)', () => {
    expect(() => createAutomationRouter({ store: new InMemoryAutomationStore(), controlToken: '' })).toThrow();
  });
});

describe('isLoopbackRequest — control plane is local-only (reads the socket peer, not a header)', () => {
  const req = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } }) as unknown as Request;

  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', (addr) => {
    expect(isLoopbackRequest(req(addr))).toBe(true);
  });

  it.each(['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '2001:db8::1', '', undefined])(
    'rejects non-loopback %s',
    (addr) => {
      expect(isLoopbackRequest(req(addr as string | undefined))).toBe(false);
    },
  );
});

describe('buildAutomation (pure)', () => {
  const base = { sessionIssueId: SESSION, prompt: 'digest', intervalSec: 3600 };

  it('pins to Personal Chat, first slot one interval out, defaults timezone, observability null', () => {
    const a = buildAutomation(base, { now: NOW, id: 'x', approvalState: 'pending_approval' });
    expect(a.companyId).toBe(PERSONAL_CHAT_COMPANY_ID);
    expect(a.nextRunAt).toBe(NOW + 3_600_000);
    expect(a.timezone).toBe('UTC');
    expect(a.approvalState).toBe('pending_approval');
    expect(a).toMatchObject({ lastFiredAt: null, lastOutcomeOk: null, lastError: null, lastFireKey: null });
  });

  it.each([
    [{ ...base, sessionIssueId: 'not-a-uuid' }, /uuid/],
    [{ ...base, prompt: '   ' }, /prompt/],
    [{ ...base, intervalSec: 30 }, /intervalSec/], // below 60s floor
    [{ ...base, intervalSec: 60.5 }, /intervalSec/], // non-integer
    [{ ...base, intervalSec: 0 }, /intervalSec/],
  ])('rejects invalid input %#', (input, re) => {
    expect(() => buildAutomation(input as never, { now: NOW, id: 'x', approvalState: 'approved' })).toThrow(re);
  });
});

describe('automation routes — auth', () => {
  it('401 without the control token; stores nothing', async () => {
    const store = new InMemoryAutomationStore();
    const base = await startApp(store);
    const res = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIssueId: SESSION, prompt: 'p', intervalSec: 3600 }),
    });
    expect(res.status).toBe(401);
    expect(await store.list()).toEqual([]);
  });

  it('401 with a wrong token', async () => {
    const base = await startApp(new InMemoryAutomationStore());
    const res = await fetch(`${base}/api/automations`, { headers: { 'x-superclaw-gateway-token': 'wrong' } });
    expect(res.status).toBe(401);
  });
});

describe('automation routes — CRUD + governance', () => {
  it('POST creates a Personal-Chat automation as pending_approval (fail-closed) and 201', async () => {
    const store = new InMemoryAutomationStore();
    const base = await startApp(store);
    const res = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ sessionIssueId: SESSION, prompt: 'morning digest', intervalSec: 3600 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'fixed-id',
      sessionIssueId: SESSION,
      companyId: PERSONAL_CHAT_COMPANY_ID,
      approvalState: 'pending_approval', // fail-closed: not auto-run
    });
  });

  it('POST with invalid body returns 400 and stores nothing', async () => {
    const store = new InMemoryAutomationStore();
    const base = await startApp(store);
    const res = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ sessionIssueId: SESSION, intervalSec: 3600 }), // no prompt
    });
    expect(res.status).toBe(400);
    expect(await store.list()).toEqual([]);
  });

  it('POST .../approve flips pending → approved (the human gate)', async () => {
    const store = new InMemoryAutomationStore([
      buildAutomation({ sessionIssueId: SESSION, prompt: 'p', intervalSec: 3600 }, { now: NOW, id: 'pend', approvalState: 'pending_approval' }),
    ]);
    const base = await startApp(store);
    const res = await fetch(`${base}/api/automations/pend/approve`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approvalState: string }).approvalState).toBe('approved');
    expect((await store.get('pend'))!.approvalState).toBe('approved');
  });

  it('POST .../approve on a missing id is 404', async () => {
    const base = await startApp(new InMemoryAutomationStore());
    const res = await fetch(`${base}/api/automations/nope/approve`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET lists and filters by sessionIssueId; DELETE removes', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const store = new InMemoryAutomationStore([
      buildAutomation({ sessionIssueId: SESSION, prompt: 'p', intervalSec: 3600 }, { now: NOW, id: 'a', approvalState: 'approved' }),
      buildAutomation({ sessionIssueId: other, prompt: 'p', intervalSec: 3600 }, { now: NOW, id: 'b', approvalState: 'approved' }),
    ]);
    const base = await startApp(store);
    const all = (await (await fetch(`${base}/api/automations`, { headers: AUTH })).json()) as Array<{ id: string }>;
    expect(all.map((a) => a.id).sort()).toEqual(['a', 'b']);
    const filtered = (await (await fetch(`${base}/api/automations?sessionIssueId=${SESSION}`, { headers: AUTH })).json()) as Array<{ id: string }>;
    expect(filtered.map((a) => a.id)).toEqual(['a']);
    const del = await fetch(`${base}/api/automations/a`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(204);
    expect(await store.get('a')).toBeNull();
  });
});
