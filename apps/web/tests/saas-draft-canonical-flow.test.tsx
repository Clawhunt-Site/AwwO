import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, emptyDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { preserveThreadRuntime } from '../src/canvas/nodeThreads';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { CANVAS_BASELINE_KEY, CANVAS_DRAFT_PREFIX, persistCanvasDraft, readCanvasDrafts } from '../src/saas/canvasDraft';
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

it('frees the acknowledged draft before storing the server baseline under quota pressure', async () => {
  const original = documentWithThreads(); const changed = { ...original, updatedAt: original.updatedAt + 1 };
  let cloud = record(original); let puts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') { const body = JSON.parse(init.body as string); puts++; cloud = record(body.document, body.version + 1); }
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const setItem = localStorage.setItem.bind(localStorage);
  const baselineDraftCounts: number[] = [];
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(CANVAS_BASELINE_KEY)) {
      const count = readCanvasDrafts(canvasStorage()).length;
      baselineDraftCounts.push(count);
      if (count) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    }
    setItem(key, value);
  });
  act(() => { expect(saveDocument(changed)).toBe(true); });
  await act(async () => { await flush(); });
  expect(puts).toBe(1);
  expect(baselineDraftCounts).toEqual([0]);
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('已同步')).toBeVisible();
});

it('retains another writer draft even when a fresh server document matches it exactly', async () => {
  const local = documentWithThreads();
  persistCanvasDraft(canvasStorage(), 'must-remain', 7, local);
  const raw = canvasStorage().getItem(`${CANVAS_DRAFT_PREFIX}must-remain`);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    return response(record(local));
  }));
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: '发现未同步的本机草稿' });
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复草稿并继续同步' })).toBeEnabled());
  expect(canvasStorage().getItem(`${CANVAS_DRAFT_PREFIX}must-remain`)).toBe(raw);
});

it('continues saving an edit when only the optional baseline fits instead of a third document copy', async () => {
  const original = documentWithThreads(); const changed = { ...original, nodes: original.nodes.map(node => ({ ...node, title: '保留最新编辑' })) };
  let cloud = record(original); const writes: CanvasDocument[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') { const body = JSON.parse(init.body as string); writes.push(body.document); cloud = record(body.document, body.version + 1); }
    return response(cloud);
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const storage = canvasStorage(); const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(CANVAS_DRAFT_PREFIX) && storage.getItem(CANVAS_BASELINE_KEY)) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    if (key.endsWith(CANVAS_BASELINE_KEY)) throw new DOMException('No space for optional baseline', 'QuotaExceededError');
    setItem(key, value);
  });
  act(() => { expect(saveDocument(changed)).toBe(true); });
  expect(readCanvasDrafts(storage)[0]?.draft?.document.nodes[0].title).toBe('保留最新编辑');
  await act(async () => { await flush(); });
  expect(writes).toHaveLength(1);
  expect(writes[0].nodes[0].title).toBe('保留最新编辑');
  expect(readCanvasDrafts(storage)).toHaveLength(0);
  expect(storage.getItem(CANVAS_BASELINE_KEY)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('已同步')).toBeVisible();
});

it('explains local storage exhaustion without exposing storage keys and exports the latest pending edit', async () => {
  const original = documentWithThreads(); const changed = { ...original, nodes: original.nodes.map(node => ({ ...node, title: '最新未保存内容' })) };
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method && init.method !== 'GET') writes.push(url);
    return response(record(original));
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(CANVAS_DRAFT_PREFIX)) throw new DOMException(`setItem ${key} exceeded quota`, 'QuotaExceededError');
    setItem(key, value);
  });
  act(() => { saveDocument(changed); });
  expect(await screen.findByRole('alert')).toHaveTextContent('本机存储空间已满');
  expect(screen.getByRole('alert')).not.toHaveTextContent(CANVAS_DRAFT_PREFIX);
  // A stale on-disk cache must not win over the editor's known latest pending value.
  setItem(canvasStorageKey(CANVAS_STORAGE_KEY), JSON.stringify(original));
  let exported: Blob | undefined;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { exported = blob; return 'blob:test-export'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '导出本地副本' }));
  const bytes = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(exported!);
  });
  expect(JSON.parse(bytes).nodes[0].title).toBe('最新未保存内容');
  await expect(flush()).rejects.toThrow('画布未同步');
  expect(writes).toEqual([]);
});

it('warns when the canvas cache itself cannot save and exports the current in-memory edit', async () => {
  const original = documentWithThreads(); const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method && init.method !== 'GET') writes.push(url);
    return response(record(original));
  }));
  render(<SaaSApp />); const flush = await writerReady();
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(CANVAS_STORAGE_KEY)) throw new DOMException(`setItem ${key} exceeded quota`, 'QuotaExceededError');
    setItem(key, value);
  });
  fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('本机无法保存最新编辑');
  expect(screen.getByRole('alert')).not.toHaveTextContent(CANVAS_STORAGE_KEY);
  expect(screen.getByText('未同步', { exact: true })).toBeVisible();
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes).toHaveLength(1);
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  let exported: Blob | undefined;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { exported = blob; return 'blob:test-export'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '导出本地副本' }));
  const bytes = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(exported!);
  });
  expect(JSON.parse(bytes).nodes).toHaveLength(0);
  await expect(flush()).rejects.toThrow('画布未同步');
  expect(writes).toEqual([]);
});

it.each([200, 503])('keeps the latest in-memory edit and warning when an older cloud save returns %s after a local cache failure', async status => {
  const original = documentWithThreads(); const changed = { ...original, updatedAt: original.updatedAt + 1 };
  let resolve!: (value: Response) => void; let puts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') { puts++; return new Promise<Response>(done => { resolve = done; }); }
    return response(record(original));
  }));
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { saveDocument(changed); });
  const pendingSave = flush();
  await waitFor(() => expect(puts).toBe(1));
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(CANVAS_STORAGE_KEY)) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    setItem(key, value);
  });
  fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
  await screen.findByRole('alert');
  await act(async () => {
    resolve(status === 200 ? response(record(changed, 8)) : response({ error: { message: 'Temporary server failure' } }, status));
    await expect(pendingSave).rejects.toThrow('画布未同步');
  });
  expect(screen.getByText('未同步', { exact: true })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('本机无法保存最新编辑');
  expect(screen.getByRole('alert')).not.toHaveTextContent('未同步草稿保留在本机');
  let exported: Blob | undefined;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { exported = blob; return 'blob:test-export'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '导出本地副本' }));
  const bytes = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(exported!);
  });
  expect(JSON.parse(bytes).nodes).toHaveLength(0);
  expect(puts).toBe(1);
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
