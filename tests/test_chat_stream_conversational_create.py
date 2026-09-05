"""A3b: conversational skill creation on the codex-session streaming path.

Mirrors the test_api chat_stream harness: a fake codex session returns a skill
proposal block; on a create-intent message the handler injects the directive,
harvests the proposal, and registers a governed cross-runtime skill. conftest
pins SUPERCLAW_HOME so the store is isolated.
"""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.codex_app_server import CodexAppServerTurnResult
from superclaw.models import WorkspaceProfile
from superclaw.skill_author import PROPOSAL_CLOSE, PROPOSAL_OPEN, SKILL_CREATION_DIRECTIVE
from superclaw.state import StateStore
from superclaw.skill_store import list_skills


def _trust_repo(tmp_path: Path) -> None:
    StateStore(tmp_path / "state.db").save_workspace_profile(
        WorkspaceProfile(name="test-repo", repo_path=str(tmp_path), trust_source="api")
    )


def _proposal(name: str, description: str, body: str) -> str:
    return f"{PROPOSAL_OPEN}\nname: {name}\ndescription: {description}\n---\n{body}\n{PROPOSAL_CLOSE}"


def _make_session(prompts: list, reply: str):
    class FakeCodexSession:
        thread_id = "thread-demo"
        resumed = True

        def ensure_started(self):
            return None

        def run_turn(self, prompt, *, budget_seconds, cancel_check=None, on_event=None, effort=None):
            prompts.append(prompt)
            # Stream the reply as a live delta (as the real codex adapter does)
            # BEFORE returning — so the test exercises the real ordering where the
            # raw block is streamed live and only the persisted/completion text is
            # sanitized afterwards.
            if on_event is not None:
                on_event("message.delta", {"text": reply, "streamed_chars": len(reply)})
            return CodexAppServerTurnResult(
                thread_id=self.thread_id, turn_id="t1", final_text=reply, output=reply
            )

    return {"session": FakeCodexSession(), "lock": threading.Lock(), "turns": 0, "extra_args": []}


def _last_assistant(state_path: Path, session_id: str) -> str:
    session = StateStore(state_path).get_chat_session(session_id)
    assistant = [m for m in session.messages if m.role == "assistant"]
    return assistant[-1].content if assistant else ""


def test_codex_chat_conversational_create(tmp_path, monkeypatch) -> None:
    prompts: list = []
    reply = "Here's your skill:\n\n" + _proposal(
        "Diff Summarizer", "Summarize a git diff into a changelog.", "Group changes by intent."
    )
    conv = _make_session(prompts, reply)
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *a, **k: conv)

    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("create chat")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))

    resp = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "create a skill that summarizes diffs",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "backend_policy": "codex",
        },
    )
    assert resp.status_code == 200
    # Directive injected into the codex prompt on a create-intent turn.
    assert any(SKILL_CREATION_DIRECTIVE in p for p in prompts)
    # Skill registered, governed + cross-runtime.
    assert "diff-summarizer" in [s.slug for s in list_skills()]
    # The DURABLE record (persisted assistant message) is sanitized: raw block
    # stripped, confirmation appended. (Live deltas may still carry the raw block;
    # A5 hides it on the completion event — not asserted on resp.text here.)
    persisted = _last_assistant(state_path, session.session_id)
    assert PROPOSAL_OPEN not in persisted
    assert "Registered SuperClaw skill" in persisted
    # Honest lifecycle: registered != active; the receipt points to the sync step
    # and never repeats the overstated "usable across runtimes" claim.
    assert "Not active in any runtime yet" in persisted
    assert "usable across runtimes" not in persisted
    # Prove the test exercises the real ordering: the raw block WAS streamed live
    # (via message.delta) — so the persisted-message cleanliness above is a real
    # guarantee, not a false negative from a fake that never streamed.
    assert PROPOSAL_OPEN in resp.text


def test_codex_chat_directive_disabled_does_not_register(tmp_path, monkeypatch) -> None:
    # The ONLY gate is the env flag (intent itself is the LLM's job). With the
    # feature disabled, the directive is not injected and an emitted block is not
    # harvested — even though the model returned one.
    monkeypatch.setenv("SUPERCLAW_SKILL_CREATE", "0")
    prompts: list = []
    reply = _proposal("Sneaked", "planted", "do stuff")
    conv = _make_session(prompts, reply)
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *a, **k: conv)

    state_path = tmp_path / "state.db"
    session = StateStore(state_path).create_chat_session("plain chat")
    _trust_repo(tmp_path)
    client = TestClient(create_app(state_path=state_path))

    resp = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "make me a tidy skill",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "backend_policy": "codex",
        },
    )
    assert resp.status_code == 200
    assert list_skills() == []
    assert all(SKILL_CREATION_DIRECTIVE not in p for p in prompts)
