import type { CanvasNode } from './canvasDoc';
import { sameValue } from './multiplayer/changes';

// 多人同屏: the Configure panel (InspectorPanel) edits a copy of its node, its draft, while others on the canvas may change
// the node. The panel keeps the node as it last took it in (its base). A field the person has not changed follows the node
// as others change it; a field both changed, to different values, waits for the person to keep theirs or take the other's
// (the panel asks); a save writes only the person's own changes, onto the node as it is then. A field is a key of the node
// (one the panel removes, as a change of kind removes a contract, is a change too); the id and the kind are the node's
// identity, never merged.

const IDENTITY: ReadonlySet<string> = new Set(['id', 'kind']);

const own = (node: object, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(node, key) ? (node as Record<string, unknown>)[key] : undefined;

function fieldsOf(...nodes: object[]): string[] {
  return [...new Set(nodes.flatMap(node => Object.keys(node)))].filter(key => !IDENTITY.has(key));
}

/** The node with `key` holding `value` (none: the key goes), or the same node when it already does. */
function put<T extends CanvasNode>(node: T, key: string, value: unknown): T {
  if (sameValue(own(node, key), value)) return node;
  const next = { ...node } as Record<string, unknown>;
  if (value === undefined) delete next[key]; else next[key] = value;
  return next as T;
}

const sameNode = (a: CanvasNode, b: CanvasNode) => a.id === b.id && a.kind === b.kind;

/** The fields the person has changed: those the draft holds otherwise than the base. */
export function inspectorEdits(draft: CanvasNode, base: CanvasNode): string[] {
  return fieldsOf(draft, base).filter(key => !sameValue(own(draft, key), own(base, key)));
}

export interface InspectorView<T extends CanvasNode = CanvasNode> {
  draft: T;
  base: CanvasNode;
  /** The fields both the person and someone else changed, to different values, that the person has not settled. */
  conflicts: string[];
}

/** Whether a field is still both the person's change and another one: the draft, the base and the node all differ. */
const conflicting = (draft: CanvasNode, base: CanvasNode, live: CanvasNode, key: string) => {
  const mine = own(draft, key), seen = own(base, key), now = own(live, key);
  return !sameValue(mine, seen) && !sameValue(now, seen) && !sameValue(mine, now);
};

/** The panel's open conflicts less those nothing differs in any more (either side went back, or both came to the same). */
export function openConflicts<T extends CanvasNode>(view: InspectorView<T>, live: CanvasNode): InspectorView<T> {
  if (!sameNode(view.draft, live)) return view;
  const conflicts = view.conflicts.filter(key => conflicting(view.draft, view.base, live, key));
  return conflicts.length === view.conflicts.length ? view : { ...view, conflicts };
}

/** The panel once its node is `live`: every field someone else changed since the base follows them where the person has
 *  not changed it, settles where both made the same change, and is a conflict where both changed it otherwise; a
 *  conflict nothing differs in any more closes. */
export function followLiveNode<T extends CanvasNode>(view: InspectorView<T>, live: CanvasNode): InspectorView<T> {
  if (!sameNode(view.draft, live)) return view;
  if (view.base === live) return openConflicts(view, live);
  let { draft, base } = view;
  const open = new Set(view.conflicts);
  for (const key of fieldsOf(view.draft, view.base, live)) {
    const mine = own(view.draft, key), seen = own(view.base, key), now = own(live, key);
    if (sameValue(seen, now)) continue;
    if (sameValue(mine, seen)) { draft = put(draft, key, now); base = put(base, key, now); open.delete(key); }
    else if (sameValue(mine, now)) { base = put(base, key, now); open.delete(key); }
    else open.add(key);
  }
  const conflicts = [...open].filter(key => conflicting(draft, base, live, key));
  const unchanged = draft === view.draft && base === view.base
    && conflicts.length === view.conflicts.length && conflicts.every(key => view.conflicts.includes(key));
  return unchanged ? view : { draft, base, conflicts };
}

/** A conflict settled: `keep` keeps the person's value (to be saved over the other's), else the other's is taken. */
export function settleConflict<T extends CanvasNode>(view: InspectorView<T>, live: CanvasNode, key: string, keep: boolean): InspectorView<T> {
  if (!sameNode(view.draft, live)) return view;
  const now = own(live, key);
  return { draft: keep ? view.draft : put(view.draft, key, now), base: put(view.base, key, now),
    conflicts: view.conflicts.filter(item => item !== key) };
}

/** Whether a save of `saved` (made against `base`) has landed in `live`: the node holds every change it made. */
export function savedInto(saved: CanvasNode, base: CanvasNode, live: CanvasNode): boolean {
  return sameNode(saved, live) && inspectorEdits(saved, base).every(key => sameValue(own(saved, key), own(live, key)));
}

/** The node a save writes: `live` (the node as it is now) with the person's own changes on it, each as the draft holds it
 *  (a key the draft holds as undefined stays, undefined: a save reads that as cleared, inspectorSave.ts). `forced`: fields
 *  written as the draft holds them whether the person changed them or not (what a bind sent with the Agent it hired). */
export function mergeIntoLive<T extends CanvasNode>(draft: T, base: CanvasNode, live: CanvasNode, forced: readonly string[] = []): T {
  if (!sameNode(draft, live)) return draft;
  let merged: Record<string, unknown> | null = null;
  const changed = new Set(inspectorEdits(draft, base));
  for (const key of forced) if (!IDENTITY.has(key) && !sameValue(own(draft, key), own(live, key))) changed.add(key);
  for (const key of changed) {
    merged ??= { ...live };
    if (Object.prototype.hasOwnProperty.call(draft, key)) merged[key] = (draft as unknown as Record<string, unknown>)[key];
    else delete merged[key];
  }
  return (merged ?? live) as T;
}
