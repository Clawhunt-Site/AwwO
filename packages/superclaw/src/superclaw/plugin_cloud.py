from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from superclaw.capability_registry import CapabilityRegistryError, assert_immutable_digest
from superclaw.plugins import (
    PluginVerificationError,
    compute_package_digest,
    is_skill_origin_plugin,
    load_plugin_package,
    plugin_state_root,
    verify_plugin_package,
)


# The fake-cloud *source* registry stays cwd-relative — it simulates a remote and
# is a per-project authoring/test artifact, not installed-plugin state.
DEFAULT_CLOUD_ROOT = Path(".superclaw/plugins/cloud")
# The local governance state root is the SAME directory the admission gate reads
# (cache/revocations/entitlements/policy under ~/.superclaw/plugins). cloud-sync
# WRITES the synced revocations/entitlements/policy here, so it MUST resolve to the
# user-global plugin state root — otherwise a cloud revocation synced to a cwd copy
# would be invisible to the (now global) gate and a revoked plugin could install
# (fail-closed violation). Back-compat constant snapshots the default at import;
# prefer the call-time resolver below.
DEFAULT_LOCAL_STATE_ROOT = plugin_state_root()


def local_plugin_state_root() -> Path:
    """Call-time local governance state root (where cloud-sync writes, status reads).

    Honors the legacy ``SUPERCLAW_PLUGIN_LOCAL_STATE_PATH`` override first, then the
    unified ``SUPERCLAW_PLUGIN_STATE_ROOT`` via :func:`plugin_state_root`, so the
    cloud-sync write target, the surface entitlement status, and the admission gate
    all resolve to one directory.
    """
    override = os.environ.get("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH")
    return Path(override).expanduser() if override else plugin_state_root()
ENTITLEMENTS_NAME = "entitlements.json"
REVOCATIONS_NAME = "revocations.json"
POLICY_NAME = "runtime-policy.json"
SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$")
MAX_OFFLINE_GRACE_SECONDS = 72 * 60 * 60
SEMVERISH_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}$")
SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$")
PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$")
TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SHA256_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
EVIDENCE_SUMMARY_STATUSES = {"ok", "error", "denied", "timeout"}
EVIDENCE_SUMMARY_REQUIRED_FIELDS = (
    "run_id",
    "plugin_id",
    "plugin_version",
    "package_digest",
    "tool_name",
    "started_at",
    "finished_at",
    "status",
    "entitlement_id",
    "input_digest",
    "output_digest",
    "evidence_artifact_id",
)
REVOCATION_REASON_CODES = {
    "malware",
    "secret_leak",
    "license_violation",
    "broken_runtime",
    "fraud",
    "policy_violation",
    "developer_request",
}


class PluginCloudSyncError(ValueError):
    """Raised when local fake-cloud plugin sync input is invalid."""


@dataclass(frozen=True)
class CloudPluginInstallResult:
    plugin_id: str
    version: str
    digest: str
    registry_metadata_path: Path


@dataclass(frozen=True)
class CloudGovernanceSyncResult:
    entitlement_file: Path
    revocation_file: Path
    policy_file: Path
    entitlement_count: int
    revocation_count: int
    policy_digest: str


@dataclass(frozen=True)
class EvidenceUploadResult:
    upload_id: str
    summary_path: Path
    summary_digest: str


def list_registry_plugins(cloud_root: Path, *, filters: dict[str, str | None] | None = None) -> list[dict[str, Any]]:
    """Return sanitized fake-cloud registry plugin metadata."""
    filters = filters or {}
    rows: list[dict[str, Any]] = []
    registry_root = cloud_root / "registry" / "plugins"
    if not registry_root.exists():
        return []
    for metadata_path in sorted(registry_root.glob("*/*/metadata.json")):
        metadata = _read_json(metadata_path)
        row = _sanitize_registry_metadata(metadata_path, metadata)
        if _matches_registry_filters(row, filters):
            rows.append(row)
    return rows


def search_registry_plugins(cloud_root: Path, query: str, *, filters: dict[str, str | None] | None = None) -> list[dict[str, Any]]:
    """Search sanitized fake-cloud registry metadata without exposing package paths."""
    rows = list_registry_plugins(cloud_root, filters=filters)
    needle = query.strip().lower()
    if not needle:
        return rows
    searchable_fields = ("plugin_id", "name", "summary", "category", "pricing_model", "acceptance_level")
    return [
        row
        for row in rows
        if any(needle in str(row.get(field, "")).lower() for field in searchable_fields)
    ]


def resolve_registry_plugin_version(cloud_root: Path, plugin_id: str, version: str | None = None) -> str:
    """Resolve an explicit or latest fake-cloud registry version for a plugin."""
    if version:
        get_registry_plugin_version(cloud_root, plugin_id, version)
        return version
    rows = [row for row in list_registry_plugins(cloud_root) if row.get("plugin_id") == plugin_id]
    if not rows:
        raise PluginCloudSyncError(f"plugin not found in registry: {plugin_id}")
    return str(sorted(rows, key=lambda row: _version_sort_key(str(row.get("version") or "0.0.0")))[-1]["version"])


def get_registry_plugin_version(cloud_root: Path, plugin_id: str, version: str) -> dict[str, Any]:
    """Return sanitized version metadata for one registry package."""
    metadata_path = _registry_metadata_path(cloud_root, plugin_id, version)
    metadata = _read_json(metadata_path)
    _assert_registry_identity(metadata, plugin_id, version)
    return _sanitize_registry_metadata(metadata_path, metadata)


def get_registry_download_reference(cloud_root: Path, plugin_id: str, version: str) -> dict[str, Any]:
    """Return an opaque local download reference without exposing filesystem paths."""
    metadata = get_registry_plugin_version(cloud_root, plugin_id, version)
    return {
        "plugin_id": plugin_id,
        "version": version,
        "package_digest": metadata.get("package_digest"),
        "download_url": f"superclaw-local://plugins/{plugin_id}/versions/{version}/package",
        "expires_at": _short_lived_expiry(),
    }


def sync_entitlements_for_device(
    cloud_root: Path,
    *,
    device_id: str,
    runtime_version: str,
    plugin_ids: list[str],
) -> dict[str, Any]:
    """Return sanitized fake-cloud entitlement sync payload for a device."""
    payload = _read_optional_json(cloud_root / "governance" / ENTITLEMENTS_NAME, {"entitlements": []})
    _validate_entitlements(payload)
    policy_payload = get_runtime_policy(cloud_root)
    requested = set(plugin_ids)
    now = datetime.now(UTC)
    entitlements: list[dict[str, Any]] = []
    for item in payload.get("entitlements", []):
        if requested and item.get("plugin_id") not in requested:
            continue
        entitlements.append(
            _runtime_entitlement(
                item,
                now=now,
                device_id=device_id,
                runtime_version=runtime_version,
                include_token=True,
                policies=policy_payload.get("policies", []),
            )
        )
    return {"entitlements": entitlements}


def get_revocations(cloud_root: Path) -> dict[str, Any]:
    payload = _read_optional_json(cloud_root / "governance" / REVOCATIONS_NAME, {"revoked": []})
    _validate_revocations(payload)
    return payload


def get_runtime_policy(cloud_root: Path) -> dict[str, Any]:
    payload = _read_optional_json(cloud_root / "governance" / POLICY_NAME, {"policies": []})
    _validate_policy(payload)
    return payload


def store_evidence_summary(summary: dict[str, Any], *, cloud_root: Path) -> EvidenceUploadResult:
    """Store a caller-provided evidence summary after rejecting raw evidence shapes."""
    _validate_cloud_evidence_summary(summary)
    upload_id = str(summary.get("upload_id") or f"evup_{hashlib.sha256(_json_bytes(summary)).hexdigest()[:16]}")
    _validate_safe_identifier(upload_id, field="upload_id")
    sanitized = dict(summary)
    sanitized["upload_id"] = upload_id
    destination = cloud_root / "evidence" / f"{upload_id}.json"
    _write_json(destination, sanitized)
    return EvidenceUploadResult(upload_id=upload_id, summary_path=destination, summary_digest=_digest_json(sanitized))


def install_plugin_from_cloud_metadata(
    cloud_root: Path,
    plugin_id: str,
    version: str,
    *,
    public_key: str,
    cache_root: Path | None = None,
    revocation_file: Path | None = None,
) -> CloudPluginInstallResult:
    """Install a plugin from fake-cloud registry metadata after package verification.

    Phase 5A deliberately uses a local registry directory instead of a real
    SuperClaw Cloud API. This proves the runtime contract without inventing
    production networking, payment, or marketplace behavior.
    """
    metadata_path = _registry_metadata_path(cloud_root, plugin_id, version)
    metadata = _read_json(metadata_path)
    _assert_registry_identity(metadata, plugin_id, version)
    # Red line (capability-workshop): a skill-origin capability is NEVER installable via
    # the plugin pipeline — it is equipped from the Skills tab / projected to runtimes,
    # never side-loaded as a plugin. Refuse at THIS kernel entry so every caller — REST
    # /api/plugins/install, `superclaw plugin install`, `plugin cloud-install` — is covered
    # by the single source of truth (``is_skill_origin_plugin``), not merely the web-UI
    # guards. (install-workshop already refuses kind != plugin at its own entry.)
    if is_skill_origin_plugin(plugin_id, metadata.get("skill_origin")):
        raise PluginCloudSyncError(
            f"{plugin_id}@{version} is a skill capability, not installable via the plugin pipeline"
        )
    package_path = _resolve_registry_package_path(metadata_path, metadata)
    expected_digest = metadata.get("package_digest")
    # Probe FIRST (cache=False): bind digest + identity BEFORE any cache write, so a
    # mismatched / tampered / version-skewed package can never overwrite or delete a
    # pre-existing GOOD install of the same id/version (cache_plugin_package replaces a
    # same id/version entry on a signer match — a post-write rollback would then erase
    # the prior good copy, not just the bad one). Mirrors install-workshop's
    # probe->commit. reject_skill_origin is enforced at the probe too, so a skill is
    # refused before any byte is cached. The probe is the REMOTE plugin-install sink:
    # provenance="remote" forbids any sign-free `local` grade (design §3.7).
    try:
        probe = verify_plugin_package(
            package_path,
            public_key=public_key,
            cache_root=cache_root,
            revocation_file=revocation_file,
            cache=False,
            provenance="remote",
            install_entry="registry-install",
            reject_skill_origin=True,
        )
    except PluginVerificationError as exc:
        raise PluginCloudSyncError(str(exc)) from exc
    if expected_digest and expected_digest != probe.digest:
        raise PluginCloudSyncError(f"registry digest mismatch: metadata {expected_digest}, package {probe.digest}")
    if probe.plugin_id != plugin_id or probe.version != version:
        raise PluginCloudSyncError(f"verified package identity mismatch: {probe.plugin_id}@{probe.version}")
    # Bound & matched -> commit to the cache. package_path is a stable local registry
    # entry (not a network download), so the committed bytes are the probed bytes; the
    # commit verify recomputes the digest and re-runs the full admission, so any change
    # still fails closed (never caches blind) instead of needing a post-write rollback
    # that could clobber a good install.
    try:
        verified = verify_plugin_package(
            package_path,
            public_key=public_key,
            cache_root=cache_root,
            revocation_file=revocation_file,
            cache=True,
            provenance="remote",
            install_entry="registry-install",
            reject_skill_origin=True,
        )
    except PluginVerificationError as exc:
        raise PluginCloudSyncError(str(exc)) from exc
    return CloudPluginInstallResult(plugin_id=plugin_id, version=version, digest=verified.digest, registry_metadata_path=metadata_path)


def sync_cloud_governance(cloud_root: Path, *, local_state_root: Path | None = None) -> CloudGovernanceSyncResult:
    """Sync fake-cloud entitlement, revocation, and runtime policy files locally.

    ``local_state_root`` defaults (call-time) to the user-global plugin state root
    so the synced governance lands in the SAME files the admission gate reads.
    """
    local_state_root = local_state_root or local_plugin_state_root()
    governance_root = cloud_root / "governance"
    entitlements = _read_optional_json(governance_root / ENTITLEMENTS_NAME, {"entitlements": []})
    revocations = _read_optional_json(governance_root / REVOCATIONS_NAME, {"revoked": []})
    policy = _read_optional_json(governance_root / POLICY_NAME, {"policies": []})
    _validate_entitlements(entitlements)
    _validate_revocations(revocations)
    _validate_policy(policy)
    now = datetime.now(UTC)
    local_entitlements = {
        "entitlements": [
            _runtime_entitlement(
                item,
                now=now,
                device_id=item.get("device_id"),
                runtime_version=item.get("runtime_version"),
                include_token=False,
                policies=policy.get("policies", []),
            )
            for item in entitlements.get("entitlements", [])
        ]
    }

    local_state_root.mkdir(parents=True, exist_ok=True)
    entitlement_file = local_state_root / ENTITLEMENTS_NAME
    revocation_file = local_state_root / REVOCATIONS_NAME
    policy_file = local_state_root / POLICY_NAME
    _write_json(entitlement_file, local_entitlements)
    _write_json(revocation_file, revocations)
    _write_json(policy_file, policy)
    return CloudGovernanceSyncResult(
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        entitlement_count=len(local_entitlements.get("entitlements", [])),
        revocation_count=len(revocations.get("revoked", [])),
        policy_digest=_digest_json(policy),
    )


def upload_evidence_summary(evidence_path: Path, *, cloud_root: Path) -> EvidenceUploadResult:
    """Upload a privacy-preserving evidence summary into the fake cloud store."""
    evidence = _read_json(evidence_path)
    summary = summarize_evidence_for_cloud(evidence)
    upload_id = str(summary["upload_id"])
    destination = cloud_root / "evidence" / f"{upload_id}.json"
    _write_json(destination, summary)
    return EvidenceUploadResult(upload_id=upload_id, summary_path=destination, summary_digest=_digest_json(summary))


def summarize_evidence_for_cloud(evidence: dict[str, Any]) -> dict[str, Any]:
    """Build a cloud-safe evidence summary with digests instead of raw outputs."""
    run_id = str(evidence.get("run_id") or "unknown")
    uploaded_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    commands = [
        {
            "command_digest": _digest_json(command.get("command")),
            "exit_code": command.get("exit_code"),
            "output_digest": _digest_json(command.get("output")),
        }
        for command in evidence.get("commands", [])
    ]
    worker_results = [
        {
            "task_id": item.get("task_id"),
            "role": item.get("role"),
            "backend": item.get("backend"),
            "exit_code": item.get("exit_code"),
            "output_digest": _digest_json(item.get("output")),
            "artifact_id": item.get("artifact_id"),
            "transcript_artifact_id": item.get("transcript_artifact_id"),
        }
        for item in evidence.get("worker_results", [])
    ]
    probes = [
        {
            "name": probe.get("name"),
            "status_code": probe.get("status_code"),
            "body_digest": _digest_json(probe.get("body")),
            "plugin_id": _extract_plugin_field(probe.get("body"), "plugin_id"),
            "plugin_version": _extract_plugin_field(probe.get("body"), "plugin_version"),
            "package_digest": _extract_plugin_field(probe.get("body"), "package_digest"),
            "entitlement_id": _extract_plugin_field(probe.get("body"), "entitlement_id"),
        }
        for probe in evidence.get("probes", [])
    ]
    artifacts = [
        {
            "artifact_id": artifact.get("artifact_id"),
            "kind": artifact.get("kind"),
            "sensitivity": artifact.get("sensitivity"),
            "path_digest": _digest_json(artifact.get("path")),
            "metadata_digest": _digest_json(artifact.get("metadata")),
        }
        for artifact in evidence.get("artifacts", [])
    ]
    return {
        "schema_version": "0.1.0",
        "upload_id": f"evup_{hashlib.sha256((run_id + uploaded_at).encode('utf-8')).hexdigest()[:16]}",
        "run_id": run_id,
        "uploaded_at": uploaded_at,
        "chain_verdict": evidence.get("chain_verdict"),
        "counts": {
            "commands": len(commands),
            "worker_results": len(worker_results),
            "probes": len(probes),
            "artifacts": len(artifacts),
            "findings": len(evidence.get("findings", [])),
        },
        "commands": commands,
        "worker_results": worker_results,
        "probes": probes,
        "artifacts": artifacts,
        "findings": [
            {
                "name": finding.get("name"),
                "passed": finding.get("passed"),
                "severity": finding.get("severity"),
                "detail_digest": _digest_json(finding.get("detail")),
            }
            for finding in evidence.get("findings", [])
        ],
    }


def _registry_metadata_path(cloud_root: Path, plugin_id: str, version: str) -> Path:
    _validate_safe_identifier(plugin_id, field="plugin_id")
    _validate_safe_identifier(version, field="version")
    return cloud_root / "registry" / "plugins" / plugin_id / version / "metadata.json"


def _sanitize_registry_metadata(metadata_path: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    package_path = _resolve_registry_package_path(metadata_path, metadata)
    manifest = _read_optional_json(package_path / "superclaw-plugin.json", {})
    provenance = manifest.get("provenance", {}) if isinstance(manifest, dict) else {}
    commerce = manifest.get("commerce", {}) if isinstance(manifest, dict) else {}
    acceptance = manifest.get("acceptance", {}) if isinstance(manifest, dict) else {}
    runtime = manifest.get("runtime", {}) if isinstance(manifest, dict) else {}
    manifest_skill_origin = manifest.get("skill_origin") if isinstance(manifest, dict) else None
    plugin_id = metadata.get("plugin_id")
    return {
        "plugin_id": plugin_id,
        "version": metadata.get("version"),
        "name": metadata.get("name") or manifest.get("name"),
        "summary": metadata.get("summary") or manifest.get("summary"),
        "category": metadata.get("category"),
        "logo": metadata.get("logo") or manifest.get("logo"),
        "skill_origin": is_skill_origin_plugin(str(plugin_id or ""), metadata.get("skill_origin") if metadata.get("skill_origin") is not None else manifest_skill_origin),
        "runtime": metadata.get("runtime") or runtime.get("type"),
        "platforms": metadata.get("platforms") or runtime.get("platforms", []),
        "acceptance_level": metadata.get("acceptance_level") or acceptance.get("level"),
        "verified": bool(metadata.get("verified", True)),
        "pricing_model": metadata.get("pricing_model") or commerce.get("pricing_model"),
        "package_digest": metadata.get("package_digest") or provenance.get("package_digest"),
        "signature": metadata.get("signature") or provenance.get("signature"),
        "compatibility": metadata.get("compatibility", {}),
        "entitlement_required": bool(metadata.get("entitlement_required") or commerce.get("pricing_model") not in {None, "", "free"}),
    }


def _matches_registry_filters(row: dict[str, Any], filters: dict[str, str | None]) -> bool:
    for key in ("category", "runtime", "acceptance_level", "pricing_model"):
        expected = filters.get(key)
        if expected and str(row.get(key)) != expected:
            return False
    verified = filters.get("verified")
    if verified is not None and verified != "":
        if bool(row.get("verified")) is not _parse_bool(verified):
            return False
    platform = filters.get("platform")
    if platform and platform not in {str(item) for item in row.get("platforms", [])}:
        return False
    return True


def _assert_registry_identity(metadata: dict[str, Any], plugin_id: str, version: str) -> None:
    if metadata.get("plugin_id") != plugin_id:
        raise PluginCloudSyncError("registry metadata plugin_id mismatch")
    if metadata.get("version") != version:
        raise PluginCloudSyncError("registry metadata version mismatch")


def _resolve_registry_package_path(metadata_path: Path, metadata: dict[str, Any]) -> Path:
    package_path = metadata.get("package_path")
    if not package_path:
        raise PluginCloudSyncError("registry metadata missing package_path")
    candidate = Path(str(package_path))
    if not candidate.is_absolute():
        candidate = metadata_path.parent / candidate
    resolved = candidate.resolve()
    cloud_registry_root = metadata_path.parents[3].resolve()
    if resolved != cloud_registry_root and cloud_registry_root not in resolved.parents:
        raise PluginCloudSyncError("registry package_path escapes registry root")
    if not resolved.exists():
        raise PluginCloudSyncError(f"registry package missing: {package_path}")
    return resolved


def _validate_entitlements(payload: dict[str, Any]) -> None:
    if not isinstance(payload.get("entitlements", []), list):
        raise PluginCloudSyncError("entitlements must be a list")
    for item in payload.get("entitlements", []):
        if not item.get("plugin_id") or not item.get("entitlement_id"):
            raise PluginCloudSyncError("entitlement requires plugin_id and entitlement_id")
        if "secret" in json.dumps(item, sort_keys=True).lower():
            raise PluginCloudSyncError("entitlement payload must not contain secrets")
        if item.get("offline_grace_seconds") is not None and int(item["offline_grace_seconds"]) < 0:
            raise PluginCloudSyncError("offline_grace_seconds must be non-negative")


def _runtime_entitlement(
    item: dict[str, Any],
    *,
    now: datetime,
    device_id: str | None,
    runtime_version: str | None,
    include_token: bool,
    policies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    entitlement_id = str(item["entitlement_id"])
    version_range = item.get("version_range") or (f"={item['version']}" if item.get("version") else None)
    synced_at = _format_time(now)
    disabled_reason = _offline_grace_disabled_reason(item, policies or [])
    runtime_item: dict[str, Any] = {
        "plugin_id": item.get("plugin_id"),
        "version": item.get("version"),
        "version_range": version_range,
        "subject": item.get("subject") or device_id,
        "device_id": device_id,
        "runtime_version": runtime_version,
        "entitlement_id": entitlement_id,
        "expires_at": item.get("expires_at"),
        "synced_at": synced_at,
        "offline_grace_expires_at": synced_at if disabled_reason else _offline_grace_expires_at(item, now),
    }
    if disabled_reason:
        runtime_item["offline_grace_disabled_reason"] = disabled_reason
    if include_token:
        token_material = {
            "device_id": device_id,
            "runtime_version": runtime_version,
            "plugin_id": item.get("plugin_id"),
            "version_range": version_range,
            "entitlement_id": entitlement_id,
            "expires_at": item.get("expires_at"),
            "offline_grace_expires_at": runtime_item["offline_grace_expires_at"],
        }
        runtime_item["token"] = f"local-entitlement.{hashlib.sha256(_json_bytes(token_material)).hexdigest()[:32]}"
    return runtime_item


def _offline_grace_disabled_reason(item: dict[str, Any], policies: list[dict[str, Any]]) -> str | None:
    if item.get("offline_grace_allowed") is False:
        return "entitlement_offline_grace_disabled"
    if item.get("requires_live_metering"):
        return "entitlement_requires_live_metering"
    for policy in _matching_runtime_policies(item, policies):
        if policy.get("offline_grace_allowed") is False:
            return "policy_offline_grace_disabled"
        if policy.get("requires_live_metering"):
            return "policy_requires_live_metering"
        if str(policy.get("risk_level") or "").lower() in {"high", "critical"}:
            return "policy_high_risk"
    return None


def _matching_runtime_policies(item: dict[str, Any], policies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    plugin_id = item.get("plugin_id")
    version = item.get("version")
    matches: list[dict[str, Any]] = []
    for policy in policies:
        if policy.get("plugin_id") not in {None, plugin_id}:
            continue
        if policy.get("version") not in {None, version}:
            continue
        matches.append(policy)
    return matches


def _offline_grace_expires_at(item: dict[str, Any], now: datetime) -> str:
    requested_seconds = MAX_OFFLINE_GRACE_SECONDS
    if item.get("offline_grace_seconds") is not None:
        requested_seconds = min(int(item["offline_grace_seconds"]), MAX_OFFLINE_GRACE_SECONDS)
    deadline = now + timedelta(seconds=requested_seconds)
    if item.get("offline_grace_expires_at"):
        deadline = min(deadline, _parse_time(str(item["offline_grace_expires_at"])))
    if item.get("expires_at"):
        deadline = min(deadline, _parse_time(str(item["expires_at"])))
    return _format_time(deadline)


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _format_time(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _validate_revocations(payload: dict[str, Any]) -> None:
    if not isinstance(payload.get("revoked", []), list):
        raise PluginCloudSyncError("revoked must be a list")
    for item in payload.get("revoked", []):
        if not item.get("plugin_id"):
            raise PluginCloudSyncError("revocation requires plugin_id")
        if item.get("reason") not in REVOCATION_REASON_CODES:
            allowed = ", ".join(sorted(REVOCATION_REASON_CODES))
            raise PluginCloudSyncError(f"revocation reason must be one of: {allowed}")


def _validate_policy(payload: dict[str, Any]) -> None:
    policies = payload.get("policies", [])
    if not isinstance(policies, list):
        raise PluginCloudSyncError("policies must be a list")
    for item in policies:
        if item.get("secret_values"):
            raise PluginCloudSyncError("runtime policy must not include secret values")
        if "private_key" in json.dumps(item, sort_keys=True).lower():
            raise PluginCloudSyncError("runtime policy must not include private keys")
        if item.get("minimum_runtime_version") and not SEMVERISH_RE.fullmatch(str(item["minimum_runtime_version"])):
            raise PluginCloudSyncError("runtime policy minimum_runtime_version must be SemVer")
        if item.get("max_tool_timeout_ms") is not None:
            try:
                max_tool_timeout_ms = int(item["max_tool_timeout_ms"])
            except (TypeError, ValueError) as exc:
                raise PluginCloudSyncError("runtime policy max_tool_timeout_ms must be positive") from exc
            if max_tool_timeout_ms <= 0:
                raise PluginCloudSyncError("runtime policy max_tool_timeout_ms must be positive")


def _validate_cloud_evidence_summary(summary: dict[str, Any]) -> None:
    text = json.dumps(summary, sort_keys=True, ensure_ascii=False)
    denied_keys = {"output", "raw_output", "stderr", "stdout", "workspace", "artifact_path", "path"}
    if _contains_denied_key(summary, denied_keys):
        raise PluginCloudSyncError("evidence summary must not include raw output or local paths")
    if "/Users/" in text or "\\Users\\" in text:
        raise PluginCloudSyncError("evidence summary must not include workspace paths")
    if "ghp_" in text or "sk-" in text:
        raise PluginCloudSyncError("evidence summary must not include secret values")
    missing = [field for field in EVIDENCE_SUMMARY_REQUIRED_FIELDS if field not in summary]
    if missing:
        raise PluginCloudSyncError(f"evidence summary missing required fields: {', '.join(missing)}")
    _validate_evidence_summary_string(summary, "run_id", safe_identifier=True)
    _validate_evidence_summary_string(summary, "plugin_id", pattern=PLUGIN_ID_RE)
    _validate_evidence_summary_string(summary, "plugin_version", pattern=SEMVER_RE)
    _validate_evidence_summary_string(summary, "package_digest", pattern=SHA256_RE)
    _validate_evidence_summary_string(summary, "tool_name", pattern=TOOL_NAME_RE)
    _validate_evidence_summary_string(summary, "input_digest", pattern=SHA256_RE)
    _validate_evidence_summary_string(summary, "output_digest", pattern=SHA256_RE)
    _validate_evidence_summary_string(summary, "evidence_artifact_id", safe_identifier=True)
    entitlement_id = summary.get("entitlement_id")
    if entitlement_id is not None and (not isinstance(entitlement_id, str) or not entitlement_id.strip()):
        raise PluginCloudSyncError("evidence summary entitlement_id must be a string or null")
    if summary.get("status") not in EVIDENCE_SUMMARY_STATUSES:
        allowed = ", ".join(sorted(EVIDENCE_SUMMARY_STATUSES))
        raise PluginCloudSyncError(f"evidence summary status must be one of: {allowed}")
    started_at = _parse_evidence_summary_time(summary, "started_at")
    finished_at = _parse_evidence_summary_time(summary, "finished_at")
    if finished_at < started_at:
        raise PluginCloudSyncError("evidence summary finished_at must be after started_at")


def _parse_evidence_summary_time(summary: dict[str, Any], field: str) -> datetime:
    value = summary.get(field)
    if not isinstance(value, str) or not value.strip():
        raise PluginCloudSyncError(f"evidence summary {field} must be an RFC3339 timestamp")
    try:
        return _parse_time(value)
    except ValueError as exc:
        raise PluginCloudSyncError(f"evidence summary {field} must be an RFC3339 timestamp") from exc


def _validate_evidence_summary_string(
    summary: dict[str, Any],
    field: str,
    *,
    pattern: re.Pattern[str] | None = None,
    safe_identifier: bool = False,
) -> None:
    value = summary.get(field)
    if not isinstance(value, str) or not value.strip():
        raise PluginCloudSyncError(f"evidence summary {field} must be a non-empty string")
    if pattern and not pattern.fullmatch(value):
        raise PluginCloudSyncError(f"evidence summary {field} has invalid format")
    if safe_identifier:
        _validate_safe_identifier(value, field=f"evidence summary {field}")


def _validate_safe_identifier(value: str, *, field: str) -> None:
    if "/" in value or "\\" in value or ".." in value or not SAFE_ID_PATTERN.fullmatch(value):
        raise PluginCloudSyncError(f"unsafe {field}")


def _contains_denied_key(value: Any, denied_keys: set[str]) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key) in denied_keys:
                return True
            if _contains_denied_key(item, denied_keys):
                return True
    if isinstance(value, list):
        return any(_contains_denied_key(item, denied_keys) for item in value)
    return False


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PluginCloudSyncError(f"missing file: {path}") from exc
    if not isinstance(data, dict):
        raise PluginCloudSyncError(f"expected JSON object: {path}")
    return data


def _read_optional_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    return _read_json(path)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def _digest_json(payload: Any) -> str:
    return f"sha256:{hashlib.sha256(_json_bytes(payload)).hexdigest()}"


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _parse_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "y"}


def _version_sort_key(version: str) -> tuple[int, int, int, str]:
    core, _, suffix = version.partition("-")
    parts = core.split(".")
    numbers: list[int] = []
    for part in parts[:3]:
        try:
            numbers.append(int(part))
        except ValueError:
            numbers.append(0)
    while len(numbers) < 3:
        numbers.append(0)
    return (numbers[0], numbers[1], numbers[2], suffix)


def _short_lived_expiry() -> str:
    return (datetime.now(UTC) + timedelta(minutes=5)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extract_plugin_field(payload: Any, field: str) -> Any:
    if isinstance(payload, dict):
        if field in payload:
            return payload[field]
        for value in payload.values():
            found = _extract_plugin_field(value, field)
            if found is not None:
                return found
    if isinstance(payload, list):
        for value in payload:
            found = _extract_plugin_field(value, field)
            if found is not None:
                return found
    return None


def copy_package_into_fake_registry(source: Path, cloud_root: Path, plugin_id: str, version: str) -> Path:
    """Test/helper utility for creating local fake-cloud registry fixtures."""
    source_digest, kind = _package_publish_identity(source, plugin_id, version)
    target = cloud_root / "registry" / "plugins" / plugin_id / version / "package"
    if target.exists():
        existing_digest, _existing_kind = _package_publish_identity(target, plugin_id, version)
        if existing_digest != source_digest:
            raise PluginCloudSyncError(
                f"registry package already exists with different digest: {plugin_id}@{version}"
            )
        return target
    metadata_path = target.parent / "metadata.json"
    if metadata_path.exists():
        metadata = _read_json(metadata_path)
        metadata_digest = metadata.get("package_digest")
        if metadata_digest is not None and metadata_digest != source_digest:
            raise PluginCloudSyncError(
                f"registry metadata already pins different digest for {plugin_id}@{version}"
            )
    try:
        assert_immutable_digest(
            cloud_root=cloud_root,
            kind=kind,
            capability_id=plugin_id,
            version=version,
            digest=source_digest,
        )
    except CapabilityRegistryError as exc:
        raise PluginCloudSyncError(str(exc)) from exc
    shutil.copytree(source, target)
    return target


def _package_publish_identity(source: Path, plugin_id: str, version: str) -> tuple[str, str]:
    package = load_plugin_package(source)
    try:
        if package.plugin_id != plugin_id or package.version != version:
            raise PluginCloudSyncError(
                f"package identity mismatch: {package.plugin_id}@{package.version}"
            )
        kind = "skill" if is_skill_origin_plugin(package.plugin_id, package.manifest.get("skill_origin")) else "plugin"
        return compute_package_digest(package), kind
    finally:
        package.cleanup()
