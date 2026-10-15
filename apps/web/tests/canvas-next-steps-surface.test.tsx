import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument, saveDocument, type SessionNode } from '../src/canvas/canvasDoc';
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
