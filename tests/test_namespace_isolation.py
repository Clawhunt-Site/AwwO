"""Namespace hard-isolation at the execution gate (方向二 §3.2).

A reserved first-party namespace (``superclaw.``/``first_party.``) signed by a
non-root key is rejected at the execution gate (PLUGIN_NAMESPACE_VIOLATION).
Because every enumerator shares ``_gate_passes`` -> the same execution gate, a
hijack package is also dropped from ``available_plugins``/``gate_passing_plugins``.

Scope note: same-id-different-signer hard conflict (§3.3) across the execution
invoke path / install-time overwrite / MCP tools-list projection is a dedicated
follow-up PR; it is intentionally NOT claimed here.
"""
from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package
from superclaw.plugin_proxy import load_cached_package, verify_cached_package_before_execution

REPO_ROOT = Path(__file__).resolve().parents[1]
ROOT_KEY_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"
LOCAL_DEV_ENV = "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST"


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return priv, "ed25519:" + base64.b64encode(raw).decode()


def _sign(priv: Ed25519PrivateKey, digest: str) -> str:
    return "ed25519:" + base64.b64encode(priv.sign(digest.encode("utf-8"))).decode()


def _build_signed_plugin(
    tmp_path: Path,
    plugin_id: str,
    version: str,
    priv: Ed25519PrivateKey,
    *,
    skill_origin: bool | None = None,
) -> Path:
    src = tmp_path / f"{plugin_id}-{version}".replace(".", "_")
    shutil.copytree(REPO_ROOT / "examples" / "plugins" / "hello-world", src)
    mp = src / "superclaw-plugin.json"
    manifest = json.loads(mp.read_text(encoding="utf-8"))
    manifest["id"] = plugin_id
    manifest["version"] = version
    if skill_origin is not None:
        manifest["skill_origin"] = skill_origin
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(src))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = _sign(priv, digest)
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return src


def test_reserved_namespace_non_root_is_rejected(tmp_path, monkeypatch):
    root_priv, root_pub = _keypair()
    dev_priv, dev_pub = _keypair()
    # claims "superclaw.*" but signed by a NON-root (dev) key
    src = _build_signed_plugin(tmp_path, "superclaw.hijack", "1.0.0", dev_priv)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)  # the real root is a different key
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    package = load_plugin_package(src)
    # admission via the explicit dev key passes the signature gate, but the
    # namespace check (root-only) rejects the hijack.
    code = verify_cached_package_before_execution(
        package, public_key=dev_pub, revocation_file=tmp_path / "rev.json"
    )
    assert code == "PLUGIN_NAMESPACE_VIOLATION"


def test_reserved_namespace_non_root_rejected_even_with_local_dev(tmp_path, monkeypatch):
    # local-dev trust must NOT let a non-root key own a reserved prefix
    root_priv, root_pub = _keypair()
    dev_priv, dev_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "first_party.evil", "1.0.0", dev_priv)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    package = load_plugin_package(src)
    code = verify_cached_package_before_execution(
        package, public_key=dev_pub, revocation_file=tmp_path / "rev.json"
    )
    assert code == "PLUGIN_NAMESPACE_VIOLATION"


def test_reserved_namespace_root_signed_is_allowed(tmp_path, monkeypatch):
    root_priv, root_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "superclaw.official", "1.0.0", root_priv)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    package = load_plugin_package(src)
    code = verify_cached_package_before_execution(
        package, revocation_file=tmp_path / "rev.json"
    )
    assert code is None  # root-signed reserved namespace is legitimate


def test_non_reserved_namespace_non_root_is_not_a_namespace_violation(tmp_path, monkeypatch):
    dev_priv, dev_pub = _keypair()
    root_priv, root_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "dev.acme.tool", "1.0.0", dev_priv)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    package = load_plugin_package(src)
    code = verify_cached_package_before_execution(
        package, public_key=dev_pub, revocation_file=tmp_path / "rev.json"
    )
    # a non-reserved id signed by a dev key is not a NAMESPACE violation
    assert code != "PLUGIN_NAMESPACE_VIOLATION"


def test_skill_prefix_without_skill_origin_is_rejected_for_non_root(tmp_path, monkeypatch):
    dev_priv, dev_pub = _keypair()
    _root_priv, root_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "skill.spoof", "1.0.0", dev_priv)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    package = load_plugin_package(src)

    code = verify_cached_package_before_execution(
        package, public_key=dev_pub, revocation_file=tmp_path / "rev.json"
    )

    assert code == "PLUGIN_NAMESPACE_VIOLATION"


def test_skill_prefix_with_skill_origin_installed_local_is_allowed_sign_free(tmp_path, monkeypatch):
    # Provenance model (PR-1): a self-imported skill_origin package becomes
    # equippable when installed through a LOCAL entry — graded `local`, sign-free.
    # (Pre-PR-1 this test admitted a dev-key signature directly; under the owner's
    # model a skill is graded by PROVENANCE, not a non-root signature.)
    dev_priv, _dev_pub = _keypair()
    _root_priv, root_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "skill.imported", "1.0.0", dev_priv, skill_origin=True)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    cache_root = tmp_path / "cache"
    # Install through a LOCAL entry: stamps provenance="local" (sign-free).
    verify_plugin_package(
        src, cache_root=cache_root, cache=True, provenance="local", install_entry="skill-build"
    )
    package = load_cached_package("skill.imported", version="1.0.0", cache_root=cache_root)
    assert package is not None

    code = verify_cached_package_before_execution(
        package, revocation_file=tmp_path / "rev.json"
    )

    assert code is None


def test_skill_prefix_with_skill_origin_remote_unverified_is_rejected(tmp_path, monkeypatch):
    # A skill_origin package over the REMOTE channel that does NOT verify under the
    # root key is rejected (untrusted) — never re-admitted via the sign-free local
    # lane. A dev-key signature is not root.
    dev_priv, dev_pub = _keypair()
    _root_priv, root_pub = _keypair()
    src = _build_signed_plugin(tmp_path, "skill.fromremote", "1.0.0", dev_priv, skill_origin=True)
    monkeypatch.setenv(ROOT_KEY_ENV, root_pub)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    cache_root = tmp_path / "cache"
    verify_plugin_package(
        src, public_key=dev_pub, cache_root=cache_root, cache=True, provenance="remote", install_entry="registry-install"
    )
    package = load_cached_package("skill.fromremote", version="1.0.0", cache_root=cache_root)
    assert package is not None

    code = verify_cached_package_before_execution(
        package, public_key=dev_pub, revocation_file=tmp_path / "rev.json"
    )

    assert code == "PLUGIN_SIGNATURE_INVALID"
