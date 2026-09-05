from __future__ import annotations

import base64
import hashlib
import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from typer.testing import CliRunner

from superclaw.capability_registry import (
    CapabilityRegistryClient,
    CapabilityRegistryError,
    publish_capability_registry_entry,
)
from superclaw.catalog_resolver import resolve_catalog, resolve_trust_state
from superclaw.cli import app
from superclaw.company_template import CompanyTemplate, _COMPANY_VERIFIER
from superclaw.plugin_cloud import copy_package_into_fake_registry
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _copy_plugin(tmp_path: Path, name: str = "hello-world", target_name: str | None = None) -> Path:
    target = tmp_path / (target_name or name)
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _sign_plugin(plugin_dir: Path, private_key: Ed25519PrivateKey) -> str:
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return digest


def _canonical(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sign_metadata(private_key: Ed25519PrivateKey, payload: dict[str, Any]) -> str:
    return "ed25519:" + base64.b64encode(private_key.sign(_canonical(payload))).decode("ascii")


def _signed_metadata(signed: dict[str, Any], private_key: Ed25519PrivateKey, keyid: str) -> dict[str, Any]:
    return {"signed": signed, "signatures": [{"keyid": keyid, "signature": _sign_metadata(private_key, signed)}]}


def _metadata_digest(doc: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(doc["signed"])).hexdigest()


def _write_registry_trust_bundle(
    registry_root: Path,
    *,
    root_private: Ed25519PrivateKey,
    root_public: str,
    developer_public: str,
    target_id: str,
    target_version: str,
    target_digest: str,
    target_kind: str = "plugin",
    sequence: int = 1,
    developer_paths: list[str] | None = None,
) -> None:
    timestamp_private, timestamp_public = _keypair()
    snapshot_private, snapshot_public = _keypair()
    targets_private, targets_public = _keypair()
    targets = _signed_metadata(
        {
            "type": "targets",
            "sequence": sequence,
            "delegations": {
                "developers": {
                    "dev-key": {
                        "public_key": developer_public,
                        "paths": developer_paths or ["dev.superclaw.*"],
                    }
                }
            },
            "targets": [
                {
                    "kind": target_kind,
                    "id": target_id,
                    "version": target_version,
                    "digest": target_digest,
                    "signer_keyid": "dev-key",
                }
            ],
        },
        targets_private,
        "targets",
    )
    snapshot = _signed_metadata(
        {
            "type": "snapshot",
            "sequence": sequence,
            "meta": {
                "targets.json": {
                    "version": sequence,
                    "sha256": _metadata_digest(targets),
                }
            },
        },
        snapshot_private,
        "snapshot",
    )
    timestamp = _signed_metadata(
        {
            "type": "timestamp",
            "sequence": sequence,
            "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "meta": {
                "snapshot.json": {
                    "version": sequence,
                    "sha256": _metadata_digest(snapshot),
                },
                "targets.json": {
                    "version": sequence,
                    "sha256": _metadata_digest(targets),
                },
            },
        },
        timestamp_private,
        "timestamp",
    )
    root_doc = _signed_metadata(
        {
            "type": "root",
            "sequence": 1,
            "keys": {
                "root": root_public,
                "timestamp": timestamp_public,
                "snapshot": snapshot_public,
                "targets": targets_public,
            },
        },
        root_private,
        "root",
    )
    registry_root.mkdir(parents=True, exist_ok=True)
    for name, doc in {
        "root.json": root_doc,
        "timestamp.json": timestamp,
        "snapshot.json": snapshot,
        "targets.json": targets,
    }.items():
        (registry_root / name).write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _cache_signed_plugin(
    tmp_path: Path,
    *,
    cache_root: Path,
    version: str = "0.1.0",
    skill_origin: bool = False,
    fixture: str = "hello-world",
    private_key: Ed25519PrivateKey | None = None,
    public_key: str | None = None,
    target_name: str | None = None,
) -> tuple[Path, str, str]:
    private_key = private_key or Ed25519PrivateKey.generate()
    if public_key is None:
        public_key = base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    plugin_dir = _copy_plugin(tmp_path, fixture, target_name=target_name)
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = version
    if skill_origin:
        manifest["skill_origin"] = True
        manifest["id"] = "skill.changelog-formatter"
        manifest["name"] = "Changelog Formatter"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = _sign_plugin(plugin_dir, private_key)
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    return plugin_dir, public_key, digest


def _write_registry_metadata(cloud_root: Path, plugin_dir: Path, plugin_id: str, version: str, digest: str) -> None:
    package_path = copy_package_into_fake_registry(plugin_dir, cloud_root, plugin_id, version)
    metadata_path = package_path.parent / "metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "plugin_id": plugin_id,
                "version": version,
                "package_digest": digest,
                "package_path": "package",
                "summary": "Registry copy",
                "compatibility": {"superclaw": ">=0.1.0"},
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _company_manifest() -> dict:
    return {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery Co",
        "version": "1.0.0",
        "summary": "Delivery company blueprint",
        "kind": "company",
        "source": {"type": "local", "developer_id": "acme"},
        "commerce": {"pricing_model": "free"},
        "roles": [{"name": "lead", "charter": "Lead the team"}],
        "equipment_requirements": {},
        "provenance": {"build_type": "local", "package_digest": "", "signature": ""},
    }


def _write_signed_company(root: Path, private_key: Ed25519PrivateKey | None = None) -> tuple[Path, str]:
    private_key = private_key or Ed25519PrivateKey.generate()
    company_dir = root / "acme.delivery"
    company_dir.mkdir(parents=True)
    manifest = _company_manifest()
    manifest_path = company_dir / "superclaw-company.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    template = CompanyTemplate(source=company_dir, root=company_dir, manifest=manifest)
    digest = _COMPANY_VERIFIER.compute_digest(template)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return company_dir, digest


def test_catalog_resolve_cli_projects_registry_local_skill_and_company(tmp_path: Path, monkeypatch):
    private_key, public_key = _keypair()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    cache_root = tmp_path / "cache"
    cloud_root = tmp_path / "cloud"
    companies_root = tmp_path / "companies"
    plugin_dir, _public_key, digest = _cache_signed_plugin(
        tmp_path, cache_root=cache_root, private_key=private_key, public_key=public_key
    )
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    _cache_signed_plugin(
        tmp_path,
        cache_root=cache_root,
        private_key=private_key,
        public_key=public_key,
        skill_origin=True,
        target_name="skill-plugin",
    )
    _write_signed_company(companies_root)

    result = CliRunner().invoke(
        app,
        [
            "catalog",
            "resolve",
            "--cache-root",
            str(cache_root),
            "--cloud-root",
            str(cloud_root),
            "--companies-root",
            str(companies_root),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    by_key = {(item["kind"], item["plugin_id"]): item for item in payload["items"]}
    assert by_key[("plugin", "dev.superclaw.hello-world")]["trust"] == "official"
    assert by_key[("plugin", "dev.superclaw.hello-world")]["sources"] == ["registry", "local_cache"]
    assert by_key[("skill", "skill.changelog-formatter")]["sources"] == ["local_cache", "skill_projection"]
    assert by_key[("company", "acme.delivery")]["instantiable"] is False


def test_capability_registry_projects_approved_plugin_skill_and_company(tmp_path: Path):
    digest_plugin = "sha256:" + "a" * 64
    digest_skill = "sha256:" + "b" * 64
    digest_company = "sha256:" + "c" * 64
    cloud_root = tmp_path / "cloud"
    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "plugin",
            "plugin_id": "dev.superclaw.registry-plugin",
            "version": "1.2.3",
            "package_digest": digest_plugin,
            "status": "approved",
            "name": "Registry Plugin",
            "summary": "Approved plugin from ClawHunt admin registry.",
            "entitlement_required": True,
            "signer_keyid": "dev-plugin",
        },
    )
    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "skill",
            "capability_id": "skill.registry-coach",
            "version": "0.4.0",
            "digest": digest_skill,
            "status": "approved",
            "name": "Registry Coach",
        },
    )
    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "company",
            "company_id": "acme.registry",
            "version": "2.0.0",
            "package_digest": digest_company,
            "status": "published",
            "trust": "official",
            "name": "Acme Registry Co",
        },
    )

    resolution = resolve_catalog(cloud_root=cloud_root, companies_root=tmp_path / "missing-companies")
    payload = resolution.to_dict()
    by_key = {(item["kind"], item["plugin_id"]): item for item in payload["items"]}

    assert by_key[("plugin", "dev.superclaw.registry-plugin")]["package_digest"] == digest_plugin
    assert by_key[("plugin", "dev.superclaw.registry-plugin")]["pinned_digest"] == digest_plugin
    assert by_key[("plugin", "dev.superclaw.registry-plugin")]["digest_pinned"] is True
    assert by_key[("plugin", "dev.superclaw.registry-plugin")]["entitlement_state"] == "required"
    assert by_key[("plugin", "dev.superclaw.registry-plugin")]["trust"] == "developer"
    assert by_key[("skill", "skill.registry-coach")]["skill_origin"] is True
    assert by_key[("skill", "skill.registry-coach")]["sources"] == ["registry", "capability_registry"]
    assert by_key[("company", "acme.registry")]["trust"] == "official"
    # D3 PR-2/PR-5 (G1): company `instantiable` is DERIVED, and a REGISTRY-ONLY company
    # (no local source directory) is NOT instantiable even when official — the
    # verify-before-instantiate gate needs a local source path the registry row cannot
    # provide, so offering it would badge an action that always 404s. instantiable for
    # company comes only from a local-dir source.
    assert by_key[("company", "acme.registry")]["instantiable"] is False


def test_capability_registry_rejects_digest_overwrite_and_fetches_without_network(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "plugin",
            "plugin_id": "dev.superclaw.registry-plugin",
            "version": "1.0.0",
            "package_digest": "sha256:" + "1" * 64,
            "status": "approved",
        },
    )

    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "plugin",
            "plugin_id": "dev.superclaw.registry-plugin",
            "version": "1.0.0",
            "package_digest": "sha256:" + "1" * 64,
            "status": "approved",
            "summary": "Idempotent metadata refresh.",
        },
    )
    with pytest.raises(CapabilityRegistryError, match="different digest"):
        publish_capability_registry_entry(
            cloud_root,
            {
                "kind": "plugin",
                "plugin_id": "dev.superclaw.registry-plugin",
                "version": "1.0.0",
                "package_digest": "sha256:" + "2" * 64,
                "status": "approved",
            },
        )

    client = CapabilityRegistryClient(
        "https://clawhunt.invalid/admin/capabilities.json",
        fetch_json=lambda _url: {
            "entries": [
                {
                    "kind": "company",
                    "company_id": "acme.fetched",
                    "version": "1.0.0",
                    "package_digest": "sha256:" + "3" * 64,
                    "status": "approved",
                }
            ]
        },
    )

    assert client.load()[0].capability_id == "acme.fetched"


def test_capability_registry_consumes_clawhunt_admin_registry_shape(tmp_path: Path):
    active_digest = "e" * 64
    replaced_digest = "f" * 64
    registry_file = tmp_path / "clawhunt-admin-registry.json"
    registry_file.write_text(
        json.dumps(
            [
                {
                    "kind": "plugin",
                    "capability_id": "dev.superclaw.clawhunt-plugin",
                    "version": "1.0.0",
                    "sha256_digest": active_digest,
                    "status": "active",
                    "artifact": {"sha256_digest": active_digest, "storage_path": f"sha256/{active_digest[:2]}/{active_digest}"},
                },
                {
                    "kind": "skill",
                    "capability_id": "skill.clawhunt-replaced",
                    "version": "0.9.0",
                    "sha256_digest": replaced_digest,
                    "status": "replaced",
                    "replacement_registry_id": 12,
                },
            ],
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    entries = CapabilityRegistryClient(registry_file).load()
    by_id = {entry.capability_id: entry for entry in entries}

    assert by_id["dev.superclaw.clawhunt-plugin"].digest == f"sha256:{active_digest}"
    assert by_id["dev.superclaw.clawhunt-plugin"].status == "active"
    assert by_id["skill.clawhunt-replaced"].digest == f"sha256:{replaced_digest}"
    assert by_id["skill.clawhunt-replaced"].revoked is True


def test_catalog_hides_revoked_registry_entries_by_default(tmp_path: Path):
    digest = "sha256:" + "d" * 64
    cloud_root = tmp_path / "cloud"
    publish_capability_registry_entry(
        cloud_root,
        {
            "kind": "plugin",
            "plugin_id": "dev.superclaw.revoked-registry",
            "version": "9.9.9",
            "package_digest": digest,
            "status": "revoked",
            "revocation": {"reason": "broken_runtime", "sequence": 42},
        },
    )

    default_resolution = resolve_catalog(kind="plugin", cloud_root=cloud_root)
    include_revoked = resolve_catalog(kind="plugin", cloud_root=cloud_root, include_revoked=True).to_dict()

    assert [item.plugin_id for item in default_resolution.items] == []
    item = include_revoked["items"][0]
    assert item["plugin_id"] == "dev.superclaw.revoked-registry"
    assert item["revoked"] is True
    assert item["trust"] == "untrusted"
    assert item["trust_reasons"] == ["revoked"]
    assert item["revocation"] == {"reason": "broken_runtime", "sequence": 42}


def test_catalog_resolver_uses_delegated_developer_registry_metadata(tmp_path: Path, monkeypatch):
    root_private, root_public = _keypair()
    developer_private, developer_public = _keypair()
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    cache_root = tmp_path / "cache"
    cloud_root = tmp_path / "cloud"
    registry_root = tmp_path / "registry"
    plugin_dir = _copy_plugin(tmp_path)
    digest = _sign_plugin(plugin_dir, developer_private)
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    _write_registry_trust_bundle(
        registry_root,
        root_private=root_private,
        root_public=root_public,
        developer_public=developer_public,
        target_id="dev.superclaw.hello-world",
        target_version="0.1.0",
        target_digest=digest,
    )

    resolution = resolve_catalog(
        kind="plugin",
        cache_root=cache_root,
        cloud_root=cloud_root,
        registry_root=registry_root,
        public_key=root_public,
    )
    item = resolution.items[0]

    assert item.plugin_id == "dev.superclaw.hello-world"
    assert item.trust.value == "developer"
    assert item.signer_class == "developer:dev-key"
    assert resolution.watermark_sequence == 1
    assert resolution.registry_freshness["fresh"] is True


def test_catalog_resolver_uses_delegated_company_registry_metadata(tmp_path: Path, monkeypatch):
    root_private, root_public = _keypair()
    developer_private, developer_public = _keypair()
    monkeypatch.delenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", raising=False)
    registry_root = tmp_path / "registry"
    companies_root = tmp_path / "companies"
    _company_dir, digest = _write_signed_company(companies_root, private_key=developer_private)
    _write_registry_trust_bundle(
        registry_root,
        root_private=root_private,
        root_public=root_public,
        developer_public=developer_public,
        target_id="acme.delivery",
        target_version="1.0.0",
        target_digest=digest,
        target_kind="company",
        developer_paths=["acme.*"],
    )

    resolution = resolve_catalog(
        kind="company",
        companies_root=companies_root,
        registry_root=registry_root,
        public_key=root_public,
    )
    item = resolution.items[0]

    assert item.plugin_id == "acme.delivery"
    assert item.trust.value == "developer"
    assert item.signer_class == "developer:dev-key"


def test_catalog_resolver_propagates_registry_rollback_into_trust_state(tmp_path: Path, monkeypatch):
    root_private, root_public = _keypair()
    plugin_private, plugin_public = _keypair()
    _developer_private, developer_public = _keypair()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", plugin_public)
    cache_root = tmp_path / "cache"
    cloud_root = tmp_path / "cloud"
    registry_root = tmp_path / "registry"
    plugin_dir = _copy_plugin(tmp_path)
    digest = _sign_plugin(plugin_dir, plugin_private)
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    registry_root.mkdir(parents=True)
    (registry_root / "trust-state.json").write_text(json.dumps({"watermark_sequence": 5}), encoding="utf-8")
    _write_registry_trust_bundle(
        registry_root,
        root_private=root_private,
        root_public=root_public,
        developer_public=developer_public,
        target_id="dev.superclaw.hello-world",
        target_version="0.1.0",
        target_digest=digest,
        sequence=4,
    )

    resolution = resolve_catalog(
        kind="plugin",
        cache_root=cache_root,
        cloud_root=cloud_root,
        registry_root=registry_root,
        public_key=root_public,
    )
    item = resolution.items[0]

    assert resolution.watermark_sequence == 5
    assert resolution.registry_freshness["fresh"] is False
    assert "rollback" in resolution.registry_freshness["stale_reason"]
    assert item.trust.value == "untrusted"
    assert item.trust_reasons == ("sequence_rollback",)


def test_catalog_local_discovery_reuses_fail_closed_gate(tmp_path: Path, monkeypatch):
    private_key, public_key = _keypair()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    cache_root = tmp_path / "cache"
    _cache_signed_plugin(tmp_path, cache_root=cache_root, fixture="github-scanner", private_key=private_key, public_key=public_key)

    resolution = resolve_catalog(cache_root=cache_root, cloud_root=tmp_path / "empty-cloud")

    assert resolution.items == ()


def test_catalog_reports_same_id_different_signer_conflict(tmp_path: Path, monkeypatch):
    root_key, root_public = _keypair()
    dev_key, dev_public = _keypair()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", root_public)
    cache_root = tmp_path / "cache"
    _cache_signed_plugin(
        tmp_path,
        cache_root=cache_root,
        version="0.1.0",
        private_key=root_key,
        public_key=root_public,
        target_name="official",
    )
    _cache_signed_plugin(
        tmp_path,
        cache_root=cache_root,
        version="0.2.0",
        private_key=dev_key,
        public_key=dev_public,
        target_name="developer",
    )

    result = CliRunner().invoke(app, ["catalog", "resolve", "--cache-root", str(cache_root), "--public-key", dev_public, "--json"])
    payload = json.loads(result.output)

    assert result.exit_code == 0, result.output
    assert payload["items"] == []
    assert payload["conflicts"][0]["reason"] == "same_id_different_signer"
    assert payload["conflicts"][0]["plugin_id"] == "dev.superclaw.hello-world"


def test_catalog_list_filters_kind_and_trust_state_cli(tmp_path: Path, monkeypatch):
    private_key, public_key = _keypair()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    cache_root = tmp_path / "cache"
    _cache_signed_plugin(tmp_path, cache_root=cache_root, private_key=private_key, public_key=public_key)

    listed = CliRunner().invoke(app, ["catalog", "list", "--kind", "plugin", "--cache-root", str(cache_root), "--json"])
    trusted = CliRunner().invoke(
        app,
        ["trust", "state", "dev.superclaw.hello-world@0.1.0", "--cache-root", str(cache_root), "--json"],
    )

    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["items"][0]["plugin_id"] == "dev.superclaw.hello-world"
    assert trusted.exit_code == 0, trusted.output
    payload = json.loads(trusted.output)
    assert payload["trust"] == "official"
    assert payload["signer_class"] == "root"


def test_catalog_refresh_fails_closed_and_keeps_cached_registry(tmp_path: Path):
    result = CliRunner().invoke(
        app,
        ["catalog", "refresh", "--registry-root", str(tmp_path / "registry"), "--source-url", "https://example.invalid/tuf", "--json"],
    )

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["kept_cached"] is True


def test_resolve_trust_state_missing_item_is_untrusted(tmp_path: Path):
    derivation = resolve_trust_state("dev.missing.tool", "9.9.9", cache_root=tmp_path / "cache", cloud_root=tmp_path / "cloud")

    assert derivation.state.value == "untrusted"
    assert "integrity_failed" in derivation.reasons
