// @vitest-environment node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { familyFonts, folderFiles, fontFolder, fontsInModules, inlinedFontLicences, licenceAssets, licenceBanner, unlicensedFonts } from '../scripts/font-licences.mjs';
import { PREVIEW_FONTS } from '../src/canvas/previewFontList';
import { glyphCount } from './woff2-font';

const WEB = path.resolve(__dirname, '..');
const FONTS = path.join(WEB, 'src', 'saas', 'design', 'fonts');
const LICENCE = 'LICENSE-mona-sans.txt';
// GitHub's own build of Mona Sans, the one Google Fonts serves: googlefonts/variable/MonaSans[wdth,wght].ttf at
// github/mona-sans 0d07d5a501a2d8d4ea456fab73aad6b9fda2060a, the commit google/fonts' METADATA.pb names (version 2.000,
// 349,140 bytes, sha256 fd6e79634b5ae804…), compressed with `fonttools ttLib.woff2 compress` (fontTools 4.57.0, brotli
// 1.2.0). fontTools decompresses it to every table of that file byte for byte, but the head flag bit WOFF2 sets and the
// checksum: its glyf transform is part of WOFF2 compression. The license is that commit's OFL.txt, the one GitHub ships
// with its fonts. A font file the copyright holder made, changed by nothing but WOFF2 compression, may keep the name the
// license reserves (OFL-FAQ 2.2); a subset or an edit may not.
const PINNED: Record<string, { bytes: number; sha256: string }> = {
  [LICENCE]: { bytes: 4419, sha256: '9261dcb61fb5e3c587d50d7a9fdae12bc7422d8822d7ac06b8f34550479575de' },
  'mona-sans-wdth-wght.woff2': { bytes: 170948, sha256: 'ca36dc0a5856f0448f887e706b503bfa56bbf73da9c54f93ab6449ec78faca6d' },
};
// That file's 756 glyphs: a subset, which may not keep the name, has fewer.
const GLYPHS = 756;
// The ranges of Google Fonts' latin and latin-ext subsets, which the two files it replaced covered.
const RANGES = ['U+0000-00FF', 'U+0131', 'U+0152-0153', 'U+02BB-02BC', 'U+02C6', 'U+02DA', 'U+02DC', 'U+0304', 'U+0308', 'U+0329', 'U+2000-206F',
  'U+20AC', 'U+2122', 'U+2191', 'U+2193', 'U+2212', 'U+2215', 'U+FEFF', 'U+FFFD', 'U+0100-02BA', 'U+02BD-02C5', 'U+02C7-02CC', 'U+02CE-02D7',
  'U+02DD-02FF', 'U+1E00-1E9F', 'U+1EF2-1EFF', 'U+2020', 'U+20A0-20AB', 'U+20AD-20C0', 'U+2113', 'U+2C60-2C7F', 'U+A720-A7FF'];
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array; code?: string };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? file.code ?? '');
const outputFiles = (result: unknown) => (Array.isArray(result) ? result : [result]).flatMap(output => (output as { output: OutputFile[] }).output);

const PREVIEW = path.join(WEB, 'src', 'canvas', 'fonts');
const slug = (family: string) => family.toLowerCase().replace(/ /g, '-');
// Each face's license file, as vite.saas.config.mjs gives the plugin: its family's.
const PREVIEW_PAIRS = new Map(PREVIEW_FONTS.flatMap(font => font.faces.map(face => [face.file, `${slug(font.family)}.LICENSE.txt`] as const)));
// Each preview font family's license in src/canvas/fonts/, unchanged, from where its fonts come from
// (tests/canvas-preview-fonts.test.ts pins those): the LICENSE of its Fontsource 5.3.0 package
// (@fontsource-variable/<family>, or @fontsource/<family> for Bebas Neue, Instrument Serif and Rajdhani), and for the
// three families that reserve their names, which ship their full fonts, the OFL.txt beside them in google/fonts at
// bf7c667a (ofl/orbitron, ofl/playfairdisplay, ofl/pressstart2p).
const PREVIEW_LICENCES: Record<string, { bytes: number; sha256: string }> = {
  'bebas-neue.LICENSE.txt': { bytes: 4391, sha256: '66c436339f7490c1a99e4f6a7b8aef5c176676edfd071a31638e7d54c1b0aeda' },
  'cinzel.LICENSE.txt': { bytes: 4382, sha256: 'f5a242cf68ad6ebd0603b3359a74c593ca080318a681035be5296ba2c6b04ae6' },
  'exo-2.LICENSE.txt': { bytes: 4489, sha256: '7644b74e07215f62af4ebbfcf2b0f06a428d70d32c41e751fba93763a683c3f5' },
  'instrument-serif.LICENSE.txt': { bytes: 4532, sha256: 'b6106a757902d2d412e09d94dc4a226fe3da80485208a98003969f1b8b6b1d74' },
  'inter.LICENSE.txt': { bytes: 4477, sha256: '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345' },
  'jetbrains-mono.LICENSE.txt': { bytes: 4524, sha256: '403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b' },
  'manrope.LICENSE.txt': { bytes: 4383, sha256: 'd826ab6583b12c26807d8716a545bdbbb672df04f48608a364ba9efdbe501c30' },
  'montserrat.LICENSE.txt': { bytes: 4509, sha256: 'f429f739351287574c0c3175a9222bb3e49c7cad3f568a04f2c08d74c107724e' },
  'orbitron.LICENSE.txt': { bytes: 4426, sha256: 'ab609b0e110d622435ff337cdf233288556e011bbf9bd0550be98846c0630819' },
  'outfit.LICENSE.txt': { bytes: 4387, sha256: '0e5fcef5d93bfcae273c11c00f0bb453d3b5491860e1ac8b658767b7577c938f' },
  'oxanium.LICENSE.txt': { bytes: 4383, sha256: '062fa183baec494d989d5d848f78a5466a537033c40f1b7651c19ca5d140ab7c' },
  'pixelify-sans.LICENSE.txt': { bytes: 4393, sha256: '8ed5cd9e189e30dfdb0df2d5c2771556b50e9d502d899221328c3245caf8423c' },
  'playfair-display.LICENSE.txt': { bytes: 4449, sha256: '566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e' },
  'press-start-2p.LICENSE.txt': { bytes: 4413, sha256: '705960c3281a5765ecc0b59bd4ed7ca59eed165748076bc2fc3e8fdbfeb944b0' },
  'rajdhani.LICENSE.txt': { bytes: 4727, sha256: '078e327eb00525214cdce9780cfdf156141f137f1a095bec9798f470703d7d2d' },
  'space-grotesk.LICENSE.txt': { bytes: 4401, sha256: '18a4de52385f6b988782639d5d0cc1326e5a8c2de9a7f01d7b20d9aedcc60943' },
  'unbounded.LICENSE.txt': { bytes: 4390, sha256: '48a780bc857729859e54d1e691b05792894a26634edc1c4b5dbeabffe6941758' },
};
type FamilyFont = { name: string; bytes: Buffer; base64: string; licence: { name: string; text: string } };

// The hosted build config itself, with its plugins, on an entry that loads the stylesheet naming the app's own fonts and
// the preview fonts: each of the config's two font plugins fails a build in which a font of its folder ships nowhere.
let hosted: Promise<OutputFile[]> | undefined;
const hostedBuild = () => (hosted ??= (async () => {
  const entry = 'virtual:awwo-font-licences-test';
  const code = `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};`
    + `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};`
    + 'globalThis.awwoPreviewFontSource = previewFontSource;';
  return outputFiles(await build({
    configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
    plugins: [{ name: 'awwo-font-licences-test-entry',
      resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
      load: (id: string) => (id === `\0${entry}` ? code : undefined) }],
    build: { write: false, rollupOptions: { input: entry } },
  }));
})());

describe("the hosted app's own fonts", () => {
  it("are GitHub's own build, its whole font in WOFF2, with the license their stylesheet names", () => {
    // Hidden files (a Finder .DS_Store) are no part of the folder; the plugin ignores them too.
    expect(readdirSync(FONTS).filter(name => !name.startsWith('.')).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [name, pin] of Object.entries(PINNED)) {
      const bytes = readFileSync(path.join(FONTS, name));
      expect(bytes.length, name).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(pin.sha256);
      if (!name.endsWith('.woff2')) continue;
      // A WOFF2 file of TrueType outlines, with no metadata or private block of its own.
      expect(bytes.subarray(0, 4).toString('latin1'), name).toBe('wOF2');
      expect(bytes.readUInt32BE(4), name).toBe(0x00010000);
      expect([bytes.readUInt32BE(32), bytes.readUInt32BE(44)], name).toEqual([0, 0]);
      expect(glyphCount(bytes), name).toBe(GLYPHS);
    }
    const licence = readFileSync(path.join(FONTS, LICENCE), 'utf8');
    expect(licence.startsWith('Copyright 2022 The Mona Sans Project Authors (https://github.com/github/mona-sans), with Reserved Font Name "Mona"')).toBe(true);
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    const tokens = readFileSync(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'), 'utf8');
    const named = [...tokens.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map(match => match[1]).sort();
    expect(named).toEqual(Object.keys(PINNED).filter(name => name.endsWith('.woff2')).sort());
    expect(tokens).toContain(`fonts/${LICENCE}`);
    // One face, for the same ranges as before: Latin and Latin Extended, nothing dropped and nothing added.
    expect(tokens.match(/@font-face/g)).toHaveLength(1);
    expect(/unicode-range:([^;]+);/.exec(tokens)?.[1]?.split(',').map(range => range.trim())).toEqual(RANGES);
  });

  it('ship with their license beside them in the hosted build', async () => {
    const files = await hostedBuild();
    const licence = readFileSync(path.join(FONTS, LICENCE));
    const fonts = readdirSync(FONTS).filter(name => name.endsWith('.woff2')).map(name => readFileSync(path.join(FONTS, name)));
    const shipped = files.filter(file => file.type === 'asset' && fonts.some(font => bytesOf(file).equals(font)));
    expect(shipped.map(file => path.posix.dirname(file.fileName))).toEqual(fonts.map(() => 'assets'));
    for (const font of shipped) {
      const beside = files.find(file => file.fileName === path.posix.join(path.posix.dirname(font.fileName), LICENCE));
      expect(beside, font.fileName).toBeDefined();
      expect(bytesOf(beside!).equals(licence), font.fileName).toBe(true);
    }
    // The stylesheet the build writes loads the emitted files.
    const css = files.filter(file => file.fileName.endsWith('.css')).map(file => bytesOf(file).toString('utf8')).join('\n');
    for (const font of shipped) expect(css).toContain(path.posix.basename(font.fileName));
  }, 180_000);

  it('stop a build that would ship a font without its license', () => {
    const font = Buffer.from('wOF2 a'), other = Buffer.from('wOF2 b'), licence = Buffer.from('SIL OPEN FONT LICENSE');
    const folder = { fonts: new Map([['a.woff2', font], ['b.woff2', other]]), licences: new Map([['OFL.txt', licence]]) };
    const both = (extra: [string, Buffer][] = []) => new Map<string, Buffer>([['assets/a-1x.woff2', font], ['assets/b-2y.woff2', other], ...extra]);
    // Each license goes into every directory that holds one of the fonts, once; one already there is left alone.
    expect(licenceAssets('fonts', folder, both([['print/a-1x.woff2', font]]))).toEqual([{ fileName: 'assets/OFL.txt', source: licence }, { fileName: 'print/OFL.txt', source: licence }]);
    expect(licenceAssets('fonts', folder, both([['assets/OFL.txt', licence]]))).toEqual([]);
    expect(licenceAssets('fonts', folder, new Map([['a.woff2', font], ['b.woff2', other]]))).toEqual([{ fileName: 'OFL.txt', source: licence }]);
    // A font the bundle holds in no file of its own (inlined into a stylesheet, or no longer named) stops the build,
    // and so do a folder without a license and a license that would replace another file.
    expect(() => licenceAssets('fonts', folder, new Map([['assets/a-1x.woff2', font]]))).toThrow(/holds b\.woff2 from fonts/);
    expect(() => licenceAssets('fonts', folder, new Map([['assets/a-1x.woff2', Buffer.from('wOF2 a, changed')], ['assets/b-2y.woff2', other]]))).toThrow(/holds a\.woff2 from fonts/);
    expect(() => licenceAssets('fonts', { ...folder, licences: new Map() }, both())).toThrow(/has fonts but no license file/);
    expect(() => licenceAssets('fonts', folder, both([['assets/OFL.txt', Buffer.from('other')]]))).toThrow(/would replace another file at assets\/OFL\.txt/);
    // The real folder: its font, and its license.
    const real = fontFolder(FONTS);
    expect([...real.fonts.keys()]).toEqual(['mona-sans-wdth-wght.woff2']);
    expect([...real.licences.keys()]).toEqual([LICENCE]);
  });
});

describe('the fonts AwwO supplies to running previews', () => {
  it("each come with their family's license, as their source ships it", () => {
    const files = folderFiles(PREVIEW);
    for (const [name, pin] of Object.entries(PREVIEW_LICENCES)) {
      const bytes = files.get(name)!;
      expect(bytes?.length, name).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(pin.sha256);
      expect(bytes.toString('utf8'), name).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    }
    // Every face of every family has its family's license, and the folder holds nothing else.
    const fonts = familyFonts(PREVIEW, files, PREVIEW_PAIRS) as FamilyFont[];
    const faces = PREVIEW_FONTS.flatMap(font => font.faces.map(face => `${face.file} ${slug(font.family)}.LICENSE.txt`)).sort();
    expect(fonts.map(font => `${font.name} ${font.licence.name}`)).toEqual(faces);
    expect([...files.keys()].sort()).toEqual([...fonts.map(font => font.name), ...Object.keys(PREVIEW_LICENCES)].sort());
    // The Reserved Font Names the licenses declare with their copyright lines: those of the three families that ship
    // their full fonts (Orbitron's fontsource license left its name out; Google Fonts' license of it, as its font
    // files' own copyright notice, declares it).
    const reserved = Object.keys(PREVIEW_LICENCES).filter(name => files.get(name)!.toString('utf8').split('\n')[0].includes('Reserved Font Name'));
    expect(reserved).toEqual(['orbitron.LICENSE.txt', 'playfair-display.LICENSE.txt', 'press-start-2p.LICENSE.txt']);
  });

  it('ship each with its license at the top of the script chunk that holds it, in the hosted build', async () => {
    const files = await hostedBuild(), chunks = files.filter(file => file.type === 'chunk');
    const licensed = new Set<OutputFile>();
    for (const font of PREVIEW_FONTS) for (const face of font.faces) {
      const base64 = readFileSync(path.join(PREVIEW, face.file)).toString('base64');
      const holders = files.filter(file => bytesOf(file).includes(base64));
      expect(holders.map(file => file.type), face.file).toEqual(['chunk']);
      // The license first, unchanged, after the line naming the font and the license file; then the font, still the
      // data: URL previewFonts.ts reads, in a chunk that another chunk loads.
      const name = `${slug(font.family)}.LICENSE.txt`, licence = readFileSync(path.join(PREVIEW, name), 'utf8');
      const code = holders[0].code ?? '';
      // (Press Start 2P's license, as Google Fonts ships it, has no line break at its end: the comment adds one.)
      expect(code.startsWith(`/*! License of ${face.file} (${name}):\n${licence}${licence.endsWith('\n') ? '' : '\n'}*/\n`), face.file).toBe(true);
      expect(code, face.file).toContain(`data:font/woff2;base64,${base64}`);
      expect(chunks.some(chunk => chunk.code?.includes(path.posix.basename(holders[0].fileName))), face.file).toBe(true);
      licensed.add(holders[0]);
    }
    expect(licensed.size).toBe(PREVIEW_FONTS.flatMap(font => font.faces).length);
    // No other chunk gains a license or so much as a line break.
    for (const chunk of chunks.filter(file => !licensed.has(file))) expect(chunk.code, chunk.fileName).toMatch(/^(?!\/\*! License of)\S/);
  }, 180_000);

  it('stop a build that would ship a preview font without its license', () => {
    const font = (text: string) => Buffer.from(`wOF2 ${text}`);
    const licence = (family: string) => Buffer.from(`Copyright 2026 The ${family} Project Authors\n\nSIL OPEN FONT LICENSE\n`);
    const folder = new Map<string, Buffer>([['a-sans-latin-italic.woff2', font('italic')], ['a-sans-latin-normal.woff2', font('normal')],
      ['a-sans-mono-latin-normal.woff2', font('mono')], ['a-sans-mono.LICENSE.txt', licence('A Sans Mono')], ['a-sans.LICENSE.txt', licence('A Sans')]]);
    const pairs = new Map([['a-sans-latin-italic.woff2', 'a-sans.LICENSE.txt'], ['a-sans-latin-normal.woff2', 'a-sans.LICENSE.txt'],
      ['a-sans-mono-latin-normal.woff2', 'a-sans-mono.LICENSE.txt']]);
    // Each font has the license the list of families gives it.
    const fonts = familyFonts('fonts', folder, pairs) as FamilyFont[];
    expect(fonts.map(entry => `${entry.name} ${entry.licence.name}`)).toEqual(['a-sans-latin-italic.woff2 a-sans.LICENSE.txt',
      'a-sans-latin-normal.woff2 a-sans.LICENSE.txt', 'a-sans-mono-latin-normal.woff2 a-sans-mono.LICENSE.txt']);
    const [italic, normal, mono] = fonts;
    // A family whose license is missing never borrows another's, even one whose name starts its own; a font the list
    // does not name, a license of no font and one that would end the comment carrying it stop the build too.
    const without = new Map([...folder].filter(([name]) => name !== 'a-sans-mono.LICENSE.txt'));
    expect(() => familyFonts('fonts', without, pairs)).toThrow('fonts: a-sans-mono-latin-normal.woff2: its license a-sans-mono.LICENSE.txt is missing.');
    expect(() => familyFonts('fonts', new Map([...folder, ['b-latin-normal.woff2', font('b')]]), pairs)).toThrow('fonts: b-latin-normal.woff2: no family lists it.');
    expect(() => familyFonts('fonts', new Map([...folder, ['c.LICENSE.txt', licence('C')]]), pairs)).toThrow('fonts: c.LICENSE.txt: the license of no font.');
    expect(() => familyFonts('fonts', new Map([...folder, ['a-sans.LICENSE.txt', Buffer.from('a */ b')]]), pairs))
      .toThrow('fonts: a-sans.LICENSE.txt holds "*/", which would end the comment that carries it.');
    // A chunk's banner: each license once, unchanged, after the fonts of the chunk it covers; nothing for none.
    const banner = (names: string, family: string, file: string) => `/*! License of ${names} (${file}):\n${licence(family)}*/`;
    expect(licenceBanner([normal, italic, normal])).toBe(banner('a-sans-latin-italic.woff2, a-sans-latin-normal.woff2', 'A Sans', 'a-sans.LICENSE.txt'));
    // Licenses in the order of their file names ("a-sans-mono." before "a-sans.").
    expect(licenceBanner([normal, mono])).toBe(`${banner('a-sans-mono-latin-normal.woff2', 'A Sans Mono', 'a-sans-mono.LICENSE.txt')}\n${banner('a-sans-latin-normal.woff2', 'A Sans', 'a-sans.LICENSE.txt')}`);
    expect(licenceBanner([])).toBe('');
    // A chunk holds a font when the code of one of its modules has the font's bytes, as base64.
    expect(fontsInModules(fonts, { a: { code: `export default "data:font/woff2;base64,${mono.base64}"` }, b: { code: null }, c: { code: 'x' } })).toEqual([mono]);
    expect(fontsInModules(fonts, { a: { code: `"${normal.base64.slice(1)}"` } })).toEqual([]);
    // In the bundle: a chunk with a font but not its license (no banner, another family's, or one cut short), any
    // other file holding the font or its base64, and a font in no file at all.
    const code = (entry: FamilyFont, licensed = entry) => `${licenceBanner([licensed])}\nvar e=\`data:font/woff2;base64,${entry.base64}\``;
    const fine = new Map([['assets/i.js', { type: 'chunk', content: code(italic) }], ['assets/n.js', { type: 'chunk', content: code(normal) }],
      ['assets/m.js', { type: 'chunk', content: code(mono) }]]);
    expect(unlicensedFonts(fonts, fine)).toEqual([]);
    const cut = code(normal).replace('SIL OPEN FONT LICENSE\n', '');
    for (const content of [`"${normal.base64}"`, code(normal, mono), cut]) {
      expect(unlicensedFonts(fonts, new Map([...fine, ['assets/n.js', { type: 'chunk', content }]])), content.slice(0, 60))
        .toEqual(['assets/n.js holds a-sans-latin-normal.woff2 without its license a-sans.LICENSE.txt']);
    }
    const other = 'only a script chunk can start with its license: load it from a script with ?inline, and keep it out of source maps, stylesheets and copied folders such as public/';
    expect(unlicensedFonts(fonts, new Map([...fine, ['assets/a.woff2', { type: 'asset', content: italic.bytes }],
      ['assets/s.css', { type: 'asset', content: Buffer.from(`src:url(data:font/woff2;base64,${mono.base64})`) }]]))).toEqual([
      `assets/a.woff2 holds a-sans-latin-italic.woff2 (${other})`, `assets/s.css holds a-sans-mono-latin-normal.woff2 (${other})`]);
    expect(unlicensedFonts(fonts, new Map([...fine].filter(([name]) => name !== 'assets/m.js')))).toEqual([
      'no file holds a-sans-mono-latin-normal.woff2 (delete a font no page loads, then a license of no font and its entry in THIRD_PARTY_NOTICES.md)']);
  });

  it('keep a banner set before theirs, and give every other chunk nothing at all', async () => {
    const plugin = inlinedFontLicences(PREVIEW, PREVIEW_PAIRS) as unknown as { buildStart(): void; outputOptions(options: object): { postBanner(chunk: object): Promise<string | undefined> } };
    plugin.buildStart();
    const cinzel = readFileSync(path.join(PREVIEW, 'cinzel-latin-wght-normal.woff2')).toString('base64');
    const fontChunk = { modules: { 'cinzel-latin-wght-normal.woff2?inline': { code: `var e = "data:font/woff2;base64,${cinzel}";` } } };
    const other = { modules: { 'main.ts': { code: 'export const x = 1;' } } };
    const banner = `/*! License of cinzel-latin-wght-normal.woff2 (cinzel.LICENSE.txt):\n${readFileSync(path.join(PREVIEW, 'cinzel.LICENSE.txt'), 'utf8')}*/`;
    const none = plugin.outputOptions({});
    expect(await none.postBanner(fontChunk)).toBe(banner);
    // undefined, not '': Rolldown starts a chunk with a line break even for an empty banner.
    expect(await none.postBanner(other)).toBeUndefined();
    const text = plugin.outputOptions({ postBanner: '/* earlier */' }), called = plugin.outputOptions({ postBanner: async () => '/* earlier */' });
    for (const options of [text, called]) {
      expect(await options.postBanner(fontChunk)).toBe(`/* earlier */\n${banner}`);
      expect(await options.postBanner(other)).toBe('/* earlier */');
    }
  });

  it('fail a hosted build in which a preview font ships as a file, or in no file', async () => {
    const run = (code: string) => build({
      configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-font-licences-refusal-entry', resolveId: (id: string) => (id === 'virtual:refusal' ? '\0virtual:refusal' : undefined),
        load: (id: string) => (id === '\0virtual:refusal' ? `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};${code}` : undefined) }],
      build: { write: false, rollupOptions: { input: 'virtual:refusal' } },
    });
    const previewFonts = JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'));
    const cinzel = JSON.stringify(`${path.join(PREVIEW, 'cinzel-latin-wght-normal.woff2')}?url`);
    await expect(run(`import { previewFontSource } from ${previewFonts}; import url from ${cinzel}; globalThis.x = [previewFontSource, url];`))
      .rejects.toThrow(/assets\/cinzel-latin-wght-normal-[\w-]+\.woff2 holds cinzel-latin-wght-normal\.woff2 \(only a script chunk can start with its license/);
    await expect(run('')).rejects.toThrow(/no file holds bebas-neue-latin-400-normal\.woff2/);
  }, 180_000);

  it('fail a build that copies a preview font into its output', async () => {
    // A written build of the plugin alone (the hosted config's own copy steps need the showcase), with public/ copied in.
    const scratch = mkdtempSync(path.join(tmpdir(), 'awwo-font-licences-')), publicDir = path.join(scratch, 'public');
    const entry = 'virtual:awwo-font-licences-copy';
    const run = () => build({
      configFile: false, root: WEB, publicDir, logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-font-licences-copy-entry', resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
        load: (id: string) => (id === `\0${entry}` ? `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))}; globalThis.x = previewFontSource;` : undefined) },
      inlinedFontLicences(PREVIEW, PREVIEW_PAIRS)],
      build: { outDir: path.join(scratch, `out-${readdirSync(scratch).length}`), write: true, rollupOptions: { input: entry } },
    });
    try {
      mkdirSync(path.join(publicDir, 'sub'), { recursive: true });
      writeFileSync(path.join(publicDir, 'robots.txt'), 'User-agent: *\n');
      await expect(run()).resolves.toBeDefined();
      // In a folder of the copy: a face itself, and a saved stylesheet holding another as a data: URL.
      copyFileSync(path.join(PREVIEW, 'cinzel-latin-wght-normal.woff2'), path.join(publicDir, 'sub', 'brand.woff2'));
      const bebas = readFileSync(path.join(PREVIEW, 'bebas-neue-latin-400-normal.woff2')).toString('base64');
      writeFileSync(path.join(publicDir, 'sub', 'saved.css'), `@font-face{font-family:"Bebas Neue";src:url(data:font/woff2;base64,${bebas})}`);
      const message = await run().then(() => '', (failure: Error) => failure.message);
      expect(message).toMatch(/^The build shipped fonts of /);
      expect(message).toContain('sub/brand.woff2 holds cinzel-latin-wght-normal.woff2 (only a script chunk');
      expect(message).toContain('sub/saved.css holds bebas-neue-latin-400-normal.woff2 (only a script chunk');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
