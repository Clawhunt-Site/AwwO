// Pure helpers backing the chat image right-click menu (Copy image / Reveal in
// Finder). Kept DOM-free so they are unit-testable without a browser: the actual
// clipboard write and canvas re-encode (which need `document`/`navigator`) stay in
// App.tsx and call into these.

export type ImageDataUrlParts = { mime: string; base64: string };

// Parse a base64 `data:` URL into its MIME type and payload. Returns null for
// anything we can't turn into bytes on the surface — non-data URLs (e.g. remote
// http(s) images, which the app renders as click-to-open links, never inline) and
// non-base64 data URLs. Callers treat null as "not copyable / not revealable".
export function parseImageDataUrl(src: string): ImageDataUrlParts | null {
  if (typeof src !== 'string') return null;
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src.trim());
  if (!match) return null;
  const isBase64 = Boolean(match[2]);
  if (!isBase64) return null;
  const base64 = match[3] ?? '';
  if (!base64) return null;
  const mime = (match[1] || '').trim() || 'application/octet-stream';
  return { mime, base64 };
}

// Convert a base64 `data:` URL into a Blob. Returns null when the source isn't a
// decodable base64 data URL. `atobFn` is injectable so tests can run without a DOM
// `atob`; App.tsx passes the browser's `atob`.
export function dataUrlToBlob(
  src: string,
  atobFn: (input: string) => string = (input) => atob(input),
): Blob | null {
  const parts = parseImageDataUrl(src);
  if (!parts) return null;
  let binary: string;
  try {
    binary = atobFn(parts.base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: parts.mime });
}

// MIME types the desktop shell's `desktop_reveal_image` command will materialize.
// MUST mirror the Rust allowlist (image_ext_for_mime): the surface hides "Reveal in
// Finder" for anything the kernel would reject, so the menu never offers an action
// that fails on click (fail-closed at the surface). A native binary can't import
// this list, so the duplication is deliberate defense-in-depth, not drift.
export const REVEALABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// Whether the "Reveal in Finder" item should appear for an image. It is a
// desktop-only affordance and needs a real file to select: either a local_path
// attachment already on disk (revealed directly, any type), or a base64 data URL
// whose MIME is on the shell's allowlist (materialized then revealed). A pure
// http(s) URL — or an off-allowlist data URL like AVIF/SVG — can't be revealed, so
// the item is hidden rather than shown-then-failing.
export function canRevealImage(opts: { desktopMode: boolean; path: string | null; src: string }): boolean {
  if (!opts.desktopMode) return false;
  if (opts.path && opts.path.trim()) return true;
  const parts = parseImageDataUrl(opts.src);
  return parts !== null && REVEALABLE_IMAGE_MIMES.has(parts.mime);
}
