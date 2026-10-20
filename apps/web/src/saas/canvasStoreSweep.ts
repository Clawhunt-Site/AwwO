import { canvasStore, canvasStoreAdoption, legacyRunGoingOn } from '../canvas/canvasStorage';

// Earlier releases kept every opened canvas's document, sync proof and records in localStorage, never removed, until the
// site's ~5 MB was full. Once this page uses the canvas store, it takes in what the other canvases left there, while the
// browser is idle: the large copies move out (see canvasStoreAdoption), the small records are copied (and leave once
// their bytes have not changed for a day, see canvasStore.ts LEGACY_COPY_MS). A reader's copy
// holds nothing but the server's document, so it is dropped. A canvas with an unsent draft or a run record from the last
// day (legacyRunGoingOn), or one a tab has open, is left as it is: its own opening takes those in.

const SCOPE = /^awwo\.saas:[^:]+:[^:]+:[^:]+:/;
const READER_SCOPE = /%2Fread-only:$/;
const DRAFTS = 'awwo.cloud.draft.v1:';
let swept = false;

function legacyScopes(storage: Storage, current: string): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    const prefix = key ? SCOPE.exec(key)?.[0] : undefined;
    if (!key || !prefix || prefix === current || !canvasStoreAdoption(key.slice(prefix.length))) continue;
    scopes.set(prefix, [...(scopes.get(prefix) ?? []), key]);
  }
  return scopes;
}

/** Take in (once per page) what earlier releases left in localStorage for canvases other than `current`. */
export async function moveLegacyCanvasStorage(current: string): Promise<void> {
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  if (!storage) return;
  for (const [prefix, keys] of legacyScopes(storage, current)) {
    if (READER_SCOPE.test(prefix)) {
      for (const key of keys) { try { storage.removeItem(key); } catch { /* Left in place. */ } }
      continue;
    }
    if (keys.some(key => key.slice(prefix.length).startsWith(DRAFTS)) || legacyRunGoingOn(prefix, storage)) continue;
    try { await canvasStore().moveLegacy(prefix, keys, canvasStoreAdoption); } catch { /* It moves when that canvas opens. */ }
  }
}

export function sweepLegacyCanvasStorage(current: string): void {
  if (swept) return;
  swept = true;
  const run = () => { void moveLegacyCanvasStorage(current).catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10000 });
  else setTimeout(run, 2000);
}
