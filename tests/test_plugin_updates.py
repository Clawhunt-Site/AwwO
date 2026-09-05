from __future__ import annotations

import json
import shutil
from pathlib import Path

from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_updates import review_plugin_update


ROOT = Path(__file__).resolve().parents[1]


def _copy_update_pair(tmp_path: Path) -> tuple[Path, Path]:
    previous = tmp_path / "previous"
    candidate = tmp_path / "candidate"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", previous)
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", candidate)
    _mutate_manifest(candidate, lambda manifest: manifest.__setitem__("version", "0.1.1"))
    return previous, candidate


def _mutate_manifest(plugin_dir: Path, mutate):
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _required_reviews_for(previous: Path, candidate: Path) -> list[str]:
    return review_plugin_update(previous, candidate).record["required_reviews"]


def test_patch_update_without_contract_changes_allows_automated_review(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)

    result = review_plugin_update(previous, candidate, output_dir=tmp_path / "review")

    assert result.status == "automated_review_allowed"
    assert result.automated_review_allowed is True
    assert result.record["version_change"]["kind"] == "patch"
    assert result.record["required_reviews"] == ["automated_tests"]
    assert result.review_path == tmp_path / "review" / "plugin-update-preflight.json"
    assert str(tmp_path) not in json.dumps(result.record)


def test_tool_input_schema_change_requires_compatibility_review(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    _mutate_manifest(
        candidate,
        lambda manifest: manifest["tools"][0]["input_schema"]["properties"].__setitem__("style", {"type": "string"}),
    )

    assert "compatibility_review" in _required_reviews_for(previous, candidate)


def test_tool_output_schema_change_requires_evidence_replay(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    _mutate_manifest(
        candidate,
        lambda manifest: manifest["tools"][0]["output_schema"]["properties"].__setitem__("debug", {"type": "string"}),
    )

    assert "evidence_replay" in _required_reviews_for(previous, candidate)


def test_new_filesystem_network_or_environment_permission_requires_security_review(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)

    _mutate_manifest(
        candidate,
        lambda manifest: (
            manifest["permissions"]["filesystem"].append({"mode": "read", "scope": "workspace"}),
            manifest["permissions"]["network"].append({"host": "api.example.com"}),
            manifest["permissions"]["environment"].append("EXAMPLE_TOKEN"),
        ),
    )

    result = review_plugin_update(previous, candidate)
    assert "security_review" in result.record["required_reviews"]
    findings = {finding["kind"] for finding in result.record["findings"]}
    assert "filesystem_permission_added" in findings
    assert "network_permission_added" in findings
    assert "environment_permission_added" in findings


def test_runtime_entrypoint_change_requires_sandbox_smoke(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    shutil.copy(candidate / "bin" / "hello-world", candidate / "bin" / "hello-world-v2")
    _mutate_manifest(candidate, lambda manifest: manifest["runtime"].__setitem__("entrypoint", "bin/hello-world-v2"))

    assert "sandbox_smoke" in _required_reviews_for(previous, candidate)


def test_commerce_change_requires_commerce_review(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    _mutate_manifest(
        candidate,
        lambda manifest: manifest.__setitem__("commerce", {"pricing_model": "paid_per_invocation", "metering": "per_invocation"}),
    )

    assert "commerce_review" in _required_reviews_for(previous, candidate)


def test_major_update_requires_side_by_side_install(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    _mutate_manifest(candidate, lambda manifest: manifest.__setitem__("version", "1.0.0"))

    result = review_plugin_update(previous, candidate)

    assert result.status == "manual_review_required"
    assert result.record["side_by_side_required"] is True
    assert "side_by_side_install" in result.record["required_reviews"]


def test_cli_update_preflight_returns_json_report(tmp_path: Path):
    previous, candidate = _copy_update_pair(tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "update-preflight",
            str(previous),
            str(candidate),
            "--output-dir",
            str(tmp_path / "review"),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "automated_review_allowed"
    assert payload["required_reviews"] == ["automated_tests"]
    assert Path(payload["review_path"]).exists()
    assert payload["record"]["out_of_scope"] == [
        "production_signing",
        "cloud_policy_publish",
        "marketplace_listing",
        "entitlement_sync",
        "payment",
        "sidecar_replay_execution",
        "sandbox_execution",
    ]
