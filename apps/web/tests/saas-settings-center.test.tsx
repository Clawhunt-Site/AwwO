import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences, readAccountPreferences, type AccountPreferences } from '../src/saas/accountPreferences';
import { canvasKeyBindings } from '../src/canvas/useCanvasKeys';
import { SETTINGS_SECTIONS } from '../src/saas/settingsFrame';
import type { Identity } from '../src/saas/api';
import { SaaSApp } from '../src/saas/SaaSApp';
import { AdminPanel } from '../src/saas/AdminPanel';
import { appearanceFixture } from './saas-appearance-fixture';

const tenants = [
  { id: 'team-a', name: 'Team A', status: 'active', role: 'owner' },
  { id: 'team-b', name: 'Team B', status: 'active', role: 'reader' },
];
const identity = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants, authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const models = { 'team-a': [{ id: 'opus', label: 'Claude Opus', runtime: 'pi' }, { id: 'qwen', label: 'Qwen', runtime: 'pi' }], 'team-b': [{ id: 'qwen', label: 'Qwen', runtime: 'pi' }] } as Record<string, unknown[]>;

/** A small in-memory server: the settings with their version, a deletion request, each workspace's models. */
function server(initial: Partial<AccountPreferences> = {}) {
  const state = { preferences: { ...emptyAccountPreferences(), ...initial } as AccountPreferences, version: initial ? 1 : 0, request: null as null | Record<string, unknown>, conflictNext: false,
    /** An operator's decision that lands just before the next withdrawal. */
    decidedMeanwhile: null as null | Record<string, unknown> };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url.endsWith('/auth/preferences') && method === 'GET') return json({ preferences: state.preferences, version: state.version });
    if (url.endsWith('/auth/preferences') && method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (state.conflictNext || body.version !== state.version) {
        state.conflictNext = false; state.version += 1;
        return json({ error: { code: 'preferences_version_conflict', message: 'Settings changed elsewhere. Reload before saving.' } }, 409);
      }
      state.preferences = body.preferences; state.version += 1;
      return json({ preferences: state.preferences, version: state.version });
    }
    if (url.endsWith('/auth/deletion-request')) {
      if (method === 'GET') return json({ request: state.request });
      if (method === 'POST') { state.request = { id: 'del-1', status: 'pending', reason: JSON.parse(String(init.body)).reason, createdAt: '2026-10-18T06:00:00Z' }; return json({ request: state.request }, 201); }
      if (method === 'DELETE' && state.decidedMeanwhile) { state.request = state.decidedMeanwhile; return json({ error: { code: 'not_found', message: 'No pending deletion request' } }, 404); }
      if (method === 'DELETE') { state.request = { ...state.request, status: 'withdrawn', withdrawnAt: '2026-10-18T06:05:00Z' }; return json({ request: state.request }); }
    }
    const runtime = /\/tenants\/([^/]+)\/execution\/runtime/.exec(url) || /\/tenants\/([^/]+)\/[^?]*runtime/.exec(url);
    if (runtime) return json({ ready: true, capabilities: { workspace: true, approvals: true }, models: models[runtime[1]] || [] });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}
const writes = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/auth/preferences') && (init as RequestInit | undefined)?.method === 'PUT')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

function open(section: string, who: Identity = identity) {
  history.replaceState(null, '', `/?account=${section}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('opens every section in one centre whose navigation marks the open page', async () => {
  server();
  for (const section of SETTINGS_SECTIONS) {
    open(section);
    const nav = await screen.findByRole('navigation', { name: '设置' });
    const current = within(nav).getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page');
    // The hosted site has no 本机 (the local edition's page), and 邀请好友 went with the invite codes: their addresses
    // open 账号安全.
    if (section === 'local' || section === 'invites') expect(current.map(link => link.getAttribute('href'))).toEqual(['/?account=security']);
    // A site that does not offer AwwO 本地版 its models has no 本机版连接: its address opens the engines page.
    else if (section === 'relay') expect(current.map(link => link.getAttribute('href'))).toEqual(['/?account=engines']);
    else expect(current.map(link => link.getAttribute('href'))).toEqual([`/?account=${section}`]);
    expect(screen.queryByText('workspace')).toBeNull();
    cleanup();
  }
});

it('lists 邀请好友 for no account (no invite codes since the public beta), and keeps the old account links working', async () => {
  server();
  open('security');
  const nav = await screen.findByRole('navigation', { name: '设置' });
  expect(await screen.findByRole('heading', { level: 1, name: '账号安全' })).toBeVisible();
  expect(within(nav).queryByRole('link', { name: '邀请好友' })).toBeNull();
  expect(within(nav).getByRole('link', { name: '返回工作区' })).toHaveAttribute('href', '/');
  for (const group of ['账户', '设置', '功能', '工作区', '数据', '关于']) expect(within(nav).getByText(group)).toBeVisible();
  cleanup();
  const clawhunt = { ...identity, authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store' } as Identity;
  open('security', clawhunt);
  expect(within(await screen.findByRole('navigation', { name: '设置' })).queryByRole('link', { name: '邀请好友' })).toBeNull();
  cleanup();
  // An old 邀请好友 link opens 账号安全, for a ClawHunt account too.
  open('invites', clawhunt);
  expect(await screen.findByRole('heading', { level: 1, name: '账号安全' })).toBeVisible();
});

it('shows the platform administration link to platform administrators only', async () => {
  server();
  open('general', { ...identity, user: { ...identity.user, platformRole: 'admin' } } as Identity);
  expect(within(await screen.findByRole('navigation', { name: '设置' })).getByRole('link', { name: '平台管理' })).toHaveAttribute('href', '/admin');
  cleanup();
  open('general');
  expect(within(await screen.findByRole('navigation', { name: '设置' })).queryByRole('link', { name: '平台管理' })).toBeNull();
});

it('switches the interface language from 通用 and keeps it in this browser', async () => {
  server();
  open('general');
  fireEvent.click(await screen.findByRole('radio', { name: 'English' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  expect(localStorage.getItem('superclaw_locale')).toBe('en');
});

it('saves the sound alert to the account with the version it read', async () => {
  const { fetch } = server();
  open('general');
  const sound = await screen.findByRole('checkbox', { name: '声音提醒' });
  expect(sound).not.toBeChecked();
  fireEvent.click(sound);
  await waitFor(() => expect(sound).toBeChecked());
  expect(writes(fetch)).toEqual([{ version: 1, preferences: { ...emptyAccountPreferences(), notifications: { browser: false, sound: true } } }]);
  expect(await screen.findByText('已保存。')).toBeVisible();
});

it('turns browser notifications on only once the browser allows them', async () => {
  const { fetch } = server();
  const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
  vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'default', requestPermission }));
  open('general');
  fireEvent.click(await screen.findByRole('checkbox', { name: '浏览器通知' }));
  await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
  expect(writes(fetch)).toEqual([]);
  expect(screen.getByRole('checkbox', { name: '浏览器通知' })).not.toBeChecked();
});

it('answers a save another tab beat with the stored settings and the reason', async () => {
  const { state, fetch } = server();
  open('general');
  const sound = await screen.findByRole('checkbox', { name: '声音提醒' });
  state.conflictNext = true;
  state.preferences = { ...state.preferences, notifications: { browser: false, sound: false } };
  fireEvent.click(sound);
  expect(await screen.findByRole('alert')).toHaveTextContent('设置刚在别的页面里改过，这里已换成最新的值，请重新选择。');
  await waitFor(() => expect(fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/auth/preferences') && !(init as RequestInit | undefined)?.method).length).toBe(2));
  expect(sound).not.toBeChecked();
});

it('chooses the default model from the selected workspace’s catalogue, and keeps one it does not offer visible', async () => {
  const { fetch } = server({ defaultModel: { runtime: 'pi', model: 'opus' } });
  open('general');
  const select = await screen.findByRole('combobox', { name: '默认模型' });
  await waitFor(() => expect(within(select).getByRole('option', { name: 'Claude Opus' })).toBeInTheDocument());
  expect(select).toHaveValue(JSON.stringify(['pi', 'opus']));
  fireEvent.change(screen.getByRole('combobox', { name: '按这个工作区的模型列表选择' }), { target: { value: 'team-b' } });
  await waitFor(() => expect(within(select).queryByRole('option', { name: 'Claude Opus' })).toBeNull());
  // A model the workspace does not offer is named from its selector, never shown as it is.
  expect(within(select).getByRole('option', { name: 'Opus（这个工作区不提供）' })).toBeInTheDocument();
  expect(new URLSearchParams(location.search).get('tenant')).toBe('team-b');
  fireEvent.change(select, { target: { value: JSON.stringify(['pi', 'qwen']) } });
  await waitFor(() => expect(writes(fetch).at(-1)?.preferences.defaultModel).toEqual({ runtime: 'pi', model: 'qwen' }));
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(writes(fetch).at(-1)?.preferences.defaultModel).toBeNull());
});

it('saves personal instructions, counts characters against the limit and can discard an edit', async () => {
  const { fetch } = server();
  open('personalization');
  const about = await screen.findByRole('textbox', { name: '关于你' });
  const save = screen.getByRole('button', { name: '保存' });
  expect(save).toBeDisabled();
  fireEvent.change(about, { target: { value: '独立开发者' } });
  expect(screen.getByText('5 / 1000')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(about).toHaveValue('');
  fireEvent.click(screen.getByRole('checkbox', { name: '规划画布时参考这些内容' }));
  fireEvent.change(about, { target: { value: '独立开发者' } });
  fireEvent.change(screen.getByRole('textbox', { name: '希望怎样回答' }), { target: { value: '先给结论' } });
  fireEvent.click(save);
  await waitFor(() => expect(writes(fetch)).toHaveLength(1));
  expect(writes(fetch)[0].preferences.personalization).toEqual({ enabled: true, aboutMe: '独立开发者', instructions: '先给结论' });
  await waitFor(() => expect(save).toBeDisabled());
  fireEvent.change(about, { target: { value: '长'.repeat(1001) } });
  expect(save).toBeDisabled();
  expect(screen.getByText('1001 / 1000')).toHaveClass('saas-error');
});

it('requests account deletion only after confirming, and can withdraw it', async () => {
  const { fetch } = server();
  open('data');
  await screen.findByRole('button', { name: '下载 JSON' });
  fireEvent.click(await screen.findByRole('button', { name: '申请删除账号' }));
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/auth/deletion-request') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  expect(screen.getByText('将为 ada@example.test 提交删除申请。')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: '原因（可选）' }), { target: { value: '不再需要' } });
  fireEvent.click(screen.getByRole('button', { name: '确认提交申请' }));
  expect(await screen.findByText('删除申请已提交')).toBeVisible();
  expect(screen.getByText('原因：不再需要')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));
  expect(await screen.findByRole('button', { name: '申请删除账号' })).toBeVisible();
  const posts = fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/auth/deletion-request') && (init as RequestInit | undefined)?.method === 'POST');
  expect(posts.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([{ reason: '不再需要' }]);
});

it('saves the export only when the server sent all of it, and says why otherwise', async () => {
  let reply = () => new Response('{"kind":"awwo.account-export","canvases":[],"complete":true}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/export') ? reply()
    : url.endsWith('/auth/deletion-request') ? json({ request: null }) : json({ preferences: emptyAccountPreferences(), version: 0 })));
  const created = vi.fn(() => 'blob:export');
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  open('data');
  fireEvent.click(await screen.findByRole('button', { name: '下载 JSON' }));
  await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
  expect(created).toHaveBeenCalledTimes(1);
  reply = () => new Response('{"kind":"awwo.account-export","canvases":[{"id":"c"}],"complete":false}', { status: 200 });
  fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('导出没有完整读完，请稍后再试。');
  reply = () => json({ error: { code: 'export_busy', message: 'busy' } }, 429);
  fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已有一份导出正在进行，或这一小时的导出次数已用完，请稍后再试。'));
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(created).toHaveBeenCalledTimes(1);
});

it('lists exactly the canvas’s own shortcut table', async () => {
  server();
  open('shortcuts');
  await screen.findByRole('heading', { level: 1, name: '快捷键' });
  const canvas = screen.getByRole('heading', { level: 2, name: '画布' }).closest('section')!;
  const rows = within(canvas).getAllByRole('row').map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
  expect(rows).toEqual(canvasKeyBindings().map(binding => [binding.label, binding.hint]));
});

it('lists deletion requests for the operator, with an account already gone marked as such', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('/admin/deletions') ? { items: [
    { id: 'd-1', userId: 'user-1', email: 'ada@example.test', name: 'Ada', reason: '不再需要', status: 'pending', createdAt: '2026-10-18T06:00:00Z' },
    { id: 'd-2', userId: null, email: 'bo@example.test', name: 'Bo', reason: '', status: 'withdrawn', createdAt: '2026-10-17T06:00:00Z' },
  ], nextCursor: null } : { items: [], nextCursor: null })));
  const admin = { ...identity, user: { ...identity.user, platformRole: 'admin' } } as Identity;
  render(<SaaSPreferencesProvider><AdminPanel identity={admin} /></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '删除申请' }));
  const pending = (await screen.findByText('ada@example.test')).closest('tr')!;
  expect(within(pending).getAllByRole('cell').map(cell => cell.textContent).slice(0, 4)).toEqual(['Ada', 'ada@example.test', '不再需要', '待处理']);
  const gone = screen.getByText('bo@example.test').closest('tr')!;
  expect(within(gone).getAllByRole('cell').map(cell => cell.textContent).slice(0, 4)).toEqual(['Bo（账号已删除）', 'bo@example.test', '—', '已撤回']);
  expect(screen.getByText(/提交不会删除任何东西/)).toBeVisible();
});

it('lets the operator decline a pending request with a reason, or mark it handled, and shows the outcome', async () => {
  const rows = [
    { id: 'd-1', userId: 'user-1', email: 'ada@example.test', name: 'Ada', reason: '不再需要', status: 'pending', createdAt: '2026-10-18T06:00:00Z', decidedAt: null, decisionNote: '' },
    // The operator already deleted Cy's account by hand: its request keeps the record, without the account.
    { id: 'd-2', userId: null, email: 'cy@example.test', name: 'Cy', reason: '', status: 'pending', createdAt: '2026-10-18T05:00:00Z', decidedAt: null, decisionNote: '' },
  ];
  const patches: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const decided = /\/admin\/deletions\/([^/?]+)$/.exec(url);
    if (decided && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); patches.push({ url, body });
      const row = rows.find(item => item.id === decodeURIComponent(decided[1]))!;
      if (row.status !== 'pending') return json({ error: { code: 'deletion_already_decided', message: 'no longer pending' } }, 409);
      Object.assign(row, { status: body.status, decidedAt: '2026-10-18T14:10:00Z', decisionNote: body.note.trim() });
      return json(row);
    }
    return json(url.includes('/admin/deletions') ? { items: rows.map(row => ({ ...row })), nextCursor: null } : { items: [], nextCursor: null });
  }));
  const admin = { ...identity, user: { ...identity.user, platformRole: 'admin' } } as Identity;
  render(<SaaSPreferencesProvider><AdminPanel identity={admin} /></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '删除申请' }));
  const first = (await screen.findByText('ada@example.test')).closest('tr')!;
  // Ada's account still exists, so her request cannot be marked handled yet.
  expect(within(first).getByRole('button', { name: '标记已处理' })).toBeDisabled();
  expect(within(first).getByRole('button', { name: '标记已处理' })).toHaveAttribute('title', '先人工删除这个账号，才能标记已处理');
  fireEvent.click(within(first).getByRole('button', { name: '拒绝…' }));
  const dialog = await screen.findByRole('dialog', { name: '拒绝这条删除申请？' });
  const confirm = within(dialog).getByRole('button', { name: '确认拒绝' });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole('textbox', { name: '拒绝理由（必填）' }), { target: { value: '工作区仍有付费套餐' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(patches).toEqual([{ url: '/api/v1/admin/deletions/d-1', body: { status: 'declined', note: '工作区仍有付费套餐' } }]);
  const declined = (await screen.findByText('ada@example.test')).closest('tr')!;
  await waitFor(() => expect(within(declined).getByText('已拒绝')).toBeVisible());
  expect(within(declined).queryByRole('button', { name: '拒绝…' })).toBeNull();
  expect(declined).toHaveTextContent('工作区仍有付费套餐');
  const second = screen.getByText('cy@example.test').closest('tr')!;
  expect(second).toHaveTextContent('Cy（账号已删除）');
  // Cy's account is gone, so a decline would be a reason nobody can read.
  expect(within(second).getByRole('button', { name: '拒绝…' })).toBeDisabled();
  expect(within(second).getByRole('button', { name: '拒绝…' })).toHaveAttribute('title', '账号已删除，只能标记已处理');
  fireEvent.click(within(second).getByRole('button', { name: '标记已处理' }));
  const mark = await screen.findByRole('dialog', { name: '标记为已处理？' });
  expect(within(mark).getByText(/不再删除任何东西/)).toBeVisible();
  fireEvent.click(within(mark).getByRole('button', { name: '确认已处理' }));
  await waitFor(() => expect(within(screen.getByText('cy@example.test').closest('tr')!).getByText('已处理')).toBeVisible());
  expect(patches[1]).toEqual({ url: '/api/v1/admin/deletions/d-2', body: { status: 'handled', note: '' } });
});

it.each([
  ['deletion_already_decided', '这条删除申请已经处理过了，列表已刷新。'],
  ['deletion_withdrawn', '对方已经撤回了这条删除申请，列表已刷新。'],
])('says why a request changed meanwhile (%s) and reads the list again', async (code, text) => {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'PATCH'
    ? json({ error: { code, message: 'no longer pending' } }, 409)
    : json(url.includes('/admin/deletions') ? { items: [{ id: 'd-1', userId: 'user-1', email: 'ada@example.test', name: 'Ada', reason: '', status: 'pending', createdAt: '2026-10-18T06:00:00Z', decidedAt: null, decisionNote: '' }], nextCursor: null } : { items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetch);
  const lists = () => fetch.mock.calls.filter(([url, init]) => String(url).includes('/admin/deletions') && !(init as RequestInit | undefined)?.method).length;
  const admin = { ...identity, user: { ...identity.user, platformRole: 'admin' } } as Identity;
  render(<SaaSPreferencesProvider><AdminPanel identity={admin} /></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '删除申请' }));
  fireEvent.click(within((await screen.findByText('ada@example.test')).closest('tr')!).getByRole('button', { name: '拒绝…' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '原因' } });
  const before = lists();
  fireEvent.click(within(dialog).getByRole('button', { name: '确认拒绝' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
  await waitFor(() => expect(lists()).toBeGreaterThan(before));
});

it('shows the account a decline with its reason and lets it ask again', async () => {
  const { state } = server();
  state.request = { id: 'del-1', status: 'declined', reason: '不再需要', createdAt: '2026-10-18T06:00:00Z', decidedAt: '2026-10-18T14:10:00Z', decisionNote: '工作区仍有付费套餐' };
  open('data');
  expect(await screen.findByText('删除申请未通过')).toBeVisible();
  expect(screen.getByText('运营人员的说明：工作区仍有付费套餐')).toBeVisible();
  expect(screen.getByText('如有需要，可以重新提交申请。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '撤回申请' })).toBeNull();
  expect(screen.getByRole('button', { name: '申请删除账号' })).toBeVisible();
});

it('shows the decline when an operator decided the request just before it was withdrawn', async () => {
  const { state } = server();
  state.request = { id: 'del-1', status: 'pending', reason: '不再需要', createdAt: '2026-10-18T06:00:00Z' };
  state.decidedMeanwhile = { ...state.request, status: 'declined', decidedAt: '2026-10-18T14:10:00Z', decisionNote: '工作区仍有付费套餐' };
  open('data');
  fireEvent.click(await screen.findByRole('button', { name: '撤回申请' }));
  expect(await screen.findByText('删除申请未通过')).toBeVisible();
  expect(screen.getByText('运营人员的说明：工作区仍有付费套餐')).toBeVisible();
  expect(screen.queryByRole('button', { name: '撤回申请' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('opens the centre from the workspace menu', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? json({ ...identity, tenants: [tenants[0]] })
    : url.endsWith('/appearance') ? json(appearanceFixture) : json({ items: [] })));
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(await screen.findByRole('link', { name: '设置' })).toHaveAttribute('href', '/?account=general');
});

// On a phone the list is one row that scrolls sideways, centred on the open page's entry. 我的 Agent joins it only once
// the workspace's market answers, which moves every entry after it along: the row is centred again then, and only the
// row scrolls, never the page (2026-11-08: 成员与工作区 sat cut at the row's right edge).
it('centres the open page’s entry in the phone’s row again once 我的 Agent joins it, scrolling only the row', async () => {
  const row = phoneRow();
  const page = pageScrolls();
  try {
    open('about');
    const nav = await screen.findByRole('navigation', { name: '设置' });
    const centre = () => { const entry = within(nav).getByRole('link', { name: '关于 AwwO' }).getBoundingClientRect(); return entry.left + entry.width / 2; };
    await waitFor(() => expect(centre()).toBe(20 + 348 / 2));
    expect(within(nav).queryByRole('link', { name: '我的 Agent' })).toBeNull();
    row.answerMarket();
    expect(await within(nav).findByRole('link', { name: '我的 Agent' })).toBeVisible();
    await waitFor(() => expect(centre()).toBe(20 + 348 / 2));
    page.expectUntouched();
  } finally {
    page.restore();
  }
});

// The scroll position moves only for the person once they have moved it (MOTION.md: what never moves).
it('leaves the phone’s row where the person scrolled it when 我的 Agent joins later', async () => {
  const row = phoneRow();
  const page = pageScrolls();
  try {
    open('about');
    const nav = await screen.findByRole('navigation', { name: '设置' });
    await waitFor(() => expect(nav.scrollLeft).toBeGreaterThan(0));
    nav.scrollLeft = 40;
    row.answerMarket();
    expect(await within(nav).findByRole('link', { name: '我的 Agent' })).toBeVisible();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(nav.scrollLeft).toBe(40);
    page.expectUntouched();
  } finally {
    page.restore();
  }
});

/** A phone's settings row in jsdom, which draws nothing: 348px wide, 20px from the left, its entries 100px apart and
 *  90px wide, moved by its scroll; the workspace's market answers (and 我的 Agent joins the list) when the test says. */
function phoneRow() {
  let answer: (value: Response) => void = () => {};
  const capabilities = new Promise<Response>(resolve => { answer = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => /\/tenants\/team-a\/capabilities$/.test(url) ? capabilities
    : json({ error: { code: 'not_found', message: 'Not found' } }, 404)));
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const list = this.closest<HTMLElement>('.saas-settings-nav');
    if (!list) return rect(0, 0, 0, 0);
    if (this === list) return rect(20, 66, 348, 58);
    const index = [...list.querySelectorAll('a, button')].indexOf(this);
    return index < 0 ? rect(0, 0, 0, 0) : rect(30 + 100 * index - list.scrollLeft, 76, 90, 36);
  });
  return {
    answerMarket: () => answer(json({ skills: { enabled: true }, memory: { enabled: false }, webReader: { enabled: false },
      render: { enabled: false }, market: { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14 } })),
  };
}

// On a wider screen the list is a column that scrolls inside its box when the window is short, and its last lines fade
// while more is below (settings-center.css). An open page whose entry is below the column's view is brought into it
// above the fade: the column's scroll padding keeps that room. Only the column scrolls.
it('brings the open page’s entry into the column’s view above its fade, scrolling only the column', async () => {
  server();
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
  const isList = (element: Element) => element.classList.contains('saas-settings-nav');
  // jsdom draws nothing: a column at 92px with a 1px border and 650px inside it, its entries 60px apart (关于 AwwO the
  // twelfth, below the view), moved by its scroll; its scroll padding as the stylesheet sets it.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const column = this.closest<HTMLElement>('.saas-settings-nav');
    if (!column) return rect(0, 0, 0, 0);
    if (this === column) return rect(120, 92, 232, 652);
    const index = [...column.querySelectorAll('a, button')].indexOf(this);
    return index < 0 ? rect(0, 0, 0, 0) : rect(133, 109 + 60 * index - column.scrollTop, 206, 36);
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return isList(this) ? 650 : 0; });
  vi.spyOn(Element.prototype, 'clientTop', 'get').mockImplementation(function (this: Element) { return isList(this) ? 1 : 0; });
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return isList(this) ? 885 : 0; });
  const style = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const real = style(element, pseudo);
    if (!isList(element) || pseudo) return real;
    return new Proxy(real, { get: (target, name) => {
      if (name === 'scrollPaddingBottom') return '48px';
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const page = pageScrolls();
  try {
    const view = open('about');
    const nav = await screen.findByRole('navigation', { name: '设置' });
    const entry = (name: string) => within(nav).getByRole('link', { name }).getBoundingClientRect();
    // Its view ends 48px above the inside of the column's bottom edge: 92 + 1 + 650 - 48.
    await waitFor(() => expect(entry('关于 AwwO').bottom).toBe(695));
    // Another page opened in the list scrolled down: its entry, now above the view, comes to the view's top (92 + 1).
    const again = () => view.rerender(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}>
      <PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
    history.replaceState(null, '', '/?account=security');
    again();
    await waitFor(() => expect(entry('账号安全').top).toBe(93));
    // One already in view leaves the column where it is.
    const scrolled = nav.scrollTop;
    history.replaceState(null, '', '/?account=general');
    again();
    await waitFor(() => expect(within(nav).getByRole('link', { name: '通用' })).toHaveAttribute('aria-current', 'page'));
    expect(nav.scrollTop).toBe(scrolled);
    page.expectUntouched();
  } finally {
    page.restore();
  }
});

/** What would scroll the page rather than the list: an element's scrollIntoView (jsdom has none, so it is stubbed
 *  here), the window's own scrolls, and the document's scroll offsets. */
function pageScrolls() {
  const intoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: intoView });
  const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  return {
    expectUntouched() {
      expect(intoView).not.toHaveBeenCalled();
      expect(to).not.toHaveBeenCalled();
      expect(by).not.toHaveBeenCalled();
      expect([document.documentElement.scrollTop, document.body.scrollTop, document.documentElement.scrollLeft]).toEqual([0, 0, 0]);
    },
    restore() { delete (Element.prototype as Partial<Element>).scrollIntoView; },
  };
}

it('reads what the server stored, and every missing or malformed part as its default', () => {
  expect(readAccountPreferences(null)).toEqual(emptyAccountPreferences());
  expect(readAccountPreferences({ notifications: { browser: 'yes', sound: true }, personalization: { enabled: true, aboutMe: 3 }, defaultModel: { runtime: 'pi' } }))
    .toEqual({ ...emptyAccountPreferences(), notifications: { browser: false, sound: true }, personalization: { enabled: true, aboutMe: '', instructions: '' } });
});
