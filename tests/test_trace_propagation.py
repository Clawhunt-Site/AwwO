"""P0a-B2: trace context propagation across the execution choke point, worker
threads, and child processes."""
from __future__ import annotations

import contextvars
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

from superclaw import trace_context
from superclaw.backends import LocalShellBackend, WorkerLimits
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


def test_execute_existing_session_binds_run_id_and_trace(tmp_path, monkeypatch) -> None:
    orch = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    goal = GoalSpec(title="t", description="d")
    session = RunSession(goal_id=goal.goal_id, run_id="run_choke")

    seen: dict[str, str] = {}

    def fake_impl(self, g, s, **kw):  # noqa: ANN001, ANN002, ANN003
        seen.update(trace_context.current())
        return "impl-ok"

    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_impl", fake_impl)

    assert orch.execute_existing_session(goal, session) == "impl-ok"
    assert seen["run_id"] == "run_choke"
    assert seen["trace_id"].startswith("trace_")  # generated when no ambient trace
    assert trace_context.current() == {}  # restored after the choke point


def test_execute_existing_session_inherits_ambient_trace(tmp_path, monkeypatch) -> None:
    orch = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    goal = GoalSpec(title="t", description="d")
    session = RunSession(goal_id=goal.goal_id, run_id="run_inherit")

    seen: dict[str, str] = {}

    def fake_impl(self, g, s, **kw):  # noqa: ANN001, ANN002, ANN003
        seen.update(trace_context.current())
        return "ok"

    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_impl", fake_impl)

    with trace_context.bind(trace_id="trace_ambient"):
        orch.execute_existing_session(goal, session)
    assert seen["trace_id"] == "trace_ambient"  # inherited, not regenerated
    assert seen["run_id"] == "run_inherit"


def test_workers_inherit_parent_trace_each_own_run_id(tmp_path, monkeypatch) -> None:
    # Mirrors the orchestrator's concurrent submit (copy_context per worker), the
    # path that lets each worker thread carry the shared trace_id while binding
    # its own run_id at the choke point.
    orch = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    captured: dict[str, dict[str, str]] = {}

    def fake_impl(self, g, s, **kw):  # noqa: ANN001, ANN002, ANN003
        captured[s.run_id] = dict(trace_context.current())
        return "ok"

    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_impl", fake_impl)
    goal = GoalSpec(title="t", description="d")
    sessions = [RunSession(goal_id=goal.goal_id, run_id=f"run_{i}") for i in range(3)]

    with trace_context.bind(trace_id="trace_parent"):
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {}
            for session in sessions:
                ctx = contextvars.copy_context()
                futures[pool.submit(ctx.run, orch.execute_existing_session, goal, session)] = session.run_id
            for future in as_completed(futures):
                future.result()

    for session in sessions:
        assert captured[session.run_id]["trace_id"] == "trace_parent"  # inherited
        assert captured[session.run_id]["run_id"] == session.run_id  # own


def test_run_command_child_process_inherits_trace_env(tmp_path) -> None:
    # End-to-end: a real child process started by the backend must see the trace
    # correlation via inherited env vars.
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    code = "import os; print(os.environ.get('SUPERCLAW_TRACE_TRACE_ID', 'MISSING'))"

    with trace_context.bind(trace_id="trace_child_env"):
        result = backend.run_command(
            [sys.executable, "-c", code],
            task=TaskNode(task_id="task_1", role=WorkerRole.EXPLORE, title="explore"),
            goal=GoalSpec(title="g", description="d"),
            session=RunSession(goal_id="goal_1", run_id="run_env_1"),
            limits=limits,
        )
    assert "trace_child_env" in result.output


def test_child_async_thread_inherits_parent_trace(tmp_path, monkeypatch) -> None:
    # Real path (Codex follow-up): _start_child_async spawns a threading.Thread;
    # copy_context must carry the parent trace_id across it while the choke point
    # binds the child's own run_id.
    orch = SuperClawOrchestrator(StateStore(tmp_path / "state.db"))
    captured: dict[str, str] = {}

    def fake_impl(self, g, s, **kw):  # noqa: ANN001, ANN002, ANN003
        captured.update(trace_context.current())
        return "ok"

    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_impl", fake_impl)
    goal = GoalSpec(title="t", description="d")
    child = RunSession(goal_id=goal.goal_id, run_id="run_child_async")

    with trace_context.bind(trace_id="trace_parent_async"):
        orch._start_child_async(goal, child, {})
        thread = orch._run_thread("run_child_async")
    assert thread is not None
    thread.join(timeout=5)

    assert captured["trace_id"] == "trace_parent_async"  # inherited across the thread
    assert captured["run_id"] == "run_child_async"


def test_claude_stream_child_inherits_trace_env(monkeypatch, tmp_path) -> None:
    # Codex follow-up: the Claude streaming backend has its own subprocess spawn.
    import superclaw.claude_stream as cs

    captured: dict[str, object] = {}

    class _FakePopen:
        def __init__(self, command, **kwargs):  # noqa: ANN001, ANN002, ANN003
            captured["env"] = kwargs.get("env")
            raise OSError("stop after capturing env")

    monkeypatch.setattr(cs.subprocess, "Popen", _FakePopen)
    with trace_context.bind(trace_id="trace_cs", run_id="run_cs"):
        cs.run_claude_stream(["claude", "x"], cwd=tmp_path, budget_seconds=5)  # OSError -> error result

    env = captured["env"]
    assert env["SUPERCLAW_TRACE_TRACE_ID"] == "trace_cs"
    assert env["SUPERCLAW_TRACE_RUN_ID"] == "run_cs"


def test_codex_app_server_child_inherits_trace_env(monkeypatch) -> None:
    # Codex follow-up: the codex app-server backend has its own subprocess spawn;
    # trace must be read at spawn time, not client __init__.
    import superclaw.codex_app_server as cas

    captured: dict[str, object] = {}

    class _FakePopen:
        def __init__(self, command, **kwargs):  # noqa: ANN001, ANN002, ANN003
            captured["env"] = kwargs.get("env")
            raise OSError("stop after capturing env")

    monkeypatch.setattr(cas.subprocess, "Popen", _FakePopen)
    client = cas.CodexAppServerClient(executable="/usr/bin/true")
    with trace_context.bind(trace_id="trace_cas", run_id="run_cas"):
        with pytest.raises(cas.CodexAppServerError):
            client.start()

    env = captured["env"]
    assert env["SUPERCLAW_TRACE_TRACE_ID"] == "trace_cas"
    assert env["SUPERCLAW_TRACE_RUN_ID"] == "run_cas"
