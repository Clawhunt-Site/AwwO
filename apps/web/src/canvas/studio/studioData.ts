// Bytes for the deliverable studio: stored files and generated media read with the session (bounded, never
// following a redirect), archives opened in the browser with limits on what they actually inflate to, and the
// "download everything" archive. Nothing here runs a file; viewers decide how to show the bytes.
import { Unzip, UnzipInflate, zipSync, strToU8 } from 'fflate';
import { sessionFetch } from '../../saas/api';
import { storedArtifactUrl, storedMediaUrl } from '../../saas/canvasBridge';
import { artifactFilename } from '../ArtifactPreview';
import type { StudioEntry } from './studioModel';

const MiB = 1024 * 1024;
export const STUDIO_LIMITS = { file: 64 * MiB, archive: 32 * MiB, member: 16 * MiB, members: 400, inflated: 96 * MiB, inline: 24 * MiB } as const;

export interface LoadedFile { name: string | null; bytes: Uint8Array; contentType: string }

/** The download URL of a stored file or generated media item, for links and the browser's own players. */
export function entryDownloadUrl(entry: StudioEntry): string | null {
  if (entry.source.type === 'stored') return storedArtifactUrl(entry.source.reference);
  if (entry.source.type === 'media') return storedArtifactUrl(`awwo-file:${entry.source.artifactId}`);
  return null;
}

/** The inline URL a same-origin <img>/<video> can play directly (the session cookie goes with it). */
export function entryMediaUrl(entry: StudioEntry): string | null {
  if (entry.source.type === 'media') return storedMediaUrl(entry.source.artifactId);
  return null;
}

/** Read a stored file's bytes, refusing more than `limit` even when the server omits Content-Length. */
export async function fetchEntryBytes(entry: StudioEntry, signal: AbortSignal, limit: number = STUDIO_LIMITS.file): Promise<LoadedFile> {
  if (entry.source.type === 'member') return { name: entry.name, bytes: entry.source.bytes, contentType: '' };
  if (entry.source.type === 'inline') return { name: entry.name, bytes: strToU8(entry.source.text), contentType: 'text/plain' };
  const url = entryDownloadUrl(entry);
  if (!url) throw new Error('studio_unavailable');
  const response = await sessionFetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal, headers: { Accept: 'application/octet-stream' } });
  const expected = new URL(url, window.location.origin).href;
  if (!response.ok || response.redirected || (response.url && response.url !== expected)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 404 ? 'studio_gone' : 'studio_unavailable');
  }
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel().catch(() => undefined); throw new Error('studio_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('studio_unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('studio_too_large');
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { name: artifactFilename(response.headers.get('Content-Disposition') || ''), bytes, contentType: response.headers.get('Content-Type') || '' };
}

/** Archive paths that stay inside the archive: no absolute, parent or empty segments. */
export function safeArchivePath(path: string): boolean {
  return path.length > 0 && path.length <= 300 && !/^[/\\]|[\\:\u0000-\u001f\u007f]/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.' || part === '');
}

/** Every file in a ZIP, inflated as a stream so the limits apply to the bytes that actually come out. */
export async function unzipMembers(bytes: Uint8Array, signal: AbortSignal): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  if (bytes.length > STUDIO_LIMITS.archive) throw new Error('studio_archive_too_large');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('studio_archive_invalid');
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const seen = new Set<string>();
  const active: Array<{ terminate: () => void }> = [];
  let failure: Error | null = null, entries = 0, total = 0, pending = 0;
  const stop = (error: Error) => { failure ??= error; for (const file of active) file.terminate(); };
  const unzip = new Unzip(file => {
    if (failure) return;
    if (file.name.endsWith('/')) return;
    // macOS resource forks and editor litter are not deliverables.
    if (/(?:^|\/)(?:__MACOSX|\.DS_Store$)/.test(file.name)) return;
    const path = file.name;
    if (++entries > STUDIO_LIMITS.members || !safeArchivePath(path) || seen.has(path)) { stop(new Error('studio_archive_paths')); return; }
    seen.add(path);
    if (file.originalSize != null && file.originalSize > STUDIO_LIMITS.member) return;
    const chunks: Uint8Array[] = []; let size = 0; pending++;
    active.push(file);
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { stop(error); return; }
      size += chunk.length; total += chunk.length;
      if (size > STUDIO_LIMITS.member) { pending--; file.terminate(); return; }
      if (total > STUDIO_LIMITS.inflated) { stop(new Error('studio_archive_too_large')); return; }
      chunks.push(chunk);
      if (final) {
        pending--;
        const data = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { data.set(part, offset); offset += part.length; }
        files.push({ path, bytes: data });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const abort = () => stop(new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  try {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      if (failure) throw failure;
      if (Date.now() - started > 15000) throw new Error('studio_archive_timeout');
      unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
      if (offset % (512 * 1024) === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (failure) throw failure;
    if (pending > 0) throw new Error('studio_archive_incomplete');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  } finally { signal.removeEventListener('abort', abort); for (const file of active) file.terminate(); }
}

/** UTF-8 text, or null for bytes that are not (binary files are never shown as text). */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 8192)) ? null : text;
  } catch { return null; }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json', wasm: 'application/wasm',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf', xml: 'application/xml',
};

export function mimeOfName(name: string, fallback = 'application/octet-stream'): string {
  const extension = name.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? fallback;
}

/** A data: URL for bytes, base64 encoded in chunks so a large file does not overflow the call stack. */
export function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Everything in one archive, folders by node, for 「下载全部」. Files that cannot be read are listed in a note. */
export async function buildArchive(entries: ReadonlyArray<StudioEntry>, signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  let done = 0;
  for (const entry of entries) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const folder = [entry.nodeTitle, ...entry.folder].map(part => part.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '-').trim() || '_').join('/');
    const path = `${folder}/${entry.name}`;
    try {
      if (entry.source.type === 'missing') skipped.push(`${path} — ${entry.source.claimed}`);
      else files[path] = (await fetchEntryBytes(entry, signal)).bytes;
    } catch (error) {
      if (signal.aborted) throw error;
      skipped.push(path);
    }
    onProgress?.(++done, entries.length);
  }
  if (skipped.length) files['README-skipped.txt'] = strToU8(`These deliverables could not be included:\n\n${skipped.join('\n')}\n`);
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
}

/** Save bytes under a name, through a short-lived object URL. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.style.display = 'none';
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
}
