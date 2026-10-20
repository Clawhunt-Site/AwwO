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
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
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

  it('answers “continue” with the review’s advice, not that nothing is left to run (review of the Next card fix)', async () => {
    seed();
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(toggle());
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '继续运行' } });
    const sendButton = () => sidebar().getByRole('button', { name: '修改画布' });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText(new RegExp(`^${LEAD}建议下一步：按验收意见返工「心理咨询小程序前端开发」`))).toBeVisible());
    expect(log.queryByText(/所有节点都已经有结果了/)).toBeNull();
    expect(submitted).toBeNull();
  });
});

// The presses the operator asked to count (2026-10-12): which of 「看下一步」, 「查看验收报告」 and the page's own answers
// people use. Each is one POST naming the button; nothing from the canvas goes with it.
const counted = () => vi.mocked(fetch).mock.calls.flatMap(([url, init]) => String(url).endsWith('/tenants/workspace/canvases/canvas/ui-events')
  && (init as RequestInit | undefined)?.method === 'POST' ? [JSON.parse(String((init as RequestInit).body))] : []);

describe('what the operator counts', () => {
  it('counts 查看验收报告 and a question answered on the page, and sends nothing else', async () => {
    seed();
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(toggle());
    fireEvent.click(within(sidebar().getByRole('group', { name: '接下来' })).getByRole('button', { name: '查看验收报告' }));
    await waitFor(() => expect(counted()).toEqual([{ name: 'review.open_report' }]));
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '验收没通过怎么办' } });
    const sendButton = () => sidebar().getByRole('button', { name: '修改画布' });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    await waitFor(() => expect(counted()).toEqual([{ name: 'review.open_report' }, { name: 'assistant.local_answer' }]));
    // A message the assistant does handle is not one of these.
    fireEvent.change(box, { target: { value: '把交付验收的标准改成只看接口契约' } });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/plan|assistant\/route/.test(String(url)))).toBe(true));
    expect(counted()).toHaveLength(2);
  });

  it('counts the run note’s 看下一步 when a rework’s review still does not pass', async () => {
    seed();
    const done = () => ({ ...graph('completed'), nodes: [
      { nodeId: 'frontend', state: 'done', output: JSON.stringify({ delivery: '实现页面：18 个，路径已按契约改' }), threadId: 'default', agentId: 'agent-frontend', sessionId: 'session-frontend' },
      { nodeId: 'review', state: 'done', output: JSON.stringify({ report: REPORT, issues: ISSUES }), threadId: 'default', agentId: 'agent-review', sessionId: 'session-review' },
    ] });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/graph-runs') && init.method === 'POST') { submitted = JSON.parse(String(init.body)); return new Response(JSON.stringify(done()), { status: 202 }); }
      if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(done()));
      return base(input as RequestInfo, init);
    });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(toggle());
    fireEvent.click(within(sidebar().getByRole('group', { name: '接下来' })).getByRole('button', { name: /^按验收意见返工/ }));
    await waitFor(() => expect(submitted?.scope).toEqual(['frontend', 'review']));
    const note = await screen.findByText(/「小程序产品交付验收」验收结论：不通过。/);
    fireEvent.click(toggle());
    fireEvent.click(within(note.closest('[role="status"]') as HTMLElement).getByRole('button', { name: '看下一步' }));
    await waitFor(() => expect(counted()).toEqual([{ name: 'review.next_steps' }]));
    expect(sidebar().getByRole('group', { name: '接下来' })).toBeVisible();
  });
});

describe('普通用户模式', () => {
  it('shows the reworked Agent the findings it was given, though its settings are out of sight', async () => {
    seed();
    render(<CanvasUiModeProvider mode="simple"><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></CanvasUiModeProvider>);
    // The chat-first mode may already show the assistant.
    if (toggle().getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle());
    fireEvent.click(within(sidebar().getByRole('group', { name: '接下来' })).getByRole('button', { name: /^按验收意见返工/ }));
    await waitFor(() => expect(submitted?.scope).toEqual(['frontend', 'review']));
    fireEvent.click(screen.getByRole('button', { name: '打开 心理咨询小程序前端开发', exact: true }));
    const tile = within(screen.getByTestId('canvas-tile-frontend'));
    expect(tile.queryByRole('button', { name: '配置' })).toBeNull();
    fireEvent.click(tile.getByRole('button', { name: /带着「小程序产品交付验收」的验收意见/ }));
    const findings = tile.getByRole('region', { name: '这个节点的验收意见' });
    expect(findings).toHaveTextContent('上次验收结论：不通过。请按下面的验收意见修改交付');
    expect(findings).toHaveTextContent('问题：线索列表调用 /leads，契约为 /api/v1/leads');
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
