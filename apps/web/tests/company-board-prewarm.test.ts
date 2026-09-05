import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// Exercises the REAL board domain modules (server/ui via the `@` alias) so it actually
// proves the startup prewarm warms the same cache keys CompanyProvider + Dashboard read
// on mount. The board UI itself is never mounted here — this is the data-warm half of
// Approach A (no keep-alive), which is exactly what makes the Team tab open without a
// cold fetch.
import { queryKeys } from '@/lib/queryKeys';
import { prewarmCompanyBoard } from '../src/companyBoardPrewarm';

// retry:false keeps the warm's fetchQuery/prefetchQuery calls one-shot, so a failure
// path resolves immediately (no exponential-backoff retries slowing the test).
function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// The board's companies list lives at `${apiBase}/companies`; every company-scoped
// endpoint has a longer path, so an exact `/companies` suffix uniquely identifies the
// gating list call. By default company-scoped calls succeed with an empty body — the
// prewarm only needs them to resolve and populate the cache. `failDashboardSummary`
// makes ONLY `dashboard.summary` (`/companies/:id/dashboard`) fail, to exercise the
// "summary is the gating query" path.
function stubFetch(companies: unknown[], opts: { failDashboardSummary?: boolean } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (opts.failDashboardSummary && url.endsWith('/dashboard')) {
      return new Response(JSON.stringify({ error: 'summary unavailable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = url.endsWith('/companies') ? companies : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom-less env: nothing to clear */
  }
});

describe('prewarmCompanyBoard', () => {
  it('warms the companies list and the selected company\'s Dashboard cascade into the cache', async () => {
    const calls = stubFetch([{ id: 'c1', name: 'C1', status: 'active' }]);
    const client = freshClient();

    const ok = await prewarmCompanyBoard(client);

    expect(ok).toBe(true);
    // Gating companies query is cached in the exact shape CompanyProvider reads.
    expect(client.getQueryData(queryKeys.companies.all)).toEqual({
      companies: [{ id: 'c1', name: 'C1', status: 'active' }],
      unauthorized: false,
    });
    // The skeleton-gating summary query is cached (so Dashboard's `isLoading` is false).
    expect(client.getQueryData(queryKeys.dashboard('c1'))).toBeDefined();
    // The five secondary sections are warmed for the auto-selected company (c1), keyed
    // identically to Dashboard.tsx (including the activity { limit: 10 } variant).
    expect(client.getQueryData(queryKeys.agents.list('c1'))).toBeDefined();
    expect(client.getQueryData([...queryKeys.activity('c1'), { limit: 10 }])).toBeDefined();
    expect(client.getQueryData(queryKeys.issues.list('c1'))).toBeDefined();
    expect(client.getQueryData(queryKeys.projects.list('c1'))).toBeDefined();
    expect(client.getQueryData(queryKeys.access.companyUserDirectory('c1'))).toBeDefined();
    // 1 companies probe + 1 summary + 5 secondary = 7 calls, nothing more.
    expect(calls).toHaveLength(7);
  });

  it('is single-flight + idempotent per client (a settled warm never refetches)', async () => {
    const calls = stubFetch([{ id: 'c1', status: 'active' }]);
    const client = freshClient();

    await prewarmCompanyBoard(client);
    const callsAfterFirst = calls.length;
    const second = await prewarmCompanyBoard(client);

    expect(second).toBe(true);
    expect(calls.length).toBe(callsAfterFirst); // no second cascade
  });

  it('treats an empty company list as settled (returns true, warms nothing company-scoped, no retry churn)', async () => {
    const calls = stubFetch([]);
    const client = freshClient();

    const ok = await prewarmCompanyBoard(client);

    // Empty is a terminal state, not a transient failure — settled, so the caller stops.
    expect(ok).toBe(true);
    // Only the companies probe ran — no company-scoped fetches without a selection.
    expect(calls.every((u) => u.endsWith('/companies'))).toBe(true);
  });

  it('returns false (so the caller retries) when companies warm but dashboard.summary fails', async () => {
    // Regression guard: summary is what the board skeleton blocks on, so a swallowed
    // summary failure must NOT be reported as a completed warm — otherwise Team would
    // still cold-load and the App would never retry.
    const calls = stubFetch([{ id: 'c1', status: 'active' }], { failDashboardSummary: true });
    const client = freshClient();

    const ok = await prewarmCompanyBoard(client);

    expect(ok).toBe(false);
    expect(calls.some((u) => u.endsWith('/companies/c1/dashboard'))).toBe(true);
  });

  it('returns false on a control-plane failure and does not cache the failure (retry allowed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('control plane not reachable');
      }),
    );
    const client = freshClient();

    const firstAttempt = await prewarmCompanyBoard(client);
    expect(firstAttempt).toBe(false);

    // Node came up: the failed warm was dropped (not remembered), so a later call runs.
    const calls = stubFetch([{ id: 'c1', status: 'active' }]);
    const retry = await prewarmCompanyBoard(client);
    expect(retry).toBe(true);
    expect(calls.some((u) => u.endsWith('/companies'))).toBe(true);
  });
});
