import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { openCanvasStoreDatabase } from '../src/canvas/canvasStoreIdb';
import { createCanvasStore, type CanvasStoreBackend, type StoreRecord } from '../src/canvas/canvasStore';
import { canvasStoreAdoption } from '../src/canvas/canvasStorage';
import { channelHub, countedLocks, quotaStorage, settle } from './saas-canvas-store-fakes';

// The canvas store's IndexedDB backend on a complete in-memory IndexedDB (fake-indexeddb): what the store sees, and what
// IndexedDB itself holds afterwards.

const P = 'awwo.saas:user-a:tenant-a:canvas-1:';
const DOC = P + 'superclaw.canvas.v2';
const record = (k: string, v: string | null, c: number, p = 'page-a', t = Date.now()): StoreRecord => ({ k, v, c, p, t });

beforeEach(() => { (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); });

async function backend(): Promise<CanvasStoreBackend> {
  const db = await openCanvasStoreDatabase(2000);
  if (!db) throw new Error('no IndexedDB');
  return db;
}
/** Every version IndexedDB holds, read past the backend. */
async function versions(): Promise<Array<[string, number, string]>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('awwo-canvas-store', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAllKeys();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close();
  return keys as Array<[string, number, string]>;
}

describe('canvas store IndexedDB backend', () => {
  it('keeps the newest version of each key whatever order the writes arrive in', async () => {
    const db = await backend();
    await db.write([record(DOC, 'second', 2)]);
    await db.write([record(DOC, 'first', 1)]);
    await db.write([record(DOC, 'tie, lower page', 2, 'aaa')]);
    expect((await db.load(P)).map(row => row.v)).toEqual(['second']);
    await db.write([record(DOC, 'third', 3)]);
    expect((await db.load(P)).map(row => row.v)).toEqual(['third']);
  });

  it('lists the keys under a prefix, removed ones too, once each and without their values', async () => {
    const db = await backend();
    const other = 'awwo.saas:user-a:tenant-a:canvas-2:superclaw.canvas.v2';
    await db.write([record(DOC, 'one', 1), record(P + 'awwo.cloud.version', '3', 1), record(other, 'other', 1)]);
    await db.write([record(DOC, null, 2)]);
    await db.write([record('awwo.saas:user-a:tenant-b:canvas-1:superclaw.canvas.v2', 'elsewhere', 1)]);
    expect((await db.keys(P)).sort()).toEqual([P + 'awwo.cloud.version', DOC].sort());
    expect((await db.keys('awwo.saas:user-a:tenant-a:')).sort()).toEqual([P + 'awwo.cloud.version', DOC, other].sort());
    expect(await db.keys('awwo.saas:user-z:')).toEqual([]);
  });

  it('deletes a key\'s older versions as it writes a newer one', async () => {
    const db = await backend();
    await db.write([record(DOC, 'one', 1)]);
    await db.write([record(DOC, 'two', 2)]);
    await db.write([record(DOC, 'three', 3, 'page-b')]);
    expect(await versions()).toEqual([[DOC, 3, 'page-b']]);
  });

  it('keeps a tombstone over an older write that arrives after it', async () => {
    const db = await backend();
    await db.write([record(DOC, null, 9)]);
    await db.write([record(DOC, 'resurrected', 8, 'page-z')]);
    const [row] = await db.load(P);
    expect(row).toMatchObject({ k: DOC, v: null, c: 9 });
  });

  it('reads exactly its own canvas: canvas-1 never sees canvas-10 or canvas-1%2Fread-only', async () => {
    const db = await backend();
    await db.write([record(DOC, 'mine', 1), record('awwo.saas:user-a:tenant-a:canvas-10:superclaw.canvas.v2', 'ten', 1),
      record('awwo.saas:user-a:tenant-a:canvas-1%2Fread-only:superclaw.canvas.v2', 'reader', 1),
      record('awwo.saas:user-a:tenant-a:canvas-:superclaw.canvas.v2', 'shorter', 1)]);
    expect((await db.load(P)).map(row => row.v)).toEqual(['mine']);
    expect((await db.load('awwo.saas:user-a:tenant-a:canvas-10:')).map(row => row.v)).toEqual(['ten']);
  });

  it('prunes older versions and expired tombstones, and keeps a key written since', async () => {
    const db = await backend();
    await db.write([record(DOC, 'new', 5)]);
    await db.write([record(DOC, 'old', 4, 'page-z')]); // an older version arriving late
    await db.write([record(P + 'gone', null, 2, 'page-a', 0), record(P + 'gone-but-rewritten', null, 2, 'page-a', 0)]);
    const expired = (await db.load(P)).filter(row => row.v === null);
    await db.write([record(P + 'gone-but-rewritten', 'back', 3)]);
    await db.prune(P, expired);
    expect((await versions()).sort()).toEqual([[DOC, 5, 'page-a'], [P + 'gone-but-rewritten', 3, 'page-a']].sort());
  });

  it('opens a new connection when the browser loses the one it had (Safari\'s UnknownError), and writes there', async () => {
    const db = await backend();
    const transaction = IDBDatabase.prototype.transaction;
    let lost = 1;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (lost > 0) { lost -= 1; throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError'); }
      return transaction.apply(this, args);
    } as IDBDatabase['transaction'];
    try { await db.write([record(DOC, 'after the loss', 1)]); }
    finally { IDBDatabase.prototype.transaction = transaction; }
    expect(lost).toBe(0);
    expect((await db.load(P)).map(row => row.v)).toEqual(['after the loss']);
  });

  it('finishes a write the page asks to commit at once', async () => {
    const db = await backend();
    await db.write([record(DOC, 'on the way out', 1)], { commit: true });
    expect((await db.load(P))[0].v).toBe('on the way out');
  });

  it('reports a database a newer release has upgraded instead of hanging', async () => {
    const db = await backend();
    await db.write([record(DOC, 'before', 1)]);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('awwo-canvas-store', 2);
      request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error);
    });
    await expect(db.write([record(DOC, 'after', 2)])).rejects.toThrow();
  });
});

describe('canvas store on IndexedDB', () => {
  it('shares writes between tabs and keeps the last one for the next visit', async () => {
    const hub = channelHub(); const { locks } = countedLocks();
    const open = () => createCanvasStore({ backend: () => openCanvasStoreDatabase(2000), channel: hub.channel, locks, watchPage: false, flushDelay: 5 });
    const a = open(); const b = open();
    await a.open(P); await b.open(P);
    a.set(P, DOC, 'from a');
    await settle();
    expect(b.get(P, DOC)).toBe('from a');
    b.remove(P, DOC);
    b.set(P, P + 'awwo.cloud.version', '8');
    await settle(); await a.flush(); await b.flush();
    const later = createCanvasStore({ backend: () => openCanvasStoreDatabase(2000), channel: channelHub().channel, locks: countedLocks().locks, watchPage: false });
    await later.open(P);
    expect(later.get(P, DOC)).toBeNull();
    expect(later.get(P, P + 'awwo.cloud.version')).toBe('8');
  });

  it('moves an earlier release\'s document in and out of localStorage once IndexedDB holds it', async () => {
    const { storage } = quotaStorage();
    storage.setItem(DOC, 'legacy');
    storage.setItem(P + 'awwo.cloud.version', '3');
    const store = createCanvasStore({ backend: () => openCanvasStoreDatabase(2000), channel: channelHub().channel, locks: countedLocks().locks,
      legacy: storage, watchPage: false, flushDelay: 5 });
    await store.open(P, canvasStoreAdoption);
    await settle(); await store.flush(); await settle();
    expect(storage.getItem(DOC)).toBeNull();
    expect(storage.getItem(P + 'awwo.cloud.version')).toBe('3');
    const db = await backend();
    const rows = new Map((await db.load(P)).map(row => [row.k, row.v]));
    expect(rows.get(DOC)).toBe('legacy');
    expect(rows.get(P + 'awwo.cloud.version')).toBe('3');
  });
});
