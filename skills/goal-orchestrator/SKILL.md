---
name: goal-orchestrator
description: Claude Code's own self-contained goal orchestrator. The current chat becomes the goal coordinator and dispatches each bounded task to a background, worktree-isolated subagent worker (which may spawn sub-subagents). It is self-sufficient — it bundles its own queue helper (`scripts/goalgo_tasks.py`) and contract spec (`references/state-machine.md`) and does NOT require any other plugin to be installed. It uses the runtime-neutral `.goalgo/` + `.codex-orchestrator/` on-disk format family, owns its own contract spec, serves Claude Code only, and adds no business semantics of its own. Use ONLY when the user explicitly asks to orchestrate/parallelize a goal across Claude Code subagents, run a persistent coordinator chat, dispatch worker subagents into worktrees, drain the `.goalgo/` queue, or 用 subagent 编排/并行一个目标 / 起协调器持续派活 / 启动监听 / drain .goalgo. Do NOT trigger on ordinary "do this task" or "check status" requests.
---

# Goal Orchestrator (Claude Code's own goal orchestrator)

This skill is **Claude Code's own goal orchestrator**. It turns **this chat** into
the **goal coordinator** and dispatches each bounded task to a **background,
worktree-isolated subagent worker**. Its **orchestration machinery is bundled** —
the queue helper (`scripts/goalgo_tasks.py`) and contract spec
(`references/state-machine.md`) ship with the skill, so it requires **no external
goal-go / Codex plugin** to run. It still relies on the surrounding Claude Code
environment for project policy (`coordination.md`, `AGENTS.md`, `CLAUDE.md`) and
for the gate advisor skills (`codex-cli-advisor`, `antigravity-cli-advisor`,
`adversarial-verification`) — those are project/environment fixtures, not the old
plugin. The coordination flow is inspired by the Codex `goal-go` model, but this
skill serves Claude Code only and owns its own helper + contract spec.

## Boundary: own the helper + spec, share only the on-disk formats

This skill bundles its **own** canonical helper and contract spec, and adds **no
new business semantics** — it uses a runtime-neutral on-disk file format family
and owns its own contract spec; it serves Claude Code only and depends on no
external plugin:

| Concern | Owned by this skill (bundled) |
| --- | --- |
| Queue / task / claim / listener state | `.goalgo/` protocol via the **bundled** `scripts/goalgo_tasks.py`. Tasks in `.goalgo/tasks/<id>.json`; claims are an exclusive-create of the **file** `.goalgo/claims/<id>.json`; listener state in `.goalgo/state.json`. Drive status transitions through the helper's `set-status`. |
| Worker status + lifecycle | The `.codex-orchestrator/workers/<workerTaskId>.status.json` contract + state machine, specified in the **bundled** `references/state-machine.md`. |
| Git / integration discipline | `coordination.md` + `AGENTS.md` (`dev/roadmap` integration worktree, branch promotion, approval gates, force-push ban). |
| Acceptance gate | The project's mandatory two-advisor gate: **Codex (`codex-cli-advisor --model gpt-5.5`) + the Gemini-lineage reviewer (`antigravity-cli-advisor --model "Gemini 3.1 Pro (High)"`)**, plus `adversarial-verification`. (Gemini CLI's personal tier is discontinued — `antigravity-cli-advisor` is Google's sanctioned Gemini successor and the project's standing second advisor.) |

The worker is a **Claude Code background worktree subagent** (its agent id is
recorded as the worker `threadId`). The on-disk `.goalgo/` + `.codex-orchestrator/`
formats are runtime-neutral and owned by this skill; the helper and spec are bundled here so the
skill never depends on an external plugin.

## Identity model: queue task id vs worker task id

- **queueTaskId** — the `.goalgo/tasks/<id>.json` id; the correlation id across coordination, worker status files, evidence, and PR notes.
- **workerTaskId** — a distinct id per worker (e.g. `<queueTaskId>-<slug>`). One queue task decomposed into N parallel workstreams yields N workers, N distinct `workerTaskId`s, and N status files `.codex-orchestrator/workers/<workerTaskId>.status.json`. Each status file carries `queueTaskId` as the correlation field. Never name two workers' status files by the same id.

## Three status planes (do not mix them)

- **Queue plane** — `.goalgo/tasks/<id>.json` status: `todo / normalized / claimed / dispatched / active / done / blocked / deleted / dead_letter`. Driven via the helper's `set-status`. `done` is a **queue** status only.
- **Worker plane** — `.codex-orchestrator/workers/<workerTaskId>.status.json` status: `planned / provisioning / active / ready_for_review / ready_for_goal_test / merged_to_goal_test / cross_validating / pr_ready / pr_open / merged_remote / blocked / abandoned / cleanup_ready / cleaned`. (List = vocabulary, not execution order. This skill deliberately applies `cross_validating` — the gate — to the feature branch **before** `merged_to_goal_test`, so the PR'd code is exactly the gated code; see the loop.)
- **Listener plane** — `.goalgo/state.json` status: `active / idle_waiting / idle_paused / blocked`, where listener `blocked` means **only** "the queue is malformed or unsafe to process" — never "waiting for work".

**Shared coordination root.** `.goalgo/` and `.codex-orchestrator/` are gitignored, so a worker's own worktree would otherwise get a private copy the coordinator cannot see. All queue/claim/status/coordination files MUST be read and written at the **single canonical workspace-boundary (main project) root** via absolute paths (the `workspaceBoundary`/`projectRoot` in each status file), never the worker's per-worktree copy — otherwise the coordinator reads stale state and the loop stalls.

## Roles

- **Coordinator (this chat)** — decomposes the goal, classifies risk, dispatches workers, tracks status, drives integration into the `dev/roadmap` worktree, runs the gate, decides PR readiness, reports. Owns `.codex-orchestrator/workspace.json`, `.codex-orchestrator/runtimes.json`, the integration worktree, the cross-validation records, and PR transitions. It **never edits product code** (no implementation; no conflict editing).
- **Worker (background subagent)** — one bounded task, one isolated worktree/branch. Implements, self-verifies, commits on its own branch, writes its status file, resolves rebases on its own branch. May spawn sub-subagents inside its own worktree. **Always** forbidden: push, open/merge PRs, merge to remote, touch local `main`, edit coordinator-owned files (`.codex-orchestrator/workspace.json`, `runtimes.json`), modify global config. A worker touches only its own branch/worktree and owned paths.
- **Integration worker (a narrowly-scoped, explicitly-assigned, user-approved worker)** — the *only* exception, and a narrow one. It may do **exactly one thing**: resolve a combined-verification merge conflict **within the `dev/roadmap` worktree** (throwaway — for verification only). It has **no feature-branch write authority** (real feature-branch fixes are always the branch's own worker), and it is **still** forbidden to push, open/merge PRs, merge to remote, touch local `main`, or edit coordinator-owned config. The "explicit assignment" never grants push/PR/merge/main rights.
- **Local `main`** — read-only fast-forward mirror of `origin/main`. Never developed on; never a PR source.
- **Integration worktree** — the project's `dev/roadmap` worktree (`coordination.md`). Used for **combined verification only**; never a PR source (`AGENTS.md`).
- **User** — approves every remote/irreversible action: push, PR open/update/merge, history rewrite, release/deploy, destructive cleanup, and any payment / scan-or-probe network intent.

## Worker dispatch (the Claude-native mechanism)

Dispatch each independent task as a **background, worktree-isolated,
general-purpose subagent** via the live `Agent` tool: background execution (chat
stays live; completion posts a task-notification that re-invokes the coordinator —
a per-run notification, not a durable daemon across restart); worktree isolation
(own worktree + branch); a `general-purpose` subagent type (so it can spawn
sub-subagents — `Explore`/`Plan` cannot); and a stable `name` (addressable via
`SendMessage` while held; record the agent id as `threadId`). Treat the live
`Agent` tool schema as the source of truth for field names. Do **not** use a
foreground in-chat helper as a worker.

**Re-engaging a stopped worker.** A worker stops after writing its status file, but
sync/gate-fix/rebase steps need it again. The coordinator re-engages it **without
editing code itself**: `SendMessage` to the worker if its handle (`threadId`) is
still held, otherwise spawn a **fresh** worker on the **same branch/worktree** carrying the
**original `workerTaskId`** (so it updates the same status file) that rehydrates
from the worktree + status file. The branch + status file are the
durable handoff; a coordinator restart reconstructs in-flight state from
`.codex-orchestrator/workers/*.status.json` + `.goalgo/` + `git worktree list` +
`gh pr list`.

## Gate / commit ordering — explicit adjudication (read carefully)

`CLAUDE.md` says "未经验收，禁止 commit" and its conventions **override** defaults.
Read literally as "no git commit object may exist before the gate," this is
**mechanically impossible** in the worktree-isolation model that
`coordination.md`/`AGENTS.md` themselves mandate: a worker's change must become a
**commit on its isolated branch** to be a syncable, cross-worktree-visible,
tree-stable artifact that the gate can review at all — an uncommitted working-tree
diff cannot be rebased onto latest `origin/main` and is invisible across
worktrees. `AGENTS.md` explicitly permits local commits on isolated branches.

**Adjudication:** "commit" in the gate rule means the **accepted/landed** commit —
the one merged into `dev/roadmap`, pushed, or carried by a PR. Isolated-branch
worker commits are the gate's **review substrate**. The mandatory two-advisor gate
is **blocking before that substrate is accepted** (before any merge to
`dev/roadmap`, push, or PR), and the **exact gated commit SHA is recorded and the
PR head must equal it**. No unreviewed code is ever accepted or landed. This
matches Goal Go's own machine (workers commit at `ready_for_goal_test` before
`cross_validating`).

## Coordinator loop (attended)

1. **Intake.** Confirm a real Git project. Classify each task's conflict class (`none / file_potential / file_blocking / runtime_potential / dependency_blocking / batch_required`). Do not parallelize `file_blocking` / `dependency_blocking` / `batch_required` work — sequence it or stack branches. Record each branch's **target base** as three distinct values (do not conflate them): the **local sync ref** used for rebase (`origin/main`, or the dependency branch's local ref if stacked); the **PR base branch name** used for `gh pr --base` and compared to GitHub `baseRefName` (`main`, or the dependency branch name — a plain branch name, never a remote-tracking ref like `origin/main`); and the **gated base SHA** (the commit the branch is gated against, compared to `baseRefOid`). Below, "base" refers to whichever of these three the step needs.
2. **Enqueue + claim.** Via the helper: normalize into `.goalgo/tasks/<id>.json`, then atomically create `.goalgo/claims/<id>.json` `{taskId, owner, claimedAt}` (exclusive create). **If the claim file already exists, abort this task immediately — do not `set-status dispatched` and do not dispatch a worker** (no stale-claim repair without explicit user direction + clear staleness evidence). Only on a successful exclusive create: `set-status claimed → dispatched`.
3. **Dispatch.** Create one background worktree subagent worker per workstream, each with a distinct `workerTaskId`; record its agent id as `threadId`. Plane bookkeeping: write the **worker-plane** status file `provisioning → active`, and separately drive the **queue-plane** task with the helper `set-status active` (these are two different files in two different planes).
4. **Implement + commit (`active`→`ready_for_goal_test`).** **For a CODE change**, the worker delivers a **well-formed module** and tests (for a non-code change — docs / config / skill-only — skip **all** the code-specific bullets below and instead run the change's *relevant* checks/build and record the evidence):
   - **Module** — real code lives where the repo's package discovery owns it (e.g. under the packaged source tree), **not** an unowned top-level directory; fully typed, documented, no stray dead code.
   - **Unit tests** — placed where the repo's *default* test command collects them (e.g. under the configured `testpaths` / `tests/`), so CI discovers them automatically; do not rely on ad-hoc path invocation. Cover happy path **and** edge/negative cases (empty/invalid input, boundaries).
   - **Integration tests** — wherever the change spans modules, contracts, or surfaces (CLI↔API↔Web, plugin boundaries, on-disk formats), add tests that exercise the seams, not just the unit in isolation.
   - **Self-verify with the repo's DEFAULT commands** (the same ones CI runs — e.g. `python -m pytest`, `ruff check` over the CI lint scope), not just a narrow path, and capture their output as evidence; a non-happy-path probe is mandatory evidence. *(This is a code-specific bullet — a non-code change runs its relevant checks/build instead, per the intro.)*

   The worker makes atomic commits **on its own isolated branch** (review substrate; not yet accepted). It reaches `ready_for_review` if the work/verification is incomplete or uncommitted, else `ready_for_goal_test` once committed and locally verified — **for a code change** by the repo's default test+lint commands, **for a non-code change** by its relevant checks/build. On each completion notification, read the status file + `git log`; block advancement if `threadId` is missing/unknown or belongs to the coordinator, or — **for a code change** — if the required unit tests (or applicable integration tests) are missing or not CI-discoverable (a recorded reason is required when integration tests genuinely do not apply). A non-code change is validated by its recorded relevant-checks evidence instead.
5. **Sync (`ready_for_goal_test`).** The worker rebases its **committed** branch onto the latest **target base** (step 1: `origin/main` for an independent branch, or the dependency branch for a stacked one — clean tree, mechanically valid) and resolves any rebase conflicts **on its own branch** (within its owned scope). The branch now sits on the current base.
6. **Gate (`cross_validating`, fail-closed).** **Pre-gate invariant:** immediately before gating, require the feature worktree to be **clean** (no uncommitted/staged changes) and the reviewed tree to be exactly the branch's committed `HEAD` over the current target base — so the gate is bound to the exact tree that will land, never a dirty overlay whose changes are not in the gated commit. On the synced, clean, committed branch, run `adversarial-verification`, then both advisors — `codex-cli-advisor --model gpt-5.5` **and** `antigravity-cli-advisor --model "Gemini 3.1 Pro (High)"` — each fed a self-contained adversarial brief (canonical gate: `CLAUDE.md` §批判性验收). **Verify the resolved model, fail-closed:** a CLI can silently fall back to a different model when given an unknown id. Confirm from each advisor's run log that the **model actually sent to the backend matches the requested one**, reading the **authoritative final-selection line** — for `agy` that is `Propagating selected model override to backend: label="…"` (which must equal the requested model). Do **not** judge by an intermediate resolver line such as `Model ID … not in local config, defaulting to …` / `resolved via default`: `agy` prints that even when the requested label *does* resolve correctly, so it is misleading noise, not the verdict. If the authoritative final-selection line shows a model different from the requested one (a genuine silent fallback), treat it as a **gate FAILURE**, not a pass. (Verified locally this session: `--model "Gemini 3.1 Pro (High)"` propagates Gemini 3.1 Pro; the slug `--model gemini-3.1-pro` silently propagates Gemini 3.5 Flash — hence the requested id must be the exact label.) **Both must report no blocking findings** *and* both must be confirmed to have run the intended model. On pass, write the coordinator-owned **cross-validation record** at the durable path **`.codex-orchestrator/cross-validation/<workerTaskId>.json`** (under the canonical workspace-boundary root; coordinator-owned per the state machine), containing: `{workerTaskId, queueTaskId, gatedHeadSha, gatedBaseSha, targetBaseBranch, gateSpec:{advisors:[…], resolvedModels:[…], contractVersion}, verdicts:{codex, antigravity}, updatedAt}` — the **gateSpec.resolvedModels** are the **verified resolved model identities that actually ran** (not the requested labels — e.g. `Gemini 3.1 Pro (High)`). This file IS the durable, restart-safe gate record steps 7–8 read. Any blocking finding → the worker fixes on its branch → re-sync → re-run both. A persisted verdict is reusable (a coordinator restart need not re-gate) **only when the full key `(head SHA, base SHA, gate spec)` is unchanged**; if the gate spec changes — e.g. an advisor's model label is corrected (a silently-wrong model is exactly this failure mode) or the gate contract is bumped — the cached verdict is **invalid** and the gate MUST re-run. PR/merge readiness (step 8) requires a valid cross-validation record whose gate spec equals the current gate definition.
7. **Integrate (`merged_to_goal_test`).** Merge the gated branch into the `dev/roadmap` worktree and run **combined integration verification** there. This verification is bound to the **`(gated head SHA, gated base SHA, gate spec)` triple**; any re-sync or re-gate (new head, base, and/or gate spec) invalidates it and it must be re-run here for the new triple. On pass, also run the **mandatory pre-PR end-to-end test** here: exercise the change in the real app/flow per the project's `run` / `verify` conventions (launch the app/CLI/server, perform the real user-facing action, observe the real result), not just unit/integration tests. Then write the durable, coordinator-owned **integration-verification record** at **`.codex-orchestrator/integration-verification/<workerTaskId>.json`** — `{workerTaskId, queueTaskId, gatedHeadSha, gatedBaseSha, gateSpec, integrationResultSha, commands, results, verdict, e2e, updatedAt}`, where **`e2e` is `{"verdict":"passed", "commands":[…], "results":[…]}`** or, **only when the change is genuinely not e2e-testable, `{"verdict":"not-applicable", "reason":"…"}`** — this is the restart-safe proof that step 8 reads (reuse it only when the triple still matches; otherwise re-integrate). This whole record (including `e2e`) is written ONCE here in step 7; step 8 only reads it. The coordinator never edits product files. A combined-verification conflict is resolved **in the `dev/roadmap` worktree** (throwaway — verification only, per `AGENTS.md` "resolve in `dev/roadmap`, do not hide in a worker branch") by an explicitly-assigned, user-approved **integration worker given `dev/roadmap` worktree scope**, or is bubbled to the user. Separately, if the combination reveals that a **real** code change is needed to land, that change is made **on the relevant feature branch by its worker** and **re-gated** (step 6); landing-time base conflicts are handled by the worker's own re-sync + re-gate on its branch, which is normal rebasing, not hiding. Nothing lands only in `dev/roadmap`.
8. **PR readiness (`pr_ready`→`pr_open`), fail-closed.** Advance only when the gate passed **and** the step-7 integration-verification record (for the current `(gated head SHA, gated base SHA, gate spec)` triple) shows `verdict == passed` **and** its `e2e.verdict` is `passed` (or `not-applicable` with a recorded `reason`). The e2e test is run and recorded in step 7; step 8 only **requires** its passing presence and does not write the record. This is in addition to (not a replacement for) the gate (gate spec is exactly as defined in step 6 — advisor identities + the **verified resolved model identities that actually ran** + gate-contract version; never compare requested labels alone; a record carrying a stale gate spec is **invalid** and forces a re-gate). Each checklist below verifies the gate spec too, not just the SHAs. **Pre-push gate** — `git fetch` and require: the feature branch's local head == **gated head SHA**; the worktree is clean (no uncommitted changes that could contaminate the push); the live target base == **gated base SHA**; the cross-validation record's **gate spec == the current gate definition**; and the durable **integration-verification record** (`.codex-orchestrator/integration-verification/<workerTaskId>.json`) exists for this same triple with `verdict == passed` **and** `e2e.verdict` ∈ {`passed`, `not-applicable`(+reason)}. If any fails (base advanced, branch diverged, or e2e not passing), **re-sync → re-gate (step 6) → re-integrate (step 7)** for the new triple first — never PR a head/base/gate-spec the gate+integration did not all cover. Push the gated head. **Pre-open gate (precondition, before `gh pr create`/update)** — fetch and require the pushed remote source ref == **gated head SHA**, the live target base still == **gated base SHA**, **and** the record's **gate spec == the current gate definition** (a base that advanced, or a gate spec that changed, invalidates the gate → re-sync/re-gate/re-integrate first); only then open/update **one atomic PR per logical change from its feature worktree**, with `--base` = the recorded **PR base branch name** (e.g. `main`, never `origin/main`) and PR head = gated head — never from `main` itself, the `dev/roadmap` worktree, or any integration branch. Push, PR open/update/merge, and history rewrite are **remote/irreversible** and require explicit user approval (`AGENTS.md`). **Never** `git push --force` or `--force-with-lease` (`CLAUDE.md`); a non-fast-forward update stops for explicit user approval. **Immediately before any remote merge**, re-verify via `gh pr view --json headRefOid,baseRefName,baseRefOid`: remote `headRefOid` == gated head SHA, `baseRefName` == recorded **PR base branch name** (e.g. `main`, not `origin/main`), and `baseRefOid` == gated base SHA — **and** the cross-validation record's **gate spec == the current gate definition**; on any mismatch, re-sync/re-gate/re-integrate/re-push first. Because base can still advance between this check and the merge API call, the **merge must go through a host mechanism that enforces base-up-to-date atomically** (branch-protection "require branches up to date" / merge queue / expected-base merge), or the user performs the merge under that guarantee; this residual atomicity is infrastructure-bound and outside a prose skill's control. After a confirmed remote merge, set the worker plane to `merged_remote`. **Queue completion:** `set-status done` on the queue task **only when all its workers** (every `workerTaskId` sharing this `queueTaskId`) have reached a terminal state (`merged_remote`/`abandoned`); a single worker's merge never closes a multi-worker queue task.
9. **Report.** Reconstruct from the contract files + `git worktree list` + `gh pr list`; report queue-, worker-, and listener-plane statuses separately.

## Queue / listener mode (attended)

On `drain` / `检查队列` / `启动监听`, run queue mode over `.goalgo/` via the helper:
normalize, claim, dispatch through the same loop, and drive task status with
`set-status`. Set `.goalgo/state.json`: `active` while scanning, `idle_waiting`
when no claimable task is found (rescan no more than every 30s), `idle_paused`
after the idle timeout (default 300s). `idle_paused` is the queue-layer pause for
an empty queue — it is **not** goal completion and **not** a failure; do not
invent a goal-level status for it. Reserve listener `blocked` for a malformed or
unsafe queue.

## Worker brief template

```
You are a goal-orchestrator background worker for goal "<goal>". workerTaskId <id> (queueTaskId <qid>): <bounded task>.
- Canonical root: <ABS_PROJECT_ROOT> (workspaceBoundary). Read/write ALL .goalgo/ and .codex-orchestrator/ files via this ABSOLUTE path, never a relative path inside your own worktree (your worktree has a private gitignored copy the coordinator cannot see).
- Work ONLY inside your own worktree and ONLY on branch <branch>. Owned paths: <paths>. Your target base is <targetBase> (origin/main, or your dependency branch if stacked).
- Implement the task and self-verify. Make ATOMIC commits (type(scope): summary), one logical change each, on your branch only — these are review substrate, not yet accepted.
- When the coordinator says to sync: rebase your committed branch onto the latest <targetBase> and resolve any rebase conflicts on your own branch.
- If the gate returns blocking findings: review them, fix the code on your branch, re-commit, and re-report ready_for_goal_test. Do not argue past a real finding.
- You may be RE-ENGAGED after you stop (via a follow-up message, or a fresh worker spawned on this same branch/worktree) to sync, fix gate findings, or rebase — your branch + status file are the durable handoff.
- You MAY spawn sub-subagents (general-purpose) inside this worktree; they stay subordinate to your branch and owned paths.
- For a CODE change: deliver a WELL-FORMED module (owned by the repo's package discovery, not an unowned top-level dir; typed, documented), with UNIT tests placed under the repo's configured test path (so the DEFAULT CI test command collects them — not ad-hoc), covering happy + edge/negative cases, plus INTEGRATION tests wherever the change spans modules/contracts/surfaces. For a non-code change (docs/config/skill-only): no module/unit tests apply — run the change's relevant checks/build instead and capture evidence.
- For a code change, self-verify with the repo's DEFAULT commands (the same CI runs, e.g. `python -m pytest`, `ruff check` over CI scope), not a narrow path; capture output as evidence; a non-happy-path probe is mandatory. For a non-code change, run the change's relevant checks/build and capture evidence instead.
- You MUST NOT: push, open/merge PRs, integrate other workers, touch the dev/roadmap integration branch or local main, edit coordinator-owned files, or modify global config (~/.codex, ~/.claude, ~/.agents).
- Write <ABS_PROJECT_ROOT>/.codex-orchestrator/workers/<id>.status.json with ALL contract fields: taskId(=workerTaskId), queueTaskId, role:"worker", status, threadId:<your agent id>, branch, actualCheckout, baseBranch(=the **PR base branch name** from step 1 — e.g. `main` or your dependency branch; NOT the `origin/main` local sync ref and NOT a SHA), headCommit, workspaceBoundary, projectRoot, ownedPaths, changedFiles, dependencies, sharedFilesRequested, testCases, runtimeResources, verification[], pr:{independent, sourceWorktree, blockedBy}, risks, updatedAt. Then stop.
- Do not report ready_for_goal_test if any write/runtime path is outside the workspace boundary, or if actualCheckout is detached/mismatched.
```

## Hard boundaries

- Coordinator never edits product code (no implementation; no conflict editing). Combined-verification conflicts in `dev/roadmap` go to an explicitly-assigned integration worker with `dev/roadmap` scope (or the user); landing-time/rebase conflicts on a feature branch are resolved by that branch's **own** worker; any real fix is made on the feature branch and re-gated.
- Workers never push / PR / merge to remote / touch local `main` / edit coordinator-owned files. The only exception is a narrowly-scoped integration worker that resolves a `dev/roadmap` combined-verification conflict **only** (no feature-branch write authority) — and is **still** never granted push/PR/remote-merge/`main` rights.
- `main` is a read-only fast-forward mirror; the `dev/roadmap` worktree is combined-verification-only; neither is ever a PR source.
- All remote/irreversible actions are **fail-closed** and require explicit user approval: push, PR open/update/merge, history rewrite (any force push is otherwise forbidden), release/deploy, destructive cleanup, and any payment or scan-or-probe network intent.
- The two-advisor gate is mandatory and blocking before any change is accepted/landed (merged to `dev/roadmap`, pushed, or PR'd); the PR head must equal the gated head SHA.
- Only write inside the Git project boundary; never modify `~/.codex`, `~/.claude`, `~/.agents`, user profiles, or system paths.

## Commands / intents

- `start` / `coordinate <goal>` / `编排目标` — adopt the project, become the coordinator. Initialize the queue with the helper (`goalgo_tasks.py init`, which creates `.goalgo/`); the coordinator/workers create the `.codex-orchestrator/` files themselves on first write (`mkdir -p .codex-orchestrator/{workers,cross-validation,integration-verification}` then write the JSON) — these are plain JSON files needing no special initializer. No auto-dispatch without a concrete task.
- `task: <…>` / `加任务` — classify, enqueue + claim via the helper, dispatch a background worktree subagent worker.
- `drain` / `检查队列` / `启动监听` — attended queue mode (see Queue/listener mode).
- `status` — reconstruct from contract files + `git worktree list` + `gh pr list`; report the three status planes separately.
- `integrate` / `合练` — merge gated worker branches into the `dev/roadmap` worktree and run combined verification.
- `gate` / `验收` — run `adversarial-verification` + the two-advisor gate on a worker's synced committed branch.
- `pr` — after gate + integration + e2e pass (per the step-7 record), get user approval and open/update atomic PRs (head == gated head SHA) from feature worktrees in dependency order.
- `runtime` / `test app` — allocate/inspect/tear down per-worker runtime resources via `.codex-orchestrator/runtimes.json`.
- `cleanup` — propose safe cleanup of worktrees, branches, claims, status files, and runtime resources; ask before deleting anything.

## Bundled contracts (self-contained; this skill ships and drives its own)

- State machine + worker-status/queue/claim contracts: **`references/state-machine.md`** (bundled in this skill; no external plugin required).
- Queue helper: **`scripts/goalgo_tasks.py`** (bundled; pure-stdlib Python; subcommands `init/path/scan/add/list/show/update/delete/dead-letter/claim/next/release/set-status/state`; claim = `os.open(.goalgo/claims/<id>.json, O_CREAT|O_EXCL)`; status via `set-status`; `dead-letter` archives an unparseable/abandoned task to `.goalgo/dead-letter/`; every mutating subcommand accepts **`--dry-run`** to preview intended writes without touching any file; the helper resolves the canonical **main project root** even when invoked from inside a linked worktree). Invoke with the project Python interpreter (this repo requires Python >=3.11 — use the SuperClaw venv python or `python3.11`, not a bare `python3` that may be older), e.g. `<venv>/bin/python <skill-dir>/scripts/goalgo_tasks.py …`.
- Git discipline: `coordination.md`, `AGENTS.md`. Acceptance gate: `CLAUDE.md` §批判性验收 + `adversarial-verification`.
- `.goalgo/` and `.codex-orchestrator/` are gitignored local coordination state (runtime-neutral on-disk formats owned by this skill — no external-plugin dependency), not product code.
