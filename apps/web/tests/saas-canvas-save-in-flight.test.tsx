import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createSessionNode, emptyDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { CANVAS_MIRROR_GROUP, canvasStorage, configureCanvasStorage, keepLegacyCanvasCache, preserveRegisteredLegacyCache, setCanvasStoreForTests } from '../src/canvas/canvasStorage';
import { CANVAS_STORE_CHANNEL, createCanvasStore } from '../src/canvas/canvasStore';
import { readCanvasDrafts } from '../src/saas/canvasDraft';
import * as bridge from '../src/saas/canvasBridge';
import { channelHub, countedLocks, memoryBackend, quotaStorage, settle } from './saas-canvas-store-fakes';

// A hosted canvas's saves when its page closes with one out (the reply never comes, the server stores it anyway), and
// autosave's pace on a slow, big canvas. Found by the signed-in production check of 2026-10-19 on a 142-node canvas.
const A = 'awwo.saas:user-a:tenant-a:canvas-a:';
const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const record = (document: CanvasDocument, version = 7) => ({ id: 'canvas-a', tenantId: 'tenant-a', name: 'Canvas', document, version, createdAt: '', updatedAt: '' });
/** One node at `x`, carrying `filler` characters of output (a big canvas's weight: autosave paces from 1 million). */
const documentAt = (title: string, x = 0, filler = 0): CanvasDocument => ({ ...emptyDocument(), updatedAt: 1, view: { x: 0, y: 0, scale: 1 },
  nodes: [{ ...createSessionNode('llm', { x, y: 0 }), id: 'node-a', title, ...(filler ? { lastOutput: { text: 'x'.repeat(filler), at: 1, source: 'run' as const } } : {}) }] });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pointer = (type: string, pointerId = 1) => Object.assign(new Event(type), { pointerId });
const BUSY = () => response({ error: { code: 'canvas_save_busy', message: 'Canvas saves are busy; try again shortly' } }, 503);

async function writerReady() {
  await waitFor(() => {
    expect(document.querySelector('.awwo-workspace')).not.toBeNull();
    expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function');
  }, { timeout: 5000 });
  return vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall![0]!;
}
type Serve = { hang?: boolean; read?: () => Promise<void>; held?: Promise<void>; busy?: boolean };
/** The API: a PUT stores its document as the next version. `hang`: its reply never comes (the page has closed); `read`:
 * the canvas's own GET answers once it settles; `held`: the first PUT's reply waits for it; `busy`: every PUT is
 * answered busy, storing nothing. */
function serve(cloud: { current: ReturnType<typeof record> }, puts: CanvasDocument[], options: Serve = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/artifacts')) return response({ items: [] });
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      puts.push(body.document);
      if (options.busy) return BUSY();
      cloud.current = record(body.document, body.version + 1);
      if (options.hang) return new Promise<Response>(() => {});
      if (options.held && puts.length === 1) { const stored = cloud.current; await options.held; return response(stored); }
    }
    if (options.read && url.endsWith('/canvases/canvas-a')) await options.read();
    return response(cloud.current);
  }));
}
/** The page closes: the editor goes, the page's canvas store (with its hold on the canvas) stays as the test's. */
function closePage() { cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); }

let locks: ReturnType<typeof countedLocks>;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
beforeEach(() => {
  const local = quotaStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local.storage });
  Object.defineProperty(navigator.locks, 'query', { configurable: true, value: async () => ({ held: [], pending: [] }) });
  locks = countedLocks();
  const backend = memoryBackend();
  setCanvasStoreForTests(createCanvasStore({ backend: async () => backend.backend, channel: channelHub().channel, locks: locks.locks,
    legacy: local.storage, keepLegacy: keepLegacyCanvasCache, mirrorGroup: CANVAS_MIRROR_GROUP, preserveLegacy: preserveRegisteredLegacyCache,
    flushDelay: 5, peerWait: 100, watchPage: false }));
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  localStorage.setItem('superclaw_locale', 'zh'); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestIdleCallback', () => 0);
});
afterEach(() => {
  closePage(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  setCanvasStoreForTests(null);
  Object.defineProperty(globalThis, 'localStorage', original);
  delete (navigator.locks as { query?: unknown }).query;
});

/** The page sends `sent` and closes before the reply; `after` is an edit it made while that save was out. */
async function closeWithSaveOut(cloud: { current: ReturnType<typeof record> }, puts: CanvasDocument[], sent: CanvasDocument, after?: CanvasDocument) {
  serve(cloud, puts, { hang: true });
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { expect(saveDocument(sent)).toBe(true); void flush().catch(() => {}); });
  await waitFor(() => expect(puts).toHaveLength(1));
  if (after) act(() => { expect(saveDocument(after)).toBe(true); });
  await act(async () => { await settle(); });
  closePage();
}
/** Another tab has the canvas open. */
const anotherTab = () => locks.held.push({ name: CANVAS_STORE_CHANNEL + A, mode: 'shared' });

it('restores the draft a page left behind onto the cloud version its last save became after the page closed', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('拖动中', 10), documentAt('拖动后', 20));
  expect(cloud.current.version).toBe(8);
  expect(readCanvasDrafts(canvasStorage())[0].draft).toMatchObject({ baseVersion: 7, sending: { baseVersion: 7 }, document: { nodes: [{ x: 20 }] } });
  serve(cloud, puts);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  const restore = screen.getByRole('button', { name: '恢复草稿并继续同步' });
  await waitFor(() => expect(restore).toBeEnabled());
  expect(screen.getByText(/云端版本 8 正是这个页面关闭前送出的保存/)).toBeVisible();
  expect(screen.queryByText(/云端版本已有变化/)).toBeNull();
  fireEvent.click(restore);
  // The restored copy builds on version 8: a page closing again before its save still offers it.
  expect(readCanvasDrafts(canvasStorage()).map(each => each.draft?.baseVersion).sort()).toEqual([7, 8]);
  const flush = await writerReady();
  await act(async () => { await flush(); });
  expect(puts).toHaveLength(2);
  expect(puts[1].nodes[0]).toMatchObject({ title: '拖动后', x: 20 });
  expect(cloud.current.version).toBe(9);
  await waitFor(() => expect(readCanvasDrafts(canvasStorage())).toHaveLength(0));
});

it('keeps the draft export-only when the cloud moved on with another document instead', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('拖动中', 10), documentAt('拖动后', 20));
  cloud.current = record(documentAt('另一台设备保存的版本', 99), 8);
  serve(cloud, puts);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  await waitFor(() => expect(screen.getByText(/云端版本已有变化/)).toBeVisible());
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '导出未同步草稿' })).toBeEnabled();
  expect(puts).toHaveLength(1);
});

it('keeps such a draft export-only while another tab has the canvas open: its page may still be that tab', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('拖动中', 10), documentAt('拖动后', 20));
  anotherTab();
  serve(cloud, puts);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  await waitFor(() => expect(screen.getByText(/云端版本已有变化/)).toBeVisible());
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
  expect(screen.queryByText(/正是这个页面关闭前送出的保存/)).toBeNull();
});

it('opens the canvas without a recovery prompt, not even while the cloud loads, when the draft left behind is exactly the cloud\'s', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('最后一次保存', 30));
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
  let read!: () => void;
  const gate = new Promise<void>(resolve => { read = resolve; });
  serve(cloud, puts, { read: () => gate });
  render(<SaaSApp />);
  await act(async () => { await settle(); await sleep(200); });
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  await act(async () => { read(); });
  await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(screen.getByText('已同步')).toBeVisible();
  expect(puts).toHaveLength(1);
});

it('offers the drafts it held back when the cloud cannot be read', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('拖动中', 10), documentAt('拖动后', 20));
  serve(cloud, puts, { read: () => Promise.reject(new TypeError('cloud offline')) });
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  expect(screen.getByRole('button', { name: '导出未同步草稿' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeDisabled();
});

it('leaves a draft identical to the cloud for review while another tab has the canvas open (that tab may still be writing it)', async () => {
  const cloud = { current: record(documentAt('云端原文')) }; const puts: CanvasDocument[] = [];
  await closeWithSaveOut(cloud, puts, documentAt('最后一次保存', 30));
  anotherTab();
  serve(cloud, puts);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  await act(async () => { await settle(); });
  expect(screen.getByRole('heading', { name: '发现未同步的本机草稿' })).toBeVisible();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
});

it('saves a slow drag of a big canvas once, after the pointer lifts, not once per frame', async () => {
  const cloud = { current: record(documentAt('大画布', 0, 1_000_000)) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts);
  render(<SaaSApp />); await writerReady();
  window.dispatchEvent(pointer('pointerdown'));
  // Frames 700 ms apart, slower than autosave's plain wait.
  for (const x of [10, 20, 30]) { act(() => { saveDocument(documentAt('大画布', x, 1_000_000)); }); await act(async () => { await sleep(700); }); }
  expect(puts).toHaveLength(0);
  window.dispatchEvent(pointer('pointerup'));
  await waitFor(() => expect(puts).toHaveLength(1), { timeout: 6000 });
  expect(puts[0].nodes[0].x).toBe(30);
  await act(async () => { await sleep(600); });
  expect(puts).toHaveLength(1);
});

it('sends a big canvas\'s edit made while autosave\'s save was out once that edit\'s burst is over, and a run\'s save at once', async () => {
  const big = 1_200_000;
  const cloud = { current: record(documentAt('画布', 0, big)) }; const puts: CanvasDocument[] = [];
  let reply!: () => void;
  serve(cloud, puts, { held: new Promise<void>(resolve => { reply = resolve; }) });
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { saveDocument(documentAt('第一次', 1, big)); });
  await waitFor(() => expect(puts).toHaveLength(1), { timeout: 4000 });
  // A burst of edits 1.2 s apart while that save is out; its reply comes mid-burst.
  act(() => { saveDocument(documentAt('第二次', 2, big)); });
  await act(async () => { await sleep(1200); });
  act(() => { saveDocument(documentAt('第三次', 3, big)); });
  await act(async () => { reply(); await sleep(200); });
  expect(puts).toHaveLength(1);
  await waitFor(() => expect(puts).toHaveLength(2), { timeout: 8000 });
  expect(puts[1].nodes[0].title).toBe('第三次');
  // A run saves first, at once, even with a pointer held down.
  window.dispatchEvent(pointer('pointerdown'));
  act(() => { saveDocument(documentAt('运行前', 4, big)); });
  await act(async () => { await flush(); });
  expect(puts).toHaveLength(3);
  expect(puts[2].nodes[0].title).toBe('运行前');
  window.dispatchEvent(pointer('pointerup'));
}, 30000);

it('counts the busy answers of an autosave whose canvas keeps changing, and says the save failed after the third', async () => {
  const big = 1_200_000;
  const cloud = { current: record(documentAt('画布', 0, big)) }; const puts: CanvasDocument[] = [];
  serve(cloud, puts, { busy: true });
  render(<SaaSApp />); await writerReady();
  act(() => { saveDocument(documentAt('第一次', 1, big)); });
  await waitFor(() => expect(puts).toHaveLength(1), { timeout: 4000 });
  // Then edits 700 ms apart through every 2 s wait for a turn.
  let step = 0;
  const editing = setInterval(() => { step += 1; act(() => { saveDocument(documentAt(`忙时第 ${step} 次`, step, big)); }); }, 700);
  try {
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存失败：Canvas saves are busy'), { timeout: 20000 });
  } finally { clearInterval(editing); }
  expect(puts).toHaveLength(4);
  await act(async () => { await sleep(3000); });
  expect(puts).toHaveLength(4);
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
}, 40000);
