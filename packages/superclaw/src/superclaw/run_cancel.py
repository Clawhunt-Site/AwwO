"""Store-portable run cancellation — the single source for "cancel a run".

Cancelling a run is essentially a DURABLE operation: flip the run's status to
``cancelled`` and record the event; the live worker (in whatever process) polls
its own status and stops when it sees ``cancelled``. Because that core is
store-only, this function works from ANY caller that holds a ``StateStore`` —
including the A-class MCP proxy subprocess, which has no in-process orchestrator
and so could not previously stop a run.

``SuperClawOrchestrator.cancel_run`` delegates here for the store-essential work
and layers its IN-PROCESS refinements on top (a thread-aliveness-aware event
detail, and the child-evidence sync safety net). The company issue-tree commands
(``issue.tree_pause`` / ``issue.tree_cancel``) build their ``run_canceller`` from
THIS function inside the kernel dispatcher, so every surface — chat (B-class),
A-class proxy, CLI, REST, and the grant-time apply path — cancels runs the SAME
way, with no second implementation to drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from superclaw.models import TERMINAL_RUN_STATUSES, RunStatus

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from superclaw.state import StateStore


@dataclass
class CancelResult:
    run_id: str
    previous_status: str
    status: str
    event_type: str
    accepted: bool
    detail: str


def cancel_run_in_store(
    store: "StateStore", run_id: str, *, active_thread: bool = False, recurse: bool = True
) -> CancelResult:
    """Cancel ``run_id`` durably (status flip + event) and propagate to child runs.

    Idempotent / fail-soft on an already-terminal run (returns ``accepted=False``
    with a ``run.cancel.ignored`` event, never an exception for an
    already-done run — but a genuinely missing run still raises ``KeyError`` from
    ``get_run`` so a corrupt reference is not silently swallowed).

    ``active_thread`` is an OPTIONAL hint from a caller that CAN see the worker
    thread (the orchestrator): it only selects the event type
    (``run.cancel.requested`` when a worker is still alive vs ``run.cancelled``
    when not) — the cancellation itself is identical either way. A store-only
    caller leaves it ``False`` (it cannot inspect the worker thread), so the event
    is recorded as ``run.cancelled``; the status flip still stops a live worker
    when it next polls.

    ``recurse`` (default True) cancels linked child runs
    (``session.child_executions``) so a cancelled parent never leaves orphaned
    children running — store-only, so it works from every caller. The orchestrator
    passes ``recurse=False`` because it does its OWN per-child recursion via
    ``cancel_run`` (which additionally runs the in-process child-evidence sync that
    a store-only caller cannot), preserving its exact prior behavior; the
    store-portable callers (company tree commands / A-class proxy) use the built-in
    recursion (a whole-subtree pause/cancel terminates every child, so the
    per-child evidence sync is not on the critical path — see the design note).
    """
    session = store.get_run(run_id)  # KeyError -> unknown run (fail-closed)
    previous_status = session.status
    if previous_status in TERMINAL_RUN_STATUSES - {RunStatus.CANCELLED.value}:
        detail = f"run already reached terminal status {previous_status}"
        store.add_event(
            run_id,
            "run.cancel.ignored",
            {"run_id": run_id, "previous_status": previous_status, "status": session.status, "detail": detail},
        )
        return CancelResult(
            run_id=run_id,
            previous_status=previous_status,
            status=session.status,
            event_type="run.cancel.ignored",
            accepted=False,
            detail=detail,
        )

    session.status = RunStatus.CANCELLED.value
    store.save_run(session)
    event_type = "run.cancel.requested" if active_thread else "run.cancelled"
    detail = (
        "cancellation requested for active run"
        if active_thread
        else "run cancelled without active worker"
    )
    store.add_event(
        run_id,
        event_type,
        {"run_id": run_id, "previous_status": previous_status, "status": session.status, "detail": detail},
    )

    if not recurse:
        return CancelResult(
            run_id=run_id,
            previous_status=previous_status,
            status=session.status,
            event_type=event_type,
            accepted=True,
            detail=detail,
        )

    for child in getattr(session, "child_executions", []) or []:
        child_run_id = getattr(child, "child_run_id", None)
        if not child_run_id:
            continue
        try:
            child_session = store.get_run(child_run_id)
        except KeyError:
            continue
        if child_session.status in TERMINAL_RUN_STATUSES:
            continue
        cancel_run_in_store(store, child_run_id)
        store.add_event(
            run_id,
            "run.cancel.propagated",
            {
                "run_id": run_id,
                "child_run_id": child_run_id,
                "child_task_id": getattr(child, "child_task_id", None),
            },
        )

    return CancelResult(
        run_id=run_id,
        previous_status=previous_status,
        status=session.status,
        event_type=event_type,
        accepted=True,
        detail=detail,
    )
