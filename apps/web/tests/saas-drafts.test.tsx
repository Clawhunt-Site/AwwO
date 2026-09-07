import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, saveDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { acknowledgeCanvasDraft, persistCanvasDraft, readCanvasDrafts } from '../src/saas/canvasDraft';

const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [{ id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const documentWith = (title: string) => ({ ...emptyDocument(), updatedAt: 1, view: { x: 0, y: 0, scale: 1 }, nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title }] });
const record = (document = documentWith('云端原文'), version = 7) => ({ id: 'canvas-a', tenantId: 'tenant-a', name: '团队画布', document, version, createdAt: '', updatedAt: '' });
const reconnect = () => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); render(<SaaSApp />); };
const writerReady = async () => waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull());
beforeEach(() => {
  localStorage.clear(); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); });

it('reload_after_409 retains the local draft, blocks the editor and never overwrites the newer cloud version', async () => {
  let cloud = record(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { writes++; cloud = record(documentWith('其他页面的新内容'), 8); return response({ error: { code: 'conflict', message: 'Changed elsewhere' } }, 409); }
    return response(cloud);
  }));
  render(<SaaSApp />); await writerReady();
  act(() => { saveDocument(documentWith('409 后必须保留的修改')); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画布已在另一页面更新'));
  expect(readCanvasDrafts(canvasStorage())[0].draft).toMatchObject({ baseVersion: 7, dirty: true, document: { nodes: [{ title: '409 后必须保留的修改' }] } });
  reconnect();
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '导出未同步草稿' })).toBeVisible();
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toContain('409 后必须保留的修改');
  expect(document.querySelector('.awwo-workspace')).toBeNull();
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '使用云端版本，保留草稿' }));
  await writerReady();
  expect(readCanvasDrafts(canvasStorage())[0].draft?.document.nodes[0].title).toBe('409 后必须保留的修改');
  expect(writes).toBe(1);
});

it('network_failure preserves an exportable draft across reload even while the cloud remains unreachable', async () => {
  let offline = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { offline = true; throw new TypeError('network unavailable'); }
    if (offline) throw new TypeError('cloud offline');
    return response(record());
  }));
  render(<SaaSApp />); await writerReady();
  act(() => { saveDocument(documentWith('断网后保留的工作')); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存失败'));
  reconnect();
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  expect(screen.getByRole('button', { name: '导出未同步草稿' })).toBeVisible();
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
  expect(readCanvasDrafts(canvasStorage())[0].draft?.document.nodes[0].title).toBe('断网后保留的工作');
  expect(document.querySelector('.awwo-workspace')).toBeNull();
});

it('successful_save_clears_draft and StrictMode reload of a saved document does not report a recovery or write a duplicate', async () => {
  let cloud = record(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { const body = JSON.parse(init.body as string); cloud = record(body.document, body.version + 1); writes++; }
    return response(cloud);
  }));
  render(<StrictMode><SaaSApp /></StrictMode>); await writerReady();
  act(() => { saveDocument(cloud.document); });
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  act(() => { saveDocument(documentWith('已经确认保存的内容')); });
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
  await waitFor(() => expect(readCanvasDrafts(canvasStorage())).toHaveLength(0));
  expect(writes).toBe(1);
  expect(cloud.document.nodes[0].title).toBe('已经确认保存的内容');
  cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); render(<StrictMode><SaaSApp /></StrictMode>);
  await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(writes).toBe(1);
  cloud = record(documentWith('另一设备后来保存的新版本'), 9);
  reconnect(); await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toContain('另一设备后来保存的新版本');
  expect(writes).toBe(1);
});

it('explicitly restores a same-version draft and only removes its source after the restored content is saved', async () => {
  persistCanvasDraft(canvasStorage(), 'previous-editor', 7, documentWith('待恢复的真实内容'));
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { writes++; const body = JSON.parse(init.body as string); expect(body.document.nodes[0].title).toBe('待恢复的真实内容'); expect(body.version).toBe(7); return response(record(body.document, 8)); }
    return response(record());
  }));
  render(<SaaSApp />);
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeEnabled());
  expect(writes).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: '恢复草稿并继续同步' }));
  await writerReady();
  await waitFor(() => expect(readCanvasDrafts(canvasStorage())).toHaveLength(0));
  expect(writes).toBe(1);
});

it('retains edits made during an in-flight save when the older revision is acknowledged', async () => {
  let resolveSave!: (value: Response) => void;
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { writes++; if (writes === 1) return new Promise<Response>(resolve => { resolveSave = resolve; }); throw new TypeError('network interrupted'); }
    return response(record());
  }));
  render(<SaaSApp />); await writerReady();
  const first = documentWith('已发出的版本');
  act(() => { saveDocument(first); });
  await waitFor(() => expect(writes).toBe(1));
  act(() => { saveDocument(documentWith('请求期间继续编辑的新版本')); });
  await act(async () => { resolveSave(response(record(first, 8))); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存失败'));
  expect(readCanvasDrafts(canvasStorage())[0].draft).toMatchObject({ baseVersion: 8, dirty: true, document: { nodes: [{ title: '请求期间继续编辑的新版本' }] } });
});

it('isolates draft writers and user/tenant/canvas scopes, including a late acknowledgement using the captured scope', () => {
  const a = canvasStorage();
  const first = persistCanvasDraft(a, 'tab-a', 7, documentWith('标签页 A'));
  persistCanvasDraft(a, 'tab-b', 7, documentWith('标签页 B'));
  expect(readCanvasDrafts(a)).toHaveLength(2);
  for (const scope of [['user-b', 'tenant-a', 'canvas-a'], ['user-a', 'tenant-b', 'canvas-a'], ['user-a', 'tenant-a', 'canvas-b']]) {
    configureCanvasStorage(scope[0], scope[1], scope[2]);
    expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  }
  const b = canvasStorage();
  persistCanvasDraft(b, 'tab-a', 2, documentWith('另一画布'));
  acknowledgeCanvasDraft(a, first, 8);
  expect(readCanvasDrafts(a)).toHaveLength(1);
  expect(readCanvasDrafts(a)[0].draft?.document.nodes[0].title).toBe('标签页 B');
  expect(readCanvasDrafts(b)[0].draft?.document.nodes[0].title).toBe('另一画布');
});

it('protects a divergent legacy cache without a run journal and requires explicit confirmation to discard it', async () => {
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(documentWith('旧缓存中未同步的修改')));
  canvasStorage().setItem('awwo.cloud.version', '7');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/runtime') ? response({ available: false, models: [] }) : response(record(documentWith('更新的云端内容'), 8))));
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '丢弃这份本机草稿' }));
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '确认丢弃' }));
  await writerReady();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toContain('更新的云端内容');
});
