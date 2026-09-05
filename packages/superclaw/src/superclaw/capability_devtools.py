from __future__ import annotations

import base64
import json
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx

from superclaw.capability_registry import (
    CapabilityRegistryClient,
    CapabilityRegistryEntry,
    publish_capability_registry_entry,
)
from superclaw.capability_submission import SEMVER_RE
from superclaw.company_template import _COMPANY_VERIFIER, load_company_template, validate_company_template_contract
from superclaw.harness import parse_markdown_with_frontmatter
from superclaw.plugin_devkit import PluginPackResult, pack_plugin_package
from superclaw.plugins import compute_package_digest, load_plugin_package
from superclaw.secrets_scan import contains_secret

CapabilityKind = Literal["plugin", "skill", "company"]

CAPABILITY_KINDS = {"plugin", "skill", "company"}
WORKSHOP_SUBMISSION_SCHEMA = "superclaw.capability_review_submission.v1"
WORKSHOP_STATUS_SCHEMA = "superclaw.capability_review_status.v1"
DEFAULT_REVIEW_API_PATH = "/v1/capabilities/submissions"
_SENSITIVE_KEY_RE = re.compile(
    r"(?:^|_)(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|"
    r"client[_-]?secret|refresh[_-]?token|private[_-]?key)(?:$|_)",
    re.IGNORECASE,
)


class CapabilityDevtoolError(ValueError):
    """Raised when Capability Workshop developer tooling fails closed."""


@dataclass(frozen=True)
class CapabilityPackageMetadata:
    kind: CapabilityKind
    capability_id: str
    version: str
    name: str | None
    summary: str | None
    artifact_digest: str
    artifact_path: Path
    artifact_filename: str
    package_format: str
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "capability_id": self.capability_id,
            f"{self.kind}_id": self.capability_id,
            "version": self.version,
            "name": self.name,
            "summary": self.summary,
            "artifact_digest": self.artifact_digest,
            "package_digest": self.artifact_digest,
            "artifact_filename": self.artifact_filename,
            "artifact_path": str(self.artifact_path),
            "package_format": self.package_format,
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class CapabilityBuildResult:
    metadata: CapabilityPackageMetadata
    package_path: Path

    def to_dict(self) -> dict[str, Any]:
        payload = self.metadata.to_dict()
        payload["package_path"] = str(self.package_path)
        return payload


@dataclass(frozen=True)
class CapabilitySubmissionResponse:
    ok: bool
    submission_id: str | None
    status: str | None
    response: dict[str, Any]
    request: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "submission_id": self.submission_id,
            "status": self.status,
            "request": self.request,
            "response": self.response,
        }


def validate_capability_artifact(kind: str, artifact_path: Path) -> CapabilityPackageMetadata:
    normalized_kind = _normalize_kind(kind)
    source = Path(artifact_path).resolve()
    if not source.exists():
        raise CapabilityDevtoolError(f"artifact path not found: {artifact_path}")
    if source.is_symlink():
        raise CapabilityDevtoolError("artifact path must not be a symlink")
    _reject_secret_bearing_artifact(source)
    if normalized_kind == "plugin":
        return _plugin_metadata(source)
    if normalized_kind == "skill":
        return _skill_metadata(source)
    return _company_metadata(source)


def build_capability_artifact(
    kind: str,
    artifact_path: Path,
    *,
    dist_dir: Path,
    dev_sign_plugin: bool = False,
    signing_private_key: str | None = None,
) -> CapabilityBuildResult:
    normalized_kind = _normalize_kind(kind)
    source = Path(artifact_path).resolve()
    if normalized_kind == "plugin":
        result: PluginPackResult = pack_plugin_package(
            source,
            dist_dir=dist_dir,
            dev_sign=dev_sign_plugin,
            signing_private_key=signing_private_key,
        )
        metadata = validate_capability_artifact("plugin", result.package_path)
        return CapabilityBuildResult(metadata=metadata, package_path=result.package_path)

    metadata = validate_capability_artifact(normalized_kind, source)
    dist_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".scskill" if normalized_kind == "skill" else ".sccompany"
    package_path = dist_dir / f"{_safe_filename(metadata.capability_id)}-{metadata.version}{suffix}"
    _write_deterministic_archive(source, package_path)
    packaged_metadata = validate_capability_artifact(normalized_kind, package_path)
    return CapabilityBuildResult(metadata=packaged_metadata, package_path=package_path)


def sign_capability_submission(
    metadata: CapabilityPackageMetadata,
    *,
    artifact_ref: str,
    signing_private_key: str,
) -> dict[str, str]:
    """Sign a capability submission's canonical signed-core with a developer key.

    The signed core is ``trust_contracts.capability_signed_core(...)`` — the SAME
    cross-repo definition ClawHunt rebuilds and verifies against the registered
    developer public key (a cross-repo golden test pins the bytes identical). We sign
    over the SANITIZED ``artifact_ref`` so the bytes match exactly what
    :func:`build_review_submission_payload` puts on the wire (the signature binds the
    declared storage location).

    ``signing_private_key`` is ``ed25519:<base64 of 32 raw bytes>`` (the escrowed
    developer key cached locally by :mod:`superclaw.developer_identity`). Returns
    ``{"signature": "ed25519:<b64>", "signer_keyid": "sha256:<hex>"}``. Raises
    :class:`CapabilityDevtoolError` on a malformed key (fail-closed — never emit an
    unsigned-but-claimed payload).
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from superclaw.trust_contracts import (
        TrustContractError,
        capability_signed_core,
        sign_envelope,
    )

    material = (signing_private_key or "").strip()
    try:
        raw = base64.b64decode(material.removeprefix("ed25519:"), validate=True)
        if len(raw) != 32:
            raise ValueError("developer private key must be 32 raw bytes")
        private_key = Ed25519PrivateKey.from_private_bytes(raw)
    except (ValueError, TypeError) as exc:
        raise CapabilityDevtoolError(f"invalid developer signing key: {exc}") from exc

    try:
        core = capability_signed_core(
            kind=metadata.kind,
            capability_id=metadata.capability_id,
            version=metadata.version,
            package_digest=metadata.artifact_digest,
            artifact_ref=_sanitize_artifact_ref(artifact_ref),
        )
        envelope = sign_envelope(core, private_key)
    except TrustContractError as exc:
        raise CapabilityDevtoolError(f"failed to sign capability submission: {exc}") from exc
    signature = envelope["signatures"][0]
    return {"signature": signature["sig"], "signer_keyid": signature["keyid"]}


def build_review_submission_payload(
    metadata: CapabilityPackageMetadata,
    *,
    artifact_ref: str,
    developer_ref: str | None = None,
    signature: str | None = None,
    signer_keyid: str | None = None,
) -> dict[str, Any]:
    artifact_ref = _sanitize_artifact_ref(artifact_ref)
    payload: dict[str, Any] = {
        "schema_version": WORKSHOP_SUBMISSION_SCHEMA,
        "kind": metadata.kind,
        "capability_id": metadata.capability_id,
        f"{metadata.kind}_id": metadata.capability_id,
        "version": metadata.version,
        "artifact_digest": metadata.artifact_digest,
        "package_digest": metadata.artifact_digest,
        "artifact_ref": artifact_ref,
        "artifact_filename": metadata.artifact_filename,
        "package_format": metadata.package_format,
        "name": metadata.name,
        "summary": metadata.summary,
        "requested_status": "review_requested",
        "auto_approve": False,
    }
    if developer_ref:
        payload["developer_ref"] = _sanitize_public_ref(developer_ref, field="developer_ref")
    # Developer signature is all-or-nothing: a signature without its keyid (or vice
    # versa) is a malformed claim. FAIL CLOSED — raise rather than silently dropping a
    # half-provided signature into an UNSIGNED submission (a programmatic caller that
    # loses one field must never have its signature quietly downgraded). ClawHunt
    # rejects a partial signature with 422 over the same signed core.
    if bool(signature) != bool(signer_keyid):
        raise CapabilityDevtoolError("signature and signer_keyid must be provided together")
    if signature and signer_keyid:
        payload["signature"] = signature
        payload["signer_keyid"] = signer_keyid
    _assert_public_payload(payload)
    return payload


def submit_capability_for_review(
    kind: str,
    artifact_path: Path,
    *,
    api_url: str,
    artifact_ref: str,
    developer_ref: str | None = None,
    signing_private_key: str | None = None,
    timeout_seconds: float = 10.0,
    client_factory: Any | None = None,
) -> CapabilitySubmissionResponse:
    metadata = validate_capability_artifact(kind, artifact_path)
    signature_fields: dict[str, str] = {}
    if signing_private_key:
        signature_fields = sign_capability_submission(
            metadata, artifact_ref=artifact_ref, signing_private_key=signing_private_key
        )
    request_payload = build_review_submission_payload(
        metadata, artifact_ref=artifact_ref, developer_ref=developer_ref, **signature_fields
    )
    url = _join_url(api_url, DEFAULT_REVIEW_API_PATH)
    factory = client_factory or httpx.Client
    with factory(timeout=timeout_seconds) as client:
        response = client.post(url, json=request_payload)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise CapabilityDevtoolError("review API response must be a JSON object")
    sanitized = _sanitize_review_status_payload(payload)
    return CapabilitySubmissionResponse(
        ok=bool(sanitized.get("ok", True)),
        submission_id=_optional_str(sanitized.get("submission_id") or sanitized.get("id")),
        status=_optional_str(sanitized.get("status") or sanitized.get("review_status")),
        response=sanitized,
        request=request_payload,
    )


def query_capability_review_status(
    submission_id: str,
    *,
    api_url: str,
    timeout_seconds: float = 10.0,
    client_factory: Any | None = None,
) -> dict[str, Any]:
    safe_submission_id = _sanitize_path_segment(submission_id, field="submission_id")
    url = _join_url(api_url, f"{DEFAULT_REVIEW_API_PATH}/{safe_submission_id}")
    factory = client_factory or httpx.Client
    with factory(timeout=timeout_seconds) as client:
        response = client.get(url)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise CapabilityDevtoolError("review API response must be a JSON object")
    status = _sanitize_review_status_payload(payload)
    status.setdefault("schema_version", WORKSHOP_STATUS_SCHEMA)
    return status


def sync_approved_capability_registry(
    source: str | Path,
    *,
    cloud_root: Path,
    include_revoked: bool = False,
) -> dict[str, Any]:
    entries = CapabilityRegistryClient(source).load()
    synced: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for entry in entries:
        if entry.revoked and not include_revoked:
            skipped.append({"kind": entry.kind, "capability_id": entry.capability_id, "version": entry.version, "reason": "revoked"})
            continue
        path = publish_capability_registry_entry(cloud_root, _registry_entry_payload(entry))
        synced.append({**_registry_entry_payload(entry), "registry_file": str(path)})
    return {"ok": True, "synced": synced, "skipped": skipped, "count": len(synced)}


def list_approved_capability_registry(source: str | Path) -> dict[str, Any]:
    entries = CapabilityRegistryClient(source).load()
    payload = [_registry_entry_payload(entry) for entry in entries if not entry.revoked]
    return {"ok": True, "count": len(payload), "items": payload}


def _plugin_metadata(source: Path) -> CapabilityPackageMetadata:
    package = load_plugin_package(source)
    try:
        manifest = package.manifest
        capability_id = str(manifest.get("id") or "").strip()
        version = str(manifest.get("version") or "").strip()
        _require_identity("plugin", capability_id, version)
        digest = compute_package_digest(package)
        return CapabilityPackageMetadata(
            kind="plugin",
            capability_id=capability_id,
            version=version,
            name=_optional_str(manifest.get("name")),
            summary=_optional_str(manifest.get("summary")),
            artifact_digest=digest,
            artifact_path=source,
            artifact_filename=source.name,
            package_format="scplug" if source.suffix == ".scplug" else "directory",
        )
    finally:
        package.cleanup()


def _skill_metadata(source: Path) -> CapabilityPackageMetadata:
    root = _materialize_archive_if_needed(source, ".scskill")
    try:
        if root != source:
            _reject_secret_bearing_artifact(root)
        skill_path = root / "SKILL.md" if root.is_dir() else root
        if skill_path.name != "SKILL.md" or not skill_path.exists():
            raise CapabilityDevtoolError("skill artifact must be SKILL.md, a folder containing SKILL.md, or .scskill")
        frontmatter, body = parse_markdown_with_frontmatter(skill_path.read_text(encoding="utf-8"))
        name = str(frontmatter.get("name") or skill_path.parent.name).strip()
        capability_id = str(frontmatter.get("id") or f"skill.{_slugify(name)}").strip()
        version = str(frontmatter.get("version") or "0.1.0").strip()
        _require_identity("skill", capability_id, version)
        if not str(frontmatter.get("description") or "").strip():
            raise CapabilityDevtoolError("skill frontmatter must declare description")
        if not body.strip():
            raise CapabilityDevtoolError("skill body must not be empty")
        return CapabilityPackageMetadata(
            kind="skill",
            capability_id=capability_id,
            version=version,
            name=name,
            summary=str(frontmatter.get("description") or "").strip(),
            artifact_digest=_artifact_digest(root),
            artifact_path=source,
            artifact_filename=source.name,
            package_format="scskill" if source.suffix == ".scskill" else "directory",
        )
    finally:
        _cleanup_materialized(root, source)


def _company_metadata(source: Path) -> CapabilityPackageMetadata:
    template = load_company_template(source)
    try:
        _reject_secret_bearing_artifact(template.root)
        validate_company_template_contract(template.manifest)
        capability_id = template.artifact_id
        version = template.version
        _require_identity("company", capability_id, version)
        digest = _COMPANY_VERIFIER.compute_digest(template)
        return CapabilityPackageMetadata(
            kind="company",
            capability_id=capability_id,
            version=version,
            name=_optional_str(template.manifest.get("name")),
            summary=_optional_str(template.manifest.get("summary")),
            artifact_digest=digest,
            artifact_path=source,
            artifact_filename=source.name,
            package_format="sccompany" if source.suffix == ".sccompany" else "directory",
        )
    finally:
        template.cleanup()


def _write_deterministic_archive(source: Path, package_path: Path) -> None:
    if package_path.exists():
        package_path.unlink()
    root = _archive_root(source)
    try:
        with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file_path in _iter_files(root):
                relative = file_path.relative_to(root).as_posix()
                info = zipfile.ZipInfo(relative)
                info.date_time = (1980, 1, 1, 0, 0, 0)
                info.external_attr = (file_path.stat().st_mode & 0o777) << 16
                archive.writestr(info, file_path.read_bytes())
    finally:
        if root != source and root.exists():
            shutil.rmtree(root, ignore_errors=True)


def _materialize_archive_if_needed(source: Path, suffix: str) -> Path:
    if source.suffix != suffix:
        return source
    tmp = Path(tempfile.mkdtemp(prefix="superclaw-capability-"))
    try:
        with zipfile.ZipFile(source) as archive:
            _safe_extract(archive, tmp)
        return tmp
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _cleanup_materialized(root: Path, source: Path) -> None:
    if root != source and root.exists():
        shutil.rmtree(root, ignore_errors=True)


def _archive_root(source: Path) -> Path:
    if source.is_dir():
        return source
    if source.is_file() and source.name == "SKILL.md":
        tmp = Path(tempfile.mkdtemp(prefix="superclaw-skill-archive-"))
        shutil.copy2(source, tmp / "SKILL.md")
        return tmp
    raise CapabilityDevtoolError(f"unsupported build source: {source}")


def _safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.infolist():
        target = (destination / member.filename).resolve()
        if target != root and root not in target.parents:
            raise CapabilityDevtoolError(f"archive entry escapes destination: {member.filename}")
        mode = (member.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise CapabilityDevtoolError(f"archive may not contain symlink: {member.filename}")
    archive.extractall(destination)


def _artifact_digest(path: Path) -> str:
    digest = __import__("hashlib").sha256()
    root = path if path.is_dir() else path.parent
    for file_path in _iter_files(path):
        relative = file_path.relative_to(root)
        name = relative.as_posix().encode("utf-8")
        data = file_path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return f"sha256:{digest.hexdigest()}"


def _iter_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise CapabilityDevtoolError(f"artifact may not contain symlink: {path.relative_to(root).as_posix()}")
        if path.is_file() and "__pycache__" not in path.relative_to(root).parts:
            files.append(path)
    return files


def _reject_secret_bearing_artifact(source: Path) -> None:
    for path in _iter_files(source):
        if path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if contains_secret(text):
            raise CapabilityDevtoolError(f"artifact contains secret-like material: {path.name}")
        if path.suffix == ".json":
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            _reject_sensitive_json_keys(payload, path.name)
        elif path.name == "SKILL.md":
            frontmatter, _body = parse_markdown_with_frontmatter(text)
            _reject_sensitive_json_keys(frontmatter, path.name)


def _reject_sensitive_json_keys(value: Any, filename: str, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            dotted = f"{path}.{key_text}" if path else key_text
            if _SENSITIVE_KEY_RE.search(key_text):
                raise CapabilityDevtoolError(f"artifact contains secret-bearing field {dotted} in {filename}")
            _reject_sensitive_json_keys(child, filename, dotted)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive_json_keys(child, filename, f"{path}[{index}]")


def _sanitize_review_status_payload(payload: dict[str, Any]) -> dict[str, Any]:
    _assert_public_payload(payload)
    return {str(key): value for key, value in payload.items() if not _SENSITIVE_KEY_RE.search(str(key)) and not str(key).endswith("_path")}


def _assert_public_payload(payload: Any) -> None:
    rendered = json.dumps(payload, sort_keys=True, default=str)
    if contains_secret(rendered):
        raise CapabilityDevtoolError("payload contains secret-like material")
    lowered = rendered.lower()
    for forbidden in ("private_key", "signing_private_key", "file://", "/users/", "\\users\\"):
        if forbidden in lowered:
            raise CapabilityDevtoolError("payload exposes a forbidden private or local value")


def _registry_entry_payload(entry: CapabilityRegistryEntry) -> dict[str, Any]:
    payload = {
        "kind": entry.kind,
        "capability_id": entry.capability_id,
        f"{entry.kind}_id": entry.capability_id,
        "version": entry.version,
        "package_digest": entry.digest,
        "status": entry.status,
        "name": entry.name,
        "summary": entry.summary,
        "logo_url": entry.logo_url,
        "trust": entry.trust.value,
        "signer_class": entry.signer_class,
        "entitlement_required": entry.entitlement_required,
        "skill_origin": entry.skill_origin,
        "instantiable": entry.instantiable,
        "metadata": dict(entry.metadata) if entry.metadata else {},
    }
    if entry.revocation:
        payload["revocation"] = dict(entry.revocation)
    return {key: value for key, value in payload.items() if value is not None}


def _sanitize_artifact_ref(value: str) -> str:
    ref = str(value).strip()
    if not ref:
        raise CapabilityDevtoolError("artifact_ref is required")
    if ref.startswith(("file://", "/", "~")) or "\\" in ref:
        raise CapabilityDevtoolError("artifact_ref must not expose a local filesystem path")
    _assert_public_payload({"artifact_ref": ref})
    return ref


def _sanitize_public_ref(value: str, *, field: str) -> str:
    text = str(value).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@+-]{1,160}", text):
        raise CapabilityDevtoolError(f"{field} must be an opaque non-secret reference")
    _assert_public_payload({field: text})
    return text


def _sanitize_path_segment(value: str, *, field: str) -> str:
    text = str(value).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}", text):
        raise CapabilityDevtoolError(f"{field} must be a safe identifier")
    return text


def _require_identity(kind: str, capability_id: str, version: str) -> None:
    if not capability_id:
        raise CapabilityDevtoolError(f"{kind} artifact is missing id")
    if not SEMVER_RE.fullmatch(version):
        raise CapabilityDevtoolError(f"{kind} version must be MAJOR.MINOR.PATCH")


def _normalize_kind(kind: str) -> CapabilityKind:
    normalized = str(kind).strip().lower()
    if normalized not in CAPABILITY_KINDS:
        raise CapabilityDevtoolError(f"unsupported capability kind: {kind}")
    return normalized  # type: ignore[return-value]


def _join_url(base_url: str, path: str) -> str:
    base = str(base_url).strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise CapabilityDevtoolError("api_url must start with http:// or https://")
    return f"{base}{path}"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        return "unnamed"
    if not slug[0].isalpha():
        slug = f"s-{slug}"
    return slug


def _safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-") or "capability"


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
