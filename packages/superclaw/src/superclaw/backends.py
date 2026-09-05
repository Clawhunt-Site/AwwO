from __future__ import annotations

import contextlib
import os
import json
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from superclaw import trace_context
from superclaw.codex_app_server import (
    CodexAppServerClient,
    CodexAppServerError,
    CodexAppServerSession,
    CodexApprovalDecision,
    check_codex_app_server_binary,
)
from superclaw.claude_stream import run_claude_stream
from superclaw.escalation import EscalationDenied
from superclaw.secure_fs import harden_path
from superclaw.permissions import (
    PresetMap,
    PresetRealization,
    make_presets,
    posture_denies_tool,
    posture_for_mode,
)
from superclaw.containment import (
    ContainmentPolicy,
    containment_denies_read_path,
    containment_denies_tool,
)
from superclaw.credential_guard import (
    CredentialAccessError,
    assert_command_allowed,
    assert_file_access_allowed,
    scrub_operator_authority_env,
)
from superclaw.environment import DEFAULT_ANTHROPIC_BASE_URL, anthropic_base_url
from superclaw.local_agent_runtime import (
    app_server_runtime_spec,
    api_agent_runtime_spec,
    cli_agent_runtime_spec,
)
from superclaw.models import (
    GoalSpec,
    PRIMARY_EVIDENCE_TEXT_LIMIT,
    RunSession,
    TaskNode,
    WorkerResult,
)
from superclaw.runtime import (
    PermissionPolicy,
    codex_cli_mode,
    desktop_toolchain_path,
    find_codex_executable,
    redact_secrets,
)
from superclaw.prompt_contracts import (
    PromptEnvelope,
    PromptLayerKind,
    PromptProjectionCapabilities,
    PromptProjectionResult,
    project_prompt_envelope,
    prompt_layer,
)


@dataclass(frozen=True)
class BackendAvailability:
    name: str
    available: bool
    executable: str | None = None
    version: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class WorkerLimits:
    repo_path: Path
    artifact_dir: Path
    budget_seconds: int = 60
    permission_policy: PermissionPolicy | None = None
    # True when repo_path is an inode-pinned real-folder project (set by the
    # orchestrator after the execution choke point validated it). Backends must
    # then NOT auto-(re)create the cwd: a missing directory at run time is a
    # tamper/deletion signal, so they execute in the validated dir or fail —
    # never silently re-materialize a deleted/swapped project folder.
    protected_cwd: bool = False
    cancel_check: Callable[[], bool] | None = None
    # Optional live event sink: ``sink(event_type, payload)``. Streaming-capable
    # adapters (codex app-server today) call it as output arrives so the runtime
    # can persist + push events live. Non-streaming backends ignore it. Bound to
    # a run_id by the orchestrator; defaults to None so backends and tests that
    # do not stream are unaffected.
    event_sink: Callable[[str, dict[str, object]], None] | None = None
    # Short, model-facing note about the SuperClaw plugins available this run
    # (injected into the worker prompt). None when no plugins are projected.
    plugin_capabilities_note: str | None = None
    # @skill overlay ids for this run (from chat_turn's ChatRoutePlan.skill_ids).
    # Each backend resolves these through superclaw.skill_runtime against its OWN
    # capability: prose skills are projected into the backend's run-scoped skill
    # directory; a tool-skill on a backend without MCP support is fail-closed
    # (the run is refused, never silently degraded). Empty = no skill overlay.
    skill_ids: tuple[str, ...] = ()
    # Semantic-discovery catalog (built fail-closed + bounded by
    # superclaw.skill_runtime.build_available_skill_catalog) for a CHAT turn that did
    # NOT name an explicit @skill: the available native skills' names/descriptions
    # (and bodies within budget) so the model can apply a relevant one on its own.
    # Computed by the chat entry point (so it is chat-only and honors the
    # semantic_skill_autotrigger toggle) and inlined into TOOL_CONTRACT. Empty = none.
    available_skill_catalog: str = ""
    # Canonical base prompt envelope for this run, built by the orchestrator when
    # team identity is bound. Backends merge in their runtime/task-specific layer
    # and project it through runtime capabilities before dispatch.
    prompt_envelope: PromptEnvelope | None = None
    # Per-run model override (CLI --model / chat runtime selection). Takes
    # precedence over the backend's SUPERCLAW_*_MODEL env default. A backend that
    # cannot honor an explicit override MUST fail closed (refuse the run) rather
    # than silently executing on a different model than the user selected.
    model_override: str | None = None
    # Per-run reasoning-effort / thinking-level override (CLI --effort / chat
    # runtime selection). Each runtime carries its OWN native levels (codex's
    # model_reasoning_effort low/medium/high/xhigh, claude's
    # low/medium/high/xhigh/max, opencode's provider-specific --variant); the
    # value is the raw native level, NOT a unified vocabulary. Resolved via
    # ``_resolve_effort`` (override > SUPERCLAW_*_EFFORT env > none). A backend
    # whose AGENT_CONTROL_SPECS spec declares supports_effort_selection=False MUST
    # fail closed on an explicit override (EFFORT_OVERRIDE_UNSUPPORTED) rather than
    # silently dropping it — the kernel rejects regardless of whether a surface
    # rendered the picker. ``default_effort`` in the spec is DISPLAY-ONLY and is
    # never backfilled here as an explicit request.
    effort_override: str | None = None
    # Escalation gate for the B-class (in-process) tool layer. Called as
    # ``gate(tool_name, args, reserved_path)`` before a dangerous action (shell /
    # reserved-path write) executes under a non-`full` posture. It consumes an
    # approved single-use grant and returns (proceed), or raises EscalationPending
    # so the orchestrator suspends the run for human review. Bound by the
    # orchestrator to the run's id + principal. None when no approval channel exists
    # (e.g. direct chat, tests) — the tool layer then fail-closes the action.
    escalation_gate: Callable[[str, dict, str | None], None] | None = None
    # Native approval broker for codex app-server (P2/D5): bridges codex's own
    # ``requestApproval`` into the SuperClaw escalation queue (human-in-the-loop) instead
    # of the static auto-answer. Bound by the orchestrator to the run's id + principal,
    # and only when opted in (SUPERCLAW_NATIVE_APPROVAL_BROKER) under a non-full posture.
    # None ⇒ the codex session keeps its legacy static decision (back-compat).
    native_approval_broker: Any | None = None
    # Resolved runtime containment fence (T11). None = standard (no extra
    # fence). A low-trust policy here means the backend MUST run read-only with no
    # untrusted-code data-plane egress; the orchestrator refuses to dispatch to a
    # backend whose supports_containment() returns False rather than downgrade.
    containment_policy: "ContainmentPolicy | None" = None
    # Company-management command resolver for the B-class tool layer (PR-F). Called
    # SYNCHRONOUSLY as ``resolver(command_type, args) -> str`` when the chat agent
    # invokes one of the projected company tools (company_create/.../issue_delegate).
    # The orchestrator binds it to the run's store + principal + acting company so
    # ``_exec_tool`` — which has no StateStore of its own — can route the call
    # through ``company_handler.execute_company_command`` IN-LOOP and return a
    # result string straight back into the agent's tool-result message (no run
    # suspension; a company create/assign is synchronous, unlike a delegated child
    # run). It returns a model-facing string for EVERY outcome (executed /
    # pending_approval / error) — it never raises into the agent loop. None when no
    # store is bound (tests / surfaces without a kernel) — the tool layer then
    # fail-closes the call with an explicit "unavailable" result.
    company_command_resolver: Callable[[str, dict], str] | None = None
    # ClawHunt marketplace command resolver for the B-class tool layer (P3). Same
    # shape/contract as ``company_command_resolver`` — ``resolver(command_type, args)
    # -> str``, never raises — but routes through
    # ``marketplace_handler.execute_marketplace_command``: reads (browse/inspect) run
    # IN-LOOP and return their result; writes (post/bid/claim/submit/abandon) return
    # a pending-approval string (human-gated, the remote ClawHunt action never runs
    # on the default path). None when no store/scope is bound — the tool layer then
    # fail-closes with an explicit "unavailable" result.
    marketplace_command_resolver: Callable[[str, dict], str] | None = None
    # Company READ resolver for the B-class tool layer (roadmap P0). Same shape/
    # contract as ``company_command_resolver`` — ``resolver(command_type, args) ->
    # str``, never raises — but routes through ``company_read.execute_company_read``:
    # discovery (company.list) + snapshot (company.snapshot) run IN-LOOP and return
    # their DTO as a JSON string. Read-only (no mutation, no approval), so unlike the
    # mutation resolver these tools are NOT in _MUTATING_TOOLS and stay available
    # under a read-only posture. None when no store/scope is bound — the tool layer
    # then fail-closes the call with an explicit "unavailable" result.
    company_read_resolver: Callable[[str, dict], str] | None = None
    # ClawWork Tier 2 native chat session (consumed only by ClawWorkBackend.run).
    # When set, the run resumes/continues ClawWork's own on-disk session via
    # ``--session-id`` instead of the default ``--no-session`` one-shot. The caller
    # (execute_clawwork_native_chat_turn) owns the resume pre-flight / retire / lock
    # lifecycle in the chat layer; the backend only projects these into the spawn.
    # ``native_session_id`` must satisfy clawwork_session.is_valid_native_session_id;
    # ``native_session_dir`` is the SuperClaw-owned durable 0700 directory.
    native_session_id: str | None = None
    native_session_dir: "Path | None" = None
    # True when the caller believes this is a RESUME (a prior binding existed). The
    # backend re-verifies the durable session file UNDER the native lock before the
    # spawn (TOCTOU): if the caller expected resume but the session is no longer a
    # unique header-verified match, run() fails closed with CLAWWORK_NATIVE_SESSION_LOST
    # rather than letting --session-id silently start an empty session. The chat
    # executor maps that failure to a binding retire + full-seed on the next turn.
    native_session_expect_resume: bool = False


class WorkerBackend(Protocol):
    name: str

    def available(self) -> BackendAvailability:
        ...

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        ...

    def permission_presets(self) -> PresetMap:
        """REQUIRED. Declare how this runtime realizes the two presets
        (ask / allow). Enforced by tests/test_permission_presets.py — a new
        backend that omits this fails the registry conformance test.
        See docs/permission-mode-framework.md."""
        ...

    def supports_containment(self, policy: "ContainmentPolicy") -> bool:
        """Whether this backend can PROVABLY execute the given containment fence
        (T11). The orchestrator refuses to dispatch a run to a backend that
        returns False — fail-closed, never downgraded. The default (see
        ``backend_supports_containment``) admits the standard preset for every
        backend and admits low-trust ONLY for backends that override this to
        prove a real read-only + no-egress posture (PR-A: the in-process B-class
        runtime; other backends gain native-sandbox proofs in PR-B)."""
        ...


def backend_supports_containment(backend: "WorkerBackend", policy: ContainmentPolicy | None) -> bool:
    """Fail-closed containment-capability check for a backend.

    ``supports_containment`` is OPTIONAL on a backend (not every backend needs to
    implement it). The default contract is fail-closed: the standard preset is
    admitted everywhere (it is today's behaviour), but a low-trust fence is
    admitted ONLY when the backend explicitly proves it can enforce it. A backend
    that does not implement ``supports_containment`` therefore REFUSES low-trust
    work — exactly the desired "no silent downgrade" posture."""
    if policy is None or not policy.is_low_trust:
        return True
    prover = getattr(backend, "supports_containment", None)
    if prover is None:
        return False
    try:
        return bool(prover(policy))
    except Exception:
        # A capability probe that errors must not be read as "supported".
        return False


def _resolve_model(limits: WorkerLimits, *env_vars: str, default: str | None = None) -> str | None:
    """Resolve the model for a run: explicit per-run override first, then the
    backend's env default(s), then ``default``. Returns None when nothing is set
    (backend CLI then uses its own configured default)."""
    override = (limits.model_override or "").strip()
    if override:
        return override
    for var in env_vars:
        value = (os.environ.get(var) or "").strip()
        if value:
            return value
    return default


def _resolve_effort(limits: WorkerLimits, *env_vars: str, default: str | None = None) -> str | None:
    """Resolve the reasoning-effort level for a run: explicit per-run override
    first, then the backend's SUPERCLAW_*_EFFORT env default(s), then ``default``.
    Returns None when nothing is set (the backend then omits the effort flag and
    the runtime uses its own configured default). Mirrors ``_resolve_model`` so a
    surface that sets nothing never forces an effort the user did not pick."""
    override = (limits.effort_override or "").strip()
    if override:
        return override
    for var in env_vars:
        value = (os.environ.get(var) or "").strip()
        if value:
            return value
    return default


def _stringify(command: list[str]) -> str:
    return " ".join(command)


def _windows_cmd_safe_args(command: list[str]) -> list[str]:
    if os.name != "nt" or not command:
        return command
    if Path(command[0]).suffix.lower() not in {".cmd", ".bat"}:
        return command
    return [item.replace("\r\n", " ").replace("\n", " ").replace("\r", " ") for item in command]


def _safe_name(value: str) -> str:
    return "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in value)


def _first_line_version(completed: "subprocess.CompletedProcess[str]") -> str | None:
    """First non-empty line of a ``--version`` probe, truncated, or None.

    Guards the empty/whitespace-only case: ``"  \\n".strip().splitlines()`` is
    ``[]``, so a naive ``[0]`` would IndexError on a CLI that prints only blank
    output to a version probe.
    """
    text = (completed.stdout or completed.stderr or "").strip()
    lines = text.splitlines()
    return lines[0][:120] if lines else None


def _policy_dict(policy: PermissionPolicy | None) -> dict[str, object]:
    return policy.to_dict() if policy else PermissionPolicy().to_dict()


def _transcript_safe_policy_dict(policy: PermissionPolicy | None) -> dict[str, object]:
    """Policy view safe to persist in a transcript artifact.

    The raw ``_policy_dict`` carries absolute ``mcp_configs`` / ``plugin_dirs``
    filesystem paths. Those paths are governance-internal (where SuperClaw
    materialized the proxy config / plugin set) and have no business in an
    evidence artifact — a fail-closed run that *rejected* a plugin policy
    especially should not echo the rejected paths back into the transcript. Keep
    the governance-relevant shape (mode, tool lists, and whether MCP/plugin
    projection was present, as counts) but drop the paths themselves.
    """
    raw = _policy_dict(policy)
    safe = dict(raw)
    for key in ("mcp_configs", "plugin_dirs"):
        value = raw.get(key)
        if isinstance(value, list):
            safe[key] = {"count": len(value)}
    return safe

def _redacted_json_value(value: object) -> object:
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    try:
        return json.loads(redact_secrets(rendered))
    except json.JSONDecodeError:  # pragma: no cover - redaction should preserve JSON shape
        return redact_secrets(rendered)


def _toml_value(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _codex_mcp_server_segment(value: str) -> str:
    normalized = "".join(char if char.isalnum() or char == "_" else "_" for char in value).strip("_")
    if not normalized:
        raise ValueError("MCP server name is empty after normalization")
    return normalized


def _secret_free_mcp_servers(config_paths: list[str], *, backend_name: str) -> list[tuple[str, dict[str, object]]]:
    """Load generated SuperClaw MCP configs without allowing secret env blocks."""
    servers_to_project: list[tuple[str, dict[str, object]]] = []
    for config_path in config_paths:
        path = Path(config_path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise ValueError("MCP config cannot be read") from exc
        except json.JSONDecodeError as exc:
            raise ValueError("MCP config is not valid JSON") from exc
        servers = payload.get("mcpServers") if isinstance(payload, dict) else None
        if not isinstance(servers, dict) or not servers:
            raise ValueError("MCP config has no mcpServers object")
        for raw_name, server_config in servers.items():
            if not isinstance(server_config, dict):
                raise ValueError(f"MCP server config must be an object: {raw_name}")
            if "env" in server_config:
                raise ValueError(f"MCP server env is not supported for {backend_name} projection: {raw_name}")
            command = server_config.get("command")
            args = server_config.get("args", [])
            if not isinstance(command, str) or not command:
                raise ValueError(f"MCP server command must be a non-empty string: {raw_name}")
            if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
                raise ValueError(f"MCP server args must be a string array: {raw_name}")
            servers_to_project.append((str(raw_name), {"command": command, "args": args}))
    return servers_to_project


def _codex_mcp_config_overrides(config_paths: list[str]) -> list[str]:
    """Convert SuperClaw proxy MCP JSON configs into Codex `-c` overrides.

    Codex does not accept Claude-style `--mcp-config <json-file>` in exec mode.
    SuperClaw therefore projects only the secret-free command/args subset from
    generated MCP config files into Codex config overrides.
    """
    overrides: list[str] = []
    for raw_name, server_config in _secret_free_mcp_servers(config_paths, backend_name="Codex"):
        command = str(server_config["command"])
        args = list(server_config["args"])  # type: ignore[arg-type]
        segment = _codex_mcp_server_segment(raw_name)
        overrides.extend(
            [
                "-c",
                f"mcp_servers.{segment}.command={_toml_value(command)}",
                "-c",
                f"mcp_servers.{segment}.args={_toml_value(args)}",
            ]
        )
    return overrides


class LocalShellBackend:
    name = "local"
    failure_markers: tuple[str, ...] = ()
    # Display Protocol DL4: does this backend surface a LIVE tool lifecycle
    # (canonical tool.* during execution)? Only the streaming projector-wired
    # backends (codex app-server, claude stream) do. Everything else is BATCH —
    # it emits one honest adapter.diagnostic instead. Used to gate the diagnostic
    # on the non-subprocess (`_synthetic_result`) path so a streaming backend's
    # pre-execution error is never mislabelled batch.
    surfaces_live_tools: bool = False
    # Does this backend execute company-management commands IN-LOOP via the
    # orchestrator-bound ``WorkerLimits.company_command_resolver``? Only the
    # B-class native-harness providers (gemini-agent / anthropic-agent, which own
    # their own tool loop) do — see ``_RealToolExecution._maybe_add_company_tools``.
    # A-class native backends (codex/claude) have no such loop and instead receive
    # the company contract via the team MCP proxy (``team_mcp_proxy``). The
    # orchestrator reads this flag to inject the MCP config for A-class team runs
    # ONLY, so the two paths never double-stack the same vocabulary.
    surfaces_company_tools_in_loop: bool = False
    # Does this backend honor a per-run reasoning-effort / thinking-level override
    # (WorkerLimits.effort_override)? Default False — a backend that cannot project
    # an explicit effort onto its runtime MUST refuse the run (fail closed) rather
    # than silently dropping the user's selection. Only backends with a verified
    # native per-run effort mechanism flip this to True (codex exec, codex
    # app-server, claude, opencode). This is the runtime-side mirror of the
    # AGENT_CONTROL_SPECS ``supports_effort_selection`` contract flag; a drift test
    # asserts the two agree so a surface never offers what a backend will reject.
    supports_effort: bool = False

    def _effort_unsupported_guard(
        self,
        *,
        task: TaskNode,
        session: RunSession,
        limits: WorkerLimits,
    ) -> WorkerResult | None:
        """Fail-closed guard: a backend that does not support reasoning-effort
        selection MUST refuse an explicit override instead of silently ignoring it
        (mirrors the model_override refusal in local/openclaw-gateway). Returns a
        synthetic exit-1 WorkerResult when ``effort_override`` is set on a
        non-supporting backend, else None. Called at the TOP of every backend's
        run() so the kernel rejects regardless of which surface (or none) rendered
        the picker; it is a no-op for backends with supports_effort=True."""
        if self.supports_effort:
            return None
        effort = (limits.effort_override or "").strip()
        if not effort:
            return None
        started_at = time.time()
        started = time.monotonic()
        return self._synthetic_result(
            task=task,
            session=session,
            limits=limits,
            command_repr=f"{self.name} effort selection",
            output=(
                f"EFFORT_OVERRIDE_UNSUPPORTED: the {self.name} backend does not support a "
                f"reasoning-effort selection ({effort}); clear the effort selection or pick a "
                "backend that does (codex / codex-app-server / claude / opencode)"
            ),
            exit_code=1,
            started_at=started_at,
            finished_at=time.time(),
            duration=time.monotonic() - started,
        )

    def _skill_overlay_guard(
        self,
        *,
        task: TaskNode,
        session: RunSession,
        limits: WorkerLimits,
    ) -> WorkerResult | None:
        """Fail-closed guard: if this turn's @skill overlays cannot all be served
        (unknown id, tool-skill on a prose-only backend, unreadable / too-large
        prose), refuse the whole run with a synthetic exit-1 — never proceed having
        silently dropped a skill the user explicitly invoked. Mirrors ClawWork's
        file-projection ``SKILL_UNAVAILABLE`` refusal and the effort guard's shape.

        Resolving here (at the TOP of run()) ALSO caches the resolved text on the
        per-run ``session`` (a transient attribute, not a serialized field), so the
        later in-prompt injection in ``_prompt_envelope`` reuses it instead of reading
        the store a second time — one resolution per run (no read→build TOCTOU, no
        second mid-build raise). A no-op when there are no skill_ids. Called by
        backends that opt into @skill via ``skill_capability``."""
        from superclaw.skill_runtime import SkillRuntimeError

        try:
            text = self._inline_skill_overlay_text(limits)
        except SkillRuntimeError as exc:
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr=f"{self.name} skill overlay",
                output=f"SKILL_UNAVAILABLE: {exc}",
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        # Cache the resolved overlay text on the per-run session so _prompt_envelope
        # reuses it (single resolution per run). Transient attribute — never a
        # serialized RunSession field.
        if session is not None:
            session._skill_overlay_text = text
        return None

    def _invalid_effort_result(
        self,
        *,
        task: TaskNode,
        session: RunSession,
        limits: WorkerLimits,
        effort: str,
        levels: tuple[str, ...],
    ) -> WorkerResult:
        """Fail-LOUD on a typo'd effort level for a select-mode backend, instead of
        handing the CLI a malformed arg it rejects with a generic usage error
        (e.g. claude's EFFORT_INVALID guard)."""
        started_at = time.time()
        started = time.monotonic()
        return self._synthetic_result(
            task=task,
            session=session,
            limits=limits,
            command_repr=f"{self.name} effort validation",
            output=(
                f"EFFORT_INVALID: effort={effort!r} is not one of {'/'.join(levels)} for the "
                f"{self.name} backend; fix or clear the effort selection"
            ),
            exit_code=1,
            started_at=started_at,
            finished_at=time.time(),
            duration=time.monotonic() - started,
        )

    def permission_presets(self) -> PresetMap:
        return make_presets(
            ask=PresetRealization("local shell exec (no native sandbox/approval gate)", False, "perm.note.local.ask", preset_driven=False),
            allow=PresetRealization("local shell exec (unrestricted)", False, "perm.note.local.allow", preset_driven=False),
        )

    def available(self) -> BackendAvailability:
        return BackendAvailability(name=self.name, available=True, executable=sys.executable, version=sys.version.split()[0])

    def _default_command(self, task: TaskNode, goal: GoalSpec) -> list[str]:
        text = f"local worker {task.role.value} completed for {goal.title}"
        return [sys.executable, "-c", f"print({text!r})"]

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        if limits.model_override:
            # The built-in local worker has no model at all; honoring is impossible,
            # so refuse rather than silently running without the selection.
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="local model selection",
                output=(
                    f"MODEL_OVERRIDE_UNSUPPORTED: the local builtin backend has no model; "
                    f"clear the model selection ({limits.model_override}) or pick another backend"
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        return self.run_command(self._default_command(task, goal), task=task, goal=goal, session=session, limits=limits)

    def _emit_batch_diagnostic(
        self,
        limits: WorkerLimits,
        *,
        task: TaskNode | None = None,
        session: RunSession | None = None,
        suffix: str = "batch",
    ) -> None:
        """Emit ONE canonical ``adapter.diagnostic`` (Display Protocol DL4) for a
        BATCH (non-streaming) execution, so the surface honestly shows "batch, no
        live tools" rather than spinning forever or fabricating tool traces.

        Called UP FRONT (before execution) by the delivery chokepoint
        (``orchestrator``, before ``backend.run``) for non-streaming backends, and
        by ``run_command`` only for a STREAMING backend that fell back to a
        subprocess (its stream produced nothing parseable — that fallback is batch).
        NOT called for the streaming happy path (codex-app-server uses run_turn,
        claude uses run_claude_stream) — they surface real tool lifecycle, so they
        must never be mislabelled batch. Best-effort: a display failure never
        breaks the run."""
        if limits.event_sink is None:
            return
        try:
            from superclaw.display_projection import build_adapter_diagnostic

            event_id = None
            if task is not None and session is not None:
                event_id = f"adapter.diagnostic:{session.run_id}:{task.task_id}:{self.name}:{suffix}"
            diag = build_adapter_diagnostic(
                self.name,
                f"{self.name} runs as a batch (non-streaming) runtime; tool calls are not surfaced live",
                event_id=event_id,
            )
            limits.event_sink(diag.type, diag.to_dict())
        except Exception:  # pragma: no cover - display is best-effort
            pass

    def run_command(
        self,
        command: list[str],
        *,
        task: TaskNode,
        goal: GoalSpec,
        session: RunSession,
        limits: WorkerLimits,
        transcript_extra: dict[str, Any] | None = None,
    ) -> WorkerResult:
        command = _windows_cmd_safe_args(command)
        del goal
        started_at = time.time()
        started = time.monotonic()
        # BATCH runtime honesty (Display Protocol DL4): a subprocess (non-streaming)
        # worker emits no tool.* live. For ordinary non-streaming backends the
        # diagnostic is emitted UP FRONT by the delivery chokepoint (orchestrator,
        # before backend.run) or the chat path — emitting again here would double.
        # The one case that reaches run_command WITHOUT an up-front emit is a
        # STREAMING backend (surfaces_live_tools=True, e.g. claude) whose stream
        # yielded nothing parseable and fell back to a subprocess: that fallback IS
        # batch, so disclose it here. Streaming backends never hit the orchestrator
        # emit (they are skipped there), so there is no double.
        if self.surfaces_live_tools:
            self._emit_batch_diagnostic(limits, task=task, session=session, suffix="fallback")
        attempt_index = max(1, int(session.task_attempts.get(task.task_id, 1)))
        timed_out = False
        cancelled = False
        forced_kill = False
        stdout = ""
        stderr = ""
        exit_code = 0
        try:
            popen_kwargs = {
                "cwd": limits.repo_path,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            else:
                popen_kwargs["start_new_session"] = True
            # Propagate trace correlation to the child via env (a superclaw child
            # reads it back; external backend CLIs inherit it harmlessly). SCRUB
            # operator-authority vars (e.g. SUPERCLAW_CONTROL_TOKEN) so an agent
            # backend can never inherit the operator's ambient API authority and
            # bypass governance via the loopback API (route B).
            popen_kwargs["env"] = scrub_operator_authority_env(trace_context.child_env())
            process = subprocess.Popen(command, **popen_kwargs)
            stdout_parts: list[str] = []
            stderr_parts: list[str] = []

            def read_stream(stream, sink: list[str]) -> None:
                if stream is None:
                    return
                try:
                    sink.append(stream.read() or "")
                except Exception as exc:  # pragma: no cover - defensive pipe read detail
                    sink.append(f"\nSuperClaw stream read failed: {type(exc).__name__}: {exc}\n")

            stdout_thread = threading.Thread(target=read_stream, args=(process.stdout, stdout_parts), daemon=True)
            stderr_thread = threading.Thread(target=read_stream, args=(process.stderr, stderr_parts), daemon=True)
            stdout_thread.start()
            stderr_thread.start()

            deadline = started + max(0.001, float(limits.budget_seconds))
            while True:
                return_code = process.poll()
                if return_code is not None:
                    exit_code = int(return_code)
                    break
                if limits.cancel_check and limits.cancel_check():
                    cancelled = True
                    exit_code = 130
                    forced_kill = self._terminate_process(process)
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    exit_code = 124
                    forced_kill = self._terminate_process(process)
                    break
                time.sleep(0.05)

            stdout_thread.join(timeout=1.0)
            stderr_thread.join(timeout=1.0)
            stdout = "".join(stdout_parts)
            stderr = "".join(stderr_parts)
            output = stdout + stderr
            if cancelled:
                output = f"Command cancelled by SuperClaw\n{output}"
            elif timed_out:
                output = f"Command timed out after {limits.budget_seconds}s\n{output}"
        except OSError as exc:
            exit_code = 127
            output = f"{type(exc).__name__}: {exc}"
            stderr = output
        duration = time.monotonic() - started
        finished_at = time.time()
        failure_marker = self._failure_marker(output)
        if exit_code == 0 and failure_marker and not cancelled and not timed_out:
            exit_code = 126
            output = f"{output}\nSuperClaw classified backend output as failure: {failure_marker}"

        limits.artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_id = _safe_name(f"{session.run_id}_{task.task_id}_{self.name}_attempt_{attempt_index:02d}")
        artifact_path = limits.artifact_dir / f"{artifact_id}.log"
        redacted_output = redact_secrets(output)
        redacted_output_length = len(redacted_output)
        redacted_stdout = redact_secrets(stdout)
        redacted_stderr = redact_secrets(stderr)
        artifact_path.write_text(
            "\n".join(
                [
                    f"backend={self.name}",
                    f"task_id={task.task_id}",
                    f"role={task.role.value}",
                    f"attempt_index={attempt_index}",
                    f"command={redact_secrets(_stringify(command))}",
                    f"exit_code={exit_code}",
                    f"started_at={started_at:.6f}",
                    f"finished_at={finished_at:.6f}",
                    f"duration_seconds={duration:.3f}",
                    f"timed_out={str(timed_out).lower()}",
                    f"cancelled={str(cancelled).lower()}",
                    f"forced_kill={str(forced_kill).lower()}",
                    "",
                    redacted_output,
                ]
            ),
            encoding="utf-8",
        )
        transcript_artifact_id = _safe_name(f"{session.run_id}_{task.task_id}_{self.name}_attempt_{attempt_index:02d}_transcript")
        transcript_path = limits.artifact_dir / f"{transcript_artifact_id}.json"
        transcript_payload = {
            "backend": self.name,
            "task_id": task.task_id,
            "role": task.role.value,
            "attempt_index": attempt_index,
            "goal_id": session.goal_id,
            "run_id": session.run_id,
            "chat_session_id": session.chat_session_id,
            "command": redact_secrets(_stringify(command)),
            "argv": [redact_secrets(item) for item in command],
            "exit_code": exit_code,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": duration,
            "timed_out": timed_out,
            "cancelled": cancelled,
            "forced_kill": forced_kill,
            "stdout": redacted_stdout,
            "stderr": redacted_stderr,
            "stdout_tail": redacted_stdout[-8000:],
            "stderr_tail": redacted_stderr[-8000:],
            "permission_policy": _transcript_safe_policy_dict(limits.permission_policy),
        }
        if transcript_extra:
            transcript_payload["extra"] = json.loads(redact_secrets(json.dumps(transcript_extra, ensure_ascii=False)))
        transcript_path.write_text(
            json.dumps(
                transcript_payload,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return WorkerResult(
            task_id=task.task_id,
            role=task.role.value,
            backend=self.name,
            command=redact_secrets(_stringify(command)),
            exit_code=exit_code,
            output=redacted_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:],
            duration_seconds=duration,
            attempt_index=attempt_index,
            started_at=started_at,
            finished_at=finished_at,
            timed_out=timed_out,
            cancelled=cancelled,
            forced_kill=forced_kill,
            artifact_id=artifact_id,
            artifact_path=str(artifact_path),
            transcript_artifact_id=transcript_artifact_id,
            transcript_path=str(transcript_path),
            output_truncated=redacted_output_length > PRIMARY_EVIDENCE_TEXT_LIMIT,
            output_original_length=redacted_output_length if redacted_output_length > PRIMARY_EVIDENCE_TEXT_LIMIT else None,
            stdout=redacted_stdout[-PRIMARY_EVIDENCE_TEXT_LIMIT:],
            stderr=redacted_stderr[-PRIMARY_EVIDENCE_TEXT_LIMIT:],
        )

    def _failure_marker(self, output: str) -> str | None:
        lowered = output.lower()
        return next((marker for marker in self.failure_markers if marker in lowered), None)

    def _terminate_process(self, process: subprocess.Popen[str]) -> bool:
        if os.name == "nt":
            process.kill()
            process.wait(timeout=2.0)
            return True
        try:
            process.terminate()
            process.wait(timeout=2.0)
            return False
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2.0)
            return True

    def _synthetic_result(
        self,
        *,
        task: TaskNode,
        session: RunSession,
        limits: WorkerLimits,
        command_repr: str,
        output: str,
        exit_code: int,
        started_at: float,
        finished_at: float,
        duration: float,
        cancelled: bool = False,
        timed_out: bool = False,
        forced_kill: bool = False,
        transcript_extra: dict[str, Any] | None = None,
        stream_events: list[dict[str, Any]] | None = None,
    ) -> WorkerResult:
        """Persist a worker artifact + transcript for a non-subprocess backend (e.g. an API call)
        and build a WorkerResult identical in shape to the subprocess path."""
        # BATCH runtime honesty (DL4): the batch diagnostic is emitted UP FRONT by
        # the delivery chokepoint (orchestrator, before backend.run) and the chat
        # path — NOT here. _synthetic_result runs AFTER the backend's (possibly long)
        # work, so emitting here would land too late to disclose "batch" during
        # execution. It is therefore display-silent.
        attempt_index = max(1, int(session.task_attempts.get(task.task_id, 1)))
        failure_marker = self._failure_marker(output)
        if exit_code == 0 and failure_marker and not cancelled and not timed_out:
            exit_code = 126
            output = f"{output}\nSuperClaw classified backend output as failure: {failure_marker}"
        limits.artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_id = _safe_name(f"{session.run_id}_{task.task_id}_{self.name}_attempt_{attempt_index:02d}")
        artifact_path = limits.artifact_dir / f"{artifact_id}.log"
        redacted_output = redact_secrets(output)
        redacted_output_length = len(redacted_output)
        artifact_path.write_text(
            "\n".join(
                [
                    f"backend={self.name}",
                    f"task_id={task.task_id}",
                    f"role={task.role.value}",
                    f"attempt_index={attempt_index}",
                    f"command={redact_secrets(command_repr)}",
                    f"exit_code={exit_code}",
                    f"started_at={started_at:.6f}",
                    f"finished_at={finished_at:.6f}",
                    f"duration_seconds={duration:.3f}",
                    f"timed_out={str(timed_out).lower()}",
                    f"cancelled={str(cancelled).lower()}",
                    f"forced_kill={str(forced_kill).lower()}",
                    "",
                    redacted_output,
                ]
            ),
            encoding="utf-8",
        )
        transcript_artifact_id = _safe_name(f"{session.run_id}_{task.task_id}_{self.name}_attempt_{attempt_index:02d}_transcript")
        transcript_path = limits.artifact_dir / f"{transcript_artifact_id}.json"
        transcript_payload = {
            "backend": self.name,
            "task_id": task.task_id,
            "role": task.role.value,
            "attempt_index": attempt_index,
            "goal_id": session.goal_id,
            "run_id": session.run_id,
            "chat_session_id": session.chat_session_id,
            "command": redact_secrets(command_repr),
            "exit_code": exit_code,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": duration,
            "timed_out": timed_out,
            "cancelled": cancelled,
            "forced_kill": forced_kill,
            "output": redacted_output,
            "output_tail": redacted_output[-8000:],
            "permission_policy": _transcript_safe_policy_dict(limits.permission_policy),
            "stream_events": _redacted_json_value(stream_events or []),
        }
        if transcript_extra:
            transcript_payload["extra"] = json.loads(redact_secrets(json.dumps(transcript_extra, ensure_ascii=False)))
        transcript_path.write_text(
            json.dumps(
                transcript_payload,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return WorkerResult(
            task_id=task.task_id,
            role=task.role.value,
            backend=self.name,
            command=redact_secrets(command_repr),
            exit_code=exit_code,
            output=redacted_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:],
            duration_seconds=duration,
            attempt_index=attempt_index,
            started_at=started_at,
            finished_at=finished_at,
            timed_out=timed_out,
            cancelled=cancelled,
            forced_kill=forced_kill,
            artifact_id=artifact_id,
            artifact_path=str(artifact_path),
            transcript_artifact_id=transcript_artifact_id,
            transcript_path=str(transcript_path),
            output_truncated=redacted_output_length > PRIMARY_EVIDENCE_TEXT_LIMIT,
            output_original_length=redacted_output_length if redacted_output_length > PRIMARY_EVIDENCE_TEXT_LIMIT else None,
            # A synthetic result has no subprocess streams: its ``output`` IS
            # the reply/diagnostic channel, so it doubles as stdout — otherwise
            # stdout-only consumers (chat) would swallow synthetic diagnostics
            # like GROK_PROMPT_TOO_LARGE into an empty reply.
            stdout=redacted_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:],
            stderr="",
            cost=_extract_cost_snapshot(
                backend_name=self.name,
                duration=duration,
                transcript_extra=transcript_extra,
                status="timed_out" if timed_out else ("cancelled" if cancelled else ("completed" if exit_code == 0 else "failed")),
            ),
        )


def _extract_cost_snapshot(
    *,
    backend_name: str,
    duration: float,
    transcript_extra: dict[str, Any] | None,
    status: str,
) -> dict[str, Any]:
    """Build a CostSnapshot dict from a backend turn's transcript extra.

    Pulls real token usage when the backend surfaced it (e.g. Claude stream
    ``usage``); otherwise records duration with ``usage_status=unavailable`` so
    the ledger still has an entry. Returned as a plain dict (kept off the model
    import to avoid coupling); the orchestrator wraps it into a CostEvent.
    """
    extra = transcript_extra or {}
    usage = extra.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    # Provider AND model can ride the top-level extra OR the nested runtime spec
    # emitted by ``_runtime_extra`` (``local_agent_runtime.{provider,model}``).
    # Resolve both SYMMETRICALLY: the static ``_PROVIDER_BY_BACKEND`` map normalises
    # the well-known backends, but any backend missing from it (clawwork, grok,
    # cursor, hermes, openclaw, http, …) must fall back to the provider it declared
    # in its own runtime spec instead of silently collapsing to "unknown". Before
    # this the provider read only the top-level key (which ``_runtime_extra`` never
    # writes) while model already read the nested spec — an asymmetry that left
    # every un-mapped backend's provider as "unknown".
    runtime_spec = extra.get("local_agent_runtime")
    runtime_provider = runtime_spec.get("provider") if isinstance(runtime_spec, dict) else None
    provider = str(
        extra.get("provider")
        or _PROVIDER_BY_BACKEND.get(backend_name)
        or runtime_provider
        or "unknown"
    )
    model = extra.get("model") or (runtime_spec.get("model") if isinstance(runtime_spec, dict) else None)

    def _pick(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if value is not None:
                try:
                    return int(value)
                except (TypeError, ValueError):
                    return None
        return None

    input_tokens = _pick("input_tokens", "prompt_tokens", "inputTokens")
    output_tokens = _pick("output_tokens", "completion_tokens", "outputTokens")
    cached = _pick("cache_read_input_tokens", "cached_input_tokens", "cache_read_tokens")
    has_tokens = input_tokens is not None or output_tokens is not None
    return {
        "backend": backend_name,
        "provider": provider,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached,
        "reasoning_tokens": _pick("reasoning_tokens"),
        "tool_call_count": extra.get("tool_iterations") if isinstance(extra.get("tool_iterations"), int) else None,
        "duration_seconds": float(duration),
        "meter_kind": "model_tokens" if has_tokens else "wall_clock",
        "usage_status": "actual" if has_tokens else "unavailable",
        "usage_source": "stream_event" if has_tokens else "local_timer",
        "invocation_id": extra.get("invocation_id") or extra.get("turn_id"),
        "raw_usage": usage or None,
    }


_PROVIDER_BY_BACKEND = {
    "claude": "anthropic",
    "anthropic-agent": "anthropic",
    "codex": "openai",
    "codex-app-server": "openai",
    "gemini": "google",
    "bobo": "bobo",
    "local": "local",
}


class _AgentCliBackend(LocalShellBackend):
    name = "agent"
    executable_name = "agent"
    failure_markers = (
        "sign in with chatgpt",
        "paste an api key",
        "raw mode is not supported",
        "not authenticated",
        "login required",
        "api key required",
        "invalid api key",
    )

    def __init__(self, executable: str | None = None) -> None:
        self.executable = executable

    def available(self) -> BackendAvailability:
        executable = self.executable or shutil.which(self.executable_name, path=desktop_toolchain_path())
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason=f"{self.executable_name} not found on PATH")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = (completed.stdout or completed.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def _legacy_prompt(
        self,
        task: TaskNode,
        goal: GoalSpec,
        *,
        repo_path: Path | None = None,
        capabilities_note: str | None = None,
    ) -> str:
        criteria = "; ".join(goal.acceptance_criteria) if getattr(goal, "acceptance_criteria", None) else ""
        criteria_line = f"Acceptance criteria: {criteria}\n" if criteria else ""
        repo_line = f"Repository root: {repo_path}\n" if repo_path else ""
        plugin_line = f"{capabilities_note}\n" if capabilities_note else ""
        final_line = (
            f"superclaw_worker_result backend={self.name} role={task.role.value} "
            f"goal={goal.goal_id} status=completed"
        )
        # Direct chat turn: the goal description IS the full chat prompt
        # (direct_chat_prompt already framed history/context/mutation rules).
        # Worker boilerplate — roles, acceptance criteria, the worker_result
        # marker — would misdirect the model into "doing work" over answering.
        if str((getattr(goal, "metadata", None) or {}).get("chat_turn_intent")) == "chat":
            return goal.description if not plugin_line else f"{goal.description}\n\n{plugin_line}"
        # Light agentic task (research, a plugin/tool query, Q&A turned action):
        # do NOT push the worker toward code changes/evidence — that misdirects the
        # model on non-delivery work and wastes turns. Just complete the task and
        # report, using whatever tools/plugins are available.
        if str((getattr(goal, "metadata", None) or {}).get("chat_turn_intent")) == "task":
            return (
                f"You are SuperClaw's agent. Complete the user's task directly.\n"
                f"Task: {goal.description}\n"
                f"{repo_line}"
                f"{plugin_line}"
                f"Use the available tools/plugins as needed (e.g. superclaw__list_tools, "
                f"superclaw__describe_tool, superclaw__call_tool). You do NOT need to modify files "
                f"or produce code changes — if this is research or a tool/plugin call, just do it and "
                f"report the result clearly. When done, print exactly one final line:\n"
                f"{final_line}"
            )
        return (
            f"You are a SuperClaw {task.role.value} worker contributing to goal '{goal.title}'.\n"
            f"Goal: {goal.description}\n"
            f"Task: {task.title}\n"
            f"{criteria_line}"
            f"{repo_line}"
            f"{plugin_line}"
            f"Do the {task.role.value} work for this task in the current repository, making real, "
            f"minimal, verifiable changes. When the step is complete, print exactly one final line:\n"
            f"{final_line}"
        )

    def _base_envelope_context(self, session: RunSession | None) -> Mapping[str, Any] | None:
        if session is None:
            return None
        ctx = (session.execution_context or {}).get("agent_run_context")
        return ctx if isinstance(ctx, Mapping) else None

    def _inline_skill_overlay_text(self, limits: WorkerLimits | None) -> str:
        """Resolve this run's ``@skill`` overlays into prose to inline in TOOL_CONTRACT.

        Single, fail-closed choke shared by every prompt-driven backend (no
        per-backend prompt drift): a backend opts in by declaring ``skill_capability``;
        without it (or without ``skill_ids``) this is a no-op. Resolution goes through
        the kernel's fail-closed :func:`prepare_inline_skill_overlay`, which RAISES
        :class:`SkillRuntimeError` on any unavailable skill — so a turn that addressed
        ``@skill:x`` never proceeds without x. The backend's ``run`` catches that and
        returns a clean refusal (mirrors ClawWork's file-projection ``SKILL_UNAVAILABLE``).
        Prose-only here: a tool-skill needs MCP projection, which the inline path does
        not do, so a prose-only capability fail-closes it in the kernel planner.
        """
        skill_ids = tuple(getattr(limits, "skill_ids", ()) or ()) if limits is not None else ()
        if not skill_ids:
            return ""
        capability_fn = getattr(self, "skill_capability", None)
        if not callable(capability_fn):
            # A backend that did not opt in should never have received skill_ids
            # (chat_turn gates on skill_capability); fail-closed if it somehow did.
            from superclaw.skill_runtime import SkillRuntimeError

            raise SkillRuntimeError(
                f"backend {getattr(self, 'name', '?')} received @skill overlays but declares no skill capability"
            )
        from superclaw.skill_runtime import prepare_inline_skill_overlay

        overlay = prepare_inline_skill_overlay(skill_ids, capability=capability_fn())
        parts: list[str] = []
        for slug, name, body in overlay.prose:
            parts.append(f"Apply this SuperClaw skill now — «{name}» ({slug}):\n{body}")
        return "\n\n".join(parts)

    def _cached_or_resolved_skill_overlay(
        self, limits: WorkerLimits | None, session: RunSession | None
    ) -> str:
        """Return the @skill overlay prose for this run, preferring the value cached
        by ``_skill_overlay_guard`` (single resolution per run). Falls back to
        resolving when no guard ran first (e.g. a direct ``_prompt_envelope`` caller
        without a session) — that path can still raise SkillRuntimeError fail-closed."""
        if session is not None:
            cached = getattr(session, "_skill_overlay_text", None)
            if cached is not None:
                return cached
        return self._inline_skill_overlay_text(limits)

    def _prompt_envelope(
        self,
        task: TaskNode,
        goal: GoalSpec,
        *,
        limits: WorkerLimits | None = None,
        session: RunSession | None = None,
        repo_path: Path | None = None,
        capabilities_note: str | None = None,
        runtime_adapter: str = "",
        requires_tool_projection: bool = False,
    ) -> PromptEnvelope:
        from superclaw.agent_prompt import build_agent_prompt_envelope

        task_context = self._legacy_prompt(
            task,
            goal,
            repo_path=repo_path,
            capabilities_note=capabilities_note,
        )
        skill_overlay_text = self._cached_or_resolved_skill_overlay(limits, session)
        # Semantic-discovery catalog (chat-only, no explicit @skill) — precomputed by
        # the chat entry, just inlined here. Mutually exclusive with skill_overlay_text
        # in practice (catalog is built only when no skill_ids), but harmless if both.
        catalog_text = (limits.available_skill_catalog if limits is not None else "") or ""
        if limits is None or limits.prompt_envelope is None:
            base_tool_contract = "\n\n".join(
                dict.fromkeys(
                    part
                    for part in (capabilities_note or "", skill_overlay_text, catalog_text)
                    if part
                )
            )
            return build_agent_prompt_envelope(
                self._base_envelope_context(session),
                user_turn=goal.description,
                task_context=task_context,
                runtime_adapter=runtime_adapter,
                tool_contract=base_tool_contract,
                requires_tool_projection=requires_tool_projection,
            )

        base = limits.prompt_envelope

        def _content(kind: PromptLayerKind, fallback: str = "") -> str:
            layer = base.get(kind)
            return layer.content if layer is not None else fallback

        def _native_required(kind: PromptLayerKind) -> bool:
            layer = base.get(kind)
            return bool(layer and layer.requires_native_system)

        def _tool_required(kind: PromptLayerKind) -> bool:
            layer = base.get(kind)
            return bool(layer and layer.requires_tool_projection)

        tool_contract_parts = [
            part
            for part in (
                _content(PromptLayerKind.TOOL_CONTRACT),
                capabilities_note or "",
                skill_overlay_text,
                catalog_text,
            )
            if part
        ]
        tool_contract = "\n\n".join(dict.fromkeys(tool_contract_parts))
        adapter = runtime_adapter.strip() or _content(PromptLayerKind.RUNTIME_ADAPTER)
        return PromptEnvelope.build(
            [
                prompt_layer(
                    PromptLayerKind.GOVERNANCE_CORE,
                    _content(PromptLayerKind.GOVERNANCE_CORE),
                    requires_native_system=_native_required(PromptLayerKind.GOVERNANCE_CORE),
                    requires_tool_projection=_tool_required(PromptLayerKind.GOVERNANCE_CORE),
                ),
                prompt_layer(
                    PromptLayerKind.RUNTIME_ADAPTER,
                    adapter,
                    requires_native_system=_native_required(PromptLayerKind.RUNTIME_ADAPTER),
                    requires_tool_projection=_tool_required(PromptLayerKind.RUNTIME_ADAPTER),
                ),
                prompt_layer(
                    PromptLayerKind.TOOL_CONTRACT,
                    tool_contract,
                    requires_native_system=_native_required(PromptLayerKind.TOOL_CONTRACT),
                    requires_tool_projection=_tool_required(PromptLayerKind.TOOL_CONTRACT) or requires_tool_projection,
                ),
                prompt_layer(
                    PromptLayerKind.AGENT_CHARTER,
                    _content(PromptLayerKind.AGENT_CHARTER),
                    requires_native_system=_native_required(PromptLayerKind.AGENT_CHARTER),
                    requires_tool_projection=_tool_required(PromptLayerKind.AGENT_CHARTER),
                ),
                prompt_layer(PromptLayerKind.TASK_CONTEXT, task_context),
                prompt_layer(PromptLayerKind.USER_TURN, _content(PromptLayerKind.USER_TURN, goal.description)),
            ]
        )

    def _projection_metadata_prefix(self, projection: PromptProjectionResult) -> str:
        losses = ",".join(
            f"{loss.kind.value}:{loss.layer.value if loss.layer else '*'}"
            for loss in projection.projection_loss
        ) or "none"
        cache_sections = ",".join(section.kind.value for section in projection.cache_sections) or "none"
        cache_control = projection.metadata.get("provider_cache_control", {})
        if isinstance(cache_control, Mapping):
            cache_control_status = (
                f"supported={bool(cache_control.get('supported'))};"
                f"eligible={cache_control.get('eligible_section_count', 0)};"
                f"reason={cache_control.get('unsupported_reason', '') or 'none'}"
            )
        else:
            cache_control_status = "unknown"
        return "\n".join(
            [
                "# SuperClaw Prompt Projection",
                f"projection_kind={projection.metadata.get('projection_kind', '')}",
                f"system_channel={projection.system_channel}",
                f"stable_fingerprint={projection.stable_fingerprint}",
                f"projection_loss={losses}",
                f"cache_sections={cache_sections}",
                f"cache_control={cache_control_status}",
            ]
        )

    def _projection_system_text(self, projection: PromptProjectionResult) -> str:
        sections: list[str] = []
        for layer in projection.system_layers:
            if not layer.content:
                continue
            if sections:
                sections.append("")
            sections.append(f"## {layer.kind.value}")
            sections.append(layer.content)
        return "\n".join(sections)

    def _projection_transcript_extra(self, projection: PromptProjectionResult) -> dict[str, Any]:
        return projection.audit_metadata()

    def _project_prompt(
        self,
        task: TaskNode,
        goal: GoalSpec,
        *,
        limits: WorkerLimits | None = None,
        session: RunSession | None = None,
        repo_path: Path | None = None,
        capabilities_note: str | None = None,
        capabilities: PromptProjectionCapabilities | None = None,
        native_tool_schema: list[dict] | None = None,
        runtime_adapter: str = "",
        requires_tool_projection: bool = False,
    ) -> PromptProjectionResult:
        envelope = self._prompt_envelope(
            task,
            goal,
            limits=limits,
            session=session,
            repo_path=repo_path,
            capabilities_note=capabilities_note,
            runtime_adapter=runtime_adapter,
            requires_tool_projection=requires_tool_projection,
        )
        projection_capabilities = capabilities or PromptProjectionCapabilities(
            system_channel="flatten_only",
            backend=self.name,
        )
        return project_prompt_envelope(
            envelope,
            projection_capabilities,
            native_tool_schema=native_tool_schema,
        )

    def _prompt(
        self,
        task: TaskNode,
        goal: GoalSpec,
        *,
        repo_path: Path | None = None,
        capabilities_note: str | None = None,
        limits: WorkerLimits | None = None,
        session: RunSession | None = None,
    ) -> str:
        if limits is None and session is None:
            return self._legacy_prompt(task, goal, repo_path=repo_path, capabilities_note=capabilities_note)
        projection = self._project_prompt(
            task,
            goal,
            limits=limits,
            session=session,
            repo_path=repo_path,
            capabilities_note=capabilities_note,
        )
        return f"{self._projection_metadata_prefix(projection)}\n\n{projection.flattened_prompt}"

    def _projected_cli_prompt(
        self,
        task: TaskNode,
        goal: GoalSpec,
        *,
        repo_path: Path | None = None,
        capabilities_note: str | None = None,
        limits: WorkerLimits | None = None,
        session: RunSession | None = None,
        capabilities: PromptProjectionCapabilities | None = None,
        runtime_adapter: str = "",
        native_tool_schema: list[dict] | None = None,
        requires_tool_projection: bool = False,
    ) -> tuple[str, PromptProjectionResult]:
        projection = self._project_prompt(
            task,
            goal,
            limits=limits,
            session=session,
            repo_path=repo_path,
            capabilities_note=capabilities_note,
            capabilities=capabilities,
            runtime_adapter=runtime_adapter,
            native_tool_schema=native_tool_schema,
            requires_tool_projection=requires_tool_projection,
        )
        if projection.system_channel == "native_cli_append":
            return projection.user_prompt, projection
        return f"{self._projection_metadata_prefix(projection)}\n\n{projection.flattened_prompt}", projection

    def _fail_if_custom_prompt_cannot_project(
        self,
        limits: WorkerLimits,
        *,
        capabilities: PromptProjectionCapabilities | None = None,
    ) -> None:
        if limits.prompt_envelope is None:
            return
        project_prompt_envelope(
            limits.prompt_envelope,
            capabilities or PromptProjectionCapabilities(system_channel="flatten_only", backend=self.name),
        )

    def _runtime_extra(
        self,
        *,
        executable: str,
        model: str | None = None,
        provider: str | None = None,
        api_mode: str = "cli",
        supports_mcp_configs: bool = False,
        supports_plugin_dirs: bool = False,
        system_channel: str = "flatten_only",
        per_call_system: bool = False,
        append_preserves_default: bool = False,
        override_replaces_default: bool = False,
        supports_cache_control: bool = False,
        supports_tool_schema: bool = False,
        notes: list[str] | None = None,
        prompt_projection: PromptProjectionResult | None = None,
    ) -> dict[str, Any]:
        extra = {
            "local_agent_runtime": cli_agent_runtime_spec(
                backend=self.name,
                executable=executable,
                model=model,
                provider=provider,
                api_mode=api_mode,
                supports_mcp_configs=supports_mcp_configs,
                supports_plugin_dirs=supports_plugin_dirs,
                system_channel=system_channel,  # type: ignore[arg-type]
                per_call_system=per_call_system,
                append_preserves_default=append_preserves_default,
                override_replaces_default=override_replaces_default,
                supports_cache_control=supports_cache_control,
                supports_tool_schema=supports_tool_schema,
                notes=notes,
            ).to_dict()
        }
        if prompt_projection is not None:
            extra["prompt_projection"] = self._projection_transcript_extra(prompt_projection)
        return extra


class CodexCliBackend(_AgentCliBackend):
    name = "codex"
    executable_name = "codex"

    def skill_capability(self) -> "Any":
        """Inline @skill: prose skills are injected into the TOOL_CONTRACT prompt
        layer; a tool-skill is fail-closed (no MCP projection on the inline path)."""
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.prose_only()
    supports_effort = True
    # Codex reasoning effort is a config-file value (model_reasoning_effort),
    # projected per-run via ``codex exec -c model_reasoning_effort=<v>``. Verbatim
    # from codex's OWN authoritative model metadata (~/.codex/models_cache.json
    # supported_reasoning_levels: every gpt-5.x model advertises low/medium/high/
    # xhigh — NOT "minimal", and NOT claude's "max"). Must mirror
    # AGENT_CONTROL_SPECS["codex"]["effort_levels"] (drift test).
    EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh")

    def permission_presets(self) -> PresetMap:
        return make_presets(
            # Doctrine: runtime is a pure execution engine handed max permission;
            # both presets map to bypassPermissions, so ask == allow at runtime
            # (preset_driven=False is the honest signal). SuperClaw governs above.
            ask=PresetRealization("codex exec --dangerously-bypass-approvals-and-sandbox (max; both presets)", False, "perm.note.codex.ask", preset_driven=False),
            allow=PresetRealization("codex exec --dangerously-bypass-approvals-and-sandbox (max; both presets)", False, "perm.note.codex.allow", preset_driven=False),
        )

    def _resolve_executable(self) -> tuple[str | None, str | None]:
        if self.executable:
            return self.executable, "constructor"
        return find_codex_executable(os.environ.get("SUPERCLAW_CODEX_EXECUTABLE"))

    def available(self) -> BackendAvailability:
        executable, source = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="codex executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = (completed.stdout or completed.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        mode = codex_cli_mode(executable)
        suffix = f" ({source}; {mode})" if source or mode else ""
        return BackendAvailability(name=self.name, available=True, executable=executable, version=(version or "") + suffix)

    def resolve_discovery_reachability(self) -> str:
        """Runtime-resolved discovery faithfulness (overrides the static spec for
        the reachability probe — see runtime_probe.discovery_reachability_class).

        codex's model-discovery channel is the app-server ``model/list`` method.
        Faithfulness is capability-conditioned, not a static constant, and needs
        BOTH conditions — ``exec``-capable is NOT the same as ``app-server``-ready
        (the codex-app-server backend gates availability on its own
        ``check_codex_app_server_binary``):
          * a ``legacy`` codex runs delivery fine but exposes no app-server;
          * even an ``exec`` codex may have a broken/unsupported app-server.
        In either case discovery via app-server would FALSE-FAIL, so faithfulness
        holds only when the binary is ``exec`` mode AND its app-server answers —
        otherwise ``cross_plane`` (the probe degrades to presence, not a false
        ``runtime_fail``)."""
        executable, _source = self._resolve_executable()
        if codex_cli_mode(executable) != "exec" or not executable:
            return "cross_plane"
        app_server_ok, _detail = check_codex_app_server_binary(executable)
        return "faithful" if app_server_ok else "cross_plane"

    def supports_containment(self, policy: "ContainmentPolicy") -> bool:
        """Standard runs are admitted; a low-trust fence is REFUSED (fail-closed).

        EMPIRICAL FINDING (real-binary canary, 2026-06-15): codex ``--sandbox
        read-only`` blocks WRITES, not READS — a canary `cat` of a secret file
        OUTSIDE the ``--cd`` workspace succeeded and printed it. None of codex's
        sandbox modes (read-only/workspace-write/danger) restrict reads, and there
        is no per-file read-deny flag, so codex cannot enforce the secret-read gate
        the B-class runtime / claude provide; the iron law (§0) forbids wrapping it
        in an external OS read-sandbox. A low-trust review therefore routes to a
        B-class backend (gemini/anthropic-agent), which owns tool execution and
        enforces ``containment_denies_read_path``. See
        docs/t11-low-trust-containment-design.md §3.1."""
        return not policy.is_low_trust

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        executable, _source = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "codex", 127, "codex executable not found", 0.0)
        if (skill_guard := self._skill_overlay_guard(task=task, session=session, limits=limits)) is not None:
            return skill_guard
        mode = codex_cli_mode(executable)
        if limits.containment_policy and limits.containment_policy.is_low_trust:
            # Fail-closed for a direct caller too: codex cannot enforce the read gate
            # (see supports_containment). The orchestrator already refuses dispatch.
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="codex containment projection",
                output=(
                    "CONTAINMENT_UNSUPPORTED: codex --sandbox read-only blocks writes but not reads "
                    "(no per-file read-deny); cannot enforce the low-trust secret-read gate. Use a "
                    "B-class backend (gemini/anthropic-agent) for low-trust review."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        model = _resolve_model(limits, "SUPERCLAW_CODEX_MODEL")
        if model and mode != "exec":
            # The legacy `codex -q` CLI predates a stable --model surface; running
            # anyway would silently use whatever the legacy CLI defaults to.
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="codex model selection",
                output=(
                    "MODEL_OVERRIDE_UNSUPPORTED: legacy codex CLI mode cannot honor a model "
                    f"selection ({model}); upgrade to a codex exec-capable CLI or clear the model"
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        effort = (_resolve_effort(limits, "SUPERCLAW_CODEX_EFFORT") or "").strip().lower()
        if effort and effort not in self.EFFORT_LEVELS:
            return self._invalid_effort_result(
                task=task, session=session, limits=limits, effort=effort, levels=self.EFFORT_LEVELS
            )
        if effort and mode != "exec":
            # model_reasoning_effort is projected via `codex exec -c`; the legacy
            # `codex -q` CLI has no equivalent, so refuse rather than silently drop it.
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="codex effort selection",
                output=(
                    "EFFORT_OVERRIDE_UNSUPPORTED: legacy codex CLI mode cannot honor a reasoning-effort "
                    f"selection ({effort}); upgrade to a codex exec-capable CLI or clear the effort"
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        policy = limits.permission_policy
        mcp_config_overrides: list[str] = []
        if policy:
            started_at = time.time()
            started = time.monotonic()
            if policy.plugin_dirs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="codex plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: Codex backend does not accept plugin directories; use SuperClaw MCP proxy config instead",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            try:
                mcp_config_overrides = _codex_mcp_config_overrides(policy.mcp_configs)
            except ValueError as exc:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="codex plugin runtime policy projection",
                    output=f"PLUGIN_RUNTIME_CONFIG_INVALID: {exc}",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
        if mode == "exec":
            # (Low-trust already refused above; only standard runs reach here.)
            prompt, prompt_projection = self._projected_cli_prompt(
                task,
                goal,
                repo_path=limits.repo_path,
                capabilities_note=limits.plugin_capabilities_note,
                limits=limits,
                session=session,
            )
            command = [
                executable,
                "exec",
                *mcp_config_overrides,
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "--cd",
                str(limits.repo_path),
            ]
            if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
                command.append("--dangerously-bypass-approvals-and-sandbox")
            if model:
                command.extend(["--model", model])
            if effort:
                command.extend(["-c", f"model_reasoning_effort={effort}"])
            # `--` ends option parsing: the user prompt can start with an
            # "--- BEGIN UNTRUSTED … ---" fence, which a bare positional would
            # mis-parse as an unknown `--` option (exit 1). See claude backend.
            command.extend(("--", prompt))
            return self.run_command(
                command,
                task=task,
                goal=goal,
                session=session,
                limits=limits,
                transcript_extra=self._runtime_extra(
                    executable=executable,
                    model=model,
                    api_mode="codex_exec",
                    supports_mcp_configs=bool(mcp_config_overrides),
                    notes=["modern codex exec CLI"],
                    prompt_projection=prompt_projection,
                ),
            )

        # (Unreachable under containment: a low-trust run forces mode="exec" above
        # after proving --sandbox, or refuses; only standard runs reach the legacy
        # `-q` path.)
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        command = [executable, *mcp_config_overrides, "-q", "--full-stdout"]
        if policy:
            if policy.mode in {"acceptEdits", "auto"}:
                command.extend(["--approval-mode", "auto-edit"])
            elif policy.mode in {"bypassPermissions", "dontAsk"}:
                command.extend(["--approval-mode", "full-auto"])
            else:
                command.extend(["--approval-mode", "suggest"])
        # `--` ends option parsing: the user prompt can start with an
        # "--- BEGIN UNTRUSTED … ---" fence, which a bare positional would mis-parse
        # as an unknown `--` option (exit 1). See the claude backend for the detail.
        command.extend(("--", prompt))
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                api_mode="codex_legacy_cli",
                supports_mcp_configs=bool(mcp_config_overrides),
                notes=["legacy codex CLI"],
                prompt_projection=prompt_projection,
            ),
        )


class CodexAppServerBackend(_AgentCliBackend):
    name = "codex-app-server"
    executable_name = "codex"
    surfaces_live_tools = True  # streams canonical tool.* via the codex projector (run_turn)
    supports_effort = True
    # Same reasoning-effort constants as codex exec (it is the same binary). The
    # app-server is a long-lived daemon, so effort is applied PER TURN via the
    # native turn/start.effort (CodexAppServerSession.run_turn) — NOT a process-
    # level `-c` — so one daemon serves different efforts across turns without a
    # per-effort rebuild, and effort is deliberately absent from the session cache
    # key. Mirrors AGENT_CONTROL_SPECS["codex-app-server"] and the codex exec set
    # (low/medium/high/xhigh — codex's advertised levels).
    EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh")

    def permission_presets(self) -> PresetMap:
        # Honest: the app-server raises per-action approval callbacks, but SuperClaw
        # answers them from static policy (escalations auto-declined under ask) — no
        # human is prompted. interactive stays False until an approval queue exists.
        return make_presets(
            # Doctrine: max permission for both presets (sandbox=danger-full-access,
            # approval=never). ask == allow at runtime; preset_driven=False.
            ask=PresetRealization("sandbox=danger-full-access; approval=never (max; both presets)", False, "perm.note.codexapp.ask", preset_driven=False),
            allow=PresetRealization("sandbox=danger-full-access; approval=never (max; both presets)", False, "perm.note.codexapp.allow", preset_driven=False),
        )

    failure_markers = _AgentCliBackend.failure_markers + (
        "codex app-server authentication failed",
        "codex app-server request failed",
        "codex app-server exited before turn completion",
    )

    def supports_containment(self, policy: "ContainmentPolicy") -> bool:
        """Standard runs are admitted; a low-trust fence is REFUSED (fail-closed).

        Like ``codex`` (exec), the app-server cannot enforce the secret-read gate —
        codex ``--sandbox read-only`` blocks writes, not reads (real-binary canary,
        see CodexCliBackend.supports_containment) — and it additionally has no
        ``--ignore-user-config``. The iron law forbids wrapping it in an external OS
        sandbox, so low-trust review routes to a B-class backend (gemini/anthropic-agent);
        the app-server stays out of the low-trust path."""
        return not policy.is_low_trust

    def __init__(
        self,
        executable: str | None = None,
        *,
        session_factory: Callable[..., CodexAppServerSession] | None = None,
    ) -> None:
        super().__init__(executable=executable)
        self._session_factory = session_factory
        self._sessions: dict[tuple[str, str, tuple[str, ...], str, str, CodexApprovalDecision, str], CodexAppServerSession] = {}
        self._session_use_counts: dict[tuple[str, str, tuple[str, ...], str, str, CodexApprovalDecision, str], int] = {}

    def _resolve_executable(self) -> tuple[str | None, str | None]:
        if self.executable:
            return self.executable, "constructor"
        return find_codex_executable(os.environ.get("SUPERCLAW_CODEX_EXECUTABLE"))

    def available(self) -> BackendAvailability:
        executable, source = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="codex executable not found")
        ok, detail = check_codex_app_server_binary(executable)
        if not ok:
            return BackendAvailability(name=self.name, available=False, executable=executable, reason=detail)
        suffix = f" ({source}; app-server)" if source else " (app-server)"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=(detail or "codex") + suffix)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        executable, _source = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "codex app-server", 127, "codex executable not found", 0.0)
        started_at = time.time()
        started = time.monotonic()
        policy = limits.permission_policy
        # T11 PR-B: codex cannot enforce the secret-read gate (read-only blocks writes,
        # not reads — real-binary canary), so a low-trust fence is REFUSED here too —
        # the orchestrator already declines it (supports_containment=False), but a
        # direct caller must fail closed. Low-trust review routes to a B-class backend.
        if limits.containment_policy and limits.containment_policy.is_low_trust:
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="codex app-server containment projection",
                output=(
                    "CONTAINMENT_UNSUPPORTED: codex --sandbox read-only blocks writes but not reads; "
                    "cannot enforce the low-trust secret-read gate. Use a B-class backend "
                    "(gemini/anthropic-agent) for low-trust review."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        extra_args: list[str] = []
        if policy:
            if policy.plugin_dirs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="codex app-server plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: Codex app-server backend does not accept plugin directories; use SuperClaw MCP proxy config instead",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            try:
                extra_args = _codex_mcp_config_overrides(policy.mcp_configs)
            except ValueError as exc:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="codex app-server plugin runtime policy projection",
                    output=f"PLUGIN_RUNTIME_CONFIG_INVALID: {exc}",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
        # (Low-trust already refused above; only standard runs reach here.)
        sandbox = self._sandbox_for_policy(policy)
        approval_policy = self._approval_policy_for_policy(policy)
        approval_decision = self._approval_decision_for_policy(policy)
        model = _resolve_model(limits, "SUPERCLAW_CODEX_MODEL")
        effort = (_resolve_effort(limits, "SUPERCLAW_CODEX_EFFORT") or "").strip().lower()
        if effort and effort not in self.EFFORT_LEVELS:
            return self._invalid_effort_result(
                task=task, session=session, limits=limits, effort=effort, levels=self.EFFORT_LEVELS
            )
        # Reasoning effort rides the native per-turn ``turn/start.effort`` on
        # run_turn below (process-free; the SAME mechanism the chat surface uses,
        # zero divergence). It is deliberately NOT appended to extra_args / the
        # session cache key: a reused thread runs each turn at its own requested
        # effort, and a cleared selection reverts to the thread's baseline.
        # approval_decision must be part of the key: different permission modes
        # (e.g. default vs acceptEdits) can map to the same sandbox + approval_policy
        # yet carry different auto-approve decisions. Sharing a cached session across
        # them would let a session keep the decision it was first created with.
        # model is part of the key for the same reason: a cached thread keeps the
        # model it was started with, so a different selection needs its own session.
        # effort is intentionally NOT part of the key: it is applied per turn via
        # turn/start.effort, so one cached thread can serve different efforts.
        session_key = (
            str(Path(limits.repo_path).resolve()),
            executable,
            tuple(extra_args),
            sandbox,
            approval_policy,
            approval_decision,
            model or "",
        )
        runtime_session = self._sessions.get(session_key)
        reused_session = runtime_session is not None
        if runtime_session is None:
            runtime_session = self._new_session(
                executable=executable,
                repo_path=limits.repo_path,
                extra_args=extra_args,
                sandbox=sandbox,
                approval_policy=approval_policy,
                approval_decision=approval_decision,
                model=model,
            )
            self._sessions[session_key] = runtime_session
            self._session_use_counts[session_key] = 0
        self._session_use_counts[session_key] += 1
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )

        exit_code = 0
        forced_kill = False
        result = None
        output = ""
        try:
            result = runtime_session.run_turn(
                prompt,
                budget_seconds=float(limits.budget_seconds),
                cancel_check=limits.cancel_check,
                on_event=limits.event_sink,
                native_approval_broker=limits.native_approval_broker,
                effort=effort or None,
            )
            output = result.output
            if result.cancelled:
                exit_code = 130
                output = f"Codex app-server turn cancelled by SuperClaw\n{output}"
            elif result.timed_out:
                exit_code = 124
                output = f"Codex app-server turn timed out after {limits.budget_seconds}s\n{output}"
            elif result.error:
                exit_code = 1
            if exit_code == 0:
                output += (
                    f"\nsuperclaw_worker_result backend={self.name} role={task.role.value} "
                    f"goal={goal.goal_id} status=completed"
                )
        except CodexAppServerError as exc:
            exit_code = 1
            output = f"CODEX_APP_SERVER_RUNTIME_ERROR: {exc}"
            self._retire_session(session_key)
        finally:
            if result and result.should_retire_session:
                self._retire_session(session_key)
                forced_kill = True

        finished_at = time.time()
        duration = time.monotonic() - started
        transcript_extra = {
            "runtime": "codex_app_server",
            "local_agent_runtime": app_server_runtime_spec(
                backend=self.name,
                executable=executable,
                model=model,
                api_mode="codex_app_server",
                provider="openai-codex",
                supports_mcp_configs=bool(extra_args),
                notes=["persistent codex app-server thread over JSON-RPC stdio"],
            ).to_dict(),
            "prompt_projection": self._projection_transcript_extra(prompt_projection),
            "session_key": {
                "repo_path": session_key[0],
                "executable": session_key[1],
                "extra_args": list(session_key[2]),
                "sandbox": session_key[3],
                "approval_policy": session_key[4],
                "model": session_key[6],
            },
            "session_reused": reused_session,
            "session_use_count": self._session_use_counts.get(session_key, 0),
        }
        if result:
            transcript_extra.update(
                {
                    "thread_id": result.thread_id,
                    "turn_id": result.turn_id,
                    "tool_iterations": result.tool_iterations,
                    "interrupted": result.interrupted,
                    "should_retire_session": result.should_retire_session,
                    "approval_events": result.approval_events,
                    "raw_events": result.raw_events,
                }
            )
        return self._synthetic_result(
            task=task,
            session=session,
            limits=limits,
            command_repr=f"{executable} app-server --listen stdio:// {' '.join(extra_args)} turn cwd={limits.repo_path}",
            output=output,
            exit_code=exit_code,
            started_at=started_at,
            finished_at=finished_at,
            duration=duration,
            cancelled=bool(result and result.cancelled),
            timed_out=bool(result and result.timed_out),
            forced_kill=forced_kill,
            transcript_extra=transcript_extra,
        )

    def close(self) -> None:
        for runtime_session in list(self._sessions.values()):
            runtime_session.close()
        self._sessions.clear()
        self._session_use_counts.clear()

    def _new_session(
        self,
        *,
        executable: str,
        repo_path: Path,
        extra_args: list[str],
        sandbox: str,
        approval_policy: str,
        approval_decision: CodexApprovalDecision,
        model: str | None = None,
    ) -> CodexAppServerSession:
        if self._session_factory:
            return self._session_factory(
                executable=executable,
                repo_path=repo_path,
                extra_args=extra_args,
                sandbox=sandbox,
                approval_policy=approval_policy,
                approval_decision=approval_decision,
                model=model,
            )
        client = CodexAppServerClient(executable=executable, extra_args=extra_args)
        return CodexAppServerSession(
            cwd=repo_path,
            client=client,
            sandbox=sandbox,
            approval_policy=approval_policy,
            approval_decision=approval_decision,
            post_tool_quiet_timeout_seconds=float(os.environ.get("SUPERCLAW_CODEX_APP_SERVER_POST_TOOL_TIMEOUT_SECONDS", "30")),
            model=model,
        )

    def _retire_session(self, session_key: tuple[str, str, tuple[str, ...], str, str, CodexApprovalDecision, str]) -> None:
        runtime_session = self._sessions.pop(session_key, None)
        if runtime_session:
            runtime_session.close()

    def _sandbox_for_policy(self, policy: PermissionPolicy | None) -> str:
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            return "danger-full-access"
        if policy and policy.mode == "plan":
            return "read-only"
        return "workspace-write"

    def _approval_policy_for_policy(self, policy: PermissionPolicy | None) -> str:
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            return "never"
        return "on-request"

    def _approval_decision_for_policy(self, policy: PermissionPolicy | None) -> CodexApprovalDecision:
        mode = policy.mode if policy else "default"
        if mode in {"bypassPermissions", "dontAsk"}:
            return CodexApprovalDecision(
                accept_command=True, accept_file_change=True, accept_permissions=True, accept_mcp_tool=True, scope="session"
            )
        if mode in {"acceptEdits", "auto"}:
            return CodexApprovalDecision(accept_file_change=True, accept_mcp_tool=True)
        return CodexApprovalDecision()


class ClaudeCliBackend(_AgentCliBackend):
    name = "claude"
    executable_name = "claude"

    def skill_capability(self) -> "Any":
        """Inline @skill: prose skills are injected into the TOOL_CONTRACT prompt
        layer; a tool-skill is fail-closed (no MCP projection on the inline path)."""
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.prose_only()
    surfaces_live_tools = True  # streams canonical tool.* via the claude projector (run_claude_stream)
    supports_effort = True
    # Claude Code's per-session effort flag (`claude --effort <level>`); levels per
    # `claude --help`. Must mirror AGENT_CONTROL_SPECS["claude"]["effort_levels"].
    EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")

    def permission_presets(self) -> PresetMap:
        return make_presets(
            # Doctrine: max permission for both presets. claude headless
            # ``acceptEdits``/``default`` silently auto-DENIES tools that need
            # approval (WebSearch, MCP) instead of escalating, so both presets
            # map to bypassPermissions. ask == allow; preset_driven=False.
            ask=PresetRealization("--permission-mode bypassPermissions (max; both presets)", False, "perm.note.claude.ask", preset_driven=False),
            allow=PresetRealization("--permission-mode bypassPermissions (max; both presets)", False, "perm.note.claude.allow", preset_driven=False),
        )

    def supports_containment(self, policy: "ContainmentPolicy") -> bool:
        """Standard runs are admitted; a low-trust fence is REFUSED (fail-closed).

        EMPIRICAL FINDING (real-binary canary, 2026-06-15): a flag-projection fence
        for claude could NOT be proven in-environment. ``--disallowedTools`` is
        variadic so the trailing prompt was consumed as deny-rules (a real bug an
        argv-shape test missed), and the standalone ``claude`` binary 401s on direct
        invocation here, so the ``Read(**/<glob>)`` secret-deny semantics could not
        be verified against the real permission matcher. A security read-fence must
        be PROVEN, and the iron law (§0) forbids wrapping claude in an external OS
        sandbox, so claude is refused for low-trust; review routes to a B-class
        backend (gemini/anthropic-agent), which enforces ``containment_denies_read_path``
        in-process. Re-admission is gated on a real-binary canary proving the Read()
        deny — see docs/t11-low-trust-containment-design.md §3.1 (follow-up)."""
        return not policy.is_low_trust

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_CLAUDE_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="claude executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = (completed.stdout or completed.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "claude", 127, "claude executable not found", 0.0)
        if (skill_guard := self._skill_overlay_guard(task=task, session=session, limits=limits)) is not None:
            return skill_guard
        model = _resolve_model(limits, "SUPERCLAW_CLAUDE_MODEL", default="claude-opus-4-8")
        effort = (_resolve_effort(limits, "SUPERCLAW_CLAUDE_EFFORT") or "").strip().lower()
        if effort and effort not in self.EFFORT_LEVELS:
            return self._invalid_effort_result(
                task=task, session=session, limits=limits, effort=effort, levels=self.EFFORT_LEVELS
            )
        # Stream live output through the runtime when a sink is wired (real
        # orchestrator runs). Without a sink (tests, ad-hoc callers) keep the
        # batch --output-format json path so existing behavior is unchanged.
        streaming = limits.event_sink is not None
        policy = limits.permission_policy
        if limits.containment_policy and limits.containment_policy.is_low_trust:
            # Fail-closed for a direct caller too: claude's flag-projection read-fence
            # could not be PROVEN (see supports_containment). The orchestrator already
            # refuses dispatch; route low-trust review to a B-class backend.
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="claude containment projection",
                output=(
                    "CONTAINMENT_UNSUPPORTED: claude flag-projection read-fence is unproven "
                    "(--disallowedTools is variadic and the Read() deny semantics are not verified "
                    "against the real matcher). Use a B-class backend (gemini/anthropic-agent) for "
                    "low-trust review."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        tail: list[str] = []
        if policy:
            started_at = time.time()
            started = time.monotonic()
            if policy.plugin_dirs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="claude plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: Claude backend does not accept plugin directories for SuperClaw plugin runtime; use SuperClaw MCP proxy config instead",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            try:
                _secret_free_mcp_servers(policy.mcp_configs, backend_name="Claude")
            except ValueError as exc:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="claude plugin runtime policy projection",
                    output=f"PLUGIN_RUNTIME_CONFIG_INVALID: {exc}",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            tail.extend(["--permission-mode", policy.mode])
            if policy.allowed_tools:
                tail.extend(["--allowedTools", ",".join(policy.allowed_tools)])
            if policy.disallowed_tools:
                tail.extend(["--disallowedTools", ",".join(policy.disallowed_tools)])
            for config in policy.mcp_configs:
                tail.extend(["--mcp-config", config])
            for plugin_dir in policy.plugin_dirs:
                tail.extend(["--plugin-dir", plugin_dir])
        else:
            tail.extend(["--no-session-persistence", "--tools="])
        prompt_projection = self._project_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
            capabilities=PromptProjectionCapabilities(
                system_channel="native_cli_append",
                per_call_system=True,
                append_preserves_default=True,
                backend=self.name,
                notes=("claude --append-system-prompt",),
            ),
        )
        prompt = prompt_projection.user_prompt

        def _build_command(stream: bool) -> list[str]:
            head = [executable, "--print"]
            if stream:
                head.extend(["--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            else:
                head.extend(["--output-format", "json"])
            head.extend(["--model", model])
            if effort:
                head.extend(["--effort", effort])
            # `--` terminates option parsing so the user prompt — which the prompt
            # envelope ALWAYS prefixes with an "--- BEGIN UNTRUSTED … ---" fence — is
            # taken as the positional prompt, NOT mis-read as an unknown `--…` option.
            # Without it the commander-style CLI rejects the whole run with exit 1
            # ("unknown option '--- BEGIN UNTRUSTED TASK CONTEXT ---…'"), which broke
            # EVERY claude-backend worker turn. Verified: `claude --print … -- "<--prompt>"`
            # parses cleanly.
            return head + tail + ["--append-system-prompt", prompt_projection.append_system, "--", prompt]

        if not streaming:
            return self.run_command(
                _build_command(False),
                task=task,
                goal=goal,
                session=session,
                limits=limits,
                transcript_extra=self._runtime_extra(
                    executable=executable,
                    model=model,
                    provider="claude-code",
                    api_mode="claude_cli",
                    supports_mcp_configs=bool(policy and policy.mcp_configs),
                    system_channel="native_cli_append",
                    per_call_system=True,
                    append_preserves_default=True,
                    prompt_projection=prompt_projection,
                ),
            )

        stream_result = run_claude_stream(
            _build_command(True),
            cwd=limits.repo_path,
            budget_seconds=float(limits.budget_seconds),
            cancel_check=limits.cancel_check,
            on_event=limits.event_sink,
        )
        # If stream-json produced nothing parseable (e.g. an unexpected CLI/version
        # shape), fall back to the proven batch path so the run still completes.
        if stream_result.parsed_events == 0 and not stream_result.cancelled and not stream_result.timed_out:
            transcript_extra = self._runtime_extra(
                executable=executable,
                model=model,
                provider="claude-code",
                api_mode="claude_cli",
                supports_mcp_configs=bool(policy and policy.mcp_configs),
                system_channel="native_cli_append",
                per_call_system=True,
                append_preserves_default=True,
                prompt_projection=prompt_projection,
            )
            transcript_extra["stream_fallback"] = "stream-json produced no parseable events; used batch json"
            return self.run_command(
                _build_command(False),
                task=task,
                goal=goal,
                session=session,
                limits=limits,
                transcript_extra=transcript_extra,
            )

        output = stream_result.output
        if stream_result.exit_code == 0 and not stream_result.is_error:
            output = (
                f"{output}\nsuperclaw_worker_result backend={self.name} role={task.role.value} "
                f"goal={goal.goal_id} status=completed"
            )
        transcript_extra = self._runtime_extra(
            executable=executable,
            model=model,
            provider="claude-code",
            api_mode="claude_stream_json",
            supports_mcp_configs=bool(policy and policy.mcp_configs),
            system_channel="native_cli_append",
            per_call_system=True,
            append_preserves_default=True,
            prompt_projection=prompt_projection,
        )
        transcript_extra.update(
            {
                "streaming": True,
                "tool_iterations": stream_result.tool_iterations,
                "parsed_events": stream_result.parsed_events,
                "is_error": stream_result.is_error,
                "usage": stream_result.usage,
                "raw_events": stream_result.raw_events,
            }
        )
        return self._synthetic_result(
            task=task,
            session=session,
            limits=limits,
            command_repr=" ".join(_build_command(True)[:-1] + ["<prompt>"]),
            output=output,
            exit_code=stream_result.exit_code,
            started_at=stream_result.started_at,
            finished_at=stream_result.finished_at,
            duration=stream_result.duration_seconds,
            cancelled=stream_result.cancelled,
            timed_out=stream_result.timed_out,
            transcript_extra=transcript_extra,
        )


class OpenCodeCliBackend(_AgentCliBackend):
    """Worker backend that drives the local ``opencode`` CLI in headless ``run``
    mode, so SuperClaw can route delivery work through OpenCode like any other
    local agent runtime.

    Channel-access logic mirrors Paperclip's ``opencode-local`` adapter:
    ``opencode run --format json [--model <m>] <prompt>`` with the prompt passed
    as the positional message (OpenCode ``run`` accepts a positional message, so
    the shared DEVNULL-stdin ``run_command`` path is reused unchanged). The model
    is an optional ``SUPERCLAW_OPENCODE_MODEL`` override; without it OpenCode uses
    its own configured default. Auth/quota failures OpenCode reports on a clean
    exit are caught by ``failure_markers`` and reclassified as a failed run.

    Plugin governance is fail-closed: OpenCode consumes MCP through its own
    ``opencode.json`` config rather than a CLI flag, so SuperClaw's MCP proxy
    config cannot be projected through the CLI yet. A run that arrives with plugin
    directories or MCP configs in its permission policy is rejected rather than
    silently dropping the governance projection. The run also passes ``--pure``
    (OpenCode's documented "run without external plugins" flag) so an ambient
    project's plugins do not load into a governed run. (MCP projection for
    OpenCode is a follow-up channel enhancement.)

    KNOWN LIMITATION — unverified config isolation: ``--pure`` is documented to
    disable *external plugins*, but the OpenCode docs do not state whether it also
    suppresses a project ``opencode.json``'s own ``mcp`` servers / permission
    rules, and no ``OPENCODE_DISABLE_PROJECT_CONFIG`` env var is documented. With
    no local ``opencode`` install this backend has not been smoke-tested, so full
    isolation of an ambient project config is NOT verified. Treat ``opencode`` as
    an unverified runtime dependency until a real install confirms ``--pure`` (or
    ``OPENCODE_CONFIG``) fully governs config discovery.

    Permission posture is preset-driven: ``allow`` maps to OpenCode's real
    ``--dangerously-skip-permissions`` flag, while ``ask`` omits it (OpenCode then
    falls back to its config-resolved permission rules — SuperClaw does not claim
    to CLI-enforce a finer gate than OpenCode exposes).

    Failed runs are caught two ways: a JSON ``error`` event in the ``--format
    json`` stream (a real opencode 1.16.2 smoke showed auth failure exits 0 with a
    ``{"type":"error",...}`` event — see ``failure_markers``), plus the inherited
    auth/quota phrases for the human-formatted path.

    Deferred to follow-up channel work: session resume (``--session``) and full
    structured parsing of the JSONL stream for sessionID / token usage. v1
    otherwise treats stdout as text like the other CLI backends.
    """

    name = "opencode"
    executable_name = "opencode"
    supports_effort = True
    # OpenCode's reasoning effort is a provider-specific `--variant` (e.g. high /
    # max / minimal — NOT a stable closed enum), so the contract marks it
    # effort_input_mode="text": the levels below are SUGGESTIONS only and free-form
    # input stays allowed (mirrors the model combo input). No strict validation —
    # we forward whatever the user typed and let opencode reject an unknown variant.
    EFFORT_SUGGESTIONS: tuple[str, ...] = ("minimal", "low", "medium", "high", "max")

    # Two kinds of OpenCode-specific "clean exit but did not actually run" signals:
    #
    # 1. `"type":"error"` — OpenCode's `--format json` emits one JSONL event per
    #    line; a failed run (e.g. expired-token "Token refresh failed: 401",
    #    UnknownError) surfaces as a compact `{"type":"error",...}` event while the
    #    process still exits 0. A real smoke against an installed opencode 1.16.2
    #    confirmed exactly this false-success shape, so we key on the JSON error
    #    event itself. A successful run only emits text / step_finish / tool_use
    #    events, so this structural marker does not misfire on normal output (far
    #    safer than substring-matching natural-language phrases).
    # 2. A few high-specificity auth/quota phrases as a belt-and-suspenders for the
    #    human-formatted path; the broad auth phrases are already inherited.
    failure_markers = _AgentCliBackend.failure_markers + (
        '"type":"error"',
        '"type": "error"',
        "opencode auth login",
        "free usage exceeded",
        "no model configured",
    )

    def permission_presets(self) -> PresetMap:
        # Doctrine: runtime is a pure execution engine handed max permission. Both
        # presets map to bypassPermissions -> OpenCode's real headless override
        # flag. ask == allow at runtime; preset_driven=False is the honest signal.
        return make_presets(
            ask=PresetRealization(
                "opencode run --dangerously-skip-permissions (max; both presets)",
                False,
                "perm.note.opencode.ask",
                preset_driven=False,
            ),
            allow=PresetRealization(
                "opencode run --dangerously-skip-permissions (max; both presets)",
                False,
                "perm.note.opencode.allow",
                preset_driven=False,
            ),
        )

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_OPENCODE_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="opencode executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = (completed.stdout or completed.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "opencode", 127, "opencode executable not found", 0.0)
        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="opencode plugin runtime policy projection",
                output=(
                    "PLUGIN_RUNTIME_CONFIG_INVALID: OpenCode backend cannot yet project SuperClaw "
                    "plugin runtime policy (OpenCode consumes MCP via its own opencode.json config, "
                    "not a CLI flag). Run without plugin directories / MCP configs until OpenCode MCP "
                    "projection lands."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        model = _resolve_model(limits, "SUPERCLAW_OPENCODE_MODEL") or ""
        # Per-run effort_override (CLI --effort / chat selection) wins; the legacy
        # SUPERCLAW_OPENCODE_VARIANT env stays the fallback. Free-form (text mode):
        # forwarded as-is to opencode's provider-specific --variant. Reject only a
        # value with inner whitespace, which would split into a malformed argv.
        variant = (_resolve_effort(limits, "SUPERCLAW_OPENCODE_VARIANT") or "").strip()
        if variant and any(ch.isspace() for ch in variant):
            return self._invalid_effort_result(
                task=task, session=session, limits=limits, effort=variant, levels=self.EFFORT_SUGGESTIONS
            )
        # `--pure` is OpenCode's documented "run without external plugins" flag —
        # the strongest documented governance lever to keep an ambient project's
        # plugins out of a governed run (see KNOWN LIMITATION in the class doc:
        # this does not provably suppress a project opencode.json's own mcp field).
        command = [executable, "run", "--format", "json", "--pure"]
        if model:
            command.extend(["--model", model])
        if variant:
            command.extend(["--variant", variant])
        # Preset-driven permission posture: allow → real headless override flag.
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            command.append("--dangerously-skip-permissions")
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        # `--` ends option parsing: the user prompt can start with an
        # "--- BEGIN UNTRUSTED … ---" fence, which a bare positional would mis-parse
        # as an unknown `--` option (exit 1). See the claude backend for the detail.
        command.extend(("--", prompt))
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model or None,
                provider="opencode",
                api_mode="opencode_run",
                notes=["opencode headless run (--format json --pure)"],
                prompt_projection=prompt_projection,
            ),
        )


class GrokCliBackend(_AgentCliBackend):
    """Worker backend that drives the local ``grok`` CLI (xAI's conversational CLI
    with text-editor + tool capabilities) in headless ``-p`` mode.

    Channel access: ``grok [--model <m>] [--max-tool-rounds N] -p <prompt>``. The
    ``-p/--prompt`` flag is grok's documented headless "process a single prompt and
    exit" mode, so the shared DEVNULL-stdin ``run_command`` path is reused. Model
    and key come from grok's own env (``GROK_MODEL`` / ``GROK_API_KEY`` /
    ``GROK_BASE_URL``); SuperClaw only overrides the model when
    ``SUPERCLAW_GROK_MODEL`` is set, and bounds the agent loop via
    ``SUPERCLAW_GROK_MAX_TOOL_ROUNDS``.

    Reasoning effort is deliberately NOT exposed (``supports_effort = False``).
    The ``grok`` CLI advertises an ``--effort`` flag, but there is no single Grok
    effort axis SuperClaw can faithfully expose: per xAI's docs the model-level
    ``reasoning_effort`` support is narrow and model-specific — grok-4 rejects the
    param outright, grok-3-mini accepts only low/high, grok-4-fast / grok-4.3 only
    none/low/medium/high — and the grok.com coding model the CLI drives by default
    has no documented effort axis. There is no claude-style unified low→max ladder
    that holds across Grok models. Rather than offer a control the chosen model may
    not honor, SuperClaw does not advertise grok effort and fail-closes on an
    explicit selection (``_effort_unsupported_guard``).

    Two ``grok`` binaries exist in the wild and both speak ``--model``/``-p``:
    xAI's first-party CLI (https://x.ai/cli) and the community grok-cli.

    The CLI enforces ``-p`` as a value-required argv prompt (stdin piping does not
    satisfy it), so the rendered prompt is guarded by ``MAX_PROMPT_BYTES`` — a
    too-large prompt fails with a clear message instead of a cryptic
    OSError(E2BIG)/ENAMETOOLONG deep inside subprocess.

    Plugin governance is fail-closed: grok manages MCP through its own ``grok mcp``
    config, not a CLI flag, so SuperClaw will not project plugin dirs / MCP configs
    to it; a policy that carries them is rejected rather than silently dropped.
    Permissions are not preset-driven — grok runs its own tool loop with no
    CLI-level approval gate (the loop is only bounded by ``--max-tool-rounds``).
    """

    name = "grok"
    executable_name = "grok"

    # argv budget for the value-required `-p <prompt>` (same rationale as the
    # Cursor backend's guard): stay safely under Linux MAX_ARG_STRLEN (~128 KiB
    # for a single argv entry) with headroom for the other flags.
    MAX_PROMPT_BYTES = 96 * 1024
    # No Grok model reliably honors reasoning-effort (see class docstring), so the
    # control is not advertised and an explicit effort is refused fail-closed.
    supports_effort = False

    # High-specificity "clean exit but did not run" signals only. "rate limit" was
    # dropped as too broad — a successful answer that merely mentions rate limits
    # must not be reclassified as a failure (a genuine non-zero exit is already
    # caught by run_command regardless of markers).
    failure_markers = _AgentCliBackend.failure_markers + (
        "grok api key",
        "set grok_api_key",
        "no api key",
    )

    def permission_presets(self) -> PresetMap:
        return make_presets(
            ask=PresetRealization(
                "grok -p (runs its own tool loop; no preset-driven CLI gate, bounded by --max-tool-rounds)",
                False,
                "perm.note.grok.ask",
                preset_driven=False,
            ),
            allow=PresetRealization(
                "grok -p (runs its own tool loop; no preset-driven CLI gate, bounded by --max-tool-rounds)",
                False,
                "perm.note.grok.allow",
                preset_driven=False,
            ),
        )

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_GROK_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="grok executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = _first_line_version(completed)
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "grok", 127, "grok executable not found", 0.0)
        # Grok has no real reasoning-effort axis — refuse an explicit selection
        # fail-closed rather than pass a flag no Grok model honors.
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="grok plugin runtime policy projection",
                output=(
                    "PLUGIN_RUNTIME_CONFIG_INVALID: Grok backend does not project SuperClaw plugin "
                    "runtime policy (grok manages MCP via its own `grok mcp` config, not a CLI flag). "
                    "Run without plugin directories / MCP configs."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        model = _resolve_model(limits, "SUPERCLAW_GROK_MODEL") or ""
        max_rounds = os.environ.get("SUPERCLAW_GROK_MAX_TOOL_ROUNDS", "").strip()
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        # argv length guard: grok enforces `-p` as a value-required argv prompt
        # (stdin piping does not satisfy it), so a too-large prompt must fail
        # with a clear message rather than a cryptic OSError(E2BIG).
        if len(prompt.encode("utf-8")) > self.MAX_PROMPT_BYTES:
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="grok prompt length guard",
                output=(
                    f"GROK_PROMPT_TOO_LARGE: rendered prompt is "
                    f"{len(prompt.encode('utf-8'))} bytes (> {self.MAX_PROMPT_BYTES} budget for the "
                    "value-required -p argv prompt). Reduce context for this run."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        command = [executable]
        if model:
            command.extend(["--model", model])
        # Only forward a valid positive integer — an empty/negative/non-numeric env
        # value is ignored rather than handed to the CLI as a malformed arg.
        if max_rounds.isdigit() and int(max_rounds) > 0:
            command.extend(["--max-tool-rounds", max_rounds])
        command.extend(["-p", prompt])
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model or None,
                provider="grok",
                api_mode="grok_headless",
                notes=["grok headless -p (single prompt)"],
                prompt_projection=prompt_projection,
            ),
        )


class CursorCliBackend(_AgentCliBackend):
    """Worker backend that drives Cursor's local ``cursor-agent`` CLI in headless
    ``--print`` mode, so SuperClaw can route delivery work through Cursor.

    Channel access (confirmed against cursor-agent 2026.06.04):
    ``cursor-agent -p --output-format stream-json --workspace <cwd> --trust
    [--force] [--model <m>] <prompt>``. The prompt is a positional argument (the
    CLI is ``agent [prompt...]``), so the shared DEVNULL-stdin run_command path is
    reused — no stdin plumbing needed. ``--trust`` is always passed: headless
    ``--print`` runs would otherwise stall on the interactive workspace-trust
    prompt; trusting the workspace is *not* command approval (that is ``--force``).

    Permission posture is preset-driven: ``allow`` maps to ``--force`` ("force
    allow commands unless explicitly denied"); ``ask`` omits it, so Cursor falls
    back to its own default per-command policy. NOTE: ``ask`` only guarantees that
    SuperClaw does not *force-allow* — the exact headless behavior for a command
    Cursor would otherwise prompt for is Cursor-determined and has NOT been
    real-smoke-verified against a logged-in account (the local cursor-agent is
    unauthenticated). Do not over-rely on ``ask`` to hard-deny dangerous shell
    until that smoke exists; for a strict boundary, sandbox the run.

    Auth/model come from Cursor's own env (``CURSOR_API_KEY``); SuperClaw overrides
    the model only when ``SUPERCLAW_CURSOR_MODEL`` is set (Cursor defaults to
    ``auto``). Plugin governance is fail-closed: Cursor *does* expose
    ``--plugin-dir``, but a SuperClaw plugin runtime policy is an MCP-proxy
    projection (superclaw-plugins.mcp.json), not a format-equivalent native Cursor
    plugin dir / MCP config — so a policy carrying plugin dirs / MCP configs is
    rejected (not silently dropped) rather than mis-mapped onto ``--plugin-dir``.

    Deferred follow-up (mirrors the in-repo open-design cursor-agent runtime def,
    which pipes the prompt via stdin with ``--stream-partial-output``): prompt via
    stdin to avoid the argv length ceiling, session resume (``--resume``), and
    structured parsing of the stream-json events. v1 passes the prompt as a
    positional arg (bounded by a byte budget) and treats stdout as text; a non-zero
    exit (the confirmed exit-1 on missing auth) is caught by run_command.
    """

    name = "cursor"
    executable_name = "cursor-agent"

    # Conservative headroom under a typical 256 KiB+ ARG_MAX once env + other args
    # are accounted for; an over-budget prompt fails with a clear message instead of
    # a cryptic E2BIG / ENAMETOOLONG. (Follow-up: stdin delivery removes this
    # ceiling, as the in-repo open-design cursor-agent def does.)
    MAX_PROMPT_BYTES = 96 * 1024

    failure_markers = _AgentCliBackend.failure_markers + (
        "agent login",
        "cursor_api_key",
        "set cursor_api_key",
        "not logged in",
        "unauthenticated",
        "authentication required",
        # Both the compact and spaced JSON forms of a stream-json error event.
        '"type":"error"',
        '"type": "error"',
    )

    def permission_presets(self) -> PresetMap:
        # Doctrine: max permission for both presets -> Cursor's force-allow flag.
        # ask == allow at runtime; preset_driven=False is the honest signal.
        return make_presets(
            ask=PresetRealization(
                "cursor-agent -p --trust --force (max; both presets)",
                False,
                "perm.note.cursor.ask",
                preset_driven=False,
            ),
            allow=PresetRealization(
                "cursor-agent -p --trust --force (max; both presets)",
                False,
                "perm.note.cursor.allow",
                preset_driven=False,
            ),
        )

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_CURSOR_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="cursor-agent executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = _first_line_version(completed)
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "cursor", 127, "cursor-agent executable not found", 0.0)
        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="cursor plugin runtime policy projection",
                output=(
                    "PLUGIN_RUNTIME_CONFIG_INVALID: a SuperClaw plugin runtime policy is an MCP-proxy "
                    "projection, not a format-equivalent native Cursor plugin dir / MCP config, so the "
                    "Cursor backend rejects it rather than mis-mapping onto --plugin-dir. Run without "
                    "plugin directories / MCP configs (Cursor resolves its own MCP via config / "
                    "--approve-mcps)."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        # argv length guard: a positional prompt is bounded by ARG_MAX. Fail with a
        # clear message instead of a cryptic OSError(E2BIG) deep in subprocess.
        if len(prompt.encode("utf-8")) > self.MAX_PROMPT_BYTES:
            started_at = time.time()
            started = time.monotonic()
            return self._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="cursor prompt length guard",
                output=(
                    f"CURSOR_PROMPT_TOO_LARGE: rendered prompt is "
                    f"{len(prompt.encode('utf-8'))} bytes (> {self.MAX_PROMPT_BYTES} budget for a "
                    "positional argv prompt). Reduce context or wait for stdin-delivery support."
                ),
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=time.monotonic() - started,
            )
        model = _resolve_model(limits, "SUPERCLAW_CURSOR_MODEL") or ""
        command = [
            executable, "-p", "--output-format", "stream-json",
            "--workspace", str(limits.repo_path), "--trust",
        ]
        if model:
            command.extend(["--model", model])
        # Preset-driven permission posture: allow → Cursor's real force-allow flag.
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            command.append("--force")
        # `--` ends option parsing: the user prompt can start with an
        # "--- BEGIN UNTRUSTED … ---" fence, which a bare positional would mis-parse
        # as an unknown `--` option (exit 1). See the claude backend for the detail.
        command.extend(("--", prompt))
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model or None,
                provider="cursor",
                api_mode="cursor_headless",
                notes=["cursor-agent headless --print (stream-json)"],
                prompt_projection=prompt_projection,
            ),
        )


class BoboCliBackend(_AgentCliBackend):
    """Worker backend that drives the local ``bobo`` CLI (Portable AI Engineering
    Assistant) in its autonomous ``run`` loop, so SuperClaw can land real changes.

    Non-interactive execution: ``--print --full-auto`` (and ``--yolo`` when the
    permission policy is a bypass) are global flags placed before the ``run``
    subcommand; ``--model/--effort/--max-iterations`` configure the run. Model
    defaults to bobo's own configured provider model unless SUPERCLAW_BOBO_MODEL
    is set.
    """

    name = "bobo"
    executable_name = "bobo"

    def permission_presets(self) -> PresetMap:
        return make_presets(
            # Doctrine: max permission for both presets -> --full-auto --yolo (no
            # sandbox, no approvals). ask == allow; preset_driven=False on both.
            ask=PresetRealization("--print --full-auto --yolo (max; both presets)", False, "perm.note.bobo.ask", preset_driven=False),
            allow=PresetRealization("--print --full-auto --yolo (max; both presets)", False, "perm.note.bobo.allow", preset_driven=False),
        )

    failure_markers = _AgentCliBackend.failure_markers + (
        "no provider configured",
        "provider not configured",
        "run `bobo config",
        "run 'bobo config",
    )

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_BOBO_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="bobo executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = (completed.stdout or completed.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "bobo", 127, "bobo executable not found", 0.0)
        # Global non-interactive / auto-approve flags must precede the `run` subcommand.
        command = [executable, "--print", "--full-auto"]
        policy = limits.permission_policy
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            command.append("--yolo")  # no sandbox, no approvals
        command.append("run")
        model = _resolve_model(limits, "SUPERCLAW_BOBO_MODEL")
        if model:
            command.extend(["--model", model])
        command.extend([
            "--effort", os.environ.get("SUPERCLAW_BOBO_EFFORT", "high"),
            "--max-iterations", os.environ.get("SUPERCLAW_BOBO_MAX_ITERATIONS", "10"),
        ])
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        # `--` ends option parsing: the user prompt can start with an
        # "--- BEGIN UNTRUSTED … ---" fence, which a bare positional would mis-parse
        # as an unknown `--` option (exit 1). See the claude backend for the detail.
        command.extend(("--", prompt))
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model,
                provider="bobo",
                api_mode="bobo_cli",
                notes=["autonomous bobo run loop"],
                prompt_projection=prompt_projection,
            ),
        )


class HermesCliBackend(_AgentCliBackend):
    name = "hermes"
    executable_name = "hermes"

    def permission_presets(self) -> PresetMap:
        return make_presets(
            # Doctrine: max permission for both presets -> --yolo. ask == allow at
            # runtime; preset_driven=False is the honest signal.
            ask=PresetRealization("--oneshot --accept-hooks --yolo (max; both presets)", False, "perm.note.hermes.ask", preset_driven=False),
            allow=PresetRealization("--oneshot --accept-hooks --yolo (max; both presets)", False, "perm.note.hermes.allow", preset_driven=False),
        )

    failure_markers = _AgentCliBackend.failure_markers + (
        "provider credentials not configured",
        "provider authentication failed",
        "exhausted all providers",
        "no provider available",
    )

    def _resolve_executable(self) -> str | None:
        return self.executable or os.environ.get("SUPERCLAW_HERMES_EXECUTABLE") or shutil.which(self.executable_name, path=desktop_toolchain_path())

    def _prompt(self, task: TaskNode, goal: GoalSpec, *, repo_path: Path | None = None, capabilities_note: str | None = None) -> str:
        del capabilities_note  # this backend cannot reach SuperClaw MCP plugins; note is always None here
        criteria = "; ".join(goal.acceptance_criteria) if getattr(goal, "acceptance_criteria", None) else ""
        criteria_line = f"Acceptance criteria: {criteria}\n" if criteria else ""
        repo_line = (
            f"Repository root: {repo_path}\n"
            f"All file inspection, edits, commands, and verification must target this repository root exactly: {repo_path}\n"
            if repo_path
            else ""
        )
        role_contracts = {
            "explore": "Inspect only. Do not edit files. Identify the minimum facts needed for the next step.",
            "plan": "Inspect only. Do not edit files. Decide the smallest safe implementation path.",
            "implement": "Make only the minimal repository changes required by the goal.",
            "verify": "Verify the result with quick local checks. Do not edit files unless the check requires a harmless generated artifact.",
            "review": "Review the delivered result quickly. Do not edit files. If the goal is already satisfied, finish immediately.",
        }
        role_contract = role_contracts.get(task.role.value, "Do the smallest safe amount of work for this role.")
        return (
            f"You are a non-interactive SuperClaw {task.role.value} worker.\n"
            f"Goal title: {goal.title}\n"
            f"Goal: {goal.description}\n"
            f"Task: {task.title}\n"
            f"{criteria_line}"
            f"{repo_line}"
            f"Role contract: {role_contract}\n"
            "Execution rules: keep this invocation short; do not start servers, watchers, browsers, "
            "interactive sessions, or long-running commands; avoid repeating work already completed by prior roles.\n"
            "The final marker is only evidence formatting. It is not a substitute for doing the requested work. "
            "Do not print it until the role contract is actually completed in the repository root above.\n"
            "When the step is complete, print exactly one final line and no extra commentary:\n"
            f"superclaw_worker_result backend={self.name} role={task.role.value} "
            f"goal={goal.goal_id} status=completed"
        )

    def available(self) -> BackendAvailability:
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="hermes executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "version"], capture_output=True, text=True, timeout=10, check=False)
            version = _first_line_version(completed)
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=executable, version=version)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        executable = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "hermes", 127, "hermes executable not found", 0.0)
        self._fail_if_custom_prompt_cannot_project(limits)
        command = [executable, "--oneshot", self._prompt(task, goal, repo_path=limits.repo_path, capabilities_note=limits.plugin_capabilities_note)]
        model = _resolve_model(limits, "SUPERCLAW_HERMES_MODEL")
        provider = os.environ.get("SUPERCLAW_HERMES_PROVIDER")
        toolsets = os.environ.get("SUPERCLAW_HERMES_TOOLSETS")
        skills = os.environ.get("SUPERCLAW_HERMES_SKILLS")
        if model:
            command.extend(["--model", model])
        if provider:
            command.extend(["--provider", provider])
        if toolsets:
            command.extend(["--toolsets", toolsets])
        if skills:
            command.extend(["--skills", skills])
        command.append("--accept-hooks")
        policy = limits.permission_policy
        if policy:
            started_at = time.time()
            started = time.monotonic()
            if policy.plugin_dirs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="hermes plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: Hermes backend does not accept plugin directories for SuperClaw plugin runtime; use SuperClaw MCP proxy config instead",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            try:
                _secret_free_mcp_servers(policy.mcp_configs, backend_name="Hermes")
            except ValueError as exc:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="hermes plugin runtime policy projection",
                    output=f"PLUGIN_RUNTIME_CONFIG_INVALID: {exc}",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            if policy.mcp_configs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="hermes plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: Hermes backend does not yet support SuperClaw MCP proxy config projection; use a backend with MCP projection support",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            if policy.mode in {"bypassPermissions", "dontAsk"}:
                command.append("--yolo")
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model,
                provider=provider,
                api_mode="hermes_oneshot",
                supports_mcp_configs=False,
                notes=["Hermes owns its internal provider resolver and tool loop"],
            ),
        )


class OpenClawCliBackend(_AgentCliBackend):
    name = "openclaw"
    executable_name = "openclaw"

    def permission_presets(self) -> PresetMap:
        return make_presets(
            ask=PresetRealization("configured via SUPERCLAW_OPENCLAW_ARGS (default --print); no preset-driven gate", False, "perm.note.openclaw.ask", preset_driven=False),
            allow=PresetRealization("configured via SUPERCLAW_OPENCLAW_ARGS; no preset-driven gate", False, "perm.note.openclaw.allow", preset_driven=False),
        )

    failure_markers = _AgentCliBackend.failure_markers + (
        "agent not registered",
        "openclaw secrets reload",
        "provider credentials not configured",
        "provider authentication failed",
        "no model configured",
    )

    def _resolve_executable(self) -> tuple[str | None, str | None]:
        if self.executable:
            return self.executable, "constructor"
        env_override = os.environ.get("SUPERCLAW_OPENCLAW_EXECUTABLE")
        if env_override:
            return env_override, "env_override"
        for candidate in ("openclaw", "open-claw", "claw", "bobo"):
            executable = shutil.which(candidate, path=desktop_toolchain_path())
            if executable:
                return executable, candidate
        return None, None

    def available(self) -> BackendAvailability:
        executable, source = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="openclaw executable not found")
        version = None
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            version = _first_line_version(completed)
        except Exception as exc:  # pragma: no cover - defensive availability detail
            version = f"version check failed: {exc}"
        suffix = f" ({source})" if source else ""
        return BackendAvailability(name=self.name, available=True, executable=executable, version=(version or "") + suffix)

    def _prompt(self, task: TaskNode, goal: GoalSpec, *, repo_path: Path | None = None, capabilities_note: str | None = None) -> str:
        del capabilities_note  # this backend cannot reach SuperClaw MCP plugins; note is always None here
        criteria = "; ".join(goal.acceptance_criteria) if getattr(goal, "acceptance_criteria", None) else ""
        criteria_line = f"Acceptance criteria: {criteria}\n" if criteria else ""
        repo_line = (
            f"Repository root: {repo_path}\n"
            f"All file inspection, edits, commands, and verification must target this repository root exactly: {repo_path}\n"
            if repo_path
            else ""
        )
        return (
            f"You are a non-interactive OpenClaw worker running under SuperClaw as role {task.role.value}.\n"
            f"Goal title: {goal.title}\n"
            f"Goal: {goal.description}\n"
            f"Task: {task.title}\n"
            f"{criteria_line}"
            f"{repo_line}"
            "Do the smallest safe amount of real work required for this role. Keep the invocation short; "
            "do not start servers, watchers, browsers, or interactive sessions.\n"
            "The final marker is only evidence formatting. It is not a substitute for doing the requested work. "
            "Do not print it until the role contract is actually completed in the repository root above.\n"
            "When the step is complete, print exactly one final line and no extra commentary:\n"
            f"superclaw_worker_result backend={self.name} role={task.role.value} "
            f"goal={goal.goal_id} status=completed"
        )

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        executable, _source = self._resolve_executable()
        if not executable:
            return WorkerResult(task.task_id, task.role.value, self.name, "openclaw", 127, "openclaw executable not found", 0.0)
        self._fail_if_custom_prompt_cannot_project(limits)
        policy = limits.permission_policy
        if policy:
            started_at = time.time()
            started = time.monotonic()
            if policy.plugin_dirs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="openclaw plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: OpenClaw backend does not accept plugin directories for SuperClaw plugin runtime; use SuperClaw MCP proxy config instead",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            try:
                _secret_free_mcp_servers(policy.mcp_configs, backend_name="OpenClaw")
            except ValueError as exc:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="openclaw plugin runtime policy projection",
                    output=f"PLUGIN_RUNTIME_CONFIG_INVALID: {exc}",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
            if policy.mcp_configs:
                return self._synthetic_result(
                    task=task,
                    session=session,
                    limits=limits,
                    command_repr="openclaw plugin runtime policy projection",
                    output="PLUGIN_RUNTIME_CONFIG_INVALID: OpenClaw backend does not yet support SuperClaw MCP proxy config projection; use a backend with MCP projection support",
                    exit_code=1,
                    started_at=started_at,
                    finished_at=time.time(),
                    duration=time.monotonic() - started,
                )
        configured_args = os.environ.get("SUPERCLAW_OPENCLAW_ARGS", "--print")
        command = [executable, *shlex.split(configured_args)]
        model = _resolve_model(limits, "SUPERCLAW_OPENCLAW_MODEL")
        if model:
            command.extend(["--model", model])
        command.append(self._prompt(task, goal, repo_path=limits.repo_path, capabilities_note=limits.plugin_capabilities_note))
        return self.run_command(
            command,
            task=task,
            goal=goal,
            session=session,
            limits=limits,
            transcript_extra=self._runtime_extra(
                executable=executable,
                model=model,
                provider="openclaw",
                api_mode="openclaw_cli",
                notes=["configurable OpenClaw CLI"],
            ),
        )


def _bundled_clawwork_home() -> Path | None:
    """Locate the internalized ClawWork harness vendored at ``third_party/clawwork``.

    ClawWork is vendored INTO this repo (a hard fork of ``earendil-works/pi``
    v0.79.1 with the upstream git history dropped) and maintained here. This
    resolves it ONLY from a genuine source checkout: ``parents[4]`` is the repo
    root in the source tree, but in a site-packages/venv install it points
    elsewhere, so we additionally require two source-checkout sentinels — the
    repo root's ``pyproject.toml`` AND the harness's governance extension. A
    coincidental ``third_party/clawwork`` near an install therefore returns None
    (callers fall back to env/PATH). The bundled harness is SOURCE-CHECKOUT-ONLY;
    a packaged wheel would need explicit package-data + a prebuilt dist (out of
    scope here — node_modules/ and dist/ are gitignored, built on demand)."""
    try:
        repo_root = Path(__file__).resolve().parents[4]
    except IndexError:
        return None
    # Sentinels reject a coincidental third_party/clawwork near a venv/install:
    # the repo root must carry SuperClaw's pyproject.toml AND the harness must
    # expose its governance extension (both are git-tracked in a source tree).
    if not (repo_root / "pyproject.toml").is_file():
        return None
    home = repo_root / "third_party" / "clawwork"
    if not (home / "extensions" / "superclaw-governance.ts").is_file():
        return None
    return home if home.is_dir() else None


def _frozen_clawwork_binary_name() -> str:
    """Filename of the bundled ClawWork binary inside a frozen desktop app."""
    return "clawwork.exe" if sys.platform == "win32" else "clawwork"


def _frozen_clawwork_dir() -> Path | None:
    """Locate the ClawWork binary + governance extension shipped inside a frozen
    desktop bundle.

    A packaged desktop app cannot use ``_bundled_clawwork_home`` — there is no
    source tree (no repo-root ``pyproject.toml``, no ``third_party`` checkout, no
    Node toolchain). Instead the build ships a self-contained ClawWork next to
    the frozen backend executable: ``<sys.executable dir>/clawwork/`` holds the
    bun-compiled ``clawwork`` binary and ``extensions/superclaw-governance.ts``
    (the SAME governance extension as the source tree — it is self-contained,
    importing only node builtins + a type-only symbol, so the standalone binary
    loads it via ``-e`` and the liveness handshake still proves the gate is LIVE).

    Gated on ``sys.frozen`` (the bundle's tamper-proof marker, mirroring
    ``environment._running_from_source``) so a source checkout never resolves
    here. Returns the dir ONLY when BOTH the runnable binary AND the governance
    extension are present — a partial/half-shipped bundle resolves to None so the
    backend reports ClawWork unavailable rather than ever running ungoverned
    (fail-closed; the governance extension is mandatory)."""
    if not getattr(sys, "frozen", False):
        return None
    try:
        base = Path(sys.executable).resolve().parent
    except (OSError, ValueError):
        return None
    home = base / "clawwork"
    binary = home / _frozen_clawwork_binary_name()
    ext = home / "extensions" / "superclaw-governance.ts"
    # is_file()/X_OK follow symlinks; require a runnable binary AND the mandatory
    # extension before claiming this bundle is governed-ready.
    if binary.is_file() and os.access(binary, os.X_OK) and ext.is_file():
        return home
    return None


class ClawWorkBackend(_AgentCliBackend):
    """EXPERIMENTAL worker backend that drives ClawWork — SuperClaw's model-relay
    coding harness, vendored at ``third_party/clawwork`` (a hard fork of
    ``earendil-works/pi`` v0.79.1, now maintained inside SuperClaw).

    ClawWork is the default harness for *bare-model* relay endpoints (an
    OpenAI-/Anthropic-compatible model gateway with no agent loop of its own):
    ClawWork supplies the agent loop, SuperClaw supplies governance. Channel
    access is ClawWork's RPC mode — ``clawwork --mode rpc`` speaking strict JSONL
    over stdin/stdout (``{"type":"prompt","message":...}`` in, ``agent_*`` /
    ``tool_*`` events out, terminal ``agent_end``).

    Governance (D4 — one policy, two executors): before spawning, the backend
    writes an HMAC-signed policy snapshot (``clawwork_policy.py``) and points the
    ClawWork ``superclaw-governance`` extension at it via env. The extension
    enforces the SAME posture in-process inside ClawWork (denylist > allowlist >
    pay/scan hard gates > read-only mode), failing closed on a missing/forged
    snapshot. ``permission_presets`` therefore carry NO CLI-level gate — the
    posture rides the snapshot, and ``preset_driven=False`` is the honest signal.

    Relay config (env, never hard-coded): ``SUPERCLAW_RELAY_BASE_URL`` +
    ``SUPERCLAW_RELAY_API_KEY`` feed ClawWork's ``clawrelay`` provider; the model
    is the per-run selection (``SUPERCLAW_CLAWWORK_MODEL`` default). The
    governance extension path is ``SUPERCLAW_CLAWWORK_GOVERNANCE_EXT``.

    A ``rpc_fn`` ``(command, *, executable, env, cwd, timeout, cancel_check) ->
    RpcResult`` is injectable so tests drive the full governance/mapping path
    against an in-memory fake without spawning the real Node binary.
    """

    name = "clawwork"
    executable_name = "clawwork"
    maturity = "experimental"
    # ClawWork's RPC stream emits tool_execution_{start,update,end} on stdout, which
    # _spawn_rpc projects into canonical tool.* events through the clawwork projector
    # (display_projection.project_clawwork_event) when a live event_sink is wired.
    # partial tier: full tool lifecycle + input/output, but no incremental deltas
    # (partialResult is a cumulative snapshot, not a delta -- never synthesized).
    surfaces_live_tools = True
    failure_markers = _AgentCliBackend.failure_markers + (
        '"type":"extension_error"',
        '"type": "extension_error"',
        "fail-closed",
    )

    def __init__(self, executable: str | None = None, *, rpc_fn=None) -> None:
        super().__init__(executable=executable)
        self._rpc_fn = rpc_fn

    def permission_presets(self) -> PresetMap:
        return make_presets(
            # Doctrine: both presets map to bypassPermissions -> never-ask posture
            # lifts the --tools gate (max; _clawwork_tool_allowlist returns None).
            # The signed policy snapshot enforced by the governance extension still
            # governs in-process. NOTE: ClawWork's --tools floor is keyed on
            # policy.mode (NOT a separate containment floor), so a low-trust run is
            # NOT protected here by re-deriving read-only — instead the orchestrator
            # refuses ClawWork for low-trust runs (it cannot prove in-process
            # containment, see backend_supports_containment). ask == allow at
            # runtime; preset_driven=False is the honest signal.
            ask=PresetRealization(
                "clawwork --mode rpc (never-ask posture lifts the --tools gate; max; "
                "both presets; signed policy snapshot still governs via the extension)",
                False, "perm.note.clawwork.ask", preset_driven=False,
            ),
            allow=PresetRealization(
                "clawwork --mode rpc (never-ask posture lifts the --tools gate; max; "
                "both presets; signed policy snapshot still governs via the extension)",
                False, "perm.note.clawwork.allow", preset_driven=False,
            ),
        )

    def _resolve_executable(self) -> str | None:
        explicit = self.executable or os.environ.get("SUPERCLAW_CLAWWORK_EXECUTABLE")
        if explicit:
            return explicit
        # Packaged desktop app (sys.frozen): the ONLY non-override source is the
        # self-contained bundle. A valid bundle wins; an invalid/half-shipped one
        # is UNAVAILABLE (None) — never fall back to an ambient PATH binary or the
        # (nonexistent) source tree inside a frozen app. A stray `clawwork` on the
        # user's PATH paired with the bundled governance extension is a
        # mixed/forged pair; a packaged app must use its own bundled binary or
        # nothing (fail-closed). Only an explicit operator override (above) wins.
        if getattr(sys, "frozen", False):
            frozen = _frozen_clawwork_dir()
            return str(frozen / _frozen_clawwork_binary_name()) if frozen is not None else None
        # Source/dev checkout: PATH, then the vendored third_party/clawwork harness
        # (built there via `npm ci && npm run build`). Lets the backend work out
        # of the box from a source checkout with no env wiring; env/PATH win.
        home = _bundled_clawwork_home()
        if home is not None:
            # The build OUTPUT is the reliable target: `npm run build` emits an
            # executable dist/cli.js (shebang + chmod +x). The workspace bin
            # symlink node_modules/.bin/clawwork is NOT reliable on a fresh
            # checkout — npm only links it when dist/cli.js already exists at
            # `npm ci` time, and build runs AFTER install, so it is usually
            # absent. Prefer the dist entry; accept the bin symlink only if it
            # happens to be present. exists() alone lies (a broken symlink or a
            # non-executable file would resolve "available" then blow up at
            # spawn), so require a runnable file (is_file/X_OK follow symlinks).
            for cand in (
                home / "packages" / "coding-agent" / "dist" / "cli.js",
                home / "node_modules" / ".bin" / self.executable_name,
            ):
                if cand.is_file() and os.access(cand, os.X_OK):
                    return str(cand)
        return None

    def _resolve_governance_ext(self) -> str:
        """Governance extension path: env override > bundled harness default.

        The extension is mandatory — an unset/missing path fails ClawWork closed
        in both available() and run(). Defaulting to the vendored copy means a
        source checkout is governed out of the box; the env var still wins.

        Trust model: the bundled extension is vendored INTO this repo (git-tracked,
        code-reviewed, repo-permission-gated) — the SAME trust domain as backends.py
        and the rest of the kernel's governance code. An attacker who could swap the
        vendored extension already has repo write access and could disable governance
        in backends.py directly, so defaulting to it does not widen the trust
        boundary; _bundled_clawwork_home()'s source-checkout sentinels keep it
        anchored inside the repo (never a stray path). The ready-file nonce
        handshake proves the gate is LIVE (handler registered), not the extension's
        identity — identity is guaranteed by repo integrity, as for all in-tree
        governance code."""
        ext = os.environ.get("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", "")
        if ext:
            return ext
        # Packaged desktop app: the extension comes ONLY from the bundle (mirrors
        # the executable resolution). A valid bundle's extension wins; an
        # invalid/half-shipped bundle yields "" → available()/run() fail closed.
        # Never resolve a source-tree path inside a frozen app.
        if getattr(sys, "frozen", False):
            frozen = _frozen_clawwork_dir()
            return str(frozen / "extensions" / "superclaw-governance.ts") if frozen is not None else ""
        home = _bundled_clawwork_home()
        if home is not None:
            bundled = home / "extensions" / "superclaw-governance.ts"
            if bundled.exists():
                return str(bundled)
        return ext

    def available(self) -> BackendAvailability:
        if self._rpc_fn is not None:
            return BackendAvailability(name=self.name, available=True, version="injected:clawwork")
        executable = self._resolve_executable()
        if not executable:
            return BackendAvailability(name=self.name, available=False, reason="clawwork executable not found (build the bundled harness: `npm --prefix third_party/clawwork ci && npm --prefix third_party/clawwork run build`, or set SUPERCLAW_CLAWWORK_EXECUTABLE)")
        ext = self._resolve_governance_ext()
        if not ext or not Path(ext).exists():
            # The governance extension is mandatory — without it a ClawWork run
            # would be UNGOVERNED. Fail-closed in availability so the backend
            # never silently runs unsupervised.
            return BackendAvailability(name=self.name, available=False, executable=executable, reason="SUPERCLAW_CLAWWORK_GOVERNANCE_EXT not set or missing (refusing to run ClawWork ungoverned)")
        # Relay base resolves through the env-baked per-environment default (or an explicit
        # SUPERCLAW_RELAY_BASE_URL override), so a build no longer needs the env var set by
        # hand. Validate it early so availability reflects reality: a malformed / unsafe base
        # (userinfo injection / remote http / %-encoding) would otherwise show READY but leak
        # the relay key to an attacker host at run time (adversarial review).
        try:
            from superclaw.relay_key import resolve_relay_base_url

            resolve_relay_base_url()
        except Exception as exc:  # RelayKeyError or any parse error → not available
            return BackendAvailability(
                name=self.name, available=False, executable=executable,
                reason=f"SUPERCLAW_RELAY_BASE_URL invalid/unsafe: {type(exc).__name__}",
            )
        # Fail-closed on the relay key as well: a ClawWork run with an empty
        # apiKey would only fail downstream with an opaque 401. The resolver is
        # read-only (env > cached key) so probing availability never mutates env.
        # A saved ClawHunt login counts as available: run() auto-provisions the
        # key through the bridge (the third step of the resolution chain).
        from superclaw import relay_key as _relay_key
        from superclaw.clawhunt_auth import saved_clawhunt_access_token

        resolved_key, _source = _relay_key.resolve_relay_api_key()
        if not resolved_key and not saved_clawhunt_access_token():
            return BackendAvailability(
                name=self.name,
                available=False,
                executable=executable,
                reason="no relay API key and no ClawHunt login to auto-provision one (set SUPERCLAW_RELAY_API_KEY, or `superclaw clawhunt account login`; `superclaw relay ensure-key` provisions it explicitly)",
            )
        # Probe the executable for real: a path that exists()+X_OK can still
        # front a broken build, wrong shebang, or dangling workspace link. A
        # failed --version means the harness is not actually runnable, so
        # fail-closed in availability rather than reporting available=True and
        # letting run() blow up later.
        try:
            completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
        except Exception as exc:
            return BackendAvailability(name=self.name, available=False, executable=executable, reason=f"clawwork executable not runnable (--version raised {type(exc).__name__}: {exc}); rebuild the harness with scripts/build-clawwork.sh")
        if completed.returncode != 0:
            return BackendAvailability(name=self.name, available=False, executable=executable, reason=f"clawwork executable not runnable (--version exited {completed.returncode}); rebuild the harness with scripts/build-clawwork.sh")
        version = _first_line_version(completed)
        return BackendAvailability(name=self.name, available=True, executable=executable, version=f"{version} (experimental)")

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        started_at = time.time()
        started = time.monotonic()

        # Cost telemetry captured during the turn. ``turn_model`` is the relay alias
        # once resolved, then upgraded to the concrete model the relay served (from
        # agent_end); ``turn_usage`` is the terminal token usage. synth() stamps both
        # into the cost snapshot so a clawwork turn reports a real model + token usage
        # instead of unknown/0. They stay None on the early-exit paths (executable
        # missing, ungoverned, cancelled-before-start) where no model/usage exists.
        turn_model: str | None = None
        turn_usage: dict[str, Any] | None = None

        def synth(output: str, exit_code: int, *, timed_out: bool = False, cancelled: bool = False) -> WorkerResult:
            extra = self._runtime_extra(
                executable="clawwork", provider="clawrelay", api_mode="clawwork_rpc",
                model=turn_model,
                notes=["clawwork rpc (experimental model-relay harness)"],
            )
            if turn_usage:
                extra["usage"] = turn_usage
            return self._synthetic_result(
                task=task, session=session, limits=limits,
                command_repr="clawwork --mode rpc", output=output, exit_code=exit_code,
                started_at=started_at, finished_at=time.time(), duration=time.monotonic() - started,
                timed_out=timed_out, cancelled=cancelled,
                transcript_extra=extra,
            )

        injected = self._rpc_fn is not None
        executable = "clawwork" if injected else self._resolve_executable()
        if not executable:
            return synth("clawwork executable not found", 127)
        governance_ext = self._resolve_governance_ext()
        if not injected and (not governance_ext or not Path(governance_ext).exists()):
            return synth("CLAWWORK_UNGOVERNED: SUPERCLAW_CLAWWORK_GOVERNANCE_EXT not set or missing; refusing to run ungoverned", 126)

        policy = limits.permission_policy
        # ClawWork resolves its own MCP via the relay; SuperClaw plugin runtime
        # policy is not projected over RPC. A policy carrying dirs/configs is
        # rejected rather than silently dropped (fail-closed, like the gateway).
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            return synth(
                "PLUGIN_RUNTIME_CONFIG_INVALID: ClawWork backend does not project SuperClaw plugin "
                "runtime policy (it resolves tools through the relay). Run without plugin dirs / MCP configs.",
                1,
            )

        if limits.cancel_check and limits.cancel_check():
            return synth("clawwork run cancelled before start", 130, cancelled=True)

        # ClawWork's only provider is the relay (clawrelay), which REQUIRES a package
        # model to resolve a key — unlike the native CLI backends it has NO usable
        # "no model selected" fallback (it rejects the prompt with "No API key found
        # for the selected model"). So when no model is given — the composer's relay
        # package selector sends '' for its "use the relay default" option, and a
        # worker/agent may carry no model_override — default to the base relay tier so
        # the documented "use the relay default" actually runs instead of being
        # rejected. An explicit per-run override or SUPERCLAW_CLAWWORK_MODEL still wins
        # (resolved first); the tier name is the relay contract constant, never
        # hard-coded.
        from superclaw.relay_packages import SUPERCLAW_BRIDGE_TIERS, normalize_relay_package_id
        from superclaw import relay_key as _relay_key

        # 默认档跟随账号解锁上限（issue #452 方案 C）：登录后默认就是已购档位（plus/max），
        # 不再写死 core；未登录回落 base tier(core)。显式 per-run override / 环境变量仍优先
        # （_resolve_model 先解析这些），仅"未选"时才用 ceiling 作默认。
        raw_model = _resolve_model(
            limits, "SUPERCLAW_CLAWWORK_MODEL",
            default=_relay_key.cached_or_refresh_tier_ceiling() or SUPERCLAW_BRIDGE_TIERS[0],
        )
        # 越级 clamp（硬上限，业主拍板）：标准档位（core/plus/max）才校验 ≤ 解锁上限；动态套餐 /
        # 裸模型（normalize 返回 None）原样下放，由下游 fail-safe。裁决单一源 = relay_key，
        # 表层不自造 tier 序（CLI 唯一事实源铁律）。
        # 二级模型选择（chat composer，clawwork 专属）：model_override 可为 composite
        # ``"<tier>::<model_id>"``（如 ``plus::claude-opus-4-8``）——第一级套餐 + 第二级该套餐内
        # 的具体模型。无 ``::`` 则是纯档位（沿用：core/plus/max / 动态套餐 / 裸模型），向后兼容。
        tier_token, _sep, model_token = (raw_model or "").partition("::")
        tier_token = tier_token.strip()
        model_token = model_token.strip()
        # Fail-closed on a malformed composite: a ``::model`` with an EMPTY tier (no
        # first level) must NOT silently route to the core fail-safe tier carrying an
        # arbitrary model id — that would smuggle a level-2 model past the level-1 tier
        # gate (Codex adversarial finding #1). The two-level contract REQUIRES a tier
        # whenever a concrete model is named; refuse rather than guess one. (A bare
        # ``tier::`` with empty model stays valid — it degrades to the plain tier below.)
        if _sep and not tier_token and model_token:
            return synth(
                "CLAWWORK_MODEL_WITHOUT_TIER: 二级模型选择必须带套餐档位（形如 "
                f"``plus::{model_token}``）。收到的 ``{raw_model}`` 缺少第一级档位，已拒绝"
                "（请先选套餐档位，再选档位内的具体模型）。",
                125,
            )
        # Fail-closed on extra separators: the grammar is EXACTLY ``<tier>::<model>`` with a
        # single ``::``. A model id never contains ``::``, so ``plus::foo::bar`` (model_token
        # ``foo::bar``) is malformed — refuse rather than forward a bogus ``--model`` token
        # into the relay group (Codex adversarial finding #1, "multiple ::" boundary).
        if "::" in model_token:
            return synth(
                "CLAWWORK_MODEL_MALFORMED: 二级模型选择的格式必须是 ``<档位>::<模型>``（仅一个 "
                f"``::``）。收到的 ``{raw_model}`` 含多余分隔符，已拒绝。",
                125,
            )
        selected_tier = normalize_relay_package_id(tier_token)
        # ensure 绑 key 用的档位：标准档（core/plus/max）=自身；**一切非标准档**（动态套餐 superclaw-*、
        # 裸模型 override 如 relay/raw-model、configured-default 等，normalize 返回 None）一律显式回落
        # "core"。绝不传 None —— tier=None 会让 _owned_stored_key 跳过档位闸而复用账号已有的任意 owned
        # key（含 plus/max 缓存 key），key 隔离不确定（Codex 终审阻断项：标准档/动态档/裸模型全覆盖）。
        ensure_tier = selected_tier or "core"
        if selected_tier is not None:
            allowed, ceiling, _sel = _relay_key.check_tier_within_ceiling(selected_tier)
            if not allowed:
                return synth(
                    f"CLAWWORK_TIER_NOT_UNLOCKED: 当前账号解锁上限为 {ceiling}，无法使用 "
                    f"{selected_tier} 档（superclaw-{selected_tier}）。请在 ClawHunt 升级套餐后重试"
                    "（若刚升级，请重新登录或 `superclaw relay ensure-key` 刷新解锁上限），"
                    f"或改选 ≤{ceiling} 的档位。",
                    125,
                )
        # 发给 LLMgate 的 model：二级选了具体模型 → 直接发该 model_id（key 已绑到 superclaw-{tier}
        # 组，LLMgate 在组内路由到该模型）；否则纯档位 → 翻成 group slug（沿用，LLMgate 选组默认）。
        if model_token:
            model = model_token
        else:
            model = self._translate_relay_package_model(model=tier_token or raw_model)
        # 动态套餐（标准三档之外、经 live catalog 翻成 superclaw-* slug 的档，如未来的 ``pro``）：
        # 当前 ensure 只按标准档绑 key，selected_tier=None → 该 key 绑 fail-safe core，而 model 请求
        # 动态分组 slug → 存在 key↔分组 mismatch。这是 #452 范围（core/plus/max）**之外的既有**限制
        # —— 动态档本就经 catalog 翻译并起跑（见 test_worker_backends 的动态翻译契约），#452 不改其
        # 行为，故**不 refuse**（refuse 会破坏既有动态套餐执行契约，Codex 复审阻断项 #2）；仅留一条
        # 警告日志（Codex 对抗项 #1 的"log"），动态档逐档 key 绑定列为 backlog（需放宽 _normalize_tier
        # 接受 catalog 校验过的动态 tier）。
        if selected_tier is None and isinstance(model, str) and model.startswith("superclaw-"):
            # 动态套餐：ensure_tier 已由上面 ``selected_tier or "core"`` 回落 core（确定性绑 fail-safe
            # core key，绝不挪用付费档缓存 key）；这里仅额外 log 一条，记下"动态分组 slug ↔ core key"的
            # mismatch（逐档绑定 backlog，需放宽 _normalize_tier 接受 catalog 校验的动态 tier）。
            import logging as _logging
            _logging.getLogger("superclaw.backends").warning(
                "clawwork dynamic package %s runs with an explicit fail-safe core-bound key "
                "(never reuses a paid plus/max key); per-tier binding is backlog (#452 covers "
                "core/plus/max)", model,
            )
        # The relay alias is the fallback model for the cost snapshot; agent_end's
        # concrete model (set after _spawn_rpc) upgrades it when available.
        turn_model = model
        prompt = self._prompt(task, goal, repo_path=limits.repo_path, capabilities_note=limits.plugin_capabilities_note)

        agent_dir = Path(limits.artifact_dir) / "clawwork-agent"
        # Lock the agent dir down (0700) BEFORE projecting any skill prose into it,
        # so a projected SKILL.md is never world-readable in the window before the
        # provider-seeding step would have chmod'd it (and so injected runs, which
        # skip seeding, are locked too). Fail-closed: if the lockdown cannot be
        # established, refuse rather than project under default (world-readable)
        # permissions.
        try:
            agent_dir.mkdir(parents=True, exist_ok=True)
            agent_dir.chmod(0o700)
        except OSError as exc:
            return synth(f"CLAWWORK_AGENT_DIR_SETUP_FAILED: {exc}", 1)
        if os.name == "nt" and not harden_path(agent_dir, is_dir=True):
            # chmod(0o700) is a no-op on NTFS. Fail-closed (per the lockdown
            # contract above): if the owner-only ACL cannot be established, refuse
            # rather than project the relay key under broad inherited permissions.
            return synth("CLAWWORK_AGENT_DIR_SETUP_FAILED: could not restrict agent dir ACL to current user", 1)
        # @skill overlays: ClawWork resolves tools through its relay and cannot
        # host the SuperClaw MCP proxy, so a tool-skill is fail-closed here while a
        # prose skill is projected into ClawWork's own per-run skill directory
        # (CLAWWORK_CODING_AGENT_DIR/skills). Done BEFORE relay-key provisioning so
        # an unavailable skill refuses the run without first mutating env/account
        # state.
        skill_error = self._project_run_skills(limits, agent_dir)
        if skill_error is not None:
            return synth(skill_error, 1)

        # Write the signed policy snapshot for the in-process governance extension.
        from superclaw.clawwork_policy import write_policy_snapshot

        handle = write_policy_snapshot(
            directory=str(limits.artifact_dir),
            mode=(policy.mode if policy else "default"),
            allowed_tools=(policy.allowed_tools if policy else []),
            disallowed_tools=(policy.disallowed_tools if policy else []),
            pay_switch_enabled=False,  # pay is never on the default path
            run_id=session.run_id,
            issued_at=started_at,
        )
        # Governance liveness handshake (defense in depth): the extension writes
        # this file at load time; _spawn_rpc waits for it before the first prompt
        # and fail-closes if it never appears — so a silently-failed `-e` load
        # cannot leave the run ungoverned. The handshake is content-checked, not
        # existence-checked: a per-spawn nonce ties the file to THIS process.
        # The nonce is ALSO in the path so concurrent attempts of the same run
        # (artifact dir is reused) can never collide on one ready file; the
        # unlink is belt-and-suspenders against an improbable path reuse.
        handshake_nonce = secrets.token_hex(16)
        ready_file = str(Path(limits.artifact_dir) / f"clawwork-governance-ready-{session.run_id}-{handshake_nonce}")
        with contextlib.suppress(OSError):
            os.unlink(ready_file)
        # Account-isolation (adversarial review): provision/refresh the relay key BEFORE
        # snapshotting the child env. In a long-lived process that switched accounts,
        # _ensure_relay_key_for_run() runs the owner-checked resolver+ensure, which
        # re-provisions for the CURRENT account and rewrites os.environ — so the snapshot
        # below carries the current account's key, never a stale hydrated key from a prior
        # account (a child env copied BEFORE ensure would leak account A's key to B's run).
        if not injected:
            # 传 ensure_tier（标准档=自身；动态档=显式 "core"，绝不 None）：ensure 据此把 key 绑到
            # superclaw-{tier} 分组（切档自动换池），且档位闸恒生效，绝不复用别档缓存 key。
            provision_error = self._ensure_relay_key_for_run(tier=ensure_tier)
            if provision_error:
                return synth(provision_error, 125)
        env = dict(os.environ)
        env.update(handle.env())
        # Propagate trace correlation to the clawwork rpc child: scrubs any stale
        # inherited SUPERCLAW_TRACE_* and stamps the current context only. Also
        # scrub operator-authority vars (route B): an agent backend never inherits
        # the operator's ambient API token.
        env = scrub_operator_authority_env(trace_context.child_env(env))
        env["SUPERCLAW_GOVERNANCE_READY_FILE"] = ready_file
        env["SUPERCLAW_GOVERNANCE_NONCE"] = handshake_nonce
        # Isolate the agent dir so ambient global extensions (~/.clawwork) cannot
        # register tools that bypass governance; the dir is per-run + per-artifact.
        env["CLAWWORK_CODING_AGENT_DIR"] = str(agent_dir)
        # Tier 2 native session: point ClawWork's session storage at the SuperClaw-owned
        # durable 0700 dir so ``--session-id`` resumes across runs (caller-resolved; the
        # per-run agent dir above stays separate). Absent for one-shot worker/delivery runs.
        from superclaw.clawwork_session import (
            CLAWWORK_SESSION_DIR_ENV,
            is_resumable_native_session,
            is_valid_native_session_id,
            native_session_lock,
        )

        native_session_id = limits.native_session_id if is_valid_native_session_id(limits.native_session_id or "") else None
        if native_session_id and limits.native_session_dir is not None:
            env[CLAWWORK_SESSION_DIR_ENV] = str(limits.native_session_dir)
        if not injected:
            # Defense in depth: pin the child's relay key to the owner- AND tier-checked
            # resolver result. Even though ensure already rewrote os.environ, normalize the
            # copied env to exactly the current account's key **for THIS run's tier** (or strip
            # it on mismatch/logout) so a stale or wrong-tier SUPERCLAW_RELAY_API_KEY can never
            # reach the ClawWork subprocess.
            #
            # tier-aware（Codex 终审阻断项）：传 ensure_tier 让 resolve 走档位闸——杜绝"ensure 后、
            # pin key 前另一并发 run / `ensure-key --tier max` 把同账号缓存换成别档 key，本 run 在
            # post-ensure resolve 误用付费 key"的窗口。失配 → 空 key → 下面 fail-closed。
            from superclaw import relay_key as _relay_key
            owned_relay_key, _ = _relay_key.resolve_relay_api_key(tier=ensure_tier)
            if not owned_relay_key:
                # ensure raced with an account switch / logout / tier swap so no owned same-tier
                # key remains: fail closed. Never start ClawWork with an empty or wrong-tier key,
                # and never let seed re-resolve a different account's/tier's key into models.json.
                return synth(
                    "CLAWWORK_RELAY_KEY_MISSING: relay key missing or ownership/tier changed "
                    "after ensure (account switch / concurrent tier swap?) — refusing to start",
                    125,
                )
            env[_relay_key.RELAY_KEY_ENV] = owned_relay_key
            # base 校验 fail-closed：relay key 即将写进 models.json 给 ClawWork 子进程发往
            # base，不安全 base（userinfo 注入 / 远程 http 明文 / %-编码）会把 key exfil 到
            # 攻击者 host —— 早暴露 125，绝不带不安全 base 起跑（统一收口阻断项）。
            # Resolve the relay base through the env-baked per-environment default (or an
            # explicit override) and pin it into the child env, so the ClawWork subprocess +
            # the seeded models.json carry the same validated base whether or not the env var
            # was set by hand. resolve_relay_base_url() validates fail-closed (userinfo /
            # remote http / %-encoding would exfil the key to an attacker host).
            try:
                env["SUPERCLAW_RELAY_BASE_URL"] = _relay_key.resolve_relay_base_url()
            except _relay_key.RelayKeyError as exc:
                return synth(f"CLAWWORK_RELAY_BASE_INVALID: {exc}", 125)

        runner = self._rpc_fn or self._spawn_rpc
        try:
            # seed 写的 models.json 含明文 relay key。把它放进 try 内：从写明文那一刻
            # 起，之后任何失败（含 command 构造）都会走 finally 删掉它，绝不在产物树里
            # 残留明文（即用即弃——把唯一写明文的步骤纳入 unlink 保护范围，顾问 F-N2）。
            if not injected:
                # Pass the owner-checked key/base_url resolved ONCE above; seed must not
                # re-resolve global auth/env (would reopen the concurrent-switch window).
                self._seed_clawrelay_provider(
                    agent_dir, model,
                    api_key=owned_relay_key,
                    base_url=env.get("SUPERCLAW_RELAY_BASE_URL"),
                )

            command = [executable, "--mode", "rpc"]
            if native_session_id and limits.native_session_dir is not None:
                # Resume/continue ClawWork's durable on-disk session: create-if-missing,
                # open-if-exists (canary-verified). The caller already ran the resume
                # pre-flight (refusing a phantom resume) so a missing file here is a
                # deliberate first turn that legitimately creates the session.
                command.extend(["--session-id", native_session_id, "--session-dir", str(limits.native_session_dir)])
            else:
                command.append("--no-session")
            command.extend(["--provider", "clawrelay"])
            if model:
                command.extend(["--model", model])
            # CLI-layer hard gate (does NOT depend on the extension loading): a
            # read-only posture drives ClawWork's own `--tools` allowlist so even a
            # custom/ambient mutating tool is never enabled. The extension stays the
            # fine-grained second layer (denylist / pay-scan / per-tool).
            tool_allowlist = self._clawwork_tool_allowlist(policy)
            if tool_allowlist is not None:
                command.extend(["--tools", ",".join(tool_allowlist)])
            if governance_ext:
                command.extend(["-e", governance_ext])

            runner_kwargs: dict[str, Any] = dict(
                executable=executable, command=command, env=env,
                cwd=str(limits.repo_path), budget_seconds=float(limits.budget_seconds),
                cancel_check=limits.cancel_check,
            )
            # Live tool.* projection only flows through the real _spawn_rpc stdout
            # loop; an injected test double returns a result dict directly and never
            # streams, so it must not receive (or need) the event_sink kwarg.
            if self._rpc_fn is None:
                runner_kwargs["event_sink"] = limits.event_sink
            # Serialise concurrent turns of one native session: ClawWork's list-then-create
            # session write would otherwise mint two divergent <timestamp>_<id> files for a
            # same-id race (blocker #2). One-shot runs (no native session) take no lock.
            if native_session_id and limits.native_session_dir is not None:
                with native_session_lock(limits.native_session_dir, native_session_id):
                    # TOCTOU close: re-verify the durable session UNDER the lock right
                    # before the spawn. If the caller expected a resume but the file is
                    # no longer a unique header-verified match (a concurrent delete /
                    # same-id race between the API pre-flight and now), fail closed —
                    # --session-id would otherwise silently start an empty session and
                    # the turn (seeded only with catch-up) would lose all context.
                    if limits.native_session_expect_resume and not is_resumable_native_session(
                        limits.native_session_dir, native_session_id, expected_repo=str(limits.repo_path),
                    ):
                        return synth(
                            "CLAWWORK_NATIVE_SESSION_LOST: expected resume but the durable session "
                            "file is missing/ambiguous under lock; retire the binding and full-seed",
                            125,
                        )
                    result = runner({"type": "prompt", "message": prompt}, **runner_kwargs)
            else:
                result = runner({"type": "prompt", "message": prompt}, **runner_kwargs)
        except Exception as exc:  # transport/spawn failure surfaces as a failed run
            return synth(f"CLAWWORK_RUNTIME_ERROR: {type(exc).__name__}: {exc}", 1)
        finally:
            if not injected:
                # The provider file carries the relay key in plaintext and only
                # needs to outlive the ClawWork process — never leave a durable
                # plaintext copy in the run artifact tree.
                try:
                    (agent_dir / "models.json").unlink(missing_ok=True)
                except OSError:
                    pass

        if result.get("cancelled"):
            return synth(result.get("output") or "clawwork run cancelled", 130, cancelled=True)
        if result.get("timed_out"):
            return synth(result.get("output") or f"clawwork run timed out after {limits.budget_seconds}s", 124, timed_out=True)
        if result.get("ungoverned"):
            # The governance handshake failed — treat as a hard governance error,
            # never as a completed run.
            return synth(result.get("output") or "CLAWWORK_UNGOVERNED: governance handshake failed", 126)
        if result.get("prompt_rejected"):
            # ClawWork refused the prompt outright (no API key / no model selected /
            # malformed request) and would otherwise idle in RPC mode until the budget
            # expired. _spawn_rpc surfaces it immediately; fail closed (non-zero, no
            # completion marker) so a rejected turn is never billed as completed and the
            # surface shows the real reason fast instead of a phantom timeout.
            return synth(result.get("output") or "CLAWWORK_PROMPT_REJECTED: clawwork rejected the prompt", 125)
        if result.get("model_error"):
            # The relay/model call failed (provider 401/403/5xx or an upstream
            # model error): ClawWork ended the turn with stopReason=error and no
            # assistant response, yet still exits 0. WITHOUT this guard run() would
            # append the status=completed marker and the orchestrator would treat a
            # turn the model never answered as a completed run — a fake success.
            # Fail closed (non-zero exit, no completion marker), like ungoverned.
            return synth(result.get("output") or "CLAWWORK_MODEL_ERROR: the relay/model call failed", 125)

        # Past the error early-exits: only a clean finish OR a governance-blocked
        # finish reaches here, and BOTH ran the model and consumed tokens (a blocked
        # turn merely had a tool call denied). Upgrade the cost snapshot with the
        # turn's real telemetry so it is billed honestly — a governance-blocked turn
        # still records its actual tokens, while its non-zero exit (below) marks the
        # CostEvent failed. cancelled / timed-out / model-error returned already and
        # never reach this point, so they keep turn_usage=None / the relay alias.
        raw_usage = result.get("usage")
        if isinstance(raw_usage, dict):
            # ClawWork's Usage shape (input/output/cacheRead, third_party/clawwork
            # ai/types.ts) is normalised to the canonical token keys the cost
            # snapshot understands HERE, at the adapter boundary, rather than
            # teaching the generic _extract_cost_snapshot bare field names that could
            # mis-read a future backend's usage dict. Raw fields are kept for audit.
            turn_usage = {**raw_usage}
            # setdefault: derive a canonical key from ClawWork's bare field ONLY when
            # the payload didn't already provide it, so a future variant that emits
            # canonical ``*_tokens`` directly is never clobbered to None.
            turn_usage.setdefault("input_tokens", raw_usage.get("input"))
            turn_usage.setdefault("output_tokens", raw_usage.get("output"))
            turn_usage.setdefault("cache_read_input_tokens", raw_usage.get("cacheRead"))
        concrete_model = result.get("model")
        if isinstance(concrete_model, str) and concrete_model.strip():
            turn_model = concrete_model.strip()

        exit_code = int(result.get("exit_code", 0))
        output = str(result.get("output") or "")
        if result.get("governance_blocked"):
            # A tool was blocked by governance: do NOT mark the run completed
            # (that would be a false positive). Surface a non-zero exit so the
            # verifier sees the run did not cleanly finish its intended work.
            marker = "CLAWWORK_GOVERNANCE_BLOCKED: a tool call was blocked by SuperClaw governance"
            return synth((output + "\n" + marker).strip(), exit_code if exit_code != 0 else 1)
        if exit_code == 0:
            output += (
                f"\nsuperclaw_worker_result backend={self.name} role={task.role.value} "
                f"goal={goal.goal_id} status=completed"
            )
        return synth(output, exit_code)

    # ClawWork's whole tool universe is read/bash/edit/write/grep/find/ls;
    # the read-only postures keep only the non-mutating subset.
    _CLAWWORK_READONLY_TOOLS = ["read", "grep", "find", "ls"]
    _CLAWWORK_EDITS_OK_TOOLS = ["read", "grep", "find", "ls", "write", "edit"]

    @staticmethod
    def _translate_relay_package_model(*, model: str | None) -> str | None:
        """Translate a selected super package into the relay group slug to route on.

        The clawwork model override is a SuperClaw package id (套餐: core/plus/max…),
        not a raw model. The relay routes on the package's group slug
        (``plus`` → ``superclaw-plus``), exactly like ClawHunt's
        ``relay_group_slug_for_package``. Applied once here so both the seeded
        ``models.json`` and the ``--model`` arg carry the same slug.

        - Known static tier / ``superclaw-*`` alias → static map (no network).
        - Any OTHER non-empty value → consult the live package list once
          (fail-safe): a DYNAMIC package id (e.g. a future ``pro``) resolves to its
          catalog group slug; a raw model override or ``configured-default`` that
          matches nothing is passed through verbatim. The live lookup runs only off
          the common static path, so standard runs stay network-free.
        """
        if not model:
            return model
        from superclaw.relay_packages import (
            normalize_package_id_from_options,
            normalize_relay_package_id,
            relay_group_slug_for_package,
            relay_packages,
        )

        if normalize_relay_package_id(model):
            return relay_group_slug_for_package(model)
        # Non-standard string: could be a dynamic package id needing its catalog
        # slug, or a raw model override to pass through. A fail-safe live lookup
        # decides; any failure degrades to verbatim (never blocks the run).
        try:
            options = relay_packages().get("packages", [])
        except Exception:
            options = []
        package_id = normalize_package_id_from_options(model, options)
        if package_id:
            return relay_group_slug_for_package(package_id, options)
        return model

    @classmethod
    def _clawwork_tool_allowlist(cls, policy) -> list[str] | None:
        """Translate a SuperClaw posture into ClawWork's ``--tools`` allowlist.

        Returns None when no CLI-layer restriction applies (the extension is the
        only gate). ClawWork's RPC mode is headless — it can never ASK — so any
        posture that would prompt projects to a hard bound instead (fail-closed,
        mirroring _approval_decision_for_policy's tiers):

        - ``plan``: read-only set, regardless of explicit allowlists (strictest).
        - explicit ``allowed_tools``: the pre-approved exhaustive set as-is.
        - ``acceptEdits``/``auto``: file changes are pre-accepted, commands would
          ask -> everything but ``bash``.
        - ``bypassPermissions``/``dontAsk``: unrestricted at this layer.
        - ``default`` (and anything unknown): would ask for every mutation ->
          read-only set. A missing policy (the CLI folds an all-default
          ``PermissionPolicy()`` to ``None``) IS the default posture, so it
          gets the same read-only bound — never an unrestricted CLI layer.

        The returned list drives ClawWork's own ``--tools`` flag so a blocked
        tool is never even ENABLED — a hard bound that holds regardless of
        whether the governance extension loaded."""
        from superclaw.clawwork_policy import canonicalize_tool_names

        if policy is None:
            return list(cls._CLAWWORK_READONLY_TOOLS)
        mode = getattr(policy, "mode", None)
        if mode == "plan":
            return list(cls._CLAWWORK_READONLY_TOOLS)
        explicit = canonicalize_tool_names(getattr(policy, "allowed_tools", None))
        if explicit:
            return explicit
        if mode in {"acceptEdits", "auto"}:
            return list(cls._CLAWWORK_EDITS_OK_TOOLS)
        if mode in {"bypassPermissions", "dontAsk"}:
            return None
        return list(cls._CLAWWORK_READONLY_TOOLS)

    @staticmethod
    def _ensure_relay_key_for_run(tier: str | None = None) -> str | None:
        """The third step of the key resolution chain (env > cached > logged-in
        auto-provision > fail-closed), executed at run time on the real spawn
        path. Returns a fail-closed error string instead of raising so run()
        can surface it as a synthetic worker result.

        档位（issue #452）：``tier`` 透传给 ``ensure_relay_key``。**不再 pre-resolve 短路**
        —— 旧实现先 ``resolve_relay_api_key()`` 拿到 key 就跳过 ensure，但 resolve 不看档位，
        切档时会复用绑了旧分组的 key（违反"切档换池"）。``ensure_relay_key`` 自身对手动 env /
        同档缓存命中走不触网短路，仅切档/无 key 才 exchange，故直接调它既保证 key 绑当前档、
        又不多触网。"""
        from superclaw import relay_key as _relay_key

        try:
            _relay_key.ensure_relay_key(tier=tier)
        except _relay_key.RelayKeyError as exc:
            return f"CLAWWORK_RELAY_KEY_MISSING: {exc}"
        except Exception as exc:  # network/bridge failure stays fail-closed, never a silent empty key
            return f"CLAWWORK_RELAY_KEY_MISSING: relay key auto-provision failed: {type(exc).__name__}: {exc}"
        return None

    @staticmethod
    def _seed_clawrelay_provider(
        agent_dir: Path, model: str | None,
        *, api_key: str | None = None, base_url: str | None = None,
    ) -> None:
        """Write the ``clawrelay`` provider into ClawWork's models.json so
        ``--provider clawrelay`` resolves to the configured relay endpoint. The
        relay base URL / key come from env (never hard-coded); a missing base URL
        is already gated by ``available()`` and the key by
        ``_ensure_relay_key_for_run()``.

        Account-isolation (adversarial review R3): run() resolves the owner-checked key
        ONCE after ensure and passes it in via ``api_key``; seed NEVER resolves global
        auth/env itself — that previously reopened a window where the provider file could
        be written with a different account's key after a concurrent switch. Callers
        (including tests) must pass a non-empty key explicitly; a missing/blank key raises
        ValueError (the caller owns the fail-closed decision, see run())."""
        if base_url is None:
            base_url = os.environ.get("SUPERCLAW_RELAY_BASE_URL", "")
        base_url = (base_url or "").strip()
        if not base_url:
            return
        # base 校验：relay key 明文写进 models.json 供 ClawWork 子进程发往它，必须严防
        # userinfo 注入 / 远程 http 明文 / %-编码把 key exfil 到攻击者 host（统一收口阻断项）。
        # validate 返回规范化 base，并对不安全配置 raise RelayKeyError（run 已先 fail-closed）。
        from superclaw.relay_key import validate_relay_base_url

        base_url = validate_relay_base_url(base_url)
        # strip 后再校验：纯空白 api_key（"   "）也算缺失，绝不写空白 key（顾问第五轮纵深）。
        api_key = api_key.strip() if isinstance(api_key, str) else ""
        if not api_key:
            # 调用方（run）必须传入 owner 校验后的非空 key；空值是上游 fail-closed 缺失的缺陷，
            # 绝不默默写空 apiKey 起跑（顾问第四轮纵深）。
            raise ValueError(
                "_seed_clawrelay_provider requires a non-empty api_key (run() passes the "
                "owner-checked key; empty means an upstream fail-closed was missed)"
            )
        # The provider file carries the relay key in plaintext (ClawWork reads it as its
        # provider config), so it gets the same on-disk posture as the cached key itself:
        # 0700 dir / 0600 file.
        resolved_key = api_key
        agent_dir.mkdir(parents=True, exist_ok=True)
        agent_dir.chmod(0o700)
        if os.name == "nt":
            harden_path(agent_dir, is_dir=True)  # NTFS owner-only ACL (chmod is a no-op)
        models = [{"id": model}] if model else []
        provider = {
            "providers": {
                "clawrelay": {
                    "baseUrl": base_url,
                    "api": os.environ.get("SUPERCLAW_RELAY_API", "openai-completions"),
                    "apiKey": resolved_key or "",
                    "models": models,
                }
            }
        }
        provider_path = agent_dir / "models.json"
        provider_path.write_text(json.dumps(provider, indent=2), encoding="utf-8")
        provider_path.chmod(0o600)
        if os.name == "nt":
            harden_path(provider_path, is_dir=False)  # relay key plaintext: owner-only ACL

    def skill_capability(self) -> "Any":
        """ClawWork hosts prose skills only (it resolves tools through its relay,
        so it cannot host the SuperClaw MCP proxy a tool-skill needs)."""
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.relay_backend()

    def _project_run_skills(self, limits: WorkerLimits, agent_dir: Path) -> str | None:
        """Project @skill overlays into ClawWork's run-scoped skill dir, fail-closed.

        Returns ``None`` when there is nothing to do or projection succeeded, or a
        model-facing error string (for ``synth``) when a requested skill is
        unavailable on ClawWork. ClawWork's capability is relay (prose projection,
        no MCP), so a tool-skill or an unknown id makes ``prepare_run_skills``
        raise and the run is refused rather than degraded.
        """
        skills_dir = agent_dir / "skills"
        # Reconcile the run-scoped skill dir to EXACTLY this run's overlays: drop
        # any prior projection first so a reused artifact dir can never leak a skill
        # not requested this turn (ClawWork's loader is recursive). Done even when
        # there are no skill_ids, so "remove an overlay" turns actually drop it.
        if skills_dir.is_symlink():
            skills_dir.unlink()
        elif skills_dir.exists():
            shutil.rmtree(skills_dir, ignore_errors=True)

        skill_ids = getattr(limits, "skill_ids", ()) or ()
        if not skill_ids:
            return None
        from superclaw.skill_runtime import SkillRuntimeError, prepare_run_skills

        try:
            prepare_run_skills(
                tuple(skill_ids),
                capability=self.skill_capability(),
                skills_dir=skills_dir,
            )
        except SkillRuntimeError as exc:
            return f"SKILL_UNAVAILABLE: {exc}"
        return None

    def _spawn_rpc(self, command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check, event_sink=None):
        """Drive a real ``clawwork --mode rpc`` subprocess: send one prompt, read
        strict-JSONL events until ``agent_end``, collect assistant text. Splits on
        ``\\n`` only (RPC framing requirement) and honors budget + cancel.

        When ``event_sink`` is provided, the tool_execution_{start,update,end}
        events on the same JSONL stream are projected into canonical tool.* display
        events (via the clawwork projector) and pushed to the sink in real time; a
        terminal repair pass on exit closes any tool card the stream left open so
        the UI never spins forever."""
        import queue
        import threading

        from superclaw.display_projection import (
            new_clawwork_projection_state,
            project_clawwork_event,
            project_terminal_repair,
        )

        proj_state = new_clawwork_projection_state() if event_sink is not None else None
        # Set in the cancel paths so terminal repair marks any dangling tool card
        # ``cancelled`` rather than ``error`` (a timeout/crash leaves it ``error``).
        cancelled_flag = False

        def _emit_display(events) -> None:
            if event_sink is None:
                return
            for display_event in events:
                event_sink(display_event.type, display_event.to_dict())

        proc = subprocess.Popen(
            command, cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        # Cross-platform raw reader: dedicated blocking-read threads feed a stdout
        # queue + an stderr tail buffer, so the main loop needs NEITHER fcntl /
        # O_NONBLOCK NOR select-on-pipes — both are POSIX-only (select cannot watch
        # a pipe fd on Windows, and fcntl does not exist there). stderr must be
        # continuously drained or a chatty child dead-locks once the OS pipe
        # buffer (~64KB) fills; the main loop polls the stdout queue with a
        # timeout so a half-written line (crash mid-write) can never block past
        # the budget the way a blocking readline() would.
        _STDERR_TAIL_CAP = 32768
        _STDOUT_EOF = object()
        stdout_queue: "queue.Queue[object]" = queue.Queue()
        stderr_parts: list[str] = []
        stderr_lock = threading.Lock()

        def _pump_stdout() -> None:
            fileobj = proc.stdout
            if fileobj is None:
                stdout_queue.put(_STDOUT_EOF)
                return
            fd = fileobj.fileno()
            try:
                while True:
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    stdout_queue.put(data)
            except OSError:
                pass
            finally:
                stdout_queue.put(_STDOUT_EOF)

        def _pump_stderr() -> None:
            fileobj = proc.stderr
            if fileobj is None:
                return
            fd = fileobj.fileno()
            try:
                while True:
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    with stderr_lock:
                        stderr_parts.append(data.decode("utf-8", errors="replace"))
                        # Bound the retained tail to a fixed cap REGARDLESS of
                        # chunk size — collapse to a single trimmed part.
                        if sum(len(p) for p in stderr_parts) > _STDERR_TAIL_CAP:
                            stderr_parts[:] = ["".join(stderr_parts)[-_STDERR_TAIL_CAP:]]
            except OSError:
                pass

        stdout_pump = threading.Thread(target=_pump_stdout, name="clawwork-rpc-stdout", daemon=True)
        stderr_pump = threading.Thread(target=_pump_stderr, name="clawwork-rpc-stderr", daemon=True)
        stdout_pump.start()
        stderr_pump.start()

        def _stderr_text() -> str:
            with stderr_lock:
                return "".join(stderr_parts)

        try:
            assert proc.stdin is not None and proc.stdout is not None
            deadline = time.monotonic() + max(1.0, budget_seconds)
            # Governance liveness handshake: do NOT send the prompt until the
            # extension has written its ready file (proving the tool_call gate is
            # registered). The file's CONTENT is what satisfies the handshake —
            # handler_registered must be true and the nonce must match this
            # spawn's — so a stale file from a previous attempt of the same run
            # (the artifact dir is reused) can never stand in for a live gate.
            # If it never appears within the bound, the `-e` load silently
            # failed — fail closed (kill, never run ungoverned).
            ready_file = env.get("SUPERCLAW_GOVERNANCE_READY_FILE")
            if ready_file:
                expected_nonce = env.get("SUPERCLAW_GOVERNANCE_NONCE") or ""

                def _handshake_ok() -> bool:
                    try:
                        payload = json.loads(Path(ready_file).read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        return False
                    if not isinstance(payload, dict) or payload.get("handler_registered") is not True:
                        return False
                    # Fail-closed: a nonce MUST be issued and MUST match. An empty
                    # expected nonce never satisfies the handshake (the backend
                    # always issues one; a missing one means a misconfigured spawn,
                    # which must not run ungoverned).
                    return bool(expected_nonce) and payload.get("nonce") == expected_nonce

                handshake_deadline = time.monotonic() + min(15.0, max(1.0, budget_seconds))
                while not _handshake_ok():
                    # (stderr is continuously drained by the stderr pump thread)
                    if proc.poll() is not None:
                        stderr = _stderr_text()
                        return {"ungoverned": True, "output": f"CLAWWORK_UNGOVERNED: clawwork exited before governance activated{(': ' + stderr.strip()) if stderr.strip() else ''}"}
                    if cancel_check and cancel_check():
                        proc.kill()
                        return {"cancelled": True, "output": "clawwork run cancelled by SuperClaw"}
                    if time.monotonic() >= handshake_deadline:
                        proc.kill()
                        # Surface the child's stderr: a failed `-e` load (syntax /
                        # dependency error) prints its stack there, and that is the
                        # single most useful breadcrumb for why governance never
                        # came up. Without it the operator only sees "did not signal
                        # ready" with no cause.
                        stderr = _stderr_text()
                        detail = f": {stderr.strip()}" if stderr.strip() else ""
                        return {"ungoverned": True, "output": f"CLAWWORK_UNGOVERNED: governance extension did not signal ready (its -e load failed, or the ready file lacked this spawn's nonce); refusing to run ungoverned{detail}"}
                    time.sleep(0.05)
            proc.stdin.write(json.dumps(command_obj) + "\n")
            proc.stdin.flush()
            text_parts: list[str] = []
            buffer = ""
            blocked_reasons: list[str] = []
            while True:
                if cancel_check and cancel_check():
                    proc.kill()
                    cancelled_flag = True
                    return {"cancelled": True, "output": "clawwork run cancelled by SuperClaw"}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    proc.kill()
                    stderr = _stderr_text()
                    out = "".join(text_parts)
                    return {"timed_out": True, "output": (out + ("\n" + stderr if stderr.strip() else "")).strip()}
                # Poll the stdout queue with a timeout (the stdout pump thread does
                # the blocking read). Timing out lets us re-check budget/cancel; an
                # EOF sentinel means the child closed stdout.
                try:
                    item = stdout_queue.get(timeout=min(0.5, remaining))
                except queue.Empty:
                    if proc.poll() is not None and not stdout_pump.is_alive():
                        break
                    continue
                if item is _STDOUT_EOF:
                    if proc.poll() is not None:
                        break
                    continue
                buffer += item.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.rstrip("\r")
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    etype = event.get("type")
                    # A REJECTED prompt is terminal. ClawWork's RPC loop ACKs every
                    # `prompt` command with a {"type":"response","command":"prompt",
                    # "success":bool} envelope: success=true is a mere ACK (the turn's
                    # agent_start/…/agent_end follow it), but success=false means the
                    # prompt was refused outright — no API key, no model selected,
                    # malformed request — and NO turn will run. Critically, ClawWork
                    # then stays ALIVE in RPC mode awaiting the next command and emits
                    # neither agent_end nor EOF. WITHOUT this branch the read loop would
                    # spin until the budget expires (the 40–120s phantom "hang" users
                    # saw when the relay key/model was unusable) before reporting a bare
                    # timeout. Surface the rejection as an immediate fail-closed error so
                    # the chat gets a fast, accurate message instead of a long hang.
                    if etype == "response" and event.get("command") == "prompt" and event.get("success") is False:
                        proc.terminate()
                        err = event.get("error")
                        err_text = (
                            err.strip() if isinstance(err, str) and err.strip()
                            else "clawwork rejected the prompt without a reason"
                        )
                        stderr = _stderr_text()
                        detail = f"; {stderr.strip()[:300]}" if stderr.strip() else ""
                        return {
                            "exit_code": 1,
                            "prompt_rejected": True,
                            "output": f"CLAWWORK_PROMPT_REJECTED: {err_text[:500]}{detail}",
                        }
                    # NOTE: message_update events carry assistantMessageEvent
                    # deltas, not top-level text; the final text is read from
                    # agent_end only (parsing both would double-count).
                    if etype in ("tool_execution_start", "tool_execution_update", "tool_execution_end"):
                        # Project the tool lifecycle into canonical tool.* cards for
                        # any live surface; a no-op when no event_sink is wired.
                        if proj_state is not None:
                            _emit_display(project_clawwork_event(event, proj_state))
                        if etype == "tool_execution_end":
                            # The governance extension prefixes every block reason with
                            # "SuperClaw governance:"; a block surfaces as an ERROR tool
                            # result carrying that reason. Scope the marker match to the
                            # result of an errored call (not the whole event) so a tool
                            # whose normal output merely mentions the string can't be
                            # mis-read as a governance block.
                            if event.get("isError") and "SuperClaw governance:" in json.dumps(event.get("result")):
                                blocked_reasons.append("a tool call was blocked by SuperClaw governance")
                    elif etype == "agent_end":
                        # Track the terminal assistant turn's stop reason: a failed
                        # provider/model call (relay 401/403/5xx, upstream/model
                        # error) surfaces as the LAST assistant message ending with
                        # stopReason == "error" (empty content, zero tokens), even
                        # though ClawWork itself exits 0.
                        last_assistant_stop = None
                        last_assistant_usage: dict[str, Any] | None = None
                        last_assistant_model: str | None = None
                        for msg in event.get("messages") or []:
                            for block in (msg.get("content") or []):
                                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                                    text_parts.append(block["text"])
                            if msg.get("role") == "assistant":
                                last_assistant_stop = msg.get("stopReason")
                                # Capture the terminal assistant turn's cost metadata:
                                # the token usage and the CONCRETE model the relay
                                # actually served (``responseModel`` when it differs
                                # from the requested alias, else ``model``). These ride
                                # the success result so run() can stamp real
                                # model/token usage into the cost snapshot instead of
                                # leaving it unknown/0.
                                if isinstance(msg.get("usage"), dict):
                                    last_assistant_usage = msg["usage"]
                                concrete_model = msg.get("responseModel") or msg.get("model")
                                if isinstance(concrete_model, str) and concrete_model.strip():
                                    last_assistant_model = concrete_model.strip()
                        proc.terminate()
                        output = "".join(text_parts).strip()
                        if blocked_reasons:
                            output = (output + "\n" if output else "") + "; ".join(dict.fromkeys(blocked_reasons))
                        if last_assistant_stop == "error":
                            # The model never produced a completed response — do NOT
                            # report this as a successful (exit 0) turn. run() maps
                            # model_error to a hard failure so the orchestrator can't
                            # mark a model-less turn "completed" (fake-success guard).
                            stderr = _stderr_text()
                            detail = f": {stderr.strip()[:500]}" if stderr.strip() else ""
                            partial = f" (partial output discarded: {output[:200]})" if output else ""
                            return {
                                "exit_code": 1,
                                "model_error": True,
                                "output": (
                                    "CLAWWORK_MODEL_ERROR: the relay/model call failed "
                                    f"(stopReason=error); no completed assistant response{detail}{partial}"
                                ),
                            }
                        return {
                            "exit_code": 0,
                            "output": output or "(clawwork produced no text output)",
                            "governance_blocked": bool(blocked_reasons),
                            "usage": last_assistant_usage,
                            "model": last_assistant_model,
                        }
            # process ended without agent_end
            stderr = _stderr_text()
            return {"exit_code": proc.returncode or 1, "output": ("".join(text_parts) + ("\n" + stderr if stderr else "")).strip() or "clawwork exited without an agent_end event"}
        finally:
            # Close any tool card the stream left open (timeout / cancel / crash /
            # model-error before tool_execution_end) so a live surface never spins
            # forever. A clean agent_end already popped every call, so this is a
            # no-op on the success path. Best-effort: a sink failure here must never
            # mask the run's real outcome.
            if proj_state is not None:
                try:
                    _emit_display(project_terminal_repair(proj_state, cancelled=cancelled_flag))
                except Exception:
                    pass
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:
                pass


def resolve_clawwork_runtime_paths() -> tuple[str | None, str | None]:
    """Resolve ``(governance_ext, executable)`` absolute paths for ClawWork via the
    SAME discovery :class:`ClawWorkBackend` uses (env override > frozen desktop
    bundle > source checkout). Returns ``None`` for any path that does not resolve
    to an existing file.

    WHY this exists (single source of truth across the Python/Node boundary): the
    server-refactor moved ClawWork *execution* into the Node ``clawwork-local``
    adapter, which re-derives these paths by walking up from its own module to
    ``third_party/clawwork``. That walk-up only works in a built source checkout and
    BREAKS in a frozen/relocated desktop bundle — there ClawWork ships at
    ``<backend>/clawwork/`` (discovered here by :func:`_frozen_clawwork_dir`), which
    is NOT an ancestor of the Node server tree, so the adapter finds nothing and
    refuses to run (``CLAWWORK_UNGOVERNED``). :mod:`superclaw.node_runtime` calls
    this and hands the resolved paths to the Node child via
    ``SUPERCLAW_CLAWWORK_GOVERNANCE_EXT`` / ``SUPERCLAW_CLAWWORK_EXECUTABLE`` so the
    kernel — not a fragile filesystem walk — owns ClawWork discovery, and a packaged
    app drives ClawWork *governed* instead of failing closed.

    The kernel governance posture is unchanged: the Node adapter still fails closed
    on its own when neither these env vars nor its walk-up resolve, and ClawWork's
    in-process governance barrier still proves the gate is live. This only supplies
    the paths the adapter would otherwise have to (and cannot) discover itself.
    """
    backend = ClawWorkBackend()
    ext = backend._resolve_governance_ext()
    # str() guards against a future refactor returning a Path: the result is handed
    # to subprocess env, which accepts only strings (matches the -> str annotation).
    ext_path = str(ext) if ext and Path(ext).is_file() else None
    exe = backend._resolve_executable()
    exe_path = str(exe) if exe and Path(exe).exists() else None
    return ext_path, exe_path


class AnthropicApiBackend(_AgentCliBackend):
    """Worker backend that calls Claude Opus 4.8 directly through the Anthropic Messages API.

    Independent of the Claude Code CLI. ``available()`` gates on ANTHROPIC_API_KEY +
    the ``anthropic`` SDK. A ``message_fn`` can be injected for deterministic tests.
    """

    name = "anthropic"
    failure_markers = ()

    def permission_presets(self) -> PresetMap:
        return make_presets(
            ask=PresetRealization("single text completion (no tool execution to gate)", False, "perm.note.anthropic.ask", preset_driven=False),
            allow=PresetRealization("single text completion (no tool execution to gate)", False, "perm.note.anthropic.allow", preset_driven=False),
        )

    def __init__(self, *, model: str | None = None, message_fn=None, max_tokens: int = 4096) -> None:
        self.model = model or os.environ.get("SUPERCLAW_ANTHROPIC_MODEL", "claude-opus-4-8")
        self._message_fn = message_fn
        self.max_tokens = max_tokens
        # Run plane = the Anthropic API at anthropic_base_url() with ANTHROPIC_API_KEY
        # (via the SDK). Exposing base_url + _resolve_api_key lets the reachability
        # probe's model-discovery (_probe_anthropic GETs base_url/v1/models with the
        # SAME key) verify this exact plane — so the backend's "faithful" discovery
        # class is true to its implementation, not a structural mismatch.
        self.base_url = anthropic_base_url().rstrip("/")

    def _resolve_api_key(self) -> str | None:
        return os.environ.get("ANTHROPIC_API_KEY")

    def available(self) -> BackendAvailability:
        if self._message_fn is not None:
            return BackendAvailability(name=self.name, available=True, version=f"injected:{self.model}")
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return BackendAvailability(name=self.name, available=False, reason="ANTHROPIC_API_KEY not set")
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return BackendAvailability(name=self.name, available=False, reason="anthropic SDK not installed")
        return BackendAvailability(name=self.name, available=True, version=self.model)

    def _invoke(self, prompt: str, model: str | None = None) -> str:
        model = model or self.model
        if self._message_fn is not None:
            return str(self._message_fn(model, prompt))
        import anthropic

        # Run on the SAME plane the reachability probe verifies: the configured
        # base_url + ANTHROPIC_API_KEY. Passing them explicitly (instead of letting
        # the SDK pick its own default) keeps discovery and run from diverging when
        # SUPERCLAW_ANTHROPIC_BASE_URL points at a custom endpoint — the precondition
        # for this backend's "faithful" discovery class to be true to implementation.
        client = anthropic.Anthropic(base_url=self.base_url, api_key=self._resolve_api_key())
        message = client.messages.create(
            model=model,
            max_tokens=self.max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(getattr(block, "text", "") for block in message.content if getattr(block, "type", None) == "text")

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        started_at = time.time()
        started = time.monotonic()
        model = (limits.model_override or "").strip() or self.model
        command_repr = f"anthropic.messages.create model={model}"
        if limits.cancel_check and limits.cancel_check():
            finished_at = time.time()
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output="Anthropic call cancelled by SuperClaw before dispatch", exit_code=130,
                started_at=started_at, finished_at=finished_at, duration=time.monotonic() - started,
                cancelled=True, forced_kill=True,
            )
        prompt, prompt_projection = self._projected_cli_prompt(
            task,
            goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits,
            session=session,
        )
        try:
            output = self._invoke(prompt, model)
            exit_code = 0
        except Exception as exc:  # network/auth/quota errors surface as a failed worker
            output = f"anthropic call failed: {type(exc).__name__}: {exc}"
            exit_code = 1
        finished_at = time.time()
        return self._synthetic_result(
            task=task, session=session, limits=limits, command_repr=command_repr,
            output=output, exit_code=exit_code, started_at=started_at, finished_at=finished_at,
            duration=time.monotonic() - started,
            transcript_extra=self._runtime_extra(
                executable="anthropic.messages",
                model=model,
                provider="anthropic",
                api_mode="anthropic_messages",
                prompt_projection=prompt_projection,
            ),
        )


class _RealToolExecution:
    """Shared real-execution tool layer for API-driven agent backends: a path
    sandbox plus run_shell/write_file/read_file/list_files dispatch. Reused by the
    Gemini (OpenAI-format) and Anthropic (Messages-format) agent loops so the
    security-critical sandbox lives in exactly one place."""

    # B-class: company-management tools are dispatched IN-LOOP via the
    # orchestrator-bound resolver (``_maybe_add_company_tools`` +
    # ``WorkerLimits.company_command_resolver``). The orchestrator therefore must
    # NOT also inject the team MCP proxy for these — that would double-stack the
    # same vocabulary. A-class native backends leave this False and get the MCP path.
    surfaces_company_tools_in_loop: bool = True

    def permission_presets(self) -> PresetMap:
        # B-class: SuperClaw OWNS the tool loop (no underlying runtime to delegate
        # to), so the preset is enforced as an in-process posture. Shared by every
        # _RealToolExecution backend (gemini-agent, anthropic-agent).
        #
        # Doctrine: both presets map to bypassPermissions -> posture=full (the
        # in-process escalation gate fires only under non-full posture, which the
        # presets no longer select; low-trust runs are still floored read-only by
        # ContainmentPolicy.permission_mode_floor, independent of the preset).
        # ask == allow at runtime; preset_driven=False is the honest signal.
        return make_presets(
            ask=PresetRealization("in-process posture=full (max; both presets)", False, "perm.note.posture.ask", preset_driven=False),
            allow=PresetRealization("in-process posture=full (max; both presets)", False, "perm.note.posture.allow", preset_driven=False),
        )

    # Write targets that are high-risk regardless of posture: editing them is never
    # a "normal workspace change" and must escalate even under acceptEdits (roadmap
    # §8.2: .git/hooks, executable entrypoints, CI/package scripts, credential/config).
    # All comparisons are case-FOLDED so a case-insensitive filesystem (macOS) cannot
    # bypass via `.GIT/hooks` or `DOCKERFILE`. Conservative D1 baseline — extend it.
    _RESERVED_WRITE_PARTS: frozenset[str] = frozenset({".git", ".github", ".ssh", ".aws", ".gnupg", ".circleci"})
    _RESERVED_WRITE_NAMES: frozenset[str] = frozenset({
        ".env", ".npmrc", ".pypirc", ".netrc", "credentials", "id_rsa", "id_ed25519",
        "package.json", "package-lock.json", "pyproject.toml", "setup.py", "setup.cfg",
        "makefile", "justfile", ".gitlab-ci.yml", ".pre-commit-config.yaml",
    })
    _RESERVED_WRITE_SUFFIXES: tuple[str, ...] = (".pem", ".key")
    # Name PREFIXES (case-folded) — catches Dockerfile/Dockerfile.prod and
    # .env/.env.local/.env.production (dotenv variants).
    _RESERVED_WRITE_NAME_PREFIXES: tuple[str, ...] = ("dockerfile", ".env.")

    _GEMINI_DELEGATE_TOOL: dict[str, Any] = {
        "type": "function",
        "function": {
            "name": "delegate",
            "description": (
                "Delegate a bounded subtask to another SuperClaw runtime. The kernel authorizes, "
                "spawns, and reviews the child run; use only for a separable subtask."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subtask": {"type": "string", "description": "Concrete bounded work to delegate."},
                    "runtime": {"type": "string", "description": "Optional target runtime id."},
                    "model_tier": {"type": "string", "description": "Optional model tier or model id."},
                    "profile": {"type": "string", "description": "Optional agent profile id to narrow equipment."},
                    "budget_seconds": {"type": "integer", "description": "Optional positive budget cap in seconds."},
                },
                "required": ["subtask"],
            },
        },
    }

    _ANTHROPIC_DELEGATE_TOOL: dict[str, Any] = {
        "name": "delegate",
        "description": (
            "Delegate a bounded subtask to another SuperClaw runtime. The kernel authorizes, "
            "spawns, and reviews the child run; use only for a separable subtask."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "subtask": {"type": "string", "description": "Concrete bounded work to delegate."},
                "runtime": {"type": "string", "description": "Optional target runtime id."},
                "model_tier": {"type": "string", "description": "Optional model tier or model id."},
                "profile": {"type": "string", "description": "Optional agent profile id to narrow equipment."},
                "budget_seconds": {"type": "integer", "description": "Optional positive budget cap in seconds."},
            },
            "required": ["subtask"],
        },
    }

    def _delegation_tool_enabled(self, session: RunSession) -> bool:
        from superclaw.cross_runtime_delegation import delegation_eligible
        from superclaw.runtime_config import delegation_enabled as cross_runtime_delegation_enabled

        depth = (session.execution_context or {}).get("delegation_depth", 0)
        return (
            cross_runtime_delegation_enabled()
            and delegation_eligible(getattr(self, "name", None))
            and isinstance(depth, int)
            and not isinstance(depth, bool)
            and depth == 0
        )

    def _maybe_add_delegate_tool(self, tools: list[dict], *, session: RunSession, schema: str) -> list[dict]:
        if not self._delegation_tool_enabled(session):
            return tools
        delegate = self._GEMINI_DELEGATE_TOOL if schema == "gemini" else self._ANTHROPIC_DELEGATE_TOOL
        return [*tools, json.loads(json.dumps(delegate))]

    def _company_tools_enabled(self, limits: WorkerLimits) -> bool:
        """Whether the company-management tools should be projected this run.

        Fail-closed on the WIRING: even when the env toggle is ON (default), the
        tools are projected ONLY when the orchestrator bound a
        ``company_command_resolver`` (i.e. a real StateStore is available). With no
        resolver the agent could call a tool the kernel cannot execute, so we omit
        it entirely rather than expose a dead tool. The env toggle
        (``SUPERCLAW_COMPANY_TOOLS``) lets an operator turn the capability off
        even when a store is present."""
        from superclaw.runtime_config import company_tools_enabled

        return company_tools_enabled() and limits.company_command_resolver is not None

    def _maybe_add_company_tools(
        self, tools: list[dict], *, limits: WorkerLimits, schema: str
    ) -> list[dict]:
        """Append the company-management tools (single-source derived) when enabled.

        The schemas come from ``ui_contracts.build_company_command_tool_schema`` —
        the SINGLE source both backends derive from (no hand-copied second
        definition). Imported lazily because ``ui_contracts`` imports this module
        (``backends``) at load time; a top-level import here would be a cycle."""
        if not self._company_tools_enabled(limits):
            return tools
        from superclaw.ui_contracts import build_company_command_tool_schema

        return [*tools, *build_company_command_tool_schema(schema)]

    def _company_read_tools_enabled(self, limits: WorkerLimits) -> bool:
        """Project the company READ tools only when the same company toggle is on
        AND the orchestrator bound a ``company_read_resolver`` (a real store +
        scope). Gated on the SAME ``company_tools_enabled()`` switch as the mutation
        tools — reads and writes are one feature — but on the READ resolver's
        presence, so a context with only the write seam never advertises a dead read
        tool. No resolver → omit (never a tool the kernel cannot run)."""
        from superclaw.runtime_config import company_tools_enabled

        return company_tools_enabled() and limits.company_read_resolver is not None

    def _maybe_add_company_read_tools(
        self, tools: list[dict], *, limits: WorkerLimits, schema: str
    ) -> list[dict]:
        """Append the company READ tools (single-source derived) when enabled.

        Mirrors ``_maybe_add_company_tools``: schemas come from
        ``ui_contracts.build_company_read_tool_schema`` (the single source). Lazy
        import to avoid the backends↔ui_contracts cycle."""
        if not self._company_read_tools_enabled(limits):
            return tools
        from superclaw.ui_contracts import build_company_read_tool_schema

        return [*tools, *build_company_read_tool_schema(schema)]

    @staticmethod
    def _marketplace_tools_enabled(limits: WorkerLimits) -> bool:
        """Same wiring-fail-closed gate as company tools, for marketplace (P3):
        projected ONLY when the env toggle is ON (default) AND the orchestrator
        bound a ``marketplace_command_resolver`` (a real store + scope). No resolver
        → omit the tools entirely (never a dead tool the kernel cannot run)."""
        from superclaw.runtime_config import marketplace_tools_enabled

        return marketplace_tools_enabled() and limits.marketplace_command_resolver is not None

    def _maybe_add_marketplace_tools(
        self, tools: list[dict], *, limits: WorkerLimits, schema: str
    ) -> list[dict]:
        """Append the SOLVER marketplace tools (single-source derived) when enabled.

        Mirrors ``_maybe_add_company_tools``: schemas come from
        ``ui_contracts.build_marketplace_command_tool_schema`` (the single source);
        buyer-side accept/accept_bid are excluded from that source. Lazy import to
        avoid the backends↔ui_contracts cycle."""
        if not self._marketplace_tools_enabled(limits):
            return tools
        from superclaw.ui_contracts import build_marketplace_command_tool_schema

        return [*tools, *build_marketplace_command_tool_schema(schema)]

    def supports_containment(self, policy: "ContainmentPolicy") -> bool:
        # B-class OWNS the tool loop, so a low-trust fence is PROVABLY enforced
        # in-process by _exec_tool: the readonly posture denies run_shell and
        # write_file, and with shell + writes denied there is no data-plane egress
        # or filesystem-write path left. (A conformance test forces every new
        # in-process tool to be classified, so a future tool cannot silently open
        # a hole.) Unlike a delegated runtime whose built-in tools bypass this
        # loop, the fence here is real — so the B-class runtime admits low-trust.
        return True

    def _safe_path(self, repo: Path, raw: str) -> Path:
        candidate = (repo / (raw or ".")).resolve()
        repo_resolved = repo.resolve()
        if candidate != repo_resolved and repo_resolved not in candidate.parents:
            raise ValueError(f"path escapes repository sandbox: {raw}")
        return candidate

    def _reserved_write_target(self, repo: Path, args: dict) -> str | None:
        """Return a display path when a write target is a reserved/sensitive location
        that must escalate even under workspace posture; None for an ordinary file.
        An out-of-sandbox path returns None here — the normal write path rejects it.
        Matching is case-folded to defeat case-insensitive-filesystem bypasses."""
        try:
            path = self._safe_path(repo, str(args.get("path", "")))
        except ValueError:
            return None
        try:
            rel = path.relative_to(repo.resolve())
        except ValueError:
            return None
        name = path.name.casefold()
        parts_folded = {part.casefold() for part in rel.parts}
        if parts_folded & self._RESERVED_WRITE_PARTS:
            return str(rel)
        if name in self._RESERVED_WRITE_NAMES:
            return str(rel)
        if any(name.endswith(suffix) for suffix in self._RESERVED_WRITE_SUFFIXES):
            return str(rel)
        if any(name.startswith(prefix) for prefix in self._RESERVED_WRITE_NAME_PREFIXES):
            return str(rel)
        return None

    def _enforce_escalation_gate(self, name: str, args: dict, limits: WorkerLimits, *, reserved_path: str | None) -> str | None:
        """Run the escalation gate for a dangerous action. Returns a fail-closed
        denial string when no approval channel is wired OR when the action was already
        denied by a human (EscalationDenied — a sticky deny must not re-prompt);
        returns None when a grant was consumed (proceed); lets EscalationPending
        propagate when approval is needed and a channel exists (the orchestrator then
        suspends the run)."""
        gate = limits.escalation_gate
        if gate is None:
            target = f" (target {reserved_path})" if reserved_path else ""
            return (
                f"error: permission denied: '{name}'{target} needs approval but no approval "
                f"channel is available under the current non-full permission posture. Re-run "
                f"under the 'allow' preset (max permission) to permit it. Do not retry."
            )
        try:
            gate(name, dict(args), reserved_path)  # consumes a grant (returns) or raises EscalationPending
        except EscalationDenied:
            target = f" (target {reserved_path})" if reserved_path else ""
            return (
                f"error: permission denied: '{name}'{target} was denied by a human reviewer; "
                f"the decision is final for this run. Do not retry."
            )
        return None

    def _exec_tool(
        self,
        name: str,
        args: dict,
        limits: WorkerLimits,
        deadline: float,
        parent_tool_call_id: str | None = None,
    ) -> str:
        repo = Path(limits.repo_path)
        mode = limits.permission_policy.mode if limits.permission_policy else None
        posture = posture_for_mode(mode)
        containment_delegate = (
            name == "delegate"
            and limits.containment_policy is not None
            and limits.containment_policy.max_delegation_depth > 0
        )
        if posture_denies_tool(posture, name) and not containment_delegate:
            return f"error: permission denied: read-only mode ({mode}) forbids '{name}'; do not retry"
        # Containment fence (T11): a low-trust review run is read-only even when
        # the permission mode would allow writes/shell — the policy floor wins.
        # This is the in-process half of the fence the orchestrator already
        # admitted via supports_containment(); it denies run_shell (the only
        # egress path) and write_file.
        if containment_denies_tool(limits.containment_policy, name, mode=mode) and not containment_delegate:
            preset = limits.containment_policy.preset if limits.containment_policy else "?"
            return f"error: permission denied: containment '{preset}' forbids '{name}'; do not retry"
        if name == "delegate":
            from superclaw.cross_runtime_delegation import DelegationRequested, parse_delegation_request

            request = parse_delegation_request(args)
            if request is None:
                return "error: invalid delegate request"
            raise DelegationRequested(request=request, parent_tool_call_id=parent_tool_call_id)
        # Company-management tools (PR-F): route the 8 chat-projected company
        # commands through the orchestrator-bound resolver, which has the
        # StateStore + actor scope this in-process tool layer lacks. The resolver
        # executes the command IN-LOOP (synchronous kernel mutation, unlike the
        # async child-run delegate above) and returns a model-facing result string
        # for EVERY outcome (executed / pending_approval / error) — it never
        # raises into the agent loop. These tools mutate KERNEL company state, so
        # they are classified as MUTATING in permissions._MUTATING_TOOLS: the
        # read-only-posture and low-trust-containment fences ABOVE already deny
        # them (a plan-mode or untrusted review run cannot reach this branch). The
        # destructive op (archive) ALSO carries its own human-approval gate inside
        # the handler. A tool name not in the closed company map falls through to
        # the workspace tools below.
        from superclaw.ui_contracts import TOOL_NAME_TO_COMMAND_TYPE

        company_command_type = TOOL_NAME_TO_COMMAND_TYPE.get(name)
        if company_command_type is not None:
            resolver = limits.company_command_resolver
            if resolver is None:
                # Fail-closed: the tool was advertised but no store is bound. This
                # should not happen (projection is gated on the resolver), so it is
                # a hard "unavailable", not a silent success.
                return (
                    f"error: company tool '{name}' is unavailable in this context "
                    f"(no company kernel bound); do not retry"
                )
            if not isinstance(args, dict):
                return f"error: company tool '{name}' requires an object argument; do not retry"
            return resolver(company_command_type, dict(args))

        # Company READ tools (roadmap P0): route the projected discovery/snapshot
        # tools through the orchestrator-bound READ resolver, which has the store +
        # actor scope this tool layer lacks. Read-only: they are NOT in
        # _MUTATING_TOOLS, so the read-only-posture / low-trust fences above leave
        # them available (an agent must be able to SEE a company before it can decide
        # how to manage it). The resolver runs the read IN-LOOP and returns the DTO as
        # a JSON string for every outcome (data / scope-denied / error); it never
        # raises. A name not in the closed read map falls through below.
        from superclaw.ui_contracts import COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE

        company_read_type = COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE.get(name)
        if company_read_type is not None:
            read_resolver = limits.company_read_resolver
            if read_resolver is None:
                return (
                    f"error: company tool '{name}' is unavailable in this context "
                    f"(no company kernel bound); do not retry"
                )
            if not isinstance(args, dict):
                return f"error: company tool '{name}' requires an object argument; do not retry"
            return read_resolver(company_read_type, dict(args))

        # ClawHunt marketplace tools (P3): route the projected SOLVER marketplace
        # tools through the orchestrator-bound marketplace resolver (store + scope +
        # client). Reads run in-loop; writes return a pending-approval string. The
        # WRITE tools are in permissions._MUTATING_TOOLS, so the read-only / low-trust
        # fences above already deny them; a tool name not in the closed marketplace
        # map falls through to the workspace tools below.
        from superclaw.ui_contracts import MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE

        marketplace_command_type = MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE.get(name)
        if marketplace_command_type is not None:
            mkt_resolver = limits.marketplace_command_resolver
            if mkt_resolver is None:
                return (
                    f"error: marketplace tool '{name}' is unavailable in this context "
                    f"(no marketplace kernel bound); do not retry"
                )
            if not isinstance(args, dict):
                return f"error: marketplace tool '{name}' requires an object argument; do not retry"
            return mkt_resolver(marketplace_command_type, dict(args))
        # Defense-in-depth credential guard (B3): hard-blacklist the operator
        # credential MATERIAL (~/.superclaw/credentials, *.env, secrets.key, ...; and
        # the whole ~/.config/superclaw) plus keychain-read commands for AGENT tool
        # calls. NOT the whole ~/.superclaw — its chats/ workspaces/ companies/
        # subtrees are legitimate managed workspaces and stay allowed. The
        # _safe_path sandbox already confines reads to repo, but this is an
        # independent inner fence (realpath-normalized, inode-based) so a
        # symlinked/`../`-traversed path or a `security find-generic-password`
        # shell-out cannot exfiltrate the human operator's tokens. Kernel-internal
        # config access does NOT route through _exec_tool, so this never affects the
        # kernel reading its own state.
        #
        # The tool's real working directory: run_shell uses cwd=repo and the file
        # tools resolve paths relative to repo via _safe_path. Pass it so the guard
        # resolves relative tokens/paths against the SAME cwd the tool will, not the
        # process cwd (closes the `cat leak/credentials` symlink-bypass).
        guard_cwd = str(repo)
        try:
            if name == "run_shell":
                assert_command_allowed(args.get("command", ""), cwd=guard_cwd)
            elif name in ("read_file", "write_file", "list_files"):
                # list_files defaults to '.' (repo root); read/write default ''.
                default = "." if name == "list_files" else ""
                raw_path = str(args.get("path", default) or default)
                assert_file_access_allowed(raw_path, cwd=guard_cwd)
        except CredentialAccessError as exc:
            return f"error: permission denied: {exc}; do not retry"
        # Permission posture: B-class backends ARE the runtime, so the preset/mode is
        # enforced here directly (no underlying runtime to delegate to).
        #   * read-only posture (mode=plan): refuse mutating tools outright.
        #   * full posture (allow / bypassPermissions): execute freely.
        #   * workspace posture (ask / default / acceptEdits / auto / unknown): shell
        #     and reserved-path writes require an approved single-use grant via the
        #     escalation gate (roadmap §8.2 hard gate #2). The OLD behavior of running
        #     shell freely under acceptEdits was fail-open; this closes it.
        # EscalationPending (raised by the gate) MUST propagate, so the gate runs
        # BEFORE the try/except below that would otherwise convert it to a string.
        if posture != "full":
            reserved = self._reserved_write_target(repo, args) if name == "write_file" else None
            if name == "run_shell" or (name == "write_file" and reserved is not None):
                denial = self._enforce_escalation_gate(name, args, limits, reserved_path=reserved)
                if denial is not None:
                    return denial
        try:
            if name == "run_shell":
                command = str(args.get("command", "")).strip()
                if not command:
                    return "error: empty command"
                remaining = max(1.0, deadline - time.monotonic())
                run_kwargs = dict(
                    cwd=str(repo), capture_output=True, text=True,
                    timeout=min(remaining, 120.0), errors="replace",
                )
                if sys.platform == "win32":  # use sys.platform, not an os.name
                    # equality check against the nt literal: that phrasing is
                    # captured by the tool-classification conformance regex
                    # (test_in_process_tools_all_classified) as a phantom tool.
                    # Agent commands are authored in POSIX shell syntax. Prefer a
                    # real POSIX shell (Git Bash / WSL bash) if installed so that
                    # quoting, &&/|, and coreutils behave; otherwise fall back to
                    # cmd.exe (shell=True) so the tool still runs (POSIX-only
                    # syntax may not translate — documented degradation).
                    bash = shutil.which("bash")
                    if bash:
                        completed = subprocess.run([bash, "-lc", command], **run_kwargs)
                    else:
                        completed = subprocess.run(command, shell=True, **run_kwargs)
                else:
                    completed = subprocess.run(command, shell=True, **run_kwargs)
                combined = (completed.stdout or "") + (completed.stderr or "")
                return f"exit_code={completed.returncode}\n{combined}"[:6000]
            if name == "write_file":
                path = self._safe_path(repo, str(args.get("path", "")))
                content = str(args.get("content", ""))
                # Never re-materialize a workspace root that vanished mid-run:
                # parents=True would otherwise recreate a deleted (e.g. inode-pinned
                # real-folder) project root. Create subdirs only inside an existing
                # workspace dir; a missing root is fail-closed.
                if not repo.is_dir():
                    raise ValueError(
                        f"workspace directory {repo} no longer exists; refusing to re-create it"
                    )
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
                return f"wrote {len(content)} bytes to {args.get('path')}"
            if name == "read_file":
                raw_path = str(args.get("path", ""))
                path = self._safe_path(repo, raw_path)
                repo_resolved = repo.resolve()
                resolved_path = path.relative_to(repo_resolved).as_posix()
                # Containment (T11): under a read-only review fence, secret-bearing
                # files are off-limits even though reading the untrusted SOURCE is
                # fine — block credential exfiltration through the review channel.
                if containment_denies_read_path(limits.containment_policy, raw_path) or containment_denies_read_path(
                    limits.containment_policy, resolved_path
                ):
                    return f"error: permission denied: containment forbids reading secret-bearing path '{raw_path}'; do not retry"
                if not path.is_file():
                    return f"error: not a file: {args.get('path')}"
                if (
                    limits.containment_policy is not None
                    and limits.containment_policy.is_low_trust
                    and path.stat().st_nlink > 1
                ):
                    return f"error: permission denied: containment forbids reading linked path '{raw_path}'; do not retry"
                return path.read_text(encoding="utf-8", errors="replace")[:6000]
            if name == "list_files":
                path = self._safe_path(repo, str(args.get("path", ".") or "."))
                if not path.is_dir():
                    return f"error: not a directory: {args.get('path')}"
                entries = sorted(p.name + ("/" if p.is_dir() else "") for p in path.iterdir())
                return "\n".join(entries[:200]) or "(empty directory)"
        except subprocess.TimeoutExpired:
            return "error: command timed out"
        except Exception as exc:  # surface tool failures back to the model
            return f"error: {type(exc).__name__}: {exc}"
        return f"error: unknown tool {name}"

    def _project_tool_to_sink(
        self, limits: WorkerLimits, call_id: str | None, name: str, args: dict, result: str, ctx: object
    ) -> None:
        """Best-effort post-hoc tool display projection. DL8: a display/sink failure
        must NEVER break the run, so this swallows sink exceptions (mirrors the
        codex/claude ``_emit`` wrappers and ``_emit_batch_diagnostic``). Shared by
        the gemini/anthropic agent loops — the kernel just executed the tool, so it
        emits a REAL tool.started+completed card via the event sink."""
        sink = limits.event_sink
        if sink is None:
            return
        from superclaw.display_projection import project_agent_tool_execution
        try:
            for event in project_agent_tool_execution(call_id, name, args, result, ctx):
                sink(event.type, event.to_dict())
        except Exception:
            pass


class GeminiAgentBackend(_RealToolExecution, _AgentCliBackend):
    """Autonomous worker backend that drives Google Gemini through its
    OpenAI-compatible Chat Completions endpoint in a real tool-using agent loop.

    Unlike ``anthropic`` (single completion that only records text) and the CLI
    backends (which shell out to external agent CLIs needing their own creds), this
    backend OWNS the loop: Gemini decides actions via OpenAI ``tool_calls`` and
    SuperClaw executes them for real (shell, file read/write/list) inside the
    sandboxed repo checkout, iterating until the model calls ``finish`` or the
    iteration/time budget is exhausted. This makes intelligent, real execution
    possible with only a Gemini API key — no Anthropic credentials required — and
    needs no Node/CLI install in the deployment image (pure stdlib HTTP).

    Env: ``SUPERCLAW_GEMINI_API_KEY`` (or ``GEMINI_API_KEY``), ``SUPERCLAW_GEMINI_MODEL``
    (default ``gemini-2.5-flash``), ``SUPERCLAW_GEMINI_BASE_URL`` (default Google's
    OpenAI-compat endpoint), ``SUPERCLAW_GEMINI_MAX_ITERATIONS`` (default 12),
    ``SUPERCLAW_GEMINI_MAX_TOKENS`` (default 8192). A ``completion_fn`` taking
    ``(messages, tools)`` may be injected for deterministic tests.
    """

    name = "gemini"
    failure_markers = ()

    def skill_capability(self) -> "Any":
        """Inline @skill: this api-loop agent owns its own tools and cannot host the
        SuperClaw MCP proxy, so prose skills are inlined into TOOL_CONTRACT and a
        tool-skill is fail-closed UNAVAILABLE."""
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.prose_only()
    # B-class api-agent: SuperClaw OWNS the tool loop and projects REAL tool cards
    # post-hoc (project_agent_tool_execution). True => _run_backend skips the BATCH
    # diagnostic (DL4) for this backend, which surfaces its own tool.* events.
    surfaces_live_tools = True

    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

    def __init__(
        self,
        *,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        max_iterations: int | None = None,
        max_tokens: int | None = None,
        completion_fn=None,
    ) -> None:
        self.model = model or os.environ.get("SUPERCLAW_GEMINI_MODEL", "gemini-2.5-flash")
        self.base_url = (base_url or os.environ.get("SUPERCLAW_GEMINI_BASE_URL") or self.DEFAULT_BASE_URL).rstrip("/")
        self._api_key = api_key
        self.max_iterations = int(
            max_iterations if max_iterations is not None else os.environ.get("SUPERCLAW_GEMINI_MAX_ITERATIONS", "12")
        )
        self.max_tokens = int(
            max_tokens if max_tokens is not None else os.environ.get("SUPERCLAW_GEMINI_MAX_TOKENS", "8192")
        )
        self._completion_fn = completion_fn

    def _resolve_api_key(self) -> str | None:
        return self._api_key or os.environ.get("SUPERCLAW_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")

    def available(self) -> BackendAvailability:
        if self._completion_fn is not None:
            return BackendAvailability(name=self.name, available=True, version=f"injected:{self.model}")
        if not self._resolve_api_key():
            return BackendAvailability(
                name=self.name, available=False, reason="SUPERCLAW_GEMINI_API_KEY / GEMINI_API_KEY not set"
            )
        return BackendAvailability(name=self.name, available=True, version=f"{self.model} @ {self.base_url}")

    def _tools(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "run_shell",
                    "description": "Run a shell command in the repository working directory; returns exit code and combined stdout/stderr.",
                    "parameters": {
                        "type": "object",
                        "properties": {"command": {"type": "string", "description": "The shell command to execute."}},
                        "required": ["command"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Create or overwrite a UTF-8 text file (path relative to repo root); parent dirs are created automatically.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                        "required": ["path", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a UTF-8 text file (path relative to repo root).",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List entries of a directory (path relative to repo root, defaults to repo root).",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "finish",
                    "description": "Call when the task is fully complete and verified. Summarize what was changed and how it was verified.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "summary": {"type": "string"},
                            "success": {"type": "boolean", "description": "true if the task completed successfully"},
                        },
                        "required": ["summary"],
                    },
                },
            },
        ]

    def _complete(self, messages: list[dict], tools: list[dict], timeout: float, model: str | None = None) -> dict:
        if self._completion_fn is not None:
            return self._completion_fn(messages, tools)
        payload = {
            "model": model or self.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": self.max_tokens,
        }
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self._resolve_api_key()}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:500] if hasattr(exc, "read") else ""
            raise RuntimeError(f"gemini HTTP {exc.code}: {body}") from exc

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        if (skill_guard := self._skill_overlay_guard(task=task, session=session, limits=limits)) is not None:
            return skill_guard
        started_at = time.time()
        started = time.monotonic()
        model = (limits.model_override or "").strip() or self.model
        command_repr = f"gemini.agent model={model} base={self.base_url} max_iter={self.max_iterations}"
        runtime_extra = {
            "local_agent_runtime": api_agent_runtime_spec(
                backend=self.name,
                model=model,
                provider="google-gemini",
                api_mode="chat_completions",
                transport="chat_completions",
                system_channel="native_structured",
                supports_tool_schema=True,
                supports_cache_control=False,
                notes=["SuperClaw-owned tool loop over OpenAI-compatible Gemini endpoint"],
            ).to_dict()
        }

        def _cancelled_now() -> bool:
            return bool(limits.cancel_check and limits.cancel_check())

        if _cancelled_now():
            finished_at = time.time()
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output="Gemini agent cancelled by SuperClaw before dispatch", exit_code=130,
                started_at=started_at, finished_at=finished_at, duration=time.monotonic() - started,
                cancelled=True, forced_kill=True,
                transcript_extra=runtime_extra,
            )
        if not (self._completion_fn or self._resolve_api_key()):
            finished_at = time.time()
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output="Gemini agent unavailable: SUPERCLAW_GEMINI_API_KEY / GEMINI_API_KEY not set", exit_code=127,
                started_at=started_at, finished_at=finished_at, duration=time.monotonic() - started,
                transcript_extra=runtime_extra,
            )

        # Ensure the workspace exists so shell tools (cwd=repo_path) and file tools
        # work even when the orchestrator points at a fresh per-run workspace dir.
        try:
            if not limits.protected_cwd:
                # Protected real-folder projects are validated upstream (inode pin)
                # and must never be re-created here — a missing dir fails closed.
                Path(limits.repo_path).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        deadline = started + max(1.0, float(limits.budget_seconds))
        tools = self._maybe_add_delegate_tool(self._tools(), session=session, schema="gemini")
        tools = self._maybe_add_company_tools(tools, limits=limits, schema="gemini")
        tools = self._maybe_add_company_read_tools(tools, limits=limits, schema="gemini")
        tools = self._maybe_add_marketplace_tools(tools, limits=limits, schema="gemini")
        system_prompt = (
            f"You are SuperClaw's autonomous {task.role.value} worker operating inside a sandboxed repository "
            f"checkout at {limits.repo_path}. Use the tools to make REAL, minimal, verifiable changes that "
            f"accomplish the goal. Prefer running commands and editing files over describing them. Verify your "
            f"work (run tests/build/relevant commands) before finishing. When the task is fully complete, call "
            f"the `finish` tool with a concise summary. You have a limited time and iteration budget — act "
            f"efficiently and never repeat an identical failing action."
        )
        projection = self._project_prompt(
            task,
            goal,
            limits=limits,
            session=session,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            capabilities=PromptProjectionCapabilities(
                system_channel="native_structured",
                supports_tool_schema=True,
                supports_cache_control=False,
                backend=self.name,
                notes=("SuperClaw-owned Gemini tool loop",),
            ),
            native_tool_schema=tools,
            runtime_adapter=system_prompt,
        )
        tools = [dict(tool) for tool in projection.native_tool_schema] or tools
        messages: list[dict] = [
            {"role": "system", "content": self._projection_system_text(projection)},
            *[message.to_dict() for message in projection.messages],
        ]
        runtime_extra["prompt_projection"] = self._projection_transcript_extra(projection)
        from superclaw.display_projection import GEMINI_AGENT_RUNTIME_ID, new_agent_projection_state
        display_ctx = new_agent_projection_state(GEMINI_AGENT_RUNTIME_ID)
        transcript: list[str] = []
        stream_events: list[dict[str, Any]] = []
        completed = success = timed_out = cancelled = False
        error: str | None = None
        finish_summary = ""
        actions = 0
        iteration = 0
        for iteration in range(1, self.max_iterations + 1):
            if _cancelled_now():
                cancelled = True
                break
            if time.monotonic() >= deadline:
                timed_out = True
                break
            try:
                remaining = max(5.0, deadline - time.monotonic())
                response = self._complete(messages, tools, timeout=min(remaining, 90.0), model=model)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                transcript.append(f"[iter {iteration}] model call failed: {error}")
                stream_events.append({"provider": self.name, "type": "model_error", "iteration": iteration, "error": error})
                break
            choice = (response.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            content = message.get("content")
            tool_calls = message.get("tool_calls") or []
            stream_events.append(
                {
                    "provider": self.name,
                    "type": "model_response",
                    "iteration": iteration,
                    "finish_reason": choice.get("finish_reason"),
                    "content": content or "",
                    "tool_call_count": len(tool_calls),
                }
            )
            if content:
                transcript.append(f"[iter {iteration}] assistant: {content}")
            assistant_msg: dict = {"role": "assistant", "content": content or ""}
            if tool_calls:
                assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)
            if not tool_calls:
                completed = True
                success = actions > 0  # text-only with no real action is "planned", not "delivered"
                finish_summary = content or "(model returned no further actions)"
                break
            stop = False
            for tool_call in tool_calls:
                fn = tool_call.get("function") or {}
                tool_name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    parsed = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except json.JSONDecodeError:
                    parsed = {}
                if not isinstance(parsed, dict):
                    parsed = {}
                if tool_name == "finish":
                    completed = True
                    success = bool(parsed.get("success", True))
                    finish_summary = str(parsed.get("summary", ""))
                    transcript.append(f"[iter {iteration}] finish: success={success} :: {finish_summary}")
                    stream_events.append(
                        {
                            "provider": self.name,
                            "type": "finish",
                            "iteration": iteration,
                            "success": success,
                            "summary": finish_summary,
                        }
                    )
                    messages.append({"role": "tool", "tool_call_id": tool_call.get("id", ""), "content": "acknowledged"})
                    stop = True
                    continue
                actions += 1
                result = self._exec_tool(tool_name, parsed, limits, deadline, parent_tool_call_id=tool_call.get("id"))
                # Post-hoc real-tool display projection (best-effort, DL8): the
                # kernel just executed this tool, so emit a real tool card.
                self._project_tool_to_sink(limits, tool_call.get("id"), tool_name, parsed, result, display_ctx)
                stream_events.append(
                    {
                        "provider": self.name,
                        "type": "tool_call",
                        "iteration": iteration,
                        "tool_call_id": tool_call.get("id", ""),
                        "tool_name": tool_name,
                        "arguments": parsed,
                    }
                )
                stream_events.append(
                    {
                        "provider": self.name,
                        "type": "tool_result",
                        "iteration": iteration,
                        "tool_call_id": tool_call.get("id", ""),
                        "tool_name": tool_name,
                        "result": result,
                    }
                )
                transcript.append(f"[iter {iteration}] {tool_name}({json.dumps(parsed)[:300]}) ->\n{result[:1500]}")
                messages.append({"role": "tool", "tool_call_id": tool_call.get("id", ""), "content": result})
            if stop:
                break

        duration = time.monotonic() - started
        finished_at = time.time()
        if cancelled:
            exit_code = 130
        elif timed_out:
            exit_code = 124
        elif error is not None:
            exit_code = 1
        elif completed and success:
            exit_code = 0
        else:
            exit_code = 1  # finished-without-success, or ran out of iterations
        status = (
            "completed" if exit_code == 0
            else "cancelled" if cancelled
            else "timeout" if timed_out
            else "failed"
        )
        header = f"gemini agent: model={model} iterations={iteration} actions={actions} status={status}"
        if finish_summary:
            header += f"\nsummary: {finish_summary}"
        if error:
            header += f"\nerror: {error}"
        output = header + "\n\n" + ("\n".join(transcript) if transcript else "(no actions taken)")
        if cancelled:
            output = f"Gemini agent cancelled by SuperClaw\n{output}"
        elif timed_out:
            output = f"Gemini agent timed out after {limits.budget_seconds}s\n{output}"
        if exit_code == 0:
            output += (
                f"\nsuperclaw_worker_result backend={self.name} role={task.role.value} "
                f"goal={goal.goal_id} status=completed"
            )
        stream_events.append(
            {
                "provider": self.name,
                "type": "terminal",
                "iterations": iteration,
                "actions": actions,
                "status": status,
                "exit_code": exit_code,
            }
        )
        return self._synthetic_result(
            task=task, session=session, limits=limits, command_repr=command_repr,
            output=output, exit_code=exit_code, started_at=started_at, finished_at=finished_at,
            duration=duration, cancelled=cancelled, timed_out=timed_out,
            transcript_extra=runtime_extra,
            stream_events=stream_events,
        )


class AnthropicAgentBackend(_RealToolExecution, _AgentCliBackend):
    """Autonomous worker backend that drives Claude (Opus 4.8 by default) through the
    Anthropic Messages API in a real tool-using agent loop.

    Like ``gemini`` but for Anthropic: the model decides actions via Messages-API
    ``tool_use`` blocks and SuperClaw executes them for real (``run_shell``,
    ``write_file``, ``read_file``, ``list_files``) inside the sandboxed repo
    checkout, iterating until the model stops requesting tools (``end_turn``) or the
    iteration/time budget is exhausted. Distinct from the single-shot ``anthropic``
    backend, this one truly executes. Pure stdlib HTTP (urllib) — no Node/agent-CLI
    install needed, so it deploys cleanly to headless containers / Cloud Run while
    running at Claude Opus 4.8.

    Env: ``ANTHROPIC_API_KEY``, ``SUPERCLAW_ANTHROPIC_AGENT_MODEL`` (falls back to
    ``SUPERCLAW_ANTHROPIC_MODEL`` then ``claude-opus-4-8``), ``SUPERCLAW_ANTHROPIC_BASE_URL``
    (provider public API by default), ``SUPERCLAW_ANTHROPIC_AGENT_MAX_ITERATIONS``
    (default 12), ``SUPERCLAW_ANTHROPIC_AGENT_MAX_TOKENS`` (default 8192). A
    ``completion_fn`` taking ``(system, messages, tools)`` may be injected for tests.
    """

    name = "anthropic-agent"
    failure_markers = ()

    def skill_capability(self) -> "Any":
        """Inline @skill: this api-loop agent owns its own tools and cannot host the
        SuperClaw MCP proxy, so prose skills are inlined into TOOL_CONTRACT and a
        tool-skill is fail-closed UNAVAILABLE."""
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.prose_only()
    # B-class api-agent: SuperClaw OWNS the tool loop and projects REAL tool cards
    # post-hoc (project_agent_tool_execution). True => _run_backend skips the BATCH
    # diagnostic (DL4) for this backend, which surfaces its own tool.* events.
    surfaces_live_tools = True

    DEFAULT_BASE_URL = DEFAULT_ANTHROPIC_BASE_URL
    ANTHROPIC_VERSION = "2023-06-01"

    def __init__(
        self,
        *,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        max_iterations: int | None = None,
        max_tokens: int | None = None,
        completion_fn=None,
    ) -> None:
        self.model = (
            model
            or os.environ.get("SUPERCLAW_ANTHROPIC_AGENT_MODEL")
            or os.environ.get("SUPERCLAW_ANTHROPIC_MODEL")
            or "claude-opus-4-8"
        )
        self.base_url = (base_url or anthropic_base_url()).rstrip("/")
        self._api_key = api_key
        self.max_iterations = int(
            max_iterations if max_iterations is not None else os.environ.get("SUPERCLAW_ANTHROPIC_AGENT_MAX_ITERATIONS", "12")
        )
        self.max_tokens = int(
            max_tokens if max_tokens is not None else os.environ.get("SUPERCLAW_ANTHROPIC_AGENT_MAX_TOKENS", "8192")
        )
        self._completion_fn = completion_fn

    def _resolve_api_key(self) -> str | None:
        return self._api_key or os.environ.get("ANTHROPIC_API_KEY")

    def available(self) -> BackendAvailability:
        if self._completion_fn is not None:
            return BackendAvailability(name=self.name, available=True, version=f"injected:{self.model}")
        if not self._resolve_api_key():
            return BackendAvailability(name=self.name, available=False, reason="ANTHROPIC_API_KEY not set")
        return BackendAvailability(name=self.name, available=True, version=f"{self.model} @ {self.base_url}")

    def _tools(self) -> list[dict]:
        return [
            {
                "name": "run_shell",
                "description": "Run a shell command in the repository working directory; returns exit code and combined stdout/stderr.",
                "input_schema": {
                    "type": "object",
                    "properties": {"command": {"type": "string", "description": "The shell command to execute."}},
                    "required": ["command"],
                },
            },
            {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file (path relative to repo root); parent dirs are created automatically.",
                "input_schema": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["path", "content"],
                },
            },
            {
                "name": "read_file",
                "description": "Read a UTF-8 text file (path relative to repo root).",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            },
            {
                "name": "list_files",
                "description": "List entries of a directory (path relative to repo root, defaults to repo root).",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
        ]

    def _complete(self, system: Any, messages: list[dict], tools: list[dict], timeout: float, model: str | None = None) -> dict:
        if self._completion_fn is not None:
            return self._completion_fn(system, messages, tools)
        payload = {
            "model": model or self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": messages,
            "tools": tools,
        }
        request = urllib.request.Request(
            f"{self.base_url}/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "x-api-key": self._resolve_api_key() or "",
                "anthropic-version": self.ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:500] if hasattr(exc, "read") else ""
            raise RuntimeError(f"anthropic HTTP {exc.code}: {body}") from exc

    def _anthropic_system_content(self, projection: PromptProjectionResult) -> str | list[dict[str, Any]]:
        eligible = {
            section.kind
            for section in projection.cache_sections
            if section.cache_control_eligible
        }
        blocks: list[dict[str, Any]] = []
        for layer in projection.system_layers:
            if not layer.content:
                continue
            block: dict[str, Any] = {
                "type": "text",
                "text": f"## {layer.kind.value}\n{layer.content}",
            }
            if layer.kind in eligible:
                block["cache_control"] = {"type": "ephemeral"}
            blocks.append(block)
        return blocks or self._projection_system_text(projection)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        if (skill_guard := self._skill_overlay_guard(task=task, session=session, limits=limits)) is not None:
            return skill_guard
        started_at = time.time()
        started = time.monotonic()
        model = (limits.model_override or "").strip() or self.model
        command_repr = f"anthropic.agent model={model} base={self.base_url} max_iter={self.max_iterations}"
        runtime_extra = {
            "local_agent_runtime": api_agent_runtime_spec(
                backend=self.name,
                model=model,
                provider="anthropic",
                api_mode="anthropic_messages",
                transport="anthropic_messages",
                system_channel="native_structured",
                supports_tool_schema=True,
                supports_cache_control=True,
                notes=["SuperClaw-owned tool loop over Anthropic Messages API"],
            ).to_dict()
        }

        def _cancelled_now() -> bool:
            return bool(limits.cancel_check and limits.cancel_check())

        if _cancelled_now():
            finished_at = time.time()
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output="Anthropic agent cancelled by SuperClaw before dispatch", exit_code=130,
                started_at=started_at, finished_at=finished_at, duration=time.monotonic() - started,
                cancelled=True, forced_kill=True,
                transcript_extra=runtime_extra,
            )
        if not (self._completion_fn or self._resolve_api_key()):
            finished_at = time.time()
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output="Anthropic agent unavailable: ANTHROPIC_API_KEY not set", exit_code=127,
                started_at=started_at, finished_at=finished_at, duration=time.monotonic() - started,
                transcript_extra=runtime_extra,
            )

        try:
            if not limits.protected_cwd:
                # Protected real-folder projects are validated upstream (inode pin)
                # and must never be re-created here — a missing dir fails closed.
                Path(limits.repo_path).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        deadline = started + max(1.0, float(limits.budget_seconds))
        tools = self._maybe_add_delegate_tool(self._tools(), session=session, schema="anthropic")
        tools = self._maybe_add_company_tools(tools, limits=limits, schema="anthropic")
        tools = self._maybe_add_company_read_tools(tools, limits=limits, schema="anthropic")
        tools = self._maybe_add_marketplace_tools(tools, limits=limits, schema="anthropic")
        system_prompt = (
            f"You are SuperClaw's autonomous {task.role.value} worker operating inside a sandboxed repository "
            f"checkout at {limits.repo_path}. Use the tools to make REAL, minimal, verifiable changes that "
            f"accomplish the goal. Prefer running commands and editing files over describing them. Verify your "
            f"work (run tests/build/relevant commands) before finishing. When the task is fully complete, stop "
            f"calling tools and give a one-line summary. You have a limited time and iteration budget — act "
            f"efficiently and never repeat an identical failing action."
        )
        projection = self._project_prompt(
            task,
            goal,
            limits=limits,
            session=session,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            capabilities=PromptProjectionCapabilities(
                system_channel="native_structured",
                supports_tool_schema=True,
                supports_cache_control=True,
                backend=self.name,
                notes=("SuperClaw-owned Anthropic Messages tool loop",),
            ),
            native_tool_schema=tools,
            runtime_adapter=system_prompt,
        )
        system_prompt = self._anthropic_system_content(projection)
        tools = [dict(tool) for tool in projection.native_tool_schema] or tools
        messages: list[dict] = [message.to_dict() for message in projection.messages]
        runtime_extra["prompt_projection"] = self._projection_transcript_extra(projection)
        from superclaw.display_projection import ANTHROPIC_AGENT_RUNTIME_ID, new_agent_projection_state
        display_ctx = new_agent_projection_state(ANTHROPIC_AGENT_RUNTIME_ID)
        transcript: list[str] = []
        stream_events: list[dict[str, Any]] = []
        completed = success = timed_out = cancelled = False
        error: str | None = None
        finish_summary = ""
        actions = 0
        iteration = 0
        for iteration in range(1, self.max_iterations + 1):
            if _cancelled_now():
                cancelled = True
                break
            if time.monotonic() >= deadline:
                timed_out = True
                break
            try:
                remaining = max(5.0, deadline - time.monotonic())
                response = self._complete(system_prompt, messages, tools, timeout=min(remaining, 90.0), model=model)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                transcript.append(f"[iter {iteration}] model call failed: {error}")
                stream_events.append({"provider": self.name, "type": "model_error", "iteration": iteration, "error": error})
                break
            blocks = response.get("content") or []
            tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
            texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
            stream_events.append(
                {
                    "provider": self.name,
                    "type": "model_response",
                    "iteration": iteration,
                    "stop_reason": response.get("stop_reason"),
                    "content": " ".join(t for t in texts if t),
                    "tool_use_count": len(tool_uses),
                    "usage": response.get("usage") or {},
                }
            )
            if any(texts):
                transcript.append(f"[iter {iteration}] assistant: {' '.join(t for t in texts if t)[:1000]}")
            messages.append({"role": "assistant", "content": blocks})
            if not tool_uses:
                completed = True
                success = actions > 0  # text-only with no real action is "planned", not "delivered"
                finish_summary = " ".join(t for t in texts if t) or "(model returned no further actions)"
                break
            tool_results: list[dict] = []
            for tool_use in tool_uses:
                tool_name = tool_use.get("name") or ""
                tool_input = tool_use.get("input") or {}
                if not isinstance(tool_input, dict):
                    tool_input = {}
                actions += 1
                result = self._exec_tool(tool_name, tool_input, limits, deadline, parent_tool_call_id=tool_use.get("id"))
                # Post-hoc real-tool display projection (best-effort, DL8): the
                # kernel just executed this tool, so emit a real tool card.
                self._project_tool_to_sink(limits, tool_use.get("id"), tool_name, tool_input, result, display_ctx)
                stream_events.append(
                    {
                        "provider": self.name,
                        "type": "tool_call",
                        "iteration": iteration,
                        "tool_call_id": tool_use.get("id", ""),
                        "tool_name": tool_name,
                        "arguments": tool_input,
                    }
                )
                stream_events.append(
                    {
                        "provider": self.name,
                        "type": "tool_result",
                        "iteration": iteration,
                        "tool_call_id": tool_use.get("id", ""),
                        "tool_name": tool_name,
                        "result": result,
                    }
                )
                transcript.append(f"[iter {iteration}] {tool_name}({json.dumps(tool_input)[:300]}) ->\n{result[:1500]}")
                tool_results.append({"type": "tool_result", "tool_use_id": tool_use.get("id", ""), "content": result})
            messages.append({"role": "user", "content": tool_results})

        duration = time.monotonic() - started
        finished_at = time.time()
        if cancelled:
            exit_code = 130
        elif timed_out:
            exit_code = 124
        elif error is not None:
            exit_code = 1
        elif completed and success:
            exit_code = 0
        else:
            exit_code = 1  # finished-without-success, or ran out of iterations
        status = (
            "completed" if exit_code == 0
            else "cancelled" if cancelled
            else "timeout" if timed_out
            else "failed"
        )
        header = f"anthropic agent: model={model} iterations={iteration} actions={actions} status={status}"
        if finish_summary:
            header += f"\nsummary: {finish_summary}"
        if error:
            header += f"\nerror: {error}"
        output = header + "\n\n" + ("\n".join(transcript) if transcript else "(no actions taken)")
        if cancelled:
            output = f"Anthropic agent cancelled by SuperClaw\n{output}"
        elif timed_out:
            output = f"Anthropic agent timed out after {limits.budget_seconds}s\n{output}"
        if exit_code == 0:
            output += (
                f"\nsuperclaw_worker_result backend={self.name} role={task.role.value} "
                f"goal={goal.goal_id} status=completed"
            )
        stream_events.append(
            {
                "provider": self.name,
                "type": "terminal",
                "iterations": iteration,
                "actions": actions,
                "status": status,
                "exit_code": exit_code,
            }
        )
        return self._synthetic_result(
            task=task, session=session, limits=limits, command_repr=command_repr,
            output=output, exit_code=exit_code, started_at=started_at, finished_at=finished_at,
            duration=duration, cancelled=cancelled, timed_out=timed_out,
            transcript_extra=runtime_extra,
            stream_events=stream_events,
        )


class OpenClawGatewayBackend(_AgentCliBackend):
    """Worker backend that drives OpenClaw over its WebSocket Gateway protocol,
    rather than the local ``openclaw`` CLI.

    Verified end-to-end against a real local gateway (openclaw 2026.6.5): the
    backend opens a WebSocket, answers the ``connect.challenge`` with an
    Ed25519-signed device identity plus a shared token, sends one ``agent`` turn
    (``message`` / ``sessionKey`` / ``idempotencyKey``), then ``agent.wait``s for
    the terminal result and maps it to a WorkerResult. The protocol client lives
    in ``openclaw_gateway.py``.

    Config (env, never hard-coded): ``SUPERCLAW_OPENCLAW_GATEWAY_URL`` (required,
    ws:// or wss://), ``SUPERCLAW_OPENCLAW_GATEWAY_TOKEN`` (shared gateway token),
    ``SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH`` (PEM path for a stable, pre-approved
    device identity).

    Pairing: a *new* device must be approved once by an operator
    (``openclaw devices approve <requestId>``); a configured key then stays paired
    across runs. An unpaired device fails the run with a clear
    ``OPENCLAW_GATEWAY_NOT_PAIRED`` message rather than hanging.

    Plugin governance is fail-closed: the gateway resolves its own tools, so
    SuperClaw does not project plugin dirs / MCP configs over the wire; a policy
    carrying them is rejected. preset_driven=False — the agent runs server-side
    and SuperClaw does not CLI-enforce a per-command gate.

    KNOWN LIMITATION — cancellation: the whole turn shares the run budget (a single
    deadline across connect/agent/wait, not three independent timeouts), but the
    blocking ``agent.wait`` cannot honor ``limits.cancel_check`` mid-flight; the
    socket read timeout is the backstop. Prompt cancellation would require a
    non-blocking read loop and is a follow-up.
    """

    name = "openclaw-gateway"
    failure_markers = ()

    def __init__(self, *, url: str | None = None, token: str | None = None, client_factory=None) -> None:
        super().__init__()
        self._url = url
        self._token = token
        self._client_factory = client_factory  # for tests: (url, token) -> client

    def permission_presets(self) -> PresetMap:
        return make_presets(
            ask=PresetRealization(
                "openclaw gateway agent (runs server-side; no preset-driven CLI gate)",
                False, "perm.note.openclaw-gateway.ask", preset_driven=False,
            ),
            allow=PresetRealization(
                "openclaw gateway agent (runs server-side; no preset-driven CLI gate)",
                False, "perm.note.openclaw-gateway.allow", preset_driven=False,
            ),
        )

    def _resolve_url(self) -> str:
        return (self._url or os.environ.get("SUPERCLAW_OPENCLAW_GATEWAY_URL") or "").strip()

    def _resolve_token(self) -> str:
        return (self._token or os.environ.get("SUPERCLAW_OPENCLAW_GATEWAY_TOKEN") or "").strip()

    @staticmethod
    def _safe_url(url: str) -> str:
        """ws(s):// URL with userinfo + query + fragment stripped, safe to log."""
        try:
            p = urllib.parse.urlparse(url)
        except Exception:
            return "(unparseable url)"
        netloc = p.hostname or ""
        if p.port:
            netloc = f"{netloc}:{p.port}"
        return urllib.parse.urlunparse((p.scheme, netloc, p.path, "", "", ""))

    @staticmethod
    def _is_loopback_host(host: str) -> bool:
        h = (host or "").lower()
        if h in {"localhost", "127.0.0.1", "::1", "[::1]"}:
            return True
        try:
            return ipaddress.ip_address(h.strip("[]")).is_loopback
        except ValueError:
            return False

    def available(self) -> BackendAvailability:
        url = self._resolve_url()
        if not url:
            return BackendAvailability(name=self.name, available=False, reason="SUPERCLAW_OPENCLAW_GATEWAY_URL not configured")
        safe = self._safe_url(url)
        try:
            parsed = urllib.parse.urlparse(url)
        except Exception:
            return BackendAvailability(name=self.name, available=False, reason=f"invalid SUPERCLAW_OPENCLAW_GATEWAY_URL: {safe}")
        if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
            return BackendAvailability(name=self.name, available=False, reason=f"SUPERCLAW_OPENCLAW_GATEWAY_URL must be a ws(s):// URL: {safe}")
        # Plaintext ws:// would expose the token / prompt / device signature on the
        # wire. Allow it only for loopback; a remote endpoint must use wss:// (or an
        # explicit insecure opt-in).
        allow_insecure = os.environ.get("SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE", "").strip().lower() in {"1", "true", "yes"}
        if parsed.scheme == "ws" and not self._is_loopback_host(parsed.hostname or "") and not allow_insecure:
            return BackendAvailability(name=self.name, available=False, reason=f"refusing plaintext ws:// to a non-loopback host ({safe}); use wss:// or set SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE=true")
        # websocket-client is a hard runtime dep for this backend; fail-soft in
        # availability rather than crashing mid-run with ImportError.
        try:
            import websocket  # noqa: F401  (websocket-client)
        except Exception:
            return BackendAvailability(name=self.name, available=False, reason="websocket-client not installed (pip install websocket-client)")
        return BackendAvailability(name=self.name, available=True, executable=safe, version=f"gateway {safe}")

    def _make_client(self, url: str, token: str):
        if self._client_factory is not None:
            return self._client_factory(url, token)
        from superclaw.openclaw_gateway import OpenClawGatewayClient

        return OpenClawGatewayClient(url, token=token)

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        started_at = time.time()
        started = time.monotonic()
        url = self._resolve_url()
        safe_url = self._safe_url(url) if url else "(unconfigured)"
        command_repr = f"openclaw-gateway agent {safe_url}"

        def synth(output: str, exit_code: int, *, timed_out: bool = False, cancelled: bool = False) -> WorkerResult:
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output=output, exit_code=exit_code, started_at=started_at, finished_at=time.time(),
                duration=time.monotonic() - started, timed_out=timed_out, cancelled=cancelled,
                transcript_extra=self._runtime_extra(
                    executable=safe_url, provider="openclaw",
                    api_mode="openclaw_gateway_ws", notes=["openclaw gateway websocket agent"],
                ),
            )

        # Entry-time fail-closed validation (URL shape, ws:// loopback policy,
        # websocket-client presence) — security/config checks must hold at run
        # time, not only in availability display.
        availability = self.available()
        if not availability.available:
            return synth(availability.reason or "openclaw gateway not configured", 127)

        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            return synth(
                "PLUGIN_RUNTIME_CONFIG_INVALID: OpenClaw gateway backend does not project SuperClaw "
                "plugin runtime policy (the gateway resolves its own tools). Run without plugin "
                "directories / MCP configs.",
                1,
            )
        if limits.model_override:
            # The server-side agent owns its model (configured on the gateway); the
            # agent protocol carries no per-run model, so an explicit selection
            # cannot be honored — refuse rather than silently running another model.
            return synth(
                f"MODEL_OVERRIDE_UNSUPPORTED: openclaw-gateway runs the gateway's configured agent "
                f"model; clear the model selection ({limits.model_override}) or configure the model "
                "on the gateway side",
                1,
            )

        from superclaw.openclaw_gateway import PROTOCOL_VERSION, OpenClawGatewayError

        prompt = self._prompt(task, goal, repo_path=limits.repo_path, capabilities_note=limits.plugin_capabilities_note)
        session_key = f"superclaw-{session.run_id}-{task.task_id}"
        # Keep the whole turn (connect + agent + wait) inside the run budget by
        # spending against a single shared deadline rather than three independent
        # timeouts that could sum past it.
        deadline = started + max(1.0, float(limits.budget_seconds))

        def _remaining() -> float:
            return max(0.0, deadline - time.monotonic())

        def _cancelled() -> bool:
            return bool(limits.cancel_check and limits.cancel_check())

        # Fail-closed BEFORE any network effect: if we are already cancelled or out
        # of budget, never start a server-side agent run we cannot supervise.
        if _cancelled():
            return synth("openclaw gateway run cancelled before start", 130, cancelled=True)
        if _remaining() <= 0:
            return synth("openclaw gateway run had no budget remaining before start", 124, timed_out=True)

        client = self._make_client(url, self._resolve_token())
        try:
            hello = client.connect(min(_remaining(), 30.0))
            # Verify the gateway negotiated a protocol we speak before sending an
            # agent request — a missing/incompatible protocol means a stale or
            # unexpected peer, not a usable session.
            negotiated = (hello or {}).get("protocol")
            try:
                negotiated_int = int(negotiated)
            except (TypeError, ValueError):
                negotiated_int = None
            if negotiated_int != PROTOCOL_VERSION:
                return synth(
                    f"openclaw gateway negotiated unusable protocol {negotiated!r} "
                    f"(SuperClaw requires {PROTOCOL_VERSION})",
                    1,
                )
            # Re-check the gate just before the agent request: connect may have
            # consumed the budget or the run may have been cancelled meanwhile, and
            # we must not kick off an unsupervised server-side run.
            if _cancelled():
                return synth("openclaw gateway run cancelled after connect (no agent started)", 130, cancelled=True)
            if _remaining() <= 0:
                return synth("openclaw gateway run exhausted its budget during connect (no agent started)", 124, timed_out=True)
            run_id = client.run_agent(prompt, session_key=session_key, timeout=min(_remaining(), 30.0))
            result = client.wait_agent(run_id, _remaining())
        except OpenClawGatewayError as exc:
            code = (exc.code or "").upper()
            if code in {"NOT_PAIRED", "PAIRING_REQUIRED"}:
                return synth(
                    "OPENCLAW_GATEWAY_NOT_PAIRED: this device is not approved on the gateway yet. "
                    "Approve it once with `openclaw devices approve <requestId>` and set "
                    "SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH to a stable key. Detail: " + str(exc),
                    1,
                )
            if "timeout" in str(exc).lower():
                return synth(f"openclaw gateway timed out: {exc}", 124, timed_out=True)
            return synth(f"openclaw gateway error: {exc}", 1)
        except (TimeoutError, socket.timeout) as exc:
            return synth(f"openclaw gateway timed out after {limits.budget_seconds}s: {exc}", 124, timed_out=True)
        except OSError as exc:
            return synth(f"openclaw gateway connection failed: {type(exc).__name__}: {exc}", 1)
        except Exception as exc:
            return synth(f"openclaw gateway invocation failed: {type(exc).__name__}: {exc}", 1)
        finally:
            try:
                client.close()
            except Exception:
                pass

        output = result.output or result.error or f"agent finished with status {result.status}"
        exit_code = 0 if result.ok else 1
        extra = self._runtime_extra(
            executable=safe_url, provider="openclaw", api_mode="openclaw_gateway_ws",
            notes=[f"openclaw gateway agent status={result.status}"],
        )
        return self._synthetic_result(
            task=task, session=session, limits=limits, command_repr=command_repr,
            output=output, exit_code=exit_code, started_at=started_at, finished_at=time.time(),
            duration=time.monotonic() - started, transcript_extra=extra,
        )


class _NoHttpRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse HTTP redirects so a 3xx cannot bounce a SSRF-validated public URL
    into internal/private space the host check never saw."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib hook
        raise urllib.error.HTTPError(req.full_url, code, f"redirect to {newurl} refused (SSRF guard)", headers, fp)


class HttpBackend(_AgentCliBackend):
    """Generic HTTP worker backend — the lowest-friction way to bring a *bring-your-
    own* agent runtime into SuperClaw over a network boundary.

    Where the CLI backends spawn a local process, this one POSTs the rendered
    task to a user-configured endpoint and reads the work back from the JSON
    response. The endpoint owns its own model, tools, and sandbox; SuperClaw only
    frames the task, applies the governance gate, and records evidence — exactly
    the seam a third party needs to plug a custom runtime in without shipping a
    local binary.

    Request — ``POST <url>`` (method configurable), ``Content-Type: application/json``::

        {
          "prompt": "<rendered worker prompt>",
          "goal": {"id", "title", "description", "acceptance_criteria"},
          "task": {"id", "role", "title"},
          "repo_path": "<abs path>",
          "run_id", "task_id",
          "permission_mode": "ask" | "allow",
          "model": "<selected model>"   # optional; only when a per-run model or
                                        # SUPERCLAW_HTTP_MODEL is set — the
                                        # endpoint owns whether/how to honor it
        }

    Response — ``2xx`` with a JSON object::

        {"output": "<what the runtime did>",   # REQUIRED
         "exit_code": 0,                        # optional, default 0
         "usage": {...}}                        # optional, recorded as-is

    Contract failures are mapped to a failed run rather than a crash: a non-2xx
    status, a missing/blank ``output``, a non-JSON body, a connection error, or a
    timeout each produce a fail-marked synthetic result.

    Governance:
    - The endpoint is an explicit, operator-configured trust boundary
      (``SUPERCLAW_HTTP_URL``), like the ``anthropic-agent`` ``base_url`` — calling
      it is not an ad-hoc scan/probe, so it carries no human-gate of its own.
    - Plugin governance is fail-closed: the remote runtime resolves its own tools,
      so SuperClaw will not project plugin dirs / MCP configs to it; a policy that
      carries them is rejected rather than silently dropped.
    - Configured ``headers`` may carry an auth token; they are redacted from the
      transcript via the shared secret scanner and never echoed into output.

    SSRF guard: the endpoint host is resolved and blocked when it lands on
    loopback / private / link-local / reserved space (cloud metadata, internal
    services) unless ``SUPERCLAW_HTTP_ALLOW_PRIVATE=true``; redirects are refused
    so a 3xx cannot bounce a validated public URL into internal space; and the
    logged URL is stripped of userinfo/query so a credential in the URL never
    lands in command_repr / transcript.

    KNOWN LIMITATIONS (documented, not silently assumed):
    - Synchronous request/response only — no streaming, no ``202 Accepted`` +
      poll, no chunked logs. A long task can hit an intermediary (LB/proxy)
      idle-timeout; size the endpoint and ``SUPERCLAW_HTTP_TIMEOUT_SEC`` for that.
    - ``repo_path`` is sent as an absolute local path. A remote runtime only sees
      the same files under a shared-disk mount (Docker volume / NFS); otherwise it
      must manage its own workspace and ignore the path.

    Config (env, never hard-coded): ``SUPERCLAW_HTTP_URL`` (required),
    ``SUPERCLAW_HTTP_METHOD`` (default ``POST``), ``SUPERCLAW_HTTP_HEADERS`` (JSON
    object; a malformed value fails the run rather than silently dropping auth),
    ``SUPERCLAW_HTTP_TIMEOUT_SEC`` (default = run budget),
    ``SUPERCLAW_HTTP_ALLOW_PRIVATE`` (default false). A ``transport`` callable
    ``(url, method, headers, body, timeout) -> (status, dict)`` may be injected for
    tests so no real network is required.
    """

    name = "http"
    failure_markers = ()

    # Cap the response body we will buffer, so a hostile/buggy endpoint cannot OOM
    # the host with an unbounded stream.
    MAX_RESPONSE_BYTES = 8 * 1024 * 1024

    def __init__(
        self,
        *,
        url: str | None = None,
        method: str | None = None,
        headers: dict[str, str] | None = None,
        timeout_sec: float | None = None,
        allow_private: bool | None = None,
        transport=None,
    ) -> None:
        super().__init__()
        self._url = url
        self._method = method
        self._headers = headers
        self._timeout_sec = timeout_sec
        self._allow_private = allow_private
        self._transport = transport

    def permission_presets(self) -> PresetMap:
        # The remote runtime resolves its own permissions; SuperClaw does not
        # CLI-enforce a gate over the wire, so neither preset is preset-driven.
        # The mode is still forwarded in the request body for the endpoint to honor.
        # Doctrine: both presets project onto bypassPermissions (max). The wire
        # body uses the {"ask","allow"} vocabulary; bypassPermissions/dontAsk map
        # to "allow", so BOTH presets POST permission_mode="allow" (see run()).
        # The remote runtime resolves its own permissions, so neither preset is
        # preset-driven here.
        return make_presets(
            ask=PresetRealization(
                "POST permission_mode=allow (max; both presets; remote runtime resolves its own permissions)",
                False,
                "perm.note.http.ask",
                preset_driven=False,
            ),
            allow=PresetRealization(
                "POST permission_mode=allow (max; both presets; remote runtime resolves its own permissions)",
                False,
                "perm.note.http.allow",
                preset_driven=False,
            ),
        )

    def _resolve_url(self) -> str:
        return (self._url or os.environ.get("SUPERCLAW_HTTP_URL") or "").strip()

    def _resolve_method(self) -> str:
        return (self._method or os.environ.get("SUPERCLAW_HTTP_METHOD") or "POST").strip().upper()

    def _resolve_headers(self) -> dict[str, str]:
        """Resolve request headers, failing loud on a malformed override.

        A typo in ``SUPERCLAW_HTTP_HEADERS`` (e.g. a stray comma) must not silently
        drop the operator's auth token and send an unauthenticated request — that
        turns a config mistake into a quiet security downgrade. Raise instead, so
        ``available()``/``run()`` surface it as a configuration error.
        """
        if self._headers is not None:
            return dict(self._headers)
        raw = os.environ.get("SUPERCLAW_HTTP_HEADERS", "").strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"SUPERCLAW_HTTP_HEADERS is not valid JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ValueError("SUPERCLAW_HTTP_HEADERS must be a JSON object of header name/value pairs")
        return {str(k): str(v) for k, v in parsed.items()}

    def available(self) -> BackendAvailability:
        url = self._resolve_url()
        if not url:
            return BackendAvailability(name=self.name, available=False, reason="SUPERCLAW_HTTP_URL not configured")
        # Never surface the raw URL (it may carry a userinfo/query token) into the
        # availability/status/UI/debug surface — always report the credential-free form.
        safe = self._safe_url(url)
        try:
            parsed = urllib.parse.urlparse(url)
        except Exception:
            return BackendAvailability(name=self.name, available=False, reason=f"invalid SUPERCLAW_HTTP_URL: {safe}")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return BackendAvailability(name=self.name, available=False, reason=f"SUPERCLAW_HTTP_URL must be an absolute http(s) URL: {safe}")
        try:
            self._resolve_headers()
        except ValueError as exc:
            return BackendAvailability(name=self.name, available=False, reason=str(exc))
        return BackendAvailability(name=self.name, available=True, executable=safe, version=f"{self._resolve_method()} {safe}")

    def _resolve_allow_private(self) -> bool:
        if self._allow_private is not None:
            return self._allow_private
        return os.environ.get("SUPERCLAW_HTTP_ALLOW_PRIVATE", "").strip().lower() in {"1", "true", "yes"}

    @staticmethod
    def _safe_url(url: str) -> str:
        """URL with userinfo + query + fragment stripped, safe to log / persist.

        A configured endpoint can legitimately carry a token in userinfo
        (``https://user:token@host``) or a ``?key=`` query param; neither belongs
        in command_repr / transcript / evidence, so drop them before the URL is
        ever recorded.
        """
        try:
            p = urllib.parse.urlparse(url)
        except Exception:
            return "(unparseable url)"
        netloc = p.hostname or ""
        if p.port:
            netloc = f"{netloc}:{p.port}"
        return urllib.parse.urlunparse((p.scheme, netloc, p.path, "", "", ""))

    def _private_host_block_reason(self, url: str) -> str | None:
        """Return a reason if the URL host resolves to a non-public address.

        SSRF guard: an endpoint pointing at loopback / private / link-local /
        reserved space (e.g. cloud metadata ``169.254.169.254`` or an internal
        ``localhost:6379``) is blocked by default — opt in with
        ``SUPERCLAW_HTTP_ALLOW_PRIVATE=true`` for local/dev runtimes. Resolution
        failure is *not* treated as private (we cannot prove it; the request will
        fail naturally), so a fake test host stays a connection error, not a
        spurious SSRF block.
        """
        host = urllib.parse.urlparse(url).hostname
        if not host:
            return None
        try:
            infos = socket.getaddrinfo(host, None)
        except Exception:
            return None
        for info in infos:
            ip = info[4][0]
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            # `not is_global` is the broad net — it covers private, loopback,
            # link-local, reserved, AND ranges an explicit enum misses such as
            # CGNAT 100.64.0.0/10. Keep multicast/unspecified explicit for clarity.
            if not addr.is_global or addr.is_multicast or addr.is_unspecified:
                return f"{host} resolves to non-public address {ip}"
        return None

    @staticmethod
    def _redact_header_values(text: str, headers: dict[str, str]) -> str:
        """Exact-redact configured header values from endpoint-reflected text.

        Pattern-based secret scanning (applied separately) catches `cph_`/`Bearer`
        shapes, but an opaque/Basic/custom token reflected back in the endpoint's
        output would otherwise slip through. Exact-replace each configured header
        value (and any bearer/basic credential inside it) so a hostile endpoint
        cannot echo the operator's token back into evidence.
        """
        if not text:
            return text
        seen: set[str] = set()
        for value in headers.values():
            for candidate in (value, *value.split()):
                candidate = candidate.strip()
                if len(candidate) >= 8 and candidate not in seen:
                    seen.add(candidate)
        for candidate in sorted(seen, key=len, reverse=True):
            text = text.replace(candidate, "[redacted-header]")
        return text

    def _do_request(self, url: str, method: str, headers: dict[str, str], body: dict, timeout: float) -> tuple[int, dict]:
        if self._transport is not None:
            return self._transport(url, method, headers, body, timeout)
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", **headers},
            method=method,
        )
        # Refuse redirects: a 3xx to an internal address would otherwise bypass the
        # SSRF host check, which only validated the original URL.
        opener = urllib.request.build_opener(_NoHttpRedirect)
        # Bound the read so a misbehaving or hostile endpoint cannot OOM the host
        # by streaming an unbounded body. Read one byte past the cap to detect
        # overflow, then fail closed rather than parsing a truncated/huge payload.
        try:
            with opener.open(request, timeout=timeout) as response:
                status = int(getattr(response, "status", 200) or 200)
                data = response.read(self.MAX_RESPONSE_BYTES + 1)
            if len(data) > self.MAX_RESPONSE_BYTES:
                raise RuntimeError(
                    f"HTTP runtime response exceeded {self.MAX_RESPONSE_BYTES} bytes; refusing to buffer it"
                )
            raw = data.decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read(self.MAX_RESPONSE_BYTES).decode("utf-8", "replace") if hasattr(exc, "read") else ""
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"output": raw[:2000]}
            return int(exc.code), parsed if isinstance(parsed, dict) else {"output": raw[:2000]}
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"HTTP runtime returned non-JSON body: {exc}") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("HTTP runtime response must be a JSON object")
        return status, parsed

    def run(self, task: TaskNode, goal: GoalSpec, session: RunSession, limits: WorkerLimits) -> WorkerResult:
        if (effort_guard := self._effort_unsupported_guard(task=task, session=session, limits=limits)) is not None:
            return effort_guard
        started_at = time.time()
        started = time.monotonic()
        url = self._resolve_url()
        method = self._resolve_method()
        safe_url = self._safe_url(url) if url else "(unconfigured)"
        command_repr = f"http {method} {safe_url}"

        def synth(output: str, exit_code: int, *, timed_out: bool = False) -> WorkerResult:
            return self._synthetic_result(
                task=task, session=session, limits=limits, command_repr=command_repr,
                output=output, exit_code=exit_code, started_at=started_at, finished_at=time.time(),
                duration=time.monotonic() - started, timed_out=timed_out,
                transcript_extra=self._runtime_extra(
                    executable=safe_url, provider="http", api_mode="http_post",
                    notes=["generic HTTP runtime endpoint"],
                ),
            )

        # Entry-time fail-closed validation — security/config checks must hold at
        # run() time, not only in availability display.
        availability = self.available()
        if not availability.available:
            return synth(availability.reason or "HTTP backend not configured", 127)

        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            return synth(
                "PLUGIN_RUNTIME_CONFIG_INVALID: HTTP backend does not project SuperClaw plugin "
                "runtime policy to a remote endpoint (the remote runtime resolves its own tools). "
                "Run without plugin directories / MCP configs.",
                1,
            )

        try:
            headers = self._resolve_headers()
        except ValueError as exc:
            return synth(str(exc), 127)

        try:
            timeout = float(self._timeout_sec) if self._timeout_sec else float(
                os.environ.get("SUPERCLAW_HTTP_TIMEOUT_SEC", "").strip() or limits.budget_seconds
            )
        except (TypeError, ValueError):
            return synth("SUPERCLAW_HTTP_TIMEOUT_SEC must be a number", 127)
        if timeout <= 0:
            timeout = float(limits.budget_seconds)

        # SSRF guard runs against the real-network path only (an injected transport
        # is a trusted test seam, not an outbound socket).
        if self._transport is None and not self._resolve_allow_private():
            block = self._private_host_block_reason(url)
            if block:
                return synth(
                    f"HTTP {method} {safe_url} blocked: {block} "
                    "(set SUPERCLAW_HTTP_ALLOW_PRIVATE=true to allow private/loopback endpoints)",
                    1,
                )

        permission_mode = "allow" if (policy and policy.mode in {"bypassPermissions", "dontAsk"}) else "ask"
        criteria = list(getattr(goal, "acceptance_criteria", None) or [])
        body = {
            "prompt": self._prompt(task, goal, repo_path=limits.repo_path, capabilities_note=limits.plugin_capabilities_note),
            "goal": {"id": goal.goal_id, "title": goal.title, "description": goal.description, "acceptance_criteria": criteria},
            "task": {"id": task.task_id, "role": task.role.value, "title": task.title},
            "repo_path": str(limits.repo_path),
            "run_id": session.run_id,
            "task_id": task.task_id,
            "permission_mode": permission_mode,
        }
        # Forward an explicit model selection for the endpoint to honor — the
        # remote runtime owns the final model choice (same trust boundary as
        # permission_mode above); the field is omitted when nothing is selected.
        http_model = _resolve_model(limits, "SUPERCLAW_HTTP_MODEL")
        if http_model:
            body["model"] = http_model

        try:
            status, payload = self._do_request(url, method, headers, body, timeout)
        except (TimeoutError, socket.timeout):
            return synth(f"HTTP {method} {safe_url} timed out after {timeout:.0f}s", 124, timed_out=True)
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, (TimeoutError, socket.timeout)):
                return synth(f"HTTP {method} {safe_url} timed out after {timeout:.0f}s", 124, timed_out=True)
            return synth(f"HTTP {method} {safe_url} connection failed: {reason}", 1)
        except Exception as exc:  # non-JSON body, redirect refusal, transport error, etc.
            return synth(f"HTTP {method} {safe_url} invocation failed: {type(exc).__name__}: {exc}", 1)

        def _as_text(value: object) -> str:
            return value if isinstance(value, str) else ""

        # Belt-and-suspenders against a hostile endpoint reflecting the auth token.
        def _clean(value: str) -> str:
            return self._redact_header_values(value, headers)

        if not (200 <= status < 300):
            detail = _as_text(payload.get("output")) or _as_text(payload.get("error")) or json.dumps(payload)[:500]
            return synth(f"HTTP runtime returned status {status}: {_clean(detail)}", 1)

        output = _as_text(payload.get("output"))
        if not output.strip():
            return synth(f"HTTP runtime response missing required 'output' field (status {status})", 1)
        output = _clean(output)

        # exit_code: absent -> success(0); present but unparseable -> failure(1),
        # never a silent success. Clamp to a sane byte range.
        if "exit_code" in payload:
            try:
                exit_code = int(payload["exit_code"])
            except (TypeError, ValueError):
                exit_code = 1
        else:
            exit_code = 0
        exit_code = max(0, min(255, exit_code))

        usage = payload.get("usage")
        extra = self._runtime_extra(
            executable=safe_url, provider="http", api_mode="http_post", notes=["generic HTTP runtime endpoint"],
        )
        if isinstance(usage, dict):
            # usage is endpoint-controlled too — exact-redact any reflected header
            # value before it lands in the transcript (pattern redaction alone
            # would miss an opaque/Basic token echoed into a usage field).
            try:
                extra["http_usage"] = json.loads(self._redact_header_values(json.dumps(usage), headers))
            except (TypeError, ValueError):
                extra["http_usage"] = {}
        return self._synthetic_result(
            task=task, session=session, limits=limits, command_repr=command_repr,
            output=output, exit_code=exit_code, started_at=started_at, finished_at=time.time(),
            duration=time.monotonic() - started, transcript_extra=extra,
        )


def default_backends() -> dict[str, WorkerBackend]:
    return {
        "local": LocalShellBackend(),
        "codex": CodexCliBackend(),
        "codex-app-server": CodexAppServerBackend(),
        "claude": ClaudeCliBackend(),
        "opencode": OpenCodeCliBackend(),
        "grok": GrokCliBackend(),
        "cursor": CursorCliBackend(),
        "hermes": HermesCliBackend(),
        "bobo": BoboCliBackend(),
        "gemini": GeminiAgentBackend(),
        "openclaw": OpenClawCliBackend(),
        "openclaw-gateway": OpenClawGatewayBackend(),
        "http": HttpBackend(),
        "clawwork": ClawWorkBackend(),
        "anthropic": AnthropicApiBackend(),
        "anthropic-agent": AnthropicAgentBackend(),
    }


def select_backends(policy: str, registry: dict[str, WorkerBackend] | None = None) -> list[WorkerBackend]:
    registry = registry or default_backends()
    if policy == "all":
        return [backend for backend in registry.values() if backend.available().available]
    if policy not in registry:
        raise ValueError(f"unknown backend policy: {policy}")
    backend = registry[policy]
    return [backend] if backend.available().available else []
