from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_workflow import (
    DEFAULT_PLUGIN_WORKFLOW_GATES,
    PluginWorkflowGate,
    plugin_workflow_gate_payload,
    run_plugin_workflow_gate,
)


def test_plugin_workflow_gate_passes_for_current_framework_docs():
    repo_root = Path(__file__).resolve().parents[1]

    results = run_plugin_workflow_gate(repo_root=repo_root)
    payload = plugin_workflow_gate_payload(results)

    assert payload["ok"] is True
    assert payload["summary"] == {"passed": len(DEFAULT_PLUGIN_WORKFLOW_GATES), "failed": 0}
    assert [result.gate_id for result in results] == [
        "feature-boundary-card",
        "tests-per-feature",
        "documentation-loop",
        "atomic-commit-policy",
        "pre-commit-gate",
        "feature-group-pr-policy",
        "pre-pr-sync-gate",
        "version-changelog-gate",
    ]
    assert all(result.status == "passed" for result in results)
    assert all(result.evidence for result in results)


def test_plugin_workflow_gate_detects_missing_required_markers(tmp_path: Path):
    (tmp_path / "docs").mkdir()
    framework = tmp_path / "docs" / "plugin-ecosystem-framework.md"
    framework.write_text("Feature id\nPhase\n", encoding="utf-8")

    results = run_plugin_workflow_gate(
        repo_root=tmp_path,
        gates=(
            PluginWorkflowGate(
                gate_id="feature-boundary-card",
                requirement="boundary",
                evidence=["docs/plugin-ecosystem-framework.md"],
                required_markers=["Feature id", "Runtime boundary"],
            ),
        ),
    )

    assert results[0].status == "failed"
    assert results[0].missing_markers == ["Runtime boundary"]


def test_plugin_workflow_gate_validates_version_and_changelog(tmp_path: Path):
    (tmp_path / "VERSION").write_text("0.1\n", encoding="utf-8")
    (tmp_path / "CHANGELOG.md").write_text("# Changelog\n## [Unreleased]\n", encoding="utf-8")

    results = run_plugin_workflow_gate(
        repo_root=tmp_path,
        gates=tuple(gate for gate in DEFAULT_PLUGIN_WORKFLOW_GATES if gate.gate_id == "version-changelog-gate"),
    )

    assert results[0].status == "failed"
    assert results[0].missing_markers == ["semver-version", "released-version-heading"]


def test_plugin_workflow_gate_rejects_unsafe_evidence_path(tmp_path: Path):
    with pytest.raises(ValueError, match="evidence path is unsafe"):
        run_plugin_workflow_gate(
            repo_root=tmp_path,
            gates=(
                PluginWorkflowGate(
                    gate_id="unsafe",
                    requirement="unsafe",
                    evidence=["../secret.md"],
                    required_markers=["secret"],
                ),
            ),
        )


def test_plugin_workflow_gate_cli_json_contract():
    runner = CliRunner()

    result = runner.invoke(app, ["plugin", "workflow-gate", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["summary"]["failed"] == 0
    assert any(
        gate["gate_id"] == "pre-pr-sync-gate"
        and gate["status"] == "passed"
        and gate["evidence"] == ["docs/plugin-ecosystem-framework.md"]
        for gate in payload["gates"]
    )
