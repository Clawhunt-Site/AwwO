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
  nodes: [{ nodeId: 'Draft node', status: 'completed', output: 'Done', threadId: 'default', agentId: 'new-agent', sessionId: 'new-session' }] });
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
function canonical(document: CanvasDocument): CanvasDocument {
  return sanitizeDocument({ ...document, nodes: document.nodes.map(node => node.kind !== 'session' ? node : { ...node,
    ...(node.threads ? { threads: node.threads.map(thread => thread.id !== node.activeThreadId ? thread : { ...thread, binding: { companyId: tenant.id, agentId: 'new-agent', agentName: node.title }, issueId: 'new-session', runtime: 'pi', model: 'profile-main' }) } : {}),
    runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: 'new-agent', agentName: node.title }, issueId: 'new-session',
  }) });
}
async function openInspector() {
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft node', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  await waitFor(() => expect(screen.getByRole('button', { name: /保存配置|保存并准备运行/ })).not.toBeDisabled());
}
it('initializes a draft before graph journaling and executes the returned Agent/session identity', async () => {
  seed(); const initialize = vi.fn(async () => { expect(loadRunJournal()).toBeNull(); return canonical(loadDocumentWithStatus().doc); });
  configureSaaSCanvasInitialize(initialize); render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await waitFor(() => expect(journalAtSubmission?.nodes['Draft node']).toMatchObject({ agentId: 'new-agent', issueId: 'new-session', companyId: tenant.id }));
  expect(initialize).toHaveBeenCalledOnce(); expect(screen.queryByText(/未绑定真实 Agent/)).toBeNull();
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
  expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ binding: { agentId: 'new-agent' }, issueId: 'new-session', persona: 'Updated persona' });
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
