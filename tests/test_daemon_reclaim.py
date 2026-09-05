"""Robustness (Paperclip-native): an agent is never permanently stuck `agent_busy`.

A crash/restart/hung run can leave a wakeup `claimed` holding the per-agent
single-flight lock (which has no TTL) → without reclaim that durable lock blocks
every future wakeup for that agent forever. Reclaim reaps it by RUN LIVENESS
(not a fixed run-duration cap), continuously (startup + every scheduler cycle):
a claim past the grace period whose agent has NO live run is stale → release the
lock + finish the claim, so the agent recovers WITHOUT a restart.
"""

from __future__ import annotations

import types

import pytest

from superclaw.daemon import HeartbeatDaemon
from superclaw.models import AgentProfile, AgentWakeupRequest, CompanyProfile
from superclaw.state import StateStore

GRACE = HeartbeatDaemon._STALE_CLAIM_GRACE_SECONDS


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _daemon(store, tmp_path):
    return HeartbeatDaemon(store, types.SimpleNamespace(reconcile_stale_runs=lambda **k: []),
                           repo_path=tmp_path, artifact_dir=tmp_path / "a")


def _agent(store):
    cid = store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id
    return store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", backend_policy="local", company_profile_id=cid)
    )


def _orphan_claim(store, profile):
    """Simulate a crash: a claimed wakeup that left the per-agent lock held."""
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id,
                                            source="on_demand", reason="mention:i1"))
    claimed = store.claim_next_wakeup()
    store.acquire_workspace_lock(f"agent:{profile.profile_id}",
                                 workspace_id=profile.workspace_id,
                                 holder=profile.profile_id, run_id=claimed.wakeup_id)
    return claimed


def test_reclaims_stale_claim_when_agent_has_no_live_run(store, tmp_path):
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None
    # Past grace + no live run (no runs at all) → reaped.
    n = _daemon(store, tmp_path).reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert n == 1
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is None
    done = [w for w in store.list_wakeups(status="skipped") if w.wakeup_id == claimed.wakeup_id]
    assert done and done[0].detail == "reclaimed:stale_claim_no_live_run"


def test_grace_protects_a_freshly_claimed_run(store, tmp_path):
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    # Within the grace window → NOT reclaimed (a just-started run may not have its
    # lease yet; reaping it would kill live work).
    n = _daemon(store, tmp_path).reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + 1)
    assert n == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_does_not_reclaim_when_the_claims_run_is_live(store, tmp_path):
    # Keyed on wakeup_id: the run THIS claim spawned (execution_context.wakeup_id ==
    # wakeup_id) is live → its lock must not be freed.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: ({claimed.wakeup_id}, set())  # its run is genuinely live
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert n == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_does_not_reclaim_when_agent_has_a_live_unkeyable_run(store, tmp_path):
    # Fail-CLOSED fallback: a live run we couldn't key to a wakeup (wakeup_id
    # missing) but that carries this agent's id → protect the whole agent.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: (set(), {eng.profile_id})
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert n == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_does_not_reclaim_when_liveness_unassessable(store, tmp_path):
    # Fail-CLOSED: if runs can't be listed at all (None), reap NOTHING this cycle —
    # a transient DB hiccup must never free a live agent's lock.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: None
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert n == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_no_run_scan_when_no_stale_candidate(store, tmp_path):
    # no-burn: with no claim past the grace window, reclaim returns WITHOUT scanning
    # runs at all (the common idle path must be cheap).
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)  # still within grace below
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: (_ for _ in ()).throw(AssertionError("must not scan runs"))
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + 1)  # within grace
    assert n == 0


def test_live_owners_lock_survives_but_dead_duplicate_claim_is_finished(store, tmp_path):
    # The agent lock is held by a LIVE owner (a DIFFERENT run, run_id protected). The
    # reaper must NOT delete that live lock, but it MUST finish this dead duplicate
    # claim (wakeup_id != the live owner's, and finish_wakeup keys strictly on this
    # wakeup_id → it can never touch the live owner's row). Leaving it would leak the
    # claim forever while the agent stays busy.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    store.release_workspace_lock(f"agent:{eng.profile_id}", holder=eng.profile_id)
    store.acquire_workspace_lock(f"agent:{eng.profile_id}", workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, run_id="wake_NEW_owner")
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: ({"wake_NEW_owner"}, set())  # new owner is genuinely live
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert n == 1
    held = store.get_workspace_lock(f"agent:{eng.profile_id}")
    assert held is not None and held.run_id == "wake_NEW_owner"  # live owner's lock survives
    # The dead duplicate claim IS finished (never leaked).
    assert any(w.wakeup_id == claimed.wakeup_id for w in store.list_wakeups(status="skipped"))


def test_future_claimed_at_is_protected_within_grace(store, tmp_path):
    # Clock skew: a claim whose claimed_at is slightly in the FUTURE (negative delta)
    # must be treated as STILL WITHIN grace — never reap a just-claimed run on a clock
    # difference. (It self-corrects once wall-clock advances past claimed_at + grace.)
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    n = d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) - 1)  # now BEFORE claim
    assert n == 0
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is not None


def test_recovers_a_lock_held_by_a_dead_mismatched_run(store, tmp_path):
    # The recovery case Codex flagged: the agent lock is held under a run_id that is
    # NOT this claim's and is NOT live (dead/mismatched/corrupt). The reaper must FREE
    # it (compare-and-delete on the holder's own run_id) rather than abandon the claim
    # and wedge the agent agent_busy forever.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    store.release_workspace_lock(f"agent:{eng.profile_id}", holder=eng.profile_id)
    store.acquire_workspace_lock(f"agent:{eng.profile_id}", workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, run_id="wake_DEAD_other")
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: (set(), set())  # nothing live → the holder is dead
    d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert store.get_workspace_lock(f"agent:{eng.profile_id}") is None  # stuck lock freed
    assert any(w.wakeup_id == claimed.wakeup_id for w in store.list_wakeups(status="skipped"))


def test_raced_release_still_finishes_the_dead_claim(store, tmp_path):
    # If the atomic release returns None (the lock was concurrently re-acquired by a
    # NEWER run), the dead claim must STILL be finished — that newer run has its own
    # claim, and finish_wakeup keys on this wakeup_id so it never touches the new owner.
    # Not finishing here would leak the claim forever on a continuously-busy agent.
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    d._live_protection = lambda: (set(), set())  # holder is not live
    d.store.release_workspace_lock = lambda *a, **k: None  # simulate raced re-acquire
    d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    assert any(w.wakeup_id == claimed.wakeup_id for w in store.list_wakeups(status="skipped"))


def test_startup_self_heal_skips_reclaim_when_reconcile_fails(store, tmp_path):
    # Fail-closed ordering: if reconcile raises, the run view is not confirmed
    # converged → startup must NOT reclaim (the continuous loop handles it later).
    d = HeartbeatDaemon(
        store,
        types.SimpleNamespace(reconcile_stale_runs=lambda **k: (_ for _ in ()).throw(RuntimeError("x"))),
        repo_path=tmp_path, artifact_dir=tmp_path / "a",
    )
    called = {"n": 0}
    d.reclaim_stale_agent_locks = lambda **k: called.__setitem__("n", called["n"] + 1) or 0
    assert d.startup_self_heal() == 0
    assert called["n"] == 0  # reclaim skipped


def test_startup_self_heal_invokes_reclaim(store, tmp_path):
    d = _daemon(store, tmp_path)
    called = {"n": 0}
    d.reclaim_stale_agent_locks = lambda **k: called.__setitem__("n", called["n"] + 1) or 0
    d.startup_self_heal()
    assert called["n"] == 1


def test_reclaimed_agent_can_be_serviced_again(store, tmp_path):
    eng = _agent(store)
    claimed = _orphan_claim(store, eng)
    d = _daemon(store, tmp_path)
    d.reclaim_stale_agent_locks(now=(claimed.claimed_at or 0) + GRACE + 1)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id, source="timer", reason="timer"))
    out = d.service_once()  # heartbeat disabled → idle, NOT agent_busy: lock is free
    assert out is not None and "agent_busy" not in (out.detail or "")


def test_reclaim_never_raises_on_broken_store(store, tmp_path):
    d = _daemon(store, tmp_path)
    d.store.list_wakeups = lambda **k: (_ for _ in ()).throw(RuntimeError("db down"))
    assert d.reclaim_stale_agent_locks() == 0  # no raise


def test_respond_budget_is_capped_never_unlimited(store, tmp_path):
    # The duration backstop complementing the reaper: a respond run is hard-capped so
    # a hung-but-still-leasing turn cannot hold the per-agent lock indefinitely.
    d = _daemon(store, tmp_path)
    cap = HeartbeatDaemon._RESPOND_BUDGET_CAP_SECONDS
    assert d._respond_budget_seconds(AgentProfile(name="a", role="r", budget_seconds=0)) == cap
    assert d._respond_budget_seconds(AgentProfile(name="a", role="r", budget_seconds=60)) == 60
    assert d._respond_budget_seconds(AgentProfile(name="a", role="r", budget_seconds=99999)) == cap


def test_respond_budget_tolerates_string_value(store, tmp_path):
    d = _daemon(store, tmp_path)
    cap = HeartbeatDaemon._RESPOND_BUDGET_CAP_SECONDS
    assert d._respond_budget_seconds(AgentProfile(name="a", role="r", budget_seconds="60")) == 60
    assert d._respond_budget_seconds(AgentProfile(name="a", role="r", budget_seconds="oops")) == cap


def test_finish_wakeup_expected_status_guards_against_clobber(store, tmp_path):
    # TOCTOU guard: the reaper must never overwrite a wakeup another path concurrently
    # transitioned out of `claimed` (e.g. its run completing `finished`).
    eng = _agent(store)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id, source="timer", reason="t"))
    w = store.claim_next_wakeup()
    store.finish_wakeup(w.wakeup_id, status="finished", detail="done")  # completed concurrently
    # A late reaper finish with expected_status="claimed" must be a no-op (not clobber).
    out = store.finish_wakeup(w.wakeup_id, status="skipped", detail="reclaimed", expected_status="claimed")
    assert out.status == "finished" and out.detail == "done"  # unchanged
    assert store.list_wakeups(status="finished")[0].wakeup_id == w.wakeup_id


def test_release_expected_run_id_none_is_a_real_compare(store, tmp_path):
    # The concurrency hole both advisors flagged: expected_run_id=None must mean
    # "delete only if the held run_id is EXACTLY None", NOT "skip the check". So a
    # lock concurrently re-acquired with a REAL run_id is never blind-deleted when
    # the reaper observed a None run_id.
    eng = _agent(store)
    key = f"agent:{eng.profile_id}"
    store.acquire_workspace_lock(key, workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, run_id="wake_LIVE")
    assert store.release_workspace_lock(key, expected_run_id=None) is None  # None != "wake_LIVE"
    assert store.get_workspace_lock(key) is not None  # live owner's lock survived
    # A lock genuinely holding run_id None → expected_run_id=None matches → deleted.
    store.release_workspace_lock(key, holder=eng.profile_id)
    store.acquire_workspace_lock(key, workspace_id=eng.workspace_id, holder=eng.profile_id)  # run_id None
    assert store.release_workspace_lock(key, expected_run_id=None) is not None
    assert store.get_workspace_lock(key) is None


def _run(status, *, ec):
    return types.SimpleNamespace(status=status, execution_context=ec)


def test_live_protection_keys_on_wakeup_id(store, tmp_path, monkeypatch):
    # The live set is keyed on execution_context.wakeup_id — the exact link a claim
    # has to its run — NOT a fuzzy agent attribution.
    import superclaw.daemon as dm
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec={"wakeup_id": "wake_LIVE"}),
                                 _run("completed", ec={"wakeup_id": "wake_DONE"})]
    monkeypatch.setattr(dm, "effective_run_state", lambda run, **k: {"is_live": True})
    wakeups, agents = d._live_protection()
    assert wakeups == {"wake_LIVE"} and agents == set()  # resolved run ignored


def test_live_protection_agent_fallback_when_wakeup_id_missing(store, tmp_path, monkeypatch):
    # A live run with NO usable wakeup_id but an agent id → protect that agent.
    import superclaw.daemon as dm
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec={"agent_profile_id": "agent_7"}),
                                 _run("running", ec={})]  # operator run: no agent id → ignored
    monkeypatch.setattr(dm, "effective_run_state", lambda run, **k: {"is_live": True})
    wakeups, agents = d._live_protection()
    assert wakeups == set() and agents == {"agent_7"}


class _ExplodingStatusRun:
    """A run whose status read raises — an active run we cannot classify."""
    execution_context: dict = {}

    @property
    def status(self):
        raise RuntimeError("corrupt run row")


def test_live_protection_aborts_fail_closed_on_unclassifiable_run(store, tmp_path):
    # An ACTIVE run we cannot classify might be live AND holding a lock → the whole
    # sweep must fail CLOSED (return None → reap nothing), never fail-open by skipping.
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_ExplodingStatusRun()]
    assert d._live_protection() is None


def test_live_protection_fail_closed_on_corrupt_ec_of_a_LIVE_run(store, tmp_path, monkeypatch):
    # A PRESENT but non-Mapping execution_context on a LIVE run is corrupt and unkeyable
    # → fail closed (return None), never silently coerce to {} and leave a possibly-live
    # lock-holder unprotected.
    import superclaw.daemon as dm
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec="corrupt-not-a-mapping")]
    monkeypatch.setattr(dm, "effective_run_state", lambda run, **k: {"is_live": True})
    assert d._live_protection() is None


def test_live_protection_tolerates_corrupt_ec_of_a_NOT_live_run(store, tmp_path, monkeypatch):
    # A corrupt ec on a NOT-live active run protects nothing → skip it, do NOT abort the
    # whole sweep (a dead leftover must never stall reclaim for every other agent).
    import superclaw.daemon as dm
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec="corrupt-not-a-mapping"),
                                 _run("running", ec={"wakeup_id": "wake_LIVE"})]
    monkeypatch.setattr(dm, "effective_run_state",
                        lambda run, **k: {"is_live": run.execution_context != "corrupt-not-a-mapping"})
    out = d._live_protection()
    assert out == ({"wake_LIVE"}, set())  # corrupt-but-dead skipped; live one protected


def test_release_holder_mismatch_still_raises(store, tmp_path):
    # The expected_run_id addition must not weaken the holder guard: a holder-only
    # release with a mismatched holder still raises (no caller combines holder +
    # expected_run_id, so the new short-circuit never bypasses this).
    eng = _agent(store)
    key = f"agent:{eng.profile_id}"
    store.acquire_workspace_lock(key, workspace_id=eng.workspace_id,
                                 holder=eng.profile_id, run_id="wake_X")
    with pytest.raises(ValueError):
        store.release_workspace_lock(key, holder="someone_else")
    assert store.get_workspace_lock(key) is not None  # not released


def test_live_protection_none_when_runs_unlistable(store, tmp_path):
    # Fail-CLOSED: cannot list runs → None → caller reaps nothing this cycle.
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: (_ for _ in ()).throw(RuntimeError("db down"))
    assert d._live_protection() is None


def test_live_protection_protects_on_per_run_liveness_error(store, tmp_path, monkeypatch):
    # Fail-CLOSED per run: if liveness can't be computed for an active run, protect
    # its wakeup (cannot prove not-live → never reap).
    import superclaw.daemon as dm
    d = _daemon(store, tmp_path)
    d.store.list_runs = lambda: [_run("running", ec={"wakeup_id": "wake_X"})]
    monkeypatch.setattr(dm, "effective_run_state",
                        lambda run, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    wakeups, agents = d._live_protection()
    assert wakeups == {"wake_X"}
