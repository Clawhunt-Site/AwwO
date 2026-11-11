// AwwO's sign-in with no invite codes (the public beta: ClawHunt #1193 opened AwwO to every ClawHunt account it does not
// bar). The sign-in page says AwwO is open and still offers sign-up; no menu, panel or page offers 邀请好友 any more, and
// an old ?account=invites link opens 账号安全. (Replaces saas-invite-friends.test.tsx, whose page went with the codes.)
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { clawHuntStartURL } from '../src/saas/clawhuntAuth';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';
import { appearanceFixture } from './saas-appearance-fixture';

const identity = { user: { id: 'member-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store' } as Identity;
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const unauthorized = () => response({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); });

it('starts the ClawHunt sign-up view from the sign-in page, keeping a workspace invitation', () => {
  const invite = 'fixture_invite_token_0123456789abcdef';
  expect(clawHuntStartURL('', { signup: true })).toBe('/api/v1/auth/clawhunt/start?signup=1');
  expect(clawHuntStartURL(`?invite=${invite}`, { signup: true })).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}&signup=1`);
  expect(clawHuntStartURL(`?invite=${invite}`)).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(clawHuntStartURL('?invite=https://evil.example/', { signup: true })).toBe('/api/v1/auth/clawhunt/start?signup=1');
});

it('says on the sign-in page that AwwO is open to everyone, with sign-in and sign-up, and no invite code', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.store' })));
  render(<SaaSApp />);
  expect(await screen.findByRole('link', { name: '使用 ClawHunt 账号继续' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start');
  expect(screen.getByRole('link', { name: '没有账号？注册 ClawHunt 账号' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start?signup=1');
  expect(screen.getByText('AwwO 公测中，对所有人开放：注册或登录 ClawHunt 账号后就能直接进入。')).toBeVisible();
  expect(document.body).not.toHaveTextContent('邀请码');
});

it('offers 邀请好友 nowhere: not in the menu, the account panel or Account security', async () => {
  const owner = { ...identity, tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(owner) : url.endsWith('/appearance') ? response(appearanceFixture) : response({ items: [] })));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(await screen.findByRole('link', { name: '账号安全' })).toBeVisible();
  expect(screen.queryByRole('link', { name: /邀请好友/ })).toBeNull();
  // The account panel keeps its plans link, and has no invite codes to show.
  fireEvent.click(screen.getByRole('button', { name: '账号与工作区' }));
  expect(await screen.findByRole('link', { name: '套餐与点数：Pro / Max / Ultra' })).toHaveAttribute('href', '/?account=plans');
  expect(screen.queryByRole('link', { name: /邀请好友/ })).toBeNull();
  expect(document.body).not.toHaveTextContent('邀请码');
  cleanup();
  history.replaceState(null, '', '/?account=security');
  vi.stubGlobal('fetch', vi.fn(async () => response({ items: [] })));
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: '账号安全' });
  expect(screen.queryByRole('link', { name: /邀请好友/ })).toBeNull();
});

it('opens 账号安全 for an old ?account=invites link, and never asks ClawHunt for invite codes', async () => {
  history.replaceState(null, '', '/?account=invites');
  const fetch = vi.fn(async () => response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></SaaSPreferencesProvider>);
  expect(await screen.findByRole('heading', { name: '账号安全' })).toBeVisible();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/auth/clawhunt/invites'))).toBe(false);
});
