import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    if (section === 'invites') expect(current).toHaveLength(0); // A local account has no 邀请好友 page in the list.
    else expect(current.map(link => link.getAttribute('href'))).toEqual([`/?account=${section}`]);
    expect(screen.queryByText('workspace')).toBeNull();
    cleanup();
  }
});

it('lists 邀请好友 for a ClawHunt account only, and keeps the old account links working', async () => {
  server();
  open('security');
  const nav = await screen.findByRole('navigation', { name: '设置' });
  expect(await screen.findByRole('heading', { level: 1, name: '账号安全' })).toBeVisible();
  expect(within(nav).queryByRole('link', { name: '邀请好友' })).toBeNull();
  expect(within(nav).getByRole('link', { name: '返回工作区' })).toHaveAttribute('href', '/');
  for (const group of ['账户', '设置', '功能', '工作区', '数据', '关于']) expect(within(nav).getByText(group)).toBeVisible();
  cleanup();
  open('security', { ...identity, authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store' } as Identity);
  expect(within(await screen.findByRole('navigation', { name: '设置' })).getByRole('link', { name: '邀请好友' })).toHaveAttribute('href', '/?account=invites');
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
  expect(within(select).getByRole('option', { name: 'opus（这个工作区不提供）' })).toBeInTheDocument();
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

it('reads what the server stored, and every missing or malformed part as its default', () => {
  expect(readAccountPreferences(null)).toEqual(emptyAccountPreferences());
  expect(readAccountPreferences({ notifications: { browser: 'yes', sound: true }, personalization: { enabled: true, aboutMe: 3 }, defaultModel: { runtime: 'pi' } }))
    .toEqual({ ...emptyAccountPreferences(), notifications: { browser: false, sound: true }, personalization: { enabled: true, aboutMe: '', instructions: '' } });
});
