import type { CanvasDocument } from '../canvas/canvasDoc';

/** Preserve native graph metadata while refusing to execute it as a SaaS DAG. */
export function unsupportedSaaSGraph(doc: CanvasDocument): boolean {
  return Boolean(doc.execution) || doc.edges.some(edge => edge.kind === 'feedback');
}
