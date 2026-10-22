import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { GraphRunPanel } from '../src/saas/GraphRunPanel';
import { useCanvasKeys } from '../src/canvas/useCanvasKeys';
import type { GraphRunSnapshot, TeamTurn } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { runErrorText } from '../src/saas/canvasErrors';
import { graphRunSummary } from './saas-graph-run-summary-fixture';

const base = '/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
// The list sends each run's summary; a run's own route sends it whole, with its frozen canvas and its nodes' outputs.
const runs = (url: string, ...items: GraphRunSnapshot[]) => url === base ? { items: items.map(graphRunSummary) }
  : items.find(item => url === `${base}/${item.id}`) ?? null;
const flushTimers = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const runRecord = (url: string) => /\/runs\/run-[ab]$/.test(url)
  ? { id: url.endsWith('run-a') ? 'run-a' : 'run-b', tenantId: 'tenant-a', status: url.endsWith('run-a') ? 'completed' : 'running' } : null;
const graph = (patch: Partial<GraphRunSnapshot> = {}): GraphRunSnapshot => ({
  id: 'graph-a', operationId: 'operation-a', canvasId: 'canvas-a', documentVersion: 8, scope: ['a', 'b'], status: 'running', createdAt: '2026-09-08T03:04:05Z',
  document: { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Research team' }, { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'b', title: 'Delivery team' }] },
  nodes: [{ nodeId: 'a', state: 'done', runId: 'run-a', output: 'Research consensus from the server' }, { nodeId: 'b', state: 'running', runId: 'run-b', output: 'Delivery draft from the server' }], ...patch,
});
const turns: TeamTurn[] = [
  { id: 'turn-1', memberId: 'writer', memberName: 'Writer Ada', role: 'member', round: 1, status: 'completed', model: 'writer-profile', output: 'First proposal with evidence' },
  { id: 'turn-2', memberId: 'reviewer', memberName: 'Reviewer Lin', role: 'reviewer', round: 1, status: 'completed', model: 'review-profile', output: 'Review: verify the cost estimate' },
  { id: 'turn-3', memberId: 'writer', memberName: 'Writer Ada', role: 'member', round: 2, status: 'completed', model: 'writer-profile', output: 'Revised proposal incorporating the review' },
];
const renderPanel = (readOnly = false) => render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" readOnly={readOnly}/></SaaSPreferencesProvider>);
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Run history/ }));
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

// A node that failed its delivery contract must say so in the reader's language, while a
// detail the panel does not know still shows verbatim rather than being swallowed.
it('labels a delivery-contract failure in both locales and leaves an unmapped detail raw', async () => {
  for (const [locale, detail, expected] of [
    ['en', 'output_contract_invalid', 'Output did not match the delivery format'],
    ['zh', 'output_contract_invalid', '输出不符合交付格式'],
    ['en', 'provider_auth_failed', 'The provider rejected the credentials'],
    ['zh', 'provider_auth_failed', '模型服务拒绝了凭据'],
    ['zh', 'model_refused', '模型拒绝了请求'],
    ['en', 'provider_rate_limited', 'The provider is rate limited'],
    ['zh', 'provider_unavailable', '模型服务暂不可用'],
    // A code with no short label reads as it does on the node, with what to do (it showed as its code).
    ['en', 'run_timeout', runErrorText('run_timeout', 'en')!],
    ['zh', 'team_timeout', runErrorText('team_timeout', 'zh')!],
    ['en', 'context_limit', saasErrorMessage(new SaaSApiError(0, 'context_limit', ''), 'en')],
    ['en', 'provider_diagnostic_42', 'provider_diagnostic_42'],
  ] as const) {
    localStorage.setItem('superclaw_locale', locale);
    const failed = graph({ status: 'failed', nodes: [{ nodeId: 'a', state: 'failed', runId: 'run-a', output: '', detail }] });
    const fetcher = vi.fn(async (url: string) => {
      if (runs(url, failed)) return json(runs(url, failed));
      if (runRecord(url)) return json({ id: 'run-a', tenantId: 'tenant-a', status: 'failed' });
      if (url === '/api/v1/tenants/tenant-a/runs/run-a/turns') return json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher); renderPanel();
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? /运行记录/ : /Run history/ }));
    const panel = within(await screen.findByRole('dialog'));
    await panel.findByText(expected);
    cleanup(); vi.unstubAllGlobals();
  }
});

it('renders actual member rounds, per-agent models, review text and final node output', async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
    if (runs(url, graph())) return json(runs(url, graph()));
    if (runRecord(url)) return json(runRecord(url));
    if (url === '/api/v1/tenants/tenant-a/runs/run-a/turns') return json({ items: turns });
    if (url === '/api/v1/tenants/tenant-a/runs/run-b/turns') return json({ items: [{ ...turns[0], id: 'delivery-turn', memberName: 'Delivery Kai', output: 'Delivery member response' }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  const panel = within(await screen.findByRole('dialog', { name: 'Run history' }));
  await panel.findByText('Revised proposal incorporating the review');
  expect(panel.getByText('Research consensus from the server')).toBeVisible();
  expect(panel.getByText('1/2 nodes completed')).toBeVisible();
  const articles = panel.getAllByRole('article'); expect(articles).toHaveLength(3);
  expect(articles[0]).toHaveTextContent('Writer Ada'); expect(articles[0]).toHaveTextContent('member · Round 1 · Completed');
  expect(articles[0]).toHaveTextContent('writer-profile'); expect(articles[0]).toHaveTextContent('First proposal with evidence');
  expect(articles[1]).toHaveTextContent('Reviewer Lin'); expect(articles[1]).toHaveTextContent('reviewer · Round 1 · Completed');
  expect(articles[1]).toHaveTextContent('review-profile'); expect(articles[1]).toHaveTextContent('verify the cost estimate');
  expect(articles[2]).toHaveTextContent('member · Round 2 · Completed');
  fireEvent.click(within(panel.getByRole('navigation', { name: 'Run nodes' })).getByRole('button', { name: 'Delivery team · Running' }));
  await panel.findByText('Delivery member response');
  expect(panel.getByText('Delivery draft from the server')).toBeVisible();
  expect(panel.queryByText('Research consensus from the server')).toBeNull();
  expect(panel.queryByText('Review: verify the cost estimate')).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => !init.method && init.credentials === 'include')).toBe(true);
});

it('lets a reader inspect active collaboration but never offers Stop or sends a mutation', async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(runRecord(url) || runs(url, graph()) || { items: turns }));
  vi.stubGlobal('fetch', fetcher); renderPanel(true); openPanel();
  await screen.findByText('Review: verify the cost estimate');
  expect(screen.queryByRole('button', { name: 'Stop entire task' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Export this graph’s evidence' })).toBeEnabled();
  expect(screen.getByText('graph-a')).toBeVisible();
  expect(screen.getByText('run-a', { selector: 'code' })).toBeVisible();
  expect(screen.getByText('Research consensus from the server')).toBeVisible();
  expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

it('sends an explicit Stop for the selected graph and displays the authoritative refreshed state', async () => {
  let stopped = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === `${base}/graph-a/cancel` && init.method === 'POST') { stopped = true; return json({ confirmed: true }); }
    const current = graph(stopped ? { status: 'cancelled', nodes: [{ nodeId: 'a', state: 'done', output: 'Research consensus from the server' }, { nodeId: 'b', state: 'cancelled', output: 'Delivery partial evidence' }] } : {});
    if (runs(url, current)) return json(runs(url, current));
    if (url.endsWith('/turns')) return json({ items: turns });
    if (runRecord(url)) return json(runRecord(url));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop entire task' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cancelled'));
  expect(screen.queryByRole('button', { name: 'Stop entire task' })).toBeNull();
  const writes = fetcher.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(writes).toHaveLength(1); expect(writes[0]![0]).toBe(`${base}/graph-a/cancel`);
  expect(writes[0]![1]).toMatchObject({ body: '{}', credentials: 'include' });
  expect(screen.getByText('Research consensus from the server')).toBeVisible();
});

it('keeps a running graph visible after a rejected Stop instead of reporting cancellation', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') return json({ error: { code: 'forbidden', message: 'Stop forbidden' } }, 403);
    return json(runRecord(url) || runs(url, graph()) || { items: [] });
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop entire task' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
  expect(screen.getByText('Running', { selector: 'strong' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop entire task' })).toBeEnabled();
  expect(screen.getByText('Research consensus from the server')).toBeVisible();
});

it('detaches observers on panel close and component unmount without cancelling accepted work', async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(runRecord(url) || runs(url, graph()) || { items: turns }));
  vi.stubGlobal('fetch', fetcher); const view = renderPanel(); openPanel();
  await screen.findByText('First proposal with evidence');
  const turnSignal = fetcher.mock.calls.find(([url]) => url.endsWith('/turns'))![1].signal!;
  fireEvent.click(screen.getByRole('button', { name: 'Close run history' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(turnSignal.aborted).toBe(true);
  view.unmount();
  expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
});

it('reports a malformed history response without crashing the canvas shell', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ document: {}, version: 1 })));
  renderPanel(); openPanel();
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid graph run response');
  expect(screen.getByRole('button', { name: 'Close run history' })).toBeVisible();
});


it('contains run-history shortcuts and restores the canvas trigger without changing its selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
  const canvasAction = vi.fn();
  function CanvasHarness() {
    useCanvasKeys({
      onDeleteSelection: canvasAction,
      onUndo: canvasAction,
      onRedo: canvasAction,
      onPalette: canvasAction,
      onFocusToggle: canvasAction,
      onEscape: canvasAction,
    });
    return <GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" />;
  }
  render(<SaaSPreferencesProvider><CanvasHarness /></SaaSPreferencesProvider>);
  const trigger = screen.getByRole('button', { name: 'Run history' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Run history' });
  const close = within(panel).getByRole('button', { name: 'Close run history' });
  expect(panel).toHaveFocus();
  await within(panel).findByText('No background graph runs yet.');
  for (const target of [panel, close]) {
    for (const key of ['Delete', 'Backspace']) fireEvent.keyDown(target, { key });
    for (const key of ['z', 'y', 'p', 'e']) {
      fireEvent.keyDown(target, { key, ctrlKey: true });
      fireEvent.keyDown(target, { key, metaKey: true });
    }
  }
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(close).toHaveFocus();
  for (const shiftKey of [false, true]) {
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
  }
  expect(canvasAction).not.toHaveBeenCalled();
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
  expect(canvasAction).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(canvasAction).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Close run history' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('wraps run-history Tab focus through the controls in both directions', async () => {
  const completed = graph({ status: 'completed', nodes: [{ nodeId: 'a', state: 'done' }, { nodeId: 'b', state: 'done' }] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(runs(url, completed))));
  render(<SaaSPreferencesProvider><button>Outside canvas action</button><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" /></SaaSPreferencesProvider>);
  openPanel();
  const panel = screen.getByRole('dialog');
  const first = within(panel).getByRole('button', { name: 'Close run history' });
  const selector = await within(panel).findByRole('combobox', { name: 'Select run' });
  const exportButton = within(panel).getByRole('button', { name: 'Export this graph’s evidence' });
  const nodeA = await within(panel).findByRole('button', { name: 'Research team · Completed' });
  const last = within(panel).getByRole('button', { name: 'Delivery team · Completed' });
  expect(panel).toHaveFocus();
  for (const expected of [first, selector, exportButton, nodeA, last, first]) {
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(expected).toHaveFocus();
  }
  for (const expected of [last, nodeA, exportButton, selector, first, last]) {
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(expected).toHaveFocus();
  }
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Run history' })).toHaveFocus();
});

// The list carries no run's canvas or outputs (graph_runs.go). The panel polls it alone while closed, reads the run it
// shows whole when it opens (its steps' titles and outputs come from that read), and again only when the list says the
// run changed: a node's output moves only with its state, so a run that goes on is not read on every poll.
it('polls the light list alone while closed and reads the run it shows whole once opened, again only when the list says it changed', async () => {
  vi.useFakeTimers();
  let settled = false;
  const latest = () => graph({ status: settled ? 'completed' : 'running', nodes: [
    { nodeId: 'a', state: 'done', output: 'Research consensus from the server' },
    { nodeId: 'b', state: settled ? 'done' : 'running', output: settled ? 'Delivery from the server' : '' }] });
  const earlier = graph({ id: 'graph-b', operationId: 'operation-b', status: 'completed', createdAt: '2026-09-07T03:04:05Z',
    nodes: [{ nodeId: 'a', state: 'done', output: 'An earlier consensus' }, { nodeId: 'b', state: 'done', output: 'An earlier delivery' }] });
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
    const found = runs(url, latest(), earlier);
    if (found) return json(found);
    throw new Error(`Unexpected request: ${url}`);
  });
  const reads = (from: number) => fetcher.mock.calls.slice(from).map(([url]) => url === base ? 'list' : url.slice(base.length + 1));
  vi.stubGlobal('fetch', fetcher); renderPanel();
  await flushTimers(); await flushTimers(5000); await flushTimers(5000);
  expect(reads(0)).toEqual(['list', 'list', 'list']);
  openPanel(); await flushTimers();
  expect(reads(3)).toEqual(['list', 'graph-a']);
  const panel = within(screen.getByRole('dialog'));
  expect(panel.getByText('Research consensus from the server')).toBeVisible();
  expect(panel.getByRole('button', { name: 'Delivery team · Running' })).toBeVisible();
  // It goes on, and the list says nothing new of it: the list alone.
  await flushTimers(2000); await flushTimers(2000);
  expect(reads(5)).toEqual(['list', 'list']);
  // A step settles: the list says so, and the run is read again, with that step's output.
  settled = true; await flushTimers(2000);
  expect(reads(7)).toEqual(['list', 'graph-a']);
  fireEvent.click(panel.getByRole('button', { name: 'Delivery team · Completed' }));
  expect(panel.getByText('Delivery from the server')).toBeVisible();
  // Settled, with nothing new in the list: the list alone.
  await flushTimers(2000); await flushTimers(2000);
  expect(reads(9)).toEqual(['list', 'list']);
  // A run picked in the list is read once, then the list alone again.
  fireEvent.change(panel.getByRole('combobox', { name: 'Select run' }), { target: { value: 'graph-b' } }); await flushTimers();
  expect(reads(11)).toEqual(['list', 'graph-b']);
  expect(panel.getByText('An earlier consensus')).toBeVisible();
  await flushTimers(2000);
  expect(reads(13)).toEqual(['list']);
  // Closed, the list alone every 5 s; opened again, the run it shows is read once more.
  fireEvent.click(panel.getByRole('button', { name: 'Close run history' })); await flushTimers(); await flushTimers(5000);
  expect(reads(14)).toEqual(['list', 'list']);
  // Opened again, it shows what the list says until the run is read anew, never the earlier opening's read.
  openPanel();
  expect(screen.getByText('Reading this run…')).toBeVisible();
  expect(screen.queryByText('An earlier consensus')).toBeNull();
  await flushTimers();
  expect(reads(16)).toEqual(['list', 'graph-b']);
  expect(screen.getByText('An earlier consensus')).toBeVisible();
  expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

// A collaboration's turns go on with no step's state moving, and the list does not carry them: while one goes on, the
// panel reads it on every poll, and once it has settled, no more.
it('reads a collaboration that goes on at every poll, and no more once it has settled', async () => {
  vi.useFakeTimers();
  let turns = 0;
  const collaborating = () => graph({ status: turns > 2 ? 'completed' : 'running',
    nodes: [{ nodeId: 'a', state: turns > 2 ? 'done' : 'running' }, { nodeId: 'b', state: turns > 2 ? 'done' : 'waiting' }],
    collaboration: { goal: 'Agree on one plan', rounds: 1, synthesizerNodeId: 'a', maxModelCalls: 5, phase: 'proposal', round: 1,
      turns: Array.from({ length: Math.min(turns, 2) + 1 }, (_, index) => ({ ordinal: index + 1, nodeId: index % 2 ? 'b' : 'a', phase: 'proposal' as const, round: 1,
        status: 'waiting' as const, output: `Turn ${index + 1} of the plan` })) } });
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
    const found = runs(url, collaborating());
    if (!found) throw new Error(`Unexpected request: ${url}`);
    if (url !== base) turns++;
    return json(found);
  });
  const reads = (from: number) => fetcher.mock.calls.slice(from).map(([url]) => url === base ? 'list' : url.slice(base.length + 1));
  vi.stubGlobal('fetch', fetcher); renderPanel(); await flushTimers();
  openPanel(); await flushTimers();
  expect(reads(1)).toEqual(['list', 'graph-a']);
  const panel = within(screen.getByRole('dialog'));
  expect(panel.getByText('Turn 1 of the plan')).toBeInTheDocument();
  // Its turns go on where the list says nothing: each poll reads it.
  await flushTimers(2000);
  expect(reads(3)).toEqual(['list', 'graph-a']);
  expect(panel.getByText('Turn 2 of the plan')).toBeInTheDocument();
  await flushTimers(2000);
  expect(reads(5)).toEqual(['list', 'graph-a']);
  // Settled: read once more, as the list says it changed, then the list alone.
  await flushTimers(2000);
  expect(reads(7)).toEqual(['list', 'graph-a']);
  await flushTimers(2000); await flushTimers(2000);
  expect(reads(9)).toEqual(['list', 'list']);
  expect(panel.getByText('Completed', { selector: 'strong' })).toBeVisible();
});

// A retry takes a node from running back to running with a new run, after a wait no poll need see (a sleeping laptop, a
// frozen tab): the list carries a retried node's attempts, so the panel reads the run again all the same.
it('reads the run again for a retry the list shows only by its attempts', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const run = () => graph({ nodes: [{ nodeId: 'a', state: 'done' }, { nodeId: 'b', state: 'running', attempts }] });
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
    const found = runs(url, run());
    if (!found) throw new Error(`Unexpected request: ${url}`);
    return json(found);
  });
  const reads = (from: number) => fetcher.mock.calls.slice(from).map(([url]) => url === base ? 'list' : url.slice(base.length + 1));
  vi.stubGlobal('fetch', fetcher); renderPanel(); await flushTimers();
  openPanel(); await flushTimers();
  expect(reads(1)).toEqual(['list', 'graph-a']);
  await flushTimers(2000);
  expect(reads(3)).toEqual(['list']);
  // Between two polls the node failed, waited and began its next attempt: running before and after.
  attempts = 1; await flushTimers(2000);
  expect(reads(4)).toEqual(['list', 'graph-a']);
  await flushTimers(2000);
  expect(reads(6)).toEqual(['list']);
});

// Until the run's own read answers, the panel shows what the list says of it, and none of what it made.
it('shows what the list says of the run while its own read is pending, and none of its outputs', async () => {
  let answer!: (response: Response) => void;
  const fetcher = vi.fn(async (url: string) => {
    if (url === base) return json(runs(url, graph()));
    if (url === `${base}/graph-a`) return new Promise<Response>(resolve => { answer = resolve; });
    return json(runRecord(url) || { items: [] });
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  const panel = within(await screen.findByRole('dialog'));
  await panel.findByText('Reading this run…');
  expect(panel.getByText('Running', { selector: 'strong' })).toBeVisible();
  expect(panel.getByText('1/2 nodes completed')).toBeVisible();
  expect(panel.getByRole('button', { name: 'Stop entire task' })).toBeEnabled();
  expect(panel.queryByRole('navigation', { name: 'Run nodes' })).toBeNull();
  expect(panel.queryByText('Research consensus from the server')).toBeNull();
  answer(json(graph()));
  await panel.findByText('Research consensus from the server');
  expect(panel.queryByText('Reading this run…')).toBeNull();
  expect(panel.getByRole('button', { name: 'Research team · Completed' })).toBeVisible();
});

it('says so when the run cannot be read, keeps what the list says, and reads it again on Retry', async () => {
  let refuse = true;
  const fetcher = vi.fn(async (url: string) => {
    if (url === `${base}/graph-a` && refuse) return json({ error: { code: 'internal_error', message: 'Read failed' } }, 500);
    return json(runRecord(url) || runs(url, graph()) || { items: [] });
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  const panel = within(await screen.findByRole('dialog'));
  expect(await panel.findByRole('alert')).toHaveTextContent('Retry');
  expect(panel.getByText('Running', { selector: 'strong' })).toBeVisible();
  expect(panel.queryByText('Reading this run…')).toBeNull();
  refuse = false; fireEvent.click(panel.getByRole('button', { name: 'Retry' }));
  await panel.findByText('Research consensus from the server');
  expect(panel.queryByRole('alert')).toBeNull();
});
