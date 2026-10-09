import { describe, expect, it } from 'vitest';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import { nextSteps, type NextStepsInput } from '../src/canvas/nextSteps';

const field = (id: string, patch: Partial<ContractField> = {}): ContractField => ({ id, label: id, type: 'markdown', required: true, value: '', ...patch });
function agent(id: string, patch: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id,
    contract: { version: 1, inputs: [field('brief', { label: '任务要求', value: 'Do it' })], outputs: [field('result', { label: '交付结果' })] }, ...patch };
}
const done = (node: SessionNode): SessionNode => ({ ...node, lastOutput: { text: 'ok', at: 1, source: 'run' } });
const edge = (from: string, to: string): CanvasEdge => ({ id: `${from}->${to}`, fromNode: from, fromPort: 'out:result', toNode: to, toPort: 'in:brief', dataType: 'text' });
const PREMIUM = '免费版每天的次数只能用于默认模型';
function input(patch: Partial<NextStepsInput>): NextStepsInput {
  return { nodes: [], edges: [], runs: {}, running: false, canRun: true, resultsAvailable: true, upgradeAvailable: true,
    isPremiumRefusal: detail => detail.includes(PREMIUM), ...patch };
}

describe('the assistant\'s next steps', () => {
  it('offers to run a planned canvas that never ran', () => {
    const plan = input({ nodes: [agent('a'), agent('b', { contract: { version: 1, inputs: [field('brief')], outputs: [] } })], edges: [edge('a', 'b')] });
    // b's required brief is wired from a, so it is not the reader's to fill in.
    expect(nextSteps(plan)).toEqual({ situation: { kind: 'fresh' }, steps: [{ kind: 'run-all' }] });
  });

  it('asks for a required input nothing feeds, before offering a run the preflight would refuse', () => {
    const lonely = agent('b', { title: '数据治理', contract: { version: 1, inputs: [field('brief', { label: '业务需求' }), field('notes', { required: false })], outputs: [] } });
    expect(nextSteps(input({ nodes: [agent('a'), lonely] }))).toEqual({
      situation: { kind: 'inputs', nodeTitle: '数据治理', fields: ['业务需求'] }, steps: [{ kind: 'fill-inputs', nodeId: 'b' }] });
  });

  it('leads a free premium refusal with the paid plans, then the free model and a rerun', () => {
    const nodes = [agent('plan', { title: '游戏化学习系统规划' }), agent('next')];
    const runs = { plan: { state: 'failed' as const, detail: `${PREMIUM}…` }, next: { state: 'blocked' as const } };
    expect(nextSteps(input({ nodes, runs }))).toEqual({ situation: { kind: 'premium', nodeTitle: '游戏化学习系统规划' },
      steps: [{ kind: 'upgrade' }, { kind: 'switch-model', nodeId: 'plan' }, { kind: 'rerun-failed', nodeIds: ['plan'] }] });
    // Without a plans page (a local canvas) the free way is first.
    expect(nextSteps(input({ nodes, runs, upgradeAvailable: false }))!.steps[0]).toEqual({ kind: 'switch-model', nodeId: 'plan' });
  });

  it('sends any other failure to its reason first, counting every failed node', () => {
    const runs = { a: { state: 'failed' as const, detail: 'The model provider is rate limited.' }, b: { state: 'failed' as const, detail: 'x' } };
    expect(nextSteps(input({ nodes: [agent('a'), agent('b')], runs }))).toEqual({ situation: { kind: 'failed', nodeTitle: 'a', count: 2 },
      steps: [{ kind: 'open-failed', nodeId: 'a' }, { kind: 'rerun-failed', nodeIds: ['a', 'b'] }] });
  });

  it('continues a partly delivered canvas and offers what it has so far', () => {
    expect(nextSteps(input({ nodes: [done(agent('a')), agent('b'), agent('c', { lastOutput: { text: 'half', at: 1, source: 'run', partial: true } })] })))
      .toEqual({ situation: { kind: 'partial', count: 2 }, steps: [{ kind: 'run-rest', nodeIds: ['b', 'c'] }, { kind: 'results' }] });
  });

  it('points a finished canvas at its results', () => {
    expect(nextSteps(input({ nodes: [done(agent('a')), done(agent('b'))] }))).toEqual({ situation: { kind: 'complete' }, steps: [{ kind: 'results' }] });
  });

  it('stays quiet while running, on an empty or media-only canvas, and when no step could act', () => {
    expect(nextSteps(input({ nodes: [agent('a')], running: true }))).toBeNull();
    expect(nextSteps(input({ nodes: [] }))).toBeNull();
    expect(nextSteps(input({ nodes: [{ ...createSessionNode('image', { x: 0, y: 0 }), id: 'img' }] }))).toBeNull();
    expect(nextSteps(input({ nodes: [agent('a')], canRun: false }))).toBeNull();
    expect(nextSteps(input({ nodes: [done(agent('a'))], resultsAvailable: false }))).toBeNull();
    // A failure is still explained when the canvas cannot run now; only the rerun is withheld.
    expect(nextSteps(input({ nodes: [agent('a')], canRun: false, runs: { a: { state: 'failed', detail: 'x' } } }))!.steps).toEqual([{ kind: 'open-failed', nodeId: 'a' }]);
  });
});
