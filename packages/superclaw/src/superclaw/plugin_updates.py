from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from superclaw.plugins import MANIFEST_NAME, compute_package_digest, load_plugin_package


UPDATE_PREFLIGHT_RECORD_NAME = "plugin-update-preflight.json"


class PluginUpdateReviewError(ValueError):
    """Raised when a plugin update cannot be compared safely."""


@dataclass(frozen=True)
class PluginUpdateReviewResult:
    plugin_id: str
    previous_version: str
    candidate_version: str
    status: str
    automated_review_allowed: bool
    review_path: Path | None
    record: dict[str, Any]


def review_plugin_update(
    previous_package_path: Path,
    candidate_package_path: Path,
    *,
    output_dir: Path | None = None,
) -> PluginUpdateReviewResult:
    """Compare two local plugin packages and emit a sanitized update-review record."""
    previous = load_plugin_package(previous_package_path)
    candidate = load_plugin_package(candidate_package_path)
    try:
        previous_manifest = previous.manifest
        candidate_manifest = candidate.manifest
        previous_plugin_id = str(previous_manifest.get("id") or "")
        candidate_plugin_id = str(candidate_manifest.get("id") or "")
        if not previous_plugin_id or previous_plugin_id != candidate_plugin_id:
            raise PluginUpdateReviewError("previous and candidate packages must use the same plugin id")
        previous_version = str(previous_manifest.get("version") or "")
        candidate_version = str(candidate_manifest.get("version") or "")
        version_change = _version_change(previous_version, candidate_version)
        findings = _manifest_findings(previous_manifest, candidate_manifest)
        required_reviews = _required_reviews(version_change, findings)
        rejected = version_change["order"] != "increased"
        automated = not rejected and required_reviews == ["automated_tests"]
        status = "rejected" if rejected else ("automated_review_allowed" if automated else "manual_review_required")
        record = {
            "schema_version": "0.1.0",
            "review_type": "plugin_update_compatibility_preflight",
            "plugin_id": previous_plugin_id,
            "previous_version": previous_version,
            "candidate_version": candidate_version,
            "status": status,
            "automated_review_allowed": automated,
            "review_level": "automated" if automated else "manual",
            "version_change": version_change,
            "package_digests": {
                "previous": _safe_digest(previous),
                "candidate": _safe_digest(candidate),
            },
            "findings": findings,
            "required_reviews": required_reviews,
            "side_by_side_required": "side_by_side_install" in required_reviews,
            "out_of_scope": [
                "production_signing",
                "cloud_policy_publish",
                "marketplace_listing",
                "entitlement_sync",
                "payment",
                "sidecar_replay_execution",
                "sandbox_execution",
            ],
        }
        review_path = _write_review_record(record, output_dir) if output_dir else None
        return PluginUpdateReviewResult(
            plugin_id=previous_plugin_id,
            previous_version=previous_version,
            candidate_version=candidate_version,
            status=status,
            automated_review_allowed=automated,
            review_path=review_path,
            record=record,
        )
    finally:
        previous.cleanup()
        candidate.cleanup()


def _manifest_findings(previous: dict[str, Any], candidate: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    findings.extend(_tool_contract_findings(previous, candidate))
    findings.extend(_permission_findings(previous, candidate))
    if _canonical(previous.get("runtime", {})) != _canonical(candidate.get("runtime", {})):
        findings.append(
            {
                "kind": "runtime_contract_changed",
                "severity": "review_required",
                "required_review": "sandbox_smoke",
                "detail": "runtime metadata changed; sandbox smoke verification is required before signing",
            }
        )
    if _canonical(previous.get("commerce", {})) != _canonical(candidate.get("commerce", {})):
        findings.append(
            {
                "kind": "commerce_contract_changed",
                "severity": "review_required",
                "required_review": "commerce_review",
                "detail": "pricing, metering, or entitlement-facing commerce metadata changed",
            }
        )
    return findings


def _tool_contract_findings(previous: dict[str, Any], candidate: dict[str, Any]) -> list[dict[str, Any]]:
    previous_tools = _tools_by_name(previous)
    candidate_tools = _tools_by_name(candidate)
    findings: list[dict[str, Any]] = []
    removed = sorted(set(previous_tools) - set(candidate_tools))
    added = sorted(set(candidate_tools) - set(previous_tools))
    if added or removed:
        findings.append(
            {
                "kind": "tool_set_changed",
                "severity": "review_required",
                "required_review": "compatibility_review",
                "detail": f"tool set changed; added={added or []}; removed={removed or []}",
            }
        )
    for name in sorted(set(previous_tools) & set(candidate_tools)):
        previous_tool = previous_tools[name]
        candidate_tool = candidate_tools[name]
        if _canonical(previous_tool.get("input_schema")) != _canonical(candidate_tool.get("input_schema")):
            findings.append(
                {
                    "kind": "tool_input_schema_changed",
                    "tool": name,
                    "severity": "review_required",
                    "required_review": "compatibility_review",
                    "detail": "tool input schema changed; compatibility review is required",
                }
            )
        if _canonical(previous_tool.get("output_schema")) != _canonical(candidate_tool.get("output_schema")):
            findings.append(
                {
                    "kind": "tool_output_schema_changed",
                    "tool": name,
                    "severity": "review_required",
                    "required_review": "evidence_replay",
                    "detail": "tool output schema changed; replay against existing evidence fixtures is required",
                }
            )
    return findings


def _permission_findings(previous: dict[str, Any], candidate: dict[str, Any]) -> list[dict[str, Any]]:
    previous_permissions = previous.get("permissions", {})
    candidate_permissions = candidate.get("permissions", {})
    findings: list[dict[str, Any]] = []
    for permission_type in ("filesystem", "network", "environment", "process"):
        previous_items = _stable_item_set(previous_permissions.get(permission_type, []))
        candidate_items = _stable_item_set(candidate_permissions.get(permission_type, []))
        added = sorted(candidate_items - previous_items)
        if added:
            findings.append(
                {
                    "kind": f"{permission_type}_permission_added",
                    "severity": "review_required",
                    "required_review": "security_review",
                    "detail": f"new {permission_type} permission requires security review",
                    "added_count": len(added),
                }
            )
    return findings


def _required_reviews(version_change: dict[str, Any], findings: list[dict[str, Any]]) -> list[str]:
    reviews = {"automated_tests"}
    if version_change["kind"] == "major":
        reviews.add("side_by_side_install")
    for finding in findings:
        required = finding.get("required_review")
        if required:
            reviews.add(str(required))
    ordered = [
        "automated_tests",
        "compatibility_review",
        "evidence_replay",
        "security_review",
        "sandbox_smoke",
        "commerce_review",
        "side_by_side_install",
    ]
    return [review for review in ordered if review in reviews]


def _version_change(previous_version: str, candidate_version: str) -> dict[str, Any]:
    previous = _parse_semver(previous_version)
    candidate = _parse_semver(candidate_version)
    if previous is None or candidate is None:
        return {
            "kind": "invalid",
            "order": "invalid",
            "detail": "previous and candidate versions must be MAJOR.MINOR.PATCH",
        }
    if candidate <= previous:
        return {
            "kind": "non_increasing",
            "order": "not_increased",
            "detail": "candidate version must be greater than previous version",
        }
    if candidate[0] != previous[0]:
        kind = "major"
    elif candidate[1] != previous[1]:
        kind = "minor"
    else:
        kind = "patch"
    return {"kind": kind, "order": "increased", "detail": f"{previous_version} -> {candidate_version}"}


def _parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value)
    if not match:
        return None
    return tuple(int(group) for group in match.groups())


def _tools_by_name(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(tool.get("name")): tool for tool in manifest.get("tools", []) if isinstance(tool, dict)}


def _stable_item_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {_canonical(item) for item in value}


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _safe_digest(package: Any) -> str:
    try:
        return compute_package_digest(package)
    except Exception:
        manifest_path = package.root / MANIFEST_NAME
        if manifest_path.exists():
            return "sha256:" + hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        return "sha256:" + ("0" * 64)


def _write_review_record(record: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / UPDATE_PREFLIGHT_RECORD_NAME
    path.write_text(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path
