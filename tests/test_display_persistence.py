"""PR-4 run-channel persistence: snapshot read, safe-write, lease event split.

Locks the StateStore changes that make the canonical display events durable
without letting an events-table failure break the run flow (DL8 safe-write) and
without flooding readers with raw deltas (A2 snapshot read).
"""
from __future__ import annotations

import pytest

from superclaw.models import GoalSpec, RunMutationMode
from superclaw.state import StateStore


def _store_with_run(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Display", description="persistence"))
    run = store.create_run(goal.goal_id)
    return store, run


# --- snapshot read (A2 / T4) ------------------------------------------------


def test_list_events_snapshot_excludes_deltas_and_carries_id(tmp_path):
    store, run = _store_with_run(tmp_path)
    store.add_event(run.run_id, "tool.started", {"k": 1})
    store.add_event(run.run_id, "tool.delta", {"chunk": "x"})
    store.add_event(run.run_id, "reasoning.delta", {"text": "y"})
    store.add_event(run.run_id, "message.delta", {"text": "z"})
    store.add_event(run.run_id, "tool.completed", {"k": 2})
    store.add_event(run.run_id, "run.completed", {"ok": True})

    snapshot = store.list_events_snapshot(run.run_id)
    types = [e["type"] for e in snapshot]
    assert types == ["tool.started", "tool.completed", "run.completed"]  # deltas excluded
    # Every snapshot row carries the durable SQLite id, ascending.
    ids = [e["id"] for e in snapshot]
    assert all(isinstance(i, int) for i in ids)
    assert ids == sorted(ids)
    # The full live read still includes the deltas (only the live SSE uses it).
    assert any(e["type"] == "tool.delta" for e in store.list_events_after(run.run_id, 0))


def test_list_events_snapshot_empty_for_unknown_run(tmp_path):
    store, _run = _store_with_run(tmp_path)
    assert store.list_events_snapshot("no-such-run") == []


# --- safe-write (DL8 / U1) --------------------------------------------------


def test_add_event_is_best_effort_and_does_not_raise(tmp_path, monkeypatch):
    store, run = _store_with_run(tmp_path)

    def _boom(*_a, **_k):
        raise RuntimeError("events table is on fire")

    monkeypatch.setattr(store, "_add_event_in_transaction", _boom)
    before = store._event_write_failures
    # Must NOT raise — a run path can never crash because events is unwritable.
    store.add_event(run.run_id, "tool.started", {"k": 1})
    assert store._event_write_failures == before + 1
    # The run itself is still readable (run health is decoupled from events).
    assert store.get_run(run.run_id).run_id == run.run_id


# --- lease event split (U1-deep): state commits even if event write fails ---


def test_lease_acquire_commits_state_even_when_event_write_fails(tmp_path, monkeypatch):
    store, run = _store_with_run(tmp_path)

    def _boom(*_a, **_k):
        raise RuntimeError("events table is on fire")

    # The lease STATE write goes through _save_run_in_transaction (untouched); the
    # audit event now goes through best-effort add_event (-> _add_event_in_transaction).
    monkeypatch.setattr(store, "_add_event_in_transaction", _boom)
    lease = store.acquire_run_mutation_lease(run.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    # Lease was acquired despite the audit-event write failing (not rolled back).
    assert store.get_run(run.run_id).active_mutation_lease is not None
    assert store.get_run(run.run_id).active_mutation_lease.lease_id == lease.lease_id
    assert store._event_write_failures >= 1


def test_lease_acquire_and_release_emit_audit_events(tmp_path):
    store, run = _store_with_run(tmp_path)
    lease = store.acquire_run_mutation_lease(run.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    store.release_run_mutation_lease(run.run_id, lease_id=lease.lease_id, owner="execute:test")
    types = [e["type"] for e in store.list_events_snapshot(run.run_id)]
    assert "run.lease.acquired" in types
    assert "run.lease.released" in types
    # Released: lease cleared.
    assert store.get_run(run.run_id).active_mutation_lease is None


def test_lease_release_mismatch_records_rejected_and_raises(tmp_path):
    store, run = _store_with_run(tmp_path)
    store.acquire_run_mutation_lease(run.run_id, owner="execute:test", mode=RunMutationMode.EXECUTE)
    with pytest.raises(ValueError):
        store.release_run_mutation_lease(run.run_id, lease_id="wrong-id", owner="execute:test")
    # The mismatch is audited (best-effort, outside the txn) and the lease stays.
    types = [e["type"] for e in store.list_events_snapshot(run.run_id)]
    assert "run.lease.release_rejected" in types
    assert store.get_run(run.run_id).active_mutation_lease is not None
