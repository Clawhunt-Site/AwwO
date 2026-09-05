import { useSyncExternalStore } from 'react';

// Thin host<->board navigation bridge. The embedded company board (CompanyBoard) owns
// its own in-memory router, so super's team-page topbar can't read or drive it directly.
// The board publishes its current nav level (the full-page company directory "home" vs a
// specific company's workspace) here, and registers a "go back to the directory" callback;
// super's topbar reads the level to render the back hierarchy and calls goToCompanyList()
// to step up. This keeps the back-navigation hierarchy in super's chrome (one place) — the
// vendored board's own breadcrumb is left untouched.

export interface BoardNavState {
  /** True when the board is inside a specific company (not on the directory home). */
  inCompany: boolean;
  /** Display name of the current company, when inside one. */
  companyName: string | null;
}

let state: BoardNavState = { inCompany: false, companyName: null };
let homeNav: (() => void) | null = null;
const listeners = new Set<() => void>();

export function publishBoardNav(next: BoardNavState): void {
  if (next.inCompany === state.inCompany && next.companyName === state.companyName) return;
  state = next;
  for (const listener of listeners) listener();
}

/** The board registers how to navigate back to the directory home; null on unmount. */
export function registerBoardHomeNav(fn: (() => void) | null): void {
  homeNav = fn;
}

/** Super's topbar calls this to send the board back to the company directory. */
export function goToCompanyList(): void {
  homeNav?.();
}

export function useBoardNavState(): BoardNavState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => state,
    () => state,
  );
}
