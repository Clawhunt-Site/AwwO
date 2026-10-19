// A customer's report (2026-10-16): with the conversation in the side panel, nothing on the canvas said whether the
// assistant was arranging it or doing the work elsewhere, and an empty canvas still showing its example looked stuck.
// The stage now says what the assistant is doing, and the example says it is one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { StageActivity, showsStageLine } from '../src/canvas/StageActivity';
import { executionHost } from '../src/saas/AssistantExecution';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import type { AssistantExecutionHost, AssistantRoute, AssistantRouteDecision, AssistantRouteRequest } from '../src/canvas/assistantRouting';
import { emptyDocument, saveDocument } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import { savePlanningConversation, type requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions } from '../src/canvas/sessions';

const time = '2026-10-16T06:40:00Z';
const plan: CanvasPlan = { version: 1, summary: '已添加一个节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '新节点' }] };
const seedNode = () => saveDocument({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' }], view: { x: 0, y: 0, scale: 1 } });
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true });
const panel = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
const empty = () => document.querySelector('.awwo-empty') as HTMLElement | null;
const pill = () => document.querySelector('.awwo-stage-activity.is-compact');
const routeTo = (route: AssistantRoute) => vi.fn(async (_request: AssistantRouteRequest, _signal: AbortSignal): Promise<AssistantRouteDecision> => ({ route }));
// A router that reads every message as a correction toward `route`, and the correction these tests send.
const correcting = (route: AssistantRoute) => vi.fn(async (_request: AssistantRouteRequest, _signal: AbortSignal): Promise<AssistantRouteDecision> => ({ route, redirect: true }));
const CORRECTION = '还是放到画布上吧';
const sendCorrection = () => {
  fireEvent.change(panel().getByRole('textbox', { name: '画布需求' }), { target: { value: CORRECTION } });
  fireEvent.click(panel().getByRole('button', { name: '发送' }));
};
const taskConversation = () => savePlanningConversation({ draft: '', messages: [
  { id: 'turn-1-user', role: 'user', content: '做一个专属游戏', route: 'execute' },
  { id: 'turn-1-task', role: 'assistant', content: '', route: 'execute', taskId: 'task-1' }] });

function fakeHost(state: { running: boolean }) {
  const host: AssistantExecutionHost = {
    readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(),
    start: vi.fn(async () => 'task-2'),
    stop: vi.fn(async () => { state.running = false; }),
    finished: () => !state.running,
    running: () => state.running,
    renderTask: id => <p>任务卡片 {id}</p>,
    renderEarlier: () => null,
    renderNotices: () => null,
    settings: null,
  };
  return host;
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

describe('the stage says what the canvas assistant is doing', () => {
  it('says on an empty canvas that a direct task left it as it is, in place of the example, with no way to pick by hand', async () => {
    taskConversation();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={fakeHost({ running: false })} routeAssistant={correcting('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle());
    const stage = within(empty()!);
    expect(stage.getByText('画布上还没有节点')).toBeVisible();
    expect(stage.getByText('直接执行的任务不改画布，结果都在对话里。')).toBeVisible();
    expect(stage.queryByText('把想法，交给一组 Agent。')).toBeNull();
    expect(document.querySelector('.awwo-empty-diagram')).toBeNull();
    expect(document.querySelector('.awwo-stage-activity button')).toBeNull();
    // Said in the conversation, the request goes to the planner with the correction after it.
    sendCorrection();
    await waitFor(() => expect(planRequest).toHaveBeenCalled());
    expect(planRequest.mock.calls[0][0]).toBe(`做一个专属游戏

${CORRECTION}`);
  });

  it('says a direct task is under way, and leaves stopping it to the conversation, beside the task', async () => {
    taskConversation();
    const state = { running: true };
    const host = fakeHost(state);
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={correcting('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle());
    const stage = within(empty()!);
    expect(stage.getByText('正在直接执行，画布不会变化')).toBeVisible();
    expect(stage.getByText('助手在独立的工作区里做这件事，画布上不会有变化。进展和结果都在对话里。')).toBeVisible();
    expect(document.querySelector('.awwo-stage-activity button')).toBeNull();
    // A correction in the conversation stops the task and hands its request to the planner.
    sendCorrection();
    await waitFor(() => expect(planRequest).toHaveBeenCalled());
    expect(host.stop).toHaveBeenCalledExactlyOnceWith('task-1');
  });

  it('offers nothing to press on the stage while the latest task, no longer read, is not known to have ended', () => {
    taskConversation();
    // Its reading paused: not counted as under way, yet it may still run, and handing it over would stop it.
    const host = { ...fakeHost({ running: false }), finished: () => false };
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn()} />);
    fireEvent.click(toggle());
    const stage = within(empty()!);
    expect(stage.getByText('画布上还没有节点')).toBeVisible();
    expect(stage.getByText('直接执行的任务不改画布，结果都在对话里。')).toBeVisible();
    expect(document.querySelector('.awwo-stage-activity button')).toBeNull();
  });

  it('hands the canvas the request a bare 「继续」 followed, not the word', async () => {
    savePlanningConversation({ draft: '', messages: [
      { id: 'turn-1-user', role: 'user', content: '做一个专属游戏', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '', route: 'execute', taskId: 'task-1' },
      { id: 'turn-2-user', role: 'user', content: '继续', route: 'execute' },
      { id: 'turn-2-task', role: 'assistant', content: '', route: 'execute', taskId: 'task-2' }] });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={fakeHost({ running: false })} routeAssistant={correcting('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle());
    sendCorrection();
    await waitFor(() => expect(planRequest).toHaveBeenCalled());
    expect(planRequest.mock.calls[0][0]).toBe(`做一个专属游戏

${CORRECTION}`);
  });

  it('shows a plan being made over a canvas with nodes as one line, gone once the plan is on the canvas', async () => {
    seedNode();
    let answer!: (value: CanvasPlan) => void;
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    render(<CanvasSurface assistantExecution={fakeHost({ running: false })} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle());
    fireEvent.change(panel().getByRole('textbox', { name: '画布需求' }), { target: { value: '加一个审核节点' } });
    fireEvent.click(panel().getByRole('button', { name: '发送' }));
    await waitFor(() => expect(planRequest).toHaveBeenCalled());
    expect(pill()).toHaveTextContent('画布助手正在调整画布');
    // The conversation, on screen, says it too: the line on the stage is not announced a second time.
    expect(pill()!.querySelector('[aria-live]')).toBeNull();
    answer(plan);
    await waitFor(() => expect(pill()).toBeNull());
    expect(panel().getByText(/^已添加一个节点。/)).toBeVisible();
  });

  it('shows a direct task under way over a canvas with nodes while the conversation reads it', async () => {
    seedNode();
    taskConversation();
    render(<CanvasSurface assistantExecution={fakeHost({ running: true })} routeAssistant={routeTo('execute')} planRequest={vi.fn()} />);
    expect(pill()).toBeNull();
    fireEvent.click(toggle());
    expect(pill()).toHaveTextContent('正在直接执行，画布不会变化');
  });

  it('labels the example of an empty canvas as one', () => {
    render(<CanvasSurface readOnly />);
    expect(within(document.querySelector('.awwo-empty-diagram') as HTMLElement).getByText('示例')).toBeInTheDocument();
  });
});

describe('StageActivity', () => {
  it('draws the line over a canvas with nodes only for a plan or a task, and not over the results or a note on the stage', () => {
    const stage = { nodes: 2, results: false, note: false };
    expect(showsStageLine({ kind: 'planning' }, stage)).toBe(true);
    expect(showsStageLine({ kind: 'task' }, stage)).toBe(true);
    expect(showsStageLine({ kind: 'pending', phase: 'routing' }, stage)).toBe(false);
    expect(showsStageLine({ kind: 'empty' }, stage)).toBe(false);
    expect(showsStageLine(undefined, stage)).toBe(false);
    expect(showsStageLine({ kind: 'task' }, { ...stage, nodes: 0 })).toBe(false);
    expect(showsStageLine({ kind: 'task' }, { ...stage, results: true })).toBe(false);
    // A narrow stage can stretch a note to the same corner; the conversation still says what is under way.
    expect(showsStageLine({ kind: 'planning' }, { ...stage, note: true })).toBe(false);
  });


  it('names a plan’s declared nodes and connections and its step, and is announced only where asked', () => {
    const progress = { stage: 'streaming' as const, characters: 120, nodes: 3, edges: 2, reasoning: 0, attempt: 1 };
    const { container, rerender } = render(<StageActivity state={{ kind: 'planning', progress }} />);
    expect(screen.getByText('画布助手正在调整画布')).toBeVisible();
    expect(screen.getByText('3 个节点 · 2 条连线')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '规划进度' })).toHaveAttribute('aria-valuenow', '2');
    expect(container.querySelector('[aria-live]')).toBeNull();
    rerender(<StageActivity compact announce state={{ kind: 'planning', progress }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('画布助手正在调整画布');
    rerender(<StageActivity state={{ kind: 'pending', phase: 'routing' }} />);
    expect(screen.getByText('正在判断怎么处理')).toBeVisible();
    rerender(<StageActivity state={{ kind: 'empty' }} />);
    expect(screen.getByText('直接执行的任务不改画布，结果都在对话里。')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// Code review 2026-10-16: only the open task is read, for about six minutes, so a task counts as under way only while it
// is being read; any other task's listed status may be old.
describe('the host says a task is under way only while it reads it', () => {
  it('trusts the open task while it is read, and no other', () => {
    const run = { id: 'run-a', status: 'running', prompt: '做一个专属游戏', createdAt: time, updatedAt: time, output: '', error: '', canRespond: false,
      canCancel: true, truncated: false, messages: [], approvals: [], artifacts: [] };
    const host = (fields: Record<string, unknown>) => executionHost({ selectedId: 'run-a', run, pollingPaused: false, history: { items: [] }, ...fields } as never);
    expect(host({}).running?.('run-a')).toBe(true);
    expect(host({}).outcome?.('run-a')).toBe('still running');
    expect(host({ pollingPaused: true }).running?.('run-a')).toBe(false);
    expect(host({ pollingPaused: true }).outcome?.('run-a')).toBeUndefined();
    expect(host({ selectedId: 'run-b' }).running?.('run-a')).toBe(false);
    expect(host({ run: null, history: { items: [{ id: 'run-a', status: 'running', prompt: '做一个专属游戏', createdAt: time, updatedAt: time }] } }).running?.('run-a')).toBe(false);
    expect(host({ run: { ...run, status: 'completed' } }).running?.('run-a')).toBe(false);
    expect(host({ run: { ...run, status: 'completed' } }).outcome?.('run-a')).toBe('completed');
  });
});
