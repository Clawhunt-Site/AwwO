import { sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import type { canvasStorage } from '../canvas/canvasStorage';

export const CANVAS_DRAFT_PREFIX = 'awwo.cloud.draft.v1:';
export const CANVAS_BASELINE_KEY = 'awwo.cloud.baseline.v1';
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
  storage.setItem(CANVAS_BASELINE_KEY, JSON.stringify({ version, document: canonicalCanvasDocumentJSON(document) }));
}

export function isKnownSyncedCache(storage: ScopedStorage, document: CanvasDocument): boolean {
  try {
    // Existing clean markers used insertion order, so normalize them while reading too.
    const baseline = JSON.parse(JSON.parse(storage.getItem(CANVAS_BASELINE_KEY) || '{}').document);
    if (baseline?.version !== 2 || !Array.isArray(baseline.nodes) || !Array.isArray(baseline.edges)) return false;
    return canonicalCanvasDocumentJSON(baseline) === canonicalCanvasDocumentJSON(document);
  }
  catch { return false; }
}

/** Each editor owns a separate key. A second tab cannot overwrite the first tab's unsaved work. */
export function persistCanvasDraft(storage: ScopedStorage, writerId: string, baseVersion: number, document: CanvasDocument): CanvasDraft {
  const draft: CanvasDraft = { schemaVersion: 1, writerId, revision: crypto.randomUUID(), baseVersion, dirty: true, updatedAt: Date.now(), document };
  storage.setItem(`${CANVAS_DRAFT_PREFIX}${writerId}`, JSON.stringify(draft));
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
