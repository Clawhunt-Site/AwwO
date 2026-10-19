import { isCanvasStorageQuotaError } from '../saas/canvasBaselineCompression';

// A hosted canvas's browser storage.
//
// localStorage holds about 5 MB for the whole site, and one large canvas (its document, a draft of it while a save is
// pending, its sync proof and run records) could fill that alone: autosave then paused behind 「本机存储空间已满」.
// IndexedDB holds a share of the disk instead. The canvas code reads and writes its storage synchronously, so a scope
// (one account's canvas in one workspace) is read into memory when it opens, served from memory, and written to
// IndexedDB shortly after each change, and at once when the page is hidden, frozen or left.
//
// Tabs. Every write is sent to the other tabs holding the scope over a BroadcastChannel and reaches them as a `storage`
// event, as a localStorage write did; after storing writes, a tab says so. A tab opening a scope first asks the tabs
// already holding it (counted through a shared Web Lock) for what they have not stored, then reads IndexedDB. Each
// write carries a Lamport stamp; every tab and IndexedDB keep the newest per key, so concurrent writers settle on one
// value. A removal is kept as a tombstone, so an older write that reaches IndexedDB later cannot bring the key back.
//
// What earlier releases left in localStorage. A tab of the earlier release may still be open and still reads and writes
// localStorage, so its keys come in by kind (see `Adoption`): large copies move (they become ordinary writes and leave
// localStorage once IndexedDB holds the record of their move, written with them; the ones this release writes too are
// taken in only while nothing here has written them since), small shared records are copied and stay, and the version
// is merged up. Beside each key, the hashes of the bytes taken in tell a later opening which bytes it has seen, so bytes
// a page left behind cannot overwrite what was written since.
//
// Honesty. A write IndexedDB refuses stays in memory and is retried, and listeners are told (also those that come later,
// until a write succeeds), so the hosted canvas can pause its autosave as it did when localStorage was full.

/** One stored key. `v` null is a tombstone. `c`/`p` are the write's Lamport stamp (counter, page); `t` its wall time. */
export type StoreRecord = { k: string; v: string | null; c: number; p: string; t: number };

export interface CanvasStoreBackend {
  /** The newest record of every key (tombstones included) that starts with `prefix`. */
  load(prefix: string): Promise<StoreRecord[]>;
  /** Store each record; an older one never replaces a newer. `commit`: the page is leaving, finish now. */
  write(records: readonly StoreRecord[], options?: { commit?: boolean }): Promise<void>;
  /** Drop older versions under `prefix`, and the given expired tombstones. */
  prune(prefix: string, expired: readonly StoreRecord[]): Promise<void>;
  /** Every key with a version stored under `prefix` (tombstones included), read without any value. */
  keys(prefix: string): Promise<string[]>;
}

/** How a localStorage key of an earlier release comes in: `move` (a large copy only that release writes, its drafts:
 * taken in, then removed from localStorage), `mirror` (a large copy this release writes too, such as the document
 * cache: taken in while this store has not written it since it was last taken in, never over what a tab of this release
 * wrote, then removed from localStorage), `copy` (a small record a page of that release may still read and rewrite:
 * taken in while this store has not written it since, and kept in localStorage), `max` (a number that only grows: the
 * larger one is kept). */
export type Adoption = 'move' | 'mirror' | 'copy' | 'max';

export type StoreChannel = { postMessage(message: unknown): void; close(): void; onmessage: ((event: MessageEvent) => void) | null };
type StoreLocks = Pick<LockManager, 'request'> & Partial<Pick<LockManager, 'query'>>;
type Legacy = Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'>;
export type StoreFailureListener = (error: unknown, prefixes: readonly string[]) => void;

export interface CanvasStoreOptions {
  /** IndexedDB, or null where the browser has none (only memory scopes then). */
  backend: () => Promise<CanvasStoreBackend | null>;
  channel?: (name: string) => StoreChannel | null;
  locks?: StoreLocks | null;
  /** Where bytes written before this store existed are found. */
  legacy?: Legacy | null;
  /** Whether bytes taken in must stay in localStorage for now (a tab of the earlier release may be running over them);
   * asked right before each removal, which is tried again after later writes. */
  keepLegacy?: (key: string, legacy: Legacy) => boolean;
  /** `mirror` keys (after the prefix) that come in together, decided by the first (the document cache): what a tab of
   * this release works on is never split from its sync proof. */
  mirrorGroup?: readonly string[];
  /** The group's first key when its bytes are not taken in: a record (under the prefix) keeping them for recovery, or
   * null when they hold nothing unsynced. */
  preserveLegacy?: (prefix: string, raw: string, legacy: Legacy, current: string | null) => { key: string; value: string } | null;
  dispatch?: (event: Event) => void;
  page?: string;
  now?: () => number;
  flushDelay?: number;
  peerWait?: number;
  loadTimeout?: number;
  /** How long after a scope opens its old versions and expired tombstones are dropped. */
  pruneDelay?: number;
  /** How long another tab's write may stay unstored before this tab stores it too (that tab may have crashed). */
  peerStoreDelay?: number;
  /** Write at once when the page is hidden or left (off in tests that make many stores). */
  watchPage?: boolean;
}

export interface CanvasStore {
  /** Whether IndexedDB is usable in this page. */
  available(): Promise<boolean>;
  /** Read a scope into memory and serve it from here on; `adopt` says how each localStorage key (after the prefix) comes in. */
  open(prefix: string, adopt?: (name: string) => Adoption | null): Promise<void>;
  /** A scope kept in this page's memory only (a read-only view, or a page whose browser storage is full). */
  openMemory(prefix: string, copy?: { from: Legacy; adopt: (name: string) => unknown }): void;
  isOpen(prefix: string): boolean;
  /** Open in this page's memory only. */
  inMemory(prefix: string): boolean;
  /** Whether any scope this page holds is kept in IndexedDB. */
  holdsStoredScopes(): boolean;
  /** How many other tabs have the scope open; null when the browser cannot say. */
  otherTabs(prefix: string): Promise<number | null>;
  /** The keys kept under `within` (in IndexedDB and in this page's scopes), removed ones included: which scopes there
   * are, without reading a value. */
  storedKeys(within: string): Promise<string[]>;
  get(prefix: string, key: string): string | null;
  set(prefix: string, key: string, value: string): void;
  remove(prefix: string, key: string): void;
  keys(prefix: string): string[];
  /** Take in another scope's localStorage keys without opening it, unless a tab holds it. */
  moveLegacy(prefix: string, keys: readonly string[], adopt: (name: string) => Adoption | null): Promise<void>;
  /** Remove every key under the prefix, here, in IndexedDB and in the other tabs (a deleted canvas). */
  forget(prefix: string): Promise<void>;
  /** For a scope no tab holds (its canvas open nowhere, this page included), alone with it: remove the keys `forgets`
   * picks, from IndexedDB (tombstones, told to the other tabs) and localStorage, and drop its expired tombstones. The
   * keys left holding a value in either, or null when a tab holds the scope (nothing done). */
  forgetIdle(prefix: string, forgets: (key: string) => boolean): Promise<string[] | null>;
  flush(): Promise<void>;
  /** Told of writes IndexedDB refuses; a listener added while a refusal stands is told at once. */
  onFailure(listener: StoreFailureListener): () => void;
}

type Entry = { v: string | null; c: number; p: string; t: number; dirty: boolean; stored: boolean };
type Scope = {
  prefix: string;
  persist: boolean;
  ready: boolean;
  opened: Promise<void>;
  entries: Map<string, Entry>;
  channel: StoreChannel | null;
  /** Writes other tabs sent while this scope was opening. */
  buffered: Array<{ record: StoreRecord; stored: boolean }> | null;
  /** This task's writes, sent to the other tabs together at its end. */
  outbox: Map<string, StoreRecord>;
  replies: Map<string, (records: StoreRecord[]) => void>;
  /** Moved localStorage bytes to remove once IndexedDB holds the record of their move. */
  moved: Array<{ key: string; raw: string; hash: string }>;
  /** Other tabs' unstored writes, each stored here too if it stays unstored. */
  watched: Map<string, ReturnType<typeof setTimeout>>;
  release: (() => void) | null;
  /** This page's hold on the scope is held or waiting (it asked and was not refused). */
  asked?: boolean;
};
type Marker = { h: string[]; s: [number, string] | null };

export const CANVAS_STORE_CHANNEL = 'awwo.canvas-store.v1:';
/** Beside a key, what was taken in from localStorage. Never a canvas key itself (a key has no NUL). */
const MOVED = String.fromCharCode(0) + 'moved';
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_MESSAGE_RECORDS = 10000;
/** How long a reply that missed the opening still counts (it is applied as an ordinary write). */
const LATE_REPLY_MS = 60000;
/** A deleted canvas's tombstones sit this far above every stamp seen, so a tab's pending writes cannot outrank them. */
const FORGET_LEAD = 2 ** 20;

const newer = (a: Pick<StoreRecord, 'c' | 'p'>, b: Pick<StoreRecord, 'c' | 'p'>) => a.c > b.c || (a.c === b.c && a.p > b.p);
const same = (a: Pick<StoreRecord, 'c' | 'p'>, b: Pick<StoreRecord, 'c' | 'p'>) => a.c === b.c && a.p === b.p;

export function validStoreRecord(value: unknown): value is StoreRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  // A counter far below the largest safe integer, so one tab's bad stamp cannot push every clock out of range.
  return typeof r.k === 'string' && (r.v === null || typeof r.v === 'string') && Number.isSafeInteger(r.c) && Number(r.c) >= 0
    && Number(r.c) < 2 ** 48 && typeof r.p === 'string' && r.p.length <= 200 && Number.isFinite(r.t);
}
/** Another tab's list of records, or null for anything else (a sparse or oversized array included). */
function records(value: unknown): StoreRecord[] | null {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_RECORDS) return null;
  const list: StoreRecord[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (!validStoreRecord(item)) return null;
    list.push(item);
  }
  return list;
}
function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function legacyKeys(legacy: Legacy, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < legacy.length; index++) {
    const key = legacy.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}
/** A 53-bit hash of a string's UTF-16 units (cyrb53) and its length: enough to recognise bytes taken in before. */
export function bytesHash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + ':' + text.length;
}
function marker(value: string | null | undefined): Marker {
  try {
    const parsed = JSON.parse(value ?? 'null') as Partial<Marker> | null;
    const h = Array.isArray(parsed?.h) ? parsed.h.filter((item): item is string => typeof item === 'string') : [];
    const s = Array.isArray(parsed?.s) && Number.isSafeInteger(parsed.s[0]) && typeof parsed.s[1] === 'string' ? [parsed.s[0], parsed.s[1]] as [number, string] : null;
    return { h, s };
  } catch { return { h: [], s: null }; }
}
/** Whether bytes of an earlier release's key are taken in over what this store holds for it. */
function takesOver(adoption: Adoption, raw: string, current: Pick<Entry, 'v' | 'c' | 'p'> | undefined, seen: Marker): boolean {
  if (!current || current.v === null && !seen.s) return true;
  // A page of the earlier release wrote these after the last move: its own draft is newest.
  if (adoption === 'move') return true;
  if (adoption === 'max') return Number(raw) > Number(current.v ?? 0);
  // A record this release writes too: only while nothing here has written it since it was last taken in. A tab of this
  // release that is running compares the document cache with what it last wrote, and stops saving when it changes.
  return Boolean(seen.s && current.c === seen.s[0] && current.p === seen.s[1]);
}
const removedAfterTaking = (adoption: Adoption) => adoption === 'move' || adoption === 'mirror';
/** How the `mirror` group comes in, decided once by its first key's state here: `take` (nothing held, or nothing written
 * since it was last taken in: the group's bytes come in), `keep` (a tab of the earlier release may be running over them:
 * left as they are, to be decided at a later opening), `leave` (this release wrote its own since: never replaced; the
 * bytes are recorded and leave localStorage, the first key's kept for recovery when it may hold unsynced edits). */
type GroupDecision = 'take' | 'keep' | 'leave';
function groupDecision(current: Pick<Entry, 'v' | 'c' | 'p'> | undefined, seen: Marker, running: boolean): GroupDecision {
  if (!current || current.v === null && !seen.s) return 'take';
  if (running) return 'keep';
  return seen.s && current.c === seen.s[0] && current.p === seen.s[1] ? 'take' : 'leave';
}

export function createCanvasStore(options: CanvasStoreOptions): CanvasStore {
  const page = options.page ?? randomId();
  const now = options.now ?? Date.now;
  const flushDelay = options.flushDelay ?? 250;
  const peerWait = options.peerWait ?? 1000;
  const loadTimeout = options.loadTimeout ?? 15000;
  const pruneDelay = options.pruneDelay ?? 5000;
  const peerStoreDelay = options.peerStoreDelay ?? 5000;
  const legacy = options.legacy ?? null;
  const dispatch = options.dispatch ?? ((event: Event) => { if (typeof window !== 'undefined') window.dispatchEvent(event); });
  const scopes = new Map<string, Scope>();
  const listeners = new Set<StoreFailureListener>();
  /** The refusal standing for each scope, until one of its writes is stored. */
  const refused = new Map<string, unknown>();
  let backend: Promise<CanvasStoreBackend | null> | null = null;
  /** The backend once known, for a write that cannot wait (the page is leaving). */
  let resolved: CanvasStoreBackend | null = null;
  let clock = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let failures = 0;
  let sending = false;

  const database = () => (backend ??= options.backend().then(db => (resolved = db), () => null));
  const lockName = (prefix: string) => CANVAS_STORE_CHANNEL + prefix;

  function storageEvent(key: string, oldValue: string | null, newValue: string | null): Event {
    const url = typeof location === 'undefined' ? '' : location.href;
    return typeof StorageEvent === 'function' ? new StorageEvent('storage', { key, oldValue, newValue, url })
      : Object.assign(new Event('storage'), { key, oldValue, newValue, url });
  }

  /** Another tab stores its own writes and says so. One it has not stored after a while (it crashed, or keeps failing)
   * this tab stores too, so a write every tab still shows is not lost at the next load; the same record twice is harmless. */
  function watchPeerWrite(scope: Scope, record: StoreRecord) {
    if (!scope.persist) return;
    clearTimeout(scope.watched.get(record.k));
    scope.watched.set(record.k, setTimeout(() => {
      scope.watched.delete(record.k);
      const entry = scope.entries.get(record.k);
      if (scopes.get(scope.prefix) !== scope || !entry || entry.dirty || entry.stored || !same(entry, record)) return;
      entry.dirty = true;
      schedule();
    }, peerStoreDelay));
  }

  /** A record read while the scope opens (IndexedDB, other tabs): no event, nothing to write. */
  function take(scope: Scope, record: StoreRecord, stored: boolean) {
    clock = Math.max(clock, record.c);
    const current = scope.entries.get(record.k);
    if (current && !newer(record, current)) {
      if (stored && same(current, record)) current.stored = true;
      return;
    }
    scope.entries.set(record.k, { v: record.v, c: record.c, p: record.p, t: record.t, dirty: false, stored });
    if (!stored) watchPeerWrite(scope, record);
  }

  /** Another tab's write to an open scope: applied if newer, and announced as a `storage` event if it changed the value. */
  function accept(scope: Scope, record: StoreRecord, stored: boolean) {
    clock = Math.max(clock, record.c);
    const current = scope.entries.get(record.k);
    if (current && !newer(record, current)) {
      if (stored && same(current, record)) current.stored = true;
      return;
    }
    // The sender stores its own write; an older local write it replaced is no longer needed in IndexedDB.
    scope.entries.set(record.k, { v: record.v, c: record.c, p: record.p, t: record.t, dirty: false, stored });
    if (!stored) watchPeerWrite(scope, record);
    const previous = current?.v ?? null;
    if (previous !== record.v && !record.k.endsWith(MOVED)) dispatch(storageEvent(record.k, previous, record.v));
  }

  /** What another tab opening this scope cannot read from IndexedDB yet. */
  function unstored(scope: Scope): StoreRecord[] {
    return [...scope.entries].filter(([, e]) => e.dirty || !e.stored).map(([k, e]) => ({ k, v: e.v, c: e.c, p: e.p, t: e.t }));
  }

  function receive(scope: Scope, data: unknown) {
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.type === 'set') {
      const list = records(message.records);
      if (!list) return;
      const stored = message.stored === true;
      if (!scope.ready) { if (scope.buffered) for (const record of list) scope.buffered.push({ record, stored }); return; }
      for (const record of list) if (record.k.startsWith(scope.prefix)) accept(scope, record, stored);
      if (stored) removeMoved();
    } else if (message.type === 'stored') {
      const list = records(message.records);
      if (!list || !scope.ready) return;
      for (const record of list) {
        const entry = scope.entries.get(record.k);
        if (entry && same(entry, record)) entry.stored = true;
      }
      removeMoved();
    } else if (message.type === 'hydrate') {
      if (scope.ready && typeof message.id === 'string' && typeof message.from === 'string' && message.from !== page) {
        try { scope.channel?.postMessage({ type: 'state', id: message.id, to: message.from, records: unstored(scope) }); }
        catch { /* The other tab still reads IndexedDB. */ }
      }
    } else if (message.type === 'state') {
      const list = records(message.records);
      if (list && message.to === page && typeof message.id === 'string') scope.replies.get(message.id)?.(list.filter(r => r.k.startsWith(scope.prefix)));
    }
  }

  function send(scope: Scope, record: StoreRecord) {
    if (!scope.channel) return;
    scope.outbox.set(record.k, record);
    if (sending) return;
    sending = true;
    queueMicrotask(() => {
      sending = false;
      for (const each of scopes.values()) {
        if (!each.outbox.size) continue;
        const batch = [...each.outbox.values()];
        each.outbox.clear();
        try { each.channel?.postMessage({ type: 'set', records: batch }); } catch { /* Another tab still reads IndexedDB when it opens. */ }
      }
    });
  }

  function schedule(delay = flushDelay) {
    if (timer !== null || flushing) return;
    timer = setTimeout(() => { timer = null; void flush(); }, delay);
  }

  /** How many tabs hold the scope; null when the browser cannot say. */
  async function holders(prefix: string): Promise<number | null> {
    if (!options.locks?.query) return null;
    try {
      const state = await options.locks.query();
      // Tabs hold a scope shared; a page sweeping it holds it alone, and has nothing to answer.
      return (state.held ?? []).filter(lock => lock.name === lockName(prefix) && lock.mode !== 'exclusive').length;
    } catch { return null; }
  }

  /** Hold the scope for this page's lifetime, so a tab opening it later knows to ask this one. A lock that is not
   * granted soon (nothing should hold it exclusively) never keeps the canvas from opening. */
  function hold(scope: Scope): Promise<void> {
    const locks = options.locks;
    if (!locks) return Promise.resolve();
    return new Promise<void>(acquired => {
      const late = setTimeout(acquired, 2000);
      const granted = () => { clearTimeout(late); acquired(); };
      scope.asked = true;
      locks.request(lockName(scope.prefix), { mode: 'shared' }, () => new Promise<void>(release => { scope.release = release; granted(); }))
        .catch(() => { scope.asked = false; granted(); });
    });
  }

  /** The other tabs' unstored writes. A tab that answers after the wait (busy) is still heard: its records arrive as
   * ordinary writes, so this page's next write to that key outranks them instead of losing to them unseen. */
  function ask(scope: Scope, peers: number | null): Promise<StoreRecord[]> {
    if (!scope.channel || peers === 0) return Promise.resolve([]);
    return new Promise(resolve => {
      const id = randomId();
      const got: StoreRecord[] = [];
      let answers = 0;
      let open = true;
      const done = () => {
        if (!open) return;
        open = false; clearTimeout(wait); resolve(got);
        setTimeout(() => scope.replies.delete(id), LATE_REPLY_MS);
      };
      // Without a count, give a tab that holds the scope a short moment to answer.
      const wait = setTimeout(done, peers === null ? Math.min(peerWait, 300) : peerWait);
      scope.replies.set(id, list => {
        if (!open) {
          if (scope.ready) for (const record of list) accept(scope, record, false);
          else if (scope.buffered) for (const record of list) scope.buffered.push({ record, stored: false });
          return;
        }
        for (const record of list) got.push(record);
        if (peers !== null && ++answers >= peers) done();
      });
      try { scope.channel!.postMessage({ type: 'hydrate', id, from: page }); } catch { done(); }
    });
  }

  function writeEntry(scope: Scope, key: string, value: string | null) {
    const current = scope.entries.get(key);
    if ((current?.v ?? null) === value) return; // As localStorage: an unchanged value is no write and no event.
    if (!scope.persist) {
      if (value === null) scope.entries.delete(key);
      else scope.entries.set(key, { v: value, c: 0, p: page, t: now(), dirty: false, stored: false });
      return;
    }
    clock += 1;
    const entry: Entry = { v: value, c: clock, p: page, t: now(), dirty: true, stored: false };
    scope.entries.set(key, entry);
    send(scope, { k: key, v: value, c: entry.c, p: page, t: entry.t });
    schedule();
  }

  /** The earlier release's localStorage keys under an opening scope, each by its kind (see `Adoption`). */
  /** The `mirror` group's decision for a scope (see GroupDecision), from what is held for its first key. */
  function decideGroup(prefix: string, held: (key: string) => Pick<Entry, 'v' | 'c' | 'p'> | undefined): { first: string; decision: GroupDecision } | null {
    if (!legacy || !options.mirrorGroup?.length) return null;
    const first = prefix + options.mirrorGroup[0];
    let running = true;
    try { running = options.keepLegacy?.(first, legacy) ?? false; } catch { /* Unreadable: assume a run, change nothing. */ }
    return { first, decision: groupDecision(held(first), marker(held(first + MOVED)?.v), running) };
  }

  function adoptLegacy(scope: Scope, adopt: (name: string) => Adoption | null) {
    if (!legacy) return;
    let keys: string[];
    try { keys = legacyKeys(legacy, scope.prefix); } catch { return; }
    const group = decideGroup(scope.prefix, key => scope.entries.get(key));
    for (const key of keys) {
      const adoption = adopt(key.slice(scope.prefix.length));
      if (!adoption) continue;
      const decision = adoption === 'mirror' ? group?.decision : undefined;
      if (decision === 'keep') continue;
      let raw: string | null;
      try { raw = legacy.getItem(key); } catch { continue; }
      if (raw === null) continue;
      const hash = bytesHash(raw);
      const seen = marker(scope.entries.get(key + MOVED)?.v);
      if (!seen.h.includes(hash)) {
        const current = scope.entries.get(key);
        let stamp = seen.s;
        if (decision === 'leave' && key === group!.first) {
          // Never over what this release wrote; kept for recovery when it may hold edits that tab never synced.
          let kept: { key: string; value: string } | null | undefined;
          try { kept = options.preserveLegacy?.(scope.prefix, raw, legacy, current?.v ?? null); }
          catch { continue; } // Left in localStorage untouched, for a later opening.
          if (kept && kept.key.startsWith(scope.prefix) && scope.entries.get(kept.key)?.v == null) writeEntry(scope, kept.key, kept.value);
        }
        if (decision ? decision === 'take' : takesOver(adoption, raw, current, seen)) {
          if (current?.v === raw) { if (!current.stored) { current.dirty = true; schedule(); } }
          else writeEntry(scope, key, raw);
          const taken = scope.entries.get(key)!;
          stamp = [taken.c, taken.p];
        }
        // Written with the value (one IndexedDB write), so a stored record means the bytes are stored too.
        writeEntry(scope, key + MOVED, JSON.stringify({ h: [...seen.h, hash].slice(-8), s: stamp }));
      }
      if (removedAfterTaking(adoption)) scope.moved.push({ key, raw, hash });
    }
    if (scope.moved.length) schedule(0);
  }

  /** Remove moved bytes once IndexedDB holds the record of their move (and nothing asks to keep them for now). */
  function removeMoved() {
    if (!legacy) return;
    for (const scope of scopes.values()) {
      if (!scope.moved.length) continue;
      scope.moved = scope.moved.filter(item => {
        const record = scope.entries.get(item.key + MOVED);
        if (!record || record.dirty || !record.stored || !marker(record.v).h.includes(item.hash)) return true;
        try {
          if (legacy.getItem(item.key) !== item.raw) return false; // Rewritten since: a later opening takes those bytes.
          if (options.keepLegacy?.(item.key, legacy)) return true;
          legacy.removeItem(item.key);
        } catch { return true; }
        return false;
      });
    }
  }

  function dirtyRecords(): Array<{ scope: Scope; record: StoreRecord }> {
    const batch: Array<{ scope: Scope; record: StoreRecord }> = [];
    for (const scope of scopes.values()) {
      if (!scope.persist || !scope.ready) continue;
      for (const [k, e] of scope.entries) if (e.dirty) batch.push({ scope, record: { k, v: e.v, c: e.c, p: e.p, t: e.t } });
    }
    return batch;
  }

  /** After IndexedDB took a batch: its entries are stored here, the other tabs are told, refusals end. */
  function written(batch: Array<{ scope: Scope; record: StoreRecord }>) {
    const told = new Map<Scope, StoreRecord[]>();
    for (const { scope, record } of batch) {
      refused.delete(scope.prefix);
      const entry = scope.entries.get(record.k);
      if (!entry || !same(entry, record)) continue;
      entry.dirty = false; entry.stored = true;
      told.set(scope, [...(told.get(scope) ?? []), record]);
    }
    for (const [scope, list] of told) {
      try { scope.channel?.postMessage({ type: 'stored', records: list.map(({ k, c, p, t }) => ({ k, v: null, c, p, t })) }); }
      catch { /* They read IndexedDB when they next open. */ }
    }
    removeMoved();
  }

  function refuse(error: unknown, batch: Array<{ scope: Scope }>) {
    const prefixes = [...new Set(batch.map(item => item.scope.prefix))];
    for (const prefix of prefixes) refused.set(prefix, error);
    for (const listener of [...listeners]) { try { listener(error, prefixes); } catch { /* One listener cannot stop the others. */ } }
  }

  async function flush(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // Only a store that has opened a scope has anything to write (and a page leaving opens no database).
    const db = backend ? await backend : null;
    if (!db) return;
    while (flushing) await flushing.catch(() => {});
    // From here to db.write nothing awaits, so a concurrent flush waits on `flushing` instead of writing the same batch.
    const batch = dirtyRecords();
    if (!batch.length) { removeMoved(); return; }
    const attempt = db.write(batch.map(item => item.record));
    flushing = attempt;
    try {
      await attempt;
      failures = 0;
      written(batch);
    } catch (error) {
      failures += 1;
      // A full disk does not clear by retrying alone; anything else may be momentary.
      if (isCanvasStorageQuotaError(error) || failures >= 3) refuse(error, batch);
    } finally {
      if (flushing === attempt) flushing = null;
    }
    if (dirtyRecords().length) schedule(failures ? RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] : flushDelay);
  }

  /** The page is being hidden, frozen or closed: write everything pending now, in this task, without waiting for a
   * write already under way (versions make writing the same record twice harmless). */
  function flushNow() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const batch = dirtyRecords();
    if (!resolved || !batch.length) return;
    resolved.write(batch.map(item => item.record), { commit: true }).then(() => { failures = 0; written(batch); }, () => schedule(RETRY_MS[0]));
  }

  function readyScope(prefix: string): Scope {
    const scope = scopes.get(prefix);
    if (!scope?.ready) throw new Error('This canvas storage is not open');
    return scope;
  }

  /** Records stamped just above what is stored for their keys, by no page: a tab that opened the scope meanwhile stamps
   * above what it read, with its page, so what this page takes in never outranks what that tab wrote. */
  function stampJustAbove(stored: Map<string, StoreRecord>, items: ReadonlyArray<{ k: string; v: string | null }>): StoreRecord[] {
    const at = now();
    return items.map(item => ({ k: item.k, v: item.v, c: (stored.get(item.k)?.c ?? 0) + 1, p: '', t: at }));
  }
  /** Records stamped above everything stored for their keys (and seen here), for a scope this page does not hold. */
  function stampAbove(stored: Map<string, StoreRecord>, items: ReadonlyArray<{ k: string; v: string | null }>, lead = 0): StoreRecord[] {
    const at = now();
    for (const item of items) clock = Math.max(clock, stored.get(item.k)?.c ?? 0);
    clock += lead;
    return items.map(item => ({ k: item.k, v: item.v, c: ++clock, p: page, t: at }));
  }
  function announce(prefix: string, list: StoreRecord[]) {
    let channel: StoreChannel | null = null;
    try { channel = options.channel?.(CANVAS_STORE_CHANNEL + prefix) ?? null; channel?.postMessage({ type: 'set', records: list, stored: true }); }
    catch { /* A tab of that canvas still reads IndexedDB when it opens it. */ }
    finally { channel?.close(); }
  }

  /** Take in a scope's localStorage keys without opening it (moveLegacy, holding the scope's lock alone). */
  async function sweep(prefix: string, keys: readonly string[], adopt: (name: string) => Adoption | null) {
    const db = await database();
    if (!db || !legacy) return;
    const stored = new Map((await db.load(prefix)).map(record => [record.k, record]));
    const group = decideGroup(prefix, key => stored.get(key));
    const items: Array<{ k: string; v: string | null }> = [];
    const remove: Array<{ key: string; raw: string }> = [];
    for (const key of keys) {
      const adoption = key.startsWith(prefix) ? adopt(key.slice(prefix.length)) : null;
      if (!adoption) continue;
      const decision = adoption === 'mirror' ? group?.decision : undefined;
      if (decision === 'keep') continue;
      let raw: string | null;
      try { raw = legacy.getItem(key); } catch { continue; }
      if (raw === null) continue;
      const hash = bytesHash(raw);
      const seen = marker(stored.get(key + MOVED)?.v);
      if (!seen.h.includes(hash)) {
        if (decision === 'leave' && key === group!.first) {
          let kept: { key: string; value: string } | null | undefined;
          try { kept = options.preserveLegacy?.(prefix, raw, legacy, stored.get(key)?.v ?? null); }
          catch { continue; } // Left in localStorage untouched, for a later opening.
          if (kept && kept.key.startsWith(prefix) && stored.get(kept.key)?.v == null) items.push({ k: kept.key, v: kept.value });
        }
        const takes = decision ? decision === 'take' : takesOver(adoption, raw, stored.get(key), seen);
        if (takes) items.push({ k: key, v: raw });
        // The value's stamp is not known before stamping; marked for a later opening by its hash alone.
        items.push({ k: key + MOVED, v: JSON.stringify({ h: [...seen.h, hash].slice(-8), s: takes ? null : seen.s }) });
      }
      if (removedAfterTaking(adoption)) remove.push({ key, raw });
    }
    if (items.length) {
      const list = stampJustAbove(stored, items);
      // The value and the record of its move, stamped together: the record names the value it was written with.
      for (let index = 0; index < list.length; index++) {
        const record = list[index];
        if (!record.k.endsWith(MOVED) || !list[index - 1] || list[index - 1].k + MOVED !== record.k) continue;
        const seen = marker(record.v);
        record.v = JSON.stringify({ h: seen.h, s: [list[index - 1].c, list[index - 1].p] });
      }
      await db.write(list);
      announce(prefix, list);
    }
    for (const item of remove) {
      try { if (legacy.getItem(item.key) === item.raw && !options.keepLegacy?.(item.key, legacy)) legacy.removeItem(item.key); }
      catch { /* Stays until the canvas opens. */ }
    }
  }

  if (options.watchPage !== false && typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushNow);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
      document.addEventListener('freeze', flushNow);
    }
  }

  return {
    async available() { return (await database()) !== null; },

    async open(prefix, adopt = () => null) {
      const existing = scopes.get(prefix);
      if (existing) { await existing.opened; if (!existing.persist) throw new Error('This canvas storage is open in memory only'); return; }
      const scope: Scope = { prefix, persist: true, ready: false, opened: Promise.resolve(), entries: new Map(), channel: null,
        buffered: [], outbox: new Map(), replies: new Map(), moved: [], watched: new Map(), release: null };
      scopes.set(prefix, scope);
      scope.opened = (async () => {
        const db = await database();
        if (!db) throw new Error('IndexedDB is unavailable');
        // Listen first: a write another tab sends from now on is kept until this scope is ready.
        try { scope.channel = options.channel?.(CANVAS_STORE_CHANNEL + prefix) ?? null; } catch { scope.channel = null; }
        if (scope.channel) scope.channel.onmessage = event => receive(scope, event.data);
        const peers = await holders(prefix);
        await hold(scope);
        // The other tabs' unstored writes first: what they had stored before answering, the read below finds.
        const answered = await ask(scope, peers);
        // A read queued behind a write that never finishes (a suspended tab) must not keep the canvas loading forever.
        let late: ReturnType<typeof setTimeout> | undefined;
        const stored = await Promise.race([db.load(prefix),
          new Promise<never>((_, reject) => { late = setTimeout(() => reject(new Error('IndexedDB did not answer')), loadTimeout); })])
          .finally(() => clearTimeout(late));
        for (const record of stored) if (validStoreRecord(record) && record.k.startsWith(prefix)) take(scope, record, true);
        for (const record of answered) take(scope, record, false);
        for (const { record, stored: told } of scope.buffered ?? []) if (record.k.startsWith(prefix)) take(scope, record, told);
        scope.buffered = null;
        scope.ready = true;
        adoptLegacy(scope, adopt);
        // Old versions and expired tombstones, later and off the opening's path.
        const expired = stored.filter(record => record.v === null && record.t < now() - TOMBSTONE_MS);
        setTimeout(() => { void db.prune(prefix, expired).catch(() => {}); }, pruneDelay);
      })();
      try { await scope.opened; }
      catch (error) {
        if (scopes.get(prefix) === scope) scopes.delete(prefix);
        scope.channel?.close();
        scope.release?.();
        throw error;
      }
    },

    openMemory(prefix, copy) {
      const existing = scopes.get(prefix);
      if (existing?.ready && !existing.persist) return;
      if (existing) throw new Error('This canvas storage is already open');
      const scope: Scope = { prefix, persist: false, ready: true, opened: Promise.resolve(), entries: new Map(), channel: null,
        buffered: null, outbox: new Map(), replies: new Map(), moved: [], watched: new Map(), release: null };
      if (copy) {
        try {
          for (const key of legacyKeys(copy.from, prefix)) {
            if (!copy.adopt(key.slice(prefix.length))) continue;
            const raw = copy.from.getItem(key);
            if (raw !== null) scope.entries.set(key, { v: raw, c: 0, p: page, t: now(), dirty: false, stored: false });
          }
        } catch { /* A storage that cannot be listed leaves an empty scope, as a blocked localStorage read did. */ }
      }
      scopes.set(prefix, scope);
    },

    isOpen(prefix) { return scopes.get(prefix)?.ready === true; },
    inMemory(prefix) { const scope = scopes.get(prefix); return Boolean(scope?.ready && !scope.persist); },
    holdsStoredScopes() { return [...scopes.values()].some(scope => scope.persist && scope.ready); },
    async otherTabs(prefix) {
      if (!options.locks?.query) return null;
      // A tab whose hold still waits (behind a page sweeping the scope) has the canvas open too. This page is among the
      // holds held or waiting once it has asked (opening asks), whichever it is at the moment of the query.
      try {
        const state = await options.locks.query();
        const mine = scopes.get(prefix)?.asked ? 1 : 0;
        const shared = (list: LockInfo[] | undefined) => (list ?? []).filter(lock => lock.name === lockName(prefix) && lock.mode !== 'exclusive').length;
        return Math.max(0, shared(state.held) + shared(state.pending) - mine);
      } catch { return null; }
    },
    async storedKeys(within) {
      const found = new Set<string>();
      for (const scope of scopes.values()) for (const key of scope.entries.keys()) if (key.startsWith(within) && !key.endsWith(MOVED)) found.add(key);
      const db = await database();
      if (db) for (const key of await db.keys(within)) if (key.startsWith(within) && !key.endsWith(MOVED)) found.add(key);
      return [...found];
    },
    get(prefix, key) { return readyScope(prefix).entries.get(key)?.v ?? null; },
    set(prefix, key, value) { writeEntry(readyScope(prefix), key, String(value)); },
    remove(prefix, key) { writeEntry(readyScope(prefix), key, null); },
    keys(prefix) { return [...readyScope(prefix).entries].filter(([k, e]) => e.v !== null && !k.endsWith(MOVED)).map(([k]) => k); },

    async moveLegacy(prefix, keys, adopt) {
      if (!legacy || !keys.length || scopes.has(prefix) || !options.locks) return;
      // Alone with the canvas: a tab holding it took in what it found when it opened, and what it writes now must not
      // meet older bytes; no other page sweeps it meanwhile. A tab that opens it now waits a moment for this lock, and
      // what is written here is stamped below anything such a tab writes anyway.
      await options.locks.request(lockName(prefix), { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return;
        // An IndexedDB that never answers (a suspended tab's write ahead) must not keep the canvas from its tabs.
        let late: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([sweep(prefix, keys, adopt), new Promise<void>(resolve => { late = setTimeout(resolve, loadTimeout); })])
          .finally(() => clearTimeout(late));
      }).catch(() => {});
    },

    async forget(prefix) {
      const scope = scopes.get(prefix);
      if (scope && !scope.persist) { scope.entries.clear(); return; }
      const db = await database();
      if (scope?.ready) {
        // Above any write another tab may still have pending.
        clock += FORGET_LEAD;
        for (const [key, entry] of scope.entries) if (entry.v !== null) writeEntry(scope, key, null);
        await flush();
        return;
      }
      if (!db) return;
      const stored = await db.load(prefix);
      const live = stored.filter(record => record.v !== null && record.k.startsWith(prefix));
      if (!live.length) return;
      const list = stampAbove(new Map(stored.map(record => [record.k, record])), live.map(record => ({ k: record.k, v: null })), FORGET_LEAD);
      await db.write(list);
      announce(prefix, list);
    },

    async forgetIdle(prefix, forgets) {
      if (scopes.has(prefix) || !options.locks) return null;
      const db = await database();
      // Alone with the canvas: a tab that has it open holds it, and one that opens it now waits a moment for this lock.
      // What is removed is decided on what is read here, while alone with it.
      return options.locks.request(lockName(prefix), { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return null;
        const left = new Set<string>();
        if (legacy) {
          for (const key of legacyKeys(legacy, prefix)) {
            if (!forgets(key)) { left.add(key); continue; }
            try { legacy.removeItem(key); } catch { left.add(key); }
          }
        }
        if (!db) return [...left];
        const stored = await db.load(prefix);
        const live = stored.filter(record => record.v !== null && record.k.startsWith(prefix));
        const removed = live.filter(record => forgets(record.k));
        if (removed.length) {
          // As forget's: above any write a tab opening the canvas meanwhile may make.
          const list = stampAbove(new Map(stored.map(record => [record.k, record])), removed.map(record => ({ k: record.k, v: null })), FORGET_LEAD);
          await db.write(list);
          announce(prefix, list);
        }
        for (const record of live) if (!forgets(record.k) && !record.k.endsWith(MOVED)) left.add(record.k);
        // A canvas no page opens any more never has these dropped by its opening.
        const expired = stored.filter(record => record.v === null && record.t < now() - TOMBSTONE_MS);
        if (expired.length) await db.prune(prefix, expired).catch(() => {});
        return [...left];
      });
    },

    flush,
    onFailure(listener) {
      listeners.add(listener);
      // A refusal that stands is told at once, so a canvas opened after it does not autosave as if nothing were wrong.
      if (refused.size) queueMicrotask(() => { for (const [prefix, error] of refused) if (listeners.has(listener)) listener(error, [prefix]); });
      return () => { listeners.delete(listener); };
    },
  };
}
