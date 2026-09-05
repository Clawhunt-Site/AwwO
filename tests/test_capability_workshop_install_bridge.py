"""Slice 1: the download→Node-land install bridge (H-architecture).

The feed / cosign / R2 / validate / Node-import boundaries are all faked, so these are
pure in-process unit tests of the orchestration + its fail-closed gates.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

import superclaw.capability_workshop_install_bridge as mod
from superclaw.capability_workshop_install_bridge import (
    WorkshopInstallBridgeError,
    _artifact_ref_to_r2_key,
    install_published_capability,
)

_DIGEST = "sha256:" + "ab" * 32
_HMAC = b"workshop-install-bridge-test-key"
_REF = "superclaw-object://capabilities/skill/skill.demo/versions/1.0.0/package.scskill"


@dataclass
class _FakeMeta:
    kind: str
    capability_id: str
    version: str
    artifact_digest: str


@dataclass
class _FakeR2Config:
    artifact_bucket: str = "clawhunt-capability-artifacts-prod"


def _entry(**over) -> dict:
    e = {
        "kind": "skill",
        "capability_id": "skill.demo",
        "version": "1.0.0",
        "package_digest": _DIGEST,
        "artifact_ref": _REF,
        "signature_verified_official": True,
    }
    e.update(over)
    return e


def _ok_outcome(**over) -> dict:
    o = {"kind": "skill", "capabilityId": "skill.demo", "version": "1.0.0", "official": True, "nativeId": "skill.demo"}
    o.update(over)
    return o


def _wire_install(
    monkeypatch, *, entry=..., official=True, meta=..., node="http://127.0.0.1:3100", posted=None, outcome=..., fetched=None
):
    """Patch every boundary for a happy-ish install; individual tests override pieces."""
    if entry is ...:
        entry = _entry()
    if meta is ...:
        meta = _FakeMeta("skill", "skill.demo", "1.0.0", _DIGEST)
    if outcome is ...:
        outcome = _ok_outcome()
    monkeypatch.setattr(mod, "fetch_published_entry", lambda *a, **k: entry)
    monkeypatch.setattr(mod, "verify_official_cosignature", lambda e, **k: official)
    monkeypatch.setattr(mod, "official_root_public_key", lambda: "ed25519:AAAA")
    monkeypatch.setattr(mod, "load_r2_config", lambda: _FakeR2Config())

    def _fake_fetch(bucket, key, dest, *, config):
        if fetched is not None:
            fetched.append(bucket)
        Path(dest).write_bytes(b"fake .scskill bytes")

    monkeypatch.setattr(mod, "fetch_r2_object", _fake_fetch)
    monkeypatch.setattr(mod, "validate_capability_artifact", lambda kind, path: meta)
    monkeypatch.setattr(mod, "resolve_node_base_url", lambda explicit=None: node)
    record = posted if posted is not None else []
    monkeypatch.setattr(
        mod, "_post_workshop_import", lambda base, wire, timeout: record.append((base, wire)) or outcome
    )


# ----------------------------------------------------------------- _artifact_ref_to_r2_key


@pytest.mark.parametrize(
    "ref,expected",
    [
        (_REF, "capabilities/skill/skill.demo/versions/1.0.0/package.scskill"),
        ("superclaw-object://capabilities/plugin/p/versions/1/package.scplug", "capabilities/plugin/p/versions/1/package.scplug"),
        ("https://evil.example/x", None),
        ("superclaw-object://etc/passwd", None),  # not capabilities/
        ("superclaw-object://capabilities/../escape", None),
        ("superclaw-object://capabilities/a\\b", None),
        ("superclaw-object://capabilities/file://x", None),
        (123, None),
    ],
)
def test_artifact_ref_to_r2_key(ref, expected):
    assert _artifact_ref_to_r2_key(ref) == expected


# ----------------------------------------------------------------- happy path


def test_install_happy_path_posts_signed_receipt(monkeypatch):
    posted: list = []
    _wire_install(monkeypatch, posted=posted)
    out = install_published_capability(
        "skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC
    )
    assert out["ok"] is True
    assert out["outcome"]["official"] is True
    # exactly one loopback import, carrying a signed receipt wire for the right identity
    assert len(posted) == 1
    base, wire = posted[0]
    assert base == "http://127.0.0.1:3100"
    assert wire["kind"] == "skill" and wire["capability_id"] == "skill.demo" and wire["version"] == "1.0.0"
    assert wire["official"] is True and wire["package_digest"] == _DIGEST
    assert wire["staged_artifact"].endswith("package.scskill")
    assert "mac" in wire and wire["transport_sha256"].startswith("sha256:")


# --------------------------------------------------- receipt key resolved from file (2a-4)


def test_install_resolves_hmac_key_from_key_file(tmp_path, monkeypatch):
    """No explicit key + no env key: the bridge signs with the 0600 key FILE, so the
    secret never has to live in this process's environment."""
    from superclaw import workshop_receipt_key as wrk

    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))
    monkeypatch.delenv("SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY", raising=False)
    file_key = wrk.ensure_workshop_receipt_key()

    captured: dict = {}
    real_to_wire = mod.receipt_to_wire

    def _spy(receipt, *, key=None):
        captured["key"] = key
        return real_to_wire(receipt, key=key)

    monkeypatch.setattr(mod, "receipt_to_wire", _spy)
    _wire_install(monkeypatch)
    out = install_published_capability("skill", "skill.demo", "1.0.0", app_env="production")
    assert out["ok"] is True
    assert captured["key"] == file_key.encode("utf-8")


def test_install_fails_closed_when_no_hmac_key_anywhere(tmp_path, monkeypatch):
    """No explicit key, no key file, no env: signing is refused (no silent unsigned receipt)."""
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))  # nothing provisioned
    monkeypatch.delenv("SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY", raising=False)
    _wire_install(monkeypatch)
    with pytest.raises(WorkshopInstallBridgeError, match="not provisioned"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production")


def test_install_wraps_unsafe_key_file_error_in_bridge_error(tmp_path, monkeypatch):
    """An unsafe/malformed key file (symlink/perms/format) fails closed AND is wrapped so callers
    only see WorkshopInstallBridgeError (consistent error contract), not WorkshopReceiptKeyError."""
    from superclaw.workshop_receipt_key import WorkshopReceiptKeyError

    def _boom():
        raise WorkshopReceiptKeyError("group/other-readable")

    monkeypatch.setattr(mod, "read_workshop_receipt_key", _boom)
    monkeypatch.delenv("SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY", raising=False)
    _wire_install(monkeypatch)
    with pytest.raises(WorkshopInstallBridgeError, match="unusable"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production")


def test_install_never_signs_from_env_when_key_file_absent(tmp_path, monkeypatch):
    """File-only on the Python side: even when the env var IS set, an absent key file makes
    the bridge refuse rather than sign with an env-injectable secret. This closes the
    `_resolve_hmac_key(None)` env-fallback path for the workshop install bridge."""
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))  # no key file provisioned
    monkeypatch.setenv("SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY", "de" * 32)  # env HAS a key
    _wire_install(monkeypatch)
    with pytest.raises(WorkshopInstallBridgeError, match="not provisioned"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production")


# ----------------------------------------------------------------- fail-closed gates


def test_unsupported_kind(monkeypatch):
    with pytest.raises(WorkshopInstallBridgeError):
        install_published_capability("widget", "x", "1.0.0", hmac_key=_HMAC)


def test_not_published(monkeypatch):
    _wire_install(monkeypatch, entry=None)
    with pytest.raises(WorkshopInstallBridgeError, match="not published"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_not_officially_cosigned(monkeypatch):
    _wire_install(monkeypatch, official=False)
    with pytest.raises(WorkshopInstallBridgeError, match="not officially co-signed"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_no_resolvable_artifact_ref(monkeypatch):
    _wire_install(monkeypatch, entry=_entry(artifact_ref="https://evil/x"))
    with pytest.raises(WorkshopInstallBridgeError, match="resolvable artifact"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_digest_mismatch(monkeypatch):
    bad = _FakeMeta("skill", "skill.demo", "1.0.0", "sha256:" + "cd" * 32)
    _wire_install(monkeypatch, meta=bad)
    with pytest.raises(WorkshopInstallBridgeError, match="digest does not match"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_identity_mismatch(monkeypatch):
    bad = _FakeMeta("skill", "skill.OTHER", "1.0.0", _DIGEST)
    _wire_install(monkeypatch, meta=bad)
    with pytest.raises(WorkshopInstallBridgeError, match="identity"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_no_colaunched_node(monkeypatch):
    _wire_install(monkeypatch, node=None)
    with pytest.raises(WorkshopInstallBridgeError, match="no co-launched Node"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_missing_cosigned_digest(monkeypatch):
    _wire_install(monkeypatch, entry=_entry(package_digest=None))
    with pytest.raises(WorkshopInstallBridgeError, match="co-signed package_digest"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_outcome_identity_mismatch_fails(monkeypatch):
    _wire_install(monkeypatch, outcome=_ok_outcome(capabilityId="skill.evil"))
    with pytest.raises(WorkshopInstallBridgeError, match="outcome identity"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_outcome_not_official_fails(monkeypatch):
    _wire_install(monkeypatch, outcome=_ok_outcome(official=False))
    with pytest.raises(WorkshopInstallBridgeError, match="not official"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_outcome_version_mismatch_fails(monkeypatch):
    _wire_install(monkeypatch, outcome=_ok_outcome(version="9.9.9"))
    with pytest.raises(WorkshopInstallBridgeError, match="outcome identity"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_outcome_missing_native_id_fails(monkeypatch):
    _wire_install(monkeypatch, outcome=_ok_outcome(nativeId=""))
    with pytest.raises(WorkshopInstallBridgeError, match="nativeId"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


def test_development_env_folds_to_staging_bucket_not_prod(monkeypatch):
    # an alias env (development → staging) must read the STAGING bucket, never prod
    fetched: list = []
    _wire_install(monkeypatch, fetched=fetched)
    install_published_capability("skill", "skill.demo", "1.0.0", app_env="development", hmac_key=_HMAC)
    assert fetched == ["clawhunt-capability-artifacts-staging"]


def test_invalid_app_env_rejected(monkeypatch):
    fetched: list = []
    _wire_install(monkeypatch, fetched=fetched)
    with pytest.raises(WorkshopInstallBridgeError):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="bogus-env", hmac_key=_HMAC)
    assert fetched == []  # never downloaded from any bucket


def test_staging_uses_staging_artifact_bucket(monkeypatch):
    fetched: list = []
    _wire_install(monkeypatch, fetched=fetched)
    install_published_capability("skill", "skill.demo", "1.0.0", app_env="staging", hmac_key=_HMAC)
    assert fetched == ["clawhunt-capability-artifacts-staging"]  # never the prod bucket


def test_production_uses_prod_artifact_bucket(monkeypatch):
    fetched: list = []
    _wire_install(monkeypatch, fetched=fetched)
    install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)
    assert fetched == ["clawhunt-capability-artifacts-prod"]


def test_duplicate_feed_entries_rejected(monkeypatch):
    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"entries": [_entry(), _entry()]}  # two for the same identity

    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp())
    with pytest.raises(WorkshopInstallBridgeError, match="malformed"):
        mod.fetch_published_entry("skill", "skill.demo", "1.0.0", feed_url="http://x")


def test_import_post_failure_propagates(monkeypatch):
    _wire_install(monkeypatch)

    def _boom(base, wire, timeout):
        raise WorkshopInstallBridgeError("node workshop-import returned HTTP 400: rejected")

    monkeypatch.setattr(mod, "_post_workshop_import", _boom)
    with pytest.raises(WorkshopInstallBridgeError, match="HTTP 400"):
        install_published_capability("skill", "skill.demo", "1.0.0", app_env="production", hmac_key=_HMAC)


# ----------------------------------------------------------------- feed parsing


def test_fetch_published_entry_matches(monkeypatch):
    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"entries": [_entry(version="9.9.9"), _entry()]}

    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp())
    e = mod.fetch_published_entry("skill", "skill.demo", "1.0.0", feed_url="http://x")
    assert e is not None and e["version"] == "1.0.0"


def test_fetch_published_entry_absent(monkeypatch):
    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"entries": [_entry(capability_id="skill.other")]}

    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp())
    assert mod.fetch_published_entry("skill", "skill.demo", "1.0.0", feed_url="http://x") is None


def test_fetch_published_entry_non_200_raises(monkeypatch):
    class _Resp:
        status_code = 503
        text = "down"

    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp())
    with pytest.raises(WorkshopInstallBridgeError, match="HTTP 503"):
        mod.fetch_published_entry("skill", "skill.demo", "1.0.0", feed_url="http://x")
