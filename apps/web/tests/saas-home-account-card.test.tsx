// The home's account card (home/HomeAccountCard.tsx): who is signed in, the workspace's plan as route-usage says it (a
// paid owner's, a paid member's, one set to end, few credits left, the free trial, its end, the free plan), the meter it
// carries for the whole page, and its way to the plans page. Never GET /billing, and nothing at all in the local edition.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HomeShell } from '../src/saas/home/HomeShell';
import { initials } from '../src/saas/home/HomeAccountCard';
import { lowCredits, planView } from '../src/saas/home/accountPlan';
import { LocalEdition } from '../src/saas/edition';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity, Tenant } from '../src/saas/api';
import type { RouteUsage } from '../src/saas/routeUsage';

const tenant: Tenant = { id: 'team-c', name: 'Team C', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-c', name: 'Hana Ito', email: 'hana.ito.with.a.long.address@example.test', platformRole: 'user' }, tenants: [tenant], authentication: 'clawhunt' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const free = (extra: Partial<RouteUsage> = {}): RouteUsage => ({ limited: true, interested: false, daily: { limit: 30, used: 2 }, routes: {}, ...extra });
const paid = (plan: Partial<NonNullable<RouteUsage['plan']>> = {}): RouteUsage => ({ limited: false, interested: false, daily: { limit: 300, used: 4 },
  plan: { id: 'pro', owner: true, periodEnd: new Date(2026, 10, 30, 12).toISOString(), cancelAtPeriodEnd: false, credits: { granted: 2000, spent: 150, remaining: 1850 }, ...plan } });
// Midnight in the reader's own time, whatever the zone the tests run in: the card says 11月12日 24:00.
const TRIAL_END = new Date(2026, 10, 13).toISOString();

function server(usage: unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    calls.push({ url: url.pathname, method: init.method ?? 'GET' });
    if (url.pathname.endsWith('/route-usage')) return json(usage);
    if (url.pathname.endsWith('/upgrade-interest')) return json({ recorded: true, clicks: 1 });
    if (url.pathname.endsWith('/runtime')) return json({ available: true, configured: true, plannerAvailable: true, models: [{ id: 'model' }] });
    return json({ items: [], nextCursor: null });
  }));
  return calls;
}
function card(usage: unknown, { role = 'owner', who = identity, local = false }: { role?: string; who?: Identity; local?: boolean } = {}) {
  const calls = server(usage);
  render(<SaaSPreferencesProvider><LocalEdition.Provider value={local}>
    <HomeShell identity={who} tenant={{ ...tenant, role }} onOpen={vi.fn()} />
  </LocalEdition.Provider></SaaSPreferencesProvider>);
  return { calls, card: within(screen.getByRole('region', { name: /^(账号与套餐|Account and plan)$/ })) };
}
const stayOnPage = (event: Event) => event.preventDefault();

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  window.history.replaceState({}, '', '/?tenant=team-c');
  document.addEventListener('click', stayOnPage);
});
afterEach(() => { cleanup(); document.removeEventListener('click', stayOnPage); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('who is signed in', () => {
  it('shows the name, the whole email on hover, an avatar of initials, and names nothing other parts need unique', async () => {
    const { card: shown } = card(free());
    expect(shown.getByText('Hana Ito')).toBeVisible();
    expect(shown.getByText(identity.user.email)).toHaveAttribute('title', identity.user.email);
    expect(shown.getByText('HI')).toHaveAttribute('aria-hidden', 'true');
    expect(shown.queryByText('只读成员')).toBeNull();
    expect(shown.getByRole('link', { name: '账号设置' })).toHaveAttribute('href', '/?tenant=team-c&account=general');
    for (const name of ['退出登录', '邀请好友', '账号与工作区']) {
      expect(shown.queryByRole('button', { name })).toBeNull();
      expect(shown.queryByRole('link', { name })).toBeNull();
    }
    expect(initials('王小明')).toBe('王');
    expect(initials('ada')).toBe('A');
    expect(initials('  ')).toBe('?');
  });
});

describe('a paid plan', () => {
  it('gives its owner the period’s credits, the renewal day and a quiet way to manage it', async () => {
    const { card: shown, calls } = card(paid());
    expect(await shown.findByText('Pro', { selector: '.saas-home-account-badge' })).toBeVisible();
    expect(shown.getByText('本期剩余 1,850 / 2,000 点')).toBeVisible();
    expect(shown.getByText('11月30日 自动续费')).toBeVisible();
    const manage = shown.getByRole('link', { name: '管理订阅' });
    expect(manage).not.toHaveClass('saas-primary');
    expect(manage).toHaveAttribute('href', '/?tenant=team-c&account=plans');
    expect(manage).not.toHaveAttribute('target');
    fireEvent.click(manage);
    expect(calls.some(call => call.url.endsWith('/upgrade-interest'))).toBe(false);
    // The meter is the page's one route-usage reader; the home never reads GET /billing.
    expect(shown.getByRole('button', { name: 'Pro · 剩 1,850 点' })).toBeVisible();
    expect(calls.filter(call => call.url.endsWith('/route-usage'))).toHaveLength(1);
    expect(calls.some(call => call.url.includes('/billing'))).toBe(false);
  });

  it('offers to resume a plan set to end, and records that its owner would pay', async () => {
    const { card: shown, calls } = card(paid({ cancelAtPeriodEnd: true }));
    expect(await shown.findByText('11月30日 到期，不会自动续费')).toBeVisible();
    const resume = shown.getByRole('link', { name: '恢复续订' });
    expect(resume).toHaveClass('saas-primary');
    fireEvent.click(resume);
    await waitFor(() => expect(calls.some(call => call.url === '/api/v1/tenants/team-c/upgrade-interest' && call.method === 'POST')).toBe(true));
  });

  it('makes the plan one step up the first action when few credits are left (managing the largest one)', async () => {
    const low = { granted: 2000, spent: 1800, remaining: 200 };
    card(paid({ credits: low }));
    expect(await screen.findByRole('link', { name: '升级 Max' })).toHaveClass('saas-primary');
    expect(document.querySelector('.saas-home-account-bar')).toHaveClass('is-low');
    cleanup();
    // A low Max plan is offered Ultra, the third plan, not Max again.
    card(paid({ id: 'max', credits: { granted: 10000, spent: 9000, remaining: 1000 } }));
    expect(await screen.findByRole('link', { name: '升级 Ultra' })).toHaveClass('saas-primary');
    expect(screen.queryByRole('link', { name: '升级 Max' })).toBeNull();
    cleanup();
    // Nothing is above Ultra: its owner manages it.
    card(paid({ id: 'ultra', credits: { granted: 29900, spent: 27000, remaining: 2900 } }));
    expect(await screen.findByRole('link', { name: '管理订阅' })).toHaveClass('saas-primary');
    expect(screen.queryByRole('link', { name: /^升级/ })).toBeNull();
    expect(screen.getByText('Ultra')).toBeVisible();
    expect(lowCredits({ granted: 2000, spent: 1700, remaining: 300 })).toBe(false);
    expect(lowCredits({ granted: 0, spent: 0, remaining: 0 })).toBe(true);
    expect(lowCredits(null)).toBe(false);
  });

  it('tells a member of someone’s paid workspace whose plan it is, with nothing to renew', async () => {
    const { card: shown } = card(paid({ owner: false, periodEnd: undefined, cancelAtPeriodEnd: undefined }), { role: 'member' });
    expect(await shown.findByText('工作区所有者的 Pro 套餐')).toBeVisible();
    expect(shown.getByText('本期剩余 1,850 / 2,000 点')).toBeVisible();
    expect(shown.queryByRole('link', { name: /管理订阅|恢复续订|升级/ })).toBeNull();
  });
});

describe('the free plan', () => {
  it('says when the trial ends and how many days are left, with subscribing first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 8, 12));
    const { card: shown, calls } = card(free({ freePlan: { until: TRIAL_END, ended: false } }));
    expect(await shown.findByText('免费试用', { selector: '.saas-home-account-badge' })).toBeVisible();
    expect(shown.getByText('试用到 11月12日 24:00 · 还剩 5 天')).toBeVisible();
    const subscribe = shown.getByRole('link', { name: '订阅套餐' });
    expect(subscribe).toHaveClass('saas-primary');
    expect(subscribe).toHaveAttribute('href', '/?tenant=team-c&account=plans');
    fireEvent.click(subscribe);
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/upgrade-interest'))).toBe(true));
    expect(shown.getByRole('button', { name: '今日额度 · 剩 28 次' })).toBeVisible();
  });

  it('marks an ended trial in the warning chip, and its subscribing link', async () => {
    const { card: shown } = card(free({ freePlan: { until: TRIAL_END, ended: true } }));
    const badge = await shown.findByText('未订阅');
    expect(badge).toHaveClass('saas-home-account-badge', 'is-ended');
    expect(shown.getByText('免费试用已结束，订阅后继续运行')).toBeVisible();
    expect(shown.getByRole('link', { name: '订阅套餐' })).toHaveClass('saas-primary');
    // The meter no longer counts calls nothing can use.
    expect(shown.getByRole('button', { name: '免费试用已结束' })).toHaveClass('is-out');
    cleanup();
    const member = card(free({ freePlan: { until: TRIAL_END, ended: true } }), { role: 'member' });
    expect(await member.card.findByText('免费试用已结束，工作区所有者订阅后继续运行')).toBeVisible();
  });

  it('names the free plan and a promotion’s end on an API older than the trial’s end, offering the upgrade', async () => {
    const { card: shown } = card(free({ promo: { until: new Date(2026, 10, 30, 8).toISOString(), daily: 100 } }));
    expect(await shown.findByText('免费版', { selector: '.saas-home-account-badge' })).toBeVisible();
    expect(shown.getByText('限时额度到 11月30日 08:00')).toBeVisible();
    expect(shown.getByRole('link', { name: '升级套餐' })).toHaveClass('saas-primary');
    cleanup();
    const plain = card(free());
    expect(await plain.card.findByText('免费版', { selector: '.saas-home-account-badge' })).toBeVisible();
    expect(plain.card.queryByText(/限时额度/)).toBeNull();
  });

  it('offers an admin or a member of a free workspace a plan of their own only, said to be theirs', async () => {
    // The server opens a workspace by its owner's plan: a member's purchase opens their own workspaces, not this one.
    for (const role of ['admin', 'member'] as const) {
      const { card: shown, calls } = card(free({ freePlan: { until: TRIAL_END, ended: false } }), { role });
      expect(await shown.findByText('试用结束后，这个工作区要所有者订阅才能继续运行。')).toBeVisible();
      expect(shown.queryByRole('link', { name: '订阅套餐' })).toBeNull();
      const own = shown.getByRole('link', { name: '为我自己的账号订阅' });
      expect(own).not.toHaveClass('saas-primary');
      expect(own).toHaveAttribute('href', '/?tenant=team-c&account=plans');
      fireEvent.click(own);
      await waitFor(() => expect(calls.some(call => call.url.endsWith('/upgrade-interest'))).toBe(true));
      cleanup();
    }
    const ended = card(free({ freePlan: { until: TRIAL_END, ended: true } }), { role: 'member' });
    expect(await ended.card.findByText('免费试用已结束，工作区所有者订阅后继续运行')).toBeVisible();
    expect(ended.card.queryByText('试用结束后，这个工作区要所有者订阅才能继续运行。')).toBeNull();
    expect(ended.card.queryByRole('link', { name: '订阅套餐' })).toBeNull();
    expect(ended.card.getByRole('link', { name: '为我自己的账号订阅' })).toBeVisible();
    expect(planView(free({ freePlan: { until: TRIAL_END, ended: false } }), 'admin')).toEqual({ standing: 'trial', until: TRIAL_END, owner: false, call: 'own' });
  });

  it('gives a password account the link too: the plans page explains how to buy', async () => {
    const { card: shown } = card(free({ freePlan: { until: TRIAL_END, ended: false } }), { who: { ...identity, authentication: 'local' } });
    expect(await shown.findByRole('link', { name: '订阅套餐' })).toBeVisible();
  });
});

describe('a reader and the local edition', () => {
  it('shows a reader their role and the trial, with nothing to buy', async () => {
    const { card: shown } = card(free({ freePlan: { until: TRIAL_END, ended: false } }), { role: 'reader' });
    expect(await shown.findByText('免费试用', { selector: '.saas-home-account-badge' })).toBeVisible();
    expect(shown.getByText('只读成员')).toBeVisible();
    expect(shown.queryByRole('link', { name: /订阅|升级/ })).toBeNull();
    expect(planView(free(), 'reader')).toEqual({ standing: 'free', until: null, owner: false, call: null });
  });

  it('reads no route-usage and no billing in the local edition, and shows no plan', async () => {
    const local = { ...identity, edition: 'local' as const, authentication: 'local' as const };
    const { card: shown, calls } = card(free({ freePlan: { until: TRIAL_END, ended: true } }), { who: local, local: true });
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/canvases'))).toBe(true));
    expect(shown.getByText('Hana Ito')).toBeVisible();
    expect(shown.getByRole('link', { name: '账号设置' })).toBeVisible();
    expect(document.querySelector('.saas-route-usage-trigger')).toBeNull();
    expect(document.querySelector('.saas-home-account-plan')).toBeNull();
    expect(calls.some(call => call.url.includes('/route-usage') || call.url.includes('/billing'))).toBe(false);
    expect(screen.queryByRole('status', { name: /试用/ })).toBeNull();
  });

  it('shows no plan block for an unlimited workspace, or before an answer', () => {
    expect(planView(null, 'owner')).toBeNull();
    expect(planView({ limited: false, interested: false, daily: { limit: 100, used: 0 } }, 'owner')).toBeNull();
  });
});

describe('in English', () => {
  it('words every state', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    const { card: shown } = card(paid({ cancelAtPeriodEnd: true }));
    expect(screen.getByRole('region', { name: 'Account and plan' })).toBeVisible();
    expect(await shown.findByText('1,850 of 2,000 credits left this period')).toBeVisible();
    expect(shown.getByText('Ends on November 30; it will not renew')).toBeVisible();
    expect(shown.getByRole('link', { name: 'Resume subscription' })).toBeVisible();
    expect(shown.getByRole('link', { name: 'Account settings' })).toBeVisible();
    cleanup();
    const ended = card(free({ freePlan: { until: TRIAL_END, ended: true } }), { role: 'reader' });
    expect(await ended.card.findByText('Not subscribed')).toBeVisible();
    expect(ended.card.getByText('Reader')).toBeVisible();
    expect(ended.card.getByText('The free trial has ended; it runs again once the workspace owner subscribes')).toBeVisible();
  });
});
