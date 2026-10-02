import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CANVAS_STORAGE_KEY, emptyDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY } from '../src/canvas/runJournal';
import { CANVAS_BASELINE_KEY, CANVAS_DRAFT_PREFIX, persistCanvasDraft, rememberCanvasBaseline } from '../src/saas/canvasDraft';

const quotaError = () => new DOMException('Storage quota exceeded', 'QuotaExceededError');
beforeEach(() => { localStorage.clear(); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a'); });
afterEach(() => { vi.restoreAllMocks(); });

it('reclaims only the captured canvas baseline and retries the exact draft once', () => {
  const storage = canvasStorage(); const document = emptyDocument();
  rememberCanvasBaseline(storage, 7, document);
  const protectedValues = new Map([
    [CANVAS_STORAGE_KEY, JSON.stringify(document)],
    [CANVAS_RUN_JOURNAL_KEY, '{"running":"must-remain"}'],
    [`${CANVAS_DRAFT_PREFIX}another-writer`, '{"future-format":"must-remain"}'],
  ]);
  for (const [key, value] of protectedValues) storage.setItem(key, value);
  const ownDraftKey = canvasStorageKey(`${CANVAS_DRAFT_PREFIX}writer-a`);
  // A late operation still belongs to the original account/workspace/canvas.
  configureCanvasStorage('user-b', 'tenant-b', 'canvas-b');
  const otherStorage = canvasStorage();
  rememberCanvasBaseline(otherStorage, 9, document);
  const otherBaseline = otherStorage.getItem(CANVAS_BASELINE_KEY);
  const setItem = localStorage.setItem.bind(localStorage);
  const attempts: string[] = [];
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === ownDraftKey) {
      attempts.push(value);
      if (storage.getItem(CANVAS_BASELINE_KEY)) throw quotaError();
    }
    setItem(key, value);
  });
  const remove = vi.spyOn(localStorage, 'removeItem');
  const draft = persistCanvasDraft(storage, 'writer-a', 7, document);
  expect(attempts).toEqual([JSON.stringify(draft), JSON.stringify(draft)]);
  expect(storage.getItem(CANVAS_BASELINE_KEY)).toBeNull();
  expect(storage.getItem(`${CANVAS_DRAFT_PREFIX}writer-a`)).toBe(JSON.stringify(draft));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('awwo.saas:user-a:tenant-a:canvas-a:' + CANVAS_BASELINE_KEY);
  for (const [key, value] of protectedValues) expect(storage.getItem(key)).toBe(value);
  expect(otherStorage.getItem(CANVAS_BASELINE_KEY)).toBe(otherBaseline);
});

it('keeps all previous draft bytes if freeing the baseline is still insufficient', () => {
  const storage = canvasStorage(); const document = emptyDocument();
  const previous = persistCanvasDraft(storage, 'writer-a', 7, document);
  const otherRaw = '{"unknown-content":"keep exactly"}';
  storage.setItem(`${CANVAS_DRAFT_PREFIX}other`, otherRaw);
  storage.setItem(CANVAS_STORAGE_KEY, 'existing cache');
  storage.setItem(CANVAS_RUN_JOURNAL_KEY, 'existing journal');
  rememberCanvasBaseline(storage, 7, document);
  const ownKey = canvasStorageKey(`${CANVAS_DRAFT_PREFIX}writer-a`);
  const setItem = localStorage.setItem.bind(localStorage); let attempts = 0;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === ownKey) { attempts++; throw quotaError(); }
    setItem(key, value);
  });
  expect(() => persistCanvasDraft(storage, 'writer-a', 7, { ...document, updatedAt: document.updatedAt + 1 })).toThrow('Storage quota exceeded');
  expect(attempts).toBe(2);
  expect(storage.getItem(CANVAS_BASELINE_KEY)).toBeNull();
  expect(storage.getItem(`${CANVAS_DRAFT_PREFIX}writer-a`)).toBe(JSON.stringify(previous));
  expect(storage.getItem(`${CANVAS_DRAFT_PREFIX}other`)).toBe(otherRaw);
  expect(storage.getItem(CANVAS_STORAGE_KEY)).toBe('existing cache');
  expect(storage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe('existing journal');
});

it('does not retry or remove anything when no baseline can be reclaimed', () => {
  const storage = canvasStorage();
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw quotaError(); });
  const remove = vi.spyOn(localStorage, 'removeItem');
  expect(() => persistCanvasDraft(storage, 'writer-a', 7, emptyDocument())).toThrow('Storage quota exceeded');
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});

it('does not reclaim a baseline for non-quota failures', () => {
  const storage = canvasStorage(); const document = emptyDocument();
  rememberCanvasBaseline(storage, 7, document); const baseline = storage.getItem(CANVAS_BASELINE_KEY);
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage access denied', 'SecurityError'); });
  const remove = vi.spyOn(localStorage, 'removeItem');
  expect(() => persistCanvasDraft(storage, 'writer-a', 7, document)).toThrow('Storage access denied');
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(storage.getItem(CANVAS_BASELINE_KEY)).toBe(baseline);
});

it.each(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])('treats a %s baseline write as an optional optimization', name => {
  const storage = canvasStorage(); const document = emptyDocument();
  rememberCanvasBaseline(storage, 7, document); const baseline = storage.getItem(CANVAS_BASELINE_KEY);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', name); });
  const remove = vi.spyOn(localStorage, 'removeItem');
  expect(() => rememberCanvasBaseline(storage, 8, { ...document, updatedAt: document.updatedAt + 1 })).not.toThrow();
  expect(storage.getItem(CANVAS_BASELINE_KEY)).toBe(baseline);
  expect(remove).not.toHaveBeenCalled();
});

it('still surfaces non-quota baseline failures', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  expect(() => rememberCanvasBaseline(canvasStorage(), 7, emptyDocument())).toThrow('Storage unavailable');
});
