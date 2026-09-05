// SCOPED RUNS + PERSISTED OUTPUTS — the iteration loop.
//
// Before this, `outputs` lived in a Map local to one runGraph call and was rendered nowhere, so
// the canvas threw away everything it produced. That forced every press of 运行图 to re-execute —
// and re-bill — every tile on the canvas, including unbound scratch tiles parked in a corner,
// which preflight also refused the whole run over. Tuning the last node of a five-node pipeline
// meant paying for the four agents above it again.
//
// The loop the product exists for is: look at what came out, adjust one node, carry it forward.
// That needs three things, all pinned here:
//   1. an upstream OUTSIDE the scope contributes what it produced earlier instead of running,
//   2. and is reported as 'cached', never 'done' — it did not run, and a timeline that says it
//      did is a timeline you cannot trust,
//   3. and if it has nothing stored, the run is BLOCKED with a named reason rather than sending
//      an empty precondition downstream, which the agent could not detect.
import { describe, expect, it } from 'vitest';
import { preflightGraph, runGraph, type RunNodeStatus } from '../src/canvas/runGraph';
import {
  createFormNode,
  createSessionNode,
  type CanvasEdge,
  type CanvasNode,
  type SessionNode,
} from '../src/canvas/canvasDoc';

function form(id: string, value: string, at = { x: 0, y: 0 }): CanvasNode {
  return { ...createFormNode(at), id, title: `表单-${id}`, fields: [{ id: `${id}f`, label: '任务', value }] };
}

function agent(id: string, at = { x: 400, y: 0 }, bound = true): SessionNode {
  return {
    ...createSessionNode('llm', at),
    id,
    title: `节点-${id}`,
    binding: bound ? { companyId: 'c1', agentId: `ag-${id}`, agentName: id } : null,
  };
}

function wire(from: string, to: string, fromPort = 'result'): CanvasEdge {
  return { id: `${from}->${to}`, fromNode: from, fromPort, toNode: to, toPort: 'context', dataType: 'text' };
}

/** brief -> plan -> build : the shape the owner described. */
function pipeline() {
  const brief = form('brief', '做一个落地页', { x: 0, y: 0 });
  const plan = agent('plan', { x: 400, y: 0 });
  const build = agent('build', { x: 800, y: 0 });
  return {
    nodes: [brief, plan, build] as CanvasNode[],
    edges: [wire('brief', 'plan', 'data'), wire('plan', 'build')],
  };
}

describe('preflight scoping', () => {
  it('ignores an unbound scratch tile that is not in the scope', () => {
    const { nodes, edges } = pipeline();
    const scratch = agent('scratch', { x: 0, y: 900 }, false);
    const all = [...nodes, scratch];

    // Unscoped, the parked unbound tile refuses the whole canvas — the old behaviour.
    expect(preflightGraph(all, edges)).toContain('未绑定');
    // Scoped to the real pipeline, it is none of the run's business.
    expect(preflightGraph(all, edges, ['brief', 'plan', 'build'])).toBeNull();
  });

  it('refuses an empty scope rather than reporting a vacuous success', () => {
    const { nodes, edges } = pipeline();
    expect(preflightGraph(nodes, edges, [])).toContain('没有选中');
  });

  it('still names an unbound node that IS in the scope', () => {
    const { edges } = pipeline();
    const nodes = [form('brief', 'x'), agent('plan', { x: 400, y: 0 }, false), agent('build')];
    expect(preflightGraph(nodes, edges, ['plan'])).toContain('节点-plan');
  });
});

describe('scoped execution', () => {
  it('re-runs ONE node and reuses the upstream output instead of executing it', async () => {
    const { nodes, edges } = pipeline();
    const ran: string[] = [];
    const statuses: Record<string, RunNodeStatus[]> = {};

    const summary = await runGraph({
      nodes,
      edges,
      scope: ['build'],
      storedOutput: (id) => (id === 'plan' ? '上一轮的方案' : id === 'brief' ? '做一个落地页' : null),
      execAgent: async (n, message) => {
        ran.push(n.id);
        expect(message).toContain('上一轮的方案'); // the reused output really reached it
        return { ok: true, output: '实现完成', detail: '已完成' };
      },
      onStatus: (id, st) => {
        (statuses[id] ??= []).push(st);
      },
    });

    // Exactly one agent turn fired — that is the whole point.
    expect(ran).toEqual(['build']);
    expect(summary).toMatchObject({ ok: true, done: 1, total: 1, failed: 0, blocked: 0 });
    // ...and the reused upstream is CACHED, not done.
    expect(statuses['plan'].at(-1)!.state).toBe('cached');
    expect(statuses['plan'].at(-1)!.detail).toContain('沿用');
    expect(summary.cached).toBeGreaterThan(0);
  });

  it('BLOCKS with a named reason when a reused upstream has nothing stored', async () => {
    const { nodes, edges } = pipeline();
    const ran: string[] = [];
    const statuses: Record<string, RunNodeStatus[]> = {};

    const summary = await runGraph({
      nodes,
      edges,
      scope: ['build'],
      storedOutput: () => null, // nothing has ever run
      execAgent: async (n) => {
        ran.push(n.id);
        return { ok: true, output: 'x', detail: '已完成' };
      },
      onStatus: (id, st) => {
        (statuses[id] ??= []).push(st);
      },
    });

    // No turn fired, and nothing pretended to succeed.
    expect(ran).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(statuses['plan'].at(-1)!.state).toBe('blocked');
    expect(statuses['plan'].at(-1)!.detail).toContain('节点-plan');
    expect(statuses['build'].at(-1)!.state).toBe('blocked');
  });

  it('only badges the nodes the run will touch', async () => {
    const { nodes, edges } = pipeline();
    const touched = new Set<string>();
    await runGraph({
      nodes: [...nodes, agent('parked', { x: 0, y: 900 })],
      edges,
      scope: ['build'],
      storedOutput: () => '上一轮的方案',
      execAgent: async () => ({ ok: true, output: 'ok', detail: '已完成' }),
      onStatus: (id) => touched.add(id),
    });
    // 'parked' is neither in the scope nor upstream of it — it must not be repainted at all.
    expect(touched.has('parked')).toBe(false);
    expect(touched.has('build')).toBe(true);
  });

  it('counts success against the SCOPE, not the canvas', async () => {
    const { nodes, edges } = pipeline();
    const summary = await runGraph({
      nodes: [...nodes, agent('parked', { x: 0, y: 900 })],
      edges,
      scope: ['plan', 'build'],
      storedOutput: (id) => (id === 'brief' ? '做一个落地页' : null),
      execAgent: async () => ({ ok: true, output: 'ok', detail: '已完成' }),
      onStatus: () => {},
    });
    expect(summary.total).toBe(2);
    expect(summary.ok).toBe(true);
  });

  it('an unscoped run is unchanged — the whole canvas, nothing cached', async () => {
    const { nodes, edges } = pipeline();
    const ran: string[] = [];
    const summary = await runGraph({
      nodes,
      edges,
      execAgent: async (n) => {
        ran.push(n.id);
        return { ok: true, output: 'ok', detail: '已完成' };
      },
      onStatus: () => {},
    });
    expect(ran.sort()).toEqual(['build', 'plan']);
    expect(summary).toMatchObject({ ok: true, done: 3, total: 3, cached: 0 });
  });
});
