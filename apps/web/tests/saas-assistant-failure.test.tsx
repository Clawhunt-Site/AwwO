import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { failureRequestKind } from '../src/canvas/nextSteps';
import { loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';
import { recoveryDetailMessage } from '../src/canvas/surfaceMessages';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// A user's report, 2026-10-11: 「画布的最后一个节点运行失败了」 went to a direct task, which saw an empty workspace and
// asked what a canvas was. The canvas ran the nodes; it answers.
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true });
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
const FORMAT = 'Output must be a JSON object keyed by output field IDs';
let posted: Array<{ scope?: string[] }>;
let outcome: 'failed' | 'running';
const graph = (status: string) => ({ id: 'graph', operationId: loadRunJournal()?.id, status, canvasId: 'canvas', documentVersion: 9,
  nodes: status === 'failed'
    ? [{ nodeId: 'frontend', state: 'failed', detail: FORMAT, threadId: 'default', agentId: 'agent-frontend', sessionId: 'session-frontend' },
      { nodeId: 'review', state: 'blocked', detail: 'Upstream did not complete', threadId: 'default', agentId: 'agent-review', sessionId: 'session-review' }]
    : ['frontend', 'review'].map(nodeId => ({ nodeId, state: 'waiting', threadId: 'default', agentId: `agent-${nodeId}`, sessionId: `session-${nodeId}` })) });

function bound(node: SessionNode): SessionNode {
  return { ...node, runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: `agent-${node.id}`, agentName: node.title }, issueId: `session-${node.id}` };
}
function seed() {
  const frontend = createAgentTemplate('frontend', { x: 40, y: 40 });
  const review = createAgentTemplate('review', { x: 700, y: 40 });
  const filled = (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => ({ ...field, value: field.value || 'given' })) } });
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
    bound(filled({ ...frontend, id: 'frontend', title: '3D游戏前端实现' })), bound(filled({ ...review, id: 'review', title: '游戏验收' })),
  ], edges: [{ id: 'delivery', fromNode: 'frontend', fromPort: 'out:delivery', toNode: 'review', toPort: 'in:delivery', dataType: 'text' }] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); posted = []; outcome = 'failed';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(graph('running')), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(graph(posted.length > 1 ? 'running' : outcome)));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function failedRun() {
  seed();
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(toggle());
  fireEvent.click(within(sidebar().getByRole('group', { name: '接下来' })).getByRole('button', { name: /^运行整张画布/ }));
  await waitFor(() => expect(posted).toHaveLength(1));
  await waitFor(() => expect(within(sidebar().getByRole('group', { name: '接下来' })).getByText('「3D游戏前端实现」上次运行失败了。')).toBeVisible());
}

async function send(text: string) {
  const box = sidebar().getByRole('textbox', { name: '画布需求' });
  fireEvent.change(box, { target: { value: text } });
  const sendButton = () => sidebar().getByRole('button', { name: '修改画布' });
  await waitFor(() => expect(sendButton()).toBeEnabled());
  fireEvent.click(sendButton());
  return box;
}

describe('a message about the last run’s failure', () => {
  it('says what failed and why, and runs the failed node and what it feeds again', async () => {
    await failedRun();
    const box = await send('画布的最后一个节点运行失败了');
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText('「3D游戏前端实现」上次运行失败：交回的结果不符合这个组件的交付格式（模型没按要求的字段给出）。'
      // What the rerun spends is said too: the failed node and the review it feeds.
      + '重新运行通常就能好；如果反复出现，可以换一个模型。现在重新运行失败的节点和它们后面的 1 个节点，完成后结果会更新在画布和成果里。至少会用 2 次调用。')).toBeVisible());
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].scope).toEqual(['frontend', 'review']);
    expect(box).toHaveValue('');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => /assistant\/route|computer-runs|\/plan/.test(String(url)))).toEqual([]);
  });

  it('only explains when asked why', async () => {
    await failedRun();
    await send('为什么失败了');
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText(/^「3D游戏前端实现」上次运行失败：交回的结果不符合这个组件的交付格式.*建议下一步：查看失败原因。$/)).toBeVisible());
    expect(posted).toHaveLength(1);
  });
});

describe('which messages are about the failure', () => {
  it.each(['画布的最后一个节点运行失败了', '处理失败', '节点报错了，帮我修一下', '又失败了', 'it failed', 'the last node failed, fix it'])('acts on %s', text => {
    expect(failureRequestKind(text)).toBe('fix');
  });
  it.each(['为什么失败了', '失败原因是什么', 'why did it fail'])('explains %s', text => {
    expect(failureRequestKind(text)).toBe('why');
  });
  it.each(['你找找有没其它目录', '失败的节点改成用 React 写', '帮我把登录页的错误提示改成红色', '没有失败啊', '帮我写一份项目失败原因的分析报告',
    'write a report on why startups fail', 'it did not fail', 'change the failed node to React', ''])('leaves %s to the assistant', text => {
    expect(failureRequestKind(text)).toBeNull();
  });
});

describe('a delivery-format refusal', () => {
  it('reads as what it means, in the reader’s words', () => {
    const t = (key: string) => key;
    for (const detail of [FORMAT, 'Missing output delivery', 'Output preview requires a string or {name, content}', 'Output count requires number'])
      expect(recoveryDetailMessage(t as never, detail)).toBe('surface.deliveryFormat');
    expect(recoveryDetailMessage(t as never, 'provider said no')).toBe('provider said no');
  });
});
