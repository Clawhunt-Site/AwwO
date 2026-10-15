/**
 * Brand fonts for a RUNNING preview of a delivered page (the families in previewFontList.ts). A page that names one of
 * them gets AwwO's pinned copy as an @font-face with a data: source, ahead of its own styles: no request is made, so the
 * text looks the same in mainland China, where a page's Google Fonts link never loads, and in a sandbox that reaches no
 * network at all. A page that names none gets nothing, and nothing in a page changes but the added style.
 */
import { PREVIEW_FONTS, type PreviewFont, type PreviewFontFace } from './previewFontList';

export { fontStyleText, PREVIEW_FONT_LOAD_SCRIPT, PREVIEW_FONT_RULE, PREVIEW_FONTS, PREVIEW_FONTS_KEY, type PreviewFont, type PreviewFontFace } from './previewFontList';

// A family counts where a font is named: right after a quote, a comma or a colon (a CSS declaration or custom property,
// a style attribute or object, an SVG attribute) or after a size (a CSS or canvas font shorthand: '700 28px Orbitron',
// '14px/1.4 Inter', '2rem/var(--leading) Orbitron', 'clamp(2rem,5vw,4rem) Orbitron'), and right before a quote (escaped
// or not), a comma, a semicolon, a brace, a bracket, !important or a line's end. A quote may be written as an HTML
// entity, as in a style attribute (font-family:&quot;Space Grotesk&quot;). Prose that only contains the word ("an
// outfit", "Interstate") names no font.
const CALL = String.raw`(?:var|calc|clamp|min|max)\((?:[^()]|\([^()]*\))*\)`;
const SIZE = String.raw`(?:px|pt|em|rem|%|vw|vh|vmin|vmax|ch|${CALL})`;
const LINE_HEIGHT = String.raw`(?:\s*\/\s*(?:[\d.]+[a-z%]*|${CALL}|normal))?`;
const BEFORE = String.raw`(?:['"\x60,:]|${SIZE}${LINE_HEIGHT}\s)\s*`;
const AFTER = String.raw`(?=\s*(?:['"\x60,;})\]!\\]|$))`;
const PATTERNS = new Map(PREVIEW_FONTS.map(font => [font,
  new RegExp(BEFORE + font.family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, String.raw`\s+`) + AFTER, 'im')]));
const decodeQuotes = (text: string) => text.replace(/&(?:quot|#0*34|#x0*22);/gi, '"').replace(/&(?:apos|#0*39|#x0*27);/gi, "'");

/** The supplied families the given page texts name (its document, and any canvas files inlined into it), in list order. */
export function previewFontNeeds(...texts: readonly string[]): PreviewFont[] {
  const decoded = texts.map(decodeQuotes);
  return PREVIEW_FONTS.filter(font => decoded.some(text => PATTERNS.get(font)!.test(text)));
}

// Each face's file, as a data: URL in its own chunk, fetched only when a page uses that family.
const FILES = import.meta.glob<string>('./fonts/*.woff2', { query: '?inline', import: 'default' });
const loaded = new Map<string, Promise<string>>();

/** A face's file as a data: URL, checked against its pinned size (tests check the sha256). */
export function previewFontSource(entry: PreviewFontFace): Promise<string> {
  let pending = loaded.get(entry.file);
  if (!pending) {
    const load = Object.prototype.hasOwnProperty.call(FILES, `./fonts/${entry.file}`) ? FILES[`./fonts/${entry.file}`] : undefined;
    if (!load) return Promise.reject(new Error('preview_font_unknown'));
    pending = load().then(url => {
      const comma = url.indexOf(',');
      const data = comma > 0 && /^data:[a-z0-9.+/-]*;base64$/i.test(url.slice(0, comma)) ? url.slice(comma + 1) : '';
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || (data.length / 4) * 3 - padding !== entry.bytes) throw new Error('preview_font_invalid');
      return `data:font/woff2;base64,${data}`;
    });
    loaded.set(entry.file, pending);
    pending.catch(() => { if (loaded.get(entry.file) === pending) loaded.delete(entry.file); });
  }
  return pending;
}

/** The @font-face rules of these families, every face of each (a variable font is one face per style). */
export async function previewFontFaces(fonts: readonly PreviewFont[]): Promise<string> {
  const rules = await Promise.all(fonts.flatMap(font => font.faces.map(async entry =>
    `@font-face{font-family:"${font.family}";src:url(${await previewFontSource(entry)}) format("woff2");font-weight:${entry.weight};font-style:${entry.style};font-display:block}`)));
  return rules.join('\n');
}
