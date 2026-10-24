import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectionSettings, PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider } from '../src/saas/accountPreferences';
import { linkCode, rememberPendingLink, restorePendingLink, PENDING_LINK_KEY } from '../src/saas/pendingLink';
import type { Identity } from '../src/saas/api';

// The cloud relay's two pages (docs/awwo-cloud-relay.md): AwwO 本地版's 「AwwO 线上」 card in 我的引擎, and the hosted
// site's 设置 → 本机连接, where the person approves the code the local edition shows.

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const awwo = { id: 'awwo', name: 'AwwO 线上 · 经云端调用 Bedrock', runtimes: ['openai-agents', 'pi'], link: true };
const gate = { id: 'llmgate', name: 'LLM Gate · ClawHunt', runtimes: ['openai-agents', 'pi'] };
const catalog = (items: unknown[] = []) => ({ items, providers: [awwo, gate], required: true, purchaseURL: 'https://api.clawhunt.site/' });
const relayConnection = (runtime: string, id: string) => ({ id, name: 'AwwO 线上 · 我的工作区', provider: 'awwo', runtime, models: ['bedrock.claude-opus-5-5'], hasKey: true,
  relay: { workspace: { id: 'tenant-1', name: '我的工作区' }, expiresAt: '2027-01-22T12:00:00Z' } });

beforeEach(() => {
  localStorage.setItem('superclaw_locale', 'zh');
  history.replaceState(null, '', '/?account=engines');
  sessionStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

function engines(initial = catalog()) {
  let current = initial;
  const onChange = vi.fn((next) => { current = next; });
  const view = render(<SaaSPreferencesProvider><ConnectionSettings catalog={initial} onChange={onChange} onboarding={initial.items.length === 0} /></SaaSPreferencesProvider>);
  return { ...view, onChange, current: () => current };
}

it('leads 我的引擎 with 「AwwO 线上」 and keeps it out of the key form', () => {
  engines();
  expect(screen.getByRole('heading', { name: '使用 AwwO 线上账号' })).toBeVisible();
  const provider = screen.getByRole('combobox', { name: '模型服务' });
  expect(within(provider).getAllByRole('option').map(option => option.textContent)).toEqual(['LLM Gate · ClawHunt']);
  expect(screen.getByRole('button', { name: '连接线上账号' })).toBeEnabled();
});

it('connects the online account with the code the hosted site approves, asking at its interval', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const polls: string[] = ['pending', 'connected'];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/cloud-link') && init?.method === 'POST') return json({ userCode: 'KQ7M-3XHD', verificationURL: 'https://awwo.clawhunt.store/?link=KQ7M-3XHD', expiresAt: '2026-10-24T13:00:00Z', interval: 5 }, 201);
    if (url.endsWith('/auth/cloud-link/poll')) {
      const status = polls.shift();
      return json(status === 'connected' ? { status, workspace: { id: 'tenant-1', name: '我的工作区' }, expiresAt: '2027-01-22T12:00:00Z', models: 1 } : { status });
    }
    if (url.endsWith('/auth/connections')) return json(catalog([relayConnection('openai-agents', 'c1'), relayConnection('pi', 'c2')]));
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  const view = engines();
  fireEvent.click(screen.getByRole('button', { name: '连接线上账号' }));
  expect(await screen.findByLabelText('确认码')).toHaveTextContent('KQ7M-3XHD');
  const open = screen.getByRole('link', { name: /在浏览器中打开确认页/ });
  expect(open).toHaveAttribute('href', 'https://awwo.clawhunt.store/?link=KQ7M-3XHD');
  expect(open).toHaveAttribute('target', '_blank');
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/poll'))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/poll'))).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await screen.findByText('已连接，工作区「我的工作区」的 1 个模型可以用了。')).toBeVisible();
  await waitFor(() => expect(view.onChange).toHaveBeenCalled());
  expect(view.current().items).toHaveLength(2);
});

it('says when the hosted site declined the code or it expired, and leaves a way to connect again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let answer = 'denied';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/cloud-link') && init?.method === 'POST') return json({ userCode: 'KQ7M-3XHD', verificationURL: 'https://awwo.clawhunt.store/?link=KQ7M-3XHD', expiresAt: '2026-10-24T13:00:00Z', interval: 1 }, 201);
    if (url.endsWith('/auth/cloud-link/poll')) return json({ status: answer });
    return json({ error: { code: 'not_found' } }, 404);
  }));
  engines();
  fireEvent.click(screen.getByRole('button', { name: '连接线上账号' }));
  await screen.findByLabelText('确认码');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await screen.findByText('你在线上拒绝了这次连接。')).toBeVisible();
  answer = 'expired';
  fireEvent.click(screen.getByRole('button', { name: '连接线上账号' }));
  await screen.findByLabelText('确认码');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await screen.findByText('确认码已过期，请重新连接。')).toBeVisible();
});

it('waits out a moment\'s trouble reaching AwwO online while the code lasts, and stops at a refusal', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const answers: Array<() => Response> = [
    () => json({ error: { code: 'cloud_unreachable', message: 'x' } }, 502),
    () => json({ status: 'pending' }),
    () => json({ error: { code: 'no_cloud_link', message: 'x' } }, 404),
  ];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/cloud-link') && init?.method === 'POST') return json({ userCode: 'KQ7M-3XHD', verificationURL: 'https://awwo.clawhunt.store/?link=KQ7M-3XHD', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), interval: 1 }, 201);
    if (url.endsWith('/auth/cloud-link/poll')) return answers.shift()!();
    return json({ error: { code: 'not_found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  engines();
  fireEvent.click(screen.getByRole('button', { name: '连接线上账号' }));
  await screen.findByLabelText('确认码');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await screen.findByText('暂时连不上 AwwO 线上，正在重试…')).toBeVisible();
  expect(screen.getByLabelText('确认码')).toHaveTextContent('KQ7M-3XHD');
  await vi.advanceTimersByTimeAsync(2000);
  expect(await screen.findByText('正在等待确认…')).toBeVisible();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await screen.findByRole('alert')).toHaveTextContent('没有等待中的连接');
  expect(screen.queryByLabelText('确认码')).toBeNull();
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/poll'))).toHaveLength(3);
});

it('names why a link could not start: the hosted site out of reach, or not taking links yet', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'cloud_link_unavailable', message: 'x' } }, 503)));
  engines();
  fireEvent.click(screen.getByRole('button', { name: '连接线上账号' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('AwwO 线上暂未开放本地版连接');
});

it('shows a linked engine\'s workspace and end, and disconnects both engines and the link together', async () => {
  const items = [relayConnection('openai-agents', 'c1'), relayConnection('pi', 'c2')];
  const deletes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { deletes.push(url); return json(null, 204); }
    if (url.endsWith('/auth/connections')) return json(catalog([]));
    return json({ error: { code: 'not_found' } }, 404);
  }));
  engines(catalog(items));
  expect(screen.getByRole('heading', { name: '已连接 AwwO 线上' })).toBeVisible();
  expect(screen.getByRole('button', { name: '重新连接' })).toBeVisible();
  expect(screen.getAllByText(/已连接线上工作区「我的工作区」/)).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: '移除连接' })[0]);
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('两个执行引擎都会断开');
  fireEvent.click(within(dialog).getByRole('button', { name: '确认移除' }));
  await waitFor(() => expect(deletes).toEqual(['/api/v1/auth/connections/c1']));
});

const waitingFor = (extra: Record<string, unknown> = {}) => ({ userCode: 'KQ7M-3XHD', deviceName: 'AwwO 本地版 · Mac', createdAt: '2026-10-24T12:00:00Z', expiresAt: '2026-10-24T12:15:00Z',
  requestIP: '203.0.113.5', yourIP: '203.0.113.5', sameNetwork: true, signInAgain: false, ...extra });
const hosted = { user: { id: 'user-a', name: 'A', email: 'a@example.test', platformRole: 'user' }, personalCredentialsRequired: false, edition: 'hosted', localRelay: true,
  tenants: [{ id: 'tenant-1', name: '工作区一', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 },
    { id: 'tenant-2', name: '只读的', status: 'active', role: 'reader', maxConcurrentRuns: 2, maxRunsPerDay: 100 },
    { id: 'tenant-3', name: '工作区三', status: 'active', role: 'member', maxConcurrentRuns: 2, maxRunsPerDay: 100 }] } as Identity;

function links(who: Identity = hosted, search = '') {
  history.replaceState(null, '', `/?account=links${search}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

it('lists 本机连接 where the hosted site takes local links, and approves a code for a workspace its person may spend', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const posted: unknown[] = [];
  let linked: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/local-links/pending/KQ7M-3XHD')) return json(waitingFor());
    if (url.endsWith('/local-links/approve')) {
      posted.push(JSON.parse(String(init?.body)));
      linked = [{ id: 'l1', status: 'approved', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-3', name: '工作区三' }, createdAt: '2026-10-24T12:00:00Z', lastUsedAt: null, expiresAt: null }];
      return json({ id: 'l1', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-3', name: '工作区三' } });
    }
    if (url.endsWith('/local-links')) return json({ items: linked });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }));
  links(hosted, '&code=kq7m3xhd');
  const nav = await screen.findByRole('navigation', { name: '设置' });
  expect(within(nav).getByRole('link', { name: '本机连接' })).toHaveAttribute('aria-current', 'page');
  const request = await screen.findByRole('group', { name: '等待确认的连接' });
  expect(request).toHaveTextContent('AwwO 本地版 · Mac');
  const workspace = within(request).getByRole('combobox', { name: '次数和点数计入的工作区' });
  expect(within(workspace).getAllByRole('option').map(option => option.textContent)).toEqual(['工作区一', '工作区三']);
  fireEvent.change(workspace, { target: { value: 'tenant-3' } });
  // The person sees where the request came from beside where they are, and confirms the code is their own computer's.
  expect(request).toHaveTextContent('名称由发起请求的设备自己报告。');
  expect(request).toHaveTextContent('发起请求的网络：203.0.113.5 · 你现在的网络：203.0.113.5');
  expect(within(request).queryByText(/不是从你现在的网络发起的/)).toBeNull();
  const approve = within(request).getByRole('button', { name: '确认连接' });
  expect(approve).toBeDisabled();
  fireEvent.click(within(request).getByRole('checkbox', { name: '确认码 KQ7M-3XHD 就显示在我自己的电脑上，是我刚刚发起的连接' }));
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  expect(await screen.findByText('已连接。回到 AwwO 本地版，几秒内就会显示已连接。')).toBeVisible();
  expect(posted).toEqual([{ userCode: 'KQ7M-3XHD', tenantId: 'tenant-3', confirmed: true }]);
  expect(new URLSearchParams(location.search).has('code')).toBe(false);
  // Listed at once, approved; read again until its computer has taken its token.
  expect(await screen.findByText(/已确认，等待这台电脑完成连接/)).toBeVisible();
  linked = [{ id: 'l1', status: 'issued', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-3', name: '工作区三' }, createdAt: '2026-10-24T12:00:00Z', lastUsedAt: null, expiresAt: '2027-01-22T12:00:00Z' }];
  await vi.advanceTimersByTimeAsync(5000);
  expect(await screen.findByText(/尚未使用/)).toBeVisible();
  expect(screen.queryByText(/已确认，等待这台电脑完成连接/)).toBeNull();
});

it('warns of a request from another network, and has an old session sign in again with the code kept', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/local-links/pending/KQ7M-3XHD')) return json(waitingFor({ requestIP: '198.51.100.7', sameNetwork: false, signInAgain: true }));
    if (url.endsWith('/auth/logout')) return json(null, 204);
    if (url.endsWith('/local-links')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  links({ ...hosted, authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.example/' }, '&code=KQ7M-3XHD');
  const request = await screen.findByRole('group', { name: '等待确认的连接' });
  expect(within(request).getByText(/这个请求不是从你现在的网络发起的/)).toBeVisible();
  expect(within(request).queryByRole('button', { name: '确认连接' })).toBeNull();
  fireEvent.click(within(request).getByRole('button', { name: '重新登录后确认' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/logout'))).toHaveLength(1));
  expect(JSON.parse(sessionStorage.getItem(PENDING_LINK_KEY)!).code).toBe('KQ7M-3XHD');
  // Without the main site's sign-out address the page says so rather than claim a sign-out (signOut.ts).
  expect(await screen.findByText(/无法确认 ClawHunt 主站退出/)).toBeVisible();
});

it('turns to signing in again when the session aged past the window since the code was looked up', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/local-links/pending/KQ7M-3XHD')) return json(waitingFor());
    if (url.endsWith('/local-links/approve')) return json({ error: { code: 'sign_in_again', message: 'x' } }, 403);
    if (url.endsWith('/local-links')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }));
  links(hosted, '&code=KQ7M-3XHD');
  const request = await screen.findByRole('group', { name: '等待确认的连接' });
  fireEvent.click(within(request).getByRole('checkbox'));
  fireEvent.click(within(request).getByRole('button', { name: '确认连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('为保护你的账号，确认连接前需要重新登录。');
  expect(within(request).getByRole('button', { name: '重新登录后确认' })).toBeEnabled();
});

it('disconnects every computer at once', async () => {
  const deletes: string[] = [];
  let linked = [
    { id: 'l1', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-1', name: '工作区一' }, createdAt: '2026-10-20T12:00:00Z', lastUsedAt: null, expiresAt: '2027-01-18T12:00:00Z' },
    { id: 'l2', deviceName: 'AwwO 本地版 · Windows', workspace: { id: 'tenant-3', name: '工作区三' }, createdAt: '2026-10-21T12:00:00Z', lastUsedAt: null, expiresAt: '2027-01-19T12:00:00Z' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { deletes.push(url); linked = []; return json(null, 204); }
    if (url.endsWith('/local-links')) return json({ items: linked });
    return json({ error: { code: 'not_found' } }, 404);
  }));
  links(hosted);
  await screen.findByText('AwwO 本地版 · Windows');
  fireEvent.click(screen.getByRole('button', { name: '断开所有电脑' }));
  await waitFor(() => expect(deletes).toEqual(['/api/v1/local-links']));
  expect(await screen.findByText('还没有电脑连接到这个账号。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '断开所有电脑' })).toBeNull();
});

it('says a code that waits for nothing is gone, and disconnects a computer', async () => {
  const deletes: string[] = [];
  let linked = [{ id: 'l1', deviceName: 'AwwO 本地版 · Windows', workspace: { id: 'tenant-1', name: '工作区一' }, createdAt: '2026-10-20T12:00:00Z', lastUsedAt: '2026-10-24T11:00:00Z', expiresAt: '2027-01-18T12:00:00Z' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/local-links/pending/')) return json({ error: { code: 'link_not_found', message: 'x' } }, 404);
    if (init?.method === 'DELETE') { deletes.push(url); linked = []; return json(null, 204); }
    if (url.endsWith('/local-links')) return json({ items: linked });
    return json({ error: { code: 'not_found' } }, 404);
  }));
  links(hosted, '&code=BCDF-GHJK');
  expect(await screen.findByRole('alert')).toHaveTextContent('没有找到等待确认的连接');
  const item = (await screen.findByText('AwwO 本地版 · Windows')).closest('li')!;
  fireEvent.click(within(item).getByRole('button', { name: '断开' }));
  await waitFor(() => expect(deletes).toEqual(['/api/v1/local-links/l1']));
  expect(await screen.findByText('还没有电脑连接到这个账号。')).toBeVisible();
});

it('reads a code typed any way, and keeps a code across a sign-in for one plain landing', () => {
  expect(linkCode('kq7m 3xhd')).toBe('KQ7M-3XHD');
  expect(linkCode('KQ7M-3XH')).toBe('');
  expect(linkCode('KQ0M-3XHD')).toBe('', 'no 0: it reads like O');
  rememberPendingLink('kq7m-3xhd', 1000);
  expect(JSON.parse(sessionStorage.getItem(PENDING_LINK_KEY)!).code).toBe('KQ7M-3XHD');
  history.replaceState(null, '', '/?canvas=x');
  restorePendingLink(2000);
  expect(location.search).toBe('?canvas=x', 'an address chosen on purpose stays');
  history.replaceState(null, '', '/');
  restorePendingLink(2000);
  expect(location.search).toBe('?account=links&code=KQ7M-3XHD');
  history.replaceState(null, '', '/');
  restorePendingLink(3000);
  expect(location.search).toBe('', 'restored once');
  rememberPendingLink('KQ7M-3XHD', 0);
  restorePendingLink(16 * 60_000);
  expect(location.search).toBe('', 'a code past its 15 minutes is dropped');
  history.replaceState(null, '', '/?link=BCDF-GHJK');
  restorePendingLink(0);
  expect(location.search).toBe('?account=links&code=BCDF-GHJK', 'a signed-in address that names a code opens it at once');
});

it('shows the latest read of the connected computers, a slow earlier answer never over it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const approved = { id: 'l1', status: 'approved', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-1', name: '工作区一' }, createdAt: '2026-10-24T12:00:00Z', lastUsedAt: null, expiresAt: null };
  const issued = { ...approved, status: 'issued', expiresAt: '2027-01-22T12:00:00Z' };
  let reads = 0;
  let late: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/local-links/pending/KQ7M-3XHD')) return json(waitingFor());
    if (url.endsWith('/local-links/approve')) return json({ id: 'l1', deviceName: 'AwwO 本地版 · Mac', workspace: { id: 'tenant-1', name: '工作区一' } });
    if (url.endsWith('/local-links')) {
      reads++;
      if (reads === 1) return json({ items: [] });
      // The read right after the approval answers late, and as it stood then.
      if (reads === 2) return new Promise<Response>(resolve => { late = resolve; });
      return json({ items: [issued] });
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }));
  links(hosted, '&code=KQ7M-3XHD');
  const request = await screen.findByRole('group', { name: '等待确认的连接' });
  fireEvent.click(within(request).getByRole('checkbox'));
  fireEvent.click(within(request).getByRole('button', { name: '确认连接' }));
  await screen.findByText('已连接。回到 AwwO 本地版，几秒内就会显示已连接。');
  await vi.advanceTimersByTimeAsync(5000);
  expect(await screen.findByText(/尚未使用/)).toBeVisible();
  late(json({ items: [approved] }));
  await vi.advanceTimersByTimeAsync(100);
  expect(screen.queryByText(/已确认，等待这台电脑完成连接/)).toBeNull();
  expect(screen.getByText(/尚未使用/)).toBeVisible();
});
