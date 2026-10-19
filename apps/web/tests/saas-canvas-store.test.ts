import { describe, expect, it } from 'vitest';
import { bytesHash, CANVAS_STORE_CHANNEL, createCanvasStore, type CanvasStoreOptions, type StoreRecord } from '../src/canvas/canvasStore';
import { CANVAS_STORAGE_KEY, CANVAS_BACKUP_KEY, emptyDocument } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY } from '../src/canvas/runJournal';
import { CANVAS_BASELINE_KEY, CANVAS_DRAFT_PREFIX, CANVAS_KEPT_DRAFTS_KEY, preserveLegacyCanvasCache, rememberCanvasBaseline } from '../src/saas/canvasDraft';
import { PLANNING_STORAGE_KEY } from '../src/canvas/canvasPlanning';
import { PAGE_REPAIR_STORAGE_KEY } from '../src/canvas/pageRepair';
import { CARD_FRAMES_KEY } from '../src/canvas/cardFrames';
import { CANVAS_MIRROR_GROUP, canvasStoreAdoption, keepLegacyCanvasCache, keptInCanvasStore } from '../src/canvas/canvasStorage';
import { channelHub, countedLocks, memoryBackend, quotaStorage, settle } from './saas-canvas-store-fakes';

const P = 'awwo.saas:user-a:tenant-a:canvas-a:';
const DOC = P + 'superclaw.canvas.v2';
const DRAFT = P + `${CANVAS_DRAFT_PREFIX}old-writer`;
const PLAN = P + PLANNING_STORAGE_KEY;
const VERSION = P + 'awwo.cloud.version';
const MOVED = String.fromCharCode(0) + 'moved';

type World = { backend: ReturnType<typeof memoryBackend>; hub: ReturnType<typeof channelHub>; locks: ReturnType<typeof countedLocks> };
function tab(shared: World, extra: Partial<CanvasStoreOptions> = {}) {
  const events: StorageEvent[] = [];
  const store = createCanvasStore({ backend: async () => shared.backend.backend, channel: shared.hub.channel, locks: shared.locks.locks,
    dispatch: event => { events.push(event as StorageEvent); }, flushDelay: 5, peerWait: 200, watchPage: false, ...extra });
  return { store, events };
}
function world(): World { return { backend: memoryBackend(), hub: channelHub(), locks: countedLocks() }; }
/** The same IndexedDB on a later visit: no tab of the earlier visit is still open. */
const nextVisit = (shared: World): World => ({ ...shared, hub: channelHub(), locks: countedLocks() });

describe('canvas store routing', () => {
  it('keeps exactly the large and cross-tab canvas keys in the store', () => {
    for (const name of [CANVAS_STORAGE_KEY, CANVAS_BACKUP_KEY, CANVAS_BASELINE_KEY, CANVAS_KEPT_DRAFTS_KEY, 'awwo.cloud.version',
      PLANNING_STORAGE_KEY, PAGE_REPAIR_STORAGE_KEY, `${CANVAS_DRAFT_PREFIX}writer`, CANVAS_RUN_JOURNAL_KEY, `${CANVAS_RUN_JOURNAL_KEY}.lane2`,
      `${CANVAS_RUN_JOURNAL_KEY}.corrupt.17`, 'awwo.canvas.manual-recovery.v1:c:a:n:t', 'awwo.canvas.conversation-presentation.v1:c:a:n:t']) {
      expect(keptInCanvasStore(name), name).toBe(true);
    }
    // Written straight to localStorage elsewhere, or small preferences: they stay there.
    for (const name of [CARD_FRAMES_KEY, 'awwo.canvas.planner-provider.v1', 'awwo.canvas.planning.run.v1:t:c',
      'awwo.execution.pending-submission.v1', 'awwo.execution.started-submission.v1', 'superclaw.studio.workflow.v1']) {
      expect(keptInCanvasStore(name), name).toBe(false);
      expect(canvasStoreAdoption(name), name).toBeNull();
    }
  });

  it('moves only the large copies out of localStorage, copies what an older page may still rewrite, and merges the version up', () => {
    expect(canvasStoreAdoption(`${CANVAS_DRAFT_PREFIX}writer`)).toBe('move');
    // Written by this release too: taken in only while nothing here wrote them since.
    for (const name of [CANVAS_STORAGE_KEY, CANVAS_BACKUP_KEY, CANVAS_BASELINE_KEY]) expect(canvasStoreAdoption(name), name).toBe('mirror');
    for (const name of [CANVAS_KEPT_DRAFTS_KEY, PLANNING_STORAGE_KEY, PAGE_REPAIR_STORAGE_KEY, CANVAS_RUN_JOURNAL_KEY, `${CANVAS_RUN_JOURNAL_KEY}.lane1`,
      'awwo.canvas.manual-recovery.v1:c:a:n:t', 'awwo.canvas.conversation-presentation.v1:c:a:n:t']) expect(canvasStoreAdoption(name), name).toBe('copy');
    expect(canvasStoreAdoption('awwo.cloud.version')).toBe('max');
  });
});

describe('canvas store', () => {
  it('serves its own writes at once and keeps them for the next visit', async () => {
    const shared = world();
    const a = tab(shared);
    await a.store.open(P);
    a.store.set(P, DOC, 'one');
    expect(a.store.get(P, DOC)).toBe('one');
    expect(shared.backend.value(DOC)).toBeNull();
    await a.store.flush();
    expect(shared.backend.value(DOC)).toBe('one');
    const later = tab(nextVisit(shared));
    await later.store.open(P);
    expect(later.store.get(P, DOC)).toBe('one');
    expect(later.store.keys(P)).toEqual([DOC]);
  });

  it('writes on its own shortly after a change, once per key however often it changes', async () => {
    const shared = world();
    const a = tab(shared, { flushDelay: 30 });
    await a.store.open(P);
    for (let index = 0; index < 20; index++) a.store.set(P, DOC, `v${index}`);
    await settle(20);
    expect(shared.backend.value(DOC)).toBe('v19');
    expect(shared.backend.writes).toHaveLength(1);
    expect(shared.backend.writes[0]).toHaveLength(1);
  });

  it('sends a write to another tab of the canvas, which sees it as a storage event', async () => {
    const shared = world();
    const a = tab(shared); const b = tab(shared);
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'from a');
    await settle();
    expect(b.store.get(P, DOC)).toBe('from a');
    expect(b.events.map(event => [event.type, event.key, event.oldValue, event.newValue])).toEqual([['storage', DOC, null, 'from a']]);
    // The writer itself is not told, as with localStorage.
    expect(a.events).toEqual([]);
    a.store.remove(P, DOC);
    await settle();
    expect(b.store.get(P, DOC)).toBeNull();
    expect(b.events.at(-1)?.newValue).toBeNull();
  });

  it('announces a run journal another tab writes under the key the run lanes listen for', async () => {
    const shared = world();
    const a = tab(shared); const b = tab(shared);
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, P + `${CANVAS_RUN_JOURNAL_KEY}.lane1`, '{"version":1}');
    await settle();
    expect(b.events.map(event => event.key)).toEqual([P + `${CANVAS_RUN_JOURNAL_KEY}.lane1`]);
  });

  it('does not write or announce a value that did not change', async () => {
    const shared = world();
    const a = tab(shared); const b = tab(shared);
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'same'); await settle(); await a.store.flush();
    const writes = shared.backend.writes.length; const events = b.events.length;
    a.store.set(P, DOC, 'same'); a.store.remove(P, P + 'never-written');
    await settle(); await a.store.flush();
    expect(shared.backend.writes.length).toBe(writes);
    expect(b.events.length).toBe(events);
  });

  it('gives a tab that opens later the writes other tabs have not stored yet, and only those', async () => {
    const shared = world();
    const a = tab(shared, { flushDelay: 60_000 });
    await a.store.open(P);
    a.store.set(P, PLAN, 'stored'); await a.store.flush();
    a.store.set(P, DOC, 'unsaved in a');
    expect(shared.backend.value(DOC)).toBeNull();
    const b = tab(shared);
    await b.store.open(P);
    expect(b.store.get(P, DOC)).toBe('unsaved in a');
    expect(b.store.get(P, PLAN)).toBe('stored');
    const state = shared.hub.sent.map(item => item.data as { type: string; records?: Array<{ k: string }> }).find(data => data.type === 'state');
    expect(state?.records?.map(record => record.k)).toEqual([DOC]);
  });

  it('waits only as long as the counted tabs take to answer', async () => {
    const shared = world();
    const a = tab(shared); await a.store.open(P);
    const b = tab(shared, { peerWait: 5000 });
    const started = Date.now();
    await b.store.open(P);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still takes a reply that comes after the wait, so its next write is not outranked unseen', async () => {
    const shared = world();
    const a = tab(shared, { flushDelay: 60_000 });
    await a.store.open(P);
    a.store.set(P, PLAN, 'a: busy');
    // a cannot answer in time: b's channel holds its reply back past b's wait.
    const held: Array<() => void> = [];
    const slowReplies = (name: string) => {
      const channel = shared.hub.channel(name);
      return { postMessage: (message: unknown) => channel.postMessage(message), close: () => channel.close(),
        get onmessage() { return channel.onmessage; },
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          channel.onmessage = handler && (event => {
            if ((event.data as { type?: string })?.type === 'state') held.push(() => handler(event)); else handler(event);
          });
        } };
    };
    const b = tab({ ...shared, hub: { ...shared.hub, channel: slowReplies } }, { peerWait: 50 });
    await b.store.open(P);
    expect(b.store.get(P, PLAN)).toBeNull();
    for (const release of held) release();
    expect(b.store.get(P, PLAN)).toBe('a: busy');
    b.store.set(P, PLAN, 'b: newer');
    await settle(); await a.store.flush(); await b.store.flush();
    expect(a.store.get(P, PLAN)).toBe('b: newer');
    expect(shared.backend.value(PLAN)).toBe('b: newer');
  });

  it('settles concurrent writes from two tabs on one value everywhere', async () => {
    const shared = world();
    const a = tab(shared); const b = tab(shared);
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'a wins?'); b.store.set(P, DOC, 'b wins?');
    await settle(); await a.store.flush(); await b.store.flush();
    expect(a.store.get(P, DOC)).toBe(b.store.get(P, DOC));
    expect(shared.backend.value(DOC)).toBe(a.store.get(P, DOC));
  });

  it('keeps a removal over an older write that reaches IndexedDB later', async () => {
    const shared = world();
    const slow = tab(shared, { flushDelay: 60_000 }); const quick = tab(shared);
    await slow.store.open(P); await quick.store.open(P);
    slow.store.set(P, DOC, 'old');
    await settle();
    quick.store.remove(P, DOC);
    await settle(); await quick.store.flush();
    expect(slow.store.get(P, DOC)).toBeNull();
    await slow.store.flush();
    expect(shared.backend.records.get(DOC)?.v).toBeNull();
    await shared.backend.backend.write([{ k: DOC, v: 'stale', c: 1, p: 'z', t: 0 }]);
    expect(shared.backend.value(DOC)).toBeNull();
    const later = tab(nextVisit(shared));
    await later.store.open(P);
    expect(later.store.get(P, DOC)).toBeNull();
    expect(later.store.keys(P)).toEqual([]);
  });

  it('ignores malformed, sparse, oversized and foreign messages', async () => {
    const shared = world();
    const a = tab(shared); await a.store.open(P);
    const intruder = shared.hub.channel('awwo.canvas-store.v1:' + P);
    const good = { k: DOC, v: 'x', c: 99, p: 'q', t: 0 };
    // eslint-disable-next-line no-sparse-arrays
    for (const records of [[{ k: DOC, v: 1 }], [, good], Array.from({ length: 10001 }, () => good), [{ ...good, c: 2 ** 53 - 1 }],
      [{ ...good, k: 'awwo.saas:user-b:t:c:superclaw.canvas.v2' }]]) intruder.postMessage({ type: 'set', records });
    intruder.postMessage('garbage');
    intruder.postMessage({ type: 'state', id: 'nobody-asked', to: 'other', records: [good] });
    await settle();
    expect(a.store.keys(P)).toEqual([]);
    expect(a.events).toEqual([]);
  });

  it('moves the large copies of the scope in, and removes them from localStorage only once IndexedDB has them', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'legacy doc');
    storage.setItem(DRAFT, 'legacy draft');
    storage.setItem(P + CARD_FRAMES_KEY, '{"n":1}');
    storage.setItem('awwo.saas:user-a:tenant-a:canvas-b:superclaw.canvas.v2', 'another canvas');
    shared.backend.hold();
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    expect(a.store.get(P, DOC)).toBe('legacy doc');
    expect(a.store.get(P, DRAFT)).toBe('legacy draft');
    expect(a.store.get(P, P + CARD_FRAMES_KEY)).toBeNull();
    expect(a.store.keys(P).sort()).toEqual([DOC, DRAFT].sort());
    await settle();
    expect(storage.getItem(DOC)).toBe('legacy doc');
    shared.backend.release();
    await settle(); await a.store.flush();
    expect(shared.backend.value(DOC)).toBe('legacy doc');
    expect(storage.getItem(DOC)).toBeNull();
    expect(storage.getItem(DRAFT)).toBeNull();
    expect(storage.getItem(P + CARD_FRAMES_KEY)).toBe('{"n":1}');
    expect(storage.getItem('awwo.saas:user-a:tenant-a:canvas-b:superclaw.canvas.v2')).toBe('another canvas');
  });

  it('never removes a moved draft from localStorage while no tab has stored it, even when a second tab opens', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DRAFT, 'the only copy of unsent edits');
    shared.backend.failWith(new DOMException('full', 'QuotaExceededError'));
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    await settle();
    const b = tab(shared, { legacy: storage });
    await b.store.open(P, canvasStoreAdoption);
    await new Promise(resolve => setTimeout(resolve, 1100)); await settle();
    await a.store.flush(); await b.store.flush();
    expect(storage.getItem(DRAFT)).toBe('the only copy of unsent edits');
    expect(shared.backend.value(DRAFT)).toBeNull();
    // Once IndexedDB takes it, the bytes leave localStorage.
    shared.backend.recover();
    await a.store.flush(); await settle(); await b.store.flush(); await settle();
    expect(shared.backend.value(DRAFT)).toBe('the only copy of unsent edits');
    expect(storage.getItem(DRAFT)).toBeNull();
  });

  it('removes moved bytes once another tab says it stored their move', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DRAFT, 'unsent edits');
    // a moves the bytes but its page goes away before it can remove them; its first write fails.
    const keeps = { getItem: storage.getItem.bind(storage), key: storage.key.bind(storage), get length() { return storage.length; }, removeItem: () => {} };
    shared.backend.failWith(new Error('momentary'), 1);
    const a = tab(shared, { legacy: keeps });
    await a.store.open(P, canvasStoreAdoption);
    await settle();
    // b opens meanwhile and holds the move only as a's unstored write: it may not remove the bytes yet.
    const b = tab(shared, { legacy: storage, flushDelay: 60_000 });
    await b.store.open(P, canvasStoreAdoption);
    await settle();
    expect(storage.getItem(DRAFT)).toBe('unsent edits');
    // a stores it and says so; b then removes the bytes.
    await new Promise(resolve => setTimeout(resolve, 1100)); await settle();
    expect(shared.backend.value(DRAFT)).toBe('unsent edits');
    expect(storage.getItem(DRAFT)).toBeNull();
  });

  it('does not let bytes a page left behind overwrite what was written since they moved', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'moved once');
    // The page that moved them closed before it could remove them.
    const first = tab(shared, { legacy: { ...storage, getItem: storage.getItem.bind(storage), key: storage.key.bind(storage),
      get length() { return storage.length; }, removeItem: () => {} } });
    await first.store.open(P, canvasStoreAdoption);
    await first.store.flush(); await settle();
    first.store.set(P, DOC, 'edited since'); await first.store.flush();
    expect(storage.getItem(DOC)).toBe('moved once');
    const later = tab(nextVisit(shared), { legacy: storage });
    await later.store.open(P, canvasStoreAdoption);
    expect(later.store.get(P, DOC)).toBe('edited since');
    await later.store.flush(); await settle();
    expect(storage.getItem(DOC)).toBeNull();
  });

  it('never takes a document cache that an earlier release\'s tab wrote later over the one this release wrote, and lets those bytes go', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'cache of the earlier release');
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    expect(a.store.get(P, DOC)).toBe('cache of the earlier release');
    await a.store.flush(); await settle();
    expect(storage.getItem(DOC)).toBeNull();
    // This release writes the cache (the hosted canvas writes the server's document on opening); a tab of the earlier
    // release that is still open saves its own document again.
    a.store.set(P, DOC, 'written by this release'); await a.store.flush();
    storage.setItem(DOC, 'written later by the earlier release');
    const seen = a.events.length;
    const b = tab(shared, { legacy: storage });
    await b.store.open(P, canvasStoreAdoption);
    await b.store.flush(); await settle();
    // Neither this tab nor the running one sees its cache change under it; the earlier release's bytes leave localStorage.
    expect(b.store.get(P, DOC)).toBe('written by this release');
    expect(a.store.get(P, DOC)).toBe('written by this release');
    expect(a.events.slice(seen).map(event => event.key)).not.toContain(DOC);
    expect(shared.backend.value(DOC)).toBe('written by this release');
    expect(storage.getItem(DOC)).toBeNull();
  });

  describe('the document group (cache, backup, sync proof), as the hosted app opens it', () => {
    const BASELINE = P + CANVAS_BASELINE_KEY;
    const doc = (at: number) => JSON.stringify({ ...emptyDocument(), updatedAt: at });
    const legacyScope = (storage: Storage) => ({ getItem: (k: string) => storage.getItem(P + k), setItem: (k: string, v: string) => storage.setItem(P + k, v),
      removeItem: (k: string) => storage.removeItem(P + k), keys: () => [] as string[] });
    const hosted = (shared: World, storage: Storage, extra: Partial<CanvasStoreOptions> = {}) => tab(shared, { legacy: storage,
      mirrorGroup: CANVAS_MIRROR_GROUP, preserveLegacy: preserveLegacyCanvasCache, keepLegacy: keepLegacyCanvasCache, ...extra });
    const legacyDrafts = (store: ReturnType<typeof tab>['store']) => store.keys(P).filter(key => key.startsWith(P + `${CANVAS_DRAFT_PREFIX}legacy-cache-`));

    it('keeps a later cache of the earlier release that its own sync proof does not cover as a draft, never dropping it', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1)); storage.setItem(VERSION, '7');
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      // A tab of the earlier release edits; its draft write fails on the full localStorage: the cache is the only copy.
      storage.setItem(DOC, doc(3));
      const b = hosted(nextVisit(shared), storage);
      await b.store.open(P, canvasStoreAdoption);
      await b.store.flush(); await settle();
      expect(b.store.get(P, DOC)).toBe(doc(2));
      const kept = legacyDrafts(b.store);
      expect(kept).toHaveLength(1);
      const draft = JSON.parse(b.store.get(P, kept[0])!);
      expect([draft.schemaVersion, draft.dirty, draft.baseVersion, draft.document.updatedAt]).toEqual([1, true, 7, 3]);
      expect(shared.backend.value(kept[0])).not.toBeNull();
      expect(storage.getItem(DOC)).toBeNull();
    });

    it('keeps no draft for a later cache that holds nothing more than this store\'s cache, a draft that tab wrote, or unreadable bytes', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1)); storage.setItem(VERSION, '7');
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      const opening = async () => {
        const b = hosted(nextVisit(shared), storage);
        await b.store.open(P, canvasStoreAdoption);
        await b.store.flush(); await settle();
        return b.store;
      };
      // The same document as this store's cache (the key order differs: an edit of the earlier release appended a key).
      const reordered = JSON.parse(doc(2)) as Record<string, unknown>;
      storage.setItem(DOC, JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse())));
      expect(legacyDrafts(await opening())).toEqual([]);
      expect(storage.getItem(DOC)).toBeNull();
      // The same document as that tab's own draft, which carries its true base.
      storage.setItem(DOC, doc(5));
      storage.setItem(P + `${CANVAS_DRAFT_PREFIX}old-tab`, JSON.stringify({ schemaVersion: 1, writerId: 'old-tab', revision: 'r', baseVersion: 6,
        dirty: true, updatedAt: 1, document: JSON.parse(doc(5)) }));
      const withDraft = await opening();
      expect(legacyDrafts(withDraft)).toEqual([]);
      expect(withDraft.get(P, P + `${CANVAS_DRAFT_PREFIX}old-tab`)).not.toBeNull();
      // Bytes that are no canvas document.
      storage.setItem(DOC, '{"version":2,"nodes":');
      expect(legacyDrafts(await opening())).toEqual([]);
      expect(storage.getItem(DOC)).toBeNull();
    });

    it('leaves a later cache untouched when keeping it fails, still opens the canvas, and keeps it at a later opening', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1));
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      storage.setItem(DOC, doc(3));
      const b = hosted(nextVisit(shared), storage, { preserveLegacy: () => { throw new Error('broken'); } });
      await b.store.open(P, canvasStoreAdoption);
      await b.store.flush(); await settle();
      expect(b.store.get(P, DOC)).toBe(doc(2));
      expect(storage.getItem(DOC)).toBe(doc(3));
      const c = hosted(nextVisit(shared), storage);
      await c.store.open(P, canvasStoreAdoption);
      await c.store.flush(); await settle();
      expect(legacyDrafts(c.store)).toHaveLength(1);
      expect(storage.getItem(DOC)).toBeNull();
    });

    it('marks a kept cache as export only, with the version key as its stated base', () => {
      const { storage } = quotaStorage();
      storage.setItem(VERSION, '9');
      const kept = preserveLegacyCanvasCache(P, doc(3), storage, doc(2));
      expect(kept).not.toBeNull();
      const draft = JSON.parse(kept!.value);
      expect([draft.legacyCache, draft.baseVersion, draft.writerId.startsWith('legacy-cache-')]).toEqual([true, 9, true]);
      expect(kept!.key).toBe(P + `${CANVAS_DRAFT_PREFIX}${draft.writerId}`);
    });

    it('drops a later cache of the earlier release that its own sync proof covers', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1));
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      // That tab saved version 8 and wrote its sync proof for it.
      storage.setItem(DOC, doc(3)); storage.setItem(VERSION, '8');
      rememberCanvasBaseline(legacyScope(storage) as never, 8, JSON.parse(doc(3)));
      const b = hosted(nextVisit(shared), storage);
      await b.store.open(P, canvasStoreAdoption);
      await b.store.flush(); await settle();
      expect(legacyDrafts(b.store)).toEqual([]);
      expect(b.store.get(P, DOC)).toBe(doc(2));
      expect(storage.getItem(DOC)).toBeNull();
    });

    it('never takes the sync proof without the document it proves', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1));
      rememberCanvasBaseline(legacyScope(storage) as never, 7, JSON.parse(doc(1)));
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      const proof = a.store.get(P, BASELINE);
      expect(proof).not.toBeNull();
      // This release rewrites the document; the proof's bytes stay the same (nothing new to prove yet).
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      // The earlier release's tab saves version 8: a new document and a new proof in localStorage.
      storage.setItem(DOC, doc(3));
      rememberCanvasBaseline(legacyScope(storage) as never, 8, JSON.parse(doc(3)));
      const b = hosted(nextVisit(shared), storage);
      await b.store.open(P, canvasStoreAdoption);
      await b.store.flush(); await settle();
      expect(b.store.get(P, DOC)).toBe(doc(2));
      expect(b.store.get(P, BASELINE)).toBe(proof);
      expect(storage.getItem(BASELINE)).toBeNull();
    });

    it('leaves the group as it is while a run record of its canvas is in localStorage, and decides at a later opening', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1));
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      await a.store.flush(); await settle();
      // A tab of the earlier release runs a node and writes its cache as the run goes on.
      storage.setItem(P + CANVAS_RUN_JOURNAL_KEY, '{"run":"under way"}');
      storage.setItem(DOC, doc(4));
      const b = hosted(nextVisit(shared), storage);
      await b.store.open(P, canvasStoreAdoption);
      await b.store.flush(); await settle();
      expect(b.store.get(P, DOC)).toBe(doc(1));
      expect(legacyDrafts(b.store)).toEqual([]);
      expect(storage.getItem(DOC)).toBe(doc(4));
      // The run is over (the record is gone): nothing here wrote the document since, so that tab's last cache comes in.
      storage.removeItem(P + CANVAS_RUN_JOURNAL_KEY);
      const c = hosted(nextVisit(shared), storage);
      await c.store.open(P, canvasStoreAdoption);
      await c.store.flush(); await settle();
      expect(c.store.get(P, DOC)).toBe(doc(4));
      expect(storage.getItem(DOC)).toBeNull();
    });

    it('keeps such a cache for recovery when the idle sweep takes another canvas in, too', async () => {
      const shared = world();
      const { storage } = quotaStorage();
      storage.setItem(DOC, doc(1)); storage.setItem(VERSION, '7');
      const a = hosted(shared, storage);
      await a.store.open(P, canvasStoreAdoption);
      a.store.set(P, DOC, doc(2)); await a.store.flush(); await settle();
      storage.setItem(DOC, doc(3));
      const sweeper = hosted(nextVisit(shared), storage);
      await sweeper.store.moveLegacy(P, [DOC], canvasStoreAdoption);
      expect(shared.backend.value(DOC)).toBe(doc(2));
      const kept = [...shared.backend.records.keys()].filter(key => key.startsWith(P + `${CANVAS_DRAFT_PREFIX}legacy-cache-`));
      expect(kept).toHaveLength(1);
      expect(JSON.parse(shared.backend.value(kept[0])!).document.updatedAt).toBe(3);
      expect(storage.getItem(DOC)).toBeNull();
    });
  });

  it('gives a canvas back to its tabs when a sweep\'s IndexedDB read never answers', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const Q = 'awwo.saas:user-a:tenant-a:canvas-q:';
    storage.setItem(Q + `${CANVAS_DRAFT_PREFIX}w`, 'a draft');
    const a = tab(shared, { legacy: storage, loadTimeout: 100,
      backend: async () => ({ ...shared.backend.backend, load: () => new Promise<StoreRecord[]>(() => {}) }) });
    const started = Date.now();
    await a.store.moveLegacy(Q, [Q + `${CANVAS_DRAFT_PREFIX}w`], canvasStoreAdoption);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(shared.locks.held.filter(lock => lock.name === CANVAS_STORE_CHANNEL + Q)).toEqual([]);
    expect(storage.getItem(Q + `${CANVAS_DRAFT_PREFIX}w`)).toBe('a draft');
  });

  it('sweeps a canvas only alone: not while a tab holds it or another page sweeps it, and a sweep is not counted as a tab', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const Q = 'awwo.saas:user-a:tenant-a:canvas-q:';
    storage.setItem(Q + `${CANVAS_DRAFT_PREFIX}w`, 'a draft');
    const a = tab(shared, { legacy: storage });
    // Another page is sweeping Q right now.
    let finish!: () => void;
    const other = shared.locks.locks.request(CANVAS_STORE_CHANNEL + Q, { mode: 'exclusive' }, () => new Promise<void>(resolve => { finish = resolve; }));
    await a.store.moveLegacy(Q, [Q + `${CANVAS_DRAFT_PREFIX}w`], canvasStoreAdoption);
    expect(shared.backend.value(Q + `${CANVAS_DRAFT_PREFIX}w`)).toBeNull();
    // A tab opening Q meanwhile asks no one: the sweeping page holds no writes of Q.
    const sent = shared.hub.sent.length;
    const b = tab(shared, { legacy: quotaStorage().storage, peerWait: 5000 });
    const started = Date.now();
    await b.store.open(Q);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(shared.hub.sent.slice(sent).some(message => (message.data as { type?: string }).type === 'hydrate')).toBe(false);
    finish(); await other;
  });

  it('leaves the document cache in localStorage while a run record of its canvas is there, and lets it go after the run', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const LANE = P + `${CANVAS_RUN_JOURNAL_KEY}.lane1`;
    storage.setItem(DOC, 'the cache a running tab of the earlier release saves over');
    storage.setItem(LANE, '{"run":"under way"}');
    storage.setItem(DRAFT, 'its draft');
    const a = tab(shared, { legacy: storage, keepLegacy: keepLegacyCanvasCache });
    await a.store.open(P, canvasStoreAdoption);
    await a.store.flush(); await settle();
    expect(a.store.get(P, DOC)).toBe('the cache a running tab of the earlier release saves over');
    expect(shared.backend.value(DOC)).toBe('the cache a running tab of the earlier release saves over');
    expect(storage.getItem(DOC)).toBe('the cache a running tab of the earlier release saves over');
    expect(storage.getItem(DRAFT)).toBeNull();
    // The run ends (that tab removes its record): the next write here lets the cache go.
    storage.removeItem(LANE);
    a.store.set(P, PLAN, '{"draft":"next"}'); await a.store.flush(); await settle();
    expect(storage.getItem(DOC)).toBeNull();
  });

  it('counts a run record, not the kept copy of a damaged one, as a run that keeps the document cache', () => {
    const { storage } = quotaStorage();
    expect(keepLegacyCanvasCache(DOC, storage)).toBe(false);
    storage.setItem(P + `${CANVAS_RUN_JOURNAL_KEY}.corrupt.17`, '{');
    storage.setItem('awwo.saas:user-a:tenant-a:canvas-b:' + CANVAS_RUN_JOURNAL_KEY, '{"run":"another canvas"}');
    expect(keepLegacyCanvasCache(DOC, storage)).toBe(false);
    storage.setItem(P + CANVAS_RUN_JOURNAL_KEY, '{"run":"under way"}');
    expect(keepLegacyCanvasCache(DOC, storage)).toBe(true);
    expect(keepLegacyCanvasCache(DRAFT, storage)).toBe(false);
  });

  it('takes another canvas\'s bytes in below anything a tab that opened that canvas meanwhile wrote', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const Q = 'awwo.saas:user-a:tenant-a:canvas-q:';
    storage.setItem(Q + CANVAS_STORAGE_KEY, 'stale cache in localStorage');
    // A fresh tab opens canvas Q, takes the stale cache in, then writes the server's document.
    const fresh = tab(shared, { legacy: storage });
    await fresh.store.open(Q, canvasStoreAdoption);
    fresh.store.set(Q, Q + CANVAS_STORAGE_KEY, 'the server\'s document'); await fresh.store.flush(); await settle();
    // Another page sweeps Q as if it had looked before that tab opened it: no holder yet, nothing stored. It has
    // edited another canvas a great deal, so its own clock is far ahead.
    const sweeper = tab({ ...shared, locks: countedLocks() }, { legacy: storage,
      backend: async () => ({ ...shared.backend.backend, load: async (prefix: string) => prefix === Q ? [] : shared.backend.backend.load(prefix) }) });
    await sweeper.store.open(P);
    for (let index = 0; index < 50; index++) sweeper.store.set(P, DOC, `edit ${index}`);
    await sweeper.store.flush();
    storage.setItem(Q + CANVAS_STORAGE_KEY, 'stale cache in localStorage');
    await sweeper.store.moveLegacy(Q, [Q + CANVAS_STORAGE_KEY], canvasStoreAdoption);
    await settle();
    expect(fresh.store.get(Q, Q + CANVAS_STORAGE_KEY)).toBe('the server\'s document');
    expect(shared.backend.value(Q + CANVAS_STORAGE_KEY)).toBe('the server\'s document');
  });

  it('loses a tie with a write of the same counter that a tab which opened the canvas meanwhile made', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const Q = 'awwo.saas:user-a:tenant-a:canvas-q:';
    storage.setItem(Q + CANVAS_STORAGE_KEY, 'stale cache in localStorage');
    const sweeper = tab({ ...shared, locks: countedLocks() }, { legacy: storage, page: 'zzzz-sweeper',
      backend: async () => ({ ...shared.backend.backend, async load(prefix: string) {
        const before = await shared.backend.backend.load(prefix);
        // Between this read and the sweep's write, a tab opens Q and writes just above what was stored.
        shared.backend.records.set(Q + CANVAS_STORAGE_KEY, { k: Q + CANVAS_STORAGE_KEY, v: 'written by the tab that opened', c: 1, p: 'aaaa-tab', t: 1 });
        return before;
      } }) });
    await sweeper.store.moveLegacy(Q, [Q + CANVAS_STORAGE_KEY], canvasStoreAdoption);
    expect(shared.backend.value(Q + CANVAS_STORAGE_KEY)).toBe('written by the tab that opened');
  });

  it('leaves another canvas\'s document cache in localStorage while a run record of it is there', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const Q = 'awwo.saas:user-a:tenant-a:canvas-q:';
    storage.setItem(Q + CANVAS_STORAGE_KEY, 'cache of a canvas a tab of the earlier release runs');
    storage.setItem(Q + CANVAS_RUN_JOURNAL_KEY, '{"run":"started after the sweep listed its keys"}');
    const a = tab(shared, { legacy: storage, keepLegacy: keepLegacyCanvasCache });
    await a.store.moveLegacy(Q, [Q + CANVAS_STORAGE_KEY], canvasStoreAdoption);
    expect(shared.backend.value(Q + CANVAS_STORAGE_KEY)).toBe('cache of a canvas a tab of the earlier release runs');
    expect(storage.getItem(Q + CANVAS_STORAGE_KEY)).toBe('cache of a canvas a tab of the earlier release runs');
  });

  it('stores another tab\'s write itself when that tab never stores it', async () => {
    const shared = world();
    // a's IndexedDB writes never finish (its page crashed while writing).
    const a = tab(shared, { backend: async () => ({ ...shared.backend.backend, write: () => new Promise<void>(() => {}) }) });
    const b = tab(shared, { peerStoreDelay: 50 });
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'only in memory');
    await settle();
    expect(b.store.get(P, DOC)).toBe('only in memory');
    expect(shared.backend.value(DOC)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 120)); await b.store.flush(); await settle();
    expect(shared.backend.value(DOC)).toBe('only in memory');
  });

  it('leaves another tab\'s write to that tab while it stores it in time', async () => {
    const shared = world();
    const a = tab(shared);
    const b = tab(shared, { peerStoreDelay: 200 });
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'stored by a');
    await a.store.flush(); await settle();
    const writes = shared.backend.writes.length;
    await new Promise(resolve => setTimeout(resolve, 300)); await b.store.flush(); await settle();
    expect(shared.backend.writes.length).toBe(writes);
  });

  it('does not let a second tab opening before the move is stored revert the first tab\'s newer write', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(PLAN, '{"draft":"from the earlier release"}');
    const a = tab(shared, { legacy: storage, flushDelay: 60_000 });
    await a.store.open(P, canvasStoreAdoption);
    a.store.set(P, PLAN, '{"draft":"typed in a since"}');
    const b = tab(shared, { legacy: storage });
    await b.store.open(P, canvasStoreAdoption);
    await settle();
    expect(b.store.get(P, PLAN)).toBe('{"draft":"typed in a since"}');
    expect(a.store.get(P, PLAN)).toBe('{"draft":"typed in a since"}');
  });

  it('copies what a page of the earlier release may still rewrite, keeps it in localStorage, and takes its later bytes only while unchanged here', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const RECOVERY = P + 'awwo.canvas.manual-recovery.v1:c:a:n:t';
    storage.setItem(RECOVERY, '{"records":[1]}');
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    await a.store.flush(); await settle();
    expect(a.store.get(P, RECOVERY)).toBe('{"records":[1]}');
    expect(storage.getItem(RECOVERY)).toBe('{"records":[1]}');
    // The old page appends to the full set it still reads.
    storage.setItem(RECOVERY, '{"records":[1,2]}');
    const b = tab(nextVisit(shared), { legacy: storage });
    await b.store.open(P, canvasStoreAdoption);
    expect(b.store.get(P, RECOVERY)).toBe('{"records":[1,2]}');
    // Once this release writes the record, the old page's later bytes no longer win.
    b.store.set(P, RECOVERY, '{"records":[1,2,3]}'); await b.store.flush();
    storage.setItem(RECOVERY, '{"records":[1,2,"old"]}');
    const c = tab(nextVisit(shared), { legacy: storage });
    await c.store.open(P, canvasStoreAdoption);
    expect(c.store.get(P, RECOVERY)).toBe('{"records":[1,2,3]}');
    expect(storage.getItem(RECOVERY)).toBe('{"records":[1,2,"old"]}');
  });

  it('keeps the larger version and leaves it in localStorage', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(VERSION, '7');
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    expect(a.store.get(P, VERSION)).toBe('7');
    a.store.set(P, VERSION, '9'); await a.store.flush();
    // An older page still on 8 never lowers it.
    storage.setItem(VERSION, '8');
    const b = tab(nextVisit(shared), { legacy: storage });
    await b.store.open(P, canvasStoreAdoption);
    expect(b.store.get(P, VERSION)).toBe('9');
    storage.setItem(VERSION, '12');
    const c = tab(nextVisit(shared), { legacy: storage });
    await c.store.open(P, canvasStoreAdoption);
    expect(c.store.get(P, VERSION)).toBe('12');
    await c.store.flush(); await settle();
    expect(storage.getItem(VERSION)).toBe('12');
  });

  it('records what it took in beside each key, without showing the record as a key', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'bytes');
    const a = tab(shared, { legacy: storage });
    await a.store.open(P, canvasStoreAdoption);
    await a.store.flush();
    expect(JSON.parse(shared.backend.value(DOC + MOVED)!).h).toEqual([bytesHash('bytes')]);
    expect(a.store.keys(P)).toEqual([DOC]);
  });

  it('reports a full disk at once, also to a listener added later, keeps the edit and stores it when there is room', async () => {
    const shared = world();
    const a = tab(shared);
    const failures: Array<[unknown, readonly string[]]> = [];
    a.store.onFailure((error, prefixes) => { failures.push([error, prefixes]); });
    await a.store.open(P);
    const full = new DOMException('full', 'QuotaExceededError');
    shared.backend.failWith(full, 1);
    a.store.set(P, DOC, 'kept');
    await a.store.flush();
    expect(failures).toEqual([[full, [P]]]);
    const later: unknown[] = [];
    a.store.onFailure(error => { later.push(error); });
    await settle();
    expect(later).toEqual([full]);
    expect(a.store.get(P, DOC)).toBe('kept');
    expect(shared.backend.value(DOC)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await settle();
    expect(shared.backend.value(DOC)).toBe('kept');
    // Stored again: a listener added now is not told of the old refusal.
    const fresh: unknown[] = [];
    a.store.onFailure(error => { fresh.push(error); });
    await settle();
    expect(fresh).toEqual([]);
  });

  it('tells listeners of other failures only once they persist', async () => {
    const shared = world();
    const a = tab(shared);
    const failures: unknown[] = [];
    a.store.onFailure(error => { failures.push(error); });
    await a.store.open(P);
    shared.backend.failWith(new Error('momentary'), 2);
    a.store.set(P, DOC, 'x');
    await a.store.flush(); await a.store.flush();
    expect(failures).toEqual([]);
    await a.store.flush();
    expect(failures).toEqual([]);
    expect(shared.backend.value(DOC)).toBe('x');
    shared.backend.failWith(new Error('broken'));
    a.store.set(P, DOC, 'y');
    await a.store.flush(); await a.store.flush(); await a.store.flush();
    expect(failures).toHaveLength(1);
    expect(a.store.get(P, DOC)).toBe('y');
  });

  it('writes what is pending at once when the page is hidden or left, without waiting for a write under way', async () => {
    const shared = world();
    const a = tab(shared, { watchPage: true, flushDelay: 60_000 });
    await a.store.open(P);
    a.store.set(P, DOC, 'first');
    shared.backend.hold();
    void a.store.flush();
    a.store.set(P, DOC, 'typed just before closing');
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(shared.backend.commits).toContain(true);
    expect(shared.backend.value(DOC)).toBe('typed just before closing');
    shared.backend.release();
    await settle();
    expect(shared.backend.value(DOC)).toBe('typed just before closing');
  });

  it('counts a write stored as the page is hidden as a success, so one later hiccup does not pause autosave', async () => {
    const shared = world();
    const a = tab(shared, { watchPage: true, flushDelay: 60_000 });
    const told: unknown[] = [];
    a.store.onFailure(error => { told.push(error); });
    await a.store.open(P);
    shared.backend.failWith(new Error('momentary'), 2);
    a.store.set(P, DOC, 'one'); await a.store.flush(); await a.store.flush();
    shared.backend.recover();
    window.dispatchEvent(new Event('pagehide')); await settle();
    expect(shared.backend.value(DOC)).toBe('one');
    shared.backend.failWith(new Error('momentary'), 1);
    a.store.set(P, DOC, 'two'); await a.store.flush();
    expect(told).toEqual([]);
    await a.store.flush();
    expect(shared.backend.value(DOC)).toBe('two');
  });

  it('refuses to open a scope where the browser has no IndexedDB', async () => {
    const store = createCanvasStore({ backend: async () => null, watchPage: false });
    expect(await store.available()).toBe(false);
    await expect(store.open(P)).rejects.toThrow('IndexedDB is unavailable');
    expect(store.isOpen(P)).toBe(false);
    expect(() => store.get(P, DOC)).toThrow('not open');
  });

  it('does not keep a canvas loading forever when IndexedDB never answers', async () => {
    const shared = world();
    const stuck = { ...shared.backend.backend, load: () => new Promise<never>(() => {}) };
    const a = createCanvasStore({ backend: async () => stuck, channel: shared.hub.channel, locks: shared.locks.locks, watchPage: false, loadTimeout: 50 });
    await expect(a.open(P)).rejects.toThrow('IndexedDB did not answer');
    expect(a.isOpen(P)).toBe(false);
  });

  it('keeps a memory scope in memory only, optionally copying what localStorage holds', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'from localStorage');
    storage.setItem(P + CARD_FRAMES_KEY, 'frames');
    const a = tab(shared, { legacy: storage });
    a.store.openMemory(P, { from: storage, adopt: keptInCanvasStore });
    expect(a.store.inMemory(P)).toBe(true);
    expect(a.store.holdsStoredScopes()).toBe(false);
    expect(a.store.get(P, DOC)).toBe('from localStorage');
    expect(a.store.get(P, P + CARD_FRAMES_KEY)).toBeNull();
    a.store.set(P, DOC, 'edited');
    await settle(); await a.store.flush();
    expect(shared.backend.records.size).toBe(0);
    expect(shared.hub.sent).toEqual([]);
    expect(storage.getItem(DOC)).toBe('from localStorage');
    await expect(a.store.open(P)).rejects.toThrow('memory only');
  });

  it('moves another canvas\'s large copies in without opening it, copies its small records, and a canvas a tab holds is left alone', async () => {
    const shared = world();
    const { storage } = quotaStorage();
    const other = 'awwo.saas:user-a:tenant-a:canvas-b:';
    storage.setItem(other + 'superclaw.canvas.v2', 'b doc');
    storage.setItem(other + PLANNING_STORAGE_KEY, 'plan');
    const a = tab(shared, { legacy: storage });
    await a.store.moveLegacy(other, [other + 'superclaw.canvas.v2', other + PLANNING_STORAGE_KEY], canvasStoreAdoption);
    expect(shared.backend.value(other + 'superclaw.canvas.v2')).toBe('b doc');
    expect(shared.backend.value(other + PLANNING_STORAGE_KEY)).toBe('plan');
    expect(storage.getItem(other + 'superclaw.canvas.v2')).toBeNull();
    expect(storage.getItem(other + PLANNING_STORAGE_KEY)).toBe('plan');
    // Moved bytes a page brings back later are recognised and only removed.
    storage.setItem(other + 'superclaw.canvas.v2', 'b doc');
    await a.store.moveLegacy(other, [other + 'superclaw.canvas.v2'], canvasStoreAdoption);
    expect(storage.getItem(other + 'superclaw.canvas.v2')).toBeNull();
    // A canvas another tab holds is that tab's to take in.
    const held = 'awwo.saas:user-a:tenant-a:canvas-c:';
    const b = tab(shared); await b.store.open(held);
    storage.setItem(held + 'superclaw.canvas.v2', 'c doc');
    await a.store.moveLegacy(held, [held + 'superclaw.canvas.v2'], canvasStoreAdoption);
    expect(storage.getItem(held + 'superclaw.canvas.v2')).toBe('c doc');
    expect(shared.backend.value(held + 'superclaw.canvas.v2')).toBeNull();
  });

  it('forgets a deleted canvas everywhere, above writes another tab still has pending', async () => {
    const shared = world();
    const a = tab(shared); const b = tab(shared, { flushDelay: 60_000 });
    await a.store.open(P); await b.store.open(P);
    a.store.set(P, DOC, 'doc'); a.store.set(P, DRAFT, 'draft');
    await settle(); await a.store.flush();
    b.store.set(P, PLAN, 'pending in b');
    await settle();
    await a.store.forget(P);
    await settle(); await b.store.flush();
    expect(a.store.keys(P)).toEqual([]);
    expect(b.store.keys(P)).toEqual([]);
    expect([...shared.backend.records.values()].filter(record => record.v !== null)).toEqual([]);
    const other = 'awwo.saas:user-a:tenant-a:canvas-z:';
    await shared.backend.backend.write([{ k: other + 'superclaw.canvas.v2', v: 'z', c: 4, p: 'q', t: 1 }]);
    await a.store.forget(other);
    expect(shared.backend.value(other + 'superclaw.canvas.v2')).toBeNull();
  });

  it('outranks, when it forgets a canvas it does not hold, the newer writes a tab of that canvas has not stored', async () => {
    const shared = world();
    const b = tab(shared, { flushDelay: 60_000 });
    await b.store.open(P);
    b.store.set(P, DOC, 'stored'); await b.store.flush();
    for (let index = 0; index < 100; index++) b.store.set(P, DOC, `pending ${index}`);
    // Another page (on the canvas list) deletes the canvas: it reads IndexedDB, where only the first write is.
    const list = tab(shared);
    await list.store.forget(P);
    await settle(); await b.store.flush();
    expect(b.store.get(P, DOC)).toBeNull();
    expect(shared.backend.value(DOC)).toBeNull();
  });

  it('drops tombstones older than thirty days a while after a scope opens', async () => {
    const shared = world();
    await shared.backend.backend.write([{ k: DOC, v: null, c: 3, p: 'q', t: 0 }, { k: P + 'fresh', v: null, c: 3, p: 'q', t: Date.now() }]);
    const a = tab(shared, { pruneDelay: 10 });
    await a.store.open(P);
    await settle();
    expect(shared.backend.records.has(DOC)).toBe(false);
    expect(shared.backend.records.has(P + 'fresh')).toBe(true);
  });
});
