import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { CanvasList } from '../src/saas/CanvasList';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, emptyDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { preserveThreadRuntime } from '../src/canvas/nodeThreads';
import { CANVAS_MIRROR_GROUP, canvasStorage, configureCanvasStorage, keepLegacyCanvasCache, preserveRegisteredLegacyCache, setCanvasStoreForTests } from '../src/canvas/canvasStorage';
import { createCanvasStore } from '../src/canvas/canvasStore';
import { CARD_FRAMES_KEY } from '../src/canvas/cardFrames';
import { PLANNING_STORAGE_KEY } from '../src/canvas/canvasPlanning';
import { CANVAS_BASELINE_KEY, CANVAS_DRAFT_PREFIX, readCanvasDrafts, rememberCanvasBaseline } from '../src/saas/canvasDraft';
import { moveLegacyCanvasStorage } from '../src/saas/canvasStoreSweep';
import * as bridge from '../src/saas/canvasBridge';
import type { Tenant } from '../src/saas/api';
import { channelHub, countedLocks, memoryBackend, quotaStorage, settle } from './saas-canvas-store-fakes';

// The hosted canvas on the canvas store (IndexedDB stood in for), against a browser-sized localStorage.
const QUOTA = 5_242_880; // Chrome's localStorage: 10 MiB of UTF-16 for the whole site.
const A = 'awwo.saas:user-a:tenant-a:canvas-a:';
const identity = (role = 'owner') => ({ user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: 'Workspace A', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const record = (document: CanvasDocument, version = 7) => ({ id: 'canvas-a', tenantId: 'tenant-a', name: 'Canvas', document, version, createdAt: '', updatedAt: '' });
/** A PALLWARD-sized canvas: one node holding 1.9 million characters of output. */
function largeDocument(title = 'PALLWARD'): CanvasDocument {
  const node = { ...preserveThreadRuntime(createAgentTemplate('backend', { x: 0, y: 0 }), createAgentTemplate('backend', { x: 0, y: 0 })), title,
    lastOutput: { text: 'x'.repeat(1_900_000), at: 1, source: 'run' as const } };
  return { ...emptyDocument(), updatedAt: 123456, view: { x: 0, y: 0, scale: 1 }, nodes: [node] };
}
async function writerReady() {
  await waitFor(() => {
    expect(document.querySelector('.awwo-workspace')).not.toBeNull();
    expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function');
  }, { timeout: 5000 });
  return vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall![0]!;
}
function serve(cloud: { current: ReturnType<typeof record> }, puts: CanvasDocument[], role = 'owner') {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/artifacts')) return response({ items: [] });
    if (url.endsWith('/auth/me')) return response(identity(role));
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      puts.push(body.document); cloud.current = record(body.document, body.version + 1);
    }
    return response(cloud.current);
  }));
}
/** Other canvases an earlier release left behind: about 85% of the site's localStorage. */
function fillWithOtherCanvases(storage: Storage) {
  for (const id of ['old-1', 'old-2', 'old-3', 'old-4']) {
    storage.setItem(`awwo.saas:user-a:tenant-a:${id}:superclaw.canvas.v2`, JSON.stringify({ ...emptyDocument(), filler: 'y'.repeat(1_100_000) }));
    storage.setItem(`awwo.saas:user-a:tenant-a:${id}:awwo.cloud.version`, '3');
  }
}
const canvasKeys = (storage: Storage, prefix: string) => Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter(key => key.startsWith(prefix));

let local: ReturnType<typeof quotaStorage>;
let backend: ReturnType<typeof memoryBackend>;
let idle: Array<() => void>;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
/** A page's canvas store as the hosted app makes it (canvasStorage.ts), on the test's IndexedDB stand-in. */
function useStore() {
  Object.defineProperty(navigator.locks, 'query', { configurable: true, value: async () => ({ held: [], pending: [] }) });
  const store = createCanvasStore({ backend: async () => backend.backend, channel: channelHub().channel, locks: countedLocks().locks,
    legacy: local.storage, keepLegacy: keepLegacyCanvasCache, mirrorGroup: CANVAS_MIRROR_GROUP, preserveLegacy: preserveRegisteredLegacyCache,
    flushDelay: 5, peerWait: 100, watchPage: false });
  setCanvasStoreForTests(store);
  return store;
}
beforeEach(() => {
  local = quotaStorage(QUOTA); backend = memoryBackend(); idle = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local.storage });
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  localStorage.setItem('superclaw_locale', 'zh'); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return idle.length; });
});
afterEach(() => {
  cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
  setCanvasStoreForTests(null);
  Object.defineProperty(globalThis, 'localStorage', original);
  delete (navigator.locks as { query?: unknown }).query;
});

it('opens, edits and saves a PALLWARD-sized canvas with localStorage nearly full, without the storage warning', async () => {
  useStore(); fillWithOtherCanvases(localStorage);
  const used = local.used();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); const flush = await writerReady();
  const changed = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: 'PALLWARD 改过' })) };
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await flush(); });
  expect(puts).toHaveLength(1);
  expect(puts[0].nodes[0].title).toBe('PALLWARD 改过');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('已同步')).toBeVisible();
  // The canvas is in the store, its draft released after the save; localStorage took none of it.
  const storage = canvasStorage();
  expect(JSON.parse(storage.getItem(CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('PALLWARD 改过');
  expect(readCanvasDrafts(storage)).toHaveLength(0);
  expect(canvasKeys(localStorage, A)).toEqual([]);
  expect(local.used() - used).toBeLessThan(200); // Preferences only (the UI mode).
  await act(async () => { await settle(); });
  expect(JSON.parse(backend.value(A + CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('PALLWARD 改过');
  // While idle, the page moves the other canvases out of localStorage into the store.
  expect(idle).toHaveLength(1);
  await act(async () => { idle[0](); await settle(); });
  // Only the small records a page of the earlier release may still read stay (here, each version).
  await waitFor(() => expect(canvasKeys(localStorage, 'awwo.saas:user-a:tenant-a:old-').map(key => key.split(':').slice(4).join(':')))
    .toEqual(Array(4).fill('awwo.cloud.version')));
  expect(local.used()).toBeLessThan(500);
  expect(backend.value('awwo.saas:user-a:tenant-a:old-2:superclaw.canvas.v2')).not.toBeNull();
  expect(backend.value('awwo.saas:user-a:tenant-a:old-2:awwo.cloud.version')).toBe('3');
});

it('moves the canvas an earlier release kept in localStorage into the store on its first opening', async () => {
  useStore();
  const document = largeDocument('迁移前');
  configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  const legacy = canvasStorage(); // Not open yet: this writes localStorage, as the earlier release did.
  legacy.setItem(CANVAS_STORAGE_KEY, JSON.stringify(document)); legacy.setItem('awwo.cloud.version', '7');
  rememberCanvasBaseline(legacy, 7, document);
  legacy.setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: '下一步', messages: [] }));
  // A frame of the canvas's own node, so the canvas's save of its card frames keeps it.
  localStorage.setItem(A + CARD_FRAMES_KEY, JSON.stringify({ [document.nodes[0].id]: { w: 500, h: 400 } }));
  expect(canvasKeys(localStorage, A)).toHaveLength(5);
  const cloud = { current: record(document) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  // Past the canvas's 300 ms save of its card frames, which writes localStorage.
  await act(async () => { await settle(); await new Promise(resolve => setTimeout(resolve, 400)); });
  // The document and its sync proof left localStorage; the version and planning record are copied (a page of the
  // earlier release may still read them), and the card frames are not the store's.
  expect(canvasKeys(localStorage, A).sort()).toEqual([A + CARD_FRAMES_KEY, A + 'awwo.cloud.version', A + PLANNING_STORAGE_KEY].sort());
  expect(backend.value(A + CARD_FRAMES_KEY)).toBeNull();
  expect(JSON.parse(canvasStorage().getItem(PLANNING_STORAGE_KEY)!).draft).toBe('下一步');
  expect(backend.value(A + CANVAS_BASELINE_KEY)).not.toBeNull();
  expect(JSON.parse(backend.value(A + CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('迁移前');
  expect(puts).toEqual([]);
});

it('offers for recovery an edit an earlier release\'s tab kept only in its cache, after this release wrote the canvas', async () => {
  const first = useStore();
  const cloud = { current: record(largeDocument('云端')) };
  serve(cloud, []);
  render(<SaaSApp />); await writerReady();
  await act(async () => { await settle(); await first.flush(); });
  cleanup();
  // A tab of the earlier release, still open, edits; its draft write fails on the full localStorage, so the edit is
  // only in its cache.
  const edited = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '只在旧缓存里' })) };
  localStorage.setItem(A + CANVAS_STORAGE_KEY, JSON.stringify(edited)); localStorage.setItem(A + 'awwo.cloud.version', '7');
  // The next visit: a new page over the same IndexedDB.
  useStore();
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' }, { timeout: 5000 })).toBeVisible();
  expect(readCanvasDrafts(canvasStorage()).map(saved => saved.draft?.document.nodes[0].title)).toEqual(['只在旧缓存里']);
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('云端');
  // Its base is not known (the earlier release's tabs share one version key, here the cloud's own 7): export only.
  expect(screen.getByText(/这是旧版本页面留在本机的画布副本/)).toBeVisible();
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '导出未同步草稿' })).toBeEnabled();
});

it('keeps an unsaved draft an earlier release left in localStorage and offers it for recovery', async () => {
  useStore();
  const saved = largeDocument('云端');
  const edited = { ...saved, nodes: saved.nodes.map(node => ({ ...node, title: '本机未同步的修改' })) };
  localStorage.setItem(A + `${CANVAS_DRAFT_PREFIX}old-writer`, JSON.stringify({ schemaVersion: 1, writerId: 'old-writer', revision: 'r1', baseVersion: 7,
    dirty: true, updatedAt: 5, document: edited }));
  serve({ current: record(saved) }, []);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' }, { timeout: 5000 })).toBeVisible();
  await act(async () => { await settle(); });
  expect(readCanvasDrafts(canvasStorage()).map(item => item.draft?.document.nodes[0].title)).toEqual(['本机未同步的修改']);
  expect(canvasKeys(localStorage, A)).toEqual([]);
});

it('without IndexedDB, a full localStorage on the first opening shows the canvas and the warning instead of failing', async () => {
  setCanvasStoreForTests(createCanvasStore({ backend: async () => null, watchPage: false }));
  fillWithOtherCanvases(localStorage);
  const used = local.used();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); const flush = await writerReady();
  expect(await screen.findByRole('alert')).toHaveTextContent('本机存储空间已满');
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
  expect(screen.getByText('未同步', { exact: true })).toBeVisible();
  // The canvas reads from this page's memory; autosave waits for the export or reload the warning asks for.
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('PALLWARD');
  await expect(flush()).rejects.toThrow('画布未同步');
  expect(puts).toEqual([]);
  expect(canvasKeys(localStorage, A)).toEqual([]);
  expect(local.used() - used).toBeLessThan(200);
});

it('pauses autosave behind the warning when IndexedDB itself is full', async () => {
  useStore();
  backend.failWith(new DOMException('full disk', 'QuotaExceededError'));
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); const flush = await writerReady();
  expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('本机存储空间已满');
  await expect(flush()).rejects.toThrow('画布未同步');
  expect(puts).toEqual([]);
});

it('saves an edit the API first answers as busy, after waiting its turn, without an error', async () => {
  useStore();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  const saved = vi.mocked(fetch).getMockImplementation()!;
  let busy = 2;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT' && busy > 0) { busy -= 1; return response({ error: { code: 'canvas_save_busy', message: 'Canvas saves are busy; try again shortly' } }, 503); }
    return saved(url, init);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const changed = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '忙时修改' })) };
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await flush(); });
  expect(busy).toBe(0);
  expect(puts).toHaveLength(1);
  expect(puts[0].nodes[0].title).toBe('忙时修改');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('已同步')).toBeVisible();
}, 15000);

it('counts busy answers per edit: an edit made while another waited its turn gets its own three', async () => {
  useStore();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  const saved = vi.mocked(fetch).getMockImplementation()!;
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = () => response({ error: { code: 'canvas_save_busy', message: 'Canvas saves are busy; try again shortly' } }, 503);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method !== 'PUT') return saved(url, init);
    calls += 1;
    if (calls <= 3 || calls === 5) return busy();
    if (calls === 4) await gate; // the first edit's last send, answered once the second edit is made
    return saved(url, init);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const titled = (title: string) => ({ ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title })) });
  act(() => { expect(saveDocument(titled('第一次'))).toBe(true); });
  let first!: Promise<unknown>;
  act(() => { first = flush(); });
  await waitFor(() => expect(calls).toBe(4), { timeout: 15000 });
  act(() => { expect(saveDocument(titled('第二次'))).toBe(true); });
  release();
  await act(async () => { await first; });
  expect(calls).toBe(6);
  expect(puts.map(document => document.nodes[0].title)).toEqual(['第一次', '第二次']);
  expect(screen.queryByRole('alert')).toBeNull();
}, 30000);

it('stops waiting for a turn after three busy answers and says the save failed, keeping the draft', async () => {
  useStore();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  const saved = vi.mocked(fetch).getMockImplementation()!;
  let tries = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method !== 'PUT') return saved(url, init);
    tries += 1;
    return response({ error: { code: 'canvas_save_busy', message: 'Canvas saves are busy; try again shortly' } }, 503);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const changed = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '一直忙' })) };
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await expect(flush()).rejects.toThrow('画布未同步'); });
  expect(tries).toBe(4);
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败：Canvas saves are busy');
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
}, 20000);

it('counts a save reply without the saved canvas as no save, and keeps the draft', async () => {
  useStore();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  const saved = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'PUT' ? new Response('', { status: 200 }) : saved(url, init)));
  render(<SaaSApp />); const flush = await writerReady();
  const changed = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '未确认' })) };
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await expect(flush()).rejects.toThrow('画布未同步'); });
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败：服务器没有返回保存结果');
  expect(screen.getByRole('alert')).not.toHaveTextContent('本机草稿保存失败');
  expect(readCanvasDrafts(canvasStorage()).map(draft => draft.draft?.document.nodes[0].title)).toEqual(['未确认']);
});

it('says a canvas over the 8 MB save limit is too large, keeping the edit on this device', async () => {
  useStore();
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  const saved = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'PUT'
    ? response({ error: { code: 'body_too_large', message: 'Request body is too large' } }, 413) : saved(url, init)));
  render(<SaaSApp />); const flush = await writerReady();
  const changed = { ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '太大了' })) };
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await expect(flush()).rejects.toThrow('画布未同步'); });
  expect(screen.getByRole('alert')).toHaveTextContent('画布超过 8 MB 的单次保存上限');
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
});

it('keeps a reader\'s copy in memory: the read-only canvas writes nothing to browser storage', async () => {
  useStore(); fillWithOtherCanvases(localStorage);
  const used = local.used();
  serve({ current: record(largeDocument('只读')) }, [], 'reader');
  render(<SaaSApp />);
  await waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull(), { timeout: 5000 });
  expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  await act(async () => { await settle(); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(canvasKeys(localStorage, 'awwo.saas:user-a:tenant-a:canvas-a')).toEqual([]);
  expect(local.used() - used).toBeLessThan(200);
  expect([...backend.records.keys()].filter(key => key.includes('read-only'))).toEqual([]);
});

it('deleting a canvas removes what this browser kept of it, after the server has deleted it', async () => {
  useStore();
  const zero = 'awwo.saas:user-a:tenant-a:canvas-1:';
  localStorage.setItem(zero + CANVAS_STORAGE_KEY, '{"nodes":[]}');
  localStorage.setItem(zero + CARD_FRAMES_KEY, '{}');
  localStorage.setItem(zero + 'awwo.execution.pending-submission.v1', '{}');
  localStorage.setItem('awwo.saas:user-a:tenant-a:canvas-1%2Fread-only:' + CANVAS_STORAGE_KEY, '{"nodes":[]}');
  localStorage.setItem('awwo.saas:user-a:tenant-a:canvas-10:' + CANVAS_STORAGE_KEY, 'keep');
  await backend.backend.write([{ k: 'awwo.saas:user-a:tenant-a:canvas-10:' + CANVAS_STORAGE_KEY, v: 'keep in IndexedDB', c: 2, p: 'q', t: Date.now() }]);
  await backend.backend.write([{ k: zero + `${CANVAS_DRAFT_PREFIX}w`, v: 'draft', c: 2, p: 'q', t: Date.now() }]);
  let removed = false; let deletes = 0;
  const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
  const item = (i: number) => ({ id: `canvas-${i}`, tenantId: 'tenant-a', name: `Canvas ${i}`, version: 1, document: { nodes: [] }, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') { deletes++; if (deletes === 1) return response({ error: { code: 'resource_in_use', message: 'Active run' } }, 409); removed = true; return new Response(null, { status: 204 }); }
    return response({ items: removed ? [item(10)] : [item(1), item(10)], nextCursor: null });
  }));
  render(<SaaSPreferencesProvider><CanvasList userId="user-a" tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '画布选项：Canvas 1' }));
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  // A refused deletion leaves everything in place.
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(canvasKeys(localStorage, zero)).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Canvas 1' })).toBeNull());
  await act(async () => { await settle(); });
  expect(canvasKeys(localStorage, zero)).toEqual([]);
  expect(canvasKeys(localStorage, 'awwo.saas:user-a:tenant-a:canvas-1%2F')).toEqual([]);
  expect(localStorage.getItem('awwo.saas:user-a:tenant-a:canvas-10:' + CANVAS_STORAGE_KEY)).toBe('keep');
  expect(backend.value('awwo.saas:user-a:tenant-a:canvas-10:' + CANVAS_STORAGE_KEY)).toBe('keep in IndexedDB');
  expect(backend.value(zero + `${CANVAS_DRAFT_PREFIX}w`)).toBeNull();
});

it('moves other canvases out of localStorage, leaving unsent drafts and runs of the last day for their own opening and dropping reader copies', async () => {
  useStore();
  const settled = 'awwo.saas:user-a:tenant-a:settled:';
  const drafting = 'awwo.saas:user-a:tenant-a:drafting:';
  const running = 'awwo.saas:user-b:tenant-b:running:';
  const ranLong = 'awwo.saas:user-b:tenant-b:ran-long:';
  const reader = 'awwo.saas:user-a:tenant-a:shared%2Fread-only:';
  const journal = (startedAt: number) => JSON.stringify({ version: 1, id: 'run-1', startedAt, scope: ['n1'], nodes: {} });
  localStorage.setItem(A + CANVAS_STORAGE_KEY, 'current canvas');
  localStorage.setItem(settled + CANVAS_STORAGE_KEY, 'settled doc');
  localStorage.setItem(settled + CANVAS_BASELINE_KEY, 'proof');
  localStorage.setItem(settled + CARD_FRAMES_KEY, 'frames');
  localStorage.setItem(drafting + CANVAS_STORAGE_KEY, 'drafting doc');
  localStorage.setItem(drafting + `${CANVAS_DRAFT_PREFIX}w`, 'unsent');
  localStorage.setItem(running + CANVAS_STORAGE_KEY, 'running doc');
  localStorage.setItem(running + 'awwo.canvas.active-run.v1.lane1', journal(Date.now() - 3600 * 1000));
  // A run record over a day old: no tab of the earlier release is still on that run.
  const longOver = journal(Date.now() - 25 * 3600 * 1000);
  localStorage.setItem(ranLong + CANVAS_STORAGE_KEY, 'doc of a run long over');
  localStorage.setItem(ranLong + 'awwo.canvas.active-run.v1', longOver);
  localStorage.setItem(reader + CANVAS_STORAGE_KEY, 'reader copy');
  localStorage.setItem('awwo.saas:user-a:tenant-a:awwo.canvas.planning.duration.v1', '40');
  await moveLegacyCanvasStorage(A);
  expect(localStorage.getItem(A + CANVAS_STORAGE_KEY)).toBe('current canvas');
  expect(canvasKeys(localStorage, settled)).toEqual([settled + CARD_FRAMES_KEY]);
  expect(backend.value(settled + CANVAS_STORAGE_KEY)).toBe('settled doc');
  expect(backend.value(settled + CANVAS_BASELINE_KEY)).toBe('proof');
  expect(canvasKeys(localStorage, drafting)).toHaveLength(2);
  expect(canvasKeys(localStorage, running)).toHaveLength(2);
  expect(backend.value(running + CANVAS_STORAGE_KEY)).toBeNull();
  expect(backend.value(running + 'awwo.canvas.active-run.v1.lane1')).toBeNull();
  // Its document moves; its run record is copied and stays, as the store's copied records do.
  expect(canvasKeys(localStorage, ranLong)).toEqual([ranLong + 'awwo.canvas.active-run.v1']);
  expect(backend.value(ranLong + CANVAS_STORAGE_KEY)).toBe('doc of a run long over');
  expect(backend.value(ranLong + 'awwo.canvas.active-run.v1')).toBe(longOver);
  expect(canvasKeys(localStorage, reader)).toEqual([]);
  expect(backend.value(reader + CANVAS_STORAGE_KEY)).toBeNull();
  expect(localStorage.getItem('awwo.saas:user-a:tenant-a:awwo.canvas.planning.duration.v1')).toBe('40');
});

it('without IndexedDB, opening the canvas again in the same page keeps the warning and autosave paused', async () => {
  setCanvasStoreForTests(createCanvasStore({ backend: async () => null, watchPage: false }));
  fillWithOtherCanvases(localStorage);
  const cloud = { current: record(largeDocument()) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); await writerReady();
  expect(await screen.findByRole('alert')).toHaveTextContent('本机存储空间已满');
  // Back to the workspace and into the same canvas again, in this page: its copy is still in memory only.
  cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null);
  vi.mocked(bridge.configureSaaSCanvasSave).mockClear();
  render(<SaaSApp />); const flush = await writerReady();
  expect(await screen.findByRole('alert')).toHaveTextContent('本机存储空间已满');
  act(() => { saveDocument({ ...cloud.current.document, nodes: cloud.current.document.nodes.map(node => ({ ...node, title: '再次打开后的修改' })) }); });
  await expect(flush()).rejects.toThrow('画布未同步');
  expect(puts).toEqual([]);
});

it('without IndexedDB, a full localStorage still offers the unsent draft it holds', async () => {
  setCanvasStoreForTests(createCanvasStore({ backend: async () => null, watchPage: false }));
  const saved = largeDocument('云端');
  const edited = { ...saved, nodes: saved.nodes.map(node => ({ ...node, title: '本机未同步的修改' })) };
  localStorage.setItem(A + `${CANVAS_DRAFT_PREFIX}old-writer`, JSON.stringify({ schemaVersion: 1, writerId: 'old-writer', revision: 'r1', baseVersion: 7,
    dirty: true, updatedAt: 5, document: edited }));
  for (const id of ['old-1', 'old-2', 'old-3']) localStorage.setItem(`awwo.saas:user-a:tenant-a:${id}:superclaw.canvas.v2`, 'y'.repeat(1_100_000));
  serve({ current: record(saved) }, []);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' }, { timeout: 5000 })).toBeVisible();
  expect(readCanvasDrafts(canvasStorage()).map(item => item.draft?.document.nodes[0].title)).toEqual(['本机未同步的修改']);
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
});
