import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasKnowledgeDock } from '../src/saas/CanvasKnowledgeDock';
import { canvasKnowledgeRevisionIds, clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import type { KnowledgeContextItem } from '../src/saas/knowledgeApi';
import type { KnowledgeWorkbenchProps } from '../src/saas/KnowledgeWorkbench';
import type { ManagedExecutionPanelProps } from '../src/saas/ManagedExecutionPanel';

const fixture = vi.hoisted(() => ({
  api: vi.fn(), proposal: vi.fn(), failed: vi.fn(),
  ref: { documentId: 'doc-a', revisionId: 'rev-a', title: 'Evidence', kind: 'source', contentHash: 'hash-a', content: 'Frozen evidence', sourceUri: '', provenance: {} },
}));
vi.mock('../src/saas/api', async original => ({ ...await original<typeof import('../src/saas/api')>(), api: fixture.api }));
vi.mock('../src/saas/knowledgeApi', async original => ({ ...await original<typeof import('../src/saas/knowledgeApi')>(), createKnowledgeProposal: fixture.proposal }));
vi.mock('../src/saas/preferences', () => ({ useSaaSPreferences: () => ({ locale: 'zh', t: (zh: string) => zh }) }));
vi.mock('../src/canvas/CanvasPreviewDesk', () => ({ CanvasPreviewDesk: ({ artifacts }: { artifacts: { identity: string; title: string }[] }) => <div>Preview panes{artifacts.map(item => <span key={item.identity}>{item.title}</span>)}</div> }));
vi.mock('../src/saas/ManagedExecutionPanel', () => ({ ManagedExecutionPanel: (props: ManagedExecutionPanelProps) => <div>
  <p>Managed execution · {props.canvasId}</p><p>Execution references: {props.knowledgeReferences?.map(item => item.revisionId).join(', ')}</p>
  <button onClick={props.onArtifactsChanged}>Produced artifact</button><button onClick={props.onClose}>Close execution</button>
</div> }));
vi.mock('../src/saas/KnowledgeWorkbench', () => ({ KnowledgeWorkbench: (props: KnowledgeWorkbenchProps) => <div>
  <button onClick={() => { void props.onTaskContext('quoted content', [fixture.ref as KnowledgeContextItem]); }}>Select evidence</button>
  <button onClick={() => { Promise.resolve(props.onCompile?.('ignored generated prompt', [fixture.ref as KnowledgeContextItem])).catch(fixture.failed); }}>Compile evidence</button>
  <button onClick={props.onClose}>Close workbench</button>
</div> }));
const scope = (canvasId = 'canvas-a') => configureSaaSCanvas({ canvasId, tenant: { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } });
beforeEach(() => {
  fixture.api.mockReset(); fixture.proposal.mockReset(); fixture.failed.mockReset(); scope();
  fixture.api.mockImplementation(async (path: string) => path.endsWith('/artifacts') || path.endsWith('/knowledge-compilations') ? { items: [] } : path.endsWith('/knowledge-compile') ? { id: 'run-a' } : {
    id: 'run-a', status: 'completed', knowledge: { items: [fixture.ref] }, pages: [{ title: 'Compiled page', kind: 'page', content: 'Cites doc-a/rev-a', sourceRevisionIds: ['rev-a'] }],
  });
  fixture.proposal.mockResolvedValue({ id: 'proposal-a' });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); });
it('loads initial artifacts immediately in StrictMode without an aborted request releasing the current request', async () => {
  const intervals = vi.spyOn(window, 'setInterval');
  const pending: { signal: AbortSignal; resolve: (result: unknown) => void; reject: (cause: Error) => void }[] = [];
  fixture.api.mockImplementation((_path: string, init?: RequestInit) => new Promise((resolve, reject) => {
    pending.push({ signal: init?.signal as AbortSignal, resolve, reject });
  }));
  render(<StrictMode><CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" /></StrictMode>);
  expect(pending).toHaveLength(2);
  expect(pending[0]?.signal.aborted).toBe(true);
  expect(pending[1]?.signal.aborted).toBe(false);

  await act(async () => { pending[0]!.reject(new DOMException('Aborted', 'AbortError')); });
  expect((screen.getByRole('button', { name: '刷新画布产物' }) as HTMLButtonElement).disabled).toBe(true);
  const poll = intervals.mock.calls.at(-1)?.[0];
  if (typeof poll !== 'function') throw new Error('Artifact polling callback is missing');
  act(() => { poll(); });
  expect(pending).toHaveLength(2);

  await act(async () => { pending[1]!.resolve({ items: [{ id: 'artifact-a', name: 'Initial.md', runId: 'run-a', nodeId: 'node-a' }] }); });
  expect(screen.getByText('Initial.md')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: '刷新画布产物' }) as HTMLButtonElement).disabled).toBe(false);
});
it('pins revision identities before handing evidence to the task composer', async () => {
  const onTaskDraft = vi.fn(); render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={onTaskDraft} />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' }));
  fireEvent.click(screen.getByText('Select evidence'));
  expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  expect(onTaskDraft).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '清除任务知识引用' }));
  expect(canvasKnowledgeRevisionIds()).toEqual([]);
});
it('opens the integrated assistant with selected knowledge and refreshes real canvas artifacts', async () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新画布产物' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Select evidence'));
  fireEvent.click(screen.getByRole('button', { name: '执行助手' }));
  expect(screen.getByText('Managed execution · canvas-a')).toBeTruthy();
  expect(screen.getByText('Execution references: rev-a')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /OpenMaus/ })).toBeNull();
  const reads = fixture.api.mock.calls.filter(([path]) => path.endsWith('/artifacts')).length;
  fireEvent.click(screen.getByText('Produced artifact'));
  await waitFor(() => expect(fixture.api.mock.calls.filter(([path]) => path.endsWith('/artifacts'))).toHaveLength(reads + 1));
  fireEvent.click(screen.getByText('Close execution')); expect(screen.queryByRole('dialog')).toBeNull();
});
it('creates only review proposals with frozen sources and stable per-run operation IDs', async () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(fixture.proposal).toHaveBeenCalledOnce());
  expect(fixture.proposal.mock.calls[0]?.[1]).toMatchObject({ sourceRevisionIds: ['rev-a'], operationId: 'wiki-run-a-0', baseVersion: 0 });
  const post = fixture.api.mock.calls.find(([path]) => path.endsWith('/knowledge-compile'));
  expect(JSON.parse(post?.[1]?.body)).toMatchObject({ revisionIds: ['rev-a'] });
  expect(fixture.api.mock.calls.some(([path]) => path.endsWith('/accept'))).toBe(false);
  expect(await screen.findByText('已生成 1 份待审核提案。')).toBeTruthy();
});
it('rejects an output whose frozen references differ from admission', async () => {
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? {
    id: 'run-a', status: 'completed', knowledge: { items: [{ ...fixture.ref, contentHash: 'wrong-hash' }] }, pages: [{ title: 'Bad', kind: 'page', content: 'bad' }],
  } : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(fixture.failed).toHaveBeenCalled()); expect(fixture.proposal).not.toHaveBeenCalled();
});
it('allows closing a running compilation and aborts observation on scope unmount', async () => {
  let observedSignal: AbortSignal | undefined;
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? new Promise((_resolve, reject) => {
    observedSignal = init?.signal as AbortSignal;
    observedSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) : normal(path, init));
  const view = render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(observedSignal).toBeDefined());
  fireEvent.click(screen.getByText('Close workbench')); expect(screen.queryByRole('dialog')).toBeNull();
  expect(observedSignal?.aborted).toBe(false);
  view.unmount(); expect(observedSignal?.aborted).toBe(true); expect(fixture.proposal).not.toHaveBeenCalled();
});
it('does not select task knowledge in a read-only canvas even if a child calls its callback', () => {
  const onTaskDraft = vi.fn(); render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" readOnly onTaskDraft={onTaskDraft} />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Select evidence'));
  expect(canvasKnowledgeRevisionIds()).toEqual([]); expect(onTaskDraft).not.toHaveBeenCalled();
});
