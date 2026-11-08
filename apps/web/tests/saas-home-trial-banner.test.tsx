// The banner over the home's sections (home/TrialBanner.tsx): the free trial's end, its passing, a promotion's end from
// an older API, and the owner's plan set to end; who gets the way to the plans page; dismissing it for the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrialBanner } from '../src/saas/home/TrialBanner';
import { bannerView } from '../src/saas/home/accountPlan';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { RouteUsage } from '../src/saas/routeUsage';

const TRIAL_END = new Date(2026, 10, 13).toISOString();
const free = (extra: Partial<RouteUsage> = {}): RouteUsage => ({ limited: true, interested: false, daily: { limit: 30, used: 2 }, routes: {}, ...extra });
const plan = (extra: Partial<NonNullable<RouteUsage['plan']>> = {}): RouteUsage => ({ limited: false, interested: false, daily: { limit: 300, used: 0 },
  plan: { id: 'max', owner: true, periodEnd: new Date(2026, 11, 2, 12).toISOString(), cancelAtPeriodEnd: true, credits: { granted: 10000, spent: 0, remaining: 10000 }, ...extra } });
const banner = (usage: RouteUsage | null, { owner = true, userId = 'user-b', tenantId = 'team-b', onDismiss = vi.fn() } = {}) =>
  <SaaSPreferencesProvider><TrialBanner usage={usage} userId={userId} tenantId={tenantId} owner={owner} onDismiss={onDismiss} /></SaaSPreferencesProvider>;
const posts: string[] = [];
const stayOnPage = (event: Event) => event.preventDefault();

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); posts.length = 0;
  window.history.replaceState({}, '', '/?tenant=team-b');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { if (init.method === 'POST') posts.push(String(url)); return new Response('{"recorded":true,"clicks":1}'); }));
  document.addEventListener('click', stayOnPage);
});
afterEach(() => { cleanup(); document.removeEventListener('click', stayOnPage); vi.unstubAllGlobals(); });

describe('the trial banner', () => {
  it('says when the beta’s free trial ends, links the owner to the plans, and can be put away for the session', async () => {
    const onDismiss = vi.fn();
    const view = render(banner(free({ freePlan: { until: TRIAL_END, ended: false } }), { onDismiss }));
    const shown = screen.getByRole('status');
    // Planning is refused after the end as running is (free_plan.go): the banner says both.
    expect(shown).toHaveTextContent('AwwO 内测即将结束：免费试用到 11月12日 24:00 结束，之后要订阅 Pro 或 Max 才能继续规划和运行。');
    const plans = screen.getByRole('link', { name: '查看套餐' });
    expect(plans).toHaveAttribute('href', '/?tenant=team-b&account=plans');
    fireEvent.click(plans);
    await waitFor(() => expect(posts).toEqual(['/api/v1/tenants/team-b/upgrade-interest']));
    fireEvent.click(screen.getByRole('button', { name: '关闭这条提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    // For the rest of the session, for this person and workspace only, and until another end comes.
    view.unmount();
    render(banner(free({ freePlan: { until: TRIAL_END, ended: false } })));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    render(banner(free({ freePlan: { until: TRIAL_END, ended: false } }), { tenantId: 'team-other' }));
    expect(screen.getByRole('status')).toBeVisible();
    cleanup();
    render(banner(free({ freePlan: { until: new Date(2026, 10, 20).toISOString(), ended: false } })));
    expect(screen.getByRole('status')).toHaveTextContent('11月19日 24:00');
  });

  it('keeps an ended trial on screen with subscribing first, never as an alert', () => {
    const { container } = render(banner(free({ freePlan: { until: TRIAL_END, ended: true } })));
    expect(container).toHaveTextContent('免费试用已结束：订阅 Pro 或 Max 后就能继续规划和运行，画布和成果都还在。');
    expect(screen.getByRole('link', { name: '订阅 Pro / Max' })).toHaveClass('saas-primary');
    expect(screen.queryByRole('button', { name: '关闭这条提示' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('tells anyone but the owner that the owner subscribes, and offers them nothing to buy for the workspace', () => {
    // The server opens a workspace by its owner's plan: a member's own purchase would leave this one closed.
    render(banner(free({ freePlan: { until: TRIAL_END, ended: true } }), { owner: false }));
    expect(screen.getByText('免费试用已结束：工作区所有者订阅 Pro 或 Max 后，就能继续规划和运行，画布和成果都还在。')).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    render(banner(free({ freePlan: { until: TRIAL_END, ended: false } }), { owner: false }));
    expect(screen.getByRole('status')).toHaveTextContent('AwwO 内测即将结束：免费试用到 11月12日 24:00 结束，之后这个工作区要所有者订阅 Pro 或 Max 才能继续规划和运行。');
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    localStorage.setItem('superclaw_locale', 'en');
    render(banner(free({ freePlan: { until: TRIAL_END, ended: true } }), { owner: false }));
    expect(screen.getByText('The free trial has ended: once the workspace owner subscribes to Pro or Max, planning and runs work again. The canvases and results are all still here.')).toBeVisible();
  });

  it('says a promotion’s end where the API has no trial end, and the owner’s plan set to end', () => {
    // A promotion alone (e.g. a workspace an administrator owns, which the trial's end never closes) is no trial: its
    // end is the limited-time allowance's, in the same form as the trial's.
    render(banner(free({ promo: { until: TRIAL_END, daily: 100 } })));
    expect(screen.getByRole('status')).toHaveTextContent(/^限时额度到 11月12日 24:00 结束。/);
    expect(screen.getByRole('link', { name: '查看套餐' })).toBeVisible();
    cleanup();
    render(banner(plan()));
    expect(screen.getByRole('status')).toHaveTextContent('你的 Max 套餐 12月2日 到期，不会自动续费。');
    expect(screen.getByRole('link', { name: '恢复续订' })).toBeVisible();
    expect(screen.getByRole('button', { name: '关闭这条提示' })).toBeVisible();
  });

  it('shows nothing for a plan that renews, someone else’s plan, an unlimited workspace, a plain free one, or no answer', () => {
    for (const usage of [plan({ cancelAtPeriodEnd: false }), plan({ owner: false, cancelAtPeriodEnd: undefined, periodEnd: undefined }),
      { limited: false, interested: false, daily: { limit: 100, used: 0 } }, free(), null]) {
      expect(bannerView(usage)).toBeNull();
      const { container } = render(banner(usage));
      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });

  it('reads in English', () => {
    localStorage.setItem('superclaw_locale', 'en');
    render(banner(free({ freePlan: { until: TRIAL_END, ended: false } })));
    expect(screen.getByRole('status')).toHaveTextContent('The AwwO beta is ending: the free trial ends on Nov 12, 24:00; after that, planning and running need Pro or Max.');
    expect(screen.getByRole('link', { name: 'See plans' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dismiss this notice' })).toBeVisible();
    cleanup();
    render(banner(free({ freePlan: { until: TRIAL_END, ended: true } })));
    expect(screen.getByRole('link', { name: 'Subscribe to Pro or Max' })).toBeVisible();
    cleanup();
    render(banner(plan({ id: 'pro' })));
    expect(screen.getByText('Your Pro plan ends on December 2 and will not renew.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Resume subscription' })).toBeVisible();
  });
});
