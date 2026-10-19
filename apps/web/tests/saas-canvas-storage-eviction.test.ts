import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canvasOfStorageKey, setCanvasStoreForTests, workspaceStoragePrefix } from '../src/canvas/canvasStorage';
import { createCanvasStore } from '../src/canvas/canvasStore';
import { CANVAS_STORAGE_SWEPT_KEY, MAX_CANVAS_CHECKS, MAX_CANVAS_READS, forgetDeletedCanvasStorage, resetCanvasStorageEvictionForTests } from '../src/saas/canvasStorageEviction';
import { channelHub, countedLocks, memoryBackend, quotaStorage } from './saas-canvas-store-fakes';

// What this browser keeps of canvases a workspace no longer has, forgotten once the server says they are gone.
const W = workspaceStoragePrefix('user-a', 'tenant-a');
/** A canvas id as the API makes them: "a" and 32 base64url characters. */
const id = (n: number) => 'a' + String(n).padStart(32, 'x');
const editor = (canvas: string) => `${W}${canvas}:`;
const reader = (canvas: string) => `${W}${encodeURIComponent(`${canvas}/read-only`)}:`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let local: ReturnType<typeof quotaStorage>;
let backend: ReturnType<typeof memoryBackend>;
let hub: ReturnType<typeof channelHub>;
let locks: ReturnType<typeof countedLocks>;
let heads: string[];
let lists: string[];
/** The API: HEAD of a canvas answers `answers[id]` (404 when not given), after `asked` when given; the summary list
 * pages `pages` in order. */
function serve(answers: Record<string, number>, pages: Array<{ items: Array<{ id: string }>; nextCursor: string | null }> = [],
  asked?: (canvas: string) => Promise<void>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'HEAD') {
      const canvas = decodeURIComponent(url.split('/canvases/')[1]);
      heads.push(canvas);
      await asked?.(canvas);
      return new Response(null, { status: answers[canvas] ?? 404 });
    }
    lists.push(url);
    const cursor = new URL(url, 'http://test').searchParams.get('cursor');
    return json(pages[cursor ? Number(cursor) : 0]);
  }));
}
/** A record an earlier page put in IndexedDB (a value, or null: removed), `t` its time. */
const stored = (key: string, value: string | null, t = Date.now()) => backend.records.set(key, { k: key, v: value, c: 1, p: 'earlier-page', t });
const localKeys = () => Array.from({ length: local.storage.length }, (_, index) => local.storage.key(index)!);
/** Another tab of this browser, on the same IndexedDB, channels and locks. */
const otherTab = () => createCanvasStore({ backend: async () => backend.backend, channel: hub.channel, locks: locks.locks,
  legacy: local.storage, flushDelay: 5, peerWait: 50, watchPage: false });

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
beforeEach(() => {
  local = quotaStorage(); backend = memoryBackend(); hub = channelHub(); locks = countedLocks(); heads = []; lists = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local.storage });
  Object.defineProperty(navigator.locks, 'query', { configurable: true, value: async () => ({ held: [], pending: [] }) });
  setCanvasStoreForTests(otherTab());
  resetCanvasStorageEvictionForTests();
  // A sweep starts at a random canvas: the first one found, here.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); setCanvasStoreForTests(null);
  Object.defineProperty(globalThis, 'localStorage', original);
  delete (navigator.locks as { query?: unknown }).query;
});

it('finds a key\'s canvas only for a canvas id, a reader\'s copy counting as its canvas\'s', () => {
  expect(canvasOfStorageKey(`${editor(id(1))}superclaw.canvas.v2`, W)).toBe(id(1));
  expect(canvasOfStorageKey(`${reader(id(1))}superclaw.canvas.v2`, W)).toBe(id(1));
  expect(canvasOfStorageKey(`${editor(id(1))}awwo.cloud.draft.v1:writer`, W)).toBe(id(1));
  // The workspace's own facts, ids of no API, other workspaces, a scope with nothing after it, bad escapes.
  expect(canvasOfStorageKey(`${W}awwo.plan.duration.v1`, W)).toBeNull();
  expect(canvasOfStorageKey(`${W}canvas-a:superclaw.canvas.v2`, W)).toBeNull();
  expect(canvasOfStorageKey(`awwo.saas:user-a:tenant-b:${id(1)}:superclaw.canvas.v2`, W)).toBeNull();
  expect(canvasOfStorageKey(`${W}${id(1)}:`, W)).toBeNull();
  expect(canvasOfStorageKey(`${W}%E0%A4%A:x`, W)).toBeNull();
});

it('forgets, in both storages, the copies of canvases the server says are gone, except their unsent drafts', async () => {
  const [listed, legacy, moved, read, drafted, removed, onlyDrafts] = [1, 2, 3, 4, 5, 6, 7].map(id);
  local.storage.setItem(`${editor(listed)}superclaw.canvas.v2`, '{"listed":true}');
  stored(`${editor(listed)}awwo.cloud.baseline.v1`, '{"v":1}');
  // An earlier release's copies, never taken in (a draft among them).
  local.storage.setItem(`${editor(legacy)}superclaw.canvas.v2`, '{"legacy":true}');
  local.storage.setItem(`${editor(legacy)}awwo.cloud.version`, '4');
  local.storage.setItem(`${editor(legacy)}awwo.cloud.draft.v1:old`, '{"old draft":true}');
  local.storage.setItem(`${reader(legacy)}superclaw.canvas.v2`, '{"read":true}');
  local.storage.setItem(`${reader(legacy)}awwo.cloud.draft.v1:reader`, '{"reader draft":true}');
  // Copies the store took into IndexedDB: a canvas, a reader's copy, one with a draft, one already removed, and drafts alone.
  stored(`${editor(moved)}superclaw.canvas.v2`, 'x'.repeat(5000)); stored(`${editor(moved)}awwo.canvas.planning.v1`, '{}');
  stored(`${reader(read)}superclaw.canvas.v2`, '{"read":true}');
  stored(`${editor(drafted)}superclaw.canvas.v2`, '{}'); stored(`${editor(drafted)}awwo.cloud.draft.v1:writer`, '{"draft":true}');
  stored(`${editor(removed)}superclaw.canvas.v2`, null);
  stored(`${editor(onlyDrafts)}awwo.cloud.draft.v1:writer`, '{"draft":true}');
  // Not this account's canvases in this workspace, or no canvas at all.
  local.storage.setItem(`${W}awwo.plan.duration.v1`, '42');
  local.storage.setItem(`awwo.saas:user-b:tenant-a:${legacy}:superclaw.canvas.v2`, '{"someone else":true}');
  local.storage.setItem(`${W}canvas-z:superclaw.canvas.v2`, '{"no API id":true}');
  serve({});
  const forgotten = await forgetDeletedCanvasStorage('user-a', 'tenant-a', [listed], true);
  expect(forgotten.sort()).toEqual([legacy, moved, read, drafted].sort());
  expect(heads.sort()).toEqual([legacy, moved, read, drafted].sort());
  expect(lists).toEqual([]);
  expect(localKeys().filter(key => key.startsWith(editor(legacy)) || key.startsWith(reader(legacy))).sort())
    .toEqual([`${editor(legacy)}awwo.cloud.draft.v1:old`, `${reader(legacy)}awwo.cloud.draft.v1:reader`].sort());
  for (const key of [`${editor(moved)}superclaw.canvas.v2`, `${editor(moved)}awwo.canvas.planning.v1`, `${reader(read)}superclaw.canvas.v2`,
    `${editor(drafted)}superclaw.canvas.v2`]) expect(backend.value(key)).toBeNull();
  // Kept: the listed canvas, the unsent drafts, and every key that is not this account's canvas here.
  expect(local.storage.getItem(`${editor(listed)}superclaw.canvas.v2`)).toBe('{"listed":true}');
  expect(backend.value(`${editor(listed)}awwo.cloud.baseline.v1`)).toBe('{"v":1}');
  expect(local.storage.getItem(`${editor(legacy)}awwo.cloud.draft.v1:old`)).toBe('{"old draft":true}');
  expect(backend.value(`${editor(drafted)}awwo.cloud.draft.v1:writer`)).toBe('{"draft":true}');
  expect(backend.value(`${editor(onlyDrafts)}awwo.cloud.draft.v1:writer`)).toBe('{"draft":true}');
  expect(local.storage.getItem(`${W}awwo.plan.duration.v1`)).toBe('42');
  expect(local.storage.getItem(`awwo.saas:user-b:tenant-a:${legacy}:superclaw.canvas.v2`)).toBe('{"someone else":true}');
  expect(local.storage.getItem(`${W}canvas-z:superclaw.canvas.v2`)).toBe('{"no API id":true}');
  // Once a page.
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [listed], true)).toEqual([]);
  expect(heads).toHaveLength(4);
  // Next time, what is left (drafts, recent tombstones) is asked about no more, and a canvas of drafts alone is not read.
  const loads: string[] = [];
  const load = backend.backend.load;
  backend.backend.load = prefix => { loads.push(prefix); return load(prefix); };
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [listed], true)).toEqual([]);
  expect(heads).toHaveLength(4);
  expect(loads.sort()).toEqual([editor(moved), reader(read), editor(drafted), editor(removed)].sort());
});

it('keeps a canvas the server still has, and stops at the first answer that is not 404', async () => {
  const [there, unsure, after] = [8, 9, 10].map(id);
  for (const canvas of [there, unsure, after]) local.storage.setItem(`${editor(canvas)}superclaw.canvas.v2`, '{}');
  serve({ [there]: 200, [unsure]: 503 });
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([there, unsure]);
  expect(localKeys()).toHaveLength(3);
  // Asked again on a later opening of the page, not in this one.
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([there, unsure]);
});

it('leaves a canvas a tab has open, without asking about it', async () => {
  const open = id(11);
  stored(`${editor(open)}superclaw.canvas.v2`, '{"open":true}');
  local.storage.setItem(`${editor(open)}awwo.canvas.card-frames.v1`, '{}');
  await otherTab().open(editor(open));
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([]);
  expect(backend.value(`${editor(open)}superclaw.canvas.v2`)).toBe('{"open":true}');
  expect(local.storage.getItem(`${editor(open)}awwo.canvas.card-frames.v1`)).toBe('{}');
});

it('decides what to remove on what it reads alone with a canvas: what was written meanwhile goes but a draft, a canvas opened meanwhile is left', async () => {
  const [late, opened] = [12, 13].map(id);
  for (const canvas of [late, opened]) stored(`${editor(canvas)}superclaw.canvas.v2`, '{}');
  const tab = otherTab();
  // While the server is asked: another tab writes a draft and a planning record of one canvas (and closes), and opens
  // the other.
  serve({}, [], async canvas => {
    if (canvas === late) await backend.backend.write([{ k: `${editor(late)}awwo.cloud.draft.v1:late`, v: '{"late":true}', c: 9, p: 'tab', t: Date.now() },
      { k: `${editor(late)}awwo.canvas.planning.v1`, v: '{"late":true}', c: 9, p: 'tab', t: Date.now() }]);
    if (canvas === opened) await tab.open(editor(opened));
  });
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([late]);
  expect(heads.sort()).toEqual([late, opened].sort());
  expect(backend.value(`${editor(late)}awwo.cloud.draft.v1:late`)).toBe('{"late":true}');
  expect(backend.value(`${editor(late)}awwo.canvas.planning.v1`)).toBeNull();
  expect(backend.value(`${editor(late)}superclaw.canvas.v2`)).toBeNull();
  expect(backend.value(`${editor(opened)}superclaw.canvas.v2`)).toBe('{}');
});

it('reads at most a bounded number of canvases a sweep, from a random start, so the rest are reached on later visits', async () => {
  // A month of canvases forgotten before (their tombstones), and, found last, one deleted elsewhere.
  for (let n = 100; n < 100 + MAX_CANVAS_READS + 5; n++) stored(`${editor(id(n))}superclaw.canvas.v2`, null);
  const deleted = id(99);
  stored(`${editor(deleted)}superclaw.canvas.v2`, '{"deleted elsewhere":true}');
  const loads: string[] = [];
  const load = backend.backend.load;
  backend.backend.load = prefix => { loads.push(prefix); return load(prefix); };
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(loads).toHaveLength(MAX_CANVAS_READS);
  expect(heads).toEqual([]);
  // A later visit that starts at the last canvas found.
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([deleted]);
  expect(heads).toEqual([deleted]);
  expect(backend.value(`${editor(deleted)}superclaw.canvas.v2`)).toBeNull();
});

it('drops the expired tombstones of canvases forgotten long ago, without asking', async () => {
  const [old, recent] = [14, 15].map(id);
  stored(`${editor(old)}superclaw.canvas.v2`, null, 0);
  stored(`${editor(recent)}superclaw.canvas.v2`, null);
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([]);
  expect(backend.records.has(`${editor(old)}superclaw.canvas.v2`)).toBe(false);
  expect(backend.records.has(`${editor(recent)}superclaw.canvas.v2`)).toBe(true);
});

it('leaves everything when the store cannot say what it keeps, and stops at a canvas it cannot read', async () => {
  const [inLocal, inStore] = [16, 17].map(id);
  local.storage.setItem(`${editor(inLocal)}superclaw.canvas.v2`, '{}');
  stored(`${editor(inStore)}superclaw.canvas.v2`, '{}');
  serve({});
  const keys = backend.backend.keys;
  backend.backend.keys = async () => { throw new Error('IndexedDB did not answer'); };
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  backend.backend.keys = keys;
  // The first canvas (its localStorage copy) cannot be read in IndexedDB: the second is left too, for another visit.
  const load = backend.backend.load;
  backend.backend.load = async prefix => { if (prefix === editor(inLocal)) throw new Error('IndexedDB did not answer'); return load(prefix); };
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([]);
  expect(local.storage.getItem(`${editor(inLocal)}superclaw.canvas.v2`)).toBe('{}');
  expect(backend.value(`${editor(inStore)}superclaw.canvas.v2`)).toBe('{}');
});

it('stops at the first forget that fails, leaving the rest for another visit', async () => {
  const [first, second] = [74, 75].map(id);
  for (const canvas of [first, second]) stored(`${editor(canvas)}superclaw.canvas.v2`, '{}');
  backend.failWith(new DOMException('The disk is full', 'QuotaExceededError'), 1);
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([first]);
  for (const canvas of [first, second]) expect(backend.value(`${editor(canvas)}superclaw.canvas.v2`)).toBe('{}');
});

it('leaves everything where tabs cannot share the store (an open canvas would not be known)', async () => {
  local.storage.setItem(`${editor(id(18))}superclaw.canvas.v2`, '{}');
  delete (navigator.locks as { query?: unknown }).query;
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toEqual([]);
  expect(heads).toEqual([]);
  expect(local.storage.getItem(`${editor(id(18))}superclaw.canvas.v2`)).toBe('{}');
});

it('asks about at most a bounded number of canvases a sweep', async () => {
  for (let n = 20; n < 20 + MAX_CANVAS_CHECKS + 5; n++) local.storage.setItem(`${editor(id(n))}superclaw.canvas.v2`, '{}');
  serve({});
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [], true)).toHaveLength(MAX_CANVAS_CHECKS);
  expect(heads).toHaveLength(MAX_CANVAS_CHECKS);
  expect(localKeys()).toHaveLength(5);
});

it('reads the whole list when the first page is not all of it, at most once a day', async () => {
  const [first, later, gone, goneToo] = [60, 61, 62, 63].map(id);
  for (const canvas of [later, gone]) local.storage.setItem(`${editor(canvas)}superclaw.canvas.v2`, '{}');
  serve({}, [{ items: [{ id: first }], nextCursor: '1' }, { items: [{ id: later }], nextCursor: null }]);
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [first], false)).toEqual([gone]);
  expect(lists).toHaveLength(2);
  expect(lists.every(url => url.includes('view=summary') && url.includes('limit=200'))).toBe(true);
  expect(heads).toEqual([gone]);
  expect(local.storage.getItem(`${editor(later)}superclaw.canvas.v2`)).toBe('{}');
  expect(Number(local.storage.getItem(W + CANVAS_STORAGE_SWEPT_KEY))).toBeGreaterThan(0);
  // Within a day, a long list is not read again.
  local.storage.setItem(`${editor(goneToo)}superclaw.canvas.v2`, '{}');
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [first], false)).toEqual([]);
  expect(lists).toHaveLength(2);
  expect(heads).toEqual([gone]);
  // A whole list on its first page needs no reading, whenever.
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [first, later], true)).toEqual([goneToo]);
  expect(lists).toHaveLength(2);
});

it('forgets nothing from a longer list it cannot read whole, and reads it no more that day', async () => {
  local.storage.setItem(`${editor(id(70))}superclaw.canvas.v2`, '{}');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { lists.push(url); return new Response('{}', { status: 503 }); }));
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [id(71)], false)).toEqual([]);
  expect(local.storage.getItem(`${editor(id(70))}superclaw.canvas.v2`)).toBe('{}');
  expect(lists).toHaveLength(1);
  resetCanvasStorageEvictionForTests();
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [id(71)], false)).toEqual([]);
  expect(lists).toHaveLength(1);
  // Nor one past ten pages of 200.
  local.storage.removeItem(W + CANVAS_STORAGE_SWEPT_KEY);
  resetCanvasStorageEvictionForTests();
  serve({}, Array.from({ length: 12 }, (_, page) => ({ items: [{ id: id(100 + page) }], nextCursor: String(page + 1) })));
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [id(71)], false)).toEqual([]);
  expect(lists).toHaveLength(11);
  expect(heads).toEqual([]);
  expect(local.storage.getItem(`${editor(id(70))}superclaw.canvas.v2`)).toBe('{}');
});

it('reads a longer list again when its last read is dated ahead of this clock (the clock set back since)', async () => {
  local.storage.setItem(`${editor(id(76))}superclaw.canvas.v2`, '{}');
  local.storage.setItem(W + CANVAS_STORAGE_SWEPT_KEY, String(Date.now() + 10 * 24 * 3600 * 1000));
  serve({}, [{ items: [{ id: id(77) }], nextCursor: null }]);
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [id(77)], false)).toEqual([id(76)]);
  expect(lists).toHaveLength(1);
});

it('does not read a longer list when this browser cannot keep when it last did', async () => {
  local.storage.setItem(`${editor(id(72))}superclaw.canvas.v2`, '{}');
  local.storage.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  serve({}, [{ items: [], nextCursor: null }]);
  expect(await forgetDeletedCanvasStorage('user-a', 'tenant-a', [id(73)], false)).toEqual([]);
  expect(lists).toEqual([]);
  expect(heads).toEqual([]);
});
