import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { PREVIEW_FONT_RULE, PREVIEW_FONTS, PREVIEW_FONTS_KEY } from '../src/canvas/previewFontList';
import { previewFontFaces, previewFontNeeds, previewFontSource } from '../src/canvas/previewFonts';
import { loadPreviewLibraries, previewScriptNeeds, PREVIEW_FONTS_LIBRARY } from '../src/canvas/previewLibraries';
import { buildLiveDocument } from '../src/canvas/studio/liveDocument';

const FONT_DIR = path.resolve(__dirname, '../src/canvas/fonts');
const slug = (family: string) => family.toLowerCase().replace(/ /g, '-');
const names = (texts: string[]) => previewFontNeeds(...texts).map(font => font.family);

describe('brand fonts AwwO supplies to running pages', () => {
  it('pins every vendored face to its file, and nothing else is in the folder', () => {
    const listed = PREVIEW_FONTS.flatMap(font => font.faces.map(face => face.file)).sort();
    expect(readdirSync(FONT_DIR).filter(name => name.endsWith('.woff2')).sort()).toEqual(listed);
    for (const font of PREVIEW_FONTS) for (const face of font.faces) {
      const bytes = readFileSync(path.join(FONT_DIR, face.file));
      expect(bytes.length, face.file).toBe(face.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), face.file).toBe(face.sha256);
      // A woff2 file starts with its signature.
      expect(bytes.subarray(0, 4).toString('latin1'), face.file).toBe('wOF2');
      expect(face.file.startsWith(`${slug(font.family)}-latin-`), face.file).toBe(true);
    }
  });

  it('ships the OFL-1.1 license each family came with', () => {
    for (const font of PREVIEW_FONTS) {
      const license = readFileSync(path.join(FONT_DIR, `${slug(font.family)}.LICENSE.txt`), 'utf8');
      expect(license, font.family).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });

  it('finds a family where a page names a font, in CSS, styles, canvas strings and SVG', () => {
    expect(names(['<style>h1{font-family:\'Orbitron\',sans-serif}</style>'])).toEqual(['Orbitron']);
    expect(names(['body{font: 500 15px/1.4 Inter, system-ui}'])).toEqual(['Inter']);
    expect(names(['ctx.font = `700 ${size}px Rajdhani`;'])).toEqual(['Rajdhani']);
    expect(names(['ctx.font = "600 14px \\"Space Grotesk\\", system-ui";'])).toEqual(['Space Grotesk']);
    expect(names([':root{--display: Bebas Neue;\n--mono:"JetBrains Mono", monospace}'])).toEqual(['Bebas Neue', 'JetBrains Mono']);
    expect(names(['label.style.fontFamily = \'exo 2\';'])).toEqual(['Exo 2']);
    expect(names(['<text font-family="Cinzel" x="0">KEEP</text>'])).toEqual(['Cinzel']);
    expect(names(['h2{font-family:inter;}', 'p{font-family:"Playfair Display" !important}'])).toEqual(['Inter', 'Playfair Display']);
    // A style attribute writes its quotes as entities; a shorthand may size by a variable or a CSS function.
    expect(names(['<h1 style="font-family:&quot;Space Grotesk&quot;,sans-serif">Hello</h1>'])).toEqual(['Space Grotesk']);
    expect(names([':root{--leading:1.2}h1{font:700 2rem/var(--leading) Orbitron,sans-serif}'])).toEqual(['Orbitron']);
    expect(names(['h1{font:800 clamp(2rem, calc(1rem + 4vw), 5rem)/1 Unbounded;}', 'p{font:var(--size) Manrope}'])).toEqual(['Manrope', 'Unbounded']);
  });

  it('does not take prose, other families or longer names for a supplied font', () => {
    expect(names(['<p>Choose an outfit for the Interstate run; growth is unbounded.</p>'])).toEqual([]);
    expect(names(['h1{font-family:"Inter Variable",sans-serif}', 'p{font-family:Montserrat2}', 'x{font-family:MyOrbitron}'])).toEqual([]);
    expect(names(['<h1>Inter</h1>', 'const label = "Fonts"'])).toEqual([]);
  });

  it('loads a face as the pinned bytes and writes one rule per face', async () => {
    const orbitron = PREVIEW_FONTS.find(font => font.family === 'Orbitron')!;
    const url = await previewFontSource(orbitron.faces[0]);
    expect(url.startsWith('data:font/woff2;base64,')).toBe(true);
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(orbitron.faces[0].sha256);
    const rajdhani = PREVIEW_FONTS.find(font => font.family === 'Rajdhani')!;
    const css = await previewFontFaces([orbitron, rajdhani]);
    expect(css.match(/@font-face\{/g)).toHaveLength(1 + rajdhani.faces.length);
    expect(css).toContain('font-family:"Orbitron";src:url(data:font/woff2;base64,');
    expect(css).toContain('font-weight:400 900;font-style:normal;font-display:block');
    expect(css).toContain('font-family:"Rajdhani"');
    expect(css).not.toContain('<');
  });

  it('puts the named fonts into the running preview ahead of the page, and nothing into a page that names none', async () => {
    const page = '<!doctype html><html><head><style>h1{font-family:"Orbitron",sans-serif}</style></head><body><h1>LAP 1/3</h1><script>document.title="ok"</script></body></html>';
    const needs = previewScriptNeeds(page);
    expect(needs.libraries).toContain(PREVIEW_FONTS_LIBRARY);
    expect(needs.fonts?.map(font => font.family)).toEqual(['Orbitron']);
    const code = await loadPreviewLibraries(needs);
    const html = htmlPreviewDocument(page, true, code);
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('@font-face{font-family:"Orbitron"');
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('@font-face'));
    expect(head).toContain('document.fonts');
    expect(html.indexOf('@font-face')).toBeLessThan(html.indexOf('h1{font-family'));
    const plain = '<!doctype html><html><head><style>h1{font-family:system-ui}</style></head><body><h1>Inter</h1></body></html>';
    expect(previewScriptNeeds(plain).fonts).toBeUndefined();
    expect(htmlPreviewDocument(plain, true, await loadPreviewLibraries(previewScriptNeeds(plain)))).not.toContain('@font-face');
    expect(code.get(PREVIEW_FONTS_KEY)).toBeTruthy();
  });

  it('puts them into the live page too, after its policy and before its guard', async () => {
    const page = '<!doctype html><html><head><title>t</title></head><body><canvas></canvas><script>const c=document.querySelector("canvas").getContext("2d");document.fonts.ready.then(()=>{c.font="700 32px Unbounded";c.fillText("GO",0,40)})</script></body></html>';
    const live = await buildLiveDocument(page);
    const doc = new DOMParser().parseFromString(live, 'text/html');
    const children = Array.from(doc.head.children);
    const policy = children.findIndex(element => element.getAttribute('http-equiv') === 'Content-Security-Policy');
    const style = children.findIndex(element => element.localName === 'style' && (element.textContent || '').includes('font-family:"Unbounded"'));
    const guard = children.findIndex(element => element.localName === 'script' && (element.textContent || '').includes('document.fonts'));
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(style).toBeGreaterThan(policy);
    expect(guard).toBeGreaterThan(style);
  });

  it('tells a model the families by name', () => {
    for (const font of PREVIEW_FONTS) expect(PREVIEW_FONT_RULE).toContain(font.family);
    expect(PREVIEW_FONT_RULE).toContain('document.fonts.ready');
  });
});
