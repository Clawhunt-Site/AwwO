import type { CanvasRunJournal, CanvasRunJournalNode } from './runJournal';
import type { ExecAgentResult } from './runGraph';

type RunIdentity = Pick<CanvasRunJournalNode, 'companyId' | 'agentId' | 'issueId' | 'runId'>;
export type SettlementResult = { confirmed: true; status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'; holdId: string }
  | { confirmed: false };

/** Explicitly park a completed native turn. Reads alone never change server state. */
export async function settleConversationRun(base: string, identity: RunIdentity, signal?: AbortSignal): Promise<SettlementResult> {
  const { companyId, agentId, issueId, runId } = identity;
  if (!companyId || !agentId || !issueId || !runId || signal?.aborted) return { confirmed: false };
  try {
    const path = [companyId, 'agents', agentId, 'issues', issueId, 'settle'].map(encodeURIComponent).join('/');
    const response = await fetch(`${base.replace(/\/+$/, '')}/conversations/${path}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ runId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || data?.confirmed !== true || typeof data.holdId !== 'string' || !data.holdId
        || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(data.status)) return { confirmed: false };
    return { confirmed: true, status: data.status, holdId: data.holdId };
  } catch { return { confirmed: false }; }
}

export async function settleExecutionResult(base: string, identity: RunIdentity | undefined, result: ExecAgentResult,
  settle = settleConversationRun): Promise<ExecAgentResult> {
  // No dispatch/uncertain transport stays governed by its existing recovery path.
  if (result.unconfirmed) return result;
  if (!identity?.runId) return result.ok
    ? { ok: false, unconfirmed: true, output: result.output, detail: 'recovery_identity_missing' } : result;
  const parked = await settle(base, identity);
  if (!parked.confirmed) return { ok: false, unconfirmed: true, output: result.output, detail: 'recovery_settlement_unconfirmed' };
  if (parked.status === 'cancelled') return { ok: false, cancelled: true, output: result.output, detail: 'cancelled' };
  if (parked.status !== 'succeeded') return { ok: false, output: result.output, detail: parked.status };
  return result;
}

/** Recovery may publish/unlock only after the exact completed turn is parked. */
export async function settleRecoveredJournal(base: string, journal: CanvasRunJournal, signal?: AbortSignal,
  settle = settleConversationRun): Promise<CanvasRunJournal> {
  const next = { ...journal, nodes: { ...journal.nodes } };
  for (const nodeId of journal.scope) {
    const item = next.nodes[nodeId];
    if (!item) continue;
    if (!item.runId) {
      if (item.state === 'done' && item.threadId !== 'form') {
        next.nodes[nodeId] = { ...item, state: 'running', detail: 'recovery_identity_missing' };
      }
      continue;
    }
    if (!['done', 'failed', 'cancelled'].includes(item.state)) continue;
    const parked = await settle(base, item, signal);
    if (!parked.confirmed) next.nodes[nodeId] = { ...item, state: 'running', detail: 'recovery_settlement_unconfirmed' };
    else if (parked.status === 'cancelled') next.nodes[nodeId] = { ...item, state: 'cancelled', detail: 'cancelled' };
    else if (parked.status !== 'succeeded') next.nodes[nodeId] = { ...item, state: 'failed', detail: parked.status };
  }
  return next;
}
