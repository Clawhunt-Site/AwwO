import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';

const baselineKey = 'awwo.cloud.baseline.v1';
const quotaError = () => new DOMException('Storage quota exceeded', 'QuotaExceededError');
const ownPrefix = 'awwo.saas:user%3Aa:';
function baseline(): string {
  const document = { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }),
    persona: '已保存的完整任务说明与原始上下文 🧭\n'.repeat(1600) }] };
  return JSON.stringify({ version: 7, document: JSON.stringify(document) });
}
function snapshot(): Map<string, string | null> {
  return new Map(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
    .map(key => [key, localStorage.getItem(key)]));
}
let events: CustomEvent[] = [];
const observe = (event: Event) => events.push(event as CustomEvent);
beforeEach(() => {
  localStorage.clear(); configureCanvasStorage('user:a', 'tenant-a', 'canvas-a'); events = [];
  window.addEventListener('awwo:canvas-cache-write', observe);
});
afterEach(() => {
  window.removeEventListener('awwo:canvas-cache-write', observe);
  vi.restoreAllMocks(); localStorage.clear();
});

describe('captured canvas cache writes under quota pressure', () => {
  it('losslessly compacts only the captured account proofs and retries the exact pending write once', () => {
    const captured = canvasStorage();
    const requestedKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    const originalBaseline = baseline();
    const proofKeys = [`${ownPrefix}tenant-a:canvas-a:${baselineKey}`, `${ownPrefix}tenant-b:canvas-b:${baselineKey}`];
    for (const key of proofKeys) localStorage.setItem(key, originalBaseline);
    const protectedValues = new Map([
      [`${ownPrefix}tenant-a:canvas-a:awwo.cloud.draft.v1:writer`, 'unsent draft bytes'],
      [`${ownPrefix}tenant-a:canvas-a:awwo.canvas.run.v1`, 'accepted run journal bytes'],
      ['awwo.saas:user%3Aab:tenant-a:canvas-a:' + baselineKey, originalBaseline],
      ['awwo.saas:other-user:tenant-b:canvas-b:' + baselineKey, originalBaseline],
      ['unrelated-preference', 'keep this'],
    ]);
    for (const [key, value] of protectedValues) localStorage.setItem(key, value);
    configureCanvasStorage('other-user', 'tenant-b', 'canvas-b');
    const write = localStorage.setItem.bind(localStorage);
    const attempts: Array<[string, string]> = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === requestedKey) {
        attempts.push([key, value]);
        if (proofKeys.some(proof => localStorage.getItem(proof) === originalBaseline)) throw quotaError();
      }
      write(key, value);
    });
    const remove = vi.spyOn(localStorage, 'removeItem');
    const payload = 'exact pending document bytes \u0000 🧭';
    captured.setItem(CANVAS_STORAGE_KEY, payload);
    expect(attempts).toEqual([[requestedKey, payload], [requestedKey, payload]]);
    expect(localStorage.getItem(requestedKey)).toBe(payload);
    for (const key of proofKeys) expect(localStorage.getItem(key)!.length).toBeLessThan(originalBaseline.length);
    for (const [key, value] of protectedValues) expect(localStorage.getItem(key)).toBe(value);
    expect(remove).not.toHaveBeenCalled();
    expect(events.map(event => event.detail)).toEqual([{ key: CANVAS_STORAGE_KEY, storageKey: requestedKey }]);
  });

  it('publishes no cache event when the exact retry still fails and preserves the previous payload', () => {
    const storage = canvasStorage(); const requestedKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    const proofKey = canvasStorageKey(baselineKey); const proof = baseline();
    localStorage.setItem(proofKey, proof); localStorage.setItem(requestedKey, 'previous payload');
    const write = localStorage.setItem.bind(localStorage);
    const retryError = new DOMException('Still no room', 'QuotaExceededError');
    const attempts: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === requestedKey) { attempts.push(value); throw attempts.length === 1 ? quotaError() : retryError; }
      write(key, value);
    });
    expect(() => storage.setItem(CANVAS_STORAGE_KEY, 'new payload')).toThrow(retryError);
    expect(attempts).toEqual(['new payload', 'new payload']);
    expect(localStorage.getItem(requestedKey)).toBe('previous payload');
    expect(localStorage.getItem(proofKey)!.length).toBeLessThan(proof.length);
    expect(events).toEqual([]);
  });

  it('does not compact or retry an ordinary storage failure', () => {
    const storage = canvasStorage(); localStorage.setItem(canvasStorageKey(baselineKey), baseline());
    const before = snapshot(); const denied = new DOMException('Storage access denied', 'SecurityError');
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw denied; });
    expect(() => storage.setItem(CANVAS_STORAGE_KEY, 'new payload')).toThrow(denied);
    expect(write).toHaveBeenCalledOnce(); expect(snapshot()).toEqual(before); expect(events).toEqual([]);
  });

  it('does not compact another account when the captured account has no eligible proof', () => {
    const storage = canvasStorage();
    localStorage.setItem('awwo.saas:other-user:tenant:canvas:' + baselineKey, baseline());
    const before = snapshot(); const full = quotaError();
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw full; });
    expect(() => storage.setItem(CANVAS_STORAGE_KEY, 'new payload')).toThrow(full);
    expect(write).toHaveBeenCalledOnce(); expect(snapshot()).toEqual(before); expect(events).toEqual([]);
  });

  it('never widens compaction to all accounts when no user identity was configured', () => {
    configureCanvasStorage('', '', ''); const storage = canvasStorage();
    localStorage.setItem(`${ownPrefix}tenant:canvas:${baselineKey}`, baseline());
    const before = snapshot(); const full = quotaError();
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw full; });
    expect(() => storage.setItem(CANVAS_STORAGE_KEY, 'new payload')).toThrow(full);
    expect(write).toHaveBeenCalledOnce(); expect(snapshot()).toEqual(before); expect(events).toEqual([]);
  });

  it('leaves existing proofs untouched when the first write succeeds', () => {
    const storage = canvasStorage(); const proof = baseline(); const proofKey = canvasStorageKey(baselineKey);
    localStorage.setItem(proofKey, proof); const write = vi.spyOn(localStorage, 'setItem');
    storage.setItem(CANVAS_STORAGE_KEY, 'new payload');
    expect(write).toHaveBeenCalledOnce(); expect(localStorage.getItem(proofKey)).toBe(proof);
    expect(events.map(event => event.detail)).toEqual([{ key: CANVAS_STORAGE_KEY, storageKey: canvasStorageKey(CANVAS_STORAGE_KEY) }]);
  });
});
