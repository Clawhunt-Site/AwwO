import { compactCanvasBaselinesForUser, isCanvasStorageQuotaError } from '../saas/canvasBaselineCompression';
import { createCanvasStore, type Adoption, type CanvasStore } from './canvasStore';
import { openCanvasStoreDatabase } from './canvasStoreIdb';

/** An optional SaaS namespace. Legacy local development retains its original keys. */
let scope = '';
const scopeOf = (userId: string, tenantId: string, canvasId: string) => [userId, tenantId, canvasId].map(encodeURIComponent).join(':');
export function configureCanvasStorage(userId: string, tenantId: string, canvasId: string): void {
  scope = scopeOf(userId, tenantId, canvasId);
}
/** Every key of one account's canvas in one workspace starts with this. */
export function canvasStoragePrefix(userId: string, tenantId: string, canvasId: string): string {
  return `awwo.saas:${scopeOf(userId, tenantId, canvasId)}:`;
}
export function canvasStorageKey(key: string): string { return scope ? `awwo.saas:${scope}:${key}` : key; }
/** Every key of one account's canvases in one workspace starts with this (and so do the workspace's own few facts). */
export function workspaceStoragePrefix(userId: string, tenantId: string): string {
  return `awwo.saas:${[userId, tenantId].map(encodeURIComponent).join(':')}:`;
}
/** A canvas id as the API makes them ("a" and 32 base64url characters), alone or as a reader's copy. */
const STORED_CANVAS = /^(a[A-Za-z0-9_-]{32})(\/read-only)?$/;
/** The canvas a key under `within` (a workspaceStoragePrefix) belongs to, a reader's copy counting as its canvas's; null
 * for a key of no canvas (the workspace's facts sit under the same prefix). */
export function canvasOfStorageKey(key: string, within: string): string | null {
  if (!key.startsWith(within)) return null;
  const rest = key.slice(within.length);
  const end = rest.indexOf(':');
  if (end <= 0 || end === rest.length - 1) return null;
  let segment: string;
  try { segment = decodeURIComponent(rest.slice(0, end)); } catch { return null; }
  return STORED_CANVAS.exec(segment)?.[1] ?? null;
}
/** A key for one signed-in account's browser preference, or null outside a SaaS account scope. */
export function userStorageKey(key: string): string | null {
  const user = scope.split(':')[0];
  return user ? `awwo.saas:${user}:${key}` : null;
}
/** The same account and workspace namespace without the canvas, for small facts that describe how
 * this workspace behaves rather than one canvas (such as how long its plans take). A fact's name never starts with a
 * canvas id and a colon: that is how the deleted-canvas sweep tells a canvas's keys from these (canvasOfStorageKey). */
export function workspaceStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const captured = scope.split(':').slice(0, 2).join(':');
  const keyOf = (key: string) => captured ? `awwo.saas:${captured}:${key}` : key;
  return { getItem: key => localStorage.getItem(keyOf(key)), setItem: (key, value) => localStorage.setItem(keyOf(key), value) };
}

// Once a hosted canvas opens, these keys live in the canvas store (IndexedDB, see canvasStore.ts) instead of
// localStorage: the document and its backup, drafts, the sync proof and version, run journals, recovery records and the
// planning conversation. They are the large values and the ones tabs read together with them. Every other key, and
// every key written straight to localStorage elsewhere (card frames, planner runs, pending submissions), stays there.
const STORE_KEYS = new Set(['superclaw.canvas.v2', 'superclaw.canvas.v2.corrupt', 'awwo.cloud.kept-drafts.v1', 'awwo.cloud.baseline.v1',
  'awwo.cloud.version', 'awwo.canvas.planning.v1', 'awwo.canvas.page-repair.v1']);
const STORE_PREFIXES = ['awwo.cloud.draft.v1:', 'awwo.canvas.active-run.v1', 'awwo.canvas.manual-recovery.v1:', 'awwo.canvas.conversation-presentation.v1:'];
export function keptInCanvasStore(name: string): boolean {
  return STORE_KEYS.has(name) || STORE_PREFIXES.some(prefix => name.startsWith(prefix));
}
/** How a key an earlier release left in localStorage comes into the store. A page of that release may still be open:
 * the large copies move out to free the space (its drafts always; the document, its backup and the sync proof, which
 * this release writes too, only while nothing here has written them since they were last taken in); the records it
 * reads and rewrites (version, reviewed drafts, run journals, recovery and presentation records, planning, page
 * repairs) are copied and stay while that page may still be working on them (until their bytes have not changed for a
 * day), the version merged up. */
export function canvasStoreAdoption(name: string): Adoption | null {
  if (!keptInCanvasStore(name)) return null;
  if (name === 'awwo.cloud.version') return 'max';
  if (name.startsWith('awwo.cloud.draft.v1:')) return 'move';
  if (name === 'superclaw.canvas.v2' || name === 'superclaw.canvas.v2.corrupt' || name === 'awwo.cloud.baseline.v1') return 'mirror';
  return 'copy';
}
/** How long an earlier release's run record counts as a run its tab may still be on: none runs or watches one this long. */
const LEGACY_RUN_MS = 24 * 3600 * 1000;
/** Whether an earlier release left a run record of the canvas under `prefix` that started less than a day ago (its
 * `startedAt`): a tab of that release may still be running a node or watching that run. That release took a record it
 * could not read for no run, and such a tab removes its record when the run ends; a record copied into the store stays
 * in localStorage, so without the age an old one would hold the canvas's cache there for good. */
export function legacyRunGoingOn(prefix: string, legacy: Pick<Storage, 'getItem' | 'key' | 'length'>, now = Date.now()): boolean {
  const runs = prefix + 'awwo.canvas.active-run.v1';
  for (let index = 0; index < legacy.length; index++) {
    const name = legacy.key(index);
    // A damaged record's kept copy (….corrupt.<time>) is no run.
    if (!name?.startsWith(runs) || name.includes('.corrupt.')) continue;
    let started: unknown;
    try { started = (JSON.parse(legacy.getItem(name) ?? 'null') as { startedAt?: unknown } | null)?.startedAt; } catch { continue; }
    // A time ahead of this clock counts as recent.
    if (typeof started === 'number' && Number.isFinite(started) && now - started < LEGACY_RUN_MS) return true;
  }
  return false;
}
/** The document cache stays in localStorage while such a run may be going on: a tab of the earlier release that is
 * running a node or watching a run saves its edits only over the cache it last wrote, and pauses when it is gone. */
export function keepLegacyCanvasCache(key: string, legacy: Pick<Storage, 'getItem' | 'key' | 'length'>): boolean {
  return key.endsWith(':superclaw.canvas.v2') && legacyRunGoingOn(key.slice(0, -'superclaw.canvas.v2'.length), legacy);
}

/** The document cache first: the group decides by it (see canvasStore.ts mirrorGroup). */
export const CANVAS_MIRROR_GROUP = ['superclaw.canvas.v2', 'superclaw.canvas.v2.corrupt', 'awwo.cloud.baseline.v1'] as const;
type PreserveLegacy = (prefix: string, raw: string, legacy: Pick<Storage, 'getItem' | 'key' | 'length'>, current: string | null) => { key: string; value: string } | null;
let preserveLegacy: PreserveLegacy | null = null;
/** How the hosted app keeps an earlier release's document cache that is not taken in (it knows drafts and sync proofs). */
export function setLegacyCachePreservation(next: PreserveLegacy | null): void { preserveLegacy = next; }
/** The store's hook: whatever the hosted app set, else nothing kept. */
export const preserveRegisteredLegacyCache: PreserveLegacy = (prefix, raw, legacy, current) => preserveLegacy?.(prefix, raw, legacy, current) ?? null;

let store: CanvasStore | null = null;
function browserLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
/** This page's canvas store. */
export function canvasStore(): CanvasStore {
  if (store) return store;
  store = createCanvasStore({
    backend: () => openCanvasStoreDatabase(),
    legacy: browserLocalStorage(),
    keepLegacy: keepLegacyCanvasCache,
    mirrorGroup: CANVAS_MIRROR_GROUP,
    preserveLegacy: preserveRegisteredLegacyCache,
    channel: name => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name),
    locks: typeof navigator === 'undefined' ? null : navigator.locks ?? null,
  });
  // Restored from the back/forward cache, a page has missed its other tabs' writes: read everything again.
  if (typeof window !== 'undefined') window.addEventListener('pageshow', event => { if (event.persisted && store?.holdsStoredScopes()) window.location.reload(); });
  return store;
}
/** Tests run on a store of their own (or none: localStorage only). */
export function setCanvasStoreForTests(next: CanvasStore | null): void { store = next; }

/** Tabs share the store's writes over a BroadcastChannel and count each other with Web Locks; without them (an old
 * browser) a canvas stays in localStorage, whose tabs see each other's writes. */
function tabsCanShare(): boolean {
  return typeof BroadcastChannel === 'function' && typeof navigator !== 'undefined'
    && typeof navigator.locks?.request === 'function' && typeof navigator.locks?.query === 'function';
}

/** Whether this page keeps hosted canvases in the store (IndexedDB, tabs able to share). */
export async function canvasStoreUsable(): Promise<boolean> {
  return tabsCanShare() && canvasStore().available();
}

/** Read a hosted canvas's storage before the canvas uses it. 'local' where the browser has no IndexedDB: the canvas
 * then keeps using localStorage as it always did. 'memory': this page already keeps the canvas in its memory only
 * (localStorage was full on an earlier opening): nothing it writes survives the page. */
export async function openCanvasStorage(userId: string, tenantId: string, canvasId: string): Promise<'store' | 'local' | 'memory'> {
  const target = canvasStore();
  const prefix = canvasStoragePrefix(userId, tenantId, canvasId);
  if (target.inMemory(prefix)) return 'memory';
  if (!tabsCanShare() || !(await target.available())) return 'local';
  await target.open(prefix, canvasStoreAdoption);
  return 'store';
}
/** Keep a canvas's storage in this page's memory: a read-only view, or (copying what localStorage holds) a page whose
 * localStorage is full where the browser has no IndexedDB. Nothing kept this way survives the page. */
export function openCanvasStorageInMemory(userId: string, tenantId: string, canvasId: string, copyFromLocalStorage = false): void {
  const from = copyFromLocalStorage ? browserLocalStorage() : null;
  canvasStore().openMemory(canvasStoragePrefix(userId, tenantId, canvasId), from ? { from, adopt: keptInCanvasStore } : undefined);
}
/** A deleted canvas leaves nothing behind: every key of the editor's and the reader's copy, in both storages. */
export async function forgetCanvasStorage(userId: string, tenantId: string, canvasId: string): Promise<void> {
  const local = browserLocalStorage();
  for (const id of [canvasId, `${canvasId}/read-only`]) {
    const prefix = canvasStoragePrefix(userId, tenantId, id);
    if (local) {
      const keys = Array.from({ length: local.length }, (_, index) => local.key(index)).filter((key): key is string => key !== null && key.startsWith(prefix));
      for (const key of keys) { try { local.removeItem(key); } catch { /* Left for the browser to clear. */ } }
    }
    try { await canvasStore().forget(prefix); } catch { /* IndexedDB keeps it; the canvas no longer opens. */ }
  }
}

export function canvasStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys(): string[] } {
  // Capture the namespace so a pending operation cannot cross a later account boundary.
  const captured = scope;
  const capturedUser = captured.split(':')[0];
  const userPrefix = capturedUser ? `awwo.saas:${capturedUser}:` : '';
  const keyOf = (key: string) => captured ? `awwo.saas:${captured}:${key}` : key;
  const prefix = keyOf('');
  // Asked on every call: the canvas opens in the store after this storage was handed out.
  const opened = () => captured && store?.isOpen(prefix) ? store : null;
  const storeFor = (key: string) => keptInCanvasStore(key) ? opened() : null;
  return {
    getItem: key => {
      const target = storeFor(key);
      return target ? target.get(prefix, keyOf(key)) : localStorage.getItem(keyOf(key));
    },
    setItem: (key, value) => {
      const storageKey = keyOf(key);
      const target = storeFor(key);
      if (target) target.set(prefix, storageKey, value);
      else {
        try { localStorage.setItem(storageKey, value); }
        catch (error) {
          if (!isCanvasStorageQuotaError(error) || !userPrefix
            || compactCanvasBaselinesForUser(localStorage, userPrefix) === 0) throw error;
          // Only losslessly compact optional proofs, then retry the original write.
          // A failed retry must still surface, without broadcasting a saved cache.
          localStorage.setItem(storageKey, value);
        }
      }
      window.dispatchEvent(new CustomEvent('awwo:canvas-cache-write', { detail: { key, storageKey } }));
    },
    removeItem: key => {
      const target = storeFor(key);
      if (target) target.remove(prefix, keyOf(key)); else localStorage.removeItem(keyOf(key));
    },
    keys: () => {
      const local = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key): key is string => key !== null && key.startsWith(prefix)).map(key => key.slice(prefix.length));
      const target = opened();
      if (!target) return local;
      return [...target.keys(prefix).map(key => key.slice(prefix.length)), ...local.filter(name => !keptInCanvasStore(name))];
    },
  };
}
