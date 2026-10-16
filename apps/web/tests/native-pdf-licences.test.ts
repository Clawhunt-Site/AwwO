// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '..');
const PDFJS = path.join(WEB, 'node_modules', 'pdfjs-dist');
// The license files PdfPreview links (src/canvas/PdfPreview.tsx), by the name of the asset each ships as.
const LICENCES = { LICENSE: path.join(PDFJS, 'LICENSE'), 'cmaps LICENSE': path.join(PDFJS, 'cmaps', 'LICENSE'), LICENSE_FOXIT: path.join(PDFJS, 'standard_fonts', 'LICENSE_FOXIT') };
type OutputFile = { type: string; fileName: string; source?: string | Uint8Array; code?: string };
const bytesOf = (file: OutputFile) => Buffer.from(file.source ?? '');

describe("the PDF preview's license links, in the native build", () => {
  it('open text files of their own', async () => {
    // The native build config itself (vite.config.mjs, whose output the desktop app and the root Docker image ship), on an
    // entry that keeps the PDF preview and, as the app does, the preview fonts. The input goes in rolldownOptions, as the
    // config names its own options.
    const entry = 'virtual:awwo-native-pdf-licences-test';
    const source = `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};\n`
      + `import { PdfPreview } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'PdfPreview.tsx'))};\n`
      + 'globalThis.awwoPdfPreview = PdfPreview;\nglobalThis.awwoPreviewFontSource = previewFontSource;';
    const result = await build({
      configFile: path.join(WEB, 'vite.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-native-pdf-licences-test-entry',
        resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
        load: (id: string) => (id === `\0${entry}` ? source : undefined) }],
      build: { write: false, rolldownOptions: { input: entry } },
    });
    const files = (Array.isArray(result) ? result : [result]).flatMap(output => (output as unknown as { output: OutputFile[] }).output);
    const code = files.filter(file => file.type === 'chunk').map(file => file.code ?? '').join('\n');
    for (const [label, source] of Object.entries(LICENCES)) {
      const text = readFileSync(source);
      const shipped = files.filter(file => file.type === 'asset' && bytesOf(file).equals(text));
      expect(shipped.map(file => file.fileName), label).toHaveLength(1);
      // assets/LICENSE-<hash>.txt, as in the hosted build: the desktop installer is built on Windows, which drops the
      // trailing dot Rolldown leaves on a name without an extension, and the link would then open nothing.
      expect(shipped[0]!.fileName, label).toMatch(/^assets\/LICENSE(?:_FOXIT)?-[\w-]+\.txt$/);
      expect(code, label).toContain(shipped[0]!.fileName);
      expect(code.includes(text.toString('base64').slice(0, 64)), label).toBe(false);
    }
    expect(files.filter(file => file.fileName.endsWith('.')).map(file => file.fileName)).toEqual([]);
  }, 180_000);
});
