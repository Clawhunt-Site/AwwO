"""Golden-fixture tests for the codex display projector (Display Protocol PR-2).

These feed raw codex app-server notifications/requests into ``project_codex_*``
and lock the canonical DisplayEvent / ToolCall shapes: call_id sourcing,
command/file/mcp projection, MCP args/result (the closed gap), interleaving,
no-aggregatedOutput buffer fallback, terminal repair, redaction, truncation,
and read-only auto-approval. The validator from display_contracts is the gate so
a projector cannot "fake-pass" with a malformed event.
"""
from __future__ import annotations

from superclaw.display_contracts import (
    TRUNCATE_BUDGET_BYTES,
    EventType,
    validate_display_event,
    validate_tool_call,
)
from superclaw.display_projection import (
    GEMINI_AGENT_RUNTIME_ID,
    build_adapter_diagnostic,
    new_agent_projection_state,
    new_claude_projection_state,
    new_codex_projection_state,
    project_agent_tool_execution,
    project_claude_event,
    project_claude_usage,
    project_codex_approval_requested,
    project_codex_approval_resolved,
    project_codex_event,
    project_terminal_repair,
)


def _notif(method: str, **params):
    return {"method": method, "params": params}


def _started(item_type: str, **fields):
    return _notif("item/started", item={"type": item_type, **fields})


def _completed(item_type: str, **fields):
    return _notif("item/completed", item={"type": item_type, **fields})


def _all_valid(events):
    for ev in events:
        assert validate_display_event(ev) == [], f"{ev.type}: {validate_display_event(ev)}"


# --- envelope + identity ----------------------------------------------------


def test_envelope_fields_and_synthetic_monotonic_id():
    ctx = new_codex_projection_state(turn_id="turn-1")
    e1 = project_codex_event(_started("commandExecution", id="c1", command="ls"), ctx)[0]
    e2 = project_codex_event(_completed("commandExecution", id="c1", aggregatedOutput="ok", exitCode=0), ctx)[0]
    assert e1.schema_version == 1
    assert e1.runtime_id == "codex-app-server"
    assert e1.capability_tier == "full"
    assert e1.turn_id == "turn-1"
    # Synthetic, session-local, monotonic id for the realtime chat channel (DL5).
    assert e1.id_source == "synthetic"
    assert e2.id == e2.seq and e2.seq > e1.seq
    _all_valid([e1, e2])


def test_message_events_are_not_projected_here():
    ctx = new_codex_projection_state()
    assert project_codex_event(_notif("item/agentMessage/delta", delta="hi"), ctx) == []
    assert project_codex_event(_completed("agentMessage", text="done"), ctx) == []


# --- command ----------------------------------------------------------------


def test_command_started_then_completed_ok():
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("commandExecution", id="cmd", command="pytest", cwd="/repo"), ctx)
    assert len(started) == 1 and started[0].type == EventType.TOOL_STARTED.value
    tc = started[0].payload
    assert tc["call_id"] == "cmd" and tc["call_id_source"] == "runtime"
    assert tc["kind"] == "command" and tc["status"] == "running"
    assert tc["input"] == {"command": "pytest", "cwd": "/repo"}
    assert validate_tool_call(tc) == []

    completed = project_codex_event(_completed("commandExecution", id="cmd", aggregatedOutput="3 passed", exitCode=0), ctx)
    done = completed[0].payload
    assert done["status"] == "ok" and done["exit_code"] == 0
    assert done["output"] == "3 passed"
    # The started input survives onto the completed call (open_calls reuse).
    assert done["input"] == {"command": "pytest", "cwd": "/repo"}


def test_command_nonzero_exit_is_error():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="false"), ctx)
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="boom", exitCode=2), ctx)[0].payload
    assert done["status"] == "error" and done["exit_code"] == 2


def test_command_output_falls_back_to_streamed_buffer():
    # No aggregatedOutput -> projector reconstructs output from the streamed
    # tool.delta chunks it buffered (DL5).
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="echo hi"), ctx)
    d1 = project_codex_event(_notif("item/commandExecution/outputDelta", itemId="c", delta="hel"), ctx)
    d2 = project_codex_event(_notif("item/commandExecution/outputDelta", itemId="c", delta="lo"), ctx)
    assert d1[0].type == EventType.TOOL_DELTA.value
    assert d1[0].payload == {"call_id": "c", "stream_type": "stdout", "chunk": "hel"}
    assert d2[0].payload["chunk"] == "lo"
    done = project_codex_event(_completed("commandExecution", id="c", exitCode=0), ctx)[0].payload
    assert done["output"] == "hello"


# --- file -------------------------------------------------------------------


def test_command_present_empty_output_is_not_degraded():
    # A present empty string is REAL empty output (ran, produced nothing) — must
    # NOT be conflated with "unavailable" (Full Disclosure).
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="true"), ctx)
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="", exitCode=0), ctx)[0].payload
    assert done["output"] == ""
    assert "output" not in done["degraded_fields"]


def test_command_absent_output_is_degraded():
    # No aggregatedOutput AND no streamed buffer -> truly unavailable.
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="x"), ctx)
    done = project_codex_event(_completed("commandExecution", id="c", exitCode=0), ctx)[0].payload
    assert done["output"] is None
    assert "output" in done["degraded_fields"]


def test_completion_without_native_id_correlates_to_open_call_no_phantom():
    # codex omits the item id on item/completed: completed must CORRELATE to the
    # open started call (one card) instead of synthesizing a new id and leaving
    # the started call to be terminal-repaired into a phantom error (Codex #1).
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("commandExecution", command="ls"), ctx)[0].payload
    assert started["call_id_source"] == "projector_synthesized"
    completed = project_codex_event(_completed("commandExecution", aggregatedOutput="ok", exitCode=0), ctx)
    assert len(completed) == 1
    done = completed[0].payload
    assert done["call_id"] == started["call_id"] and done["status"] == "ok"
    # Nothing left open -> no phantom error card.
    assert project_terminal_repair(ctx, cancelled=False) == []


def test_file_change_output_is_the_diff():
    # v2 fileChange carries per-file changes in `changes` (a list of
    # {path, kind, diff}); there is NO top-level diff/patch field.
    ctx = new_codex_projection_state()
    patch = "--- a.py\n+++ a.py\n@@\n-old\n+new\n"
    changes = [{"path": "a.py", "kind": {"type": "update"}, "diff": patch}]
    started = project_codex_event(_started("fileChange", id="f", changes=changes, status="inProgress"), ctx)[0].payload
    assert started["kind"] == "file" and started["input"] == {"path": "a.py"}
    done = project_codex_event(_completed("fileChange", id="f", changes=changes, status="completed"), ctx)[0].payload
    assert done["kind"] == "file" and done["status"] == "ok"
    assert done["output"] == patch


def test_file_change_multi_file_joins_paths_and_diffs():
    ctx = new_codex_projection_state()
    changes = [
        {"path": "a.py", "kind": {"type": "update"}, "diff": "diff-a"},
        {"path": "b.py", "kind": {"type": "add"}, "diff": "diff-b"},
    ]
    done = project_codex_event(_completed("fileChange", id="f", changes=changes, status="completed"), ctx)[0].payload
    assert done["input"] == {"path": "a.py; b.py"}
    assert done["output"] == "diff-a\ndiff-b"


def test_file_change_without_changes_is_degraded():
    ctx = new_codex_projection_state()
    project_codex_event(_started("fileChange", id="f"), ctx)
    done = project_codex_event(_completed("fileChange", id="f", status="completed"), ctx)[0].payload
    assert done["output"] is None and "output" in done["degraded_fields"]


def test_file_change_declined_status_is_cancelled():
    ctx = new_codex_projection_state()
    done = project_codex_event(_completed("fileChange", id="f", status="declined"), ctx)[0].payload
    assert done["status"] == "cancelled"


# --- mcp (the closed gap: args + result) ------------------------------------


def test_mcp_tool_call_carries_args_and_result():
    # v2 McpToolCall: name field is `tool`, args is `arguments`, output is `result`.
    ctx = new_codex_projection_state()
    started = project_codex_event(
        _started("mcpToolCall", id="m", server="srv", tool="search", arguments={"q": "hi"}, status="inProgress"), ctx
    )[0].payload
    assert started["kind"] == "mcp" and started["name"] == "search"
    assert started["input"] == {"q": "hi"}
    done = project_codex_event(
        _completed("mcpToolCall", id="m", server="srv", tool="search", result={"hits": 2}, status="completed"), ctx
    )[0].payload
    assert done["status"] == "ok" and done["output"] == {"hits": 2}
    assert "input" not in done["degraded_fields"]


def test_mcp_missing_args_and_result_are_degraded_not_faked():
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("mcpToolCall", id="m", tool="noargs"), ctx)[0].payload
    assert started["input"] is None and "input" in started["degraded_fields"]
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="noargs", status="completed"), ctx)[0].payload
    assert done["output"] is None and "output" in done["degraded_fields"]


def test_mcp_error_object_marks_status_error():
    # v2 McpToolCall failure is the `error` object (NOT an isError flag).
    ctx = new_codex_projection_state()
    project_codex_event(_started("mcpToolCall", id="m", tool="x", arguments={}, status="inProgress"), ctx)
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="x", result="bad", error={"message": "boom"}, status="failed"), ctx)[0].payload
    assert done["status"] == "error"


def test_mcp_completed_only_recovers_arguments():
    # No item/started seen (dropped/concurrent): the completed McpToolCall still
    # carries `arguments`, so input must be recovered, not lost (Full Disclosure).
    ctx = new_codex_projection_state()
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="x", arguments={"q": "hi"}, result={"r": 1}, status="completed"), ctx)[0].payload
    assert done["input"] == {"q": "hi"} and "input" not in done["degraded_fields"]


def test_mcp_completed_only_without_arguments_degrades_input():
    ctx = new_codex_projection_state()
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="x", status="completed"), ctx)[0].payload
    assert done["input"] is None and "input" in done["degraded_fields"]


def test_file_no_path_degrades_input_consistently():
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("fileChange", id="f"), ctx)[0].payload
    assert "input" in started["degraded_fields"]
    done = project_codex_event(_completed("fileChange", id="f", status="completed"), ctx)[0].payload
    assert "input" in done["degraded_fields"]
    # No duplicate degraded entries across started -> completed.
    assert done["degraded_fields"].count("input") == 1


def test_cross_phase_recovery_clears_stale_degraded_marker():
    # started lacks the field (-> degraded), completed supplies it: the final card
    # must NOT keep a stale degraded marker (no "value present AND degraded" lie).
    # file: no path at start, path at completed.
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("fileChange", id="f"), ctx)[0].payload
    assert "input" in started["degraded_fields"]
    changes = [{"path": "a.py", "kind": {"type": "update"}, "diff": "d"}]
    done = project_codex_event(_completed("fileChange", id="f", changes=changes, status="completed"), ctx)[0].payload
    assert done["input"] == {"path": "a.py"} and "input" not in done["degraded_fields"]

    # mcp: no args at start, args at completed.
    ctx2 = new_codex_projection_state()
    s2 = project_codex_event(_started("mcpToolCall", id="m", tool="x"), ctx2)[0].payload
    assert "input" in s2["degraded_fields"]
    d2 = project_codex_event(_completed("mcpToolCall", id="m", tool="x", arguments={"q": 1}, result="r", status="completed"), ctx2)[0].payload
    assert d2["input"] == {"q": 1} and "input" not in d2["degraded_fields"]


def test_completed_only_recovers_args_via_variant_field():
    # Consistency: completed-only recovery honors the same variant fallback
    # (arguments/input/params) as started.
    ctx = new_codex_projection_state()
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="x", params={"p": 2}, result="r", status="completed"), ctx)[0].payload
    assert done["input"] == {"p": 2} and "input" not in done["degraded_fields"]


def test_dynamic_tool_call_uses_content_items_and_success():
    # v2 DynamicToolCall: output is `contentItems`; failure is success==False.
    ctx = new_codex_projection_state()
    started = project_codex_event(_started("dynamicToolCall", id="d", tool="browse", arguments={"url": "x"}, status="inProgress"), ctx)[0].payload
    assert started["kind"] == "mcp" and started["name"] == "browse" and started["input"] == {"url": "x"}
    ok = project_codex_event(_completed("dynamicToolCall", id="d", tool="browse", contentItems=[{"type": "text", "text": "hi"}], success=True, status="completed"), ctx)[0].payload
    assert ok["status"] == "ok" and ok["output"] == [{"type": "text", "text": "hi"}]

    ctx2 = new_codex_projection_state()
    project_codex_event(_started("dynamicToolCall", id="d", tool="browse", arguments={}), ctx2)
    bad = project_codex_event(_completed("dynamicToolCall", id="d", tool="browse", success=False, status="failed"), ctx2)[0].payload
    assert bad["status"] == "error" and "output" in bad["degraded_fields"]


def test_command_duration_ms_captured():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="ls"), ctx)
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="ok", exitCode=0, durationMs=1500, status="completed"), ctx)[0].payload
    assert done["duration_ms"] == 1500


def test_command_completed_with_nonzero_exit_is_error_even_if_status_completed():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="false"), ctx)
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="boom", exitCode=1, status="completed"), ctx)[0].payload
    assert done["status"] == "error"


# --- reasoning --------------------------------------------------------------


def test_reasoning_delta_then_completed():
    ctx = new_codex_projection_state()
    d = project_codex_event(_notif("item/reasoning/delta", delta="thinking"), ctx)
    assert d[0].type == EventType.REASONING_DELTA.value and d[0].payload == {"text": "thinking"}
    c = project_codex_event(_completed("reasoning", summary=["all done"]), ctx)
    assert c[0].type == EventType.REASONING_COMPLETED.value and c[0].payload == {"text": "all done"}


def test_reasoning_completed_falls_back_to_buffered_deltas():
    ctx = new_codex_projection_state()
    project_codex_event(_notif("item/reasoning/delta", delta="part1 "), ctx)
    project_codex_event(_notif("item/reasoning/delta", delta="part2"), ctx)
    c = project_codex_event(_completed("reasoning"), ctx)
    assert c[0].payload == {"text": "part1 part2"}


# --- interleaving + missing id ----------------------------------------------


def test_interleaved_commands_tracked_by_call_id():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="a", command="one"), ctx)
    project_codex_event(_started("commandExecution", id="b", command="two"), ctx)
    done_b = project_codex_event(_completed("commandExecution", id="b", aggregatedOutput="2", exitCode=0), ctx)[0].payload
    done_a = project_codex_event(_completed("commandExecution", id="a", aggregatedOutput="1", exitCode=0), ctx)[0].payload
    assert done_b["call_id"] == "b" and done_b["input"]["command"] == "two"
    assert done_a["call_id"] == "a" and done_a["input"]["command"] == "one"


def test_missing_item_id_is_synthesized_and_flagged():
    ctx = new_codex_projection_state()
    tc = project_codex_event(_started("commandExecution", command="ls"), ctx)[0].payload
    assert tc["call_id"].startswith("commandExecution-")
    assert tc["call_id_source"] == "projector_synthesized"


# --- terminal repair (DL8) --------------------------------------------------


def test_terminal_repair_cancels_open_call_with_partial_output():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="sleep 999"), ctx)
    project_codex_event(_notif("item/commandExecution/outputDelta", itemId="c", delta="partial..."), ctx)
    repaired = project_terminal_repair(ctx, cancelled=True)
    assert len(repaired) == 1
    tc = repaired[0].payload
    assert tc["status"] == "cancelled" and tc["call_id"] == "c"
    assert tc["output"] == "partial..."
    # Idempotent: the open call was consumed.
    assert project_terminal_repair(ctx, cancelled=True) == []


def test_terminal_repair_error_when_no_partial():
    ctx = new_codex_projection_state()
    project_codex_event(_started("fileChange", id="f", path="x"), ctx)
    tc = project_terminal_repair(ctx, cancelled=False)[0].payload
    assert tc["status"] == "error" and "output" in tc["degraded_fields"]


def test_normal_completion_leaves_no_open_calls_to_repair():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="ls"), ctx)
    project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="ok", exitCode=0), ctx)
    assert project_terminal_repair(ctx, cancelled=False) == []


# --- auto-approval (DL7) ----------------------------------------------------


def test_approval_requested_and_resolved_share_id_and_kernel_decides():
    ctx = new_codex_projection_state()
    request = {"id": 41, "method": "item/commandExecution/requestApproval", "params": {"itemId": "cmd", "command": "touch ok"}}
    req = project_codex_approval_requested(request, ctx)[0]
    res = project_codex_approval_resolved(request, "accept", ctx)[0]
    assert req.type == EventType.APPROVAL_REQUESTED.value
    assert req.payload["approval_id"] == "41" and req.payload["kind"] == "command"
    assert req.payload["input_preview"] == "touch ok"
    assert res.type == EventType.APPROVAL_RESOLVED.value
    assert res.payload["approval_id"] == "41"
    assert res.payload["decided_by"] == "kernel" and res.payload["decision"] == "accept"


def test_approval_id_falls_back_to_item_id_when_no_request_id():
    ctx = new_codex_projection_state()
    request = {"method": "mcpServer/elicitation/request", "params": {"itemId": "el-7", "serverName": "x"}}
    req = project_codex_approval_requested(request, ctx)[0]
    assert req.payload["approval_id"] == "el-7" and req.payload["kind"] == "mcp"


# --- redaction + truncation (MUST, section 7.4/7.5) -------------------------


def test_secret_in_command_output_is_redacted_and_recorded():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="print"), ctx)
    secret_output = "token=ghp_" + "a" * 36
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput=secret_output, exitCode=0), ctx)[0].payload
    assert "ghp_" not in str(done["output"])
    assert "[REDACTED]" in str(done["output"])
    assert any("output" in f for f in done["redacted_fields"])


def test_input_and_output_redaction_markers_both_survive():
    # A call redacted at item/started (input) AND item/completed (output) must keep
    # BOTH "已脱敏" markers — finalize must extend, not overwrite, redacted_fields.
    ctx = new_codex_projection_state()
    secret = "ghp_" + "a" * 36
    project_codex_event(_started("mcpToolCall", id="m", tool="x", arguments={"key": secret}), ctx)
    done = project_codex_event(_completed("mcpToolCall", id="m", tool="x", result={"token": secret}, status="completed"), ctx)[0].payload
    assert any("input" in f for f in done["redacted_fields"])
    assert any("output" in f for f in done["redacted_fields"])
    assert secret not in str(done["input"]) and secret not in str(done["output"])


def test_large_output_is_truncated_with_flag():
    ctx = new_codex_projection_state()
    project_codex_event(_started("commandExecution", id="c", command="cat big"), ctx)
    big = "x" * (TRUNCATE_BUDGET_BYTES + 5000)
    done = project_codex_event(_completed("commandExecution", id="c", aggregatedOutput=big, exitCode=0), ctx)[0].payload
    assert done["truncated"]["output"] is True
    assert len(str(done["output"]).encode("utf-8")) <= TRUNCATE_BUDGET_BYTES


def test_every_projected_event_passes_the_validator():
    ctx = new_codex_projection_state()
    events = []
    events += project_codex_event(_started("commandExecution", id="c", command="ls"), ctx)
    events += project_codex_event(_notif("item/commandExecution/outputDelta", itemId="c", delta="out"), ctx)
    events += project_codex_event(_completed("commandExecution", id="c", aggregatedOutput="out", exitCode=0), ctx)
    events += project_codex_event(_started("mcpToolCall", id="m", tool="x", arguments={"a": 1}), ctx)
    events += project_codex_event(_completed("mcpToolCall", id="m", tool="x", result={"r": 1}, status="completed"), ctx)
    events += project_codex_event(_notif("item/reasoning/delta", delta="t"), ctx)
    events += project_codex_event(_completed("reasoning", summary=["done"]), ctx)
    request = {"id": 1, "method": "item/fileChange/requestApproval", "params": {"path": "a.py"}}
    events += project_codex_approval_requested(request, ctx)
    events += project_codex_approval_resolved(request, "decline", ctx)
    assert len(events) == 9
    _all_valid(events)


# --- claude (stream-json) projector (PR-3) ----------------------------------


def _assistant(*tool_uses):
    return {"type": "assistant", "message": {"content": list(tool_uses)}}


def _tool_use(tid, name, inp):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def _user_result(tool_use_id, content=None, is_error=False):
    block = {"type": "tool_result", "tool_use_id": tool_use_id, "is_error": is_error}
    if content is not None:
        block["content"] = content
    return {"type": "user", "message": {"content": [block]}}


def test_claude_tool_use_carries_input_and_kind_and_partial_tier():
    ctx = new_claude_projection_state()
    ev = project_claude_event(_assistant(_tool_use("t1", "Bash", {"command": "ls"})), ctx)[0]
    assert ev.runtime_id == "claude-cli" and ev.capability_tier == "partial"
    assert ev.type == EventType.TOOL_STARTED.value
    tc = ev.payload
    assert tc["call_id"] == "t1" and tc["call_id_source"] == "runtime"
    assert tc["name"] == "Bash" and tc["kind"] == "command"
    assert tc["input"] == {"command": "ls"}
    assert validate_tool_call(tc) == []


def test_claude_kind_classification():
    ctx = new_claude_projection_state()

    def kind_of(name):
        return project_claude_event(_assistant(_tool_use("x", name, {})), ctx)[0].payload["kind"]

    assert kind_of("Bash") == "command"
    assert kind_of("Edit") == "file"
    assert kind_of("mcp__server__search") == "mcp"
    assert kind_of("Grep") == "builtin"


def test_claude_tool_result_correlates_name_and_carries_content():
    ctx = new_claude_projection_state()
    project_claude_event(_assistant(_tool_use("t1", "Read", {"file_path": "a.py"})), ctx)
    done = project_claude_event(_user_result("t1", content="file body"), ctx)[0].payload
    # name/kind recovered from the open tool_use; content (the closed gap) carried.
    assert done["name"] == "Read" and done["kind"] == "file"
    assert done["status"] == "ok" and done["output"] == "file body"
    assert done["call_id"] == "t1"


def test_claude_tool_result_is_error_marks_error():
    ctx = new_claude_projection_state()
    project_claude_event(_assistant(_tool_use("t1", "Bash", {"command": "false"})), ctx)
    done = project_claude_event(_user_result("t1", content="boom", is_error=True), ctx)[0].payload
    assert done["status"] == "error"


def test_claude_missing_input_and_result_are_degraded_not_faked():
    ctx = new_claude_projection_state()
    started = project_claude_event(_assistant({"type": "tool_use", "id": "t1", "name": "Bash"}), ctx)[0].payload
    assert started["input"] is None and "input" in started["degraded_fields"]
    done = project_claude_event(_user_result("t1"), ctx)[0].payload  # no content
    assert done["output"] is None and "output" in done["degraded_fields"]


def test_claude_orphan_tool_result_degrades_name():
    # tool_result with no matching open tool_use: name cannot be recovered.
    ctx = new_claude_projection_state()
    done = project_claude_event(_user_result("nope", content="x"), ctx)[0].payload
    assert "name" in done["degraded_fields"] and done["kind"] == "unknown"


def test_claude_usage_event():
    ctx = new_claude_projection_state()
    ev = project_claude_usage({"input_tokens": 10, "output_tokens": 5}, ctx)[0]
    assert ev.type == EventType.USAGE.value
    assert ev.payload["usage"] == {"input_tokens": 10, "output_tokens": 5}
    assert project_claude_usage({}, ctx) == []  # nothing to surface


def test_claude_terminal_repair_closes_open_tool_use():
    ctx = new_claude_projection_state()
    project_claude_event(_assistant(_tool_use("t1", "Bash", {"command": "sleep 999"})), ctx)
    repaired = project_terminal_repair(ctx, cancelled=True)
    assert len(repaired) == 1 and repaired[0].payload["status"] == "cancelled"
    assert project_terminal_repair(ctx, cancelled=True) == []


def test_claude_secret_in_tool_result_is_redacted():
    ctx = new_claude_projection_state()
    project_claude_event(_assistant(_tool_use("t1", "Bash", {"command": "cat .env"})), ctx)
    secret = "ghp_" + "b" * 36
    done = project_claude_event(_user_result("t1", content="TOKEN=" + secret), ctx)[0].payload
    assert secret not in str(done["output"]) and "[REDACTED]" in str(done["output"])
    assert any("output" in f for f in done["redacted_fields"])


def test_every_claude_event_passes_the_validator():
    ctx = new_claude_projection_state()
    events = []
    events += project_claude_event(_assistant(_tool_use("t1", "Bash", {"command": "ls"})), ctx)
    events += project_claude_event(_user_result("t1", content="ok"), ctx)
    events += project_claude_usage({"input_tokens": 1}, ctx)
    assert len(events) == 3
    _all_valid(events)


# --- BATCH adapter diagnostic (DL4) -----------------------------------------


def test_build_adapter_diagnostic_is_honest_batch_event():
    de = build_adapter_diagnostic("grok", "grok runs as a batch worker; no live tools")
    assert de.type == EventType.ADAPTER_DIAGNOSTIC.value
    assert de.runtime_id == "grok"
    assert de.capability_tier == "batch"
    assert de.payload == {
        "streaming": False,
        "tool_lifecycle": False,
        "reason": "grok runs as a batch worker; no live tools",
    }
    assert de.id == de.to_dict()["id"]
    assert str(de.id).startswith("adapter.diagnostic:grok:1:")
    assert de.id_source == "synthetic"
    assert validate_display_event(de) == []


def test_build_adapter_diagnostic_accepts_explicit_stable_event_id():
    de = build_adapter_diagnostic(
        "grok",
        "grok runs as a batch worker; no live tools",
        event_id="adapter.diagnostic:run_1:task_1:grok:batch",
    )
    assert de.id == "adapter.diagnostic:run_1:task_1:grok:batch"
    assert validate_display_event(de) == []


# --- api-agent (gemini / anthropic) post-hoc real-tool projection -----------


def _agent_ctx():
    return new_agent_projection_state(GEMINI_AGENT_RUNTIME_ID)


def test_agent_tool_execution_emits_started_and_completed_one_card():
    ctx = _agent_ctx()
    evs = project_agent_tool_execution("call_1", "run_shell", {"command": "ls"}, "exit_code=0\nout", ctx)
    assert [e.type for e in evs] == ["tool.started", "tool.completed"]
    started, completed = evs[0].payload, evs[1].payload
    # 同 call_id → 前端 DisplayAccumulator 聚合成一张卡
    assert started["call_id"] == completed["call_id"] == "call_1"
    assert started["call_id_source"] == "runtime"
    assert completed["kind"] == "command"
    assert completed["name"] == "run_shell"
    assert completed["status"] == "ok"
    assert completed["input"] == {"command": "ls"}
    assert completed["output"] == "exit_code=0\nout"
    for ev in evs:
        assert validate_display_event(ev) == []


def test_agent_tool_error_result_marks_error():
    # _exec_tool 的 pre-exec 失败(空命令/超时)返回 "error: ..." 串
    done = project_agent_tool_execution("c", "run_shell", {"command": "x"}, "error: command timed out", _agent_ctx())[1].payload
    assert done["status"] == "error"
    assert done["output"] == "error: command timed out"


def test_agent_run_shell_nonzero_exit_is_error():
    # run_shell 命令跑了但失败(exit_code != 0)→ 必须 error,即使 result 不以 "error:"
    # 开头(与 codex projector 的 exitCode!=0=>error 一致)。这是 Codex 抓出的 bug。
    bad = project_agent_tool_execution("c", "run_shell", {"command": "false"}, "exit_code=1\nboom", _agent_ctx())[1].payload
    assert bad["status"] == "error"
    good = project_agent_tool_execution("c", "run_shell", {"command": "true"}, "exit_code=0\nok", _agent_ctx())[1].payload
    assert good["status"] == "ok"


def test_agent_read_file_content_is_ok_not_error():
    # read_file 成功返回文件内容(任意文本);只要不是工具层 "error:" 失败就是 ok。
    done = project_agent_tool_execution("c", "read_file", {"path": "a.py"}, "print('hi')\n", _agent_ctx())[1].payload
    assert done["status"] == "ok"


def test_agent_permission_denial_is_error_not_fabricated():
    denial = "error: permission denied: 'run_shell' needs approval. Do not retry."
    done = project_agent_tool_execution("c", "run_shell", {"command": "rm -rf /"}, denial, _agent_ctx())[1].payload
    assert done["status"] == "error"
    assert "permission denied" in str(done["output"])


def test_agent_write_file_is_file_kind():
    done = project_agent_tool_execution("c", "write_file", {"path": "a.txt", "content": "hi"}, "wrote 2 bytes to a.txt", _agent_ctx())[1].payload
    assert done["kind"] == "file"
    assert done["status"] == "ok"


def test_agent_missing_call_id_synthesizes_shared_projector_id():
    evs = project_agent_tool_execution(None, "list_files", {"path": "."}, "a\nb", _agent_ctx())
    assert evs[0].payload["call_id_source"] == "projector_synthesized"
    # started/completed 仍共享同一合成 id(否则前端拆成两卡)
    assert evs[0].payload["call_id"] == evs[1].payload["call_id"]


def test_agent_secret_in_tool_output_is_redacted():
    secret = "token=ghp_" + "a" * 36
    done = project_agent_tool_execution("c", "run_shell", {"command": "env"}, f"exit_code=0\n{secret}", _agent_ctx())[1].payload
    assert "[REDACTED]" in str(done["output"])
    assert any("output" in f for f in done["redacted_fields"])


# --- clawwork (pi-fork RPC) projector ---------------------------------------
# These feed raw ClawWork --mode rpc tool_execution_{start,update,end} events
# into project_clawwork_event and lock the canonical shapes: lifecycle, native
# call-id correlation, bash exit-code recovery from result text, kind mapping,
# the cumulative-snapshot (NOT delta) update contract, and terminal repair.


def _cw_ctx():
    from superclaw.display_projection import new_clawwork_projection_state

    return new_clawwork_projection_state()


def _cw(etype: str, **fields):
    return {"type": etype, **fields}


def _project_cw(raw, ctx):
    from superclaw.display_projection import project_clawwork_event

    return project_clawwork_event(raw, ctx)


def _cw_result(text: str) -> dict:
    """The documented wire result shape (rpc.md): an object with a content array
    and a details envelope -- NOT a bare string."""
    return {"content": [{"type": "text", "text": text}], "details": {"truncation": None, "fullOutputPath": None}}


def test_clawwork_started_then_completed_single_card():
    ctx = _cw_ctx()
    started = _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "ls"}), ctx)
    assert len(started) == 1 and started[0].type == EventType.TOOL_STARTED.value
    assert validate_display_event(started[0].to_dict()) == []
    sc = started[0].payload
    assert sc["call_id"] == "t1"
    assert sc["call_id_source"] == "runtime"
    assert sc["name"] == "bash"
    assert sc["kind"] == "command"
    assert sc["status"] == "running"
    assert sc["input"] == {"command": "ls"}
    assert validate_tool_call(sc) == []

    done = _project_cw(_cw("tool_execution_end", toolCallId="t1", toolName="bash", result=_cw_result("file.txt\n"), isError=False), ctx)
    assert len(done) == 1 and done[0].type == EventType.TOOL_COMPLETED.value
    assert validate_display_event(done[0].to_dict()) == []
    dc = done[0].payload
    # same call_id => one card; input recovered from the open start, output from end
    assert dc["call_id"] == "t1"
    assert dc["status"] == "ok"
    assert dc["input"] == {"command": "ls"}
    # output is the content array (claude-shaped), NEVER the {content,details} dict repr
    assert dc["output"] == [{"type": "text", "text": "file.txt\n"}]
    assert dc["exit_code"] == 0  # clean bash result => exit 0
    assert validate_tool_call(dc) == []
    # the open call was popped on completion
    assert ctx.open_calls == {}


def test_clawwork_bash_error_exit_code_from_object_result():
    # Real (documented) result is an object; the errored bash code lives inside its
    # content text. _clawwork_text must dig into content -- never str(dict).
    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "false"}), ctx)
    result = _cw_result("boom\nCommand exited with code 127")
    done = _project_cw(_cw("tool_execution_end", toolCallId="t1", toolName="bash", result=result, isError=True), ctx)[0].payload
    assert done["status"] == "error"
    assert done["exit_code"] == 127  # recovered from the errored result content text
    assert done["output"] == [{"type": "text", "text": "boom\nCommand exited with code 127"}]


def test_clawwork_result_shape_tolerance_string_and_list():
    # The projector also tolerates a bare string or content-array result without
    # leaking a dict repr (defensive: the wire shape is the object above).
    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="s", toolName="bash", args={}), ctx)
    s = _project_cw(_cw("tool_execution_end", toolCallId="s", toolName="bash", result="plain\n", isError=False), ctx)[0].payload
    assert s["output"] == "plain\n" and s["exit_code"] == 0
    ctx2 = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="l", toolName="read", args={}), ctx2)
    arr = [{"type": "text", "text": "abc"}]
    out = _project_cw(_cw("tool_execution_end", toolCallId="l", toolName="read", result=arr, isError=False), ctx2)[0].payload
    assert out["output"] == arr


def test_clawwork_non_bash_tool_never_fabricates_exit_code():
    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="w1", toolName="write", args={"path": "a.txt"}), ctx)
    done = _project_cw(_cw("tool_execution_end", toolCallId="w1", toolName="write", result=_cw_result("wrote 3 bytes"), isError=False), ctx)[0].payload
    assert done["kind"] == "file"
    assert done["status"] == "ok"
    assert done["exit_code"] is None  # only bash carries an exit code


def test_clawwork_kind_mapping():
    from superclaw.display_projection import _clawwork_kind

    assert _clawwork_kind("bash") == "command"
    assert _clawwork_kind("read") == "file"
    assert _clawwork_kind("write") == "file"
    assert _clawwork_kind("edit") == "file"
    assert _clawwork_kind("grep") == "builtin"
    assert _clawwork_kind("find") == "builtin"
    assert _clawwork_kind("ls") == "builtin"
    assert _clawwork_kind("mcp__server__tool") == "mcp"
    assert _clawwork_kind("totally-unknown") == "unknown"
    assert _clawwork_kind(None) == "unknown"


def test_clawwork_update_is_cumulative_snapshot_not_delta():
    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "slow"}), ctx)
    # updates carry a CUMULATIVE partialResult (the documented object shape); the
    # projector emits NO tool.delta (appending a snapshot as a delta would
    # double-render) and buffers the latest EXTRACTED text, never a dict repr.
    out1 = _project_cw(_cw("tool_execution_update", toolCallId="t1", toolName="bash", args={}, partialResult=_cw_result("line1\n")), ctx)
    out2 = _project_cw(_cw("tool_execution_update", toolCallId="t1", toolName="bash", args={}, partialResult=_cw_result("line1\nline2\n")), ctx)
    assert out1 == [] and out2 == []
    assert ctx.command_buffers["t1"] == ["line1\nline2\n"]  # replaced, not appended; text extracted


def test_clawwork_terminal_repair_folds_last_snapshot():
    from superclaw.display_projection import project_terminal_repair

    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "hang"}), ctx)
    _project_cw(_cw("tool_execution_update", toolCallId="t1", toolName="bash", args={}, partialResult=_cw_result("partial out")), ctx)
    # tool never finalized -> terminal repair closes the card, folding the snapshot
    # as real text (NOT a Python dict repr of the {content,details} envelope).
    repaired = project_terminal_repair(ctx, cancelled=False)
    assert len(repaired) == 1 and repaired[0].type == EventType.TOOL_COMPLETED.value
    rc = repaired[0].payload
    assert rc["call_id"] == "t1"
    assert rc["status"] == "error"
    assert rc["output"] == "partial out"
    assert ctx.open_calls == {}


def test_clawwork_terminal_repair_cancelled_status():
    from superclaw.display_projection import project_terminal_repair

    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "hang"}), ctx)
    rc = project_terminal_repair(ctx, cancelled=True)[0].payload
    assert rc["status"] == "cancelled"


def test_clawwork_completion_without_start_recovers_native_id_and_name():
    ctx = _cw_ctx()
    # end with no prior start: keep the native id, recover name/kind from the end
    done = _project_cw(_cw("tool_execution_end", toolCallId="orphan", toolName="read", result="contents", isError=False), ctx)[0].payload
    assert done["call_id"] == "orphan"
    assert done["call_id_source"] == "runtime"
    assert done["name"] == "read"
    assert done["kind"] == "file"
    assert done["status"] == "ok"
    assert "name" not in done["degraded_fields"]


def test_clawwork_missing_name_degraded_then_recovered_at_end():
    ctx = _cw_ctx()
    started = _project_cw(_cw("tool_execution_start", toolCallId="t1", args={"x": 1}), ctx)[0].payload
    assert started["name"] is None
    assert "name" in started["degraded_fields"]
    done = _project_cw(_cw("tool_execution_end", toolCallId="t1", toolName="bash", result="ok", isError=False), ctx)[0].payload
    # the end phase supplied the name -> recovered, stale degraded marker cleared
    assert done["name"] == "bash"
    assert done["kind"] == "command"
    assert "name" not in done["degraded_fields"]


def test_clawwork_non_tool_event_returns_nothing():
    ctx = _cw_ctx()
    assert _project_cw(_cw("agent_end", messages=[]), ctx) == []
    assert _project_cw(_cw("message_update", text="hi"), ctx) == []


def test_clawwork_text_never_leaks_dict_or_list_repr():
    # Regression (agy review): every content-envelope edge must yield real text or
    # "", never a Python str(dict)/str(list) repr leaking quoted syntax into a card.
    from superclaw.display_projection import _clawwork_text

    assert _clawwork_text({"content": [], "details": {}}) == ""  # empty array -> "" not "[]"
    assert _clawwork_text({"content": [{"type": "image", "source": "x"}]}) == ""  # image-only -> ""
    assert _clawwork_text({"content": "abc"}) == "abc"  # content as bare string -> extracted
    assert _clawwork_text({"details": {}}) == ""  # no content key -> "" not "{'details': {}}"
    assert _clawwork_text([{"type": "image"}]) == ""  # non-text blocks -> "" not list repr
    assert _clawwork_text("plain") == "plain"
    assert _clawwork_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "a\nb"


def test_clawwork_bash_exit_code_takes_last_match_not_first():
    # Regression (agy review): the appended status line is LAST; an echoed earlier
    # "exited with code 0" must not spoof the real non-zero code.
    from superclaw.display_projection import _clawwork_bash_exit_code

    result = {"content": [{"type": "text", "text": "exited with code 0\nreal work\nCommand exited with code 2"}]}
    assert _clawwork_bash_exit_code(result, is_error=True) == 2
    assert _clawwork_bash_exit_code({"content": []}, is_error=True) is None  # no marker -> None, not fabricated
    assert _clawwork_bash_exit_code({"content": [{"type": "text", "text": "ok"}]}, is_error=False) == 0


def test_clawwork_end_without_native_id_correlates_no_phantom():
    # Regression (agy review): a tool_execution_end missing toolCallId must correlate
    # to the open started card (by toolName), not synthesize a new id -- otherwise
    # the started card orphans into a phantom error and a stunted duplicate appears.
    from superclaw.display_projection import project_terminal_repair

    ctx = _cw_ctx()
    _project_cw(_cw("tool_execution_start", toolCallId="t1", toolName="bash", args={"command": "ls"}), ctx)
    done = _project_cw(_cw("tool_execution_end", toolName="bash", result=_cw_result("out"), isError=False), ctx)[0].payload
    assert done["call_id"] == "t1"  # correlated to the open card, not a synth id
    assert done["input"] == {"command": "ls"}  # input recovered (not a stunted duplicate)
    assert done["status"] == "ok"
    assert ctx.open_calls == {}  # the start was popped -> no phantom for terminal repair
    assert project_terminal_repair(ctx, cancelled=False) == []
