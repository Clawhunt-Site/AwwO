import { describe, expect, it } from 'vitest';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { appendDeliveryProfile } from '../src/canvas/deliveryProfiles';
import { carryWiresIntoContract, droppedWiresNote } from '../src/canvas/deliverableWires';
import { canvasText } from '../src/canvas/i18n';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { emptyContract, type NodeContract } from '../src/canvas/nodeContracts';
import { edgeId, reconcileEdges } from '../src/canvas/ports';

// A session taking its first deliverable form keeps its wires on the form's ports (多人同屏, 2026-11-07: a person added the
// Game deliverable to a session the agents had wired, and every one of its wires went, unsaid). Every id here is made up.

const session = (id: string, title: string, x: number, y: number, extra: Partial<SessionNode> = {}): SessionNode =>
  ({ ...createSessionNode('llm', { x, y }), id, title, ...extra });
const wire = (fromNode: string, fromPort: string, toNode: string, toPort: string, dataType: CanvasEdge['dataType'] = 'text'): CanvasEdge =>
  ({ id: edgeId({ nodeId: fromNode, portId: fromPort }, { nodeId: toNode, portId: toPort }), fromNode, fromPort, toNode, toPort, dataType });

/** The agents' canvas: a brief and the levels feed the build, the build feeds the review. */
function wired(): CanvasDocument {
  const brief = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: 'Brief' };
  return { ...emptyDocument(), nodes: [brief, session('levels', 'Levels', 0, 400), session('build', 'Build the game', 500, 200), session('review', 'Review', 1000, 200)],
    edges: [wire('levels', 'result', 'build', 'context'), wire('brief', 'data', 'build', 'context'), wire('build', 'result', 'review', 'context')] };
}
const withContract = (doc: CanvasDocument, id: string, contract: NodeContract) => doc.nodes.find(node => node.id === id)!.kind === 'session'
  ? { ...(doc.nodes.find(node => node.id === id) as SessionNode), contract } : doc.nodes.find(node => node.id === id)!;
const game = () => appendDeliveryProfile(emptyContract(), 'game', 'en');
const carry = (doc: CanvasDocument, id: string, contract: NodeContract) =>
  carryWiresIntoContract(doc.nodes, doc.edges, doc.nodes.find(node => node.id === id)!, withContract(doc, id, contract), 'Context');
const contractOf = (node: CanvasNode) => (node as SessionNode).contract!;

describe('a session taking its first deliverable form', () => {
  it('gives each wire into its context an input of its own, named after its source, in the order a run reads them', () => {
    const doc = wired();
    const carried = carry(doc, 'build', game());
    expect(contractOf(carried.node).inputs).toEqual([
      { id: 'context', label: 'Brief', type: 'text', required: false, value: '' },
      { id: 'context_2', label: 'Levels', type: 'text', required: false, value: '' },
    ]);
    expect(contractOf(carried.node).outputs.map(field => field.id)).toEqual(['delivery_game']);
    expect(carried.edges.map(edge => edge.id)).toEqual([
      'levels:result->build:in:context_2', 'brief:data->build:in:context', 'build:out:delivery_game->review:context']);
    expect(carried.dropped).toEqual([]);
    // Every carried wire is one the canvas keeps, as the board and a run read it.
    const nodes = doc.nodes.map(node => node.id === 'build' ? carried.node : node);
    expect(reconcileEdges(nodes, carried.edges)).toEqual(carried.edges);
  });

  it('takes what was made below it to be as it was when it had no result: the moved wires take nothing back', () => {
    const before = wired();
    before.nodes = before.nodes.map(node => node.id === 'review' ? { ...node, lastOutput: { text: 'Checklist by the agent', source: 'manual' as const, at: 5 } } : node);
    const carried = carry(before, 'build', game());
    const after = { ...before, nodes: before.nodes.map(node => node.id === 'build' ? carried.node : node), edges: carried.edges };
    const resolved = invalidateOutputs(before, after);
    expect(resolved.nodes.find(node => node.id === 'review')!.lastOutput?.text).toBe('Checklist by the agent');
  });

  it('still takes back what was made from its own result, which its new form makes stale', () => {
    const before = wired();
    before.nodes = before.nodes.map(node => node.id === 'build' ? { ...node, lastOutput: { text: 'A plain answer', source: 'run' as const, at: 4 } }
      : node.id === 'review' ? { ...node, lastOutput: { text: 'Review of it', source: 'run' as const, at: 5 } } : node);
    const carried = carry(before, 'build', game());
    const after = { ...before, nodes: before.nodes.map(node => node.id === 'build' ? carried.node : node), edges: carried.edges };
    const resolved = invalidateOutputs(before, after);
    expect(resolved.nodes.filter(node => node.id === 'build' || node.id === 'review').map(node => node.lastOutput)).toEqual([null, null]);
  });

  it('feeds each reader from the first output its input can take', () => {
    const doc = wired();
    const carried = carry(doc, 'build', appendDeliveryProfile(emptyContract(), 'model3d', 'en'));
    // The 3D model is a file, which the review's text input cannot take; its HTML preview is the first output it can.
    expect(carried.edges.map(edge => [edge.id, edge.dataType])).toContainEqual(['build:out:delivery_model3d_preview->review:context', 'text']);
    expect(carried.dropped).toEqual([]);
  });

  it('returns a wire to a reader no output of the form can feed, and names it', () => {
    const doc = wired();
    // A source project is a file, which a text input cannot take.
    const carried = carry(doc, 'build', appendDeliveryProfile(emptyContract(), 'project', 'en'));
    expect(carried.dropped.map(edge => edge.id)).toEqual(['build:result->review:context']);
    expect(carried.edges.map(edge => edge.id)).toEqual(['levels:result->build:in:context_2', 'brief:data->build:in:context']);
    expect(droppedWiresNote((key, values) => canvasText('zh', key, values), doc.nodes, doc.nodes, carried.dropped))
      .toBe('交付要求接不上这个组件的一条连线，已移除：Build the game → Review。撤销可以恢复。');
  });

  it('carries no wire of a media node, whose generation reads only its own inputs, and names every one', () => {
    const doc = wired();
    doc.nodes.push({ ...session('poster', 'Poster', 0, 800), agentKind: 'image' });
    doc.nodes = doc.nodes.map(node => node.id === 'build' ? { ...node, agentKind: 'image' as const } : node);
    doc.edges.push(wire('poster', 'result', 'build', 'reference', 'image'));
    const carried = carry(doc, 'build', appendDeliveryProfile(emptyContract(), 'report', 'en'));
    expect(contractOf(carried.node).inputs).toEqual([]);
    expect(carried.edges).toEqual([]);
    expect(carried.dropped.map(edge => edge.id).sort()).toEqual(['brief:data->build:context', 'build:result->review:context',
      'levels:result->build:context', 'poster:result->build:reference']);
    expect(droppedWiresNote((key, values) => canvasText('en', key, values), doc.nodes, doc.nodes, carried.dropped.slice(0, 2)))
      .toBe('The deliverable form cannot carry 2 of this component’s wires, so they were removed: Levels → Build the game, Brief → Build the game. Undo brings them back.');
  });

  it('orders the inputs as a run reads its context: top to bottom, then left to right, whatever the wires’ order or names', () => {
    const doc = wired();
    // Levels now sits above the brief, and a third source sits beside the brief, further left.
    doc.nodes = doc.nodes.map(node => node.id === 'levels' ? { ...node, y: -200 } : node);
    doc.nodes.push(session('art', 'Art notes', -300, 0));
    doc.edges.unshift(wire('art', 'result', 'build', 'context'));
    expect(contractOf(carry(doc, 'build', game()).node).inputs.map(field => [field.id, field.label]))
      .toEqual([['context', 'Levels'], ['context_2', 'Art notes'], ['context_3', 'Brief']]);
  });

  it('names no wire the canvas did not show: one whose end was gone already is left for the canvas to drop', () => {
    const doc = wired();
    // A text session has no picture input, so this wire was never drawn.
    doc.edges.push(wire('levels', 'result', 'build', 'reference', 'image'));
    const carried = carry(doc, 'build', game());
    expect(carried.dropped).toEqual([]);
    expect(carried.edges).toContain(doc.edges[3]);
    const nodes = doc.nodes.map(node => node.id === 'build' ? carried.node : node);
    expect(reconcileEdges(nodes, carried.edges).map(edge => edge.id)).toEqual([
      'levels:result->build:in:context_2', 'brief:data->build:in:context', 'build:out:delivery_game->review:context']);
  });

  it('keeps the inputs a form brings, and names its own after them where they would clash', () => {
    const doc = wired();
    const contract = { ...game(), inputs: [{ id: 'context', label: 'Notes', type: 'markdown' as const, required: true, value: 'Keep it short' }] };
    const carried = carry(doc, 'build', contract);
    expect(contractOf(carried.node).inputs.map(field => [field.id, field.label])).toEqual([['context', 'Notes'], ['context_2', 'Brief'], ['context_3', 'Levels']]);
  });

  it('names an input after the word for context when its source has no title', () => {
    const doc = wired();
    doc.nodes = doc.nodes.map(node => node.id === 'brief' ? { ...node, title: '  ' } : node);
    expect(contractOf(carry(doc, 'build', game()).node).inputs[0].label).toBe('Context');
  });

  it('leaves a node that had a form already, or has none now, and every other wire, as they are', () => {
    const doc = wired();
    doc.nodes = doc.nodes.map(node => node.id === 'build' ? { ...node, contract: game() } : node);
    const before = doc.nodes.find(node => node.id === 'build')!;
    const more = appendDeliveryProfile(game(), 'report', 'en');
    const carried = carry(doc, 'build', more);
    expect(carried.node).toEqual({ ...before, contract: more });
    expect(carried.edges).toEqual(doc.edges);
    const plain = carryWiresIntoContract(doc.nodes, doc.edges, before, { ...before, contract: undefined } as CanvasNode, 'Context');
    expect(plain.edges).toEqual(doc.edges);
    expect(plain.dropped).toEqual([]);
  });
});
