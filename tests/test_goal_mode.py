"""PR2 — Goal Mode planner + lifecycle driver + CLI (docs/goal-mode-design.md).

Covers the kernel seam (materialize plan / plan_goal / confirm / revise / cancel /
start_confirmed_goal_run) and the `superclaw goal ...` CLI that is its baseline
surface. The run-start is exercised with an injected fake orchestrator so these
tests stay pure and fast (no real backend execution).
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw import goal_mode
from superclaw.cli import app
from superclaw.models import GoalSpec, GoalStatus, TaskTopology
from superclaw.state import GoalRevisionConflict, StateStore


def _spec(title: str = "ship the widget") -> GoalSpec:
    return GoalSpec(title=title, description="make it work")


# --- pure planner -----------------------------------------------------------


def test_materialize_goal_plan_emits_role_slots():
    plan = goal_mode.materialize_goal_plan(_spec(), topology=TaskTopology.LINEAR)
    assert plan["topology"] == TaskTopology.LINEAR.value
    assert plan["slots"], "a plan must have at least one slot"
    slot = plan["slots"][0]
    assert {"task_id", "role", "title", "depends_on"} <= set(slot)


def test_compute_plan_hash_is_stable_and_sensitive():
    plan = goal_mode.materialize_goal_plan(_spec(), topology=TaskTopology.LINEAR)
    assert goal_mode.compute_plan_hash(plan) == goal_mode.compute_plan_hash(plan)
    mutated = dict(plan, topology="changed")
    assert goal_mode.compute_plan_hash(plan) != goal_mode.compute_plan_hash(mutated)


# --- plan -> confirm lifecycle ----------------------------------------------


def test_plan_goal_parks_awaiting_confirmation_with_plan(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    assert record.status == GoalStatus.AWAITING_CONFIRMATION.value
    assert record.revision == 1
    assert record.plan and record.plan_hash
    # persisted
    assert store.get_goal_record(record.goal_id).status == GoalStatus.AWAITING_CONFIRMATION.value


def test_confirm_goal_moves_to_active_and_stamps_roster(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {"entries": [{"source": "backend", "backend": "claude", "model": None, "effort": None}]}
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
    )
    assert confirmed.status == GoalStatus.ACTIVE.value
    assert confirmed.revision == 2
    assert confirmed.roster == roster


def test_confirm_goal_rejects_stale_plan_hash(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    with pytest.raises(ValueError, match="plan hash mismatch"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=1, plan_hash="sha256:wrong"
        )


def test_confirm_goal_rejects_wrong_status(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    goal_mode.cancel_goal(store, record.goal_id, expected_revision=1)
    with pytest.raises(ValueError, match="not awaiting_confirmation"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=2, plan_hash=record.plan_hash
        )


def test_confirm_goal_rejects_concurrent_revision(tmp_path):
    # The plan_hash matches but another writer already advanced the revision —
    # the CAS in update_goal_record must fail closed.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    with pytest.raises(GoalRevisionConflict):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=0, plan_hash=record.plan_hash
        )


def test_revise_rolls_back_to_draft_then_replan(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    revised = goal_mode.revise_goal(store, record.goal_id, expected_revision=1)
    assert revised.status == GoalStatus.DRAFT.value
    assert revised.revision == 2


def test_toctou_confirm_after_revise_is_rejected(tmp_path):
    # A confirmation carrying the old plan_hash after a revise must be rejected.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    old_hash = record.plan_hash
    goal_mode.revise_goal(store, record.goal_id, expected_revision=1)
    with pytest.raises(ValueError, match="not awaiting_confirmation"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=2, plan_hash=old_hash
        )


# --- run start (injected fake orchestrator) ---------------------------------


class _FakeRunResult:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class _FakeOrchestrator:
    def __init__(self, store):
        self.store = store
        self.calls = []

    def run_existing_goal(self, goal, **kwargs):
        self.calls.append((goal, kwargs))
        return _FakeRunResult(**kwargs)


def test_start_confirmed_goal_run_pins_linear_and_serial(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash
    )
    fake = _FakeOrchestrator(store)
    goal_mode.start_confirmed_goal_run(fake, confirmed)
    assert len(fake.calls) == 1
    goal_arg, kwargs = fake.calls[0]
    assert goal_arg.goal_id == record.goal_id  # run linked to the goal (1:N)
    assert kwargs["task_topology"] == TaskTopology.LINEAR
    assert kwargs["concurrency"] == 1


def test_start_uses_confirmed_roster_runtime_not_caller(tmp_path):
    # The runtime is the one the goal was CONFIRMED with (its roster), never a
    # separately-passed value — approved A, executed A (铁律2).
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {"entries": [{"source": "backend", "backend": "codex", "model": "gpt-x", "effort": "high"}]}
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
    )
    fake = _FakeOrchestrator(store)
    goal_mode.start_confirmed_goal_run(fake, confirmed)
    _goal, kwargs = fake.calls[0]
    assert kwargs["backend_policy"] == "codex"
    assert kwargs["model"] == "gpt-x"
    assert kwargs["effort"] == "high"


def test_start_confirmed_goal_run_requires_active(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")  # awaiting_confirmation
    fake = _FakeOrchestrator(store)
    with pytest.raises(ValueError, match="not active"):
        goal_mode.start_confirmed_goal_run(fake, record)


def test_start_takes_atomic_revision_claim(tmp_path):
    # Start re-reads the goal fresh and bumps the revision as an atomic claim, so a
    # concurrent second start loses the CAS instead of double-creating a run.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash
    )
    assert confirmed.revision == 2
    fake = _FakeOrchestrator(store)
    goal_mode.start_confirmed_goal_run(fake, confirmed)
    assert store.get_goal_record(record.goal_id).revision == 3  # claim bumped revision


def test_start_rejects_stale_record_after_cancel(tmp_path):
    # A goal cancelled between the caller's read and start must not run — start
    # re-reads the live ledger, not the caller's stale active copy.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    stale_active = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash
    )
    goal_mode.cancel_goal(store, record.goal_id, expected_revision=2)  # another writer cancels
    fake = _FakeOrchestrator(store)
    with pytest.raises(ValueError, match="not active"):
        goal_mode.start_confirmed_goal_run(fake, stale_active)


def test_confirm_rejects_two_lead_roster(tmp_path):
    # PR4 allows multi-entry rosters, but two role-less (lead) entries are ambiguous.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {"entries": [{"source": "backend", "backend": "a"}, {"source": "backend", "backend": "b"}]}
    with pytest.raises(ValueError, match="more than one lead"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
        )


def test_validate_topology_executable_fails_closed_on_missing():
    from superclaw.models import GoalRecord

    # missing plan entirely
    rec = GoalRecord.new(_spec())
    with pytest.raises(ValueError, match="not executable"):
        goal_mode._validate_topology_executable(rec)
    # plan present but no topology key
    rec.plan = {"slots": []}
    with pytest.raises(ValueError, match="not executable"):
        goal_mode._validate_topology_executable(rec)


def test_implement_fanout_requires_token_budget():
    # PR7 hard gate: a concurrent topology is only executable with a token budget.
    from superclaw.models import GoalRecord, TaskTopology

    rec = GoalRecord.new(_spec())
    rec.plan = {"topology": TaskTopology.IMPLEMENT_FANOUT.value, "slots": []}
    with pytest.raises(ValueError, match="requires a token budget"):
        goal_mode._validate_topology_executable(rec)
    # with a budget it is executable
    rec.budget_policy = {"token_budget": 1000}
    goal_mode._validate_topology_executable(rec)  # no raise


def test_start_refuses_duplicate_while_run_live(tmp_path):
    # A confirmed goal is started at most once while a run is live — retry resumes,
    # it does not duplicate (confirm→start crash idempotency).
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash
    )
    # a live (non-terminal) run already exists for this goal
    store.create_run(confirmed.goal_id)
    fake = _FakeOrchestrator(store)
    with pytest.raises(ValueError, match="already has a live run"):
        goal_mode.start_confirmed_goal_run(fake, confirmed)


def test_replan_from_draft_remateralizes_and_changes_hash(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    old_hash = record.plan_hash
    goal_mode.revise_goal(store, record.goal_id, expected_revision=1)  # -> draft (rev 2)
    replanned = goal_mode.replan_goal(
        store, record.goal_id, expected_revision=2, description="new direction"
    )
    assert replanned.status == GoalStatus.AWAITING_CONFIRMATION.value
    assert replanned.revision == 3
    assert replanned.plan_hash != old_hash  # description change -> new plan hash
    assert replanned.spec.description == "new direction"


def test_replan_rejects_terminal_goal(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    goal_mode.cancel_goal(store, record.goal_id, expected_revision=1)
    with pytest.raises(ValueError, match="only a draft"):
        goal_mode.replan_goal(store, record.goal_id, expected_revision=2)


# --- CLI baseline -----------------------------------------------------------


def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))


def test_cli_goal_plan_inspect_confirm_no_start(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    runner = CliRunner()

    planned = runner.invoke(app, ["goal", "plan", "build a thing", "--description", "do it"])
    assert planned.exit_code == 0, planned.output
    record = json.loads(planned.output)
    assert record["status"] == GoalStatus.AWAITING_CONFIRMATION.value
    goal_id = record["spec"]["goal_id"]
    plan_hash = record["plan_hash"]

    shown = runner.invoke(app, ["goal", "inspect", goal_id])
    assert shown.exit_code == 0
    assert json.loads(shown.output)["spec"]["goal_id"] == goal_id

    # --no-start just flips to active without running a backend
    confirmed = runner.invoke(
        app,
        ["goal", "confirm", goal_id, "--revision", "1", "--plan-hash", plan_hash, "--no-start"],
    )
    assert confirmed.exit_code == 0, confirmed.output
    assert json.loads(confirmed.output)["status"] == GoalStatus.ACTIVE.value


def test_cli_goal_confirm_rejects_bad_plan_hash(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "build a thing"])
    goal_id = json.loads(planned.output)["spec"]["goal_id"]
    bad = runner.invoke(
        app,
        ["goal", "confirm", goal_id, "--revision", "1", "--plan-hash", "sha256:nope", "--no-start"],
    )
    assert bad.exit_code == 1
    assert "plan hash mismatch" in bad.output


def test_cli_goal_list_and_cancel(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "build a thing"])
    goal_id = json.loads(planned.output)["spec"]["goal_id"]

    listed = runner.invoke(app, ["goal", "list", "--status", GoalStatus.AWAITING_CONFIRMATION.value])
    assert listed.exit_code == 0
    assert any(r["spec"]["goal_id"] == goal_id for r in json.loads(listed.output))

    cancelled = runner.invoke(app, ["goal", "cancel", goal_id, "--revision", "1"])
    assert cancelled.exit_code == 0
    assert json.loads(cancelled.output)["status"] == GoalStatus.CANCELLED.value


def test_cli_revise_replan_confirm_loop(monkeypatch, tmp_path):
    # The full replan loop must not dead-end: plan -> revise (draft) -> replan
    # (awaiting again, fresh hash) -> confirm.
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "build a thing"])
    goal_id = json.loads(planned.output)["spec"]["goal_id"]

    revised = runner.invoke(app, ["goal", "revise", goal_id, "--revision", "1"])
    assert revised.exit_code == 0
    assert json.loads(revised.output)["status"] == GoalStatus.DRAFT.value

    replanned = runner.invoke(
        app, ["goal", "replan", goal_id, "--revision", "2", "--description", "v2"]
    )
    assert replanned.exit_code == 0, replanned.output
    rec = json.loads(replanned.output)
    assert rec["status"] == GoalStatus.AWAITING_CONFIRMATION.value
    new_hash = rec["plan_hash"]

    confirmed = runner.invoke(
        app, ["goal", "confirm", goal_id, "--revision", "3", "--plan-hash", new_hash, "--no-start"]
    )
    assert confirmed.exit_code == 0, confirmed.output
    assert json.loads(confirmed.output)["status"] == GoalStatus.ACTIVE.value


def test_cli_goal_start_picks_up_active_goal(monkeypatch, tmp_path):
    # `goal confirm --no-start` then `goal start` is a valid two-step — an active
    # goal must be startable (no liveness dead-end). We dry-run to avoid a real
    # backend; the command must succeed and report a run.
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "build a thing"])
    rec = json.loads(planned.output)
    goal_id = rec["spec"]["goal_id"]
    plan_hash = rec["plan_hash"]
    runner.invoke(
        app,
        ["goal", "confirm", goal_id, "--revision", "1", "--plan-hash", plan_hash, "--no-start"],
    )
    started = runner.invoke(app, ["goal", "start", goal_id, "--dry"])
    assert started.exit_code == 0, started.output
    assert json.loads(started.output)["run"]["goal_id"] == goal_id


# --- PR4: multi-agent roster allocator (role binding) -----------------------


def _roles(plan):
    return goal_mode._plan_roles(plan)


def test_roster_allocator_binds_agent_per_role(tmp_path):
    # A lead covers most slots; an explicit role entry binds a different agent to one
    # slot. start projects this into goal_slot_runtimes so each serial slot runs on
    # its bound agent.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roles = _roles(record.plan)
    assert "implement" in roles
    roster = {
        "entries": [
            {"source": "backend", "role": None, "backend": "claude"},  # lead
            {"source": "backend", "role": "implement", "backend": "codex", "model": "gpt-5.5", "effort": "high"},
        ]
    }
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
    )
    fake = _FakeOrchestrator(store)
    goal_mode.start_confirmed_goal_run(fake, confirmed)
    _, kwargs = fake.calls[0]
    assert kwargs["backend_policy"] == "claude"  # run base = lead
    slot_runtimes = kwargs["execution_context_extra"]["goal_slot_runtimes"]
    # implement is bound to codex; the others fall back to the lead (claude).
    assert slot_runtimes["implement"] == {"backend": "codex", "model": "gpt-5.5", "effort": "high"}
    assert slot_runtimes["explore"]["backend"] == "claude"
    assert set(slot_runtimes) == set(roles)


def test_roster_coverage_failure_is_rejected(tmp_path):
    # No lead and an uncovered role → fail closed, naming the unbound roles.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {"entries": [{"source": "backend", "role": "implement", "backend": "codex"}]}
    with pytest.raises(goal_mode.GoalRosterError, match="does not cover"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
        )


def test_roster_duplicate_role_is_rejected(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {
        "entries": [
            {"source": "backend", "role": None, "backend": "claude"},
            {"source": "backend", "role": "implement", "backend": "codex"},
            {"source": "backend", "role": "implement", "backend": "grok"},
        ]
    }
    with pytest.raises(goal_mode.GoalRosterError, match="more than one roster entry"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
        )


def test_roster_unknown_role_is_rejected(tmp_path):
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {
        "entries": [
            {"source": "backend", "role": None, "backend": "claude"},
            {"source": "backend", "role": "deploy", "backend": "codex"},  # not a plan role
        ]
    }
    with pytest.raises(goal_mode.GoalRosterError, match="not a slot in the plan"):
        goal_mode.confirm_goal(
            store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
        )


def test_single_lead_roster_back_compat(tmp_path):
    # PR2/PR3 single-entry (no role) roster still works: every slot gets the lead.
    store = StateStore(tmp_path / "s.db")
    record = goal_mode.plan_goal(store, title="t", description="d")
    roster = {"entries": [{"source": "backend", "backend": "codex", "model": "gpt-x"}]}
    confirmed = goal_mode.confirm_goal(
        store, record.goal_id, expected_revision=1, plan_hash=record.plan_hash, roster=roster
    )
    fake = _FakeOrchestrator(store)
    goal_mode.start_confirmed_goal_run(fake, confirmed)
    _, kwargs = fake.calls[0]
    slot_runtimes = kwargs["execution_context_extra"]["goal_slot_runtimes"]
    assert all(rt["backend"] == "codex" for rt in slot_runtimes.values())


def test_cli_confirm_assign_binds_agent_per_slot(monkeypatch, tmp_path):
    # CLI parity with the kernel allocator: --assign binds an agent to a plan slot.
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "ship it"])
    assert planned.exit_code == 0, planned.output
    rec = json.loads(planned.output)
    goal_id = rec["spec"]["goal_id"]
    plan_hash = rec["plan_hash"]
    confirmed = runner.invoke(
        app,
        [
            "goal", "confirm", goal_id,
            "--revision", "1", "--plan-hash", plan_hash,
            "--backend", "claude",
            "--assign", "role=implement,backend=codex,model=gpt-5.5,effort=high",
            "--no-start",
        ],
    )
    assert confirmed.exit_code == 0, confirmed.output
    roster = json.loads(confirmed.output)["roster"]["entries"]
    impl = [e for e in roster if e.get("role") == "implement"]
    assert impl and impl[0]["backend"] == "codex" and impl[0]["model"] == "gpt-5.5"


def test_cli_confirm_assign_requires_role(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "x"])
    rec = json.loads(planned.output)
    res = runner.invoke(
        app,
        [
            "goal", "confirm", rec["spec"]["goal_id"],
            "--revision", "1", "--plan-hash", rec["plan_hash"],
            "--assign", "backend=codex",  # no role=
            "--no-start",
        ],
    )
    assert res.exit_code != 0


def test_cli_confirm_fanout_with_budget(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    runner = CliRunner()
    planned = runner.invoke(app, ["goal", "plan", "ship it", "--topology", "implement_fanout"])
    assert planned.exit_code == 0, planned.output
    rec = json.loads(planned.output)
    gid, plan_hash = rec["spec"]["goal_id"], rec["plan_hash"]
    # no budget -> rejected
    no_budget = runner.invoke(
        app, ["goal", "confirm", gid, "--revision", "1", "--plan-hash", plan_hash, "--no-start"]
    )
    assert no_budget.exit_code != 0
    confirmed = runner.invoke(
        app,
        ["goal", "confirm", gid, "--revision", "1", "--plan-hash", plan_hash, "--token-budget", "2000", "--no-start"],
    )
    assert confirmed.exit_code == 0, confirmed.output
    assert json.loads(confirmed.output)["budget_policy"]["token_budget"] == 2000


def test_cli_goal_autonomy_and_continue(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path)
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    runner = CliRunner()
    # default OFF
    shown = runner.invoke(app, ["goal", "autonomy"])
    assert shown.exit_code == 0 and json.loads(shown.output)["goal_autonomous_continuation"] is False
    enabled = runner.invoke(app, ["goal", "autonomy", "--enable"])
    assert json.loads(enabled.output)["goal_autonomous_continuation"] is True
    # continue tick (no confirmed goals) -> empty
    cont = runner.invoke(app, ["goal", "continue"])
    assert cont.exit_code == 0 and json.loads(cont.output)["continued"] == []
