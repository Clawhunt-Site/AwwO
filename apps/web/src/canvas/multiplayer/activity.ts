// One line per canvas change, for the 同屏 panel's 最近的改动 (docs/awwo-canvas-live-collaboration.md, The canvas page):
// 「Claude Code 添加了节点「后端接口」」 / "Claude Code added the node “Backend API”". Pure: the caller names the nodes
// (nodeTitle, from the document it holds) and decides which changes to show; folding a run of one author's moves into
// one line is the caller's, not this file's.
//
// A change's ops are its effective ops (the server's diff of the document before and after it), so a record `set` on a
// node is a node that is new, and a field op is one field of a node that stays. A line names the most telling edits
// first: nodes added and removed, results, renames and settings, inputs and outputs, forms and conversations, wires,
// then sizes and moves.
import type { UiLocale } from '../../locale';
import type { CanvasChange, CanvasOp, LiveParticipant } from './types';
import { sameValue } from './changes';
import { mt, shownTitle, type MultiplayerTextKey } from './multiplayerText';

type NodeBucket = 'added' | 'removed' | 'result' | 'renamed' | 'settings' | 'contract' | 'form' | 'thread' | 'resized' | 'moved';
type Flag = 'displays' | 'waypoints' | 'canvas' | 'order';

/** What a line can be told besides the change itself. */
export interface DescribeOptions {
  /** A node's contract as it was before the change, where the caller knows it. A run's results reach a node's contract
   *  as its outputs' values, and a contract whose only change is those is told as a result, as the server's run fence
   *  tells it (canvas_change_write.go contractOnlyOutputValues). Without it, a contract's change is told as one of its
   *  inputs and outputs: no label or op says which it was. */
  contractBefore?: (nodeId: string) => unknown;
}

/** A node's place on the board; `deliverablesOpen` widens it with its drawer. */
const MOVE_KEYS = new Set(['x', 'y']);
const SIZE_KEYS = new Set(['w', 'h', 'deliverablesOpen']);
/** What a run writes into a node or into one of its conversations (the fence's free results). */
const RESULT_KEYS = new Set(['lastOutput', 'preview', 'issueId', 'outputValues']);

interface Tally {
  nodes: Map<NodeBucket, string[]>;
  /** A node's title as the change itself gives it: a new node's, or a rename's. */
  titles: Map<string, string>;
  wires: Array<{ from: string; to: string }>;
  unwired: number;
  flags: Set<Flag>;
  /** Every node the ops name, in their order. */
  named: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function name(tally: Tally, id: string) {
  if (!tally.named.includes(id)) tally.named.push(id);
}

function note(tally: Tally, bucket: NodeBucket, id: string) {
  const list = tally.nodes.get(bucket) ?? [];
  if (!list.includes(id)) list.push(id);
  tally.nodes.set(bucket, list);
  name(tally, id);
}

/** A contract with its outputs' values taken out: what stays when a run writes its results into it. */
function withoutOutputValues(contract: unknown): unknown {
  const record = asRecord(contract);
  if (!record || !Array.isArray(record.outputs)) return contract;
  return { ...record, outputs: record.outputs.map(field => {
    const output = asRecord(field);
    if (!output) return field;
    const rest = { ...output };
    delete rest.value;
    return rest;
  }) };
}

/** Whether a contract's change is only its outputs' values (a run's results), told by the contract before it. */
function onlyOutputValues(op: CanvasOp, before: unknown): boolean {
  return op.op === 'set' && asRecord(before) !== null && asRecord(op.value) !== null && sameValue(withoutOutputValues(before), withoutOutputValues(op.value));
}

/** Which kind of edit one field of a node is. */
function nodeFieldBucket(id: string, key: string, op: CanvasOp, options: DescribeOptions): NodeBucket {
  if (MOVE_KEYS.has(key)) return 'moved';
  if (SIZE_KEYS.has(key)) return 'resized';
  if (RESULT_KEYS.has(key)) return 'result';
  if (key === 'contract') return options.contractBefore && onlyOutputValues(op, options.contractBefore(id)) ? 'result' : 'contract';
  if (key === 'title' && op.op === 'set' && typeof op.value === 'string') return 'renamed';
  return 'settings';
}

function classifyNodeOp(tally: Tally, op: CanvasOp, path: readonly string[], options: DescribeOptions) {
  const id = path[1];
  if (path.length === 2) {
    if (op.op === 'set') {
      note(tally, 'added', id);
      const title = asRecord(op.value)?.title;
      if (typeof title === 'string') tally.titles.set(id, title);
    } else if (op.op === 'del') note(tally, 'removed', id);
    return;
  }
  const key = path[2];
  if (key === 'fields') { note(tally, 'form', id); return; }
  if (key === 'threads') {
    // A conversation's own results are results; anything else in it (a draft, a title, a new one) is the conversation.
    note(tally, path.length === 5 && RESULT_KEYS.has(path[4]) ? 'result' : 'thread', id);
    return;
  }
  if (path.length !== 3) return;
  const bucket = nodeFieldBucket(id, key, op, options);
  note(tally, bucket, id);
  if (bucket === 'renamed' && op.op === 'set') tally.titles.set(id, String(op.value));
}

function classify(tally: Tally, op: CanvasOp, options: DescribeOptions) {
  const path = Array.isArray(op.path) ? op.path.filter((part): part is string => typeof part === 'string') : [];
  const collection = path[0];
  if ((collection === 'nodes' || collection === 'edges') && path.length === 1) { tally.flags.add('order'); return; }
  if (collection === 'nodes') { if (path.length >= 2) classifyNodeOp(tally, op, path, options); return; }
  if (collection === 'edges') {
    if (op.op === 'del') { tally.unwired += 1; return; }
    const wire = op.op === 'set' ? asRecord(op.value) : null;
    if (wire && typeof wire.fromNode === 'string' && typeof wire.toNode === 'string') {
      tally.wires.push({ from: wire.fromNode, to: wire.toNode });
      name(tally, wire.fromNode);
      name(tally, wire.toNode);
    }
    return;
  }
  if (collection === 'displays') tally.flags.add('displays');
  else if (collection === 'waypoints') tally.flags.add('waypoints');
  else if (collection === 'doc') tally.flags.add('canvas');
}

function tallyOf(change: CanvasChange, options: DescribeOptions): Tally {
  const tally: Tally = { nodes: new Map(), titles: new Map(), wires: [], unwired: 0, flags: new Set(), named: [] };
  for (const op of Array.isArray(change.ops) ? change.ops : []) if (op && typeof op === 'object') classify(tally, op, options);
  // A node this change added or removed is named for that alone (raw ops can also touch its fields).
  const whole = new Set([...(tally.nodes.get('added') ?? []), ...(tally.nodes.get('removed') ?? [])]);
  for (const [bucket, ids] of tally.nodes) {
    if (bucket !== 'added' && bucket !== 'removed') tally.nodes.set(bucket, ids.filter(id => !whole.has(id)));
  }
  // A resize from a left or top edge moves the node too: it is told as the resize.
  const resized = new Set(tally.nodes.get('resized') ?? []);
  tally.nodes.set('moved', (tally.nodes.get('moved') ?? []).filter(id => !resized.has(id)));
  return tally;
}

type Describe = (tally: Tally, title: (id: string) => string, nodeTitle: (id: string) => string | undefined, locale: UiLocale) => string | null;

/** One node or a count of them, by the two keys of an edit. */
function nodes(bucket: NodeBucket, one: MultiplayerTextKey, many: MultiplayerTextKey): Describe {
  return (tally, title, _nodeTitle, locale) => {
    const ids = tally.nodes.get(bucket) ?? [];
    if (!ids.length) return null;
    return ids.length === 1 ? mt(locale, one, { node: title(ids[0]) }) : mt(locale, many, { count: ids.length });
  };
}

/** The edits a line can name, the most telling first. */
const PHRASES: readonly Describe[] = [
  nodes('added', 'act.addedOne', 'act.addedMany'),
  (tally, _title, nodeTitle, locale) => {
    const ids = tally.nodes.get('removed') ?? [];
    if (ids.length > 1) return mt(locale, 'act.removedMany', { count: ids.length });
    if (!ids.length) return null;
    // A removed node is usually gone from the caller's document too: then it is "a node".
    const known = nodeTitle(ids[0]);
    return known === undefined ? mt(locale, 'act.removedSome') : mt(locale, 'act.removedOne', { node: shownTitle(locale, known) });
  },
  nodes('result', 'act.resultOne', 'act.resultMany'),
  nodes('renamed', 'act.renamedOne', 'act.renamedMany'),
  nodes('settings', 'act.settingsOne', 'act.settingsMany'),
  nodes('contract', 'act.contractOne', 'act.contractMany'),
  nodes('form', 'act.formOne', 'act.formMany'),
  nodes('thread', 'act.threadOne', 'act.threadMany'),
  (tally, title, _nodeTitle, locale) => tally.wires.length === 1
    ? mt(locale, 'act.connectedOne', { from: title(tally.wires[0].from), to: title(tally.wires[0].to) })
    : tally.wires.length > 1 ? mt(locale, 'act.connectedMany', { count: tally.wires.length }) : null,
  (tally, _title, _nodeTitle, locale) => tally.unwired === 1 ? mt(locale, 'act.disconnectedOne')
    : tally.unwired > 1 ? mt(locale, 'act.disconnectedMany', { count: tally.unwired }) : null,
  nodes('resized', 'act.resizedOne', 'act.resizedMany'),
  nodes('moved', 'act.movedOne', 'act.movedMany'),
  (tally, _title, _nodeTitle, locale) => tally.flags.has('displays') ? mt(locale, 'act.displays') : null,
  (tally, _title, _nodeTitle, locale) => tally.flags.has('waypoints') ? mt(locale, 'act.waypoints') : null,
  (tally, _title, _nodeTitle, locale) => tally.flags.has('canvas') ? mt(locale, 'act.canvas') : null,
];

/** One short line for a change, and the nodes it set or changed (not the ones it removed) in the order its ops name
 *  them; a new wire's two ends count. */
export function describeChange(change: CanvasChange, nodeTitle: (id: string) => string | undefined, locale: UiLocale,
  options: DescribeOptions = {}): { text: string; nodeIds: string[] } {
  const tally = tallyOf(change, options);
  const title = (id: string) => shownTitle(locale, tally.titles.get(id) ?? nodeTitle(id));
  const phrases = PHRASES.map(describe => describe(tally, title, nodeTitle, locale)).filter((phrase): phrase is string => phrase !== null);
  // An order on its own is told; beside other edits it is part of them.
  if (!phrases.length && tally.flags.has('order')) phrases.push(mt(locale, 'act.order'));
  const actorName = typeof change.actor?.name === 'string' ? change.actor.name.trim() : '';
  const who = actorName || mt(locale, 'someone');
  const [a = mt(locale, 'act.generic'), b = ''] = phrases;
  const text = phrases.length <= 1 ? mt(locale, 'act.one', { who, a })
    : phrases.length === 2 ? mt(locale, 'act.two', { who, a, b })
      : phrases.length === 3 ? mt(locale, 'act.moreOne', { who, a, b })
        : mt(locale, 'act.more', { who, a, b, count: phrases.length - 2 });
  const removed = new Set(tally.nodes.get('removed') ?? []);
  return { text, nodeIds: tally.named.filter(id => !removed.has(id)) };
}

/** One line of the panel's 最近的改动. */
export interface ActivityItem {
  /** The change's version: the panel lists the newest first. */
  version: number;
  text: string;
  /** The nodes it set or changed; a click on the line shows the first. */
  nodeIds: readonly string[];
  /** When the server made it (ISO). */
  at: string;
  /** Its author's colour while they are on the canvas. */
  color?: string;
}

/** The participant who made a change: a page by its client id, an agent by its token ('t_' + token id). */
export function actorParticipantId(actor: CanvasChange['actor']): string {
  return actor.kind === 'agent' && actor.tokenId ? `t_${actor.tokenId}` : actor.clientId;
}

/** A change as one line of the panel, in its author's colour when they are here. */
export function activityItem(change: CanvasChange, nodeTitle: (id: string) => string | undefined, locale: UiLocale,
  participants: readonly LiveParticipant[] = [], options: DescribeOptions = {}): ActivityItem {
  const { text, nodeIds } = describeChange(change, nodeTitle, locale, options);
  const authorId = change.actor ? actorParticipantId(change.actor) : '';
  const author = authorId ? participants.find(participant => participant.id === authorId) : undefined;
  return { version: change.version, text, nodeIds, at: change.at, ...(author ? { color: author.color } : {}) };
}
