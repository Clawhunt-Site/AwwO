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
  it('marks the closed toggle for a node a run would refuse, and opens that node’s settings in one click', async () => {
    seed('');
    render(<CanvasSurface />);
    expect(toggle()).toHaveClass('has-hint');
    expect(toggle()).toHaveAttribute('title', '助手有建议');
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    expect(next.getByText(/「已有节点」还缺 任务要求，补全后画布才能运行。/)).toBeVisible();
    fireEvent.click(next.getByRole('button', { name: '去补全「已有节点」' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /已有节点/ })).toBeVisible());
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
});
