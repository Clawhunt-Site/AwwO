import { api, tenantPath, SaaSApiError } from './api';
import { currentSaaSCanvas, flushSaaSCanvas, canvasKnowledgeRevisionIds } from './canvasBridge';
import type { CanvasDocument } from '../canvas/canvasDoc';
import { runInputFingerprint } from '../canvas/runRecoveryDocument';
import { activeThreadId } from '../canvas/nodeThreads';
import type { CanvasRunJournal, CanvasRunJournalNode } from '../canvas/runJournal';
import type { RunNodeState } from '../canvas/runGraph';
import type { RunExecutionMetadata } from './workspaceActivity';

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
  /** Automatic retries after transient failures (the server's graph_retry.go); a waiting node whose detail is
   * `retrying` waits for the next one. */
  attempts?: number;
  /** Each failed attempt the node was retried after, oldest first. */
  attemptLog?: GraphNodeAttempt[];
  /** When the node's current run was admitted and when it settled (null while in flight, or for a node with no run). */
  startedAt?: string | null;
  endedAt?: string | null;
}
export interface GraphNodeAttempt { runId: string; code: string; endedAt: string; attempt: number }
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
  /** When the run last changed; for a finished run, when it ended. */
  updatedAt?: string;
  error?: string;
  collaboration?: GraphCollaborationSnapshot | null;
  /** How many times a node of this graph may run again by itself after a transient failure. */
  nodeRetries?: number;
}
/** A node of a run as the run list reads it: where it stands, not what it made, and its attempts once it has been retried
 *  (a retry takes it from running back to running, with a new run). */
export interface GraphNodeSummary { nodeId: string; state: RunNodeState; attempts?: number }
/** A run as the canvas's run list reads it (GET …/graph-runs): what it is and how it stands, without the canvas it froze
 * at admission or anything its nodes made (a film's frozen canvas alone is a megabyte, and the list holds 50 runs). Its
 * own route reads one run whole (readGraphRun); a GraphRunSnapshot is a summary too. */
export interface GraphRunSummary {
  id: string;
  operationId: string;
  canvasId: string;
  documentVersion: number;
  scope: string[];
  status: GraphRunSnapshot['status'];
  nodes: GraphNodeSummary[];
  createdAt: string;
  updatedAt?: string;
  error?: string;
}

/** A retry count the server sent, or nothing: retries run from 1 to 5. */
const retryCount = (value: unknown): number | undefined => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5 ? Number(value) : undefined;

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
export interface TeamRunRecord extends RunExecutionMetadata {
  id: string;
  tenantId: string;
  status: GraphRunSnapshot['status'];
  error?: string;
}
export const graphIsActive = (snapshot: Pick<GraphRunSummary, 'status'>) => snapshot.status === 'queued' || snapshot.status === 'running';
/** A run as the list sends it, or nothing; a run its own route sent passes too. */
function validGraphRunSummary(raw: unknown): raw is GraphRunSummary {
  if (!raw || typeof raw !== 'object') return false;
  const item = raw as GraphRunSummary;
  return typeof item.id === 'string' && typeof item.status === 'string' && typeof item.createdAt === 'string'
    && (item.updatedAt === undefined || typeof item.updatedAt === 'string') && (item.scope === undefined || Array.isArray(item.scope))
    && Array.isArray(item.nodes) && item.nodes.every(node => node && typeof node === 'object' && typeof node.nodeId === 'string' && typeof node.state === 'string');
}
/** A graph-run list as the server sends it, or nothing: a malformed item never passes as a run. */
export function validGraphRunList(value: unknown): value is { items: GraphRunSummary[] } {
  const items = value && typeof value === 'object' ? (value as { items?: unknown }).items : undefined;
  return Array.isArray(items) && items.every(validGraphRunSummary);
}
/** A run as its own route sends it, or nothing: a summary's fields, and its frozen canvas and collaboration as they must be. */
export function validGraphRun(value: unknown): value is GraphRunSnapshot {
  if (!validGraphRunSummary(value)) return false;
  const item = value as GraphRunSnapshot;
  return (item.document == null || (typeof item.document === 'object' && Array.isArray(item.document.nodes)))
    && (item.collaboration == null || validGraphCollaboration(item.collaboration, item.scope));
}

// The run panel's latest read of a canvas's run list, shared with the views that show it (the 成果 receipt),
// so a canvas page reads the list once per poll, not once per view.
const runFeeds = new Map<string, { items: GraphRunSummary[] | null; listeners: Set<() => void> }>();
const runFeed = (tenantId: string, canvasId: string) => {
  const key = JSON.stringify([tenantId, canvasId]);
  let feed = runFeeds.get(key);
  if (!feed) { feed = { items: null, listeners: new Set() }; runFeeds.set(key, feed); }
  return feed;
};
export function publishGraphRuns(tenantId: string, canvasId: string, items: GraphRunSummary[]): void {
  const feed = runFeed(tenantId, canvasId); feed.items = items;
  for (const listener of [...feed.listeners]) listener();
}
export function latestGraphRuns(tenantId: string, canvasId: string): GraphRunSummary[] | null { return runFeed(tenantId, canvasId).items; }
export function subscribeGraphRuns(tenantId: string, canvasId: string, listener: () => void): () => void {
  const feed = runFeed(tenantId, canvasId); feed.listeners.add(listener);
  return () => { feed.listeners.delete(listener); };
}
export const graphPath = (tenantId: string, canvasId: string) => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/graph-runs`);
/** One run's own route (GET …/graph-runs/{id}): the run whole, or, for a reader that already holds the canvas it froze at
 *  admission, all but that canvas (?document=false). The server writes a run's frozen canvas once, when it admits the
 *  run (graph_runs.go), and a film's is about a megabyte, which the reads again of a run that goes on for hours need not
 *  carry each time. */
const graphRunPath = (tenantId: string, canvasId: string, graphId: string, withoutDocument: boolean) =>
  `${graphPath(tenantId, canvasId)}/${encodeURIComponent(graphId)}${withoutDocument ? '?document=false' : ''}`;
/** One run as its own route reads it: with the canvas it froze at admission and every node's output, which the list
 *  leaves out. A reader that already holds that canvas passes it as `frozen`: the run is then read without it and
 *  carries the one held. */
export async function readGraphRun(tenantId: string, canvasId: string, graphId: string, signal?: AbortSignal, frozen?: CanvasDocument): Promise<GraphRunSnapshot> {
  const run = await api<unknown>(graphRunPath(tenantId, canvasId, graphId, Boolean(frozen)), { signal });
  if (!validGraphRun(run) || run.id !== graphId) throw new Error('Invalid graph run response');
  return frozen ? { ...run, document: frozen } : run;
}
/** What one observer of a cloud graph keeps from one read to the next (observeCloudGraph): the canvas its run froze at
 *  admission, as the run's first read gave it, and the run it belongs to, by workspace, canvas and id. */
export interface GraphObservation { run?: string; document?: CanvasDocument }
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
  const knowledgeRevisionIds = canvasKnowledgeRevisionIds();
  const requestedCollaboration = collaboration ? { ...collaboration } : undefined;
  if (requestedCollaboration && !validGraphCollaboration({ ...requestedCollaboration, maxModelCalls: 2 * requestedScope.length * requestedCollaboration.rounds + 1,
    phase: 'proposal', round: 0, turns: [] }, requestedScope)) throw new GraphNotSubmittedError('Invalid collaboration policy or selection');
  let documentVersion: number | void;
  try { documentVersion = await flushSaaSCanvas(); }
  catch (error) { throw new GraphNotSubmittedError(error instanceof Error ? error.message : 'Canvas saving failed'); }
  if (captured !== currentSaaSCanvas()) throw new GraphNotSubmittedError('The active workspace changed before submission');
  if (!Number.isInteger(documentVersion) || Number(documentVersion) < 1) throw new GraphNotSubmittedError('The saved canvas version is unavailable');
  return api<GraphRunSnapshot>(graphPath(captured.tenant.id, captured.canvasId), {
    method: 'POST', body: JSON.stringify({ operationId, scope: requestedScope, documentVersion, ...(knowledgeRevisionIds.length ? { knowledgeRevisionIds } : {}), ...(requestedCollaboration ? { collaboration: requestedCollaboration } : {}) }),
  });
}

/** One read of the journal's cloud graph, merged into it. An observer that reads it again and again (the canvas's poll,
 *  every 2.5 s while the run goes on: hours, for a film) passes the same `observation` each time: its first read of a
 *  run is whole, and keeps the canvas the run froze at admission; its later reads of that run leave the canvas out
 *  (?document=false) and merge the one kept. That canvas never changes once the run is admitted, so the merge sees what
 *  a whole read would give, and still checks a collaboration's document against its admission and finds a cached
 *  ancestor's node in it. Only a read the merge accepted is kept: until one is, every read of the run is whole, as it
 *  always was; after that, the reads of that run leave the canvas out whatever their outcome, since the canvas they
 *  merge stays the run's. */
export async function observeCloudGraph(journal: CanvasRunJournal, signal?: AbortSignal, observation?: GraphObservation): Promise<CanvasRunJournal> {
  const graph = journal.serverGraph;
  if (!graph) return journal;
  let known = graph.id;
  if (graph.cancelRequested) {
    const result = await cancelCloudGraph(journal);
    if (result.confirmed && result.status === 'cancelled' && !result.graphId) return { ...journal, nodes: Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [id,
      node.state === 'waiting' || node.state === 'running' ? { ...node, state: 'cancelled' as const, detail: 'cancelled' } : node,
    ])) };
    // Stop names the operation's graph when there is one; the snapshot read by it must still be the operation's.
    if (!known && typeof result.graphId === 'string' && result.graphId) known = result.graphId;
  }
  const base = graphPath(graph.tenantId, graph.canvasId);
  // Without the run's id (its POST's response was lost), the list finds it by the operation; the list carries no outputs,
  // so the run is then read by its id, as when the journal knows it.
  const id = known
    || (await api<{ items: GraphRunSummary[] }>(`${base}?operationId=${encodeURIComponent(journal.id)}`, { signal })).items.find(item => item.operationId === journal.id)?.id;
  // A missing response is not proof that an in-flight POST failed. Retain the lock and
  // recover by the same operation identity; observation never submits another model call.
  if (!id) return journal;
  const run = JSON.stringify([graph.tenantId, graph.canvasId, id]);
  const frozen = observation?.run === run ? observation.document : undefined;
  const read = await api<GraphRunSnapshot>(graphRunPath(graph.tenantId, graph.canvasId, id, Boolean(frozen)), { signal });
  const snapshot = frozen ? { ...read, document: frozen } : read;
  const merged = mergeGraphSnapshot(journal, snapshot);
  if (observation && !frozen && snapshot.document) { observation.run = run; observation.document = snapshot.document; }
  return merged;
}

/** A server timestamp as epoch milliseconds, or nothing for a missing or unreadable one. */
function graphTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
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
  const nodes: Record<string, CanvasRunJournalNode> = Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [id, { ...node }]));
  for (const result of snapshot.nodes) {
    let previous = nodes[result.nodeId];
    // The pending journal contains executable nodes only. The server can also confirm that
    // out-of-scope ancestors supplied a published output; show those as cached in the live
    // timeline without adding them to the executable scope or claiming they ran again.
    if (!previous && result.state === 'cached' && !journal.scope.includes(result.nodeId)
      && !snapshot.scope.includes(result.nodeId) && typeof result.output === 'string'
      && result.output.trim() && result.partial !== true) {
      const source = snapshot.document?.nodes.find(node => node.id === result.nodeId);
      if (source && (source.kind !== 'session' || source.binding?.companyId === journal.serverGraph.tenantId)) {
        previous = { nodeId: result.nodeId,
          threadId: source.kind === 'session' ? activeThreadId(source) : 'form',
          companyId: journal.serverGraph.tenantId,
          agentId: source.kind === 'session' ? source.binding?.agentId ?? null : null,
          issueId: null, runId: null, state: 'cached' };
      }
    }
    if (!previous) continue;
    if (collaboration && previous.issueId && result.sessionId && previous.issueId !== result.sessionId) throw new Error('Collaboration node Session changed');
    // A fresh authoritative node snapshot replaces its previous diagnostic too. In particular,
    // a local observer's input-mismatch warning must not survive a later matching server result.
    const { detail: _previousDetail, attempts: _previousAttempts, retryLimit: _previousLimit, ...previousState } = previous;
    // The server's times for the node's current run, which the timeline draws; a node it has none for keeps what it had.
    const startedAt = graphTime(result.startedAt);
    const endedAt = startedAt !== undefined ? graphTime(result.endedAt) : undefined;
    // A node's retries show only while the server reports them, with the limit they count towards.
    const attempts = retryCount(result.attempts);
    const retryLimit = retryCount(snapshot.nodeRetries);
    nodes[result.nodeId] = { ...previousState, state: result.state,
      ...(typeof result.output === 'string' ? { output: result.output } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(attempts ? { attempts, ...(retryLimit ? { retryLimit } : {}) } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.sessionId ? { issueId: result.sessionId } : {}),
      ...(collaboration ? { partial: snapshot.status !== 'completed' || result.partial !== false || result.nodeId !== collaboration.synthesizerNodeId }
        : result.partial !== undefined ? { partial: result.partial } : {}),
      ...(result.phase ? { phase: result.phase } : {}), ...(result.round !== undefined ? { round: result.round } : {}),
      ...(startedAt !== undefined ? { startedAt, ...(endedAt !== undefined && endedAt >= startedAt ? { endedAt } : {}) } : {}),
    };
    if (startedAt !== undefined && (endedAt === undefined || endedAt < startedAt)) delete nodes[result.nodeId].endedAt;
  }
  // A terminal graph cannot keep an unobserved node perpetually waiting.
  if (!graphIsActive(snapshot)) for (const node of Object.values(nodes)) {
    if (node.state === 'waiting' || node.state === 'running') {
      node.state = snapshot.status === 'cancelled' ? 'cancelled' : 'blocked';
      node.detail = snapshot.error || snapshot.status;
    }
  }
  return { ...journal, serverGraph: { ...journal.serverGraph, id: snapshot.id, documentVersion: snapshot.documentVersion, ...(collaboration ? { status: snapshot.status } : {}) }, nodes,
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
