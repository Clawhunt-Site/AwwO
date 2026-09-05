from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from superclaw.prompt_contracts import (
    DEFAULT_SYSTEM_CHANNEL,
    SYSTEM_CHANNELS,
    PromptContractError,
    SystemChannel,
)


RuntimeKind = Literal["builtin", "cli", "app-server", "api", "api-agent"]
TransportKind = Literal["in_process", "cli_subprocess", "json_rpc_stdio", "chat_completions", "anthropic_messages"]
SessionStrategy = Literal["none", "per_invocation", "persistent_thread", "provider_client"]


@dataclass(frozen=True)
class LocalAgentRuntimeSpec:
    """Normalized invocation contract for any local agent-like backend.

    Mirrors the useful split in Hermes: runtime/provider selection, transport
    shape, session boundary, and model/provider hints are described separately
    from the backend that eventually executes the turn.
    """

    backend: str
    kind: RuntimeKind
    transport: TransportKind
    session_strategy: SessionStrategy
    api_mode: str
    executable: str | None = None
    model: str | None = None
    provider: str | None = None
    source: str = "superclaw"
    supports_mcp_configs: bool = False
    supports_plugin_dirs: bool = False
    # System-channel capability (PromptEnvelope projection, roadmap §3.2). These
    # describe how finely the runtime can take a layered prompt; they default to
    # the most conservative posture (flatten-only, no native system/tool/cache
    # support) so a backend gets richer projection only by explicitly declaring
    # it. Inert until the projector PR consumes them.
    system_channel: SystemChannel = DEFAULT_SYSTEM_CHANNEL
    per_call_system: bool = False
    append_preserves_default: bool = False
    override_replaces_default: bool = False
    supports_cache_control: bool = False
    supports_tool_schema: bool = False
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # ``system_channel`` is a ``Literal`` (type hint only); validate at
        # construction so a typo cannot reach the projector as an undefined
        # channel. fail-closed: an unknown channel is a contract violation.
        if self.system_channel not in SYSTEM_CHANNELS:
            raise PromptContractError(
                f"unknown system_channel {self.system_channel!r}; "
                f"must be one of {sorted(SYSTEM_CHANNELS)}"
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def local_agent_runtime_spec(
    *,
    backend: str,
    kind: RuntimeKind,
    transport: TransportKind,
    session_strategy: SessionStrategy,
    api_mode: str,
    executable: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    supports_mcp_configs: bool = False,
    supports_plugin_dirs: bool = False,
    system_channel: SystemChannel = DEFAULT_SYSTEM_CHANNEL,
    per_call_system: bool = False,
    append_preserves_default: bool = False,
    override_replaces_default: bool = False,
    supports_cache_control: bool = False,
    supports_tool_schema: bool = False,
    notes: list[str] | None = None,
) -> LocalAgentRuntimeSpec:
    return LocalAgentRuntimeSpec(
        backend=backend,
        kind=kind,
        transport=transport,
        session_strategy=session_strategy,
        api_mode=api_mode,
        executable=executable,
        model=model,
        provider=provider,
        supports_mcp_configs=supports_mcp_configs,
        supports_plugin_dirs=supports_plugin_dirs,
        system_channel=system_channel,
        per_call_system=per_call_system,
        append_preserves_default=append_preserves_default,
        override_replaces_default=override_replaces_default,
        supports_cache_control=supports_cache_control,
        supports_tool_schema=supports_tool_schema,
        notes=list(notes or []),
    )


def cli_agent_runtime_spec(
    *,
    backend: str,
    executable: str,
    model: str | None = None,
    provider: str | None = None,
    api_mode: str = "cli",
    supports_mcp_configs: bool = False,
    supports_plugin_dirs: bool = False,
    system_channel: SystemChannel = DEFAULT_SYSTEM_CHANNEL,
    per_call_system: bool = False,
    append_preserves_default: bool = False,
    override_replaces_default: bool = False,
    supports_cache_control: bool = False,
    supports_tool_schema: bool = False,
    notes: list[str] | None = None,
) -> LocalAgentRuntimeSpec:
    return local_agent_runtime_spec(
        backend=backend,
        kind="cli",
        transport="cli_subprocess",
        session_strategy="per_invocation",
        api_mode=api_mode,
        executable=executable,
        model=model,
        provider=provider,
        supports_mcp_configs=supports_mcp_configs,
        supports_plugin_dirs=supports_plugin_dirs,
        system_channel=system_channel,
        per_call_system=per_call_system,
        append_preserves_default=append_preserves_default,
        override_replaces_default=override_replaces_default,
        supports_cache_control=supports_cache_control,
        supports_tool_schema=supports_tool_schema,
        notes=notes,
    )


def app_server_runtime_spec(
    *,
    backend: str,
    executable: str,
    api_mode: str,
    model: str | None = None,
    provider: str | None = None,
    supports_mcp_configs: bool = False,
    system_channel: SystemChannel = DEFAULT_SYSTEM_CHANNEL,
    per_call_system: bool = False,
    append_preserves_default: bool = False,
    override_replaces_default: bool = False,
    supports_cache_control: bool = False,
    supports_tool_schema: bool = False,
    notes: list[str] | None = None,
) -> LocalAgentRuntimeSpec:
    return local_agent_runtime_spec(
        backend=backend,
        kind="app-server",
        transport="json_rpc_stdio",
        session_strategy="persistent_thread",
        api_mode=api_mode,
        executable=executable,
        model=model,
        provider=provider,
        supports_mcp_configs=supports_mcp_configs,
        supports_plugin_dirs=False,
        system_channel=system_channel,
        per_call_system=per_call_system,
        append_preserves_default=append_preserves_default,
        override_replaces_default=override_replaces_default,
        supports_cache_control=supports_cache_control,
        supports_tool_schema=supports_tool_schema,
        notes=notes,
    )


def api_agent_runtime_spec(
    *,
    backend: str,
    model: str,
    provider: str,
    api_mode: str,
    transport: Literal["chat_completions", "anthropic_messages"],
    system_channel: SystemChannel = DEFAULT_SYSTEM_CHANNEL,
    per_call_system: bool = False,
    append_preserves_default: bool = False,
    override_replaces_default: bool = False,
    supports_cache_control: bool = False,
    supports_tool_schema: bool = False,
    notes: list[str] | None = None,
) -> LocalAgentRuntimeSpec:
    return local_agent_runtime_spec(
        backend=backend,
        kind="api-agent",
        transport=transport,
        session_strategy="provider_client",
        api_mode=api_mode,
        model=model,
        provider=provider,
        system_channel=system_channel,
        per_call_system=per_call_system,
        append_preserves_default=append_preserves_default,
        override_replaces_default=override_replaces_default,
        supports_cache_control=supports_cache_control,
        supports_tool_schema=supports_tool_schema,
        notes=notes,
    )
