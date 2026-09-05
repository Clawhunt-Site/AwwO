// Goal Mode send flow (PR6) — extracted from App's composer so the async race
// guards are unit-testable without a full <App/> render harness.
//
// Three guarantees, all exercised by goal-mode-send.test.ts:
//   1. Single in-flight: a second send while a plan is pending is dropped (no
//      duplicate goals).
//   2. No data loss on failure: a failed /api/goals/plan never clears the prompt.
//   3. Edit-safe success: the prompt is cleared on success ONLY if it still equals
//      the submitted text — text the user typed while the plan was pending survives.
import type { GoalRecord } from './GoalModeDialog';

type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

export type GoalPlanSendDeps = {
  readJson: ReadJson;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  setGoalModeRecord: (record: GoalRecord) => void;
  // Functional setter so the success clear can compare against the LIVE prompt.
  setPrompt: (updater: (prev: string) => string) => void;
  setMessage: (message: string) => void;
};

export async function submitGoalPlanFlow(content: string, deps: GoalPlanSendDeps): Promise<void> {
  if (deps.isBusy()) return; // single in-flight plan — drop a double-submit
  deps.setBusy(true);
  try {
    const out = await deps.readJson('/api/goals/plan', {
      method: 'POST',
      body: JSON.stringify({ title: content }),
    });
    deps.setGoalModeRecord((out?.goal ?? out) as GoalRecord);
    // Clear ONLY if the prompt is still the submitted text — never wipe edits the
    // user made while the request was in flight, and never clear on failure.
    deps.setPrompt((prev) => (prev === content ? '' : prev));
  } catch (err) {
    deps.setMessage(err instanceof Error ? err.message : 'goal plan failed');
  } finally {
    deps.setBusy(false);
  }
}
