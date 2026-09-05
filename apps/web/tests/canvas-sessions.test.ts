// Per-node session store + the tile's manual conversation transport.
//
// What is being defended here: the transcript is module-level BECAUSE tiles unmount when culled
// and the run engine writes from outside React — so snapshot stability, per-node notification
// isolation, the local-send guard and the stale-stream guard are the correctness surface, not
// implementation detail. Plus the honesty invariants: an unreadable history is never rendered as
// an empty one, and a node's thread is its own (never "the agent's latest conversation").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatFrame } from '../src/canvasAgentChat';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import * as sessions from '../src/canvas/sessions';
import { restoreHistory, sendMessage } from '../src/canvas/sessionTransport';
import { persistRecoveredManualConversation } from '../src/canvas/runRecoveryDocument';
import type { CanvasRunJournal } from '../src/canvas/runJournal';

const streamMock = vi.fn();
const indexMock = vi.fn();
const messagesMock = vi.fn();
vi.mock('../src/canvasAgentChat', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/canvasAgentChat')>();
  return {
    ...orig,
    streamAgentConversation: (...args: unknown[]) => streamMock(...args),
    fetchConversationIndex: (...args: unknown[]) => indexMock(...args),
    fetchConversationMessages: (...args: unknown[]) => messagesMock(...args),
  };
});

/** A fresh node per test — ids are unique, so the module-level store/guards never leak across. */
function boundNode(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    ...createSessionNode('llm', { x: 0, y: 0 }),
    binding: { companyId: 'c1', agentId: 'ag-1', agentName: 'dev' },
    ...overrides,
  };
}

function emitting(frames: AgentChatFrame[]) {
  return async (
    _base: string,
    _company: string,
    _agent: string,
    _message: string,
    onFrame: (f: AgentChatFrame) => void,
  ) => {
    for (const f of frames) onFrame(f);
  };
}

beforeEach(() => {
  localStorage.clear();
  sessions.resetAllSessions();
  streamMock.mockReset();
  indexMock.mockReset();
  messagesMock.mockReset();
});

describe('sessions store', () => {
  it('an untouched node yields the SAME snapshot object every call (useSyncExternalStore safety)', () => {
    const a = sessions.getSnapshot('n1');
    expect(sessions.getSnapshot('n1')).toBe(a);
    // Different untouched nodes share the pristine snapshot — still a stable reference each.
    expect(sessions.getSnapshot('n2')).toBe(a);
    expect(a).toMatchObject({ turns: [], streaming: false, status: null, history: 'unloaded' });
  });

  it('notifies ONLY the changed node, and hands out a new snapshot only when something changed', () => {
    const hits: Record<string, number> = { a: 0, b: 0 };
    sessions.subscribe('a', () => (hits.a += 1));
    sessions.subscribe('b', () => (hits.b += 1));
    const beforeB = sessions.getSnapshot('b');

    sessions.appendTurn('a', { role: 'user', text: 'hi' });
    expect(hits).toEqual({ a: 1, b: 0 });
    expect(sessions.getSnapshot('b')).toBe(beforeB);

    const afterA = sessions.getSnapshot('a');
    // Idempotent writes must not churn: same value → no new object, no notification.
    sessions.setStreaming('a', false);
    sessions.setStatus('a', null);
    sessions.setHistory('a', 'unloaded');
    sessions.patchTurn('a', 999, 'nowhere');
    sessions.appendToTurn('a', 999, 'nowhere');
    sessions.appendToTurn('a', 1, '');
    expect(hits.a).toBe(1);
    expect(sessions.getSnapshot('a')).toBe(afterA);

    sessions.setStreaming('a', true);
    expect(hits.a).toBe(2);
    expect(sessions.getSnapshot('a')).not.toBe(afterA);
  });

  it('unsubscribe stops delivery to that listener only', () => {
    let one = 0;
    let two = 0;
    const off = sessions.subscribe('a', () => (one += 1));
    sessions.subscribe('a', () => (two += 1));
    off();
    sessions.appendTurn('a', { role: 'user', text: 'x' });
    expect(one).toBe(0);
    expect(two).toBe(1);
  });

  it('appendTurn mints ids; patchTurn/appendToTurn address them; reset wipes back to pristine', () => {
    const first = sessions.appendTurn('a', { role: 'user', text: '问题' });
    const second = sessions.appendTurn('a', { role: 'agent', text: '' });
    expect(second).not.toBe(first);

    sessions.appendToTurn('a', second, '答');
    sessions.appendToTurn('a', second, '案');
    expect(sessions.getSnapshot('a').turns[1].text).toBe('答案');

    sessions.patchTurn('a', second, '出错：boom', 'error');
    expect(sessions.getSnapshot('a').turns[1]).toMatchObject({ text: '出错：boom', tone: 'error' });

    sessions.reset('a');
    expect(sessions.getSnapshot('a').turns).toEqual([]);
    expect(sessions.getSnapshot('a').history).toBe('unloaded');
  });

  it('replaceTurns mints fresh ids so an in-flight append can never land on a replayed turn', () => {
    const live = sessions.appendTurn('a', { role: 'agent', text: 'live' });
    sessions.replaceTurns('a', [
      { role: 'user', text: 'stored q' },
      { role: 'agent', text: 'stored a' },
    ]);
    const ids = sessions.getSnapshot('a').turns.map((t) => t.id);
    expect(ids).not.toContain(live);
    // The stale id addresses nothing — the write is dropped rather than corrupting a replayed turn.
    sessions.appendToTurn('a', live, 'LEAK');
    expect(sessions.getSnapshot('a').turns.map((t) => t.text)).toEqual(['stored q', 'stored a']);
  });

  it('lastLine reads the last non-empty line of the last non-empty turn', () => {
    expect(sessions.lastLine('a')).toBe('');
    sessions.appendTurn('a', { role: 'user', text: '  开始  ' });
    expect(sessions.lastLine('a')).toBe('开始');
    sessions.appendTurn('a', { role: 'agent', text: '第一行\n最后一行\n\n' });
    expect(sessions.lastLine('a')).toBe('最后一行');
    // A trailing empty (still-streaming) turn falls back to the last one that has text.
    sessions.appendTurn('a', { role: 'agent', text: '' });
    expect(sessions.lastLine('a')).toBe('最后一行');
  });
});

describe('restoreHistory', () => {
  it('a NULL index is "unreadable", never an empty transcript', async () => {
    indexMock.mockResolvedValue(null);
    const node = boundNode({ issueId: 'iss-1' });
    await restoreHistory({ gatewayBase: '/gw', node });
    expect(sessions.getSnapshot(node.id).history).toBe('unreadable');
    expect(sessions.getSnapshot(node.id).turns).toEqual([]);
    expect(messagesMock).not.toHaveBeenCalled();
  });

  it('unreadable MESSAGES are also "unreadable", not an empty transcript', async () => {
    indexMock.mockResolvedValue([{ issueId: 'iss-1', title: '', agentId: 'ag-1', updatedAt: null }]);
    messagesMock.mockResolvedValue(null);
    const node = boundNode({ issueId: 'iss-1' });
    await restoreHistory({ gatewayBase: '/gw', node });
    expect(sessions.getSnapshot(node.id).history).toBe('unreadable');
  });

  it('an aborted history restore leaves a retryable state instead of loading forever', async () => {
    const controller = new AbortController();
    indexMock.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const node = boundNode({ issueId: 'iss-1' });
    await restoreHistory({ gatewayBase: '/gw', node, signal: controller.signal });
    expect(sessions.getSnapshot(node.id).history).toBe('unloaded');
  });

  it('replays THIS node own thread — the issueId asked for is the node own', async () => {
    indexMock.mockResolvedValue([
      { issueId: 'other-tile', title: '', agentId: 'ag-1', updatedAt: '2026-12-01' },
      { issueId: 'mine', title: '', agentId: 'ag-1', updatedAt: '2026-01-01' },
    ]);
    messagesMock.mockResolvedValue([
      { role: 'user', text: '之前问的' },
      { role: 'agent', text: '之前答的' },
    ]);
    // Two tiles share agent ag-1; 'other-tile' is the MORE recent conversation. The old
    // "agent's latest issue" rule would steal it — this node must read only its own.
    const node = boundNode({ issueId: 'mine' });
    await restoreHistory({ gatewayBase: '/gw', node });
    expect(messagesMock.mock.calls[0][2]).toBe('mine');
    expect(sessions.getSnapshot(node.id).turns.map((t) => t.text)).toEqual(['之前问的', '之前答的']);
    expect(sessions.getSnapshot(node.id).history).toBe('loaded');
  });

  it('merges locally persisted recovery evidence after every fresh server-history restore', async () => {
    const node = boundNode({ id: 'durable-manual-node', issueId: 'mine' });
    const journal: CanvasRunJournal = {
      version: 1, id: 'journal-1', startedAt: 100, scope: [node.id], manual: true,
      manualMessage: 'detached question',
      nodes: {
        [node.id]: {
          nodeId: node.id, threadId: 'default', companyId: 'c1', agentId: 'ag-1', issueId: 'mine',
          runId: 'run-1', operationId: '11111111-1111-4111-8111-111111111111', state: 'done', output: 'stdout-only answer',
        },
      },
    };
    expect(persistRecoveredManualConversation(node, journal)).toBe(true);
    indexMock.mockResolvedValue([{ issueId: 'mine', title: '', agentId: 'ag-1', updatedAt: null }]);
    messagesMock.mockResolvedValue([{ role: 'user', text: 'older question' }]);

    await restoreHistory({ gatewayBase: '/gw', node });

    expect(sessions.getSnapshot(node.id).turns.map(turn => turn.text)).toEqual([
      'older question', 'detached question', 'stdout-only answer',
    ]);
    expect(sessions.getSnapshot(node.id).history).toBe('loaded');
  });

  it('a node with no thread of its own reads nothing at all (no fallback to the agent latest)', async () => {
    const node = boundNode({ issueId: null });
    await restoreHistory({ gatewayBase: '/gw', node });
    expect(indexMock).not.toHaveBeenCalled();
    expect(messagesMock).not.toHaveBeenCalled();
    expect(sessions.getSnapshot(node.id).history).toBe('loaded');
  });

  it('an unbound node is honestly "loaded" with nothing, and touches no network', async () => {
    const node = boundNode({ binding: null, issueId: 'iss-1' });
    await restoreHistory({ gatewayBase: '/gw', node });
    expect(indexMock).not.toHaveBeenCalled();
    expect(sessions.getSnapshot(node.id).history).toBe('loaded');
  });

  it('LOCAL-SEND GUARD: a late replay cannot clobber turns already sent from this client', async () => {
    const node = boundNode({ issueId: 'iss-1' });
    streamMock.mockImplementation(emitting([{ event: 'delta', text: '实时回复' }, { event: 'done', status: 'succeeded' }]));
    await sendMessage({ gatewayBase: '/gw', node, text: '现在问的' });

    indexMock.mockResolvedValue([{ issueId: 'iss-1', title: '', agentId: 'ag-1', updatedAt: null }]);
    messagesMock.mockResolvedValue([{ role: 'user', text: '陈旧快照' }]);
    await restoreHistory({ gatewayBase: '/gw', node });

    const texts = sessions.getSnapshot(node.id).turns.map((t) => t.text);
    expect(texts).toEqual(['现在问的', '实时回复']);
    expect(sessions.getSnapshot(node.id).history).toBe('loaded');
  });
});

describe('sendMessage', () => {
  it('sends on the node OWN issueId and reports a server-minted one back', async () => {
    const minted: string[] = [];
    streamMock.mockImplementation(emitting([
      { event: 'accepted', issueId: 'iss-server', runId: 'r1', runVisible: true },
      { event: 'delta', text: 'ok' },
      { event: 'done', status: 'succeeded' },
    ]));
    const node = boundNode({ issueId: null });
    await sendMessage({ gatewayBase: '/gw', node, text: '开工', onIssueId: (id) => minted.push(id) });

    const opts = streamMock.mock.calls[0][5] as { issueId?: string };
    expect(opts.issueId).toBeUndefined(); // no thread yet — the server mints one
    expect(minted).toEqual(['iss-server']);

    // An existing thread is continued, and an echo of the same id is not re-reported.
    streamMock.mockClear();
    const again: string[] = [];
    const node2 = boundNode({ issueId: 'iss-server' });
    await sendMessage({ gatewayBase: '/gw', node: node2, text: '继续', onIssueId: (id) => again.push(id) });
    expect((streamMock.mock.calls[0][5] as { issueId?: string }).issueId).toBe('iss-server');
    expect(again).toEqual([]);
  });

  it('streams deltas into the agent turn and settles streaming state honestly', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'status', status: 'running' },
      { event: 'delta', text: '你好' },
      { event: 'delta', text: '世界' },
      { event: 'done', status: 'succeeded' },
    ]));
    const node = boundNode({ issueId: 'iss-1' });
    await sendMessage({ gatewayBase: '/gw', node, text: '在吗' });
    const s = sessions.getSnapshot(node.id);
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', '在吗'],
      ['agent', '你好世界'],
    ]);
    expect(s.streaming).toBe(false);
    expect(s.status).toBeNull();
  });

  it('ignores every frame after the first terminal event', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'delta', text: '最终回复' },
      { event: 'done', status: 'succeeded' },
      { event: 'delta', text: '迟到内容' },
      { event: 'status', status: 'failed' },
      { event: 'error', detail: 'late teardown' },
    ]));
    const node = boundNode({ issueId: 'iss-1' });
    await sendMessage({ gatewayBase: '/gw', node, text: '在吗' });
    expect(sessions.getSnapshot(node.id).turns.map((turn) => turn.text)).toEqual(['在吗', '最终回复']);
  });

  it('a run with NO text output says so instead of showing an empty reply', async () => {
    streamMock.mockImplementation(emitting([{ event: 'done', status: 'failed' }]));
    const node = boundNode({ issueId: 'iss-1' });
    await sendMessage({ gatewayBase: '/gw', node, text: 'x' });
    const agentTurn = sessions.getSnapshot(node.id).turns[1];
    expect(agentTurn.text).toContain('失败');
    expect(agentTurn.tone).toBe('info');
  });

  it('an error before any text becomes the reply; after text it is appended as a system turn', async () => {
    streamMock.mockImplementation(emitting([{ event: 'error', detail: 'boom' }]));
    const a = boundNode({ issueId: 'i' });
    await sendMessage({ gatewayBase: '/gw', node: a, text: 'x' });
    expect(sessions.getSnapshot(a.id).turns[1]).toMatchObject({ text: '出错：boom', tone: 'error' });

    streamMock.mockImplementation(emitting([{ event: 'delta', text: '半截' }, { event: 'error', detail: '断了' }]));
    const b = boundNode({ issueId: 'i' });
    await sendMessage({ gatewayBase: '/gw', node: b, text: 'x' });
    const turns = sessions.getSnapshot(b.id).turns;
    expect(turns[1].text).toBe('半截'); // partial output kept as evidence
    expect(turns[2]).toMatchObject({ role: 'system', text: '出错：断了', tone: 'error' });
  });

  // The SSE client reports a user-initiated stop as an error frame whose detail is the internal
  // token 'aborted'. Rendering that verbatim would mislabel a deliberate action as a failure AND
  // leak an English internal string into a Chinese transcript.
  it('a user-initiated stop reads as a stop, not as 出错：aborted', async () => {
    streamMock.mockImplementation(emitting([{ event: 'error', detail: 'aborted' }]));
    const a = boundNode({ issueId: 'i' });
    await sendMessage({ gatewayBase: '/gw', node: a, text: 'x' });
    const turn = sessions.getSnapshot(a.id).turns[1];
    expect(turn.text).not.toContain('aborted');
    expect(turn.text).not.toContain('出错');
    expect(turn.text).toContain('已停止');
    expect(turn.tone).toBe('info');

    streamMock.mockImplementation(emitting([{ event: 'delta', text: '半截' }, { event: 'error', detail: 'aborted' }]));
    const b = boundNode({ issueId: 'i' });
    await sendMessage({ gatewayBase: '/gw', node: b, text: 'x' });
    const turns = sessions.getSnapshot(b.id).turns;
    expect(turns[1].text).toBe('半截');
    expect(turns[2]).toMatchObject({ role: 'system', tone: 'info' });
    expect(turns[2].text).toContain('已停止');
  });

  it('no_run is reported honestly and still binds the thread it landed on', async () => {
    const minted: string[] = [];
    streamMock.mockImplementation(emitting([{ event: 'no_run', issueId: 'iss-x', detail: 'later' }]));
    const node = boundNode({ issueId: null });
    await sendMessage({ gatewayBase: '/gw', node, text: 'x', onIssueId: (id) => minted.push(id) });
    expect(sessions.getSnapshot(node.id).turns[1]).toMatchObject({ tone: 'warn' });
    expect(sessions.getSnapshot(node.id).turns[1].text).toContain('无可见运行');
    expect(minted).toEqual(['iss-x']);
  });

  it('an unbound node refuses to send and says why (no network)', async () => {
    const node = boundNode({ binding: null });
    await sendMessage({ gatewayBase: '/gw', node, text: 'x' });
    expect(streamMock).not.toHaveBeenCalled();
    expect(sessions.getSnapshot(node.id).turns[0]).toMatchObject({ role: 'system', tone: 'error' });
  });

  it('STALE-STREAM GUARD: a superseded stream frames are dropped and it cannot stop the live spinner', async () => {
    const pending: Array<{ onFrame: (f: AgentChatFrame) => void; resolve: () => void }> = [];
    streamMock.mockImplementation(
      (..._args: unknown[]) =>
        new Promise<void>((resolve) => {
          pending.push({ onFrame: _args[4] as (f: AgentChatFrame) => void, resolve });
        }),
    );
    const node = boundNode({ issueId: 'iss-1' });
    const first = sendMessage({ gatewayBase: '/gw', node, text: 'one' });
    const second = sendMessage({ gatewayBase: '/gw', node, text: 'two' });
    expect(pending).toHaveLength(2);

    pending[0].onFrame({ event: 'delta', text: 'STALE' });
    pending[0].onFrame({ event: 'accepted', issueId: 'stale-issue', runId: null, runVisible: true });
    pending[1].onFrame({ event: 'delta', text: 'LIVE' });

    const turns = sessions.getSnapshot(node.id).turns;
    expect(turns.map((t) => t.text)).toEqual(['one', '', 'two', 'LIVE']);

    // The superseded stream finishing must NOT clear the live stream's streaming state.
    pending[0].resolve();
    await first;
    expect(sessions.getSnapshot(node.id).streaming).toBe(true);

    pending[1].resolve();
    await second;
    expect(sessions.getSnapshot(node.id).streaming).toBe(false);
  });
});
