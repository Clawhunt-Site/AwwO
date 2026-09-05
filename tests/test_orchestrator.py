import json
import socket
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

import superclaw.orchestrator as orchestrator_module
from superclaw.backends import LocalShellBackend, WorkerLimits, default_backends
from superclaw.cross_runtime_delegation import DelegationRequest, DelegationRequested
from superclaw.models import (
    AgentProfile,
    ArtifactRef,
    ChainVerdict,
    ChildAggregationPolicy,
    CostEvent,
    GoalSpec,
    Issue,
    IssueStatus,
    PRIMARY_EVIDENCE_TRUNCATED_FINDING,
    RunSession,
    RunStatus,
    TaskGraph,
    TaskNode,
    TaskTopology,
    WorkerResult,
    WorkerRole,
)
from superclaw.models import RunMutationLease, RunMutationMode
from superclaw.orchestrator import RUN_MUTATION_LEASE_TTL_SECONDS, SuperClawOrchestrator
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore


def test_bind_agent_identity_attaches_envelope_without_prepending_goal(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    goal = GoalSpec(title="Ship", description="User task only")
    session = RunSession(
        goal_id=goal.goal_id,
        run_id="run_prompt_identity",
        execution_context={
            "agent_run_context": {
                "agent_name": "Roadmap Worker",
                "agent_role": "implementer",
                "agent_charter": "Stable charter.",
                "model": "profile-model",
                "effort": "high",
            }
        },
    )
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    bound_goal, bound_limits = orchestrator._bind_agent_identity(session, goal, limits)

    assert bound_goal.description == "User task only"
    assert "# You are a member of an Agent Team" not in bound_goal.description
    assert bound_limits.model_override == "profile-model"
    # effort projects onto the same governed channel as model (effort_override).
    assert bound_limits.effort_override == "high"
    assert bound_limits.prompt_envelope is not None
    charter = bound_limits.prompt_envelope.get("agent_charter")
    assert charter is not None
    assert "Roadmap Worker" in charter.content
    assert "Stable charter." in charter.content


def test_issue_equipment_constraints_tristate():
    """The per-fire constraint derivation preserves None vs [] per axis."""
    f = orchestrator_module._issue_equipment_constraints
    # No metadata / no routine_context key → no narrowing (inherit).
    assert f(Issue(title="x")) == (None, None)
    assert f(Issue(title="x", metadata={})) == (None, None)
    # A PRESENT but garbled whole block (not an object) fails CLOSED to nothing,
    # NOT inherit-everything — a corrupt scoping directive scopes to zero.
    assert f(Issue(title="x", metadata={"routine_context": "bad"})) == (frozenset(), frozenset())
    # Present axes: ids → set; explicit [] → EMPTY frozenset (distinct from None).
    p, s = f(Issue(title="x", metadata={"routine_context": {"plugin_ids": ["p1", "p2"], "skill_ids": []}}))
    assert p == frozenset({"p1", "p2"})
    assert s == frozenset()  # explicit zero, NOT None
    # Absent axis stays None even when the other axis is present.
    p2, s2 = f(Issue(title="x", metadata={"routine_context": {"plugin_ids": []}}))
    assert p2 == frozenset()
    assert s2 is None


def test_issue_equipment_constraints_malformed_axis_fails_closed():
    """A present-but-malformed axis (a non-list, non-null value from corrupt /
    tampered state) narrows to NOTHING (empty set), never silently inherits the
    agent's full grants."""
    f = orchestrator_module._issue_equipment_constraints
    # plugin_ids is a string (garbage) → fail-closed empty; skill_ids absent → None.
    p, s = f(Issue(title="x", metadata={"routine_context": {"plugin_ids": "git"}}))
    assert p == frozenset()  # NOT None (would be an amplification)
    assert s is None
    # A dict garbage axis also fails closed.
    p2, _ = f(Issue(title="x", metadata={"routine_context": {"plugin_ids": {"bad": 1}}}))
    assert p2 == frozenset()
    # An explicit null axis is still treated as inherit (absent), not fail-closed.
    p3, _ = f(Issue(title="x", metadata={"routine_context": {"plugin_ids": None}}))
    assert p3 is None


def test_run_goal_threads_issue_routine_context_into_run_context(tmp_path, monkeypatch):
    """run_goal derives the per-fire equipment caps FROM the bound issue (intrinsic,
    not a caller argument) and feeds them to build_agent_run_context — so a manual
    rerun of the same routine issue cannot bypass the narrowing."""
    import superclaw.team_kernel as tk

    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    profile = AgentProfile(
        name="Eng", role="engineer", backend_policy="local", plugin_allowlist=["p1", "p2"],
    )
    store.save_agent_profile(profile)
    issue = store.save_issue(
        Issue(
            title="routine work",
            company_profile_id=profile.company_profile_id,
            workspace_id=profile.workspace_id,
            assignee_agent_profile_id=profile.profile_id,
            status=IssueStatus.TODO.value,
            metadata={"routine_context": {"plugin_ids": ["p1"], "skill_ids": []}},
        )
    )
    captured: dict = {}
    real = tk.build_agent_run_context

    def _spy(store_, prof, **kw):
        captured.update(kw)
        return real(store_, prof, **kw)

    monkeypatch.setattr(tk, "build_agent_run_context", _spy)
    # Stop before real backend execution — we only assert the context wiring.
    monkeypatch.setattr(orch, "execute_existing_session", lambda *a, **k: None)

    orch.run_goal(
        title="t", description="d", backend_policy="local", repo_path=tmp_path,
        budget_seconds=5, agent_profile_id=profile.profile_id,
        execution_context_extra={"issue_id": issue.issue_id},
    )

    assert captured.get("issue_plugin_constraint") == frozenset({"p1"})
    assert captured.get("issue_skill_constraint") == frozenset()  # explicit [] → empty set


def test_bind_agent_identity_skips_projection_on_backend_mismatch(tmp_path):
    """The ctx model/effort (the profile's OWN values) must NOT be projected onto a
    run whose actual backend differs from the profile's — they are runtime-specific.
    This is the shared choke point that protects both forced root runs and
    cross-runtime children (build_agent_run_context bakes the profile values in)."""
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    goal = GoalSpec(title="Ship", description="task")
    # Run forced onto gemini, but the bound profile context is for codex.
    session = RunSession(
        goal_id=goal.goal_id,
        run_id="run_mismatch",
        execution_context={
            "backend_policy": "gemini",
            "agent_run_context": {
                "agent_name": "Eng",
                "agent_role": "engineer",
                "backend_policy": "codex",
                "model": "gpt-5.5",
                "effort": "high",
            },
        },
    )
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    _, bound = orchestrator._bind_agent_identity(session, goal, limits)
    # Confirmed mismatch (gemini run vs codex profile) → neither leaks onto the run.
    assert bound.model_override is None
    assert bound.effort_override is None

    # Matching backend → the profile's values DO project (normal profile run).
    session.execution_context["backend_policy"] = "codex"
    _, bound_match = orchestrator._bind_agent_identity(session, goal, limits)
    assert bound_match.model_override == "gpt-5.5"
    assert bound_match.effort_override == "high"


def test_root_run_profile_effort_gated_on_forced_backend(tmp_path):
    """A root run bound to a profile but FORCED onto a different backend must not
    inherit the profile's (runtime-specific) model/effort into its execution context."""
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    profile = AgentProfile(name="Eng", role="engineer", backend_policy="codex", model="gpt-5.5", effort="high")
    store.save_agent_profile(profile)
    goal = store.create_goal(GoalSpec(title="Forced", description="run on a different backend"))
    # Force the run onto 'local' (≠ codex) while binding the codex profile.
    result = orchestrator.run_existing_goal(
        goal, dry_run=True, backend_policy="local", agent_profile_id=profile.profile_id,
        repo_path=tmp_path, budget_seconds=10, artifact_dir=tmp_path / "artifacts",
    )
    ctx = result.session.execution_context
    # The forced backend did not inherit codex's model/effort (would be unhonored there).
    assert ctx.get("model") is None
    assert ctx.get("effort") is None


def _run_session_for_lease(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Lease", description="Run mutation lease behavior"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    store.create_evidence(session.run_id)
    return store, orchestrator, session


def test_orchestrator_reclaims_abandoned_expired_run_mutation_lease(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:crashed",
        mode=RunMutationMode.EXECUTE,
        acquired_at=time.time() - (RUN_MUTATION_LEASE_TTL_SECONDS + 60),
    )
    store.save_run(session)

    acquired = orchestrator._try_acquire_run_mutation(store.get_run(session.run_id), mode=RunMutationMode.RESUME)
    assert acquired is not None  # abandoned lease reclaimed instead of blocking forever
    _, runtime_lease, run_lease = acquired
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.lease.stale" in event_types
    assert "run.lease.acquired" in event_types
    orchestrator._release_run_mutation(session.run_id, runtime_lease=runtime_lease, lease=run_lease)


def test_orchestrator_thread_registry_helpers_are_synchronized(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    ready = threading.Barrier(4)
    errors: list[BaseException] = []

    def register(index: int) -> None:
        try:
            thread = threading.Thread(target=lambda: None)
            ready.wait(timeout=2)
            orchestrator._register_run_thread(f"run-{index}", thread)
            assert orchestrator._run_thread(f"run-{index}") is thread
        except BaseException as exc:  # pragma: no cover - reported below
            errors.append(exc)

    workers = [threading.Thread(target=register, args=(index,)) for index in range(3)]
    for worker in workers:
        worker.start()
    ready.wait(timeout=2)
    for worker in workers:
        worker.join(timeout=2)

    assert errors == []


def test_run_start_budget_preflight_blocks_exceeded_agent_before_start_or_issue_mutation(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", token_budget=10))
    issue = store.save_issue(
        Issue(
            title="budgeted work",
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=profile.profile_id,
        )
    )
    store.record_cost_event(
        CostEvent(idempotency_key="agent-spend", agent_profile_id=profile.profile_id, input_tokens=10)
    )
    goal = store.create_goal(GoalSpec(title="Budget", description="blocked before runtime starts"))

    result = orchestrator.run_existing_goal(
        goal,
        dry_run=True,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        agent_profile_id=profile.profile_id,
        execution_context_extra={"issue_id": issue.issue_id, "company_profile_id": profile.company_profile_id},
    )

    event_types = [event["type"] for event in store.list_events_snapshot(result.session.run_id)]
    persisted_run = store.get_run(result.session.run_id)
    persisted_issue = store.get_issue(issue.issue_id)
    assert result.session.status == RunStatus.FAILED.value
    assert persisted_run.active_mutation_lease is None
    assert persisted_run.execution_context["budget_preflight"]["reason_code"] == "budget_limit_exceeded"
    assert "run.budget_blocked" in event_types
    assert "run.started" not in event_types
    assert "worker.planned" not in event_types
    assert "task.started" not in event_types
    assert persisted_issue.status == IssueStatus.TODO.value
    assert persisted_issue.checkout_run_id is None


def test_run_start_budget_preflight_allows_report_only_chat_scope(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    store.record_cost_event(CostEvent(idempotency_key="chat-spend", chat_session_id="chat_1", input_tokens=10))
    goal = store.create_goal(GoalSpec(title="Budget", description="report-only budget does not block"))

    result = orchestrator.run_existing_goal(
        goal,
        dry_run=True,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        chat_session_id="chat_1",
        execution_context_extra={
            "budget_policy": {
                "scopes": [
                    {
                        "scope": "chat",
                        "cost_governed": False,
                        "hard_limits": {"token_budget": 1},
                    }
                ]
            }
        },
    )

    event_types = [event["type"] for event in store.list_events_snapshot(result.session.run_id)]
    assert result.session.status == RunStatus.COMPLETED.value
    assert "run.started" in event_types
    assert "worker.planned" in event_types
    assert "run.budget_blocked" not in event_types


class _DelegatingBackend(LocalShellBackend):
    name = "gemini"

    def __init__(self, *, runtime: str | None = "local") -> None:
        super().__init__()
        self.runtime = runtime
        self.calls = 0

    def run(self, task, goal, session, limits):
        self.calls += 1
        raise DelegationRequested(
            request=DelegationRequest(
                subtask="inspect the repo and report status",
                runtime=self.runtime,
                budget_seconds=5,
            ),
            parent_tool_call_id="delegate-call-1",
        )


class _ContinuationAwareDelegatingBackend(_DelegatingBackend):
    def run(self, task, goal, session, limits):
        approved = [
            item
            for item in (session.execution_context or {}).get("delegate_tool_results", [])
            if item.get("request_key") == "tool:delegate-call-1" and item.get("status") == "approved"
        ]
        if approved:
            self.calls += 1
            return WorkerResult(
                task_id=task.task_id,
                role=task.role.value,
                backend=self.name,
                command="delegate-continuation",
                exit_code=0,
                output=f"continued with child {approved[0]['child_run_id']}",
                duration_seconds=0.01,
                attempt_index=max(1, int(session.task_attempts.get(task.task_id, 1))),
            )
        return super().run(task, goal, session, limits)


class _StreamingChildBackend(LocalShellBackend):
    name = "stream-child"
    surfaces_live_tools = True

    def run(self, task, goal, session, limits):
        if limits.event_sink:
            limits.event_sink(
                "tool.started",
                {"task_id": task.task_id, "backend": self.name, "tool": "stream-child"},
        )
        return super().run(task, goal, session, limits)


class _BlockingChildBackend(LocalShellBackend):
    name = "blocking-child"

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def run(self, task, goal, session, limits):
        self.started.set()
        self.release.wait(timeout=5)
        return super().run(task, goal, session, limits)


def _wait_for_delegated_child_result(store: StateStore, parent_run_id: str, *, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        parent = store.get_run(parent_run_id)
        results = (parent.execution_context or {}).get("delegate_tool_results") or []
        if results:
            return results[0]
        time.sleep(0.05)
    raise AssertionError("delegated child did not produce a parent-visible tool result")


def test_orchestrator_delegate_request_spawns_child_and_waits(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    backend = _DelegatingBackend()
    orchestrator = SuperClawOrchestrator(store, backends={"gemini": backend, "local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="Delegate", description="parent delegates"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="delegate-parent", role=WorkerRole.IMPLEMENT, title="delegate once")],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    parent = store.get_run(session.run_id)
    assert len(parent.child_executions) == 1
    wait = parent.execution_context["child_delegation_waits"][0]
    assert wait["request_key"] == "tool:delegate-call-1"
    assert wait["child_run_id"] == parent.child_executions[0].child_run_id
    child = store.get_run(wait["child_run_id"])
    assert child.execution_context["delegation_depth"] == 1
    assert child.execution_context["origin_run_id"] == session.run_id
    assert child.execution_context["parent_tool_call_id"] == "delegate-call-1"
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "delegation.child_spawned" in event_types
    assert "run.waiting_for_child_delegation" in event_types
    assert "child_run.event" in event_types

    tool_result = _wait_for_delegated_child_result(store, session.run_id)
    assert tool_result["status"] == "pending_review"
    assert tool_result["tool_call_id"] == "delegate-call-1"

    resumed = orchestrator.resume_run(session.run_id)
    assert resumed.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert len(store.get_run(session.run_id).child_executions) == 1
    assert "run.resume.blocked" in [event["type"] for event in store.list_events(session.run_id)]


def test_orchestrator_delegate_result_requires_review_before_parent_continues(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    backend = _ContinuationAwareDelegatingBackend()
    orchestrator = SuperClawOrchestrator(store, backends={"gemini": backend, "local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="Delegate review", description="parent resumes only after review"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="delegate-parent", role=WorkerRole.IMPLEMENT, title="delegate once")],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    pending_result = _wait_for_delegated_child_result(store, session.run_id)
    assert pending_result["status"] == "pending_review"

    blocked = orchestrator.resume_run(session.run_id)
    assert blocked.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert backend.calls == 1

    approved = orchestrator.review_child_delegation_result(
        session.run_id,
        "tool:delegate-call-1",
        approved=True,
        reviewed_by="qa",
    )
    assert approved["status"] == "approved"

    resumed = orchestrator.resume_run(session.run_id)
    assert resumed.session.status == RunStatus.COMPLETED.value
    assert backend.calls == 2
    parent = store.get_run(session.run_id)
    stored_result = parent.execution_context["delegate_tool_results"][0]
    assert stored_result["status"] == "approved"
    assert stored_result["review"]["reviewed_by"] == "qa"
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "delegation.tool_result.pending_review" in event_types
    assert "delegation.tool_result.approved" in event_types


def test_orchestrator_child_terminal_sync_is_idempotent_after_review(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    backend = _ContinuationAwareDelegatingBackend()
    orchestrator = SuperClawOrchestrator(store, backends={"gemini": backend, "local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="Delegate sync", description="child sync preserves review"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="delegate-parent", role=WorkerRole.IMPLEMENT, title="delegate once")],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    pending_result = _wait_for_delegated_child_result(store, session.run_id)
    child_run_id = pending_result["child_run_id"]
    approved = orchestrator.review_child_delegation_result(
        session.run_id,
        "tool:delegate-call-1",
        approved=True,
        reviewed_by="qa",
    )
    assert approved["status"] == "approved"

    child = store.get_run(child_run_id)
    orchestrator._sync_child_execution_to_parent(child)
    orchestrator._sync_child_execution_to_parent(child)

    parent = store.get_run(session.run_id)
    results = parent.execution_context["delegate_tool_results"]
    waits = parent.execution_context["child_delegation_waits"]
    assert [item["request_key"] for item in results].count("tool:delegate-call-1") == 1
    assert results[0]["status"] == "approved"
    assert results[0]["review"]["reviewed_by"] == "qa"
    assert waits[0]["tool_result_status"] == "approved"
    assert waits[0]["status"] == "review_approved"
    assert parent.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value

    events = store.list_events(session.run_id)
    assert [event["type"] for event in events].count("delegation.tool_result.pending_review") == 1
    parent_evidence = store.get_evidence(session.run_id)
    child_artifacts = [
        artifact
        for artifact in parent_evidence.artifacts
        if artifact.kind == "child-evidence" and artifact.metadata.get("child_run_id") == child_run_id
    ]
    assert len(child_artifacts) == 1


def test_orchestrator_delegate_result_rejection_fails_parent_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(
        store,
        backends={"gemini": _ContinuationAwareDelegatingBackend(), "local": LocalShellBackend()},
    )
    goal = store.create_goal(GoalSpec(title="Delegate reject", description="reject child result"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="delegate-parent", role=WorkerRole.IMPLEMENT, title="delegate once")],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    pending_result = _wait_for_delegated_child_result(store, session.run_id)
    assert pending_result["status"] == "pending_review"

    rejected = orchestrator.review_child_delegation_result(
        session.run_id,
        "tool:delegate-call-1",
        approved=False,
        reviewed_by="qa",
    )

    assert rejected["status"] == "rejected"
    parent = store.get_run(session.run_id)
    assert parent.status == RunStatus.FAILED.value
    assert parent.execution_context["delegate_tool_results"][0]["status"] == "rejected"
    evidence = store.get_evidence(session.run_id)
    assert any(finding.name == "cross_runtime_delegation_review" for finding in evidence.findings)
    with pytest.raises(ValueError, match="not resumable"):
        orchestrator.resume_run(session.run_id)


def test_orchestrator_resume_blocks_while_delegated_child_is_running(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    child_backend = _BlockingChildBackend()
    parent_backend = _DelegatingBackend(runtime="blocking-child")
    orchestrator = SuperClawOrchestrator(
        store,
        backends={"gemini": parent_backend, "blocking-child": child_backend},
    )
    goal = store.create_goal(GoalSpec(title="Delegate running", description="child still running"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="delegate-parent", role=WorkerRole.IMPLEMENT, title="delegate once")],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert child_backend.started.wait(timeout=5)

    blocked = orchestrator.resume_run(session.run_id)
    assert blocked.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert parent_backend.calls == 1
    events = store.list_events(session.run_id)
    assert any(
        event["type"] == "run.resume.blocked"
        and event["payload"].get("reason") == "delegated child is still running"
        for event in events
    )
    child_backend.release.set()
    _wait_for_delegated_child_result(store, session.run_id)


def test_orchestrator_parallel_delegate_request_spawns_one_child_and_waits(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    backend = _DelegatingBackend(runtime="stream-child")
    orchestrator = SuperClawOrchestrator(
        store,
        backends={"gemini": backend, "stream-child": _StreamingChildBackend()},
    )
    goal = store.create_goal(GoalSpec(title="Parallel delegate", description="parallel parent delegates"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        concurrency=2,
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[
            TaskNode(task_id="p1", role=WorkerRole.IMPLEMENT, title="parallel delegate 1"),
            TaskNode(task_id="p2", role=WorkerRole.IMPLEMENT, title="parallel delegate 2"),
        ],
    )
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        concurrency=2,
    )

    assert result.session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    parent = store.get_run(session.run_id)
    assert len(parent.child_executions) == 1
    assert parent.execution_context["child_delegation_waits"][0]["child_run_id"] == parent.child_executions[0].child_run_id

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        child_events = [
            event
            for event in store.list_events(session.run_id)
            if event["type"] == "child_run.event" and event["payload"].get("event_type") == "tool.started"
        ]
        if child_events:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("parent did not receive nested child worker events")


def test_orchestrator_delegate_runtime_none_denies_without_child(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator_module, "delegation_enabled", lambda: True)
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(
        store,
        backends={"gemini": _DelegatingBackend(runtime=None), "local": LocalShellBackend()},
    )
    goal = store.create_goal(GoalSpec(title="Delegate", description="parent delegates without runtime"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="gemini",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == RunStatus.FAILED.value
    assert store.get_run(session.run_id).child_executions == []
    assert "delegation.denied" in [event["type"] for event in store.list_events(session.run_id)]


def test_orchestrator_ignores_fresh_run_mutation_lease(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )  # acquired_at defaults to now -> fresh
    store.save_run(session)

    acquired = orchestrator._try_acquire_run_mutation(store.get_run(session.run_id), mode=RunMutationMode.RESUME)
    assert acquired is None  # fresh lease => active writer => ignored
    assert store.get_run(session.run_id).active_mutation_lease is not None
    assert "run.resume.ignored" in [event["type"] for event in store.list_events(session.run_id)]


def test_orchestrator_reconcile_ignores_fresh_persisted_run_mutation_lease(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )
    store.save_run(session)

    reconcile = orchestrator.reconcile_run(session.run_id)
    persisted = store.get_run(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]

    assert reconcile.classification == "active_writer"
    assert reconcile.resumable is False
    assert persisted.status == "running"
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.owner == "execute:live"
    assert "run.reconcile.ignored" in event_types
    assert "run.lease.stale" not in event_types


def test_orchestrator_resume_does_not_steal_fresh_persisted_run_mutation_lease(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )
    store.save_run(session)

    resumed = orchestrator.resume_run(session.run_id)
    persisted = store.get_run(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]

    assert resumed.run_id == session.run_id
    assert resumed.status == "running"
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.owner == "execute:live"
    assert "run.reconcile.ignored" in event_types
    assert "run.resume.ignored" in event_types
    assert "run.lease.stale" not in event_types


def test_orchestrator_does_not_steal_expired_lease_from_live_runtime_holder(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:long-running",
        mode=RunMutationMode.EXECUTE,
        acquired_at=time.time() - (RUN_MUTATION_LEASE_TTL_SECONDS + 60),
    )
    store.save_run(session)

    # A live writer still holds the in-process runtime lock for this run.
    with orchestrator.locks.acquire(f"run:{session.run_id}", owner="live-writer"):
        acquired = orchestrator._try_acquire_run_mutation(store.get_run(session.run_id), mode=RunMutationMode.RESUME)

    assert acquired is None  # never steal from a live runtime-lock holder
    assert store.get_run(session.run_id).active_mutation_lease is not None  # persisted lease untouched


def test_non_runtime_error_escaping_execution_closes_out_run_and_propagates(tmp_path, monkeypatch):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    goal = store.get_goal(session.goal_id)

    def explode(*args, **kwargs):
        raise KeyError("unexpected execution bug")

    monkeypatch.setattr(orchestrator, "_assert_run_mutation_lease", explode)

    with pytest.raises(KeyError, match="unexpected execution bug"):
        orchestrator.execute_existing_session(
            goal,
            session,
            dry_run=False,
            backend_policy="local",
            repo_path=tmp_path,
            budget_seconds=20,
            artifact_dir=tmp_path / "artifacts",
        )

    latest = store.get_run(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    # The bug propagates to the caller, but the stored state never keeps
    # claiming the run is in progress and the lease is released.
    assert latest.status in {"queued", "failed"}
    assert latest.active_mutation_lease is None
    assert "run.interrupted" in event_types


def test_reconcile_stale_runs_converges_dead_executing_claims(tmp_path):
    store, orchestrator, session = _run_session_for_lease(tmp_path)
    session.status = "running"
    store.save_run(session)  # claims execution; no lease, no live thread

    fresh_goal = store.create_goal(GoalSpec(title="Fresh", description="live writer"))
    fresh = orchestrator.create_run_session(
        fresh_goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    store.create_evidence(fresh.run_id)
    fresh.status = "running"
    fresh.active_mutation_lease = RunMutationLease(
        resource=f"run:{fresh.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )
    store.save_run(fresh)

    queued_goal = store.create_goal(GoalSpec(title="Queued", description="awaiting executor"))
    queued = orchestrator.create_run_session(
        queued_goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    queued.status = "queued"
    store.save_run(queued)

    stale_ids = [run.run_id for run in orchestrator.list_stale_runs()]
    assert stale_ids == [session.run_id]

    results = orchestrator.reconcile_stale_runs()
    assert [result.run_id for result in results] == [session.run_id]
    healed = store.get_run(session.run_id)
    assert healed.status in {"queued", "failed"}
    # The live writer and the pending run are untouched.
    assert store.get_run(fresh.run_id).status == "running"
    assert store.get_run(queued.run_id).status == "queued"


def test_orchestrator_uses_state_store_run_mutation_lease_contract(tmp_path, monkeypatch):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    calls = {"acquire": 0, "require": 0, "release": 0}
    original_acquire = store.acquire_run_mutation_lease
    original_require = store.require_run_mutation_lease
    original_release = store.release_run_mutation_lease

    def acquire_spy(*args, **kwargs):
        calls["acquire"] += 1
        return original_acquire(*args, **kwargs)

    def require_spy(*args, **kwargs):
        calls["require"] += 1
        return original_require(*args, **kwargs)

    def release_spy(*args, **kwargs):
        calls["release"] += 1
        return original_release(*args, **kwargs)

    monkeypatch.setattr(store, "acquire_run_mutation_lease", acquire_spy)
    monkeypatch.setattr(store, "require_run_mutation_lease", require_spy)
    monkeypatch.setattr(store, "release_run_mutation_lease", release_spy)

    result = orchestrator.run_goal(
        title="Lease contract",
        description="Use the state-store lease contract.",
        dry_run=True,
    )

    event_types = [event["type"] for event in store.list_events(result.session.run_id)]
    assert result.session.status == "completed"
    assert calls["acquire"] == 1
    assert calls["require"] >= 1
    assert calls["release"] == 1
    assert "run.lease.acquired" in event_types
    assert "run.lease.released" in event_types


def test_orchestrator_releases_runtime_lock_when_state_store_lease_acquire_races(tmp_path, monkeypatch):
    store, orchestrator, session = _run_session_for_lease(tmp_path)

    def acquire_conflict(*args, **kwargs):
        raise ValueError("run mutation lease already held: test race")

    monkeypatch.setattr(store, "acquire_run_mutation_lease", acquire_conflict)

    acquired = orchestrator._try_acquire_run_mutation(store.get_run(session.run_id), mode=RunMutationMode.EXECUTE)

    assert acquired is None
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.execute.ignored" in event_types
    post_race_lease = orchestrator.locks.try_acquire(f"run:{session.run_id}", owner="after-race")
    assert post_race_lease is not None
    orchestrator.locks.release(post_race_lease)


def test_orchestrator_dry_run_creates_task_graph_and_partial_evidence(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Fix API",
        description="Find, implement, and verify the fix.",
        dry_run=True,
    )

    assert result.session.status == "completed"
    assert len(result.task_graph.tasks) >= 3
    assert result.evidence.chain_verdict == ChainVerdict.CHAIN_PARTIAL
    assert any(event["type"] == "run.verifying" for event in result.events)
    assert any(event["type"] == "verification.completed" for event in result.events)
    assert any(event["type"] == "run.completed" for event in result.events)


def test_terminal_run_revokes_its_run_tickets(tmp_path, monkeypatch):
    # Run-scoped ticket teardown (#2): when a run reaches a terminal status, the
    # orchestrator best-effort revokes every RunTicket bound to it (so a leaked
    # respond grant cannot outlive its run). We spy on the store to confirm the
    # terminal path calls it with THIS run's id.
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    revoked: list[str] = []
    original = store.revoke_run_tickets_for_run

    def spy(run_id, **kwargs):
        revoked.append(run_id)
        return original(run_id, **kwargs)

    monkeypatch.setattr(store, "revoke_run_tickets_for_run", spy)
    result = orchestrator.run_goal(
        title="Done",
        description="Reach terminal and revoke tickets.",
        dry_run=True,
    )
    assert result.session.status == "completed"
    assert result.session.run_id in revoked


def test_terminal_run_revoke_failure_does_not_crash(tmp_path, monkeypatch):
    # The revoke is best-effort: a store failure on the terminal path must NOT
    # crash the run (the verify-time terminal gate is the hard guarantee).
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)

    def boom(run_id, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(store, "revoke_run_tickets_for_run", boom)
    result = orchestrator.run_goal(
        title="Done",
        description="Terminal revoke fails but run still completes.",
        dry_run=True,
    )
    assert result.session.status == "completed"


def test_orchestrator_persists_verifier_findings_before_verification_completed(tmp_path):
    class FindingSnapshotStore(StateStore):
        def __init__(self, path):
            super().__init__(path)
            self.finding_names_at_verification_completed: list[str] = []

        def add_event(self, run_id, event_type, payload):
            if event_type == "verification.completed":
                self.finding_names_at_verification_completed = [
                    finding.name for finding in self.get_evidence(run_id).findings
                ]
            return super().add_event(run_id, event_type, payload)

    store = FindingSnapshotStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)

    result = orchestrator.run_goal(
        title="Persist verifier findings",
        description="Verifier findings must be durable before final verdict.",
        dry_run=True,
    )

    assert result.session.status == "completed"
    assert "command_backed_verification" in store.finding_names_at_verification_completed
    assert "non_happy_path_probe" in store.finding_names_at_verification_completed
    assert "command_backed_verification" in [finding.name for finding in store.get_evidence(result.session.run_id).findings]


def test_orchestrator_resume_verifying_run_after_restart_without_rerunning_workers(tmp_path):
    db_path = tmp_path / "state.db"
    store = StateStore(db_path)
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Verify restart", description="Resume from persisted verification stage"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    for task in session.task_graph.tasks:
        task.status = "completed"
    first_task = session.task_graph.tasks[0]
    session.status = "running"
    store.save_run(session)
    session.status = "verifying"
    store.save_run(session)
    evidence = store.create_evidence(session.run_id)
    evidence.add_probe("control_plane", 200, {"ok": True})
    evidence.add_command("pytest before verifier restart", 0, "1 passed")
    evidence.add_worker_result(
        WorkerResult(
            task_id=first_task.task_id,
            role=first_task.role.value,
            backend="local",
            command="pytest before verifier restart",
            exit_code=0,
            output="1 passed",
            duration_seconds=0.01,
            artifact_id="artifact_verify_restart",
            artifact_path=str(tmp_path / "artifacts" / session.run_id / "verify-restart.log"),
        )
    )
    evidence.add_artifact(
        ArtifactRef(
            kind="worker-log",
            path=str(tmp_path / "artifacts" / session.run_id / "verify-restart.log"),
            sensitivity="internal",
            artifact_id="artifact_verify_restart",
            metadata={"task_id": first_task.task_id, "backend": "local"},
        )
    )
    evidence.add_finding("pre_restart_verifier_snapshot", True, "verifier finding persisted before restart")
    store.save_evidence(evidence)
    store.add_event(session.run_id, "run.verifying", {"run_id": session.run_id, "verification_policy": "adversarial"})

    restarted_store = StateStore(db_path)
    restarted_orchestrator = SuperClawOrchestrator(restarted_store)

    resumed = restarted_orchestrator.resume_run(session.run_id)
    assert hasattr(resumed, "evidence")
    persisted_evidence = restarted_store.get_evidence(session.run_id)
    event_types = [event["type"] for event in restarted_store.list_events(session.run_id)]

    assert resumed.session.status == "completed"
    assert len(persisted_evidence.worker_results) == 1
    assert persisted_evidence.worker_results[0].artifact_id == "artifact_verify_restart"
    assert any(finding.name == "pre_restart_verifier_snapshot" for finding in persisted_evidence.findings)
    assert "run.reconciled" in event_types
    assert "run.resumed" in event_types
    assert "verification.completed" in event_types
    assert "run.completed" in event_types
    assert "task.started" not in event_types


def test_orchestrator_lock_prevents_duplicate_active_resource(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))

    with orchestrator.locks.acquire("repo:main", owner="run_a") as lease:
        assert lease.resource == "repo:main"
        assert not orchestrator.locks.try_acquire("repo:main", owner="run_b")

    assert orchestrator.locks.try_acquire("repo:main", owner="run_b")


def test_orchestrator_non_dry_run_executes_real_local_worker(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Run worker",
        description="Execute through local backend.",
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        permission_policy=PermissionPolicy.from_values(mode="plan", allowed_tools=["Read"]),
    )

    assert result.session.status == "completed"
    assert result.evidence.worker_results
    assert result.evidence.worker_results[0].backend == "local"
    assert result.evidence.worker_results[0].exit_code == 0
    assert all(command["command"] != "superclaw run --dry" for command in result.evidence.commands)
    assert any(event["type"] == "command.completed" for event in result.events)
    assert result.evidence.artifacts
    permission_requested = next(event for event in result.events if event["type"] == "permission.requested")
    permission_decided = next(event for event in result.events if event["type"] == "permission.decided")
    context_usage = next(event for event in result.events if event["type"] == "context.usage")
    assert permission_requested["payload"]["permission_policy"]["mode"] == "plan"
    assert permission_requested["payload"]["permission_policy"]["allowed_tools"] == ["Read"]
    assert permission_decided["payload"]["decision"] == "allowed"
    assert permission_decided["payload"]["decision_source"] == "execution_context"
    assert context_usage["payload"]["backend"] == "local"
    assert context_usage["payload"]["worker_result_count"] >= 1
    assert context_usage["payload"]["primary_output_chars"] > 0


def test_orchestrator_emits_batch_diagnostic_up_front_for_non_streaming_backend(tmp_path):
    # Display Protocol DL4: for a non-streaming (batch) backend, the orchestrator
    # discloses "batch, no live tools" UP FRONT — after command.started and before
    # the worker completes — so the surface isn't blank during execution. This is
    # the single delivery chokepoint that covers every non-streaming backend.
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Run worker",
        description="Execute through local backend.",
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    types = [event["type"] for event in result.events]
    assert "adapter.diagnostic" in types
    diag = next(event for event in result.events if event["type"] == "adapter.diagnostic")
    assert diag["payload"]["capability_tier"] == "batch"
    assert diag["payload"]["payload"]["streaming"] is False
    # emitted up front: after command.started, before the worker completes
    assert types.index("command.started") < types.index("adapter.diagnostic")
    assert types.index("adapter.diagnostic") < types.index("command.completed")


def test_orchestrator_skips_batch_diagnostic_for_streaming_backend(tmp_path):
    # A streaming backend (surfaces_live_tools=True) surfaces real tool.* via its
    # projector; the orchestrator must NOT emit the batch diagnostic for it, or it
    # would mislabel a streaming run as batch.
    class _StreamingBackend(LocalShellBackend):
        name = "codex-app-server"
        surfaces_live_tools = True

        def run(self, task, goal, session, limits):
            # mimic a streaming backend: returns without run_command, so no batch
            # diagnostic originates from the worker layer either.
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="codex stream",
                output="streamed output",
                exit_code=0,
                started_at=time.time(),
                finished_at=time.time(),
                duration=0.0,
            )

    orchestrator = SuperClawOrchestrator(
        StateStore(tmp_path / "state.db"),
        backends={"codex-app-server": _StreamingBackend()},
    )
    result = orchestrator.run_goal(
        title="Stream worker",
        description="Execute through a streaming backend.",
        dry_run=False,
        backend_policy="codex-app-server",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert all(event["type"] != "adapter.diagnostic" for event in result.events)


def test_orchestrator_emits_batch_diagnostic_for_parallel_frontier_backends(tmp_path):
    # DL4 regression (parallel path): concurrent non-streaming workers run via
    # _execute_frontier_parallel (pool.submit), NOT the sequential branch. They
    # must ALSO disclose "batch, no live tools" up front — one diagnostic per
    # task. Routing both paths through _run_backend guarantees this; a call-site
    # specific emit would miss the parallel frontier entirely.
    backend = _ConcurrencyTrackingBackend()
    orchestrator = SuperClawOrchestrator(
        StateStore(tmp_path / "state.db"), backends={"conc-track": backend, **default_backends()}
    )
    result = orchestrator.run_goal(
        title="Parallel frontier",
        description="Run the implement branches concurrently",
        dry_run=False,
        backend_policy="conc-track",
        repo_path=tmp_path,
        budget_seconds=30,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.IMPLEMENT_FANOUT,
        concurrency=2,
    )
    assert result.session.status == "completed"
    assert backend.peak >= 2  # confirm the parallel frontier path actually ran
    started = [event for event in result.events if event["type"] == "command.started"]
    diags = [event for event in result.events if event["type"] == "adapter.diagnostic"]
    assert len(started) >= 2  # at least the two concurrent implement branches
    # STRICT 1:1 — every delivery execution (each command.started) yields EXACTLY
    # one batch diagnostic. Catches a missed path (under-count) AND a double-emit
    # (over-count), which a `>= 2` lower bound would silently pass.
    assert len(diags) == len(started)
    assert all(diag["payload"]["capability_tier"] == "batch" for diag in diags)
    assert len({diag["id"] for diag in diags}) == len(diags)


def test_orchestrator_emits_evidence_finding_for_truncated_primary_output(tmp_path):
    class LongOutputBackend(LocalShellBackend):
        name = "long_output"

        def _default_command(self, task, goal):
            return [sys.executable, "-c", "print('worker-prefix-' + ('x' * 5005))"]

    orchestrator = SuperClawOrchestrator(
        StateStore(tmp_path / "state.db"),
        backends={"long_output": LongOutputBackend()},
    )
    result = orchestrator.run_goal(
        title="Run long output worker",
        description="Record truncation finding events.",
        dry_run=False,
        backend_policy="long_output",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    evidence_events = [
        event
        for event in result.events
        if event["type"] == "evidence.finding"
        and event["payload"]["name"] == PRIMARY_EVIDENCE_TRUNCATED_FINDING
    ]
    verification_events = [
        event
        for event in result.events
        if event["type"] == "verification.finding"
        and event["payload"]["name"] == PRIMARY_EVIDENCE_TRUNCATED_FINDING
    ]

    assert result.session.status == "completed"
    assert len(evidence_events) == len(result.task_graph.tasks)
    assert evidence_events[0]["payload"]["finding_kind"] == "metadata"
    assert evidence_events[0]["payload"]["input_fields"] == ["worker_results[].output"]
    assert verification_events == []


def test_orchestrator_persists_task_attempt_counters_across_execution(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Retry worker", description="Track task attempts"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    first_task_id = session.task_graph.tasks[0].task_id
    session.task_attempts[first_task_id] = 1
    store.save_run(session)

    result = orchestrator.execute_existing_session(
        goal,
        session,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    persisted = store.get_run(session.run_id)
    task_started = next(
        event for event in result.events
        if event["type"] == "task.started" and event["payload"]["task_id"] == first_task_id
    )

    assert result.session.status == "completed"
    assert result.evidence.worker_results[0].task_id == first_task_id
    assert result.evidence.worker_results[0].attempt_index == 2
    assert persisted.task_attempts[first_task_id] == 2
    assert task_started["payload"]["attempt_index"] == 2


def test_orchestrator_constrained_dag_executes_dependency_order_and_records_topology(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Run DAG worker",
        description="Execute through constrained DAG topology.",
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.IMPLEMENT_FANOUT,
    )

    assert result.session.status == "completed"
    assert result.session.execution_context["task_topology"] == TaskTopology.IMPLEMENT_FANOUT.value
    assert result.task_graph.tasks[4].depends_on == [result.task_graph.tasks[2].task_id, result.task_graph.tasks[3].task_id]
    assert len(result.evidence.worker_results) == 6
    started = {event["payload"]["task_id"]: event["payload"] for event in result.events if event["type"] == "task.started"}
    verify_payload = started[result.task_graph.tasks[4].task_id]
    assert verify_payload["depends_on"] == [result.task_graph.tasks[2].task_id, result.task_graph.tasks[3].task_id]
    evidence_payload = json.loads(Path(result.evidence.artifacts[-1].path).read_text(encoding="utf-8"))
    assert evidence_payload["chain_verdict"] == "CHAIN_PARTIAL"


def test_orchestrator_failed_worker_persists_verifying_stage_and_failed_terminal_event(tmp_path):
    class FailingBackend(LocalShellBackend):
        name = "failing"

        def _default_command(self, task, goal):
            return [sys.executable, "-c", "import sys; print('boom', flush=True); sys.exit(3)"]

    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"), backends={"failing": FailingBackend()})
    result = orchestrator.run_goal(
        title="Fail worker",
        description="Force a backend failure.",
        dry_run=False,
        backend_policy="failing",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == "failed"
    event_types = [event["type"] for event in result.events]
    assert "run.verifying" in event_types
    assert "verification.completed" in event_types
    assert "run.failed" in event_types
    assert result.evidence.chain_verdict == ChainVerdict.FAIL


def test_orchestrator_reconcile_stale_run_and_resume_remaining_tasks(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume worker", description="Continue after stale state"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "completed"
    session.task_graph.tasks[1].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)

    reconcile = orchestrator.reconcile_run(session.run_id)
    resumed = orchestrator.resume_run(session.run_id)
    reconciled_session = store.get_run(session.run_id)

    assert reconcile.classification == "resumable"
    assert reconcile.status == "queued"
    assert reconciled_session.status == "completed"
    assert any(event["type"] == "run.reconciled" for event in store.list_events(session.run_id))
    assert resumed.session.status == "completed"
    assert len(resumed.evidence.worker_results) == 4
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.reconciled" in event_types
    assert "run.resumed" in event_types


def test_orchestrator_resume_preserves_prior_worker_results_and_artifacts(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume evidence", description="Keep prior audit package"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    first_task_id = session.task_graph.tasks[0].task_id
    session.status = "running"
    session.task_graph.tasks[0].status = "completed"
    session.task_graph.tasks[1].status = "running"
    store.save_run(session)

    prior_artifact_path = str(tmp_path / "artifacts" / session.run_id / "prior-explore.log")
    evidence = store.create_evidence(session.run_id)
    evidence.add_worker_result(
        WorkerResult(
            task_id=first_task_id,
            role=WorkerRole.EXPLORE.value,
            backend="local",
            command="previous explore command",
            exit_code=0,
            output="previous explore output",
            duration_seconds=0.01,
            attempt_index=1,
            artifact_id="artifact_prior_explore",
            artifact_path=prior_artifact_path,
        )
    )
    evidence.add_artifact(
        ArtifactRef(
            kind="worker-log",
            path=prior_artifact_path,
            sensitivity="internal",
            artifact_id="artifact_prior_explore",
            metadata={"task_id": first_task_id, "backend": "local"},
        )
    )
    evidence.add_command("previous explore command", 0, "previous explore output")
    store.save_evidence(evidence)

    reconcile = orchestrator.reconcile_run(session.run_id)
    resumed = orchestrator.resume_run(session.run_id)
    persisted_evidence = store.get_evidence(session.run_id)
    evidence_artifact = next(artifact for artifact in persisted_evidence.artifacts if artifact.kind == "evidence-json")
    evidence_payload = json.loads(Path(evidence_artifact.path).read_text(encoding="utf-8"))

    assert reconcile.classification == "resumable"
    assert resumed.session.status == "completed"
    assert any(result.artifact_id == "artifact_prior_explore" for result in persisted_evidence.worker_results)
    assert any(artifact.artifact_id == "artifact_prior_explore" for artifact in persisted_evidence.artifacts)
    assert any(result.task_id != first_task_id for result in persisted_evidence.worker_results)
    assert "artifact_prior_explore" in {artifact["artifact_id"] for artifact in evidence_payload["artifacts"]}
    assert "artifact_prior_explore" in {result["artifact_id"] for result in evidence_payload["worker_results"]}
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.reconciled" in event_types
    assert "run.resumed" in event_types


def test_orchestrator_interrupt_resume_local_run_without_rerunning_completed_task(tmp_path):
    class InterruptingLocalBackend(LocalShellBackend):
        name = "interrupt-local"

        def run(self, task, goal, session, limits):
            if task.role == WorkerRole.PLAN:
                raise RuntimeError("simulated process interrupt after persisted task start")
            return super().run(task, goal, session, limits)

    class RecordingLocalBackend(LocalShellBackend):
        name = "interrupt-local"

        def __init__(self) -> None:
            super().__init__()
            self.roles: list[str] = []

        def run(self, task, goal, session, limits):
            self.roles.append(task.role.value)
            return super().run(task, goal, session, limits)

    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    goal = store.create_goal(GoalSpec(title="Interrupted local run", description="Resume after local process exit"))
    interrupted_orchestrator = SuperClawOrchestrator(store, backends={"interrupt-local": InterruptingLocalBackend()})
    session = interrupted_orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="interrupt-local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    first_task_id = session.task_graph.tasks[0].task_id

    with pytest.raises(RuntimeError, match="simulated process interrupt"):
        interrupted_orchestrator.execute_existing_session(
            goal,
            session,
            dry_run=False,
            backend_policy="interrupt-local",
            repo_path=tmp_path,
            budget_seconds=20,
            artifact_dir=tmp_path / "artifacts",
        )

    interrupted_session = store.get_run(session.run_id)
    interrupted_evidence = store.get_evidence(session.run_id)
    # The escaped exception must not leave a stored in-progress claim behind:
    # the run closes out to queued (resumable) and the in-flight task returns
    # to pending so deterministic resume can pick it up.
    assert interrupted_session.status == "queued"
    assert interrupted_session.task_graph is not None
    assert interrupted_session.task_graph.tasks[0].status == "completed"
    assert interrupted_session.task_graph.tasks[1].status == "pending"
    assert interrupted_session.active_mutation_lease is None
    assert "run.interrupted" in [event["type"] for event in store.list_events(session.run_id)]
    assert [result.task_id for result in interrupted_evidence.worker_results] == [first_task_id]

    resumed_backend = RecordingLocalBackend()
    restarted_store = StateStore(state_path)
    restarted_orchestrator = SuperClawOrchestrator(restarted_store, backends={"interrupt-local": resumed_backend})

    reconcile = restarted_orchestrator.reconcile_run(session.run_id)
    resumed = restarted_orchestrator.resume_run(session.run_id)
    persisted_evidence = restarted_store.get_evidence(session.run_id)
    worker_results_for_first_task = [result for result in persisted_evidence.worker_results if result.task_id == first_task_id]
    event_types = [event["type"] for event in restarted_store.list_events(session.run_id)]

    assert reconcile.classification == "resumable"
    assert reconcile.status == "queued"
    assert resumed.session.status == "completed"
    assert resumed_backend.roles == ["plan", "implement", "verify", "review"]
    assert len(worker_results_for_first_task) == 1
    assert len(persisted_evidence.worker_results) == 5
    assert "run.reconciled" in event_types
    assert "run.resumed" in event_types
    assert "run.completed" in event_types


def test_orchestrator_reconcile_reclaims_stale_run_mutation_lease(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume worker", description="Continue after stale state"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner=f"execute:{session.run_id}",
        mode=RunMutationMode.EXECUTE,
        acquired_at=time.time() - (RUN_MUTATION_LEASE_TTL_SECONDS + 60),
    )
    store.save_run(session)
    store.create_evidence(session.run_id)

    reconcile = orchestrator.reconcile_run(session.run_id)
    reconciled = store.get_run(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]

    assert reconcile.classification == "resumable"
    assert reconciled.active_mutation_lease is None
    assert "run.lease.stale" in event_types
    assert "run.lease.acquired" in event_types
    assert "run.lease.released" in event_types


def test_orchestrator_reconcile_reclaims_dead_worker_pid_lease_before_ttl(tmp_path, monkeypatch):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume worker", description="Continue after dead pid"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    dead_pid = 424242
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner=f"execute:{session.run_id}",
        mode=RunMutationMode.EXECUTE,
        worker_pid=dead_pid,
        worker_host=socket.gethostname(),
    )
    store.save_run(session)
    store.create_evidence(session.run_id)

    def fake_kill(pid, signal):
        assert signal == 0
        if pid == dead_pid:
            raise ProcessLookupError(pid)

    monkeypatch.setattr("superclaw.orchestrator.os.kill", fake_kill)

    reconcile = orchestrator.reconcile_run(session.run_id)
    reconciled = store.get_run(session.run_id)
    stale_event = next(event for event in store.list_events(session.run_id) if event["type"] == "run.lease.stale")

    assert reconcile.classification == "resumable"
    assert reconciled.active_mutation_lease is None
    assert stale_event["payload"]["worker_pid"] == dead_pid
    assert stale_event["payload"]["stale_reason"] == "worker process is no longer alive"


def test_orchestrator_reconcile_rejects_duplicate_active_writer(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Reconcile worker", description="Protect run mutation"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)

    with orchestrator.locks.acquire(f"run:{session.run_id}", owner="other-writer"):
        reconcile = orchestrator.reconcile_run(session.run_id)

    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert reconcile.classification == "active_writer"
    assert reconcile.resumable is False
    assert "run.reconcile.ignored" in event_types


def test_orchestrator_resume_ignores_duplicate_active_writer(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume worker", description="Protect run mutation"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    store.create_evidence(session.run_id)

    with orchestrator.locks.acquire(f"run:{session.run_id}", owner="other-writer"):
        resumed = orchestrator.resume_run(session.run_id)

    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert resumed.run_id == session.run_id
    assert resumed.status == "queued"
    assert "run.reconcile.ignored" in event_types
    assert "run.resume.ignored" in event_types


def test_orchestrator_reconcile_and_resume_constrained_dag_remaining_branches(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Resume DAG worker", description="Continue branched graph"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.IMPLEMENT_FANOUT,
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "completed"
    session.task_graph.tasks[1].status = "completed"
    session.task_graph.tasks[2].status = "completed"
    session.task_graph.tasks[3].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)

    reconcile = orchestrator.reconcile_run(session.run_id)
    resumed = orchestrator.resume_run(session.run_id)

    assert reconcile.classification == "resumable"
    assert reconcile.status == "queued"
    assert resumed.session.status == "completed"
    assert len(resumed.evidence.worker_results) == 3
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.reconciled" in event_types
    assert "run.resumed" in event_types


def test_orchestrator_reconcile_fails_closed_when_resume_evidence_missing(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Missing evidence", description="Do not resume blind"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "completed"
    session.task_graph.tasks[1].status = "running"
    store.save_run(session)

    reconcile = orchestrator.reconcile_run(session.run_id)

    assert reconcile.classification == "failed_closed"
    assert reconcile.resumable is False
    assert reconcile.status == "failed"
    assert "evidence bundle is missing or unreadable" in reconcile.detail
    assert store.get_run(session.run_id).status == "failed"
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.failed" in event_types
    with pytest.raises(KeyError):
        store.get_evidence(session.run_id)
    with pytest.raises(ValueError, match="not resumable"):
        orchestrator.resume_run(session.run_id)


def test_orchestrator_reconcile_fails_closed_when_resume_evidence_unreadable(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Unreadable evidence", description="Do not resume blind"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "completed"
    session.task_graph.tasks[1].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)
    with sqlite3.connect(store.path) as conn:
        conn.execute("UPDATE evidence SET payload = ? WHERE run_id = ?", ("{not-json", session.run_id))

    reconcile = orchestrator.reconcile_run(session.run_id)

    assert reconcile.classification == "failed_closed"
    assert reconcile.resumable is False
    assert reconcile.status == "failed"
    assert "evidence bundle is missing or unreadable" in reconcile.detail
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "run.failed" in event_types


def test_orchestrator_reconcile_fails_closed_when_resume_frontier_missing(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Broken run", description="Cannot resume"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    session.execution_context = {}
    if session.task_graph is not None:
        session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)

    reconcile = orchestrator.reconcile_run(session.run_id)
    evidence = store.get_evidence(session.run_id)

    assert reconcile.classification == "failed_closed"
    assert reconcile.status == "failed"
    assert any(finding.name == "stale_run_unrecoverable" for finding in evidence.findings)


def test_orchestrator_reconcile_finalizes_stale_cancelled_run_from_cancel_event(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Cancelled run", description="Cancellation should persist"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)
    store.add_event(session.run_id, "run.cancel.requested", {"run_id": session.run_id})

    reconcile = orchestrator.reconcile_run(session.run_id)
    latest = store.get_run(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]

    assert reconcile.classification == "cancelled"
    assert reconcile.resumable is False
    assert latest.status == "cancelled"
    assert latest.task_graph is not None
    assert latest.task_graph.tasks[0].status == "pending"
    assert "run.reconciled" in event_types
    assert "run.cancelled" in event_types


def test_orchestrator_reconcile_preserves_cancelled_run_after_restart(tmp_path):
    db_path = tmp_path / "state.db"
    store = StateStore(db_path)
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Restarted cancel", description="Cancellation survives restart"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    evidence = store.create_evidence(session.run_id)
    evidence.add_command("cancel requested before restart", 130, "operator cancelled")
    store.save_evidence(evidence)
    store.add_event(session.run_id, "run.cancel.requested", {"run_id": session.run_id})

    restarted_store = StateStore(db_path)
    restarted_orchestrator = SuperClawOrchestrator(restarted_store)

    reconcile = restarted_orchestrator.reconcile_run(session.run_id)
    latest = restarted_store.get_run(session.run_id)
    persisted_evidence = restarted_store.get_evidence(session.run_id)
    event_types = [event["type"] for event in restarted_store.list_events(session.run_id)]

    assert reconcile.classification == "cancelled"
    assert reconcile.status == "cancelled"
    assert reconcile.resumable is False
    assert latest.status == "cancelled"
    assert latest.task_graph is not None
    assert latest.task_graph.tasks[0].status == "pending"
    assert persisted_evidence.commands[0]["command"] == "cancel requested before restart"
    assert "run.reconciled" in event_types
    assert "run.cancelled" in event_types
    with pytest.raises(ValueError, match="not resumable"):
        restarted_orchestrator.resume_run(session.run_id)


def test_orchestrator_reconcile_finalizes_stale_cancelled_run_from_worker_evidence(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Cancelled worker", description="Use evidence fallback"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    evidence = store.create_evidence(session.run_id)
    evidence.worker_results.append(
        WorkerResult(
            task_id=session.task_graph.tasks[0].task_id,
            role=session.task_graph.tasks[0].role.value,
            backend="local",
            command="echo cancelled",
            exit_code=130,
            output="cancelled",
            duration_seconds=0.1,
            cancelled=True,
        )
    )
    store.save_evidence(evidence)

    reconcile = orchestrator.reconcile_run(session.run_id)

    assert reconcile.classification == "cancelled"
    assert reconcile.status == "cancelled"
    assert store.get_run(session.run_id).status == "cancelled"


def test_orchestrator_cancel_kills_active_worker_process(tmp_path):
    class SlowBackend(LocalShellBackend):
        name = "slow"

        def _default_command(self, task, goal):
            return [sys.executable, "-c", "import time; print('slow-start', flush=True); time.sleep(10)"]

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"slow": SlowBackend()})
    goal = store.create_goal(GoalSpec(title="Cancel worker", description="Stop an active worker process"))
    session = orchestrator.start_existing_goal(
        goal,
        dry_run=False,
        backend_policy="slow",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    # Generous timeouts so real-subprocess cancellation stays reliable under load.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(event["type"] == "command.started" for event in store.list_events(session.run_id)):
            break
        time.sleep(0.05)
    else:
        raise AssertionError("worker command did not start")

    latest = store.get_run(session.run_id)
    latest.status = "cancelled"
    store.save_run(latest)
    store.add_event(session.run_id, "run.cancel.requested", {"run_id": session.run_id})

    thread = orchestrator._threads[session.run_id]
    thread.join(timeout=30)

    assert not thread.is_alive()
    assert store.get_run(session.run_id).status == "cancelled"
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "worker.cancelled" in event_types
    assert "run.cancelled" in event_types
    evidence = store.get_evidence(session.run_id)
    assert evidence.worker_results[0].cancelled is True
    assert evidence.worker_results[0].exit_code == 130
    assert any(finding.name == "worker_cancelled" for finding in evidence.findings)


def test_orchestrator_fails_closed_when_run_mutation_lease_is_lost_mid_execution(tmp_path):
    class LeaseLosingBackend(LocalShellBackend):
        name = "lease-loss"

        def __init__(self, store: StateStore) -> None:
            super().__init__()
            self._store = store

        def run(self, task, goal, session, limits):
            latest = self._store.get_run(session.run_id)
            latest.active_mutation_lease = None
            self._store.save_run(latest)
            return super().run(task, goal, session, limits)

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"lease-loss": LeaseLosingBackend(store)})
    result = orchestrator.run_goal(
        title="Lease loss",
        description="Fail closed when mutation lease disappears.",
        dry_run=False,
        backend_policy="lease-loss",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    event_types = [event["type"] for event in store.list_events(result.session.run_id)]
    evidence = store.get_evidence(result.session.run_id)

    assert result.session.status == "failed"
    assert "run.lease.lost" in event_types
    assert "run.failed" in event_types
    assert any(finding.name == "run_mutation_lease" for finding in evidence.findings)


def test_orchestrator_spawn_child_run_persists_parent_child_contract_and_evidence(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent worker", description="Spawn a child run"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)

    child = orchestrator.spawn_child_run(
        parent_run_id=session.run_id,
        parent_task_id=session.task_graph.tasks[0].task_id,
        title="Child worker",
        description="Execute through child orchestration.",
        backend_policy="local",
    )

    parent_session = store.get_run(session.run_id)
    parent_evidence = store.get_evidence(session.run_id)
    parent_events = store.list_events(session.run_id)

    assert child.session.parent_run_id == session.run_id
    assert child.session.parent_task_id == session.task_graph.tasks[0].task_id
    assert child.session.depth == 1
    assert child.session.execution_context["child_task_id"].startswith("childtask_")
    assert child.session.status == "completed"
    assert parent_session.child_executions
    assert parent_session.child_executions[0].child_run_id == child.session.run_id
    assert parent_session.child_executions[0].status == "completed"
    assert parent_session.child_executions[0].chain_verdict == child.evidence.chain_verdict.value
    assert parent_evidence.child_executions[0].child_run_id == child.session.run_id
    assert any(artifact.kind == "child-evidence" for artifact in parent_evidence.artifacts)
    assert any(event["type"] == "child_run.spawned" for event in parent_events)
    assert any(event["type"] == "child_run.completed" for event in parent_events)
    assert any(event["type"] == "child_evidence.added" for event in parent_events)


def test_orchestrator_rejects_recursive_child_spawn_beyond_depth_one(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent worker", description="Spawn a child run"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)

    child = orchestrator.spawn_child_run(
        parent_run_id=session.run_id,
        parent_task_id=session.task_graph.tasks[0].task_id,
        title="Child worker",
        description="Execute through child orchestration.",
        backend_policy="local",
    )
    assert child.session.task_graph is not None
    child_session = store.get_run(child.session.run_id)

    try:
        orchestrator.spawn_child_run(
            parent_run_id=child.session.run_id,
            parent_task_id=child_session.task_graph.tasks[0].task_id,
            title="Grandchild worker",
            description="This should be rejected.",
            backend_policy="local",
        )
    except ValueError as exc:
        assert "depth limit" in str(exc)
    else:
        raise AssertionError("expected depth-limit failure for child-of-child spawn")


def test_orchestrator_parent_cancel_propagates_to_active_child_run(tmp_path):
    class SlowBackend(LocalShellBackend):
        name = "slow"

        def _default_command(self, task, goal):
            return [sys.executable, "-c", "import time; print('slow-child', flush=True); time.sleep(10)"]

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"slow": SlowBackend()})
    goal = store.create_goal(GoalSpec(title="Parent worker", description="Spawn a child run"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="slow",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    assert session.task_graph is not None
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)

    child_result: list[object] = []

    def run_child() -> None:
        child_result.append(
            orchestrator.spawn_child_run(
                parent_run_id=session.run_id,
                parent_task_id=session.task_graph.tasks[0].task_id,
                title="Child worker",
                description="Execute through child orchestration.",
                backend_policy="slow",
            )
        )

    thread = threading.Thread(target=run_child, daemon=True)
    thread.start()

    # Generous timeouts so real-subprocess child cancellation stays reliable under load.
    deadline = time.monotonic() + 30
    child_run_id = None
    while time.monotonic() < deadline:
        latest_parent = store.get_run(session.run_id)
        if latest_parent.child_executions:
            child_run_id = latest_parent.child_executions[0].child_run_id
            if any(event["type"] == "command.started" for event in store.list_events(child_run_id)):
                break
        time.sleep(0.05)
    else:
        raise AssertionError("child run command did not start")

    cancel = orchestrator.cancel_run(session.run_id)
    thread.join(timeout=30)

    assert cancel.accepted is True
    assert child_run_id is not None
    child_session = store.get_run(child_run_id)
    child_evidence = store.get_evidence(child_run_id)
    parent_session = store.get_run(session.run_id)
    parent_events = store.list_events(session.run_id)

    assert not thread.is_alive()
    assert child_result
    assert child_result[0].session.status == "cancelled"
    assert child_session.status == "cancelled"
    assert parent_session.child_executions[0].status == "cancelled"
    # Either the parent's recursive cancel or the child's parent-status poll can
    # win. Both record propagation, on the run that first observes the request.
    child_events = store.list_events(child_run_id)
    assert any(
        event["type"] == "run.cancel.propagated"
        and event["payload"].get("run_id") == session.run_id
        and event["payload"].get("child_run_id") == child_run_id
        and event["payload"].get("accepted") is True
        for event in parent_events
    ) or any(
        event["type"] == "run.cancel.propagated"
        and event["payload"].get("run_id") == child_run_id
        and event["payload"].get("parent_run_id") == session.run_id
        and event["payload"].get("parent_task_id") == session.task_graph.tasks[0].task_id
        for event in child_events
    )
    assert any(event["type"] == "child_run.cancelled" for event in parent_events)
    assert child_evidence.worker_results[0].cancelled is True


def _live_session_at_depth(store, orchestrator, goal, tmp_path, depth):
    """A queued->running session at a given subagent depth, ready to spawn from."""
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    session.depth = depth
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    return session


def test_orchestrator_allows_controlled_subagent_depth_beyond_one(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, max_subagent_depth=2)
    goal = store.create_goal(GoalSpec(title="Parent", description="Deep subagent tree"))

    # A live depth-1 parent may spawn a depth-2 grandchild under the raised limit.
    depth1 = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=1)
    grandchild = orchestrator.spawn_child_run(
        parent_run_id=depth1.run_id, parent_task_id=depth1.task_graph.tasks[0].task_id,
        title="Grandchild", description="d", backend_policy="local",
    )
    assert grandchild.session.depth == 2

    # The configured limit still fails closed one level deeper (depth 3).
    depth2 = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=2)
    with pytest.raises(ValueError, match="depth limit"):
        orchestrator.spawn_child_run(
            parent_run_id=depth2.run_id, parent_task_id=depth2.task_graph.tasks[0].task_id,
            title="GreatGrandchild", description="d", backend_policy="local",
        )


def test_orchestrator_default_subagent_depth_limit_is_one(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)  # default max_subagent_depth=1
    goal = store.create_goal(GoalSpec(title="Parent", description="d"))
    depth1 = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=1)
    with pytest.raises(ValueError, match="depth limit"):
        orchestrator.spawn_child_run(
            parent_run_id=depth1.run_id, parent_task_id=depth1.task_graph.tasks[0].task_id,
            title="Child", description="d", backend_policy="local",
        )


def test_orchestrator_spawn_child_runs_parallel_fanout_aggregates(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent", description="Parallel fan-out"))
    parent = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)

    result = orchestrator.spawn_child_runs(
        parent_run_id=parent.run_id,
        parent_task_id=parent.task_graph.tasks[0].task_id,
        children=[
            {"title": "Child A", "description": "branch a", "backend_policy": "local"},
            {"title": "Child B", "description": "branch b", "backend_policy": "local"},
            {"title": "Child C", "description": "branch c", "backend_policy": "local"},
        ],
        aggregation=ChildAggregationPolicy.ALL_SUCCEED,
        max_concurrency=3,
    )

    assert result.total == 3
    assert result.completed == 3
    assert result.failed == 0
    assert result.succeeded is True
    assert len(result.children) == 3

    parent_session = store.get_run(parent.run_id)
    assert len(parent_session.child_executions) == 3  # thread-safe parent sync kept all 3
    event_types = [event["type"] for event in store.list_events(parent.run_id)]
    assert event_types.count("child_run.spawned") == 3
    assert "child_fanout.completed" in event_types
    parent_evidence = store.get_evidence(parent.run_id)
    fanout = next(f for f in parent_evidence.findings if f.name == "subagent_fanout")
    assert fanout.passed is True


class _FailingBackend(LocalShellBackend):
    name = "failing"

    def run(self, task, goal, session, limits):
        result = super().run(task, goal, session, limits)
        result.exit_code = 1
        result.output = "deliberate child failure"
        return result


def test_orchestrator_fanout_aggregation_policies_differ_on_failure(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["failing"] = _FailingBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    goal = store.create_goal(GoalSpec(title="Parent", description="Mixed fan-out"))
    specs = [
        {"title": "ok", "description": "succeeds", "backend_policy": "local"},
        {"title": "bad", "description": "fails", "backend_policy": "failing"},
    ]

    parent_all = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    all_result = orchestrator.spawn_child_runs(
        parent_run_id=parent_all.run_id,
        parent_task_id=parent_all.task_graph.tasks[0].task_id,
        children=specs,
        aggregation=ChildAggregationPolicy.ALL_SUCCEED,
        max_concurrency=2,
    )
    assert all_result.failed == 1
    assert all_result.succeeded is False  # one failing child fails ALL_SUCCEED
    all_evidence = store.get_evidence(parent_all.run_id)
    assert all_evidence.chain_verdict.value == "FAIL"  # failed fan-out finding fails the parent

    parent_any = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    any_result = orchestrator.spawn_child_runs(
        parent_run_id=parent_any.run_id,
        parent_task_id=parent_any.task_graph.tasks[0].task_id,
        children=specs,
        aggregation=ChildAggregationPolicy.ANY_SUCCEEDS,
        max_concurrency=2,
    )
    assert any_result.completed >= 1
    assert any_result.succeeded is True  # one succeeding child satisfies ANY_SUCCEEDS


def test_orchestrator_spawn_child_runs_requires_specs(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent", description="empty"))
    parent = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    with pytest.raises(ValueError, match="at least one child"):
        orchestrator.spawn_child_runs(
            parent_run_id=parent.run_id,
            parent_task_id=parent.task_graph.tasks[0].task_id,
            children=[],
        )


def test_orchestrator_fanout_consensus_policy(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["failing"] = _FailingBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    goal = store.create_goal(GoalSpec(title="P", description="consensus"))

    parent_pass = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    passing = orchestrator.spawn_child_runs(
        parent_run_id=parent_pass.run_id,
        parent_task_id=parent_pass.task_graph.tasks[0].task_id,
        children=[
            {"title": "a", "description": "x", "dry_run": True},
            {"title": "b", "description": "x", "dry_run": True},
            {"title": "c", "description": "x", "backend_policy": "failing"},
        ],
        aggregation=ChildAggregationPolicy.CONSENSUS,
        max_concurrency=3,
    )
    assert passing.completed == 2 and passing.total == 3
    assert passing.succeeded is True  # 2/3 is a strict majority

    parent_fail = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    failing = orchestrator.spawn_child_runs(
        parent_run_id=parent_fail.run_id,
        parent_task_id=parent_fail.task_graph.tasks[0].task_id,
        children=[
            {"title": "a", "description": "x", "dry_run": True},
            {"title": "b", "description": "x", "backend_policy": "failing"},
            {"title": "c", "description": "x", "backend_policy": "failing"},
        ],
        aggregation=ChildAggregationPolicy.CONSENSUS,
        max_concurrency=3,
    )
    assert failing.completed == 1
    assert failing.succeeded is False  # 1/3 is not a majority


def test_orchestrator_fanout_quorum_policy(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["failing"] = _FailingBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    goal = store.create_goal(GoalSpec(title="P", description="quorum"))
    specs = [
        {"title": "a", "description": "x", "dry_run": True},
        {"title": "b", "description": "x", "dry_run": True},
        {"title": "c", "description": "x", "backend_policy": "failing"},
    ]

    parent_met = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    met = orchestrator.spawn_child_runs(
        parent_run_id=parent_met.run_id, parent_task_id=parent_met.task_graph.tasks[0].task_id,
        children=specs, aggregation=ChildAggregationPolicy.QUORUM, quorum=2, max_concurrency=3,
    )
    assert met.succeeded is True  # 2 succeeded, quorum 2 met

    parent_unmet = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    unmet = orchestrator.spawn_child_runs(
        parent_run_id=parent_unmet.run_id, parent_task_id=parent_unmet.task_graph.tasks[0].task_id,
        children=specs, aggregation=ChildAggregationPolicy.QUORUM, quorum=3, max_concurrency=3,
    )
    assert unmet.succeeded is False  # only 2 succeeded, quorum 3 unmet


def test_orchestrator_fanout_quorum_requires_threshold(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="P", description="q"))
    parent = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    with pytest.raises(ValueError, match="quorum"):
        orchestrator.spawn_child_runs(
            parent_run_id=parent.run_id, parent_task_id=parent.task_graph.tasks[0].task_id,
            children=[{"title": "a", "description": "x", "dry_run": True}],
            aggregation=ChildAggregationPolicy.QUORUM,
        )


def test_orchestrator_fanout_synthesizes_child_evidence_into_parent_report(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="P", description="synthesis"))
    parent = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    orchestrator.spawn_child_runs(
        parent_run_id=parent.run_id, parent_task_id=parent.task_graph.tasks[0].task_id,
        children=[
            {"title": "a", "description": "x", "dry_run": True},
            {"title": "b", "description": "x", "dry_run": True},
        ],
        aggregation=ChildAggregationPolicy.ALL_SUCCEED, max_concurrency=2,
    )
    report = store.get_evidence(parent.run_id).backend_summary.get("subagent_fanouts")
    assert report and len(report) == 1
    assert report[0]["policy"] == "all_succeed"
    assert report[0]["total"] == 2
    assert len(report[0]["children"]) == 2
    assert all("chain_verdict" in child for child in report[0]["children"])


def test_orchestrator_explore_fanout_topology_expands_node_into_subagents(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Topo fanout",
        description="Explore fan-out topology",
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.EXPLORE_FANOUT,
    )
    assert result.session.status == "completed"
    event_types = [event["type"] for event in result.events]
    assert "child_fanout.completed" in event_types
    parent = orchestrator.store.get_run(result.session.run_id)
    assert len(parent.child_executions) == 2  # explore node auto-expanded into 2 subagents
    report = orchestrator.store.get_evidence(result.session.run_id).backend_summary.get("subagent_fanouts")
    assert report and report[0]["total"] == 2
    assert report[0]["policy"] == "all_succeed"


def test_orchestrator_review_consensus_topology_runs_consensus_fanout(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(
        title="Review consensus",
        description="Consensus review topology",
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.REVIEW_CONSENSUS,
    )
    assert result.session.status == "completed"
    parent = orchestrator.store.get_run(result.session.run_id)
    assert len(parent.child_executions) == 3  # review node fans out into 3 reviewers
    report = orchestrator.store.get_evidence(result.session.run_id).backend_summary.get("subagent_fanouts")
    assert report and report[0]["policy"] == "consensus"


def test_orchestrator_expand_task_graph_adds_discovered_subtask_to_frontier(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="P", description="dynamic expansion"))
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    first = session.task_graph.tasks[0]
    first.status = "completed"  # so a dependent new task becomes frontier-ready
    session.status = "running"
    store.save_run(session)

    new_task = TaskNode(task_id="dyn_1", role=WorkerRole.IMPLEMENT, title="discovered subtask", depends_on=[first.task_id])
    updated = orchestrator.expand_task_graph(session.run_id, [new_task])

    assert any(task.task_id == "dyn_1" for task in updated.task_graph.tasks)
    frontier_ids = [task.task_id for task in orchestrator._pending_frontier(updated.task_graph)]
    assert "dyn_1" in frontier_ids  # discovered subtask joined the live frontier
    assert "task.added" in [event["type"] for event in store.list_events(session.run_id)]


def test_orchestrator_expand_task_graph_validates_merged_graph(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="P", description="dynamic"))
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    existing_id = session.task_graph.tasks[0].task_id

    with pytest.raises(ValueError, match="unknown task"):
        orchestrator.expand_task_graph(session.run_id, [TaskNode(task_id="d1", role=WorkerRole.IMPLEMENT, title="x", depends_on=["nope"])])
    with pytest.raises(ValueError, match="duplicate task id"):
        orchestrator.expand_task_graph(session.run_id, [TaskNode(task_id=existing_id, role=WorkerRole.IMPLEMENT, title="x")])
    with pytest.raises(ValueError, match="cycle"):
        orchestrator.expand_task_graph(
            session.run_id,
            [
                TaskNode(task_id="cyc_a", role=WorkerRole.IMPLEMENT, title="a", depends_on=["cyc_b"]),
                TaskNode(task_id="cyc_b", role=WorkerRole.VERIFY, title="b", depends_on=["cyc_a"]),
            ],
        )


def test_orchestrator_expand_task_graph_rejects_terminal_run(tmp_path):
    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    result = orchestrator.run_goal(title="P", description="done", dry_run=True)
    with pytest.raises(ValueError, match="terminal"):
        orchestrator.expand_task_graph(
            result.session.run_id,
            [TaskNode(task_id="d1", role=WorkerRole.IMPLEMENT, title="x")],
        )


def test_orchestrator_fanout_detects_verdict_conflict_and_synthesizes_findings(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["failing"] = _FailingBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    goal = store.create_goal(GoalSpec(title="P", description="conflict"))

    parent_mixed = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    mixed = orchestrator.spawn_child_runs(
        parent_run_id=parent_mixed.run_id,
        parent_task_id=parent_mixed.task_graph.tasks[0].task_id,
        children=[
            {"title": "a", "description": "x", "dry_run": True},
            {"title": "b", "description": "x", "backend_policy": "failing"},
        ],
        aggregation=ChildAggregationPolicy.BEST_EFFORT,
        max_concurrency=2,
    )
    assert mixed.conflict is True  # children disagree (one passed, one failed)
    report = store.get_evidence(parent_mixed.run_id).backend_summary["subagent_fanouts"][-1]
    assert report["conflict"] is True
    assert sum(report["verdict_distribution"].values()) == 2
    assert any(item["passed"] is False for item in report["merged_findings"])  # failing child's findings surfaced
    assert all({"name", "passed", "severity", "failing_children", "child_count"} <= set(item) for item in report["merged_findings"])

    parent_agree = _live_session_at_depth(store, orchestrator, goal, tmp_path, depth=0)
    agree = orchestrator.spawn_child_runs(
        parent_run_id=parent_agree.run_id,
        parent_task_id=parent_agree.task_graph.tasks[0].task_id,
        children=[
            {"title": "a", "description": "x", "dry_run": True},
            {"title": "b", "description": "x", "dry_run": True},
        ],
        aggregation=ChildAggregationPolicy.ALL_SUCCEED,
        max_concurrency=2,
    )
    assert agree.conflict is False  # all children agree


class _DiscoverOnceBackend(LocalShellBackend):
    name = "discover-once"

    def __init__(self):
        super().__init__()
        self._emitted = False

    def run(self, task, goal, session, limits):
        result = super().run(task, goal, session, limits)
        if not self._emitted:
            self._emitted = True
            result.discovered_tasks = [
                {"task_id": "discovered_1", "role": "implement", "title": "discovered subtask", "depends_on": [task.task_id]}
            ]
        return result


class _BadDiscoverBackend(LocalShellBackend):
    name = "bad-discover"

    def __init__(self):
        super().__init__()
        self._emitted = False

    def run(self, task, goal, session, limits):
        result = super().run(task, goal, session, limits)
        if not self._emitted:
            self._emitted = True
            result.discovered_tasks = [
                {"task_id": "bad_1", "role": "implement", "title": "bad", "depends_on": ["nonexistent_task"]}
            ]
        return result


def test_orchestrator_self_expands_graph_from_discovered_tasks_mid_run(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["discover-once"] = _DiscoverOnceBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    result = orchestrator.run_goal(
        title="Self expand",
        description="Grow the graph mid-run",
        dry_run=False,
        backend_policy="discover-once",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    final_graph = store.get_run(result.session.run_id).task_graph
    task_ids = [task.task_id for task in final_graph.tasks]
    assert "discovered_1" in task_ids  # discovered subtask joined the live graph
    discovered = next(task for task in final_graph.tasks if task.task_id == "discovered_1")
    assert discovered.status == "completed"  # and was actually executed
    added = [
        event for event in store.list_events(result.session.run_id)
        if event["type"] == "task.added" and event["payload"].get("source") == "discovered"
    ]
    assert added
    worker_results = store.get_evidence(result.session.run_id).worker_results
    assert any(wr.task_id == "discovered_1" for wr in worker_results)


def test_orchestrator_self_expansion_fails_soft_on_invalid_discovered_tasks(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backends = default_backends()
    backends["bad-discover"] = _BadDiscoverBackend()
    orchestrator = SuperClawOrchestrator(store, backends=backends)
    result = orchestrator.run_goal(
        title="Bad expand",
        description="Invalid discovered task",
        dry_run=False,
        backend_policy="bad-discover",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    final_graph = store.get_run(result.session.run_id).task_graph
    assert "bad_1" not in [task.task_id for task in final_graph.tasks]  # invalid expansion dropped
    evidence = store.get_evidence(result.session.run_id)
    assert any(f.name == "task_expansion" and not f.passed for f in evidence.findings)  # surfaced, not crashed


class _ConcurrencyTrackingBackend(LocalShellBackend):
    name = "conc-track"

    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
        self._active = 0
        self.peak = 0

    def run(self, task, goal, session, limits):
        with self._lock:
            self._active += 1
            self.peak = max(self.peak, self._active)
        try:
            time.sleep(0.05)  # widen the overlap window so concurrent tasks coincide
            return super().run(task, goal, session, limits)
        finally:
            with self._lock:
                self._active -= 1


def test_orchestrator_frontier_parallelism_runs_independent_tasks_concurrently(tmp_path):
    backend = _ConcurrencyTrackingBackend()
    orchestrator = SuperClawOrchestrator(
        StateStore(tmp_path / "state.db"), backends={"conc-track": backend, **default_backends()}
    )
    result = orchestrator.run_goal(
        title="Parallel frontier",
        description="Run the two implement branches concurrently",
        dry_run=False,
        backend_policy="conc-track",
        repo_path=tmp_path,
        budget_seconds=30,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.IMPLEMENT_FANOUT,
        concurrency=2,
    )
    assert result.session.status == "completed"
    assert backend.peak >= 2  # the parallel implement branches overlapped


def test_orchestrator_frontier_concurrency_one_stays_sequential(tmp_path):
    backend = _ConcurrencyTrackingBackend()
    orchestrator = SuperClawOrchestrator(
        StateStore(tmp_path / "state.db"), backends={"conc-track": backend, **default_backends()}
    )
    result = orchestrator.run_goal(
        title="Sequential frontier",
        description="concurrency=1 must stay sequential",
        dry_run=False,
        backend_policy="conc-track",
        repo_path=tmp_path,
        budget_seconds=30,
        artifact_dir=tmp_path / "artifacts",
        task_topology=TaskTopology.IMPLEMENT_FANOUT,
        concurrency=1,
    )
    assert result.session.status == "completed"
    assert backend.peak == 1  # backward compatible: no overlap at concurrency=1


def test_orchestrator_frontier_parallelism_stress_no_lost_updates(tmp_path):
    store = StateStore(tmp_path / "state.db")
    backend = _ConcurrencyTrackingBackend()
    orchestrator = SuperClawOrchestrator(store, backends={"conc-track": backend, **default_backends()})
    goal = store.create_goal(GoalSpec(title="Stress", description="many independent tasks"))
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="conc-track", repo_path=tmp_path,
        budget_seconds=30, artifact_dir=tmp_path / "artifacts", concurrency=4,
    )
    # 6 independent tasks (no deps) -> all in one frontier -> 4-worker parallel batch.
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id=f"t{i}", role=WorkerRole.IMPLEMENT, title=f"task {i}") for i in range(6)],
    )
    store.save_run(session)
    result = orchestrator.execute_existing_session(
        goal, session, dry_run=False, backend_policy="conc-track", repo_path=tmp_path,
        concurrency=4, budget_seconds=30, artifact_dir=tmp_path / "artifacts",
    )
    assert result.session.status == "completed"
    final = store.get_run(session.run_id)
    assert all(task.status == "completed" for task in final.task_graph.tasks)
    evidence = store.get_evidence(session.run_id)
    recorded = sorted(wr.task_id for wr in evidence.worker_results)
    assert recorded == [f"t{i}" for i in range(6)]  # every result recorded, none lost under concurrency
    assert 2 <= backend.peak <= 4  # genuine parallelism, bounded by the concurrency limit


def test_orchestrator_parallel_frontier_cancellation_stops_all_workers(tmp_path):
    class _SlowParallelBackend(LocalShellBackend):
        name = "slow-par"

        def _default_command(self, task, goal):
            return [sys.executable, "-c", "import time; print('slow', flush=True); time.sleep(10)"]

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"slow-par": _SlowParallelBackend()})
    goal = store.create_goal(GoalSpec(title="ParCancel", description="cancel a parallel frontier"))
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="slow-par", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts", concurrency=2,
    )
    session.task_graph = TaskGraph(
        goal_id=goal.goal_id,
        tasks=[TaskNode(task_id="p1", role=WorkerRole.IMPLEMENT, title="p1"), TaskNode(task_id="p2", role=WorkerRole.IMPLEMENT, title="p2")],
    )
    store.save_run(session)

    def run_it():
        orchestrator.execute_existing_session(
            goal, session, dry_run=False, backend_policy="slow-par", repo_path=tmp_path,
            concurrency=2, budget_seconds=20, artifact_dir=tmp_path / "artifacts",
        )

    thread = threading.Thread(target=run_it, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if sum(1 for e in store.list_events(session.run_id) if e["type"] == "command.started") >= 2:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("parallel frontier workers did not both start")

    orchestrator.cancel_run(session.run_id)
    thread.join(timeout=30)

    evidence = store.get_evidence(session.run_id)
    assert len(evidence.worker_results) == 2
    assert all(wr.cancelled for wr in evidence.worker_results)  # cancel reached every concurrent worker


def test_orchestrator_threads_model_into_worker_limits_and_context(tmp_path):
    seen_models: list = []

    class RecordingBackend(LocalShellBackend):
        name = "recording"

        def run(self, task, goal, session, limits):
            seen_models.append(limits.model_override)
            return super().run_command(
                [sys.executable, "-c", "print('ok')"], task=task, goal=goal, session=session, limits=limits
            )

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"recording": RecordingBackend()})
    result = orchestrator.run_goal(
        title="Model threading",
        description="Per-run model override reaches the worker.",
        dry_run=False,
        backend_policy="recording",
        model="claude-haiku-4-5",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == "completed"
    assert seen_models and all(m == "claude-haiku-4-5" for m in seen_models)
    assert result.session.execution_context["model"] == "claude-haiku-4-5"
    started = next(e for e in result.events if e["type"] == "run.started")
    assert started["payload"]["model"] == "claude-haiku-4-5"


def test_orchestrator_run_without_model_keeps_override_unset(tmp_path):
    seen_models: list = []

    class RecordingBackend(LocalShellBackend):
        name = "recording"

        def run(self, task, goal, session, limits):
            seen_models.append(limits.model_override)
            return super().run_command(
                [sys.executable, "-c", "print('ok')"], task=task, goal=goal, session=session, limits=limits
            )

    orchestrator = SuperClawOrchestrator(StateStore(tmp_path / "state.db"), backends={"recording": RecordingBackend()})
    result = orchestrator.run_goal(
        title="No model",
        description="Default model path stays env-driven.",
        dry_run=False,
        backend_policy="recording",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.session.status == "completed"
    assert seen_models and all(m is None for m in seen_models)
    assert result.session.execution_context["model"] is None


def test_child_run_inherits_parent_model_only_with_same_backend(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="Parent", description="parent run"))
    parent = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        model="claude-haiku-4-5",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    parent.status = "running"
    store.save_run(parent)
    parent_task_id = parent.task_graph.tasks[0].task_id

    # same backend → inherits the parent's model
    _, child_same, kwargs_same = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child same", description="same backend"
    )
    assert kwargs_same["model"] == "claude-haiku-4-5"
    assert child_same.execution_context["model"] == "claude-haiku-4-5"

    # different backend → model ids are not portable; selection must NOT leak
    _, child_other, kwargs_other = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child other", description="other backend",
        backend_policy="codex",
    )
    assert kwargs_other["model"] is None
    assert child_other.execution_context["model"] is None

    # explicit child model always wins
    _, _, kwargs_explicit = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child explicit", description="explicit model",
        backend_policy="codex", model="gpt-5.2-codex",
    )
    assert kwargs_explicit["model"] == "gpt-5.2-codex"


def test_child_run_inherits_parent_effort_only_with_same_backend(tmp_path):
    """effort follows the same inheritance rule as model: a child inherits the
    parent's effort only when it speaks the parent's backend (effort levels are
    runtime-specific), and an explicit child effort always wins."""
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="Parent", description="parent run"))
    parent = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        effort="high",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    parent.status = "running"
    store.save_run(parent)
    parent_task_id = parent.task_graph.tasks[0].task_id

    # same backend → inherits the parent's effort
    _, child_same, kwargs_same = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child same", description="same backend"
    )
    assert kwargs_same["effort"] == "high"
    assert child_same.execution_context["effort"] == "high"

    # different backend → effort levels are not portable; must NOT leak
    _, child_other, kwargs_other = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child other", description="other backend",
        backend_policy="codex",
    )
    assert kwargs_other["effort"] is None
    assert child_other.execution_context["effort"] is None

    # explicit child effort always wins
    _, _, kwargs_explicit = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="child explicit", description="explicit effort",
        backend_policy="codex", effort="low",
    )
    assert kwargs_explicit["effort"] == "low"


def test_linked_child_profile_model_effort_gated_on_profile_backend(tmp_path):
    """A bound profile's model/effort apply only when the child runs on the profile's
    OWN backend. Cross-runtime delegation overrides the runtime (target_runtime becomes
    backend_policy) while still binding the profile — the profile's codex model/effort
    must NOT leak onto a gemini child (model ids + effort enums are runtime-specific)."""
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    profile = AgentProfile(name="Eng", role="engineer", backend_policy="codex", model="gpt-5.5", effort="high")
    store.save_agent_profile(profile)
    goal = store.create_goal(GoalSpec(title="Parent", description="parent run"))
    parent = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="local",
        repo_path=tmp_path, budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    parent.status = "running"
    store.save_run(parent)
    parent_task_id = parent.task_graph.tasks[0].task_id

    # Child bound to the codex profile, runs on its OWN backend (codex) → inherits both.
    _, _, kwargs_same = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="own backend", description="x",
        backend_policy="codex", agent_profile_id=profile.profile_id,
    )
    assert kwargs_same["model"] == "gpt-5.5"
    assert kwargs_same["effort"] == "high"

    # Same profile, but an explicit override re-runs it on gemini → the codex
    # model/effort are NOT portable and must be gated out (fall back to gemini's own
    # default), never injected onto the mismatched runtime.
    _, _, kwargs_override = orchestrator._create_linked_child(
        store.get_run(parent.run_id), parent_task_id, title="overridden backend", description="x",
        backend_policy="gemini", agent_profile_id=profile.profile_id,
    )
    assert kwargs_override["model"] is None
    assert kwargs_override["effort"] is None


def test_resume_run_preserves_model_from_execution_context(tmp_path):
    seen_models: list = []

    class RecordingBackend(LocalShellBackend):
        name = "recording"

        def run(self, task, goal, session, limits):
            seen_models.append(limits.model_override)
            return super().run_command(
                [sys.executable, "-c", "print('ok')"], task=task, goal=goal, session=session, limits=limits
            )

    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store, backends={"recording": RecordingBackend()})
    goal = store.create_goal(GoalSpec(title="Resumable", description="resume keeps model"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="recording",
        model="claude-haiku-4-5",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
    )
    store.create_evidence(session.run_id)

    result = orchestrator.resume_run(session.run_id)

    assert result.session.status == "completed"
    assert seen_models and all(m == "claude-haiku-4-5" for m in seen_models)
