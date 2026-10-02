import { mainSiteEnvironment, mainSiteURL, safeMainSiteURL } from './mainSite';

export type AuthOptions = {
  passwordRecovery?: boolean;
  clawhuntSSO?: boolean;
  localAuth?: boolean;
  clawhuntSiteURL?: string;
};

export type SSOReturn =
  | { kind: 'link' }
  | { kind: 'error'; reason: 'waitlisted' | 'expired' | 'unavailable' | 'conflict' | 'invalid_identity' };
export type SSOFailureReason = Exclude<SSOReturn, { kind: 'link' }>['reason'];

/** A workspace invitation token as the API accepts it (`identityInvitePattern`). */
export const isInviteToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
export function clawHuntStartURL(search: string): string {
  const invite = new URLSearchParams(search).get('invite');
  return isInviteToken(invite) ? `/api/v1/auth/clawhunt/start?invite=${encodeURIComponent(invite)}` : '/api/v1/auth/clawhunt/start';
}

/** A successful link can restore only the existing first-party invitation route. */
export function trustedAwwORedirectURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== '/' || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'invite' || !isInviteToken(url.searchParams.get('invite'))) return null;
    return url.pathname + url.search;
  } catch { return null; }
}

/** The callback carries only an outcome. OAuth codes and provider tokens never reach this page. */
export function readSSOReturn(search: string): SSOReturn | null {
  const query = new URLSearchParams(search);
  if (query.get('sso') === 'link') return { kind: 'link' };
  if (query.get('sso') !== 'error') return null;
  const reason = query.get('reason');
  if (reason === 'waitlisted' || reason === 'expired' || reason === 'unavailable' || reason === 'conflict' || reason === 'invalid_identity') {
    return { kind: 'error', reason };
  }
  return { kind: 'error', reason: 'unavailable' };
}

export function clearSSOReturnURL(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('sso') && !url.searchParams.has('reason')) return;
  url.searchParams.delete('sso');
  url.searchParams.delete('reason');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

function siteURL(value?: string): URL | null {
  const safe = safeMainSiteURL(value, mainSiteEnvironment()) || mainSiteURL;
  return safe ? new URL(safe) : null;
}

export function clawHuntAccountURL(value?: string): string | null {
  const site = siteURL(value);
  return site ? new URL('/account', site.origin).href : null;
}

/** The main-site page where a signed-in account redeems an AwwO invite code and continues in. */
export function clawHuntRedeemURL(value?: string): string | null {
  const site = siteURL(value);
  return site ? new URL('/awwo?from=signin', site.origin).href : null;
}

/** Only the main site's dedicated sign-out route may receive a one-time ticket. */
export function trustedClawHuntLogoutURL(value: unknown, siteValue?: string): string | null {
  // An already-revoked provider grant has nothing left to revoke upstream.
  // The server completes local sign-out with this exact first-party URL.
  if (value === new URL('/', window.location.origin).href) return value;
  const site = siteURL(siteValue);
  if (!site || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== site.origin || url.username || url.password || url.pathname !== '/api/awwo/sso/logout' || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (!url.searchParams.get('ticket') || keys.length !== 1 || keys[0] !== 'ticket') return null;
    return url.href;
  } catch { return null; }
}
