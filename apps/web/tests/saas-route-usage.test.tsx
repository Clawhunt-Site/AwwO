import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouteUsageMeter } from '../src/saas/RouteUsageMeter';
import { AdminPanel } from '../src/saas/AdminPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { announceRouteUsageChanged } from '../src/saas/routeUsage';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const usage = (routes: Record<string, { limit: number; used: number }>, daily = { limit: 30, used: 12 }, interested = false) => ({ limited: true, interested, daily, routes });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const meter = () => render(<SaaSPreferencesProvider><RouteUsageMeter tenantId="t-a" /></SaaSPreferencesProvider>);
const showing = (value: unknown) => vi.stubGlobal('fetch', vi.fn(async () => response(value)));
const row = (name: string) => screen.getByText(name).parentElement!;
const allOut = { gate: { limit: 3, used: 3 }, bedrock: { limit: 1, used: 1 }, media: { limit: 1, used: 1 } };
// Only intervals are faked in the polling test, so a short real pause lets every answer land.
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

it('shows nothing for a workspace without route limits, and stops asking about it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const fetch = vi.fn(async () => response({ limited: false, interested: false, daily: { limit: 100, used: 2 } }));
    vi.stubGlobal('fetch', fetch);
    const { container } = meter();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await React.act(async () => { await vi.advanceTimersByTimeAsync(3 * 120_000); });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.saas-route-usage-trigger')).toBeNull();
    // A route-limited workspace keeps its count fresh.
    cleanup();
    fetch.mockImplementation(async () => response(usage({ gate: { limit: 3, used: 1 } })));
    meter();
    await screen.findByRole('button', { name: '今日额度 · 剩 18 次' });
    await React.act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it('shows the assistant’s free canvas changes as their own row, outside the daily total', async () => {
  showing({ ...usage({ gate: { limit: 0, used: 0 }, bedrock: { limit: 0, used: 0 }, media: { limit: 1, used: 0 } }, { limit: 30, used: 4 }), planner: { limit: 20, used: 7 } });
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 26 次' }));
  expect(row('助手改画布（免费，不占总次数）')).toHaveTextContent('7 / 20');
  expect(row('总次数')).toHaveTextContent('4 / 30');
});

// A customer's question (2026-10-16): what one 次 is, and what a task the platform failed gives back.
it('says what one call is and what a failed direct task gives back', async () => {
  showing(usage({ gate: { limit: 3, used: 1 } }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 18 次' }));
  expect(screen.getByText(/^1 次 = 模型回答一次/)).toBeVisible();
  expect(screen.getByText(/用掉的次数退还到当天的总次数，每天最多退还 32 次；下面单独限次的几行不退。$/)).toBeVisible();
});

it('reads the numbers again as soon as a task says it ended', async () => {
  const fetch = vi.fn(async () => response(usage({ gate: { limit: 3, used: 1 } })));
  vi.stubGlobal('fetch', fetch);
  meter();
  await screen.findByRole('button', { name: '今日额度 · 剩 18 次' });
  fetch.mockImplementation(async () => response(usage({ gate: { limit: 3, used: 1 } }, { limit: 30, used: 19 })));
  React.act(() => { announceRouteUsageChanged(); });
  expect(await screen.findByRole('button', { name: '今日额度 · 剩 11 次' })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
  // Once unmounted, the meter no longer listens.
  cleanup();
  announceRouteUsageChanged();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('counts down the daily total while every route still has room', async () => {
  showing(usage({ gate: { limit: 3, used: 1 } }));
  meter();
  expect(await screen.findByRole('button', { name: '今日额度 · 剩 18 次' })).not.toHaveClass('is-out');
});

it('names the one route that ran out instead of saying every premium call is gone', async () => {
  showing(usage({ gate: { limit: 3, used: 1 }, bedrock: { limit: 1, used: 1 }, media: { limit: 1, used: 0 } }));
  meter();
  const chip = await screen.findByRole('button', { name: '剩 18 次 · Bedrock 已用完' });
  expect(chip).not.toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findByText('Bedrock（Opus 5.5 等）')).toBeVisible();
  expect(row('Bedrock（Opus 5.5 等）')).toHaveClass('is-out');
  expect(row('Claude / GPT 等')).not.toHaveClass('is-out');
  expect(row('总次数').textContent).toBe('总次数12 / 30');
});

it('does not call premium used up while a route without a limit of its own can still run', async () => {
  showing(usage({ gate: { limit: 3, used: 3 } }));
  meter();
  const chip = await screen.findByRole('button', { name: '剩 18 次 · Claude / GPT 已用完' });
  expect(chip).not.toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findAllByText('不单独限次')).toHaveLength(2);
  expect(row('Bedrock（Opus 5.5 等）').textContent).toBe('Bedrock（Opus 5.5 等）不单独限次');
  expect(row('Claude / GPT 等')).toHaveClass('is-out');
});

it('says when more than one route ran out without naming them all', async () => {
  showing(usage({ gate: { limit: 3, used: 3 }, bedrock: { limit: 1, used: 0 }, media: { limit: 1, used: 1 } }));
  meter();
  expect(await screen.findByRole('button', { name: '剩 18 次 · 部分高级次数已用完' })).not.toHaveClass('is-out');
});

it('warns once every route that offers calls is used up, and shows a closed route as not included', async () => {
  showing(usage({ gate: { limit: 3, used: 3 }, bedrock: { limit: 0, used: 0 }, media: { limit: 1, used: 1 } }));
  meter();
  const chip = await screen.findByRole('button', { name: '剩 18 次 · 高级次数已用完' });
  expect(chip).toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findByText('不含')).toBeVisible();
  expect(row('Bedrock（Opus 5.5 等）')).not.toHaveClass('is-out');
  // A closed route is never "used up", so it alone does not turn the chip into a warning.
  cleanup();
  showing(usage({ gate: { limit: 3, used: 0 }, bedrock: { limit: 0, used: 0 } }));
  meter();
  expect(await screen.findByRole('button', { name: '今日额度 · 剩 18 次' })).not.toHaveClass('is-out');
});

it('says nothing can run once the daily total is spent, whatever the routes have left', async () => {
  showing(usage({ gate: { limit: 3, used: 1 } }, { limit: 30, used: 30 }));
  meter();
  const chip = await screen.findByRole('button', { name: '今日次数已用完' });
  expect(chip).toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findByText(/所有模型都要等到 UTC 0 点后才能再运行/)).toBeVisible();
  expect(row('总次数')).toHaveClass('is-out');
});

it('records an ask without naming routes, since the server counts what ran out, and keeps it repeatable', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    return init.method === 'POST' ? response({ recorded: true, clicks: 1 }) : response(usage(allOut));
  }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '剩 18 次 · 高级次数已用完' }));
  fireEvent.click(await screen.findByRole('button', { name: '想要更多次数' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已记录');
  const post = requests.find(request => request.init.method === 'POST')!;
  expect(post.url).toBe('/api/v1/tenants/t-a/upgrade-interest');
  expect(JSON.parse(String(post.init.body))).toEqual({});
  expect(screen.getByRole('button', { name: '我还需要更多次数' })).toBeEnabled();
});

it('tells a free workspace its plan includes no premium model and makes upgrading the first action', async () => {
  // The reported popover: 2 / 30 used, Claude / GPT and Bedrock 不含, images 0 / 1.
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    return init.method === 'POST' ? response({ recorded: true, clicks: 1 })
      : response(usage({ gate: { limit: 0, used: 0 }, bedrock: { limit: 0, used: 0 }, media: { limit: 1, used: 0 } }, { limit: 30, used: 2 }));
  }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 28 次' }));
  expect(await screen.findByText('标着「不含」的高级模型不在这个工作区的免费额度里，需要 Pro / Max 套餐，按点数使用。')).toBeVisible();
  const upgrade = screen.getByRole('link', { name: '升级 Pro / Max' });
  expect(upgrade).toHaveClass('saas-primary');
  expect(upgrade.getAttribute('href')).toContain('account=plans');
  expect(upgrade).toHaveAttribute('target', '_blank');
  // The interest ask stays, as the secondary action.
  expect(screen.getByRole('button', { name: '想要更多次数' })).not.toHaveClass('saas-primary');
  const stay = (event: Event) => event.preventDefault(); document.addEventListener('click', stay);
  try { fireEvent.click(upgrade); } finally { document.removeEventListener('click', stay); }
  await waitFor(() => expect(requests.some(request => request.init.method === 'POST' && request.url === '/api/v1/tenants/t-a/upgrade-interest')).toBe(true));
  expect(screen.queryByText(/付费套餐上线时/)).toBeNull();
});

it('remembers an earlier ask from the server', async () => {
  showing(usage(allOut, undefined, true));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '剩 18 次 · 高级次数已用完' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已记录');
  expect(screen.getByRole('button', { name: '我还需要更多次数' })).toBeVisible();
});

const identity = { user: { id: 'admin-a', name: 'Admin', email: 'a@example.invalid', platformRole: 'admin' as const }, tenants: [] };
const tenant = { id: 't-a', name: 'Tenant A', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 30, routeLimits: { gate: 3, bedrock: 1, media: 1 } };
const stubAdmin = (handler: (url: string, init: RequestInit) => Response) => vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) =>
  url.endsWith('/admin/summary') ? response({ tenantCount: 1, userCount: 1, activeRuns: 0, completedRuns: 0, failedRuns: 0 }) : handler(url, init)));
const patchesOf = (items: unknown[]) => {
  const patches: unknown[] = [];
  stubAdmin((url, init) => {
    if (init.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return response(tenant); }
    return url.includes('/admin/tenants') ? response({ items, nextCursor: null }) : response({ items: [], nextCursor: null });
  });
  render(<SaaSPreferencesProvider><AdminPanel identity={identity}/></SaaSPreferencesProvider>);
  return patches;
};

it('shows route limits in the workspace list and edits them only when asked to', async () => {
  const patches = patchesOf([tenant, { ...tenant, id: 't-b', name: 'Open', routeLimits: null }, { ...tenant, id: 't-c', name: 'Closed', routeLimits: { gate: 3, bedrock: 0 } }]);
  expect(await screen.findByText('Claude / GPT 3 · Bedrock 1 · 图片视频 1')).toBeVisible();
  expect(screen.getByText('不限')).toBeVisible();
  expect(screen.getByText('Claude / GPT 3 · Bedrock 关闭')).toBeVisible();
  fireEvent.click(screen.getAllByRole('button', { name: '编辑配额' })[0]);
  fireEvent.change(screen.getByLabelText('Bedrock（每天）'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('图片视频（每天）'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ maxConcurrentRuns: 2, maxRunsPerDay: 30, routeLimits: { gate: 3, bedrock: 0 } });
  fireEvent.click(await screen.findAllByRole('button', { name: '编辑配额' }).then(buttons => buttons[0]));
  fireEvent.click(screen.getByLabelText('按路由限每日次数'));
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({ maxConcurrentRuns: 2, maxRunsPerDay: 30, routeLimits: null });
});

it('leaves route limits alone when a quota edit only changes the daily limit', async () => {
  const patches = patchesOf([tenant]);
  fireEvent.click(await screen.findByRole('button', { name: '编辑配额' }));
  fireEvent.change(screen.getByLabelText('每日运行上限'), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ maxConcurrentRuns: 2, maxRunsPerDay: 40 });
});

it('cannot send a fractional route limit, sends zero to close a route, and drops hidden fields', async () => {
  const patches = patchesOf([tenant]);
  fireEvent.click(await screen.findByRole('button', { name: '编辑配额' }));
  const gate = screen.getByLabelText('Claude / GPT（每天）') as HTMLInputElement;
  // The field's own constraints stop a fraction before the form's check runs.
  fireEvent.change(gate, { target: { value: '2.5' } });
  expect(gate.validity.valid).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(patches).toHaveLength(0);
  // Zero is a valid limit: it closes the route.
  fireEvent.change(gate, { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ maxConcurrentRuns: 2, maxRunsPerDay: 30, routeLimits: { gate: 0, bedrock: 1, media: 1 } });
  // A half-typed value in fields the operator then hid is not checked: unticking removes route limits.
  fireEvent.click(await screen.findByRole('button', { name: '编辑配额' }));
  fireEvent.change(screen.getByLabelText('Claude / GPT（每天）'), { target: { value: '2.5' } });
  fireEvent.click(screen.getByLabelText('按路由限每日次数'));
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({ maxConcurrentRuns: 2, maxRunsPerDay: 30, routeLimits: null });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('lists who asked for more calls and what they had used up', async () => {
  stubAdmin(url => url.includes('/admin/interests')
    ? response({ items: [
      { id: 'i-1', userName: 'Ann', email: 'ann@example.invalid', tenantName: 'Ann · AwwO', routes: ['daily', 'gate', 'media'], clicks: 2, createdAt: '2026-10-05T10:00:00Z', lastAt: '2026-10-05T11:00:00Z' },
      { id: 'i-2', userName: 'Bo', email: 'bo@example.invalid', tenantName: 'Bo · AwwO', routes: [], clicks: 1, createdAt: '2026-10-05T09:00:00Z', lastAt: '2026-10-05T09:00:00Z' },
    ], nextCursor: null })
    : response({ items: [tenant], nextCursor: null }));
  render(<SaaSPreferencesProvider><AdminPanel identity={identity}/></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '付费意向' }));
  expect(await screen.findByText('ann@example.invalid')).toBeVisible();
  expect(screen.getByRole('columnheader', { name: '提出时已用完' })).toBeVisible();
  expect(screen.getByText('总次数、Claude / GPT、图片视频')).toBeVisible();
  expect(screen.getByText('提出时未用完')).toBeVisible();
  expect(screen.getByText('Ann · AwwO')).toBeVisible();
});
