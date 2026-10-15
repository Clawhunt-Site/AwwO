import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouteUsageMeter } from '../src/saas/RouteUsageMeter';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CheckinState } from '../src/saas/routeUsage';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const failure = (code: string, status = 409) => new Response(JSON.stringify({ error: { code, message: code } }), { status });
const bonus = { daily: 50, media: 3 };
const checkin = (state: Partial<CheckinState> = {}): CheckinState => ({ available: true, checkedIn: false, bonus, streak: 0, endsAt: '2026-10-29T00:00:00Z', ...state });
const usage = (state: Partial<CheckinState> | null, daily = { limit: 100, used: 12 }, media = { limit: 5, used: 1 }) => ({
  limited: true, interested: false, daily, routes: { media },
  promo: { until: '2026-10-29T00:00:00Z', daily: 100, routes: { media: 5 } },
  ...(state ? { checkin: checkin(state) } : {}),
});
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const meter = () => render(<SaaSPreferencesProvider><RouteUsageMeter tenantId="t-a" /></SaaSPreferencesProvider>);

it('offers today’s check-in beside the meter, adds the bonus, and then shows what it gave', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let checked = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (init.method === 'POST') {
      checked = true;
      return response({ checkin: checkin({ checkedIn: true, today: bonus, streak: 1 }) });
    }
    return response(checked ? usage({ checkedIn: true, today: bonus, streak: 1 }, { limit: 150, used: 12 }, { limit: 8, used: 1 }) : usage({}));
  }));
  meter();
  const chip = await screen.findByRole('button', { name: '签到领次数' });
  expect(chip).toHaveAttribute('title', '签到：今天再多 50 次调用和 3 次图片 / 视频生成');
  fireEvent.click(chip);
  await waitFor(() => expect(screen.queryByRole('button', { name: '签到领次数' })).toBeNull());
  const post = requests.find(request => request.init.method === 'POST')!;
  expect(post.url).toBe('/api/v1/tenants/t-a/checkin');
  expect(JSON.parse(String(post.init.body))).toEqual({});
  // The chip opened the meter's popover, which says what the check-in gave; the meter reads the raised limits again.
  expect(await screen.findByRole('status')).toHaveTextContent('今天已签到，多了 50 次调用和 3 次图片 / 视频生成');
  expect(await screen.findByRole('button', { name: '今日额度 · 剩 138 次' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('图片 / 视频').parentElement).toHaveTextContent('1 / 8');
  expect(screen.getByText(/限时放开：到 .*免费版每天 100 次调用、5 次图片 \/ 视频生成/)).toBeVisible();
});

it('checks in from the meter’s popover too, and keeps the run of days in view', async () => {
  let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { posts++; return response({ checkin: checkin({ checkedIn: true, today: bonus, streak: 4 }) }); }
    return response(usage(posts ? { checkedIn: true, today: bonus, streak: 4 } : { streak: 3 }));
  }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 88 次' }));
  expect(await screen.findByText('已连续签到 3 天，今天签了接着算。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '签到：今天再多 50 次调用和 3 次图片 / 视频生成' }));
  expect(await screen.findByRole('status')).toHaveTextContent('今天已签到，多了 50 次调用和 3 次图片 / 视频生成 · 已连续签到 4 天');
  expect(posts).toBe(1);
});

it('offers no check-in when another member or another workspace already took today’s, and says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(usage({ taken: true, today: bonus }))));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 88 次' }));
  expect(await screen.findByText('这个工作区今天已经有成员签到了，多出的次数已经加上。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '签到领次数' })).toBeNull();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => response(usage({ elsewhere: true }))));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 88 次' }));
  expect(await screen.findByText('你今天已经在另一个工作区签到了，每人每天签一次。')).toBeVisible();
  expect(screen.queryByRole('button', { name: /签到/ })).toBeNull();
});

it('shows no check-in where none is offered: a reader, a plan, or after the promotion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(usage(null))));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 88 次' }));
  expect(await screen.findByText(/限时放开/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /签到/ })).toBeNull();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => response({ limited: true, interested: false, daily: { limit: 30, used: 2 }, routes: { media: { limit: 1, used: 0 } } })));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 28 次' }));
  expect(screen.queryByText(/限时放开/)).toBeNull();
  expect(screen.queryByRole('button', { name: /签到/ })).toBeNull();
});

it('says why a check-in was refused and reads the meter again', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') return failure('checkin_elsewhere');
    reads++;
    return response(usage(reads > 1 ? { elsewhere: true } : {}));
  }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '签到领次数' }));
  await waitFor(() => expect(reads).toBe(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: '签到领次数' })).toBeNull());
  // The refusal is said in the popover the chip opened.
  expect(await screen.findByRole('alert')).toHaveTextContent('你今天已经在另一个工作区签到了，每人每天签一次。');
});

it('speaks English to an English reader', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  vi.stubGlobal('fetch', vi.fn(async () => response(usage({ streak: 2 }))));
  meter();
  expect(await screen.findByRole('button', { name: 'Check in' })).toHaveAttribute('title', 'Check in for 50 more calls and 3 more image / video generations today');
  fireEvent.click(screen.getByRole('button', { name: 'Today · 88 calls left' }));
  expect(await screen.findByText(/^Limited time: until .*, the free plan has 100 calls and 5 image \/ video generations a day/)).toBeVisible();
  expect(screen.getByText('2 days in a row so far; check in today to keep it going.')).toBeVisible();
});

it('names only what this workspace gets: no generations where its image / video route is closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ limited: true, interested: false, daily: { limit: 100, used: 12 }, routes: { media: { limit: 0, used: 0 } },
    promo: { until: '2026-10-29T00:00:00Z', daily: 100 }, checkin: checkin({ bonus: { daily: 50, media: 0 } }) })));
  meter();
  expect(await screen.findByRole('button', { name: '签到领次数' })).toHaveAttribute('title', '签到：今天再多 50 次调用');
  fireEvent.click(screen.getByRole('button', { name: '今日额度 · 剩 88 次' }));
  expect(await screen.findByText(/^限时放开：到 .*，免费版每天 100 次调用，下面的数字已经算上。$/)).toBeVisible();
  expect(screen.getByRole('button', { name: '签到：今天再多 50 次调用' })).toBeVisible();
});

it('renders nothing new for a workspace without route limits', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ limited: false, interested: false, daily: { limit: 100, used: 2 } })));
  const { container } = meter();
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(container.querySelector('.saas-checkin-trigger')).toBeNull();
});
