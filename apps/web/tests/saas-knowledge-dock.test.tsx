import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasKnowledgeDock } from '../src/saas/CanvasKnowledgeDock';
import { SaaSApiError } from '../src/saas/api';
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
vi.mock('../src/saas/ManagedExecutionPanel', () => ({ ManagedExecutionPanel: (props: ManagedExecutionPanelProps) => <div>
  <p>Managed execution · {props.canvasId}</p><p>Execution references: {props.knowledgeReferences?.map(item => item.revisionId).join(', ')}</p>
  <button onClick={props.onClose}>Close execution</button>
  <button onClick={() => { void props.onImported?.({} as never); }}>Import artifact</button>
</div> }));
vi.mock('../src/saas/KnowledgeWorkbench', () => ({ KnowledgeWorkbench: (props: KnowledgeWorkbenchProps) => <div>
  <p>Artifacts: {props.artifacts?.map(item => item.title).join(', ')}</p>
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
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reads canvas artifacts only while the knowledge map is open, never by polling', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    fixture.api.mockImplementation(async (path: string) => path.endsWith('/artifacts') ? { items: [{ id: 'artifact-a', name: 'Initial.md', runId: 'run-a', nodeId: 'node-a' }] } : { items: [] });
    const reads = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith('/artifacts')).length;
    render(<StrictMode><CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" /></StrictMode>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '知识地图' }));
    expect(await screen.findByText('Artifacts: Initial.md')).toBeTruthy();
    expect(reads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toBe(1);
    // Reopening reads again, so artifacts produced in the meantime are offered.
    fireEvent.click(screen.getByText('Close workbench'));
    fireEvent.click(screen.getByRole('button', { name: '知识地图' }));
    await waitFor(() => expect(reads()).toBe(2));
  } finally { vi.useRealTimers(); }
});
it('abandons an artifact read when the knowledge map closes before it answers', async () => {
  const signals: AbortSignal[] = [];
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/artifacts') ? new Promise(() => { signals.push(init?.signal as AbortSignal); }) : Promise.resolve({ items: [] }));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' }));
  await waitFor(() => expect(signals).toHaveLength(1));
  fireEvent.click(screen.getByText('Close workbench'));
  expect(signals[0]?.aborted).toBe(true);
  expect(live('alert')).toBe('');
  expect(mapButton()).toHaveAccessibleName('知识地图');
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
it('opens the integrated assistant with the selected knowledge', () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '知识地图' })); fireEvent.click(screen.getByText('Select evidence'));
  fireEvent.click(screen.getByRole('button', { name: '执行助手' }));
  expect(screen.getByText('Managed execution · canvas-a')).toBeTruthy();
  expect(screen.getByText('Execution references: rev-a')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /OpenMaus/ })).toBeNull();
  fireEvent.click(screen.getByText('Close execution')); expect(screen.queryByRole('dialog')).toBeNull();
});
const mapButton = () => screen.getByRole('button', { name: /^知识地图/ });
const live = (kind: 'status' | 'alert') => document.querySelector(`.awwo-knowledge-tools > [aria-live="${kind === 'alert' ? 'assertive' : 'polite'}"]`)?.textContent ?? '';
const inMap = () => within(screen.getByRole('dialog', { name: '知识地图工作台' }));
it('pins evidence for the task without a notice over the canvas: the references chip says so', () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={vi.fn()} />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Select evidence'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('已引用 1 份知识')).toBeTruthy();
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('status')).toBe(''); expect(live('alert')).toBe('');
  expect(document.querySelector('.awwo-knowledge-tool-mark')).toBeNull();
});
it('keeps a failed map read inside the map and clears it when the map opens again', async () => {
  let fail = true;
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/artifacts') && fail) throw new Error('Artifact list unavailable');
    return normal(path, init);
  });
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton());
  expect(await inMap().findByRole('alert')).toHaveTextContent('Artifact list unavailable');
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('alert')).toBe('');
  fail = false;
  fireEvent.click(mapButton());
  await waitFor(() => expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith('/artifacts'))).toHaveLength(2));
  expect(inMap().queryByRole('alert')).toBeNull();
  // A later outcome is shown on its own, not hidden behind the earlier read failure.
  fireEvent.click(screen.getByText('Compile evidence'));
  expect(await inMap().findByText('已生成 1 份待审核提案。')).toBeTruthy();
});
it('marks the map button while a compilation runs on after the map closed, then shows its failure in the map', async () => {
  let finish: (value: unknown) => void = () => {};
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? new Promise(resolve => { finish = resolve; }) : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  expect(await inMap().findByRole('status')).toHaveTextContent('模型正在整理资料');
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图（正在整理资料）');
  expect(document.querySelector('.awwo-knowledge-tool-mark')).toHaveClass('is-busy');
  expect(live('status')).toContain('模型正在整理资料');
  await act(async () => { finish({ id: 'run-a', status: 'failed', error: 'Model gateway refused the request' }); });
  await waitFor(() => expect(mapButton()).toHaveAccessibleName('知识地图（整理未完成，打开查看原因）'));
  expect(document.querySelector('.awwo-knowledge-tool-mark')).toHaveClass('is-error');
  expect(mapButton()).toHaveAttribute('title', '知识地图：Model gateway refused the request');
  expect(live('alert')).toBe('Model gateway refused the request'); expect(live('status')).toBe('');
  fireEvent.click(mapButton());
  expect(inMap().getByRole('alert')).toHaveTextContent('Model gateway refused the request');
  expect(live('alert')).toBe('Model gateway refused the request');
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('alert')).toBe('');
  expect(document.querySelector('.awwo-knowledge-tool-mark')).toBeNull();
  expect(fixture.proposal).not.toHaveBeenCalled();
});
it('marks a result that arrives after the map closed until the map is opened, whatever else is opened first', async () => {
  let finish: (value: unknown) => void = () => {};
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? new Promise(resolve => { finish = resolve; }) : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await inMap().findByRole('status');
  fireEvent.click(screen.getByText('Close workbench'));
  await act(async () => { finish({ id: 'run-a', status: 'completed', knowledge: { items: [fixture.ref] }, pages: [{ title: 'Compiled page', kind: 'page', content: 'Cites doc-a/rev-a', sourceRevisionIds: ['rev-a'] }] }); });
  await waitFor(() => expect(mapButton()).toHaveAccessibleName('知识地图（有新的整理结果）'));
  expect(live('status')).toBe('已生成 1 份待审核提案。');
  fireEvent.click(screen.getByRole('button', { name: '执行助手' })); fireEvent.click(screen.getByText('Close execution'));
  expect(mapButton()).toHaveAccessibleName('知识地图（有新的整理结果）');
  fireEvent.click(mapButton());
  expect(inMap().getByRole('status')).toHaveTextContent('已生成 1 份待审核提案。');
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  fireEvent.click(mapButton());
  expect(inMap().queryByText('已生成 1 份待审核提案。')).toBeNull();
});
it('shows a new compilation as running from its first request on, not as the previous outcome', async () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  expect(await inMap().findByText('已生成 1 份待审核提案。')).toBeTruthy();
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/knowledge-compile') ? new Promise(() => {}) : normal(path, init));
  fireEvent.click(screen.getByText('Compile evidence'));
  expect(inMap().getByRole('status')).toHaveTextContent('模型正在整理资料');
  expect(inMap().queryByText('已生成 1 份待审核提案。')).toBeNull();
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAttribute('title', '知识地图：模型正在整理资料；完成后生成待审核提案。');
});
it('says nothing again when the map is opened and closed during a run', async () => {
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? new Promise(() => {}) : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await inMap().findByRole('status');
  fireEvent.click(screen.getByText('Close workbench'));
  const spoken = live('status');
  expect(spoken).toContain('模型正在整理资料');
  fireEvent.click(mapButton());
  expect(live('status')).toBe(spoken);
  fireEvent.click(screen.getByText('Close workbench'));
  expect(live('status')).toBe(spoken);
});
it('leaves a failure to the workbench that is still showing and withdraws the progress notice', async () => {
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? { id: 'run-a', status: 'failed', error: 'Model gateway refused the request' } : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(fixture.failed).toHaveBeenCalledOnce());
  expect(inMap().queryByRole('status')).toBeNull();
  expect(inMap().queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('status')).toBe(''); expect(live('alert')).toBe('');
});
it('creates only review proposals with frozen sources and stable per-run operation IDs', async () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(fixture.proposal).toHaveBeenCalledOnce());
  expect(fixture.proposal.mock.calls[0]?.[1]).toMatchObject({ sourceRevisionIds: ['rev-a'], operationId: 'wiki-run-a-0', baseVersion: 0 });
  const post = fixture.api.mock.calls.find(([path]) => path.endsWith('/knowledge-compile'));
  expect(JSON.parse(post?.[1]?.body)).toMatchObject({ revisionIds: ['rev-a'] });
  expect(fixture.api.mock.calls.some(([path]) => path.endsWith('/accept'))).toBe(false);
  expect(await inMap().findByText('已生成 1 份待审核提案。')).toBeTruthy();
  fireEvent.click(screen.getByText('Close workbench'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('status')).toBe('');
});
it('rejects an output whose frozen references differ from admission', async () => {
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? {
    id: 'run-a', status: 'completed', knowledge: { items: [{ ...fixture.ref, contentHash: 'wrong-hash' }] }, pages: [{ title: 'Bad', kind: 'page', content: 'bad' }],
  } : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
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
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await waitFor(() => expect(observedSignal).toBeDefined());
  fireEvent.click(screen.getByText('Close workbench')); expect(screen.queryByRole('dialog')).toBeNull();
  expect(observedSignal?.aborted).toBe(false);
  view.unmount(); expect(observedSignal?.aborted).toBe(true); expect(fixture.proposal).not.toHaveBeenCalled();
});
it('does not select task knowledge in a read-only canvas even if a child calls its callback', () => {
  const onTaskDraft = vi.fn(); render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" readOnly onTaskDraft={onTaskDraft} />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Select evidence'));
  expect(canvasKnowledgeRevisionIds()).toEqual([]); expect(onTaskDraft).not.toHaveBeenCalled();
});
it('adds no notice of its own when the execution assistant saves an artifact, which the assistant confirms itself', () => {
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(screen.getByRole('button', { name: '执行助手' }));
  fireEvent.click(screen.getByText('Import artifact'));
  fireEvent.click(screen.getByText('Close execution'));
  expect(mapButton()).toHaveAccessibleName('知识地图');
  expect(live('status')).toBe('');
});
it('translates an API failure from its error code', async () => {
  let finish: (cause: unknown) => void = () => {};
  const normal = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/compilations/run-a') ? new Promise((_resolve, reject) => { finish = reject; }) : normal(path, init));
  render(<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" />);
  fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Compile evidence'));
  await inMap().findByRole('status');
  fireEvent.click(screen.getByText('Close workbench'));
  await act(async () => { finish(new SaaSApiError(403, 'forbidden', 'Forbidden by policy')); });
  await waitFor(() => expect(live('alert')).toBe('你没有执行此操作的权限。'));
  expect(mapButton()).toHaveAttribute('title', '知识地图：你没有执行此操作的权限。');
});

describe('in a narrow canvas bar', () => {
  const geometry = { toolsRight: 400, runLeft: 900, end: 1000 };
  const observers: { callback: () => void }[] = [];
  const box = (left: number, right: number, top = 0, bottom = 32) => ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const resize = () => act(() => { observers.forEach(observer => observer.callback()); });
  let width: PropertyDescriptor | undefined;
  beforeEach(() => {
    Object.assign(geometry, { toolsRight: 400, runLeft: 900, end: 1000 }); observers.length = 0;
    vi.stubGlobal('ResizeObserver', class { constructor(public callback: () => void) { observers.push(this); } observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('awwo-knowledge-tools')) return box(100, geometry.toolsRight);
      if (this.classList.contains('awwo-run-slot')) return box(geometry.runLeft, geometry.runLeft + 80);
      if (this.classList.contains('awwo-canvas-bar') || this.classList.contains('awwo-workspace')) return box(0, geometry.end, 0, 44);
      return box(0, 0);
    });
    // Each tool label is 101px wide whether shown or hidden, so the labels add 2 × (101 + 9) = 220px;
    // a references label adds 90 + 9 more.
    width = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) {
      return this.parentElement?.classList.contains('awwo-knowledge-tool') ? 101 : this.classList.contains('awwo-knowledge-references-label') ? 90 : 0;
    } });
  });
  afterEach(() => { if (width) Object.defineProperty(Element.prototype, 'scrollWidth', width); });
  function Bar({ toggle = false }: { toggle?: boolean }) {
    return <div className="awwo-workspace"><div className="awwo-canvas-bar">{toggle && <button type="button" className="awwo-assistant-toggle">画布助手</button>}<CanvasKnowledgeDock tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={vi.fn()} /><div className="awwo-run-slot" /></div></div>;
  }

  it('drops the tool labels once the room before the run controls runs out, and restores them only with room to spare', () => {
    const { container } = render(<Bar />);
    const tools = () => container.querySelector('.awwo-knowledge-tools')!;
    expect(tools()).not.toHaveClass('is-compact');
    geometry.runLeft = 410; resize();
    expect(tools()).toHaveClass('is-compact');
    expect(mapButton()).toHaveAttribute('title', '知识地图');
    // Icons alone are 220px narrower; labels come back only when they would leave 48px to spare.
    geometry.toolsRight = 180; geometry.runLeft = 440; resize();
    expect(tools()).toHaveClass('is-compact');
    geometry.runLeft = 460; resize();
    expect(tools()).not.toHaveClass('is-compact');
  });
  it('shrinks the references chip to a count with the labels, and counts its full text before restoring them', () => {
    const { container } = render(<Bar />);
    const tools = () => container.querySelector('.awwo-knowledge-tools')!;
    fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Select evidence'));
    geometry.runLeft = 410; resize();
    expect(tools()).toHaveClass('is-compact');
    const chip = container.querySelector('.awwo-knowledge-references')!;
    expect(chip).toHaveAttribute('title', '已引用 1 份知识');
    expect(chip.querySelector('.awwo-knowledge-references-label')).toHaveTextContent('已引用 1 份知识');
    expect(chip.querySelector('.awwo-knowledge-references-count')).toHaveTextContent('1');
    expect(chip.querySelector('.awwo-knowledge-references-count')).toHaveAttribute('aria-hidden', 'true');
    // 220px of tool labels and 99px of references text, plus 48px to spare.
    geometry.toolsRight = 180; geometry.runLeft = 180 + 300; resize();
    expect(tools()).toHaveClass('is-compact');
    geometry.runLeft = 180 + 370; resize();
    expect(tools()).not.toHaveClass('is-compact');
  });
  it('re-checks before painting a references chip that only fits beside icons', () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.classList.contains('awwo-knowledge-tools')) return box(100, this.querySelector('.awwo-knowledge-references') ? 450 : 300);
      if (this.classList.contains('awwo-run-slot')) return box(460, 540);
      if (this.classList.contains('awwo-canvas-bar') || this.classList.contains('awwo-workspace')) return box(0, 1000, 0, 44);
      return box(0, 0);
    });
    const { container } = render(<Bar />);
    const tools = () => container.querySelector('.awwo-knowledge-tools')!;
    expect(tools()).not.toHaveClass('is-compact');
    fireEvent.click(mapButton()); fireEvent.click(screen.getByText('Select evidence'));
    // No ResizeObserver callback ran: the dock's own layout effect re-checked before paint.
    expect(tools()).toHaveClass('is-compact');
  });
  it('re-checks the labels when a neighbour goes away without anything being resized (the last node is deleted)', async () => {
    geometry.runLeft = 410;
    const { container, rerender } = render(<Bar toggle />);
    const tools = () => container.querySelector('.awwo-knowledge-tools')!;
    expect(tools()).toHaveClass('is-compact');
    Object.assign(geometry, { toolsRight: 180, runLeft: 900 });
    await act(async () => { rerender(<Bar />); });
    expect(tools()).not.toHaveClass('is-compact');
  });
  it('drops the labels when they push the tools onto a row of their own in a wrapping bar', () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.classList.contains('awwo-assistant-toggle')) return box(16, 100, 0, 32);
      if (this.classList.contains('awwo-knowledge-tools')) return box(16, 343, 40, 72);
      // On phones the run controls always take a full row of their own, which is not "pushed down".
      if (this.classList.contains('awwo-run-slot')) return box(0, 414, 80, 112);
      if (this.classList.contains('awwo-canvas-bar') || this.classList.contains('awwo-workspace')) return box(0, 414, 0, 120);
      return box(0, 0);
    });
    const { container } = render(<Bar toggle />);
    expect(container.querySelector('.awwo-knowledge-tools')).toHaveClass('is-compact');
  });
  it('keeps icons while the run controls sit on a second row, and restores the labels once they share a row again', () => {
    let pushed = true;
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this.classList.contains('awwo-knowledge-tools')) return box(100, 180, 0, 32);
      if (this.classList.contains('awwo-run-slot')) return pushed ? box(700, 900, 40, 72) : box(700, 900, 0, 32);
      if (this.classList.contains('awwo-canvas-bar') || this.classList.contains('awwo-workspace')) return box(0, 1000, 0, 80);
      return box(0, 0);
    });
    const { container } = render(<Bar />);
    const tools = () => container.querySelector('.awwo-knowledge-tools')!;
    expect(tools()).toHaveClass('is-compact');
    // The rest of the first row is free, but restoring the labels would not bring the run controls back.
    resize();
    expect(tools()).toHaveClass('is-compact');
    pushed = false; resize();
    expect(tools()).not.toHaveClass('is-compact');
  });
  it('brings the labels back after the bar was first laid out with no width (a hidden tab or pane)', () => {
    Object.assign(geometry, { toolsRight: 0, runLeft: 0, end: 0 });
    const { container } = render(<Bar />);
    expect(container.querySelector('.awwo-knowledge-tools')).toHaveClass('is-compact');
    Object.assign(geometry, { toolsRight: 180, runLeft: 900, end: 1000 }); resize();
    expect(container.querySelector('.awwo-knowledge-tools')).not.toHaveClass('is-compact');
  });
});
