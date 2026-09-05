// P3d — project a company's live-event WS stream into per-agent chat frames.
//
// The upstream company WS (/api/companies/:id/events/ws) is company-scoped: it
// broadcasts EVERY run's events with no server-side per-agent filter. This pure
// projector filters that firehose down to ONE conversation's run and turns its
// raw events into honest chat frames — a "light" stdout projection (owner-chosen
// over a chat.ts-quality clean stream, which would need a server/ change).
//
// Attribution is by RUN ID only. The upstream heartbeat.run.queued/status/progress
// events carry no issueId, and a bare agentId collides with the agent's other
// runs — so a bare agent/issue match is unsafe. The caller discovers the runId
// first (dispatch → findActiveRun, which reads the issue-scoped /live-runs) and
// hands it in; the WS client (part 2b) buffers pre-runId events and replays them
// once the id is known.
//
// It is deliberately transport-free (no WebSocket here): feed it decoded
// LiveEvent objects, get frames back. Zero server/ import — the event shapes and
// the claude stream-json extraction are mirrored from the upstream's public
// LIVE_EVENT contract + chat-display-projector semantics, not its source.

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Mirror the upstream heartbeat state machine. `scheduled_retry` remains live: a later
 * attempt can still execute real work, so treating it as done would unlock the canvas while
 * the native Agent is still eligible to resume. Unknown statuses are neither live nor terminal
 * until this contract is deliberately updated. */
const LIVE_RUN_STATUSES = new Set(['queued', 'scheduled_retry', 'running']);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function isLiveRunStatus(status: string): boolean {
  return LIVE_RUN_STATUSES.has(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Claude-family adapters stream Anthropic stream-json and Codex uses JSONL;
 *  every other adapter is treated as raw stdout (forwarded verbatim, NEVER parsed
 *  or dropped — a raw line that happens to look like JSON must not vanish). This
 *  is keyed off the adapter, not guessed from content. */
export function isStreamJsonAdapter(adapterType: string | null | undefined): boolean {
  return typeof adapterType === 'string' && /^(?:claude|codex)/i.test(adapterType.trim());
}

const RUN_EVENT_TYPES = new Set([
  'heartbeat.run.queued',
  'heartbeat.run.status',
  'heartbeat.run.progress',
  'heartbeat.run.event',
  'heartbeat.run.log',
]);

// The upstream redacts command text before persisting it. That text transform
// can break escaped quotes inside command_execution JSONL. Recognize only the
// anchored event/item header, before command content, to discard this known
// non-delivery event without relaxing validation of assistant or unknown lines.
const CODEX_COMMAND_EVENT_PREFIX = /^\s*\{\s*"type"\s*:\s*"item\.(?:started|updated|completed)"\s*,\s*"item"\s*:\s*\{\s*(?:"id"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*)?"type"\s*:\s*"command_execution"\s*[,}]/;

/** A decoded upstream LiveEvent frame: { type, payload }. companyId is handled by
 *  the socket (one WS per company), so the projector only needs type + payload. */
export interface LiveEventFrame {
  type?: unknown;
  payload?: unknown;
}

/** Honest chat frames emitted for the ONE conversation run being followed. */
export type ChatFrame =
  | { kind: 'delta'; text: string } // a chunk of the agent's textual output
  | { kind: 'phase'; phase: string; message: string | null } // progress note
  | { kind: 'status'; status: string } // run status transition (queued/running/…)
  | { kind: 'done'; status: string }; // terminal — the run ended (no more frames)

export interface ConversationFilter {
  /** The conversation run to follow — the ONLY reliable attribution key. */
  runId: string;
  /** The run's adapter (from /live-runs) — drives stdout decoding. */
  adapterType?: string | null;
}

/**
 * Stateful projector for a SINGLE conversation run (matched by runId). Keeps a
 * stdout line buffer so a JSON event split across log chunks is not garbled, and
 * tracks `streamedText` to dedupe the live token stream against the consolidated
 * `assistant` message (mirroring the upstream chat-display-projector).
 */
export class RunStreamProjector {
  private readonly runId: string;
  private readonly streamJson: boolean;
  private readonly codexJson: boolean;
  private done = false;
  private stdoutBuf = '';
  private streamedText = false;
  // Codex emits commentary and final answers as separate complete agent_message
  // items. Keep the last candidate, rather than appending irreversible deltas.
  private codexFinal = '';
  private codexPartial = '';
  private truncated = false;
  private malformedCodex = false;

  constructor(filter: ConversationFilter) {
    this.runId = filter.runId;
    this.streamJson = isStreamJsonAdapter(filter.adapterType);
    this.codexJson = typeof filter.adapterType === 'string' && /^codex/i.test(filter.adapterType.trim());
  }

  /** True once a terminal status has been seen — the caller should stop. */
  get isDone(): boolean {
    return this.done;
  }

  get needsLogRecovery(): boolean { return this.codexJson && this.truncated; }
  get hasMalformedCodexLog(): boolean { return this.malformedCodex; }

  /** Inspect only this run's terminal event before its pending output is emitted. */
  terminalStatus(event: LiveEventFrame): string | null {
    if (event.type !== 'heartbeat.run.status' && event.type !== 'heartbeat.run.queued') return null;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const status = str(payload.status);
    return str(payload.runId) === this.runId && status && isTerminalRunStatus(status) ? status : null;
  }

  /** A disconnected transport may expose evidence, but must not invent a done. */
  flushPartial(): ChatFrame[] {
    if (this.done) return [];
    const text = this.flushStdout('failed');
    this.done = true;
    return text ? [{ kind: 'delta', text }] : [];
  }

  handle(event: LiveEventFrame): ChatFrame[] {
    if (this.done) return [];
    const type = str(event?.type);
    if (!type || !RUN_EVENT_TYPES.has(type)) return [];
    const payload = (event?.payload ?? {}) as Record<string, unknown>;
    // Attribution by runId ONLY (queued/status carry no issueId; agentId collides).
    if (str(payload.runId) !== this.runId) return [];

    if (type === 'heartbeat.run.log') {
      if (str(payload.stream) !== 'stdout') return []; // stderr/system: not chat text
      if (this.codexJson && payload.truncated === true) {
        this.truncated = true;
        this.stdoutBuf = ''; // the gap cannot be joined to a prior partial JSON line
        return [];
      }
      return this.projectStdout(typeof payload.chunk === 'string' ? payload.chunk : '');
    }
    if (type === 'heartbeat.run.progress') {
      const phase = str(payload.phase);
      if (!phase) return [];
      return [{ kind: 'phase', phase, message: str(payload.message) }];
    }
    if (type === 'heartbeat.run.status' || type === 'heartbeat.run.queued') {
      const status = str(payload.status) ?? (type === 'heartbeat.run.queued' ? 'queued' : null);
      if (!status) return [];
      const frames: ChatFrame[] = [{ kind: 'status', status }];
      if (isTerminalRunStatus(status)) {
        const tail = this.flushStdout(status);
        if (tail) frames.unshift({ kind: 'delta', text: tail });
        this.done = true;
        frames.push({ kind: 'done', status });
      }
      return frames;
    }
    return []; // heartbeat.run.event — no chat-visible projection
  }

  private projectStdout(chunk: string): ChatFrame[] {
    this.stdoutBuf += chunk;
    const lastNl = this.stdoutBuf.lastIndexOf('\n');
    if (lastNl < 0) return []; // no complete line yet — keep buffering
    const complete = this.stdoutBuf.slice(0, lastNl + 1); // include trailing newline(s)
    this.stdoutBuf = this.stdoutBuf.slice(lastNl + 1);
    if (!this.streamJson) {
      // Raw adapter: forward the complete stdout verbatim, newlines intact.
      return complete ? [{ kind: 'delta', text: complete }] : [];
    }
    if (this.codexJson) {
      return complete.split('\n').flatMap(line => this.consumeCodexLine(line));
    }
    let text = '';
    for (const line of complete.split('\n')) text += this.extractClaudeLine(line);
    return text ? [{ kind: 'delta', text }] : [];
  }

  /** Emit the trailing buffered stdout (a final line with no newline) on terminal. */
  private flushStdout(status: string): string {
    const rem = this.stdoutBuf;
    this.stdoutBuf = '';
    if (this.codexJson) {
      if (rem) this.consumeCodexLine(rem);
      // Only the final turn's final message is consumable. On failures preserve
      // the latest assistant text as evidence; the unchanged terminal status
      // still makes execAgentViaGateway return ok=false.
      return status === 'succeeded' ? this.codexFinal : this.codexPartial;
    }
    if (!rem) return '';
    return this.streamJson ? this.extractClaudeLine(rem) : rem;
  }

  private consumeCodexLine(line: string): ChatFrame[] {
    if (!line.trimStart().startsWith('{')) return []; // runtime setup noise
    if (CODEX_COMMAND_EVENT_PREFIX.test(line.slice(0, 512))) return [];
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { this.malformedCodex = true; return []; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const event = raw as Record<string, unknown>;
    const type = str(event.type);
    if (type === 'thread.started' || type === 'turn.started') {
      // Adapter retries/continuations can contain several turns in one run.
      // A prior turn must never leak into the next turn's contract output.
      this.codexFinal = '';
      this.codexPartial = '';
      return [];
    }
    if (type !== 'item.completed') return [];
    const item = event.item as Record<string, unknown> | null | undefined;
    if (!item || str(item.type) !== 'agent_message' || typeof item.text !== 'string' || !item.text.trim()) return [];
    this.codexPartial = item.text;
    // Some versions provide phase; older JSONL does not. For phase-less events,
    // mirror the native adapter's parseCodexJsonl rule: the last message wins.
    if (str(item.phase) === 'commentary') {
      return [{ kind: 'phase', phase: 'commentary', message: item.text }];
    }
    this.codexFinal = item.text;
    // Even turn.completed is not the heartbeat terminal: a continuation may
    // follow. Emit exactly once at run terminal to avoid concatenating finals.
    return [];
  }

  /** Extract user-visible text from one claude stream-json line, mirroring
   *  chat-display-projector: live `stream_event`/`content_block_delta` text
   *  deltas, plus the consolidated `assistant` message ONLY as a fallback when no
   *  live text streamed. Non-text events (tool_use, message_start, …) yield "". */
  private extractClaudeLine(line: string): string {
    const t = line.trim();
    if (!t.startsWith('{')) return ''; // noise between JSON lines
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      return '';
    }
    const ev = parsed as Record<string, unknown>;
    const type = str(ev.type);

    if (type === 'stream_event') {
      const inner = (ev.event ?? {}) as Record<string, unknown>;
      if (str(inner.type) === 'content_block_delta') return this.textDelta(inner.delta);
      return '';
    }
    if (type === 'content_block_delta') {
      return this.textDelta(ev.delta); // some claude versions emit unwrapped
    }
    if (type === 'assistant') {
      // Consolidated message — only a fallback when nothing streamed live, else it
      // double-emits the whole reply. Text/reasoning already arrived via stream_event.
      if (this.streamedText) return '';
      const message = (ev.message ?? {}) as Record<string, unknown>;
      const content = message.content;
      if (!Array.isArray(content)) return '';
      let out = '';
      for (const raw of content) {
        const block = (raw ?? {}) as Record<string, unknown>;
        if (str(block.type) === 'text' && typeof block.text === 'string') out += block.text;
      }
      return out;
    }
    return '';
  }

  private textDelta(delta: unknown): string {
    const d = (delta ?? {}) as Record<string, unknown>;
    if (str(d.type) === 'text_delta' && typeof d.text === 'string' && d.text) {
      this.streamedText = true;
      return d.text;
    }
    return '';
  }
}
