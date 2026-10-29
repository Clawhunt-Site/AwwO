// A run made with a market Agent (MarketRunFee.tsx, beside a run's outcome in the node's conversation): the Agent's fee
// and where it stands, an author's own call said as such, and 👍 / 👎 on a completed run sent to the run's rating. And
// the workspace home's strip of the best-ranked Agents, which starts a canvas with the one chosen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MarketRunFee } from '../src/saas/market/MarketRunFee';
import { MarketHomeStrip } from '../src/saas/market/MarketHomeStrip';
import { TeamRunDetails } from '../src/saas/TeamRunDetails';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { forgetMarketAgents } from '../src/saas/market/useMarket';
import type { MarketRunInfo } from '../src/saas/marketApi';
import type { Tenant } from '../src/saas/api';

type Call = { url: string; method: string; body: any };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fee = (patch: Partial<MarketRunInfo> = {}): MarketRunInfo => ({ agentId: 'agent-1', version: 2, price: 5, status: 'charged', insider: false, rating: 0, ...patch });
const tenant = { id: 'team', name: 'Team', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 } as Tenant;
const agent = (index: number) => ({ id: `agent-${index}`, name: `Agent ${index}`, tagline: '', category: 'code', kind: 'llm', official: true, author: null, price: 0, version: 1,
  model: { runtime: '', id: '', effort: '', locked: false }, listedAt: null,
  stats: { calls: 100 - index, users: 10, successRate: 0.9, up: 1, down: 0, avgSeconds: null, avgModelCredits: null, score: 0.9, ranked: true } });

function server(handle: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handle(call) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetMarketAgents(); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a run’s Agent fee', () => {
  it('says what the fee is and where it stands, and rates a completed run (pressing the rating again takes it back)', async () => {
    // The server answers the rating it now holds (market_use.go rateMarketRun).
    const calls = server(call => call.method === 'PUT' ? json({ score: call.body.score }) : undefined);
    render(<MarketRunFee tenantId="team" runId="run 1" market={fee()} completed canRate />);
    const group = screen.getByRole('group', { name: '市场 Agent' });
    expect(group).toHaveTextContent('Agent 费用：每次 5 点 · 已扣');
    fireEvent.click(within(group).getByRole('button', { name: '好评' }));
    await waitFor(() => expect(within(group).getByRole('button', { name: '好评' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(within(group).getByRole('button', { name: '好评' }));
    await waitFor(() => expect(within(group).getByRole('button', { name: '好评' })).toHaveAttribute('aria-pressed', 'false'));
    fireEvent.click(within(group).getByRole('button', { name: '差评' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map(call => [call.method, call.url, call.body])).toEqual([
      ['PUT', '/api/v1/tenants/team/runs/run%201/market-rating', { score: 1 }],
      ['PUT', '/api/v1/tenants/team/runs/run%201/market-rating', { score: 0 }],
      ['PUT', '/api/v1/tenants/team/runs/run%201/market-rating', { score: -1 }],
    ]);
  });

  it('offers no rating before a run completes, to a reader, or on its author’s own call, and names each fee state', () => {
    server();
    const { rerender } = render(<MarketRunFee tenantId="team" runId="r" market={fee({ status: 'reserved' })} completed={false} canRate />);
    expect(screen.getByRole('group')).toHaveTextContent('预扣（运行结束时结算）');
    expect(screen.queryByRole('button', { name: '好评' })).toBeNull();
    rerender(<MarketRunFee tenantId="team" runId="r" market={fee({ status: 'released' })} completed canRate={false} />);
    expect(screen.getByRole('group')).toHaveTextContent('未扣');
    expect(screen.queryByRole('button', { name: '好评' })).toBeNull();
    // A run that completed without the Agent's text was not charged, and its rating would count for nothing.
    rerender(<MarketRunFee tenantId="team" runId="r" market={fee({ status: 'released' })} completed canRate />);
    expect(screen.queryByRole('button', { name: '好评' })).toBeNull();
    // Stopped after the Agent had written: charged, said why, and rated like a completed run.
    rerender(<MarketRunFee tenantId="team" runId="r" market={fee({ status: 'charged' })} completed={false} canRate />);
    expect(screen.getByRole('group')).toHaveTextContent('已扣（Agent 已经写出了内容，内容归你，所以照常计费）');
    expect(screen.getByRole('button', { name: '好评' })).toBeVisible();
    rerender(<MarketRunFee tenantId="team" runId="r" market={fee({ insider: true, price: 5 })} completed canRate />);
    expect(screen.getByRole('group')).toHaveTextContent('作者本人或在作者自己的工作区里的调用：不收 Agent 费用，也不计入排行');
    expect(screen.queryByRole('button', { name: '好评' })).toBeNull();
    rerender(<MarketRunFee tenantId="team" runId="r" market={fee({ price: 0 })} completed canRate />);
    expect(screen.getByRole('group')).toHaveTextContent('免费 Agent');
  });

  it('shows beside a node’s run in its conversation, even with the run’s details folded', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    server(call => call.url.endsWith('/runs/run-1') ? json({ id: 'run-1', tenantId: 'team', status: 'completed', executionKind: 'text', market: fee({ status: 'charged' }) })
      : call.url.endsWith('/turns') ? json({ items: [] }) : undefined);
    render(<SaaSPreferencesProvider><TeamRunDetails tenantId="team" runId="run-1" defaultOpen /></SaaSPreferencesProvider>);
    expect(await screen.findByRole('group', { name: '市场 Agent' })).toHaveTextContent('Agent 费用：每次 5 点 · 已扣');
    expect(screen.getByRole('button', { name: '好评' })).toBeVisible();
  });
});

describe('the home strip', () => {
  it('shows the best-ranked Agents and starts a canvas with the one chosen', async () => {
    const opened = vi.fn();
    const calls = server(call => {
      const path = call.url.replace('/api/v1', '');
      if (path.endsWith('/capabilities')) return json({ skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false }, render: { enabled: false },
        market: { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14 } });
      if (path.startsWith('/market/agents?')) return json({ items: Array.from({ length: 8 }, (_, index) => agent(index + 1)), nextCursor: 'more' });
      if (path.startsWith('/market/agents/')) return json({ ...agent(Number(path.split('-')[1])), description: '', examples: [], skills: [], instructionsPublic: true, instructions: 'Official text' });
      if (path.endsWith('/runtime')) return json({ configured: true, available: true, models: [] });
      if (path.endsWith('/canvases') && call.method === 'POST') return json({ id: 'canvas-new', tenantId: 'team', name: call.body.name, document: call.body.document, version: 1 }, 201);
      return undefined;
    });
    render(<SaaSPreferencesProvider><MarketHomeStrip tenant={tenant} onOpen={opened} /></SaaSPreferencesProvider>);
    const strip = await screen.findByRole('region', { name: 'Agent 市场' });
    await waitFor(() => expect(within(strip).getAllByRole('button', { name: /^Agent \d/ })).toHaveLength(6));
    expect(calls.find(call => call.url.includes('/market/agents?'))?.url).toBe('/api/v1/market/agents?sort=score&limit=6');
    fireEvent.click(within(strip).getByRole('button', { name: /^Agent 2/ }));
    const page = await screen.findByRole('article', { name: 'Agent 2 的详情' });
    expect(page).toHaveTextContent('AwwO 官方');
    expect(page).toHaveTextContent('AwwO 官方 Agent 的指令是公开的');
    fireEvent.click(await within(page).findByRole('button', { name: '新建画布使用' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('canvas-new'));
    const created = calls.find(call => call.method === 'POST')!;
    expect(created.body.name).toBe('Agent 2');
    expect(created.body.document.nodes).toHaveLength(1);
    expect(created.body.document.nodes[0]).toMatchObject({ title: 'Agent 2', persona: '', agentRef: { source: 'market', agentId: 'agent-2', version: 1 } });
  });

  it('lets a reader browse only, and stays away where the market is off', async () => {
    server(call => {
      const path = call.url.replace('/api/v1', '');
      if (path.endsWith('/capabilities')) return json({ skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false }, render: { enabled: false },
        market: { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14 } });
      if (path.startsWith('/market/agents?')) return json({ items: [agent(1)], nextCursor: null });
      if (path.startsWith('/market/agents/')) return json({ ...agent(1), description: '', examples: [], skills: [], instructionsPublic: false });
      if (path.endsWith('/runtime')) return json({ configured: true, available: true, models: [] });
      return undefined;
    });
    const view = render(<SaaSPreferencesProvider><MarketHomeStrip tenant={{ ...tenant, role: 'reader' }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '查看全部' }));
    const page = await screen.findByRole('article', { name: 'Agent 1 的详情' });
    expect(within(page).queryByRole('button', { name: '新建画布使用' })).toBeNull();
    view.unmount();
    server(call => call.url.endsWith('/capabilities') ? json({ skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false }, render: { enabled: false } }) : undefined);
    const { container } = render(<SaaSPreferencesProvider><MarketHomeStrip tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
