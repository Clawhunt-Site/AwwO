import { getOfficialWorkflow } from './officialWorkflows';
import { clawHuntStartURL } from '../clawhuntAuth';

const KEY = 'awwo.official-selection.v1';
const MAX_AGE = 30 * 60 * 1000;

export function officialExampleURL(id: string, search: string): string {
  if (!getOfficialWorkflow(id)) return '/?examples=1';
  const query = new URLSearchParams({ official: id });
  const invite = new URLSearchParams(clawHuntStartURL(search).split('?')[1]).get('invite');
  if (invite) query.set('invite', invite);
  query.set('examples', '1');
  return `/?${query}`;
}

export function officialSignInURL(id: string, search: string): string {
  if (!getOfficialWorkflow(id)) return '/';
  // Enter the same first-party SSO flow as the main sign-in action. Returning to
  // /?official=... only reopens and focuses the guest example, hiding sign-in again.
  // Selection stays tab-local; the auth URL carries only a validated invitation.
  return clawHuntStartURL(search);
}

/** The OAuth redirect intentionally carries no arbitrary return URL. The curated public id
 * stays in tab-local storage with a short expiry. It never triggers a create. */
export function rememberOfficialSelection(id: string): void {
  if (!getOfficialWorkflow(id)) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* Sign-in still works; reopening the example requires storage. */ }
}

export function readOfficialSelection(): string | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (value && typeof value.at === 'number' && value.at <= Date.now() && Date.now() - value.at < MAX_AGE && typeof value.id === 'string' && getOfficialWorkflow(value.id)) return value.id;
  } catch { /* Ignore unavailable storage and invalid data. */ }
  return undefined;
}

export function clearOfficialSelection(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* A completed copy is already saved by the API. */ }
}
