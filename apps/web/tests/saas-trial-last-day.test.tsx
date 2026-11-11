// The meter on the free trial's last UTC day (the 2026-11-08 review of the public beta: 08:00 to 24:00 Beijing time on
// the 12th), when the trial ends before the daily calls next reset: it promises no reset (none comes: the end closes
// the workspace first) and says what does carry on; and a promotion that lasts the whole trial is the trial's
// allowance, said without a second date. Dates are local midnights, so the words hold in any time zone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RouteUsageMeter, trialEndsBeforeReset } from '../src/saas/RouteUsageMeter';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { RouteUsage } from '../src/saas/routeUsage';

const hour = 3_600_000;
const until = new Date(2026, 10, 13).toISOString();
const base = (over: Partial<RouteUsage> = {}): RouteUsage => ({
  limited: true, interested: false, daily: { limit: 100, used: 100 }, routes: { media: { limit: 5, used: 0 } },
  freePlan: { until, ended: false }, resetsAt: new Date(Date.parse(until) + 8 * hour).toISOString(), ...over,
});
const meter = (usage: RouteUsage, owner = true) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(usage))));
  return render(<SaaSPreferencesProvider><RouteUsageMeter tenantId="t-a" owner={owner} /></SaaSPreferencesProvider>);
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the trial’s last day', () => {
  it('is the day whose next reset comes after the trial’s end', () => {
    expect(trialEndsBeforeReset(base())).toBe(until);
    // The reset at the end itself is no reset the workspace gets either.
    expect(trialEndsBeforeReset(base({ resetsAt: until }))).toBe(until);
    expect(trialEndsBeforeReset(base({ resetsAt: new Date(Date.parse(until) - hour).toISOString() }))).toBeNull();
    expect(trialEndsBeforeReset(base({ freePlan: { until, ended: true } }))).toBeNull();
    expect(trialEndsBeforeReset(base({ freePlan: undefined }))).toBeNull();
    // Without the server's resetsAt, the next UTC midnight after now.
    const morning = Date.UTC(2026, 10, 12, 5);
    const noon = new Date(Date.UTC(2026, 10, 12, 12)).toISOString();
    expect(trialEndsBeforeReset(base({ resetsAt: undefined, freePlan: { until: noon, ended: false } }), morning)).toBe(noon);
    expect(trialEndsBeforeReset(base({ resetsAt: undefined, freePlan: { until: noon, ended: false } }), morning - 24 * hour)).toBeNull();
  });

  it('promises the owner no reset, and says that subscribing carries on', async () => {
    meter(base());
    fireEvent.click(await screen.findByRole('button', { name: '今日次数已用完' }));
    expect(await screen.findByText('今天是免费试用的最后一天：今天的次数不会再重置，试用 11月12日 24:00 结束。默认模型不单独限次，只占总次数。')).toBeVisible();
    expect(screen.getByText('今天的总次数已用完，免费试用今天结束，不会再重置：订阅 Pro、Max 或 Ultra 后就能继续运行。')).toBeVisible();
    expect(document.body).not.toHaveTextContent('UTC 0 点重置');
    expect(document.body).not.toHaveTextContent('等到 UTC 0 点后');
  });

  it('tells anyone else that the owner subscribes, and reads in English', async () => {
    meter(base(), false);
    fireEvent.click(await screen.findByRole('button', { name: '今日次数已用完' }));
    expect(await screen.findByText('今天的总次数已用完，免费试用今天结束，不会再重置：工作区所有者订阅 Pro、Max 或 Ultra 后才能继续运行。')).toBeVisible();
    cleanup();
    localStorage.setItem('superclaw_locale', 'en');
    meter(base());
    fireEvent.click(await screen.findByRole('button', { name: 'No calls left today' }));
    expect(await screen.findByText(/^Today is the free trial’s last day: today’s calls will not reset, as the trial ends on Nov 12, 24:00\./)).toBeVisible();
    expect(screen.getByText('Today’s calls are used up, and the free trial ends today without another reset: subscribe to Pro, Max or Ultra to keep running.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('Resets at 00:00 UTC');
  });

  it('keeps the daily reset on any other day', async () => {
    meter(base({ resetsAt: new Date(Date.parse(until) - 4 * 24 * hour).toISOString() }));
    fireEvent.click(await screen.findByRole('button', { name: '今日次数已用完' }));
    expect(await screen.findByText('每天 UTC 0 点重置。默认模型不单独限次，只占总次数。')).toBeVisible();
    expect(screen.getByText('今天的总次数已用完，所有模型都要等到 UTC 0 点后才能再运行。')).toBeVisible();
  });
});

describe('a promotion during the trial', () => {
  it('lasting the whole trial is the trial’s allowance, said without a second date', async () => {
    meter(base({ daily: { limit: 100, used: 10 }, promo: { until, daily: 100, routes: { media: 5 } } }));
    fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 90 次' }));
    expect(await screen.findByText('试用期间每天 100 次调用、5 次图片 / 视频生成，下面的数字已经算上。')).toBeVisible();
    expect(document.body).not.toHaveTextContent('限时放开');
    // The trial's end is said once, by its own note.
    expect(screen.getByText('免费试用到 11月12日 24:00 结束，之后要订阅 Pro、Max 或 Ultra 才能继续规划和运行。')).toBeVisible();
  });

  it('ending before the trial keeps its own date', async () => {
    const earlier = new Date(2026, 10, 10).toISOString();
    meter(base({ daily: { limit: 100, used: 10 }, promo: { until: earlier, daily: 100 } }));
    fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 90 次' }));
    expect(await screen.findByText(/^限时放开：到 .*，免费版每天 100 次调用，下面的数字已经算上。$/)).toBeVisible();
  });
});
