// Brand fonts AwwO supplies to the pages it renders. AwwO's film kit names each face of its 18 brand families by the
// file Fontsource 5.3.0 publishes on jsDelivr (apps/web/scripts/build-film-kit.mjs BRAND_FONTS, through cinecode's
// roleFaces), so a film rendered here used to fetch its type over the network: a face that failed drew the whole film in
// the system font, and one that came late changed the type mid-film. The worker answers exactly those 27 URLs instead,
// from its own copies in fonts/: the files of the brand fonts AwwO's running previews supply
// (apps/web/src/canvas/fonts, previewFontList.ts), each family's license beside them, as the SIL Open Font License asks
// of every copy. A render therefore draws a film's brand type with no network, and the faces it draws are the ones a
// preview draws.
//
// 23 of the copies are the file at their URL byte for byte: Google Fonts' Latin subsets as the Fontsource packages ship
// them, and its simplified Chinese subset of Noto Sans SC's bold cut, the one face a film's Chinese words have (its
// license reserves the name "Source", which is no part of its name). Orbitron, Playfair Display and Press Start 2P
// reserve their names, which no subset may keep, so AwwO carries the full fonts as Google Fonts releases them, and
// those four URLs are answered with them. Measured in Chrome 157
// (2026-11-08, weights 400, 650 and 900, upright and italic), they draw every character of the subsets' Latin range
// (ASCII, Latin-1, the general punctuation block, € ™ Œ œ ı and the rest) pixel for pixel as the subsets do, but for
// Playfair Display's U+2052 ⁒; and as full fonts they also draw what the subsets lack (‐ † ‡ ‰, and Latin Extended,
// Greek or Cyrillic where the family has them), as a preview does and a downloaded page, which gets the subsets, does
// not.
//
// Each copy is checked against its size and sha256, and its family's license must be beside it, when this module loads:
// a worker with a damaged or unlicensed copy fails to start rather than render with it. kits.test.mjs keeps the list
// equal to the URLs the kit asks for, and the copies equal to the web's files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const font = (family, url, file, license, bytes, sha256) => Object.freeze({ family, url, file, license, bytes, sha256 });

export const FONTS = Object.freeze([
  font('Inter', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-normal.woff2',
    'inter-latin-wght-normal.woff2', 'inter.LICENSE.txt', 48256, '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62'),
  font('Inter', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-italic.woff2',
    'inter-latin-wght-italic.woff2', 'inter.LICENSE.txt', 51832, '7291b5970da2237441273c03b424a504b70b18f09791473fab99687dcc314720'),
  font('Space Grotesk', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/space-grotesk@5.3.0/files/space-grotesk-latin-wght-normal.woff2',
    'space-grotesk-latin-wght-normal.woff2', 'space-grotesk.LICENSE.txt', 22288, '0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d'),
  font('Manrope', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/manrope@5.3.0/files/manrope-latin-wght-normal.woff2',
    'manrope-latin-wght-normal.woff2', 'manrope.LICENSE.txt', 24836, 'a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972'),
  font('Outfit', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/outfit@5.3.0/files/outfit-latin-wght-normal.woff2',
    'outfit-latin-wght-normal.woff2', 'outfit.LICENSE.txt', 32292, '6c18d579fd87c3776be068b762cbc83fde3acb543d49eabd3ade842eb987e887'),
  font('Montserrat', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/montserrat@5.3.0/files/montserrat-latin-wght-normal.woff2',
    'montserrat-latin-wght-normal.woff2', 'montserrat.LICENSE.txt', 37956, '06b16db7a969135d48d38c49183be7fb88d4452e2a3011957c7851941f4e4879'),
  font('Montserrat', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/montserrat@5.3.0/files/montserrat-latin-wght-italic.woff2',
    'montserrat-latin-wght-italic.woff2', 'montserrat.LICENSE.txt', 39632, '0eb22e3d769a66a92dbd82e3aefa5740e5bc21afa4485f62f92b22656d49182a'),
  font('Unbounded', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/unbounded@5.3.0/files/unbounded-latin-wght-normal.woff2',
    'unbounded-latin-wght-normal.woff2', 'unbounded.LICENSE.txt', 50904, '22f9b928aa3928a896340422b54d690fbb5875c30eae4c106f029c61f2289fd6'),
  font('Orbitron', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/orbitron@5.3.0/files/orbitron-latin-wght-normal.woff2',
    'orbitron-wght-normal.woff2', 'orbitron.LICENSE.txt', 16028, '206601dd7476a038ad4038f8c45f07c59bf2189b8733e328b79697a09e846bc0'),
  font('Exo 2', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/exo-2@5.3.0/files/exo-2-latin-wght-normal.woff2',
    'exo-2-latin-wght-normal.woff2', 'exo-2.LICENSE.txt', 40896, '4a259dde317e08aa5d37e6eb684e222ae833516b2a0fccba36ee5e36224f16be'),
  font('Exo 2', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/exo-2@5.3.0/files/exo-2-latin-wght-italic.woff2',
    'exo-2-latin-wght-italic.woff2', 'exo-2.LICENSE.txt', 43048, '26a4dc84a13ae17366fcd188e354530db070234c038370df9ee47f1b0d611a7a'),
  font('Oxanium', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/oxanium@5.3.0/files/oxanium-latin-wght-normal.woff2',
    'oxanium-latin-wght-normal.woff2', 'oxanium.LICENSE.txt', 14044, '3aa555c528430aab19bb2693dc206bab557767d3082dba66400784c9cc90cfbb'),
  font('Rajdhani', 'https://cdn.jsdelivr.net/npm/@fontsource/rajdhani@5.3.0/files/rajdhani-latin-400-normal.woff2',
    'rajdhani-latin-400-normal.woff2', 'rajdhani.LICENSE.txt', 14976, '759a9000e47b028799d7a4ca602634a7ac7adf415775df070a335d18d9b66f38'),
  font('Rajdhani', 'https://cdn.jsdelivr.net/npm/@fontsource/rajdhani@5.3.0/files/rajdhani-latin-500-normal.woff2',
    'rajdhani-latin-500-normal.woff2', 'rajdhani.LICENSE.txt', 15084, '23afdb9b5b89b878fab04d80cc30bf41bb4f3f7e8be88e5f16a7cc7671cdb2dc'),
  font('Rajdhani', 'https://cdn.jsdelivr.net/npm/@fontsource/rajdhani@5.3.0/files/rajdhani-latin-600-normal.woff2',
    'rajdhani-latin-600-normal.woff2', 'rajdhani.LICENSE.txt', 15732, '433a7007e4747a02a790167a6efa2625855f013970ba49b9b739a5d3db8b2601'),
  font('Rajdhani', 'https://cdn.jsdelivr.net/npm/@fontsource/rajdhani@5.3.0/files/rajdhani-latin-700-normal.woff2',
    'rajdhani-latin-700-normal.woff2', 'rajdhani.LICENSE.txt', 15688, '5b7e4a6f97163c2636724d4de90304fc895653dcfe64c67a7a22f26331ca5c5f'),
  font('Bebas Neue', 'https://cdn.jsdelivr.net/npm/@fontsource/bebas-neue@5.3.0/files/bebas-neue-latin-400-normal.woff2',
    'bebas-neue-latin-400-normal.woff2', 'bebas-neue.LICENSE.txt', 13768, 'a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412'),
  font('Playfair Display', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/playfair-display@5.3.0/files/playfair-display-latin-wght-normal.woff2',
    'playfair-display-wght-normal.woff2', 'playfair-display.LICENSE.txt', 106440, '4297e9ec39f1b8157623d048fb99eab03c90e482669599e8fc662ee178994c49'),
  font('Playfair Display', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/playfair-display@5.3.0/files/playfair-display-latin-wght-italic.woff2',
    'playfair-display-wght-italic.woff2', 'playfair-display.LICENSE.txt', 103728, '07dd1cb3a11ed07a7d706e25b64b1a1a46c0ab1bbd53f7e4b5dff9052fc6dd26'),
  font('Instrument Serif', 'https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-normal.woff2',
    'instrument-serif-latin-400-normal.woff2', 'instrument-serif.LICENSE.txt', 21032, '5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31'),
  font('Instrument Serif', 'https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-italic.woff2',
    'instrument-serif-latin-400-italic.woff2', 'instrument-serif.LICENSE.txt', 22128, '5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7'),
  font('Cinzel', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/cinzel@5.3.0/files/cinzel-latin-wght-normal.woff2',
    'cinzel-latin-wght-normal.woff2', 'cinzel.LICENSE.txt', 25904, '09941fb1c169c38fd414536b37690057fc01b3117a5c63dd6571186540c8f370'),
  font('JetBrains Mono', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-normal.woff2',
    'jetbrains-mono-latin-wght-normal.woff2', 'jetbrains-mono.LICENSE.txt', 40404, '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'),
  font('JetBrains Mono', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-italic.woff2',
    'jetbrains-mono-latin-wght-italic.woff2', 'jetbrains-mono.LICENSE.txt', 42964, 'a8afa085e9ca5e53434e2ee918ba6b65c7dd4dda56509976b36591478c99d62e'),
  font('Press Start 2P', 'https://cdn.jsdelivr.net/npm/@fontsource/press-start-2p@5.3.0/files/press-start-2p-latin-400-normal.woff2',
    'press-start-2p-400-normal.woff2', 'press-start-2p.LICENSE.txt', 29920, 'ec0a835d8047efb59e51434c40cce52997d5dd235a0968f611b286c5f6fce743'),
  font('Pixelify Sans', 'https://cdn.jsdelivr.net/npm/@fontsource-variable/pixelify-sans@5.3.0/files/pixelify-sans-latin-wght-normal.woff2',
    'pixelify-sans-latin-wght-normal.woff2', 'pixelify-sans.LICENSE.txt', 12016, '4a5633a0c9c1b73abd133a56d3716c2d8df2ed03cb987346f72194aeb224f382'),
  font('Noto Sans SC', 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.0/files/noto-sans-sc-chinese-simplified-700-normal.woff2',
    'noto-sans-sc-chinese-simplified-700-normal.woff2', 'noto-sans-sc.LICENSE.txt', 1172244, 'e1df51edc00bce27b58044e829fb8ec6accc8a5daece475413de90d52818845c'),
]);

const BODIES = new Map(FONTS.map((entry) => {
  const at = (name) => new URL(`./fonts/${name}`, import.meta.url);
  const body = readFileSync(at(entry.file));
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (body.length !== entry.bytes || sha256 !== entry.sha256) {
    throw new Error(`render worker: fonts/${entry.file} is ${body.length} bytes with sha256 ${sha256}, not the pinned ${entry.bytes} / ${entry.sha256}`);
  }
  // The license travels with the font: a copy without it is not one the worker may hand out.
  if (!/SIL OPEN FONT LICENSE/i.test(readFileSync(at(entry.license), 'utf8'))) {
    throw new Error(`render worker: fonts/${entry.license}, the license of ${entry.family}, is not the SIL Open Font License`);
  }
  return [entry.url, body];
}));

/** The bytes AwwO supplies for this exact font URL (a query or fragment names nothing), else null. */
export function suppliedFont(url) {
  return BODIES.get(String(url)) ?? null;
}
