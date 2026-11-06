// Converged groups: the view preference that draws several components as one live icon, and the projection of the
// board while they are drawn so. Converging is a way of looking: it must never change nodes or edges, never invent a
// wire, and never keep a node hidden that is gone from the canvas.
import { describe, expect, it, vi } from 'vitest';
import { createFormNode, createSessionNode, type CanvasEdge, type CanvasNode } from '../src/canvas/canvasDoc';
import {
  CANVAS_GROUP_ID, CONVERGED_GROUPS_KEY, convergeNodes, convergeView, countSteps, drawnGroups, editReachesHidden, expandForNode, expandGroup,
  expandGroupOf, loadConvergedState, NOTHING_CONVERGED, pruneConvergedGroups, saveConvergedState, stageGroups, type ConvergedGroup,
} from '../src/canvas/convergedGroups';
import { portAnchorWorld, reconcileEdges } from '../src/canvas/ports';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const node = (id: string, x: number, y: number): CanvasNode => ({ ...createSessionNode('llm', { x, y }), id, title: id, w: 260, h: 128 });
const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}:result->${to}:context`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });

describe('converged groups as a stored view preference', () => {
  it('reads nothing malformed and keeps each node in its first group only', () => {
    const storage = memoryStorage({ [CONVERGED_GROUPS_KEY]: JSON.stringify({ v: 1, canvas: false, groups: [
      { id: 'g1', members: ['a', 'b', 7, ''] },
      { id: 'g2', members: ['b', 'c'] },
      { id: 'g1', members: ['d', 'e'] },
      { id: 'g3', members: ['d', 'e'] },
      { id: CANVAS_GROUP_ID, members: ['x', 'y'] },
      null, 'x', { members: ['f', 'g'] },
    ] }) });
    expect(loadConvergedState(storage)).toEqual({ canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }, { id: 'g3', members: ['d', 'e'] }] });
    for (const raw of ['{not json', '{"a":1}', '[]', '{"v":2,"canvas":true}', 'null']) {
      expect(loadConvergedState(memoryStorage({ [CONVERGED_GROUPS_KEY]: raw }))).toBe(NOTHING_CONVERGED);
    }
    expect(loadConvergedState(null)).toBe(NOTHING_CONVERGED);
    expect(loadConvergedState(memoryStorage({ [CONVERGED_GROUPS_KEY]: '{"v":1,"canvas":true}' }))).toEqual({ canvas: true, groups: [] });
  });

  it('saves only what is still on the canvas and removes the entry when nothing is converged', () => {
    const storage = memoryStorage();
    saveConvergedState({ canvas: false, groups: [{ id: 'g1', members: ['a', 'b', 'gone'] }] }, new Set(['a', 'b']), storage);
    expect(JSON.parse(storage.data.get(CONVERGED_GROUPS_KEY)!)).toEqual({ v: 1, canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }] });
    // A deleted member leaves its group, and a group of one dissolves: its last card is drawn again.
    saveConvergedState({ canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }] }, new Set(['a']), storage);
    expect(storage.data.has(CONVERGED_GROUPS_KEY)).toBe(false);
    saveConvergedState({ canvas: true, groups: [] }, new Set(['a']), storage);
    expect(JSON.parse(storage.data.get(CONVERGED_GROUPS_KEY)!)).toEqual({ v: 1, canvas: true, groups: [] });
  });

  it('draws the whole canvas as one icon of every node, now and later, while it is converged', () => {
    const groups: ConvergedGroup[] = [{ id: 'g1', members: ['a', 'b'] }];
    expect(drawnGroups({ canvas: true, groups }, ['a', 'b', 'c'])).toEqual([{ id: CANVAS_GROUP_ID, members: ['a', 'b', 'c'] }]);
    expect(drawnGroups({ canvas: true, groups }, ['a'])).toEqual([]);
    expect(drawnGroups({ canvas: false, groups }, ['a', 'b', 'c'])).toBe(groups);
  });

  it('counts forms out: a form and one Agent are no canvas of two components, though the icon holds the form', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f' };
    expect(countSteps([form, node('a', 0, 0)])).toBe(1);
    expect(countSteps([form, node('a', 0, 0), node('b', 0, 0)])).toBe(2);
    expect(drawnGroups({ canvas: true, groups: [] }, ['f', 'a'], 1)).toEqual([]);
    expect(drawnGroups({ canvas: true, groups: [] }, ['f', 'a', 'b'], 2)).toEqual([{ id: CANVAS_GROUP_ID, members: ['f', 'a', 'b'] }]);
  });

  it('draws an opened node in its place again: the whole canvas, or the group it is in', () => {
    const state = { canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['c', 'd'] }] };
    expect(expandForNode(state, 'c')).toEqual({ canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }] });
    expect(expandForNode(state, 'z')).toBe(state);
    expect(expandForNode({ ...state, canvas: true }, 'z')).toEqual({ ...state, canvas: false });
    // Opened while the whole canvas is converged over kept groups: its own group is drawn as cards too, never left
    // as an icon beside the opened card.
    expect(expandForNode({ ...state, canvas: true }, 'c')).toEqual({ canvas: false, groups: [{ id: 'g1', members: ['a', 'b'] }] });
  });

  it('counts a node listed twice in one group once: no phantom group of two', () => {
    const storage = memoryStorage({ [CONVERGED_GROUPS_KEY]: JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g1', members: ['a', 'a'] }, { id: 'g2', members: ['b', 'c', 'b'] }] }) });
    expect(loadConvergedState(storage).groups).toEqual([{ id: 'g2', members: ['b', 'c'] }]);
    const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 800, 0)];
    const view = convergeView(nodes, [], [{ id: 'g1', members: ['a', 'a'] }], { w: 160, h: 160 });
    expect(view.icons).toEqual([]);
    expect(view.hidden.size).toBe(0);
  });

  it('prunes to the nodes on the canvas and returns the same array when nothing changed', () => {
    const groups: ConvergedGroup[] = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['c', 'd', 'e'] }];
    expect(pruneConvergedGroups(groups, new Set(['a', 'b', 'c', 'd', 'e']))).toBe(groups);
    expect(pruneConvergedGroups(groups, new Set(['a', 'c', 'd']))).toEqual([{ id: 'g2', members: ['c', 'd'] }]);
  });

  it('converges at least two distinct nodes, taking them out of the groups they were in', () => {
    const groups: ConvergedGroup[] = [{ id: 'g1', members: ['a', 'b', 'c'] }];
    expect(convergeNodes(groups, ['a'], 'g2')).toBe(groups);
    expect(convergeNodes(groups, ['x', 'x'], 'g2')).toBe(groups);
    expect(convergeNodes(groups, ['c', 'd'], 'g2')).toEqual([{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['c', 'd'] }]);
    // Taking two of three leaves one: that group dissolves.
    expect(convergeNodes(groups, ['b', 'c', 'd'], 'g2')).toEqual([{ id: 'g2', members: ['b', 'c', 'd'] }]);
  });

  it('converges by stage: one group per step of the graph, a stage of one node stays a card', () => {
    const nodes = ['director', 'b1', 'b2', 'b3', 'assembly', 't1', 't2'].map((id, index) => node(id, index * 300, 0));
    const depths = new Map([['director', 0], ['b1', 1], ['b2', 1], ['b3', 1], ['assembly', 2], ['t1', 3], ['t2', 3]]);
    expect(stageGroups(nodes, depths)).toEqual([
      { id: 'stage-1', members: ['b1', 'b2', 'b3'] },
      { id: 'stage-3', members: ['t1', 't2'] },
    ]);
    expect(stageGroups([], new Map())).toEqual([]);
  });

  it('expands a group by id, or the group holding a node that is being opened', () => {
    const groups: ConvergedGroup[] = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['c', 'd'] }];
    expect(expandGroup(groups, 'g1')).toEqual([{ id: 'g2', members: ['c', 'd'] }]);
    expect(expandGroup(groups, 'nope')).toBe(groups);
    expect(expandGroupOf(groups, 'd')).toEqual([{ id: 'g1', members: ['a', 'b'] }]);
    expect(expandGroupOf(groups, 'z')).toBe(groups);
  });
});

describe('the board while groups are converged', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 0, 400), node('d', 800, 200), node('e', 1200, 200)];
  const edges = [wire('a', 'b'), wire('a', 'c'), wire('b', 'd'), wire('c', 'd'), wire('d', 'e')];
  const size = { w: 160, h: 160 };

  it('draws the board exactly as before when nothing is converged', () => {
    const view = convergeView(nodes, edges, [], size);
    expect(view.wireNodes).toBe(nodes);
    expect(view.wireEdges).toBe(edges);
    expect(view.hidden.size).toBe(0);
    expect(view.icons).toEqual([]);
  });

  it('puts one icon at the middle of its members and hides them', () => {
    const view = convergeView(nodes, edges, [{ id: 'g', members: ['a', 'b', 'c'] }], size);
    expect([...view.hidden].sort()).toEqual(['a', 'b', 'c']);
    expect(view.icons).toHaveLength(1);
    const icon = view.icons[0];
    // Middles: a (130, 64), b (530, 64), c (130, 464) → (263.33, 197.33).
    expect(icon.x + icon.w / 2).toBeCloseTo((130 + 530 + 130) / 3);
    expect(icon.y + icon.h / 2).toBeCloseTo((64 + 64 + 464) / 3);
    expect(icon.members).toEqual(['a', 'b', 'c']);
    expect(view.groupOf.get('b')).toBe('g');
  });

  it('drops only the wires inside a group, and ends every crossing wire on the icon', () => {
    const view = convergeView(nodes, edges, [{ id: 'g', members: ['a', 'b', 'c'] }], size);
    expect(view.wireEdges.map(edge => edge.id)).toEqual(['b:result->d:context', 'c:result->d:context', 'd:result->e:context']);
    const icon = view.icons[0];
    const byId = new Map(view.wireNodes.map(item => [item.id, item]));
    for (const edge of view.wireEdges.filter(item => item.fromNode === 'b' || item.fromNode === 'c')) {
      const anchor = portAnchorWorld(byId.get(edge.fromNode)!, edge.fromPort)!;
      // An output leaves from the icon's right side, near its middle.
      expect(anchor.x).toBeCloseTo(icon.x + icon.w);
      expect(Math.abs(anchor.y - (icon.y + icon.h / 2))).toBeLessThanOrEqual(icon.h / 10);
    }
    // Nodes outside every group keep their own objects, so their cards are not redrawn.
    expect(byId.get('d')).toBe(nodes[3]);
    expect(byId.get('e')).toBe(nodes[4]);
  });

  it('draws a wire between two groups from one icon to the other', () => {
    const view = convergeView(nodes, edges, [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['d', 'e'] }], size);
    expect(view.wireEdges.map(edge => edge.id)).toEqual(['a:result->c:context', 'b:result->d:context', 'c:result->d:context']);
    const [one, two] = view.icons;
    const byId = new Map(view.wireNodes.map(item => [item.id, item]));
    expect(portAnchorWorld(byId.get('b')!, 'result')!.x).toBeCloseTo(one.x + one.w);
    expect(portAnchorWorld(byId.get('d')!, 'context')!.x).toBeCloseTo(two.x);
  });

  it('draws a group of two components only: a form and one Agent stay cards', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f', w: 260, h: 128 };
    const view = convergeView([form, ...nodes], edges, [{ id: 'g', members: ['f', 'a'] }, { id: 'h', members: ['f', 'b', 'c'] }], size);
    // 'g' is a form and one Agent: no icon; 'h' keeps the form inside with its two Agents.
    expect(view.icons.map(icon => icon.id)).toEqual(['h']);
    expect(view.icons[0].members).toEqual(['f', 'b', 'c']);
    expect(view.hidden.has('a')).toBe(false);
  });

  it('keeps the objects of the wires an edit does not change, so an edit beside a group is not taken for one inside it', () => {
    const typed = edges.map(edge => ({ ...edge }));
    const kept = reconcileEdges(nodes, typed);
    expect(kept.every((edge, index) => edge === typed[index])).toBe(true);
    // A card renamed beside the group: its wires are the same objects, so nothing inside the icon is reached.
    const renamed = { nodes: nodes.map(item => item.id === 'e' ? { ...item, title: 'e!' } : item), edges: reconcileEdges(nodes, edges) };
    expect(editReachesHidden({ nodes, edges }, renamed, new Set(['a', 'b', 'c']), false)).toBe(false);
  });

  it('ignores members that are not on the canvas and groups left with fewer than two', () => {
    const view = convergeView(nodes, edges, [{ id: 'g1', members: ['a', 'gone'] }, { id: 'g2', members: ['d', 'e', 'gone'] }], size);
    expect(view.icons.map(icon => icon.id)).toEqual(['g2']);
    expect(view.icons[0].members).toEqual(['d', 'e']);
    expect(view.hidden.has('a')).toBe(false);
  });

  it('never changes the nodes or edges it is given', () => {
    const before = JSON.stringify({ nodes, edges });
    convergeView(nodes, edges, [{ id: 'g', members: ['a', 'b', 'c', 'd'] }], size);
    expect(JSON.stringify({ nodes, edges })).toBe(before);
  });
});

describe('an edit while components are converged', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 800, 0)];
  const edges = [wire('a', 'b'), wire('b', 'c')];
  const doc = { nodes, edges };
  const hiddenBC = new Set(['b', 'c']);
  const renamed = (id: string) => nodes.map(item => item.id === id ? { ...item, title: `${id}!` } : item);

  it('reaches nothing hidden while nothing is converged, whatever it does', () => {
    expect(editReachesHidden(doc, { nodes: [...nodes, node('d', 0, 0)], edges }, new Set(), false)).toBe(false);
    expect(editReachesHidden(doc, { nodes: renamed('a'), edges: [] }, new Set(), false)).toBe(false);
  });

  it('reaches the icon when it changes or removes a member inside it, or a wire of one', () => {
    expect(editReachesHidden(doc, { nodes: renamed('b'), edges }, hiddenBC, false)).toBe(true);
    expect(editReachesHidden(doc, { nodes: nodes.filter(item => item.id !== 'c'), edges }, hiddenBC, false)).toBe(true);
    expect(editReachesHidden(doc, { nodes, edges: [edges[1]] }, hiddenBC, false)).toBe(true);
    expect(editReachesHidden(doc, { nodes, edges: [...edges, wire('c', 'a')] }, hiddenBC, false)).toBe(true);
    expect(editReachesHidden(doc, { nodes, edges: [{ ...edges[0] }, edges[1]] }, hiddenBC, false)).toBe(true);
  });

  it('leaves the icon alone for what the board draws: a card outside it, a node added beside a group, the same document', () => {
    const hiddenB = new Set(['b']);
    expect(editReachesHidden(doc, { nodes: renamed('a'), edges }, hiddenB, false)).toBe(false);
    expect(editReachesHidden(doc, { nodes: [...nodes, node('d', 0, 0)], edges }, hiddenBC, false)).toBe(false);
    expect(editReachesHidden(doc, { nodes: [...nodes], edges: [...edges] }, hiddenBC, true)).toBe(false);
    expect(editReachesHidden({ nodes: [node('x', 0, 0), node('y', 0, 0)], edges: [] }, { nodes: [node('x', 0, 0), node('y', 0, 0)], edges: [wire('x', 'y')] },
      hiddenBC, false)).toBe(false);
  });

  it('reaches a converged canvas with any node added, even one not drawn as an icon (under two components)', () => {
    expect(editReachesHidden(doc, { nodes: [...nodes, node('d', 0, 0)], edges }, new Set(['a', 'b', 'c']), true)).toBe(true);
    const one = { nodes: [nodes[0]], edges: [] };
    expect(editReachesHidden(one, { nodes: [nodes[0], node('d', 0, 0)], edges: [] }, new Set(), true)).toBe(true);
    // Changing the lone card of such a canvas is an edit of what is drawn.
    expect(editReachesHidden(one, { nodes: [{ ...nodes[0], title: 'a!' }], edges: [] }, new Set(), true)).toBe(false);
  });
});

describe('where the preference is kept', () => {
  it('under each person’s own key for each canvas, beside the canvas cache, never one key for everyone', async () => {
    // A fresh module pair, so the scope set here never reaches the tests above (they use the unscoped local key).
    vi.resetModules();
    const storageModule = await import('../src/canvas/canvasStorage');
    const groupsModule = await import('../src/canvas/convergedGroups');
    const storage = memoryStorage();
    storageModule.configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
    groupsModule.saveConvergedState({ canvas: true, groups: [] }, new Set(['a', 'b']), storage);
    expect([...storage.data.keys()]).toEqual([`awwo.saas:user-a:tenant-a:canvas-a:${CONVERGED_GROUPS_KEY}`]);
    expect(groupsModule.loadConvergedState(storage)).toEqual({ canvas: true, groups: [] });
    storageModule.configureCanvasStorage('user-a', 'tenant-a', 'canvas-b');
    expect(groupsModule.loadConvergedState(storage)).toBe(groupsModule.NOTHING_CONVERGED);
    storageModule.configureCanvasStorage('user-b', 'tenant-a', 'canvas-a');
    expect(groupsModule.loadConvergedState(storage)).toBe(groupsModule.NOTHING_CONVERGED);
  });
});
