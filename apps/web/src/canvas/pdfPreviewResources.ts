/// <reference path="./preview-assets.d.ts" />
// The manifest is fixed at build time. PDF-supplied resource names cannot become
// arbitrary paths, and Chinese/CJK PDFs can use the bundled Adobe character maps.
const cmaps = import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true });
const fonts = import.meta.glob<string>(['../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../node_modules/pdfjs-dist/standard_fonts/*.ttf'], { query: '?url', import: 'default', eager: true });
const names = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, url]) => [path.split('/').at(-1)!, url]));
const resources = { cMapUrl: names(cmaps), standardFontDataUrl: names(fonts) };

export function pdfResourceFactory(signal: AbortSignal) {
  return class LocalPdfResources {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const url = kind === 'cMapUrl' || kind === 'standardFontDataUrl' ? resources[kind].get(filename) : undefined;
      if (!url) throw new Error('PDF 请求了未提供的内置资源');
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
      if (!response.ok) throw new Error('PDF 内置资源读取失败');
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}
