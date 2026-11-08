import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { applyOps } from '../src/canvas/multiplayer/changes';
import { pathsMeet, withOthersEdits, withOthersPaths } from '../src/canvas/multiplayer/history';
import type { CanvasChange, CanvasOp } from '../src/canvas/multiplayer/types';
import { rebaseFor } from '../src/saas/canvasSync';

// 多人同屏: an undo or redo leaves what someone else changed since its step (multiplayer/history.ts, canvasSync.ts).

function canvas(): CanvasDocument {
  const a = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Plan', persona: 'Plans.' };
  const b = { ...createSessionNode('llm', { x: 420, y: 0 }), id: 'b', title: 'Build' };
  return sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [a, b] });
}
const set = (path: string[], value: unknown): CanvasOp => ({ op: 'set', path, value });
const apply = (doc: CanvasDocument, ops: CanvasOp[]) => sanitizeDocument(applyOps(doc, ops).doc);
const node = (doc: CanvasDocument, id: string) => doc.nodes.find(item => item.id === id)! as { title: string; persona?: string; x: number };
const theirs = (version: number, ops: CanvasOp[]): CanvasChange => ({ version, actor: { kind: 'human', name: 'Member', clientId: 'other-page', userId: 'user-other' }, label: 'edit', ops, at: '' });

describe('an undo with others on the canvas', () => {
  it('meets a path at itself, inside it and around it, and nowhere else', () => {
    expect(pathsMeet(['nodes', 'a'], ['nodes', 'a', 'title'])).toBe(true);
    expect(pathsMeet(['nodes', 'a', 'title'], ['nodes', 'a'])).toBe(true);
    expect(pathsMeet(['nodes', 'a', 'title'], ['nodes', 'a', 'title'])).toBe(true);
    expect(pathsMeet(['nodes', 'a', 'title'], ['nodes', 'a', 'persona'])).toBe(false);
    expect(pathsMeet(['nodes', 'a'], ['nodes', 'ab'])).toBe(false);
  });

  it('takes back the page’s own edit but leaves a field someone else changed since', () => {
    const before = canvas();
    // This page renamed a and rewrote its persona; then someone else rewrote the persona again.
    const mine = apply(before, [set(['nodes', 'a', 'title'], 'Plan v2'), set(['nodes', 'a', 'persona'], 'Plans better.')]);
    const now = apply(mine, [set(['nodes', 'a', 'persona'], 'Plans and reviews.')]);
    const others = withOthersPaths(undefined, [['nodes', 'a', 'persona']]);
    const { doc, kept } = withOthersEdits(now, before, others);
    expect(kept).toBe(true);
    expect(node(doc, 'a').title).toBe('Plan');
    expect(node(doc, 'a').persona).toBe('Plans and reviews.');
    // Without others' paths, the step whole, as on a canvas of one.
    expect(withOthersEdits(now, before, undefined)).toEqual({ doc: before, kept: false });
    expect(withOthersEdits(now, before, new Map())).toEqual({ doc: before, kept: false });
  });

  it('keeps a node the page added once someone else changed it, and says nothing when nothing is held back', () => {
    const before = canvas();
    const added = { ...createSessionNode('llm', { x: 900, y: 0 }), id: 'c', title: 'New' };
    const mine = sanitizeDocument({ ...before, nodes: [...before.nodes, added] });
    const moved = apply(mine, [set(['nodes', 'c', 'x'], 1200)]);
    const kept = withOthersEdits(moved, before, withOthersPaths(undefined, [['nodes', 'c', 'x']]));
    expect(kept.kept).toBe(true);
    expect(kept.doc.nodes.map(item => item.id)).toEqual(['a', 'b', 'c']);
    // Someone else's change elsewhere holds nothing back.
    const elsewhere = withOthersEdits(mine, before, withOthersPaths(undefined, [['nodes', 'b', 'title']]));
    expect(elsewhere.kept).toBe(false);
    expect(elsewhere.doc.nodes.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('brings back a node the page deleted, with the edit someone else made in it meanwhile', () => {
    const before = canvas();
    // Someone renamed a before the page's deletion of it reached the server: the step, carried over, holds their title.
    const step = apply(before, [set(['nodes', 'a', 'title'], 'Plan by the member')]);
    const deleted = sanitizeDocument({ ...before, nodes: before.nodes.filter(item => item.id !== 'a') });
    const { doc, kept } = withOthersEdits(deleted, step, withOthersPaths(undefined, [['nodes', 'a', 'title']]));
    expect(kept).toBe(false);
    expect(node(doc, 'a').title).toBe('Plan by the member');
  });

  it('brings back a conversation the page deleted, with someone else’s rename of it, and deletes none they changed', () => {
    const before = canvas();
    const withSecond = (title: string) => sanitizeDocument({ ...before, nodes: before.nodes.map(item => item.id === 'a' && item.kind === 'session'
      ? { ...item, threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1 },
        { id: 't2', title, issueId: null, preview: '', draft: '', createdAt: 2 }] } : item) });
    const others = withOthersPaths(undefined, [['nodes', 'a', 'threads', 't2', 'title']]);
    const without = sanitizeDocument({ ...before, nodes: before.nodes.map(item => item.id === 'a' && item.kind === 'session'
      ? { ...item, threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1 }] } : item) });
    // Undo of the page's deletion of t2, which someone renamed meanwhile: it comes back with their title.
    const back = withOthersEdits(without, withSecond('Their title'), others);
    expect(back.kept).toBe(false);
    expect((back.doc.nodes[0] as { threads?: { id: string; title: string }[] }).threads?.find(thread => thread.id === 't2')?.title).toBe('Their title');
    // Undo of the page's adding t2, which someone renamed since: it stays, as they left it.
    const kept = withOthersEdits(withSecond('Their title'), without, others);
    expect(kept.kept).toBe(true);
    expect((kept.doc.nodes[0] as { threads?: { id: string; title: string }[] }).threads?.find(thread => thread.id === 't2')?.title).toBe('Their title');
  });

  it('counts a path once however often it is changed', () => {
    const paths = withOthersPaths(undefined, [['nodes', 'a', 'x'], ['nodes', 'a', 'y']]);
    expect(withOthersPaths(paths, [['nodes', 'a', 'x'], ['nodes', 'a', 'x']]).size).toBe(2);
  });
});

describe('a rebase names the paths others changed', () => {
  it('lists others’ set and delete paths, not their order ops, and none of the page’s own', () => {
    const before = canvas();
    const ops: CanvasOp[] = [set(['nodes', 'a', 'title'], 'Plan by the member'), { op: 'order', path: ['nodes'], ids: ['b', 'a'] }];
    const after = apply(before, ops);
    expect(rebaseFor({ before, after, changes: [theirs(4, ops)] }).othersPaths).toEqual([['nodes', 'a', 'title']]);
    const own = (change: CanvasChange) => change.actor.clientId === 'this-page';
    const mine: CanvasChange = { ...theirs(4, ops), actor: { ...theirs(4, ops).actor, clientId: 'this-page' } };
    expect(rebaseFor({ before, after, changes: [mine], sent: ops, own }).othersPaths).toEqual([]);
  });
});
