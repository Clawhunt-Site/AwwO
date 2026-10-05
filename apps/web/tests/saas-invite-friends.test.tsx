import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { readInvites } from '../src/saas/InviteFriends';
import { clawHuntInviteLink, clawHuntStartURL } from '../src/saas/clawhuntAuth';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';
import { appearanceFixture } from './saas-appearance-fixture';

const identity = { user: { id: 'member-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store' } as Identity;
const codes = [
  { code: 'AWWO-AB12-CD34-EF56', status: 'unused' },
  { code: 'AWWO-GH78-JK9M-NP0Q', status: 'used' },
  { code: 'AWWO-RSTV-WXYZ-0123', status: 'revoked' },
];
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const unauthorized = () => response({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); });

function invitesPage(reply: () => Response, who: Identity = identity) {
  history.replaceState(null, '', '/?account=invites');
  const fetch = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/auth/clawhunt/invites') && init?.method === 'POST' ? reply() : response({ error: { code: 'not_found' } }, 404));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></SaaSPreferencesProvider>);
  return fetch;
}
const reads = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/clawhunt/invites')).length;

it('starts the ClawHunt sign-up view from the sign-in page, keeping a workspace invitation', () => {
  const invite = 'fixture_invite_token_0123456789abcdef';
  expect(clawHuntStartURL('', { signup: true })).toBe('/api/v1/auth/clawhunt/start?signup=1');
  expect(clawHuntStartURL(`?invite=${invite}`, { signup: true })).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}&signup=1`);
  expect(clawHuntStartURL(`?invite=${invite}`)).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(clawHuntStartURL('?invite=https://evil.example/', { signup: true })).toBe('/api/v1/auth/clawhunt/start?signup=1');
});

it('builds share links for printed codes only, with the code in the fragment', () => {
  expect(clawHuntInviteLink('AWWO-AB12-CD34-EF56', 'https://clawhunt.store')).toBe('https://clawhunt.store/awwo#invite=AWWO-AB12-CD34-EF56');
  expect(new URL(clawHuntInviteLink('AWWO-AB12-CD34-EF56', 'https://clawhunt.store')!).search).toBe('');
  for (const bad of ['', 'AWWO-AB12-CD34', 'awwo-ab12-cd34-ef56', 'AWWO-AB12-CD34-EF56&x=1', '<b>AWWO-AB12-CD34-EF56</b>']) expect(clawHuntInviteLink(bad, 'https://clawhunt.store')).toBeNull();
});

it('accepts only the documented invites answer', () => {
  expect(readInvites({ member: true, limit: 3, codes })).toEqual({ member: true, limit: 3, codes });
  expect(readInvites({ member: false, limit: 3, codes: [] })).toEqual({ member: false, limit: 3, codes: [] });
  for (const bad of [null, 'x', {}, { member: 'yes', limit: 3, codes: [] }, { member: true, limit: 3 },
    { member: true, limit: 3, codes: [{ code: '<img src=x>', status: 'unused' }] },
    { member: true, limit: 3, codes: [{ code: 'AWWO-AB12-CD34-EF56', status: 'stolen' }] },
    { member: true, limit: 1, codes },
    { member: false, limit: 3, codes: [codes[0]] }]) expect(readInvites(bad)).toBeNull();
});

it('shows the account its three codes, with links to copy for the unused ones', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const fetch = invitesPage(() => response({ member: true, limit: 3, codes }));
  expect(await screen.findByRole('heading', { name: '邀请好友' })).toBeVisible();
  const list = await screen.findByRole('list');
  const rows = within(list).getAllByRole('listitem');
  expect(rows.map(row => row.querySelector('code')?.textContent)).toEqual(codes.map(item => item.code));
  expect(rows.map(row => row.getAttribute('data-status'))).toEqual(['unused', 'used', 'revoked']);
  expect(within(rows[1]).queryByRole('button')).toBeNull();
  expect(within(rows[2]).queryByRole('button')).toBeNull();
  expect(screen.getByText(/还可邀请 1 位好友/)).toBeVisible();
  fireEvent.click(within(rows[0]).getByRole('button', { name: '复制邀请链接' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://clawhunt.store/awwo#invite=AWWO-AB12-CD34-EF56'));
  expect(await within(rows[0]).findByRole('button', { name: '链接已复制' })).toBeVisible();
  // Screen readers hear which code a button copies, and that it was copied.
  expect(within(rows[0]).getByRole('button', { name: '链接已复制' })).toHaveAccessibleDescription('AWWO-AB12-CD34-EF56');
  expect(screen.getByRole('status')).toHaveTextContent('邀请链接已复制');
  fireEvent.click(within(rows[0]).getByRole('button', { name: '复制邀请码' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('AWWO-AB12-CD34-EF56'));
  expect(await screen.findByText('邀请码已复制', { selector: '[role=status]' })).toBeInTheDocument();
  // One POST for the page: the account's own codes, never a GET that a link could trigger.
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/clawhunt/invites'))).toHaveLength(1);
});

it('says when the account has nothing to share, or has no ClawHunt account to ask about', async () => {
  invitesPage(() => response({ member: false, limit: 3, codes: [] }));
  expect(await screen.findByText('这个账号暂时没有可分享的邀请码。')).toBeVisible();
  cleanup();
  const local = { ...identity, authentication: 'local' } as Identity;
  const fetch = invitesPage(() => response({ member: true, limit: 3, codes }), local);
  expect(await screen.findByText(/邀请码随 ClawHunt 账号提供/)).toBeVisible();
  expect(screen.queryByRole('list')).toBeNull();
  expect(reads(fetch)).toBe(0);
});

it('reads a 404 for a ClawHunt account as unavailable (an API older than the page), never as no account', async () => {
  invitesPage(() => new Response('404 page not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取你的邀请码');
  expect(screen.queryByText(/邀请码随 ClawHunt 账号提供/)).toBeNull();
});

it('leaves an ended session to its own notice, and asks to wait when rate-limited', async () => {
  const fetch = invitesPage(() => response({ error: { code: 'unauthorized', message: 'Continue with ClawHunt again' } }, 401));
  await waitFor(() => expect(reads(fetch)).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  cleanup();
  invitesPage(() => response({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429));
  expect(await screen.findByRole('alert')).toHaveTextContent('请求太频繁');
});

it('fails closed on an unavailable issuer or a reply in any other shape, and retries on request', async () => {
  let reply = response({ error: { code: 'invites_unavailable', message: 'unavailable' } }, 503);
  const fetch = invitesPage(() => reply);
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取你的邀请码');
  expect(screen.queryByRole('list')).toBeNull();
  reply = response({ member: true, limit: 3, codes: [{ code: 'call 1-800-555-0199', status: 'unused' }] });
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/clawhunt/invites'))).toHaveLength(2));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取你的邀请码');
  expect(screen.queryByText(/call 1-800/)).toBeNull();
});

it('offers sign-up on the sign-in page and tells a new user the code comes after it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.store' })));
  render(<SaaSApp />);
  expect(await screen.findByRole('link', { name: '使用 ClawHunt 账号继续' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start');
  expect(screen.getByRole('link', { name: '没有账号？注册 ClawHunt 账号' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start?signup=1');
  expect(screen.getByText(/还没开通 AwwO？注册或登录后会弹出邀请码输入框/)).toBeVisible();
});

it('puts the invite page in the menu and the account panel of a ClawHunt account only', async () => {
  const owner = { ...identity, tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(owner) : url.endsWith('/appearance') ? response(appearanceFixture) : response({ items: [] })));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(await screen.findByRole('link', { name: '邀请好友' })).toHaveAttribute('href', '/?account=invites');
  // The account panel, where an account looks for its invitations.
  fireEvent.click(screen.getByRole('button', { name: '账号与工作区' }));
  expect(await screen.findByRole('link', { name: '邀请好友：查看你的 3 个邀请码' })).toHaveAttribute('href', '/?account=invites');
  cleanup();
  const local = { ...owner, authentication: 'local' as const };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(local) : url.endsWith('/appearance') ? response(appearanceFixture) : response({ items: [] })));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(screen.queryByRole('link', { name: '邀请好友' })).toBeNull();
});


it('links the invite page from Account security for a ClawHunt account only', async () => {
  history.replaceState(null, '', '/?account=security');
  vi.stubGlobal('fetch', vi.fn(async () => response({ items: [] })));
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></SaaSPreferencesProvider>);
  expect(await screen.findByRole('link', { name: '邀请好友' })).toHaveAttribute('href', '/?account=invites');
  cleanup();
  history.replaceState(null, '', '/?account=security');
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={{ ...identity, authentication: 'local' } as Identity}><p>workspace</p></PersonalEngineGate></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: '账号安全' });
  expect(screen.queryByRole('link', { name: '邀请好友' })).toBeNull();
});
