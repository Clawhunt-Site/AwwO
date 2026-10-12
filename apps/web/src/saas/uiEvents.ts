import { api } from './api';

/** Canvas buttons whose presses the hosted API counts for the operator (POST /canvases/{id}/ui-events): the
 * finished-run note's 「看下一步」, 「查看验收报告」 in the next steps, and a question the canvas assistant answered on
 * the page. The server keeps the name, the canvas and who pressed it; nothing the canvas holds is sent. */
export type CanvasUiEvent = 'review.next_steps' | 'review.open_report' | 'assistant.local_answer';

/** Best effort: the press never waits for its count, and an API without the route yet (404) or a lost request is
 * simply not counted. */
export function recordCanvasEvent(tenantId: string, canvasId: string, name: CanvasUiEvent): void {
  void api(`/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}/ui-events`,
    { method: 'POST', body: JSON.stringify({ name }) }).catch(() => {});
}
