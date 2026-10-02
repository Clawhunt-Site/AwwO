/** Only presentation preferences survive a round trip. Canvas records and access are always read
 * again from the server; cursor snapshots are deliberately not persisted. */
export type CanvasListView = { query: string; expanded: boolean };
export const CANVAS_SEARCH_MAX_LENGTH = 100;
const emptyView = (): CanvasListView => ({ query: '', expanded: false });
const key = (userId: string, tenantId: string) => `awwo.saas.canvas-list.v1:${encodeURIComponent(userId)}:${encodeURIComponent(tenantId)}`;

export function readCanvasListView(userId: string | undefined, tenantId: string): CanvasListView {
  if (!userId || !tenantId) return emptyView();
  try {
    const raw = window.sessionStorage.getItem(key(userId, tenantId));
    if (!raw || raw.length > 2048) return emptyView();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyView();
    const state = value as Record<string, unknown>;
    return { query: typeof state.query === 'string' ? state.query.slice(0, CANVAS_SEARCH_MAX_LENGTH) : '', expanded: state.expanded === true };
  } catch { return emptyView(); }
}

export function saveCanvasListView(userId: string | undefined, tenantId: string, view: CanvasListView): void {
  if (!userId || !tenantId) return;
  try {
    window.sessionStorage.setItem(key(userId, tenantId), JSON.stringify({ query: view.query.slice(0, CANVAS_SEARCH_MAX_LENGTH), expanded: view.expanded }));
  } catch { /* Search and expansion remain usable when the browser refuses storage. */ }
}
