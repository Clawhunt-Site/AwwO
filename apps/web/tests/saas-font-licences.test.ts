// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { fontFolder, licenceAssets } from '../scripts/font-licences.mjs';

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
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? '');

/** The glyph count of a WOFF2 font, from its maxp table: tables follow one another, unpadded, in one Brotli stream. */
function woff2GlyphCount(file: Buffer): number {
  let offset = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = file[offset++]!;
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return value;
    }
    throw new Error('UIntBase128 longer than 5 bytes');
  };
  const tables: { known: number; stored: number }[] = [];
  for (let i = 0; i < file.readUInt16BE(12); i += 1) {
    const flags = file[offset++]!, known = flags & 0x3f, version = flags >> 6;
    if (known === 0x3f) offset += 4;
    const length = base128();
    // glyf (10) and loca (11) are transformed at version 0, every other table at any other version.
    const transformed = known === 10 || known === 11 ? version === 0 : version !== 0;
    tables.push({ known, stored: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(file.subarray(offset, offset + file.readUInt32BE(20)));
  let start = 0;
  for (const table of tables) {
    // maxp is table 4 of WOFF2's known tags; its numGlyphs is at offset 4.
    if (table.known === 4) return data.readUInt16BE(start + 4);
    start += table.stored;
  }
  throw new Error('no maxp table');
}

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
      expect(woff2GlyphCount(bytes), name).toBe(GLYPHS);
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
    // The hosted build config itself, with its plugins, on an entry that loads only the stylesheet naming the fonts.
    const entry = 'virtual:awwo-font-licences-test';
    const result = await build({
      configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-font-licences-test-entry',
        resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
        load: (id: string) => (id === `\0${entry}` ? `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};` : undefined) }],
      build: { write: false, rollupOptions: { input: entry } },
    });
    const files = (Array.isArray(result) ? result : [result]).flatMap(output => (output as unknown as { output: OutputFile[] }).output);
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
