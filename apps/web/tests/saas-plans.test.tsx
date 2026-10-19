import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlansPage, returnPoll } from '../src/saas/PlansPage';
import { RouteUsageMeter } from '../src/saas/RouteUsageMeter';
import { billingNavigation, stripePage } from '../src/saas/billing';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const identity = { user: { id: 'member-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, tenants: [], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store' } as Identity;
const catalog = [
  { id: 'pro', priceUsd: 20, credits: 2000, dailyCalls: 300, concurrentAgents: 3, workspaces: 3, mediaPerDay: 30 },
  { id: 'max', priceUsd: 100, credits: 10000, dailyCalls: 1000, concurrentAgents: 6, workspaces: 10, mediaPerDay: 100 },
];
const free = { catalog, checkoutEnabled: true, plan: null, credits: null, stale: false };
const pro = { ...free, plan: { id: 'pro', status: 'active', periodStart: '2026-10-05T00:00:00Z', periodEnd: '2026-11-05T00:00:00Z', cancelAtPeriodEnd: false, entitled: true }, credits: { granted: 2000, spent: 150, remaining: 1850 } };
let go: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  window.history.replaceState({}, '', '/?account=plans');
  go = vi.spyOn(billingNavigation, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); returnPoll.ms = 2500; });

const page = (who: Identity = identity) => render(<SaaSPreferencesProvider><PlansPage identity={who} /></SaaSPreferencesProvider>);
const serve = (handler: (url: string, init: RequestInit) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(url, init); }));
  return calls;
};

it('shows both plans as coming soon while checkout is closed', async () => {
  serve(() => response({ ...free, checkoutEnabled: false }));
  page();
  expect(await screen.findByRole('heading', { name: 'Pro' })).toBeVisible();
  expect(screen.getByText('$20')).toBeVisible();
  expect(screen.getByText('$100')).toBeVisible();
  const soon = screen.getAllByRole('button', { name: '即将开放' });
  expect(soon).toHaveLength(2);
  soon.forEach(button => expect(button).toBeDisabled());
  expect(within(screen.getByRole('region', { name: 'Pro' })).getByText('2,000')).toBeVisible();
  expect(screen.getByText(/默认模型每天 1,000 次/)).toBeVisible();
});

it('shows each plan as a voucher: its credits as the face value, its price on the stub, and the plan held stamped', async () => {
  serve(() => response(free));
  page();
  const proVoucher = await screen.findByRole('region', { name: 'Pro' });
  expect(within(proVoucher).getByText('面值')).toBeVisible();
  expect(within(proVoucher).getByText('2,000')).toBeVisible();
  expect(within(proVoucher).getByText('$20')).toBeVisible();
  expect(within(proVoucher).getByText('日常创作')).toBeVisible();
  expect(within(proVoucher).getByText('按月订阅 · 可随时取消 · 由 Stripe 安全支付')).toBeVisible();
  // Every figure is the catalog's: Max says how many times Pro's credits it holds, from the two plans' credits.
  const maxVoucher = screen.getByRole('region', { name: 'Max' });
  expect(within(maxVoucher).getByText('10,000')).toBeVisible();
  expect(within(maxVoucher).getByText('进阶创作 · 点数是 Pro 的 5 倍')).toBeVisible();
  expect(within(maxVoucher).getByText(/默认模型每天 1,000 次/)).toBeVisible();
  expect(screen.getByText(/选一张点数券/)).toBeVisible();
  expect(screen.queryByText('使用中')).toBeNull();
  cleanup();
  serve(() => response(pro));
  page();
  const held = await screen.findByRole('region', { name: 'Pro' });
  expect(within(held).getByText('使用中')).toBeInTheDocument();
  // Only the plan held is stamped.
  expect(within(screen.getByRole('region', { name: 'Max' })).queryByText('使用中')).toBeNull();
  expect(within(held).getByText('当前套餐')).toBeVisible();
  expect(within(held).getByText('每期自动续费，点数随新一期到账')).toBeVisible();
  // Switching up says what an upgrade costs; the page never offers a second checkout to a subscriber.
  expect(within(screen.getByRole('region', { name: 'Max' })).getByText('期中升级只补按剩余天数折算的差价，补多少钱就加多少点')).toBeVisible();
  expect(screen.queryByText(/选一张点数券/)).toBeNull();
  expect(screen.queryByRole('button', { name: /^立即开通/ })).toBeNull();
  cleanup();
  // A Max subscriber looking at Pro is not told an upgrade's terms.
  serve(() => response({ ...pro, plan: { ...pro.plan, id: 'max' } }));
  page();
  const lower = await screen.findByRole('region', { name: 'Pro' });
  expect(within(lower).getByRole('button', { name: '在管理订阅中切换到 Pro' })).toBeEnabled();
  expect(within(lower).queryByText(/期中升级/)).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Max' })).getByText('使用中')).toBeInTheDocument();
  cleanup();
  // A cancelled renewal says the plan stays on until the period ends.
  serve(() => response({ ...pro, plan: { ...pro.plan, cancelAtPeriodEnd: true } }));
  page();
  expect(within(await screen.findByRole('region', { name: 'Pro' })).getByText('已取消续费，本期结束前照常可用')).toBeVisible();
  cleanup();
  // A subscription not paid yet has no difference to pay: no upgrade line, and nothing stamped.
  serve(() => response({ ...free, plan: { ...pro.plan, status: 'incomplete', entitled: false } }));
  page();
  const unpaid = await screen.findByRole('region', { name: 'Max' });
  expect(within(unpaid).getByRole('button', { name: '在管理订阅中切换到 Max' })).toBeEnabled();
  expect(within(unpaid).queryByText(/期中升级/)).toBeNull();
  expect(screen.queryByText('使用中')).toBeNull();
});

it('opens Stripe checkout for the chosen plan, and only Stripe’s own page', async () => {
  const calls = serve((url, init) => url.endsWith('/billing/checkout') ? response({ url: 'https://checkout.stripe.com/c/pay/cs_1' }) : response(free));
  page();
  fireEvent.click(await screen.findByRole('button', { name: '立即开通 Max' }));
  await waitFor(() => expect(go).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1'));
  const post = calls.find(call => call.init.method === 'POST')!;
  expect(JSON.parse(String(post.init.body))).toEqual({ plan: 'max' });
  cleanup();
  go.mockClear();
  serve((url, init) => init.method === 'POST' ? response({ url: 'https://evil.example/c/pay' }) : response(free));
  page();
  fireEvent.click(await screen.findByRole('button', { name: '立即开通 Pro' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('支付页面地址无效');
  expect(go).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '立即开通 Pro' })).toBeEnabled();
});

it('shows the current plan with its credits and sends changes to the billing portal', async () => {
  const calls = serve((url, init) => init.method === 'POST' ? response({ url: 'https://billing.stripe.com/p/session/1' }) : response(pro));
  page();
  expect(await screen.findByText('1,850 / 2,000')).toBeVisible();
  expect(screen.getByText('下次续费')).toBeVisible();
  expect(screen.getAllByText('当前套餐').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '在管理订阅中切换到 Max' }));
  await waitFor(() => expect(go).toHaveBeenCalledWith('https://billing.stripe.com/p/session/1'));
  expect(calls.find(call => call.init.method === 'POST')!.url).toBe('/api/v1/billing/portal');
});

it('says when a cancelled plan ends and when a renewal payment failed', async () => {
  serve(() => response({ ...pro, plan: { ...pro.plan, cancelAtPeriodEnd: true, status: 'past_due' } }));
  page();
  expect(await screen.findByText('到期日')).toBeVisible();
  expect(screen.getByText(/续费扣款失败/)).toBeVisible();
});

it('shows what an earlier period overspent and a renewal still being charged', async () => {
  serve(() => response({ ...pro, plan: { ...pro.plan, periodEnd: '2026-10-01T00:00:00Z' }, credits: { granted: 2000, spent: 100, carried: 150, remaining: 1750 } }));
  page();
  expect(await screen.findByText('1,750 / 2,000')).toBeVisible();
  expect(screen.getByText('上期超支（本期扣除）')).toBeVisible();
  expect(screen.getByText('150')).toBeVisible();
  expect(screen.getByText(/续费处理中/)).toBeVisible();
});

it('turns the plan on after Stripe sends the browser back', async () => {
  window.history.replaceState({}, '', '/?account=plans&billing=success');
  returnPoll.ms = 5;
  let reads = 0;
  const calls = serve(() => response(++reads < 3 ? free : pro));
  page();
  expect(await screen.findByText('支付完成，正在开通套餐…')).toBeVisible();
  expect(await screen.findByText('已开通 Pro，点数已到账。')).toBeVisible();
  expect(reads).toBe(3);
  expect(calls.every(call => call.url === '/api/v1/billing?refresh=1')).toBe(true);
});

it('stops asking after a few tries and says the plan is still syncing', async () => {
  window.history.replaceState({}, '', '/?account=plans&billing=success');
  returnPoll.ms = 1;
  let reads = 0;
  serve(() => { reads++; return response(free); });
  page();
  expect(await screen.findByText(/套餐还在同步/)).toBeVisible();
  expect(reads).toBe(8);
});

it('reads the payment page’s answer once and takes it off the address', async () => {
  window.history.replaceState({}, '', '/?account=plans&billing=cancel#top');
  serve(() => response(free));
  page();
  expect(await screen.findByText('已取消支付，没有扣款。')).toBeVisible();
  expect(window.location.search).toBe('?account=plans');
  expect(window.location.hash).toBe('#top');
});

it('sends a subscription that has not gone through to the billing portal, never to a second checkout', async () => {
  const calls = serve((url, init) => init.method === 'POST' ? response({ url: 'https://billing.stripe.com/p/session/2' }) : response({ ...free, plan: { ...pro.plan, status: 'incomplete', entitled: false } }));
  page();
  expect(await screen.findByText(/订阅还没有生效/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /^(订阅|立即开通)/ })).toBeNull();
  expect(screen.getByRole('button', { name: '在管理订阅中切换到 Max' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '管理订阅' }));
  await waitFor(() => expect(go).toHaveBeenCalledWith('https://billing.stripe.com/p/session/2'));
  expect(calls.find(call => call.init.method === 'POST')!.url).toBe('/api/v1/billing/portal');
});

it('frees its buttons when the browser comes back from Stripe with Back', async () => {
  serve((url, init) => init.method === 'POST' ? response({ url: 'https://checkout.stripe.com/c/pay/cs_9' }) : response(free));
  page();
  fireEvent.click(await screen.findByRole('button', { name: '立即开通 Pro' }));
  await waitFor(() => expect(go).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: '立即开通 Max' })).toBeDisabled();
  const restored = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  await waitFor(() => expect(screen.getByRole('button', { name: '立即开通 Max' })).toBeEnabled());
});

it('says a cancelled checkout charged nothing', async () => {
  window.history.replaceState({}, '', '/?account=plans&billing=cancel');
  serve(() => response(free));
  page();
  expect(await screen.findByText('已取消支付，没有扣款。')).toBeVisible();
});

it('needs a ClawHunt account', () => {
  serve(() => response(free));
  page({ ...identity, authentication: 'password' } as Identity);
  expect(screen.getByText(/付费套餐随 ClawHunt 账号提供/)).toBeVisible();
});

it('accepts only https Stripe pages on the expected host', () => {
  expect(stripePage('https://checkout.stripe.com/c/pay/1', 'checkout.stripe.com')).toBe('https://checkout.stripe.com/c/pay/1');
  expect(stripePage('https://billing.stripe.com/p/1', 'checkout.stripe.com')).toBeNull();
  expect(stripePage('http://checkout.stripe.com/c', 'checkout.stripe.com')).toBeNull();
  expect(stripePage('https://u:p@checkout.stripe.com/c', 'checkout.stripe.com')).toBeNull();
  expect(stripePage('javascript:alert(1)', 'checkout.stripe.com')).toBeNull();
});

const meter = () => render(<SaaSPreferencesProvider><RouteUsageMeter tenantId="t-a" /></SaaSPreferencesProvider>);
const paid = (remaining: number, used = 12, owner = true) => ({ limited: false, interested: false, daily: { limit: 300, used }, plan: { id: 'pro', owner, ...(owner ? { periodEnd: '2026-11-05T00:00:00Z', cancelAtPeriodEnd: false } : {}), credits: { granted: 2000, spent: 2000 - remaining, remaining } } });

it('shows a paid workspace’s credits in the chip and its popover', async () => {
  serve(() => response(paid(1850)));
  meter();
  const chip = await screen.findByRole('button', { name: 'Pro · 剩 1,850 点' });
  expect(chip).not.toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findByText('1,850 / 2,000')).toBeVisible();
  expect(screen.getByText('12 / 300')).toBeVisible();
  expect(screen.getByRole('link', { name: '套餐与点数' })).toHaveAttribute('href', expect.stringContaining('account=plans'));
});

it('warns when the plan’s credits or today’s calls are used up', async () => {
  serve(() => response(paid(0)));
  meter();
  const chip = await screen.findByRole('button', { name: 'Pro · 点数已用完' });
  expect(chip).toHaveClass('is-out');
  fireEvent.click(chip);
  expect(await screen.findByText(/本期点数已用完/)).toBeVisible();
  cleanup();
  serve(() => response(paid(900, 300)));
  meter();
  // Only the default model's calls are used up: paid models still run on the credits.
  expect(await screen.findByRole('button', { name: 'Pro · 默认模型今日已用完' })).toHaveClass('is-out');
});

it('does not tell Max to upgrade, and shows a member no renewal date', async () => {
  const max = (remaining: number) => ({ limited: false, interested: false, daily: { limit: 1000, used: 3 }, plan: { id: 'max', owner: true, credits: { granted: 10000, spent: 10000 - remaining, remaining } } });
  serve(() => response(max(0)));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: 'Max · 点数已用完' }));
  expect(await screen.findByText(/点数在续费后重置/)).toBeVisible();
  expect(screen.queryByText(/升级到 Max/)).toBeNull();
  expect(screen.getByText(/点数按套餐的计费周期发放/)).toBeVisible();
});

it('tells a member to ask the owner, not to upgrade a plan that is not theirs', async () => {
  serve(() => response(paid(0, 12, false)));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: 'Pro · 点数已用完' }));
  expect(await screen.findByText(/请联系工作区所有者/)).toBeVisible();
  expect(screen.queryByText(/升级到 Max/)).toBeNull();
});

it('links a free workspace’s allowance to the plans', async () => {
  serve(() => response({ limited: true, interested: false, daily: { limit: 30, used: 2 }, routes: { gate: { limit: 3, used: 1 } } }));
  meter();
  fireEvent.click(await screen.findByRole('button', { name: '今日额度 · 剩 28 次' }));
  expect(await screen.findByRole('link', { name: '升级 Pro / Max' })).toHaveAttribute('href', expect.stringContaining('account=plans'));
});
