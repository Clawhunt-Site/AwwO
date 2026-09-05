"""Self-contained streaming test app.

Serves a small web page (apps/streamtest/index.html) from the SAME origin as the
real SuperClaw API, so you can pick a backend (codex / claude / bobo), enter a
prompt, press Run, and watch tokens — plus commands and reasoning — stream in
live over SSE. No auth, no CORS, no separate frontend build.

Two modes:
  - Direct (default): one raw agent turn, streamed. Ask a question, get an
    answer. No task decomposition, no evidence/verification, no worker-prompt
    wrapping. codex runs read-only; claude runs with tools disabled.
  - Delivery: the full SuperClaw orchestration (decompose -> explore/plan/
    implement/verify/review). Use it when you actually want a delivery.

Run it::

    cd <this worktree>
    uv run --python 3.11 python apps/streamtest/serve.py
    # then open http://127.0.0.1:8077/streamtest
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
from pathlib import Path

# Make the repo root importable when run as a file.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import uvicorn  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from apps.api.main import create_app  # noqa: E402
from superclaw.environment import superclaw_data_path  # noqa: E402
from superclaw.models import GoalSpec, RunStatus  # noqa: E402

# Control token stays OFF here on purpose (local test harness).
os.environ.pop("SUPERCLAW_CONTROL_TOKEN", None)
# Allow any origin so the page works from a normal browser, an IDE preview
# panel, or a different port without CORS friction. Local test harness only.
os.environ.setdefault("SUPERCLAW_CORS_ORIGINS", "*")

_DB = os.environ.get("STREAMTEST_DB") or str(superclaw_data_path("streamtest-state.db"))
app = create_app(state_path=_DB)
_INDEX_HTML = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")

# Friendly UI names -> real backend ids. One "codex" maps to the streaming
# app-server backend; the legacy codex CLI is not exposed as a separate choice.
_BACKEND_ALIASES = {"codex": "codex-app-server"}


# Persistent direct-mode conversations: conversation_id -> live codex session.
# Keeping one CodexAppServerSession alive reuses its codex thread across turns,
# which is how the model remembers the conversation. Guarded by a per-conversation
# lock so two turns never interleave on the same thread.
_conversations: dict[str, dict] = {}
_conversations_guard = threading.Lock()


class StreamRunReq(BaseModel):
    backend: str = "codex"
    prompt: str
    repo_path: str = "/tmp"
    budget_seconds: int = 120
    deliver: bool = False  # False = direct single turn (chat), True = full delivery
    session_id: str | None = None  # direct-mode conversation id for multi-turn memory


class ResetReq(BaseModel):
    session_id: str | None = None


@app.get("/streamtest", response_class=HTMLResponse)
def streamtest_page() -> str:
    return _INDEX_HTML


@app.post("/streamtest/run")
def streamtest_run(req: StreamRunReq) -> dict[str, str]:
    store = app.state.store
    backend_id = _BACKEND_ALIASES.get(req.backend, req.backend)
    goal = store.create_goal(GoalSpec(title="streamtest", description=req.prompt))

    if req.deliver:
        session = app.state.orchestrator.start_existing_goal(
            goal,
            dry_run=False,
            backend_policy=backend_id,
            repo_path=req.repo_path,
            budget_seconds=req.budget_seconds,
            verification_policy="none",
        )
        return {"run_id": session.run_id, "mode": "delivery"}

    session = store.create_run(goal.goal_id, dry_run=False)
    threading.Thread(
        target=_direct_turn,
        args=(store, req.backend, goal, session, req.prompt, req.repo_path, req.budget_seconds, req.session_id),
        daemon=True,
    ).start()
    return {"run_id": session.run_id, "mode": "direct"}


@app.post("/streamtest/reset")
def streamtest_reset(req: ResetReq) -> dict[str, str]:
    """End a direct-mode conversation: close and forget its codex thread."""
    if not req.session_id:
        return {"status": "noop"}
    with _conversations_guard:
        conv = _conversations.pop(req.session_id, None)
    if conv and conv.get("codex_session") is not None:
        try:
            conv["codex_session"].close()
        except Exception:
            pass
    return {"status": "reset"}


def _direct_turn(store, backend_name, goal, session, prompt, repo_path, budget_seconds, conversation_id=None) -> None:
    """Run ONE raw agent turn, streaming events to the store (which rings the bus)."""
    run_id = session.run_id

    def sink(event_type: str, payload: dict) -> None:
        try:
            store.add_event(run_id, event_type, payload)
        except Exception:
            pass

    def set_status(status: str) -> None:
        session.status = status
        store.save_run(session)

    ok = False
    try:
        set_status(RunStatus.QUEUED.value)
        sink("run.queued", {"run_id": run_id})
        set_status(RunStatus.RUNNING.value)
        sink("run.started", {"run_id": run_id, "backend": backend_name, "mode": "direct", "session_id": conversation_id})
        if backend_name == "codex":
            ok = _codex_direct(conversation_id, prompt, repo_path, budget_seconds, sink)
        elif backend_name == "claude":
            ok = _claude_direct(prompt, repo_path, budget_seconds, sink)
        else:
            sink("message.completed", {"text": f"Direct mode supports codex and claude. For '{backend_name}', use Delivery mode."})
            ok = True
    except Exception as exc:  # pragma: no cover - surfaced to the UI
        sink("adapter.diagnostic", {"detail": f"{type(exc).__name__}: {exc}"})
        ok = False
    finally:
        try:
            set_status(RunStatus.VERIFYING.value)
            if ok:
                set_status(RunStatus.COMPLETED.value)
                sink("run.completed", {"status": "completed"})
            else:
                set_status(RunStatus.FAILED.value)
                sink("run.failed", {"status": "failed"})
        except Exception:
            pass


def _new_codex_session(repo_path):
    from superclaw.codex_app_server import (
        CodexAppServerClient,
        CodexAppServerSession,
        CodexApprovalDecision,
    )

    executable = os.environ.get("SUPERCLAW_CODEX_EXECUTABLE") or shutil.which("codex") or "codex"
    client = CodexAppServerClient(executable=executable, request_timeout=25.0)
    # read-only + never-approve: a safe chat/inspection turn that won't mutate.
    return CodexAppServerSession(
        cwd=Path(repo_path),
        client=client,
        sandbox="read-only",
        approval_policy="never",
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=40,
    )


def _get_conversation(conversation_id, repo_path):
    """Get-or-create the persistent codex session for a conversation.

    Reusing the session reuses its codex thread, which is what gives the model
    memory across turns. Returns (session, lock). When conversation_id is None we
    return a throwaway one-shot session (no memory).
    """
    if not conversation_id:
        return _new_codex_session(repo_path), threading.Lock(), True
    with _conversations_guard:
        conv = _conversations.get(conversation_id)
        if conv is None:
            conv = {"codex_session": _new_codex_session(repo_path), "lock": threading.Lock()}
            _conversations[conversation_id] = conv
        return conv["codex_session"], conv["lock"], False


def _drop_conversation(conversation_id) -> None:
    if not conversation_id:
        return
    with _conversations_guard:
        _conversations.pop(conversation_id, None)


def _codex_direct(conversation_id, prompt, repo_path, budget_seconds, sink) -> bool:
    from superclaw.codex_app_server import CodexAppServerError

    session, lock, throwaway = _get_conversation(conversation_id, repo_path)
    with lock:
        try:
            result = session.run_turn(prompt, budget_seconds=float(budget_seconds), on_event=sink)
            ok = not (result.error or result.cancelled or result.timed_out)
            # If the codex thread needs retiring (crash/stale), drop it so the next
            # turn in this conversation starts a fresh thread.
            if result.should_retire_session:
                try:
                    session.close()
                finally:
                    _drop_conversation(conversation_id)
            return ok
        except CodexAppServerError as exc:
            sink("adapter.diagnostic", {"detail": f"codex session error: {exc}"})
            try:
                session.close()
            finally:
                _drop_conversation(conversation_id)
            return False
        finally:
            if throwaway:
                try:
                    session.close()
                except Exception:
                    pass


def _claude_direct(prompt, repo_path, budget_seconds, sink) -> bool:
    from superclaw.claude_stream import run_claude_stream

    executable = os.environ.get("SUPERCLAW_CLAUDE_EXECUTABLE") or shutil.which("claude") or "claude"
    model = os.environ.get("SUPERCLAW_CLAUDE_MODEL", "claude-opus-4-8")
    command = [
        executable, "--print",
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", model, "--no-session-persistence", "--tools=",
        prompt,
    ]
    result = run_claude_stream(command, cwd=Path(repo_path), budget_seconds=float(budget_seconds), on_event=sink)
    return result.exit_code == 0 and not result.is_error


def main() -> None:
    host = os.environ.get("STREAMTEST_HOST", "127.0.0.1")
    port = int(os.environ.get("STREAMTEST_PORT", "8077"))
    print("=" * 64, flush=True)
    print("SuperClaw streaming test app", flush=True)
    print(f"  open:    http://{host}:{port}/streamtest", flush=True)
    print(f"  state:   {_DB}", flush=True)
    print("  auth:    disabled (no control token)", flush=True)
    print("=" * 64, flush=True)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
