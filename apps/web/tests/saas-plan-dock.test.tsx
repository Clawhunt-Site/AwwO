// The plan button in the bottom-left corner of every page but the home (PlanDock.tsx; owner 2026-11-12: 「整个会员套餐购买
// 按钮就呈现在页面左下角，买好的也能实时的看到自己的套餐等级」): the plan's level as a badge with the credits left, the way to
// the plans where there is none, kept up with the server, and the feedback button beside it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DOCK_REFRESH_MS, PlanDock, onHomePage } from '../src/saas/PlanDock';
import { measurePage, placeLauncher } from '../src/saas/feedbackPlacement';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { ROUTE_USAGE_CHANGED, type RouteUsage } from '../src/saas/routeUsage';
import type { Identity, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'team-a', name: 'Team A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [tenant], authentication: 'clawhunt' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const paid = (id: 'pro' | 'max' | 'ultra', remaining: number, granted: number, owner = true): RouteUsage => ({ limited: false, interested: false, daily: { limit: 300, used: 0 },
  plan: { id, owner, cancelAtPeriodEnd: false, credits: { granted, spent: granted - remaining, remaining } } });
const trial: RouteUsage = { limited: true, interested: false, daily: { limit: 100, used: 0 }, routes: {}, freePlan: { until: '2026-11-12T16:00:00Z', ended: false } };
const unlimited: RouteUsage = { limited: false, interested: false, daily: { limit: 100000, used: 0 } };

function server(usage: () => unknown) {
  const calls: Array<{ path: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    calls.push({ path: url.pathname, method: init.method ?? 'GET' });
    if (url.pathname.endsWith('/route-usage')) return json(usage());
    return json({ recorded: true, clicks: 1 });
  }));
  return calls;
}
const dock = (who: Identity = identity) => render(<SaaSPreferencesProvider><PlanDock identity={who} /></SaaSPreferencesProvider>);
const button = () => document.querySelector<HTMLAnchorElement>('.saas-plan-dock');

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/?canvas=c1'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the plan button on a canvas page', () => {
  it.each([
    ['pro', 1850, 2000, 'Pro', '剩 1,850 点'],
    ['max', 9200, 10000, 'Max', '剩 9,200 点'],
    ['ultra', 29900, 29900, 'Ultra', '剩 29,900 点'],
  ] as const)('shows the workspace’s plan %s as its level, with the credits left, and leads to the plans', async (id, remaining, granted, name, left) => {
    server(() => paid(id, remaining, granted));
    dock();
    await waitFor(() => expect(button()).not.toBeNull());
    const link = button()!;
    expect(link).toHaveAttribute('href', expect.stringContaining('account=plans'));
    expect(link).toHaveAttribute('data-plan-dock', id);
    expect(link).toHaveClass('is-paid', `is-${id}`);
    expect(link.querySelector('.saas-plan-dock-badge')).toHaveTextContent(name);
    expect(link.querySelector('.saas-plan-dock-credits')).toHaveTextContent(left);
    expect(link).toHaveAccessibleName(`当前套餐 ${name}，${left}。查看套餐与点数`);
    // The feedback button keeps clear of it and sits beside it.
    expect(link).toHaveAttribute('data-feedback-avoid', 'beside');
  });

  it('marks credits that are nearly spent', async () => {
    server(() => paid('pro', 120, 2000));
    dock();
    await waitFor(() => expect(button()).toHaveClass('is-low'));
  });

  it('shows a member the owner’s plan level', async () => {
    server(() => paid('max', 5000, 10000, false));
    dock({ ...identity, tenants: [{ ...tenant, role: 'member' }] });
    await waitFor(() => expect(button()?.querySelector('.saas-plan-dock-badge')).toHaveTextContent('Max'));
    // Whose plan it is, and whose plans the link opens: not "your current plan".
    expect(button()!.getAttribute('aria-label')).toMatch(/^这个工作区的套餐 Max（由所有者订阅）.*查看我自己的套餐$/);
  });

  it('offers the plans where the workspace is on none, and says its person would pay when pressed', async () => {
    const calls = server(() => trial);
    dock();
    const link = await screen.findByRole('link', { name: '订阅套餐' });
    expect(link).toHaveClass('is-call');
    expect(link).toHaveAttribute('href', expect.stringContaining('account=plans'));
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(calls).toContainEqual({ path: '/api/v1/tenants/team-a/upgrade-interest', method: 'POST' }));
  });

  it('reads in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    server(() => paid('pro', 1850, 2000));
    dock();
    await waitFor(() => expect(button()).toHaveAccessibleName('Current plan: Pro, 1,850 credits left. See plans and credits'));
  });

  it('shows the new level at once when the plans page says a plan has landed, with no reload', async () => {
    let usage: RouteUsage = trial;
    const calls = server(() => usage);
    dock();
    await screen.findByRole('link', { name: '订阅套餐' });
    usage = paid('pro', 2000, 2000);
    act(() => { window.dispatchEvent(new Event(ROUTE_USAGE_CHANGED)); });
    await waitFor(() => expect(button()?.querySelector('.saas-plan-dock-badge')).toHaveTextContent('Pro'));
    // An upgrade shows the same way.
    usage = paid('max', 10000, 10000);
    act(() => { window.dispatchEvent(new Event(ROUTE_USAGE_CHANGED)); });
    await waitFor(() => expect(button()?.querySelector('.saas-plan-dock-badge')).toHaveTextContent('Max'));
    expect(calls.filter(call => call.path.endsWith('/route-usage'))).toHaveLength(3);
  });

  it('reads again by itself every two minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let usage: RouteUsage = paid('pro', 2000, 2000);
    server(() => usage);
    dock();
    await waitFor(() => expect(button()?.querySelector('.saas-plan-dock-badge')).toHaveTextContent('Pro'));
    usage = paid('ultra', 29900, 29900);
    await act(async () => { await vi.advanceTimersByTimeAsync(DOCK_REFRESH_MS + 50); });
    await waitFor(() => expect(button()?.querySelector('.saas-plan-dock-badge')).toHaveTextContent('Ultra'));
  });
});

describe('where there is no plan button', () => {
  it('is the home (its rail has the account card), an unlimited workspace, a reader of a workspace on no plan, and the local edition', async () => {
    expect(onHomePage('/', '')).toBe(true);
    expect(onHomePage('/', '?tenant=team-a')).toBe(true);
    expect(onHomePage('/', '?canvas=c1')).toBe(false);
    expect(onHomePage('/', '?account=plans')).toBe(false);
    // The home: nothing drawn, nothing asked.
    window.history.replaceState({}, '', '/');
    const home = server(() => paid('pro', 2000, 2000));
    const first = dock();
    await waitFor(() => expect(home).toHaveLength(0));
    expect(button()).toBeNull();
    first.unmount();
    // An unlimited workspace has no plan to show and none to buy.
    window.history.replaceState({}, '', '/?canvas=c1');
    const calls = server(() => unlimited);
    const second = dock();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(button()).toBeNull();
    second.unmount();
    // A reader of a workspace on no plan is offered nothing.
    server(() => trial);
    const third = dock({ ...identity, tenants: [{ ...tenant, role: 'reader' }] });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(button()).toBeNull();
    third.unmount();
    const local = server(() => paid('pro', 2000, 2000));
    dock({ ...identity, edition: 'local' } as Identity);
    await waitFor(() => expect(local).toHaveLength(0));
    expect(button()).toBeNull();
  });
});

describe('the corner, shared with the feedback button', () => {
  it('gives the plan button the corner, and puts the feedback button to its right', () => {
    const view = { width: 1440, height: 900 }, size = { width: 96, height: 40 };
    // The plan button, 170px wide, sits in the corner: an obstacle the feedback button goes beside.
    const plan = { box: { left: 16, top: 844, right: 186, bottom: 884 }, mode: 'beside' as const };
    expect(placeLauncher(view, { width: 170, height: 40 }, null, [])).toEqual({ left: 16, bottom: 16 });
    expect(placeLauncher(view, size, null, [plan])).toEqual({ left: 202, bottom: 16 });
  });

  it('measures the page for the plan button without itself and without the feedback button’s slot', () => {
    document.body.innerHTML = '<div id="slot" data-feedback-slot></div><a id="dock" data-feedback-avoid="beside"></a><aside id="side" data-feedback-avoid="beside"></aside>';
    const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(document.getElementById('slot')!, 'getBoundingClientRect').mockReturnValue(rect(20, 600, 240, 640));
    vi.spyOn(document.getElementById('dock')!, 'getBoundingClientRect').mockReturnValue(rect(16, 700, 186, 740));
    vi.spyOn(document.getElementById('side')!, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 300, 768));
    // The feedback button: the slot is its own, and both marked things are in its way.
    const forFeedback = measurePage();
    expect(forFeedback.slot).not.toBeNull();
    expect(forFeedback.obstacles).toHaveLength(2);
    // The plan button: no slot, and it is no obstacle to itself.
    const forPlan = measurePage(document.getElementById('dock'));
    expect(forPlan.slot).toBeNull();
    expect(forPlan.obstacles).toHaveLength(1);
    expect(forPlan.obstacles[0].box.right).toBe(300);
    document.body.innerHTML = '';
  });
});
