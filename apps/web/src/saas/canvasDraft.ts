import { sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import type { canvasStorage } from '../canvas/canvasStorage';
import { bytesHash } from '../canvas/canvasStore';
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
  /** An earlier release's cache kept for export: its base is not known, so it is never restored. */
  legacyCache?: true;
  /** Written while its page had a save out, built on the same base: that save's document (its hash). If the page closed
   * before the reply and the server stored the save, the cloud is one version on and holds exactly that document, which
   * this draft, a later state of the same page, builds on. */
  sending?: CanvasDraftSending;
};
export type CanvasDraftSending = { baseVersion: number; hash: string };
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

/** A document's identity as the server stores it (object key order aside); `canonical` when the caller has it already. */
export function canvasDocumentHash(document: unknown, canonical = canonicalCanvasDocumentJSON(document)): string { return bytesHash(canonical); }

/** The cloud version a draft can be restored onto: its base, or, when its page has closed (`closed`: no other tab has
 * the canvas open), the cloud's version if the cloud holds exactly the save that page had out when it wrote the draft
 * (see CanvasDraft.sending). Null when the cloud has moved on. `cloudHash` lets a caller hash a big cloud document once. */
export function restorableCanvasDraftBase(draft: CanvasDraft, cloud: { version: number; document: unknown }, closed: boolean,
  cloudHash: () => string = () => canvasDocumentHash(cloud.document)): number | null {
  if (draft.legacyCache) return null;
  if (draft.baseVersion === cloud.version) return cloud.version;
  const sending = draft.sending;
  return closed && sending && sending.baseVersion === draft.baseVersion && cloud.version === draft.baseVersion + 1 && sending.hash === cloudHash()
    ? cloud.version : null;
}

/** Each editor owns a separate key. A second tab cannot overwrite the first tab's unsaved work. */
export function persistCanvasDraft(storage: ScopedStorage, writerId: string, baseVersion: number, document: CanvasDocument,
  sending?: CanvasDraftSending | null): CanvasDraft {
  const draft: CanvasDraft = { schemaVersion: 1, writerId, revision: crypto.randomUUID(), baseVersion, dirty: true, updatedAt: Date.now(), document,
    ...(sending && sending.baseVersion === baseVersion ? { sending } : {}) };
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

/** An earlier release's document cache the canvas store does not take in (a tab of this release wrote the canvas's own
 * since): that tab's unsynced edits may be only there (its draft write failed on a full localStorage), so it is kept as
 * a draft offered for export, unless it holds nothing more than its own sync proof, this store's cache or a draft that
 * tab wrote (which carries its true base). Export only (`legacyCache`): the version it was based on is not known, since
 * that release's tabs share one version key, and restoring it could overwrite newer cloud edits. Keyed by its bytes, so
 * the same cache is kept once; unreadable bytes hold no edit anyone can restore and are not kept. */
export function preserveLegacyCanvasCache(prefix: string, raw: string, legacy: Pick<Storage, 'getItem' | 'key' | 'length'>,
  current: string | null): { key: string; value: string } | null {
  const document = readableDocument(raw);
  if (!document) return null;
  const proof = { getItem: (name: string) => legacy.getItem(prefix + name) } as unknown as ScopedStorage;
  if (isKnownSyncedCache(proof, document)) return null;
  const canonical = canonicalCanvasDocumentJSON(document);
  const same = (bytes: string | null) => { const other = bytes === null ? null : readableDocument(bytes); return other !== null && canonicalCanvasDocumentJSON(other) === canonical; };
  if (same(current)) return null;
  for (let index = 0; index < legacy.length; index++) {
    const key = legacy.key(index);
    if (!key?.startsWith(prefix + CANVAS_DRAFT_PREFIX)) continue;
    try { const draft = JSON.parse(legacy.getItem(key) ?? 'null'); if (draft?.document && same(JSON.stringify(draft.document))) return null; }
    catch { /* A damaged draft is no match. */ }
  }
  const writerId = `legacy-cache-${bytesHash(raw).replace(':', '-')}`;
  const version = Number(legacy.getItem(prefix + 'awwo.cloud.version'));
  const draft: CanvasDraft = { schemaVersion: 1, writerId, revision: crypto.randomUUID(), baseVersion: Number.isSafeInteger(version) && version >= 1 ? version : 1,
    dirty: true, updatedAt: Date.now(), document, legacyCache: true };
  return { key: `${prefix}${CANVAS_DRAFT_PREFIX}${writerId}`, value: JSON.stringify(draft) };
}
function readableDocument(raw: string): CanvasDocument | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? sanitizeDocument(parsed) : null;
  } catch { return null; }
}

export function readCanvasDrafts(storage: ScopedStorage): SavedCanvasDraft[] {
  return storage.keys().filter(key => key.startsWith(CANVAS_DRAFT_PREFIX)).map(key => {
    const raw = storage.getItem(key) || '';
    try {
      const draft = JSON.parse(raw);
      if (draft.schemaVersion !== 1 || draft.dirty !== true || typeof draft.writerId !== 'string' || typeof draft.revision !== 'string'
        || !Number.isInteger(draft.baseVersion) || draft.baseVersion < 1 || !draft.document || draft.document.version !== 2
        || !Array.isArray(draft.document.nodes) || !Array.isArray(draft.document.edges)) throw new Error('invalid draft');
      // A damaged record of a save that was out proves nothing; the draft itself stays whole.
      if (draft.sending !== undefined && !(Number.isInteger(draft.sending?.baseVersion) && typeof draft.sending?.hash === 'string')) delete draft.sending;
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
    // Edits made during the request now build on its confirmed version and remain dirty; no save is out any more.
    storage.setItem(key, JSON.stringify({ ...current, baseVersion: savedVersion, sending: undefined }));
  }
}
