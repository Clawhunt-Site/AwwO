from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

from superclaw.backends import default_backends
from superclaw.models import ChatSession, EvidenceBundle, GoalSpec, RunSession, TaskTopology
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.plugin_config import delete_plugin_secret, plugin_configuration_status, set_plugin_secret, set_plugin_setting
from superclaw.plugin_cloud import DEFAULT_CLOUD_ROOT
from superclaw.plugin_evidence import default_plugin_evidence_dir
from superclaw.plugin_versions import PluginVersionRangeError, version_satisfies_range
from superclaw.plugins import MANIFEST_NAME, plugin_cache_root
from superclaw.protocol_adapter import DELIVERY_PROTOCOL_ADAPTER_NAME, build_clawhunt_delivery_protocol_payload, default_solution_text
from superclaw.runtime_config import runtime_config_payload, set_runtime_config, shell_config_path
from superclaw.liveness import ACTIVE_RUN_STATUSES as _ACTIVE_RUN_STATUSES
from superclaw.state import StateStore
from superclaw.ui_contracts import (
    build_agent_inventory,
    build_plugin_diagnostics_payload,
    build_plugin_status_payload,
    build_runtime_status_payload,
)

_TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled"}


class TuiBootstrapError(RuntimeError):
    """Raised when the Textual runtime cannot be bootstrapped."""


@dataclass(frozen=True)
class TuiQuickAction:
    action_id: str
    label: str
    description: str
    argv: tuple[str, ...]
    parameters: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "label": self.label,
            "description": self.description,
            "argv": list(self.argv),
            "parameters": self.parameters,
        }


@dataclass(frozen=True)
class TuiComposerCommand:
    action_id: str
    prompt: str | None = None
    backend_override: str | None = None
    config_name: str | None = None
    config_value: str | None = None
    plugin_config_name: str | None = None
    plugin_config_value: str | None = None


@dataclass(frozen=True)
class TuiCommandPaletteEntry:
    command: str
    label: str
    description: str
    category: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "label": self.label,
            "description": self.description,
            "category": self.category,
        }


@dataclass
class TuiAsyncActionHandle:
    action_id: str
    submitted_value: str
    started_at: float = field(default_factory=time.time)
    result: dict[str, Any] | None = None
    thread: Thread | None = None
    _done: Event = field(default_factory=Event, repr=False)
    _lock: Lock = field(default_factory=Lock, repr=False)


def _superclaw_version() -> str:
    try:
        return version("superclaw")
    except PackageNotFoundError:
        return "0.1.0"


def build_tui_quick_actions(
    *,
    backend: str,
    repo: Path,
    artifact_dir: Path,
    selected_run_id: str | None = None,
) -> list[TuiQuickAction]:
    actions = [
        TuiQuickAction(
            action_id="chat.direct",
            label="Chat turn",
            description="Start a chat turn against the selected backend.",
            argv=("tui", "--dispatch-action", "chat.direct", "--backend", backend, "--repo", str(repo)),
            parameters={"dry_run": True},
        ),
        TuiQuickAction(
            action_id="delivery.start",
            label="Delivery dry-run",
            description="Run a delivery dry-run with the selected backend.",
            argv=(
                "tui",
                "--dispatch-action",
                "delivery.start",
                "--backend",
                backend,
                "--repo",
                str(repo),
                "--artifact-dir",
                str(artifact_dir),
            ),
            parameters={"dry_run": True},
        ),
        TuiQuickAction(
            action_id="delivery.start.local",
            label="Local backend run",
            description="Run a dry-run using the built-in local backend.",
            argv=(
                "tui",
                "--dispatch-action",
                "delivery.start.local",
                "--backend",
                backend,
                "--repo",
                str(repo),
                "--artifact-dir",
                str(artifact_dir),
            ),
            parameters={"backend_override": "local", "dry_run": True},
        ),
        TuiQuickAction(
            action_id="ui.refresh",
            label="Refresh",
            description="Refresh runtime status and run panels.",
            argv=("tui", "--dispatch-action", "ui.refresh", "--backend", backend, "--repo", str(repo)),
        ),
        TuiQuickAction(
            action_id="ui.snapshot.export",
            label="Snapshot evidence",
            description="Write the current cockpit snapshot to the local artifact tree.",
            argv=(
                "tui",
                "--dispatch-action",
                "ui.snapshot.export",
                "--backend",
                backend,
                "--repo",
                str(repo),
                "--artifact-dir",
                str(artifact_dir),
            ),
        ),
    ]
    if selected_run_id:
        actions.extend(
            [
                TuiQuickAction(
                    action_id="run.evidence.open",
                    label="Evidence summary",
                    description="Open the selected run evidence summary.",
                    argv=("tui", "--dispatch-action", "run.evidence.open", "--run-id", selected_run_id),
                ),
                TuiQuickAction(
                    action_id="run.cancel",
                    label="Cancel run",
                    description="Cancel the selected run.",
                    argv=("tui", "--dispatch-action", "run.cancel", "--run-id", selected_run_id),
                ),
                TuiQuickAction(
                    action_id="run.reconcile",
                    label="Reconcile run",
                    description="Reconcile the selected run if it is stale.",
                    argv=("tui", "--dispatch-action", "run.reconcile", "--run-id", selected_run_id),
                ),
                TuiQuickAction(
                    action_id="run.resume",
                    label="Resume run",
                    description="Resume the selected run after reconcile or human gate.",
                    argv=("tui", "--dispatch-action", "run.resume", "--run-id", selected_run_id),
                ),
            ]
        )
    return actions


def render_tui_run_events(store: StateStore, run_id: str, *, limit: int = 20) -> list[str]:
    events = store.list_events(run_id)
    rendered: list[str] = []
    for event in events[-limit:]:
        payload = json.dumps(event["payload"], ensure_ascii=False, sort_keys=True)
        rendered.append(f"{event['type']} {payload}")
    return rendered or ["No run events yet."]


def render_tui_chat_messages(session: ChatSession, *, limit: int = 20) -> list[str]:
    messages = session.messages[-limit:]
    rendered: list[str] = []
    for message in messages:
        run_suffix = f" run_id={message.run_id}" if message.run_id else ""
        rendered.append(f"{message.role}{run_suffix}: {message.content}")
    return rendered or ["No chat messages yet."]


def resolve_tui_default_action(mode: str) -> str:
    if mode == "delivery":
        return "delivery.start"
    return "chat.direct"


def select_tui_run_id(run_ids: list[str], current: str | None, *, step: int) -> str | None:
    if not run_ids:
        return None
    if current not in run_ids:
        return run_ids[0]
    index = (run_ids.index(current) + step) % len(run_ids)
    return run_ids[index]


def _plugin_cache_path() -> Path:
    # Kernel resolver: user-global default + honors SUPERCLAW_PLUGIN_CACHE_PATH /
    # SUPERCLAW_PLUGIN_STATE_ROOT (single source of truth shared with CLI/API).
    return plugin_cache_root()


def _plugin_submission_path() -> Path:
    return Path(os.environ.get("SUPERCLAW_PLUGIN_SUBMISSION_PATH", ".superclaw/plugins/submissions"))


def _plugin_cloud_path() -> Path:
    return Path(os.environ.get("SUPERCLAW_PLUGIN_CLOUD_PATH", os.fspath(DEFAULT_CLOUD_ROOT)))


def _clawhunt_ingestion_path() -> Path:
    return _plugin_cloud_path() / "clawhunt-ingestions"


def _plugin_artifact_path() -> Path:
    configured = os.environ.get("SUPERCLAW_PLUGIN_ARTIFACT_PATH")
    return Path(configured) if configured else default_plugin_evidence_dir()


def build_tui_command_palette(*, selected_run_id: str | None = None) -> list[TuiCommandPaletteEntry]:
    entries = [
        TuiCommandPaletteEntry("/chat <prompt>", "Chat turn", "Ask the selected backend a direct question.", "chat"),
        TuiCommandPaletteEntry("/delivery <goal>", "Delivery dry-run", "Start a delivery dry-run for a task or goal.", "delivery"),
        TuiCommandPaletteEntry("/local <goal>", "Local backend run", "Run a dry-run using the built-in local backend.", "delivery"),
        TuiCommandPaletteEntry("/refresh", "Refresh", "Refresh runtime status, runs, and side panels.", "control"),
        TuiCommandPaletteEntry("/snapshot", "Snapshot evidence", "Write the current cockpit snapshot into the local artifact tree.", "control"),
        TuiCommandPaletteEntry("/commands", "Command palette", "Show slash commands and recommended next action.", "help"),
        TuiCommandPaletteEntry("/help", "Help", "Alias for the command palette summary.", "help"),
        TuiCommandPaletteEntry("/config set NAME VALUE", "Config set", "Persist backend, mode, repo, or agent executable settings.", "config"),
        TuiCommandPaletteEntry("/plugin-setting <name> <value>", "Plugin setting", "Configure the selected cached plugin setting.", "plugin"),
        TuiCommandPaletteEntry("/plugin-secret <name> <value>", "Plugin secret", "Configure the selected cached plugin secret without printing its value.", "plugin"),
        TuiCommandPaletteEntry("/plugin-secret-clear <name>", "Clear plugin secret", "Remove a configured secret for the selected cached plugin.", "plugin"),
    ]
    if selected_run_id:
        entries.extend(
            [
                TuiCommandPaletteEntry("/evidence", "Evidence summary", "Open evidence for the selected run.", "run"),
                TuiCommandPaletteEntry("/protocol", "Protocol export", "Export the selected run as a delivery protocol payload.", "run"),
                TuiCommandPaletteEntry("/cancel", "Cancel run", "Cancel the selected run.", "run"),
                TuiCommandPaletteEntry("/reconcile", "Reconcile run", "Reconcile a stale or interrupted run.", "run"),
                TuiCommandPaletteEntry("/resume", "Resume run", "Resume a queued or human-gated run.", "run"),
            ]
        )
    return entries


def recommend_tui_next_action(
    *,
    mode: str,
    selected_run: dict[str, Any] | None,
    selected_evidence: dict[str, Any] | None,
    selected_session: dict[str, Any] | None,
    missing_agents: list[dict[str, Any]],
    selected_plugin_configuration: dict[str, Any] | None,
) -> dict[str, Any]:
    if missing_agents:
        first_missing = missing_agents[0]
        return {
            "command": str(first_missing.get("configure") or "/config set BACKEND_EXECUTABLE /path/to/binary"),
            "label": f"Configure {first_missing.get('name')}",
            "reason": f"{first_missing.get('name')} is missing and blocks part of the runtime surface.",
        }
    if selected_run and selected_run.get("status") == "WAITING_FOR_HUMAN_GATE":
        return {
            "command": "/resume",
            "label": "Resume selected run",
            "reason": "The selected run is waiting for an operator gate before it can continue.",
        }
    if selected_run and selected_run.get("status") in _ACTIVE_RUN_STATUSES:
        return {
            "command": "/refresh",
            "label": "Refresh active run",
            "reason": "The selected run is still active, so the cockpit should keep polling for new state.",
        }
    if selected_evidence and selected_evidence.get("failed_finding_count", 0):
        return {
            "command": "/evidence",
            "label": "Inspect failing evidence",
            "reason": "The selected run has failing findings and should be inspected before retrying.",
        }
    if selected_plugin_configuration:
        missing_setting = next(
            (item for item in selected_plugin_configuration.get("configuration", {}).get("settings", []) if not item.get("configured")),
            None,
        )
        if missing_setting:
            return {
                "command": f"/plugin-setting {missing_setting['name']} <value>",
                "label": "Configure plugin setting",
                "reason": f"The selected plugin is missing setting `{missing_setting['name']}`.",
            }
        missing_secret = next(
            (
                item
                for item in selected_plugin_configuration.get("configuration", {}).get("secrets", [])
                if item.get("required") and not item.get("configured")
            ),
            None,
        )
        if missing_secret:
            return {
                "command": f"/plugin-secret {missing_secret['name']} <value>",
                "label": "Configure plugin secret",
                "reason": f"The selected plugin is missing required secret `{missing_secret['name']}`.",
            }
    if (
        selected_run
        and selected_run.get("status") == "completed"
        and selected_evidence
        and not selected_evidence.get("failed_finding_count", 0)
    ):
        return {
            "command": "/protocol",
            "label": "Export delivery protocol",
            "reason": "The selected run completed cleanly, so the next useful step is a delivery-protocol export.",
        }
    if mode == "chat":
        return {
            "command": "/chat Explain the current repo architecture",
            "label": "Start a direct chat turn",
            "reason": "No urgent run action is pending, so the fastest next move is a direct backend question.",
        }
    if selected_session:
        return {
            "command": "/delivery Verify the selected change and produce evidence",
            "label": "Start a new delivery dry-run",
            "reason": "The operator already has chat context, so the next useful step is a delivery turn.",
        }
    return {
        "command": "/delivery Describe the task to execute and verify",
        "label": "Start a delivery dry-run",
        "reason": "No blocking runtime issue is present, so the next useful step is to start a goal-oriented run.",
    }


def parse_tui_composer_input(
    *,
    value: str,
    mode: str,
    selected_action_id: str | None = None,
) -> TuiComposerCommand:
    text = value.strip()
    default_action = selected_action_id or resolve_tui_default_action(mode)
    if not text:
        return TuiComposerCommand(action_id=default_action)
    if not text.startswith("/"):
        return TuiComposerCommand(action_id=default_action, prompt=text)

    command, _, remainder = text[1:].partition(" ")
    remainder = remainder.strip()
    prompt = remainder or None
    alias = command.strip().lower()
    if alias == "config":
        if remainder.lower().startswith("set "):
            args = remainder[4:].strip()
            name, separator, value = args.partition(" ")
            return TuiComposerCommand(
                action_id="config.set",
                config_name=name.strip() or None,
                config_value=value.strip() if separator else None,
            )
        return TuiComposerCommand(action_id="config.set")
    if alias == "plugin-setting":
        name, separator, value = remainder.partition(" ")
        return TuiComposerCommand(
            action_id="plugin.setting.set",
            plugin_config_name=name.strip() or None,
            plugin_config_value=value.strip() if separator else None,
        )
    if alias == "plugin-secret":
        name, separator, value = remainder.partition(" ")
        return TuiComposerCommand(
            action_id="plugin.secret.set",
            plugin_config_name=name.strip() or None,
            plugin_config_value=value.strip() if separator else None,
        )
    if alias == "plugin-secret-clear":
        return TuiComposerCommand(
            action_id="plugin.secret.clear",
            plugin_config_name=remainder.strip() or None,
        )
    mapping = {
        "help": TuiComposerCommand(action_id="ui.commands"),
        "commands": TuiComposerCommand(action_id="ui.commands"),
        "chat": TuiComposerCommand(action_id="chat.direct", prompt=prompt),
        "delivery": TuiComposerCommand(action_id="delivery.start", prompt=prompt),
        "local": TuiComposerCommand(action_id="delivery.start.local", prompt=prompt, backend_override="local"),
        "refresh": TuiComposerCommand(action_id="ui.refresh"),
        "snapshot": TuiComposerCommand(action_id="ui.snapshot.export"),
        "evidence": TuiComposerCommand(action_id="run.evidence.open"),
        "protocol": TuiComposerCommand(action_id="run.protocol.export"),
        "cancel": TuiComposerCommand(action_id="run.cancel"),
        "reconcile": TuiComposerCommand(action_id="run.reconcile"),
        "resume": TuiComposerCommand(action_id="run.resume"),
    }
    if alias in mapping:
        return mapping[alias]
    return TuiComposerCommand(action_id=default_action, prompt=text)


def _evidence_artifact_path(session: RunSession, artifact_dir: Path) -> Path:
    root = Path(session.execution_context.get("artifact_dir") or artifact_dir).resolve()
    return root / session.run_id / "evidence.json"


def _protocol_export_artifact_path(session: RunSession, artifact_dir: Path) -> Path:
    root = Path(session.execution_context.get("artifact_dir") or artifact_dir).resolve()
    return root / session.run_id / "delivery-protocol.json"


def _tui_snapshot_artifact_path(
    *,
    artifact_dir: Path,
    run_id: str | None = None,
    session_id: str | None = None,
) -> Path:
    root = artifact_dir.resolve()
    if run_id:
        return root / run_id / "tui-snapshot.json"
    if session_id:
        return root / "chat" / session_id / "tui-snapshot.json"
    return root / "tui" / "tui-snapshot.json"


def write_tui_snapshot_artifact(snapshot: dict[str, Any], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _selected_plugin_payload(
    cached_plugins: list[dict[str, Any]],
    *,
    selected_plugin_id: str | None,
    plugin_entitlements: dict[str, Any] | None = None,
    plugin_revocations: list[dict[str, Any]] | None = None,
    plugin_policies: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if not cached_plugins:
        return None
    if selected_plugin_id:
        for plugin in cached_plugins:
            if str(plugin.get("id")) == selected_plugin_id:
                selected_plugin_id = str(plugin.get("id"))
                break
        else:
            selected_plugin_id = None
    selected = next((plugin for plugin in cached_plugins if str(plugin.get("id")) == selected_plugin_id), cached_plugins[0])
    manifest_path = Path(str(selected["path"])) / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    configuration = plugin_configuration_status(
        str(selected["id"]),
        manifest,
        plugin_version=str(selected["version"]),
    )
    commerce = manifest.get("commerce") if isinstance(manifest, dict) else {}
    if not isinstance(commerce, dict):
        commerce = {}
    entitlement_required = str(commerce.get("pricing_model") or "free") not in {"", "free"}
    entitlements = _matching_local_plugin_entitlements(
        plugin_entitlements,
        plugin_id=str(selected["id"]),
        plugin_version=str(selected["version"]),
    )
    revocations = _matching_plugin_revocations(
        plugin_revocations,
        plugin_id=str(selected["id"]),
        plugin_version=str(selected["version"]),
    )
    policies = _matching_plugin_policies(
        plugin_policies,
        plugin_id=str(selected["id"]),
        plugin_version=str(selected["version"]),
    )
    if not entitlement_required:
        entitlement_status = "not-required"
    elif entitlements:
        entitlement_status = "synced"
    else:
        entitlement_status = "missing"
    revocation_status = "revoked" if revocations else "clean"
    policy_status = "attached" if policies else "none"
    return {
        "plugin_id": str(selected["id"]),
        "version": str(selected["version"]),
        "name": str(selected.get("name") or selected["id"]),
        "path": str(selected["path"]),
        "acceptance_level": str((manifest.get("acceptance") or {}).get("level") or "unknown")
        if isinstance(manifest, dict)
        else "unknown",
        "package_digest": str((manifest.get("provenance") or {}).get("package_digest") or "")
        if isinstance(manifest, dict)
        else "",
        "signature_present": bool((manifest.get("provenance") or {}).get("signature"))
        if isinstance(manifest, dict)
        else False,
        "entitlement_required": entitlement_required,
        "entitlement_status": entitlement_status,
        "entitlements": entitlements,
        "revocation_status": revocation_status,
        "revocations": revocations,
        "policy_status": policy_status,
        "policies": policies,
        "configuration": configuration,
    }


def _matching_local_plugin_entitlements(
    entitlement_status: dict[str, Any] | None,
    *,
    plugin_id: str,
    plugin_version: str,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for item in list((entitlement_status or {}).get("entries") or []):
        if str(item.get("plugin_id") or "") != plugin_id:
            continue
        version = str(item.get("version") or "")
        version_range = str(item.get("version_range") or "")
        if version and version != plugin_version:
            continue
        if version_range:
            try:
                if not version_satisfies_range(plugin_version, version_range):
                    continue
            except PluginVersionRangeError:
                continue
        matches.append(item)
    return matches


def _matching_plugin_revocations(
    revocations: list[dict[str, Any]] | None,
    *,
    plugin_id: str,
    plugin_version: str,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for item in list(revocations or []):
        if str(item.get("plugin_id") or "") != plugin_id:
            continue
        version = str(item.get("version") or "")
        if version and version != plugin_version:
            continue
        matches.append(item)
    return matches


def _matching_plugin_policies(
    policies: list[dict[str, Any]] | None,
    *,
    plugin_id: str,
    plugin_version: str,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for item in list(policies or []):
        if str(item.get("plugin_id") or "") != plugin_id:
            continue
        version = str(item.get("version") or "")
        if version and version != plugin_version:
            continue
        matches.append(item)
    return matches


def _failure_reason_from_evidence(evidence: EvidenceBundle) -> str | None:
    timed_out_workers = [result for result in evidence.worker_results if result.timed_out]
    if timed_out_workers:
        selected_worker = sorted(timed_out_workers, key=lambda result: float(result.duration_seconds or 0.0), reverse=True)[0]
        duration = int(round(float(selected_worker.duration_seconds or 0.0)))
        return f"timeout: {selected_worker.backend} {selected_worker.role} exceeded {duration}s"
    failed = [finding for finding in evidence.findings if not finding.passed]
    if not failed:
        return None
    severity_rank = {"critical": 0, "high": 1, "warning": 2, "info": 3}
    selected = sorted(failed, key=lambda finding: (severity_rank.get(finding.severity, 9), finding.name))[0]
    return f"{selected.name}: {selected.detail}"


def build_tui_evidence_summary(store: StateStore, run_id: str, *, artifact_dir: Path) -> dict[str, Any]:
    session = store.get_run(run_id)
    protocol_export_path = _protocol_export_artifact_path(session, artifact_dir)
    try:
        bundle = store.get_evidence(run_id)
    except KeyError:
        return {
            "run_id": run_id,
            "chain_verdict": None,
            "evidence_path": str(_evidence_artifact_path(session, artifact_dir)),
            "protocol_export_path": str(protocol_export_path),
            "protocol_export_exists": protocol_export_path.exists(),
            "protocol_export_command": f"/protocol {run_id}",
            "protocol_adapter_name": DELIVERY_PROTOCOL_ADAPTER_NAME,
            "finding_count": 0,
            "failed_finding_count": 0,
            "worker_result_count": 0,
            "artifact_count": 0,
            "submitted_to_clawhunt": False,
            "failure_reason": None,
        }
    return {
        "run_id": run_id,
        "chain_verdict": bundle.chain_verdict.value,
        "evidence_path": str(_evidence_artifact_path(session, artifact_dir)),
        "protocol_export_path": str(protocol_export_path),
        "protocol_export_exists": protocol_export_path.exists(),
        "protocol_export_command": f"/protocol {run_id}",
        "protocol_adapter_name": DELIVERY_PROTOCOL_ADAPTER_NAME,
        "finding_count": len(bundle.findings),
        "failed_finding_count": len([finding for finding in bundle.findings if not finding.passed]),
        "worker_result_count": len(bundle.worker_results),
        "artifact_count": len(bundle.artifacts),
        "submitted_to_clawhunt": bool(bundle.submitted_to_clawhunt),
        "failure_reason": _failure_reason_from_evidence(bundle),
    }


def _goal_title(store: StateStore, goal_id: str) -> str | None:
    try:
        goal = store.get_goal(goal_id)
    except KeyError:
        return None
    if isinstance(goal, GoalSpec):
        return goal.title
    return None


def _selected_run_payload(store: StateStore, run_id: str | None) -> dict[str, Any] | None:
    if not run_id:
        return None
    try:
        session = store.get_run(run_id)
    except KeyError:
        return None
    payload = {
        "run_id": session.run_id,
        "goal_id": session.goal_id,
        "goal_title": _goal_title(store, session.goal_id),
        "status": session.status,
        "backend": str(session.execution_context.get("backend_policy") or "-"),
        "repo": str(session.execution_context.get("repo_path") or "."),
        "dry_run": bool(session.dry_run),
        "task_topology": str(session.execution_context.get("task_topology") or "linear"),
        "child_execution_count": len(session.child_executions),
    }
    try:
        bundle = store.get_evidence(run_id)
        payload["chain_verdict"] = bundle.chain_verdict.value
        payload["failure_reason"] = _failure_reason_from_evidence(bundle)
    except KeyError:
        payload["chain_verdict"] = None
        payload["failure_reason"] = None
    payload["cancellable"] = session.status not in _TERMINAL_RUN_STATUSES
    payload["resumable"] = session.status in {"queued", "WAITING_FOR_HUMAN_GATE"}
    return payload


def render_tui_task_timeline_lines(session: RunSession | None, *, limit: int = 8) -> list[str]:
    if session is None or session.task_graph is None or not session.task_graph.tasks:
        return ["No task timeline available."]
    lines = []
    for task in session.task_graph.tasks[:limit]:
        lines.append(f"{task.role.value} task={task.task_id} status={task.status}")
    return lines


def _latest_worker_result(bundle: EvidenceBundle | None) -> Any | None:
    if bundle is None or not bundle.worker_results:
        return None
    return max(
        bundle.worker_results,
        key=lambda item: (
            float(item.finished_at or 0.0),
            float(item.started_at or 0.0),
            int(item.attempt_index or 0),
        ),
    )


def _transcript_tail_lines(result: Any | None, *, limit_chars: int = 1600) -> list[str]:
    if result is None:
        return ["No worker transcript yet."]
    transcript_path = getattr(result, "transcript_path", None)
    if transcript_path:
        path = Path(str(transcript_path))
        if path.is_file():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = {}
            output_tail = str(payload.get("output_tail") or "")
            stdout_tail = str(payload.get("stdout_tail") or "")
            stderr_tail = str(payload.get("stderr_tail") or "")
            if output_tail:
                return (output_tail[-limit_chars:] or "(empty transcript)").splitlines()[-12:] or ["(empty transcript)"]
            combined = []
            if stdout_tail:
                combined.extend(["[stdout_tail]"] + stdout_tail[-limit_chars:].splitlines()[-8:])
            if stderr_tail:
                combined.extend(["[stderr_tail]"] + stderr_tail[-limit_chars:].splitlines()[-8:])
            if combined:
                return combined
    artifact_path = getattr(result, "artifact_path", None)
    if artifact_path:
        path = Path(str(artifact_path))
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8")[-limit_chars:].splitlines()[-12:] or ["(empty worker log)"]
            except OSError:
                pass
    output = str(getattr(result, "output", "") or "")
    if output:
        return output[-limit_chars:].splitlines()[-12:] or ["(empty worker output)"]
    return ["No worker transcript yet."]


def _selected_worker_payload(
    session: RunSession | None,
    bundle: EvidenceBundle | None,
) -> dict[str, Any] | None:
    if session is None:
        return None
    running_task = None
    if session.task_graph is not None:
        running_task = next((task for task in session.task_graph.tasks if task.status == "running"), None)
    latest_result = _latest_worker_result(bundle)
    if running_task is not None:
        return {
            "task_id": running_task.task_id,
            "role": running_task.role.value,
            "status": running_task.status,
            "backend": str(session.execution_context.get("backend_policy") or getattr(latest_result, "backend", "-")),
            "attempt_index": int(session.task_attempts.get(running_task.task_id, 0) or 0),
            "log_tail": _transcript_tail_lines(latest_result),
        }
    if latest_result is not None:
        return {
            "task_id": str(latest_result.task_id),
            "role": str(latest_result.role),
            "status": "completed" if int(getattr(latest_result, "exit_code", 1)) == 0 else "failed",
            "backend": str(latest_result.backend),
            "attempt_index": int(getattr(latest_result, "attempt_index", 1) or 1),
            "log_tail": _transcript_tail_lines(latest_result),
        }
    return None


def _run_result_summary(result: Any, artifact_dir: Path) -> dict[str, Any]:
    summary = {
        "run_id": result.session.run_id,
        "status": result.session.status,
        "chain_verdict": result.evidence.chain_verdict.value,
        "evidence_path": str((Path(artifact_dir).resolve() / result.session.run_id / "evidence.json")),
        "protocol_export_path": str((Path(artifact_dir).resolve() / result.session.run_id / "delivery-protocol.json")),
    }
    failure_reason = _failure_reason_from_evidence(result.evidence)
    if failure_reason:
        summary["failure_reason"] = failure_reason
    return summary


def _title_from_prompt(prompt: str, *, fallback: str) -> str:
    title = prompt.strip().splitlines()[0] if prompt.strip() else ""
    return (title[:80] or fallback).strip()


def _load_or_create_chat_session(
    store: StateStore,
    *,
    prompt: str,
    continue_last: bool,
    session_id: str | None = None,
) -> ChatSession:
    if session_id:
        return store.get_chat_session(session_id)
    sessions = store.list_chat_sessions()
    if continue_last and sessions:
        return sessions[0]
    return store.create_chat_session(_title_from_prompt(prompt, fallback="SuperClaw TUI"))


def dispatch_tui_action(
    *,
    state_path: Path,
    action_id: str,
    backend: str,
    mode: str,
    repo: Path,
    artifact_dir: Path,
    prompt: str | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
    plugin_id: str | None = None,
    plugin_version: str | None = None,
    continue_last: bool = False,
    dry_run: bool | None = None,
    budget_seconds: int = 60,
    backend_override: str | None = None,
    config_name: str | None = None,
    config_value: str | None = None,
    plugin_config_name: str | None = None,
    plugin_config_value: str | None = None,
) -> dict[str, Any]:
    orchestrator = SuperClawOrchestrator.from_path(state_path)
    store = orchestrator.store
    resolved_backend = backend_override or backend
    target_run_id = run_id

    if action_id == "ui.refresh":
        return {
            "action_id": action_id,
            "status": "completed",
            "snapshot": build_tui_snapshot(
                state_path=state_path,
                backend=backend,
                mode=mode,
                repo=repo,
                artifact_dir=artifact_dir,
                selected_run_id=target_run_id,
                selected_plugin_id=plugin_id,
            ),
        }

    if action_id == "ui.commands":
        snapshot = build_tui_snapshot(
            state_path=state_path,
            backend=backend,
            mode=mode,
            repo=repo,
            artifact_dir=artifact_dir,
            selected_run_id=target_run_id,
            selected_session_id=session_id,
            selected_plugin_id=plugin_id,
            selected_surface="chat" if mode == "chat" else "run",
        )
        return {
            "action_id": action_id,
            "status": "completed",
            "command_palette": snapshot["bottom_panel"]["command_palette"],
            "recommended_action": snapshot["bottom_panel"]["recommended_action"],
            "detail": "command palette refreshed",
        }

    if action_id == "ui.snapshot.export":
        snapshot = build_tui_snapshot(
            state_path=state_path,
            backend=backend,
            mode=mode,
            repo=repo,
            artifact_dir=artifact_dir,
            selected_run_id=target_run_id,
            selected_session_id=session_id,
            selected_plugin_id=plugin_id,
            selected_surface="chat" if mode == "chat" and session_id else "run",
        )
        snapshot_run_id = target_run_id or snapshot["sidebar"].get("selected_run_id")
        snapshot_session_id = session_id or snapshot["sidebar"].get("selected_session_id")
        export_path = write_tui_snapshot_artifact(
            snapshot,
            _tui_snapshot_artifact_path(
                artifact_dir=artifact_dir,
                run_id=snapshot_run_id,
                session_id=None if snapshot_run_id else snapshot_session_id,
            ),
        )
        return {
            "action_id": action_id,
            "status": "completed",
            "snapshot_path": str(export_path),
            "selected_run_id": snapshot_run_id,
            "selected_session_id": snapshot_session_id,
            "detail": "tui snapshot exported",
        }

    if action_id == "config.set":
        if not config_name or not config_value:
            return {
                "action_id": action_id,
                "status": "failed",
                "failure_reason": "usage: /config set NAME VALUE",
            }
        try:
            result = set_runtime_config(
                config_name,
                config_value,
                allow_secret=True,
                apply_process_env=True,
            )
        except ValueError as exc:
            return {"action_id": action_id, "status": "failed", "failure_reason": str(exc)}
        payload = {
            "action_id": action_id,
            "status": "completed",
            "config_name": str(result["name"]),
            "display_value": str(result["display_value"]),
            "persisted": bool(result["persisted"]),
            "restart_required": bool(result["restart_required"]),
            "detail": f"configured {result['name']}",
        }
        if result["name"] == "backend":
            payload["backend"] = str(config_value)
        elif result["name"] == "mode":
            payload["mode"] = str(config_value)
        elif result["name"] == "repo":
            payload["repo"] = str(config_value)
        return payload

    if action_id == "plugin.setting.set":
        if not plugin_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "selected plugin is required"}
        if not plugin_config_name or plugin_config_value is None:
            return {
                "action_id": action_id,
                "status": "failed",
                "failure_reason": "usage: /plugin-setting NAME VALUE",
            }
        result = set_plugin_setting(plugin_id, plugin_config_name, plugin_config_value)
        return {
            "action_id": action_id,
            "status": "completed",
            "plugin_id": plugin_id,
            "setting": result.name,
            "configured": True,
            "detail": f"configured plugin setting {result.name}",
        }

    if action_id == "plugin.secret.set":
        if not plugin_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "selected plugin is required"}
        if not plugin_config_name or plugin_config_value is None:
            return {
                "action_id": action_id,
                "status": "failed",
                "failure_reason": "usage: /plugin-secret NAME VALUE",
            }
        result = set_plugin_secret(
            plugin_id,
            plugin_config_name,
            plugin_config_value,
            version_range=f"={plugin_version}" if plugin_version else None,
        )
        return {
            "action_id": action_id,
            "status": "completed",
            "plugin_id": plugin_id,
            "secret": result.name,
            "configured": True,
            "detail": f"configured plugin secret {result.name}",
        }

    if action_id == "plugin.secret.clear":
        if not plugin_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "selected plugin is required"}
        if not plugin_config_name:
            return {
                "action_id": action_id,
                "status": "failed",
                "failure_reason": "usage: /plugin-secret-clear NAME",
            }
        result = delete_plugin_secret(plugin_id, plugin_config_name)
        return {
            "action_id": action_id,
            "status": "completed",
            "plugin_id": plugin_id,
            "secret": result.name,
            "configured": False,
            "detail": f"cleared plugin secret {result.name}" if result.deleted else f"plugin secret {result.name} was already absent",
        }

    if action_id == "run.evidence.open":
        if not target_run_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "run_id is required"}
        try:
            evidence = build_tui_evidence_summary(store, target_run_id, artifact_dir=artifact_dir)
        except KeyError:
            return {"action_id": action_id, "status": "failed", "failure_reason": f"run not found: {target_run_id}"}
        return {"action_id": action_id, "status": "completed", "evidence": evidence}

    if action_id == "run.protocol.export":
        if not target_run_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "run_id is required"}
        try:
            session = store.get_run(target_run_id)
        except KeyError:
            return {"action_id": action_id, "status": "failed", "failure_reason": f"run not found: {target_run_id}"}
        try:
            goal = store.get_goal(session.goal_id)
        except KeyError:
            return {"action_id": action_id, "status": "failed", "failure_reason": f"goal not found: {session.goal_id}"}
        try:
            bundle = store.get_evidence(target_run_id)
        except KeyError:
            return {
                "action_id": action_id,
                "status": "failed",
                "failure_reason": f"evidence not found for run: {target_run_id}",
            }
        export_path = _protocol_export_artifact_path(session, artifact_dir)
        export_path.parent.mkdir(parents=True, exist_ok=True)
        payload = build_clawhunt_delivery_protocol_payload(
            solution_text=default_solution_text(target_run_id),
            name=goal.title,
            summary=goal.description,
            evidence=bundle,
            attachments=[f"superclaw-run:{target_run_id}"],
        )
        export_path.write_text(json.dumps(payload.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return {
            "action_id": action_id,
            "status": "completed",
            "run_id": target_run_id,
            "protocol_export_path": str(export_path),
            "protocol_adapter_name": payload.adapter_name,
            "detail": f"protocol export ready: {payload.adapter_name}",
        }

    if action_id == "run.cancel":
        if not target_run_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "run_id is required"}
        result = orchestrator.cancel_run(target_run_id)
        return {
            "action_id": action_id,
            "status": "completed" if result.accepted else "failed",
            "run_id": result.run_id,
            "previous_status": result.previous_status,
            "accepted": bool(result.accepted),
            "event_type": result.event_type,
            "detail": result.detail,
        }

    if action_id == "run.reconcile":
        if not target_run_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "run_id is required"}
        result = orchestrator.reconcile_run(target_run_id)
        return {
            "action_id": action_id,
            "status": "completed",
            "run_id": result.run_id,
            "previous_status": result.previous_status,
            "run_status": result.status,
            "classification": result.classification,
            "resumable": bool(result.resumable),
            "detail": result.detail,
        }

    if action_id == "run.resume":
        if not target_run_id:
            return {"action_id": action_id, "status": "failed", "failure_reason": "run_id is required"}
        try:
            result = orchestrator.resume_run(target_run_id)
        except ValueError as exc:
            return {"action_id": action_id, "status": "failed", "failure_reason": str(exc), "run_id": target_run_id}
        if hasattr(result, "session"):
            summary = _run_result_summary(
                result,
                Path(result.session.execution_context.get("artifact_dir") or artifact_dir),
            )
            return {"action_id": action_id, "status": "completed", **summary}
        return {"action_id": action_id, "status": "completed", "run_id": target_run_id, "run_status": result.status}

    if action_id in {"chat.direct", "delivery.start", "delivery.start.local"}:
        if not prompt or not prompt.strip():
            return {"action_id": action_id, "status": "failed", "failure_reason": "prompt is required"}
        execution_dry_run = True if dry_run is None else bool(dry_run)
        if action_id == "chat.direct":
            session = _load_or_create_chat_session(
                store,
                prompt=prompt,
                continue_last=continue_last,
                session_id=session_id,
            )
            store.append_chat_message(session.session_id, "user", prompt)
            result = orchestrator.run_goal(
                title=session.title,
                description=prompt,
                dry_run=execution_dry_run,
                backend_policy=resolved_backend,
                repo_path=repo,
                budget_seconds=budget_seconds,
                artifact_dir=artifact_dir,
                chat_session_id=session.session_id,
                task_topology=TaskTopology.LINEAR,
            )
            summary = _run_result_summary(result, artifact_dir)
            store.append_chat_message(
                session.session_id,
                "assistant",
                f"run_id={result.session.run_id} status={result.session.status} chain_verdict={result.evidence.chain_verdict.value}",
                run_id=result.session.run_id,
            )
            return {"action_id": action_id, "status": "completed", "session_id": session.session_id, **summary}
        result = orchestrator.run_goal(
            title=_title_from_prompt(prompt, fallback="SuperClaw TUI delivery"),
            description=prompt,
            dry_run=execution_dry_run,
            backend_policy=resolved_backend,
            repo_path=repo,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            task_topology=TaskTopology.LINEAR,
        )
        return {"action_id": action_id, "status": "completed", **_run_result_summary(result, artifact_dir)}

    return {"action_id": action_id, "status": "failed", "failure_reason": f"unknown action: {action_id}"}


def dispatch_tui_composer(
    *,
    state_path: Path,
    backend: str,
    mode: str,
    repo: Path,
    artifact_dir: Path,
    value: str,
    selected_action_id: str | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
    plugin_id: str | None = None,
    plugin_version: str | None = None,
    continue_last: bool = False,
    dry_run: bool | None = None,
    budget_seconds: int = 60,
) -> dict[str, Any]:
    command = parse_tui_composer_input(value=value, mode=mode, selected_action_id=selected_action_id)
    return dispatch_tui_action(
        state_path=state_path,
        action_id=command.action_id,
        backend=backend,
        mode=mode,
        repo=repo,
        artifact_dir=artifact_dir,
        prompt=command.prompt,
        run_id=run_id,
        session_id=session_id,
        plugin_id=plugin_id,
        plugin_version=plugin_version,
        continue_last=continue_last,
        dry_run=dry_run,
        budget_seconds=budget_seconds,
        backend_override=command.backend_override,
        config_name=command.config_name,
        config_value=command.config_value,
        plugin_config_name=command.plugin_config_name,
        plugin_config_value=command.plugin_config_value,
    )


def start_tui_composer_action(
    *,
    state_path: Path,
    backend: str,
    mode: str,
    repo: Path,
    artifact_dir: Path,
    value: str,
    selected_action_id: str | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
    plugin_id: str | None = None,
    plugin_version: str | None = None,
    continue_last: bool = False,
    dry_run: bool | None = None,
    budget_seconds: int = 60,
) -> TuiAsyncActionHandle:
    command = parse_tui_composer_input(value=value, mode=mode, selected_action_id=selected_action_id)
    handle = TuiAsyncActionHandle(action_id=command.action_id, submitted_value=value)

    def _runner() -> None:
        try:
            result = dispatch_tui_composer(
                state_path=state_path,
                backend=backend,
                mode=mode,
                repo=repo,
                artifact_dir=artifact_dir,
                value=value,
                selected_action_id=selected_action_id,
                run_id=run_id,
                session_id=session_id,
                plugin_id=plugin_id,
                plugin_version=plugin_version,
                continue_last=continue_last,
                dry_run=dry_run,
                budget_seconds=budget_seconds,
            )
        except Exception as exc:  # pragma: no cover - exercised through tests via read helper
            result = {
                "action_id": command.action_id,
                "status": "failed",
                "failure_reason": f"{type(exc).__name__}: {exc}",
            }
        with handle._lock:
            handle.result = result
            handle._done.set()

    thread = Thread(target=_runner, name=f"superclaw-tui-{command.action_id}", daemon=True)
    handle.thread = thread
    thread.start()
    return handle


def read_tui_action_handle(handle: TuiAsyncActionHandle) -> dict[str, Any]:
    with handle._lock:
        if handle.result is not None:
            return dict(handle.result)
        return {
            "action_id": handle.action_id,
            "status": "working",
            "submitted_value": handle.submitted_value,
            "elapsed_seconds": round(max(0.0, time.time() - handle.started_at), 2),
        }


def apply_tui_action_result_selection(
    *,
    selected_run_id: str | None,
    selected_session_id: str | None,
    selected_surface: str,
    result: dict[str, Any],
) -> tuple[str | None, str | None, str]:
    next_run_id = selected_run_id
    next_session_id = selected_session_id
    next_surface = selected_surface
    if result.get("run_id"):
        next_run_id = str(result["run_id"])
        if result.get("action_id") != "chat.direct":
            next_surface = "run"
    if result.get("session_id") and result.get("action_id") == "chat.direct":
        next_session_id = str(result["session_id"])
        next_surface = "chat"
    return next_run_id, next_session_id, next_surface


def summarize_tui_action_result(result: dict[str, Any]) -> list[str]:
    lines = [
        f"action={result.get('action_id', '(unknown)')}",
        f"status={result.get('status', '(unknown)')}",
    ]
    if result.get("elapsed_seconds") is not None:
        lines.append(f"elapsed_seconds={result['elapsed_seconds']}")
    if result.get("run_id"):
        lines.append(f"run_id={result['run_id']}")
    if result.get("session_id"):
        lines.append(f"session_id={result['session_id']}")
    if result.get("submitted_value"):
        lines.append(f"submitted_value={result['submitted_value']}")
    if result.get("classification"):
        lines.append(f"classification={result['classification']}")
    if result.get("config_name"):
        lines.append(f"config_name={result['config_name']}")
    if result.get("display_value"):
        lines.append(f"display_value={result['display_value']}")
    if result.get("chain_verdict"):
        lines.append(f"chain_verdict={result['chain_verdict']}")
    if result.get("failure_reason"):
        lines.append(f"failure_reason={result['failure_reason']}")
    elif result.get("detail"):
        lines.append(f"detail={result['detail']}")
    return lines


def render_tui_agent_doctor_lines(
    *,
    agents: list[dict[str, Any]],
    missing_agents: list[dict[str, Any]],
    limit: int = 3,
) -> list[str]:
    lines = ["Agent doctor:"]
    selected = missing_agents[:limit] or agents[:2]
    if not selected:
        return [*lines, "No agents discovered."]
    for agent in selected:
        config_state = agent.get("config_state") or "unset"
        lines.append(
            f"{agent['name']} {'READY' if agent.get('available') else 'MISSING'} "
            f"kind={agent.get('kind')} config={config_state}"
        )
        if agent.get("model_env"):
            lines.append(f"model={agent.get('model_state') or 'unset'}")
        lines.append(f"hint={agent.get('configure')}")
    return lines


def render_tui_plugin_cache_lines(plugins: list[dict[str, Any]], *, limit: int = 5) -> list[str]:
    if not plugins:
        return ["Plugin cache:", "No cached plugins."]
    lines = ["Plugin cache:"]
    for plugin in plugins[:limit]:
        lines.append(f"{plugin.get('id')}@{plugin.get('version')} name={plugin.get('name')}")
    return lines


def render_tui_plugin_verification_lines(
    plugin_verification: dict[str, Any] | None,
    *,
    selected_plugin: dict[str, Any] | None,
) -> list[str]:
    root_ready = bool((plugin_verification or {}).get("public_key_configured"))
    lines = [
        "Plugin verification:",
        f"root_key={'set' if root_ready else 'unset'}",
    ]
    if not selected_plugin:
        lines.append("No cached plugin selected.")
        return lines
    package_digest = str(selected_plugin.get("package_digest") or "")
    digest_display = package_digest[:19] + "..." if len(package_digest) > 22 else (package_digest or "(missing)")
    lines.append(
        (
            f"selected={selected_plugin['plugin_id']}@{selected_plugin['version']} "
            f"acceptance={selected_plugin.get('acceptance_level') or 'unknown'} "
            f"signature={'present' if selected_plugin.get('signature_present') else 'missing'}"
        )
    )
    lines.append(f"digest={digest_display}")
    if not root_ready:
        lines.append("Configure SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY before trusting new local installs.")
    return lines


def render_tui_plugin_configuration_lines(selected_plugin: dict[str, Any] | None) -> list[str]:
    if not selected_plugin:
        return ["Plugin config:", "No cached plugin selected."]
    configuration = selected_plugin.get("configuration", {})
    settings = list(configuration.get("settings", []))
    secrets = list(configuration.get("secrets", []))
    configured_settings = sum(1 for item in settings if item.get("configured"))
    configured_secrets = sum(1 for item in secrets if item.get("configured"))
    lines = [
        "Plugin config:",
        f"{selected_plugin['plugin_id']}@{selected_plugin['version']}",
        f"settings={configured_settings}/{len(settings)} secrets={configured_secrets}/{len(secrets)}",
    ]
    for item in settings[:4]:
        status = "configured" if item.get("configured") else "missing"
        lines.append(f"setting {item['name']}={status}")
        if not item.get("configured"):
            lines.append(f"  /plugin-setting {item['name']} <value>")
    for item in secrets[:4]:
        # Auto-provisioned credentials are supplied from login state, not pasted by
        # the user — never label them "missing" or prompt /plugin-secret (that is
        # the original confusion the config-status contract removes). Mirror the
        # status payload every other surface renders.
        if item.get("auto_provisioned"):
            provider = item.get("provisioning_provider") or "account login"
            avail = "available" if item.get("provisioning_status") == "available" else "sign-in required"
            lines.append(f"secret {item['name']}=auto-provisioned ({provider}: {avail})")
            if item.get("configured"):
                lines.append(f"  override active — /plugin-secret-clear {item['name']}")
            continue
        status = "configured" if item.get("configured") else "missing" if item.get("required") else "optional"
        lines.append(f"secret {item['name']}={status}")
        if not item.get("configured"):
            lines.append(f"  /plugin-secret {item['name']} <value>")
        else:
            lines.append(f"  /plugin-secret-clear {item['name']}")
    return lines


def render_tui_plugin_entitlement_lines(
    entitlement_status: dict[str, Any] | None,
    *,
    selected_plugin: dict[str, Any] | None,
) -> list[str]:
    if not entitlement_status:
        return ["Plugin entitlements:", "No local entitlement state available."]
    lines = [
        "Plugin entitlements:",
        (
            f"local_count={entitlement_status.get('count', 0)} "
            f"plugin_count={entitlement_status.get('plugin_count', 0)}"
        ),
        f"file={entitlement_status.get('file')}",
    ]
    error = entitlement_status.get("error")
    if error:
        lines.append(f"error={error}")
        return lines
    if not selected_plugin:
        lines.append("No cached plugin selected.")
        return lines
    lines.append(
        (
            f"selected={selected_plugin['plugin_id']}@{selected_plugin['version']} "
            f"required={'yes' if selected_plugin.get('entitlement_required') else 'no'} "
            f"status={selected_plugin.get('entitlement_status')}"
        )
    )
    for item in list(selected_plugin.get("entitlements", []))[:2]:
        lines.append(
            (
                f"entitlement {item.get('entitlement_id')} "
                f"expires={item.get('expires_at') or '(none)'} "
                f"offline_grace={item.get('offline_grace_expires_at') or '(none)'}"
            )
        )
        if item.get("offline_grace_disabled_reason"):
            lines.append(f"  disabled_reason={item['offline_grace_disabled_reason']}")
    if selected_plugin.get("entitlement_required") and not selected_plugin.get("entitlements"):
        lines.append("Sync a local entitlement before paid plugin execution.")
    return lines


def render_tui_plugin_revocation_lines(
    revocations: list[dict[str, Any]] | None,
    *,
    selected_plugin: dict[str, Any] | None,
) -> list[str]:
    lines = [
        "Plugin revocations:",
        f"total={len(revocations or [])}",
    ]
    if not selected_plugin:
        lines.append("No cached plugin selected.")
        return lines
    lines.append(
        (
            f"selected={selected_plugin['plugin_id']}@{selected_plugin['version']} "
            f"status={selected_plugin.get('revocation_status')}"
        )
    )
    for item in list(selected_plugin.get("revocations", []))[:2]:
        lines.append(
            (
                f"revoked reason={item.get('reason') or '(unknown)'} "
                f"version={item.get('version') or '(any)'} "
                f"digest={item.get('package_digest') or '(none)'}"
            )
        )
    if not selected_plugin.get("revocations"):
        lines.append("No matching revocation entries for the selected plugin.")
    return lines


def render_tui_plugin_policy_lines(
    policies: list[dict[str, Any]] | None,
    *,
    selected_plugin: dict[str, Any] | None,
) -> list[str]:
    lines = [
        "Plugin runtime policy:",
        f"total={len(policies or [])}",
    ]
    if not selected_plugin:
        lines.append("No cached plugin selected.")
        return lines
    lines.append(
        (
            f"selected={selected_plugin['plugin_id']}@{selected_plugin['version']} "
            f"status={selected_plugin.get('policy_status')}"
        )
    )
    for item in list(selected_plugin.get("policies", []))[:2]:
        lines.append(
            (
                f"policy min_runtime={item.get('minimum_runtime_version') or '(none)'} "
                f"max_output={item.get('max_model_output_bytes') or '(none)'} "
                f"timeout={item.get('max_tool_timeout_ms') or '(none)'}"
            )
        )
        lines.append(
            (
                f"  risk={item.get('risk_level') or '(unset)'} "
                f"metering={'yes' if item.get('requires_live_metering') else 'no'} "
                f"denylist={','.join(item.get('denylisted_permissions') or []) or '(none)'}"
            )
        )
        descriptors = [str(descriptor.get("name")) for descriptor in list(item.get("secret_descriptors") or []) if descriptor.get("name")]
        lines.append(f"  secret_descriptors={','.join(descriptors) or '(none)'}")
    if not selected_plugin.get("policies"):
        lines.append("No matching runtime policy for the selected plugin.")
    return lines


def render_tui_plugin_diagnostic_lines(
    plugin_diagnostics: dict[str, Any] | None,
    *,
    selected_plugin: dict[str, Any] | None,
    limit: int = 3,
) -> list[str]:
    if not plugin_diagnostics:
        return ["Plugin diagnostics:", "No plugin diagnostics available."]
    summary = plugin_diagnostics.get("summary", {})
    lines = [
        "Plugin diagnostics:",
        f"artifacts={plugin_diagnostics.get('artifact_count', 0)} findings={len(plugin_diagnostics.get('findings', []))}",
        (
            f"slow_calls={summary.get('slow_calls', 0)} "
            f"failures={summary.get('failures', 0)} sandbox_kills={summary.get('sandbox_kills', 0)}"
        ),
    ]
    findings = list(plugin_diagnostics.get("findings", []))
    if selected_plugin:
        plugin_id = str(selected_plugin.get("plugin_id") or "")
        plugin_version = str(selected_plugin.get("version") or "")
        findings = [
            finding
            for finding in findings
            if str(finding.get("plugin_id") or "") == plugin_id and str(finding.get("plugin_version") or "") == plugin_version
        ]
        lines.append(f"selected={plugin_id}@{plugin_version} findings={len(findings)}")
    if not findings:
        lines.append("No plugin runtime findings.")
        return lines
    for finding in findings[:limit]:
        detail = finding.get("tool_name") or finding.get("artifact_id") or "(detail unavailable)"
        lines.append(f"{finding.get('code')} severity={finding.get('severity')} tool={detail}")
    return lines


def render_tui_command_palette_lines(entries: list[dict[str, Any]], *, limit: int = 8) -> list[str]:
    lines = ["Command palette:"]
    if not entries:
        return [*lines, "No commands available."]
    for entry in entries[:limit]:
        lines.append(f"{entry['command']} -> {entry['label']} ({entry['category']})")
        lines.append(f"  {entry['description']}")
    return lines


def build_tui_snapshot(
    *,
    state_path: Path,
    backend: str,
    mode: str,
    repo: Path,
    artifact_dir: Path,
    selected_run_id: str | None = None,
    selected_session_id: str | None = None,
    selected_plugin_id: str | None = None,
    selected_surface: str | None = None,
    selected_action_id: str | None = None,
    last_action_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    store = StateStore(state_path)
    runs = store.list_runs()
    sessions = store.list_chat_sessions()
    if selected_run_id is None and runs:
        selected_run_id = runs[0].run_id
    if selected_session_id is None and sessions:
        selected_session_id = sessions[0].session_id
    if selected_surface not in {"run", "chat"}:
        if mode == "chat" and selected_session_id:
            selected_surface = "chat"
        else:
            selected_surface = "run"
    context = store.context_usage()
    active_run_ids = [
        run.run_id
        for run in runs
        if str(run.status) in _ACTIVE_RUN_STATUSES
    ]
    plugin_status = build_plugin_status_payload(
        cache_root=_plugin_cache_path(),
        cloud_root=_plugin_cloud_path(),
        developer_submission_root=_plugin_submission_path(),
        clawhunt_ingestion_root=_clawhunt_ingestion_path(),
    )
    plugin_diagnostics = build_plugin_diagnostics_payload(artifact_dir=_plugin_artifact_path())
    agents = build_agent_inventory(backends=default_backends(), config_payload=runtime_config_payload())
    runtime_status = build_runtime_status_payload(
        runtime_version=_superclaw_version(),
        repo=repo,
        state_path=state_path,
        artifact_dir=artifact_dir,
        backend=backend,
        mode=mode,
        started_at=time.time(),
        control_token_required=bool(os.environ.get("SUPERCLAW_CONTROL_TOKEN")),
        clawhunt_agent_api_key_configured=bool(os.environ.get("CLAWHUNT_AGENT_API_KEY")),
        context=context,
        active_run_ids=active_run_ids,
        recent_run_id=runs[0].run_id if runs else None,
        config_path=shell_config_path(),
        agents=agents,
        plugins=plugin_status,
    )
    missing_agents = [agent for agent in agents if not agent.get("available")]
    cached_plugins = plugin_status.get("plugins", [])
    selected_plugin = (
        _selected_plugin_payload(
            cached_plugins,
            selected_plugin_id=selected_plugin_id,
            plugin_entitlements=plugin_status.get("entitlements"),
            plugin_revocations=plugin_status.get("governance", {}).get("revocations"),
            plugin_policies=plugin_status.get("governance", {}).get("policies"),
        )
        if cached_plugins
        else None
    )
    selected_run = _selected_run_payload(store, selected_run_id)
    if selected_run_id:
        try:
            selected_run_session = store.get_run(selected_run_id)
        except KeyError:
            selected_run_session = None
    else:
        selected_run_session = None
    selected_session = None
    selected_chat_lines = ["No chat session selected."]
    if selected_session_id:
        try:
            session = store.get_chat_session(selected_session_id)
        except KeyError:
            selected_chat_lines = [f"Selected session not found: {selected_session_id}"]
            selected_session = None
        else:
            selected_session = {
                "session_id": session.session_id,
                "title": session.title,
                "message_count": len(session.messages),
                "updated_at": session.updated_at,
                "latest_run_id": next((message.run_id for message in reversed(session.messages) if message.run_id), None),
            }
            selected_chat_lines = render_tui_chat_messages(session)
    selected_evidence = None
    selected_bundle = None
    if selected_run_id:
        try:
            selected_evidence = build_tui_evidence_summary(store, selected_run_id, artifact_dir=artifact_dir)
        except KeyError:
            selected_evidence = None
        try:
            selected_bundle = store.get_evidence(selected_run_id)
        except KeyError:
            selected_bundle = None
    selected_worker = _selected_worker_payload(selected_run_session, selected_bundle)
    task_timeline = render_tui_task_timeline_lines(selected_run_session)
    command_palette = [
        entry.to_dict()
        for entry in build_tui_command_palette(selected_run_id=selected_run_id)
    ]
    recommended_action = recommend_tui_next_action(
        mode=mode,
        selected_run=selected_run,
        selected_evidence=selected_evidence,
        selected_session=selected_session,
        missing_agents=missing_agents,
        selected_plugin_configuration=selected_plugin,
    )
    main_kind = str(selected_surface)
    runtime_health = runtime_status["service"]["health"]
    return {
        "layout": {
            "left": "sessions/runs",
            "top": "runtime status",
            "main": "chat or run detail",
            "bottom": "input box and command palette",
            "right": "evidence/plugin/agent status",
        },
        "top_bar": {
            "backend": backend,
            "mode": mode,
            "repo": str(repo),
            "auth": runtime_status["auth"]["clawhunt"],
            "runtime_health": runtime_health["status"],
            "runtime_health_summary": runtime_health["summary"],
            "active_runs": runtime_status["state"]["active_run_count"],
            "ready_agents": runtime_status["agents"]["ready_count"],
        },
        "sidebar": {
            "selected_run_id": selected_run_id,
            "selected_session_id": selected_session_id,
            "selected_plugin_id": selected_plugin["plugin_id"] if selected_plugin else None,
            "runs": [
                {
                    "run_id": run.run_id,
                    "status": run.status,
                    "goal_id": run.goal_id,
                    "goal_title": _goal_title(store, run.goal_id),
                    "dry_run": bool(run.dry_run),
                }
                for run in runs[:20]
            ],
            "sessions": [
                {
                    "session_id": session.session_id,
                    "title": session.title,
                    "message_count": len(session.messages),
                    "updated_at": session.updated_at,
                }
                for session in sessions[:20]
            ],
        },
        "main_panel": {
            "kind": main_kind,
            "selected_run": selected_run,
            "selected_session": selected_session,
            "task_timeline": task_timeline,
            "selected_worker": selected_worker,
            "events": (
                selected_chat_lines
                if main_kind == "chat"
                else render_tui_run_events(store, selected_run_id) if selected_run_id else ["No run selected."]
            ),
        },
        "bottom_panel": {
            "input_placeholder": "Type a chat message or use a quick action.",
            "default_action": resolve_tui_default_action(mode),
            "selected_action_id": selected_action_id or resolve_tui_default_action(mode),
            "quick_actions": [
                action.to_dict()
                for action in build_tui_quick_actions(
                    backend=backend,
                    repo=repo,
                    artifact_dir=artifact_dir,
                    selected_run_id=selected_run_id,
                )
            ],
            "command_palette": command_palette,
            "recommended_action": recommended_action,
        },
        "right_panel": {
            "recent_run_id": runtime_status["state"]["recent_run_id"],
            "plugin_count": plugin_status["plugin_count"],
            "ready_agents": runtime_status["agents"]["ready_count"],
            "auth": runtime_status["auth"]["clawhunt"],
            "runtime_health": runtime_health,
            "selected_evidence": selected_evidence,
            "selected_surface": main_kind,
            "selected_worker": selected_worker,
            "last_action_result": last_action_result,
            "agents": agents,
            "missing_agents": missing_agents,
            "plugins": cached_plugins,
            "selected_plugin": selected_plugin,
            "plugin_diagnostics": plugin_diagnostics,
            "plugin_verification": plugin_status["verification"],
            "plugin_entitlements": plugin_status["entitlements"],
            "entitlement_count": plugin_status["entitlements"]["count"],
            "plugin_revocations": plugin_status["governance"].get("revocations", []),
            "plugin_policies": plugin_status["governance"].get("policies", []),
            "registry_count": plugin_status["registry"]["count"],
            "revocation_count": plugin_status["governance"]["revocation_count"],
            "policy_count": plugin_status["governance"]["policy_count"],
            "recommended_action": recommended_action,
            "command_palette": command_palette,
        },
        "runtime_status": runtime_status,
    }


def _load_textual_app_class() -> type[Any]:
    try:
        from textual.app import App, ComposeResult
        from textual.containers import Vertical
        from textual.widgets import Footer, Header, Input, Static
    except ModuleNotFoundError as exc:  # pragma: no cover - environment-dependent
        raise TuiBootstrapError("textual runtime is unavailable; reinstall SuperClaw dependencies and retry") from exc

    class SuperClawTextualApp(App[None]):  # pragma: no cover - exercised through CLI bootstrap tests only
        CSS = """
        Screen {
            layout: grid;
            grid-size: 3 3;
            grid-columns: 24 1fr 30;
            grid-rows: 3 1fr 8;
        }
        #topbar {
            column-span: 3;
            border: solid green;
            padding: 0 1;
        }
        #sidebar {
            border: solid cyan;
            padding: 0 1;
        }
        #main-panel {
            border: solid white;
            padding: 0 1;
        }
        #right-panel {
            border: solid magenta;
            padding: 0 1;
        }
        #bottom-panel {
            column-span: 3;
            border: solid yellow;
            padding: 0 1;
        }
        #composer {
            margin-top: 1;
        }
        """
        BINDINGS = [
            ("q", "quit", "Quit"),
            ("r", "refresh", "Refresh"),
            ("a", "toggle_auto_refresh", "Auto refresh"),
            ("j", "select_next_run", "Next run"),
            ("k", "select_previous_run", "Previous run"),
            ("u", "select_previous_session", "Previous session"),
            ("i", "select_next_session", "Next session"),
            ("o", "select_previous_plugin", "Previous plugin"),
            ("p", "select_next_plugin", "Next plugin"),
            ("s", "toggle_surface", "Toggle surface"),
            ("]", "select_next_action", "Next action"),
            ("[", "select_previous_action", "Previous action"),
        ]

        def __init__(
            self,
            *,
            state_path: Path,
            backend: str,
            mode: str,
            repo: Path,
            artifact_dir: Path,
            selected_run_id: str | None = None,
            selected_plugin_id: str | None = None,
            budget_seconds: int = 60,
            dry_run: bool | None = None,
        ) -> None:
            super().__init__()
            self._state_path = state_path
            self._backend = backend
            self._mode = mode
            self._repo = repo
            self._artifact_dir = artifact_dir
            self._selected_run_id = selected_run_id
            self._selected_session_id: str | None = None
            self._selected_plugin_id = selected_plugin_id
            self._selected_surface = "chat" if mode == "chat" else "run"
            self._selected_action_id = resolve_tui_default_action(mode)
            self._last_action_result: dict[str, Any] | None = None
            self._pending_action: TuiAsyncActionHandle | None = None
            self._auto_refresh_enabled = True
            self._budget_seconds = budget_seconds
            self._dry_run = dry_run

        def _snapshot(self) -> dict[str, Any]:
            return build_tui_snapshot(
                state_path=self._state_path,
                backend=self._backend,
                mode=self._mode,
                repo=self._repo,
                artifact_dir=self._artifact_dir,
                selected_run_id=self._selected_run_id,
                selected_session_id=self._selected_session_id,
                selected_plugin_id=self._selected_plugin_id,
                selected_surface=self._selected_surface,
                selected_action_id=self._selected_action_id,
                last_action_result=self._last_action_result,
            )

        def compose(self) -> ComposeResult:
            yield Header(show_clock=True)
            yield Static(id="topbar")
            yield Static(id="sidebar")
            yield Static(id="main-panel")
            yield Static(id="right-panel")
            with Vertical(id="bottom-panel"):
                yield Static(id="command-palette")
                yield Input(placeholder="Type a chat message or press a quick action", id="composer")
            yield Footer()

        def on_mount(self) -> None:
            self.action_refresh()
            self.set_interval(1.0, self._poll_runtime)

        def action_refresh(self) -> None:
            snapshot = self._snapshot()
            top_bar = snapshot["top_bar"]
            working_state = (
                read_tui_action_handle(self._pending_action)["status"]
                if self._pending_action is not None
                else "idle"
            )
            self.query_one("#topbar", Static).update(
                f"backend={top_bar['backend']} mode={top_bar['mode']} repo={top_bar['repo']} "
                f"auth={top_bar['auth']} ready_agents={top_bar['ready_agents']} active_runs={top_bar['active_runs']} "
                f"health={top_bar['runtime_health']} working={working_state} auto_refresh={'on' if self._auto_refresh_enabled else 'off'}"
            )
            runs = snapshot["sidebar"]["runs"]
            sessions = snapshot["sidebar"]["sessions"]
            selected = snapshot["sidebar"]["selected_run_id"] or "(none)"
            selected_session = snapshot["sidebar"]["selected_session_id"] or "(none)"
            selected_plugin = snapshot["sidebar"].get("selected_plugin_id") or "(none)"
            sidebar_lines = [
                f"Surface: {snapshot['main_panel']['kind']}",
                f"Selected run: {selected}",
                f"Selected session: {selected_session}",
                f"Selected plugin: {selected_plugin}",
                "",
                "Sessions:",
            ]
            if sessions:
                sidebar_lines.extend(
                    f"{session['session_id']} messages={session['message_count']} title={session['title']}"
                    for session in sessions
                )
            else:
                sidebar_lines.append("No chat sessions recorded.")
            sidebar_lines.extend(["", "Runs:"])
            if runs:
                sidebar_lines.extend(
                    f"{run['run_id']} status={run['status']} dry_run={str(run['dry_run']).lower()}" for run in runs
                )
            else:
                sidebar_lines.append("No runs recorded.")
            self.query_one("#sidebar", Static).update("\n".join(sidebar_lines))
            main_kind = snapshot["main_panel"]["kind"]
            selected_run = snapshot["main_panel"]["selected_run"]
            selected_session_payload = snapshot["main_panel"]["selected_session"]
            main_lines = [f"{main_kind.title()} detail:"]
            if main_kind == "chat" and selected_session_payload:
                main_lines.extend(
                    [
                        f"session_id={selected_session_payload['session_id']}",
                        f"title={selected_session_payload['title']}",
                        f"message_count={selected_session_payload['message_count']}",
                        f"latest_run_id={selected_session_payload.get('latest_run_id') or '(none)'}",
                        "",
                    ]
                )
            elif selected_run:
                main_lines.extend(
                    [
                        f"run_id={selected_run['run_id']}",
                        f"goal={selected_run.get('goal_title') or selected_run['goal_id']}",
                        f"status={selected_run['status']}",
                        f"backend={selected_run['backend']}",
                        f"topology={selected_run['task_topology']}",
                        f"chain_verdict={selected_run.get('chain_verdict') or '(none)'}",
                        f"failure_reason={selected_run.get('failure_reason') or '(none)'}",
                        f"resumable={str(selected_run['resumable']).lower()}",
                        f"cancellable={str(selected_run['cancellable']).lower()}",
                        "",
                    ]
                )
            else:
                main_lines.append("No item selected.")
                main_lines.append("")
            if main_kind == "run":
                main_lines.extend(["Task timeline:"])
                main_lines.extend(snapshot["main_panel"]["task_timeline"])
                main_lines.append("")
                selected_worker = snapshot["main_panel"]["selected_worker"]
                if selected_worker:
                    main_lines.extend(
                        [
                            "Current worker:",
                            f"task_id={selected_worker['task_id']}",
                            f"role={selected_worker['role']}",
                            f"status={selected_worker['status']}",
                            f"backend={selected_worker['backend']}",
                            f"attempt_index={selected_worker['attempt_index']}",
                            "",
                            "Worker log tail:",
                            *selected_worker["log_tail"],
                            "",
                        ]
                    )
            main_lines.extend(snapshot["main_panel"]["events"])
            self.query_one("#main-panel", Static).update("\n".join(main_lines))
            right_panel = snapshot["right_panel"]
            action_lines = (
                summarize_tui_action_result(right_panel["last_action_result"])
                if right_panel["last_action_result"]
                else ["action=(none)"]
            )
            self.query_one("#right-panel", Static).update(
                "\n".join(
                    [
                        f"recent_run_id={right_panel['recent_run_id'] or '(none)'}",
                        f"plugin_count={right_panel['plugin_count']}",
                        f"registry_count={right_panel['registry_count']}",
                        f"ready_agents={right_panel['ready_agents']}",
                        f"missing_agents={len(right_panel['missing_agents'])}",
                        f"auth={right_panel['auth']}",
                        f"runtime_health={right_panel['runtime_health']['status']}",
                        f"runtime_summary={right_panel['runtime_health']['summary']}",
                        f"plugin_root_key={'set' if right_panel['plugin_verification']['public_key_configured'] else 'unset'}",
                        f"entitlement_count={right_panel['entitlement_count']}",
                        f"revocation_count={right_panel['revocation_count']}",
                        f"policy_count={right_panel['policy_count']}",
                        f"selected_chain_verdict={(right_panel['selected_evidence'] or {}).get('chain_verdict') or '(none)'}",
                        f"evidence_path={(right_panel['selected_evidence'] or {}).get('evidence_path') or '(none)'}",
                        f"protocol_export_path={(right_panel['selected_evidence'] or {}).get('protocol_export_path') or '(none)'}",
                        f"selected_surface={right_panel['selected_surface']}",
                        f"current_worker={(right_panel['selected_worker'] or {}).get('role') or '(none)'}",
                        f"recommended={right_panel['recommended_action']['command']}",
                        f"why={right_panel['recommended_action']['reason']}",
                        "",
                        *render_tui_agent_doctor_lines(
                            agents=right_panel["agents"],
                            missing_agents=right_panel["missing_agents"],
                        ),
                        "",
                        *render_tui_plugin_cache_lines(right_panel["plugins"]),
                        "",
                        *render_tui_plugin_verification_lines(
                            right_panel["plugin_verification"],
                            selected_plugin=right_panel["selected_plugin"],
                        ),
                        "",
                        *render_tui_plugin_entitlement_lines(
                            right_panel["plugin_entitlements"],
                            selected_plugin=right_panel["selected_plugin"],
                        ),
                        "",
                        *render_tui_plugin_revocation_lines(
                            right_panel["plugin_revocations"],
                            selected_plugin=right_panel["selected_plugin"],
                        ),
                        "",
                        *render_tui_plugin_policy_lines(
                            right_panel["plugin_policies"],
                            selected_plugin=right_panel["selected_plugin"],
                        ),
                        "",
                        *render_tui_plugin_configuration_lines(right_panel["selected_plugin"]),
                        "",
                        *render_tui_plugin_diagnostic_lines(
                            right_panel["plugin_diagnostics"],
                            selected_plugin=right_panel["selected_plugin"],
                        ),
                        "",
                        *render_tui_command_palette_lines(right_panel["command_palette"], limit=4),
                        "",
                        *action_lines,
                    ]
                )
            )
            actions = snapshot["bottom_panel"]["quick_actions"]
            selected_action_id = snapshot["bottom_panel"]["selected_action_id"]
            recommended_action = snapshot["bottom_panel"]["recommended_action"]
            self.query_one("#command-palette", Static).update(
                "Quick actions: "
                + " | ".join(
                    f"[{action['label']}]" if action["action_id"] == selected_action_id else action["label"]
                    for action in actions
                )
                + f"\nComposer default={snapshot['bottom_panel']['default_action']} selected={selected_action_id}"
                + f"\nRecommended next action: {recommended_action['command']} ({recommended_action['label']})"
                + f"\nWhy: {recommended_action['reason']}"
                + "\nBindings: a auto-refresh, j/k runs, u/i sessions, o/p plugins, s toggle surface, [/ ] actions, r refresh"
                + "\nSlash commands: "
                + " | ".join(entry["command"] for entry in snapshot["bottom_panel"]["command_palette"][:8])
            )
            self.query_one("#composer", Input).placeholder = (
                f"Type a message or slash command; enter uses {selected_action_id}"
            )

        def _poll_runtime(self) -> None:
            refresh_required = self._auto_refresh_enabled
            if self._pending_action is not None:
                self._last_action_result = read_tui_action_handle(self._pending_action)
                refresh_required = True
                if self._last_action_result.get("status") != "working":
                    self._apply_completed_pending_action()
            if refresh_required:
                self.action_refresh()

        def action_toggle_auto_refresh(self) -> None:
            self._auto_refresh_enabled = not self._auto_refresh_enabled
            self.action_refresh()

        def _apply_completed_pending_action(self) -> None:
            if self._pending_action is None or self._last_action_result is None:
                return
            (
                self._selected_run_id,
                self._selected_session_id,
                self._selected_surface,
            ) = apply_tui_action_result_selection(
                selected_run_id=self._selected_run_id,
                selected_session_id=self._selected_session_id,
                selected_surface=self._selected_surface,
                result=self._last_action_result,
            )
            if self._last_action_result.get("backend"):
                self._backend = str(self._last_action_result["backend"])
            if self._last_action_result.get("mode"):
                self._mode = str(self._last_action_result["mode"])
            if self._last_action_result.get("repo"):
                self._repo = Path(str(self._last_action_result["repo"])).resolve()
            self._pending_action = None

        def action_select_next_run(self) -> None:
            runs = self._snapshot()["sidebar"]["runs"]
            self._selected_run_id = select_tui_run_id(
                [str(run["run_id"]) for run in runs],
                self._selected_run_id,
                step=1,
            )
            self._selected_surface = "run"
            self.action_refresh()

        def action_select_previous_run(self) -> None:
            runs = self._snapshot()["sidebar"]["runs"]
            self._selected_run_id = select_tui_run_id(
                [str(run["run_id"]) for run in runs],
                self._selected_run_id,
                step=-1,
            )
            self._selected_surface = "run"
            self.action_refresh()

        def action_select_previous_session(self) -> None:
            sessions = self._snapshot()["sidebar"]["sessions"]
            self._selected_session_id = select_tui_run_id(
                [str(session["session_id"]) for session in sessions],
                self._selected_session_id,
                step=-1,
            )
            if self._selected_session_id:
                self._selected_surface = "chat"
            self.action_refresh()

        def action_select_next_session(self) -> None:
            sessions = self._snapshot()["sidebar"]["sessions"]
            self._selected_session_id = select_tui_run_id(
                [str(session["session_id"]) for session in sessions],
                self._selected_session_id,
                step=1,
            )
            if self._selected_session_id:
                self._selected_surface = "chat"
            self.action_refresh()

        def action_select_previous_plugin(self) -> None:
            plugins = self._snapshot()["right_panel"]["plugins"]
            self._selected_plugin_id = select_tui_run_id(
                [str(plugin["id"]) for plugin in plugins],
                self._selected_plugin_id,
                step=-1,
            )
            self.action_refresh()

        def action_select_next_plugin(self) -> None:
            plugins = self._snapshot()["right_panel"]["plugins"]
            self._selected_plugin_id = select_tui_run_id(
                [str(plugin["id"]) for plugin in plugins],
                self._selected_plugin_id,
                step=1,
            )
            self.action_refresh()

        def action_toggle_surface(self) -> None:
            snapshot = self._snapshot()
            if self._selected_surface == "run" and snapshot["sidebar"]["sessions"]:
                self._selected_surface = "chat"
            elif self._selected_surface == "chat" and snapshot["sidebar"]["runs"]:
                self._selected_surface = "run"
            self.action_refresh()

        def _cycle_action(self, step: int) -> None:
            actions = self._snapshot()["bottom_panel"]["quick_actions"]
            action_ids = [str(action["action_id"]) for action in actions]
            next_action = select_tui_run_id(action_ids, self._selected_action_id, step=step)
            if next_action:
                self._selected_action_id = next_action
            self.action_refresh()

        def action_select_next_action(self) -> None:
            self._cycle_action(1)

        def action_select_previous_action(self) -> None:
            self._cycle_action(-1)

        def on_input_submitted(self, event: Input.Submitted) -> None:
            submitted_value = event.value
            event.input.value = ""
            if self._pending_action is not None:
                pending_state = read_tui_action_handle(self._pending_action)
                if pending_state.get("status") == "working":
                    self._last_action_result = {
                        "action_id": self._pending_action.action_id,
                        "status": "working",
                        "detail": "another action is already running",
                    }
                    self.action_refresh()
                    return
                self._last_action_result = pending_state
                self._apply_completed_pending_action()
            self._pending_action = start_tui_composer_action(
                state_path=self._state_path,
                backend=self._backend,
                mode=self._mode,
                repo=self._repo,
                artifact_dir=self._artifact_dir,
                value=submitted_value,
                selected_action_id=self._selected_action_id,
                run_id=self._selected_run_id,
                session_id=self._selected_session_id,
                plugin_id=(self._snapshot()["right_panel"]["selected_plugin"] or {}).get("plugin_id"),
                plugin_version=(self._snapshot()["right_panel"]["selected_plugin"] or {}).get("version"),
                dry_run=self._dry_run,
                budget_seconds=self._budget_seconds,
            )
            self._last_action_result = read_tui_action_handle(self._pending_action)
            self.action_refresh()

    return SuperClawTextualApp


def run_tui(
    *,
    state_path: Path,
    backend: str,
    mode: str,
    repo: Path,
    artifact_dir: Path,
    selected_run_id: str | None = None,
    selected_plugin_id: str | None = None,
    budget_seconds: int = 60,
    dry_run: bool | None = None,
) -> None:
    app_class = _load_textual_app_class()
    app_class(
        state_path=state_path,
        backend=backend,
        mode=mode,
        repo=repo,
        artifact_dir=artifact_dir,
        selected_run_id=selected_run_id,
        selected_plugin_id=selected_plugin_id,
        budget_seconds=budget_seconds,
        dry_run=dry_run,
    ).run()
