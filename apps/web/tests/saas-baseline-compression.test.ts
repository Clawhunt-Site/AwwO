import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { gunzipSync, strFromU8, strToU8 } from 'fflate';
import { CANVAS_STORAGE_KEY, createFormNode, emptyDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_BASELINE_KEY, canonicalCanvasDocumentJSON, isKnownSyncedCache, rememberCanvasBaseline } from '../src/saas/canvasDraft';
import { compactCanvasBaselinesForUser } from '../src/saas/canvasBaselineCompression';

const userPrefix = 'awwo.saas:user-a:';
const prefix = `${userPrefix}tenant-a:canvas-a:`;
const key = prefix + CANVAS_BASELINE_KEY;
const document = () => ({ ...emptyDocument(), updatedAt: 123, nodes: [{ ...createFormNode({ x: 0, y: 0 }),
  fields: [{ id: 'goal', label: '目标', value: '完整保留已保存的目标内容。'.repeat(200) }] }], edges: [] });
const legacy = (body: string, version = 7) => JSON.stringify({ version, document: body });
const largeBody = () => JSON.stringify({ ...document(), futurePayload: '无损保留 🐈\u0000\ud800'.repeat(2000) }, null, 2);
const unpack = (raw: string) => strFromU8(gunzipSync(strToU8(atob(JSON.parse(raw).document), true)));

beforeEach(() => { localStorage.clear(); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a'); });
afterEach(() => { vi.restoreAllMocks(); });

it('writes deterministic trusted proofs and an older client fails closed on the new encoding', () => {
  const doc = document();
  rememberCanvasBaseline(canvasStorage(), 7, doc);
  const first = localStorage.getItem(key)!;
  const stored = JSON.parse(first);
  expect(stored).toMatchObject({ version: 7, encoding: 'gzip' });
  expect(unpack(first)).toBe(canonicalCanvasDocumentJSON(doc));
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(true);
  expect(isKnownSyncedCache(canvasStorage(), { ...doc, updatedAt: 124 })).toBe(false);
  rememberCanvasBaseline(canvasStorage(), 7, doc);
  expect(localStorage.getItem(key)).toBe(first);
  // This is the old reader's first operation; it must not see a clean document.
  expect(() => JSON.parse(stored.document)).toThrow();
});

it('compacts only exact current-user proof namespaces and preserves original document bytes', () => {
  const body = largeBody(); const before = legacy(body);
  localStorage.setItem(key, before);
  const second = `${userPrefix}tenant-b:canvas-b:${CANVAS_BASELINE_KEY}`;
  localStorage.setItem(second, legacy(body, 9));
  const protectedValues = new Map([
    ['awwo.saas:user-ab:tenant-a:canvas-a:' + CANVAS_BASELINE_KEY, before],
    ['awwo.saas:user-b:tenant-a:canvas-a:' + CANVAS_BASELINE_KEY, before],
    [prefix + CANVAS_STORAGE_KEY, 'exact source cache'],
    [prefix + 'awwo.cloud.draft.v1:writer', 'exact unsynced draft'],
    [prefix + 'awwo.canvas.run.v1', 'exact run journal'],
    [prefix + 'awwo.canvas.planning.v1', 'exact conversation history'],
    [prefix + CANVAS_BASELINE_KEY + ':extra', before],
    [userPrefix + 'tenant-a:' + CANVAS_BASELINE_KEY, before],
    [userPrefix + 'tenant-a:canvas-a:extra:' + CANVAS_BASELINE_KEY, before],
    [userPrefix + 'tenant-a:%XX:' + CANVAS_BASELINE_KEY, before],
  ]);
  for (const [protectedKey, raw] of protectedValues) localStorage.setItem(protectedKey, raw);
  const remove = vi.spyOn(localStorage, 'removeItem');
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(2);
  for (const migratedKey of [key, second]) {
    const after = localStorage.getItem(migratedKey)!;
    expect(after.length).toBeLessThan(before.length / 10);
    expect(unpack(after)).toBe(body); // Includes future fields, whitespace, emoji, NUL and lone-surrogate escapes.
    expect(JSON.parse(after).migrated).toBe(true);
  }
  expect(JSON.parse(localStorage.getItem(second)!).version).toBe(9);
  for (const [protectedKey, raw] of protectedValues) expect(localStorage.getItem(protectedKey)).toBe(raw);
  expect(remove).not.toHaveBeenCalled();
});

it('never trusts a migrated proof until a fresh acknowledgement replaces it', () => {
  const doc = document();
  const body = canonicalCanvasDocumentJSON(doc);
  localStorage.setItem(key, legacy(body));
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(1);
  expect(unpack(localStorage.getItem(key)!)).toBe(body);
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(false);
  const migrated = localStorage.getItem(key);
  rememberCanvasBaseline(canvasStorage(), 6, doc);
  expect(localStorage.getItem(key)).toBe(migrated);
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(false);
  rememberCanvasBaseline(canvasStorage(), 8, doc);
  expect(JSON.parse(localStorage.getItem(key)!).migrated).toBeUndefined();
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(true);
  rememberCanvasBaseline(canvasStorage(), 7, { ...doc, updatedAt: 999 });
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(true);
});

it('cannot misclassify old data as clean if another tab updates a proof after the raw recheck', () => {
  const doc = document();
  localStorage.setItem(key, legacy(canonicalCanvasDocumentJSON(doc)));
  const setItem = localStorage.setItem.bind(localStorage);
  let raced = false;
  vi.spyOn(localStorage, 'setItem').mockImplementation((candidateKey, value) => {
    if (candidateKey === key && JSON.parse(value).migrated === true) {
      raced = true;
      // An old tab can write between our final read and replace; there is no Storage CAS.
      setItem(key, legacy(canonicalCanvasDocumentJSON({ ...doc, updatedAt: 124 }), 8));
    }
    setItem(candidateKey, value);
  });
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(1);
  expect(raced).toBe(true);
  expect(isKnownSyncedCache(canvasStorage(), doc)).toBe(false);
});

it('skips a proof changed before the final raw recheck', () => {
  const before = legacy(largeBody()); const newer = legacy(largeBody(), 8);
  localStorage.setItem(key, before);
  const getItem = localStorage.getItem.bind(localStorage);
  let reads = 0;
  vi.spyOn(localStorage, 'getItem').mockImplementation(candidateKey => candidateKey === key && ++reads >= 2 ? newer : getItem(candidateKey));
  const setItem = vi.spyOn(localStorage, 'setItem');
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(setItem).not.toHaveBeenCalled();
});

it.each([
  '{broken', legacy('not JSON'), legacy('{}'), legacy('{"version":3,"nodes":[],"edges":[]}'),
  JSON.stringify({ version: 7, document: largeBody(), futureEnvelope: true }),
  JSON.stringify({ version: 7, document: largeBody(), encoding: 'future' }),
  legacy(largeBody(), 0), legacy(largeBody(), Number.MAX_SAFE_INTEGER + 1),
])('keeps unrecognized proof bytes intact: %s', raw => {
  localStorage.setItem(key, raw);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(raw);
});

it('keeps the original proof if compaction cannot be written and never removes any key', () => {
  const before = legacy(largeBody()); localStorage.setItem(key, before);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  const remove = vi.spyOn(localStorage, 'removeItem');
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(before);
  expect(remove).not.toHaveBeenCalled();
});

it('does not rewrite already compressed proofs or invalid user prefixes', () => {
  const before = legacy(largeBody()); localStorage.setItem(key, before);
  for (const invalid of ['', 'awwo.saas:', 'awwo.saas:user-a', 'awwo.saas:user-a:tenant-a:', 'awwo.saas:%XX:']) {
    expect(compactCanvasBaselinesForUser(localStorage, invalid)).toBe(0);
  }
  expect(localStorage.getItem(key)).toBe(before);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(1);
  const after = localStorage.getItem(key);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(after);
});

it('preserves malformed UTF-16 bytes and proofs whose compressed envelope would be larger', () => {
  const malformed = JSON.stringify({ version: 2, nodes: [], edges: [], future: 'x'.repeat(1000) })
    .replace('xxx', '\ud800xx');
  const before = legacy(malformed); localStorage.setItem(key, before);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(before);
  const tiny = legacy('{"version":2,"nodes":[],"edges":[]}'); localStorage.setItem(key, tiny);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(tiny);
});

it('accepts correctly encoded account identifiers and limits replacement count largest first', () => {
  const encodedUser = 'awwo.saas:user%3Apart:';
  for (let index = 0; index < 65; index++) localStorage.setItem(`${encodedUser}tenant%3Apart:canvas-${index}:${CANVAS_BASELINE_KEY}`,
    legacy(JSON.stringify({ version: 2, nodes: [], edges: [], preserved: 'a'.repeat(500 + index) })));
  expect(compactCanvasBaselinesForUser(localStorage, encodedUser)).toBe(64);
  expect(JSON.parse(localStorage.getItem(`${encodedUser}tenant%3Apart:canvas-0:${CANVAS_BASELINE_KEY}`)!).encoding).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(`${encodedUser}tenant%3Apart:canvas-64:${CANVAS_BASELINE_KEY}`)!).migrated).toBe(true);
});

it('bounds key scanning and oversized proof inputs', () => {
  for (let index = 0; index < 512; index++) localStorage.setItem(`unrelated-${index}`, '');
  const before = legacy(largeBody()); localStorage.setItem(key, before);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(before);
  localStorage.clear();
  const oversized = legacy(' '.repeat(2 * 1024 * 1024)); localStorage.setItem(key, oversized);
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(0);
  expect(localStorage.getItem(key)).toBe(oversized);
});

it('frees enough proof-only space to store a real-sized new cache and independent draft', () => {
  const before = legacy(largeBody());
  for (let index = 0; index < 28; index++) localStorage.setItem(`${userPrefix}tenant-a:canvas-${index}:${CANVAS_BASELINE_KEY}`, before);
  const bytes = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
    .reduce((sum, storedKey) => sum + (storedKey.length + localStorage.getItem(storedKey)!.length) * 2, 0);
  const budget = bytes() + 11674;
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((storedKey, value) => {
    const old = localStorage.getItem(storedKey);
    if (bytes() - (old === null ? 0 : (storedKey.length + old.length) * 2) + (storedKey.length + value.length) * 2 > budget) {
      throw new DOMException('Full', 'QuotaExceededError');
    }
    setItem(storedKey, value);
  });
  const cache = '最新生成的完整画布'.repeat(800);
  expect(() => localStorage.setItem(prefix + CANVAS_STORAGE_KEY, cache)).toThrow('Full');
  expect(compactCanvasBaselinesForUser(localStorage, userPrefix)).toBe(28);
  expect(() => localStorage.setItem(prefix + CANVAS_STORAGE_KEY, cache)).not.toThrow();
  expect(() => localStorage.setItem(prefix + 'awwo.cloud.draft.v1:writer-a', cache)).not.toThrow();
  expect(localStorage.getItem(prefix + CANVAS_STORAGE_KEY)).toBe(cache);
});
