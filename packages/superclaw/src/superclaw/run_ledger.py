"""Issue run ledger — a read-only projection of "what happened to this issue".

Paperclip surfaces every heartbeat run against an issue with an explicit status
(running / succeeded / failed / timed_out / …) plus the failure reason, so an
operator can always see *why* an issue is stuck. SuperClaw already records the
same facts — assignment / mention / comment wakeups in ``agent_wakeup_requests``
(with a durable ``detail``) and the resulting ``runs`` — but nothing projects
them for a surface, so a failed or deferred run is invisible and the issue looks
like "nothing happened".

This module is that projection, and it is the SINGLE place the fragile wakeup
``detail`` strings are parsed into a normalized status vocabulary (铁律: contracts
are centralised; surfaces consume structured entries, never re-parse details).
It introduces NO new business state — it only reads existing StateStore facts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from superclaw.models import AgentWakeupRequest, RunStatus

if TYPE_CHECKING:  # pragma: no cover - typing only
    from superclaw.state import StateStore

# Normalized, surface-facing run-state vocabulary (mirrors Paperclip's
# HEARTBEAT_RUN_STATUSES intent). Surfaces map these to labels/tone via the
# ``run_ledger`` contract; they never derive status from raw details themselves.
LEDGER_STATUS_QUEUED = "queued"
LEDGER_STATUS_RUNNING = "running"
LEDGER_STATUS_WAITING = "waiting"  # ran but paused on a human gate / child delegation
LEDGER_STATUS_SUCCEEDED = "succeeded"
LEDGER_STATUS_FAILED = "failed"
LEDGER_STATUS_TIMED_OUT = "timed_out"
LEDGER_STATUS_NO_RESPONSE = "no_response"
LEDGER_STATUS_DEFERRED = "deferred"
LEDGER_STATUS_RECLAIMED = "reclaimed"
LEDGER_STATUS_SKIPPED = "skipped"
LEDGER_STATUS_IDLE = "idle"

LEDGER_STATUSES: tuple[str, ...] = (
    LEDGER_STATUS_QUEUED,
    LEDGER_STATUS_RUNNING,
    LEDGER_STATUS_WAITING,
    LEDGER_STATUS_SUCCEEDED,
    LEDGER_STATUS_FAILED,
    LEDGER_STATUS_TIMED_OUT,
    LEDGER_STATUS_NO_RESPONSE,
    LEDGER_STATUS_DEFERRED,
    LEDGER_STATUS_RECLAIMED,
    LEDGER_STATUS_SKIPPED,
    LEDGER_STATUS_IDLE,
)

# Statuses that mean "an agent is actively working on this issue right now" —
# the surface shows a live/Thinking indicator for these. ``waiting`` is NOT
# active (it is paused on a human gate), so it must never blink "working".
ACTIVE_LEDGER_STATUSES: frozenset[str] = frozenset(
    {LEDGER_STATUS_QUEUED, LEDGER_STATUS_RUNNING}
)

# Run statuses that genuinely mean "executing now" — used to override a finished
# wakeup row to running ONLY when the run is truly live (NOT a waiting/gate state).
_LIVE_RUN_STATUSES: frozenset[str] = frozenset(
    {
        RunStatus.CREATED.value,
        RunStatus.QUEUED.value,
        RunStatus.RUNNING.value,
        RunStatus.VERIFYING.value,
    }
)
_WAITING_RUN_STATUSES: frozenset[str] = frozenset(
    {
        RunStatus.WAITING_FOR_HUMAN_GATE.value,
        RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
    }
)

# Wakeup-reason prefix -> ledger entry "kind" (what the wakeup was trying to do).
_WORK_REASONS = (
    "issue_assigned",
    "delegated",
    "child_done",
    "qa_rejection",
    "revision_requested",
)
_KIND_BY_PREFIX: dict[str, str] = {
    **{prefix: "work" for prefix in _WORK_REASONS},
    "mention": "respond",
    "comment": "comment",
}


@dataclass(frozen=True)
class IssueRunLedgerEntry:
    """One normalized "an agent woke for this issue and here is what happened" row."""

    wakeup_id: str
    agent_profile_id: str  # which agent this wakeup/run belongs to (for "<agent> thinking" dots)
    kind: str  # work | respond | comment | other
    reason: str
    status: str  # one of LEDGER_STATUSES
    run_id: str | None
    run_status: str | None
    active: bool
    detail: str
    requested_at: float
    claimed_at: float | None
    finished_at: float | None
    # Read-only failure enrichment from the run's evidence (NOT artifact text):
    # the failing worker's exit code and whether it timed out, so "why it failed"
    # (e.g. exit_code=124 timeout) is visible instead of a bare "failed".
    timed_out: bool = False
    exit_code: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "wakeup_id": self.wakeup_id,
            "agent_profile_id": self.agent_profile_id,
            "kind": self.kind,
            "reason": self.reason,
            "status": self.status,
            "run_id": self.run_id,
            "run_status": self.run_status,
            "active": self.active,
            "detail": self.detail,
            "requested_at": self.requested_at,
            "claimed_at": self.claimed_at,
            "finished_at": self.finished_at,
            "timed_out": self.timed_out,
            "exit_code": self.exit_code,
        }


@dataclass(frozen=True)
class IssueRunLedger:
    issue_id: str
    entries: list[IssueRunLedgerEntry] = field(default_factory=list)

    @property
    def active(self) -> bool:
        """True when any entry means an agent is currently working this issue."""
        return any(entry.active for entry in self.entries)

    def to_dict(self) -> dict[str, Any]:
        return {
            "issue_id": self.issue_id,
            "active": self.active,
            "entries": [entry.to_dict() for entry in self.entries],
        }


def _reason_prefix(reason: str) -> str:
    return reason.split(":", 1)[0] if reason else ""


def _reason_issue_id(reason: str) -> str | None:
    """The issue id encoded in a ``<prefix>:<issue_id>`` reason, if any."""
    if ":" not in reason:
        return None
    prefix, rest = reason.split(":", 1)
    if prefix in _KIND_BY_PREFIX or prefix in _WORK_REASONS:
        return rest or None
    return None


def _wakeup_targets_issue(wakeup: AgentWakeupRequest, issue_id: str) -> bool:
    if _reason_issue_id(wakeup.reason) == issue_id:
        return True
    snap = wakeup.context_snapshot or {}
    return str(snap.get("issue_id") or "") == issue_id


def _parse_ran_detail(detail: str) -> tuple[str | None, str | None]:
    """Parse a ``ran:<run_id>:<run_status>[:...]`` detail.

    Returns ``(run_id, run_status)``; either may be None when the detail is not a
    ``ran:`` form. This is the ONE place that string shape is decoded.
    """
    if not detail.startswith("ran:"):
        return None, None
    parts = detail.split(":")
    run_id = parts[1] if len(parts) > 1 and parts[1] else None
    run_status = parts[2] if len(parts) > 2 and parts[2] else None
    return run_id, run_status


def _normalize(wakeup: AgentWakeupRequest) -> tuple[str, str | None]:
    """Map a wakeup (status + durable detail) to (ledger_status, run_id).

    Centralised so surfaces never re-derive run state from raw details.
    """
    status = (wakeup.status or "").lower()
    detail = wakeup.detail or ""

    if status == "queued":
        return LEDGER_STATUS_QUEUED, None
    if status == "claimed":
        return LEDGER_STATUS_RUNNING, None

    run_id, run_status = _parse_ran_detail(detail)
    if run_id is not None:
        # Exact run_status match (not a substring scan) so a future detail like
        # ``no_response_from_api`` can't be mis-read as a clean no-response.
        # Vocabulary tracks daemon.py's actual ``ran:<id>:<...>`` writers.
        if run_status == "no_response":
            return LEDGER_STATUS_NO_RESPONSE, run_id
        if run_status in (RunStatus.COMPLETED.value, "responded", "submitted_for_review"):
            return LEDGER_STATUS_SUCCEEDED, run_id
        if run_status in ("waiting_human_gate", "waiting_for_child_delegation"):
            return LEDGER_STATUS_WAITING, run_id
        if run_status in ("claim_changed_before_submit", "held_before_submit", RunStatus.CANCELLED.value):
            # The run finished but its result was superseded / blocked before
            # submit — not a failure, not a clean success.
            return LEDGER_STATUS_SKIPPED, run_id
        # failed / run_error / any other terminal-but-not-completed outcome
        return LEDGER_STATUS_FAILED, run_id

    # Non-``ran:`` finish/skip markers (one per daemon writer family).
    if detail.startswith(("error:", "run_error:", "respond_error:")):
        return LEDGER_STATUS_FAILED, None
    if detail.startswith("reclaimed:"):
        return LEDGER_STATUS_RECLAIMED, None
    if detail.endswith(":deferred"):  # agent_busy / workspace_locked / workspace_guard_busy
        return LEDGER_STATUS_DEFERRED, None
    if detail == "idle":
        return LEDGER_STATUS_IDLE, None
    # finished/skipped with an unrecognised detail: fail-soft to skipped (never
    # invent success, never cry failure on an unknown marker).
    return LEDGER_STATUS_SKIPPED, None


def _failure_enrichment(store: "StateStore", run_id: str) -> tuple[bool, int | None]:
    """Read (timed_out, exit_code) from a run's evidence worker results.

    Structured, read-only — uses ``StateStore.get_evidence(run_id).worker_results``
    (which the orchestrator already persists), NOT artifact-log text parsing.
    Prefers a timed-out worker; else reports the first non-zero exit code. Returns
    (False, None) when there is no evidence or no failing worker.
    """
    try:
        evidence = store.get_evidence(run_id)
    except Exception:
        # Display-only enrichment: missing (KeyError) OR corrupt/undeserializable
        # evidence must never break the read-only ledger endpoint — fail soft.
        return False, None
    results = getattr(evidence, "worker_results", None) or []
    timed_out = any(getattr(r, "timed_out", False) for r in results)
    exit_code: int | None = None
    for r in results:
        if getattr(r, "timed_out", False):
            exit_code = getattr(r, "exit_code", None)
            break
        code = getattr(r, "exit_code", None)
        if exit_code is None and isinstance(code, int) and code != 0:
            exit_code = code
    return timed_out, exit_code


def build_issue_run_ledger(
    store: "StateStore", issue_id: str, *, scan_limit: int = 500
) -> IssueRunLedger:
    """Project every wakeup/run that targeted ``issue_id`` into a normalized ledger.

    Read-only: it joins ``agent_wakeup_requests`` (durable detail) with ``runs``
    (live status) — both existing facts — and never mutates state. Scans the most
    recent ``scan_limit`` wakeups (newest-first); this is a bounded recent view,
    not an exhaustive history, so an issue's latest run is never dropped behind a
    backlog of older global wakeups (a busy board may elide very old entries).
    """
    wakeups = store.list_wakeups(limit=scan_limit, newest_first=True)
    entries: list[IssueRunLedgerEntry] = []
    for wakeup in wakeups:
        if not _wakeup_targets_issue(wakeup, issue_id):
            continue
        ledger_status, run_id = _normalize(wakeup)
        run_status: str | None = None
        if run_id is not None:
            try:
                run_status = store.get_run(run_id).status
            except KeyError:
                run_status = None
            # Reconcile the wakeup's recorded outcome with the run's LIVE status:
            #   - genuinely executing (created/queued/running/verifying) → running
            #   - paused on a human gate / child delegation → waiting (NOT running,
            #     so the surface never blinks "working" on a gated run)
            # A terminal run keeps the wakeup-derived status (succeeded/failed/…).
            if run_status in _LIVE_RUN_STATUSES:
                ledger_status = LEDGER_STATUS_RUNNING
            elif run_status in _WAITING_RUN_STATUSES:
                ledger_status = LEDGER_STATUS_WAITING
        # Enrich a failed entry with the real reason from evidence (exit_code /
        # timed_out) so "why it failed" is visible; a timeout becomes its own
        # status. Only worth reading for a settled failure with a run.
        timed_out = False
        exit_code: int | None = None
        if run_id is not None and ledger_status == LEDGER_STATUS_FAILED:
            timed_out, exit_code = _failure_enrichment(store, run_id)
            if timed_out:
                ledger_status = LEDGER_STATUS_TIMED_OUT
        active = ledger_status in ACTIVE_LEDGER_STATUSES
        entries.append(
            IssueRunLedgerEntry(
                wakeup_id=wakeup.wakeup_id,
                agent_profile_id=wakeup.agent_profile_id,
                kind=_KIND_BY_PREFIX.get(_reason_prefix(wakeup.reason), "other"),
                reason=wakeup.reason,
                status=ledger_status,
                run_id=run_id,
                run_status=run_status,
                active=active,
                detail=wakeup.detail or "",
                requested_at=wakeup.requested_at,
                claimed_at=wakeup.claimed_at,
                finished_at=wakeup.finished_at,
                timed_out=timed_out,
                exit_code=exit_code,
            )
        )
    # Most recent first — the surface leads with the latest outcome.
    entries.sort(key=lambda e: e.requested_at, reverse=True)
    return IssueRunLedger(issue_id=issue_id, entries=entries)
