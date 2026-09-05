// Canvas graph execution engine + its gateway transport.
//
// The engine is the ported, production-verified workflow runner: topological order, upstream
// output injection, concurrent independent branches, honest failure/block propagation, abort,
// preflight, and per-agent serialization. The transport adds the canvas's two changes: the run
// turn lands on THIS NODE's own thread, and every frame is mirrored into the tile's transcript.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatFrame } from '../src/canvasAgentChat';
import {
  createFormNode,
  createSessionNode,
  type CanvasEdge,
  type FormNode,
  type SessionNode,
} from '../src/canvas/canvasDoc';
import {
  buildNodeMessage,
  findCycle,
  preflightGraph,
  runGraph,
  serializeFormOutput,
  withPerKeySerialization,
  type RunNodeStatus,
} from '../src/canvas/runGraph';
import { createGatewayExecutor, execAgentViaGateway } from '../src/canvas/runTransport';
import * as sessions from '../src/canvas/sessions';

const streamMock = vi.fn();
const indexMock = vi.fn();
vi.mock('../src/canvasAgentChat', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/canvasAgentChat')>();
  return {
    ...orig,
    streamAgentConversation: (...args: unknown[]) => streamMock(...args),
    fetchConversationIndex: (...args: unknown[]) => indexMock(...args),
  };
});

function agent(id: string, title: string, binding?: SessionNode['binding']): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id,
    title,
    runtime: 'claude_local',
    binding: binding ?? { companyId: 'c1', agentId: `ag-${id}`, agentName: title },
  };
}
function form(id: string): FormNode {
  return {
    ...createFormNode({ x: 0, y: 0 }),
    id,
    fields: [
      { id: 'f1', label: '目标', value: '做一个落地页' },
      { id: 'f2', label: '约束', value: '' },
    ],
  };
}
function edge(fromNode: string, toNode: string, fromPort = 'result', toPort = 'context'): CanvasEdge {
  return { id: `${fromNode}:${fromPort}->${toNode}:${toPort}`, fromNode, fromPort, toNode, toPort, dataType: 'text' };
}

beforeEach(() => {
  sessions.resetAllSessions();
  streamMock.mockReset();
  indexMock.mockReset();
});

describe('runGraph engine', () => {
  it('findCycle: acyclic diamond → [], cycle → its members', () => {
    const nodes = [agent('a', 'A'), agent('b', 'B'), agent('c', 'C')];
    expect(findCycle(nodes, [edge('a', 'b'), edge('a', 'c')])).toEqual([]);
    expect(findCycle(nodes, [edge('a', 'b'), edge('b', 'a')]).sort()).toEqual(['a', 'b']);
  });

  it('preflight refuses empty graphs, unbound sessions (named), and cycles', () => {
    expect(preflightGraph([], [])).toContain('还没有节点');
    const unbound = { ...agent('u', '孤儿节点'), binding: null };
    expect(preflightGraph([unbound], [])).toContain('孤儿节点');
    const nodes = [agent('a', 'A'), agent('b', 'B')];
    expect(preflightGraph(nodes, [edge('a', 'b'), edge('b', 'a')])).toContain('环');
    expect(preflightGraph(nodes, [edge('a', 'b')])).toBeNull();
  });

  it('serializeFormOutput labels every field and marks blanks honestly', () => {
    const out = serializeFormOutput(form('f'));
    expect(out).toContain('目标: 做一个落地页');
    expect(out).toContain('约束: （未填写）');
  });

  it('buildNodeMessage frames the task and labels each upstream input by source + port', () => {
    const msg = buildNodeMessage(agent('a', '前端实现'), [
      { fromTitle: '需求表单', toPort: 'context', output: '目标: 做一个落地页' },
    ]);
    expect(msg).toContain('前端实现');
    expect(msg).toContain('来自「需求表单」→ context');
    expect(msg).toContain('目标: 做一个落地页');
    expect(msg).toContain('请基于以上前置输入');
  });

  // A root node has NO preconditions — telling it to work "基于以上前置输入" points at nothing
  // and invites the agent to invent the context it was told to rely on.
  it('buildNodeMessage does not claim upstream input a ROOT node never received', () => {
    const msg = buildNodeMessage(agent('a', '选题'), []);
    expect(msg).toContain('选题');
    expect(msg).not.toContain('基于以上前置输入');
    expect(msg).toContain('没有上游输入');
    expect(msg).toContain('本节点的最终输出');
  });

  it('runs a chain in dependency order and pipes upstream outputs downstream', async () => {
    const calls: Array<{ title: string; message: string }> = [];
    const statuses: Record<string, RunNodeStatus[]> = {};
    const summary = await runGraph({
      nodes: [form('f'), agent('a', '策划'), agent('b', '实现')],
      edges: [edge('f', 'a', 'data', 'context'), edge('a', 'b')],
      execAgent: async (node, message) => {
        calls.push({ title: node.title, message });
        return { ok: true, output: `${node.title}-OUT`, detail: '已完成' };
      },
      onStatus: (id, s) => {
        (statuses[id] ??= []).push(s);
      },
    });
    expect(summary).toMatchObject({ ok: true, done: 3, failed: 0, blocked: 0, total: 3 });
    expect(calls.map((c) => c.title)).toEqual(['策划', '实现']);
    expect(calls[0].message).toContain('目标: 做一个落地页');
    expect(calls[1].message).toContain('策划-OUT');
    expect(statuses.b.map((s) => s.state)).toEqual(['waiting', 'running', 'done']);
  });

  it('independent branches start concurrently (no false serialization)', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = runGraph({
      nodes: [agent('a', 'A'), agent('b', 'B'), agent('c', 'C')],
      edges: [edge('a', 'c'), edge('b', 'c')],
      execAgent: async (node) => {
        started.push(node.id);
        if (node.id !== 'c') await gate;
        return { ok: true, output: node.id, detail: '' };
      },
      onStatus: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(started.sort()).toEqual(['a', 'b']); // both roots in flight, their join still waiting
    release();
    expect((await run).done).toBe(3);
  });

  it('a failed node blocks its downstream but sibling branches still complete', async () => {
    const statuses: Record<string, RunNodeStatus> = {};
    const summary = await runGraph({
      nodes: [agent('a', '会失败'), agent('b', '下游'), agent('d', '独立')],
      edges: [edge('a', 'b')],
      execAgent: async (node) =>
        node.id === 'a'
          ? { ok: false, output: '部分输出', detail: '运行失败' }
          : { ok: true, output: 'ok', detail: '已完成' },
      onStatus: (id, s) => {
        statuses[id] = s;
      },
    });
    expect(summary).toMatchObject({ ok: false, done: 1, failed: 1, blocked: 1 });
    expect(statuses.a).toMatchObject({ state: 'failed', output: '部分输出' }); // partial evidence kept
    expect(statuses.b).toMatchObject({ state: 'blocked', detail: '上游未完成' });
    expect(statuses.d.state).toBe('done');
  });

  it('an aborted run marks untouched nodes 已停止 and never fakes completion', async () => {
    const ac = new AbortController();
    ac.abort();
    const execAgent = vi.fn(async () => ({ ok: true, output: 'x', detail: '' }));
    const statuses: Record<string, RunNodeStatus> = {};
    const summary = await runGraph({
      nodes: [agent('a', 'A')],
      edges: [],
      execAgent,
      onStatus: (id, s) => {
        statuses[id] = s;
      },
      signal: ac.signal,
    });
    expect(execAgent).not.toHaveBeenCalled();
    expect(statuses.a).toMatchObject({ state: 'blocked', detail: '已停止' });
    expect(summary.ok).toBe(false);
  });

  it('a THROWING transport marks only that node failed instead of rejecting the run', async () => {
    const statuses: Record<string, RunNodeStatus> = {};
    const summary = await runGraph({
      nodes: [agent('a', 'A'), agent('b', 'B'), agent('d', '独立')],
      edges: [edge('a', 'b')],
      execAgent: async (node) => {
        if (node.id === 'a') throw new Error('transport 崩了');
        return { ok: true, output: 'x', detail: '' };
      },
      onStatus: (id, s) => {
        statuses[id] = s;
      },
    });
    expect(statuses.a).toMatchObject({ state: 'failed', detail: 'transport 崩了' });
    expect(statuses.b.state).toBe('blocked');
    expect(statuses.d.state).toBe('done');
    expect(summary.failed).toBe(1);
  });

  it('withPerKeySerialization: same key strictly serializes, different keys stay concurrent', async () => {
    const running = new Set<string>();
    let sameKeyOverlap = false;
    let crossKeyConcurrency = false;
    const fn = withPerKeySerialization(
      (key: string) => key,
      async (key: string) => {
        if (running.has(key)) sameKeyOverlap = true;
        if ([...running].some((k) => k !== key)) crossKeyConcurrency = true;
        running.add(key);
        await new Promise((r) => setTimeout(r, 5));
        running.delete(key);
        return key;
      },
    );
    await Promise.all([fn('x'), fn('x'), fn('y'), fn('x')]);
    expect(sameKeyOverlap).toBe(false);
    expect(crossKeyConcurrency).toBe(true);
  });

  it('withPerKeySerialization: a rejection does not break the chain for later calls', async () => {
    let calls = 0;
    const fn = withPerKeySerialization(
      () => 'k',
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('first fails');
        return 'ok';
      },
    );
    await expect(fn()).rejects.toThrow('first fails');
    await expect(fn()).resolves.toBe('ok');
  });

  it('refuses to run a cyclic graph instead of deadlocking', async () => {
    const summary = await runGraph({
      nodes: [agent('a', 'A'), agent('b', 'B')],
      edges: [edge('a', 'b'), edge('b', 'a')],
      execAgent: async () => ({ ok: true, output: '', detail: '' }),
      onStatus: () => {},
    });
    expect(summary).toMatchObject({ ok: false, done: 0, total: 2 });
  });
});

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

describe('execAgentViaGateway', () => {
  it('ok only on done:succeeded, with the streamed text as output', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'delta', text: '你好' },
      { event: 'delta', text: '世界' },
      { event: 'done', status: 'succeeded' },
    ]));
    const r = await execAgentViaGateway('/gw', agent('a', 'A'), 'msg');
    expect(r).toMatchObject({ ok: true, output: '你好世界', detail: '已完成' });
  });

  it('done with a non-success status is NOT ok (honest terminal)', async () => {
    streamMock.mockImplementation(emitting([{ event: 'done', status: 'failed' }]));
    const r = await execAgentViaGateway('/gw', agent('a', 'A'), 'msg');
    expect(r).toMatchObject({ ok: false, detail: '运行失败' });
  });

  it('FIRST terminal wins: an error before done:succeeded stays a failure', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'error', detail: 'boom' },
      { event: 'done', status: 'succeeded' },
    ]));
    expect(await execAgentViaGateway('/gw', agent('a', 'A'), 'msg')).toMatchObject({ ok: false, detail: 'boom' });
  });

  it('FIRST terminal wins: a late teardown error cannot flip a real success', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'done', status: 'succeeded' },
      { event: 'error', detail: 'stream teardown' },
    ]));
    expect((await execAgentViaGateway('/gw', agent('a', 'A'), 'msg')).ok).toBe(true);
  });

  it('a stream that ends with NO terminal is reported as interrupted, never 成功', async () => {
    streamMock.mockImplementation(emitting([{ event: 'delta', text: '半截' }]));
    const r = await execAgentViaGateway('/gw', agent('a', 'A'), 'msg');
    expect(r).toMatchObject({ ok: false, output: '半截' });
    expect(r.detail).toContain('中断');
  });

  it('no_run is honest: delivered but not ok', async () => {
    streamMock.mockImplementation(emitting([{ event: 'no_run', issueId: 'i', detail: 'later' }]));
    const r = await execAgentViaGateway('/gw', agent('a', 'A'), 'msg');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('无可见运行');
  });

  it('runs on THIS node own thread — never discovers the agent latest conversation', async () => {
    streamMock.mockImplementation(emitting([{ event: 'done', status: 'succeeded' }]));
    const node = { ...agent('a', 'A'), issueId: 'my-thread' };
    await execAgentViaGateway('/gw', node, 'msg');
    expect(indexMock).not.toHaveBeenCalled();
    expect((streamMock.mock.calls[0][5] as { issueId?: string }).issueId).toBe('my-thread');
  });

  it('reports a server-minted issueId back so the node can persist its thread', async () => {
    const minted: string[] = [];
    streamMock.mockImplementation(emitting([
      { event: 'accepted', issueId: 'iss-new', runId: 'r', runVisible: true },
      { event: 'done', status: 'succeeded' },
    ]));
    const node = { ...agent('a', 'A'), issueId: null };
    await execAgentViaGateway('/gw', node, 'msg', { onIssueId: (id) => minted.push(id) });
    expect((streamMock.mock.calls[0][5] as { issueId?: string }).issueId).toBeUndefined();
    expect(minted).toEqual(['iss-new']);
  });

  it('mirrors the whole run into the node own transcript, live', async () => {
    streamMock.mockImplementation(emitting([
      { event: 'status', status: 'running' },
      { event: 'delta', text: '干活中' },
      { event: 'done', status: 'succeeded' },
    ]));
    const node = agent('a', 'A');
    await execAgentViaGateway('/gw', node, '【工作流节点】A');
    const s = sessions.getSnapshot(node.id);
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', '【工作流节点】A'],
      ['agent', '干活中'],
    ]);
    expect(s.streaming).toBe(false);
    expect(s.status).toBeNull();
  });

  it('a failed run leaves the failure visible in the tile, not a blank reply', async () => {
    streamMock.mockImplementation(emitting([{ event: 'error', detail: 'boom' }]));
    const node = agent('a', 'A');
    await execAgentViaGateway('/gw', node, 'msg');
    expect(sessions.getSnapshot(node.id).turns[1]).toMatchObject({ text: '出错：boom', tone: 'error' });
  });

  // Stopping a run marks the node 已停止 in the timeline; the tile must not contradict that by
  // rendering the SSE client's internal 'aborted' token as a failure.
  it('a stopped run mirrors a stop into the tile, not 出错：aborted', async () => {
    streamMock.mockImplementation(emitting([{ event: 'error', detail: 'aborted' }]));
    const node = agent('a', 'A');
    await execAgentViaGateway('/gw', node, 'msg');
    const turn = sessions.getSnapshot(node.id).turns[1];
    expect(turn.text).not.toContain('aborted');
    expect(turn.text).not.toContain('出错');
    expect(turn.text).toContain('已停止');
    expect(turn.tone).toBe('info');
  });

  it('an unbound node is refused up front (defensive; preflight already gates)', async () => {
    const r = await execAgentViaGateway('/gw', { ...agent('a', 'A'), binding: null }, 'msg');
    expect(r.ok).toBe(false);
    expect(streamMock).not.toHaveBeenCalled();
  });
});

describe('createGatewayExecutor', () => {
  function trackingStream() {
    let inflight = 0;
    const seen = { max: 0 };
    streamMock.mockImplementation(async (..._args: unknown[]) => {
      inflight += 1;
      seen.max = Math.max(seen.max, inflight);
      await new Promise((r) => setTimeout(r, 5));
      (_args[4] as (f: AgentChatFrame) => void)({ event: 'done', status: 'succeeded' });
      inflight -= 1;
    });
    return seen;
  }

  it('two nodes bound to the SAME agent never execute concurrently', async () => {
    const seen = trackingStream();
    const shared = { companyId: 'c1', agentId: 'shared', agentName: 'x' };
    const summary = await runGraph({
      nodes: [agent('a', 'A', shared), agent('b', 'B', shared)],
      edges: [],
      execAgent: createGatewayExecutor({ gatewayBase: '/gw' }),
      onStatus: () => {},
    });
    expect(summary.done).toBe(2);
    expect(seen.max).toBe(1);
  });

  it('nodes bound to DIFFERENT agents still run concurrently', async () => {
    const seen = trackingStream();
    await runGraph({
      nodes: [agent('a', 'A'), agent('b', 'B')],
      edges: [],
      execAgent: createGatewayExecutor({ gatewayBase: '/gw' }),
      onStatus: () => {},
    });
    expect(seen.max).toBe(2);
  });
});
