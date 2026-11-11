import type { RouteAllowance } from '../saas/routeUsage';
import type { CanvasTranslate } from './i18n';

/** What the assistant's composer says a message costs. Only the hosted app counts calls (countsCalls); there the
 * canvas changes on the operator's model are free up to a daily number the server reports (planner), so the note
 * says how many are left, and without that report it keeps the general wording. unified: the assistant can also run
 * a direct task, which costs up to 16 calls. ended: the free trial is over for this workspace (route-usage
 * freePlan.ended), so it has no calls today and a message starts nothing: the note would promise a cost that cannot
 * be paid, and the canvas's own notice already says a plan is needed. */
export function assistantCostNote(t: CanvasTranslate, countsCalls: boolean, unified: boolean, planner: RouteAllowance | null, ended = false): string | undefined {
  if (!countsCalls || ended) return undefined;
  if (planner && planner.limit > 0) {
    return t(unified ? 'assistant.costNoteUnifiedPlanner' : 'assistant.costNotePlanPlanner',
      { limit: planner.limit, left: Math.max(0, planner.limit - planner.used) });
  }
  return t(unified ? 'assistant.costNoteUnified' : 'assistant.costNotePlan');
}
