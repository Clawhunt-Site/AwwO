from __future__ import annotations
import pytest

import base64
import json
import shutil
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugins import (
    PluginVerificationError,
    check_plugin_revocation,
    compute_package_digest,
    list_cached_plugins,
    load_plugin_package,
    verify_plugin_package,
)


ROOT = Path(__file__).resolve().parents[1]


def _copy_fixture(tmp_path: Path, name: str = "hello-world") -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign_plugin(plugin_dir: Path, private_key: Ed25519PrivateKey) -> tuple[str, str]:
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return digest, manifest["provenance"]["signature"]


def test_verify_signed_plugin_caches_package(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    (plugin_dir / "assets").mkdir()
    (plugin_dir / "assets" / "logo.svg").write_text("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\" />\n", encoding="utf-8")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["logo"] = "assets/logo.svg"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    private_key, public_key = _keypair()
    digest, _signature = _sign_plugin(plugin_dir, private_key)
    cache_root = tmp_path / "cache"

    result = verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)

    assert result.plugin_id == "dev.superclaw.hello-world"
    assert result.version == "0.1.0"
    assert result.digest == digest
    assert result.cached_path == cache_root / "dev.superclaw.hello-world" / "0.1.0"
    assert (result.cached_path / "superclaw-plugin.json").exists()
    cached = list_cached_plugins(cache_root=cache_root)[0]
    assert cached["id"] == "dev.superclaw.hello-world"
    assert cached["logo"] == "assets/logo.svg"
    assert cached["logo_url"] == "/api/plugins/dev.superclaw.hello-world/logo?version=0.1.0"


def test_verify_scplug_archive_caches_package(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    private_key, public_key = _keypair()
    digest, _signature = _sign_plugin(plugin_dir, private_key)
    archive_path = tmp_path / "hello-world.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for path in sorted(item for item in plugin_dir.rglob("*") if item.is_file()):
            archive.write(path, path.relative_to(plugin_dir).as_posix())

    result = verify_plugin_package(archive_path, public_key=public_key, cache_root=tmp_path / "cache")

    assert result.plugin_id == "dev.superclaw.hello-world"
    assert result.digest == digest
    assert (tmp_path / "cache" / "dev.superclaw.hello-world" / "0.1.0" / "superclaw-plugin.json").exists()


def test_verify_rejects_tampered_package(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    (plugin_dir / "bin" / "hello-world").write_text("#!/usr/bin/env sh\nprintf tampered\n", encoding="utf-8")

    try:
        verify_plugin_package(plugin_dir, public_key=public_key, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "package digest mismatch" in str(exc)
    else:
        raise AssertionError("expected tampered package to fail")


def test_verify_rejects_unsigned_package(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    manifest["provenance"]["package_digest"] = compute_package_digest(package)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _private_key, public_key = _keypair()

    try:
        verify_plugin_package(plugin_dir, public_key=public_key, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "unsupported signature format" in str(exc)
    else:
        raise AssertionError("expected unsigned package to fail")


def test_verify_rejects_invalid_signature(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    signer, _signer_public_key = _keypair()
    _wrong_private_key, wrong_public_key = _keypair()
    _sign_plugin(plugin_dir, signer)

    try:
        verify_plugin_package(plugin_dir, public_key=wrong_public_key, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "plugin signature invalid" in str(exc)
    else:
        raise AssertionError("expected invalid signature to fail")


def test_verify_rejects_invalid_plugin_configuration_contract(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path, "github-scanner")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["configuration"]["settings"][0]["ui"] = {"control": "switch"}
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)

    try:
        verify_plugin_package(plugin_dir, public_key=public_key, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "plugin configuration contract invalid" in str(exc)
        assert "switch control requires boolean setting type" in str(exc)
    else:
        raise AssertionError("expected invalid configuration contract to fail")


def test_revocation_metadata_blocks_verified_plugin_before_cache(tmp_path: Path):
    plugin_dir = _copy_fixture(tmp_path)
    private_key, public_key = _keypair()
    digest, _signature = _sign_plugin(plugin_dir, private_key)
    revocation_file = tmp_path / "revocations.json"
    revocation_file.write_text(
        json.dumps({"revoked": [{"plugin_id": "dev.superclaw.hello-world", "package_digest": digest}]}),
        encoding="utf-8",
    )

    try:
        verify_plugin_package(plugin_dir, public_key=public_key, cache_root=tmp_path / "cache", revocation_file=revocation_file)
    except PluginVerificationError as exc:
        assert "plugin revoked" in str(exc)
    else:
        raise AssertionError("expected revoked plugin to fail")
    assert not (tmp_path / "cache").exists()


def test_revocation_matches_computed_digest_despite_tampered_declared(tmp_path: Path):
    """A digest-specific revocation must match the *computed* digest, not the
    mutable manifest-declared value.

    The declared provenance.package_digest is excluded from the digest input,
    so it can be tampered without breaking the signature. If revocation only
    matched the declared value, an attacker could edit a cached manifest's
    declared digest and evade a revocation keyed on the real (computed) digest
    — especially on the warm-cache path where the full integrity check is
    skipped. This pins the fix: revocation fires on the computed digest.
    """
    plugin_dir = _copy_fixture(tmp_path)
    private_key, _public_key = _keypair()
    computed_digest, _signature = _sign_plugin(plugin_dir, private_key)

    # Tamper ONLY the declared digest in the manifest (signature stays valid:
    # the signed/computed digest excludes this field).
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = "sha256:" + "0" * 64
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    package = load_plugin_package(plugin_dir)
    assert package.package_digest != computed_digest  # declared is tampered
    assert compute_package_digest(package) == computed_digest  # computed unchanged

    revocation_file = tmp_path / "revocations.json"
    revocation_file.write_text(
        json.dumps({"revoked": [{"plugin_id": package.plugin_id, "package_digest": computed_digest}]}),
        encoding="utf-8",
    )

    try:
        check_plugin_revocation(package, revocation_file=revocation_file)
    except PluginVerificationError as exc:
        assert "plugin revoked" in str(exc)
    else:
        raise AssertionError("expected revocation to match the computed digest despite tampered declared digest")


def test_scplug_archive_path_traversal_is_rejected(tmp_path: Path):
    archive_path = tmp_path / "unsafe.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("../superclaw-plugin.json", "{}")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "unsafe archive member path" in str(exc)
    else:
        raise AssertionError("expected unsafe archive member to fail")


def test_scplug_archive_rejects_zip_bomb_uncompressed_size(tmp_path: Path, monkeypatch):
    # Streaming cap: a member whose decompressed bytes exceed the cap is aborted
    # mid-copy (we do not trust the declared file_size). Lower the cap for speed.
    import superclaw.plugins as plugins

    monkeypatch.setattr(plugins, "_MAX_ARCHIVE_UNCOMPRESSED_BYTES", 1024)
    archive_path = tmp_path / "bomb.scplug"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("big.bin", b"\0" * (1024 * 64))  # highly compressible, > cap when extracted

    with pytest.raises(PluginVerificationError, match="maximum uncompressed size"):
        load_plugin_package(archive_path)


def test_scplug_archive_rejects_oversize_file_before_open(tmp_path: Path, monkeypatch):
    # Physical pre-open guard: a huge on-disk .scplug (e.g. a central-directory
    # bomb) is rejected by os.stat before zipfile parses it into memory.
    import superclaw.plugins as plugins

    monkeypatch.setattr(plugins, "_MAX_ARCHIVE_COMPRESSED_BYTES", 256)
    archive_path = tmp_path / "huge.scplug"
    archive_path.write_bytes(b"\0" * 1024)  # exceeds the lowered physical cap

    with pytest.raises(PluginVerificationError, match="archive file is too large"):
        load_plugin_package(archive_path)


def test_central_directory_byte_size_matches_zipfile(tmp_path: Path):
    # The pre-open size_cd must equal what ZipFile itself computes (we reuse
    # CPython's _EndRecData), so the guard bounds the real open-time allocation.
    import zipfile as _zip

    import superclaw.plugins as plugins

    archive_path = tmp_path / "sized.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for i in range(7):
            archive.writestr(f"f{i}.txt", "x")
    with archive_path.open("rb") as fh:
        expected = _zip._EndRecData(fh)[_zip._ECD_SIZE]
    with archive_path.open("rb") as fh:
        assert plugins._central_directory_byte_size(fh) == expected


def test_size_cap_neutralizes_spoofed_low_entry_count(tmp_path: Path, monkeypatch):
    # CD-bomb defense must NOT rely on the EOCD declared count (ZipFile ignores it
    # for the parse loop). Spoof the EOCD "total entries" to 1 while keeping the
    # real (large) central directory; the size_cd cap must still reject.
    import superclaw.plugins as plugins

    archive_path = tmp_path / "spoofed.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for i in range(20):
            archive.writestr(f"file_{i}.txt", "x")
    data = bytearray(archive_path.read_bytes())
    idx = data.rfind(b"PK\x05\x06")
    assert idx >= 0
    data[idx + 10 : idx + 12] = b"\x01\x00"  # entries-this-disk
    data[idx + 8 : idx + 10] = b"\x01\x00"  # total-entries
    archive_path.write_bytes(data)

    monkeypatch.setattr(plugins, "_MAX_CENTRAL_DIRECTORY_BYTES", 64)
    with pytest.raises(PluginVerificationError, match="central directory is too large"):
        load_plugin_package(archive_path)


def test_scplug_malformed_zip_is_normalized_error(tmp_path: Path):
    # A non-zip file with the .scplug suffix must fail closed as a
    # PluginVerificationError, not a raw BadZipFile / parse error.
    archive_path = tmp_path / "garbage.scplug"
    archive_path.write_bytes(b"not a zip at all")
    with pytest.raises(PluginVerificationError):
        load_plugin_package(archive_path)


def test_scplug_corrupt_member_data_is_normalized_error(tmp_path: Path):
    # Zip opens fine but a member's stored bytes are corrupted → CRC failure during
    # extraction must normalize to PluginVerificationError, not raw BadZipFile.
    archive_path = tmp_path / "corruptdata.scplug"
    content = b'{"x":"' + b"A" * 200 + b'"}'
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("superclaw-plugin.json", content)
    data = bytearray(archive_path.read_bytes())
    marker = data.find(b"A" * 16)
    assert marker >= 0
    data[marker] ^= 0xFF  # corrupt stored bytes → CRC mismatch on read
    archive_path.write_bytes(data)
    with pytest.raises(PluginVerificationError):
        load_plugin_package(archive_path)


def test_directory_package_corrupt_manifest_is_normalized_error(tmp_path: Path):
    # The directory branch must also normalize a corrupt manifest to
    # PluginVerificationError (no raw JSONDecodeError escapes the loader).
    plugin_dir = tmp_path / "broken"
    plugin_dir.mkdir()
    (plugin_dir / "superclaw-plugin.json").write_text("{ not json", encoding="utf-8")
    with pytest.raises(PluginVerificationError):
        load_plugin_package(plugin_dir)


def test_scplug_corrupt_manifest_json_is_normalized_error(tmp_path: Path):
    # Extraction succeeds but the manifest is invalid JSON → must normalize to
    # PluginVerificationError, not a raw JSONDecodeError.
    archive_path = tmp_path / "badmanifest.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{ this is not valid json ")
    with pytest.raises(PluginVerificationError):
        load_plugin_package(archive_path)


def test_scplug_archive_rejects_oversize_central_directory(tmp_path: Path, monkeypatch):
    # size_cd cap is the real CD-bomb OOM guard: a (low-declared-count or not)
    # archive whose central directory exceeds the cap is rejected before ZipFile
    # reads it into memory and builds ZipInfo per record.
    import superclaw.plugins as plugins

    monkeypatch.setattr(plugins, "_MAX_CENTRAL_DIRECTORY_BYTES", 64)
    archive_path = tmp_path / "cdbomb.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for i in range(20):  # central directory > 64 bytes
            archive.writestr(f"file_{i}.txt", "x")

    with pytest.raises(PluginVerificationError, match="central directory is too large"):
        load_plugin_package(archive_path)


def test_scplug_archive_rejects_too_many_entries(tmp_path: Path, monkeypatch):
    # Post-open entry-count cap (defense in depth; size_cd already bounds the
    # record count, but this enforces the semantic "too many files" limit).
    import superclaw.plugins as plugins

    monkeypatch.setattr(plugins, "_MAX_ARCHIVE_ENTRIES", 5)
    archive_path = tmp_path / "manyentries.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for i in range(10):
            archive.writestr(f"f{i}.txt", "x")

    with pytest.raises(PluginVerificationError, match="too many entries"):
        load_plugin_package(archive_path)


def test_plugin_cli_verify_and_list_use_local_cache(tmp_path: Path, monkeypatch):
    plugin_dir = _copy_fixture(tmp_path)
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "cache"))
    runner = CliRunner()

    verify_result = runner.invoke(app, ["plugin", "verify", str(plugin_dir), "--public-key", public_key, "--json"])
    list_result = runner.invoke(app, ["plugin", "list", "--json"])

    assert verify_result.exit_code == 0, verify_result.output
    payload = json.loads(verify_result.output)
    assert payload["ok"] is True
    assert payload["plugin_id"] == "dev.superclaw.hello-world"
    assert list_result.exit_code == 0, list_result.output
    listed = json.loads(list_result.output)["plugins"]
    assert listed[0]["id"] == "dev.superclaw.hello-world"


# --- P0-1: package digest must cover the executable bit and reject ambiguous
# path normalization (docs/plugin-trust-chain-hardening.md §4). ---


def test_digest_changes_when_executable_bit_is_flipped(tmp_path: Path):
    """Flipping a file's exec bit must change the digest (and thus break signing).

    This is the core P0-1 bug: before the fix the digest only covered
    "relative path + content", so toggling the exec bit on (e.g.) the entry
    binary left the digest — and the signature over it — unchanged, silently
    turning a passive data file into an executable entry point.
    """
    plugin_dir = _copy_fixture(tmp_path)
    target = plugin_dir / "bin" / "hello-world"

    target.chmod(0o644)
    package = load_plugin_package(plugin_dir)
    digest_without_exec = compute_package_digest(package)

    target.chmod(0o755)
    package = load_plugin_package(plugin_dir)
    digest_with_exec = compute_package_digest(package)

    assert digest_without_exec != digest_with_exec


def test_exec_bit_flip_breaks_signature_in_full_verification(tmp_path: Path):
    """End-to-end: a signed package whose exec bit is flipped post-signing fails.

    Mirrors the real attack — sign a package, then flip an exec bit on disk
    without touching content. The recomputed digest must no longer match the
    declared/signed digest, so verification fails fail-closed.
    """
    plugin_dir = _copy_fixture(tmp_path)
    (plugin_dir / "bin" / "hello-world").chmod(0o644)
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)

    # Tamper: flip the exec bit only. Content and path are untouched.
    (plugin_dir / "bin" / "hello-world").chmod(0o755)

    try:
        verify_plugin_package(plugin_dir, public_key=public_key, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "package digest mismatch" in str(exc)
    else:
        raise AssertionError("expected exec-bit flip to break the signed digest")


def test_digest_owner_exec_is_stable_against_group_other_noise(tmp_path: Path):
    """The normalized exec signal ignores group/other bits and umask noise.

    Only the owner-execute distinction is security-relevant; folding raw st_mode
    in would make the digest drift across checkouts/umasks and fail every
    verification. 0o755 and 0o744 are both "owner-executable" and must hash the
    same; 0o744 vs 0o644 (owner exec on vs off) must differ.
    """
    plugin_dir = _copy_fixture(tmp_path)
    target = plugin_dir / "bin" / "hello-world"

    target.chmod(0o755)
    digest_755 = compute_package_digest(load_plugin_package(plugin_dir))
    target.chmod(0o744)
    digest_744 = compute_package_digest(load_plugin_package(plugin_dir))
    target.chmod(0o644)
    digest_644 = compute_package_digest(load_plugin_package(plugin_dir))

    assert digest_755 == digest_744  # owner-exec on in both; group/other noise ignored
    assert digest_744 != digest_644  # owner-exec on vs off must differ


def test_digest_is_domain_separated_v2(tmp_path: Path):
    """The digest stream is domain-separated so v1-algorithm digests can't collide.

    Format stays sha256:<64 hex> (so existing validators keep working) but the
    bytes are versioned; this test pins the prefix and length so a future
    accidental algorithm change is caught.
    """
    plugin_dir = _copy_fixture(tmp_path)
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64
    # A v1 ("relative path + content", no domain tag, no exec bit) recomputation
    # of the same tree must not match the v2 digest.
    import hashlib as _hashlib

    from superclaw.plugins import MANIFEST_NAME, _canonical_manifest_for_digest, _iter_package_files

    package = load_plugin_package(plugin_dir)
    legacy = _hashlib.sha256()
    for file_path in _iter_package_files(package.root):
        relative = file_path.relative_to(package.root).as_posix()
        legacy.update(relative.encode("utf-8"))
        legacy.update(b"\0")
        if relative == MANIFEST_NAME:
            legacy.update(_canonical_manifest_for_digest(package.manifest))
        else:
            legacy.update(file_path.read_bytes())
        legacy.update(b"\0")
    assert digest != f"sha256:{legacy.hexdigest()}"


def test_scplug_rejects_duplicate_member(tmp_path: Path):
    """Two archive entries with the same name are rejected before extraction.

    Last-write-wins extraction would otherwise leave one file on disk while the
    digest re-walk is blind to the shadowed entry — a smuggle channel.
    """
    archive_path = tmp_path / "dup.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("data.txt", "first")
        archive.writestr("data.txt", "second")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "duplicate member" in str(exc)
    else:
        raise AssertionError("expected duplicate archive member to be rejected")


def test_scplug_rejects_case_colliding_member(tmp_path: Path):
    """Members differing only by case collide on case-insensitive filesystems."""
    archive_path = tmp_path / "case.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("Entry.txt", "a")
        archive.writestr("entry.txt", "b")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "case/Unicode-colliding member" in str(exc)
    else:
        raise AssertionError("expected case-colliding archive member to be rejected")


def test_scplug_rejects_nfc_nfd_colliding_member(tmp_path: Path):
    """NFC and NFD spellings of one name collide on normalization-insensitive FS.

    casefold() alone does not normalize, so a composed and a decomposed spelling
    fold to different strings yet land on the same on-disk file (APFS/HFS+). The
    extraction collision check must NFC-normalize before folding.
    """
    import unicodedata

    archive_path = tmp_path / "uni.scplug"
    nfc = unicodedata.normalize("NFC", "café.txt")
    nfd = unicodedata.normalize("NFD", "café.txt")
    assert nfc != nfd
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr(nfc, "a")
        archive.writestr(nfd, "b")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        # Rejected either as a collision or (caught first) as a non-NFC name;
        # both are fail-closed and both prevent the shadow.
        assert "colliding member" in str(exc) or "not Unicode-NFC-normalized" in str(exc)
    else:
        raise AssertionError("expected NFC/NFD-colliding archive member to be rejected")


def test_scplug_rejects_dir_file_collision(tmp_path: Path):
    """A foo/ directory and a foo file must fail closed, not crash extraction.

    Without the guard, extraction order triggers a raw IsADirectoryError /
    FileExistsError instead of a contract PluginVerificationError.
    """
    archive_path = tmp_path / "dirfile.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("foo/", b"")
        archive.writestr("foo", b"data")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "colliding member" in str(exc) or "duplicate member" in str(exc)
    else:
        raise AssertionError("expected dir/file collision to be rejected")


def test_scplug_rejects_pycache_member(tmp_path: Path):
    """A shipped __pycache__/*.pyc is a signed-but-unhashed smuggle channel.

    The digest intentionally skips __pycache__, so an archive must never carry
    it — otherwise a malicious bytecode file would ride along under a valid
    signature. Reject it at extraction.
    """
    archive_path = tmp_path / "pyc.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("pkg/__pycache__/evil.cpython-311.pyc", b"\x00\x00malicious")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "__pycache__" in str(exc)
    else:
        raise AssertionError("expected __pycache__ archive member to be rejected")


def test_digest_covers_pyc_outside_pycache(tmp_path: Path):
    """A .pyc shipped outside __pycache__ is real content and must be hashed.

    Closes the entrypoint-swap bypass: declare a .pyc entrypoint, sign (file
    excluded), then swap bytecode. With the fix the file is part of the digest,
    so any swap changes it.
    """
    plugin_dir = _copy_fixture(tmp_path)
    entry = plugin_dir / "bin" / "runner.pyc"
    entry.write_bytes(b"\x00original")
    digest_before = compute_package_digest(load_plugin_package(plugin_dir))

    entry.write_bytes(b"\x00swapped-malicious")
    digest_after = compute_package_digest(load_plugin_package(plugin_dir))

    assert digest_before != digest_after


def test_digest_still_skips_generated_pycache(tmp_path: Path):
    """Interpreter-generated __pycache__ must stay excluded (cache stability).

    A .pyc written under __pycache__ after caching/import must not perturb the
    digest, or verification would fail on every call after the first.
    """
    plugin_dir = _copy_fixture(tmp_path)
    digest_clean = compute_package_digest(load_plugin_package(plugin_dir))
    pycache = plugin_dir / "bin" / "__pycache__"
    pycache.mkdir()
    (pycache / "mod.cpython-311.pyc").write_bytes(b"\x00generated")
    digest_with_pycache = compute_package_digest(load_plugin_package(plugin_dir))

    assert digest_clean == digest_with_pycache


def test_digest_covers_setuid_bit(tmp_path: Path):
    """Adding a setuid bit post-signing must change the digest (priv-esc bypass)."""
    import os

    plugin_dir = _copy_fixture(tmp_path)
    target = plugin_dir / "bin" / "hello-world"
    target.chmod(0o755)
    digest_plain = compute_package_digest(load_plugin_package(plugin_dir))

    os.chmod(target, 0o4755)  # add setuid
    digest_setuid = compute_package_digest(load_plugin_package(plugin_dir))

    assert digest_plain != digest_setuid


def test_cache_write_rejects_path_traversal_in_identity(tmp_path: Path):
    """cache_plugin_package must reject id/version that escape the cache root."""
    from superclaw.plugins import PluginPackage, cache_plugin_package

    src = _copy_fixture(tmp_path)
    package = load_plugin_package(src)
    malicious = PluginPackage(
        source=package.source,
        root=package.root,
        manifest={**package.manifest, "id": "../../etc", "version": "cron.d"},
    )
    try:
        cache_plugin_package(malicious, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "unsafe" in str(exc)
    else:
        raise AssertionError("expected path-traversal identity to be rejected before write")


def test_directory_package_install_rejects_shipped_pycache(tmp_path: Path):
    """A directory package that ships __pycache__ must be refused at install.

    .scplug extraction already rejects __pycache__ members; the directory
    package never goes through extraction, so install (caching) is the
    chokepoint that closes the same signed-but-unhashed bytecode smuggle.
    """
    from superclaw.plugins import cache_plugin_package

    plugin_dir = _copy_fixture(tmp_path)
    pycache = plugin_dir / "bin" / "__pycache__"
    pycache.mkdir()
    (pycache / "evil.cpython-311.pyc").write_bytes(b"\x00malicious")
    package = load_plugin_package(plugin_dir)

    try:
        cache_plugin_package(package, cache_root=tmp_path / "cache")
    except PluginVerificationError as exc:
        assert "__pycache__" in str(exc)
    else:
        raise AssertionError("expected shipped __pycache__ to be rejected at install")


def test_cache_write_rejects_same_id_version_different_signer(tmp_path: Path):
    """A cached id@version cannot be silently overwritten by another signer.

    Namespace isolation must fail closed at install time too; otherwise a local
    package with the same id/version could replace a previously verified cached
    package and make later execution depend on whichever signer wrote last.
    """
    first = tmp_path / "first"
    second = tmp_path / "second"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", first)
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", second)
    signer_a, public_a = _keypair()
    signer_b, public_b = _keypair()
    _digest_a, signature_a = _sign_plugin(first, signer_a)
    _sign_plugin(second, signer_b)
    cache_root = tmp_path / "cache"

    verify_plugin_package(first, public_key=public_a, cache_root=cache_root)

    try:
        verify_plugin_package(second, public_key=public_b, cache_root=cache_root)
    except PluginVerificationError as exc:
        assert "different signer" in str(exc)
    else:
        raise AssertionError("expected same id/version from a different signer to be rejected")

    cached_manifest = json.loads(
        (cache_root / "dev.superclaw.hello-world" / "0.1.0" / "superclaw-plugin.json").read_text(encoding="utf-8")
    )
    assert cached_manifest["provenance"]["signature"] == signature_a


def test_scplug_rejects_ancestor_file_directory_conflict(tmp_path: Path):
    """A file 'foo' and a member 'foo/bar' must fail closed, not crash extraction."""
    archive_path = tmp_path / "ancestor.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr("foo", "iamafile")
        archive.writestr("foo/bar", "needs foo to be a dir")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "both a file and a directory" in str(exc) or "colliding" in str(exc)
    else:
        raise AssertionError("expected file/directory ancestor conflict to be rejected")


def test_pack_excludes_pycache_so_archive_verifies(tmp_path: Path, monkeypatch):
    """plugin pack must exclude __pycache__ so the .scplug it builds verifies.

    The digest excludes __pycache__ and the verifier rejects it inside an
    archive; pack must agree, or it would emit a self-invalidating package.
    """
    from superclaw.plugin_devkit import pack_plugin_package

    plugin_dir = _copy_fixture(tmp_path)
    pycache = plugin_dir / "bin" / "__pycache__"
    pycache.mkdir()
    (pycache / "mod.cpython-311.pyc").write_bytes(b"\x00generated")
    private_key, public_key = _keypair()

    result = pack_plugin_package(
        plugin_dir, dist_dir=tmp_path / "dist", signing_private_key=None, dev_sign=True
    )

    # The packed archive must load (no rejected __pycache__ member) and its
    # recomputed digest must match what pack signed.
    package = load_plugin_package(result.package_path)
    try:
        assert compute_package_digest(package) == package.package_digest
    finally:
        package.cleanup()


def test_digest_rejects_non_nfc_filename(tmp_path: Path):
    """A non-NFC (decomposed) filename is rejected rather than silently folded.

    Silent normalization would let a decomposed and a composed spelling both be
    admitted while one no longer matches the file the digest claims to cover.
    """
    import unicodedata

    plugin_dir = _copy_fixture(tmp_path)
    decomposed = unicodedata.normalize("NFD", "café.txt")
    assert decomposed != unicodedata.normalize("NFC", decomposed)
    try:
        (plugin_dir / decomposed).write_text("x", encoding="utf-8")
    except (OSError, UnicodeError):
        import pytest

        pytest.skip("filesystem normalized the name; cannot stage a non-NFC entry")

    # Skip if the filesystem (e.g. APFS) silently re-normalized the stored name.
    staged = {p.name for p in plugin_dir.iterdir()}
    if decomposed not in staged:
        import pytest

        pytest.skip("filesystem normalized the name; cannot stage a non-NFC entry")

    package = load_plugin_package(plugin_dir)
    try:
        compute_package_digest(package)
    except PluginVerificationError as exc:
        assert "not Unicode-NFC-normalized" in str(exc)
    else:
        raise AssertionError("expected non-NFC filename to be rejected")


def test_digest_length_framing_resists_path_content_ambiguity(tmp_path: Path):
    """Length framing removes concatenation ambiguity between path and content.

    Two distinct packages — one with a file "ab" containing "c", another with a
    file "a" containing "bc" — must produce different digests. A naive
    separator-only stream is at higher risk of aliasing; explicit length frames
    make it impossible.
    """
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    pkg_a = _copy_fixture(tmp_path / "a", "hello-world")
    pkg_b = _copy_fixture(tmp_path / "b", "hello-world")
    (pkg_a / "ab").write_text("c", encoding="utf-8")
    (pkg_b / "a").write_text("bc", encoding="utf-8")

    digest_a = compute_package_digest(load_plugin_package(pkg_a))
    digest_b = compute_package_digest(load_plugin_package(pkg_b))
    assert digest_a != digest_b


def test_sign_package_copy_rejects_shipped_pycache(tmp_path: Path):
    """Signing a tree that ships __pycache__ must fail closed (R3-1).

    The digest excludes __pycache__, so signing such a tree would bless
    signed-but-unhashed bytecode. The no-cache verify path (cache=False) skips
    the install-time __pycache__ check, so the guarantee must live in the
    signing path itself — a signed package can never contain __pycache__,
    independent of any later cache flag.
    """
    import pytest

    from superclaw.plugin_submission import _sign_package_copy

    plugin_dir = _copy_fixture(tmp_path)
    pycache = plugin_dir / "bin" / "__pycache__"
    pycache.mkdir()
    (pycache / "evil.cpython-311.pyc").write_bytes(b"\x00malicious")
    private_key, _public_key = _keypair()
    signing_key = base64.b64encode(
        private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    ).decode("ascii")

    with pytest.raises(PluginVerificationError) as excinfo:
        _sign_package_copy(plugin_dir, tmp_path / "signed", signing_key)
    assert "__pycache__" in str(excinfo.value)


def test_scplug_rejects_root_alias_member(tmp_path: Path):
    """A literal '.' member aliases the archive root and must be refused (R3-2).

    ``Path('.').parts == ()`` slips past the absolute/'..' and collision checks,
    and ``(root / '.')`` resolves back to root, so extraction would ``open('wb')``
    the root directory and crash with a bare IsADirectoryError. Reject it as a
    fail-closed contract violation instead.
    """
    archive_path = tmp_path / "rootalias.scplug"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("superclaw-plugin.json", "{}")
        archive.writestr(".", b"iamroot")

    try:
        load_plugin_package(archive_path)
    except PluginVerificationError as exc:
        assert "root-alias" in str(exc)
    else:
        raise AssertionError("expected root-alias '.' member to be rejected")


def test_pack_rejects_path_traversal_in_identity(tmp_path: Path):
    """plugin pack must reject id/version that escape the dist dir (R3-3).

    id/version come straight from the untrusted manifest and are interpolated
    into the output filename; an id like '../../escape' or a version with a
    path separator would write the .scplug outside dist_dir.
    """
    import pytest

    from superclaw.plugin_devkit import pack_plugin_package

    plugin_dir = _copy_fixture(tmp_path)
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["id"] = "../../escape"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(PluginVerificationError) as excinfo:
        pack_plugin_package(
            plugin_dir, dist_dir=tmp_path / "dist", signing_private_key=None, dev_sign=True
        )
    assert "unsafe" in str(excinfo.value)
