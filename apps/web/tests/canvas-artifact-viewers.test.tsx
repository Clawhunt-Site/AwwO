import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceBrowser, SourcePreview } from '../src/canvas/SourcePreview';
import { ModelPreview } from '../src/canvas/ModelPreview';
import { PdfPreview } from '../src/canvas/PdfPreview';
import { previewSample } from './fixtures/previewSamples';

afterEach(() => { cleanup(); });
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
