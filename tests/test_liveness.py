import time

import pytest

from superclaw.liveness import (
    ACTIVE_RUN_STATUSES,
    EXECUTING_RUN_STATUSES,
    PENDING_RUN_STATUSES,
    RUN_MUTATION_LEASE_TTL_SECONDS,
    WAITING_RUN_STATUSES,
    chat_session_activity,
    effective_run_state,
    lease_stale_reason,
)
from superclaw.models import (
    ChatMessage,
    ChatSession,
    GoalSpec,
    RunMutationLease,
    RunMutationMode,
    RunSession,
    RunStatus,
    TERMINAL_RUN_STATUSES,
)
from superclaw.state import StateStore


def test_active_run_statuses_is_the_canonical_non_terminal_attention_set():
    # Active = pending ∪ executing ∪ human-gate; never a terminal status, and
    # NEVER the phantom "paused" literal that drifted into hand-rolled surface
    # sets. This is the single source of truth CLI/API/TUI all import.
    assert ACTIVE_RUN_STATUSES == PENDING_RUN_STATUSES | EXECUTING_RUN_STATUSES | WAITING_RUN_STATUSES
    assert "paused" not in ACTIVE_RUN_STATUSES
    assert ACTIVE_RUN_STATUSES.isdisjoint(TERMINAL_RUN_STATUSES)
    # Every member is a real RunStatus value (no typos / dead literals).
    assert ACTIVE_RUN_STATUSES <= {s.value for s in RunStatus}
    # The human-gated run must stay counted as active (it needs a person).
    assert RunStatus.WAITING_FOR_HUMAN_GATE.value in ACTIVE_RUN_STATUSES
    # A child-delegation wait is also active: no executor is live, but the parent
    # still owns the task until the child result is reviewed/consumed.
    assert RunStatus.WAITING_FOR_CHILD_DELEGATION.value in ACTIVE_RUN_STATUSES


def _lease(run_id: str, **overrides) -> RunMutationLease:
    fields = {
        "resource": f"run:{run_id}",
        "owner": f"execute:{run_id}",
        "mode": RunMutationMode.EXECUTE,
        "worker_pid": None,
        "worker_host": None,
    }
    fields.update(overrides)
    return RunMutationLease(**fields)


def _session(status: str, lease: RunMutationLease | None = None) -> RunSession:
    session = RunSession(goal_id="goal_x", status=status)
    session.active_mutation_lease = lease
    return session


def test_terminal_statuses_are_never_live():
    for status in ("completed", "failed", "cancelled"):
        state = effective_run_state(_session(status, _lease("r1")))
        assert state["is_live"] is False
        assert state["liveness"] == "terminal"
        assert state["effective_status"] == status


def test_waiting_for_human_gate_is_waiting_not_live():
    state = effective_run_state(_session(RunStatus.WAITING_FOR_HUMAN_GATE.value))
    assert state["liveness"] == "waiting"
    assert state["is_live"] is False
    assert state["effective_status"] == RunStatus.WAITING_FOR_HUMAN_GATE.value


def test_waiting_for_child_delegation_is_waiting_not_live():
    state = effective_run_state(_session(RunStatus.WAITING_FOR_CHILD_DELEGATION.value))
    assert state["liveness"] == "waiting"
    assert state["is_live"] is False
    assert state["effective_status"] == RunStatus.WAITING_FOR_CHILD_DELEGATION.value


def test_created_and_queued_are_pending_not_live():
    for status in ("created", "queued"):
        state = effective_run_state(_session(status))
        assert state["liveness"] == "pending"
        assert state["is_live"] is False
        assert state["effective_status"] == status


def test_running_with_fresh_lease_is_live():
    state = effective_run_state(_session("running", _lease("r1")))
    assert state["is_live"] is True
    assert state["liveness"] == "live"
    assert state["effective_status"] == "running"
    assert state["stale_reason"] is None


def test_running_without_lease_reads_as_failed():
    state = effective_run_state(_session("running"))
    assert state["is_live"] is False
    assert state["liveness"] == "stale"
    assert state["effective_status"] == "failed"
    assert state["stale_reason"] == "no active mutation lease"


def test_running_with_expired_lease_reads_as_failed():
    stale = _lease("r1", acquired_at=time.time() - (RUN_MUTATION_LEASE_TTL_SECONDS + 60))
    state = effective_run_state(_session("verifying", stale))
    assert state["is_live"] is False
    assert state["liveness"] == "stale"
    assert state["effective_status"] == "failed"
    assert state["stale_reason"] == "lease exceeded ttl"


def test_renewal_keeps_long_run_live_past_acquisition_ttl():
    lease = _lease(
        "r1",
        acquired_at=time.time() - (RUN_MUTATION_LEASE_TTL_SECONDS * 5),
        last_renewed_at=time.time(),
    )
    assert lease_stale_reason(lease) is None
    state = effective_run_state(_session("running", lease))
    assert state["is_live"] is True


def test_dead_worker_process_marks_lease_stale():
    # PID 1 belongs to launchd/init, never to us; a PID that cannot exist is the
    # portable way to simulate a dead worker.
    lease = _lease("r1", worker_pid=2**22 + 1)
    state = effective_run_state(_session("running", lease))
    assert state["is_live"] is False
    assert state["stale_reason"] == "worker process is no longer alive"


def _chat(messages: list[tuple[str, str]]) -> ChatSession:
    session = ChatSession(title="t")
    for role, content in messages:
        session.append(ChatMessage(role=role, content=content))  # type: ignore[arg-type]
    return session


def test_chat_activity_empty_session_is_idle():
    activity = chat_session_activity(_chat([]), [])
    assert activity["status"] == "idle"
    assert activity["is_live"] is False


def test_chat_activity_dangling_user_tail_without_run_is_interrupted_legacy():
    activity = chat_session_activity(_chat([("user", "你是什么模型")]), [])
    assert activity["status"] == "interrupted"
    assert activity["legacy_incomplete_tail"] is True
    assert activity["is_live"] is False


def test_chat_activity_follows_latest_run_liveness():
    live_run = _session("running", _lease("r1"))
    activity = chat_session_activity(_chat([("user", "go")]), [live_run])
    assert activity["status"] == "live"
    assert activity["is_live"] is True

    dead_run = _session("running")
    activity = chat_session_activity(_chat([("user", "go")]), [dead_run])
    assert activity["status"] == "interrupted"
    assert activity["reason"] == "no active mutation lease"


def test_chat_activity_terminal_run_with_assistant_tail_is_idle():
    done = _session("completed")
    activity = chat_session_activity(_chat([("user", "go"), ("assistant", "done")]), [done])
    assert activity["status"] == "idle"
    assert activity["is_live"] is False


def test_chat_activity_terminal_run_with_user_tail_is_interrupted():
    failed = _session("failed")
    activity = chat_session_activity(_chat([("user", "go")]), [failed])
    assert activity["status"] == "interrupted"
    assert activity["legacy_incomplete_tail"] is False


def _store_with_running_run(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="liveness", description="renewal"))
    session = RunSession(goal_id=goal.goal_id)
    store.save_run(session)
    return store, session


def test_renew_run_mutation_lease_bumps_freshness(tmp_path):
    store, session = _store_with_running_run(tmp_path)
    lease = store.acquire_run_mutation_lease(session.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    assert lease.last_renewed_at is None

    renewed = store.renew_run_mutation_lease(session.run_id, lease_id=lease.lease_id, owner=lease.owner)
    assert renewed.last_renewed_at is not None

    persisted = store.get_run(session.run_id).active_mutation_lease
    assert persisted is not None
    assert persisted.last_renewed_at == pytest.approx(renewed.last_renewed_at)


def test_renew_run_mutation_lease_fails_closed_on_lost_lease(tmp_path):
    store, session = _store_with_running_run(tmp_path)
    store.acquire_run_mutation_lease(session.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)

    with pytest.raises(ValueError, match="lease mismatch"):
        store.renew_run_mutation_lease(session.run_id, lease_id="runlease_not_mine", owner="execute:test")


def test_lease_renewer_thread_keeps_bumping_freshness(tmp_path, monkeypatch):
    import superclaw.orchestrator as orchestrator_module

    store, session = _store_with_running_run(tmp_path)
    lease = store.acquire_run_mutation_lease(session.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    monkeypatch.setattr(orchestrator_module, "RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS", 0.05)

    renewer = orchestrator_module.RunMutationLeaseRenewer(store, session.run_id, lease).start()
    try:
        deadline = time.time() + 5.0
        while time.time() < deadline:
            persisted = store.get_run(session.run_id).active_mutation_lease
            if persisted is not None and persisted.last_renewed_at is not None:
                break
            time.sleep(0.02)
    finally:
        renewer.stop()

    persisted = store.get_run(session.run_id).active_mutation_lease
    assert persisted is not None
    assert persisted.last_renewed_at is not None
    assert effective_run_state(_session("running", persisted))["is_live"] is True


def test_lease_renewer_thread_stops_after_lease_is_lost(tmp_path, monkeypatch):
    import superclaw.orchestrator as orchestrator_module

    store, session = _store_with_running_run(tmp_path)
    lease = store.acquire_run_mutation_lease(session.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    store.release_run_mutation_lease(session.run_id, lease_id=lease.lease_id, owner=lease.owner)
    taken_over = store.acquire_run_mutation_lease(session.run_id, owner="reconcile:other", mode=RunMutationMode.RECONCILE)
    monkeypatch.setattr(orchestrator_module, "RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS", 0.05)

    renewer = orchestrator_module.RunMutationLeaseRenewer(store, session.run_id, lease).start()
    time.sleep(0.3)
    renewer.stop()

    persisted = store.get_run(session.run_id).active_mutation_lease
    assert persisted is not None
    assert persisted.lease_id == taken_over.lease_id
    assert persisted.last_renewed_at is None  # the dead owner never renewed the new lease
