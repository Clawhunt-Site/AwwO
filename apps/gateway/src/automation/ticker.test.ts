import { describe, expect, it, vi } from 'vitest';
import type { ChatAutomation } from './types.js';
import type { ChatTurnDispatcher, FireOutcome } from './fire.js';
import { fireKey } from './schedule.js';
import { InMemoryAutomationStore, PERSONAL_CHAT_COMPANY_ID } from './store.js';
import { AutomationTicker } from './ticker.js';

const ANCHOR = 1_000_000;

function automation(over: Partial<ChatAutomation> = {}): ChatAutomation {
  return {
    id: 'a1',
    sessionIssueId: 'chat-issue-1',
    chatAgentId: 'agent-1',
    companyId: PERSONAL_CHAT_COMPANY_ID,
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

function recordingDispatcher(outcome: FireOutcome = { ok: true }) {
  const calls: Array<{ sessionIssueId: string; prompt: string }> = [];
  const dispatcher: ChatTurnDispatcher = {
    inject: vi.fn(async (sessionIssueId: string, prompt: string) => {
      calls.push({ sessionIssueId, prompt });
      return outcome;
    }),
  };
  return { dispatcher, calls };
}

describe('AutomationTicker.tickOnce', () => {
  it('fires a due automation through the chat-turn dispatcher and advances it', async () => {
    const store = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const { dispatcher, calls } = recordingDispatcher();
    const ticker = new AutomationTicker(store, dispatcher);

    const result = await ticker.tickOnce(ANCHOR + 1);
    expect(result.fired).toEqual([{ id: 'a1', sessionIssueId: 'chat-issue-1', outcome: { ok: true } }]);
    expect(calls).toEqual([{ sessionIssueId: 'chat-issue-1', prompt: 'morning digest' }]);

    // Advanced: slot stamped + rolled forward.
    const after = await store.get('a1');
    expect(after!.lastFireKey).toBe(fireKey('a1', ANCHOR));
    expect(after!.nextRunAt).toBe(ANCHOR + 60_000);
  });

  it('exactly-once: a second tick before the next slot does NOT re-fire', async () => {
    const store = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const { dispatcher, calls } = recordingDispatcher();
    const ticker = new AutomationTicker(store, dispatcher);

    await ticker.tickOnce(ANCHOR + 1);
    const second = await ticker.tickOnce(ANCHOR + 2); // still before ANCHOR+60_000
    expect(second.fired).toEqual([]);
    expect(calls).toHaveLength(1); // fired exactly once
  });

  it('claims (advances) even when the dispatch fails, so a failed slot is never re-fired', async () => {
    const store = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const { dispatcher } = recordingDispatcher({ ok: false, status: 500, error: 'boom' });
    const ticker = new AutomationTicker(store, dispatcher);

    const result = await ticker.tickOnce(ANCHOR + 1);
    expect(result.fired[0]?.outcome).toEqual({ ok: false, status: 500, error: 'boom' });
    // Slot still claimed → not re-fired on the next tick.
    expect((await store.get('a1'))!.lastFireKey).toBe(fireKey('a1', ANCHOR));
    const second = await ticker.tickOnce(ANCHOR + 2);
    expect(second.fired).toEqual([]);
  });

  it('does not fire disabled / pending-approval / future automations', async () => {
    const store = new InMemoryAutomationStore([
      automation({ id: 'disabled', enabled: false, nextRunAt: ANCHOR }),
      automation({ id: 'pending', approvalState: 'pending_approval', nextRunAt: ANCHOR }),
      automation({ id: 'future', nextRunAt: ANCHOR + 60_000 }),
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const ticker = new AutomationTicker(store, dispatcher);

    const result = await ticker.tickOnce(ANCHOR + 1);
    expect(result.fired).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fires multiple due automations in one tick', async () => {
    const store = new InMemoryAutomationStore([
      automation({ id: 'a', sessionIssueId: 's-a', nextRunAt: ANCHOR }),
      automation({ id: 'b', sessionIssueId: 's-b', nextRunAt: ANCHOR }),
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const ticker = new AutomationTicker(store, dispatcher);

    const result = await ticker.tickOnce(ANCHOR + 1);
    expect(result.fired.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(calls.map((c) => c.sessionIssueId).sort()).toEqual(['s-a', 's-b']);
  });

  it('records the fire outcome on the automation (never silent)', async () => {
    const store = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const okTicker = new AutomationTicker(store, recordingDispatcher({ ok: true }).dispatcher);
    await okTicker.tickOnce(ANCHOR + 1);
    expect(await store.get('a1')).toMatchObject({ lastFiredAt: ANCHOR + 1, lastOutcomeOk: true, lastError: null });

    const store2 = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const failTicker = new AutomationTicker(store2, recordingDispatcher({ ok: false, status: 500, error: 'boom' }).dispatcher);
    await failTicker.tickOnce(ANCHOR + 1);
    expect(await store2.get('a1')).toMatchObject({ lastOutcomeOk: false, lastError: 'boom' });
  });

  it('exposes liveness status after a tick (lastTickAt / counts)', async () => {
    const store = new InMemoryAutomationStore([automation({ nextRunAt: ANCHOR })]);
    const ticker = new AutomationTicker(store, recordingDispatcher({ ok: false, status: 500, error: 'x' }).dispatcher);
    expect(ticker.status().lastTickAt).toBeNull();
    await ticker.tickOnce(ANCHOR + 1);
    const s = ticker.status();
    expect(s.lastTickAt).toBe(ANCHOR + 1);
    expect(s.lastTickFired).toBe(1);
    expect(s.lastTickFailed).toBe(1);
  });

  it('a per-task dispatch throw is isolated — other due tasks still fire', async () => {
    const store = new InMemoryAutomationStore([
      automation({ id: 'boom', sessionIssueId: 's-boom', nextRunAt: ANCHOR }),
      automation({ id: 'ok', sessionIssueId: 's-ok', nextRunAt: ANCHOR }),
    ]);
    const dispatcher: ChatTurnDispatcher = {
      inject: vi.fn(async (sessionIssueId: string) => {
        if (sessionIssueId === 's-boom') throw new Error('network down');
        return { ok: true } as FireOutcome;
      }),
    };
    const ticker = new AutomationTicker(store, dispatcher);
    const result = await ticker.tickOnce(ANCHOR + 1);
    expect(result.fired.find((f) => f.id === 'boom')?.outcome.ok).toBe(false);
    expect(result.fired.find((f) => f.id === 'ok')?.outcome.ok).toBe(true);
    // Both slots claimed regardless.
    expect((await store.get('boom'))!.lastError).toContain('network down');
  });
});
