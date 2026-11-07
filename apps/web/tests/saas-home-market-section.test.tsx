// The home's Agent 市场 section (MarketHomeStrip `expanded`): category chips with 全部 first, twelve Agents of the one
// chosen, 查看全部 opening the market as the strip's does, the official Agents' coming price, and one line where the
// market is off. The strip itself is pinned by tests/saas-agent-market-runs.test.tsx.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MarketHomeStrip, SECTION_MARKET_AGENTS } from '../src/saas/market/MarketHomeStrip';
import { forgetMarketAgents } from '../src/saas/market/useMarket';
import { MARKET_CATEGORIES } from '../src/saas/marketApi';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Tenant } from '../src/saas/api';

const tenant = { id: 'team-m', name: 'Team M', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 } as Tenant;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const agent = (index: number, category = 'code') => ({ id: `agent-${index}`, name: `Agent ${index}`, tagline: '', category, kind: 'llm', official: true, author: null, price: 0, version: 1,
  model: { runtime: '', id: '', effort: '', locked: false }, listedAt: null,
  stats: { calls: 100 - index, users: 10, successRate: 0.9, up: 1, down: 0, avgSeconds: null, avgModelCredits: null, score: 0.9, ranked: true } });
const capabilities = (market: unknown) => ({ skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false }, render: { enabled: false }, market });
const MARKET = { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14 };

function server(market: unknown, { capabilitiesStatus = 200 } = {}) {
  const lists: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace('/api/v1', '');
    if (path.endsWith('/capabilities')) return capabilitiesStatus === 200 ? json(capabilities(market)) : json({ error: { code: 'unavailable' } }, capabilitiesStatus);
    if (path.startsWith('/market/agents?')) {
      lists.push(path);
      const category = new URLSearchParams(path.split('?')[1]).get('category');
      return json({ items: Array.from({ length: category ? 2 : 14 }, (_, index) => agent(index + 1, category ?? 'code')), nextCursor: null });
    }
    if (path.startsWith('/market/agents/')) return json({ ...agent(1), description: '', examples: [], skills: [], instructionsPublic: true, instructions: 'Text' });
    if (path.endsWith('/runtime')) return json({ configured: true, available: true, models: [] });
    return json({ error: { code: 'not_found' } }, 404);
  }));
  return lists;
}
const section = (role = 'owner') => render(<SaaSPreferencesProvider><MarketHomeStrip tenant={{ ...tenant, role }} onOpen={vi.fn()} expanded /></SaaSPreferencesProvider>);
const cards = (scope: HTMLElement) => within(scope).getAllByRole('button').filter(button => button.classList.contains('awwo-market-card'));

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetMarketAgents(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the best twelve Agents with category chips, 全部 first, and asks for the category chosen', async () => {
  const lists = server(MARKET);
  section();
  const region = await screen.findByRole('region', { name: 'Agent 市场' });
  await waitFor(() => expect(cards(region)).toHaveLength(SECTION_MARKET_AGENTS));
  expect(SECTION_MARKET_AGENTS).toBe(12);
  expect(lists[0]).toBe('/market/agents?sort=score&limit=12');
  const chips = within(within(region).getByRole('group', { name: 'Agent 类别' }));
  expect(chips.getAllByRole('button').map(chip => chip.textContent)).toEqual(['全部', '网页与界面', '写作与文案', '研究与分析', '编程与工程', '设计与创意', '图像与视频提示', '商业与营销', '教育与学习', '其他']);
  expect(chips.getAllByRole('button')).toHaveLength(MARKET_CATEGORIES.length + 1);
  expect(chips.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(chips.getByRole('button', { name: '研究与分析' }));
  expect(chips.getByRole('button', { name: '研究与分析' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(cards(region)).toHaveLength(2));
  expect(lists.at(-1)).toBe('/market/agents?category=research&sort=score&limit=12');
  // No price notice without an official price.
  expect(within(region).queryByRole('note')).toBeNull();
});

it('opens the whole market from 查看全部, and lets a reader browse only', async () => {
  server(MARKET);
  section('reader');
  const region = await screen.findByRole('region', { name: 'Agent 市场' });
  fireEvent.click(await within(region).findByRole('button', { name: '查看全部' }));
  const page = await screen.findByRole('article', { name: 'Agent 1 的详情' });
  expect(within(page).queryByRole('button', { name: '新建画布使用' })).toBeNull();
});

it('says when the official Agents’ price starts, and stops saying it once it has', async () => {
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  server({ ...MARKET, officialPrice: 5, officialPriceFrom: later });
  section();
  const note = await screen.findByRole('note');
  expect(note).toHaveTextContent(/起，AwwO 官方 Agent 每次调用 5 点（模型费另算），需要工作区所有者有 Pro \/ Max 套餐。$/);
  cleanup();
  server({ ...MARKET, officialPrice: 5, officialPriceFrom: new Date(Date.now() - 60_000).toISOString() });
  section();
  await screen.findByRole('group', { name: 'Agent 类别' });
  expect(screen.queryByRole('note')).toBeNull();
});

it('says in one line where the market is off, and offers another try where it cannot be read', async () => {
  server(undefined);
  section();
  const region = await screen.findByRole('region', { name: 'Agent 市场' });
  expect(await within(region).findByText('Agent 市场暂未开放。')).toBeVisible();
  expect(within(region).queryByRole('group')).toBeNull();
  expect(within(region).queryByRole('button', { name: '查看全部' })).toBeNull();
  cleanup();
  server(MARKET, { capabilitiesStatus: 503 });
  section();
  const failed = await screen.findByRole('alert');
  expect(failed).toHaveTextContent('暂时读不到 Agent 市场。');
  server(MARKET);
  fireEvent.click(within(failed).getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('group', { name: 'Agent 类别' })).toBeVisible();
});

it('reads in English', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  server(MARKET);
  section();
  const region = await screen.findByRole('region', { name: 'Agent market' });
  const chips = within(await within(region).findByRole('group', { name: 'Agent categories' }));
  expect(chips.getAllByRole('button')[0]).toHaveTextContent('All');
  expect(chips.getByRole('button', { name: 'Code and engineering' })).toBeVisible();
  expect(await within(region).findByRole('button', { name: 'See all' })).toBeVisible();
});
