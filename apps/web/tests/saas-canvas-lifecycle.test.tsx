import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { CreateWorkspaceDialog, SaaSApp } from '../src/saas/SaaSApp';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument, type NodeOutput } from '../src/canvas/canvasDoc';
import { canvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import type { GraphRunSnapshot } from '../src/saas/graphRuns';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const record = (i: number): CanvasRecord => ({ id: `canvas-${i}`, tenantId: tenant.id, name: `Canvas ${i}`, version: 1, document: { nodes: [] }, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const wrap = (node: React.ReactNode) => <SaaSPreferencesProvider>{node}</SaaSPreferencesProvider>;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('makes the 201st canvas reachable through bounded pages, previous and refresh', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => record(i));
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    const offset = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
    return json({ items: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null });
  }));
  const onOpen = vi.fn(); render(wrap(<CanvasList tenant={tenant} onOpen={onOpen}/>));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  const pager = within(screen.getByRole('navigation', { name: '画布分页' }));
  for (let page = 1; page < 5; page++) {
    fireEvent.click(pager.getByRole('button', { name: '下一页' }));
    await screen.findByRole('heading', { name: `Canvas ${page * 50}` });
  }
  fireEvent.click(screen.getByRole('button', { name: /^Canvas 200/ })); expect(onOpen).toHaveBeenCalledWith('canvas-200');
  expect(pager.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(pager.getByRole('button', { name: '上一页' })); await screen.findByRole('heading', { name: 'Canvas 150' });
  fireEvent.click(pager.getByRole('button', { name: '刷新列表' })); await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(requests.every(url => url.searchParams.get('limit') === '50')).toBe(true);
  expect(requests.map(url => url.searchParams.get('cursor'))).toEqual([null, '50', '100', '150', '200', '150', null]);
});

it('ignores a late canvas list response from a previous tenant and starts the new scope at page one', async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn((input: string) => input.includes('tenant-a') ? new Promise<Response>(resolve => { resolveOld = resolve; }) : Promise.resolve(json({ items: [{ ...record(3), name: 'Only B' }], nextCursor: null })));
  vi.stubGlobal('fetch', fetcher);
  const view = render(wrap(<CanvasList key="a" tenant={tenant} onOpen={vi.fn()}/>));
  view.rerender(wrap(<CanvasList key="b" tenant={{ ...tenant, id: 'tenant-b' }} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Only B' });
  await act(async () => resolveOld(json({ items: [{ ...record(1), name: 'Private A' }], nextCursor: 'a-next' })));
  expect(screen.queryByText('Private A')).toBeNull();
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
  expect(screen.getByRole('button', { name: '刷新列表' })).toBeEnabled();
  expect(fetcher.mock.calls[1][0]).toBe('/api/v1/tenants/tenant-b/canvases?view=summary&limit=50');
});

it('recovers from an invalid page cursor by refreshing from the first page', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => { urls.push(input); return input.includes('cursor=') ? json({ error: { code: 'invalid_cursor', message: 'Invalid cursor' } }, 400) : json({ items: [record(0)], nextCursor: 'expired' }); }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('分页已失效');
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(urls.at(-1)).toBe('/api/v1/tenants/tenant-a/canvases?view=summary&limit=50');
});

it('does not write when renaming is cancelled, including before the initial read completes', async () => {
  let resolveRead!: (response: Response) => void; const methods: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    methods.push(init.method || 'GET');
    if (input.includes('?')) return json({ items: [record(0)], nextCursor: null });
    return new Promise<Response>(resolve => { resolveRead = resolve; });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  fireEvent.click(await screen.findByRole('button', { name: '画布选项：Canvas 0' }));
  fireEvent.click(screen.getByRole('button', { name: '改名', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: '画布名称' }), { target: { value: 'Cancelled name' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => resolveRead(json(record(0))));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(methods).toEqual(['GET', 'GET']);
  expect(screen.getByRole('heading', { name: 'Canvas 0' })).toBeVisible();
});

it('renames with the latest document and exact CAS version, preserving input on conflict', async () => {
  let version = 7, reject = true;
  const cloudDocument = { nodes: [{ id: 'private-node', threads: [{ draft: 'keep me' }] }], view: { scale: 0.7 } };
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { writes.push(JSON.parse(init.body as string)); return reject ? json({ error: { code: 'version_conflict', message: 'Changed' } }, 409) : json(record(0)); }
    return input.includes('?') ? json({ items: [record(0)], nextCursor: null }) : json({ ...record(0), document: cloudDocument, version });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  fireEvent.click(await screen.findByRole('button', { name: '画布选项：Canvas 0' }));
  fireEvent.click(screen.getByRole('button', { name: '改名', exact: true }));
  const dialog = within(screen.getByRole('dialog', { name: '更改画布名称' }));
  await waitFor(() => expect(dialog.getByRole('button', { name: '保存名称' })).toBeEnabled());
  fireEvent.change(dialog.getByRole('textbox', { name: '画布名称' }), { target: { value: 'My rename' } });
  fireEvent.click(dialog.getByRole('button', { name: '保存名称' }));
  await dialog.findByRole('alert');
  expect(writes[0]).toEqual({ name: 'My rename', document: cloudDocument, version: 7 });
  expect(dialog.getByRole('textbox', { name: '画布名称' })).toHaveValue('My rename');
  version = 9; reject = false;
  fireEvent.click(dialog.getByRole('button', { name: '刷新云端版本，保留名称' }));
  await waitFor(() => expect(dialog.queryByRole('alert')).toBeNull());
  fireEvent.click(dialog.getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes[1]).toEqual({ name: 'My rename', document: cloudDocument, version: 9 });
});

it('requires explicit deletion, sends nothing on cancel, and preserves the canvas on active-run rejection', async () => {
  let removed = false, active = true; const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') { writes.push('delete'); if (active) return json({ error: { code: 'resource_in_use', message: 'Active run' } }, 409); removed = true; return new Response(null, { status: 204 }); }
    return json({ items: removed ? [] : [record(0)], nextCursor: null });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  fireEvent.click(await screen.findByRole('button', { name: '画布选项：Canvas 0' }));
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
  expect(screen.getByRole('dialog')).toHaveTextContent('全部会话和运行历史');
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(writes).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '画布选项：Canvas 0' }));
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('正在执行');
  expect(screen.getByRole('heading', { name: 'Canvas 0' })).toBeVisible();
  expect(screen.getByRole('dialog')).toBeVisible();
  active = false; fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Canvas 0' })).toBeNull());
  expect(writes).toEqual(['delete', 'delete']);
});

it('shows reader canvases without create, rename or delete controls', async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ items: [record(0)], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  render(wrap(<CanvasList tenant={{ ...tenant, role: 'reader' }} onOpen={vi.fn()}/>));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(screen.queryByRole('button', { name: '新建画布' })).toBeNull();
  expect(screen.queryByRole('button', { name: /改名|删除/ })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

// Creating canvases moved to the workspace home's prompt box; saas-workspace-home.test.tsx covers
// the untitled blank canvas and keeping the request when creation fails. The list itself creates nothing.
it('offers no creation control of its own', async () => {
  const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => json({ items: [record(0)], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4}/>));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(screen.queryByRole('button', { name: '新建画布' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '新画布名称' })).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

const titles = () => screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);

it('shows the most recently updated canvases first and expands the full list in place', async () => {
  const rows = [
    { ...record(0), name: 'Oldest', updatedAt: '2026-09-01T00:00:00Z' }, { ...record(1), name: 'Newest', updatedAt: '2026-09-06T00:00:00Z' },
    { ...record(2), name: 'Middle', updatedAt: '2026-09-03T00:00:00Z' }, { ...record(3), name: 'Second', updatedAt: '2026-09-05T00:00:00Z' },
    { ...record(4), name: 'Third', updatedAt: '2026-09-04T00:00:00Z' }, { ...record(5), name: 'Fifth', updatedAt: '2026-09-02T00:00:00Z' },
  ];
  const fetcher = vi.fn(async () => json({ items: rows, nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4}/>));
  await screen.findByRole('heading', { name: 'Newest' });
  expect(screen.getByRole('heading', { level: 2, name: '继续工作' })).toBeVisible();
  expect(screen.getByText('6 张画布')).toBeVisible();
  expect(titles()).toEqual(['Newest', 'Second', 'Third', 'Middle']);
  const toggle = screen.getByRole('button', { name: '查看全部 6 张' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(screen.getByRole('heading', { name: 'Newest' }));
  expect(screen.queryByRole('navigation', { name: '画布分页' })).toBeNull();
  fireEvent.click(toggle);
  expect(titles()).toEqual(['Newest', 'Second', 'Third', 'Middle', 'Fifth', 'Oldest']);
  expect(screen.getAllByRole('button', { name: /^画布选项：/ })).toHaveLength(6);
  const collapse = screen.getByRole('button', { name: '收起' });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(collapse);
  expect(titles()).toEqual(['Newest', 'Second', 'Third', 'Middle']);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('searches the loaded page by name, case-insensitively, without another request', async () => {
  const rows = ['Launch plan A', 'Launch plan B', 'Budget', 'launch plan C', 'Launch plan D', 'LAUNCH plan E'].map((name, i) => ({ ...record(i), name }));
  const fetcher = vi.fn(async () => json({ items: rows, nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4}/>));
  await screen.findByRole('heading', { name: 'Launch plan A' });
  const search = screen.getByRole('searchbox', { name: '按名称搜索画布' });
  fireEvent.change(search, { target: { value: 'launch' } });
  // A search shows every match, not only the four most recent.
  expect(titles()).toEqual(['Launch plan A', 'Launch plan B', 'launch plan C', 'Launch plan D', 'LAUNCH plan E']);
  expect(screen.getByText('找到 5 张画布').closest('[role="status"]')).not.toBeNull();
  fireEvent.change(search, { target: { value: '  BUDGET ' } });
  expect(titles()).toEqual(['Budget']);
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  expect(screen.getByText('没有名称包含“zzz”的画布')).toBeVisible();
  expect(screen.queryByText('从第一张画布开始')).toBeNull();
  fireEvent.change(search, { target: { value: '' } });
  expect(titles()).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('pages only the expanded list, says a search covers this page only, and collapses back to the newest page', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => record(i));
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    const offset = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
    return json({ items: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4}/>));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(titles()).toEqual(['Canvas 0', 'Canvas 1', 'Canvas 2', 'Canvas 3']);
  expect(screen.getByText('50+ 张画布')).toBeVisible();
  expect(screen.queryByRole('navigation', { name: '画布分页' })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox', { name: '按名称搜索画布' }), { target: { value: 'Canvas 1' } });
  expect(screen.getByText('找到 11 张画布（只搜索当前页）')).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox', { name: '按名称搜索画布' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '查看全部画布' }));
  const pager = within(screen.getByRole('navigation', { name: '画布分页' }));
  fireEvent.click(pager.getByRole('button', { name: '下一页' }));
  await screen.findByRole('heading', { name: 'Canvas 50' });
  fireEvent.click(screen.getByRole('button', { name: '收起' }));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(titles()).toEqual(['Canvas 0', 'Canvas 1', 'Canvas 2', 'Canvas 3']);
  expect(requests.map(url => url.searchParams.get('cursor'))).toEqual([null, '50', null]);
});

it('reloads a list restored from the back/forward cache', async () => {
  let name = 'Before leaving';
  const fetcher = vi.fn(async () => json({ items: [{ ...record(0), name }], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4}/>));
  await screen.findByRole('heading', { name: 'Before leaving' });
  name = 'Renamed elsewhere';
  act(() => { window.dispatchEvent(new Event('pageshow')); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const restored = new Event('pageshow'); Object.defineProperty(restored, 'persisted', { value: true });
  act(() => { window.dispatchEvent(restored); });
  await screen.findByRole('heading', { name: 'Renamed elsewhere' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('offers workspace creation even to a user without memberships and cancels without a request', async () => {
  const fetcher = vi.fn(async (url: string) => json(url.endsWith('/appearance') ? appearanceFixture : { user: { id: 'u', name: 'User', email: 'u@example.test', platformRole: 'user' }, tenants: [] })); vi.stubGlobal('fetch', fetcher);
  render(<SaaSApp/>);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  fireEvent.click(screen.getByRole('button', { name: '新建工作区' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fetcher.mock.calls.filter(call => !['/appearance', '/auth/preferences'].some(path => String(call[0]).endsWith(path)))).toHaveLength(1);
});

it('preserves workspace input on failure, then creates the independent workspace', async () => {
  let fail = true; const writes: any[] = []; const onCreated = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { writes.push({ url, body: JSON.parse(init.body as string) }); return fail ? json({ error: { message: 'Unavailable' } }, 503) : json({ ...tenant, id: 'new-tenant' }, 201); }));
  render(wrap(<CreateWorkspaceDialog onClose={vi.fn()} onCreated={onCreated}/>));
  fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: '  New workspace  ' } });
  fireEvent.click(screen.getByRole('button', { name: '创建工作区' })); await screen.findByRole('alert');
  expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('  New workspace  ');
  fail = false; fireEvent.click(screen.getByRole('button', { name: '创建工作区' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-tenant'));
  expect(writes[1]).toEqual({ url: '/api/v1/tenants', body: { name: 'New workspace' } });
});

it('preserves a newer operation journal created while background graph discovery is pending', async () => {
  const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief' };
  const document = { ...emptyDocument(), nodes: [form] };
  const cloud = { ...record(0), document };
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'alice@example.test', platformRole: 'user' }, tenants: [tenant] };
  const snapshot = (operationId: string): GraphRunSnapshot => ({ id: `graph-${operationId}`, operationId,
    canvasId: cloud.id, documentVersion: cloud.version, document, scope: [form.id], status: 'running',
    createdAt: '2026-09-08T00:00:00Z', nodes: [{ nodeId: form.id, state: 'waiting' }] });
  let resolveDiscovery!: (response: Response) => void;
  let discoveryStarted = false;
  const writes: string[] = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== 'GET') writes.push(init.method);
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return json({ available: false, configured: false, models: [] });
    if (url.endsWith('/graph-runs')) {
      if (!discoveryStarted) { discoveryStarted = true; return new Promise<Response>(resolve => { resolveDiscovery = resolve; }); }
      return json({ items: [snapshot('new-operation')] });
    }
    if (url.endsWith('/graph-runs/graph-new-operation')) return json(snapshot('new-operation'));
    if (url.endsWith('/graph-runs/graph-old-operation')) return json(snapshot('old-operation'));
    return json(cloud);
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=${cloud.id}`);
  render(<SaaSApp />);
  await waitFor(() => expect(discoveryStarted).toBe(true));
  const storage = canvasStorage();
  expect(loadRunJournal(storage)).toBeNull();
  // Another page admits a new operation after this page's initial journal read, while
  // its older graph-list response remains in flight. Use the actual scoped journal store.
  const newer: CanvasRunJournal = { version: 1, id: 'new-operation', startedAt: Date.now(), scope: [form.id],
    inputFingerprint: runInputFingerprint(document, [form.id]),
    serverGraph: { tenantId: tenant.id, canvasId: cloud.id, id: 'graph-new-operation', documentVersion: cloud.version },
    nodes: { [form.id]: { nodeId: form.id, threadId: 'form', companyId: tenant.id, agentId: null, issueId: null, runId: null, state: 'waiting' } },
  };
  expect(saveRunJournal(newer, storage)).toBe(true);
  await act(async () => resolveDiscovery(json({ items: [snapshot('old-operation')] })));
  await screen.findByTestId('canvas-tile-brief');
  expect(loadRunJournal(storage)?.id).toBe('new-operation');
  expect(loadRunJournal(storage)?.serverGraph).toEqual(newer.serverGraph);
  expect(writes).toEqual([]);
});

// A workspace restricted away from every model still has a healthy runtime
// service, so the canvas must not look ready to execute just because the service
// is up. The note is keyed on the server's reason, not on service availability.
it.each([
  { name: 'a workspace entitled to no model', runtime: { available: true, configured: true, plannerAvailable: false, models: [], reason: 'No model is available to this workspace' }, note: 'No model is available to this workspace. Ask an administrator to grant one.' },
  { name: 'a workspace with an entitled model', runtime: { available: true, configured: true, plannerAvailable: true, models: [{ id: 'granted-model' }] }, note: null },
])('states that execution is not ready for $name', async ({ runtime, note }) => {
  localStorage.setItem('superclaw_locale', 'en');
  const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief' };
  const cloud = { ...record(0), document: { ...emptyDocument(), nodes: [form] } };
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'alice@example.test', platformRole: 'user' }, tenants: [tenant] };
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return json(runtime);
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    return json(cloud);
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=${cloud.id}`);
  render(<SaaSApp />);
  await screen.findByTestId('canvas-tile-brief');
  if (note) await waitFor(() => {
    expect(document.querySelector('.saas-runtime-note')).toBeVisible();
    expect(document.querySelector('.saas-runtime-note')).toHaveTextContent(note);
  });
  else expect(screen.queryByText(/Pi execution is not ready/)).toBeNull();
});

it('links a personal-mode canvas runtime warning to engine settings without claiming a missing key', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  const cloud = { ...record(0), document: emptyDocument() };
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'alice@example.test', platformRole: 'user' },
    tenants: [tenant], personalCredentialsRequired: true };
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/auth/connections')) return json({ items: [{ id: 'saved-engine', name: 'Work', provider: 'llmgate', runtime: 'openai-agents', models: ['test-model'], hasKey: true }],
      providers: [{ id: 'llmgate', name: 'LLM Gate · ClawHunt', runtimes: ['openai-agents', 'pi'] }], required: true, purchaseURL: 'https://api.clawhunt.site/' });
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/runtime')) return json({ available: false, configured: true, plannerAvailable: false,
      models: [], reason: 'No configured runtime is available', runtimes: [
        { id: 'pi', name: 'Pi', available: false, configured: true, supportsEffortSelection: false, tools: [], reason: 'Runtime is unavailable' },
        { id: 'openai-agents', name: 'OpenAI Agents', available: false, configured: true, supportsEffortSelection: false, tools: [], reason: 'Runtime is unavailable' },
      ] });
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    return json(cloud);
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=${cloud.id}`);
  const view = render(<SaaSApp />);
  await waitFor(() => expect(view.container.querySelector('.saas-runtime-note')).not.toBeNull());
  const note = view.container.querySelector('.saas-runtime-note');
  expect(note).not.toBeNull();
  expect(note).toHaveTextContent('Execution is not ready');
  expect(note).not.toHaveTextContent('Pi execution');
  expect(note).not.toHaveTextContent('Add an API key');
  expect(within(note as HTMLElement).getByRole('link', { name: 'My engines' })).toHaveAttribute('href', `/?tenant=${tenant.id}&canvas=${cloud.id}&account=engines`);
});

// Opening a canvas in a browser with no run journal rebuilds its latest run from the server. As production records
// a failed run: the failed step shows the partial delivery the running browser stamped, and the server sends the
// blocked step after it with an output of "".
describe('opening a canvas after its latest run', () => {
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'alice@example.test', platformRole: 'user' }, tenants: [tenant] };
  const step = (id: string, x: number, lastOutput?: NodeOutput) => ({
    ...createSessionNode('llm', { x, y: 0 }), id, title: `Step ${id}`, runtime: 'openai', model: 'qwen',
    binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id }, ...(lastOutput ? { lastOutput } : {}),
  });
  const browserStamp = Date.parse('2026-10-03T08:30:15.360Z');
  const serverStart = '2026-10-03T08:30:15.878Z';
  type Run = Omit<GraphRunSnapshot, 'id' | 'operationId' | 'canvasId' | 'documentVersion' | 'document' | 'scope'>;
  /** Opens the canvas as a browser with no run journal would. `submitted` is the document the run was given. */
  function open(document: CanvasDocument, run: Run | null, submitted: CanvasDocument = document) {
    const cloud = { ...record(0), document };
    const latest: GraphRunSnapshot | null = run && { id: 'graph-latest', operationId: 'operation-latest', canvasId: cloud.id, documentVersion: cloud.version, document: submitted, scope: ['a', 'b'], ...run };
    const reads: string[] = []; const writes: string[] = []; const saved: CanvasDocument[] = []; const journalWrites: string[] = [];
    // The test storage defines setItem on the instance, so a Storage.prototype spy would see nothing.
    const setItem = localStorage.setItem;
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes(CANVAS_RUN_JOURNAL_KEY)) journalWrites.push(key);
      return setItem.call(localStorage, key, value);
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method && init.method !== 'GET') {
        writes.push(init.method);
        if (init.method === 'PUT') {
          const body = JSON.parse(String(init.body)).document as CanvasDocument; saved.push(body);
          return json({ ...cloud, version: cloud.version + 1, document: body });
        }
      } else reads.push(url);
      if (url.endsWith('/appearance')) return json(appearanceFixture);
      if (url.endsWith('/auth/me')) return json(identity);
      if (url.endsWith('/runtime')) return json({ available: false, configured: false, models: [] });
      if (url.endsWith('/graph-runs')) return json({ items: latest ? [latest] : [] });
      if (url.endsWith('/graph-runs/graph-latest')) return json(latest);
      return json(cloud);
    }));
    window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=${cloud.id}`);
    render(<SaaSApp />);
    const shown = () => JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY) || '{}').nodes as CanvasDocument['nodes'];
    const discovered = () => reads.some(url => url.endsWith('/graph-runs'));
    return { writes, saved, journalWrites, shown, discovered, restore: () => spy.mockRestore() };
  }
  // Past the run read and the 450 ms autosave a recovery would cause.
  const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 1500)));

  it('opens on a screen its saved camera does not fit without saving the refit, and saves the operator’s own camera', async () => {
    // A 1200×800 stage: the saved camera leaves the node past the right edge, so the canvas refits as it opens.
    const stage = { w: 1200, h: 800 };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      ({ x: 0, y: 0, left: 0, top: 0, right: stage.w, bottom: stage.h, width: stage.w, height: stage.h, toJSON() {} }) as DOMRect);
    const offStage = { x: -235, y: 71, scale: 0.75 };
    const document = sanitizeDocument({ ...emptyDocument(), view: offStage, nodes: [{ ...step('a', 2000), y: 1500 }] });
    const view = open(document, null);
    try {
      await screen.findByTestId('canvas-tile-a');
      const world = window.document.querySelector('.canvas-world') as HTMLElement;
      await waitFor(() => expect(world.style.transform).not.toBe('translate(-235px, 71px) scale(0.75)'));
      // A camera change is saved 400 ms later and sent 450 ms after that; on a busy runner it lands later still.
      const quiet = () => act(() => new Promise(resolve => setTimeout(resolve, 3000)));
      const camera = () => world.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/)!.slice(1).map(Number);
      await quiet();
      expect(view.writes).toEqual([]);
      // A rail collapses and the stage widens: the app refits its own camera, and that is not saved either.
      const fitted = world.style.transform;
      stage.w = 1500;
      fireEvent.click(screen.getByRole('button', { name: '收起 Bot 清单' }));
      await waitFor(() => expect(world.style.transform).not.toBe(fitted));
      await quiet();
      expect(view.writes).toEqual([]);
      // The operator's zoom is saved, and the one save carries exactly that camera.
      fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
      const zoomed = camera();
      await waitFor(() => expect(view.saved).toHaveLength(1), { timeout: 5000 });
      const saved = view.saved[0].view!;
      expect([saved.x, saved.y, saved.scale]).toEqual(zoomed);
      // And only that one.
      await quiet();
      expect(view.writes).toEqual(['PUT']);
    } finally { view.restore(); rect.mockRestore(); }
  }, 30000);

  it('does not recover a failed run it already shows again, so the canvas is neither re-stamped nor saved', async () => {
    const document = sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 },
      nodes: [step('a', 0, { text: 'Partial page', at: browserStamp, source: 'run', partial: true }), step('b', 500)] });
    const view = open(document, { status: 'failed', createdAt: serverStart, updatedAt: '2026-10-03T08:31:47Z',
      nodes: [{ nodeId: 'a', state: 'failed', output: 'Partial page', partial: true }, { nodeId: 'b', state: 'blocked', output: '', detail: 'Upstream did not complete' }] });
    try {
      await screen.findByTestId('canvas-tile-a');
      await settle();
      expect(view.discovered()).toBe(true);
      expect(view.journalWrites).toEqual([]);
      expect(view.writes).toEqual([]);
      expect(screen.queryByText('已从后台恢复运行结果。')).toBeNull();
      expect(view.shown()[0].lastOutput).toEqual({ text: 'Partial page', at: browserStamp, source: 'run', partial: true });
    } finally { view.restore(); }
  });

  it.each([false, true])('preserves a follow-up while discovering its superseded graph (missing sibling: %s)', async missing => {
    const revised = { text: 'Revised budget: 240 yuan, exactly three notes', at: 1, source: 'run' as const, supersedesThroughGraphVersion: 12, supersedesGraphCanvasId: 'canvas-0' };
    const document = sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 },
      nodes: [step('a', 0, missing ? undefined : { text: 'Draft', at: browserStamp, source: 'run' }), step('b', 500, revised)] });
    const view = open(document, { status: 'completed', createdAt: serverStart, updatedAt: '2026-10-03T08:31:47Z',
      nodes: [{ nodeId: 'a', state: 'done', output: 'Draft' }, { nodeId: 'b', state: 'done', output: 'Old budget: 300 yuan, five notes' }] });
    try {
      await screen.findByTestId('canvas-tile-a'); await settle();
      expect(view.discovered()).toBe(true);
      expect(view.shown()[1].lastOutput).toEqual(revised);
      if (missing) expect(view.shown()[0].lastOutput?.text).toBe('Draft');
      else { expect(view.journalWrites).toEqual([]); expect(view.writes).toEqual([]); }
    } finally { view.restore(); }
  });

  it('still recovers a result the canvas does not show yet, saves it once, and then opens quietly', async () => {
    const document = sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [step('a', 0), step('b', 500)] });
    const run: Run = { status: 'completed', createdAt: serverStart, updatedAt: '2026-10-03T08:31:47Z',
      nodes: [{ nodeId: 'a', state: 'done', output: 'Delivered page' }, { nodeId: 'b', state: 'done', output: 'Checked' }] };
    const first = open(document, run);
    let saved: CanvasDocument;
    try {
      await screen.findByText('已从后台恢复运行结果。');
      expect(first.journalWrites.length).toBeGreaterThan(0);
      await waitFor(() => expect(first.saved).toHaveLength(1));
      await settle();
      expect(first.writes).toEqual(['PUT']);
      saved = first.saved[0];
      expect(saved.nodes.map(node => node.lastOutput?.text)).toEqual(['Delivered page', 'Checked']);
      expect(saved.nodes[0].lastOutput?.at).toBe(Date.parse(serverStart));
    } finally { first.restore(); }
    // Another browser opens the saved canvas: nothing is left to recover.
    cleanup(); localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
    const second = open(sanitizeDocument(saved!), run, document);
    try {
      await screen.findByTestId('canvas-tile-a');
      await settle();
      expect(second.discovered()).toBe(true);
      expect(second.journalWrites).toEqual([]);
      expect(second.writes).toEqual([]);
      expect(screen.queryByText('已从后台恢复运行结果。')).toBeNull();
    } finally { second.restore(); }
  });
});
