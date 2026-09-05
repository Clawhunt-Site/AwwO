"""Tier C envelope encryption primitive: round-trip, tamper-evidence, key binding,
and wire-compat with the server's ``decode_tier_c_rows``.

RSA keygen is slow, so a single module-scoped keypair is reused across cases.
"""
from __future__ import annotations

import base64

import pytest

from superclaw.telemetry_envelope import (
    EnvelopeError,
    generate_keypair,
    key_id_for,
    seal,
    unseal,
)


@pytest.fixture(scope="module")
def keypair():
    return generate_keypair()  # (public_pem, private_pem)


def test_seal_unseal_roundtrip(keypair):
    pub, priv = keypair
    plaintext = "原始 prompt: rm -rf / at /Users/leon/secret\n模型输出...".encode()
    env = seal(plaintext, pub)
    assert set(env) == {"ciphertext_b64", "nonce_b64", "wrapped_cek_b64", "key_id"}
    assert unseal(env, priv) == plaintext


def test_server_never_sees_plaintext(keypair):
    pub, _ = keypair
    secret = b"super secret raw IO"
    env = seal(secret, pub)
    # The wire blobs must not contain the plaintext in any form.
    for field in ("ciphertext_b64", "nonce_b64", "wrapped_cek_b64"):
        raw = base64.b64decode(env[field])
        assert secret not in raw


def test_tamper_is_detected(keypair):
    pub, priv = keypair
    env = seal(b"untampered", pub)
    ct = bytearray(base64.b64decode(env["ciphertext_b64"]))
    ct[0] ^= 0x01  # flip one bit
    env["ciphertext_b64"] = base64.b64encode(bytes(ct)).decode()
    with pytest.raises(EnvelopeError, match="authentication failed"):
        unseal(env, priv)


def test_wrong_private_key_cannot_unseal(keypair):
    pub, _ = keypair
    _, other_priv = generate_keypair()
    env = seal(b"x", pub)
    with pytest.raises(EnvelopeError):
        unseal(env, other_priv)


def test_key_id_is_stable_and_bound(keypair):
    pub, _ = keypair
    assert key_id_for(pub) == key_id_for(pub) == seal(b"a", pub)["key_id"]
    other_pub, _ = generate_keypair()
    assert key_id_for(other_pub) != key_id_for(pub)


def test_unseal_rejects_key_id_mismatch(keypair):
    """key_id is the public-key fingerprint; a tampered/misrouted key_id must be
    caught, not silently 'work' because the private key still unwraps the CEK."""
    pub, priv = keypair
    env = seal(b"x", pub)
    env["key_id"] = "deadbeefdeadbeefdeadbeefdeadbeef"
    with pytest.raises(EnvelopeError, match="key_id"):
        unseal(env, priv)


def test_unseal_bad_nonce_length_fails_closed(keypair):
    """A malformed nonce length makes AESGCM raise ValueError (not InvalidTag); it
    must still surface as EnvelopeError, never a bare library exception."""
    pub, priv = keypair
    env = seal(b"x", pub)
    env["nonce_b64"] = base64.b64encode(b"\x00\x00\x00").decode()  # 3 bytes: illegal
    with pytest.raises(EnvelopeError):
        unseal(env, priv)


def test_unseal_rejects_weak_private_key(keypair):
    """A downgraded (weak) private key must be refused on the decrypt side too —
    symmetric to seal()'s public-key size guard."""
    from cryptography.hazmat.primitives import serialization as _ser
    from cryptography.hazmat.primitives.asymmetric import rsa as _rsa

    weak = _rsa.generate_private_key(public_exponent=65537, key_size=1024)
    weak_pem = weak.private_bytes(
        _ser.Encoding.PEM, _ser.PrivateFormat.PKCS8, _ser.NoEncryption()
    ).decode()
    pub, _ = keypair
    env = seal(b"x", pub)
    with pytest.raises(EnvelopeError, match="too small"):
        unseal(env, weak_pem)


def test_each_seal_uses_fresh_cek_and_nonce(keypair):
    pub, _ = keypair
    a, b = seal(b"same", pub), seal(b"same", pub)
    assert a["nonce_b64"] != b["nonce_b64"]
    assert a["ciphertext_b64"] != b["ciphertext_b64"]
    assert a["wrapped_cek_b64"] != b["wrapped_cek_b64"]


def test_envelope_is_wire_compatible_with_server_decode(keypair):
    """seal()'s output must satisfy the server's decode_tier_c_rows contract."""
    from apps.telemetry_server.schemas import decode_tier_c_rows

    pub, _ = keypair
    env = seal(b"raw", pub)
    row = {**env, "trace_id": "t", "run_id": "r", "payload_kind": "llm.response"}
    decoded = decode_tier_c_rows([row])[0]
    # base64 fields turned into raw bytes; key_id / correlation preserved.
    assert isinstance(decoded["ciphertext"], bytes)
    assert isinstance(decoded["nonce"], bytes)
    assert isinstance(decoded["wrapped_cek"], bytes)
    assert decoded["key_id"] == env["key_id"]
    assert "ciphertext_b64" not in decoded


def test_rejects_weak_or_wrong_key_material(keypair):
    pub, _ = keypair
    with pytest.raises(EnvelopeError, match="invalid public key"):
        seal(b"x", "not a pem")
    with pytest.raises(EnvelopeError):
        unseal({"ciphertext_b64": "@@", "nonce_b64": "@@", "wrapped_cek_b64": "@@"}, "bad pem")
    with pytest.raises(EnvelopeError, match="smaller than"):
        generate_keypair(bits=1024)


def test_non_bytes_plaintext_rejected(keypair):
    pub, _ = keypair
    with pytest.raises(EnvelopeError, match="must be bytes"):
        seal("a string not bytes", pub)  # type: ignore[arg-type]
