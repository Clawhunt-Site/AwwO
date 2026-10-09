import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { activeNodeThread, sessionStoreKey } from '../src/canvas/nodeThreads';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { forgetNode } from '../src/canvas/sessionTransport';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { beginConversationPresentation } from '../src/canvas/conversationPresentation';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = { id: 'conversation-workspace', name: 'Conversation workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const base = `/api/v1/tenants/${tenant.id}`;
const reader = async (path: string) => path === '/api/agents'
  ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] }
  : { models: ['profile-main'] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type FixtureRun = { id: string; tenantId: string; sessionId: string; status: string; terminal: boolean; prompt: string; output: string; operationId: string };
let runs: FixtureRun[];
let submittedJournals: CanvasRunJournal[];
let fetcher: ReturnType<typeof vi.fn>;
let initialize: ReturnType<typeof vi.fn>;
let nextOutput: string;
let nextStatus: string;

function makeNode(id: string, requiredValue = ''): SessionNode {
  const node: SessionNode = {
    ...createSessionNode('llm', { x: id === 'conversation-node' ? 50 : 850, y: 50 }),
    id, title: id === 'conversation-node' ? 'Poetry team' : 'Downstream task',
    runtime: 'pi', model: 'profile-main', persona: 'Collaborate as the configured members.',
    binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id }, issueId: `session-${id}`,
    contract: { version: 1,
      inputs: [{ id: 'task', label: 'Task brief', type: 'text', required: true, value: requiredValue }],
      outputs: [{ id: 'result', label: 'Task result', type: 'text', required: true, value: 'Published report' },
        { id: 'approved', label: 'Approved', type: 'boolean', required: true, value: 'true' }],
    },
    lastOutput: { text: '{"result":"Published report","approved":true}', at: 123, source: 'run' },
  };
  return { ...node, team: createNodeTeam(node, 'en') };
}

function seed(requiredValue = '', downstream = false) {
  const node = makeNode('conversation-node', requiredValue);
  const document = sanitizeDocument({ ...emptyDocument(), nodes: downstream ? [node, makeNode('downstream-node', 'Already supplied')] : [node],
    edges: downstream ? [{ id: 'dependency', fromNode: node.id, fromPort: 'out:result', toNode: 'downstream-node', toPort: 'in:task', dataType: 'text' }] : [],
    view: { x: 0, y: 0, scale: 1 },
  });
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
  return document;
}

function renderCanvas(readOnly = false) {
  return render(<SaaSPreferencesProvider><CanvasSurface storageMode="cloud" runtimeReadJson={reader} readOnly={readOnly} /></SaaSPreferencesProvider>);
}
function openChat() { fireEvent.click(screen.getByRole('button', { name: 'Open Poetry team', exact: true })); }
function send(text: string) {
  const input = screen.getByTestId('composer-input');
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTestId('composer-send'));
}
async function finished(count = 1) {
  await waitFor(() => expect(runs).toHaveLength(count));
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeEnabled());
}
const writes = () => fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const resetConversationMemory = () => {
  resetAllSessions();
  for (const id of ['conversation-node', 'downstream-node']) forgetNode(id);
};

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'en');
  configureCanvasStorage('conversation-user', tenant.id, 'conversation-canvas');
  resetConversationMemory(); runs = []; submittedJournals = [];
  nextOutput = 'Both members considered your question.'; nextStatus = 'completed';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  configureSaaSCanvas({ tenant, canvasId: 'conversation-canvas' });
  configureSaaSCanvasSave(async () => 9);
  initialize = vi.fn(async () => {
    expect(loadRunJournal()).toBeNull();
    return loadDocumentWithStatus().doc;
  });
  configureSaaSCanvasInitialize(initialize);
  fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `${base}/runs` && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const journal = loadRunJournal();
      expect(journal).not.toBeNull();
      submittedJournals.push(structuredClone(journal!));
      const run: FixtureRun = { id: `conversation-run-${runs.length + 1}`, tenantId: tenant.id, sessionId: body.sessionId,
        status: nextStatus, terminal: true, prompt: body.prompt, output: nextOutput, operationId: body.operationId };
      runs.push(run);
      return response(run, 202);
    }
    if (url.startsWith(`${base}/runs?operationId=`)) {
      const operationId = new URL(url, 'http://fixture.local').searchParams.get('operationId');
      return response({ items: runs.filter(run => run.operationId === operationId).map(run => ({ ...run, outputAvailable: Boolean(run.output) })) });
    }
    if (url.startsWith(`${base}/sessions?`)) return response({ items: [{ id: 'session-conversation-node', agentId: 'agent-conversation-node', title: 'Poetry team', createdAt: '2026-09-08T00:00:00Z' }] });
    if (url === `${base}/sessions/session-conversation-node/messages`) return response({ items: runs.flatMap(run => [
      { id: `user-${run.id}`, role: 'user', content: run.prompt, runId: run.id },
      { id: `agent-${run.id}`, role: 'assistant', content: run.output, runId: run.id },
    ]) });
    const match = new RegExp(`^${base}/runs/([^/]+)(/events|/turns)?$`).exec(url);
    if (match) {
      const run = runs.find(item => item.id === match[1]);
      if (!run) return response({ error: { code: 'not_found', message: 'Unknown fixture run' } }, 404);
      if (match[2] === '/events') return new Response(`data: ${JSON.stringify({ type: run.status, text: run.output })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      if (match[2] === '/turns') return response({ items: [{ id: `member-${run.id}`, memberId: 'poet', memberName: `Poet ${run.id}`,
        role: 'member', round: 1, ordinal: 1, status: 'completed', model: 'profile-main', runtime: 'pi', output: `Member evidence for ${run.id}` }] });
      return response(run);
    }
    if (init.method && init.method !== 'GET') throw new Error(`Unexpected mutation: ${url}`);
    return response({ items: [], models: [] });
  });
  vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
  cleanup(); clearSaaSCanvas(); resetConversationMemory();
  configureCanvasStorage('conversation-user', tenant.id, 'conversation-canvas');
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('admits raw SaaS conversation with missing task inputs and a JSON output contract', async () => {
  seed(); renderCanvas(); openChat();
  send('Who spoke first? Please answer naturally.');
  await finished();
  expect(initialize).toHaveBeenCalledWith(['conversation-node'], expect.any(AbortSignal));
  expect(runs[0]).toMatchObject({ sessionId: 'session-conversation-node', prompt: 'Who spoke first? Please answer naturally.' });
  expect(submittedJournals[0]).toMatchObject({ manual: true, manualMessage: runs[0].prompt, scope: ['conversation-node'],
    nodes: { 'conversation-node': { agentId: 'agent-conversation-node', issueId: 'session-conversation-node', companyId: tenant.id } } });
  expect(submittedJournals[0].serverGraph).toBeUndefined();
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe(`${base}/runs`);
  expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'agent')).toEqual([
    expect.objectContaining({ text: runs[0].output, runId: runs[0].id }),
  ]);
  expect(screen.getByTestId('composer-input')).toHaveValue('');
  expect(screen.queryByText(/input is not ready|required field/i)).toBeNull();
  expect(screen.queryByText(/result format needs|结果格式需要修复/i)).toBeNull();
  expect(getSnapshot('conversation-node').turns.find(turn => turn.role === 'agent')?.presentation?.outputContract).toBeUndefined();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(false);
  const presentationKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).filter(key => key.includes('conversation-presentation'));
  expect(presentationKeys).toHaveLength(1);
  expect(presentationKeys[0]).toMatch(/^awwo\.saas:conversation-user:/);
});

it('keeps explicit node execution behind task validation and retains the unsent conversation draft', async () => {
  seed(); renderCanvas(); openChat();
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'An unsent follow-up' } });
  fireEvent.click(screen.getByRole('button', { name: 'Execute node task', exact: true }));
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  await screen.findByText(/Task brief.*required/i);
  expect(writes()).toEqual([]); expect(runs).toEqual([]); expect(loadRunJournal()).toBeNull();
  expect(screen.getByTestId('composer-input')).toBeEnabled();
  expect(screen.getByTestId('composer-input')).toHaveValue('An unsent follow-up');
});

it('replaces a failed historical run observer with the newly admitted graph run on retry', async () => {
  seed('Build the current project');
  runs.push({ id: 'old-failed-run', tenantId: tenant.id, sessionId: 'session-conversation-node', status: 'failed', terminal: true,
    prompt: 'The earlier task', output: 'Earlier attempt output', operationId: 'old-operation' });
  const fallback = fetcher.getMockImplementation()!;
  let acceptGraph!: (response: Response) => void;
  let graph: Record<string, unknown> | undefined;
  fetcher.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `${base}/runs/old-failed-run`) return response({ ...runs[0], executionKind: 'workspace', error: 'runtime_failed',
      workspaceActivity: { items: [{ step: 3, tool: 'workspace_exec' }], truncated: false } });
    if (url.endsWith('/graph-runs') && init.method === 'POST') {
      graph = { id: 'retry-graph', operationId: loadRunJournal()!.id, canvasId: 'conversation-canvas', documentVersion: 9,
        scope: ['conversation-node'], status: 'running', createdAt: '2026-10-01T00:00:00Z',
        nodes: [{ nodeId: 'conversation-node', state: 'running', runId: 'new-current-run', sessionId: 'session-conversation-node' }] };
      return new Promise<Response>(resolve => { acceptGraph = resolve; });
    }
    if (url.endsWith('/graph-runs/retry-graph')) return response(graph);
    if (url === `${base}/runs/new-current-run`) return response({ id: 'new-current-run', tenantId: tenant.id, status: 'running', executionKind: 'workspace',
      workspaceActivity: { items: [{ step: 1, tool: 'workspace_write' }], truncated: false } });
    return fallback(input, init);
  });
  renderCanvas(); openChat();
  await screen.findByText('Model execution failed. Check the runtime configuration and try again.');
  expect(screen.getByText('Earlier attempt output')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Execute node task', exact: true }));
  await waitFor(() => expect(acceptGraph).toBeTypeOf('function'));
  expect(screen.getByText('Submitting the node task…')).toBeVisible();
  expect(screen.queryByText('Model execution failed. Check the runtime configuration and try again.')).toBeNull();
  expect(screen.queryByText('Run a terminal command')).toBeNull();
  const oldReads = fetcher.mock.calls.filter(([url]) => String(url) === `${base}/runs/old-failed-run`).length;
  await act(async () => { acceptGraph(response(graph, 202)); });
  expect(await screen.findByText('Write a file')).toBeVisible();
  const current = within(screen.getByRole('region', { name: 'Current node task' }));
  expect(screen.getByRole('region', { name: 'Current node task' }).closest('[data-testid="transcript-scroll"]')).not.toBeNull();
  expect(current.getByRole('status')).toHaveTextContent('Run status: Running');
  expect(screen.queryByText('Run a terminal command')).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => String(url) === `${base}/runs/old-failed-run`)).toHaveLength(oldReads);
  expect(fetcher.mock.calls.some(([url]) => String(url) === `${base}/runs/new-current-run`)).toBe(true);
});

it('keeps a cloud canvas editable but blocks manual conversation before initialization when the engine is unavailable', async () => {
  const original = seed();
  const reason = 'Connect your execution engine before running this canvas.';
  render(<SaaSPreferencesProvider><CanvasSurface storageMode="cloud" runtimeReadJson={reader}
    executionUnavailableReason={reason} /></SaaSPreferencesProvider>);
  const run = screen.getByRole('button', { name: '▶ Run graph' });
  expect(run).toBeDisabled();
  expect(run).toHaveAttribute('title', reason);
  expect(document.getElementById(run.getAttribute('aria-describedby')!)).toHaveTextContent(reason);
  openChat();
  expect(screen.queryByRole('button', { name: 'Execute node task' })).toBeNull();
  const input = screen.getByTestId('composer-input');
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: 'Keep this draft until the engine is connected.' } });
  expect(input).toHaveValue('Keep this draft until the engine is connected.');
  const sendButton = screen.getByTestId('composer-send');
  expect(sendButton).toBeDisabled();
  expect(sendButton).toHaveAttribute('title', reason);
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  expect(input).toHaveValue('Keep this draft until the engine is connected.');
  expect(initialize).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
  expect(loadRunJournal()).toBeNull();
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({
    id: original.nodes[0].id, title: original.nodes[0].title,
    lastOutput: original.nodes[0].lastOutput,
    threads: [{ draft: 'Keep this draft until the engine is connected.' }],
  }));
});

it('preserves published outputs and downstream deliverables after successful natural-language chat and reload', async () => {
  const original = seed('Create a structured report', true);
  let view = renderCanvas(); openChat(); send('Can you explain the previous answer?'); await finished();
  expect(loadDocumentWithStatus().doc.nodes.map(node => ({ output: node.lastOutput, contract: node.kind === 'session' ? node.contract : null })))
    .toEqual(original.nodes.map(node => ({ output: node.lastOutput, contract: node.kind === 'session' ? node.contract : null })));
  view.unmount(); resetConversationMemory();
  view = renderCanvas(); openChat();
  await waitFor(() => expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'agent')).toHaveLength(1));
  expect(getSnapshot('conversation-node').turns.find(turn => turn.role === 'agent')).toMatchObject({ text: runs[0].output, runId: runs[0].id });
  expect(loadDocumentWithStatus().doc.nodes.map(node => node.lastOutput)).toEqual(original.nodes.map(node => node.lastOutput));
  expect(writes()).toHaveLength(1);
});

it('associates identical live replies and restored replies with their own durable member records', async () => {
  seed(); let view = renderCanvas(); openChat();
  send('Please continue'); await finished();
  send('Please continue'); await finished(2);
  const key = sessionStoreKey(loadDocumentWithStatus().doc.nodes[0] as SessionNode);
  expect(getSnapshot(key).turns.filter(turn => turn.role === 'agent').map(turn => turn.runId)).toEqual(runs.map(run => run.id));
  view.unmount(); resetConversationMemory();
  view = renderCanvas(); openChat();
  await waitFor(() => expect(getSnapshot(key).turns.filter(turn => turn.role === 'agent').map(turn => turn.runId)).toEqual(runs.map(run => run.id)));
  const replies = screen.getAllByText((_content, element) =>
    element?.matches('.canvas-transcript-turn--agent') === true && element.textContent === runs[0].output);
  expect(replies).toHaveLength(2);
  for (const [index, reply] of replies.entries()) {
    const slot = reply.nextElementSibling as HTMLElement;
    expect(slot).toHaveClass('saas-team-run-details');
    const toggle = within(slot).getByRole('button', { name: /Team collaboration|Run process/ });
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    await within(slot).findByText(`Member evidence for ${runs[index].id}`);
    expect(within(slot).queryByText(`Member evidence for ${runs[1 - index].id}`)).toBeNull();
  }
  expect(writes()).toHaveLength(2);
});

it('recovers accepted natural-language chat exactly once without task validation, republication or resubmission', async () => {
  const original = seed();
  runs.push({ id: 'detached-run', tenantId: tenant.id, sessionId: 'session-conversation-node', status: 'completed', terminal: true,
    prompt: 'A follow-up accepted before the browser closed', output: 'Recovered natural-language answer', operationId: 'detached-operation' });
  expect(saveRunJournal({ version: 1, id: 'detached-journal', startedAt: 100, scope: ['conversation-node'], manual: true,
    manualMessage: runs[0].prompt, inputFingerprint: runInputFingerprint(original, ['conversation-node']), nodes: {
      'conversation-node': { nodeId: 'conversation-node', threadId: 'default', companyId: tenant.id, agentId: 'agent-conversation-node',
        issueId: runs[0].sessionId, runId: runs[0].id, operationId: runs[0].operationId, state: 'running' },
    } })).toBe(true);
  let view = renderCanvas(); openChat();
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  await waitFor(() => expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'agent')).toEqual([
    expect.objectContaining({ text: runs[0].output, runId: runs[0].id }),
  ]));
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput).toEqual(original.nodes[0].lastOutput);
  view.unmount(); resetConversationMemory();
  view = renderCanvas(); openChat();
  await waitFor(() => expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'agent')).toHaveLength(1));
  expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual([runs[0].prompt]);
  expect(initialize).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(false);
});

it('lets read-only viewers inspect run identities without initialization, chat admission or task execution', async () => {
  seed(); runs.push({ id: 'reader-run', tenantId: tenant.id, sessionId: 'session-conversation-node', status: 'completed', terminal: true,
    prompt: 'Earlier question', output: 'Earlier answer', operationId: 'reader-operation' });
  renderCanvas(true); openChat();
  await screen.findByText('Member evidence for reader-run');
  expect(screen.getByTestId('composer-input')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Execute node task', exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: '▶ Run graph', exact: true })).toBeDisabled();
  expect(initialize).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
});

it('preserves a newer SaaS draft while ownership and canonical initialization admit the original request', async () => {
  seed(); renderCanvas(); openChat();
  let enter!: () => void;
  vi.spyOn(navigator.locks, 'request').mockImplementation(((_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
    new Promise<void>(resolve => { enter = () => { void callback({ name: 'owned' }).then(resolve); }; })) as typeof navigator.locks.request);
  send('Original question');
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'My next question' } });
  await act(async () => enter());
  await finished();
  expect(runs[0].prompt).toBe('Original question');
  expect(screen.getByTestId('composer-input')).toHaveValue('My next question');
  expect(activeNodeThread(loadDocumentWithStatus().doc.nodes[0] as SessionNode).draft).toBe('My next question');
  expect(initialize).toHaveBeenCalledOnce();
  expect(writes()).toHaveLength(1);
});

const revision = JSON.stringify({ result: '## Revised book club\nBudget: 240 yuan\n1. First\n2. Second\n3. Third', approved: true });

it('publishes a complete structured follow-up and restores its readable report after reload', async () => {
  const original = seed('Create a structured report');
  (original.nodes[0] as SessionNode).contract!.outputs[0].type = 'markdown';
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(original));
  nextOutput = revision;
  let view = renderCanvas(); openChat(); send('Revise the budget to 240 yuan and update the complete deliverable.');
  await finished();
  const saved = loadDocumentWithStatus().doc;
  expect(saved.nodes[0].lastOutput).toMatchObject({ text: revision, source: 'run', supersedesThroughGraphVersion: 9, supersedesGraphCanvasId: 'conversation-canvas' });
  expect(saved.nodes[0].lastOutput?.partial).toBeUndefined();
  const transcript = document.querySelector('.canvas-transcript') as HTMLElement;
  expect(within(transcript).getByRole('heading', { name: 'Revised book club' })).toBeVisible();
  expect(within(transcript).getByText('View original response')).toBeInTheDocument();
  view.unmount(); resetConversationMemory();
  view = renderCanvas(); openChat();
  await waitFor(() => expect(getSnapshot('conversation-node').turns.filter(turn => turn.role === 'agent')).toHaveLength(1));
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput?.text).toBe(revision);
  expect(getSnapshot('conversation-node').turns.find(turn => turn.role === 'agent')?.presentation?.outputContract?.outputs[0].id).toBe('result');
  expect(runs).toHaveLength(1);
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:revised-report'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Expand deliverables' }));
  fireEvent.click(screen.getByRole('button', { name: 'Download .md' }));
  expect(blobs).toHaveLength(1);
  const downloaded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blobs[0]);
  });
  expect(downloaded).toBe('## Revised book club\nBudget: 240 yuan\n1. First\n2. Second\n3. Third');
});

it.each(['failed', 'cancelled', 'invalid'] as const)('preserves the prior delivery when a follow-up is %s', async outcome => {
  const original = seed('Create a structured report', true);
  nextOutput = outcome === 'invalid' ? JSON.stringify({ result: 'Incomplete revision', approved: 'yes' }) : revision;
  nextStatus = outcome === 'invalid' ? 'completed' : outcome;
  renderCanvas(); openChat(); send('Revise the report.'); await finished();
  expect(loadDocumentWithStatus().doc.nodes.map(node => node.lastOutput)).toEqual(original.nodes.map(node => node.lastOutput));
});


it.each([undefined, 9])('recovers a structured revision with a stable publication version %s without another model request', async savedVersion => {
  const original = seed('Create a structured report');
  const node = original.nodes[0] as SessionNode;
  const prompt = 'Revise the report to 240 yuan';
  expect(beginConversationPresentation(node, 'detached-revision', prompt, { inputKind: 'manual', outputState: 'streaming' }, canvasStorage())).toBe(true);
  runs.push({ id: 'detached-revision-run', tenantId: tenant.id, sessionId: node.issueId!, status: 'completed', terminal: true,
    prompt, output: revision, operationId: 'detached-revision' });
  expect(saveRunJournal({ version: 1, id: 'detached-revision-journal', startedAt: 500, scope: [node.id], manual: true,
    manualMessage: prompt, ...(savedVersion === undefined ? {} : { supersedesThroughGraphVersion: savedVersion, supersedesGraphCanvasId: 'conversation-canvas' }), inputFingerprint: runInputFingerprint(original, [node.id]), nodes: {
      [node.id]: { nodeId: node.id, threadId: 'default', companyId: tenant.id, agentId: node.binding!.agentId,
        issueId: node.issueId, runId: runs[0].id, operationId: runs[0].operationId, state: 'running' },
    } })).toBe(true);
  configureSaaSCanvasSave(async () => 12);
  renderCanvas(); openChat();
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput).toMatchObject({ text: revision, source: 'run', supersedesThroughGraphVersion: savedVersion ?? 12 });
  const reply = getSnapshot(node.id).turns.find(turn => turn.role === 'agent');
  expect(reply?.presentation).toMatchObject({ outputState: 'final', outputContract: { outputs: [{ id: 'result' }, { id: 'approved' }] } });
  expect(writes()).toEqual([]);
});

it('keeps revision recovery until the cloud save is acknowledged', async () => {
  seed('Create a structured report'); nextOutput = revision;
  let acknowledge: (() => void) | undefined;
  configureSaaSCanvasSave(async () => {
    if (loadDocumentWithStatus().doc.nodes[0].lastOutput?.text === revision) {
      await new Promise<void>(resolve => { acknowledge = resolve; });
    }
    return 10;
  });
  renderCanvas(); openChat(); send('Revise the complete report.');
  await waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  expect(loadRunJournal()?.manual).toBe(true);
  expect(screen.getByTestId('composer-input')).toBeDisabled();
  await act(async () => acknowledge!());
  await finished();
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput?.text).toBe(revision);
});

it('captures the latest acknowledged cloud version immediately before publishing, after interim autosaves', async () => {
  seed('Create a structured report'); nextOutput = revision;
  configureSaaSCanvasSave(async () => runs.length ? 12 : 9);
  renderCanvas(); openChat(); send('Revise the report.'); await finished();
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput).toMatchObject({ text: revision, supersedesThroughGraphVersion: 12 });
});


it('retains the durable publication boundary after a cloud CAS failure and replays it without advancing the cutoff', async () => {
  seed('Create a structured report'); nextOutput = revision;
  let failedSaves = 0;
  configureSaaSCanvasSave(async () => {
    if (loadDocumentWithStatus().doc.nodes[0].lastOutput?.text === revision) {
      expect(loadRunJournal()?.supersedesThroughGraphVersion).toBe(12);
      failedSaves += 1;
      throw new Error('version_conflict');
    }
    return 12;
  });
  const view = renderCanvas(); openChat(); send('Revise the report.');
  await waitFor(() => expect(failedSaves).toBeGreaterThan(0));
  expect(loadRunJournal()).toMatchObject({ manual: true, supersedesThroughGraphVersion: 12 });
  expect(screen.getByTestId('composer-input')).toBeDisabled();
  view.unmount(); resetConversationMemory();
  configureSaaSCanvasSave(async () => 19);
  renderCanvas(); openChat(); await finished();
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput).toMatchObject({ text: revision, supersedesThroughGraphVersion: 12 });
  expect(runs).toHaveLength(1);
});


it('does not publish a revision when its causal boundary cannot be written to recovery storage', async () => {
  const original = seed('Create a structured report'); nextOutput = revision;
  const setItem = localStorage.setItem;
  let rejected = 0;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
    if (key.includes(CANVAS_RUN_JOURNAL_KEY) && JSON.parse(value).supersedesThroughGraphVersion) {
      rejected += 1; throw new Error('Storage full');
    }
    setItem.call(localStorage, key, value);
  });
  renderCanvas(); openChat(); send('Revise the report.');
  await waitFor(() => expect(rejected).toBeGreaterThan(0));
  expect(loadRunJournal()?.manual).toBe(true);
  expect(loadDocumentWithStatus().doc.nodes[0].lastOutput).toEqual(original.nodes[0].lastOutput);
});
