/** Opening a homepage case from outside its card: from another part of the page (the Academy's "Open the case"), through
 * the case library that is on the page, or from a link, `?case=<id>`, which the library opens once it is there. */
export const CASE_PARAM = 'case';

type Opener = (id: string) => boolean;
const openers = new Set<Opener>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/** The case library on the page registers how it opens a case; the returned function unregisters it. */
export function registerCaseOpener(opener: Opener): () => void {
  openers.add(opener);
  changed();
  return () => { openers.delete(opener); changed(); };
}

/** Opens the case in the library on this page; false when the page has none, or it has no such case. */
export function openCase(id: string): boolean {
  for (const opener of openers) if (opener(id)) return true;
  return false;
}

/** Whether the page has a case library, for useSyncExternalStore with subscribeCaseOpeners: a page can show one after a
 * part that asks has drawn (the workspace home page, once the session is known). */
export function canOpenCase(): boolean { return openers.size > 0; }
export function subscribeCaseOpeners(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The home page of a workspace (the landing page with none) with the case opened. */
export function caseURL(id: string, tenant?: string): string {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  query.set(CASE_PARAM, id);
  return `/?${query}`;
}

/** The case a link asks for, taken out of the address so that a reload or a later visit does not open it again. */
export function takeCaseLink(): string | null {
  const url = new URL(window.location.href);
  const id = url.searchParams.get(CASE_PARAM);
  if (id === null) return null;
  url.searchParams.delete(CASE_PARAM);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return id;
}
