import { describe, expect, it } from 'vitest';
import type { ChatAutomation } from './types.js';
import { advance, computeNextRunAt, dueAutomations, fireKey, isDue } from './schedule.js';

const ANCHOR = 1_000_000; // arbitrary epoch ms anchor for deterministic tests

function automation(over: Partial<ChatAutomation> = {}): ChatAutomation {
  return {
    id: 'a1',
    sessionIssueId: 'chat-issue-1',
    chatAgentId: 'agent-1',
    companyId: '00000000-c4a7-4000-a000-000000000001',
    prompt: 'morning digest',
    cadence: { kind: 'interval', intervalSec: 60 },
    timezone: 'UTC',
    enabled: true,
    nextRunAt: ANCHOR,
    lastFireKey: null,
    approvalState: 'approved',
    createdAt: ANCHOR,
    lastFiredAt: null,
    lastOutcomeOk: null,
    lastError: null,
    updatedAt: ANCHOR,
    ...over,
  };
}

describe('computeNextRunAt (interval)', () => {
  const cadence = { kind: 'interval' as const, intervalSec: 60 };

  it('returns the anchor when after is before it', () => {
    expect(computeNextRunAt(cadence, ANCHOR - 5, ANCHOR)).toBe(ANCHOR);
  });

  it('returns the next strictly-future slot on the anchored grid', () => {
    // 60s interval = 60_000ms. after = anchor + 90s -> next slot is anchor + 120s.
    expect(computeNextRunAt(cadence, ANCHOR + 90_000, ANCHOR)).toBe(ANCHOR + 120_000);
  });

  it('is strict: exactly on a slot rolls to the next one', () => {
    expect(computeNextRunAt(cadence, ANCHOR + 60_000, ANCHOR)).toBe(ANCHOR + 120_000);
  });

  it('rejects a non-positive interval', () => {
    expect(() => computeNextRunAt({ kind: 'interval', intervalSec: 0 }, ANCHOR, ANCHOR)).toThrow();
  });

  it('cron is an explicit unimplemented seam (never silently behaves like interval)', () => {
    expect(() => computeNextRunAt({ kind: 'cron', expression: '0 9 * * *' }, ANCHOR, ANCHOR)).toThrow(/cron/);
  });
});

describe('isDue — governance + exactly-once guards', () => {
  it('is due when enabled, approved, and the slot has arrived', () => {
    expect(isDue(automation({ nextRunAt: ANCHOR }), ANCHOR)).toBe(true);
    expect(isDue(automation({ nextRunAt: ANCHOR }), ANCHOR + 1)).toBe(true);
  });

  it('is NOT due before its slot', () => {
    expect(isDue(automation({ nextRunAt: ANCHOR + 60_000 }), ANCHOR)).toBe(false);
  });

  it('fail-closed: disabled never fires', () => {
    expect(isDue(automation({ enabled: false }), ANCHOR + 999_999)).toBe(false);
  });

  it('fail-closed: pending_approval never fires (waits for a human)', () => {
    expect(isDue(automation({ approvalState: 'pending_approval' }), ANCHOR + 999_999)).toBe(false);
  });

  it('exactly-once: a slot already stamped in lastFireKey is not re-fired (restart-safe)', () => {
    const a = automation({ nextRunAt: ANCHOR, lastFireKey: fireKey('a1', ANCHOR) });
    expect(isDue(a, ANCHOR + 5)).toBe(false);
  });
});

describe('advance — stamp + roll forward, no mutation', () => {
  it('stamps the fired slot key and rolls nextRunAt to the next future slot', () => {
    const a = automation({ nextRunAt: ANCHOR });
    const next = advance(a, ANCHOR + 5); // fired 5ms late
    expect(next.lastFireKey).toBe(fireKey('a1', ANCHOR));
    expect(next.nextRunAt).toBe(ANCHOR + 60_000); // next slot on the createdAt-anchored grid
    expect(next.updatedAt).toBe(ANCHOR + 5);
  });

  it('a late fire catches up to the next FUTURE slot, not now+interval (no drift)', () => {
    const a = automation({ nextRunAt: ANCHOR, createdAt: ANCHOR });
    // Dispatched very late, at anchor + 200s. Next slot must be the grid slot after that:
    // anchor + 240s (multiple of 60s), not (anchor+200s)+60s.
    const next = advance(a, ANCHOR + 200_000);
    expect(next.nextRunAt).toBe(ANCHOR + 240_000);
  });

  it('does not mutate the input', () => {
    const a = automation({ nextRunAt: ANCHOR });
    const snapshot = { ...a };
    advance(a, ANCHOR + 5);
    expect(a).toEqual(snapshot);
  });

  it('after advance the same slot is no longer due even if re-evaluated (restart-safe)', () => {
    const a = automation({ nextRunAt: ANCHOR });
    const next = advance(a, ANCHOR + 5);
    // A crash between advance-persist and the next tick re-reads `next`; the old slot is
    // stamped and the new slot is in the future -> not due.
    expect(isDue(next, ANCHOR + 5)).toBe(false);
  });
});

describe('dueAutomations', () => {
  it('selects only the enabled, approved, arrived, un-fired ones', () => {
    const list: ChatAutomation[] = [
      automation({ id: 'ready', nextRunAt: ANCHOR }),
      automation({ id: 'future', nextRunAt: ANCHOR + 60_000 }),
      automation({ id: 'disabled', enabled: false, nextRunAt: ANCHOR }),
      automation({ id: 'pending', approvalState: 'pending_approval', nextRunAt: ANCHOR }),
      automation({ id: 'fired', nextRunAt: ANCHOR, lastFireKey: fireKey('fired', ANCHOR) }),
    ];
    expect(dueAutomations(list, ANCHOR + 1).map((a) => a.id)).toEqual(['ready']);
  });
});
