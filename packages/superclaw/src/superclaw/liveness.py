"""Run liveness: the single place that decides whether an "in progress" run is real.

A stored ``status`` only records the last persisted phase of a run. Whether the
run is *actually* being worked on must be proven by an unexpired run-mutation
lease whose owner process is still alive. Every surface (CLI, API, Web,
Desktop) derives its "is it running" answer from :func:`effective_run_state`
instead of trusting the stored status string.
"""

from __future__ import annotations

import socket
import time
from typing import Any, TYPE_CHECKING

from superclaw.models import RunStatus, TERMINAL_RUN_STATUSES
from superclaw.proc_compat import pid_is_alive

if TYPE_CHECKING:
    from superclaw.models import ChatSession, RunMutationLease, RunSession

# A persisted run-mutation lease older than this (with no live in-process writer
# holding the runtime lock) is treated as abandoned and is reclaimed, so a
# crashed or hung writer cannot block execute/resume/reconcile indefinitely.
# Executors renew their lease (see RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS),
# so freshness is judged against the latest renewal, not the acquisition time.
RUN_MUTATION_LEASE_TTL_SECONDS = 120.0

# Owners renew at TTL/3 so two consecutive renewals can be missed before the
# lease goes stale; the renewer adds jitter on top of this base interval.
RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS = RUN_MUTATION_LEASE_TTL_SECONDS / 3

# Stored statuses that claim an executor is (or will be) working the run.
EXECUTING_RUN_STATUSES = {RunStatus.RUNNING.value, RunStatus.VERIFYING.value}
PENDING_RUN_STATUSES = {RunStatus.CREATED.value, RunStatus.QUEUED.value}

# The single source of truth for "this run is active" across every surface
# (CLI / API / TUI / daemon). Active = NOT terminal: it is pending, executing,
# or parked at a human gate awaiting attention. Equivalently, every run status
# except completed/failed/cancelled. Surfaces MUST import this rather than
# hand-rolling a status set — divergent literals (a phantom "paused", or a set
# missing "created"/"verifying") have repeatedly drifted the active-run count
# between CLI and API, and a daemon set that dropped the human gate would treat a
# parked run as crashed and double-execute it. A human-gated run is active
# because it still OCCUPIES its issue and needs a person to act. The finer-
# grained PENDING_RUN_STATUSES / EXECUTING_RUN_STATUSES remain available for
# callers that genuinely need that distinction (e.g. lease liveness).
WAITING_RUN_STATUSES = {
    RunStatus.WAITING_FOR_HUMAN_GATE.value,
    RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
}
ACTIVE_RUN_STATUSES = PENDING_RUN_STATUSES | EXECUTING_RUN_STATUSES | WAITING_RUN_STATUSES


def lease_freshness_timestamp(lease: "RunMutationLease") -> float:
    """The instant the lease last proved its owner was alive."""
    return lease.last_renewed_at or lease.acquired_at


def lease_worker_process_is_dead(lease: "RunMutationLease") -> bool:
    if lease.worker_pid is None or lease.worker_pid <= 0:
        return False
    if lease.worker_host and lease.worker_host != socket.gethostname():
        return False
    # NOT os.kill(pid, 0): on Windows that calls TerminateProcess and would kill
    # the lease's worker instead of probing it (see proc_compat).
    return not pid_is_alive(lease.worker_pid)


def lease_stale_reason(lease: "RunMutationLease", *, now: float | None = None) -> str | None:
    if lease_worker_process_is_dead(lease):
        return "worker process is no longer alive"
    if ((now if now is not None else time.time()) - lease_freshness_timestamp(lease)) > RUN_MUTATION_LEASE_TTL_SECONDS:
        return "lease exceeded ttl"
    return None


def effective_run_state(session: "RunSession", *, now: float | None = None) -> dict[str, Any]:
    """Compute the truthful, liveness-backed view of a run.

    Returns a dict with:
    - ``status``: the stored status, unchanged.
    - ``effective_status``: what the run is actually in — equals ``status``
      except for an executing status with no live lease, which reads as failed.
    - ``liveness``: ``terminal`` | ``live`` | ``waiting`` | ``pending`` | ``stale``.
    - ``is_live``: True only when an unexpired lease proves an executor owns the run.
    - ``stale_reason``: why the claim of execution was rejected, when it was.
    """
    status = session.status
    if status in TERMINAL_RUN_STATUSES:
        return _state(status, status, "terminal")
    if status in WAITING_RUN_STATUSES:
        return _state(status, status, "waiting")
    if status in PENDING_RUN_STATUSES:
        return _state(status, status, "pending")
    if status in EXECUTING_RUN_STATUSES:
        lease = session.active_mutation_lease
        if lease is None:
            return _state(status, RunStatus.FAILED.value, "stale", is_live=False, stale_reason="no active mutation lease")
        reason = lease_stale_reason(lease, now=now)
        if reason is not None:
            return _state(status, RunStatus.FAILED.value, "stale", is_live=False, stale_reason=reason)
        return _state(status, status, "live", is_live=True)
    # Unknown stored status: report it untouched but never claim liveness.
    return _state(status, status, "pending")


def _state(
    status: str,
    effective_status: str,
    liveness: str,
    *,
    is_live: bool = False,
    stale_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "effective_status": effective_status,
        "liveness": liveness,
        "is_live": is_live,
        "stale_reason": stale_reason,
    }


# Chat-session activity statuses derived for every surface. A session is only
# ever "live" when a liveness-backed run proves an executor is working it;
# a trailing user message with nothing alive behind it is "interrupted", never
# an implicit forever-pending.
CHAT_ACTIVITY_STATUSES = ("live", "waiting", "pending", "interrupted", "idle")


def chat_session_activity(
    chat_session: "ChatSession",
    linked_runs: list["RunSession"],
    *,
    now: float | None = None,
) -> dict[str, Any]:
    """Derive a chat session's activity from the liveness of its linked runs.

    Messages are a pure transcript: they never carry execution state, so the
    answer comes from the newest linked run (creation order). Sessions whose
    transcript ends in a user message with no run to back it read as
    interrupted with ``legacy_incomplete_tail`` set — the read-side healing for
    turns that died before any assistant reply was recorded.
    """
    messages = chat_session.messages
    tail_is_user = bool(messages) and messages[-1].role == "user"
    latest_run = linked_runs[-1] if linked_runs else None
    if latest_run is None:
        if tail_is_user:
            return _activity(
                "interrupted",
                reason="turn ended without an assistant reply and no run backs it",
                legacy_incomplete_tail=True,
            )
        return _activity("idle")
    state = effective_run_state(latest_run, now=now)
    base = {
        "run_id": latest_run.run_id,
        "effective_run_status": state["effective_status"],
    }
    if state["liveness"] == "live":
        return _activity("live", is_live=True, **base)
    if state["liveness"] == "waiting":
        return _activity("waiting", **base)
    if state["liveness"] == "pending":
        return _activity("pending", **base)
    if state["liveness"] == "stale":
        return _activity("interrupted", reason=state["stale_reason"], **base)
    # Terminal run: the session is settled unless its transcript still dangles.
    if tail_is_user:
        return _activity("interrupted", reason="turn ended without an assistant reply", **base)
    return _activity("idle", **base)


def _activity(
    status: str,
    *,
    is_live: bool = False,
    run_id: str | None = None,
    effective_run_status: str | None = None,
    reason: str | None = None,
    legacy_incomplete_tail: bool = False,
) -> dict[str, Any]:
    return {
        "status": status,
        "is_live": is_live,
        "run_id": run_id,
        "effective_run_status": effective_run_status,
        "reason": reason,
        "legacy_incomplete_tail": legacy_incomplete_tail,
    }
