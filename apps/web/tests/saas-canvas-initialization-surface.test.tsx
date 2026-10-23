import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { loadRunJournal } from '../src/canvas/runJournal';
import { getNodeThreads } from '../src/canvas/nodeThreads';
import { resetAllSessions } from '../src/canvas/sessions';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
let journalAtSubmission: ReturnType<typeof loadRunJournal>;
const completedGraph = () => ({ id: 'graph', operationId: journalAtSubmission?.id, status: 'completed', canvasId: 'canvas', documentVersion: 9,
  nodes: [{ nodeId: 'Draft node', state: 'done', output: 'Done', threadId: 'default', agentId: 'new-agent', sessionId: 'new-session' }] });
beforeEach(() => {
  localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); journalAtSubmission = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { journalAtSubmission = loadRunJournal(); return new Response(JSON.stringify(completedGraph()), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(completedGraph()));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function seed(bound = false) {
  const node = { ...createSessionNode('llm', { x: 50, y: 50 }), id: 'Draft node', title: 'Draft node', persona: 'Original persona',
    ...(bound ? { runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: 'old-agent', agentName: 'Draft node' }, issueId: 'old-session' } : {}) };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
}
function canonical(document: CanvasDocument, runtime = 'pi', model = 'profile-main'): CanvasDocument {
  return sanitizeDocument({ ...document, nodes: document.nodes.map(node => node.kind !== 'session' ? node : { ...node,
    ...(node.threads ? { threads: node.threads.map(thread => thread.id !== node.activeThreadId ? thread : { ...thread, binding: { companyId: tenant.id, agentId: 'new-agent', agentName: node.title }, issueId: 'new-session', runtime, model }) } : {}),
    runtime, model, binding: { companyId: tenant.id, agentId: 'new-agent', agentName: node.title }, issueId: 'new-session',
  }) });
}
it('routes empty hosted model catalogues according to who owns the credential', async () => {
  const view = render(<CanvasSurface storageMode="cloud" personalCredentialsRequired runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '展开模型' }));
  expect(await screen.findByRole('link', { name: '配置我的模型连接 ↗' })).toHaveAttribute('href', expect.stringContaining('account=engines'));
  view.rerender(<CanvasSurface storageMode="cloud" personalCredentialsRequired={false} runtimeReadJson={reader} />);
  await screen.findByText('当前没有可用模型。请联系工作区管理员检查模型权限和服务状态。');
  expect(screen.queryByRole('link', { name: '配置我的模型连接 ↗' })).toBeNull();
  expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled();
});
it('shows the model controls when a 390px canvas first opens its model drawer', () => {
  vi.stubGlobal('innerWidth', 390);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '打开模型库' }));
  const modelBody = document.querySelector('.awwo-model-sidebar .model-persona-shelf-body');
  expect(modelBody).not.toBeNull();
  expect(modelBody).not.toHaveAttribute('hidden');
  expect(screen.getByRole('heading', { name: '执行模型' })).toBeVisible();
});
async function openInspector() {
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  await waitFor(() => expect(screen.getByRole('button', { name: /保存配置|保存并准备运行/ })).not.toBeDisabled());
}
it('saves cloud node configuration without initializing when execution is unavailable', async () => {
  seed(true);
  const initialize = vi.fn();
  configureSaaSCanvasInitialize(initialize);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader}
    executionUnavailableReason="请先连接执行引擎。" />);
  expect(screen.getByRole('button', { name: /运行图/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  const inspector = screen.getByRole('dialog', { name: '节点配置 — Draft node' });
  fireEvent.change(screen.getByLabelText(/系统提示词|人格/), { target: { value: 'Saved without running' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  await waitFor(() => expect(inspector).not.toBeInTheDocument());
  expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ persona: 'Saved without running' });
  expect(initialize).not.toHaveBeenCalled();
  expect(loadRunJournal()).toBeNull();
});
it('initializes a draft before graph journaling and executes the returned Agent/session identity', async () => {
  seed(); const initialize = vi.fn(async () => { expect(loadRunJournal()).toBeNull(); return canonical(loadDocumentWithStatus().doc); });
  configureSaaSCanvasInitialize(initialize); render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await waitFor(() => expect(journalAtSubmission?.nodes['Draft node']).toMatchObject({ agentId: 'new-agent', issueId: 'new-session', companyId: tenant.id }));
  expect(initialize).toHaveBeenCalledOnce(); expect(screen.queryByText(/未绑定真实 Agent/)).toBeNull();
});
it('sets a node saved on Pi up on openai-agents when a run executes it there, and leaves a Pi-only model on Pi', async () => {
  const catalogue = { available: true, configured: true,
    models: [{ id: 'profile-main', runtime: 'pi' }, { id: 'profile-main', runtime: 'openai-agents' }, { id: 'pi-only', runtime: 'pi' }],
    runtimes: ['pi', 'openai-agents'].map(id => ({ id, name: id, available: true, configured: true, supportsEffortSelection: false, tools: [] })) };
  for (const [model, expected] of [['profile-main', 'openai-agents'], ['pi-only', 'pi']] as const) {
    cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); journalAtSubmission = null;
    configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
    seed(true);
    const document = loadDocumentWithStatus().doc;
    (document.nodes[0] as SessionNode).model = model;
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
    const fallback = (globalThis.fetch as unknown as (input: unknown, init?: RequestInit) => Promise<Response>);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => String(input).endsWith('/runtime')
      ? new Response(JSON.stringify(catalogue)) : fallback(input, init)));
    let received!: CanvasDocument;
    configureSaaSCanvasInitialize(async () => { received = loadDocumentWithStatus().doc; return canonical(received, expected, model); });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    // The run waits for the workspace's models, so it knows where each one runs.
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/runtime'))).toBe(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(received).toBeDefined());
    expect(received.nodes[0]).toMatchObject({ runtime: expected, model });
  }
});
it('retains the editable draft and writes no journal when initialization fails; the notice can be dismissed', async () => {
  seed(); configureSaaSCanvasInitialize(async () => { throw new Error('Fixture unavailable'); });
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await screen.findByText('Fixture unavailable'); expect(loadRunJournal()).toBeNull(); expect(journalAtSubmission).toBeNull();
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).binding).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' })); expect(screen.queryByText('Fixture unavailable')).toBeNull();
});
it('saves edited configuration synchronously, preserves the old thread and adopts canonical setup in the same inspector action', async () => {
  seed(true); let received!: CanvasDocument;
  configureSaaSCanvasInitialize(async scope => { expect(scope).toEqual(['Draft node']); received = loadDocumentWithStatus().doc; return canonical(received); });
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />); await openInspector();
  const inspector = screen.getByRole('dialog', { name: '节点配置 — Draft node' });
  expect(inspector.parentElement).toHaveClass('canvas-root');
  fireEvent.change(screen.getByLabelText(/系统提示词|人格/), { target: { value: 'Updated persona' } });
  fireEvent.click(screen.getByRole('button', { name: /保存配置|保存并准备运行/ }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '节点配置 — Draft node' })).toBeNull());
  expect(received.nodes[0]).toMatchObject({ persona: 'Updated persona', binding: null, issueId: null });
  expect(getNodeThreads(received.nodes[0] as SessionNode).some(thread => thread.issueId === 'old-session' && thread.binding?.agentId === 'old-agent')).toBe(true);
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ binding: { agentId: 'new-agent' }, issueId: 'new-session', persona: 'Updated persona' }));
});
it('picks a model without a runtime, sets it up where AwwO runs it, and preserves the prior Pi conversation', async () => {
  seed(true); let received!: CanvasDocument;
  // The workspace offers profile-main on Pi only and agents-only on OpenAI Agents only.
  const catalogue = { available: true, configured: true, models: [{ id: 'profile-main', runtime: 'pi' }, { id: 'agents-only', runtime: 'openai-agents' }],
    runtimes: ['pi', 'openai-agents'].map(id => ({ id, name: id, available: true, configured: true, supportsEffortSelection: false, tools: [] })) };
  const fallback = (globalThis.fetch as unknown as (input: unknown, init?: RequestInit) => Promise<Response>);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => String(input).endsWith('/runtime')
    ? new Response(JSON.stringify(catalogue)) : fallback(input, init)));
  configureSaaSCanvasInitialize(async scope => {
    expect(scope).toEqual(['Draft node']); received = loadDocumentWithStatus().doc;
    return canonical(received, 'openai-agents', 'agents-only');
  });
  const view = render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />); await openInspector();
  // The panel names models only: no runtime control, and a hint that AwwO picks the engine.
  expect(screen.queryByLabelText('Runtime')).toBeNull();
  expect(screen.getByText('AwwO 会为所选模型自动安排执行引擎，无需设置。')).toBeVisible();
  const model = await screen.findByRole('combobox', { name: '模型' });
  await waitFor(() => expect(model.querySelector('option[value="agents-only"]')).not.toBeNull());
  expect(model).toHaveValue('profile-main');
  fireEvent.change(model, { target: { value: 'agents-only' } });
  fireEvent.click(screen.getByRole('button', { name: /保存配置|保存并准备运行/ }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '节点配置 — Draft node' })).toBeNull());
  expect(received.nodes[0]).toMatchObject({ runtime: 'openai-agents', model: 'agents-only', effort: '', binding: null, issueId: null });
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ runtime: 'openai-agents', model: 'agents-only', binding: { agentId: 'new-agent' }, issueId: 'new-session' }));
  const saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(getNodeThreads(saved)).toEqual(expect.arrayContaining([
    expect.objectContaining({ runtime: 'pi', model: 'profile-main', issueId: 'old-session', binding: expect.objectContaining({ agentId: 'old-agent' }) }),
    expect.objectContaining({ runtime: 'openai-agents', model: 'agents-only', issueId: 'new-session', binding: expect.objectContaining({ agentId: 'new-agent' }) }),
  ]));
  view.unmount(); render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />); await openInspector();
  await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('agents-only'));
  expect(screen.queryByLabelText('Runtime')).toBeNull();
});
it('persists detaching a shared Agent through the full inspector save path without reviving its reference', async () => {
  seed(true);
  const document = loadDocumentWithStatus().doc;
  (document.nodes[0] as SessionNode).agentRef = { source: 'workspace', agentId: 'old-agent' };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
  let received!: CanvasDocument;
  configureSaaSCanvasInitialize(async () => { received = loadDocumentWithStatus().doc; return canonical(received); });
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />); await openInspector();
  fireEvent.click(screen.getByRole('button', { name: '解除引用，使用独立自定义 Agent' }));
  fireEvent.click(screen.getByRole('button', { name: /保存配置|保存并准备运行/ }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '节点配置 — Draft node' })).toBeNull());
  const detached = received.nodes[0] as SessionNode;
  expect(detached.agentRef).toBeUndefined();
  expect(detached.binding).toBeNull();
  expect(detached.issueId).toBeNull();
  expect(getNodeThreads(detached)).toEqual(expect.arrayContaining([
    expect.objectContaining({ issueId: 'old-session', agentRef: { source: 'workspace', agentId: 'old-agent' }, binding: expect.objectContaining({ agentId: 'old-agent' }) }),
    expect.objectContaining({ issueId: null, agentRef: null, binding: null }),
  ]));
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).agentRef).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).includes('/agents/') && init?.method === 'PUT')).toBe(false);
});
it('allows a SaaS draft composer while retaining its text until initialization and durable run acceptance', async () => {
  seed(); let reject!: (error: Error) => void;
  configureSaaSCanvasInitialize(() => new Promise((_resolve, failure) => { reject = failure; }));
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  const input = screen.getByTestId('composer-input'); expect(input).not.toBeDisabled();
  fireEvent.change(input, { target: { value: 'Keep my request' } }); fireEvent.click(screen.getByTestId('composer-send'));
  await waitFor(() => expect(reject).toBeTypeOf('function'));
  expect(input).toHaveValue('Keep my request'); expect(loadRunJournal()).toBeNull();
  await act(async () => reject(new Error('Cannot prepare')));
  await screen.findByText('Cannot prepare'); expect(input).toHaveValue('Keep my request'); expect(input).not.toBeDisabled();
});
it('shows a real quota rejection after first-node initialization and allows another send without false page recovery', async () => {
  seed(); configureSaaSCanvasInitialize(async () => canonical(loadDocumentWithStatus().doc));
  let submissions = 0;
  const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/runs') && init.method === 'POST') {
      submissions += 1;
      return new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Workspace run quota exceeded' } }), { status: 429 });
    }
    return new Response(JSON.stringify({ items: [], models: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  for (const request of ['First request', 'Try after capacity returns']) {
    const before = submissions;
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: request } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(submissions).toBe(before + 1));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(screen.getByTestId('composer-input')).toBeEnabled();
    expect(screen.getAllByText(/工作区运行额度已满|workspace run quota/)[0]).toBeVisible();
    expect(screen.queryByText('页面中断前尚未下发。')).toBeNull();
    expect(screen.queryByText('已恢复运行结果；未执行的下游可单独继续。')).toBeNull();
  }
  // Only the pre-submission operation lookup is needed: no recovery lookup follows either rejection.
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/runs?operationId='))).toHaveLength(2);
});
it('allows conversation before required task input is filled while keeping explicit task validation', async () => {
  seed(); const document = loadDocumentWithStatus().doc;
  document.nodes[0] = { ...document.nodes[0], contract: { version: 1,
    inputs: [{ id: 'task', label: '任务要求', type: 'text', required: true, value: '' }], outputs: [] } } as SessionNode;
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
  configureSaaSCanvasInitialize(async () => canonical(loadDocumentWithStatus().doc));
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  expect(screen.getByTestId('composer-input')).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '执行节点任务' }));
  await screen.findByText('“Draft node”输入未就绪：任务要求。请补齐必填项并填写有效值。');
  expect(journalAtSubmission).toBeNull();
  expect(screen.queryByText(/未绑定真实 Agent|先绑定/)).toBeNull();
});

// 图片 · 高清 as the offer had it when a node was saved, and after it was repointed to a generator whose
// resolutions are 2K alone (2026-10-22): the model's id did not change, only its choices narrowed.
const mediaOffer = (resolutions: string[]) => ({
  configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
  models: [{ id: 'xt.seedream-5-pro', name: 'Seedream 5 Pro', label: ['图片 · 高清', 'Image · HD'], vendor: 'media', kind: 'image',
    mode: 'text-to-image', prompt: { minLength: 1, maxLength: 32000 }, references: 0, audioReferences: 0, params: [
      { name: 'resolution', type: 'enum', values: resolutions, default: '2K', label: ['分辨率', 'Resolution'] },
      { name: 'imageNum', type: 'integer', min: 1, max: 4, default: 1, label: ['生成张数', 'Images'] }] }],
});
function seedMedia(mediaParams: SessionNode['mediaParams']) {
  const node: SessionNode = { ...createSessionNode('image', { x: 50, y: 50 }), id: 'poster', title: '海报', runtime: 'pi',
    model: 'xt.seedream-5-pro', binding: { companyId: tenant.id, agentId: 'media-agent', agentName: '海报' }, issueId: 'media-session', mediaParams };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
}
/** The fixture's routes, with the workspace's media catalogue and any route this test answers itself. */
function withMediaRoutes(offer: ReturnType<typeof mediaOffer>, own: (url: string, init: RequestInit) => Response | undefined = () => undefined) {
  const fallback = globalThis.fetch as unknown as (input: unknown, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/tenants/workspace/media')) return new Response(JSON.stringify(offer));
    return own(url, init) ?? fallback(input, init);
  }));
}

// A setting the model no longer accepts refuses the whole canvas at the server, so the run is not sent and the node
// is named. The canvas itself is left alone: this catalogue is the one read when it opened, so deleting the setting
// by it could lose a choice the workspace accepts.
it('refuses a run a media node holds a refused setting in, names the node, and changes nothing', async () => {
  seedMedia({ resolution: '1K', imageNum: 3 });
  withMediaRoutes(mediaOffer(['2K']));
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  // The settings are judged by the workspace's catalogue, so the run waits for it; without one they are not judged
  // here at all and the server refuses that run instead.
  await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/tenants/workspace/media'))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await screen.findByText('有 1 个节点的生成设置不被它的模型接受：海报。请打开它们重新选择；如果打开这张画布之后模型有变动，刷新页面即可。');
  expect(journalAtSubmission).toBeNull();
  expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => String(url).endsWith('/graph-runs') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).mediaParams).toEqual({ resolution: '1K', imageNum: 3 });
});

it('runs a media node whose settings the workspace still accepts', async () => {
  seedMedia({ resolution: '1K', imageNum: 3 });
  withMediaRoutes(mediaOffer(['2K', '1K']));
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/tenants/workspace/media'))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await waitFor(() => expect(journalAtSubmission?.nodes.poster).toBeDefined());
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).mediaParams).toEqual({ resolution: '1K', imageNum: 3 });
});

// The server freezes every media node in a run's scope before the run starts, so one node's own saved state refuses
// the whole canvas; it carries that node's id, and the page, which owns the titles, says which node it was.
it('names the node a refused canvas run was refused for', async () => {
  seedMedia({ resolution: '1K' });
  withMediaRoutes(mediaOffer(['2K', '1K']), (url, init) => url.endsWith('/graph-runs') && init.method === 'POST'
    ? new Response(JSON.stringify({ error: { code: 'media_params_invalid', message: 'Node media settings are invalid for its model', details: { nodeId: 'poster' } } }), { status: 400 })
    : undefined);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await screen.findByText('“海报”：节点的生成参数不适用于所选模型，请在节点配置中修改。');
  expect(loadRunJournal()).toBeNull();
});
