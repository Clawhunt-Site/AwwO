/** A request typed on the workspace home, carried to the canvas it created. It lives in this tab's
 * sessionStorage only: the canvas page takes it, plans it once, and removes it when planning ends.
 *
 * `pending` has not been sent. `dispatched` was sent by a page that never reported back (it was
 * reloaded or closed mid-plan), so the next page restores the prompt instead of sending it again:
 * the earlier run may still be on the server, and a second one must be the operator's choice. */
export const PLAN_HANDOFF_PREFIX = 'awwo.saas.plan-handoff.v1';
/** A request older than this is only restored to the prompt box, never started. */
export const PLAN_HANDOFF_TTL_MS = 10 * 60_000;
// The same browser writes and reads the time, so only a small adjustment of its clock is tolerated.
const CLOCK_TOLERANCE_MS = 5_000;

export type PlanHandoffScope = { user: string; tenant: string; canvas: string };
type StoredHandoff = { v: 1; prompt: string; createdAt: number; state: 'pending' | 'dispatched' };
/** `start` is true only for a fresh request nobody has sent; `interrupted` marks one that was sent
 * and never came back. */
export type PlanHandoff = { prompt: string; start: boolean; interrupted: boolean };

const keyOf = ({ user, tenant, canvas }: PlanHandoffScope) =>
  `${PLAN_HANDOFF_PREFIX}:${[user, tenant, canvas].map(encodeURIComponent).join(':')}`;

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function parse(raw: string): StoredHandoff | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredHandoff> | null;
    if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.prompt !== 'string' || !value.prompt.trim()
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || (value.state !== 'pending' && value.state !== 'dispatched')) return null;
    return { v: 1, prompt: value.prompt, createdAt: value.createdAt, state: value.state };
  } catch { return null; }
}

/** Reads the stored request; a malformed entry is removed. `null` when there is none. */
function read(scope: PlanHandoffScope): StoredHandoff | null {
  const storage = sessionStore();
  if (!storage) return null;
  const key = keyOf(scope);
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value = parse(raw);
  if (!value) storage.removeItem(key);
  return value;
}

const fresh = (value: StoredHandoff, now: number) =>
  now - value.createdAt <= PLAN_HANDOFF_TTL_MS && value.createdAt - now <= CLOCK_TOLERANCE_MS;

/** Records the request for the canvas just created. False when this tab cannot store it; the
 * canvas then opens with an empty prompt box. */
export function savePlanHandoff(scope: PlanHandoffScope, prompt: string, now = Date.now()): boolean {
  const text = prompt.trim();
  if (!text) return false;
  try {
    const storage = sessionStore();
    if (!storage) return false;
    const value: StoredHandoff = { v: 1, prompt: text, createdAt: now, state: 'pending' };
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
    if (value.state === 'dispatched') return { prompt: value.prompt, start: false, interrupted: true };
    return { prompt: value.prompt, start: fresh(value, now), interrupted: false };
  } catch { return null; }
}

/** Marks a fresh pending request as sent, synchronously, just before it is sent. True only for
 * the caller that made that change; a request that is already sent, expired or unreadable is
 * never sent again from here. */
export function claimPlanHandoff(scope: PlanHandoffScope, now = Date.now()): boolean {
  try {
    const storage = sessionStore();
    const value = read(scope);
    if (!storage || !value || value.state !== 'pending' || !fresh(value, now)) return false;
    storage.setItem(keyOf(scope), JSON.stringify({ ...value, state: 'dispatched' } satisfies StoredHandoff));
    return true;
  } catch { return false; }
}

/** Forgets the request once planning has ended, or once it was restored to the prompt box. */
export function clearPlanHandoff(scope: PlanHandoffScope): void {
  try { sessionStore()?.removeItem(keyOf(scope)); }
  catch { /* Nothing more can be done; an unreadable entry is never sent. */ }
}
