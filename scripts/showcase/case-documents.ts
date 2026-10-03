import { PRODUCTION_WORKFLOWS } from '../../apps/web/src/saas/productionWorkflows';
import { createOfficialDocument } from '../../apps/web/src/saas/examples/officialWorkflows';
import type { CanvasDocument } from '../../apps/web/src/canvas/canvasDoc';
import type { UiLocale } from '../../apps/web/src/locale';

/** The canvases a member gets from 「复制这张画布」 with one model chosen for every node, which is
 * also what run-production-cases.mjs runs. Nothing else is bound: no agents, sessions or results. */
export function caseDocuments(locale: UiLocale, runtime: string, model: string): Record<string, { name: string; document: CanvasDocument }> {
  return Object.fromEntries(Object.values(PRODUCTION_WORKFLOWS).map(item => {
    const document = createOfficialDocument(item, locale);
    return [item.id, { name: item.title[locale], document: { ...document, nodes: document.nodes.map(node => node.kind === 'session' ? { ...node, runtime, model, effort: '' } : node) } }];
  }));
}
