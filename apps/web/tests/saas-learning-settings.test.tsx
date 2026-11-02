import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider } from '../src/saas/accountPreferences';
import type { Identity } from '../src/saas/api';

const tenants = [
  { id: 'team-o', name: 'Owned', status: 'active', role: 'owner' },
  { id: 'team-a', name: 'Administered', status: 'active', role: 'admin' },
  { id: 'team-m', name: 'Joined', status: 'active', role: 'member' },
];
const hosted = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants, authentication: 'clawhunt',
  clawhuntSiteURL: 'https://clawhunt.example', personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Setting = { offered: boolean; on: boolean; since: string | null };
const setting = (offered: boolean, on = false): Setting => ({ offered, on, since: on ? '2026-11-01T09:00:00Z' : null });

/** The learning settings API in memory, one workspace's settings each, as offered (and on, for the ones given); a PUT
 *  can be held until the test lets it answer. */
function server(start = { consent: setting(true), memorySuggestions: setting(true) }) {
  const state: Record<string, { consent: Setting; memorySuggestions: Setting }> = {};
  const held: Array<() => void> = [];
  let hold = false;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/deletion-request')) return json({ request: null });
    const match = /\/tenants\/([^/]+)\/learning$/.exec(url);
    if (match) {
      const settings = state[match[1]] ??= { consent: { ...start.consent }, memorySuggestions: { ...start.memorySuggestions } };
      if (method === 'PUT') {
        const change = JSON.parse(String(init.body)) as { consent?: boolean; memorySuggestions?: boolean };
        for (const name of ['consent', 'memorySuggestions'] as const) {
          if (change[name] === undefined) continue;
          settings[name] = { ...settings[name], on: change[name]!, since: change[name] ? '2026-11-02T09:00:00Z' : null };
        }
        if (hold) await new Promise<void>(resolve => held.push(resolve));
      }
      return json(settings);
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, hold: () => { hold = true; }, release: () => { hold = false; held.splice(0).forEach(resolve => resolve()); } };
}
const learningCalls = (fetch: ReturnType<typeof vi.fn>, method: string) => fetch.mock.calls.filter(([url, init]) => String(url).includes('/learning') && ((init as RequestInit | undefined)?.method || 'GET') === method);
const putBody = (fetch: ReturnType<typeof vi.fn>, n = 0) => JSON.parse(String((learningCalls(fetch, 'PUT')[n][1] as RequestInit).body));

function open(tenant: string, who: Identity = hosted) {
  history.replaceState(null, '', `/?account=data&tenant=${tenant}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}
const card = async () => (await screen.findByRole('heading', { name: '学习与改进' })).closest('section') as HTMLElement;

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('lets the owner turn Help improve AwwO on, off unless turned on, saying since when', async () => {
  const { fetch } = server();
  open('team-o');
  const section = await card();
  const memory = within(section).getByRole('checkbox', { name: /从运行中提炼记忆建议/ });
  const consent = within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ });
  expect(memory).not.toBeChecked();
  expect(consent).not.toBeChecked();
  fireEvent.click(consent);
  await waitFor(() => expect(consent).toBeChecked());
  expect(putBody(fetch)).toEqual({ consent: true });
  expect(within(section).getByText(/开启于/)).toBeVisible();
  expect(memory).not.toBeChecked();
});

it('lets an admin turn memory suggestions on, never the consent, and a member neither', async () => {
  const { fetch } = server();
  open('team-a');
  let section = await card();
  const memory = within(section).getByRole('checkbox', { name: /从运行中提炼记忆建议/ });
  expect(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeDisabled();
  fireEvent.click(memory);
  await waitFor(() => expect(memory).toBeChecked());
  expect(putBody(fetch)).toEqual({ memorySuggestions: true });
  cleanup();
  server();
  open('team-m');
  section = await card();
  expect(within(section).getByRole('checkbox', { name: /从运行中提炼记忆建议/ })).toBeDisabled();
  expect(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeDisabled();
});

it('keeps the workspace while a change is on its way, and shows its answer for the workspace it was made in', async () => {
  const api = server();
  open('team-o');
  const section = await card();
  const picker = within(section).getByRole('combobox');
  api.hold();
  fireEvent.click(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ }));
  await waitFor(() => expect(learningCalls(api.fetch, 'PUT').length).toBe(1));
  expect(picker).toBeDisabled();
  await act(async () => { api.release(); });
  await waitFor(() => expect(picker).toBeEnabled());
  expect(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeChecked();
});

it('keeps a consent given where it is no longer offered, for its owner to withdraw, never to give again', async () => {
  const { fetch } = server({ consent: setting(false, true), memorySuggestions: setting(false) });
  open('team-o');
  const section = await card();
  const consent = within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ });
  expect(consent).toBeChecked();
  expect(consent).toBeEnabled();
  expect(within(section).queryByRole('checkbox', { name: /从运行中提炼记忆建议/ })).toBeNull();
  fireEvent.click(consent);
  await waitFor(() => expect(putBody(fetch)).toEqual({ consent: false }));
  // Off and no longer offered: the card goes.
  await waitFor(() => expect(screen.queryByRole('heading', { name: '学习与改进' })).toBeNull());
});

it('keeps the way to another workspace whose setting is on, where this one has none to show', async () => {
  const api = server({ consent: setting(false), memorySuggestions: setting(false) });
  api.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/deletion-request')) return json({ request: null });
    const match = /\/tenants\/([^/]+)\/learning$/.exec(url);
    if (match?.[1] === 'team-o') return json({ consent: setting(false), memorySuggestions: setting(false), elsewhere: true });
    if (match?.[1] === 'team-a') return json({ consent: setting(false), memorySuggestions: setting(false, true), elsewhere: false });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  open('team-o');
  const section = await card();
  expect(within(section).getByText(/在上面选它就能关闭/)).toBeVisible();
  fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'team-a' } });
  const memory = await within(section).findByRole('checkbox', { name: /从运行中提炼记忆建议/ });
  expect(memory).toBeChecked();
  expect(memory).toBeEnabled();
});

it('shows nothing, and no error, on an API without the settings (a website released before its API)', async () => {
  const fetch = vi.fn(async (url: string) => String(url).endsWith('/auth/preferences') ? json({ preferences: {}, version: 0 })
    : String(url).endsWith('/auth/deletion-request') ? json({ request: null })
    : json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  vi.stubGlobal('fetch', fetch);
  open('team-o');
  expect(await screen.findByRole('heading', { name: '导出我的数据' })).toBeVisible();
  await waitFor(() => expect(learningCalls(fetch, 'GET').length).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole('heading', { name: '学习与改进' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('shows only what this AwwO offers, and nothing when it offers neither', async () => {
  server({ consent: setting(false), memorySuggestions: setting(true) });
  open('team-o');
  const section = await card();
  expect(within(section).queryByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeNull();
  cleanup();
  const { fetch } = server({ consent: setting(false), memorySuggestions: setting(false) });
  open('team-o');
  await waitFor(() => expect(learningCalls(fetch, 'GET').length).toBeGreaterThan(0));
  expect(await screen.findByRole('heading', { name: '导出我的数据' })).toBeVisible();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole('heading', { name: '学习与改进' })).toBeNull();
});
