from __future__ import annotations

import json
import os
import shutil
import subprocess
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from superclaw.environment import default_state_path

# Re-exported for backward compatibility; canonical definition lives in secrets_scan.
from superclaw.secrets_scan import redact_secrets

PermissionMode = Literal["default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"]


_CLI_FAILURE_MARKERS = (
    "sign in with chatgpt",
    "paste an api key",
    "raw mode is not supported",
    "not authenticated",
    "login required",
    "api key required",
    "invalid api key",
)


def desktop_toolchain_path(base_path: str | None = None) -> str:
    """Return a PATH that works for macOS GUI-launched desktop subprocesses."""
    existing_entries = [entry for entry in (base_path or os.environ.get("PATH", "")).split(os.pathsep) if entry]
    candidates: list[Path] = []
    if os.name != "nt":
        candidates.extend(
            [
                Path.home() / ".local" / "bin",
                Path("/opt/homebrew/opt/node/bin"),
                Path("/opt/homebrew/bin"),
                Path("/usr/local/bin"),
                Path("/usr/bin"),
                Path("/bin"),
                Path("/usr/sbin"),
                Path("/sbin"),
            ]
        )
    else:
        candidates.extend(Path(entry) for entry in existing_entries)

    preferred_entries = [str(candidate) for candidate in candidates if candidate.exists()]
    merged: list[str] = []
    for entry in [*preferred_entries, *existing_entries]:
        if entry not in merged:
            merged.append(entry)
    return os.pathsep.join(merged)


def desktop_toolchain_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base_env or os.environ)
    env["PATH"] = desktop_toolchain_path(env.get("PATH"))
    return env


def codex_desktop_executable() -> Path | None:
    """Return the bundled Codex Desktop CLI when it is installed locally."""
    candidates: list[Path] = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(Path(local_appdata) / "OpenAI" / "Codex" / "bin" / "codex.exe")
    if os.name == "nt":
        candidates.append(Path.home() / "AppData" / "Local" / "OpenAI" / "Codex" / "bin" / "codex.exe")
    else:
        candidates.append(Path.home() / ".local" / "share" / "OpenAI" / "Codex" / "bin" / "codex")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def find_codex_executable(env_override: str | None = None) -> tuple[str | None, str | None]:
    if env_override:
        return env_override, "env_override"
    desktop = codex_desktop_executable()
    if desktop:
        return str(desktop), "desktop_exec"
    path = shutil.which("codex", path=desktop_toolchain_path())
    if path:
        return path, "path"
    return None, None


def codex_cli_mode(executable: str | Path | None) -> str:
    override = os.environ.get("SUPERCLAW_EVAL_CODEX_MODE") or os.environ.get("SUPERCLAW_CODEX_MODE")
    if override in {"exec", "legacy"}:
        return override
    if not executable:
        return "missing"
    try:
        completed = subprocess.run(
            [str(executable), "exec", "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=desktop_toolchain_env(),
            timeout=5,
            check=False,
        )
    except Exception:
        return "legacy"
    output = ((completed.stdout or "") + (completed.stderr or "")).lower()
    if completed.returncode == 0 and "run codex non-interactively" in output:
        return "exec"
    return "legacy"


CLAUDE_SOURCEMAP_ALIGNMENT = {
    "source": "Arxchibobo/claude-code-sourcemap",
    "version_observed": "2.1.88",
    "usage_boundary": "architecture signals only; no restored source is vendored",
    "hook_contract": {
        "base_fields": ["session_id", "transcript_path", "cwd", "permission_mode", "agent_id", "agent_type"],
        "events": [
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "PermissionDenied",
            "SessionStart",
            "SessionEnd",
            "SubagentStart",
            "SubagentStop",
            "TaskCreated",
            "TaskCompleted",
            "WorktreeCreate",
            "WorktreeRemove",
        ],
    },
    "control_contract": [
        "set_permission_mode",
        "set_model",
        "mcp_status",
        "get_context_usage",
        "permission_request",
    ],
    "agent_tool_topology": {
        "async_agent_allowed": [
            "Read",
            "Grep",
            "Glob",
            "WebFetch",
            "WebSearch",
            "Bash",
            "Edit",
            "Write",
            "Skill",
            "TodoWrite",
            "tool_search",
        ],
        "async_agent_blocked": [
            "Agent",
            "TaskStop",
            "ExitPlanMode",
            "AskUserQuestion",
            "Workflow",
        ],
        "reason": "avoid recursive delegation and keep main-thread-only controls outside worker sandboxes",
    },
    "operational_patterns_to_copy": [
        "permission decisions are explicit events, not implicit command failures",
        "worker transcripts carry session, cwd, permission mode, and agent identity",
        "cancel current turn and kill all background workers are separate user actions",
        "MCP/tool outputs need independent size limits before entering model context",
        "resuming a session must preserve coordinator/normal mode and worktree boundary",
    ],
}


@dataclass(frozen=True)
class PermissionPolicy:
    mode: PermissionMode = "default"
    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)
    mcp_configs: list[str] = field(default_factory=list)
    plugin_dirs: list[str] = field(default_factory=list)
    session_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_values(
        cls,
        *,
        mode: str = "default",
        allowed_tools: list[str] | None = None,
        disallowed_tools: list[str] | None = None,
        mcp_configs: list[str] | None = None,
        plugin_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> "PermissionPolicy":
        normalized = mode if mode in {"default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"} else "default"
        return cls(
            mode=normalized,  # type: ignore[arg-type]
            allowed_tools=[item for item in allowed_tools or [] if item],
            disallowed_tools=[item for item in disallowed_tools or [] if item],
            mcp_configs=[str(Path(item)) for item in mcp_configs or [] if item],
            plugin_dirs=[str(Path(item)) for item in plugin_dirs or [] if item],
            session_id=session_id,
        )


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
    return redact_secrets((completed.stdout or completed.stderr or "").strip()[:200]) or None


def _help_markers(executable: str, markers: list[str]) -> dict[str, bool]:
    try:
        completed = subprocess.run(
            [executable, "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=desktop_toolchain_env(),
            timeout=10,
            check=False,
        )
    except Exception:
        return {marker: False for marker in markers}
    text = (completed.stdout or "") + (completed.stderr or "")
    return {marker: marker in text for marker in markers}


def _cli_probe(name: str, markers: list[str], *, probe_help: bool = True) -> dict[str, Any]:
    executable = shutil.which(name, path=desktop_toolchain_path())
    features = {marker: False for marker in markers}
    if executable and probe_help:
        features = _help_markers(executable, markers)
    return {
        "name": name,
        "available": bool(executable),
        "executable": executable,
        "version": _version(executable) if executable else None,
        "features": features,
        "help_probed": bool(executable and probe_help),
    }


def _redact_url(value: str) -> str:
    redacted = redact_secrets(value)
    try:
        parts = urlsplit(redacted)
    except ValueError:
        return redacted
    netloc = parts.hostname or ""
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def _mcp_config_paths(config_paths: list[str] | None = None) -> list[Path]:
    candidates: list[Path] = []
    for item in config_paths or []:
        if item:
            candidates.append(Path(item).expanduser())
    env_paths = os.environ.get("SUPERCLAW_MCP_CONFIG_PATHS") or os.environ.get("SUPERCLAW_MCP_CONFIG")
    if env_paths:
        candidates.extend(Path(item).expanduser() for item in env_paths.split(os.pathsep) if item)
    if not candidates:
        candidates.append(Path.home() / ".codex" / "config.toml")
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            deduped.append(path)
            seen.add(key)
    return deduped


def _load_mcp_config(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        if path.suffix.lower() == ".json":
            return json.loads(path.read_text(encoding="utf-8")), None
        with path.open("rb") as handle:
            return tomllib.load(handle), None
    except Exception as exc:
        return {}, f"{type(exc).__name__}: {str(exc)[:200]}"


def _extract_mcp_servers(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_servers = payload.get("mcp_servers") or payload.get("mcpServers") or payload.get("servers") or {}
    return {
        str(name): dict(config)
        for name, config in raw_servers.items()
        if isinstance(config, dict)
    } if isinstance(raw_servers, dict) else {}


def _command_available(command: str | None) -> bool | None:
    if not command:
        return None
    expanded = Path(command).expanduser()
    return expanded.exists() or shutil.which(command, path=desktop_toolchain_path()) is not None


def _server_status(name: str, config: dict[str, Any], source: Path) -> dict[str, Any]:
    command = config.get("command")
    url = config.get("url") or config.get("endpoint")
    args = config.get("args") if isinstance(config.get("args"), list) else []
    env_config = config.get("env") if isinstance(config.get("env"), dict) else {}
    token_env_var = (
        config.get("bearer_token_env_var")
        or config.get("bearerTokenEnvVar")
        or config.get("token_env_var")
        or config.get("tokenEnvVar")
    )
    transport = "http" if url else "stdio" if command else str(config.get("transport") or config.get("type") or "unknown")
    command_ok = _command_available(str(command)) if command else None
    env_status = {str(key): "set" if os.environ.get(str(key)) else "unset" for key in env_config}
    token_env_status = "set" if token_env_var and os.environ.get(str(token_env_var)) else "unset" if token_env_var else "not_configured"
    issues: list[str] = []
    if transport == "stdio" and command_ok is False:
        issues.append("command_not_found")
    if transport == "http" and not url:
        issues.append("missing_url")
    if token_env_var and token_env_status != "set":
        issues.append("token_env_unset")
    ready = not issues and transport in {"stdio", "http", "sse", "streamable_http"}
    return {
        "name": name,
        "source": str(source),
        "transport": transport,
        "ready": ready,
        "issues": issues,
        "command": redact_secrets(str(command)) if command else None,
        "command_available": command_ok,
        "args_count": len(args),
        "url": _redact_url(str(url)) if url else None,
        "token_env_var": str(token_env_var) if token_env_var else None,
        "token_env_status": token_env_status,
        "env": env_status,
    }


def _codex_mcp_list_probe() -> dict[str, Any]:
    executable = shutil.which("codex", path=desktop_toolchain_path())
    if not executable:
        return {"available": False, "ok": False, "reason": "codex not found on PATH"}
    try:
        completed = subprocess.run(
            [executable, "mcp", "list"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=desktop_toolchain_env(),
            timeout=10,
            check=False,
        )
    except Exception as exc:
        return {
            "available": True,
            "ok": False,
            "executable": executable,
            "error": f"{type(exc).__name__}: {str(exc)[:300]}",
        }
    output = redact_secrets(((completed.stdout or "") + (completed.stderr or "")).strip())
    failure_marker = next((marker for marker in _CLI_FAILURE_MARKERS if marker in output.lower()), None)
    return {
        "available": True,
        "ok": completed.returncode == 0 and failure_marker is None,
        "executable": executable,
        "exit_code": int(completed.returncode),
        "failure_marker": failure_marker,
        "output_tail": output[-4000:],
    }


def runtime_mcp_status(
    config_paths: list[str] | None = None,
    *,
    run_cli_probe: bool = True,
) -> dict[str, Any]:
    """Inspect MCP configuration and local CLI status without printing secret values."""
    files: list[dict[str, Any]] = []
    servers: list[dict[str, Any]] = []
    for path in _mcp_config_paths(config_paths):
        exists = path.exists()
        item: dict[str, Any] = {"path": str(path), "exists": exists}
        if exists:
            payload, error = _load_mcp_config(path)
            if error:
                item["error"] = error
            discovered = _extract_mcp_servers(payload)
            item["server_count"] = len(discovered)
            servers.extend(_server_status(name, config, path) for name, config in discovered.items())
        files.append(item)
    issue_count = sum(len(server["issues"]) for server in servers)
    status = {
        "summary": {
            "config_files_found": len([item for item in files if item["exists"]]),
            "server_count": len(servers),
            "ready_count": len([server for server in servers if server["ready"]]),
            "issue_count": issue_count,
            "cli_probe_ran": run_cli_probe,
        },
        "config_files": files,
        "servers": servers,
        "codex_mcp_list": _codex_mcp_list_probe() if run_cli_probe else {"skipped": True},
    }
    status["summary"]["cli_probe_ok"] = bool(status["codex_mcp_list"].get("ok"))
    return status


CLI_MARKERS: dict[str, list[str]] = {
    "superclaw": ["chat", "watch", "runtime", "harness", "clawhunt", "validate"],
    "codex": ["--approval-mode", "--history", "--project-doc", "--full-context", "--quiet"],
    "claude": ["--permission-mode", "--mcp-config", "--plugin-dir", "--resume", "--output-format", "agents"],
    "gemini": ["--approval-mode", "--resume", "--output-format", "mcp", "extensions", "skills", "hooks"],
    "opencode": ["agent", "permission", "mcp"],
    "cursor": [],
}


def runtime_cli_comparison() -> dict[str, Any]:
    clis = {
        name: _cli_probe(name, markers, probe_help=name != "cursor")
        for name, markers in CLI_MARKERS.items()
    }
    return {
        "observed_clis": clis,
        "capabilities": {
            "delivery_evidence_ledger": {"superclaw": True, "codex": False, "claude": False, "gemini": False},
            "backend_success_matrix": {"superclaw": True, "codex": False, "claude": False, "gemini": False},
            "process_level_cancel": {
                "superclaw": "state-backed cancel_check terminates worker subprocesses and records worker.cancelled evidence",
                "codex": "native session control",
                "claude": "native current-turn cancel plus worker kill controls",
                "gemini": "native session control where supported",
            },
            "stale_run_reconciliation": {
                "superclaw": "state-backed reconcile and resume for queued/running/verifying records",
                "codex": "external orchestration required",
                "claude": "external orchestration required",
                "gemini": "external orchestration required",
            },
            "interactive_session": {"superclaw": "chat-turn", "codex": True, "claude": True, "gemini": True},
            "resume_session": {
                "superclaw": "session_id/continue_last",
                "codex": bool(clis["codex"]["features"].get("--history")),
                "claude": bool(clis["claude"]["features"].get("--resume")),
                "gemini": bool(clis["gemini"]["features"].get("--resume")),
            },
            "permission_policy": {
                "superclaw": "normalized policy plus backend mapping",
                "codex": bool(clis["codex"]["features"].get("--approval-mode")),
                "claude": bool(clis["claude"]["features"].get("--permission-mode")),
                "gemini": bool(clis["gemini"]["features"].get("--approval-mode")),
            },
            "mcp_runtime": {
                "superclaw": "runtime mcp-status config/readiness probe plus optional codex mcp list",
                "codex": "external config",
                "claude": bool(clis["claude"]["features"].get("--mcp-config")),
                "gemini": bool(clis["gemini"]["features"].get("mcp")),
            },
            "plugin_or_extension_runtime": {
                "superclaw": "harness emit/validate, no live marketplace install",
                "claude": bool(clis["claude"]["features"].get("--plugin-dir")),
                "gemini": bool(clis["gemini"]["features"].get("extensions")),
                "cursor": clis["cursor"]["available"],
            },
            "stream_json": {
                "superclaw": "run events plus persisted API-agent transcript stream_events; no live model passthrough yet",
                "claude": bool(clis["claude"]["features"].get("--output-format")),
                "gemini": bool(clis["gemini"]["features"].get("--output-format")),
            },
        },
        "superclaw_gaps": [
            {
                "id": "live_model_stream_passthrough",
                "priority": "medium",
                "detail": "SuperClaw captures structured API-agent stream_events in transcripts, but does not yet live-forward raw backend model stream-json events",
            },
            {
                "id": "plugin_runtime_install",
                "priority": "medium",
                "detail": "harness artifacts can be emitted/validated, but runtime install/link flows are not first-class",
            },
            {
                "id": "true_subagent_spawn",
                "priority": "medium",
                "detail": "worker roles are scheduled by SuperClaw; backend-native subagent spawning is not yet orchestrated",
            },
        ],
        "next_iteration": [
            "add live backend stream-json forwarding for Claude/Gemini where available",
            "add plugin/extension link/install dry-run helpers for Codex/Gemini/Claude",
        ],
    }


def runtime_manifest() -> dict[str, Any]:
    # Local-CLI discovery here feeds the desktop UI's availability contract, so it
    # must use the GUI-subprocess toolchain PATH: a Finder-launched .app has a
    # stripped PATH, and a bare shutil.which would falsely report installed tools as
    # missing — breaking the BYO experience even when the CLIs are present.
    toolchain_path = desktop_toolchain_path()
    codex, codex_source = find_codex_executable()
    claude = shutil.which("claude", path=toolchain_path)
    codex_markers = [
        "exec",
        "--cd",
        "--skip-git-repo-check",
        "--approval-mode",
        "--writable-root",
        "--project-doc",
        "--history",
        "--full-context",
    ]
    claude_markers = [
        "--permission-mode",
        "--allowedTools",
        "--mcp-config",
        "--plugin-dir",
        "--resume",
        "--output-format",
        "--worktree",
        "agents",
        "plugin",
    ]
    return {
        "superclaw": {
            "session_model": "chat_sessions + run_sessions + evidence bundles",
            "event_stream": "sqlite events exposed as CLI watch and API SSE",
            "secret_policy": "environment-only credentials; output is redacted before transcript storage",
            "sourcemap_alignment": CLAUDE_SOURCEMAP_ALIGNMENT,
            "mcp_status": runtime_mcp_status(run_cli_probe=False)["summary"],
        },
        "codex": {
            "available": bool(codex),
            "executable": codex,
            "executable_source": codex_source,
            "cli_mode": codex_cli_mode(codex),
            "version": _version(codex) if codex else None,
            "features": _help_markers(codex, codex_markers) if codex else {marker: False for marker in codex_markers},
            "policy_mapping": {
                "exec": "codex exec --cd <workspace> --sandbox workspace-write",
                "legacy": "codex -q --approval-mode <mode>",
                "plan/default": "workspace-write sandbox for exec mode; approval-mode suggest for legacy mode",
                "acceptEdits/auto": "workspace-write sandbox for exec mode; approval-mode auto-edit for legacy mode",
                "bypassPermissions/dontAsk": "dangerous bypass only in disposable eval workspaces; full-auto for legacy mode",
                "mcp_configs": "recorded in SuperClaw policy; configure Codex MCP through Codex config",
            },
        },
        "claude": {
            "available": bool(claude),
            "executable": claude,
            "version": _version(claude) if claude else None,
            "features": _help_markers(claude, claude_markers) if claude else {marker: False for marker in claude_markers},
            "policy_mapping": {
                "mode": "--permission-mode",
                "allowed_tools": "--allowedTools",
                "disallowed_tools": "--disallowedTools",
                "mcp_configs": "--mcp-config",
                "plugin_dirs": "--plugin-dir",
            },
        },
        "environment": {
            "CLAWHUNT_AGENT_API_KEY": "set" if os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset",
            "SUPERCLAW_CONTROL_TOKEN": "set" if os.environ.get("SUPERCLAW_CONTROL_TOKEN") else "unset",
            "SUPERCLAW_STATE_PATH": str(default_state_path()),
        },
        "available_clis": {
            name: {"available": bool(exe), "executable": exe}
            for name in CLI_MARKERS
            for exe in (shutil.which(name, path=toolchain_path),)
        },
    }
