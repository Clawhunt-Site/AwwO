"""Per-run plugin verification warm cache.

The plugin sidecar is one-shot by contract (read stdin -> write stdout -> exit),
so the worker process itself cannot be pooled without changing the plugin ABI.
The dominant *repeatable* per-call cost is instead re-hashing every plugin file
and re-verifying its signature on every tool call. These are immutable for a
given on-disk package, so a per-run cache memoizes them — while revocation,
entitlement, and policy are still re-checked on every call (fail-closed).
"""

from __future__ import annotations

import base64
import json
import shutil
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import superclaw.plugin_proxy as pp
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import (
    PluginVerificationError,
    check_plugin_revocation,
    compute_package_digest,
    load_plugin_package,
    verify_plugin_integrity,
    verify_plugin_package,
)

ROOT = Path(__file__).resolve().parents[1]
HELLO_ID = "dev.superclaw.hello-world"


def _cache_hello(tmp_path: Path, *, extra_bytes: int = 0) -> tuple[Path, str]:
    plugin_dir = tmp_path / "hello-world"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", plugin_dir)
    if extra_bytes:  # make digest hashing measurably expensive for the showcase
        (plugin_dir / "big.bin").write_bytes(b"x" * extra_bytes)
    pk = Ed25519PrivateKey.generate()
    pub = base64.b64encode(pk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    mp = plugin_dir / "superclaw-plugin.json"
    m = json.loads(mp.read_text())
    m["provenance"]["package_digest"] = ""
    m["provenance"]["signature"] = ""
    mp.write_text(json.dumps(m, indent=2, sort_keys=True) + "\n")
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    m["provenance"]["package_digest"] = digest
    m["provenance"]["signature"] = "ed25519:" + base64.b64encode(pk.sign(digest.encode())).decode()
    mp.write_text(json.dumps(m, indent=2, sort_keys=True) + "\n")
    cache_root = tmp_path / "cache"
    verify_plugin_package(plugin_dir, public_key=pub, cache_root=cache_root)
    return cache_root, pub


def _pkg(cache_root: Path):
    return load_plugin_package(cache_root / HELLO_ID / "0.1.0")


def test_verify_plugin_integrity_accepts_valid_rejects_bad_signature(tmp_path):
    cache_root, public_key = _cache_hello(tmp_path)
    verify_plugin_integrity(_pkg(cache_root), public_key=public_key)  # no raise
    other = base64.b64encode(
        Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    with pytest.raises(PluginVerificationError):
        verify_plugin_integrity(_pkg(cache_root), public_key=other)


def test_check_plugin_revocation_raises_when_revoked(tmp_path):
    cache_root, _public_key = _cache_hello(tmp_path)
    check_plugin_revocation(_pkg(cache_root), revocation_file=tmp_path / "absent.json")  # no file -> ok
    rf = tmp_path / "rev.json"
    rf.write_text(json.dumps({"revoked": [{"plugin_id": HELLO_ID}]}), encoding="utf-8")
    with pytest.raises(PluginVerificationError):
        check_plugin_revocation(_pkg(cache_root), revocation_file=rf)


def test_warm_cache_verifies_integrity_once_across_calls(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    calls = {"n": 0}
    real = pp.verify_plugin_integrity

    def spy(package, **kwargs):
        calls["n"] += 1
        return real(package, **kwargs)

    monkeypatch.setattr(pp, "verify_plugin_integrity", spy)
    cache: dict = {}
    for _ in range(3):
        result = invoke_cached_plugin_tool(
            HELLO_ID, "hello_world", {"name": "x"},
            cache_root=cache_root, public_key=public_key,
            artifact_dir=tmp_path / "art", verification_cache=cache,
        )
        assert result.ok
    assert calls["n"] == 1  # integrity (hash + signature) computed once, not per call


def test_warm_cache_does_not_bypass_revocation(tmp_path):
    cache_root, public_key = _cache_hello(tmp_path)
    rf = tmp_path / "rev.json"
    rf.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    cache: dict = {}

    first = invoke_cached_plugin_tool(
        HELLO_ID, "hello_world", {"name": "x"},
        cache_root=cache_root, public_key=public_key, revocation_file=rf,
        artifact_dir=tmp_path / "art", verification_cache=cache,
    )
    assert first.ok and cache  # cache now populated

    rf.write_text(json.dumps({"revoked": [{"plugin_id": HELLO_ID}]}), encoding="utf-8")
    second = invoke_cached_plugin_tool(
        HELLO_ID, "hello_world", {"name": "x"},
        cache_root=cache_root, public_key=public_key, revocation_file=rf,
        artifact_dir=tmp_path / "art", verification_cache=cache,
    )
    assert not second.ok  # revocation enforced even with a warm cache (fail-closed)
    assert "PLUGIN_REVOKED" in json.dumps(second.model_response, ensure_ascii=False, default=str)


def test_warm_cache_speedup_showcase(tmp_path, capsys):
    # Showcase: a ~16MB package makes digest hashing measurable in local runs,
    # but CI runners can invert wall-clock timings due filesystem/cache noise.
    # The correctness gate is the populated verification cache; the timings are
    # printed as diagnostics only.
    cache_root, public_key = _cache_hello(tmp_path, extra_bytes=16 * 1024 * 1024)

    def run(n, cache):
        for _ in range(n):
            r = invoke_cached_plugin_tool(
                HELLO_ID, "hello_world", {"name": "x"},
                cache_root=cache_root, public_key=public_key,
                artifact_dir=tmp_path / "art", verification_cache=cache,
            )
            assert r.ok

    n = 5
    t0 = time.monotonic()
    run(n, None)
    cold = time.monotonic() - t0  # no cache: re-verify each call
    t0 = time.monotonic()
    cache: dict = {}
    run(n, cache)
    warm = time.monotonic() - t0  # warm cache: verify once

    with capsys.disabled():
        print(f"\n[warm-cache showcase] {n} calls — cold(no cache)={cold:.3f}s  warm(cache)={warm:.3f}s  saved={cold - warm:.3f}s")
    assert cache
