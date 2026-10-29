// A node's market Agent in its settings (InspectorPanel + MarketAgentBox.tsx): the Agent, its version, price and author;
// a newer listed version to update to; the node's own persona and skills kept but replaced by a note while the Agent is
// on; a locked model shown and not offered; and choosing, updating and taking the Agent off through the settings' own
// 保存并准备运行. A node with a persona offers to publish it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { forgetMarketAgents } from '../src/saas/market/useMarket';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import type { InspectorMarket } from '../src/canvas/marketAgents';
import type { ModelPaletteGroup, ModelPaletteSelection } from '../src/canvas/modelPalette';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const model = (id: string, name: string): ModelPaletteSelection => ({ key: JSON.stringify(['openai-agents', id]), label: name, displayName: name, providerGroup: 'claude',
  runtime: 'openai-agents', model: id, available: true });
const models = [model('claude', 'Claude Opus'), model('qwen', 'Qwen')];
const groups: ModelPaletteGroup[] = [{ id: 'claude', label: 'Claude', models, available: true }];
const version = (number: number, patch: Record<string, unknown> = {}) => ({ id: 'agent-1', name: 'Copy Pro', tagline: '', category: 'writing', kind: 'llm', official: false,
  author: { name: 'Ada' }, price: number === 1 ? 2 : 5, version: number, model: { runtime: 'openai-agents', id: 'claude', effort: '', locked: false }, listedAt: null,
  stats: { calls: 0, users: 0, successRate: null, up: 0, down: 0, avgSeconds: null, avgModelCredits: null, score: null, ranked: false },
  description: '', examples: [], skills: [], instructionsPublic: false, ...patch });

function serve(listed: Record<string, unknown>, pinned?: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/market/agents/agent-1')) return json(listed);
    if (url.endsWith('/market/agents/agent-1?version=1')) return json(pinned ?? listed);
    if (url.includes('/skills')) return json({ items: [], limits: { maxNodeSkills: 4, maxNodeSkillBytes: 20480, maxSkillBodyBytes: 12288, maxWorkspaceSkills: 100 } });
    return json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
}
const node = (patch: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'writer', title: 'Writer', persona: 'MY OWN PERSONA',
  runtime: 'openai-agents', model: 'qwen', skills: ['builtin:critic'], ...patch });
const host = (patch: Partial<InspectorMarket> = {}): InspectorMarket => ({ pick: vi.fn(), publish: vi.fn(), catalogue: models, ...patch });
/** `market` null: a workspace without the market. */
function open(start: SessionNode, market: InspectorMarket | null = host(), initialize = vi.fn(async () => {})) {
  render(<InspectorPanel node={start} liveCompanies={[{ id: 'tenant', name: 'Workspace' }]} apiBase="/api" onSave={vi.fn()} onClose={vi.fn()}
    onInitialize={initialize} modelGroups={groups} market={market ?? undefined} />);
  return initialize;
}
const box = () => screen.findByRole('group', { name: '市场 Agent' });

beforeEach(() => { forgetMarketAgents(); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a node with a market Agent', () => {
  it('shows the Agent at the node’s version and updates it to the listed one on save', async () => {
    serve(version(2), version(1));
    const initialize = open(node({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 } }));
    const shown = await box();
    await waitFor(() => expect(shown).toHaveTextContent('市场 Agent：Copy Pro'));
    expect(shown).toHaveTextContent('v1');
    await waitFor(() => expect(shown).toHaveTextContent('每次 2 点'));
    expect(shown).toHaveTextContent('Ada');
    expect(shown).toHaveTextContent('有新版本 v2 · 每次 5 点');
    // While the Agent is on, its instructions and skills apply: the node's own are not edited here.
    expect(screen.queryByLabelText('人设 / 系统提示词')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('指令和技能由这个市场 Agent 提供');
    expect(screen.queryByRole('region', { name: '技能' })).toBeNull();
    fireEvent.click(within(shown).getByRole('button', { name: '更新' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(initialize.mock.calls[0][0]).toMatchObject({ agentRef: { source: 'market', agentId: 'agent-1', version: 2 }, runtime: 'openai-agents', model: 'claude',
      persona: 'MY OWN PERSONA', skills: ['builtin:critic'] });
  });

  it('offers a paid newer version only where the workspace owner has a plan', async () => {
    configureSaaSCanvas({ tenant: { id: 'team', name: 'Team', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 }, canvasId: 'canvas' });
    const listed = version(2);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/market/agents/agent-1') ? json(listed)
      : url.endsWith('/market/agents/agent-1?version=1') ? json(version(1))
      : url.endsWith('/route-usage') ? json({ limited: false, daily: { limit: 100, used: 0 }, interested: false }) : json({ error: { code: 'not_found', message: 'x' } }, 404)));
    open(node({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 } }));
    const shown = await box();
    await waitFor(() => expect(shown).toHaveTextContent('付费版本需要工作区所有者有 Pro / Max 套餐'));
    expect(within(shown).queryByRole('button', { name: '更新' })).toBeNull();
    expect(within(shown).getByRole('link', { name: '查看套餐' })).toHaveAttribute('href', '/?account=plans');
    clearSaaSCanvas();
  });

  it('takes the Agent off on save and gives the node its own persona and skills back', async () => {
    serve(version(1));
    const initialize = open(node({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 } }));
    fireEvent.click(within(await box()).getByRole('button', { name: '不用 Agent' }));
    expect(screen.getByLabelText('人设 / 系统提示词')).toHaveValue('MY OWN PERSONA');
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(initialize.mock.calls[0][0]).toMatchObject({ agentRef: undefined, persona: 'MY OWN PERSONA', skills: ['builtin:critic'] });
  });

  it('shows a locked model without offering another, and opens the market to choose a different Agent', async () => {
    serve(version(1, { model: { runtime: 'openai-agents', id: 'claude', effort: '', locked: true } }));
    const market = host();
    const start = node({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 }, model: 'claude' });
    open(start, market);
    expect(await screen.findByText('这个 Agent 的作者锁定了模型：用它的节点只能用这个模型。')).toBeVisible();
    expect(screen.getByLabelText('模型')).toHaveTextContent('claude');
    expect(screen.queryByRole('combobox', { name: '模型' })).toBeNull();
    fireEvent.click(within(await box()).getByRole('button', { name: '换一个' }));
    expect(market.pick).toHaveBeenCalledOnce();
    expect((market.pick as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: 'writer', agentRef: { version: 1 } });
  });

  it('applies the market’s choice to the settings’ draft', async () => {
    serve(version(1));
    const market = host({ pick: vi.fn((draft: SessionNode, apply: (next: SessionNode) => void) => apply({ ...draft, agentRef: { source: 'market', agentId: 'agent-1', version: 1 }, model: 'claude' })) });
    const initialize = open(node(), market);
    fireEvent.click(screen.getByRole('button', { name: '从 Agent 市场选一个 Agent' }));
    expect(await box()).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(initialize.mock.calls[0][0]).toMatchObject({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 }, model: 'claude', persona: 'MY OWN PERSONA' });
  });
});

describe('publishing a node', () => {
  it('offers to publish a text node with a persona, and not a node without one or one using a market Agent', () => {
    serve(version(1));
    const market = host();
    open(node(), market);
    fireEvent.click(screen.getByRole('button', { name: '发布到 Agent 市场' }));
    expect(market.publish).toHaveBeenCalledOnce();
    expect((market.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: 'writer', persona: 'MY OWN PERSONA', skills: ['builtin:critic'] });
    cleanup();
    open(node({ persona: '' }), host());
    expect(screen.queryByRole('button', { name: '发布到 Agent 市场' })).toBeNull();
    cleanup();
    open(node({ agentRef: { source: 'market', agentId: 'agent-1', version: 1 } }), host());
    expect(screen.queryByRole('button', { name: '发布到 Agent 市场' })).toBeNull();
    cleanup();
    // Where the workspace has no market, nothing of it is offered.
    open(node(), null);
    expect(screen.queryByRole('button', { name: '发布到 Agent 市场' })).toBeNull();
    expect(screen.queryByRole('button', { name: '从 Agent 市场选一个 Agent' })).toBeNull();
  });
});
