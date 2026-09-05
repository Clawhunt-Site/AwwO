// The automation ticker — a thin loop around the pure scheduler core + the store's atomic
// transaction. Each tick atomically CLAIMS every due slot (select-due + advance + persist
// in one store transaction, so a concurrent DELETE can't be resurrected and a slot is
// claimed at-most-once), then dispatches each claimed fire, then records its outcome.
//
// Exactly the at-most-once tradeoff the advisors signed off on: claim before dispatch, so
// a crash never re-fires a slot (no duplicate scans/payments). A failed dispatch is NOT
// re-fired this slot; it is recorded (lastOutcomeOk/lastError) so it is never silent.

import type { ChatTurnDispatcher, FireOutcome } from './fire.js';
import { advance, dueAutomations } from './schedule.js';
import type { AutomationStore } from './store.js';

export interface TickFireRecord {
  id: string;
  sessionIssueId: string;
  outcome: FireOutcome;
}

export interface TickResult {
  fired: TickFireRecord[];
}

export interface TickerStatus {
  running: boolean;
  lastTickAt: number | null;
  lastTickFired: number;
  lastTickFailed: number;
  lastError: string | null;
}

export interface AutomationTickerOptions {
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export class AutomationTicker {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private status_: TickerStatus = {
    running: false,
    lastTickAt: null,
    lastTickFired: 0,
    lastTickFailed: 0,
    lastError: null,
  };

  constructor(
    private readonly store: AutomationStore,
    private readonly dispatcher: ChatTurnDispatcher,
    opts: AutomationTickerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
  }

  status(): TickerStatus {
    return { ...this.status_ };
  }

  async tickOnce(now: number = this.now()): Promise<TickResult> {
    // CLAIM: select due + advance (stamp fireKey, roll forward) atomically. Returns the
    // dispatch payloads for the slots we just claimed.
    const claimed = await this.store.transaction((map) => {
      const due = dueAutomations([...map.values()], now);
      const payloads: Array<{ id: string; sessionIssueId: string; prompt: string }> = [];
      for (const a of due) {
        map.set(a.id, advance(a, now));
        payloads.push({ id: a.id, sessionIssueId: a.sessionIssueId, prompt: a.prompt });
      }
      return payloads;
    });

    const fired: TickFireRecord[] = [];
    let failed = 0;
    for (const p of claimed) {
      // Per-task isolation: one task's dispatch/record failure must not starve the rest.
      let outcome: FireOutcome;
      try {
        outcome = await this.dispatcher.inject(p.sessionIssueId, p.prompt);
      } catch (err) {
        outcome = { ok: false, status: null, error: err instanceof Error ? err.message : 'dispatch threw' };
      }
      if (!outcome.ok) failed += 1;
      // Record the outcome (never silent). The slot stays claimed regardless.
      try {
        await this.store.transaction((map) => {
          const a = map.get(p.id);
          if (a) {
            map.set(p.id, {
              ...a,
              lastFiredAt: now,
              lastOutcomeOk: outcome.ok,
              lastError: outcome.ok ? null : outcome.error,
            });
          }
        });
      } catch (err) {
        this.onError(err);
      }
      fired.push({ id: p.id, sessionIssueId: p.sessionIssueId, outcome });
    }

    this.status_ = {
      ...this.status_,
      lastTickAt: now,
      lastTickFired: fired.length,
      lastTickFailed: failed,
    };
    return { fired };
  }

  start(): void {
    if (this.timer) return;
    this.status_.running = true;
    this.timer = setInterval(() => {
      if (this.inFlight) return; // skip if the previous tick is still running
      this.inFlight = true;
      void this.tickOnce()
        .then((result) => {
          // Surface failed fires (never silent): the per-task lastError is persisted; here
          // we also log so a misconfigured upstream / store is visible to the operator.
          const failures = result.fired.filter((f) => !f.outcome.ok);
          if (failures.length > 0) {
            this.onError(new Error(`automation tick: ${failures.length} fire(s) failed`));
          }
        })
        .catch((err) => {
          this.status_ = { ...this.status_, lastError: err instanceof Error ? err.message : String(err) };
          this.onError(err);
        })
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status_.running = false;
  }
}
