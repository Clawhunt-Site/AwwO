import '@testing-library/jest-dom/vitest';

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
