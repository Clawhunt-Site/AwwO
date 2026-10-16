import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceBrowser, SourcePreview } from '../src/canvas/SourcePreview';
import { ModelPreview } from '../src/canvas/ModelPreview';
import { PdfPreview } from '../src/canvas/PdfPreview';
import { pdfResourceFactory } from '../src/canvas/pdfPreviewResources';
import { previewSample } from './fixtures/previewSamples';

// pdf.js itself, replaced, so a test can see what PdfPreview asks of it; the malformed-file test never reaches it.
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: '' } }));
vi.mock('pdfjs-dist', () => pdfjs);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); pdfjs.getDocument.mockReset(); });
describe('deliverable viewers', () => {
  it('switches source files and searches exact rendered lines', () => {
    render(<SourceBrowser files={[{ path: 'src/a.ts', source: 'const first = 1;\nexport { first };' }, { path: 'src/b.ts', source: 'const second = 2;' }]} />);
    expect(screen.getByText('const first = 1;')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(screen.getByText('const second = 2;')).toBeTruthy();
    expect(screen.queryByText('const first = 1;')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前文件' }), { target: { value: 'second' } });
    expect(screen.getByRole('button', { name: '1/1' })).toBeTruthy();
    expect(screen.getByText('const second = 2;').parentElement).toHaveAttribute('data-match', 'true');
  });
  it('opens a real workspace archive through the source renderer', async () => {
    render(<SourcePreview files={[previewSample('ide')]} />);
    expect(await screen.findByRole('button', { name: 'src/main.ts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'src/main.ts' }));
    expect(screen.getByText('interface Preview { title: string; ready: boolean }')).toBeTruthy();
  });
  it('reports malformed 3D files before creating a WebGL context', async () => {
    render(<ModelPreview file={{ name: 'broken.glb', bytes: new Uint8Array([1, 2]) }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('GLB');
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('reports malformed PDF without claiming page rendering', async () => {
    render(<PdfPreview file={{ name: 'broken.pdf', bytes: new Uint8Array([1, 2]) }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 文件头无效');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});

describe('the PDF preview\'s bundled fonts', () => {
  it('are the two that pdf.js asks for when it uses the system\'s fonts, as the preview tells it to', async () => {
    pdfjs.getDocument.mockReturnValue({ promise: new Promise(() => undefined), destroy: () => Promise.resolve() });
    render(<PdfPreview file={{ name: 'a.pdf', bytes: new TextEncoder().encode('%PDF-1.7\n') }} />);
    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(1));
    const options = pdfjs.getDocument.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.useSystemFonts).toBe(true);
    // A font URL would let pdf.js load every standard font by URL as well; XFA forms load Liberation Sans without the
    // system's fonts; and the data pdf.js asks for goes through the preview's own resource factory, not the worker's fetch.
    expect(options).not.toHaveProperty('standardFontDataUrl');
    expect(options.enableXfa).toBe(false);
    expect(options.useWorkerFetch).toBe(false);
    expect(options.BinaryDataFactory).toBeTypeOf('function');
    // pdfjs-dist's worker: with useSystemFonts, standard font data is fetched for Symbol and ZapfDingbats only, from these
    // files, in its one place that asks for standard font data; only its XFA font loading turns the system's fonts off.
    const worker = readFileSync(path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'), 'utf8');
    expect(worker).toMatch(/if \(this\.options\.useSystemFonts && name !== "Symbol" && name !== "ZapfDingbats"\) \{\s*return null;\s*\}/);
    expect(worker).toContain('t.Symbol = "FoxitSymbol.pfb";');
    expect(worker).toContain('t.ZapfDingbats = "FoxitDingbats.pfb";');
    expect(worker.match(/kind: "standardFontDataUrl"/g)).toHaveLength(1);
    expect(worker.match(/useSystemFonts: false/g)).toHaveLength(1);
    expect(worker).toMatch(/async #loadXfaFonts\([^]{0,1500}useSystemFonts: false/);
  });

  it('are served to pdf.js, while every other standard font file is refused', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(String(url)); return { ok: true, arrayBuffer: async () => new Uint8Array([7]).buffer }; }));
    const Resources = pdfResourceFactory(new AbortController().signal), resources = new Resources();
    for (const filename of ['FoxitSymbol.pfb', 'FoxitDingbats.pfb']) expect(await resources.fetch({ kind: 'standardFontDataUrl', filename })).toEqual(new Uint8Array([7]));
    expect(fetched.map(url => url.split('/').at(-1))).toEqual(['FoxitSymbol.pfb', 'FoxitDingbats.pfb']);
    for (const filename of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'FoxitSerif.pfb', 'FoxitFixed.pfb']) {
      await expect(resources.fetch({ kind: 'standardFontDataUrl', filename }), filename).rejects.toThrow('PDF 请求了未提供的内置资源');
    }
    // The character maps are all still there.
    expect(await resources.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' })).toEqual(new Uint8Array([7]));
    expect(fetched).toHaveLength(3);
  });
});
