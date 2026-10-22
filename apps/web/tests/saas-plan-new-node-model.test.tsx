// A hosted canvas tells its planner the model the Agent nodes a plan adds take (the reader's choice for the canvas
// assistant, or "default"), which the planner sizes their tasks by (planning_limits.go), once it knows it, and applies a
// plan with the model its request named (the plan frame's newNodeModel, canvasPlan.ts planNewNodeModel): a resume's
// was chosen before the reader changed it, and its nodes take that one rather than the reader's choice now, which is
// read when the plan lands.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import type { AssistantExecutionHost } from '../src/canvas/assistantRouting';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { markPlanNewNodeModel, type CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { readModelPalette } from '../src/canvas/modelPalette';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// The palette's read, which one test holds back while the planner's own status is read.
vi.mock('../src/canvas/modelPalette', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas/modelPalette')>();
  return { ...actual, readModelPalette: vi.fn(actual.readModelPalette) };
});

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'qwen-fixture', name: 'Qwen fixture', runtime: 'openai-agents', provider: 'openai' },
    { id: 'opus-fixture', name: 'Claude Opus fixture', runtime: 'openai-agents', provider: 'anthropic' },
    { id: 'deepseek-fixture', name: 'DeepSeek fixture', runtime: 'openai-agents', provider: 'deepseek', userChosen: true }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] }] };
const runtimeReader = async () => ({ agents: [], models: [] });
const qwen = { runtime: 'pi', model: 'qwen-fixture' };

/** The assistant's host: the reader's choice once its catalogue is read (`read`), none chosen where `componentModel` is
 *  undefined. */
function host(componentModel?: { runtime: string; model: string }, read = true): AssistantExecutionHost {
  return { readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(), start: vi.fn(async () => 'task-1'), stop: vi.fn(async () => {}),
    finished: () => false, renderTask: id => <p>任务卡片 {id}</p>, renderEarlier: () => null, renderNotices: () => null, settings: null,
    ...(componentModel ? { componentModel } : {}), ...(read ? { componentModelRead: true } : {}) };
}
/** A plan adding one Agent node, its planner having sized it for `sizedFor` (unmarked where undefined); `held` keeps it
 *  until `land` is called. */
function planner(sizedFor?: string, held = false) {
  let land!: () => void;
  const landed = new Promise<void>(resolve => { land = resolve; });
  if (!held) land();
  const request = vi.fn<typeof requestCanvasPlan>(async () => {
    await landed;
    const plan: CanvasPlan = { version: 1, summary: '已添加一个节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '新节点' }] };
    if (sizedFor) markPlanNewNodeModel(plan, sizedFor);
    return plan;
  });
  return { request, land: () => act(async () => { land(); }) };
}
const router = vi.fn(async () => ({ route: 'plan' as const }));
const surface = (execution: AssistantExecutionHost, planRequest: ReturnType<typeof planner>['request']) =>
  <CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} assistantExecution={execution} routeAssistant={router} planRequest={planRequest} />;
/** Asks the empty canvas's assistant (its welcome) for a plan, once the palette is read where `palette` says so. */
async function ask(palette = true) {
  if (palette) {
    fireEvent.click(screen.getByRole('button', { name: '展开模型' }));
    await screen.findByRole('button', { name: '添加 Qwen fixture' });
  }
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '加一个节点' } });
  // The box sends once the canvas has checked for a plan it could resume.
  const send = screen.getByRole('button', { name: /^(发送|生成画布)$/ });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
}
async function added(): Promise<SessionNode> {
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  return loadDocumentWithStatus().doc.nodes[0] as SessionNode;
}
async function plan(execution: AssistantExecutionHost, planRequest: ReturnType<typeof planner>['request']): Promise<SessionNode> {
  render(surface(execution, planRequest));
  await ask();
  return added();
}
const runtimeReply = () => new Response(JSON.stringify(status));

beforeEach(() => {
  cleanup(); localStorage.clear(); resetAllSessions(); vi.restoreAllMocks(); router.mockClear(); localStorage.setItem('superclaw_locale', 'zh');
  configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 2);
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(emptyDocument()));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => String(input).endsWith('/runtime') ? runtimeReply() : new Response(JSON.stringify({ items: [] }))));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('names the reader’s choice to the planner, and puts the nodes a plan adds on the model the plan was sized for', async () => {
  const { request } = planner('opus-fixture');
  const node = await plan(host(qwen), request);
  expect(request.mock.calls[0][6]?.newNodeModel).toBe('qwen-fixture');
  // A resume's plan, sized for the model chosen before the reader switched: its node runs that one.
  expect([node.runtime, node.model]).toEqual(['openai-agents', 'opus-fixture']);
});

it('names the workspace default where the reader chose no model, and keeps a node sized for it there', async () => {
  const { request } = planner('default');
  const node = await plan(host(), request);
  expect(request.mock.calls[0][6]?.newNodeModel).toBe('default');
  expect([node.runtime, node.model]).toEqual(['', '']);
});

it('keeps a node sized for the default there, whatever the reader chose since', async () => {
  const node = await plan(host(qwen), planner('default').request);
  expect([node.runtime, node.model]).toEqual(['', '']);
});

it('puts the nodes of a plan that names no model on the reader’s choice now', async () => {
  const node = await plan(host(qwen), planner().request);
  expect([node.runtime, node.model]).toEqual(['openai-agents', 'qwen-fixture']);
});

// The reader may change the model while the plan is made: what it was sized for is checked against the choice then.
it('puts no node on a model only a user may choose once the reader has switched away from it while it planned', async () => {
  const { request, land } = planner('deepseek-fixture', true);
  const view = render(surface(host({ runtime: 'openai-agents', model: 'deepseek-fixture' }), request));
  await ask();
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][6]?.newNodeModel).toBe('deepseek-fixture');
  view.rerender(surface(host(qwen), request));
  await land();
  const node = await added();
  expect([node.runtime, node.model]).toEqual(['openai-agents', 'qwen-fixture']);
});

it('names no model before the host has read the reader’s choice, and puts the nodes on that choice once the plan lands', async () => {
  const { request, land } = planner(undefined, true);
  const view = render(surface(host(undefined, false), request));
  await ask();
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][6]?.newNodeModel).toBeUndefined();
  view.rerender(surface(host({ runtime: 'pi', model: 'opus-fixture' }), request));
  await land();
  const node = await added();
  expect([node.runtime, node.model]).toEqual(['openai-agents', 'opus-fixture']);
});

it('names no model before the canvas has read its palette', async () => {
  let reply!: () => void;
  const paletteRead = new Promise<void>(resolve => { reply = resolve; });
  const read = vi.mocked(readModelPalette).getMockImplementation()!;
  vi.mocked(readModelPalette).mockImplementationOnce(async (...args) => { await paletteRead; return read(...args); });
  const { request, land } = planner(undefined, true);
  render(surface(host(qwen), request));
  await ask(false);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][6]?.newNodeModel).toBeUndefined();
  await act(async () => { reply(); });
  fireEvent.click(screen.getByRole('button', { name: '展开模型' }));
  await screen.findByRole('button', { name: '添加 Qwen fixture' });
  await land();
  const node = await added();
  expect([node.runtime, node.model]).toEqual(['openai-agents', 'qwen-fixture']);
});
