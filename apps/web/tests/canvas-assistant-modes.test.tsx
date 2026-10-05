import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument, loadDocumentWithStatus, saveDocument } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions } from '../src/canvas/sessions';

// The hosted app hands the canvas assistant a 直接执行 mode; these check how the canvas places it.
const execution = <div><p>任务对话</p></div>;
const plan: CanvasPlan = { version: 1, summary: '已添加一个节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '新节点' }] };
const seedNode = () => saveDocument({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' }], view: { x: 0, y: 0, scale: 1 } });
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).queryByRole('button', { name: '画布助手', exact: true });
const sidebar = () => document.querySelector('.awwo-planner-sidebar') as HTMLElement | null;

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

describe('the canvas assistant with a 直接执行 mode', () => {
  it('opens on planning, switches to the task conversation on request and remembers the choice while the canvas is open', () => {
    seedNode();
    render(<CanvasSurface assistantExecution={execution} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    const panel = within(sidebar()!);
    expect(panel.getByRole('textbox', { name: '画布需求' })).toBeVisible();
    fireEvent.click(panel.getByRole('button', { name: '直接执行' }));
    expect(panel.getByText('任务对话')).toBeVisible();
    expect(panel.queryByRole('textbox', { name: '画布需求' })).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: '关闭画布助手' }));
    expect(sidebar()).toBeNull();
    fireEvent.click(toggle()!);
    expect(within(sidebar()!).getByText('任务对话')).toBeVisible();
    // Back to planning only by choosing it.
    fireEvent.click(within(sidebar()!).getByRole('button', { name: '编排画布' }));
    expect(within(sidebar()!).getByRole('textbox', { name: '画布需求' })).toBeVisible();
  });

  it('on an empty canvas, opens the task conversation beside the welcome and returns to the welcome for planning', () => {
    render(<CanvasSurface assistantExecution={execution} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeVisible();
    expect(toggle()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '或者直接让助手完成一个任务' }));
    expect(within(sidebar()!).getByText('任务对话')).toBeVisible();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(sidebar()!).getByRole('button', { name: '编排画布' }));
    expect(sidebar()).toBeNull();
    expect(toggle()).toBeNull();
    expect(screen.getByRole('textbox', { name: '画布需求' })).toBeVisible();
  });

  it('brings the panel back to planning when a plan is applied', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={execution} planRequest={planRequest} />);
    fireEvent.click(screen.getByRole('button', { name: '或者直接让助手完成一个任务' }));
    expect(within(sidebar()!).getByText('任务对话')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '加一个节点' } });
    fireEvent.click(screen.getByRole('button', { name: '生成画布', exact: true }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    await waitFor(() => expect(within(sidebar()!).getByRole('button', { name: '编排画布' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(sidebar()!).queryByText('任务对话')).toBeNull();
  });

  it('lets a read-only canvas review its tasks, with no planning and no switch', () => {
    seedNode();
    render(<CanvasSurface readOnly assistantExecution={execution} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    const panel = within(sidebar()!);
    expect(panel.getByText('任务对话')).toBeVisible();
    expect(panel.queryByRole('group', { name: '助手模式' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '画布需求' })).toBeNull();
  });

  it('lets a viewer open the task history even on an empty canvas', () => {
    render(<CanvasSurface readOnly assistantExecution={execution} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle()!);
    expect(within(sidebar()!).getByText('任务对话')).toBeVisible();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the desktop canvas (no execution) as it was: planning only, and nothing for a read-only canvas', () => {
    seedNode();
    const { unmount } = render(<CanvasSurface planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(within(sidebar()!).queryByRole('group', { name: '助手模式' })).toBeNull();
    unmount();
    render(<CanvasSurface readOnly planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(toggle()).toBeNull();
  });
});
