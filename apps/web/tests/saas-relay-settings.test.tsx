import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider } from '../src/saas/accountPreferences';
import { readRelayKey, relayOffered } from '../src/saas/settings/relay';
import type { Identity } from '../src/saas/api';

const tenants = [
  { id: 'team-a', name: 'Team A', status: 'active', role: 'owner' },
  { id: 'team-r', name: 'Read only', status: 'active', role: 'reader' },
  { id: 'team-s', name: 'Paused', status: 'suspended', role: 'owner' },
  { id: 'team-m', name: 'Team M', status: 'active', role: 'member' },
];
const hosted = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants, authentication: 'clawhunt',
  clawhuntSiteURL: 'https://clawhunt.example', personalCredentialsRequired: false, relay: true } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const KEY = 'awwo_rk_' + 'A'.repeat(43);
const item = (id: string, overrides: Record<string, unknown> = {}) => ({ id, name: 'Laptop ' + id, prefix: 'awwo_rk_AAAA', tenant: { id: 'team-a', name: 'Team A' },
  createdAt: '2026-10-20T08:00:00Z', expiresAt: '2099-01-18T08:00:00Z', lastUsedAt: null, revokedAt: null, ...overrides });

/** The keys API in memory: its list, a key made (each of `keys` in turn), a key revoked; after one, the list can answer
 *  `listAfterRevoke` instead (an error's status). */
function server({ items = [item('k1')] as unknown[], list = undefined as unknown, made = undefined as unknown, keys = [KEY], listAfterRevoke = 0 } = {}) {
  const state = { items: [...items], made: 0, revoked: false };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url.endsWith('/auth/preferences')) return json({ preferences: {}, version: 0 });
    if (url.endsWith('/auth/relay-keys') && method === 'GET') {
      if (state.revoked && listAfterRevoke) return json({ error: { code: 'database_unavailable', message: 'Database unavailable' } }, listAfterRevoke);
      return json(list ?? { items: state.items, limit: 5 });
    }
    if (url.endsWith('/auth/relay-keys') && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const fresh = item('k' + (state.items.length + 1), { name: body.name || 'AwwO 本地版', tenant: { id: body.tenantId, name: body.tenantId } });
      state.items = [fresh, ...state.items];
      return json(made ?? { key: keys[Math.min(state.made++, keys.length - 1)], item: fresh }, 201);
    }
    const revoke = /\/auth\/relay-keys\/([^/]+)$/.exec(url);
    if (revoke && method === 'DELETE') {
      state.items = state.items.map(entry => (entry as { id: string }).id === revoke[1] ? { ...(entry as object), revokedAt: '2026-10-25T09:00:00Z' } : entry);
      state.revoked = true;
      return json(null, 204);
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}
const calls = (fetch: ReturnType<typeof vi.fn>, method: string) => fetch.mock.calls.filter(([url, init]) => String(url).includes('/auth/relay-keys') && ((init as RequestInit | undefined)?.method || 'GET') === method);

function open(section: string, who: Identity = hosted) {
  history.replaceState(null, '', `/?account=${section}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('offers 本机版连接 only on a hosted site whose API says it relays', async () => {
  expect(relayOffered(hosted)).toBe(true);
  expect(relayOffered({ ...hosted, relay: false })).toBe(false);
  expect(relayOffered({ ...hosted, edition: 'local' })).toBe(false);
  server();
  open('relay');
  const nav = await screen.findByRole('navigation', { name: '设置' });
  expect(within(nav).getByRole('link', { name: '本机版连接' }).getAttribute('aria-current')).toBe('page');
  cleanup();
  // Without it, the address opens the engines page and the list has no such entry.
  for (const who of [{ ...hosted, relay: undefined }, { ...hosted, edition: 'local', personalCredentialsRequired: true, authentication: 'local' }] as unknown as Identity[]) {
    server();
    open('relay', who);
    const other = await screen.findByRole('navigation', { name: '设置' });
    expect(within(other).queryByRole('link', { name: '本机版连接' })).toBeNull();
    expect(within(other).getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.getAttribute('href'))).toEqual(['/?account=engines']);
    cleanup();
  }
});

it('lists the keys with their state, makes one for a workspace the person can run calls in, and shows it once', async () => {
  const { fetch } = server({ items: [item('k1', { lastUsedAt: '2026-10-24T08:00:00Z' }), item('k2', { expiresAt: '2026-10-21T08:00:00Z' }), item('k3', { revokedAt: '2026-10-22T08:00:00Z' })] });
  open('relay');
  const list = await screen.findByRole('list', { name: '连接密钥' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['live', 'expired', 'revoked']);
  expect(within(rows[0]).getByText('有效')).toBeTruthy();
  expect(within(rows[1]).getByText('已过期')).toBeTruthy();
  expect(within(rows[2]).getByText('已撤销')).toBeTruthy();
  expect(within(rows[2]).queryByRole('button', { name: '撤销' })).toBeNull();
  // Only the workspaces the person can run calls in: not one they only read, not a suspended one.
  const select = screen.getByLabelText('计入的工作区') as HTMLSelectElement;
  expect([...select.options].map(option => option.value)).toEqual(['team-a', 'team-m']);
  fireEvent.change(select, { target: { value: 'team-m' } });
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  Desk  ' } });
  fireEvent.click(screen.getByRole('button', { name: '生成密钥' }));
  const shown = await screen.findByText(KEY);
  expect(JSON.parse(String((calls(fetch, 'POST')[0][1] as RequestInit).body))).toEqual({ name: 'Desk', tenantId: 'team-m' });
  expect(shown.closest('[role="status"]')?.textContent).toContain('只显示这一次');
  // The list is read again, with the new key in it, and never shows the key itself.
  await waitFor(() => expect(within(screen.getByRole('list', { name: '连接密钥' })).getAllByRole('listitem')).toHaveLength(4));
  expect(within(screen.getByRole('list', { name: '连接密钥' })).queryByText(KEY)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
  expect(screen.queryByText(KEY)).toBeNull();
});

it('copies the new key', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  server({ items: [] });
  open('relay');
  await screen.findByText('还没有连接密钥。');
  fireEvent.click(screen.getByRole('button', { name: '生成密钥' }));
  await screen.findByText(KEY);
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  await screen.findByRole('button', { name: '已复制' });
  expect(writeText).toHaveBeenCalledWith(KEY);
});

it('draws a second key made while the first is shown afresh, never as already copied', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  const second = 'awwo_rk_' + 'B'.repeat(43);
  server({ items: [], keys: [KEY, second] });
  open('relay');
  await screen.findByText('还没有连接密钥。');
  fireEvent.click(screen.getByRole('button', { name: '生成密钥' }));
  await screen.findByText(KEY);
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  await screen.findByRole('button', { name: '已复制' });
  fireEvent.click(screen.getByRole('button', { name: '生成密钥' }));
  await screen.findByText(second);
  expect(screen.queryByText(KEY)).toBeNull();
  expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
});

it('revokes a key only once it is confirmed, then reads the list again', async () => {
  const { fetch } = server();
  open('relay');
  const row = within(await screen.findByRole('list', { name: '连接密钥' })).getAllByRole('listitem')[0];
  fireEvent.click(within(row).getByRole('button', { name: '撤销' }));
  expect(calls(fetch, 'DELETE')).toHaveLength(0);
  fireEvent.click(within(row).getByRole('button', { name: '取消' }));
  fireEvent.click(within(row).getByRole('button', { name: '撤销' }));
  fireEvent.click(within(row).getByRole('button', { name: '确认撤销' }));
  await waitFor(() => expect(within(screen.getByRole('list', { name: '连接密钥' })).getAllByRole('listitem')[0].getAttribute('data-state')).toBe('revoked'));
  expect(calls(fetch, 'DELETE').map(([url]) => String(url).split('/').pop())).toEqual(['k1']);
});

it('draws a key revoked as revoked even when the list cannot be read again', async () => {
  server({ items: [item('k1'), item('k2')], listAfterRevoke: 503 });
  open('relay');
  const row = within(await screen.findByRole('list', { name: '连接密钥' })).getAllByRole('listitem')[0];
  fireEvent.click(within(row).getByRole('button', { name: '撤销' }));
  fireEvent.click(within(row).getByRole('button', { name: '确认撤销' }));
  await screen.findByRole('button', { name: '重试' });
  const rows = within(screen.getByRole('list', { name: '连接密钥' })).getAllByRole('listitem');
  expect(rows.map(entry => entry.getAttribute('data-state'))).toEqual(['revoked', 'live']);
});

it('holds the button at the limit, and says what the API refused or could not be read', async () => {
  server({ items: [1, 2, 3, 4, 5].map(n => item('k' + n)) });
  open('relay');
  await screen.findByRole('list', { name: '连接密钥' });
  expect((screen.getByRole('button', { name: '生成密钥' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('已有 5 个有效密钥：撤销一个后才能再生成。')).toBeTruthy();
  cleanup();
  server({ list: { items: [{ id: 'x' }], limit: 5 } });
  open('relay');
  expect((await screen.findByRole('alert')).textContent).toContain('线上 AwwO 的回答无法识别');
  cleanup();
  server({ items: [], made: { key: 'not-a-key' } });
  open('relay');
  await screen.findByText('还没有连接密钥。');
  fireEvent.click(screen.getByRole('button', { name: '生成密钥' }));
  expect((await screen.findByRole('alert')).textContent).toContain('线上 AwwO 的回答无法识别');
  expect(screen.queryByText('not-a-key')).toBeNull();
});

it('says so when the person has no workspace to count calls in', async () => {
  server({ items: [] });
  open('relay', { ...hosted, tenants: [tenants[1], tenants[2]] } as unknown as Identity);
  expect(await screen.findByText(/你还没有可以运行任务的工作区/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '生成密钥' })).toBeNull();
});

it('reads a key only in its documented shape', () => {
  expect(readRelayKey(item('k1'))?.prefix).toBe('awwo_rk_AAAA');
  expect(readRelayKey({ ...item('k1'), prefix: KEY })).toBeNull();
  expect(readRelayKey({ ...item('k1'), expiresAt: 'soon' })).toBeNull();
  expect(readRelayKey({ ...item('k1'), tenant: null })).toBeNull();
  expect(readRelayKey({ ...item('k1'), lastUsedAt: 7 })).toBeNull();
});
