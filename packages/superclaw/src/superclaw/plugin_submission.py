from __future__ import annotations

import json
import base64
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from jsonschema import Draft202012Validator, ValidationError

from superclaw.models import _id
from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract
from superclaw.process_scripts import command_for_script, script_is_runnable
from superclaw.plugin_timeouts import floor_default_timeout_seconds
from superclaw.plugins import (
    _reject_shipped_pycache,
    compute_package_digest,
    load_plugin_package,
)
from superclaw.secrets_scan import contains_secret


REVIEW_RECORD_NAME = "developer-upload-review.json"
MCP_SERVER_CONFIG_NAME = "mcp/server.json"
def _safe_review_base_path() -> str:
    """Minimal sanitized base PATH for the plugin-review child process.

    POSIX system bin dirs; on Windows the System32 dirs (the "/usr/bin:/bin"
    equivalent) so the child is not handed an effectively-empty PATH.
    """
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
        return os.pathsep.join(
            os.path.join(system_root, *parts)
            for parts in ((), ("System32",), ("System32", "Wbem"), ("System32", "WindowsPowerShell", "v1.0"))
        )
    return "/usr/bin:/bin:/usr/sbin:/sbin"


SAFE_REVIEW_PATH = _safe_review_base_path()
TEXT_SCAN_SUFFIXES = {
    ".json",
    ".md",
    ".txt",
    ".toml",
    ".yaml",
    ".yml",
    ".py",
    ".js",
    ".ts",
    ".sh",
    ".env",
}
LOCK_OR_SBOM_FILES = {
    "sbom.spdx.json",
    "sbom.cdx.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "requirements.lock",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
}
VULNERABILITY_FIXTURE_FILES = {
    "dependency-vulnerabilities.json",
    "sbom.cdx.json",
    "sbom.spdx.json",
}
BLOCKING_VULNERABILITY_SEVERITIES = {"critical", "high"}
KNOWN_VULNERABILITY_SEVERITIES = {"none", "low", "medium", "moderate", "high", "critical"}
DEPENDENCY_DECLARATION_FILES = {
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
}
REQUIRED_SUBMISSION_DOCS = {
    "support_contact_present": ("SUPPORT.md", "support.md", ".github/SUPPORT.md"),
    "license_declaration_present": ("LICENSE", "LICENSE.md", "license.md"),
    "permission_justification_present": ("PERMISSIONS.md", "permissions.md"),
    "security_notes_present": ("SECURITY.md", "security.md"),
    "changelog_present": ("CHANGELOG.md", "changelog.md"),
}
ROOT_LLM_ENV_NAMES = {
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "COHERE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "OPENAI_API_KEY",
}
MANIFEST_SECRET_VALUE_FIELD_NAMES = {
    "access_token",
    "api_key",
    "auth_token",
    "client_secret",
    "default_secret",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "secret_value",
    "secret_values",
    "token",
    "value",
}
MANIFEST_SECRET_SETTING_NAMES = {
    "access_token",
    "api_key",
    "auth_token",
    "client_secret",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "token",
}
USAGE_METERED_METERING_MODES = {"duration", "usage_units"}
RUNTIME_DOWNLOAD_PATTERNS = (
    re.compile(r"\b(?:curl|wget)\b[^\n|;]*(?:\||\bsh\b|\bbash\b|\bpython\b|\bnode\b)", re.IGNORECASE),
    re.compile(r"\bpip\s+install\s+(?:git\+|https?://)", re.IGNORECASE),
    re.compile(r"\b(?:npm|pnpm|yarn)\s+(?:add|install)\s+https?://", re.IGNORECASE),
    re.compile(r"\b(?:exec|eval)\s*\([^)]*(?:requests\.get|urllib\.request\.urlopen)\s*\(", re.IGNORECASE),
)
SCRIPT_SCAN_SUFFIXES = {".sh", ".py", ".js", ".ts", ".mjs", ".cjs"}
THIRD_PARTY_MARKERS = {
    "node_modules",
    "vendor",
    "third_party",
    ".venv",
    "site-packages",
}


class DeveloperUploadReviewError(ValueError):
    """Raised when a developer upload package cannot be reviewed."""


@dataclass(frozen=True)
class DeveloperUploadReviewResult:
    plugin_id: str
    version: str
    status: str
    ready_for_signing: bool
    review_path: Path | None
    record: dict[str, Any]


@dataclass(frozen=True)
class DeveloperUploadSubmissionResult:
    submission_id: str
    plugin_id: str
    version: str
    status: str
    ready_for_signing: bool
    review_path: Path
    signed_package_path: Path | None
    record: dict[str, Any]


def _store_submission_blob(package_path: Path, blob_dir: Path) -> str:
    """Store an IMMUTABLE copy of the exact submitted package and return its
    content-addressed digest. Signing later reads from this copy, never a
    caller-supplied path that could change after review."""
    package = load_plugin_package(package_path)
    try:
        if blob_dir.exists():
            shutil.rmtree(blob_dir)
        shutil.copytree(package.root, blob_dir)
    finally:
        package.cleanup()
    stored = load_plugin_package(blob_dir)
    try:
        return compute_package_digest(stored)
    finally:
        stored.cleanup()


def _submission_blob_dir(submission_dir: Path) -> Path:
    return submission_dir / "package"


def _require_submission_blob_dir(submission_dir: Path) -> Path:
    blob_dir = _submission_blob_dir(submission_dir)
    if blob_dir.is_symlink():
        raise DeveloperUploadReviewError("stored submission blob must not be a symlink")
    if not blob_dir.is_dir():
        raise DeveloperUploadReviewError(f"submission {submission_dir.name} has no stored blob to sign")
    submission_root = submission_dir.resolve()
    blob_root = blob_dir.resolve()
    if submission_root not in blob_root.parents:
        raise DeveloperUploadReviewError("stored submission blob escapes the submission directory")
    return blob_dir


def _require_recorded_blob_path_matches(record: dict[str, Any], submission_dir: Path, blob_dir: Path) -> None:
    recorded = record.get("blob_path")
    if not recorded:
        return
    recorded_path = Path(str(recorded))
    if not recorded_path.is_absolute():
        recorded_path = submission_dir / recorded_path
    if recorded_path.resolve() != blob_dir.resolve():
        raise DeveloperUploadReviewError("review record blob_path does not match the immutable submission blob")


def _require_reviewed_digest(record: dict[str, Any], digest: str, field: str) -> None:
    expected = record.get(field)
    if not expected:
        raise DeveloperUploadReviewError(f"review record is missing {field}; refusing to sign")
    if expected != digest:
        raise DeveloperUploadReviewError(f"stored blob digest does not match reviewed {field}; refusing to sign")


def submit_developer_plugin_upload(
    package_path: Path,
    *,
    submission_root: Path,
    schema_path: Path | None = None,
    smoke_timeout_seconds: float | None = None,
    submission_id: str | None = None,
) -> DeveloperUploadSubmissionResult:
    """Create a Phase 4A developer-upload submission. **SUBMIT NEVER SIGNS.**

    Submission runs the preflight review gates and stores an immutable copy of the
    package (the blob) + its digest. ``status`` is the review outcome
    (``ready_for_signing`` or ``rejected``) — NEVER ``verified``. Signing is a
    separate, post-review step (:func:`sign_reviewed_submission`) that holds the key
    on its own; this closes the old "any private key passed to submit → status
    verified" bypass (roadmap §8.3: submit must not carry a signing key)."""
    submission_id = submission_id or _id("plugsub")
    submission_dir = submission_root / submission_id
    submission_dir.mkdir(parents=True, exist_ok=False)
    review = review_developer_plugin_upload(
        package_path,
        output_dir=None,
        schema_path=schema_path,
        smoke_timeout_seconds=smoke_timeout_seconds,
    )
    blob_dir = _submission_blob_dir(submission_dir)
    blob_digest = _store_submission_blob(package_path, blob_dir)
    record = {
        **review.record,
        "submission_id": submission_id,
        "kind": "plugin",
        "capability_id": review.plugin_id,
        "status": review.status,  # ready_for_signing | rejected — NEVER verified at submit
        "capability_status": "ready_for_review" if review.ready_for_signing else "rejected",
        "ready_for_signing": review.ready_for_signing,
        "ready_for_review": review.ready_for_signing,
        "signed_package_path": None,
        "signing_public_key": None,
        "signature_issued": False,
        "blob_path": str(blob_dir),
        "artifact_blob_digest": blob_digest,
    }
    review_path = _write_review_record(record, submission_dir)
    return DeveloperUploadSubmissionResult(
        submission_id=submission_id,
        plugin_id=review.plugin_id,
        version=review.version,
        status=str(record["status"]),
        ready_for_signing=bool(record["ready_for_signing"]),
        review_path=review_path,
        signed_package_path=None,
        record=record,
    )


def sign_reviewed_submission(
    submission_id: str,
    *,
    submission_root: Path,
    signing_private_key: str,
) -> dict[str, Any]:
    """Isolated post-review signing step — the ONLY place a submission is signed.

    Requires the submission passed review (``status == ready_for_signing``),
    RECOMPUTES the digest from the stored immutable blob (never trusting the record's
    declared digest), signs with the official key, then marks ``verified``. Keeping
    this separate from submit/review is what closes the "any key → verified" bypass:
    the submit/review path never holds a signing key, and signing always re-derives
    the digest from the stored bytes."""
    submission_dir = submission_root / submission_id
    record_path = submission_dir / REVIEW_RECORD_NAME
    if not record_path.exists():
        raise DeveloperUploadReviewError(f"submission not found: {submission_id}")
    record = json.loads(record_path.read_text(encoding="utf-8"))
    if record.get("status") != "ready_for_signing":
        raise DeveloperUploadReviewError(
            f"submission {submission_id} is not ready for signing (status={record.get('status')})"
        )
    blob_dir = _require_submission_blob_dir(submission_dir)
    _require_recorded_blob_path_matches(record, submission_dir, blob_dir)
    stored = load_plugin_package(blob_dir)
    try:
        digest = compute_package_digest(stored)
    finally:
        stored.cleanup()
    _require_reviewed_digest(record, digest, "artifact_blob_digest")
    _require_reviewed_digest(record, digest, "package_digest")
    signed_path, public_key = _sign_package_copy(blob_dir, submission_dir / "signed-package", signing_private_key)
    record["status"] = "verified"
    record["capability_status"] = "verified"
    record["signed_package_path"] = str(signed_path)
    record["signing_public_key"] = public_key
    record["signature_issued"] = True
    record.setdefault("gates", []).append(
        _gate("isolated_signature_issued", True, "signed after review by the isolated signing step")
    )
    record.update(_developer_review_classification(record.get("requested_acceptance_level", "L1"), record["gates"], signed=True))
    _write_review_record(record, submission_dir)
    return record


def get_developer_plugin_submission(submission_id: str, *, submission_root: Path) -> dict[str, Any]:
    path = submission_root / submission_id / REVIEW_RECORD_NAME
    if not path.exists():
        raise DeveloperUploadReviewError(f"submission not found: {submission_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def review_developer_plugin_upload(
    package_path: Path,
    *,
    output_dir: Path | None = None,
    schema_path: Path | None = None,
    smoke_timeout_seconds: float | None = None,
) -> DeveloperUploadReviewResult:
    """Run local Phase 4A preflight gates for a developer-uploaded package."""
    package = load_plugin_package(package_path)
    try:
        manifest = package.manifest
        plugin_id = str(manifest.get("id") or "unknown")
        version = str(manifest.get("version") or "unknown")
        gates = [
            _manifest_gate(manifest, schema_path),
            _configuration_contract_gate(manifest),
            _developer_source_gate(manifest),
            _entrypoint_gate(package.root, manifest),
            _entrypoint_runnable_gate(package.root, manifest),
            _digest_gate(package),
            _static_secret_scan_gate(package.root),
            _dependency_gate(package.root),
            _dependency_vulnerability_policy_gate(package.root),
            *_submission_documentation_gates(package.root),
            _pricing_intent_gate(manifest),
            _root_llm_key_gate(manifest),
            _manifest_secret_values_gate(manifest),
            _secret_descriptor_contract_gate(manifest),
            _runtime_code_download_gate(package.root, manifest),
            _runtime_tool_schema_gate(package.root, manifest),
            _acceptance_test_permission_gate(package.root, manifest),
            _evidence_fixture_gate(package.root, manifest),
            _smoke_test_gate(package.root, manifest, timeout_seconds=smoke_timeout_seconds),
        ]
        ready = all(gate["passed"] for gate in gates)
        status = "ready_for_signing" if ready else "rejected"
        record = {
            "schema_version": "0.1.0",
            "review_type": "developer_upload_local_preflight",
            "plugin_id": plugin_id,
            "version": version,
            "status": status,
            "ready_for_signing": ready,
            "requested_acceptance_level": _requested_acceptance_level(manifest),
            "package_digest": _safe_digest(package),
            "gates": gates,
            "out_of_scope": [
                "production_signing",
                "cloud_registry_upload",
                "entitlement_sync",
                "marketplace_listing",
                "payment",
                "certified_listing",
                "l3_acceptance",
                "manual_security_review",
                "continuous_verification",
            ],
        }
        record.update(_developer_review_classification(record["requested_acceptance_level"], gates, signed=False))
        review_path = _write_review_record(record, output_dir) if output_dir else None
        return DeveloperUploadReviewResult(plugin_id, version, status, ready, review_path, record)
    finally:
        package.cleanup()


def _manifest_gate(manifest: dict[str, Any], schema_path: Path | None) -> dict[str, Any]:
    if schema_path is None:
        schema_path = Path(__file__).resolve().parents[4] / "schemas" / "superclaw-plugin.schema.json"
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(manifest)
    except (ValidationError, OSError, json.JSONDecodeError) as exc:
        return _gate("manifest_valid", False, str(exc))
    return _gate("manifest_valid", True, "manifest validates against schemas/superclaw-plugin.schema.json")


def _configuration_contract_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_manifest_configuration_contract(manifest)
    except PluginConfigurationError as exc:
        return _gate("configuration_contract_valid", False, str(exc))
    return _gate("configuration_contract_valid", True, "plugin configuration descriptors are semantically valid")


def _developer_review_classification(requested_acceptance_level: str, gates: list[dict[str, Any]], *, signed: bool) -> dict[str, Any]:
    gate_map = {str(gate.get("name")): bool(gate.get("passed")) for gate in gates}
    automated_passed = all(gate_map.values())
    acceptance_recommendation = "none"
    if automated_passed and requested_acceptance_level in {"L2", "L3"} and _l2_recommendation_gates_pass(gate_map):
        acceptance_recommendation = "L2"
    elif automated_passed and _l1_recommendation_gates_pass(gate_map):
        acceptance_recommendation = "L1"
    manual_requirements = []
    if requested_acceptance_level == "L3":
        manual_requirements.extend(
            [
                "manual_security_review",
                "adversarial_verification",
                "continuous_verification",
                "commercial_readiness_review",
            ]
        )
    listing_review_level = "Verified" if signed and automated_passed else "Unlisted"
    if listing_review_level == "Verified":
        reason = "automated gates passed and local signed package artifact was issued"
    elif automated_passed:
        reason = "automated gates passed; local signature is still required before Verified listing"
    else:
        reason = "one or more automated gates failed; package remains Unlisted"
    return {
        "listing_review_level": listing_review_level,
        "listing_review_reason": reason,
        "acceptance_recommendation": acceptance_recommendation,
        "certified_allowed": False,
        "l3_allowed": False,
        "manual_requirements": manual_requirements,
    }


def _l1_recommendation_gates_pass(gate_map: dict[str, bool]) -> bool:
    return all(
        gate_map.get(name)
        for name in [
            "manifest_valid",
            "runtime_tool_schema_match",
            "sandbox_smoke_run",
        ]
    )


def _l2_recommendation_gates_pass(gate_map: dict[str, bool]) -> bool:
    return _l1_recommendation_gates_pass(gate_map) and all(
        gate_map.get(name)
        for name in [
            "package_digest_stable",
            "entrypoint_runnable",
            "acceptance_test_permissions_declared",
            "evidence_fixture_present",
        ]
    )


def _requested_acceptance_level(manifest: dict[str, Any]) -> str:
    level = str((manifest.get("acceptance") or {}).get("level") or "L1").upper()
    return level if level in {"L1", "L2", "L3"} else "L1"


def _digest_gate(package: Any) -> dict[str, Any]:
    try:
        digest = compute_package_digest(package)
    except Exception as exc:
        return _gate("package_digest_stable", False, str(exc))
    declared = str(package.manifest.get("provenance", {}).get("package_digest") or "")
    if not declared.startswith("sha256:"):
        return _gate("package_digest_stable", False, "manifest provenance.package_digest must be a sha256 digest")
    if declared not in {digest, "sha256:" + ("0" * 64)}:
        return _gate("package_digest_stable", False, "declared package digest does not match package contents")
    return _gate("package_digest_stable", True, f"computed_digest={digest}")


def _developer_source_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    source = manifest.get("source") or {}
    if source.get("type") != "developer_upload":
        return _gate("developer_source_type", False, "developer upload path requires source.type=developer_upload")
    if not source.get("developer_id"):
        return _gate("developer_source_type", False, "developer upload path requires source.developer_id")
    return _gate("developer_source_type", True, f"developer_id={source.get('developer_id')}")


def _entrypoint_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    entrypoint = str((manifest.get("runtime") or {}).get("entrypoint") or "")
    if Path(entrypoint).is_absolute() or ".." in Path(entrypoint).parts or not entrypoint:
        return _gate("entrypoint_present", False, f"unsafe entrypoint: {entrypoint}")
    path = (root / entrypoint).resolve()
    if root.resolve() not in path.parents or not path.is_file():
        return _gate("entrypoint_present", False, f"missing entrypoint: {entrypoint}")
    return _gate("entrypoint_present", True, f"entrypoint={entrypoint}")


def _entrypoint_runnable_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    entrypoint = str((manifest.get("runtime") or {}).get("entrypoint") or "")
    path = _safe_package_file(root, entrypoint)
    if path is None:
        return _gate("entrypoint_runnable", False, f"unsafe or missing entrypoint: {entrypoint}")
    if not script_is_runnable(path):
        return _gate("entrypoint_runnable", False, f"entrypoint is not executable: {entrypoint}")
    return _gate("entrypoint_runnable", True, f"entrypoint executable={entrypoint}")


def _static_secret_scan_gate(root: Path) -> dict[str, Any]:
    hits: list[str] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.name == REVIEW_RECORD_NAME:
            continue
        try:
            if path.stat().st_size > 2_000_000:  # skip very large blobs
                continue
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:8192]:  # binary file (images/archives) — no text secrets
            continue
        # Scan ANY text file regardless of extension/encoding (.pem, .key, .cfg,
        # extensionless, UTF-16/latin-1, …), not just an allowlist — a secret can
        # hide in any of them. latin-1 decodes every byte losslessly as a fallback.
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1", errors="replace")
        if contains_secret(text):
            hits.append(path.relative_to(root).as_posix())
    if hits:
        return _gate("static_secret_scan", False, f"secret-like values found in: {', '.join(hits)}")
    return _gate("static_secret_scan", True, "no secret-like values found in scanned files")


def _dependency_gate(root: Path) -> dict[str, Any]:
    has_bundled_dependencies = any(path.name in THIRD_PARTY_MARKERS for path in root.rglob("*"))
    has_dependency_declaration = any((root / name).exists() for name in DEPENDENCY_DECLARATION_FILES)
    if not has_bundled_dependencies:
        if not has_dependency_declaration:
            return _gate("dependency_or_sbom_scan", True, "no dependency declaration or bundled third-party dependency marker found")
        if any((root / name).exists() for name in LOCK_OR_SBOM_FILES):
            return _gate("dependency_or_sbom_scan", True, "dependency declaration has lockfile or SBOM")
        return _gate("dependency_or_sbom_scan", False, "dependency declaration requires a lockfile or SBOM")
    if any((root / name).exists() for name in LOCK_OR_SBOM_FILES):
        return _gate("dependency_or_sbom_scan", True, "bundled dependency marker has lockfile or SBOM")
    return _gate("dependency_or_sbom_scan", False, "bundled dependencies require a lockfile or SBOM")


def _dependency_vulnerability_policy_gate(root: Path) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    scanned = 0
    for name in sorted(VULNERABILITY_FIXTURE_FILES):
        path = root / name
        if not path.is_file():
            continue
        scanned += 1
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _gate("dependency_vulnerability_policy", False, f"invalid dependency vulnerability fixture: {name}")
        findings.extend(_extract_vulnerability_findings(payload))
    if not scanned:
        return _gate("dependency_vulnerability_policy", True, "no dependency vulnerability fixture supplied")
    blocking = [finding for finding in findings if finding["severity"] in BLOCKING_VULNERABILITY_SEVERITIES]
    if blocking:
        counts = _vulnerability_counts(blocking)
        ids = ", ".join(finding["id"] for finding in blocking[:5])
        suffix = f"; examples={ids}" if ids else ""
        return _gate(
            "dependency_vulnerability_policy",
            False,
            f"blocking dependency vulnerabilities found: {counts}{suffix}",
        )
    if findings:
        return _gate("dependency_vulnerability_policy", True, f"dependency vulnerability fixture has no blocking findings: {_vulnerability_counts(findings)}")
    return _gate("dependency_vulnerability_policy", True, "dependency vulnerability fixture has no findings")


def _extract_vulnerability_findings(payload: Any) -> list[dict[str, str]]:
    if not isinstance(payload, dict):
        return []
    raw_items: list[Any] = []
    if isinstance(payload.get("vulnerabilities"), list):
        raw_items.extend(payload["vulnerabilities"])
    if isinstance(payload.get("findings"), list):
        raw_items.extend(payload["findings"])
    if isinstance(payload.get("packages"), list):
        for package in payload["packages"]:
            if isinstance(package, dict) and isinstance(package.get("vulnerabilities"), list):
                raw_items.extend(package["vulnerabilities"])
    findings: list[dict[str, str]] = []
    for item in raw_items:
        finding = _normalize_vulnerability_finding(item)
        if finding:
            findings.append(finding)
    return findings


def _normalize_vulnerability_finding(item: Any) -> dict[str, str] | None:
    if not isinstance(item, dict):
        return None
    severity = _vulnerability_severity(item)
    if severity not in KNOWN_VULNERABILITY_SEVERITIES:
        return None
    finding_id = _safe_vulnerability_id(item)
    return {"id": finding_id, "severity": severity}


def _vulnerability_severity(item: dict[str, Any]) -> str:
    for key in ("severity", "cvss_severity", "rating"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    ratings = item.get("ratings")
    if isinstance(ratings, list):
        for rating in ratings:
            if isinstance(rating, dict):
                value = rating.get("severity")
                if isinstance(value, str) and value.strip():
                    return value.strip().lower()
    return ""


def _safe_vulnerability_id(item: dict[str, Any]) -> str:
    raw = str(item.get("id") or item.get("cve") or item.get("vulnerability_id") or "unknown")
    sanitized = re.sub(r"[^A-Za-z0-9_.:-]", "_", raw)[:80]
    return sanitized or "unknown"


def _vulnerability_counts(findings: list[dict[str, str]]) -> str:
    counts: dict[str, int] = {}
    for finding in findings:
        counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1
    ordered = ["critical", "high", "medium", "moderate", "low", "none"]
    parts = [f"{severity}={counts[severity]}" for severity in ordered if severity in counts]
    return " ".join(parts)


def _submission_documentation_gates(root: Path) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    for gate_name, candidates in REQUIRED_SUBMISSION_DOCS.items():
        found = next((candidate for candidate in candidates if _has_nonempty_file(root / candidate)), None)
        if found:
            gates.append(_gate(gate_name, True, f"{found} present"))
        else:
            gates.append(_gate(gate_name, False, f"missing one of: {', '.join(candidates)}"))
    return gates


def _has_nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and bool(path.read_text(encoding="utf-8").strip())
    except UnicodeDecodeError:
        return False


def _pricing_intent_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    commerce = manifest.get("commerce") if isinstance(manifest.get("commerce"), dict) else {}
    pricing_model = str(commerce.get("pricing_model") or "")
    metering = str(commerce.get("metering") or "")
    if not pricing_model or not metering:
        return _gate("pricing_intent_consistent", False, "commerce.pricing_model and commerce.metering are required")
    if pricing_model == "free" and metering != "none":
        return _gate("pricing_intent_consistent", False, "free plugins must declare metering=none")
    if pricing_model == "paid_per_invocation" and metering != "per_invocation":
        return _gate("pricing_intent_consistent", False, "paid_per_invocation plugins must declare metering=per_invocation")
    if pricing_model == "usage_metered" and metering not in USAGE_METERED_METERING_MODES:
        allowed = ", ".join(sorted(USAGE_METERED_METERING_MODES))
        return _gate("pricing_intent_consistent", False, f"usage_metered plugins must declare metering in: {allowed}")
    return _gate("pricing_intent_consistent", True, f"pricing_model={pricing_model} metering={metering}")


def _root_llm_key_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    requested: set[str] = set()
    requested.update(str(name) for name in (manifest.get("permissions") or {}).get("environment", []))
    configuration = manifest.get("configuration") or {}
    for secret in configuration.get("secrets", []):
        if isinstance(secret, dict):
            requested.add(str(secret.get("name") or ""))
            requested.add(str(secret.get("env_name") or ""))
    blocked = sorted(name for name in requested if name in ROOT_LLM_ENV_NAMES)
    if blocked:
        return _gate("root_llm_key_denied", False, f"plugins must not request root LLM keys directly: {', '.join(blocked)}")
    return _gate("root_llm_key_denied", True, "no root LLM API key requested directly")


def _manifest_secret_values_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    violation = _manifest_secret_value_path(manifest)
    if violation:
        return _gate("manifest_secret_values_denied", False, f"manifest embeds a secret value at {violation}")
    return _gate("manifest_secret_values_denied", True, "manifest contains descriptors only; no secret values found")


def _manifest_secret_value_path(value: Any, path: str = "$") -> str | None:
    if isinstance(value, dict):
        for raw_key, child in value.items():
            key = str(raw_key)
            key_name = key.lower().replace("-", "_")
            child_path = f"{path}.{key}"
            if _is_sensitive_setting_default(path, key_name, child, value):
                return child_path
            if isinstance(child, str):
                if contains_secret(child):
                    return child_path
                if _is_manifest_secret_value_field(path, key_name) and child.strip():
                    return child_path
            if _is_manifest_secret_value_field(path, key_name) and child:
                return child_path
            nested = _manifest_secret_value_path(child, child_path)
            if nested:
                return nested
    elif isinstance(value, list):
        for index, child in enumerate(value):
            nested = _manifest_secret_value_path(child, f"{path}[{index}]")
            if nested:
                return nested
    elif isinstance(value, str) and contains_secret(value):
        return path
    return None


def _is_manifest_secret_value_field(path: str, key_name: str) -> bool:
    return path.startswith("$.configuration.secrets") and key_name in MANIFEST_SECRET_VALUE_FIELD_NAMES


def _is_sensitive_setting_default(path: str, key_name: str, value: Any, parent: dict[str, Any]) -> bool:
    if not path.startswith("$.configuration.settings") or key_name != "default":
        return False
    if not isinstance(value, str) or not value.strip():
        return False
    setting_name = str(parent.get("name") or "").lower().replace("-", "_")
    return setting_name in MANIFEST_SECRET_SETTING_NAMES or contains_secret(value)


def _secret_descriptor_contract_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    permissions = manifest.get("permissions") if isinstance(manifest.get("permissions"), dict) else {}
    declared_env = {str(name) for name in permissions.get("environment", []) if str(name)}
    configuration = manifest.get("configuration") if isinstance(manifest.get("configuration"), dict) else {}
    descriptors = configuration.get("secrets", []) if isinstance(configuration.get("secrets", []), list) else []
    descriptor_env = {
        str(secret.get("env_name") or secret.get("name"))
        for secret in descriptors
        if isinstance(secret, dict) and str(secret.get("env_name") or secret.get("name"))
    }
    missing_descriptors = sorted(declared_env - descriptor_env)
    undeclared_descriptors = sorted(descriptor_env - declared_env)
    if missing_descriptors:
        return _gate(
            "secret_descriptors_match_environment",
            False,
            f"permissions.environment entries missing configuration.secrets descriptors: {', '.join(missing_descriptors)}",
        )
    if undeclared_descriptors:
        return _gate(
            "secret_descriptors_match_environment",
            False,
            f"configuration.secrets descriptors missing permissions.environment declarations: {', '.join(undeclared_descriptors)}",
        )
    if declared_env:
        return _gate("secret_descriptors_match_environment", True, f"{len(declared_env)} environment secret descriptor(s) declared")
    return _gate("secret_descriptors_match_environment", True, "no environment secrets declared")


def _runtime_code_download_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    scanned: list[str] = []
    for relative in _runtime_scan_paths(root, manifest):
        text = _read_text_if_safe(root, relative)
        if text is None:
            continue
        scanned.append(relative)
        for pattern in RUNTIME_DOWNLOAD_PATTERNS:
            if pattern.search(text):
                return _gate("runtime_code_download_denied", False, f"runtime code download marker found in {relative}")
    return _gate("runtime_code_download_denied", True, f"no runtime download markers found in {len(scanned)} executable file(s)")


def _runtime_tool_schema_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    metadata_path = root / MCP_SERVER_CONFIG_NAME
    if not metadata_path.is_file():
        return _gate("runtime_tool_schema_match", False, f"missing {MCP_SERVER_CONFIG_NAME}")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _gate("runtime_tool_schema_match", False, f"invalid {MCP_SERVER_CONFIG_NAME}: {exc}")
    if not isinstance(metadata, dict):
        return _gate("runtime_tool_schema_match", False, f"{MCP_SERVER_CONFIG_NAME} must be a JSON object")
    if metadata.get("proxy_required") is not True:
        return _gate("runtime_tool_schema_match", False, f"{MCP_SERVER_CONFIG_NAME} must set proxy_required=true")
    identity_drift = _runtime_metadata_identity_drift(metadata, manifest)
    if identity_drift:
        return _gate("runtime_tool_schema_match", False, identity_drift)

    manifest_tools = _tool_contract_map(manifest.get("tools"))
    metadata_tools = _tool_contract_map(metadata.get("tools"))
    if manifest_tools is None or metadata_tools is None:
        return _gate("runtime_tool_schema_match", False, "manifest tools and MCP metadata tools must be arrays of tool objects")
    if set(manifest_tools) != set(metadata_tools):
        missing = sorted(set(manifest_tools) - set(metadata_tools))
        extra = sorted(set(metadata_tools) - set(manifest_tools))
        return _gate("runtime_tool_schema_match", False, f"tool name drift missing={missing} extra={extra}")
    for tool_name, contract in manifest_tools.items():
        runtime_contract = metadata_tools[tool_name]
        if _canonical_json(contract["input_schema"]) != _canonical_json(runtime_contract["input_schema"]):
            return _gate("runtime_tool_schema_match", False, f"input_schema drift for tool {tool_name}")
        if _canonical_json(contract["output_schema"]) != _canonical_json(runtime_contract["output_schema"]):
            return _gate("runtime_tool_schema_match", False, f"output_schema drift for tool {tool_name}")
    return _gate("runtime_tool_schema_match", True, f"{len(manifest_tools)} tool contract(s) match {MCP_SERVER_CONFIG_NAME}")


def _runtime_metadata_identity_drift(metadata: dict[str, Any], manifest: dict[str, Any]) -> str | None:
    runtime = manifest.get("runtime") or {}
    expected = {
        "plugin_id": manifest.get("id"),
        "plugin_version": manifest.get("version"),
        "transport": runtime.get("transport"),
        "entrypoint": runtime.get("entrypoint"),
        "args": runtime.get("args", []),
    }
    for key, expected_value in expected.items():
        if metadata.get(key) != expected_value:
            return f"{MCP_SERVER_CONFIG_NAME} {key} drift"
    return None


def _tool_contract_map(tools: Any) -> dict[str, dict[str, Any]] | None:
    if not isinstance(tools, list):
        return None
    contracts: dict[str, dict[str, Any]] = {}
    for tool in tools:
        if not isinstance(tool, dict):
            return None
        name = str(tool.get("name") or "")
        if not name or name in contracts or "input_schema" not in tool or "output_schema" not in tool:
            return None
        contracts[name] = {
            "input_schema": tool.get("input_schema"),
            "output_schema": tool.get("output_schema"),
        }
    return contracts


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _runtime_scan_paths(root: Path, manifest: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    entrypoint = str((manifest.get("runtime") or {}).get("entrypoint") or "")
    if entrypoint:
        paths.append(entrypoint)
    paths.extend(str(path) for path in manifest.get("acceptance", {}).get("tests", []))
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item.suffix in SCRIPT_SCAN_SUFFIXES):
        if THIRD_PARTY_MARKERS.intersection(path.relative_to(root).parts):
            continue
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        paths.append(relative)
    return sorted(set(paths))


def _acceptance_test_permission_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    tests = [str(path) for path in manifest.get("acceptance", {}).get("tests", [])]
    if not tests:
        return _gate("acceptance_test_permissions_declared", False, "manifest declares no acceptance tests")
    scanned = 0
    for relative in tests:
        text = _read_text_if_safe(root, relative)
        if text is None:
            return _gate("acceptance_test_permissions_declared", False, f"unsafe or missing acceptance test: {relative}")
        scanned += 1
        text_without_shebang = _without_shebang(text)
        violation = _undeclared_test_network_access(manifest, text_without_shebang)
        if violation:
            return _gate("acceptance_test_permissions_declared", False, f"{relative}: {violation}")
        violation = _undeclared_test_filesystem_access(manifest, text_without_shebang)
        if violation:
            return _gate("acceptance_test_permissions_declared", False, f"{relative}: {violation}")
    return _gate("acceptance_test_permissions_declared", True, f"{scanned} acceptance test(s) use declared network/filesystem permissions")


def _without_shebang(text: str) -> str:
    return "\n".join(line for index, line in enumerate(text.splitlines()) if not (index == 0 and line.startswith("#!")))


def _undeclared_test_network_access(manifest: dict[str, Any], text: str) -> str | None:
    allowed_hosts = {str(item.get("host")) for item in manifest.get("permissions", {}).get("network", []) if isinstance(item, dict)}
    hosts = set(re.findall(r"https?://([^/'\"\s)]+)", text))
    for host in sorted(hosts):
        if host not in allowed_hosts:
            return f"undeclared network host: {host}"
    return None


def _undeclared_test_filesystem_access(manifest: dict[str, Any], text: str) -> str | None:
    filesystem_permissions = manifest.get("permissions", {}).get("filesystem", [])
    allowed_scopes = {str(item.get("scope")) for item in filesystem_permissions if isinstance(item, dict)}
    absolute_paths = set(re.findall(r"(?:cat|ls|cp|mv|rm|touch|mkdir|tee|find)\s+(/[^'\"\s]+)", text))
    absolute_paths |= set(re.findall(r"(?:>|>>|<)\s*(/[^'\"\s]+)", text))
    for path in sorted(absolute_paths):
        if path.startswith(("/dev/null", "/usr/bin/env")):
            continue
        if not allowed_scopes:
            return f"undeclared filesystem path: {path}"
        if path.startswith("/tmp/") and "artifact_dir" not in allowed_scopes:
            return f"undeclared filesystem path: {path}"
        if path.startswith("/Users/") and "workspace" not in allowed_scopes:
            return f"undeclared filesystem path: {path}"
        if not path.startswith(("/tmp/", "/Users/")):
            return f"undeclared filesystem path: {path}"
    return None


def _read_text_if_safe(root: Path, relative: str) -> str | None:
    path = _safe_package_file(root, relative)
    if path is None:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None


def _safe_package_file(root: Path, relative: str) -> Path | None:
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    path = (root / relative_path).resolve()
    if root.resolve() not in path.parents or not path.is_file():
        return None
    return path


def _evidence_fixture_gate(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    missing: list[str] = []
    for relative in manifest.get("acceptance", {}).get("evidence_fixtures", []):
        if not (root / str(relative)).is_file():
            missing.append(str(relative))
    if missing:
        return _gate("evidence_fixture_present", False, f"missing evidence fixtures: {', '.join(missing)}")
    return _gate("evidence_fixture_present", True, "all manifest-declared evidence fixtures exist")


def _smoke_test_gate(root: Path, manifest: dict[str, Any], *, timeout_seconds: float | None) -> dict[str, Any]:
    if timeout_seconds is None:
        timeout_seconds = floor_default_timeout_seconds(10.0)
    tests = [str(path) for path in manifest.get("acceptance", {}).get("tests", [])]
    if not tests:
        return _gate("sandbox_smoke_run", False, "manifest declares no acceptance tests")
    for relative in tests:
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            return _gate("sandbox_smoke_run", False, f"unsafe test path: {relative}")
        test_path = (root / relative).resolve()
        if root.resolve() not in test_path.parents:
            return _gate("sandbox_smoke_run", False, f"test path escapes package root: {relative}")
        if not test_path.is_file():
            return _gate("sandbox_smoke_run", False, f"missing test: {relative}")
        try:
            completed = subprocess.run(
                command_for_script(test_path),
                cwd=root,
                env={"PATH": SAFE_REVIEW_PATH},
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return _gate("sandbox_smoke_run", False, f"test timed out: {relative}")
        if completed.returncode != 0:
            return _gate("sandbox_smoke_run", False, f"test failed: {relative}: {completed.stderr or completed.stdout}")
    return _gate("sandbox_smoke_run", True, f"{len(tests)} acceptance test(s) passed")


def _safe_digest(package: Any) -> str | None:
    try:
        return compute_package_digest(package)
    except Exception:
        return None


def _write_review_record(record: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / REVIEW_RECORD_NAME
    path.write_text(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def _sign_package_copy(package_path: Path, output_path: Path, signing_private_key: str) -> tuple[Path, str]:
    package = load_plugin_package(package_path)
    try:
        if output_path.exists():
            shutil.rmtree(output_path)
        shutil.copytree(package.root, output_path)
    finally:
        package.cleanup()
    private_key = _load_private_key(signing_private_key)
    manifest_path = output_path / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    # SECURITY: the package digest intentionally excludes __pycache__
    # (interpreter-generated bytecode). If the source tree ships __pycache__,
    # copytree above carried it into the signed copy, where it would become
    # signed-but-unhashed bytecode the runtime could load. The cache/install and
    # .scplug-extraction paths already refuse such content, but no-cache verify
    # (cache=False) skips the install check, so make "a signed package can never
    # contain unhashed __pycache__" a true invariant by refusing to *sign* such a
    # tree here — independent of any later cache flag.
    _reject_shipped_pycache(output_path)
    signed_package = load_plugin_package(output_path)
    try:
        digest = compute_package_digest(signed_package)
    finally:
        signed_package.cleanup()
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return output_path, base64.b64encode(public_bytes).decode("ascii")


def _load_private_key(value: str) -> Ed25519PrivateKey:
    try:
        raw = base64.b64decode(value.removeprefix("ed25519:"), validate=True)
        return Ed25519PrivateKey.from_private_bytes(raw)
    except Exception as exc:
        raise DeveloperUploadReviewError("invalid SuperClaw signing private key") from exc


def _gate(name: str, passed: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "passed": passed, "detail": detail}
