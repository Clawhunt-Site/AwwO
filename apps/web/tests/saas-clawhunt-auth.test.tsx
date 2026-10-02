import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { clearSSOReturnURL, clawHuntStartURL, readSSOReturn, trustedAwwORedirectURL, trustedClawHuntLogoutURL } from '../src/saas/clawhuntAuth';
import { appearanceFixture } from './saas-appearance-fixture';
import { PENDING_INVITE_KEY } from '../src/saas/pendingInvite';

const identity = { user: { id: 'legacy-user', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.example/' };
const invite = 'fixture_invite_token_0123456789abcdef';
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const unauthorized = () => response({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401);
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); });

it('offers only ClawHunt SSO when local auth is disabled and carries a bounded invite', async () => {
  history.replaceState(null, '', `/?invite=${invite}`);
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('link', { name: '使用 ClawHunt 账号继续' })).toHaveAttribute('href', `/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(screen.queryByLabelText('邮箱')).toBeNull();
  expect(screen.queryByLabelText('密码')).toBeNull();
  expect(screen.queryByRole('button', { name: '创建账号和工作区' })).toBeNull();
  expect(fetch.mock.calls.every(([url]) => !url.endsWith('/auth/login') && !url.endsWith('/auth/register'))).toBe(true);
  expect(JSON.stringify(localStorage)).not.toContain('token');
});

it('does not expose local sign-in before auth options have been confirmed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ error: { code: 'unavailable' } }, 503)));
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '无法确认登录方式' })).toBeVisible();
  expect(screen.queryByLabelText('密码')).toBeNull();
  expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
});

it('fails closed when a successful auth options response omits both mode flags', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ passwordRecovery: true })));
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '登录暂不可用' })).toBeVisible();
  expect(screen.queryByLabelText('密码')).toBeNull();
  expect(screen.queryByRole('link', { name: '使用 ClawHunt 账号继续' })).toBeNull();
});

it('routes even a legacy AwwO reset link to the main-site account under unified auth', async () => {
  history.replaceState(null, '', '/?reset=synthetic-legacy-reset-token');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized()
    : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '到 ClawHunt 管理账号' })).toBeVisible();
  expect(screen.getByRole('link', { name: '打开 ClawHunt 账号管理' })).toHaveAttribute('href', 'https://clawhunt.example/account');
  expect(screen.queryByLabelText('新密码')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/reset-password'))).toBe(false);
  await waitFor(() => expect(location.search).toBe(''));
});

it('offers invite-code redemption in both languages on the waitlisted result, clears callback parameters and never signs in', async () => {
  history.replaceState(null, '', `/?sso=error&reason=waitlisted&invite=${invite}`);
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('alert')).toHaveTextContent('邀请码');
  expect(screen.getByRole('link', { name: '输入邀请码进入 AwwO' })).toHaveAttribute('href', 'https://clawhunt.example/awwo?from=signin');
  await waitFor(() => expect(location.search).toBe(`?invite=${invite}`));
  fireEvent.click(screen.getByRole('button', { name: '切换为英文' }));
  expect(screen.getByRole('alert')).toHaveTextContent('invite code');
  expect(screen.getByRole('link', { name: 'Enter your invite code' })).toHaveAttribute('href', 'https://clawhunt.example/awwo?from=signin');
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/login') || url.endsWith('/auth/register'))).toBe(false);
});

it('requires the original AwwO password before linking the verified ClawHunt subject', async () => {
  history.replaceState(null, '', '/?sso=link');
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return unauthorized();
    if (url.endsWith('/auth/clawhunt/pending')) return response({ email: 'ada@example.test', expiresAt: '2099-01-01T00:00:00Z' });
    if (url.endsWith('/auth/clawhunt/link')) return response({ ...identity, redirectURL: `/?invite=${invite}` });
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    return response({ tenantId: 'invited', tenantName: 'Invited', role: 'member', status: 'active', expiresAt: '2099-01-01T00:00:00Z' });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '验证原 AwwO 密码' })).toBeVisible();
  expect(screen.getByText('ada@example.test')).toBeVisible();
  expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  expect(location.search).toBe('');
  fireEvent.change(screen.getByLabelText('原 AwwO 密码'), { target: { value: 'synthetic-old-password' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并保留工作区' }));
  await waitFor(() => expect(location.search).toBe(`?invite=${invite}`));
  expect(await screen.findByText(/Invited/)).toBeVisible();
  const link = fetch.mock.calls.find(([url]) => url.endsWith('/auth/clawhunt/link'));
  expect(link?.[1]?.method).toBe('POST');
  expect(JSON.parse(String(link?.[1]?.body))).toEqual({ password: 'synthetic-old-password' });
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-old-password');
});

it('does not grant a workspace when the legacy password is wrong', async () => {
  history.replaceState(null, '', '/?sso=link');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : url.endsWith('/auth/clawhunt/pending')
    ? response({ email: 'ada@example.test', expiresAt: '2099-01-01T00:00:00Z' })
    : response({ error: { code: 'sso_link_failed', message: 'Account proof failed' } }, 401));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  fireEvent.change(await screen.findByLabelText('原 AwwO 密码'), { target: { value: 'synthetic-wrong-password' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并保留工作区' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('关联请求已用尽');
  expect(screen.queryByLabelText('原 AwwO 密码')).toBeNull();
  expect(screen.getByRole('link', { name: '从 ClawHunt 重新开始' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start');
  expect(screen.queryByRole('heading', { name: '选择工作区' })).toBeNull();
});

it.each(['old-identity', 'service-error'] as const)('keeps a completed account link when the initial session request returns a late %s', async (lateResult) => {
  history.replaceState(null, '', '/?sso=link');
  let finishSession!: (value: Response) => void;
  const pendingSession = new Promise<Response>(resolve => { finishSession = resolve; });
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return pendingSession;
    if (url.endsWith('/auth/clawhunt/pending')) return response({ email: identity.user.email, expiresAt: '2099-01-01T00:00:00Z' });
    if (url.endsWith('/auth/clawhunt/link')) return response(identity);
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    return response({ items: [] });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  fireEvent.change(await screen.findByLabelText('原 AwwO 密码'), { target: { value: 'synthetic-old-password' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '验证并保留工作区' })); });
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/clawhunt/link'))).toBe(true);
  await act(async () => {
    finishSession(lateResult === 'old-identity'
      ? response({ ...identity, user: { ...identity.user, id: 'previous-user', name: 'Previous account' } })
      : response({ error: { code: 'sso_unavailable', message: 'Previous request failed' } }, 503));
  });
  expect(await screen.findByRole('button', { name: '账号与工作区' })).toHaveTextContent('Ada');
  expect(screen.queryByText('Previous account')).toBeNull();
  expect(screen.queryByText('Previous request failed')).toBeNull();
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
});

it('rejects expired pending links without showing the old-account password form', async () => {
  history.replaceState(null, '', '/?sso=link');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : url.endsWith('/auth/clawhunt/pending')
    ? response({ error: { code: 'sso_expired' } }, 401) : response({ clawhuntSSO: true, localAuth: false })));
  render(<SaaSApp />);
  expect(await screen.findByRole('alert')).toHaveTextContent('登录请求已过期');
  expect(screen.queryByLabelText('原 AwwO 密码')).toBeNull();
});

it('shows unified identity and sends profile and password changes to the main-site account page', async () => {
  history.replaceState(null, '', '/?account=security');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/appearance')
    ? response(appearanceFixture) : response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '已关联 ClawHunt 账号' })).toBeVisible();
  expect(screen.getByRole('link', { name: '管理 ClawHunt 账号' })).toHaveAttribute('href', 'https://clawhunt.example/account');
  expect(screen.queryByLabelText('当前密码')).toBeNull();
  expect(screen.queryByRole('button', { name: '修改并重新登录' })).toBeNull();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/password'))).toBe(false);
});

it('keeps the AwwO workspace panel while making a linked profile read-only', async () => {
  const owner = { ...identity, tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }] };
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(owner) : url.endsWith('/appearance')
    ? response(appearanceFixture) : response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '账号与工作区' }));
  expect(await screen.findByRole('heading', { name: '工作区资料' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '显示名称' })).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: '保存资料' })).toBeNull();
  expect(screen.getByRole('link', { name: '到 ClawHunt 管理资料' })).toHaveAttribute('href', 'https://clawhunt.example/account');
  await waitFor(() => expect(screen.getByRole('button', { name: '创建邀请链接' })).toBeEnabled());
  expect(screen.queryByRole('textbox', { name: '成员邮箱' })).toBeNull();
  expect(screen.getByText('请创建邀请链接并分享给指定成员，对方使用 ClawHunt 账号确认后加入。')).toBeVisible();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/profile'))).toBe(false);
});

it('does not claim unified sign-out when the server fails to return the main-site logout route', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/appearance')
    ? response(appearanceFixture) : url.endsWith('/auth/logout') ? response(null, 204) : response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法确认 ClawHunt 主站退出');
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/auth/logout'))).toHaveLength(1);
});

const invitePreview = { tenantId: 'invited', tenantName: 'Invited', role: 'member', status: 'active', expiresAt: '2099-01-01T00:00:00Z' };

it('keeps a workspace invitation through the invite-code detour and offers it after the next sign-in', async () => {
  history.replaceState(null, '', `/?invite=${invite}`);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' })));
  render(<SaaSApp />);
  expect(await screen.findByRole('link', { name: '使用 ClawHunt 账号继续' })).toHaveAttribute('href', `/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(JSON.parse(sessionStorage.getItem(PENDING_INVITE_KEY) || 'null')).toMatchObject({ v: 1, token: invite });
  cleanup(); vi.unstubAllGlobals();

  // Redemption on ClawHunt returns through a fresh sign-in that lands on the plain root.
  history.replaceState(null, '', '/');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/appearance')
    ? response(appearanceFixture) : url.includes('/invites/') ? response(invitePreview) : response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByText(/Invited/)).toBeVisible();
  expect(location.search).toBe(`?invite=${invite}`);
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
  // Joining still takes the explicit confirmation.
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/accept'))).toBe(false);
});

it('never restores a stored invitation onto a failed sign-in', async () => {
  sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ v: 1, token: invite, savedAt: Date.now() }));
  history.replaceState(null, '', '/?sso=error&reason=expired');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('alert')).toHaveTextContent('登录请求已过期');
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(location.search).toBe('');
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull();
});

it('restores a stored invitation once an existing AwwO account has been linked', async () => {
  sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ v: 1, token: invite, savedAt: Date.now() }));
  history.replaceState(null, '', '/?sso=link');
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return unauthorized();
    if (url.endsWith('/auth/clawhunt/pending')) return response({ email: 'ada@example.test', expiresAt: '2099-01-01T00:00:00Z' });
    // The detour's fresh flow carried no invitation, so the server returns the plain root.
    if (url.endsWith('/auth/clawhunt/link')) return response({ ...identity, redirectURL: '/' });
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    return url.includes('/invites/') ? response(invitePreview) : response({ items: [] });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  // The link screen holds the stored invitation untouched until linking succeeds.
  expect(await screen.findByRole('heading', { name: '验证原 AwwO 密码' })).toBeVisible();
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull();
  fireEvent.change(screen.getByLabelText('原 AwwO 密码'), { target: { value: 'synthetic-old-password' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并保留工作区' }));
  expect(await screen.findByText(/Invited/)).toBeVisible();
  expect(location.search).toBe(`?invite=${invite}`);
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
});

it('keeps a stored invitation through a password-reset screen opened with a live session', async () => {
  sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ v: 1, token: invite, savedAt: Date.now() }));
  history.replaceState(null, '', '/?reset=synthetic-legacy-reset-token');
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity)
    : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.example/' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  expect(await screen.findByRole('heading', { name: '到 ClawHunt 管理账号' })).toBeVisible();
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(location.search).not.toContain('invite');
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull();
});

it('leaves a stored invitation alone on a chosen address and forgets it at sign-out', async () => {
  sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ v: 1, token: invite, savedAt: Date.now() }));
  history.replaceState(null, '', '/?tenant=team-a');
  const owner = { ...identity, tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(owner) : url.endsWith('/appearance')
    ? response(appearanceFixture) : url.endsWith('/auth/logout') ? response(null, 204) : response({ items: [] })));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(location.search).toBe('?tenant=team-a');
  expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  await waitFor(() => expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull());
});

it('accepts only bounded first-party invite redirects and the configured main-site logout route', () => {
  expect(readSSOReturn('?sso=error&reason=waitlisted')).toEqual({ kind: 'error', reason: 'waitlisted' });
  expect(clawHuntStartURL(`?invite=${invite}`)).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(clawHuntStartURL('?invite=https://evil.example/')).toBe('/api/v1/auth/clawhunt/start');
  expect(trustedAwwORedirectURL(`/?invite=${invite}`)).toBe(`/?invite=${invite}`);
  expect(trustedAwwORedirectURL(`//evil.example/?invite=${invite}`)).toBeNull();
  expect(trustedAwwORedirectURL(`/admin?invite=${invite}`)).toBeNull();
  expect(trustedAwwORedirectURL(`/?invite=${invite}&tenant=other`)).toBeNull();
  expect(trustedClawHuntLogoutURL('https://clawhunt.example/api/awwo/sso/logout?ticket=one-time', 'https://clawhunt.example/')).toBe('https://clawhunt.example/api/awwo/sso/logout?ticket=one-time');
  expect(trustedClawHuntLogoutURL('https://evil.example/api/awwo/sso/logout?ticket=one-time', 'https://clawhunt.example/')).toBeNull();
  expect(trustedClawHuntLogoutURL('https://clawhunt.example/other?ticket=one-time', 'https://clawhunt.example/')).toBeNull();
  expect(trustedClawHuntLogoutURL('https://clawhunt.example/api/awwo/sso/logout?ticket=one-time&next=https://evil.example', 'https://clawhunt.example/')).toBeNull();
  expect(trustedClawHuntLogoutURL('https://clawhunt.example/api/awwo/sso/logout?ticket=one-time&ticket=other', 'https://clawhunt.example/')).toBeNull();
  expect(trustedClawHuntLogoutURL(new URL('/', location.origin).href, 'https://clawhunt.example/')).toBe(new URL('/', location.origin).href);
  expect(trustedClawHuntLogoutURL(new URL('/?next=other', location.origin).href, 'https://clawhunt.example/')).toBeNull();
  history.replaceState(null, '', '/?sso=error&reason=expired&tenant=existing');
  clearSSOReturnURL();
  expect(location.search).toBe('?tenant=existing');
});
