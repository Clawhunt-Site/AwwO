import { describe, expect, it, vi } from 'vitest';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { preflightGraphIssue, runGraph, type ExecAgentResult } from '../src/canvas/runGraph';
import { preflightReviewGraphIssue, runReviewGraph, type ReviewGraphPolicy } from '../src/canvas/reviewGraph';
import type { ContractField } from '../src/canvas/nodeContracts';
import { canvasText } from '../src/canvas/i18n';
import { preflightIssueMessage } from '../src/canvas/surfaceMessages';

const field = (id: string, type: ContractField['type'] = 'markdown', value = '', required = true): ContractField => ({
  id, label: id, type, value, required,
});
function graph() {
  const author: SessionNode = {
    ...createSessionNode('coding', { x: 0, y: 0 }), id: 'author', title: 'Author',
    binding: { companyId: 'test-company', agentId: 'author-agent', agentName: 'Author' },
    contract: { version: 1, inputs: [field('task', 'text', 'Build a landing page'), field('feedback', 'markdown', '', false)], outputs: [field('artifact')] },
  };
  const reviewer: SessionNode = {
    ...createSessionNode('coding', { x: 500, y: 0 }), id: 'reviewer', title: 'Reviewer',
    binding: { companyId: 'test-company', agentId: 'reviewer-agent', agentName: 'Reviewer' },
    contract: { version: 1, inputs: [field('candidate')], outputs: [field('approved', 'boolean'), field('notes')] },
  };
  const edges: CanvasEdge[] = [
    { id: 'candidate', fromNode: author.id, fromPort: 'out:artifact', toNode: reviewer.id, toPort: 'in:candidate', dataType: 'text' },
    { id: 'feedback', fromNode: reviewer.id, fromPort: 'out:notes', toNode: author.id, toPort: 'in:feedback', dataType: 'text', kind: 'feedback' },
  ];
  const policy: ReviewGraphPolicy = { mode: 'review', maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved' };
  return { nodes: [author, reviewer], edges, policy, author, reviewer };
}
function ok(output: string): ExecAgentResult { return { ok: true, output, detail: 'succeeded' }; }
const review = (approved: boolean, notes = 'Check responsive layout') => JSON.stringify({ approved, notes });

describe('review Graph preflight', () => {
  it('accepts an explicit feedback loop while the legacy workflow still refuses it', () => {
    const { nodes, edges, policy } = graph();
    expect(preflightReviewGraphIssue(nodes, edges, policy)).toBeNull();
    expect(preflightGraphIssue(nodes, edges)?.code).toBe('cycle');
  });

  it('refuses partial scope even when that scope happens to name every node', () => {
    const { nodes, edges, policy } = graph();
    expect(preflightReviewGraphIssue(nodes, edges, policy, nodes.map(node => node.id))?.message).toContain('完整画布');
  });

  it.each([0, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsafe round budget %s', maxRounds => {
    const { nodes, edges, policy } = graph();
    expect(preflightReviewGraphIssue(nodes, edges, { ...policy, maxRounds })?.message).toContain('1 到 5');
  });

  it('does not count a future feedback edge as a required first-round seed', () => {
    const { nodes, edges, policy, author } = graph();
    author.contract!.inputs[1].required = true;
    expect(preflightReviewGraphIssue(nodes, edges, policy)?.message).toContain('feedback');
    author.contract!.inputs[1].value = 'Review keyboard navigation first';
    expect(preflightReviewGraphIssue(nodes, edges, policy)).toBeNull();
  });

  it('requires an actual boolean gate and a feedback edge', () => {
    const { nodes, edges, policy, reviewer } = graph();
    expect(preflightReviewGraphIssue(nodes, edges.filter(edge => edge.kind !== 'feedback'), policy)?.message).toContain('至少');
    reviewer.contract!.outputs[0].type = 'text';
    expect(preflightReviewGraphIssue(nodes, edges, policy)?.message).toContain('boolean');
  });

  it('rejects data cycles, unrelated feedback sources and a gate with forward dependents', () => {
    const { nodes, edges, policy, reviewer } = graph();
    const nonFeedback = edges.map(edge => ({ ...edge, kind: 'data' as const }));
    expect(preflightReviewGraphIssue(nodes, [...nonFeedback, { ...edges[1], id: 'extra-feedback' }], policy)).not.toBeNull();
    const unrelated = { ...reviewer, id: 'unrelated' };
    expect(preflightReviewGraphIssue([...nodes, unrelated], [...edges, { ...edges[1], id: 'unrelated-feedback', fromNode: unrelated.id, toPort: 'in:task' }], policy)?.message).toContain('祖先');
    expect(preflightReviewGraphIssue([...nodes, unrelated], [...edges, { ...edges[0], id: 'premature-delivery', fromNode: reviewer.id, fromPort: 'out:notes', toNode: unrelated.id }], policy)?.message).toContain('最后');
  });

  it('still applies the DAG cycle gate to ordinary edges inside review mode', () => {
    const { nodes, edges, policy, author } = graph();
    author.contract!.inputs.push(field('peer-reply', 'markdown', '', false));
    const peer: SessionNode = { ...author, id: 'peer', contract: {
      version: 1, inputs: [field('candidate')], outputs: [field('artifact')],
    } };
    const cyclicEdges: CanvasEdge[] = [...edges,
      { ...edges[0], id: 'to-peer', toNode: peer.id },
      { ...edges[0], id: 'from-peer', fromNode: peer.id, toNode: author.id, toPort: 'in:peer-reply' },
    ];
    expect(preflightReviewGraphIssue([...nodes, peer], cyclicEdges, policy)?.code).toBe('cycle');
  });

  it('rejects duplicate, stale and conflicting feedback sources', () => {
    const { nodes, edges, policy } = graph();
    expect(preflightReviewGraphIssue(nodes, [...edges, { ...edges[1], id: 'duplicate' }], policy)).not.toBeNull();
    expect(preflightReviewGraphIssue(nodes, [edges[0], { ...edges[1], fromPort: 'out:missing' }], policy)).not.toBeNull();
    expect(preflightReviewGraphIssue(nodes, [...edges, { ...edges[0], id: 'conflict', toNode: 'author', toPort: 'in:feedback' }], policy)).not.toBeNull();
  });

  it.each(['detached', 'dangling-branch'] as const)('refuses an unreviewed %s before preparing or dispatching any turn', async topology => {
    const data = graph();
    const first: SessionNode = { ...data.author, id: 'unreviewed-first', title: 'Unreviewed first', contract: {
      version: 1, inputs: [field('task', 'text', 'Side project')], outputs: [field('artifact')],
    } };
    const second: SessionNode = { ...data.author, id: 'unreviewed-second', title: 'Unreviewed second', contract: {
      version: 1, inputs: [field('candidate')], outputs: [field('artifact')],
    } };
    const nodes = topology === 'detached' ? [...data.nodes, first] : [...data.nodes, first, second];
    const edges = topology === 'detached' ? data.edges : [...data.edges, {
      ...data.edges[0], id: 'side-branch', fromNode: first.id, toNode: second.id,
    }];
    const issue = preflightReviewGraphIssue(nodes, edges, data.policy);
    expect(issue?.values.reviewReason).toBe('unreviewed_nodes');
    expect(issue?.values.titles).toEqual(topology === 'detached' ? [first.title] : [first.title, second.title]);
    expect(issue?.message).toContain(first.title);
    for (const locale of ['en', 'zh'] as const) {
      const message = preflightIssueMessage((key, values) => canvasText(locale, key, values), issue, locale)!;
      expect(message).toContain(first.title);
      if (topology === 'dangling-branch') expect(message).toContain(second.title);
      expect(message).not.toContain('{titles}');
      if (locale === 'en') expect(message).not.toMatch(/[\u3400-\u9fff]/);
    }
    const beforeTurn = vi.fn(); const execAgent = vi.fn(); const onRound = vi.fn();
    const summary = await runReviewGraph({ ...data, nodes, edges, beforeTurn, execAgent, onRound, onStatus: vi.fn() });
    expect(summary).toMatchObject({ ok: false, blocked: nodes.length, review: { rounds: 0, outcome: 'failed' } });
    expect(beforeTurn).not.toHaveBeenCalled(); expect(execAgent).not.toHaveBeenCalled(); expect(onRound).not.toHaveBeenCalled();
  });

  it('accepts multiple producer branches only when every result reaches the final reviewer', async () => {
    const data = graph();
    const peer: SessionNode = { ...data.author, id: 'peer', title: 'Peer', contract: {
      version: 1, inputs: [field('task', 'text', 'Produce accessibility findings')], outputs: [field('artifact')],
    } };
    data.reviewer.contract!.inputs.push(field('peer-candidate'));
    const edges = [...data.edges, { ...data.edges[0], id: 'peer-to-reviewer', fromNode: peer.id, toPort: 'in:peer-candidate' }];
    const nodes = [...data.nodes, peer];
    expect(preflightReviewGraphIssue(nodes, edges, data.policy)).toBeNull();
    const execAgent = vi.fn(async (node: SessionNode, message: string) => {
      if (node.id === 'reviewer') {
        expect(message).toContain('# Main page'); expect(message).toContain('# Accessibility findings');
      }
      return ok(node.id === 'reviewer' ? review(true) : node.id === 'peer' ? '# Accessibility findings' : '# Main page');
    });
    const summary = await runReviewGraph({ ...data, nodes, edges, execAgent, onStatus: vi.fn() });
    expect(summary).toMatchObject({ ok: true, done: 3, review: { outcome: 'approved', rounds: 1 } });
    expect(execAgent).toHaveBeenCalledTimes(3);
    expect(execAgent.mock.calls.at(-1)?.[0].id).toBe('reviewer');
  });
});

describe('bounded review execution', () => {
  it('stops after first-round approval and exposes only real node statuses', async () => {
    const data = graph();
    const execAgent = vi.fn(async (node: SessionNode) => ok(node.id === 'author' ? '# Landing page' : review(true)));
    const onStatus = vi.fn(); const onRound = vi.fn();
    const summary = await runReviewGraph({ ...data, execAgent, onStatus, onRound });
    expect(summary).toMatchObject({ ok: true, done: 2, failed: 0, cached: 0, total: 2, review: { rounds: 1, outcome: 'approved' } });
    expect(execAgent.mock.calls.map(([node]) => node.id)).toEqual(['author', 'reviewer']);
    expect(onRound.mock.calls).toEqual([[1]]);
    expect(new Set(onStatus.mock.calls.map(([id]) => id))).toEqual(new Set(['author', 'reviewer']));
  });

  it('feeds back the declared field from the preceding round and hydrates the same Session before each turn', async () => {
    const data = graph();
    const invocations: Array<{ id: string; issueId: string | null; message: string }> = [];
    let reviews = 0;
    const beforeTurn = vi.fn(async (node: SessionNode, _round: number) => ({ ...node, issueId: `issue-${node.id}` }));
    const execAgent = vi.fn(async (node: SessionNode, message: string) => {
      invocations.push({ id: node.id, issueId: node.issueId, message });
      return ok(node.id === 'author' ? '# Revised page' : review(++reviews === 2, 'Fix the mobile menu'));
    });
    const onStatus = vi.fn();
    const summary = await runReviewGraph({ ...data, execAgent, onStatus, beforeTurn });
    expect(summary).toMatchObject({ ok: true, done: 2, cached: 0, review: { rounds: 2, outcome: 'approved' } });
    expect(invocations.map(turn => turn.id)).toEqual(['author', 'reviewer', 'author', 'reviewer']);
    expect(beforeTurn.mock.calls.map(([, round]) => round)).toEqual([1, 1, 2, 2]);
    expect(invocations[2]).toMatchObject({ issueId: 'issue-author' });
    expect(invocations[2].message).toContain('来自「Reviewer · 第 1 轮反馈」');
    expect(invocations[2].message).toContain('Fix the mobile menu');
    expect(invocations[2].message).not.toContain('"approved":false');
    expect(invocations[0].message).not.toContain('Fix the mobile menu');
    expect(invocations[1].message).toContain('输出字段 "approved" 必须是 JSON 布尔值');
    expect(invocations[1].message).toContain('达到轮次上限不代表通过');
    expect(onStatus.mock.calls.every(([id]) => id === 'author' || id === 'reviewer')).toBe(true);
  });

  it('keeps a declined last verdict as failure when the round budget is exhausted', async () => {
    const data = graph(); data.policy.maxRounds = 2;
    const execAgent = vi.fn(async (node: SessionNode) => ok(node.id === 'author' ? '# Work' : review(false)));
    const onStatus = vi.fn();
    const summary = await runReviewGraph({ ...data, execAgent, onStatus });
    expect(execAgent).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ ok: false, done: 1, failed: 1, review: { rounds: 2, outcome: 'exhausted' } });
    expect(onStatus).toHaveBeenLastCalledWith('reviewer', expect.objectContaining({ state: 'failed', detail: 'review_exhausted' }));
  });

  it.each(['"true"', '1', 'null'])('rejects a non-boolean verdict %s without dispatching another round', async approved => {
    const data = graph();
    const execAgent = vi.fn(async (node: SessionNode) => ok(node.id === 'author' ? '# Work' : `{"approved":${approved},"notes":"retry"}`));
    const result = await runReviewGraph({ ...data, execAgent, onStatus: vi.fn() });
    expect(result).toMatchObject({ ok: false, review: { outcome: 'failed', rounds: 1 } });
    expect(execAgent).toHaveBeenCalledTimes(2);
  });

  it('rejects an omitted optional verdict rather than treating missing as approval or retry', async () => {
    const data = graph(); data.reviewer.contract!.outputs[0].required = false;
    const execAgent = vi.fn(async (node: SessionNode) => ok(node.id === 'author' ? '# Work' : '{"notes":"No verdict"}'));
    const result = await runReviewGraph({ ...data, execAgent, onStatus: vi.fn() });
    expect(result.review.outcome).toBe('failed'); expect(execAgent).toHaveBeenCalledTimes(2);
  });

  it('stops after confirmed cancellation and keeps uncertain runs locked', async () => {
    const data = graph();
    for (const result of [
      { ok: false, cancelled: true, output: 'partial', detail: 'cancelled' },
      { ok: false, unconfirmed: true, output: 'partial', detail: 'recovery_unconfirmed' },
    ]) {
      const execAgent = vi.fn(async () => result); const onStatus = vi.fn();
      const summary = await runReviewGraph({ ...data, execAgent, onStatus });
      expect(summary.review.outcome).toBe('cancelled' in result ? 'cancelled' : 'failed');
      expect(execAgent).toHaveBeenCalledTimes(1);
      if ('unconfirmed' in result) expect(onStatus).toHaveBeenCalledWith('author', expect.objectContaining({ state: 'running', unconfirmed: true }));
    }
  });

  it('never dispatches after Stop while preparing a turn', async () => {
    const data = graph(); const controller = new AbortController(); const execAgent = vi.fn();
    const beforeTurn = vi.fn(async (node: SessionNode) => { controller.abort(); return node; });
    const summary = await runReviewGraph({ ...data, execAgent, beforeTurn, signal: controller.signal, onStatus: vi.fn() });
    expect(summary.review.outcome).toBe('cancelled'); expect(execAgent).not.toHaveBeenCalled();
  });

  it('does not dispatch invalid graphs or after a durable round/turn preparation failure', async () => {
    const data = graph(); const execAgent = vi.fn();
    const badScope = await runReviewGraph({ ...data, scope: ['author'], execAgent, onStatus: vi.fn() });
    expect(badScope.review.rounds).toBe(0);
    const roundFailure = await runReviewGraph({ ...data, execAgent, onStatus: vi.fn(), onRound: () => { throw new Error('Storage full'); } });
    expect(roundFailure).toMatchObject({ blocked: 2, review: { outcome: 'failed', rounds: 0 } });
    const turnFailure = await runReviewGraph({ ...data, execAgent, onStatus: vi.fn(), beforeTurn: async () => { throw new Error('Identity unavailable'); } });
    expect(turnFailure).toMatchObject({ failed: 1, blocked: 1, review: { outcome: 'failed' } });
    expect(execAgent).not.toHaveBeenCalled();
  });

  it('blocks an independent branch awaiting preparation when another preparation fails', async () => {
    const data = graph(); const execAgent = vi.fn();
    const sibling = { ...data.author, id: 'sibling' };
    data.reviewer.contract!.inputs.push(field('sibling-candidate'));
    const edges = [...data.edges, { ...data.edges[0], id: 'sibling-review', fromNode: sibling.id, toPort: 'in:sibling-candidate' }];
    const beforeTurn = vi.fn(async (node: SessionNode) => {
      if (node.id === 'author') throw new Error('Journal unavailable');
      await Promise.resolve(); return node;
    });
    const summary = await runReviewGraph({ ...data, nodes: [...data.nodes, sibling], edges, execAgent, onStatus: vi.fn(),
      beforeTurn,
    });
    expect(beforeTurn).toHaveBeenCalled();
    expect(summary.review.outcome).toBe('failed'); expect(execAgent).not.toHaveBeenCalled();
  });

  it('preserves ordinary single-pass workflow execution', async () => {
    const data = graph(); const execAgent = vi.fn(async (node: SessionNode) => ok(node.id === 'author' ? '# Work' : review(false)));
    const summary = await runGraph({ ...data, edges: data.edges.filter(edge => edge.kind !== 'feedback'), execAgent, onStatus: vi.fn() });
    expect(summary.ok).toBe(true); expect(execAgent).toHaveBeenCalledTimes(2);
  });
});
