// AwwO's figure kit (原理图解组件): the drawing modules of the anatomy kit (third_party/anatomy, MIT) as one classic
// script, anatomy-kit.js, which defines window.Anatomy. A figure node's page loads it by FIGURE_KIT_URL; a running
// preview inlines this exact file instead (previewLibraries.ts), and the hosted site serves the same bytes at that URL
// for downloaded pages (vite.saas.config.mjs). figure-guide.md is how a figure node's model builds such a page.
import FIGURE_GUIDE from './figure-guide.md?raw';

export { FIGURE_GUIDE };

/** The one external script a figure page may name. Versioned: a kit whose API changes gets a new number. */
export const FIGURE_KIT_URL = 'https://awwo.clawhunt.store/kits/anatomy/1/anatomy.js';
/** Byte size and sha256 of anatomy-kit.js, pinned so a preview only ever inlines the reviewed file. */
export const FIGURE_KIT_BYTES = 113029;
export const FIGURE_KIT_SHA256 = '698f43bd202f7b5c0d9b41c0494abc71c30fb6534db0ec98943368eab3e11554';

/** The guide's first line. Keep it unchanged when the guide is revised: figureRole finds the guide by it, so a persona
 *  that carries an older guide gets the current one instead of two. */
export const GUIDE_HEADING = FIGURE_GUIDE.slice(0, FIGURE_GUIDE.indexOf('\n'));

/** Node setup refuses a persona above 32,000 bytes (backend node_setup.go); keep a margin under it. */
const PERSONA_BYTES = 31_000;
const SEPARATOR = '\n\n';
const encoder = new TextEncoder();

/** The role part of a figure persona: everything before the kit guide. A persona without the guide is returned whole. */
export function figureRole(persona: string): string {
  const at = persona.startsWith(GUIDE_HEADING) ? 0 : persona.indexOf(`\n${GUIDE_HEADING}`);
  return at < 0 ? persona : persona.slice(0, at).trimEnd();
}

/** A figure node's role text with the current kit guide after it, once. The role is cut at a character boundary when
 *  both would not fit the setup limit: the guide is what makes the page work, so it is always kept whole. */
export function figurePersona(role: string): string {
  let kept = figureRole(role).trim();
  const room = PERSONA_BYTES - encoder.encode(SEPARATOR + FIGURE_GUIDE).byteLength;
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
  return kept ? `${kept}${SEPARATOR}${FIGURE_GUIDE}` : FIGURE_GUIDE;
}
