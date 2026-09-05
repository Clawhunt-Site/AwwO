from __future__ import annotations

import base64
import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.models import ArtifactRef, EvidenceBundle, WorkerResult
from superclaw.plugin_cloud import (
    MAX_OFFLINE_GRACE_SECONDS,
    PluginCloudSyncError,
    _registry_metadata_path,
    copy_package_into_fake_registry,
    install_plugin_from_cloud_metadata,
    store_evidence_summary,
    sync_cloud_governance,
    sync_entitlements_for_device,
    upload_evidence_summary,
)
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import compute_package_digest, list_cached_plugins, load_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _parse_z(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _copy_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


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


def _write_sidecar(plugin_dir: Path, script_name: str, body: str) -> None:
    script = plugin_dir / "bin" / script_name
    script.write_text(body, encoding="utf-8")
    script.chmod(0o755)


def _write_registry_metadata(cloud_root: Path, plugin_dir: Path, plugin_id: str, version: str, digest: str) -> Path:
    package_path = copy_package_into_fake_registry(plugin_dir, cloud_root, plugin_id, version)
    metadata_path = package_path.parent / "metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "plugin_id": plugin_id,
                "version": version,
                "package_digest": digest,
                "package_path": "package",
                "compatibility": {"superclaw": ">=0.1.0"},
                "entitlement_required": plugin_id.endswith("github-scanner"),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return metadata_path


def _safe_invocation_summary() -> dict[str, object]:
    return {
        "run_id": "run_1",
        "plugin_id": "dev.superclaw.hello-world",
        "plugin_version": "0.1.0",
        "package_digest": "sha256:" + "1" * 64,
        "tool_name": "hello_world",
        "started_at": "2026-05-31T00:00:00Z",
        "finished_at": "2026-05-31T00:00:01Z",
        "status": "ok",
        "entitlement_id": None,
        "input_digest": "sha256:" + "2" * 64,
        "output_digest": "sha256:" + "3" * 64,
        "evidence_artifact_id": "artifact_1",
    }


def _signed_registry_fixture(tmp_path: Path, name: str) -> tuple[Path, Path, str, str]:
    plugin_dir = _copy_fixture(tmp_path, name)
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    manifest = json.loads((plugin_dir / "superclaw-plugin.json").read_text(encoding="utf-8"))
    _write_registry_metadata(cloud_root, plugin_dir, manifest["id"], manifest["version"], digest)
    return cloud_root, plugin_dir, public_key, digest


def test_cloud_install_verifies_registry_metadata_and_caches_plugin(tmp_path: Path):
    cloud_root, _plugin_dir, public_key, digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"

    result = install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.hello-world",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )

    assert result.digest == digest
    cached = list_cached_plugins(cache_root=cache_root)
    assert cached == [
        {
            "id": "dev.superclaw.hello-world",
            "version": "0.1.0",
            "name": "Hello World",
            "path": str(cache_root / "dev.superclaw.hello-world" / "0.1.0"),
            "skill_origin": False,
        }
    ]


def test_cloud_install_refuses_skill_origin_via_plugin_pipeline(tmp_path: Path):
    # Red line (capability-workshop): a skill-origin registry entry must NEVER install
    # via the plugin pipeline. This kernel entry is what BOTH REST /api/plugins/install
    # and CLI `plugin install` / `plugin cloud-install` route through, so refusing here
    # covers them all via the single source (is_skill_origin_plugin) — not just web-UI
    # guards. The guard fires BEFORE package verification.
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "hello-world")
    metadata_path = _registry_metadata_path(cloud_root, "dev.superclaw.hello-world", "0.1.0")
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    meta["skill_origin"] = True
    metadata_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(PluginCloudSyncError, match="skill capability"):
        install_plugin_from_cloud_metadata(
            cloud_root,
            "dev.superclaw.hello-world",
            "0.1.0",
            public_key=public_key,
            cache_root=tmp_path / "cache",
        )


def test_cloud_install_refuses_skill_origin_manifest_even_when_feed_says_plugin(tmp_path: Path):
    # MANIFEST-layer red line (capability-workshop): the registry feed metadata is
    # untrusted/driftable — the authoritative signal is the SIGNED package manifest.
    # Here the metadata does NOT advertise skill_origin and the id is non-"skill.",
    # so the metadata-level guard CANNOT fire; only the reject_skill_origin manifest
    # backstop in verify_plugin_package catches a package whose signed manifest is
    # skill_origin:true. This is the exact "feed says plugin, manifest says skill"
    # drift, and it must fail closed BEFORE the cache write.
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    private_key, public_key = _keypair()
    # Bake skill_origin:true INTO the manifest so it is signed into the digest.
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["skill_origin"] = True
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    # Feed advertises a plain plugin (no skill_origin) with a non-"skill." id, so the
    # feed-level guard is bypassed by construction — only the manifest backstop is left.
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    cache_root = tmp_path / "cache"

    with pytest.raises(PluginCloudSyncError, match="skill capability"):
        install_plugin_from_cloud_metadata(
            cloud_root,
            "dev.superclaw.hello-world",
            "0.1.0",
            public_key=public_key,
            cache_root=cache_root,
        )
    # Nothing was cached: the manifest backstop fired before the cache write.
    assert list_cached_plugins(cache_root=cache_root) == []


def test_cloud_install_refuses_digest_mismatch_without_caching(tmp_path: Path):
    # F2 (Codex R8): registry install PROBES with cache=False, binds digest/identity,
    # and only THEN commits with cache=True. A digest mismatch is refused at the probe,
    # so nothing is ever written to the cache (no debris — and, per the next test, no
    # risk of clobbering a pre-existing good install).
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "hello-world")
    # Corrupt the registry metadata digest so the bind check fails.
    metadata_path = _registry_metadata_path(cloud_root, "dev.superclaw.hello-world", "0.1.0")
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    meta["package_digest"] = "sha256:" + "0" * 64
    metadata_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    cache_root = tmp_path / "cache"

    with pytest.raises(PluginCloudSyncError, match="digest mismatch"):
        install_plugin_from_cloud_metadata(
            cloud_root,
            "dev.superclaw.hello-world",
            "0.1.0",
            public_key=public_key,
            cache_root=cache_root,
        )
    # Refused at the probe (cache=False): nothing was ever cached.
    assert list_cached_plugins(cache_root=cache_root) == []


def test_cloud_install_mismatch_preserves_prior_good_install(tmp_path: Path):
    # F2 (Codex R8), the core attack: a digest-mismatched re-install of an ALREADY
    # cached id/version must NOT clobber the good copy. probe->commit catches the
    # mismatch BEFORE any cache write, so the prior good install survives intact. (A
    # cache=True + post-write rollback would have deleted the overwritten good entry —
    # exactly the collateral damage Codex flagged.)
    cloud_root, _plugin_dir, public_key, _good_digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"
    # First: a clean, good install of 0.1.0.
    install_plugin_from_cloud_metadata(
        cloud_root, "dev.superclaw.hello-world", "0.1.0", public_key=public_key, cache_root=cache_root
    )
    assert [p["id"] for p in list_cached_plugins(cache_root=cache_root)] == ["dev.superclaw.hello-world"]
    # Now corrupt the metadata digest and re-install the SAME id/version.
    metadata_path = _registry_metadata_path(cloud_root, "dev.superclaw.hello-world", "0.1.0")
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    meta["package_digest"] = "sha256:" + "0" * 64
    metadata_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with pytest.raises(PluginCloudSyncError, match="digest mismatch"):
        install_plugin_from_cloud_metadata(
            cloud_root, "dev.superclaw.hello-world", "0.1.0", public_key=public_key, cache_root=cache_root
        )
    # The prior GOOD install is untouched — still cached at its id/version.
    assert [p["id"] for p in list_cached_plugins(cache_root=cache_root)] == ["dev.superclaw.hello-world"]


def test_fake_registry_publish_rejects_same_version_digest_overwrite(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    private_key, _public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"

    first = copy_package_into_fake_registry(plugin_dir, cloud_root, "dev.superclaw.hello-world", "0.1.0")
    second = copy_package_into_fake_registry(plugin_dir, cloud_root, "dev.superclaw.hello-world", "0.1.0")

    assert second == first
    _write_sidecar(plugin_dir, "hello-world", "#!/usr/bin/env sh\nprintf '%s\\n' changed\n")

    with pytest.raises(PluginCloudSyncError, match="different digest"):
        copy_package_into_fake_registry(plugin_dir, cloud_root, "dev.superclaw.hello-world", "0.1.0")


def test_synced_expired_entitlement_blocks_cached_paid_plugin_before_sidecar(tmp_path: Path):
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "github-scanner")
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    expired = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_expired",
                        "expires_at": expired,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=sync.entitlement_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_ENTITLEMENT_EXPIRED"


def test_cloud_sync_clamps_offline_entitlement_grace_to_platform_max(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_grace",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "offline_grace_seconds": MAX_OFFLINE_GRACE_SECONDS * 10,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    entitlement = json.loads(sync.entitlement_file.read_text(encoding="utf-8"))["entitlements"][0]
    synced_at = _parse_z(entitlement["synced_at"])
    grace_expires_at = _parse_z(entitlement["offline_grace_expires_at"])
    assert grace_expires_at - synced_at <= timedelta(seconds=MAX_OFFLINE_GRACE_SECONDS)
    assert grace_expires_at - synced_at > timedelta(hours=71)
    assert "token" not in entitlement


def test_entitlement_sync_token_is_scoped_and_grace_capped(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_device",
                        "subject": "user_fixture",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "offline_grace_seconds": MAX_OFFLINE_GRACE_SECONDS * 2,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = sync_entitlements_for_device(
        cloud_root,
        device_id="device_1",
        runtime_version="0.1.0",
        plugin_ids=["dev.superclaw.github-scanner"],
    )

    entitlement = payload["entitlements"][0]
    synced_at = _parse_z(entitlement["synced_at"])
    grace_expires_at = _parse_z(entitlement["offline_grace_expires_at"])
    assert entitlement["device_id"] == "device_1"
    assert entitlement["runtime_version"] == "0.1.0"
    assert entitlement["version_range"] == "=0.1.0"
    assert entitlement["token"].startswith("local-entitlement.")
    assert grace_expires_at - synced_at <= timedelta(seconds=MAX_OFFLINE_GRACE_SECONDS)


def test_policy_high_risk_disables_offline_entitlement_grace(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_high_risk",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "offline_grace_seconds": MAX_OFFLINE_GRACE_SECONDS,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.github-scanner", "version": "0.1.0", "risk_level": "high"}]}),
        encoding="utf-8",
    )

    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    entitlement = json.loads(sync.entitlement_file.read_text(encoding="utf-8"))["entitlements"][0]
    assert entitlement["offline_grace_disabled_reason"] == "policy_high_risk"
    assert entitlement["offline_grace_expires_at"] == entitlement["synced_at"]
    assert "token" not in entitlement


def test_live_metering_entitlement_disables_offline_grace_token(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_live_metered",
                        "subject": "user_fixture",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "requires_live_metering": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = sync_entitlements_for_device(
        cloud_root,
        device_id="device_1",
        runtime_version="0.1.0",
        plugin_ids=["dev.superclaw.github-scanner"],
    )

    entitlement = payload["entitlements"][0]
    assert entitlement["offline_grace_disabled_reason"] == "entitlement_requires_live_metering"
    assert entitlement["offline_grace_expires_at"] == entitlement["synced_at"]
    assert entitlement["token"].startswith("local-entitlement.")


def test_proxy_rejects_entitlement_grace_above_platform_max_before_sidecar(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "github-scanner")
    _write_sidecar(
        plugin_dir,
        "github-scanner",
        "#!/usr/bin/env sh\nset -eu\ntouch sidecar-ran\nprintf '%s\\n' '{\"text\":\"sidecar ran\",\"artifacts\":[]}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.github-scanner", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    entitlement_file = tmp_path / "entitlements.json"
    now = datetime.now(UTC)
    entitlement_file.write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_overlong",
                        "expires_at": (now + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "synced_at": now.isoformat().replace("+00:00", "Z"),
                        "offline_grace_expires_at": (now + timedelta(days=10)).isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=entitlement_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_ENTITLEMENT_EXPIRED"
    assert not (cache_root / "dev.superclaw.github-scanner" / "0.1.0" / "sidecar-ran").exists()


def test_proxy_accepts_matching_entitlement_version_range(tmp_path: Path):
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "github-scanner")
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    now = datetime.now(UTC)
    entitlement_file = tmp_path / "entitlements.json"
    entitlement_file.write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version_range": ">=0.1.0 <0.2.0",
                        "entitlement_id": "ent_matching_range",
                        "expires_at": (now + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
                        "synced_at": now.isoformat().replace("+00:00", "Z"),
                        "offline_grace_expires_at": (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=entitlement_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is True
    assert result.evidence_record["entitlement_id"] == "ent_matching_range"


def test_proxy_requires_entitlement_version_range_to_match_before_sidecar(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "github-scanner")
    _write_sidecar(
        plugin_dir,
        "github-scanner",
        "#!/usr/bin/env sh\nset -eu\ntouch sidecar-ran\nprintf '%s\\n' '{\"text\":\"sidecar ran\",\"artifacts\":[]}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.github-scanner", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    now = datetime.now(UTC)
    entitlement_file = tmp_path / "entitlements.json"
    entitlement_file.write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version_range": ">=0.2.0 <0.3.0",
                        "entitlement_id": "ent_wrong_range",
                        "expires_at": (now + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
                        "synced_at": now.isoformat().replace("+00:00", "Z"),
                        "offline_grace_expires_at": (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=entitlement_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_ENTITLEMENT_MISSING"
    assert not (cache_root / "dev.superclaw.github-scanner" / "0.1.0" / "sidecar-ran").exists()


def test_synced_revocation_blocks_already_cached_plugin(tmp_path: Path):
    cloud_root, _plugin_dir, public_key, digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.hello-world",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "revocations.json").write_text(
        json.dumps(
            {
                "revoked": [
                    {
                        "plugin_id": "dev.superclaw.hello-world",
                        "version": "0.1.0",
                        "package_digest": digest,
                        "reason": "broken_runtime",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")
    synced_revocation = json.loads(sync.revocation_file.read_text(encoding="utf-8"))["revoked"][0]
    assert synced_revocation["reason"] == "broken_runtime"

    result = invoke_cached_plugin_tool(
        "dev.superclaw.hello-world",
        "hello_world",
        {"name": "Ada"},
        cache_root=cache_root,
        public_key=public_key,
        revocation_file=sync.revocation_file,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_REVOKED"


def test_cloud_sync_rejects_revocation_without_required_reason_code(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    revocation_file = governance_root / "revocations.json"
    revocation_file.write_text(
        json.dumps({"revoked": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0"}]}),
        encoding="utf-8",
    )

    with pytest.raises(PluginCloudSyncError, match="revocation reason"):
        sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    revocation_file.write_text(
        json.dumps({"revoked": [{"plugin_id": "dev.superclaw.hello-world", "reason": "unknown"}]}),
        encoding="utf-8",
    )

    with pytest.raises(PluginCloudSyncError, match="revocation reason"):
        sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")


def test_offline_grace_disabled_policy_blocks_cached_paid_plugin_before_sidecar(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "github-scanner")
    _write_sidecar(
        plugin_dir,
        "github-scanner",
        "#!/usr/bin/env sh\nset -eu\ntouch sidecar-ran\nprintf '%s\\n' '{\"text\":\"sidecar ran\",\"artifacts\":[]}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.github-scanner", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_no_offline",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.github-scanner", "version": "0.1.0", "offline_grace_allowed": False}]}),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=sync.entitlement_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_ENTITLEMENT_EXPIRED"
    assert not (cache_root / "dev.superclaw.github-scanner" / "0.1.0" / "sidecar-ran").exists()


def test_policy_sync_updates_runtime_policy_without_secret_values(tmp_path: Path):
    cloud_root = tmp_path / "cloud"
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "runtime-policy.json").write_text(
        json.dumps(
            {
                "policies": [
                    {
                        "plugin_id": "dev.superclaw.hello-world",
                        "version": "0.1.0",
                        "max_model_output_bytes": 1024,
                        "max_tool_timeout_ms": 250,
                        "minimum_runtime_version": "0.2.0",
                        "denylisted_permissions": ["network:*"],
                        "secret_descriptors": [{"name": "GITHUB_TOKEN", "required": True}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    policy = json.loads(sync.policy_file.read_text(encoding="utf-8"))
    assert policy["policies"][0]["max_model_output_bytes"] == 1024
    assert policy["policies"][0]["max_tool_timeout_ms"] == 250
    assert policy["policies"][0]["minimum_runtime_version"] == "0.2.0"
    assert policy["policies"][0]["denylisted_permissions"] == ["network:*"]
    assert "secret_values" not in json.dumps(policy)
    assert "private_key" not in json.dumps(policy)


def test_synced_policy_denylist_blocks_sidecar_before_execution(tmp_path: Path):
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "github-scanner")
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.github-scanner",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_valid",
                        "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.github-scanner", "version": "0.1.0", "denylisted_permissions": ["network:*"]}]}),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=sync.entitlement_file,
        policy_file=sync.policy_file,
        environment={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"},
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_PERMISSION_DENIED"
    assert result.model_response["error"]["retryable"] is False
    assert result.evidence_record["status"] == "denied"
    assert result.evidence_record["sandbox_exit_status"] is None
    assert result.evidence_record["policy_decision"].startswith("PLUGIN_PERMISSION_DENIED")
    assert result.evidence_artifact is not None


def test_synced_policy_max_output_size_tightens_proxy_model_output(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    _write_sidecar(
        plugin_dir,
        "hello-world",
        "#!/usr/bin/env sh\nset -eu\nprintf '%s\\n' '{\"text\":\"" + ("x" * 200) + "\"}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.hello-world",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0", "max_model_output_bytes": 40}]}),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.hello-world",
        "hello_world",
        {"name": "Ada"},
        cache_root=cache_root,
        public_key=public_key,
        policy_file=sync.policy_file,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is True
    assert len(result.model_response["text"]) < 200
    assert len(json.dumps(result.model_response, separators=(",", ":")).encode("utf-8")) <= 40


def test_synced_policy_minimum_runtime_version_blocks_sidecar_before_execution(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    _write_sidecar(
        plugin_dir,
        "hello-world",
        "#!/usr/bin/env sh\nset -eu\ntouch sidecar-ran\nprintf '%s\\n' '{\"text\":\"sidecar ran\",\"artifacts\":[]}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.hello-world",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0", "minimum_runtime_version": "0.2.0"}]}),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.hello-world",
        "hello_world",
        {"name": "Ada"},
        cache_root=cache_root,
        public_key=public_key,
        policy_file=sync.policy_file,
        runtime_version="0.1.0",
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_PERMISSION_DENIED"
    assert result.evidence_record["status"] == "denied"
    assert result.evidence_record["sandbox_exit_status"] is None
    assert "runtime version below policy minimum" in result.evidence_record["policy_decision"]
    assert not (cache_root / "dev.superclaw.hello-world" / "0.1.0" / "sidecar-ran").exists()


def test_synced_policy_max_tool_timeout_tightens_sidecar_timeout(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    _write_sidecar(
        plugin_dir,
        "hello-world",
        "#!/usr/bin/env sh\nset -eu\nsleep 2\ntouch sidecar-finished\nprintf '%s\\n' '{\"text\":\"finished\",\"artifacts\":[]}'\n",
    )
    private_key, public_key = _keypair()
    digest = _sign_plugin(plugin_dir, private_key)
    cloud_root = tmp_path / "cloud"
    _write_registry_metadata(cloud_root, plugin_dir, "dev.superclaw.hello-world", "0.1.0", digest)
    cache_root = tmp_path / "cache"
    install_plugin_from_cloud_metadata(
        cloud_root,
        "dev.superclaw.hello-world",
        "0.1.0",
        public_key=public_key,
        cache_root=cache_root,
    )
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0", "max_tool_timeout_ms": 100}]}),
        encoding="utf-8",
    )
    sync = sync_cloud_governance(cloud_root, local_state_root=tmp_path / "state")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.hello-world",
        "hello_world",
        {"name": "Ada"},
        cache_root=cache_root,
        public_key=public_key,
        policy_file=sync.policy_file,
        artifact_dir=tmp_path / "artifacts",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_TIMEOUT"
    assert result.evidence_record["status"] == "timeout"
    assert result.evidence_record["sandbox_exit_status"] is None
    assert not (cache_root / "dev.superclaw.hello-world" / "0.1.0" / "sidecar-finished").exists()


def test_evidence_summary_upload_omits_raw_outputs_and_workspace_paths(tmp_path: Path):
    evidence = EvidenceBundle(run_id="run_cloud_upload")
    evidence.add_command("cat /Users/leongong/Documents/superClaw/private.txt", 0, "raw secret output ghp_abcdefghijklmnop")
    evidence.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="codex",
            command="pytest",
            exit_code=0,
            output="full workspace transcript /Users/leongong/Documents/superClaw",
            duration_seconds=1.0,
            artifact_path="/Users/leongong/Documents/superClaw/.superclaw/raw.log",
        )
    )
    evidence.add_artifact(
        ArtifactRef(
            kind="plugin-invocation",
            path="/Users/leongong/Documents/superClaw/.superclaw/artifacts/plugin.json",
            metadata={"plugin_id": "dev.superclaw.hello-world", "tool_name": "hello_world"},
        )
    )
    evidence.add_probe(
        "plugin_invocation",
        200,
        {
            "plugin_id": "dev.superclaw.hello-world",
            "plugin_version": "0.1.0",
            "package_digest": "sha256:" + "1" * 64,
            "entitlement_id": "ent_test",
            "raw_output": "should not be uploaded",
        },
    )
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(evidence.to_dict(), indent=2, sort_keys=True), encoding="utf-8")

    result = upload_evidence_summary(evidence_path, cloud_root=tmp_path / "cloud")

    summary_text = result.summary_path.read_text(encoding="utf-8")
    summary = json.loads(summary_text)
    assert summary["counts"] == {"commands": 1, "worker_results": 1, "probes": 1, "artifacts": 1, "findings": 0}
    assert summary["probes"][0]["plugin_id"] == "dev.superclaw.hello-world"
    assert "raw secret output" not in summary_text
    assert "should not be uploaded" not in summary_text
    assert "/Users/leongong/Documents/superClaw" not in summary_text
    assert "ghp_abcdefghijklmnop" not in summary_text
    assert "output_digest" in summary_text


def test_store_evidence_summary_requires_minimum_invocation_contract(tmp_path: Path):
    result = store_evidence_summary(_safe_invocation_summary(), cloud_root=tmp_path / "cloud")
    saved = json.loads(result.summary_path.read_text(encoding="utf-8"))
    assert saved["plugin_id"] == "dev.superclaw.hello-world"
    assert saved["entitlement_id"] is None

    missing = _safe_invocation_summary()
    missing.pop("started_at")
    with pytest.raises(PluginCloudSyncError, match="missing required fields: started_at"):
        store_evidence_summary(missing, cloud_root=tmp_path / "cloud")

    bad_digest = {**_safe_invocation_summary(), "input_digest": "sha256:not-a-digest"}
    with pytest.raises(PluginCloudSyncError, match="input_digest"):
        store_evidence_summary(bad_digest, cloud_root=tmp_path / "cloud")

    bad_window = {
        **_safe_invocation_summary(),
        "started_at": "2026-05-31T00:00:02Z",
        "finished_at": "2026-05-31T00:00:01Z",
    }
    with pytest.raises(PluginCloudSyncError, match="finished_at"):
        store_evidence_summary(bad_window, cloud_root=tmp_path / "cloud")


def test_cloud_cli_sync_install_and_upload_do_not_expose_cache_paths(tmp_path: Path, monkeypatch):
    cloud_root, _plugin_dir, public_key, _digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    runner = CliRunner()

    install = runner.invoke(
        app,
        [
            "plugin",
            "cloud-install",
            "dev.superclaw.hello-world",
            "0.1.0",
            "--cloud-root",
            str(cloud_root),
            "--public-key",
            public_key,
            "--json",
        ],
    )

    assert install.exit_code == 0, install.output
    assert str(cache_root) not in install.output
    payload = json.loads(install.output)
    assert payload["installed"] is True

    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(EvidenceBundle(run_id="run_cli").to_dict()), encoding="utf-8")
    upload = runner.invoke(app, ["plugin", "evidence-upload-local", str(evidence_path), "--cloud-root", str(cloud_root), "--json"])

    assert upload.exit_code == 0, upload.output
    assert json.loads(upload.output)["ok"] is True


def test_plugin_search_cli_returns_sanitized_registry_matches(tmp_path: Path, monkeypatch):
    cloud_root, _plugin_dir, _public_key, _digest = _signed_registry_fixture(tmp_path, "hello-world")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    runner = CliRunner()

    search = runner.invoke(app, ["plugin", "search", "hello", "--runtime", "mcp_sidecar", "--json"])
    payload = json.loads(search.output)
    joined = json.dumps(payload, sort_keys=True)

    assert search.exit_code == 0, search.output
    assert payload["ok"] is True
    assert payload["plugins"][0]["plugin_id"] == "dev.superclaw.hello-world"
    assert payload["plugins"][0]["version"] == "0.1.0"
    assert str(cloud_root) not in joined
    assert "package_path" not in joined
    assert "bin/hello-world" not in joined


def test_plugin_install_alias_resolves_latest_and_hides_cache_paths(tmp_path: Path, monkeypatch):
    cloud_root, _plugin_dir, public_key, digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    runner = CliRunner()

    install = runner.invoke(app, ["plugin", "install", "dev.superclaw.hello-world", "--public-key", public_key, "--json"])
    payload = json.loads(install.output)

    assert install.exit_code == 0, install.output
    assert payload == {
        "ok": True,
        "plugin_id": "dev.superclaw.hello-world",
        "version": "0.1.0",
        "digest": digest,
        "installed": True,
    }
    assert str(cache_root) not in install.output
    assert list_cached_plugins(cache_root=cache_root)[0]["id"] == "dev.superclaw.hello-world"


def test_plugin_install_alias_accepts_explicit_version_ref(tmp_path: Path, monkeypatch):
    cloud_root, _plugin_dir, public_key, digest = _signed_registry_fixture(tmp_path, "hello-world")
    cache_root = tmp_path / "cache"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    runner = CliRunner()

    install = runner.invoke(app, ["plugin", "install", "dev.superclaw.hello-world@0.1.0", "--public-key", public_key, "--json"])
    payload = json.loads(install.output)

    assert install.exit_code == 0, install.output
    assert payload["plugin_id"] == "dev.superclaw.hello-world"
    assert payload["version"] == "0.1.0"
    assert payload["digest"] == digest
    assert str(cache_root) not in install.output


def test_plugin_install_fails_closed_for_missing_registry_plugin(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(tmp_path / "cloud"))
    runner = CliRunner()

    install = runner.invoke(app, ["plugin", "install", "dev.superclaw.missing", "--public-key", "bad", "--json"])
    payload = json.loads(install.output)

    assert install.exit_code == 1
    assert payload["ok"] is False
    assert "plugin not found in registry" in payload["error"]


def test_cloud_sync_governance_targets_gate_state_root(tmp_path, monkeypatch):
    """Regression: cloud-sync's governance write target IS the gate's read root.

    Guards the fail-closed hole where a cloud revocation synced to a cwd-relative
    copy was invisible to the user-global admission gate, letting a revoked plugin
    install. The synced files must land in the same directory the gate reads
    (``plugins.default_revocation_file`` / ``default_entitlement_file``),
    independent of the working directory cloud-sync runs from.
    """
    from superclaw import plugins
    from superclaw.plugin_cloud import local_plugin_state_root

    state_root = tmp_path / "global-plugin-state"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_STATE_ROOT", str(state_root))
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH", raising=False)

    governance = tmp_path / "fake-cloud" / "governance"
    governance.mkdir(parents=True)
    (governance / "revocations.json").write_text(
        json.dumps({"revoked": [{"plugin_id": "com.example.bad", "reason": "malware"}]}),
        encoding="utf-8",
    )

    # Run from an unrelated cwd to prove the write target is cwd-independent.
    work = tmp_path / "some-project"
    work.mkdir()
    monkeypatch.chdir(work)
    result = sync_cloud_governance(tmp_path / "fake-cloud")  # no explicit local_state_root

    # Write target == local-state resolver == the gate's revocation read path.
    assert local_plugin_state_root() == state_root
    assert plugins.default_revocation_file() == state_root / "revocations.json"
    synced = json.loads((state_root / "revocations.json").read_text(encoding="utf-8"))
    assert synced["revoked"][0]["plugin_id"] == "com.example.bad"
    assert result.revocation_count == 1
    # NOT written under the working directory (the pre-fix cwd-relative location).
    assert not (work / ".superclaw" / "plugins" / "revocations.json").exists()
