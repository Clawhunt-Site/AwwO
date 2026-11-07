// treg's advice under the home's composer (home/ToolAdvice.tsx): the live data a request names (canvas/liveDataNeed.ts),
// and the card that recommends pairing treg with the person's own Agent, its steps and lines, and 不需要.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { liveDataNeed, LIVE_DATA_NEEDS } from '../src/canvas/liveDataNeed';
import { tregSnippets } from '../src/canvas/multiplayer/AgentInvite';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-x', name: 'Workspace X', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-x', name: 'Xia', email: 'x@example.test', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('the live data a request names', () => {
  it('finds each need once, in a fixed order, from Chinese and English words', () => {
    expect(LIVE_DATA_NEEDS).toEqual(['web', 'seo', 'social', 'company', 'market', 'ads']);
    expect(liveDataNeed('调研竞品的定价，写一份报告')).toEqual(['web']);
    expect(liveDataNeed('A competitive analysis of three CRMs, from real-time data')).toEqual(['web']);
    expect(liveDataNeed('做 SEO：查关键词的搜索量和外链')).toEqual(['seo']);
    expect(liveDataNeed('Find SERPs, keywords and backlinks for our blog')).toEqual(['seo']);
    expect(liveDataNeed('整理小红书和抖音上的爆款达人')).toEqual(['social']);
    expect(liveDataNeed('Find prospects and their funding rounds for a lead generation list')).toEqual(['company']);
    expect(liveDataNeed('一份客户名单，附公司信息和联系方式')).toEqual(['company']);
    expect(liveDataNeed('Track stock prices, Bitcoin and the exchange rate')).toEqual(['market']);
    expect(liveDataNeed('看看竞品广告和 Meta 的 ad library')).toEqual(['web', 'ads']);
    // Each need once, whatever the number of its words.
    expect(liveDataNeed('竞品、竞争对手、行业报告、market research')).toEqual(['web']);
    // Upper or lower case alike; a phrase over any white space.
    expect(liveDataNeed('MARKET\nDATA and b站 videos')).toEqual(['social', 'market']);
  });

  it('counts a platform only where the request asks for its data', () => {
    expect(liveDataNeed('分析小红书上的热门笔记')).toEqual(['social']);
    expect(liveDataNeed('Search Twitter and LinkedIn for comments about our brand')).toEqual(['social']);
    expect(liveDataNeed('Research TikTok trends')).toEqual(['social']);
    expect(liveDataNeed('做一个 YouTube 风格的播放器')).toEqual([]);
    expect(liveDataNeed('A login page like Instagram’s')).toEqual([]);
  });

  it('names nothing for an ordinary build request, and matches Latin words only as whole words', () => {
    expect(liveDataNeed('做一个贪吃蛇小游戏，用方向键控制')).toEqual([]);
    expect(liveDataNeed('Make a snake game for the browser, with a ranking board')).toEqual([]);
    expect(liveDataNeed('做一个产品落地页，介绍我们的 AI 写作工具')).toEqual([]);
    expect(liveDataNeed('Build a product landing page for our app, with a pricing table')).toEqual([]);
    // Everyday words that name no data on their own (a review of 2026-11-08 found them flagging these).
    expect(liveDataNeed('做一个公司官网，底部放联系方式')).toEqual([]);
    expect(liveDataNeed('用最新的设计风格做个落地页')).toEqual([]);
    expect(liveDataNeed('做一个招聘网站')).toEqual([]);
    expect(liveDataNeed('做一个新闻阅读 App')).toEqual([]);
    expect(liveDataNeed('A trend chart of our own sales, with the latest numbers we give it')).toEqual([]);
    // "prospect" is not "prospective", "SEO" not a word inside another.
    expect(liveDataNeed('A page for prospective students')).toEqual([]);
    expect(liveDataNeed('It loads fast and counts the downloads')).toEqual([]);
    expect(liveDataNeed('')).toEqual([]);
  });
});

function server() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname;
    return json(path.endsWith('/runtime') ? { available: true, configured: true, plannerAvailable: true, models: [{ id: 'model' }] } : { items: [], nextCursor: null });
  }));
}
const home = () => render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
const box = () => screen.getByRole('textbox', { name: /画布需求|Canvas request/ });
const advice = () => screen.queryByRole('complementary', { name: /treg/ });

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); server(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe('the advice under the composer', () => {
  it('shows only while the request names live data, says which and what it costs, and never blocks sending', () => {
    home();
    expect(advice()).toBeNull();
    fireEvent.change(box(), { target: { value: '做一个贪吃蛇小游戏' } });
    expect(advice()).toBeNull();
    fireEvent.change(box(), { target: { value: '调研竞品在小红书上的爆款笔记，做一份周报' } });
    const card = advice()!;
    expect(card).toHaveAccessibleName('推荐搭配 · treg（第三方工具目录）');
    expect(card).toHaveTextContent('这个需求可能要用到实时数据：网页资料、社媒趋势。');
    expect(card).toHaveTextContent('AwwO 自己的 Agent 不联网');
    expect(card).toHaveTextContent('「同屏 → 邀请 Agent」');
    expect(card).toHaveTextContent('treg 按次计费，记在你自己的 treg 账户上，不经过 AwwO。');
    // No key or token is asked for or named, and no logo is drawn.
    expect(card.textContent).not.toMatch(/key|密钥|token/i);
    expect(card.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: '生成画布' })).toBeEnabled();
    fireEvent.change(box(), { target: { value: '' } });
    expect(advice()).toBeNull();
  });

  it('expands into the three steps and treg’s lines, each with a copy button', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
    home();
    fireEvent.change(box(), { target: { value: 'Research our competitors’ SEO keywords' } });
    const card = advice()!;
    const how = within(card).getByRole('button', { name: '怎么接入' });
    expect(how).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(how);
    expect(how).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    const lines = tregSnippets();
    expect([...card.querySelectorAll('pre')].map(pre => pre.textContent)).toEqual([lines.claude, lines.codex, lines.cursor]);
    // The lines carry no credential and ask for none: treg's own sign-in names the person's team in their browser.
    for (const line of [lines.claude, lines.codex, lines.cursor]) expect(line).not.toMatch(/token|bearer|authorization|header|api[_-]?key|x-treg|secret|password/i);
    expect(card.textContent).not.toMatch(/treg_[A-Za-z0-9]|sk-[A-Za-z0-9]|密钥|API Key/i);
    fireEvent.click(within(card).getByRole('button', { name: '复制：Codex' }));
    await waitFor(() => expect(writes).toEqual([lines.codex]));
    expect(within(card).getByRole('link', { name: '在新标签页打开 treg.to（第三方网站）' })).toHaveAttribute('target', '_blank');
    fireEvent.click(how);
    expect(card.querySelector('pre')).toBeNull();
  });

  it('hides on 不需要 until the request names other needs, and keeps it hidden in this tab', () => {
    const view = home();
    fireEvent.change(box(), { target: { value: '抓取竞品官网的价格' } });
    fireEvent.click(within(advice()!).getByRole('button', { name: '不需要' }));
    expect(advice()).toBeNull();
    fireEvent.change(box(), { target: { value: '抓取竞品官网的价格，越新越好' } });
    expect(advice()).toBeNull();
    view.unmount();
    home();
    fireEvent.change(box(), { target: { value: '抓取竞品官网的价格' } });
    expect(advice()).toBeNull();
    fireEvent.change(box(), { target: { value: '抓取竞品官网的价格，再查它们的股价' } });
    expect(advice()).not.toBeNull();
  });

  it('reads in English', () => {
    localStorage.setItem('superclaw_locale', 'en');
    home();
    fireEvent.change(box(), { target: { value: 'Find prospects and their competitors' } });
    const card = advice()!;
    expect(card).toHaveAccessibleName('Pairs well with treg (a third-party tool catalog)');
    expect(card).toHaveTextContent('This request may need live data: web research, company and people data.');
    expect(card).toHaveTextContent('open Multiplayer → Invite an Agent on it');
    expect(card).toHaveTextContent('treg charges per call to your own treg account, never through AwwO.');
    fireEvent.click(within(card).getByRole('button', { name: 'How to connect' }));
    expect(within(card).getByRole('button', { name: 'Copy: Claude Code' })).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: 'Not needed' }));
    expect(advice()).toBeNull();
  });
});
