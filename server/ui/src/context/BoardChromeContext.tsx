import { createContext, useContext, type ReactNode } from "react";

/**
 * How the board's in-company primary navigation is presented:
 *  - `"sidebar"` (default) — the board's own left vertical rail/sidebar.
 *  - `"top-nav"` — a horizontal grouped tab bar across the top. Requested by an
 *    embedding host (super's Team panel) that owns the surrounding shell (back
 *    button, account/theme). PRESENTATION ONLY: every tab navigates an existing
 *    route; no business semantics change.
 *
 * This is deliberately a SEPARATE context from `EmbeddedHostContext`. The chrome
 * choice must not flip any of the board's embed-gated *behaviors* (create/
 * onboarding routing, company-menu visibility): the embed keeps `embeddedHost`
 * null so the onboarding wizard still mounts and create flows are unchanged —
 * only the nav layout differs.
 */
export type BoardChrome = "sidebar" | "top-nav";

const BoardChromeContext = createContext<BoardChrome>("sidebar");

export function BoardChromeProvider({
  chrome,
  children,
}: {
  chrome: BoardChrome;
  children: ReactNode;
}) {
  return <BoardChromeContext.Provider value={chrome}>{children}</BoardChromeContext.Provider>;
}

export function useBoardChrome(): BoardChrome {
  return useContext(BoardChromeContext);
}
