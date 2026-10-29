// The Agent market dialog (AgentMarket.tsx): its listing asks the server for the order, category and search chosen; an
// Agent's page says what using it does to the node's model; a paid Agent without the owner's plan offers the plans
// instead; and the one action it was opened for hands the Agent and its model decision to the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentMarket } from '../src/saas/market/AgentMarket';
import { forgetMarketAgents } from '../src/saas/market/useMarket';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';

type Call = { url: string; method: string; body: any };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stats = (ranked: boolean, patch: Record<string, unknown> = {}) => ({ calls: ranked ? 40 : 2, users: ranked ? 9 : 1, successRate: ranked ? 0.9 : null, up: 5, down: 1,
  avgSeconds: 42, avgModelCredits: 2.5, score: ranked ? 0.8 : null, ranked, ...patch });
const agent = (id: string, name: string, patch: Record<string, unknown> = {}) => ({ id, name, tagline: `${name} tagline`, category: 'writing', kind: 'llm', official: false,
  author: { name: 'Ada' }, price: 0, version: 2, model: { runtime: 'openai-agents', id: 'claude', effort: '', locked: false }, listedAt: '2026-10-20T00:00:00Z', stats: stats(true), ...patch });
const AGENTS = [
  agent('writer', 'Writer'),
  agent('coder', 'Coder', { kind: 'coding', price: 5, model: { runtime: 'openai-agents', id: 'claude', effort: 'high', locked: true } }),
  agent('locked', 'Locked', { model: { runtime: 'pi', id: 'gpt-x', effort: '', locked: true } }),
  agent('chosen', 'Chosen', { model: { runtime: 'openai-agents', id: 'deepseek', effort: '', locked: false } }),
  agent('fresh', 'Fresh', { stats: stats(false), official: true, author: null }),
];
const detail = (item: Record<string, unknown>) => ({ ...item, description: `About ${item.name}`, examples: [{ prompt: 'Write a haiku', result: 'An old pond' }],
  skills: [{ name: 'critic', title: 'Critic', attribution: 'wshobson/agents', license: 'MIT' }], instructionsPublic: false });
const catalogue: ModelPaletteSelection[] = [
  { key: '["openai-agents","claude"]', label: 'Claude Opus', displayName: 'Claude Opus', providerGroup: 'claude', runtime: 'openai-agents', model: 'claude', available: true, efforts: ['low', 'high'] },
  { key: '["openai-agents","deepseek"]', label: 'DeepSeek', displayName: 'DeepSeek', providerGroup: 'deepseek', runtime: 'openai-agents', model: 'deepseek', available: true, userChosen: true },
];

function server(plan: boolean | 'fail' = false) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const path = call.url.replace('/api/v1', '');
    if (path.startsWith('/market/agents?') || path === '/market/agents') {
      const query = new URL(`http://x${path}`).searchParams;
      const items = AGENTS.filter(item => (!query.get('category') || item.category === query.get('category')) && (!query.get('q') || String(item.name).toLowerCase().includes(query.get('q')!.toLowerCase())));
      return json({ items, nextCursor: null });
    }
    const one = /^\/market\/agents\/([^/?]+)/.exec(path);
    if (one) { const found = AGENTS.find(item => item.id === decodeURIComponent(one[1])); return found ? json(detail(found)) : json({ error: { code: 'market_agent_not_found', message: 'gone' } }, 404); }
    if (path.endsWith('/route-usage')) return plan === 'fail' ? json({ error: { code: 'rate_limited', message: 'slow' } }, 429)
      : json({ limited: false, daily: { limit: 100, used: 1 }, interested: false, ...(plan ? { plan: { id: 'pro', credits: { granted: 2000, spent: 0, remaining: 2000 } } } : {}) });
    return json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const lists = (calls: Call[]) => calls.filter(call => call.url.startsWith('/api/v1/market/agents') && !/\/market\/agents\/[^?]/.test(call.url));
const card = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name}`) });
const page = (name: string) => screen.findByRole('article', { name: `${name} 的详情` });

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetMarketAgents(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browsing the market', () => {
  it('lists ranked Agents first and new ones apart, and asks again for each order, category and search', async () => {
    const calls = server();
    render(<AgentMarket tenantId="team" target={{ kind: 'canvas' }} catalogue={catalogue} onUse={vi.fn()} onClose={vi.fn()} />);
    expect(await card('Writer')).toHaveTextContent('成功率 90%');
    expect(screen.getByRole('button', { name: /^Writer/ })).toHaveTextContent('免费');
    expect(screen.getByRole('button', { name: /^Coder/ })).toHaveTextContent('每次 5 点');
    const fresh = screen.getByRole('heading', { name: '新上架' }).parentElement!;
    expect(within(fresh).getByRole('button', { name: /^Fresh/ })).toHaveTextContent('AwwO 官方');
    expect(within(fresh).queryByRole('button', { name: /^Writer/ })).toBeNull();
    expect(lists(calls).map(call => call.url)).toEqual(['/api/v1/market/agents?sort=score&limit=24']);

    fireEvent.change(screen.getByRole('combobox', { name: '排序' }), { target: { value: 'calls' } });
    await waitFor(() => expect(lists(calls).at(-1)?.url).toBe('/api/v1/market/agents?sort=calls&limit=24'));
    fireEvent.click(within(screen.getByRole('group', { name: '类别' })).getByRole('button', { name: '编程与工程' }));
    await waitFor(() => expect(lists(calls).at(-1)?.url).toBe('/api/v1/market/agents?category=code&sort=calls&limit=24'));
    expect(await screen.findByText('没有符合的 Agent。')).toBeVisible();
    fireEvent.click(within(screen.getByRole('group', { name: '类别' })).getByRole('button', { name: '全部' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 Agent' }), { target: { value: 'cod' } });
    await waitFor(() => expect(lists(calls).at(-1)?.url).toBe('/api/v1/market/agents?q=cod&sort=calls&limit=24'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Writer/ })).toBeNull());
    expect(screen.getByRole('button', { name: /^Coder/ })).toBeVisible();
  });

  it('shows an Agent’s page in plain words and adds it to the canvas with the model it brings', async () => {
    server();
    const use = vi.fn();
    render(<AgentMarket tenantId="team" target={{ kind: 'canvas' }} catalogue={catalogue} onUse={use} onClose={vi.fn()} />);
    const writer = await page('Writer');
    expect(writer).toHaveTextContent('About Writer');
    expect(writer).toHaveTextContent('Critic');
    expect(writer).toHaveTextContent('许可：MIT');
    expect(writer).toHaveTextContent('Write a haiku');
    expect(writer).toHaveTextContent('指令不公开');
    expect(writer).toHaveTextContent('节点会换成推荐模型「Claude Opus」');
    fireEvent.click(within(writer).getByRole('button', { name: '添加到画布' }));
    expect(use).toHaveBeenCalledOnce();
    expect(use.mock.calls[0][0]).toMatchObject({ id: 'writer', version: 2 });
    expect(use.mock.calls[0][1]).toEqual({ kind: 'apply', runtime: 'openai-agents', model: 'claude', effort: '', label: 'Claude Opus', userChosen: false });
  });

  it('keeps the node’s model for a suggestion only a person may choose, and blocks a locked model the workspace lacks', async () => {
    server();
    const use = vi.fn();
    render(<AgentMarket tenantId="team" target={{ kind: 'canvas' }} catalogue={catalogue} onUse={use} onClose={vi.fn()} />);
    fireEvent.click(await card('Chosen'));
    const chosen = await page('Chosen');
    expect(chosen).toHaveTextContent('只能由你自己选择，节点保留它现在的模型');
    fireEvent.click(within(chosen).getByRole('button', { name: '添加到画布' }));
    expect(use.mock.calls[0][1]).toMatchObject({ kind: 'keep', reason: 'user-chosen' });
    fireEvent.click(screen.getByRole('button', { name: /^Locked/ }));
    const locked = await page('Locked');
    expect(locked).toHaveTextContent('你的工作区用不了它');
    expect(within(locked).getByRole('button', { name: '添加到画布' })).toBeDisabled();
  });
});

describe('a paid Agent', () => {
  it('offers the plans instead of using it when the workspace’s owner has no paid plan', async () => {
    const calls = server(false);
    const use = vi.fn();
    render(<AgentMarket tenantId="team" target={{ kind: 'node', title: 'Draft' }} catalogue={catalogue} onUse={use} onClose={vi.fn()} />);
    fireEvent.click(await card('Coder'));
    const coder = await page('Coder');
    await waitFor(() => expect(within(coder).getByRole('note')).toHaveTextContent('工作区所有者有 Pro / Max 付费套餐才能用'));
    expect(within(coder).getByRole('link', { name: '查看 Pro / Max 套餐' })).toHaveAttribute('href', '/?account=plans');
    expect(within(coder).queryByRole('button', { name: '用在这个节点' })).toBeNull();
    expect(calls.some(call => call.url === '/api/v1/tenants/team/route-usage')).toBe(true);
    expect(use).not.toHaveBeenCalled();
  });

  it('can be used once the owner has a plan, and says the fee is taken only on success', async () => {
    server(true);
    const use = vi.fn();
    render(<AgentMarket tenantId="team" target={{ kind: 'node', title: 'Draft' }} catalogue={catalogue} onUse={use} onClose={vi.fn()} />);
    fireEvent.click(await card('Coder'));
    const coder = await page('Coder');
    expect(coder).toHaveTextContent('节点运行完成时扣费。Agent 已经写出内容后，运行被你停止、被你的节点自己的输出格式拒收、被截断、中途拒答或超时，也照常扣费');
    expect(coder).toHaveTextContent('作者锁定了模型「Claude Opus」，节点会用这个模型运行');
    fireEvent.click(await within(coder).findByRole('button', { name: '用在这个节点' }));
    expect(use.mock.calls[0][1]).toMatchObject({ kind: 'apply', model: 'claude', effort: 'high' });
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('choosing for a node that has one', () => {
  it('says the node uses this version, takes the Agent off, and shows a rejection on the Agent’s page', async () => {
    server();
    const detach = vi.fn();
    const use = vi.fn().mockRejectedValue(Object.assign(new Error('x'), {}));
    render(<AgentMarket tenantId="team" target={{ kind: 'node', title: 'Draft', current: { source: 'market', agentId: 'writer', version: 2 } }} catalogue={catalogue}
      onUse={use} onDetach={detach} onClose={vi.fn()} />);
    const writer = await page('Writer');
    expect(writer).toHaveTextContent('这个节点正在用这个版本。');
    expect(within(writer).getByRole('button', { name: '正在使用' })).toBeDisabled();
    fireEvent.click(within(writer).getByRole('button', { name: '不用 Agent' }));
    expect(detach).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /^Fresh/ }));
    const fresh = await page('Fresh');
    fireEvent.click(within(fresh).getByRole('button', { name: '用在这个节点' }));
    expect(await within(fresh).findByRole('alert')).toBeVisible();
  });

  it('offers to update a node locked to an older version', async () => {
    server();
    render(<AgentMarket tenantId="team" target={{ kind: 'node', title: 'Draft', current: { source: 'market', agentId: 'writer', version: 1 } }} catalogue={catalogue}
      onUse={vi.fn()} onDetach={vi.fn()} onClose={vi.fn()} />);
    const writer = await page('Writer');
    expect(writer).toHaveTextContent('这个节点用的是 v1，最新上架的是 v2。');
    expect(within(writer).getByRole('button', { name: '更新到 v2' })).toBeEnabled();
  });
});
