"""Unit tests for the frozen-bundle Node runtime resolution (node_runtime.py).

In-process, instant: a fake frozen bundle layout is built under tmp_path and
``sys.frozen``/``sys.executable`` are monkeypatched. Verifies the packaged app
auto-discovers the embedded ``node-runtime/`` next to the frozen backend, fails
closed on a half-shipped bundle, and NEVER falls back to an ambient ``node`` /
source tree when frozen.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# The embedded runtime ships node.exe on Windows, an extensionless node on POSIX —
# mirror node_runtime.py's platform-aware lookup so the fake bundle is discoverable.
_NODE_BIN = "node.exe" if os.name == "nt" else "node"

import pytest

from superclaw.node_runtime import (
    _frozen_node_runtime_dir,
    resolve_node_executable,
    resolve_node_server_dir,
)


def _make_bundle(tmp_path: Path, *, with_node: bool = True, with_server: bool = True) -> Path:
    """Build a fake frozen bundle and return the (fake) frozen backend executable.

    Layout mirrors prepare-macos-bundle.mjs: the embedded ``node-runtime/`` sits
    next to the backend executable, holding ``node`` + ``server/`` (dist + manifest).
    """
    exe_dir = tmp_path / "backend" / "superclaw-backend"
    exe_dir.mkdir(parents=True)
    exe = exe_dir / "superclaw-backend"
    exe.write_text("#!/bin/sh\n", encoding="utf-8")
    home = exe_dir / "node-runtime"
    home.mkdir()
    if with_node:
        node = home / _NODE_BIN
        node.write_text("#!/bin/sh\n", encoding="utf-8")
        node.chmod(0o755)
    if with_server:
        server = home / "server"
        (server / "dist").mkdir(parents=True)
        (server / "dist" / "index.js").write_text("// built\n", encoding="utf-8")
        (server / "package.json").write_text("{}", encoding="utf-8")
    return exe


def _as_frozen(monkeypatch: pytest.MonkeyPatch, exe: Path) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))


def test_frozen_dir_none_when_not_frozen(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    exe = _make_bundle(tmp_path)
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    assert _frozen_node_runtime_dir() is None


def test_frozen_dir_resolves_complete_bundle(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _as_frozen(monkeypatch, _make_bundle(tmp_path))
    home = _frozen_node_runtime_dir()
    assert home is not None
    assert home.name == "node-runtime"


def test_frozen_dir_fails_closed_when_node_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _as_frozen(monkeypatch, _make_bundle(tmp_path, with_node=False))
    assert _frozen_node_runtime_dir() is None


def test_frozen_dir_fails_closed_when_server_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _as_frozen(monkeypatch, _make_bundle(tmp_path, with_server=False))
    assert _frozen_node_runtime_dir() is None


def test_resolve_node_executable_frozen_uses_embedded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SUPERCLAW_NODE_BIN", raising=False)
    _as_frozen(monkeypatch, _make_bundle(tmp_path))
    result = resolve_node_executable()
    assert result is not None
    resolved = Path(result)
    assert resolved.name == _NODE_BIN
    assert resolved.parent.name == "node-runtime"


def test_resolve_node_executable_frozen_never_falls_back_to_ambient(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("SUPERCLAW_NODE_BIN", raising=False)
    _as_frozen(monkeypatch, _make_bundle(tmp_path, with_node=False))
    # Even if an ambient node exists on PATH, a frozen bundle without an embedded
    # node must resolve to None (fail-closed) rather than launch an unknown binary.
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/local/bin/node")
    assert resolve_node_executable() is None


def test_resolve_node_executable_override_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    node = tmp_path / "mynode"
    node.write_text("", encoding="utf-8")
    node.chmod(0o755)
    monkeypatch.setenv("SUPERCLAW_NODE_BIN", str(node))
    assert resolve_node_executable() == str(node)


def test_resolve_node_server_dir_frozen_uses_embedded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SUPERCLAW_NODE_SERVER_DIR", raising=False)
    _as_frozen(monkeypatch, _make_bundle(tmp_path))
    result = resolve_node_server_dir()
    assert result is not None
    assert result.name == "server"
    assert (result / "package.json").is_file()


def test_resolve_node_server_dir_frozen_fails_closed_half_shipped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("SUPERCLAW_NODE_SERVER_DIR", raising=False)
    _as_frozen(monkeypatch, _make_bundle(tmp_path, with_node=False))
    assert resolve_node_server_dir() is None
