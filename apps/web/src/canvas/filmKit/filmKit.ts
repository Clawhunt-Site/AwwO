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
export const FILM_KIT_BYTES = 102326;
export const FILM_KIT_SHA256 = '8e6af5d8ee28ad3a9b1d928e395376608b4224e9774dc4cd112155326620b777';

/** The guide's first line. Keep it unchanged when the guide is revised: filmRole finds the guide by it, so a persona that
 *  carries an older guide gets the current one instead of two. */
export const FILM_GUIDE_HEADING = FILM_GUIDE.slice(0, FILM_GUIDE.indexOf('\n'));

/** Node setup refuses a persona above 32,000 bytes (backend node_setup.go); keep a margin under it. */
const PERSONA_BYTES = 31_000;
const SEPARATOR = '\n\n';
const encoder = new TextEncoder();

/** The role part of a film persona: everything before the kit guide. A persona without the guide is returned whole. */
export function filmRole(persona: string): string {
  const at = persona.startsWith(FILM_GUIDE_HEADING) ? 0 : persona.indexOf(`\n${FILM_GUIDE_HEADING}`);
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
