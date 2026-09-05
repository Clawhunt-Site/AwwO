from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping

from superclaw.backends import default_backends
from superclaw.harness import HARNESS_CAPABILITIES
from superclaw.plugin_cloud import (
    ENTITLEMENTS_NAME,
    get_revocations,
    get_runtime_policy,
    list_registry_plugins,
    local_plugin_state_root,
)
from superclaw.permissions import permission_mode_contract, serialize_preset_map
from superclaw.plugin_config import CONFIG_UI_SECTIONS
from superclaw.plugin_evidence import diagnose_plugin_runtime
from superclaw.plugins import list_cached_plugins
from superclaw.runtime_config import runtime_config_payload
from superclaw.state import StateStore
from superclaw.tui_acceptance import tui_acceptance_report_path
from superclaw import team_kernel
from superclaw.display_contracts import DisplayEvent  # noqa: F401  -- re-export
from superclaw.display_contracts import ToolCall  # noqa: F401  -- re-export
from superclaw.display_contracts import build_display_contract_payload  # noqa: F401
from superclaw.appearance import appearance_payload  # noqa: F401  -- re-export
from superclaw.appearance import build_appearance_contract  # noqa: F401  -- re-export


# The owner-ratified provenance trust grades — the SINGLE definition point shared
# by the skill / plugin / company surfaces (design §10, 铁律 3). No surface
# hardcodes its own grade list; the catalog and skill-build contracts both read
# this so they can never drift. Order is least→most trusted for display.
PROVENANCE_TRUST_STATES: tuple[str, ...] = ("untrusted", "local", "developer", "official")
PROVENANCE_TRUST_COPY: dict[str, str] = {
    "official": "Official",
    "developer": "Developer signed",
    "local": "Local",
    "untrusted": "Untrusted",
}


# Goal Mode (计划模式) status machine — display copy for each lifecycle state.
# The status set + legal transitions are the SINGLE SOURCE in superclaw.models
# (GoalStatus / _ALLOWED_GOAL_STATUS_TRANSITIONS); this map only adds labels.
# CLI / API / Web must read the status list and transitions from
# build_goal_status_contract(), never hand-copy them (铁律3).
GOAL_STATUS_COPY: dict[str, str] = {
    "draft": "Draft",
    "awaiting_confirmation": "Awaiting confirmation",
    "active": "Active",
    "blocked": "Blocked",
    "budget_limited": "Budget limited",
    "complete": "Complete",
    "cancelled": "Cancelled",
    "legacy": "Legacy",
}
# Execution-phase statuses that mean "the goal is being worked" — a strict derived
# projection of the underlying issue tree (docs/goal-mode-design.md §9.1). draft /
# awaiting_confirmation are the only pre-execution standalone states.
GOAL_ACTIVE_LIKE_STATUSES: tuple[str, ...] = ("active", "blocked", "budget_limited")


def build_goal_status_contract() -> dict[str, Any]:
    """Project the Goal Mode status machine from the model (single source) into a
    UI/API contract: every status with its label, whether it is terminal, and its
    legal outgoing transitions. Surfaces render state badges + allowed actions from
    this, so the lifecycle graph can never drift between CLI / API / Web."""
    from superclaw.models import (
        GOAL_STATUSES,
        TERMINAL_GOAL_STATUSES,
        _ALLOWED_GOAL_STATUS_TRANSITIONS,
    )

    statuses = []
    for status in sorted(GOAL_STATUSES):
        transitions = sorted(
            t for t in _ALLOWED_GOAL_STATUS_TRANSITIONS.get(status, {status}) if t != status
        )
        # ``terminal`` for the UI = absorbing (no outgoing edge besides self). This
        # covers the semantic terminals (complete / cancelled) AND ``legacy`` — an
        # inert pre-Goal-Mode row — so a surface never offers an action on a goal
        # that cannot move.
        statuses.append(
            {
                "id": status,
                "label": GOAL_STATUS_COPY.get(status, status),
                "terminal": status in TERMINAL_GOAL_STATUSES or not transitions,
                "transitions": transitions,
            }
        )
    return {
        "statuses": statuses,
        "terminal": sorted(TERMINAL_GOAL_STATUSES),
        "active_like": list(GOAL_ACTIVE_LIKE_STATUSES),
    }


# Per-backend control + runtime-selector contract shared by CLI / API / Web /
# Desktop. Selector fields (consumed by the per-chat runtime dropdown):
# - label: display name
# - supports_model_selection: whether WorkerLimits.model_override is honored
#   (False => the kernel fails closed on an explicit selection; the UI must not
#   offer a model picker for that backend)
# - default_model: what runs when nothing is selected (display only)
# - suggested_models: dropdown candidates; free-form input stays allowed
# - supports_effort_selection: whether WorkerLimits.effort_override is honored —
#   the per-run reasoning-effort / thinking-level control (False => the kernel
#   fails closed on an explicit effort; the UI must not offer an effort picker).
#   Mirrors the backend's runtime-side ``supports_effort`` flag (drift test).
# - effort_levels: this runtime's OWN native levels — NOT a unified vocabulary
#   (codex: low/medium/high/xhigh; claude: low/medium/high/xhigh/max;
#   opencode: provider-specific suggestions). [] when effort is unsupported
#   (e.g. grok — its CLI flag exists but no Grok model reliably honors it).
# - effort_input_mode: "select" => effort_levels is the authoritative enum (UI
#   renders a constrained dropdown; backend validates and hard-fails an invalid
#   level). "text" => effort_levels are SUGGESTIONS and free-form input is allowed
#   (opencode's provider-specific --variant). None when effort is unsupported.
# - default_effort: shown when nothing is selected (DISPLAY ONLY). A surface MUST
#   NOT backfill it as an explicit request — that would turn "inherit" into an
#   explicit effort and (on an unsupported backend) trip the fail-closed guard.
# - chat_capable: can serve the STREAMING direct-chat path with native thread
#   memory (codex app-server today). Every registered backend can answer plain
#   chat turns over the kernel's one-shot direct-chat channel regardless.
# - chat_tier: the backend's RUNTIME SHAPE for the unified chat entry (chat =
#   a native agent-runtime session; see docs/unified-task-entry.md):
#     "native"      — native persistent session + streaming wired end-to-end
#     "upgradeable" — the runtime exposes native session + streaming (CLI
#                     resume/stream flags) but SuperClaw has not wired them yet;
#                     chat works over the one-shot channel meanwhile
#     "oneshot"     — a one-shot exec/API form with no native session; not a
#                     chat substrate by design (delivery/runs only)
#     "infra"       — plumbing/infrastructure (relay, gateway, test worker);
#                     hidden from the default chat selector
AGENT_CONTROL_SPECS: dict[str, dict[str, Any]] = {
    "local": {
        "chat_tier": "infra",
        "kind": "builtin",
        "label": "Local builtin",
        "strengths": "Deterministic built-in worker for plumbing, tests, and dry runs; no model reasoning.",
        "configure": "built-in Python worker; no external agent config required",
        "supports_model_selection": False,
        "suggested_models": [],
    },
    "codex": {
        "chat_tier": "oneshot",
        "kind": "cli",
        "label": "Codex CLI",
        # Static default; the codex backend REFINES this at runtime via
        # resolve_discovery_reachability(): discovery is the app-server model/list,
        # faithful only when the binary is BOTH exec-capable AND its app-server
        # answers (exec != app-server-ready) — a legacy codex or a broken app-server
        # resolves to cross_plane so the probe degrades to presence, not a false fail.
        "discovery_reachability": "faithful",
        "strengths": "Strong autonomous coding and multi-file refactors via codex exec; single agent (no native sub-spawn).",
        "harness": "codex",
        "env": "SUPERCLAW_CODEX_EXECUTABLE",
        "model_env": "SUPERCLAW_CODEX_MODEL",
        "configure": "/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
        "supports_effort_selection": True,
        "effort_levels": ["low", "medium", "high", "xhigh"],
        "effort_input_mode": "select",
        "default_effort": None,
    },
    "codex-app-server": {
        "chat_tier": "native",
        "kind": "app-server",
        "label": "Codex App Server",
        # discovery lists models via the backend's OWN codex CLI (its run plane).
        "discovery_reachability": "faithful",
        "strengths": "Codex over a persistent streaming session — best for interactive chat with live tool streaming.",
        "harness": "codex",
        "env": "SUPERCLAW_CODEX_EXECUTABLE",
        "model_env": "SUPERCLAW_CODEX_MODEL",
        "configure": "/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
        "supports_effort_selection": True,
        "effort_levels": ["low", "medium", "high", "xhigh"],
        "effort_input_mode": "select",
        "default_effort": None,
        "chat_capable": True,
    },
    "claude": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "Claude Code",
        "strengths": "Broad reasoning, long-context planning, and native sub-agent spawning (Task tool).",
        "harness": "claude-code",
        "env": "SUPERCLAW_CLAUDE_EXECUTABLE",
        "model_env": "SUPERCLAW_CLAUDE_MODEL",
        "configure": "/config set SUPERCLAW_CLAUDE_EXECUTABLE /path/to/claude",
        "supports_model_selection": True,
        "default_model": "claude-opus-4-8",
        "suggested_models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
        "supports_effort_selection": True,
        "effort_levels": ["low", "medium", "high", "xhigh", "max"],
        "effort_input_mode": "select",
        "default_effort": None,
        # discovery_reachability (single-source faithfulness of the model-discovery
        # channel vs the actual RUN plane; read by
        # runtime_probe._discovery_reflects_reachability):
        #   "cross_plane" — the Claude CLI runs off its OWN login/session and exposes
        #   no model-listing command, so discovery falls back to the Anthropic API
        #   plane (a different credential the run lane does not use). A model-list
        #   result/auth-error there is NOT the run lane's reachability, so the probe
        #   reports presence only. Any future self-contained-CLI-login backend
        #   (e.g. an OAuth-session CLI) declares the same value.
        "discovery_reachability": "cross_plane",
    },
    "opencode": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "OpenCode",
        # discovery lists models via the backend's OWN `opencode models` CLI.
        "discovery_reachability": "faithful",
        "strengths": "Open multi-provider coding agent with per-agent tool allowlists and sub-task spawning.",
        "harness": "opencode",
        "env": "SUPERCLAW_OPENCODE_EXECUTABLE",
        "model_env": "SUPERCLAW_OPENCODE_MODEL",
        "configure": "/config set SUPERCLAW_OPENCODE_EXECUTABLE /path/to/opencode",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6"],
        "supports_effort_selection": True,
        # provider-specific `--variant` — suggestions, not a closed enum (text mode)
        "effort_levels": ["minimal", "low", "medium", "high", "max"],
        "effort_input_mode": "text",
        "default_effort": None,
    },
    "grok": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "Grok CLI",
        # discovery lists models via the backend's OWN `grok models` CLI.
        "discovery_reachability": "faithful",
        "strengths": "Fast iteration with live web/X search grounding.",
        "env": "SUPERCLAW_GROK_EXECUTABLE",
        "model_env": "SUPERCLAW_GROK_MODEL",
        "configure": "/config set SUPERCLAW_GROK_EXECUTABLE /path/to/grok",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["grok-4-fast", "grok-4"],
        # No effort axis: the grok CLI has an --effort flag, but Grok's model-level
        # reasoning_effort support is narrow and model-specific (grok-4 rejects it
        # outright; grok-3-mini is low/high only; grok-4-fast/4.3 are
        # none/low/medium/high) — there is no claude-style unified ladder to expose.
        # GrokCliBackend.supports_effort is False and the kernel fail-closes on an
        # explicit effort — so don't advertise the control.
        "supports_effort_selection": False,
    },
    "cursor": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "Cursor Agent",
        # discovery lists models via the backend's OWN `cursor-agent models` CLI.
        "discovery_reachability": "faithful",
        "strengths": "Repo-wide IDE-grounded edits; reads Claude-style skill/agent assets.",
        "harness": "cursor",
        "env": "SUPERCLAW_CURSOR_EXECUTABLE",
        "model_env": "SUPERCLAW_CURSOR_MODEL",
        "configure": "/config set SUPERCLAW_CURSOR_EXECUTABLE /path/to/cursor-agent",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["sonnet-4.6", "gpt-5.2"],
    },
    "hermes": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "Hermes",
        "strengths": "Lightweight one-shot coding through a configurable provider.",
        "env": "SUPERCLAW_HERMES_EXECUTABLE",
        "model_env": "SUPERCLAW_HERMES_MODEL",
        "configure": "/config set SUPERCLAW_HERMES_EXECUTABLE /path/to/hermes",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6"],
    },
    "openclaw": {
        "chat_tier": "upgradeable",
        "kind": "cli",
        "label": "OpenClaw CLI",
        "strengths": "Local Claude-compatible CLI runtime.",
        "env": "SUPERCLAW_OPENCLAW_EXECUTABLE",
        "model_env": "SUPERCLAW_OPENCLAW_MODEL",
        "configure": "/config set SUPERCLAW_OPENCLAW_EXECUTABLE /path/to/openclaw",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": [],
    },
    "openclaw-gateway": {
        "chat_tier": "infra",
        "kind": "gateway",
        "label": "OpenClaw Gateway",
        "strengths": "Remote OpenClaw over a gateway; the gateway-side agent owns its model.",
        "env": "SUPERCLAW_OPENCLAW_GATEWAY_URL",
        "model_env": "",
        "configure": "/config set SUPERCLAW_OPENCLAW_GATEWAY_URL ws://127.0.0.1:18789 and /config set SUPERCLAW_OPENCLAW_GATEWAY_TOKEN <token>",
        "supports_model_selection": False,  # the gateway-side agent owns its model; kernel fails closed
        "suggested_models": [],
    },
    "http": {
        "chat_tier": "infra",
        "kind": "http",
        "label": "HTTP endpoint",
        # "cross_plane": discovery probes the sibling /v1/models route, but the run
        # plane POSTs to the configured SUPERCLAW_HTTP_URL chat endpoint — a
        # different route that can be up/down independently. So a model list there
        # is not run-endpoint reachability; the probe reports presence only.
        "discovery_reachability": "cross_plane",
        "strengths": "Bring-your-own HTTP runtime endpoint.",
        "env": "SUPERCLAW_HTTP_URL",
        "model_env": "SUPERCLAW_HTTP_MODEL",
        "configure": "/config set SUPERCLAW_HTTP_URL https://your-runtime.example.com/run",
        "supports_model_selection": True,  # forwarded in the request body; the endpoint owns honoring it
        "default_model": "configured-default",
        "suggested_models": [],
    },
    "clawwork": {
        "chat_tier": "infra",
        "kind": "cli",
        "label": "ClawWork (relay)",
        # "synthetic": discovery returns the relay's fail-safe package floor
        # (relay_packages() always yields a non-empty core/plus/max list even when
        # the relay is unreachable or the login is stale), so a non-empty list is
        # never reachability proof; the probe reports presence only.
        "discovery_reachability": "synthetic",
        "strengths": "Relay-backed ClawWork delivery harness (experimental).",
        "env": "SUPERCLAW_CLAWWORK_EXECUTABLE",
        "model_env": "SUPERCLAW_CLAWWORK_MODEL",
        "configure": "build the bundled harness (scripts/build-clawwork.sh). The relay endpoint is resolved per-environment from APP_ENV by default — only `/config set SUPERCLAW_RELAY_BASE_URL <relay-url>` to point at a custom relay. The governance ext + executable are auto-discovered from third_party/clawwork; override with SUPERCLAW_CLAWWORK_GOVERNANCE_EXT / _EXECUTABLE only if needed.",
        "supports_model_selection": True,  # relay model via --model; provider is clawrelay
        # Display-only default (ui_contracts §default_model): MUST match what run()
        # actually executes when nothing is selected — the base relay tier
        # (relay_packages.SUPERCLAW_BRIDGE_TIERS[0] = "core"). The relay-package
        # selector shows packages by id (core/plus/max) and uses this as the
        # empty-option label, so "core" keeps display == execution (零漂移, 铁律 2).
        # A test pins this to the kernel constant so the two never drift.
        "default_model": "core",
        "suggested_models": [],
        # Selects a SuperClaw package (套餐) from the relay's super groups, not a
        # raw model id; surfaces render the package selector (GET /api/relay/packages).
        "uses_relay_packages": True,
        "maturity": "experimental",
    },
    "bobo": {
        "chat_tier": "oneshot",
        "kind": "cli",
        "label": "Bobo",
        "strengths": "Experimental one-shot coding CLI.",
        "env": "SUPERCLAW_BOBO_EXECUTABLE",
        "model_env": "SUPERCLAW_BOBO_MODEL",
        "configure": "/config set SUPERCLAW_BOBO_EXECUTABLE /path/to/bobo",
        "supports_model_selection": True,
        "default_model": "configured-default",
        "suggested_models": [],
    },
    "gemini": {
        "chat_tier": "oneshot",
        "kind": "api-agent",
        "label": "Gemini Agent",
        # discovery lists models via the SAME API key the agent loop runs on.
        "discovery_reachability": "faithful",
        "strengths": "Long-context multimodal reasoning with Google-grounded search.",
        # No harness mapping: this backend is the Anthropic/OpenAI-compatible API
        # agent loop (GeminiAgentBackend), NOT the Gemini CLI, so the CLI's
        # task_spawn capability does not apply — task_spawn stays null (honest).
        "env": "SUPERCLAW_GEMINI_API_KEY",
        "model_env": "SUPERCLAW_GEMINI_MODEL",
        "configure": "/config set SUPERCLAW_GEMINI_API_KEY <key> or export GEMINI_API_KEY",
        "supports_model_selection": True,
        "default_model": "gemini-2.5-flash",
        "suggested_models": ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    "anthropic": {
        "chat_tier": "infra",
        "kind": "api",
        "label": "Anthropic API",
        # discovery lists models via the SAME API key the backend runs on.
        "discovery_reachability": "faithful",
        "strengths": "Direct Anthropic API completions (plumbing/infra).",
        "env": "ANTHROPIC_API_KEY",
        "model_env": "SUPERCLAW_ANTHROPIC_MODEL",
        "configure": "export ANTHROPIC_API_KEY=... before starting superclaw",
        "supports_model_selection": True,
        "default_model": "claude-opus-4-8",
        "suggested_models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    },
    "anthropic-agent": {
        "chat_tier": "oneshot",
        "kind": "api-agent",
        "label": "Anthropic Agent",
        # discovery lists models via the SAME API key the agent loop runs on.
        "discovery_reachability": "faithful",
        "strengths": "Anthropic API agent loop with native tool use.",
        "env": "ANTHROPIC_API_KEY",
        "model_env": "SUPERCLAW_ANTHROPIC_AGENT_MODEL",
        # The backend resolves model_override -> SUPERCLAW_ANTHROPIC_AGENT_MODEL ->
        # SUPERCLAW_ANTHROPIC_MODEL -> claude-opus-4-8 (backends.AnthropicAgentBackend).
        # Declare the SECONDARY env so model_state reflects the real fallback: a
        # surface that only read the primary env would show the baked default
        # (opus) even when SUPERCLAW_ANTHROPIC_MODEL is the model actually running.
        # Order MUST mirror the backend's resolution order (pinned by a test).
        "model_env_fallbacks": ["SUPERCLAW_ANTHROPIC_MODEL"],
        "configure": "export ANTHROPIC_API_KEY=... before starting superclaw",
        "supports_model_selection": True,
        "default_model": "claude-opus-4-8",
        "suggested_models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    },
}

DESKTOP_DEPENDENCY_SPECS: tuple[dict[str, str], ...] = (
    {
        "name": "codex",
        "label": "Codex",
        "fallback": "Install Codex CLI or set SUPERCLAW_CODEX_EXECUTABLE to the local codex binary.",
    },
    {
        "name": "hermes",
        "label": "Hermes",
        "fallback": "Install Hermes CLI or set SUPERCLAW_HERMES_EXECUTABLE to the local hermes binary.",
    },
    {
        "name": "claude",
        "label": "Claude Code",
        "fallback": "Install Claude Code or set SUPERCLAW_CLAUDE_EXECUTABLE to the local claude binary.",
    },
    {
        "name": "openclaw",
        "label": "OpenClaw",
        "fallback": "Install OpenClaw or set SUPERCLAW_OPENCLAW_EXECUTABLE to the local openclaw binary.",
    },
)


def build_agent_inventory(
    *,
    backends: Mapping[str, Any] | None = None,
    config_payload: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    config_payload = config_payload or runtime_config_payload()
    config_entries = {entry["name"]: entry for entry in config_payload["entries"]}
    items: list[dict[str, Any]] = []
    resolved_backends = backends if backends is not None else default_backends()
    for backend in resolved_backends.values():
        raw_availability = backend.available()
        if hasattr(raw_availability, "to_dict"):
            availability = raw_availability.to_dict()
        else:
            availability = {
                "name": getattr(raw_availability, "name", ""),
                "available": bool(getattr(raw_availability, "available", False)),
                "executable": getattr(raw_availability, "executable", None),
                "version": getattr(raw_availability, "version", None),
                "reason": getattr(raw_availability, "reason", None),
            }
        spec = AGENT_CONTROL_SPECS.get(str(availability["name"]), {})
        env_name = spec.get("env")
        model_env = spec.get("model_env")
        availability["kind"] = spec.get("kind", "backend")
        availability["configure"] = spec.get("configure", "configure the backend before starting superclaw")
        availability["config_env"] = env_name
        availability["model_env"] = model_env
        # Runtime-selector contract: surfaces render the per-chat backend/model
        # dropdown from these fields instead of hardcoding their own lists.
        availability["label"] = spec.get("label") or str(availability["name"])
        availability["supports_model_selection"] = bool(spec.get("supports_model_selection", False))
        availability["default_model"] = spec.get("default_model")
        availability["suggested_models"] = list(spec.get("suggested_models") or [])
        # Per-run reasoning-effort / thinking-level selector contract (parallel to
        # the model selector). Surfaces render the effort picker ONLY when
        # supports_effort_selection is True, using effort_levels + effort_input_mode
        # ("select" = constrained dropdown, "text" = free combo with suggestions).
        # default_effort is display-only and must never be backfilled as a request.
        availability["supports_effort_selection"] = bool(spec.get("supports_effort_selection", False))
        availability["effort_levels"] = list(spec.get("effort_levels") or [])
        availability["effort_input_mode"] = spec.get("effort_input_mode")
        availability["default_effort"] = spec.get("default_effort")
        # Relay-backed runtimes select a SuperClaw package (套餐: core/plus/max…)
        # exposed by the relay's super groups, NOT raw model ids. Surfaces read
        # this flag (contract, never a hardcoded backend name) to render the
        # package selector from GET /api/relay/packages instead of the model
        # dropdown. The selected package id is the model override; the kernel
        # translates it to the hidden group slug at run time.
        availability["uses_relay_packages"] = bool(spec.get("uses_relay_packages", False))
        availability["chat_capable"] = bool(spec.get("chat_capable", False))
        availability["chat_tier"] = spec.get("chat_tier", "oneshot")
        # Maturity badge (e.g. "experimental") so surfaces can flag a backend
        # that is wired but not yet a default-path recommendation.
        availability["maturity"] = spec.get("maturity", "stable")
        # Cross-runtime delegation (roadmap §6, P0): a short declarative strengths
        # hint the orchestrator model reads to self-select a delegation target —
        # a judgment hint, NOT a routing rule.
        availability["strengths"] = spec.get("strengths", "")
        # Fold the harness sub-spawn / parallelism bits into the inventory so a
        # SURFACE consults one projected descriptor instead of also reading
        # HARNESS_CAPABILITIES directly (HARNESS_CAPABILITIES stays the
        # harness-native source; the inventory is its surface/CLI projection). A
        # backend whose runtime maps to a known harness reports real booleans;
        # one without a mapping reports null (unknown), never a fabricated False.
        harness_id = spec.get("harness")
        capability = HARNESS_CAPABILITIES.get(harness_id) if harness_id else None
        availability["harness"] = harness_id
        availability["task_spawn"] = bool(capability.task_spawn) if capability else None
        availability["parallel_agents"] = (
            bool(capability.parallel_agents) if capability else None
        )
        if env_name:
            env_entry = config_entries.get(str(env_name))
            availability["config_state"] = env_entry.get("display_value") if env_entry else "unset"
            availability["config_source"] = env_entry.get("source") if env_entry else "default"
        else:
            availability["config_state"] = "built-in"
            availability["config_source"] = "runtime"
        if model_env:
            # Resolve model_state across the backend's full env fallback chain
            # (primary model_env, then model_env_fallbacks in order), so the
            # surfaced state matches the model the backend actually runs. Walk the
            # chain and take the first env that is EXPLICITLY configured (env or
            # persisted); if none is, fall back to the primary entry whose
            # display_value is the baked default. For single-env backends (no
            # fallbacks) this is identical to the previous primary-only lookup.
            model_chain = [str(model_env), *(str(env) for env in spec.get("model_env_fallbacks") or [])]
            resolved_entry = next(
                (
                    config_entries[env]
                    for env in model_chain
                    if config_entries.get(env) and config_entries[env].get("configured")
                ),
                None,
            )
            if resolved_entry is None:
                resolved_entry = config_entries.get(str(model_env))
            availability["model_state"] = resolved_entry.get("display_value") if resolved_entry else "unset"
            availability["model_source"] = resolved_entry.get("source") if resolved_entry else "default"
        # Per-backend permission preset mapping (ask/allow -> native runtime mode),
        # including the honest `interactive` bit so surfaces never imply a headless
        # backend prompts at runtime. Called unconditionally: a backend that fails
        # to declare its mapping must fail fast here, not be silently omitted.
        # See docs/permission-mode-framework.md.
        availability["permission_presets"] = serialize_preset_map(backend.permission_presets())
        items.append(availability)
    return items


def build_permission_mode_contract() -> dict[str, Any]:
    """The two-preset contract shared by CLI / API / Web / Desktop."""
    return permission_mode_contract()


def build_agent_summary(items: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "count": len(items),
        "ready_count": sum(1 for item in items if item.get("available")),
    }


def build_clawhunt_auth_payload(
    *,
    base_url: str,
    agent_api_key_configured: bool,
    account_configured: bool = False,
    account_user: dict[str, Any] | None = None,
    agent_key_source: str | None = None,
    agent_key_name: str | None = None,
    account_source: str | None = None,
    login_source: str | None = None,
) -> dict[str, Any]:
    return {
        "clawhunt": {
            "account": "set" if account_configured else "unset",
            "agent_api_key": "set" if agent_api_key_configured else "unset",
            "base_url": base_url,
            "account_user": account_user,
            "agent_key_source": agent_key_source,
            "agent_key_name": agent_key_name,
            "account_source": account_source,
            "login_source": login_source,
            "browser_login_start_url": "/api/auth/clawhunt/browser/start",
            "account_login_url": "/api/auth/clawhunt/account/login",
            "account_login_probe_url": "/api/auth/clawhunt/account/login-probe",
            "account_profile_url": "/api/auth/clawhunt/account/me",
            "account_agents_url": "/api/auth/clawhunt/account/agents",
            "agent_key_create_url": "/api/auth/clawhunt/agent-key",
            "profile_url": "/api/auth/clawhunt/me",
            "login_url": "/api/auth/clawhunt/login",
            "logout_url": "/api/auth/clawhunt/logout",
        }
    }


def build_plugin_status_payload(
    *,
    cache_root: Path,
    cloud_root: Path,
    developer_submission_root: Path,
    clawhunt_ingestion_root: Path,
) -> dict[str, Any]:
    cached = list_cached_plugins(cache_root=cache_root)
    # Same call-time resolver the gate and cloud-sync use, so the entitlement
    # status this surface shows matches the directory the kernel actually reads.
    local_state_root = local_plugin_state_root()
    registry_count = 0
    revocation_count = 0
    policy_count = 0
    registry_error = None
    revocation_error = None
    policy_error = None
    entitlement_status = _build_local_entitlement_status(local_state_root)
    revocations: list[dict[str, Any]] = []
    policies: list[dict[str, Any]] = []
    try:
        registry_count = len(list_registry_plugins(cloud_root))
    except Exception as exc:  # pragma: no cover - defensive status surface
        registry_error = str(exc)
    try:
        revocations = _sanitize_local_revocations(get_revocations(cloud_root).get("revoked", []))
        revocation_count = len(revocations)
    except Exception as exc:  # pragma: no cover - defensive status surface
        revocation_error = str(exc)
    try:
        policies = _sanitize_runtime_policies(get_runtime_policy(cloud_root).get("policies", []))
        policy_count = len(policies)
    except Exception as exc:  # pragma: no cover - defensive status surface
        policy_error = str(exc)
    return {
        "cache_root": str(cache_root),
        "cloud_root": str(cloud_root),
        "developer_submission_root": str(developer_submission_root),
        "clawhunt_ingestion_root": str(clawhunt_ingestion_root),
        "plugin_count": len(cached),
        "plugins": cached,
        "verification": {
            "public_key_configured": bool(os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY")),
            "install_url": "/api/plugins/install",
            "uninstall_url": "/api/plugins/uninstall",
            "local_install_url": "/api/plugins/install-local",
        },
        "registry": {
            "count": registry_count,
            "status_url": "/v1/plugins",
            "error": registry_error,
        },
        "governance": {
            "revocation_count": revocation_count,
            "policy_count": policy_count,
            "revocations_url": "/v1/plugins/revocations",
            "policy_url": "/v1/policies/runtime",
            "revocation_error": revocation_error,
            "policy_error": policy_error,
            "revocations": revocations,
            "policies": policies,
        },
        "configuration": {
            "status_url": "/api/plugins/{plugin_id}/configuration",
            "setting_url": "/api/plugins/config/set",
            "secret_url": "/api/plugins/secret/set",
            "secret_delete_url": "/api/plugins/secret/delete",
            # Canonical two-tier exposure contract shared by every surface. A
            # setting/secret declares its tier via `ui.section` (legacy
            # `ui.advanced: true` == "advanced"); basic items are ordered into
            # steps via `ui.step` and labelled with `ui.step_title` /
            # `ui.step_description`. Surfaces render "basic" as up-front,
            # step-by-step required operations and collapse "advanced" behind a
            # disclosure. See superclaw.plugin_config.CONFIG_UI_SECTIONS.
            "tiers": {
                # Derived from the canonical set (single source of truth) but
                # ordered basic-first — the order surfaces render — not alphabetical.
                "sections": ["basic", *sorted(CONFIG_UI_SECTIONS - {"basic"})],
                "default_section": "basic",
                "ui_keys": ["section", "step", "step_title", "step_description"],
            },
        },
        "entitlements": entitlement_status,
        "diagnostics": {
            "status_url": "/api/plugins/diagnostics",
            "events_url": "/api/plugins/diagnostics/events",
        },
    }


def _build_local_entitlement_status(local_state_root: Path) -> dict[str, Any]:
    entitlement_file = local_state_root / ENTITLEMENTS_NAME
    payload = {"entitlements": []}
    error = None
    if entitlement_file.exists():
        try:
            payload = json.loads(entitlement_file.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                payload = {"entitlements": []}
        except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover - defensive status surface
            error = str(exc)
            payload = {"entitlements": []}
    entitlements = [
        _sanitize_local_entitlement(item)
        for item in (payload.get("entitlements") or [])
        if isinstance(item, dict)
    ]
    return {
        "file": str(entitlement_file),
        "count": len(entitlements),
        "plugin_count": len({str(item.get("plugin_id") or "") for item in entitlements if item.get("plugin_id")}),
        "status_url": "/v1/entitlements/sync",
        "error": error,
        "entries": entitlements,
    }


def _sanitize_local_entitlement(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "plugin_id": item.get("plugin_id"),
        "version": item.get("version"),
        "version_range": item.get("version_range"),
        "subject": item.get("subject"),
        "device_id": item.get("device_id"),
        "runtime_version": item.get("runtime_version"),
        "entitlement_id": item.get("entitlement_id"),
        "expires_at": item.get("expires_at"),
        "synced_at": item.get("synced_at"),
        "offline_grace_expires_at": item.get("offline_grace_expires_at"),
        "offline_grace_disabled_reason": item.get("offline_grace_disabled_reason"),
    }


def _sanitize_local_revocations(items: list[Any]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        sanitized.append(
            {
                "plugin_id": item.get("plugin_id"),
                "version": item.get("version"),
                "package_digest": item.get("package_digest"),
                "reason": item.get("reason"),
            }
        )
    return sanitized


def _sanitize_runtime_policies(items: list[Any]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        secret_descriptors = []
        for descriptor in list(item.get("secret_descriptors") or []):
            if not isinstance(descriptor, Mapping):
                continue
            secret_descriptors.append(
                {
                    "name": descriptor.get("name"),
                    "required": bool(descriptor.get("required", False)),
                }
            )
        sanitized.append(
            {
                "plugin_id": item.get("plugin_id"),
                "version": item.get("version"),
                "max_model_output_bytes": item.get("max_model_output_bytes"),
                "max_tool_timeout_ms": item.get("max_tool_timeout_ms"),
                "denylisted_permissions": list(item.get("denylisted_permissions") or []),
                "minimum_runtime_version": item.get("minimum_runtime_version"),
                "risk_level": item.get("risk_level"),
                "requires_live_metering": bool(item.get("requires_live_metering", False)),
                "secret_descriptors": secret_descriptors,
            }
        )
    return sanitized


def build_plugin_diagnostics_payload(*, artifact_dir: Path) -> dict[str, Any]:
    payload = diagnose_plugin_runtime(artifact_dir)
    payload["artifact_dir"] = artifact_dir.as_posix()
    payload["status_url"] = "/api/plugins/diagnostics"
    payload["events_url"] = "/api/plugins/diagnostics/events"
    return payload


def build_skill_sync_contract() -> dict[str, Any]:
    """The shared skill-sync capability contract: the runtime targets and the
    operation surface every client renders, sourced from the one definition in
    ``skill_sync.RUNTIME_TARGETS`` so a surface can never hardcode a list that
    diverges from the CLI/core.
    """
    from superclaw.skill_sync import RUNTIME_TARGETS, default_projection_lock

    return {
        "capability": "skill-sync",
        "description": "Project governed SuperClaw skills into native agent-runtime skill directories.",
        "tier": "proxy-discovery",
        "governed": True,
        "targets": [
            {
                "name": target.name,
                "env_var": target.env_var,
                "default_subdir": target.default_subdir.as_posix(),
            }
            for target in RUNTIME_TARGETS.values()
        ],
        "projection_lock": str(default_projection_lock()),
        "operations": {
            "list": {"method": "GET", "url": "/api/plugins/skills/projections"},
            "sync": {"method": "POST", "url": "/api/plugins/skills/sync"},
            "unsync": {"method": "POST", "url": "/api/plugins/skills/unsync"},
        },
    }


def build_skill_build_contract() -> dict[str, Any]:
    """Shared `skill build` capability contract for all user-facing surfaces.

    The single definition point (铁律 3) for the "build a SKILL.md into an
    equippable governed skill" action — its endpoint, request fields, and the
    provenance-grade vocabulary the badge renders. Surfaces (Web/Desktop) read
    this instead of hardcoding the endpoint or the grade list, so they cannot
    drift from the CLI/kernel. The kernel derives the grade; a surface NEVER
    upgrades it (no client-side trust logic, §2.3).
    """
    return {
        "capability": "skill-build",
        "schema_version": "0.1.0",
        "description": (
            "Build a local SKILL.md into a governed, equippable skill-origin plugin. "
            "A local-origin skill is equippable sign-free and graded `local`; signing "
            "is optional and never upgrades the grade."
        ),
        "governed": True,
        "operation": {"method": "POST", "url": "/v1/skills/build"},
        "request_fields": [
            "path",
            "plugin_id",
            "version",
            "developer_id",
            "sign",
            "signing_private_key",
            "force",
        ],
        "result_fields": [
            "plugin_id",
            "version",
            "package_digest",
            "trust_state",
            "equippable",
            "signed",
            "warnings",
        ],
        # The provenance grade a built skill can derive to (the kernel decides;
        # a built local skill is `local`). Shared vocabulary, never re-listed.
        "trust_states": list(PROVENANCE_TRUST_STATES),
        "trust_copy": dict(PROVENANCE_TRUST_COPY),
        "default_trust_state": "local",
        "equip_via": "skill_allowlist",
    }


def build_run_ledger_contract() -> dict[str, Any]:
    """Shared issue-run-ledger contract: the normalized run-state vocabulary +
    per-status tone, so every surface renders the same "what happened to this
    issue" view without re-deriving status from raw wakeup details (铁律 3).

    Tone vocabulary reuses the existing status-pill tones: good / bad / warn /
    live / neutral. The separate ``active`` flag drives the "working" indicator.
    """
    from superclaw.run_ledger import ACTIVE_LEDGER_STATUSES, LEDGER_STATUSES

    # Tone vocabulary reuses the existing status-pill tones (good/bad/warn/live/
    # neutral) so no new CSS class is needed; ``active`` is a separate boolean flag.
    tone_by_status = {
        "queued": "live",
        "running": "live",
        "waiting": "warn",
        "succeeded": "good",
        "failed": "bad",
        "timed_out": "bad",
        "no_response": "warn",
        "deferred": "warn",
        "reclaimed": "warn",
        "skipped": "neutral",
        "idle": "neutral",
    }
    return {
        "capability": "issue-run-ledger",
        "schema_version": "0.1.0",
        "url_template": "/api/team/issues/{issue_id}/runs",
        "statuses": [
            {
                "value": status,
                "tone": tone_by_status.get(status, "neutral"),
                "active": status in ACTIVE_LEDGER_STATUSES,
            }
            for status in LEDGER_STATUSES
        ],
        "kinds": ["work", "respond", "comment", "other"],
    }


def build_catalog_contract_payload() -> dict[str, Any]:
    """Shared Capability Workshop catalog contract for all user-facing surfaces."""
    item_fields = [
        "kind",
        "plugin_id",
        "version",
        "name",
        "summary",
        "description",
        "trust",
        "trust_reasons",
        "signer_class",
        "namespace_reserved",
        "install_state",
        "entitlement_state",
        "revoked",
        "sources",
        "instantiable",
    ]
    return {
        "capability": "capability-catalog",
        "schema_version": "0.1.0",
        "status_url": "/v1/catalog",
        "refresh_url": "/v1/catalog/refresh",
        "trust_state_url_template": "/v1/catalog/trust/{plugin_id}/{version}",
        "legacy_views": {
            "plugins_url": "/v1/plugins",
            "skills_url": "/v1/skills",
        },
        "kinds": ["plugin", "skill", "company"],
        # Most→least trusted for the catalog display, sourced from the single
        # PROVENANCE_TRUST_STATES definition so the skill/plugin/company surfaces
        # can never drift on the grade vocabulary (design §10).
        "trust_states": list(reversed(PROVENANCE_TRUST_STATES)),
        "signer_classes": ["root", "developer", "local_dev", "explicit", "none"],
        "item_fields": item_fields,
        "plugin_view_backfill_fields": [
            "catalog_kind",
            "trust",
            "trust_reasons",
            "signer_class",
            "namespace_reserved",
            "install_state",
            "entitlement_state",
            "revoked",
            "sources",
            "instantiable",
        ],
        "conflict_reasons": [
            {
                "id": "same_id_different_signer",
                "severity": "error",
                "blocks_install": True,
            },
            {
                "id": "namespace_hijack",
                "severity": "error",
                "blocks_install": True,
            },
            {
                "id": "revoked",
                "severity": "error",
                "blocks_install": True,
            },
        ],
        "install_blocking": {
            "untrusted": True,
            "revoked": True,
            "namespace_hijack": True,
        },
        # `instantiable` is a single shared field with a per-kind verb (design Q1):
        # - plugin/skill: "may be installed".
        # - company: "may be OFFERED to proposal-mode bootstrap" — it never writes
        #   state directly; clicking it starts a verify-gated proposal -> human review
        #   -> commit/approval flow. DERIVED from TrustState (official/local & not
        #   revoked => True; developer/untrusted/revoked => False, fail-closed), NOT a
        #   client rule. Surfaces MUST read this field and never re-hardcode
        #   `kind==='company' => disabled`, or they re-diverge from the kernel.
        "instantiable_semantics": {
            "plugin": "install",
            "skill": "install",
            "company": "bootstrap_proposal",
            "derived_from_trust": True,
            "company_instantiable_trust": ["official", "local"],
            "company_developer_disabled_reason": "developer_source_not_instantiable_pending_verify",
        },
        "copy": {
            "trust": dict(PROVENANCE_TRUST_COPY),
            "conflict_banner": "Catalog conflicts require review before install.",
            "refresh_failed": "Catalog refresh failed; cached catalog remains active.",
            "company_instantiate_cta": "Instantiate company",
            "company_developer_disabled": "Developer-source companies are not yet instantiable.",
            "company_untrusted_disabled": "Untrusted companies cannot be instantiated.",
        },
    }


def build_capability_upload_contract() -> dict[str, Any]:
    """Single source for the LOCAL developer-upload surface (CLI / Web / Desktop).

    The "developer upload" panel submits a package that lives on THIS machine's
    filesystem; the co-located control plane reads that path directly. This is a
    local developer console for managing one's own capabilities — not a hosted
    portal where a remote browser uploads bytes. Surfaces must therefore frame the
    package field as a local path / native file pick, never a network upload.

    Signing, publishing and marketplace listing are out-of-scope post-review steps
    (the kernel keeps submit/sign/publish strictly separate, and the API rejects a
    signing key on the upload path), so this contract excludes them on purpose — a
    surface must not collect a signing key here.

    Kinds are sourced from CAPABILITY_KINDS and the plugin document checklist from
    REQUIRED_SUBMISSION_DOCS so the guidance can never drift from what the kernel
    actually verifies (铁律 3 — contracts are centralised, not re-hardcoded per
    surface). Note that only `plugin` runs the full automated gate battery
    (incl. the sandbox smoke test); `skill` and `company` get a lighter review, so
    surfaces must not advertise a uniform "same gates for every kind" story.
    """
    from superclaw.capability_submission import CAPABILITY_KINDS
    from superclaw.plugin_submission import REQUIRED_SUBMISSION_DOCS

    # Canonical filename per required-doc gate (first candidate is the canonical
    # spelling); sourced from the kernel so the checklist tracks the real gates.
    plugin_docs = [candidates[0] for candidates in REQUIRED_SUBMISSION_DOCS.values()]

    kinds = [
        {
            "value": "plugin",
            "label": "Plugin",
            "id_field": "plugin_id",
            "id_placeholder": "dev.namespace.plugin",
            "summary": "An MCP tool/runtime your agents can call.",
            "package_format": "A directory (or .scplug archive) built on this machine.",
            "contents": [
                {
                    "path": "superclaw-plugin.json",
                    "required": True,
                    "detail": "Manifest: id, version, runtime, tools, permissions, "
                    "acceptance, commerce, provenance.",
                },
                {
                    "path": "runtime entrypoint",
                    "required": True,
                    "detail": "The executable the manifest points at (must exist and be runnable).",
                },
                *[
                    {
                        "path": doc,
                        "required": True,
                        "detail": "Required developer documentation.",
                    }
                    for doc in plugin_docs
                ],
                {
                    "path": "acceptance tests + evidence fixtures",
                    "required": True,
                    "detail": "Declared in the manifest's acceptance block; permissions must be declared.",
                },
                {
                    "path": "lockfile or SBOM",
                    "required": False,
                    "detail": "Required only when the package declares or bundles dependencies.",
                },
            ],
            "review": "Full automated preflight gate battery, including a sandbox smoke run.",
        },
        {
            "value": "skill",
            "label": "Skill",
            "id_field": "skill_id",
            "id_placeholder": "skill.namespace.name",
            "summary": "A reusable instruction/playbook surfaced to runtimes.",
            "package_format": "A SKILL.md file (or a folder containing SKILL.md).",
            "contents": [
                {
                    "path": "SKILL.md",
                    "required": True,
                    "detail": "Frontmatter must declare name, description and a "
                    "MAJOR.MINOR.PATCH version; the body must be non-empty.",
                },
            ],
            "review": "Lightweight review (markdown/frontmatter validity + secret scan).",
        },
        {
            "value": "company",
            "label": "Company",
            "id_field": "company_id",
            "id_placeholder": "company.namespace.name",
            "summary": "A pre-built agent company template.",
            "package_format": "A company template manifest built on this machine.",
            "contents": [
                {
                    "path": "superclaw-company.json",
                    "required": True,
                    "detail": "Company template manifest with a MAJOR.MINOR.PATCH version "
                    "that loads and passes contract validation.",
                },
            ],
            "review": "Lightweight review (template load + contract validity + version).",
        },
    ]

    # Defensive: keep the contract's kind vocabulary locked to the kernel's set so a
    # future kind added to one but not the other surfaces as a contract drift, not a
    # silently-missing option. (Asserted by tests as well; this is the runtime guard.)
    contract_kinds = {entry["value"] for entry in kinds}
    if contract_kinds != set(CAPABILITY_KINDS):
        missing = sorted(set(CAPABILITY_KINDS) - contract_kinds)
        extra = sorted(contract_kinds - set(CAPABILITY_KINDS))
        raise RuntimeError(
            "capability-upload contract drifted from CAPABILITY_KINDS "
            f"(missing={missing}, extra={extra})"
        )

    return {
        "capability": "capability-upload",
        "schema_version": "0.1.0",
        # The control plane reads the package from this machine's filesystem.
        "artifact_source": "local_path",
        # Steps that MUST NOT appear on the upload surface.
        "excludes": ["signing_private_key", "publish", "marketplace_listing"],
        "kinds": kinds,
        "acceptance_levels": [
            {
                "value": "L1",
                "label": "L1 · baseline",
                "detail": "Manifest valid, tool schemas match, sandbox smoke run passes.",
            },
            {
                "value": "L2",
                "label": "L2 · hardened",
                "detail": "Adds stable digest, runnable entrypoint, declared test "
                "permissions and evidence fixtures.",
            },
            {
                "value": "L3",
                "label": "L3 · high assurance",
                "detail": "Adds manual security review and commercial-readiness checks.",
            },
        ],
        "copy": {
            "source_hint": "Pick a capability package you built on this machine — "
            "the local control plane reads the path directly.",
            "signing_excluded": "Signing is a separate, post-review step and is never "
            "part of uploading. Don't paste a signing key here.",
            "review_note": "Uploading runs local preflight review only. It never "
            "signs, publishes, or lists your capability.",
            "smoke_note": "Plugin review runs your entrypoint in a sandbox smoke test; "
            "skills and companies get a lighter, code-free review.",
        },
    }


def build_desktop_dependency_targets(*, agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    known_agents = {str(agent.get("name")): agent for agent in agents}
    items: list[dict[str, Any]] = []
    for spec in DESKTOP_DEPENDENCY_SPECS:
        agent = known_agents.get(spec["name"], {})
        installed = bool(agent.get("available"))
        items.append(
            {
                "name": spec["name"],
                "label": spec["label"],
                "installed": installed,
                "detail": agent.get("executable") or agent.get("version") or agent.get("reason") or ("ready" if installed else "missing"),
                "remediation": "Ready for desktop use." if installed else str(agent.get("configure") or spec["fallback"]),
            }
        )
    return items


def _toolchain_which(name: str) -> str | None:
    return shutil.which(name)


def _toolchain_version(command: str, *, args: tuple[str, ...] = ("--version",)) -> str | None:
    try:
        completed = subprocess.run(
            [command, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = (completed.stdout or completed.stderr or "").strip().splitlines()
    if not output:
        return None
    return output[0][:160]


def build_desktop_toolchain_payload(*, workspace_root: Path) -> dict[str, Any]:
    desktop_root = workspace_root / "apps" / "desktop"
    source_workspace = (workspace_root / ".git").exists() and (desktop_root / "package.json").exists()
    if not source_workspace:
        return {
            "workspace_root": str(workspace_root),
            "desktop_root": str(desktop_root),
            "source_workspace": False,
            "tools": [],
            "summary": {
                "required_count": 0,
                "ready_count": 0,
                "source_build_ready": True,
            },
            "status_url": "/api/desktop/toolchain",
        }

    npm_installed = (desktop_root / "node_modules").exists()
    local_tauri = desktop_root / "node_modules" / ".bin" / "tauri"
    python_executable = _toolchain_which("python3")
    node_executable = _toolchain_which("node")
    npm_executable = _toolchain_which("npm")
    cargo_executable = _toolchain_which("cargo")
    tauri_available = local_tauri.exists()
    tools = [
        {
            "name": "python3",
            "label": "Python 3",
            "available": bool(python_executable),
            "detail": _toolchain_version(python_executable) if python_executable else "python3 not found on PATH",
            "remediation": "Install Python 3.11+ and create the local .venv before launching SuperClaw from source.",
        },
        {
            "name": "node",
            "label": "Node.js",
            "available": bool(node_executable),
            "detail": _toolchain_version(node_executable) if node_executable else "node not found on PATH",
            "remediation": "Install Node.js so the shared web workbench can build and run.",
        },
        {
            "name": "npm",
            "label": "npm",
            "available": bool(npm_executable),
            "detail": _toolchain_version(npm_executable) if npm_executable else "npm not found on PATH",
            "remediation": "Install npm or a Node.js distribution that includes it.",
        },
        {
            "name": "cargo",
            "label": "Cargo",
            "available": bool(cargo_executable),
            "detail": _toolchain_version(cargo_executable) if cargo_executable else "cargo not found on PATH",
            "remediation": "Install Rust/Cargo to build the Tauri desktop shell from source.",
        },
        {
            "name": "tauri",
            "label": "Tauri CLI",
            "available": tauri_available,
            "detail": str(local_tauri) if tauri_available else "apps/desktop/node_modules/.bin/tauri is missing",
            "remediation": (
                "Run `npm install --prefix apps/desktop` so the local @tauri-apps/cli binary exists before `npm run tauri:build`."
                if not npm_installed
                else "Re-run `npm install --prefix apps/desktop` to restore the local @tauri-apps/cli binary."
            ),
        },
    ]
    ready_count = sum(1 for tool in tools if tool["available"])
    return {
        "workspace_root": str(workspace_root),
        "desktop_root": str(desktop_root),
        "source_workspace": True,
        "tools": tools,
        "summary": {
            "required_count": len(tools),
            "ready_count": ready_count,
            "source_build_ready": ready_count == len(tools),
        },
        "status_url": "/api/desktop/toolchain",
    }


def build_desktop_onboarding_payload(
    *,
    workspace_root: Path,
    runtime_status: dict[str, Any],
    agents: list[dict[str, Any]],
    auth_payload: dict[str, Any],
    plugin_status: dict[str, Any],
    toolchain_payload: dict[str, Any],
    acceptance_payload: dict[str, Any],
) -> dict[str, Any]:
    dependency_targets = build_desktop_dependency_targets(agents=agents)
    missing_dependency_targets = [target for target in dependency_targets if not target["installed"]]
    missing_toolchain = [tool for tool in toolchain_payload.get("tools", []) if not tool.get("available")]
    clawhunt = auth_payload.get("clawhunt", {})
    checks = [
        {
            "title": "Runtime service",
            "ready": True,
            "detail": f"{runtime_status.get('service', {}).get('version', 'unknown')} / backend {runtime_status.get('backend', 'unknown')} / mode {runtime_status.get('mode', 'unknown')}",
            "remediation": "The local SuperClaw runtime is already serving the control-plane APIs.",
        },
        {
            "title": "Desktop toolchain",
            "ready": toolchain_payload.get("source_workspace") is False or bool(toolchain_payload.get("summary", {}).get("source_build_ready")),
            "detail": (
                f"{toolchain_payload['summary']['ready_count']}/{toolchain_payload['summary']['required_count']} source-build tools are ready."
                if toolchain_payload.get("source_workspace") and not missing_toolchain
                else (
                    f"Needs setup: {', '.join(str(tool['label']) for tool in missing_toolchain)}."
                    if toolchain_payload.get("source_workspace")
                    else "Packaged beta mode does not require a local source-build toolchain."
                )
            ),
            "remediation": (
                missing_toolchain[0]["remediation"]
                if toolchain_payload.get("source_workspace") and missing_toolchain
                else (
                    "Desktop source-build toolchain is ready."
                    if toolchain_payload.get("source_workspace")
                    else "Use the packaged beta path unless you plan to build SuperClaw from source."
                )
            ),
        },
        {
            "title": "Dependency doctor",
            "ready": not missing_dependency_targets,
            "detail": (
                f"{len(dependency_targets)}/{len(dependency_targets)} supported desktop agents are ready."
                if not missing_dependency_targets
                else f"Needs setup: {', '.join(str(target['label']) for target in missing_dependency_targets)}."
            ),
            "remediation": missing_dependency_targets[0]["remediation"] if missing_dependency_targets else "Desktop agent dependencies are already available.",
        },
        {
            "title": "Beta acceptance",
            "ready": acceptance_payload.get("summary", {}).get("success") is True,
            "detail": (
                f"Acceptance passed at {acceptance_payload['summary'].get('generated_at') or 'unknown time'}."
                if acceptance_payload.get("summary", {}).get("success") is True
                else (
                    "No acceptance report found yet."
                    if not acceptance_payload.get("exists")
                    else f"Acceptance needs review: {acceptance_payload['summary'].get('failed_step') or 'unknown failure'}."
                )
            ),
            "remediation": f"Run `{acceptance_payload.get('generate_command')}` and review `{acceptance_payload.get('report_path')}`.",
        },
        {
            "title": "ClawHunt login",
            "ready": clawhunt.get("agent_api_key") == "set",
            "detail": "Agent key is linked."
            if clawhunt.get("agent_api_key") == "set"
            else "No ClawHunt agent key is configured yet.",
            "remediation": "Sign in with a ClawHunt account, then create or paste an agent key before browsing or submitting market work.",
        },
        {
            "title": "Plugin trust root",
            "ready": bool(plugin_status.get("verification", {}).get("public_key_configured")),
            "detail": (
                "Registry signature root is configured."
                if plugin_status.get("verification", {}).get("public_key_configured")
                else "Registry signature root is not configured yet."
            ),
            "remediation": "Configure the plugin public key before relying on marketplace installs.",
        },
    ]
    ready_count = sum(1 for item in checks if item["ready"])
    return {
        "workspace_root": str(workspace_root),
        "quickstart_path": "docs/desktop-beta-quickstart.md",
        "status_url": "/api/desktop/onboarding",
        "summary": {
            "ready": ready_count == len(checks),
            "ready_count": ready_count,
            "total_count": len(checks),
        },
        "checks": checks,
        "dependency_targets": dependency_targets,
    }


def desktop_acceptance_report_path(*, workspace_root: Path) -> Path:
    configured = os.environ.get("SUPERCLAW_DESKTOP_ACCEPTANCE_REPORT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return workspace_root / ".superclaw" / "desktop" / "desktop-beta-acceptance.json"


def build_desktop_acceptance_payload(*, workspace_root: Path) -> dict[str, Any]:
    desktop_root = workspace_root / "apps" / "desktop"
    report_path = desktop_acceptance_report_path(workspace_root=workspace_root)
    source_workspace = (workspace_root / ".git").exists() and (desktop_root / "package.json").exists()
    payload: dict[str, Any] = {
        "workspace_root": str(workspace_root),
        "desktop_root": str(desktop_root),
        "source_workspace": source_workspace,
        "report_path": str(report_path),
        "status_url": "/api/desktop/acceptance",
        "generate_command": "npm --prefix apps/desktop run test:beta-acceptance",
        "quickstart_path": "docs/desktop-beta-quickstart.md",
        "exists": report_path.exists(),
        "report": None,
        "summary": {
            "ready": False,
            "success": None,
            "failed_step": None,
            "generated_at": None,
            "completed_steps": 0,
            "total_steps": 0,
        },
    }
    if not report_path.exists():
        return payload
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        payload["summary"] = {
            "ready": False,
            "success": False,
            "failed_step": "report_parse_error",
            "generated_at": None,
            "completed_steps": 0,
            "total_steps": 0,
            "error": str(exc),
        }
        return payload
    steps = report.get("steps") if isinstance(report.get("steps"), list) else []
    completed_steps = sum(1 for step in steps if isinstance(step, Mapping) and step.get("ok") is True)
    payload["report"] = report
    payload["summary"] = {
        "ready": True,
        "success": report.get("success"),
        "failed_step": report.get("failed_step"),
        "generated_at": report.get("generated_at"),
        "completed_steps": completed_steps,
        "total_steps": len(steps),
    }
    return payload


def build_tui_acceptance_payload(*, workspace_root: Path) -> dict[str, Any]:
    report_path = tui_acceptance_report_path(workspace_root=workspace_root)
    payload: dict[str, Any] = {
        "workspace_root": str(workspace_root),
        "report_path": str(report_path),
        "status_url": "/api/tui/acceptance",
        "generate_command": "PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance",
        "exists": report_path.exists(),
        "report": None,
        "summary": {
            "ready": False,
            "success": None,
            "failed_step": None,
            "generated_at": None,
            "completed_steps": 0,
            "total_steps": 0,
        },
    }
    if not report_path.exists():
        return payload
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        payload["summary"] = {
            "ready": False,
            "success": False,
            "failed_step": "report_parse_error",
            "generated_at": None,
            "completed_steps": 0,
            "total_steps": 0,
            "error": str(exc),
        }
        return payload
    steps = report.get("steps") if isinstance(report.get("steps"), list) else []
    completed_steps = sum(1 for step in steps if isinstance(step, Mapping) and step.get("ok") is True)
    payload["report"] = report
    payload["summary"] = {
        "ready": True,
        "success": report.get("success"),
        "failed_step": report.get("failed_step"),
        "generated_at": report.get("generated_at"),
        "completed_steps": completed_steps,
        "total_steps": len(steps),
    }
    return payload


def build_runtime_health_payload(
    *,
    agents: list[dict[str, Any]],
    plugins: dict[str, Any],
    clawhunt_agent_api_key_configured: bool,
) -> dict[str, Any]:
    missing_agents = [str(agent.get("name") or "unknown") for agent in agents if not agent.get("available")]
    registry_error = plugins.get("registry", {}).get("error")
    revocation_error = plugins.get("governance", {}).get("revocation_error")
    policy_error = plugins.get("governance", {}).get("policy_error")
    plugin_root_ready = bool(plugins.get("verification", {}).get("public_key_configured"))
    issues: list[str] = []
    warnings: list[str] = []

    if registry_error:
        issues.append("plugin registry unavailable")
    if revocation_error:
        issues.append("revocation sync unavailable")
    if policy_error:
        issues.append("runtime policy unavailable")
    if missing_agents:
        warnings.append(f"missing agents: {', '.join(missing_agents)}")
    if not plugin_root_ready:
        warnings.append("plugin trust root unset")
    if not clawhunt_agent_api_key_configured:
        warnings.append("clawhunt auth unset")

    if issues:
        status = "error"
    elif warnings:
        status = "warn"
    else:
        status = "ok"

    return {
        "status": status,
        "issues": issues,
        "warnings": warnings,
        "summary": "; ".join([*issues, *warnings]) if issues or warnings else "runtime ready",
        "missing_agent_count": len(missing_agents),
        "plugin_root_key_configured": plugin_root_ready,
        "clawhunt_auth_configured": clawhunt_agent_api_key_configured,
    }


def build_runtime_status_payload(
    *,
    runtime_version: str,
    repo: Path,
    state_path: Path,
    artifact_dir: Path,
    backend: str,
    mode: str,
    started_at: float,
    control_token_required: bool,
    clawhunt_agent_api_key_configured: bool,
    context: dict[str, Any],
    active_run_ids: list[str],
    recent_run_id: str | None,
    config_path: Path,
    agents: list[dict[str, Any]],
    plugins: dict[str, Any],
    service_pid: int | None = None,
    service_bind: str | None = None,
    service_control_token: str | None = None,
    node: dict[str, Any] | None = None,
) -> dict[str, Any]:
    health = build_runtime_health_payload(
        agents=agents,
        plugins=plugins,
        clawhunt_agent_api_key_configured=clawhunt_agent_api_key_configured,
    )
    resolved_service_pid = int(service_pid or os.getpid())
    resolved_service_bind = str(service_bind or os.environ.get("SUPERCLAW_SERVICE_BIND") or "127.0.0.1")
    resolved_control_token = service_control_token or ("set" if control_token_required else "unset")
    return {
        "runtime_version": runtime_version,
        "repo": str(repo),
        "state_path": str(state_path),
        "artifact_dir": str(artifact_dir),
        "backend": backend,
        "mode": mode,
        "auth": {
            "clawhunt": "set" if clawhunt_agent_api_key_configured else "unset",
            "status_url": "/api/auth/status",
        },
        # Two-state permission shell (Ask/Allow) shared by every surface; per-backend
        # realizations ride on each agents entry. docs/permission-mode-framework.md.
        "permission_modes": permission_mode_contract(),
        "service": {
            "name": "superclaw",
            "version": runtime_version,
            "pid": resolved_service_pid,
            "bind": resolved_service_bind,
            "control_token": resolved_control_token,
            "started_at": started_at,
            "uptime_seconds": round(max(0.0, time.time() - float(started_at)), 3),
            "control_token_required": control_token_required,
            "health": health,
        },
        "state": {
            "path": str(state_path),
            "context": context,
            "active_run_ids": active_run_ids,
            "active_run_count": len(active_run_ids),
            "recent_run_id": recent_run_id,
        },
        "agents": {
            **build_agent_summary(agents),
            "status_url": "/api/agents",
        },
        "config": {
            "path": str(config_path),
            "status_url": "/api/config",
        },
        "plugins": {
            "plugin_count": plugins["plugin_count"],
            "status_url": "/api/plugins/status",
        },
        # Node coexistence readiness (server-refactor): the web startup gate holds the
        # welcome splash until the co-launched Node control plane is ready so the sidebar
        # never paints empty. ``enabled`` False ⇒ no Node in this deployment (the gate must
        # not wait). Populated by the service process from node_runtime; defaults to a
        # disabled section for callers without node info (CLI doctor, tests).
        "node": node
        or {"enabled": False, "ready": False, "url": None, "port": None, "error": None},
    }


def build_shell_status_lines(
    runtime_status: dict[str, Any],
    *,
    session_id: str | None,
    last_run_id: str | None,
    backend_status: str,
) -> list[str]:
    context = runtime_status.get("state", {}).get("context", {})
    counts = context.get("counts", {})
    auth = runtime_status.get("auth", {})
    state = runtime_status.get("state", {})
    return [
        "Runtime status:",
        f"runtime_version={runtime_status['runtime_version']}",
        f"backend={runtime_status['backend']}",
        f"mode={runtime_status['mode']}",
        f"repo={runtime_status['repo']}",
        f"service_pid={runtime_status['service'].get('pid', '(unknown)')}",
        f"service_bind={runtime_status['service'].get('bind', '(unknown)')}",
        f"control_token={runtime_status['service'].get('control_token', 'unset')}",
        f"session_id={session_id or '(not started)'}",
        f"last_run_id={last_run_id or '(none)'}",
        f"backend_status={backend_status}",
        f"auth={auth.get('clawhunt', 'unset')}",
        f"runs_total={counts.get('runs', 0)}",
        f"events_total={counts.get('events', 0)}",
        f"evidence_total={counts.get('evidence_bundles', 0)}",
        f"chat_sessions_total={counts.get('chat_sessions', 0)}",
        f"active_runs={state.get('active_run_count', len(state.get('active_run_ids', [])))}",
        f"plugin_cache_count={runtime_status.get('plugins', {}).get('plugin_count', 0)}",
    ]


# --- Agent Team Kernel surface contracts ----------------------------------
#
# Single-definition-point read models for the team/company surface. Surfaces (Web /
# Desktop) render these payloads; they must not compute organization state on
# their own. Mutations always flow back through the CLI kernel, never directly.


def build_team_inventory_payload(
    store: StateStore,
    *,
    workspace_id: str | None = None,
    company_profile_id: str | None = None,
) -> dict[str, Any]:
    """Org-chart + issue-status + open-approval roll-up for the team/company surface."""
    return team_kernel.team_inventory(
        store, workspace_id=workspace_id, company_profile_id=company_profile_id
    )


def build_company_export_payload(
    store: StateStore,
    company_profile_id: str,
    *,
    include_issues: bool = False,
    include_work_products: bool = False,
    revision: str | None = None,
    include_files: bool = True,
) -> dict[str, Any]:
    """Single contract point for company-as-code export across CLI / API / Web.

    Wraps the kernel :func:`superclaw.company_export.build_company_export` so no
    surface re-implements the export. ``include_files=False`` returns the preview
    shape (manifest + file tree + warnings, no file bodies) for a surface that
    only needs to show what *would* be written before committing to a download.
    """
    from superclaw.company_export import build_company_export

    bundle = build_company_export(
        store,
        company_profile_id,
        include_issues=include_issues,
        include_work_products=include_work_products,
        revision=revision,
    )
    return bundle.surface_payload(include_files=include_files)


def build_approval_queue_payload(
    store: StateStore,
    *,
    status: str | None = "pending",
    company_profile_id: str | None = None,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    """The approval inbox a reviewer acts on. Read-only; decisions go via CLI.

    ``company_profile_id`` scopes the inbox to one company (resolved through
    each approval's issue, fail-closed in the kernel); ``workspace_id`` to one
    execution boundary.
    """
    approvals = store.list_approvals(
        status=status, company_profile_id=company_profile_id, workspace_id=workspace_id
    )
    return {
        "status_filter": status,
        "company_profile_id": company_profile_id,
        "workspace_id": workspace_id,
        "count": len(approvals),
        "approvals": [a.to_dict() for a in approvals],
    }


def build_company_messages_payload(
    store: StateStore,
    *,
    company_profile_id: str | None = None,
    user_id: str = "local_user",
) -> dict[str, Any]:
    """Single contract point for the Agent-company message center across surfaces.

    Wraps the kernel :func:`superclaw.company_messages.build_company_messages_payload`
    so CLI / API / Web all read the IDENTICAL tiered roll-up (pending approvals +
    completed-unreviewed + blocked, with per-itemKey unread). No surface may
    re-derive per-company unread from raw agents/issues
    (docs/agent-company-message-center-design.md M-1: 禁前端聚合).
    """
    from superclaw import company_messages

    return company_messages.build_company_messages_payload(
        store, company_profile_id=company_profile_id, user_id=user_id
    )


def build_workspace_locks_payload(store: StateStore, *, workspace_id: str | None = None) -> dict[str, Any]:
    """Active checkout locks, so a surface can show who holds which workspace."""
    locks = store.list_workspace_locks(workspace_id=workspace_id)
    return {
        "workspace_id": workspace_id,
        "count": len(locks),
        "locks": [lock.to_dict() for lock in locks],
    }


def workspace_projection(workspace, *, session_count: int | None = None) -> dict[str, Any]:
    """Surface contract for one workspace group/card (ADR: workspace-trust-container).

    Single definition point: surfaces render trust state and grouping from
    this projection and never derive organizational semantics themselves. A
    non-"active" trust_status means the surface must show a trust barrier
    instead of a chat box.
    """
    from superclaw.containment import workspace_effective_containment  # local: avoid cycle

    # Effective fence, not just the stored field — so the surface renders the
    # risk-based floor (a remote/untrusted-source workspace reads as low-trust
    # even if it never set the preset). T11.
    effective = workspace_effective_containment(workspace)
    payload = {
        "workspace_id": workspace.workspace_id,
        "name": workspace.name,
        "kind": workspace.kind,
        "trust_status": workspace.trust_status,
        "is_trusted": workspace.is_trusted,
        "trust_source": workspace.trust_source,
        "repo_path": workspace.repo_path,
        "company_profile_id": workspace.company_profile_id,
        "builtin_chat": workspace.metadata.get("builtin") == "chat",
        "containment_preset": getattr(workspace, "containment_preset", "standard"),
        "effective_containment": effective.preset,
        # Sidebar pin (cross-surface): surfaces float pinned groups to the top
        # "Pinned" zone and order them by pinned_at. ``pinned`` is the derived
        # boolean; ``pinned_at`` is the order stamp (null = not pinned).
        "pinned": getattr(workspace, "pinned_at", None) is not None,
        "pinned_at": getattr(workspace, "pinned_at", None),
    }
    if session_count is not None:
        payload["session_count"] = session_count
    return payload


def build_workspace_inventory(store: StateStore) -> dict[str, Any]:
    """The chat surface's workspace sidebar: PERSONAL workspaces + session counts.

    Only ``company="local"`` workspaces are listed — a company's workspace is an
    agent execution boundary that belongs to the team/company surface, not the personal
    chat sidebar (workspace-sidebar-rework §4.2: company workspaces must not leak
    into chat grouping). Session counts exclude archived sessions (list default),
    matching what the sidebar renders. Includes the unassigned (legacy) session
    count so surfaces can render an Inbox/Chats section during migration.
    """
    sessions = store.list_chat_sessions()
    counts: dict[str, int] = {}
    unassigned = 0
    for session in sessions:
        if session.workspace_id:
            counts[session.workspace_id] = counts.get(session.workspace_id, 0) + 1
        else:
            unassigned += 1
    workspaces = [
        workspace_projection(workspace, session_count=counts.get(workspace.workspace_id, 0))
        for workspace in store.list_workspace_profiles(company_profile_id="local")
    ]
    return {
        "count": len(workspaces),
        "workspaces": workspaces,
        "unassigned_session_count": unassigned,
    }


def build_secrets_contract() -> dict[str, Any]:
    """Shared spec for the company-secrets surface (Paperclip 拿取清单 §6 本地 v1).

    Surfaces render FROM this contract — provider/target lists must never be
    re-hardcoded client-side. Plaintext never crosses this contract: every
    read model is masked ledger metadata only.
    """
    from superclaw.models import InstanceSettings
    from superclaw.secrets_store import BINDING_TARGET_TYPES, PROVIDER

    return {
        "providers": [
            {
                "id": PROVIDER,
                "label": "Local encrypted (AES-256-GCM)",
                "ready": True,
                "notes": "master key: SUPERCLAW_SECRETS_MASTER_KEY env > ~/.superclaw/secrets.key (0600, auto-generated)",
            },
            {"id": "aws_secrets_manager", "label": "AWS Secrets Manager", "ready": False, "notes": "B 端里程碑"},
            {"id": "gcp_secret_manager", "label": "GCP Secret Manager", "ready": False, "notes": "B 端里程碑"},
            {"id": "vault", "label": "HashiCorp Vault", "ready": False, "notes": "B 端里程碑"},
        ],
        "binding_target_types": list(BINDING_TARGET_TYPES),
        "masking": {
            "plaintext_never_listed": True,
            "resolution_requires_binding": True,
            "denied_resolutions_audited": True,
        },
        "invokability_gate": {
            "rule": "every required binding must point at a live (existing, non-archived) secret",
            "enforced_at": ["team_kernel.checkout_issue"],
        },
        "instance_settings_buckets": list(InstanceSettings.BUCKETS),
    }


# --- Company-management tool projection (PR-F) -----------------------------
#
# SINGLE SOURCE of the company-management tool vocabulary the chat agent can
# call. The B-class backends (Gemini / Anthropic) derive their per-provider tool
# schemas FROM this one list (no hand-copied second definition), and the
# orchestrator maps a called tool name back to a typed command_type via
# TOOL_NAME_TO_COMMAND_TYPE before dispatching through
# ``company_handler.execute_company_command``.
#
# Each entry's ``input_schema`` mirrors the corresponding
# ``superclaw.company_commands`` model fields (the typed mutation contract). The
# schema is intentionally provider-NEUTRAL (JSON-Schema "object" with properties
# + required); the backend wrappers project it into the Gemini
# ``{"type":"function","function":{...}}`` and Anthropic
# ``{"name","description","input_schema"}`` shapes. ``from_dict`` on the command
# model is the authoritative validator — it REJECTS unknown fields — so the
# schema here is a guide for the model, not the security boundary.
#
# TOOL_NAME_TO_COMMAND_TYPE is the closed, fail-closed map: a tool name not in
# this dict is not a company command and is never dispatched as one.
COMPANY_COMMAND_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "company_create",
        "command_type": "company.create",
        "description": (
            "Create a new company (a governance namespace for agents/issues). "
            "User-triggered and reversible, so it runs immediately."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Company name (required)."},
                "goal": {"type": "string", "description": "Optional company goal/mission."},
                "default_budget_seconds": {"type": "integer", "description": "Optional default per-run wall-clock budget."},
                "default_token_budget": {"type": "integer", "description": "Optional default per-run token budget."},
                "allowed_plugins": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional plugin allowlist for the company.",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "company_update",
        "command_type": "company.update",
        "description": "Patch an existing company's profile. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (required)."},
                "name": {"type": "string", "description": "New company name."},
                "goal": {"type": "string", "description": "New company goal."},
                "default_budget_seconds": {"type": "integer", "description": "New default per-run wall-clock budget."},
                "default_token_budget": {"type": "integer", "description": "New default per-run token budget."},
                "allowed_plugins": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Replacement plugin allowlist.",
                },
            },
            "required": ["company_profile_id"],
        },
    },
    {
        "name": "company_archive",
        "command_type": "company.archive",
        "description": (
            "Archive (soft-delete) a company. IRREVERSIBLE — this pauses for a human "
            "confirmation in the Web/CLI approvals queue before it takes effect."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (required)."},
                "reason": {"type": "string", "description": "Optional reason recorded with the archive."},
            },
            "required": ["company_profile_id"],
        },
    },
    {
        "name": "agent_hire",
        "command_type": "agent.hire",
        "description": "Hire (create) a new agent role in a company. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": (
                        "Agent spec. Requires 'name' and 'role'. May include "
                        "company_profile_id, workspace_id, reports_to, model, "
                        "permission_policy, plugin_allowlist, skill_allowlist (the "
                        "kernel's hire-spec whitelist; unknown keys are rejected)."
                    ),
                },
            },
            "required": ["spec"],
        },
    },
    {
        "name": "agent_update",
        "command_type": "agent.update",
        "description": "Patch an existing agent role. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "profile_id": {"type": "string", "description": "Target agent profile id (required)."},
                "patch": {
                    "type": "object",
                    "description": (
                        "Fields to change (must be a subset of the kernel's editable "
                        "profile fields; unknown keys are rejected)."
                    ),
                },
            },
            "required": ["profile_id", "patch"],
        },
    },
    {
        "name": "issue_create",
        "command_type": "issue.create",
        "description": "Create an issue (a unit of work) in a company. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Issue title (required)."},
                "description": {"type": "string", "description": "Optional issue description."},
                "kind": {"type": "string", "description": "Optional issue kind (closed enum)."},
                "review_policy": {"type": "string", "description": "Optional review policy (closed enum)."},
                "workspace_id": {"type": "string", "description": "Optional workspace to file the issue under."},
                "assignee_agent_profile_id": {"type": "string", "description": "Optional agent to assign at creation."},
            },
            "required": ["title"],
        },
    },
    {
        "name": "issue_assign",
        "command_type": "issue.assign",
        "description": "Assign an existing issue to an agent. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "profile_id": {"type": "string", "description": "Agent profile id to assign (required)."},
            },
            "required": ["issue_id", "profile_id"],
        },
    },
    {
        "name": "issue_delegate",
        "command_type": "issue.delegate",
        "description": "Create a child issue under a parent, assigned to an agent. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "parent_id": {"type": "string", "description": "Parent issue id (required)."},
                "assignee_agent_profile_id": {"type": "string", "description": "Agent to assign the child to (required)."},
                "title": {"type": "string", "description": "Child issue title (required)."},
                "description": {"type": "string", "description": "Optional child description."},
                "priority": {"type": "string", "description": "Optional priority."},
                "origin_run_id": {"type": "string", "description": "Optional originating run id."},
            },
            "required": ["parent_id", "assignee_agent_profile_id", "title"],
        },
    },
    {
        "name": "issue_comment",
        "command_type": "issue.comment",
        "description": (
            "Post a comment on an issue's thread (how an agent asks for help / "
            "reports progress; @mentions wake the named agent, any non-assignee "
            "comment wakes the assignee). Reversible, runs immediately."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "body": {"type": "string", "description": "Comment text (required, non-empty)."},
            },
            "required": ["issue_id", "body"],
        },
    },
    {
        "name": "work_product_attach",
        "command_type": "work_product.attach",
        "description": (
            "Attach a delivery fact (PR / commit / preview / artifact / …) to an "
            "issue. Audit-only — it never moves the issue or touches the approval "
            "gate. Reversible, runs immediately."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "type": {"type": "string", "description": "Work-product type (closed enum, required)."},
                "title": {"type": "string", "description": "Optional human title."},
                "url": {"type": "string", "description": "Optional URL/locator for the artifact."},
                "provider": {"type": "string", "description": "Optional provider (default 'local')."},
                "external_id": {"type": "string", "description": "Optional external id at the provider."},
                "status": {"type": "string", "description": "Optional work-product status (closed enum)."},
                "summary": {"type": "string", "description": "Optional summary."},
                "is_primary": {"type": "boolean", "description": "Mark as the issue's primary delivery fact."},
            },
            "required": ["issue_id", "type"],
        },
    },
    {
        "name": "issue_submit_review",
        "command_type": "issue.submit_review",
        "description": (
            "Submit an in-progress issue for review (the agent cannot mark its own "
            "work done — it requests review and a human/parent decides). A confined "
            "agent MUST pass expected_checkout_run_id (its OWN checkout run) AND may "
            "only submit an issue it owns; the operator may force-submit without it. "
            "Reversible, runs immediately."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "expected_checkout_run_id": {
                    "type": "string",
                    "description": (
                        "The run id that holds this issue's checkout: the submit is "
                        "bound to it so stale/foreign-run submissions are refused. "
                        "REQUIRED for a confined agent; optional for the operator "
                        "(force-submit). When provided it must be non-empty."
                    ),
                },
                "summary": {"type": "string", "description": "Optional review summary / note."},
            },
            "required": ["issue_id"],
        },
    },
    {
        "name": "work_product_update",
        "command_type": "work_product.update",
        "description": (
            "Patch a delivery fact's mutable fields (status/title/url/summary/primary). "
            "Reversible, runs immediately. Provide at least one field."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "work_product_id": {"type": "string", "description": "Target work product id (required)."},
                "status": {"type": "string", "description": "New status (closed enum)."},
                "title": {"type": "string", "description": "New title."},
                "url": {"type": "string", "description": "New url."},
                "summary": {"type": "string", "description": "New summary."},
                "is_primary": {"type": "boolean", "description": "Mark as the issue's primary delivery fact."},
            },
            "required": ["work_product_id"],
        },
    },
    {
        "name": "agent_charter",
        "command_type": "agent.charter",
        "description": (
            "Set an agent's behavioral charter (its behavior contract — a different axis "
            "from agent_update's scalar fields, and the single command path for the "
            "revisioned charter). Reversible. To edit persona, use agent_update."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "profile_id": {"type": "string", "description": "Target agent profile id (required)."},
                "charter": {"type": "string", "description": "The role's behavior contract (charter text, required)."},
            },
            "required": ["profile_id", "charter"],
        },
    },
    {
        "name": "issue_block",
        "command_type": "issue.block",
        "description": "Mark an issue blocked with a reason. Reversible (issue_unblock clears it).",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "reason": {"type": "string", "description": "Why it is blocked (required)."},
                "unblock_owner": {"type": "string", "description": "Optional agent who should unblock it."},
            },
            "required": ["issue_id", "reason"],
        },
    },
    {
        "name": "issue_unblock",
        "command_type": "issue.unblock",
        "description": "Clear an issue's blocked state. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "note": {"type": "string", "description": "Optional note recorded with the unblock."},
            },
            "required": ["issue_id"],
        },
    },
    {
        "name": "issue_hold",
        "command_type": "issue.hold",
        "description": "Pause a single issue (a hold). Reversible (issue_unhold releases it).",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Target issue id (required)."},
                "reason": {"type": "string", "description": "Optional reason for the hold."},
            },
            "required": ["issue_id"],
        },
    },
    {
        "name": "issue_unhold",
        "command_type": "issue.unhold",
        "description": "Release a single issue's active hold. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Target issue id (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "routine_author",
        "command_type": "routine.author",
        "description": (
            "Author a recurring routine schedule for a company (a scheduled wake that "
            "seeds an issue). Reversible (a schedule can be disabled/removed). The spec "
            "needs: title, company_profile_id, workspace_id, agent_profile_id, "
            "cadence (e.g. {interval_sec: 3600} or a cron), issue_seed ({title, ...}), "
            "and optional governance budgets. A spec that needs governance approval is "
            "refused here — use the dedicated routine flow for those."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": (
                        "The routine spec (Paperclip-style). Must name a "
                        "company_profile_id (top-level or under references)."
                    ),
                },
            },
            "required": ["spec"],
        },
    },
    {
        "name": "issue_requeue",
        "command_type": "issue.requeue",
        "description": (
            "Recover a stuck issue: cancel its live run (if any) and return it to the "
            "queue (re-claimable). Reversible, runs immediately."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Target issue id (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "issue_tree_pause",
        "command_type": "issue.tree_pause",
        "description": (
            "Pause a whole issue subtree (root + descendants) — stops scheduling and "
            "cancels active runs in the subtree. Reversible (issue_tree_resume)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Root issue id of the subtree (required)."},
                "reason": {"type": "string", "description": "Optional reason for the pause."},
            },
            "required": ["issue_id"],
        },
    },
    {
        "name": "issue_tree_resume",
        "command_type": "issue.tree_resume",
        "description": "Resume a paused issue subtree. Reversible, runs immediately.",
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Root issue id of the subtree (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "issue_tree_cancel",
        "command_type": "issue.tree_cancel",
        "description": (
            "Cancel a whole issue subtree — IRREVERSIBLE (terminates every issue under "
            "the root and cancels its active runs). Pauses for a human confirmation in "
            "the Web/CLI approvals queue."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_id": {"type": "string", "description": "Root issue id of the subtree (required)."},
                "reason": {"type": "string", "description": "Optional reason recorded with the cancel."},
            },
            "required": ["issue_id"],
        },
    },
    {
        "name": "board_inbox_resolve",
        "command_type": "board_inbox.resolve",
        "description": (
            "Resolve a board-inbox escalation (the human-escalation queue) without "
            "changing its issue. Idempotent. Operator-only. Use board_inbox_list to "
            "find the interaction_id."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "interaction_id": {"type": "string", "description": "Board inbox item id (required)."},
            },
            "required": ["interaction_id"],
        },
    },
    {
        "name": "board_inbox_assign",
        "command_type": "board_inbox.assign",
        "description": (
            "Assign a board item's issue to an agent through the assignment gate, then "
            "(by default) resolve the escalation. Operator-only; same-company assignee "
            "only. Set resolve=false to keep the item open."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "interaction_id": {"type": "string", "description": "Board inbox item id (required)."},
                "profile_id": {"type": "string", "description": "Agent profile id to assign the issue to (required)."},
                "resolve": {"type": "boolean", "description": "Resolve the board item after assigning (default true)."},
            },
            "required": ["interaction_id", "profile_id"],
        },
    },
)


# Closed, fail-closed map: chat tool name -> typed company command_type. A name
# not present here is NOT a company command. The AUTHORITATIVE name<->command_type
# binding lives in ``company_commands.COMMAND_TYPE_TO_TOOL_NAME`` (the same source
# ``permissions._MUTATING_TOOLS`` derives from), so the dispatch map and the
# permission-classification map are ONE source — not two hand-maintained lists.
from superclaw.company_commands import (  # noqa: E402 - placed near its sole consumer
    COMMAND_TYPE_TO_TOOL_NAME as _COMMAND_TYPE_TO_TOOL_NAME,
)

TOOL_NAME_TO_COMMAND_TYPE: dict[str, str] = {
    tool_name: command_type for command_type, tool_name in _COMMAND_TYPE_TO_TOOL_NAME.items()
}

# Fail-closed at import: the schema tools, the dispatch map, and the canonical
# name source MUST describe the exact same tool set. A drift (e.g. a schema entry
# added without a command-type binding, or vice-versa) is a programming error
# caught HERE, not silently advertised-but-undispatchable or dispatched-but-
# unclassified-as-mutating.
assert {tool["name"] for tool in COMPANY_COMMAND_TOOLS} == set(TOOL_NAME_TO_COMMAND_TYPE), (
    "COMPANY_COMMAND_TOOLS drifted from the canonical company tool-name map"
)
assert all(
    tool["command_type"] == TOOL_NAME_TO_COMMAND_TYPE[tool["name"]]
    for tool in COMPANY_COMMAND_TOOLS
), "a COMPANY_COMMAND_TOOLS entry's command_type disagrees with the canonical map"


def build_company_command_tool_schema(schema: str) -> list[dict[str, Any]]:
    """Project the single-source COMPANY_COMMAND_TOOLS into a backend tool schema.

    ``schema`` is ``"gemini"`` (OpenAI function-calling shape) or ``"anthropic"``
    (Messages tools shape). Both are derived from the SAME source list — no
    surface hand-copies a second definition (CLAUDE.md 契约集中). Returns a fresh
    deep copy so a caller mutating the result can never corrupt the source.
    """
    projected: list[dict[str, Any]] = []
    for tool in COMPANY_COMMAND_TOOLS:
        name = tool["name"]
        description = tool["description"]
        input_schema = json.loads(json.dumps(tool["input_schema"]))
        if schema == "gemini":
            projected.append(
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": input_schema,
                    },
                }
            )
        else:  # anthropic
            projected.append(
                {
                    "name": name,
                    "description": description,
                    "input_schema": input_schema,
                }
            )
    return projected


# --- Company READ tools (discovery + snapshot) -------------------------------
# The read half of the company control plane projected into the chat agent: it
# can now SEE companies (list) and a company's state (snapshot), not only mutate
# them. These dispatch through ``company_read.execute_company_read`` (read-only,
# scope-gated; no risk/approval) — distinct from the mutation tools above, so
# they live in their own closed map and are NEVER classified as mutating. See
# docs/company-chat-exposure-roadmap.md (P0).
COMPANY_READ_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "company_list",
        "command_type": "company.list",
        "description": (
            "List the companies you can see (id, name, status, goal). Use this to "
            "answer 'what companies do I have' or to find a company's id before "
            "managing it. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "include_archived": {
                    "type": "boolean",
                    "description": "Include archived/dissolved companies (default false).",
                },
            },
        },
    },
    {
        "name": "company_snapshot",
        "command_type": "company.snapshot",
        "description": (
            "Get a bounded dashboard snapshot of ONE company: its roster (agents + "
            "their model/effort), issue counts by status, open/stale counts, recent "
            "issues, pending-approval count, and a cost rollup. Use this to 盘点/understand "
            "a company before assigning work. Omit company_profile_id to snapshot the "
            "company this chat is scoped to. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {
                    "type": "string",
                    "description": (
                        "Target company id. Omit to use the company this chat turn "
                        "is scoped to (the @-selected company)."
                    ),
                },
            },
        },
    },
    {
        "name": "agent_list",
        "command_type": "agent.list",
        "description": (
            "List a company's agents (roster): id, name, role, backend, model, effort, "
            "reports_to. Use before assigning/delegating an issue. Omit company_profile_id "
            "for the scoped company. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (omit for the scoped company)."},
            },
        },
    },
    {
        "name": "agent_show",
        "command_type": "agent.show",
        "description": (
            "Show one agent's full config: model, effort, budgets, plugin/skill allowlists, "
            "persona, granted tools. Use to check capabilities before assigning work. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"profile_id": {"type": "string", "description": "Agent profile id (required)."}},
            "required": ["profile_id"],
        },
    },
    {
        "name": "issue_list",
        "command_type": "issue.list",
        "description": (
            "List a company's issues, optionally filtered by status and/or assignee "
            "(bounded). Use to see the board / find work. Omit company_profile_id for the "
            "scoped company. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (omit for the scoped company)."},
                "status": {"type": "string", "description": "Filter by status (todo/in_progress/in_review/blocked/done/...)."},
                "assignee_agent_profile_id": {"type": "string", "description": "Filter by assignee agent profile id."},
                "limit": {"type": "integer", "description": "Max issues to return (capped)."},
            },
        },
    },
    {
        "name": "issue_show",
        "command_type": "issue.show",
        "description": "Show one issue's detail (title, status, assignee, kind, review policy, description excerpt). Read-only.",
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Issue id (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "read_issue_thread",
        "command_type": "issue.thread",
        "description": (
            "Read an issue's comment thread (bounded; long bodies excerpted). Use to follow "
            "a discussion or review feedback before responding. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Issue id (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "read_work_products",
        "command_type": "issue.work_products",
        "description": (
            "List an issue's work products (delivery facts): type, provider, url, status, "
            "summary excerpt. Review what was delivered before accepting/commenting. Returns "
            "metadata + excerpt, never raw bytes. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"issue_id": {"type": "string", "description": "Issue id (required)."}},
            "required": ["issue_id"],
        },
    },
    {
        "name": "approval_list",
        "command_type": "approval.list",
        "description": (
            "List a company's PENDING approvals (the human gate): id, type, linked issue, "
            "requested_by. See what awaits human decision. Omit company_profile_id for the "
            "scoped company. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (omit for the scoped company)."},
            },
        },
    },
    {
        "name": "messages_read",
        "command_type": "messages.read",
        "description": (
            "Read a company's message-center roll-up: pending approvals, completed-unreviewed, "
            "blocked counts. Operator/board triage view. Omit company_profile_id for the scoped "
            "company. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (omit for the scoped company)."},
            },
        },
    },
    {
        "name": "board_inbox_list",
        "command_type": "board_inbox.list",
        "description": (
            "List a company's board-inbox escalations (the human-escalation queue): "
            "interaction_id, issue_id, kind, status. Find items to act on with "
            "board_inbox_resolve / board_inbox_assign. Defaults to pending; pass "
            "status=all for every status. Omit company_profile_id for the scoped "
            "company. Read-only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "company_profile_id": {"type": "string", "description": "Target company id (omit for the scoped company)."},
                "status": {"type": "string", "description": "Status filter: pending (default), resolved, or all."},
            },
        },
    },
)


def _company_read_tool_name_to_command_type() -> dict[str, str]:
    """Derive the read tool-name → command_type map from the kernel registry.

    Single source: the read models in ``company_read`` own the command_types, so
    the map and the schema list can never drift from the dispatch registry.
    Imported lazily (function-local) to keep the module import order clean.
    """
    from superclaw.company_read import _READ_REGISTRY

    name_for = {
        "company.list": "company_list",
        "company.snapshot": "company_snapshot",
        "agent.list": "agent_list",
        "agent.show": "agent_show",
        "issue.list": "issue_list",
        "issue.show": "issue_show",
        "issue.thread": "read_issue_thread",
        "issue.work_products": "read_work_products",
        "approval.list": "approval_list",
        "messages.read": "messages_read",
        "board_inbox.list": "board_inbox_list",
    }
    return {name_for[ct]: ct for ct in _READ_REGISTRY}


COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE: dict[str, str] = _company_read_tool_name_to_command_type()

# Fail-closed at import: schema list, dispatch map, and kernel registry must
# describe the exact same read tool set (mirrors the mutation-tool assertion).
assert {tool["name"] for tool in COMPANY_READ_TOOLS} == set(COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE), (
    "COMPANY_READ_TOOLS drifted from the canonical company read tool-name map"
)
assert all(
    tool["command_type"] == COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE[tool["name"]]
    for tool in COMPANY_READ_TOOLS
), "a COMPANY_READ_TOOLS entry's command_type disagrees with the canonical map"
# Reads and writes must be DISJOINT tool sets — a name that is both readable and
# mutating would be classified ambiguously by the permission fence.
assert not (set(COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE) & set(TOOL_NAME_TO_COMMAND_TYPE)), (
    "company read/write tool names overlap"
)


def build_company_read_tool_schema(schema: str) -> list[dict[str, Any]]:
    """Project the single-source COMPANY_READ_TOOLS into a backend tool schema.

    Same projection contract as ``build_company_command_tool_schema`` — ``"gemini"``
    (function-calling) or ``"anthropic"`` (Messages tools) — from the SAME source
    list, returning a fresh deep copy.
    """
    projected: list[dict[str, Any]] = []
    for tool in COMPANY_READ_TOOLS:
        name = tool["name"]
        description = tool["description"]
        input_schema = json.loads(json.dumps(tool["input_schema"]))
        if schema == "gemini":
            projected.append(
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": input_schema,
                    },
                }
            )
        else:  # anthropic
            projected.append(
                {
                    "name": name,
                    "description": description,
                    "input_schema": input_schema,
                }
            )
    return projected


# --- ClawHunt marketplace chat tools (P3) ------------------------------------
# The SOLVER-facing marketplace tools projected into the chat agent. Buyer-side
# accept/accept_bid are deliberately EXCLUDED (a solver must never accept its own
# solution or pay out a bid — advisor阻断项); the API surface mirrors this exclusion.
# Single source: tool names + command_types come from marketplace_commands; a
# drift assertion (below) keeps this list locked to that vocabulary.
MARKETPLACE_COMMAND_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "marketplace_browse",
        "command_type": "marketplace.browse",
        "description": (
            "Browse / count open ClawHunt marketplace orders. Read-only; runs "
            "immediately. Requires a connected ClawHunt agent key (fail-closed if "
            "not connected)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "Optional status filter (open/bidding/claimed/…)."},
                "skip": {"type": "integer", "description": "Pagination offset (default 0)."},
                "limit": {"type": "integer", "description": "Max orders to return (1–50, default 20)."},
            },
        },
    },
    {
        "name": "marketplace_inspect",
        "command_type": "marketplace.inspect",
        "description": (
            "Inspect one marketplace order's full (agent-gated) detail. Read-only; "
            "requires a connected agent key."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"problem_id": {"type": "string", "description": "Order/problem id (required)."}},
            "required": ["problem_id"],
        },
    },
    {
        "name": "marketplace_post_task",
        "command_type": "marketplace.post_task",
        "description": (
            "Publish a new task/problem to the marketplace. Creates an EXTERNAL "
            "artifact — pauses for a human approval before it takes effect."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "price": {"type": "integer", "description": "Reward in cents (default 1)."},
                "category": {"type": "string"},
                "difficulty": {"type": "string"},
                "routing_mode": {"type": "string"},
                "target_agent_id": {"type": "string"},
            },
            "required": ["title", "description"],
        },
    },
    {
        "name": "marketplace_bid",
        "command_type": "marketplace.bid",
        "description": (
            "Bid on a marketplace order. A commitment to a third party — pauses for "
            "a human approval."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "problem_id": {"type": "string"},
                "amount": {"type": "integer", "description": "Bid amount in cents (optional)."},
                "message": {"type": "string"},
            },
            "required": ["problem_id"],
        },
    },
    {
        "name": "marketplace_claim",
        "command_type": "marketplace.claim",
        "description": (
            "Claim a marketplace order and bind it to a delivery company. Makes a "
            "remote commitment — pauses for a human approval; once granted, the order "
            "becomes a verifiable company delivery (run → completion gate → submit)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "problem_id": {"type": "string"},
                "company_profile_id": {"type": "string", "description": "Company that will own the delivery."},
            },
            "required": ["problem_id", "company_profile_id"],
        },
    },
    {
        "name": "marketplace_submit",
        "command_type": "marketplace.submit",
        "description": (
            "Submit a completed delivery's evidence to a claimed order. Pauses for a "
            "human approval; only allowed after the delivery passed its completion gate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "order_id": {"type": "string"},
                "solution_text": {"type": "string", "description": "Optional solution text override."},
            },
            "required": ["order_id"],
        },
    },
    {
        "name": "marketplace_abandon",
        "command_type": "marketplace.abandon",
        "description": (
            "Abandon a claimed order, releasing the remote commitment. Pauses for a "
            "human approval."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "order_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["order_id"],
        },
    },
)


def _marketplace_solver_tool_name_to_command_type() -> dict[str, str]:
    """The solver tool-name → command_type map (buyer-side excluded), from the
    single command vocabulary source."""
    from superclaw.marketplace_commands import (
        MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME,
        MARKETPLACE_SOLVER_TOOL_NAMES,
    )

    return {
        tool_name: command_type
        for command_type, tool_name in MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME.items()
        if tool_name in MARKETPLACE_SOLVER_TOOL_NAMES
    }


#: Closed, fail-closed map for the backend dispatch: a tool name not in it is not a
#: marketplace tool. Derived from the single command vocabulary (solver set only).
MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE: dict[str, str] = _marketplace_solver_tool_name_to_command_type()

# Drift guards: the chat tool list must exactly equal the solver tool-name map, and
# each entry's command_type must agree with that map (caught at import).
assert {tool["name"] for tool in MARKETPLACE_COMMAND_TOOLS} == set(
    MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE
), "MARKETPLACE_COMMAND_TOOLS drifted from the solver marketplace tool-name map"
assert all(
    tool["command_type"] == MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE[tool["name"]]
    for tool in MARKETPLACE_COMMAND_TOOLS
), "a MARKETPLACE_COMMAND_TOOLS entry's command_type disagrees with the map"


def build_marketplace_command_tool_schema(schema: str) -> list[dict[str, Any]]:
    """Project MARKETPLACE_COMMAND_TOOLS into a backend tool schema (mirrors
    ``build_company_command_tool_schema``). ``schema`` is "gemini" or "anthropic";
    both derive from the SAME source list (契约集中). Returns a fresh deep copy."""
    projected: list[dict[str, Any]] = []
    for tool in MARKETPLACE_COMMAND_TOOLS:
        name = tool["name"]
        description = tool["description"]
        input_schema = json.loads(json.dumps(tool["input_schema"]))
        if schema == "gemini":
            projected.append(
                {"type": "function", "function": {
                    "name": name, "description": description, "parameters": input_schema}}
            )
        else:  # anthropic
            projected.append(
                {"name": name, "description": description, "input_schema": input_schema}
            )
    return projected


def build_file_view_contract() -> dict[str, Any]:
    """Shared spec for the reference-viewer file capability (CLI / API / Web).

    Surfaces render FROM this contract — limits, render categories, and the
    stable error-code set must never be re-hardcoded client-side (CLI-is-kernel
    zero-divergence law). Design brief: docs/reference-viewer-panel.md.
    """
    from superclaw.file_view import (
        FILE_VIEW_ERROR_CODES,
        FILE_VIEW_MAX_BYTES,
        FILE_VIEW_SCAN_CAP,
    )

    return {
        "max_bytes": FILE_VIEW_MAX_BYTES,
        "scan_cap_bytes": FILE_VIEW_SCAN_CAP,
        "render_categories": ["markdown", "text", "binary"],
        # binary repo files return metadata only — no content, no download.
        "binary_download": False,
        "error_codes": list(FILE_VIEW_ERROR_CODES),
        "posture": {
            # files are read ONLY from the run's own trusted checkout, fail-closed
            "trusted_root": "run.execution_context.repo_path (ACTIVE workspace)",
            "sensitive_denied_not_redacted": True,
            "symlinks_refused": True,
        },
    }


def build_preview_contract() -> dict[str, Any]:
    """Shared spec for the reference-viewer URL preview-proxy (CLI / API / Web).

    Surfaces render FROM this contract — the stable error-code set and limits
    must not be re-hardcoded client-side. The v1 posture is a sanitized,
    non-navigable reader document: the rendered body makes zero browser network
    requests (no subresources, no navigation). Design: docs/reference-viewer-panel.md §10.
    """
    from superclaw.web_preview import (
        PREVIEW_MAX_BYTES,
        PREVIEW_TICKET_TTL_S,
        _PREVIEW_ERROR_CODES,
    )

    return {
        "max_bytes": PREVIEW_MAX_BYTES,
        "ticket_ttl_seconds": PREVIEW_TICKET_TTL_S,
        "error_codes": list(_PREVIEW_ERROR_CODES),
        "posture": {
            "mode": "sanitized_non_navigable_reader",
            "fetch": (
                "server-side, SSRF-guarded (default-deny non-global IPs, pinned IP); "
                "when a system proxy is configured and allowed, routes through it "
                "under a hostname-level gate so fake-IP/split-tunnel proxies work"
            ),
            "renders_subresources": False,
            "navigable": False,
            "credentials_forwarded": False,
            # When true (default) the fetch may route through the OS-configured
            # proxy for the target; surfaces expose a per-request opt-out.
            "proxy_aware": True,
        },
    }


def build_company_logo_contract() -> dict[str, Any]:
    """Shared spec for the company custom-logo capability (CLI / API / Web).

    Surfaces render FROM this contract — the upload limit, accepted formats, and
    the stable error-code set must never be re-hardcoded client-side (CLI-is-kernel
    zero-divergence law, 铁律3). The single source of truth lives in
    ``company_logo``; this only re-projects it. Design brief: docs/company-logo.md.
    """
    from superclaw.company_logo import (
        COMPANY_LOGO_ERROR_CODES,
        COMPANY_LOGO_MAX_BYTES,
        COMPANY_LOGO_MIME_TYPES,
    )

    return {
        "max_bytes": COMPANY_LOGO_MAX_BYTES,
        "accepted_mime_types": list(COMPANY_LOGO_MIME_TYPES),
        "error_codes": list(COMPANY_LOGO_ERROR_CODES),
        "posture": {
            # SVG is rejected on upload — untrusted XML / XSS surface.
            "svg_accepted": False,
            # The declared Content-Type is ignored; only the sniffed magic bytes
            # decide the format, so a lying Content-Type cannot smuggle anything.
            "magic_byte_sniff_authoritative": True,
            # The profile stores a filename reference, never the image bytes.
            "stored_as_reference": True,
            # Logos are instance-level visual assets — never part of the
            # company-as-code export bundle.
            "excluded_from_export": True,
            # When no custom logo is set the web surface renders a deterministic
            # identicon derived from the company id.
            "fallback": "deterministic identicon from company_profile_id",
        },
    }
