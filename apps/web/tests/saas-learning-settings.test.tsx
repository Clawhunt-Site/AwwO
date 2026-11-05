import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

/** The learning settings API in memory, one workspace's settings each: the consent offered and off, self-learning
 *  offered and on (as a deployment that offers it has every workspace), unless start says otherwise; a PUT can be held
 *  until the test lets it answer. */
function server(start = { consent: setting(true), selfLearning: setting(true, true) }) {
  const state: Record<string, { consent: Setting; selfLearning: Setting }> = {};
  const held: Array<() => void> = [];
  let hold = false;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/deletion-request')) return json({ request: null });
    const match = /\/tenants\/([^/]+)\/learning$/.exec(url);
    if (match) {
      const settings = state[match[1]] ??= { consent: { ...start.consent }, selfLearning: { ...start.selfLearning } };
      if (method === 'PUT') {
        const change = JSON.parse(String(init.body)) as { consent?: boolean; selfLearning?: boolean };
        for (const name of ['consent', 'selfLearning'] as const) {
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

// The settings center is a lazy chunk: read once before the tests, so that no test's time goes on loading it.
beforeAll(async () => { await import('../src/saas/SettingsCenter'); }, 300_000);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('shows self-learning on where it is offered, and lets the owner turn Help improve AwwO on, saying since when', async () => {
  const { fetch } = server();
  open('team-o');
  const section = await card();
  const learning = within(section).getByRole('checkbox', { name: /自动学习/ });
  const consent = within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ });
  expect(learning).toBeChecked();
  expect(learning).toBeEnabled();
  expect(within(section).getByText(/开启于/)).toBeVisible();
  expect(within(section).getByText(/默认开启，管理员或所有者可以关闭/)).toBeVisible();
  // It says what it keeps beyond the notes and lessons (keyed hashes of what people deleted, and the runs' copies of the
  // notes they were given), what a cycle archives, and no cadence of its own: the Lessons panel says how often.
  expect(within(section).getByText(/用 ClawHunt 持有的密钥算出的哈希，不留原文/)).toBeVisible();
  expect(within(section).getByText(/运行也会留着交给它们的笔记的副本/)).toBeVisible();
  expect(within(section).getByText(/把试用中 30 天里没有运行再印证的归档/)).toBeVisible();
  expect(within(section).queryByText(/每 3 天/)).toBeNull();
  expect(consent).not.toBeChecked();
  fireEvent.click(consent);
  await waitFor(() => expect(consent).toBeChecked());
  expect(putBody(fetch)).toEqual({ consent: true });
  expect(learning).toBeChecked();
});

it('lets an admin turn self-learning off, never the consent, and a member neither', async () => {
  const { fetch } = server();
  open('team-a');
  let section = await card();
  const learning = within(section).getByRole('checkbox', { name: /自动学习/ });
  expect(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeDisabled();
  fireEvent.click(learning);
  await waitFor(() => expect(learning).not.toBeChecked());
  expect(putBody(fetch)).toEqual({ selfLearning: false });
  expect(within(section).queryByText(/开启于/)).toBeNull();
  cleanup();
  server();
  open('team-m');
  section = await card();
  expect(within(section).getByRole('checkbox', { name: /自动学习/ })).toBeDisabled();
  expect(within(section).getByRole('checkbox', { name: /自动学习/ })).toBeChecked();
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
  const { fetch } = server({ consent: setting(false, true), selfLearning: setting(false) });
  open('team-o');
  const section = await card();
  const consent = within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ });
  expect(consent).toBeChecked();
  expect(consent).toBeEnabled();
  expect(within(section).queryByRole('checkbox', { name: /自动学习/ })).toBeNull();
  fireEvent.click(consent);
  await waitFor(() => expect(putBody(fetch)).toEqual({ consent: false }));
  // Off and no longer offered: the card goes.
  await waitFor(() => expect(screen.queryByRole('heading', { name: '学习与改进' })).toBeNull());
});

it('keeps the way to another workspace whose setting is on, where this one has none to show', async () => {
  const api = server({ consent: setting(false), selfLearning: setting(false) });
  api.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/deletion-request')) return json({ request: null });
    const match = /\/tenants\/([^/]+)\/learning$/.exec(url);
    if (match?.[1] === 'team-o') return json({ consent: setting(false), selfLearning: setting(false), elsewhere: true });
    if (match?.[1] === 'team-a') return json({ consent: setting(false), selfLearning: setting(true, true), elsewhere: false });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  open('team-o');
  const section = await card();
  expect(within(section).getByText(/在上面选它就能关闭/)).toBeVisible();
  fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'team-a' } });
  const learning = await within(section).findByRole('checkbox', { name: /自动学习/ });
  expect(learning).toBeChecked();
  expect(learning).toBeEnabled();
});

it('shows the consent alone on an API from before self-learning, keeping its memory suggestions while on, to turn off', async () => {
  let legacy = setting(true, true);
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/deletion-request')) return json({ request: null });
    if (/\/tenants\/[^/]+\/learning$/.test(url)) {
      if ((init.method || 'GET') === 'PUT' && JSON.parse(String(init.body)).memorySuggestions === false) legacy = setting(true);
      return json({ consent: setting(true), memorySuggestions: legacy, elsewhere: false });
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  open('team-a');
  const section = await card();
  expect(within(section).getByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeDisabled();
  expect(within(section).queryByRole('checkbox', { name: /自动学习/ })).toBeNull();
  const old = within(section).getByRole('checkbox', { name: /从运行中提炼记忆建议/ });
  expect(old).toBeChecked();
  expect(old).toBeEnabled();
  fireEvent.click(old);
  await waitFor(() => expect(putBody(fetch)).toEqual({ memorySuggestions: false }));
  await waitFor(() => expect(within(section).queryByRole('checkbox', { name: /从运行中提炼记忆建议/ })).toBeNull());
  cleanup();
  vi.stubGlobal('fetch', fetch);
  open('team-m');
  expect(within(await card()).queryByRole('checkbox', { name: /从运行中提炼记忆建议/ })).toBeNull();
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
  server({ consent: setting(false), selfLearning: setting(true, true) });
  open('team-o');
  const section = await card();
  expect(within(section).queryByRole('checkbox', { name: /帮助改进 AwwO/ })).toBeNull();
  expect(within(section).getByRole('checkbox', { name: /自动学习/ })).toBeChecked();
  cleanup();
  const { fetch } = server({ consent: setting(false), selfLearning: setting(false) });
  open('team-o');
  await waitFor(() => expect(learningCalls(fetch, 'GET').length).toBeGreaterThan(0));
  expect(await screen.findByRole('heading', { name: '导出我的数据' })).toBeVisible();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole('heading', { name: '学习与改进' })).toBeNull();
});
