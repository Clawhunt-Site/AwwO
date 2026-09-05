"""Robustness (Paperclip-native): an issue is never permanently stranded
``in_progress`` behind a workspace/issue checkout lock that no live run backs.

A crash/restart between checkout and run-anchor can leak a ``workspace:`` /
``issue:`` lock (no TTL): the issue stays ``in_progress`` and every later
checkout of that workspace defers ``workspace already locked`` (observed: a 42h
leak). The reaper reaps the TRUE orphan by RUN LIVENESS (not a duration cap),
continuously (startup + every scheduler cycle), and re-drives the issue. It must
NEVER touch ``agent:`` locks, active occupants, terminal wreckage (no-burn),
persisted-but-unanchored runs, or operator/CLI locks.
"""

from __future__ import annotations

import types

import pytest

from superclaw.daemon import HeartbeatDaemon
from superclaw.models import (
    AgentProfile,
    AgentWakeupRequest,
    CompanyProfile,
    Issue,
    IssueStatus,
)
from superclaw.state import StateStore

GRACE = HeartbeatDaemon._STALE_CHECKOUT_GRACE_SECONDS


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _daemon(store, tmp_path):
    return HeartbeatDaemon(
        store,
        types.SimpleNamespace(reconcile_stale_runs=lambda **k: []),
        repo_path=tmp_path,
        artifact_dir=tmp_path / "a",
    )


def _agent(store):
    cid = store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id
    return store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", backend_policy="local", company_profile_id=cid)
    )


def _run(status, *, ec):
    return types.SimpleNamespace(status=status, execution_context=ec)


def _checked_out_issue(store, profile, *, wakeup_id, lock_key="workspace:local", acquired_at=0.0):
    """Materialize a real checked-out issue: a wakeup-backed lock + an
    in_progress issue pinned to that wakeup/lock, exactly as kernel checkout
    leaves it. ``wakeup_id`` must exist in the wakeup table so the reaper does
    NOT treat it as an operator lock."""
    # The lock's run_id IS the spawning wakeup id; register that wakeup so the
    # reaper's operator-exemption (get_wakeup is None) does not fire.
    store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id=profile.profile_id, wakeup_id=wakeup_id,
                           company_profile_id=profile.company_profile_id, source="on_demand",
                           reason="checkout")
    )
    issue = store.save_issue(
        Issue(title="t", workspace_id=profile.workspace_id,
              company_profile_id=profile.company_profile_id,
              assignee_agent_profile_id=profile.profile_id, status=IssueStatus.TODO.value)
    )
    store.acquire_workspace_lock(lock_key, workspace_id=profile.workspace_id,
                                 holder=profile.profile_id, issue_id=issue.issue_id,
                                 run_id=wakeup_id)
    # Mutate the lock's acquired_at so grace tests can control staleness.
    lock = store.get_workspace_lock(lock_key)
    lock.acquired_at = acquired_at
    # Re-persist via a raw write path: release + re-acquire would change run_id,
    # so reach into the store connection to overwrite the payload in place.
    import json

    with store._connect() as conn:
        conn.execute("UPDATE workspace_locks SET payload = ? WHERE lock_key = ?",
                     (json.dumps(lock.to_dict(), ensure_ascii=False), lock_key))
    issue.status = IssueStatus.IN_PROGRESS.value
    issue.checkout_run_id = wakeup_id
    issue.execution_run_id = wakeup_id
    issue.lock_key = lock_key
    store.commit_checkout(issue)
    return store.get_issue(issue.issue_id)


# --------------------------------------------------------------------------- #
# True-orphan reclaim                                                          #
# --------------------------------------------------------------------------- #


def test_reclaims_a_true_orphan_checkout(store, tmp_path):
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: []  # the spawning run no longer exists → orphan
    n = d.reclaim_stale_workspace_locks(now=GRACE + 1)
    assert n == 1
    # Lock freed, issue back to todo + pins cleared.
    assert store.get_workspace_lock("workspace:local") is None
    reset = store.get_issue(issue.issue_id)
    assert reset.status == IssueStatus.TODO.value
    assert reset.checkout_run_id is None and reset.execution_run_id is None
    assert reset.lock_key is None
    # A single retry wakeup was enqueued to re-drive the work.
    retries = [w for w in store.list_wakeups(status="queued")
               if w.reason == f"reclaimed_orphan_checkout:{issue.issue_id}"]
    assert len(retries) == 1
    assert retries[0].agent_profile_id == eng.profile_id


def test_issue_prefixed_lock_is_also_in_scope(store, tmp_path):
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD", lock_key="issue:abc")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: []
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 1
    assert store.get_workspace_lock("issue:abc") is None
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value


# --------------------------------------------------------------------------- #
# Skips: associated run / wreckage / operator / grace / fail-closed           #
# --------------------------------------------------------------------------- #


def test_does_not_reclaim_when_a_run_carries_the_wakeup_id(store, tmp_path):
    eng = _agent(store)
    _checked_out_issue(store, eng, wakeup_id="wake_LIVE")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec={"wakeup_id": "wake_LIVE"})]
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_does_not_reclaim_when_a_run_carries_the_issue_id(store, tmp_path):
    # Persisted-but-not-yet-anchored: a run references the issue_id (no wakeup_id
    # stamped yet) → still associated → skip.
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("created", ec={"issue_id": issue.issue_id})]
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_does_not_reclaim_terminal_wreckage(store, tmp_path):
    # no-burn: a FAILED run still references the wakeup → its lock is left so the
    # failed work is never silently re-driven.
    eng = _agent(store)
    _checked_out_issue(store, eng, wakeup_id="wake_FAILED")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("failed", ec={"wakeup_id": "wake_FAILED"})]
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_does_not_reclaim_an_operator_lock(store, tmp_path):
    # An operator/CLI checkout's lock holds run_id == run_* (NOT a wakeup) → out of
    # scope: get_wakeup(run_id) is None → skip.
    eng = _agent(store)
    issue = store.save_issue(
        Issue(title="t", workspace_id=eng.workspace_id, company_profile_id=eng.company_profile_id,
              assignee_agent_profile_id=eng.profile_id, status=IssueStatus.TODO.value)
    )
    store.acquire_workspace_lock("workspace:local", workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, issue_id=issue.issue_id, run_id="run_operator")
    issue.status = IssueStatus.IN_PROGRESS.value
    issue.checkout_run_id = "run_operator"
    issue.execution_run_id = "run_operator"
    issue.lock_key = "workspace:local"
    store.commit_checkout(issue)
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: []
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_grace_protects_a_freshly_acquired_lock(store, tmp_path):
    eng = _agent(store)
    _checked_out_issue(store, eng, wakeup_id="wake_DEAD", acquired_at=100.0)
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: []
    # now within grace of acquired_at → NOT reaped (run may still be establishing).
    assert d.reclaim_stale_workspace_locks(now=100.0 + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_future_acquired_at_is_protected_within_grace(store, tmp_path):
    # Clock skew: now BEFORE acquired_at (negative delta) counts as still-within-grace.
    eng = _agent(store)
    _checked_out_issue(store, eng, wakeup_id="wake_DEAD", acquired_at=1000.0)
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: []
    assert d.reclaim_stale_workspace_locks(now=999.0) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_fail_closed_when_runs_unlistable(store, tmp_path):
    eng = _agent(store)
    _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: (_ for _ in ()).throw(RuntimeError("db down"))
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock("workspace:local") is not None


def test_never_touches_agent_prefixed_locks(store, tmp_path):
    eng = _agent(store)
    store.acquire_workspace_lock(f"agent:{eng.profile_id}", workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, run_id="wake_X")
    d = _daemon(store, tmp_path)
    # An agent: lock is not a candidate at all → no run scan, lock untouched.
    d.store.list_runs = lambda: (_ for _ in ()).throw(AssertionError("must not scan runs"))
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_no_run_scan_when_no_checkout_locks(store, tmp_path):
    _agent(store)
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: (_ for _ in ()).throw(AssertionError("must not scan runs"))
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0


def test_reclaim_never_raises_on_broken_store(store, tmp_path):
    d = _daemon(store, tmp_path)
    d.store.list_workspace_locks = lambda **k: (_ for _ in ()).throw(RuntimeError("db down"))
    assert d.reclaim_stale_workspace_locks(now=GRACE + 1) == 0  # no raise


# --------------------------------------------------------------------------- #
# Retry-once (ledger PK) + ABA guard                                          #
# --------------------------------------------------------------------------- #


def test_retry_once_does_not_re_enqueue_on_a_second_reclaim(store, tmp_path):
    # The ledger PK collapses a re-observed (issue, dead-wakeup) to a no-op INSERT,
    # so the SAME orphan re-drives work AT MOST ONCE. Drive reclaim_orphaned_checkout
    # twice for the same pair (second time after re-staging the same lock+issue).
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_DEAD", expected_lock_key="workspace:local",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY1",
        retry_company_profile_id=eng.company_profile_id,
    ) is True
    # Re-stage the EXACT orphan (same issue + same dead wakeup id) as if it leaked again.
    store.acquire_workspace_lock("workspace:local", workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, issue_id=issue.issue_id, run_id="wake_DEAD")
    again = store.get_issue(issue.issue_id)
    again.status = IssueStatus.IN_PROGRESS.value
    again.checkout_run_id = "wake_DEAD"
    again.execution_run_id = "wake_DEAD"
    again.lock_key = "workspace:local"
    store.commit_checkout(again)
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_DEAD", expected_lock_key="workspace:local",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY2",
        retry_company_profile_id=eng.company_profile_id,
    ) is True
    # Lock freed + issue reset both times, but only ONE retry wakeup exists.
    retries = [w for w in store.list_wakeups(status="queued")
               if w.reason == f"reclaimed_orphan_checkout:{issue.issue_id}"]
    assert len(retries) == 1 and retries[0].wakeup_id == "wake_RETRY1"


def test_aba_guard_rejects_when_issue_re_checked_out_by_a_new_run(store, tmp_path):
    # A concurrent re-checkout (a NEW run grabbed the issue between the reaper's read
    # and the commit) flips checkout_run_id → the atomic ABA guard must reject and
    # mutate NOTHING.
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_OLD")
    # Simulate the issue now owned by a different, newer run.
    moved = store.get_issue(issue.issue_id)
    moved.checkout_run_id = "wake_NEW"
    moved.execution_run_id = "wake_NEW"
    store.save_issue(moved)
    # Reaper still believes the OLD wakeup holds it → ABA mismatch → False, no change.
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_OLD", expected_lock_key="workspace:local",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY",
        retry_company_profile_id=eng.company_profile_id,
    ) is False
    assert store.get_workspace_lock("workspace:local") is not None  # lock untouched
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert not [w for w in store.list_wakeups(status="queued")
                if w.reason.startswith("reclaimed_orphan_checkout:")]


def test_aba_guard_rejects_when_lock_key_mismatches(store, tmp_path):
    # The issue is checked out under a DIFFERENT lock key than the reaper expects →
    # reject (the reaper's read is stale w.r.t. the pinned key).
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD", lock_key="workspace:local")
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_DEAD", expected_lock_key="workspace:OTHER",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY",
        retry_company_profile_id=eng.company_profile_id,
    ) is False
    assert store.get_workspace_lock("workspace:local") is not None


def test_in_txn_recheck_rejects_a_run_created_after_the_snapshot(store, tmp_path):
    # TOCTOU close: the reaper's out-of-txn "no run" snapshot can go stale if a run
    # is created + stamped for THIS wakeup AFTER the snapshot but before the reclaim
    # txn. The ABA guard alone passes (checkout_run_id/lock.run_id never change when
    # the run is created), so reclaim_orphaned_checkout MUST re-scan runs in-txn and
    # abort. Here a live run for wake_DEAD exists at call time → no reclaim.
    from superclaw.models import RunSession
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    store.save_run(RunSession(goal_id="g", run_id="run_live",
                              execution_context={"wakeup_id": "wake_DEAD"}))
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_DEAD", expected_lock_key="workspace:local",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY",
        retry_company_profile_id=eng.company_profile_id,
    ) is False
    assert store.get_workspace_lock("workspace:local") is not None  # live lock untouched
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value


def test_create_run_stamps_attribution_on_the_first_insert(store, tmp_path):
    # Root close for the live-setup-stall race: store.create_run must persist the
    # attribution keys (wakeup_id / issue_id) on the FIRST run row, so a run being
    # set up for a checkout is always discoverable by the reaper — never a window
    # where a persisted-but-unstamped run looks like a no-run orphan.
    from superclaw.models import RunSession  # noqa: F401 - parity import
    session = store.create_run("g", execution_context={"wakeup_id": "wake_X", "issue_id": "issue_Y"})
    persisted = store.get_run(session.run_id)
    assert persisted.execution_context.get("wakeup_id") == "wake_X"
    assert persisted.execution_context.get("issue_id") == "issue_Y"
    # Backward-compatible: no execution_context → empty (unchanged behavior).
    assert store.create_run("g2").execution_context == {}


def test_in_txn_recheck_rejects_a_run_carrying_the_issue_id(store, tmp_path):
    # Same TOCTOU close via the issue_id stamp (a run that anchored to the issue but
    # under a different/blank wakeup stamp still proves live work → abort).
    from superclaw.models import RunSession
    eng = _agent(store)
    issue = _checked_out_issue(store, eng, wakeup_id="wake_DEAD")
    store.save_run(RunSession(goal_id="g", run_id="run_live2",
                              execution_context={"issue_id": issue.issue_id}))
    assert store.reclaim_orphaned_checkout(
        issue.issue_id, expected_wakeup_id="wake_DEAD", expected_lock_key="workspace:local",
        retry_agent_profile_id=eng.profile_id, retry_wakeup_id="wake_RETRY",
        retry_company_profile_id=eng.company_profile_id,
    ) is False
    assert store.get_workspace_lock("workspace:local") is not None


# --------------------------------------------------------------------------- #
# Wiring                                                                      #
# --------------------------------------------------------------------------- #


def test_startup_self_heal_invokes_workspace_reclaim(store, tmp_path):
    d = _daemon(store, tmp_path)
    called = {"n": 0}
    d.reclaim_stale_workspace_locks = lambda **k: called.__setitem__("n", called["n"] + 1) or 0
    d.startup_self_heal()
    assert called["n"] == 1


def test_startup_self_heal_skips_workspace_reclaim_when_reconcile_fails(store, tmp_path):
    d = HeartbeatDaemon(
        store,
        types.SimpleNamespace(
            reconcile_stale_runs=lambda **k: (_ for _ in ()).throw(RuntimeError("x"))
        ),
        repo_path=tmp_path, artifact_dir=tmp_path / "a",
    )
    called = {"n": 0}
    d.reclaim_stale_workspace_locks = lambda **k: called.__setitem__("n", called["n"] + 1) or 0
    assert d.startup_self_heal() == 0
    assert called["n"] == 0  # reclaim skipped on an unconverged run view


def test_run_forever_calls_workspace_reclaim_each_cycle(store, tmp_path):
    d = _daemon(store, tmp_path)
    called = {"n": 0}
    d.reclaim_stale_workspace_locks = lambda **k: called.__setitem__("n", called["n"] + 1) or 0
    # Single-cycle stop: heal once, run the loop body once, then stop.
    stops = iter([False, True])
    d.startup_self_heal = lambda: 0  # isolate to the loop body's call
    d.run_forever(interval_seconds=1.0, stop_check=lambda: next(stops))
    assert called["n"] >= 1
