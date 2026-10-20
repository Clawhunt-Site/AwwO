import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface, type InitialPlanRequest } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { TaskStartUnconfirmed, type AssistantExecutionHost, type AssistantRoute, type AssistantRouteDecision, type AssistantRouteRequest } from '../src/canvas/assistantRouting';
import { emptyDocument, loadDocumentWithStatus, saveDocument } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import { loadPlanningConversation, savePlanningConversation, type requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions, setStreaming } from '../src/canvas/sessions';

// Where the host also does tasks, the assistant is one conversation and the server routes each message: these
// check how the canvas sends it, follows the route, draws the turn and hands a request over to the other way when the
// reader corrects how it was handled: the reader never picks a way by hand.
// A message joins the conversation only once it is handled; until then the box keeps it.
const plan: CanvasPlan = { version: 1, summary: '已添加一个节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '新节点' }] };
const seedNode = () => saveDocument({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' }], view: { x: 0, y: 0, scale: 1 } });
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).queryByRole('button', { name: '画布助手', exact: true });
const sidebar = () => document.querySelector('.awwo-planner-sidebar') as HTMLElement | null;
const panel = () => within(sidebar()!);
const box = () => panel().getByRole('textbox', { name: '画布需求' });
const pendingBubble = () => sidebar()!.querySelector('.awwo-assistant-message.is-pending');
const userRoutes = () => loadPlanningConversation().messages.filter(message => message.role === 'user').map(message => message.route);
const BUSY = '节点正在执行或连接，请结束后再修改画布。';
const UNCONFIRMED = '没能确认任务是否已经开始。可以用下方的「核对上次提交」核对，不会多建一个任务；已经开始的任务也会列在这张画布的任务里。';
const UNDONE = '已撤销最近一次 AI 更改。';
const OPERATION = expect.stringMatching(/^execution-[0-9a-f-]{36}$/);
const STORED_OP = 'execution-11111111-1111-4111-8111-111111111111';
const LOST = '没能确认任务是否已经开始。如果它开始了，会列在这张画布之前的任务里；没有的话，可以重新发送。';
const deleteTile = (id: string) => {
  const tile = within(screen.getByTestId(`canvas-tile-${id}`));
  fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(tile.getByRole('button', { name: '删除', exact: true }));
};
const unconfirmedConversation = () => savePlanningConversation({ draft: '', messages: [
  { id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
  { id: 'turn-1-task', role: 'assistant', content: '（存下的说明）', status: 'unconfirmed', route: 'execute', operationId: STORED_OP }] });
const KEPT = '上面的画布更改没有自动撤销：当时画布正忙、任务是否开始还没确认，或画布已有新的改动。';

// `waits`: like the real host after an unconfirmed start, it reports the submission it was last sent as waiting.
function fakeHost(overrides: Partial<AssistantExecutionHost> = {}, { waits = false }: { waits?: boolean } = {}) {
  let ended = false;
  let lastOperation: string | undefined;
  const startImpl = overrides.start ?? (async () => 'task-1');
  const host: AssistantExecutionHost = {
    readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(),
    stop: vi.fn(async () => {}),
    finished: () => ended,
    renderTask: id => <p>任务卡片 {id}</p>,
    renderEarlier: (mentioned, open) => <p data-testid="earlier" data-open={String(open)}>{`提到的任务：${[...mentioned].join(',') || '无'}`}</p>,
    renderNotices: () => <p>任务服务提示</p>,
    settings: <p>直接执行用的模型</p>,
    ...overrides,
    start: vi.fn(async (prompt: string, operationId: string) => { lastOperation = operationId; return startImpl(prompt, operationId); }),
  };
  if (waits) Object.defineProperty(host, 'pendingOperation', { get: () => lastOperation, enumerable: true });
  return { host, end: () => { ended = true; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
// The next message `correct` sends is answered as a correction (redirect) toward this way.
let correction: AssistantRoute | null = null;
const routeTo = (route: AssistantRoute) => vi.fn(async (_request: AssistantRouteRequest, _signal: AbortSignal): Promise<AssistantRouteDecision> => {
  if (!correction) return { route };
  const to = correction;
  correction = null;
  return { route: to, redirect: true };
});
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(panel().getByRole('button', { name: '发送' }));
};
const CORRECT: Record<AssistantRoute, string> = { execute: '别改画布，直接做吧', plan: '还是放到画布上吧' };
/** What the other way is given when a correction hands `request` over: the request, then the correction. */
const handed = (request: string, to: AssistantRoute) => `${request}\n\n${CORRECT[to]}`;
// Says, once the assistant is idle, that the latest request should have gone the other way.
const correct = async (to: AssistantRoute) => {
  await waitFor(() => { expect(box()).toBeEnabled(); expect(pendingBubble()).toBeNull(); });
  correction = to;
  send(CORRECT[to]);
};

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); correction = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

describe('the canvas assistant’s one conversation', () => {
  it('starts a task with the message where the server routes it to execution, and plans nothing', async () => {
    seedNode();
    const { host } = fakeHost();
    const router = routeTo('execute');
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一封给客户的道歉邮件');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    expect(host.start).toHaveBeenCalledExactlyOnceWith('写一封给客户的道歉邮件', OPERATION);
    const request = router.mock.calls[0][0];
    expect(request).toEqual({ message: '写一封给客户的道歉邮件', routes: ['plan', 'execute'],
      canvas: { nodes: 1, titles: ['已有节点'], results: false }, recent: [] });
    expect(planRequest).not.toHaveBeenCalled();
    expect(sidebar()!.querySelector('.awwo-assistant-route')).toHaveTextContent('直接执行');
    // Saved by an effect that can run a moment after the turn is drawn.
    await waitFor(() => expect(loadPlanningConversation().messages.map(({ role, route, taskId }) => ({ role, route, taskId }))).toEqual([
      { role: 'user', route: 'execute', taskId: undefined }, { role: 'assistant', route: 'execute', taskId: 'task-1' }]));
    expect(loadPlanningConversation().draft).toBe('');
    expect(box()).toHaveValue('');
  });

  it('arranges the canvas where the server routes the message to planning, and says so on the reply', async () => {
    seedNode();
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('加一个审核节点');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    expect(planRequest.mock.calls[0][0]).toBe('加一个审核节点');
    expect(host.start).not.toHaveBeenCalled();
    // The model's summary leads the reply; under it, what the canvas now holds.
    await waitFor(() => expect(panel().getByText(/^已添加一个节点。/)).toBeVisible());
    const reply = panel().getByText(/^已添加一个节点。/).closest('li')!;
    expect(reply).toHaveTextContent(/画布上的改动：\s*· 新增 1 个节点：「新节点」/);
    expect(reply).toHaveTextContent('调整画布');
    expect(reply).toHaveTextContent('已更新画布');
    expect(loadPlanningConversation().messages.every(message => message.route === 'plan')).toBe(true);
    expect(loadPlanningConversation().draft).toBe('');
  });

  it('plans a message the router cannot answer for, and asks no router where only one way is open', async () => {
    seedNode();
    const { host } = fakeHost();
    const failing = vi.fn(async () => { throw new Error('router down'); });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={failing} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('帮我调研一下竞品');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(host.start).not.toHaveBeenCalled();
    unmount(); cleanup(); localStorage.clear(); seedNode();
    // A service that cannot start a task leaves planning as the only way: the router is not asked at all.
    const notReady = fakeHost({ ready: false });
    const router = routeTo('execute');
    const planned = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={notReady.host} routeAssistant={router} planRequest={planned} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(planned).toHaveBeenCalledOnce());
    expect(router).not.toHaveBeenCalled();
    expect(notReady.host.start).not.toHaveBeenCalled();
  });

  it('shows a message being routed as pending, keeps it in the box, and puts it back when stopped', async () => {
    seedNode();
    const { host } = fakeHost();
    let signal: AbortSignal | undefined;
    const router = vi.fn((_request: AssistantRouteRequest, given: AbortSignal) => { signal = given; return new Promise<AssistantRouteDecision>(() => {}); });
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('做一个落地页');
    await waitFor(() => expect(panel().getByRole('status')).toHaveTextContent('正在判断怎么处理'));
    expect(pendingBubble()).toHaveTextContent('做一个落地页');
    expect(box()).toHaveValue('');
    // Nothing joined the conversation: the message is stored only as the box's draft.
    expect(loadPlanningConversation()).toEqual({ draft: '做一个落地页', messages: [] });
    fireEvent.click(panel().getByRole('button', { name: '取消' }));
    expect(signal?.aborted).toBe(true);
    expect(box()).toHaveValue('做一个落地页');
    expect(pendingBubble()).toBeNull();
    expect(loadPlanningConversation().messages).toEqual([]);
    expect(planRequest).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
  });

  it('leaves a message in the box, and nothing in the conversation, when the page goes while it is routed', async () => {
    seedNode();
    const { host } = fakeHost();
    let signal: AbortSignal | undefined;
    const router = vi.fn((_request: AssistantRouteRequest, given: AbortSignal) => { signal = given; return new Promise<AssistantRouteDecision>(() => {}); });
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('做一个落地页');
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(loadPlanningConversation()).toEqual({ draft: '做一个落地页', messages: [] });
  });

  it('keeps a message the canvas cannot take while a node is talking in the box, out of the conversation', async () => {
    seedNode();
    setStreaming('node-a', true);
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('在画布上加一个审核节点');
    expect(await panel().findByText(BUSY)).toBeVisible();
    expect(planRequest).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
    expect(box()).toHaveValue('在画布上加一个审核节点');
    expect(loadPlanningConversation()).toEqual({ draft: '在画布上加一个审核节点', messages: [] });
    expect(pendingBubble()).toBeNull();
  });

  it('says a task is being created, with the message pending and nothing to stop meanwhile', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getByRole('status')).toHaveTextContent('正在创建任务'));
    expect(pendingBubble()).toHaveTextContent('写一封邮件');
    expect(panel().queryByRole('button', { name: '取消' })).toBeNull();
    expect(box()).toBeDisabled();
    await act(async () => { starting.resolve('task-9'); });
    expect(await panel().findByText('任务卡片 task-9')).toBeVisible();
    expect(pendingBubble()).toBeNull();
    expect(box()).toHaveValue('');
  });

  it('says why a task could not start, keeps the message and plans nothing', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new Error('工作区正忙：它一次只运行一个任务。'); }) });
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getAllByText('工作区正忙：它一次只运行一个任务。').length).toBeGreaterThan(0));
    expect(box()).toHaveValue('写一封邮件');
    expect(planRequest).not.toHaveBeenCalled();
    // The refused request is in the conversation, so a correction hands it to the canvas.
    await correct('plan');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][0]).toBe(handed('写一封邮件', 'plan'));
  });

  it('records a start whose outcome is unknown as unconfirmed, never planned over or sent again', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) }, { waits: true });
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(box()).toHaveValue('');
    expect(panel().queryByRole('alert')).toBeNull();
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ role: 'assistant', route: 'execute', status: 'unconfirmed' });
    // A correction does not hand it to the canvas: the message is planned on its own.
    await correct('plan');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][0]).toBe(CORRECT.plan);
  });

  it('still starts tasks while the canvas cannot be arranged, and says so', async () => {
    seedNode();
    const { host } = fakeHost();
    const router = routeTo('plan');
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    render(<CanvasSurface storageMode="cloud" executionUnavailableReason="先连接一个引擎" assistantExecution={host} routeAssistant={router} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText('暂时不能调整画布，消息会作为任务直接执行。')).toBeVisible();
    send('加一个审核节点');
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith('加一个审核节点', OPERATION));
    expect(router).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
    cleanup(); localStorage.clear(); seedNode();
    // With neither way open the composer waits, and promises nothing.
    const closed = fakeHost({ ready: false });
    render(<CanvasSurface storageMode="cloud" executionUnavailableReason="先连接一个引擎" assistantExecution={closed.host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    fireEvent.change(box(), { target: { value: '加一个节点' } });
    expect(panel().getByRole('button', { name: '发送' })).toBeDisabled();
    expect(panel().queryByText('暂时不能调整画布，消息会作为任务直接执行。')).toBeNull();
  });

  it('hands a planned request over to a task, undoing the plan once the task exists', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith(handed('写一份发布说明', 'execute'), OPERATION));
    // The plan stays until its task exists.
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().getByText('正在创建任务')).toBeVisible();
    await act(async () => { starting.resolve('task-1'); });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']));
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(panel().getByText(UNDONE)).toBeVisible();
    expect(userRoutes()).toEqual(['plan', 'execute']);
    // The conversation keeps the reader's own words.
    expect(loadPlanningConversation().messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['写一份发布说明', CORRECT.execute]);
  });

  // Review 2026-10-19: a turn kept only the correction, so a second correction handed over the first one alone.
  it('hands the whole request over again when a second correction follows the first, through a reload', async () => {
    seedNode();
    const { host, end } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const router = routeTo('plan');
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    const first = handed('写一份发布说明', 'execute');
    expect(host.start).toHaveBeenCalledExactlyOnceWith(first, OPERATION);
    await waitFor(() => expect(loadPlanningConversation().messages.filter(message => message.role === 'user').at(-1))
      .toMatchObject({ content: CORRECT.execute, request: first }));
    end();
    unmount();
    render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    await correct('plan');
    await waitFor(() => expect(planRequest).toHaveBeenCalledTimes(2));
    expect(planRequest.mock.calls[1][0]).toBe(`${first}\n\n${CORRECT.plan}`);
    expect(loadPlanningConversation().messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['写一份发布说明', CORRECT.execute, CORRECT.plan]);
  });

  it('plans a correction on its own where the request with it would be too long for the planner', async () => {
    seedNode();
    const { host, end } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const long = '字'.repeat(2660); // 7980 bytes alone, over 8000 with the correction.
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send(long);
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith(long, OPERATION));
    end();
    await correct('plan');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][0]).toBe(CORRECT.plan);
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('keeps the plan and says why where a hand-over to a task cannot start', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new Error('工作区正忙：它一次只运行一个任务。'); }) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    expect(await panel().findByText('工作区正忙：它一次只运行一个任务。')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(userRoutes()).toEqual(['plan']);
    // The correction stays in the box, to send again.
    expect(box()).toHaveValue(CORRECT.execute);
  });

  it('hands a task over to the canvas, stopping it first while it still runs', async () => {
    seedNode();
    const stopping = deferred<void>();
    const { host } = fakeHost({ stop: vi.fn(() => stopping.promise) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    await correct('plan');
    await waitFor(() => expect(host.stop).toHaveBeenCalledExactlyOnceWith('task-1'));
    expect(panel().getByRole('status')).toHaveTextContent('正在停止任务');
    expect(panel().queryByRole('button', { name: '取消' })).toBeNull();
    expect(planRequest).not.toHaveBeenCalled();
    await act(async () => { stopping.resolve(); });
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][0]).toBe(handed('把三个节点并行', 'plan'));
    expect(host.stop).toHaveBeenCalledOnce();
    expect(userRoutes()).toEqual(['execute', 'plan']);
    expect(panel().queryByText('画布现在没法处理这个请求，请稍后再试。')).toBeNull();
  });

  it('hands a planned request over to a task once, and takes no other message while the task is created', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    await waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(box()).toBeDisabled();
    await act(async () => { starting.resolve('task-1'); });
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(userRoutes()).toEqual(['plan', 'execute']);
  });

  it('hands an ended task over to the canvas without stopping it', async () => {
    seedNode();
    const { host, end } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    end();
    await correct('plan');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('does not stop a task for the canvas while the canvas cannot take the request', async () => {
    seedNode();
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    act(() => setStreaming('node-a', true));
    await correct('plan');
    expect(await panel().findByText(BUSY)).toBeVisible();
    expect(host.stop).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
    expect(userRoutes()).toEqual(['execute']);
  });

  it('keeps executed turns out of what the planner reads', async () => {
    seedNode();
    const { host } = fakeHost();
    let route: AssistantRoute = 'execute';
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={vi.fn(async () => ({ route }))} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    route = 'plan';
    send('加一个节点');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][2]).toEqual([]);
  });

  it('opens the task conversation beside an empty canvas, keeping one composer', async () => {
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeVisible();
    expect(toggle()).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '写一首诗' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    expect(screen.queryByRole('heading', { name: '想一起搭建什么？' })).toBeNull();
    expect(screen.getAllByRole('textbox', { name: '画布需求' })).toHaveLength(1);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    // Closed, the welcome comes back with the composer, and the conversation can be opened again.
    fireEvent.click(panel().getByRole('button', { name: '关闭画布助手' }));
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeVisible();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads the tasks an empty canvas’s welcome shows: its own, and the canvas’s earlier ones', () => {
    savePlanningConversation({ draft: '', messages: [
      { id: 'u', role: 'user', content: '写一首诗', route: 'execute' },
      { id: 'a', role: 'assistant', content: '', route: 'execute', taskId: 'task-1' }] });
    const { host } = fakeHost();
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeVisible();
    expect(screen.getByText('任务卡片 task-1')).toBeVisible();
    expect(host.setVisible).toHaveBeenLastCalledWith(true);
    unmount();
    // A conversation with no task of its own still draws the canvas's earlier ones.
    savePlanningConversation({ draft: '', messages: [{ id: 'u', role: 'user', content: '加一个节点', route: 'plan' },
      { id: 'a', role: 'assistant', content: '画布不需要改动', route: 'plan' }] });
    const planned = fakeHost();
    render(<CanvasSurface assistantExecution={planned.host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.getByTestId('earlier')).toBeVisible();
    expect(planned.host.setVisible).toHaveBeenLastCalledWith(true);
    cleanup(); localStorage.clear();
    // With no conversation, the welcome draws none, and nothing is read for it.
    const quiet = fakeHost();
    render(<CanvasSurface assistantExecution={quiet.host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.queryByTestId('earlier')).toBeNull();
    expect(quiet.host.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('gives a message too long to plan to a task, and says so only where no task can start', async () => {
    seedNode();
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const long = '字'.repeat(2700); // 8100 bytes; the planner takes at most 8000.
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send(long);
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith(long, OPERATION));
    expect(planRequest).not.toHaveBeenCalled();
    // Started, it leaves the box, so Enter does not send it a second time.
    await waitFor(() => expect(box()).toHaveValue(''));
    unmount(); cleanup(); localStorage.clear(); seedNode();
    const notReady = fakeHost({ ready: false });
    render(<CanvasSurface assistantExecution={notReady.host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send(long);
    expect(await panel().findByText('这条消息太长，没法用来调整画布（最多约 8000 字节）。请精简后再发。')).toBeVisible();
    expect(planRequest).not.toHaveBeenCalled();
    expect(notReady.host.start).not.toHaveBeenCalled();
    expect(box()).toHaveValue(long);
  });

  it('reads the task service once the canvas opens, and tasks only while the panel is on screen', () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(host.activate).toHaveBeenCalled();
    expect(host.setVisible).toHaveBeenLastCalledWith(false);
    fireEvent.click(toggle()!);
    expect(host.setVisible).toHaveBeenLastCalledWith(true);
    expect(panel().getByTestId('earlier')).toHaveAttribute('data-open', 'false');
    expect(panel().getByText('直接执行用的模型')).toBeVisible();
    fireEvent.click(panel().getByRole('button', { name: '关闭画布助手' }));
    expect(host.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('lets a read-only canvas review its tasks, open, without a composer, read only once shown', () => {
    const { host } = fakeHost({ readOnly: true, ready: false });
    render(<CanvasSurface readOnly assistantExecution={host} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(host.activate).not.toHaveBeenCalled();
    fireEvent.click(toggle()!);
    expect(host.activate).toHaveBeenCalled();
    expect(host.setVisible).toHaveBeenLastCalledWith(true);
    expect(panel().getByTestId('earlier')).toHaveAttribute('data-open', 'true');
    expect(screen.queryByRole('textbox', { name: '画布需求' })).toBeNull();
    expect(panel().getByText('只读访问：可以查看这张画布的任务。')).toBeVisible();
    expect(panel().queryByText('说出画布上想调整的地方，或交给助手一件事。')).toBeNull();
  });

  it('says the plan was kept, not undone, where the canvas could not undo it once the task existed', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    await waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    // A node begins talking while the task is created: the plan can no longer be undone.
    act(() => setStreaming('node-a', true));
    await act(async () => { starting.resolve('task-1'); });
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().getByText(KEPT)).toBeVisible();
    expect(panel().queryByText(UNDONE)).toBeNull();
  });

  it('does not hand a plan over to a task while a node is talking', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    act(() => setStreaming('node-a', true));
    await correct('execute');
    expect(await panel().findByText(BUSY)).toBeVisible();
    expect(host.start).not.toHaveBeenCalled();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
  });

  it('hands a request over to a task without touching the canvas once its plan was undone by hand', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(host.start).toHaveBeenCalledExactlyOnceWith(handed('写一份发布说明', 'execute'), OPERATION);
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1);
    expect(panel().queryByText(KEPT)).toBeNull();
    expect(panel().getAllByText(UNDONE)).toHaveLength(1);
  });

  it('keeps a plan a redo brought back, and says so, when a correction hands its request to a task', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: true });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().getByText(KEPT)).toBeVisible();
  });

  it('moves the focus to the side panel’s box when the first task takes the conversation there', async () => {
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const welcomeBox = screen.getByRole('textbox', { name: '画布需求' });
    welcomeBox.focus();
    fireEvent.change(welcomeBox, { target: { value: '写一首诗' } });
    fireEvent.keyDown(welcomeBox, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    await waitFor(() => expect(box()).toHaveFocus());
  });

  // 2026-10-20: the focus moved at the next frame, and fell to the page wherever a frame came before React drew the
  // panel (it draws a task's start in a scheduler task); the test above failed 5 of 12 runs of this whole file, in
  // which the test before it left a frame pending.
  it('moves the focus to the side panel’s box when frames pass before the panel is drawn', async () => {
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const welcomeBox = screen.getByRole('textbox', { name: '画布需求' });
    welcomeBox.focus();
    fireEvent.change(welcomeBox, { target: { value: '写一首诗' } });
    fireEvent.keyDown(welcomeBox, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    // act holds React's drawing until its callback ends: the task starts, then two frames pass, then the panel is drawn.
    await act(async () => {
      starting.resolve('task-1');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(panel().getByText('任务卡片 task-1')).toBeVisible();
    await waitFor(() => expect(box()).toHaveFocus());
  });

  it('moves the focus to the side panel’s box when a correction in the welcome hands its request over to a task', async () => {
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    const welcomeBox = () => screen.getByRole('textbox', { name: '画布需求' });
    fireEvent.change(welcomeBox(), { target: { value: '写一份发布说明' } });
    fireEvent.keyDown(welcomeBox(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    // Its plan undone by hand, the canvas is empty again, and the conversation is back in the welcome.
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(document.querySelector('.awwo-canvas-assistant--welcome')).not.toBeNull());
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
    correction = 'execute';
    welcomeBox().focus();
    fireEvent.change(welcomeBox(), { target: { value: CORRECT.execute } });
    fireEvent.keyDown(welcomeBox(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith(handed('写一份发布说明', 'execute'), OPERATION));
    await act(async () => {
      starting.resolve('task-1');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(panel().getByText('任务卡片 task-1')).toBeVisible();
    await waitFor(() => expect(box()).toHaveFocus());
  });

  it('leaves the focus where the reader moved it while the first task was created', async () => {
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const welcomeBox = screen.getByRole('textbox', { name: '画布需求' });
    welcomeBox.focus();
    fireEvent.change(welcomeBox, { target: { value: '写一首诗' } });
    fireEvent.keyDown(welcomeBox, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    const search = screen.getByRole('searchbox', { name: '查找 Agent' });
    search.focus();
    await act(async () => { starting.resolve('task-1'); });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(panel().getByText('任务卡片 task-1')).toBeVisible();
    expect(search).toHaveFocus();
  });

  it('says the task was stopped when the canvas became busy meanwhile', async () => {
    seedNode();
    const stopping = deferred<void>();
    const { host } = fakeHost({ stop: vi.fn(() => stopping.promise) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    await correct('plan');
    await waitFor(() => expect(host.stop).toHaveBeenCalledOnce());
    act(() => setStreaming('node-a', true));
    await act(async () => { stopping.resolve(); });
    expect(await panel().findByText(`任务已结束或已请求停止。${BUSY}`)).toBeVisible();
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('handles a carried-over request once when it is sent before the planner is known', async () => {
    let plannerKnown = () => {};
    vi.stubGlobal('fetch', vi.fn((input: unknown) => String(input).endsWith('/canvas/planner')
      ? new Promise(resolve => { plannerKnown = () => resolve({ ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) }); })
      : Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
    const routing = deferred<AssistantRouteDecision>();
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt: '做一个落地页', start: true, interrupted: false, claim: () => true, done };
    render(<CanvasSurface assistantExecution={host} routeAssistant={vi.fn(() => routing.promise)} planRequest={planRequest} initialPlan={carried} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue('做一个落地页'));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    // The planner's status arrives while the message is routed: the carried request stands aside.
    await act(async () => { plannerKnown(); });
    await waitFor(() => expect(done).toHaveBeenCalled());
    await act(async () => { routing.resolve({ route: 'execute' }); });
    expect(await screen.findByText('任务卡片 task-1')).toBeVisible();
    expect(host.start).toHaveBeenCalledExactlyOnceWith('做一个落地页', OPERATION);
    expect(planRequest).not.toHaveBeenCalled();
    expect(userRoutes()).toEqual(['execute']);
  });

  it('says a plan stays on the canvas while the task handed it over is unconfirmed', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) }, { waits: true });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(panel().getByText(KEPT)).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().queryByText(UNDONE)).toBeNull();
  });

  it('gives a start reconciled later its task, in place of the unconfirmed request', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) }, { waits: true });
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    const operationId = vi.mocked(host.start).mock.calls[0][1];
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'unconfirmed', operationId });
    rerender(<CanvasSurface assistantExecution={{ ...host, pendingOperation: undefined, confirmedTask: { taskId: 'task-7', operationId } }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText('任务卡片 task-7')).toBeVisible();
    expect(panel().queryByText(UNCONFIRMED)).toBeNull();
    expect(loadPlanningConversation().messages.at(-1)).toEqual({ id: expect.any(String), role: 'assistant', content: '', route: 'execute', taskId: 'task-7' });
  });

  it('stores a message being made a task as unconfirmed, out of the box, should the page go meanwhile', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    const { unmount } = render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getByRole('status')).toHaveTextContent('正在创建任务'));
    unmount();
    const stored = loadPlanningConversation();
    expect(stored.draft).toBe('');
    // Under the identity it was sent with, which the host keeps waiting for a reconcile.
    expect(stored.messages[1].operationId).toBe(vi.mocked(host.start).mock.calls[0][1]);
    expect(stored.messages.map(({ role, content, route, status }) => ({ role, content, route, status }))).toEqual([
      { role: 'user', content: '写一封邮件', route: 'execute', status: undefined },
      { role: 'assistant', content: UNCONFIRMED, route: 'execute', status: 'unconfirmed' }]);
  });

  it('puts a task draft that arrives while a message is handled in the box only afterwards', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getByRole('status')).toHaveTextContent('正在创建任务'));
    rerender(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} taskDraft={{ id: 'draft-1', prompt: '请结合已选知识完成任务：' }} />);
    expect(box()).toHaveValue('');
    await act(async () => { starting.resolve('task-1'); });
    await waitFor(() => expect(box()).toHaveValue('请结合已选知识完成任务：'));
    expect(host.start).toHaveBeenCalledOnce();
  });

  it('keeps a plan undone by hand undone through later canvas changes, and hands the request over untouched', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    // An edit of the operator's own after the undo: the plan is still not on the canvas.
    deleteTile('node-b');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(host.start).toHaveBeenCalledExactlyOnceWith(handed('写一份发布说明', 'execute'), OPERATION);
    expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']);
    expect(panel().queryByText(KEPT)).toBeNull();
  });

  it('keeps a plan undone while a redo brings back another step, and drops that only for the plan’s own', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    const redo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: true });
    const undo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    // The operator's own step first, then the plan, then both undone.
    deleteTile('node-b');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    undo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    // Redoing the operator's step leaves the plan undone.
    redo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']));
    // Redoing the plan's own step brings it back, and the assistant can no longer undo it: a task keeps it.
    redo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().getByText(KEPT)).toBeVisible();
  });

  it('counts a plan undone by Ctrl+Z after other steps were undone first', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    const undo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    // An edit after the plan, then both undone: the edit first, the plan second.
    deleteTile('node-b');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    undo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    undo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id).sort()).toEqual(['node-a', 'node-b']));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().queryByText(KEPT)).toBeNull();
  });

  it('knows a plan that only renamed a node as undone by its undo step, however many steps came first', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const rename: CanvasPlan = { version: 1, summary: '已改名。', operations: [{ type: 'update_node', nodeId: 'node-a', title: '新名字' }] };
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(rename)} />);
    const undo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    const redo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: true });
    const title = () => loadDocumentWithStatus().doc.nodes.find(node => node.id === 'node-a')?.title;
    fireEvent.click(toggle()!);
    send('把第一个节点改个名');
    await waitFor(() => expect(title()).toBe('新名字'));
    deleteTile('node-b');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    undo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    undo();
    await waitFor(() => expect(title()).toBe('已有节点'));
    // Its own redo has it back; undone by its step again, it is undone.
    redo();
    await waitFor(() => expect(title()).toBe('新名字'));
    undo();
    await waitFor(() => expect(title()).toBe('已有节点'));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(title()).toBe('已有节点');
    expect(panel().queryByText(KEPT)).toBeNull();
  });

  it('keeps a rename plan undone while a redo brings back an earlier step, until its own redo', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const rename: CanvasPlan = { version: 1, summary: '已改名。', operations: [{ type: 'update_node', nodeId: 'node-a', title: '新名字' }] };
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(rename)} />);
    const undo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    const redo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: true });
    const title = () => loadDocumentWithStatus().doc.nodes.find(node => node.id === 'node-a')?.title;
    // The operator's own step before the plan; the plan undone by its button, then the own step undone too.
    deleteTile('node-b');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    fireEvent.click(toggle()!);
    send('把第一个节点改个名');
    await waitFor(() => expect(title()).toBe('新名字'));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    await waitFor(() => expect(title()).toBe('已有节点'));
    undo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    // Redoing the own step leaves the rename undone.
    redo();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    redo();
    await waitFor(() => expect(title()).toBe('新名字'));
    // Back by its own redo, the rename is kept when a correction hands its request to a task.
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(title()).toBe('新名字');
    expect(panel().getByText(KEPT)).toBeVisible();
  });

  it('counts a plan whose nodes were deleted by hand as undone', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    const added = loadDocumentWithStatus().doc.nodes.find(node => node.id !== 'node-a')!.id;
    deleteTile(added);
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']);
    expect(panel().queryByText(KEPT)).toBeNull();
  });

  it('keeps a plan that also removed a node on the canvas when its added node is deleted by hand', async () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
      { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' },
      { ...createAgentTemplate('general', { x: 700, y: 60 }), id: 'node-b', title: '另一个节点' }] });
    const swap: CanvasPlan = { version: 1, summary: '已换掉一个节点。', operations: [
      { type: 'add_node', ref: 'x', templateId: 'general', title: '新节点' }, { type: 'remove_node', nodeId: 'node-b' }] };
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(swap)} />);
    const undo = () => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    const ids = () => loadDocumentWithStatus().doc.nodes.map(node => node.id).sort();
    fireEvent.click(toggle()!);
    send('换掉另一个节点');
    await waitFor(() => expect(ids()).not.toContain('node-b'));
    // Its reply keeps no nodes: their absence would not say the removal is gone.
    await waitFor(() => expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'applied' }));
    expect(loadPlanningConversation().messages.at(-1)?.nodes).toBeUndefined();
    deleteTile(ids().find(id => id !== 'node-a')!);
    await waitFor(() => expect(ids()).toEqual(['node-a']));
    // node-b is still removed; undone by its own step (after the deletion's), the plan is undone.
    undo();
    await waitFor(() => expect(ids()).toHaveLength(2));
    undo();
    await waitFor(() => expect(ids()).toEqual(['node-a', 'node-b']));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(ids()).toEqual(['node-a', 'node-b']);
    expect(panel().queryByText(KEPT)).toBeNull();
  });

  it('counts a plan undone with Ctrl+Z as undone too', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await waitFor(() => expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'applied' }));
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
    await correct('execute');
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1);
    expect(panel().queryByText(KEPT)).toBeNull();
    expect(panel().queryByText(UNDONE)).toBeNull();
  });

  it('offers an unconfirmed request’s reconcile after a reload, and says where to look once there is none', () => {
    seedNode();
    unconfirmedConversation();
    const waiting = fakeHost({ pendingOperation: STORED_OP });
    const { unmount } = render(<CanvasSurface assistantExecution={waiting.host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText('（存下的说明）')).toBeVisible();
    expect(panel().queryByText(LOST)).toBeNull();
    unmount();
    // No submission left to reconcile (another device, a cleared store): no button is pointed at.
    const gone = fakeHost();
    render(<CanvasSurface assistantExecution={gone.host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText(LOST)).toBeVisible();
    expect(panel().queryByText('（存下的说明）')).toBeNull();
    cleanup(); seedNode();
    // A turn stored before identities were kept has no submission waiting for it: what this page waits on, and what it
    // settles, is another request's (another tab's), so the turn says where to look and stays as it was.
    savePlanningConversation({ draft: '', messages: [{ id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '（旧的说明）', status: 'unconfirmed', route: 'execute' }] });
    const other = fakeHost({ pendingOperation: STORED_OP }).host;
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={other} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText(LOST)).toBeVisible();
    rerender(<CanvasSurface assistantExecution={{ ...other, pendingOperation: undefined, startRefusal: { reason: '所选模型已不可用。', at: 1, operationId: STORED_OP } }}
      routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    rerender(<CanvasSurface assistantExecution={{ ...other, pendingOperation: undefined, confirmedTask: { taskId: 'task-9', operationId: STORED_OP } }}
      routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(panel().getByText(LOST)).toBeVisible();
    expect(panel().queryByText('所选模型已不可用。')).toBeNull();
    expect(panel().queryByText('任务卡片 task-9')).toBeNull();
    expect(box()).toHaveValue('');
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'unconfirmed', content: '（旧的说明）' });
  });

  it('settles a refused submission’s own request only, and once', async () => {
    seedNode();
    const OTHER_OP = 'execution-22222222-2222-4222-8222-222222222222';
    savePlanningConversation({ draft: '', messages: [
      { id: 'turn-1-user', role: 'user', content: '旧的请求', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '（甲）', status: 'unconfirmed', route: 'execute', operationId: STORED_OP },
      { id: 'turn-2-user', role: 'user', content: '新的请求', route: 'execute' },
      { id: 'turn-2-task', role: 'assistant', content: '（乙）', status: 'unconfirmed', route: 'execute', operationId: OTHER_OP }] });
    const refused = { ...fakeHost({ pendingOperation: OTHER_OP }).host, startRefusal: { reason: '所选模型已不可用。', at: 1, operationId: STORED_OP } };
    const { unmount } = render(<CanvasSurface assistantExecution={refused} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(await panel().findByText('所选模型已不可用。')).toBeVisible();
    expect(panel().getByText('（乙）')).toBeVisible();
    unmount();
    // Shown again (a remount) with the same refusal: the other request stays as it was.
    render(<CanvasSurface assistantExecution={refused} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(loadPlanningConversation().messages.map(message => message.status ?? null)).toEqual([null, 'error', null, 'unconfirmed']);
  });

  it('settles an unconfirmed request the service refused: its reason, and the request back in the box', async () => {
    seedNode();
    unconfirmedConversation();
    const { host } = fakeHost({ pendingOperation: STORED_OP });
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    rerender(<CanvasSurface assistantExecution={{ ...host, pendingOperation: undefined, startRefusal: { reason: '所选模型已不可用。', at: 1, operationId: STORED_OP } }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText('所选模型已不可用。')).toBeVisible();
    expect(box()).toHaveValue('写一封邮件');
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'error', content: '所选模型已不可用。', route: 'execute' });
  });

  it('settles a given-up request without offering it again, and not while the same submission waits again', async () => {
    seedNode();
    unconfirmedConversation();
    const { host } = fakeHost({ pendingOperation: STORED_OP });
    const router = routeTo('execute');
    const givenUp = { reason: '已放弃核对这次提交。', at: 1, operationId: STORED_OP, givenUp: true };
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    // Stored back (by the tab that sent it) while this page still holds its give-up: it is waited for, not settled.
    rerender(<CanvasSurface assistantExecution={{ ...host, startRefusal: givenUp }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(panel().queryByText('已放弃核对这次提交。')).toBeNull();
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'unconfirmed' });
    rerender(<CanvasSurface assistantExecution={{ ...host, pendingOperation: undefined, startRefusal: givenUp }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText('已放弃核对这次提交。')).toBeVisible();
    // Not back in the box: a task it started may be listed only once read, and sending it unread could start another.
    expect(box()).toHaveValue('');
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'error', content: '已放弃核对这次提交。', route: 'execute' });
  });

  it('takes a settled request back to unconfirmed while its submission waits again, and out of the box', async () => {
    seedNode();
    // Refused here (its request back in the box), then stored again by the page that sent it.
    savePlanningConversation({ draft: '写一封邮件', messages: [{ id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '所选模型已不可用。', status: 'error', route: 'execute', operationId: STORED_OP }] });
    const { host } = fakeHost();
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText('所选模型已不可用。')).toBeVisible();
    rerender(<CanvasSurface assistantExecution={{ ...host, pendingOperation: STORED_OP }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(panel().queryByText('所选模型已不可用。')).toBeNull();
    expect(box()).toHaveValue('');
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ status: 'unconfirmed', operationId: STORED_OP });
    // Another submission waiting, or a request edited in the box, is left alone.
    cleanup(); seedNode();
    savePlanningConversation({ draft: '改过的请求', messages: [{ id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '已放弃核对这次提交。', status: 'error', route: 'execute', operationId: STORED_OP }] });
    const other = render(<CanvasSurface assistantExecution={{ ...host, pendingOperation: 'execution-22222222-2222-4222-8222-222222222222' }}
      routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText('已放弃核对这次提交。')).toBeVisible();
    other.rerender(<CanvasSurface assistantExecution={{ ...host, pendingOperation: STORED_OP }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(box()).toHaveValue('改过的请求');
  });

  it('links a task another page announces to the request given up or refused here, and takes it out of the box', async () => {
    seedNode();
    savePlanningConversation({ draft: '写一封邮件', messages: [{ id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '所选模型已不可用。', status: 'error', route: 'execute', operationId: STORED_OP }] });
    const { host } = fakeHost();
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    rerender(<CanvasSurface assistantExecution={{ ...host, confirmedTask: { taskId: 'task-9', operationId: STORED_OP } }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText('任务卡片 task-9')).toBeVisible();
    expect(panel().queryByText('所选模型已不可用。')).toBeNull();
    expect(box()).toHaveValue('');
    const linked = loadPlanningConversation().messages.at(-1)!;
    expect(linked).toMatchObject({ taskId: 'task-9', route: 'execute', content: '' });
    expect(linked.status).toBeUndefined();
    expect(linked.operationId).toBeUndefined();
    // Another submission's task links nothing.
    cleanup(); seedNode();
    savePlanningConversation({ draft: '', messages: [{ id: 'turn-1-user', role: 'user', content: '写一封邮件', route: 'execute' },
      { id: 'turn-1-task', role: 'assistant', content: '已放弃核对这次提交。', status: 'error', route: 'execute', operationId: STORED_OP }] });
    render(<CanvasSurface assistantExecution={{ ...host, confirmedTask: { taskId: 'task-8', operationId: 'execution-22222222-2222-4222-8222-222222222222' } }}
      routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    expect(panel().getByText('已放弃核对这次提交。')).toBeVisible();
    expect(panel().queryByText('任务卡片 task-8')).toBeNull();
  });

  it('keeps the desktop canvas (no task host) as it was: planning only, nothing routed', async () => {
    seedNode();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const { unmount } = render(<CanvasSurface planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    fireEvent.change(box(), { target: { value: '加一个节点' } });
    fireEvent.click(panel().getByRole('button', { name: '修改画布' }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    expect(sidebar()!.querySelector('.awwo-assistant-route')).toBeNull();
    expect(loadPlanningConversation().messages.some(message => message.route)).toBe(false);
    unmount();
    render(<CanvasSurface readOnly planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(toggle()).toBeNull();
  });
});
