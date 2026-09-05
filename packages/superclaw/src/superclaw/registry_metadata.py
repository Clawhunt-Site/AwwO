"""TUF-style registry metadata for Capability Workshop trust refresh.

This module verifies a deliberately small local TUF-style bundle:
``root.json``, ``timestamp.json``, ``snapshot.json``, and ``targets.json``.
The bundle declares discoverability and delegated developer keys; it never
authorizes execution by itself. Runtime/catalog trust still flows through
``derive_trust_state`` and entitlement/policy gates.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from superclaw.trust_state import FIRST_PARTY_NAMESPACES

REGISTRY_ROOT_PUBLIC_KEY_ENV = "SUPERCLAW_REGISTRY_ROOT_PUBLIC_KEY"
TRUST_STATE_NAME = "trust-state.json"
METADATA_FILES = ("root.json", "timestamp.json", "snapshot.json", "targets.json")


class RegistryMetadataError(ValueError):
    """Raised when registry trust metadata fails closed."""


@dataclass(frozen=True)
class RegistryTarget:
    kind: str
    artifact_id: str
    version: str
    digest: str
    signer_keyid: str | None


@dataclass(frozen=True)
class RegistryMetadataState:
    registry_root: Path
    root_sequence: int
    timestamp_sequence: int
    snapshot_sequence: int
    targets_sequence: int
    watermark_sequence: int
    fresh: bool
    expires_at: str | None
    stale_reason: str | None
    developer_keys: dict[str, str]
    targets: tuple[RegistryTarget, ...]

    @property
    def active_developer_keyids(self) -> frozenset[str]:
        return frozenset(self.developer_keys)

    def freshness_payload(self) -> dict[str, Any]:
        return {
            "fresh": self.fresh,
            "expires_at": self.expires_at,
            "stale_reason": self.stale_reason,
            "timestamp_sequence": self.timestamp_sequence,
            "snapshot_sequence": self.snapshot_sequence,
            "targets_sequence": self.targets_sequence,
        }

    def target_keyid_for(self, *, kind: str, artifact_id: str, version: str, digest: str) -> str | None:
        for target in self.targets:
            if (
                target.kind == kind
                and target.artifact_id == artifact_id
                and target.version == version
                and target.digest == digest
            ):
                return target.signer_keyid
        return None


@dataclass(frozen=True)
class RegistryRefreshResult:
    ok: bool
    refreshed_at: str
    registry_root: str
    source_url: str | None = None
    kept_cached: bool = True
    watermark_sequence: int | None = None
    registry_freshness: dict[str, Any] | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": self.ok,
            "refreshed_at": self.refreshed_at,
            "registry_root": self.registry_root,
            "source_url": self.source_url,
            "kept_cached": self.kept_cached,
        }
        if self.watermark_sequence is not None:
            payload["watermark_sequence"] = self.watermark_sequence
        if self.registry_freshness is not None:
            payload["registry_freshness"] = self.registry_freshness
        if self.error:
            payload["error"] = self.error
        return payload


def load_registry_metadata(
    registry_root: Path,
    *,
    public_key: str | None = None,
    now: datetime | None = None,
) -> RegistryMetadataState | None:
    """Load and verify cached registry metadata.

    Missing metadata returns ``None`` so catalog discovery can show an explicit
    ``registry_metadata_not_configured`` freshness state. Malformed, stale, or
    rolled-back metadata raises: callers decide whether to present that as a
    fail-closed refresh error or an untrusted developer state.
    """
    registry_root = Path(registry_root)
    if not any((registry_root / name).exists() for name in METADATA_FILES):
        return None
    _require_all_metadata_files(registry_root)
    state = _verify_bundle(registry_root, public_key=public_key, now=now)
    _write_trust_state(registry_root, state)
    return state


def refresh_trust_registry(
    *,
    registry_root: Path,
    source_url: str | None = None,
    public_key: str | None = None,
    now: datetime | None = None,
) -> RegistryRefreshResult:
    """Refresh registry metadata while preserving the last cached state on error."""
    root = Path(registry_root)
    root.mkdir(parents=True, exist_ok=True)
    refreshed_at = _utc_now(now)
    try:
        source = _source_path(source_url)
        if source is None:
            state = load_registry_metadata(root, public_key=public_key, now=now)
            if state is None:
                raise RegistryMetadataError("registry metadata backend is not configured")
            return RegistryRefreshResult(
                ok=True,
                refreshed_at=refreshed_at,
                registry_root=str(root),
                source_url=source_url,
                kept_cached=True,
                watermark_sequence=state.watermark_sequence,
                registry_freshness=state.freshness_payload(),
            )

        _require_all_metadata_files(source)
        tmp = Path(tempfile.mkdtemp(prefix="superclaw-registry-refresh-"))
        try:
            for name in METADATA_FILES:
                shutil.copy2(source / name, tmp / name)
            state = _verify_bundle(tmp, public_key=public_key, watermark_root=root, now=now)
            for name in METADATA_FILES:
                shutil.copy2(tmp / name, root / name)
            state = load_registry_metadata(root, public_key=public_key, now=now)
            if state is None:
                raise RegistryMetadataError("registry metadata backend is not configured")
            return RegistryRefreshResult(
                ok=True,
                refreshed_at=refreshed_at,
                registry_root=str(root),
                source_url=source_url,
                kept_cached=False,
                watermark_sequence=state.watermark_sequence,
                registry_freshness=state.freshness_payload(),
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        return RegistryRefreshResult(
            ok=False,
            refreshed_at=refreshed_at,
            registry_root=str(root),
            source_url=source_url,
            kept_cached=True,
            error=str(exc),
        )


def assert_freshness_for_high_risk(
    registry_root: Path,
    *,
    high_risk: bool,
    public_key: str | None = None,
    now: datetime | None = None,
) -> None:
    """Fail closed for high-risk developer use when timestamp freshness is stale."""
    if not high_risk:
        return
    state = load_registry_metadata(registry_root, public_key=public_key, now=now)
    if state is None:
        raise RegistryMetadataError("registry metadata not configured for high-risk developer trust")
    if not state.fresh:
        raise RegistryMetadataError(state.stale_reason or "registry metadata stale")


def registry_freshness_from_state_file(registry_root: Path) -> dict[str, Any]:
    state_path = Path(registry_root) / TRUST_STATE_NAME
    if not state_path.exists():
        return {"fresh": None, "expires_at": None, "stale_reason": "registry_metadata_not_configured"}
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return {"fresh": False, "expires_at": None, "stale_reason": "registry_metadata_invalid"}
    return {
        "fresh": payload.get("fresh"),
        "expires_at": payload.get("expires_at"),
        "stale_reason": payload.get("stale_reason"),
        "watermark_sequence": payload.get("watermark_sequence"),
        "timestamp_sequence": payload.get("timestamp_sequence"),
        "snapshot_sequence": payload.get("snapshot_sequence"),
        "targets_sequence": payload.get("targets_sequence"),
    }


def classify_developer_signer(
    *,
    digest: str,
    signature: str,
    kind: str,
    artifact_id: str,
    version: str,
    state: RegistryMetadataState | None,
) -> str | None:
    """Return ``developer:<keyid>`` only for a signed, delegated exact target."""
    if state is None:
        return None
    keyid = state.target_keyid_for(kind=kind, artifact_id=artifact_id, version=version, digest=digest)
    if not keyid:
        return None
    public_key = state.developer_keys.get(keyid)
    if not public_key:
        return None
    try:
        _verify_ed25519(digest.encode("utf-8"), signature, public_key)
    except RegistryMetadataError:
        return None
    return f"developer:{keyid}"


def _verify_bundle(
    registry_root: Path,
    *,
    public_key: str | None,
    watermark_root: Path | None = None,
    now: datetime | None = None,
) -> RegistryMetadataState:
    root_doc = _read_signed(registry_root / "root.json")
    root_signed = root_doc["signed"]
    root_public_key = public_key or os.environ.get(REGISTRY_ROOT_PUBLIC_KEY_ENV)
    if not root_public_key:
        raise RegistryMetadataError(f"missing {REGISTRY_ROOT_PUBLIC_KEY_ENV}")
    _verify_signed_doc(root_doc, root_public_key)

    keys = root_signed.get("keys")
    if not isinstance(keys, dict):
        raise RegistryMetadataError("root metadata missing keys")
    timestamp_key = _role_key(keys, "timestamp")
    snapshot_key = _role_key(keys, "snapshot")
    targets_key = _role_key(keys, "targets")

    timestamp_doc = _read_signed(registry_root / "timestamp.json")
    snapshot_doc = _read_signed(registry_root / "snapshot.json")
    targets_doc = _read_signed(registry_root / "targets.json")
    _verify_signed_doc(timestamp_doc, timestamp_key)
    _verify_signed_doc(snapshot_doc, snapshot_key)
    _verify_signed_doc(targets_doc, targets_key)

    timestamp_signed = timestamp_doc["signed"]
    snapshot_signed = snapshot_doc["signed"]
    targets_signed = targets_doc["signed"]
    _assert_doc_type(root_signed, "root")
    _assert_doc_type(timestamp_signed, "timestamp")
    _assert_doc_type(snapshot_signed, "snapshot")
    _assert_doc_type(targets_signed, "targets")

    for name, doc in (("snapshot.json", snapshot_doc), ("targets.json", targets_doc)):
        _assert_meta_digest(timestamp_signed, name, doc)
    _assert_meta_digest(snapshot_signed, "targets.json", targets_doc)

    root_sequence = _sequence(root_signed, "root")
    timestamp_sequence = _sequence(timestamp_signed, "timestamp")
    snapshot_sequence = _sequence(snapshot_signed, "snapshot")
    targets_sequence = _sequence(targets_signed, "targets")
    watermark_root = watermark_root or registry_root
    current_watermark = _read_watermark(watermark_root)
    if snapshot_sequence < current_watermark:
        raise RegistryMetadataError(
            f"registry metadata rollback: snapshot sequence {snapshot_sequence} < watermark {current_watermark}"
        )

    expires_at = _optional_string(timestamp_signed.get("expires_at"))
    fresh = True
    stale_reason = None
    if expires_at:
        expires = _parse_time(expires_at)
        current = now or datetime.now(UTC)
        if expires <= current:
            fresh = False
            stale_reason = "timestamp_expired"

    developer_keys = _developer_keys(targets_signed)
    targets = _targets(targets_signed, developer_keys)
    return RegistryMetadataState(
        registry_root=registry_root,
        root_sequence=root_sequence,
        timestamp_sequence=timestamp_sequence,
        snapshot_sequence=snapshot_sequence,
        targets_sequence=targets_sequence,
        watermark_sequence=max(current_watermark, snapshot_sequence),
        fresh=fresh,
        expires_at=expires_at,
        stale_reason=stale_reason,
        developer_keys=developer_keys,
        targets=tuple(targets),
    )


def _read_signed(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RegistryMetadataError(f"registry metadata unreadable: {path.name}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("signed"), dict) or not isinstance(payload.get("signatures"), list):
        raise RegistryMetadataError(f"registry metadata malformed: {path.name}")
    return payload


def _verify_signed_doc(doc: dict[str, Any], public_key: str) -> None:
    signed_bytes = _canonical_bytes(doc["signed"])
    signatures = doc.get("signatures", [])
    for item in signatures:
        if isinstance(item, dict) and isinstance(item.get("signature"), str):
            try:
                _verify_ed25519(signed_bytes, str(item["signature"]), public_key)
                return
            except RegistryMetadataError:
                continue
    raise RegistryMetadataError("registry metadata signature invalid")


def _verify_ed25519(payload: bytes, signature: str, public_key: str) -> None:
    if not signature.startswith("ed25519:"):
        raise RegistryMetadataError("unsupported registry signature format")
    try:
        signature_bytes = base64.b64decode(signature.removeprefix("ed25519:"), validate=True)
        public_bytes = base64.b64decode(public_key.removeprefix("ed25519:"), validate=True)
        Ed25519PublicKey.from_public_bytes(public_bytes).verify(signature_bytes, payload)
    except (InvalidSignature, ValueError) as exc:
        raise RegistryMetadataError("registry metadata signature invalid") from exc


def _developer_keys(targets_signed: dict[str, Any]) -> dict[str, str]:
    delegations = targets_signed.get("delegations", {})
    developers = delegations.get("developers", {}) if isinstance(delegations, dict) else {}
    if not isinstance(developers, dict):
        raise RegistryMetadataError("developer delegations must be an object")
    keys: dict[str, str] = {}
    for keyid, info in developers.items():
        if not isinstance(info, dict):
            raise RegistryMetadataError("developer delegation must be an object")
        if info.get("revoked"):
            continue
        paths = info.get("paths", [])
        if not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
            raise RegistryMetadataError("developer delegation paths must be strings")
        for pattern in paths:
            prefix = pattern.removesuffix("*")
            if any(prefix.startswith(reserved) or reserved.startswith(prefix) for reserved in FIRST_PARTY_NAMESPACES):
                raise RegistryMetadataError("developer delegation claims reserved namespace")
        public_key = info.get("public_key")
        if not isinstance(public_key, str) or not public_key:
            raise RegistryMetadataError("developer delegation missing public_key")
        keys[str(keyid)] = public_key
    return keys


def _targets(targets_signed: dict[str, Any], developer_keys: dict[str, str]) -> list[RegistryTarget]:
    payload = targets_signed.get("targets", [])
    if not isinstance(payload, list):
        raise RegistryMetadataError("targets must be a list")
    delegations = targets_signed.get("delegations", {})
    developers = delegations.get("developers", {}) if isinstance(delegations, dict) else {}
    targets: list[RegistryTarget] = []
    for item in payload:
        if not isinstance(item, dict):
            raise RegistryMetadataError("target entry must be an object")
        kind = str(item.get("kind") or "")
        artifact_id = str(item.get("id") or item.get("plugin_id") or "")
        version = str(item.get("version") or "")
        digest = str(item.get("digest") or item.get("package_digest") or "")
        signer_keyid = item.get("signer_keyid")
        if kind not in {"plugin", "skill", "company"} or not artifact_id or not version or not digest:
            raise RegistryMetadataError("target entry missing kind/id/version/digest")
        if signer_keyid is not None:
            signer_keyid = str(signer_keyid)
            info = developers.get(signer_keyid)
            if signer_keyid not in developer_keys or not isinstance(info, dict):
                raise RegistryMetadataError("target references unknown developer signer")
            paths = [str(path) for path in info.get("paths", [])]
            if not _matches_any_path(artifact_id, paths):
                raise RegistryMetadataError("target is outside delegated developer paths")
        targets.append(RegistryTarget(kind=kind, artifact_id=artifact_id, version=version, digest=digest, signer_keyid=signer_keyid))
    return targets


def _matches_any_path(artifact_id: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if pattern.endswith("*") and artifact_id.startswith(pattern[:-1]):
            return True
        if artifact_id == pattern:
            return True
    return False


def _assert_meta_digest(parent_signed: dict[str, Any], name: str, doc: dict[str, Any]) -> None:
    meta = parent_signed.get("meta", {})
    expected = meta.get(name) if isinstance(meta, dict) else None
    if not isinstance(expected, dict):
        raise RegistryMetadataError(f"metadata missing meta for {name}")
    digest = expected.get("sha256")
    if digest and digest != _sha256_doc(doc):
        raise RegistryMetadataError(f"metadata digest mismatch for {name}")
    version = expected.get("version")
    signed_version = doc["signed"].get("sequence")
    if version is not None and int(version) != int(signed_version):
        raise RegistryMetadataError(f"metadata version mismatch for {name}")


def _write_trust_state(registry_root: Path, state: RegistryMetadataState) -> None:
    payload = {
        "watermark_sequence": state.watermark_sequence,
        "fresh": state.fresh,
        "expires_at": state.expires_at,
        "stale_reason": state.stale_reason,
        "timestamp_sequence": state.timestamp_sequence,
        "snapshot_sequence": state.snapshot_sequence,
        "targets_sequence": state.targets_sequence,
        "developer_keyids": sorted(state.developer_keys),
        "updated_at": _utc_now(None),
    }
    _write_json_atomic(registry_root / TRUST_STATE_NAME, payload)


def _read_watermark(registry_root: Path) -> int:
    path = registry_root / TRUST_STATE_NAME
    if not path.exists():
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return int(payload.get("watermark_sequence") or 0)
    except Exception:
        raise RegistryMetadataError("registry trust-state watermark invalid")


def _require_all_metadata_files(registry_root: Path) -> None:
    missing = [name for name in METADATA_FILES if not (registry_root / name).exists()]
    if missing:
        raise RegistryMetadataError(f"registry metadata missing: {', '.join(missing)}")


def _role_key(keys: dict[str, Any], role: str) -> str:
    value = keys.get(role)
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, str) or not value:
        raise RegistryMetadataError(f"root metadata missing {role} key")
    return value


def _assert_doc_type(signed: dict[str, Any], expected: str) -> None:
    if signed.get("type") != expected:
        raise RegistryMetadataError(f"expected {expected} metadata")


def _sequence(signed: dict[str, Any], label: str) -> int:
    try:
        sequence = int(signed.get("sequence"))
    except Exception as exc:
        raise RegistryMetadataError(f"{label} metadata missing sequence") from exc
    if sequence < 0:
        raise RegistryMetadataError(f"{label} metadata sequence must be non-negative")
    return sequence


def _source_path(source_url: str | None) -> Path | None:
    if not source_url:
        return None
    if source_url.startswith("file://"):
        return Path(source_url.removeprefix("file://"))
    candidate = Path(source_url)
    if candidate.exists():
        return candidate
    raise RegistryMetadataError("catalog refresh source must be a local path or file:// URL in this slice")


def _optional_string(value: Any) -> str | None:
    return str(value) if value not in {None, ""} else None


def _parse_time(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except Exception as exc:
        raise RegistryMetadataError(f"invalid timestamp expires_at: {value}") from exc


def _canonical_bytes(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_doc(doc: dict[str, Any]) -> str:
    import hashlib

    return hashlib.sha256(_canonical_bytes(doc["signed"])).hexdigest()


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _utc_now(now: datetime | None) -> str:
    current = now or datetime.now(UTC)
    return current.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


__all__ = [
    "REGISTRY_ROOT_PUBLIC_KEY_ENV",
    "RegistryMetadataError",
    "RegistryMetadataState",
    "RegistryRefreshResult",
    "RegistryTarget",
    "assert_freshness_for_high_risk",
    "classify_developer_signer",
    "load_registry_metadata",
    "refresh_trust_registry",
    "registry_freshness_from_state_file",
]
