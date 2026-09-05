from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Mapping

from superclaw.plugin_conformance import (
    DEFAULT_PLUGIN_CONFORMANCE_CHECKS,
    CommandRunner,
    PluginConformanceCheck,
    run_plugin_conformance,
)


@dataclass(frozen=True)
class PluginReleaseChecklistItem:
    item_id: str
    section: str
    requirement: str
    conformance_checks: list[str]
    evidence: list[str]
    manual_reason: str | None = None


@dataclass(frozen=True)
class PluginManualReleaseEvidence:
    item_id: str
    evidence_uri: str
    verified_by: str
    verified_at: str
    summary: str


@dataclass(frozen=True)
class PluginReleaseChecklistResult:
    item_id: str
    section: str
    requirement: str
    conformance_checks: list[str]
    evidence: list[str]
    status: str
    manual_reason: str | None = None
    manual_evidence: PluginManualReleaseEvidence | None = None


DEFAULT_PLUGIN_RELEASE_CHECKLIST: tuple[PluginReleaseChecklistItem, ...] = (
    PluginReleaseChecklistItem(
        item_id="schema-versioned",
        section="25",
        requirement="Package schema is versioned.",
        conformance_checks=["package-validation"],
        evidence=["schemas/superclaw-plugin.schema.json", "tests/test_plugin_distribution_pack.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="json-schema-fixtures",
        section="25",
        requirement="JSON Schema fixtures pass.",
        conformance_checks=["package-validation", "developer-devkit"],
        evidence=[
            "schemas/superclaw-plugin.schema.json",
            "tests/test_plugin_distribution_pack.py",
            "tests/test_plugin_devkit.py",
        ],
    ),
    PluginReleaseChecklistItem(
        item_id="configuration-policy-schema",
        section="25",
        requirement="Configuration policy schema fixtures pass.",
        conformance_checks=["credential-manager"],
        evidence=["schemas/plugin-configuration-policy.schema.json", "tests/test_plugin_config.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="output-schema-validation",
        section="25",
        requirement="Tool output schema validation rejects malformed sidecar output.",
        conformance_checks=["runtime-proxy"],
        evidence=["tests/test_plugin_proxy.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="signature-tamper-rejection",
        section="25",
        requirement="Signature verifier rejects tampered packages.",
        conformance_checks=["package-validation", "local-package-verification"],
        evidence=["tests/test_plugin_local_verification.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="revocation-blocks-cached",
        section="25",
        requirement="Revocation blocks cached plugin execution.",
        conformance_checks=["local-package-verification", "cloud-contract"],
        evidence=["tests/test_plugin_local_verification.py", "tests/test_plugin_cloud.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="entitlement-before-startup",
        section="25",
        requirement="Entitlement denial happens before sidecar startup.",
        conformance_checks=["runtime-proxy", "cloud-contract"],
        evidence=["tests/test_plugin_proxy.py", "tests/test_plugin_cloud.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="missing-secret-config-required",
        section="25",
        requirement="Missing required plugin secret returns PLUGIN_CONFIG_REQUIRED before sidecar startup.",
        conformance_checks=["credential-manager", "runtime-proxy"],
        evidence=["tests/test_plugin_config.py", "tests/test_plugin_proxy.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="runtime-config-secret-free",
        section="25",
        requirement="Generated runtime config does not contain plugin secret values.",
        conformance_checks=["credential-manager", "backend-runtime-policy"],
        evidence=["tests/test_plugin_config.py", "tests/test_worker_backends.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="offline-grace-cap",
        section="25",
        requirement="Offline entitlement grace cannot exceed the 72-hour policy maximum.",
        conformance_checks=["entitlement-governance", "cloud-contract"],
        evidence=["tests/test_plugin_cloud.py", "tests/test_plugin_cloud_api.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="cloud-rest-contract-required",
        section="25",
        requirement="Local /v1 plugin cloud REST endpoints expose sanitized registry, entitlement, revocation, policy, download-reference, and evidence-summary contracts without raw evidence, local path, or secret leakage.",
        conformance_checks=["cloud-rest-contract"],
        evidence=["tests/test_plugin_cloud_api.py", "apps/api/main.py", "packages/superclaw/src/superclaw/plugin_cloud.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="registry-ux-required",
        section="25",
        requirement="Local plugin registry search and install commands expose sanitized metadata, resolve explicit or latest versions, and install only through verifier-backed package metadata without leaking package or cache paths.",
        conformance_checks=["registry-ux"],
        evidence=["tests/test_plugin_cloud.py", "packages/superclaw/src/superclaw/plugin_cloud.py", "packages/superclaw/src/superclaw/cli.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="engineering-workflow-gate-required",
        section="25",
        requirement="Section 27 engineering workflow gates for feature boundaries, tests, docs, Gemini review, atomic commits, PR sync, and version/changelog hygiene remain explicit and locally checkable.",
        conformance_checks=["engineering-workflow-gate"],
        evidence=["tests/test_plugin_workflow.py", "packages/superclaw/src/superclaw/plugin_workflow.py", "docs/plugin-ecosystem-framework.md"],
    ),
    PluginReleaseChecklistItem(
        item_id="release-checklist-integrity",
        section="25",
        requirement="Release checklist integrity checks prove Section 25 items map to known conformance checks, existing repo-relative evidence, explicit manual gates, and sanitized JSON output.",
        conformance_checks=["release-checklist"],
        evidence=["tests/test_plugin_release.py", "packages/superclaw/src/superclaw/plugin_release.py", "packages/superclaw/src/superclaw/cli.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="mcp-proxy-nonleakage",
        section="25",
        requirement="MCP proxy hides sidecar path and entitlement token from the underlying agent.",
        conformance_checks=["runtime-proxy", "backend-runtime-policy"],
        evidence=["tests/test_plugin_proxy.py", "tests/test_worker_backends.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="extension-ports-contract-required",
        section="25",
        requirement="Section 13 framework extension ports remain represented as explicit code-level contracts before product UI or production adapters depend on them.",
        conformance_checks=["extension-ports-contract"],
        evidence=[
            "tests/test_plugin_ports.py",
            "packages/superclaw/src/superclaw/plugin_ports.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginReleaseChecklistItem(
        item_id="developer-onboarding-contract-required",
        section="25",
        requirement="Section 12 developer onboarding remains a local sanitized contract for verified identity, payout profile reference, contacts, license declaration, plugin-policy acceptance, sample evidence, and V1 commerce state before marketplace payment or payout workflows ship.",
        conformance_checks=["developer-onboarding-contract"],
        evidence=[
            "tests/test_plugin_developer_onboarding.py",
            "packages/superclaw/src/superclaw/plugin_developer_onboarding.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginReleaseChecklistItem(
        item_id="sandbox-preflight-required",
        section="25",
        requirement="Sandbox guardrails reject undeclared filesystem, network, environment, and process behavior before sidecar startup.",
        conformance_checks=["sandbox"],
        evidence=["tests/test_plugin_proxy.py", "tests/test_plugin_mcp_proxy.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="codex-backed-proxy-run",
        section="25",
        requirement="At least one Codex-backed run can call a plugin through the proxy.",
        conformance_checks=["backend-runtime-policy"],
        evidence=["tests/test_worker_backends.py"],
        manual_reason="Requires an operator-observed Codex-backed run outside the local unit-test harness.",
    ),
    PluginReleaseChecklistItem(
        item_id="claude-backed-proxy-run",
        section="25",
        requirement="At least one Claude-backed run can call a plugin through the proxy or documented bridge.",
        conformance_checks=["backend-runtime-policy"],
        evidence=["tests/test_worker_backends.py"],
        manual_reason="Requires an operator-observed Claude-backed run outside the local unit-test harness.",
    ),
    PluginReleaseChecklistItem(
        item_id="clawhunt-reusable-conversion",
        section="25",
        requirement="At least one ClawHunt-derived reusable fixture converts into a plugin package.",
        conformance_checks=["clawhunt-ingestion"],
        evidence=["tests/test_plugin_ingestion.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="clawhunt-oneoff-rejection",
        section="25",
        requirement="At least one one-off ClawHunt delivery fixture is rejected as non-ingestible.",
        conformance_checks=["clawhunt-ingestion"],
        evidence=["tests/test_plugin_ingestion.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="developer-upload-signing",
        section="25",
        requirement="At least one developer-upload fixture passes scan and signing.",
        conformance_checks=["developer-upload"],
        evidence=["tests/test_plugin_submission.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="developer-submission-rest-contract",
        section="25",
        requirement="Local developer submission REST endpoints create submissions, attach local package artifacts through review, and return sanitized verification metadata without leaking local paths, signing private keys, cache paths, entitlement tokens, or secrets.",
        conformance_checks=["developer-submission-rest"],
        evidence=[
            "tests/test_plugin_cloud_api.py",
            "tests/test_plugin_submission.py",
            "apps/api/main.py",
            "packages/superclaw/src/superclaw/plugin_submission.py",
        ],
    ),
    PluginReleaseChecklistItem(
        item_id="plugin-update-preflight-required",
        section="25",
        requirement="Local plugin update compatibility preflight proves candidate versions are classified and mapped to required review gates before signing, cloud policy publication, marketplace listing, payment, cache mutation, replay, or sandbox execution.",
        conformance_checks=["plugin-update-preflight"],
        evidence=[
            "tests/test_plugin_updates.py",
            "packages/superclaw/src/superclaw/plugin_updates.py",
            "packages/superclaw/src/superclaw/cli.py",
            "docs/plugin-ecosystem-framework.md",
        ],
    ),
    PluginReleaseChecklistItem(
        item_id="plugin-call-evidence",
        section="25",
        requirement="Every plugin call writes evidence.",
        conformance_checks=["runtime-proxy", "runtime-diagnostics", "evidence-retention"],
        evidence=["tests/test_plugin_proxy.py", "tests/test_plugin_evidence.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="delivery-protocol-plugin-evidence-export",
        section="25",
        requirement="Delivery Protocol manifests export sanitized plugin invocation evidence without raw payload, path, secret, or source-evidence mutation.",
        conformance_checks=["protocol-adapter-plugin-evidence-export"],
        evidence=["tests/test_protocol_adapter.py", "packages/superclaw/src/superclaw/protocol_adapter.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="model-visible-output-safe",
        section="25",
        requirement="Model-visible output is schema-validated, redacted, and size-limited.",
        conformance_checks=["runtime-proxy", "runtime-error-contract", "adversarial-policy"],
        evidence=["tests/test_plugin_proxy.py", "tests/test_plugin_cloud.py", "tests/test_adversarial.py", "tests/test_adversarial_hardening.py"],
    ),
    PluginReleaseChecklistItem(
        item_id="marketplace-payment-no-go",
        section="25",
        requirement="No marketplace payment UI is released before local signed execution works.",
        conformance_checks=["package-validation", "runtime-proxy"],
        evidence=["docs/plugin-ecosystem-framework.md", "tests/test_plugin_proxy.py"],
        manual_reason="Requires release-manager review that no payment or marketplace UI ships with this release.",
    ),
)


def run_plugin_release_checklist(
    *,
    repo_root: Path,
    run: bool = False,
    manual_evidence: Mapping[str, PluginManualReleaseEvidence] | None = None,
    command_runner: CommandRunner | None = None,
    items: Iterable[PluginReleaseChecklistItem] = DEFAULT_PLUGIN_RELEASE_CHECKLIST,
    checks: Iterable[PluginConformanceCheck] = DEFAULT_PLUGIN_CONFORMANCE_CHECKS,
) -> list[PluginReleaseChecklistResult]:
    item_list = list(items)
    check_list = list(checks)
    validate_plugin_release_checklist(items=item_list, checks=check_list, repo_root=repo_root)
    manual_evidence_by_id = dict(manual_evidence or {})
    validate_manual_release_evidence(
        manual_evidence_by_id,
        items=item_list,
        repo_root=repo_root,
    )
    conformance_status = _conformance_status_by_id(
        repo_root=repo_root,
        run=run,
        command_runner=command_runner,
        item_list=item_list,
        check_list=check_list,
    )

    results: list[PluginReleaseChecklistResult] = []
    for item in item_list:
        evidence_record = manual_evidence_by_id.get(item.item_id)
        if item.manual_reason:
            status = "passed" if evidence_record else "manual"
        elif not run:
            status = "not_run"
        else:
            selected_statuses = [conformance_status[check_id] for check_id in item.conformance_checks]
            status = "failed" if "failed" in selected_statuses else "passed"
        results.append(
            PluginReleaseChecklistResult(
                item_id=item.item_id,
                section=item.section,
                requirement=item.requirement,
                conformance_checks=list(item.conformance_checks),
                evidence=list(item.evidence),
                status=status,
                manual_reason=item.manual_reason,
                manual_evidence=evidence_record,
            )
        )
    return results


def validate_plugin_release_checklist(
    *,
    items: Iterable[PluginReleaseChecklistItem] = DEFAULT_PLUGIN_RELEASE_CHECKLIST,
    checks: Iterable[PluginConformanceCheck] = DEFAULT_PLUGIN_CONFORMANCE_CHECKS,
    repo_root: Path | None = None,
) -> None:
    check_ids = {check.check_id for check in checks}
    seen_item_ids: set[str] = set()
    root = repo_root or Path(".")
    for item in items:
        if not item.item_id or item.item_id.strip() != item.item_id:
            raise ValueError("release checklist item id must be non-empty and trimmed")
        if item.item_id in seen_item_ids:
            raise ValueError(f"duplicate release checklist item id: {item.item_id}")
        seen_item_ids.add(item.item_id)
        if item.section != "25":
            raise ValueError(f"release checklist item {item.item_id} must map to Section 25")
        if not item.requirement:
            raise ValueError(f"release checklist item {item.item_id} must have a requirement")
        if not item.conformance_checks:
            raise ValueError(f"release checklist item {item.item_id} must map to at least one conformance check")
        missing_checks = sorted(set(item.conformance_checks) - check_ids)
        if missing_checks:
            raise ValueError(
                f"release checklist item {item.item_id} references unknown conformance checks: "
                f"{', '.join(missing_checks)}"
            )
        if not item.evidence:
            raise ValueError(f"release checklist item {item.item_id} must list evidence")
        for evidence in item.evidence:
            evidence_path = Path(evidence)
            if evidence_path.is_absolute() or ".." in evidence_path.parts:
                raise ValueError(f"release checklist item {item.item_id} has unsafe evidence path: {evidence}")
            if not (root / evidence_path).exists():
                raise ValueError(f"release checklist item {item.item_id} evidence does not exist: {evidence}")


def load_manual_release_evidence(evidence_path: Path, *, repo_root: Path) -> dict[str, PluginManualReleaseEvidence]:
    try:
        raw = json.loads(evidence_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"manual release evidence file cannot be read: {evidence_path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"manual release evidence file is invalid JSON: {evidence_path}") from exc
    if not isinstance(raw, dict):
        raise ValueError("manual release evidence must be a JSON object")
    gate_rows = raw.get("manual_gates")
    if not isinstance(gate_rows, list):
        raise ValueError("manual release evidence must contain manual_gates array")

    evidence_by_id: dict[str, PluginManualReleaseEvidence] = {}
    for index, row in enumerate(gate_rows):
        if not isinstance(row, dict):
            raise ValueError(f"manual release evidence row {index} must be an object")
        evidence = PluginManualReleaseEvidence(
            item_id=_required_string(row, "item_id", index),
            evidence_uri=_required_string(row, "evidence_uri", index),
            verified_by=_required_string(row, "verified_by", index),
            verified_at=_required_string(row, "verified_at", index),
            summary=_required_string(row, "summary", index),
        )
        if evidence.item_id in evidence_by_id:
            raise ValueError(f"duplicate manual release evidence item id: {evidence.item_id}")
        evidence_by_id[evidence.item_id] = evidence

    validate_manual_release_evidence(evidence_by_id, repo_root=repo_root)
    return evidence_by_id


def validate_manual_release_evidence(
    evidence_by_id: Mapping[str, PluginManualReleaseEvidence],
    *,
    items: Iterable[PluginReleaseChecklistItem] = DEFAULT_PLUGIN_RELEASE_CHECKLIST,
    repo_root: Path,
) -> None:
    item_by_id = {item.item_id: item for item in items}
    manual_item_ids = {item.item_id for item in item_by_id.values() if item.manual_reason}
    for item_id, evidence in evidence_by_id.items():
        if item_id != evidence.item_id:
            raise ValueError(f"manual release evidence key does not match item id: {item_id}")
        if item_id not in item_by_id:
            raise ValueError(f"manual release evidence references unknown checklist item: {item_id}")
        if item_id not in manual_item_ids:
            raise ValueError(f"manual release evidence is only accepted for manual gate items: {item_id}")
        _validate_manual_evidence_uri(evidence.evidence_uri, repo_root=repo_root, item_id=item_id)
        _validate_iso_timestamp(evidence.verified_at, item_id=item_id)
        if len(evidence.summary) > 240:
            raise ValueError(f"manual release evidence summary is too long for item: {item_id}")


def plugin_release_checklist_summary(results: list[PluginReleaseChecklistResult]) -> dict[str, int]:
    summary = {"passed": 0, "failed": 0, "manual": 0, "not_run": 0}
    for result in results:
        summary[result.status] = summary.get(result.status, 0) + 1
    return summary


def plugin_release_checklist_payload(results: list[PluginReleaseChecklistResult]) -> dict[str, object]:
    summary = plugin_release_checklist_summary(results)
    return {
        "ok": summary.get("failed", 0) == 0,
        "release_ready": summary.get("failed", 0) == 0
        and summary.get("manual", 0) == 0
        and summary.get("not_run", 0) == 0,
        "summary": summary,
        "items": [
            {
                "item_id": result.item_id,
                "section": result.section,
                "requirement": result.requirement,
                "conformance_checks": result.conformance_checks,
                "evidence": result.evidence,
                "status": result.status,
                "manual_reason": result.manual_reason,
                "manual_evidence": _manual_evidence_payload(result.manual_evidence),
            }
            for result in results
        ],
    }


def _conformance_status_by_id(
    *,
    repo_root: Path,
    run: bool,
    command_runner: CommandRunner | None,
    item_list: list[PluginReleaseChecklistItem],
    check_list: list[PluginConformanceCheck],
) -> dict[str, str]:
    check_ids = sorted({check_id for item in item_list for check_id in item.conformance_checks})
    results = run_plugin_conformance(
        repo_root=repo_root,
        run=run,
        check_ids=check_ids,
        command_runner=command_runner,
        checks=check_list,
    )
    return {result.check_id: result.status for result in results}


def _required_string(row: dict[str, object], field: str, index: int) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value.strip() or value.strip() != value:
        raise ValueError(f"manual release evidence row {index} field {field} must be a non-empty trimmed string")
    if "\n" in value or "\r" in value:
        raise ValueError(f"manual release evidence row {index} field {field} must be a single line")
    return value


def _validate_manual_evidence_uri(evidence_uri: str, *, repo_root: Path, item_id: str) -> None:
    if "://" in evidence_uri:
        scheme = evidence_uri.split("://", 1)[0]
        if scheme not in {"https", "gh"}:
            raise ValueError(f"manual release evidence URI scheme is not allowed for item {item_id}: {scheme}")
        return
    evidence_path = Path(evidence_uri)
    if evidence_path.is_absolute() or ".." in evidence_path.parts:
        raise ValueError(f"manual release evidence path is unsafe for item {item_id}: {evidence_uri}")
    if not (repo_root / evidence_path).exists():
        raise ValueError(f"manual release evidence path does not exist for item {item_id}: {evidence_uri}")


def _validate_iso_timestamp(timestamp: str, *, item_id: str) -> None:
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"manual release evidence verified_at is not ISO-8601 for item {item_id}") from exc


def _manual_evidence_payload(evidence: PluginManualReleaseEvidence | None) -> dict[str, str] | None:
    if evidence is None:
        return None
    return {
        "evidence_uri": evidence.evidence_uri,
        "verified_by": evidence.verified_by,
        "verified_at": evidence.verified_at,
        "summary": evidence.summary,
    }
