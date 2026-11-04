// A lesson's suggested reasoning effort, applied on the canvas (CanvasSurface applyEvolution): a plan of the canvas
// plan protocol, put on the canvas as an AI change the reader can undo and the assistant's panel describes, once the
// canvas's palette is read; and why it applied nothing when it could not.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface, type CanvasEvolution } from '../src/canvas/CanvasSurface';
import type { AssistantExecutionHost } from '../src/canvas/assistantRouting';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, dropOverriddenEvolutionMarks, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { resetAllSessions, setStreaming } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'opus-fixture', name: 'Claude Opus fixture', runtime: 'openai-agents', provider: 'anthropic', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    { id: 'qwen-fixture', name: 'Qwen fixture', runtime: 'openai-agents', provider: 'openai' }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] }] };
const runtimeReader = async () => ({ agents: [], models: [] });
const page = (patch: Partial<SessionNode> = {}): SessionNode =>
  ({ ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'page', title: '生成页面', runtime: 'openai-agents', model: 'opus-fixture', effort: '', ...patch } as SessionNode);
const seed = (...nodes: SessionNode[]) => canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes, view: { x: 0, y: 0, scale: 1 } }));
const NOTE = '「生成页面」已经 2 次停在模型的输出上限，没有交付完。把它的推理强度调成 low，模型不变。';
const evolution = (patch: Partial<CanvasEvolution> = {}): CanvasEvolution => ({ id: 'lesson:l1:1', nodeId: 'page', effort: 'low', model: 'opus-fixture', note: NOTE, ...patch });
const stored = () => loadDocumentWithStatus().doc.nodes.find(item => item.id === 'page') as SessionNode | undefined;
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
const surface = (settled: (id: string, result: { applied: boolean; reason?: string }) => void, request: CanvasEvolution | null = null) =>
  <CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} evolution={request} onEvolutionSettled={settled} />;
let runtimeRead: () => Promise<Response>;

beforeEach(() => {
  cleanup(); localStorage.clear(); resetAllSessions(); vi.restoreAllMocks(); localStorage.setItem('superclaw_locale', 'zh');
  configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 2);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  runtimeRead = async () => new Response(JSON.stringify(status));
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => String(input).endsWith('/runtime') ? runtimeRead() : new Response(JSON.stringify({ items: [] }))));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('runs the node at the effort on the model it runs, as an AI change the assistant describes and the reader can undo', async () => {
  seed(page());
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution()));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ runtime: 'openai-agents', model: 'opus-fixture', effort: 'low' }));
  expect(sidebar().getByText(/把它的推理强度调成 low，模型不变/)).toBeVisible();
  // Once: the same request again changes nothing more.
  rerender(surface(settled, evolution()));
  expect(settled).toHaveBeenCalledTimes(1);
  fireEvent.click(await sidebar().findByRole('button', { name: '撤销本次更改' }));
  await waitFor(() => expect(stored()?.effort).toBe(''));
});

it('applies it to a node with outputs, clearing those it makes stale, as one AI change the reader can undo', async () => {
  // The canvas's own pass clears more than the plan's (a case delivery downstream of a cleared output), so the canvas
  // it keeps is not the plan's to the byte.
  const upstream = { ...page(), lastOutput: { text: 'PARTIAL', at: 1, source: 'run' } } as SessionNode;
  const downstream = { ...page({ id: 'review', title: '验收' }), x: 600, lastOutput: { text: 'CASE', at: 1, source: 'case' } } as SessionNode;
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [upstream, downstream], view: { x: 0, y: 0, scale: 1 },
    edges: [{ id: 'page-review', fromNode: 'page', fromPort: 'out:result', toNode: 'review', toPort: 'in:brief', dataType: 'text' }] }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution()));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ effort: 'low', lastOutput: null }));
  // The case delivery downstream went too, as any change upstream of it clears it.
  expect(loadDocumentWithStatus().doc.nodes.find(item => item.id === 'review')).toMatchObject({ lastOutput: null });
  expect(await sidebar().findByRole('button', { name: '撤销本次更改' })).toBeVisible();
});

it('puts a node on the workspace default on the model its lesson’s runs ran with, which takes the effort', async () => {
  seed(page({ runtime: '', model: '' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution()));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ runtime: 'openai-agents', model: 'opus-fixture', effort: 'low' }));
});

// A model only a user may choose (the DeepSeek API's, userChosenModels.ts) is one the canvas never puts a node on, but a
// node the reader set on one keeps it, and takes its lesson's effort there (live on 2026-11-04 the change was refused,
// the plan step naming the model the node already ran).
it('applies it to a node the reader set on a model only a user may choose, which stays on it, and never moves a node there', async () => {
  const chosen = { ...status, models: [...status.models, { id: 'deepseek-fixture', name: 'DeepSeek fixture', runtime: 'openai-agents', provider: 'deepseek',
    reasoningEfforts: ['low', 'medium', 'high'], userChosen: true }] };
  runtimeRead = async () => new Response(JSON.stringify(chosen));
  seed(page({ model: 'deepseek-fixture', effort: 'high' }));
  const settled = vi.fn();
  const { rerender, unmount } = render(surface(settled));
  rerender(surface(settled, evolution({ model: 'deepseek-fixture', expect: 'high', change: 'change-1' })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ runtime: 'openai-agents', model: 'deepseek-fixture', effort: 'low', evolution: { change: 'change-1' } }));
  unmount();
  // A node on the workspace default whose lesson's runs ran it is not put on it: it keeps the default, saying who picks it.
  cleanup(); localStorage.setItem('superclaw_locale', 'zh');
  seed(page({ runtime: '', model: '' }));
  const refused = vi.fn();
  const second = render(surface(refused));
  second.rerender(surface(refused, evolution({ id: 'lesson:l2:1', model: 'deepseek-fixture' })));
  await waitFor(() => expect(refused).toHaveBeenCalledWith('lesson:l2:1', expect.objectContaining({ applied: false,
    reason: expect.stringContaining('这个模型只能由你自己在节点设置里选，助手不替你选') })));
  expect(stored()).toMatchObject({ runtime: '', model: '', effort: '' });
});

it('waits for the canvas’s palette, and says why it applied nothing where there was nothing to apply', async () => {
  seed(page({ effort: 'low' }));
  let answer!: () => void;
  const held = new Promise<void>(resolve => { answer = resolve; });
  runtimeRead = async () => { await held; return new Response(JSON.stringify(status)); };
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution()));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).not.toHaveBeenCalled();
  answer();
  // Already so: nothing changes, and the suggestion counts as taken.
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: false, satisfied: true, reason: '这条建议没有改动画布：节点已经是这样运行的。' }));
  expect(stored()?.effort).toBe('low');
  // A node no longer on the canvas: the panel opened says so.
  rerender(surface(settled, evolution({ id: 'lesson:l1:2', nodeId: 'gone' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('lesson:l1:2', { applied: false, reason: '这个节点已经不在画布上，这条建议没有应用。' }));
  // Said in the assistant's conversation, under the suggestion's words.
  expect(await sidebar().findByText(/这个节点已经不在画布上，这条建议没有应用。/)).toBeVisible();
});

it('says why it applied nothing while a node is talking or when the palette could not be read, and takes nothing read only', async () => {
  seed(page());
  const settled = vi.fn();
  setStreaming('page', true);
  const { rerender, unmount } = render(surface(settled));
  rerender(surface(settled, evolution()));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: false, reason: '节点正在执行或连接，请结束后再修改画布。' }));
  // No turn of the conversation is in flight: said there, under the suggestion's words, where a later reply leaves it.
  expect(await sidebar().findByText(/节点正在执行或连接，请结束后再修改画布。/)).toBeVisible();
  setStreaming('page', false);
  unmount();
  // The palette could not be read: its reason.
  runtimeRead = async () => new Response(JSON.stringify({ error: { code: 'internal_error', message: 'down' } }), { status: 500 });
  const second = vi.fn();
  const again = render(surface(second));
  again.rerender(surface(second, evolution({ id: 'lesson:l1:2' })));
  await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  expect(second.mock.calls[0][1].applied).toBe(false);
  expect(second.mock.calls[0][1].reason).toBeTruthy();
  again.unmount();
  expect(stored()?.effort).toBe('');
  // Read only: the request is not taken at all.
  runtimeRead = async () => new Response(JSON.stringify(status));
  const fourth = vi.fn();
  render(<CanvasSurface readOnly storageMode="cloud" runtimeReadJson={runtimeReader} evolution={evolution({ id: 'lesson:l1:4' })} onEvolutionSettled={fourth} />);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fourth).not.toHaveBeenCalled();
});

// A change the canvas's evolution claimed from one effort (`expect`) is made only on a node still at it: a person who
// changed the node since keeps their change.
it('leaves a node changed since its change was claimed as it is, and makes it on one still as claimed', async () => {
  seed(page({ effort: 'high' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ id: 'evolution:1', expect: '' })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('evolution:1', { applied: false, reason: '这个节点的推理强度在这之后改过了，这项调整没有应用。' }));
  expect(stored()?.effort).toBe('high');
  rerender(surface(settled, evolution({ id: 'evolution:2', expect: 'high' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:2', { applied: true }));
  await waitFor(() => expect(stored()?.effort).toBe('low'));
});

// A change of the canvas's evolution marks the node it makes with its id, which the server records it by: undone with
// the plan, and never on a suggestion of the 经验 panel's own.
it('marks the node a change of the canvas’s evolution makes, and only that', async () => {
  seed(page(), page({ id: 'brief', title: '简报' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ id: 'evolution:1', expect: '', change: 'aChange1' })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('evolution:1', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ effort: 'low', evolution: { change: 'aChange1' } }));
  fireEvent.click(await sidebar().findByRole('button', { name: '撤销本次更改' }));
  await waitFor(() => expect(stored()?.effort).toBe(''));
  expect(stored()?.evolution).toBeUndefined();
  rerender(surface(settled, evolution({ id: 'lesson:l1:2', nodeId: 'brief' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('lesson:l1:2', { applied: true }));
  const brief = () => loadDocumentWithStatus().doc.nodes.find(item => item.id === 'brief') as SessionNode | undefined;
  await waitFor(() => expect(brief()?.effort).toBe('low'));
  expect(brief()?.evolution).toBeUndefined();
});

// The mark goes once anything but its change sets the node's effort (a person, a plan, the panel's own suggestion): the
// change no longer stands.
it('takes the mark away when anything but its change sets the node’s effort', async () => {
  seed(page());
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ id: 'evolution:1', expect: '', change: 'aChange1' })));
  await waitFor(() => expect(stored()).toMatchObject({ effort: 'low', evolution: { change: 'aChange1' } }));
  rerender(surface(settled, evolution({ id: 'lesson:l1:3', effort: 'medium' })));
  await waitFor(() => expect(stored()?.effort).toBe('medium'));
  expect(stored()?.evolution).toBeUndefined();
});

it('takes off only a mark whose node’s effort something else changed', () => {
  const marked = page({ effort: 'low', evolution: { change: 'a1' } });
  const doc = { ...emptyDocument(), nodes: [marked] };
  const renamed = { ...doc, nodes: [{ ...marked, title: '另一个名字' }] };
  expect(dropOverriddenEvolutionMarks(doc, renamed)).toBe(renamed);
  expect(dropOverriddenEvolutionMarks(doc, { ...doc, nodes: [{ ...marked, effort: 'high' }] }).nodes[0]).not.toHaveProperty('evolution');
  // Its own plan sets the effort and the mark together.
  expect(dropOverriddenEvolutionMarks(doc, { ...doc, nodes: [{ ...marked, effort: '', evolution: { change: 'a2' } }] }).nodes[0])
    .toMatchObject({ effort: '', evolution: { change: 'a2' } });
  expect(dropOverriddenEvolutionMarks(doc, doc)).toBe(doc);
});

// A change claimed is made only on a node whose effort nothing set since its claim, even back to the same value, on the
// page's monotonic clock: a system clock set back meanwhile changes nothing.
it('keeps the times of claims and edits on a clock a system clock set back does not move', async () => {
  seed(page({ effort: 'high' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  const claimed = performance.now();
  // The system clock goes back an hour, and the node goes to medium and back.
  const wall = Date.now();
  const now = vi.spyOn(Date, 'now').mockReturnValue(wall - 3_600_000);
  try {
    rerender(surface(settled, evolution({ id: 'lesson:l1:7', effort: 'medium' })));
    await waitFor(() => expect(stored()?.effort).toBe('medium'));
    rerender(surface(settled, evolution({ id: 'lesson:l1:8', effort: 'high' })));
    await waitFor(() => expect(stored()?.effort).toBe('high'));
    rerender(surface(settled, evolution({ id: 'evolution:9', effort: 'low', expect: 'high', since: claimed, change: 'aChange9' })));
    await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:9', { applied: false, reason: '这个节点的推理强度在这之后改过了，这项调整没有应用。' }));
  } finally { now.mockRestore(); }
});

// A change claimed is made only on a node whose effort nothing set since its claim, even back to the same value.
it('leaves a node whose effort was set since its change was claimed, even back to the same value', async () => {
  seed(page({ effort: 'high' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  const claimed = performance.now();
  // Meanwhile the node goes to medium and back to high (here by suggestions of the panel's own).
  rerender(surface(settled, evolution({ id: 'lesson:l1:5', effort: 'medium' })));
  await waitFor(() => expect(stored()?.effort).toBe('medium'));
  rerender(surface(settled, evolution({ id: 'lesson:l1:6', effort: 'high' })));
  await waitFor(() => expect(stored()?.effort).toBe('high'));
  rerender(surface(settled, evolution({ id: 'evolution:1', effort: 'low', expect: 'high', since: claimed, change: 'aChange1' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:1', { applied: false, reason: '这个节点的推理强度在这之后改过了，这项调整没有应用。' }));
  expect(stored()?.effort).toBe('high');
  // One claimed after those edits is made.
  rerender(surface(settled, evolution({ id: 'evolution:2', effort: 'low', expect: 'high', since: performance.now(), change: 'aChange2' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:2', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ effort: 'low', evolution: { change: 'aChange2' } }));
});

// A revert is made only on a node the change it takes back still marks: a person's own edit since took the mark away.
it('takes back a change only from a node that change still marks', async () => {
  seed(page({ effort: 'low', evolution: { change: 'aChange1' } }), page({ id: 'brief', title: '简报', effort: 'low' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ id: 'evolution:1', nodeId: 'brief', effort: '', expect: 'low', expectMark: 'aChange1', change: 'aRevert0' })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('evolution:1', { applied: false, reason: '这个节点的推理强度在这之后改过了，这项调整没有应用。' }));
  rerender(surface(settled, evolution({ id: 'evolution:2', effort: '', expect: 'low', expectMark: 'aChange1', change: 'aRevert1' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:2', { applied: true }));
  await waitFor(() => expect(stored()).toMatchObject({ effort: '', evolution: { change: 'aRevert1' } }));
  const brief = loadDocumentWithStatus().doc.nodes.find(item => item.id === 'brief') as SessionNode | undefined;
  expect(brief?.effort).toBe('low');
});

// A change its host took back before the canvas came to it (it waited too long, or the page left) is dropped unsaid.
it('drops unsaid a change its host took back before the canvas came to it', async () => {
  seed(page());
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ id: 'evolution:1', expect: '', wanted: () => false })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('evolution:1', { applied: false }));
  expect(stored()?.effort).toBe('');
  expect(document.body.textContent).not.toContain('把它的推理强度调成 low');
  rerender(surface(settled, evolution({ id: 'evolution:2', expect: '', wanted: () => true })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('evolution:2', { applied: true }));
  await waitFor(() => expect(stored()?.effort).toBe('low'));
});

it('leaves a node whose model has no such effort as it was, saying so', async () => {
  seed(page({ model: 'qwen-fixture', effort: '' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ model: 'qwen-fixture' })));
  await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  expect(settled.mock.calls[0][1]).toMatchObject({ applied: false, reason: expect.stringContaining('没有「low」这档思考强度') });
  expect(settled.mock.calls[0][1].satisfied).toBeUndefined();
  expect(stored()).toMatchObject({ model: 'qwen-fixture', effort: '' });
});

it('refuses, without touching the canvas, a suggestion with no model for a node on the default, and one it cannot make a plan of', async () => {
  seed(page({ runtime: '', model: '' }));
  const settled = vi.fn();
  const { rerender } = render(surface(settled));
  rerender(surface(settled, evolution({ model: '' })));
  await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:l1:1', { applied: false, reason: '这条建议没有写明节点该用的模型，没有应用。先给节点选好模型，再应用一次。' }));
  expect(await sidebar().findByText(/这条建议没有写明节点该用的模型，没有应用。先给节点选好模型，再应用一次。/)).toBeVisible();
  // An effort the plan protocol refuses: the canvas stays up and says so.
  rerender(surface(settled, evolution({ id: 'lesson:l1:2', effort: 'LOW!' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('lesson:l1:2', { applied: false, reason: '这条建议没法按节点现在的设置应用。' }));
  expect(stored()).toMatchObject({ runtime: '', model: '', effort: '' });
  expect(document.querySelector('.canvas-root')).not.toBeNull();
});

// A refusal while a turn of the conversation is in flight (a message being handled) shows where a plan's refusal would,
// and joins the conversation with the next thing a suggestion says, rather than being lost to it.
it('holds a refusal made while a message is handled, and says it with the next reply', async () => {
  seed(page());
  let start!: (task: string) => void;
  const starting = new Promise<string>(resolve => { start = resolve; });
  const host: AssistantExecutionHost = { readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(), start: vi.fn(() => starting), stop: vi.fn(async () => {}),
    finished: () => false, renderTask: id => <p>任务卡片 {id}</p>, renderEarlier: () => null, renderNotices: () => null, settings: null, componentModelRead: true };
  const router = vi.fn(async () => ({ route: 'execute' as const }));
  const settled = vi.fn();
  const view = (request: CanvasEvolution | null) =>
    <CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} assistantExecution={host} routeAssistant={router} evolution={request} onEvolutionSettled={settled} />;
  const { rerender } = render(view(null));
  fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true }));
  const box = await sidebar().findByRole('textbox', { name: '画布需求' });
  fireEvent.change(box, { target: { value: '写一封邮件' } });
  const send = sidebar().getByRole('button', { name: '发送' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(host.start).toHaveBeenCalled());
  rerender(view(evolution({ nodeId: 'gone' })));
  await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  expect(settled.mock.calls[0][1].applied).toBe(false);
  const reason = settled.mock.calls[0][1].reason as string;
  // Held: shown where a plan's refusal would, and not in the conversation yet.
  const said = (text: string) => sidebar().queryAllByText(content => content.includes(text));
  expect(said('已经 2 次停在模型的输出上限')).toHaveLength(0);
  expect(await sidebar().findByText(reason)).toBeVisible();
  await act(async () => { start('task-1'); });
  rerender(view(evolution({ id: 'lesson:l1:2' })));
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith('lesson:l1:2', { applied: true }));
  // Both said now, the held refusal first; and it no longer shows apart.
  await waitFor(() => expect(said(reason).length).toBeGreaterThanOrEqual(1));
  expect(said('已经 2 次停在模型的输出上限').length).toBeGreaterThanOrEqual(2);
});
