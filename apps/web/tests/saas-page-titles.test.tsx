import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { clearSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { pageTitle } from '../src/saas/pageTitle';
import { appearanceFixture } from './saas-appearance-fixture';

// Every page kept saas.html's one title, so the tabs of three canvases, the settings and the admin all read
// 「AwwO · Agent Workspace」 (2026-11-05). A page now names itself first and AwwO last.
const SITE = 'AwwO · Agent Workspace';
const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: 'Team A', role: 'owner', status: 'active' }], authentication: 'local' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () => response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401);
const signInMethods = { clawhuntSSO: false, localAuth: true, passwordRecovery: true };

/** The server: the account (or none), the sign-in methods, an empty workspace, and a canvas called 「季度复盘」. */
function serve(me: unknown, overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [path, body] of Object.entries(overrides)) if (url.includes(path)) return response(body);
    if (url.endsWith('/auth/me')) return me ? response(me) : unauthorized();
    if (url.endsWith('/auth/options')) return response(signInMethods);
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.includes('/canvases/canvas-a')) return response({ id: 'canvas-a', name: '季度复盘', version: 2,
      document: { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '云端节点' }] } });
    return response({ items: [] });
  }));
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  localStorage.setItem('awwo.workmode.v1:user-a', 'skipped');
  document.title = SITE;
});
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); });

it('joins a page’s names with AwwO last, leaving out empty ones', () => {
  expect(pageTitle('季度复盘')).toBe('季度复盘 · AwwO');
  expect(pageTitle('账号安全', '设置')).toBe('账号安全 · 设置 · AwwO');
  expect(pageTitle(' ', '设置')).toBe('设置 · AwwO');
});

it.each([
  ['zh', 'AwwO · 让 Agent 在同一张画布上协作'],
  ['en', 'AwwO · Bring your agents together on one canvas'],
] as const)('names the sign-in page, the first a visitor sees, by what AwwO does (%s)', async (locale, title) => {
  localStorage.setItem('superclaw_locale', locale);
  serve(null);
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: locale === 'zh' ? '欢迎回来' : 'Welcome back' });
  expect(document.title).toBe(title);
});

it('names the account recovery a sign-in page opens as itself, not as the sign-in page', async () => {
  serve(null);
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '忘记密码？' }));
  await waitFor(() => expect(document.title).toBe('找回密码 · AwwO'));
});

it('names a reset link’s page and a failed ClawHunt sign-in', async () => {
  history.replaceState(null, '', '/?reset=reset-token');
  serve(null);
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('重设密码 · AwwO'));
  cleanup();
  history.replaceState(null, '', '/?sso=error&reason=expired');
  serve(null);
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: '账号连接未完成' });
  expect(document.title).toBe('登录 · AwwO');
});

it('names the workspace home by its workspace, and a suspended or missing one by what it is', async () => {
  serve(identity);
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('Team A · AwwO'));
  cleanup();
  history.replaceState(null, '', '/?tenant=tenant-a&canvas=canvas-a');
  serve({ ...identity, tenants: [{ ...identity.tenants[0], status: 'suspended' }] });
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: '工作区已暂停' });
  expect(document.title).toBe('工作区已暂停 · AwwO');
});

// Signing in on the page swaps it without loading another, so a canvas that cannot open must name itself: it kept the
// sign-in page's title, as draft recovery would have, until the canvases named themselves in every state.
it.each(['owner', 'reader'])('names a canvas page that cannot open as a canvas, after a sign-in on the same page (%s)', async role => {
  history.replaceState(null, '', '/?tenant=tenant-a&canvas=missing');
  const account = { ...identity, tenants: [{ ...identity.tenants[0], role }] };
  let signedIn = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) return signedIn ? response(account) : unauthorized();
    if (url.endsWith('/auth/options')) return response(signInMethods);
    if (url.endsWith('/auth/login') && init.method === 'POST') { signedIn = true; return response(account); }
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.includes('/canvases/missing')) return response({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return response({ items: [] });
  }));
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: '欢迎回来' });
  expect(document.title).toBe('AwwO · 让 Agent 在同一张画布上协作');
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('alert');
  expect(document.title).toBe('画布 · AwwO');
});

// The editing and the read-only canvas each name the page while its canvas is still being read.
it.each(['owner', 'reader'])('names a canvas page as a canvas while it loads (%s)', async role => {
  history.replaceState(null, '', '/?tenant=tenant-a&canvas=slow');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return response({ ...identity, tenants: [{ ...identity.tenants[0], role }] });
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.includes('/canvases/slow')) return new Promise<Response>(() => {});
    return response({ items: [] });
  }));
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('画布 · AwwO'));
});

it('names a canvas page by its canvas, for a reader too', async () => {
  history.replaceState(null, '', '/?tenant=tenant-a&canvas=canvas-a');
  serve({ ...identity, tenants: [{ ...identity.tenants[0], role: 'reader' }] });
  render(<SaaSApp />);
  await waitFor(() => expect(document.querySelector('.awwo-workspace')).not.toBeNull());
  await waitFor(() => expect(document.title).toBe('季度复盘 · AwwO'));
});

it.each([
  ['zh', 'security', '账号安全 · 设置 · AwwO'],
  ['en', 'security', 'Account security · Settings · AwwO'],
  ['zh', 'about', '关于 AwwO · 设置 · AwwO'],
] as const)('names a settings page by its section (%s, %s)', async (locale, section, title) => {
  localStorage.setItem('superclaw_locale', locale);
  history.replaceState(null, '', `/?account=${section}`);
  serve(identity, { '/auth/preferences': { preferences: {}, version: 0 }, '/auth/sessions': { items: [] } });
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe(title));
});

// 邀请好友 opens for an account not on ClawHunt too, though its navigation does not list it there.
it('names 邀请好友 for an account its navigation leaves it out of', async () => {
  history.replaceState(null, '', '/?account=invites');
  serve(identity, { '/auth/preferences': { preferences: {}, version: 0 } });
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('邀请好友 · 设置 · AwwO'));
});

it('names platform administration and an invitation', async () => {
  history.replaceState(null, '', '/admin');
  serve({ ...identity, user: { ...identity.user, platformRole: 'admin' } });
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('平台管理 · AwwO'));
  cleanup();
  history.replaceState(null, '', '/?invite=invite-token');
  serve(identity, { '/invites/invite-token': { tenantName: 'Team B', role: 'member', expiresAt: '2026-12-01T00:00:00Z' } });
  render(<SaaSApp />);
  await waitFor(() => expect(document.title).toBe('加入工作区 · AwwO'));
});
