import { api, tenantPath, SaaSApiError } from './api';
import { currentSaaSCanvas, flushSaaSCanvas } from './canvasBridge';
import type { CanvasDocument } from '../canvas/canvasDoc';
import { runInputFingerprint } from '../canvas/runRecoveryDocument';
import { activeThreadId } from '../canvas/nodeThreads';
import type { CanvasRunJournal } from '../canvas/runJournal';
import type { RunNodeState } from '../canvas/runGraph';

export interface GraphNodeResult {
  nodeId: string;
  state: RunNodeState;
  output?: string;
  detail?: string;
  runId?: string;
  sessionId?: string;
  partial?: boolean;
  phase?: GraphCollaborationPhase;
  round?: number;
}
export type GraphCollaborationPhase = 'proposal' | 'review' | 'synthesis';
export interface GraphCollaborationPolicy { goal: string; rounds: number; synthesizerNodeId: string }
export interface GraphCollaborationTurn {
  ordinal: number;
  nodeId: string;
  phase: GraphCollaborationPhase;
  round: number;
  status: 'waiting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  runId?: string;
  sessionId?: string;
  output?: string;
  error?: string;
}
export interface GraphCollaborationSnapshot extends GraphCollaborationPolicy {
  maxModelCalls: number;
  phase: GraphCollaborationPhase;
  round: number;
  turns: GraphCollaborationTurn[];
}
export interface GraphRunSnapshot {
  id: string;
  operationId: string;
  canvasId: string;
  documentVersion: number;
  document?: CanvasDocument;
  scope: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  nodes: GraphNodeResult[];
  createdAt: string;
  error?: string;
  collaboration?: GraphCollaborationSnapshot | null;
}

const collaborationPhases = new Set(['proposal', 'review', 'synthesis']);
const collaborationStatuses = new Set(['waiting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
/** Validate stored/server metadata without converting malformed collaboration into a plain DAG. */
export function validGraphCollaboration(value: unknown, scope: readonly string[]): value is GraphCollaborationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(scope)) return false;
  const item = value as GraphCollaborationSnapshot;
  if (typeof item.goal !== 'string' || !item.goal.trim() || !Number.isInteger(item.rounds) || item.rounds < 1 || item.rounds > 3
    || scope.length < 2 || scope.length > 6 || new Set(scope).size !== scope.length || !scope.includes(item.synthesizerNodeId)
    || item.maxModelCalls !== 2 * scope.length * item.rounds + 1 || !collaborationPhases.has(item.phase)
    || !Number.isInteger(item.round) || item.round < 0 || item.round > item.rounds
    || !Array.isArray(item.turns) || item.turns.length > item.maxModelCalls) return false;
  const ordinals = new Set<number>();
  const sessions = new Map<string, string>();
  for (const turn of item.turns) {
    if (!turn || typeof turn !== 'object' || !scope.includes(turn.nodeId) || !Number.isInteger(turn.ordinal)
      || turn.ordinal < 1 || turn.ordinal > item.maxModelCalls || ordinals.has(turn.ordinal)
      || !collaborationPhases.has(turn.phase) || !collaborationStatuses.has(turn.status)
      || !Number.isInteger(turn.round) || turn.round < 1 || turn.round > item.rounds
      || ['runId', 'sessionId', 'output', 'error'].some(key => turn[key as keyof GraphCollaborationTurn] !== undefined && typeof turn[key as keyof GraphCollaborationTurn] !== 'string')
      || (['running', 'completed'].includes(turn.status) && !turn.runId)
      || (turn.phase === 'synthesis' && turn.nodeId !== item.synthesizerNodeId)) return false;
    ordinals.add(turn.ordinal);
    if (turn.sessionId) {
      if (sessions.has(turn.nodeId) && sessions.get(turn.nodeId) !== turn.sessionId) return false;
      sessions.set(turn.nodeId, turn.sessionId);
    }
  }
  return true;
}
export interface TeamTurn {
  id: string;
  memberId: string;
  memberName: string;
  role: string;
  round: number;
  ordinal?: number;
  status: string;
  output: string;
  error?: string;
  model?: string;
  runtime?: string;
  createdAt?: string;
  updatedAt?: string;
  config?: { instructions?: string; context?: 'task' | 'shared' } | null;
  prompt?: string | null;
  systemPrompt?: string | null;
  messages?: { role: string; content: string }[] | null;
  context?: TeamTurnContext | null;
}
export interface TeamTurnContext {
  version: 1;
  mode: 'task' | 'shared';
  historyMessages: number;
  historyAvailable: number;
  historyTruncated: boolean;
  upstreamMembers: { memberId: string; memberName: string; round: number; ordinal: number }[];
  upstreamAvailable: number;
  upstreamTruncated: boolean;
  purpose: 'work' | 'aggregate' | 'review' | 'revise';
}
export interface TeamRunRecord {
  id: string;
  tenantId: string;
  status: GraphRunSnapshot['status'];
  error?: string;
}
export const graphIsActive = (snapshot: GraphRunSnapshot) => snapshot.status === 'queued' || snapshot.status === 'running';
export const graphPath = (tenantId: string, canvasId: string) => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/graph-runs`);
export function hasCloudGraphRuntime(): boolean { return currentSaaSCanvas() !== null; }
export class GraphNotSubmittedError extends Error {}
export function graphAdmissionRejected(error: unknown): boolean {
  return error instanceof GraphNotSubmittedError || (error instanceof SaaSApiError && (
    (error.status >= 400 && error.status < 500) || (error.status === 503 && ['runtime_unavailable', 'worker_unavailable', 'database_unavailable'].includes(error.code))
  ));
}

export async function submitCloudGraph(operationId: string, scope: readonly string[], collaboration?: GraphCollaborationPolicy): Promise<GraphRunSnapshot> {
  const captured = currentSaaSCanvas();
  if (!captured) throw new GraphNotSubmittedError('Cloud canvas is unavailable');
  const requestedScope = [...scope];
  const requestedCollaboration = collaboration ? { ...collaboration } : undefined;
  if (requestedCollaboration && !validGraphCollaboration({ ...requestedCollaboration, maxModelCalls: 2 * requestedScope.length * requestedCollaboration.rounds + 1,
    phase: 'proposal', round: 0, turns: [] }, requestedScope)) throw new GraphNotSubmittedError('Invalid collaboration policy or selection');
  let documentVersion: number | void;
  try { documentVersion = await flushSaaSCanvas(); }
  catch (error) { throw new GraphNotSubmittedError(error instanceof Error ? error.message : 'Canvas saving failed'); }
  if (captured !== currentSaaSCanvas()) throw new GraphNotSubmittedError('The active workspace changed before submission');
  if (!Number.isInteger(documentVersion) || Number(documentVersion) < 1) throw new GraphNotSubmittedError('The saved canvas version is unavailable');
  return api<GraphRunSnapshot>(graphPath(captured.tenant.id, captured.canvasId), {
    method: 'POST', body: JSON.stringify({ operationId, scope: requestedScope, documentVersion, ...(requestedCollaboration ? { collaboration: requestedCollaboration } : {}) }),
  });
}

export async function observeCloudGraph(journal: CanvasRunJournal, signal?: AbortSignal): Promise<CanvasRunJournal> {
  const graph = journal.serverGraph;
  if (!graph) return journal;
  if (graph.cancelRequested) {
    const result = await cancelCloudGraph(journal);
    if (result.confirmed && result.status === 'cancelled' && !result.graphId) return { ...journal, nodes: Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [id,
      node.state === 'waiting' || node.state === 'running' ? { ...node, state: 'cancelled' as const, detail: 'cancelled' } : node,
    ])) };
  }
  const base = graphPath(graph.tenantId, graph.canvasId);
  const snapshot = graph.id
    ? await api<GraphRunSnapshot>(`${base}/${encodeURIComponent(graph.id)}`, { signal })
    : (await api<{ items: GraphRunSnapshot[] }>(`${base}?operationId=${encodeURIComponent(journal.id)}`, { signal })).items.find(item => item.operationId === journal.id);
  // A missing response is not proof that an in-flight POST failed. Retain the lock and
  // recover by the same operation identity; observation never submits another model call.
  if (!snapshot) return journal;
  return mergeGraphSnapshot(journal, snapshot);
}

export function mergeGraphSnapshot(journal: CanvasRunJournal, snapshot: GraphRunSnapshot): CanvasRunJournal {
  if (!journal.serverGraph || snapshot.canvasId !== journal.serverGraph.canvasId || snapshot.operationId !== journal.id
    || (journal.serverGraph.id && journal.serverGraph.id !== snapshot.id)) {
    throw new Error('Graph run identity does not match the recovery journal');
  }
  const collaboration = snapshot.collaboration;
  if (collaboration || journal.collaboration) {
    if (!validGraphCollaboration(collaboration, snapshot.scope) || snapshot.scope.length !== journal.scope.length
      || snapshot.scope.some(id => !journal.scope.includes(id))) throw new Error('Collaboration scope or metadata does not match the recovery journal');
    if (journal.collaboration && (collaboration.goal !== journal.collaboration.goal || collaboration.rounds !== journal.collaboration.rounds
      || collaboration.synthesizerNodeId !== journal.collaboration.synthesizerNodeId)) throw new Error('Collaboration policy changed after admission');
    if ((journal.collaboration && (collaboration.round < journal.collaboration.round
      || journal.collaboration.turns.some(old => !collaboration.turns.some(turn => turn.ordinal === old.ordinal))))
      || (journal.serverGraph.status && !['queued', 'running'].includes(journal.serverGraph.status) && snapshot.status !== journal.serverGraph.status)) {
      throw new Error('Collaboration snapshot regressed');
    }
    if (snapshot.document && journal.inputFingerprint?.startsWith('v1:')
      && runInputFingerprint(snapshot.document, journal.scope) !== journal.inputFingerprint) throw new Error('Collaboration document changed after admission');
    for (const turn of collaboration.turns) {
      const previous = journal.collaboration?.turns.find(old => old.ordinal === turn.ordinal);
      const sessionId = journal.nodes[turn.nodeId]?.issueId;
      if ((sessionId && turn.sessionId && sessionId !== turn.sessionId)
        || (previous && (previous.nodeId !== turn.nodeId || previous.phase !== turn.phase || previous.round !== turn.round
          || (previous.runId && previous.runId !== turn.runId) || (previous.sessionId && previous.sessionId !== turn.sessionId)
          || (['completed', 'failed', 'cancelled', 'interrupted'].includes(previous.status) && previous.status !== turn.status)))) {
        throw new Error('Collaboration turn identity changed after admission');
      }
    }
  }
  const nodes = Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [id, { ...node }]));
  for (const result of snapshot.nodes) {
    const previous = nodes[result.nodeId];
    if (!previous) continue;
    if (collaboration && previous.issueId && result.sessionId && previous.issueId !== result.sessionId) throw new Error('Collaboration node Session changed');
    nodes[result.nodeId] = { ...previous, state: result.state,
      ...(typeof result.output === 'string' ? { output: result.output } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.sessionId ? { issueId: result.sessionId } : {}),
      ...(collaboration ? { partial: snapshot.status !== 'completed' || result.partial !== false || result.nodeId !== collaboration.synthesizerNodeId }
        : result.partial !== undefined ? { partial: result.partial } : {}),
      ...(result.phase ? { phase: result.phase } : {}), ...(result.round !== undefined ? { round: result.round } : {}),
    };
  }
  // A terminal graph cannot keep an unobserved node perpetually waiting.
  if (!graphIsActive(snapshot)) for (const node of Object.values(nodes)) {
    if (node.state === 'waiting' || node.state === 'running') {
      node.state = snapshot.status === 'cancelled' ? 'cancelled' : 'blocked';
      node.detail = snapshot.error || snapshot.status;
    }
  }
  return { ...journal, serverGraph: { ...journal.serverGraph, id: snapshot.id, ...(collaboration ? { status: snapshot.status } : {}) }, nodes,
    ...(collaboration ? { collaboration: structuredClone(collaboration) } : {}) };
}

export async function cancelCloudGraph(journal: CanvasRunJournal): Promise<{ confirmed: boolean; graphId?: string; status: string }> {
  const graph = journal.serverGraph;
  if (!graph) throw new Error('Cloud graph identity is unavailable');
  // The server serializes this with admission and records a tombstone for an operation
  // not yet accepted. A delayed POST cannot start work after Stop was confirmed.
  return api(`${graphPath(graph.tenantId, graph.canvasId)}/operations/${encodeURIComponent(journal.id)}/cancel`, { method: 'POST', body: '{}' });
}

/** A different device can attach to an already accepted run without browser-local state. */
export function graphRecoveryJournal(snapshot: GraphRunSnapshot, tenantId: string, current: CanvasDocument): CanvasRunJournal {
  const source = snapshot.document || current;
  const scope = snapshot.scope?.length ? snapshot.scope : snapshot.nodes.filter(n => n.state !== 'cached').map(n => n.nodeId);
  const result: CanvasRunJournal = {
    version: 1, id: snapshot.operationId, startedAt: Date.parse(snapshot.createdAt) || Date.now(), scope,
    inputFingerprint: snapshot.document ? runInputFingerprint(source, scope) : 'unverified-server-document',
    serverGraph: { id: snapshot.id, tenantId, canvasId: snapshot.canvasId },
    nodes: Object.fromEntries(snapshot.nodes.map(item => {
      const node = source.nodes.find(node => node.id === item.nodeId);
      return [item.nodeId, { nodeId: item.nodeId, threadId: node?.kind === 'session' ? activeThreadId(node) : 'form',
        companyId: tenantId, agentId: node?.kind === 'session' ? node.binding?.agentId ?? null : null,
        issueId: item.sessionId || null, runId: item.runId || null, state: item.state,
        ...(typeof item.output === 'string' ? { output: item.output } : {}), ...(item.detail ? { detail: item.detail } : {}) }];
    })),
  };
  return mergeGraphSnapshot(result, snapshot);
}
