import { API_BASE, api, SaaSApiError, tenantPath } from './api';
import { graphPath, graphIsActive, validGraphCollaboration, type GraphRunSnapshot } from './graphRuns';
import { readRunEvidence, readRunInvocations, type RunEvidenceSummary, type RunInvocation } from './runEvidenceApi';

export const GRAPH_EVIDENCE_LIMITS = Object.freeze({ concurrency: 2, maxRuns: 200, maxPagesPerRun: 10,
  pageSize: 100, maxInvocations: 5000, maxBytes: 16 * 1024 * 1024, timeoutMs: 120000 });
export type GraphEvidenceScope = { tenantId: string; canvasId: string; graphId: string };
type ExportIssue = { stage: string; code: string; runId?: string; status?: number };
type RunReference = { runId: string; nodeIds: string[]; sessionIds: string[]; collaborationTurns: number[] };
export type GraphEvidenceRun = RunReference & {
  record: Record<string, unknown> | null; evidence: RunEvidenceSummary | null;
  invocations: { items: RunInvocation[]; pagesRead: number; nextCursor: string | null; complete: boolean };
  archiveURL: string; complete: boolean; errors: ExportIssue[];
};
export interface GraphEvidenceBundle {
  schemaVersion: 1; format: 'awwo-graph-evidence-v1'; exportedAt: string; startedAt: string;
  scope: GraphEvidenceScope; graph: GraphRunSnapshot | null;
  graphObservation: { id: string; canvasId: string; status: string; documentVersion: number; observedAt: string };
  graphAfterRead: { status: string; observedAt: string } | null;
  runs: GraphEvidenceRun[]; errors: ExportIssue[]; limits: typeof GRAPH_EVIDENCE_LIMITS;
  completeness: { complete: boolean; status: 'complete' | 'partial' | 'in-progress'; inProgress: boolean;
    graphStable: boolean; omittedRunIds: string[]; boundsReached: string[]; nodesWithoutRunIds: string[] };
  coverage: { runEvents: 'references-only'; artifactBodies: 'not-included'; teamTurns: 'not-included';
    atomicSnapshot: false; manualAcceptance: 'not-assessed'; redacted: false };
}
const states = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const nodeStates = new Set(['idle', 'waiting', 'running', 'done', 'failed', 'blocked', 'cancelled', 'cached']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const invalid = (code = 'invalid_graph_evidence') => new SaaSApiError(502, code, 'The graph evidence response does not match this graph.');

function validateGraph(value: unknown, scope: GraphEvidenceScope): GraphRunSnapshot {
  if (!object(value) || value.id !== scope.graphId || value.canvasId !== scope.canvasId
    || (value.tenantId !== undefined && value.tenantId !== scope.tenantId) || !identity(value.operationId)
    || !Number.isSafeInteger(value.documentVersion) || Number(value.documentVersion) < 1 || !states.has(String(value.status))
    || !Array.isArray(value.nodes) || value.nodes.length > 200 || !Array.isArray(value.scope)
    || !value.scope.every(identity) || new Set(value.scope).size !== value.scope.length
    || value.nodes.some(node => !object(node) || !identity(node.nodeId) || !nodeStates.has(String(node.state))
      || (node.runId != null && !identity(node.runId)) || (node.sessionId != null && !identity(node.sessionId)))
    || new Set(value.nodes.map(node => node.nodeId)).size !== value.nodes.length) throw invalid();
  const nodes = value.nodes as Record<string, unknown>[];
  if (value.scope.some(id => !nodes.some(node => node.nodeId === id))) throw invalid();
  if (value.document !== undefined) {
    if (!object(value.document) || value.document.version !== 2 || !Array.isArray(value.document.nodes) || !Array.isArray(value.document.edges)
      || value.document.nodes.some(node => !object(node) || !identity(node.id)
        || (object(node.binding) && node.binding.companyId && node.binding.companyId !== scope.tenantId))
      || value.nodes.some(node => !(value.document as { nodes: { id: string }[] }).nodes.some(source => source.id === node.nodeId))) throw invalid();
  }
  if (value.collaboration != null && !validGraphCollaboration(value.collaboration, value.scope)) throw invalid();
  return value as unknown as GraphRunSnapshot;
}
function references(graph: GraphRunSnapshot): RunReference[] {
  const refs = new Map<string, RunReference>();
  const add = (runId: string | undefined, nodeId: string, sessionId?: string, ordinal?: number) => {
    if (!runId) return;
    const ref = refs.get(runId) || { runId, nodeIds: [], sessionIds: [], collaborationTurns: [] };
    if (!ref.nodeIds.includes(nodeId)) ref.nodeIds.push(nodeId);
    if (sessionId && !ref.sessionIds.includes(sessionId)) ref.sessionIds.push(sessionId);
    if (ordinal !== undefined) ref.collaborationTurns.push(ordinal);
    if (ref.nodeIds.length > 1 || ref.sessionIds.length > 1) throw invalid('inconsistent_graph_run_binding');
    refs.set(runId, ref);
  };
  graph.nodes.forEach(node => add(node.runId, node.nodeId, node.sessionId));
  graph.collaboration?.turns.forEach(turn => add(turn.runId, turn.nodeId, turn.sessionId, turn.ordinal));
  return [...refs.values()];
}

/** Read only the selected authorized graph. Two serial collectors cap total concurrent GETs at two.
 * Separate endpoint observations are not a database transaction; active/changed snapshots stay partial.
 * This is an owner-readable data export, not a redacted public sharing artifact. */
export async function collectGraphEvidence(scope: GraphEvidenceScope, signal: AbortSignal): Promise<GraphEvidenceBundle> {
  if (!Object.values(scope).every(identity)) throw invalid();
  signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), GRAPH_EVIDENCE_LIMITS.timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  let accessFailure: SaaSApiError | undefined;
  const assertActive = () => { signal.throwIfAborted(); if (accessFailure) throw accessFailure; };
  const issue = (cause: unknown, stage: string, runId?: string): ExportIssue => {
    assertActive();
    // An explicit authorization loss never produces a file containing earlier observations.
    if (cause instanceof SaaSApiError && ([401, 403].includes(cause.status)
      // Membership revocation is intentionally indistinguishable from a missing graph.
      || (stage === 'graph_recheck' && cause.status === 404))) {
      accessFailure = cause; deadline.abort(); throw cause;
    }
    return { stage, ...(runId ? { runId } : {}), code: deadline.signal.aborted ? 'export_timeout'
      : cause instanceof SaaSApiError && /^[a-z0-9_]{1,80}$/.test(cause.code) ? cause.code : 'request_failed',
      ...(cause instanceof SaaSApiError ? { status: cause.status } : {}) };
  };
  try {
    const path = `${graphPath(scope.tenantId, scope.canvasId)}/${encodeURIComponent(scope.graphId)}`;
    const graph = validateGraph(await api<unknown>(path, { signal: requestSignal }), scope);
    assertActive();
    const refs = references(graph);
    const bundle: GraphEvidenceBundle = {
      schemaVersion: 1, format: 'awwo-graph-evidence-v1', startedAt, exportedAt: '', scope: { ...scope }, graph,
      graphObservation: { id: graph.id, canvasId: graph.canvasId, status: graph.status,
        documentVersion: graph.documentVersion, observedAt: new Date().toISOString() }, graphAfterRead: null,
      runs: [], errors: [], limits: GRAPH_EVIDENCE_LIMITS,
      completeness: { complete: false, status: 'partial', inProgress: graphIsActive(graph), graphStable: false,
        omittedRunIds: refs.slice(GRAPH_EVIDENCE_LIMITS.maxRuns).map(ref => ref.runId), boundsReached: [],
        nodesWithoutRunIds: graph.nodes.filter(node => !node.runId).map(node => node.nodeId) },
      coverage: { runEvents: 'references-only', artifactBodies: 'not-included', teamTurns: 'not-included',
        atomicSnapshot: false, manualAcceptance: 'not-assessed', redacted: false },
    };
    let remainingBytes = GRAPH_EVIDENCE_LIMITS.maxBytes - 1024 * 1024;
    let invocationCount = 0;
    const retain = (value: unknown, stage: string, runId?: string) => {
      const bytes = byteSize(value);
      if (bytes <= remainingBytes) { remainingBytes -= bytes; return true; }
      if (!bundle.completeness.boundsReached.includes('maxBytes')) bundle.completeness.boundsReached.push('maxBytes');
      bundle.errors.push({ stage, code: 'export_byte_limit', ...(runId ? { runId } : {}) });
      return false;
    };
    if (!retain(graph, 'graph')) bundle.graph = null;
    if (!graph.document) bundle.errors.push({ stage: 'graph', code: 'frozen_document_missing' });
    if (bundle.completeness.omittedRunIds.length) bundle.completeness.boundsReached.push('maxRuns');
    let next = 0;
    const selected = refs.slice(0, GRAPH_EVIDENCE_LIMITS.maxRuns);
    const results: (GraphEvidenceRun | undefined)[] = new Array(selected.length);
    const collect = async () => {
      while (next < selected.length) {
        assertActive();
        const index = next++, ref = selected[index];
        const base = tenantPath(scope.tenantId, `/runs/${encodeURIComponent(ref.runId)}`);
        const result: GraphEvidenceRun = { ...ref, record: null, evidence: null, complete: false, errors: [],
          invocations: { items: [], pagesRead: 0, nextCursor: null, complete: false }, archiveURL: `${API_BASE}${base}/archive` };
        results[index] = result;
        if (deadline.signal.aborted) { result.errors.push({ stage: 'run', code: 'export_timeout', runId: ref.runId }); continue; }
        try {
          const record = await api<unknown>(base, { signal: requestSignal });
          assertActive();
          if (!object(record) || record.id !== ref.runId || record.tenantId !== scope.tenantId || !states.has(String(record.status))
            || !identity(record.sessionId) || ref.sessionIds.some(id => id !== record.sessionId)) throw invalid('invalid_run_binding');
          if (retain(record, 'run', ref.runId)) result.record = record;
          if (record.status === 'running' || record.status === 'queued') bundle.completeness.inProgress = true;
        } catch (cause) { result.errors.push(issue(cause, 'run', ref.runId)); continue; }
        try {
          const evidence = await readRunEvidence(scope.tenantId, ref.runId, requestSignal);
          assertActive();
          if (retain(evidence, 'evidence', ref.runId)) result.evidence = evidence;
          if (evidence.status === 'running' || evidence.status === 'queued') bundle.completeness.inProgress = true;
          if (result.record && evidence.status !== result.record.status) result.errors.push({ stage: 'evidence', code: 'run_changed_during_export', runId: ref.runId });
        } catch (cause) { result.errors.push(issue(cause, 'evidence', ref.runId)); }
        const cursors = new Set<string>();
        const ids = new Set<string>();
        try {
          for (let pageIndex = 0; pageIndex < GRAPH_EVIDENCE_LIMITS.maxPagesPerRun; pageIndex++) {
            assertActive();
            if (invocationCount >= GRAPH_EVIDENCE_LIMITS.maxInvocations) {
              bundle.completeness.boundsReached.push('maxInvocations');
              result.errors.push({ stage: 'invocations', code: 'invocation_limit', runId: ref.runId }); break;
            }
            const page = await readRunInvocations(scope.tenantId, ref.runId, requestSignal, result.invocations.nextCursor || undefined);
            assertActive();
            result.invocations.pagesRead++;
            result.invocations.nextCursor = page.page.nextCursor;
            if (page.items.some(item => ids.has(item.id)) || (page.page.nextCursor && cursors.has(page.page.nextCursor))) throw invalid('repeated_invocation_page');
            const room = GRAPH_EVIDENCE_LIMITS.maxInvocations - invocationCount;
            const retained = page.items.slice(0, room);
            if (!retain(retained, 'invocations', ref.runId)) break;
            result.invocations.items.push(...retained); invocationCount += retained.length;
            retained.forEach(item => ids.add(item.id));
            if (retained.some(item => item.status === 'queued' || item.status === 'running')) bundle.completeness.inProgress = true;
            if (retained.length !== page.items.length) {
              bundle.completeness.boundsReached.push('maxInvocations');
              result.errors.push({ stage: 'invocations', code: 'invocation_limit', runId: ref.runId }); break;
            }
            if (!page.page.nextCursor) { result.invocations.complete = true; break; }
            cursors.add(page.page.nextCursor);
            if (pageIndex + 1 === GRAPH_EVIDENCE_LIMITS.maxPagesPerRun) {
              bundle.completeness.boundsReached.push('maxPagesPerRun');
              result.errors.push({ stage: 'invocations', code: 'invocation_page_limit', runId: ref.runId });
            }
          }
        } catch (cause) { result.errors.push(issue(cause, 'invocations', ref.runId)); }
        result.complete = !!result.record && !!result.evidence && result.invocations.complete && !result.errors.length;
      }
    };
    // allSettled lets both collectors stop before returning an authorization/abort failure.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(GRAPH_EVIDENCE_LIMITS.concurrency, selected.length) }, collect));
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    assertActive();
    bundle.runs = results.filter((result): result is GraphEvidenceRun => !!result);
    bundle.errors.push(...bundle.runs.flatMap(run => run.errors));
    try {
      const after = validateGraph(await api<unknown>(path, { signal: requestSignal }), scope);
      assertActive();
      bundle.graphAfterRead = { status: after.status, observedAt: new Date().toISOString() };
      bundle.completeness.graphStable = JSON.stringify(after) === JSON.stringify(graph);
      if (graphIsActive(after)) bundle.completeness.inProgress = true;
      if (!bundle.completeness.graphStable) bundle.errors.push({ stage: 'graph_recheck', code: 'graph_changed_during_export' });
    } catch (cause) { bundle.errors.push(issue(cause, 'graph_recheck')); }
    bundle.completeness.boundsReached = [...new Set(bundle.completeness.boundsReached)];
    bundle.completeness.complete = !!bundle.graph && !bundle.completeness.inProgress && bundle.completeness.graphStable
      && !bundle.errors.length && !bundle.completeness.omittedRunIds.length && !bundle.completeness.boundsReached.length
      && bundle.runs.length === refs.length && bundle.runs.every(run => run.complete);
    bundle.completeness.status = bundle.completeness.inProgress ? 'in-progress' : bundle.completeness.complete ? 'complete' : 'partial';
    bundle.exportedAt = new Date().toISOString();
    if (byteSize(bundle) > GRAPH_EVIDENCE_LIMITS.maxBytes) throw new SaaSApiError(413, 'graph_export_too_large', 'Graph evidence exceeds the download limit.');
    return bundle;
  } finally { clearTimeout(timer); }
}

export function downloadGraphEvidence(bundle: GraphEvidenceBundle): void {
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `awwo-graph-${bundle.scope.graphId.replace(/[^a-zA-Z0-9._-]/g, '_')}-evidence.json`;
  anchor.hidden = true; document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
