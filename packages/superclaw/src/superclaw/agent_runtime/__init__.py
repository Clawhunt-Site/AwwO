"""SuperClaw local agent runtime.

This package hosts the SuperClaw-owned runtime for invoking local agents (codex,
Claude Code, bobo, ...). It is built incrementally:

- ``bus``: in-process pub/sub doorbell that replaces SQLite polling on the live
  read path (foundation, phase B).

- ``adapter``: the runtime-neutral adapter contract for the unified task entry
  (capabilities, session/turn requests, the manager, and the codex/claude
  adapters). See ``docs/unified-task-entry.md``.

Later phases add the incremental reader, the approval coordinator, and the
unified interrupt token. See ``docs/hermes-style-agent-runtime.md``.
"""

from superclaw.agent_runtime.adapter import (
    CODEX_APP_SERVER_RUNTIME_ID,
    DEFAULT_RUNTIME_ID,
    AgentRuntimeAdapter,
    AgentRuntimeManager,
    ClaudeRuntimeAdapter,
    CodexAppServerRuntimeAdapter,
    EventSink,
    RuntimeCapabilities,
    RuntimeCapabilityError,
    RuntimeOneShotRequest,
    RuntimeSessionRequest,
    RuntimeTurnRequest,
    RuntimeTurnResult,
    default_runtime_manager,
    plan_streaming,
)
from superclaw.agent_runtime.bus import EventBus, Subscription

__all__ = [
    "EventBus",
    "Subscription",
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
