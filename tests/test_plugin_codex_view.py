from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_codex_view import export_codex_compatible_view


ROOT = Path(__file__).resolve().parents[1]


def _copy_fixture(tmp_path: Path, name: str = "hello-world") -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _all_view_text(output_dir: Path) -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(output_dir.rglob("*")) if path.is_file())


def test_codex_view_exports_proxy_only_artifacts_without_private_paths(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    output_dir = tmp_path / "codex-view"

    result = export_codex_compatible_view(plugin_dir, output_dir=output_dir, python_executable="/usr/bin/python3")

    assert result.record["proxy_only"] is True
    assert sorted(result.record["generated_paths"]) == [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "skills/hello_world/SKILL.md",
    ]
    assert (output_dir / ".codex-plugin" / "plugin.json").exists()
    assert (output_dir / ".mcp.json").exists()
    assert (output_dir / "skills" / "hello_world" / "SKILL.md").exists()
    text = _all_view_text(output_dir)
    assert "superclaw.plugin_mcp_proxy" in text
    assert "superclaw__dev_superclaw_hello_world__hello_world" in text
    assert "bin/hello-world" not in text
    assert os.fspath(plugin_dir) not in text
    assert ".superclaw/plugins/cache" not in text
    assert "entitlement" not in text.lower()
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in text
    assert "plugin_dirs" not in text
    assert '"env"' not in text


def test_codex_view_plugin_json_is_derived_manifest_not_runtime_source(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    output_dir = tmp_path / "codex-view"

    export_codex_compatible_view(plugin_dir, output_dir=output_dir, python_executable="/usr/bin/python3")
    plugin_json = json.loads((output_dir / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))

    assert plugin_json == {
        "schema_version": "0.1.0",
        "id": "dev.superclaw.hello-world",
        "name": "Hello World",
        "version": "0.1.0",
        "description": "Returns a deterministic hello-world response through the SuperClaw plugin contract.",
        "source_of_truth": "superclaw-plugin.json",
        "runtime": "superclaw_mcp_proxy",
        "mcp_config": ".mcp.json",
        "tools": [
            {
                "name": "superclaw__dev_superclaw_hello_world__hello_world",
                "description": "Return a deterministic greeting for plugin contract smoke tests.",
                "skill": "skills/hello_world/SKILL.md",
            }
        ],
    }
    assert "source" not in plugin_json
    assert "provenance" not in plugin_json
    assert "commerce" not in plugin_json


def test_codex_view_mcp_json_points_only_to_superclaw_proxy(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    output_dir = tmp_path / "codex-view"

    export_codex_compatible_view(plugin_dir, output_dir=output_dir, python_executable="/usr/bin/python3")
    mcp = json.loads((output_dir / ".mcp.json").read_text(encoding="utf-8"))
    server = next(iter(mcp["mcpServers"].values()))

    assert server["command"] == "/usr/bin/python3"
    assert server["args"] == [
        "-m",
        "superclaw.plugin_mcp_proxy",
        "serve",
        "--plugin-id",
        "dev.superclaw.hello-world",
        "--version",
        "0.1.0",
    ]
    assert "env" not in server


def test_codex_view_cli_generates_json_and_refuses_existing_output_without_force(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    output_dir = tmp_path / "codex-view"
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "codex-view",
            str(plugin_dir),
            "--output-dir",
            str(output_dir),
            "--python-executable",
            "/usr/bin/python3",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["record"]["out_of_scope"] == [
        "codex_install",
        "codex_process_start",
        "source_export",
        "plugin_cache_export",
        "entitlement_export",
        "secret_export",
        "marketplace_distribution",
    ]
    again = runner.invoke(
        app,
        [
            "plugin",
            "codex-view",
            str(plugin_dir),
            "--output-dir",
            str(output_dir),
            "--json",
        ],
    )
    assert again.exit_code == 1
    assert "already exists" in again.output
