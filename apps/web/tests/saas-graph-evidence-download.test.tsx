import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GraphEvidenceDownload } from '../src/saas/GraphEvidenceDownload';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { collectGraphEvidence, downloadGraphEvidence, type GraphEvidenceBundle } from '../src/saas/graphEvidenceExport';
vi.mock('../src/saas/graphEvidenceExport', () => ({ collectGraphEvidence: vi.fn(), downloadGraphEvidence: vi.fn() }));
const view = (tenantId = 'tenant-a', graphId = 'graph-a') => <SaaSPreferencesProvider><GraphEvidenceDownload tenantId={tenantId} canvasId="canvas-a" graphId={graphId} /></SaaSPreferencesProvider>;
const bundle = (patch = {}) => ({ completeness: { complete: true, inProgress: false, ...patch } }) as GraphEvidenceBundle;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); vi.mocked(collectGraphEvidence).mockReset(); vi.mocked(downloadGraphEvidence).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows graph identity and only exports on click with a loading guard', async () => {
  let resolve!: (value: GraphEvidenceBundle) => void;
  vi.mocked(collectGraphEvidence).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(view()); expect(screen.getByText('graph-a')).toBeVisible(); expect(collectGraphEvidence).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '导出本次整图证据' }));
  expect(screen.getByRole('button', { name: '正在收集运行证据…' })).toBeDisabled();
  expect(collectGraphEvidence).toHaveBeenCalledWith({ tenantId: 'tenant-a', canvasId: 'canvas-a', graphId: 'graph-a' }, expect.any(AbortSignal));
  resolve(bundle());
  await waitFor(() => expect(downloadGraphEvidence).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status')).toHaveTextContent('不代表任务通过人工验收');
});
it.each([{ complete: false, inProgress: true, label: '运行中快照' }, { complete: false, inProgress: false, label: '部分记录' }])('labels incomplete downloads honestly: %j', async patch => {
  vi.mocked(collectGraphEvidence).mockResolvedValue(bundle(patch)); render(view());
  fireEvent.click(screen.getByRole('button', { name: '导出本次整图证据' }));
  expect(await screen.findByRole('status')).toHaveTextContent(patch.label); expect(downloadGraphEvidence).toHaveBeenCalledTimes(1);
});
it('reports failure without downloading any stale export', async () => {
  vi.mocked(collectGraphEvidence).mockRejectedValue(new Error('Access revoked'));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '导出本次整图证据' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Access revoked'); expect(downloadGraphEvidence).not.toHaveBeenCalled();
});
it('aborts on tenant/graph switch and ignores a late prior response', async () => {
  let finish!: (value: GraphEvidenceBundle) => void;
  vi.mocked(collectGraphEvidence).mockImplementation(() => new Promise(done => { finish = done; }));
  const page = render(view()); fireEvent.click(screen.getByRole('button', { name: '导出本次整图证据' }));
  const signal = vi.mocked(collectGraphEvidence).mock.calls[0][1];
  page.rerender(view('tenant-b', 'graph-b')); expect(signal.aborted).toBe(true);
  finish(bundle()); await Promise.resolve();
  expect(downloadGraphEvidence).not.toHaveBeenCalled(); expect(screen.queryByRole('status')).toBeNull(); expect(screen.getByText('graph-b')).toBeVisible();
});
it('aborts on unmount and provides the English action', () => {
  localStorage.setItem('superclaw_locale', 'en');
  vi.mocked(collectGraphEvidence).mockImplementation(() => new Promise(() => {}));
  const page = render(view()); fireEvent.click(screen.getByRole('button', { name: 'Export this graph’s evidence' }));
  const signal = vi.mocked(collectGraphEvidence).mock.calls[0][1]; page.unmount(); expect(signal.aborted).toBe(true);
});
