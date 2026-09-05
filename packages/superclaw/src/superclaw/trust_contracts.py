"""Capability Workshop trust-chain contract primitives (Phase 1 foundation).

The single, cross-repo source of truth for how trust metadata is canonicalized,
how keyids are derived, and how signed envelopes verify. superclaw (verify side)
and clawhunt (sign side) MUST produce byte-identical canonical JSON; the golden
vectors in tests/fixtures/trust/ lock that down.

Design: docs/capability-trust-chain-design.md (v7, 7-round dual-advisor PASS).

Canonicalization rules (RFC 8785 / JCS, with deliberate SuperClaw constraints):
  - NFC normalization is a SEPARATE pre-signing step (``nfc_normalize``); JCS
    itself does NOT normalize Unicode.
  - Object property names are sorted by **UTF-16 code units** (RFC 8785 §3.2.3),
    NOT Unicode code points — otherwise Python (code point) and JS (UTF-16)
    diverge on non-BMP keys and signatures fail cross-stack.
  - Numbers: floats / NaN / Inf are REJECTED. Integers are allowed only within
    the JS safe-integer range; anything larger (and all monetary amounts, in the
    smallest currency unit) MUST be carried as a decimal string by the caller.
  - Strings use ECMAScript JSON.stringify escaping (the RFC 8785 string rule).
"""

from __future__ import annotations

import base64
import hashlib
import re
import unicodedata
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


SPEC_VERSION = "1.0"

# Trust channels (channel-scoped watermark / freshness — see design §3).
CHANNEL_BUNDLED = "bundled"
CHANNEL_REMOTE = "remote"
CHANNELS = (CHANNEL_BUNDLED, CHANNEL_REMOTE)

# Metadata roles.
ROLE_ROOT = "root"
ROLE_TARGETS = "targets"
ROLE_SNAPSHOT = "snapshot"
ROLE_TIMESTAMP = "timestamp"
ROLES = (ROLE_ROOT, ROLE_TARGETS, ROLE_SNAPSHOT, ROLE_TIMESTAMP)

KEYTYPE_ED25519 = "ed25519"
SCHEME_ED25519 = "ed25519"

# sha256:<64 lowercase hex> — the digest shape bound by ``capability_signed_core``.
# Kept here so the signed-core builder is dependency-free and cross-repo identical.
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# JS Number.MAX_SAFE_INTEGER. Integers outside [-MAX, MAX] must be decimal strings.
_MAX_SAFE_INTEGER = 2**53 - 1

# ECMAScript JSON.stringify short escapes (RFC 8785 §3.2.2.2).
_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


class TrustContractError(ValueError):
    """Raised when a value cannot be canonicalized or an envelope is malformed."""


def nfc_normalize(value: Any) -> Any:
    """Pre-signing data-model normalization: NFC-normalize every string in the tree.

    This is intentionally a separate step from JCS canonicalization (JCS does not
    do Unicode normalization). Apply it to the data model BEFORE serializing, so
    both the signer and verifier operate on the same normalized strings.
    """
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise TrustContractError("object keys must be strings")
            nk = unicodedata.normalize("NFC", k)
            if nk in result:
                # Two distinct raw keys that NFC-fold to the same key would let a
                # field be silently dropped — fail closed instead (Codex r-impl1).
                raise TrustContractError(f"NFC key collision after normalization: {nk!r}")
            result[nk] = nfc_normalize(v)
        return result
    if isinstance(value, list):
        return [nfc_normalize(v) for v in value]
    if isinstance(value, tuple):
        # Reject (not silently list-ify) so a Python-only form cannot enter the
        # cross-repo contract even via the normalization path (Codex r-impl1b).
        raise TrustContractError("tuples are not a JSON type; use a list")
    return value


def _escape_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        short = _SHORT_ESCAPES.get(code)
        if short is not None:
            out.append(short)
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _serialize(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return _escape_string(value)
    # bool is a subclass of int — handled above, so a bare int here is a real int.
    if isinstance(value, int):
        if not (-_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER):
            raise TrustContractError(
                "integer outside JS safe range; carry it as a decimal string instead"
            )
        return str(value)
    if isinstance(value, float):
        raise TrustContractError(
            "floats are not permitted in trust metadata (use integer minor units "
            "or a decimal string)"
        )
    if isinstance(value, list):
        return "[" + ",".join(_serialize(v) for v in value) + "]"
    if isinstance(value, tuple):
        # Reject tuples: a Python-only form must not enter the cross-repo contract.
        # nfc_normalize also rejects them, so neither path silently list-ifies a
        # tuple (Codex impl review).
        raise TrustContractError("tuples are not a JSON type; use a list")
    if isinstance(value, dict):
        items = []
        for key in _sorted_keys(value):
            items.append(_escape_string(key) + ":" + _serialize(value[key]))
        return "{" + ",".join(items) + "}"
    raise TrustContractError(f"unsupported type for canonical JSON: {type(value).__name__}")


def _sorted_keys(obj: dict[Any, Any]) -> list[str]:
    keys = []
    for key in obj:
        if not isinstance(key, str):
            raise TrustContractError("object keys must be strings")
        keys.append(key)
    # RFC 8785 §3.2.3: sort by UTF-16 code units. Comparing the UTF-16-BE byte
    # encoding is exactly UTF-16 code-unit lexicographic order (and differs from
    # Python's default code-point order on non-BMP keys).
    try:
        keys.sort(key=lambda k: k.encode("utf-16-be"))
    except UnicodeEncodeError as exc:
        raise TrustContractError("object key contains invalid Unicode (lone surrogate)") from exc
    return keys


def jcs_canonicalize(value: Any) -> bytes:
    """Serialize a JSON-compatible value to RFC 8785 (JCS) canonical UTF-8 bytes.

    Caller is responsible for pre-signing NFC normalization (``nfc_normalize``);
    this function does NOT normalize Unicode (per JCS). Floats are rejected.
    """
    try:
        return _serialize(value).encode("utf-8")
    except UnicodeEncodeError as exc:
        # Lone/invalid surrogates can't UTF-8 encode — surface as a contract error,
        # not a raw UnicodeEncodeError (uniform error surface, Codex r-impl1).
        raise TrustContractError("value contains invalid Unicode (lone surrogate)") from exc


def _canonical_ed25519_public_key(material: str) -> str:
    """Normalize+validate Ed25519 public material to the SINGLE canonical form
    ``ed25519:<standard base64 of 32 raw bytes>``.

    Rejects bare base64 (no ``ed25519:`` prefix), wrong byte length, and
    non-canonical base64. This guarantees one physical key maps to exactly one
    keyid — otherwise ``ed25519:<b64>`` and bare ``<b64>`` would decode to the same
    key but hash to two distinct keyids, inflating signature thresholds
    (Codex r-impl4a: "distinct keyid = distinct signing authority").
    """
    if not isinstance(material, str) or not material.startswith("ed25519:"):
        raise TrustContractError("ed25519 public key must use the 'ed25519:' prefix")
    raw_b64 = material[len("ed25519:"):]
    try:
        raw = base64.b64decode(raw_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise TrustContractError("invalid ed25519 public key base64") from exc
    if len(raw) != 32:
        raise TrustContractError("ed25519 public key must be 32 bytes")
    if base64.b64encode(raw).decode("ascii") != raw_b64:
        raise TrustContractError("ed25519 public key base64 is not canonical")
    return material


def compute_keyid(public_key: str, *, keytype: str = KEYTYPE_ED25519, scheme: str = SCHEME_ED25519) -> str:
    """keyid = sha256( JCS({keytype, scheme, public_key}) ) — a canonical JSON
    object hash, never an undefined concatenation (design §2 / Codex r7).

    ``public_key`` is canonicalized first (``_canonical_ed25519_public_key``) so
    that aliased encodings of the same physical key cannot produce different keyids.
    """
    canonical = _canonical_ed25519_public_key(public_key)
    payload = {"keytype": keytype, "scheme": scheme, "public_key": canonical}
    return "sha256:" + hashlib.sha256(jcs_canonicalize(payload)).hexdigest()


def encode_public_key(public_key: Ed25519PublicKey) -> str:
    """Serialize a raw Ed25519 public key to the ``ed25519:<base64>`` material form
    used everywhere in trust metadata (32 raw bytes -> standard padded base64)."""
    raw = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    return "ed25519:" + base64.b64encode(raw).decode("ascii")


def generate_ed25519_keypair() -> tuple[Ed25519PrivateKey, str]:
    """Generate an Ed25519 keypair, returning ``(private_key, public_key_material)``.

    Only the public material (``ed25519:<base64>``) is ever published; the private
    key stays with the signer (offline root / online role / developer-local).
    """
    private_key = Ed25519PrivateKey.generate()
    return private_key, encode_public_key(private_key.public_key())


def _sign_message(signed: dict[str, Any], private_key: Ed25519PrivateKey) -> str:
    # Symmetric with verify_envelope: sign over JCS(NFC(signed)). nfc_normalize
    # also raises on an NFC key collision, so the sign side cannot mint bytes the
    # verify side would reject for a different reason.
    message = jcs_canonicalize(nfc_normalize(signed))
    return "ed25519:" + base64.b64encode(private_key.sign(message)).decode("ascii")


def sign_envelope(signed: dict[str, Any], private_key: Ed25519PrivateKey) -> dict[str, Any]:
    """Produce a ``{signed, signatures:[{keyid, sig}]}`` envelope that
    ``verify_envelope`` accepts. The keyid is derived from (and binds to) the
    public key of ``private_key`` via ``compute_keyid`` (no spoofing); the signature
    is Ed25519 over ``JCS(NFC(signed))``.

    The public key is always derived from the private key — there is no caller
    override, so the keyid can never disagree with the key that actually signed
    (Codex r-impl4a). Ed25519 is deterministic (RFC 8032), so the same key + payload
    yields identical bytes — golden vectors are reproducible across superclaw and
    clawhunt.
    """
    if not isinstance(signed, dict):
        raise TrustContractError("signed payload must be an object")
    public_key = encode_public_key(private_key.public_key())
    keyid = compute_keyid(public_key)
    return {"signed": signed, "signatures": [{"keyid": keyid, "sig": _sign_message(signed, private_key)}]}


def add_signature(envelope: dict[str, Any], private_key: Ed25519PrivateKey) -> dict[str, Any]:
    """Ensure this key's VALID signature over the envelope's ``signed`` payload is
    present (threshold / root-rotation co-signing). Mutates and returns ``envelope``.

    If an entry with this keyid already exists it is REPLACED with the freshly
    computed signature (idempotent under Ed25519 determinism, and repairs a bad or
    foreign same-keyid entry instead of trusting it); otherwise a new entry is
    appended. A physical key therefore contributes exactly one valid signature — no
    threshold inflation, mirroring verify_envelope's distinct-keyid counting
    (Codex r-impl4a)."""
    if not isinstance(envelope, dict) or not isinstance(envelope.get("signed"), dict):
        raise TrustContractError("envelope must have an object 'signed'")
    signatures = envelope.setdefault("signatures", [])
    if not isinstance(signatures, list):
        raise TrustContractError("envelope 'signatures' must be an array")
    public_key = encode_public_key(private_key.public_key())
    keyid = compute_keyid(public_key)
    sig = _sign_message(envelope["signed"], private_key)
    for entry in signatures:
        if isinstance(entry, dict) and entry.get("keyid") == keyid:
            entry["sig"] = sig
            return envelope
    signatures.append({"keyid": keyid, "sig": sig})
    return envelope


def _decode_ed25519_public_key(public_key: str) -> Ed25519PublicKey:
    # Canonical-only: bare base64 is rejected here too, so the verifier never
    # accepts a key form that compute_keyid would hash to a different keyid.
    canonical = _canonical_ed25519_public_key(public_key)
    raw = base64.b64decode(canonical[len("ed25519:"):], validate=True)
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_envelope(envelope: dict[str, Any], keys: dict[str, dict[str, Any]], *, threshold: int = 1) -> set[str]:
    """Verify a ``{signed, signatures}`` envelope and return the set of keyids
    whose Ed25519 signature over ``JCS(signed)`` checks out.

    Fail-closed: raises ``TrustContractError`` if fewer than ``threshold`` DISTINCT
    trusted keyids verify. ``keys`` maps keyid -> {public_key, keytype, scheme}.
    Signatures from unknown keyids, or that do not verify, are ignored (never
    counted). A signature is counted at most once per keyid (no threshold inflation
    by repeating the same keyid).
    """
    # Fail-closed on a non-positive / non-int threshold: threshold<=0 would let an
    # empty signatures list "verify" (real bypass if a schema forgets minimum:1).
    # bool is an int subclass — reject it explicitly (Codex r-impl1).
    if isinstance(threshold, bool) or not isinstance(threshold, int) or threshold < 1:
        raise TrustContractError("threshold must be a positive integer")
    if not isinstance(envelope, dict):
        raise TrustContractError("envelope must be an object")
    signed = envelope.get("signed")
    signatures = envelope.get("signatures")
    if not isinstance(signed, dict) or not isinstance(signatures, list):
        raise TrustContractError("envelope must have object 'signed' and array 'signatures'")
    # Enforce the design's "NFC pre-normalize, then JCS" rule at the envelope layer:
    # nfc_normalize raises on an NFC key collision / non-JSON form, so a raw-signed
    # non-normalized payload cannot bypass the collision guard here (Codex r-impl1b).
    message = jcs_canonicalize(nfc_normalize(signed))
    verified: set[str] = set()
    for sig in signatures:
        if not isinstance(sig, dict):
            continue
        keyid = sig.get("keyid")
        raw_sig = sig.get("sig")
        if not isinstance(keyid, str) or not isinstance(raw_sig, str) or keyid in verified:
            continue
        key = keys.get(keyid)
        if not isinstance(key, dict):
            continue
        public_key = key.get("public_key")
        if not isinstance(public_key, str):
            continue
        # Only Ed25519 is supported. A key explicitly declaring another keytype/scheme
        # is NOT trusted (fail-closed) — never fed to the Ed25519 verifier under a
        # mislabel. Adding an algorithm later means adding routing here, not relaxing.
        keytype = key.get("keytype", KEYTYPE_ED25519)
        scheme = key.get("scheme", SCHEME_ED25519)
        if keytype != KEYTYPE_ED25519 or scheme != SCHEME_ED25519:
            continue
        # keyid must actually bind to the public key it claims (no keyid spoofing).
        try:
            expected = compute_keyid(
                public_key,
                keytype=key.get("keytype", KEYTYPE_ED25519),
                scheme=key.get("scheme", SCHEME_ED25519),
            )
        except TrustContractError:
            continue  # non-canonical public key in the keyset — fail-closed, skip it
        if keyid != expected:
            continue
        try:
            signature_bytes = base64.b64decode(raw_sig.removeprefix("ed25519:"), validate=True)
            _decode_ed25519_public_key(public_key).verify(signature_bytes, message)
        except (InvalidSignature, ValueError, TypeError):
            continue
        verified.add(keyid)
    if len(verified) < threshold:
        raise TrustContractError(
            f"envelope signature threshold not met: {len(verified)}/{threshold}"
        )
    return verified


def capability_signed_core(
    *,
    kind: str,
    capability_id: str,
    version: str,
    package_digest: str,
    artifact_ref: str,
    blob_digest: str | None = None,
    length: int | None = None,
) -> dict[str, Any]:
    """The canonical trust-relevant identity a capability submission is signed over.

    This is the single cross-repo definition: ClawHunt's signer
    (``backend/utils/trust_signing.capability_signed_core``) and SuperClaw's
    verifier MUST build a byte-identical core, or the Ed25519 signature will not
    verify across the two independent re-implementations.

    Contract (kept logically identical to the ClawHunt side):
      - Required identity fields (kind/capability_id/version/package_digest/
        artifact_ref) are always present; ``artifact_ref`` is signed so swapping
        the declared storage location invalidates the signature.
      - Optional fields (blob_digest/length) are OMITTED, not set to null, when
        absent, so the core stays minimal and deterministic on both sides.
      - The signature only binds the *declared* digest strings; recomputing the
        digest from fetched bytes is the loading side's job.
      - Inputs are normalized/validated here (strip + shape checks) so neither
        side depends on the caller having pre-stripped. Fail-closed on malformed
        input.
    """
    if not isinstance(kind, str) or not kind:
        raise TrustContractError("signed core requires a non-empty kind")
    capability_id = str(capability_id).strip()
    version = str(version).strip()
    artifact_ref = str(artifact_ref).strip()
    if not capability_id or not version or not artifact_ref:
        raise TrustContractError("signed core requires capability_id, version and artifact_ref")
    if not SHA256_RE.match(str(package_digest or "")):
        raise TrustContractError("package_digest must be sha256:<hex>")
    core: dict[str, Any] = {
        "kind": kind,
        "capability_id": capability_id,
        "version": version,
        "package_digest": package_digest,
        "artifact_ref": artifact_ref,
    }
    if blob_digest is not None:
        if not SHA256_RE.match(str(blob_digest)):
            raise TrustContractError("blob_digest must be sha256:<hex>")
        core["blob_digest"] = blob_digest
    if length is not None:
        if isinstance(length, bool) or not isinstance(length, int) or length < 0:
            raise TrustContractError("length must be a non-negative integer")
        core["length"] = length
    return core
