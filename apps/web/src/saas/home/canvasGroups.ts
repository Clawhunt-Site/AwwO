// 我的画布 sorts a workspace's canvases by when each was last changed, in the reader's own time: 今天, the six days
// before it (最近 7 天 counts today), and everything older. The list carries no kind or owner to sort by (the summary
// view's outline only), so the time a canvas was touched is the one order every canvas has.

export type CanvasGroupId = 'today' | 'week' | 'earlier';
export const CANVAS_GROUPS: ReadonlyArray<CanvasGroupId> = ['today', 'week', 'earlier'];

/** The group of a moment: from local midnight on (a clock ahead of this one's too) today; from the local midnight six
 *  days before, the week; older, or a time that does not read, earlier. */
export function canvasGroupOf(updatedAt: string, now: Date): CanvasGroupId {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 'earlier';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= today) return 'today';
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  return at >= week ? 'week' : 'earlier';
}

/** The groups that hold a canvas, in CANVAS_GROUPS order, each keeping the order its canvases came in. */
export function groupCanvases<T extends { updatedAt: string }>(items: ReadonlyArray<T>, now: Date): Array<{ id: CanvasGroupId; items: T[] }> {
  const groups = new Map<CanvasGroupId, T[]>(CANVAS_GROUPS.map(id => [id, []]));
  for (const item of items) groups.get(canvasGroupOf(item.updatedAt, now))!.push(item);
  return CANVAS_GROUPS.map(id => ({ id, items: groups.get(id)! })).filter(group => group.items.length > 0);
}
