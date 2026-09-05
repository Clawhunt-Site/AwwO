// Canonical Agent Runtime Display Protocol — front-end types + aggregation reducer.
//
// The schema's single source of truth is the Python core (display_contracts.py,
// re-exported via ui_contracts.build_display_contract_payload). These TS types are
// LOCKED to it by tests/display-protocol.test.tsx (which diffs the enum vocab
// against tests/display_contract.fixture.json) — the front end never re-derives
// tool/runtime semantics on its own (design doc §3 / DL2).
//
// First principle — Full Disclosure: render every field the runtime provided;
// surface what it could not as a "degraded" marker. Never fabricate.

// Enum vocab as runtime arrays so a test can lock them against the Python
// contract (tests/display_contract.fixture.json); the union types are DERIVED
// from these, never hand-written in parallel (DL2 — no second semantic source).
export const TOOL_STATUSES = ['running', 'ok', 'error', 'cancelled'] as const;
export const TOOL_KINDS = ['command', 'file', 'mcp', 'builtin', 'approval', 'unknown'] as const;
export const STREAM_TYPES = ['stdout', 'stderr', 'patch', 'result', 'log', 'progress'] as const;
export const CAPABILITY_TIERS = ['full', 'partial', 'batch'] as const;
export const CALL_ID_SOURCES = ['runtime', 'projector_synthesized'] as const;
export const ID_SOURCES = ['sqlite', 'synthetic', 'none'] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];
export type ToolKind = (typeof TOOL_KINDS)[number];
export type StreamType = (typeof STREAM_TYPES)[number];
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export interface ToolCall {
  call_id: string;
  call_id_source: 'runtime' | 'projector_synthesized';
  name: string | null;
  kind: ToolKind;
  status: ToolStatus;
  input: unknown;
  output: unknown;
  degraded_fields: string[];
  redacted_fields: string[];
  truncated: { input: boolean; output: boolean };
  artifact_refs?: unknown[] | null;
  exit_code?: number | null;
  duration_ms?: number | null;
}

export interface DisplayEvent {
  schema_version: number;
  type: string;
  seq: number;
  ts: string;
  runtime_id: string;
  capability_tier: CapabilityTier;
  payload: Record<string, unknown>;
  session_id?: string;
  run_id?: string;
  turn_id?: string;
  id?: number | string;
  id_source?: 'sqlite' | 'synthetic' | 'none';
}

// A rendered tool card: the canonical ToolCall plus the live stdout/patch the
// projector streamed as tool.delta before the completed payload arrived.
export interface ToolCardView extends ToolCall {
  streamedOutput: string;
  capability_tier: CapabilityTier;
}

export type UsageView = Record<string, unknown>;

// A BATCH-runtime diagnostic (DL4): a non-streaming backend emits no tool.* live;
// this is the honest "why" the surface shows instead of fabricating tool traces.
export interface DiagnosticView {
  reason: string;
  capability_tier: CapabilityTier;
  streaming: boolean;
  tool_lifecycle: boolean;
}

export interface DisplaySnapshot {
  toolCards: ToolCardView[];
  reasoning: string;
  usage: UsageView | null;
  diagnostics: DiagnosticView[];
}

// Canonical event-type strings the chat surface acts on. Approval events are
// deliberately NOT consumed here — they are classified separately by
// classifyRunDisplayEvent (no surface currently renders them); the chat surface
// only renders tool/reasoning/usage.
const TOOL_STARTED = 'tool.started';
const TOOL_DELTA = 'tool.delta';
const TOOL_COMPLETED = 'tool.completed';
const REASONING_DELTA = 'reasoning.delta';
const REASONING_COMPLETED = 'reasoning.completed';
const USAGE = 'usage';
const ADAPTER_DIAGNOSTIC = 'adapter.diagnostic';

export function isDisplayProtocolEvent(type: string): boolean {
  return (
    type === TOOL_STARTED ||
    type === TOOL_DELTA ||
    type === TOOL_COMPLETED ||
    type === REASONING_DELTA ||
    type === REASONING_COMPLETED ||
    type === USAGE
  );
}

// The chat surface consumes the tool/reasoning/usage set PLUS adapter.diagnostic
// (BATCH runtime note). Kept separate from isDisplayProtocolEvent so the run-channel
// classifyRunDisplayEvent still keeps diagnostic in its own category (not the 'card'
// path) — see the classify comment below for who currently renders each category.
export function isChatDisplayEvent(type: string): boolean {
  return isDisplayProtocolEvent(type) || type === ADAPTER_DIAGNOSTIC;
}

// 把一条 run 通道 canonical 事件分到一个类别。当前消费者是 chat（App.tsx 的
// DisplayAccumulator + ToolCallCard），它只渲染 'card'（工具卡/推理/usage）。
// 'approval'（审批，DL7）/ 'diagnostic'（adapter 诊断，DL4/DL8）是完整的分类
// 契约保留项——目前没有表层渲染它们（其历史审批/诊断渲染面板已移除），
// 但分类器保持完整以便未来表层复用；'card' 以外的类别此刻不产生 UI。
//   null → 本通道不消费（如 message.*、run.*，由别处处理）
export function classifyRunDisplayEvent(type: string): 'card' | 'approval' | 'diagnostic' | null {
  if (isDisplayProtocolEvent(type)) return 'card';
  if (type === 'approval.requested' || type === 'approval.resolved') return 'approval';
  if (type === 'adapter.diagnostic') return 'diagnostic';
  return null;
}

function asToolCall(payload: Record<string, unknown>): ToolCardView {
  const truncated = (payload.truncated as { input?: boolean; output?: boolean }) ?? {};
  return {
    call_id: String(payload.call_id ?? ''),
    call_id_source: (payload.call_id_source as ToolCall['call_id_source']) ?? 'runtime',
    name: (payload.name as string | null) ?? null,
    kind: (payload.kind as ToolKind) ?? 'unknown',
    status: (payload.status as ToolStatus) ?? 'running',
    input: payload.input ?? null,
    output: payload.output ?? null,
    degraded_fields: Array.isArray(payload.degraded_fields) ? (payload.degraded_fields as string[]) : [],
    redacted_fields: Array.isArray(payload.redacted_fields) ? (payload.redacted_fields as string[]) : [],
    truncated: { input: Boolean(truncated.input), output: Boolean(truncated.output) },
    artifact_refs: (payload.artifact_refs as unknown[] | null) ?? null,
    exit_code: (payload.exit_code as number | null) ?? null,
    duration_ms: (payload.duration_ms as number | null) ?? null,
    streamedOutput: '',
    capability_tier: 'full',
  };
}

/**
 * Aggregates canonical DisplayEvents into renderable chat state. Tool cards are
 * keyed by call_id (started → delta* → completed three-phase); events are
 * de-duplicated by `id` so a shared reducer is safe on a channel that may replay
 * (the chat channel is single-FIFO so it never does, but the run channel will).
 *
 * Internally mutable for the live streaming closure; `snapshot()` returns fresh
 * objects each call so React re-renders on change.
 */
export class DisplayAccumulator {
  private order: string[] = [];
  private cards = new Map<string, ToolCardView>();
  private seenIds = new Set<string>();
  private reasoningText = '';
  private usageView: UsageView | null = null;
  private diagnosticList: DiagnosticView[] = [];

  apply(event: DisplayEvent): void {
    if (!event || typeof event.type !== 'string') return;
    if (!isChatDisplayEvent(event.type)) return;
    // De-dup by event identity when present (idempotent on replay/reconnect).
    if (event.id !== undefined && event.id !== null) {
      const key = `${event.id}`;
      if (this.seenIds.has(key)) return;
      this.seenIds.add(key);
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const tier = event.capability_tier ?? 'full';
    switch (event.type) {
      case TOOL_STARTED: {
        const card = asToolCall(payload);
        card.capability_tier = tier;
        if (!card.call_id) return;
        if (!this.cards.has(card.call_id)) this.order.push(card.call_id);
        // Preserve any streamed output already buffered for this call_id.
        const prior = this.cards.get(card.call_id);
        card.streamedOutput = prior?.streamedOutput ?? '';
        this.cards.set(card.call_id, card);
        break;
      }
      case TOOL_DELTA: {
        const callId = String(payload.call_id ?? '');
        const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
        if (!callId || !chunk) return;
        let card = this.cards.get(callId);
        if (!card) {
          // delta before started: create a minimal running card so output is not lost.
          card = asToolCall({ call_id: callId });
          card.capability_tier = tier;
          this.order.push(callId);
        } else {
          card = { ...card };
        }
        card.streamedOutput = (card.streamedOutput ?? '') + chunk;
        this.cards.set(callId, card);
        break;
      }
      case TOOL_COMPLETED: {
        const done = asToolCall(payload);
        done.capability_tier = tier;
        if (!done.call_id) return;
        const prior = this.cards.get(done.call_id);
        // Keep the live-streamed output (already redacted per-chunk by the
        // projector) as a fallback when the completed payload carries none —
        // Full Disclosure: don't drop output we already showed.
        done.streamedOutput = prior?.streamedOutput ?? '';
        // The completed payload is AUTHORITATIVE for every field — input, name,
        // and the governance markers (degraded_fields/redacted_fields/truncated)
        // all come from it. We deliberately do NOT backfill input/name from the
        // started card: doing so could re-show a value the terminal marked
        // unavailable, or show a value while dropping its 已脱敏/已截断 marker
        // (the markers live on the completed payload). The projectors guarantee
        // the terminal carries the full call (codex/claude reuse the open call),
        // so terminal-authoritative is both correct and complete.
        if (!this.cards.has(done.call_id)) this.order.push(done.call_id);
        this.cards.set(done.call_id, done);
        break;
      }
      case REASONING_DELTA: {
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.reasoningText += text;
        break;
      }
      case REASONING_COMPLETED: {
        const text = typeof payload.text === 'string' ? payload.text : '';
        // The completed reasoning is authoritative over the streamed deltas.
        if (text) this.reasoningText = text;
        break;
      }
      case USAGE: {
        const usage = payload.usage;
        if (usage && typeof usage === 'object') this.usageView = usage as UsageView;
        break;
      }
      case ADAPTER_DIAGNOSTIC: {
        // BATCH runtime note (DL4): record the honest "no live tools" reason.
        this.diagnosticList.push({
          reason: typeof payload.reason === 'string' ? payload.reason : '',
          capability_tier: tier,
          streaming: payload.streaming === true,
          tool_lifecycle: payload.tool_lifecycle === true,
        });
        break;
      }
    }
  }

  hasContent(): boolean {
    return (
      this.order.length > 0 ||
      this.reasoningText.length > 0 ||
      this.usageView !== null ||
      this.diagnosticList.length > 0
    );
  }

  snapshot(): DisplaySnapshot {
    return {
      toolCards: this.order.map((id) => ({ ...(this.cards.get(id) as ToolCardView) })),
      reasoning: this.reasoningText,
      usage: this.usageView,
      diagnostics: this.diagnosticList.map((d) => ({ ...d })),
    };
  }
}

/** Pure batch fold — convenience for tests and non-streaming callers. */
export function reduceDisplayEvents(events: DisplayEvent[]): DisplaySnapshot {
  const acc = new DisplayAccumulator();
  for (const ev of events) acc.apply(ev);
  return acc.snapshot();
}
