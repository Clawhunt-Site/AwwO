"""Orchestrator integration for the B-class escalation gate (Direction 4 P0/D1).

A worker that requests a gated action (via the escalation gate the orchestrator
wires onto WorkerLimits) suspends the run to WAITING_FOR_HUMAN_GATE with a durable
PENDING escalation instead of failing; resume re-enters the suspended task and the
gate consumes the grant once approved. Without approval the run stays suspended
(fail-closed) and does not spawn duplicate pendings.
"""

from __future__ import annotations

from superclaw.backends import LocalShellBackend
from superclaw.escalation import EscalationDenied, EscalationStatus
from superclaw.models import GoalSpec, RunStatus, TaskGraph, TaskNode, WorkerRole
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


class _GatedShellBackend(LocalShellBackend):
    """Local backend that, on the IMPLEMENT task, asks the escalation gate to permit
    a shell action — exactly what a real B-class _exec_tool would do for run_shell.
    Mirrors _exec_tool: an EscalationDenied (sticky human deny) becomes a refused
    action the worker proceeds past, NOT a re-suspend."""

    name = "esc-local"

    def __init__(self) -> None:
        super().__init__()
        self.gate_calls = 0
        self.denied = False

    def run(self, task, goal, session, limits):
        if task.role == WorkerRole.IMPLEMENT:
            self.gate_calls += 1
            assert limits.escalation_gate is not None, "orchestrator must wire the gate"
            try:
                limits.escalation_gate("run_shell", {"command": "echo hi"}, None)  # raises if no grant
            except EscalationDenied:
                self.denied = True  # refused — proceed without the action (like a denial string)
        return super().run(task, goal, session, limits)


def _start(tmp_path, backend):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"esc-local": backend})
    goal = store.create_goal(GoalSpec(title="Gated", description="exercise the escalation gate"))
    session = orch.create_run_session(
        goal, dry_run=False, backend_policy="esc-local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    return store, orch, goal, session


def _execute(orch, goal, session, tmp_path):
    return orch.execute_existing_session(
        goal, session, dry_run=False, backend_policy="esc-local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )


def test_run_suspends_on_escalation_then_resumes_after_approval(tmp_path):
    backend = _GatedShellBackend()
    store, orch, goal, session = _start(tmp_path, backend)

    result = _execute(orch, goal, session, tmp_path)

    # Suspended, not failed.
    assert result.session.status == RunStatus.WAITING_FOR_HUMAN_GATE.value
    assert backend.gate_calls == 1
    event_types = [e["type"] for e in store.list_events(session.run_id)]
    assert "escalation.requested" in event_types
    assert "run.waiting_for_human_gate" in event_types

    pending = store.list_escalations(status="pending")
    assert len(pending) == 1
    env = pending[0]
    assert env.run_id == session.run_id
    assert env.tool_name == "run_shell"

    # Approve, then resume → the gate consumes the grant → the run completes.
    store.resolve_escalation(
        env.request_id, decision_option_id="approve", approver="local_user", principal="local_user"
    )
    resumed = orch.resume_run(session.run_id)
    assert resumed.session.status == RunStatus.COMPLETED.value
    assert backend.gate_calls == 2  # re-entered the suspended IMPLEMENT task
    assert store.get_escalation(env.request_id).status == EscalationStatus.CONSUMED.value
    # No NEW escalation was created on resume (the grant authorized the exact action).
    assert len(store.list_escalations()) == 1


def test_run_stays_suspended_without_approval_and_dedups_pending(tmp_path):
    backend = _GatedShellBackend()
    store, orch, goal, session = _start(tmp_path, backend)

    _execute(orch, goal, session, tmp_path)
    assert store.get_run(session.run_id).status == RunStatus.WAITING_FOR_HUMAN_GATE.value
    assert len(store.list_escalations(status="pending")) == 1

    # Resume WITHOUT approving: re-runs, gate finds no grant, reuses the open pending
    # (no duplicate), and suspends again — fail-closed.
    resumed = orch.resume_run(session.run_id)
    assert resumed.session.status == RunStatus.WAITING_FOR_HUMAN_GATE.value
    assert len(store.list_escalations(status="pending")) == 1  # deduped, not spawned anew


def test_denied_action_is_sticky_and_not_reprompted_on_resume(tmp_path):
    # A human DENY must be sticky: after deny + resume the action is refused (the
    # worker proceeds without it), NOT re-prompted into another suspend.
    backend = _GatedShellBackend()
    store, orch, goal, session = _start(tmp_path, backend)
    _execute(orch, goal, session, tmp_path)
    env = store.list_escalations(status="pending")[0]
    store.resolve_escalation(
        env.request_id, decision_option_id="deny", approver="local_user", principal="local_user"
    )

    resumed = orch.resume_run(session.run_id)
    assert resumed.session.status == RunStatus.COMPLETED.value  # ran to completion, action refused
    assert backend.denied is True
    # deny is sticky — no NEW pending was spawned on resume
    assert store.list_escalations(status="pending") == []


class _SelectiveGateBackend(LocalShellBackend):
    """Escalates only on the task whose title contains 'gated'; completes others."""

    name = "esc-local"

    def run(self, task, goal, session, limits):
        if "gated" in task.title:
            assert limits.escalation_gate is not None
            limits.escalation_gate("run_shell", {"command": "echo hi"}, None)
        return super().run(task, goal, session, limits)


def test_parallel_frontier_records_completed_sibling_when_one_escalates(tmp_path):
    # In a parallel frontier, one task escalates while a sibling completes. The
    # sibling's result must be recorded (not lost / re-run on resume); only the
    # escalated task is reset to pending. Guards the concurrency race.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"esc-local": _SelectiveGateBackend()})
    goal = store.create_goal(GoalSpec(title="Parallel", description="two independent tasks"))
    session = orch.create_run_session(
        goal, dry_run=False, backend_policy="esc-local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    # Replace the default linear graph with two INDEPENDENT tasks so both enter the
    # frontier together and run under the parallel path (concurrency=2).
    graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[
            TaskNode(task_id="free", role=WorkerRole.IMPLEMENT, title="free task"),
            TaskNode(task_id="gated", role=WorkerRole.IMPLEMENT, title="gated shell task"),
        ],
    )
    graph.validate()
    session.task_graph = graph
    store.save_run(session)

    result = orch.execute_existing_session(
        goal, session, dry_run=False, backend_policy="esc-local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts", concurrency=2,
    )

    assert result.session.status == RunStatus.WAITING_FOR_HUMAN_GATE.value
    final = store.get_run(session.run_id).task_graph
    by_id = {t.task_id: t for t in final.tasks}
    assert by_id["free"].status == "completed"  # sibling recorded, not lost
    assert by_id["gated"].status == "pending"   # escalated task reset for resume
    pending = store.list_escalations(status="pending")
    assert len(pending) == 1
    assert pending[0].tool_name == "run_shell"
