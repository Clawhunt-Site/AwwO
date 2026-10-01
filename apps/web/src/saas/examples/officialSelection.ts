import { getOfficialWorkflow } from './officialWorkflows';
import { clawHuntStartURL } from '../clawhuntAuth';

const KEY = 'awwo.official-selection.v1';
const MAX_AGE = 30 * 60 * 1000;

export function officialSignInURL(id: string, search: string): string {
  if (!getOfficialWorkflow(id)) return '/';
  const query = new URLSearchParams({ official: id });
  // Reuse the auth flow's bounded invitation validation; never carry arbitrary return URLs.
  const invite = new URLSearchParams(clawHuntStartURL(search).split('?')[1]).get('invite');
  if (invite) query.set('invite', invite);
  return `/?${query}`;
}

/** The OAuth redirect intentionally carries no arbitrary return URL. Only a curated public id
 * crosses sign-in, using tab-local storage with a short expiry. It never triggers a create. */
export function rememberOfficialSelection(id: string): void {
  if (!getOfficialWorkflow(id)) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* The URL still works for local sign-in. */ }
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
