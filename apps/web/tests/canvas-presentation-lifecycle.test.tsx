import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { getSnapshot, resetAllSessions, type TurnPresentation } from '../src/canvas/sessions';
import { forgetNode, restoreHistory } from '../src/canvas/sessionTransport';
import { execAgentViaGateway } from '../src/canvas/runTransport';
import { loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { beginConversationPresentation, updateConversationPresentation } from '../src/canvas/conversationPresentation';
import { buildNodeMessage } from '../src/canvas/runGraph';
import { readableOutput } from '../src/canvas/readableTranscript';

const ID = 'presentation-agent';
const INPUT = '把会员详情改成右侧抽屉';
const OUTPUT = JSON.stringify({ result: '## 会员详情\n\n**抽屉已完成**，保留返回位置。', ready: true });
const OPERATION = '11111111-1111-4111-8111-111111111111';

function nodeFixture(): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }), id: ID, title: 'Frontend Agent', runtime: 'codex_local',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' }, issueId: 'issue',
    contract: { version: 1, inputs: [{ id: 'brief', label: '需求', type: 'markdown', required: true, value: '会员后台原有列表页' }],
      outputs: [{ id: 'result', label: '实现说明', type: 'markdown', required: true, value: '旧的表单草稿' },
        { id: 'ready', label: '验收结果', type: 'boolean', required: true, value: 'false' }] } };
}

function presentation(node: SessionNode): TurnPresentation {
  return { inputKind: 'manual', displayText: INPUT, outputState: 'streaming',
    outputContract: { version: 1, inputs: [], outputs: node.contract!.outputs.map(field => ({ ...field, value: '' })) } };
}

function streamHarness() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next; } });
  const encoder = new TextEncoder();
  return {
    body,
    frame(event: string, data: Record<string, unknown> = {}) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ event, ...data })}\n\n`));
    },
    close() { controller.close(); },
  };
}

function transportFixture() {
  const stream = streamHarness();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let terminal = 'succeeded';
  let comments: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') posts.push({ url: path, body: JSON.parse(String(init.body)) });
    if (path.endsWith('/prepare')) return { ok: true, status: 201 };
    if (path.endsWith('/messages') && init?.method === 'POST') return { ok: true, status: 200, body: stream.body };
    if (path.endsWith('/settle')) return { ok: true, json: async () => ({ confirmed: true, status: terminal, holdId: 'hold' }) };
    if (path.endsWith('/conversations/company')) return { ok: true, json: async () => ({ conversations: [{ issueId: 'issue' }] }) };
    if (path.endsWith('/messages')) return { ok: true, json: async () => ({ complete: true, messages: comments }) };
    return { ok: false, status: 503, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { stream, posts, fetchMock, setTerminal: (state: string) => { terminal = state; },
    setComments: (next: typeof comments) => { comments = next; } };
}

function renderSurface(node = nodeFixture()) {
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  const result = render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Frontend Agent', exact: true }));
  return result;
}

function nativeComments(executionText: string, operationId: string) {
  return [
    { id: 'user-comment', body: executionText, createdAt: '2026-09-07T00:00:01Z',
      metadata: { version: 1, sections: [{ title: 'AwwO conversation', rows: [{ type: 'key_value', label: 'Operation', value: operationId }] }] } },
    { id: 'agent-comment', body: OUTPUT, authorAgentId: 'agent', createdByRunId: 'run', createdAt: '2026-09-07T00:00:02Z' },
  ];
}

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); forgetNode(ID);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); forgetNode(ID); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('conversation presentation lifecycle', () => {
  it('keeps the complete execution request in POST and details, then restores readable native history by operation and run identity', async () => {
    const transport = transportFixture();
    const node = nodeFixture();
    const expected = `${buildNodeMessage(node, [])}\n\n【用户消息】\n${INPUT}`;
    const { container } = renderSurface(node);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: INPUT } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(transport.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(1));
    const post = transport.posts.find(item => item.url.endsWith('/messages'))!;
    expect(post.body).toMatchObject({ message: expected, issueId: 'issue', operationId: expect.any(String) });
    expect(transport.posts.find(item => item.url.endsWith('/prepare'))?.body).toEqual({ message: expected, issueId: 'issue' });
    expect(getSnapshot(ID).turns[0]).toMatchObject({ role: 'user', text: expected,
      presentation: { inputKind: 'manual', displayText: INPUT } });
    const userTurn = container.querySelector('.canvas-transcript-turn--user') as HTMLElement;
    expect(within(userTurn).getByText(INPUT, { exact: true })).toBeInTheDocument();
    expect(userTurn.querySelector('details')).not.toHaveAttribute('open');
    expect(userTurn.querySelector('pre')).toHaveTextContent('会员后台原有列表页');
    act(() => {
      transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
      transport.stream.frame('delta', { text: OUTPUT });
    });
    await waitFor(() => expect(getSnapshot(ID).turns.at(-1)?.text).toBe(OUTPUT));
    expect(getSnapshot(ID).turns.at(-1)?.presentation).toMatchObject({ outputState: 'streaming' });
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    act(() => { transport.stream.frame('done', { status: 'succeeded' }); transport.stream.close(); });
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const agentTurn = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(agentTurn.presentation).toEqual({ outputState: 'final', outputContract: presentation(node).outputContract });
    expect(screen.getByRole('heading', { name: '会员详情', exact: true })).toBeInTheDocument();
    expect(screen.getByText('抽屉已完成').tagName).toBe('STRONG');

    const saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
    transport.setComments(nativeComments(expected, String(post.body.operationId)));
    cleanup(); resetAllSessions(); forgetNode(ID);
    await restoreHistory({ gatewayBase: '/gateway-api', node: saved });
    const restored = getSnapshot(ID);
    expect(restored.history).toBe('loaded');
    expect(restored.turns).toHaveLength(2);
    expect(restored.turns[0]).toMatchObject({ nativeCommentId: 'user-comment', nativeOperationId: post.body.operationId,
      text: expected, presentation: { inputKind: 'manual', displayText: INPUT } });
    expect(restored.turns[1]).toMatchObject({ nativeCommentId: 'agent-comment', nativeRunId: 'run', text: OUTPUT,
      presentation: { outputState: 'final', outputContract: presentation(node).outputContract } });
    render(<TileTranscript turns={restored.turns} history={restored.history} streaming={false} limit={Infinity} />);
    expect(screen.getByText(INPUT, { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '会员详情', exact: true })).toBeInTheDocument();
    expect(transport.posts.filter(item => item.url.endsWith('/messages'))).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'] as const)('keeps a %s live result as original evidence rather than a completed structured reply', async status => {
    const transport = transportFixture();
    transport.setTerminal(status);
    const { container } = renderSurface();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: INPUT } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    act(() => {
      transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
      transport.stream.frame('delta', { text: OUTPUT });
      transport.stream.frame('done', { status });
      transport.stream.close();
    });
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const reply = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(reply).toMatchObject({ text: OUTPUT, presentation: { outputState: 'failed' } });
    expect(readableOutput(reply).fields).toEqual([]);
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    expect(screen.queryByRole('heading', { name: '会员详情', exact: true })).toBeNull();
    expect(container.querySelector('.canvas-transcript-turn--agent')).toHaveTextContent(OUTPUT);
  });

  it.each(['error', 'no_run', 'missing-terminal'] as const)('does not project a completed output after %s transport', async ending => {
    const transport = transportFixture();
    const node = nodeFixture();
    const pending = execAgentViaGateway('/gateway-api', node, 'complete execution envelope', {
      operationId: OPERATION, presentation: presentation(node),
    });
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
    transport.stream.frame('delta', { text: OUTPUT });
    if (ending === 'error') transport.stream.frame('error', { detail: 'transport disconnected' });
    if (ending === 'no_run') transport.stream.frame('no_run', { issueId: 'issue', detail: 'run not visible' });
    transport.stream.close();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, unconfirmed: true, output: OUTPUT });
    const reply = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(reply.presentation?.outputState).toBe('failed');
    expect(readableOutput(reply).fields).toEqual([]);
    expect(reply.text).toBe(OUTPUT);
  });

  it('withdraws successful display projection when native settlement confirms cancellation', async () => {
    const transport = transportFixture();
    transport.setTerminal('cancelled');
    const { container } = renderSurface();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: INPUT } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    act(() => {
      transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
      transport.stream.frame('delta', { text: OUTPUT });
      transport.stream.frame('done', { status: 'succeeded' });
      transport.stream.close();
    });
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const reply = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(reply.presentation?.outputState).toBe('failed');
    expect(readableOutput(reply).fields).toEqual([]);
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
  });

  it('keeps success unprojected while settlement is pending and when confirmation is temporarily unavailable', async () => {
    const transport = transportFixture();
    let finishSettlement!: (response: unknown) => void;
    const settlement = new Promise(resolve => { finishSettlement = resolve; });
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => String(url).endsWith('/settle')
      ? settlement : transport.fetchMock(url, init));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderSurface();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: INPUT } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    act(() => {
      transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
      transport.stream.frame('delta', { text: OUTPUT });
      transport.stream.frame('done', { status: 'succeeded' });
      transport.stream.close();
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(true));
    expect(getSnapshot(ID).turns.find(turn => turn.role === 'agent')?.presentation?.outputState).toBe('streaming');
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    expect(container.querySelector('.canvas-transcript-turn--agent')).toHaveTextContent(OUTPUT);
    expect(loadRunJournal()?.nodes[ID].state).toBe('running');
    act(() => finishSettlement({ ok: true, json: async () => ({ confirmed: false }) }));
    await waitFor(() => expect(loadRunJournal()?.nodes[ID]).toMatchObject({ state: 'running', detail: 'recovery_settlement_unconfirmed' }));
    const reply = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(reply.presentation?.outputState).not.toBe('final');
    expect(readableOutput(reply).fields).toEqual([]);
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
  });

  it('updates the live cancellation display even when every presentation-cache write fails', async () => {
    const transport = transportFixture();
    transport.setTerminal('cancelled');
    const { container } = renderSurface();
    const setItem = localStorage.setItem.bind(localStorage);
    let failedWrites = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('awwo.canvas.conversation-presentation.v1:')) {
        failedWrites += 1;
        throw new DOMException('Display cache unavailable', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: INPUT } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    const operationId = transport.posts.find(post => post.url.endsWith('/messages'))!.body.operationId;
    act(() => {
      transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
      transport.stream.frame('delta', { text: OUTPUT });
      transport.stream.frame('done', { status: 'succeeded' });
      transport.stream.close();
    });
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(failedWrites).toBeGreaterThan(0);
    const reply = getSnapshot(ID).turns.find(turn => turn.role === 'agent')!;
    expect(reply).toMatchObject({ recoveryOperationId: operationId, text: OUTPUT, presentation: { outputState: 'failed' } });
    expect(readableOutput(reply).fields).toEqual([]);
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    expect(container.querySelector('.canvas-transcript-turn--agent')).toHaveTextContent(OUTPUT);
    expect(screen.getByTestId('composer-input')).toBeEnabled();
  });

  it('freezes the output contract before the stream and ignores a later success after failure', async () => {
    const transport = transportFixture();
    const node = nodeFixture();
    const metadata = presentation(node);
    const frozen = structuredClone(metadata.outputContract);
    const pending = execAgentViaGateway('/gateway-api', node, 'original request', { operationId: OPERATION, presentation: metadata });
    await waitFor(() => expect(transport.posts.some(post => post.url.endsWith('/messages'))).toBe(true));
    metadata.outputContract!.outputs[0].label = '修改后的字段';
    metadata.outputContract!.outputs[0].type = 'number';
    node.contract!.outputs[0].id = 'replacement';
    transport.stream.frame('accepted', { issueId: 'issue', runId: 'run', runVisible: true });
    transport.stream.frame('delta', { text: OUTPUT });
    transport.stream.frame('done', { status: 'failed' });
    transport.stream.frame('done', { status: 'succeeded' });
    transport.stream.close();
    expect(await pending).toMatchObject({ ok: false });
    expect(getSnapshot(ID).turns.find(turn => turn.role === 'agent')?.presentation).toEqual({ outputContract: frozen, outputState: 'failed' });
  });

  it('fills an interrupted presentation from the confirmed journal on reload without another message POST', async () => {
    const node = nodeFixture();
    const request = `${buildNodeMessage(node, [])}\n\n【用户消息】\n${INPUT}`;
    const journal: CanvasRunJournal = { version: 1, id: 'interrupted-run', startedAt: 1, scope: [ID], manual: true, manualMessage: request,
      nodes: { [ID]: { nodeId: ID, threadId: 'default', companyId: 'company', agentId: 'agent', issueId: 'issue',
        runId: 'run', operationId: OPERATION, state: 'running' } } };
    expect(beginConversationPresentation(node, OPERATION, request, presentation(node))).toBe(true);
    expect(updateConversationPresentation(node, OPERATION, { issueId: 'issue', runId: 'run' })).toBe(true);
    saveRunJournal(journal);
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') posts.push(path);
      if (path.endsWith(`/operations/${OPERATION}`)) return { ok: true, json: async () => ({ operationId: OPERATION,
        state: 'terminal', issueId: 'issue', runId: 'run', terminal: true, status: 'succeeded', output: OUTPUT, outputAvailable: true, detail: null }) };
      if (path.endsWith('/settle')) return { ok: true, json: async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold' }) };
      if (path.endsWith('/conversations/company')) return { ok: true, json: async () => ({ conversations: [{ issueId: 'issue' }] }) };
      if (path.endsWith('/messages')) return { ok: true, json: async () => ({ complete: true, messages: nativeComments(request, OPERATION) }) };
      return { ok: false, status: 503, json: async () => ({}) };
    }));
    renderSurface(node);
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const turns = getSnapshot(ID).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ text: request, presentation: { inputKind: 'manual', displayText: INPUT } });
    expect(turns[1]).toMatchObject({ text: OUTPUT, presentation: { outputState: 'final', outputContract: presentation(node).outputContract } });
    expect(screen.getByRole('heading', { name: '会员详情', exact: true })).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/\/settle$/);
  });
});
