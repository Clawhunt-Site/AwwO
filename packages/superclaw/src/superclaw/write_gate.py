"""Process-level maintenance write gate — B4 全局写冻结的「种子」(seed).

This module is the **in-process seed** of contract B4's *maintenance gate / 全局
写冻结*: a single guard primitive — :func:`assert_writes_allowed` — that every
deepest write sink calls *before* it actually mutates persistent state. When a
maintenance window is active, that guard hard-refuses (`WritesFrozenError`,
503-ish semantics) so the kernel cannot have its ledger / run-state / governance
objects mutate underneath an in-flight cutover/migration. See
``docs/company-chat-management-design.md`` (section B4).

What this PR (PR-A.5) IS — the seed, default OFF, zero behavior change
---------------------------------------------------------------------
  * The guard primitive (:func:`assert_writes_allowed`), the maintenance
    on/off switch (:func:`maintenance_window` / :func:`is_writes_frozen`), and
    a migrator escape hatch (:func:`allow_writes_during_maintenance`).
  * The guard is sunk into ``state.py``'s deepest write sinks (``save_run`` /
    ``_save_run_in_transaction`` / ``save_approval`` / ``resolve_escalation`` /
    ``save_issue`` / ``save_company_profile`` / ``save_agent_profile`` /
    ``save_workspace_profile`` / ``ensure_company_membership`` /
    ``save_issue_interaction`` / ``save_issue_hold``) so *all* surfaces
    (API / CLI / TUI / daemon / orchestrator-internal / direct kernel calls)
    are covered at one choke point rather than at each door.
  * **No maintenance window is ever entered in this PR.** With no window active
    the guard is a strict no-op, so every existing write path behaves exactly as
    before. Existing tests must stay green — that green *is* the
    "default-OFF / zero behavior change" proof.

What is explicitly NOT in this PR — that is PR-B (cutover)
----------------------------------------------------------
  * The actual cutover *sequence* (enter maintenance → drain in-flight
    transactions → single-transaction migration with pending-conservation
    asserts → flip the new ledger → forward old IDs idempotently → exit).
  * **Cross-process freezing.** The switch here is a single *process-local*
    flag (this repo is single-machine, but a freeze must hold across the daemon
    and any independent CLI process during a real cutover). Propagating the
    freeze across processes is PR-B's responsibility; this seed only provides
    the in-process mechanism + the sink wiring it rides on.

B4 contract reminders honored by this seed
------------------------------------------
  * **纯硬拒绝 (pure hard refusal):** a frozen write raises immediately. It is
    NEVER queued, cached, or retried in the background — queuing would replay
    stale semantics past the cutover and corrupt idempotency/audit.
  * **Migrator escape hatch:** the migration that runs *inside* the maintenance
    window must itself be allowed to write (otherwise it freezes itself). PR-B's
    migrator wraps its single transaction in
    :func:`allow_writes_during_maintenance`; nothing else may use it. The hatch
    is thread-local so it never leaks the freeze-exemption to a concurrent
    worker thread.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator

__all__ = [
    "WritesFrozenError",
    "is_writes_frozen",
    "maintenance_window",
    "assert_writes_allowed",
    "allow_writes_during_maintenance",
]


class WritesFrozenError(RuntimeError):
    """Raised when a write is attempted during a maintenance window.

    A :class:`RuntimeError` subclass — *not* a :class:`ValueError` — because a
    frozen write is not bad user input; it is a transient *system maintenance*
    state (maps to 503-ish ``MAINTENANCE_IN_PROGRESS`` semantics: the caller
    should fail-closed and retry after the cutover, never have its write queued
    or replayed). ``operation`` is the name of the sink that was refused (for
    diagnostics / audit); ``reason`` is the maintenance window's reason.
    """

    def __init__(self, *, operation: str = "", reason: str = "") -> None:
        self.operation = operation
        self.reason = reason
        detail = operation or "write"
        suffix = f" ({reason})" if reason else ""
        super().__init__(
            f"writes are frozen for maintenance — refused: {detail}{suffix}"
        )


# Process-local maintenance state. A single switch is sufficient for this
# single-machine repo (cross-process freeze is PR-B). The lock guards every
# read/write of the shared counter/reason because the daemon and worker
# subprocesses run threads concurrently.
_LOCK = threading.RLock()
_DEPTH = 0  # re-entrant: number of active (possibly nested) maintenance windows.
_REASON = ""  # reason of the innermost-entered window, surfaced on refusals.

# Thread-local migrator escape hatch. Stored per-thread so a window opened on
# one thread never silently exempts an unrelated worker thread.
_HATCH = threading.local()


def _hatch_active() -> bool:
    return getattr(_HATCH, "depth", 0) > 0


def is_writes_frozen() -> bool:
    """True iff a maintenance window is currently active in THIS process.

    Note this reports the raw window state; it does NOT account for the
    migrator escape hatch. :func:`assert_writes_allowed` is the function that
    combines both (frozen AND not exempt → refuse).
    """
    with _LOCK:
        return _DEPTH > 0


@contextmanager
def maintenance_window(reason: str) -> Iterator[None]:
    """Freeze all guarded writes for the duration of this context.

    Re-entrant: nested windows increment a depth counter, so exiting an inner
    window leaves the freeze in place and only exiting the outermost window
    thaws. On exit (normal OR exceptional) the prior state is always restored —
    the depth is decremented in a ``finally`` and never hard-set to zero/false,
    so a window nested inside another cannot prematurely thaw it.

    Process-local only (single-machine seed); cross-process propagation is PR-B.
    """
    global _DEPTH, _REASON
    with _LOCK:
        _DEPTH += 1
        prev_reason = _REASON
        _REASON = reason
    try:
        yield
    finally:
        with _LOCK:
            _DEPTH -= 1
            # Restore the reason to whatever the enclosing window had (or "").
            _REASON = prev_reason if _DEPTH > 0 else ""


@contextmanager
def allow_writes_during_maintenance() -> Iterator[None]:
    """Migrator-only escape hatch: permit writes inside an active window.

    The single-transaction migration of PR-B runs *inside* the maintenance
    window, so without this seam the migrator would freeze itself. Wrapping its
    work in this context makes :func:`assert_writes_allowed` pass on the current
    thread while the freeze stays in force for every other writer.

    **Only the cutover migrator may use this.** It is thread-local (never leaks
    to a concurrent worker thread) and re-entrant (nested uses restore on exit).
    """
    depth = getattr(_HATCH, "depth", 0)
    _HATCH.depth = depth + 1
    try:
        yield
    finally:
        _HATCH.depth = getattr(_HATCH, "depth", 1) - 1


def assert_writes_allowed(operation: str = "") -> None:
    """Refuse the write if a maintenance window is active (unless exempt).

    No-op when no window is active (the default — this is what keeps every
    existing write path unchanged). Inside a window it raises
    :class:`WritesFrozenError` unless the calling thread holds the migrator
    escape hatch (:func:`allow_writes_during_maintenance`). ``operation`` is the
    sink name, attached to the error for diagnostics.
    """
    # Hatch check is thread-local and lock-free; if exempt, never even read the
    # shared window state.
    if _hatch_active():
        return
    with _LOCK:
        if _DEPTH > 0:
            reason = _REASON
        else:
            return
    raise WritesFrozenError(operation=operation, reason=reason)
