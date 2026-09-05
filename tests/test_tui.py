import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from typer.testing import CliRunner

import superclaw.cli as cli_module
import superclaw.tui as tui_module
from superclaw.cli import app
from superclaw.models import EvidenceBundle, GoalSpec, RunSession, TaskGraph, WorkerResult
from superclaw.state import StateStore


def _write_cached_plugin(
    root: Path,
    *,
    plugin_id: str = "dev.superclaw.github-scanner",
    version: str = "0.2.0",
) -> Path:
    plugin_dir = root / plugin_id / version
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "superclaw-plugin.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "id": plugin_id,
                "version": version,
                "name": "GitHub Scanner",
                "acceptance": {"level": "L1"},
                "provenance": {
                    "package_digest": "sha256:" + ("1" * 64),
                    "signature": "ed25519:test-signature",
                },
                "configuration": {
                    "settings": [
                        {"name": "base_url", "type": "string", "description": "Target URL"},
                    ],
                    "secrets": [
                        {"name": "GITHUB_TOKEN", "env_name": "GITHUB_TOKEN", "required": True},
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    return plugin_dir


def _write_plugin_runtime_artifact(
    root: Path,
    *,
    artifact_id: str,
    plugin_id: str = "dev.superclaw.github-scanner",
    plugin_version: str = "0.2.0",
    tool_name: str = "scan_repo",
    status: str = "ok",
    started_at: str = "2026-06-04T00:00:00Z",
    finished_at: str = "2026-06-04T00:01:00Z",
    policy_decision: str = "allow",
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{artifact_id}.json"
    path.write_text(
        json.dumps(
            {
                "evidence_artifact_id": artifact_id,
                "plugin_id": plugin_id,
                "plugin_version": plugin_version,
                "tool_name": tool_name,
                "status": status,
                "started_at": started_at,
                "finished_at": finished_at,
                "policy_decision": policy_decision,
            }
        ),
        encoding="utf-8",
    )
    return path


def test_build_tui_snapshot_includes_backend_mode_and_selected_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="TUI goal", description="Inspect TUI snapshot"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.status = "queued"
    run.execution_context["backend_policy"] = "local"
    run.execution_context["repo_path"] = str(tmp_path)
    store.save_run(run)
    store.add_event(run.run_id, "run.started", {"run_id": run.run_id})

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )

    assert snapshot["top_bar"]["backend"] == "codex"
    assert snapshot["top_bar"]["mode"] == "chat"
    assert snapshot["top_bar"]["active_runs"] == 1
    assert "runtime_health" in snapshot["top_bar"]
    assert "runtime_health_summary" in snapshot["top_bar"]
    assert snapshot["sidebar"]["selected_run_id"] == run.run_id
    assert snapshot["main_panel"]["selected_run"]["run_id"] == run.run_id
    assert snapshot["main_panel"]["selected_run"]["cancellable"] is True
    assert snapshot["bottom_panel"]["default_action"] == "chat.direct"
    assert snapshot["bottom_panel"]["selected_action_id"] == "chat.direct"
    assert snapshot["right_panel"]["selected_evidence"]["run_id"] == run.run_id
    assert snapshot["main_panel"]["events"][0].startswith("run.started ")


def test_build_tui_quick_actions_cover_chat_delivery_and_local_run(tmp_path):
    actions = tui_module.build_tui_quick_actions(
        backend="codex",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )

    payload = {action.action_id: action.to_dict() for action in actions}
    assert payload["chat.direct"]["argv"][:3] == ["tui", "--dispatch-action", "chat.direct"]
    assert payload["delivery.start"]["parameters"]["dry_run"] is True
    assert payload["delivery.start.local"]["parameters"]["backend_override"] == "local"


def test_build_tui_quick_actions_include_selected_run_controls(tmp_path):
    actions = tui_module.build_tui_quick_actions(
        backend="codex",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        selected_run_id="run_123",
    )

    payload = {action.action_id: action.to_dict() for action in actions}
    assert payload["run.evidence.open"]["argv"][-1] == "run_123"
    assert payload["run.cancel"]["argv"][-1] == "run_123"
    assert payload["run.reconcile"]["argv"][-1] == "run_123"


def test_build_tui_command_palette_covers_help_config_and_run_actions():
    entries = tui_module.build_tui_command_palette(selected_run_id="run_123")

    payload = {entry.command: entry.to_dict() for entry in entries}
    assert payload["/snapshot"]["label"] == "Snapshot evidence"
    assert payload["/commands"]["label"] == "Command palette"
    assert payload["/help"]["category"] == "help"
    assert payload["/config set NAME VALUE"]["category"] == "config"
    assert payload["/plugin-setting <name> <value>"]["category"] == "plugin"
    assert payload["/plugin-secret <name> <value>"]["label"] == "Plugin secret"
    assert payload["/protocol"]["label"] == "Protocol export"
    assert payload["/resume"]["label"] == "Resume run"


def test_render_tui_run_events_formats_recent_events(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Events", description="Render recent events"))
    run = store.create_run(goal.goal_id, dry_run=True)
    store.add_event(run.run_id, "run.started", {"step": 1})
    store.add_event(run.run_id, "run.completed", {"step": 2})

    rendered = tui_module.render_tui_run_events(store, run.run_id, limit=1)

    assert rendered == ['run.completed {"step": 2}']


def test_render_tui_chat_messages_formats_recent_messages(tmp_path):
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("TUI chat")
    store.append_chat_message(session.session_id, "user", "Explain the architecture")
    store.append_chat_message(session.session_id, "assistant", "run_id=run_chat status=completed", run_id="run_chat")

    rendered = tui_module.render_tui_chat_messages(store.get_chat_session(session.session_id))

    assert rendered == [
        "user: Explain the architecture",
        "assistant run_id=run_chat: run_id=run_chat status=completed",
    ]


def test_build_tui_snapshot_defaults_to_chat_surface_when_chat_mode_has_session(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Chat session")
    store.append_chat_message(session.session_id, "user", "hello")
    store.append_chat_message(session.session_id, "assistant", "hi there", run_id="run_chat")

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )

    assert snapshot["sidebar"]["selected_session_id"] == session.session_id
    assert snapshot["sidebar"]["sessions"][0]["session_id"] == session.session_id
    assert snapshot["main_panel"]["kind"] == "chat"
    assert snapshot["main_panel"]["selected_session"]["session_id"] == session.session_id
    assert snapshot["main_panel"]["events"][0] == "user: hello"
    assert snapshot["right_panel"]["selected_surface"] == "chat"


def test_build_tui_snapshot_exposes_run_timeline_and_worker_log_tail(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Timeline goal", description="Inspect timeline"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.status = "queued"
    run.execution_context["backend_policy"] = "codex"
    run.execution_context["repo_path"] = str(tmp_path)
    run.task_graph = TaskGraph.from_goal(goal)
    first_task = run.task_graph.tasks[0]
    first_task.status = "running"
    run.task_attempts[first_task.task_id] = 1
    store.save_run(run)
    run.status = "running"
    store.save_run(run)

    transcript_path = tmp_path / "artifacts" / f"{run.run_id}-worker-transcript.json"
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.write_text(
        json.dumps(
            {
                "backend": "codex",
                "task_id": first_task.task_id,
                "role": first_task.role.value,
                "stdout_tail": "planning\nimplemented",
                "stderr_tail": "",
            }
        ),
        encoding="utf-8",
    )
    evidence = store.create_evidence(run.run_id)
    evidence.add_worker_result(
        WorkerResult(
            task_id=first_task.task_id,
            role=first_task.role.value,
            backend="codex",
            command="codex run",
            exit_code=0,
            output="implemented",
            duration_seconds=1.2,
            attempt_index=1,
            started_at=10.0,
            finished_at=11.2,
            transcript_artifact_id="artifact_transcript",
            transcript_path=str(transcript_path),
        )
    )
    store.save_evidence(evidence)

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        selected_run_id=run.run_id,
    )

    assert snapshot["main_panel"]["task_timeline"][0].startswith("explore task=")
    assert snapshot["main_panel"]["selected_worker"]["role"] == first_task.role.value
    assert snapshot["main_panel"]["selected_worker"]["status"] == "running"
    assert "planning" in "\n".join(snapshot["main_panel"]["selected_worker"]["log_tail"])
    assert snapshot["right_panel"]["selected_worker"]["backend"] == "codex"


def test_build_tui_snapshot_keeps_chat_surface_for_missing_session(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        selected_session_id="session_missing",
        selected_surface="chat",
    )

    assert snapshot["main_panel"]["kind"] == "chat"
    assert snapshot["main_panel"]["selected_session"] is None
    assert snapshot["main_panel"]["events"] == ["Selected session not found: session_missing"]


def test_build_tui_snapshot_exposes_agent_doctor_and_plugin_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    # The plugin-artifact root now defaults under the HOME data root (no longer cwd);
    # point it explicitly at the dir this test populates (parity with the state/cache
    # path env vars already pinned above).
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ARTIFACT_PATH", str(tmp_path / ".superclaw" / "artifacts" / "plugins"))
    monkeypatch.chdir(tmp_path)
    plugin_dir = _write_cached_plugin(tmp_path / "plugin-cache")
    _write_plugin_runtime_artifact(
        tmp_path / ".superclaw" / "artifacts" / "plugins",
        artifact_id="art_slow",
        status="ok",
    )
    _write_plugin_runtime_artifact(
        tmp_path / ".superclaw" / "artifacts" / "plugins",
        artifact_id="art_fail",
        status="sandbox_violation",
        started_at="2026-06-04T00:02:00Z",
        finished_at="2026-06-04T00:02:01Z",
        policy_decision="PLUGIN_SANDBOX_VIOLATION",
    )
    monkeypatch.setattr(
        tui_module,
        "build_agent_inventory",
        lambda **kwargs: [
            {
                "name": "codex",
                "available": True,
                "kind": "cli",
                "config_state": "/opt/homebrew/bin/codex",
                "configure": "/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
                "model_env": None,
            },
            {
                "name": "openclaw",
                "available": False,
                "kind": "cli",
                "config_state": "unset",
                "configure": "/config set SUPERCLAW_OPENCLAW_EXECUTABLE /path/to/openclaw",
                "model_env": "SUPERCLAW_OPENCLAW_MODEL",
                "model_state": "configured-default",
            },
        ],
    )
    monkeypatch.setattr(
        tui_module,
        "build_plugin_status_payload",
        lambda **kwargs: {
            "plugin_count": 1,
            "plugins": [
                {
                    "id": "dev.superclaw.hello-world",
                    "version": "0.1.0",
                    "name": "Hello World",
                    "path": str(plugin_dir),
                }
            ],
            "verification": {"public_key_configured": True},
            "entitlements": {"count": 0, "plugin_count": 0, "file": "/tmp/entitlements.json", "entries": []},
            "registry": {"count": 3},
            "governance": {
                "revocation_count": 1,
                "policy_count": 2,
                "revocations": [
                    {
                        "plugin_id": "dev.superclaw.hello-world",
                        "version": "0.1.0",
                        "package_digest": "sha256:" + ("2" * 64),
                        "reason": "broken_runtime",
                    }
                ],
                "policies": [
                    {
                        "plugin_id": "dev.superclaw.hello-world",
                        "version": "0.1.0",
                        "max_model_output_bytes": 2048,
                        "max_tool_timeout_ms": 8000,
                        "denylisted_permissions": ["network:external"],
                        "minimum_runtime_version": "0.1.0",
                        "risk_level": "high",
                        "requires_live_metering": True,
                        "secret_descriptors": [{"name": "API_TOKEN", "required": True}],
                    }
                ],
            },
        },
    )

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )

    assert snapshot["right_panel"]["plugin_count"] == 1
    assert snapshot["right_panel"]["registry_count"] == 3
    assert snapshot["right_panel"]["plugin_diagnostics"]["artifact_count"] == 2
    assert snapshot["right_panel"]["plugin_diagnostics"]["summary"]["sandbox_kills"] == 1
    assert snapshot["right_panel"]["plugin_verification"]["public_key_configured"] is True
    assert snapshot["right_panel"]["entitlement_count"] == 0
    assert snapshot["right_panel"]["selected_plugin"]["acceptance_level"] == "L1"
    assert snapshot["right_panel"]["selected_plugin"]["signature_present"] is True
    assert snapshot["right_panel"]["selected_plugin"]["package_digest"].startswith("sha256:")
    assert snapshot["right_panel"]["selected_plugin"]["revocation_status"] == "revoked"
    assert snapshot["right_panel"]["selected_plugin"]["policy_status"] == "attached"
    assert snapshot["right_panel"]["agents"][1]["name"] == "openclaw"
    assert snapshot["right_panel"]["missing_agents"][0]["configure"].startswith("/config set SUPERCLAW_OPENCLAW_EXECUTABLE")
    assert snapshot["right_panel"]["plugins"][0]["id"] == "dev.superclaw.hello-world"
    assert snapshot["bottom_panel"]["recommended_action"]["command"].startswith("/config set SUPERCLAW_OPENCLAW_EXECUTABLE")
    assert snapshot["right_panel"]["command_palette"][0]["command"] == "/chat <prompt>"
    assert snapshot["top_bar"]["runtime_health"] == "warn"
    assert "missing agents: openclaw" in snapshot["top_bar"]["runtime_health_summary"]
    assert snapshot["right_panel"]["runtime_health"]["status"] == "warn"


def test_render_tui_plugin_diagnostic_lines_filters_to_selected_plugin():
    lines = tui_module.render_tui_plugin_diagnostic_lines(
        {
            "artifact_count": 3,
            "summary": {"slow_calls": 1, "failures": 2, "sandbox_kills": 1},
            "findings": [
                {
                    "code": "PLUGIN_RUNTIME_SLOW_CALL",
                    "severity": "warning",
                    "plugin_id": "dev.superclaw.github-scanner",
                    "plugin_version": "0.2.0",
                    "tool_name": "scan_repo",
                },
                {
                    "code": "PLUGIN_RUNTIME_REPEATED_SANDBOX_KILLS",
                    "severity": "critical",
                    "plugin_id": "dev.superclaw.other",
                    "plugin_version": "0.1.0",
                    "tool_name": "other_tool",
                },
            ],
        },
        selected_plugin={"plugin_id": "dev.superclaw.github-scanner", "version": "0.2.0"},
    )

    assert lines[0] == "Plugin diagnostics:"
    assert "artifacts=3 findings=2" in lines[1]
    assert "selected=dev.superclaw.github-scanner@0.2.0 findings=1" in lines[3]
    assert "PLUGIN_RUNTIME_SLOW_CALL severity=warning tool=scan_repo" in lines[4]


def test_render_tui_plugin_entitlement_lines_show_selected_plugin_state():
    lines = tui_module.render_tui_plugin_entitlement_lines(
        {
            "count": 1,
            "plugin_count": 1,
            "file": "/tmp/entitlements.json",
            "entries": [
                {
                    "plugin_id": "dev.superclaw.github-scanner",
                    "version_range": ">=0.2.0,<0.3.0",
                    "entitlement_id": "ent_demo",
                    "expires_at": "2030-01-01T00:00:00Z",
                    "offline_grace_expires_at": "2030-01-02T00:00:00Z",
                }
            ],
        },
        selected_plugin={
            "plugin_id": "dev.superclaw.github-scanner",
            "version": "0.2.0",
            "entitlement_required": True,
            "entitlement_status": "synced",
            "entitlements": [
                {
                    "entitlement_id": "ent_demo",
                    "expires_at": "2030-01-01T00:00:00Z",
                    "offline_grace_expires_at": "2030-01-02T00:00:00Z",
                }
            ],
        },
    )

    assert lines[0] == "Plugin entitlements:"
    assert "local_count=1 plugin_count=1" in lines[1]
    assert "selected=dev.superclaw.github-scanner@0.2.0 required=yes status=synced" in lines[3]
    assert "entitlement ent_demo" in lines[4]


def test_render_tui_plugin_revocation_lines_show_selected_plugin_state():
    lines = tui_module.render_tui_plugin_revocation_lines(
        [
            {
                "plugin_id": "dev.superclaw.github-scanner",
                "version": "0.2.0",
                "package_digest": "sha256:" + ("2" * 64),
                "reason": "broken_runtime",
            }
        ],
        selected_plugin={
            "plugin_id": "dev.superclaw.github-scanner",
            "version": "0.2.0",
            "revocation_status": "revoked",
            "revocations": [
                {
                    "version": "0.2.0",
                    "package_digest": "sha256:" + ("2" * 64),
                    "reason": "broken_runtime",
                }
            ],
        },
    )

    assert lines[0] == "Plugin revocations:"
    assert "total=1" in lines[1]
    assert "selected=dev.superclaw.github-scanner@0.2.0 status=revoked" in lines[2]
    assert "revoked reason=broken_runtime" in lines[3]


def test_render_tui_plugin_verification_lines_show_selected_plugin_state():
    lines = tui_module.render_tui_plugin_verification_lines(
        {"public_key_configured": True},
        selected_plugin={
            "plugin_id": "dev.superclaw.github-scanner",
            "version": "0.2.0",
            "acceptance_level": "L1",
            "package_digest": "sha256:" + ("1" * 64),
            "signature_present": True,
        },
    )

    assert lines[0] == "Plugin verification:"
    assert lines[1] == "root_key=set"
    assert "selected=dev.superclaw.github-scanner@0.2.0 acceptance=L1 signature=present" in lines[2]
    assert lines[3].startswith("digest=sha256:")


def test_render_tui_plugin_policy_lines_show_selected_plugin_state():
    lines = tui_module.render_tui_plugin_policy_lines(
        [
            {
                "plugin_id": "dev.superclaw.github-scanner",
                "version": "0.2.0",
                "max_model_output_bytes": 1024,
                "max_tool_timeout_ms": 5000,
                "denylisted_permissions": ["network:external"],
                "minimum_runtime_version": "0.1.0",
                "risk_level": "high",
                "requires_live_metering": True,
                "secret_descriptors": [{"name": "API_TOKEN", "required": True}],
            }
        ],
        selected_plugin={
            "plugin_id": "dev.superclaw.github-scanner",
            "version": "0.2.0",
            "policy_status": "attached",
            "policies": [
                {
                    "max_model_output_bytes": 1024,
                    "max_tool_timeout_ms": 5000,
                    "denylisted_permissions": ["network:external"],
                    "minimum_runtime_version": "0.1.0",
                    "risk_level": "high",
                    "requires_live_metering": True,
                    "secret_descriptors": [{"name": "API_TOKEN", "required": True}],
                }
            ],
        },
    )

    assert lines[0] == "Plugin runtime policy:"
    assert "total=1" in lines[1]
    assert "selected=dev.superclaw.github-scanner@0.2.0 status=attached" in lines[2]
    assert "min_runtime=0.1.0 max_output=1024 timeout=5000" in lines[3]
    assert "risk=high metering=yes denylist=network:external" in lines[4]
    assert "secret_descriptors=API_TOKEN" in lines[5]


def test_recommend_tui_next_action_prioritizes_human_gate_and_failed_evidence():
    waiting = tui_module.recommend_tui_next_action(
        mode="delivery",
        selected_run={"status": "WAITING_FOR_HUMAN_GATE"},
        selected_evidence=None,
        selected_session=None,
        missing_agents=[],
        selected_plugin_configuration=None,
    )
    failed = tui_module.recommend_tui_next_action(
        mode="delivery",
        selected_run={"status": "failed"},
        selected_evidence={"failed_finding_count": 2},
        selected_session=None,
        missing_agents=[],
        selected_plugin_configuration=None,
    )

    assert waiting["command"] == "/resume"
    assert failed["command"] == "/evidence"


def test_recommend_tui_next_action_prefers_protocol_after_clean_completion():
    recommended = tui_module.recommend_tui_next_action(
        mode="delivery",
        selected_run={"status": "completed"},
        selected_evidence={"failed_finding_count": 0},
        selected_session=None,
        missing_agents=[],
        selected_plugin_configuration=None,
    )

    assert recommended["command"] == "/protocol"


def test_recommend_tui_next_action_prefers_missing_plugin_configuration():
    recommended = tui_module.recommend_tui_next_action(
        mode="chat",
        selected_run=None,
        selected_evidence=None,
        selected_session=None,
        missing_agents=[],
        selected_plugin_configuration={
            "configuration": {
                "settings": [{"name": "base_url", "configured": False}],
                "secrets": [{"name": "GITHUB_TOKEN", "required": True, "configured": False}],
            }
        },
    )

    assert recommended["command"] == "/plugin-setting base_url <value>"


def test_resolve_tui_default_action_matches_mode():
    assert tui_module.resolve_tui_default_action("chat") == "chat.direct"
    assert tui_module.resolve_tui_default_action("auto") == "chat.direct"
    assert tui_module.resolve_tui_default_action("delivery") == "delivery.start"


def test_select_tui_run_id_cycles():
    run_ids = ["run_1", "run_2", "run_3"]

    assert tui_module.select_tui_run_id(run_ids, "run_1", step=1) == "run_2"
    assert tui_module.select_tui_run_id(run_ids, "run_1", step=-1) == "run_3"
    assert tui_module.select_tui_run_id(run_ids, None, step=1) == "run_1"


def test_parse_tui_composer_input_routes_default_and_slash_commands():
    default_command = tui_module.parse_tui_composer_input(value="Fix failing tests", mode="delivery")
    slash_command = tui_module.parse_tui_composer_input(value="/local repair this bug", mode="chat")
    empty_promptless = tui_module.parse_tui_composer_input(value="/refresh", mode="chat", selected_action_id="run.cancel")
    snapshot_command = tui_module.parse_tui_composer_input(value="/snapshot", mode="chat")
    help_command = tui_module.parse_tui_composer_input(value="/help", mode="chat")
    protocol_command = tui_module.parse_tui_composer_input(value="/protocol", mode="chat")
    config_command = tui_module.parse_tui_composer_input(
        value="/config set SUPERCLAW_HERMES_EXECUTABLE /tmp/hermes",
        mode="chat",
    )
    plugin_setting_command = tui_module.parse_tui_composer_input(
        value="/plugin-setting base_url https://api.github.com",
        mode="chat",
    )
    plugin_secret_command = tui_module.parse_tui_composer_input(
        value="/plugin-secret GITHUB_TOKEN super-secret",
        mode="chat",
    )
    plugin_secret_clear_command = tui_module.parse_tui_composer_input(
        value="/plugin-secret-clear GITHUB_TOKEN",
        mode="chat",
    )

    assert default_command.action_id == "delivery.start"
    assert default_command.prompt == "Fix failing tests"
    assert slash_command.action_id == "delivery.start.local"
    assert slash_command.backend_override == "local"
    assert slash_command.prompt == "repair this bug"
    assert empty_promptless.action_id == "ui.refresh"
    assert snapshot_command.action_id == "ui.snapshot.export"
    assert help_command.action_id == "ui.commands"
    assert protocol_command.action_id == "run.protocol.export"
    assert config_command.action_id == "config.set"
    assert config_command.config_name == "SUPERCLAW_HERMES_EXECUTABLE"
    assert config_command.config_value == "/tmp/hermes"
    assert plugin_setting_command.action_id == "plugin.setting.set"
    assert plugin_setting_command.plugin_config_name == "base_url"
    assert plugin_setting_command.plugin_config_value == "https://api.github.com"
    assert plugin_secret_command.action_id == "plugin.secret.set"
    assert plugin_secret_command.plugin_config_name == "GITHUB_TOKEN"
    assert plugin_secret_command.plugin_config_value == "super-secret"
    assert plugin_secret_clear_command.action_id == "plugin.secret.clear"
    assert plugin_secret_clear_command.plugin_config_name == "GITHUB_TOKEN"


def test_start_tui_composer_action_reports_working_then_completion(monkeypatch, tmp_path):
    gate = threading.Event()

    def _fake_dispatch(**kwargs):
        gate.wait(timeout=1.0)
        return {"action_id": "chat.direct", "status": "completed", "session_id": "session_1"}

    monkeypatch.setattr(tui_module, "dispatch_tui_composer", _fake_dispatch)
    handle = tui_module.start_tui_composer_action(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        value="hello",
    )

    working = tui_module.read_tui_action_handle(handle)
    assert working["status"] == "working"
    assert working["action_id"] == "chat.direct"
    gate.set()
    handle.thread.join(timeout=1.0)
    completed = tui_module.read_tui_action_handle(handle)
    assert completed["status"] == "completed"
    assert completed["session_id"] == "session_1"


def test_start_tui_composer_action_converts_exceptions_to_failed_result(monkeypatch, tmp_path):
    def _fake_dispatch(**kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(tui_module, "dispatch_tui_composer", _fake_dispatch)
    handle = tui_module.start_tui_composer_action(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        value="hello",
    )

    handle.thread.join(timeout=1.0)
    failed = tui_module.read_tui_action_handle(handle)
    assert failed["status"] == "failed"
    assert failed["failure_reason"] == "RuntimeError: boom"


def test_apply_tui_action_result_selection_updates_surface_and_ids():
    chat_run = tui_module.apply_tui_action_result_selection(
        selected_run_id="run_1",
        selected_session_id=None,
        selected_surface="run",
        result={"action_id": "chat.direct", "run_id": "run_2", "session_id": "session_1"},
    )
    delivery_run = tui_module.apply_tui_action_result_selection(
        selected_run_id="run_1",
        selected_session_id="session_1",
        selected_surface="chat",
        result={"action_id": "delivery.start", "run_id": "run_3"},
    )

    assert chat_run == ("run_2", "session_1", "chat")
    assert delivery_run == ("run_3", "session_1", "run")


def test_summarize_tui_action_result_includes_working_fields():
    lines = tui_module.summarize_tui_action_result(
        {
            "action_id": "chat.direct",
            "status": "working",
            "elapsed_seconds": 0.5,
            "submitted_value": "hello",
        }
    )

    assert "elapsed_seconds=0.5" in lines
    assert "submitted_value=hello" in lines


def test_cli_tui_dump_snapshot_outputs_json(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="CLI snapshot", description="Dump TUI snapshot"))
    run = store.create_run(goal.goal_id, dry_run=True)
    store.save_run(run)
    runner = CliRunner()

    result = runner.invoke(app, ["tui", "--backend", "hermes", "--mode", "delivery", "--repo", str(tmp_path), "--dump-snapshot"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["top_bar"]["backend"] == "hermes"
    assert payload["top_bar"]["mode"] == "delivery"
    assert payload["sidebar"]["selected_run_id"] == run.run_id


def test_cli_tui_dump_events_renders_run_events(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="CLI events", description="Dump TUI events"))
    run = store.create_run(goal.goal_id, dry_run=True)
    store.add_event(run.run_id, "run.started", {"backend": "local"})
    runner = CliRunner()

    result = runner.invoke(app, ["tui", "--dump-events", run.run_id])

    assert result.exit_code == 0, result.output
    assert 'run.started {"backend": "local"}' in result.output


def test_cli_tui_reports_bootstrap_error(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    def _raise(
        *,
        state_path,
        backend,
        mode,
        repo,
        artifact_dir,
        selected_run_id=None,
        selected_plugin_id=None,
        budget_seconds=60,
        dry_run=None,
    ):
        raise tui_module.TuiBootstrapError("textual runtime is unavailable; reinstall SuperClaw dependencies and retry")

    monkeypatch.setattr(cli_module, "run_tui", _raise)
    result = runner.invoke(app, ["tui"])

    assert result.exit_code == 1
    assert "textual runtime is unavailable" in result.output


def test_cli_tui_invokes_runner_with_resolved_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    (tmp_path / "shell-config.json").write_text(
        json.dumps({"backend": "codex", "mode": "chat", "repo": str(tmp_path)}),
        encoding="utf-8",
    )
    seen = {}
    runner = CliRunner()

    def _fake_run_tui(**kwargs):
        seen.update(kwargs)

    monkeypatch.setattr(cli_module, "run_tui", _fake_run_tui)
    result = runner.invoke(app, ["tui"])

    assert result.exit_code == 0, result.output
    assert seen["backend"] == "codex"
    assert seen["mode"] == "chat"
    assert seen["repo"] == tmp_path.resolve()
    assert seen["state_path"] == tmp_path / "state.db"
    assert seen["budget_seconds"] == 60
    assert seen["dry_run"] is None


def test_build_tui_evidence_summary_reports_failure_reason(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Evidence", description="Inspect evidence"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.execution_context["artifact_dir"] = str(tmp_path / "artifacts")
    store.save_run(run)
    evidence = store.create_evidence(run.run_id)
    evidence.add_finding("worker_execution", False, "backend fail", "high")
    store.save_evidence(evidence)

    summary = tui_module.build_tui_evidence_summary(store, run.run_id, artifact_dir=tmp_path / "artifacts")

    assert summary["failed_finding_count"] == 1
    assert summary["failure_reason"] == "worker_execution: backend fail"
    assert Path(summary["evidence_path"]).parts[-2:] == (run.run_id, "evidence.json")
    assert Path(summary["protocol_export_path"]).parts[-2:] == (run.run_id, "delivery-protocol.json")
    assert summary["protocol_export_command"] == f"/protocol {run.run_id}"
    assert summary["protocol_adapter_name"] == "clawhunt.delivery_protocol.v1"


def test_dispatch_tui_action_starts_chat_turn(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    store = StateStore(tmp_path / "state.db")

    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    class FakeOrchestrator:
        def __init__(self, store):
            self.store = store

        @classmethod
        def from_path(cls, path):
            return cls(StateStore(path))

        def run_goal(self, **kwargs):
            session = RunSession(goal_id="goal_chat", run_id="run_chat", status="completed")
            session.execution_context["artifact_dir"] = str(kwargs["artifact_dir"])
            evidence = EvidenceBundle(run_id="run_chat")
            return FakeRunResult(session=session, evidence=evidence)

    monkeypatch.setattr(tui_module, "SuperClawOrchestrator", FakeOrchestrator)
    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="chat.direct",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        prompt="Explain the run",
        dry_run=True,
    )

    assert response["status"] == "completed"
    assert response["run_id"] == "run_chat"
    assert store.list_chat_sessions()[0].messages[0].content == "Explain the run"


def test_dispatch_tui_action_protocol_export_writes_delivery_protocol_payload(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Protocol Export", description="Ship a delivery payload"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.execution_context["artifact_dir"] = str(tmp_path / "artifacts")
    store.save_run(run)
    evidence = store.create_evidence(run.run_id)
    store.save_evidence(evidence)

    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.protocol.export",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id=run.run_id,
    )

    export_path = (tmp_path / "artifacts" / run.run_id / "delivery-protocol.json").resolve()
    payload = json.loads(export_path.read_text(encoding="utf-8"))

    assert response["status"] == "completed"
    assert response["protocol_export_path"] == str(export_path)
    assert response["protocol_adapter_name"] == "clawhunt.delivery_protocol.v1"
    assert payload["adapter_name"] == "clawhunt.delivery_protocol.v1"
    assert payload["request_json"]["agent_package_manifest"]["name"] == "Protocol Export"


def test_dispatch_tui_action_protocol_export_reports_missing_evidence(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Protocol Export", description="Ship a delivery payload"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.execution_context["artifact_dir"] = str(tmp_path / "artifacts")
    store.save_run(run)

    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.protocol.export",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id=run.run_id,
    )

    assert response["status"] == "failed"
    assert response["failure_reason"] == f"evidence not found for run: {run.run_id}"


def test_dispatch_tui_action_chat_direct_reuses_selected_session(monkeypatch, tmp_path):
    store = StateStore(tmp_path / "state.db")
    existing_session = store.create_chat_session("Existing")
    store.append_chat_message(existing_session.session_id, "user", "first")

    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    class FakeOrchestrator:
        def __init__(self, store):
            self.store = store

        @classmethod
        def from_path(cls, path):
            return cls(StateStore(path))

        def run_goal(self, **kwargs):
            session = RunSession(goal_id="goal_chat", run_id="run_chat_2", status="completed")
            session.execution_context["artifact_dir"] = str(kwargs["artifact_dir"])
            evidence = EvidenceBundle(run_id="run_chat_2")
            return FakeRunResult(session=session, evidence=evidence)

    monkeypatch.setattr(tui_module, "SuperClawOrchestrator", FakeOrchestrator)
    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="chat.direct",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        prompt="second",
        session_id=existing_session.session_id,
        dry_run=True,
    )

    updated_session = store.get_chat_session(existing_session.session_id)
    assert response["session_id"] == existing_session.session_id
    assert [message.content for message in updated_session.messages] == [
        "first",
        "second",
        "run_id=run_chat_2 status=completed chain_verdict=CONTROL_PLANE_READY",
    ]


def test_dispatch_tui_action_controls_run_and_evidence(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Run", description="Control it"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.status = "queued"
    run.execution_context["artifact_dir"] = str(tmp_path / "artifacts")
    store.save_run(run)
    evidence = store.create_evidence(run.run_id)
    evidence.add_finding("worker_execution", False, "still failing", "high")
    store.save_evidence(evidence)

    evidence_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.evidence.open",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id=run.run_id,
    )
    cancel_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.cancel",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id=run.run_id,
    )

    assert evidence_response["evidence"]["failure_reason"] == "worker_execution: still failing"
    assert cancel_response["accepted"] is True
    assert store.get_run(run.run_id).status == "cancelled"


def test_dispatch_tui_action_commands_returns_palette_and_recommendation(tmp_path):
    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="ui.commands",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )

    assert response["status"] == "completed"
    assert response["command_palette"][0]["command"] == "/chat <prompt>"
    assert "command" in response["recommended_action"]


def test_dispatch_tui_action_reconcile_and_resume(monkeypatch, tmp_path):
    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    class FakeOrchestrator:
        def __init__(self, store):
            self.store = store

        @classmethod
        def from_path(cls, path):
            return cls(StateStore(path))

        def reconcile_run(self, run_id):
            return type(
                "ReconcileResult",
                (),
                {
                    "run_id": run_id,
                    "previous_status": "running",
                    "status": "queued",
                    "classification": "resumable",
                    "resumable": True,
                    "detail": "stale run marked queued for deterministic resume",
                },
            )()

        def resume_run(self, run_id):
            session = RunSession(goal_id="goal_resume", run_id=run_id, status="completed")
            session.execution_context["artifact_dir"] = str(tmp_path / "artifacts")
            evidence = EvidenceBundle(run_id=run_id)
            return FakeRunResult(session=session, evidence=evidence)

    monkeypatch.setattr(tui_module, "SuperClawOrchestrator", FakeOrchestrator)
    reconcile_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.reconcile",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id="run_resume",
    )
    resume_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="run.resume",
        backend="codex",
        mode="delivery",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id="run_resume",
    )

    assert reconcile_response["classification"] == "resumable"
    assert reconcile_response["resumable"] is True
    assert resume_response["status"] == "completed"
    assert resume_response["run_id"] == "run_resume"


def test_dispatch_tui_composer_uses_selected_action_for_empty_submit(monkeypatch, tmp_path):
    seen = {}

    def _fake_dispatch(**kwargs):
        seen.update(kwargs)
        return {"action_id": kwargs["action_id"], "status": "completed"}

    monkeypatch.setattr(tui_module, "dispatch_tui_action", _fake_dispatch)
    result = tui_module.dispatch_tui_composer(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        value="",
        selected_action_id="run.evidence.open",
        run_id="run_123",
    )

    assert result["action_id"] == "run.evidence.open"
    assert seen["run_id"] == "run_123"


def test_dispatch_tui_composer_config_set_persists_and_applies_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    # config.set writes into live os.environ; delenv alone records no undo
    # entry when the variable starts unset, leaking /tmp/hermes to later
    # tests. setenv first snapshots the true pre-test value for teardown.
    monkeypatch.setenv("SUPERCLAW_HERMES_EXECUTABLE", "superclaw-test-env-guard")
    monkeypatch.delenv("SUPERCLAW_HERMES_EXECUTABLE")

    result = tui_module.dispatch_tui_composer(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        value="/config set SUPERCLAW_HERMES_EXECUTABLE /tmp/hermes",
    )

    assert result["action_id"] == "config.set"
    assert result["status"] == "completed"
    assert result["config_name"] == "SUPERCLAW_HERMES_EXECUTABLE"
    assert result["display_value"] == "/tmp/hermes"
    assert result["persisted"] is True
    assert os.environ["SUPERCLAW_HERMES_EXECUTABLE"] == "/tmp/hermes"


def test_build_tui_snapshot_exposes_selected_plugin_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin-config.json"))
    plugin_dir = _write_cached_plugin(tmp_path / "plugin-cache")
    monkeypatch.setattr(tui_module, "build_agent_inventory", lambda **kwargs: [])
    tui_module.set_plugin_setting("dev.superclaw.github-scanner", "base_url", "https://api.github.com")
    monkeypatch.setattr(
        tui_module,
        "build_plugin_status_payload",
        lambda **kwargs: {
            "plugin_count": 1,
            "plugins": [
                {
                    "id": "dev.superclaw.github-scanner",
                    "version": "0.2.0",
                    "name": "GitHub Scanner",
                    "path": str(plugin_dir),
                }
            ],
            "verification": {"public_key_configured": True},
            "entitlements": {"count": 0, "plugin_count": 0, "file": "/tmp/entitlements.json", "entries": []},
            "registry": {"count": 1},
            "governance": {"revocation_count": 0, "policy_count": 0, "revocations": [], "policies": []},
        },
    )

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        selected_plugin_id="dev.superclaw.github-scanner",
    )

    selected_plugin = snapshot["right_panel"]["selected_plugin"]
    assert selected_plugin["plugin_id"] == "dev.superclaw.github-scanner"
    assert selected_plugin["acceptance_level"] == "L1"
    assert selected_plugin["entitlement_status"] == "not-required"
    assert selected_plugin["revocation_status"] == "clean"
    assert selected_plugin["policy_status"] == "none"
    assert selected_plugin["configuration"]["settings"][0]["configured"] is True
    assert selected_plugin["configuration"]["settings"][0]["value"] == "https://api.github.com"
    assert selected_plugin["configuration"]["secrets"][0]["configured"] is False
    assert snapshot["bottom_panel"]["recommended_action"]["command"] == "/plugin-secret GITHUB_TOKEN <value>"


def test_build_tui_snapshot_tolerates_non_mapping_plugin_commerce(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    plugin_dir = _write_cached_plugin(tmp_path / "plugin-cache")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["commerce"] = "free"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(tui_module, "build_agent_inventory", lambda **kwargs: [])
    monkeypatch.setattr(
        tui_module,
        "build_plugin_status_payload",
        lambda **kwargs: {
            "plugin_count": 1,
            "plugins": [
                {
                    "id": "dev.superclaw.github-scanner",
                    "version": "0.2.0",
                    "name": "GitHub Scanner",
                    "path": str(plugin_dir),
                }
            ],
            "verification": {"public_key_configured": True},
            "entitlements": {"count": 0, "plugin_count": 0, "file": "/tmp/entitlements.json", "entries": []},
            "registry": {"count": 1},
            "governance": {"revocation_count": 0, "policy_count": 0, "revocations": [], "policies": []},
        },
    )

    snapshot = tui_module.build_tui_snapshot(
        state_path=tmp_path / "state.db",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        selected_plugin_id="dev.superclaw.github-scanner",
    )

    assert snapshot["right_panel"]["selected_plugin"]["entitlement_status"] == "not-required"


def test_dispatch_tui_action_plugin_setting_and_secret_controls(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin-config.json"))

    setting_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="plugin.setting.set",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        plugin_id="dev.superclaw.github-scanner",
        plugin_config_name="base_url",
        plugin_config_value="https://api.github.com",
    )
    secret_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="plugin.secret.set",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        plugin_id="dev.superclaw.github-scanner",
        plugin_version="0.2.0",
        plugin_config_name="GITHUB_TOKEN",
        plugin_config_value="super-secret",
    )
    clear_response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="plugin.secret.clear",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        plugin_id="dev.superclaw.github-scanner",
        plugin_config_name="GITHUB_TOKEN",
    )

    assert setting_response["status"] == "completed"
    assert setting_response["setting"] == "base_url"
    assert secret_response["status"] == "completed"
    assert secret_response["secret"] == "GITHUB_TOKEN"
    assert clear_response["status"] == "completed"
    assert clear_response["configured"] is False
    payload = json.loads((tmp_path / "plugin-config.json").read_text(encoding="utf-8"))
    assert payload["plugins"]["dev.superclaw.github-scanner"]["settings"]["base_url"]["value"] == "https://api.github.com"
    assert "GITHUB_TOKEN" not in payload["plugins"]["dev.superclaw.github-scanner"]["secrets"]


def test_dispatch_tui_action_snapshot_export_writes_artifact(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="Snapshot export", description="Record cockpit evidence"))
    run = store.create_run(goal.goal_id, dry_run=True)
    run.status = "queued"
    run.execution_context["backend_policy"] = "local"
    run.execution_context["repo_path"] = str(tmp_path)
    store.save_run(run)

    response = tui_module.dispatch_tui_action(
        state_path=tmp_path / "state.db",
        action_id="ui.snapshot.export",
        backend="codex",
        mode="chat",
        repo=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        run_id=run.run_id,
    )

    snapshot_path = Path(response["snapshot_path"])
    assert response["status"] == "completed"
    assert snapshot_path.exists()
    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert payload["sidebar"]["selected_run_id"] == run.run_id
    assert payload["top_bar"]["backend"] == "codex"


def test_cli_tui_dump_snapshot_accepts_plugin_id(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    runner = CliRunner()
    monkeypatch.setattr(cli_module, "_configured_shell_backend", lambda: None)

    def _fake_snapshot(**kwargs):
        assert kwargs["selected_plugin_id"] == "dev.superclaw.github-scanner"
        return {"top_bar": {"backend": kwargs["backend"]}}

    monkeypatch.setattr(cli_module, "build_tui_snapshot", _fake_snapshot)
    result = runner.invoke(app, ["tui", "--backend", "claude", "--plugin-id", "dev.superclaw.github-scanner", "--dump-snapshot"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["top_bar"]["backend"] == "claude"


def test_cli_tui_snapshot_file_writes_json(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    output_path = tmp_path / "snapshots" / "tui.json"

    def _fake_snapshot(**kwargs):
        return {
            "top_bar": {"backend": kwargs["backend"], "mode": kwargs["mode"]},
            "sidebar": {"selected_run_id": "run_1", "selected_session_id": "session_1"},
        }

    monkeypatch.setattr(cli_module, "build_tui_snapshot", _fake_snapshot)
    result = runner.invoke(app, ["tui", "--backend", "codex", "--snapshot-file", str(output_path)])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "completed"
    assert Path(payload["snapshot_path"]) == output_path.resolve()
    assert json.loads(output_path.read_text(encoding="utf-8"))["top_bar"]["backend"] == "codex"


def test_summarize_tui_action_result_prioritizes_failure_reason():
    lines = tui_module.summarize_tui_action_result(
        {
            "action_id": "delivery.start",
            "status": "failed",
            "run_id": "run_1",
            "failure_reason": "worker_execution: failed",
        }
    )

    assert lines[0] == "action=delivery.start"
    assert "failure_reason=worker_execution: failed" in lines


def test_cli_tui_dispatch_action_outputs_json(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    def _fake_dispatch(**kwargs):
        return {"action_id": kwargs["action_id"], "status": "completed", "run_id": "run_dispatch"}

    monkeypatch.setattr(cli_module, "dispatch_tui_action", _fake_dispatch)
    result = runner.invoke(app, ["tui", "--dispatch-action", "delivery.start", "--message", "Fix tests"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["action_id"] == "delivery.start"
    assert payload["run_id"] == "run_dispatch"


def test_cli_tui_submit_composer_outputs_json(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    def _fake_submit(**kwargs):
        return {"action_id": "chat.direct", "status": "completed", "session_id": "session_1"}

    monkeypatch.setattr(cli_module, "dispatch_tui_composer", _fake_submit)
    result = runner.invoke(app, ["tui", "--submit-composer", "Explain this architecture"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["action_id"] == "chat.direct"
    assert payload["session_id"] == "session_1"
