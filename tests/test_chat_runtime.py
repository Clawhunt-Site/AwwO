from types import SimpleNamespace

from superclaw.chat_runtime import (
    REQUEST_CLEAR,
    apply_chat_runtime,
    resolve_chat_runtime,
    sticky_chat_runtime,
)
from superclaw.chat_turn import execute_direct_chat_turn
from superclaw.state import StateStore


def test_resolve_defaults_when_nothing_requested_or_sticky():
    selection = resolve_chat_runtime({}, default_backend="claude")

    assert selection.backend == "claude"
    assert selection.model is None
    assert selection.backend_switched is False
    assert selection.handoff_note is None


def test_resolve_prefers_sticky_runtime_over_default():
    metadata = {"runtime": {"backend": "hermes", "model": "anthropic/claude-sonnet-4.6"}}

    selection = resolve_chat_runtime(metadata, default_backend="claude")

    assert selection.backend == "hermes"
    assert selection.model == "anthropic/claude-sonnet-4.6"
    assert selection.backend_switched is False


def test_resolve_explicit_request_beats_sticky():
    metadata = {"runtime": {"backend": "hermes", "model": "sticky-model"}}

    selection = resolve_chat_runtime(
        metadata, requested_backend="hermes", requested_model="explicit-model"
    )

    assert selection.backend == "hermes"
    assert selection.model == "explicit-model"


def test_backend_switch_drops_sticky_model_and_emits_handoff():
    metadata = {"runtime": {"backend": "claude", "model": "claude-opus-4-8"}}

    selection = resolve_chat_runtime(metadata, requested_backend="codex")

    assert selection.backend == "codex"
    assert selection.model is None  # model ids are not portable across runtimes
    assert selection.backend_switched is True
    assert selection.previous_backend == "claude"
    assert selection.handoff_note and "claude → codex" in selection.handoff_note


def test_backend_switch_keeps_model_only_when_explicitly_requested():
    metadata = {"runtime": {"backend": "claude", "model": "claude-opus-4-8"}}

    selection = resolve_chat_runtime(
        metadata, requested_backend="codex", requested_model="gpt-5.2-codex"
    )

    assert selection.backend == "codex"
    assert selection.model == "gpt-5.2-codex"
    assert selection.backend_switched is True


def test_request_clear_drops_sticky_model_without_backend_switch():
    metadata = {"runtime": {"backend": "claude", "model": "claude-opus-4-8"}}

    selection = resolve_chat_runtime(metadata, requested_model=REQUEST_CLEAR)

    assert selection.backend == "claude"
    assert selection.model is None
    assert selection.backend_switched is False


def test_apply_chat_runtime_is_idempotent():
    selection = resolve_chat_runtime({}, requested_backend="hermes", requested_model="m1")
    metadata, changed = apply_chat_runtime({}, selection)

    assert changed is True
    assert metadata["runtime"] == {"backend": "hermes", "model": "m1"}

    again, changed_again = apply_chat_runtime(metadata, selection)
    assert changed_again is False
    assert again["runtime"] == metadata["runtime"]


def test_sticky_chat_runtime_ignores_malformed_metadata():
    assert sticky_chat_runtime(None) == (None, None, None)
    assert sticky_chat_runtime({"runtime": "claude"}) == (None, None, None)
    assert sticky_chat_runtime({"runtime": {"backend": "  ", "model": "", "effort": "  "}}) == (None, None, None)


def test_state_store_chat_runtime_roundtrip(tmp_path):
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Runtime sticky")

    assert store.get_chat_runtime(session.session_id) is None

    store.set_chat_runtime(session.session_id, backend="hermes", model="anthropic/claude-sonnet-4.6")
    assert store.get_chat_runtime(session.session_id) == {
        "backend": "hermes",
        "model": "anthropic/claude-sonnet-4.6",
    }

    # clearing the model drops the key entirely (backend default governs again)
    store.set_chat_runtime(session.session_id, backend="hermes", model=None)
    assert store.get_chat_runtime(session.session_id) == {"backend": "hermes"}


def test_direct_chat_turn_passes_model_in_exec_mode(tmp_path, monkeypatch):
    import superclaw.chat_turn as chat_turn_module

    seen = {}
    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        seen["command"] = command
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(
        content="hello", backend="codex", repo=tmp_path, budget_seconds=5, model="gpt-5.2-codex"
    )

    assert result["status"] == "completed"
    command = seen["command"]
    assert "--model" in command and command[command.index("--model") + 1] == "gpt-5.2-codex"
    assert command[-1].endswith("hello")  # prompt stays the trailing positional


def test_direct_chat_turn_fails_closed_on_model_in_legacy_mode(tmp_path, monkeypatch):
    import superclaw.chat_turn as chat_turn_module

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "legacy")

    def fail_run(command, **kwargs):
        raise AssertionError("legacy codex must not run when a model selection cannot be honored")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fail_run)

    result = execute_direct_chat_turn(
        content="hello", backend="codex", repo=tmp_path, budget_seconds=5, model="gpt-5.2-codex"
    )

    assert result["status"] == "failed"
    assert "MODEL_OVERRIDE_UNSUPPORTED" in result["failure_reason"]


def test_direct_chat_turn_codex_app_server_uses_codex_exec_channel(tmp_path, monkeypatch):
    import superclaw.chat_turn as chat_turn_module

    seen = {}
    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        seen["command"] = command
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hello", backend="codex-app-server", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert seen["command"][0] == "/tmp/codex" and seen["command"][1] == "exec"


def _fake_worker(*, name="hermes", available=True, reason=None, output='{"result": "hi"}', exit_code=0, captured=None, stdout=None, stderr=None):
    from superclaw.backends import BackendAvailability
    from superclaw.models import WorkerResult

    class FakeWorker:
        def __init__(self):
            self.name = name

        def available(self):
            return BackendAvailability(name=name, available=available, reason=reason)

        def run(self, task, goal, session, limits):
            if captured is not None:
                captured.update({"task": task, "goal": goal, "session": session, "limits": limits})
            return WorkerResult(task.task_id, task.role.value, name, f"{name} chat", exit_code, output, 0.1, stdout=stdout, stderr=stderr)

        def permission_presets(self):  # registry conformance shape; unused here
            return {}

    return FakeWorker()


def test_direct_chat_turn_dispatches_to_generic_backend_runtime(tmp_path, monkeypatch):
    import superclaw.backends as backends_module

    captured: dict = {}
    worker = _fake_worker(name="claude", output='{"result": "hi from claude"}', captured=captured)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(
        content="hello there",
        backend="claude",
        repo=tmp_path,
        budget_seconds=5,
        history="User: earlier turn",
        model="anthropic/claude-sonnet-4.6",
    )

    assert result == {"intent": "chat", "backend": "claude", "status": "completed", "response": "hi from claude"}
    goal = captured["goal"]
    # the chat prompt rides goal.description verbatim, flagged for the _prompt chat branch
    assert goal.metadata["chat_turn_intent"] == "chat"
    assert "hello there" in goal.description and "User: earlier turn" in goal.description
    assert goal.acceptance_criteria == []
    limits = captured["limits"]
    assert limits.model_override == "anthropic/claude-sonnet-4.6"
    # always an explicit policy (NOT None — policy=None is not uniform across
    # the registry); default chat posture is the "ask" preset projection, which
    # under the max-permission doctrine is bypassPermissions (runtime is a pure
    # execution engine; a conservative headless mode would auto-deny tools).
    assert limits.permission_policy is not None and limits.permission_policy.mode == "bypassPermissions"
    assert limits.repo_path == tmp_path


def test_direct_chat_turn_attaches_usage_from_display_event(tmp_path, monkeypatch):
    # The chat surface persists the token tally shown live (the Display Protocol
    # ``usage`` event). The kernel must surface that same tally on the result dict
    # so the API can persist it — whether the backend streamed it to a caller sink
    # or to the sync collector. Here the backend projects a usage event through the
    # limits.event_sink; the result must carry it verbatim.
    import superclaw.backends as backends_module
    from superclaw.backends import BackendAvailability
    from superclaw.models import WorkerResult

    tally = {"input_tokens": 4391, "output_tokens": 439, "cache_read_input_tokens": 35710}

    class UsageWorker:
        name = "anthropic"

        def available(self):
            return BackendAvailability(name="anthropic", available=True)

        def run(self, task, goal, session, limits):
            if limits.event_sink is not None:
                limits.event_sink("usage", {"usage": tally})
            return WorkerResult(task.task_id, task.role.value, "anthropic", "reply", 0, '{"result": "ok reply"}', 0.1, stdout='{"result": "ok reply"}')

        def permission_presets(self):
            return {}

    monkeypatch.setattr(backends_module, "default_backends", lambda: {"anthropic": UsageWorker()})

    # Sync path (no caller sink): the choke-point collector captures the usage.
    result = execute_direct_chat_turn(content="hi", backend="anthropic", repo=tmp_path, budget_seconds=5)
    assert result["status"] == "completed"
    assert result["usage"] == tally

    # Streaming path (caller sink): usage still rides the result, AND is forwarded.
    forwarded: list = []
    streamed = execute_direct_chat_turn(
        content="hi", backend="anthropic", repo=tmp_path, budget_seconds=5,
        event_sink=lambda et, p: forwarded.append((et, p)),
    )
    assert streamed["usage"] == tally
    assert ("usage", {"usage": tally}) in forwarded


def test_direct_chat_turn_generic_unwraps_claude_event_array(tmp_path, monkeypatch):
    # claude CLI 2.x --output-format json emits an event ARRAY whose trailing
    # result object carries the reply — verified against claude_code_version 2.1.76
    import superclaw.backends as backends_module

    event_array = (
        '[{"type":"system","subtype":"init","session_id":"s1"},'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}},'
        '{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"s1"}]'
    )
    worker = _fake_worker(name="claude", output=event_array)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="ping", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "PONG"


def test_direct_chat_turn_generic_extracts_result_despite_stderr_tail(tmp_path, monkeypatch):
    # run_command() output is stdout + stderr (+ failure-classification line on
    # nonzero exit). The claude JSON event array must still be parsed so the
    # failure detail shows the real result text ("Not logged in"), not the init
    # event's MCP tool list.
    import superclaw.backends as backends_module

    event_array = (
        '[{"type":"system","subtype":"init","tools":["mcp__plugin_playwright__browser_type","mcp__x__y"]},'
        '{"type":"result","subtype":"error","is_error":true,"result":"Not logged in · Please run /login"}]'
    )
    output = event_array + "\nSuperClaw classified backend output as failure: exit_code=1"
    worker = _fake_worker(name="claude", output=output, exit_code=1)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "Not logged in" in result["failure_reason"]
    assert "browser_type" not in result["failure_reason"]


def test_direct_chat_turn_generic_salvages_result_from_tail_truncated_output(tmp_path, monkeypatch):
    # WorkerResult.output keeps only the TAIL of large outputs, so the event
    # array's opening bracket can be cut off (the init event's giant MCP tool
    # list pushes it past the evidence limit). The trailing result object must
    # still be salvaged instead of echoing raw tool-name JSON to the user.
    import superclaw.backends as backends_module

    tail_truncated = (
        '_take_screenshot","mcp__plugin_playwright__browser_snapshot","mcp__x__y"]},'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"我是 Claude"}]}},'
        '{"type":"result","subtype":"success","is_error":false,"result":"我是 Claude"}]'
    )
    worker = _fake_worker(name="claude", output=tail_truncated)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="你是什么模型", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "我是 Claude"


def test_direct_chat_turn_generic_strips_worker_result_marker(tmp_path, monkeypatch):
    import superclaw.backends as backends_module

    worker = _fake_worker(name="claude", output="real answer\nsuperclaw_worker_result backend=claude role=implement goal=g status=completed")
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "real answer"


def test_direct_chat_turn_unknown_backend_fails_closed(tmp_path):
    result = execute_direct_chat_turn(content="hi", backend="no-such-backend", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "direct_chat_unsupported" in result["failure_reason"]
    assert "no-such-backend" in result["failure_reason"]


def test_direct_chat_turn_generic_backend_unavailable_fails_closed(tmp_path, monkeypatch):
    import superclaw.backends as backends_module

    worker = _fake_worker(name="claude", available=False, reason="claude executable not found")
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "claude executable not found" in result["failure_reason"]


def test_direct_chat_turn_generic_nonzero_exit_fails_with_detail(tmp_path, monkeypatch):
    import superclaw.backends as backends_module

    worker = _fake_worker(name="claude", output="auth error: login required", exit_code=126)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "exit code 126" in result["failure_reason"]
    assert "auth error" in result["failure_reason"]


_GROK_STDERR_NOISE = (
    "\x1b[2m2026-06-12T07:27:08.417680Z\x1b[0m \x1b[31mERROR\x1b[0m "
    "Error reading from stream: serde error data did not match any variant of untagged enum JsonRpcMessage\n"
)


def test_direct_chat_turn_success_drops_stderr_noise_and_ansi(tmp_path, monkeypatch):
    # The real grok bug: the CLI answers on stdout and writes an ANSI-colored
    # tracing log to stderr on a CLEAN exit. The reply must be the stdout text
    # only — no [2m/[31m garbage, no ERROR line glued to the answer.
    import superclaw.backends as backends_module

    answer = "我是 Grok 4.3，由 xAI 于 2026 年 4 月发布。"
    worker = _fake_worker(
        name="grok",
        output=answer + _GROK_STDERR_NOISE,
        stdout=answer,
        stderr=_GROK_STDERR_NOISE,
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="你是什么模型", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == answer
    assert "ERROR" not in result["response"]
    assert "\x1b" not in result["response"]


def test_direct_chat_turn_strips_ansi_even_from_stdout(tmp_path, monkeypatch):
    # A CLI that colors its stdout reply still reads clean in the bubble.
    import superclaw.backends as backends_module

    worker = _fake_worker(name="grok", output="", stdout="\x1b[1mbold answer\x1b[0m and \x1b]8;;https://x.ai\x1b\\a link\x1b]8;;\x1b\\", stderr="")
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "bold answer and a link"


def test_direct_chat_turn_failure_detail_prefers_merged_stream_then_stderr_tail(tmp_path, monkeypatch):
    # Failure diagnostics often live on stderr ("Not logged in") — the
    # stdout-only success channel must not hide them from failure_reason.
    import superclaw.backends as backends_module

    worker = _fake_worker(
        name="grok",
        output="\x1b[31mfatal:\x1b[0m grok api key missing\n",
        exit_code=1,
        stdout="",
        stderr="\x1b[31mfatal:\x1b[0m grok api key missing\n",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "grok api key missing" in result["failure_reason"]
    assert "\x1b" not in result["failure_reason"]


def test_direct_chat_turn_failure_reason_surfaces_classified_marker(tmp_path, monkeypatch):
    # _failure_marker flips exit 0 → 126 and appends a classification line to
    # the merged output; that verdict must reach the user even when the reply
    # extraction picked other text.
    import superclaw.backends as backends_module

    worker = _fake_worker(
        name="grok",
        output="some banner\nSuperClaw classified backend output as failure: grok api key",
        exit_code=126,
        stdout="some banner",
        stderr="",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "grok api key" in result["failure_reason"]


def test_direct_chat_turn_exit0_stderr_only_is_diagnostic_failure(tmp_path, monkeypatch):
    # exit 0 with an empty stdout is NOT a reply — and stderr must never be
    # promoted to one. Surface a diagnostic failure instead of an empty bubble.
    import superclaw.backends as backends_module

    worker = _fake_worker(name="grok", output=_GROK_STDERR_NOISE, exit_code=0, stdout="", stderr=_GROK_STDERR_NOISE)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "no reply on stdout" in result["failure_reason"]
    assert "JsonRpcMessage" in result["failure_reason"]
    assert "\x1b" not in result["failure_reason"]


def test_direct_chat_turn_legacy_worker_without_split_streams_still_replies(tmp_path, monkeypatch):
    # stdout=None means "not populated" (legacy/direct WorkerResult
    # constructions): the merged output remains the reply source.
    import superclaw.backends as backends_module

    worker = _fake_worker(name="grok", output="plain legacy answer", stdout=None, stderr=None)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "plain legacy answer"


def test_direct_chat_turn_claude_envelope_on_stdout_with_stderr_noise(tmp_path, monkeypatch):
    # JSON-envelope backends ride the same stdout-only channel: the envelope
    # parses cleanly without the stderr tail glued on.
    import superclaw.backends as backends_module

    envelope = '{"result": "hi from claude"}'
    worker = _fake_worker(name="claude", output=envelope + "\n" + _GROK_STDERR_NOISE, stdout=envelope, stderr=_GROK_STDERR_NOISE)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "hi from claude"


def test_strip_ansi_sequences_covers_csi_osc_and_bare_esc():
    from superclaw.chat_turn import strip_ansi_sequences

    assert strip_ansi_sequences("\x1b[2mdim\x1b[0m \x1b[31mred\x1b[0m") == "dim red"
    assert strip_ansi_sequences("\x1b]0;window title\x07text") == "text"
    assert strip_ansi_sequences("\x1b]8;;https://x.ai\x1b\\link\x1b]8;;\x1b\\") == "link"
    assert strip_ansi_sequences("pre\x1bMpost") == "prepost"  # two-char Fe escape
    assert strip_ansi_sequences("dangling\x1b") == "dangling"  # bare ESC remnant
    # literal backslash-x1b TEXT (no real ESC byte) is untouched
    assert strip_ansi_sequences("use \\x1b[31m for red") == "use \\x1b[31m for red"


def test_strip_ansi_unterminated_osc_does_not_eat_following_lines():
    # An OSC/DCS sequence may arrive WITHOUT its terminator (crashed CLI). The
    # payload match must stop at the newline, or every diagnostic line after
    # it would be swallowed.
    from superclaw.chat_turn import strip_ansi_sequences

    assert strip_ansi_sequences("pre\x1b]0;title\r\nerror detail\r\npost") == "pre\r\nerror detail\r\npost"
    assert strip_ansi_sequences("pre\x1bPpayload\nreal line") == "pre\nreal line"


def test_direct_chat_turn_strips_ansi_decoded_from_json_envelope(tmp_path, monkeypatch):
    # A JSON string value carries ESC as a backslash-u escape; json decode turns
    # it back into a REAL ESC byte after the entry-point strip already ran, so
    # the extracted reply must be stripped again.
    import superclaw.backends as backends_module

    envelope = '{"result": "\\u001b[31mred alert\\u001b[0m done"}'
    worker = _fake_worker(name="claude", output=envelope, stdout=envelope, stderr="")
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "red alert done"
    assert "\x1b" not in result["response"]


def test_direct_chat_turn_failure_detail_not_shortcircuited_by_stdout_banner(tmp_path, monkeypatch):
    # Non-zero exit with a harmless stdout banner must still surface the real
    # stderr error: the failure detail consults the merged stream FIRST.
    import superclaw.backends as backends_module

    worker = _fake_worker(
        name="grok",
        output="grok cli v1.2.3 banner\nfatal: api key missing\n",
        exit_code=1,
        stdout="grok cli v1.2.3 banner\n",
        stderr="fatal: api key missing\n",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_direct_chat_turn_failure_detail_keeps_stderr_despite_json_envelope_banner(tmp_path, monkeypatch):
    # The merged-output extraction is envelope-aware: a JSON envelope on stdout
    # makes raw_decode keep the leading JSON and DROP the tail — including the
    # stderr fatal. The failure detail must append the stderr tail anyway.
    import superclaw.backends as backends_module

    envelope = '{"result": "stdout banner"}'
    worker = _fake_worker(
        name="claude",
        output=envelope + "\nfatal: api key missing\n",
        exit_code=1,
        stdout=envelope,
        stderr="fatal: api key missing\n",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_direct_chat_turn_failure_detail_keeps_stderr_despite_long_json_result(tmp_path, monkeypatch):
    # A LONG primary detail must not push the appended stderr fragment past
    # the 240-char display truncation: the stderr tail has its own reserved
    # budget slice.
    import superclaw.backends as backends_module

    long_result = "B" * 300
    envelope = f'{{"result": "{long_result}"}}'
    worker = _fake_worker(
        name="claude",
        output=envelope + "\nfatal: api key missing\n",
        exit_code=1,
        stdout=envelope,
        stderr="fatal: api key missing\n",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(content="hi", backend="claude", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]
    assert "BBB" in result["failure_reason"]  # primary context still visible


def test_direct_chat_turn_failure_detail_keeps_stderr_head_fatal_with_long_trace(tmp_path, monkeypatch):
    # Common CLI failure shape: "fatal: ..." FIRST, then a long stack trace.
    # A tail-only stderr budget would keep just the trace noise and lose the
    # fatal — slices must keep both ends.
    import superclaw.backends as backends_module

    noisy_stderr = "fatal: api key missing\n" + ("trace line\n" * 80)
    worker = _fake_worker(
        name="grok",
        output="P" * 300 + "\n" + noisy_stderr,
        exit_code=1,
        stdout="P" * 300,
        stderr=noisy_stderr,
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_direct_chat_turn_failure_detail_keeps_stderr_in_long_plain_merged_output(tmp_path, monkeypatch):
    # Plain merged output carries stderr at its END. Dedup must judge on the
    # KEPT head slice — judging on the full primary would drop the stderr
    # segment right before head-truncation cuts that very end off.
    import superclaw.backends as backends_module

    long_banner = "B" * 300
    worker = _fake_worker(
        name="grok",
        output=long_banner + "\nfatal: api key missing\n",
        exit_code=1,
        stdout=long_banner,
        stderr="fatal: api key missing\n",
    )
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"grok": worker})

    result = execute_direct_chat_turn(content="hi", backend="grok", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_codex_fast_path_failure_detail_keeps_stderr_in_long_stdout_fallback(tmp_path, monkeypatch):
    # No --output-last-message file on a non-zero exit → the fallback joins
    # stdout+stderr; a long stdout must not let dedup-then-truncate cut the
    # stderr fatal off the end.
    import superclaw.chat_turn as chat_turn_module
    from types import SimpleNamespace

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override: ("/tmp/codex", "env"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        return SimpleNamespace(returncode=1, stdout="B" * 300, stderr="fatal: api key missing\n")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hi", backend="codex", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_codex_fast_path_failure_detail_keeps_stderr_despite_long_last_message(tmp_path, monkeypatch):
    import superclaw.chat_turn as chat_turn_module
    from pathlib import Path
    from types import SimpleNamespace

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override: ("/tmp/codex", "env"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        out_path = Path(command[command.index("--output-last-message") + 1])
        out_path.write_text("B" * 300, encoding="utf-8")
        return SimpleNamespace(returncode=1, stdout="", stderr="fatal: api key missing\n")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hi", backend="codex", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]


def test_codex_fast_path_failure_detail_keeps_stderr_despite_last_message_file(tmp_path, monkeypatch):
    # A partial --output-last-message file (or stdout banner) must not mask
    # the stderr fatal on a non-zero exit.
    import superclaw.chat_turn as chat_turn_module
    from pathlib import Path
    from types import SimpleNamespace

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override: ("/tmp/codex", "env"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        out_path = Path(command[command.index("--output-last-message") + 1])
        out_path.write_text("partial banner", encoding="utf-8")
        return SimpleNamespace(returncode=1, stdout="", stderr="fatal: api key missing\n")

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hi", backend="codex", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "fatal: api key missing" in result["failure_reason"]
    assert "partial banner" in result["failure_reason"]


def test_codex_fast_path_success_drops_stderr_noise(tmp_path, monkeypatch):
    # The codex --output-last-message fallback joins stdout+stderr today; on a
    # clean exit only stdout (ANSI-stripped) may become the reply.
    import superclaw.chat_turn as chat_turn_module
    from types import SimpleNamespace

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override: ("/tmp/codex", "env"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        return SimpleNamespace(returncode=0, stdout="\x1b[1mcodex answer\x1b[0m\n", stderr=_GROK_STDERR_NOISE)

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hi", backend="codex", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "completed"
    assert result["response"] == "codex answer"


def test_codex_fast_path_exit0_stderr_only_is_diagnostic_failure(tmp_path, monkeypatch):
    import superclaw.chat_turn as chat_turn_module
    from types import SimpleNamespace

    monkeypatch.setattr(chat_turn_module, "find_codex_executable", lambda override: ("/tmp/codex", "env"))
    monkeypatch.setattr(chat_turn_module, "codex_cli_mode", lambda executable: "exec")

    def fake_run(command, **kwargs):
        return SimpleNamespace(returncode=0, stdout="", stderr=_GROK_STDERR_NOISE)

    monkeypatch.setattr(chat_turn_module.subprocess, "run", fake_run)

    result = execute_direct_chat_turn(content="hi", backend="codex", repo=tmp_path, budget_seconds=5)

    assert result["status"] == "failed"
    assert "no reply on stdout" in result["failure_reason"]
    assert "\x1b" not in result["failure_reason"]


def test_direct_chat_turn_any_registered_backend_is_native(tmp_path, monkeypatch):
    # Unified entry: chat is a NATIVE runtime turn on every registered backend —
    # no whitelist refusal. The permission mode (not a hardcoded read-only
    # posture) governs what the runtime may do.
    import superclaw.backends as backends_module

    captured: dict = {}
    for backend in ("hermes", "grok", "cursor", "opencode", "claude", "gemini"):
        worker = _fake_worker(name=backend, output='{"result": "ok"}', captured=captured)
        monkeypatch.setattr(backends_module, "default_backends", lambda w=worker, b=backend: {b: w})
        result = execute_direct_chat_turn(content="hi", backend=backend, repo=tmp_path, budget_seconds=5)
        assert result["status"] == "completed", backend
        # default chat posture = "ask" projection = bypassPermissions (max-permission doctrine)
        assert captured["limits"].permission_policy.mode == "bypassPermissions", backend


def test_direct_chat_turn_passes_permission_mode_through(tmp_path, monkeypatch):
    # The user's ask/allow preset projects onto a mode and passes through to the
    # runtime's own sandbox mapping, exactly like a delivery run.
    import superclaw.backends as backends_module

    captured: dict = {}
    worker = _fake_worker(name="claude", output='{"result": "ok"}', captured=captured)
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"claude": worker})

    result = execute_direct_chat_turn(
        content="hi", backend="claude", repo=tmp_path, budget_seconds=5,
        permission_mode="bypassPermissions",
    )
    assert result["status"] == "completed"
    assert captured["limits"].permission_policy.mode == "bypassPermissions"


def test_agent_cli_prompt_passes_chat_description_verbatim():
    from superclaw.backends import ClaudeCliBackend
    from superclaw.models import GoalSpec, TaskNode, WorkerRole

    goal = GoalSpec(
        title="SuperClaw direct chat",
        description="FULL CHAT PROMPT",
        acceptance_criteria=[],
        metadata={"chat_turn_intent": "chat"},
    )
    task = TaskNode(task_id="t1", role=WorkerRole.IMPLEMENT, title="direct chat turn")

    prompt = ClaudeCliBackend()._prompt(task, goal)

    assert prompt == "FULL CHAT PROMPT"
    assert "superclaw_worker_result" not in prompt


def test_state_native_session_roundtrip(tmp_path):
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Native binding")
    sid = session.session_id

    assert store.get_chat_native_session_id(sid, "claude") is None
    store.set_chat_native_session_id(sid, "claude", "uuid-1")
    assert store.get_chat_native_session_id(sid, "claude") == "uuid-1"
    assert store.get_chat_native_session_id(sid, "cursor") is None  # per-backend
    store.drop_chat_native_session_id(sid, "claude")
    assert store.get_chat_native_session_id(sid, "claude") is None


def _fake_stream_result(final_text="hi", exit_code=0, is_error=False, timed_out=False):
    from superclaw.claude_stream import ClaudeStreamResult

    return ClaudeStreamResult(final_text=final_text, output=final_text, exit_code=exit_code,
                              is_error=is_error, timed_out=timed_out)


def test_claude_native_turn_first_turn_uses_session_id_and_seed(tmp_path, monkeypatch):
    import superclaw.chat_turn as ct

    seen = {}

    def fake_stream(command, *, cwd, budget_seconds, cancel_check=None, on_event=None, **kw):
        seen["command"] = command
        return _fake_stream_result("native answer")

    monkeypatch.setattr("superclaw.claude_stream.run_claude_stream", fake_stream)
    monkeypatch.setattr("superclaw.backends.ClaudeCliBackend._resolve_executable", lambda self: "/usr/bin/claude")

    result = ct.execute_claude_native_chat_turn(
        content="你是谁", repo=tmp_path, budget_seconds=30, model="claude-opus-4-8",
        permission_mode="acceptEdits", native_session_id="uuid-A", is_resume=False,
        history_seed="User: 早些的话",
    )
    assert result["status"] == "completed" and result["response"] == "native answer"
    assert result["native_session_id"] == "uuid-A"
    cmd = seen["command"]
    # first turn: a NEW native session is created with our binding id
    assert "--session-id" in cmd and cmd[cmd.index("--session-id") + 1] == "uuid-A"
    assert "--resume" not in cmd
    assert "--output-format" in cmd and "stream-json" in cmd  # streaming contract
    assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"  # ask/allow passthrough
    assert cmd[cmd.index("--model") + 1] == "claude-opus-4-8"
    assert "早些的话" in cmd[-1]  # history seeded ONCE on first native turn


def test_claude_native_turn_resume_skips_seed(tmp_path, monkeypatch):
    import superclaw.chat_turn as ct

    seen = {}

    def fake_stream(command, *, cwd, budget_seconds, cancel_check=None, on_event=None, **kw):
        seen["command"] = command
        return _fake_stream_result("again")

    monkeypatch.setattr("superclaw.claude_stream.run_claude_stream", fake_stream)
    monkeypatch.setattr("superclaw.backends.ClaudeCliBackend._resolve_executable", lambda self: "/usr/bin/claude")

    result = ct.execute_claude_native_chat_turn(
        content="继续", repo=tmp_path, budget_seconds=30,
        native_session_id="uuid-A", is_resume=True, history_seed="MUST NOT APPEAR",
    )
    assert result["status"] == "completed"
    cmd = seen["command"]
    # resumed turn: native memory carries the context — no replay
    assert "--resume" in cmd and cmd[cmd.index("--resume") + 1] == "uuid-A"
    assert "--session-id" not in cmd
    assert "MUST NOT APPEAR" not in cmd[-1]
    assert cmd[-1] == "继续"  # the user's message reaches claude verbatim


def test_claude_native_turn_broken_resume_retires_session(tmp_path, monkeypatch):
    import superclaw.chat_turn as ct

    monkeypatch.setattr(
        "superclaw.claude_stream.run_claude_stream",
        lambda command, **kw: _fake_stream_result("No conversation found", exit_code=1, is_error=True),
    )
    monkeypatch.setattr("superclaw.backends.ClaudeCliBackend._resolve_executable", lambda self: "/usr/bin/claude")

    result = ct.execute_claude_native_chat_turn(
        content="hi", repo=tmp_path, budget_seconds=30,
        native_session_id="uuid-dead", is_resume=True,
    )
    assert result["status"] == "failed"
    assert result["retire_native_session"] is True  # do not pin a dead session


# --- cross-runtime handoff gap fixes (advisor-reviewed G1-G5 / B1-B3) --------


def test_message_id_persists_and_legacy_rows_load(tmp_path):
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("ids")
    store.append_chat_message(session.session_id, "user", "hello")
    loaded = store.get_chat_session(session.session_id)
    mid = loaded.messages[-1].message_id
    assert mid and mid.startswith("msg")
    # stable across loads (persisted, not regenerated)
    again = store.get_chat_session(session.session_id)
    assert again.messages[-1].message_id == mid


def test_native_binding_upgrades_legacy_string(tmp_path):
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("legacy")
    # simulate a pre-upgrade row: plain string binding
    session.metadata["native_sessions"] = {"claude": "old-uuid"}
    store.save_chat_session(session)

    binding = store.get_chat_native_session(session.session_id, "claude")
    assert binding == {"id": "old-uuid", "last_seen_message_id": None, "repo_path": None}
    # unknown last-seen -> full catch-up (safe degradation)
    from superclaw.chat_turn import unseen_messages_since

    msgs = store.get_chat_session(session.session_id).messages
    assert unseen_messages_since(msgs, binding["last_seen_message_id"]) == [m for m in msgs if m.role in ("user", "assistant")]


def test_catch_up_filters_plumbing_and_respects_watermark(tmp_path):
    # B2: system rows and run-dispatch placeholders never sync; G1: only turns
    # after the watermark sync.
    from superclaw.chat_turn import CATCH_UP_HEADER, build_catch_up_block
    from superclaw.models import ChatMessage

    seen = ChatMessage(role="user", content="第一轮")
    messages = [
        seen,
        ChatMessage(role="assistant", content="第一轮回答"),
        ChatMessage(role="system", content="runtime handoff: codex → claude"),
        ChatMessage(role="assistant", content="run_id=run_x status=completed chain_verdict=PASS"),
        ChatMessage(role="user", content="第二轮(在另一个 runtime)"),
        ChatMessage(role="assistant", content="第二轮回答"),
    ]
    block = build_catch_up_block(messages, seen.message_id)
    assert block.startswith(CATCH_UP_HEADER)
    assert "第二轮(在另一个 runtime)" in block and "第二轮回答" in block
    assert "第一轮回答" in block  # after the watermark
    assert "第一轮\n" not in block.replace(CATCH_UP_HEADER, "")  # watermark itself excluded
    assert "handoff" not in block  # system filtered
    assert "run_id=" not in block  # dispatch placeholder filtered
    # up-to-date runtime -> empty block
    assert build_catch_up_block(messages, messages[-1].message_id) == ""


def test_claude_native_resume_injects_catch_up(tmp_path, monkeypatch):
    import superclaw.chat_turn as ct

    seen = {}

    def fake_stream(command, *, cwd, budget_seconds, cancel_check=None, on_event=None, **kw):
        seen["command"] = command
        return _fake_stream_result("ok")

    monkeypatch.setattr("superclaw.claude_stream.run_claude_stream", fake_stream)
    monkeypatch.setattr("superclaw.backends.ClaudeCliBackend._resolve_executable", lambda self: "/usr/bin/claude")

    result = ct.execute_claude_native_chat_turn(
        content="继续", repo=tmp_path, budget_seconds=30,
        native_session_id="uuid-A", is_resume=True,
        catch_up=f"{ct.CATCH_UP_HEADER}\nUser: 我换过 runtime",
    )
    assert result["status"] == "completed"
    prompt = seen["command"][-1]
    assert ct.CATCH_UP_HEADER in prompt and "我换过 runtime" in prompt
    assert prompt.endswith("继续")


def test_resolve_effort_sticky_and_request_precedence():
    meta = {"runtime": {"backend": "codex", "model": "gpt-5.5", "effort": "high"}}
    # nothing requested → sticky effort applies
    s = resolve_chat_runtime(meta, default_backend="codex")
    assert s.effort == "high"
    # explicit request beats sticky
    s2 = resolve_chat_runtime(meta, requested_effort="xhigh", default_backend="codex")
    assert s2.effort == "xhigh"
    # REQUEST_CLEAR drops the sticky effort without a backend switch
    s3 = resolve_chat_runtime(meta, requested_effort=REQUEST_CLEAR, default_backend="codex")
    assert s3.effort is None


def test_backend_switch_drops_sticky_effort():
    # codex's "xhigh" is not claude's vocabulary the same way; effort levels are
    # runtime-specific, so a backend switch must never carry the sticky effort across.
    meta = {"runtime": {"backend": "codex", "effort": "xhigh"}}
    s = resolve_chat_runtime(meta, requested_backend="claude", default_backend="codex")
    assert s.backend == "claude"
    assert s.backend_switched is True
    assert s.effort is None
    # ...unless the same turn explicitly requests one for the new backend
    s2 = resolve_chat_runtime(meta, requested_backend="claude", requested_effort="max", default_backend="codex")
    assert s2.effort == "max"


def test_effort_persists_in_metadata_and_roundtrips(tmp_path):
    s = resolve_chat_runtime({}, requested_backend="codex", requested_effort="high", default_backend="codex")
    assert s.to_metadata() == {"backend": "codex", "effort": "high"}
    # sticky_chat_runtime reads it back as the third element
    assert sticky_chat_runtime({"runtime": s.to_metadata()}) == ("codex", None, "high")

    store = StateStore(str(tmp_path / "state.db"))
    chat = store.create_chat_session("eff")
    store.set_chat_runtime(chat.session_id, backend="codex", model="gpt-5.5", effort="xhigh")
    reloaded = store.get_chat_session(chat.session_id)
    assert reloaded.metadata["runtime"]["effort"] == "xhigh"
