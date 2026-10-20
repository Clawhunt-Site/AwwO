import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createAssembleNode, createFormNode, createSessionNode, emptyDocument, saveDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

// The assistant says what to do next once the canvas has something to do, without being asked.
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true });
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
function seed(brief: string) {
  const node = { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' } as SessionNode;
  const contract = node.contract!;
  saveDocument({ ...emptyDocument(), nodes: [{ ...node, contract: { ...contract, inputs: contract.inputs.map(field => field.id === 'brief' ? { ...field, value: brief } : field) } }], view: { x: 0, y: 0, scale: 1 } });
}

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

describe('the assistant’s next steps on the canvas', () => {
  it('marks the closed toggle for a node a run would refuse, and opens that node on its inputs in one click', async () => {
    seed('');
    render(<CanvasSurface />);
    expect(toggle()).toHaveClass('has-hint');
    expect(toggle()).toHaveAttribute('title', '助手有建议');
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    expect(next.getByText('运行前还需要你来定 1 项：')).toBeVisible();
    const row = within(next.getByRole('listitem'));
    expect(row.getByText('「已有节点」')).toBeVisible();
    expect(row.getByText('任务要求')).toBeVisible();
    // A local canvas counts no calls, so nothing is said about them.
    expect(next.getByText('填好后就能运行整张画布。')).toBeVisible();
    expect(next.queryByText('本地检查，不用次数')).toBeNull();
    fireEvent.click(row.getByRole('button', { name: '去补全「已有节点」' }));
    // The value is filled in where it lives: the node opens on its input drawer (its settings have no input fields).
    const drawer = await screen.findByRole('region', { name: '输入表单' });
    expect(drawer.closest('[data-node-id]')).toHaveAttribute('data-lod', 'focus');
    expect(screen.queryByRole('dialog', { name: /已有节点/ })).toBeNull();
  });

  it('offers to run a ready canvas that never ran, without marking the toggle', () => {
    seed('为二年级学生设计游戏化学习知识库');
    render(<CanvasSurface />);
    expect(toggle()).not.toHaveClass('has-hint');
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    expect(next.getByText('画布已经搭好，还没有运行过。')).toBeVisible();
    expect(next.getByRole('button', { name: '运行整张画布' })).toHaveClass('is-primary');
  });

  it('runs the nodes left from a form that never ran, its fields as they are now, as a cloud run does', async () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: '需求表单', fields: [{ id: 'topic', label: '主题', value: '春季促销' }] };
    const agent = (id: string, x: number, patch: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x, y: 0 }), id, title: id,
      runtime: 'claude_local', binding: { companyId: 'c1', agentId: `a-${id}`, agentName: id }, issueId: `iss-${id}`, ...patch });
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [form, agent('writer', 600), agent('editor', 1200, { lastOutput: { text: '已完成', at: 1, source: 'run' } })],
      edges: [{ id: 'brief->writer', fromNode: 'brief', fromPort: 'data', toNode: 'writer', toPort: 'context', dataType: 'text' }] });
    // A turn's message is posted and stays open, as a real one does while the agent works.
    vi.stubGlobal('fetch', vi.fn((url: unknown) => String(url).endsWith('/prepare') ? Promise.resolve({ ok: true, status: 200 })
      : String(url).includes('/messages') ? new Promise(() => {}) : Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
    render(<CanvasSurface />);
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    expect(next.getByText('还有 1 个节点没有结果。')).toBeVisible();
    fireEvent.click(next.getByRole('button', { name: '运行剩下的 1 个节点' }));
    // The form is out of the run's scope; the writer still gets its fields, rather than being blocked for want of them.
    const sent = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes('/messages') && (init as RequestInit | undefined)?.method === 'POST');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(String((sent()[0][1] as RequestInit).body)).toContain('主题: 春季促销');
  });

  it('says what is left cannot run here when told to go on, and starts nothing (Codex review)', async () => {
    const contract = (inputs: Array<[string, 'text' | 'file']>, output: 'markdown' | 'file') => ({ version: 1 as const,
      inputs: inputs.map(([id, type]) => ({ id, label: id, type, required: true, value: id === 'brief' ? 'Do it' : '' })),
      outputs: [{ id: output === 'file' ? 'page' : 'result', label: 'out', type: output, required: true, value: '' }] });
    const writer: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'writer', title: 'writer', contract: contract([['brief', 'text']], 'markdown'),
      lastOutput: { text: 'done', at: 1, source: 'run' } };
    // A page delivered as a file: the cloud stores it; this device cannot.
    const page = { ...createAssembleNode({ x: 600, y: 0 }), id: 'page', title: 'page', contract: contract([['module', 'text']], 'file') };
    const reader: SessionNode = { ...createSessionNode('llm', { x: 1200, y: 0 }), id: 'reader', title: 'reader', contract: contract([['brief', 'text'], ['page', 'file']], 'markdown') };
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [writer, page, reader], edges: [
      { id: 'w->p', fromNode: 'writer', fromPort: 'out:result', toNode: 'page', toPort: 'in:module', dataType: 'text' },
      { id: 'p->r', fromNode: 'page', fromPort: 'out:page', toNode: 'reader', toPort: 'in:page', dataType: 'file' }] });
    render(<CanvasSurface />);
    fireEvent.click(toggle());
    const requests = vi.mocked(fetch).mock.calls.length;
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '继续运行' } });
    fireEvent.click(sidebar().getByRole('button', { name: '修改画布' }));
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText('剩下的节点在这台设备上运行不了：它们要用到剪辑，或交付文件的装配节点，这些只有在云端运行时才能生成。')).toBeVisible());
    expect(log.queryByText(/所有节点都已经有结果了/)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(vi.mocked(fetch).mock.calls.slice(requests).filter(([url]) => String(url).includes('/messages'))).toEqual([]);
  });

  it('answers “what is missing?” from the canvas without sending anything', async () => {
    seed('');
    render(<CanvasSurface />);
    fireEvent.click(toggle());
    const requests = vi.mocked(fetch).mock.calls.length;
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '现在缺什么？' } });
    fireEvent.click(sidebar().getByRole('button', { name: '修改画布' }));
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText('现在缺什么？')).toBeVisible());
    expect(log.getByText('运行前还需要你来定 1 项：「已有节点」的任务要求。填好后就能运行整张画布。')).toBeVisible();
    expect(box).toHaveValue('');
    expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
  });
});
