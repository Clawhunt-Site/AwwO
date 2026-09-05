from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from superclaw import trace_context
from superclaw.credential_guard import scrub_operator_authority_env
from superclaw.display_projection import (
    new_codex_projection_state,
    project_codex_approval_requested,
    project_codex_approval_resolved,
    project_codex_event,
    project_terminal_repair,
)
from superclaw.runtime import desktop_toolchain_env, redact_secrets

# Cap command output / reasoning text carried in live events so a noisy command
# cannot flood the bus or a UI. Full output still lands in the transcript.
_EVENT_TEXT_LIMIT = 2000

# App-server server-request methods that ask SuperClaw to approve a native action
# (codex command/file/permission escalation + MCP tool-call elicitation).
_APPROVAL_REQUEST_METHODS = frozenset(
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
    }
)


class NativeApprovalBroker(Protocol):
    """Bridges a codex native ``requestApproval`` into the SuperClaw escalation queue
    (P2/D5). Injected per-run by the orchestrator (which holds store + run + principal);
    when absent the session keeps its legacy static decision. Never blocks — ``open``
    records a durable pending escalation and returns its id; ``poll`` reports the human
    decision so the run_turn loop can respond out-of-band without stalling cancel/
    deadline/event drain (see docs/native-approval-broker-design.md)."""

    def open(self, *, method: str, action: dict[str, Any], prompt_text: str, reserved_path: str | None) -> str | None:
        """Create a PENDING runtime_tool escalation for this exact codex action and
        return its escalation request_id, or None to fall back to the static decision
        (e.g. broker disabled for this posture / open failed → fail-closed static)."""
        ...

    def poll(self, escalation_request_id: str) -> str:
        """Return ``'allow'`` | ``'deny'`` | ``'expired'`` | ``'pending'`` for a
        previously opened escalation. ``'allow'`` consumes the single-use grant."""
        ...

    def timeout_seconds(self) -> float:
        """Per-approval upper bound; on exceed the broker path fail-closes (decline)."""
        ...


def _extract_reasoning_text(item: dict[str, Any]) -> str:
    """Join codex reasoning ``summary``/``content`` blocks into plain text."""
    parts: list[str] = []
    for key in ("summary", "content"):
        seq = item.get(key)
        if isinstance(seq, list):
            for el in seq:
                if isinstance(el, str):
                    parts.append(el)
                elif isinstance(el, dict):
                    text = el.get("text") or el.get("summary") or el.get("content")
                    if isinstance(text, str):
                        parts.append(text)
    return "\n".join(p for p in parts if p).strip()


def _event_text(value: Any) -> str:
    text = redact_secrets(str(value or ""))
    return text if len(text) <= _EVENT_TEXT_LIMIT else text[-_EVENT_TEXT_LIMIT:]


class CodexAppServerError(RuntimeError):
    """Raised when the Codex app-server transport or turn protocol fails."""


@dataclass(frozen=True)
class CodexApprovalDecision:
    accept_command: bool = False
    accept_file_change: bool = False
    accept_permissions: bool = False
    accept_mcp_tool: bool = False  # auto-approve MCP (plugin) tool-call elicitations
    scope: str = "turn"


@dataclass
class CodexAppServerTurnResult:
    thread_id: str
    turn_id: str | None
    final_text: str
    output: str
    raw_events: list[dict[str, Any]] = field(default_factory=list)
    approval_events: list[dict[str, Any]] = field(default_factory=list)
    command_output: str = ""
    diff: str = ""
    error: str | None = None
    timed_out: bool = False
    cancelled: bool = False
    interrupted: bool = False
    should_retire_session: bool = False
    tool_iterations: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    duration_seconds: float = 0.0


class CodexAppServerClient:
    """Small JSON-RPC stdio client for `codex app-server --listen stdio://`."""

    def __init__(
        self,
        *,
        executable: str,
        extra_args: list[str] | None = None,
        env: dict[str, str] | None = None,
        request_timeout: float = 30.0,
    ) -> None:
        self.executable = executable
        self.extra_args = list(extra_args or [])
        self.env = desktop_toolchain_env(env or os.environ.copy())
        self.request_timeout = request_timeout
        self._next_id = 1
        self._lock = threading.Lock()
        self._pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._notifications: queue.Queue[dict[str, Any]] = queue.Queue()
        self._server_requests: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr_tail: deque[str] = deque(maxlen=200)
        self._process: subprocess.Popen[str] | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None

    def start(self) -> None:
        if self._process is not None and self.is_alive():
            return
        command = [self.executable, "app-server", "--listen", "stdio://", *self.extra_args]
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                # Re-read trace context at spawn time (not __init__) so the
                # app-server child carries the active operation's correlation.
                # Scrub operator-authority vars (route B): the codex app-server
                # agent never inherits the operator's ambient API token.
                env=scrub_operator_authority_env(trace_context.child_env(self.env)),
                bufsize=1,
            )
        except OSError as exc:
            raise CodexAppServerError(f"failed to start codex app-server: {exc}") from exc
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def initialize(self) -> dict[str, Any]:
        self.start()
        response = self.request(
            "initialize",
            {
                "clientInfo": {"name": "superclaw", "title": "SuperClaw", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        return response if isinstance(response, dict) else {}

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        self.start()
        request_id = self._allocate_id()
        waiter: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        self._pending[request_id] = waiter
        self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        try:
            message = waiter.get(timeout=timeout or self.request_timeout)
        except queue.Empty as exc:
            self._pending.pop(request_id, None)
            raise CodexAppServerError(f"codex app-server request timed out: {method}") from exc
        if "error" in message:
            error = message.get("error")
            raise CodexAppServerError(f"codex app-server request failed: {method}: {error}")
        return message.get("result")

    def respond(self, request_id: int | str, result: dict[str, Any]) -> None:
        self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(self, request_id: int | str, message: str, *, code: int = -32603) -> None:
        self._write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})

    def take_notification(self, timeout: float = 0.0) -> dict[str, Any] | None:
        try:
            return self._notifications.get(timeout=timeout)
        except queue.Empty:
            return None

    def take_server_request(self, timeout: float = 0.0) -> dict[str, Any] | None:
        try:
            return self._server_requests.get(timeout=timeout)
        except queue.Empty:
            return None

    def is_alive(self) -> bool:
        return bool(self._process and self._process.poll() is None)

    def stderr_tail(self) -> str:
        return "".join(self._stderr_tail)[-8000:]

    def close(self) -> None:
        process = self._process
        self._process = None
        if not process:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2.0)

    def _allocate_id(self) -> int:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
        return request_id

    def _write_message(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.poll() is not None:
            raise CodexAppServerError("codex app-server is not running")
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        try:
            process.stdin.write(line + "\n")
            process.stdin.flush()
        except OSError as exc:
            raise CodexAppServerError(f"failed to write codex app-server message: {exc}") from exc

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._stderr_tail.append(f"non-json stdout: {line}\n")
                continue
            if not isinstance(message, dict):
                continue
            request_id = message.get("id")
            if request_id is not None and "method" not in message:
                waiter = self._pending.pop(int(request_id), None) if isinstance(request_id, int) else self._pending.pop(request_id, None)  # type: ignore[arg-type]
                if waiter is not None:
                    waiter.put(message)
                continue
            if request_id is not None and "method" in message:
                self._server_requests.put(message)
                continue
            if "method" in message:
                self._notifications.put(message)

    def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            self._stderr_tail.append(line)


class CodexAppServerSession:
    def __init__(
        self,
        *,
        cwd: Path,
        client: CodexAppServerClient,
        approval_decision: CodexApprovalDecision,
        sandbox: str = "workspace-write",
        approval_policy: str = "on-request",
        post_tool_quiet_timeout_seconds: float = 30.0,
        resume_thread_id: str | None = None,
        ephemeral: bool = True,
        model: str | None = None,
    ) -> None:
        self.cwd = cwd
        self.client = client
        self.approval_decision = approval_decision
        self.sandbox = sandbox
        self.approval_policy = approval_policy
        # Optional model selection forwarded to thread/start + thread/resume
        # (ThreadStartParams.model in the app-server protocol). None lets codex
        # use its configured default.
        self.model = model
        self.post_tool_quiet_timeout_seconds = max(0.1, post_tool_quiet_timeout_seconds)
        # When resume_thread_id is provided, ensure_started() reattaches to that
        # codex thread (loaded from its on-disk rollout) so the conversation keeps
        # its native memory across backend restarts. ephemeral=False makes
        # thread/start persist a rollout so the thread is resumable later.
        self.resume_thread_id = resume_thread_id
        self.ephemeral = ephemeral
        self.thread_id: str | None = None
        self.thread_start_response: dict[str, Any] | None = None
        # The thread's resolved baseline reasoning effort, captured from the
        # thread/start (or thread/resume) response's ``reasoningEffort`` field —
        # i.e. whatever codex's own Config resolved this thread to. A per-turn run
        # with no explicit effort re-sends this baseline so a CLEARED selection
        # deterministically reverts to the runtime default (matching the legacy
        # "omit the flag → ambient default" semantics) even after a prior turn
        # pinned a different effort via turn/start.effort, whose override otherwise
        # persists "for this turn and subsequent turns".
        #
        # Resume equivalence (behavior-preserving, independent of model selection):
        # this change does NOT touch when ``model`` is sent on thread/resume, so
        # codex's own baseline resolution is byte-identical to the legacy path.
        # When a model override IS present, merge_persisted_resume_metadata()
        # short-circuits on has_model_resume_override() and the baseline is the
        # config default; when it is absent, codex re-applies the persisted thread's
        # reasoning_effort. EITHER way the response's reasoningEffort is exactly the
        # value the legacy rebuild-without-`-c`+resume path would have resolved and
        # applied. Re-sending that captured value on a cleared turn is therefore a
        # no-op relative to codex's own resolution — clear stays equivalent to the
        # old "omit the flag, let codex resolve" semantics in every branch.
        #
        # Invariant: a reasoning-capable codex model always resolves a non-None
        # reasoning_effort, so default_effort is reliably populated whenever effort
        # selection is offered (supports_effort_selection); a model that returns no
        # reasoningEffort is non-reasoning and is never offered an effort to pin,
        # so the "None baseline + prior override" inherit case is unreachable.
        self.default_effort: str | None = None
        self.initialize_response: dict[str, Any] | None = None
        # True once we successfully reattach to an existing on-disk thread (native
        # memory restored). resume_failed records that a resume was requested but
        # the rollout could not be loaded, so the caller can fall back to replaying
        # its own transcript.
        self.resumed: bool = False
        self.resume_failed: bool = False
        # Display Protocol projection state is held on the SESSION (not per turn)
        # so the synthetic event/call ids stay session-local-monotonic and never
        # collide across turns that reuse this codex thread (DL5). begin_turn()
        # resets only the per-turn transient maps.
        self._projection_state = None

    @staticmethod
    def _extract_thread_id(response: Any) -> str | None:
        if not isinstance(response, dict):
            return None
        thread = response.get("thread")
        thread_id = None
        if isinstance(thread, dict):
            thread_id = thread.get("id") or thread.get("sessionId")
        thread_id = thread_id or response.get("threadId") or response.get("sessionId")
        return thread_id if isinstance(thread_id, str) and thread_id else None

    @staticmethod
    def _extract_reasoning_effort(response: Any) -> str | None:
        """The thread's resolved baseline effort from a start/resume response
        (``ThreadStartResponse.reasoningEffort`` / ``ThreadResumeResponse``).
        Normalized to lower-case; None when absent."""
        if not isinstance(response, dict):
            return None
        effort = response.get("reasoningEffort")
        if isinstance(effort, str) and effort.strip():
            return effort.strip().lower()
        return None

    def ensure_started(self) -> None:
        if self.thread_id and self.client.is_alive():
            return
        self.initialize_response = self.client.initialize()

        # Try to reattach to a previously persisted thread first so the
        # conversation keeps codex's native memory (and its own compaction)
        # across backend restarts.
        if self.resume_thread_id:
            try:
                resume_params: dict[str, Any] = {
                    "threadId": self.resume_thread_id,
                    "cwd": str(self.cwd),
                    "sandbox": self.sandbox,
                    "approvalPolicy": self.approval_policy,
                    "approvalsReviewer": "user",
                }
                if self.model:
                    resume_params["model"] = self.model
                response = self.client.request("thread/resume", resume_params)
                thread_id = self._extract_thread_id(response)
                if thread_id:
                    self.thread_id = thread_id
                    self.thread_start_response = response
                    self.default_effort = self._extract_reasoning_effort(response)
                    self.resumed = True
                    return
            except Exception:
                # Rollout missing/corrupt or protocol error: fall back to a fresh
                # thread. The caller replays its own transcript when resume_failed.
                pass
            self.resume_failed = True

        start_params: dict[str, Any] = {
            "cwd": str(self.cwd),
            "sandbox": self.sandbox,
            "approvalPolicy": self.approval_policy,
            "approvalsReviewer": "user",
            "ephemeral": self.ephemeral,
            "sessionStartSource": "startup",
            "threadSource": "user",
            "serviceName": "superclaw",
        }
        if self.model:
            start_params["model"] = self.model
        response = self.client.request("thread/start", start_params)
        if not isinstance(response, dict):
            raise CodexAppServerError("codex app-server returned invalid thread/start response")
        thread_id = self._extract_thread_id(response)
        if not thread_id:
            raise CodexAppServerError("codex app-server thread/start response did not include a thread id")
        self.thread_id = thread_id
        self.thread_start_response = response
        self.default_effort = self._extract_reasoning_effort(response)

    def run_turn(
        self,
        prompt: str,
        *,
        budget_seconds: float,
        cancel_check: Callable[[], bool] | None = None,
        on_event: Callable[[str, dict[str, Any]], None] | None = None,
        native_approval_broker: "NativeApprovalBroker | None" = None,
        effort: str | None = None,
    ) -> CodexAppServerTurnResult:
        self.ensure_started()
        assert self.thread_id is not None
        # Per-turn reasoning effort rides the native ``turn/start.effort`` field
        # (TurnStartParams.effort) — the protocol-native, process-free mechanism —
        # instead of a process-level ``-c model_reasoning_effort`` that would force
        # a fresh app-server per effort. An explicit effort wins; a cleared/empty
        # selection falls back to the thread's captured baseline so it reverts to
        # the runtime default rather than inheriting a prior turn's pinned override
        # (turn/start.effort persists "for this turn and subsequent turns"). The
        # caller is responsible for validating the level against EFFORT_LEVELS.
        turn_effort = (effort or "").strip().lower() or self.default_effort
        started_at = time.time()
        started = time.monotonic()
        deadline = started + max(0.001, budget_seconds)

        # Live-streaming state. Text deltas are coalesced so we emit a bounded
        # number of message.delta events instead of one per token (which would
        # flood the durable event store). Flush on size or elapsed time.
        delta_buffer: list[str] = []
        streamed_chars = 0
        last_flush = time.monotonic()
        flush_char_threshold = 512
        flush_interval_seconds = 0.25

        def _emit(event_type: str, payload: dict[str, Any]) -> None:
            if on_event is None:
                return
            try:
                on_event(event_type, payload)
            except Exception:  # pragma: no cover - sink is best-effort
                pass

        def _flush_delta(*, force: bool = False) -> None:
            nonlocal streamed_chars, last_flush
            if not delta_buffer:
                return
            now_m = time.monotonic()
            buffered = sum(len(part) for part in delta_buffer)
            if not force and buffered < flush_char_threshold and (now_m - last_flush) < flush_interval_seconds:
                return
            text = "".join(delta_buffer)
            delta_buffer.clear()
            streamed_chars += len(text)
            last_flush = now_m
            _emit("message.delta", {"text": text, "streamed_chars": streamed_chars})
        raw_events: list[dict[str, Any]] = []
        approvals: list[dict[str, Any]] = []
        text_parts: list[str] = []
        command_parts: list[str] = []
        diff_parts: list[str] = []
        tool_iterations = 0
        error: str | None = None
        turn_id: str | None = None
        timed_out = False
        cancelled = False
        # Remote cancel (codex reports turn/completed status=cancelled) is distinct
        # from a SuperClaw-initiated cancel; it must still drive terminal repair to
        # mark open tools cancelled (not error), without changing the turn result's
        # `cancelled` semantics for existing callers.
        remote_cancelled = False
        interrupted = False
        should_retire = False
        last_tool_at: float | None = None
        last_event_at = time.monotonic()

        # --- Native approval broker state (P2/D5) ---------------------------------
        # With a broker wired, codex requestApproval is NOT answered statically: we open
        # a runtime_tool escalation (durable → queue/popup) and DEFER the response,
        # polling for the human decision each loop pass. The loop already checks
        # cancel/deadline/alive every iteration, so deferring never stalls them.
        # pending_native is run_turn-LOCAL (no cross-turn leak) and is fully declined
        # before any exit (after the loop).
        broker = native_approval_broker
        pending_native: dict[Any, dict[str, Any]] = {}

        def _native_action(request: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
            method = str(request.get("method") or "")
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            # Digest binds the FULL request payload (method + params), not a UI preview —
            # a single byte change invalidates the grant (design §digest).
            action = {"method": method, "params": params}
            if method == "item/commandExecution/requestApproval":
                cmd = params.get("command")
                prompt = f"codex 请求执行命令:{cmd}" if cmd else f"codex 请求审批:{method}"
            elif method == "item/fileChange/requestApproval":
                path = params.get("path")
                prompt = f"codex 请求修改文件:{path}" if path else f"codex 请求审批:{method}"
            elif method == "item/permissions/requestApproval":
                prompt = "codex 请求额外权限"
            elif method == "mcpServer/elicitation/request":
                label = params.get("serverName") or params.get("message") or method
                prompt = f"codex 请求 MCP 工具确认:{label}"
            else:
                prompt = f"codex 请求审批:{method}"
            return method, action, prompt

        def _open_native(request: dict[str, Any]) -> str | None:
            if broker is None:
                return None
            method, action, prompt = _native_action(request)
            try:
                return broker.open(method=method, action=action, prompt_text=prompt, reserved_path=None)
            except Exception:  # broker failure must not crash the turn → fall back to static
                return None

        def _resolve_native(codex_request_id: Any, request: dict[str, Any], accept: bool, reason: str) -> None:
            nonlocal last_event_at
            # Respond to codex only WHEN the decision is made (human / timeout / exit) —
            # the deferred response. Visibility to the operator is via the durable
            # escalation queue (/api/escalations + D3 popup), not a run-event projection
            # (the codex display projection is a separate layer, not on this base).
            decision = self._respond_approval(request, accept)
            # Resolving IS a fresh event for codex (it now proceeds/aborts on our answer):
            # stamp last_event_at so the stall timer — which resumes once pending clears —
            # does not instantly fire after a long human wait and kill a just-approved turn.
            last_event_at = time.monotonic()
            approvals.append(
                {"method": str(request.get("method") or ""), "decision": decision, "source": "native", "reason": reason}
            )
            raw_events.append({"direction": "server_request", **_redact_json(request), "decision": f"{decision}({reason})"})
            pending_native.pop(codex_request_id, None)

        def _poll_native() -> None:
            if not pending_native or broker is None:
                return
            now_m = time.monotonic()
            try:
                timeout = max(0.0, broker.timeout_seconds())
            except Exception:
                timeout = 0.0  # broker misbehaving → treat as already timed out (fail-closed)
            for cid, info in list(pending_native.items()):
                # Timeout is checked FIRST and WITHOUT polling: once the per-approval window
                # has elapsed the action is declined fail-closed regardless of a (possibly
                # late) human answer — and we must NOT poll, since an "allow" poll consumes
                # the single-use grant that we are about to refuse.
                if now_m - info["opened_at"] >= timeout:
                    _resolve_native(cid, info["request"], False, "timeout")
                    continue
                try:
                    decision = broker.poll(info["escalation_id"])
                except Exception:
                    decision = "pending"  # transient broker error → keep waiting (timeout/deadline govern)
                if decision == "allow":
                    _resolve_native(cid, info["request"], True, "human-approved")
                elif decision in ("deny", "expired"):
                    _resolve_native(cid, info["request"], False, decision)
                # else "pending": keep waiting

        def _decline_all_native(reason: str) -> None:
            for cid, info in list(pending_native.items()):
                # Best-effort: a respond failure must never mask the original exit cause.
                try:
                    _resolve_native(cid, info["request"], False, reason)
                except Exception:
                    pending_native.pop(cid, None)

        turn_params: dict[str, Any] = {
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": prompt}],
            "cwd": str(self.cwd),
        }
        if turn_effort:
            turn_params["effort"] = turn_effort
        start_response = self.client.request(
            "turn/start",
            turn_params,
            timeout=min(30.0, max(1.0, budget_seconds)),
        )
        if isinstance(start_response, dict):
            turn = start_response.get("turn")
            if isinstance(turn, dict):
                turn_id = turn.get("id") if isinstance(turn.get("id"), str) else None

        # Display Protocol projection context (DL1): threaded across raw events.
        # Held on the session so synthetic event/call ids stay session-local-
        # monotonic and never collide across turns (DL5); a reused thread's next
        # turn only resets the per-turn transient maps. Produces canonical
        # DisplayEvents for tool/reasoning/approval; the text stream
        # (message.delta/completed) stays bare so existing surfaces are untouched.
        if self._projection_state is None:
            self._projection_state = new_codex_projection_state(turn_id=turn_id)
        else:
            self._projection_state.begin_turn(turn_id)
        proj_ctx = self._projection_state

        while True:
            now = time.monotonic()
            _flush_delta()  # time-based flush even when no new notification arrives
            if cancel_check and cancel_check():
                cancelled = True
                interrupted = self._interrupt(turn_id)
                should_retire = True
                break
            if now >= deadline:
                timed_out = True
                interrupted = self._interrupt(turn_id)
                should_retire = True
                break
            # Stall timeout is EXEMPT while a native approval is pending: the quiet gap is
            # us waiting on a human, not codex stalling. The per-approval timeout + run
            # deadline (both still checked) govern that wait instead.
            if not pending_native and last_tool_at is not None and now - last_tool_at >= self.post_tool_quiet_timeout_seconds and now - last_event_at >= self.post_tool_quiet_timeout_seconds:
                error = f"codex app-server turn stalled after tool activity for {self.post_tool_quiet_timeout_seconds:.1f}s"
                interrupted = self._interrupt(turn_id)
                should_retire = True
                break
            if not self.client.is_alive():
                error = "codex app-server exited before turn completion"
                should_retire = True
                break

            # Resolve any native approvals the human has answered (or that timed out) —
            # the deferred-response poll. Runs every pass so a decision lands promptly
            # even when codex sends no new message.
            _poll_native()

            request = self.client.take_server_request(timeout=0.0)
            if request is not None:
                last_event_at = time.monotonic()
                # Read-only auto-approval broadcast (DL7): requested BEFORE the
                # kernel decides, resolved AFTER it responds. decided_by=kernel,
                # no client->kernel write back.
                for de in project_codex_approval_requested(request, proj_ctx):
                    _emit(de.type, de.to_dict())
                # Native broker path: open a runtime_tool escalation + DEFER the response
                # (record as pending; _poll_native answers it later). Falls back to the
                # static decision if no broker is wired or open() declines.
                if broker is not None and str(request.get("method") or "") in _APPROVAL_REQUEST_METHODS and request.get("id") is not None:
                    escalation_id = _open_native(request)
                    if escalation_id is not None:
                        pending_native[request["id"]] = {
                            "request": request,
                            "escalation_id": escalation_id,
                            "opened_at": time.monotonic(),
                        }
                        raw_events.append({"direction": "server_request", **_redact_json(request), "decision": "pending(native)"})
                        continue
                approval = self._handle_server_request(request)
                for de in project_codex_approval_resolved(request, approval.get("decision"), proj_ctx):
                    _emit(de.type, de.to_dict())
                approvals.append(approval)
                raw_events.append({"direction": "server_request", **_redact_json(request), "decision": approval.get("decision")})
                if approval.get("decision") == "cancel":
                    should_retire = True
                continue

            notification = self.client.take_notification(timeout=0.1)
            if notification is None:
                continue
            last_event_at = time.monotonic()
            raw_events.append({"direction": "notification", **_redact_json(notification)})
            method = str(notification.get("method") or "")
            params = notification.get("params") if isinstance(notification.get("params"), dict) else {}
            # Canonical display projection (tool.*/reasoning.*) at the emit site
            # (DL1). The text stream (message.delta/completed) is NOT projected
            # here — it keeps its existing bare wire shape below so the surfaces
            # that already render the text are untouched across PRs.
            for de in project_codex_event(notification, proj_ctx):
                _emit(de.type, de.to_dict())
            if method == "turn/started":
                turn_id = _turn_id_from_params(params) or turn_id
                proj_ctx.turn_id = turn_id
            elif method == "item/started":
                item = params.get("item") if isinstance(params.get("item"), dict) else {}
                item_type = str(item.get("type") or "")
                if item_type in {"commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"}:
                    last_tool_at = time.monotonic()
            elif method in {"item/agentMessage/delta", "agent/message/delta"}:
                delta = params.get("delta")
                if isinstance(delta, str):
                    text_parts.append(delta)
                    delta_buffer.append(delta)
                    _flush_delta()
            elif method in {
                "item/commandExecution/outputDelta",
                "item/commandExecution/output/delta",
                "commandExecution/output/delta",
            }:
                delta = params.get("delta")
                if isinstance(delta, str):
                    command_parts.append(delta)
                last_tool_at = time.monotonic()
            elif method in {
                "turn/diff/updated",
                "item/fileChange/patchUpdated",
                "item/fileChange/patch/updated",
                "item/fileChange/outputDelta",
            }:
                diff = params.get("diff") or params.get("delta")
                if isinstance(diff, str):
                    diff_parts.append(diff)
                last_tool_at = time.monotonic()
            elif method == "item/completed":
                item = params.get("item") if isinstance(params.get("item"), dict) else {}
                item_type = str(item.get("type") or "")
                if item_type == "agentMessage":
                    completed_text = item.get("text")
                    if isinstance(completed_text, str):
                        text_parts = [completed_text]
                        _flush_delta(force=True)
                        _emit("message.completed", {"text": completed_text})
                        if _has_turn_aborted_marker(completed_text):
                            error = "codex reported turn_aborted"
                            interrupted = True
                            should_retire = True
                            break
                elif item_type == "commandExecution":
                    aggregated = item.get("aggregatedOutput")
                    if isinstance(aggregated, str) and aggregated:
                        command_parts = [aggregated]
                    tool_iterations += 1
                    last_tool_at = time.monotonic()
                elif item_type == "fileChange":
                    patch = item.get("diff") or item.get("patch")
                    if isinstance(patch, str) and patch:
                        diff_parts.append(patch)
                    tool_iterations += 1
                    last_tool_at = time.monotonic()
                elif item_type in {"mcpToolCall", "dynamicToolCall"}:
                    tool_iterations += 1
                    last_tool_at = time.monotonic()
            elif method == "error":
                error = _compact_error(params.get("error"))
            elif method == "turn/completed":
                turn_id = _turn_id_from_params(params) or turn_id
                proj_ctx.turn_id = turn_id
                turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
                status = str(turn.get("status") or "")
                if status == "cancelled":
                    remote_cancelled = True
                if status and status not in {"completed", "cancelled"}:
                    error = _compact_error(turn.get("error")) or f"codex app-server turn ended with status={status}"
                    should_retire = status in {"failed", "interrupted"}
                break

        # Terminal repair (DL8): close any tool call codex left open so the UI
        # never spins forever. cancel/timeout/remote-cancel -> cancelled;
        # error/stall/exit/aborted/normal-leftover -> error. Partial buffered
        # output is folded in.
        for de in project_terminal_repair(proj_ctx, cancelled=(cancelled or timed_out or remote_cancelled)):
            _emit(de.type, de.to_dict())
        # Fail-closed exit: any native approval still pending when the loop ends (cancel,
        # deadline, stall, codex exit, turn completed/aborted) is DECLINED so codex's
        # request is never left hanging. Best-effort — a respond failure here must not
        # mask the original exit cause (should_retire / error already set above).
        if pending_native:
            _decline_all_native("turn-ended")
        _flush_delta(force=True)  # emit any buffered tail before finalizing
        finished_at = time.time()
        duration = time.monotonic() - started
        final_text = "".join(text_parts).strip()
        command_output = "".join(command_parts)
        diff = "".join(diff_parts)
        output_parts = []
        if final_text:
            output_parts.append(final_text)
        if command_output:
            output_parts.append("Command output:\n" + command_output.strip())
        if diff:
            output_parts.append("Diff:\n" + diff.strip())
        if error:
            output_parts.append("Error: " + error)
        stderr_tail = self.client.stderr_tail()
        if stderr_tail:
            classified = _classify_auth_or_transport_error(stderr_tail)
            if classified and not error:
                error = classified
                output_parts.append("Error: " + classified)
            output_parts.append("codex app-server stderr tail:\n" + redact_secrets(stderr_tail))
        output = "\n\n".join(part for part in output_parts if part).strip() or "(codex app-server produced no text output)"
        return CodexAppServerTurnResult(
            thread_id=self.thread_id,
            turn_id=turn_id,
            final_text=final_text,
            output=output,
            raw_events=raw_events[-500:],
            approval_events=approvals,
            command_output=command_output,
            diff=diff,
            error=error,
            timed_out=timed_out,
            cancelled=cancelled,
            interrupted=interrupted,
            should_retire_session=should_retire,
            tool_iterations=tool_iterations,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration,
        )

    def close(self) -> None:
        self.client.close()

    def _static_accepts(self, method: str) -> bool:
        """The legacy static accept decision for an approval method, read from this
        session's ``approval_decision`` (preset/mode-derived). Used when no native
        approval broker is wired (back-compat)."""
        if method == "item/commandExecution/requestApproval":
            return self.approval_decision.accept_command
        if method == "item/fileChange/requestApproval":
            return self.approval_decision.accept_file_change
        if method == "item/permissions/requestApproval":
            return self.approval_decision.accept_permissions
        if method == "mcpServer/elicitation/request":
            return self.approval_decision.accept_mcp_tool
        return False

    def _respond_approval(self, request: dict[str, Any], accept: bool) -> str:
        """Send the per-method accept/decline response for an approval server-request
        and return the decision string. SINGLE source of the wire shapes so the static
        path and the native broker respond identically (shapes match the app-server
        protocol exactly). ``id``-less requests cannot be responded to → ``ignored``."""
        request_id = request.get("id")
        method = str(request.get("method") or "")
        if request_id is None:
            return "ignored"
        if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
            decision = "accept" if accept else "decline"
            self.client.respond(request_id, {"decision": decision})
            return decision
        if method == "item/permissions/requestApproval":
            if accept:
                self.client.respond(
                    request_id,
                    {"permissions": {"fileSystem": None, "network": {"enabled": True}}, "scope": self.approval_decision.scope},
                )
                return "accept"
            self.client.respond_error(request_id, "SuperClaw denied additional permission request")
            return "decline"
        if method == "mcpServer/elicitation/request":
            # Codex raises an elicitation to confirm an MCP (plugin) tool call. The call
            # itself is still fully governed by the SuperClaw plugin proxy (signature,
            # entitlement, revocation, runtime policy) at execution time.
            if accept:
                self.client.respond(request_id, {"action": "accept", "content": {}, "_meta": None})
                return "accept"
            self.client.respond(request_id, {"action": "decline", "content": None, "_meta": None})
            return "decline"
        self.client.respond_error(request_id, f"SuperClaw does not implement app-server request: {method}", code=-32601)
        return "unsupported"

    def _handle_server_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Static (no-broker) approval handling: decide per the preset, respond inline.
        Preserved verbatim in behavior — the native broker path (run_turn) is the
        opt-in upgrade that routes the same request through the human queue instead."""
        method = str(request.get("method") or "")
        if request.get("id") is None:
            return {"method": method, "decision": "ignored"}
        decision = self._respond_approval(request, self._static_accepts(method))
        return {"method": method, "decision": decision}

    def _interrupt(self, turn_id: str | None) -> bool:
        if not self.thread_id or not turn_id:
            return False
        try:
            self.client.request("turn/interrupt", {"threadId": self.thread_id, "turnId": turn_id}, timeout=2.0)
            return True
        except CodexAppServerError:
            return False


def check_codex_app_server_binary(executable: str) -> tuple[bool, str | None]:
    try:
        completed = subprocess.run(
            [executable, "app-server", "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=desktop_toolchain_env(),
            timeout=5,
            check=False,
        )
    except Exception as exc:
        return False, f"app-server help check failed: {exc}"
    output = ((completed.stdout or "") + (completed.stderr or "")).strip()
    if completed.returncode == 0 and "Run the app server" in output:
        version = _version(executable)
        return True, version
    return False, output[:200] or "codex app-server not supported"


def _version(executable: str) -> str | None:
    try:
        completed = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=desktop_toolchain_env(),
            timeout=5,
            check=False,
        )
    except Exception:
        return None
    return (completed.stdout or completed.stderr or "").strip()[:120] or None


def _turn_id_from_params(params: dict[str, Any]) -> str | None:
    turn = params.get("turn")
    if isinstance(turn, dict) and isinstance(turn.get("id"), str):
        return turn["id"]
    turn_id = params.get("turnId")
    return turn_id if isinstance(turn_id, str) else None


def _compact_error(error: Any) -> str | None:
    if error is None:
        return None
    if isinstance(error, str):
        return redact_secrets(error)
    try:
        return redact_secrets(json.dumps(error, ensure_ascii=False, sort_keys=True))[:2000]
    except TypeError:
        return redact_secrets(str(error))[:2000]


def _classify_auth_or_transport_error(text: str) -> str | None:
    lowered = text.lower()
    markers = (
        "sign in with chatgpt",
        "not authenticated",
        "login required",
        "oauth",
        "invalid_grant",
        "refresh token",
        "unauthorized",
        "api key required",
    )
    if any(marker in lowered for marker in markers):
        return "Codex app-server authentication failed or requires login"
    return None


def _has_turn_aborted_marker(text: str) -> bool:
    return "<turn_aborted>" in text or "<turn_aborted/>" in text


def _redact_json(value: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(redact_secrets(json.dumps(value, ensure_ascii=False)))
    except Exception:
        return {"redacted": redact_secrets(str(value))}
