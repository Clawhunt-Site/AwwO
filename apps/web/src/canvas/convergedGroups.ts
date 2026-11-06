// Which components are drawn converged into one live icon (收敛), and how the board is drawn while they are.
//
// A view preference, like the card sizes (cardFrames.ts): kept per person and browser beside the canvas cache, never in
// the canvas document. Converging hides the members' cards and draws one icon where they were; it never changes the
// nodes, the wires, what a run runs or anyone else's view, so it works for a reader and while the canvas runs, with no
// undo step and no cloud save.
import type { CanvasDocument, CanvasEdge, CanvasNode } from './canvasDoc';
import { canvasStorageKey } from './canvasStorage';

export interface ConvergedGroup {
  id: string;
  /** Node ids, in the order they were converged. A node is in one group at most. */
  members: string[];
}

/** What is drawn converged on one canvas: the whole canvas as one icon (its members are every node on it; an edit on
 *  this page that adds one or changes one draws the cards again first: editReachesHidden), and groups of chosen
 *  components, drawn while the whole canvas is not. */
export interface ConvergedState {
  canvas: boolean;
  groups: ReadonlyArray<ConvergedGroup>;
}

export const CONVERGED_GROUPS_KEY = 'awwo.canvas.converged.v1';
export const NOTHING_CONVERGED: ConvergedState = Object.freeze({ canvas: false, groups: Object.freeze([]) as ReadonlyArray<ConvergedGroup> });
/** The id of the whole canvas's icon. */
export const CANVAS_GROUP_ID = 'canvas';
/** A group needs at least two components: one converged card is just a smaller card. */
export const MIN_GROUP_MEMBERS = 2;
const MAX_GROUPS = 200;
const MAX_ID_LENGTH = 200;

type ReadStorage = Pick<Storage, 'getItem'> | null;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
const browserStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** Groups as stored, fail-soft: anything malformed is dropped, a node claimed twice stays with its first group. */
function readGroups(raw: unknown): ConvergedGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: ConvergedGroup[] = [];
  for (const item of raw.slice(0, MAX_GROUPS)) {
    if (!item || typeof item !== 'object') continue;
    const { id, members } = item as Record<string, unknown>;
    if (!validId(id) || id === CANVAS_GROUP_ID || !Array.isArray(members)) continue;
    groups.push({ id, members: members.filter(validId) });
  }
  return claimOnce(groups);
}

/** What this person last drew converged on this canvas, fail-soft: anything malformed means nothing is. */
export function loadConvergedState(storage: ReadStorage = browserStorage()): ConvergedState {
  try {
    const raw = JSON.parse(storage?.getItem(canvasStorageKey(CONVERGED_GROUPS_KEY)) || 'null') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NOTHING_CONVERGED;
    const { v, canvas, groups } = raw as Record<string, unknown>;
    if (v !== 1) return NOTHING_CONVERGED;
    const kept = readGroups(groups);
    return canvas === true || kept.length ? { canvas: canvas === true, groups: kept } : NOTHING_CONVERGED;
  } catch { return NOTHING_CONVERGED; }
}

/** Keep what is still on the canvas; nothing converged means no entry. Writes only on a change. */
export function saveConvergedState(state: ConvergedState, nodeIds: ReadonlySet<string>, storage: WriteStorage = browserStorage()): void {
  const groups = claimOnce(state.groups, nodeIds);
  try {
    const key = canvasStorageKey(CONVERGED_GROUPS_KEY);
    const current = storage?.getItem(key) ?? null;
    if (state.canvas || groups.length) {
      const next = JSON.stringify({ v: 1, canvas: state.canvas, groups: groups.map(({ id, members }) => ({ id, members })) });
      if (current !== next) storage?.setItem(key, next);
    } else if (current !== null) storage?.removeItem(key);
  } catch { /* A view preference that cannot be stored lasts for this page only. */ }
}

/** The groups the board draws now: the whole canvas as one icon while it is converged and has two components, else the
 *  chosen groups. `steps` counts the components the icon counts and rings (forms are inputs, not steps), so a form and
 *  one Agent are never drawn as an icon of "1 component"; the icon still holds every node. */
export function drawnGroups(state: ConvergedState, nodeIds: ReadonlyArray<string>, steps = nodeIds.length): ReadonlyArray<ConvergedGroup> {
  if (state.canvas) return steps >= MIN_GROUP_MEMBERS ? [{ id: CANVAS_GROUP_ID, members: [...nodeIds] }] : [];
  return state.groups;
}

/** How many of these nodes the icon counts as components: every node but forms. */
export const countSteps = (nodes: ReadonlyArray<Pick<CanvasNode, 'kind'>>) => nodes.reduce((count, node) => node.kind === 'form' ? count : count + 1, 0);

/**
 * Whether an edit from `prev` to `next` reaches what the board does not draw: a node it adds while the whole canvas is
 * converged (it would join the icon unseen), a member inside an icon it changes or removes, or a wire to one it adds,
 * changes or removes. Such an edit draws the cards again first, so nothing changes inside an icon unseen. Compared by
 * object, as the document is edited (every edit makes new objects for what it changes only); O(nodes + edges).
 */
export function editReachesHidden(prev: Pick<CanvasDocument, 'nodes' | 'edges'>, next: Pick<CanvasDocument, 'nodes' | 'edges'>,
  hidden: ReadonlySet<string>, canvasConverged: boolean): boolean {
  // A converged canvas not drawn as an icon (under two components) still takes the next node added into it.
  if (!hidden.size && !canvasConverged) return false;
  if (prev.nodes !== next.nodes) {
    const before = new Map(prev.nodes.map(node => [node.id, node]));
    for (const node of next.nodes) {
      const was = before.get(node.id);
      if (was ? was !== node && hidden.has(node.id) : canvasConverged) return true;
      before.delete(node.id);
    }
    for (const id of before.keys()) if (hidden.has(id)) return true;
  }
  if (prev.edges !== next.edges) {
    const touches = (edge: CanvasEdge) => hidden.has(edge.fromNode) || hidden.has(edge.toNode);
    const before = new Map(prev.edges.map(edge => [edge.id, edge]));
    for (const edge of next.edges) {
      if (before.get(edge.id) !== edge && touches(edge)) return true;
      before.delete(edge.id);
    }
    for (const edge of before.values()) if (touches(edge)) return true;
  }
  return false;
}

/** The state after a node is opened: it is drawn in its place again, with the icon it was in (the whole canvas's, or its
 *  group's) drawn as cards. The same object when the node was not converged. */
export function expandForNode(state: ConvergedState, nodeId: string): ConvergedState {
  const groups = expandGroupOf(state.groups, nodeId);
  // The whole canvas is drawn as cards again, and so is the group holding the node, drawn once the canvas is not.
  if (state.canvas) return { canvas: false, groups };
  return groups === state.groups ? state : { ...state, groups };
}

/** Each node in its first group only, groups with distinct ids, and none under two members. */
function claimOnce(groups: ReadonlyArray<ConvergedGroup>, keep?: ReadonlySet<string>): ConvergedGroup[] {
  const claimed = new Set<string>();
  const ids = new Set<string>();
  const out: ConvergedGroup[] = [];
  for (const group of groups) {
    if (ids.has(group.id)) continue;
    // A node listed twice in one group is one member: ['a', 'a'] is no group of two.
    const members = [...new Set(group.members)].filter(id => !claimed.has(id) && (!keep || keep.has(id)));
    if (members.length < MIN_GROUP_MEMBERS) continue;
    members.forEach(id => claimed.add(id));
    ids.add(group.id);
    out.push(members.length === group.members.length ? group : { ...group, members });
  }
  return out;
}

/** The groups that still mean something on this canvas: members no longer on it leave, and a group left with fewer than
 *  two members dissolves (its last card is drawn again). Returns the same array when nothing changed. */
export function pruneConvergedGroups(groups: ReadonlyArray<ConvergedGroup>, nodeIds: ReadonlySet<string>): ReadonlyArray<ConvergedGroup> {
  const next = claimOnce(groups, nodeIds);
  return next.length === groups.length && next.every((group, index) => group === groups[index]) ? groups : next;
}

let sequence = 0;
/** A new group id, unique within this page (and, with the time in it, across reloads). */
export function newGroupId(now = Date.now()): string {
  sequence = (sequence + 1) % 1_000_000;
  return `cg-${now.toString(36)}-${sequence.toString(36)}`;
}

/** The groups after converging these nodes into a new group (the nodes leave any group they were in). Unchanged when
 *  fewer than two distinct nodes are given. */
export function convergeNodes(groups: ReadonlyArray<ConvergedGroup>, nodeIds: ReadonlyArray<string>, id = newGroupId()): ReadonlyArray<ConvergedGroup> {
  const members = [...new Set(nodeIds.filter(validId))];
  if (members.length < MIN_GROUP_MEMBERS) return groups;
  const taken = new Set(members);
  const rest = groups.map(group => group.members.some(member => taken.has(member))
    ? { ...group, members: group.members.filter(member => !taken.has(member)) } : group);
  return claimOnce([...rest, { id, members }]);
}

/** The id of the group a stage of the graph converges into: the same for that step every time, so converging by stage
 *  again keeps each icon where and what it was. */
export const stageGroupId = (step: number) => `stage-${step}`;

/**
 * The canvas converged by stage: the nodes at each step of the graph (`depths`, from nodeDepths with feedback wires left
 * out) make one group, in graph order; a stage of one node stays a card. A case canvas then reads as its stages do on
 * the homepage (Director → nine builders → Assembly → Test → Review), each stage one live icon.
 */
export function stageGroups(nodes: ReadonlyArray<CanvasNode>, depths: ReadonlyMap<string, number>): ConvergedGroup[] {
  const byStep = new Map<number, string[]>();
  for (const node of nodes) {
    const step = depths.get(node.id) ?? 0;
    const members = byStep.get(step) ?? [];
    members.push(node.id);
    byStep.set(step, members);
  }
  return [...byStep.entries()].sort(([a], [b]) => a - b)
    .filter(([, members]) => members.length >= MIN_GROUP_MEMBERS)
    .map(([step, members]) => ({ id: stageGroupId(step), members }));
}

/** The groups after drawing one group's cards again. */
export function expandGroup(groups: ReadonlyArray<ConvergedGroup>, groupId: string): ReadonlyArray<ConvergedGroup> {
  return groups.some(group => group.id === groupId) ? groups.filter(group => group.id !== groupId) : groups;
}

/** The groups after drawing the group holding this node again, if any (opening a node shows it in its place). */
export function expandGroupOf(groups: ReadonlyArray<ConvergedGroup>, nodeId: string): ReadonlyArray<ConvergedGroup> {
  const group = groups.find(item => item.members.includes(nodeId));
  return group ? expandGroup(groups, group.id) : groups;
}

// ---- the board while groups are converged ------------------------------------------------------------------------

export interface ConvergedIconBox {
  id: string;
  /** The icon's world box: centred on the middle of its members' drawn boxes. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The members on the canvas now, in group order. */
  members: ReadonlyArray<string>;
}

export interface ConvergedView {
  /** Nodes drawn inside an icon instead of as a card. */
  hidden: ReadonlySet<string>;
  groupOf: ReadonlyMap<string, string>;
  icons: ReadonlyArray<ConvergedIconBox>;
  /** The nodes the wires are drawn from: a hidden member carries its icon's box, so a wire that crosses the group's
   *  edge stays a real edge and ends on the icon (inputs on its left, outputs on its right). */
  wireNodes: ReadonlyArray<CanvasNode>;
  /** The edges drawn: a wire between two members of one group is inside the icon and is not drawn. */
  wireEdges: ReadonlyArray<CanvasEdge>;
}

/** An icon's world box: square, the same at every zoom, so a wire's end never moves while the board zooms. */
export const CONVERGED_ICON_WORLD = 160;
/** However far the board is zoomed out, an icon is drawn at least this large on screen: its drawing scales up about its
 *  centre (convergedIconScale), its box does not. */
export const CONVERGED_ICON_MIN_PX = 40;

/** How much the icon's drawing is enlarged at this zoom: 1 until its box would be drawn under the floor. */
export function convergedIconScale(zoom: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(1, CONVERGED_ICON_MIN_PX / (CONVERGED_ICON_WORLD * z));
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const NO_GROUPS: ReadonlyMap<string, string> = new Map();

/**
 * How the board is drawn with these groups converged. `nodes` are the drawn boxes (presentationNodes), `size` the icon's
 * world size. Pure, O(nodes + edges); when nothing is converged the inputs come back as they are, so the board draws
 * exactly as without this.
 */
export function convergeView(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>,
  groups: ReadonlyArray<ConvergedGroup>, size: { w: number; h: number }): ConvergedView {
  if (!groups.length) return { hidden: NOTHING_HIDDEN, groupOf: NO_GROUPS, icons: [], wireNodes: nodes, wireEdges: edges };
  const byId = new Map(nodes.map(node => [node.id, node]));
  const groupOf = new Map<string, string>();
  const icons: ConvergedIconBox[] = [];
  for (const group of groups) {
    const members = [...new Set(group.members)].filter(id => byId.has(id) && !groupOf.has(id));
    // Two components, as for the whole canvas: forms are inputs, so a form and one Agent stay cards.
    if (countSteps(members.map(id => byId.get(id)!)) < MIN_GROUP_MEMBERS) continue;
    let cx = 0;
    let cy = 0;
    for (const id of members) {
      const node = byId.get(id)!;
      cx += node.x + node.w / 2;
      cy += node.y + node.h / 2;
    }
    cx /= members.length;
    cy /= members.length;
    members.forEach(id => groupOf.set(id, group.id));
    icons.push({ id: group.id, x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h, members });
  }
  if (!icons.length) return { hidden: NOTHING_HIDDEN, groupOf: NO_GROUPS, icons, wireNodes: nodes, wireEdges: edges };
  const iconById = new Map(icons.map(icon => [icon.id, icon]));
  // A member's ports gather around the middle of the icon's sides (a band a fifth of its height), so every wire meets
  // the round icon where its edge is, whatever how many ports the member has.
  const wireNodes = nodes.map(node => {
    const groupId = groupOf.get(node.id);
    if (!groupId) return node;
    const icon = iconById.get(groupId)!;
    const band = icon.h / 5;
    return { ...node, x: icon.x, y: icon.y + (icon.h - band) / 2, w: icon.w, h: band };
  });
  const wireEdges = edges.filter(edge => {
    const from = groupOf.get(edge.fromNode);
    return !from || from !== groupOf.get(edge.toNode);
  });
  return { hidden: new Set(groupOf.keys()), groupOf, icons, wireNodes, wireEdges };
}
