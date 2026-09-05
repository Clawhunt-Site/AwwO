from __future__ import annotations

from pathlib import Path

from superclaw.codex_app_server import CodexAppServerError, CodexAppServerSession, CodexApprovalDecision


class FakeResumeClient:
    """Minimal codex app-server client exercising ensure_started()'s resume path."""

    def __init__(self, *, resume_ok: bool) -> None:
        self.resume_ok = resume_ok
        self.requests: list[tuple[str, dict]] = []
        self.initialized = 0
        self._alive = True

    def initialize(self) -> dict:
        self.initialized += 1
        return {"userAgent": "fake"}

    def request(self, method: str, params: dict | None = None, *, timeout: float | None = None):
        del timeout
        self.requests.append((method, params or {}))
        if method == "thread/resume":
            if not self.resume_ok:
                raise CodexAppServerError("rollout not found")
            return {"thread": {"id": "thread-resumed"}}
        if method == "thread/start":
            return {"thread": {"id": "thread-fresh"}}
        raise AssertionError(f"unexpected method: {method}")

    def is_alive(self) -> bool:
        return self._alive


def _session(client, **kw) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd=Path("/tmp"),
        client=client,
        approval_decision=CodexApprovalDecision(),
        sandbox="read-only",
        approval_policy="never",
        **kw,
    )


def test_resume_success_restores_native_thread():
    client = FakeResumeClient(resume_ok=True)
    session = _session(client, resume_thread_id="thread-old", ephemeral=False)
    session.ensure_started()
    assert session.thread_id == "thread-resumed"
    assert session.resumed is True
    assert session.resume_failed is False
    methods = [m for m, _ in client.requests]
    assert methods == ["thread/resume"]  # no fresh start needed
    # resume params carry the chat sandbox/policy and target thread id
    _, params = client.requests[0]
    assert params["threadId"] == "thread-old"
    assert params["sandbox"] == "read-only"


def test_resume_failure_falls_back_to_fresh_start():
    client = FakeResumeClient(resume_ok=False)
    session = _session(client, resume_thread_id="thread-old", ephemeral=False)
    session.ensure_started()
    assert session.thread_id == "thread-fresh"
    assert session.resumed is False
    assert session.resume_failed is True
    methods = [m for m, _ in client.requests]
    assert methods == ["thread/resume", "thread/start"]
    # fresh start persists a rollout (ephemeral False) so it can be resumed later
    _, start_params = client.requests[1]
    assert start_params["ephemeral"] is False


def test_fresh_session_without_resume_id_starts_persistent_thread():
    client = FakeResumeClient(resume_ok=True)
    session = _session(client, ephemeral=False)
    session.ensure_started()
    assert session.thread_id == "thread-fresh"
    assert session.resumed is False
    assert session.resume_failed is False
    methods = [m for m, _ in client.requests]
    assert methods == ["thread/start"]


def test_ephemeral_default_preserved_for_worker_sessions():
    client = FakeResumeClient(resume_ok=True)
    session = _session(client)  # defaults: ephemeral True, no resume id
    session.ensure_started()
    _, start_params = client.requests[0]
    assert start_params["ephemeral"] is True
