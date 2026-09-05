"""CLI-backed Capability Workshop catalog resolver.

This is the single core discovery layer for Capability Workshop B5. It is
read-only: it projects registry, local-cache, company-template, and skill-origin
assets into a common catalog shape, but it does not install, authorize, run, or
instantiate anything.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from superclaw.capability_registry import load_capability_registry_entries
from superclaw.company_template import (
    _COMPANY_VERIFIER,
    CompanyTemplateError,
    default_company_revocation_file,
    load_company_template,
    validate_company_template_contract,
)
from superclaw.environment import superclaw_data_path
from superclaw.plugin_cloud import DEFAULT_CLOUD_ROOT, list_registry_plugins
from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION, default_entitlement_file, default_policy_file, load_cached_package
from superclaw.plugin_runtime_projection import gate_passing_plugins
from superclaw.plugin_versions import version_tuple
from superclaw.plugins import (
    PluginPackage,
    check_plugin_revocation,
    compute_package_digest,
    default_revocation_file,
    is_skill_origin_plugin,
    list_cached_plugins,
    load_plugin_package,
    plugin_cache_root,
    plugin_signer_identity,
)
from superclaw.registry_metadata import (
    RegistryMetadataError,
    RegistryMetadataState,
    RegistryRefreshResult,
    classify_developer_signer,
    load_registry_metadata,
    refresh_trust_registry,
    registry_freshness_from_state_file,
)
from superclaw.trust import PackageTrustVerdict, SignedArtifactEnvelope
from superclaw.trust_state import FIRST_PARTY_NAMESPACES, TrustDerivation, TrustState, derive_trust_state

_logger = logging.getLogger(__name__)

CATALOG_KINDS = {"plugin", "skill", "company"}

# Company TrustStates that may be OFFERED to proposal-mode bootstrap (the catalog
# `instantiable` flag is advisory: "may be offered to the verify-before-instantiate
# gate", NOT "writes state"). Mirrors the bootstrap gate's admission set (design
# §1.2): official (root) and local (explicit local-dev trust) are offerable;
# `developer` is excluded until the company verify primitive can validate registered
# developer keys on the raising path (fail-closed, badge↔gate parity); `untrusted`
# and revoked are never offerable. The gate (resolve_company_template_for_bootstrap)
# remains the fail-closed authority that re-verifies at instantiation time.
_COMPANY_INSTANTIABLE_TRUST = frozenset({TrustState.OFFICIAL, TrustState.LOCAL})


def _company_instantiable_from_trust(
    trust: TrustState, *, revoked: bool, manifest: dict[str, Any] | None = None
) -> bool:
    """THE single derivation of company `instantiable` from TrustState (design G1).

    instantiable iff trust ∈ {official, local} and not revoked (developer/untrusted/
    revoked ⇒ False, fail-closed). When a manifest is available AND trust is `local`,
    a template that SELF-CLAIMS a remote/higher-tier provenance is additionally NOT
    offerable — the local lane is for genuinely local/self templates only, so the
    advisory badge never over-promises against the gate's provenance-honesty RED LINE.
    Applied at EVERY company `instantiable` site (local-dir discovery, capability
    registry projection, and source merge) so there is no second, divergent source.
    The gate (resolve_company_template_for_bootstrap) remains the fail-closed
    authority that re-verifies at instantiation time; this flag is advisory.
    """
    if revoked or trust not in _COMPANY_INSTANTIABLE_TRUST:
        return False
    if trust is TrustState.LOCAL and manifest is not None:
        # Reuse the gate's provenance-honesty predicate. Lazy import keeps the catalog
        # layer decoupled and avoids any import cycle at module load.
        from superclaw.team_templates import _claims_remote_provenance

        if _claims_remote_provenance(manifest):
            return False
    return True


def _company_instantiable(derivation: TrustDerivation, *, revoked: bool, manifest: dict[str, Any]) -> bool:
    """Local-dir discovery wrapper over :func:`_company_instantiable_from_trust`."""
    return _company_instantiable_from_trust(derivation.state, revoked=revoked, manifest=manifest)


def default_companies_root() -> Path:
    return superclaw_data_path("companies")


def default_registry_root() -> Path:
    return superclaw_data_path("registry")


@dataclass(frozen=True)
class CatalogItem:
    kind: str
    plugin_id: str
    version: str
    name: str
    summary: str | None
    digest: str | None
    trust: TrustState
    trust_reasons: tuple[str, ...]
    signer_class: str
    namespace_reserved: bool
    install_state: dict[str, Any]
    entitlement_state: str
    revoked: bool
    skill_origin: bool
    sources: tuple[str, ...]
    logo_url: str | None = None
    instantiable: bool = True
    registry_status: str | None = None
    revocation: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "kind": self.kind,
            "plugin_id": self.plugin_id,
            "id": self.plugin_id,
            "version": self.version,
            "name": self.name,
            "summary": self.summary,
            "digest": self.digest,
            "package_digest": self.digest,
            "pinned_digest": self.digest,
            "digest_pinned": self.digest is not None,
            "trust": self.trust.value,
            "trust_reasons": list(self.trust_reasons),
            "signer_class": self.signer_class,
            "namespace_reserved": self.namespace_reserved,
            "install_state": self.install_state,
            "entitlement_state": self.entitlement_state,
            "revoked": self.revoked,
            "skill_origin": self.skill_origin,
            "logo_url": self.logo_url,
            "sources": list(self.sources),
            "instantiable": self.instantiable,
            "registry_status": self.registry_status,
            "revocation": dict(self.revocation) if self.revocation else None,
        }
        return payload


@dataclass(frozen=True)
class CatalogResolution:
    resolved_at: str
    items: tuple[CatalogItem, ...]
    conflicts: tuple[dict[str, Any], ...] = ()
    watermark_sequence: int | None = None
    registry_freshness: dict[str, Any] = field(
        default_factory=lambda: {"fresh": None, "expires_at": None, "stale_reason": "registry_metadata_not_configured"}
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": True,
            "resolved_at": self.resolved_at,
            "watermark_sequence": self.watermark_sequence,
            "registry_freshness": self.registry_freshness,
            "conflicts": [dict(item) for item in self.conflicts],
            "items": [item.to_dict() for item in self.items],
        }


def resolve_catalog(
    *,
    kind: str | None = None,
    cache_root: Path | None = None,
    cloud_root: Path | None = None,
    registry_root: Path | None = None,
    companies_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    company_revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    runtime_version: str = DEFAULT_RUNTIME_VERSION,
    now: float | None = None,
    include_revoked: bool = False,
) -> CatalogResolution:
    """Resolve the read-only catalog union.

    Local plugin/skill discovery deliberately starts from
    :func:`gate_passing_plugins`; a cached package that the runtime would not
    offer is not made discoverable by this resolver.

    ``company_revocation_file`` is the SINGLE company revocation source threaded
    into the company branch here, the ``/v1/catalog/trust`` endpoint, AND the
    bootstrap verify-before-instantiate gate (design G6) — so the company badge,
    the trust endpoint and instantiation can never read divergent revocation
    lists. It defaults to ``default_company_revocation_file()`` only when unset.
    """
    _validate_kind(kind)
    cache_root = plugin_cache_root(cache_root)
    cloud_root = cloud_root or DEFAULT_CLOUD_ROOT
    registry_root = registry_root or default_registry_root()
    companies_root = companies_root or default_companies_root()
    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    company_revocation_file = company_revocation_file or default_company_revocation_file()
    policy_file = policy_file or default_policy_file()
    resolved_at = _utc_now(now)

    installed_versions = _installed_versions(cache_root=cache_root)
    registry_state, registry_freshness, registry_rollback_ok = _load_registry_state(registry_root, public_key=public_key)
    conflicts = _detect_plugin_signer_conflicts(cache_root=cache_root, cloud_root=cloud_root, public_key=public_key)
    items: dict[tuple[str, str, str], CatalogItem] = {}

    if kind in {None, "plugin", "skill"}:
        for item in _capability_registry_items(
            cloud_root=cloud_root,
            installed_versions=installed_versions,
            kind=kind,
            include_revoked=include_revoked,
        ):
            items[(item.kind, item.plugin_id, item.version)] = item
        for item in _registry_items(
            cloud_root=cloud_root,
            cache_root=cache_root,
            installed_versions=installed_versions,
            revocation_file=revocation_file,
            kind=kind,
            registry_state=registry_state,
            registry_rollback_ok=registry_rollback_ok,
            include_revoked=include_revoked,
        ):
            key = (item.kind, item.plugin_id, item.version)
            existing = items.get(key)
            items[key] = _merge_sources(existing, item) if existing else item
        for item in _local_plugin_items(
            cache_root=cache_root,
            entitlement_file=entitlement_file,
            revocation_file=revocation_file,
            policy_file=policy_file,
            public_key=public_key,
            runtime_version=runtime_version,
            installed_versions=installed_versions,
            kind=kind,
            registry_state=registry_state,
            registry_rollback_ok=registry_rollback_ok,
        ):
            key = (item.kind, item.plugin_id, item.version)
            existing = items.get(key)
            items[key] = _merge_sources(existing, item) if existing else item

    if kind in {None, "company"}:
        for item in _capability_registry_items(
            cloud_root=cloud_root,
            installed_versions=installed_versions,
            kind="company",
            include_revoked=include_revoked,
        ):
            items[(item.kind, item.plugin_id, item.version)] = item
        for item in _company_items(
            companies_root=companies_root,
            revocation_file=company_revocation_file,
            registry_state=registry_state,
            registry_rollback_ok=registry_rollback_ok,
            include_revoked=include_revoked,
        ):
            key = (item.kind, item.plugin_id, item.version)
            existing = items.get(key)
            items[key] = _merge_sources(existing, item) if existing else item

    ordered = tuple(sorted(items.values(), key=_catalog_sort_key))
    return CatalogResolution(
        resolved_at=resolved_at,
        items=ordered,
        conflicts=tuple(conflicts),
        watermark_sequence=(
            registry_state.watermark_sequence
            if registry_state is not None
            else _optional_int(registry_freshness.get("watermark_sequence"))
        ),
        registry_freshness=registry_freshness,
    )


def resolve_trust_state(
    plugin_id: str,
    version: str,
    **roots: Any,
) -> TrustDerivation:
    """Resolve a single plugin/skill/company id+version to its TrustState."""
    resolution = resolve_catalog(kind=roots.pop("kind", None), **roots)
    for item in resolution.items:
        if item.plugin_id == plugin_id and item.version == version:
            return TrustDerivation(
                state=item.trust,
                signer_class=item.signer_class,
                namespace_reserved=item.namespace_reserved,
                revoked=item.revoked,
                freshness_ok=bool(resolution.registry_freshness.get("fresh") is not False),
                rollback_ok=True,
                reasons=tuple(item.trust_reasons),
            )
    return derive_trust_state(
        plugin_id=plugin_id,
        verdict=PackageTrustVerdict(signer_class="none", integrity_ok=False),
        revoked=False,
        source_is_local=False,
        rollback_ok=True,
        freshness_ok=True,
        high_risk=False,
        developer_keyids=None,
    )


def refresh_catalog(
    *,
    registry_root: Path | None = None,
    source_url: str | None = None,
    public_key: str | None = None,
) -> RegistryRefreshResult:
    """Refresh TUF-style catalog metadata without clearing cached state."""
    return refresh_trust_registry(
        registry_root=registry_root or default_registry_root(),
        source_url=source_url,
        public_key=public_key,
    )


def trust_derivation_to_dict(plugin_id: str, version: str, derivation: TrustDerivation) -> dict[str, Any]:
    return {
        "ok": True,
        "plugin_id": plugin_id,
        "version": version,
        "trust": derivation.state.value,
        "signer_class": derivation.signer_class,
        "namespace_reserved": derivation.namespace_reserved,
        "revoked": derivation.revoked,
        "freshness_ok": derivation.freshness_ok,
        "rollback_ok": derivation.rollback_ok,
        "reasons": list(derivation.reasons),
    }


def _registry_items(
    *,
    cloud_root: Path,
    cache_root: Path,
    installed_versions: dict[str, list[str]],
    revocation_file: Path,
    kind: str | None,
    registry_state: RegistryMetadataState | None,
    registry_rollback_ok: bool,
    include_revoked: bool,
) -> list[CatalogItem]:
    items: list[CatalogItem] = []
    for row in list_registry_plugins(cloud_root):
        plugin_id = str(row.get("plugin_id") or "")
        version = str(row.get("version") or "")
        if not plugin_id or not version:
            continue
        item_kind = "skill" if is_skill_origin_plugin(plugin_id, row.get("skill_origin")) else "plugin"
        if kind is not None and item_kind != kind:
            continue
        package = _load_registry_package(cloud_root, plugin_id, version)
        derivation = _untrusted(plugin_id, "registry_package_unavailable")
        revoked = False
        if package is not None:
            try:
                derivation, revoked = _derive_plugin_trust(
                    package,
                    source_is_local=False,
                    revocation_file=revocation_file,
                    registry_state=registry_state,
                    registry_rollback_ok=registry_rollback_ok,
                )
                if revoked and not include_revoked:
                    continue
            finally:
                package.cleanup()
        sources = ("registry",)
        if version in installed_versions.get(plugin_id, []):
            sources = ("registry", "local_cache")
        items.append(
            CatalogItem(
                kind=item_kind,
                plugin_id=plugin_id,
                version=version,
                name=str(row.get("name") or plugin_id),
                summary=str(row.get("summary")) if row.get("summary") is not None else None,
                digest=str(row.get("package_digest")) if row.get("package_digest") is not None else None,
                trust=derivation.state,
                trust_reasons=tuple(derivation.reasons),
                signer_class=derivation.signer_class,
                namespace_reserved=derivation.namespace_reserved,
                install_state=_install_state(plugin_id, version, installed_versions),
                entitlement_state="required" if row.get("entitlement_required") else "not_required",
                revoked=revoked,
                skill_origin=item_kind == "skill",
                logo_url=str(row.get("logo_url")) if row.get("logo_url") is not None else None,
                sources=sources,
                registry_status="revoked" if revoked else "approved",
            )
        )
    return items


def _capability_registry_items(
    *,
    cloud_root: Path,
    installed_versions: dict[str, list[str]],
    kind: str | None,
    include_revoked: bool,
) -> list[CatalogItem]:
    items: list[CatalogItem] = []
    for entry in load_capability_registry_entries(cloud_root, include_revoked=include_revoked):
        if kind is not None and entry.kind != kind:
            continue
        if entry.revoked and not include_revoked:
            continue
        install_state = (
            {"installed": False, "installed_versions": [], "update_available": False}
            if entry.kind == "company"
            else _install_state(entry.capability_id, entry.version, installed_versions)
        )
        items.append(
            CatalogItem(
                kind=entry.kind,
                plugin_id=entry.capability_id,
                version=entry.version,
                name=entry.name or entry.capability_id,
                summary=entry.summary,
                digest=entry.digest,
                trust=entry.trust,
                trust_reasons=entry.trust_reasons,
                signer_class=entry.signer_class,
                namespace_reserved=entry.namespace_reserved,
                install_state=install_state,
                entitlement_state="required" if entry.entitlement_required else "not_required",
                revoked=entry.revoked,
                skill_origin=entry.skill_origin,
                logo_url=entry.logo_url,
                sources=("registry", "capability_registry"),
                # A capability-registry company is a published/REMOTE row with NO local
                # source directory; the verify-before-instantiate gate needs a verifiable
                # on-disk source path (resolve_company_source_path), which a registry-only
                # row can never provide — so it is NOT instantiable on its own (offering it
                # would badge an action that always 404s; remote-source instantiation is
                # deferred per design §3.4). instantiable for company therefore comes ONLY
                # from a LOCAL-DIR source (which has a path); when a company appears in BOTH
                # the registry and a local dir, _merge_sources preserves the local source's
                # offerability. Non-company kinds keep the registry's own flag.
                instantiable=(False if entry.kind == "company" else entry.instantiable),
                registry_status=entry.status,
                revocation=dict(entry.revocation) if entry.revocation else None,
            )
        )
    return items


def _local_plugin_items(
    *,
    cache_root: Path,
    entitlement_file: Path,
    revocation_file: Path,
    policy_file: Path,
    public_key: str | None,
    runtime_version: str,
    installed_versions: dict[str, list[str]],
    kind: str | None,
    registry_state: RegistryMetadataState | None,
    registry_rollback_ok: bool,
) -> list[CatalogItem]:
    allowed = gate_passing_plugins(
        cache_root=cache_root,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
        runtime_version=runtime_version,
    )
    items: list[CatalogItem] = []
    for plugin_id, version in allowed:
        package = load_cached_package(plugin_id, version=version, cache_root=cache_root)
        if package is None:
            continue
        try:
            item_kind = "skill" if is_skill_origin_plugin(plugin_id, package.manifest.get("skill_origin")) else "plugin"
            if kind is not None and item_kind != kind:
                continue
            derivation, revoked = _derive_plugin_trust(
                package,
                source_is_local=True,
                revocation_file=revocation_file,
                registry_state=registry_state,
                registry_rollback_ok=registry_rollback_ok,
            )
            items.append(
                CatalogItem(
                    kind=item_kind,
                    plugin_id=plugin_id,
                    version=version,
                    name=str(package.manifest.get("name") or plugin_id),
                    summary=str(package.manifest.get("summary")) if package.manifest.get("summary") is not None else None,
                    digest=package.package_digest,
                    trust=derivation.state,
                    trust_reasons=tuple(derivation.reasons),
                    signer_class=derivation.signer_class,
                    namespace_reserved=derivation.namespace_reserved,
                    install_state=_install_state(plugin_id, version, installed_versions),
                    entitlement_state="not_required",
                    revoked=revoked,
                    skill_origin=item_kind == "skill",
                    logo_url=_logo_url(plugin_id, version, package.manifest),
                    sources=("local_cache",) if item_kind == "plugin" else ("local_cache", "skill_projection"),
                )
            )
        finally:
            package.cleanup()
    return items


def resolve_company_source_path(
    plugin_id: str,
    version: str,
    *,
    companies_root: Path | None = None,
) -> Path:
    """Resolve a CATALOGED company's (id, version) to its on-disk source DIRECTORY.

    The catalog surfaces a company by its derived id; the bootstrap verify gate needs a
    verifiable on-disk source path. This is the SINGLE place that maps a discovered
    company id+version back to its ``companies_root/<dir>`` so a surface (CLI/API/Web)
    can ask to instantiate "the company I'm looking at in the catalog" WITHOUT inventing
    a path. It re-scans the local company root and matches by the loaded template's
    ``artifact_id`` + ``version`` (NOT the directory name, which need not equal the id).

    It does NOT verify trust — it only resolves the path; the caller MUST still run the
    verify-before-instantiate gate (resolve_company_template_for_bootstrap) on the
    returned path, which fail-closes on untrusted/unsigned/revoked/namespace. Raises
    ``FileNotFoundError`` if no local company matches (fail-closed: a remote/registry-only
    company has no local source to instantiate and is rejected here). Raises
    ``CompanyTemplateError`` if MORE THAN ONE local directory matches the same id+version
    (ambiguous: there is no single "the company I see in the catalog" to instantiate, and
    silently picking the first could instantiate different bytes than the catalog winner —
    fail-closed)."""
    root = companies_root or default_companies_root()
    if not root.exists():
        raise FileNotFoundError(f"no local company source for {plugin_id}@{version}: companies root {root} not found")
    matches: list[Path] = []
    for manifest_path in sorted(root.glob("*/superclaw-company.json")):
        template = None
        try:
            template = load_company_template(manifest_path.parent)
            if template.artifact_id == plugin_id and template.version == version:
                matches.append(manifest_path.parent)
        except (CompanyTemplateError, json.JSONDecodeError, OSError, ValueError):
            # An unreadable/invalid candidate can't be the resolved source; skip it.
            continue
        finally:
            if template is not None:
                template.cleanup()
    if not matches:
        raise FileNotFoundError(f"no local company source matches {plugin_id}@{version} under {root}")
    if len(matches) > 1:
        raise CompanyTemplateError(
            f"ambiguous company source: {len(matches)} local directories declare {plugin_id}@{version} "
            f"({', '.join(str(p) for p in sorted(matches))}); refusing to guess which to instantiate"
        )
    return matches[0]


def _company_items(
    *,
    companies_root: Path,
    revocation_file: Path,
    registry_state: RegistryMetadataState | None,
    registry_rollback_ok: bool,
    include_revoked: bool,
) -> list[CatalogItem]:
    if not companies_root.exists():
        return []
    items: list[CatalogItem] = []
    for manifest_path in sorted(companies_root.glob("*/superclaw-company.json")):
        template = None
        try:
            template = load_company_template(manifest_path.parent)
            try:
                # A malformed / contract-violating company is an EXPECTED fail-closed
                # outcome: surface it as an `untrusted`, non-instantiable item with a
                # diagnostic reason instead of silently dropping it (禁止静默吞错 /
                # design G2 — mirrors plugin discovery's non-raising assess()).
                validate_company_template_contract(template.manifest)
            except CompanyTemplateError as exc:
                # NOTE: a contract-invalid manifest may not be a dict (e.g. a JSON list/
                # scalar), so read fields defensively via _manifest_field — never assume
                # `.get` exists, or the AttributeError would fall through to the outer
                # except and silently drop the item.
                fallback = manifest_path.parent.name
                items.append(
                    _untrusted_company_item(
                        plugin_id=str(_manifest_field(template.manifest, "id", fallback)),
                        version=str(_manifest_field(template.manifest, "version", "")),
                        name=str(_manifest_field(template.manifest, "name", fallback)),
                        summary=_manifest_field(template.manifest, "summary", None),
                        reason=f"contract_invalid:{exc}",
                    )
                )
                continue
            derivation, revoked = _derive_company_trust(
                template,
                revocation_file=revocation_file,
                registry_state=registry_state,
                registry_rollback_ok=registry_rollback_ok,
            )
            if revoked and not include_revoked:
                continue
            items.append(
                CatalogItem(
                    kind="company",
                    plugin_id=template.artifact_id,
                    version=template.version,
                    name=str(template.manifest.get("name") or template.artifact_id),
                    summary=str(template.manifest.get("summary")) if template.manifest.get("summary") is not None else None,
                    digest=template.package_digest,
                    trust=derivation.state,
                    trust_reasons=tuple(derivation.reasons),
                    signer_class=derivation.signer_class,
                    namespace_reserved=derivation.namespace_reserved,
                    install_state={"installed": False, "installed_versions": [], "update_available": False},
                    entitlement_state="not_required",
                    revoked=revoked,
                    skill_origin=False,
                    logo_url=str(template.manifest.get("logo")) if template.manifest.get("logo") else None,
                    sources=("company_dir",),
                    # G1: instantiable is DERIVED from TrustState (official/local & not
                    # revoked), never a literal constant. The bootstrap gate remains the
                    # fail-closed authority that re-verifies at instantiation time; this
                    # flag is advisory ("may be offered to proposal-mode bootstrap").
                    instantiable=_company_instantiable(derivation, revoked=revoked, manifest=template.manifest),
                    registry_status="revoked" if revoked else "approved",
                )
            )
        except (CompanyTemplateError, json.JSONDecodeError, OSError, ValueError) as exc:
            # Expected fail-closed on load (missing/invalid manifest, INVALID JSON,
            # unreadable file, symlink, etc.): surface untrusted rather than vanish.
            # json.JSONDecodeError is a ValueError subclass and is raised by the loader's
            # manifest read (not wrapped as CompanyTemplateError), so it MUST be caught
            # here too — otherwise malformed JSON would fall to the broad warn+skip and be
            # silently dropped. We use the on-disk COMPANY DIRECTORY name (the stable,
            # operator-chosen slug under companies_root) as the identifier — _company_items
            # only ever loads directories from this glob, so this is never a randomized
            # archive temp-dir name.
            dir_slug = manifest_path.parent.name
            items.append(
                _untrusted_company_item(
                    plugin_id=dir_slug,
                    version="",
                    name=dir_slug,
                    summary=None,
                    reason=f"unverifiable:{exc}",
                )
            )
            continue
        except Exception:  # noqa: BLE001 - truly UNEXPECTED error: log + skip (never crash discovery).
            _logger.warning("company discovery skipped %s due to unexpected error", manifest_path, exc_info=True)
            continue
        finally:
            if template is not None:
                template.cleanup()
    return items


def _manifest_field(manifest: Any, key: str, default: Any) -> Any:
    """Read a manifest field defensively. A contract-invalid manifest may be a
    non-dict (JSON list/scalar); never assume `.get` exists (else an AttributeError
    would escape the expected fail-closed path and silently drop the item)."""
    if isinstance(manifest, dict):
        value = manifest.get(key)
        if value is not None:
            return value
    return default


def _untrusted_company_item(
    *, plugin_id: str, version: str, name: str, summary: Any, reason: str
) -> CatalogItem:
    """A visible-untrusted catalog item for a company that fails closed at discovery.

    Surfaced (not dropped) so the workshop can show WHY a company is unavailable;
    never instantiable, fail-closed."""
    return CatalogItem(
        kind="company",
        plugin_id=plugin_id,
        version=version,
        name=name,
        summary=str(summary) if summary is not None else None,
        digest=None,
        trust=TrustState.UNTRUSTED,
        trust_reasons=(reason,),
        signer_class="none",
        namespace_reserved=any(plugin_id.startswith(p) for p in FIRST_PARTY_NAMESPACES),
        install_state={"installed": False, "installed_versions": [], "update_available": False},
        entitlement_state="not_required",
        revoked=False,
        skill_origin=False,
        sources=("company_dir",),
        instantiable=False,
        registry_status="unverifiable",
    )


def _derive_plugin_trust(
    package: PluginPackage,
    *,
    source_is_local: bool,
    revocation_file: Path,
    registry_state: RegistryMetadataState | None,
    registry_rollback_ok: bool,
) -> tuple[TrustDerivation, bool]:
    revoked = _plugin_revoked(package, revocation_file=revocation_file)
    high_risk = _plugin_high_risk(package.manifest)
    verdict = _assess_plugin(package, registry_state=registry_state)
    derivation = derive_trust_state(
        plugin_id=package.plugin_id,
        verdict=verdict,
        revoked=revoked,
        source_is_local=source_is_local,
        rollback_ok=registry_rollback_ok,
        freshness_ok=(registry_state.fresh if registry_state is not None else True),
        high_risk=high_risk,
        developer_keyids=registry_state.active_developer_keyids if registry_state is not None else None,
    )
    return derivation, revoked


def _derive_company_trust(
    envelope: SignedArtifactEnvelope,
    *,
    revocation_file: Path,
    registry_state: RegistryMetadataState | None,
    registry_rollback_ok: bool,
) -> tuple[TrustDerivation, bool]:
    revoked = _company_revoked(envelope, revocation_file=revocation_file)
    verdict = _assess_company(envelope, registry_state=registry_state)
    derivation = derive_trust_state(
        plugin_id=envelope.artifact_id,
        verdict=verdict,
        revoked=revoked,
        source_is_local=True,
        rollback_ok=registry_rollback_ok,
        freshness_ok=True,
        high_risk=False,
        developer_keyids=registry_state.active_developer_keyids if registry_state is not None else None,
    )
    return derivation, revoked


def _assess_plugin(package: PluginPackage, *, registry_state: RegistryMetadataState | None) -> PackageTrustVerdict:
    try:
        digest = compute_package_digest(package)
        if package.package_digest != digest:
            return PackageTrustVerdict(signer_class="none", integrity_ok=False)
        signer = plugin_signer_identity(package)
        if signer == "none":
            developer_signer = classify_developer_signer(
                digest=digest,
                signature=package.signature,
                kind="skill" if is_skill_origin_plugin(package.plugin_id, package.manifest.get("skill_origin")) else "plugin",
                artifact_id=package.plugin_id,
                version=package.version,
                state=registry_state,
            )
            if developer_signer:
                signer = developer_signer
        return PackageTrustVerdict(
            signer_class=signer if signer != "invalid" else "none",
            integrity_ok=signer != "invalid",
        )
    except Exception:
        return PackageTrustVerdict(signer_class="none", integrity_ok=False)


def _assess_company(envelope: SignedArtifactEnvelope, *, registry_state: RegistryMetadataState | None) -> PackageTrustVerdict:
    try:
        digest = _COMPANY_VERIFIER.compute_digest(envelope)
        if envelope.package_digest != digest:
            return PackageTrustVerdict(signer_class="none", integrity_ok=False)
        signer = _COMPANY_VERIFIER.classify_signer(digest, envelope.signature)
        if signer == "none":
            developer_signer = classify_developer_signer(
                digest=digest,
                signature=envelope.signature,
                kind="company",
                artifact_id=envelope.artifact_id,
                version=envelope.version,
                state=registry_state,
            )
            if developer_signer:
                signer = developer_signer
        return PackageTrustVerdict(
            signer_class=signer,
            integrity_ok=True,
        )
    except Exception:
        return PackageTrustVerdict(signer_class="none", integrity_ok=False)


def _plugin_revoked(package: PluginPackage, *, revocation_file: Path) -> bool:
    try:
        check_plugin_revocation(package, revocation_file=revocation_file)
    except Exception:
        return True
    return False


def _company_revoked(envelope: SignedArtifactEnvelope, *, revocation_file: Path) -> bool:
    try:
        _COMPANY_VERIFIER.check_revocation(envelope, revocation_file)
    except Exception:
        return True
    return False


def _detect_plugin_signer_conflicts(
    *,
    cache_root: Path,
    cloud_root: Path,
    public_key: str | None,
) -> list[dict[str, Any]]:
    signers: dict[str, set[str]] = {}
    versions: dict[str, set[str]] = {}
    for row in list_cached_plugins(cache_root=cache_root):
        plugin_id = str(row.get("id") or "")
        version = str(row.get("version") or "")
        package = load_cached_package(plugin_id, version=version, cache_root=cache_root)
        if package is None:
            continue
        try:
            signer = plugin_signer_identity(package, public_key=public_key)
        except Exception:
            signer = "invalid"
        finally:
            package.cleanup()
        signers.setdefault(plugin_id, set()).add(signer)
        versions.setdefault(plugin_id, set()).add(version)
    for row in list_registry_plugins(cloud_root):
        plugin_id = str(row.get("plugin_id") or "")
        version = str(row.get("version") or "")
        package = _load_registry_package(cloud_root, plugin_id, version)
        if package is None:
            continue
        try:
            signer = plugin_signer_identity(package, public_key=public_key)
        except Exception:
            signer = "invalid"
        finally:
            package.cleanup()
        signers.setdefault(plugin_id, set()).add(signer)
        versions.setdefault(plugin_id, set()).add(version)
    conflicts: list[dict[str, Any]] = []
    for plugin_id, signer_set in sorted(signers.items()):
        non_empty = {item for item in signer_set if item}
        if len(non_empty) > 1:
            conflicts.append(
                {
                    "kind": "plugin",
                    "plugin_id": plugin_id,
                    "reason": "same_id_different_signer",
                    "signers": sorted(non_empty),
                    "versions": sorted(versions.get(plugin_id, set()), key=version_tuple),
                }
            )
    return conflicts


def _load_registry_package(cloud_root: Path, plugin_id: str, version: str) -> PluginPackage | None:
    metadata_path = cloud_root / "registry" / "plugins" / plugin_id / version / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        package_path = metadata.get("package_path")
        if not package_path:
            return None
        candidate = Path(str(package_path))
        if not candidate.is_absolute():
            candidate = metadata_path.parent / candidate
        resolved = candidate.resolve()
        registry_root = (cloud_root / "registry").resolve()
        if resolved != registry_root and registry_root not in resolved.parents:
            return None
        return load_plugin_package(resolved)
    except Exception:
        return None


def _installed_versions(*, cache_root: Path) -> dict[str, list[str]]:
    installed: dict[str, list[str]] = {}
    for row in list_cached_plugins(cache_root=cache_root):
        plugin_id = str(row.get("id") or "")
        version = str(row.get("version") or "")
        if plugin_id and version:
            installed.setdefault(plugin_id, []).append(version)
    for versions in installed.values():
        versions.sort(key=version_tuple)
    return installed


def _install_state(plugin_id: str, version: str, installed_versions: dict[str, list[str]]) -> dict[str, Any]:
    versions = installed_versions.get(plugin_id, [])
    installed = version in versions
    latest_installed = versions[-1] if versions else None
    return {
        "installed": installed,
        "installed_versions": list(versions),
        "update_available": bool(latest_installed and version_tuple(version) > version_tuple(latest_installed)),
    }


def _plugin_high_risk(manifest: dict[str, Any]) -> bool:
    commerce = manifest.get("commerce") if isinstance(manifest.get("commerce"), dict) else {}
    if commerce.get("pricing_model") not in {None, "", "free"}:
        return True
    permissions = json.dumps(manifest.get("permissions", {}), sort_keys=True).lower()
    high_risk_needles = ("network", "browser", "secret", "payment", "filesystem", "sidecar", "env")
    return any(needle in permissions for needle in high_risk_needles)


def _untrusted(plugin_id: str, reason: str) -> TrustDerivation:
    return TrustDerivation(
        state=TrustState.UNTRUSTED,
        signer_class="none",
        namespace_reserved=any(plugin_id.startswith(prefix) for prefix in FIRST_PARTY_NAMESPACES),
        revoked=False,
        freshness_ok=True,
        rollback_ok=True,
        reasons=(reason,),
    )


def _merge_sources(existing: CatalogItem | None, incoming: CatalogItem) -> CatalogItem:
    if existing is None:
        return incoming
    merged_sources = tuple(dict.fromkeys([*existing.sources, *incoming.sources]))
    trusted_rank = {"official": 3, "developer": 2, "local": 1, "untrusted": 0}
    chosen = incoming if trusted_rank[incoming.trust.value] > trusted_rank[existing.trust.value] else existing
    merged_revoked = existing.revoked or incoming.revoked
    duplicate_local = False
    display_digest = chosen.digest
    if chosen.kind == "company":
        # Company instantiability must be HONEST about the merged item's DISPLAYED
        # trust+version (= chosen): a source at a DIFFERENT trust level must NOT lend its
        # offerability to the chosen badge. The rule is:
        #   instantiable iff trust∈{official,local}+not-revoked (derived from chosen.trust)
        #   AND there is a source S with S.trust == chosen.trust AND S.instantiable True
        #   (i.e. a LOCAL-PRESENT, offerable source AT the winning trust level — only a
        #   local-dir source ever sets instantiable True; a registry/remote row is always
        #   False, having no local source path for the gate).
        # This closes the trust-spoofing leak (Gemini): a LOCAL local-dir (True) merged
        # with an OFFICIAL registry row (False) yields chosen=OFFICIAL but NO official
        # source is instantiable ⇒ False — never an OFFICIAL badge over unsigned local
        # bytes. It also avoids the earlier clobber: a local OFFICIAL (True) tying with a
        # registry OFFICIAL (False) stays True because the local official source matches
        # the chosen trust and is instantiable.
        chosen_trust = chosen.trust
        instantiable_at_chosen_trust = (existing.trust == chosen_trust and existing.instantiable) or (
            incoming.trust == chosen_trust and incoming.instantiable
        )
        merged_instantiable = (
            _company_instantiable_from_trust(chosen_trust, revoked=merged_revoked) and instantiable_at_chosen_trust
        )
        # AMBIGUOUS-DUPLICATE guard (Codex PR-5 R4): if BOTH merged sources are LOCAL-DIR
        # companies (two on-disk dirs declaring the same id@version), the gate's resolver
        # (resolve_company_source_path) will refuse to pick one — so the catalog must NOT
        # badge it offerable, or the Web would enable an action the core rejects. Detect by
        # both sources carrying the company-dir provenance marker and force False (badge<->
        # gate parity). Two registry rows can't collide (immutable digest per id@version).
        duplicate_local = "company_dir" in existing.sources and "company_dir" in incoming.sources
        if duplicate_local:
            merged_instantiable = False
        # IDENTITY-DISPLAY binding (Codex PR-5 R5/R6): "instantiate what you see". When a
        # company has a LOCAL-DIR source AT the displayed (chosen) trust level, bootstrap
        # resolves by id@version to those LOCAL bytes — so the DISPLAYED digest must be that
        # local source's (not a remote/registry row's, which a trust-rank tie can leave as
        # `chosen`). Bind the digest to the local source ONLY when its trust == chosen.trust,
        # so the displayed (trust label, digest) pair is always self-consistent AND, when
        # offerable, equals what the gate resolves+verifies. In a mixed-trust row (e.g.
        # chosen=registry OFFICIAL, local=LOCAL → not offerable), we keep the chosen
        # (registry official) digest so the row never labels local bytes above their
        # provenance (owner RED LINE).
        local_src = (
            existing
            if "company_dir" in existing.sources
            else (incoming if "company_dir" in incoming.sources else None)
        )
        if local_src is not None and local_src.digest is not None and local_src.trust == chosen.trust:
            display_digest = local_src.digest
    else:
        merged_instantiable = existing.instantiable and incoming.instantiable
    reason_suffix: tuple[str, ...] = ("ambiguous_duplicate_local_source",) if duplicate_local else ()
    return CatalogItem(
        kind=chosen.kind,
        plugin_id=chosen.plugin_id,
        version=chosen.version,
        name=chosen.name,
        summary=chosen.summary,
        digest=display_digest,
        trust=chosen.trust,
        trust_reasons=(*chosen.trust_reasons, *reason_suffix),
        signer_class=chosen.signer_class,
        namespace_reserved=chosen.namespace_reserved,
        install_state=_merge_install_state(existing.install_state, incoming.install_state),
        entitlement_state=chosen.entitlement_state,
        revoked=merged_revoked,
        skill_origin=existing.skill_origin or incoming.skill_origin,
        logo_url=chosen.logo_url or existing.logo_url or incoming.logo_url,
        sources=merged_sources,
        instantiable=merged_instantiable,
        registry_status=chosen.registry_status or existing.registry_status or incoming.registry_status,
        revocation=chosen.revocation or existing.revocation or incoming.revocation,
    )


def _merge_install_state(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    versions = sorted({*left.get("installed_versions", []), *right.get("installed_versions", [])}, key=version_tuple)
    return {
        "installed": bool(left.get("installed") or right.get("installed")),
        "installed_versions": versions,
        "update_available": bool(left.get("update_available") or right.get("update_available")),
    }


def _registry_freshness(registry_root: Path) -> dict[str, Any]:
    return registry_freshness_from_state_file(registry_root)


def _load_registry_state(registry_root: Path, *, public_key: str | None) -> tuple[RegistryMetadataState | None, dict[str, Any], bool]:
    try:
        state = load_registry_metadata(registry_root, public_key=public_key)
    except RegistryMetadataError as exc:
        freshness = _registry_freshness(registry_root)
        freshness.update({"fresh": False, "expires_at": freshness.get("expires_at"), "stale_reason": str(exc)})
        return None, freshness, "rollback" not in str(exc)
    if state is None:
        return None, _registry_freshness(registry_root), True
    return state, state.freshness_payload(), True


def _optional_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _catalog_sort_key(item: CatalogItem) -> tuple[int, str, str, tuple[int, ...]]:
    kind_rank = {"plugin": 0, "skill": 1, "company": 2}
    trust_rank = {"official": 0, "developer": 1, "local": 2, "untrusted": 3}
    return (kind_rank.get(item.kind, 9), item.plugin_id, trust_rank[item.trust.value], version_tuple(item.version))


def _logo_url(plugin_id: str, version: str, manifest: dict[str, Any]) -> str | None:
    logo = manifest.get("logo")
    if isinstance(logo, str) and logo.strip():
        return f"/api/plugins/{plugin_id}/logo?version={version}"
    return None


def _validate_kind(kind: str | None) -> None:
    if kind is not None and kind not in CATALOG_KINDS:
        raise ValueError(f"unknown catalog kind: {kind!r}")


def _utc_now(now: float | None) -> str:
    dt = datetime.fromtimestamp(now, UTC) if now is not None else datetime.now(UTC)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


__all__ = [
    "CATALOG_KINDS",
    "CatalogItem",
    "CatalogResolution",
    "refresh_catalog",
    "resolve_catalog",
    "resolve_trust_state",
    "trust_derivation_to_dict",
]
