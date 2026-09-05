"""Verify SuperClaw independently validates a capability's OFFICIAL co-signature.

The GOLDEN vector below was produced by ClawHunt's INDEPENDENT signer
(``backend/utils/trust_signing.sign_envelope``) using the real product official
key, signing over ``capability_signed_core(...)``. SuperClaw's verifier
(``capability_cosign.verify_official_cosignature`` + ``trust_contracts``) must
accept it — that is the cross-implementation interop proof the whole trust chain
rests on. Every tampering / wrong-key / missing-field path must fail closed.
"""

from __future__ import annotations

import copy

from superclaw.capability_cosign import verify_official_cosignature

# --- Golden: a real ClawHunt-signed official co-signature (product official key) ---
_OFFICIAL_PUB = "za6+eU91Bswm6PGqAxjeSYQu6UG6NIiNG6grhtcfwcY="
_OFFICIAL_KEYID = "sha256:74126f70d0f5bb6a73bc66b0a23718c3fb0ea84a01494c7f3a55a0812e058675"
_OFFICIAL_SIG = "ed25519:4qhW2MU090A1hqQ43ZATm6ob9zakvrZBiIH0R5nugAEaOCODik9yzY2pi3Q5ZTKGXogxSJTVZzWU6VbkrJOWAw=="

_GOLDEN_ENTRY = {
    "kind": "plugin",
    "capability_id": "dev.demo.net",
    "version": "1.0.0",
    "package_digest": "sha256:" + ("ab" * 32),
    "artifact_ref": "superclaw-object://capabilities/plugin/dev.demo.net/versions/1.0.0/package.scplug",
    "official_signature": _OFFICIAL_SIG,
    "official_signer_keyid": _OFFICIAL_KEYID,
}


# Golden #2: real ClawHunt signature over a core that INCLUDES the optional
# blob_digest + length fields (the published-feed path Codex flagged as uncovered).
_FULL_ENTRY = {
    "kind": "plugin",
    "capability_id": "dev.demo.full",
    "version": "2.0.0",
    "package_digest": "sha256:" + ("ab" * 32),
    "artifact_ref": "superclaw-object://capabilities/plugin/dev.demo.full/versions/2.0.0/package.scplug",
    "blob_digest": "sha256:" + ("cd" * 32),
    "length": 4096,
    "official_signature": "ed25519:tT9BqE8LbBLomeoeJofjNPBuLF0m9X617z2x6Ribb1XiWoXwKYjUKwRVFx+7hQbM7fZ3iglXtah79xEKYV8xAg==",
    "official_signer_keyid": _OFFICIAL_KEYID,
}


def test_real_clawhunt_cosignature_with_blob_and_length_verifies():
    # The optional-field path verifies end-to-end against the baked key.
    assert verify_official_cosignature(_FULL_ENTRY, official_public_key=_OFFICIAL_PUB) is True


def test_tampering_optional_fields_rejected():
    # blob_digest / length are part of the signed core when present: changing or
    # dropping either breaks the signature (no false accept, no silent drop).
    for mutate in (
        lambda e: e.__setitem__("blob_digest", "sha256:" + ("ef" * 32)),
        lambda e: e.__setitem__("length", 4097),
        lambda e: e.pop("blob_digest"),
        lambda e: e.pop("length"),
    ):
        e = copy.deepcopy(_FULL_ENTRY)
        mutate(e)
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False


def test_non_canonical_signature_shape_rejected():
    # Strict shape: bare (no ed25519: prefix), wrong length, non-canonical base64.
    bare = _OFFICIAL_SIG[len("ed25519:"):]
    for bad in (bare, "ed25519:" + "AA", "ed25519:not-base64!!", _OFFICIAL_SIG + "extra"):
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e["official_signature"] = bad
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False, bad


def test_missing_required_field_fails_closed_structurally():
    # A missing identity field must be rejected up front (never coerced to "None").
    for field in ("kind", "capability_id", "version", "artifact_ref", "package_digest"):
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e.pop(field)
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False, field
    # A non-string identity field (type confusion) is likewise rejected.
    for field in ("kind", "capability_id", "version", "artifact_ref"):
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e[field] = {"x": 1}
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False, field


def test_plugin_id_does_not_alias_missing_capability_id():
    # The verification boundary signs over capability_id specifically; a missing
    # capability_id must fail closed even when a plugin_id alias is present (no
    # presentation-layer fallback may relax what counts as the signed identity).
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["plugin_id"] = e["capability_id"]
    e.pop("capability_id")
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False


def test_wrong_type_optional_fields_fail_closed():
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["blob_digest"] = {"x": 1}
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["length"] = "4096"
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["length"] = True  # bool is an int subclass — must NOT be accepted as length
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False


def test_real_clawhunt_cosignature_verifies():
    # Cross-impl interop: a signature minted by ClawHunt's signer verifies under
    # SuperClaw's independent verifier against the baked official public key.
    assert verify_official_cosignature(_GOLDEN_ENTRY, official_public_key=_OFFICIAL_PUB) is True


def test_bare_or_prefixed_public_key_both_accepted():
    # The baked key is bare base64; an ``ed25519:``-prefixed form is equivalent.
    assert verify_official_cosignature(_GOLDEN_ENTRY, official_public_key=f"ed25519:{_OFFICIAL_PUB}") is True


def test_no_trust_root_fails_closed():
    # No baked key (e.g. production pre-bake) -> never endorsed.
    assert verify_official_cosignature(_GOLDEN_ENTRY, official_public_key="") is False
    assert verify_official_cosignature(_GOLDEN_ENTRY, official_public_key=None) is False


def test_wrong_official_key_rejected():
    # A different (valid-shape) key whose keyid will not match the claimed signer.
    other = "MmPYuR66nJZ+KvWeZD7Zs0nzcKY8iGSCrHj1+ZYXLK4="
    assert verify_official_cosignature(_GOLDEN_ENTRY, official_public_key=other) is False


def test_tampered_identity_rejected():
    # Swapping any signed field (artifact_ref / version / digest / id) breaks the
    # signature — the core no longer matches what was signed.
    for field, bad in [
        ("artifact_ref", "superclaw-object://capabilities/plugin/evil/versions/1.0.0/package.scplug"),
        ("version", "9.9.9"),
        ("package_digest", "sha256:" + ("cd" * 32)),
        ("capability_id", "dev.demo.evil"),
        ("kind", "skill"),
    ]:
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e[field] = bad
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False, field


def test_claimed_keyid_must_be_our_baked_key():
    # A signature whose claimed signer keyid is not our baked key's keyid is not an
    # OFFICIAL endorsement, even if the bytes were otherwise well-formed.
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["official_signer_keyid"] = "sha256:" + ("00" * 32)
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False


def test_missing_or_nonstring_signature_material_rejected():
    for field in ("official_signature", "official_signer_keyid"):
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e.pop(field)
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False
    for bad in (None, 123, {"x": 1}, ["a"], ""):
        e = copy.deepcopy(_GOLDEN_ENTRY)
        e["official_signature"] = bad
        assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False


def test_malformed_core_fields_fail_closed():
    # A non-sha256 package_digest (or missing identity) can't build a valid core.
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["package_digest"] = "not-a-digest"
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False
    e = copy.deepcopy(_GOLDEN_ENTRY)
    e["artifact_ref"] = ""
    assert verify_official_cosignature(e, official_public_key=_OFFICIAL_PUB) is False
