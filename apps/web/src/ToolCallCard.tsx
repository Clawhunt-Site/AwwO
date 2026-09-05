// Renders ONE canonical tool call (Display Protocol §8). Pure presentation: it
// never infers tool semantics — kind/status/degraded all come from the projector.
// Shows name + kind icon + status, expandable input/output, command stdout,
// duration/exit_code, and honest degraded/redacted/truncated markers.
import { useState } from 'react';
import {
  Terminal,
  FileDiff,
  Plug,
  Wrench,
  ShieldCheck,
  CircleHelp,
  ChevronRight,
  LoaderCircle,
  Check,
  X,
  Ban,
  Brain,
  Info,
} from 'lucide-react';
import type { DisplaySnapshot, ToolCardView, ToolKind, ToolStatus, UsageView } from './displayProtocol';

const KIND_ICON: Record<ToolKind, typeof Terminal> = {
  command: Terminal,
  file: FileDiff,
  mcp: Plug,
  builtin: Wrench,
  approval: ShieldCheck,
  unknown: CircleHelp,
};

function statusIcon(status: ToolStatus) {
  if (status === 'running') return <LoaderCircle size={12} className="spin" aria-hidden="true" />;
  if (status === 'ok') return <Check size={12} aria-hidden="true" />;
  if (status === 'error') return <X size={12} aria-hidden="true" />;
  return <Ban size={12} aria-hidden="true" />; // cancelled
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Short human title from kind + the strongly-typed input (front end derives the
// title from `kind`, per DL6 — no `display{}` sub-object on the wire).
export function cardTitle(card: ToolCardView): string {
  const input = card.input as Record<string, unknown> | null;
  if (card.kind === 'command') {
    const cmd = input && typeof input.command === 'string' ? input.command : '';
    return cmd || card.name || 'command';
  }
  if (card.kind === 'file') {
    const path = input && typeof input.path === 'string' ? input.path : '';
    return path || card.name || 'file change';
  }
  return card.name || card.kind;
}

// The output worth showing: completed output, else the live-streamed stdout.
function cardOutput(card: ToolCardView): string {
  const out = stringify(card.output);
  if (out) return out;
  return card.streamedOutput ?? '';
}

export function ToolCallCard({ card }: { card: ToolCardView }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[card.kind] ?? CircleHelp;
  const title = cardTitle(card);
  const output = cardOutput(card);
  const inputText = stringify(card.input);
  const hasBody = Boolean(inputText) || Boolean(output) || card.degraded_fields.length > 0;
  const degradedInput = card.degraded_fields.some((f) => f === 'input' || f.startsWith('input'));
  const degradedOutput = card.degraded_fields.some((f) => f === 'output' || f.startsWith('output'));

  return (
    <div className={`tool-card tool-${card.kind} tool-status-${card.status}`} data-testid="tool-card">
      <button
        type="button"
        className="tool-card-head"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
      >
        {hasBody ? (
          <ChevronRight size={13} className={`tool-card-chevron ${open ? 'open' : ''}`} aria-hidden="true" />
        ) : (
          <span className="tool-card-chevron-spacer" aria-hidden="true" />
        )}
        <Icon size={13} className="tool-card-kind-icon" aria-hidden="true" />
        <span className="tool-card-title" title={title}>
          {title}
        </span>
        <span className={`tool-card-status tone-${card.status}`}>
          {statusIcon(card.status)}
          <span>{card.status}</span>
        </span>
        {typeof card.exit_code === 'number' ? (
          <span className="tool-card-exit">exit {card.exit_code}</span>
        ) : null}
        {typeof card.duration_ms === 'number' ? (
          <span className="tool-card-duration">{Math.round(card.duration_ms)}ms</span>
        ) : null}
        {card.redacted_fields.length > 0 ? (
          <span className="tool-card-badge redacted" title={card.redacted_fields.join(', ')}>
            已脱敏
          </span>
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="tool-card-body">
          {inputText ? (
            <div className="tool-card-section">
              <div className="tool-card-section-label">
                input
                {card.truncated.input ? <span className="tool-card-trunc">已截断</span> : null}
              </div>
              <pre className="tool-card-pre">{inputText}</pre>
            </div>
          ) : degradedInput ? (
            <div className="tool-card-degraded">此 runtime 未提供入参</div>
          ) : null}
          {output ? (
            <div className="tool-card-section">
              <div className="tool-card-section-label">
                {card.kind === 'file' ? 'diff' : 'output'}
                {card.truncated.output ? <span className="tool-card-trunc">已截断</span> : null}
              </div>
              <pre className="tool-card-pre">{output}</pre>
            </div>
          ) : degradedOutput ? (
            <div className="tool-card-degraded">此 runtime 未提供出参</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-reasoning" data-testid="tool-reasoning">
      <button type="button" className="tool-reasoning-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={`tool-card-chevron ${open ? 'open' : ''}`} aria-hidden="true" />
        <Brain size={13} aria-hidden="true" />
        <span>thinking</span>
      </button>
      {open ? <pre className="tool-card-pre tool-reasoning-body">{text}</pre> : null}
    </div>
  );
}

// 1234 -> 1.2K, 999 -> 999, 1_500_000 -> 1.5M. Token counts in the chat metering
// row read far easier compact than as raw digits; the exact value stays available
// on the row's title attribute. Mirrors the CLI `_format_token_count`.
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const s = (n / 1000).toFixed(1);
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'K';
  }
  const s = (n / 1_000_000).toFixed(1);
  return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'M';
}

// Ordered metering fields; provider-native key aliases collapse to one label so
// claude's cache_read_input_tokens and a codex-style cached_input_tokens render
// identically. Labels are localized; ``total`` sums the displayed fields.
const USAGE_FIELDS: Array<{ keys: string[]; zh: string; en: string }> = [
  { keys: ['input_tokens', 'prompt_tokens'], zh: '输入', en: 'input' },
  { keys: ['output_tokens', 'completion_tokens'], zh: '输出', en: 'output' },
  { keys: ['cache_read_input_tokens', 'cached_input_tokens', 'cache_read_tokens'], zh: '缓存读取', en: 'cache read' },
  { keys: ['cache_creation_input_tokens', 'cache_creation_tokens'], zh: '缓存创建', en: 'cache write' },
];

// "输入 4.4K · 输出 439 · 缓存读取 35.7K · 缓存创建 9.0K · 合计 49.6K" — the
// human-readable metering string shown in the chat turn's hover meta row.
export function formatUsageMeter(usage: UsageView, locale: 'zh' | 'en' = 'en'): string {
  const parts: string[] = [];
  let total = 0;
  let count = 0;
  for (const field of USAGE_FIELDS) {
    let value: number | undefined;
    for (const key of field.keys) {
      const candidate = usage[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
        value = candidate;
        break;
      }
    }
    if (typeof value === 'number') {
      // Truncate to an integer to match the API/CLI `int(...)` landing — token
      // counts are integers; a (hypothetical) fractional report must read the
      // same live, on reload, and in the CLI.
      const tokens = Math.trunc(value);
      parts.push(`${locale === 'zh' ? field.zh : field.en} ${formatTokenCount(tokens)}`);
      total += tokens;
      count += 1;
    }
  }
  // The total is only informative once ≥2 fields contribute; with a single field it
  // just repeats that field, so omit it (CLI _shell_turn_meter_line does the same).
  if (count >= 2 && total > 0) parts.push(`${locale === 'zh' ? '合计' : 'total'} ${formatTokenCount(total)}`);
  return parts.join(' · ');
}

// Renders a whole turn's Display Protocol snapshot: streamed reasoning (collapsed),
// canonical tool cards (by call_id), and token usage. Used in the chat surface.
// ``hideUsage`` lets the chat surface suppress the usage row here
// and render it (with timing) in its own hover meta row instead — the persisted
// metering must show on reload even when ``display`` is gone, so chat owns it.
export function TurnDisplay({
  display,
  hideUsage = false,
  locale = 'en',
}: {
  display: DisplaySnapshot;
  hideUsage?: boolean;
  locale?: 'zh' | 'en';
}) {
  const usageText = !hideUsage && display.usage ? formatUsageMeter(display.usage, locale) : '';
  const diagnostics = display.diagnostics ?? [];
  if (display.toolCards.length === 0 && !display.reasoning && !usageText && diagnostics.length === 0) return null;
  return (
    <div className="turn-display" data-testid="turn-display">
      {display.reasoning ? <ReasoningBlock text={display.reasoning} /> : null}
      {display.toolCards.map((card) => (
        <ToolCallCard key={card.call_id} card={card} />
      ))}
      {diagnostics.map((d, i) => (
        <div key={`diag-${i}`} className="turn-diagnostic" data-testid="turn-diagnostic" title={d.reason}>
          <Info size={12} aria-hidden="true" />
          <span>{d.reason || 'This runtime is batch; no live tools are surfaced.'}</span>
        </div>
      ))}
      {usageText ? (
        <div className="turn-usage" title="token usage">
          {usageText}
        </div>
      ) : null}
    </div>
  );
}
