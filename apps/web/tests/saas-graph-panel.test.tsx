import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { GraphRunPanel } from '../src/saas/GraphRunPanel';
import type { GraphRunSnapshot, TeamTurn } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const base = '/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
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
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Background runs & collaboration/ }));
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

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
    ['en', 'provider_diagnostic_42', 'provider_diagnostic_42'],
  ] as const) {
    localStorage.setItem('superclaw_locale', locale);
    const fetcher = vi.fn(async (url: string) => {
      if (url === base) return json({ items: [graph({ status: 'failed', nodes: [{ nodeId: 'a', state: 'failed', runId: 'run-a', output: '', detail }] })] });
      if (runRecord(url)) return json({ id: 'run-a', tenantId: 'tenant-a', status: 'failed' });
      if (url === '/api/v1/tenants/tenant-a/runs/run-a/turns') return json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher); renderPanel();
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? /后台运行/ : /Background runs & collaboration/ }));
    const panel = within(await screen.findByRole('dialog'));
    await panel.findByText(expected);
    cleanup(); vi.unstubAllGlobals();
  }
});

it('renders actual member rounds, per-agent models, review text and final node output', async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
    if (url === base) return json({ items: [graph()] });
    if (runRecord(url)) return json(runRecord(url));
    if (url === '/api/v1/tenants/tenant-a/runs/run-a/turns') return json({ items: turns });
    if (url === '/api/v1/tenants/tenant-a/runs/run-b/turns') return json({ items: [{ ...turns[0], id: 'delivery-turn', memberName: 'Delivery Kai', output: 'Delivery member response' }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  const panel = within(await screen.findByRole('dialog', { name: 'Background runs & collaboration' }));
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
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(runRecord(url) || (url === base ? { items: [graph()] } : { items: turns })));
  vi.stubGlobal('fetch', fetcher); renderPanel(true); openPanel();
  await screen.findByText('Review: verify the cost estimate');
  expect(screen.queryByRole('button', { name: 'Stop entire task' })).toBeNull();
  expect(screen.getByText('Research consensus from the server')).toBeVisible();
  expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

it('sends an explicit Stop for the selected graph and displays the authoritative refreshed state', async () => {
  let stopped = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === `${base}/graph-a/cancel` && init.method === 'POST') { stopped = true; return json({ confirmed: true }); }
    if (url === base) return json({ items: [graph(stopped ? { status: 'cancelled', nodes: [{ nodeId: 'a', state: 'done', output: 'Research consensus from the server' }, { nodeId: 'b', state: 'cancelled', output: 'Delivery partial evidence' }] } : {})] });
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
    return json(runRecord(url) || (url === base ? { items: [graph()] } : { items: [] }));
  });
  vi.stubGlobal('fetch', fetcher); renderPanel(); openPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop entire task' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
  expect(screen.getByText('Running', { selector: 'strong' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop entire task' })).toBeEnabled();
  expect(screen.getByText('Research consensus from the server')).toBeVisible();
});

it('detaches observers on panel close and component unmount without cancelling accepted work', async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(runRecord(url) || (url === base ? { items: [graph()] } : { items: turns })));
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
