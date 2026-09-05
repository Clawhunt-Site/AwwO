import pytest

from superclaw.models import (
    ArtifactRef,
    ChainVerdict,
    ChildExecution,
    EvidenceBundle,
    GoalSpec,
    PRIMARY_EVIDENCE_TEXT_LIMIT,
    PRIMARY_EVIDENCE_TRUNCATED_FINDING,
    RunMutationLease,
    RunMutationMode,
    RunSession,
    RunStatus,
    TaskGraph,
    TaskNode,
    TaskTopology,
    WorkerResult,
    WorkerRole,
    is_valid_run_status_transition,
)


def test_goal_spec_normalizes_clawhunt_problem_payload():
    payload = {
        "id": 42,
        "title": "Fix checkout callback",
        "description": "Webhook retries fail under timeout.",
        "category": "backend",
        "bounty": 12000,
        "url": "https://github.com/example/repo/issues/7",
    }

    goal = GoalSpec.from_clawhunt_problem(payload)

    assert goal.source == "clawhunt"
    assert goal.external_id == "42"
    assert goal.title == "Fix checkout callback"
    assert goal.acceptance_criteria[0] == "Evidence bundle includes command output"
    assert goal.metadata["bounty"] == 12000


def test_task_graph_rejects_missing_dependencies():
    graph = TaskGraph.from_goal(
        GoalSpec(title="Ship", description="Build the thing"),
        roles=[WorkerRole.EXPLORE, WorkerRole.IMPLEMENT, WorkerRole.VERIFY],
    )

    assert [task.role for task in graph.tasks] == [
        WorkerRole.EXPLORE,
        WorkerRole.IMPLEMENT,
        WorkerRole.VERIFY,
    ]
    assert graph.tasks[1].depends_on == [graph.tasks[0].task_id]
    assert graph.tasks[2].depends_on == [graph.tasks[1].task_id]


def test_task_graph_supports_constrained_implement_fanout_topology():
    graph = TaskGraph.from_goal(
        GoalSpec(title="Ship", description="Build the thing"),
        topology=TaskTopology.IMPLEMENT_FANOUT,
    )

    assert [task.role for task in graph.tasks] == [
        WorkerRole.EXPLORE,
        WorkerRole.PLAN,
        WorkerRole.IMPLEMENT,
        WorkerRole.IMPLEMENT,
        WorkerRole.VERIFY,
        WorkerRole.REVIEW,
    ]
    assert graph.tasks[2].depends_on == [graph.tasks[1].task_id]
    assert graph.tasks[3].depends_on == [graph.tasks[1].task_id]
    assert graph.tasks[4].depends_on == [graph.tasks[2].task_id, graph.tasks[3].task_id]


def test_task_graph_validation_rejects_missing_dependencies_and_cycles():
    missing_dep = TaskGraph(
        goal_id="goal_1",
        tasks=[
            TaskNode(task_id="task_a", role=WorkerRole.EXPLORE, title="A"),
            TaskNode(task_id="task_b", role=WorkerRole.VERIFY, title="B", depends_on=["task_missing"]),
        ],
    )
    cycle = TaskGraph(
        goal_id="goal_1",
        tasks=[
            TaskNode(task_id="task_a", role=WorkerRole.EXPLORE, title="A", depends_on=["task_b"]),
            TaskNode(task_id="task_b", role=WorkerRole.VERIFY, title="B", depends_on=["task_a"]),
        ],
    )

    try:
        missing_dep.validate()
    except ValueError as exc:
        assert "unknown task" in str(exc)
    else:
        raise AssertionError("expected missing dependency validation failure")

    try:
        cycle.validate()
    except ValueError as exc:
        assert "dependency cycle" in str(exc)
    else:
        raise AssertionError("expected cycle validation failure")


def test_run_mutation_lease_loads_legacy_payload_without_worker_liveness_fields():
    lease = RunMutationLease.from_dict(
        {
            "resource": "run:run_1",
            "owner": "execute:run_1",
            "mode": "execute",
            "lease_id": "runlease_legacy",
            "acquired_at": 123.0,
        }
    )

    assert lease.worker_pid is None
    assert lease.worker_host is None
    assert lease.to_dict()["worker_pid"] is None
    assert lease.to_dict()["worker_host"] is None


def test_evidence_bundle_distinguishes_chain_verdicts():
    ready = EvidenceBundle(run_id="run_1")
    ready.add_probe("clawhunt_health", 200, {"status": "ok"})
    assert ready.chain_verdict == ChainVerdict.CONTROL_PLANE_READY

    partial = EvidenceBundle(run_id="run_2")
    partial.add_probe("clawhunt_health", 200, {"status": "ok"})
    partial.add_command("pytest", 0, "1 passed")
    assert partial.chain_verdict == ChainVerdict.CHAIN_PARTIAL

    proven = EvidenceBundle(run_id="run_3")
    proven.add_probe("clawhunt_health", 200, {"status": "ok"})
    proven.add_command("pytest", 0, "1 passed")
    proven.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="verify",
            backend="local",
            command="pytest",
            exit_code=0,
            output="1 passed",
            duration_seconds=0.2,
        )
    )
    proven.add_artifact(ArtifactRef(kind="browser", path="screenshots/run.png", sensitivity="public"))
    proven.add_finding("adversarial_probe", True, "non-happy path passed")
    proven.mark_submitted({"status_code": 200, "body": {"accepted": True}})
    assert proven.chain_verdict == ChainVerdict.E2E_PROVEN


def test_e2e_proven_requires_real_worker_result():
    bundle = EvidenceBundle(run_id="run_no_worker")
    bundle.add_probe("clawhunt_health", 200, {"status": "ok"})
    bundle.add_command("superclaw capability-plan", 0, "planned tasks")
    bundle.add_artifact(ArtifactRef(kind="evidence-json", path="evidence.json"))
    bundle.add_finding("adversarial_probe", True, "passed")
    bundle.mark_submitted({"status_code": 200, "body": {"accepted": True}})

    assert bundle.chain_verdict == ChainVerdict.CHAIN_PARTIAL


def test_truncation_disclosure_finding_does_not_prove_e2e_verification():
    bundle = EvidenceBundle(run_id="run_truncation_only")
    long_output = "prefix-" + ("x" * 5005)
    bundle.add_probe("clawhunt_health", 200, {"status": "ok"})
    bundle.add_command("pytest -q", 0, long_output)
    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="verify",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output="1 passed",
            duration_seconds=0.2,
        )
    )
    bundle.add_artifact(ArtifactRef(kind="worker-log", path="artifacts/run.log"))
    bundle.mark_submitted({"status_code": 200, "body": {"accepted": True}})
    bundle.normalize()

    assert any(finding.name == PRIMARY_EVIDENCE_TRUNCATED_FINDING for finding in bundle.findings)
    assert bundle.chain_verdict == ChainVerdict.CHAIN_PARTIAL


def test_evidence_bundle_fails_on_failed_finding():
    bundle = EvidenceBundle(run_id="run_fail")
    bundle.add_probe("clawhunt_health", 200, {"status": "ok"})
    bundle.add_finding("adversarial_probe", False, "missing protected API 401")

    assert bundle.chain_verdict == ChainVerdict.FAIL


def test_run_status_transition_rules_capture_verifying_and_human_gate_compatibility():
    assert is_valid_run_status_transition(RunStatus.CREATED.value, RunStatus.QUEUED.value)
    assert is_valid_run_status_transition(RunStatus.RUNNING.value, RunStatus.VERIFYING.value)
    assert is_valid_run_status_transition(RunStatus.RUNNING.value, RunStatus.WAITING_FOR_CHILD_DELEGATION.value)
    assert is_valid_run_status_transition(RunStatus.WAITING_FOR_CHILD_DELEGATION.value, RunStatus.QUEUED.value)
    assert is_valid_run_status_transition(RunStatus.VERIFYING.value, RunStatus.COMPLETED.value)
    assert is_valid_run_status_transition(RunStatus.COMPLETED.value, RunStatus.WAITING_FOR_HUMAN_GATE.value)
    assert not is_valid_run_status_transition(RunStatus.COMPLETED.value, RunStatus.CANCELLED.value)
    assert not is_valid_run_status_transition(RunStatus.FAILED.value, RunStatus.CANCELLED.value)
    assert not is_valid_run_status_transition(RunStatus.COMPLETED.value, RunStatus.RUNNING.value)


def test_run_session_round_trip_preserves_execution_context():
    session = RunSession(
        goal_id="goal_1",
        run_id="run_1",
        status=RunStatus.QUEUED.value,
        execution_context={
            "backend_policy": "local",
            "repo_path": "/tmp/project",
            "artifact_dir": "/tmp/artifacts",
            "budget_seconds": 30,
        },
        task_attempts={"task_parent": 2},
        parent_run_id="run_parent",
        parent_task_id="task_parent",
        depth=1,
        child_executions=[
            ChildExecution(
                child_task_id="childtask_1",
                child_run_id="run_child",
                parent_run_id="run_1",
                parent_task_id="task_parent",
                backend="local",
                status="queued",
                timeout_seconds=30,
            )
        ],
        active_mutation_lease=RunMutationLease(
            resource="run:run_1",
            owner="execute:run_1",
            mode=RunMutationMode.EXECUTE,
            lease_id="runlease_1",
            acquired_at=123.4,
        ),
    )

    restored = RunSession.from_dict(session.to_dict())

    assert restored.execution_context["backend_policy"] == "local"
    assert restored.execution_context["artifact_dir"] == "/tmp/artifacts"
    assert restored.task_attempts["task_parent"] == 2
    assert restored.parent_run_id == "run_parent"
    assert restored.parent_task_id == "task_parent"
    assert restored.depth == 1
    assert restored.child_executions[0].child_run_id == "run_child"
    assert restored.active_mutation_lease is not None
    assert restored.active_mutation_lease.mode == RunMutationMode.EXECUTE
    assert restored.active_mutation_lease.lease_id == "runlease_1"


def test_evidence_bundle_normalizes_duplicates_and_caps_primary_text():
    long_output = "prefix-" + ("x" * 5005)
    bundle = EvidenceBundle(run_id="run_norm")

    bundle.add_probe("control_plane", 200, {"ok": True})
    bundle.add_probe("control_plane", 200, {"ok": True})
    bundle.add_command("pytest -q", 0, long_output)
    bundle.add_command("pytest -q", 0, long_output)
    bundle.add_artifact(ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"))
    bundle.add_artifact(ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"))
    bundle.add_child_execution(
        ChildExecution(
            child_task_id="childtask_1",
            child_run_id="run_child",
            parent_run_id="run_norm",
            parent_task_id="task_1",
            backend="local",
            status="queued",
        )
    )
    bundle.add_child_execution(
        ChildExecution(
            child_task_id="childtask_1",
            child_run_id="run_child",
            parent_run_id="run_norm",
            parent_task_id="task_1",
            backend="local",
            status="completed",
            chain_verdict="CHAIN_PARTIAL",
        )
    )
    bundle.add_finding("worker_execution", False, "backend failed", "high")
    bundle.add_finding("worker_execution", False, "backend failed", "high")
    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output=long_output,
            duration_seconds=0.4,
            attempt_index=2,
            started_at=100.0,
            finished_at=100.4,
        )
    )
    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output="replacement output",
            duration_seconds=0.6,
            attempt_index=2,
            started_at=100.0,
            finished_at=100.4,
        )
    )
    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output="second attempt",
            duration_seconds=0.7,
            attempt_index=3,
            started_at=101.0,
            finished_at=101.4,
        )
    )

    restored = EvidenceBundle.from_dict(bundle.to_dict())

    assert len(restored.probes) == 1
    assert len(restored.commands) == 1
    assert len(restored.artifacts) == 1
    assert len(restored.child_executions) == 1
    assert len(restored.findings) == 2
    assert len(restored.worker_results) == 2
    truncation_findings = [
        finding for finding in restored.findings if finding.name == PRIMARY_EVIDENCE_TRUNCATED_FINDING
    ]
    assert len(truncation_findings) == 1
    assert truncation_findings[0].passed is True
    assert truncation_findings[0].severity == "warning"
    assert truncation_findings[0].input_fields == ["commands[].output"]
    assert "pytest -q" in truncation_findings[0].detail
    assert restored.worker_results[0].attempt_index == 2
    assert restored.worker_results[0].started_at == 100.0
    assert restored.worker_results[0].finished_at == 100.4
    assert restored.worker_results[0].output == "replacement output"
    assert restored.worker_results[0].output_truncated is False
    assert restored.worker_results[1].attempt_index == 3
    assert restored.commands[0]["output"] == long_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:]
    assert restored.commands[0]["output_truncated"] is True
    assert restored.commands[0]["output_original_length"] == len(long_output)
    assert restored.child_executions[0].status == "completed"


def test_evidence_bundle_records_worker_result_output_truncation():
    long_output = "worker-prefix-" + ("w" * 5005)
    bundle = EvidenceBundle(run_id="run_worker_truncation")

    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="verify",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output=long_output,
            duration_seconds=0.5,
        )
    )

    restored = EvidenceBundle.from_dict(bundle.to_dict())

    assert restored.worker_results[0].output == long_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:]
    assert restored.worker_results[0].output_truncated is True
    assert restored.worker_results[0].output_original_length == len(long_output)
    truncation_findings = [
        finding for finding in restored.findings if finding.name == PRIMARY_EVIDENCE_TRUNCATED_FINDING
    ]
    assert len(truncation_findings) == 1
    assert truncation_findings[0].passed is True
    assert truncation_findings[0].input_fields == ["worker_results[].output"]
    assert "task=task_1" in truncation_findings[0].detail


def test_task_graph_rejects_dependency_cycle_on_load():
    a = TaskNode(task_id="a", role=WorkerRole.IMPLEMENT, title="a", depends_on=["b"])
    b = TaskNode(task_id="b", role=WorkerRole.VERIFY, title="b", depends_on=["a"])
    with pytest.raises(ValueError, match="cycle"):
        TaskGraph(goal_id="g", tasks=[a, b]).validate()
    # from_dict must also fail closed on a persisted cyclic graph.
    payload = {"goal_id": "g", "tasks": [
        {"task_id": "a", "role": "implement", "title": "a", "depends_on": ["b"], "status": "pending"},
        {"task_id": "b", "role": "verify", "title": "b", "depends_on": ["a"], "status": "pending"},
    ]}
    with pytest.raises(ValueError, match="cycle"):
        TaskGraph.from_dict(payload)


def test_task_graph_rejects_self_dependency():
    node = TaskNode(task_id="x", role=WorkerRole.IMPLEMENT, title="x", depends_on=["x"])
    with pytest.raises(ValueError, match="cycle"):
        TaskGraph(goal_id="g", tasks=[node]).validate()


def test_task_graph_rejects_dangling_dependency():
    node = TaskNode(task_id="x", role=WorkerRole.IMPLEMENT, title="x", depends_on=["missing"])
    with pytest.raises(ValueError, match="unknown task"):
        TaskGraph(goal_id="g", tasks=[node]).validate()


# --- Issue.status_changed_at (message-center §2.5: blocked event_time) -------


def test_issue_status_changed_at_seeds_to_created_at_on_fresh_issue():
    from superclaw.models import Issue

    issue = Issue(title="x", created_at=1000.0)
    # A brand-new issue has not transitioned away from its initial status, so the
    # "changed since" instant is creation, NOT "now" (which would make a fresh
    # blocked issue read as just-blocked on the very first poll).
    assert issue.status_changed_at == 1000.0


def test_issue_status_changed_at_explicit_value_is_preserved():
    from superclaw.models import Issue

    issue = Issue(title="x", created_at=1000.0, status_changed_at=1500.0)
    assert issue.status_changed_at == 1500.0


def test_issue_status_changed_at_boundary_zero_is_preserved_not_seeded():
    # The boundary value 0.0 (Unix epoch) is a REAL timestamp, not the unset
    # sentinel (which is the negative default). It must be preserved verbatim,
    # never silently rewritten to created_at.
    from superclaw.models import Issue

    issue = Issue(title="x", created_at=1000.0, status_changed_at=0.0)
    assert issue.status_changed_at == 0.0


def test_issue_from_dict_backfills_missing_status_changed_at_from_updated_at():
    from superclaw.models import Issue

    # A legacy payload persisted before status_changed_at existed: the field is
    # absent. It MUST backfill to the stored updated_at — a stable past instant —
    # NEVER to a live clock (which would make event_time jump to the present and
    # the blocked item re-surface as unread on every read).
    legacy = {
        "title": "old",
        "issue_id": "issue_legacy",
        "status": "blocked",
        "created_at": 1000.0,
        "updated_at": 1234.0,
    }
    issue = Issue.from_dict(legacy)
    assert issue.status_changed_at == 1234.0


def test_issue_from_dict_preserves_stored_status_changed_at():
    from superclaw.models import Issue

    payload = {
        "title": "x",
        "issue_id": "issue_y",
        "status": "blocked",
        "created_at": 1000.0,
        "updated_at": 1234.0,
        "status_changed_at": 1100.0,
    }
    issue = Issue.from_dict(payload)
    assert issue.status_changed_at == 1100.0
