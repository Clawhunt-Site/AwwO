/** A code as the API takes it (local_links.go userCodePattern), typed any way: XXXX-XXXX, or '' for one that cannot be. */
export function linkCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^[BCDFGHJKMNPQRSTVWXZ2-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
}

/** The code AwwO 本地版 sent its person here with (/?link=CODE: docs/awwo-cloud-relay.md), carried across a sign-in that
 * leaves AwwO the way a workspace invitation is (pendingInvite.ts): in this tab's sessionStorage only, restored to the
 * address once, on the first plain landing after the sign-in, as 设置 → 本机连接 with the code filled in. The page
 * still asks for an explicit approval. */
export const PENDING_LINK_KEY = 'awwo.saas.pending-link.v1';
/** A code lives 15 minutes on the hosted site (local_links.go localLinkCodeTTL). */
export const PENDING_LINK_TTL_MS = 15 * 60_000;
// The same browser writes and reads the time, so only a small adjustment of its clock is tolerated.
const CLOCK_TOLERANCE_MS = 5_000;

type StoredLink = { v: 1; code: string; savedAt: number };

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Keeps a code this tab was sent with; anything that is not one is ignored. */
export function rememberPendingLink(value: unknown, now = Date.now()): void {
  const code = typeof value === 'string' ? linkCode(value) : '';
  if (!code) return;
  try { sessionStore()?.setItem(PENDING_LINK_KEY, JSON.stringify({ v: 1, code, savedAt: now } satisfies StoredLink)); }
  catch { /* This tab cannot store it; the person can type the code. */ }
}

function takePendingLink(now: number): string {
  const storage = sessionStore();
  if (!storage) return '';
  try {
    const raw = storage.getItem(PENDING_LINK_KEY);
    if (raw === null) return '';
    storage.removeItem(PENDING_LINK_KEY);
    const value = JSON.parse(raw) as Partial<StoredLink> | null;
    if (!value || value.v !== 1 || typeof value.code !== 'string' || !linkCode(value.code) || typeof value.savedAt !== 'number') return '';
    if (now - value.savedAt > PENDING_LINK_TTL_MS || value.savedAt - now > CLOCK_TOLERANCE_MS) return '';
    return linkCode(value.code);
  } catch { return ''; }
}

const linksPage = (code: string) => `/?account=links&code=${encodeURIComponent(code)}`;

/** Signed in: an address that names a code opens 本机连接 with it at once (and the stored one is spent); only the plain
 * landing a sign-in returns to (`/`) takes the stored code; any other address was chosen on purpose and is left alone. */
export function restorePendingLink(now = Date.now()): void {
  const named = new URLSearchParams(window.location.search).get('link');
  let code = '';
  if (named !== null) {
    takePendingLink(now);
    code = linkCode(named);
    if (!code) return;
  } else {
    if (window.location.pathname !== '/' || window.location.search || window.location.hash) return;
    code = takePendingLink(now);
    if (!code) return;
  }
  try { history.replaceState(history.state, '', linksPage(code)); }
  catch { /* The browser refused the history change; the person can type the code. */ }
}
