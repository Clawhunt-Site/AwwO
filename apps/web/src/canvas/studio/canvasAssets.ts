// Files of the current canvas, read once and shared by every enlarged card: a card that previews a page can show the
// picture another node generated (a page naming `hero.png` gets the canvas file called hero.png). Bounded by count and
// bytes; the oldest reads are dropped first. Scoped to the workspace canvas that was active when a file was read.
import { currentSaaSCanvas } from '../../saas/canvasBridge';
import type { AssetResolver } from './liveDocument';
import { fetchEntryBytes, type LoadedFile } from './studioData';
import type { StudioEntry } from './studioModel';

const MAX_FILES = 48;
const MAX_BYTES = 160 * 1024 * 1024;
const cache = new Map<string, Promise<LoadedFile | null>>();
const sizes = new Map<string, number>();

function cacheKey(entry: StudioEntry): string | null {
  const scope = currentSaaSCanvas();
  const source = entry.source.type === 'stored' ? entry.source.reference : entry.source.type === 'media' ? entry.source.artifactId : null;
  return scope && source ? `${scope.tenant.id}:${scope.canvasId}:${source}` : null;
}

function evict() {
  let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  for (const key of cache.keys()) {
    if (cache.size <= MAX_FILES && total <= MAX_BYTES) break;
    total -= sizes.get(key) ?? 0;
    cache.delete(key); sizes.delete(key);
  }
}

/** A stored file's or generated media item's bytes, from the shared cache. */
export function canvasFileBytes(entry: StudioEntry): Promise<LoadedFile | null> {
  if (entry.source.type === 'inline' || entry.source.type === 'member') return fetchEntryBytes(entry, new AbortController().signal).catch(() => null);
  const key = cacheKey(entry);
  if (!key) return Promise.resolve(null);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  const read = fetchEntryBytes(entry, AbortSignal.timeout(60_000)).then(file => { sizes.set(key, file.bytes.length); evict(); return file; })
    .catch(() => { cache.delete(key); sizes.delete(key); return null; });
  cache.set(key, read);
  evict();
  return read;
}

const basename = (path: string) => path.split('/').pop()!.toLowerCase();

/** Relative URLs of a page resolved by file name against the canvas's other files. */
export function canvasResolver(entries: ReadonlyArray<StudioEntry>, self?: string): AssetResolver {
  return async path => {
    const wanted = basename(path);
    const match = entries.find(entry => entry.id !== self && entry.source.type !== 'inline' && entry.source.type !== 'missing'
      && (basename(entry.name) === wanted || basename(entry.label) === wanted));
    if (!match) return null;
    const file = await canvasFileBytes(match);
    return file ? { bytes: file.bytes, name: file.name || match.name } : null;
  };
}
