import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, emptyDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { preserveThreadRuntime } from '../src/canvas/nodeThreads';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { persistCanvasDraft, readCanvasDrafts } from '../src/saas/canvasDraft';
import * as bridge from '../src/saas/canvasBridge';

const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const record = (document: CanvasDocument, version = 7) => ({ id: 'canvas-a', tenantId: 'tenant-a', name: 'Canvas', document, version, createdAt: '', updatedAt: '' });
function documentWithThreads(): CanvasDocument {
  const node = createAgentTemplate('backend', { x: 0, y: 0 });
  return { ...emptyDocument(), updatedAt: 123456, view: { x: 0, y: 0, scale: 1 },
    nodes: [preserveThreadRuntime(node, node)] };
}
function reordered<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reordered) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) as T;
  return value;
}
async function writerReady() {
  await waitFor(() => {
    expect(document.querySelector('.awwo-workspace')).not.toBeNull();
    expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function');
  });
  return vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall![0]!;
}
function reconnect() { cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); render(<SaaSApp />); }
beforeEach(() => {
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('hydrates an equal legacy cache and ignores cache-write events that only reorder nested keys', async () => {
  const local = documentWithThreads(); const cloud = record(reordered(local)); let puts = 0;
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(local)); canvasStorage().setItem('awwo.cloud.version', '7');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') puts++;
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  act(() => { saveDocument(local); });
  await act(async () => { await flush(); });
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(puts).toBe(0);
});

it('does not re-submit a document echoed by the canvas while its first save is in flight', async () => {
  const original = documentWithThreads(); const changed = { ...original, updatedAt: original.updatedAt + 1 };
  let cloud = record(original); let puts = 0;
  let acknowledgeFirst!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      puts++;
      cloud = record(body.document, body.version + 1);
      if (puts === 1) return new Promise<Response>(resolve => { acknowledgeFirst = resolve; });
    }
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { saveDocument(reordered(changed)); });
  const firstSave = flush();
  await waitFor(() => expect(puts).toBe(1));
  act(() => { saveDocument(changed); });
  await act(async () => { acknowledgeFirst(response(cloud)); await firstSave; });
  expect(puts).toBe(1);
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
});

it('keeps the echoed draft and releases the save queue if local acknowledgement fails', async () => {
  const original = documentWithThreads(); const changed = { ...original, updatedAt: original.updatedAt + 1 };
  let cloud = record(original); let puts = 0;
  let acknowledgeFirst!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      puts++; cloud = record(body.document, body.version + 1);
      if (puts === 1) return new Promise<Response>(resolve => { acknowledgeFirst = resolve; });
    }
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { saveDocument(reordered(changed)); });
  const firstSave = flush();
  await waitFor(() => expect(puts).toBe(1));
  act(() => { saveDocument(changed); });
  const remove = localStorage.removeItem.bind(localStorage);
  vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
    if (key.includes('awwo.cloud.draft.v1:')) throw new Error('simulated local acknowledgement failure');
    return remove(key);
  });
  expect(() => localStorage.removeItem('awwo.cloud.draft.v1:probe')).toThrow('simulated local acknowledgement failure');
  await act(async () => {
    acknowledgeFirst(response(cloud));
    await expect(firstSave).rejects.toThrow('画布未同步');
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('本机草稿保存失败');
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
  expect(puts).toBe(1);
  const secondSave = await Promise.race([
    flush().then(() => 'unexpected success', () => 'blocked'),
    new Promise<string>(resolve => setTimeout(() => resolve('queue stuck'), 150)),
  ]);
  expect(secondSave).toBe('blocked');
});

it('keeps a distinct edit made during the first save and sends it with the acknowledged version', async () => {
  const original = documentWithThreads();
  const first = { ...original, updatedAt: original.updatedAt + 1 };
  const second = { ...first, nodes: first.nodes.map(node => ({ ...node, title: 'Real second edit' })) };
  let cloud = record(original); const writes: Array<{ document: CanvasDocument; version: number }> = [];
  let acknowledgeFirst!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { document: CanvasDocument; version: number };
      writes.push(body); cloud = record(body.document, body.version + 1);
      if (writes.length === 1) return new Promise<Response>(resolve => { acknowledgeFirst = resolve; });
    }
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { saveDocument(first); });
  const firstSave = flush();
  await waitFor(() => expect(writes).toHaveLength(1));
  act(() => { saveDocument(second); });
  await act(async () => { acknowledgeFirst(response(record(first, 8))); await firstSave; });
  expect(writes.map(write => write.version)).toEqual([7, 8]);
  expect(writes[1].document.nodes[0].title).toBe('Real second edit');
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
});

it('restores a same-version draft once and stays synced after a reordered server acknowledgement and refresh', async () => {
  const local = documentWithThreads(); let cloud = record(reordered(local)); let puts = 0;
  persistCanvasDraft(canvasStorage(), 'old-phantom', 7, local);
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(local)); canvasStorage().setItem('awwo.cloud.version', '7');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (init.method === 'PUT') { const body = JSON.parse(init.body as string); puts++; cloud = record(reordered(body.document), body.version + 1); }
    return response(cloud);
  }));
  render(<SaaSApp />);
  const restore = await screen.findByRole('button', { name: '恢复草稿并继续同步' });
  await waitFor(() => expect(restore).toBeEnabled()); fireEvent.click(restore);
  const flush = await writerReady(); await act(async () => { await flush(); });
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0); expect(puts).toBe(1);
  reconnect(); await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0); expect(puts).toBe(1);
});

it('does not archive a second equal cache when opening the cloud to reconcile a journal', async () => {
  const local = documentWithThreads(); const node = local.nodes[0];
  if (node.kind !== 'session') throw new Error('Expected session fixture');
  node.binding = { companyId: 'tenant-a', agentId: 'agent-a', agentName: 'Agent A' }; node.issueId = 'session-a';
  const cloud = record(reordered(local)); const old = structuredClone(local); old.nodes[0].title = 'Real old conflict';
  const oldDraft = persistCanvasDraft(canvasStorage(), 'old-conflict', 6, old);
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(local)); canvasStorage().setItem('awwo.cloud.version', '7');
  const journal: CanvasRunJournal = { version: 1, id: 'canonical-journal', startedAt: 1, scope: [node.id],
    inputFingerprint: runInputFingerprint(local, [node.id]), nodes: {
      [node.id]: { nodeId: node.id, threadId: 'default', companyId: 'tenant-a', agentId: 'agent-a', issueId: 'session-a', runId: 'run-a', operationId: 'operation-a', state: 'running' },
    } };
  canvasStorage().setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.includes('/runs')) return response({ error: { code: 'unavailable', message: 'offline' } }, 503);
    if (url.endsWith('/messages')) return response({ items: [] });
    return response(cloud);
  }));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '使用云端版本并核对运行（保留草稿）' }));
  await writerReady(); await waitFor(() => expect(calls.some(call => call.url.includes('/runs?operationId=operation-a'))).toBe(true));
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(1);
  expect(readCanvasDrafts(canvasStorage())[0].draft).toEqual(oldDraft);
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
