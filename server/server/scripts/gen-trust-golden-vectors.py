"""Generate golden trust-contract vectors from the SuperClaw kernel so the Node
port (server/server/src/trust/*) can be byte-for-byte verified against Python.

Run with the repo .venv + worktree PYTHONPATH override (see project memory):
  PYTHONPATH=<wt>/packages/superclaw/src:<wt> .venv/bin/python \
    server/server/scripts/gen-trust-golden-vectors.py \
    server/server/src/__tests__/fixtures/trust-golden-vectors.json
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from superclaw.capability_cosign import verify_official_cosignature
from superclaw.plugins import (
    MANIFEST_NAME,
    _digest_relative_name,
    _iter_package_files,
    _mode_signal,
    compute_package_digest,
    load_plugin_package,
)
from superclaw.trust_contracts import (
    add_signature,
    capability_signed_core,
    compute_keyid,
    encode_public_key,
    jcs_canonicalize,
    nfc_normalize,
    sign_envelope,
)


def key_from_seed(seed_byte: int) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes([seed_byte]) * 32)


# Deterministic signers (Ed25519 is deterministic → reproducible vectors).
sk1 = key_from_seed(1)
sk2 = key_from_seed(2)
sk3 = key_from_seed(3)  # an untrusted/unknown key
pk1 = encode_public_key(sk1.public_key())
pk2 = encode_public_key(sk2.public_key())
pk3 = encode_public_key(sk3.public_key())
kid1 = compute_keyid(pk1)
kid2 = compute_keyid(pk2)
kid3 = compute_keyid(pk3)


def keyentry(pk: str) -> dict:
    return {"public_key": pk, "keytype": "ed25519", "scheme": "ed25519"}


# --- JCS canonicalization vectors (no NFC; jcs_canonicalize only) -------------
jcs_inputs = {
    "primitives_true": True,
    "primitives_false": False,
    "primitives_null": None,
    "int_zero": 0,
    "int_neg": -42,
    "int_max_safe": 2**53 - 1,
    "int_min_safe": -(2**53 - 1),
    "empty_object": {},
    "empty_array": [],
    "key_sorting_ascii": {"b": 1, "a": 2, "c": 3, "A": 4},
    "nested": {"z": [3, 2, {"y": 1, "x": 2}], "a": {"n": None, "m": True}},
    "string_escapes": "tab\tnewline\nquote\"backslash\\bell",
    "unicode_bmp": {"é": 1, "e": 2, "z": 3},
    # Non-BMP key (emoji U+1F600) to exercise UTF-16 code-unit (surrogate) ordering,
    # which differs from code-point ordering.
    "key_sorting_non_bmp": {"\U0001f600": 1, "￿": 2, "a": 3},
    "array_of_objects": [{"b": 1, "a": 2}, {"d": 3, "c": 4}],
    # "__proto__" / "constructor" as ordinary JSON keys — the Node port must keep them
    # as real own keys (Object.create(null)), not trip the JS prototype setter.
    "proto_pollution_keys": {"__proto__": 1, "constructor": 2, "a": 3},
}
jcs_vectors = [
    {"name": name, "input": value, "expected_hex": jcs_canonicalize(value).hex()}
    for name, value in jcs_inputs.items()
]

# --- NFC-then-JCS vectors (verify path uses jcs(nfc(x))) ----------------------
# "é" as a decomposed sequence (e + U+0301 combining acute) must NFC-fold to the
# precomposed U+00E9 before canonicalization.
nfc_inputs = {
    "decomposed_string": "é",
    "decomposed_in_object": {"café": "naïve"},
}
nfc_vectors = [
    {"name": name, "input": value, "expected_hex": jcs_canonicalize(nfc_normalize(value)).hex()}
    for name, value in nfc_inputs.items()
]

# --- keyid vectors ------------------------------------------------------------
keyid_vectors = [
    {"public_key": pk1, "keyid": kid1},
    {"public_key": pk2, "keyid": kid2},
    {"public_key": pk3, "keyid": kid3},
]

# --- verify_envelope vectors --------------------------------------------------
signed_payload = {"kind": "plugin", "id": "dev.x.y", "version": "1.0.0", "n": 7}

env1 = sign_envelope(dict(signed_payload), sk1)  # single valid sig by kid1
env2 = add_signature(json_roundtrip := json.loads(json.dumps(sign_envelope(dict(signed_payload), sk1))), sk2)
# env2 now has BOTH kid1 and kid2 valid signatures.

# Tampered: valid envelope but signed payload mutated after signing.
env_tampered = json.loads(json.dumps(env1))
env_tampered["signed"]["version"] = "9.9.9"

# Spoofed keyid: claim kid2 but sig is actually kid1's, and key entry under kid2
# carries pk1 (so compute_keyid(pk1) != kid2 → rejected as keyid spoof).
env_spoof = json.loads(json.dumps(env1))
env_spoof["signatures"][0]["keyid"] = kid2

# Duplicate keyid (same valid sig listed twice) must count once.
env_dup = json.loads(json.dumps(env1))
env_dup["signatures"].append(dict(env1["signatures"][0]))

# signed payload carrying a "__proto__" key — the verifier must canonicalize it
# byte-identically to the signer (Object.create(null) on the Node side).
env_proto = sign_envelope({"__proto__": {"x": 1}, "id": "z", "n": 1}, sk1)

keys_all = {kid1: keyentry(pk1), kid2: keyentry(pk2)}

verify_vectors = [
    {"name": "valid_single_threshold1", "envelope": env1, "keys": keys_all, "threshold": 1,
     "expect": "ok", "verified": [kid1]},
    {"name": "valid_single_threshold2_fails", "envelope": env1, "keys": keys_all, "threshold": 2,
     "expect": "fail"},
    {"name": "two_sigs_threshold2_ok", "envelope": env2, "keys": keys_all, "threshold": 2,
     "expect": "ok", "verified": sorted([kid1, kid2])},
    {"name": "tampered_payload_fails", "envelope": env_tampered, "keys": keys_all, "threshold": 1,
     "expect": "fail"},
    {"name": "spoofed_keyid_ignored_fails", "envelope": env_spoof, "keys": {kid2: keyentry(pk1)},
     "threshold": 1, "expect": "fail"},
    {"name": "unknown_keyid_ignored_fails", "envelope": env1, "keys": {kid2: keyentry(pk2)},
     "threshold": 1, "expect": "fail"},
    {"name": "duplicate_keyid_counts_once_fails_threshold2", "envelope": env_dup, "keys": keys_all,
     "threshold": 2, "expect": "fail"},
    {"name": "duplicate_keyid_threshold1_ok", "envelope": env_dup, "keys": keys_all, "threshold": 1,
     "expect": "ok", "verified": [kid1]},
    {"name": "proto_key_in_signed_ok", "envelope": env_proto, "keys": {kid1: keyentry(pk1)},
     "threshold": 1, "expect": "ok", "verified": [kid1]},
]

# --- official co-signature vectors (capability_cosign.verify_official_cosignature) --
official_sk = key_from_seed(9)
official_material = encode_public_key(official_sk.public_key())  # ed25519:<b64>
official_bare = official_material[len("ed25519:"):]  # baked keys are stored bare
official_keyid = compute_keyid(official_material)

_pkg_digest = "sha256:" + hashlib.sha256(b"pkg-bytes").hexdigest()
_blob_digest = "sha256:" + hashlib.sha256(b"blob-bytes").hexdigest()
_artifact_ref = "superclaw-object://capabilities/dev.x.tool/1.2.0/pkg.scplug"


def cosigned_entry(*, with_optional: bool) -> dict:
    core_kwargs = dict(
        kind="plugin",
        capability_id="dev.x.tool",
        version="1.2.0",
        package_digest=_pkg_digest,
        artifact_ref=_artifact_ref,
    )
    if with_optional:
        core_kwargs["blob_digest"] = _blob_digest
        core_kwargs["length"] = 4096
    core = capability_signed_core(**core_kwargs)
    sig = sign_envelope(core, official_sk)["signatures"][0]["sig"]
    entry = dict(core)
    entry["official_signature"] = sig
    entry["official_signer_keyid"] = official_keyid
    return entry


valid_entry = cosigned_entry(with_optional=False)
valid_entry_optional = cosigned_entry(with_optional=True)

# Tampered: flip a signed field after signing → signature no longer matches the core.
tampered_entry = dict(valid_entry)
tampered_entry["version"] = "9.9.9"

# Wrong claimed keyid (some other key's keyid) → not OUR official endorsement.
wrong_keyid_entry = dict(valid_entry)
wrong_keyid_entry["official_signer_keyid"] = compute_keyid(encode_public_key(key_from_seed(8).public_key()))

# Signature from a DIFFERENT key but claiming the official keyid → keyid spoof.
foreign_core = capability_signed_core(
    kind="plugin", capability_id="dev.x.tool", version="1.2.0",
    package_digest=_pkg_digest, artifact_ref=_artifact_ref,
)
foreign_sig = sign_envelope(foreign_core, key_from_seed(8))["signatures"][0]["sig"]
foreign_sig_entry = dict(valid_entry)
foreign_sig_entry["official_signature"] = foreign_sig

# Missing capability_id (no plugin_id fallback at the verification boundary).
missing_id_entry = dict(valid_entry)
missing_id_entry.pop("capability_id")

# Non-canonical signature (newline injected into otherwise-valid base64).
bad_sig_entry = dict(valid_entry)
_s = valid_entry["official_signature"]
bad_sig_entry["official_signature"] = _s[:14] + "\n" + _s[14:]

cosign_vectors = [
    {"name": "valid_required_only", "entry": valid_entry, "official_public_key": official_bare, "expect": True},
    {"name": "valid_with_optional", "entry": valid_entry_optional, "official_public_key": official_bare, "expect": True},
    {"name": "valid_material_prefixed", "entry": valid_entry, "official_public_key": official_material, "expect": True},
    {"name": "no_trust_root", "entry": valid_entry, "official_public_key": "", "expect": False},
    {"name": "tampered_field", "entry": tampered_entry, "official_public_key": official_bare, "expect": False},
    {"name": "wrong_claimed_keyid", "entry": wrong_keyid_entry, "official_public_key": official_bare, "expect": False},
    {"name": "foreign_signer_spoofed_keyid", "entry": foreign_sig_entry, "official_public_key": official_bare, "expect": False},
    {"name": "missing_capability_id", "entry": missing_id_entry, "official_public_key": official_bare, "expect": False},
    {"name": "noncanonical_signature", "entry": bad_sig_entry, "official_public_key": official_bare, "expect": False},
]

# Defensive: assert the Python verifier agrees with each declared expectation, so the
# golden file can never ship a mislabeled cosign case.
for vec in cosign_vectors:
    got = verify_official_cosignature(vec["entry"], official_public_key=vec["official_public_key"] or None)
    assert got == vec["expect"], f"cosign vector {vec['name']}: python returned {got}, expected {vec['expect']}"

# --- canonical package digest vectors (PackageTrustVerifier.compute_digest) ---------
def build_package_digest_vector() -> dict:
    root = Path(tempfile.mkdtemp(prefix="pkgdig-"))
    # Non-ASCII manifest values + nested provenance exercise ensure_ascii + the zeroed
    # provenance fields in canonical_manifest_for_digest.
    manifest = {
        "id": "dev.x.tool",
        "version": "1.2.0",
        "runtime": {"type": "mcp"},
        "description": "héllo 世界 😀",
        "tools": [{"name": "b"}, {"name": "a"}],
        "provenance": {
            "package_digest": "sha256:" + ("aa" * 32),
            "signature": "ed25519:placeholder",
            "signer": "root",
        },
    }
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    (root / "entry.py").write_text("print('hi')\n", encoding="utf-8")
    os.chmod(root / "entry.py", 0o755)  # owner-execute → mode signal bit 0b0001
    (root / "data.txt").write_text("plain data\n", encoding="utf-8")
    (root / "lib").mkdir()
    (root / "lib" / "util.py").write_text("x = 1\n", encoding="utf-8")

    pkg = load_plugin_package(root)
    expected = compute_package_digest(pkg)
    files = []
    for fp in _iter_package_files(root):
        files.append({
            "relative": _digest_relative_name(fp, root),
            "mode_signal": _mode_signal(fp),
            "content_b64": base64.b64encode(fp.read_bytes()).decode("ascii"),
        })
    pkg.cleanup()
    return {
        "manifest_name": MANIFEST_NAME,
        "manifest": manifest,
        "files": files,
        "expected_digest": expected,
    }


package_digest_vector = build_package_digest_vector()


# --- package signature + revocation vectors (PackageTrustVerifier signature half) ---
def build_signature_and_revocation_vectors() -> tuple[dict, dict]:
    from superclaw.plugins import _PLUGIN_VERIFIER, PluginVerificationError

    sk = key_from_seed(7)
    pub_prefixed = encode_public_key(sk.public_key())  # ed25519:<b64>
    pub_bare = pub_prefixed[len("ed25519:"):]
    digest = "sha256:" + hashlib.sha256(b"package-bytes").hexdigest()
    valid_sig = "ed25519:" + base64.b64encode(sk.sign(digest.encode("utf-8"))).decode("ascii")
    wrong_sig = "ed25519:" + base64.b64encode(sk.sign((digest + "tamper").encode("utf-8"))).decode("ascii")
    other_pub_bare = encode_public_key(key_from_seed(8).public_key())[len("ed25519:"):]
    # Self-assert against the kernel verifier (bare key form, removeprefix is a no-op).
    _PLUGIN_VERIFIER.verify_signature(digest, valid_sig, pub_bare)
    signature = {
        "digest": digest,
        "public_key_bare": pub_bare,
        "public_key_prefixed": pub_prefixed,
        "valid_signature": valid_sig,
        "wrong_signature": wrong_sig,
        "other_public_key_bare": other_pub_bare,
    }

    # Build a real package so check_revocation's compute_digest path is exercised.
    root = Path(tempfile.mkdtemp(prefix="revoc-"))
    manifest = {
        "id": "dev.x.tool",
        "version": "1.2.0",
        "runtime": {"type": "mcp"},
        "provenance": {
            "package_digest": "sha256:" + ("bb" * 32),  # placeholder declared digest
            "signature": "ed25519:placeholder",
            "signer": "root",
        },
    }
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    (root / "f.txt").write_text("data\n", encoding="utf-8")
    pkg = load_plugin_package(root)
    declared = pkg.package_digest
    computed = compute_package_digest(pkg)
    target = {
        "artifact_id": pkg.artifact_id,
        "version": pkg.version,
        "declared_digest": declared,
        "computed_digest": computed,
    }

    def is_revoked(revocation: dict) -> bool:
        rf = Path(tempfile.mkdtemp(prefix="revfile-")) / "revocations.json"
        rf.write_text(json.dumps(revocation), encoding="utf-8")
        try:
            _PLUGIN_VERIFIER.check_revocation(pkg, rf)
            return False
        except PluginVerificationError:
            return True

    raw_cases = [
        ("version_match_no_digest", {"revoked": [{"plugin_id": "dev.x.tool", "version": "1.2.0"}]}),
        ("id_only_all_versions", {"revoked": [{"plugin_id": "dev.x.tool"}]}),
        ("version_mismatch", {"revoked": [{"plugin_id": "dev.x.tool", "version": "9.9.9"}]}),
        ("other_id", {"revoked": [{"plugin_id": "dev.other"}]}),
        ("declared_digest_match", {"revoked": [{"plugin_id": "dev.x.tool", "version": "1.2.0", "package_digest": declared}]}),
        ("computed_digest_match", {"revoked": [{"plugin_id": "dev.x.tool", "package_digest": computed}]}),
        ("digest_no_match", {"revoked": [{"plugin_id": "dev.x.tool", "package_digest": "sha256:" + ("ff" * 32)}]}),
        ("empty_list", {"revoked": []}),
    ]
    cases = [
        {"name": name, "revocation": rev, "revoked": is_revoked(rev)}
        for name, rev in raw_cases
    ]
    pkg.cleanup()
    return signature, {"id_field": "plugin_id", "target": target, "cases": cases}


signature_vector, revocation_vector = build_signature_and_revocation_vectors()


# --- verify_plugin_package orchestration vectors -----------------------------------
def build_verify_package_vectors() -> list[dict]:
    from superclaw.plugins import (
        PluginVerificationError,
        compute_package_digest,
        load_plugin_package,
        verify_plugin_package,
    )

    ROOT_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"
    root_sk = key_from_seed(11)
    root_pub = encode_public_key(root_sk.public_key())  # ed25519:<b64>
    other_sk = key_from_seed(12)
    other_pub = encode_public_key(other_sk.public_key())

    def make_package(*, manifest_extra: dict, sign_with, wrong_digest: bool = False, bad_sig: bool = False):
        root = Path(tempfile.mkdtemp(prefix="verifypkg-"))
        manifest = {
            "id": "dev.x.tool",
            "version": "1.0.0",
            "runtime": {"type": "mcp"},
            "provenance": {"package_digest": "", "signature": "", "signer": "root"},
        }
        manifest.update(manifest_extra)
        (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        (root / "entry.py").write_text("print('x')\n", encoding="utf-8")
        digest = compute_package_digest(load_plugin_package(root))
        sig_message = digest + ("tamper" if bad_sig else "")
        sig = "ed25519:" + base64.b64encode(sign_with.sign(sig_message.encode("utf-8"))).decode("ascii")
        manifest["provenance"]["package_digest"] = ("sha256:" + ("11" * 32)) if wrong_digest else digest
        manifest["provenance"]["signature"] = sig
        (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        files = [
            {
                "relative": _digest_relative_name(fp, root),
                "mode_signal": _mode_signal(fp),
                "content_b64": base64.b64encode(fp.read_bytes()).decode("ascii"),
            }
            for fp in _iter_package_files(root)
        ]
        return root, manifest, digest, files

    cases: list[dict] = []

    def run_case(name, *, manifest_extra, sign_with, root_env, public_key, provenance, reject_skill_origin,
                 revocation=None, wrong_digest=False, bad_sig=False):
        root, manifest, digest, files = make_package(
            manifest_extra=manifest_extra, sign_with=sign_with, wrong_digest=wrong_digest, bad_sig=bad_sig
        )
        rev_file = None
        if revocation is not None:
            rev_file = Path(tempfile.mkdtemp(prefix="verifyrev-")) / "revocations.json"
            rev_file.write_text(json.dumps(revocation), encoding="utf-8")
        prior = os.environ.get(ROOT_ENV)
        if root_env is None:
            os.environ.pop(ROOT_ENV, None)
        else:
            os.environ[ROOT_ENV] = root_env
        try:
            result = verify_plugin_package(
                root, public_key=public_key, cache=False, provenance=provenance,
                reject_skill_origin=reject_skill_origin,
                revocation_file=rev_file or (Path(tempfile.mkdtemp(prefix="norev-")) / "none.json"),
            )
            outcome = {
                "expect": "ok",
                "result": {
                    "plugin_id": result.plugin_id,
                    "version": result.version,
                    "digest": result.digest,
                    "signer_class": result.verdict.signer_class if result.verdict else None,
                },
            }
        except Exception:  # noqa: BLE001 — any raise (incl. AttributeError on a non-dict runtime) = rejected
            outcome = {"expect": "fail"}
        finally:
            if prior is None:
                os.environ.pop(ROOT_ENV, None)
            else:
                os.environ[ROOT_ENV] = prior
        cases.append({
            "name": name,
            "manifest": manifest,
            "files": files,
            "options": {
                "public_key": public_key,
                "provenance": provenance,
                "reject_skill_origin": reject_skill_origin,
                "revocation_data": revocation,
            },
            "root_env": root_env,
            **outcome,
        })

    run_case("valid_root_signed", manifest_extra={}, sign_with=root_sk, root_env=root_pub,
             public_key=None, provenance="remote", reject_skill_origin=True)
    run_case("digest_mismatch", manifest_extra={}, sign_with=root_sk, root_env=root_pub,
             public_key=None, provenance="remote", reject_skill_origin=True, wrong_digest=True)
    run_case("bad_signature", manifest_extra={}, sign_with=root_sk, root_env=root_pub,
             public_key=None, provenance="remote", reject_skill_origin=True, bad_sig=True)
    run_case("external_mcp_root_ok", manifest_extra={"runtime": {"type": "external_mcp"}}, sign_with=root_sk,
             root_env=root_pub, public_key=None, provenance="remote", reject_skill_origin=True)
    run_case("external_mcp_non_root_fail", manifest_extra={"runtime": {"type": "external_mcp"}}, sign_with=other_sk,
             root_env=None, public_key=other_pub, provenance="remote", reject_skill_origin=True)
    run_case("skill_origin_field_rejected", manifest_extra={"skill_origin": True}, sign_with=root_sk,
             root_env=root_pub, public_key=None, provenance="remote", reject_skill_origin=True)
    run_case("skill_id_prefix_rejected", manifest_extra={"id": "skill.demo"}, sign_with=root_sk,
             root_env=root_pub, public_key=None, provenance="remote", reject_skill_origin=True)
    run_case("sign_free_local_skill_ok", manifest_extra={"skill_origin": True}, sign_with=root_sk,
             root_env=None, public_key=None, provenance="local", reject_skill_origin=False, bad_sig=True)
    run_case("local_skill_but_reject_origin_fail", manifest_extra={"skill_origin": True}, sign_with=root_sk,
             root_env=None, public_key=None, provenance="local", reject_skill_origin=True, bad_sig=True)
    run_case("revoked_fail", manifest_extra={}, sign_with=root_sk, root_env=root_pub, public_key=None,
             provenance="remote", reject_skill_origin=True,
             revocation={"revoked": [{"plugin_id": "dev.x.tool"}]})
    # A present but non-dict runtime has no .get in the kernel → AttributeError → fail closed.
    run_case("runtime_non_object_fail", manifest_extra={"runtime": "external_mcp"}, sign_with=root_sk,
             root_env=root_pub, public_key=None, provenance="remote", reject_skill_origin=True)

    return cases


verify_package_vectors = build_verify_package_vectors()

out = {
    "_note": "Generated from superclaw.trust_contracts — do not hand-edit. Regenerate via server/server/scripts/gen-trust-golden-vectors.py.",
    "jcs": jcs_vectors,
    "nfc_then_jcs": nfc_vectors,
    "keyid": keyid_vectors,
    "verify": verify_vectors,
    "cosign": cosign_vectors,
    "package_digest": package_digest_vector,
    "signature": signature_vector,
    "revocation": revocation_vector,
    "verify_package": verify_package_vectors,
}

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2, sort_keys=False)
    fh.write("\n")
print(f"wrote {sys.argv[1]}: {len(jcs_vectors)} jcs, {len(nfc_vectors)} nfc, "
      f"{len(keyid_vectors)} keyid, {len(verify_vectors)} verify, {len(cosign_vectors)} cosign, "
      f"1 package_digest ({len(package_digest_vector['files'])} files), "
      f"1 signature, {len(revocation_vector['cases'])} revocation, "
      f"{len(verify_package_vectors)} verify_package vectors")
