import { describe, expect, it, vi } from 'vitest';

import { submitGoalPlanFlow, type GoalPlanSendDeps } from '../src/goalModeSend';

// PR6 — the goal-plan send flow's async-race guards (extracted from App so they
// are testable without a full <App/> render): single in-flight, no data loss on
// failure, edit-safe success.

function harness(opts: {
  readJson: GoalPlanSendDeps['readJson'];
  prompt?: string;
}) {
  let busy = false;
  let prompt = opts.prompt ?? '';
  const setGoalModeRecord = vi.fn();
  const setMessage = vi.fn();
  const deps: GoalPlanSendDeps = {
    readJson: opts.readJson,
    isBusy: () => busy,
    setBusy: (b) => {
      busy = b;
    },
    setGoalModeRecord,
    setPrompt: (updater) => {
      prompt = updater(prompt);
    },
    setMessage,
  };
  return { deps, setGoalModeRecord, setMessage, getPrompt: () => prompt, isBusy: () => busy };
}

describe('submitGoalPlanFlow', () => {
  it('preserves the prompt when /api/goals/plan fails (no data loss)', async () => {
    const h = harness({ readJson: vi.fn(async () => { throw new Error('boom'); }), prompt: 'my goal' });
    await submitGoalPlanFlow('my goal', h.deps);
    expect(h.getPrompt()).toBe('my goal'); // not cleared
    expect(h.setGoalModeRecord).not.toHaveBeenCalled();
    expect(h.setMessage).toHaveBeenCalled();
  });

  it('clears the prompt only on success', async () => {
    const readJson = vi.fn(async () => ({ goal: { spec: { goal_id: 'g1', title: 't' }, status: 'awaiting_confirmation', revision: 1, plan_hash: 'h', plan: null } }));
    const h = harness({ readJson, prompt: 'my goal' });
    await submitGoalPlanFlow('my goal', h.deps);
    expect(h.getPrompt()).toBe('');
    expect(h.setGoalModeRecord).toHaveBeenCalled();
  });

  it('drops a double-submit while a plan is in flight (single goal)', async () => {
    let resolve: (v: any) => void = () => {};
    const pending = new Promise((r) => { resolve = r; });
    const readJson = vi.fn(() => pending);
    const h = harness({ readJson: readJson as any, prompt: 'my goal' });
    const first = submitGoalPlanFlow('my goal', h.deps);
    // second send while pending must be dropped
    await submitGoalPlanFlow('my goal', h.deps);
    expect(readJson).toHaveBeenCalledTimes(1);
    resolve({ goal: { spec: { goal_id: 'g1', title: 't' }, status: 'awaiting_confirmation', revision: 1, plan_hash: 'h', plan: null } });
    await first;
    expect(readJson).toHaveBeenCalledTimes(1);
  });

  it('does not wipe text the user typed while the plan was pending', async () => {
    let resolve: (v: any) => void = () => {};
    const pending = new Promise((r) => { resolve = r; });
    const readJson = vi.fn(() => pending);
    const h = harness({ readJson: readJson as any, prompt: 'my goal' });
    const flow = submitGoalPlanFlow('my goal', h.deps);
    // user edits the prompt while the request is in flight
    h.deps.setPrompt(() => 'a new draft');
    resolve({ goal: { spec: { goal_id: 'g1', title: 't' }, status: 'awaiting_confirmation', revision: 1, plan_hash: 'h', plan: null } });
    await flow;
    expect(h.getPrompt()).toBe('a new draft'); // edit survived
  });
});
