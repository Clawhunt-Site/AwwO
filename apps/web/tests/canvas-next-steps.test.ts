import { describe, expect, it } from 'vitest';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import type { NodeTeam } from '../src/canvas/nodeTeam';
import { isNextStepsQuestion, nextSteps, type NextStepsInput } from '../src/canvas/nextSteps';

const field = (id: string, patch: Partial<ContractField> = {}): ContractField => ({ id, label: id, type: 'markdown', required: true, value: '', ...patch });
function agent(id: string, patch: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id,
    contract: { version: 1, inputs: [field('brief', { label: '任务要求', value: 'Do it' })], outputs: [field('result', { label: '交付结果' })] }, ...patch };
}
const needs = (id: string, labels: string[], patch: Partial<SessionNode> = {}) =>
  agent(id, { contract: { version: 1, inputs: labels.map((label, index) => field(`f${index}`, { label })), outputs: [] }, ...patch });
const done = (node: SessionNode): SessionNode => ({ ...node, lastOutput: { text: 'ok', at: 1, source: 'run' } });
const edge = (from: string, to: string): CanvasEdge => ({ id: `${from}->${to}`, fromNode: from, fromPort: 'out:result', toNode: to, toPort: 'in:brief', dataType: 'text' });
const team = (members: number): NodeTeam => ({ version: 1, mode: 'sequential', runtime: 'pi', maxRounds: 1, maxTurns: 4, timeoutSeconds: 600,
  members: Array.from({ length: members }, (_, index) => ({ id: `m${index}`, name: `m${index}`, role: 'r', instructions: 'i', runtime: '', model: '', context: 'task', tools: [] })) });
const PREMIUM = '免费版每天的次数只能用于默认模型';
const QUOTA = '工作区运行额度已满';
function input(patch: Partial<NextStepsInput>): NextStepsInput {
  return { nodes: [], edges: [], runs: {}, running: false, canRun: true, resultsAvailable: true, upgradeAvailable: true,
    isPremiumRefusal: detail => detail.includes(PREMIUM), isQuotaRefusal: detail => detail.includes(QUOTA), ...patch };
}

describe('the assistant\'s next steps', () => {
  it('offers to run a planned canvas that never ran, saying the fewest calls it takes', () => {
    const plan = input({ nodes: [agent('a'), agent('b', { contract: { version: 1, inputs: [field('brief')], outputs: [] } })], edges: [edge('a', 'b')] });
    // b's required brief is wired from a, so it is not the reader's to fill in.
    expect(nextSteps(plan)).toEqual({ situation: { kind: 'fresh', calls: 2 }, steps: [{ kind: 'run-all', calls: 2 }] });
  });

  it('lists every required input nothing feeds, node by node, before offering a run the preflight would refuse', () => {
    const nodes = [agent('a'), needs('b', ['业务需求']), agent('c'), needs('d', ['目标读者', '风格'], { team: team(3) })];
    expect(nextSteps(input({ nodes }))).toEqual({
      situation: { kind: 'inputs', nodes: 2, fields: 3, calls: 6 },
      steps: [{ kind: 'fill-inputs', nodeId: 'b', fields: ['业务需求'] }, { kind: 'fill-inputs', nodeId: 'd', fields: ['目标读者', '风格'] }] });
    // An optional field left empty is not something a run needs.
    expect(nextSteps(input({ nodes: [agent('a', { contract: { version: 1, inputs: [field('notes', { required: false })], outputs: [] } })] }))!.situation.kind).toBe('fresh');
  });

  it('offers a larger canvas a try of its first node alone, which costs one node', () => {
    const nodes = [agent('a', { team: team(2) }), agent('b'), agent('c')];
    expect(nextSteps(input({ nodes, edges: [edge('a', 'b'), edge('b', 'c')] }))).toEqual({ situation: { kind: 'fresh', calls: 4 },
      steps: [{ kind: 'run-all', calls: 4 }, { kind: 'try-first', nodeId: 'a', calls: 2 }] });
  });

  it('leads a full daily allowance with the plans, before any premium refusal', () => {
    const nodes = [agent('plan', { title: '游戏化学习系统规划' }), agent('next')];
    const runs = { plan: { state: 'failed' as const, detail: `${PREMIUM}…` }, next: { state: 'failed' as const, detail: `${QUOTA}：今天的调用次数用完了…` } };
    expect(nextSteps(input({ nodes, runs }))).toEqual({ situation: { kind: 'quota', nodeTitle: 'next' },
      steps: [{ kind: 'upgrade' }, { kind: 'rerun-failed', nodeIds: ['plan', 'next'] }] });
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

  it('takes a delivery published by hand after a failed run as that node’s result, not as a failure to rerun', () => {
    const runs = { a: { state: 'failed' as const, detail: 'Output must be a JSON object keyed by output field IDs' } };
    const fixed = agent('a', { lastOutput: { text: '{"result":"repaired"}', at: 2, source: 'manual' } });
    expect(nextSteps(input({ nodes: [fixed], runs }))).toEqual({ situation: { kind: 'complete' }, steps: [{ kind: 'results' }] });
    expect(nextSteps(input({ nodes: [agent('a')], runs }))!.situation.kind).toBe('failed');
  });

  it('continues a partly delivered canvas and offers what it has so far', () => {
    expect(nextSteps(input({ nodes: [done(agent('a')), agent('b'), agent('c', { lastOutput: { text: 'half', at: 1, source: 'run', partial: true } })] })))
      .toEqual({ situation: { kind: 'partial', count: 2 }, steps: [{ kind: 'run-rest', nodeIds: ['b', 'c'], calls: 2 }, { kind: 'results' }] });
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

describe('questions the assistant answers from the canvas, at no cost', () => {
  it.each(['现在缺什么？', '还缺啥', '下一步', '下一步该做什么', '接下来呢', '我该做什么', '那我现在该干嘛？', '有什么要决策的吗', '怎么开始？',
    '这个流程图要怎么用', '能运行了吗', '给点建议', 'What’s next?', 'what should I do now', 'Help!', 'Where do I start?'])('answers %s', question => {
    expect(isNextStepsQuestion(question)).toBe(true);
  });

  it.each(['帮我把下一步改成英文', '缺什么材料就去网上找', '接下来写一篇关于 AI 的文章', '下一步：生成封面图', '现在运行', '把选题改成科技新闻',
    'What’s next for AI in 2026? Write an article', 'help me write a product brief', ''])('sends %s on to the assistant', request => {
    expect(isNextStepsQuestion(request)).toBe(false);
  });
});
