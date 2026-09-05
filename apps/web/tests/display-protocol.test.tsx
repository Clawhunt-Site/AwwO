import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CALL_ID_SOURCES,
  CAPABILITY_TIERS,
  DisplayAccumulator,
  ID_SOURCES,
  STREAM_TYPES,
  TOOL_KINDS,
  TOOL_STATUSES,
  classifyRunDisplayEvent,
  reduceDisplayEvents,
} from '../src/displayProtocol';
import type { DisplayEvent } from '../src/displayProtocol';
import { TurnDisplay, formatUsageMeter, formatTokenCount } from '../src/ToolCallCard';
import contract from './display_contract.fixture.json';

afterEach(cleanup);

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, extra: Partial<DisplayEvent> = {}): DisplayEvent {
  seq += 1;
  return {
    schema_version: 1,
    type,
    seq,
    ts: '2026-01-01T00:00:00Z',
    runtime_id: 'codex-app-server',
    capability_tier: 'full',
    payload,
    id: seq,
    id_source: 'synthetic',
    ...extra,
  };
}

function toolCall(over: Record<string, unknown>): Record<string, unknown> {
  return {
    call_id: 'c1',
    call_id_source: 'runtime',
    name: null,
    kind: 'command',
    status: 'running',
    input: null,
    output: null,
    degraded_fields: [],
    redacted_fields: [],
    truncated: { input: false, output: false },
    ...over,
  };
}

// --- contract lock (DL2): TS vocab must match the Python source of truth -----

describe('display contract lock', () => {
  it('TS enum vocab matches the Python contract fixture', () => {
    expect([...TOOL_KINDS].sort()).toEqual([...contract.tool_kinds].sort());
    expect([...TOOL_STATUSES].sort()).toEqual([...contract.tool_statuses].sort());
    expect([...STREAM_TYPES].sort()).toEqual([...contract.stream_types].sort());
    expect([...CAPABILITY_TIERS].sort()).toEqual([...contract.capability_tiers].sort());
    expect([...CALL_ID_SOURCES].sort()).toEqual([...contract.call_id_sources].sort());
    expect([...ID_SOURCES].sort()).toEqual([...contract.id_sources].sort());
  });
});

// --- reducer aggregation -----------------------------------------------------

describe('DisplayAccumulator', () => {
  it('aggregates started -> completed into one card by call_id', () => {
    const snap = reduceDisplayEvents([
      ev('tool.started', toolCall({ call_id: 'c1', kind: 'command', input: { command: 'ls' } })),
      ev('tool.completed', toolCall({ call_id: 'c1', kind: 'command', status: 'ok', output: 'a\nb', exit_code: 0 })),
    ]);
    expect(snap.toolCards).toHaveLength(1);
    expect(snap.toolCards[0].status).toBe('ok');
    expect(snap.toolCards[0].output).toBe('a\nb');
    expect(snap.toolCards[0].exit_code).toBe(0);
  });

  it('accumulates tool.delta stdout and keeps it as a fallback output', () => {
    const acc = new DisplayAccumulator();
    acc.apply(ev('tool.started', toolCall({ call_id: 'c1' })));
    acc.apply(ev('tool.delta', { call_id: 'c1', stream_type: 'stdout', chunk: 'hel' }));
    acc.apply(ev('tool.delta', { call_id: 'c1', stream_type: 'stdout', chunk: 'lo' }));
    acc.apply(ev('tool.completed', toolCall({ call_id: 'c1', status: 'ok' }))); // no output payload
    const snap = acc.snapshot();
    expect(snap.toolCards[0].streamedOutput).toBe('hello');
  });

  it('orders cards by first-seen call_id', () => {
    const snap = reduceDisplayEvents([
      ev('tool.started', toolCall({ call_id: 'a' })),
      ev('tool.started', toolCall({ call_id: 'b' })),
      ev('tool.completed', toolCall({ call_id: 'a', status: 'ok' })),
    ]);
    expect(snap.toolCards.map((c) => c.call_id)).toEqual(['a', 'b']);
  });

  it('collects reasoning delta + completed (completed wins)', () => {
    const snap = reduceDisplayEvents([
      ev('reasoning.delta', { text: 'thin' }),
      ev('reasoning.delta', { text: 'king' }),
      ev('reasoning.completed', { text: 'final thought' }),
    ]);
    expect(snap.reasoning).toBe('final thought');
  });

  it('captures usage', () => {
    const snap = reduceDisplayEvents([ev('usage', { usage: { input_tokens: 10, output_tokens: 3 } })]);
    expect(snap.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it('is terminal-authoritative: the completed payload owns every field (no started backfill)', () => {
    // The terminal (completed) event is authoritative for input AND its governance
    // markers. A value the terminal omits/marks unavailable must NOT be re-shown
    // from the started card, and started's markers must not leak onto completed.
    const snap = reduceDisplayEvents([
      ev('tool.started', toolCall({ call_id: 'c1', kind: 'mcp', name: 'x', input: { secret: 'shown-at-start' }, redacted_fields: ['input.secret'] })),
      ev('tool.completed', toolCall({ call_id: 'c1', kind: 'mcp', name: 'x', status: 'error', input: null, degraded_fields: ['input'], redacted_fields: [] })),
    ]);
    const card = snap.toolCards[0];
    expect(card.input).toBeNull(); // not re-shown from started
    expect(card.degraded_fields).toEqual(['input']); // terminal marker wins
    expect(card.redacted_fields).toEqual([]); // started's redaction marker does not leak
  });

  it('de-dups by event id (idempotent on replay)', () => {
    const dup = ev('tool.started', toolCall({ call_id: 'c1' }));
    const snap = reduceDisplayEvents([dup, dup]);
    expect(snap.toolCards).toHaveLength(1);
  });

  it('ignores approval events (run-transcript-only, not chat)', () => {
    const snap = reduceDisplayEvents([
      ev('approval.requested', { approval_id: '1', tool_name: 'command', kind: 'command' }),
      ev('approval.resolved', { approval_id: '1', decided_by: 'kernel', decision: 'accept' }),
    ]);
    expect(snap.toolCards).toHaveLength(0);
  });

  it('records a BATCH adapter.diagnostic (DL4) — honest "no live tools"', () => {
    const snap = reduceDisplayEvents([
      ev(
        'adapter.diagnostic',
        { streaming: false, tool_lifecycle: false, reason: 'grok runs as a batch worker' },
        { capability_tier: 'batch' },
      ),
    ]);
    expect(snap.toolCards).toHaveLength(0);
    expect(snap.diagnostics).toHaveLength(1);
    expect(snap.diagnostics[0]).toEqual({
      reason: 'grok runs as a batch worker',
      capability_tier: 'batch',
      streaming: false,
      tool_lifecycle: false,
    });
  });
});

// --- component rendering ------------------------------------------------------

describe('TurnDisplay', () => {
  it('renders a command card with title and status; expands to show output', () => {
    // The projectors carry the full call on the terminal event (open-call reuse),
    // so a realistic completed payload repeats input.
    const snap = reduceDisplayEvents([
      ev('tool.started', toolCall({ call_id: 'c1', kind: 'command', input: { command: 'pytest -q' } })),
      ev('tool.completed', toolCall({ call_id: 'c1', kind: 'command', status: 'ok', input: { command: 'pytest -q' }, output: '3 passed', exit_code: 0 })),
    ]);
    render(<TurnDisplay display={snap} />);
    expect(screen.getByText('pytest -q')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
    expect(screen.getByText('exit 0')).toBeTruthy();
    // Body collapsed until clicked.
    expect(screen.queryByText('3 passed')).toBeNull();
    fireEvent.click(screen.getByText('pytest -q'));
    expect(screen.getByText('3 passed')).toBeTruthy();
  });

  it('shows honest degraded markers when a runtime gives no input/output', () => {
    const snap = reduceDisplayEvents([
      ev('tool.completed', toolCall({ call_id: 'm', kind: 'mcp', name: 'search', status: 'ok', degraded_fields: ['input', 'output'] })),
    ]);
    render(<TurnDisplay display={snap} />);
    fireEvent.click(screen.getByText('search'));
    expect(screen.getByText('此 runtime 未提供入参')).toBeTruthy();
    expect(screen.getByText('此 runtime 未提供出参')).toBeTruthy();
  });

  it('marks redacted fields', () => {
    const snap = reduceDisplayEvents([
      ev('tool.completed', toolCall({ call_id: 'c1', kind: 'command', status: 'ok', output: '[REDACTED]', redacted_fields: ['output'] })),
    ]);
    render(<TurnDisplay display={snap} />);
    expect(screen.getByText('已脱敏')).toBeTruthy();
  });

  it('renders the three tool statuses distinctly', () => {
    const snap = reduceDisplayEvents([
      ev('tool.completed', toolCall({ call_id: 'a', status: 'ok' })),
      ev('tool.completed', toolCall({ call_id: 'b', status: 'error' })),
      ev('tool.completed', toolCall({ call_id: 'c', status: 'cancelled' })),
    ]);
    render(<TurnDisplay display={snap} />);
    expect(screen.getByText('ok')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('cancelled')).toBeTruthy();
  });

  it('renders reasoning and usage', () => {
    const snap = reduceDisplayEvents([
      ev('reasoning.completed', { text: 'because' }),
      ev('usage', { usage: { input_tokens: 12, output_tokens: 4 } }),
    ]);
    render(<TurnDisplay display={snap} />);
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.getByText(/input 12/)).toBeTruthy();
    expect(screen.getByText(/output 4/)).toBeTruthy();
  });

  it('suppresses the usage row when hideUsage is set (chat owns its meta row)', () => {
    const snap = reduceDisplayEvents([ev('usage', { usage: { input_tokens: 12, output_tokens: 4 } })]);
    const { container } = render(<TurnDisplay display={snap} hideUsage />);
    // usage-only snapshot + hideUsage => nothing to render.
    expect(container.querySelector('.turn-usage')).toBeNull();
    expect(screen.queryByText(/input 12/)).toBeNull();
  });

  it('renders a BATCH diagnostic note (DL4)', () => {
    const snap = reduceDisplayEvents([
      ev(
        'adapter.diagnostic',
        { streaming: false, tool_lifecycle: false, reason: 'grok is a batch runtime; no live tools' },
        { capability_tier: 'batch' },
      ),
    ]);
    render(<TurnDisplay display={snap} />);
    expect(screen.getByTestId('turn-diagnostic')).toBeTruthy();
    expect(screen.getByText('grok is a batch runtime; no live tools')).toBeTruthy();
  });
});

// --- run-channel routing + live/snapshot reconciliation (PR-6) ---------------

describe('classifyRunDisplayEvent (run transcript routing)', () => {
  it('routes tool/reasoning/usage to the card accumulator', () => {
    for (const t of ['tool.started', 'tool.delta', 'tool.completed', 'reasoning.delta', 'reasoning.completed', 'usage']) {
      expect(classifyRunDisplayEvent(t)).toBe('card');
    }
  });

  it('routes approvals and adapter diagnostics to their own lanes', () => {
    expect(classifyRunDisplayEvent('approval.requested')).toBe('approval');
    expect(classifyRunDisplayEvent('approval.resolved')).toBe('approval');
    expect(classifyRunDisplayEvent('adapter.diagnostic')).toBe('diagnostic');
  });

  it('ignores coarse run lifecycle + text events (timeline / bare text handle those)', () => {
    for (const t of ['run.started', 'run.completed', 'command.started', 'worker.planned', 'message.delta']) {
      expect(classifyRunDisplayEvent(t)).toBeNull();
    }
  });
});

describe('run channel live + snapshot reconciliation', () => {
  it('de-dups the same SQLite-id event across the live SSE and the terminal snapshot', () => {
    // The run channel stamps id_source="sqlite" + the durable events.id. A reducer
    // shared by the live SSE and the /events/snapshot replay must show ONE card even
    // though the terminal event arrives on both paths (PR-4 SSE then PR-6 snapshot).
    const acc = new DisplayAccumulator();
    const started = ev('tool.started', toolCall({ call_id: 'c1', kind: 'command', input: { command: 'ls' } }), { id: 11, id_source: 'sqlite' });
    const completedLive = ev('tool.completed', toolCall({ call_id: 'c1', kind: 'command', status: 'ok', output: 'ok' }), { id: 12, id_source: 'sqlite' });
    const completedSnapshot = ev('tool.completed', toolCall({ call_id: 'c1', kind: 'command', status: 'ok', output: 'ok' }), { id: 12, id_source: 'sqlite' });
    acc.apply(started);
    acc.apply(completedLive);
    acc.apply(completedSnapshot); // same events.id -> ignored
    const snap = acc.snapshot();
    expect(snap.toolCards).toHaveLength(1);
    expect(snap.toolCards[0].status).toBe('ok');
  });
});

describe('formatTokenCount', () => {
  it('keeps small counts verbatim and compacts thousands/millions', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1K');
    expect(formatTokenCount(4391)).toBe('4.4K');
    expect(formatTokenCount(35710)).toBe('35.7K');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
});

describe('formatUsageMeter', () => {
  const usage = {
    input_tokens: 4391,
    output_tokens: 439,
    cache_read_input_tokens: 35710,
    cache_creation_input_tokens: 9019,
  };

  it('compacts to K with English labels and a total by default', () => {
    expect(formatUsageMeter(usage)).toBe(
      'input 4.4K · output 439 · cache read 35.7K · cache write 9K · total 49.6K',
    );
  });

  it('localizes labels and total in Chinese', () => {
    expect(formatUsageMeter(usage, 'zh')).toBe(
      '输入 4.4K · 输出 439 · 缓存读取 35.7K · 缓存创建 9K · 合计 49.6K',
    );
  });

  it('collapses provider-native key aliases to one label (codex-style keys)', () => {
    expect(formatUsageMeter({ prompt_tokens: 10, completion_tokens: 3, cached_input_tokens: 2 }, 'en')).toBe(
      'input 10 · output 3 · cache read 2 · total 15',
    );
  });

  it('renders nothing for an empty/zero usage and omits the total when no tokens', () => {
    expect(formatUsageMeter({})).toBe('');
    // a present-but-zero field shows but contributes no total
    expect(formatUsageMeter({ input_tokens: 0 })).toBe('input 0');
  });
});
