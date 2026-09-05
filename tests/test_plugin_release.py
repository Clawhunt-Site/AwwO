from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_conformance import DEFAULT_PLUGIN_CONFORMANCE_CHECKS
from superclaw.plugin_release import (
    DEFAULT_PLUGIN_RELEASE_CHECKLIST,
    PluginManualReleaseEvidence,
    PluginReleaseChecklistItem,
    load_manual_release_evidence,
    plugin_release_checklist_payload,
    run_plugin_release_checklist,
    validate_plugin_release_checklist,
)


def test_plugin_release_checklist_maps_section_25_items_to_conformance_or_manual():
    repo_root = Path(__file__).resolve().parents[1]
    results = run_plugin_release_checklist(repo_root=repo_root)
    payload = plugin_release_checklist_payload(results)

    assert payload["ok"] is True
    assert payload["release_ready"] is False
    assert payload["summary"] == {"passed": 0, "failed": 0, "manual": 3, "not_run": 26}
    assert [result.item_id for result in results] == [
        "schema-versioned",
        "json-schema-fixtures",
        "configuration-policy-schema",
        "output-schema-validation",
        "signature-tamper-rejection",
        "revocation-blocks-cached",
        "entitlement-before-startup",
        "missing-secret-config-required",
        "runtime-config-secret-free",
        "offline-grace-cap",
        "cloud-rest-contract-required",
        "registry-ux-required",
        "engineering-workflow-gate-required",
        "release-checklist-integrity",
        "mcp-proxy-nonleakage",
        "extension-ports-contract-required",
        "developer-onboarding-contract-required",
        "sandbox-preflight-required",
        "codex-backed-proxy-run",
        "claude-backed-proxy-run",
        "clawhunt-reusable-conversion",
        "clawhunt-oneoff-rejection",
        "developer-upload-signing",
        "developer-submission-rest-contract",
        "plugin-update-preflight-required",
        "plugin-call-evidence",
        "delivery-protocol-plugin-evidence-export",
        "model-visible-output-safe",
        "marketplace-payment-no-go",
    ]
    assert all(result.section == "25" for result in results)
    assert all(result.conformance_checks for result in results)
    assert all(result.evidence for result in results)


def test_plugin_release_checklist_references_known_checks_and_existing_evidence():
    repo_root = Path(__file__).resolve().parents[1]
    known_checks = {check.check_id for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS}

    validate_plugin_release_checklist(repo_root=repo_root)
    for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST:
        assert set(item.conformance_checks) <= known_checks
        for evidence in item.evidence:
            evidence_path = Path(evidence)
            assert not evidence_path.is_absolute()
            assert ".." not in evidence_path.parts
            assert (repo_root / evidence_path).exists(), evidence


def test_plugin_release_checklist_references_every_conformance_check():
    known_checks = {check.check_id for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS}
    referenced_checks = {check_id for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST for check_id in item.conformance_checks}

    assert known_checks <= referenced_checks


def test_plugin_release_checklist_requires_delivery_protocol_plugin_evidence_export():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "delivery-protocol-plugin-evidence-export")

    assert item.section == "25"
    assert item.conformance_checks == ["protocol-adapter-plugin-evidence-export"]
    assert "sanitized plugin invocation evidence" in item.requirement
    assert "tests/test_protocol_adapter.py" in item.evidence
    assert "packages/superclaw/src/superclaw/protocol_adapter.py" in item.evidence


def test_plugin_release_checklist_requires_sandbox_guardrails():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "sandbox-preflight-required")

    assert item.section == "25"
    assert item.conformance_checks == ["sandbox"]
    assert "before sidecar startup" in item.requirement
    assert "tests/test_plugin_proxy.py" in item.evidence
    assert "tests/test_plugin_mcp_proxy.py" in item.evidence


def test_plugin_release_checklist_requires_extension_ports_contract():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "extension-ports-contract-required")

    assert item.section == "25"
    assert item.conformance_checks == ["extension-ports-contract"]
    assert "Section 13 framework extension ports" in item.requirement
    assert "code-level contracts" in item.requirement
    assert "tests/test_plugin_ports.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_ports.py" in item.evidence
    assert "docs/plugin-ecosystem-framework.md" in item.evidence


def test_plugin_release_checklist_requires_developer_onboarding_contract():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "developer-onboarding-contract-required")

    assert item.section == "25"
    assert item.conformance_checks == ["developer-onboarding-contract"]
    assert "Section 12 developer onboarding" in item.requirement
    assert "marketplace payment or payout workflows" in item.requirement
    assert "tests/test_plugin_developer_onboarding.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_developer_onboarding.py" in item.evidence
    assert "docs/plugin-ecosystem-framework.md" in item.evidence


def test_plugin_release_checklist_requires_cloud_rest_contract():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "cloud-rest-contract-required")

    assert item.section == "25"
    assert item.conformance_checks == ["cloud-rest-contract"]
    assert "Local /v1 plugin cloud REST endpoints" in item.requirement
    assert "raw evidence, local path, or secret leakage" in item.requirement
    assert "tests/test_plugin_cloud_api.py" in item.evidence
    assert "apps/api/main.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_cloud.py" in item.evidence


def test_plugin_release_checklist_requires_developer_submission_rest_contract():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "developer-submission-rest-contract")

    assert item.section == "25"
    assert item.conformance_checks == ["developer-submission-rest"]
    assert "developer submission REST endpoints" in item.requirement
    assert "sanitized verification metadata" in item.requirement
    assert "signing private keys" in item.requirement
    assert "tests/test_plugin_cloud_api.py" in item.evidence
    assert "tests/test_plugin_submission.py" in item.evidence
    assert "apps/api/main.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_submission.py" in item.evidence


def test_plugin_release_checklist_requires_update_preflight_gate():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "plugin-update-preflight-required")

    assert item.section == "25"
    assert item.conformance_checks == ["plugin-update-preflight"]
    assert "plugin update compatibility preflight" in item.requirement
    assert "marketplace listing, payment" in item.requirement
    assert "tests/test_plugin_updates.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_updates.py" in item.evidence
    assert "packages/superclaw/src/superclaw/cli.py" in item.evidence
    assert "docs/plugin-ecosystem-framework.md" in item.evidence


def test_plugin_release_checklist_requires_registry_ux():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "registry-ux-required")

    assert item.section == "25"
    assert item.conformance_checks == ["registry-ux"]
    assert "registry search and install commands" in item.requirement
    assert "verifier-backed package metadata" in item.requirement
    assert "tests/test_plugin_cloud.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_cloud.py" in item.evidence
    assert "packages/superclaw/src/superclaw/cli.py" in item.evidence


def test_plugin_release_checklist_requires_engineering_workflow_gate():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "engineering-workflow-gate-required")

    assert item.section == "25"
    assert item.conformance_checks == ["engineering-workflow-gate"]
    assert "Section 27 engineering workflow gates" in item.requirement
    assert "tests/test_plugin_workflow.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_workflow.py" in item.evidence
    assert "docs/plugin-ecosystem-framework.md" in item.evidence


def test_plugin_release_checklist_requires_release_checklist_integrity():
    item = next(item for item in DEFAULT_PLUGIN_RELEASE_CHECKLIST if item.item_id == "release-checklist-integrity")

    assert item.section == "25"
    assert item.conformance_checks == ["release-checklist"]
    assert "Release checklist integrity checks" in item.requirement
    assert "sanitized JSON output" in item.requirement
    assert "tests/test_plugin_release.py" in item.evidence
    assert "packages/superclaw/src/superclaw/plugin_release.py" in item.evidence
    assert "packages/superclaw/src/superclaw/cli.py" in item.evidence


def test_plugin_release_checklist_run_reuses_conformance_statuses(tmp_path: Path):
    calls: list[list[str]] = []

    def runner(command: list[str], repo_root: Path) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="SECRET_OUTPUT", stderr="SECRET_ERROR")

    items = [
        PluginReleaseChecklistItem(
            item_id="local-only",
            section="25",
            requirement="local release item",
            conformance_checks=["runtime-proxy"],
            evidence=["tests/test_plugin_proxy.py"],
        ),
        PluginReleaseChecklistItem(
            item_id="manual-only",
            section="25",
            requirement="manual release item",
            conformance_checks=["backend-runtime-policy"],
            evidence=["tests/test_worker_backends.py"],
            manual_reason="manual verification required",
        ),
    ]

    results = run_plugin_release_checklist(repo_root=Path(__file__).resolve().parents[1], run=True, command_runner=runner, items=items)
    payload = plugin_release_checklist_payload(results)

    assert payload["ok"] is True
    assert payload["release_ready"] is False
    assert payload["summary"] == {"passed": 1, "failed": 0, "manual": 1, "not_run": 0}
    assert results[0].status == "passed"
    assert results[1].status == "manual"
    assert "SECRET_OUTPUT" not in json.dumps(payload)
    assert "SECRET_ERROR" not in json.dumps(payload)
    assert calls


def test_plugin_release_checklist_manual_evidence_can_satisfy_manual_gates():
    def runner(command: list[str], repo_root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, stdout="SECRET_OUTPUT", stderr="SECRET_ERROR")

    manual_evidence = {
        "codex-backed-proxy-run": PluginManualReleaseEvidence(
            item_id="codex-backed-proxy-run",
            evidence_uri="tests/test_worker_backends.py",
            verified_by="release-manager",
            verified_at="2026-06-01T00:00:00Z",
            summary="Codex proxy run reviewed with sanitized evidence.",
        ),
        "claude-backed-proxy-run": PluginManualReleaseEvidence(
            item_id="claude-backed-proxy-run",
            evidence_uri="gh://ClawHunt-Store/SuperClaw/actions/runs/123",
            verified_by="release-manager",
            verified_at="2026-06-01T00:00:00Z",
            summary="Claude proxy run reviewed with sanitized evidence.",
        ),
        "marketplace-payment-no-go": PluginManualReleaseEvidence(
            item_id="marketplace-payment-no-go",
            evidence_uri="https://github.com/ClawHunt-Store/SuperClaw/pull/75",
            verified_by="release-manager",
            verified_at="2026-06-01T00:00:00Z",
            summary="Release scope reviewed and payment UI is not included.",
        ),
    }

    results = run_plugin_release_checklist(
        repo_root=Path(__file__).resolve().parents[1],
        run=True,
        command_runner=runner,
        manual_evidence=manual_evidence,
    )
    payload = plugin_release_checklist_payload(results)

    assert payload["ok"] is True
    assert payload["release_ready"] is True
    assert payload["summary"] == {"passed": 29, "failed": 0, "manual": 0, "not_run": 0}
    codex_item = next(item for item in payload["items"] if item["item_id"] == "codex-backed-proxy-run")
    assert codex_item["status"] == "passed"
    assert codex_item["manual_evidence"]["verified_by"] == "release-manager"
    assert "SECRET_OUTPUT" not in json.dumps(payload)
    assert "SECRET_ERROR" not in json.dumps(payload)


def test_load_manual_release_evidence_validates_json_and_evidence_paths(tmp_path: Path):
    repo_root = Path(__file__).resolve().parents[1]
    evidence_path = tmp_path / "manual-evidence.json"
    evidence_path.write_text(
        json.dumps(
            {
                "manual_gates": [
                    {
                        "item_id": "codex-backed-proxy-run",
                        "evidence_uri": "tests/test_worker_backends.py",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "Codex proxy run reviewed with sanitized evidence.",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    evidence = load_manual_release_evidence(evidence_path, repo_root=repo_root)

    assert evidence["codex-backed-proxy-run"].evidence_uri == "tests/test_worker_backends.py"


def test_manual_release_evidence_fails_closed_for_unsafe_or_non_manual_items(tmp_path: Path):
    repo_root = Path(__file__).resolve().parents[1]
    unsafe_path = tmp_path / "unsafe-evidence.json"
    unsafe_path.write_text(
        json.dumps(
            {
                "manual_gates": [
                    {
                        "item_id": "codex-backed-proxy-run",
                        "evidence_uri": "../secret.txt",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "unsafe path",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    non_manual_path = tmp_path / "non-manual-evidence.json"
    non_manual_path.write_text(
        json.dumps(
            {
                "manual_gates": [
                    {
                        "item_id": "schema-versioned",
                        "evidence_uri": "tests/test_plugin_distribution_pack.py",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "not a manual gate",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="path is unsafe"):
        load_manual_release_evidence(unsafe_path, repo_root=repo_root)
    with pytest.raises(ValueError, match="only accepted for manual gate items"):
        load_manual_release_evidence(non_manual_path, repo_root=repo_root)


def test_plugin_release_checklist_fails_closed_for_unknown_check_id():
    repo_root = Path(__file__).resolve().parents[1]
    items = [
        PluginReleaseChecklistItem(
            item_id="bad-check",
            section="25",
            requirement="bad check",
            conformance_checks=["missing-check"],
            evidence=["tests/test_plugin_release.py"],
        )
    ]

    with pytest.raises(ValueError, match="unknown conformance checks: missing-check"):
        validate_plugin_release_checklist(items=items, repo_root=repo_root)


def test_plugin_release_checklist_cli_json_contract():
    runner = CliRunner()
    result = runner.invoke(app, ["plugin", "release-checklist", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["release_ready"] is False
    assert payload["summary"]["manual"] == 3
    assert payload["summary"]["not_run"] == 26
    assert any(item["item_id"] == "codex-backed-proxy-run" and item["status"] == "manual" for item in payload["items"])


def test_plugin_release_checklist_cli_accepts_manual_evidence(tmp_path: Path):
    evidence_path = tmp_path / "manual-evidence.json"
    evidence_path.write_text(
        json.dumps(
            {
                "manual_gates": [
                    {
                        "item_id": "codex-backed-proxy-run",
                        "evidence_uri": "tests/test_worker_backends.py",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "Codex proxy run reviewed with sanitized evidence.",
                    },
                    {
                        "item_id": "claude-backed-proxy-run",
                        "evidence_uri": "gh://ClawHunt-Store/SuperClaw/actions/runs/123",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "Claude proxy run reviewed with sanitized evidence.",
                    },
                    {
                        "item_id": "marketplace-payment-no-go",
                        "evidence_uri": "https://github.com/ClawHunt-Store/SuperClaw/pull/75",
                        "verified_by": "release-manager",
                        "verified_at": "2026-06-01T00:00:00Z",
                        "summary": "Release scope reviewed and payment UI is not included.",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    runner = CliRunner()

    result = runner.invoke(app, ["plugin", "release-checklist", "--manual-evidence", str(evidence_path), "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["release_ready"] is False
    assert payload["summary"]["manual"] == 0
    assert payload["summary"]["not_run"] == 26
