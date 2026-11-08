// 多人同屏: what an undo or a redo leaves of others' edits (CanvasSurface's undo and redo).
//
// Others' changes are carried over every undo and redo step (canvasSync.ts rebaseFor), so a step holds them wherever it
// held what they changed. Where it did not, a path the page's own edit had changed, the step still holds the page's
// older value, and going to the step would put it back over theirs. So each step keeps the paths others changed since it
// was taken, and an undo or redo goes to it only outside them: there the canvas keeps what they made it, and says so.

import { sanitizeDocument, type CanvasDocument } from '../canvasDoc';
import { applyOps, diffDocuments, sameValue, valueAt } from './changes';

/** The paths others set or deleted since a step was taken, each once (a drag's many moves of one node count once). */
export type OthersPaths = Map<string, readonly string[]>;

/** `paths` added to `into` (a new set when there is none). */
export function withOthersPaths(into: OthersPaths | undefined, paths: readonly (readonly string[])[]): OthersPaths {
  const next = into ?? new Map<string, readonly string[]>();
  for (const path of paths) next.set(JSON.stringify(path), path);
  return next;
}

const within = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length <= path.length && prefix.every((part, index) => path[index] === part);

/** Whether two paths reach the same place: one is the other, or lies inside it (a field of a node someone added). */
export function pathsMeet(a: readonly string[], b: readonly string[]): boolean {
  return within(a, b) || within(b, a);
}

/** Whether an op of an undo or redo (turning `current` into `target` at `path`) would put something over what someone else
 *  made at `theirs`. At or inside what they changed (their path is the op's or around it), it would. Around what they
 *  changed (the op sets or deletes a whole record or list holding their path): only where the document after it would
 *  hold something else there than it holds now; a record the step brings back (one this page deleted, which the
 *  document no longer holds) carries their changes already, as every step does, so it puts nothing over them. */
function overwrites(current: CanvasDocument, target: CanvasDocument, path: readonly string[], theirs: readonly string[]): boolean {
  if (!pathsMeet(path, theirs)) return false;
  if (theirs.length <= path.length) return true;
  if (valueAt(current, path) === undefined) return false;
  return !sameValue(valueAt(target, theirs), valueAt(current, theirs));
}

/** The document an undo or redo goes to: `target` (the step), less what someone else changed since the step was taken.
 *  Each op that turns `current` into `target` goes, unless it would put something over what one of `others` made
 *  (overwrites), where `current` keeps its value; the order of a list goes either way (it overwrites no one's value).
 *  `kept`: whether any op was held back. */
export function withOthersEdits(current: CanvasDocument, target: CanvasDocument, others: OthersPaths | undefined): { doc: CanvasDocument; kept: boolean } {
  if (!others?.size) return { doc: target, kept: false };
  const theirs = [...others.values()];
  const ops = diffDocuments(current, target);
  const taken = ops.filter(op => op.op === 'order' || !theirs.some(path => overwrites(current, target, op.path, path)));
  if (taken.length === ops.length) return { doc: target, kept: false };
  try {
    const applied = sanitizeDocument(applyOps(current, taken).doc);
    return { doc: { ...applied, view: target.view, updatedAt: target.updatedAt }, kept: true };
  } catch {
    // An op the change engine refuses (none it worked out itself should be): the step as it was.
    return { doc: target, kept: false };
  }
}
