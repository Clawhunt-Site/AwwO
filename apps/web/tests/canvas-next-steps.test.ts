import { describe, expect, it } from 'vitest';
import { createAssembleNode, createEditNode, createSessionNode, type AssembleNode, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import type { NodeTeam } from '../src/canvas/nodeTeam';
import { isNextStepsQuestion, nextSteps, nodesLeft, runCost, type NextStepsInput } from '../src/canvas/nextSteps';

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
// A copied media case as productionCopy.ts makes one, PALLWARD's shape in small: the Agents that delivered text in the
// case run carry it (the spec, the code, and the step after the test); the concept picture, the 3D model made from it,
// the Agent that reads the model's files, the assembled page and the test of it have nothing yet.
const caseDelivery = { text: '{"result":"case delivery"}', at: 1, source: 'case' as const };
const reads = (id: string, fields: string[], patch: Partial<SessionNode> = {}) => agent(id, { contract: { version: 1,
  inputs: [field('brief', { label: '任务要求', value: 'Do it' }), ...fields.map(name => field(name))], outputs: [field('result', { label: '交付结果' })] }, ...patch });
function copiedCase(): CanvasNode[] {
  const page: AssembleNode = { ...createAssembleNode({ x: 0, y: 0 }), id: 'page', title: 'page', template: '{{in:code}}{{in:assets}}',
    contract: { version: 1, inputs: [field('code', { type: 'text' }), field('assets', { type: 'text' })], outputs: [field('result', { type: 'html' })] } };
  return [agent('spec', { lastOutput: caseDelivery }), reads('code', ['spec'], { lastOutput: caseDelivery }),
    { ...createSessionNode('image', { x: 0, y: 0 }), id: 'concept', title: 'concept' }, { ...createSessionNode('model3d', { x: 0, y: 0 }), id: 'model', title: 'model' },
    reads('assets', ['spec', 'models']), page, reads('test', ['page']), reads('publish', ['test'], { lastOutput: caseDelivery })];
}
const wire = (from: string, fromPort: string, to: string, toPort: string): CanvasEdge =>
  ({ id: `${from}->${to}.${toPort}`, fromNode: from, fromPort, toNode: to, toPort, dataType: 'text' });
const COPY_EDGES: CanvasEdge[] = [wire('spec', 'out:result', 'code', 'in:spec'), wire('spec', 'out:result', 'assets', 'in:spec'),
  wire('concept', 'result', 'model', 'reference'), wire('model', 'result', 'assets', 'in:models'),
  wire('code', 'out:result', 'page', 'in:code'), wire('assets', 'out:result', 'page', 'in:assets'),
  wire('page', 'out:result', 'test', 'in:page'), wire('test', 'out:result', 'publish', 'in:test')];
const PREMIUM = '免费版每天的次数只能用于默认模型';
const QUOTA = '工作区运行额度已满';
function input(patch: Partial<NextStepsInput>): NextStepsInput {
  return { nodes: [], edges: [], runs: {}, running: false, canRun: true, resultsAvailable: true, upgradeAvailable: true,
    isPremiumRefusal: detail => detail.includes(PREMIUM), isQuotaRefusal: detail => detail.includes(QUOTA), cloudRuns: true, ...patch };
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
    expect(nextSteps(input({ nodes, runs }))).toEqual({ situation: { kind: 'quota', nodeTitle: 'next', nodeId: 'next' },
      steps: [{ kind: 'upgrade' }, { kind: 'rerun-failed', nodeIds: ['plan', 'next'], calls: 2 }] });
  });

  it('leads a free premium refusal with the paid plans, then the free model and a rerun', () => {
    const nodes = [agent('plan', { title: '游戏化学习系统规划' }), agent('next')];
    const runs = { plan: { state: 'failed' as const, detail: `${PREMIUM}…` }, next: { state: 'blocked' as const } };
    expect(nextSteps(input({ nodes, runs }))).toEqual({ situation: { kind: 'premium', nodeTitle: '游戏化学习系统规划' },
      steps: [{ kind: 'upgrade' }, { kind: 'switch-model', nodeId: 'plan' }, { kind: 'rerun-failed', nodeIds: ['plan'], calls: 1 }] });
    // Without a plans page (a local canvas) the free way is first.
    expect(nextSteps(input({ nodes, runs, upgradeAvailable: false }))!.steps[0]).toEqual({ kind: 'switch-model', nodeId: 'plan' });
  });

  it('sends any other failure to its reason first, counting every failed node', () => {
    const runs = { a: { state: 'failed' as const, detail: 'The model provider is rate limited.' }, b: { state: 'failed' as const, detail: 'x' } };
    expect(nextSteps(input({ nodes: [agent('a'), agent('b')], runs }))).toEqual({ situation: { kind: 'failed', nodeTitle: 'a', count: 2 },
      steps: [{ kind: 'open-failed', nodeId: 'a' }, { kind: 'rerun-failed', nodeIds: ['a', 'b'], calls: 2 }] });
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

  it('counts a copied case’s media and assemble nodes as left to run, and runs them with what they feed', () => {
    // PALLWARD copied on 2026-10-20: the card said 3 nodes (its text Agents) had no result, of 48. A copy carries the
    // Agents' text deliveries; its pictures, 3D models and pages are made on its first run, as is what reads them.
    const nodes = copiedCase();
    expect(nextSteps(input({ nodes, edges: COPY_EDGES }))).toEqual({ situation: { kind: 'partial', count: 5, media: 2 },
      // From every node without a result, through the step they feed: three Agents' calls and two generations. The spec
      // and the code keep their deliveries and hand them on.
      steps: [{ kind: 'run-rest', nodeIds: ['concept', 'model', 'assets', 'page', 'test'], calls: 3, generations: 2 }, { kind: 'results' }] });
    // Once the run has made them all, the canvas is done.
    expect(nextSteps(input({ nodes: nodes.map(node => node.lastOutput ? node : { ...node, lastOutput: { text: 'made', at: 2, source: 'run' } }),
      edges: COPY_EDGES }))).toEqual({ situation: { kind: 'complete' }, steps: [{ kind: 'results' }] });
  });

  it('does not call a canvas done while an image has no result, nor a blank output a result', () => {
    const nodes = [done(agent('a')), { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: 'img' }];
    expect(nextSteps(input({ nodes }))).toEqual({ situation: { kind: 'partial', count: 1, media: 1 },
      steps: [{ kind: 'run-rest', nodeIds: ['img'], calls: 0, generations: 1 }, { kind: 'results' }] });
    const blank = agent('b', { lastOutput: { text: '  \n', at: 1, source: 'run' } });
    expect(nextSteps(input({ nodes: [done(agent('a')), blank] }))!.situation).toEqual({ kind: 'partial', count: 1 });
  });

  it('explains a failed image, 3D model or assembly like any failed node', () => {
    const runs = { model: { state: 'failed' as const, detail: 'The generation failed.' }, assets: { state: 'blocked' as const } };
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs }))).toEqual({ situation: { kind: 'failed', nodeTitle: 'model', count: 1 },
      // Running it again runs what it feeds too: the Agent that reads its files, the page and the steps after it.
      steps: [{ kind: 'open-failed', nodeId: 'model' }, { kind: 'rerun-failed', nodeIds: ['model'], calls: 3, generations: 1 }] });
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs: { page: { state: 'failed', detail: 'x' } } }))!.situation)
      .toEqual({ kind: 'failed', nodeTitle: 'page', count: 1 });
  });

  it('says what a canvas with media nodes costs to run: its calls and a generation per media node', () => {
    const fresh = copiedCase().map(node => ({ ...node, lastOutput: undefined }));
    expect(nextSteps(input({ nodes: fresh, edges: COPY_EDGES }))).toEqual({ situation: { kind: 'fresh', calls: 5, generations: 2 },
      steps: [{ kind: 'run-all', calls: 5, generations: 2 }, { kind: 'try-first', nodeId: 'spec', calls: 1 }] });
    const unfilled = fresh.map(node => node.id === 'spec' ? agent('spec', { contract: { version: 1, inputs: [field('brief', { label: 'Brief' })], outputs: [field('result')] } }) : node);
    expect(nextSteps(input({ nodes: unfilled, edges: COPY_EDGES }))!.situation).toEqual({ kind: 'inputs', nodes: 1, fields: 1, calls: 5, generations: 2 });
  });

  it('leaves out on a canvas on this device what only a cloud run makes, edits and file assemblies, and runs the rest on its Agents', () => {
    const pageFile = { ...createAssembleNode({ x: 0, y: 0 }), id: 'file', title: 'file', contract: { version: 1, inputs: [field('module', { type: 'text', required: false })],
      outputs: [field('page', { type: 'file' })] } } as AssembleNode;
    const film = { ...createEditNode({ x: 0, y: 0 }), id: 'film', title: 'film', timeline: '{"version":"awwo.timeline/1"}' };
    const nodes = [...copiedCase(), pageFile, film];
    // The local engine sends every session node to its Agent (the picture and the model too: nothing generates here) and
    // assembles the page; the file and the film it cannot make.
    expect(nextSteps(input({ nodes, edges: COPY_EDGES, cloudRuns: false }))).toEqual({ situation: { kind: 'partial', count: 5 },
      steps: [{ kind: 'run-rest', nodeIds: ['concept', 'model', 'assets', 'page', 'test'], calls: 5 }, { kind: 'results' }] });
    // A film that failed here (it always does: EDIT_CLOUD_ONLY) is not a failure to run again.
    expect(nextSteps(input({ nodes, edges: COPY_EDGES, cloudRuns: false, runs: { film: { state: 'failed', detail: 'x' } } }))!.situation.kind).toBe('partial');
    // In the cloud they all count, the film and the file ready to make with the rest.
    expect(nextSteps(input({ nodes, edges: COPY_EDGES }))!.situation).toEqual({ kind: 'partial', count: 7, media: 2 });
  });

  it('offers no run on this device that would reach what only a cloud run makes: it would fail there and clear what follows', () => {
    const assembly = (id: string, outputs: ContractField[]) => ({ ...createAssembleNode({ x: 0, y: 0 }), id, title: id,
      contract: { version: 1, inputs: [field('module', { type: 'text' })], outputs } }) as AssembleNode;
    const after = agent('d', { contract: { version: 1, inputs: [field('brief', { value: 'Do it' }), field('page', { type: 'file' })], outputs: [field('result')] },
      lastOutput: caseDelivery });
    const nodes = [done(agent('a')), assembly('b', [field('result', { type: 'html' })]), assembly('c', [field('page', { type: 'file' })]), after];
    const edges = [wire('a', 'out:result', 'b', 'in:module'), wire('b', 'out:result', 'c', 'in:module'), { ...wire('c', 'out:page', 'd', 'in:page'), dataType: 'file' as const }];
    // b has no result; a run from it would run c, a file only the cloud makes, and then d, which has its result.
    expect(nextSteps(input({ nodes, edges, cloudRuns: false }))).toEqual({ situation: { kind: 'partial', count: 1 }, steps: [{ kind: 'results' }] });
    expect(nextSteps(input({ nodes, edges, cloudRuns: false, runs: { b: { state: 'failed', detail: 'x' } } }))!.steps).toEqual([{ kind: 'open-failed', nodeId: 'b' }]);
    // In the cloud it runs.
    expect(nextSteps(input({ nodes, edges }))!.steps[0]).toMatchObject({ kind: 'run-rest', nodeIds: ['b', 'c'] });
  });

  it('offers no run on this device of a node fed by one it cannot make, and no whole run over a result it cannot make again', () => {
    const file = { ...createAssembleNode({ x: 0, y: 0 }), id: 'f', title: 'f', contract: { version: 1, inputs: [field('module', { type: 'text' })],
      outputs: [field('page', { type: 'file' })] } } as AssembleNode;
    const reader = agent('d', { contract: { version: 1, inputs: [field('brief', { value: 'Do it' }), field('page', { type: 'file' })], outputs: [field('result')] } });
    const edges = [wire('a', 'out:result', 'f', 'in:module'), { ...wire('f', 'out:page', 'd', 'in:page'), dataType: 'file' as const }];
    // A whole run made a and failed at f: d, blocked, would be blocked again on every run from it.
    expect(nextSteps(input({ nodes: [done(agent('a')), file, reader], edges, cloudRuns: false }))).toEqual({ situation: { kind: 'partial', count: 1 },
      steps: [{ kind: 'results' }] });
    // Once f has its file (a cloud run made it), d runs from it here.
    const made = { ...file, lastOutput: { text: '{"page":"awwo-file:page"}', at: 1, source: 'run' as const } };
    expect(nextSteps(input({ nodes: [done(agent('a')), made, reader], edges, cloudRuns: false }))!.steps[0]).toEqual({ kind: 'run-rest', nodeIds: ['d'], calls: 1 });
    // An Agent that has not run beside an edit a cloud run made: not a fresh canvas, and the run offered leaves the film.
    const film = { ...createEditNode({ x: 0, y: 0 }), id: 'film', title: 'film', timeline: '{}', lastOutput: { text: 'film', at: 1, source: 'run' as const } };
    expect(nextSteps(input({ nodes: [agent('a'), film], cloudRuns: false }))).toEqual({ situation: { kind: 'partial', count: 1 },
      steps: [{ kind: 'run-rest', nodeIds: ['a'], calls: 1 }, { kind: 'results' }] });
    // Every node without a result counts as left, whether or not this host can run it.
    expect(nodesLeft([done(agent('a')), file, reader])).toBe(2);
    expect(nodesLeft([done(agent('a')), made])).toBe(0);
  });

  it('takes an image node given fields as what its host runs: an Agent on this device, a generation in the cloud, its fields checked', () => {
    const image: SessionNode = { ...agent('image'), agentKind: 'image', contract: { version: 1, inputs: [field('brief', { label: 'Brief' })], outputs: [field('result')] } };
    expect(nextSteps(input({ nodes: [done(agent('a')), image], cloudRuns: false }))!.situation).toEqual({ kind: 'inputs', nodes: 1, fields: 1, calls: 2 });
    // The cloud admits it on its media Agent whatever fields it has (graph_media.go), and its preflight checks them.
    expect(nextSteps(input({ nodes: [done(agent('a')), image] }))!.situation).toEqual({ kind: 'inputs', nodes: 1, fields: 1, calls: 1, generations: 1 });
  });

  it('offers an Agent out of the plan’s credits the default model, which spends none, after the plans', () => {
    const runs = { assets: { state: 'failed' as const, detail: 'credits_exhausted' } };
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs, isQuotaRefusal: () => true, modelSwitchHelps: () => true }))!.steps).toEqual([
      { kind: 'upgrade' }, { kind: 'switch-model', nodeId: 'assets' }, { kind: 'rerun-failed', nodeIds: ['assets'], calls: 3 }]);
    // A media node has no free model to switch to.
    const media = { model: { state: 'failed' as const, detail: 'credits_exhausted' } };
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs: media, isQuotaRefusal: () => true, modelSwitchHelps: () => true }))!.steps)
      .toEqual([{ kind: 'upgrade' }, { kind: 'rerun-failed', nodeIds: ['model'], calls: 3, generations: 1 }]);
  });

  it('sends a generation the workspace may not make today to the plans, not to a run that is refused again', () => {
    const runs = { model: { state: 'failed' as const, detail: 'model3d_quota_exceeded' }, assets: { state: 'done' as const } };
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs, isQuotaRefusal: detail => detail === 'model3d_quota_exceeded' }))).toEqual({
      situation: { kind: 'quota', nodeTitle: 'model', nodeId: 'model' },
      steps: [{ kind: 'upgrade' }, { kind: 'rerun-failed', nodeIds: ['model'], calls: 3, generations: 1 }] });
    // A limit no plan lifts (the service's own edits a day) is not sent to the plans.
    expect(nextSteps(input({ nodes: copiedCase(), edges: COPY_EDGES, runs, isQuotaRefusal: () => true, upgradeHelps: () => false }))!.steps)
      .toEqual([{ kind: 'rerun-failed', nodeIds: ['model'], calls: 3, generations: 1 }]);
  });

  it('lists an assembly’s empty input and an edit without a timeline among what a run needs, as its preflight refuses them', () => {
    const page = { ...createAssembleNode({ x: 0, y: 0 }), id: 'page', title: 'page' };
    const film = { ...createEditNode({ x: 0, y: 0 }), id: 'film', title: 'film' };
    expect(nextSteps(input({ nodes: [done(agent('a')), page, film], timelineLabel: 'Timeline' }))).toEqual({
      situation: { kind: 'inputs', nodes: 2, fields: 2, calls: 1 },
      steps: [{ kind: 'fill-inputs', nodeId: 'page', fields: ['代码模块'] }, { kind: 'fill-inputs', nodeId: 'film', fields: ['Timeline'] }] });
    // Wired in, neither needs the reader.
    const wiredIn = [wire('a', 'out:result', 'page', 'in:module'), wire('a', 'out:result', 'film', 'timeline')];
    expect(nextSteps(input({ nodes: [done(agent('a')), page, film], edges: wiredIn }))!.situation).toEqual({ kind: 'partial', count: 2 });
  });

  it('quotes a run asked for in the conversation from what it starts', () => {
    const nodes = copiedCase();
    expect(runCost(nodes, undefined, true)).toEqual({ calls: 5, generations: 2 });
    expect(runCost(nodes, ['concept', 'model', 'page'], true)).toEqual({ calls: 0, generations: 2 });
    // Here nothing generates: every session node is a call to its Agent.
    expect(runCost(nodes, undefined)).toEqual({ calls: 7 });
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
