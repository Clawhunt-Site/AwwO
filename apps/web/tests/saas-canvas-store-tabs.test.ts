import { expect, it } from 'vitest';
import { CANVAS_STORE_CHANNEL, createCanvasStore } from '../src/canvas/canvasStore';
import { channelHub, memoryBackend } from './saas-canvas-store-fakes';

// How many other tabs have a canvas open, as the canvas store counts them from the Web Locks state.
const P = 'awwo.saas:user-a:tenant-a:canvas-a:';
const NAME = CANVAS_STORE_CHANNEL + P;
type Held = { name: string; mode: LockMode };

/** Web Locks that grant this page's shared hold at once and report `others` (held or waiting) beside it. */
function locksWith(others: { held?: Held[]; pending?: Held[] }, options: { refuse?: boolean; failQuery?: boolean } = {}) {
  const held: Held[] = [];
  const locks = {
    request(name: string, lockOptions: LockOptions, callback: LockGrantedCallback) {
      if (options.refuse) return Promise.reject(new DOMException('No locks here', 'SecurityError'));
      const lock = { name, mode: lockOptions.mode ?? 'exclusive' as LockMode };
      held.push(lock);
      return Promise.resolve(callback(lock as unknown as Parameters<LockGrantedCallback>[0]));
    },
    async query() {
      if (options.failQuery) throw new Error('query failed');
      return { held: [...held, ...(others.held ?? [])].map(lock => ({ ...lock, clientId: 'tab' })), pending: (others.pending ?? []).map(lock => ({ ...lock, clientId: 'tab' })) };
    },
  };
  return locks as unknown as LockManager;
}
async function opened(locks: LockManager | null) {
  const backend = memoryBackend();
  const store = createCanvasStore({ backend: async () => backend.backend, channel: channelHub().channel, locks, flushDelay: 5, peerWait: 50, watchPage: false });
  await store.open(P);
  return store;
}

it('counts no other tab when this page is the only one holding the canvas', async () => {
  expect(await (await opened(locksWith({}))).otherTabs(P)).toBe(0);
});

it('counts another tab holding the canvas, and one whose hold waits behind a page sweeping it', async () => {
  expect(await (await opened(locksWith({ held: [{ name: NAME, mode: 'shared' }] }))).otherTabs(P)).toBe(1);
  expect(await (await opened(locksWith({ pending: [{ name: NAME, mode: 'shared' }] }))).otherTabs(P)).toBe(1);
  expect(await (await opened(locksWith({ held: [{ name: NAME, mode: 'shared' }], pending: [{ name: NAME, mode: 'shared' }] }))).otherTabs(P)).toBe(2);
});

it('counts neither a page sweeping the canvas nor another canvas\'s tabs', async () => {
  expect(await (await opened(locksWith({ held: [{ name: NAME, mode: 'exclusive' }, { name: CANVAS_STORE_CHANNEL + 'other:', mode: 'shared' }] }))).otherTabs(P)).toBe(0);
});

it('does not take this page off when its own hold was refused', async () => {
  expect(await (await opened(locksWith({ held: [{ name: NAME, mode: 'shared' }] }, { refuse: true }))).otherTabs(P)).toBe(1);
});

it('cannot say without Web Locks or when the browser does not answer', async () => {
  expect(await (await opened(null)).otherTabs(P)).toBeNull();
  expect(await (await opened(locksWith({}, { failQuery: true }))).otherTabs(P)).toBeNull();
});
