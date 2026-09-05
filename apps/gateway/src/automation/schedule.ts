// Pure scheduler mechanics for chat automations — no I/O, no timers, no upstream calls,
// so the exactly-once / restart-safe / advance logic is deterministically unit-testable.
// The ticker (a later slice) is a thin loop around these functions.

import type { AutomationCadence, ChatAutomation } from './types.js';

// Compute the next fire slot strictly AFTER `after` (epoch ms) for a cadence. For
// interval cadence the slots are anchored to `anchor` so a restart re-derives the same
// grid (no drift): the result is the smallest `anchor + n*interval` that is > after.
//
// `cron` is intentionally not implemented yet — it is the seam where a cron evaluator
// plugs in (a later slice adds the parser). Throwing here keeps the MVP honest: a cron
// schedule cannot silently behave like an interval.
export function computeNextRunAt(cadence: AutomationCadence, after: number, anchor: number): number {
  if (cadence.kind === 'interval') {
    const intervalMs = cadence.intervalSec * 1000;
    if (intervalMs <= 0) throw new RangeError('interval must be positive');
    if (after < anchor) return anchor;
    const elapsed = after - anchor;
    const slots = Math.floor(elapsed / intervalMs) + 1;
    return anchor + slots * intervalMs;
  }
  throw new Error('cron cadence not yet implemented (computeNextRunAt seam)');
}

// The idempotency key for the slot an automation is currently due at. A restart that
// re-evaluates the same `nextRunAt` slot produces the SAME key, so a fire recorded as
// `lastFireKey` is recognized and not repeated.
export function fireKey(automationId: string, scheduledAt: number): string {
  return `chat-automation:${automationId}:${scheduledAt}`;
}

// Whether an automation should fire now. Fail-closed on governance: only enabled AND
// approved automations whose slot has arrived are due. A `pending_approval` automation is
// never fired (it waits for a human), and an already-dispatched slot (lastFireKey matches
// this slot's key) is skipped — the restart-safe exactly-once guard.
export function isDue(a: ChatAutomation, now: number): boolean {
  if (!a.enabled) return false;
  if (a.approvalState !== 'approved') return false;
  if (a.nextRunAt > now) return false;
  if (a.lastFireKey === fireKey(a.id, a.nextRunAt)) return false;
  return true;
}

export function dueAutomations(list: readonly ChatAutomation[], now: number): ChatAutomation[] {
  return list.filter((a) => isDue(a, now));
}

// Advance an automation past the slot it just fired: stamp the slot's fireKey (so it is
// never re-fired) and roll nextRunAt forward to the next future slot. Returns a new object
// (no mutation). `now` is the time the fire was dispatched.
export function advance(a: ChatAutomation, now: number): ChatAutomation {
  const firedSlot = a.nextRunAt;
  return {
    ...a,
    lastFireKey: fireKey(a.id, firedSlot),
    // Anchor the interval grid to the original first slot via createdAt so slots stay on a
    // fixed cadence even if a fire is late (catch-up jumps to the next FUTURE slot, not
    // now+interval).
    nextRunAt: computeNextRunAt(a.cadence, now, a.createdAt),
    updatedAt: now,
  };
}
