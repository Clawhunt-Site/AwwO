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

export async function submitCloudGraph(operationId: string, scope: readonly string[]): Promise<GraphRunSnapshot> {
  const captured = currentSaaSCanvas();
  if (!captured) throw new GraphNotSubmittedError('Cloud canvas is unavailable');
  let documentVersion: number | void;
  try { documentVersion = await flushSaaSCanvas(); }
  catch (error) { throw new GraphNotSubmittedError(error instanceof Error ? error.message : 'Canvas saving failed'); }
  if (captured !== currentSaaSCanvas()) throw new GraphNotSubmittedError('The active workspace changed before submission');
  if (!Number.isInteger(documentVersion) || Number(documentVersion) < 1) throw new GraphNotSubmittedError('The saved canvas version is unavailable');
  return api<GraphRunSnapshot>(graphPath(captured.tenant.id, captured.canvasId), {
    method: 'POST', body: JSON.stringify({ operationId, scope, documentVersion }),
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
  if (!journal.serverGraph || snapshot.canvasId !== journal.serverGraph.canvasId || snapshot.operationId !== journal.id) {
    throw new Error('Graph run identity does not match the recovery journal');
  }
  const nodes = Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [id, { ...node }]));
  for (const result of snapshot.nodes) {
    const previous = nodes[result.nodeId];
    if (!previous) continue;
    nodes[result.nodeId] = { ...previous, state: result.state,
      ...(typeof result.output === 'string' ? { output: result.output } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.sessionId ? { issueId: result.sessionId } : {}),
    };
  }
  // A terminal graph cannot keep an unobserved node perpetually waiting.
  if (!graphIsActive(snapshot)) for (const node of Object.values(nodes)) {
    if (node.state === 'waiting' || node.state === 'running') {
      node.state = snapshot.status === 'cancelled' ? 'cancelled' : 'blocked';
      node.detail = snapshot.error || snapshot.status;
    }
  }
  return { ...journal, serverGraph: { ...journal.serverGraph, id: snapshot.id }, nodes };
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
  return result;
}
