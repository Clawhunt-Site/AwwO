import type { GraphRunSnapshot, GraphRunSummary } from '../src/saas/graphRuns';

/** A run as the run list sends it (graphSummaryJSON in backend/internal/app/graph_runs.go): without the canvas it froze,
 *  any node's output or a collaboration, each node by its id and state, and its attempts once retried. The run's own
 *  route sends it whole. */
export function graphRunSummary(run: GraphRunSnapshot): GraphRunSummary {
  return { id: run.id, operationId: run.operationId, canvasId: run.canvasId, documentVersion: run.documentVersion, scope: run.scope,
    status: run.status, error: run.error ?? '', createdAt: run.createdAt, ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
    nodes: run.nodes.map(({ nodeId, state, attempts }) => ({ nodeId, state, ...(attempts ? { attempts } : {}) })) };
}
