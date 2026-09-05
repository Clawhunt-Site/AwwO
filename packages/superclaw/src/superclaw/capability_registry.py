"""Projection for ClawHunt-admin capability registry entries.

The production registry is expected to publish immutable, approved
``{kind, id, version, digest}`` facts. This module keeps that contract local and
testable: callers can load a JSON file fixture, use a monkeypatched fetcher, or
publish local entries without depending on live ClawHunt network state.
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from string import hexdigits
from pathlib import Path
from typing import Any

from superclaw.trust_state import FIRST_PARTY_NAMESPACES, TrustState

CAPABILITY_KINDS = {"plugin", "skill", "company"}
DEFAULT_CAPABILITY_REGISTRY_NAME = "capabilities.json"
APPROVED_STATUSES = {"active", "approved", "published", "public", "private", "private_beta", "limited", "unlisted"}
REVOKED_STATUSES = {"replaced", "revoked", "blocked", "disabled"}
SKIPPED_STATUSES = {"pending", "draft", "rejected", "failed", "quarantined"}


class CapabilityRegistryError(ValueError):
    """Raised when a local capability registry contract is malformed."""


@dataclass(frozen=True)
class CapabilityRegistryEntry:
    kind: str
    capability_id: str
    version: str
    digest: str
    status: str
    name: str | None = None
    summary: str | None = None
    logo_url: str | None = None
    trust: TrustState = TrustState.DEVELOPER
    signer_class: str = "developer:registry"
    trust_reasons: tuple[str, ...] = ("approved_registry_entry",)
    namespace_reserved: bool = False
    entitlement_required: bool = False
    skill_origin: bool = False
    instantiable: bool = True
    metadata: Mapping[str, Any] | None = None
    revocation: Mapping[str, Any] | None = None

    @property
    def revoked(self) -> bool:
        return self.status in REVOKED_STATUSES


class CapabilityRegistryClient:
    """Load ClawHunt admin registry JSON from a file or injected fetcher."""

    def __init__(self, source: str | Path, *, fetch_json: Callable[[str], Any] | None = None) -> None:
        self.source = source
        self.fetch_json = fetch_json

    def load(self) -> tuple[CapabilityRegistryEntry, ...]:
        return normalize_capability_registry_payload(_load_source_payload(self.source, fetch_json=self.fetch_json))


def load_capability_registry_entries(
    cloud_root: Path,
    *,
    source: str | Path | None = None,
    include_revoked: bool = False,
) -> tuple[CapabilityRegistryEntry, ...]:
    registry_source = source or cloud_root / "registry" / DEFAULT_CAPABILITY_REGISTRY_NAME
    if isinstance(registry_source, Path) and not registry_source.exists():
        return ()
    if not isinstance(registry_source, Path):
        source_text = str(registry_source)
        if not source_text.startswith(("http://", "https://", "file://", "r2://")) and not Path(source_text).exists():
            return ()
    entries = CapabilityRegistryClient(registry_source).load()
    if include_revoked:
        return entries
    return tuple(entry for entry in entries if not entry.revoked)


def publish_capability_registry_entry(
    cloud_root: Path,
    entry: Mapping[str, Any],
    *,
    registry_file: Path | None = None,
) -> Path:
    """Append one immutable capability registry event.

    A later event may revoke or replace a previously approved digest, but a
    kind/id/version tuple can never be repointed to different bytes.
    """
    registry_file = registry_file or cloud_root / "registry" / DEFAULT_CAPABILITY_REGISTRY_NAME
    raw_payload = _read_registry_payload(registry_file)
    payload = dict(raw_payload) if isinstance(raw_payload, Mapping) else {"entries": list(raw_payload)}
    normalized = _normalize_entry(entry)
    raw_entries = list(_raw_entries(payload))

    for existing_raw in raw_entries:
        existing = _normalize_entry(existing_raw)
        if _entry_key(existing) != _entry_key(normalized):
            continue
        if existing.digest != normalized.digest:
            raise CapabilityRegistryError(
                f"registry entry already exists with different digest: "
                f"{normalized.kind}:{normalized.capability_id}@{normalized.version}"
            )
        if dict(existing_raw) == dict(entry):
            break
    else:
        raw_entries.append(dict(entry))

    payload["schema_version"] = str(payload.get("schema_version") or "clawhunt.admin.capability_registry.v1")
    payload["entries"] = raw_entries
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    registry_file.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return registry_file


def assert_immutable_digest(
    *,
    cloud_root: Path,
    kind: str,
    capability_id: str,
    version: str,
    digest: str,
    registry_file: Path | None = None,
) -> None:
    """Reject publishing a different digest for an existing kind/id/version."""
    registry_file = registry_file or cloud_root / "registry" / DEFAULT_CAPABILITY_REGISTRY_NAME
    if not registry_file.exists():
        return
    candidate = _normalize_entry(
        {
            "kind": kind,
            "capability_id": capability_id,
            "version": version,
            "package_digest": digest,
            "status": "approved",
        }
    )
    for existing in normalize_capability_registry_payload(_read_registry_payload(registry_file)):
        if _entry_key(existing) == _entry_key(candidate) and existing.digest != candidate.digest:
            raise CapabilityRegistryError(
                f"registry entry already exists with different digest: {kind}:{capability_id}@{version}"
            )


def normalize_capability_registry_payload(payload: Mapping[str, Any] | list[Any]) -> tuple[CapabilityRegistryEntry, ...]:
    entries_by_key: dict[tuple[str, str, str], CapabilityRegistryEntry] = {}
    order: list[tuple[str, str, str]] = []
    seen: dict[tuple[str, str, str], str] = {}
    for raw in _raw_entries(payload):
        try:
            entry = _normalize_entry(raw)
        except CapabilityRegistryError:
            continue
        key = _entry_key(entry)
        existing_digest = seen.get(key)
        if existing_digest is not None and existing_digest != entry.digest:
            raise CapabilityRegistryError(f"registry payload contains conflicting digests for {entry.kind}:{entry.capability_id}@{entry.version}")
        seen[key] = entry.digest
        if key not in entries_by_key:
            order.append(key)
        entries_by_key[key] = entry
    return tuple(entries_by_key[key] for key in order)


def latest_approved_capability_manifests(
    cloud_root: Path,
    *,
    source: str | Path | None = None,
) -> tuple[dict[str, Any], ...]:
    """Return latest approved manifest facts for plugin, skill, and company sync."""
    latest: dict[tuple[str, str], CapabilityRegistryEntry] = {}
    for entry in load_capability_registry_entries(cloud_root, source=source):
        key = (entry.kind, entry.capability_id)
        existing = latest.get(key)
        if existing is None or _version_sort_key(entry.version) > _version_sort_key(existing.version):
            latest[key] = entry
    return tuple(_registry_manifest(entry) for entry in sorted(latest.values(), key=lambda item: (item.kind, item.capability_id)))


def get_capability_registry_download_reference(
    cloud_root: Path,
    *,
    kind: str,
    capability_id: str,
    version: str,
    source: str | Path | None = None,
) -> dict[str, Any]:
    normalized_kind = str(kind).strip().lower()
    for entry in load_capability_registry_entries(cloud_root, source=source):
        if entry.kind == normalized_kind and entry.capability_id == capability_id and entry.version == version:
            artifact_ref = None
            metadata = entry.metadata or {}
            artifact = metadata.get("artifact") if isinstance(metadata.get("artifact"), Mapping) else {}
            if isinstance(artifact, Mapping):
                artifact_ref = artifact.get("ref")
            return {
                "kind": entry.kind,
                "capability_id": entry.capability_id,
                f"{entry.kind}_id": entry.capability_id,
                "version": entry.version,
                "package_digest": entry.digest,
                "artifact_blob_digest": entry.digest,
                "download_url": f"superclaw-local://capabilities/{entry.kind}/{entry.capability_id}/versions/{entry.version}/artifact",
                "artifact_ref": artifact_ref,
            }
    raise CapabilityRegistryError(f"capability not found in registry: {kind}:{capability_id}@{version}")


def _registry_manifest(entry: CapabilityRegistryEntry) -> dict[str, Any]:
    payload = {
        "kind": entry.kind,
        "capability_id": entry.capability_id,
        f"{entry.kind}_id": entry.capability_id,
        "version": entry.version,
        "name": entry.name,
        "summary": entry.summary,
        "package_digest": entry.digest,
        "artifact_blob_digest": entry.digest,
        "digest": entry.digest,
        "status": entry.status,
        "trust": entry.trust.value,
        "signer_class": entry.signer_class,
        "trust_reasons": list(entry.trust_reasons),
        "namespace_reserved": entry.namespace_reserved,
        "entitlement_required": entry.entitlement_required,
        "skill_origin": entry.skill_origin,
        "instantiable": entry.instantiable,
        "logo_url": entry.logo_url,
        "metadata": dict(entry.metadata or {}),
    }
    return {key: value for key, value in payload.items() if value is not None}


def _version_sort_key(version: str) -> tuple[int, tuple[int, ...] | str]:
    parts = str(version).split(".")
    if parts and all(part.isdigit() for part in parts):
        return (0, tuple(int(part) for part in parts))
    return (1, str(version))


def _load_source_payload(source: str | Path, *, fetch_json: Callable[[str], Any] | None = None) -> Mapping[str, Any] | list[Any]:
    if isinstance(source, Path):
        return _read_registry_payload(source)
    source_text = str(source)
    if source_text.startswith("file://"):
        return _read_registry_payload(Path(source_text.removeprefix("file://")))
    if source_text.startswith(("http://", "https://")):
        if fetch_json is not None:
            payload = fetch_json(source_text)
            if not isinstance(payload, (Mapping, list)):
                raise CapabilityRegistryError("capability registry fetcher must return a JSON object or list")
            return payload
        with urllib.request.urlopen(source_text, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, (Mapping, list)):
            raise CapabilityRegistryError("capability registry response must be a JSON object or list")
        return payload
    if source_text.startswith("r2://"):
        from superclaw.capability_r2 import CapabilityR2Error, get_r2_object_text

        try:
            payload = json.loads(get_r2_object_text(source_text))
        except (CapabilityR2Error, json.JSONDecodeError) as exc:
            raise CapabilityRegistryError(str(exc)) from exc
        if not isinstance(payload, (Mapping, list)):
            raise CapabilityRegistryError("capability registry R2 object must be a JSON object or list")
        return payload
    return _read_registry_payload(Path(source_text))


def _read_registry_payload(registry_file: Path) -> Mapping[str, Any] | list[Any]:
    if not registry_file.exists():
        return {"schema_version": "clawhunt.admin.capability_registry.v1", "entries": []}
    payload = json.loads(registry_file.read_text(encoding="utf-8"))
    if not isinstance(payload, (dict, list)):
        raise CapabilityRegistryError("capability registry must be a JSON object or list")
    return payload


def _raw_entries(payload: Mapping[str, Any] | list[Any]) -> tuple[Mapping[str, Any], ...]:
    if isinstance(payload, list):
        return tuple(item for item in payload if isinstance(item, Mapping))
    candidates = payload.get("entries", payload.get("capabilities", payload.get("items", payload.get("targets", []))))
    if not isinstance(candidates, list):
        raise CapabilityRegistryError("capability registry entries must be a list")
    return tuple(item for item in candidates if isinstance(item, Mapping))


def _normalize_entry(raw: Mapping[str, Any]) -> CapabilityRegistryEntry:
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), Mapping) else {}
    listing = raw.get("listing") if isinstance(raw.get("listing"), Mapping) else {}
    revocation = raw.get("revocation") if isinstance(raw.get("revocation"), Mapping) else {}
    artifact = raw.get("artifact") if isinstance(raw.get("artifact"), Mapping) else {}
    kind = _entry_kind(raw, metadata)
    capability_id = _entry_id(raw, metadata, kind)
    version = str(raw.get("version") or raw.get("artifact_version") or metadata.get("version") or "").strip()
    digest = _normalize_sha256_digest(
        raw.get("package_digest")
        or raw.get("digest")
        or raw.get("sha256_digest")
        or raw.get("sha256")
        or artifact.get("package_digest")
        or artifact.get("digest")
        or artifact.get("sha256_digest")
        or metadata.get("package_digest")
        or metadata.get("digest")
        or metadata.get("sha256_digest")
        or ""
    )
    status = _entry_status(raw)
    if status in SKIPPED_STATUSES:
        raise CapabilityRegistryError("capability registry entry is not approved")
    if status not in APPROVED_STATUSES and status not in REVOKED_STATUSES:
        raise CapabilityRegistryError("capability registry entry has unknown status")
    if not kind or kind not in CAPABILITY_KINDS:
        raise CapabilityRegistryError("capability registry entry has invalid kind")
    if not capability_id:
        raise CapabilityRegistryError("capability registry entry missing id")
    if not version:
        raise CapabilityRegistryError("capability registry entry missing version")
    if not _valid_sha256_digest(digest):
        raise CapabilityRegistryError("capability registry entry digest must be sha256:<hex>")
    trust, signer_class, reasons = _entry_trust(raw, status, capability_id)
    return CapabilityRegistryEntry(
        kind=kind,
        capability_id=capability_id,
        version=version,
        digest=digest,
        status=status,
        name=_optional_str(raw.get("name") or listing.get("name") or metadata.get("name")),
        summary=_optional_str(raw.get("summary") or listing.get("summary") or metadata.get("summary")),
        logo_url=_optional_str(raw.get("logo_url") or raw.get("logo") or listing.get("logo_url") or listing.get("logo")),
        trust=trust,
        signer_class=signer_class,
        trust_reasons=reasons,
        namespace_reserved=any(capability_id.startswith(prefix) for prefix in FIRST_PARTY_NAMESPACES),
        entitlement_required=bool(raw.get("entitlement_required") or metadata.get("entitlement_required")),
        skill_origin=kind == "skill" or bool(raw.get("skill_origin") or metadata.get("skill_origin")),
        instantiable=False if kind == "company" else bool(raw.get("instantiable", True)),
        metadata={key: value for key, value in metadata.items()},
        revocation={key: value for key, value in revocation.items()} if revocation else None,
    )


def _entry_kind(raw: Mapping[str, Any], metadata: Mapping[str, Any]) -> str:
    value = str(raw.get("kind") or raw.get("artifact_kind") or raw.get("type") or metadata.get("kind") or "").strip().lower()
    if not value and (raw.get("company_id") or metadata.get("company_id")):
        value = "company"
    if value == "capability":
        value = str(raw.get("capability_kind") or metadata.get("capability_kind") or "").strip().lower()
    if value == "tool":
        value = "plugin"
    return value


def _entry_id(raw: Mapping[str, Any], metadata: Mapping[str, Any], kind: str) -> str:
    kind_id_key = f"{kind}_id"
    return str(
        raw.get(kind_id_key)
        or metadata.get(kind_id_key)
        or raw.get("plugin_id")
        or metadata.get("plugin_id")
        or raw.get("capability_id")
        or metadata.get("capability_id")
        or raw.get("artifact_id")
        or metadata.get("artifact_id")
        or raw.get("id")
        or metadata.get("id")
        or ""
    ).strip()


def _entry_status(raw: Mapping[str, Any]) -> str:
    if raw.get("revoked") is True:
        return "revoked"
    status = str(
        raw.get("status")
        or raw.get("publication_status")
        or raw.get("approval_status")
        or raw.get("review_status")
        or ""
    ).strip().lower()
    if status:
        return status
    if raw.get("approved") is False:
        return "rejected"
    return "approved" if raw.get("approved", True) is True else "pending"


def _entry_trust(raw: Mapping[str, Any], status: str, capability_id: str) -> tuple[TrustState, str, tuple[str, ...]]:
    if status in REVOKED_STATUSES:
        return TrustState.UNTRUSTED, "none", ("revoked",)
    trust_value = str(raw.get("trust") or raw.get("trust_state") or raw.get("approval_trust") or "developer").strip().lower()
    signer_class = str(raw.get("signer_class") or raw.get("signer") or "").strip()
    if trust_value == "official":
        return TrustState.OFFICIAL, signer_class or "root", ("approved_registry_entry",)
    if trust_value == "local":
        # A capability registry is the REMOTE/published catalog. `local` trust means
        # "locally built / unsigned", which is illegitimate for a remotely-published
        # artifact: the authoritative trust contract (trust_state.py) only yields LOCAL
        # for a genuinely LOCAL source, and a remote entry self-declaring `local` must
        # fail closed — otherwise a remote artifact could badge itself locally-trusted
        # (and, for company, become instantiable) without ever verifying (owner trust
        # model RED LINE: remote content MUST verify or be untrusted). So a registry
        # `trust=local` self-label reads UNTRUSTED, not LOCAL.
        return TrustState.UNTRUSTED, "none", ("registry_local_not_allowed",)
    if trust_value == "untrusted":
        return TrustState.UNTRUSTED, signer_class or "none", ("registry_untrusted",)
    if any(capability_id.startswith(prefix) for prefix in FIRST_PARTY_NAMESPACES):
        return TrustState.UNTRUSTED, "none", ("namespace_hijack",)
    if not signer_class:
        keyid = str(raw.get("signer_keyid") or raw.get("developer_keyid") or "registry").strip()
        signer_class = f"developer:{keyid}"
    return TrustState.DEVELOPER, signer_class, ("approved_registry_entry",)


def _entry_key(entry: CapabilityRegistryEntry) -> tuple[str, str, str]:
    return (entry.kind, entry.capability_id, entry.version)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _valid_sha256_digest(value: str) -> bool:
    return value.startswith("sha256:") and len(value) == 71 and all(char in hexdigits for char in value[7:])


def _normalize_sha256_digest(value: Any) -> str:
    digest = str(value or "").strip().lower()
    if digest.startswith("sha256:"):
        return digest
    if len(digest) == 64 and all(char in hexdigits for char in digest):
        return f"sha256:{digest}"
    return digest


__all__ = [
    "CapabilityRegistryClient",
    "CapabilityRegistryEntry",
    "CapabilityRegistryError",
    "assert_immutable_digest",
    "get_capability_registry_download_reference",
    "latest_approved_capability_manifests",
    "load_capability_registry_entries",
    "normalize_capability_registry_payload",
    "publish_capability_registry_entry",
]
