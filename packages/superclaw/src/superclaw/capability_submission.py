from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from superclaw.company_portability_review import (
    PreviewFn,
    check_bundle_safety_and_limits,
    review_company_portability_bundle,
)
from superclaw.company_template import (
    CompanyTemplateError,
    _COMPANY_VERIFIER,
    load_company_template,
    validate_company_template_contract,
)
from superclaw.capability_registry import publish_capability_registry_entry
from superclaw.harness import parse_markdown_with_frontmatter
from superclaw.models import _id
from superclaw.plugin_submission import (
    DeveloperUploadReviewError,
    DeveloperUploadSubmissionResult,
    REVIEW_RECORD_NAME,
    _gate,
    _static_secret_scan_gate,
    _write_review_record,
    submit_developer_plugin_upload,
)
from superclaw.plugins import compute_package_digest, load_plugin_package

CapabilityKind = Literal["plugin", "skill", "company"]
CapabilityDistributionDecision = Literal["publish", "revoke", "replace", "sign"]

CAPABILITY_KINDS: set[str] = {"plugin", "skill", "company"}
CAPABILITY_SUBMISSION_PREFIXES: dict[str, str] = {
    "plugin": "plugsub",
    "skill": "skillsub",
    "company": "cosub",
}
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
SHA256_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
DISTRIBUTION_INDEX_NAME = "distribution-index.json"
DISTRIBUTION_STATUS_NAME = "distribution-status.json"
DISTRIBUTION_AUDIT_NAME = "distribution-audit.jsonl"
DISTRIBUTION_DECISIONS: set[str] = {"publish", "revoke", "replace", "sign"}
SENSITIVE_STATUS_KEYS = {
    "blob_path",
    "signed_package_path",
    "signing_private_key",
    "private_key",
    "cache_path",
}


class DeveloperCapabilitySubmissionError(ValueError):
    """Raised when a developer capability submission cannot be processed."""


@dataclass(frozen=True)
class DeveloperCapabilitySubmissionResult:
    submission_id: str
    kind: CapabilityKind
    capability_id: str
    version: str
    status: str
    ready_for_review: bool
    review_path: Path
    artifact_blob_digest: str
    record: dict[str, Any]


@dataclass(frozen=True)
class CapabilityDistributionDecisionResult:
    submission_id: str
    kind: CapabilityKind
    capability_id: str
    version: str
    decision: CapabilityDistributionDecision
    artifact_blob_digest: str
    artifact_ref: str
    status_path: Path
    audit_path: Path
    record: dict[str, Any]


@dataclass(frozen=True)
class CapabilityPublicationResult:
    submission_id: str
    kind: CapabilityKind
    capability_id: str
    version: str
    decision: CapabilityDistributionDecision
    artifact_blob_digest: str
    artifact_ref: str
    registry_path: Path
    artifact_storage_path: Path | None
    record: dict[str, Any]


def capability_submission_prefix(kind: str) -> str:
    return CAPABILITY_SUBMISSION_PREFIXES[_normalize_kind(kind)]


def submit_developer_capability_upload(
    kind: str,
    artifact_path: Path,
    *,
    submission_root: Path,
    schema_path: Path | None = None,
    smoke_timeout_seconds: float | None = None,
    submission_id: str | None = None,
) -> DeveloperCapabilitySubmissionResult:
    normalized_kind = _normalize_kind(kind)
    if normalized_kind == "plugin":
        return _submit_plugin_capability(
            artifact_path,
            submission_root=submission_root,
            schema_path=schema_path,
            smoke_timeout_seconds=smoke_timeout_seconds,
            submission_id=submission_id,
        )

    submission_id = submission_id or _id(capability_submission_prefix(normalized_kind))
    submission_dir = submission_root / submission_id
    submission_dir.mkdir(parents=True, exist_ok=False)
    blob_ref, blob_digest = _store_capability_blob(artifact_path, submission_dir / "artifact")
    record = _review_blob(normalized_kind, blob_ref)
    ready = all(bool(gate.get("passed")) for gate in record["gates"])
    status = "ready_for_review" if ready else "rejected"
    record.update(
        {
            "schema_version": "0.1.0",
            "submission_id": submission_id,
            "kind": normalized_kind,
            "status": status,
            "ready_for_review": ready,
            "artifact_uploaded": True,
            "artifact_blob_digest": blob_digest,
            "package_digest": record.get("package_digest") or blob_digest,
            "blob_path": str(submission_dir / "artifact"),
            "signed_package_path": None,
            "signing_public_key": None,
            "signature_issued": False,
            "out_of_scope": _developer_capability_out_of_scope(),
        }
    )
    review_path = _write_review_record(record, submission_dir)
    return DeveloperCapabilitySubmissionResult(
        submission_id=submission_id,
        kind=normalized_kind,
        capability_id=str(record["capability_id"]),
        version=str(record["version"]),
        status=status,
        ready_for_review=ready,
        review_path=review_path,
        artifact_blob_digest=blob_digest,
        record=record,
    )


def submit_company_portability_upload(
    bundle_dir: Path,
    *,
    capability_id: str,
    version: str,
    submission_root: Path,
    preview_fn: PreviewFn | None,
    submission_id: str | None = None,
) -> DeveloperCapabilitySubmissionResult:
    """Run developer submission gates over a Paperclip CompanyPortability bundle (the
    COMPANY.md format the workshop import side consumes).

    This is the portability sibling of the legacy ``company`` branch in
    :func:`submit_developer_capability_upload` (which reviews a ``superclaw-company.json``
    template). The publish identity (``capability_id``/``version``) is explicit, and the
    importability judgement is delegated to Node via ``preview_fn`` — see
    :func:`superclaw.company_portability_review.review_company_portability_bundle`.
    """
    # Bound resources BEFORE the copy: reject a symlink/over-limit bundle so an oversized
    # tree can't fill the submission store on its way to being rejected by review.
    safe, reason = check_bundle_safety_and_limits(Path(bundle_dir))
    if not safe:
        raise DeveloperCapabilitySubmissionError(f"company bundle rejected: {reason}")
    submission_id = submission_id or _id(capability_submission_prefix("company"))
    submission_dir = submission_root / submission_id
    submission_dir.mkdir(parents=True, exist_ok=False)
    blob_ref, blob_digest = _store_capability_blob(bundle_dir, submission_dir / "artifact")
    record = review_company_portability_bundle(
        blob_ref, preview_fn=preview_fn, capability_id=capability_id, version=version
    )
    ready = all(bool(gate.get("passed")) for gate in record["gates"])
    status = "ready_for_review" if ready else "rejected"
    record.update(
        {
            "schema_version": "0.1.0",
            "submission_id": submission_id,
            "kind": "company",
            "status": status,
            "ready_for_review": ready,
            "artifact_uploaded": True,
            "artifact_blob_digest": blob_digest,
            "package_digest": record.get("package_digest") or blob_digest,
            "blob_path": str(submission_dir / "artifact"),
            "signed_package_path": None,
            "signing_public_key": None,
            "signature_issued": False,
            "out_of_scope": _developer_capability_out_of_scope(),
        }
    )
    review_path = _write_review_record(record, submission_dir)
    return DeveloperCapabilitySubmissionResult(
        submission_id=submission_id,
        kind="company",
        capability_id=str(record["capability_id"]),
        version=str(record["version"]),
        status=status,
        ready_for_review=ready,
        review_path=review_path,
        artifact_blob_digest=blob_digest,
        record=record,
    )


def get_developer_capability_submission(submission_id: str, *, submission_root: Path) -> dict[str, Any]:
    path = submission_root / submission_id / REVIEW_RECORD_NAME
    if not path.exists():
        raise DeveloperCapabilitySubmissionError(f"submission not found: {submission_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def record_capability_distribution_decision(
    submission_id: str,
    *,
    submission_root: Path,
    decision: str,
    actor_ref: str,
    artifact_ref: str | None = None,
    signing_authority_ref: str | None = None,
    entitlement_ref: str | None = None,
    replacement_for_digest: str | None = None,
    signing_private_key: str | None = None,
) -> CapabilityDistributionDecisionResult:
    """Record a production-distribution policy decision for a reviewed artifact.

    This is a local, testable policy foundation only: it does not deploy to a
    hosted object store or sign with a real production key. The enforced
    contract is the important part: upload records cannot carry signing key
    material, decisions bind to the stored immutable bytes, object references
    are opaque, and publish/revoke/replace/sign actions leave append-only audit
    evidence.
    """
    normalized_decision = _normalize_distribution_decision(decision)
    if signing_private_key:
        raise DeveloperCapabilitySubmissionError("distribution decisions must not carry production signing private keys")
    if normalized_decision == "sign" and not signing_authority_ref:
        raise DeveloperCapabilitySubmissionError("sign decisions require an isolated signing authority reference")

    submission_dir = submission_root / submission_id
    record = get_developer_capability_submission(submission_id, submission_root=submission_root)
    kind = _normalize_kind(str(record.get("kind") or ""))
    capability_id = str(record.get("capability_id") or record.get(f"{kind}_id") or "").strip()
    version = str(record.get("version") or "").strip()
    if not capability_id or not version:
        raise DeveloperCapabilitySubmissionError("submission record is missing capability identity")
    if record.get("status") not in {"ready_for_review", "ready_for_signing", "verified"} and record.get("capability_status") not in {
        "ready_for_review",
        "verified",
    }:
        raise DeveloperCapabilitySubmissionError(f"submission is not approved for distribution (status={record.get('status')})")

    blob_ref = _require_stored_artifact_ref(record, submission_dir, kind)
    stored_digest = _stored_artifact_distribution_digest(kind, blob_ref)
    _require_recorded_distribution_digest(record, stored_digest)

    artifact_ref = _sanitize_object_store_ref(
        artifact_ref or _default_artifact_ref(kind=kind, capability_id=capability_id, version=version, digest=stored_digest)
    )
    actor_ref = _sanitize_authority_ref(actor_ref, field="actor_ref")
    signing_authority_ref = _sanitize_authority_ref(signing_authority_ref, field="signing_authority_ref") if signing_authority_ref else None
    entitlement_ref = _sanitize_authority_ref(entitlement_ref, field="entitlement_ref") if entitlement_ref else None

    _apply_distribution_index_policy(
        submission_root=submission_root,
        decision=normalized_decision,
        kind=kind,
        capability_id=capability_id,
        version=version,
        digest=stored_digest,
        replacement_for_digest=replacement_for_digest,
    )

    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    status = {
        "schema_version": "superclaw.capability_distribution.v1",
        "submission_id": submission_id,
        "kind": kind,
        "capability_id": capability_id,
        f"{kind}_id": capability_id,
        "version": version,
        "decision": normalized_decision,
        "artifact_blob_digest": stored_digest,
        "artifact_ref": artifact_ref,
        "actor_ref": actor_ref,
        "signing_authority_ref": signing_authority_ref,
        "entitlement_ref": entitlement_ref,
        "replacement_for_digest": replacement_for_digest,
        "decided_at": now,
    }
    status = {key: value for key, value in status.items() if value is not None}
    _assert_distribution_payload_is_public(status)

    status_path = submission_dir / DISTRIBUTION_STATUS_NAME
    audit_path = submission_dir / DISTRIBUTION_AUDIT_NAME
    status_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with audit_path.open("a", encoding="utf-8") as audit_file:
        audit_file.write(json.dumps(status, sort_keys=True) + "\n")

    return CapabilityDistributionDecisionResult(
        submission_id=submission_id,
        kind=kind,
        capability_id=capability_id,
        version=version,
        decision=normalized_decision,
        artifact_blob_digest=stored_digest,
        artifact_ref=artifact_ref,
        status_path=status_path,
        audit_path=audit_path,
        record=status,
    )


def publish_capability_distribution(
    submission_id: str,
    *,
    submission_root: Path,
    cloud_root: Path,
    decision: str,
    actor_ref: str,
    artifact_ref: str | None = None,
    signing_authority_ref: str | None = None,
    entitlement_ref: str | None = None,
    replacement_for_digest: str | None = None,
) -> CapabilityPublicationResult:
    """Record an admin distribution decision and append the public registry event."""
    distribution = record_capability_distribution_decision(
        submission_id,
        submission_root=submission_root,
        decision=decision,
        actor_ref=actor_ref,
        artifact_ref=artifact_ref,
        signing_authority_ref=signing_authority_ref,
        entitlement_ref=entitlement_ref,
        replacement_for_digest=replacement_for_digest,
    )
    submission_dir = submission_root / submission_id
    review_record = get_developer_capability_submission(submission_id, submission_root=submission_root)
    artifact_storage_path: Path | None = None
    if distribution.decision in {"publish", "sign", "replace"}:
        blob_ref = _require_stored_artifact_ref(review_record, submission_dir, distribution.kind)
        artifact_storage_path = _store_published_artifact(
            cloud_root=cloud_root,
            kind=distribution.kind,
            blob_ref=blob_ref,
            digest=distribution.artifact_blob_digest,
        )
    registry_path = publish_capability_registry_entry(
        cloud_root,
        _registry_entry_from_distribution(distribution, review_record),
    )
    return CapabilityPublicationResult(
        submission_id=distribution.submission_id,
        kind=distribution.kind,
        capability_id=distribution.capability_id,
        version=distribution.version,
        decision=distribution.decision,
        artifact_blob_digest=distribution.artifact_blob_digest,
        artifact_ref=distribution.artifact_ref,
        registry_path=registry_path,
        artifact_storage_path=artifact_storage_path,
        record={
            **distribution.record,
            "registry_status": _registry_status_for_decision(distribution.decision),
            "registry_path": str(registry_path),
        },
    )


def sanitize_capability_distribution_payload(record: dict[str, Any]) -> dict[str, Any]:
    """Return the model/API-safe subset of a submission or distribution record."""
    payload: dict[str, Any] = {}
    for key, value in record.items():
        if key in SENSITIVE_STATUS_KEYS:
            continue
        if key.endswith("_path"):
            continue
        payload[key] = value
    if payload.get("artifact_ref"):
        payload["artifact_ref"] = _sanitize_object_store_ref(str(payload["artifact_ref"]))
    _assert_distribution_payload_is_public(payload)
    return payload


def _registry_entry_from_distribution(
    distribution: CapabilityDistributionDecisionResult,
    review_record: dict[str, Any],
) -> dict[str, Any]:
    registry_status = _registry_status_for_decision(distribution.decision)
    listing_name = (
        review_record.get("name")
        or review_record.get("display_name")
        or review_record.get("capability_name")
        or distribution.capability_id
    )
    summary = review_record.get("summary") or review_record.get("description")
    entry = {
        "schema_version": "clawhunt.admin.capability_registry.event.v1",
        "kind": distribution.kind,
        "capability_id": distribution.capability_id,
        f"{distribution.kind}_id": distribution.capability_id,
        "version": distribution.version,
        "name": listing_name,
        "summary": summary,
        "status": registry_status,
        "package_digest": distribution.artifact_blob_digest,
        "artifact": {
            "digest": distribution.artifact_blob_digest,
            "ref": distribution.artifact_ref,
        },
        "metadata": {
            "submission_id": distribution.submission_id,
            "artifact": {
                "digest": distribution.artifact_blob_digest,
                "ref": distribution.artifact_ref,
            },
            "decision": distribution.decision,
            "decided_at": distribution.record.get("decided_at"),
            "replacement_for_digest": distribution.record.get("replacement_for_digest"),
        },
        "trust": "developer",
        "signer_class": distribution.record.get("signing_authority_ref") or "developer:registry",
        "entitlement_required": bool(distribution.record.get("entitlement_ref")),
        "skill_origin": distribution.kind == "skill",
        "instantiable": distribution.kind != "company",
    }
    if distribution.decision in {"revoke", "replace"}:
        entry["revocation"] = {
            "reason": distribution.decision,
            "decided_at": distribution.record.get("decided_at"),
            "actor_ref": distribution.record.get("actor_ref"),
            "replacement_for_digest": distribution.record.get("replacement_for_digest"),
        }
    return {key: value for key, value in entry.items() if value is not None}


def _registry_status_for_decision(decision: CapabilityDistributionDecision) -> str:
    if decision in {"publish", "sign"}:
        return "published"
    if decision == "revoke":
        return "revoked"
    return "replaced"


def _store_published_artifact(
    *,
    cloud_root: Path,
    kind: CapabilityKind,
    blob_ref: Path,
    digest: str,
) -> Path:
    if not _valid_sha256_digest(digest):
        raise DeveloperCapabilitySubmissionError("artifact digest must be sha256:<hex>")
    target = cloud_root / "artifacts" / "capabilities" / digest.removeprefix("sha256:") / "artifact"
    if target.exists():
        existing_digest = _stored_artifact_distribution_digest(kind, target)
        if existing_digest != digest:
            raise DeveloperCapabilitySubmissionError("published artifact store contains different bytes for digest")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    if blob_ref.is_dir():
        shutil.copytree(blob_ref, target, symlinks=False)
    else:
        target.mkdir()
        shutil.copy2(blob_ref, target / blob_ref.name)
    stored_digest = _stored_artifact_distribution_digest(kind, target)
    if stored_digest != digest:
        shutil.rmtree(target)
        raise DeveloperCapabilitySubmissionError("published artifact digest mismatch")
    return target


def _submit_plugin_capability(
    artifact_path: Path,
    *,
    submission_root: Path,
    schema_path: Path | None,
    smoke_timeout_seconds: float | None,
    submission_id: str | None,
) -> DeveloperCapabilitySubmissionResult:
    try:
        result = submit_developer_plugin_upload(
            artifact_path,
            submission_root=submission_root,
            schema_path=schema_path,
            smoke_timeout_seconds=smoke_timeout_seconds,
            submission_id=submission_id,
        )
    except DeveloperUploadReviewError as exc:
        raise DeveloperCapabilitySubmissionError(str(exc)) from exc
    record = _plugin_capability_record(result)
    _write_review_record(record, result.review_path.parent)
    return DeveloperCapabilitySubmissionResult(
        submission_id=result.submission_id,
        kind="plugin",
        capability_id=result.plugin_id,
        version=result.version,
        status=str(record.get("capability_status") or result.status),
        ready_for_review=bool(record.get("ready_for_review")),
        review_path=result.review_path,
        artifact_blob_digest=str(record.get("artifact_blob_digest") or ""),
        record=record,
    )


def _plugin_capability_record(result: DeveloperUploadSubmissionResult) -> dict[str, Any]:
    ready_for_review = result.status == "ready_for_signing"
    record = {
        **result.record,
        "kind": "plugin",
        "capability_id": result.plugin_id,
        "ready_for_review": ready_for_review,
        "capability_status": "ready_for_review" if ready_for_review else "rejected",
        "signature_issued": bool(result.record.get("signed_package_path")),
    }
    return record


def _review_blob(kind: CapabilityKind, blob_ref: Path) -> dict[str, Any]:
    if kind == "skill":
        return _review_skill(blob_ref)
    if kind == "company":
        return _review_company(blob_ref)
    raise DeveloperCapabilitySubmissionError(f"unsupported capability kind: {kind}")


def _review_skill(blob_ref: Path) -> dict[str, Any]:
    skill_file = _resolve_skill_file(blob_ref)
    gates: list[dict[str, Any]] = []
    capability_id = "unknown"
    version = "0.1.0"
    try:
        text = skill_file.read_text(encoding="utf-8")
        frontmatter, body = parse_markdown_with_frontmatter(text)
    except (OSError, UnicodeDecodeError) as exc:
        frontmatter = {}
        body = ""
        gates.append(_gate("skill_markdown_readable", False, str(exc)))
    else:
        gates.append(_gate("skill_markdown_readable", True, "SKILL.md is readable"))

    if skill_file.name != "SKILL.md":
        gates.append(_gate("skill_file_name", False, "skill artifact must be named SKILL.md or contain SKILL.md"))
    else:
        gates.append(_gate("skill_file_name", True, "SKILL.md present"))

    name = str(frontmatter.get("name") or skill_file.parent.name).strip()
    description = str(frontmatter.get("description") or "").strip()
    raw_version = str(frontmatter.get("version") or "0.1.0").strip()
    raw_id = str(frontmatter.get("id") or "").strip()
    if name:
        capability_id = raw_id or f"skill.{_slugify(name)}"
        gates.append(_gate("skill_name_present", True, f"name={name}"))
    else:
        gates.append(_gate("skill_name_present", False, "skill frontmatter must declare name or use a named folder"))
    if description:
        gates.append(_gate("skill_description_present", True, "description present"))
    else:
        gates.append(_gate("skill_description_present", False, "skill frontmatter must declare description"))
    if SEMVER_RE.fullmatch(raw_version):
        version = raw_version
        gates.append(_gate("skill_version_semver", True, f"version={version}"))
    else:
        gates.append(_gate("skill_version_semver", False, "skill version must be MAJOR.MINOR.PATCH"))
    if body.strip():
        gates.append(_gate("skill_body_present", True, "skill body present"))
    else:
        gates.append(_gate("skill_body_present", False, "skill body must not be empty"))
    gates.append(_static_secret_scan_gate(blob_ref if blob_ref.is_dir() else blob_ref.parent))
    return {
        "review_type": "developer_skill_local_preflight",
        "capability_id": capability_id,
        "skill_id": capability_id,
        "version": version,
        "listing_review_level": "Unlisted",
        "acceptance_recommendation": "none",
        "certified_allowed": False,
        "l3_allowed": False,
        "manual_requirements": [],
        "gates": gates,
    }


def _review_company(blob_ref: Path) -> dict[str, Any]:
    gates: list[dict[str, Any]] = []
    capability_id = "unknown"
    version = "unknown"
    package_digest: str | None = None
    try:
        template = load_company_template(blob_ref)
    except CompanyTemplateError as exc:
        gates.append(_gate("company_template_loadable", False, str(exc)))
    else:
        try:
            capability_id = template.artifact_id
            version = template.version
            gates.append(_gate("company_template_loadable", True, "company template manifest loaded"))
            validate_company_template_contract(template.manifest)
            gates.append(_gate("company_contract_valid", True, "company template contract is valid"))
            package_digest = _COMPANY_VERIFIER.compute_digest(template)
            gates.append(_gate("company_digest_stable", True, f"computed_digest={package_digest}"))
        except (CompanyTemplateError, KeyError, TypeError, ValueError) as exc:
            gates.append(_gate("company_contract_valid", False, str(exc)))
        finally:
            template.cleanup()
    if version != "unknown" and SEMVER_RE.fullmatch(version):
        gates.append(_gate("company_version_semver", True, f"version={version}"))
    elif version != "unknown":
        gates.append(_gate("company_version_semver", False, "company version must be MAJOR.MINOR.PATCH"))
    gates.append(_static_secret_scan_gate(blob_ref if blob_ref.is_dir() else blob_ref.parent))
    return {
        "review_type": "developer_company_local_preflight",
        "capability_id": capability_id,
        "company_id": capability_id,
        "version": version,
        "package_digest": package_digest,
        "listing_review_level": "Unlisted",
        "acceptance_recommendation": "none",
        "certified_allowed": False,
        "l3_allowed": False,
        "manual_requirements": ["manual_security_review", "marketplace_listing_review"],
        "gates": gates,
    }


def _store_capability_blob(artifact_path: Path, blob_dir: Path) -> tuple[Path, str]:
    # Check the RAW path for a symlink BEFORE resolving — `Path.resolve()` dereferences a
    # symlinked root, which would make the symlink check below dead (it always saw the
    # resolved target). This fail-closes a root-symlink artifact for every capability kind.
    raw = Path(artifact_path)
    if raw.is_symlink():
        raise DeveloperCapabilitySubmissionError("artifact path must not be a symlink")
    source = raw.resolve()
    if not source.exists():
        raise DeveloperCapabilitySubmissionError(f"artifact path not found: {artifact_path}")
    if source.is_symlink():
        raise DeveloperCapabilitySubmissionError("artifact path must not be a symlink")
    if blob_dir.exists():
        shutil.rmtree(blob_dir)
    blob_dir.mkdir(parents=True)
    if source.is_dir():
        for path in source.rglob("*"):
            if path.is_symlink():
                raise DeveloperCapabilitySubmissionError(
                    f"artifact may not contain symlink: {path.relative_to(source).as_posix()}"
                )
        shutil.rmtree(blob_dir)
        shutil.copytree(source, blob_dir, symlinks=False)
        blob_ref = blob_dir
    elif source.is_file():
        blob_ref = blob_dir / source.name
        shutil.copy2(source, blob_ref)
    else:
        raise DeveloperCapabilitySubmissionError(f"unsupported artifact path: {artifact_path}")
    return blob_ref, _artifact_digest(blob_ref)


def _artifact_digest(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        _hash_file(digest, path, Path(path.name))
    else:
        for file_path in sorted(item for item in path.rglob("*") if item.is_file() or item.is_symlink()):
            if file_path.is_symlink():
                raise DeveloperCapabilitySubmissionError(
                    f"artifact may not contain symlink: {file_path.relative_to(path).as_posix()}"
                )
            _hash_file(digest, file_path, file_path.relative_to(path))
    return f"sha256:{digest.hexdigest()}"


def _hash_file(digest: Any, file_path: Path, relative: Path) -> None:
    relative_name = relative.as_posix().encode("utf-8")
    data = file_path.read_bytes()
    digest.update(len(relative_name).to_bytes(8, "big"))
    digest.update(relative_name)
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)


def _resolve_skill_file(path: Path) -> Path:
    if path.is_dir():
        return path / "SKILL.md"
    return path


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        return "unnamed"
    if not slug[0].isalpha():
        slug = f"s-{slug}"
    return slug


def _normalize_kind(kind: str) -> CapabilityKind:
    normalized = str(kind).strip().lower()
    if normalized not in CAPABILITY_KINDS:
        raise DeveloperCapabilitySubmissionError(f"unsupported capability kind: {kind}")
    return normalized  # type: ignore[return-value]


def _normalize_distribution_decision(decision: str) -> CapabilityDistributionDecision:
    normalized = str(decision).strip().lower()
    if normalized not in DISTRIBUTION_DECISIONS:
        raise DeveloperCapabilitySubmissionError(f"unsupported distribution decision: {decision}")
    return normalized  # type: ignore[return-value]


def _require_stored_artifact_ref(record: dict[str, Any], submission_dir: Path, kind: CapabilityKind) -> Path:
    default_name = "package" if kind == "plugin" else "artifact"
    recorded = record.get("blob_path")
    blob_ref = Path(str(recorded)) if recorded else submission_dir / default_name
    if not blob_ref.is_absolute():
        blob_ref = submission_dir / blob_ref
    if blob_ref.is_symlink():
        raise DeveloperCapabilitySubmissionError("stored artifact must not be a symlink")
    resolved_submission = submission_dir.resolve()
    resolved_blob = blob_ref.resolve()
    if resolved_blob != resolved_submission and resolved_submission not in resolved_blob.parents:
        raise DeveloperCapabilitySubmissionError("stored artifact reference escapes the submission directory")
    if not resolved_blob.exists():
        raise DeveloperCapabilitySubmissionError("stored artifact reference is missing")
    return resolved_blob


def _stored_artifact_distribution_digest(kind: CapabilityKind, blob_ref: Path) -> str:
    if kind == "plugin":
        package = load_plugin_package(blob_ref)
        try:
            return compute_package_digest(package)
        finally:
            package.cleanup()
    return _artifact_digest(blob_ref)


def _require_recorded_distribution_digest(record: dict[str, Any], stored_digest: str) -> None:
    expected = str(record.get("artifact_blob_digest") or "")
    if not _valid_sha256_digest(expected):
        raise DeveloperCapabilitySubmissionError("submission record is missing artifact_blob_digest")
    if expected != stored_digest:
        raise DeveloperCapabilitySubmissionError("stored artifact digest does not match reviewed artifact_blob_digest")


def _apply_distribution_index_policy(
    *,
    submission_root: Path,
    decision: CapabilityDistributionDecision,
    kind: CapabilityKind,
    capability_id: str,
    version: str,
    digest: str,
    replacement_for_digest: str | None,
) -> None:
    index_path = submission_root / DISTRIBUTION_INDEX_NAME
    index = _read_distribution_index(index_path)
    key = f"{kind}:{capability_id}@{version}"
    existing = index.get(key)
    if decision in {"publish", "sign"}:
        if existing and existing.get("artifact_blob_digest") != digest:
            raise DeveloperCapabilitySubmissionError(f"distribution entry already exists with different digest: {key}")
    elif decision == "replace":
        if not _valid_sha256_digest(str(replacement_for_digest or "")):
            raise DeveloperCapabilitySubmissionError("replace decisions require replacement_for_digest")
        if existing and existing.get("artifact_blob_digest") != replacement_for_digest:
            raise DeveloperCapabilitySubmissionError(f"replace decision does not match current digest for {key}")
    elif decision == "revoke":
        if existing and existing.get("artifact_blob_digest") != digest:
            raise DeveloperCapabilitySubmissionError(f"revoke decision digest does not match current digest for {key}")

    index[key] = {
        "kind": kind,
        "capability_id": capability_id,
        "version": version,
        "artifact_blob_digest": digest,
        "status": decision,
    }
    _write_distribution_index(index_path, index)


def _read_distribution_index(index_path: Path) -> dict[str, dict[str, str]]:
    if not index_path.exists():
        return {}
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("entries"), dict):
        return {str(key): dict(value) for key, value in payload["entries"].items() if isinstance(value, dict)}
    raise DeveloperCapabilitySubmissionError("distribution index is malformed")


def _write_distribution_index(index_path: Path, index: dict[str, dict[str, str]]) -> None:
    payload = {
        "schema_version": "superclaw.capability_distribution_index.v1",
        "entries": index,
    }
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _default_artifact_ref(*, kind: CapabilityKind, capability_id: str, version: str, digest: str) -> str:
    digest_hex = digest.removeprefix("sha256:")
    opaque_id = hashlib.sha256(f"{kind}:{capability_id}:{version}".encode("utf-8")).hexdigest()[:16]
    return f"superclaw-object://capabilities/{kind}/{opaque_id}/versions/{version}/artifacts/{digest_hex}"


def _sanitize_object_store_ref(ref: str) -> str:
    value = str(ref).strip()
    if not value.startswith("superclaw-object://capabilities/"):
        raise DeveloperCapabilitySubmissionError("artifact_ref must be an opaque superclaw object-store reference")
    if "\\" in value or "://" not in value or "file://" in value:
        raise DeveloperCapabilitySubmissionError("artifact_ref must not expose local filesystem paths")
    _reject_secretish_public_value(value, field="artifact_ref")
    return value


def _sanitize_authority_ref(value: str | None, *, field: str) -> str:
    if not value:
        raise DeveloperCapabilitySubmissionError(f"{field} is required")
    normalized = str(value).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@+-]{1,160}", normalized):
        raise DeveloperCapabilitySubmissionError(f"{field} must be an opaque non-secret reference")
    _reject_secretish_public_value(normalized, field=field)
    return normalized


def _assert_distribution_payload_is_public(payload: Any) -> None:
    rendered = json.dumps(payload, sort_keys=True, default=str)
    lowered = rendered.lower()
    forbidden = (
        "signing_private_key",
        "private_key",
        "superclaw_plugin_signing_private_key",
        "cache_path",
        "file://",
        "/users/",
        "/tmp/",
        "\\",
    )
    if any(marker in lowered for marker in forbidden):
        raise DeveloperCapabilitySubmissionError("distribution payload contains internal paths or signing material")
    _reject_secretish_public_value(rendered, field="distribution payload")


def _reject_secretish_public_value(value: str, *, field: str) -> None:
    lowered = value.lower()
    secret_markers = ("secret=", "token=", "private_key", "password=", "bearer ", "sk-", "ghp_")
    if any(marker in lowered for marker in secret_markers):
        raise DeveloperCapabilitySubmissionError(f"{field} must not contain secrets or tokens")


def _valid_sha256_digest(value: str) -> bool:
    return bool(SHA256_RE.fullmatch(value))


def _developer_capability_out_of_scope() -> list[str]:
    return [
        "production_developer_upload_api",
        "production_cloud_upload",
        "production_signing",
        "marketplace_listing",
        "payment",
        "payout",
        "settlement",
        "entitlement_sync",
        "runtime_proxy_changes",
    ]
