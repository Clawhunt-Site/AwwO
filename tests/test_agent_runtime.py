from __future__ import annotations

import pytest

from superclaw.agent_runtime import (
    CODEX_APP_SERVER_RUNTIME_ID,
    AgentRuntimeManager,
    ClaudeRuntimeAdapter,
    CodexAppServerRuntimeAdapter,
    EventSink,
    RuntimeCapabilities,
    RuntimeCapabilityError,
    RuntimeSessionRequest,
    RuntimeTurnRequest,
    RuntimeTurnResult,
    default_runtime_manager,
    plan_streaming,
)
from superclaw.local_agent_runtime import LocalAgentRuntimeSpec


class _FakeAdapter:
    runtime_id = "fake"

    def __init__(self, caps: RuntimeCapabilities) -> None:
        self._caps = caps
        self.turns: list[str] = []

    def spec(self) -> LocalAgentRuntimeSpec:
        return LocalAgentRuntimeSpec(
            backend="fake", kind="app-server", transport="json_rpc_stdio",
            session_strategy="persistent_thread", api_mode="fake",
        )

    def capabilities(self) -> RuntimeCapabilities:
        return self._caps

    def open_session(self, request: RuntimeSessionRequest):
        return {"id": request.session_id}

    def run_turn(self, session, request: RuntimeTurnRequest, event_sink: EventSink) -> RuntimeTurnResult:
        event_sink("message.delta", {"text": request.prompt})
        self.turns.append(request.prompt)
        return RuntimeTurnResult(final_text=request.prompt)

    def close_session(self, session) -> None:
        return None

    def run_oneshot(self, request) -> RuntimeTurnResult:
        return RuntimeTurnResult(final_text=request.message, streaming=False, session_strategy="oneshot")


# --- Manager registry + default --------------------------------------------


def test_manager_resolves_default_and_named():
    manager = AgentRuntimeManager()
    fake = _FakeAdapter(RuntimeCapabilities(streaming=True, mcp_config=True))
    manager.register(fake)
    manager.default_runtime_id = "fake"
    assert manager.resolve() is fake
    assert manager.resolve("fake") is fake


def test_manager_unknown_runtime_raises():
    manager = AgentRuntimeManager()
    with pytest.raises(KeyError):
        manager.resolve("nope")


def test_default_manager_has_codex_and_claude():
    manager = default_runtime_manager()
    assert CODEX_APP_SERVER_RUNTIME_ID in manager.runtime_ids()
    assert "claude-cli" in manager.runtime_ids()
    assert manager.resolve().runtime_id == CODEX_APP_SERVER_RUNTIME_ID  # codex is default


# --- Capability negotiation: fail closed on unsupported overlay -------------


def test_overlay_requires_mcp_support_fail_closed():
    manager = AgentRuntimeManager()
    no_mcp = _FakeAdapter(RuntimeCapabilities(streaming=True, mcp_config=False))
    manager.register(no_mcp)
    # Pure turn (no overlay) is fine.
    manager.require_overlay_support(no_mcp, has_overlay=False)
    # Overlay turn on a runtime without MCP bridge must fail closed.
    with pytest.raises(RuntimeCapabilityError) as exc:
        manager.require_overlay_support(no_mcp, has_overlay=True)
    assert exc.value.code == "RUNTIME_CAPABILITY_UNSUPPORTED"
    assert exc.value.capability == "mcp_config"


def test_overlay_allowed_when_mcp_supported():
    manager = AgentRuntimeManager()
    with_mcp = _FakeAdapter(RuntimeCapabilities(streaming=True, mcp_config=True))
    manager.register(with_mcp)
    manager.require_overlay_support(with_mcp, has_overlay=True)  # no raise


def test_plan_streaming_reflects_capability():
    assert plan_streaming(_FakeAdapter(RuntimeCapabilities(streaming=True))) is True
    assert plan_streaming(_FakeAdapter(RuntimeCapabilities(streaming=False))) is False


def test_fake_adapter_turn_emits_event():
    adapter = _FakeAdapter(RuntimeCapabilities(streaming=True, mcp_config=True))
    sink_events: list[tuple[str, dict]] = []
    session = adapter.open_session(RuntimeSessionRequest(session_id="s1", repo_path="."))
    result = adapter.run_turn(
        session, RuntimeTurnRequest(prompt="hello", budget_seconds=10.0),
        lambda t, p: sink_events.append((t, p)),
    )
    assert result.final_text == "hello"
    assert ("message.delta", {"text": "hello"}) in sink_events


# --- Real adapters declare honest capabilities ------------------------------


def test_codex_adapter_declares_full_capabilities():
    caps = CodexAppServerRuntimeAdapter().capabilities()
    assert caps.streaming and caps.persistent_thread and caps.mcp_config and caps.tool_events


def test_claude_adapter_is_declared_degraded_and_fails_overlays():
    adapter = ClaudeRuntimeAdapter()
    caps = adapter.capabilities()
    assert caps.streaming is True
    assert caps.persistent_thread is False
    assert caps.mcp_config is False  # overlays must fail closed on claude in this entry
    manager = AgentRuntimeManager()
    manager.register(adapter)
    with pytest.raises(RuntimeCapabilityError):
        manager.require_overlay_support(adapter, has_overlay=True)
