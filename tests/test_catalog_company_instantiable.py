"""Catalog company `instantiable` derivation + untrusted surfacing (D3 PR-2).

`instantiable` for company is DERIVED from TrustState (official/local & not revoked
=> True; developer/untrusted/revoked => False, fail-closed) — never a literal
constant (design G1). A malformed/unverifiable company is SURFACED as an untrusted,
non-instantiable item, never silently dropped (design G2). The bootstrap gate
(resolve_company_template_for_bootstrap) remains the fail-closed authority; this
catalog flag is advisory and must stay consistent with the gate (provenance honesty).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import pytest

from superclaw.catalog_resolver import resolve_catalog, resolve_company_source_path
from superclaw.company_template import _COMPANY_VERIFIER, CompanyTemplate, CompanyTemplateError
from superclaw.trust_state import TrustState

ROOT_KEY_ENV = "SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY"
LOCAL_DEV_ENV = "SUPERCLAW_COMPANY_LOCAL_DEV_TRUST"


def _keypair():
    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, "ed25519:" + base64.b64encode(raw).decode()


def _manifest(**overrides):
    m = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery Co",
        "version": "1.0.0",
        "summary": "blueprint",
        "kind": "company",
        "source": {"type": "local", "developer_id": "self"},
        "commerce": {"pricing_model": "free"},
        "roles": [{"name": "lead", "charter": "Lead the team"}],
        "equipment_requirements": {},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "local", "package_digest": "", "signature": ""},
    }
    m.update(overrides)
    return m


def _write(root: Path, slug: str, manifest: dict) -> None:
    d = root / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")


def _sign(manifest: dict, priv: Ed25519PrivateKey, root: Path, slug: str) -> None:
    _write(root, slug, manifest)
    base = root / slug
    digest = _COMPANY_VERIFIER.compute_digest(CompanyTemplate(source=base, root=base, manifest=manifest))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")


def _private_root(tmp_path: Path) -> Path:
    root = tmp_path / "companies"
    root.mkdir(mode=0o700)
    return root


def _company_items(tmp_path, monkeypatch, **resolve_kwargs):
    """resolve_catalog(kind=company) with isolated roots so host state can't leak in."""
    root = resolve_kwargs.pop("companies_root")
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=tmp_path / "cloud",
        registry_root=tmp_path / "registry",
        **resolve_kwargs,
    )
    return {item.plugin_id: item for item in resolution.items}


def test_official_company_is_instantiable(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    root = _private_root(tmp_path)
    _sign(_manifest(source={"type": "official", "developer_id": "first_party"}), priv, root, "co")
    items = _company_items(tmp_path, monkeypatch, companies_root=root)
    item = items["acme.delivery"]
    assert item.trust is TrustState.OFFICIAL
    assert item.instantiable is True


def test_local_company_instantiable_only_with_optin_env(tmp_path, monkeypatch):
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    # Without the local-dev env, an unsigned local company is UNTRUSTED in discovery
    # (no root/dev signature) -> not instantiable, but SURFACED (not dropped).
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    root = _private_root(tmp_path)
    _sign(_manifest(), priv, root, "co")
    item = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.delivery"]
    assert item.trust is TrustState.UNTRUSTED
    assert item.instantiable is False

    # With the explicit local-dev opt-in env, the same template reads `local` and is
    # instantiable (one of the two opt-in routes the bootstrap gate honors).
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    item = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.delivery"]
    assert item.trust is TrustState.LOCAL
    assert item.instantiable is True


def test_local_company_claiming_remote_provenance_not_instantiable(tmp_path, monkeypatch):
    """Badge<->gate parity: a `local` template that self-claims remote/developer
    provenance must NOT be marked instantiable (the gate would reject it)."""
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    root = _private_root(tmp_path)
    _sign(_manifest(source={"type": "developer", "developer_id": "dev_x"}), priv, root, "co")
    item = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.delivery"]
    assert item.trust is TrustState.LOCAL  # admitted as local by discovery classifier
    assert item.instantiable is False  # ...but not offerable: self-claims remote provenance


def test_revoked_company_not_instantiable_and_surfaced_when_included(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    root = _private_root(tmp_path)
    _sign(_manifest(source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    revfile = tmp_path / "rev.json"
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    # Excluded by default.
    items = _company_items(tmp_path, monkeypatch, companies_root=root, company_revocation_file=revfile)
    assert "acme.delivery" not in items
    # Surfaced when include_revoked, but never instantiable.
    items = _company_items(
        tmp_path, monkeypatch, companies_root=root, company_revocation_file=revfile, include_revoked=True
    )
    item = items["acme.delivery"]
    assert item.revoked is True
    assert item.instantiable is False


def test_non_dict_manifest_surfaced_untrusted_not_dropped(tmp_path, monkeypatch):
    """A manifest that parses as a non-dict (JSON list/scalar) must still be SURFACED
    untrusted, not silently dropped via an AttributeError on `.get` (Gemini PR-2)."""
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    root = _private_root(tmp_path)
    d = root / "weird"
    d.mkdir()
    # A JSON list at the manifest path: load succeeds (json parses) but contract
    # validation fails; field reads must not assume a dict.
    (d / "superclaw-company.json").write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
    items = _company_items(tmp_path, monkeypatch, companies_root=root)
    # Surfaced under the directory slug, untrusted, not instantiable, not crashed/dropped.
    assert "weird" in items
    item = items["weird"]
    assert item.trust is TrustState.UNTRUSTED
    assert item.instantiable is False
    assert item.registry_status == "unverifiable"


def _write_registry(cloud_root: Path, entries: list[dict]) -> None:
    reg = cloud_root / "registry"
    reg.mkdir(parents=True, exist_ok=True)
    (reg / "capabilities.json").write_text(
        json.dumps({"schema_version": "clawhunt.admin.capability_registry.v1", "entries": entries}),
        encoding="utf-8",
    )


def _digest() -> str:
    return "sha256:" + ("a" * 64)


def test_registry_only_company_is_not_instantiable_even_official(tmp_path, monkeypatch):
    """A REGISTRY-ONLY company (no local source dir) is NEVER instantiable — even
    official — because the verify gate needs a local source path the registry can't
    provide; offering it would badge an action that always 404s (Codex PR-5).
    instantiable for company comes only from a LOCAL-DIR source."""
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    cloud = tmp_path / "cloud"
    _write_registry(
        cloud,
        [
            {"kind": "company", "capability_id": "acme.official", "version": "1.0.0",
             "package_digest": _digest(), "status": "approved", "trust": "official"},
            {"kind": "company", "capability_id": "acme.dev", "version": "1.0.0",
             "package_digest": _digest(), "status": "approved", "trust": "developer"},
        ],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=tmp_path / "empty-companies",
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    items = {i.plugin_id: i for i in resolution.items}
    # The official registry row is still SURFACED with its trust badge...
    assert items["acme.official"].trust is TrustState.OFFICIAL
    # ...but NOT instantiable (registry-only, no local source).
    assert items["acme.official"].instantiable is False
    assert items["acme.dev"].instantiable is False


def test_registry_company_local_label_reads_untrusted_not_instantiable(tmp_path, monkeypatch):
    """A REMOTE/registry company self-labeling trust=local is illegitimate (a registry
    is the published catalog; `local` means locally-built/unsigned). It must fail closed
    to UNTRUSTED at the trust-classification SOURCE — not merely be non-instantiable —
    so the BADGE itself never reads locally-trusted for remote content (Codex PR-2 R3 /
    owner trust model RED LINE: remote content must verify or be untrusted)."""
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    cloud = tmp_path / "cloud"
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.remotelocal", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "local"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=tmp_path / "empty-companies",
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.remotelocal"]
    assert item.trust is TrustState.UNTRUSTED  # badge fails closed at the source
    assert item.instantiable is False


def test_merge_does_not_clobber_company_instantiable(tmp_path, monkeypatch):
    """When the SAME official company appears both as a registry entry and a local
    dir, the merge must re-derive `instantiable` from the merged trust — a stale/forced
    per-source flag must not clobber a genuinely-offerable item (Codex PR-2 merge)."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    # Local dir: root-signed official.
    _sign(_manifest(id="acme.official", source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    # Registry: same id/version, official.
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.official", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "official"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.official"]
    assert item.trust is TrustState.OFFICIAL
    assert item.instantiable is True  # merge kept it offerable, not clobbered to False


def test_merge_lower_trust_loser_does_not_clobber_official_instantiable(tmp_path, monkeypatch):
    """Gemini PR-2 R4: a LOWER-trust source with instantiable=False (e.g. a `developer`
    registry entry) must NOT clobber a higher-trust OFFICIAL local template's
    instantiable=True. The merge derives from the CHOSEN (highest-trust) source, ANDing
    only the chosen source's own flag — never the loser's."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    # Local dir: root-signed OFFICIAL (the higher-trust winner; instantiable True).
    _sign(_manifest(id="acme.mixed", source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    # Registry: SAME id/version but `developer` trust (instantiable False, the loser).
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.mixed", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "developer"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.mixed"]
    assert item.trust is TrustState.OFFICIAL  # official wins the trust-rank merge
    assert item.instantiable is True  # NOT clobbered by the developer loser's False


def test_merge_provenance_failed_local_winner_stays_not_instantiable(tmp_path, monkeypatch):
    """Fail-closed merge: a local-dir `local` winner that FAILED provenance honesty
    (self-claims remote) keeps instantiable=False through the merge — the chosen
    winner's own flag (which encodes the provenance check) is ANDed in."""
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    # Local dir: local trust but self-claims developer provenance => not offerable.
    _sign(_manifest(id="acme.mixed2", source={"type": "developer", "developer_id": "x"}), priv, root, "co")
    # Registry: a lower-trust developer loser of the same id.
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.mixed2", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "developer"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.mixed2"]
    # local (rank 1) wins over developer (rank 2)? No — developer outranks local; but
    # either way the result must be fail-closed non-instantiable.
    assert item.instantiable is False


def test_merge_revoked_winner_stays_not_instantiable(tmp_path, monkeypatch):
    """Fail-closed merge: if either source is revoked, the merged company is revoked and
    never instantiable."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    _sign(_manifest(id="acme.rev", source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    revfile = tmp_path / "rev.json"
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.rev"}]}), encoding="utf-8")
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.rev", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "official"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
        company_revocation_file=revfile,
        include_revoked=True,
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.rev"]
    assert item.revoked is True
    assert item.instantiable is False


def test_invalid_json_manifest_surfaced_untrusted_not_dropped(tmp_path, monkeypatch):
    """A manifest with INVALID JSON raises json.JSONDecodeError from the loader (not a
    CompanyTemplateError); it must still be SURFACED untrusted, not dropped into the
    broad warn+skip branch (Codex PR-2)."""
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    root = _private_root(tmp_path)
    d = root / "brokenjson"
    d.mkdir()
    (d / "superclaw-company.json").write_text("{ this is not valid json ", encoding="utf-8")
    items = _company_items(tmp_path, monkeypatch, companies_root=root)
    assert "brokenjson" in items
    item = items["brokenjson"]
    assert item.trust is TrustState.UNTRUSTED
    assert item.instantiable is False
    assert item.registry_status == "unverifiable"


def test_contract_invalid_company_surfaced_untrusted_not_dropped(tmp_path, monkeypatch):
    """A malformed/contract-violating company is SURFACED as untrusted with a reason,
    never silently dropped (G2 / 禁止静默吞错)."""
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    root = _private_root(tmp_path)
    # reports_to cycle => contract invalid.
    bad = _manifest(
        roles=[
            {"name": "a", "charter": "x", "reports_to": "b"},
            {"name": "b", "charter": "y", "reports_to": "a"},
        ],
    )
    _write(root, "co", bad)
    item = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.delivery"]
    assert item.trust is TrustState.UNTRUSTED
    assert item.instantiable is False
    assert item.registry_status == "unverifiable"
    assert any("contract_invalid" in r for r in item.trust_reasons)


# --- D3 PR-5: resolve_company_source_path (catalog id -> local source dir) ---------


def test_resolve_company_source_path_matches_by_verified_id(tmp_path, monkeypatch):
    """Resolves a cataloged company id+version to its local source DIR by the LOADED
    template's artifact_id+version (not the dir name)."""
    priv, _ = _keypair()
    root = _private_root(tmp_path)
    # Directory name deliberately differs from the company id.
    _sign(_manifest(id="acme.delivery"), priv, root, "weird-dir-name")
    resolved = resolve_company_source_path("acme.delivery", "1.0.0", companies_root=root)
    assert resolved == root / "weird-dir-name"


def test_resolve_company_source_path_no_local_source_fails_closed(tmp_path):
    """A remote/registry-only company has no local source dir => FileNotFoundError."""
    root = _private_root(tmp_path)
    with pytest.raises(FileNotFoundError):
        resolve_company_source_path("no.such.company", "1.0.0", companies_root=root)


def test_duplicate_local_company_is_not_instantiable_in_catalog(tmp_path, monkeypatch):
    """Catalog-level badge<->gate parity (Codex PR-5 R4): two local dirs declaring the
    same id@version merge into one catalog row that must be instantiable=False — the
    gate's resolver would refuse the ambiguous source, so the Web must not offer it."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    root = _private_root(tmp_path)
    # Two official local dirs, same id+version.
    _sign(_manifest(id="acme.dup", source={"type": "official", "developer_id": "fp"}), priv, root, "dir-a")
    _sign(_manifest(id="acme.dup", source={"type": "official", "developer_id": "fp"}), priv, root, "dir-b")
    item = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.dup"]
    assert item.trust is TrustState.OFFICIAL
    assert item.instantiable is False  # ambiguous duplicate => not offerable
    assert any("ambiguous_duplicate_local_source" in r for r in item.trust_reasons)


def test_resolve_company_source_path_ambiguous_duplicate_fails_closed(tmp_path):
    """TWO local dirs declaring the same id+version is ambiguous — refuse to guess
    which to instantiate (Codex PR-5: could otherwise instantiate different bytes than
    the catalog winner)."""
    priv, _ = _keypair()
    root = _private_root(tmp_path)
    _sign(_manifest(id="acme.dup"), priv, root, "dir-a")
    _sign(_manifest(id="acme.dup"), priv, root, "dir-b")
    with pytest.raises(CompanyTemplateError, match="ambiguous"):
        resolve_company_source_path("acme.dup", "1.0.0", companies_root=root)


def test_local_lowtrust_does_not_lend_offerability_to_official_registry_badge(tmp_path, monkeypatch):
    """Trust-spoofing guard (Gemini PR-5 R2): a LOCAL local-dir source (instantiable under
    dev opt-in) merged with an OFFICIAL registry row (same version) must NOT yield an
    OFFICIAL-badged instantiable item — the local source's offerability is at the LOCAL
    trust level, not OFFICIAL, so it cannot lend instantiability to the official badge
    (else the UI would promise official while the gate instantiates unsigned local bytes)."""
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")  # local-dir reads LOCAL + instantiable
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    # Local dir: unsigned local (LOCAL trust under opt-in), honest local provenance.
    _sign(_manifest(id="acme.spoof"), priv, root, "co")
    # Registry row: SAME id+version, OFFICIAL trust (registry => instantiable False).
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.spoof", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "official"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.spoof"]
    assert item.trust is TrustState.OFFICIAL  # official wins the rank merge (displayed badge)
    # ...but NOT instantiable: no OFFICIAL source has a local path; the LOCAL source's
    # offerability does not transfer to the official badge.
    assert item.instantiable is False
    # Provenance-honest display (Codex PR-5 R6): the digest shown under the OFFICIAL label
    # must be the OFFICIAL (registry) source's, NOT the LOCAL source's — the row must never
    # label local bytes above their provenance, even with the button disabled.
    assert item.digest == _digest()  # the registry/official digest, not the local one


def test_displayed_digest_binds_to_local_source_not_registry(tmp_path, monkeypatch):
    """Identity-display binding (Codex PR-5 R5): when a company has a local source AND a
    registry row of the same id@version with a DIFFERENT digest, the merged catalog row's
    DISPLAYED digest must be the LOCAL source's (what bootstrap resolves) — so the card
    shows exactly the bytes that will be instantiated ('instantiate what you see')."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    _sign(_manifest(id="acme.conflict", source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    local_digest = _company_items(tmp_path, monkeypatch, companies_root=root)["acme.conflict"].digest
    registry_digest = "sha256:" + ("b" * 64)
    assert local_digest != registry_digest  # sanity: distinct identities
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.conflict", "version": "1.0.0",
          "package_digest": registry_digest, "status": "approved", "trust": "official"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.conflict"]
    assert item.trust is TrustState.OFFICIAL
    assert item.instantiable is True  # local source present, official => offerable
    # The DISPLAYED digest is the LOCAL one (what the gate resolves), not the registry's.
    assert item.digest == local_digest
    assert item.digest != registry_digest


def test_local_plus_registry_official_merges_to_instantiable(tmp_path, monkeypatch):
    """A company present BOTH as an official local dir (has a source path) AND an
    official registry row (no source path) must merge to instantiable=True — the local
    source's offerability is preserved, not clobbered by the registry's False (PR-5)."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    cloud = tmp_path / "cloud"
    root = _private_root(tmp_path)
    _sign(_manifest(id="acme.both", source={"type": "official", "developer_id": "fp"}), priv, root, "co")
    _write_registry(
        cloud,
        [{"kind": "company", "capability_id": "acme.both", "version": "1.0.0",
          "package_digest": _digest(), "status": "approved", "trust": "official"}],
    )
    resolution = resolve_catalog(
        kind="company",
        companies_root=root,
        cache_root=tmp_path / "cache",
        cloud_root=cloud,
        registry_root=tmp_path / "registry",
    )
    item = {i.plugin_id: i for i in resolution.items}["acme.both"]
    assert item.trust is TrustState.OFFICIAL
    assert item.instantiable is True  # local source present => offerable
