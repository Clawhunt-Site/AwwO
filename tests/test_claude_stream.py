"""Tests for the Claude Code stream-json runner and backend streaming path.

The runner is exercised end to end against a fake "claude" process (a small
Python script that prints synthetic stream-json lines), so subprocess spawn,
incremental line reading, JSONL parsing, delta coalescing, event emission,
cancellation, and timeout are all covered without needing the real CLI.
"""

from __future__ import annotations

import stat
import sys
import textwrap
from pathlib import Path

from superclaw.claude_stream import run_claude_stream
from superclaw.backends import ClaudeCliBackend, WorkerLimits
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole


def _capture():
    events: list[tuple[str, dict]] = []
    return events, (lambda etype, payload: events.append((etype, payload)))


def _printer(body: str) -> list[str]:
    return [sys.executable, "-c", textwrap.dedent(body)]


def test_run_claude_stream_streams_and_completes(tmp_path):
    events, sink = _capture()
    cmd = _printer(
        """
        import json
        def emit(o): print(json.dumps(o), flush=True)
        emit({"type":"system","subtype":"init","model":"x"})
        emit({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}})
        emit({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}})
        emit({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}})
        emit({"type":"result","subtype":"success","is_error":False,"result":"Hello","usage":{"input_tokens":1}})
        """
    )
    res = run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10, on_event=sink)

    assert res.exit_code == 0
    assert res.final_text == "Hello"
    assert res.is_error is False
    assert res.tool_iterations == 1
    assert res.usage == {"input_tokens": 1}

    types = [t for t, _ in events]
    assert "message.delta" in types
    assert "tool.started" in types
    assert "tool.completed" in types
    assert "message.completed" in types
    # PR-3: claude now emits a canonical usage event from the parsed token usage.
    assert "usage" in types

    # Text stream keeps its bare wire shape (message.delta/completed unchanged).
    delta_text = "".join(p["text"] for t, p in events if t == "message.delta")
    assert delta_text == "Hello"
    assert [p for t, p in events if t == "message.completed"][0]["text"] == "Hello"
    # Tool events are canonical DisplayEvents: payload is the ToolCall (name/kind),
    # not the old flat {tool, tool_use_id} shape.
    started = [p for t, p in events if t == "tool.started"][0]
    assert started["runtime_id"] == "claude-cli" and started["capability_tier"] == "partial"
    assert started["payload"]["name"] == "Bash" and started["payload"]["kind"] == "command"
    assert started["payload"]["call_id"] == "t1"
    usage_ev = [p for t, p in events if t == "usage"][0]
    assert usage_ev["payload"]["usage"] == {"input_tokens": 1}


def test_run_claude_stream_recovers_streamed_tool_input(tmp_path):
    # Regression (Display Protocol PR-3, Codex blocking): with
    # --include-partial-messages claude streams tool args via
    # content_block_start + input_json_delta and the final assistant wrapper
    # carries an EMPTY input. The projector must recover the real args from the
    # streamed JSON, not silently emit {} (Full Disclosure).
    events, sink = _capture()
    cmd = _printer(
        """
        import json
        def emit(o): print(json.dumps(o), flush=True)
        emit({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Write","input":{}}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"a.py\\","}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"content\\":\\"x\\"}"}}})
        emit({"type":"stream_event","event":{"type":"content_block_stop","index":0}})
        emit({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{}}]}})
        emit({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}})
        emit({"type":"result","subtype":"success","is_error":False,"result":"done"})
        """
    )
    run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10, on_event=sink)

    started = [p for t, p in events if t == "tool.started"][0]
    tc = started["payload"]
    assert tc["name"] == "Write" and tc["kind"] == "file"
    # Real args recovered from input_json_delta, NOT the empty {} wrapper.
    assert tc["input"] == {"file_path": "a.py", "content": "x"}


def test_run_claude_stream_recovers_input_across_index_reuse(tmp_path):
    # Regression (Codex r2 #1): a multi-tool agent loop reuses content-block
    # index 0 per assistant message. Each new tool_use must start a clean buffer,
    # or tool 2's partial_json concatenates onto tool 1's leftover and parses to
    # garbage. Both tools' inputs must be recovered distinctly.
    events, sink = _capture()
    cmd = _printer(
        """
        import json
        def emit(o): print(json.dumps(o), flush=True)
        emit({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"a.py\\"}"}}})
        emit({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}})
        emit({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"A"}]}})
        emit({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"Read","input":{}}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"b.py\\"}"}}})
        emit({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{}}]}})
        emit({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"B"}]}})
        emit({"type":"result","subtype":"success","is_error":False,"result":"done"})
        """
    )
    run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10, on_event=sink)

    inputs = {p["payload"]["call_id"]: p["payload"]["input"] for t, p in events if t == "tool.started"}
    assert inputs["t1"] == {"file_path": "a.py"}
    assert inputs["t2"] == {"file_path": "b.py"}  # not garbage from t1's leftover


def test_run_claude_stream_degrades_unreconstructable_tool_input(tmp_path):
    # Regression (Codex r2 #2): streamed input that cannot be reconstructed
    # (truncated/garbage JSON) must be marked degraded, NOT reported as a fake
    # no-args {} (Full Disclosure).
    events, sink = _capture()
    cmd = _printer(
        """
        import json
        def emit(o): print(json.dumps(o), flush=True)
        emit({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}})
        emit({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls"}}})
        emit({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}})
        emit({"type":"result","subtype":"success","is_error":False,"result":"done"})
        """
    )
    run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10, on_event=sink)

    tc = [p["payload"] for t, p in events if t == "tool.started"][0]
    assert tc["input"] is None and "input" in tc["degraded_fields"]


def test_run_claude_stream_coalesces_deltas(tmp_path):
    events, sink = _capture()
    # 12 small deltas, each well under the flush threshold and emitted instantly,
    # so they coalesce into a single flushed message.delta at the end.
    cmd = _printer(
        """
        import json
        def emit(o): print(json.dumps(o), flush=True)
        for i in range(12):
            emit({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ab"}}})
        emit({"type":"result","subtype":"success","is_error":False,"result":"ab"*12})
        """
    )
    res = run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10, on_event=sink)

    deltas = [p for t, p in events if t == "message.delta"]
    assert "".join(p["text"] for p in deltas) == "ab" * 12
    assert len(deltas) < 12  # coalesced, not one event per token
    assert res.final_text == "ab" * 12


def test_run_claude_stream_cancel(tmp_path):
    events, sink = _capture()
    cmd = _printer(
        """
        import json, time
        print(json.dumps({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}), flush=True)
        time.sleep(30)
        """
    )
    res = run_claude_stream(cmd, cwd=tmp_path, budget_seconds=30, cancel_check=lambda: True, on_event=sink)

    assert res.cancelled is True
    assert res.exit_code == 130


def test_run_claude_stream_timeout(tmp_path):
    cmd = _printer(
        """
        import time
        time.sleep(30)
        """
    )
    res = run_claude_stream(cmd, cwd=tmp_path, budget_seconds=0.3)

    assert res.timed_out is True
    assert res.exit_code == 124


def test_run_claude_stream_non_json_yields_no_parsed_events(tmp_path):
    cmd = _printer(
        """
        print("this is not json", flush=True)
        print("neither is this", flush=True)
        """
    )
    res = run_claude_stream(cmd, cwd=tmp_path, budget_seconds=10)

    assert res.parsed_events == 0  # signals the backend to fall back to batch json


def _fake_claude_executable(tmp_path: Path) -> str:
    script = tmp_path / "fakeclaude"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'Hello'}}}))\n"
        "print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'Hello'}))\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(script)


def test_claude_backend_streams_when_sink_present(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CLAUDE_EXECUTABLE", _fake_claude_executable(tmp_path))
    events, sink = _capture()
    backend = ClaudeCliBackend()
    task = TaskNode(task_id="t1", role=WorkerRole.IMPLEMENT, title="implement task")
    goal = GoalSpec(title="goal", description="do it")
    session = RunSession(goal_id=goal.goal_id)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=30,
        permission_policy=None,
        event_sink=sink,
    )

    result = backend.run(task, goal, session, limits)

    assert result.exit_code == 0
    assert "Hello" in result.output
    assert "superclaw_worker_result" in result.output  # success marker for the verdict layer
    types = [t for t, _ in events]
    assert "message.delta" in types
    assert "message.completed" in types
