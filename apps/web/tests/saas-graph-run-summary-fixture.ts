import type { GraphRunSnapshot, GraphRunSummary } from '../src/saas/graphRuns';

/** A run as the run list sends it (graphSummaryJSON in backend/internal/app/graph_runs.go): without the canvas it froze,
 *  any node's output or a collaboration, each node by its id and state, and its attempts once retried. The run's own
 *  route sends it whole. */
export function graphRunSummary(run: GraphRunSnapshot): GraphRunSummary {
  return { id: run.id, operationId: run.operationId, canvasId: run.canvasId, documentVersion: run.documentVersion, scope: run.scope,
    status: run.status, error: run.error ?? '', createdAt: run.createdAt, ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
    nodes: run.nodes.map(({ nodeId, state, attempts }) => ({ nodeId, state, ...(attempts ? { attempts } : {}) })) };
}

/** A run as its own route sends it with ?document=false (graphRunJSON in graph_runs.go): everything but the canvas it
 *  froze at admission. */
export function graphRunWithoutDocument(run: GraphRunSnapshot): Omit<GraphRunSnapshot, 'document'> {
  const { document: _frozen, ...rest } = run;
  return rest;
}
