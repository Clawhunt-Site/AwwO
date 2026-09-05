from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.process_scripts import script_is_runnable
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import verify_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_plugin_init_creates_schema_valid_starter_package(tmp_path: Path):
    target = tmp_path / "starter"
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "init",
            "com.example.repo-scanner",
            "--output-dir",
            str(target),
            "--tool-name",
            "repo_scan",
            "--json",
        ],
    )

    payload = json.loads(result.output)
    manifest = _load_json(target / "superclaw-plugin.json")
    Draft202012Validator(_load_json(ROOT / "schemas" / "superclaw-plugin.schema.json")).validate(manifest)

    assert result.exit_code == 0, result.output
    assert payload["ok"] is True
    assert payload["plugin_id"] == "com.example.repo-scanner"
    assert payload["tool_name"] == "repo_scan"
    assert "superclaw-plugin.json" in payload["created_files"]
    assert "bin/repo-scanner" in payload["created_files"]
    assert manifest["resource_profile"]["latency_class"] == "interactive"
    assert manifest["resource_profile"]["io_profile"] == "none"
    assert (target / "bin" / "repo-scanner").exists()
    assert (target / "tests" / "smoke.sh").exists()
    assert (target / "mcp" / "server.json").exists()
    assert (target / "skills" / "README.md").exists()
    assert "SuperClaw MCP proxy" in (target / "README.md").read_text(encoding="utf-8")


def test_plugin_dev_runs_declared_tool_without_cloud_or_entitlement(tmp_path: Path):
    target = tmp_path / "starter"
    runner = CliRunner()
    init = runner.invoke(app, ["plugin", "init", "com.example.greeter", "--output-dir", str(target)])
    assert init.exit_code == 0, init.output

    dev = runner.invoke(app, ["plugin", "dev", str(target), "--tool", "hello_world", "--json", '{"name":"Ada"}', "--output-json"])
    payload = json.loads(dev.output)

    assert dev.exit_code == 0, dev.output
    assert payload["ok"] is True
    assert payload["response"] == {"text": "hello Ada from com.example.greeter"}


def test_plugin_pack_dev_signs_archive_that_verify_accepts(tmp_path: Path):
    target = tmp_path / "starter"
    dist = tmp_path / "dist"
    cache = tmp_path / "cache"
    runner = CliRunner()
    init = runner.invoke(app, ["plugin", "init", "com.example.packable", "--output-dir", str(target)])
    assert init.exit_code == 0, init.output

    pack = runner.invoke(app, ["plugin", "pack", str(target), "--dist-dir", str(dist), "--dev-sign", "--json"])
    payload = json.loads(pack.output)

    assert pack.exit_code == 0, pack.output
    assert payload["signed"] is True
    assert payload["requires_platform_signing"] is False
    assert payload["public_key"]
    package_path = Path(payload["package_path"])
    assert package_path.suffix == ".scplug"
    verified = verify_plugin_package(package_path, public_key=payload["public_key"], cache_root=cache)
    assert verified.plugin_id == "com.example.packable"
    assert verified.cached_path == cache / "com.example.packable" / "0.1.0"
    assert script_is_runnable(verified.cached_path / "bin" / "packable")


def test_plugin_pack_dev_sign_does_not_mutate_source_manifest(tmp_path: Path):
    target = tmp_path / "starter"
    dist = tmp_path / "dist"
    runner = CliRunner()
    init = runner.invoke(app, ["plugin", "init", "com.example.immutable", "--output-dir", str(target)])
    assert init.exit_code == 0, init.output
    before = (target / "superclaw-plugin.json").read_text(encoding="utf-8")

    pack = runner.invoke(app, ["plugin", "pack", str(target), "--dist-dir", str(dist), "--dev-sign", "--json"])

    assert pack.exit_code == 0, pack.output
    assert (target / "superclaw-plugin.json").read_text(encoding="utf-8") == before


def test_plugin_pack_archive_can_be_verified_cached_and_invoked(tmp_path: Path):
    target = tmp_path / "starter"
    dist = tmp_path / "dist"
    cache = tmp_path / "cache"
    artifacts = tmp_path / "artifacts"
    runner = CliRunner()
    init = runner.invoke(app, ["plugin", "init", "com.example.invokable", "--output-dir", str(target)])
    assert init.exit_code == 0, init.output

    pack = runner.invoke(app, ["plugin", "pack", str(target), "--dist-dir", str(dist), "--dev-sign", "--json"])
    payload = json.loads(pack.output)
    verified = verify_plugin_package(Path(payload["package_path"]), public_key=payload["public_key"], cache_root=cache)
    result = invoke_cached_plugin_tool(
        "com.example.invokable",
        "hello_world",
        {"name": "Ada"},
        cache_root=cache,
        public_key=payload["public_key"],
        artifact_dir=artifacts,
    )

    assert pack.exit_code == 0, pack.output
    assert verified.cached_path == cache / "com.example.invokable" / "0.1.0"
    assert result.ok is True
    assert result.model_response == {"text": "hello SuperClaw from com.example.invokable"}


def test_plugin_init_fails_closed_for_invalid_or_existing_output(tmp_path: Path):
    target = tmp_path / "starter"
    target.mkdir()
    runner = CliRunner()

    invalid = runner.invoke(app, ["plugin", "init", "bad_id", "--output-dir", str(tmp_path / "bad"), "--json"])
    existing = runner.invoke(app, ["plugin", "init", "com.example.exists", "--output-dir", str(target), "--json"])

    assert invalid.exit_code == 1
    assert json.loads(invalid.output)["ok"] is False
    assert "reverse-DNS" in json.loads(invalid.output)["error"]
    assert existing.exit_code == 1
    assert json.loads(existing.output)["ok"] is False
    assert "already exists" in json.loads(existing.output)["error"]


def test_plugin_dev_rejects_undeclared_tool_before_sidecar_start(tmp_path: Path):
    target = tmp_path / "starter"
    runner = CliRunner()
    init = runner.invoke(app, ["plugin", "init", "com.example.greeter", "--output-dir", str(target)])
    assert init.exit_code == 0, init.output

    result = runner.invoke(app, ["plugin", "dev", str(target), "--tool", "not_declared", "--json", "{}", "--output-json"])
    payload = json.loads(result.output)

    assert result.exit_code == 1
    assert payload["ok"] is False
    assert "not declared" in payload["error"]
