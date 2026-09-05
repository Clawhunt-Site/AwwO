import json
import os
import subprocess
import sys

import superclaw.runtime as runtime_module
from superclaw.runtime import runtime_cli_comparison, runtime_mcp_status


def test_desktop_toolchain_path_prepends_gui_safe_node_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_module.Path, "home", lambda: tmp_path)
    local_bin = tmp_path / ".local" / "bin"
    local_bin.mkdir(parents=True)

    result = runtime_module.desktop_toolchain_path("/usr/bin")

    entries = result.split(os.pathsep)
    assert entries[0] == str(local_bin)
    assert "/usr/bin" in entries
    assert entries.count("/usr/bin") == 1


def test_runtime_mcp_status_parses_config_and_redacts_secrets(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_REMOTE_TOKEN", raising=False)
    config = tmp_path / "mcp.toml"
    fake_url_token = "cph_" + "secret123456789"
    fake_inline_token = "cph_" + "inline123456789"
    config.write_text(
        "\n".join(
            [
                "[mcp_servers.local]",
                f"command = {json.dumps(sys.executable)}",
                'args = ["-m", "demo"]',
                "",
                "[mcp_servers.remote]",
                f'url = "https://example.com/mcp?token={fake_url_token}"',
                'bearer_token_env_var = "MCP_REMOTE_TOKEN"',
                "",
                "[mcp_servers.remote.env]",
                f'INLINE_SECRET = "{fake_inline_token}"',
            ]
        ),
        encoding="utf-8",
    )

    status = runtime_mcp_status([str(config)], run_cli_probe=False)
    rendered = json.dumps(status)

    assert status["summary"]["server_count"] == 2
    assert status["summary"]["ready_count"] == 1
    assert status["summary"]["issue_count"] == 1
    assert status["codex_mcp_list"]["skipped"] is True
    assert "cph_secret" not in rendered
    assert "cph_inline" not in rendered
    remote = next(server for server in status["servers"] if server["name"] == "remote")
    assert remote["url"] == "https://example.com/mcp"
    assert remote["token_env_status"] == "unset"
    assert remote["issues"] == ["token_env_unset"]


def test_runtime_cli_comparison_marks_mcp_status_as_capability_not_gap():
    comparison = runtime_cli_comparison()

    assert "mcp-status" not in json.dumps(comparison["superclaw_gaps"])
    assert "live_mcp_status" not in json.dumps(comparison["superclaw_gaps"])
    assert "stale_run_reconciliation" not in json.dumps(comparison["superclaw_gaps"])
    gap_ids = {gap["id"] for gap in comparison["superclaw_gaps"]}
    assert "model_stream_passthrough" not in gap_ids
    assert "live_model_stream_passthrough" in gap_ids
    assert "runtime mcp-status" in comparison["capabilities"]["mcp_runtime"]["superclaw"]
    assert "state-backed reconcile and resume" in comparison["capabilities"]["stale_run_reconciliation"]["superclaw"]
    assert "transcript stream_events" in comparison["capabilities"]["stream_json"]["superclaw"]


def test_runtime_mcp_status_fail_closes_codex_auth_prompt(tmp_path, monkeypatch):
    config = tmp_path / "empty.toml"
    config.write_text("", encoding="utf-8")
    monkeypatch.setattr(runtime_module.shutil, "which", lambda name, path=None: "codex" if name == "codex" else None)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="Sign in with ChatGPT to generate an API key\nRaw mode is not supported",
            stderr="",
        )

    monkeypatch.setattr(runtime_module.subprocess, "run", fake_run)

    status = runtime_mcp_status([str(config)], run_cli_probe=True)

    assert status["codex_mcp_list"]["ok"] is False
    assert status["codex_mcp_list"]["failure_marker"] == "sign in with chatgpt"
    assert status["summary"]["cli_probe_ok"] is False
