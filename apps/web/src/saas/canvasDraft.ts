import { sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import type { canvasStorage } from '../canvas/canvasStorage';
import { CANVAS_BASELINE_KEY, compressedCanvasBaseline, isCanvasStorageQuotaError, matchesCompressedCanvasBaseline } from './canvasBaselineCompression';
export { CANVAS_BASELINE_KEY, isCanvasStorageQuotaError } from './canvasBaselineCompression';

export const CANVAS_DRAFT_PREFIX = 'awwo.cloud.draft.v1:';
export const CANVAS_KEPT_DRAFTS_KEY = 'awwo.cloud.kept-drafts.v1';
type ScopedStorage = ReturnType<typeof canvasStorage>;
export type CanvasDraft = {
  schemaVersion: 1;
  writerId: string;
  revision: string;
  baseVersion: number;
  dirty: true;
  updatedAt: number;
  document: CanvasDocument;
};
export type SavedCanvasDraft = { key: string; raw: string; draft: CanvasDraft | null };
type KeptDraftIdentity = { key: string; revision: string; baseVersion: number } | { key: string; raw: string };
const MAX_KEPT_CORRUPT_RAW_LENGTH = 64 * 1024;

function keptDraftIdentity(saved: SavedCanvasDraft): KeptDraftIdentity | null {
  if (saved.draft) return { key: saved.key, revision: saved.draft.revision, baseVersion: saved.draft.baseVersion };
  // Exact bytes avoid hiding a changed corrupt record; bound the extra storage cost.
  return saved.raw.length <= MAX_KEPT_CORRUPT_RAW_LENGTH ? { key: saved.key, raw: saved.raw } : null;
}

/** A cloud-choice only dismisses the exact valid draft revisions the user reviewed. */
export function unreviewedCanvasDrafts(storage: ScopedStorage, drafts: SavedCanvasDraft[]): SavedCanvasDraft[] {
  let kept: KeptDraftIdentity[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(CANVAS_KEPT_DRAFTS_KEY) || 'null');
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.drafts)) kept = parsed.drafts;
  } catch { /* A damaged marker must never conceal a draft. */ }
  return drafts.filter(saved => {
    const identity = keptDraftIdentity(saved);
    if (!identity) return true;
    return !kept.some(item => item?.key === identity.key && ('raw' in identity
      ? 'raw' in item && item.raw === identity.raw
      : 'revision' in item && item.revision === identity.revision && item.baseVersion === identity.baseVersion));
  });
}

/** Keep the source bytes untouched. A concurrent edit must not be dismissed unseen. */
export function rememberKeptCanvasDrafts(storage: ScopedStorage, drafts: SavedCanvasDraft[]): void {
  if (drafts.some(saved => storage.getItem(saved.key) !== saved.raw)) throw new Error('草稿状态刚被另一个页面更新，请重新连接后核对。');
  storage.setItem(CANVAS_KEPT_DRAFTS_KEY, JSON.stringify({ schemaVersion: 1, drafts: drafts.map(keptDraftIdentity).filter((item): item is KeptDraftIdentity => item !== null) }));
}

/** Object key order is transport metadata; array order and every document value remain significant. */
export function canonicalCanvasDocumentJSON(document: unknown): string {
  return JSON.stringify(sanitizeDocument(document), (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
}

export function rememberCanvasBaseline(storage: ScopedStorage, version: number, document: unknown): void {
  let previousVersion = 0;
  try { previousVersion = JSON.parse(storage.getItem(CANVAS_BASELINE_KEY) || '{}').version || 0; } catch { /* Replace a corrupt clean marker, never draft data. */ }
  if (previousVersion > version) return; // A late response cannot roll a newer acknowledgement backwards.
  const baseline = compressedCanvasBaseline(version, canonicalCanvasDocumentJSON(document));
  if (baseline === null) return; // Oversized optional proof; the acknowledged cloud document still exists.
  try { storage.setItem(CANVAS_BASELINE_KEY, baseline); }
  catch (error) {
    // This is only a proof cache. Losing it may prompt recovery, but cannot lose edits
    // or turn a successful server save into an unsynced document.
    if (!isCanvasStorageQuotaError(error)) throw error;
  }
}

export function isKnownSyncedCache(storage: ScopedStorage, document: CanvasDocument): boolean {
  try {
    const stored = JSON.parse(storage.getItem(CANVAS_BASELINE_KEY) || '{}');
    if (stored.encoding !== undefined || stored.migrated !== undefined) {
      return matchesCompressedCanvasBaseline(stored, canonicalCanvasDocumentJSON(document));
    }
    // Existing clean markers used insertion order, so normalize them while reading too.
    const baseline = JSON.parse(stored.document);
    if (baseline?.version !== 2 || !Array.isArray(baseline.nodes) || !Array.isArray(baseline.edges)) return false;
    return canonicalCanvasDocumentJSON(baseline) === canonicalCanvasDocumentJSON(document);
  }
  catch { return false; }
}

/** Each editor owns a separate key. A second tab cannot overwrite the first tab's unsaved work. */
export function persistCanvasDraft(storage: ScopedStorage, writerId: string, baseVersion: number, document: CanvasDocument): CanvasDraft {
  const draft: CanvasDraft = { schemaVersion: 1, writerId, revision: crypto.randomUUID(), baseVersion, dirty: true, updatedAt: Date.now(), document };
  const key = `${CANVAS_DRAFT_PREFIX}${writerId}`;
  const raw = JSON.stringify(draft);
  try { storage.setItem(key, raw); }
  catch (error) {
    if (!isCanvasStorageQuotaError(error) || storage.getItem(CANVAS_BASELINE_KEY) === null) throw error;
    // Reclaim only the captured canvas's optional synced proof. Never evict drafts,
    // the current document or run journals, even if another tab changes them.
    storage.removeItem(CANVAS_BASELINE_KEY);
    storage.setItem(key, raw);
  }
  return draft;
}

export function readCanvasDrafts(storage: ScopedStorage): SavedCanvasDraft[] {
  return storage.keys().filter(key => key.startsWith(CANVAS_DRAFT_PREFIX)).map(key => {
    const raw = storage.getItem(key) || '';
    try {
      const draft = JSON.parse(raw);
      if (draft.schemaVersion !== 1 || draft.dirty !== true || typeof draft.writerId !== 'string' || typeof draft.revision !== 'string'
        || !Number.isInteger(draft.baseVersion) || draft.baseVersion < 1 || !draft.document || draft.document.version !== 2
        || !Array.isArray(draft.document.nodes) || !Array.isArray(draft.document.edges)) throw new Error('invalid draft');
      return { key, raw, draft: draft as CanvasDraft };
    } catch { return { key, raw, draft: null }; } // Damaged drafts remain available for raw export, never silently deleted.
  }).sort((a, b) => (b.draft?.updatedAt || 0) - (a.draft?.updatedAt || 0));
}

/** Remove only the revision the operator discarded or the server actually acknowledged. */
export function removeCanvasDraft(storage: ScopedStorage, saved: SavedCanvasDraft): boolean {
  if (storage.getItem(saved.key) !== saved.raw) return false;
  storage.removeItem(saved.key); return true;
}

export function acknowledgeCanvasDraft(storage: ScopedStorage, sent: CanvasDraft, savedVersion: number): void {
  const key = `${CANVAS_DRAFT_PREFIX}${sent.writerId}`;
  const raw = storage.getItem(key);
  if (!raw) return;
  const current = JSON.parse(raw) as CanvasDraft;
  if (current.revision === sent.revision) storage.removeItem(key);
  else if (current.baseVersion === sent.baseVersion) {
    // Edits made during the request now build on its confirmed version and remain dirty.
    storage.setItem(key, JSON.stringify({ ...current, baseVersion: savedVersion }));
  }
}
