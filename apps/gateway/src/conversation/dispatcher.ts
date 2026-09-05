// P3d — real per-agent conversation dispatcher (gateway BFF, ZERO server/ change).
//
// "Talk to a specific hired agent" is delivered entirely through already-mounted,
// NON-local_trusted-gated upstream /api primitives — NOT /chat/stream (which binds
// a synthetic per-adapter "Chat Assistant" and is fail-closed to chat-eligible
// adapters). Mechanism:
//   1. ensure a DEDICATED 1:1 issue assigned to the target agent (assigneeAgentId);
//      creating it with status:'todo' auto-wakes the agent with the message as body.
//   2. subsequent turns verify the issue binding, then POST a comment; finished
//      or blocked issues use the upstream's guarded explicit resume intent.
//   3. discover the agent's active run (id) via GET /issues/:id/live-runs.
//
// The agent that wakes is the REAL hired worker (not a chat charter): its reply is
// task-execution and it may do real, governed work. This layer is honest about the
// outcome (dispatched / queued / skipped / error) and NEVER fakes a "sent".
//
// The upstream is an opaque loopback HTTP dependency — we never import its source
// (same contract as upstream.ts / mission/upstream-reader.ts).

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

export type DispatchResult =
  // Wake triggered AND the agent's run is already visible — stream/read it by runId.
  | { status: 'dispatched'; issueId: string; agentId: string; run: ActiveRun }
  // Message accepted but no run visible yet (async spin-up, busy, or wake skipped).
  // Delivery alone does not prove that the agent was woken.
  | { status: 'queued'; issueId: string; agentId: string; detail: string }
  // The upstream call failed (network / non-2xx). Nothing was reliably delivered.
  | { status: 'error'; detail: string };

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
}

export class AgentConversationDispatcher {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    upstreamBaseUrl: string,
    opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.base = upstreamBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
  async findActiveRun(issueId: string, agentId: string): Promise<ActiveRun | null> {
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
      if (runId && runAgentId === agentId && (status === 'queued' || status === 'running')) {
        return { runId, status, agentId, adapterType: str(r?.adapterType) };
      }
    }
    return null;
  }

  /** Ensure the conversation issue + deliver the message to the target agent.
   *  Never throws — returns an honest tri-state outcome. Does NOT block on the
   *  run appearing (a 'queued' result means the message landed, not that it ran;
   *  the caller streams the run via WS or re-polls findActiveRun). */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const companyId = str(input.companyId);
    const agentId = str(input.agentId);
    // Validate emptiness on the trimmed form, but SEND the original message
    // verbatim — never silently strip a user's leading/trailing whitespace or
    // newlines (e.g. a pasted code block).
    const message = typeof input.message === 'string' ? input.message : '';
    if (!companyId) return { status: 'error', detail: 'missing companyId' };
    if (!agentId) return { status: 'error', detail: 'missing agentId' };
    if (!message.trim()) return { status: 'error', detail: 'empty message' };

    let issueId = str(input.issueId);
    if (issueId) {
      // Read before writing: never continue a reassigned or cross-company issue.
      let existing: unknown;
      try {
        existing = await this.getJson(`/api/issues/${encodeURIComponent(issueId)}`);
      } catch {
        return { status: 'error', detail: 'conversation issue could not be read' };
      }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        return { status: 'error', detail: 'invalid conversation issue response' };
      }
      const issue = existing as Record<string, unknown>;
      if (issue.id !== issueId || issue.companyId !== companyId || issue.assigneeAgentId !== agentId) {
        return { status: 'error', detail: 'conversation issue no longer belongs to this company and agent' };
      }
      if (issue.status === 'cancelled') {
        return { status: 'error', detail: 'cancelled conversation requires the dedicated restore flow' };
      }
      if (!['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'].includes(String(issue.status))) {
        return { status: 'error', detail: 'invalid conversation issue status' };
      }
      // The official resume gate checks dependencies and pause holds before
      // storing the comment. A rejected resume must not become an endless queue.
      const commented = await this.postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
        body: message,
        ...(issue.status === 'done' || issue.status === 'blocked' ? { resume: true } : {}),
      });
      if (!commented.ok) {
        const reason = commented.body && typeof commented.body === 'object'
          ? str((commented.body as Record<string, unknown>).error)?.slice(0, 500)
          : null;
        return {
          status: 'error',
          detail: commented.status === 0 ? 'comment failed (upstream unreachable)'
            : `comment failed (upstream ${commented.status})${reason ? `: ${reason}` : ''}`,
        };
      }
    } else {
      // First turn: create the 1:1 issue assigned to the agent; status 'todo'
      // (not 'backlog') so the create auto-wakes it with the message as the body.
      const created = await this.postJson(`/api/companies/${encodeURIComponent(companyId)}/issues`, {
        title: str(input.title) ?? `对话 · ${agentId.slice(0, 8)}`,
        description: message,
        assigneeAgentId: agentId,
        status: 'todo',
        ...(input.labelIds?.length ? { labelIds: input.labelIds } : {}),
      });
      if (!created.ok) {
        return { status: 'error', detail: created.status === 0 ? 'create issue failed (upstream unreachable)' : `create issue failed (upstream ${created.status})` };
      }
      const b = (created.body ?? {}) as Record<string, unknown>;
      const nested = (b.issue ?? null) as Record<string, unknown> | null;
      issueId = str(b.id) ?? (nested ? str(nested.id) : null);
      if (!issueId) return { status: 'error', detail: 'create issue: no issue id in response' };
    }

    // The wake is async; the run may not be visible on the first read. Report it
    // honestly as 'queued' rather than blocking or faking — the streaming layer
    // (subscribe-before-wake) catches the run event; this poll is a fast-path.
    const run = await this.findActiveRun(issueId, agentId);
    if (run) return { status: 'dispatched', issueId, agentId, run };
    return { status: 'queued', issueId, agentId, detail: 'message delivered; agent run not yet visible' };
  }
}
