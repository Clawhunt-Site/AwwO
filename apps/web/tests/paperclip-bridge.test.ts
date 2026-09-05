import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPaperclipCompany,
  listPaperclipCompanies,
  paperclipApiBase,
  paperclipUnreadTotal,
} from '../src/paperclipBridge';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Route a mocked fetch by URL path. Unknown paths reject (network error) so the
// bridge's fail-soft behavior is exercised by default.
function stubFetch(routes: Record<string, unknown | 'reject' | { status: number }>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const hit = routes[url];
    if (hit === undefined || hit === 'reject') throw new Error(`network down: ${url}`);
    if (typeof hit === 'object' && hit !== null && 'status' in hit && typeof (hit as { status: number }).status === 'number') {
      return new Response('', { status: (hit as { status: number }).status });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

describe('paperclipApiBase', () => {
  it('defaults to the same-origin /paperclip-api proxy prefix', () => {
    expect(paperclipApiBase()).toBe('/paperclip-api');
  });

  it('honors VITE_PAPERCLIP_API_BASE and strips a trailing slash', () => {
    vi.stubEnv('VITE_PAPERCLIP_API_BASE', 'http://localhost:3100/api/');
    expect(paperclipApiBase()).toBe('http://localhost:3100/api');
  });
});

describe('listPaperclipCompanies', () => {
  it('maps Paperclip {id,name,status} to the composer company shape', async () => {
    stubFetch({
      '/paperclip-api/companies': [
        { id: 'c1', name: 'Acme', status: 'active' },
        { id: 'c2', name: '  ', status: 'paused' }, // blank name -> falls back to id
        { name: 'no-id' }, // dropped (no id)
      ],
    });
    const companies = await listPaperclipCompanies();
    expect(companies).toEqual([
      { company_profile_id: 'c1', name: 'Acme', status: 'active' },
      { company_profile_id: 'c2', name: 'c2', status: 'paused' },
    ]);
  });

  it('returns null on a transient failure (caller keeps last-known list)', async () => {
    stubFetch({ '/paperclip-api/companies': 'reject' });
    expect(await listPaperclipCompanies()).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    stubFetch({ '/paperclip-api/companies': { status: 500 } });
    expect(await listPaperclipCompanies()).toBeNull();
  });

  it('returns [] when there are genuinely no companies', async () => {
    stubFetch({ '/paperclip-api/companies': [] });
    expect(await listPaperclipCompanies()).toEqual([]);
  });
});

describe('paperclipUnreadTotal', () => {
  it('sums the inbox badge across all companies', async () => {
    stubFetch({
      '/paperclip-api/companies': [{ id: 'c1' }, { id: 'c2' }],
      '/paperclip-api/companies/c1/sidebar-badges': { inbox: 3, approvals: 1 },
      '/paperclip-api/companies/c2/sidebar-badges': { inbox: 2 },
    });
    expect(await paperclipUnreadTotal()).toBe(5);
  });

  it('returns 0 when there are no companies', async () => {
    stubFetch({ '/paperclip-api/companies': [] });
    expect(await paperclipUnreadTotal()).toBe(0);
  });

  it('returns null when the company list fetch fails', async () => {
    stubFetch({ '/paperclip-api/companies': 'reject' });
    expect(await paperclipUnreadTotal()).toBeNull();
  });

  it('returns null if ANY company badge fetch fails (never under-reports)', async () => {
    // all badges fail -> null
    stubFetch({
      '/paperclip-api/companies': [{ id: 'c1' }, { id: 'c2' }],
      // both badge routes reject (unlisted -> reject)
    });
    expect(await paperclipUnreadTotal()).toBeNull();

    // one badge resolves, one fails -> STILL null: summing only the success would
    // under-report and could blank a real pending count on the other company.
    stubFetch({
      '/paperclip-api/companies': [{ id: 'c1' }, { id: 'c2' }],
      '/paperclip-api/companies/c1/sidebar-badges': { inbox: 4 },
    });
    expect(await paperclipUnreadTotal()).toBeNull();
  });
});

describe('createPaperclipCompany', () => {
  it('POSTs the name and returns the normalized created company', async () => {
    const { fn } = stubFetch({ '/paperclip-api/companies': { id: 'uuid-1', name: 'Acme', status: 'active' } });
    const created = await createPaperclipCompany('Acme');
    expect(created).toEqual({ company_profile_id: 'uuid-1', name: 'Acme', status: 'active' });
    const [, init] = fn.mock.calls[0] as [unknown, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Acme' });
  });

  it('returns null on a non-ok response (caller decides recoverability via runtime status, not status code)', async () => {
    stubFetch({ '/paperclip-api/companies': { status: 404 } });
    expect(await createPaperclipCompany('Acme')).toBeNull();
  });

  it('returns null on a network error', async () => {
    stubFetch({}); // unknown path ⇒ reject ⇒ caught ⇒ null
    expect(await createPaperclipCompany('Acme')).toBeNull();
  });

  it('returns null for a blank name without calling fetch', async () => {
    const { fn } = stubFetch({});
    expect(await createPaperclipCompany('   ')).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
