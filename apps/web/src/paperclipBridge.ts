// paperclipBridge — apps/web's read path into the vendored Paperclip Node
// control-plane API (server/server). The company *page* is the real Paperclip board
// UI compiled natively into apps/web (CompanyBoard); this module migrates the two
// remaining apps/web surfaces that still read company data off the Python
// /api/team/* kernel — the sidebar unread badge and the chat composer @-company
// picker — onto the Paperclip company API, completing the owner directive
// "把 company 的 API 全部换成 Paperclip 那套".
//
// Reachability: the Node /api does NOT send CORS headers, so apps/web cannot
// fetch it cross-origin from a browser. In the Vite dev server we proxy a
// same-origin prefix instead (/paperclip-api -> http://localhost:3100/api; see
// apps/web/vite.config.mjs). The base is configurable via VITE_PAPERCLIP_API_BASE.
// In Paperclip's default `local_trusted` mode these endpoints need no auth; an
// `authenticated` deployment would ride the session cookie (credentials:'include').
//
// Scope/limits (surfaced to the owner): this is the dev (vite-proxy) path. In the
// packaged desktop app there is no vite proxy and the Tauri webview enforces CORS,
// so reaching the Node API there needs CORS on the server or a native HTTP path —
// the broader server-refactor bridge, tracked as a follow-up. Every call here is
// FAIL-SOFT: a failure returns null so callers keep their last-known state and
// never crash.

const DEFAULT_PAPERCLIP_API_BASE = '/paperclip-api';

export function paperclipApiBase(): string {
  // import.meta.env (Vite build) first; process.env fallback for Node/test
  // contexts (vitest's vi.stubEnv writes process.env, not import.meta.env).
  const fromImportMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[
    'VITE_PAPERCLIP_API_BASE'
  ];
  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['VITE_PAPERCLIP_API_BASE'];
  const trimmed = (fromImportMeta ?? fromProcess ?? '').trim();
  // strip trailing slashes so `${base}/companies` never doubles up
  const base = (trimmed || DEFAULT_PAPERCLIP_API_BASE).replace(/\/+$/, '');
  // An already-absolute base must never be double-prefixed with the loopback origin.
  if (/^https?:\/\//i.test(base)) return base;
  // Desktop D1: prepend the front door's loopback ORIGIN (set at runtime once the
  // desktop session base_url is known — the runtime picks a random port) so apps/web's
  // own board-data reads (sidebar badge, @-company picker) reach the Python front door
  // cross-origin while the window stays on tauri://localhost. Empty in browser/dev.
  const origin = (globalThis as { __SUPERCLAW_PY_ORIGIN__?: unknown }).__SUPERCLAW_PY_ORIGIN__;
  const prefix = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  return prefix + base;
}

// Fail-soft GET: resolves to the parsed JSON, or null on any non-ok/network/parse
// failure. Never throws — callers distinguish null (keep last) from data.
async function paperclipGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${paperclipApiBase()}${path}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Subset of the Paperclip company entity we consume (server/server types/company.ts).
type PaperclipCompany = { id?: unknown; name?: unknown; status?: unknown };

// The shape apps/web's composer already expects. Paperclip's `id` maps to
// `company_profile_id` so the downstream @-menu / default-pick code is unchanged.
export type ComposerCompany = { company_profile_id: string; name: string; status?: string };

// GET /companies -> normalized composer companies. Returns null on a transient
// failure (caller keeps its last-known list), [] when there are genuinely none.
export async function listPaperclipCompanies(): Promise<ComposerCompany[] | null> {
  const data = await paperclipGet<PaperclipCompany[]>('/companies');
  if (!Array.isArray(data)) return null;
  return data.map(normalizePaperclipCompany).filter((c): c is ComposerCompany => c !== null);
}

// Normalize one raw Paperclip company entity to the composer shape (shared by the
// list and create paths). Returns null when the row lacks a usable id.
function normalizePaperclipCompany(c: PaperclipCompany | null): ComposerCompany | null {
  if (!c || typeof c.id !== 'string' || !c.id) return null;
  return {
    company_profile_id: c.id,
    name: (typeof c.name === 'string' && c.name.trim()) || c.id,
    status: typeof c.status === 'string' ? c.status : undefined,
  };
}

// POST /companies — create a company natively on the Paperclip Node control plane, the
// SAME endpoint the board's OnboardingWizard uses (companiesApi.create). This is how the
// chat composer's "create a company" action provisions a company directly on Node (a uuid
// company, born in its single home) INSTEAD of steering an agent through the deprecated
// Python orchestrator delivery run + kernel company_create tool. Node fills owner
// membership / default grants / local environment server-side (routes/companies.ts).
// FAIL-SOFT: returns the created company, or null on ANY non-ok/network/parse failure.
// The CALLER decides whether a null is recoverable — and it does so from an EXPLICIT
// Node-availability signal (runtime status), NOT from the HTTP status here: a 404 is
// ambiguous (no front-door route in pure-Python, OR a misconfigured-but-present Node), so
// inferring "Node absent" from a bare 404 would be fail-open (silently bypassing Node
// governance). See createCompanyDirect.
export async function createPaperclipCompany(name: string): Promise<ComposerCompany | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  try {
    const res = await fetch(`${paperclipApiBase()}/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) return null;
    return normalizePaperclipCompany((await res.json()) as PaperclipCompany);
  } catch {
    return null;
  }
}

type SidebarBadges = { inbox?: unknown; approvals?: unknown; failedRuns?: unknown; joinRequests?: unknown };

function badgeInbox(badges: SidebarBadges | null): number {
  const n = badges?.inbox;
  return typeof n === 'number' && n > 0 ? n : 0;
}

// Total "actionable" count across all companies for the sidebar badge — the sum
// of Paperclip's per-company GET /companies/{id}/sidebar-badges `inbox`. Returns
// null on a transient failure (caller keeps its last-known count), 0 when there
// are genuinely no companies / nothing actionable.
/** Max simultaneous per-company badge GETs (see the fan-out note in paperclipUnreadTotal). */
const BADGE_FETCH_CONCURRENCY = 6;

export async function paperclipUnreadTotal(): Promise<number | null> {
  const companies = await paperclipGet<PaperclipCompany[]>('/companies');
  if (!Array.isArray(companies)) return null;
  const ids = companies
    .filter((c): c is PaperclipCompany & { id: string } => Boolean(c && typeof c.id === 'string' && c.id))
    .map((c) => c.id);
  if (!ids.length) return 0;
  // Bounded fan-out. This runs on a 30s poll and previously fired one badge GET per company
  // ALL AT ONCE; with a real instance holding 22+ companies that is a 22-request burst through
  // the single front door every tick, which was heavy enough to make the canvas stutter. A fixed
  // worker pool keeps the same total work and the same result (each worker writes its own index)
  // while capping how much lands simultaneously.
  const badges: (SidebarBadges | null)[] = new Array(ids.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(BADGE_FETCH_CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= ids.length) return;
        badges[i] = await paperclipGet<SidebarBadges>(
          `/companies/${encodeURIComponent(ids[i])}/sidebar-badges`,
        );
      }
    }),
  );
  // Conservative fail-soft: only report a total when EVERY company's badge
  // resolved. If ANY badge call failed we cannot know the true total, so return
  // null (caller keeps its last-known count). Summing only the successes would
  // UNDER-report — a flaky company badge could blank a real pending count.
  if (badges.some((b) => b === null)) return null;
  return badges.reduce((sum, b) => sum + badgeInbox(b), 0);
}
