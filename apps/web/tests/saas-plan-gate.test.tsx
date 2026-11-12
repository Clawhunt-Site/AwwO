// The gate of a workspace the free trial's end has closed (PlanGate.tsx; owner 2026-11-12: 「确保现在没有付费的用户使用不了
// 任何awwo的功能」, and, asked how far: locked completely, only the plans page left). It reads the workspace's usage
// answer before anything else is drawn; where that says the trial has ended the page is the plans and nothing else,
// and the moment a plan lands it is the app again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlanGate, gateSkipped, shownTenant, LOCKED_POLL_MS } from '../src/saas/PlanGate';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { WallAccountData } from '../src/saas/settings/data';
import { ROUTE_USAGE_CHANGED } from '../src/saas/routeUsage';
import type { Identity, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'team-a', name: 'Team A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const other: Tenant = { id: 'team-b', name: 'Team B', role: 'member', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [tenant], authentication: 'clawhunt' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const catalog = [
  { id: 'pro', priceUsd: 20, credits: 2000, dailyCalls: 300, concurrentAgents: 3, workspaces: 3, mediaPerDay: 30 },
  { id: 'max', priceUsd: 100, credits: 10000, dailyCalls: 1000, concurrentAgents: 6, workspaces: 10, mediaPerDay: 100 },
  { id: 'ultra', priceUsd: 299, credits: 29900, dailyCalls: 3000, concurrentAgents: 12, workspaces: 30, mediaPerDay: 300 },
];
const billing = { catalog, checkoutEnabled: true, plan: null, credits: null, stale: false, freePlan: { until: '2026-11-12T16:00:00Z', ended: true } };
const ended = { limited: true, interested: false, daily: { limit: 100, used: 0 }, routes: {}, freePlan: { until: '2026-11-12T16:00:00Z', ended: true } };
const open = { limited: false, interested: false, daily: { limit: 300, used: 0 }, plan: { id: 'pro', owner: true, credits: { granted: 2000, spent: 0, remaining: 2000 } } };

/** The server: `usage()` answers GET route-usage each time it is asked (a Response, or a value to send as JSON). */
function server(usage: () => unknown) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    calls.push((init.method && init.method !== 'GET' ? init.method + ' ' : '') + url.pathname);
    if (url.pathname.endsWith('/route-usage')) { const answer = usage(); return answer instanceof Response ? answer : json(answer); }
    if (url.pathname.endsWith('/billing')) return json(billing);
    if (url.pathname.endsWith('/auth/deletion-request')) return json({ request: null });
    if (url.pathname.endsWith('/leave')) return new Response(null, { status: 204 });
    return json({ items: [] });
  }));
  return calls;
}
const gate = (who: Identity = identity) => render(<SaaSPreferencesProvider><PlanGate identity={who}><p>the app</p></PlanGate></SaaSPreferencesProvider>);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the workspace a page is about', () => {
  it('is the address’s, else the first active one, and none for an address that names another’s', () => {
    const suspended: Tenant = { ...tenant, id: 'team-s', status: 'suspended' };
    const who = { ...identity, tenants: [suspended, tenant, other] };
    expect(shownTenant(who, '')?.id).toBe('team-a');
    expect(shownTenant(who, '?tenant=team-b')?.id).toBe('team-b');
    expect(shownTenant(who, '?tenant=someone-elses')).toBeUndefined();
    expect(shownTenant({ ...identity, tenants: [suspended] }, '')?.id).toBe('team-s');
    expect(shownTenant({ ...identity, tenants: [] }, '')).toBeUndefined();
  });
});

describe('a workspace the trial’s end has closed', () => {
  it('shows the plans and nothing of the app, to its owner', async () => {
    const calls = server(() => ended);
    gate();
    // Nothing of the app is drawn while the answer is on its way, and nothing after it.
    expect(screen.queryByText('the app')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' })).toBeVisible();
    expect(screen.queryByText('the app')).toBeNull();
    expect(screen.getByText('选一个套餐就能继续。你的画布和成果都保留着，订阅成功后立刻恢复使用。')).toBeVisible();
    expect(screen.getByText('当前账号：ada@example.test')).toBeVisible();
    // The three plans to buy, and the way out.
    for (const name of ['立即开通 Pro', '立即开通 Max', '立即开通 Ultra']) expect(await screen.findByRole('button', { name })).toBeEnabled();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
    // One workspace: nothing to switch to. No link leads back into the app.
    expect(screen.queryByRole('combobox', { name: '切换工作区' })).toBeNull();
    expect(document.querySelector('[data-plan-wall] a[href="/"]')).toBeNull();
    expect(calls.filter(path => path.endsWith('/route-usage'))).toHaveLength(1);
  });

  it('tells a member that the owner subscribes, and lets them switch to another workspace', async () => {
    server(() => ended);
    window.history.replaceState({}, '', '/?tenant=team-b');
    gate({ ...identity, tenants: [tenant, other] });
    expect(await screen.findByRole('heading', { level: 1, name: '这个工作区的免费试用已结束' })).toBeVisible();
    expect(screen.getByText(/「Team B」的所有者订阅 Pro、Max 或 Ultra 后，这个工作区恢复使用/)).toBeVisible();
    const switcher = screen.getByRole('combobox', { name: '切换工作区' }) as HTMLSelectElement;
    expect(switcher.value).toBe('team-b');
    expect([...switcher.options].map(option => option.textContent)).toEqual(['Team A', 'Team B']);
  });

  it('reads in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    server(() => ended);
    gate();
    expect(await screen.findByRole('heading', { level: 1, name: 'The free trial has ended. Subscribe to keep using AwwO' })).toBeVisible();
    expect(screen.getByText('Signed in as ada@example.test')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  it('is closed too where the server refuses the usage answer itself with the trial’s end', async () => {
    server(() => json({ error: { code: 'free_plan_ended', message: 'The free trial has ended' } }, 402));
    gate();
    expect(await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' })).toBeVisible();
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('opens the moment a plan lands: the page says so, the gate reads again, and the app is there', async () => {
    let usage: unknown = ended;
    const calls = server(() => usage);
    gate();
    await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' });
    usage = open;
    act(() => { window.dispatchEvent(new Event(ROUTE_USAGE_CHANGED)); });
    expect(await screen.findByText('the app')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(calls.filter(path => path.endsWith('/route-usage'))).toHaveLength(2);
  });

  it('asks again by itself while it is closed, so a plan bought elsewhere opens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let usage: unknown = ended;
    const calls = server(() => usage);
    gate();
    await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' });
    usage = open;
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCKED_POLL_MS + 50); });
    expect(await screen.findByText('the app')).toBeVisible();
    expect(calls.filter(path => path.endsWith('/route-usage')).length).toBeGreaterThanOrEqual(2);
  });

  it('goes on asking after a read that failed, and stays closed meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let usage: unknown = ended;
    const calls = server(() => usage);
    const asked = () => calls.filter(path => path.endsWith('/route-usage')).length;
    gate();
    const heading = { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' } as const;
    await screen.findByRole('heading', heading);
    // The API is away for one read (a release, the network): the page is still the plans, and it asks again.
    usage = json({ error: { code: 'internal', message: 'boom' } }, 500);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCKED_POLL_MS + 50); });
    await waitFor(() => expect(asked()).toBe(2));
    expect(screen.getByRole('heading', heading)).toBeVisible();
    expect(screen.queryByText('the app')).toBeNull();
    usage = open;
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCKED_POLL_MS + 50); });
    expect(await screen.findByText('the app')).toBeVisible();
    expect(asked()).toBe(3);
  });

  it('asks nothing while nobody is looking at the page, and reads the moment it is looked at again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let usage: unknown = ended;
    const calls = server(() => usage);
    const asked = () => calls.filter(path => path.endsWith('/route-usage')).length;
    gate();
    await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    usage = open;
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LOCKED_POLL_MS + 50); });
    expect(asked()).toBe(1);
    expect(screen.queryByText('the app')).toBeNull();
    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('the app')).toBeVisible();
    expect(asked()).toBe(2);
  });

  it('leaves the payment page’s answer in the address, for the plans page the app opens once the plan lands', async () => {
    window.history.replaceState({}, '', '/?account=plans&billing=success');
    server(() => ended);
    gate();
    await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' });
    await screen.findByRole('heading', { name: /Pro/ });
    expect(new URLSearchParams(window.location.search).get('billing')).toBe('success');
  });

  it('names a suspended workspace as one in the switch', async () => {
    server(() => ended);
    gate({ ...identity, tenants: [tenant, { ...other, status: 'suspended' }] });
    await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' });
    expect(screen.getByRole('option', { name: 'Team B（已暂停）' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team A' })).toBeInTheDocument();
  });
});

describe('the account’s own actions on the closed workspace’s page', () => {
  const heading = { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' } as const;

  it('are closed until asked for, and ask for nothing until then', async () => {
    const calls = server(() => ended);
    gate();
    await screen.findByRole('heading', heading);
    const summary = screen.getByText('账号与数据：导出数据、申请删除账号');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('button', { name: '下载 JSON' })).toBeNull();
    expect(calls.some(path => path.endsWith('/auth/deletion-request'))).toBe(false);
    // Opened: the export and the deletion request, the account's own; the owner is offered no leaving.
    const details = summary.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(await screen.findByRole('button', { name: '下载 JSON' })).toBeEnabled();
    expect(await screen.findByRole('button', { name: '申请删除账号' })).toBeEnabled();
    expect(screen.getByText(/试用已结束的工作区里的画布不在其中，订阅后才能导出/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '退出工作区' })).toBeNull();
    // Nothing of the closed workspace was asked for: its usage answer alone.
    expect(calls.filter(path => path.includes('/tenants/')).every(path => path.endsWith('/route-usage'))).toBe(true);
  });

  it('let a member leave the workspace, asked twice, by the account’s own route', async () => {
    const calls = server(() => ended);
    const left = vi.fn();
    render(<SaaSPreferencesProvider><WallAccountData identity={{ ...identity, tenants: [tenant, other] }} tenant={other} leave={left} /></SaaSPreferencesProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '退出工作区' }));
    expect(calls.some(path => path.endsWith('/leave'))).toBe(false);
    // Cancelled: nothing sent. Asked again and confirmed: the one POST, then the page moves on.
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '退出工作区' }));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    await waitFor(() => expect(left).toHaveBeenCalledTimes(1));
    expect(calls.filter(path => path.startsWith('POST '))).toEqual(['POST /api/v1/tenants/team-b/leave']);
  });

  it('say why where leaving is refused, and stay', async () => {
    server(() => ended);
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => String(input).endsWith('/leave')
      ? json({ error: { code: 'owner_cannot_leave', message: 'The owner cannot leave' } }, 409) : json({ request: null }));
    const left = vi.fn();
    render(<SaaSPreferencesProvider><WallAccountData identity={identity} tenant={other} leave={left} /></SaaSPreferencesProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '退出工作区' }));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(left).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认退出' })).toBeEnabled();
  });
});

describe('a workspace that is open', () => {
  it('is the app, with no word of plans', async () => {
    server(() => open);
    gate();
    expect(await screen.findByText('the app')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('is drawn at once on a later page of the same tab, and closed when the answer says so', async () => {
    let usage: unknown = open;
    server(() => usage);
    const first = gate();
    await screen.findByText('the app');
    first.unmount();
    // The next page of this tab: the app at once, before the answer; this time the answer says the trial has ended.
    usage = ended;
    gate();
    expect(screen.getByText('the app')).toBeVisible();
    expect(await screen.findByRole('heading', { level: 1, name: '免费试用已结束，订阅后继续使用 AwwO' })).toBeVisible();
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('opens where the answer cannot be read: the server refuses what a closed workspace may not do', async () => {
    server(() => json({ error: { code: 'internal', message: 'boom' } }, 500));
    gate();
    expect(await screen.findByText('the app')).toBeVisible();
  });
});

describe('pages the gate never covers', () => {
  it('are the local edition, no workspace, a suspended one, the operator’s console and an invitation', async () => {
    expect(gateSkipped(identity, tenant, '/', '')).toBe(false);
    expect(gateSkipped(identity, tenant, '/', '?canvas=c1')).toBe(false);
    expect(gateSkipped(identity, tenant, '/', '?account=plans')).toBe(false);
    expect(gateSkipped(identity, undefined, '/', '')).toBe(true);
    expect(gateSkipped(identity, { ...tenant, status: 'suspended' }, '/', '')).toBe(true);
    expect(gateSkipped(identity, tenant, '/admin', '')).toBe(true);
    expect(gateSkipped(identity, tenant, '/', '?invite=token')).toBe(true);
    expect(gateSkipped({ ...identity, edition: 'local' } as Identity, tenant, '/', '')).toBe(true);
    // And they ask the server nothing.
    const calls = server(() => ended);
    window.history.replaceState({}, '', '/?invite=token');
    gate();
    expect(screen.getByText('the app')).toBeVisible();
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});
