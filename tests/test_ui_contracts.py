import json
from pathlib import Path

from superclaw.backends import BackendAvailability
from superclaw.ui_contracts import (
    build_agent_inventory,
    build_plugin_status_payload,
    build_tui_acceptance_payload,
    build_desktop_dependency_targets,
    build_desktop_onboarding_payload,
    build_runtime_status_payload,
    build_shell_status_lines,
)


class _FakeBackend:
    def __init__(self, availability: BackendAvailability) -> None:
        self._availability = availability

    def available(self) -> BackendAvailability:
        return self._availability

    def permission_presets(self):
        from superclaw.permissions import PresetRealization, make_presets

        return make_presets(
            ask=PresetRealization("fake-ask", False, "perm.note.fake.ask"),
            allow=PresetRealization("fake-allow", False, "perm.note.fake.allow"),
        )


def test_build_agent_inventory_uses_config_payload_state():
    inventory = build_agent_inventory(
        backends={
            "codex": _FakeBackend(
                BackendAvailability(
                    name="codex",
                    available=True,
                    executable="/opt/codex",
                    version="codex 1.0.0",
                )
            )
        },
        config_payload={
            "entries": [
                {
                    "name": "SUPERCLAW_CODEX_EXECUTABLE",
                    "display_value": "/custom/codex",
                    "source": "persisted",
                }
            ]
        },
    )

    assert inventory == [
        {
            "name": "codex",
            "available": True,
            "executable": "/opt/codex",
            "version": "codex 1.0.0",
            "reason": None,
            "kind": "cli",
            "configure": "/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
            "config_env": "SUPERCLAW_CODEX_EXECUTABLE",
            "model_env": "SUPERCLAW_CODEX_MODEL",
            "config_state": "/custom/codex",
            "config_source": "persisted",
            "model_state": "unset",
            "model_source": "default",
            "label": "Codex CLI",
            "supports_model_selection": True,
            "default_model": "configured-default",
            "suggested_models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
            "supports_effort_selection": True,
            "effort_levels": ["low", "medium", "high", "xhigh"],
            "effort_input_mode": "select",
            "default_effort": None,
            "uses_relay_packages": False,
            "chat_capable": False,
            "chat_tier": "oneshot",
            "maturity": "stable",
            "strengths": "Strong autonomous coding and multi-file refactors via codex exec; single agent (no native sub-spawn).",
            "harness": "codex",
            "task_spawn": False,
            "parallel_agents": True,
            "permission_presets": {
                "ask": {"native": "fake-ask", "interactive": False, "note_key": "perm.note.fake.ask", "preset_driven": True},
                "allow": {"native": "fake-allow", "interactive": False, "note_key": "perm.note.fake.allow", "preset_driven": True},
            },
        }
    ]


def test_inventory_resolves_anthropic_agent_model_across_env_fallback_chain(monkeypatch):
    """anthropic-agent resolves model_override -> SUPERCLAW_ANTHROPIC_AGENT_MODEL
    -> SUPERCLAW_ANTHROPIC_MODEL -> claude-opus-4-8. model_state must mirror that
    chain so a surface shows the model that ACTUALLY runs, not the primary env's
    baked default. Regression guard: a surface reading only the primary env would
    show opus even when SUPERCLAW_ANTHROPIC_MODEL is the running model."""
    from superclaw.backends import AnthropicAgentBackend

    backend = {
        "anthropic-agent": _FakeBackend(
            BackendAvailability(name="anthropic-agent", available=True)
        )
    }

    def model_state_for(entries):
        return build_agent_inventory(backends=backend, config_payload={"entries": entries})[0]

    def entry(name, value, configured):
        return {
            "name": name,
            "display_value": value,
            "source": "environment" if configured else "default",
            "configured": configured,
        }

    # Only the SECONDARY env is configured -> model_state follows it, not opus.
    item = model_state_for(
        [
            entry("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "claude-opus-4-8", False),
            entry("SUPERCLAW_ANTHROPIC_MODEL", "claude-sonnet-4-6", True),
        ]
    )
    assert item["model_state"] == "claude-sonnet-4-6"
    assert item["model_source"] == "environment"

    # Primary env wins over the secondary (mirrors the backend's `or` order).
    item = model_state_for(
        [
            entry("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "claude-haiku-4-5", True),
            entry("SUPERCLAW_ANTHROPIC_MODEL", "claude-sonnet-4-6", True),
        ]
    )
    assert item["model_state"] == "claude-haiku-4-5"

    # Neither configured -> the baked default (primary entry's display_value).
    item = model_state_for(
        [
            entry("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "claude-opus-4-8", False),
            entry("SUPERCLAW_ANTHROPIC_MODEL", "claude-opus-4-8", False),
        ]
    )
    assert item["model_state"] == "claude-opus-4-8"
    assert item["model_source"] == "default"

    # Behavioral pin: the contract chain order is the backend's real resolution.
    for var in ("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "SUPERCLAW_ANTHROPIC_MODEL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SUPERCLAW_ANTHROPIC_MODEL", "claude-sonnet-4-6")
    assert AnthropicAgentBackend().model == "claude-sonnet-4-6"
    monkeypatch.setenv("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "claude-haiku-4-5")
    assert AnthropicAgentBackend().model == "claude-haiku-4-5"


def test_inventory_folds_harness_capabilities_and_strengths():
    # P0 consolidation: the inventory is the SINGLE capability fact source —
    # harness sub-spawn / parallelism bits fold in here, no second descriptor.
    inv = {
        item["name"]: item
        for item in build_agent_inventory(
            backends={
                "codex": _FakeBackend(BackendAvailability(name="codex", available=True)),
                "claude": _FakeBackend(BackendAvailability(name="claude", available=True)),
                "http": _FakeBackend(BackendAvailability(name="http", available=False)),
                "gemini": _FakeBackend(BackendAvailability(name="gemini", available=False)),
            },
            config_payload={"entries": []},
        )
    }
    # codex exec is a single agent (no native sub-spawn) but runs parallel turns.
    assert inv["codex"]["harness"] == "codex"
    assert inv["codex"]["task_spawn"] is False
    assert inv["codex"]["parallel_agents"] is True
    # claude-code spawns sub-agents natively (Task tool).
    assert inv["claude"]["harness"] == "claude-code"
    assert inv["claude"]["task_spawn"] is True
    # A backend with no harness mapping reports null (unknown), never a
    # fabricated False.
    assert inv["http"]["harness"] is None
    assert inv["http"]["task_spawn"] is None
    assert inv["http"]["parallel_agents"] is None
    # The gemini backend is the API-agent loop (GeminiAgentBackend), NOT the
    # Gemini CLI harness — so it has no harness mapping and task_spawn is null,
    # never the CLI's True (regression guard for the self-correction).
    assert inv["gemini"]["harness"] is None
    assert inv["gemini"]["task_spawn"] is None
    assert inv["gemini"]["parallel_agents"] is None
    # Every runtime carries a non-empty strengths hint for the delegating model.
    for item in inv.values():
        assert isinstance(item["strengths"], str) and item["strengths"]


def test_declared_harness_ids_are_valid():
    # A typo'd harness id would silently fold to task_spawn=None (unknown). Pin
    # that every declared mapping resolves to a real HARNESS_CAPABILITIES entry,
    # catching the typo in CI instead of as a silent runtime downgrade.
    from superclaw.harness import HARNESS_CAPABILITIES
    from superclaw.ui_contracts import AGENT_CONTROL_SPECS

    for name, spec in AGENT_CONTROL_SPECS.items():
        harness_id = spec.get("harness")
        if harness_id is not None:
            assert harness_id in HARNESS_CAPABILITIES, (
                f"{name} declares unknown harness {harness_id!r}"
            )


def test_build_plugin_status_payload_reports_local_entitlements_without_token(tmp_path, monkeypatch):
    local_state_root = tmp_path / "plugin-state"
    local_state_root.mkdir(parents=True)
    (local_state_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.2.0",
                        "entitlement_id": "ent_demo",
                        "expires_at": "2030-01-01T00:00:00Z",
                        "token": "local-entitlement.should-not-leak",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH", str(local_state_root))

    payload = build_plugin_status_payload(
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        developer_submission_root=tmp_path / "submissions",
        clawhunt_ingestion_root=tmp_path / "clawhunt",
    )

    assert payload["entitlements"]["file"] == str(local_state_root / "entitlements.json")
    assert payload["entitlements"]["count"] == 1
    assert payload["entitlements"]["plugin_count"] == 1
    assert payload["entitlements"]["status_url"] == "/v1/entitlements/sync"
    assert payload["entitlements"]["entries"][0]["plugin_id"] == "dev.superclaw.github-scanner"
    assert payload["entitlements"]["entries"][0]["entitlement_id"] == "ent_demo"
    assert "token" not in payload["entitlements"]["entries"][0]


def test_build_plugin_status_payload_tolerates_non_object_entitlement_json(tmp_path, monkeypatch):
    local_state_root = tmp_path / "plugin-state"
    local_state_root.mkdir(parents=True)
    (local_state_root / "entitlements.json").write_text(json.dumps(["unexpected"]), encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH", str(local_state_root))

    payload = build_plugin_status_payload(
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        developer_submission_root=tmp_path / "submissions",
        clawhunt_ingestion_root=tmp_path / "clawhunt",
    )

    assert payload["entitlements"]["count"] == 0
    assert payload["entitlements"]["plugin_count"] == 0
    assert payload["entitlements"]["entries"] == []


def test_build_plugin_status_payload_tolerates_null_entitlement_entries(tmp_path, monkeypatch):
    local_state_root = tmp_path / "plugin-state"
    local_state_root.mkdir(parents=True)
    (local_state_root / "entitlements.json").write_text(json.dumps({"entitlements": None}), encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH", str(local_state_root))

    payload = build_plugin_status_payload(
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        developer_submission_root=tmp_path / "submissions",
        clawhunt_ingestion_root=tmp_path / "clawhunt",
    )

    assert payload["entitlements"]["count"] == 0
    assert payload["entitlements"]["entries"] == []


def test_build_plugin_status_payload_reports_sanitized_revocations(tmp_path):
    governance_root = tmp_path / "cloud" / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "revocations.json").write_text(
        json.dumps(
            {
                "revoked": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.2.0",
                        "package_digest": "sha256:" + ("2" * 64),
                        "reason": "broken_runtime",
                        "unexpected": "ignored",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = build_plugin_status_payload(
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        developer_submission_root=tmp_path / "submissions",
        clawhunt_ingestion_root=tmp_path / "clawhunt",
    )

    assert payload["governance"]["revocation_count"] == 1
    assert payload["governance"]["revocations"] == [
        {
            "plugin_id": "dev.superclaw.github-scanner",
            "version": "0.2.0",
            "package_digest": "sha256:" + ("2" * 64),
            "reason": "broken_runtime",
        }
    ]


def test_build_plugin_status_payload_reports_sanitized_runtime_policies(tmp_path):
    governance_root = tmp_path / "cloud" / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "runtime-policy.json").write_text(
        json.dumps(
            {
                "policies": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.2.0",
                        "max_model_output_bytes": 1024,
                        "max_tool_timeout_ms": 5000,
                        "denylisted_permissions": ["network:external"],
                        "minimum_runtime_version": "0.1.0",
                        "risk_level": "high",
                        "requires_live_metering": True,
                        "secret_descriptors": [
                            {"name": "API_TOKEN", "required": True, "value": "should-not-leak"}
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = build_plugin_status_payload(
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        developer_submission_root=tmp_path / "submissions",
        clawhunt_ingestion_root=tmp_path / "clawhunt",
    )

    assert payload["governance"]["policy_count"] == 1
    assert payload["governance"]["policies"] == [
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
    ]


def test_build_shell_status_lines_reuse_runtime_contract_fields():
    runtime_status = build_runtime_status_payload(
        runtime_version="0.1.0",
        repo=Path("/tmp/repo"),
        state_path=Path("/tmp/state.db"),
        artifact_dir=Path("/tmp/artifacts"),
        backend="codex",
        mode="chat",
        started_at=0.0,
        control_token_required=False,
        clawhunt_agent_api_key_configured=True,
        context={
            "counts": {
                "runs": 3,
                "events": 9,
                "evidence_bundles": 2,
                "chat_sessions": 1,
            }
        },
        active_run_ids=["run_a", "run_b"],
        recent_run_id="run_b",
        config_path=Path("/tmp/config.json"),
        agents=[{"name": "codex", "available": True}],
        plugins={
            "plugin_count": 4,
            "verification": {"public_key_configured": True},
            "registry": {"error": None},
            "governance": {"revocation_error": None, "policy_error": None},
        },
        service_pid=4242,
        service_bind="127.0.0.1",
        service_control_token="unset",
    )

    lines = build_shell_status_lines(
        runtime_status,
        session_id="chat_123",
        last_run_id="run_b",
        backend_status="codex: READY (/opt/codex)",
    )

    assert "runtime_version=0.1.0" in lines
    assert "backend=codex" in lines
    assert "mode=chat" in lines
    assert "session_id=chat_123" in lines
    assert "last_run_id=run_b" in lines
    assert "service_pid=4242" in lines
    assert "service_bind=127.0.0.1" in lines
    assert "control_token=unset" in lines
    assert "backend_status=codex: READY (/opt/codex)" in lines
    assert "auth=set" in lines
    assert "runs_total=3" in lines
    assert "events_total=9" in lines
    assert "evidence_total=2" in lines
    assert "chat_sessions_total=1" in lines
    assert "active_runs=2" in lines
    assert "plugin_cache_count=4" in lines
    assert runtime_status["service"]["pid"] == 4242
    assert runtime_status["service"]["bind"] == "127.0.0.1"
    assert runtime_status["service"]["control_token"] == "unset"
    assert runtime_status["service"]["health"]["status"] == "ok"
    assert runtime_status["service"]["health"]["summary"] == "runtime ready"


def test_build_runtime_status_payload_marks_warnings_and_errors():
    warned = build_runtime_status_payload(
        runtime_version="0.1.0",
        repo=Path("/tmp/repo"),
        state_path=Path("/tmp/state.db"),
        artifact_dir=Path("/tmp/artifacts"),
        backend="codex",
        mode="chat",
        started_at=0.0,
        control_token_required=False,
        clawhunt_agent_api_key_configured=False,
        context={"counts": {}},
        active_run_ids=[],
        recent_run_id=None,
        config_path=Path("/tmp/config.json"),
        agents=[{"name": "codex", "available": True}, {"name": "openclaw", "available": False}],
        plugins={
            "plugin_count": 1,
            "verification": {"public_key_configured": False},
            "registry": {"error": None},
            "governance": {"revocation_error": None, "policy_error": None},
        },
    )
    errored = build_runtime_status_payload(
        runtime_version="0.1.0",
        repo=Path("/tmp/repo"),
        state_path=Path("/tmp/state.db"),
        artifact_dir=Path("/tmp/artifacts"),
        backend="codex",
        mode="chat",
        started_at=0.0,
        control_token_required=False,
        clawhunt_agent_api_key_configured=True,
        context={"counts": {}},
        active_run_ids=[],
        recent_run_id=None,
        config_path=Path("/tmp/config.json"),
        agents=[{"name": "codex", "available": True}],
        plugins={
            "plugin_count": 1,
            "verification": {"public_key_configured": True},
            "registry": {"error": "registry timeout"},
            "governance": {"revocation_error": None, "policy_error": None},
        },
    )

    assert warned["service"]["health"]["status"] == "warn"
    assert warned["service"]["pid"] > 0
    assert warned["service"]["bind"] == "127.0.0.1"
    assert warned["service"]["control_token"] == "unset"
    assert "missing agents: openclaw" in warned["service"]["health"]["summary"]
    assert "plugin trust root unset" in warned["service"]["health"]["summary"]
    assert "clawhunt auth unset" in warned["service"]["health"]["summary"]
    assert errored["service"]["health"]["status"] == "error"
    assert "plugin registry unavailable" in errored["service"]["health"]["summary"]


def test_build_runtime_status_payload_carries_node_coexistence_section():
    common = dict(
        runtime_version="0.1.0",
        repo=Path("/tmp/repo"),
        state_path=Path("/tmp/state.db"),
        artifact_dir=Path("/tmp/artifacts"),
        backend="codex",
        mode="chat",
        started_at=0.0,
        control_token_required=False,
        clawhunt_agent_api_key_configured=False,
        context={"counts": {}},
        active_run_ids=[],
        recent_run_id=None,
        config_path=Path("/tmp/config.json"),
        agents=[{"name": "codex", "available": True}],
        plugins={
            "plugin_count": 0,
            "verification": {"public_key_configured": False},
            "registry": {"error": None},
            "governance": {"revocation_error": None, "policy_error": None},
        },
    )
    # No node info (CLI doctor / tests) ⇒ a disabled section so the contract shape is
    # stable and the web gate reads "no Node to wait for".
    default = build_runtime_status_payload(**common)
    assert default["node"] == {"enabled": False, "ready": False, "url": None, "port": None, "error": None}
    # A supplied snapshot flows through verbatim (single source: node_runtime fills it).
    snapshot = {"enabled": True, "ready": True, "url": "http://127.0.0.1:3100", "port": 3100, "error": None}
    withnode = build_runtime_status_payload(**common, node=snapshot)
    assert withnode["node"] == snapshot


def test_build_tui_acceptance_payload_reads_summary(tmp_path, monkeypatch):
    report_path = tmp_path / "tui-acceptance.json"
    report_path.write_text(
        """
{
  "generated_at": "2026-06-04T12:00:00Z",
  "success": false,
  "failed_step": "snapshot_file",
  "steps": [
    {"name": "pytest", "ok": true},
    {"name": "dump_snapshot", "ok": true},
    {"name": "snapshot_file", "ok": false}
  ]
}
""".strip()
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_TUI_ACCEPTANCE_REPORT", str(report_path))

    payload = build_tui_acceptance_payload(workspace_root=tmp_path)

    assert payload["status_url"] == "/api/tui/acceptance"
    assert payload["generate_command"] == "PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance"
    assert payload["report_path"] == str(report_path)
    assert payload["exists"] is True
    assert payload["summary"] == {
        "ready": True,
        "success": False,
        "failed_step": "snapshot_file",
        "generated_at": "2026-06-04T12:00:00Z",
        "completed_steps": 2,
        "total_steps": 3,
    }


def test_build_desktop_dependency_targets_and_onboarding_payload():
    agents = [
        {
            "name": "codex",
            "available": True,
            "executable": "/opt/codex",
            "configure": "/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
        },
        {
            "name": "hermes",
            "available": False,
            "reason": "hermes executable not found",
            "configure": "/config set SUPERCLAW_HERMES_EXECUTABLE /path/to/hermes",
        },
    ]
    dependency_targets = build_desktop_dependency_targets(agents=agents)

    assert dependency_targets[0]["installed"] is True
    assert dependency_targets[1]["installed"] is False
    assert dependency_targets[1]["remediation"] == "/config set SUPERCLAW_HERMES_EXECUTABLE /path/to/hermes"

    payload = build_desktop_onboarding_payload(
        workspace_root=Path("/tmp/superclaw"),
        runtime_status={"service": {"version": "0.1.0"}, "backend": "codex", "mode": "auto"},
        agents=agents,
        auth_payload={"clawhunt": {"agent_api_key": "unset"}},
        plugin_status={"verification": {"public_key_configured": False}},
        toolchain_payload={
            "source_workspace": True,
            "tools": [{"label": "Tauri CLI", "available": False, "remediation": "Install Tauri CLI."}],
            "summary": {"ready_count": 4, "required_count": 5, "source_build_ready": False},
        },
        acceptance_payload={
            "exists": False,
            "generate_command": "npm --prefix apps/desktop run test:beta-acceptance",
            "report_path": "/tmp/report.json",
            "summary": {"success": None, "failed_step": None, "generated_at": None},
        },
    )

    assert payload["status_url"] == "/api/desktop/onboarding"
    assert payload["summary"]["ready"] is False
    assert payload["summary"]["ready_count"] == 1
    assert payload["checks"][1]["title"] == "Desktop toolchain"
    assert payload["checks"][1]["detail"] == "Needs setup: Tauri CLI."
    assert payload["checks"][2]["detail"] == "Needs setup: Hermes, Claude Code, OpenClaw."


def test_build_skill_sync_contract_sources_targets_from_core():
    from superclaw.ui_contracts import build_skill_sync_contract
    from superclaw.skill_sync import RUNTIME_TARGETS

    contract = build_skill_sync_contract()
    assert contract["capability"] == "skill-sync"
    assert contract["governed"] is True
    names = {t["name"] for t in contract["targets"]}
    # Targets come from the single core source, not a hardcoded surface list.
    assert names == set(RUNTIME_TARGETS)
    for target in contract["targets"]:
        assert target["env_var"].startswith("SUPERCLAW_")
        assert "/skills" in target["default_subdir"]
    assert contract["operations"]["sync"]["url"] == "/api/plugins/skills/sync"


def test_agent_inventory_includes_permission_presets():
    from superclaw.ui_contracts import build_agent_inventory, build_permission_mode_contract

    inventory = build_agent_inventory()
    by_name = {item["name"]: item for item in inventory}
    # every backend exposes its two-preset mapping with the honest interactive bit
    for name, item in by_name.items():
        presets = item["permission_presets"]
        assert set(presets) == {"ask", "allow"}, name
        assert set(presets["ask"]) == {"native", "interactive", "note_key", "preset_driven"}
        # honest: no backend prompts a human at runtime today
        assert presets["ask"]["interactive"] is False, name
    assert by_name["openclaw"]["permission_presets"]["ask"]["preset_driven"] is False
    # Max-permission doctrine: both presets map to bypassPermissions, so switching
    # ask<->allow no longer changes any runtime's behavior — every backend honestly
    # declares preset_driven=False (claude included, formerly preset-driven).
    assert by_name["claude"]["permission_presets"]["ask"]["preset_driven"] is False
    assert all(
        item["permission_presets"]["ask"]["preset_driven"] is False
        and item["permission_presets"]["allow"]["preset_driven"] is False
        for item in by_name.values()
    )

    contract = build_permission_mode_contract()
    assert sorted(contract["presets"]) == ["allow", "ask"]
    assert contract["preset_to_mode"] == {"ask": "bypassPermissions", "allow": "bypassPermissions"}


def test_build_tui_acceptance_payload_reads_report(tmp_path, monkeypatch):
    report_path = tmp_path / "tui-acceptance.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at": "2026-06-04T08:00:00Z",
                "success": True,
                "failed_step": None,
                "steps": [
                    {
                        "name": "pytest",
                        "command": "python -m pytest tests/test_tui.py",
                        "started_at": "2026-06-04T08:00:00Z",
                        "duration_ms": 1800,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                    {
                        "name": "launch_smoke",
                        "command": "python -m superclaw.cli tui --backend local",
                        "started_at": "2026-06-04T08:00:02Z",
                        "duration_ms": 900,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_TUI_ACCEPTANCE_REPORT", str(report_path))

    payload = build_tui_acceptance_payload(workspace_root=tmp_path)

    assert payload["status_url"] == "/api/tui/acceptance"
    assert payload["generate_command"] == "PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance"
    assert payload["report_path"] == str(report_path)
    assert payload["exists"] is True
    assert payload["summary"] == {
        "ready": True,
        "success": True,
        "failed_step": None,
        "generated_at": "2026-06-04T08:00:00Z",
        "completed_steps": 2,
        "total_steps": 2,
    }
