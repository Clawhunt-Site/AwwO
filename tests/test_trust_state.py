"""Tests for the authoritative TrustState derivation (方向二 §1).

Exhaustive state-machine coverage of the pure ``derive_trust_state`` (every
security input is required — no fail-open defaults) plus integration of the
verifier's non-raising ``classify_signer`` / ``assess`` into the derivation.
"""
from __future__ import annotations

import base64
import dataclasses
import json
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from superclaw.trust import (
    PackageTrustVerdict,
    PackageTrustVerifier,
    SignedArtifactEnvelope,
)
from superclaw.trust_state import (
    FIRST_PARTY_NAMESPACES,
    TrustDerivation,
    TrustState,
    derive_trust_state,
)

MANIFEST_NAME = "superclaw-plugin.json"
ROOT_KEY_ENV = "SUPERCLAW_TS_ROOT_KEY"
LOCAL_DEV_ENV = "SUPERCLAW_TS_LOCAL_DEV"


def _derive(
    plugin_id: str = "acme.tool",
    *,
    signer_class: str = "root",
    integrity_ok: bool = True,
    revoked: bool = False,
    source_is_local: bool = False,
    rollback_ok: bool = True,
    freshness_ok: bool = True,
    high_risk: bool = False,
    developer_keyids: frozenset[str] | None = None,
) -> TrustDerivation:
    """Terse wrapper for tests. The production ``derive_trust_state`` itself has
    NO defaults — every security input must be supplied explicitly."""
    return derive_trust_state(
        plugin_id=plugin_id,
        verdict=PackageTrustVerdict(signer_class=signer_class, integrity_ok=integrity_ok),
        revoked=revoked,
        source_is_local=source_is_local,
        rollback_ok=rollback_ok,
        freshness_ok=freshness_ok,
        high_risk=high_risk,
        developer_keyids=developer_keyids,
    )


# --- API is fail-closed: no trusted defaults --------------------------------


def test_production_api_requires_every_security_input():
    # Missing any required kw-only arg is a TypeError — you cannot accidentally
    # call into a trusted state without supplying the verification facts.
    with pytest.raises(TypeError):
        derive_trust_state(  # type: ignore[call-arg]
            plugin_id="acme.tool",
            verdict=PackageTrustVerdict(signer_class="root", integrity_ok=True),
        )


# --- pure derivation state machine ------------------------------------------


def test_revoked_is_untrusted():
    d = _derive(signer_class="root", revoked=True)
    assert d.state is TrustState.UNTRUSTED
    assert d.reasons == ("revoked",)


def test_integrity_failure_is_untrusted_and_scrubs_signer():
    d = _derive(signer_class="root", integrity_ok=False)
    assert d.state is TrustState.UNTRUSTED
    assert "integrity_failed" in d.reasons
    # a tampered package's signer identity must not survive as "root"
    assert d.signer_class == "none"


def test_root_signer_is_official():
    d = _derive(signer_class="root")
    assert d.state is TrustState.OFFICIAL
    assert d.reasons == ()


def test_root_signer_official_even_in_reserved_namespace():
    d = _derive(plugin_id="superclaw.core", signer_class="root")
    assert d.state is TrustState.OFFICIAL
    assert d.namespace_reserved is True


def test_reserved_namespace_non_root_is_hijack():
    for prefix in FIRST_PARTY_NAMESPACES:
        for sc in ("local_dev", "developer:k", "none"):
            d = _derive(plugin_id=f"{prefix}evil", signer_class=sc, source_is_local=True,
                        developer_keyids=frozenset({"k"}))
            assert d.state is TrustState.UNTRUSTED
            assert "namespace_hijack" in d.reasons


def test_local_dev_local_source_is_local():
    d = _derive(signer_class="local_dev", source_is_local=True)
    assert d.state is TrustState.LOCAL


def test_local_dev_nonlocal_source_fails_closed():
    # an unverifiable REMOTE package must never read as locally trusted
    d = _derive(signer_class="local_dev", source_is_local=False)
    assert d.state is TrustState.UNTRUSTED
    assert "local_dev_on_nonlocal" in d.reasons


def test_developer_without_registry_fails_closed():
    d = _derive(signer_class="developer:key1", developer_keyids=None)
    assert d.state is TrustState.UNTRUSTED
    assert "developer_no_registry" in d.reasons


def test_developer_not_registered_is_untrusted():
    d = _derive(signer_class="developer:key1", developer_keyids=frozenset({"key2"}))
    assert d.state is TrustState.UNTRUSTED
    assert "developer_not_registered" in d.reasons


def test_developer_registered_is_developer():
    d = _derive(signer_class="developer:key1", developer_keyids=frozenset({"key1"}))
    assert d.state is TrustState.DEVELOPER


def test_developer_high_risk_stale_freshness_is_untrusted():
    d = _derive(
        signer_class="developer:key1",
        developer_keyids=frozenset({"key1"}),
        high_risk=True,
        freshness_ok=False,
    )
    assert d.state is TrustState.UNTRUSTED
    assert "developer_freshness_stale" in d.reasons


def test_developer_low_risk_stale_freshness_still_developer():
    # offline low-risk use stays available (freshness only gates high-risk)
    d = _derive(
        signer_class="developer:key1",
        developer_keyids=frozenset({"key1"}),
        high_risk=False,
        freshness_ok=False,
    )
    assert d.state is TrustState.DEVELOPER


def test_anti_rollback_is_unconditional_even_low_risk():
    # a sequence rollback is an attack at ANY risk level
    d = _derive(signer_class="root", high_risk=False, rollback_ok=False)
    assert d.state is TrustState.UNTRUSTED
    assert "sequence_rollback" in d.reasons


def test_anti_rollback_high_risk_developer():
    d = _derive(
        signer_class="developer:key1",
        developer_keyids=frozenset({"key1"}),
        high_risk=True,
        rollback_ok=False,
    )
    assert d.state is TrustState.UNTRUSTED
    assert "sequence_rollback" in d.reasons


def test_none_signer_is_untrusted_and_scrubbed():
    d = _derive(signer_class="none")
    assert d.state is TrustState.UNTRUSTED
    assert "sig_invalid" in d.reasons
    assert d.signer_class == "none"


def test_invariant_trusted_implies_integrity_not_revoked_rollback():
    for sc, kw in [
        ("root", {}),
        ("developer:k", {"developer_keyids": frozenset({"k"})}),
        ("local_dev", {"source_is_local": True}),
    ]:
        ok = _derive(signer_class=sc, **kw)
        assert ok.state in {TrustState.OFFICIAL, TrustState.DEVELOPER, TrustState.LOCAL}
        assert _derive(signer_class=sc, integrity_ok=False, **kw).state is TrustState.UNTRUSTED
        assert _derive(signer_class=sc, revoked=True, **kw).state is TrustState.UNTRUSTED
        assert _derive(signer_class=sc, rollback_ok=False, **kw).state is TrustState.UNTRUSTED


def test_local_never_in_reserved_namespace():
    for prefix in FIRST_PARTY_NAMESPACES:
        d = _derive(plugin_id=f"{prefix}x", signer_class="local_dev", source_is_local=True)
        assert d.state is not TrustState.LOCAL


def test_derivation_is_frozen():
    d = _derive(signer_class="root")
    assert isinstance(d, TrustDerivation)
    with pytest.raises(dataclasses.FrozenInstanceError):
        d.state = TrustState.LOCAL  # type: ignore[misc]


# --- integration: verifier classify_signer / assess → derive_trust_state ----


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return priv, "ed25519:" + base64.b64encode(raw).decode()


def _sign(priv: Ed25519PrivateKey, digest: str) -> str:
    return "ed25519:" + base64.b64encode(priv.sign(digest.encode("utf-8"))).decode()


def _verifier() -> PackageTrustVerifier:
    return PackageTrustVerifier(
        manifest_name=MANIFEST_NAME,
        label="plugin",
        root_key_env=ROOT_KEY_ENV,
        local_dev_env=LOCAL_DEV_ENV,
        revocation_id_field="plugin_id",
    )


def _signed_envelope(tmp_path: Path, priv: Ed25519PrivateKey, *, tamper: bool = False):
    root = tmp_path / "pkg"
    root.mkdir()
    manifest = {
        "id": "acme.tool",
        "version": "1.0.0",
        "provenance": {"package_digest": "", "signature": ""},
    }
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    (root / "x.txt").write_text("data", encoding="utf-8")
    env0 = SignedArtifactEnvelope(source=root, root=root, manifest=manifest)
    digest = _verifier().compute_digest(env0)
    manifest["provenance"]["package_digest"] = "sha256:tampered" if tamper else digest
    manifest["provenance"]["signature"] = _sign(priv, digest)
    return SignedArtifactEnvelope(source=root, root=root, manifest=manifest)


def test_classify_signer_root_only_via_root_key(monkeypatch):
    v = _verifier()
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    digest = "sha256:" + "a" * 64
    assert v.classify_signer(digest, _sign(priv, digest)) == "root"


def test_classify_signer_arbitrary_key_cannot_be_root(monkeypatch):
    # a signature NOT under the configured root key is never "root" (no privilege
    # escalation via a caller-supplied key); local dev off -> "none"
    v = _verifier()
    root_priv, root_pub = _keypair()
    other_priv, _ = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    digest = "sha256:" + "b" * 64
    assert v.classify_signer(digest, _sign(other_priv, digest)) == "none"


def test_classify_signer_local_dev(monkeypatch):
    v = _verifier()
    other_priv, _ = _keypair()
    _root_priv, root_pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    digest = "sha256:" + "c" * 64
    assert v.classify_signer(digest, _sign(other_priv, digest)) == "local_dev"


def test_assess_root_then_official(monkeypatch, tmp_path):
    v = _verifier()
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    env = _signed_envelope(tmp_path, priv)
    verdict = v.assess(env)
    assert verdict.integrity_ok is True
    assert verdict.signer_class == "root"
    d = derive_trust_state(
        plugin_id=env.artifact_id, verdict=verdict, revoked=False,
        source_is_local=False, rollback_ok=True, freshness_ok=True, high_risk=False,
    )
    assert d.state is TrustState.OFFICIAL


def test_assess_tampered_is_integrity_failed(monkeypatch, tmp_path):
    v = _verifier()
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    env = _signed_envelope(tmp_path, priv, tamper=True)
    verdict = v.assess(env)
    assert verdict.integrity_ok is False
    assert verdict.signer_class == "none"
    d = derive_trust_state(
        plugin_id=env.artifact_id, verdict=verdict, revoked=False,
        source_is_local=False, rollback_ok=True, freshness_ok=True, high_risk=False,
    )
    assert d.state is TrustState.UNTRUSTED
    assert "integrity_failed" in d.reasons


def test_assess_non_raising_on_missing_provenance(tmp_path):
    # discovery must not crash on a malformed manifest (no provenance) — untrusted
    v = _verifier()
    root = tmp_path / "bad"
    root.mkdir()
    manifest = {"id": "x.y", "version": "1.0.0"}  # no provenance block
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    env = SignedArtifactEnvelope(source=root, root=root, manifest=manifest)
    verdict = v.assess(env)  # must NOT raise
    assert verdict.integrity_ok is False
    assert verdict.signer_class == "none"


def test_assess_non_raising_on_symlink(tmp_path):
    # a symlink makes compute_digest raise; assess must absorb it -> untrusted
    v = _verifier()
    root = tmp_path / "bad2"
    root.mkdir()
    manifest = {
        "id": "x.y",
        "version": "1.0.0",
        "provenance": {"package_digest": "sha256:x", "signature": "ed25519:x"},
    }
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    target = tmp_path / "outside.txt"
    target.write_text("x", encoding="utf-8")
    (root / "link").symlink_to(target)
    env = SignedArtifactEnvelope(source=root, root=root, manifest=manifest)
    verdict = v.assess(env)  # must NOT raise
    assert verdict.integrity_ok is False
    assert verdict.signer_class == "none"


# --- verify_plugin_package: propagated verdict is ROOT-ONLY ------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_KEY_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"


def _sign_plugin_dir(plugin_dir: Path, priv: Ed25519PrivateKey) -> None:
    from superclaw.plugins import compute_package_digest, load_plugin_package

    mp = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(mp.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = _sign(priv, digest)
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def test_verify_plugin_package_explicit_key_verdict_is_not_root(tmp_path, monkeypatch):
    # admission via an explicit caller key must NOT yield a root-class verdict
    from superclaw.plugins import verify_plugin_package

    priv, pub = _keypair()
    plug = tmp_path / "hello"
    shutil.copytree(REPO_ROOT / "examples" / "plugins" / "hello-world", plug)
    _sign_plugin_dir(plug, priv)
    monkeypatch.delenv(PLUGIN_ROOT_KEY_ENV, raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)

    result = verify_plugin_package(
        plug, public_key=pub, cache_root=tmp_path / "cache", revocation_file=tmp_path / "rev.json"
    )
    assert result.verdict is not None
    assert result.verdict.signer_class != "root"  # explicit key != root trust
    d = derive_trust_state(
        plugin_id=result.plugin_id, verdict=result.verdict, revoked=False,
        source_is_local=False, rollback_ok=True, freshness_ok=True, high_risk=False,
    )
    assert d.state is not TrustState.OFFICIAL


def test_verify_plugin_package_root_key_verdict_is_root(tmp_path, monkeypatch):
    from superclaw.plugins import verify_plugin_package

    priv, pub = _keypair()
    plug = tmp_path / "hello"
    shutil.copytree(REPO_ROOT / "examples" / "plugins" / "hello-world", plug)
    _sign_plugin_dir(plug, priv)
    monkeypatch.setenv(PLUGIN_ROOT_KEY_ENV, pub)  # the signer IS the configured root

    result = verify_plugin_package(
        plug, cache_root=tmp_path / "cache", revocation_file=tmp_path / "rev.json"
    )
    assert result.verdict is not None
    assert result.verdict.signer_class == "root"
    d = derive_trust_state(
        plugin_id=result.plugin_id, verdict=result.verdict, revoked=False,
        source_is_local=False, rollback_ok=True, freshness_ok=True, high_risk=False,
    )
    assert d.state is TrustState.OFFICIAL
