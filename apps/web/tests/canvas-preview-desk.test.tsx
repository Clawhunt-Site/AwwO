import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasPreviewDesk } from '../src/canvas/CanvasPreviewDesk';
import { SourceBrowser, SourcePreview } from '../src/canvas/SourcePreview';
import { ModelPreview } from '../src/canvas/ModelPreview';
import { PdfPreview } from '../src/canvas/PdfPreview';
import { previewSample } from '../src/canvas/previewSamples';
import { ARTIFACT_REF_PREFIX, clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('four canvas preview windows', () => {
  it('always shows four separate empty windows and labels local demos honestly', () => {
    render(<CanvasPreviewDesk />);
    for (const name of ['HTML', '3D', 'PDF', 'IDE']) expect(screen.getByRole('region', { name, exact: true })).toBeTruthy();
    const pane = within(screen.getByRole('region', { name: 'HTML', exact: true }));
    fireEvent.click(pane.getByRole('button', { name: '本地示例' }));
    expect(pane.getByText('本地演示文件 · 非任务交付物')).toBeTruthy();
    expect(pane.getByTitle('local-demo.html · HTML 预览')).toHaveAttribute('sandbox', '');
  });
  it('uploads HTML bytes, keeps sandbox isolation, and clears files when workspace changes', async () => {
    const { rerender } = render(<CanvasPreviewDesk scopeKey="one" />);
    fireEvent.change(screen.getByLabelText('HTML 本地文件'), { target: { files: [new File(['<html><body><h1>Uploaded content</h1></body></html>'], 'real.html')] } });
    expect(await screen.findByTitle('real.html · HTML 预览')).toHaveAttribute('srcdoc', expect.stringContaining('Uploaded content'));
    expect(screen.queryByText('本地演示文件 · 非任务交付物')).toBeNull();
    rerender(<CanvasPreviewDesk scopeKey="two" />);
    expect(screen.queryByTitle('real.html · HTML 预览')).toBeNull();
  });
  it('rejects a file sent to the wrong renderer', async () => {
    render(<CanvasPreviewDesk />);
    fireEvent.change(screen.getByLabelText('PDF 本地文件'), { target: { files: [new File(['bad'], 'bad.exe')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('文件格式与预览窗口不符');
  });
  it('loads actual stored artifact response and does not use title as source', async () => {
    configureSaaSCanvas({ tenant: { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: 'canvas' });
    const reference = `${ARTIFACT_REF_PREFIX}a${'B'.repeat(32)}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>Actual stored bytes</body></html>', { headers: { 'Content-Disposition': 'attachment; filename="real.html"' } })));
    render(<CanvasPreviewDesk artifacts={[{ reference, title: 'Deliverable', name: 'real.html' }]} />);
    expect(await screen.findByTitle('real.html · HTML 预览')).toHaveAttribute('srcdoc', expect.stringContaining('Actual stored bytes'));
  });
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
  it('opens a real demo workspace archive through the source renderer', async () => {
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
