// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { assetFileNames } from '../scripts/asset-names.mjs';

const WEB = path.resolve(__dirname, '..');
const PDFJS = path.join(WEB, 'node_modules', 'pdfjs-dist');
// The license files PdfPreview links (src/canvas/PdfPreview.tsx), by the name of the asset each ships as.
const LICENCES = { LICENSE: path.join(PDFJS, 'LICENSE'), 'cmaps LICENSE': path.join(PDFJS, 'cmaps', 'LICENSE'), LICENSE_FOXIT: path.join(PDFJS, 'standard_fonts', 'LICENSE_FOXIT') };
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array; code?: string };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? '');

describe("the PDF preview's license links", () => {
  it('open text files of their own in the hosted build', async () => {
    // The hosted build config itself, with its plugins, on an entry that keeps the PDF preview (an app build drops what an
    // entry only exports) and loads the stylesheet that names the app's own fonts and the preview fonts (without them, the
    // config's font license plugins stop the build).
    const entry = 'virtual:awwo-pdf-licences-test';
    const source = `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};\n`
      + `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};\n`
      + `import { PdfPreview } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'PdfPreview.tsx'))};\n`
      + 'globalThis.awwoPdfPreview = PdfPreview;\nglobalThis.awwoPreviewFontSource = previewFontSource;';
    const result = await build({
      configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-pdf-licences-test-entry',
        resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
        load: (id: string) => (id === `\0${entry}` ? source : undefined) }],
      build: { write: false, rollupOptions: { input: entry } },
    });
    const files = (Array.isArray(result) ? result : [result]).flatMap(output => (output as unknown as { output: OutputFile[] }).output);
    const code = files.filter(file => file.type === 'chunk').map(file => file.code ?? '').join('\n');
    for (const [label, source] of Object.entries(LICENCES)) {
      const text = readFileSync(source);
      const shipped = files.filter(file => file.type === 'asset' && bytesOf(file).equals(text));
      expect(shipped.map(file => file.fileName), label).toHaveLength(1);
      // assets/LICENSE-<hash>.txt: a name every file system keeps and every server sends as text.
      expect(shipped[0]!.fileName, label).toMatch(/^assets\/LICENSE(?:_FOXIT)?-[\w-]+\.txt$/);
      expect(code, label).toContain(`/${shipped[0]!.fileName}`);
      // And not inlined into a script as well (a link to a data: URL opens no text).
      expect(code.includes(text.toString('base64').slice(0, 64)), label).toBe(false);
    }
    expect(files.filter(file => file.fileName.endsWith('.')).map(file => file.fileName)).toEqual([]);
  }, 180_000);

  it('name every other asset as Vite does', () => {
    expect(assetFileNames({ names: ['LICENSE'] })).toBe('assets/[name]-[hash].txt');
    expect(assetFileNames({ names: ['LICENSE_FOXIT'] })).toBe('assets/[name]-[hash].txt');
    expect(assetFileNames({ names: ['NOTICE'] })).toBe('assets/[name]-[hash].txt');
    expect(assetFileNames({ names: ['COPYING'] })).toBe('assets/[name]-[hash].txt');
    for (const name of ['FoxitSymbol.pfb', 'saas.css', 'LICENSE-mona-sans.txt', 'skillLicences.txt', 'UniGB-UCS2-H.bcmap']) expect(assetFileNames({ names: [name] }), name).toBe('assets/[name]-[hash][extname]');
    // Another file without an extension keeps its name, without the trailing dot.
    expect(assetFileNames({ names: ['Makefile'] })).toBe('assets/[name]-[hash]');
  });
});
