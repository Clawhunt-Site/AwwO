import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface, type InitialPlanRequest } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { TaskStartUnconfirmed, type AssistantExecutionHost, type AssistantRoute, type AssistantRouteRequest } from '../src/canvas/assistantRouting';
import { emptyDocument, loadDocumentWithStatus, saveDocument } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import { loadPlanningConversation, savePlanningConversation, type requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions, setStreaming } from '../src/canvas/sessions';

// Where the host also does tasks, the assistant is one conversation and the server routes each message: these
// check how the canvas sends it, follows the route, draws the turn and hands a request over to the other way.
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
const KEPT = '上面的画布更改没有自动撤销：当时画布正忙、任务是否开始还没确认，或画布已有新的改动。';

function fakeHost(overrides: Partial<AssistantExecutionHost> = {}) {
  let ended = false;
  const host: AssistantExecutionHost = {
    readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(),
    start: vi.fn(async () => 'task-1'),
    stop: vi.fn(async () => {}),
    finished: () => ended,
    renderTask: id => <p>任务卡片 {id}</p>,
    renderEarlier: (mentioned, open) => <p data-testid="earlier" data-open={String(open)}>{`提到的任务：${[...mentioned].join(',') || '无'}`}</p>,
    renderNotices: () => <p>任务服务提示</p>,
    settings: <p>直接执行用的模型</p>,
    ...overrides,
  };
  return { host, end: () => { ended = true; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
const routeTo = (route: AssistantRoute) => vi.fn(async (_request: AssistantRouteRequest, _signal: AbortSignal) => route);
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(panel().getByRole('button', { name: '发送' }));
};

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
    expect(host.start).toHaveBeenCalledExactlyOnceWith('写一封给客户的道歉邮件');
    const request = router.mock.calls[0][0];
    expect(request).toEqual({ message: '写一封给客户的道歉邮件', routes: ['plan', 'execute'],
      canvas: { nodes: 1, titles: ['已有节点'], results: false }, recent: [] });
    expect(planRequest).not.toHaveBeenCalled();
    expect(sidebar()!.querySelector('.awwo-assistant-route')).toHaveTextContent('直接执行');
    const stored = loadPlanningConversation();
    expect(stored.messages.map(({ role, route, taskId }) => ({ role, route, taskId }))).toEqual([
      { role: 'user', route: 'execute', taskId: undefined }, { role: 'assistant', route: 'execute', taskId: 'task-1' }]);
    expect(stored.draft).toBe('');
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
    await waitFor(() => expect(panel().getByText('已添加一个节点。')).toBeVisible());
    const reply = panel().getByText('已添加一个节点。').closest('li')!;
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
    const router = vi.fn((_request: AssistantRouteRequest, given: AbortSignal) => { signal = given; return new Promise<AssistantRoute>(() => {}); });
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
    const router = vi.fn((_request: AssistantRouteRequest, given: AbortSignal) => { signal = given; return new Promise<AssistantRoute>(() => {}); });
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
    // The refused request is in the conversation, so it can still be handed to the canvas.
    expect(panel().getByRole('button', { name: '改为调整画布' })).toBeEnabled();
  });

  it('records a start whose outcome is unknown as unconfirmed, never planned over or sent again', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(box()).toHaveValue('');
    expect(panel().queryByRole('button', { name: '改为调整画布' })).toBeNull();
    expect(panel().queryByRole('alert')).toBeNull();
    expect(loadPlanningConversation().messages.at(-1)).toMatchObject({ role: 'assistant', route: 'execute', status: 'unconfirmed' });
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
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith('加一个审核节点'));
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
    fireEvent.click(await panel().findByRole('button', { name: '改为直接执行' }));
    expect(host.start).toHaveBeenCalledExactlyOnceWith('写一份发布说明');
    // The plan stays until its task exists.
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().getByText('正在创建任务')).toBeVisible();
    await act(async () => { starting.resolve('task-1'); });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['node-a']));
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(panel().getByText(UNDONE)).toBeVisible();
    expect(userRoutes()).toEqual(['plan', 'execute']);
    // The new turn is the latest; it offers the canvas again.
    expect(panel().getByRole('button', { name: '改为调整画布' })).toBeEnabled();
  });

  it('keeps the plan and says why where a hand-over to a task cannot start', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new Error('工作区正忙：它一次只运行一个任务。'); }) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '改为直接执行' }));
    expect(await panel().findByText('工作区正忙：它一次只运行一个任务。')).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(userRoutes()).toEqual(['plan']);
    expect(panel().getByRole('button', { name: '改为直接执行' })).toBeEnabled();
  });

  it('hands a task over to the canvas, stopping it first while it still runs, and only once', async () => {
    seedNode();
    const stopping = deferred<void>();
    const { host } = fakeHost({ stop: vi.fn(() => stopping.promise) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    const button = panel().getByRole('button', { name: '改为调整画布' });
    // Two presses before the page redraws: the second finds the first under way.
    act(() => { button.click(); button.click(); });
    expect(host.stop).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(panel().getByRole('status')).toHaveTextContent('正在停止任务');
    expect(panel().queryByRole('button', { name: '取消' })).toBeNull();
    expect(planRequest).not.toHaveBeenCalled();
    await act(async () => { stopping.resolve(); });
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(planRequest.mock.calls[0][0]).toBe('把三个节点并行');
    expect(host.stop).toHaveBeenCalledOnce();
    expect(userRoutes()).toEqual(['execute', 'plan']);
    // The second press was simply not taken: nothing says the canvas was busy.
    expect(panel().queryByText('画布现在没法处理这个请求，请稍后再试。')).toBeNull();
  });

  it('hands a planned request over to a task once, however often the switch is pressed', async () => {
    seedNode();
    const starting = deferred<string>();
    const { host } = fakeHost({ start: vi.fn(() => starting.promise) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    const button = await panel().findByRole('button', { name: '改为直接执行' });
    act(() => { button.click(); button.click(); });
    expect(host.start).toHaveBeenCalledOnce();
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
    fireEvent.click(panel().getByRole('button', { name: '改为调整画布' }));
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
    fireEvent.click(panel().getByRole('button', { name: '改为调整画布' }));
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
    render(<CanvasSurface assistantExecution={host} routeAssistant={vi.fn(async () => route)} planRequest={planRequest} />);
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

  it('does not turn a message too long to plan into a task: it says so, keeps it, and offers the task instead', async () => {
    seedNode();
    const { host } = fakeHost();
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const long = '字'.repeat(2700); // 8100 bytes; the planner takes at most 8000.
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send(long);
    expect(await panel().findByText('这条消息太长，没法用来调整画布（最多约 8000 字节）。请精简后再发，或改为直接执行。')).toBeVisible();
    expect(planRequest).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
    expect(box()).toHaveValue(long);
    fireEvent.click(panel().getByRole('button', { name: '改为直接执行' }));
    await waitFor(() => expect(host.start).toHaveBeenCalledExactlyOnceWith(long));
    // Handed over, it leaves the box, so Enter does not send it a second time.
    await waitFor(() => expect(box()).toHaveValue(''));
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
    fireEvent.click(await panel().findByRole('button', { name: '改为直接执行' }));
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
    const button = await panel().findByRole('button', { name: '改为直接执行' });
    act(() => setStreaming('node-a', true));
    fireEvent.click(button);
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
    fireEvent.click(panel().getByRole('button', { name: '改为直接执行' }));
    expect(await panel().findByText('任务卡片 task-1')).toBeVisible();
    expect(host.start).toHaveBeenCalledExactlyOnceWith('写一份发布说明');
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1);
    expect(panel().queryByText(KEPT)).toBeNull();
    expect(panel().getAllByText(UNDONE)).toHaveLength(1);
  });

  it('offers no hand-over to a task once a redo brings back a plan the assistant can no longer undo', async () => {
    seedNode();
    const { host } = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '撤销本次更改' }));
    expect(await panel().findByRole('button', { name: '改为直接执行' })).toBeEnabled();
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: true });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    expect(panel().queryByRole('button', { name: '改为直接执行' })).toBeNull();
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

  it('says the task was stopped when the canvas became busy meanwhile', async () => {
    seedNode();
    const stopping = deferred<void>();
    const { host } = fakeHost({ stop: vi.fn(() => stopping.promise) });
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('把三个节点并行');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    fireEvent.click(panel().getByRole('button', { name: '改为调整画布' }));
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
    const routing = deferred<AssistantRoute>();
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
    await act(async () => { routing.resolve('execute'); });
    expect(await screen.findByText('任务卡片 task-1')).toBeVisible();
    expect(host.start).toHaveBeenCalledExactlyOnceWith('做一个落地页');
    expect(planRequest).not.toHaveBeenCalled();
    expect(userRoutes()).toEqual(['execute']);
  });

  it('says a plan stays on the canvas while the task handed it over is unconfirmed', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) });
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('plan')} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('写一份发布说明');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    fireEvent.click(await panel().findByRole('button', { name: '改为直接执行' }));
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    expect(panel().getByText(KEPT)).toBeVisible();
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
    expect(panel().queryByText(UNDONE)).toBeNull();
  });

  it('gives a start reconciled later its task, in place of the unconfirmed request', async () => {
    seedNode();
    const { host } = fakeHost({ start: vi.fn(async () => { throw new TaskStartUnconfirmed('连接中断'); }) });
    const router = routeTo('execute');
    const { rerender } = render(<CanvasSurface assistantExecution={host} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    expect(await panel().findByText(UNCONFIRMED)).toBeVisible();
    rerender(<CanvasSurface assistantExecution={{ ...host, confirmedTask: 'task-7' }} routeAssistant={router} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(await panel().findByText('任务卡片 task-7')).toBeVisible();
    expect(panel().queryByText(UNCONFIRMED)).toBeNull();
    expect(loadPlanningConversation().messages.at(-1)).toEqual({ id: expect.any(String), role: 'assistant', content: '', route: 'execute', taskId: 'task-7' });
    // The task's switch is offered again: it is known now.
    expect(panel().getByRole('button', { name: '改为调整画布' })).toBeEnabled();
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
