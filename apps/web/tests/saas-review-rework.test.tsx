import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { RunControls } from '../src/canvas/RunControls';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';
import type { TaskFrame } from '../src/canvas/taskFrame';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// A hosted canvas whose acceptance node ran and concluded 不通过 (a real user's report, 2026-10-10).
const REPORT = '结论：不通过。前端实现与后端接口契约存在重大不一致（路径、资源模型、响应字段均不匹配），若按当前实现联调将大面积 404。需修复后方可进入下一轮验收。\n验收范围：18 个前端页面';
const ISSUES = '问题：线索列表调用 /leads，契约为 /api/v1/leads\n修复建议：按接口契约统一路径与响应字段';
const LEAD = '「小程序产品交付验收」的结论是「不通过」：前端实现与后端接口契约存在重大不一致（路径、资源模型、响应字段均不匹配），若按当前实现联调将大面积 404。';
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true });
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
let submitted: { scope?: string[] } | null;
const graph = (status: string) => ({ id: 'graph', operationId: loadRunJournal()?.id, status, canvasId: 'canvas', documentVersion: 9,
  nodes: ['frontend', 'review'].map(nodeId => ({ nodeId, state: 'waiting', threadId: 'default', agentId: `agent-${nodeId}`, sessionId: `session-${nodeId}` })) });

function bound(node: SessionNode): SessionNode {
  return { ...node, runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: `agent-${node.id}`, agentName: node.title }, issueId: `session-${node.id}` };
}
function seed() {
  const frontend = createAgentTemplate('frontend', { x: 40, y: 40 });
  const review = createAgentTemplate('review', { x: 700, y: 40 });
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
    bound({ ...frontend, id: 'frontend', title: '心理咨询小程序前端开发',
      contract: { ...frontend.contract!, inputs: frontend.contract!.inputs.map(field => field.id === 'api' ? { ...field, value: 'GET /api/v1/leads' } : field) },
      lastOutput: { text: JSON.stringify({ delivery: '实现页面：18 个' }), at: 1, source: 'run' } }),
    bound({ ...review, id: 'review', title: '小程序产品交付验收',
      lastOutput: { text: JSON.stringify({ report: REPORT, issues: ISSUES }), at: 2, source: 'run' } }),
  ], edges: [{ id: 'delivery', fromNode: 'frontend', fromPort: 'out:delivery', toNode: 'review', toPort: 'in:delivery', dataType: 'text' }] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); submitted = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { submitted = JSON.parse(String(init.body)); return new Response(JSON.stringify(graph('running')), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(graph('running')));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a review that did not pass, on a hosted canvas', () => {
  it('says what the review found and reworks the delivery from it in one click, review included', async () => {
    seed();
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    // Unasked: the closed assistant is marked, because "7/7 succeeded" is not the end of it.
    expect(toggle()).toHaveClass('has-hint');
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    expect(next.getByText(LEAD)).toBeVisible();
    expect(next.getByRole('button', { name: '查看验收报告' })).toBeVisible();
    fireEvent.click(next.getByRole('button', { name: '按验收意见返工「心理咨询小程序前端开发」（至少 2 次）' }));
    // The Agent whose delivery was checked runs again, and so does the review it feeds.
    await waitFor(() => expect(submitted?.scope).toEqual(['frontend', 'review']));
    const frame = (loadDocumentWithStatus().doc.nodes.find(node => node.id === 'frontend') as SessionNode).taskFrame as TaskFrame;
    expect(frame.constraints).toHaveLength(1);
    expect(frame.constraints[0]).toMatch(/^【验收返工·小程序产品交付验收】上次验收结论：不通过。请按下面的验收意见修改交付/);
    expect(frame.constraints[0]).toContain(`### 问题与返工清单\n${ISSUES}`);
  });

  it('answers “the review failed, what do I do?” from the canvas, without spending a call', async () => {
    seed();
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(toggle());
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '我看到运行后验收不通过，我该怎么办？' } });
    // A hosted composer sends once the planner and its recovery check have answered.
    const sendButton = () => sidebar().getByRole('button', { name: '修改画布' });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const requests = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(sendButton());
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText('我看到运行后验收不通过，我该怎么办？')).toBeVisible());
    expect(log.getByText(`${LEAD}建议下一步：按验收意见返工「心理咨询小程序前端开发」（至少 2 次）。点它会把验收意见交给「心理咨询小程序前端开发」修改，`
      + '再重新运行它和「小程序产品交付验收」。（这是按画布本地检查的，没有用掉次数。）')).toBeVisible();
    expect(box).toHaveValue('');
    expect(vi.mocked(fetch).mock.calls.slice(requests).filter(([url]) => /plan|runs/.test(String(url)))).toEqual([]);
  });
});

describe('the finished-run note', () => {
  it('adds a review’s verdict to a run whose nodes all succeeded, with a way to the next steps', () => {
    const next = vi.fn();
    render(<RunControls nodes={[]} edges={[]} running={false} runs={{}} onStart={vi.fn()} onStop={vi.fn()}
      summary={{ ok: true, done: 7, failed: 0, blocked: 0, cancelled: 0, cached: 0, total: 7 }}
      reviewNote="「小程序产品交付验收」验收结论：不通过。" onReviewNext={next} />);
    expect(screen.getByRole('status')).toHaveTextContent('运行完成：7/7 节点成功。「小程序产品交付验收」验收结论：不通过。');
    fireEvent.click(screen.getByRole('button', { name: '看下一步' }));
    expect(next).toHaveBeenCalledOnce();
  });
});
