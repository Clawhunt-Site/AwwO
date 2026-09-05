// Chat automation — the v4 "会话即定时任务" data model (docs/chat-routine-goal-design.md).
//
// A ChatAutomation is a schedule bound to ONE chat-session issue. On each due fire the
// gateway ticker injects `prompt` as a new user turn into THAT session (via the upstream
// chat turn path) and the chat agent continues in-thread — it NEVER touches the upstream
// routine engine, so no `routine_execution` issue is ever spawned (proven by the PR1
// de-risk). Schedules are always pinned to the Personal Chat system company so they stay
// isolated from real business companies (§4.5).

// The cadence shape. Interval is the dependency-free MVP; `cron` is the seam for
// wall-clock schedules ("every morning at 9") — computeNextRunAt is where a cron
// evaluator plugs in (a later slice adds the parser).
export type AutomationCadence =
  | { kind: 'interval'; intervalSec: number }
  | { kind: 'cron'; expression: string };

// Governance state (§8 / PR4). Only `approved` automations are allowed to fire; a
// high-risk prompt (scanning / payment / external write) lands `pending_approval` and the
// ticker fail-closed skips it until a human approves.
export type AutomationApprovalState = 'approved' | 'pending_approval';

export interface ChatAutomation {
  id: string;
  // The chat-session issue this automation drives (originKind="chat"). The fire injects
  // a turn into exactly this issue.
  sessionIssueId: string;
  // The chat agent that continues the conversation (resolved when the automation is
  // created); null until resolved.
  chatAgentId: string | null;
  // Always LOCAL_CHAT_COMPANY_ID — the isolation invariant (§4.5).
  companyId: string;
  // The scheduled task prompt injected on each fire.
  prompt: string;
  cadence: AutomationCadence;
  timezone: string;
  enabled: boolean;
  // Epoch ms of the next scheduled fire slot.
  nextRunAt: number;
  // Idempotency: the fire key of the last slot that was dispatched. A restart re-evaluating
  // the same slot produces the same key (see fireKey) so the fire is not duplicated.
  lastFireKey: string | null;
  approvalState: AutomationApprovalState;
  // Observability of the last fire (so failures are never silent — a slot is claimed
  // at-most-once, and if its dispatch failed the user/admin can see it here and re-approve
  // or fix). null until the first fire.
  lastFiredAt: number | null;
  lastOutcomeOk: boolean | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
