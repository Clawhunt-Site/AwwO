import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// Native dialogs are exercised in browser acceptance; jsdom needs the open state API.
if (typeof HTMLDialogElement !== 'undefined') {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
}

// jsdom does not implement Web Locks. Model exclusive ifAvailable ownership, including release,
// so all canvas interaction tests exercise the same asynchronous entry gate as a real browser.
const heldLocks = new Map<string, Promise<void>>();
beforeEach(() => heldLocks.clear());
Object.defineProperty(navigator, 'locks', { configurable: true, value: {
  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
    while (heldLocks.has(name)) {
      if (options.ifAvailable) return callback(null);
      await heldLocks.get(name);
    }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    heldLocks.set(name, held);
    try { return await callback({ name, mode: 'exclusive' }); }
    finally { if (heldLocks.get(name) === held) heldLocks.delete(name); release(); }
  },
} });

function createLocalStorage() {
  const store = new Map<string, string>();
  return {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    get length() {
      return store.size;
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createLocalStorage(),
});

Object.defineProperty(globalThis, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

// CI runs the whole web suite on a constrained runner where many test files
// compete for CPU, so an async assertion that resolves in well under a second
// locally can take longer there. Give waitFor/findBy more headroom (the default
// is 1000ms) so a slow-but-correct async chain isn't reported as a failure; a
// genuinely never-true condition still fails, just later.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5000 });
