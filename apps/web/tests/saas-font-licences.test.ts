// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { fontFolder, licenceAssets } from '../scripts/font-licences.mjs';

const WEB = path.resolve(__dirname, '..');
const FONTS = path.join(WEB, 'src', 'saas', 'design', 'fonts');
const LICENCE = 'LICENSE-mona-sans.txt';
// The files of @fontsource-variable/mona-sans 5.3.0 (LICENSE and files/mona-sans-latin{,-ext}-standard-normal.woff2),
// unchanged: Google Fonts' Latin and Latin Extended subsets of Mona Sans, its width and weight axes, upright.
const PINNED: Record<string, { bytes: number; sha256: string }> = {
  [LICENCE]: { bytes: 4564, sha256: '41e9911493de5899a20336baf13b6ea6483b5eea34e237f2ffed22c39bdc4a8d' },
  'mona-sans-latin-ext-standard-normal.woff2': { bytes: 32800, sha256: '5658cdeea602a52f3e70a1a940fd7a7f05154651361e683f941afee32377425b' },
  'mona-sans-latin-standard-normal.woff2': { bytes: 98124, sha256: '5ea3740633e5ac7af56c13d7e8ec32bcae12e7723e53d34284469a8947ccb2f3' },
};
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? '');

describe("the hosted app's own fonts", () => {
  it('are the files fontsource ships, with the license their stylesheet names', () => {
    // Hidden files (a Finder .DS_Store) are no part of the folder; the plugin ignores them too.
    expect(readdirSync(FONTS).filter(name => !name.startsWith('.')).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [name, pin] of Object.entries(PINNED)) {
      const bytes = readFileSync(path.join(FONTS, name));
      expect(bytes.length, name).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(pin.sha256);
    }
    const licence = readFileSync(path.join(FONTS, LICENCE), 'utf8');
    expect(licence.startsWith('Copyright 2022 The Mona Sans Project Authors (https://github.com/github/mona-sans), with Reserved Font Name "Mona"')).toBe(true);
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    const tokens = readFileSync(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'), 'utf8');
    const named = [...tokens.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map(match => match[1]).sort();
    expect(named).toEqual(Object.keys(PINNED).filter(name => name.endsWith('.woff2')).sort());
    expect(tokens).toContain(`fonts/${LICENCE}`);
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
    // The real folder: its two fonts, and its license.
    const real = fontFolder(FONTS);
    expect([...real.fonts.keys()]).toEqual(['mona-sans-latin-ext-standard-normal.woff2', 'mona-sans-latin-standard-normal.woff2']);
    expect([...real.licences.keys()]).toEqual([LICENCE]);
  });
});
