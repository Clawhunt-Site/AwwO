"""Company template domain model for the Capability Workshop (方向一).

A ``CompanyTemplate`` is the third signed asset kind, parallel to ``PluginPackage``
and skills. It shares the trust layer (``SignedArtifactEnvelope`` +
``PackageTrustVerifier`` from :mod:`superclaw.trust`) but is its OWN domain model
with its OWN landing logic — never a plugin ``kind`` (北极星护栏 1).

A company template is a STATIC governance blueprint: roles + charters + per-role
equipment allowlist + policy/budget defaults. Loading/verifying it does NOT
install, run, authorize or instantiate anything — instantiation is a separate,
human-gated proposal→commit flow (roadmap §方向一 / §8.3). This module is P0:
load + trust-verify + contract-validate. It is kind-scoped: its own root-key /
local-dev / revocation env, NEVER reusing the plugin's (护栏 1 / §7.3 Q1.4).
"""

from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError

from superclaw.environment import superclaw_data_path
from superclaw.trust import PackageTrustVerifier, SignedArtifactEnvelope, SignedArtifactError

COMPANY_MANIFEST_NAME = "superclaw-company.json"


def default_company_revocation_file() -> Path:
    return superclaw_data_path("companies", "revocations.json")


class CompanyTemplateError(SignedArtifactError):
    """Raised when a company template fails the local verification/validation contract."""


@dataclass(frozen=True)
class CompanyTemplate(SignedArtifactEnvelope):
    """A signed company blueprint. Inherits id/version/kind/digest/signature
    accessors from the shared envelope; adds company-specific typed accessors.
    Carries NO plugin ``acceptance`` (roadmap §7.3 Q1.6)."""

    @property
    def roles(self) -> list[dict[str, Any]]:
        value = self.manifest.get("roles") or []
        return [r for r in value if isinstance(r, dict)]

    @property
    def role_names(self) -> list[str]:
        return [str(r.get("name", "")) for r in self.roles]

    @property
    def equipment_requirements(self) -> dict[str, Any]:
        value = self.manifest.get("equipment_requirements")
        return value if isinstance(value, dict) else {}

    @property
    def policies(self) -> dict[str, Any]:
        value = self.manifest.get("policies")
        return value if isinstance(value, dict) else {}

    @property
    def budgets(self) -> dict[str, Any]:
        value = self.manifest.get("budgets")
        return value if isinstance(value, dict) else {}


# Kind-scoped verifier — its OWN env vars, never the plugin's (护栏 1 / Q1.4).
_COMPANY_VERIFIER = PackageTrustVerifier(
    manifest_name=COMPANY_MANIFEST_NAME,
    label="company",
    root_key_env="SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY",
    local_dev_env="SUPERCLAW_COMPANY_LOCAL_DEV_TRUST",
    revocation_id_field="id",
    error_cls=CompanyTemplateError,
)


def _company_schema_path() -> Path:
    return Path(__file__).resolve().parents[4] / "schemas" / COMPANY_MANIFEST_NAME.replace(".json", ".schema.json")


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.infolist():
        # zip-slip + symlink defense (mirrors the plugin archive extractor).
        target = (destination / member.filename).resolve()
        if target != root and root not in target.parents:
            raise CompanyTemplateError(f"company archive entry escapes destination: {member.filename}")
        mode = (member.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise CompanyTemplateError(f"company archive may not contain symlink: {member.filename}")
    archive.extractall(destination)


def load_company_template(path: Path) -> CompanyTemplate:
    """Load a company template from a directory or a ``.sccompany`` archive."""
    source = Path(path).resolve()
    if source.is_dir():
        manifest_path = source / COMPANY_MANIFEST_NAME
        if not manifest_path.exists():
            raise CompanyTemplateError(f"missing {COMPANY_MANIFEST_NAME}")
        return CompanyTemplate(source=source, root=source, manifest=_read_json(manifest_path))
    if source.is_file() and source.suffix == ".sccompany":
        temporary_root = Path(tempfile.mkdtemp(prefix="superclaw-company-"))
        try:
            with zipfile.ZipFile(source) as archive:
                _safe_extract(archive, temporary_root)
            manifest_path = temporary_root / COMPANY_MANIFEST_NAME
            if not manifest_path.exists():
                raise CompanyTemplateError(f"missing {COMPANY_MANIFEST_NAME}")
            return CompanyTemplate(
                source=source, root=temporary_root, manifest=_read_json(manifest_path), temporary_root=temporary_root
            )
        except Exception:
            shutil.rmtree(temporary_root)
            raise
    raise CompanyTemplateError(f"unsupported company template path: {path}")


def validate_company_template_contract(manifest: dict[str, Any], *, schema_path: Path | None = None) -> None:
    """Domain validation (lives HERE, not in the trust layer — 护栏 1): JSON Schema
    shape + the relational invariants schema can't express (unique role names,
    equipment keys reference declared roles, ``reports_to`` references declared
    roles and is acyclic). Raises CompanyTemplateError on any violation."""
    schema_path = schema_path or _company_schema_path()
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(manifest)
    except (ValidationError, OSError, json.JSONDecodeError) as exc:
        raise CompanyTemplateError(f"company manifest invalid: {exc}") from exc

    roles = manifest.get("roles") or []
    names = [str(r.get("name", "")) for r in roles]
    if len(names) != len(set(names)):
        raise CompanyTemplateError("company role names must be unique")
    name_set = set(names)

    for role_name in (manifest.get("equipment_requirements") or {}):
        if role_name not in name_set:
            raise CompanyTemplateError(f"equipment_requirements references unknown role: {role_name!r}")

    # reports_to must reference a declared role and the chain must be acyclic.
    reports_to: dict[str, str | None] = {}
    for role in roles:
        target = role.get("reports_to")
        if target is not None:
            if str(target) not in name_set:
                raise CompanyTemplateError(f"role {role.get('name')!r} reports_to unknown role: {target!r}")
            reports_to[str(role.get("name"))] = str(target)
    for start in reports_to:
        seen: set[str] = set()
        cursor: str | None = start
        while cursor is not None:
            if cursor in seen:
                raise CompanyTemplateError(f"reports_to chain has a cycle at role {cursor!r}")
            seen.add(cursor)
            cursor = reports_to.get(cursor)


def verify_company_template(
    path: Path,
    *,
    public_key: str | None = None,
    revocation_file: Path | None = None,
    schema_path: Path | None = None,
    allow_local_dev: bool = False,
) -> tuple[CompanyTemplate, str]:
    """Full local verification: load → contract-validate → integrity (digest) →
    signature trust → revocation. Returns (template, trust_class). fail-closed.

    ``allow_local_dev`` is an explicit per-call opt-in (the ``team bootstrap
    --trust local`` flag) admitting local-dev trust for this call even when
    ``SUPERCLAW_COMPANY_LOCAL_DEV_TRUST`` is unset; it never relaxes integrity,
    contract, revocation, or namespace isolation."""
    template = load_company_template(path)
    try:
        validate_company_template_contract(template.manifest, schema_path=schema_path)
        digest = _COMPANY_VERIFIER.compute_digest(template)
        declared = template.package_digest
        if declared != digest:
            raise CompanyTemplateError(f"company digest mismatch: declared {declared}, computed {digest}")
        trust_class = _COMPANY_VERIFIER.resolve_signature_trust(
            digest, template.signature, public_key, allow_local_dev=allow_local_dev
        )
        _COMPANY_VERIFIER.check_revocation(template, revocation_file or default_company_revocation_file())
    except Exception:
        template.cleanup()
        raise
    return template, trust_class


def company_local_dev_trust_enabled() -> bool:
    return _COMPANY_VERIFIER.local_dev_trust_enabled()
