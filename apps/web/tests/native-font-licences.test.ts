// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { PREVIEW_FONTS } from '../src/canvas/previewFontList';

const WEB = path.resolve(__dirname, '..');
const PREVIEW = path.join(WEB, 'src', 'canvas', 'fonts');
const slug = (family: string) => family.toLowerCase().replace(/ /g, '-');
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array; code?: string };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? file.code ?? '');
const outputFiles = (result: unknown) => (Array.isArray(result) ? result : [result]).flatMap(output => (output as { output: OutputFile[] }).output);

// The native build config itself (vite.config.mjs, whose output the desktop app and the root Docker image ship), with its
// plugins and its chunk groups, on an entry that loads the preview fonts and React, which a group of its own takes. The
// input goes in rolldownOptions, as the config names its own options.
const nativeBuild = async () => {
  const entry = 'virtual:awwo-native-font-licences-test';
  const code = `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};`
    + "import { createElement } from 'react';"
    + 'globalThis.awwoPreviewFontSource = [previewFontSource, createElement];';
  return outputFiles(await build({
    configFile: path.join(WEB, 'vite.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
    plugins: [{ name: 'awwo-native-font-licences-test-entry',
      resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
      load: (id: string) => (id === `\0${entry}` ? code : undefined) }],
    build: { write: false, rolldownOptions: { input: entry } },
  }));
};

describe('the fonts AwwO supplies to running previews, in the native build', () => {
  it('ship each with its license at the top of the script chunk that holds it', async () => {
    const files = await nativeBuild(), chunks = files.filter(file => file.type === 'chunk');
    const licensed = new Set<OutputFile>();
    for (const font of PREVIEW_FONTS) for (const face of font.faces) {
      const base64 = readFileSync(path.join(PREVIEW, face.file)).toString('base64');
      const holders = files.filter(file => bytesOf(file).includes(base64));
      expect(holders.map(file => file.type), face.file).toEqual(['chunk']);
      // The license first, unchanged, after the line naming the font and the license file; then the font, still the
      // data: URL previewFonts.ts reads, in a chunk that another chunk loads.
      const name = `${slug(font.family)}.LICENSE.txt`, licence = readFileSync(path.join(PREVIEW, name), 'utf8');
      const code = holders[0].code ?? '';
      expect(code.startsWith(`/*! License of ${face.file} (${name}):\n${licence}${licence.endsWith('\n') ? '' : '\n'}*/\n`), face.file).toBe(true);
      expect(code, face.file).toContain(`data:font/woff2;base64,${base64}`);
      expect(chunks.some(chunk => chunk.code?.includes(path.posix.basename(holders[0].fileName))), face.file).toBe(true);
      licensed.add(holders[0]);
    }
    expect(licensed.size).toBe(PREVIEW_FONTS.flatMap(font => font.faces).length);
    // The config's chunk groups still apply beside the license banner: React is in the group's chunk.
    const react = chunks.filter(chunk => /^assets\/vendor-react-[\w-]+\.js$/.test(chunk.fileName));
    expect(react.map(chunk => chunk.code?.includes('react.transitional.element')), 'vendor-react').toEqual([true]);
    // No other chunk gains a license or so much as a line break.
    for (const chunk of chunks.filter(file => !licensed.has(file))) expect(chunk.code, chunk.fileName).toMatch(/^(?!\/\*! License of)\S/);
  }, 180_000);
});
