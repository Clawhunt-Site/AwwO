import { validStoreRecord, type CanvasStoreBackend, type StoreRecord } from './canvasStore';

// IndexedDB under the canvas store. Every write is its own version, keyed [key, counter, page]: a write puts its
// version and deletes the key's older ones, and a read takes the newest. So a write never reads first (a page that is
// being closed can still finish one), and tabs writing in any order cannot replace a newer value with an older one.

const DB_NAME = 'awwo-canvas-store';
const RECORDS = 'records';
const TOP = String.fromCharCode(0xffff);

type StoredKey = [string, number, string];
const newer = (a: StoreRecord, b: StoreRecord) => a.c > b.c || (a.c === b.c && a.p > b.p);
const scopeRange = (prefix: string) => IDBKeyRange.bound([prefix], [prefix + TOP]);
/** Every version of the record's key older than the record. */
const olderThan = (record: StoreRecord) => IDBKeyRange.bound([record.k], [record.k, record.c, record.p], false, true);

/** The transaction's end; a failing request's own error (a full disk's QuotaExceededError) rather than a generic one. */
function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: unknown = null;
    tx.oncomplete = () => resolve();
    tx.onerror = event => { failure ??= (event.target as IDBRequest | null)?.error ?? tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('IndexedDB write aborted'));
  });
}

/** The newest version of each key. */
function newest(rows: unknown[]): StoreRecord[] {
  const byKey = new Map<string, StoreRecord>();
  for (const row of rows) {
    if (!validStoreRecord(row)) continue;
    const held = byKey.get(row.k);
    if (!held || newer(row, held)) byKey.set(row.k, row);
  }
  return [...byKey.values()];
}

function connect(timeoutMs: number): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) { db?.close(); return; }
      settled = true; clearTimeout(timer); resolve(db);
    };
    // Some browsers never answer an open (an old Safari right after launch): treat that as no IndexedDB.
    const timer = setTimeout(() => finish(null), timeoutMs);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, 1); } catch { finish(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: ['k', 'c', 'p'] });
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
  });
}

/** The canvas store's IndexedDB, or null where the browser has none or will not open it. The wait is generous: a page
 * that gives up keeps its canvases in localStorage, apart from its other tabs. */
export async function openCanvasStoreDatabase(timeoutMs = 10000): Promise<CanvasStoreBackend | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db = await connect(timeoutMs);
  if (!db) return null;
  const watch = (handle: IDBDatabase) => {
    // A newer release upgrading the database, or the browser closing it (site data cleared): reconnect on next use.
    handle.onversionchange = () => { handle.close(); if (db === handle) db = null; };
    handle.onclose = () => { if (db === handle) db = null; };
  };
  watch(db);
  let reconnecting: Promise<IDBDatabase> | null = null;
  /** One new connection for all the operations that find none at once. */
  const reconnect = (): Promise<IDBDatabase> => reconnecting ??= connect(timeoutMs).then(next => {
    if (!next) throw new Error('IndexedDB is unavailable');
    watch(next);
    db = next;
    return next;
  }).finally(() => { reconnecting = null; });
  /** Run on the open connection (synchronously up to its first wait), or on a new one if the browser closed it or lost
   * it (Safari's "Connection to Indexed Database server lost" is an UnknownError). Every operation here can run twice. */
  const use = async <T>(run: (handle: IDBDatabase) => Promise<T>): Promise<T> => {
    const current = db;
    if (current) {
      try { return await run(current); }
      catch (error) {
        if (!(error instanceof DOMException && (error.name === 'InvalidStateError' || error.name === 'UnknownError'))) throw error;
        try { current.close(); } catch { /* Already closed. */ }
        if (db === current) db = null;
      }
    }
    return run(db ?? await reconnect());
  };
  const store = (handle: IDBDatabase, mode: IDBTransactionMode) => {
    const tx = handle.transaction(RECORDS, mode);
    return { tx, records: tx.objectStore(RECORDS) };
  };

  return {
    load: prefix => use(async handle => {
      const { tx, records } = store(handle, 'readonly');
      const request = records.getAll(scopeRange(prefix));
      await finished(tx);
      return newest(request.result as unknown[]).filter(row => row.k.startsWith(prefix));
    }),
    // Put each record and delete its key's older versions: no request waits on another, so nothing here needs a later
    // task. A page that is going away asks for the commit at once rather than at the end of a task it may not get.
    write: (list, options) => list.length ? use(handle => {
      const { tx, records } = store(handle, 'readwrite');
      for (const record of list) { records.put(record); records.delete(olderThan(record)); }
      if (options?.commit) tx.commit?.();
      return finished(tx);
    }) : Promise.resolve(),
    prune: (prefix, expired) => use(async handle => {
      // Keys only: which versions are older needs no value.
      const { tx: readTx, records: readRecords } = store(handle, 'readonly');
      const request = readRecords.getAllKeys(scopeRange(prefix));
      await finished(readTx);
      const top = new Map<string, StoredKey>();
      const keys = (request.result as unknown[]).filter((key): key is StoredKey => Array.isArray(key) && key.length === 3
        && typeof key[0] === 'string' && key[0].startsWith(prefix) && typeof key[1] === 'number' && typeof key[2] === 'string');
      for (const key of keys) {
        const held = top.get(key[0]);
        if (!held || key[1] > held[1] || (key[1] === held[1] && key[2] > held[2])) top.set(key[0], key);
      }
      const drop = keys.filter(key => top.get(key[0]) !== key);
      // Expired tombstones, only while still their key's newest version (a write since keeps the key).
      for (const record of expired) {
        const held = top.get(record.k);
        if (held && held[1] === record.c && held[2] === record.p) drop.push(held);
      }
      if (!drop.length) return;
      const { tx, records } = store(handle, 'readwrite');
      for (const key of drop) records.delete(key);
      await finished(tx);
    }),
  };
}
