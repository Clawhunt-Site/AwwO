import { afterEach, describe, expect, it, vi } from 'vitest';

// Integration test for the embedded Paperclip board's API wiring. It exercises the
// REAL board modules (server/ui via the `@` alias) — NOT a stub — so it actually
// catches the failure mode app-shell.test.tsx's CompanyBoard mock cannot: that the
// board's same-origin calls must target the Paperclip control plane via the
// embedding base (`apiBase`, injected by vite `define` → "/paperclip-api"), and
// never a bare "/api" that would hit apps/web's own Python backend.
import { apiBase, api } from '@/api/client';
import { companiesApi } from '@/api/companies';
import { healthApi } from '@/api/health';
import { authApi } from '@/api/auth';

function recordFetch(body: unknown = { ok: true }) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embedded board API base wiring', () => {
  it('resolves apiBase to the same-origin Paperclip proxy prefix (vite define)', () => {
    // apps/web injects __PAPERCLIP_API_BASE__ via vite.config define; standalone
    // server/ui would fall back to "/api".
    expect(apiBase).toBe('/paperclip-api');
  });

  it('routes the shared api client through apiBase, never a bare /api', async () => {
    const calls = recordFetch();
    await api.get('/companies');
    expect(calls).toEqual([`${apiBase}/companies`]);
    expect(calls.every((u) => u.startsWith(`${apiBase}/`))).toBe(true);
    expect(calls.some((u) => u.startsWith('/api/'))).toBe(false);
  });

  it('routes a real board domain module (companiesApi.list) through apiBase', async () => {
    const calls = recordFetch([]);
    await companiesApi.list();
    expect(calls[0]).toBe(`${apiBase}/companies`);
  });

  it('routes the direct-fetch board modules (health, auth) through apiBase', async () => {
    const healthCalls = recordFetch({ status: 'ok' });
    await healthApi.get();
    expect(healthCalls[0]).toBe(`${apiBase}/health`);

    const authCalls = recordFetch({ user: null });
    await authApi.getSession().catch(() => undefined);
    expect(authCalls[0]).toBe(`${apiBase}/auth/get-session`);
  });
});
