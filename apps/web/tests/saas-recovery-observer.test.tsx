import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { graphRecoveryJournal, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { resetAllSessions } from '../src/canvas/sessions';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = { id: 'observer-workspace', name: 'Observer workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const document = (): CanvasDocument => sanitizeDocument({ ...emptyDocument(), nodes: ['a', 'b'].map((id, index) => ({
  ...createSessionNode('llm', { x: index * 500, y: 0 }), id, title: `Agent ${id}`, runtime: 'openai', model: 'qwen',
  binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id },
})), view: { x: 0, y: 0, scale: 1 } });
const snapshot = (doc: CanvasDocument, scope = ['a', 'b']): GraphRunSnapshot => ({
  id: 'graph-a', operationId: 'operation-a', canvasId: 'canvas-a', documentVersion: 7, document: doc,
  scope, status: 'completed', createdAt: '2026-10-02T00:00:00Z',
  nodes: scope.map(id => ({ nodeId: id, state: 'done', output: `Delivered ${id}` })),
});
const journalFor = (doc: CanvasDocument, scope = ['a', 'b']) => graphRecoveryJournal({ ...snapshot(doc, scope), status: 'running',
  nodes: scope.map(id => ({ nodeId: id, state: 'running' })) }, tenant.id, doc);
const renderCanvas = () => render(<SaaSPreferencesProvider><CanvasSurface storageMode="cloud" /></SaaSPreferencesProvider>);
const dispatchJournal = () => window.dispatchEvent(new StorageEvent('storage', { key: canvasStorageKey(CANVAS_RUN_JOURNAL_KEY) }));
const seed = (doc: CanvasDocument) => canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'en');
  configureCanvasStorage('observer-user', tenant.id, 'canvas-a'); configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function fetchGraph(reply: () => Promise<Response>) {
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => String(url).endsWith('/graph-runs/graph-a')
    ? reply() : Promise.resolve(json({ items: [], models: [] })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('keeps a stale empty tab from poisoning or clearing another tab’s run, even after the owner finishes', async () => {
  seed(sanitizeDocument(emptyDocument()));
  const doc = document(); const journal = journalFor(doc);
  const fetcher = fetchGraph(async () => json(snapshot(doc)));
  renderCanvas();
  act(() => { seed(doc); saveRunJournal(journal); dispatchJournal(); });
  const cached = canvasStorage().getItem(CANVAS_STORAGE_KEY);
  const durable = canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY);
  await screen.findByText(/This page has an older canvas/);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toBe(cached);
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(durable);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/graph-runs/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  act(() => { canvasStorage().removeItem(CANVAS_RUN_JOURNAL_KEY); dispatchJournal(); });
  fireEvent.keyDown(window, { key: 'e', metaKey: true });
  fireEvent.keyDown(window, { key: '+' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toBe(cached);
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBeNull();
  expect(screen.getByText(/This page has an older canvas/)).toBeVisible();
});

it('protects unrelated nodes and thread drafts during a scoped run', async () => {
  const doc = document(); const initial = { ...doc, nodes: [doc.nodes[0]] };
  seed(initial); fetchGraph(async () => json(snapshot(doc, ['a']))); renderCanvas();
  const latest = { ...doc, nodes: doc.nodes.map(node => node.kind === 'session' ? { ...node,
    threads: [{ id: 'default', title: 'Session', draft: 'Keep this exact draft', preview: '', issueId: null, createdAt: 1 }],
  } : node) };
  expect(runInputFingerprint(initial, ['a'])).toBe(runInputFingerprint(latest, ['a']));
  act(() => { seed(latest); saveRunJournal(journalFor(latest, ['a'])); dispatchJournal(); });
  const cached = canvasStorage().getItem(CANVAS_STORAGE_KEY); const durable = canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY);
  await screen.findByText(/This page has an older canvas/);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toBe(cached);
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(durable);
});

it('rechecks the complete durable document after an in-flight graph read', async () => {
  const doc = document(); seed(doc); saveRunJournal(journalFor(doc));
  let resolveRead!: (value: Response) => void;
  const fetcher = fetchGraph(() => new Promise(resolve => { resolveRead = resolve; }));
  renderCanvas();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/graph-runs/'))).toBe(true));
  const latest = { ...doc, nodes: [...doc.nodes, { ...createSessionNode('llm', { x: 900, y: 0 }), id: 'unrelated-new-node' }] };
  act(() => seed(latest)); const cached = canvasStorage().getItem(CANVAS_STORAGE_KEY); const durable = canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY);
  await act(async () => resolveRead(json(snapshot(doc))));
  await screen.findByText(/This page has an older canvas/);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toBe(cached);
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(durable);
});

it('recovers matching inputs after focusing and fitting the view without another model submission', async () => {
  const doc = document(); seed(doc); saveRunJournal(journalFor(doc));
  let resolveRead!: (value: Response) => void;
  let completed = false;
  const fetcher = fetchGraph(() => completed ? Promise.resolve(json(snapshot(doc))) : new Promise(resolve => { resolveRead = resolve; }));
  renderCanvas();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/graph-runs/'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Open Agent a', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'View all nodes' }));
  // The focus change restarts the observer; let its cancelled read release the ownership lock.
  await act(async () => { completed = true; resolveRead(json(snapshot(doc))); });
  await waitFor(() => expect(loadRunJournal()).toBeNull(), { timeout: 6000 });
  const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!);
  expect(saved.nodes.map((node: any) => node.lastOutput?.text)).toEqual(['Delivered a', 'Delivered b']);
  expect(screen.queryByText(/Historical results were retained|This page has an older canvas/)).toBeNull();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('still refuses to publish a historical result when the current durable inputs genuinely changed', async () => {
  const original = document();
  const changed = { ...original, nodes: original.nodes.map(node => node.kind === 'session' ? { ...node, persona: 'A different actual task' } : node) };
  seed(changed); saveRunJournal(journalFor(original)); fetchGraph(async () => json(snapshot(original))); renderCanvas();
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  expect(screen.getAllByText(/Historical results were retained/)[0]).toBeVisible();
  expect(screen.queryByText(/This page has an older canvas/)).toBeNull();
  const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!);
  expect(saved.nodes.every((node: any) => !node.lastOutput)).toBe(true);
  expect(saved.nodes.every((node: any) => node.persona === 'A different actual task')).toBe(true);
});

it.each([false, true])('preserves this page’s unsaved edit when the other owner has cleared its journal=%s', async ownerFinished => {
  const doc = document(); seed(doc); const failed = vi.fn();
  const fetcher = fetchGraph(async () => json(snapshot(doc)));
  render(<SaaSPreferencesProvider><CanvasSurface storageMode="cloud" onLocalDocumentSaveFailed={failed} /></SaaSPreferencesProvider>);
  const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY); const cached = localStorage.getItem(cacheKey);
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === cacheKey) throw new DOMException('Full', 'QuotaExceededError');
    setItem(key, value);
  });
  const tile = within(screen.getByTestId('canvas-tile-a'));
  fireEvent.click(tile.getByRole('button', { name: 'More node actions' }));
  fireEvent.click(tile.getByRole('button', { name: 'Delete', exact: true }));
  await waitFor(() => expect(failed).toHaveBeenCalled());
  expect(screen.queryByTestId('canvas-tile-a')).toBeNull();
  expect(failed.mock.lastCall?.[0].nodes.map((node: any) => node.id)).toEqual(['b']);
  act(() => {
    saveRunJournal(journalFor(doc)); dispatchJournal();
    if (ownerFinished) canvasStorage().removeItem(CANVAS_RUN_JOURNAL_KEY);
  });
  const durable = canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY);
  await screen.findByText(/This page has an older canvas/);
  expect(screen.queryByTestId('canvas-tile-a')).toBeNull();
  expect(screen.getByTestId('canvas-tile-b')).toBeVisible();
  expect(localStorage.getItem(cacheKey)).toBe(cached);
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(durable);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/graph-runs/'))).toBe(false);
});

it('does not clear a same-operation Stop update that arrives while terminal history is loading', async () => {
  const doc = { ...document(), nodes: document().nodes.map(node => ({ ...node, issueId: `session-${node.id}` })) };
  seed(doc); saveRunJournal(journalFor(doc));
  let resolveHistory!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: unknown) => String(url).endsWith('/graph-runs/graph-a') ? Promise.resolve(json(snapshot(doc)))
    : String(url).endsWith('/messages') ? new Promise<Response>(resolve => { resolveHistory = resolve; })
    : Promise.resolve(json({ items: [], models: [] }))));
  renderCanvas();
  await waitFor(() => expect(resolveHistory).toBeDefined());
  const current = loadRunJournal()!;
  saveRunJournal({ ...current, serverGraph: { ...current.serverGraph!, cancelRequested: true } });
  const durable = canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY);
  await act(async () => resolveHistory(json({ items: [] })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(canvasStorage().getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(durable);
  expect(loadRunJournal()?.serverGraph?.cancelRequested).toBe(true);
});

it('accepts the fresh durable base created by first-run initialization before recovering outputs', async () => {
  const ready = document();
  const unbound = { ...ready, nodes: ready.nodes.map(node => node.kind === 'session'
    ? { ...node, binding: null, runtime: '', model: '' } : node) };
  seed(unbound);
  configureSaaSCanvasInitialize(async () => { seed(ready); return ready; });
  configureSaaSCanvasSave(async () => 7);
  let admitted: GraphRunSnapshot | null = null;
  const fetcher = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    if (String(url).endsWith('/graph-runs') && init.method === 'POST') {
      const request = JSON.parse(String(init.body));
      expect(loadRunJournal()?.inputFingerprint).toBe(runInputFingerprint(ready, ['a', 'b']));
      admitted = { ...snapshot(ready), operationId: request.operationId };
      return json(admitted);
    }
    if (String(url).endsWith('/graph-runs/graph-a')) return json(admitted);
    return json({ items: [], models: [] });
  });
  vi.stubGlobal('fetch', fetcher); renderCanvas();
  fireEvent.click(screen.getByRole('button', { name: '▶ Run graph' }));
  await waitFor(() => expect(admitted).not.toBeNull());
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!);
  expect(saved.nodes.map((node: any) => node.lastOutput?.text)).toEqual(['Delivered a', 'Delivered b']);
  expect(screen.queryByText(/This page has an older canvas/)).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('does not write into another account or canvas when an old graph read completes late', async () => {
  const doc = document(); seed(doc); saveRunJournal(journalFor(doc));
  const originalStorage = canvasStorage(); const original = originalStorage.getItem(CANVAS_RUN_JOURNAL_KEY);
  let resolveRead!: (value: Response) => void;
  const fetcher = fetchGraph(() => new Promise(resolve => { resolveRead = resolve; })); renderCanvas();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/graph-runs/'))).toBe(true));
  configureCanvasStorage('other-user', 'other-workspace', 'other-canvas');
  configureSaaSCanvas({ tenant: { ...tenant, id: 'other-workspace' }, canvasId: 'other-canvas' });
  const other = canvasStorage(); other.setItem(CANVAS_STORAGE_KEY, 'Keep another account’s cache');
  other.setItem(CANVAS_RUN_JOURNAL_KEY, 'Keep another account’s journal');
  await act(async () => resolveRead(json(snapshot(doc))));
  expect(originalStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(original);
  expect(other.getItem(CANVAS_STORAGE_KEY)).toBe('Keep another account’s cache');
  expect(other.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe('Keep another account’s journal');
});

it.each([false, true])('retries its own unsaved recovery output after changing focused node=%s', async changeFocus => {
  const doc = document(); seed(doc); saveRunJournal(journalFor(doc));
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
    timeout(callback, ms === 2500 ? 30 : ms, ...args)) as typeof setTimeout);
  const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY); const setItem = localStorage.setItem.bind(localStorage);
  let allowOutputWrite = false;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === cacheKey && value.includes('Delivered') && !allowOutputWrite) throw new DOMException('Full', 'QuotaExceededError');
    setItem(key, value);
  });
  const failed = vi.fn(() => { allowOutputWrite = true; });
  fetchGraph(async () => json(snapshot(doc)));
  render(<SaaSPreferencesProvider><CanvasSurface storageMode="cloud" onLocalDocumentSaveFailed={failed} /></SaaSPreferencesProvider>);
  await waitFor(() => expect(failed).toHaveBeenCalled());
  if (changeFocus) fireEvent.click(screen.getByRole('button', { name: 'Open Agent a', exact: true }));
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!);
  expect(saved.nodes.map((node: any) => node.lastOutput?.text)).toEqual(['Delivered a', 'Delivered b']);
  expect(screen.queryByText(/This page has an older canvas/)).toBeNull();
});
