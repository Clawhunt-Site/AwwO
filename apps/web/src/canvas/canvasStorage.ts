/** An optional SaaS namespace. Legacy local development retains its original keys. */
let scope = '';
export function configureCanvasStorage(userId: string, tenantId: string, canvasId: string): void {
  scope = [userId, tenantId, canvasId].map(encodeURIComponent).join(':');
}
export function canvasStorageKey(key: string): string { return scope ? `awwo.saas:${scope}:${key}` : key; }
export function canvasStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys(): string[] } {
  // Capture the namespace so a pending operation cannot cross a later account boundary.
  const captured = scope;
  const keyOf = (key: string) => captured ? `awwo.saas:${captured}:${key}` : key;
  const prefix = keyOf('');
  return {
    getItem: key => localStorage.getItem(keyOf(key)),
    setItem: (key, value) => {
      localStorage.setItem(keyOf(key), value);
      window.dispatchEvent(new CustomEvent('awwo:canvas-cache-write', { detail: { key, storageKey: keyOf(key) } }));
    },
    removeItem: key => localStorage.removeItem(keyOf(key)),
    keys: () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix)).map(key => key.slice(prefix.length)),
  };
}
