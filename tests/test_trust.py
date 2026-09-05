"""Unit tests for the shared signed-artifact trust primitive (superclaw.trust).

These exercise the verifier with a NON-plugin configuration (a hypothetical
``company`` asset kind) to prove the primitive is genuinely asset-agnostic and
reusable — the whole point of extracting it (capability-workshop-roadmap.md
方向一). Plugin-path losslessness is covered by the existing plugin test suite.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import unicodedata
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from superclaw.trust import (
    PackageTrustVerifier,
    SignedArtifactEnvelope,
    SignedArtifactError,
    canonical_manifest_for_digest,
)

MANIFEST_NAME = "superclaw-company.json"  # deliberately not the plugin manifest
ROOT_KEY_ENV = "SUPERCLAW_TEST_ROOT_KEY"
LOCAL_DEV_ENV = "SUPERCLAW_TEST_LOCAL_DEV"


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return priv, "ed25519:" + base64.b64encode(raw).decode()


def _sign(priv: Ed25519PrivateKey, digest: str) -> str:
    return "ed25519:" + base64.b64encode(priv.sign(digest.encode("utf-8"))).decode()


def _make_artifact(base: Path, manifest: dict, *, extra: dict[str, str] | None = None) -> SignedArtifactEnvelope:
    base.mkdir(parents=True, exist_ok=True)
    (base / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    for name, content in (extra or {}).items():
        target = base / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return SignedArtifactEnvelope(source=base, root=base, manifest=manifest)


def _verifier(**overrides) -> PackageTrustVerifier:
    kw = dict(
        manifest_name=MANIFEST_NAME,
        label="company",
        root_key_env=ROOT_KEY_ENV,
        local_dev_env=LOCAL_DEV_ENV,
        revocation_id_field="company_id",
    )
    kw.update(overrides)
    return PackageTrustVerifier(**kw)


def _manifest(**provenance) -> dict:
    prov = {"package_digest": "", "signature": ""}
    prov.update(provenance)
    return {"id": "acme.co", "version": "1.0.0", "provenance": prov}


# --- digest -----------------------------------------------------------------


def test_compute_digest_is_stable_and_content_addressed(tmp_path):
    v = _verifier()
    env = _make_artifact(tmp_path / "a", _manifest(), extra={"roles.txt": "ceo"})
    d1 = v.compute_digest(env)
    assert d1.startswith("sha256:")
    assert v.compute_digest(env) == d1  # deterministic


def test_compute_digest_ignores_declared_digest_and_signature(tmp_path):
    v = _verifier()
    clean = _make_artifact(tmp_path / "a", _manifest(), extra={"x.txt": "data"})
    dirty = _make_artifact(
        tmp_path / "b",
        _manifest(package_digest="sha256:zzz", signature="ed25519:zzz"),
        extra={"x.txt": "data"},
    )
    # The self-referential provenance fields are zeroed before hashing, so the
    # computed digest depends only on content + the rest of the manifest.
    assert v.compute_digest(clean) == v.compute_digest(dirty)


def test_compute_digest_changes_with_content(tmp_path):
    v = _verifier()
    a = _make_artifact(tmp_path / "a", _manifest(), extra={"x.txt": "one"})
    b = _make_artifact(tmp_path / "b", _manifest(), extra={"x.txt": "two"})
    assert v.compute_digest(a) != v.compute_digest(b)


def test_compute_digest_changes_when_owner_exec_bit_flips(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest(), extra={"bin/run": "echo ok\n"})
    target = root / "bin" / "run"
    target.chmod(0o644)
    digest_without_exec = v.compute_digest(env)

    target.chmod(0o755)
    digest_with_exec = v.compute_digest(env)

    assert digest_without_exec != digest_with_exec


def test_compute_digest_exec_signal_ignores_group_other_noise(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest(), extra={"bin/run": "echo ok\n"})
    target = root / "bin" / "run"

    target.chmod(0o755)
    digest_755 = v.compute_digest(env)
    target.chmod(0o744)
    digest_744 = v.compute_digest(env)
    target.chmod(0o644)
    digest_644 = v.compute_digest(env)

    assert digest_755 == digest_744
    assert digest_744 != digest_644


def test_compute_digest_covers_setuid_bit(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest(), extra={"bin/run": "echo ok\n"})
    target = root / "bin" / "run"

    target.chmod(0o755)
    digest_plain = v.compute_digest(env)
    os.chmod(target, 0o4755)
    digest_setuid = v.compute_digest(env)

    assert digest_plain != digest_setuid


def test_compute_digest_hashes_pyc_outside_generated_cache(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest())
    bytecode = root / "bin" / "runner.pyc"
    bytecode.parent.mkdir()
    bytecode.write_bytes(b"\0original")
    digest_before = v.compute_digest(env)

    bytecode.write_bytes(b"\0swapped")
    digest_after = v.compute_digest(env)

    assert digest_before != digest_after


def test_compute_digest_still_ignores_generated_pycache(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest(), extra={"x.txt": "data"})
    digest_clean = v.compute_digest(env)

    pycache = root / "__pycache__"
    pycache.mkdir()
    (pycache / "x.cpython-311.pyc").write_bytes(b"\0generated")

    assert v.compute_digest(env) == digest_clean


def test_compute_digest_rejects_non_nfc_filename(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    env = _make_artifact(root, _manifest())
    decomposed = "e\u0301.txt"
    assert unicodedata.normalize("NFC", decomposed) != decomposed
    (root / decomposed).write_text("x", encoding="utf-8")
    if decomposed not in {path.name for path in root.iterdir()}:
        pytest.skip("filesystem normalized the name; cannot stage a non-NFC entry")

    with pytest.raises(SignedArtifactError, match="not Unicode-NFC-normalized"):
        v.compute_digest(env)


def test_compute_digest_domain_separator_replaces_legacy_stream(tmp_path):
    v = _verifier()
    env = _make_artifact(tmp_path / "a", _manifest(), extra={"x.txt": "data"})

    legacy = hashlib.sha256()
    for file_path in v.iter_package_files(env.root):
        relative = file_path.relative_to(env.root).as_posix()
        legacy.update(relative.encode("utf-8"))
        legacy.update(b"\0")
        if relative == MANIFEST_NAME:
            legacy.update(canonical_manifest_for_digest(env.manifest))
        else:
            legacy.update(file_path.read_bytes())
        legacy.update(b"\0")

    assert v.compute_digest(env) != f"sha256:{legacy.hexdigest()}"


def test_canonical_manifest_zeroes_provenance():
    raw = _manifest(package_digest="sha256:abc", signature="ed25519:def")
    canon = json.loads(canonical_manifest_for_digest(raw).decode("utf-8"))
    assert canon["provenance"]["package_digest"] == ""
    assert canon["provenance"]["signature"] == ""
    assert raw["provenance"]["package_digest"] == "sha256:abc"  # original untouched


def test_symlink_in_package_is_rejected_with_label(tmp_path):
    v = _verifier()
    root = tmp_path / "a"
    root.mkdir()
    (root / MANIFEST_NAME).write_text(json.dumps(_manifest()), encoding="utf-8")
    target = tmp_path / "outside.txt"
    target.write_text("x", encoding="utf-8")
    (root / "link").symlink_to(target)
    env = SignedArtifactEnvelope(source=root, root=root, manifest=_manifest())
    with pytest.raises(SignedArtifactError, match="company package may not contain symlink"):
        v.compute_digest(env)


# --- signature --------------------------------------------------------------


def test_verify_signature_round_trip(tmp_path):
    v = _verifier()
    priv, pub = _keypair()
    digest = "sha256:" + "a" * 64
    v.verify_signature(digest, _sign(priv, digest), pub)  # no raise


def test_verify_signature_bad_uses_label(tmp_path):
    v = _verifier()
    priv, _ = _keypair()
    _, other_pub = _keypair()
    digest = "sha256:" + "a" * 64
    with pytest.raises(SignedArtifactError, match="company signature invalid"):
        v.verify_signature(digest, _sign(priv, digest), other_pub)


def test_verify_signature_unsupported_format():
    v = _verifier()
    with pytest.raises(SignedArtifactError, match="unsupported signature format"):
        v.verify_signature("sha256:x", "rsa:whatever", "ed25519:AAAA")


def test_resolve_trust_official_with_explicit_key():
    v = _verifier()
    priv, pub = _keypair()
    digest = "sha256:" + "b" * 64
    assert v.resolve_signature_trust(digest, _sign(priv, digest), pub) == "official"


def test_resolve_trust_official_via_env(monkeypatch):
    v = _verifier()
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    digest = "sha256:" + "c" * 64
    assert v.resolve_signature_trust(digest, _sign(priv, digest), None) == "official"


def test_resolve_trust_bad_sig_fail_closed(monkeypatch):
    v = _verifier()
    priv, _ = _keypair()
    _, other_pub = _keypair()
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    digest = "sha256:" + "d" * 64
    with pytest.raises(SignedArtifactError, match="company signature invalid"):
        v.resolve_signature_trust(digest, _sign(priv, digest), other_pub)


def test_resolve_trust_bad_sig_local_dev(monkeypatch):
    v = _verifier()
    priv, _ = _keypair()
    _, other_pub = _keypair()
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    digest = "sha256:" + "e" * 64
    assert v.resolve_signature_trust(digest, _sign(priv, digest), other_pub) == "local_dev"


def test_resolve_trust_no_key_local_dev(monkeypatch):
    v = _verifier()
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "yes")
    digest = "sha256:" + "f" * 64
    assert v.resolve_signature_trust(digest, _sign(priv, digest), None) == "local_dev"


def test_resolve_trust_no_key_fail_closed_uses_env_name(monkeypatch):
    v = _verifier()
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    digest = "sha256:" + "0" * 64
    with pytest.raises(SignedArtifactError, match=f"missing {ROOT_KEY_ENV}"):
        v.resolve_signature_trust(digest, _sign(priv, digest), None)


def test_local_dev_trust_env_truthy_values(monkeypatch):
    v = _verifier()
    for value, expected in [("1", True), ("true", True), ("ON", True), ("0", False), ("", False)]:
        monkeypatch.setenv(LOCAL_DEV_ENV, value)
        assert v.local_dev_trust_enabled() is expected


# --- revocation -------------------------------------------------------------


def test_check_revocation_uses_configurable_id_field(tmp_path):
    v = _verifier()
    env = _make_artifact(tmp_path / "a", _manifest())
    revfile = tmp_path / "rev.json"
    # entry keyed by company_id (NOT plugin_id) — proves the field is configurable
    revfile.write_text(json.dumps({"revoked": [{"company_id": "acme.co", "version": "1.0.0"}]}), encoding="utf-8")
    with pytest.raises(SignedArtifactError, match="company revoked: acme.co@1.0.0"):
        v.check_revocation(env, revfile)


def test_check_revocation_no_match(tmp_path):
    v = _verifier()
    env = _make_artifact(tmp_path / "a", _manifest())
    revfile = tmp_path / "rev.json"
    revfile.write_text(json.dumps({"revoked": [{"company_id": "other.co"}]}), encoding="utf-8")
    v.check_revocation(env, revfile)  # no raise


def test_check_revocation_missing_file_is_noop(tmp_path):
    v = _verifier()
    env = _make_artifact(tmp_path / "a", _manifest())
    v.check_revocation(env, tmp_path / "does-not-exist.json")  # no raise


# --- error_cls parameterization ---------------------------------------------


def test_error_cls_is_honored(tmp_path):
    class CompanyTrustError(SignedArtifactError):
        pass

    v = _verifier(error_cls=CompanyTrustError)
    with pytest.raises(CompanyTrustError, match="unsupported signature format"):
        v.verify_signature("sha256:x", "rsa:nope", "ed25519:AAAA")


# --- envelope accessors -----------------------------------------------------


def test_envelope_accessors():
    manifest = {
        "id": "acme.co",
        "version": "2.1.0",
        "kind": "company",
        "provenance": {"package_digest": "sha256:dd", "signature": "ed25519:ss"},
    }
    env = SignedArtifactEnvelope(source=Path("."), root=Path("."), manifest=manifest)
    assert env.artifact_id == "acme.co"
    assert env.version == "2.1.0"
    assert env.kind == "company"
    assert env.package_digest == "sha256:dd"
    assert env.signature == "ed25519:ss"


def test_envelope_kind_optional():
    env = SignedArtifactEnvelope(source=Path("."), root=Path("."), manifest=_manifest())
    assert env.kind is None
