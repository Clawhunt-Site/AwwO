from __future__ import annotations

import uuid
import json
from dataclasses import asdict, dataclass, field, fields
from enum import Enum
from time import time
from typing import Any, Literal


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class ChainVerdict(str, Enum):
    CONTROL_PLANE_READY = "CONTROL_PLANE_READY"
    CHAIN_PARTIAL = "CHAIN_PARTIAL"
    E2E_PROVEN = "E2E_PROVEN"
    FAIL = "FAIL"


class WorkerRole(str, Enum):
    EXPLORE = "explore"
    PLAN = "plan"
    IMPLEMENT = "implement"
    VERIFY = "verify"
    REVIEW = "review"


class TaskTopology(str, Enum):
    LINEAR = "linear"
    IMPLEMENT_FANOUT = "implement_fanout"
    EXPLORE_FANOUT = "explore_fanout"
    REVIEW_CONSENSUS = "review_consensus"


class RunMutationMode(str, Enum):
    EXECUTE = "execute"
    RESUME = "resume"
    RECONCILE = "reconcile"


class ChildAggregationPolicy(str, Enum):
    """How a parallel subagent fan-out's child outcomes combine into one verdict."""

    ALL_SUCCEED = "all_succeed"      # every child must avoid a FAIL verdict
    ANY_SUCCEEDS = "any_succeeds"    # at least one child must succeed
    BEST_EFFORT = "best_effort"      # record outcomes without gating
    CONSENSUS = "consensus"          # a strict majority of children must succeed
    QUORUM = "quorum"                # at least `quorum` children must succeed


class RunStatus(str, Enum):
    CREATED = "created"
    QUEUED = "queued"
    RUNNING = "running"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    WAITING_FOR_HUMAN_GATE = "WAITING_FOR_HUMAN_GATE"
    WAITING_FOR_CHILD_DELEGATION = "WAITING_FOR_CHILD_DELEGATION"


TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED.value,
    RunStatus.FAILED.value,
    RunStatus.CANCELLED.value,
}


_ALLOWED_RUN_STATUS_TRANSITIONS: dict[str, set[str]] = {
    RunStatus.CREATED.value: {
        RunStatus.CREATED.value,
        RunStatus.QUEUED.value,
        RunStatus.FAILED.value,
        RunStatus.CANCELLED.value,
    },
    RunStatus.QUEUED.value: {
        RunStatus.QUEUED.value,
        RunStatus.RUNNING.value,
        RunStatus.CANCELLED.value,
        RunStatus.FAILED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
        RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
    },
    RunStatus.RUNNING.value: {
        RunStatus.RUNNING.value,
        RunStatus.QUEUED.value,
        RunStatus.VERIFYING.value,
        RunStatus.CANCELLED.value,
        RunStatus.FAILED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
        RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
    },
    RunStatus.VERIFYING.value: {
        RunStatus.VERIFYING.value,
        RunStatus.QUEUED.value,
        RunStatus.COMPLETED.value,
        RunStatus.CANCELLED.value,
        RunStatus.FAILED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
        RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
    },
    RunStatus.COMPLETED.value: {
        RunStatus.COMPLETED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
    },
    RunStatus.FAILED.value: {
        RunStatus.FAILED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
    },
    RunStatus.CANCELLED.value: {
        RunStatus.CANCELLED.value,
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
    },
    RunStatus.WAITING_FOR_HUMAN_GATE.value: {
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
        RunStatus.QUEUED.value,
        RunStatus.RUNNING.value,
        RunStatus.VERIFYING.value,
        RunStatus.COMPLETED.value,
        RunStatus.FAILED.value,
        RunStatus.CANCELLED.value,
    },
    RunStatus.WAITING_FOR_CHILD_DELEGATION.value: {
        RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
        RunStatus.QUEUED.value,
        RunStatus.RUNNING.value,
        RunStatus.VERIFYING.value,
        RunStatus.COMPLETED.value,
        RunStatus.FAILED.value,
        RunStatus.CANCELLED.value,
    },
}


def is_valid_run_status_transition(previous: str, current: str) -> bool:
    return current in _ALLOWED_RUN_STATUS_TRANSITIONS.get(previous, {previous})


class MarketplaceOrderStatus(str, Enum):
    """The durable saga state of a claimed ClawHunt marketplace order.

    A marketplace order ties a remote ClawHunt problem to a local delivery
    (company Issue + run) so the claim → deliver → submit lifecycle survives a
    crash and never produces an orphan (remote-committed, locally-lost) order
    (advisor阻断项 2, Codex gpt-5.5 + Antigravity Gemini 3.1 Pro). The ledger row,
    NOT an Issue's metadata, is the source of truth (CreateIssueCommand carries no
    metadata field; Issue metadata is not a saga).

    Happy path:
      claim_approval_pending → claiming → claimed_remote → issue_bound
        → run_started → review_pending → ready_to_submit
        → submit_approval_pending → submitting → submitted

    Failure / compensation edges:
      * claiming → claim_failed       (remote claim rejected; nothing committed)
      * run_started → run_failed      (delivery run failed/cancelled)
      * run_failed → abandoning → abandoned   (release the remote commitment)
      * submitting → submit_failed    (remote submit errored; retriable)
      * any non-terminal → blocked    (needs a human; e.g. no remote release API)
    """

    CLAIM_APPROVAL_PENDING = "claim_approval_pending"
    CLAIMING = "claiming"
    CLAIM_FAILED = "claim_failed"
    CLAIMED_REMOTE = "claimed_remote"
    ISSUE_BOUND = "issue_bound"
    RUN_STARTED = "run_started"
    RUN_FAILED = "run_failed"
    REVIEW_PENDING = "review_pending"
    READY_TO_SUBMIT = "ready_to_submit"
    SUBMIT_APPROVAL_PENDING = "submit_approval_pending"
    SUBMITTING = "submitting"
    SUBMITTED = "submitted"
    SUBMIT_FAILED = "submit_failed"
    ABANDONING = "abandoning"
    ABANDONED = "abandoned"
    BLOCKED = "blocked"


#: Terminal saga states — an order in one of these is settled; the ledger never
#: leaves them and the (base_url, problem_id) unique slot is considered released
#: ONLY for ``abandoned`` (a fresh claim may re-take an abandoned order).
TERMINAL_MARKETPLACE_ORDER_STATUSES = {
    MarketplaceOrderStatus.SUBMITTED.value,
    MarketplaceOrderStatus.CLAIM_FAILED.value,
    MarketplaceOrderStatus.ABANDONED.value,
}


_ALLOWED_MARKETPLACE_ORDER_TRANSITIONS: dict[str, set[str]] = {
    MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value: {
        MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value,
        MarketplaceOrderStatus.CLAIMING.value,
        MarketplaceOrderStatus.CLAIM_FAILED.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.CLAIMING.value: {
        MarketplaceOrderStatus.CLAIMING.value,
        MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        MarketplaceOrderStatus.CLAIM_FAILED.value,
        # An AMBIGUOUS remote error (timeout / disconnect / no response) during a
        # claim grant goes to BLOCKED, NOT back to a retriable state (advisor阻断项,
        # Codex): the remote may or may not have committed, so we must NOT assume
        # "not claimed" (that would risk a double-claim on retry or a wrong slot
        # release). BLOCKED retains the slot and parks the order for reconciliation.
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.CLAIMED_REMOTE.value: {
        MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.ISSUE_BOUND.value: {
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.RUN_STARTED.value: {
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.REVIEW_PENDING.value,
        MarketplaceOrderStatus.RUN_FAILED.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.RUN_FAILED.value: {
        MarketplaceOrderStatus.RUN_FAILED.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.REVIEW_PENDING.value: {
        MarketplaceOrderStatus.REVIEW_PENDING.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.READY_TO_SUBMIT.value: {
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value,
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value: {
        MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value,
        MarketplaceOrderStatus.SUBMITTING.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,  # approval rejected → re-armable
        # An operator may abandon even while a submit approval is pending (e.g. the
        # bound run is later found unfit). Without this edge a granted abandon would
        # crash the saga (advisor阻断项: SUBMIT_* → ABANDONING must be reachable).
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.SUBMITTING.value: {
        MarketplaceOrderStatus.SUBMITTING.value,
        MarketplaceOrderStatus.SUBMITTED.value,
        MarketplaceOrderStatus.SUBMIT_FAILED.value,
        # An AMBIGUOUS remote error during a submit grant goes to BLOCKED (mirror of
        # CLAIMING): the remote may have received the solution, so we must not assume
        # "not submitted" and re-submit. BLOCKED parks it for reconciliation.
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.SUBMIT_FAILED.value: {
        MarketplaceOrderStatus.SUBMIT_FAILED.value,
        # Retriable: a transient remote failure can re-arm a fresh submit approval.
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        # A submit that keeps failing must be abandonable (advisor阻断项 1): without
        # this edge ``_apply_abandon`` would hit an illegal transition and deadlock.
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
    },
    MarketplaceOrderStatus.ABANDONING.value: {
        MarketplaceOrderStatus.ABANDONING.value,
        MarketplaceOrderStatus.BLOCKED.value,
        # NOTE: ``ABANDONED`` is deliberately NOT reachable here via the generic
        # ``save_marketplace_order`` transition guard (advisor阻断项, Codex). Freeing
        # the live slot requires a PROVEN remote release, which ClawHunt does not
        # expose today. When it does, a DEDICATED proof-carrying store method (not a
        # generic save) performs abandoning → abandoned — so a reconciler / manual
        # save can never bypass the "must prove remote release" rule and free the
        # slot locally. Until then abandon settles to BLOCKED (slot retained).
    },
    # Blocked needs a human; from there an order may resume to a pre-terminal phase
    # a human chooses, or be re-attempted for abandon. It can NEVER jump straight to
    # ``abandoned`` (slot release) — that bypasses the proven-release rule (Codex).
    MarketplaceOrderStatus.BLOCKED.value: {
        MarketplaceOrderStatus.BLOCKED.value,
        MarketplaceOrderStatus.CLAIMING.value,
        MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.ABANDONING.value,
    },
}


def is_valid_marketplace_order_transition(previous: str, current: str) -> bool:
    """Fail-closed: only an explicitly-allowed saga edge may be persisted.

    An unknown ``previous`` maps to "only stay put" ({previous}), so a corrupt or
    future status can never fan out into an arbitrary transition.
    """
    return current in _ALLOWED_MARKETPLACE_ORDER_TRANSITIONS.get(previous, {previous})


PRIMARY_EVIDENCE_TEXT_LIMIT = 4000
PRIMARY_EVIDENCE_TRUNCATED_FINDING = "primary_evidence_truncated"
NON_VERIFICATION_FINDING_NAMES = {PRIMARY_EVIDENCE_TRUNCATED_FINDING}


def _primary_evidence_text(value: Any) -> str:
    text = str(value or "")
    return text


def _truncate_primary_evidence_text(value: Any, *, limit: int = PRIMARY_EVIDENCE_TEXT_LIMIT) -> str:
    text = _primary_evidence_text(value)
    if len(text) <= limit:
        return text
    return text[-limit:]


def _primary_evidence_text_length(value: Any) -> int:
    return len(_primary_evidence_text(value))


def _coerce_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _compact_evidence_identifier(value: Any, *, limit: int = 180) -> str:
    text = " ".join(str(value or "unknown").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str))


def _stable_json_key(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _dedupe_items(items: list[Any], key_fn: Any) -> list[Any]:
    seen: set[str] = set()
    deduped: list[Any] = []
    for item in items:
        key = key_fn(item)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _normalize_command_evidence_entry(command: dict[str, Any]) -> dict[str, Any]:
    output = command.get("output")
    output_length = _primary_evidence_text_length(output)
    output_truncated = bool(command.get("output_truncated")) or output_length > PRIMARY_EVIDENCE_TEXT_LIMIT
    output_original_length = _coerce_optional_int(command.get("output_original_length"))
    if output_truncated and output_original_length is None:
        output_original_length = output_length
    entry = {
        "command": command.get("command"),
        "exit_code": command.get("exit_code"),
        "output": _truncate_primary_evidence_text(output),
    }
    if output_truncated:
        entry["output_truncated"] = True
        entry["output_original_length"] = output_original_length
    return entry


def _normalize_worker_result(result: "WorkerResult") -> "WorkerResult":
    output_length = _primary_evidence_text_length(result.output)
    output_truncated = bool(result.output_truncated) or output_length > PRIMARY_EVIDENCE_TEXT_LIMIT
    output_original_length = _coerce_optional_int(result.output_original_length)
    if output_truncated and output_original_length is None:
        output_original_length = output_length
    result.output = _truncate_primary_evidence_text(result.output)
    result.output_truncated = output_truncated
    result.output_original_length = output_original_length
    result.discovered_tasks = _json_clone(result.discovered_tasks)
    return result


def _worker_result_replay_key(result: "WorkerResult") -> str:
    return _stable_json_key(
        {
            "task_id": result.task_id,
            "role": result.role,
            "backend": result.backend,
            "command": result.command,
            "attempt_index": result.attempt_index,
            "started_at": result.started_at,
            "finished_at": result.finished_at,
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "cancelled": result.cancelled,
            "forced_kill": result.forced_kill,
            "artifact_id": result.artifact_id,
            "artifact_path": result.artifact_path,
            "transcript_artifact_id": result.transcript_artifact_id,
            "transcript_path": result.transcript_path,
        }
    )


@dataclass
class GoalSpec:
    title: str
    description: str
    source: Literal["direct", "clawhunt", "a2a", "team"] = "direct"  # team = heartbeat-daemon scheduled
    goal_id: str = field(default_factory=lambda: _id("goal"))
    external_id: str | None = None
    acceptance_criteria: list[str] = field(
        default_factory=lambda: [
            "Evidence bundle includes command output",
            "Adversarial verification includes a non-happy path probe",
            "Final verdict separates control-plane readiness from E2E proof",
        ]
    )
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_clawhunt_problem(cls, payload: dict[str, Any]) -> "GoalSpec":
        title = str(payload.get("title") or f"ClawHunt problem {payload.get('id')}")
        description = str(payload.get("description") or payload.get("summary") or "")
        return cls(
            title=title,
            description=description,
            source="clawhunt",
            external_id=str(payload.get("id")),
            metadata={
                key: payload[key]
                for key in ("category", "difficulty", "bounty", "price", "url")
                if key in payload
            },
        )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source"] = str(self.source)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GoalSpec":
        return cls(**data)


class GoalStatus(str, Enum):
    """Lifecycle state of a Goal (Goal Mode / 计划模式).

    Grafts codex's goal status machine onto super, with the extra states super
    needs for plan-then-execute and fail-closed governance that codex (single
    thread, agent self-completes) does not: ``draft`` / ``awaiting_confirmation``
    (the plan + roster have been generated but no run started — the confirmation
    surface owns this), and ``cancelled``.

    ``budget_limited`` is half-terminal: a goal that exhausted its budget stops
    and can only return to ``active`` via a human budget override that bumps the
    revision — never auto-continues (铁律5 fail-closed). ``complete`` is reached
    only by the completion-gate projection (PR5), never agent self-report. The
    execution-phase statuses (active/blocked/budget_limited/complete) are a strict
    derived projection of the underlying issue tree at the layer above the ledger;
    this enum + the transition guard are the structural floor.

    ``legacy`` marks goals persisted before this ledger existed (rows backfilled
    by the schema migration); they are inert and not managed by the lifecycle so
    the historical delivery path keeps working untouched."""

    DRAFT = "draft"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    ACTIVE = "active"
    BLOCKED = "blocked"
    BUDGET_LIMITED = "budget_limited"
    COMPLETE = "complete"
    CANCELLED = "cancelled"
    LEGACY = "legacy"


TERMINAL_GOAL_STATUSES = {GoalStatus.COMPLETE.value, GoalStatus.CANCELLED.value}
GOAL_STATUSES: frozenset[str] = frozenset(s.value for s in GoalStatus)


# Fail-closed goal lifecycle graph. Self-transitions are allowed so idempotent
# saves never raise. ``awaiting_confirmation -> draft`` is the replan rollback
# (user revised the plan). ``budget_limited -> active`` is the human override
# path (the higher layer requires a revision bump). ``complete`` / ``cancelled``
# / ``legacy`` are terminal.
_ALLOWED_GOAL_STATUS_TRANSITIONS: dict[str, set[str]] = {
    GoalStatus.DRAFT.value: {
        GoalStatus.DRAFT.value,
        GoalStatus.AWAITING_CONFIRMATION.value,
        GoalStatus.CANCELLED.value,
    },
    GoalStatus.AWAITING_CONFIRMATION.value: {
        GoalStatus.AWAITING_CONFIRMATION.value,
        GoalStatus.DRAFT.value,
        GoalStatus.ACTIVE.value,
        GoalStatus.CANCELLED.value,
    },
    GoalStatus.ACTIVE.value: {
        GoalStatus.ACTIVE.value,
        GoalStatus.BLOCKED.value,
        GoalStatus.BUDGET_LIMITED.value,
        GoalStatus.COMPLETE.value,
        GoalStatus.CANCELLED.value,
    },
    GoalStatus.BLOCKED.value: {
        GoalStatus.BLOCKED.value,
        GoalStatus.ACTIVE.value,
        GoalStatus.CANCELLED.value,
    },
    GoalStatus.BUDGET_LIMITED.value: {
        GoalStatus.BUDGET_LIMITED.value,
        GoalStatus.ACTIVE.value,
        GoalStatus.CANCELLED.value,
    },
    GoalStatus.COMPLETE.value: {GoalStatus.COMPLETE.value},
    GoalStatus.CANCELLED.value: {GoalStatus.CANCELLED.value},
    GoalStatus.LEGACY.value: {GoalStatus.LEGACY.value},
}


def is_valid_goal_status_transition(previous: str, current: str) -> bool:
    # Fail closed on an unknown ``previous`` OR ``current`` — an out-of-vocabulary
    # status (e.g. a corrupted row, or a typo from a future build) must NOT be
    # allowed to self-transition and quietly persist. Only known status -> known
    # status edges in the graph are legal.
    if previous not in _ALLOWED_GOAL_STATUS_TRANSITIONS or current not in GOAL_STATUSES:
        return False
    return current in _ALLOWED_GOAL_STATUS_TRANSITIONS[previous]


@dataclass
class GoalRecord:
    """Durable lifecycle ledger wrapping a :class:`GoalSpec` (Goal Mode).

    The ``goals`` table previously stored only the inert ``GoalSpec`` JSON blob;
    ``GoalRecord`` adds the spine codex's goal framework has but super lacked — a
    status machine, a ``revision`` optimistic-concurrency token, the materialized
    ``plan`` / ``roster`` / ``budget_policy``, a ``usage_rollup`` aggregated across
    the goal's runs, and the ``completion_gate`` projection. A ``GoalRecord`` is
    1:N over :class:`RunSession`: a run is an execution attempt, not the goal.

    ``plan_hash`` / ``roster_hash`` / ``confirmation_nonce`` / ``worktree_digest``
    back the confirm-time idempotency + TOCTOU guard (a stale confirmation after a
    plan/roster/worktree change is rejected). These are filled by later phases
    (planner / roster allocator); PR1 only persists and round-trips them."""

    spec: GoalSpec
    status: str = GoalStatus.DRAFT.value
    revision: int = 0
    plan: dict[str, Any] | None = None
    roster: dict[str, Any] | None = None
    budget_policy: dict[str, Any] | None = None
    usage_rollup: dict[str, Any] = field(default_factory=dict)
    completion_gate: dict[str, Any] | None = None
    plan_hash: str | None = None
    roster_hash: str | None = None
    confirmation_nonce: str | None = None
    worktree_digest: str | None = None
    # The goal's DESIGNATED current run — stamped by start_confirmed_goal_run with the
    # run it created. The completion-gate projection derives the goal's status from
    # THIS run (a stable handle), never "the newest row" (runs are INSERT OR REPLACE,
    # so rowid order is not attempt order). The completion gate also requires the
    # completing run_id to equal this, so an old/foreign run cannot close the goal.
    last_run_id: str | None = None
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)

    @property
    def goal_id(self) -> str:
        return self.spec.goal_id

    @classmethod
    def new(cls, spec: GoalSpec, *, status: str = GoalStatus.DRAFT.value) -> "GoalRecord":
        return cls(spec=spec, status=status)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec": self.spec.to_dict(),
            "status": self.status,
            "revision": self.revision,
            "plan": self.plan,
            "roster": self.roster,
            "budget_policy": self.budget_policy,
            "usage_rollup": self.usage_rollup,
            "completion_gate": self.completion_gate,
            "plan_hash": self.plan_hash,
            "roster_hash": self.roster_hash,
            "confirmation_nonce": self.confirmation_nonce,
            "worktree_digest": self.worktree_digest,
            "last_run_id": self.last_run_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GoalRecord":
        return cls(
            spec=GoalSpec.from_dict(data["spec"]),
            status=str(data.get("status", GoalStatus.DRAFT.value)),
            revision=int(data.get("revision", 0)),
            plan=data.get("plan"),
            roster=data.get("roster"),
            budget_policy=data.get("budget_policy"),
            usage_rollup=dict(data.get("usage_rollup") or {}),
            completion_gate=data.get("completion_gate"),
            plan_hash=data.get("plan_hash"),
            roster_hash=data.get("roster_hash"),
            confirmation_nonce=data.get("confirmation_nonce"),
            worktree_digest=data.get("worktree_digest"),
            last_run_id=data.get("last_run_id"),
            created_at=float(data.get("created_at", time())),
            updated_at=float(data.get("updated_at", data.get("created_at", time()))),
        )


@dataclass
class TaskNode:
    task_id: str
    role: WorkerRole
    title: str
    depends_on: list[str] = field(default_factory=list)
    status: str = "pending"
    # When set, this node expands into a parallel subagent group at execution
    # time (keys: branches, aggregation, quorum, role, max_concurrency, dry_run).
    fanout: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["role"] = self.role.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskNode":
        return cls(role=WorkerRole(data["role"]), **{k: v for k, v in data.items() if k != "role"})


@dataclass
class TaskGraph:
    goal_id: str
    tasks: list[TaskNode]

    def validate(self) -> None:
        task_ids = {task.task_id for task in self.tasks}
        for task in self.tasks:
            for dependency in task.depends_on:
                if dependency not in task_ids:
                    raise ValueError(f"task {task.task_id} depends on unknown task {dependency}")
        visiting: set[str] = set()
        visited: set[str] = set()
        task_map = {task.task_id: task for task in self.tasks}

        def visit(task_id: str) -> None:
            if task_id in visited:
                return
            if task_id in visiting:
                raise ValueError(f"task graph contains a dependency cycle at {task_id}")
            visiting.add(task_id)
            for dependency in task_map[task_id].depends_on:
                visit(dependency)
            visiting.remove(task_id)
            visited.add(task_id)

        for task in self.tasks:
            visit(task.task_id)

    @classmethod
    def from_goal(
        cls,
        goal: GoalSpec,
        roles: list[WorkerRole] | None = None,
        topology: TaskTopology = TaskTopology.LINEAR,
    ) -> "TaskGraph":
        if topology == TaskTopology.IMPLEMENT_FANOUT:
            explore = TaskNode(task_id=_id("task"), role=WorkerRole.EXPLORE, title=f"{WorkerRole.EXPLORE.value}: {goal.title}")
            plan = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.PLAN,
                title=f"{WorkerRole.PLAN.value}: {goal.title}",
                depends_on=[explore.task_id],
            )
            implement_primary = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.IMPLEMENT,
                title=f"{WorkerRole.IMPLEMENT.value}-primary: {goal.title}",
                depends_on=[plan.task_id],
            )
            implement_hardening = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.IMPLEMENT,
                title=f"{WorkerRole.IMPLEMENT.value}-hardening: {goal.title}",
                depends_on=[plan.task_id],
            )
            verify = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.VERIFY,
                title=f"{WorkerRole.VERIFY.value}: {goal.title}",
                depends_on=[implement_primary.task_id, implement_hardening.task_id],
            )
            review = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.REVIEW,
                title=f"{WorkerRole.REVIEW.value}: {goal.title}",
                depends_on=[verify.task_id],
            )
            graph = cls(
                goal_id=goal.goal_id,
                tasks=[explore, plan, implement_primary, implement_hardening, verify, review],
            )
            graph.validate()
            return graph
        if topology == TaskTopology.EXPLORE_FANOUT:
            explore = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.EXPLORE,
                title=f"{WorkerRole.EXPLORE.value}-fanout: {goal.title}",
                fanout={"branches": 2, "aggregation": "all_succeed", "role": "explore"},
            )
            implement = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.IMPLEMENT,
                title=f"{WorkerRole.IMPLEMENT.value}: {goal.title}",
                depends_on=[explore.task_id],
            )
            verify = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.VERIFY,
                title=f"{WorkerRole.VERIFY.value}: {goal.title}",
                depends_on=[implement.task_id],
            )
            graph = cls(goal_id=goal.goal_id, tasks=[explore, implement, verify])
            graph.validate()
            return graph
        if topology == TaskTopology.REVIEW_CONSENSUS:
            implement = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.IMPLEMENT,
                title=f"{WorkerRole.IMPLEMENT.value}: {goal.title}",
            )
            review = TaskNode(
                task_id=_id("task"),
                role=WorkerRole.REVIEW,
                title=f"{WorkerRole.REVIEW.value}-consensus: {goal.title}",
                depends_on=[implement.task_id],
                fanout={"branches": 3, "aggregation": "consensus", "role": "review"},
            )
            graph = cls(goal_id=goal.goal_id, tasks=[implement, review])
            graph.validate()
            return graph
        selected_roles = roles or [
            WorkerRole.EXPLORE,
            WorkerRole.PLAN,
            WorkerRole.IMPLEMENT,
            WorkerRole.VERIFY,
            WorkerRole.REVIEW,
        ]
        tasks: list[TaskNode] = []
        previous: str | None = None
        for role in selected_roles:
            task = TaskNode(
                task_id=_id("task"),
                role=role,
                title=f"{role.value}: {goal.title}",
                depends_on=[previous] if previous else [],
            )
            tasks.append(task)
            previous = task.task_id
        graph = cls(goal_id=goal.goal_id, tasks=tasks)
        graph.validate()
        return graph

    def to_dict(self) -> dict[str, Any]:
        return {"goal_id": self.goal_id, "tasks": [task.to_dict() for task in self.tasks]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskGraph":
        graph = cls(goal_id=data["goal_id"], tasks=[TaskNode.from_dict(item) for item in data["tasks"]])
        graph.validate()
        return graph


@dataclass
class RunSession:
    goal_id: str
    run_id: str = field(default_factory=lambda: _id("run"))
    status: str = RunStatus.CREATED.value
    dry_run: bool = False
    task_graph: TaskGraph | None = None
    chat_session_id: str | None = None
    execution_context: dict[str, Any] = field(default_factory=dict)
    task_attempts: dict[str, int] = field(default_factory=dict)
    parent_run_id: str | None = None
    parent_task_id: str | None = None
    depth: int = 0
    child_executions: list["ChildExecution"] = field(default_factory=list)
    active_mutation_lease: "RunMutationLease | None" = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["task_graph"] = self.task_graph.to_dict() if self.task_graph else None
        data["child_executions"] = [child.to_dict() for child in self.child_executions]
        data["active_mutation_lease"] = self.active_mutation_lease.to_dict() if self.active_mutation_lease else None
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunSession":
        graph = data.get("task_graph")
        data = dict(data)
        data["task_graph"] = TaskGraph.from_dict(graph) if graph else None
        data["child_executions"] = [ChildExecution.from_dict(item) for item in data.get("child_executions", [])]
        lease = data.get("active_mutation_lease")
        data["active_mutation_lease"] = RunMutationLease.from_dict(lease) if lease else None
        # Drop unknown/retired keys so a payload written by an older schema (or a
        # past bug — e.g. a stray ``failure_reason``) deserializes instead of
        # raising TypeError and taking down the whole request (a chat turn that
        # links such a run would otherwise 500). Forward-compatible by design.
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in data.items() if k in known}
        return cls(**data)


@dataclass
class WorkerLease:
    resource: str
    owner: str
    lease_id: str = field(default_factory=lambda: _id("lease"))


@dataclass
class RunMutationLease:
    resource: str
    owner: str
    mode: RunMutationMode
    lease_id: str = field(default_factory=lambda: _id("runlease"))
    acquired_at: float = field(default_factory=time)
    # Owner heartbeat: bumped by renew_run_mutation_lease while the executor is
    # alive. Liveness checks judge freshness by this, falling back to acquired_at
    # for leases written before renewal existed.
    last_renewed_at: float | None = None
    worker_pid: int | None = None
    worker_host: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["mode"] = self.mode.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunMutationLease":
        return cls(
            resource=str(data["resource"]),
            owner=str(data["owner"]),
            mode=RunMutationMode(str(data["mode"])),
            lease_id=str(data.get("lease_id") or _id("runlease")),
            acquired_at=float(data.get("acquired_at") or time()),
            last_renewed_at=float(data["last_renewed_at"]) if data.get("last_renewed_at") is not None else None,
            worker_pid=int(data["worker_pid"]) if data.get("worker_pid") is not None else None,
            worker_host=str(data["worker_host"]) if data.get("worker_host") is not None else None,
        )


@dataclass
class ArtifactRef:
    kind: str
    path: str
    sensitivity: Literal["public", "internal", "sensitive"] = "internal"
    artifact_id: str = field(default_factory=lambda: _id("artifact"))
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class VerificationFinding:
    name: str
    passed: bool
    detail: str
    severity: Literal["info", "warning", "high", "critical"] = "info"
    input_fields: list[str] = field(default_factory=list)
    fail_mode: Literal["fail_open", "fail_closed"] = "fail_closed"
    remediation: str = ""


@dataclass
class WorkerResult:
    task_id: str
    role: str
    backend: str
    command: str
    exit_code: int
    output: str
    duration_seconds: float
    attempt_index: int = 1
    started_at: float | None = None
    finished_at: float | None = None
    timed_out: bool = False
    cancelled: bool = False
    forced_kill: bool = False
    artifact_id: str | None = None
    artifact_path: str | None = None
    transcript_artifact_id: str | None = None
    transcript_path: str | None = None
    output_truncated: bool = False
    output_original_length: int | None = None
    # Split streams (populated by run_command, or their synthetic equivalent in
    # _synthetic_result). ``None`` means "not populated" (legacy/direct
    # constructions) and consumers must fall back to the merged ``output``.
    # An EMPTY STRING means "populated and genuinely empty": chat surfaces must
    # NOT fall back to the merged stream then — a CLI that wrote only stderr
    # did not answer, and stderr is where log noise (ANSI-colored tracing
    # lines, MCP warnings) lives. Both are redacted and tail-capped like
    # ``output``; full streams stay in the transcript artifact.
    stdout: str | None = None
    stderr: str | None = None
    # Cost snapshot (serialized CostSnapshot dict) — the measurable consumption
    # of this worker turn, kept on the result for evidence read-back. The
    # durable cost ledger is StateStore.cost_events; this is the local fact.
    cost: dict[str, Any] | None = None
    # Subtasks discovered during execution; merged into the live graph mid-run.
    discovered_tasks: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ChildExecution:
    child_task_id: str
    child_run_id: str
    parent_run_id: str
    parent_task_id: str
    backend: str
    status: str
    depth: int = 1
    cancellation_mode: Literal["linked"] = "linked"
    timeout_seconds: int | None = None
    evidence_owner: Literal["child", "parent_aggregate"] = "child"
    chain_verdict: str | None = None
    evidence_artifact_id: str | None = None
    evidence_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChildExecution":
        return cls(**data)


@dataclass
class ChatMessage:
    role: Literal["user", "assistant", "system"]
    content: str
    run_id: str | None = None
    created_at: float = field(default_factory=time)
    context_refs: list[dict[str, Any]] = field(default_factory=list)
    # Outcome of the turn this message records. None for ordinary content;
    # "failed" for an assistant turn that errored (auth/timeout/runtime) so the
    # surface renders it as a failure AND a reload from the store still shows
    # WHY it failed instead of a silent blank. Failed assistant rows are also
    # excluded from native-runtime catch-up (they are not real conversation).
    status: str | None = None
    # Stable identity for cross-runtime context sync (native-session catch-up
    # tracks the last message each runtime has SEEN by id, never by index —
    # indexes drift under edits/inserts). Pre-existing rows deserialize without
    # one and get a fresh id per load; consumers must treat an unknown
    # last-seen id as "nothing seen" and fall back to a full sync.
    message_id: str = field(default_factory=lambda: _id("msg"))
    # Per-turn metering for the chat surface, display-only but KERNEL-owned so it
    # survives a reload and stays identical across CLI/API/Web (no surface derives
    # its own). ``usage`` is the runtime's token tally for THIS assistant turn
    # (input/output/cache_read/cache_creation, runtime-native keys kept as-is);
    # ``elapsed_ms`` is the wall-clock time the turn took. Both stay None for
    # user/system rows and for legacy rows persisted before these fields existed
    # — from_dict's ``**item`` simply leaves the defaults (back-compat).
    usage: dict[str, int] | None = None
    elapsed_ms: float | None = None


@dataclass
class ChatSession:
    title: str
    session_id: str = field(default_factory=lambda: _id("session"))
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
    messages: list[ChatMessage] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    # Workspace membership (ADR: workspace-trust-container). Every new session
    # belongs to exactly one workspace; legacy sessions stay None until adopted.
    workspace_id: str | None = None
    # Sidebar lifecycle (roadmap: workspace-sidebar-rework §5 PR-A). Archived
    # sessions are hidden from the default sidebar list but never deleted; the
    # list filters ``archived=false`` by default.
    archived: bool = False
    # Sidebar pin (cross-surface). When set, the session floats to the top
    # "Pinned" zone of every surface's sidebar; ``None`` means not pinned. The
    # timestamp is the pin moment, used purely to order pinned items (most
    # recently pinned first). Pinning is a NAVIGATION preference — it never
    # changes the session's workspace membership or execution boundary; unpinning
    # returns it to its original group untouched.
    pinned_at: float | None = None

    def append(self, message: ChatMessage) -> None:
        self.messages.append(message)
        self.updated_at = time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "messages": [asdict(message) for message in self.messages],
            "metadata": self.metadata,
            "workspace_id": self.workspace_id,
            "archived": self.archived,
            "pinned_at": self.pinned_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChatSession":
        pinned_raw = data.get("pinned_at")
        return cls(
            session_id=data["session_id"],
            title=data["title"],
            created_at=float(data.get("created_at", time())),
            updated_at=float(data.get("updated_at", data.get("created_at", time()))),
            messages=[ChatMessage(**{**item, "context_refs": list(item.get("context_refs", []))}) for item in data.get("messages", [])],
            metadata=dict(data.get("metadata", {})),
            workspace_id=data.get("workspace_id"),
            archived=bool(data.get("archived", False)),
            # Legacy rows predate pinning → None (not pinned); tolerate a stray
            # non-numeric value by treating it as unpinned rather than crashing.
            pinned_at=float(pinned_raw) if isinstance(pinned_raw, (int, float)) else None,
        )


@dataclass
class EvidenceBundle:
    run_id: str
    probes: list[dict[str, Any]] = field(default_factory=list)
    commands: list[dict[str, Any]] = field(default_factory=list)
    worker_results: list[WorkerResult] = field(default_factory=list)
    artifacts: list[ArtifactRef] = field(default_factory=list)
    child_executions: list[ChildExecution] = field(default_factory=list)
    findings: list[VerificationFinding] = field(default_factory=list)
    submitted_to_clawhunt: bool = False
    submission_response: dict[str, Any] | None = None
    backend_summary: dict[str, Any] = field(default_factory=dict)

    def _record_primary_evidence_truncation(
        self,
        source: Literal["command", "worker_result"],
        identifier: Any,
        original_length: int | None,
        *,
        field_name: str,
    ) -> None:
        label = _compact_evidence_identifier(identifier)
        if original_length and original_length > PRIMARY_EVIDENCE_TEXT_LIMIT:
            length_detail = (
                f"{original_length} chars exceeded primary evidence limit "
                f"{PRIMARY_EVIDENCE_TEXT_LIMIT}"
            )
        else:
            length_detail = (
                f"output was already marked truncated before capture; "
                f"primary evidence limit is {PRIMARY_EVIDENCE_TEXT_LIMIT} chars"
            )
        self.add_finding(
            PRIMARY_EVIDENCE_TRUNCATED_FINDING,
            True,
            (
                f"{source} output truncated for {label}: {length_detail}; "
                f"stored the last {PRIMARY_EVIDENCE_TEXT_LIMIT} chars only."
            ),
            "warning",
            input_fields=[field_name],
            fail_mode="fail_open",
            remediation="Inspect or attach the full-output artifact when omitted leading context matters.",
        )

    def _remove_primary_evidence_truncation_findings_for_field(self, field_name: str) -> None:
        self.findings = [
            finding
            for finding in self.findings
            if not (
                finding.name == PRIMARY_EVIDENCE_TRUNCATED_FINDING
                and field_name in finding.input_fields
            )
        ]

    def _record_command_truncation_findings(self) -> None:
        self._remove_primary_evidence_truncation_findings_for_field("commands[].output")
        for command in self.commands:
            if not command.get("output_truncated"):
                continue
            self._record_primary_evidence_truncation(
                "command",
                command.get("command"),
                _coerce_optional_int(command.get("output_original_length")),
                field_name="commands[].output",
            )

    def _worker_result_truncation_identifier(self, result: WorkerResult) -> str:
        return (
            f"task={result.task_id} role={result.role} backend={result.backend} "
            f"attempt={result.attempt_index} command={result.command}"
        )

    def _record_worker_result_truncation_findings(self) -> None:
        self._remove_primary_evidence_truncation_findings_for_field("worker_results[].output")
        for result in self.worker_results:
            if not result.output_truncated:
                continue
            self._record_primary_evidence_truncation(
                "worker_result",
                self._worker_result_truncation_identifier(result),
                result.output_original_length,
                field_name="worker_results[].output",
            )

    def add_probe(self, name: str, status_code: int, body: Any) -> None:
        probe = {"name": name, "status_code": status_code, "body": _json_clone(body)}
        key = _stable_json_key(probe)
        if not any(_stable_json_key(existing) == key for existing in self.probes):
            self.probes.append(probe)

    def add_command(self, command: str, exit_code: int, output: str) -> None:
        entry = _normalize_command_evidence_entry({"command": command, "exit_code": exit_code, "output": output})
        key = _stable_json_key(entry)
        if not any(_stable_json_key(existing) == key for existing in self.commands):
            self.commands.append(entry)
        self._record_command_truncation_findings()

    def add_artifact(self, artifact: ArtifactRef) -> None:
        key = artifact.artifact_id or _stable_json_key(asdict(artifact))
        if not any((existing.artifact_id or _stable_json_key(asdict(existing))) == key for existing in self.artifacts):
            self.artifacts.append(artifact)

    def add_worker_result(self, result: WorkerResult) -> None:
        result = _normalize_worker_result(result)
        key = _worker_result_replay_key(result)
        for index, existing in enumerate(self.worker_results):
            if _worker_result_replay_key(existing) == key:
                self.worker_results[index] = result
                self._record_worker_result_truncation_findings()
                return
        self.worker_results.append(result)
        self._record_worker_result_truncation_findings()

    def add_child_execution(self, execution: ChildExecution) -> None:
        for index, existing in enumerate(self.child_executions):
            if existing.child_task_id == execution.child_task_id:
                self.child_executions[index] = execution
                return
        self.child_executions.append(execution)

    def set_backend_summary(self, summary: dict[str, Any]) -> None:
        self.backend_summary = _json_clone(summary)

    def add_finding(
        self,
        name: str,
        passed: bool,
        detail: str,
        severity: Literal["info", "warning", "high", "critical"] = "info",
        *,
        input_fields: list[str] | None = None,
        fail_mode: Literal["fail_open", "fail_closed"] = "fail_closed",
        remediation: str = "",
    ) -> None:
        finding = VerificationFinding(
            name=name,
            passed=passed,
            detail=detail,
            severity=severity,
            input_fields=list(input_fields or []),
            fail_mode=fail_mode,
            remediation=remediation,
        )
        key = _stable_json_key(asdict(finding))
        if not any(_stable_json_key(asdict(existing)) == key for existing in self.findings):
            self.findings.append(finding)

    def mark_submitted(self, response: dict[str, Any] | None = None) -> None:
        self.submitted_to_clawhunt = True
        self.submission_response = _json_clone(response or {})

    def normalize(self) -> "EvidenceBundle":
        self.probes = _dedupe_items(
            [
                {
                    "name": probe.get("name"),
                    "status_code": probe.get("status_code"),
                    "body": _json_clone(probe.get("body")),
                }
                for probe in self.probes
            ],
            _stable_json_key,
        )
        self.commands = _dedupe_items(
            [_normalize_command_evidence_entry(command) for command in self.commands],
            _stable_json_key,
        )
        self._record_command_truncation_findings()
        deduped_worker_results: list[WorkerResult] = []
        for result in self.worker_results:
            result = _normalize_worker_result(result)
            key = _worker_result_replay_key(result)
            for index, existing in enumerate(deduped_worker_results):
                if _worker_result_replay_key(existing) == key:
                    deduped_worker_results[index] = result
                    break
            else:
                deduped_worker_results.append(result)
        self.worker_results = deduped_worker_results
        self._record_worker_result_truncation_findings()
        self.artifacts = _dedupe_items(
            self.artifacts,
            lambda artifact: artifact.artifact_id or _stable_json_key(asdict(artifact)),
        )
        deduped_children: list[ChildExecution] = []
        for execution in self.child_executions:
            for index, existing in enumerate(deduped_children):
                if existing.child_task_id == execution.child_task_id:
                    deduped_children[index] = execution
                    break
            else:
                deduped_children.append(execution)
        self.child_executions = deduped_children
        self.findings = _dedupe_items(
            self.findings,
            lambda finding: _stable_json_key(asdict(finding)),
        )
        self.backend_summary = _json_clone(self.backend_summary)
        if self.submission_response is not None:
            self.submission_response = _json_clone(self.submission_response)
        return self

    @property
    def chain_verdict(self) -> ChainVerdict:
        if any(not finding.passed for finding in self.findings):
            return ChainVerdict.FAIL
        has_successful_worker = any(result.exit_code == 0 for result in self.worker_results)
        has_command_evidence = any(command.get("exit_code") == 0 for command in self.commands)
        verification_findings = [
            finding for finding in self.findings if finding.name not in NON_VERIFICATION_FINDING_NAMES
        ]
        has_passing_findings = bool(verification_findings) and all(
            finding.passed for finding in verification_findings
        )
        if (
            self.probes
            and has_successful_worker
            and self.artifacts
            and has_passing_findings
            and self.submitted_to_clawhunt
            and self.submission_response is not None
        ):
            return ChainVerdict.E2E_PROVEN
        if self.probes and (has_command_evidence or self.worker_results):
            return ChainVerdict.CHAIN_PARTIAL
        return ChainVerdict.CONTROL_PLANE_READY

    def to_dict(self) -> dict[str, Any]:
        self.normalize()
        return {
            "run_id": self.run_id,
            "probes": self.probes,
            "commands": self.commands,
            "worker_results": [asdict(result) for result in self.worker_results],
            "artifacts": [asdict(artifact) for artifact in self.artifacts],
            "child_executions": [child.to_dict() for child in self.child_executions],
            "findings": [asdict(finding) for finding in self.findings],
            "submitted_to_clawhunt": self.submitted_to_clawhunt,
            "submission_response": self.submission_response,
            "backend_summary": self.backend_summary,
            "chain_verdict": self.chain_verdict.value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceBundle":
        bundle = cls(
            run_id=data["run_id"],
            probes=list(data.get("probes", [])),
            commands=list(data.get("commands", [])),
            worker_results=[WorkerResult(**item) for item in data.get("worker_results", [])],
            artifacts=[ArtifactRef(**item) for item in data.get("artifacts", [])],
            child_executions=[ChildExecution.from_dict(item) for item in data.get("child_executions", [])],
            findings=[VerificationFinding(**item) for item in data.get("findings", [])],
            submitted_to_clawhunt=bool(data.get("submitted_to_clawhunt", False)),
            submission_response=data.get("submission_response"),
            backend_summary=dict(data.get("backend_summary", {})),
        )
        return bundle.normalize()


# --- Agent Team Kernel (Phase 1) ------------------------------------------
#
# The team kernel layers an organization on top of the single-run harness:
# persistent agent profiles (roles + equipment), issues (the unit of delegated
# work, single-assignee with atomic checkout locks), and approvals (the human
# gate that must clear before work ships). These live in the CLI kernel so every
# surface (API / Web / Desktop) reads one source of truth, never its own copy.


class IssueStatus(str, Enum):
    BACKLOG = "backlog"
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELLED = "cancelled"


TERMINAL_ISSUE_STATUSES = {IssueStatus.DONE.value, IssueStatus.CANCELLED.value}


# Fail-closed: an issue can only reach ``done`` from ``in_review``. There is no
# in_progress -> done shortcut, so completion always passes through the approval
# gate. Self-transitions are allowed so idempotent saves never raise.
_ALLOWED_ISSUE_STATUS_TRANSITIONS: dict[str, set[str]] = {
    IssueStatus.BACKLOG.value: {
        IssueStatus.BACKLOG.value,
        IssueStatus.TODO.value,
        IssueStatus.CANCELLED.value,
    },
    IssueStatus.TODO.value: {
        IssueStatus.TODO.value,
        IssueStatus.BACKLOG.value,
        IssueStatus.IN_PROGRESS.value,
        IssueStatus.BLOCKED.value,
        IssueStatus.CANCELLED.value,
    },
    IssueStatus.IN_PROGRESS.value: {
        IssueStatus.IN_PROGRESS.value,
        IssueStatus.IN_REVIEW.value,
        IssueStatus.BLOCKED.value,
        IssueStatus.CANCELLED.value,
        # Abort-checkout: a claim whose run never established may be returned
        # to the queue (team_kernel.abort_checkout) — the lock releases and the
        # issue becomes claimable again instead of stranding in_progress.
        IssueStatus.TODO.value,
    },
    IssueStatus.IN_REVIEW.value: {
        IssueStatus.IN_REVIEW.value,
        IssueStatus.IN_PROGRESS.value,
        IssueStatus.DONE.value,
        IssueStatus.CANCELLED.value,
    },
    IssueStatus.BLOCKED.value: {
        IssueStatus.BLOCKED.value,
        IssueStatus.TODO.value,
        IssueStatus.IN_PROGRESS.value,
        IssueStatus.CANCELLED.value,
    },
    IssueStatus.DONE.value: {IssueStatus.DONE.value},
    IssueStatus.CANCELLED.value: {IssueStatus.CANCELLED.value},
}


def is_valid_issue_status_transition(previous: str, current: str) -> bool:
    return current in _ALLOWED_ISSUE_STATUS_TRANSITIONS.get(previous, {previous})


class IssueKind(str, Enum):
    """Business kind of an issue (Paperclip typed-issue), distinct from
    ``Issue.origin_kind`` (audit-only provenance: who/what created it). ``kind``
    drives differentiated governance — e.g. a ``delegation`` sub-issue is closed by
    its delegating parent / QA, not a human final approval, while a root
    ``delivery`` issue keeps the human gate."""

    DELIVERY = "delivery"
    DELEGATION = "delegation"
    REVIEW = "review"
    BUG = "bug"


class ReviewPolicy(str, Enum):
    """Who may move an issue ``in_review -> done`` (the completion gate). The kernel
    keeps the single in_review->done transition; this declares whose acceptance
    closes it. Fail-safe default ``human_final`` so existing issues keep today's
    human approval behaviour; ``no_completion_gate`` is the only value that lets the
    kernel flip to done without an approval, reserved for machine-flow sub-work."""

    HUMAN_FINAL = "human_final"
    PARENT_ACCEPT = "parent_accept"
    QA_ACCEPT = "qa_accept"
    NO_COMPLETION_GATE = "no_completion_gate"


class DeciderType(str, Enum):
    """Capacity in which an approval was decided. ``human`` is the universal gate
    (a person can always close); ``agent`` is an autonomous decision the kernel
    only honours when the issue's ``review_policy`` and live run context authorize
    it (see ``decide_approval``). Defaults to ``human`` everywhere for compat."""

    HUMAN = "human"
    AGENT = "agent"


# Single source of valid typed-issue values — the kernel's save gate and every
# surface (CLI/API) validate against these, never a hand-copied list.
ISSUE_KINDS: frozenset[str] = frozenset(k.value for k in IssueKind)
REVIEW_POLICIES: frozenset[str] = frozenset(p.value for p in ReviewPolicy)
DECIDER_TYPES: frozenset[str] = frozenset(d.value for d in DeciderType)

# Review policies that close an issue WITHOUT a human (the "对内闭环" set): a
# parent agent accepts, or the kernel auto-completes machine sub-work. Both are
# only coherent for delegated SUB-work, so an issue carrying one MUST have a
# parent. This is the fail-closed guard against the most dangerous bypass — a
# top-level / root-delivery issue configured to skip the human gate (created via
# CLI/API where review_policy is caller-supplied).
_PARENT_SCOPED_REVIEW_POLICIES: frozenset[str] = frozenset(
    {ReviewPolicy.PARENT_ACCEPT.value, ReviewPolicy.NO_COMPLETION_GATE.value}
)


def assert_valid_issue_typed_fields(issue: "Issue") -> None:
    """Fail-closed gate for an Issue's typed business fields (``kind`` /
    ``review_policy``).

    This is the single validation rule shared by two enforcement points:
    ``Issue.__post_init__`` (every construction — fresh, ``from_dict``, delegated
    child, bootstrap seed) and the persistence layer (``StateStore`` calls this
    before serialising any issue payload). Construction validation alone cannot
    catch a field mutated AFTER construction (``issue.kind = "x"; store...()``),
    so any code path that writes ``issues.payload`` must route through this gate.
    """
    if issue.kind not in ISSUE_KINDS:
        raise ValueError(f"invalid issue kind: {issue.kind!r} (one of {sorted(ISSUE_KINDS)})")
    if issue.review_policy not in REVIEW_POLICIES:
        raise ValueError(
            f"invalid review_policy: {issue.review_policy!r} (one of {sorted(REVIEW_POLICIES)})"
        )
    # Cross-field fail-closed guard: a human-less completion policy (parent_accept /
    # no_completion_gate) is only valid for delegated sub-work, so it requires a
    # parent. Without this, a root / top-level issue (e.g. created via CLI/API with
    # review_policy supplied by the caller) could be configured to bypass the human
    # gate that the execution plan reserves for root delivery. human_final / qa_accept
    # remain human-gated and so are allowed with or without a parent.
    if issue.review_policy in _PARENT_SCOPED_REVIEW_POLICIES and not issue.parent_id:
        raise ValueError(
            f"review_policy {issue.review_policy!r} requires a parent issue "
            "(it closes without a human and is only valid for delegated sub-work)"
        )


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    REVISION_REQUESTED = "revision_requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


TERMINAL_APPROVAL_STATUSES = {
    ApprovalStatus.APPROVED.value,
    ApprovalStatus.REJECTED.value,
    ApprovalStatus.CANCELLED.value,
}


_ALLOWED_APPROVAL_STATUS_TRANSITIONS: dict[str, set[str]] = {
    ApprovalStatus.PENDING.value: {
        ApprovalStatus.PENDING.value,
        ApprovalStatus.APPROVED.value,
        ApprovalStatus.REJECTED.value,
        ApprovalStatus.REVISION_REQUESTED.value,
        ApprovalStatus.CANCELLED.value,
    },
    ApprovalStatus.REVISION_REQUESTED.value: {
        ApprovalStatus.REVISION_REQUESTED.value,
        ApprovalStatus.PENDING.value,
        ApprovalStatus.APPROVED.value,
        ApprovalStatus.REJECTED.value,
        ApprovalStatus.CANCELLED.value,
    },
    ApprovalStatus.APPROVED.value: {ApprovalStatus.APPROVED.value},
    ApprovalStatus.REJECTED.value: {ApprovalStatus.REJECTED.value},
    ApprovalStatus.CANCELLED.value: {ApprovalStatus.CANCELLED.value},
}


def is_valid_approval_status_transition(previous: str, current: str) -> bool:
    return current in _ALLOWED_APPROVAL_STATUS_TRANSITIONS.get(previous, {previous})


class ApprovalType(str, Enum):
    ISSUE_COMPLETION = "issue_completion"
    PERMISSION_GRANT = "permission_grant"
    BUDGET_OVERRIDE = "budget_override"
    # An agent requested an organizational change (reconfigure a role, or hire a
    # new one). Always human-gated: the kernel records the request as a pending
    # approval and applies it only when a human grants it.
    AGENT_CONFIG_CHANGE = "agent_config_change"
    AGENT_HIRE = "agent_hire"
    # A chat-driven, high-risk company-management command (create/update/archive a
    # company, hire/update an agent, …) paused for human review. Rides the SAME
    # approval state machine + decide_approval gate as the agent-org types above;
    # its resume_action carries the serialized command + actor scope so a grant
    # re-checks scope/lifecycle and dispatches it (see company_handler). Added for
    # the chat-driven company-management design (docs/company-chat-management-design.md).
    COMPANY_COMMAND = "company_command"
    # A chat/CLI/API-driven, high-risk ClawHunt marketplace command (post / bid /
    # claim / submit / abandon / accept) paused for human approval. Rides the SAME
    # approval state machine + decide_approval gate; its resume_action carries the
    # serialized command + actor scope so a grant re-checks scope and dispatches it
    # through marketplace_handler. EVERY marketplace write is HIGH (external network
    # egress + commitment + money never run on the default path). Added for the
    # marketplace-as-company design (docs/company-marketplace-chat-design.md).
    MARKETPLACE_COMMAND = "marketplace_command"


class ContextMode(str, Enum):
    THIN = "thin"
    FAT = "fat"


@dataclass
class AgentProfile:
    """A persistent role in an Agent Team — an "employee" with equipment.

    ``plugin_allowlist`` names the plugins this role is *allowed* to carry. It
    can only ever narrow the governed runtime projection
    (installed ∩ valid ∩ not-revoked ∩ entitled ∩ policy-allowed); it never
    grants a plugin the projection would withhold. An empty allowlist means no
    equipment (fail-closed default).
    """

    name: str
    role: str
    profile_id: str = field(default_factory=lambda: _id("agent"))
    title: str | None = None
    workspace_id: str = "local"
    company_profile_id: str = "local"
    owner_id: str = "local_user"
    backend_policy: str = "claude"
    # Preferred model for this role's runs. Empty = the backend's default. The
    # value rides the same governed channel as chat model selection
    # (WorkerLimits.model_override): backends that cannot honour an override
    # fail closed instead of silently substituting another model.
    model: str = ""
    # Preferred reasoning-effort / thinking level for this role's runs. Empty =
    # the backend's own default. Rides the same governed channel as chat effort
    # selection (WorkerLimits.effort_override): a backend that cannot honour an
    # explicit effort fails closed rather than silently ignoring it, and an
    # effort-capable backend validates the level against its own native enum.
    effort: str = ""
    plugin_allowlist: list[str] = field(default_factory=list)
    # Governed skills this role may carry. Same narrowing rule as plugins — a
    # skill is the projection of a governed plugin, so the allowlist can only
    # narrow what the runtime projection already permits, never widen it.
    skill_allowlist: list[str] = field(default_factory=list)
    permission_policy: dict[str, Any] = field(default_factory=dict)
    budget_seconds: int = 0
    workspace_policy: dict[str, Any] = field(default_factory=dict)
    context_mode: str = ContextMode.THIN.value
    reports_to: str | None = None
    # Mirrors Paperclip ``agents.runtime_config``. The daemon (phase 2) reads
    # runtime_config["heartbeat"] = {enabled, interval_sec, wake_on_demand,
    # max_concurrent_runs}; an absent key means the role is not heartbeat-driven.
    runtime_config: dict[str, Any] = field(default_factory=dict)
    # --- behavioral charter (gap C): what makes the role actually function ---
    # ``charter`` is the role's behavior contract (e.g. an agentcompanies/v1
    # AGENTS.md body). It is a first-class field — not metadata — so it can be
    # read, diffed, injected into the run prompt, and audited.
    persona: str = ""
    charter: str = ""
    default_instructions: str = ""
    charter_source: str = "manual"  # manual | template | imported
    charter_revision_id: str = field(default_factory=lambda: _id("charterrev"))
    # --- budgets (split: budget_seconds is a wall-clock timeout, NOT cost) ----
    token_budget: int = 0          # 0 = unbounded at this layer
    run_count_budget: int = 0
    external_tool_budget: int = 0
    revision_id: str = field(default_factory=lambda: _id("rev"))
    created_at: float = field(default_factory=time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentProfile":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Issue:
    """A unit of delegated work. Single-assignee by design.

    ``checkout_run_id`` is the ownership lock (who holds execution rights now);
    ``execution_run_id`` is the run that is actually live. They are related but
    not identical, mirroring the control-plane checkout semantics.
    """

    title: str
    issue_id: str = field(default_factory=lambda: _id("issue"))
    description: str = ""
    workspace_id: str = "local"
    company_profile_id: str = "local"
    owner_id: str = "local_user"
    status: str = IssueStatus.BACKLOG.value
    priority: str = "medium"
    # Business kind (Paperclip typed-issue): delivery | delegation | review | bug.
    # Drives differentiated governance; distinct from origin_kind (audit-only).
    kind: str = IssueKind.DELIVERY.value
    # Who may close this issue (in_review -> done): human_final (default; a person
    # approves, today's behaviour) | parent_accept | qa_accept | no_completion_gate.
    review_policy: str = ReviewPolicy.HUMAN_FINAL.value
    assignee_agent_profile_id: str | None = None
    goal_id: str | None = None
    parent_id: str | None = None
    checkout_run_id: str | None = None
    execution_run_id: str | None = None
    # The EXACT lock key this issue's checkout acquired — pinned at checkout
    # time so every release path frees what was actually taken, even if the
    # workspace's concurrency declaration changes mid-claim. None = unclaimed.
    lock_key: str | None = None
    # Provenance (mirrors Paperclip originKind/originRunId): how this issue
    # came to exist — "manual" (a human), "delegation" (an agent broke down
    # work), "automation" (a routine/system) — and, for agent-created issues,
    # which run created it. Audit-only; never drives gating.
    origin_kind: str = "manual"
    origin_run_id: str | None = None
    created_by: str = "local_user"
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
    # Wall-clock instant of the LAST status transition. Distinct from ``updated_at``
    # (which also moves on a comment/metadata edit), this only advances when ``status``
    # actually changes — so a message-center "blocked" item's event_time is the moment
    # the issue entered ``blocked``, not the last time anything touched the row
    # (docs/agent-company-message-center-design.md §2.5). The persistence layer
    # (StateStore) is the single choke point that stamps this on every status write;
    # ``__post_init__`` seeds a fresh issue to ``created_at`` (NOT ``time()`` — a brand
    # new issue's status has not "changed" since creation). The default is the
    # NEGATIVE sentinel ``-1.0`` (no real epoch is negative), so a legitimate stored
    # value — including the boundary ``0.0`` — is preserved verbatim and only a truly
    # unset field is seeded.
    status_changed_at: float = -1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Validate typed-issue fields at CONSTRUCTION so every Issue object — fresh,
        # from_dict-loaded, delegated child, bootstrap seed, checkout flip — is checked.
        # The persistence layer re-runs the SAME gate before each payload write to also
        # catch a field mutated after construction (see assert_valid_issue_typed_fields).
        assert_valid_issue_typed_fields(self)
        # A fresh Issue's status_changed_at == created_at: at construction the status
        # has not transitioned away from its initial value, so the "blocked since"
        # style event_time is the creation instant, not "now". Only the NEGATIVE
        # sentinel (-1.0, the default) means "unset" — seed it to created_at. A real
        # timestamp, including the boundary 0.0 (the Unix epoch), is non-negative and
        # therefore preserved verbatim, so a value carried through from_dict (a stored
        # or backfilled row) is never clobbered.
        if self.status_changed_at < 0:
            self.status_changed_at = self.created_at

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Issue":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        payload = {k: v for k, v in data.items() if k in known}
        # Deterministic legacy backfill: a row persisted before status_changed_at
        # existed must NOT read as "changed now" (that would make a blocked issue's
        # event_time jump to the present and re-surface as unread on every poll).
        # Fall back to the stored ``updated_at`` — the most recent write to the row,
        # a stable upper bound on when its status last moved — NEVER to a live clock.
        if "status_changed_at" not in data and "updated_at" in data:
            payload["status_changed_at"] = data["updated_at"]
        return cls(**payload)


@dataclass
class WorkspaceLock:
    """A durable, cross-process checkout lock on a workspace resource.

    Unlike the in-process ``ResourceLockManager``, this survives across separate
    CLI invocations and Agent runs, so two agents cannot both check out work
    that writes the same repo/worktree.
    """

    lock_key: str
    workspace_id: str
    holder: str
    issue_id: str | None = None
    run_id: str | None = None
    lease_id: str = field(default_factory=lambda: _id("wslease"))
    acquired_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkspaceLock":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


class WorkProductType(str, Enum):
    """What concrete thing an issue produced. A delivery-fact taxonomy, not a
    review state — the kind drives how a surface renders/links it."""

    PULL_REQUEST = "pull_request"
    BRANCH = "branch"
    COMMIT = "commit"
    PREVIEW = "preview"
    DEPLOYMENT = "deployment"
    ARTIFACT = "artifact"
    DOCUMENT = "document"
    LINK = "link"


class WorkProductStatus(str, Enum):
    """Lifecycle of a delivery fact. Deliberately light — review/approval is the
    approval gate's job, not the work product's."""

    OPEN = "open"
    READY = "ready"
    MERGED = "merged"
    CLOSED = "closed"
    FAILED = "failed"


_WORK_PRODUCT_TYPES = frozenset(t.value for t in WorkProductType)
_WORK_PRODUCT_STATUSES = frozenset(s.value for s in WorkProductStatus)


@dataclass
class WorkProduct:
    """A first-class delivery fact attached to an issue — the concrete thing the
    work produced (a PR, a commit, a preview URL, a deployed artifact, a doc), so
    a reviewer sees WHAT shipped rather than digging it out of a run transcript.

    This is the structured delivery ledger SuperClaw was missing next to its
    free-form evidence: queryable, typed, linkable, with one optional ``primary``
    per issue (the headline deliverable). Audit-only — it never gates a run.
    """

    issue_id: str
    type: str = WorkProductType.LINK.value
    work_product_id: str = field(default_factory=lambda: _id("wp"))
    company_profile_id: str = "local"
    provider: str = "local"
    title: str = ""
    url: str | None = None
    external_id: str | None = None
    status: str = WorkProductStatus.OPEN.value
    summary: str = ""
    is_primary: bool = False
    created_by_run_id: str | None = None
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkProduct":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Approval:
    """A first-class approval record — not a transient UI popup.

    It captures who requested what permission, which run/issue/plugin it
    affects, and the kernel action that resumes when the human approves. This is
    what separates real governance from approval theater.
    """

    type: str
    approval_id: str = field(default_factory=lambda: _id("approval"))
    status: str = ApprovalStatus.PENDING.value
    issue_id: str | None = None
    workspace_id: str = "local"
    requested_by: str = "local_user"
    requested_permission: dict[str, Any] = field(default_factory=dict)
    affects: dict[str, Any] = field(default_factory=dict)
    resume_action: dict[str, Any] = field(default_factory=dict)
    decision_note: str | None = None
    decided_by: str | None = None
    # Capacity of the decider, NOT a free label: an agent-driven completion (a
    # parent_accept child closed by its parent's run) must be auditable as such and
    # is authorized differently from a human decision. Defaults to "human" so every
    # existing CLI/API decision and stored row stays a human grant (zero behaviour
    # change). The kernel derives "agent" only from a trusted execution context —
    # never from a surface-supplied string (see decide_approval).
    decided_by_type: str = "human"
    deciding_agent_profile_id: str | None = None
    created_at: float = field(default_factory=time)
    decided_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Approval":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class RunTicket:
    """A run-bound, single-run/single-agent/single-company authentication ticket
    for the Agent-company autonomy MCP channel (柱子 2 of
    docs/agent-company-autonomy-design.md).

    The kernel mints one of these when a team run boots; the run-bound MCP proxy
    (PR-4) carries the opaque token on every company mutation, and the kernel
    re-verifies it against the durable store before acting — argv is only a hint.

    SECURITY INVARIANTS:
    - The plaintext token is NEVER persisted. Only ``token_hash`` (a SHA-256 of
      the secret) is stored; verification re-hashes the presented secret and
      compares with ``hmac.compare_digest``. A read of the DB cannot recover a
      usable token, mirroring the broker-token / registry-key hash discipline.
    - ``allowed_actions`` is the closed allow-list of tool/command names this
      ticket may invoke; an action outside it is refused (fail-closed).
    - Single-audience: ``audience`` names the one verifier surface this ticket is
      for (e.g. the team-MCP proxy). A verifier refuses a ticket minted for a
      different audience, so a ticket cannot be replayed across surfaces that
      happen to share the StateStore.
    - The verifier re-derives scope from ``run_id`` / ``agent_profile_id`` /
      ``company_id`` and, when the caller passes expectations, enforces they
      MATCH (fail-closed) inside the primitive — the scope-match check is not
      pushed onto the caller. ``is_admin`` is NEVER carried here and is always
      False for ticket-authenticated actors — it cannot be self-reported.
    - ``expires_at`` is an absolute epoch second; an expired ticket is refused.
    - ``revoked_at`` set (run ended / explicit revoke) refuses the ticket.

    Lifecycle: valid for many mutations within a single run's life; the run
    ending, an explicit revoke, or expiry all invalidate it (fail-closed).
    """

    run_id: str
    agent_profile_id: str
    company_id: str
    token_hash: str
    audience: str = ""
    allowed_actions: list[str] = field(default_factory=list)
    ticket_id: str = field(default_factory=lambda: _id("ticket"))
    issued_at: float = field(default_factory=time)
    expires_at: float = 0.0
    revoked_at: float | None = None
    # Run-scoped respond grant: when set, this ticket additionally authorizes a
    # SINGLE comment on the named issue's thread by an agent that does NOT own
    # the issue (an @-mentioned / human-triggered respond run). It is a single
    # opaque value (never a list — grants never accumulate), scopes to exactly
    # this run + this one issue + the comment action only, and is minted ONLY by
    # the kernel from the run's execution_context (never taken from a command
    # body). See docs/agent-company-autonomy-design.md (#2 run-scoped comment
    # authorization).
    respond_issue_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunTicket":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        payload = {k: v for k, v in data.items() if k in known}
        # The StateStore is the verification AUTHORITY, so deserialization must be
        # fail-closed, NOT coercive: a tampered/legacy payload whose
        # ``allowed_actions`` is not a list of non-blank strings is rejected
        # outright rather than silently coerced into surprising permissions
        # (e.g. ``str(None) -> "None"``, ``str(123) -> "123"``). This mirrors the
        # issue-time validation so the read path cannot mint actions the write
        # path would have refused.
        actions = payload.get("allowed_actions", [])
        # Must be an explicit list/tuple/set container, NOT a bare str (a str is
        # iterable and would otherwise split into one-character "actions"), and
        # every entry a non-blank string. Symmetric with company_ticket's
        # issue-time _normalize_actions.
        if isinstance(actions, str) or not isinstance(actions, (list, tuple, set)):
            raise ValueError("RunTicket.allowed_actions must be a list of strings")
        cleaned: set[str] = set()
        for entry in actions:
            if not isinstance(entry, str) or not entry.strip():
                raise ValueError("RunTicket.allowed_actions entries must be non-blank strings")
            cleaned.add(entry)
        payload["allowed_actions"] = sorted(cleaned)
        # Timestamps are the lifecycle authority — a non-finite (NaN/inf) expiry
        # would make ``now >= expires_at`` always False (a never-expiring ticket),
        # so the read path rejects it fail-closed even if a write path ever let one
        # through (defense in depth with json.dumps(allow_nan=False) on save).
        import math as _math

        for _field in ("issued_at", "expires_at"):
            if _field in payload:
                _value = payload[_field]
                if not isinstance(_value, (int, float)) or isinstance(_value, bool) or not _math.isfinite(_value):
                    raise ValueError(f"RunTicket.{_field} must be a finite epoch second")
        _rv = payload.get("revoked_at")
        if _rv is not None and (not isinstance(_rv, (int, float)) or isinstance(_rv, bool) or not _math.isfinite(_rv)):
            raise ValueError("RunTicket.revoked_at must be a finite epoch second or null")
        # respond_issue_id is the run-scoped comment grant. The store is the
        # verification authority, so deserialization is fail-closed: a present
        # value that is not a string is rejected outright (never coerced into a
        # surprising grant). A blank string carries no grant and is normalized to
        # None so equality checks against a real issue_id can never spuriously pass.
        if "respond_issue_id" in payload:
            _ri = payload["respond_issue_id"]
            if _ri is not None and not isinstance(_ri, str):
                raise ValueError("RunTicket.respond_issue_id must be a string or null")
            if isinstance(_ri, str) and not _ri.strip():
                payload["respond_issue_id"] = None
        return cls(**payload)


@dataclass
class VerifiedTicket:
    """The trusted result of verifying a :class:`RunTicket`.

    Carries ONLY the identity fields the caller needs to re-derive scope. It
    deliberately does NOT carry the token or any admin flag: a ticket-authed
    actor is never admin, and scope is recomputed from these ids + the agent
    profile, never self-reported.
    """

    run_id: str
    agent_profile_id: str
    company_id: str
    audience: str
    ticket_id: str
    action: str
    # Run-scoped respond grant carried from the verified RunTicket (None when the
    # ticket carries no grant). The scope re-derivation reads this to authorize a
    # single comment on a non-owned issue thread; it is NEVER self-reported.
    respond_issue_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --- Governance namespace: company / workspace -----------------------------


class CompanyStatus(str, Enum):
    """Lifecycle state of a company governance namespace.

    Foundation for the chat-driven company-management design
    (docs/company-chat-management-design.md, contract B5): only an ACTIVE
    company may host new mutations/runs. FROZEN is the transient pre-archive
    state during the two-phase ``request_company_archive`` flow; DISSOLVED is
    the terminal soft-archived state (records are retained read-only, the
    company_id is never reused).
    """

    ACTIVE = "active"
    FROZEN = "frozen"  # two-phase archive: frozen, pending human approval
    DISSOLVED = "dissolved"  # soft-archived terminal state


@dataclass
class CompanyProfile:
    """A local governance namespace (replaces the hardcoded "local" placeholder).

    Single-machine, single-tenant: this is NOT a security isolation boundary,
    it is the carrier of org-wide defaults (budgets, allowed plugins, policies).
    """

    name: str
    company_profile_id: str = field(default_factory=lambda: _id("company"))
    goal: str = ""
    owner_id: str = "local_user"
    default_budget_seconds: int = 0
    default_token_budget: int = 0
    allowed_plugins: list[str] = field(default_factory=list)
    high_risk_policies: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time)
    metadata: dict[str, Any] = field(default_factory=dict)
    # --- lifecycle (contract B5: epoch fencing / archive TOCTOU defence) -----
    # ``epoch`` is a monotonic generation counter bumped on every freeze /
    # archive / restore. Recoverable artifacts (runs, approvals, tokens, …)
    # persist the epoch they were issued under so a stale continuation cannot
    # slip past an archive (later contract-B5 increments). Legacy rows predate
    # these fields; from_dict defaults keep them ACTIVE @ epoch 1.
    status: str = CompanyStatus.ACTIVE.value
    epoch: int = 1
    # --- visual identity (表现层资产引用，非 company-as-code 逻辑) ----------
    # ``logo`` is the stored filename of a custom uploaded logo, resolved
    # against ``<state-dir>/company-logos/`` (see company_logo.py). Empty means
    # "no custom logo" → the web surface falls back to a deterministic
    # identicon derived from ``company_profile_id``. It carries only a reference
    # string (never image bytes) so persistence/round-trip stays cheap; logos
    # are deliberately NOT part of the company-as-code export bundle. Legacy
    # rows predate this field; from_dict defaults keep it empty (back-compat).
    logo: str = ""

    @property
    def is_active(self) -> bool:
        return self.status == CompanyStatus.ACTIVE.value

    @property
    def is_dissolved(self) -> bool:
        return self.status == CompanyStatus.DISSOLVED.value

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyProfile":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class MarketplaceOrder:
    """The durable ledger row tying a ClawHunt order to a local delivery.

    The SINGLE source of truth for a claimed marketplace order's lifecycle
    (advisor阻断项 2): it survives a crash, carries the saga ``status``, and pins
    the three ids that must never drift —

      * ``problem_id`` + ``base_url`` — the remote ClawHunt order (the unique slot;
        the store enforces one live order per ``(base_url, problem_id)`` so two
        chats can never both claim it).
      * ``company_profile_id`` — the company that OWNS the delivery (server-injected
        from the actor's CompanyScope, never the command body).
      * ``issue_id`` / ``run_id`` — the bound delivery Issue and run (None until the
        saga binds them).

    ``problem_snapshot`` is the inspected remote payload captured at claim time
    (so the delivery has the order's requirements even if the remote later changes
    or the agent key lapses). ``last_error`` records the most recent failure for a
    ``*_failed`` / ``blocked`` state. ``submission_response`` holds the remote
    reply once submitted (mirrors EvidenceBundle.submission_response).
    """

    problem_id: str
    base_url: str
    company_profile_id: str
    order_id: str = field(default_factory=lambda: _id("order"))
    status: str = MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value
    issue_id: str | None = None
    run_id: str | None = None
    # The approval that authorized the CLAIM (HIGH), and the one that authorized a
    # SUBMIT (HIGH) — kept so a surface/audit can trace which human grant drove
    # each remote commitment.
    claim_approval_id: str | None = None
    submit_approval_id: str | None = None
    requested_by: str = ""
    #: Idempotency key so a retried claim request (lost response) maps back to the
    #: SAME order row instead of being rejected by the live-slot unique index with
    #: no way to recover the original. When non-empty, ``create_marketplace_claim``
    #: returns the existing live order with the matching key rather than inserting
    #: a duplicate. Empty (the default) means "no idempotency" — each claim is a
    #: distinct request and a second live claim for the slot is refused.
    idempotency_key: str = ""
    problem_snapshot: dict[str, Any] = field(default_factory=dict)
    submission_response: dict[str, Any] = field(default_factory=dict)
    last_error: str = ""
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
    status_changed_at: float = field(default_factory=time)

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_MARKETPLACE_ORDER_STATUSES

    @property
    def occupies_remote_slot(self) -> bool:
        """True while this order holds the live ``(base_url, problem_id)`` slot.

        A terminal ``abandoned`` (remote released) or ``claim_failed`` (nothing was
        ever committed) frees the slot for a fresh claim; ``submitted`` keeps it
        (the order is delivered, not re-takeable). Used by the store's unique-slot
        guard so a re-claim after release is allowed but a double-claim is not.
        """
        return self.status not in {
            MarketplaceOrderStatus.ABANDONED.value,
            MarketplaceOrderStatus.CLAIM_FAILED.value,
        }

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceOrder":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


class WorkspaceKind(str, Enum):
    """What anchors a workspace (ADR: docs/workspace-trust-container.md)."""

    REPO = "repo"  # a user-owned repo/directory, trusted explicitly
    MANAGED = "managed"  # app-owned scratch/checkout dir, trusted by construction
    REMOTE = "remote"  # reserved for future remote/sandbox workspaces


class WorkspaceTrustStatus(str, Enum):
    """Trust lifecycle of a workspace (fail-closed surface)."""

    PENDING_TRUST = "pending_trust"  # identified but not yet authorized
    ACTIVE = "active"  # authorized to host sessions/runs
    QUARANTINED = "quarantined"  # frozen by a high-risk policy trigger


@dataclass
class WorkspaceProfile:
    """The single workspace concept: a repo-anchored trust container.

    One object carries session grouping, the durable execution/permission
    boundary, and project-level defaults (ADR:
    docs/workspace-trust-container.md). The transient checkout lock is
    momentary occupancy on top of it. ``writable_paths`` and ``network_policy``
    are the fail-closed surface for write/scan/payment gating;
    ``trust_status`` gates whether the workspace may host work at all.
    """

    name: str
    workspace_id: str = field(default_factory=lambda: _id("workspace"))
    company_profile_id: str = "local"
    repo_path: str = "."
    writable_paths: list[str] = field(default_factory=lambda: ["."])
    default_permission_policy: dict[str, Any] = field(default_factory=dict)
    network_policy: str = "restricted"  # restricted | none | open(approval-gated)
    # Checkout-lock granularity. "serial" (default, fail-safe): one in-flight
    # checkout per workspace — two agents can never write the same repo at
    # once. "per_issue": each issue locks only itself, legal ONLY because
    # execution isolates per issue (git worktrees); declared at the governance
    # layer so every surface derives the same lock key.
    concurrency: str = "serial"  # serial | per_issue
    created_at: float = field(default_factory=time)
    metadata: dict[str, Any] = field(default_factory=dict)
    # --- trust container fields (ADR: workspace-trust-container) -----------
    # Legacy rows predate the trust lifecycle; they were created deliberately
    # via CLI/API, so defaults keep them ACTIVE/repo on deserialization.
    kind: str = WorkspaceKind.REPO.value
    trust_status: str = WorkspaceTrustStatus.ACTIVE.value
    trusted_at: float | None = None
    trust_source: str | None = None  # cli_prompt | managed | api | legacy
    policy_version: int = 1
    # Repo identity fingerprint for worktree/symlink normalization:
    # {"canonical_path", "git_common_dir", "remote_url"}. The fingerprint
    # groups checkouts of the same project; repo_path stays the actual
    # checkout path used for write gating and native sessions.
    repo_identity: dict[str, Any] = field(default_factory=dict)
    # Runtime containment preset (T11). Orthogonal to trust_status (which gates
    # whether the workspace may host work AT ALL); this gates HOW a run executes
    # inside it. "standard" = today's behaviour; "low_trust_review" = the fenced
    # posture for reviewing untrusted external code (resolved by
    # superclaw.containment; a remote/untrusted-source workspace floors to it).
    containment_preset: str = "standard"
    # Sidebar pin (cross-surface). When set, the whole project group floats to
    # the top "Pinned" zone of every surface's sidebar; ``None`` means not
    # pinned. The timestamp is the pin moment, used purely to order pinned items.
    # Pinning is a presentation/navigation preference — it never changes trust,
    # grouping membership, or the execution boundary.
    pinned_at: float | None = None

    @property
    def is_trusted(self) -> bool:
        return self.trust_status == WorkspaceTrustStatus.ACTIVE.value

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkspaceProfile":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        profile = cls(**{k: v for k, v in data.items() if k in known})
        if "trust_status" not in data and profile.trust_source is None:
            # Pre-ADR row: created deliberately via CLI/API before the trust
            # lifecycle existed. Mark it so audits can tell granted from
            # grandfathered trust.
            profile.trust_source = "legacy"
        return profile


# --- Cost tracing: the run-layer ledger ------------------------------------
#
# Unifying truth: Chat, single delivery, and team-member runs are all the same
# thing — an agent run/turn. A CostEvent records the *measurable consumption*
# within one run (not all runs cost money; not all cost is model tokens). The
# durable ledger lives in StateStore.cost_events; both the Chat surface and the
# Team/company surface are just query views over it.


class CostSource(str, Enum):
    CHAT = "chat"
    DELIVERY = "delivery"
    TEAM_MEMBER = "team_member"
    PLUGIN_TOOL = "plugin_tool"


class CostMeterKind(str, Enum):
    MODEL_TOKENS = "model_tokens"
    WALL_CLOCK = "wall_clock"
    EXTERNAL_TOOL = "external_tool"


class CostUsageStatus(str, Enum):
    ACTUAL = "actual"              # provider returned real usage
    ESTIMATED = "estimated"        # derived/approximated
    UNAVAILABLE = "unavailable"    # provider should have usage but we couldn't get it
    NOT_APPLICABLE = "not_applicable"  # local/dry-run: no token cost by nature


@dataclass
class CostSnapshot:
    """The measurable consumption of one turn — attached to WorkerResult.cost."""

    backend: str = ""
    provider: str = "unknown"
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None
    reasoning_tokens: int | None = None
    tool_call_count: int | None = None
    duration_seconds: float = 0.0
    meter_kind: str = CostMeterKind.MODEL_TOKENS.value
    usage_status: str = CostUsageStatus.UNAVAILABLE.value
    usage_source: str = "local_timer"  # provider_response | stream_event | transcript | local_timer
    invocation_id: str | None = None
    raw_usage: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CostSnapshot":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class CostEvent:
    """One durable, idempotent ledger entry for a unit of consumption."""

    idempotency_key: str
    event_id: str = field(default_factory=lambda: _id("cost"))
    occurred_at: float = field(default_factory=time)
    # scope / lineage
    run_id: str | None = None
    parent_run_id: str | None = None
    chat_session_id: str | None = None
    chat_message_id: str | None = None
    task_id: str | None = None
    attempt_index: int | None = None
    agent_profile_id: str | None = None
    issue_id: str | None = None
    company_profile_id: str | None = None
    workspace_id: str | None = None
    # metering
    source: str = CostSource.CHAT.value
    meter_kind: str = CostMeterKind.MODEL_TOKENS.value
    backend: str = ""
    provider: str = "unknown"
    model: str | None = None
    invocation_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None
    reasoning_tokens: int | None = None
    tool_call_count: int | None = None
    duration_seconds: float = 0.0
    usage_status: str = CostUsageStatus.UNAVAILABLE.value
    usage_source: str = "local_timer"
    status: str = "completed"  # completed | failed | timed_out | cancelled
    raw_usage: dict[str, Any] | None = None
    # --- money (B 端 schema 锁定; mirrors Paperclip cost_events.cost_cents) ---
    # ``relay`` lane = the relay server's own metering is authoritative and
    # cost_cents echoes its receipt; ``byo`` lane = a local reference estimate
    # from the configured price table (superclaw.pricing) that is never billed.
    cost_cents: int = 0
    billing_lane: str = "byo"  # relay | byo

    @property
    def total_tokens(self) -> int:
        return int(self.input_tokens or 0) + int(self.output_tokens or 0)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CostEvent":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})

    @classmethod
    def from_snapshot(
        cls,
        snapshot: "CostSnapshot | dict[str, Any]",
        *,
        idempotency_key: str,
        source: str,
        run_id: str | None = None,
        task_id: str | None = None,
        attempt_index: int | None = None,
        agent_profile_id: str | None = None,
        issue_id: str | None = None,
        company_profile_id: str | None = None,
        workspace_id: str | None = None,
        chat_session_id: str | None = None,
        status: str = "completed",
    ) -> "CostEvent":
        snap = snapshot.to_dict() if isinstance(snapshot, CostSnapshot) else dict(snapshot or {})
        return cls(
            idempotency_key=idempotency_key,
            source=source,
            run_id=run_id,
            task_id=task_id,
            attempt_index=attempt_index,
            agent_profile_id=agent_profile_id,
            issue_id=issue_id,
            company_profile_id=company_profile_id,
            workspace_id=workspace_id,
            chat_session_id=chat_session_id,
            status=status,
            backend=str(snap.get("backend") or ""),
            provider=str(snap.get("provider") or "unknown"),
            model=snap.get("model"),
            invocation_id=snap.get("invocation_id"),
            input_tokens=snap.get("input_tokens"),
            output_tokens=snap.get("output_tokens"),
            cached_input_tokens=snap.get("cached_input_tokens"),
            reasoning_tokens=snap.get("reasoning_tokens"),
            tool_call_count=snap.get("tool_call_count"),
            duration_seconds=float(snap.get("duration_seconds") or 0.0),
            meter_kind=str(snap.get("meter_kind") or CostMeterKind.MODEL_TOKENS.value),
            usage_status=str(snap.get("usage_status") or CostUsageStatus.UNAVAILABLE.value),
            usage_source=str(snap.get("usage_source") or "local_timer"),
            raw_usage=snap.get("raw_usage"),
            cost_cents=int(snap.get("cost_cents") or 0),
            billing_lane=str(snap.get("billing_lane") or "byo"),
        )


# ---------------------------------------------------------------------------
# Issue thread（阶段 3a; mirrors Paperclip issue_comments /
# issue_thread_interactions）。评论是组织的沟通面：@-mention、QA 打回、阻塞
# 求助都落在这里，并通过 interaction 的 continuation_policy 变成确定性的
# 唤醒事件——"blocked 必须能喊人，评论即唤醒"。
# ---------------------------------------------------------------------------


class IssueInteractionKind(str, Enum):
    MENTION = "mention"
    QA_REJECTION = "qa_rejection"
    COMPLETION = "completion"
    STATUS_CHANGE = "status_change"
    DELEGATION = "delegation"


class ContinuationPolicy(str, Enum):
    WAKE_ASSIGNEE = "wake_assignee"
    NOTIFY_PARENT = "notify_parent"
    ESCALATE_TO_BOARD = "escalate_to_board"
    NONE = "none"


@dataclass
class IssueComment:
    """One durable message on an issue's thread (human, agent, or system)."""

    issue_id: str
    body: str
    comment_id: str = field(default_factory=lambda: _id("comment"))
    company_profile_id: str = "local"
    author_type: str = "user"  # user | agent | system
    author_id: str = "local_user"
    created_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueComment":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class IssueThreadInteraction:
    """A thread event that may demand a continuation (the auditable bridge
    from "someone said something" to "an agent wakes up about it")."""

    issue_id: str
    kind: str
    interaction_id: str = field(default_factory=lambda: _id("interact"))
    company_profile_id: str = "local"
    status: str = "pending"  # pending | resolved
    continuation_policy: str = ContinuationPolicy.NONE.value
    target_agent_profile_id: str | None = None
    source_comment_id: str | None = None
    source_run_id: str | None = None
    created_by_type: str = "user"  # user | agent | system
    created_by_id: str = "local_user"
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time)
    resolved_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueThreadInteraction":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class IssueHold:
    """An administrative pause marker on an issue — a hold-ledger row.

    A hold is deliberately NOT an issue status: it never enters the status
    transition graph, so a held issue keeps its real lane (todo / in_progress /
    …) and the graph stays clean. While a hold is active the kernel refuses to
    start work on the issue (checkout) and the daemon skips it; releasing the
    hold lets it flow again — no status surgery, fully reversible. Holds are an
    append-only ledger (pause and resume each leave a row, never mutate in
    place), so the pause history is auditable. ``scope`` separates a single-issue
    hold from one applied across a whole delegation subtree, and ``operation_id``
    groups the per-issue holds a single tree pause created.
    """

    issue_id: str
    hold_id: str = field(default_factory=lambda: _id("hold"))
    company_profile_id: str = "local"
    scope: str = "single"  # single | tree
    operation_id: str | None = None  # groups one tree pause's per-issue holds
    reason: str = ""
    status: str = "active"  # active | released
    created_by: str = "local_user"
    created_at: float = field(default_factory=time)
    released_at: float | None = None
    released_by: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueHold":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


# ---------------------------------------------------------------------------
# Heartbeat engine（daemon 阶段 2; mirrors Paperclip agent_wakeup_requests /
# agent_runtime_state / agent_task_sessions）。Wakeup = "为什么醒、带什么上下文"
# 的持久化事实; runtime_state = per-agent 心跳水位与累计; task_session =
# per-agent-per-task 的续会话锚点（阶段 3 委派回流消费）。
# ---------------------------------------------------------------------------


class WakeupSource(str, Enum):
    TIMER = "timer"
    ASSIGNMENT = "assignment"
    ON_DEMAND = "on_demand"
    AUTOMATION = "automation"
    ROUTINE = "routine"


@dataclass
class AgentWakeupRequest:
    """One queued reason for an agent to wake (durable, idempotent, coalescing).

    The queue *is* the scheduler's memory: a timer tick, an assignment, or an
    approval resume all become rows here, and the daemon drains them through
    the claim gate. ``idempotency_key`` collapses duplicate triggers;
    ``coalesced_count`` records how many were absorbed.
    """

    agent_profile_id: str
    wakeup_id: str = field(default_factory=lambda: _id("wake"))
    company_profile_id: str = "local"
    source: str = WakeupSource.ON_DEMAND.value
    reason: str = ""
    status: str = "queued"  # queued | claimed | finished | skipped
    idempotency_key: str | None = None
    coalesced_count: int = 0
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    requested_at: float = field(default_factory=time)
    claimed_at: float | None = None
    finished_at: float | None = None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentWakeupRequest":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class AgentRuntimeState:
    """Per-agent scheduler watermark + rolling totals (Paperclip layer 1 of 3)."""

    agent_profile_id: str
    last_heartbeat_at: float | None = None
    last_run_id: str | None = None
    last_run_status: str | None = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost_cents: int = 0
    updated_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentRuntimeState":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class AgentTaskSession:
    """Per-agent-per-task session continuity anchor (Paperclip layer 2 of 3).

    ``task_key`` is the durable work identity (an issue id); ``session_ref`` is
    the backend-native session/thread id the resume guards consume so the next
    turn on the same task continues instead of starting cold.
    """

    agent_profile_id: str
    task_key: str
    company_profile_id: str = "local"
    backend: str = ""
    session_ref: str | None = None
    last_run_id: str | None = None
    last_run_status: str | None = None
    backlog_summary: dict[str, Any] = field(default_factory=dict)
    updated_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentTaskSession":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class TeamRoutineSchedule:
    """A durable per-agent routine definition claimed by the daemon.

    The schedule row is the source of truth. Claiming a due routine advances
    ``next_run_at`` and queues a wakeup in one StateStore transaction, so two
    daemon ticks cannot produce duplicate executions for the same due slot.
    """

    agent_profile_id: str
    title: str
    interval_sec: int
    routine_id: str = field(default_factory=lambda: _id("routine"))
    company_profile_id: str = "local"
    enabled: bool = True
    next_run_at: float = field(default_factory=time)
    idempotency_key: str | None = None
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    last_claimed_at: float | None = None
    last_wakeup_id: str | None = None
    claim_count: int = 0
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TeamRoutineSchedule":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


# ---------------------------------------------------------------------------
# Org membership（B 端 schema 锁定; mirrors Paperclip company_memberships /
# instance_user_roles）。本地 v1 单用户：root 即 instance_admin；运行时隔离
#（登录/邀请/RLS）推 B 端里程碑 — 现在锁 schema，迟补 = 数据迁移。
# ---------------------------------------------------------------------------


@dataclass
class CompanyMembership:
    """One principal's membership in a company.

    ``principal_type`` is ``user`` or ``agent`` — humans and agent employees
    share a single org-membership abstraction (Paperclip's principalType/
    principalId design), which is what lets a personal company plug into a
    hosted org later without a schema migration.
    """

    company_profile_id: str
    principal_type: str  # user | agent
    principal_id: str
    membership_id: str = field(default_factory=lambda: _id("member"))
    membership_role: str = "member"  # owner | admin | member
    status: str = "active"  # active | suspended | removed
    created_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyMembership":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class InstanceUserRole:
    """Instance-level role for a human user (Paperclip instance_user_roles).

    Local v1 seeds exactly one row: the local root user as ``instance_admin``.
    """

    user_id: str
    role: str = "instance_admin"
    role_id: str = field(default_factory=lambda: _id("instrole"))
    created_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InstanceUserRole":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


# ---------------------------------------------------------------------------
# Secrets / InstanceSettings（Paperclip 拿取清单 §6，本地 v1）
# Schema 命名镜像官方 Paperclip（company_secrets / *_versions / *_bindings /
# secret_access_events / instance_settings）；provider 本地 v1 仅 local_encrypted，
# 外部 vault（provider_configs）与 environments 租约推 B 端里程碑。
# ---------------------------------------------------------------------------


@dataclass
class CompanySecret:
    """Ledger row for one named secret. NEVER carries plaintext — the value
    lives only in encrypted version material (CompanySecretVersion)."""

    name: str
    secret_id: str = field(default_factory=lambda: _id("secret"))
    company_profile_id: str = "local"
    provider: str = "local_encrypted"
    description: str = ""
    current_version: int = 0
    created_by: str = "local_user"
    created_at: float = field(default_factory=time)
    rotated_at: float | None = None
    archived: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanySecret":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class CompanySecretVersion:
    """One immutable encrypted version of a secret (简化版：版本号+时间戳+材料)."""

    secret_id: str
    version: int
    # local_encrypted_v1 material: {"scheme", "iv", "tag", "ciphertext"} (all base64)
    material: dict[str, Any] = field(default_factory=dict)
    value_sha256: str = ""
    created_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanySecretVersion":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class CompanySecretBinding:
    """Declarative grant: WHICH consumer may read a secret and WHERE it lands.

    ``target_type``/``target_id`` name the consumer (e.g. agent_profile / plugin /
    backend), ``config_path`` is the destination (environment variable name for
    v1). ``required=True`` feeds the invokability gate: a consumer whose required
    secret is missing or archived is NOT invokable (fail-closed)."""

    secret_id: str
    target_type: str
    target_id: str
    config_path: str
    binding_id: str = field(default_factory=lambda: _id("secbind"))
    company_profile_id: str = "local"
    required: bool = True
    created_at: float = field(default_factory=time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanySecretBinding":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class SecretAccessEvent:
    """Append-only audit row. ``action`` ∈ create|rotate|resolve|denied|archive|
    unarchive|delete|bind|unbind. Denied resolutions are recorded too — the
    audit trail is most valuable exactly when access was refused."""

    secret_id: str
    action: str
    event_id: str = field(default_factory=lambda: _id("secevt"))
    company_profile_id: str = "local"
    version: int | None = None
    actor: str = "local_user"
    target_type: str | None = None
    target_id: str | None = None
    run_id: str | None = None
    issue_id: str | None = None
    occurred_at: float = field(default_factory=time)
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SecretAccessEvent":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class InstanceSettings:
    """Singleton instance configuration: two JSON buckets, mirroring Paperclip's
    ``instance_settings`` (general/experimental). Daemon-global knobs live here."""

    general: dict[str, Any] = field(default_factory=dict)
    experimental: dict[str, Any] = field(default_factory=dict)
    updated_at: float = field(default_factory=time)

    BUCKETS = ("general", "experimental")

    def to_dict(self) -> dict[str, Any]:
        return {"general": self.general, "experimental": self.experimental, "updated_at": self.updated_at}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InstanceSettings":
        return cls(
            general=dict(data.get("general") or {}),
            experimental=dict(data.get("experimental") or {}),
            updated_at=float(data.get("updated_at") or 0.0) or time(),
        )
