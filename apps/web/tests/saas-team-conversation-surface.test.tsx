import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { sessionStoreKey } from '../src/canvas/nodeThreads';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { forgetNode } from '../src/canvas/sessionTransport';
import { loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
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
        status: 'completed', terminal: true, prompt: body.prompt, output: 'Both members considered your question.', operationId: body.operationId };
      runs.push(run);
      return response(run, 202);
    }
    if (url.startsWith(`${base}/runs?operationId=`)) {
      const operationId = new URL(url, 'http://fixture.local').searchParams.get('operationId');
      return response({ items: runs.filter(run => run.operationId === operationId) });
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
      if (match[2] === '/events') return new Response(`data: ${JSON.stringify({ type: 'completed', text: run.output })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
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
  const replies = screen.getAllByText(runs[0].output, { selector: '.canvas-transcript-turn--agent' });
  expect(replies).toHaveLength(2);
  for (const [index, reply] of replies.entries()) {
    const slot = reply.nextElementSibling as HTMLElement;
    expect(slot).toHaveClass('saas-team-run-details');
    const toggle = within(slot).getByRole('button');
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
