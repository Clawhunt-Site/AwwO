import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { PREVIEW_FONT_RULE, PREVIEW_FONTS, PREVIEW_FONTS_KEY, type PreviewFont } from '../src/canvas/previewFontList';
import { previewFontFaces, previewFontNeeds, previewFontSource } from '../src/canvas/previewFonts';
import { FILM_FONT_DEADLINE_MS, FONT_DEADLINE_MS, loadPreviewLibraries, previewScriptNeeds, PREVIEW_FONTS_LIBRARY, suppliedFontRules } from '../src/canvas/previewLibraries';
import { buildLiveDocument } from '../src/canvas/studio/liveDocument';
import { copyrightNotice, fontOwnNames, glyphCount, reservedNames } from './woff2-font';

const FONT_DIR = path.resolve(__dirname, '../src/canvas/fonts');
const slug = (family: string) => family.toLowerCase().replace(/ /g, '-');
const names = (texts: string[]) => previewFontNeeds(...texts).map(font => font.family);
// The whole fonts of the families that reserve their names, by glyph count: those of google/fonts at bf7c667a, which
// these files are converted from (a subset of one has fewer glyphs).
const WHOLE_FONT_GLYPHS: Record<string, number> = {
  'orbitron-wght-normal.woff2': 269,
  'playfair-display-wght-italic.woff2': 1101,
  'playfair-display-wght-normal.woff2': 1103,
  'press-start-2p-400-normal.woff2': 658,
};

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
      expect(face.file.startsWith(`${slug(font.family)}-`), face.file).toBe(true);
    }
  });

  it('ships the OFL-1.1 license each family came with', () => {
    for (const font of PREVIEW_FONTS) {
      const license = readFileSync(path.join(FONT_DIR, `${slug(font.family)}.LICENSE.txt`), 'utf8');
      expect(license, font.family).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });

  it('ships the full font of a family that reserves its name, which no subset may keep', () => {
    // A name a family's license reserves that its own name uses: a subset of it may not keep that name. Noto Sans SC's
    // reserves "Source" (it comes from Source Han Sans), which "Noto Sans SC" does not use, so Google Fonts' subsets of it
    // are no Modified Version under a Reserved Font Name.
    const ownReserved = (family: string, names: string[]) => names.filter(name => family.toLowerCase().includes(name.toLowerCase()));
    const reservingFaces: string[] = [];
    for (const font of PREVIEW_FONTS) {
      const license = readFileSync(path.join(FONT_DIR, `${slug(font.family)}.LICENSE.txt`), 'utf8');
      const header = license.slice(0, license.indexOf('This Font Software is licensed'));
      for (const face of font.faces) {
        const bytes = readFileSync(path.join(FONT_DIR, face.file)), notice = copyrightNotice(bytes);
        expect(notice, face.file).toMatch(/^(?:Copyright|\(c\)) /);
        // The license beside it reserves every name the font's own notice does.
        expect(reservedNames(header), face.file).toEqual(expect.arrayContaining(reservedNames(notice)));
        // A subset is a Modified Version, which may not use a Reserved Font Name (OFL-FAQ 2.6): such a family ships
        // its whole font, converted to WOFF2 with nothing else changed (OFL-FAQ 2.2.1), with all of its glyphs.
        const reserved = [...reservedNames(notice), ...reservedNames(header)];
        if (!ownReserved(font.family, reserved).length) {
          // A subset: no name the font calls itself by takes a reserved name either (Noto Sans SC's call it Noto Sans SC).
          for (const own of fontOwnNames(bytes)) expect(ownReserved(own, reserved), `${face.file}: ${own}`).toEqual([]);
          continue;
        }
        reservingFaces.push(face.file);
        expect(face.file, face.file).not.toMatch(/-latin-/);
        expect(glyphCount(bytes), face.file).toBe(WHOLE_FONT_GLYPHS[face.file]);
      }
    }
    expect(reservingFaces.sort()).toEqual(Object.keys(WHOLE_FONT_GLYPHS).sort());
    const reserving = PREVIEW_FONTS.filter(font => font.faces.some(face => ownReserved(font.family, reservedNames(copyrightNotice(readFileSync(path.join(FONT_DIR, face.file))))).length));
    expect(reserving.map(font => font.family)).toEqual(['Orbitron', 'Playfair Display', 'Press Start 2P']);
    const noto = PREVIEW_FONTS.find(font => font.family === 'Noto Sans SC')!;
    const notoBytes = readFileSync(path.join(FONT_DIR, noto.faces[0].file));
    expect(reservedNames(copyrightNotice(notoBytes))).toEqual(['Source']);
    expect(fontOwnNames(notoBytes)).toEqual(['Noto Sans SC Thin', 'Noto Sans SC Thin Bold', 'NotoSansSCThin-Bold']);
  });

  it('reads the names a copyright notice reserves, however it quotes them', () => {
    expect(reservedNames('Copyright 2018 The Orbitron Project Authors, with Reserved Font Name: "Orbitron".')).toEqual(['Orbitron']);
    expect(reservedNames('Copyright 2017 X, with Reserved Font Name "Playfair Display". B.ttf: Copyright 2017 X, with Reserved Font Name "Playfair Display".'))
      .toEqual(['Playfair Display', 'Playfair Display']);
    expect(reservedNames("Copyright 2010 Adobe, with Reserved Font Name 'Source'.")).toEqual(['Source']);
    expect(reservedNames('Copyright 2022 GitHub, with Reserved Font Name “Mona Sans”')).toEqual(['Mona Sans']);
    expect(reservedNames('Copyright 2014 A, with Reserved Font Name Lato.')).toEqual(['Lato']);
    expect(reservedNames('Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)')).toEqual([]);
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

  it('tells a model the families by name, but the film kit\'s Chinese face, which only a film page gets', () => {
    for (const font of PREVIEW_FONTS.filter(entry => !entry.film)) expect(PREVIEW_FONT_RULE).toContain(font.family);
    expect(PREVIEW_FONTS.filter(entry => entry.film).map(entry => entry.family)).toEqual(['Noto Sans SC']);
    expect(PREVIEW_FONT_RULE).not.toContain('Noto Sans SC');
    expect(PREVIEW_FONT_RULE).toContain('document.fonts.ready');
  });

  it('waits for each family on its own, and longer for the film kit\'s Chinese face, keeping the ones that came', async () => {
    const family = (name: string) => PREVIEW_FONTS.find(font => font.family === name)!;
    const inter = family('Inter'), orbitron = family('Orbitron'), noto = family('Noto Sans SC');
    // One family's rules, after `delays[family]` ms (null: never).
    const faces = (delays: Record<string, number | null>) => (fonts: readonly PreviewFont[]) => {
      const delay = delays[fonts[0].family];
      return delay === null ? new Promise<string>(() => {}) : new Promise<string>(resolve => setTimeout(() => resolve(`rule:${fonts[0].family}`), delay));
    };
    vi.useFakeTimers();
    try {
      // A Chinese face slower than a Latin family may be costs Inter nothing, and is waited for.
      const slow = suppliedFontRules([inter, noto], faces({ Inter: 10, 'Noto Sans SC': FONT_DEADLINE_MS + 10_000 }));
      await vi.advanceTimersByTimeAsync(FONT_DEADLINE_MS + 10_000);
      expect(await slow).toBe('rule:Inter\nrule:Noto Sans SC');
      // One that never comes is left out once its wait is over, and Inter is kept.
      const never = suppliedFontRules([inter, noto], faces({ Inter: 10, 'Noto Sans SC': null }));
      await vi.advanceTimersByTimeAsync(FILM_FONT_DEADLINE_MS);
      expect(await never).toBe('rule:Inter');
      // A Latin family gets the shorter wait, and its stall costs another family nothing either.
      const latin = suppliedFontRules([inter, orbitron], faces({ Inter: null, Orbitron: FONT_DEADLINE_MS + 10_000 }));
      await vi.advanceTimersByTimeAsync(FONT_DEADLINE_MS);
      expect(await latin).toBeUndefined();
      const stuck = suppliedFontRules([inter, orbitron], faces({ Inter: null, Orbitron: 10 }));
      await vi.advanceTimersByTimeAsync(FONT_DEADLINE_MS);
      expect(await stuck).toBe('rule:Orbitron');
      // A family whose chunk fails is left out.
      const failed = suppliedFontRules([inter, orbitron], fonts => fonts[0] === inter ? Promise.reject(new Error('chunk')) : Promise.resolve('rule:Orbitron'));
      expect(await failed).toBe('rule:Orbitron');
    } finally {
      vi.useRealTimers();
    }
    expect(FILM_FONT_DEADLINE_MS).toBeGreaterThan(FONT_DEADLINE_MS);
  });

  it('supplies the film kit\'s Chinese face only to a page that loads the film kit', async () => {
    const kit = '<script src="https://awwo.clawhunt.store/kits/film/1/film.js"></script>';
    const film = `<!doctype html><html><body>${kit}<script>Film.run({ type: { lang: 'zh', roles: { display: 'Noto Sans SC', text: 'Inter' } } });</script></body></html>`;
    expect(previewScriptNeeds(film).fonts?.map(font => font.family)).toEqual(['Inter', 'Noto Sans SC']);
    // Its one cut is bold: a page of its own that names the family gets nothing for it (and its other fonts still).
    const page = '<!doctype html><html><head><style>body{font-family:"Noto Sans SC",sans-serif}h1{font-family:Inter}</style></head><body><h1>你好</h1></body></html>';
    expect(previewScriptNeeds(page).fonts?.map(font => font.family)).toEqual(['Inter']);
    expect(previewScriptNeeds(page.replace('h1{font-family:Inter}', '')).fonts).toBeUndefined();
    expect(previewScriptNeeds(page.replace('h1{font-family:Inter}', '')).libraries).not.toContain(PREVIEW_FONTS_LIBRARY);
    // The film page's preview has the face as its pinned bytes, at its one weight.
    const code = await loadPreviewLibraries(previewScriptNeeds(film));
    const css = code.get(PREVIEW_FONTS_KEY) ?? '';
    const noto = PREVIEW_FONTS.find(font => font.family === 'Noto Sans SC')!;
    expect(css).toContain(`@font-face{font-family:"Noto Sans SC";src:url(data:font/woff2;base64,${readFileSync(path.join(FONT_DIR, noto.faces[0].file)).toString('base64')}) format("woff2");font-weight:700;font-style:normal;font-display:block}`);
  });
});
