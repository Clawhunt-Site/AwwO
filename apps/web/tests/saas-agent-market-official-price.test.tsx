// AwwO's official Agents take a price from a moment on (the server's market capability: officialPrice from
// officialPriceFrom). Until then the market dialog says when and how much under its subtitle; from then on their cards
// and pages show it, and a page never says the fee goes to an author (it is AwwO's). No market surface says free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentMarket } from '../src/saas/market/AgentMarket';
import { officialPriceNotice } from '../src/saas/market/marketText';
import { forgetMarketAgents } from '../src/saas/market/useMarket';
import { momentText } from '../src/saas/freePlan';
import { LocaleProvider } from '../src/canvas/i18n';

type Call = { url: string; method: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stats = { calls: 2, users: 1, successRate: null, up: 0, down: 0, avgSeconds: null, avgModelCredits: null, score: null, ranked: false };
const agent = (id: string, name: string, patch: Record<string, unknown> = {}) => ({ id, name, tagline: `${name} tagline`, category: 'code', kind: 'llm',
  official: false, author: { name: 'Ada' }, price: 0, version: 1, model: { runtime: '', id: '', effort: '', locked: false }, listedAt: '2026-10-29T00:00:00Z',
  stats, ...patch });
const detail = (item: Record<string, unknown>) => ({ ...item, description: '', examples: [], skills: [], instructionsPublic: false });
// What a workspace's capabilities answer (capabilities.go): the four the page requires, and the market with the
// official Agents' price when it has one.
const capabilities = (market: Record<string, unknown> | null) => ({
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: false, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 },
  render: { enabled: false, perDay: 0, usedToday: 0, limits: { maxSeconds: 0, maxFps: 0, maxWidth: 0, maxHeight: 0, maxFrames: 0, maxHtmlBytes: 0 } },
  ...(market ? { market: { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14, ...market } } : {}),
});

function server(agents: Array<Record<string, unknown>>, market: Record<string, unknown> | null) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET' };
    calls.push(call);
    const path = call.url.replace('/api/v1', '');
    if (path.startsWith('/market/agents?')) return json({ items: agents, nextCursor: null });
    const one = /^\/market\/agents\/([^/?]+)/.exec(path);
    if (one) { const found = agents.find(item => item.id === decodeURIComponent(one[1])); return found ? json(detail(found)) : json({ error: { code: 'market_agent_not_found', message: 'gone' } }, 404); }
    if (path === '/tenants/team/capabilities') return json(capabilities(market));
    // No paid plan: a paid Agent offers the plans instead of being used.
    if (path === '/tenants/team/route-usage') return json({ limited: true, daily: { limit: 100, used: 1 }, interested: false });
    return json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const zh = (text: string) => text;
const hour = 3_600_000;
const official = agent('official-code-reviewer', 'Code reviewer', { official: true, author: null });
const open = (locale: 'zh' | 'en' = 'zh') => render(<LocaleProvider locale={locale}>
  <AgentMarket tenantId="team" target={{ kind: 'canvas' }} catalogue={[]} onUse={vi.fn()} onClose={vi.fn()} /></LocaleProvider>);
/** The capabilities were read and the page has settled on them. */
async function settled(calls: Call[]) {
  await waitFor(() => expect(calls.some(call => call.url === '/api/v1/tenants/team/capabilities')).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
const notice = () => document.querySelector('.awwo-market-official-note');

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetMarketAgents(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the official Agents’ price, before it starts', () => {
  it('is said under the market’s subtitle as a note: when, and how much', async () => {
    const from = new Date(Date.now() + 24 * hour).toISOString();
    server([official], { officialPrice: 5, officialPriceFrom: from });
    open();
    const expected = officialPriceNotice({ officialPrice: 5, officialPriceFrom: from }, Date.now(), 'zh', zh)!;
    const note = await screen.findByText(expected);
    expect(note).toHaveAttribute('role', 'note');
    expect(note).toHaveTextContent(`${momentText(from, 'zh', { end: true })} 起，AwwO 官方 Agent 每次调用 5 点（模型费另算）`);
    // A start on a local midnight reads as the trial banner names the same moment (the day before's 24:00), not 00:00.
    // (A local midnight, as the trial banner's tests build theirs, so this holds in any time zone.)
    expect(officialPriceNotice({ officialPrice: 5, officialPriceFrom: new Date(2026, 10, 13).toISOString() }, new Date(2026, 10, 8).getTime(), 'zh', zh))
      .toMatch(/^11月12日 24:00 起，AwwO 官方 Agent 每次调用 5 点/);
    // Under the subtitle, in the dialog's heading.
    expect(note.closest('.awwo-library-heading')).not.toBeNull();
    expect(note.previousElementSibling).toHaveTextContent('排行只看真实运行');
    // Before the moment the listing still reports official Agents at their price now: none.
    expect(await screen.findByRole('button', { name: /^Code reviewer/ })).toHaveTextContent('只收模型费');
    expect(document.body).not.toHaveTextContent('免费');
  });

  it('is said in English too', async () => {
    const from = new Date(Date.now() + 2 * hour).toISOString();
    server([official], { officialPrice: 1, officialPriceFrom: from });
    open('en');
    const note = await waitFor(() => { const found = notice(); expect(found).not.toBeNull(); return found!; });
    expect(note).toHaveTextContent(`From ${momentText(from, 'en', { end: true })}, a call to an AwwO official Agent costs 1 credit (the model is billed apart)`);
    expect(note).toHaveAttribute('role', 'note');
    expect(document.body).not.toHaveTextContent(/\bfree\b/i);
  });

  it('is gone once the moment has passed, where official Agents take no fee, and where the server says nothing', async () => {
    for (const market of [{ officialPrice: 5, officialPriceFrom: new Date(Date.now() - hour).toISOString() },
      { officialPrice: 0, officialPriceFrom: new Date(Date.now() + hour).toISOString() }, {}, null]) {
      const calls = server([official], market);
      open();
      expect(await screen.findByRole('button', { name: /^Code reviewer/ })).toBeVisible();
      await settled(calls);
      expect(notice(), JSON.stringify(market)).toBeNull();
      cleanup(); forgetMarketAgents();
    }
  });
});

describe('a priced official Agent', () => {
  it('asks for the owner’s plan and says the fee is AwwO’s, never an author’s', async () => {
    server([agent('official-code-reviewer', 'Code reviewer', { official: true, author: null, price: 5 })], { officialPrice: 5 });
    open();
    const card = await screen.findByRole('button', { name: /^Code reviewer/ });
    expect(card).toHaveTextContent('每次 5 点');
    expect(card).toHaveTextContent('AwwO 官方');
    const page = await screen.findByRole('article', { name: 'Code reviewer 的详情' });
    const note = await within(page).findByRole('note');
    expect(note).toHaveTextContent('AwwO 官方 Agent 每次成功调用扣 5 点（Agent 费归 AwwO，模型费另算）：工作区所有者有 Pro / Max 付费套餐才能用。');
    expect(note).not.toHaveTextContent('作者');
    expect(within(note).getByRole('link', { name: '查看 Pro / Max 套餐' })).toHaveAttribute('href', '/?account=plans');
    expect(within(page).queryByRole('button', { name: '添加到画布' })).toBeNull();
    // Its price applies already (no FROM): there is nothing to announce.
    expect(notice()).toBeNull();
  });

  it('says so in English, with no author either', async () => {
    server([agent('official-code-reviewer', 'Code reviewer', { official: true, author: null, price: 1 })], { officialPrice: 1 });
    open('en');
    const page = await screen.findByRole('article', { name: 'Code reviewer details' });
    const note = await within(page).findByRole('note');
    expect(note).toHaveTextContent('An AwwO official Agent takes 1 credit a successful call (the Agent fee is AwwO’s; the model is billed apart): it needs the workspace owner to have the Pro or Max plan.');
    expect(note).not.toHaveTextContent(/author/i);
  });
});

describe('an author’s paid Agent', () => {
  it('asks for the plan without promising anything of Agents with no fee, in both languages', async () => {
    const paid = agent('coder', 'Coder', { price: 3 });
    for (const [locale, name, words, gone] of [['zh', 'Coder 的详情', '这是付费 Agent，每次成功调用扣 3 点：工作区所有者有 Pro / Max 付费套餐才能用。', /免费/],
      ['en', 'Coder details', 'This is a paid Agent that takes 3 credits a successful call: it needs the workspace owner to have the Pro or Max plan.', /free/i]] as const) {
      server([paid], null);
      open(locale);
      const page = await screen.findByRole('article', { name });
      const note = await within(page).findByRole('note');
      expect(note).toHaveTextContent(words);
      expect(note).not.toHaveTextContent(gone);
      cleanup(); forgetMarketAgents();
    }
  });

  it('sits beside an Agent with no fee, which reads as the model cost only', async () => {
    server([agent('writer', 'Writer'), agent('coder', 'Coder', { price: 3 })], null);
    open();
    expect(await screen.findByRole('button', { name: /^Writer/ })).toHaveTextContent('只收模型费');
    fireEvent.click(screen.getByRole('button', { name: /^Coder/ }));
    expect(await screen.findByRole('article', { name: 'Coder 的详情' })).toHaveTextContent('Ada · 每次 3 点');
    expect(document.body).not.toHaveTextContent('免费');
  });
});
