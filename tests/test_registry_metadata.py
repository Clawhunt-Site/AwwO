from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.registry_metadata import (
    RegistryMetadataError,
    assert_freshness_for_high_risk,
    load_registry_metadata,
    refresh_trust_registry,
)


NOW = datetime(2026, 6, 16, 12, 0, 0, tzinfo=UTC)


def _canonical(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign(private_key: Ed25519PrivateKey, payload: bytes) -> str:
    return "ed25519:" + base64.b64encode(private_key.sign(payload)).decode("ascii")


def _signed(signed: dict[str, Any], private_key: Ed25519PrivateKey, keyid: str) -> dict[str, Any]:
    return {"signed": signed, "signatures": [{"keyid": keyid, "signature": _sign(private_key, _canonical(signed))}]}


def _digest_doc(doc: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(doc["signed"])).hexdigest()


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_bundle(
    root: Path,
    *,
    root_private: Ed25519PrivateKey,
    root_public: str,
    timestamp_private: Ed25519PrivateKey,
    timestamp_public: str,
    snapshot_private: Ed25519PrivateKey,
    snapshot_public: str,
    targets_private: Ed25519PrivateKey,
    targets_public: str,
    developer_private: Ed25519PrivateKey,
    developer_public: str,
    expires_at: datetime | None = None,
    snapshot_sequence: int = 1,
    targets_sequence: int = 1,
    developer_paths: list[str] | None = None,
    target_id: str = "dev.acme.tool",
    target_digest: str = "sha256:" + "a" * 64,
) -> None:
    expires_at = expires_at or (NOW + timedelta(hours=1))
    targets = _signed(
        {
            "type": "targets",
            "sequence": targets_sequence,
            "delegations": {
                "developers": {
                    "dev-key": {
                        "public_key": developer_public,
                        "paths": developer_paths or ["dev.acme.*"],
                    }
                }
            },
            "targets": [
                {
                    "kind": "plugin",
                    "id": target_id,
                    "version": "0.1.0",
                    "digest": target_digest,
                    "signer_keyid": "dev-key",
                }
            ],
        },
        targets_private,
        "targets",
    )
    snapshot = _signed(
        {
            "type": "snapshot",
            "sequence": snapshot_sequence,
            "meta": {
                "targets.json": {
                    "version": targets_sequence,
                    "sha256": _digest_doc(targets),
                }
            },
        },
        snapshot_private,
        "snapshot",
    )
    timestamp = _signed(
        {
            "type": "timestamp",
            "sequence": snapshot_sequence,
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            "meta": {
                "snapshot.json": {
                    "version": snapshot_sequence,
                    "sha256": _digest_doc(snapshot),
                },
                "targets.json": {
                    "version": targets_sequence,
                    "sha256": _digest_doc(targets),
                },
            },
        },
        timestamp_private,
        "timestamp",
    )
    root_doc = _signed(
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
    for name, doc in {
        "root.json": root_doc,
        "timestamp.json": timestamp,
        "snapshot.json": snapshot,
        "targets.json": targets,
    }.items():
        _write_json(root / name, doc)


@pytest.fixture()
def registry_keys():
    root_private, root_public = _keypair()
    timestamp_private, timestamp_public = _keypair()
    snapshot_private, snapshot_public = _keypair()
    targets_private, targets_public = _keypair()
    developer_private, developer_public = _keypair()
    return {
        "root_private": root_private,
        "root_public": root_public,
        "timestamp_private": timestamp_private,
        "timestamp_public": timestamp_public,
        "snapshot_private": snapshot_private,
        "snapshot_public": snapshot_public,
        "targets_private": targets_private,
        "targets_public": targets_public,
        "developer_private": developer_private,
        "developer_public": developer_public,
    }


def test_refresh_trust_registry_verifies_bundle_and_writes_watermark(tmp_path: Path, registry_keys):
    source = tmp_path / "source"
    registry = tmp_path / "registry"
    _write_bundle(source, **registry_keys, snapshot_sequence=7)

    result = refresh_trust_registry(registry_root=registry, source_url=str(source), public_key=registry_keys["root_public"], now=NOW)
    state = load_registry_metadata(registry, public_key=registry_keys["root_public"], now=NOW)
    trust_state = json.loads((registry / "trust-state.json").read_text(encoding="utf-8"))

    assert result.ok is True
    assert result.kept_cached is False
    assert result.watermark_sequence == 7
    assert state is not None
    assert state.active_developer_keyids == frozenset({"dev-key"})
    assert trust_state["watermark_sequence"] == 7
    assert trust_state["fresh"] is True


def test_refresh_rejects_lower_sequence_without_clearing_cached_state(tmp_path: Path, registry_keys):
    source = tmp_path / "source"
    rollback = tmp_path / "rollback"
    registry = tmp_path / "registry"
    _write_bundle(source, **registry_keys, snapshot_sequence=5)
    _write_bundle(rollback, **registry_keys, snapshot_sequence=4)
    assert refresh_trust_registry(registry_root=registry, source_url=str(source), public_key=registry_keys["root_public"], now=NOW).ok

    result = refresh_trust_registry(registry_root=registry, source_url=str(rollback), public_key=registry_keys["root_public"], now=NOW)
    trust_state = json.loads((registry / "trust-state.json").read_text(encoding="utf-8"))

    assert result.ok is False
    assert result.kept_cached is True
    assert "rollback" in str(result.error)
    assert trust_state["watermark_sequence"] == 5


def test_expired_timestamp_fails_closed_for_high_risk(tmp_path: Path, registry_keys):
    registry = tmp_path / "registry"
    _write_bundle(registry, **registry_keys, expires_at=NOW - timedelta(minutes=1))
    state = load_registry_metadata(registry, public_key=registry_keys["root_public"], now=NOW)

    assert state is not None
    assert state.fresh is False
    assert state.stale_reason == "timestamp_expired"
    assert_freshness_for_high_risk(registry, high_risk=False, public_key=registry_keys["root_public"], now=NOW)
    with pytest.raises(RegistryMetadataError, match="timestamp_expired"):
        assert_freshness_for_high_risk(registry, high_risk=True, public_key=registry_keys["root_public"], now=NOW)


def test_developer_delegation_cannot_claim_reserved_namespace(tmp_path: Path, registry_keys):
    registry = tmp_path / "registry"
    _write_bundle(
        registry,
        **registry_keys,
        developer_paths=["superclaw.*"],
        target_id="superclaw.tool",
    )

    with pytest.raises(RegistryMetadataError, match="reserved namespace"):
        load_registry_metadata(registry, public_key=registry_keys["root_public"], now=NOW)


def test_offline_refresh_failure_keeps_cached_metadata(tmp_path: Path, registry_keys):
    source = tmp_path / "source"
    registry = tmp_path / "registry"
    _write_bundle(source, **registry_keys, snapshot_sequence=3)
    assert refresh_trust_registry(registry_root=registry, source_url=str(source), public_key=registry_keys["root_public"], now=NOW).ok

    result = refresh_trust_registry(
        registry_root=registry,
        source_url=str(tmp_path / "missing-source"),
        public_key=registry_keys["root_public"],
        now=NOW,
    )
    state = load_registry_metadata(registry, public_key=registry_keys["root_public"], now=NOW)

    assert result.ok is False
    assert result.kept_cached is True
    assert state is not None
    assert state.watermark_sequence == 3
