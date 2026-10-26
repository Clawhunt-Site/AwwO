import { describe, expect, it } from 'vitest';
import { createAssembleNode, createEditNode, createSessionNode, type AssembleNode, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import { sameWholeRunChoice, wholeRunChoice } from '../src/canvas/nextSteps';

// 2026-10-25: a paying user's 运行 ran every node of a canvas whose nodes had all finished but one, and paid for each.
// What a run of the whole canvas asks first, worked out from the canvas alone.
const field = (id: string, patch: Partial<ContractField> = {}): ContractField => ({ id, label: id, type: 'markdown', required: true, value: '', ...patch });
function agent(id: string, patch: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id,
    contract: { version: 1, inputs: [field('brief', { label: '任务要求', value: 'Do it' })], outputs: [field('result', { label: '交付结果' })] }, ...patch };
}
const done = <T extends CanvasNode>(node: T): T => ({ ...node, lastOutput: { text: 'ok', at: 1, source: 'run' as const } });
const edge = (from: string, to: string): CanvasEdge => ({ id: `${from}->${to}`, fromNode: from, fromPort: 'out:result', toNode: to, toPort: 'in:brief', dataType: 'text' });
const wire = (from: string, fromPort: string, to: string, toPort: string): CanvasEdge =>
  ({ id: `${from}->${to}.${toPort}`, fromNode: from, fromPort, toNode: to, toPort, dataType: 'text' });

describe('what a run of the whole canvas asks first', () => {
  it('asks nothing of a canvas none of whose nodes has a result yet', () => {
    expect(wholeRunChoice({ nodes: [agent('a'), agent('b')], edges: [edge('a', 'b')], cloudRuns: true })).toBeNull();
  });

  it('names the nodes with a result it would run again, and offers the nodes without one and what they feed', () => {
    // a has its result and feeds b, which has none and feeds c, which has; d stands alone with its result.
    const nodes = [done(agent('a')), agent('b'), done(agent('c')), done(agent('d'))];
    expect(wholeRunChoice({ nodes, edges: [edge('a', 'b'), edge('b', 'c')], cloudRuns: true })).toEqual({
      finished: ['a', 'c', 'd'], cleared: [], left: 1, whole: { scope: ['a', 'b', 'c', 'd'], calls: 4 },
      // b and c run: c because what it is given changes; a hands its result on and d is left as it is.
      rest: { nodeIds: ['b'], scope: ['b', 'c'], after: 1, calls: 2 } });
  });

  it('offers only the whole run again, and not running, when every node has its result', () => {
    const nodes = [done(agent('a')), done(agent('b'))];
    expect(wholeRunChoice({ nodes, edges: [edge('a', 'b')], cloudRuns: true })).toEqual({ finished: ['a', 'b'], cleared: [], left: 0, whole: { scope: ['a', 'b'], calls: 2 } });
  });

  it('counts a failed run’s capture as no result, and a hand-published delivery as one', () => {
    const failed = { ...agent('b'), lastOutput: { text: 'half', at: 1, source: 'run' as const, partial: true } };
    const published = { ...agent('c'), lastOutput: { text: 'by hand', at: 1, source: 'manual' as const } };
    expect(wholeRunChoice({ nodes: [done(agent('a')), failed, published], edges: [], cloudRuns: true })).toEqual({
      finished: ['a', 'c'], cleared: [], left: 1, whole: { scope: ['a', 'b', 'c'], calls: 3 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } });
  });

  it('counts a copied case’s deliveries as results, and says what generating its media again spends', () => {
    // PALLWARD's shape in small (canvas-next-steps.test.ts): the Agents the case delivered text for, and the picture, the
    // model and what follows them with nothing yet.
    const caseDelivery = { text: '{"result":"case delivery"}', at: 1, source: 'case' as const };
    const reads = (id: string, fields: string[], patch: Partial<SessionNode> = {}) => agent(id, { contract: { version: 1,
      inputs: [field('brief', { value: 'Do it' }), ...fields.map(name => field(name))], outputs: [field('result')] }, ...patch });
    const page: AssembleNode = { ...createAssembleNode({ x: 0, y: 0 }), id: 'page', title: 'page', template: '{{in:code}}{{in:assets}}',
      contract: { version: 1, inputs: [field('code', { type: 'text' }), field('assets', { type: 'text' })], outputs: [field('result', { type: 'html' })] } };
    const nodes: CanvasNode[] = [agent('spec', { lastOutput: caseDelivery }), reads('code', ['spec'], { lastOutput: caseDelivery }),
      { ...createSessionNode('image', { x: 0, y: 0 }), id: 'concept', title: 'concept' }, { ...createSessionNode('model3d', { x: 0, y: 0 }), id: 'model', title: 'model' },
      reads('assets', ['spec', 'models']), page, reads('test', ['page']), reads('publish', ['test'], { lastOutput: caseDelivery })];
    const edges = [wire('spec', 'out:result', 'code', 'in:spec'), wire('spec', 'out:result', 'assets', 'in:spec'),
      wire('concept', 'result', 'model', 'reference'), wire('model', 'result', 'assets', 'in:models'),
      wire('code', 'out:result', 'page', 'in:code'), wire('assets', 'out:result', 'page', 'in:assets'),
      wire('page', 'out:result', 'test', 'in:page'), wire('test', 'out:result', 'publish', 'in:test')];
    expect(wholeRunChoice({ nodes, edges, cloudRuns: true })).toEqual({
      finished: ['spec', 'code', 'publish'], cleared: [], left: 5,
      whole: { scope: ['spec', 'code', 'concept', 'model', 'assets', 'page', 'test', 'publish'], calls: 5, generations: 2 },
      // As 「运行剩下的节点」 quotes it (canvas-next-steps.test.ts), with the step after the test, which runs again.
      rest: { nodeIds: ['concept', 'model', 'assets', 'page', 'test'], scope: ['concept', 'model', 'assets', 'page', 'test', 'publish'],
        after: 1, calls: 3, generations: 2 } });
  });

  it('asks nothing when the run would be refused for an input nobody filled in: its notice says what', () => {
    const unfilled = agent('b', { contract: { version: 1, inputs: [field('brief', { label: '业务需求' })], outputs: [field('result')] } });
    expect(wholeRunChoice({ nodes: [done(agent('a')), unfilled], edges: [], cloudRuns: true })).toBeNull();
  });

  it('offers no run of what is left that this device cannot start, as 「运行剩下的节点」 is not offered there', () => {
    const assembly = (id: string, outputs: ContractField[]) => ({ ...createAssembleNode({ x: 0, y: 0 }), id, title: id,
      contract: { version: 1, inputs: [field('module', { type: 'text' })], outputs } }) as AssembleNode;
    const nodes = [done(agent('a')), assembly('b', [field('result', { type: 'html' })]), assembly('c', [field('page', { type: 'file' })])];
    const edges = [wire('a', 'out:result', 'b', 'in:module'), wire('b', 'out:result', 'c', 'in:module')];
    // b has no result; a run from it would reach c, a file only a cloud run makes.
    expect(wholeRunChoice({ nodes, edges, cloudRuns: false })).toEqual({ finished: ['a'], cleared: [], left: 2, whole: { scope: ['a', 'b', 'c'], calls: 1 } });
    expect(wholeRunChoice({ nodes, edges, cloudRuns: true })!.rest).toEqual({ nodeIds: ['b', 'c'], scope: ['b', 'c'], after: 0, calls: 0 });
  });

  it('offers no run of what is left where the host runs only whole canvases (a review loop)', () => {
    const nodes = [done(agent('a')), agent('b')];
    expect(wholeRunChoice({ nodes, edges: [edge('a', 'b')], cloudRuns: true, scopedRuns: false })).toEqual({ finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 } });
  });

  // Review: a run on this device that reaches a node team is refused there, the whole canvas's too.
  it('asks nothing on this device of a canvas with a node team, whose run is refused there', () => {
    const team = { version: 1 as const, mode: 'sequential' as const, runtime: 'pi', maxRounds: 1, maxTurns: 4, timeoutSeconds: 600,
      members: [{ id: 'm', name: 'm', role: 'r', instructions: 'i', runtime: '', model: '', context: 'task' as const, tools: [] }] };
    const nodes = [done(agent('a')), agent('b', { team })];
    expect(wholeRunChoice({ nodes, edges: [edge('a', 'b')], cloudRuns: false })).toBeNull();
    expect(wholeRunChoice({ nodes, edges: [edge('a', 'b')], cloudRuns: true })!.rest).toMatchObject({ nodeIds: ['b'], scope: ['b'] });
  });

  // Review: on this device a whole run clears what every node it runs had delivered (prepareRunDocument), an edit a
  // cloud run made too, which it cannot make again; it was asked about only when an Agent had its result.
  it('asks on this device before a whole run clears an edit a cloud run made, and offers the Agent left alone', () => {
    const film = { ...createEditNode({ x: 0, y: 0 }), id: 'film', title: 'film', timeline: '{}', lastOutput: { text: 'film', at: 1, source: 'run' as const } };
    expect(wholeRunChoice({ nodes: [agent('a'), film], edges: [], cloudRuns: false })).toEqual({
      finished: ['film'], cleared: ['film'], left: 1, whole: { scope: ['a', 'film'], calls: 1 }, rest: { nodeIds: ['a'], scope: ['a'], after: 0, calls: 1 } });
    // In the cloud the run makes it again.
    expect(wholeRunChoice({ nodes: [agent('a'), film], edges: [], cloudRuns: true })!.cleared).toEqual([]);
  });
});

describe('an answer to that question', () => {
  it('acts only on the canvas the question showed: a node added or a result arrived asks again', () => {
    const nodes = [done(agent('a')), agent('b')];
    const shown = wholeRunChoice({ nodes, edges: [edge('a', 'b')], cloudRuns: true });
    expect(sameWholeRunChoice(shown, wholeRunChoice({ nodes: [...nodes], edges: [edge('a', 'b')], cloudRuns: true }))).toBe(true);
    // A plan added a node while it was open: the whole run would spend more than it said.
    expect(sameWholeRunChoice(shown, wholeRunChoice({ nodes: [...nodes, agent('c')], edges: [edge('a', 'b')], cloudRuns: true }))).toBe(false);
    // b's result arrived from another tab: nothing is left to run, and running it all would replace that too.
    expect(sameWholeRunChoice(shown, wholeRunChoice({ nodes: [done(agent('a')), done(agent('b'))], edges: [edge('a', 'b')], cloudRuns: true }))).toBe(false);
    expect(sameWholeRunChoice(shown, null)).toBe(false);
  });

  // Review: b moved from feeding c to feeding d, both with a result: the same calls and one node after, yet another
  // result replaced.
  it('asks again when a wire moved, though what it spends is the same', () => {
    const caseDelivery = { text: '{"result":"case"}', at: 1, source: 'case' as const };
    const nodes = [agent('a', { lastOutput: caseDelivery }), agent('b'), agent('c', { lastOutput: caseDelivery }), agent('d', { lastOutput: caseDelivery })];
    const before = wholeRunChoice({ nodes, edges: [edge('b', 'c')], cloudRuns: true });
    const after = wholeRunChoice({ nodes, edges: [edge('b', 'd')], cloudRuns: true });
    expect([before!.rest!.calls, before!.rest!.after]).toEqual([after!.rest!.calls, after!.rest!.after]);
    expect(sameWholeRunChoice(before, after)).toBe(false);
    // The order the nodes are listed in is no change.
    expect(sameWholeRunChoice(before, wholeRunChoice({ nodes: [...nodes].reverse(), edges: [edge('b', 'c')], cloudRuns: true }))).toBe(true);
  });

  // Review: with nothing left to run alone, an unfinished node swapped for another at the same cost read as no change.
  it('asks again when a node the whole run would run was swapped for another', () => {
    // A review loop: no run of what is left is offered, so only the whole run is quoted.
    const shown = wholeRunChoice({ nodes: [done(agent('a')), agent('b')], edges: [], cloudRuns: true, scopedRuns: false });
    const swapped = wholeRunChoice({ nodes: [done(agent('a')), agent('x')], edges: [], cloudRuns: true, scopedRuns: false });
    expect(swapped!.whole.calls).toBe(shown!.whole.calls);
    expect(sameWholeRunChoice(shown, swapped)).toBe(false);
  });
});
