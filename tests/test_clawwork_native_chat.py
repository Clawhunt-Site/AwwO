"""Unit tests for the ClawWork Tier 2 native chat executor + API dispatch map.

The executor drives the GOVERNED ``ClawWorkBackend.run()`` channel; here we fake that
channel (no real binary) to lock the chat-layer contract: invalid-id fail+retire,
unavailable retire, native-session WorkerLimits projection, NATIVE_SESSION_LOST →
retire, and the happy-path reply shape.
"""
from __future__ import annotations

import types
from pathlib import Path

import pytest


def _fake_result(*, exit_code=0, stdout="hello from clawwork", output=None, timed_out=False, cancelled=False, stderr=""):
    return types.SimpleNamespace(
        exit_code=exit_code,
        stdout=stdout,
        output=output if output is not None else (stdout or ""),
        timed_out=timed_out,
        cancelled=cancelled,
        stderr=stderr,
        output_truncated=False,
        transcript_path=None,
    )


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))
    return tmp_path


def _patch_backend(monkeypatch, *, run, available_ok=True):
    import superclaw.backends as backends

    monkeypatch.setattr(
        backends.ClawWorkBackend, "available",
        lambda self: types.SimpleNamespace(available=available_ok, reason=None if available_ok else "no binary"),
    )
    monkeypatch.setattr(backends.ClawWorkBackend, "run", run)


def test_invalid_native_id_fails_and_retires_without_running(home, monkeypatch):
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    ran = {"called": False}

    def _run(self, task, goal, session, limits):
        ran["called"] = True
        return _fake_result()

    _patch_backend(monkeypatch, run=_run)
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=10,
        native_session_id="bad id/slash", is_resume=True, chat_session_id="chatA",
    )
    assert out["status"] == "failed"
    assert out["retire_native_session"] is True
    assert ran["called"] is False  # never spawned an invalid-id session


def test_unavailable_backend_retires_on_resume(home, monkeypatch):
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    _patch_backend(monkeypatch, run=lambda *a, **k: _fake_result(), available_ok=False)
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=10,
        native_session_id="sess1", is_resume=True, chat_session_id="chatA",
    )
    assert out["status"] == "failed"
    assert out["retire_native_session"] is True


def test_happy_path_projects_native_session_into_limits(home, monkeypatch):
    from superclaw.chat_turn import execute_clawwork_native_chat_turn
    from superclaw.clawwork_session import native_session_dir

    captured = {}

    def _run(self, task, goal, session, limits):
        captured["native_session_id"] = limits.native_session_id
        captured["native_session_dir"] = limits.native_session_dir
        captured["expect_resume"] = limits.native_session_expect_resume
        captured["chat_intent"] = goal.metadata.get("chat_turn_intent")
        captured["prompt"] = goal.description
        return _fake_result(stdout="the answer is 42")

    _patch_backend(monkeypatch, run=_run)
    out = execute_clawwork_native_chat_turn(
        content="what is the answer?", repo=Path("/tmp"), budget_seconds=10,
        native_session_id="sess1", is_resume=False, history_seed="prior turns here",
        chat_session_id="chatA",
    )
    assert out["status"] == "completed"
    assert out["response"] == "the answer is 42"
    assert out["native_session_id"] == "sess1"
    # native session threaded into the governed run() channel
    assert captured["native_session_id"] == "sess1"
    assert captured["expect_resume"] is False
    assert captured["chat_intent"] == "chat"
    # durable dir is keyed on the chat id, HOME-anchored
    assert captured["native_session_dir"] == native_session_dir("chatA", backend="clawwork")
    # first turn injects the history seed, not catch_up
    assert "prior turns here" in captured["prompt"]
    assert "what is the answer?" in captured["prompt"]


def test_native_session_lost_marker_forces_retire(home, monkeypatch):
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    def _run(self, task, goal, session, limits):
        return _fake_result(exit_code=125, stdout="", output="CLAWWORK_NATIVE_SESSION_LOST: gone under lock")

    _patch_backend(monkeypatch, run=_run)
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=10,
        native_session_id="sess1", is_resume=False, chat_session_id="chatA",
    )
    assert out["status"] == "failed"
    # even though is_resume=False, the under-lock loss marker forces a retire so the
    # binding is dropped and the next turn full-seeds.
    assert out["retire_native_session"] is True


def test_empty_reply_is_failure(home, monkeypatch):
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    _patch_backend(monkeypatch, run=lambda *a, **k: _fake_result(stdout="", output=""))
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=10,
        native_session_id="sess1", is_resume=False, chat_session_id="chatA",
    )
    assert out["status"] == "failed"


def test_timeout_failure_surfaces_clawwork_output_tail(home, monkeypatch):
    """A bare 'timeout' hides WHY clawwork never finished — useless for a packaged-app
    diagnosis. On timeout the failure_reason must carry the underlying stderr/output tail
    (run()/_spawn_rpc fold the child's stderr into the result on timeout)."""
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    _patch_backend(
        monkeypatch,
        run=lambda *a, **k: _fake_result(
            timed_out=True, stdout="", output="partial work so far",
            stderr="relay stalled: upstream 503 after 30s",
        ),
    )
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=30,
        native_session_id="sess1", is_resume=False, chat_session_id="chatA",
    )
    assert out["status"] == "failed"
    reason = out["failure_reason"]
    assert "timeout" in reason and "30s" in reason
    assert "relay stalled" in reason  # the stderr tail survived, not just a bare timeout


def test_timeout_failure_falls_back_to_output_when_no_stderr(home, monkeypatch):
    """When clawwork emits no stderr (the observed silent-hang signature), the timeout
    detail falls back to the output tail so the surface still shows something concrete."""
    from superclaw.chat_turn import execute_clawwork_native_chat_turn

    _patch_backend(
        monkeypatch,
        run=lambda *a, **k: _fake_result(
            timed_out=True, stdout="", output="CLAWWORK partial: was mid tool call", stderr="",
        ),
    )
    out = execute_clawwork_native_chat_turn(
        content="hi", repo=Path("/tmp"), budget_seconds=20,
        native_session_id="sess1", is_resume=False, chat_session_id="chatA",
    )
    assert out["status"] == "failed"
    assert "timeout" in out["failure_reason"]
    assert "was mid tool call" in out["failure_reason"]


def test_api_dispatch_map_resolves_both_backends():
    import apps.api.main as m

    assert m._native_chat_executor("claude").__name__ == "execute_claude_native_chat_turn"
    assert m._native_chat_executor("clawwork").__name__ == "execute_clawwork_native_chat_turn"
