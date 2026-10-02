import { compactCanvasBaselinesForUser, isCanvasStorageQuotaError } from '../saas/canvasBaselineCompression';

/** An optional SaaS namespace. Legacy local development retains its original keys. */
let scope = '';
export function configureCanvasStorage(userId: string, tenantId: string, canvasId: string): void {
  scope = [userId, tenantId, canvasId].map(encodeURIComponent).join(':');
}
export function canvasStorageKey(key: string): string { return scope ? `awwo.saas:${scope}:${key}` : key; }
/** The same account and workspace namespace without the canvas, for small facts that describe how
 * this workspace behaves rather than one canvas (such as how long its plans take). */
export function workspaceStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const captured = scope.split(':').slice(0, 2).join(':');
  const keyOf = (key: string) => captured ? `awwo.saas:${captured}:${key}` : key;
  return { getItem: key => localStorage.getItem(keyOf(key)), setItem: (key, value) => localStorage.setItem(keyOf(key), value) };
}
export function canvasStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys(): string[] } {
  // Capture the namespace so a pending operation cannot cross a later account boundary.
  const captured = scope;
  const capturedUser = captured.split(':')[0];
  const userPrefix = capturedUser ? `awwo.saas:${capturedUser}:` : '';
  const keyOf = (key: string) => captured ? `awwo.saas:${captured}:${key}` : key;
  const prefix = keyOf('');
  return {
    getItem: key => localStorage.getItem(keyOf(key)),
    setItem: (key, value) => {
      const storageKey = keyOf(key);
      try { localStorage.setItem(storageKey, value); }
      catch (error) {
        if (!isCanvasStorageQuotaError(error) || !userPrefix
          || compactCanvasBaselinesForUser(localStorage, userPrefix) === 0) throw error;
        // Only losslessly compact optional proofs, then retry the original write.
        // A failed retry must still surface, without broadcasting a saved cache.
        localStorage.setItem(storageKey, value);
      }
      window.dispatchEvent(new CustomEvent('awwo:canvas-cache-write', { detail: { key, storageKey } }));
    },
    removeItem: key => localStorage.removeItem(keyOf(key)),
    keys: () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix)).map(key => key.slice(prefix.length)),
  };
}
