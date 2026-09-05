# Agent Team Kernel (Phase 1)

Status: Phase 1 implemented (CLI kernel first)
Audience: SuperClaw maintainers

The Agent Team Kernel layers an **organization** on top of the single-run
harness. Where a plugin equips one run with a capability, the team kernel lets a
team of agents take on a complex task: roles carry equipment, work is delegated
as issues with atomic checkout locks, and completion passes through a human
approval gate.

It is absorbed from Paperclip's "AI agent company" model, reduced to a
single-machine personal workstation: no Postgres, no multi-company isolation, no
HR-style hiring ceremony, no background cron autonomy. We keep the load-bearing
control-plane constraints; we drop the SaaS bulk.

## Mental model (orthogonal layers, not a replacement)

```
Crew / company layer   org chart · delegation · approval · (budget)   ← this kernel
Agent / role layer     a persistent "employee" with a backend + budget
Equipment layer        existing plugins + skills, attached to a role
Core harness           orchestrator · state · verifier · evidence (one run)
```

The plugin system is **not** replaced — it sinks down into "equipment" a role
carries. Without the team kernel, a plugin only augments a single run; without
plugins, a role is an empty title.

## Data model (`models.py`, persisted in `state.py` / SQLite)

- `AgentProfile` — a role: `role`, `title`, `backend_policy`, `plugin_allowlist`,
  `permission_policy`, `budget_seconds`, `context_mode`, `reports_to`,
  `revision_id`. Reserved namespace fields (`workspace_id`,
  `company_profile_id`, `owner_id`) are populated with local defaults now and
  carry the team/multi-user future without a migration.
- `Issue` — the unit of delegated work. Single-assignee. Carries the
  ownership/execution lock pair `checkout_run_id` (who owns execution rights)
  and `execution_run_id` (which run is live), mirroring control-plane checkout
  semantics.
- `WorkspaceLock` — a durable, cross-process checkout lock on a workspace
  resource. Unlike the in-process `ResourceLockManager`, it survives across
  separate CLI invocations and agent runs.
- `Approval` — a first-class approval record (not a UI popup): who requested
  what permission, which run/issue/plugin it affects, and the kernel action that
  resumes on approval.

## State machines (fail-closed)

Issue status: `backlog → todo → in_progress → in_review → done`, with `blocked`
and `cancelled` as side states. **`done` is only reachable from `in_review`** —
there is no `in_progress → done` shortcut, so completion always passes the
approval gate. `state.save_issue` rejects illegal transitions, so a direct write
cannot bypass the gate.

Approval status: `pending → approved | rejected | revision_requested |
cancelled`. A decided approval cannot be re-decided.

## Security invariants

1. **Equipment can only narrow.** `team_kernel.resolve_equipment` intersects a
   profile's `plugin_allowlist` with the governed runtime projection
   (`plugin_runtime_projection.available_plugins` =
   installed ∩ signature-valid ∩ not-revoked ∩ entitled ∩ policy-allowed). A
   profile can never grant a plugin governance withheld; withheld requests
   surface as `dropped` rather than silently vanishing.
2. **Checkout is atomic.** `state.acquire_workspace_lock` uses
   `BEGIN IMMEDIATE`; the losing concurrent checkout fails closed rather than
   sharing the workspace.
3. **Completion requires a human.** An agent moves work to `in_review` and opens
   an approval; only `approve grant` flips the issue to `done` and releases the
   lock.

## CLI surface (the single source of truth)

```
superclaw agent create-profile <name> <role> [--title --workspace --backend
                                              --plugin (repeatable) --budget-seconds
                                              --context-mode --reports-to]
superclaw agent list [--workspace]
superclaw agent show <profile_id>          # shows granted vs dropped equipment

superclaw issue create <title> [--description --workspace --priority --goal]
superclaw issue assign <issue_id> <profile_id>
superclaw issue checkout <issue_id> [--run-id --holder]   # takes the workspace lock
superclaw issue submit <issue_id> [--by --summary]        # opens completion approval
superclaw issue list [--workspace --status]

superclaw approve list [--status]          # default: the pending queue
superclaw approve show <approval_id>
superclaw approve grant <approval_id> [--by --note]
superclaw approve reject <approval_id> [--by --note]
```

## Surface contracts (`ui_contracts.py`)

`build_team_inventory_payload`, `build_approval_queue_payload`, and
`build_workspace_locks_payload` are read-only projections for the Web/Desktop
workbench. Surfaces render these; they never compute organization state
themselves and never mutate state directly — mutations always flow back through
the CLI commands above. This is the iron law: if the CLI does not have a
semantic, a surface may not have it first.

## REST + Desktop surface

`apps/api/main.py` projects the kernel over HTTP — GET routes return the
`ui_contracts` read models, POST routes call the same `team_kernel` functions
the CLI drives:

```
GET  /api/team/inventory | /api/team/agents | /api/team/agents/{id}
     /api/team/issues    | /api/team/approvals | /api/team/locks
POST /api/team/agents
     /api/team/issues
     /api/team/issues/{id}/assign | /checkout | /submit
     /api/team/approvals/{id}/grant | /reject
```

Error codes mirror the kernel: unknown entity → 404, governance/lock conflict
(the CLI's non-zero exit) → 409.

The macOS desktop (`apps/desktop`) spawns this exact `create_app` via uvicorn —
no separate path allowlist — and loads the web bundle. The web company board
(`apps/web/src/CompanyBoard.tsx`, the natively-mounted Paperclip board reached via
the **Team** rail button) renders the roster, an issue board (columns by status),
and the approval inbox with one-click grant/reject. It is pure presentation: every
button calls the company board API and re-reads the projection; it computes no
organization state itself. If the
CLI lacks a semantic, the desktop must not have it first.

## Orchestrator integration

`spawn_child_runs` child specs accept an optional `agent_profile_id`. When set,
the bound profile supplies role defaults (backend, budget) unless the spec
overrides them, and the profile id is recorded on the child run's execution
context and spawn event. The change is additive and backward-compatible: an
absent or unknown profile degrades to inherited parent context.

## Deferred (later phases)

- Phase 2: workspace portability — serialize issues/approvals/profiles to
  `.superclaw/*.json` so a teammate `git pull` can take over (no cloud required).
- Phase 3: multi-user control plane (server identity, assignment queue).
- Phase 4: organization/company paradigm (departments, SSO/RBAC) — interfaces
  designed, not yet implemented.

Budget hard-stops, heartbeat scheduling, and deep `reports_to` execution
semantics are intentionally out of Phase 1.
