import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { GraphRunPanel } from '../src/saas/GraphRunPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { api, onSessionEnded, sessionFetch, trackSignedInSession } from '../src/saas/api';
import { appearanceFixture } from './saas-appearance-fixture';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ended = () => response({ error: { code: 'unauthorized', message: 'Session expired' } }, 401);
const identity = { user: { id: 'ada', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.example/' };
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); trackSignedInSession(false); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); trackSignedInSession(false); localStorage.clear(); });

it('stops sending requests once the signed-in session is reported ended, except to sign-in routes', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/options') ? response({ clawhuntSSO: true }) : ended());
  vi.stubGlobal('fetch', fetch);
  const listener = vi.fn();
  const stop = onSessionEnded(listener);
  trackSignedInSession(true);
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  expect(listener).toHaveBeenCalledTimes(1);
  await expect(api('/tenants/t/canvases/c/graph-runs')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(api('/auth/options')).resolves.toEqual({ clawhuntSSO: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  // A new sign-in in this page lets requests through again.
  trackSignedInSession(true);
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});

it('keeps requests flowing while signed out and for other 401 answers', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('link') ? response({ error: { code: 'sso_link_failed' } }, 401) : ended());
  vi.stubGlobal('fetch', fetch);
  const listener = vi.fn();
  const stop = onSessionEnded(listener);
  // A visitor without a session: the public pages keep reaching the API.
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401 });
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(2);
  // A wrong password while linking is not the end of a session.
  trackSignedInSession(true);
  await expect(api('/auth/clawhunt/link', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'sso_link_failed' });
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

it('applies the same rule to raw API reads such as event streams and downloads', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('/archive') ? response({ error: { code: 'not_found' } }, 401) : ended());
  vi.stubGlobal('fetch', fetch);
  const listener = vi.fn();
  const stop = onSessionEnded(listener);
  trackSignedInSession(true);
  // Another 401 code does not end the session.
  expect((await sessionFetch('/api/v1/tenants/t/runs/r/archive')).status).toBe(401);
  expect(listener).not.toHaveBeenCalled();
  const events = await sessionFetch('/api/v1/tenants/t/runs/r/events', { credentials: 'include' });
  expect(events.status).toBe(401);
  expect(await events.json()).toMatchObject({ error: { code: 'unauthorized' } });
  expect(listener).toHaveBeenCalledTimes(1);
  const later = await sessionFetch('/api/v1/tenants/t/runs/r/events');
  expect(later.status).toBe(401);
  await expect(api('/tenants/t/canvases')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(2);
  stop();
});

it('stops the run panel polling after the session ends', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  trackSignedInSession(true);
  const fetch = vi.fn(async () => ended());
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" readOnly={false} /></SaaSPreferencesProvider>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps the page and offers a ClawHunt sign-in when the session ends', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity)
    : url.endsWith('/appearance') ? ended() : response(appearanceFixture));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  const notice = await screen.findByText(/登录已失效，页面已停止自动更新/);
  expect(notice.closest('[role="alert"]')).not.toBeNull();
  expect(screen.getByRole('link', { name: '使用 ClawHunt 账号继续' })).toHaveAttribute('href', '/api/v1/auth/clawhunt/start');
  // The workspace stays on screen rather than being swapped for the sign-in page.
  expect(screen.getByRole('heading', { name: '选择工作区' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '使用 ClawHunt 登录 AwwO' })).toBeNull();
  const sent = fetch.mock.calls.length;
  await expect(api('/tenants')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(sent);
});
