import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createSessionNode, emptyDocument, saveDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { persistCanvasDraft, readCanvasDrafts } from '../src/saas/canvasDraft';
import * as bridge from '../src/saas/canvasBridge';
import { appearanceFixture } from './saas-appearance-fixture';

const tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const cloudDocument = { ...emptyDocument(), updatedAt: 1, nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: 'Navigation fixture' }] };
const cloud = { id: 'canvas-a', tenantId: tenant.id, name: 'Team canvas', document: cloudDocument, version: 7, createdAt: '', updatedAt: '' };
const response = (value: unknown, status = 200) => Response.json(value, { status });
type Options = { role?: string; personal?: boolean; canvasRead?: () => Promise<Response>; runtimeRead?: () => Promise<Response>; write?: (init: RequestInit) => Promise<Response>; initialize?: () => Promise<Response> };
function server({ role = 'owner', personal = false, canvasRead, runtimeRead, write, initialize }: Options = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/me')) return response({ ...identity, tenants: [{ ...tenant, role }], personalCredentialsRequired: personal });
    if (url.endsWith('/auth/connections')) return response({ items: [], providers: [{ id: 'llmgate', name: 'LLM Gate', runtimes: ['pi', 'openai-agents'] }], required: true, purchaseURL: 'https://api.clawhunt.site/' });
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/runtime')) return runtimeRead ? runtimeRead() : response(personal
      ? { configured: true, available: false, plannerAvailable: false, reason: 'No configured runtime is available', models: [] }
      : { configured: true, available: true, model: 'fixture-model', models: [{ id: 'fixture-model' }] });
    if (url.endsWith('/initialize')) return initialize ? initialize() : response({ error: { message: 'Fixture initialization rejected' } }, 503);
    if (url.endsWith('/canvases/canvas-a')) {
      if (init.method === 'PUT') return write ? write(init) : response({ ...cloud, document: JSON.parse(String(init.body)).document, version: 8 });
      return canvasRead ? canvasRead() : response(cloud);
    }
    return response({ items: [], models: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const backLink = () => screen.getByRole('link', { name: '返回画布列表' });
async function ready() {
  await waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull());
  await waitFor(() => expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function'));
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  configureCanvasStorage(identity.user.id, tenant.id, cloud.id);
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); bridge.clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['owner', 'reader'])('offers a direct current-workspace return for a loaded %s canvas', async role => {
  const fetcher = server({ role }); render(<SaaSApp />);
  await waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull());
  expect(backLink()).toBeVisible(); expect(backLink()).toHaveAttribute('href', '/?tenant=tenant-a');
  expect(backLink().closest('[inert]')).toBeNull();
  expect(fetcher.mock.calls.some(([, init]) => init?.method && init.method !== 'GET')).toBe(false);
});

it('lets a signed-in owner without a personal key inspect, export and edit an existing canvas while execution remains unavailable', async () => {
  const fetcher = server({ personal: true }); render(<SaaSApp />); await ready();
  expect(await screen.findByText('尚未连接执行引擎')).toBeVisible();
  expect(screen.getByRole('link', { name: '连接执行引擎' })).toHaveAttribute('href', '/?tenant=tenant-a&canvas=canvas-a&account=engines');
  expect(screen.getByText('Navigation fixture')).toBeVisible();
  expect(screen.getByRole('button', { name: '导出画布 JSON' })).toBeEnabled();
  expect(backLink()).toHaveAttribute('href', '/?tenant=tenant-a');
  expect(screen.getByText(/画布仍可编辑/)).toBeVisible();
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  act(() => saveDocument({ ...cloudDocument, updatedAt: 2 }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/canvases/canvas-a') && init?.method === 'PUT')).toBe(true));
  expect(fetcher.mock.calls.some(([url, init]) => String(url).includes('/graph-runs') && init?.method === 'POST')).toBe(false);
});

it('keeps the old canvas editable and execution closed when the runtime-status request fails', async () => {
  const fetcher = server({ personal: true, runtimeRead: () => Promise.reject(new TypeError('offline')) });
  render(<SaaSApp />); await ready();
  expect(screen.getByText('Navigation fixture')).toBeVisible();
  expect(backLink()).toHaveAttribute('href', '/?tenant=tenant-a');
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /运行图/ })).toHaveAttribute('title', '暂时无法确认执行引擎状态。画布仍可编辑，请稍后刷新后再运行。');
  act(() => saveDocument({ ...cloudDocument, updatedAt: 2 }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/canvases/canvas-a') && init?.method === 'PUT')).toBe(true));
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/initialize') && init?.method === 'POST')).toBe(false);
});

it('does not offer execution when runtime health claims ready without a model catalog', async () => {
  const fetcher = server({ personal: true, runtimeRead: async () => response({ configured: true, available: true }) });
  render(<SaaSApp />); await ready();
  expect(screen.getByText('Navigation fixture')).toBeVisible();
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/initialize') && init?.method === 'POST')).toBe(false);
});

it.each(['owner', 'reader'])('keeps a return available while the %s canvas is loading or fails', async role => {
  let resolve!: (value: Response) => void;
  const fetcher = server({ role, canvasRead: () => new Promise(done => { resolve = done; }) }); render(<SaaSApp />);
  await screen.findByText('正在加载云端画布…');
  expect(backLink()).toBeVisible(); expect(backLink()).toHaveAttribute('href', '/?tenant=tenant-a');
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  await act(async () => resolve(response({ error: { message: 'Fixture unavailable' } }, 503)));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fixture unavailable');
  expect(backLink()).toBeVisible();
  expect(fetcher.mock.calls.some(([, init]) => init?.method && init.method !== 'GET')).toBe(false);
});

it('can return from draft recovery without discarding or uploading the local draft', async () => {
  persistCanvasDraft(canvasStorage(), 'previous-tab', cloud.version, { ...cloudDocument, updatedAt: 2 });
  const saved = readCanvasDrafts(canvasStorage());
  const fetcher = server(); render(<SaaSApp />);
  await screen.findByRole('heading', { name: '发现未同步的本机草稿' });
  expect(backLink()).toHaveAttribute('href', '/?tenant=tenant-a');
  // Suppress jsdom's unsupported full navigation; the link must not mutate data on click.
  backLink().addEventListener('click', event => event.preventDefault(), { once: true }); fireEvent.click(backLink());
  expect(readCanvasDrafts(canvasStorage())).toEqual(saved);
  expect(fetcher.mock.calls.some(([, init]) => init?.method && init.method !== 'GET')).toBe(false);
});

it('keeps the return outside locked canvas controls during node setup and after setup failure', async () => {
  let resolve!: (value: Response) => void;
  server({ initialize: () => new Promise(done => { resolve = done; }) }); render(<SaaSApp />); await ready();
  fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(screen.getByRole('button', { name: '配置' }));
  fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
  await waitFor(() => expect(document.querySelector('.awwo-account-controls')).toHaveAttribute('inert'));
  expect(backLink()).toBeVisible(); expect(backLink().closest('[inert]')).toBeNull();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  await act(async () => resolve(response({ error: { message: 'Fixture setup unavailable' } }, 503)));
  await waitFor(() => expect(document.querySelector('.awwo-account-controls')).not.toHaveAttribute('inert'));
  expect(backLink()).toBeVisible();
});

it('preserves the native unsaved-change guard until a pending save succeeds', async () => {
  let finish!: (value: Response) => void;
  server({ write: () => new Promise(done => { finish = done; }) }); render(<SaaSApp />); await ready();
  const leave = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(leave()).toBe(false);
  act(() => saveDocument({ ...cloudDocument, updatedAt: 2 }));
  expect(leave()).toBe(true); expect(backLink()).toBeVisible();
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(leave()).toBe(true);
  await act(async () => finish(response({ ...cloud, document: { ...cloudDocument, updatedAt: 2 }, version: 8 })));
  await waitFor(() => expect(leave()).toBe(false));
});

it('retains the leave warning and recoverable draft after a save failure', async () => {
  server({ write: async () => response({ error: { message: 'Fixture save failed' } }, 503) }); render(<SaaSApp />); await ready();
  act(() => saveDocument({ ...cloudDocument, updatedAt: 2 }));
  await screen.findByRole('alert');
  const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true); expect(backLink()).toBeVisible();
  expect(readCanvasDrafts(canvasStorage())[0].draft?.dirty).toBe(true);
});
