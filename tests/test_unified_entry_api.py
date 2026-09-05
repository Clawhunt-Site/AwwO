from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import WorkspaceProfile
from superclaw.state import StateStore


def _client(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    # These tests drive chat turns with repo_path="." (the test cwd); register
    # it as a trusted workspace so they exercise runtime resolution, not the
    # trust gate (ADR: docs/workspace-trust-container.md).
    StateStore(tmp_path / "state.db").save_workspace_profile(
        WorkspaceProfile(name="cwd", repo_path=".", trust_source="api")
    )
    return TestClient(app)


def _stream(client, **payload):
    body = {"message": "hello", "repo_path": ".", **payload}
    return client.post("/api/chat/stream", json=body).text


# --- runtime_id resolution + capability negotiation (fail-closed) -----------


def test_unknown_runtime_id_fails_closed(tmp_path):
    text = _stream(_client(tmp_path), runtime_id="does-not-exist")
    assert "event: chat.completed" in text
    assert "unknown runtime_id" in text


def test_overlay_on_non_mcp_runtime_fails_closed(tmp_path):
    # @plugin overlay on claude-cli (no MCP tool bridge in this entry) must fail
    # closed with RUNTIME_CAPABILITY_UNSUPPORTED, not silently run.
    text = _stream(_client(tmp_path), message="@plugin:pay-switch go", runtime_id="claude-cli")
    assert "RUNTIME_CAPABILITY_UNSUPPORTED" in text


def test_non_codex_runtime_executes_natively(tmp_path, monkeypatch):
    # Unified chat entry: a plain chat turn on claude-cli executes over claude's
    # NATIVE session channel (PR-B) — no fail-closed refusal, no silent codex
    # fallback, and the adapter alias normalizes onto the backend name.
    import superclaw.chat_turn as chat_turn_mod

    seen = {}

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        seen["native_session_id"] = native_session_id
        seen["is_resume"] = is_resume
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "native hi", "native_session_id": native_session_id}

    monkeypatch.setattr(chat_turn_mod, "execute_claude_native_chat_turn", fake_native)
    text = _stream(_client(tmp_path), message="hi", runtime_id="claude-cli")
    assert "native hi" in text
    assert seen.get("is_resume") is False  # first turn creates the native binding
    assert "RUNTIME_CAPABILITY_UNSUPPORTED" not in text


def test_pure_chat_no_repo_path_executes_in_chat_scratch(tmp_path, monkeypatch):
    # A chat turn with NO repo_path (pure chat) resolves to the managed Chat
    # workspace and EXECUTES in its scratch home, never the server cwd. (PR-B
    # parity: the CLI `chat` command and the Web composer both omit repo_path for
    # pure chats; the kernel fills it from the resolved workspace. No trusted cwd
    # workspace is registered here, proving a pure chat needs none.)
    import superclaw.chat_turn as chat_turn_mod

    chat_root = tmp_path / "chat-scratch"
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(chat_root))
    seen = {}

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        seen["repo"] = repo
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "native hi", "native_session_id": native_session_id}

    monkeypatch.setattr(chat_turn_mod, "execute_claude_native_chat_turn", fake_native)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    # repo_path omitted entirely → pure chat
    text = client.post("/api/chat/stream", json={"message": "hi", "runtime_id": "claude-cli"}).text
    assert "native hi" in text
    # executed in the managed Chat scratch home, not the server cwd
    assert Path(seen["repo"]).resolve() == chat_root.resolve()


def test_continue_project_session_with_no_repo_path_executes_in_its_project(tmp_path, monkeypatch):
    # Continuing a PROJECT session with NO repo_path (and no workspace_id) must
    # execute in that session's own project, NOT the default Chat scratch — the
    # execution boundary follows the session's binding (parity with the CLI fix).
    import superclaw.chat_turn as chat_turn_mod
    from superclaw import workspace_resolver as wr

    project = tmp_path / "proj"
    project.mkdir()
    (project / "package.json").write_text("{}")  # project marker (trust gate)
    store = StateStore(tmp_path / "state.db")
    workspace = wr.create_trusted_workspace(store, project, trust_source="test")
    session = store.create_chat_session("Proj chat", workspace_id=workspace.workspace_id)
    seen = {}

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        seen["repo"] = repo
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "native hi", "native_session_id": native_session_id}

    monkeypatch.setattr(chat_turn_mod, "execute_claude_native_chat_turn", fake_native)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    # session_id given, repo_path omitted, NO workspace_id → follows the binding
    text = client.post(
        "/api/chat/stream",
        json={"message": "hi", "runtime_id": "claude-cli", "session_id": session.session_id},
    ).text
    assert "native hi" in text
    assert Path(seen["repo"]).resolve() == project.resolve()


def test_default_runtime_delegates_to_codex(tmp_path):
    # No runtime_id -> codex-app-server. The turn must pass runtime resolution and
    # reach the codex path (it then either replies, or fails with "codex executable
    # not found" if no binary) — never a runtime-capability/unknown-runtime error.
    text = _stream(_client(tmp_path), message="hi")
    assert "event: chat.started" in text
    assert "RUNTIME_CAPABILITY_UNSUPPORTED" not in text
    assert "unknown runtime_id" not in text


# --- delivery is a deprecated legacy branch ---------------------------------


def test_delivery_emits_deprecation_event(tmp_path):
    text = _stream(_client(tmp_path), message="ship it", mode="delivery", backend_policy="local")
    assert "event: delivery.deprecated" in text
    assert "agent_company" in text


# --- @skill is an additive overlay routed as a task ------------------------


def test_skill_marker_routes_as_overlay_task(tmp_path):
    # @skill is classified as an overlay task by the KERNEL router (so CLI and
    # API agree by construction); the API resolver passes it through without
    # setting a sticky plugin.
    from apps.api.main import _resolve_chat_effective_intent
    from superclaw.chat_turn import classify_intent
    from superclaw.state import StateStore

    message = "@skill:formatter tidy this"
    base_intent = classify_intent(message, mode="auto")
    assert base_intent == "task"  # kernel-level: identical on every surface

    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("t")
    intent, active_plugin_id, sticky = _resolve_chat_effective_intent(
        store, session_id=session.session_id, message=message,
        mode="auto", base_intent=base_intent,
    )
    assert intent == "task"
    assert active_plugin_id is None  # skills don't set a sticky plugin
    assert sticky is False


def test_skill_turn_uses_skill_prompt_not_plugin_prompt():
    # Codex review constraint: "task" means overlay turn, NOT plugin turn — the
    # plugin-specific prompt (payment mapping etc.) must never be applied to a
    # skill-only turn.
    from apps.api.main import _plugin_task_prompt, _skill_task_prompt

    skill_prompt = _skill_task_prompt("tidy this", skill_ids=("formatter",))
    assert "skill(s): formatter" in skill_prompt
    # P3: @skill is resolved through the kernel. 'formatter' is not installed here,
    # so it is reported as unavailable rather than implying a tool that exists.
    # (A resolvable tool-skill would carry the superclaw__call_tool path; a prose
    # skill would carry its body inline.)
    assert "not available on this runtime" in skill_prompt
    assert "payment" not in skill_prompt.lower()  # no plugin-specific payment rules

    plugin_prompt = _plugin_task_prompt("buy it", active_plugin_id="pay-switch")
    assert "payment" in plugin_prompt.lower()  # plugin prompt keeps its rules


def test_overlay_prompt_notice_preserves_tool_contract_and_history():
    from apps.api.main import _plugin_task_prompt_envelope
    from superclaw.prompt_contracts import PromptLayerKind

    bundle = _plugin_task_prompt_envelope(
        "System:\nmake me governance",
        active_plugin_id="pay-switch",
        history_text="User: continue the sticky task",
        context_text="file.py: selected context",
        runtime_notice="[SuperClaw capability notice]\ntool changed",
    )

    assert bundle.envelope.kinds() == (
        PromptLayerKind.RUNTIME_ADAPTER,
        PromptLayerKind.TOOL_CONTRACT,
        PromptLayerKind.TASK_CONTEXT,
        PromptLayerKind.USER_TURN,
    )
    assert bundle.prompt.startswith("[SuperClaw capability notice]")
    assert "Pay-Switch submit_intent" in bundle.envelope.get(PromptLayerKind.TOOL_CONTRACT).content
    assert "continue the sticky task" in bundle.envelope.get(PromptLayerKind.TASK_CONTEXT).content
    assert bundle.envelope.get(PromptLayerKind.USER_TURN).content.startswith("System:\n")


def test_direct_endpoint_routes_through_runtime_and_is_deprecated(tmp_path, monkeypatch):
    # Hermetic: stub the kernel one-shot channel the endpoint delegates to, so we
    # assert the endpoint routes through it AND flags itself deprecated. The
    # endpoint is runtime-pluggable (any registered backend), not codex-locked.
    import superclaw.chat_turn as chat_turn_mod

    seen = {}

    def fake_turn(**kwargs):
        seen.update(kwargs)
        return {"intent": "chat", "backend": kwargs.get("backend"), "status": "completed", "response": "x"}

    monkeypatch.setattr(chat_turn_mod, "execute_direct_chat_turn", fake_turn)
    resp = _client(tmp_path).post(
        "/api/chat/direct", json={"message": "hi", "repo_path": "."}
    ).json()
    assert resp.get("response") == "x"
    assert resp.get("backend") == "codex"  # default backend_policy
    assert resp.get("deprecated") is True
    assert resp.get("replacement") == "/api/chat/stream"


def test_direct_endpoint_unknown_backend_fails_closed(tmp_path):
    resp = _client(tmp_path).post(
        "/api/chat/direct", json={"message": "hi", "repo_path": ".", "backend_policy": "no-such-runtime"}
    ).json()
    assert resp.get("status") == "failed"
    assert "unknown backend" in (resp.get("failure_reason") or "")
    assert resp.get("deprecated") is True


def test_native_turn_persists_sanitized_usage_and_elapsed(tmp_path, monkeypatch):
    # The assistant message persists ONLY finite, non-negative token counts: a
    # malformed runtime usage (nan/inf/negative/bool) must NEITHER crash the turn
    # (int(nan) raises / int(inf) overflows) NOR land bad numbers in the metering
    # row that survives a reload. elapsed_ms is recorded from the turn timer.
    import math

    import superclaw.chat_turn as chat_turn_mod

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        return {
            "intent": "chat", "backend": "claude", "status": "completed",
            "response": "native hi", "native_session_id": native_session_id,
            "usage": {
                "input_tokens": 4391,
                "output_tokens": float("nan"),
                "cache_read_input_tokens": -7,
                "cache_creation_input_tokens": True,  # bool is not a token count
                "reasoning_tokens": float("inf"),
            },
        }

    monkeypatch.setattr(chat_turn_mod, "execute_claude_native_chat_turn", fake_native)
    client = _client(tmp_path)
    text = _stream(client, message="hi", runtime_id="claude-cli")
    # The turn completed instead of 500-ing / landing a failed assistant.
    assert "native hi" in text
    assert '"status": "completed"' in text
    # The LIVE chat.completed event carries the SAME server metering that gets
    # persisted, so the web's hover meta row shows token usage + 用时 the instant
    # the turn ends — no reload needed, and live == persisted (zero jump). The
    # streamed usage is the sanitized tally (nan/inf/negative/bool dropped).
    assert '"elapsed_ms"' in text
    assert '"input_tokens": 4391' in text
    assert '"output_tokens"' not in text  # the nan field was dropped, not streamed

    store = StateStore(tmp_path / "state.db")
    session = store.list_chat_sessions(include_archived=True)[0]
    reloaded = store.get_chat_session(session.session_id)
    assistant = next(m for m in reloaded.messages if m.role == "assistant")
    # Only the finite, non-negative field survives; nan/inf/negative/bool dropped.
    assert assistant.usage == {"input_tokens": 4391}
    # elapsed_ms recorded (a real, non-negative duration).
    assert isinstance(assistant.elapsed_ms, (int, float)) and assistant.elapsed_ms >= 0
    assert math.isfinite(assistant.elapsed_ms)


def _sse_events(text):
    """Parse an SSE response into a list of (event, json-payload) tuples."""
    import json

    out = []
    event = None
    for line in text.splitlines():
        if line.startswith("event: "):
            event = line[len("event: ") :]
        elif line.startswith("data: ") and event is not None:
            out.append((event, json.loads(line[len("data: ") :])))
            event = None
    return out


def test_pure_chat_turn_emits_no_run_handle(tmp_path, monkeypatch):
    # Contract regression (the "successful chat shows as failed" bug): a PURE chat
    # turn has no run resource, so every SSE frame it emits carries run_id=None — it
    # must NEVER leak the internal cost-ledger id. A client that polls /api/runs/<id>
    # on a leaked id gets 404 and renders a successful chat as a failed run.
    import superclaw.chat_turn as chat_turn_mod

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "native hi", "native_session_id": native_session_id}

    monkeypatch.setattr(chat_turn_mod, "execute_claude_native_chat_turn", fake_native)
    client = _client(tmp_path)
    text = _stream(client, message="hi", runtime_id="claude-cli")

    events = _sse_events(text)
    completed = [payload for name, payload in events if name == "chat.completed"]
    assert completed and completed[-1]["status"] == "completed"
    # Every emitted frame is runless: run_id is explicitly None, not the synthetic id.
    for name, payload in events:
        if "run_id" in payload:
            assert payload["run_id"] is None, f"{name} leaked a run handle: {payload['run_id']!r}"

    # And the persisted assistant message is likewise runless, so reopening the
    # session never triggers a run poll either.
    store = StateStore(tmp_path / "state.db")
    session = store.list_chat_sessions(include_archived=True)[0]
    assistant = next(m for m in store.get_chat_session(session.session_id).messages if m.role == "assistant")
    assert assistant.run_id is None
