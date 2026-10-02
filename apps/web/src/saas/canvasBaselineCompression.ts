import { gzipSync, strFromU8, strToU8 } from 'fflate';

export const CANVAS_BASELINE_KEY = 'awwo.cloud.baseline.v1';
const MAX_BASELINE_CHARACTERS = 2 * 1024 * 1024;
const MAX_SCANNED_KEYS = 512;
const MAX_COMPACTED_BASELINES = 64;
const MAX_COMPACTION_CHARACTERS = 8 * 1024 * 1024;
type Baseline = { version: number; document: string; encoding?: 'gzip'; migrated?: true };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function version(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function packed(document: string): string | null {
  if (document.length > MAX_BASELINE_CHARACTERS) return null;
  const bytes = strToU8(document);
  if (strFromU8(bytes) !== document) return null; // Never replace malformed UTF-16 with replacement characters.
  // gzip is a lossless, deterministic encoding of the complete proof, not a hash.
  // Comparing this exact value needs no decompression of untrusted storage bytes.
  return btoa(strFromU8(gzipSync(bytes, { level: 9, mtime: 0 }), true));
}

/** Only fresh cloud acknowledgements may create a trusted compact proof. */
export function compressedCanvasBaseline(versionNumber: number, canonicalDocument: string): string | null {
  if (!version(versionNumber)) return null;
  const document = packed(canonicalDocument);
  return document === null ? null : JSON.stringify({ version: versionNumber, encoding: 'gzip', document });
}

export function matchesCompressedCanvasBaseline(value: unknown, canonicalDocument: string): boolean {
  if (!object(value) || !exactKeys(value, ['version', 'encoding', 'document']) || !version(value.version)
    || value.encoding !== 'gzip' || typeof value.document !== 'string') return false;
  const candidate = packed(canonicalDocument);
  return candidate !== null && candidate === value.document;
}

function encodedSegment(segment: string): boolean {
  try { return Boolean(segment) && encodeURIComponent(decodeURIComponent(segment)) === segment; }
  catch { return false; }
}

/** Compact only derived proofs for this captured user; never evict source documents or drafts.
 * A synchronous raw recheck is not a cross-tab CAS. Migrated proofs are deliberately untrusted:
 * even if an old tab changes a proof between recheck and replacement, the result cannot conceal
 * unsynced edits. A subsequent fresh cloud acknowledgement restores the normal clean marker.
 */
export function compactCanvasBaselinesForUser(storage: Storage, userPrefix: string): number {
  const user = /^awwo\.saas:([^:]+):$/.exec(userPrefix)?.[1];
  if (!user || !encodedSegment(user)) return 0;
  const candidates: { key: string; raw: string }[] = [];
  try {
    for (let index = 0; index < Math.min(storage.length, MAX_SCANNED_KEYS); index++) {
      const key = storage.key(index);
      if (!key?.startsWith(userPrefix)) continue;
      const parts = key.slice(userPrefix.length).split(':');
      if (parts.length !== 3 || !encodedSegment(parts[0]) || !encodedSegment(parts[1]) || parts[2] !== CANVAS_BASELINE_KEY) continue;
      const raw = storage.getItem(key);
      if (raw && raw.length <= MAX_BASELINE_CHARACTERS) candidates.push({ key, raw });
    }
  } catch { return 0; }
  candidates.sort((a, b) => b.raw.length - a.raw.length);
  let compacted = 0; let processedCharacters = 0;
  for (const { key, raw } of candidates) {
    if (compacted >= MAX_COMPACTED_BASELINES) break;
    if (processedCharacters + raw.length > MAX_COMPACTION_CHARACTERS) continue;
    processedCharacters += raw.length;
    try {
      const legacy: unknown = JSON.parse(raw);
      if (!object(legacy) || !exactKeys(legacy, ['version', 'document']) || !version(legacy.version)
        || typeof legacy.document !== 'string') continue;
      const document: unknown = JSON.parse(legacy.document);
      if (!object(document) || document.version !== 2 || !Array.isArray(document.nodes) || !Array.isArray(document.edges)) continue;
      // Preserve the exact original document string, including unknown fields and formatting.
      // In particular, never pass historical proof data through a lossy sanitizer.
      const encoded = packed(legacy.document);
      if (encoded === null) continue;
      const value: Baseline = { version: legacy.version, encoding: 'gzip', document: encoded, migrated: true };
      const next = JSON.stringify(value);
      if (next.length >= raw.length || storage.getItem(key) !== raw) continue;
      storage.setItem(key, next);
      if (storage.getItem(key) === next) compacted++;
    } catch { /* An optional proof must never make the original durable write less reliable. */ }
  }
  return compacted;
}

export function isCanvasStorageQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === 'QuotaExceededError' || value.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || value.code === 22 || value.code === 1014;
}
