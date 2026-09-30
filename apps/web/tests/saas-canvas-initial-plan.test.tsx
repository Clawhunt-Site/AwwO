import { appearanceFixture } from './saas-appearance-fixture';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface, type InitialPlanRequest } from '../src/canvas/CanvasSurface';
import { createFormNode, emptyDocument, loadDocumentWithStatus, saveDocument } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { resetAllSessions } from '../src/canvas/sessions';
import * as bridge from '../src/saas/canvasBridge';
import { SaaSApp } from '../src/saas/SaaSApp';
import { savePlanHandoff, takePlanHandoff } from '../src/saas/planHandoff';

const tenant = { id: 'tenant-a', name: 'Workspace A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const ready = { available: true, configured: true, plannerAvailable: true, plannerRuntime: 'pi', models: [{ id: 'fixture-model' }] };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const plan: CanvasPlan = { version: 1, summary: '已规划数据治理与后端服务。', operations: [
  { type: 'add_node', ref: 'data', templateId: 'data', title: '数据治理', inputValues: { brief: '销售周报' } },
  { type: 'add_node', ref: 'backend', templateId: 'backend', title: '后端服务' },
  { type: 'connect', fromNode: 'data', fromField: 'schema', toNode: 'backend', toField: 'schema' },
] };
const PROMPT = '搭建销售周报流程：先统一口径，再汇总指标';
const box = () => screen.getByRole('textbox', { name: '画布需求' });

function deferredPlan() {
  let resolve!: (value: CanvasPlan) => void;
  const request = vi.fn<typeof requestCanvasPlan>(() => new Promise<CanvasPlan>(done => { resolve = done; }));
  return { request, resolve: (value: CanvasPlan) => resolve(value) };
}
function carried(value: Partial<Omit<InitialPlanRequest, 'claim' | 'done'>> = {}) {
  const claim = vi.fn(() => true);
  const done = vi.fn();
  return { request: { prompt: PROMPT, start: true, interrupted: false, ...value, claim, done } as InitialPlanRequest, claim, done };
}

afterEach(() => { cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe('a request carried to a new canvas', () => {
  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
    configureCanvasStorage('user-a', tenant.id, 'canvas-a');
    bridge.configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/runtime') ? reply(ready) : reply({ items: [], models: [] })));
  });

  it('is planned exactly once under StrictMode, never aborted by the simulated remount, and stays undoable', async () => {
    const pending = deferredPlan();
    const { request, claim, done } = carried();
    render(<StrictMode><CanvasSurface storageMode="cloud" planRequest={pending.request} initialPlan={request} /></StrictMode>);
    await waitFor(() => expect(pending.request).toHaveBeenCalledTimes(1));
    const [prompt, snapshot, , signal] = pending.request.mock.calls[0];
    expect(prompt).toBe(PROMPT);
    expect(snapshot.nodes).toHaveLength(0);
    expect(signal.aborted).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
    // The live status line of the existing planning flow reports the request.
    expect(screen.getByRole('status', { name: '规划进度' })).toHaveTextContent('正在提交需求');
    expect(done).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(plan); });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    expect(signal.aborted).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '撤销本次更改' })).toBeEnabled();
    expect(pending.request).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'the execution engine is not ready', reason: '先连接你的执行引擎。', runtime: ready, shown: '先连接你的执行引擎。' },
    { name: 'the planner reports it is unavailable', reason: undefined, runtime: { ...ready, plannerAvailable: false, reason: 'Fixture planner unavailable' }, shown: 'Fixture planner unavailable' },
  ])('stays in the box with the reason when $name', async ({ reason, runtime, shown }) => {
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/runtime') ? reply(runtime) : reply({ items: [], models: [] }));
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried();
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} executionUnavailableReason={reason} initialPlan={request} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(box()).toHaveValue(PROMPT);
    expect(screen.getByRole('alert')).toHaveTextContent(shown);
    expect(planRequest).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('never plans over a canvas that already has content', async () => {
    saveDocument({ ...emptyDocument(), nodes: [{ ...createFormNode({ x: 0, y: 0 }), id: 'brief' }] });
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried();
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(planRequest).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['brief']);
  });

  it('puts an interrupted request back in the box with a notice, and does not send it again', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried({ start: false, interrupted: true });
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(box()).toHaveValue(PROMPT);
    expect(screen.getByText('上次的规划没有应用到画布，需求已放回输入框，可以重新生成。')).toBeVisible();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(planRequest).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    // The operator can still send it on purpose.
    fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
    await waitFor(() => expect(planRequest).toHaveBeenCalledTimes(1));
    expect(planRequest.mock.calls[0][0]).toBe(PROMPT);
  });

  it('only restores an expired request without a notice', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, done } = carried({ start: false, interrupted: false });
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(box()).toHaveValue(PROMPT);
    expect(screen.queryByText(/上次的规划没有应用到画布/)).toBeNull();
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('waits for the planner status and leaves a request the operator edited meanwhile to them', async () => {
    let answer!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(input => String(input).endsWith('/runtime')
      ? new Promise<Response>(resolve => { answer = resolve; }) : Promise.resolve(reply({ items: [], models: [] })));
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried();
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await waitFor(() => expect(box()).toHaveValue(PROMPT));
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: `${PROMPT}，另外加一个前端` } });
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    await act(async () => { answer(reply(ready)); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(planRequest).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(box()).toHaveValue(`${PROMPT}，另外加一个前端`);
  });

  it('does not send a request another page already claimed', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried();
    claim.mockReturnValue(false);
    render(<CanvasSurface storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(planRequest).not.toHaveBeenCalled();
    expect(box()).toHaveValue(PROMPT);
  });

  it('is never read by a read-only canvas', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>();
    const { request, claim, done } = carried();
    render(<CanvasSurface readOnly storageMode="cloud" planRequest={planRequest} initialPlan={request} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(done).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
  });
});

describe('the hosted app carrying a home request through the real planning bridge', () => {
  const handoffScope = { user: 'user-a', tenant: 'tenant-a', canvas: 'canvas-a' };
  const frames = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  let cloud: { id: string; tenantId: string; name: string; document: unknown; version: number; createdAt: string; updatedAt: string };
  let planPosts: number;
  let events: (signal?: AbortSignal) => Response;

  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('superclaw_locale', 'zh');
    localStorage.setItem('awwo.onboarding.v1:user-a:workspace', 'completed');
    configureCanvasStorage('user-a', tenant.id, 'canvas-a');
    window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    // A saved camera keeps the surface from writing its first viewport, so the only saves are the plan's.
    cloud = { id: 'canvas-a', tenantId: tenant.id, name: '搭建销售周报流程', document: { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 } },
      version: 1, createdAt: '', updatedAt: '' };
    planPosts = 0;
    events = () => new Response(frames({ type: 'queued' }, { type: 'running' }, { type: 'completed', text: JSON.stringify(plan) }),
      { headers: { 'Content-Type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/appearance')) return reply(appearanceFixture);
      if (url.endsWith('/auth/me')) return reply(identity);
      if (url.endsWith('/runtime')) return reply(ready);
      if (url.endsWith('/graph-runs')) return reply({ items: [] });
      if (url.endsWith('/canvases/canvas-a/plan') && init.method === 'POST') { planPosts++; return reply({ id: 'plan-run' }, 202); }
      if (url.endsWith('/runs/plan-run/events')) return events(init.signal ?? undefined);
      if (url.endsWith('/runs/plan-run/cancel')) return reply({ id: 'plan-run', status: 'cancelled', terminal: true });
      if (url.endsWith('/canvases/canvas-a') && init.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        cloud = { ...cloud, document: body.document, version: cloud.version + 1 };
        return reply(cloud);
      }
      if (url.endsWith('/canvases/canvas-a')) return reply(cloud);
      return reply({ items: [], models: [] });
    }));
  });
  const remount = () => { cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); render(<StrictMode><SaaSApp /></StrictMode>); };

  it('sends one plan, applies it and forgets the request, so a remount sends none', async () => {
    savePlanHandoff(handoffScope, PROMPT);
    render(<StrictMode><SaaSApp /></StrictMode>);
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    expect(planPosts).toBe(1);
    await waitFor(() => expect(takePlanHandoff(handoffScope)).toBeNull());
    await waitFor(() => expect((cloud.document as { nodes: unknown[] }).nodes).toHaveLength(2));
    await waitFor(() => expect(document.querySelector('.saas-sync-pill.is-synced')).not.toBeNull());
    const planned = loadDocumentWithStatus().doc.nodes.map(node => node.id);
    remount();
    for (const id of planned) expect(await screen.findByTestId(`canvas-tile-${id}`)).toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(planPosts).toBe(1);
    expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(planned);
  });

  it('never sends the request a second time after the page is left mid-plan', async () => {
    // The run is accepted and then reports nothing, like a page left while the model is working.
    events = signal => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    savePlanHandoff(handoffScope, PROMPT);
    render(<StrictMode><SaaSApp /></StrictMode>);
    await waitFor(() => expect(planPosts).toBe(1));
    await waitFor(() => expect(takePlanHandoff(handoffScope)).toEqual({ prompt: PROMPT, start: false, interrupted: true }));
    remount();
    expect(await screen.findByText('上次的规划没有应用到画布，需求已放回输入框，可以重新生成。')).toBeVisible();
    expect(box()).toHaveValue(PROMPT);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(planPosts).toBe(1);
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
    expect(takePlanHandoff(handoffScope)).toBeNull();
  });
});
