/** A request typed on the workspace home, carried to the canvas it created. It lives in this tab's
 * sessionStorage only: the canvas page takes it, plans it once, and removes it when planning ends.
 *
 * `pending` has not been sent. `dispatched` was sent by a page that never reported back (it was
 * reloaded or closed mid-plan), so the next page restores the prompt instead of sending it again:
 * the earlier run may still be on the server, and a second one must be the operator's choice. */
export const PLAN_HANDOFF_PREFIX = 'awwo.saas.plan-handoff.v2';
// Hand-overs before v2 came from a home box that could cut an input method's composition to its limit, so one may hold
// a cut address. Read, one is moved under v2, marked untrusted (the canvas reads none of its addresses as the person's)
// and legacy (restored to the box, never started or claimed), and its old key goes.
const LEGACY_PLAN_HANDOFF_PREFIX = 'awwo.saas.plan-handoff.v1';
/** A request older than this is only restored to the prompt box, never started. */
export const PLAN_HANDOFF_TTL_MS = 10 * 60_000;
// The same browser writes and reads the time, so only a small adjustment of its clock is tolerated.
const CLOCK_TOLERANCE_MS = 5_000;

export type PlanHandoffScope = { user: string; tenant: string; canvas: string };
type StoredHandoff = { v: 2; prompt: string; createdAt: number; state: 'pending' | 'dispatched'; untrusted?: true; legacy?: true };
/** `start` is true only for a fresh request nobody has sent; `interrupted` marks one that was sent
 * and never came back. */
export type PlanHandoff = { prompt: string; start: boolean; interrupted: boolean; untrusted?: true };

const keyOf = ({ user, tenant, canvas }: PlanHandoffScope, prefix = PLAN_HANDOFF_PREFIX) =>
  `${prefix}:${[user, tenant, canvas].map(encodeURIComponent).join(':')}`;

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** A stored request of `version`, as v2: one of v1 (LEGACY_PLAN_HANDOFF_PREFIX) is untrusted and legacy. */
function parse(raw: string, version: 1 | 2 = 2): StoredHandoff | null {
  try {
    const value = JSON.parse(raw) as (Omit<Partial<StoredHandoff>, 'v'> & { v?: unknown }) | null;
    if (!value || typeof value !== 'object' || value.v !== version || typeof value.prompt !== 'string' || !value.prompt.trim()
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || (value.state !== 'pending' && value.state !== 'dispatched')) return null;
    if (version === 1) return { v: 2, prompt: value.prompt, createdAt: value.createdAt, state: value.state, untrusted: true, legacy: true };
    return { v: 2, prompt: value.prompt, createdAt: value.createdAt, state: value.state,
      ...(value.untrusted === true ? { untrusted: true as const } : {}), ...(value.legacy === true ? { legacy: true as const } : {}) };
  } catch { return null; }
}

/** Reads the stored request; a malformed entry is removed. `null` when there is none. */
function read(scope: PlanHandoffScope): StoredHandoff | null {
  const storage = sessionStore();
  if (!storage) return null;
  const key = keyOf(scope);
  const raw = storage.getItem(key);
  if (raw === null) {
    // One the old home handed over: moved under v2, untrusted and legacy (LEGACY_PLAN_HANDOFF_PREFIX).
    const legacyKey = keyOf(scope, LEGACY_PLAN_HANDOFF_PREFIX);
    const old = storage.getItem(legacyKey);
    if (old === null) return null;
    const moved = parse(old, 1);
    if (moved) storage.setItem(key, JSON.stringify(moved));
    storage.removeItem(legacyKey);
    return moved;
  }
  const value = parse(raw);
  if (!value) storage.removeItem(key);
  return value;
}

const fresh = (value: StoredHandoff, now: number) =>
  now - value.createdAt <= PLAN_HANDOFF_TTL_MS && value.createdAt - now <= CLOCK_TOLERANCE_MS;

/** Records the request for the canvas just created. False when this tab cannot store it; the
 * canvas then opens with an empty prompt box. */
/** `untrusted`: the request comes from a draft the old home box saved (homePrompt's homeDraftUntrusted), so the canvas
 * reads none of its addresses as the person's. */
export function savePlanHandoff(scope: PlanHandoffScope, prompt: string, now = Date.now(), untrusted = false): boolean {
  const text = prompt.trim();
  if (!text) return false;
  try {
    const storage = sessionStore();
    if (!storage) return false;
    const value: StoredHandoff = { v: 2, prompt: text, createdAt: now, state: 'pending', ...(untrusted ? { untrusted: true as const } : {}) };
    storage.removeItem(keyOf(scope, LEGACY_PLAN_HANDOFF_PREFIX));
    storage.setItem(keyOf(scope), JSON.stringify(value));
    return true;
  } catch { return false; }
}

/** What the canvas should do with a stored request. Read-only: taking it twice gives the same
 * answer, and only `claimPlanHandoff` decides who sends it. A sent request that never came back
 * reads as interrupted however old it is; a pending one starts only while it is fresh. */
export function takePlanHandoff(scope: PlanHandoffScope, now = Date.now()): PlanHandoff | null {
  try {
    const value = read(scope);
    if (!value) return null;
    const trust = value.untrusted ? { untrusted: true as const } : {};
    if (value.state === 'dispatched') return { prompt: value.prompt, start: false, interrupted: true, ...trust };
    // One the old home handed over is only restored to the box.
    return { prompt: value.prompt, start: !value.legacy && fresh(value, now), interrupted: false, ...trust };
  } catch { return null; }
}

/** Marks a fresh pending request as sent, synchronously, just before it is sent. True only for
 * the caller that made that change; a request that is already sent, expired or unreadable is
 * never sent again from here. */
export function claimPlanHandoff(scope: PlanHandoffScope, now = Date.now()): boolean {
  try {
    const storage = sessionStore();
    const value = read(scope);
    if (!storage || !value || value.legacy || value.state !== 'pending' || !fresh(value, now)) return false;
    storage.setItem(keyOf(scope), JSON.stringify({ ...value, state: 'dispatched' } satisfies StoredHandoff));
    return true;
  } catch { return false; }
}

/** Forgets the request once planning has ended, or once it was restored to the prompt box. */
export function clearPlanHandoff(scope: PlanHandoffScope): void {
  try { sessionStore()?.removeItem(keyOf(scope)); sessionStore()?.removeItem(keyOf(scope, LEGACY_PLAN_HANDOFF_PREFIX)); }
  catch { /* Nothing more can be done; an unreadable entry is never sent. */ }
}
