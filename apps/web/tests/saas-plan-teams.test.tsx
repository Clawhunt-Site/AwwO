// A hosted canvas offers its planner set_team where its palette has a model ready on a runtime that runs teams, and the
// same answer lets a plan's set_team apply (CanvasSurface; sub-agent review 2026-10-25: nothing covered the flag, or its
// pass to applyCanvasPlan).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import type { AssistantExecutionHost } from '../src/canvas/assistantRouting';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { markPlanOffersTeams, type CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'qwen-fixture', name: 'Qwen fixture', runtime: 'openai-agents', provider: 'openai' }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] }] };
const host: AssistantExecutionHost = { readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(), start: vi.fn(async () => 'task-1'),
  stop: vi.fn(async () => {}), finished: () => false, renderTask: id => <p>任务卡片 {id}</p>, renderEarlier: () => null, renderNotices: () => null,
  settings: null, componentModel: { runtime: 'openai-agents', model: 'qwen-fixture' }, componentModelRead: true };
// What the hosted request marks on a plan whose request offered set_team (canvasPlanning.ts requestCanvasPlan).
const request = vi.fn<typeof requestCanvasPlan>(async () => {
  const plan: CanvasPlan = { version: 1, summary: '已添加一个团队节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '撰写' },
    { type: 'set_team', nodeId: 'a', template: 'draft-review' }] };
  markPlanOffersTeams(plan);
  return plan;
});

beforeEach(() => {
  cleanup(); localStorage.clear(); resetAllSessions(); vi.restoreAllMocks(); request.mockClear(); localStorage.setItem('superclaw_locale', 'zh');
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
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => new Response(JSON.stringify(String(input).endsWith('/runtime') ? status : { items: [] }))));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('offers set_team where the palette runs teams, and applies the plan’s team', async () => {
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} assistantExecution={host}
    routeAssistant={vi.fn(async () => ({ route: 'plan' as const }))} planRequest={request} />);
  fireEvent.click(screen.getByRole('button', { name: '展开模型' }));
  await screen.findByRole('button', { name: '添加 Qwen fixture' });
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '配一个撰写与审核团队' } });
  const send = screen.getByRole('button', { name: /^(发送|生成画布)$/ });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  expect(request.mock.calls[0][6]?.teams).toBe(true);
  const node = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect([node.runtime, node.model, node.team?.runtime, node.team?.members.map(member => member.name)])
    .toEqual(['openai-agents', 'qwen-fixture', 'openai-agents', ['撰写者', '审核者']]);
});
