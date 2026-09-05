# Goal Go State Machine

## Worker Task Status

- `planned`: task accepted but not dispatched.
- `provisioning`: coordinator is creating a background, worktree-isolated subagent worker (Claude Code Agent, general-purpose).
- `active`: worker is implementing.
- `ready_for_review`: worker finished local implementation but has not committed or verified enough.
- `ready_for_goal_test`: worker committed and produced required local verification.
- `merged_to_goal_test`: coordinator merged the worker branch into the goal test worktree.
- `cross_validating`: the two-advisor gate (Codex `gpt-5.5` + antigravity `Gemini 3.1 Pro (High)`) is running or pending.
- `pr_ready`: all gates passed and the branch is ready for PR from its feature worktree.
- `pr_open`: PR was opened or updated from the feature worktree.
- `merged_remote`: PR was merged upstream or equivalent remote preservation is confirmed.
- `blocked`: progress stopped due to conflict, failing tests, missing context, unavailable required model, inability to spawn a subagent worker, remote drift, or required user decision.
- `abandoned`: task intentionally stopped.
- `cleanup_ready`: task evidence is preserved and cleanup may be proposed.
- `cleaned`: approved cleanup completed.

## Runtime Status

- `not_required`: task does not need a running app/runtime.
- `allocated`: coordinator assigned runtime resources.
- `running`: worker reports the app/runtime is running.
- `stopped`: runtime stopped but evidence remains.
- `cleanup_ready`: work is preserved and cleanup may be proposed.
- `cleaned`: approved cleanup completed.
- `leaked`: expected resource may still exist but could not be safely verified.

## Goalgo Queue Status

Queue statuses live in `.goalgo/tasks/<task-id>.json` and are separate from
worker task statuses:

- `todo`: task is in `.goalgo/goalgo.md` and can be normalized or claimed.
- `normalized`: task has structured JSON metadata and is ready for dispatch analysis.
- `claimed`: coordinator created `.goalgo/claims/<task-id>.json`; no other coordinator may dispatch it.
- `dispatched`: one or more Goal Go worker tasks were created for this queue task.
- `active`: worker implementation or coordinator verification is in progress.
- `done`: queue task is fully handled or preserved according to the required Goal Go gates.
- `blocked`: task cannot proceed without a required decision, dependency, tool, model, or repeated failing fix/test loop resolution.
- `deleted`: task was removed from `goalgo.md` by explicit user request and archived under `.goalgo/deleted/`.
- `dead_letter`: task could not be parsed or safely normalized; keep evidence under `.goalgo/dead-letter/`.

Listener statuses live in `.goalgo/state.json`:

- `active`: queue mode can scan and claim tasks.
- `idle_waiting`: no claimable task was found; the coordinator is waiting for new work and scans no more often than once every 30 seconds.
- `idle_paused`: no claimable task arrived within the configured idle timeout, usually five minutes. This is the queue-layer pause state, not goal completion.
- `blocked`: the queue itself is malformed or unsafe to process.

`idle_paused` must not trigger an active-goal completion transition. If the
surface has only completion/blocking status primitives, mark the
active goal `blocked` for the empty queue after the idle timeout. This `blocked`
status means "waiting for new queue work", not task failure. Keep
`.goalgo/state.json` as the queue-layer pause record until the user or automation
asks to resume or explicitly close the listener.

## Conflict Classes

- `none`: owned paths do not overlap and no shared runtime resources are needed.
- `file_potential`: task may touch shared files or adjacent modules.
- `file_blocking`: task requires files already owned by an active worker.
- `runtime_potential`: task may share ports, databases, browser profiles, accounts, queues, or external services.
- `dependency_blocking`: task cannot produce an independently valid PR until another worker or PR lands.
- `batch_required`: task is safe only if reviewed or landed with related tasks.

## Status File Contract

Each worker writes `.codex-orchestrator/workers/<workerTaskId>.status.json` (one
distinct `workerTaskId` per worker; one queue task may decompose into N workers →
N status files, each carrying `queueTaskId` as the correlation field):

```json
{
  "taskId": "auth-flow",
  "workerTaskId": "auth-flow",
  "queueTaskId": "task-20260618T143000-auth",
  "role": "worker",
  "status": "ready_for_goal_test",
  "threadId": "019...",
  "branch": "codex/goal-auth/auth-flow",
  "actualCheckout": "codex/goal-auth/auth-flow",
  "baseBranch": "main",
  "workspaceBoundary": "/path/to/workspace",
  "projectRoot": "/path/to/workspace/project",
  "headCommit": "abc123",
  "ownedPaths": ["src/auth/**", "tests/auth/**"],
  "changedFiles": ["src/auth/login.ts"],
  "dependencies": [],
  "sharedFilesRequested": [],
  "testCases": [
    "login succeeds with valid credentials",
    "login rejects invalid credentials"
  ],
  "runtimeResources": {
    "required": true,
    "runtimeId": "auth-flow",
    "ports": [4301],
    "appIdSuffix": ".wt.auth-flow",
    "databaseIdentifier": "project_wt_auth_flow",
    "browserProfile": ".codex-orchestrator/runtime/auth-flow/browser-profile"
  },
  "verification": [
    {"command": "npm test -- login", "result": "passed"}
  ],
  "pr": {
    "independent": true,
    "sourceWorktree": "/path/to/worktree",
    "blockedBy": []
  },
  "risks": [],
  "updatedAt": "2026-06-16T00:00:00Z"
}
```

The coordinator owns `.codex-orchestrator/workspace.json`,
`.codex-orchestrator/runtimes.json`, the goal test worktree, the cross-validation
records, and PR state transitions. Workers must not edit those coordinator-owned
files unless explicitly assigned.

The **cross-validation record** is durable and lives at
`.codex-orchestrator/cross-validation/<workerTaskId>.json`:

```json
{
  "workerTaskId": "auth-flow",
  "queueTaskId": "task-20260618T143000-auth",
  "gatedHeadSha": "abc123",
  "gatedBaseSha": "def456",
  "targetBaseBranch": "main",
  "gateSpec": {
    "advisors": ["codex-cli-advisor", "antigravity-cli-advisor"],
    "resolvedModels": ["gpt-5.5", "Gemini 3.1 Pro (High)"],
    "contractVersion": 1
  },
  "verdicts": {"codex": "no-blocking", "antigravity": "no-blocking"},
  "updatedAt": "2026-06-19T00:00:00Z"
}
```

A persisted record is reusable only when `(gatedHeadSha, gatedBaseSha, gateSpec)`
all match the current state; a changed `gateSpec` (e.g. a corrected resolved
model) invalidates it and forces a re-gate. `resolvedModels` are the models that
actually ran (verified from each advisor's run log), never the requested labels.

The **integration-verification record** is its durable counterpart for the
combined `dev/roadmap` verification, at
`.codex-orchestrator/integration-verification/<workerTaskId>.json`:

```json
{
  "workerTaskId": "auth-flow",
  "queueTaskId": "task-20260618T143000-auth",
  "gatedHeadSha": "abc123",
  "gatedBaseSha": "def456",
  "gateSpec": { "advisors": ["codex-cli-advisor", "antigravity-cli-advisor"], "resolvedModels": ["gpt-5.5", "Gemini 3.1 Pro (High)"], "contractVersion": 1 },
  "integrationResultSha": "ghi789",
  "commands": ["python -m pytest", "ruff check ."],
  "results": ["passed", "passed"],
  "verdict": "passed",
  "e2e": { "verdict": "passed", "commands": ["<app/CLI/server e2e command>"], "results": ["passed"] },
  "updatedAt": "2026-06-19T00:00:00Z"
}
```

The `e2e` block is the mandatory pre-PR end-to-end test (the change exercised in
the real app/flow per the project's run/verify conventions), run and recorded in
step 7. Its shape is either `{"verdict":"passed","commands":[…],"results":[…]}`
or, **only when the change is genuinely not e2e-testable**,
`{"verdict":"not-applicable","reason":"…"}`. A change that is e2e-testable cannot
reach `pr_ready` without `e2e.verdict == "passed"`. It is
reusable only when its `(gatedHeadSha, gatedBaseSha, gateSpec)` triple still
matches; otherwise the coordinator must re-integrate. PR readiness (step 8)
requires BOTH a valid cross-validation record and a valid integration-verification
record for the same triple.

Workers must not report `ready_for_goal_test` if any write target, runtime path,
generated artifact, cleanup target, browser profile, database path, app data
path, or worktree path is outside the workspace boundary without exact user
approval and a matching runtime/status record.

Workers must record the actual worker chat/thread id in `threadId`; the
coordinator thread id is not valid worker evidence. The coordinator must block
PR readiness when `threadId` is missing, `unknown`, or known to belong to the
coordinator until it reconciles the actual worker thread.

Implementation and PR-bearing work must run on the assigned feature branch.
`actualCheckout: "detached HEAD"` or any branch mismatch is evidence-only unless
the task was explicitly read-only. It must not be marked `ready_for_goal_test` or
`pr_ready` for implementation output until repaired.

## Goalgo Queue Contract

The human-facing inbox is `.goalgo/goalgo.md`. The coordinator or
bundled `scripts/goalgo_tasks.py` helper normalizes unchecked Markdown items into managed
blocks and writes canonical metadata to `.goalgo/tasks/<task-id>.json`:

```json
{
  "schemaVersion": 1,
  "taskId": "task-20260618T143000-settings-validation",
  "title": "Implement settings import validation",
  "details": "Cover invalid JSON and missing fields.",
  "status": "todo",
  "priority": "normal",
  "source": ".goalgo/goalgo.md",
  "createdAt": "2026-06-18T14:30:00Z",
  "updatedAt": "2026-06-18T14:30:00Z"
}
```

Before dispatch, the coordinator must atomically create
`.goalgo/claims/<task-id>.json`:

```json
{
  "taskId": "task-20260618T143000-settings-validation",
  "owner": "coordinator-thread-id",
  "claimedAt": "2026-06-18T14:31:00Z"
}
```

If the claim file already exists, skip the task unless the user explicitly asks
to repair a stale claim and the owner/staleness evidence is clear.

Queue task IDs are correlation IDs. Preserve them in `coordination.md`, worker
prompts, worker status files, goal-test evidence, and PR notes. A single queue
task may map to multiple worker status files when the coordinator decomposes it
into parallel implementation workstreams.

The default listener state includes `scanIntervalSeconds: 30` and
`idlePauseAfterSeconds: 300`. Coordinators must respect the 30-second minimum
between idle rescans unless the user explicitly changes the policy.

An empty queue must not complete the active goal. When the listener reaches
`idle_paused`, report the pause, mark the active goal `blocked` if a goal-status
primitive is available, and resume by scanning the queue again when the user or
automation asks.
