import { QueryClient } from '@tanstack/react-query';

import { companiesListQueryOptions, type CompanyListResult } from '@/api/companies-query';
import { resolveBootstrapCompanySelection } from '@/context/CompanyContext';
import { queryKeys } from '@/lib/queryKeys';
import { agentsApi } from '@/api/agents';
import { dashboardApi } from '@/api/dashboard';
import { activityApi } from '@/api/activity';
import { issuesApi } from '@/api/issues';
import { projectsApi } from '@/api/projects';
import { accessApi } from '@/api/access';

// The embedded Paperclip board's persistent query cache. Module-level (not created
// inside <CompanyBoard/>) so the warm data survives across mounts/unmounts of the
// Team surface: the startup prewarm populates it once, and every later open of the
// Team tab reads straight from it instead of paying a cold fetch + spinner. The
// retry/refetch knobs match what the board needs as an embedded surface (one quick
// retry; no focus refetch — focus flips constantly between super's shell and the
// board); this is the single QueryClient both the prewarm and the mounted board use.
export const companyBoardQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      retryDelay: 300,
      refetchOnWindowFocus: false,
    },
  },
});

// Mirror of CompanyContext's STORAGE_KEY (server/ui) — a stable cross-surface contract
// for which company the board last had selected. We only READ it here to warm the
// right company's data; the mounted board remains the single writer.
const COMPANY_SELECTION_STORAGE_KEY = 'paperclip.selectedCompanyId';

// Mirror of Dashboard.tsx's DASHBOARD_ACTIVITY_LIMIT. The activity cache entry is keyed
// by this limit, so the warmed key must match Dashboard's exactly. If the board ever
// changes its limit, the only consequence is the activity list loads on first open
// (graceful) — nothing breaks.
const DASHBOARD_ACTIVITY_LIMIT = 10;

// Single-flight + idempotent-per-client. A successful warm is remembered (never
// repeats); a failed one is dropped so a caller can retry while the Node control plane
// finishes coming up. Keyed by client so tests can warm isolated clients independently.
const inFlight = new WeakMap<QueryClient, Promise<boolean>>();

function readStoredCompanyId(): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(COMPANY_SELECTION_STORAGE_KEY)
      : null;
  } catch {
    // localStorage can throw (privacy mode / blocked storage); a missing hint just
    // means the board falls back to its first selectable company.
    return null;
  }
}

// Returns true when the warm is SETTLED — either the Dashboard-gating data is in cache,
// or there is genuinely nothing to warm (no companies / nothing selectable). Returns
// false ONLY on a transient control-plane failure that is worth retrying. The caller's
// retry + the per-client cache (see prewarmCompanyBoard) hinge on this distinction.
async function runPrewarm(client: QueryClient): Promise<boolean> {
  // 1. Companies list — the gating query CompanyProvider blocks on. fetchQuery (not
  //    prefetchQuery) because we need the result to resolve which company the board
  //    will auto-select, reusing the board's OWN exported selection logic so the
  //    warmed company can never drift from what CompanyProvider picks on mount; and so
  //    a thrown fetch (Node control plane not up yet) surfaces as a retryable failure.
  // `CompanyListResult` resolves through the `@/*` board alias, which apps/web's type-check
  // treats as untyped (see vendor-shims.d.ts) — so the board's company shape is `any[]` here.
  let companies: any[];
  try {
    const result = (await client.fetchQuery(companiesListQueryOptions)) as { companies?: any[] } | undefined;
    companies = result?.companies ?? [];
  } catch {
    return false; // control plane unreachable — transient, ask the caller to retry.
  }
  // A valid empty list is a terminal state (nothing to warm), not a transient failure.
  // Report SETTLED so the caller stops retrying — there is no company to re-probe, and
  // the board fetches live if a company is created later this session.
  if (companies.length === 0) return true;

  const selectedId = resolveBootstrapCompanySelection({
    companies,
    sidebarCompanies: companies.filter((company) => company.status !== 'archived'),
    selectedCompanyId: null,
    storedCompanyId: readStoredCompanyId(),
  });
  if (!selectedId) return true; // nothing selectable — settled, not a transient failure.

  // 2a. The five secondary Dashboard sections each render with their own loading state,
  //     and some legitimately 404 in local_trusted mode (e.g. resource-scoped reads), so
  //     warm them best-effort: prefetchQuery swallows per-endpoint errors and never
  //     rejects, so one failing section can't fail the whole warm or block the others.
  const secondaryWarm = Promise.allSettled([
    client.prefetchQuery({
      queryKey: queryKeys.agents.list(selectedId),
      queryFn: () => agentsApi.list(selectedId),
    }),
    client.prefetchQuery({
      queryKey: [...queryKeys.activity(selectedId), { limit: DASHBOARD_ACTIVITY_LIMIT }],
      queryFn: () => activityApi.list(selectedId, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    }),
    client.prefetchQuery({
      queryKey: queryKeys.issues.list(selectedId),
      queryFn: () => issuesApi.list(selectedId),
    }),
    client.prefetchQuery({
      queryKey: queryKeys.projects.list(selectedId),
      queryFn: () => projectsApi.list(selectedId),
    }),
    client.prefetchQuery({
      queryKey: queryKeys.access.companyUserDirectory(selectedId),
      queryFn: () => accessApi.listUserDirectory(selectedId),
    }),
  ]);

  // 2b. dashboard.summary is what the board's skeleton actually blocks on
  //     (Dashboard.tsx: `if (isLoading) return <PageSkeleton/>`), so the warm only
  //     counts as done when summary truly lands. fetchQuery (NOT prefetchQuery, which
  //     swallows the error) so a failed summary surfaces as a retryable failure —
  //     otherwise we'd permanently remember an incomplete warm and Team would still
  //     cold-load the moment summary briefly failed.
  let summaryWarm = true;
  try {
    await client.fetchQuery({
      queryKey: queryKeys.dashboard(selectedId),
      queryFn: () => dashboardApi.summary(selectedId),
    });
  } catch {
    summaryWarm = false;
  }
  await secondaryWarm;
  return summaryWarm;
}

// Warm the embedded Team/Company board's data into its persistent query cache so the
// first navigation to the Team surface renders with no cold fetch / spinner. Resolves
// true when SETTLED (the gating data is warm, or there's nothing to warm) and false
// only on a transient control-plane failure worth retrying. Safe to call repeatedly:
// concurrent calls share one promise, a settled result is never re-run for the same
// client, and a transient failure is dropped so the caller can retry.
export function prewarmCompanyBoard(
  client: QueryClient = companyBoardQueryClient,
): Promise<boolean> {
  const existing = inFlight.get(client);
  if (existing) return existing;
  const pending = runPrewarm(client)
    .then((ok) => {
      if (!ok) inFlight.delete(client);
      return ok;
    })
    .catch(() => {
      inFlight.delete(client);
      return false;
    });
  inFlight.set(client, pending);
  return pending;
}
