import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, LEGACY_WORKFLOW_STORAGE_KEY, createFormNode, createSessionNode, loadDocumentWithStatus, type CanvasDocument } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY } from '../src/canvas/runJournal';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
function seed(): CanvasDocument {
  const form = { ...createFormNode({ x: 20, y: 30 }), id: 'brief', title: '客户需求' };
  const agent = { ...createSessionNode('llm', { x: 600, y: 30 }), id: 'agent', title: '方案顾问',
    binding: { companyId: 'tenant', agentId: 'bound-agent', agentName: '顾问' }, issueId: 'current',
    contract: { version: 1 as const, inputs: [], outputs: [{ id: 'summary', label: '交付说明', type: 'markdown' as const, required: true, value: '未发布修改' }] },
    threads: [{ id: 'old', title: '历史 Session', issueId: 'old-issue', preview: '历史预览', draft: '保留的历史草稿', createdAt: 1,
      lastOutput: { text: JSON.stringify({ summary: '## 历史交付\n\n已验收的方案。' }), at: 1 } }],
  };
  const target = { ...createSessionNode('llm', { x: 1000, y: 30 }), id: 'target', title: '下游会话' };
  return { version: 2, updatedAt: 1, nodes: [form, agent, target],
    edges: [{ id: 'wire', fromNode: 'brief', fromPort: 'data', toNode: 'target', toPort: 'context', dataType: 'text' }],
    waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  if (init?.method && init.method !== 'GET') throw new Error('Unexpected write request');
  const url = String(input);
  if (url.endsWith('/messages')) return { ok: true, json: async () => ({ complete: true, messages: [{ authorAgentId: 'bound-agent', body: url.includes('old-issue') ? '从服务端读取的历史回复' : '本次服务端回复' }] }) };
  if (url.endsWith('/conversations/tenant')) return { ok: true, json: async () => ({ conversations: [] }) };
  return { ok: true, json: async () => ({ companies: [], available: false }) };
});
beforeEach(() => {
  cleanup(); vi.restoreAllMocks(); resetAllSessions(); localStorage.clear(); fetchMock.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub); vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} });
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mod = { ctrlKey: true, bubbles: true, cancelable: true };

describe('original canvas reader mode', () => {
  it('keeps graph, inspector, deliveries and server history without writing or recovering a run', async () => {
    const before = localStorage.getItem(CANVAS_STORAGE_KEY);
    localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify({ version: 1, id: 'old-run', startedAt: 1, scope: ['agent'], nodes: {
      agent: { nodeId: 'agent', threadId: 'default', companyId: 'tenant', agentId: 'bound-agent', issueId: 'current', runId: 'server-run', state: 'running' },
    } }));
    const write = vi.spyOn(localStorage, 'setItem'); const remove = vi.spyOn(localStorage, 'removeItem');
    const planner = vi.fn(); const locks = vi.spyOn(navigator.locks, 'request');
    const { container } = render(<CanvasSurface readOnly storageMode="cloud" planRequest={planner} />);
    expect(container.querySelector('.awwo-local-tag')).toHaveTextContent('云端画布 · 只读');
    expect(screen.getByTestId('canvas-tile-brief')).toHaveTextContent('客户需求');
    expect(screen.getByTestId('canvas-tile-agent')).toHaveTextContent('方案顾问');
    expect(container.querySelectorAll('.canvas-wire').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /停止/ })).toBeNull();
    expect(screen.getByRole('button', { name: '添加 Agent', exact: true })).toBeDisabled();
    expect(container.querySelector('.awwo-planner-sidebar')).toBeNull();
    expect([...container.querySelectorAll('.canvas-port')].every(port => (port as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '打开 方案顾问', exact: true }));
    const tile = within(screen.getByTestId('canvas-tile-agent'));
    expect(await tile.findByText('本次服务端回复')).toBeTruthy();
    expect(tile.getByRole('button', { name: '新建 Session' })).toBeDisabled();
    fireEvent.click(tile.getByRole('button', { name: '打开 历史 Session' }));
    expect(await tile.findByText('从服务端读取的历史回复')).toBeTruthy();
    expect(tile.getByRole('button', { name: '打开 历史 Session' })).toHaveAttribute('aria-current', 'page');
    expect(tile.getByRole('textbox')).toBeDisabled();
    fireEvent.change(tile.getByRole('textbox'), { target: { value: '不能写入的草稿' } });
    fireEvent.keyDown(tile.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
    fireEvent.click(tile.getByRole('button', { name: '展开交付物' }));
    expect(tile.getByRole('heading', { name: '历史交付' })).toBeTruthy();
    fireEvent.click(tile.getByText('编辑输出表单'));
    expect(tile.getByRole('button', { name: '发布输出' })).toBeDisabled();
    fireEvent.click(tile.getByRole('button', { name: '发布输出' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    const inspector = container.querySelector('.canvas-inspector')!;
    expect(inspector).toBeTruthy();
    expect(inspector.textContent).not.toContain('图运行中');
    expect([...inspector.querySelectorAll('input, textarea, select')].every(el => (el as HTMLInputElement).disabled)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-brief'), { button: 0, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 }); fireEvent.pointerUp(window);
    for (const event of [{ key: 'Delete', code: 'Delete' }, { key: 'z', code: 'KeyZ', ...mod },
      { key: 'z', code: 'KeyZ', shiftKey: true, ...mod }, { key: '!', code: 'Digit1', shiftKey: true, ...mod }]) fireEvent.keyDown(document, event);
    const viewport = container.querySelector('.canvas-viewport')!;
    fireEvent.doubleClick(viewport, { clientX: 400, clientY: 300 });
    fireEvent.contextMenu(viewport, { clientX: 400, clientY: 300 });
    fireEvent.drop(viewport, { dataTransfer: { getData: () => JSON.stringify({ kind: 'llm' }) } });
    fireEvent.keyDown(document, { key: 'p', code: 'KeyP', ...mod });
    const palette = container.querySelector('.canvas-cmdbar-overlay')!;
    expect(palette).toBeTruthy();
    expect(palette.textContent).not.toMatch(/删除所选|保存路标|运行整张图|添加.*会话/);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    act(() => appendTurn('agent', { role: 'agent', text: '后台缓存新预览' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(before);
    expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(locks).not.toHaveBeenCalled(); expect(planner).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([input, init]) => (!init?.method || init.method === 'GET') && !String(input).includes('planner') && !String(input).includes('operations'))).toBe(true);
  });
  it('does not migrate or back up a corrupt reader snapshot', () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, '{bad snapshot');
    localStorage.setItem(LEGACY_WORKFLOW_STORAGE_KEY, '{old corrupt document');
    const write = vi.spyOn(localStorage, 'setItem');
    expect(loadDocumentWithStatus({ readOnly: true }).status).toBe('corrupt');
    render(<CanvasSurface readOnly />);
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /创建产品研发画布/ })).toBeDisabled();
  });
  it('retains editing, persistence and undo for an editor on the same graph', async () => {
    render(<CanvasSurface />);
    const tile = within(screen.getByTestId('canvas-tile-target'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '删除', exact: true }));
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-target')).toBeNull());
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ...mod });
    expect(screen.getByTestId('canvas-tile-target')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes).toHaveLength(3);
    expect(screen.getByRole('button', { name: /运行图/ })).not.toBeDisabled();
  });
});
