"""Contract tests for the trust-chain canonicalization / envelope primitives.

These golden vectors are the CROSS-REPO contract: clawhunt's signer must produce
byte-identical canonical JSON. The expected strings here are hand-verified (not
generated from the implementation), so a regression in the canonicalizer is caught.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.trust_contracts import (
    TrustContractError,
    add_signature,
    compute_keyid,
    encode_public_key,
    generate_ed25519_keypair,
    jcs_canonicalize,
    nfc_normalize,
    sign_envelope,
    verify_envelope,
)


def _fixed_key(seed: bytes) -> Ed25519PrivateKey:
    # Deterministic key from a fixed seed so golden signatures are reproducible.
    return Ed25519PrivateKey.from_private_bytes(seed)


def test_sign_envelope_round_trips_through_verify():
    private_key, public = generate_ed25519_keypair()
    keyid = compute_keyid(public)
    env = sign_envelope({"type": "root", "version": 1}, private_key)
    assert env["signatures"][0]["keyid"] == keyid  # keyid binds to the public key
    assert verify_envelope(env, {keyid: {"public_key": public}}) == {keyid}


def test_encode_public_key_shape():
    _, public = generate_ed25519_keypair()
    assert public.startswith("ed25519:")
    assert len(public) == len("ed25519:") + 44  # 32 raw bytes -> 44 base64 chars


def test_sign_is_deterministic_ed25519():
    key = _fixed_key(b"\x01" * 32)
    a = sign_envelope({"type": "timestamp", "version": 1}, key)
    b = sign_envelope({"type": "timestamp", "version": 1}, key)
    assert a == b  # RFC 8032 deterministic — golden vectors are stable


def test_tampered_signed_fails_verify():
    private_key, public = generate_ed25519_keypair()
    keyid = compute_keyid(public)
    env = sign_envelope({"type": "root", "version": 1}, private_key)
    env["signed"]["version"] = 2  # tamper after signing
    with pytest.raises(TrustContractError):
        verify_envelope(env, {keyid: {"public_key": public}})


def test_add_signature_enables_threshold_and_dedupes():
    k1, p1 = generate_ed25519_keypair()
    k2, p2 = generate_ed25519_keypair()
    id1, id2 = compute_keyid(p1), compute_keyid(p2)
    env = sign_envelope({"type": "root", "version": 1}, k1)
    add_signature(env, k2)
    keys = {id1: {"public_key": p1}, id2: {"public_key": p2}}
    assert verify_envelope(env, keys, threshold=2) == {id1, id2}
    # Re-adding the same key must not inflate the signature count.
    before = len(env["signatures"])
    add_signature(env, k1)
    assert len(env["signatures"]) == before


def test_sign_envelope_rejects_non_dict_signed():
    private_key, _ = generate_ed25519_keypair()
    with pytest.raises(TrustContractError):
        sign_envelope(["not", "a", "dict"], private_key)


def test_sign_envelope_public_key_matches_encode():
    private_key, public = generate_ed25519_keypair()
    assert encode_public_key(private_key.public_key()) == public


def test_compute_keyid_rejects_bare_base64_public_key():
    _, public = generate_ed25519_keypair()
    bare = public.removeprefix("ed25519:")  # same physical key, no prefix
    with pytest.raises(TrustContractError):
        compute_keyid(bare)


def test_compute_keyid_rejects_wrong_length_public_key():
    with pytest.raises(TrustContractError):
        compute_keyid("ed25519:" + base64.b64encode(b"\x00" * 31).decode())


def test_public_key_alias_cannot_inflate_threshold():
    # Same physical key under two encodings (canonical + bare) must NOT count twice.
    private_key, public = generate_ed25519_keypair()
    keyid = compute_keyid(public)
    signed = {"type": "root", "version": 1}
    s = base64.b64encode(private_key.sign(jcs_canonicalize(nfc_normalize(signed)))).decode()
    sig = "ed25519:" + s
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": sig},
                                            {"keyid": "sha256:" + "f" * 64, "sig": sig}]}
    # A bare-base64 alias key in the keyset is non-canonical -> skipped (fail-closed),
    # so it can never become a second distinct signing authority.
    keys = {keyid: {"public_key": public},
            "sha256:" + "f" * 64: {"public_key": public.removeprefix("ed25519:")}}
    with pytest.raises(TrustContractError):
        verify_envelope(env, keys, threshold=2)
    assert verify_envelope(env, keys, threshold=1) == {keyid}


def test_add_signature_repairs_bad_same_keyid_entry():
    private_key, public = generate_ed25519_keypair()
    keyid = compute_keyid(public)
    # Pre-seed a corrupt signature under the right keyid.
    env = {"signed": {"type": "root", "version": 1},
           "signatures": [{"keyid": keyid, "sig": "ed25519:" + "A" * 86 + "=="}]}
    add_signature(env, private_key)  # must replace the bad entry with a valid one
    assert len(env["signatures"]) == 1
    assert verify_envelope(env, {keyid: {"public_key": public}}) == {keyid}

# (name, input value, expected canonical JSON string) — hand-verified.
_GOLDEN = [
    ("key_sort", {"b": 1, "a": 2}, '{"a":2,"b":1}'),
    # Nested non-BMP key ordering: emoji U+1F600 (UTF-16 D83D…) sorts BEFORE
    # fullwidth stop U+FF0E under UTF-16 code-unit order (the opposite of code
    # point order). This is the cross-stack Python↔JS divergence guard.
    ("nested_non_bmp", {"x": {"\U0001F600": 1, "．": 2}}, '{"x":{"😀":1,"．":2}}'),
    ("escapes", {"k": 'a"\\\n\x01'}, '{"k":"a\\"\\\\\\n\\u0001"}'),
    (
        "big_int_as_string",
        {"n": 9007199254740991, "big": "9007199254740993"},
        '{"big":"9007199254740993","n":9007199254740991}',
    ),
    ("array_and_scalars", ["z", "a", {"k": True, "n": None}], '["z","a",{"k":true,"n":null}]'),
]


@pytest.mark.parametrize("name,value,expected", _GOLDEN, ids=[g[0] for g in _GOLDEN])
def test_jcs_golden_vectors(name, value, expected):
    assert jcs_canonicalize(value).decode("utf-8") == expected


def test_jcs_golden_fixture_file_matches():
    """The shipped cross-repo fixture must equal the implementation output."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "trust" / "jcs_golden.json").read_text("utf-8"))
    for entry in fixture["vectors"]:
        assert jcs_canonicalize(entry["input"]).decode("utf-8") == entry["expected"], entry["name"]


def test_jcs_rejects_floats_and_unsafe_ints():
    for bad in (1.5, float("nan"), float("inf"), 2**53, -(2**53)):
        with pytest.raises(TrustContractError):
            jcs_canonicalize({"x": bad})


def test_jcs_rejects_non_string_keys():
    with pytest.raises(TrustContractError):
        jcs_canonicalize({1: "x"})


def test_nfc_is_separate_pre_signing_step():
    # Combining sequence "e" + U+0301 normalizes to precomposed "é"; JCS itself
    # must NOT do this — only nfc_normalize does.
    decomposed = "café"
    assert nfc_normalize(decomposed) == "café"
    # jcs over the raw (un-normalized) string keeps it as-is (no normalization).
    assert jcs_canonicalize(decomposed).decode("utf-8") == '"café"'


def test_compute_keyid_is_deterministic_and_binds_fields():
    _, pub_a, _ = _make_key()
    _, pub_b, _ = _make_key()
    a = compute_keyid(pub_a)
    assert a == compute_keyid(pub_a)
    assert a.startswith("sha256:")
    # Different public key → different keyid.
    assert a != compute_keyid(pub_b)
    # Different scheme → different keyid (scheme is bound into the keyid payload).
    assert a != compute_keyid(pub_a, scheme="other")


def _make_key():
    priv = Ed25519PrivateKey.generate()
    pub = "ed25519:" + base64.b64encode(
        priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    keyid = compute_keyid(pub)
    return priv, pub, keyid


def _sign(priv, signed):
    sig = base64.b64encode(priv.sign(jcs_canonicalize(signed))).decode()
    return "ed25519:" + sig


def test_verify_envelope_happy_path():
    priv, pub, keyid = _make_key()
    signed = {"spec_version": "1.0", "type": "root", "version": 1}
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": _sign(priv, signed)}]}
    assert verify_envelope(env, {keyid: {"public_key": pub}}) == {keyid}


def test_verify_envelope_rejects_tamper():
    priv, pub, keyid = _make_key()
    signed = {"type": "root", "version": 1}
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": _sign(priv, signed)}]}
    env["signed"]["version"] = 2  # tamper after signing
    with pytest.raises(TrustContractError):
        verify_envelope(env, {keyid: {"public_key": pub}})


def test_verify_envelope_ignores_unknown_and_spoofed_keyid():
    priv, pub, keyid = _make_key()
    signed = {"type": "root"}
    # Valid signature but registered under a SPOOFED keyid that does not bind to pub.
    env = {"signed": signed, "signatures": [{"keyid": "sha256:deadbeef", "sig": _sign(priv, signed)}]}
    with pytest.raises(TrustContractError):
        verify_envelope(env, {"sha256:deadbeef": {"public_key": pub}})


def test_verify_envelope_rejects_nonpositive_threshold():
    priv, pub, keyid = _make_key()
    env = {"signed": {"type": "root"}, "signatures": []}
    # threshold<=0 must NOT let an empty signatures list "verify" (fail-closed).
    for bad in (0, -1, True, False, 1.0):
        with pytest.raises(TrustContractError):
            verify_envelope(env, {keyid: {"public_key": pub}}, threshold=bad)


def test_nfc_key_collision_fails_closed():
    # Two distinct raw keys (precomposed "é" U+00E9 vs decomposed "e"+U+0301) that
    # NFC-fold to the same key must raise, not silently drop a field.
    colliding = {"é": "v", "é": "w"}
    assert len(colliding) == 2
    with pytest.raises(TrustContractError):
        nfc_normalize(colliding)


def test_nfc_normalize_rejects_tuple_in_real_path():
    # The real signing path is jcs_canonicalize(nfc_normalize(payload)); a tuple
    # must be rejected there too, not silently list-ified.
    with pytest.raises(TrustContractError):
        nfc_normalize({"x": ("a", "b")})


def test_verify_envelope_nfc_collision_signed_is_rejected():
    priv, pub, keyid = _make_key()
    # An attacker raw-signs a payload with two NFC-colliding keys; the envelope
    # verifier must NFC-normalize first and fail closed on the collision.
    signed = {"é": 1, "é": 2}
    assert len(signed) == 2
    raw_sig = "ed25519:" + base64.b64encode(priv.sign(jcs_canonicalize(signed))).decode()
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": raw_sig}]}
    with pytest.raises(TrustContractError):
        verify_envelope(env, {keyid: {"public_key": pub}})


def test_verify_envelope_rejects_non_ed25519_keytype():
    priv, pub, _ = _make_key()
    # Ed25519 key material but the key entry mislabels itself rsa: keyid must be
    # computed over the declared fields AND the verifier must refuse non-ed25519.
    keyid = compute_keyid(pub, keytype="rsa", scheme="rsa")
    signed = {"type": "root"}
    raw_sig = "ed25519:" + base64.b64encode(priv.sign(jcs_canonicalize(signed))).decode()
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": raw_sig}]}
    with pytest.raises(TrustContractError):
        verify_envelope(env, {keyid: {"public_key": pub, "keytype": "rsa", "scheme": "rsa"}})


def test_jcs_rejects_tuple_and_lone_surrogate():
    with pytest.raises(TrustContractError):
        jcs_canonicalize(("a", "b"))
    with pytest.raises(TrustContractError):
        jcs_canonicalize({"k": "\ud800"})  # lone high surrogate
    with pytest.raises(TrustContractError):
        jcs_canonicalize({"\ud800": "v"})  # lone surrogate in key


def test_verify_envelope_no_threshold_inflation_by_repeated_keyid():
    priv, pub, keyid = _make_key()
    signed = {"type": "root"}
    s = _sign(priv, signed)
    env = {"signed": signed, "signatures": [{"keyid": keyid, "sig": s}, {"keyid": keyid, "sig": s}]}
    # Two copies of the same keyid must not satisfy threshold=2.
    with pytest.raises(TrustContractError):
        verify_envelope(env, {keyid: {"public_key": pub}}, threshold=2)
    # threshold=1 still passes, counted once.
    assert verify_envelope(env, {keyid: {"public_key": pub}}, threshold=1) == {keyid}
