/**
 * The brand fonts AwwO supplies to a running preview of a delivered page (previewFonts.ts loads them): the Latin subsets
 * of OFL-1.1 families from the Fontsource 5.3.0 packages, vendored byte for byte in fonts/ with each family's license
 * beside its files. Plain data with no loader, so the case canvases (officialWorkflows.ts) and the publish script can
 * name the families without bundling the files. tests/canvas-preview-fonts.test.ts pins every file's size and sha256.
 */
export interface PreviewFontFace {
  /** File name in fonts/. */
  readonly file: string;
  /** The CSS font-weight it covers: one weight, or a variable font's range ("100 900"). */
  readonly weight: string;
  readonly style: 'normal' | 'italic';
  readonly bytes: number;
  readonly sha256: string;
}

export interface PreviewFont {
  /** The family name a page writes, as Google Fonts names it. */
  readonly family: string;
  /** What it suits, in the words the page rule gives a model. */
  readonly use: 'sans' | 'display' | 'serif' | 'mono' | 'pixel';
  readonly faces: readonly PreviewFontFace[];
}

const face = (file: string, weight: string, bytes: number, sha256: string, style: 'normal' | 'italic' = 'normal'): PreviewFontFace =>
  ({ file, weight, style, bytes, sha256 });

export const PREVIEW_FONTS: readonly PreviewFont[] = [
  { family: 'Inter', use: 'sans', faces: [
    face('inter-latin-wght-normal.woff2', '100 900', 48256, '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62'),
    face('inter-latin-wght-italic.woff2', '100 900', 51832, '7291b5970da2237441273c03b424a504b70b18f09791473fab99687dcc314720', 'italic')] },
  { family: 'Space Grotesk', use: 'sans', faces: [
    face('space-grotesk-latin-wght-normal.woff2', '300 700', 22288, '0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d')] },
  { family: 'Manrope', use: 'sans', faces: [
    face('manrope-latin-wght-normal.woff2', '200 800', 24836, 'a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972')] },
  { family: 'Outfit', use: 'sans', faces: [
    face('outfit-latin-wght-normal.woff2', '100 900', 32292, '6c18d579fd87c3776be068b762cbc83fde3acb543d49eabd3ade842eb987e887')] },
  { family: 'Montserrat', use: 'sans', faces: [
    face('montserrat-latin-wght-normal.woff2', '100 900', 37956, '06b16db7a969135d48d38c49183be7fb88d4452e2a3011957c7851941f4e4879'),
    face('montserrat-latin-wght-italic.woff2', '100 900', 39632, '0eb22e3d769a66a92dbd82e3aefa5740e5bc21afa4485f62f92b22656d49182a', 'italic')] },
  { family: 'Unbounded', use: 'display', faces: [
    face('unbounded-latin-wght-normal.woff2', '200 900', 50904, '22f9b928aa3928a896340422b54d690fbb5875c30eae4c106f029c61f2289fd6')] },
  { family: 'Orbitron', use: 'display', faces: [
    face('orbitron-latin-wght-normal.woff2', '400 900', 11800, 'c25a9f9da5d9f3db1bf2a01474722dc9b377675b7bbab6d0dfda6902794fd1ed')] },
  { family: 'Exo 2', use: 'display', faces: [
    face('exo-2-latin-wght-normal.woff2', '100 900', 40896, '4a259dde317e08aa5d37e6eb684e222ae833516b2a0fccba36ee5e36224f16be'),
    face('exo-2-latin-wght-italic.woff2', '100 900', 43048, '26a4dc84a13ae17366fcd188e354530db070234c038370df9ee47f1b0d611a7a', 'italic')] },
  { family: 'Oxanium', use: 'display', faces: [
    face('oxanium-latin-wght-normal.woff2', '200 800', 14044, '3aa555c528430aab19bb2693dc206bab557767d3082dba66400784c9cc90cfbb')] },
  { family: 'Rajdhani', use: 'display', faces: [
    face('rajdhani-latin-400-normal.woff2', '400', 14976, '759a9000e47b028799d7a4ca602634a7ac7adf415775df070a335d18d9b66f38'),
    face('rajdhani-latin-500-normal.woff2', '500', 15084, '23afdb9b5b89b878fab04d80cc30bf41bb4f3f7e8be88e5f16a7cc7671cdb2dc'),
    face('rajdhani-latin-600-normal.woff2', '600', 15732, '433a7007e4747a02a790167a6efa2625855f013970ba49b9b739a5d3db8b2601'),
    face('rajdhani-latin-700-normal.woff2', '700', 15688, '5b7e4a6f97163c2636724d4de90304fc895653dcfe64c67a7a22f26331ca5c5f')] },
  { family: 'Bebas Neue', use: 'display', faces: [
    face('bebas-neue-latin-400-normal.woff2', '400', 13768, 'a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412')] },
  { family: 'Playfair Display', use: 'serif', faces: [
    face('playfair-display-latin-wght-normal.woff2', '400 900', 38404, 'e0c764a8e9e1cce92163c55bac4b2ad6cd4cf8c696ce2289ab5c41565e65b7e2'),
    face('playfair-display-latin-wght-italic.woff2', '400 900', 38804, '54af24bd0f911f0fd7399d5445ea2023ff501d6a69f2d728f1213072f977ab14', 'italic')] },
  { family: 'Instrument Serif', use: 'serif', faces: [
    face('instrument-serif-latin-400-normal.woff2', '400', 21032, '5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31'),
    face('instrument-serif-latin-400-italic.woff2', '400', 22128, '5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7', 'italic')] },
  { family: 'Cinzel', use: 'serif', faces: [
    face('cinzel-latin-wght-normal.woff2', '400 900', 25904, '09941fb1c169c38fd414536b37690057fc01b3117a5c63dd6571186540c8f370')] },
  { family: 'JetBrains Mono', use: 'mono', faces: [
    face('jetbrains-mono-latin-wght-normal.woff2', '100 800', 40404, '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'),
    face('jetbrains-mono-latin-wght-italic.woff2', '100 800', 42964, 'a8afa085e9ca5e53434e2ee918ba6b65c7dd4dda56509976b36591478c99d62e', 'italic')] },
  { family: 'Press Start 2P', use: 'pixel', faces: [
    face('press-start-2p-latin-400-normal.woff2', '400', 12512, 'afec86997fdaf54af1f59358fa2c1e2a0f1d04146edad18e5cd141d0384a7548')] },
  { family: 'Pixelify Sans', use: 'pixel', faces: [
    face('pixelify-sans-latin-wght-normal.woff2', '400 700', 12016, '4a5633a0c9c1b73abd133a56d3716c2d8df2ed03cb987346f72194aeb224f382')] },
];

const families = (use: PreviewFont['use']) => PREVIEW_FONTS.filter(font => font.use === use).map(font => font.family).join(', ');

/** Where loadPreviewLibraries hands the fonts' @font-face rules to the document builders. */
export const PREVIEW_FONTS_KEY = 'awwo:fonts';

/** Run in a page that has the supplied faces: start loading every one at once, so text a script draws into a canvas
 * soon after the page starts already has its font. */
export const PREVIEW_FONT_LOAD_SCRIPT = ';(()=>{try{document.fonts&&document.fonts.forEach(f=>{f.load().catch(()=>{})})}catch(e){}})();';

/** The fonts' rules as the content of a <style> element: a rule never contains '<' (the sources are base64), but a
 * value that did could close the element, so it is escaped as CSS. */
export function fontStyleText(css: string): string {
  return css.replace(/</g, '\\3c ');
}

/**
 * What a page rule tells a model about the fonts (officialWorkflows.ts, for a case canvas that opts in): the families by
 * what they suit, used by name with a generic fallback, never linked, and canvas text drawn once they are ready.
 */
export const PREVIEW_FONT_RULE = `Fonts: AwwO supplies these brand fonts with no network, the same in every country — sans ${families('sans')}; display ${families('display')}; serif ${families('serif')}; mono ${families('mono')}; pixel ${families('pixel')}. Use one display family for titles and numbers and one sans or mono family for text, by name in font-family (a CSS rule, a custom property or a style) and in canvas font strings, each followed by a generic fallback (system-ui, sans-serif or monospace); never link or @import a font. Text drawn into a canvas or a texture is drawn after document.fonts.ready resolves.`;
