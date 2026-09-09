import { canvasStorage } from './canvasStorage';
import { canvasFetch } from '../saas/canvasBridge';
import type { RunNodeState, RunNodeStatus } from './runGraph';
import { validateNodeOutput, type RunSummary } from './runGraph';
import type { CanvasNode } from './canvasDoc';
import { fetchConversationOperation } from '../canvasAgentChat';
import { observeCloudGraph } from '../saas/graphRuns';

export const CANVAS_RUN_JOURNAL_KEY = 'awwo.canvas.active-run.v1';

export interface CanvasRunJournalNode {
  nodeId: string;
  threadId: string;
  companyId: string | null;
  agentId: string | null;
  issueId: string | null;
  runId: string | null;
  /** Present for new runs; absent on pre-upgrade journals. */
  operationId?: string | null;
  state: RunNodeState;
  detail?: string;
  output?: string;
}

export interface CanvasRunJournal {
  version: 1;
  id: string;
  startedAt: number;
  scope: string[];
  inputFingerprint?: string;
  /** Accepted cloud graphs continue scheduling while all observers are detached. */
  serverGraph?: { id?: string; tenantId: string; canvasId: string; cancelRequested?: boolean };
  /** Manual replies remain transcript evidence until explicitly published. */
  manual?: boolean;
  /** Exact operator turn needed to reconstruct a detached manual conversation. */
  manualMessage?: string;
  /** Review rounds never imply convergence until the gate verdict has been checked. */
  review?: {
    round: number;
    maxRounds: number;
    outcome: 'running' | 'approved' | 'exhausted' | 'failed' | 'cancelled' | 'interrupted';
    turns: Array<CanvasRunJournalNode & { round: number }>;
  };
  nodes: Record<string, CanvasRunJournalNode>;
}

const states = new Set<RunNodeState>(['waiting', 'running', 'done', 'failed', 'blocked', 'cancelled', 'cached']);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** Invalid/torn storage never becomes an active lock. */
export function loadRunJournal(storage: Pick<Storage, 'getItem'> = canvasStorage()): CanvasRunJournal | null {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(CANVAS_RUN_JOURNAL_KEY) || 'null'); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !text(value.id) || !Number.isFinite(value.startedAt) || !Array.isArray(value.scope) || !value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) return null;
  const scope = value.scope.filter((id): id is string => Boolean(text(id)));
  const nodes: Record<string, CanvasRunJournalNode> = Object.create(null);
  for (const [key, candidate] of Object.entries(value.nodes as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    const nodeId = text(item.nodeId);
    const threadId = text(item.threadId);
    if (!nodeId || nodeId !== key || !threadId || typeof item.state !== 'string' || !states.has(item.state as RunNodeState)) return null;
    nodes[key] = {
      nodeId, threadId,
      companyId: text(item.companyId), agentId: text(item.agentId), issueId: text(item.issueId), runId: text(item.runId),
      ...(text(item.operationId) ? { operationId: text(item.operationId) } : {}),
      state: item.state as RunNodeState,
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      ...(typeof item.output === 'string' ? { output: item.output } : {}),
    };
  }
  if (!scope.length || scope.length > 1000 || scope.some(id => !Object.hasOwn(nodes, id))) return null;
  const graph = value.serverGraph as Record<string, unknown> | undefined;
  if (graph && (!text(graph.tenantId) || !text(graph.canvasId) || (graph.id !== undefined && !text(graph.id)))) return null;
  let review: CanvasRunJournal['review'];
  if (value.review !== undefined) {
    const r = value.review as NonNullable<CanvasRunJournal['review']>;
    if (!r || !Number.isInteger(r.round) || r.round < 0 || r.round > 5
      || !Number.isInteger(r.maxRounds) || r.maxRounds < 1 || r.maxRounds > 5 || r.round > r.maxRounds
      || !['running', 'approved', 'exhausted', 'failed', 'cancelled', 'interrupted'].includes(r.outcome)
      || !Array.isArray(r.turns) || r.turns.length > 5000
      || r.turns.some(turn => !turn || !text(turn.nodeId) || !text(turn.threadId)
        || !Number.isInteger(turn.round) || turn.round < 1 || turn.round > r.round
        || !states.has(turn.state) || ['waiting', 'running'].includes(turn.state))) return null;
    review = r;
  }
  return { version: 1, id: text(value.id)!, startedAt: Number(value.startedAt), scope, nodes, ...(review ? { review } : {}),
    ...(graph ? { serverGraph: { tenantId: String(graph.tenantId), canvasId: String(graph.canvasId), ...(graph.id ? { id: String(graph.id) } : {}), ...(graph.cancelRequested === true ? { cancelRequested: true } : {}) } } : {}),
    ...(typeof value.inputFingerprint === 'string' ? { inputFingerprint: value.inputFingerprint } : {}), ...(value.manual === true ? { manual: true } : {}), ...(value.manual === true && text(value.manualMessage) ? { manualMessage: String(value.manualMessage) } : {}) };
}

export function saveRunJournal(journal: CanvasRunJournal, storage: Pick<Storage, 'setItem'> = canvasStorage()): boolean {
  try { storage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal)); return true; } catch { return false; }
}

type JournalClearStorage = Pick<Storage, 'removeItem'> & Partial<Pick<Storage, 'getItem'>>;

/** Delete only the journal the caller finished. Passing an expected id prevents a stale tab or
 * recovery callback from clearing a newer run. Existing `clearRunJournal(storage)` calls remain
 * supported; `clearRunJournal(expectedId)` uses canvasStorage(). */
export function clearRunJournal(storageOrExpected: JournalClearStorage | string = canvasStorage(), expectedId?: string): boolean {
  const storage = typeof storageOrExpected === 'string' ? canvasStorage() : storageOrExpected;
  const expected = typeof storageOrExpected === 'string' ? storageOrExpected : expectedId;
  try {
    if (expected) {
      if (!storage.getItem) return false;
      const raw = JSON.parse(storage.getItem(CANVAS_RUN_JOURNAL_KEY) || 'null') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { id?: unknown }).id !== expected) return false;
    }
    storage.removeItem(CANVAS_RUN_JOURNAL_KEY);
    return true;
  } catch {
    return false; // unavailable/torn storage stays fail-closed in memory
  }
}

export function patchRunJournalNode(
  journal: CanvasRunJournal,
  nodeId: string,
  patch: Partial<CanvasRunJournalNode> | RunNodeStatus,
): CanvasRunJournal {
  const current = journal.nodes[nodeId];
  if (!current) return journal;
  return { ...journal, nodes: { ...journal.nodes, [nodeId]: { ...current, ...patch, nodeId } } };
}

export function journalSummary(journal: CanvasRunJournal): RunSummary {
  const scoped = journal.scope.map(id => journal.nodes[id]).filter(Boolean);
  const count = (state: RunNodeState) => scoped.filter(node => node.state === state).length;
  return { ok: count('done') === scoped.length && (!journal.review || journal.review.outcome === 'approved'), done: count('done'), failed: count('failed'), blocked: count('blocked'), cancelled: count('cancelled'), cached: Object.values(journal.nodes).filter(n => n.state === 'cached').length, total: scoped.length,
    ...(journal.review ? { review: { rounds: journal.review.round, outcome: journal.review.outcome === 'running' ? 'interrupted' as const : journal.review.outcome } } : {}) };
}

/** One read-only recovery pass. A missing identity or network failure always keeps the lock. */
export async function reconcileRunJournal(journal: CanvasRunJournal, nodes: ReadonlyArray<CanvasNode>, base: string, signal?: AbortSignal): Promise<CanvasRunJournal> {
  if (journal.serverGraph) {
    try { return await observeCloudGraph(journal, signal); }
    catch { return journal; } // Network/auth uncertainty cannot turn an accepted graph green.
  }
  let next = journal;
  for (const item of Object.values(journal.nodes)) {
    if (signal?.aborted) break;
    if (item.state === 'waiting') {
      next = patchRunJournalNode(next, item.nodeId, { state: 'blocked', detail: 'recovery_not_dispatched' });
      continue;
    }
    if (item.state !== 'running') continue;
    let issueId = item.issueId;
    let runId = item.runId;
    let recovered: { status: string; terminal: boolean; output: string; outputAvailable?: boolean } | null = null;

    // New journals recover first by operation identity. This closes the accepted-before-client
    // disconnect gap where neither issueId nor runId reached the browser. The endpoint is
    // read-only upstream: it may discover identities, but never sends a message or wakes Agent.
    if (item.operationId && item.companyId && item.agentId) {
      try {
        const operation = await fetchConversationOperation(base, item.companyId, item.agentId, item.operationId,
          signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000));
        issueId = operation.issueId ?? issueId;
        runId = operation.runId ?? runId;
        next = patchRunJournalNode(next, item.nodeId, { issueId, runId });
        if (operation.state === 'not_started') {
          next = patchRunJournalNode(next, item.nodeId, { state: 'failed', detail: 'recovery_not_dispatched' });
          continue;
        }
        if (operation.state === 'rejected') {
          next = patchRunJournalNode(next, item.nodeId, { state: 'failed', detail: operation.detail ?? 'recovery_rejected' });
          continue;
        }
        if (operation.state === 'uncertain') {
          next = patchRunJournalNode(next, item.nodeId, { detail: 'recovery_operation_uncertain' });
          continue;
        }
        if (operation.terminal && operation.status) {
          recovered = { status: operation.status, terminal: true, output: operation.output, outputAvailable: operation.outputAvailable };
        } else {
          next = patchRunJournalNode(next, item.nodeId, {
            detail: operation.state === 'accepted' && !operation.runId ? 'recovery_run_not_visible' : operation.status ?? 'recovery_in_flight',
          });
          continue;
        }
      } catch {
        // An older deployed gateway may not expose operation recovery yet. If the browser already
        // persisted exact native identities, the legacy exact-run GET below is still safe.
      }
    }

    if (!recovered && (!runId || !issueId || !item.companyId || !item.agentId)) {
      next = patchRunJournalNode(next, item.nodeId, { detail: 'recovery_identity_missing' });
      continue;
    }
    try {
      let data: { runId?: unknown; status?: unknown; terminal?: unknown; output?: unknown; outputAvailable?: unknown };
      if (recovered) {
        data = { runId, ...recovered };
      } else {
        const path = [item.companyId!, 'agents', item.agentId!, 'issues', issueId!, 'runs', runId!].map(encodeURIComponent).join('/');
        const response = await canvasFetch(`${base.replace(/\/+$/, '')}/conversations/${path}`, { credentials: 'include', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('read failed');
        data = await response.json() as { runId?: unknown; status?: unknown; terminal?: unknown; output?: unknown; outputAvailable?: unknown };
      }
      if (data.runId !== runId || typeof data.status !== 'string') throw new Error('identity mismatch');
      if (data.terminal !== true || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(data.status)) continue;
      if (typeof data.output !== 'string') throw new Error('output unavailable');
      const node = nodes.find(n => n.id === item.nodeId);
      const output = data.outputAvailable === false && !data.output ? item.output ?? '' : data.output;
      const valid = data.outputAvailable !== false && Boolean(data.output.trim()) && node && (journal.manual || !validateNodeOutput(node, data.output).length);
      next = patchRunJournalNode(next, item.nodeId, {
        state: data.status === 'succeeded' && valid ? 'done' : data.status === 'cancelled' ? 'cancelled' : 'failed',
        output,
        detail: data.status === 'succeeded' && !valid
          ? data.outputAvailable === false ? 'recovery_output_unavailable' : !data.output.trim() ? 'empty_delivery' : 'recovery_invalid_output'
          : data.status,
      });
    } catch {
      next = patchRunJournalNode(next, item.nodeId, { detail: 'recovery_unconfirmed' });
    }
  }
  return next;
}
