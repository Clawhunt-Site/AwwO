"""Goal Mode (计划模式) planner + lifecycle driver — the kernel seam shared by
CLI / API / Web (docs/goal-mode-design.md, P0 PR2).

This is the single source for turning a goal statement into a *plan* (a topology
of role slots), persisting it as a draft → awaiting_confirmation GoalRecord, and
driving the confirm / cancel / revise lifecycle transitions against the ledger.
The actual run start (orchestrator.start_existing_goal) is injected — this module
never imports the orchestrator, so the orchestrator can import it without a cycle.

PR2 deliberately keeps execution to a single LINEAR run with no concurrency: the
concurrent-budget reservation that makes fan-out safe is a hard prerequisite for
any parallel topology and ships with fan-out (PR7), never before it.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from superclaw.models import (
    TERMINAL_RUN_STATUSES,
    GoalRecord,
    GoalSpec,
    GoalStatus,
    RunStatus,
    TaskGraph,
    TaskTopology,
    _id,
)

if TYPE_CHECKING:  # avoid importing the heavy orchestrator/state at module load
    from superclaw.state import StateStore

logger = logging.getLogger("superclaw.goal_mode")


class GoalConflict(ValueError):
    """A goal lifecycle precondition no longer holds — a stale plan hash, a wrong
    source status, or an illegal transition. Subclasses ``ValueError`` so the CLI
    keeps reporting it as a plain error; the API maps it to HTTP 409 (conflict),
    distinct from a malformed request."""


class GoalRosterError(ValueError):
    """A roster is not a shape this phase can execute (multi-entry / non-backend /
    malformed). Subclasses ``ValueError``; the API maps it to HTTP 422."""


# Topologies safe to execute in PR2 — strictly sequential (one worker at a time),
# so the concurrent-budget race (advisor finding, §9.1) cannot bite before the
# reservation layer (PR7) exists. Fan-out topologies are rejected at confirm.
_SERIAL_TOPOLOGIES: frozenset[str] = frozenset({TaskTopology.LINEAR.value})


def materialize_goal_plan(spec: GoalSpec, *, topology: TaskTopology) -> dict[str, Any]:
    """Project a goal into a concrete plan: the task graph for ``topology`` grouped
    into role slots. A slot is a unit of work a roster entry will later be bound to
    (PR4); PR2 only materializes and displays them. Pure — no persistence."""
    graph = TaskGraph.from_goal(spec, topology=topology)
    slots: list[dict[str, Any]] = []
    for task in graph.tasks:
        slot: dict[str, Any] = {
            "task_id": task.task_id,
            "role": task.role.value,
            "title": task.title,
            "depends_on": list(task.depends_on),
        }
        if task.fanout:
            slot["fanout"] = task.fanout
        slots.append(slot)
    return {
        "plan_version": 1,
        "topology": topology.value,
        "slots": slots,
    }


def compute_plan_hash(plan: dict[str, Any]) -> str:
    """Stable content hash of a plan, used as the confirm-time idempotency anchor:
    a confirmation carrying a plan_hash that no longer matches the stored plan is a
    stale replay and is rejected (TOCTOU guard, §9.1)."""
    canonical = json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def plan_goal(
    store: "StateStore",
    *,
    title: str,
    description: str,
    topology: TaskTopology = TaskTopology.LINEAR,
    source: str = "direct",
    metadata: dict[str, Any] | None = None,
) -> GoalRecord:
    """Create a goal in ``draft`` then materialize its plan and move it to
    ``awaiting_confirmation`` (revision 1). The returned record carries the plan +
    plan_hash a surface presents for confirmation. The two writes go through the
    ledger's guarded create/update (status machine + CAS), so a plan is never minted
    in any state but draft."""
    spec = GoalSpec(
        title=title,
        description=description,
        source=source,  # type: ignore[arg-type]
        metadata=dict(metadata or {}),
    )
    record = GoalRecord.new(spec)
    store.create_goal_record(record)

    plan = materialize_goal_plan(spec, topology=topology)
    record.plan = plan
    record.plan_hash = compute_plan_hash(plan)
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    record.revision = 1
    return store.update_goal_record(record, expected_revision=0)


def revise_goal(store: "StateStore", goal_id: str, *, expected_revision: int) -> GoalRecord:
    """Replan rollback: move a goal from awaiting_confirmation back to draft so a new
    plan can be generated (the confirmation surface's 'revise' action, §9.1). The
    underlying transition guard also blocks this from any other status, but we check
    explicitly for a clear error. Use :func:`replan_goal` to then re-materialize."""
    record = store.get_goal_record(goal_id)
    if record.status != GoalStatus.AWAITING_CONFIRMATION.value:
        raise GoalConflict(
            f"goal {goal_id} is {record.status}, not awaiting_confirmation; "
            "only an awaiting-confirmation goal can be revised back to draft"
        )
    record.status = GoalStatus.DRAFT.value
    record.revision = expected_revision + 1
    return store.update_goal_record(record, expected_revision=expected_revision)


def replan_goal(
    store: "StateStore",
    goal_id: str,
    *,
    expected_revision: int,
    topology: TaskTopology | None = None,
    description: str | None = None,
) -> GoalRecord:
    """Re-materialize the plan for an EXISTING goal and park it awaiting confirmation
    again — the path out of ``draft`` (and the replan loop's forward edge), so a
    revised goal is never a dead-end. Legal from ``draft`` or ``awaiting_confirmation``
    (re-plan in place). Optionally swaps the topology and/or the goal description; the
    fresh plan gets a fresh ``plan_hash`` (invalidating any stale confirmation)."""
    record = store.get_goal_record(goal_id)
    if record.status not in (GoalStatus.DRAFT.value, GoalStatus.AWAITING_CONFIRMATION.value):
        raise GoalConflict(
            f"goal {goal_id} is {record.status}; only a draft / awaiting_confirmation "
            "goal can be re-planned"
        )
    if description is not None:
        record.spec.description = description
    plan_topology = topology or TaskTopology(
        (record.plan or {}).get("topology", TaskTopology.LINEAR.value)
    )
    plan = materialize_goal_plan(record.spec, topology=plan_topology)
    record.plan = plan
    record.plan_hash = compute_plan_hash(plan)
    record.confirmation_nonce = None  # any prior confirmation handle is void
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    record.revision = expected_revision + 1
    return store.update_goal_record(record, expected_revision=expected_revision)


def cancel_goal(store: "StateStore", goal_id: str, *, expected_revision: int) -> GoalRecord:
    """Cancel a goal (terminal). Legal from any non-terminal live state."""
    record = store.get_goal_record(goal_id)
    record.status = GoalStatus.CANCELLED.value
    record.revision = expected_revision + 1
    return store.update_goal_record(record, expected_revision=expected_revision)


def confirm_goal(
    store: "StateStore",
    goal_id: str,
    *,
    expected_revision: int,
    plan_hash: str,
    roster: dict[str, Any] | None = None,
    known_backends: set[str] | None = None,
    budget: dict[str, Any] | None = None,
) -> GoalRecord:
    """Confirm an awaiting_confirmation goal and move it to ``active`` (revision
    bump). Fails closed if the supplied ``plan_hash`` no longer matches the stored
    plan (TOCTOU / stale-tab replay). The roster (PR2: a minimal single-entry
    snapshot; PR4: the full allocator output) is stamped onto the record. This does
    NOT start the run — call :func:`start_confirmed_goal_run` with an orchestrator.

    The CAS lives in ``update_goal_record``; the ``plan_hash`` equality is verified
    INSIDE that same ``BEGIN IMMEDIATE`` (via ``expected_plan_hash``), so the bind to
    the approved plan is atomic with the revision compare-and-set — no read→confirm
    TOCTOU window. A ``confirmation_nonce`` is stamped as the confirmation handle."""
    record = store.get_goal_record(goal_id)
    if record.status != GoalStatus.AWAITING_CONFIRMATION.value:
        raise GoalConflict(
            f"goal {goal_id} is {record.status}, not awaiting_confirmation; cannot confirm"
        )
    if record.plan_hash != plan_hash:  # early, friendly check (authoritative one is atomic)
        raise GoalConflict(
            f"plan hash mismatch for goal {goal_id}: the plan changed since it was "
            "shown; re-inspect and confirm the current plan"
        )
    if budget is not None:
        record.budget_policy = _normalize_budget(budget)
    _validate_topology_executable(record)  # may require a budget for a concurrent plan
    record.roster = roster if roster is not None else _default_roster()
    _validate_roster(record.roster, record.plan, known_backends)
    record.confirmation_nonce = _id("confirm")
    record.status = GoalStatus.ACTIVE.value
    record.revision = expected_revision + 1
    confirmed = store.update_goal_record(
        record, expected_revision=expected_revision, expected_plan_hash=plan_hash
    )
    # Initialise the goal's reservation ledger once it is confirmed with a budget, so a
    # concurrent fan-out run has the admission ceiling in place before it dispatches.
    total = _goal_token_budget(confirmed)
    if total > 0:
        store.set_goal_budget(confirmed.goal_id, total)
    return confirmed


def _normalize_budget(budget: dict[str, Any]) -> dict[str, Any]:
    """Coerce a caller's budget dict to the stored ``budget_policy`` shape, keeping only
    the non-negative integer token fields the reservation ledger understands."""
    out: dict[str, Any] = {}
    for key in ("token_budget", "per_worker_tokens"):
        try:
            value = int(budget.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            out[key] = value
    return out


def _goal_token_budget(record: GoalRecord) -> int:
    """The goal's configured total token budget (0 = none). The budget is the
    admission ceiling for concurrent fan-out (PR7); a concurrent topology may only run
    when this is > 0."""
    policy = record.budget_policy or {}
    try:
        return max(0, int(policy.get("token_budget") or 0))
    except (TypeError, ValueError):
        return 0


def _goal_per_worker_tokens(record: GoalRecord) -> int:
    """The per-worker reservation slice for this goal's fan-out admission. Explicit
    ``per_worker_tokens`` wins; otherwise the total budget split across the topology's
    concurrency (so a full wave of workers fits exactly once)."""
    policy = record.budget_policy or {}
    try:
        explicit = int(policy.get("per_worker_tokens") or 0)
    except (TypeError, ValueError):
        explicit = 0
    if explicit > 0:
        return explicit
    total = _goal_token_budget(record)
    lanes = max(1, _topology_lanes((record.plan or {}).get("topology")))
    return max(1, total // lanes) if total > 0 else 0


# Concurrent fan-out topologies and how many workers each may run AT ONCE (its budget
# "lanes"). IMPLEMENT_FANOUT is a 2-wide FRONTIER (the two implement tasks); the
# fan-out-NODE topologies (PR9) expand a single node into a parallel subagent group:
# EXPLORE_FANOUT (2 explore branches) and REVIEW_CONSENSUS (3 review branches, consensus
# aggregation). Every concurrent topology needs a token budget (the hard gate) and gets
# the same per-worker reservation admission — for the frontier in PR7, and for the
# fan-out-node child group in PR9.
_TOPOLOGY_LANES: dict[str, int] = {
    TaskTopology.IMPLEMENT_FANOUT.value: 2,
    TaskTopology.EXPLORE_FANOUT.value: 2,
    TaskTopology.REVIEW_CONSENSUS.value: 3,
}


def _topology_lanes(topology: str | None) -> int:
    """Max workers a topology runs at once — the divisor for the per-worker budget slice
    and the admission cap. 1 for LINEAR / unknown."""
    return _TOPOLOGY_LANES.get(topology or "", 1)


def _topology_is_concurrent(topology: str | None) -> bool:
    """Whether a topology runs workers concurrently (frontier OR fan-out node) and so
    must carry a token budget + reservation admission."""
    return _topology_lanes(topology) > 1


def _topology_concurrency(topology: str | None) -> int:
    """The RUN-LEVEL frontier concurrency passed to the orchestrator loop. Only
    IMPLEMENT_FANOUT runs its parallelism as a wide FRONTIER (concurrency=2); the
    fan-out-NODE topologies keep a serial frontier (concurrency=1) and run their
    branches inside a single node via the child fan-out path, which has its own
    bounded concurrency + the same goal-budget admission."""
    if topology == TaskTopology.IMPLEMENT_FANOUT.value:
        return 2
    return 1


def _validate_topology_executable(record: GoalRecord) -> None:
    """Fail closed unless a goal's plan is executable. LINEAR always is. A concurrent
    topology (IMPLEMENT_FANOUT frontier, or the EXPLORE_FANOUT / REVIEW_CONSENSUS
    fan-out-node groups) is executable ONLY when a token budget is configured — the hard
    gate that concurrency never ships without budget reservation (§9.3). Any other /
    missing / malformed topology is rejected (never defaulted)."""
    topology = (record.plan or {}).get("topology")
    if topology in _SERIAL_TOPOLOGIES:
        return
    if _topology_is_concurrent(topology):
        if _goal_token_budget(record) <= 0:
            raise ValueError(
                f"topology {topology!r} is concurrent and requires a token budget "
                "(set budget_policy.token_budget at confirm); concurrent fan-out must "
                "not run without budget reservation"
            )
        return
    raise ValueError(
        f"topology {topology!r} is not executable: a goal run requires an explicit "
        "LINEAR plan, or a budgeted concurrent topology (IMPLEMENT_FANOUT / "
        "EXPLORE_FANOUT / REVIEW_CONSENSUS)"
    )


def _plan_roles(plan: dict[str, Any] | None) -> list[str]:
    """The distinct role names the plan's slots need an agent for, in plan order.
    A goal can only be executed once every one of these roles has a runtime bound
    (a role entry or the lead) — that is the coverage the allocator enforces."""
    seen: list[str] = []
    for slot in (plan or {}).get("slots") or []:
        role = slot.get("role")
        if isinstance(role, str) and role and role not in seen:
            seen.append(role)
    return seen


def _validate_roster(
    roster: dict[str, Any] | None,
    plan: dict[str, Any] | None,
    known_backends: set[str] | None = None,
) -> None:
    """Fail closed unless the roster is a shape the allocator can execute: a list of
    backend-sourced entries, each either the LEAD (``role`` omitted/None — applies to
    every otherwise-unbound slot) or bound to exactly one of the plan's slot roles.

    Rules (all fail-closed — an unexecutable roster is rejected, never silently run
    as only its first entry, which would diverge from what was approved):
      * at least one entry; every entry ``source == 'backend'``;
      * at most one lead; no two entries bind the same role;
      * a bound entry's role must be a real slot role in the plan;
      * COVERAGE: every plan slot role must be covered by a role entry or the lead —
        otherwise the unbound roles are reported.

    Back-compat: a single lead entry (no role) is the PR2/PR3 single-runtime roster.
    Company-profile-sourced entries are a later increment; PR4 binds backends/models
    per role, never writing anything into ``agent_profiles``."""
    entries = (roster or {}).get("entries")
    if not isinstance(entries, list) or not entries:
        raise GoalRosterError("roster must have at least one entry")
    roles = _plan_roles(plan)
    bound: set[str] = set()
    lead_count = 0
    for entry in entries:
        if not isinstance(entry, dict):
            raise GoalRosterError("each roster entry must be an object")
        if entry.get("source") != "backend":
            raise GoalRosterError("each roster entry must be source='backend'")
        # Fail-closed (铁律2 approved == executed): when the caller supplies the live
        # backend names, a roster naming an unknown backend is rejected at confirm
        # rather than silently degrading to the lead at run time. A null backend means
        # "shell default" and is always allowed.
        backend_name = entry.get("backend")
        if known_backends is not None and backend_name and backend_name not in known_backends:
            raise GoalRosterError(
                f"roster entry names unknown backend {backend_name!r} "
                f"(known: {', '.join(sorted(known_backends)) or 'none'})"
            )
        role = entry.get("role")
        if role is None:
            lead_count += 1
            continue
        if not isinstance(role, str) or role not in roles:
            raise GoalRosterError(
                f"roster entry binds role {role!r} which is not a slot in the plan "
                f"(plan roles: {', '.join(roles) or 'none'})"
            )
        if role in bound:
            raise GoalRosterError(f"role {role!r} is bound by more than one roster entry")
        bound.add(role)
    if lead_count > 1:
        raise GoalRosterError("roster has more than one lead (role-less) entry")
    if lead_count == 0:
        uncovered = [r for r in roles if r not in bound]
        if uncovered:
            raise GoalRosterError(
                "roster does not cover every plan slot; add a lead entry or bind: "
                + ", ".join(uncovered)
            )


def _default_roster() -> dict[str, Any]:
    """A goal confirmed with no explicit roster runs on the shell's default backend
    as a single LEAD entry covering every slot. A backend-sourced entry is never
    written into agent_profiles."""
    return {"entries": [{"source": "backend", "role": None, "backend": None, "model": None, "effort": None}]}


def _roster_lead_runtime(roster: dict[str, Any] | None) -> dict[str, Any]:
    """The run-level default runtime (backend/model/effort) — the lead entry, else the
    first entry. This is what the orchestrator resolves the run's base backend from;
    per-slot overrides ride ``goal_slot_runtimes`` (see :func:`_roster_slot_runtimes`).
    A null backend falls back to the shell default."""
    entries = (roster or {}).get("entries") or []
    lead = next((e for e in entries if e.get("role") is None), entries[0] if entries else {})
    return {
        "backend": lead.get("backend") or "claude",
        "model": lead.get("model"),
        "effort": lead.get("effort"),
    }


def _roster_slot_runtimes(roster: dict[str, Any] | None, plan: dict[str, Any] | None) -> dict[str, Any]:
    """Project the roster into a per-role runtime map ``{role: {backend, model,
    effort}}`` covering EVERY plan role — a role entry wins, else the lead. This is the
    execution source of truth the orchestrator reads to run each serial slot on its
    bound agent (铁律2: each slot executes on the runtime its confirmed roster names)."""
    entries = (roster or {}).get("entries") or []
    lead = _roster_lead_runtime(roster)
    by_role: dict[str, dict[str, Any]] = {}
    for entry in entries:
        role = entry.get("role")
        if isinstance(role, str) and role:
            by_role[role] = {
                "backend": entry.get("backend") or lead["backend"],
                "model": entry.get("model"),
                "effort": entry.get("effort"),
            }
    out: dict[str, Any] = {}
    for role in _plan_roles(plan):
        out[role] = by_role.get(role, dict(lead))
    return out


def goal_has_live_run(store: "StateStore", goal_id: str) -> bool:
    """True if the goal already has a non-terminal run — used to keep start
    idempotent: a confirmed goal is started AT MOST once while a run is live, so a
    retry after a crash resumes rather than spawning a duplicate run."""
    return any(
        run.goal_id == goal_id and run.status not in TERMINAL_RUN_STATUSES
        for run in store.list_runs()
    )


def start_confirmed_goal_run(
    orchestrator: Any,
    record: GoalRecord,
    *,
    repo_path: Any = ".",
    budget_seconds: int = 60,
    artifact_dir: Any = None,
    dry_run: bool = False,
    harness_policy: str = "codex",
    permission_policy: Any = None,
) -> Any:
    """Run the (single, LINEAR) confirmed goal to completion. The orchestrator is
    injected so this module stays free of the orchestrator import; CLI and API both
    call this one helper so the confirm→run wiring is identical across surfaces
    (铁律2 zero-divergence). Returns a RunResult.

    The runtime (backend/model/effort) comes from the goal's CONFIRMED roster, never
    from separate caller arguments — so a goal can only execute on the runtime it was
    approved with. The topology is re-checked serial here (defense in depth, not just
    at confirm), and a goal that already has a live run is refused so a confirm→start
    crash-retry resumes rather than duplicating the run.

    Uses the SYNCHRONOUS ``run_existing_goal`` (not the background
    ``start_existing_goal``) so a short-lived CLI process actually runs the goal to
    completion rather than spawning a daemon thread that dies on exit. The run links
    to the goal by ``goal_id`` (the ledger's 1:N relationship); ``create_goal`` inside
    the orchestrator is an ON CONFLICT upsert, so re-persisting the spec never
    clobbers the lifecycle record.

    PR2 contract: ``task_topology=LINEAR`` / ``concurrency=1`` are pinned here, not
    caller-overridable — no concurrent fan-out ships before the budget-reservation
    layer (PR7).

    Start is made atomic against the ledger, NOT the caller's possibly-stale
    ``record``: the current record is re-read from the store, re-validated (status /
    topology / roster / no live run), and then a revision-CAS claim
    (``active -> active``, revision bump) is taken BEFORE the run is created. Two
    concurrent starts that read the SAME revision both pass the live-run scan but
    only one wins the CAS; the loser gets ``GoalRevisionConflict``. A goal cancelled
    between the caller's read and this call is caught by the fresh re-read.

    Daemon-safe single-flight (PR8): in addition to the revision-CAS claim (which
    seals two starts that read the SAME revision), an ATOMIC start lease
    (``claim_goal_start_lease``) is held across the whole start+run, closing the
    sequential window between a claim committing and its run row existing that two
    overlapping autonomous-continuation ticks could otherwise both pass. A stale lease
    is reclaimed by time + the no-live-run scan, so a crashed start never strands a
    goal."""
    store = orchestrator.store
    current = store.get_goal_record(record.goal_id)  # never trust the caller's stale copy
    if current.status != GoalStatus.ACTIVE.value:
        raise ValueError(
            f"goal {current.goal_id} is {current.status}, not active; confirm it first"
        )
    _validate_topology_executable(current)
    _validate_roster(current.roster, current.plan)
    # Daemon-safe single-flight: an ATOMIC start lease closes the window between the
    # no-live-run check + revision claim and the run row actually existing, so two
    # overlapping autonomous-continuation ticks cannot both create a run. Held for the
    # whole synchronous start+run and released in the finally below.
    if not store.claim_goal_start_lease(current.goal_id):
        raise ValueError(f"goal {current.goal_id} is already being started")
    try:
        return _start_confirmed_goal_run_locked(
            orchestrator, store, current,
            repo_path=repo_path, budget_seconds=budget_seconds, artifact_dir=artifact_dir,
            dry_run=dry_run, harness_policy=harness_policy, permission_policy=permission_policy,
        )
    finally:
        store.release_goal_start_lease(current.goal_id)


def _start_confirmed_goal_run_locked(
    orchestrator: Any,
    store: "StateStore",
    current: GoalRecord,
    *,
    repo_path: Any,
    budget_seconds: int,
    artifact_dir: Any,
    dry_run: bool,
    harness_policy: str,
    permission_policy: Any,
) -> Any:
    if goal_has_live_run(store, current.goal_id):
        raise ValueError(
            f"goal {current.goal_id} already has a live run; not starting a duplicate"
        )
    # Atomic start claim: bump the revision (active -> active) under the ledger CAS so
    # two concurrent starts cannot both proceed past this point.
    claim_revision = current.revision
    current.revision = claim_revision + 1
    store.update_goal_record(current, expected_revision=claim_revision)
    # The run's BASE runtime is the lead; per-slot overrides ride goal_slot_runtimes
    # so each slot runs on the agent its confirmed roster bound to it.
    lead = _roster_lead_runtime(current.roster)
    slot_runtimes = _roster_slot_runtimes(current.roster, current.plan)
    topology = TaskTopology((current.plan or {}).get("topology", TaskTopology.LINEAR.value))
    concurrency = _topology_concurrency(topology.value)
    extra: dict[str, Any] = {"goal_slot_runtimes": slot_runtimes}
    # Any concurrent topology passes the admission ceiling down: the orchestrator
    # reserves `per_worker_tokens` from the goal's budget before dispatching each
    # concurrent worker and denies one that does not fit (no concurrent overspend). The
    # SAME reservation drives the frontier path (PR7) and the fan-out-node child group
    # (PR9), so EXPLORE_FANOUT / REVIEW_CONSENSUS branches are admitted identically.
    if _topology_is_concurrent(topology.value) and _goal_token_budget(current) > 0:
        extra["goal_budget_reservation"] = {
            "goal_id": current.goal_id,
            "per_worker_tokens": _goal_per_worker_tokens(current),
        }
    result = orchestrator.run_existing_goal(
        current.spec,
        dry_run=dry_run,
        backend_policy=lead["backend"],
        model=lead["model"],
        effort=lead["effort"],
        repo_path=repo_path,
        concurrency=concurrency,
        budget_seconds=budget_seconds,
        artifact_dir=artifact_dir,
        harness_policy=harness_policy,
        permission_policy=permission_policy,
        task_topology=topology,
        execution_context_extra=extra,
    )
    # PR5 completion-gate projection: the goal's execution-phase status is DERIVED
    # from its run outcome, never agent-self-reported. The run already passed its own
    # verification gate, so its terminal status is the goal's gate (run_existing_goal
    # is synchronous, so the run is terminal here). reconcile_goal_status retries CAS
    # conflicts internally; only a truly unexpected failure reaches here, and it must
    # NOT mask the run result the caller needs — so it is logged, never swallowed
    # silently, and the run result is still returned.
    try:
        reconcile_goal_status(store, current.goal_id, run_id=result.session.run_id)
    except Exception:  # noqa: BLE001 - best-effort post-run projection; run result must survive
        logger.warning("goal %s status projection failed after its run", current.goal_id, exc_info=True)
    return result


def _run_passed_verification(store: "StateStore", run: Any) -> bool:
    """A completed run counts as a goal-COMPLETING success only if its evidence chain
    verdict is not ``FAIL`` — i.e. the run's own adversarial verification recorded no
    failing finding. Fail-closed: missing / unreadable evidence is treated as NOT
    passed (a run cannot complete a goal without provable verification)."""
    from superclaw.models import ChainVerdict

    try:
        evidence = store.get_evidence(run.run_id)
    except KeyError:
        return False
    return evidence.chain_verdict != ChainVerdict.FAIL


def _project_goal_status_from_runs(store: "StateStore", record: GoalRecord) -> tuple[str | None, str | None]:
    """The execution-phase goal status DERIVED from the goal's DESIGNATED run
    (``record.last_run_id``, stamped at start). Returns ``(target_status,
    completing_run_id)``; ``(None, None)`` means nothing should change (the goal is not
    in an execution phase, or has no designated run yet).

    Deriving from the stamped run — not "the newest row" — is what makes this stable:
    runs are persisted with INSERT OR REPLACE, so rowid order is NOT attempt order, and
    a re-saved old run could otherwise masquerade as the latest. The designated run
    that is non-terminal → ``active``; COMPLETED **and** evidence verdict passed →
    ``complete`` (with that run id, which the completion gate independently re-verifies);
    otherwise (failed / cancelled / completed-but-FAIL-verdict) → ``blocked``."""
    if record.status not in (
        GoalStatus.ACTIVE.value,
        GoalStatus.BLOCKED.value,
        GoalStatus.BUDGET_LIMITED.value,
    ):
        return None, None  # draft / awaiting_confirmation / complete / cancelled are not run-derived
    run_id = record.last_run_id
    if not run_id:
        return None, None  # no run has been designated for this goal yet
    try:
        run = store.get_run(run_id)
    except KeyError:
        return None, None
    if run.goal_id != record.goal_id:
        return None, None
    if run.status not in TERMINAL_RUN_STATUSES:
        return GoalStatus.ACTIVE.value, None
    if run.status == RunStatus.COMPLETED.value and _run_passed_verification(store, run):
        return GoalStatus.COMPLETE.value, run.run_id
    return GoalStatus.BLOCKED.value, None


def reconcile_goal_status(
    store: "StateStore", goal_id: str, *, run_id: str | None = None, max_attempts: int = 5
) -> GoalRecord:
    """Re-derive and persist a goal's execution-phase status from its DESIGNATED run
    (idempotent). ``run_id`` (passed by start_confirmed_goal_run) designates the run
    this goal's status derives from and is stamped onto the record; without it the
    goal's existing ``last_run_id`` is used. A no-op when the projection matches the
    stored status (and the designation is unchanged).

    Wrapped in a bounded CAS RETRY loop: another writer can bump the revision between
    the read and the write, so on ``GoalRevisionConflict`` we re-read, re-derive (the
    projection is stable — a run does not un-finish), and retry, so a real terminal
    state is never silently dropped. ``complete`` is reached ONLY from ``active`` (the
    normal post-run state); a non-active goal is never force-completed (no multi-step
    transition window). On non-convergence it logs and returns the latest record
    rather than raising into the caller's run result."""
    from superclaw.state import GoalRevisionConflict

    # Step 1 — DURABLY designate the run (a separate write) BEFORE any completion, so
    # the gate can validate the completing run_id against the goal's STORED last_run_id
    # (not a value the same write supplies). Without this, a single write could forge
    # "designated + complete" together.
    if run_id:
        for _ in range(max(1, max_attempts)):
            record = store.get_goal_record(goal_id)
            if record.last_run_id == run_id:
                break
            record.revision += 1
            try:
                store.designate_goal_run(record, expected_revision=record.revision - 1, run_id=run_id)
                break
            except GoalRevisionConflict:
                continue

    # Step 2 — derive + persist the status from the (now durable) designated run.
    for _ in range(max(1, max_attempts)):
        record = store.get_goal_record(goal_id)
        target, completing_run_id = _project_goal_status_from_runs(store, record)
        if target is None or target == record.status:
            return record
        try:
            record.status = target
            record.revision += 1
            # ``complete`` is terminal and is reached ONLY from ``active`` (the normal
            # post-run state) through the ledger's completion gate, which re-verifies
            # the completing run (designated + completed + evidence verdict != FAIL)
            # INSIDE its own write transaction.
            if target == GoalStatus.COMPLETE.value:
                return store.complete_goal_record(
                    record, expected_revision=record.revision - 1, run_id=completing_run_id
                )
            return store.update_goal_record(record, expected_revision=record.revision - 1)
        except GoalRevisionConflict:
            continue  # a concurrent writer moved the revision — re-read + re-derive
    logger.warning(
        "goal %s status reconciliation did not converge after %d attempts", goal_id, max_attempts
    )
    return store.get_goal_record(goal_id)


def continue_active_goals(
    orchestrator: Any,
    *,
    enabled: bool | None = None,
    repo_path: Any = ".",
    budget_seconds: int = 60,
    artifact_dir: Any = None,
    max_goals: int = 5,
) -> list[str]:
    """Autonomous continuation daemon tick (PR8) — auto-start CONFIRMED goals that are
    ``active`` with no live run, so a goal the human already approved progresses without
    a human-initiated start. Returns the goal_ids continued this tick.

    Fail-closed, opt-in: a STRICT no-op unless ``enabled`` is True (resolved from the
    shell config when None) — autonomy is off by default and a corrupt config can only
    keep it off. Single-flight is the start CAS itself: two ticks racing the same goal
    both call :func:`start_confirmed_goal_run`, but only one wins the revision claim (the
    other gets ``GoalRevisionConflict`` and is skipped). Continuation only decides WHEN an
    approved goal runs — the run carries its OWN governance (budget / risk / human gates),
    so no gate is ever bypassed. A per-goal failure is logged and skipped so one bad goal
    never aborts the tick."""
    if enabled is None:
        from superclaw.runtime_config import goal_autonomous_continuation_enabled

        enabled = goal_autonomous_continuation_enabled()
    if not enabled:
        return []
    store = orchestrator.store
    continued: list[str] = []
    for record in store.list_goal_records(statuses={GoalStatus.ACTIVE.value}):
        if len(continued) >= max(0, int(max_goals)):
            break
        if not record.roster:
            continue  # not confirmed (no roster) — nothing runnable
        if goal_has_live_run(store, record.goal_id):
            continue  # already running — never double-start
        try:
            start_confirmed_goal_run(
                orchestrator,
                record,
                repo_path=repo_path,
                budget_seconds=budget_seconds,
                artifact_dir=artifact_dir,
            )
            continued.append(record.goal_id)
        except Exception as exc:  # noqa: BLE001 — one goal's failure must not abort the tick
            logger.info("autonomous continuation skipped goal %s: %s", record.goal_id, exc)
    return continued
