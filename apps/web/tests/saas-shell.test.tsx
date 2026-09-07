import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, saveDocument } from '../src/canvas/canvasDoc';
import { configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';

const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: '真实工作区', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); });

it('shows login on a missing server session without reading legacy identity tokens', async () => {
  localStorage.setItem('clawhunt_token', 'not-a-saas-session');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401)));
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeVisible();
  expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
});

it('rejects the admin surface for an ordinary user before loading administrative records', async () => {
  window.history.replaceState({}, '', '/admin');
  const fetch = vi.fn().mockResolvedValue(response(identity)); vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '无平台管理权限' })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps platform administration and logout reachable for a bootstrap administrator with no tenant', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...identity, user: { ...identity.user, platformRole: 'admin' }, tenants: [] })));
  render(<SaaSApp />);
  expect(await screen.findByRole('link', { name: '进入平台管理' })).toHaveAttribute('href', '/admin');
  expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
});

it('keeps tenant switching and logout available on a suspended tenant and does not fetch its canvases', async () => {
  window.history.replaceState({}, '', '/?tenant=tenant-a');
  const fetch = vi.fn().mockResolvedValue(response({ ...identity, tenants: [{ ...identity.tenants[0], status: 'suspended' }, { ...identity.tenants[0], id: 'tenant-b', name: '另一工作区' }] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '工作区已暂停' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: '切换工作区' })).toHaveValue('tenant-a');
  expect(screen.getByRole('option', { name: '另一工作区' })).toHaveValue('tenant-b');
  expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('gives readers a cloud-backed browse and export view without mounting the writer or touching local drafts', async () => {
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  localStorage.setItem(CANVAS_STORAGE_KEY, 'private local draft');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response({ ...identity, tenants: [{ ...identity.tenants[0], role: 'reader' }] });
    if (url.includes('/messages')) return response({ items: [{ id: 'msg-1', role: 'assistant', content: '真实云端会话' }] });
    if (url.includes('/sessions?')) return response({ items: [{ id: 'session-a', nodeId: 'node-a', title: '测试会话' }] });
    return response({ id: 'canvas-a', name: '只读画布', document: { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '云端节点' }] }, version: 2 });
  }));
  render(<SaaSApp />);
  expect(await screen.findByText('真实云端会话')).toBeVisible();
  expect(screen.getByRole('button', { name: '导出画布 JSON' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('只读视图');
  expect(screen.queryByRole('button', { name: '新建画布' })).toBeNull();
  expect(document.querySelector('.awwo-workspace')).toBeNull();
  expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe('private local draft');
  expect(calls.every(call => !call.init.method || call.init.method === 'GET')).toBe(true);
});

it('lets an owner add a registered member, change the role and remove by userId while protecting the owner', async () => {
  let members = [{ id: 'membership-owner', userId: 'user-a', name: 'Alice', email: 'a@example.test', role: 'owner' }];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/canvases')) return response({ items: [] });
    if (init.method === 'POST') { members = [...members, { id: 'membership-b', userId: 'user-b', name: 'Bob', email: 'b@example.test', role: 'member' }]; return response(members[1], 201); }
    if (init.method === 'PATCH') { members = members.map(item => item.userId === 'user-b' ? { ...item, role: 'reader' } : item); return new Response(null, { status: 204 }); }
    if (init.method === 'DELETE') { members = members.filter(item => item.userId !== 'user-b'); return new Response(null, { status: 204 }); }
    return response({ items: members });
  }));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '工作区成员' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(await dialog.findByText('a@example.test')).toBeVisible();
  expect(dialog.queryByRole('button', { name: '移除a@example.test' })).toBeNull();
  fireEvent.change(dialog.getByRole('textbox', { name: '成员邮箱' }), { target: { value: 'b@example.test' } });
  fireEvent.click(dialog.getByRole('button', { name: '添加成员' }));
  expect(await dialog.findByText('b@example.test')).toBeVisible();
  expect(JSON.parse(calls.find(call => call.init.method === 'POST')!.init.body as string)).toEqual({ email: 'b@example.test', role: 'member' });
  fireEvent.change(dialog.getByRole('combobox', { name: 'b@example.test的角色' }), { target: { value: 'reader' } });
  await waitFor(() => expect(dialog.getByRole('combobox', { name: 'b@example.test的角色' })).toHaveValue('reader'));
  expect(calls.find(call => call.init.method === 'PATCH')?.url).toBe('/api/v1/tenants/tenant-a/members/user-b');
  fireEvent.click(dialog.getByRole('button', { name: '移除b@example.test' }));
  await waitFor(() => expect(dialog.queryByText('b@example.test')).toBeNull());
  expect(calls.find(call => call.init.method === 'DELETE')?.url).toBe('/api/v1/tenants/tenant-a/members/user-b');
});

it('never mounts or saves an empty canvas when cloud hydration fails', async () => {
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/runtime') ? response({ available: false, models: [] }) : response({ error: { message: 'Cloud unavailable' } }, 503));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cloud unavailable');
  expect(fetch.mock.calls.some((call: any[]) => call[1]?.method === 'PUT')).toBe(false);
  expect(document.querySelector('.awwo-workspace')).toBeNull();
});

it('hydrates the real canvas and stops cloud writes on a version conflict', async () => {
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), title: 'Legacy private content' }] }));
  const serverDocument = { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), title: '云端真实节点' }] };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, configured: false, models: [] });
    if (init.method === 'PUT') return response({ error: { code: 'conflict', message: 'Changed elsewhere' } }, 409);
    return response({ id: 'canvas-a', tenantId: 'tenant-a', name: '团队画布', document: serverDocument, version: 7, createdAt: '', updatedAt: '' });
  }));
  render(<SaaSApp />);
  await waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull());
  expect(screen.queryByText('Legacy private content')).toBeNull();
  expect(screen.getAllByText('云端真实节点').length).toBeGreaterThan(0);
  act(() => { saveDocument({ ...serverDocument, updatedAt: Date.now() }); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画布已在另一页面更新'));
  const writes = calls.filter(call => call.init.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0].init.body as string).version).toBe(7);
  act(() => { saveDocument({ ...serverDocument, updatedAt: Date.now() + 1 }); });
  await act(() => new Promise(resolve => setTimeout(resolve, 550)));
  expect(calls.filter(call => call.init.method === 'PUT')).toHaveLength(1);
});
