import { canvasOfStorageKey, canvasStoragePrefix, canvasStore, canvasStoreUsable, workspaceStoragePrefix } from '../canvas/canvasStorage';
import { api, SaaSApiError, tenantPath } from './api';
import { CANVAS_DRAFT_PREFIX } from './canvasDraft';
import { listPage, type ListPage } from './listPage';

// What this browser still keeps of canvases a workspace no longer has: the editor's and the reader's copies of a canvas
// deleted elsewhere (another device, a teammate), or deleted before the list's delete forgot its copies. Earlier
// releases kept them in localStorage; the canvas store then took them into IndexedDB, where they stayed (4.2 million
// characters for eight deleted canvases in one profile, 2026-10-19). A canvas missing from the workspace's whole list is
// forgotten once the server answers that it is gone (a delete there is final), unless a tab has it open. Its unsent
// drafts stay: its page still offers them for export.

/** Canvases asked about per sweep: each is one request, and a workspace's deleted canvases are few. */
export const MAX_CANVAS_CHECKS = 20;
/** Canvases read per sweep (each alone with it): the tombstones a month of deleted canvases leaves are read again on
 * every visit until they expire, so a sweep reads at most this many, from a random start (the rest on later visits). */
export const MAX_CANVAS_READS = 50;
/** Pages of 200 read past the list's first page; a longer list is not swept. */
const MAX_LIST_PAGES = 10;
/** Under the workspace prefix (no canvas key): when a list longer than its first page and one more read was last read
 * whole for this, at most once a day. */
export const CANVAS_STORAGE_SWEPT_KEY = 'awwo.canvas-store.swept.v2';
/** The earlier release's record, which held every longer list's daily read: removed. */
const EARLIER_SWEPT_KEY = 'awwo.canvas-store.swept.v1';
const DAY_MS = 24 * 3600 * 1000;
/** Account and workspace pairs this page has swept (once a page). */
const swept = new Set<string>();

function localKeys(within: string): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(within));
  } catch { return []; }
}

/** The ids of the list past its first page, read on from that page's cursor (valid across views and page sizes): one
 * read of 200 on every visit, all of it for a workspace of up to 250 canvases; a list longer still is read on at most
 * once a day. Null when it is not read whole now. */
async function restOfList(tenantId: string, cursor: string, within: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let next: string | null = cursor;
  for (let page = 0; page < MAX_LIST_PAGES && next; page++) {
    if (page === 1) {
      if (readRecently(within)) return null;
      // Recorded before the read, whatever it gives; where it cannot be recorded, it would be read on every visit.
      rememberRead(within);
      if (!readRecently(within)) return null;
    }
    const result: ListPage<{ id: string }> = await listPage<{ id: string }>(tenantPath(tenantId, '/canvases?view=summary'), next, undefined, 200);
    for (const item of result.items) ids.add(item.id);
    next = result.nextCursor ?? null;
  }
  return next ? null : ids;
}

function readRecently(within: string): boolean {
  // A time ahead of this clock (the clock set back since) is no recent read.
  try { const age = Date.now() - Number(localStorage.getItem(within + CANVAS_STORAGE_SWEPT_KEY)); return age >= 0 && age < DAY_MS; } catch { return false; }
}
function rememberRead(within: string): void {
  try { localStorage.setItem(within + CANVAS_STORAGE_SWEPT_KEY, String(Date.now())); } catch { /* Not read then (see below). */ }
}

/** What the copies under the prefixes hold once the keys `forgets` picks are removed, each read alone with it (the
 * store's forgetIdle, which also drops expired tombstones); null while a tab has the canvas open. */
async function idleCopies(prefixes: readonly string[], forgets: (key: string) => boolean): Promise<string[] | null> {
  const left: string[] = [];
  for (const prefix of prefixes) {
    const kept = await canvasStore().forgetIdle(prefix, forgets);
    if (!kept) return null;
    left.push(...kept);
  }
  return left;
}

/** Forget the copies of the account's canvases in the workspace that the server answers 404 for, among those not in the
 * list (`firstPage`, its ids; `nextCursor`, the cursor after it, null when the list has no further page: the rest is
 * read first, see restOfList). Returns the canvases forgotten. */
export async function forgetDeletedCanvasStorage(userId: string, tenantId: string, firstPage: Iterable<string>, nextCursor: string | null): Promise<string[]> {
  const pair = JSON.stringify([userId, tenantId]);
  if (swept.has(pair)) return [];
  swept.add(pair);
  // Only where tabs share the store: there a canvas open in a tab holds its lock, and nothing is removed under it.
  if (!(await canvasStoreUsable())) return [];
  const within = workspaceStoragePrefix(userId, tenantId);
  try { localStorage.removeItem(within + EARLIER_SWEPT_KEY); } catch { /* Left: nothing reads it. */ }
  // A store that cannot say what it keeps is left alone.
  const stored = await canvasStore().storedKeys(within).catch(() => null);
  if (!stored) return [];
  const keys = [...localKeys(within), ...stored];
  const known = new Set(firstPage);
  const unlisted = () => {
    const ids = new Set<string>();
    for (const key of keys) {
      const canvasId = canvasOfStorageKey(key, within);
      if (canvasId && !known.has(canvasId)) ids.add(canvasId);
    }
    return ids;
  };
  let candidates = unlisted();
  if (!candidates.size) return [];
  if (nextCursor) {
    const rest = await restOfList(tenantId, nextCursor, within).catch(() => null);
    if (!rest) return [];
    for (const id of rest) known.add(id);
    candidates = unlisted();
  }
  const forgotten: string[] = [];
  const order = [...candidates];
  const start = Math.floor(Math.random() * order.length);
  let asked = 0;
  let reads = 0;
  for (let index = 0; index < order.length; index++) {
    if (asked >= MAX_CANVAS_CHECKS || reads >= MAX_CANVAS_READS) break;
    const canvasId = order[(start + index) % order.length];
    const editor = canvasStoragePrefix(userId, tenantId, canvasId);
    const reader = canvasStoragePrefix(userId, tenantId, `${canvasId}/read-only`);
    const forgets = (key: string) => !key.startsWith(editor + CANVAS_DRAFT_PREFIX) && !key.startsWith(reader + CANVAS_DRAFT_PREFIX);
    const prefixes = [editor, reader].filter(prefix => keys.some(key => key.startsWith(prefix)));
    // Nothing but drafts kept here, in either storage: nothing to ask about.
    if (!keys.some(key => prefixes.some(prefix => key.startsWith(prefix)) && forgets(key))) continue;
    reads += 1;
    let held: string[] | null;
    // What the canvas still holds (its expired tombstones dropped meanwhile); storage that fails is left for another visit.
    try { held = await idleCopies(prefixes, () => false); } catch { break; }
    // Open in a tab, or holding nothing but drafts and what was removed before (its tombstones).
    if (!held?.some(forgets)) continue;
    asked += 1;
    try {
      await api(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}`), { method: 'HEAD' });
      continue; // There after all: created since the list was read.
    } catch (error) {
      // Only a canvas the server says is gone is forgotten; anything else is asked about again another time.
      if (!(error instanceof SaaSApiError && error.status === 404)) break;
    }
    try { if (await idleCopies(prefixes, forgets)) forgotten.push(canvasId); } catch { break; }
  }
  return forgotten;
}

/** Tests sweep the same pair again. */
export function resetCanvasStorageEvictionForTests(): void { swept.clear(); }
