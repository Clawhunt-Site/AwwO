// Who may delete a canvas, as the server judges it (resources.go deleteCanvas, its deleteObject's canvas_not_yours): a
// workspace's owners and admins delete any of its canvases, a member only one they made, and a canvas with no maker
// recorded (made before migration 059 and never logged, or its maker's account deleted) is deleted by owners and admins
// only. The canvas list (CanvasList.tsx), which offers Delete, holds it, saying who may, where the server would refuse.
import type { CanvasRecord } from './api';

/** Why a member's Delete is held: 'maker', someone else made the canvas; 'admins', no maker is recorded. */
export type CanvasDeleteHold = 'maker' | 'admins';

/** Whether the server would refuse this person the canvas's deletion for not being its maker, and why; null where it
 *  would not. Asked for a person who may delete canvases at all (a member or above, in an active workspace). Not known
 *  here (a server older than createdBy, or a page that does not know who reads it): the server decides. */
export function canvasDeleteHold(role: string, userId: string | undefined, canvas: Pick<CanvasRecord, 'createdBy'>): CanvasDeleteHold | null {
  if (role === 'owner' || role === 'admin' || canvas.createdBy === undefined || !userId) return null;
  if (!canvas.createdBy) return 'admins';
  return canvas.createdBy === userId ? null : 'maker';
}

/** Who may delete it, in the page's language: the words of the server's refusal for 'maker'. */
export function canvasDeleteHoldText(hold: CanvasDeleteHold, t: (zh: string, en: string) => string): string {
  return hold === 'maker'
    ? t('只有创建这张画布的人，或工作区的所有者和管理员，能删除它。', 'Only the person who made this canvas, or a workspace owner or admin, can delete it.')
    : t('这张画布没有记下创建者，只有工作区的所有者和管理员能删除它。', 'No maker is recorded for this canvas, so only a workspace owner or admin can delete it.');
}
