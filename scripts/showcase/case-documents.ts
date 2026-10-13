import { PRODUCTION_WORKFLOWS } from '../../apps/web/src/saas/productionWorkflows';
import { createOfficialDocument } from '../../apps/web/src/saas/examples/officialWorkflows';
import type { CanvasDocument } from '../../apps/web/src/canvas/canvasDoc';

/** The canvases behind “Copy this canvas” with one model chosen for every node, which is what
 * run-production-cases.mjs runs. Nothing else is bound: no agents, sessions or results. (A member's
 * copy also carries the case's recorded deliveries, productionCopy.ts; a recording run starts without them.) */
export function caseDocuments(runtime: string, model: string): Record<string, { name: string; document: CanvasDocument }> {
  return Object.fromEntries(Object.values(PRODUCTION_WORKFLOWS).map(item => {
    const document = createOfficialDocument(item);
    return [item.id, { name: item.title, document: { ...document, nodes: document.nodes.map(node => node.kind === 'session' ? { ...node, runtime, model, effort: '' } : node) } }];
  }));
}
