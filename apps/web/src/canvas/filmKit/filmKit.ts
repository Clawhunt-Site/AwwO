// AwwO's film kit (代码影片组件): the frame engine of cinecode's one-file film (third_party/cinecode, MIT) as one classic
// script, film-kit.js, which defines window.Film. A film node's page loads it by FILM_KIT_URL and describes its film with
// Film.run({...}); a running preview inlines this exact file instead (previewLibraries.ts), the render worker answers the
// URL with its own pinned copy (apps/render-worker/kits), and the hosted site serves the same bytes at that URL for
// downloaded pages (vite.saas.config.mjs). film-guide.md is how a film node's model builds such a page.
import FILM_GUIDE from './film-guide.md?raw';

export { FILM_GUIDE };

/** The one external script a film page may name. Versioned: a kit whose API changes gets a new number. */
export const FILM_KIT_URL = 'https://awwo.clawhunt.store/kits/film/1/film.js';
/** Byte size and sha256 of film-kit.js, pinned so a preview only ever inlines the reviewed file. */
export const FILM_KIT_BYTES = 110669;
export const FILM_KIT_SHA256 = '351b6d10d60b723c6e75b0182728e3c893391cd61dc191c48dae49b42d45c2e8';

/** The guide's first line. filmRole finds the guide by it, so a persona that carries an older guide gets the current one
 *  instead of two. When it changes, the line it replaces goes in FILM_GUIDE_OLD_HEADINGS: the personas of the film
 *  nodes made before keep their guide's first line. */
export const FILM_GUIDE_HEADING = FILM_GUIDE.slice(0, FILM_GUIDE.indexOf('\n'));
/** The guide's earlier first lines. Until 2026-11-09 it opened in Chinese inside English personas, which a homepage
 *  case's briefs show as they are (the owner's rule since 2026-10-14: those are English only). */
export const FILM_GUIDE_OLD_HEADINGS: readonly string[] = ['## 代码影片组件 · how to build the film page'];
const FILM_GUIDE_HEADINGS = [FILM_GUIDE_HEADING, ...FILM_GUIDE_OLD_HEADINGS];

/** Node setup refuses a persona above 32,000 bytes (backend node_setup.go); keep a margin under it. */
const PERSONA_BYTES = 31_000;
const SEPARATOR = '\n\n';
const encoder = new TextEncoder();

/** The role part of a film persona: everything before the kit guide, the current one or an earlier one. A persona
 *  without a guide is returned whole. */
export function filmRole(persona: string): string {
  let at = -1;
  for (const heading of FILM_GUIDE_HEADINGS) {
    const found = persona.startsWith(heading) ? 0 : persona.indexOf(`\n${heading}`);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at < 0 ? persona : persona.slice(0, at).trimEnd();
}

/** A film node's role text with the current kit guide after it, once. The role is cut at a character boundary when both
 *  would not fit the setup limit: the guide is what makes the page work, so it is always kept whole. */
export function filmPersona(role: string): string {
  let kept = filmRole(role).trim();
  const room = PERSONA_BYTES - encoder.encode(SEPARATOR + FILM_GUIDE).byteLength;
  if (encoder.encode(kept).byteLength > room) {
    let bytes = 0;
    let end = 0;
    for (const char of kept) {
      const size = encoder.encode(char).byteLength;
      if (bytes + size > room) break;
      bytes += size;
      end += char.length;
    }
    kept = kept.slice(0, end).trimEnd();
  }
  return kept ? `${kept}${SEPARATOR}${FILM_GUIDE}` : FILM_GUIDE;
}
