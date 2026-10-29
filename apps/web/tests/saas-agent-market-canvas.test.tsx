// A node's market Agent on a cloud canvas in the simple view (canvasMarket.tsx, MarketAgentChip.tsx): the composer's chip
// opens the market for the node, choosing saves the Agent (and the model it brings) on the node, and the chip takes it
// off again with the node's own persona intact. Media nodes get no chip, and a workspace without the market shows none.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { forgetMarketAgents } from '../src/saas/market/useMarket';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'claude', name: 'Claude Opus', runtime: 'openai-agents', provider: 'anthropic' }, { id: 'qwen', name: 'Qwen', runtime: 'openai-agents', provider: 'openai' }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] }] };
const capabilities = (market: boolean) => ({ skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: false, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 1 } },
  ...(market ? { market: { enabled: true, payouts: false, feeBps: 2500, maxPrice: 500, holdDays: 14 } } : {}) });
const writerAgent = { id: 'agent-w', name: 'Copy Pro', tagline: 'Sharp copy', category: 'writing', kind: 'llm', official: false, author: { name: 'Ada' }, price: 0, version: 2,
  model: { runtime: 'openai-agents', id: 'claude', effort: '', locked: false }, listedAt: null,
  stats: { calls: 40, users: 9, successRate: 0.9, up: 5, down: 1, avgSeconds: 40, avgModelCredits: 2, score: 0.7, ranked: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function serve(market: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = String(input);
    if (url.endsWith('/runtime')) return json(status);
    if (url.endsWith('/capabilities')) return json(capabilities(market));
    if (url.includes('/market/agents/agent-w')) return json({ ...writerAgent, description: 'Writes', examples: [], skills: [], instructionsPublic: false });
    if (url.includes('/market/agents')) return json({ items: [writerAgent], nextCursor: null });
    return json({ items: [] });
  }));
}
function seed(nodes: SessionNode[]) {
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes }));
}
const writer = (): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'writer', title: 'Writer', persona: 'MY OWN PERSONA', runtime: 'openai-agents', model: 'qwen' });
const stored = (id: string) => loadDocumentWithStatus().doc.nodes.find(node => node.id === id) as SessionNode;
const view = () => render(<CanvasUiModeProvider mode="simple"><CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} /></CanvasUiModeProvider>);

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); forgetMarketAgents(); configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('chooses a market Agent from a node’s composer in the simple view and takes it off again', async () => {
  serve(true);
  seed([writer()]);
  view();
  fireEvent.click(await screen.findByRole('button', { name: '打开 Writer' }));
  fireEvent.click(await screen.findByRole('button', { name: '选择 Agent' }));
  const dialog = await screen.findByRole('dialog', { name: 'Agent 市场' });
  expect(dialog).toHaveTextContent('为「Writer」选一个 Agent');
  const page = await within(dialog).findByRole('article', { name: 'Copy Pro 的详情' });
  fireEvent.click(await within(page).findByRole('button', { name: '用在这个节点' }));
  await waitFor(() => expect(stored('writer').agentRef).toEqual({ source: 'market', agentId: 'agent-w', version: 2 }));
  // The suggestion is one this workspace offers, so the node takes it; its own persona stays for later.
  expect(stored('writer')).toMatchObject({ runtime: 'openai-agents', model: 'claude', persona: 'MY OWN PERSONA', agentKind: 'llm' });
  expect(screen.queryByRole('dialog', { name: 'Agent 市场' })).toBeNull();
  expect(await screen.findByRole('button', { name: 'Agent：Copy Pro，点击更换' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '不用 Agent' }));
  await waitFor(() => expect(stored('writer').agentRef).toBeUndefined());
  expect(stored('writer').persona).toBe('MY OWN PERSONA');
  expect(await screen.findByRole('button', { name: '选择 Agent' })).toBeVisible();
});

it('shows no Agent chip on a media node, nor anywhere the workspace has no market', async () => {
  serve(true);
  seed([{ ...createSessionNode('image', { x: 0, y: 0 }), id: 'picture', title: 'Picture' }]);
  const first = view();
  fireEvent.click(await screen.findByRole('button', { name: '打开 Picture' }));
  // The opened node's own composer is drawn, with no Agent chip in it.
  await waitFor(() => expect(document.querySelector('[data-node-id="picture"] [data-testid="composer-send"]')).not.toBeNull());
  expect(screen.queryByRole('button', { name: '选择 Agent' })).toBeNull();
  first.unmount();
  serve(false);
  seed([writer()]);
  view();
  fireEvent.click(await screen.findByRole('button', { name: '打开 Writer' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: '这个组件使用的模型' })).toBeVisible());
  expect(screen.queryByRole('button', { name: '选择 Agent' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Agent 市场' })).toBeNull();
});

it('adds a node with a market Agent from the canvas bar', async () => {
  serve(true);
  seed([writer()]);
  view();
  fireEvent.click(await screen.findByRole('button', { name: 'Agent 市场' }));
  const dialog = await screen.findByRole('dialog', { name: 'Agent 市场' });
  fireEvent.click(await within(dialog).findByRole('button', { name: '添加到画布' }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
  const added = loadDocumentWithStatus().doc.nodes.find(node => node.id !== 'writer') as SessionNode;
  expect(added).toMatchObject({ title: 'Copy Pro', persona: '', agentRef: { source: 'market', agentId: 'agent-w', version: 2 }, model: 'claude' });
});
