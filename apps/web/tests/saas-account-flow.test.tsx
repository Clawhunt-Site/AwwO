import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { clearSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

const owner = { user: { id: 'alice', name: 'Alice', email: 'alice@example.test', platformRole: 'user' }, tenants: [{ id: 'team-a', name: 'Team A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const members = [{ userId: 'alice', name: 'Alice', email: 'alice@example.test', role: 'owner' }, { userId: 'bob', name: 'Bob', email: 'bob@example.test', role: 'admin' }];
const response = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('uses the original account panel and PATCHes only the current SaaS profile name', async () => {
  let name = 'Alice'; const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response({ ...owner, user: { ...owner.user, name } });
    if (url.endsWith('/auth/profile')) { name = JSON.parse(init.body as string).name; return response({ id: 'alice', name, email: owner.user.email, isPlatformAdmin: false }); }
    if (new URL(url, 'http://localhost').pathname.endsWith('/members')) return response({ items: members });
    return response({ items: [] });
  }));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  const panel = within(screen.getByRole('dialog'));
  expect(await panel.findByRole('heading', { name: '工作区资料' })).toBeVisible();
  expect(document.querySelector('.account-workspace-panel')).not.toBeNull();
  expect(panel.queryByText('ClawHunt 账户')).toBeNull();
  fireEvent.change(panel.getByRole('textbox', { name: '显示名称' }), { target: { value: 'Alice Updated' } });
  fireEvent.click(panel.getByRole('button', { name: '保存资料' }));
  expect(await panel.findByText('已保存')).toBeVisible();
  expect(screen.getByRole('button', { name: '账号与工作区' })).toHaveTextContent('Alice Updated');
  expect(calls.filter(call => call.init.method === 'PATCH').map(call => JSON.parse(call.init.body as string))).toEqual([{ name: 'Alice Updated' }]);
  expect(calls.every(call => call.url.startsWith('/api/v1/'))).toBe(true);
  expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).some(key => /token|session/.test(key || ''))).toBe(false);
});

it('does not show profile success when the backend rejects a save', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/appearance') ? response(appearanceFixture) : url.endsWith('/auth/me') ? response(owner) : url.endsWith('/auth/profile') ? response({ error: { code: 'invalid_input', message: 'Invalid name' } }, 400) : response({ items: new URL(url, 'http://localhost').pathname.endsWith('/members') ? members : [] })));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  fireEvent.click(await screen.findByRole('button', { name: '保存资料' }));
  expect(await screen.findByText('输入无效，请检查后重试。')).toBeVisible();
  expect(screen.queryByText('已保存')).toBeNull();
});

it('limits an admin to member and reader roles and protects owner/admin members', async () => {
  const admin = { ...owner, tenants: [{ ...owner.tenants[0], role: 'admin' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/appearance') ? response(appearanceFixture) : url.endsWith('/auth/me') ? response(admin) : response({ items: new URL(url, 'http://localhost').pathname.endsWith('/members') ? [...members, { userId: 'c', name: 'Chris', email: 'c@example.test', role: 'member' }] : [] })));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  const roles = await screen.findByRole('combobox', { name: 'Chris 的角色' });
  expect(within(roles).getAllByRole('option').map(item => item.getAttribute('value'))).toEqual(['reader', 'member']);
  expect(screen.queryByRole('combobox', { name: 'Alice 的角色' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Bob 的角色' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Chris 的状态' })).toBeNull();
  expect(within(screen.getByRole('combobox', { name: '邀请角色' })).queryByRole('option', { name: '管理员' })).toBeNull();
});

it('creates, copies and revokes an invitation without storing its token or sending email', async () => {
  const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let created = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response(owner);
    if (new URL(url, 'http://localhost').pathname.endsWith('/members')) return response({ items: members });
    if (init.method === 'POST') { created = true; return response({ id: 'invite-a', role: 'member', token: 'fixture-invite-token', inviteUrl: 'http://localhost/?invite=fixture-invite-token', expiresAt: '2099-01-01T00:00:00Z' }, 201); }
    if (init.method === 'DELETE') { created = false; return response(null, 204); }
    if (new URL(url, 'http://localhost').pathname.endsWith('/invites')) return response({ items: created ? [{ id: 'invite-a', role: 'member', status: 'active', expiresAt: '2099-01-01T00:00:00Z' }] : [], nextCursor: null });
    return response({ items: [] });
  }));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '创建邀请链接' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '创建邀请链接' }));
  fireEvent.click(await screen.findByRole('button', { name: '复制邀请链接' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('http://localhost/?invite=fixture-invite-token'));
  expect(JSON.parse(calls.find(call => call.init.method === 'POST')!.init.body as string)).toEqual({ role: 'member' });
  fireEvent.click(screen.getByRole('button', { name: '撤销邀请' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '复制邀请链接' })).toBeNull());
  expect(calls.find(call => call.init.method === 'DELETE')?.url).toBe('/api/v1/tenants/team-a/invites/invite-a');
  expect(JSON.stringify(localStorage)).not.toContain('fixture-invite-token');
});

it('preserves an invitation through login and joins only after explicit confirmation', async () => {
  window.history.replaceState({}, '', '/?invite=fixture-token'); let authenticated = false;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return authenticated ? response(owner) : response({ error: { code: 'unauthenticated' } }, 401);
    if (url.endsWith('/auth/login')) { authenticated = true; return response(owner); }
    if (url.endsWith('/accept')) return response({ tenantId: 'invited-team', role: 'member' });
    return response({ tenantId: 'invited-team', tenantName: 'Invited Team', role: 'member', status: 'active', expiresAt: '2099-01-01T00:00:00Z' });
  }));
  render(<SaaSApp />);
  fireEvent.change(await screen.findByRole('textbox', { name: '邮箱' }), { target: { value: owner.user.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('heading', { name: 'Invited Team' })).toBeVisible();
  expect(calls.filter(call => call.url.endsWith('/accept'))).toHaveLength(0);
  expect(window.location.search).toBe('?invite=fixture-token');
  fireEvent.click(screen.getByRole('button', { name: '确认加入' }));
  expect(await screen.findByRole('link', { name: '打开工作区' })).toHaveAttribute('href', '/?tenant=invited-team');
  expect(calls.filter(call => call.url.endsWith('/accept'))).toHaveLength(1);
});

it.each(['expired', 'revoked', 'suspended', 'unavailable'])('blocks confirmation for a %s invitation', async status => {
  window.history.replaceState({}, '', '/?invite=fixture-token');
  const fetch = vi.fn(async (url: string) => url.endsWith('/appearance') ? response(appearanceFixture) : url.endsWith('/auth/me') ? response(owner) : response({ tenantId: 'team-a', tenantName: 'Team A', role: 'admin', status, expiresAt: '2000-01-01T00:00:00Z' })); vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('button', { name: '确认加入' })).toBeDisabled();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/accept'))).toBe(false);
});

it('keeps an invitation across registration and does not consume it when creating an account', async () => {
  window.history.replaceState({}, '', '/?invite=registration-invite');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    calls.push({ url, init });
    if (url.endsWith('/auth/me')) return response({ error: { code: 'unauthenticated' } }, 401);
    if (url.endsWith('/auth/register')) return response(owner, 201);
    return response({ tenantId: 'invited-team', tenantName: 'Registration Team', role: 'reader', status: 'active', expiresAt: '2099-01-01T00:00:00Z' });
  }));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '创建账号和工作区' }));
  fireEvent.change(screen.getByRole('textbox', { name: '姓名' }), { target: { value: 'New Member' } });
  fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: 'Personal Workspace' } });
  fireEvent.change(screen.getByRole('textbox', { name: '邮箱' }), { target: { value: 'new@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '注册并创建工作区' }));
  expect(await screen.findByRole('heading', { name: 'Registration Team' })).toBeVisible();
  expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  expect(calls.some(call => call.url.endsWith('/accept'))).toBe(false);
  expect(window.location.search).toBe('?invite=registration-invite');
});

it('shows a consumed-invite conflict and never claims that membership was created', async () => {
  window.history.replaceState({}, '', '/?invite=used-invite');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(owner);
    if (url.endsWith('/accept')) return response({ error: { code: 'invite_used', message: 'Already used' } }, 409);
    return response({ tenantId: 'team-a', tenantName: 'Team A', role: 'admin', status: 'accepted', expiresAt: '2099-01-01T00:00:00Z' });
  }));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '确认加入' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('此邀请已被其他账号领取。');
  expect(screen.queryByRole('heading', { name: '已加入工作区' })).toBeNull();
  expect(screen.queryByRole('link', { name: '打开工作区' })).toBeNull();
});

it('uses the server-returned membership role instead of elevating to the invitation role', async () => {
  window.history.replaceState({}, '', '/?invite=admin-invite');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/appearance') ? response(appearanceFixture) : url.endsWith('/auth/me') ? response(owner)
    : url.endsWith('/accept') ? response({ tenantId: 'team-a', role: 'reader' })
    : response({ tenantId: 'team-a', tenantName: 'Team A', role: 'admin', status: 'active', expiresAt: '2099-01-01T00:00:00Z' })));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '确认加入' }));
  expect(await screen.findByRole('status')).toHaveTextContent('你的当前角色：只读成员');
});

it('translates the original account panel when changing the SaaS language', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/appearance') ? response(appearanceFixture) : url.endsWith('/auth/me') ? response(owner) : response({ items: new URL(url, 'http://localhost').pathname.endsWith('/members') ? members : [] })));
  render(<SaaSApp />); fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  expect(await screen.findByRole('heading', { name: '工作区资料' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '切换为英文' }));
  expect(screen.getByRole('heading', { name: 'Workspace profile' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Alice');
  expect(screen.queryByText('ClawHunt account')).toBeNull();
});

it('reuses the existing language/theme keys and keeps the choice on a fresh mount', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'unauthenticated' } }, 401)));
  const first = render(<SaaSApp />); expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '切换为英文' }));
  expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Use dark theme' }));
  expect(document.documentElement.dataset.theme).toBe('dark'); expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem('superclaw_theme')).toBe('dark'); expect(localStorage.getItem('superclaw_locale')).toBe('en');
  first.unmount(); render(<SaaSApp />); expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Use light theme' })).toBeVisible();
});
