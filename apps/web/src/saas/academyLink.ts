/** The Academy's place in the address: `?academy` opens it, `?academy=<video>` opens that video in it (Academy.tsx). */
export const ACADEMY_PARAM = 'academy';

/** The video an address asks for: '' for the Academy itself, null when it asks for nothing. */
export function readAcademyLink(search: string = window.location.search): string | null {
  const params = new URLSearchParams(search);
  return params.has(ACADEMY_PARAM) ? params.get(ACADEMY_PARAM) ?? '' : null;
}

/** The address's query with the Academy's part: `academy` for the Academy, `academy=<video>` for one of its videos,
 * nothing for null; every other part as it was. */
export function academySearch(search: string, value: string | null): string {
  const params = new URLSearchParams(search);
  params.delete(ACADEMY_PARAM);
  const rest = params.toString();
  if (value === null) return rest ? `?${rest}` : '';
  const own = value ? `${ACADEMY_PARAM}=${encodeURIComponent(value)}` : ACADEMY_PARAM;
  return `?${rest ? `${rest}&` : ''}${own}`;
}

/** Puts the Academy's part into the address in place, with no new history entry. */
export function writeAcademyLink(value: string | null): void {
  history.replaceState(history.state, '', window.location.pathname + academySearch(window.location.search, value) + window.location.hash);
}
