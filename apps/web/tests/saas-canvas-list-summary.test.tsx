import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasListItem, CanvasRecord, Tenant } from '../src/saas/api';

// The canvas list reads the summary view: each canvas's outline (its nodes' boxes and its edges) for the card, never
// its document, unless a view built from the list's first page needs the documents.
const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const wrap = (node: React.ReactNode) => <SaaSPreferencesProvider>{node}</SaaSPreferencesProvider>;
const boxes = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, x: i * 400, y: 0, w: 340, h: 260 }));
const summary = (id: string, nodes: number, nodeCount = nodes): CanvasListItem => ({
  id, tenantId: tenant.id, name: `Canvas ${id}`, version: 3, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
  outline: { nodes: boxes(nodes), edges: nodes > 1 ? [{ fromNode: 'n0', toNode: 'n1' }] : [], nodeCount } });
const card = (name: string) => screen.getByRole('heading', { name }).closest('article')!;
const drawnBoxes = (name: string) => card(name).querySelectorAll('.saas-canvas-thumb rect.saas-canvas-thumb-node').length;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reads the summary view and draws each card from its outline, counting every node', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => { urls.push(input); return json({ items: [summary('big', 60, 72), summary('small', 2)], nextCursor: null }); }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas big' });
  expect(urls).toEqual(['/api/v1/tenants/tenant-a/canvases?view=summary&limit=50']);
  expect(drawnBoxes('Canvas big')).toBe(60);
  expect(drawnBoxes('Canvas small')).toBe(2);
  // A thumbnail draws the outline's 60 boxes; the card counts all 72 nodes.
  expect(within(card('Canvas big')).getByText('72 个节点')).toBeInTheDocument();
  expect(within(card('Canvas small')).getByText('2 个节点')).toBeInTheDocument();
});

it('draws from the document when the API sends one instead of an outline', async () => {
  const old: CanvasRecord = { id: 'old', tenantId: tenant.id, name: 'Canvas old', version: 1, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
    document: { nodes: boxes(3), edges: [] } };
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [old, summary('empty', 0)], nextCursor: null })));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas old' });
  expect(drawnBoxes('Canvas old')).toBe(3);
  expect(within(card('Canvas old')).getByText('3 个节点')).toBeInTheDocument();
  expect(within(card('Canvas empty')).getByText('空白画布')).toBeInTheDocument();
});

it('ignores an outline node count that is not a count', async () => {
  const odd = (id: string, nodeCount: unknown) => ({ ...summary(id, 2), outline: { nodes: boxes(2), edges: [], nodeCount } });
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [odd('text', '9'), odd('fraction', 2.5), odd('negative', -1), odd('missing', undefined)], nextCursor: null })));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas text' });
  for (const name of ['Canvas text', 'Canvas fraction', 'Canvas negative', 'Canvas missing']) {
    expect(within(card(name)).getByText('2 个节点')).toBeInTheDocument();
  }
});

it('reads whole documents when a view is built from the first page', async () => {
  const urls: string[] = [];
  const full: CanvasRecord = { id: 'full', tenantId: tenant.id, name: 'Canvas full', version: 1, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
    document: { nodes: boxes(1), edges: [] } };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => { urls.push(input); return json({ items: [full], nextCursor: null }); }));
  const onFirstPage = vi.fn();
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} onFirstPage={onFirstPage}/>));
  await screen.findByRole('heading', { name: 'Canvas full' });
  expect(urls).toEqual(['/api/v1/tenants/tenant-a/canvases?limit=50']);
  await waitFor(() => expect(onFirstPage).toHaveBeenCalledWith([full]));
});

it('renames a canvas listed by its outline with the canvas it reads first, never the outline', async () => {
  const stored = { nodes: [{ id: 'n0', kind: 'session', x: 0, y: 0, lastOutput: { text: 'kept' } }], edges: [] };
  const sent: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    sent.push({ url: input, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    if (input.includes('?')) return json({ items: [summary('one', 1)], nextCursor: null });
    if ((init.method || 'GET') === 'GET') return json({ ...summary('one', 1), outline: undefined, document: stored, version: 7 });
    return json({ ok: true });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas one' });
  fireEvent.click(within(card('Canvas one')).getByRole('button', { name: '画布选项：Canvas one' }));
  fireEvent.click(screen.getByRole('button', { name: '改名' }));
  const input = await screen.findByLabelText('画布名称');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'Renamed' } });
  await waitFor(() => expect(screen.queryByText('正在读取最新画布…')).toBeNull());
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sent.some(request => request.method === 'PUT')).toBe(true));
  const put = sent.find(request => request.method === 'PUT')!;
  expect(put.url).toBe('/api/v1/tenants/tenant-a/canvases/one');
  expect(JSON.parse(put.body!)).toEqual({ name: 'Renamed', document: stored, version: 7 });
});
