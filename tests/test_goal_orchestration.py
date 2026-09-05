"""PR4 — prove the orchestrator actually binds each plan slot to its roster agent on
the SERIAL execution path (the path a LINEAR concurrency=1 Goal Mode run always
takes). The lifecycle tests inject a fake orchestrator; this exercises the REAL one,
so a per-slot binding that only wired the parallel frontier path would be caught.
"""

from superclaw import goal_mode
from superclaw.backends import LocalShellBackend
from superclaw.models import TaskTopology, WorkerResult
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


class _RecordingBackend(LocalShellBackend):
    """A success-returning backend that records, per task, the role it ran and the
    model/effort overrides it was handed — so the test can assert which agent + knobs
    each slot actually executed on."""

    def __init__(self, name: str) -> None:
        super().__init__()
        self.name = name
        self.seen: list[tuple[str, object, object]] = []

    def run(self, task, goal, session, limits):  # type: ignore[override]
        self.seen.append((task.role.value, limits.model_override, limits.effort_override))
        return WorkerResult(
            task_id=task.task_id,
            role=task.role.value,
            backend=self.name,
            command=f"{self.name}:{task.role.value}",
            exit_code=0,
            output="ok",
            duration_seconds=0.0,
            attempt_index=max(1, int(session.task_attempts.get(task.task_id, 1))),
        )


def _confirm(store: StateStore, roster: list[dict]):
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.LINEAR)
    return goal_mode.confirm_goal(
        store,
        rec.goal_id,
        expected_revision=rec.revision,
        plan_hash=rec.plan_hash,
        roster={"entries": roster},
    )


def test_serial_path_binds_each_slot_to_its_roster_agent(tmp_path):
    store = StateStore(tmp_path / "state.db")
    alpha, beta = _RecordingBackend("alpha"), _RecordingBackend("beta")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha, "beta": beta})
    confirmed = _confirm(
        store,
        [
            {"source": "backend", "role": None, "backend": "alpha"},
            {"source": "backend", "role": "implement", "backend": "beta", "model": "m-beta", "effort": "high"},
        ],
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)

    # The 'implement' slot ran on beta with ITS per-slot model/effort override...
    assert beta.seen == [("implement", "m-beta", "high")]
    # ...and every other LINEAR role ran on the lead (alpha), never on beta.
    assert {role for role, _m, _e in alpha.seen} == {"explore", "plan", "verify", "review"}


def test_lead_only_roster_runs_all_slots_on_lead(tmp_path):
    store = StateStore(tmp_path / "state.db")
    alpha, beta = _RecordingBackend("alpha"), _RecordingBackend("beta")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha, "beta": beta})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert {role for role, _m, _e in alpha.seen} == {"explore", "plan", "implement", "verify", "review"}
    assert beta.seen == []


def test_slot_backend_fail_safe_on_unknown_name(tmp_path):
    # An unknown bound backend degrades to the fallback (select_backends raises
    # ValueError on an unknown policy); the run must not crash.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})

    class _T:
        from superclaw.models import WorkerRole as _WR
        role = _WR.IMPLEMENT

    fallback = object()
    assert orch._slot_backend(_T(), {"implement": {"backend": "nope"}}, fallback) is fallback


def test_slot_resolver_noop_and_roleless(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    from superclaw.models import WorkerRole

    class _WithRole:
        role = WorkerRole.IMPLEMENT

    class _NoRole:
        role = None  # not a goal slot — must not raise on .value

    fallback = object()
    # empty slot_runtimes (every normal run) -> strict no-op
    assert orch._slot_backend(_WithRole(), {}, fallback) is fallback
    assert SuperClawOrchestrator._slot_runtime_for(_WithRole(), {}) is None
    # a roleless task with a populated map -> still no-op, no AttributeError
    assert orch._slot_backend(_NoRole(), {"implement": {"backend": "alpha"}}, fallback) is fallback


def test_confirm_rejects_unknown_backend_when_known_set_given(tmp_path):
    # 铁律2: confirm fails closed on a backend the live registry does not have,
    # rather than silently degrading to the lead at run time.
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.LINEAR)
    roster = {"entries": [{"source": "backend", "role": None, "backend": "ghost"}]}
    import pytest

    with pytest.raises(goal_mode.GoalRosterError, match="unknown backend"):
        goal_mode.confirm_goal(
            store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
            roster=roster, known_backends={"alpha", "beta"},
        )


def test_different_backend_slot_does_not_inherit_lead_model(tmp_path):
    # Codex regression: a slot bound to a DIFFERENT backend with empty model/effort
    # must run on that backend's OWN default, NOT inherit the lead's (non-portable)
    # model override. Same-backend slots DO keep the lead default.
    store = StateStore(tmp_path / "state.db")
    alpha, beta = _RecordingBackend("alpha"), _RecordingBackend("beta")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha, "beta": beta})
    confirmed = _confirm(
        store,
        [
            {"source": "backend", "role": None, "backend": "alpha", "model": "m-alpha", "effort": "high"},
            {"source": "backend", "role": "implement", "backend": "beta"},  # no model/effort
        ],
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    # beta (different backend) ran with NO leaked lead model/effort.
    assert beta.seen == [("implement", None, None)]
    # alpha slots (same backend as lead) kept the lead's model/effort default.
    assert all(m == "m-alpha" and e == "high" for _r, m, e in alpha.seen)


def test_goal_completes_when_run_succeeds(tmp_path):
    # PR5: a goal's status is DERIVED from its run — a successful run flips the goal
    # to complete (never agent-self-reported).
    store = StateStore(tmp_path / "state.db")
    alpha = _RecordingBackend("alpha")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert store.get_goal_record(confirmed.goal_id).status == "complete"


class _FailingBackend(_RecordingBackend):
    def run(self, task, goal, session, limits):  # type: ignore[override]
        from superclaw.models import WorkerResult
        self.seen.append((task.role.value, limits.model_override, limits.effort_override))
        return WorkerResult(
            task_id=task.task_id, role=task.role.value, backend=self.name,
            command=f"{self.name}:{task.role.value}", exit_code=1, output="boom",
            duration_seconds=0.0, attempt_index=1,
        )


def test_goal_blocks_when_run_fails(tmp_path):
    store = StateStore(tmp_path / "state.db")
    bad = _FailingBackend("alpha")
    orch = SuperClawOrchestrator(store, backends={"alpha": bad})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert store.get_goal_record(confirmed.goal_id).status == "blocked"


def test_reconcile_is_idempotent_noop_without_runs(tmp_path):
    # An active goal with no runs (or a fake-orchestrated one) is left untouched.
    store = StateStore(tmp_path / "state.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash
    )
    before = confirmed.revision
    reconciled = goal_mode.reconcile_goal_status(store, confirmed.goal_id)
    assert reconciled.status == "active" and reconciled.revision == before


def _make_active_goal_with_run(store, run_status, *, with_fail_finding=False):
    """Build an active goal that already has one run in `run_status`, optionally with a
    failing evidence finding — to drive the projection without a full orchestrator run."""
    from superclaw.models import RunSession
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    run = RunSession(goal_id=confirmed.goal_id, status=run_status)
    store.save_run(run)
    ev = store.create_evidence(run.run_id)
    if with_fail_finding:
        ev.add_finding("verification", False, "adversarial probe failed", "high")
    store.save_evidence(ev)
    return confirmed, run


def test_completed_run_with_fail_verdict_does_not_complete(tmp_path):
    # Codex: RunStatus.COMPLETED != verification passed. A completed run whose evidence
    # verdict is FAIL must leave the goal blocked, never complete.
    store = StateStore(tmp_path / "state.db")
    confirmed, run = _make_active_goal_with_run(store, "completed", with_fail_finding=True)
    # designate that run; its evidence verdict is FAIL -> blocked, not complete
    goal_mode.reconcile_goal_status(store, confirmed.goal_id, run_id=run.run_id)
    assert store.get_goal_record(confirmed.goal_id).status == "blocked"


def test_latest_run_failure_overrides_older_success(tmp_path):
    # Codex: a stale historical success must not mask a newer failure (1:N).
    from superclaw.models import RunSession
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    old = RunSession(goal_id=confirmed.goal_id, status="completed")
    store.save_run(old)
    store.save_evidence(store.create_evidence(old.run_id))
    new = RunSession(goal_id=confirmed.goal_id, status="failed")  # the goal's latest attempt
    store.save_run(new)
    # the goal derives from its DESIGNATED run (the new failed one), not an old success
    goal_mode.reconcile_goal_status(store, confirmed.goal_id, run_id=new.run_id)
    assert store.get_goal_record(confirmed.goal_id).status == "blocked"


def test_completion_gate_requires_a_real_completed_run(tmp_path):
    # Codex: the gate is not just naming — without a real completed run for the goal,
    # complete_goal_record refuses, so no caller can self-flip a goal to complete.
    import pytest
    from superclaw.models import GoalStatus
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    confirmed.status = GoalStatus.COMPLETE.value
    confirmed.revision += 1
    with pytest.raises(ValueError, match="completion gate"):
        store.complete_goal_record(confirmed, expected_revision=confirmed.revision - 1, run_id=None)
    with pytest.raises(ValueError, match="completion gate"):
        store.complete_goal_record(confirmed, expected_revision=confirmed.revision - 1, run_id="run_ghost")


def test_gate_rejects_fail_verdict_and_non_designated_run_directly(tmp_path):
    # Codex: the verdict + designated-run checks live in the STORE gate, so even a
    # direct complete_goal_record call cannot complete with a FAIL-verdict run or a
    # run that is not the goal's designated run.
    import pytest
    from superclaw.models import GoalStatus, RunSession
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    # designate run A (completed) but give it a FAIL verdict
    run_a = RunSession(goal_id=confirmed.goal_id, status="completed")
    store.save_run(run_a)
    ev = store.create_evidence(run_a.run_id)
    ev.add_finding("verification", False, "probe failed", "high")
    store.save_evidence(ev)
    designated = goal_mode.reconcile_goal_status(store, confirmed.goal_id, run_id=run_a.run_id)
    assert designated.status == "blocked"  # projection already refused

    # Force-build a 'complete' record and try the gate directly with run A (FAIL verdict)
    fresh = store.get_goal_record(confirmed.goal_id)
    # route to active first (blocked->active is legal) so we can attempt active->complete
    fresh.status = GoalStatus.ACTIVE.value
    fresh.revision += 1
    store.update_goal_record(fresh, expected_revision=fresh.revision - 1)
    fresh = store.get_goal_record(confirmed.goal_id)
    fresh.status = GoalStatus.COMPLETE.value
    fresh.revision += 1
    with pytest.raises(ValueError, match="verdict is FAIL"):
        store.complete_goal_record(fresh, expected_revision=fresh.revision - 1, run_id=run_a.run_id)

    # A different (non-designated) completed run with a passing verdict is also rejected.
    run_b = RunSession(goal_id=confirmed.goal_id, status="completed")
    store.save_run(run_b)
    store.save_evidence(store.create_evidence(run_b.run_id))
    with pytest.raises(ValueError, match="designated run"):
        store.complete_goal_record(fresh, expected_revision=fresh.revision - 1, run_id=run_b.run_id)


def test_gate_rejects_single_write_forge_against_stored_designation(tmp_path):
    # Codex: a caller cannot forge "designated + complete" in ONE write. The gate
    # validates run_id against the goal's STORED last_run_id (None here), not the
    # caller-supplied record field — even with a genuinely completed, passing run.
    import pytest
    from superclaw.models import GoalStatus, RunSession
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    # a real completed run with a passing verdict, but NOT designated on the goal
    run = RunSession(goal_id=confirmed.goal_id, status="completed")
    store.save_run(run)
    store.save_evidence(store.create_evidence(run.run_id))
    assert store.get_goal_record(confirmed.goal_id).last_run_id is None  # nothing designated

    forged = store.get_goal_record(confirmed.goal_id)
    forged.last_run_id = run.run_id  # caller tries to self-designate in the same write
    forged.status = GoalStatus.COMPLETE.value
    forged.revision += 1
    with pytest.raises(ValueError, match="gate-controlled"):
        store.complete_goal_record(forged, expected_revision=forged.revision - 1, run_id=run.run_id)
    # goal is untouched
    assert store.get_goal_record(confirmed.goal_id).status == "active"


def test_last_run_id_is_gate_controlled(tmp_path):
    # Codex: the trust root cannot be moved via a generic ledger update — only the
    # designation gate (which validates the run belongs to the goal) may set it.
    import pytest
    from superclaw.models import RunSession
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(store, rec.goal_id, expected_revision=1, plan_hash=rec.plan_hash)
    run = RunSession(goal_id=confirmed.goal_id, status="completed")
    store.save_run(run)
    # generic update trying to move last_run_id -> rejected
    rogue = store.get_goal_record(confirmed.goal_id)
    rogue.last_run_id = run.run_id
    rogue.revision += 1
    with pytest.raises(ValueError, match="gate-controlled"):
        store.update_goal_record(rogue, expected_revision=rogue.revision - 1)
    # the designation gate sets it, validating the run belongs to the goal
    fresh = store.get_goal_record(confirmed.goal_id)
    fresh.revision += 1
    store.designate_goal_run(fresh, expected_revision=fresh.revision - 1, run_id=run.run_id)
    assert store.get_goal_record(confirmed.goal_id).last_run_id == run.run_id
    # designating a foreign run is rejected
    foreign = RunSession(goal_id="goal_other", status="completed")
    store.save_run(foreign)
    bad = store.get_goal_record(confirmed.goal_id)
    bad.revision += 1
    with pytest.raises(ValueError, match="designation gate"):
        store.designate_goal_run(bad, expected_revision=bad.revision - 1, run_id=foreign.run_id)


# --- PR7: concurrent fan-out budget reservation -----------------------------


def test_budget_reservation_ledger_is_atomic_and_bounded(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.set_goal_budget("g1", 1000)
    assert store.goal_budget_snapshot("g1")["remaining_tokens"] == 1000
    assert store.reserve_goal_budget("g1", 600) is True
    assert store.reserve_goal_budget("g1", 600) is False  # 600+600 > 1000 -> denied
    assert store.reserve_goal_budget("g1", 400) is True   # 600+400 == 1000 -> fits
    snap = store.goal_budget_snapshot("g1")
    assert snap["reserved_tokens"] == 1000 and snap["remaining_tokens"] == 0
    # settle the 600 reservation to an actual 100 spend -> frees 500
    store.settle_goal_reservation("g1", 600, 100)
    snap = store.goal_budget_snapshot("g1")
    assert snap["spent_tokens"] == 100 and snap["reserved_tokens"] == 400
    assert snap["remaining_tokens"] == 500
    # an unbudgeted goal is never gated
    assert store.reserve_goal_budget("no-budget", 999999) is True


def test_confirm_implement_fanout_requires_budget(tmp_path):
    store = StateStore(tmp_path / "state.db")
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.IMPLEMENT_FANOUT)
    # no budget -> rejected
    import pytest
    with pytest.raises(ValueError, match="requires a token budget"):
        goal_mode.confirm_goal(store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash)
    # with a budget -> confirms and the ledger is initialised
    confirmed = goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        budget={"token_budget": 1000},
    )
    assert confirmed.status == "active"
    assert store.goal_budget_snapshot(rec.goal_id)["total_tokens"] == 1000


def test_implement_fanout_runs_both_workers_within_budget(tmp_path):
    store = StateStore(tmp_path / "state.db")
    alpha = _RecordingBackend("alpha")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha})
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.IMPLEMENT_FANOUT)
    confirmed = goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        roster={"entries": [{"source": "backend", "role": None, "backend": "alpha"}]},
        budget={"token_budget": 1000},
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    # both implement tasks ran (the 2-wide concurrent frontier)
    impl = [r for r, _m, _e in alpha.seen if r == "implement"]
    assert len(impl) == 2
    assert store.get_goal_record(rec.goal_id).status == "complete"


def test_implement_fanout_blocks_when_budget_cannot_admit_both(tmp_path):
    # per-worker slice == total, so the first worker reserves all of it and the second
    # is denied -> the fan-out cannot run -> goal blocked (no overspend).
    store = StateStore(tmp_path / "state.db")
    alpha = _RecordingBackend("alpha")
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha})
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.IMPLEMENT_FANOUT)
    confirmed = goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        roster={"entries": [{"source": "backend", "role": None, "backend": "alpha"}]},
        budget={"token_budget": 100, "per_worker_tokens": 100},
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert store.get_goal_record(rec.goal_id).status == "blocked"
    # at most one implement worker was admitted; the budget was never overspent
    snap = store.goal_budget_snapshot(rec.goal_id)
    assert snap["spent_tokens"] + snap["reserved_tokens"] <= snap["total_tokens"]


class _CostBackend(_RecordingBackend):
    """A success backend that reports a fixed token cost, so the reservation settles to
    ACTUAL spend (read from result.cost), not the conservative reserved slice."""

    def __init__(self, name: str, tokens_per_run: int) -> None:
        super().__init__(name)
        self._tokens = tokens_per_run

    def run(self, task, goal, session, limits):  # type: ignore[override]
        from superclaw.models import WorkerResult
        self.seen.append((task.role.value, limits.model_override, limits.effort_override))
        return WorkerResult(
            task_id=task.task_id, role=task.role.value, backend=self.name,
            command="x", exit_code=0, output="ok", duration_seconds=0.0, attempt_index=1,
            cost={"input_tokens": self._tokens // 2, "output_tokens": self._tokens - self._tokens // 2},
        )


def _confirm_fanout(store, budget):
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.IMPLEMENT_FANOUT)
    return goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        roster={"entries": [{"source": "backend", "role": None, "backend": "alpha"}]}, budget=budget,
    )


def test_settles_actual_token_spend_not_reserved_slice(tmp_path):
    # Codex: tokens live in result.cost; a worker books its ACTUAL spend (300), not the
    # reserved slice (1000).
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _CostBackend("alpha", 300)})
    confirmed = _confirm_fanout(store, {"token_budget": 2000})  # per-worker = 1000
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    snap = store.goal_budget_snapshot(confirmed.goal_id)
    # 2 fan-out workers actually spent 300 each; the other serial slots reported none.
    assert snap["reserved_tokens"] == 0
    assert snap["spent_tokens"] == 600  # actual, not 2 * 1000 reserved


def test_overspend_is_booked_honestly_not_capped_at_reservation(tmp_path):
    # A worker that overspends its slice books the higher real number (bounded overshoot),
    # so future admission sees the true depletion — never an undercount.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _CostBackend("alpha", 1500)})
    confirmed = _confirm_fanout(store, {"token_budget": 2000})  # per-worker 1000, but each spends 1500
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    snap = store.goal_budget_snapshot(confirmed.goal_id)
    assert snap["reserved_tokens"] == 0
    assert snap["spent_tokens"] == 3000  # 2 * 1500 actual, booked honestly over the 2000 budget


class _CrashBackend(_RecordingBackend):
    def run(self, task, goal, session, limits):  # type: ignore[override]
        if task.role.value == "implement":
            raise RuntimeError("worker crashed mid-run")
        from superclaw.models import WorkerResult
        return WorkerResult(
            task_id=task.task_id, role=task.role.value, backend=self.name,
            command="x", exit_code=0, output="ok", duration_seconds=0.0, attempt_index=1,
        )


def test_reservation_is_released_when_a_worker_crashes(tmp_path):
    # Codex: a generic worker exception must not strand its budget reservation.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _CrashBackend("alpha")})
    confirmed = _confirm_fanout(store, {"token_budget": 2000})
    try:
        goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    except Exception:
        pass  # the crash may propagate or be converted to a failed run — either way:
    snap = store.goal_budget_snapshot(confirmed.goal_id)
    assert snap["reserved_tokens"] == 0  # no leaked reservation


class _MixedWaveBackend(_RecordingBackend):
    """implement-hardening crashes; every other task (incl. implement-primary) succeeds
    with a real token cost — so a mixed crash/success wave can be asserted: the surviving
    sibling settles to its ACTUAL spend, not 0."""

    def run(self, task, goal, session, limits):  # type: ignore[override]
        from superclaw.models import WorkerResult
        if "hardening" in task.title:
            raise RuntimeError("hardening worker crashed")
        return WorkerResult(
            task_id=task.task_id, role=task.role.value, backend=self.name,
            command="x", exit_code=0, output="ok", duration_seconds=0.0, attempt_index=1,
            cost={"input_tokens": 150, "output_tokens": 150},
        )


def test_mixed_crash_success_wave_settles_survivor_actual(tmp_path):
    # Codex: a crash must not abort settlement of an already-finished sibling (which
    # would book it at 0 and undercount). The surviving implement worker books 300.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _MixedWaveBackend("alpha")})
    confirmed = _confirm_fanout(store, {"token_budget": 2000})
    try:
        goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    except Exception:
        pass
    snap = store.goal_budget_snapshot(confirmed.goal_id)
    assert snap["reserved_tokens"] == 0           # no leak
    assert snap["spent_tokens"] == 300            # survivor's ACTUAL spend, not 0
    assert store.get_goal_record(confirmed.goal_id).status == "blocked"  # crash -> blocked


# --- PR8: autonomous continuation daemon tick (default OFF) ------------------


def test_continue_active_goals_is_noop_when_disabled(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    assert goal_mode.continue_active_goals(orch, enabled=False, repo_path=str(tmp_path)) == []
    assert store.get_goal_record(confirmed.goal_id).status == "active"  # untouched
    assert not alpha_ran(orch)


def alpha_ran(orch):
    return bool(orch.backends["alpha"].seen)


def test_continue_active_goals_starts_confirmed_when_enabled(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    continued = goal_mode.continue_active_goals(orch, enabled=True, repo_path=str(tmp_path), budget_seconds=30)
    assert confirmed.goal_id in continued
    assert store.get_goal_record(confirmed.goal_id).status == "complete"  # ran to completion


def test_continue_skips_goal_with_a_live_run(tmp_path):
    from superclaw.models import RunSession
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    store.save_run(RunSession(goal_id=confirmed.goal_id, status="running"))  # a live run exists
    assert goal_mode.continue_active_goals(orch, enabled=True, repo_path=str(tmp_path)) == []
    assert not alpha_ran(orch)  # never double-started


def test_continue_respects_max_goals(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    for _ in range(3):
        _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    continued = goal_mode.continue_active_goals(orch, enabled=True, repo_path=str(tmp_path), max_goals=2)
    assert len(continued) == 2  # capped


def test_autonomy_flag_is_fail_closed_off(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    from superclaw import runtime_config
    assert runtime_config.goal_autonomous_continuation_enabled() is False  # default OFF
    runtime_config.set_goal_autonomous_continuation(True)
    assert runtime_config.goal_autonomous_continuation_enabled() is True
    runtime_config.set_goal_autonomous_continuation(False)
    assert runtime_config.goal_autonomous_continuation_enabled() is False


def test_goal_start_lease_is_single_flight(tmp_path):
    store = StateStore(tmp_path / "state.db")
    assert store.claim_goal_start_lease("g1") is True       # first claim wins
    assert store.claim_goal_start_lease("g1") is False      # a fresh lease blocks
    store.release_goal_start_lease("g1")
    assert store.claim_goal_start_lease("g1") is True        # released -> claimable
    # a stale lease is reclaimed (crash recovery)
    assert store.claim_goal_start_lease("g1", stale_after_seconds=0) is True


def test_two_overlapping_starts_only_one_runs(tmp_path):
    # The lease makes start daemon-safe: the second start of the same goal is refused
    # while the first holds the lease (here simulated by pre-claiming it).
    import pytest
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    store.claim_goal_start_lease(confirmed.goal_id)  # another starter holds it
    with pytest.raises(ValueError, match="already being started"):
        goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)


def test_autonomy_flag_rejects_corrupt_values(tmp_path, monkeypatch):
    import json
    cfg = tmp_path / "config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(cfg))
    from superclaw import runtime_config
    for bad in ("true", 1, [], {}, "yes", 0, None):
        cfg.write_text(json.dumps({"goal_autonomous_continuation": bad}), encoding="utf-8")
        assert runtime_config.goal_autonomous_continuation_enabled() is False, bad
    # malformed JSON -> treated as empty config -> disabled
    cfg.write_text("{not json", encoding="utf-8")
    assert runtime_config.goal_autonomous_continuation_enabled() is False
    # only literal boolean True enables
    cfg.write_text(json.dumps({"goal_autonomous_continuation": True}), encoding="utf-8")
    assert runtime_config.goal_autonomous_continuation_enabled() is True


def test_continue_tick_isolates_per_goal_failure(tmp_path, monkeypatch):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    bad = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    good = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    real_start = goal_mode.start_confirmed_goal_run

    def flaky_start(orchestrator, record, **kwargs):
        if record.goal_id == bad.goal_id:
            raise RuntimeError("boom for this goal only")
        return real_start(orchestrator, record, **kwargs)

    monkeypatch.setattr(goal_mode, "start_confirmed_goal_run", flaky_start)
    continued = goal_mode.continue_active_goals(orch, enabled=True, repo_path=str(tmp_path), budget_seconds=30)
    assert good.goal_id in continued       # the healthy goal still ran
    assert bad.goal_id not in continued    # the failing goal was skipped, not aborting the tick


def test_daemon_tick_goal_continuation_wires_the_kernel(tmp_path, monkeypatch):
    import json
    from superclaw.daemon import HeartbeatDaemon
    cfg = tmp_path / "config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(cfg))
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    daemon = HeartbeatDaemon(store=store, orchestrator=orch)
    confirmed = _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])
    # disabled -> no-op
    assert daemon.tick_goal_continuation() == []
    assert store.get_goal_record(confirmed.goal_id).status == "active"
    # enabled via config -> the daemon continues the confirmed goal
    cfg.write_text(json.dumps({"goal_autonomous_continuation": True}), encoding="utf-8")
    continued = daemon.tick_goal_continuation(max_goals=5)
    assert confirmed.goal_id in continued
    assert store.get_goal_record(confirmed.goal_id).status == "complete"


def test_daemon_continuation_forwards_its_execution_context(tmp_path, monkeypatch):
    # Codex: the daemon must run a continued goal in ITS operator-selected repo with ITS
    # budget, never the kernel fallbacks (cwd / 60s).
    import json
    from pathlib import Path
    from superclaw.daemon import HeartbeatDaemon
    cfg = tmp_path / "config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(cfg))
    cfg.write_text(json.dumps({"goal_autonomous_continuation": True}), encoding="utf-8")
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    repo = tmp_path / "operator-repo"
    repo.mkdir()
    daemon = HeartbeatDaemon(store=store, orchestrator=orch, repo_path=repo, default_budget_seconds=999)
    _confirm(store, [{"source": "backend", "role": None, "backend": "alpha"}])

    captured = {}
    real_start = goal_mode.start_confirmed_goal_run

    def spy_start(orchestrator, record, **kwargs):
        captured.update(kwargs)
        return real_start(orchestrator, record, **kwargs)

    monkeypatch.setattr(goal_mode, "start_confirmed_goal_run", spy_start)
    daemon.tick_goal_continuation(max_goals=5)
    assert Path(captured["repo_path"]) == repo            # operator repo, not cwd
    assert captured["budget_seconds"] == 999              # daemon budget, not 60
    assert captured["artifact_dir"] == daemon.artifact_dir


# --- PR9: fan-out-node consensus topologies (EXPLORE_FANOUT / REVIEW_CONSENSUS) ---


def test_consensus_topologies_require_budget(tmp_path):
    import pytest
    store = StateStore(tmp_path / "state.db")
    for topo in (TaskTopology.REVIEW_CONSENSUS, TaskTopology.EXPLORE_FANOUT):
        rec = goal_mode.plan_goal(store, title="t", description="d", topology=topo)
        with pytest.raises(ValueError, match="requires a token budget"):
            goal_mode.confirm_goal(store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash)
        confirmed = goal_mode.confirm_goal(
            store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
            roster={"entries": [{"source": "backend", "role": None, "backend": "alpha"}]},
            budget={"token_budget": 3000},
        )
        assert confirmed.status == "active"
        assert store.goal_budget_snapshot(rec.goal_id)["total_tokens"] == 3000


def test_review_consensus_binds_reviewer_role_and_settles_actual(tmp_path):
    # PR9 multi-agent consensus: the 3 review branches run on the ROLE-BOUND reviewer
    # (beta) with its bound model + effort (NOT the lead alpha / its runtime), and each
    # branch settles to its ACTUAL token cost (well under the reserved slice).
    store = StateStore(tmp_path / "state.db")
    alpha, beta = _RecordingBackend("alpha"), _CostBackend("beta", 100)
    orch = SuperClawOrchestrator(store, backends={"alpha": alpha, "beta": beta})
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.REVIEW_CONSENSUS)
    confirmed = goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        roster={"entries": [
            {"source": "backend", "role": None, "backend": "alpha"},
            {"source": "backend", "role": "review", "backend": "beta", "model": "m-rev", "effort": "high"},
        ]},
        budget={"token_budget": 9000},  # per-worker slice = 9000/3 = 3000, far above actual
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert store.get_goal_record(rec.goal_id).status in ("complete", "blocked")
    # the 3 review branches ran on beta with ITS bound model + effort, never on the lead.
    review_on_beta = [(m, e) for r, m, e in beta.seen if r == "review"]
    assert len(review_on_beta) == 3
    assert all(m == "m-rev" and e == "high" for m, e in review_on_beta)
    assert not any(r == "review" for r, _m, _e in alpha.seen)
    # actual settle: spent reflects REAL child spend (small), not 3 * 3000 reserved.
    snap = store.goal_budget_snapshot(rec.goal_id)
    assert snap["reserved_tokens"] == 0
    assert 0 < snap["spent_tokens"] < 3 * 3000  # booked actual, not the conservative reserve
    # the consensus aggregation report was produced on the parent (root) run
    root_run_id = next(r.run_id for r in store.list_runs() if r.goal_id == rec.goal_id and not r.parent_run_id)
    assert any(f.name == "subagent_fanout" for f in store.get_evidence(root_run_id).findings)

def test_fanout_node_all_or_nothing_denies_when_budget_too_small(tmp_path):
    # per-worker slice == total, so only the first of 3 review branches can reserve; the
    # all-or-nothing gate denies the whole fan-out (no degraded consensus, no overspend).
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"alpha": _RecordingBackend("alpha")})
    rec = goal_mode.plan_goal(store, title="t", description="d", topology=TaskTopology.REVIEW_CONSENSUS)
    confirmed = goal_mode.confirm_goal(
        store, rec.goal_id, expected_revision=rec.revision, plan_hash=rec.plan_hash,
        roster={"entries": [{"source": "backend", "role": None, "backend": "alpha"}]},
        budget={"token_budget": 100, "per_worker_tokens": 100},
    )
    goal_mode.start_confirmed_goal_run(orch, confirmed, repo_path=str(tmp_path), budget_seconds=30)
    assert store.get_goal_record(rec.goal_id).status == "blocked"
    snap = store.goal_budget_snapshot(rec.goal_id)
    assert snap["reserved_tokens"] == 0  # the denied reservations were released
    assert snap["spent_tokens"] + snap["reserved_tokens"] <= snap["total_tokens"]
