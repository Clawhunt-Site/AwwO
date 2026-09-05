"""Tier C field-level envelope encryption — hybrid AES-256-GCM + RSA-OAEP.

The remote telemetry server receives Tier C raw payloads **zero-knowledge**: the
installed client encrypts each payload under a fresh random content-encryption key
(CEK), wraps that CEK with the server's PUBLIC key, and uploads only ciphertext.
The private key NEVER reaches the client — only an authorized operator holding it
can unseal. This module is the single seal / unseal primitive for §8.3 of
``docs/remote-telemetry-upload-architecture.md``.

Scheme (one independent CEK per payload, so one leaked CEK never spreads):

    CEK            = AESGCM.generate_key(256)
    ciphertext     = AES-256-GCM(CEK, nonce, plaintext)        # AEAD: tamper-evident
    wrapped_cek    = RSA-OAEP(SHA-256)-encrypt(server_pub, CEK)
    key_id         = SHA-256(server_pub SPKI DER)[:32]         # rotation/fingerprint

The wire envelope carries only the three base64 blobs + key_id (matching the
server's ``decode_tier_c_rows`` contract). Decryption requires the RSA private key
and is a deliberately separate, privileged operator action — it lives here next to
``seal`` only so the two halves of the contract can't drift, NOT so the server (or
any uploading client) ever calls ``unseal``.

Kept dependency-light: ``cryptography`` (already a transitive dep via relay_key's
Fernet) + stdlib, no superclaw imports, so the operator-decrypt tooling and the
upload spooler can both use it without cycles.
"""
from __future__ import annotations

import base64
import binascii
import hashlib

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# OAEP with SHA-256 (NOT the SHA-1 default) for the CEK wrap.
_OAEP = padding.OAEP(
    mgf=padding.MGF1(algorithm=hashes.SHA256()),
    algorithm=hashes.SHA256(),
    label=None,
)
_NONCE_BYTES = 12  # 96-bit GCM nonce (standard)
_MIN_RSA_BITS = 3072


class EnvelopeError(ValueError):
    """A Tier C payload could not be sealed or unsealed (bad key / tamper / format)."""


def _fingerprint(pub: rsa.RSAPublicKey) -> str:
    der = pub.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()[:32]


def _load_rsa_public(public_key_pem: str) -> rsa.RSAPublicKey:
    try:
        pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise EnvelopeError(f"invalid public key PEM: {exc}") from exc
    if not isinstance(pub, rsa.RSAPublicKey):
        raise EnvelopeError("Tier C requires an RSA public key (RSA-OAEP CEK wrap)")
    if pub.key_size < _MIN_RSA_BITS:
        raise EnvelopeError(f"RSA key too small ({pub.key_size} bits; need >= {_MIN_RSA_BITS})")
    return pub


def key_id_for(public_key_pem: str) -> str:
    """Stable fingerprint of a public key: SHA-256 of its DER SubjectPublicKeyInfo,
    first 32 hex chars. This IS the ``key_id`` — it is derived from the key, never
    free-chosen, so a tampered key_id can be detected against the key it claims to
    name. Rotation = a new keypair (new fingerprint), advertised via ``/keys``."""
    return _fingerprint(_load_rsa_public(public_key_pem))


def is_public_key_pem(pem: str) -> bool:
    """True iff ``pem`` is a USABLE Tier C public key (RSA, >= 3072 bits). False for
    a PRIVATE key, a non-RSA key, a weak key, or junk. Callers fail closed on a
    misconfigured/swapped key BEFORE sealing under it — or, far worse on the server
    side, before publishing it: a private key fed here as 'the public key' must
    never be treated as usable."""
    if not pem or "PRIVATE KEY" in pem.upper():
        return False
    try:
        _load_rsa_public(pem)
        return True
    except EnvelopeError:
        return False


def seal(plaintext: bytes, public_key_pem: str) -> dict[str, str]:
    """Hybrid-encrypt ``plaintext`` for the holder of ``public_key_pem``'s private
    key. Returns the wire envelope: ``{ciphertext_b64, nonce_b64, wrapped_cek_b64,
    key_id}`` — exactly the fields the server's ``decode_tier_c_rows`` expects.

    ``key_id`` is ALWAYS the public-key fingerprint (never caller-chosen), so the
    operator can verify on unseal that the envelope was addressed to their key. A
    fresh CEK + nonce per call: never reuse a (key, nonce) pair under GCM."""
    if not isinstance(plaintext, (bytes, bytearray)):
        raise EnvelopeError("plaintext must be bytes")
    pub = _load_rsa_public(public_key_pem)

    cek = AESGCM.generate_key(bit_length=256)
    nonce = _urandom(_NONCE_BYTES)
    ciphertext = AESGCM(cek).encrypt(nonce, bytes(plaintext), None)
    try:
        wrapped = pub.encrypt(cek, _OAEP)
    except ValueError as exc:  # pragma: no cover - key too small for OAEP padding
        raise EnvelopeError(f"CEK wrap failed: {exc}") from exc
    return {
        "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
        "nonce_b64": base64.b64encode(nonce).decode("ascii"),
        "wrapped_cek_b64": base64.b64encode(wrapped).decode("ascii"),
        "key_id": _fingerprint(pub),
    }


def unseal(envelope: dict[str, str], private_key_pem: str) -> bytes:
    """Operator-only: recover the plaintext using the RSA private key. Fails CLOSED
    on a wrong key, a weak key, a corrupt/oversized envelope, a key_id that doesn't
    name this key, or any tamper — every failure path raises ``EnvelopeError``,
    NEVER a bare library exception and never garbage plaintext."""
    try:
        priv = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    except (ValueError, TypeError) as exc:
        raise EnvelopeError(f"invalid private key PEM: {exc}") from exc
    if not isinstance(priv, rsa.RSAPrivateKey):
        raise EnvelopeError("Tier C requires an RSA private key")
    # Symmetric to seal(): refuse a downgraded key on the decrypt side too, so a
    # weak-key envelope can never be unsealed even by a willing operator.
    if priv.key_size < _MIN_RSA_BITS:
        raise EnvelopeError(
            f"RSA private key too small ({priv.key_size} bits; need >= {_MIN_RSA_BITS})"
        )
    # key_id binding: the envelope must be addressed to THIS key. key_id is the
    # public-key fingerprint, so a tampered/misrouted key_id is caught here rather
    # than silently 'working' because the private key happened to unwrap it.
    expected = _fingerprint(priv.public_key())
    if envelope.get("key_id") != expected:
        raise EnvelopeError("key_id does not name this key (wrong key or tampered routing)")
    try:
        wrapped = base64.b64decode(envelope["wrapped_cek_b64"], validate=True)
        nonce = base64.b64decode(envelope["nonce_b64"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext_b64"], validate=True)
    except (KeyError, binascii.Error, ValueError) as exc:
        raise EnvelopeError(f"malformed envelope: {exc}") from exc
    try:
        cek = priv.decrypt(wrapped, _OAEP)
    except ValueError as exc:
        raise EnvelopeError("CEK unwrap failed (wrong key or corrupt wrapped_cek)") from exc
    try:
        # AESGCM.decrypt raises InvalidTag on tamper, AND ValueError on a malformed
        # nonce/CEK length — both must fail closed as EnvelopeError.
        return AESGCM(cek).decrypt(nonce, ciphertext, None)
    except (InvalidTag, ValueError) as exc:
        raise EnvelopeError("ciphertext authentication failed (tampered or wrong CEK)") from exc


def generate_keypair(bits: int = _MIN_RSA_BITS) -> tuple[str, str]:
    """Generate an ``(public_pem, private_pem)`` RSA keypair for operator key
    provisioning and tests.

    The PUBLIC half is baked into clients (``environment.py``) and advertised by the
    collector's ``/keys``. The PRIVATE half (unencrypted PKCS#8 here) is the
    zero-knowledge boundary's secret: it belongs ONLY in offline operator escrow /
    an HSM, gated by the §8.3 unseal-authorization policy. It must NEVER be placed
    on the collector server (which would defeat zero-knowledge) NOR on any client.
    The caller is responsible for that storage; this function only mints the pair."""
    if bits < _MIN_RSA_BITS:
        raise EnvelopeError(f"refusing to generate a key smaller than {_MIN_RSA_BITS} bits")
    priv = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    private_pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return public_pem, private_pem


def _urandom(n: int) -> bytes:
    # Indirection kept so tests can assert nonce length without monkeypatching os.
    import os

    return os.urandom(n)
