import { describe, expect, it } from 'vitest';
import { advanceConfirmed, changeBatches, heldOps, opNode, rebaseFor, readableConfirmed, sameCanvasContent, unsentOps } from '../src/saas/canvasSync';
import { applyOps, diffDocuments } from '../src/canvas/multiplayer/changes';
import { sanitizeDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { getNodeThreads, updateNodeDraft } from '../src/canvas/nodeThreads';
import type { CanvasChange, CanvasOp } from '../src/canvas/multiplayer/types';

// 多人同屏: a page's confirmed and working documents (src/saas/canvasSync.ts; docs/awwo-canvas-live-collaboration.md).

const session = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'session', agentKind: 'llm', runtime: '', model: '', effort: '', persona: '', binding: null, bindAttempt: null,
  issueId: null, preview: '', title, x: 0, y: 0, w: 340, h: 260, ...extra,
});
const base = () => sanitizeDocument({ version: 2, updatedAt: 1, nodes: [session('a', 'Plan'), session('b', 'Build', { x: 400 })], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } });
const change = (version: number, ops: CanvasOp[], clientId = 'other-page'): CanvasChange => ({ version, actor: { kind: 'human', name: 'Other', clientId }, label: 'edit', ops, at: '2026-11-06T00:00:00Z' });
const set = (path: string[], value: unknown): CanvasOp => ({ op: 'set', path, value });
const title = (doc: CanvasDocument, id: string) => doc.nodes.find(node => node.id === id)?.title;

describe('advancing the confirmed document', () => {
  it('applies the changes after its version in order and skips the ones it has', () => {
    const confirmed = { version: 3, document: base() };
    const out = advanceConfirmed(confirmed, [change(5, [set(['nodes', 'b', 'title'], 'B5')]), change(3, [set(['nodes', 'a', 'title'], 'old')]), change(4, [set(['nodes', 'a', 'title'], 'A4')])]);
    expect(out.gap).toBe(false);
    expect(out.next.version).toBe(5);
    expect(out.applied.map(c => c.version)).toEqual([4, 5]);
    expect(title(out.next.document as CanvasDocument, 'a')).toBe('A4');
    expect(title(out.next.document as CanvasDocument, 'b')).toBe('B5');
  });

  it('stops at a change it cannot apply, and says to read the canvas whole', () => {
    const out = advanceConfirmed({ version: 3, document: base() }, [change(4, [set(['nodes', 'a', 'title'], 'A4')]), change(5, [set(['nodes', 'a', ''], 'x')])]);
    expect(out.unreadable).toBe(true);
    expect(out.gap).toBe(true);
    expect(out.next.version).toBe(4);
    expect(out.applied.map(c => c.version)).toEqual([4]);
  });

  it('stops at a missing change and says so', () => {
    const out = advanceConfirmed({ version: 3, document: base() }, [change(5, [set(['nodes', 'a', 'title'], 'x')])]);
    expect(out.gap).toBe(true);
    expect(out.next.version).toBe(3);
    expect(out.applied).toEqual([]);
  });
});

describe('what a page has not sent', () => {
  it('is nothing for a camera move or a new clock', () => {
    const doc = base();
    expect(unsentOps(doc, { ...doc, view: { x: 50, y: 60, scale: 2 }, updatedAt: 99 })).toEqual([]);
    expect(sameCanvasContent(doc, { ...doc, view: null, updatedAt: 5 })).toBe(true);
  });

  it('is the changed fields only', () => {
    const doc = base();
    const working = { ...doc, nodes: doc.nodes.map(node => node.id === 'a' ? { ...node, title: 'Plan v2' } : node) };
    expect(unsentOps(doc, working)).toEqual([set(['nodes', 'a', 'title'], 'Plan v2')]);
    expect(sameCanvasContent(doc, working)).toBe(false);
  });

  it('leaves out the edits of a held node until its hold ends', () => {
    const doc = base();
    const working = { ...doc, nodes: doc.nodes.map(node => ({ ...node, title: `${node.title}!` })) };
    const held = new Map([['a', 2000]]);
    expect(unsentOps(doc, working, held, 1000).map(op => op.path[1])).toEqual(['b']);
    expect(unsentOps(doc, working, held, 3000).map(op => op.path[1])).toEqual(['a', 'b']);
  });

  it('names the node of an op, a wire by the node it leads into', () => {
    const doc = { ...base(), edges: [{ id: 'e1', fromNode: 'a', fromPort: 'result', toNode: 'b', toPort: 'context', dataType: 'text' as const }] };
    expect(opNode(set(['nodes', 'a', 'x'], 1), doc)).toBe('a');
    expect(opNode({ op: 'del', path: ['edges', 'e1'] }, doc)).toBe('b');
    expect(opNode(set(['edges', 'e2'], { id: 'e2', toNode: 'a' }), doc)).toBe('a');
    expect(opNode(set(['doc', 'execution'], null), doc)).toBeNull();
  });

  it('keeps the ops the server held back', () => {
    const ops = [set(['nodes', 'a', 'title'], 1), set(['nodes', 'b', 'title'], 2), set(['nodes', 'a', 'x'], 3)];
    expect(heldOps(ops, ['ok', 'node_running', 'claimed'])).toEqual([ops[1], ops[2]]);
    expect(heldOps(ops, null)).toEqual([]);
  });

  it('sends no conversations a node only wrote out as they read anyway, and sends a real one', () => {
    const doc = base();
    const a = doc.nodes[0] as SessionNode;
    const written = { ...doc, nodes: doc.nodes.map(node => node.kind === 'session' ? { ...node, threads: getNodeThreads(node) } : node) };
    expect(unsentOps(doc, written)).toEqual([]);
    expect(sameCanvasContent(doc, written)).toBe(true);
    expect(sameCanvasContent(written, doc)).toBe(true);
    const typed = { ...written, nodes: written.nodes.map(node => node.id === 'a' ? updateNodeDraft(node as SessionNode, 'hello') : node) };
    expect(unsentOps(doc, typed).map(op => op.path.join('/'))).toEqual(['nodes/a/threads']);
    expect(sameCanvasContent(doc, typed)).toBe(false);
    expect(a.threads).toBeUndefined();
  });

  it('goes in changes of at most 500 ops', () => {
    const ops = Array.from({ length: 1201 }, (_, i) => set(['nodes', `n${i}`, 'x'], i));
    expect(changeBatches(ops).map(batch => batch.length)).toEqual([500, 500, 201]);
  });
});

describe('the rebase a page applies', () => {
  const mine = (version: number, ops: CanvasOp[]) => change(version, ops, 'this-page');
  const own = (c: CanvasChange) => c.actor.clientId === 'this-page';

  it('takes others’ edits of other fields and keeps its own unsent edit', () => {
    const before = base();
    const after = applyOps(before, [set(['nodes', 'b', 'persona'], 'Write the API'), set(['nodes', 'a', 'x'], 120)]).doc;
    // This page renamed a and has not sent it.
    const working = { ...before, view: { x: 9, y: 9, scale: 1 }, nodes: before.nodes.map(node => node.id === 'a' ? { ...node, title: 'Mine' } : node) };
    const next = rebaseFor({ before, after }).working(working);
    expect(title(next, 'a')).toBe('Mine');
    expect(next.nodes.find(node => node.id === 'a')?.x).toBe(120);
    expect((next.nodes.find(node => node.id === 'b') as { persona?: string }).persona).toBe('Write the API');
    // The camera stays this page's own.
    expect(next.view).toEqual({ x: 9, y: 9, scale: 1 });
    expect(unsentOps(readableConfirmed(after), next)).toEqual([set(['nodes', 'a', 'title'], 'Mine')]);
  });

  it('keeps an unsent edit of the same field over the server’s, until it is sent', () => {
    const before = base();
    const after = applyOps(before, [set(['nodes', 'a', 'title'], 'Theirs')]).doc;
    const working = { ...before, nodes: before.nodes.map(node => node.id === 'a' ? { ...node, title: 'Mine' } : node) };
    expect(title(rebaseFor({ before, after }).working(working), 'a')).toBe('Mine');
  });

  it('takes the server’s value for a path it sent, unless the page changed it again since', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Sent'), set(['nodes', 'b', 'title'], 'Sent b')];
    // The server kept a's as sent and b's as someone else's later write.
    const after = applyOps(before, [set(['nodes', 'a', 'title'], 'Sent'), set(['nodes', 'b', 'title'], 'Later at the server')]).doc;
    const sentAndKept = applyOps(before, sent).doc;
    expect(title(rebaseFor({ before, after, sent }).working(sentAndKept), 'b')).toBe('Later at the server');
    // A page that typed again after sending keeps its newer text.
    const typedAgain = applyOps(sentAndKept, [set(['nodes', 'a', 'title'], 'Typed after')]).doc;
    expect(title(rebaseFor({ before, after, sent }).working(typedAgain), 'a')).toBe('Typed after');
  });

  it('removes a node someone else deleted, edited here or not', () => {
    const before = base();
    const after = applyOps(before, [{ op: 'del', path: ['nodes', 'b'] }]).doc;
    const working = { ...before, nodes: before.nodes.map(node => node.id === 'b' ? { ...node, title: 'edited here' } : node) };
    expect(rebaseFor({ before, after }).working(working).nodes.map(node => node.id)).toEqual(['a']);
  });

  it('carries undo steps the same way, so an undo never takes back another’s edit', () => {
    const before = base();
    const undoStep = { ...before, nodes: before.nodes.map(node => node.id === 'a' ? { ...node, title: 'Older mine' } : node) };
    const after = applyOps(before, [set(['nodes', 'b', 'title'], 'Their B')]).doc;
    const step = rebaseFor({ before, after }).history(undoStep);
    expect(title(step, 'b')).toBe('Their B');
    expect(title(step, 'a')).toBe('Older mine');
  });

  it('returns the same document when nothing moved', () => {
    const doc = base();
    const rebase = rebaseFor({ before: doc, after: doc });
    expect(rebase.working(doc)).toBe(doc);
    expect(rebase.history(doc)).toBe(doc);
  });

  it('agrees with the engine: a page with nothing unsent ends equal to the server', () => {
    const before = base();
    const ops: CanvasOp[] = [set(['nodes', 'c'], session('c', 'New')), { op: 'del', path: ['nodes', 'a'] }, { op: 'order', path: ['nodes'], ids: ['c', 'b'] }];
    const after = applyOps(before, ops).doc;
    const next = rebaseFor({ before, after }).working(before);
    expect(diffDocuments(readableConfirmed(after), next)).toEqual([]);
    expect(next.nodes.map(node => node.id)).toEqual(['c', 'b']);
  });

  // The page's own saved change is never carried onto its undo steps: an undo after a save still takes it back.
  it('lets an undo take back a saved edit', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Mine')];
    const working = applyOps(before, sent).doc;
    const after = applyOps(before, sent).doc;
    const rebase = rebaseFor({ before, after, changes: [mine(3, sent)], sent, own });
    expect(title(rebase.working(working), 'a')).toBe('Mine');
    expect(rebase.history(before)).toBe(before);
  });

  it('keeps a saved new node out of the undo steps, and a saved deletion’s node in them', () => {
    const before = base();
    const sent: CanvasOp[] = [set(['nodes', 'c'], session('c', 'New')), { op: 'del', path: ['nodes', 'b'] }];
    const after = applyOps(before, sent).doc;
    const rebase = rebaseFor({ before, after, changes: [mine(3, sent)], sent, own });
    expect(rebase.history(before).nodes.map(node => node.id)).toEqual(['a', 'b']);
    expect(rebase.working(applyOps(before, sent).doc).nodes.map(node => node.id).sort()).toEqual(['a', 'c']);
  });

  it('keeps an undo pressed while the save was out, unsent', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Mine')];
    const after = applyOps(before, sent).doc;
    // The edit went, then the person pressed undo before the answer came: the page shows the old title again.
    const undone = rebaseFor({ before, after, changes: [mine(3, sent)], sent, own }).working(before);
    expect(title(undone, 'a')).toBe('Plan');
    expect(unsentOps(readableConfirmed(after), undone)).toEqual([set(['nodes', 'a', 'title'], 'Plan')]);
  });

  it('keeps such an undo though someone else’s change of that field reached the server just before the save', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Mine')];
    // Someone else's title and place for a reached the server first; this page's save went over the title.
    const changes = [change(3, [set(['nodes', 'a', 'title'], 'Theirs'), set(['nodes', 'a', 'x'], 55)]), mine(4, sent)];
    const after = advanceConfirmed({ version: 2, document: before }, changes).next.document;
    expect(title(after as CanvasDocument, 'a')).toBe('Mine');
    const rebase = rebaseFor({ before, after, changes, sent, own });
    // The person pressed undo before the answer came (or put the old title back by hand): the page holds the title
    // from before both changes. It is the page's newer edit, not a field never touched: their title, which the
    // save had gone over at the server already, does not come onto it. Their place, which the page never sent, does.
    const undone = rebase.working(before);
    expect(title(undone, 'a')).toBe('Plan');
    expect(undone.nodes.find(node => node.id === 'a')?.x).toBe(55);
    expect(unsentOps(readableConfirmed(after), undone)).toEqual([set(['nodes', 'a', 'title'], 'Plan')]);
    // A page that left the title as it sent it holds what the server holds.
    const kept = rebase.working(applyOps(before, sent).doc);
    expect(diffDocuments(readableConfirmed(after), kept)).toEqual([]);
    // The undo steps take their title as before (an undo after the answer goes by multiplayer/history.ts).
    expect(title(rebase.history(before), 'a')).toBe('Theirs');
    // Their change after the page's own still reaches a title the page has not changed since, and not one it has.
    const later = [mine(3, sent), change(4, [set(['nodes', 'a', 'title'], 'Theirs later')])];
    const afterLater = advanceConfirmed({ version: 2, document: before }, later).next.document;
    const rebaseLater = rebaseFor({ before, after: afterLater, changes: later, sent, own });
    expect(title(rebaseLater.working(applyOps(before, sent).doc), 'a')).toBe('Theirs later');
    expect(title(rebaseLater.working(before), 'a')).toBe('Plan');
  });

  it('lets someone else’s later change into a node this page made and has moved since, and their earlier conversations back over ones it set whole', () => {
    const before = base();
    // A new node, moved again while its save was out; someone renames it after the save.
    const made: CanvasOp[] = [set(['nodes', 'c'], session('c', 'New', { x: 800 }))];
    const changes = [mine(3, made), change(4, [set(['nodes', 'c', 'title'], 'Renamed')])];
    const after = advanceConfirmed({ version: 2, document: before }, changes).next.document;
    const moved = applyOps(applyOps(before, made).doc, [set(['nodes', 'c', 'x'], 900)]).doc;
    const next = rebaseFor({ before, after, changes, sent: made, own }).working(moved);
    expect(title(next, 'c')).toBe('Renamed');
    expect(next.nodes.find(node => node.id === 'c')?.x).toBe(900);
    // Conversations this page set whole and has put back as they were (a draft typed, then cleared): someone else's,
    // which the save went over, come back rather than be lost.
    const thread = getNodeThreads(before.nodes[0] as SessionNode)[0];
    const sent = [set(['nodes', 'a', 'threads'], [{ ...thread, draft: 'My draft' }])];
    const lists = [change(3, [set(['nodes', 'a', 'threads'], [{ ...thread, draft: 'Their draft' }])]), mine(4, sent)];
    const afterLists = advanceConfirmed({ version: 2, document: before }, lists).next.document;
    const back = rebaseFor({ before, after: afterLists, changes: lists, sent, own }).working(before);
    expect((back.nodes[0] as SessionNode).threads?.[0]?.draft).toBe('Their draft');
    // A list of choices (a node's skills) is a field like any other: put back, it stays as this page has it.
    const chosen = [set(['nodes', 'a', 'skills'], ['builtin:mine'])];
    const choices = [change(3, [set(['nodes', 'a', 'skills'], ['builtin:theirs'])]), mine(4, chosen)];
    const afterChoices = advanceConfirmed({ version: 2, document: before }, choices).next.document;
    const unchosen = rebaseFor({ before, after: afterChoices, changes: choices, sent: chosen, own }).working(before);
    expect((unchosen.nodes[0] as { skills?: string[] }).skills).toBeUndefined();
  });

  it('brings a deleted node back with what someone else made of it before the deletion, when the deletion is undone while its save is out', () => {
    const before = base();
    const sent: CanvasOp[] = [{ op: 'del', path: ['nodes', 'b'] }];
    const changes = [change(3, [set(['nodes', 'b', 'title'], 'Their B')]), mine(4, sent)];
    const after = advanceConfirmed({ version: 2, document: before }, changes).next.document;
    // The page deleted b, sent that, and undid it before the answer: it holds b again, as it was.
    const undone = rebaseFor({ before, after, changes, sent, own }).working(before);
    expect(title(undone, 'b')).toBe('Their B');
  });

  it('carries others’ changes on either side of its own, and not its own', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Mine')];
    const changes = [change(3, [set(['nodes', 'b', 'title'], 'Their B')]), mine(4, sent), change(5, [set(['nodes', 'b', 'x'], 777), set(['nodes', 'a', 'x'], 55)])];
    const after = advanceConfirmed({ version: 2, document: before }, changes).next.document;
    const rebase = rebaseFor({ before, after, changes, sent, own });
    const step = rebase.history(before);
    expect(title(step, 'b')).toBe('Their B');
    expect(step.nodes.find(node => node.id === 'b')?.x).toBe(777);
    expect(step.nodes.find(node => node.id === 'a')?.x).toBe(55);
    expect(title(step, 'a')).toBe('Plan');
    const working = rebase.working(applyOps(before, sent).doc);
    expect(diffDocuments(readableConfirmed(after), working)).toEqual([]);
  });

  it('lets someone else’s conversation reach a node whose default one this page only wrote out', () => {
    const before = base();
    const written = { ...before, nodes: before.nodes.map(node => node.kind === 'session' ? { ...node, threads: getNodeThreads(node) } : node) };
    const theirs = [{ ...getNodeThreads(before.nodes[0] as SessionNode)[0], draft: 'Their draft' }];
    const after = applyOps(before, [set(['nodes', 'a', 'threads'], theirs)]).doc;
    const next = rebaseFor({ before, after }).working(written);
    expect((next.nodes[0] as SessionNode).threads?.[0]?.draft).toBe('Their draft');
    expect(unsentOps(readableConfirmed(after), next)).toEqual([]);
  });

  it('lets a node someone else deleted go from a document read whole, though this page sent a field of it', () => {
    const before = base();
    const sent = [set(['nodes', 'b', 'title'], 'Mine')];
    const after = applyOps(before, [{ op: 'del', path: ['nodes', 'b'] }]).doc;
    const rebase = rebaseFor({ before, after, sent });
    expect(rebase.working(applyOps(before, sent).doc).nodes.map(node => node.id)).toEqual(['a']);
    expect(rebase.history(before).nodes.map(node => node.id)).toEqual(['a']);
  });

  it('leaves the places it sent out of a document read whole', () => {
    const before = base();
    const sent = [set(['nodes', 'a', 'title'], 'Mine')];
    const after = applyOps(before, [...sent, set(['nodes', 'b', 'title'], 'Theirs')]).doc;
    const rebase = rebaseFor({ before, after, sent });
    const step = rebase.history(before);
    expect(title(step, 'a')).toBe('Plan');
    expect(title(step, 'b')).toBe('Theirs');
    expect(title(rebase.working(applyOps(before, sent).doc), 'b')).toBe('Theirs');
  });
});
