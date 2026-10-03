import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { appearanceFixture } from './saas-appearance-fixture';
import { createFormNode, emptyDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { savePlanHandoff } from '../src/saas/planHandoff';
import { clearSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'recheck-tenant', name: 'Recheck workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'recheck-user', name: 'Tester', email: 'test@example.test', platformRole: 'user' }, tenants: [tenant] };
const ready = { available: true, configured: true, plannerAvailable: true, models: [{ id: 'fixture-model' }] };
const unavailable = { available: false, configured: true, models: [], reason: 'No configured runtime is available' };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const record = (id: string) => ({ id, tenantId: tenant.id, name: `Canvas ${id}`, version: 1, document: emptyDocument(), createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};

function server(document: CanvasDocument = emptyDocument()) {
  let runtime: (init: RequestInit) => Promise<Response> = async () => json(unavailable);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return runtime(init);
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    const canvas = /\/canvases\/([^/]+)$/.exec(url);
    if (canvas) return json({ ...record(canvas[1]), document });
    if (url.includes('/planner')) return json({ available: false, error: 'Unavailable' });
    return json({ items: [], available: false, models: [] });
  }));
  return { requests, runtime: (handler: typeof runtime) => { runtime = handler; },
    canvasReads: () => requests.filter(item => (!item.init.method || item.init.method === 'GET') && /\/canvases\/[^/]+$/.test(item.url)),
    // Editing the preserved request may autosave the document. A status check must never
    // plan, initialize nodes, or dispatch a graph/session, even when that save has completed.
    executionWrites: () => requests.filter(item => item.init.method && item.init.method !== 'GET'
      && !(item.init.method === 'PUT' && /\/canvases\/[^/]+$/.test(item.url))) };
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  localStorage.setItem('awwo.workmode.v1:recheck-user', 'dismissed');
  history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=first`);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('rechecks only runtime, keeps the editor and request, and never resumes planning by itself', async () => {
  const api = server();
  const scope = { user: identity.user.id, tenant: tenant.id, canvas: 'first' };
  savePlanHandoff(scope, '保留这个尚未运行的需求');
  render(<SaaSApp />);
  const recheck = await screen.findByRole('button', { name: '重新检查' });
  const input = screen.getByRole('textbox', { name: '画布需求' });
  await waitFor(() => expect(input).toHaveValue('保留这个尚未运行的需求'));
  fireEvent.change(input, { target: { value: '我继续修改后的需求' } });
  const pending = deferred(); const checks = vi.fn(() => pending.promise);
  api.runtime(checks);
  fireEvent.click(recheck); fireEvent.click(recheck);
  expect(screen.getByRole('button', { name: '正在检查…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  expect(checks).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(json(ready)));
  expect(screen.queryByText(/执行尚未就绪：/)).toBeNull();
  expect(screen.getByRole('textbox', { name: '画布需求' })).toBe(input);
  expect(input).toHaveValue('我继续修改后的需求');
  expect(api.canvasReads()).toHaveLength(1);
  expect(api.executionWrites()).toEqual([]);
});

it('allows an existing graph to run after a successful check without starting it', async () => {
  const api = server({ ...emptyDocument(), nodes: [createFormNode({ x: 0, y: 0 })] });
  api.runtime(async () => { throw new TypeError('offline'); });
  render(<SaaSApp />);
  const recheck = await screen.findByRole('button', { name: '重新检查' });
  const run = screen.getByRole('button', { name: /运行图/ });
  expect(run).toBeDisabled();
  api.runtime(async () => json(ready));
  fireEvent.click(recheck);
  await waitFor(() => expect(run).toBeEnabled());
  expect(api.canvasReads()).toHaveLength(1);
  expect(api.executionWrites()).toEqual([]);
});

it.each([null, { available: 'yes', configured: true, models: [{}] }, { ...ready, models: [] }, { ...ready, reason: 'No model is available to this workspace' }])('keeps execution blocked after an invalid or unavailable recheck: %j', async result => {
  const api = server({ ...emptyDocument(), nodes: [createFormNode({ x: 0, y: 0 })] });
  render(<SaaSApp />);
  const recheck = await screen.findByRole('button', { name: '重新检查' });
  api.runtime(async () => json(result));
  fireEvent.click(recheck);
  await waitFor(() => expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled());
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  expect(screen.getByText(/执行尚未就绪：/)).toBeVisible();
  expect(api.canvasReads()).toHaveLength(1);
  expect(api.executionWrites()).toEqual([]);
});

it('offers another check after network failure without losing text', async () => {
  const api = server();
  render(<SaaSApp />);
  const recheck = await screen.findByRole('button', { name: '重新检查' });
  const input = screen.getByRole('textbox', { name: '画布需求' });
  fireEvent.change(input, { target: { value: '不要丢掉这段输入' } });
  api.runtime(async () => { throw new TypeError('offline'); });
  fireEvent.click(recheck);
  await waitFor(() => expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled());
  expect(screen.getByText(/执行尚未就绪：/)).toHaveTextContent('暂时无法确认执行引擎状态，请重新检查');
  expect(input).toHaveValue('不要丢掉这段输入');
  expect(api.executionWrites()).toEqual([]);
});

it('aborts an old check when leaving and ignores its late successful response on the next canvas', async () => {
  const api = server();
  const first = render(<SaaSApp />);
  const recheck = await screen.findByRole('button', { name: '重新检查' });
  const pending = deferred(); let signal: AbortSignal | undefined;
  api.runtime(async init => { signal = init.signal ?? undefined; return pending.promise; });
  fireEvent.click(recheck);
  first.unmount();
  expect(signal?.aborted).toBe(true);
  api.runtime(async () => json(unavailable));
  history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=second`);
  render(<SaaSApp />);
  await screen.findByRole('button', { name: '重新检查' });
  await act(async () => pending.resolve(json(ready)));
  expect(screen.getByText('Canvas second')).toBeVisible();
  expect(screen.getByText(/执行尚未就绪：/)).toBeVisible();
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  expect(api.executionWrites()).toEqual([]);
});
