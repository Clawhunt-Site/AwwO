import json
import time
from pathlib import Path

from superclaw.backends import CodexAppServerBackend, default_backends, WorkerLimits
from superclaw.codex_app_server import (
    CodexAppServerSession,
    CodexAppServerTurnResult,
    CodexApprovalDecision,
)
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole
from superclaw.runtime import PermissionPolicy


class FakeCodexClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.responses: list[tuple[int | str, dict]] = []
        self.errors: list[tuple[int | str, str]] = []
        self.notifications: list[dict] = []
        self.server_requests: list[dict] = []
        self.thread_start_response: dict = {"thread": {"id": "thread-1"}}
        # None → thread/resume is unsupported (raises, mirroring a missing rollout
        # so ensure_started falls back to thread/start). Set to a dict to simulate
        # a successful reattach carrying the thread's resolved reasoningEffort.
        self.thread_resume_response: dict | None = None
        self.closed = False

    def initialize(self) -> dict:
        return {"codexHome": "/tmp/codex", "userAgent": "fake"}

    def request(self, method: str, params: dict | None = None, *, timeout: float | None = None):
        del timeout
        self.requests.append((method, params or {}))
        if method == "thread/start":
            return self.thread_start_response
        if method == "thread/resume":
            if self.thread_resume_response is None:
                raise AssertionError("no rollout to resume")
            return self.thread_resume_response
        if method == "turn/start":
            return {"turn": {"id": "turn-1", "status": "running", "items": []}}
        if method == "turn/interrupt":
            return {}
        raise AssertionError(f"unexpected method: {method}")

    def respond(self, request_id: int | str, result: dict) -> None:
        self.responses.append((request_id, result))

    def respond_error(self, request_id: int | str, message: str, *, code: int = -32603) -> None:
        del code
        self.errors.append((request_id, message))

    def take_notification(self, timeout: float = 0.0):
        del timeout
        if self.notifications:
            return self.notifications.pop(0)
        return None

    def take_server_request(self, timeout: float = 0.0):
        del timeout
        if self.server_requests:
            return self.server_requests.pop(0)
        return None

    def is_alive(self) -> bool:
        return not self.closed

    def stderr_tail(self) -> str:
        return ""

    def close(self) -> None:
        self.closed = True


def _task(role: WorkerRole = WorkerRole.IMPLEMENT) -> TaskNode:
    return TaskNode(task_id="task_1", role=role, title=f"{role.value} task")


def test_codex_app_server_session_reuses_thread_and_projects_turn_events(tmp_path):
    client = FakeCodexClient()
    client.notifications = [
        {"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}},
        {"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "msg", "delta": "done"}},
        {
            "method": "item/commandExecution/outputDelta",
            "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "cmd", "delta": "pytest ok"},
        },
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("ship it", budget_seconds=5)

    assert result.thread_id == "thread-1"
    assert result.turn_id == "turn-1"
    assert result.final_text == "done"
    assert "pytest ok" in result.output
    assert [method for method, _params in client.requests].count("thread/start") == 1
    assert client.requests[-1][0] == "turn/start"


def test_codex_app_server_session_accepts_session_id_thread_response_and_completed_items(tmp_path):
    client = FakeCodexClient()
    client.thread_start_response = {"sessionId": "session-thread-1"}
    client.notifications = [
        {
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "aggregatedOutput": "pytest ok",
                    "exitCode": 0,
                }
            },
        },
        {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg", "text": "done"}}},
        {"method": "turn/completed", "params": {"threadId": "session-thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("ship it", budget_seconds=5)

    assert result.thread_id == "session-thread-1"
    assert result.final_text == "done"
    assert result.command_output == "pytest ok"
    assert result.tool_iterations == 1


def test_run_turn_streams_events_to_on_event_sink(tmp_path):
    client = FakeCodexClient()
    client.notifications = [
        {"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}},
        {"method": "item/agentMessage/delta", "params": {"delta": "Hello "}},
        {"method": "item/agentMessage/delta", "params": {"delta": "world"}},
        {
            "method": "item/completed",
            "params": {"item": {"type": "commandExecution", "id": "cmd", "aggregatedOutput": "ok", "exitCode": 0}},
        },
        {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg", "text": "Hello world"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    events: list[tuple[str, dict]] = []
    result = runtime_session.run_turn(
        "ship it", budget_seconds=5, on_event=lambda etype, payload: events.append((etype, payload))
    )

    types = [etype for etype, _payload in events]
    assert "message.delta" in types
    assert "message.completed" in types
    assert "tool.completed" in types

    # Coalesced deltas reconstruct the streamed text. The text stream keeps its
    # bare wire shape (Display Protocol PR-2): message.delta/completed are NOT
    # wrapped in the canonical envelope, so existing surfaces render unchanged.
    delta_text = "".join(payload["text"] for etype, payload in events if etype == "message.delta")
    assert delta_text == "Hello world"
    completed = [payload for etype, payload in events if etype == "message.completed"]
    assert completed[0]["text"] == "Hello world"

    # Tool events ARE canonical DisplayEvents: the payload is the ToolCall domain
    # model (kind/status/output/call_id), not the old flat {tool, output} shape.
    tool_events = [payload for etype, payload in events if etype == "tool.completed"]
    envelope = tool_events[0]
    assert envelope["schema_version"] == 1
    assert envelope["runtime_id"] == "codex-app-server"
    assert envelope["capability_tier"] == "full"
    tc = envelope["payload"]
    assert tc["kind"] == "command"
    assert tc["status"] == "ok"
    assert tc["output"] == "ok"
    assert tc["call_id"] == "cmd"
    assert tc["call_id_source"] == "runtime"
    assert result.final_text == "Hello world"


def test_projection_ids_are_session_monotonic_across_turns(tmp_path):
    # Regression (Display Protocol PR-2): the projection state is held on the
    # SESSION, not recreated per turn, so synthetic event ids stay session-local-
    # monotonic and a second turn on the same codex thread never collides with the
    # first (which would make a session-wide reducer merge unrelated tool cards).
    client = FakeCodexClient()
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    def _turn_notifs():
        return [
            {"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c", "command": "ls"}}},
            {"method": "item/completed", "params": {"item": {"type": "commandExecution", "id": "c", "aggregatedOutput": "ok", "exitCode": 0}}},
            {"method": "turn/completed", "params": {"turn": {"id": "t", "status": "completed"}}},
        ]

    events1: list[tuple[str, dict]] = []
    client.notifications = _turn_notifs()
    runtime_session.run_turn("one", budget_seconds=5, on_event=lambda t, p: events1.append((t, p)))
    events2: list[tuple[str, dict]] = []
    client.notifications = _turn_notifs()
    runtime_session.run_turn("two", budget_seconds=5, on_event=lambda t, p: events2.append((t, p)))

    ids1 = [p["id"] for t, p in events1 if t.startswith("tool.")]
    ids2 = [p["id"] for t, p in events2 if t.startswith("tool.")]
    assert ids1 and ids2
    # Turn 2's ids continue past turn 1's — no reset, no collision.
    assert max(ids1) < min(ids2)


def test_remote_cancelled_turn_repairs_open_tool_as_cancelled_not_error(tmp_path):
    # Regression (Display Protocol PR-2, Codex #2): codex reports turn/completed
    # status=cancelled with a tool still open. Terminal repair must mark it
    # cancelled, NOT a phantom error — without changing the turn result's
    # `cancelled` semantics (a remote cancel is not a SuperClaw-initiated cancel).
    client = FakeCodexClient()
    client.notifications = [
        {"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c", "command": "sleep 999"}}},
        {"method": "turn/completed", "params": {"turn": {"id": "t", "status": "cancelled"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )
    events: list[tuple[str, dict]] = []
    result = runtime_session.run_turn("go", budget_seconds=5, on_event=lambda t, p: events.append((t, p)))

    assert result.cancelled is False  # remote cancel != SuperClaw cancel
    tool_completed = [p for t, p in events if t == "tool.completed"]
    assert tool_completed and tool_completed[0]["payload"]["status"] == "cancelled"


def test_run_turn_without_sink_behaves_as_before(tmp_path):
    client = FakeCodexClient()
    client.notifications = [
        {"method": "item/agentMessage/delta", "params": {"delta": "done"}},
        {"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("ship it", budget_seconds=5)  # no on_event
    assert result.final_text == "done"


def test_codex_app_server_session_treats_turn_aborted_marker_as_terminal(tmp_path):
    client = FakeCodexClient()
    client.notifications = [
        {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg", "text": "<turn_aborted>"}}},
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("abort", budget_seconds=5)

    assert result.error == "codex reported turn_aborted"
    assert result.interrupted is True
    assert result.should_retire_session is True


def test_codex_app_server_session_bridges_command_approval(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [
        {
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "cmd", "startedAtMs": 1, "command": "touch ok"},
        }
    ]
    client.notifications = [
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}}
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(accept_command=True),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("needs approval", budget_seconds=5)

    assert result.approval_events == [{"method": "item/commandExecution/requestApproval", "decision": "accept"}]
    assert client.responses == [(41, {"decision": "accept"})]
    assert not client.errors


def test_codex_app_server_session_declines_mcp_elicitation_without_hanging(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [
        {
            "id": 42,
            "method": "mcpServer/elicitation/request",
            "params": {"serverName": "unknown", "message": "need input"},
        }
    ]
    client.notifications = [
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}}
    ]
    runtime_session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )

    result = runtime_session.run_turn("needs input", budget_seconds=5)

    assert result.approval_events == [{"method": "mcpServer/elicitation/request", "decision": "decline"}]
    assert client.responses == [(42, {"action": "decline", "content": None, "_meta": None})]
    assert not client.errors


class FakeRuntimeSession:
    def __init__(self, *, should_retire: bool = False) -> None:
        self.should_retire = should_retire
        self.calls = 0
        self.closed = False
        self.efforts: list[str | None] = []

    def run_turn(self, prompt: str, *, budget_seconds: float, cancel_check=None, on_event=None, native_approval_broker=None, effort=None) -> CodexAppServerTurnResult:
        del budget_seconds, cancel_check, native_approval_broker
        self.calls += 1
        self.efforts.append(effort)
        assert "Repository root:" in prompt
        # Mirror a streaming turn so backends that forward a sink see live events.
        if on_event is not None:
            on_event("message.delta", {"text": "backend ", "streamed_chars": 8})
            on_event("message.delta", {"text": "done", "streamed_chars": 12})
            on_event("message.completed", {"text": "backend done"})
        now = time.time()
        return CodexAppServerTurnResult(
            thread_id="thread-backend",
            turn_id=f"turn-{self.calls}",
            final_text="backend done",
            output="backend done",
            raw_events=[{"method": "item/agentMessage/delta"}],
            approval_events=[],
            should_retire_session=self.should_retire,
            started_at=now,
            finished_at=now,
            duration_seconds=0.01,
        )

    def close(self) -> None:
        self.closed = True


def test_codex_app_server_backend_reuses_session_and_records_transcript(tmp_path):
    created: list[FakeRuntimeSession] = []

    def factory(**kwargs):
        assert kwargs["sandbox"] == "workspace-write"
        runtime_session = FakeRuntimeSession()
        created.append(runtime_session)
        return runtime_session

    backend = CodexAppServerBackend(executable="/tmp/fake-codex", session_factory=factory)
    goal = GoalSpec(title="Ship", description="Use app-server")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    first = backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_first"), limits)
    second = backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_second"), limits)

    assert first.exit_code == 0
    assert second.exit_code == 0
    assert len(created) == 1
    assert created[0].calls == 2
    transcript = json.loads(Path(second.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["extra"]["runtime"] == "codex_app_server"
    assert transcript["extra"]["session_reused"] is True
    assert transcript["extra"]["thread_id"] == "thread-backend"
    assert transcript["extra"]["turn_id"] == "turn-2"
    assert transcript["extra"]["raw_events"] == [{"method": "item/agentMessage/delta"}]


def test_codex_app_server_backend_separates_sessions_by_permission_mode(tmp_path):
    # Regression: "default" and "acceptEdits" both map to workspace-write + on-request,
    # but carry different auto-approve decisions. They must NOT share a cached session,
    # otherwise a session created under one mode keeps its decision for the other.
    created: list[CodexApprovalDecision] = []

    def factory(**kwargs):
        created.append(kwargs["approval_decision"])
        return FakeRuntimeSession()

    backend = CodexAppServerBackend(executable="/tmp/fake-codex", session_factory=factory)
    goal = GoalSpec(title="Ship", description="Use app-server")

    def _limits(mode: str) -> WorkerLimits:
        return WorkerLimits(
            repo_path=tmp_path,
            artifact_dir=tmp_path / "artifacts",
            budget_seconds=10,
            permission_policy=PermissionPolicy(mode=mode),
        )

    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_default"), _limits("default"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_accept"), _limits("acceptEdits"))

    assert len(created) == 2
    # default → nothing auto-approved
    assert created[0] == CodexApprovalDecision()
    # acceptEdits → plugin (MCP) tool calls + file edits auto-approved, shell commands NOT
    assert created[1].accept_mcp_tool is True
    assert created[1].accept_file_change is True
    assert created[1].accept_command is False


def test_codex_app_server_backend_rejects_plugin_dirs_without_runtime_start(tmp_path):
    created: list[FakeRuntimeSession] = []
    backend = CodexAppServerBackend(
        executable="/tmp/fake-codex",
        session_factory=lambda **kwargs: created.append(FakeRuntimeSession()) or created[-1],
    )
    goal = GoalSpec(title="Ship", description="Reject direct plugin dir")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )

    result = backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_reject"), limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "protected-plugin-dir" not in result.output
    assert created == []


def test_codex_app_server_backend_is_registered_in_default_registry():
    assert isinstance(default_backends()["codex-app-server"], CodexAppServerBackend)


def test_elicitation_approved_when_accept_mcp_tool(tmp_path):
    client = FakeCodexClient()
    sess = CodexAppServerSession(cwd=tmp_path, client=client, approval_decision=CodexApprovalDecision(accept_mcp_tool=True))
    out = sess._handle_server_request({"id": 7, "method": "mcpServer/elicitation/request"})
    assert out["decision"] == "accept"
    assert client.responses[-1] == (7, {"action": "accept", "content": {}, "_meta": None})


def test_elicitation_declined_by_default(tmp_path):
    client = FakeCodexClient()
    sess = CodexAppServerSession(cwd=tmp_path, client=client, approval_decision=CodexApprovalDecision())
    out = sess._handle_server_request({"id": 8, "method": "mcpServer/elicitation/request"})
    assert out["decision"] == "decline"
    assert client.responses[-1] == (8, {"action": "decline", "content": None, "_meta": None})


def test_codex_app_server_backend_separates_sessions_by_model(tmp_path):
    # A cached thread keeps the model it was started with; a different per-run
    # selection must get its own session instead of silently reusing the old model.
    created_models: list = []

    def factory(**kwargs):
        created_models.append(kwargs["model"])
        return FakeRuntimeSession()

    backend = CodexAppServerBackend(executable="/tmp/fake-codex", session_factory=factory)
    goal = GoalSpec(title="Ship", description="Use app-server with models")

    def _limits(model):
        return WorkerLimits(
            repo_path=tmp_path,
            artifact_dir=tmp_path / "artifacts",
            budget_seconds=10,
            model_override=model,
        )

    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_m1"), _limits("gpt-5.2-codex"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_m2"), _limits("gpt-5.2-codex"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_m3"), _limits(None))

    assert created_models == ["gpt-5.2-codex", None]


def test_codex_app_server_session_passes_model_to_thread_start(tmp_path):
    client = FakeCodexClient()
    sess = CodexAppServerSession(
        cwd=tmp_path,
        client=client,
        approval_decision=CodexApprovalDecision(),
        model="gpt-5.2-codex",
    )
    sess.ensure_started()
    start_calls = [params for method, params in client.requests if method == "thread/start"]
    assert start_calls and start_calls[0]["model"] == "gpt-5.2-codex"


def test_codex_app_server_session_omits_model_when_unset(tmp_path):
    client = FakeCodexClient()
    sess = CodexAppServerSession(cwd=tmp_path, client=client, approval_decision=CodexApprovalDecision())
    sess.ensure_started()
    start_calls = [params for method, params in client.requests if method == "thread/start"]
    assert start_calls and "model" not in start_calls[0]


def test_codex_app_server_session_passes_model_to_thread_resume(tmp_path):
    class ResumeClient(FakeCodexClient):
        def request(self, method, params=None, *, timeout=None):
            self.requests.append((method, params or {}))
            if method == "thread/resume":
                return {"thread": {"id": "thread-resumed"}}
            return super().request(method, params, timeout=timeout)

    client = ResumeClient()
    sess = CodexAppServerSession(
        cwd=tmp_path,
        client=client,
        approval_decision=CodexApprovalDecision(),
        resume_thread_id="thread-old",
        model="gpt-5.2-codex",
    )
    sess.ensure_started()
    resume_calls = [params for method, params in client.requests if method == "thread/resume"]
    assert resume_calls and resume_calls[0]["model"] == "gpt-5.2-codex"
    assert sess.resumed is True


# --- Native approval broker (P2/D5) ----------------------------------------


class _FakeBroker:
    """Duck-typed NativeApprovalBroker for run_turn integration tests."""

    def __init__(self, decisions, *, timeout: float = 60.0, open_returns=...):
        self._decisions = list(decisions)
        self._timeout = timeout
        self._open_returns = open_returns  # ... = auto id; None = decline-to-open
        self.opened: list[dict] = []
        self.polls: list[str] = []

    def open(self, *, method, action, prompt_text, reserved_path):
        self.opened.append({"method": method, "action": action, "prompt_text": prompt_text})
        if self._open_returns is None:
            return None
        return f"esc_{len(self.opened) - 1}"

    def poll(self, escalation_request_id):
        self.polls.append(escalation_request_id)
        return self._decisions.pop(0) if self._decisions else "pending"

    def timeout_seconds(self):
        return self._timeout


def _approval_session(tmp_path, client):
    return CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),  # static = decline; broker overrides
        post_tool_quiet_timeout_seconds=60,
    )


def _cmd_request(req_id=41):
    return {
        "id": req_id,
        "method": "item/commandExecution/requestApproval",
        "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "cmd", "command": "touch ok"},
    }


def _completed():
    return {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}}


def test_native_broker_human_approve_responds_accept(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [_cmd_request()]
    client.notifications = [_completed()]
    broker = _FakeBroker(["allow"])
    session = _approval_session(tmp_path, client)

    result = session.run_turn("needs approval", budget_seconds=5, native_approval_broker=broker)

    assert client.responses == [(41, {"decision": "accept"})]
    assert not client.errors
    assert broker.opened and broker.opened[0]["method"] == "item/commandExecution/requestApproval"
    # digest binds the full request payload, not a preview
    assert broker.opened[0]["action"]["params"]["command"] == "touch ok"
    assert result.approval_events == [
        {"method": "item/commandExecution/requestApproval", "decision": "accept", "source": "native", "reason": "human-approved"}
    ]


def test_native_broker_human_deny_responds_decline(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [_cmd_request()]
    client.notifications = [_completed()]
    broker = _FakeBroker(["deny"])
    session = _approval_session(tmp_path, client)

    session.run_turn("needs approval", budget_seconds=5, native_approval_broker=broker)

    assert client.responses == [(41, {"decision": "decline"})]
    assert not client.errors


def test_native_broker_timeout_fails_closed_decline(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [_cmd_request()]
    client.notifications = [_completed()]
    broker = _FakeBroker([], timeout=0.0)  # never decided + zero window → fail-closed decline
    session = _approval_session(tmp_path, client)

    session.run_turn("needs approval", budget_seconds=5, native_approval_broker=broker)

    assert client.responses == [(41, {"decision": "decline"})]


def test_native_broker_cancel_declines_pending_on_exit(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [_cmd_request()]
    client.notifications = []  # never completes on its own
    broker = _FakeBroker([], timeout=600.0)  # stays pending
    session = _approval_session(tmp_path, client)
    calls = {"n": 0}

    def cancel_check():
        calls["n"] += 1
        return calls["n"] >= 2  # False on the first loop pass (opens pending), True after

    session.run_turn("needs approval", budget_seconds=5, cancel_check=cancel_check, native_approval_broker=broker)

    # the pending approval is declined fail-closed on the cancel exit (never left hanging)
    assert client.responses == [(41, {"decision": "decline"})]


def test_native_broker_open_declines_falls_back_to_static(tmp_path):
    client = FakeCodexClient()
    client.server_requests = [_cmd_request()]
    client.notifications = [_completed()]
    # broker.open returns None → fall back to the static decision (here: decline)
    broker = _FakeBroker([], open_returns=None)
    session = _approval_session(tmp_path, client)

    result = session.run_turn("needs approval", budget_seconds=5, native_approval_broker=broker)

    assert client.responses == [(41, {"decision": "decline"})]  # static path
    assert result.approval_events == [{"method": "item/commandExecution/requestApproval", "decision": "decline"}]


def test_native_broker_handles_concurrent_pending_approvals(tmp_path):
    # Two approval requests may be in flight at once; pending_native is keyed by codex
    # request id, so each resolves to its own response (no cross-talk).
    client = FakeCodexClient()
    client.server_requests = [_cmd_request(41), _cmd_request(42)]
    client.notifications = [_completed()]
    broker = _FakeBroker(["allow", "allow"])
    session = _approval_session(tmp_path, client)

    session.run_turn("two approvals", budget_seconds=5, native_approval_broker=broker)

    assert (41, {"decision": "accept"}) in client.responses
    assert (42, {"decision": "accept"}) in client.responses
    assert len(client.responses) == 2


def test_codex_app_server_effort_rides_turn_start_and_shares_session(tmp_path):
    """Reasoning effort is applied PER TURN via run_turn (turn/start.effort), NOT a
    process-level `-c`. It is therefore absent from extra_args, and one cached
    app-server thread serves different efforts on successive turns (no per-effort
    daemon rebuild)."""
    seen_args: list[list[str]] = []
    sessions: list[FakeRuntimeSession] = []

    def factory(**kwargs):
        seen_args.append(list(kwargs["extra_args"]))
        sess = FakeRuntimeSession()
        sessions.append(sess)
        return sess

    backend = CodexAppServerBackend(executable="/tmp/fake-codex", session_factory=factory)
    goal = GoalSpec(title="Ship", description="Use app-server effort")

    def _limits(effort: str | None) -> WorkerLimits:
        return WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10, effort_override=effort)

    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="r_high"), _limits("high"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="r_high2"), _limits("high"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="r_xhigh"), _limits("xhigh"))
    backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="r_clear"), _limits(None))

    # No `-c model_reasoning_effort` ever reaches the spawned daemon.
    assert all("-c" not in args for args in seen_args)
    # One shared session (effort no longer keys the cache); effort rides each turn.
    assert len(sessions) == 1
    assert sessions[0].efforts == ["high", "high", "xhigh", None]


def test_codex_app_server_rejects_invalid_effort_without_spawning(tmp_path):
    spawned = []

    def factory(**kwargs):
        spawned.append(kwargs)
        return FakeRuntimeSession()

    backend = CodexAppServerBackend(executable="/tmp/fake-codex", session_factory=factory)
    goal = GoalSpec(title="Ship", description="bad effort")
    res = backend.run(
        _task(), goal, RunSession(goal_id=goal.goal_id, run_id="r_bad"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10, effort_override="turbo"),
    )
    assert res.exit_code == 1
    assert "EFFORT_INVALID" in res.output
    assert spawned == []  # never spawned a daemon with a malformed -c


def _turn_start_params(client: FakeCodexClient) -> dict:
    for method, params in reversed(client.requests):
        if method == "turn/start":
            return params
    raise AssertionError("no turn/start request recorded")


def _completing_client(*, reasoning_effort: str | None = None) -> FakeCodexClient:
    client = FakeCodexClient()
    if reasoning_effort is not None:
        client.thread_start_response = {"thread": {"id": "thread-1"}, "reasoningEffort": reasoning_effort}
    client.notifications = [
        {"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}},
        {"method": "item/agentMessage/delta", "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "msg", "delta": "ok"}},
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    return client


def _effort_session(client: FakeCodexClient, tmp_path) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
    )


def test_run_turn_sends_explicit_effort_on_turn_start(tmp_path):
    """An explicit per-turn effort is forwarded as turn/start.effort (native,
    process-free) — never as a `-c` and never forcing a new app-server."""
    client = _completing_client()
    session = _effort_session(client, tmp_path)
    session.run_turn("ship it", budget_seconds=5, effort="low")
    assert _turn_start_params(client).get("effort") == "low"


def test_run_turn_cleared_effort_falls_back_to_thread_baseline(tmp_path):
    """A cleared/empty effort re-sends the thread's captured baseline (the
    reasoningEffort codex resolved at start), so it reverts to the runtime default
    instead of inheriting a prior turn's pinned override."""
    client = _completing_client(reasoning_effort="high")
    session = _effort_session(client, tmp_path)
    session.run_turn("ship it", budget_seconds=5, effort="")  # REQUEST_CLEAR
    assert _turn_start_params(client).get("effort") == "high"


def test_run_turn_explicit_effort_overrides_thread_baseline(tmp_path):
    client = _completing_client(reasoning_effort="high")
    session = _effort_session(client, tmp_path)
    session.run_turn("ship it", budget_seconds=5, effort="low")
    assert _turn_start_params(client).get("effort") == "low"


def test_run_turn_clear_after_explicit_override_reverts_to_baseline(tmp_path):
    """The core anti-drift guarantee: pinning an explicit effort then clearing must
    revert to the thread baseline, NOT inherit the prior turn's override (which
    turn/start.effort would otherwise persist 'for subsequent turns')."""
    client = _completing_client(reasoning_effort="high")
    session = _effort_session(client, tmp_path)
    session.run_turn("turn-1", budget_seconds=5, effort="low")  # pin low
    assert _turn_start_params(client).get("effort") == "low"
    client.notifications = [
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    session.run_turn("turn-2", budget_seconds=5, effort="")  # clear
    assert _turn_start_params(client).get("effort") == "high"  # reverted to baseline, not "low"


def test_run_turn_omits_effort_when_none_and_no_baseline(tmp_path):
    """No selection and no resolvable baseline → no effort field at all (codex
    uses its own configured default); never an empty/None value on the wire."""
    client = _completing_client()  # thread/start response carries no reasoningEffort
    session = _effort_session(client, tmp_path)
    session.run_turn("ship it", budget_seconds=5)
    assert "effort" not in _turn_start_params(client)


def test_run_turn_case_insensitive_effort_normalized(tmp_path):
    client = _completing_client()
    session = _effort_session(client, tmp_path)
    session.run_turn("ship it", budget_seconds=5, effort="  HIGH ")
    assert _turn_start_params(client).get("effort") == "high"


def test_resumed_thread_clear_reverts_to_resume_baseline_not_prior_override(tmp_path):
    """On resume, the baseline is the resume response's reasoningEffort — which
    codex resolves to the runtime's configured default, NOT the persisted thread's
    last effort (verified empirically). A turn that pins low then a cleared turn
    therefore reverts to that baseline rather than inheriting the low override, so
    'clear == runtime default' holds across resume exactly as the legacy
    rebuild-without-`-c` path did."""
    client = _completing_client()
    client.thread_resume_response = {"thread": {"id": "thread-1"}, "reasoningEffort": "high"}
    session = CodexAppServerSession(
        cwd=tmp_path,
        client=client,  # type: ignore[arg-type]
        approval_decision=CodexApprovalDecision(),
        post_tool_quiet_timeout_seconds=60,
        resume_thread_id="thread-1",
    )
    session.run_turn("first", budget_seconds=5, effort="low")
    assert session.resumed is True
    assert session.default_effort == "high"  # captured from the resume response
    # Reset the completion notifications for a second turn.
    client.notifications = [
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}}},
    ]
    session.run_turn("second", budget_seconds=5, effort="")  # cleared
    assert _turn_start_params(client).get("effort") == "high"  # baseline, not the prior "low"
