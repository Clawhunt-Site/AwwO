from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_conformance import (
    DEFAULT_PLUGIN_CONFORMANCE_CHECKS,
    PluginConformanceCheck,
    plugin_conformance_payload,
    run_plugin_conformance,
)


def test_plugin_conformance_dry_run_maps_all_section_22_groups(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path)

    assert [result.check_id for result in results] == [
        "package-validation",
        "developer-devkit",
        "local-package-verification",
        "runtime-proxy",
        "runtime-error-contract",
        "credential-manager",
        "backend-runtime-policy",
        "adversarial-policy",
        "extension-ports-contract",
        "developer-onboarding-contract",
        "protocol-adapter-plugin-evidence-export",
        "runtime-diagnostics",
        "evidence-retention",
        "sandbox",
        "cloud-contract",
        "cloud-rest-contract",
        "entitlement-governance",
        "registry-ux",
        "developer-upload",
        "developer-submission-rest",
        "plugin-update-preflight",
        "clawhunt-ingestion",
        "release-checklist",
        "engineering-workflow-gate",
    ]
    assert {result.section for result in results} == {"22.1", "4.0/19", "1/22.1", "22.2", "21/22.2", "7.4/22.2", "24/25", "13", "12", "24", "23", "5D/10.4", "22.3", "22.4", "6/22.4", "5C/22.4", "7.1/22.4", "6.6/26", "6.6/22.4", "10.3/4B", "22.5", "25", "27"}
    assert all(result.status == "not_run" for result in results)
    assert all(result.command for result in results)
    assert all(result.evidence for result in results)


def test_plugin_conformance_matrix_has_unique_ids_and_local_pytest_commands():
    check_ids = [check.check_id for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS]

    assert len(check_ids) == len(set(check_ids))
    for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS:
        assert check.check_id.strip() == check.check_id
        assert check.section
        assert check.requirement
        assert check.command[:3] == [".venv/bin/python", "-m", "pytest"]
        assert check.command[3:]
        assert all(target.startswith("tests/") for target in check.command[3:])


def test_plugin_conformance_matrix_references_existing_repo_relative_evidence():
    repo_root = Path(__file__).resolve().parents[1]

    for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS:
        evidence_paths = set(check.evidence)
        for test_target in check.command[3:]:
            assert test_target in evidence_paths
        for evidence in check.evidence:
            evidence_path = Path(evidence)
            assert not evidence_path.is_absolute()
            assert ".." not in evidence_path.parts
            assert (repo_root / evidence_path).exists(), evidence


def test_plugin_conformance_runs_selected_checks_with_injected_runner(tmp_path: Path):
    calls: list[list[str]] = []

    def runner(command: list[str], repo_root: Path) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    results = run_plugin_conformance(
        repo_root=tmp_path,
        run=True,
        check_ids=["cloud-contract"],
        command_runner=runner,
    )

    assert len(results) == 1
    assert results[0].check_id == "cloud-contract"
    assert results[0].status == "passed"
    assert results[0].exit_code == 0
    assert calls == [list(next(check.command for check in DEFAULT_PLUGIN_CONFORMANCE_CHECKS if check.check_id == "cloud-contract"))]


def test_plugin_conformance_package_validation_targets_schema_and_verifier_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["package-validation"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "22.1"
    assert result.command == [
        ".venv/bin/python",
        "-m",
        "pytest",
        "tests/test_plugin_distribution_pack.py",
        "tests/test_plugin_local_verification.py",
    ]
    assert "tests/test_plugin_distribution_pack.py" in result.evidence
    assert "tests/test_plugin_local_verification.py" in result.evidence
    assert "schemas/superclaw-plugin.schema.json" in result.evidence


def test_plugin_conformance_developer_devkit_targets_phase_0b_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["developer-devkit"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "4.0/19"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_devkit.py"]
    assert "tests/test_plugin_devkit.py" in result.evidence
    assert "plugin_devkit.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_local_package_verification_targets_phase_1_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["local-package-verification"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "1/22.1"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_local_verification.py"]
    assert "tests/test_plugin_local_verification.py" in result.evidence
    assert "plugins.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_runtime_proxy_targets_phase_2_proxy_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["runtime-proxy"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "22.2"
    assert result.command == [
        ".venv/bin/python",
        "-m",
        "pytest",
        "tests/test_plugin_proxy.py",
        "tests/test_plugin_mcp_proxy.py",
    ]
    assert "tests/test_plugin_proxy.py" in result.evidence
    assert "tests/test_plugin_mcp_proxy.py" in result.evidence
    assert "plugin_proxy.py" in " ".join(result.evidence)
    assert "plugin_mcp_proxy.py" in " ".join(result.evidence)


def test_plugin_conformance_credential_manager_check_targets_phase_2d_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["credential-manager"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "7.4/22.2"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_config.py"]
    assert "tests/test_plugin_config.py" in result.evidence
    assert "plugin_config.py" in " ".join(result.evidence)


def test_plugin_conformance_runtime_error_contract_targets_section_21_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["runtime-error-contract"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "21/22.2"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_proxy.py", "tests/test_plugin_cloud.py"]
    assert "tests/test_plugin_proxy.py" in result.evidence
    assert "tests/test_plugin_cloud.py" in result.evidence
    assert "plugin_proxy.py" in " ".join(result.evidence)


def test_plugin_conformance_backend_runtime_policy_targets_section_24_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["backend-runtime-policy"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "24/25"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_worker_backends.py"]
    assert "Hermes/OpenClaw fail-closed" in result.requirement
    assert "tests/test_worker_backends.py" in result.evidence
    assert "backends.py" in " ".join(result.evidence)
    assert "runtime.py" in " ".join(result.evidence)


def test_plugin_conformance_adversarial_policy_targets_section_24_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["adversarial-policy"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "24/25"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_adversarial.py", "tests/test_adversarial_hardening.py"]
    assert "tests/test_adversarial.py" in result.evidence
    assert "tests/test_adversarial_hardening.py" in result.evidence
    assert "adversarial.py" in " ".join(result.evidence)


def test_plugin_conformance_extension_ports_contract_targets_section_13_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["extension-ports-contract"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "13"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_ports.py"]
    assert "Framework extension ports" in result.requirement
    assert "Protocol contracts" in result.requirement
    assert "without changing runtime behavior" in result.requirement
    assert "tests/test_plugin_ports.py" in result.evidence
    assert "plugin_ports.py" in " ".join(result.evidence)


def test_plugin_conformance_developer_onboarding_contract_targets_section_12_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["developer-onboarding-contract"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "12"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_developer_onboarding.py"]
    assert "verified identity" in result.requirement
    assert "raw payment" in result.requirement
    assert "tests/test_plugin_developer_onboarding.py" in result.evidence
    assert "plugin_developer_onboarding.py" in " ".join(result.evidence)
    assert "docs/plugin-ecosystem-framework.md" in result.evidence


def test_plugin_conformance_protocol_adapter_plugin_evidence_export_targets_section_24_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["protocol-adapter-plugin-evidence-export"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "24"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_protocol_adapter.py"]
    assert "sanitized plugin invocation summaries" in result.requirement
    assert "without raw payload, path, secret" in result.requirement
    assert "tests/test_protocol_adapter.py" in result.evidence
    assert "protocol_adapter.py" in " ".join(result.evidence)


def test_plugin_conformance_update_preflight_targets_phase_4b_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["plugin-update-preflight"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "10.3/4B"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_updates.py"]
    assert "SemVer update risk" in result.requirement
    assert "without signing, marketplace, payment" in result.requirement
    assert "tests/test_plugin_updates.py" in result.evidence
    assert "plugin_updates.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)
    assert "docs/plugin-ecosystem-framework.md" in result.evidence


def test_plugin_conformance_runtime_diagnostics_targets_section_23_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["runtime-diagnostics"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "23"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_evidence.py"]
    assert "tests/test_plugin_evidence.py" in result.evidence
    assert "plugin_evidence.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_evidence_retention_targets_phase_5d_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["evidence-retention"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "5D/10.4"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_evidence.py"]
    assert "tests/test_plugin_evidence.py" in result.evidence
    assert "plugin_evidence.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_sandbox_targets_phase_2c_proxy_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["sandbox"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "22.3"
    assert result.command == [
        ".venv/bin/python",
        "-m",
        "pytest",
        "tests/test_plugin_proxy.py",
        "tests/test_plugin_mcp_proxy.py",
    ]
    assert "tests/test_plugin_proxy.py" in result.evidence
    assert "tests/test_plugin_mcp_proxy.py" in result.evidence
    assert "plugin_proxy.py" in " ".join(result.evidence)


def test_plugin_conformance_cloud_contract_targets_phase_5a_governance_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["cloud-contract"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "22.4"
    assert "minimum invocation-summary validation" in result.requirement
    assert result.command == [
        ".venv/bin/python",
        "-m",
        "pytest",
        "tests/test_plugin_cloud.py",
        "tests/test_plugin_cloud_api.py",
    ]
    assert "tests/test_plugin_cloud.py" in result.evidence
    assert "tests/test_plugin_cloud_api.py" in result.evidence
    assert "plugin_cloud.py" in " ".join(result.evidence)
    assert "plugin_proxy.py" in " ".join(result.evidence)


def test_plugin_conformance_registry_ux_targets_phase_5e_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["registry-ux"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "7.1/22.4"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud.py"]
    assert "tests/test_plugin_cloud.py" in result.evidence
    assert "plugin_cloud.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_cloud_rest_contract_targets_phase_5b_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["cloud-rest-contract"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "6/22.4"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud_api.py"]
    assert "tests/test_plugin_cloud_api.py" in result.evidence
    assert "apps/api/main.py" in result.evidence
    assert "plugin_cloud.py" in " ".join(result.evidence)


def test_plugin_conformance_entitlement_governance_targets_phase_5c_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["entitlement-governance"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "5C/22.4"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud.py", "tests/test_plugin_cloud_api.py"]
    assert "tests/test_plugin_cloud.py" in result.evidence
    assert "tests/test_plugin_cloud_api.py" in result.evidence
    assert "plugin_cloud.py" in " ".join(result.evidence)
    assert "plugin_proxy.py" in " ".join(result.evidence)


def test_plugin_conformance_developer_upload_targets_phase_4a_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["developer-upload"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "6.6/26"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_submission.py"]
    assert "tests/test_plugin_submission.py" in result.evidence
    assert "plugin_submission.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_developer_submission_rest_targets_section_6_6_api_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["developer-submission-rest"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "6.6/22.4"
    assert result.command == [
        ".venv/bin/python",
        "-m",
        "pytest",
        "tests/test_plugin_cloud_api.py",
        "tests/test_plugin_submission.py",
    ]
    assert "Local developer submission REST contract" in result.requirement
    assert "sanitized verification metadata" in result.requirement
    assert "signing private keys" in result.requirement
    assert "tests/test_plugin_cloud_api.py" in result.evidence
    assert "tests/test_plugin_submission.py" in result.evidence
    assert "apps/api/main.py" in result.evidence
    assert "plugin_submission.py" in " ".join(result.evidence)


def test_plugin_conformance_clawhunt_ingestion_targets_phase_3_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["clawhunt-ingestion"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "22.5"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_ingestion.py"]
    assert "tests/test_plugin_ingestion.py" in result.evidence
    assert "plugin_ingestion.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_release_checklist_targets_section_25_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["release-checklist"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "25"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_release.py"]
    assert "tests/test_plugin_release.py" in result.evidence
    assert "plugin_release.py" in " ".join(result.evidence)
    assert "cli.py" in " ".join(result.evidence)


def test_plugin_conformance_engineering_workflow_gate_targets_section_27_tests(tmp_path: Path):
    results = run_plugin_conformance(repo_root=tmp_path, check_ids=["engineering-workflow-gate"])

    assert len(results) == 1
    result = results[0]
    assert result.section == "27"
    assert result.command == [".venv/bin/python", "-m", "pytest", "tests/test_plugin_workflow.py"]
    assert "feature boundary" in result.requirement
    assert "Gemini" in result.requirement
    assert "tests/test_plugin_workflow.py" in result.evidence
    assert "plugin_workflow.py" in " ".join(result.evidence)
    assert "docs/plugin-ecosystem-framework.md" in result.evidence


def test_plugin_conformance_reports_failures_without_stdout_leak(tmp_path: Path):
    def runner(command: list[str], repo_root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 1, stdout="SECRET_OUTPUT", stderr="SECRET_ERROR")

    results = run_plugin_conformance(
        repo_root=tmp_path,
        run=True,
        checks=[
            PluginConformanceCheck(
                check_id="failing-check",
                section="22.x",
                requirement="synthetic failure",
                command=["false"],
                evidence=["tests/failing.py"],
            )
        ],
        command_runner=runner,
    )
    payload = plugin_conformance_payload(results)

    assert payload["ok"] is False
    assert payload["summary"]["failed"] == 1
    assert payload["checks"][0]["exit_code"] == 1
    assert "SECRET_OUTPUT" not in json.dumps(payload)
    assert "SECRET_ERROR" not in json.dumps(payload)


def test_plugin_conformance_rejects_unknown_check_id(tmp_path: Path):
    with pytest.raises(ValueError, match="unknown plugin conformance check id"):
        run_plugin_conformance(repo_root=tmp_path, check_ids=["missing-check"])


def test_plugin_conformance_cli_dry_run_and_failure_contract(tmp_path: Path):
    runner = CliRunner()
    dry_run = runner.invoke(app, ["plugin", "conformance", "--check-id", "package-validation", "--json"])
    assert dry_run.exit_code == 0, dry_run.output
    payload = json.loads(dry_run.output)
    assert payload["ok"] is True
    assert payload["summary"]["not_run"] == 1
    assert payload["checks"][0]["check_id"] == "package-validation"
    assert payload["checks"][0]["command"]

    unknown = runner.invoke(app, ["plugin", "conformance", "--check-id", "missing-check", "--json"])
    assert unknown.exit_code == 1
    assert "unknown plugin conformance check id" in unknown.output
