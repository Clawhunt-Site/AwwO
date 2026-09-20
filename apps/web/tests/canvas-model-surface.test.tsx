import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { MODEL_DRAG_MIME } from '../src/canvas/canvasModelDrop';
import * as jev from '../src/canvas/jevPlanning';
import { presentationNodes } from '../src/canvas/nodePresentation';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'qwen-fixture', name: 'Qwen fixture', runtime: 'pi', provider: 'openai' }],
  runtimes: [{ id: 'pi', name: 'Pi', configured: true, available: true, tools: [] }] };
const runtimeReader = async () => ({ agents: [], models: [] });

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(emptyDocument()));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = String(input);
    return new Response(JSON.stringify(url.endsWith('/runtime') ? status : url.endsWith('/typesafe')
      ? { provider: 'typesafe', configured: true, enabled: true, canEvaluate: true, model: 'jev-test', questionTypes: ['choice'], limits: { maxQuestions: 16, maxRequestBytes: 65536 } }
      : { items: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('adds a selected persona on a real catalog model with generic inputs, and undoes it as one action', async () => {
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} />);
  fireEvent.click(screen.getByText('人设预设'));
  fireEvent.click(screen.getByRole('radio', { name: '前端开发' }));
  fireEvent.click(await screen.findByRole('button', { name: '添加 Qwen fixture · Pi' }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  const node = loadDocumentWithStatus().doc.nodes[0];
  expect(node).toMatchObject({ runtime: 'pi', model: 'qwen-fixture', effort: '', templateId: 'general', binding: null });
  if (node.kind !== 'session') throw new Error('Expected session');
  expect(node.persona).toContain('前端页面');
  expect(node.contract!.inputs.filter(field => field.required).map(field => field.id)).toEqual(['brief']);
  fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0));
});

it('drops only same-workspace model identities and uses viewport coordinates', async () => {
  let deliverResize = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { deliverResize = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  const { container } = render(<CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} />);
  await screen.findByRole('button', { name: '添加 Qwen fixture · Pi' });
  const stage = container.querySelector('.awwo-stage-canvas')!;
  const root = container.querySelector('.canvas-root')!;
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 60, top: 120, width: 900, height: 600, x: 60, y: 120, right: 960, bottom: 720, toJSON() {} });
  const transfer = (scope: string) => ({ types: [MODEL_DRAG_MIME], getData: () => JSON.stringify({ version: 1, scope, key: '["pi","qwen-fixture"]', personaId: null }) });
  fireEvent.drop(stage, { dataTransfer: transfer('other-workspace'), clientX: 260, clientY: 320 });
  expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
  fireEvent.drop(stage, { dataTransfer: transfer('workspace'), clientX: 260, clientY: 320 });
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ runtime: 'pi', model: 'qwen-fixture' });
  const focusedView = (container.querySelector('.canvas-world') as HTMLElement).style.transform;
  vi.spyOn(container.querySelector('.canvas-viewport')!, 'getBoundingClientRect').mockReturnValue(root.getBoundingClientRect());
  act(() => deliverResize());
  expect((container.querySelector('.canvas-world') as HTMLElement).style.transform).toBe(focusedView);
});

it('selects Jev independently of execution models and cancellation cannot apply a late plan', async () => {
  let resolve!: (value: jev.JevPlanResult) => void;
  const jevRequest = vi.spyOn(jev, 'requestJevPlan').mockImplementation(() => new Promise(done => { resolve = done; }));
  const apply = vi.spyOn(jev, 'applyJevPlan');
  const piRequest = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} planRequest={piRequest} />);
  await waitFor(() => expect((screen.getByRole('option', { name: 'Jev', exact: true }) as HTMLOptionElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole('combobox', { name: '编排模型' }), { target: { value: 'jev' } });
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '整理产品需求' } });
  fireEvent.click(screen.getByRole('button', { name: '新增工作流' }));
  await waitFor(() => expect(jevRequest).toHaveBeenCalledOnce());
  expect(piRequest).not.toHaveBeenCalled();
  const signal = jevRequest.mock.calls[0][3];
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
  expect(signal.aborted).toBe(true);
  resolve({ plan: { version: 1, summary: 'Late result', operations: [] } } as unknown as jev.JevPlanResult);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue('整理产品需求'));
  expect(apply).not.toHaveBeenCalled();
  expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
});

it('does not expose writable model/persona controls in a reader canvas', () => {
  render(<CanvasSurface readOnly storageMode="cloud" runtimeReadJson={runtimeReader} />);
  expect(screen.queryByRole('complementary', { name: '模型与人设' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '编排模型' })).toBeNull();
});

it('keeps a dragged model visible after undoing a plan back to the welcome screen', async () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.classList.contains('canvas-root')) return originalRect.call(this);
    const width = document.querySelector('.awwo-planner-sidebar') ? 620 : 950;
    return { left: 60, top: 138, width, height: 550, x: 60, y: 138, right: 60 + width, bottom: 688, toJSON() {} };
  });
  const planRequest = vi.fn().mockResolvedValue({ version: 1, summary: 'Fixture plan', operations: [
    { type: 'add_node', ref: 'one', templateId: 'general', title: 'Fixture task', inputValues: { brief: 'Fixture' } },
  ] });
  const { container } = render(<CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} planRequest={planRequest} />);
  await screen.findByRole('button', { name: '添加 Qwen fixture · Pi' });
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: 'Fixture request' } });
  fireEvent.click(screen.getByRole('button', { name: '生成画布', exact: true }));
  await screen.findByRole('button', { name: '撤销本次更改', exact: true });
  fireEvent.click(screen.getByRole('button', { name: '撤销本次更改', exact: true }));
  expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
  fireEvent.drop(container.querySelector('.awwo-stage-canvas')!, {
    dataTransfer: { types: [MODEL_DRAG_MIME], getData: () => JSON.stringify({ version: 1, scope: 'workspace', key: '["pi","qwen-fixture"]', personaId: null }) },
    clientX: 970, clientY: 630,
  });
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  expect(container.querySelector('.awwo-planner-sidebar')).toBeNull();
  const doc = loadDocumentWithStatus().doc;
  const card = presentationNodes(doc.nodes, doc.nodes[0].id)[0];
  const transform = (container.querySelector('.canvas-world') as HTMLElement).style.transform;
  const [x, y, scale] = transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/i)!.slice(1).map(Number);
  expect(x + card.x * scale).toBeGreaterThanOrEqual(0);
  expect(x + (card.x + card.w) * scale).toBeLessThanOrEqual(950);
  expect(y + card.y * scale).toBeGreaterThanOrEqual(0);
  expect(y + (card.y + card.h) * scale).toBeLessThanOrEqual(550);
});
