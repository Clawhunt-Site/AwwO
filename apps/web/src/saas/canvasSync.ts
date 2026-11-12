// 多人同屏: how a canvas page keeps its copy of the server's document (confirmed) and its own working document apart,
// and moves both when changes come (docs/awwo-canvas-live-collaboration.md, "A page's own edits win until they are
// sent"). Pure: the page (SaaSApp CloudCanvas) holds the state, the canvas surface applies the rebase it is handed to
// its document and to every undo and redo step.

import { keepAgentWritten, keepCurrentAgentWritten } from '../canvas/agentPages';
import { sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { applyOps, CanvasOpError, diffDocuments, othersOps, rebaseAfterAck, rebaseWorking, sameValue, valueAt } from '../canvas/multiplayer/changes';
import { getNodeThreads } from '../canvas/nodeThreads';
import type { CanvasChange, CanvasOp, OpResult } from '../canvas/multiplayer/types';

/** The server's document as this page knows it, at a version. */
export interface ConfirmedCanvas { version: number; document: unknown }

/** At most this many ops go in one change (the API's bound). */
export const MAX_CHANGE_OPS = 500;

/** The changes after the confirmed version applied to it. `gap`: a change in between is missing (the page reads the
 *  changes again); `unreadable`: a change this page cannot apply (the page reads the canvas whole, as reading the
 *  changes again would stop at it again). Changes at or before the confirmed version are skipped (one already applied,
 *  or this page's own). */
export function advanceConfirmed(confirmed: ConfirmedCanvas, changes: readonly CanvasChange[]): { next: ConfirmedCanvas; applied: CanvasChange[]; gap: boolean; unreadable: boolean } {
  let next = confirmed;
  const applied: CanvasChange[] = [];
  for (const change of [...changes].sort((a, b) => a.version - b.version)) {
    if (change.version <= next.version) continue;
    if (change.version !== next.version + 1) return { next, applied, gap: true, unreadable: false };
    let document: Record<string, unknown>;
    try {
      document = applyOps(next.document as Record<string, unknown>, change.ops).doc;
    } catch (error) {
      if (error instanceof CanvasOpError) return { next, applied, gap: true, unreadable: true };
      throw error;
    }
    next = { version: change.version, document };
    applied.push(change);
  }
  return { next, applied, gap: false, unreadable: false };
}

const sanitized = new WeakMap<object, CanvasDocument>();
/** A confirmed document as the canvas reads it (sanitizeDocument), worked out once per document. */
export function readableConfirmed(document: unknown): CanvasDocument {
  if (!document || typeof document !== 'object') return sanitizeDocument(document);
  let out = sanitized.get(document);
  if (!out) { out = sanitizeDocument(document); sanitized.set(document, out); }
  return out;
}

/** The node an op changes: a node path's node, a wire's node it leads into (as the API's fence and claims read it). */
export function opNode(op: CanvasOp, doc: Pick<CanvasDocument, 'edges'>): string | null {
  if (op.path[0] === 'nodes' && op.path.length >= 2) return op.path[1];
  if (op.path[0] === 'edges' && op.path.length === 2) {
    const value = op.op === 'set' ? op.value as { toNode?: unknown } | null : null;
    if (value && typeof value.toNode === 'string') return value.toNode;
    return doc.edges.find(edge => edge.id === op.path[1])?.toNode ?? null;
  }
  return null;
}

const asJSON = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

/** Whether an op (from one document to another) only writes out, or leaves out, a session node's conversations as they
 *  read anyway: a node that keeps none reads as one default conversation made from its own fields (getNodeThreads), and
 *  the canvas writes that out when it restores a step (an undo). Sent, it would be a change of every such node for
 *  everyone, and could replace a conversation someone else just started on it; so it is no change at all. */
function sameThreadsAsRead(op: CanvasOp, from: CanvasDocument, to: CanvasDocument): boolean {
  if (op.path.length !== 3 || op.path[0] !== 'nodes' || op.path[2] !== 'threads') return false;
  const a = from.nodes.find(node => node.id === op.path[1]);
  const b = to.nodes.find(node => node.id === op.path[1]);
  if (a?.kind !== 'session' || b?.kind !== 'session' || (a.threads === undefined) === (b.threads === undefined)) return false;
  const [bare, kept] = a.threads === undefined ? [a, b] : [b, a];
  const written = asJSON(kept.threads);
  return [getNodeThreads(bare), getNodeThreads({ ...kept, threads: undefined })].some(threads => sameValue(asJSON(threads), written));
}

/** A page's document without the conversations it only wrote out (sameThreadsAsRead) where the confirmed one keeps
 *  none: they read the same, and kept they would stand for an edit of this page's own, so someone else's later change
 *  of that node's conversations could not reach it. The same document when there are none. */
function withoutThreadsAsRead(doc: CanvasDocument, confirmed: CanvasDocument): CanvasDocument {
  let nodes: CanvasDocument['nodes'] | null = null;
  doc.nodes.forEach((node, i) => {
    if (node.kind !== 'session' || node.threads === undefined) return;
    if (!sameThreadsAsRead({ op: 'set', path: ['nodes', node.id, 'threads'], value: node.threads }, confirmed, doc)) return;
    nodes ??= [...doc.nodes];
    const { threads: _written, ...bare } = node;
    nodes[i] = bare;
  });
  return nodes ? { ...doc, nodes } : doc;
}

/** What a page has not sent yet: the ops from its confirmed document to its working one, less those on nodes held back
 *  (a run fences them, or an agent's claim did) until their hold ends. */
export function unsentOps(confirmed: CanvasDocument, working: CanvasDocument, held: ReadonlyMap<string, number> = new Map(), now = Date.now()): CanvasOp[] {
  const ops = diffDocuments(confirmed as unknown as Record<string, unknown>, working as unknown as Record<string, unknown>)
    .filter(op => !sameThreadsAsRead(op, confirmed, working));
  if (!held.size) return ops;
  return ops.filter(op => {
    const node = opNode(op, working);
    const until = node ? held.get(node) : undefined;
    return until === undefined || until <= now;
  });
}

/** The ops of a change answered `node_running` or `claimed`: they stay on the page, unsent, until their node's hold ends. */
export function heldOps(sent: readonly CanvasOp[], results: readonly OpResult[] | null | undefined): CanvasOp[] {
  if (!results) return [];
  return sent.filter((_, i) => results[i] === 'node_running' || results[i] === 'claimed');
}

/** What a page applies once its confirmed document moved: `working` to the document it shows, `history` to each of its
 *  undo and redo steps. */
export interface CanvasRebase {
  working(doc: CanvasDocument): CanvasDocument;
  history(doc: CanvasDocument): CanvasDocument;
  /** The paths others set or deleted in the move (their order ops left out): an undo or redo step taken before it goes
   *  to its older value at none of them (multiplayer/history.ts). */
  othersPaths: readonly (readonly string[])[];
}

/** A confirmed document's move: from `before` to `after` (both as the server holds them), by `changes` in version
 *  order (none when the page read the document whole). `sent`: the ops of this page's own change in it, without its
 *  held ones. `own`: whether a change is this page's. */
export interface ConfirmedMove {
  before: unknown;
  after: unknown;
  changes?: readonly CanvasChange[];
  sent?: readonly CanvasOp[];
  own?: (change: CanvasChange) => boolean;
}

/**
 * The rebase a page applies once its confirmed document moved. Only others' changes are carried onto the page's
 * documents: each path one changed is taken where the page still has the value from before it, so its own unsent edits
 * stay. The page's own change is never carried: its working document already holds it, and its undo and redo steps keep
 * what they held, so an undo after a save still takes the save's edit back. The working document also takes the
 * server's answer to that change: each path it sent takes the server's value unless the page changed it again since
 * (an undo pressed while the save was out stays, unsent). Such a field is the page's whatever it holds now: someone
 * else's change of it that reached the server before the page's own went over it is not carried onto it either, though
 * the page's value there is the one from before both (the undo's), which would otherwise read as never edited. (A list
 * of records set whole, or a record deleted and brought back, still takes theirs: none is lost by a coincidence.)
 */
export function rebaseFor({ before, after, changes = [], sent = [], own = () => false }: ConfirmedMove): CanvasRebase {
  // Others' parts of the move, each from one confirmed document to another: a change of the page's own between two of
  // them ends one and starts the next, so its effect is carried by neither.
  // `beforeOwn`: the page's own change came after it, over whatever it did at the paths the page sent.
  const steps: { from: CanvasDocument; to: CanvasDocument; moved: CanvasOp[]; beforeOwn: boolean }[] = [];
  const step = (from: unknown, to: unknown, mine: readonly CanvasOp[] = [], beforeOwn = false) => {
    const fromRead = readableConfirmed(from), toRead = readableConfirmed(to);
    const all = diffDocuments(fromRead as unknown as Record<string, unknown>, toRead as unknown as Record<string, unknown>);
    const moved = mine.length ? othersOps(all, fromRead, toRead, mine) : all;
    if (moved.length) steps.push({ from: fromRead, to: toRead, moved, beforeOwn });
  };
  if (changes.length) {
    let raw = before as Record<string, unknown>;
    let start: Record<string, unknown> | null = null;
    for (const change of changes) {
      const next = applyOps(raw, change.ops).doc;
      if (own(change)) {
        if (start) step(start, raw, [], true);
        start = null;
      } else if (!start) start = raw;
      raw = next;
    }
    if (start) step(start, after);
  } else {
    // A document read whole: everything that moved, less what this page's own answered change accounts for (a node
    // someone else deleted still goes, though the page sent a field of it).
    step(before, after, sent);
  }
  const afterRead = readableConfirmed(after);
  const beforeRead = readableConfirmed(before);
  const carry = (doc: CanvasDocument, ack: boolean): CanvasDocument => {
    let next = withoutThreadsAsRead(doc, beforeRead) as unknown as Record<string, unknown>;
    // The fields the page set in its change and has changed again since (as rebaseAfterAck reads it): they are the
    // page's. Not a record it deleted and has brought back, which takes what others made of it meanwhile; nor a list
    // of records it set whole (a node's conversations), where someone else's comes back rather than be lost.
    const records = (value: unknown) => Array.isArray(value) && value.some(item => typeof item === 'object' && item !== null);
    const again = ack ? sent.filter(op => op.op === 'set' && op.value !== undefined && !records(op.value)
      && !sameValue(valueAt(next, op.path), op.value)).map(op => op.path) : [];
    if (ack && sent.length) next = rebaseAfterAck(next, sent, afterRead as unknown as Record<string, unknown>) as Record<string, unknown>;
    for (const { from, to, moved, beforeOwn } of steps) {
      const ops = beforeOwn && again.length ? moved.filter(op => op.op === 'order' || !again.some(path => path.length <= op.path.length && path.every((part, i) => part === op.path[i]))) : moved;
      if (ops.length) next = rebaseWorking(next, from as unknown as Record<string, unknown>, to as unknown as Record<string, unknown>, ops) as Record<string, unknown>;
    }
    // Every fingerprint the server keeps of what invited Agents wrote comes onto the page's documents, its own change's
    // included, which is never carried (agentPages.ts): only the server writes them, so none is the page's to keep out.
    // And the page keeps each of its own of a text the document holds now: an answer may bring a node's fingerprints as
    // the server pruned them before an undo brought their value back.
    if (next === (doc as unknown)) return keepCurrentAgentWritten(doc, keepAgentWritten(afterRead, doc));
    // Read again as the canvas reads every document (a wire whose port went with its node's change goes too); the
    // page's own camera and clock stay its own.
    const read = sanitizeDocument(next);
    return keepCurrentAgentWritten(doc, keepAgentWritten(afterRead, { ...read, view: doc.view, updatedAt: doc.updatedAt }));
  };
  const othersPaths = steps.flatMap(({ moved }) => moved.flatMap(op => op.op === 'order' ? [] : [op.path]));
  if (!steps.length && !sent.length) return { working: doc => doc, history: doc => doc, othersPaths };
  return { working: doc => carry(doc, true), history: doc => steps.length ? carry(doc, false) : doc, othersPaths };
}

/** Whether two documents hold the same canvas, as a change would see it: each person's camera and clock are theirs. */
export function sameCanvasContent(a: unknown, b: unknown): boolean {
  const left = sanitizeDocument(a), right = sanitizeDocument(b);
  return diffDocuments(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>).every(op => sameThreadsAsRead(op, left, right));
}

/** Splits ops into changes of at most MAX_CHANGE_OPS. */
export function changeBatches(ops: readonly CanvasOp[]): CanvasOp[][] {
  const out: CanvasOp[][] = [];
  for (let i = 0; i < ops.length; i += MAX_CHANGE_OPS) out.push(ops.slice(i, i + MAX_CHANGE_OPS));
  return out;
}
