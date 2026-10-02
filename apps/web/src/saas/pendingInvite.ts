/** A workspace invitation token as the API accepts it: `identityInvitePattern` in
 * backend/internal/app/clawhunt_identity.go, and the same check in clawhuntAuth.ts. */
const isInviteToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);

/** A workspace invitation opened while signed out, carried across a sign-in that leaves AwwO.
 * An account without AwwO access is sent to ClawHunt to redeem an invite code, and the way back is
 * a fresh sign-in that no longer carries the invitation. It lives in this tab's sessionStorage
 * only: the first plain landing after sign-in restores it to the address bar, once, and the
 * invitation page still asks for an explicit acceptance. */
export const PENDING_INVITE_KEY = 'awwo.saas.pending-invite.v1';
/** Long enough to register on ClawHunt and redeem a code; short enough that a shared browser does
 * not offer someone's invitation to the next person to sign in there. */
export const PENDING_INVITE_TTL_MS = 30 * 60_000;
// The same browser writes and reads the time, so only a small adjustment of its clock is tolerated.
const CLOCK_TOLERANCE_MS = 5_000;

type StoredInvite = { v: 1; token: string; savedAt: number };

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Keeps a valid invitation token for this tab; anything else is ignored. */
export function rememberPendingInvite(token: unknown, now = Date.now()): void {
  if (!isInviteToken(token)) return;
  try { sessionStore()?.setItem(PENDING_INVITE_KEY, JSON.stringify({ v: 1, token, savedAt: now } satisfies StoredInvite)); }
  catch { /* This tab cannot store it; the invitation link itself still works. */ }
}

/** The stored invitation while it is fresh, removed in the same step so it is restored only once.
 * A stale or malformed entry is removed too. */
export function takePendingInvite(now = Date.now()): string | null {
  const storage = sessionStore();
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_INVITE_KEY);
    if (raw === null) return null;
    storage.removeItem(PENDING_INVITE_KEY);
    const value = JSON.parse(raw) as Partial<StoredInvite> | null;
    if (!value || typeof value !== 'object' || value.v !== 1 || !isInviteToken(value.token)
      || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null;
    if (now - value.savedAt > PENDING_INVITE_TTL_MS || value.savedAt - now > CLOCK_TOLERANCE_MS) return null;
    return value.token;
  } catch { return null; }
}

export function forgetPendingInvite(): void {
  try { sessionStore()?.removeItem(PENDING_INVITE_KEY); }
  catch { /* Nothing more can be done; it expires on its own. */ }
}

/** After a sign-in completes: an address that already names an invitation wins and replaces the
 * stored one; only the plain landing a sign-in returns to (`/`) takes the stored invitation, and
 * any other address was chosen on purpose, so it is left alone. */
export function restorePendingInvite(now = Date.now()): void {
  if (new URLSearchParams(window.location.search).has('invite')) {
    forgetPendingInvite();
    return;
  }
  if (window.location.pathname !== '/' || window.location.search || window.location.hash) return;
  const token = takePendingInvite(now);
  if (!token) return;
  try { history.replaceState(history.state, '', `/?invite=${encodeURIComponent(token)}`); }
  catch { /* The browser refused the history change; sign-in must not fail for it, and the link still works. */ }
}
