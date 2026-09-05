"""Kernel-side verification of a capability's OFFICIAL co-signature.

ClawHunt re-signs a reviewed capability at publish time with the PRODUCT official
key, over ``trust_contracts.capability_signed_core(...)``. SuperClaw bakes that
key's PUBLIC half per environment (``environment.official_root_public_key``).

``verify_official_cosignature`` is the single place that decides whether a
published-feed entry is genuinely endorsed by THE baked official key — by
independently rebuilding the signed core and verifying the Ed25519 signature,
NOT by trusting any self-reported "verified" flag in the feed (a poisoned/MITM'd
public feed could set such a flag; only a signature that verifies against the
locally-baked key is trustworthy).

Fail-closed everywhere: a missing/short trust root, absent signature material,
malformed core, a signer keyid that is not our baked key's keyid, or a bad
signature all return ``False``. A surface may light an "officially endorsed"
badge ONLY when this returns ``True``.
"""

from __future__ import annotations

import base64
from typing import Any

from . import trust_contracts as tc


def _ed25519_material(public_key: str | None) -> str:
    """Normalize a baked public key to the ``ed25519:<base64>`` material form the
    trust primitives require. The baked ``OFFICIAL_ROOT_PUBLIC_KEYS`` values are
    bare base64; ``trust_contracts`` rejects bare keys, so prefix when needed."""
    pk = (public_key or "").strip()
    if not pk:
        return ""
    return pk if pk.startswith("ed25519:") else f"ed25519:{pk}"


def _is_canonical_ed25519_signature(sig: Any) -> bool:
    """Strict signature shape: ``ed25519:<canonical base64 of exactly 64 bytes>``.

    This boundary mirrors the ClawHunt signer's emission contract (always the
    ``ed25519:`` prefix, a 64-byte Ed25519 signature, canonical base64) — rejecting
    a bare/short/non-canonical encoding here, BEFORE delegating to the shared
    ``verify_envelope`` primitive (which we keep byte-identical to the cross-repo
    canonical version and therefore do not modify)."""
    if not isinstance(sig, str) or not sig.startswith("ed25519:"):
        return False
    raw_b64 = sig[len("ed25519:"):]
    try:
        raw = base64.b64decode(raw_b64, validate=True)
    except (ValueError, TypeError):
        return False
    if len(raw) != 64:
        return False
    return base64.b64encode(raw).decode("ascii") == raw_b64


def _nonempty_str(value: Any) -> str | None:
    """Return ``value`` only if it is a non-empty (post-strip) string, else None."""
    if isinstance(value, str) and value.strip():
        return value
    return None


def verify_official_cosignature(entry: dict[str, Any], *, official_public_key: str | None) -> bool:
    """Return ``True`` iff ``entry`` carries an official co-signature that verifies
    against ``official_public_key`` AND was produced by that exact key's keyid.

    ``entry`` is a published-capability dict (``/v1/capabilities/published`` shape):
    it must expose the trust-relevant identity (kind/capability_id/version/
    package_digest/artifact_ref, optional blob_digest/length) plus
    ``official_signature`` and ``official_signer_keyid``.
    """
    material = _ed25519_material(official_public_key)
    if not material:
        return False  # no trust root baked (e.g. production pre-bake) -> fail closed
    signature = entry.get("official_signature")
    claimed_keyid = entry.get("official_signer_keyid")
    # Strict signature shape (prefix + 64 bytes + canonical base64) and a string keyid.
    if not _is_canonical_ed25519_signature(signature) or not isinstance(claimed_keyid, str):
        return False

    try:
        expected_keyid = tc.compute_keyid(material)
    except tc.TrustContractError:
        return False
    # The co-signer MUST be our baked official key — not merely "some" valid signer.
    # A signature from any other keyid (even a real one) is not an OFFICIAL endorsement.
    if claimed_keyid != expected_keyid:
        return False

    # Structurally require every signed-core field to be the right TYPE before
    # building the core. ``capability_signed_core`` would otherwise coerce a missing
    # field via ``str(None) -> "None"`` and only fail later by signature mismatch;
    # rejecting a non-string/missing field up front is an explicit fail-closed (a
    # malformed untrusted-feed entry can never alias a real signed core).
    kind = _nonempty_str(entry.get("kind"))
    # NO ``plugin_id`` fallback at the verification boundary: ClawHunt signs the core
    # over ``capability_id`` specifically, so a missing ``capability_id`` must fail
    # closed even if a ``plugin_id`` alias is present (a presentation-layer fallback in
    # the mapper is fine, but it must never relax what we treat as signed).
    capability_id = _nonempty_str(entry.get("capability_id"))
    version = _nonempty_str(entry.get("version"))
    package_digest = _nonempty_str(entry.get("package_digest"))
    artifact_ref = _nonempty_str(entry.get("artifact_ref"))
    if not (kind and capability_id and version and package_digest and artifact_ref):
        return False
    # Optional fields: present-but-wrong-type fails closed (never silently dropped).
    blob_digest = entry.get("blob_digest")
    if blob_digest is not None and not isinstance(blob_digest, str):
        return False
    length = entry.get("length")
    if length is not None and (isinstance(length, bool) or not isinstance(length, int)):
        return False

    try:
        core = tc.capability_signed_core(
            kind=kind,
            capability_id=capability_id,
            version=version,
            package_digest=package_digest,
            artifact_ref=artifact_ref,
            blob_digest=blob_digest,
            length=length,
        )
    except tc.TrustContractError:
        return False

    envelope = {"signed": core, "signatures": [{"keyid": expected_keyid, "sig": signature}]}
    keys = {expected_keyid: {"public_key": material, "keytype": tc.KEYTYPE_ED25519, "scheme": tc.SCHEME_ED25519}}
    try:
        verified = tc.verify_envelope(envelope, keys, threshold=1)
    except tc.TrustContractError:
        return False
    return expected_keyid in verified
