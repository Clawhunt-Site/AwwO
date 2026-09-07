// P3d — real per-agent conversation dispatcher (gateway BFF, ZERO server/ change).
//
// "Talk to a specific hired agent" is delivered entirely through already-mounted,
// NON-local_trusted-gated upstream /api primitives — NOT /chat/stream (which binds
// a synthetic per-adapter "Chat Assistant" and is fail-closed to chat-eligible
// adapters). Mechanism:
//   1. ensure a DEDICATED backlog issue assigned to the target agent (assigneeAgentId);
//      creation alone does not wake a worker or count as message delivery.
//   2. every turn verifies the issue binding, then POSTs one comment; finished
//      or blocked issues use the upstream's guarded explicit resume intent.
//   3. discover the agent's active run (id) via GET /issues/:id/live-runs.
//
// The agent that wakes is the REAL hired worker (not a chat charter): its reply is
// task-execution and it may do real, governed work. This layer is honest about the
// outcome (dispatched / queued / skipped / error) and NEVER fakes a "sent".
//
// The upstream is an opaque loopback HTTP dependency — we never import its source
// (same contract as upstream.ts / mission/upstream-reader.ts).

import { isLiveRunStatus, isTerminalRunStatus, RunStreamProjector } from './run-stream.js';
import {
  ConversationOperationConflictError,
  ConversationOperationCorruptError,
  type ConversationOperationSnapshot,
  type ConversationOperationStore,
  conversationRequestDigest,
  isConversationOperationId,
} from './operation-store.js';

// One Gateway process serializes mutation gates. The agent scope also covers the interval
// before a first conversation has an issue ID; unrelated agents remain independent.
const conversationMutations = new Map<string, Promise<void>>();
async function withConversationMutation<T>(companyId: string, agentId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([companyId.trim(), agentId.trim()]);
  const previous = conversationMutations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  conversationMutations.set(key, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (conversationMutations.get(key) === tail) conversationMutations.delete(key); }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** An active run discovered for the target agent on its conversation issue. */
export interface ActiveRun {
  runId: string;
  status: string;
  agentId: string;
  /** The run's adapter (drives how its stdout is decoded downstream). Null when
   *  the upstream row omitted it. */
  adapterType: string | null;
}

/** Exact native wake context for one durable operation. Legacy callers omit this
 *  field and retain the historical issue-wide live-run lookup. */
export type RunAttribution =
  | { kind: 'first_turn' }
  | { kind: 'comment'; commentId: string }
  | { kind: 'unattributable' };

export type DispatchResult =
  // Wake triggered AND the agent's run is already visible — stream/read it by runId.
  | { status: 'dispatched'; issueId: string; agentId: string; run: ActiveRun; runAttribution?: RunAttribution }
  // Message accepted but no run visible yet (async spin-up, busy, or wake skipped).
  // Delivery alone does not prove that the agent was woken.
  | { status: 'queued'; issueId: string; agentId: string; detail: string; runAttribution?: RunAttribution }
  // The upstream call failed (network / non-2xx). Nothing was reliably delivered.
  | { status: 'error'; detail: string; code?: 'operation_conflict' | 'operation_uncertain' };

export interface DispatchInput {
  companyId: string;
  agentId: string;
  message: string;
  /** Reuse an existing 1:1 conversation issue; omit to open a new one. */
  issueId?: string;
  /** Title for a newly-opened conversation issue (first turn only). */
  title?: string;
  /** P3f: labels stamped on a newly-opened conversation issue so it can be found again by the
   *  company-wide index. Absent/empty → the conversation is simply unindexed; a turn must never
   *  fail because indexing metadata could not be resolved. */
  labelIds?: string[];
  /** Durable caller-minted identity for exactly one upstream message mutation. */
  operationId?: string;
}

export interface ConversationOperationReadInput {
  companyId: string;
  agentId: string;
  operationId: string;
}

export interface ConversationOperationReadResult {
  operationId: string;
  state: 'not_started' | 'in_flight' | 'accepted' | 'terminal' | 'rejected' | 'uncertain';
  issueId: string | null;
  runId: string | null;
  terminal: boolean;
  status: string | null;
  output: string;
  outputAvailable: boolean;
  detail: string | null;
}

export interface CancelConversationRunInput {
  companyId: string;
  agentId: string;
  issueId: string;
  /** Optional while the wake is still being claimed. The issue hold also cancels unclaimed wakes. */
  runId?: string | null;
}

export type CancelConversationRunResult =
  | { ok: true; confirmed: true; cancelled: boolean; status: string; holdId: string | null }
  | { ok: false; confirmed: false; detail: string; holdId?: string | null };

export type SettleConversationRunResult =
  | { confirmed: true; status: string; holdId: string; stoppedAutomaticRunIds: string[] }
  | { confirmed: false; detail: string };

export class AgentConversationDispatcher {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cancelPollAttempts: number;
  private readonly cancelPollDelayMs: number;
  private readonly operationStore: ConversationOperationStore | null;
  private readonly operationDiscoveryAttempts: number;
  private readonly operationDiscoveryDelayMs: number;
  private readonly latestCommentByIssue = new Map<string, string>();

  constructor(
    upstreamBaseUrl: string,
    opts: {
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
      cancelPollAttempts?: number;
      cancelPollDelayMs?: number;
      operationStore?: ConversationOperationStore;
      operationDiscoveryAttempts?: number;
      operationDiscoveryDelayMs?: number;
    } = {},
  ) {
    this.base = upstreamBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cancelPollAttempts = opts.cancelPollAttempts ?? 40;
    this.cancelPollDelayMs = opts.cancelPollDelayMs ?? 100;
    this.operationStore = opts.operationStore ?? null;
    this.operationDiscoveryAttempts = opts.operationDiscoveryAttempts ?? 8;
    this.operationDiscoveryDelayMs = opts.operationDiscoveryDelayMs ?? 100;
  }

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch {
      // Network refusal / timeout abort / bad URL → a non-ok result with status 0,
      // NOT a thrown error: dispatch() must never reject (fail-soft contract).
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!res.ok) throw new Error(`upstream ${path} returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private operationLabelName(operationId: string): string {
    // 8 + 36 = 44 chars, below the upstream's 48-character label limit.
    return `awwo:op:${operationId.toLowerCase()}`;
  }

  /** Claim an immutable request identity before the SSE response is opened. */
  async prepareConversationOperation(input: DispatchInput): Promise<{ created: boolean; snapshot: ConversationOperationSnapshot } | null> {
    if (!input.operationId) return null;
    if (!this.operationStore) throw new Error('conversation operation recovery is unavailable');
    const companyId = str(input.companyId);
    const agentId = str(input.agentId);
    const message = typeof input.message === 'string' ? input.message : '';
    if (!companyId || !agentId || !message.trim()) throw new Error('invalid conversation operation request');
    return this.operationStore.claim({
      operationId: input.operationId,
      companyId,
      agentId,
      issueId: str(input.issueId),
      deliveryMode: 'comment',
      requestDigest: conversationRequestDigest({
        companyId,
        agentId,
        issueId: str(input.issueId),
        message,
        title: str(input.title),
      }),
    });
  }

  private async ensureOperationLabel(companyId: string, operationId: string): Promise<string | null> {
    const name = this.operationLabelName(operationId);
    const find = async (): Promise<string | null> => {
      let labels: unknown;
      try { labels = await this.getJson(`/api/companies/${encodeURIComponent(companyId)}/labels`); }
      catch { return null; }
      if (!Array.isArray(labels)) return null;
      for (const raw of labels) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const label = raw as Record<string, unknown>;
        if (str(label.name) === name) return str(label.id);
      }
      return null;
    };
    const existing = await find();
    if (existing) return existing;
    const created = await this.postJson(`/api/companies/${encodeURIComponent(companyId)}/labels`, {
      name,
      color: '#0f766e',
    });
    const id = created.ok && created.body && typeof created.body === 'object' && !Array.isArray(created.body)
      ? str((created.body as Record<string, unknown>).id) : null;
    return id ?? await find();
  }

  private async readBoundIssue(companyId: string, agentId: string, issueId: string): Promise<Record<string, unknown>> {
    const raw = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid conversation issue response');
    const issue = raw as Record<string, unknown>;
    if (str(issue.id) !== issueId || str(issue.companyId) !== companyId || str(issue.assigneeAgentId) !== agentId) {
      throw new Error('conversation issue no longer belongs to this company and agent');
    }
    return issue;
  }

  private async findOperationIssue(companyId: string, agentId: string, labelId: string): Promise<Record<string, unknown> | null> {
    const query = `labelId=${encodeURIComponent(labelId)}&limit=10&offset=0&sortField=updated&sortDir=desc`;
    const raw = await this.getJson(`/api/companies/${encodeURIComponent(companyId)}/issues?${query}`);
    if (!Array.isArray(raw)) throw new Error('invalid operation issue search response');
    const ids = raw.map(value => value && typeof value === 'object' && !Array.isArray(value)
      ? str((value as Record<string, unknown>).id) : null).filter((value): value is string => Boolean(value));
    if (ids.length > 1) throw new Error('operation label matched multiple issues');
    if (!ids.length) return null;
    return this.readBoundIssue(companyId, agentId, ids[0]!);
  }

  private async recoverOperationIssue(snapshot: ConversationOperationSnapshot): Promise<Record<string, unknown> | null> {
    if (!snapshot.labelId || snapshot.request.issueId) return null;
    for (let attempt = 0; attempt < this.operationDiscoveryAttempts; attempt += 1) {
      const found = await this.findOperationIssue(snapshot.request.companyId, snapshot.request.agentId, snapshot.labelId);
      if (found) {
        if (snapshot.request.deliveryMode === 'comment') {
          await this.operationStore?.recordContainer(snapshot.request.operationId, str(found.id)!);
        } else {
          await this.operationStore?.recordIssue(snapshot.request.operationId, str(found.id)!);
        }
        return found;
      }
      if (attempt + 1 < this.operationDiscoveryAttempts && this.operationDiscoveryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.operationDiscoveryDelayMs));
      }
    }
    return null;
  }

  private commentMetadata(snapshot: ConversationOperationSnapshot): Record<string, unknown> {
    return { version: 1, sections: [{ title: 'AwwO conversation', rows: [
      { type: 'key_value', label: 'Operation', value: snapshot.request.operationId },
      { type: 'key_value', label: 'Request digest', value: snapshot.request.requestDigest },
    ] }] };
  }

  /** Read back a committed comment after a lost response. Metadata identifies the operation
   * without changing the user's message or selecting an unrelated recent run. */
  private async recoverOperationComment(snapshot: ConversationOperationSnapshot): Promise<boolean> {
    if (snapshot.request.deliveryMode !== 'comment' || !snapshot.commentStarted || !snapshot.issueId) return false;
    await this.readBoundIssue(snapshot.request.companyId, snapshot.request.agentId, snapshot.issueId);
    for (let attempt = 0; attempt < this.operationDiscoveryAttempts; attempt += 1) {
      const comments = await this.getJson(`/api/issues/${encodeURIComponent(snapshot.issueId)}/comments?order=desc&limit=200`);
      if (!Array.isArray(comments)) throw new Error('invalid operation comment search response');
      const matches = comments.filter(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const comment = raw as Record<string, unknown>;
        if (comment.issueId !== snapshot.issueId || comment.companyId !== snapshot.request.companyId || !str(comment.id)) return false;
        const metadata = comment.metadata as { version?: unknown; sections?: Array<{ title?: unknown; rows?: Array<{ type?: unknown; label?: unknown; value?: unknown }> }> } | null;
        if (metadata?.version !== 1 || !Array.isArray(metadata.sections)) return false;
        return metadata.sections.some(section => section?.title === 'AwwO conversation' && Array.isArray(section.rows)
          && section.rows.some(row => row?.type === 'key_value' && row.label === 'Operation' && row.value === snapshot.request.operationId)
          && section.rows.some(row => row?.type === 'key_value' && row.label === 'Request digest' && row.value === snapshot.request.requestDigest));
      }) as Array<Record<string, unknown>>;
      if (matches.length > 1) throw new Error('operation marker matched multiple comments');
      if (matches.length === 1) {
        await this.operationStore!.recordIssue(snapshot.request.operationId, snapshot.issueId, str(matches[0]!.id)!);
        return true;
      }
      if (attempt + 1 < this.operationDiscoveryAttempts && this.operationDiscoveryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.operationDiscoveryDelayMs));
      }
    }
    return false;
  }

  /** Bind run identity to the durable operation as soon as discovery succeeds. */
  async recordConversationOperationRun(operationId: string, runId: string): Promise<void> {
    if (!this.operationStore) return;
    await this.operationStore.recordRun(operationId, runId);
  }

  private async findHistoricalOperationRun(snapshot: ConversationOperationSnapshot, issueId: string): Promise<string | null> {
    let raw: unknown;
    // The upstream exposes historical heartbeat runs at company scope (the issue
    // route exposes live runs only). Keep the scan bounded and server-filtered by
    // the already-validated Agent, then apply the exact issue/wake context here.
    const query = `agentId=${encodeURIComponent(snapshot.request.agentId)}&limit=1000&summary=1`;
    try { raw = await this.getJson(`/api/companies/${encodeURIComponent(snapshot.request.companyId)}/heartbeat-runs?${query}`); }
    catch { return null; }
    if (!Array.isArray(raw)) return null;
    const candidates = raw.filter(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const run = value as Record<string, unknown>;
      const context = run.contextSnapshot && typeof run.contextSnapshot === 'object' && !Array.isArray(run.contextSnapshot)
        ? run.contextSnapshot as Record<string, unknown> : null;
      if (str(run.companyId) !== snapshot.request.companyId || str(run.agentId) !== snapshot.request.agentId
        || str(context?.issueId) !== issueId) return false;
      if (snapshot.request.issueId === null && snapshot.request.deliveryMode !== 'comment') return !str(context?.commentId) && !str(context?.wakeCommentId);
      if (!snapshot.commentId) return false;
      const ids = Array.isArray(context?.wakeCommentIds)
        ? context.wakeCommentIds.filter((value): value is string => typeof value === 'string') : [];
      return str(context?.commentId) === snapshot.commentId
        || str(context?.wakeCommentId) === snapshot.commentId
        || ids.includes(snapshot.commentId);
    }) as Array<Record<string, unknown>>;
    candidates.sort((a, b) => Date.parse(String(a.createdAt ?? '')) - Date.parse(String(b.createdAt ?? '')));
    const first = candidates[0];
    return first ? str(first.id) ?? str(first.runId) : null;
  }

  /** Read-only (upstream) reconciliation for a caller-minted operation identity. */
  async readConversationOperation(input: ConversationOperationReadInput): Promise<ConversationOperationReadResult> {
    if (!this.operationStore) throw new Error('conversation operation recovery is unavailable');
    let snapshot = await this.operationStore.read(input.operationId);
    if (snapshot.request.companyId !== input.companyId || snapshot.request.agentId !== input.agentId) {
      throw new ConversationOperationConflictError();
    }
    if (snapshot.phase === 'rejected') {
      return { operationId: snapshot.request.operationId, state: 'rejected', issueId: snapshot.issueId, runId: null,
        terminal: false, status: null, output: '', outputAvailable: false, detail: snapshot.detail };
    }
    if (!snapshot.deliveryConfirmed) {
      if (snapshot.request.deliveryMode === 'comment') {
        if (!snapshot.issueId && snapshot.mutationStarted) await this.recoverOperationIssue(snapshot);
        snapshot = await this.operationStore.read(snapshot.request.operationId);
        if (snapshot.commentStarted) {
          await this.recoverOperationComment(snapshot);
          snapshot = await this.operationStore.read(snapshot.request.operationId);
        }
        if (!snapshot.deliveryConfirmed) {
          return { operationId: snapshot.request.operationId, state: snapshot.commentStarted || (!snapshot.issueId && snapshot.mutationStarted) ? 'uncertain' : 'not_started',
            issueId: snapshot.issueId, runId: null, terminal: false, status: null, output: '', outputAvailable: false,
            detail: snapshot.commentStarted ? 'comment mutation started but its result is not yet attributable' : 'conversation message has not been sent' };
        }
      }
    }
    if (!snapshot.deliveryConfirmed) {
      if (!snapshot.mutationStarted) {
        return { operationId: snapshot.request.operationId, state: 'not_started', issueId: snapshot.request.issueId,
          runId: null, terminal: false, status: null, output: '', outputAvailable: false, detail: null };
      }
      const issue = await this.recoverOperationIssue(snapshot);
      if (!issue) {
        return { operationId: snapshot.request.operationId, state: 'uncertain', issueId: snapshot.request.issueId,
          runId: null, terminal: false, status: null, output: '', outputAvailable: false,
          detail: snapshot.detail ?? 'upstream mutation started but its result is not yet attributable' };
      }
      snapshot = await this.operationStore.read(snapshot.request.operationId);
    }
    const issueId = snapshot.issueId;
    if (!issueId) throw new ConversationOperationCorruptError(snapshot.request.operationId);
    await this.readBoundIssue(input.companyId, input.agentId, issueId);
    let runId = snapshot.runId;
    if (!runId) {
      // The issue can contain several runs for the same Agent. Attribute this operation
      // by its immutable wake context before consulting the live roster; an issue-wide
      // fallback could bind a continuation to an older run.
      runId = await this.findHistoricalOperationRun(snapshot, issueId);
      if (!runId) {
        const usesComment = snapshot.request.deliveryMode === 'comment' || snapshot.request.issueId !== null;
        const commentId = usesComment ? snapshot.commentId : null;
        const active = usesComment && !commentId
          ? null
          : await this.findActiveRun(issueId, input.agentId, commentId);
        runId = active?.runId ?? null;
      }
      if (runId) {
        await this.operationStore.recordRun(snapshot.request.operationId, runId);
        snapshot = await this.operationStore.read(snapshot.request.operationId);
      }
    }
    if (!runId) {
      return { operationId: snapshot.request.operationId, state: 'accepted', issueId, runId: null,
        terminal: false, status: null, output: '', outputAvailable: false, detail: 'message accepted; run not yet attributable' };
    }
    const run = await this.readConversationRun({ companyId: input.companyId, agentId: input.agentId, issueId, runId });
    return {
      operationId: snapshot.request.operationId,
      state: run.terminal ? 'terminal' : 'in_flight',
      issueId,
      runId,
      terminal: run.terminal,
      status: run.status,
      output: run.output,
      outputAvailable: run.terminal && run.outputAvailable !== false,
      detail: run.terminal && run.outputAvailable === false ? 'terminal output is not safely readable' : null,
    };
  }

  /** Read only the discovered run's persisted stdout. No recent-run fallback.
   * Pages end on outer NDJSON record boundaries so UTF-8 split by the upstream's
   * byte ranges is re-read intact instead of joining replacement characters. */
  async readRunStdout(runId: string, signal?: AbortSignal): Promise<string> {
    const pageBytes = 1024 * 1024;
    const maxBytes = 8 * pageBytes;
    let offset = 0;
    let stdout = '';
    for (let page = 0; page < 16; page += 1) {
      if (signal?.aborted) throw new Error('Run log read cancelled');
      const raw = await this.getJson(`/api/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=${pageBytes}`, signal);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid run log response');
      const result = raw as Record<string, unknown>;
      if (result.runId !== runId || typeof result.content !== 'string' || result.content.length > pageBytes + 4) throw new Error('Invalid run log response');
      const hasCursor = result.nextOffset !== undefined && result.nextOffset !== null;
      if (hasCursor && (!Number.isSafeInteger(result.nextOffset) || Number(result.nextOffset) <= offset || Number(result.nextOffset) > maxBytes)) throw new Error('Invalid run log offset');
      // A short page without a cursor is EOF. Probe again after a full page so
      // older upstream versions that omit cursors cannot silently truncate it.
      const more = hasCursor || Buffer.byteLength(result.content) >= pageBytes;
      const end = more ? result.content.lastIndexOf('\n') + 1 : result.content.length;
      if (more && end === 0) throw new Error('Run log record exceeds read limit');
      const complete = result.content.slice(0, end);
      const consumed = Buffer.byteLength(complete);
      if (offset + consumed > maxBytes) throw new Error('Run log exceeds read limit');
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch { throw new Error('Incomplete run log record'); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid run log record');
        const entry = record as Record<string, unknown>;
        if (typeof entry.chunk !== 'string' || !['stdout', 'stderr', 'system'].includes(String(entry.stream))) throw new Error('Invalid run log record');
        if (entry.stream === 'stdout') stdout += entry.chunk;
      }
      if (!more) return stdout;
      // Discard the page's partial last record and fetch it again in full.
      offset += consumed;
    }
    throw new Error('Run log exceeds page limit');
  }

  /** The target agent's active (queued|running) run on this issue, if any. Reads
   *  GET /issues/:id/live-runs (already scoped to the issue) and picks the row for
   *  our agent. Fail-soft: an unreadable roster → null (unknown, not "no run"). */
  async findActiveRun(issueId: string, agentId: string, commentId?: string | null): Promise<ActiveRun | null> {
    let rows: unknown;
    try {
      rows = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}/live-runs`);
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    for (const r of rows as Array<Record<string, unknown>>) {
      const runId = str(r?.id);
      const runAgentId = str(r?.agentId);
      const status = str(r?.status);
      const contextCommentId = str(r?.contextCommentId);
      const contextWakeCommentId = str(r?.contextWakeCommentId);
      if (commentId === null && (contextCommentId || contextWakeCommentId)) continue;
      if (typeof commentId === 'string' && contextCommentId !== commentId && contextWakeCommentId !== commentId) continue;
      if (runId && runAgentId === agentId && status && isLiveRunStatus(status)) {
        return { runId, status, agentId, adapterType: str(r?.adapterType) };
      }
    }
    return null;
  }

  /** Reconcile a persisted run identity without sending a message or waking an agent. */
  async readConversationRun(input: CancelConversationRunInput): Promise<{ runId: string; status: string; terminal: boolean; output: string; outputAvailable?: boolean }> {
    const { companyId, agentId, issueId, runId } = input;
    if (!runId) throw new Error('A native run ID is required for recovery');
    const issue = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}`) as Record<string, unknown> | null;
    if (!issue || issue.id !== issueId || issue.companyId !== companyId || issue.assigneeAgentId !== agentId) throw new Error('Conversation identity mismatch');
    const run = await this.getJson(`/api/heartbeat-runs/${encodeURIComponent(runId)}`) as Record<string, unknown> | null;
    const context = run?.contextSnapshot as Record<string, unknown> | null;
    if (!run || run.id !== runId || run.companyId !== companyId || run.agentId !== agentId || context?.issueId !== issueId) throw new Error('Run identity mismatch');
    const status = str(run.status) ?? 'unknown';
    const terminal = isTerminalRunStatus(status);
    let output = '';
    if (terminal) {
      let adapterType = str(run.adapterType);
      if (!adapterType) {
        // The heartbeat detail contract may omit adapterType. A null adapter makes the
        // projector treat stdout as raw text, which would expose Codex JSONL/tool events as
        // a user deliverable. Resolve the already-validated Agent identity instead; inability
        // to prove its adapter means output is unavailable, never raw.
        try {
          const rawAgent = await this.getJson(`/api/agents/${encodeURIComponent(agentId)}`);
          if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) throw new Error('invalid agent');
          const agent = rawAgent as Record<string, unknown>;
          if (str(agent.id) !== agentId || str(agent.companyId) !== companyId) throw new Error('agent identity mismatch');
          adapterType = str(agent.adapterType);
        } catch {
          return { runId, status, terminal, output: '', outputAvailable: false };
        }
      }
      if (!adapterType) return { runId, status, terminal, output: '', outputAvailable: false };
      const projector = new RunStreamProjector({ runId, adapterType });
      let stdout: string;
      try { stdout = await this.readRunStdout(runId); }
      catch {
        // Execution truth and delivery availability are independent. Unlock a confirmed terminal
        // run, but never publish a successful output that could not be read.
        return { runId, status, terminal, output: '', outputAvailable: false };
      }
      const frames = [
        ...projector.handle({ type: 'heartbeat.run.log', payload: { runId, stream: 'stdout', chunk: stdout } }),
        ...projector.handle({ type: 'heartbeat.run.status', payload: { runId, status } }),
      ];
      if (projector.hasMalformedCodexLog) return { runId, status, terminal, output: '', outputAvailable: false };
      output = frames.filter(f => f.kind === 'delta').map(f => f.kind === 'delta' ? f.text : '').join('');
    }
    return { runId, status, terminal, output };
  }

  /** Ordinary native comments may wake an in_progress issue through a pause hold. Therefore
   * every explicit send must discover persisted holds and confirm their release first, even
   * after a Gateway restart. A remembered ID or a successful comment is never that proof. */
  private async releaseCanvasStopHolds(issueId: string, companyId: string): Promise<'released' | 'none' | 'blocked' | 'failed'> {
    const issuePath = `/api/issues/${encodeURIComponent(issueId)}`;
    const owned = (hold: Record<string, unknown>) => {
      const metadata = hold.metadata && typeof hold.metadata === 'object' && !Array.isArray(hold.metadata)
        ? hold.metadata as Record<string, unknown> : null;
      const releasePolicy = hold.releasePolicy && typeof hold.releasePolicy === 'object' && !Array.isArray(hold.releasePolicy)
        ? hold.releasePolicy as Record<string, unknown> : null;
      return metadata?.source === 'awwo_agent_canvas'
        || (typeof releasePolicy?.note === 'string' && /^awwo_agent_canvas:(stop|settle):[A-Za-z0-9_-]+$/.test(releasePolicy.note))
        || hold.reason === 'Stopped by AwwO Agent canvas';
    };
    const readHolds = async () => {
      const raw = await this.getJson(`${issuePath}/tree-holds?status=active&mode=pause`);
      if (!Array.isArray(raw)) throw new Error('pause holds unavailable');
      const ids = new Set<string>();
      return raw.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid pause hold');
        const hold = value as Record<string, unknown>;
        const id = str(hold.id);
        if (!id || ids.has(id) || hold.companyId !== companyId || hold.rootIssueId !== issueId
            || hold.status !== 'active' || hold.mode !== 'pause') throw new Error('pause hold scope mismatch');
        ids.add(id);
        return hold;
      });
    };
    const readGate = async () => {
      const raw = await this.getJson(`${issuePath}/tree-control/state`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'activePauseHold')) throw new Error('pause state unavailable');
      const gate = (raw as Record<string, unknown>).activePauseHold;
      if (gate === null) return null;
      if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error('invalid pause state');
      const value = gate as Record<string, unknown>;
      if (!str(value.holdId) || !str(value.rootIssueId) || value.issueId !== issueId || value.mode !== 'pause') throw new Error('pause state scope mismatch');
      return value;
    };
    try {
      const holds = await readHolds();
      const gate = await readGate();
      // Inherited holds have another root and cannot be released through this conversation.
      // Check all root holds too: the effective-state API only returns one of them.
      if (gate && gate.rootIssueId !== issueId) return 'blocked';
      if (holds.some(hold => !owned(hold))) return 'blocked';
      if (gate && !holds.some(hold => hold.id === gate.holdId)) return 'failed';
      for (const hold of holds) {
        const released = await this.postJson(`${issuePath}/tree-holds/${encodeURIComponent(String(hold.id))}/release`,
          { reason: 'AwwO conversation resumed by the operator' });
        if (!released.ok) return 'failed';
      }
      if (holds.length === 0) return 'none';
      // Confirm all persisted owned holds are gone, then also check inherited pause state.
      // Neither a 2xx release response nor the in-memory process state is sufficient.
      if ((await readHolds()).length > 0) return 'failed';
      if (await readGate()) return 'blocked';
      return 'released';
    } catch {
      return 'failed';
    }
  }

  /** Stop one canvas conversation without triggering the upstream's automatic cancellation
   * recovery. A pause hold is created first (also sweeping unclaimed wakes), then the exact
   * native run is polled until it is terminal. Returning ok=true therefore means the execution
   * really stopped or had already completed; a timeout/error is never reported as cancellation. */
  async cancelConversationRun(input: CancelConversationRunInput): Promise<CancelConversationRunResult> {
    const companyId = str(input.companyId);
    const agentId = str(input.agentId);
    const issueId = str(input.issueId);
    const runId = str(input.runId);
    if (!companyId || !agentId || !issueId) return { ok: false, confirmed: false, detail: 'invalid conversation identity' };

    let issueRaw: unknown;
    try { issueRaw = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}`); }
    catch { return { ok: false, confirmed: false, detail: 'conversation issue could not be read' }; }
    if (!issueRaw || typeof issueRaw !== 'object' || Array.isArray(issueRaw)) return { ok: false, confirmed: false, detail: 'invalid conversation issue response' };
    const issue = issueRaw as Record<string, unknown>;
    if (str(issue.id) !== issueId || str(issue.companyId) !== companyId || str(issue.assigneeAgentId) !== agentId) {
      return { ok: false, confirmed: false, detail: 'conversation identity mismatch' };
    }

    if (runId) {
      let runRaw: unknown;
      try { runRaw = await this.getJson(`/api/heartbeat-runs/${encodeURIComponent(runId)}`); }
      catch { return { ok: false, confirmed: false, detail: 'conversation run could not be read' }; }
      if (!runRaw || typeof runRaw !== 'object' || Array.isArray(runRaw)) return { ok: false, confirmed: false, detail: 'invalid conversation run response' };
      const run = runRaw as Record<string, unknown>;
      const context = run.contextSnapshot && typeof run.contextSnapshot === 'object' && !Array.isArray(run.contextSnapshot)
        ? run.contextSnapshot as Record<string, unknown> : null;
      if (str(run.id) !== runId || str(run.companyId) !== companyId || str(run.agentId) !== agentId || str(context?.issueId) !== issueId) {
        return { ok: false, confirmed: false, detail: 'conversation run identity mismatch' };
      }
      const status = str(run.status);
      if (status && isTerminalRunStatus(status)) {
        return { ok: true, confirmed: true, cancelled: status === 'cancelled', status, holdId: null };
      }
    }

    const created = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/tree-holds`, {
      mode: 'pause',
      reason: 'Stopped by AwwO Agent canvas',
      releasePolicy: { strategy: 'manual', note: `awwo_agent_canvas:stop:${runId ?? 'pending'}` },
      metadata: { source: 'awwo_agent_canvas', ...(runId ? { runId } : {}) },
    });
    if (!created.ok || !created.body || typeof created.body !== 'object' || Array.isArray(created.body)) {
      return { ok: false, confirmed: false, detail: 'native stop request was rejected' };
    }
    const body = created.body as Record<string, unknown>;
    const hold = body.hold && typeof body.hold === 'object' && !Array.isArray(body.hold) ? body.hold as Record<string, unknown> : null;
    const holdId = str(hold?.id);
    if (!holdId) return { ok: false, confirmed: false, detail: 'native stop hold was not confirmed' };
    const preview = body.preview && typeof body.preview === 'object' && !Array.isArray(body.preview) ? body.preview as Record<string, unknown> : null;
    const active = Array.isArray(preview?.activeRuns) ? preview.activeRuns : [];
    const targetIds = new Set<string>(runId ? [runId] : []);
    for (const value of active) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const id = str((value as Record<string, unknown>).id);
      if (id) targetIds.add(id);
    }
    if (!targetIds.size) return { ok: true, confirmed: true, cancelled: true, status: 'cancelled', holdId };

    const statuses = new Map<string, string>();
    for (let attempt = 0; attempt < this.cancelPollAttempts; attempt += 1) {
      let unreadable = false;
      for (const id of targetIds) {
        if (statuses.has(id)) continue;
        try {
          const raw = await this.getJson(`/api/heartbeat-runs/${encodeURIComponent(id)}`);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { unreadable = true; break; }
          const run = raw as Record<string, unknown>;
          const status = str(run.status);
          if (str(run.id) !== id || str(run.companyId) !== companyId || !status) { unreadable = true; break; }
          if (isTerminalRunStatus(status)) statuses.set(id, status);
        } catch { unreadable = true; break; }
      }
      if (unreadable) return { ok: false, confirmed: false, detail: 'native stop status could not be confirmed', holdId };
      if (statuses.size === targetIds.size) {
        const requestedStatus = runId ? statuses.get(runId) : null;
        const status = requestedStatus ?? ([...statuses.values()].every(value => value === 'cancelled') ? 'cancelled' : 'terminal');
        return { ok: true, confirmed: true, cancelled: [...statuses.values()].every(value => value === 'cancelled'), status, holdId };
      }
      if (this.cancelPollDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.cancelPollDelayMs));
    }
    return { ok: false, confirmed: false, detail: 'native stop was not confirmed before timeout', holdId };
  }

  /** Park this completed user turn without marking its task done. Native tree holds lack CAS:
   * this protects one Gateway's user mutations; direct concurrent native writes are excluded.
   * Known system continuations of the same turn may be interrupted, never a newer user turn. */
  async settleConversationRun(input: CancelConversationRunInput): Promise<SettleConversationRunResult> {
    return withConversationMutation(input.companyId, input.agentId, async () => {
      try {
        const { companyId, agentId, issueId } = input;
        const runId = str(input.runId);
        if (!runId || !isConversationOperationId(runId)) return { confirmed: false, detail: 'a native run UUID is required' };
        if (!this.operationStore) return { confirmed: false, detail: 'durable settlement storage is unavailable' };
        await this.readBoundIssue(companyId, agentId, issueId);
        const readRun = async (id: string): Promise<Record<string, unknown>> => {
          const raw = await this.getJson(`/api/heartbeat-runs/${encodeURIComponent(id)}`);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid native run');
          const run = raw as Record<string, unknown>;
          const context = run.contextSnapshot as Record<string, unknown> | null;
          if (run.id !== id || run.companyId !== companyId || run.agentId !== agentId || context?.issueId !== issueId) throw new Error('Run identity mismatch');
          return run;
        };
        const sourceRun = await readRun(runId);
        const status = str(sourceRun.status);
        if (!status || !isTerminalRunStatus(status)) return { confirmed: false, detail: 'requested native run is not terminal' };
        const sourceContext = sourceRun.contextSnapshot as Record<string, unknown>;
        const sourceTime = Date.parse(String(sourceRun.createdAt ?? ''));
        if (!Number.isFinite(sourceTime)) return { confirmed: false, detail: 'native run ordering is unavailable' };
        const sourceCommentId = str(sourceContext.commentId) ?? str(sourceContext.wakeCommentId);
        if (!sourceCommentId) return { confirmed: false, detail: 'source comment anchor is unavailable for this native run' };
        const latestComment = this.latestCommentByIssue.get(issueId);
        if (latestComment && latestComment !== sourceCommentId) return { confirmed: false, detail: 'a newer user turn already owns this conversation' };

        const history = await this.getJson(`/api/companies/${encodeURIComponent(companyId)}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=1000&summary=1`);
        if (!Array.isArray(history)) throw new Error('native run history is unavailable');
        const issueRuns = history.filter(raw => raw && typeof raw === 'object'
          && (raw as { contextSnapshot?: { issueId?: unknown } }).contextSnapshot?.issueId === issueId) as Array<Record<string, unknown>>;
        if (!issueRuns.some(run => run.id === runId)) throw new Error('source run is outside the verified history window');
        if (issueRuns.some(run => !str(run.id) || !Number.isFinite(Date.parse(String(run.createdAt ?? ''))))) throw new Error('native run ordering is unavailable');
        const automaticRunIds = new Set<string>();
        const autoReasons = new Set(['finish_successful_run_handoff', 'issue_continuation_needed', 'run_liveness_continuation', 'missing_issue_comment']);
        const acceptAutomaticRun = async (id: string): Promise<boolean> => {
          const run = await readRun(id);
          const context = run.contextSnapshot as Record<string, unknown>;
          const parent = str(context.sourceRunId) ?? str(context.retryOfRunId) ?? str(context.livenessContinuationSourceRunId) ?? str(context.resumeFromRunId);
          if (!autoReasons.has(String(context.wakeReason)) || !parent || (parent !== runId && !automaticRunIds.has(parent))) return false;
          automaticRunIds.add(id);
          return true;
        };
        const later = issueRuns.filter(run => run.id !== runId && Date.parse(String(run.createdAt ?? '')) >= sourceTime)
          .sort((left, right) => Date.parse(String(left.createdAt)) - Date.parse(String(right.createdAt)));
        for (const row of later) {
          const id = str(row.id);
          if (!id) throw new Error('native run identity is unavailable');
          if (!await acceptAutomaticRun(id)) {
            return { confirmed: false, detail: 'a newer user turn or unattributed run owns this conversation' };
          }
        }
        // A comment can already be accepted while its native wake is not visible yet.
        const comments = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}/comments?order=desc&limit=200`);
        if (!Array.isArray(comments)) throw new Error('conversation comment ordering is unavailable');
        const scopedComments = comments.map(raw => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid conversation comment');
          const comment = raw as Record<string, unknown>;
          if (comment.companyId !== companyId || comment.issueId !== issueId) throw new Error('conversation comment scope mismatch');
          return comment;
        });
        const sourceComments = scopedComments.filter(comment => comment.id === sourceCommentId);
        if (sourceComments.length !== 1) return { confirmed: false, detail: 'exact source comment anchor is unavailable' };
        const sourceCommentTime = Date.parse(String(sourceComments[0]!.createdAt ?? ''));
        if (!Number.isFinite(sourceCommentTime) || sourceCommentTime > sourceTime) {
          return { confirmed: false, detail: 'source comment ordering is unavailable' };
        }
        for (const comment of scopedComments) {
          if (comment.id === sourceCommentId || comment.createdByRunId === runId
              || automaticRunIds.has(String(comment.createdByRunId))) continue;
          const createdAt = Date.parse(String(comment.createdAt ?? ''));
          // UUID ordering and array position cannot establish chronology when timestamps tie.
          // Compare against the actual wake comment, not the later-created native run row.
          if (!Number.isFinite(createdAt) || createdAt >= sourceCommentTime) return { confirmed: false, detail: 'a newer user comment or unknown comment prevents settlement' };
        }

        const note = `awwo_agent_canvas:settle:${runId}`;
        const interruptedByHold = new Set<string>();
        const matchingHold = async (): Promise<string | null> => {
          const holds = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}/tree-holds?status=active&mode=pause&includeMembers=true`);
          if (!Array.isArray(holds)) throw new Error('native pause holds are unavailable');
          const matched = holds.filter(raw => raw && typeof raw === 'object' && raw.companyId === companyId && raw.rootIssueId === issueId
            && raw.status === 'active' && raw.mode === 'pause' && raw.releasePolicy?.note === note);
          if (matched.length > 1) throw new Error('multiple settlement holds require review');
          if (matched.length === 1) {
            if (!Array.isArray(matched[0].members) || matched[0].members.some((member: { issueId?: unknown }) => member.issueId !== issueId)) {
              throw new Error('settlement hold scope could not be verified');
            }
            for (const member of matched[0].members) if (str(member.activeRunId)) interruptedByHold.add(str(member.activeRunId)!);
          }
          return matched.length === 1 ? str(matched[0].id) : null;
        };
        let holdId = await matchingHold();
        if (!holdId) {
          const previewed = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/tree-control/preview`, { mode: 'pause' });
          const preview = previewed.body as { companyId?: unknown; rootIssueId?: unknown; issues?: Array<{ id?: unknown }>; activeRuns?: Array<{ id?: unknown; issueId?: unknown; agentId?: unknown }> } | null;
          if (!previewed.ok || preview?.companyId !== companyId || preview.rootIssueId !== issueId
              || !Array.isArray(preview.issues) || preview.issues.length !== 1 || preview.issues[0]?.id !== issueId
              || !Array.isArray(preview.activeRuns)) return { confirmed: false, detail: 'settlement requires one isolated conversation issue' };
          if (preview.activeRuns.some(run => run.issueId !== issueId || run.agentId !== agentId || !automaticRunIds.has(String(run.id)))) {
            return { confirmed: false, detail: 'unattributed active execution prevents settlement' };
          }
          if (!await this.operationStore.beginSettlement({ companyId, agentId, issueId, runId })) {
            return { confirmed: false, detail: 'settlement outcome is uncertain; duplicate hold creation was refused' };
          }
          await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/tree-holds`, {
            mode: 'pause', reason: 'AwwO conversation waiting for the next user request',
            releasePolicy: { strategy: 'manual', note },
          });
          // Confirm the persisted hold even when the POST response was lost. Never infer
          // success from an HTTP status alone, and never repeat an uncertain creation.
          holdId = await matchingHold();
          if (!holdId) return { confirmed: false, detail: 'native settlement hold could not be confirmed' };
        }
        // A system continuation may start between preview and native hold creation. The
        // persisted member snapshot records exactly what that hold interrupted, including
        // after a lost response. Preserve that evidence in the receipt.
        for (const id of interruptedByHold) {
          if (!automaticRunIds.has(id) && !await acceptAutomaticRun(id)) return { confirmed: false, detail: 'hold encountered an execution outside the verified turn' };
        }
        const stoppedAutomaticRunIds: string[] = [];
        for (let attempt = 0; attempt < this.cancelPollAttempts; attempt += 1) {
          const live = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}/live-runs`);
          if (!Array.isArray(live)) throw new Error('native execution status is unavailable');
          if (live.some(run => !automaticRunIds.has(String(run?.id)))) return { confirmed: false, detail: 'unexpected execution appeared during settlement' };
          if (live.length === 0) {
            for (const id of automaticRunIds) {
              const automaticStatus = str((await readRun(id)).status);
              if (!automaticStatus || !isTerminalRunStatus(automaticStatus)) return { confirmed: false, detail: 'automatic continuation terminal status is unconfirmed' };
              if (automaticStatus === 'cancelled') stoppedAutomaticRunIds.push(id);
            }
            return { confirmed: true, status, holdId, stoppedAutomaticRunIds };
          }
          if (this.cancelPollDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.cancelPollDelayMs));
        }
        return { confirmed: false, detail: 'automatic continuation has not yet stopped' };
      } catch (error) {
        return { confirmed: false, detail: error instanceof Error ? error.message : 'native settlement is unconfirmed' };
      }
    });
  }

  private async operationDispatchResult(issueId: string, agentId: string, operationId?: string, firstCommentId?: string): Promise<DispatchResult> {
    const operation = operationId ? await this.operationStore?.read(operationId) : null;
    const runAttribution: RunAttribution | undefined = !operation
      ? firstCommentId ? { kind: 'comment', commentId: firstCommentId } : undefined
      : operation.request.issueId === null && operation.request.deliveryMode !== 'comment'
        ? { kind: 'first_turn' }
        : operation.commentId
          ? { kind: 'comment', commentId: operation.commentId }
          : { kind: 'unattributable' };
    if (runAttribution?.kind === 'unattributable') {
      return { status: 'queued', issueId, agentId, detail: 'message delivered; exact comment run is not yet attributable', runAttribution };
    }
    const commentId = runAttribution?.kind === 'first_turn' ? null
      : runAttribution?.kind === 'comment' ? runAttribution.commentId : undefined;
    const run = await this.findActiveRun(issueId, agentId, commentId);
    if (run) {
      if (operationId) await this.operationStore?.recordRun(operationId, run.runId);
      return { status: 'dispatched', issueId, agentId, run, ...(runAttribution ? { runAttribution } : {}) };
    }
    return { status: 'queued', issueId, agentId, detail: 'message delivered; agent run not yet visible', ...(runAttribution ? { runAttribution } : {}) };
  }

  private async waitForConfirmedOperation(operationId: string): Promise<ConversationOperationSnapshot> {
    if (!this.operationStore) throw new Error('conversation operation recovery is unavailable');
    let snapshot = await this.operationStore.read(operationId);
    for (let attempt = 0; !snapshot.deliveryConfirmed && attempt + 1 < this.operationDiscoveryAttempts; attempt += 1) {
      if (this.operationDiscoveryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.operationDiscoveryDelayMs));
      snapshot = await this.operationStore.read(operationId);
    }
    return snapshot;
  }

  /** A different request (or a process that died after reserving) crossed the
   *  no-replay boundary. Recover only attributable upstream state; never send
   *  the message again. */
  private async recoverStartedOperation(
    operation: ConversationOperationSnapshot,
    companyId: string,
    agentId: string,
  ): Promise<DispatchResult> {
    let snapshot = operation;
    if (!snapshot.deliveryConfirmed) {
      if (snapshot.request.deliveryMode === 'comment') {
        try {
          if (!snapshot.issueId) await this.recoverOperationIssue(snapshot);
          snapshot = await this.waitForConfirmedOperation(snapshot.request.operationId);
          if (!snapshot.deliveryConfirmed) await this.recoverOperationComment(snapshot);
          snapshot = await this.operationStore!.read(snapshot.request.operationId);
        } catch (error) {
          await this.operationStore!.recordUncertain(snapshot.request.operationId,
            error instanceof Error ? error.message : 'comment recovery failed');
        }
      } else if (!snapshot.request.issueId) {
        try {
          await this.recoverOperationIssue(snapshot);
          snapshot = await this.operationStore!.read(snapshot.request.operationId);
        } catch (error) {
          await this.operationStore!.recordUncertain(snapshot.request.operationId,
            error instanceof Error ? error.message : 'operation recovery failed');
          return { status: 'error', code: 'operation_uncertain', detail: 'operation outcome is uncertain; duplicate delivery was refused' };
        }
      } else {
        snapshot = await this.waitForConfirmedOperation(snapshot.request.operationId);
      }
      if (!snapshot.deliveryConfirmed) {
        await this.operationStore!.recordUncertain(snapshot.request.operationId,
          'upstream mutation started but no attributable result was found');
        return { status: 'error', code: 'operation_uncertain', detail: 'operation outcome is uncertain; duplicate delivery was refused' };
      }
    }
    const issueId = snapshot.issueId;
    if (!issueId) return { status: 'error', code: 'operation_uncertain', detail: 'operation issue identity is missing' };
    try { await this.readBoundIssue(companyId, agentId, issueId); }
    catch (error) { return { status: 'error', detail: error instanceof Error ? error.message : 'conversation issue could not be read' }; }
    return this.operationDispatchResult(issueId, agentId, snapshot.request.operationId);
  }

  /** A new conversation is a passive container followed by exactly one comment wake. Each
   * upstream mutation has its own durable boundary; recovering a container never confirms or
   * replays a comment whose outcome is unknown. Old todo-creation journals keep their path below. */
  private async dispatchCommentTurn(input: DispatchInput, initial: ConversationOperationSnapshot | null): Promise<DispatchResult> {
    const companyId = input.companyId.trim();
    const agentId = input.agentId.trim();
    let operation = initial;
    const operationId = operation?.request.operationId;
    if (operation?.deliveryConfirmed || operation?.commentStarted) return this.recoverStartedOperation(operation, companyId, agentId);
    let issueId = operation?.issueId ?? str(input.issueId);
    if (!issueId) {
      if (operation?.mutationStarted) {
        await this.recoverOperationIssue(operation);
        operation = await this.operationStore!.read(operationId!);
        issueId = operation.issueId;
        if (!issueId) return this.recoverStartedOperation(operation, companyId, agentId);
      } else {
        let labelIds = input.labelIds;
        if (operation) {
          const labelId = operation.labelId ?? await this.ensureOperationLabel(companyId, operationId!);
          if (!labelId) {
            await this.operationStore!.recordRejected(operationId!, 'operation label unavailable before mutation');
            return { status: 'error', detail: 'operation label unavailable before mutation' };
          }
          await this.operationStore!.recordLabel(operationId!, labelId);
          labelIds = [...new Set([...(labelIds ?? []), labelId])];
          if (!await this.operationStore!.beginMutation(operationId!)) {
            return this.dispatchCommentTurn(input, await this.operationStore!.read(operationId!));
          }
        }
        const created = await this.postJson(`/api/companies/${encodeURIComponent(companyId)}/issues`, {
          title: str(input.title) ?? `对话 · ${agentId.slice(0, 8)}`,
          description: input.message,
          assigneeAgentId: agentId,
          status: 'backlog',
          ...(labelIds?.length ? { labelIds } : {}),
        });
        const body = created.body && typeof created.body === 'object' && !Array.isArray(created.body)
          ? created.body as Record<string, unknown> : null;
        const nested = body?.issue && typeof body.issue === 'object' ? body.issue as Record<string, unknown> : null;
        issueId = created.ok ? str(body?.id) ?? str(nested?.id) : null;
        if (issueId) {
          await this.readBoundIssue(companyId, agentId, issueId);
          if (operation) await this.operationStore!.recordContainer(operationId!, issueId);
        } else if (operation) {
          await this.recoverOperationIssue(await this.operationStore!.read(operationId!));
          operation = await this.operationStore!.read(operationId!);
          issueId = operation.issueId;
        }
        if (!issueId) {
          const detail = created.ok ? 'create issue: no issue id in response'
            : created.status === 0 ? 'create issue failed (upstream unreachable)' : `create issue failed (upstream ${created.status})`;
          if (operation) {
            if (created.status >= 400 && created.status < 500) await this.operationStore!.recordRejected(operationId!, detail);
            else await this.operationStore!.recordUncertain(operationId!, detail);
          }
          return { status: 'error', ...(operation && !(created.status >= 400 && created.status < 500) ? { code: 'operation_uncertain' as const } : {}), detail };
        }
      }
    }
    const issue = await this.readBoundIssue(companyId, agentId, issueId);
    if (issue.status === 'cancelled') {
      if (operation) await this.operationStore!.recordRejected(operationId!, 'cancelled conversation requires the dedicated restore flow');
      return { status: 'error', detail: 'cancelled conversation requires the dedicated restore flow' };
    }
    if (!['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'].includes(String(issue.status))) {
      return { status: 'error', detail: 'invalid conversation issue status' };
    }
    const holdRelease = await this.releaseCanvasStopHolds(issueId, companyId);
    if (holdRelease === 'failed' || holdRelease === 'blocked') return { status: 'error', detail: holdRelease === 'blocked'
      ? 'conversation is paused by an operator hold' : 'canvas pause state or release could not be confirmed' };
    if (operation) {
      if (!await this.operationStore!.beginComment(operationId!)) {
        return this.recoverStartedOperation(await this.operationStore!.read(operationId!), companyId, agentId);
      }
      operation = await this.operationStore!.read(operationId!);
    }
    const commentBody = {
      body: input.message,
      ...(issue.status === 'done' || issue.status === 'blocked' ? { resume: true } : {}),
      ...(operation ? { metadata: this.commentMetadata(operation) } : {}),
    };
    let commented = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, commentBody);
    const firstReason = commented.body && typeof commented.body === 'object'
      ? str((commented.body as Record<string, unknown>).error) : null;
    // This explicit upstream 409 precedes comment insertion. It is the sole safe resend:
    // release only our own hold, then retry the same operation once.
    if (!commented.ok && commented.status === 409 && firstReason?.includes('active subtree pause hold')) {
      if (await this.releaseCanvasStopHolds(issueId, companyId) === 'released') {
        commented = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, commentBody);
      }
    }
    const commentId = commented.ok && commented.body && typeof commented.body === 'object' && !Array.isArray(commented.body)
      ? str((commented.body as Record<string, unknown>).id) : null;
    if (commentId) {
      this.latestCommentByIssue.set(issueId, commentId);
      if (operation) await this.operationStore!.recordIssue(operationId!, issueId, commentId);
      return this.operationDispatchResult(issueId, agentId, operationId, commentId);
    }
    if (operation) {
      try {
        if (await this.recoverOperationComment(operation)) return this.operationDispatchResult(issueId, agentId, operationId);
      } catch { /* No mutation is repeated when readback is unavailable or ambiguous. */ }
    }
    const reason = commented.body && typeof commented.body === 'object'
      ? str((commented.body as Record<string, unknown>).error)?.slice(0, 500) : null;
    const detail = commented.ok ? 'comment response omitted its identity'
      : commented.status === 0 ? 'comment failed (upstream unreachable)'
        : `comment failed (upstream ${commented.status})${reason ? `: ${reason}` : ''}`;
    const rejected = commented.status >= 400 && commented.status < 500;
    if (operation) {
      if (rejected) await this.operationStore!.recordRejected(operationId!, detail);
      else await this.operationStore!.recordUncertain(operationId!, detail);
    }
    return { status: 'error', ...(operation && !rejected ? { code: 'operation_uncertain' as const } : {}), detail };
  }

  /** Ensure the conversation issue + deliver the message to the target agent.
   *  Never throws — returns an honest tri-state outcome. Does NOT block on the
   *  run appearing (a 'queued' result means the message landed, not that it ran;
   *  the caller streams the run via WS or re-polls findActiveRun). */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    return withConversationMutation(input.companyId, input.agentId, () => this.dispatchUnlocked(input));
  }

  private async dispatchUnlocked(input: DispatchInput): Promise<DispatchResult> {
    const companyId = str(input.companyId);
    const agentId = str(input.agentId);
    // Validate emptiness on the trimmed form, but SEND the original message
    // verbatim — never silently strip a user's leading/trailing whitespace or
    // newlines (e.g. a pasted code block).
    const message = typeof input.message === 'string' ? input.message : '';
    if (!companyId) return { status: 'error', detail: 'missing companyId' };
    if (!agentId) return { status: 'error', detail: 'missing agentId' };
    if (!message.trim()) return { status: 'error', detail: 'empty message' };

    let operation: ConversationOperationSnapshot | null = null;
    if (input.operationId) {
      try {
        operation = (await this.prepareConversationOperation(input))?.snapshot ?? null;
      } catch (error) {
        return error instanceof ConversationOperationConflictError
          ? { status: 'error', code: 'operation_conflict', detail: error.message }
          : { status: 'error', detail: error instanceof Error ? error.message : 'operation claim failed' };
      }
      if (!operation) return { status: 'error', detail: 'operation claim failed' };
      if (operation.phase === 'rejected') return { status: 'error', detail: operation.detail ?? 'upstream rejected the operation' };
      if (operation.request.deliveryMode === 'comment') {
        try { return await this.dispatchCommentTurn(input, operation); }
        catch (error) {
          const snapshot = await this.operationStore!.read(operation.request.operationId);
          const detail = error instanceof Error ? error.message : 'conversation dispatch could not be confirmed';
          if (snapshot.mutationStarted) await this.operationStore!.recordUncertain(operation.request.operationId, detail);
          return { status: 'error', ...(snapshot.mutationStarted ? { code: 'operation_uncertain' as const } : {}), detail };
        }
      }
      if (operation.deliveryConfirmed || operation.mutationStarted) {
        return this.recoverStartedOperation(operation, companyId, agentId);
      }
    }

    if (!operation && !str(input.issueId)) {
      try { return await this.dispatchCommentTurn(input, null); }
      catch (error) { return { status: 'error', detail: error instanceof Error ? error.message : 'conversation issue could not be read' }; }
    }

    let issueId = str(input.issueId);
    let acceptedCommentId: string | undefined;
    if (issueId) {
      // Read before writing: never continue a reassigned or cross-company issue.
      let issue: Record<string, unknown>;
      try { issue = await this.readBoundIssue(companyId, agentId, issueId); }
      catch (error) {
        const detail = error instanceof Error ? error.message : 'conversation issue could not be read';
        if (operation && detail === 'conversation issue no longer belongs to this company and agent') {
          await this.operationStore!.recordRejected(operation.request.operationId, detail);
        }
        if (detail === 'conversation issue no longer belongs to this company and agent') return { status: 'error', detail };
        return { status: 'error', detail: 'conversation issue could not be read' };
      }
      if (issue.status === 'cancelled') {
        if (operation) await this.operationStore!.recordRejected(operation.request.operationId, 'cancelled conversation requires the dedicated restore flow');
        return { status: 'error', detail: 'cancelled conversation requires the dedicated restore flow' };
      }
      if (!['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'].includes(String(issue.status))) {
        if (operation) await this.operationStore!.recordRejected(operation.request.operationId, 'invalid conversation issue status');
        return { status: 'error', detail: 'invalid conversation issue status' };
      }
      const holdRelease = await this.releaseCanvasStopHolds(issueId, companyId);
      if (holdRelease === 'failed' || holdRelease === 'blocked') {
        return { status: 'error', detail: holdRelease === 'blocked'
          ? 'conversation is paused by an operator hold' : 'canvas pause state or release could not be confirmed' };
      }
      if (operation) {
        const reserved = await this.operationStore!.beginMutation(operation.request.operationId);
        if (!reserved) {
          return this.recoverStartedOperation(await this.operationStore!.read(operation.request.operationId), companyId, agentId);
        }
      }
      // The official resume gate checks dependencies and pause holds before
      // storing the comment. A rejected resume must not become an endless queue.
      let commented = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
        body: message,
        ...(issue.status === 'done' || issue.status === 'blocked' ? { resume: true } : {}),
      });
      // A gateway restart forgets its in-memory hold id. If the guarded comment says an active
      // pause hold blocked it, discover and release only holds carrying our source marker, then
      // retry the mutation once. Manual/operator holds are never bypassed.
      const firstReason = commented.body && typeof commented.body === 'object'
        ? str((commented.body as Record<string, unknown>).error) : null;
      if (!commented.ok && commented.status === 409 && firstReason?.includes('active subtree pause hold')) {
        const released = await this.releaseCanvasStopHolds(issueId, companyId);
        if (released === 'released') {
          commented = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
            body: message,
            ...(issue.status === 'done' || issue.status === 'blocked' ? { resume: true } : {}),
          });
        }
      }
      if (!commented.ok) {
        const reason = commented.body && typeof commented.body === 'object'
          ? str((commented.body as Record<string, unknown>).error)?.slice(0, 500)
          : null;
        const detail = commented.status === 0 ? 'comment failed (upstream unreachable)'
          : `comment failed (upstream ${commented.status})${reason ? `: ${reason}` : ''}`;
        if (operation) {
          if (commented.status > 0 && commented.status < 500) await this.operationStore!.recordRejected(operation.request.operationId, detail);
          else await this.operationStore!.recordUncertain(operation.request.operationId, detail);
        }
        return {
          status: 'error',
          ...(operation && (commented.status === 0 || commented.status >= 500) ? { code: 'operation_uncertain' as const } : {}),
          detail,
        };
      }
      acceptedCommentId = commented.body && typeof commented.body === 'object' && !Array.isArray(commented.body)
        ? str((commented.body as Record<string, unknown>).id) ?? undefined : undefined;
      if (acceptedCommentId) this.latestCommentByIssue.set(issueId, acceptedCommentId);
      else if (!operation) return { status: 'error', detail: 'comment response omitted its identity' };
      if (operation) {
        await this.operationStore!.recordIssue(operation.request.operationId, issueId, acceptedCommentId ?? null);
        operation = await this.operationStore!.read(operation.request.operationId);
      }
    } else {
      let labelIds = input.labelIds;
      if (operation) {
        const labelId = operation.labelId ?? await this.ensureOperationLabel(companyId, operation.request.operationId);
        if (!labelId) {
          await this.operationStore!.recordRejected(operation.request.operationId, 'operation label unavailable before mutation');
          return { status: 'error', detail: 'operation label unavailable before mutation' };
        }
        await this.operationStore!.recordLabel(operation.request.operationId, labelId);
        labelIds = [...new Set([...(labelIds ?? []), labelId])];
        const reserved = await this.operationStore!.beginMutation(operation.request.operationId);
        if (!reserved) {
          return this.recoverStartedOperation(await this.operationStore!.read(operation.request.operationId), companyId, agentId);
        }
      }
      // First turn: create the 1:1 issue assigned to the agent; status 'todo'
      // (not 'backlog') so the create auto-wakes it with the message as the body.
      const created = await this.postJson(`/api/companies/${encodeURIComponent(companyId)}/issues`, {
        title: str(input.title) ?? `对话 · ${agentId.slice(0, 8)}`,
        description: message,
        assigneeAgentId: agentId,
        status: 'todo',
        ...(labelIds?.length ? { labelIds } : {}),
      });
      if (!created.ok) {
        const detail = created.status === 0 ? 'create issue failed (upstream unreachable)' : `create issue failed (upstream ${created.status})`;
        if (operation) {
          let recovered: Record<string, unknown> | null = null;
          try { recovered = await this.recoverOperationIssue(await this.operationStore!.read(operation.request.operationId)); }
          catch { /* keep the original mutation result */ }
          if (recovered) {
            issueId = str(recovered.id);
          } else if (created.status > 0 && created.status < 500) {
            await this.operationStore!.recordRejected(operation.request.operationId, detail);
          } else {
            await this.operationStore!.recordUncertain(operation.request.operationId, detail);
            return { status: 'error', code: 'operation_uncertain', detail };
          }
        }
        if (!issueId) return { status: 'error', detail };
      }
      if (!issueId) {
        const b = (created.body ?? {}) as Record<string, unknown>;
        const nested = (b.issue ?? null) as Record<string, unknown> | null;
        issueId = str(b.id) ?? (nested ? str(nested.id) : null);
      }
      if (!issueId) {
        if (operation) await this.operationStore!.recordUncertain(operation.request.operationId, 'create issue response omitted its identity');
        return { status: 'error', ...(operation ? { code: 'operation_uncertain' as const } : {}), detail: 'create issue: no issue id in response' };
      }
      if (operation) {
        try { await this.readBoundIssue(companyId, agentId, issueId); }
        catch {
          const recovered = await this.recoverOperationIssue(await this.operationStore!.read(operation.request.operationId));
          const recoveredId = recovered ? str(recovered.id) : null;
          if (!recoveredId) {
            await this.operationStore!.recordUncertain(operation.request.operationId, 'created issue identity could not be verified');
            return { status: 'error', code: 'operation_uncertain', detail: 'created issue identity could not be verified' };
          }
          issueId = recoveredId;
        }
        await this.operationStore!.recordIssue(operation.request.operationId, issueId);
      }
    }

    return this.operationDispatchResult(issueId, agentId, operation?.request.operationId, acceptedCommentId);
  }
}
