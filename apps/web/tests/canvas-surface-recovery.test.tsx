import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, type CanvasRunJournal } from '../src/canvas/runJournal';
import { persistRecoveredManualConversation, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { getSnapshot, replaceTurns, resetAllSessions, setHistory, setStreaming } from '../src/canvas/sessions';
import { forgetNode, markLocalSend } from '../src/canvas/sessionTransport';

afterEach(() => { cleanup(); localStorage.clear(); resetAllSessions(); forgetNode('foreign'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function foreignCompletionFixture() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
    timeout(callback, ms === 2500 ? 30 : ms, ...args)) as typeof setTimeout);
  const node = {
    ...createSessionNode('llm', { x: 0, y: 0 }), id: 'foreign', title: 'Foreign', runtime: 'codex_local',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' }, issueId: 'issue', preview: 'old prompt',
  };
  const doc = { ...emptyDocument(), nodes: [node] };
  const journal: CanvasRunJournal = {
    version: 1, id: 'foreign-completion', startedAt: 2000, scope: [node.id], manual: true, manualMessage: 'new prompt',
    nodes: { [node.id]: { nodeId: node.id, threadId: 'default', companyId: 'company', agentId: 'agent',
      issueId: 'issue', runId: 'run', operationId: 'operation', state: 'running' } },
  };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  replaceTurns(node.id, [{ role: 'user', text: 'old prompt' }]);
  setHistory(node.id, 'loaded');
  markLocalSend(node.id);
  let finishRead!: (response: unknown) => void;
  const nativeRead = new Promise(resolve => { finishRead = resolve; });
  let historyReply: () => Promise<unknown> = async () => ({ ok: true, json: async () => ({ complete: true, messages: [
    { body: 'new prompt', createdAt: '1970-01-01T00:00:02.100Z' },
    { body: 'AWWO-TURN-RECHECKED', authorAgentId: 'agent', createdAt: '1970-01-01T00:00:03.000Z' },
  ] }) });
  const fetchMock = vi.fn((url: unknown, _init?: RequestInit) => {
    if (String(url).endsWith('/runs/run')) return nativeRead;
    if (String(url).endsWith('/conversations/company')) return Promise.resolve({ ok: true, json: async () => ({ conversations: [{ issueId: 'issue' }] }) });
    if (String(url).endsWith('/messages')) return historyReply();
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const completeElsewhere = (completedDoc = doc) => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(completedDoc));
    localStorage.removeItem(CANVAS_RUN_JOURNAL_KEY);
    finishRead({ ok: true, json: async () => ({ runId: 'run', status: 'running', terminal: false, output: '' }) });
  };
  return { node, doc, journal, fetchMock, completeElsewhere, setHistoryReply: (reply: typeof historyReply) => { historyReply = reply; } };
}

it('refreshes a loaded local transcript once when another tab completes and removes the journal', async () => {
  const f = foreignCompletionFixture();
  const failed = { ...f.journal, id: 'old-failed', startedAt: 1000, manualMessage: 'blocked locally',
    nodes: { foreign: { ...f.journal.nodes.foreign, runId: null, operationId: 'failed-operation', state: 'failed' as const } } };
  expect(persistRecoveredManualConversation(f.node, failed)).toBe(true);
  expect(persistRecoveredManualConversation(f.node, { ...f.journal,
    nodes: { foreign: { ...f.journal.nodes.foreign, state: 'done', output: 'AWWO-TURN-RECHECKED' } } })).toBe(true);
  const { container } = render(<CanvasSurface />);
  await waitFor(() => expect(f.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '打开 Foreign', exact: true }));
  act(() => f.completeElsewhere({ ...f.doc, nodes: [{ ...f.node, preview: 'AWWO-TURN-RECHECKED' }] }));
  await waitFor(() => expect(getSnapshot('foreign').turns.filter(turn => turn.role === 'agent' && turn.text === 'AWWO-TURN-RECHECKED')).toHaveLength(1));
  expect(container.querySelectorAll('.canvas-transcript-turn--agent')).toHaveLength(1);
  expect(getSnapshot('foreign').turns.filter(turn => turn.text === 'blocked locally')).toHaveLength(1);
  expect(getSnapshot('foreign').turns.at(-1)?.text).toBe('AWWO-TURN-RECHECKED');
  await waitFor(() => expect(screen.queryByRole('button', { name: /停止/ })).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1);
  expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBeNull();
  expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes[0].preview).toBe('AWWO-TURN-RECHECKED');
});

it('keeps foreign completion locked and the saved preview intact until history becomes readable', async () => {
  const f = foreignCompletionFixture();
  f.setHistoryReply(async () => ({ ok: false, status: 503 }));
  render(<CanvasSurface />);
  await waitFor(() => expect(f.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '打开 Foreign', exact: true }));
  act(() => f.completeElsewhere({ ...f.doc, nodes: [{ ...f.node, preview: 'new saved preview' }] }));
  await waitFor(() => expect(getSnapshot('foreign').history).toBe('unreadable'));
  expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes[0].preview).toBe('new saved preview');
  f.setHistoryReply(async () => ({ ok: true, json: async () => ({ complete: true, messages: [
    { body: 'new prompt' }, { body: 'restored reply', authorAgentId: 'agent' },
  ] }) }));
  await waitFor(() => expect(getSnapshot('foreign').turns.at(-1)?.text).toBe('restored reply'));
  await waitFor(() => expect(screen.queryByRole('button', { name: /停止/ })).toBeNull());
  expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBeNull();
});

it.each(['binding', 'thread', 'issue'] as const)('does not replay a foreign completion into a changed %s', async changed => {
  const f = foreignCompletionFixture();
  render(<CanvasSurface />);
  await waitFor(() => expect(f.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run'))).toBe(true));
  const node = { ...f.node,
    ...(changed === 'binding' ? { binding: { ...f.node.binding, agentId: 'replacement' } } : {}),
    ...(changed === 'thread' ? { activeThreadId: 'replacement-thread', threads: [{
      id: 'replacement-thread', title: 'Session 2', issueId: 'issue', preview: '', draft: '', createdAt: 1,
    }] } : {}),
    ...(changed === 'issue' ? { issueId: 'replacement-issue' } : {}),
  };
  if (changed === 'thread') setHistory('foreign::replacement-thread', 'loaded');
  act(() => f.completeElsewhere({ ...f.doc, nodes: [node] }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /停止/ })).toBeNull());
  expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(0);
  expect(getSnapshot('foreign').turns).toEqual([expect.objectContaining({ text: 'old prompt' })]);
});

it('preserves a newer journal that appears while foreign completion is loading history', async () => {
  const f = foreignCompletionFixture();
  let finishHistory!: (response: unknown) => void;
  f.setHistoryReply(() => new Promise(resolve => { finishHistory = resolve; }));
  render(<CanvasSurface />);
  await waitFor(() => expect(f.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run'))).toBe(true));
  act(() => f.completeElsewhere());
  await waitFor(() => expect(getSnapshot('foreign').history).toBe('loading'));
  const newer = JSON.stringify({ ...f.journal, id: 'newer-run', nodes: { foreign: { ...f.journal.nodes.foreign, runId: 'newer-native-run' } } });
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, newer);
  act(() => finishHistory({ ok: true, json: async () => ({ complete: true, messages: [{ body: 'old reply', authorAgentId: 'agent' }] }) }));
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(newer);
  expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
});

it('waits for a local stream to finish before forgetting its transport ownership', async () => {
  const f = foreignCompletionFixture();
  setStreaming('foreign', true);
  render(<CanvasSurface />);
  await waitFor(() => expect(f.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run'))).toBe(true));
  act(() => f.completeElsewhere());
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(0);
  act(() => setStreaming('foreign', false));
  await waitFor(() => expect(getSnapshot('foreign').turns.some(turn => turn.text === 'AWWO-TURN-RECHECKED')).toBe(true));
});

it('does not let an older recovery response undo a confirmed Stop', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const nodes = ['a', 'b'].map(id => ({
    ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id, runtime: 'codex_local',
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id }, issueId: `issue-${id}`,
  }));
  const doc = { ...emptyDocument(), nodes };
  const journal: CanvasRunJournal = {
    version: 1, id: 'recovery-race', startedAt: Date.now(), scope: ['a', 'b'], inputFingerprint: runInputFingerprint(doc, ['a', 'b']),
    nodes: Object.fromEntries(nodes.map(n => [n.id, {
      nodeId: n.id, threadId: 'default', companyId: 'company', agentId: n.binding.agentId,
      issueId: n.issueId, runId: n.id === 'a' ? 'run-a' : null, state: 'running' as const,
    }])),
  };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  let resolveRun!: (value: unknown) => void;
  const read = new Promise(resolve => { resolveRun = resolve; });
  const fetchMock = vi.fn((url: unknown) => {
    if (String(url).endsWith('/runs/run-a')) return read;
    if (String(url).endsWith('/cancel')) return Promise.resolve({ ok: true, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<CanvasSurface />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run-a'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
  resolveRun({ ok: true, json: async () => ({ runId: 'run-a', status: 'running', terminal: false, output: '' }) });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)!).nodes.b.state).toBe('cancelled'));
  expect(JSON.parse(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)!).nodes.b.state).toBe('cancelled');
});

it.each(['external-stop', 'new-run'] as const)('preserves %s written by another tab before its storage event arrives', async scenario => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const nodes = ['a', 'b'].map(id => ({
    ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id, runtime: 'codex_local',
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id }, issueId: `issue-${id}`,
  }));
  const doc = { ...emptyDocument(), nodes };
  const journal: CanvasRunJournal = {
    version: 1, id: 'j1', startedAt: Date.now(), scope: ['a', 'b'], inputFingerprint: runInputFingerprint(doc, ['a', 'b']),
    nodes: Object.fromEntries(nodes.map(n => [n.id, {
      nodeId: n.id, threadId: 'default', companyId: 'company', agentId: n.binding.agentId,
      issueId: n.issueId, runId: n.id === 'a' ? 'run-a' : null, state: 'running' as const,
    }])),
  };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  let resolveRead!: (value: unknown) => void;
  let resolveStop!: (value: unknown) => void;
  const read = new Promise(resolve => { resolveRead = resolve; });
  const stop = new Promise(resolve => { resolveStop = resolve; });
  const fetchMock = vi.fn((url: unknown) => {
    if (String(url).endsWith('/runs/run-a')) return read;
    if (String(url).endsWith('/cancel')) return stop;
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<CanvasSurface />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run-a'))).toBe(true));
  if (scenario === 'new-run') fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  const external = scenario === 'external-stop'
    ? { ...journal, nodes: { ...journal.nodes, b: { ...journal.nodes.b, state: 'cancelled', detail: 'cancelled' } } }
    : { ...journal, id: 'j2', nodes: { ...journal.nodes, b: { ...journal.nodes.b, operationId: 'new-operation', state: 'running' } } };
  const bytes = JSON.stringify(external);
  // Intentionally no StorageEvent: another tab's durable write is visible before delivery.
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, bytes);
  resolveRead({ ok: true, json: async () => ({ runId: 'run-a', status: 'running', terminal: false, output: '' }) });
  resolveStop({ ok: true, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(bytes);
});
