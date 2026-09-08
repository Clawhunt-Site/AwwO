import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';
import { forgetNode } from '../src/canvas/sessionTransport';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import type { ContractField } from '../src/canvas/nodeContracts';

const field = (id: string, type: ContractField['type'] = 'markdown', value = '', required = true): ContractField => ({ id, label: id, type, value, required });
function graph(): CanvasDocument {
  const author: SessionNode = {
    ...createSessionNode('coding', { x: 0, y: 0 }), id: 'review-author', title: 'Author', runtime: 'codex_local',
    binding: { companyId: 'review-company', agentId: 'author-agent', agentName: 'Author' },
    contract: { version: 1, inputs: [field('task', 'text', 'Create a landing page'), field('feedback', 'markdown', '', false)], outputs: [field('artifact')] },
  };
  const reviewer: SessionNode = {
    ...createSessionNode('coding', { x: 500, y: 0 }), id: 'review-reviewer', title: 'Reviewer', runtime: 'codex_local',
    binding: { companyId: 'review-company', agentId: 'reviewer-agent', agentName: 'Reviewer' },
    contract: { version: 1, inputs: [field('candidate')], outputs: [field('approved', 'boolean'), field('notes')] },
  };
  return { ...emptyDocument(), nodes: [author, reviewer], view: { x: 0, y: 0, scale: 1 }, execution: {
    mode: 'review', maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved',
  }, edges: [
    { id: 'candidate', fromNode: author.id, fromPort: 'out:artifact', toNode: reviewer.id, toPort: 'in:candidate', dataType: 'text' },
    { id: 'feedback', fromNode: reviewer.id, fromPort: 'out:notes', toNode: author.id, toPort: 'in:feedback', dataType: 'text', kind: 'feedback' },
  ] };
}
const saved = (): CanvasDocument => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!);
const verdict = (approved: boolean) => JSON.stringify({ approved, notes: approved ? 'All checks passed' : 'Fix keyboard navigation' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface NativeTurn {
  agentId: string;
  operationId: string;
  requestedIssueId?: string;
  issueId: string;
  runId: string;
  message: string;
  output: string;
  status: 'running' | 'succeeded' | 'cancelled';
  finish: (output: string, status?: 'succeeded' | 'cancelled') => void;
}

/** Real Surface -> review scheduler -> gateway executor -> prepare HTTP -> SSE path.
 * Only the network peer is simulated; no execution or journal helper is mocked. */
function nativePeer() {
  const turns: NativeTurn[] = [];
  const preparationProofs: Array<{ operationId: string; durable: string | null | undefined; state?: string }> = [];
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    const preparation = url.match(/\/agents\/([^/]+)\/operations\/([^/]+)\/prepare$/);
    if (method === 'POST' && preparation) {
      const agentId = decodeURIComponent(preparation[1]); const operationId = decodeURIComponent(preparation[2]);
      const item = Object.values(loadRunJournal()?.nodes ?? {}).find(node => node.agentId === agentId);
      preparationProofs.push({ operationId, durable: item?.operationId, state: item?.state });
      return response({ prepared: true });
    }
    const messages = url.match(/\/agents\/([^/]+)\/messages$/);
    if (method === 'POST' && messages) {
      const agentId = decodeURIComponent(messages[1]);
      const issueId = body.issueId || `issue-${agentId}`;
      const runId = `native-run-${turns.length + 1}`;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const emit = (frame: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      const turn: NativeTurn = {
        agentId, operationId: body.operationId, requestedIssueId: body.issueId, issueId, runId, message: body.message, output: '', status: 'running',
        finish(output, status = 'succeeded') {
          if (turn.status !== 'running') return;
          turn.output = output; turn.status = status;
          if (output) emit({ event: 'delta', text: output });
          emit({ event: 'done', status }); controller.close();
        },
      };
      turns.push(turn);
      emit({ event: 'accepted', issueId, runId, operationId: body.operationId, runVisible: true });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (method === 'POST' && url.endsWith('/settle')) {
      const turn = turns.find(turn => turn.runId === body.runId);
      return response({ confirmed: true, status: turn?.status ?? 'succeeded', holdId: `hold-${body.runId}` });
    }
    if (method === 'POST' && url.endsWith('/cancel')) {
      const turn = turns.find(turn => turn.runId === body.runId);
      turn?.finish('Partial work before Stop', 'cancelled');
      return response({ confirmed: true, cancelled: true, status: 'cancelled' });
    }
    if (method === 'GET' && url.endsWith('/conversations/review-company')) {
      return response({ conversations: turns.map(turn => ({ issueId: turn.issueId, agentId: turn.agentId })) });
    }
    if (method === 'GET' && url.endsWith('/messages')) return response({ complete: true, messages: [] });
    return response({}, 503);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { turns, preparationProofs, fetchMock };
}

beforeEach(() => {
  localStorage.clear(); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); localStorage.clear(); resetAllSessions(); forgetNode('review-author'); forgetNode('review-reviewer');
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function start(doc = graph()) {
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  const view = render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: /开始互审/ }));
  return view;
}
async function finishTurn(turn: NativeTurn, output: string) { await act(async () => { turn.finish(output); }); }

describe('CanvasSurface review Graph native transport integration', () => {
  it.each(['toolbar', 'palette'] as const)('in Workflow mode the %s selection run ignores saved feedback and reuses the producer output', async entry => {
    const peer = nativePeer(); const doc = graph(); delete doc.execution;
    const cached = { text: '# Cached author delivery', at: 1234, source: 'run' as const };
    doc.nodes[0].lastOutput = cached;
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Reviewer' }));
    if (entry === 'toolbar') fireEvent.click(screen.getByRole('button', { name: '运行所选及下游' }));
    else {
      fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
      const row = screen.getByTestId('cmdbar-row-run-selection');
      expect(row.getAttribute('aria-disabled')).not.toBe('true');
      fireEvent.click(row);
    }
    await waitFor(() => expect(peer.turns).toHaveLength(1));
    expect(peer.turns[0].agentId).toBe('reviewer-agent');
    expect(peer.turns[0].message).toContain(cached.text);
    expect(loadRunJournal()?.scope).toEqual(['review-reviewer']);
    await finishTurn(peer.turns[0], verdict(true));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(peer.turns).toHaveLength(1);
    expect(peer.turns.some(turn => turn.agentId === 'author-agent')).toBe(false);
    expect(saved().nodes[0].lastOutput).toEqual(cached);
    expect(saved().nodes[1].lastOutput).toMatchObject({ text: verdict(true), source: 'run' });
    expect(saved().edges.find(edge => edge.id === 'feedback')?.kind).toBe('feedback');
  });

  it('persists a unique operation for every round, continues the original Session and publishes the approved batch together', async () => {
    const peer = nativePeer(); await start();
    await waitFor(() => expect(peer.turns).toHaveLength(1));
    await finishTurn(peer.turns[0], '# First candidate');
    await waitFor(() => expect(peer.turns).toHaveLength(2));
    expect(saved().nodes.every(node => !node.lastOutput)).toBe(true);
    await finishTurn(peer.turns[1], verdict(false));
    await waitFor(() => expect(peer.turns).toHaveLength(3));
    expect(loadRunJournal()?.review).toMatchObject({ round: 2, outcome: 'running' });
    expect(loadRunJournal()?.review?.turns).toHaveLength(2);
    expect(saved().nodes.every(node => !node.lastOutput)).toBe(true);
    expect(peer.turns[2].requestedIssueId).toBe(peer.turns[0].issueId);
    expect(peer.turns[2].message).toContain('Fix keyboard navigation');
    await finishTurn(peer.turns[2], '# Final candidate');
    await waitFor(() => expect(peer.turns).toHaveLength(4));
    expect(peer.turns[3].requestedIssueId).toBe(peer.turns[1].issueId);
    expect(saved().nodes.every(node => !node.lastOutput)).toBe(true);
    await finishTurn(peer.turns[3], verdict(true));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(new Set(peer.turns.map(turn => turn.operationId)).size).toBe(4);
    expect(peer.preparationProofs).toHaveLength(4);
    expect(peer.preparationProofs.every(proof => proof.operationId && proof.durable === proof.operationId && proof.state === 'running')).toBe(true);
    expect(saved().nodes.map(node => node.lastOutput?.text)).toEqual(['# Final candidate', verdict(true)]);
    expect(saved().nodes.every(node => node.lastOutput && !node.lastOutput.partial)).toBe(true);
    expect(peer.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(4);
  });

  it('keeps exhausted work as partial evidence that cannot be passed to a downstream conversation', async () => {
    const peer = nativePeer(); const doc = graph(); doc.execution!.maxRounds = 1;
    await start(doc); await waitFor(() => expect(peer.turns).toHaveLength(1));
    await finishTurn(peer.turns[0], '# Unapproved candidate');
    await waitFor(() => expect(peer.turns).toHaveLength(2));
    await finishTurn(peer.turns[1], verdict(false));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const final = saved();
    expect(final.nodes.every(node => node.lastOutput?.partial === true)).toBe(true);
    expect(prepareNodeConversation(final.nodes[1] as SessionNode, final.nodes, final.edges).error).toContain('完整产出');
    expect(peer.turns).toHaveLength(2);
    expect(screen.getByText(/达到轮次上限|已达.*轮.*上限|达到.*轮上限|轮次已用完/)).not.toBeNull();
  });

  it('sends real Stop for the active native run and never starts the next review turn', async () => {
    const peer = nativePeer(); await start(); await waitFor(() => expect(peer.turns).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const cancellation = peer.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cancel'));
    expect(cancellation).toBeDefined();
    expect(JSON.parse(String(cancellation![1]!.body))).toMatchObject({ runId: peer.turns[0].runId });
    expect(peer.turns).toHaveLength(1);
    expect(saved().nodes[0].lastOutput).toMatchObject({ partial: true });
    expect(saved().nodes[1].lastOutput).toBeNull();
  });

  it('after refresh reads an exact native turn and retains partial evidence without automatically dispatching the reviewer', async () => {
    const doc = graph(); const author = doc.nodes[0] as SessionNode; author.issueId = 'issue-author-agent';
    const scope = doc.nodes.map(node => node.id);
    const journal: CanvasRunJournal = {
      version: 1, id: 'interrupted-review-graph', startedAt: Date.now(), scope, inputFingerprint: runInputFingerprint(doc, scope),
      review: { round: 1, maxRounds: 3, outcome: 'running', turns: [] },
      nodes: Object.fromEntries(doc.nodes.map(node => [node.id, {
        nodeId: node.id, threadId: 'default', companyId: 'review-company', agentId: (node as SessionNode).binding!.agentId,
        issueId: node.id === author.id ? author.issueId : null, runId: node.id === author.id ? 'native-author-run' : null,
        operationId: node.id === author.id ? 'native-author-operation' : null, state: node.id === author.id ? 'running' : 'waiting',
      }])),
    };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc)); localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/operations/native-author-operation')) return response({
        operationId: 'native-author-operation', state: 'terminal', issueId: author.issueId, runId: 'native-author-run',
        terminal: true, status: 'succeeded', output: '# Recovered candidate', outputAvailable: true, detail: null,
      });
      if (url.endsWith('/settle') && init?.method === 'POST') return response({ confirmed: true, status: 'succeeded', holdId: 'recovered-hold' });
      if (url.endsWith('/conversations/review-company')) return response({ conversations: [{ issueId: author.issueId, agentId: author.binding!.agentId }] });
      if (url.endsWith('/messages') && init?.method !== 'POST') return response({ complete: true, messages: [] });
      return response({}, 503);
    });
    vi.stubGlobal('fetch', fetchMock); render(<CanvasSurface />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/operations/native-author-operation'))).toBe(true));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(saved().nodes[0].lastOutput).toMatchObject({ text: '# Recovered candidate', partial: true });
    expect(saved().nodes[1].lastOutput).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').every(([url]) => String(url).endsWith('/settle'))).toBe(true);
    expect(screen.getByRole('button', { name: /开始互审/ })).not.toBeNull();
  });
});
