// A rerun the canvas's evolution asks for (CanvasSurface autoRun): its nodes run once, as a run of their own under the
// operation id the server admits it by; the assistant's panel says why the canvas runs by itself, and the host hears
// whether it started.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { CanvasSurface, type CanvasAutoRun } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { CANVAS_RUN_JOURNAL_KEY, clearRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const NOTE = '自动进化：把上次没完成的 1 个节点再跑一次，带上刚学到的经验。';
const request: CanvasAutoRun = { id: 'autorun:1', scope: ['page'], operationId: 'autorerun:g1', note: NOTE };
let submitted: { operationId: string; scope: string[] }[];
let refuse: boolean;
let admission: number;
const graph = (operationId: string) => ({ id: 'g2', operationId, status: 'completed', canvasId: 'canvas', documentVersion: 9,
  nodes: [{ nodeId: 'page', state: 'done', output: 'Done', threadId: 'default', agentId: 'agent', sessionId: 'session' }] });

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions();
  submitted = []; refuse = false; admission = 30;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => canonical(loadDocumentWithStatus().doc));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      submitted.push({ operationId: body.operationId, scope: body.scope });
      // Admission takes a round trip, as it does over a network: the page shows the run running meanwhile.
      await new Promise(resolve => setTimeout(resolve, admission));
      return refuse ? new Response(JSON.stringify({ error: { code: 'auto_rerun_limit', message: 'limit' } }), { status: 409 })
        : new Response(JSON.stringify(graph(body.operationId)), { status: 202 });
    }
    if (url.includes('/graph-runs/g2')) return new Response(JSON.stringify(graph(submitted.at(-1)?.operationId ?? '')));
    // A run another load left: still running until the page has started its own, then over.
    if (url.includes('/graph-runs/old')) return new Response(JSON.stringify({ ...graph('old-operation'), id: 'old', status: submitted.length ? 'completed' : 'running',
      nodes: [{ nodeId: 'brief', state: submitted.length ? 'done' : 'running', output: submitted.length ? 'Old' : '', threadId: 'default', agentId: 'agent', sessionId: 'session' }] }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
  const node = { ...createSessionNode('llm', { x: 50, y: 50 }), id: 'page', title: '生成页面' };
  const other = { ...createSessionNode('llm', { x: 450, y: 50 }), id: 'brief', title: '简报' };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node, other], view: { x: 0, y: 0, scale: 1 } }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureSaaSCanvasInitialize(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function canonical(document: CanvasDocument): CanvasDocument {
  return sanitizeDocument({ ...document, nodes: document.nodes.map(node => node.kind !== 'session' ? node : { ...node,
    runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: 'agent', agentName: node.title }, issueId: 'session' }) });
}
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);

it('runs its nodes once under the operation id it names, says why in the assistant’s panel, says it started, and names the run when it ends', async () => {
  const settled = vi.fn();
  const ended = vi.fn();
  const { rerender } = render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }));
  expect(submitted).toEqual([{ operationId: 'autorerun:g1', scope: ['page'] }]);
  expect(await sidebar().findByText(NOTE)).toBeVisible();
  // The canvas run it watched end is named, for the host to know which run that was.
  await waitFor(() => expect(ended).toHaveBeenCalledWith({ kind: 'run', failed: false, graphIds: ['g2'] }), { timeout: 8000 });
  // Once: the same request again starts nothing more.
  rerender(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={{ ...request }} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(submitted).toHaveLength(1);
  expect(settled).toHaveBeenCalledOnce();
});

// A run this page found in a journal (another load's, another tab's) ends without being named, even beside one it started:
// here it ends while the page's own run waits for its admission, longer than the journal's next read.
it('names only the canvas runs it started itself when work ends', async () => {
  admission = 3000;
  saveRunJournal({ version: 1, id: 'old-operation', startedAt: Date.now() - 60_000, scope: ['brief'], serverGraph: { id: 'old', tenantId: tenant.id, canvasId: 'canvas' },
    nodes: { brief: { nodeId: 'brief', threadId: 'default', operationId: 'old-node-op', companyId: tenant.id, agentId: 'agent', issueId: 'session', runId: null, state: 'running' } } });
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }), { timeout: 8000 });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 10000 });
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
});

// Another tab may finish a run this page started, and clear its journal, before this page sees it end: still named.
it('names a run it started that another tab finished first', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let read = false;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    if (String(input).includes('/graph-runs/g2') && !read) {
      // The other tab, which took the run over, has finished it and let its journal go.
      read = true;
      clearRunJournal(request.operationId);
    }
    return base(input as string, init);
  }));
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }));
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 10000 });
  expect(read).toBe(true);
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
});

// 多人同屏: the page's host lands a run whose journal another tab let go (saas/useRunLanding.ts); one this page started is
// still named at its end.
it('names a run it started that another tab finished first, where the page’s host lands it', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let read = false;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    if (String(input).includes('/graph-runs/g2') && !read) {
      // The other tab, which took the run over, has handed it over and let its journal go.
      read = true;
      clearRunJournal(request.operationId);
    }
    return base(input as string, init);
  }));
  const landEnded = vi.fn();
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" multiplayer={{ connect: () => {}, presence: () => {}, landEnded }} runtimeReadJson={reader}
    autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }));
  await waitFor(() => expect(landEnded).toHaveBeenCalledWith('g2'), { timeout: 10000 });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 10000 });
  expect(read).toBe(true);
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
});

// A run found in a journal may recover for the whole of the page's own run: the page's run is still named at its end.
it('names a run it started while a restored run recovered the whole time', async () => {
  saveRunJournal({ version: 1, id: 'old-operation', startedAt: Date.now() - 60_000, scope: ['brief'], serverGraph: { id: 'old', tenantId: tenant.id, canvasId: 'canvas' },
    nodes: { brief: { nodeId: 'brief', threadId: 'default', operationId: 'old-node-op', companyId: tenant.id, agentId: 'agent', issueId: 'session', runId: null, state: 'running' } } });
  const base = vi.mocked(fetch).getMockImplementation()!;
  let ownDone = false;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/graph-runs/g2')) ownDone = true;
    // The restored run goes on until the page's own run has been read over.
    if (url.includes('/graph-runs/old')) return new Response(JSON.stringify({ ...graph('old-operation'), id: 'old', status: ownDone ? 'completed' : 'running',
      nodes: [{ nodeId: 'brief', state: ownDone ? 'done' : 'running', output: ownDone ? 'Old' : '', threadId: 'default', agentId: 'agent', sessionId: 'session' }] }));
    return base(url, init);
  }));
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }), { timeout: 8000 });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 15000 });
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
}, 30000);

// A run whose admission answer was lost, which another tab then finished and let go of: found by its operation, named.
it('names a run it started whose admission answer was lost, finished by another tab', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') {
      await base(url, init);
      throw new TypeError('Failed to fetch');
    }
    if (url.includes('/graph-runs?operationId=')) {
      lists += 1;
      // The other tab, which took the run over, has finished it and let its journal go.
      if (lists === 1) clearRunJournal(request.operationId);
      return new Response(JSON.stringify({ items: [{ id: 'g2', operationId: request.operationId, status: 'completed' }] }));
    }
    return base(url, init);
  }));
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 8000 });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 15000 });
  expect(lists).toBeGreaterThanOrEqual(2);
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
}, 30000);

// 多人同屏: the same, where the page's host lands the run, and the lookup by its operation takes a moment.
it('names a run it started whose admission answer was lost, finished by another tab, where the page’s host lands it', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') {
      await base(url, init);
      throw new TypeError('Failed to fetch');
    }
    if (url.includes('/graph-runs?operationId=')) {
      lists += 1;
      // The other tab, which took the run over, has finished it and let its journal go.
      if (lists === 1) clearRunJournal(request.operationId);
      // Answered after a moment, as over a network (a read the page lets go is not answered).
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 300);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
      });
      return new Response(JSON.stringify({ items: [{ id: 'g2', operationId: request.operationId, status: 'completed' }] }));
    }
    return base(url, init);
  }));
  const landEnded = vi.fn();
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" multiplayer={{ connect: () => {}, presence: () => {}, landEnded }} runtimeReadJson={reader}
    autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 8000 });
  await waitFor(() => expect(landEnded).toHaveBeenCalledWith('g2'), { timeout: 15000 });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 15000 });
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
}, 30000);

// Another tab may take a run this page started over, see it end, let its journal go and put work of its own in its
// place, which this page then watches: the page's run is still named when that work ends.
it('names a run it started whose journal another tab let go of and replaced with its own', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/graph-runs/g2')) {
      reads += 1;
      return new Response(JSON.stringify({ ...graph(request.operationId), status: 'running',
        nodes: [{ nodeId: 'page', state: 'running', output: '', threadId: 'default', agentId: 'agent', sessionId: 'session' }] }));
    }
    return base(url, init);
  }));
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: true }), { timeout: 8000 });
  await waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 8000 });
  const other: CanvasRunJournal = { version: 1, id: 'other-tab-run', startedAt: Date.now(), scope: ['brief'],
    nodes: { brief: { nodeId: 'brief', threadId: 'default', companyId: null, agentId: null, issueId: null, runId: null, state: 'running' } } };
  const key = canvasStorageKey(CANVAS_RUN_JOURNAL_KEY);
  act(() => { saveRunJournal(other); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await new Promise(resolve => setTimeout(resolve, 200));
  // That work ends there too, and its journal goes.
  act(() => { clearRunJournal('other-tab-run'); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 15000 });
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']);
}, 30000);

// A run whose admission answer was lost, whose journal another tab replaced, is looked up by its operation; the lookup
// may answer after the work this page watched was over, and the run is still named.
it('names a run it started that it found only after the work it ended with was over', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  let lists = 0;
  let replaced = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') {
      await base(url, init);
      throw new TypeError('Failed to fetch');
    }
    if (url.includes('/graph-runs?operationId=')) {
      lists += 1;
      // Not found yet while the page watches it; once another tab has it, the page's own lookup answers late.
      if (!replaced) return new Response(JSON.stringify({ items: [] }));
      await held;
      return new Response(JSON.stringify({ items: [{ id: 'g2', operationId: request.operationId, status: 'completed' }] }));
    }
    return base(url, init);
  }));
  const settled = vi.fn();
  const ended = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} onWorkSettled={ended} />);
  await waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 8000 });
  await waitFor(() => expect(lists).toBeGreaterThan(0), { timeout: 8000 });
  const other: CanvasRunJournal = { version: 1, id: 'other-tab-run', startedAt: Date.now(), scope: ['brief'],
    nodes: { brief: { nodeId: 'brief', threadId: 'default', companyId: null, agentId: null, issueId: null, runId: null, state: 'running' } } };
  const key = canvasStorageKey(CANVAS_RUN_JOURNAL_KEY);
  replaced = true;
  act(() => { saveRunJournal(other); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await new Promise(resolve => setTimeout(resolve, 200));
  act(() => { clearRunJournal('other-tab-run'); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 15000 });
  expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual([]);
  release();
  await waitFor(() => expect(ended.mock.calls.flatMap(([event]) => event.graphIds ?? [])).toEqual(['g2']), { timeout: 5000 });
}, 30000);

it('says it did not start when the server refused it, and starts nothing read only', async () => {
  refuse = true;
  const settled = vi.fn();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} autoRun={request} onAutoRunSettled={settled} />);
  await waitFor(() => expect(settled).toHaveBeenCalledWith('autorun:1', { started: false }));
  expect(submitted).toHaveLength(1);
  expect(document.querySelector('.awwo-planner-sidebar')?.textContent ?? '').not.toContain(NOTE);
  cleanup();
  submitted = [];
  const readOnly = vi.fn();
  render(<CanvasSurface storageMode="cloud" readOnly runtimeReadJson={reader} autoRun={{ ...request, id: 'autorun:2' }} onAutoRunSettled={readOnly} />);
  // Long enough for a canvas that may run to have started it (well under a second, above).
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(submitted).toHaveLength(0);
  expect(readOnly).not.toHaveBeenCalled();
});
