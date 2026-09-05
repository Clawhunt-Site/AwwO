# Per-Worker Test App And Runtime Lifecycle

Git worktrees isolate source files. They do not isolate ports, installed apps,
bundle IDs, browser profiles, databases, simulators, device permissions,
external accounts, queues, or long-running processes.

## When A Worker Needs A Test App

Allocate a per-worker runtime when the task needs:

- manual UI testing,
- E2E/browser/device testing,
- database-backed behavior,
- app permissions such as camera, microphone, files, or notifications,
- a long-running local server,
- user inspection of a work-in-progress app build.

Do not allocate one for pure unit tests, static analysis, formatting, or
read-only research.

Queue/listener mode does not by itself require a long-running process, port,
database, browser profile, or app install. Allocate runtime resources only when
the claimed `.goalgo/` task's implementation or verification needs them.

## Registry

The coordinator owns `.codex-orchestrator/runtimes.json`.

Runtime registry paths should be workspace-relative by default. Persistent
profiles, databases, app data, generated artifacts, caches, and temp files must
stay inside the declared workspace boundary unless the user explicitly approves
the exact external path/resource and the coordinator records it before use.

Recommended shape:

```json
{
  "schemaVersion": 1,
  "runtimes": [
    {
      "runtimeId": "auth-flow",
      "taskId": "auth-flow",
      "threadId": "019...",
      "branch": "codex/goal-auth/auth-flow",
      "worktreePath": "/path/to/worktree",
      "workspaceBoundary": "/path/to/workspace",
      "status": "allocated",
      "app": {
        "displayName": "MyApp [wt-auth-flow]",
        "idSuffix": ".wt.auth-flow",
        "bundleId": "com.example.myapp.wt.auth-flow"
      },
      "ports": [4301],
      "database": {
        "kind": "sqlite",
        "identifier": "myapp_wt_auth_flow",
        "path": ".codex-orchestrator/runtime/auth-flow/db.sqlite"
      },
      "browserProfile": ".codex-orchestrator/runtime/auth-flow/browser-profile",
      "tmpDir": ".codex-orchestrator/runtime/auth-flow/tmp",
      "processes": [],
      "createdAt": "2026-06-16T00:00:00Z",
      "updatedAt": "2026-06-16T00:00:00Z"
    }
  ]
}
```

## Goal Test Worktree Runtime Rules

The goal test worktree may run a combined app or E2E suite. Its runtime
resources must be registered separately from worker runtime resources when they
use ports, databases, app bundle ids, browser profiles, devices, or long-running
processes.

Use deterministic goal-test markers:

- branch: `codex/goal-test/<goal-id>`
- browser profile: `.codex-orchestrator/runtime/goal-test-<goal-id>/browser-profile`
- temp/cache dir: `.codex-orchestrator/runtime/goal-test-<goal-id>/tmp`
- database/schema/file: `<project>_goal_test_<goal-id>`

Do not reuse production accounts, default browser profiles, default app bundle
ids, or main databases for goal-test verification.

## Safety Rules

Before deleting or stopping anything, verify all of the following:

- resource is present in `runtimes.json`,
- resource belongs to the requested `taskId` or goal-test id,
- branch is not `main`, `master`, or the base branch,
- paths are under the workspace boundary,
- paths are under the expected worktree or `.codex-orchestrator/runtime/<id>/` unless an exact external path was explicitly user-approved and registered,
- app id / bundle id contains `.wt.<task-id>` or a goal-test marker,
- database identifier contains `_wt_<task-id>` or `_goal_test_<goal-id>`,
- browser profile path contains the task id or goal-test id,
- PID command line or cwd points to the expected worktree before terminating,
- user explicitly approved destructive cleanup.

If any check fails, stop and report. Do not guess or broaden deletion patterns.

Never clean up global Codex/plugin config, user-level browser profiles, shell
profiles, user-level package caches, personal plugin directories, marketplace
files, system launch agents, or system temp directories as part of workspace
cleanup. If one of these was touched by a task, report it as out-of-scope
residual risk unless the user explicitly approves a separate cleanup plan.

## Cannot Guarantee

Goal Go cannot fully clean external systems such as SaaS test accounts, cloud
buckets, payment sandboxes, third-party queues, push-notification providers, or
orphaned daemon child processes that were never registered. It can only report
them as residual risk unless the project provides a specific safe cleanup
command.
