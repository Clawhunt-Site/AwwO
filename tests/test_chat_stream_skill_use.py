"""P3: @skill USE on the codex-session path inlines a prose skill into the prompt.

A prose skill is model instructions; "using" it on a prompt-driven runtime means
injecting its body into the turn prompt (guaranteed activation for an explicit
@skill). Tool-skills keep the MCP-proxy path. conftest pins SUPERCLAW_HOME.
"""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.codex_app_server import CodexAppServerTurnResult
from superclaw.models import WorkspaceProfile
from superclaw.skill_author import register_skill_proposal
from superclaw.state import StateStore


def _trust_repo(tmp_path: Path) -> None:
    StateStore(tmp_path / "state.db").save_workspace_profile(
        WorkspaceProfile(name="test-repo", repo_path=str(tmp_path), trust_source="api")
    )


def _conv(prompts: list):
    class FakeCodexSession:
        thread_id = "thread-use"
        resumed = True

        def ensure_started(self):
            return None

        def run_turn(self, prompt, *, budget_seconds, cancel_check=None, on_event=None, effort=None):
            prompts.append(prompt)
            return CodexAppServerTurnResult(
                thread_id=self.thread_id, turn_id="t1", final_text="done", output="done"
            )

    return {"session": FakeCodexSession(), "lock": threading.Lock(), "turns": 0, "extra_args": []}


def test_codex_skill_use_inlines_prose_body(tmp_path, monkeypatch) -> None:
    # A governed prose skill exists in the store.
    register_skill_proposal(
        name="Diff Summarizer",
        description="Summarize a git diff.",
        body="UNIQUE-SKILL-BODY: group changes by intent.",
    )
    prompts: list = []
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *a, **k: _conv(prompts))

    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("use chat")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))

    resp = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "@skill:diff-summarizer summarize this",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "backend_policy": "codex",
        },
    )
    assert resp.status_code == 200
    # The prose skill body was inlined into the codex turn prompt (used, not just
    # described) — guaranteed activation for an explicit @skill.
    assert any("UNIQUE-SKILL-BODY" in p for p in prompts)
    assert any("Apply this SuperClaw skill now" in p for p in prompts)


def test_tool_skill_unavailable_when_mcp_not_projected(tmp_path) -> None:
    # B2: a tool-skill is only callable if its MCP proxy was projected this turn.
    # If projection did not happen, the prompt must NOT tell the model to call a
    # non-existent tool — it reports the skill unavailable.
    from apps.api.main import _skill_overlay_lines
    from superclaw.skill_build import build_and_install_skill_plugin

    src = tmp_path / "g"
    src.mkdir()
    (src / "SKILL.md").write_text("---\nname: greeter\ndescription: greet\n---\n\nGreet.\n", encoding="utf-8")
    build_and_install_skill_plugin(src / "SKILL.md")

    projected = "\n".join(_skill_overlay_lines(("greeter",), mcp_projected=True))
    assert "superclaw__call_tool" in projected

    not_projected = "\n".join(_skill_overlay_lines(("greeter",), mcp_projected=False))
    assert "superclaw__call_tool" not in not_projected
    assert "not available on this runtime" in not_projected
    assert "mcp_not_projected" in not_projected


def test_tool_skill_unavailable_when_not_in_projected_catalog(tmp_path, monkeypatch) -> None:
    # B2 (deeper): mcp_projected is True (some OTHER plugin made projection happen)
    # but the requested tool-skill's plugin id is NOT in the actually-projectable
    # catalog → must report mcp_not_projected, not instruct a call to a missing tool.
    from apps.api import main as api_main
    from superclaw.skill_build import build_and_install_skill_plugin

    src = tmp_path / "g"
    src.mkdir()
    (src / "SKILL.md").write_text("---\nname: greeter\ndescription: greet\n---\n\nGreet.\n", encoding="utf-8")
    build_and_install_skill_plugin(src / "SKILL.md")

    # available_plugins returns a DIFFERENT plugin (skill.greeter absent).
    class _FakeAvail:
        plugin_id = "other.plugin"
        tools = ("t",)

    monkeypatch.setattr(
        "superclaw.plugin_runtime_projection.available_plugins", lambda **kw: [_FakeAvail()]
    )
    lines = "\n".join(api_main._skill_overlay_lines(("greeter",), mcp_projected=True))
    assert "superclaw__call_tool" not in lines
    assert "mcp_not_projected" in lines


def test_prose_unreadable_branch_reports_unavailable(tmp_path, monkeypatch) -> None:
    # B1 (precise): a prose skill that planned cleanly but whose body reads empty
    # → PROSE_UNREADABLE in unavailable, never silently absent.
    from apps.api.main import _skill_overlay_lines

    register_skill_proposal(name="Readable", description="ok", body="real body")
    monkeypatch.setattr("superclaw.skill_runtime._read_prose_body", lambda record: "")
    lines = "\n".join(_skill_overlay_lines(("readable",), mcp_projected=False))
    assert "Apply this SuperClaw skill" not in lines
    assert "prose_skill_unreadable" in lines


def test_plugin_plus_skill_compose_includes_skill(tmp_path) -> None:
    # B4: a turn with BOTH @plugin and @skill must still apply the skill overlay
    # (an explicit @skill is never silently dropped on the plugin path).
    from apps.api.main import _plugin_task_prompt_envelope

    register_skill_proposal(name="Diff Summarizer", description="summarize", body="INLINE-BODY-XYZ")
    bundle = _plugin_task_prompt_envelope(
        "do it", active_plugin_id="pay-switch", skill_ids=("diff-summarizer",), mcp_projected=True
    )
    assert "INLINE-BODY-XYZ" in bundle.prompt  # skill body inlined alongside plugin
    assert "payment" in bundle.prompt.lower()  # plugin rules still present


def test_codex_skill_use_unknown_refuses_fail_closed(tmp_path, monkeypatch) -> None:
    prompts: list = []
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *a, **k: _conv(prompts))
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("use chat")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "@skill:ghost do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "backend_policy": "codex",
        },
    )
    assert resp.status_code == 200
    # Fail-closed: an unknown @skill REFUSES the turn up front (kernel pre-flight via
    # prepare_inline_skill_overlay), instead of running with a "not available" note
    # the model may ignore (the legacy fail-open behavior).
    assert "SKILL_UNAVAILABLE" in resp.text
    assert '"status": "failed"' in resp.text
    # The codex session is never driven — the turn is refused before any model call.
    assert prompts == []


def test_chat_turn_skill_only_routes_inline_with_skill_ids(tmp_path, monkeypatch) -> None:
    """/api/chat/turn: a skill-only @skill turn routes INLINE (with skill_ids threaded)
    rather than to the orchestrator that drops them — so the skill is actually applied."""
    register_skill_proposal(name="Diff Summarizer", description="summarize", body="INLINE-BODY")
    captured: dict = {}

    def _spy(**kwargs):
        captured["skill_ids"] = kwargs.get("skill_ids")
        return {"intent": "chat", "status": "completed", "response": "ok"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", _spy)
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("turn skill")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "session_id": session.session_id,
            "message": "@skill:diff-summarizer do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "direct_chat_backend": "codex",
        },
    )
    assert resp.status_code == 200, resp.text
    # Routed inline with the overlay threaded — NOT silently dropped to the orchestrator.
    assert captured.get("skill_ids") == ("diff-summarizer",)


def test_chat_turn_skill_only_unknown_fail_closed(tmp_path) -> None:
    """/api/chat/turn: an unknown @skill on the skill-only inline path fails closed
    (the kernel choke refuses before any model call) — never a silent no-op."""
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("turn skill")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "session_id": session.session_id,
            "message": "@skill:ghost do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "direct_chat_backend": "codex",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "failed"
    assert "skill_overlay_unavailable" in (body.get("failure_reason") or "")


def test_legacy_chat_endpoint_refuses_skill_overlay(tmp_path) -> None:
    """The legacy /api/chat (delivery wrapper) has no @skill handling, so it must
    REFUSE an @skill message rather than silently run it without the skill."""
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("legacy")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat",
        json={
            "session_id": session.session_id,
            "message": "@skill:ghost do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "failed"
    assert "SKILL_OVERLAY_UNSUPPORTED" in (body.get("failure_reason") or "")


def test_chat_turn_tool_skill_fail_closed_prose_only(tmp_path) -> None:
    """/api/chat/turn runs a skill-only turn INLINE (codex direct path = prose-only),
    so a TOOL-skill is fail-closed there (no MCP projection on that path) — never a
    silent no-op. (The streaming path keeps the MCP tool route.)"""
    from superclaw.skill_build import build_and_install_skill_plugin

    src = tmp_path / "greeter-src"
    src.mkdir()
    (src / "SKILL.md").write_text("---\nname: greeter\ndescription: greet\n---\n\nGreet.\n", encoding="utf-8")
    build_and_install_skill_plugin(src / "SKILL.md")

    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("turn tool skill")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "session_id": session.session_id,
            "message": "@skill:skill.greeter do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "direct_chat_backend": "codex",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "failed"
    assert "skill_overlay_unavailable" in (body.get("failure_reason") or "")


def test_stream_forced_chat_mode_with_skill_refuses(tmp_path) -> None:
    """Forced mode=chat + @skill is contradictory (forced chat ignores overlays), so
    the stream REFUSES rather than silently running without the skill."""
    register_skill_proposal(name="Diff Summarizer", description="summarize", body="BODY")
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("forced")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "@skill:diff-summarizer do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "backend_policy": "codex",
            "mode": "chat",
        },
    )
    assert resp.status_code == 200
    assert "SKILL_OVERLAY_UNSUPPORTED" in resp.text
    assert '"status": "failed"' in resp.text


def test_turn_forced_delivery_mode_with_skill_refuses(tmp_path) -> None:
    """Forced mode=delivery + @skill: the delivery path applies no overlay, so the
    turn endpoint refuses instead of silently dropping the (valid) skill."""
    register_skill_proposal(name="Diff Summarizer", description="summarize", body="BODY")
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("forced")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "session_id": session.session_id,
            "message": "@skill:diff-summarizer do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "direct_chat_backend": "codex",
            "mode": "delivery",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "failed"
    assert "SKILL_OVERLAY_UNSUPPORTED" in (body.get("failure_reason") or "")


def test_turn_plugin_plus_skill_refuses_fail_closed(tmp_path) -> None:
    """/api/chat/turn cannot compose @plugin+@skill (it applies @skill only as a
    standalone overlay), so such a turn is refused fail-closed rather than dropping
    the skill on the orchestrator path. (@plugin+@skill composition is a stream cap.)"""
    register_skill_proposal(name="Diff Summarizer", description="summarize", body="BODY")
    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("plugin+skill")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "session_id": session.session_id,
            "message": "@plugin:pay-switch @skill:diff-summarizer do x",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "direct_chat_backend": "codex",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "failed"
    assert "SKILL_OVERLAY_UNSUPPORTED" in (body.get("failure_reason") or "")
