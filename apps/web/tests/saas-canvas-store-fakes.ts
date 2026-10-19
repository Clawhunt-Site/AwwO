import type { CanvasStoreBackend, StoreChannel, StoreRecord } from '../src/canvas/canvasStore';

// Test doubles for the canvas store: an IndexedDB stand-in, a BroadcastChannel hub shared by "tabs", Web Locks that
// can be counted, and a localStorage with a quota.

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const newer = (a: StoreRecord, b: StoreRecord) => a.c > b.c || (a.c === b.c && a.p > b.p);

/** IndexedDB as the store sees it: the newest version per key wins whatever order writes arrive in. */
export function memoryBackend() {
  const records = new Map<string, StoreRecord>();
  const writes: StoreRecord[][] = [];
  const commits: boolean[] = [];
  let failure: { error: unknown; times: number } | null = null;
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const backend: CanvasStoreBackend = {
    async load(prefix) {
      await tick();
      return [...records.values()].filter(record => record.k.startsWith(prefix)).map(record => ({ ...record }));
    },
    async write(list, options) {
      commits.push(Boolean(options?.commit));
      if (gate && !options?.commit) await gate.promise;
      await tick();
      if (failure && failure.times > 0) { failure.times--; throw failure.error; }
      writes.push(list.map(record => ({ ...record })));
      for (const record of list) {
        const current = records.get(record.k);
        if (!current || newer(record, current)) records.set(record.k, { ...record });
      }
    },
    async prune(prefix, expired) {
      for (const record of expired) {
        const current = records.get(record.k);
        if (record.k.startsWith(prefix) && current && current.c === record.c && current.p === record.p) records.delete(record.k);
      }
    },
  };
  return {
    backend, records, writes, commits,
    value: (key: string) => records.get(key)?.v ?? null,
    failWith(error: unknown, times = Infinity) { failure = { error, times }; },
    recover() { failure = null; },
    hold() { let open!: () => void; gate = { promise: new Promise<void>(resolve => { open = resolve; }), open }; },
    release() { gate?.open(); gate = null; },
  };
}

type FakeChannel = StoreChannel & { name: string; closed: boolean };
export function channelHub() {
  const channels = new Set<FakeChannel>();
  const sent: Array<{ name: string; data: unknown }> = [];
  return {
    sent,
    channel(name: string): StoreChannel {
      const self: FakeChannel = {
        name, closed: false, onmessage: null,
        postMessage(message: unknown) {
          if (self.closed) throw new Error('closed');
          const data = structuredClone(message);
          sent.push({ name, data });
          for (const other of channels) {
            if (other === self || other.name !== name) continue;
            setTimeout(() => { if (!other.closed) other.onmessage?.({ data } as MessageEvent); }, 0);
          }
        },
        close() { self.closed = true; channels.delete(self); },
      };
      channels.add(self);
      return self;
    },
    /** A tab going away: its channels stop receiving. */
    closeAll() { for (const channel of [...channels]) channel.close(); },
  };
}

export function countedLocks() {
  const held: Array<{ name: string; mode: LockMode }> = [];
  const locks = {
    request(name: string, options: LockOptions, callback: LockGrantedCallback) {
      const lock = { name, mode: options.mode ?? 'exclusive' as LockMode };
      // ifAvailable: refused (the callback gets null) while a lock it conflicts with is held.
      if (options.ifAvailable && held.some(other => other.name === name && (lock.mode === 'exclusive' || other.mode === 'exclusive'))) {
        return Promise.resolve(callback(null));
      }
      held.push(lock);
      return Promise.resolve(callback(lock as Lock)).finally(() => { held.splice(held.indexOf(lock), 1); });
    },
    async query() { return { held: held.map(lock => ({ ...lock, clientId: 'tab' })), pending: [] }; },
  };
  return { locks: locks as unknown as LockManager, held };
}

/** A localStorage that refuses writes past `quota` characters (keys and values), as a browser's does. */
export function quotaStorage(quota = Infinity) {
  const values = new Map<string, string>();
  const used = () => [...values].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.has(key) ? values.get(key)! : null,
    setItem(key: string, value: string) {
      const next = used() - (values.has(key) ? key.length + values.get(key)!.length : 0) + key.length + String(value).length;
      if (next > quota) throw new DOMException(`Setting the value of '${key}' exceeded the quota.`, 'QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
  return { storage: storage as unknown as Storage, values, used };
}

export const settle = async (ms = 20) => { for (let index = 0; index < 3; index++) await new Promise(resolve => setTimeout(resolve, ms)); };
