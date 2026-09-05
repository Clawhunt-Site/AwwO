import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveAutomation,
  createSessionAutomation,
  deleteAutomation,
  listSessionAutomations,
} from '../src/chatAutomations';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Recorded = { url: string; method: string; body: unknown };

function stubFetch(routes: Record<string, unknown | 'reject' | { status: number; error?: string }>) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body });
    const hit = routes[url];
    if (hit === undefined || hit === 'reject') throw new Error(`network down: ${url}`);
    if (typeof hit === 'object' && hit !== null && typeof (hit as { status?: unknown }).status === 'number') {
      const h = hit as { status: number; error?: string };
      return new Response(h.error ? JSON.stringify({ error: h.error }) : null, {
        status: h.status,
        headers: h.error ? { 'Content-Type': 'application/json' } : undefined,
      });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const SESSION = '11111111-1111-4111-8111-111111111111';

describe('listSessionAutomations', () => {
  it('GETs the gateway automations scoped to the session via the /gateway-api proxy', async () => {
    const item = { id: 'a1', sessionIssueId: SESSION, prompt: 'p', approvalState: 'approved' };
    const { calls } = stubFetch({ [`/gateway-api/automations?sessionIssueId=${SESSION}`]: [item] });
    const out = await listSessionAutomations(SESSION);
    expect(out).toEqual([item]);
    expect(calls[0]?.url).toBe(`/gateway-api/automations?sessionIssueId=${SESSION}`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('fail-soft: returns null on a transient failure (caller keeps last-known)', async () => {
    stubFetch({ [`/gateway-api/automations?sessionIssueId=${SESSION}`]: 'reject' });
    expect(await listSessionAutomations(SESSION)).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    stubFetch({ [`/gateway-api/automations?sessionIssueId=${SESSION}`]: { status: 401 } });
    expect(await listSessionAutomations(SESSION)).toBeNull();
  });
});

describe('createSessionAutomation', () => {
  it('POSTs the input and returns the created (pending_approval) automation', async () => {
    const created = { id: 'a9', sessionIssueId: SESSION, approvalState: 'pending_approval' };
    const { calls } = stubFetch({ '/gateway-api/automations': created });
    const result = await createSessionAutomation({ sessionIssueId: SESSION, prompt: 'digest', intervalSec: 3600 });
    expect(result).toEqual({ ok: true, data: created });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ sessionIssueId: SESSION, prompt: 'digest', intervalSec: 3600 });
  });

  it('surfaces a typed error (never optimistic) on a non-ok response', async () => {
    stubFetch({ '/gateway-api/automations': { status: 400, error: 'intervalSec must be an integer' } });
    const result = await createSessionAutomation({ sessionIssueId: SESSION, prompt: 'p', intervalSec: 1 });
    expect(result).toEqual({ ok: false, status: 400, error: 'intervalSec must be an integer' });
  });

  it('surfaces a 403 (loopback) / 401 (token) gateway rejection', async () => {
    stubFetch({ '/gateway-api/automations': { status: 403, error: 'automation API is loopback-only' } });
    const result = await createSessionAutomation({ sessionIssueId: SESSION, prompt: 'p', intervalSec: 3600 });
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(403);
  });
});

describe('approveAutomation / deleteAutomation', () => {
  it('POSTs the approve route', async () => {
    const { calls } = stubFetch({ '/gateway-api/automations/a1/approve': { id: 'a1', approvalState: 'approved' } });
    const result = await approveAutomation('a1');
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: '/gateway-api/automations/a1/approve', method: 'POST' });
  });

  it('DELETE returns ok on 204 (no body)', async () => {
    const { calls } = stubFetch({ '/gateway-api/automations/a1': { status: 204 } });
    const result = await deleteAutomation('a1');
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe('DELETE');
  });
});

describe('desktop loopback origin', () => {
  afterEach(() => {
    delete (globalThis as { __SUPERCLAW_PY_ORIGIN__?: unknown }).__SUPERCLAW_PY_ORIGIN__;
  });

  it('prefixes the gateway base with __SUPERCLAW_PY_ORIGIN__ so packaged-desktop reaches the Python front door', async () => {
    // In a packaged desktop the window stays on tauri://localhost; the gateway API
    // must be addressed at the Python front door's loopback origin, not relative.
    (globalThis as { __SUPERCLAW_PY_ORIGIN__?: string }).__SUPERCLAW_PY_ORIGIN__ = 'http://127.0.0.1:54321';
    const url = `http://127.0.0.1:54321/gateway-api/automations?sessionIssueId=${SESSION}`;
    const { calls } = stubFetch({ [url]: [] });
    await listSessionAutomations(SESSION);
    expect(calls[0]?.url).toBe(url); // absolute origin-prefixed, not relative
  });

  it('stays relative in browser/dev (no origin injected)', async () => {
    const { calls } = stubFetch({ '/gateway-api/automations': [] });
    await listSessionAutomations('x').catch(() => undefined);
    // listAutomationSessionIds uses '/automations'; here listSessionAutomations adds the query
    expect(calls[0]?.url.startsWith('/gateway-api/')).toBe(true);
  });
});
