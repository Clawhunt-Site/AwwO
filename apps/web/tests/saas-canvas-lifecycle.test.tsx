import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { CreateWorkspaceDialog, SaaSApp } from '../src/saas/SaaSApp';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { createFormNode, emptyDocument } from '../src/canvas/canvasDoc';
import { canvasStorage } from '../src/canvas/canvasStorage';
import { loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
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
  fireEvent.click(screen.getByRole('button', { name: /↗ Canvas 200/ })); expect(onOpen).toHaveBeenCalledWith('canvas-200');
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
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(fetcher.mock.calls[1][0]).toBe('/api/v1/tenants/tenant-b/canvases?limit=50');
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
  expect(urls.at(-1)).toBe('/api/v1/tenants/tenant-a/canvases?limit=50');
});

it('does not write when renaming is cancelled, including before the initial read completes', async () => {
  let resolveRead!: (response: Response) => void; const methods: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    methods.push(init.method || 'GET');
    if (input.includes('?')) return json({ items: [record(0)], nextCursor: null });
    return new Promise<Response>(resolve => { resolveRead = resolve; });
  }));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  fireEvent.click(await screen.findByRole('button', { name: '改名：Canvas 0' }));
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
  fireEvent.click(await screen.findByRole('button', { name: '改名：Canvas 0' }));
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
  fireEvent.click(await screen.findByRole('button', { name: '删除：Canvas 0' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('全部会话和运行历史');
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(writes).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '删除：Canvas 0' }));
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

it('creates with a default name when the input is left empty', async () => {
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { writes.push(JSON.parse(init.body as string)); return json({ ...record(0), name: '未命名' }, 201); }
    return json({ items: [], nextCursor: null });
  }));
  const onOpen = vi.fn();
  render(wrap(<CanvasList tenant={tenant} onOpen={onOpen}/>));
  const button = await screen.findByRole('button', { name: '新建画布' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].name).toBe('未命名');
  expect(onOpen).toHaveBeenCalledWith('canvas-0');
});

it('keeps a new canvas name when creation fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => init.method === 'POST' ? json({ error: { message: 'network save failed' } }, 503) : json({ items: [], nextCursor: null })));
  render(wrap(<CanvasList tenant={tenant} onOpen={vi.fn()}/>));
  fireEvent.change(screen.getByRole('textbox', { name: '新画布名称' }), { target: { value: 'keep this name' } });
  fireEvent.click(screen.getByRole('button', { name: '新建画布' }));
  await screen.findByRole('alert'); expect(screen.getByRole('textbox', { name: '新画布名称' })).toHaveValue('keep this name');
});

it('offers workspace creation even to a user without memberships and cancels without a request', async () => {
  const fetcher = vi.fn(async (url: string) => json(url.endsWith('/appearance') ? appearanceFixture : { user: { id: 'u', name: 'User', email: 'u@example.test', platformRole: 'user' }, tenants: [] })); vi.stubGlobal('fetch', fetcher);
  render(<SaaSApp/>);
  fireEvent.click(await screen.findByRole('button', { name: '新建工作区' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fetcher.mock.calls.filter(call => !String(call[0]).endsWith('/appearance'))).toHaveLength(1);
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
    serverGraph: { tenantId: tenant.id, canvasId: cloud.id, id: 'graph-new-operation' },
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
  if (note) expect(await screen.findByText(new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { selector: '.saas-runtime-note' })).toBeVisible();
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
