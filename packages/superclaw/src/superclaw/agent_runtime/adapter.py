"""Runtime-neutral agent-runtime boundary for the unified task entry.

The unified entry runs every chat turn as ONE runtime turn against a pluggable
agent runtime. ``codex-app-server`` is the first — and currently only
full-capability — implementation; this module makes that an implementation
detail behind a runtime-neutral interface so Claude/Gemini/etc. can be added
later without leaking codex's app-server concepts into the entry.

Honesty rule (see docs/unified-task-entry.md): "runtime-neutral" is a boundary
design, not a capability fact. Each adapter declares its capabilities; the
manager negotiates and **fails closed** (``RUNTIME_CAPABILITY_UNSUPPORTED``)
rather than silently running with different semantics — especially for plugin/
skill overlays, which require a real MCP tool bridge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable

from superclaw.display_contracts import capability_tier as _display_capability_tier
from superclaw.local_agent_runtime import (
    LocalAgentRuntimeSpec,
    app_server_runtime_spec,
    cli_agent_runtime_spec,
)
from superclaw.prompt_contracts import PromptEnvelope

EventSink = Callable[[str, dict[str, Any]], None]

CODEX_APP_SERVER_RUNTIME_ID = "codex-app-server"
DEFAULT_RUNTIME_ID = CODEX_APP_SERVER_RUNTIME_ID


class RuntimeCapabilityError(RuntimeError):
    """Raised when a turn needs a capability the chosen runtime does not provide.

    Fail-closed: we never silently degrade an overlay/streaming requirement into
    a different execution semantics.
    """

    code = "RUNTIME_CAPABILITY_UNSUPPORTED"

    def __init__(self, runtime_id: str, capability: str, detail: str = "") -> None:
        self.runtime_id = runtime_id
        self.capability = capability
        message = f"runtime {runtime_id!r} does not support {capability!r}"
        if detail:
            message = f"{message}: {detail}"
        super().__init__(message)


@dataclass(frozen=True)
class RuntimeCapabilities:
    """Granular, separately-declared runtime capabilities (no one-size flag).

    The Display Protocol (docs/agent-runtime-display-protocol.md section 4) splits
    tool capability into field-level flags, so half-true states (e.g. "has tool
    input but no result") are expressible. ``tool_events`` is kept as a legacy
    alias of ``tool_lifecycle``: setting either reads back consistently on both.
    Per-adapter honest tuning of the new flags lands in PR-2 (codex) / PR-3
    (claude); PR-1 only adds the structure (no declared value changes).
    """

    streaming: bool = False
    persistent_thread: bool = False
    mcp_config: bool = False
    mcp_hot_reload: bool = False
    tool_events: bool = False  # legacy alias of tool_lifecycle (see __post_init__)
    interrupt: bool = False
    history_replay: bool = False
    approval_policy: bool = False
    usage_events: bool = False
    # Field-level display capabilities (Display Protocol section 4). Default False.
    tool_lifecycle: bool = False
    tool_input: bool = False
    tool_output: bool = False
    tool_output_delta: bool = False
    reasoning: bool = False

    def __post_init__(self) -> None:
        # Legacy alias: ``tool_events`` and ``tool_lifecycle`` mirror each other,
        # so existing callers/tests that set ``tool_events`` keep working while
        # new code uses the granular name. frozen -> object.__setattr__.
        unified = self.tool_lifecycle or self.tool_events
        object.__setattr__(self, "tool_lifecycle", unified)
        object.__setattr__(self, "tool_events", unified)

    def capability_tier(self) -> str:
        """User-visible tier (full/partial/batch) derived from the field matrix."""
        return _display_capability_tier(self)


@dataclass
class RuntimeSessionRequest:
    session_id: str
    repo_path: str
    # Generic overlay injection args (for codex these are the `-c mcp_servers…`
    # overrides). Empty == a pure native turn with no overlay.
    overlay_args: list[str] = field(default_factory=list)
    resume_thread_id: str | None = None
    sandbox: str = "read-only"


@dataclass
class RuntimeTurnRequest:
    prompt: str
    budget_seconds: float
    needs_history: bool = False
    prompt_envelope: PromptEnvelope | None = None
    projection_audit: dict[str, Any] = field(default_factory=dict)
    legacy_prompt_fallback: dict[str, Any] = field(default_factory=dict)
    # Per-turn reasoning effort / thinking level (validated by the caller against
    # the runtime's EFFORT_LEVELS). None / "" means "use the runtime default";
    # a runtime that projects effort natively (codex app-server) forwards it onto
    # turn/start, one that cannot simply ignores it.
    effort: str | None = None


@dataclass
class RuntimeOneShotRequest:
    """A single non-streaming turn (legacy /api/chat/direct). The runtime picks
    the right mechanism — for codex this is `codex exec`, not app-server."""

    message: str
    repo_path: str
    budget_seconds: float
    context_text: str = ""
    history: str = ""


@dataclass
class RuntimeTurnResult:
    final_text: str = ""
    thread_id: str | None = None
    error: str | None = None
    timed_out: bool = False
    cancelled: bool = False
    should_retire_session: bool = False
    # How the turn was actually served, so surfaces can label degraded runs.
    streaming: bool = True
    session_strategy: str = "persistent_thread"


@runtime_checkable
class AgentRuntimeAdapter(Protocol):
    runtime_id: str

    def spec(self) -> LocalAgentRuntimeSpec: ...
    def capabilities(self) -> RuntimeCapabilities: ...
    def open_session(self, request: RuntimeSessionRequest) -> Any: ...
    def run_turn(self, session: Any, request: RuntimeTurnRequest, event_sink: EventSink) -> RuntimeTurnResult: ...
    def close_session(self, session: Any) -> None: ...
    def run_oneshot(self, request: RuntimeOneShotRequest) -> RuntimeTurnResult: ...


class AgentRuntimeManager:
    """Registry + capability negotiation for runtime adapters."""

    def __init__(self, *, default_runtime_id: str = DEFAULT_RUNTIME_ID) -> None:
        self._adapters: dict[str, AgentRuntimeAdapter] = {}
        self.default_runtime_id = default_runtime_id

    def register(self, adapter: AgentRuntimeAdapter) -> None:
        self._adapters[adapter.runtime_id] = adapter

    def runtime_ids(self) -> list[str]:
        return sorted(self._adapters)

    def resolve(self, runtime_id: str | None = None) -> AgentRuntimeAdapter:
        rid = (runtime_id or self.default_runtime_id).strip() or self.default_runtime_id
        adapter = self._adapters.get(rid)
        if adapter is None:
            raise KeyError(f"unknown runtime_id: {rid!r} (known: {self.runtime_ids()})")
        return adapter

    def require_overlay_support(self, adapter: AgentRuntimeAdapter, *, has_overlay: bool) -> None:
        """Fail closed if the turn carries an overlay the runtime can't bridge."""
        if has_overlay and not adapter.capabilities().mcp_config:
            raise RuntimeCapabilityError(
                adapter.runtime_id,
                "mcp_config",
                "plugin/skill overlays require an MCP tool bridge",
            )


def plan_streaming(adapter: AgentRuntimeAdapter) -> bool:
    """True if the runtime streams; False means surfaces emit a single delta and
    label the turn ``streaming=false`` (graceful, declared degradation)."""
    return adapter.capabilities().streaming


# --- Codex app-server adapter (first, full-capability implementation) --------


class CodexAppServerRuntimeAdapter:
    """Wraps the codex app-server session/client behind the neutral interface.

    All codex-specific concepts (JSON-RPC, `-c mcp_servers…`, thread/resume) stay
    confined here; the entry only sees the neutral request/result types.
    """

    runtime_id = CODEX_APP_SERVER_RUNTIME_ID

    def __init__(self, *, executable_env: str = "SUPERCLAW_CODEX_EXECUTABLE") -> None:
        self._executable_env = executable_env

    def spec(self) -> LocalAgentRuntimeSpec:
        return app_server_runtime_spec(
            backend="codex",
            executable="codex",
            api_mode="app-server",
            supports_mcp_configs=True,
            notes=["unified-entry primary runtime"],
        )

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(
            streaming=True,
            persistent_thread=True,
            mcp_config=True,
            mcp_hot_reload=False,  # MCP servers are baked in at launch; rebuild on change
            tool_events=True,
            interrupt=True,
            history_replay=True,
            approval_policy=True,
            # Display Protocol field-level capabilities (PR-2): codex is FULL —
            # command/file/mcp lifecycle with input AND output, streamed command
            # output, and live reasoning deltas.
            tool_input=True,
            tool_output=True,
            tool_output_delta=True,
            reasoning=True,
            # Honest: codex app-server does NOT surface token usage in its turn
            # stream, so usage_events is False (PR-2). The projector never
            # fabricates a usage event for codex.
            usage_events=False,
        )

    def open_session(self, request: RuntimeSessionRequest) -> Any:
        import os

        from superclaw.codex_app_server import (
            CodexApprovalDecision,
            CodexAppServerClient,
            CodexAppServerSession,
        )
        from superclaw.runtime import find_codex_executable

        executable, _source = find_codex_executable(os.environ.get(self._executable_env))
        if not executable:
            return None
        client = CodexAppServerClient(
            executable=executable, request_timeout=25.0, extra_args=list(request.overlay_args)
        )
        return CodexAppServerSession(
            cwd=request.repo_path,
            client=client,
            sandbox=request.sandbox,
            approval_policy="never",
            approval_decision=CodexApprovalDecision(accept_mcp_tool=True),
            post_tool_quiet_timeout_seconds=40,
            resume_thread_id=request.resume_thread_id,
            ephemeral=False,
        )

    def run_turn(self, session: Any, request: RuntimeTurnRequest, event_sink: EventSink) -> RuntimeTurnResult:
        session.ensure_started()
        result = session.run_turn(
            request.prompt,
            budget_seconds=request.budget_seconds,
            on_event=event_sink,
            effort=request.effort,
        )
        return RuntimeTurnResult(
            final_text=(result.final_text or ""),
            thread_id=getattr(session, "thread_id", None),
            error=result.error,
            timed_out=result.timed_out,
            cancelled=result.cancelled,
            should_retire_session=getattr(result, "should_retire_session", False),
            streaming=True,
            session_strategy="persistent_thread",
        )

    def close_session(self, session: Any) -> None:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass

    def run_oneshot(self, request: RuntimeOneShotRequest) -> RuntimeTurnResult:
        # Non-streaming one-shot uses `codex exec` (the right tool for a single
        # turn), not app-server. This keeps the legacy /api/chat/direct on the
        # same runtime seam without spinning up a persistent thread.
        from pathlib import Path

        from superclaw.chat_turn import execute_direct_chat_turn

        result = execute_direct_chat_turn(
            content=request.message,
            backend="codex",
            repo=Path(request.repo_path),
            budget_seconds=int(request.budget_seconds),
            context_text=request.context_text,
            history=request.history,
        )
        ok = result.get("status") == "completed"
        return RuntimeTurnResult(
            final_text=str(result.get("response") or ""),
            error=None if ok else str(result.get("failure_reason") or "direct turn failed"),
            streaming=False,
            session_strategy="oneshot",
        )


# --- Claude adapter (declared-degraded; no MCP tool bridge in this entry) -----


class ClaudeRuntimeAdapter:
    """Honest degraded stub: Claude CLI streams text (``stream-json``) but has no
    persistent JSON-RPC thread and no MCP tool-event bridge equivalent in this
    entry. It therefore declares ``mcp_config=False`` so overlay turns fail closed
    instead of silently running with different semantics. Wiring the actual
    Claude stream is a follow-up; capabilities are declared now so the manager can
    negotiate truthfully."""

    runtime_id = "claude-cli"

    def spec(self) -> LocalAgentRuntimeSpec:
        return cli_agent_runtime_spec(
            backend="claude",
            executable="claude",
            api_mode="cli",
            supports_mcp_configs=True,  # CLI --mcp-config exists, but no tool-event bridge here
            notes=["degraded: streaming text only; no persistent thread or MCP tool events in unified entry"],
        )

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(
            streaming=True,
            persistent_thread=False,
            mcp_config=False,  # no tool-event bridge in this entry -> overlays fail closed
            tool_events=False,
            history_replay=True,
            approval_policy=False,
            usage_events=False,
        )

    def open_session(self, request: RuntimeSessionRequest) -> Any:
        raise RuntimeCapabilityError(self.runtime_id, "open_session", "claude streaming adapter not wired yet")

    def run_turn(self, session: Any, request: RuntimeTurnRequest, event_sink: EventSink) -> RuntimeTurnResult:
        raise RuntimeCapabilityError(self.runtime_id, "run_turn", "claude streaming adapter not wired yet")

    def close_session(self, session: Any) -> None:
        return None

    def run_oneshot(self, request: RuntimeOneShotRequest) -> RuntimeTurnResult:
        raise RuntimeCapabilityError(self.runtime_id, "run_oneshot", "claude one-shot adapter not wired yet")


def default_runtime_manager() -> AgentRuntimeManager:
    manager = AgentRuntimeManager()
    manager.register(CodexAppServerRuntimeAdapter())
    manager.register(ClaudeRuntimeAdapter())
    return manager


__all__ = [
    "EventSink",
    "CODEX_APP_SERVER_RUNTIME_ID",
    "DEFAULT_RUNTIME_ID",
    "RuntimeCapabilityError",
    "RuntimeCapabilities",
    "RuntimeSessionRequest",
    "RuntimeTurnRequest",
    "RuntimeOneShotRequest",
    "RuntimeTurnResult",
    "AgentRuntimeAdapter",
    "AgentRuntimeManager",
    "plan_streaming",
    "CodexAppServerRuntimeAdapter",
    "ClaudeRuntimeAdapter",
    "default_runtime_manager",
]
