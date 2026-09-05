from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


CommandRunner = Callable[[list[str], Path], subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class PluginConformanceCheck:
    check_id: str
    section: str
    requirement: str
    command: list[str]
    evidence: list[str]


@dataclass(frozen=True)
class PluginConformanceResult:
    check_id: str
    section: str
    requirement: str
    command: list[str]
    evidence: list[str]
    status: str
    exit_code: int | None


DEFAULT_PLUGIN_CONFORMANCE_CHECKS: tuple[PluginConformanceCheck, ...] = (
    PluginConformanceCheck(
        check_id="package-validation",
        section="22.1",
        requirement="Package validation rejects malformed manifests, digest mismatch, signature mismatch, missing permissions, and wildcard network permissions.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_distribution_pack.py", "tests/test_plugin_local_verification.py"],
        evidence=["tests/test_plugin_distribution_pack.py", "tests/test_plugin_local_verification.py", "schemas/superclaw-plugin.schema.json"],
    ),
    PluginConformanceCheck(
        check_id="developer-devkit",
        section="4.0/19",
        requirement="Developer quickstart tooling scaffolds schema-valid starter packages, runs declared local tools without cloud state, and packs dev-signed archives for local verification exercises.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_devkit.py"],
        evidence=[
            "tests/test_plugin_devkit.py",
            "packages/superclaw/src/superclaw/plugin_devkit.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="local-package-verification",
        section="1/22.1",
        requirement="Local package verification reads directories and scplug archives, verifies stable digests and Ed25519 signatures, rejects tampering, unsafe archives, wrong keys, unsigned packages, and local revocations, and lists verified cache entries.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_local_verification.py"],
        evidence=[
            "tests/test_plugin_local_verification.py",
            "packages/superclaw/src/superclaw/plugins.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="runtime-proxy",
        section="22.2",
        requirement="Runtime proxy enforces proxy-only access, entitlement, revocation, secret, schema, timeout, redaction, and output budget behavior.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_proxy.py", "tests/test_plugin_mcp_proxy.py"],
        evidence=[
            "tests/test_plugin_proxy.py",
            "tests/test_plugin_mcp_proxy.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
            "packages/superclaw/src/superclaw/plugin_mcp_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="runtime-error-contract",
        section="21/22.2",
        requirement="Runtime errors use stable plugin error codes, sanitized model-visible payloads, retryable flags, and evidence ids for policy, sandbox, timeout, schema, and sidecar failures.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_proxy.py", "tests/test_plugin_cloud.py"],
        evidence=[
            "tests/test_plugin_proxy.py",
            "tests/test_plugin_cloud.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="credential-manager",
        section="7.4/22.2",
        requirement="Local credential manager covers config set, secret set/status/delete, user/device scope, version scope, rotation, non-inherited shell secrets, and sanitized output.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_config.py"],
        evidence=[
            "tests/test_plugin_config.py",
            "packages/superclaw/src/superclaw/plugin_config.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="backend-runtime-policy",
        section="24/25",
        requirement="Backend runtime policy projects SuperClaw MCP proxy config to supported agent CLIs, keeps Hermes/OpenClaw fail-closed until projection exists, rejects direct plugin directories, and keeps MCP env secrets out of worker output.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_worker_backends.py"],
        evidence=[
            "tests/test_worker_backends.py",
            "packages/superclaw/src/superclaw/backends.py",
            "packages/superclaw/src/superclaw/runtime.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="adversarial-policy",
        section="24/25",
        requirement="Adversarial verification rejects plugin policy bypass evidence, revoked-success plugin records, and secret-bearing plugin output while allowing proxy-only invocation evidence.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_adversarial.py", "tests/test_adversarial_hardening.py"],
        evidence=[
            "tests/test_adversarial.py",
            "tests/test_adversarial_hardening.py",
            "packages/superclaw/src/superclaw/adversarial.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="extension-ports-contract",
        section="13",
        requirement="Framework extension ports are represented as stable code-level Protocol contracts for cloud client, signature verifier, entitlement, sandbox, MCP proxy, bounty ingestion, developer submission, and credential manager responsibilities without changing runtime behavior.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_ports.py"],
        evidence=[
            "tests/test_plugin_ports.py",
            "packages/superclaw/src/superclaw/plugin_ports.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginConformanceCheck(
        check_id="developer-onboarding-contract",
        section="12",
        requirement="Developer onboarding requires verified identity, payout profile reference, support and vulnerability contacts, license declaration, plugin-policy acceptance, sample evidence fixture, and V1 commerce-state validation without collecting raw payment, identity, or secret fields.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_developer_onboarding.py"],
        evidence=[
            "tests/test_plugin_developer_onboarding.py",
            "packages/superclaw/src/superclaw/plugin_developer_onboarding.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginConformanceCheck(
        check_id="protocol-adapter-plugin-evidence-export",
        section="24",
        requirement="Delivery Protocol manifests export sanitized plugin invocation summaries from existing EvidenceBundle plugin probes and plugin-invocation artifacts without raw payload, path, secret, or source-evidence mutation.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_protocol_adapter.py"],
        evidence=[
            "tests/test_protocol_adapter.py",
            "packages/superclaw/src/superclaw/protocol_adapter.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="runtime-diagnostics",
        section="23",
        requirement="Runtime diagnostics report slow calls, high failure rates, and repeated sandbox kills from local plugin evidence without leaking raw artifacts.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_evidence.py"],
        evidence=[
            "tests/test_plugin_evidence.py",
            "packages/superclaw/src/superclaw/plugin_evidence.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="evidence-retention",
        section="5D/10.4",
        requirement="Local plugin evidence retention lists sanitized invocation summaries, prunes only expired successful records, and refuses to clear locked audit records.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_evidence.py"],
        evidence=[
            "tests/test_plugin_evidence.py",
            "packages/superclaw/src/superclaw/plugin_evidence.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="sandbox",
        section="22.3",
        requirement="Sandbox guardrails reject undeclared filesystem, network, environment, and process behavior before sidecar startup.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_proxy.py", "tests/test_plugin_mcp_proxy.py"],
        evidence=[
            "tests/test_plugin_proxy.py",
            "tests/test_plugin_mcp_proxy.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="cloud-contract",
        section="22.4",
        requirement="Cloud contract covers entitlement sync, offline grace caps, revocation, policy descriptors, policy output limits, evidence-summary privacy, and minimum invocation-summary validation.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud.py", "tests/test_plugin_cloud_api.py"],
        evidence=[
            "tests/test_plugin_cloud.py",
            "tests/test_plugin_cloud_api.py",
            "packages/superclaw/src/superclaw/plugin_cloud.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="cloud-rest-contract",
        section="6/22.4",
        requirement="Local /v1 plugin cloud REST endpoints expose sanitized registry, entitlement, revocation, policy, download-reference, and evidence-summary contracts without leaking local paths or raw evidence.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud_api.py"],
        evidence=[
            "tests/test_plugin_cloud_api.py",
            "apps/api/main.py",
            "packages/superclaw/src/superclaw/plugin_cloud.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="entitlement-governance",
        section="5C/22.4",
        requirement="Offline entitlement governance caps local grace windows, scopes entitlement sync tokens, enforces version ranges, and fails closed before sidecar startup when local governance is stale or overbroad.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud.py", "tests/test_plugin_cloud_api.py"],
        evidence=[
            "tests/test_plugin_cloud.py",
            "tests/test_plugin_cloud_api.py",
            "packages/superclaw/src/superclaw/plugin_cloud.py",
            "packages/superclaw/src/superclaw/plugin_proxy.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="registry-ux",
        section="7.1/22.4",
        requirement="User-facing local registry commands search sanitized fake-cloud metadata and install explicit or latest versions through the verified cloud metadata path without exposing package or cache paths.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud.py"],
        evidence=[
            "tests/test_plugin_cloud.py",
            "packages/superclaw/src/superclaw/plugin_cloud.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="developer-upload",
        section="6.6/26",
        requirement="Developer upload intake validates developer-source packages, blocks secrets, missing dependency attestations, failing smoke tests, and missing signing keys, and signs only packages that pass all local gates.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_submission.py"],
        evidence=[
            "tests/test_plugin_submission.py",
            "packages/superclaw/src/superclaw/plugin_submission.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="developer-submission-rest",
        section="6.6/22.4",
        requirement="Local developer submission REST contract creates submissions, attaches local package artifacts through the Phase 4A review path, returns sanitized verification metadata, and omits local paths, signing private keys, cache paths, entitlement tokens, and secrets.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_cloud_api.py", "tests/test_plugin_submission.py"],
        evidence=[
            "tests/test_plugin_cloud_api.py",
            "tests/test_plugin_submission.py",
            "apps/api/main.py",
            "packages/superclaw/src/superclaw/plugin_submission.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="plugin-update-preflight",
        section="10.3/4B",
        requirement="Local plugin update preflight classifies SemVer update risk, maps schema, permission, runtime, commerce, and major-version changes to required review gates, and emits sanitized review records without signing, marketplace, payment, cloud policy, cache mutation, replay, or sandbox execution.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_updates.py"],
        evidence=[
            "tests/test_plugin_updates.py",
            "packages/superclaw/src/superclaw/plugin_updates.py",
            "packages/superclaw/src/superclaw/cli.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginConformanceCheck(
        check_id="clawhunt-ingestion",
        section="22.5",
        requirement="ClawHunt ingestion converts accepted reusable deliveries, rejects one-off or missing-evidence deliveries, emits replay/MCP contract files, and records revenue attribution.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_ingestion.py"],
        evidence=[
            "tests/test_plugin_ingestion.py",
            "packages/superclaw/src/superclaw/plugin_ingestion.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="release-checklist",
        section="25",
        requirement="Local release checklist maps Section 25 release criteria to conformance coverage and explicit manual gates without leaking raw command output.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_release.py"],
        evidence=[
            "tests/test_plugin_release.py",
            "packages/superclaw/src/superclaw/plugin_release.py",
            "packages/superclaw/src/superclaw/cli.py",
        ],
    ),
    PluginConformanceCheck(
        check_id="engineering-workflow-gate",
        section="27",
        requirement="Local workflow gate proves feature boundary, tests, documentation, Gemini, atomic commit, PR sync, and version/changelog requirements remain explicit and checkable.",
        command=[".venv/bin/python", "-m", "pytest", "tests/test_plugin_workflow.py"],
        evidence=[
            "tests/test_plugin_workflow.py",
            "packages/superclaw/src/superclaw/plugin_workflow.py",
            "packages/superclaw/src/superclaw/cli.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
)


def run_plugin_conformance(
    *,
    repo_root: Path,
    run: bool = False,
    check_ids: Iterable[str] | None = None,
    command_runner: CommandRunner | None = None,
    checks: Iterable[PluginConformanceCheck] = DEFAULT_PLUGIN_CONFORMANCE_CHECKS,
) -> list[PluginConformanceResult]:
    selected = _select_checks(checks, check_ids)
    runner = command_runner or _default_runner
    results: list[PluginConformanceResult] = []
    for check in selected:
        if not run:
            results.append(_result(check, "not_run", None))
            continue
        completed = runner(check.command, repo_root)
        status = "passed" if completed.returncode == 0 else "failed"
        results.append(_result(check, status, completed.returncode))
    return results


def plugin_conformance_summary(results: list[PluginConformanceResult]) -> dict[str, int]:
    summary = {"passed": 0, "failed": 0, "not_run": 0}
    for result in results:
        summary[result.status] = summary.get(result.status, 0) + 1
    return summary


def plugin_conformance_payload(results: list[PluginConformanceResult]) -> dict[str, object]:
    return {
        "ok": all(result.status != "failed" for result in results),
        "summary": plugin_conformance_summary(results),
        "checks": [
            {
                "check_id": result.check_id,
                "section": result.section,
                "requirement": result.requirement,
                "command": result.command,
                "evidence": result.evidence,
                "status": result.status,
                "exit_code": result.exit_code,
            }
            for result in results
        ],
    }


def _select_checks(
    checks: Iterable[PluginConformanceCheck],
    check_ids: Iterable[str] | None,
) -> list[PluginConformanceCheck]:
    all_checks = list(checks)
    requested = [str(check_id) for check_id in (check_ids or [])]
    if not requested:
        return all_checks
    by_id = {check.check_id: check for check in all_checks}
    missing = sorted(set(requested) - set(by_id))
    if missing:
        raise ValueError(f"unknown plugin conformance check id: {', '.join(missing)}")
    return [by_id[check_id] for check_id in requested]


def _default_runner(command: list[str], repo_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )


def _result(check: PluginConformanceCheck, status: str, exit_code: int | None) -> PluginConformanceResult:
    return PluginConformanceResult(
        check_id=check.check_id,
        section=check.section,
        requirement=check.requirement,
        command=list(check.command),
        evidence=list(check.evidence),
        status=status,
        exit_code=exit_code,
    )
