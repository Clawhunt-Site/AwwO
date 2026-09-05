"""Maintenance write gate — B4 seed (process-local freeze + deepest-sink wiring).

See docs/company-chat-management-design.md (contract B4).
"""

from __future__ import annotations

import threading

import pytest

from superclaw.models import CompanyProfile, Issue
from superclaw.state import StateStore
from superclaw.write_gate import (
    WritesFrozenError,
    allow_writes_during_maintenance,
    assert_writes_allowed,
    is_writes_frozen,
    maintenance_window,
)


def test_default_off_is_noop():
    # The default (no window) MUST be a strict no-op — this is the zero-behavior-
    # change guarantee that keeps every existing write path unchanged.
    assert is_writes_frozen() is False
    assert_writes_allowed("anything")  # no raise


def test_window_freezes_then_restores():
    assert is_writes_frozen() is False
    with maintenance_window("cutover"):
        assert is_writes_frozen() is True
        with pytest.raises(WritesFrozenError) as exc:
            assert_writes_allowed("save_run")
        assert exc.value.operation == "save_run"
        assert "cutover" in str(exc.value)
    # Restored after the window.
    assert is_writes_frozen() is False
    assert_writes_allowed("save_run")


def test_window_restores_on_exception():
    with pytest.raises(RuntimeError):
        with maintenance_window("boom"):
            assert is_writes_frozen() is True
            raise RuntimeError("boom")
    # Even an exception inside the window must thaw on exit (finally).
    assert is_writes_frozen() is False


def test_reentrant_inner_exit_keeps_frozen():
    with maintenance_window("outer"):
        with maintenance_window("inner"):
            assert is_writes_frozen() is True
        # Exiting the inner window must NOT thaw — only the outermost does.
        assert is_writes_frozen() is True
    assert is_writes_frozen() is False


def test_migrator_hatch_allows_writes_inside_window():
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            assert_writes_allowed("save_issue")
        with allow_writes_during_maintenance():
            assert_writes_allowed("migration_write")  # no raise
        # Hatch closed → frozen again.
        with pytest.raises(WritesFrozenError):
            assert_writes_allowed("save_issue")


def test_hatch_is_thread_local():
    # The migrator hatch on the main thread must NOT exempt a concurrent worker.
    results: dict[str, object] = {}

    def worker():
        try:
            assert_writes_allowed("worker_write")
            results["worker"] = "allowed"
        except WritesFrozenError:
            results["worker"] = "frozen"

    with maintenance_window("cutover"):
        with allow_writes_during_maintenance():
            t = threading.Thread(target=worker)
            t.start()
            t.join()
    # The worker thread never held the hatch, so it must still see the freeze.
    assert results["worker"] == "frozen"


# --- deepest-sink wiring: the guard actually reaches state.py writes ---------


def test_company_profile_write_is_gated(tmp_path):
    store = StateStore(tmp_path / "s.db")
    company = CompanyProfile(name="Acme")
    # Outside a window the write succeeds.
    store.save_company_profile(company)
    # Inside a window the SAME write is refused at the state sink.
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.save_company_profile(CompanyProfile(name="Beta"))
    # And succeeds again after the window.
    store.save_company_profile(CompanyProfile(name="Gamma"))


def test_issue_write_is_gated(tmp_path):
    store = StateStore(tmp_path / "s.db")
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.save_issue(Issue(title="t"))
    # Succeeds outside the window.
    store.save_issue(Issue(title="t2"))


def test_run_write_is_gated(tmp_path):
    from superclaw.models import GoalSpec

    store = StateStore(tmp_path / "s.db")
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    run = store.create_run(goal.goal_id)
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.save_run(run)


def test_create_run_is_gated_at_entry(tmp_path):
    # create_run is itself a public run-creation mutation entry: it must fail
    # closed at its own first statement under freeze, not merely rely on the
    # save_run it delegates to. This locks the gate in directly rather than via
    # the coverage scanner (which only flagged create_run incidentally because a
    # comment contained the word "insert").
    from superclaw.models import GoalSpec

    store = StateStore(tmp_path / "s.db")
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError) as exc:
            store.create_run(goal.goal_id)
        assert exc.value.operation == "create_run"
        # The migrator hatch still lets a legitimate create_run through.
        with allow_writes_during_maintenance():
            run = store.create_run(goal.goal_id)
        assert run.goal_id == goal.goal_id
    # Succeeds outside the window.
    store.create_run(goal.goal_id)


# --- newly wired sinks (PR-A.5 carpet wiring): a representative sample. The
# architecture test in test_write_gate_coverage.py guarantees the FULL surface;
# these prove the guard truly reaches a few of the previously-ungated sinks and
# fires *before* any of their own validation (it is the first statement). ----


def test_create_goal_is_gated(tmp_path):
    from superclaw.models import GoalSpec

    store = StateStore(tmp_path / "s.db")
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.create_goal(GoalSpec(title="g", description="d"))
    # Succeeds outside the window.
    store.create_goal(GoalSpec(title="g2", description="d2"))


def test_save_work_product_is_gated(tmp_path):
    from superclaw.models import WorkProduct

    store = StateStore(tmp_path / "s.db")
    wp = WorkProduct(issue_id="i1", type="artifact")
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.save_work_product(wp)


def test_save_delegated_child_is_gated(tmp_path):
    store = StateStore(tmp_path / "s.db")
    # The guard is the first statement, so it fires before parent validation —
    # a minimal child + arbitrary parent_id is enough to exercise the freeze.
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.save_delegated_child(Issue(title="child"), parent_id="p1")


def test_add_issue_comment_is_gated(tmp_path):
    from superclaw.models import IssueComment

    store = StateStore(tmp_path / "s.db")
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.add_issue_comment(IssueComment(issue_id="i1", body="hi"))


def test_add_event_freeze_propagates_not_swallowed(tmp_path):
    # add_event is best-effort and swallows DB Exceptions, but the maintenance
    # freeze must NOT be silently swallowed — the guard sits before the try/except
    # so WritesFrozenError propagates (the freeze can't be bypassed via events).
    store = StateStore(tmp_path / "s.db")
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            store.add_event("run-x", "test", {})


# --- constructor / schema write face is frozen too (B4: whole _init gated) ---


def test_store_construction_frozen_without_hatch(tmp_path):
    # Building a StateStore inside a maintenance window WITHOUT the migrator hatch
    # must fail closed — the entire _init write face (journal_mode + CREATE TABLE
    # schema + the instance_user_roles governance seed) is behind one guard.
    db = tmp_path / "frozen.db"
    with maintenance_window("cutover"):
        with pytest.raises(WritesFrozenError):
            StateStore(db)


def test_store_construction_allowed_under_migrator_hatch(tmp_path):
    # The cutover migrator opens the new store under allow_writes_during_maintenance();
    # construction must succeed there even though a window is active.
    db = tmp_path / "migrated.db"
    with maintenance_window("cutover"):
        with allow_writes_during_maintenance():
            store = StateStore(db)  # no raise
    assert store.schema_version() == StateStore.SCHEMA_VERSION


def test_store_construction_normal_when_no_window(tmp_path):
    # The default path (no window) is a strict no-op — construction unaffected.
    StateStore(tmp_path / "normal.db")
