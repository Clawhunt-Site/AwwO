"""Tests for the Node control-plane co-launch / co-teardown orchestration.

Per the test-pyramid rule: the bulk are in-process assertions (argv/env/marker/
gate logic) that fake the subprocess boundary — fast and parallel-immune. ONE
real-subprocess integration test exercises the genuine spawn + health-wait +
group-teardown path against a stub server (the file is in the serial family).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx
import pytest

import superclaw.node_runtime as nr


# --------------------------------------------------------------------------- #
# Test doubles                                                                 #
# --------------------------------------------------------------------------- #


class DummyResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


class DummyProcess:
    """Fake Popen: poll() walks a script of return codes (None == still running);
    wait() simulates the process dying (and reaping) on demand."""

    def __init__(self, pid: int = 5150, poll_values: list[int | None] | None = None):
        self.pid = pid
        self._poll_values = list(poll_values or [None])
        self.returncode = None
        self.wait_calls: list[float | None] = []

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if self._poll_values:
            value = self._poll_values.pop(0)
            if value is not None:
                self.returncode = value
            return value
        return None

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        self.returncode = 0  # reaped == dead
        return 0


def _make_supervisor(tmp_path: Path, **kwargs) -> nr.NodeServerSupervisor:
    return nr.NodeServerSupervisor(run_dir=tmp_path / "run", **kwargs)


# --------------------------------------------------------------------------- #
# node_server_mode                                                             #
# --------------------------------------------------------------------------- #


def test_mode_defaults_to_auto(monkeypatch):
    monkeypatch.delenv(nr.NODE_SERVER_MODE_ENV, raising=False)
    assert nr.node_server_mode() == "auto"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("auto", "auto"),
        ("on", "on"),
        ("off", "off"),
        ("ON", "on"),
        ("  Off ", "off"),
        ("1", "on"),
        ("true", "on"),
        ("yes", "on"),
        ("0", "off"),
        ("false", "off"),
        ("disabled", "off"),
        ("garbage", "auto"),
        ("", "auto"),
    ],
)
def test_mode_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, raw)
    assert nr.node_server_mode() == expected


# --------------------------------------------------------------------------- #
# resolvers                                                                    #
# --------------------------------------------------------------------------- #


def test_resolve_server_dir_env_override(monkeypatch, tmp_path):
    pkg = tmp_path / "srv"
    pkg.mkdir()
    (pkg / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv(nr.NODE_SERVER_DIR_ENV, str(pkg))
    assert nr.resolve_node_server_dir() == pkg


def test_resolve_server_dir_env_override_without_package_is_none(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_DIR_ENV, str(tmp_path / "nope"))
    assert nr.resolve_node_server_dir() is None


def test_resolve_server_dir_upward_search_finds_vendored(monkeypatch):
    monkeypatch.delenv(nr.NODE_SERVER_DIR_ENV, raising=False)
    found = nr.resolve_node_server_dir()
    # The repo vendors server/server; the upward search must find it.
    assert found is not None
    assert found.name == "server"
    assert (found / "package.json").is_file()


def test_resolve_node_executable_env_override(monkeypatch):
    monkeypatch.setenv(nr.NODE_BIN_ENV, sys.executable)  # any real executable
    assert nr.resolve_node_executable() == sys.executable


def test_resolve_node_executable_bad_override_is_none(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_BIN_ENV, str(tmp_path / "not-a-binary"))
    assert nr.resolve_node_executable() is None


def test_resolve_node_executable_falls_back_to_which(monkeypatch):
    import shutil

    monkeypatch.delenv(nr.NODE_BIN_ENV, raising=False)
    assert nr.resolve_node_executable() == shutil.which("node")


@pytest.mark.parametrize(
    "raw,expected",
    [(None, 3100), ("3810", 3810), ("0", 3100), ("99999", 3100), ("abc", 3100)],
)
def test_resolve_node_port(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv(nr.NODE_PORT_ENV, raising=False)
    else:
        monkeypatch.setenv(nr.NODE_PORT_ENV, raw)
    assert nr.resolve_node_port() == expected


def test_resolve_boot_timeout(monkeypatch):
    monkeypatch.delenv(nr.NODE_BOOT_TIMEOUT_ENV, raising=False)
    assert nr.resolve_node_boot_timeout() == nr.DEFAULT_NODE_BOOT_TIMEOUT_SECONDS
    assert nr.resolve_node_boot_timeout(12.5) == 12.5
    assert nr.resolve_node_boot_timeout(float("inf")) == nr.DEFAULT_NODE_BOOT_TIMEOUT_SECONDS
    monkeypatch.setenv(nr.NODE_BOOT_TIMEOUT_ENV, "30")
    assert nr.resolve_node_boot_timeout() == 30.0
    monkeypatch.setenv(nr.NODE_BOOT_TIMEOUT_ENV, "-5")
    assert nr.resolve_node_boot_timeout() == nr.DEFAULT_NODE_BOOT_TIMEOUT_SECONDS
    monkeypatch.setenv(nr.NODE_BOOT_TIMEOUT_ENV, "99999")
    assert nr.resolve_node_boot_timeout() == nr.MAX_NODE_BOOT_TIMEOUT_SECONDS


# --------------------------------------------------------------------------- #
# resolve_run_command / is_runnable                                           #
# --------------------------------------------------------------------------- #


def test_run_command_prefers_built_dist(tmp_path):
    server = tmp_path / "server"
    (server / "dist").mkdir(parents=True)
    (server / "dist" / "index.js").write_text("//", encoding="utf-8")
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    assert sup.resolve_run_command() == ["/usr/bin/node", str(server / "dist" / "index.js")]
    assert sup.is_runnable() is True


def test_run_command_dist_without_node_bin_is_none(tmp_path):
    server = tmp_path / "server"
    (server / "dist").mkdir(parents=True)
    (server / "dist" / "index.js").write_text("//", encoding="utf-8")
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    sup.node_bin = None  # force-empty (the __init__ sentinel would resolve a real node)
    assert sup.resolve_run_command() is None


def test_run_command_falls_back_to_tsx(tmp_path):
    server = tmp_path / "server"
    (server / "src").mkdir(parents=True)
    (server / "src" / "index.ts").write_text("//", encoding="utf-8")
    binroot = server / "node_modules" / ".bin"
    binroot.mkdir(parents=True)
    tsx = binroot / "tsx"
    tsx.write_text("#!/bin/sh\n", encoding="utf-8")
    tsx.chmod(0o755)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    assert sup.resolve_run_command() == [str(tsx), str(server / "src" / "index.ts")]


def test_run_command_source_only_without_tsx_is_none(tmp_path):
    server = tmp_path / "server"
    (server / "src").mkdir(parents=True)
    (server / "src" / "index.ts").write_text("//", encoding="utf-8")
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    assert sup.resolve_run_command() is None
    assert sup.is_runnable() is False


def test_run_command_no_server_dir_is_none(tmp_path):
    sup = _make_supervisor(tmp_path, server_dir="/nonexistent", node_bin="/usr/bin/node")
    sup.server_dir = None  # force-empty (the __init__ sentinel would resolve the real repo server dir)
    assert sup.resolve_run_command() is None


# --------------------------------------------------------------------------- #
# build_env                                                                    #
# --------------------------------------------------------------------------- #


def test_build_env_sets_server_config(tmp_path):
    sup = _make_supervisor(
        tmp_path,
        host="127.0.0.1",
        port=3100,
        node_home=tmp_path / "node-home",
        instance_id="superclaw",
    )
    env = sup.build_env()
    assert env["HOST"] == "127.0.0.1"
    assert env["PORT"] == "3100"
    assert env["PAPERCLIP_HOME"] == str(tmp_path / "node-home")
    assert env["PAPERCLIP_INSTANCE_ID"] == "superclaw"
    assert env["PAPERCLIP_MIGRATION_AUTO_APPLY"] == "true"
    assert env["PAPERCLIP_MIGRATION_PROMPT"] == "never"


def test_build_env_overrides_win_and_do_not_mutate_os_environ(tmp_path, monkeypatch):
    monkeypatch.setenv("PORT", "9999")  # should be overridden by supervisor
    sup = _make_supervisor(tmp_path, port=3100, env_overrides={"PAPERCLIP_INSTANCE_ID": "custom"})
    env = sup.build_env()
    assert env["PORT"] == "3100"
    assert env["PAPERCLIP_INSTANCE_ID"] == "custom"
    # os.environ untouched
    assert os.environ["PORT"] == "9999"


def test_build_env_augments_path_via_desktop_toolchain(tmp_path, monkeypatch):
    # PATH must run through the kernel's GUI-subprocess toolchain helper (the same
    # one the legacy backends use to find codex) — NOT a bare os.environ copy — so a
    # Finder-launched .app's Node server can resolve the user's local claude/codex.
    # Spy on the helper rather than asserting concrete dirs: which dirs exist is
    # host-dependent (no /opt/homebrew on Linux CI), so a dir assertion would be
    # environment-coupled. We assert the wiring, which is environment-invariant.
    called = {}

    def fake_env(base_env=None):
        called["env"] = True
        return {"PATH": "/sentinel/toolchain"}

    monkeypatch.setattr(nr, "desktop_toolchain_env", fake_env)
    sup = _make_supervisor(tmp_path, port=3100)
    env = sup.build_env()
    assert called.get("env") is True
    assert env["PATH"] == "/sentinel/toolchain"
    # server config is still layered on top of the toolchain env
    assert env["PORT"] == "3100"


def test_build_env_override_path_takes_precedence(tmp_path, monkeypatch):
    # An explicit PATH override must stay FIRST (a deliberately-pinned binary wins
    # over a same-named one in a standard dir); the toolchain dirs are appended only
    # as a deduped fallback. Spy the toolchain helper so the assertion is
    # environment-invariant (no dependency on which dirs exist on the host).
    monkeypatch.setattr(nr, "desktop_toolchain_env", lambda base_env=None: {"PATH": "/should-be-replaced"})
    monkeypatch.setattr(nr, "desktop_toolchain_path", lambda base_path=None: "/opt/homebrew/bin:/usr/bin")
    sup = _make_supervisor(tmp_path, env_overrides={"PATH": "/custom/bin:/usr/bin"})
    env = sup.build_env()
    parts = env["PATH"].split(":")
    # Override entries come first, in their given order.
    assert parts[0] == "/custom/bin"
    # Toolchain dirs are appended as fallback.
    assert "/opt/homebrew/bin" in parts
    # Dedup: /usr/bin (in both override and toolchain) appears once, at its override
    # position — i.e. before the toolchain-only dirs.
    assert parts.count("/usr/bin") == 1
    assert parts.index("/usr/bin") < parts.index("/opt/homebrew/bin")


# --------------------------------------------------------------------------- #
# build_env: workshop receipt key FILE PATH + app_env handoff to the Node import #
# --------------------------------------------------------------------------- #


def test_build_env_injects_workshop_receipt_key_file_path(tmp_path, monkeypatch):
    """build_env provisions the 0600 key file and hands Node its PATH — never the key VALUE, so
    the secret never enters Node's process.env (no child can inherit it). Even when the PARENT
    env carries an old key VALUE (build_env copies os.environ), it must be stripped from the
    Node child env."""
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "production")
    # Parent env carries a stale key VALUE — build_env must NOT propagate it to Node.
    monkeypatch.setenv("SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY", "f" * 64)
    sup = _make_supervisor(tmp_path, node_home=tmp_path / "node-home")
    env = sup.build_env()
    assert env["SUPERCLAW_APP_ENV"] == "production"
    # The key VALUE must never be in the Node env (stripped even though the parent had it).
    assert "SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY" not in env
    # The PATH is injected and points at a provisioned 64-hex 0600 file.
    from pathlib import Path

    key_path = Path(env["SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE"])
    assert key_path.is_file()
    body = key_path.read_text().strip()
    assert len(body) == 64 and all(c in "0123456789abcdef" for c in body)
    assert (key_path.stat().st_mode & 0o177) == 0  # owner-only perms


def test_build_env_workshop_key_fail_soft_when_provisioning_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "staging")
    import superclaw.workshop_receipt_key as wrk

    def _boom():
        raise wrk.WorkshopReceiptKeyError("simulated anomaly")

    monkeypatch.setattr(wrk, "ensure_workshop_receipt_key", _boom)
    sup = _make_supervisor(tmp_path, node_home=tmp_path / "node-home")
    env = sup.build_env()  # must NOT raise — workshop disabled, server still boots
    assert env["SUPERCLAW_APP_ENV"] == "staging"
    assert "SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE" not in env  # never a stale/partial path
    assert "SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY" not in env


# --------------------------------------------------------------------------- #
# build_env: ClawWork governance/executable handoff to the Node adapter        #
# --------------------------------------------------------------------------- #


def test_build_env_injects_clawwork_paths(tmp_path, monkeypatch):
    # The Node clawwork-local adapter resolves its governance ext + executable by
    # walking up to third_party/clawwork, which breaks in a frozen/relocated bundle.
    # build_env must hand it the KERNEL-resolved paths so a packaged app runs
    # ClawWork governed instead of failing closed (CLAWWORK_UNGOVERNED).
    import superclaw.backends as backends

    monkeypatch.setattr(
        backends, "resolve_clawwork_runtime_paths", lambda: ("/k/ext.ts", "/k/clawwork")
    )
    sup = _make_supervisor(tmp_path, port=3100)
    env = sup.build_env()
    assert env["SUPERCLAW_CLAWWORK_GOVERNANCE_EXT"] == "/k/ext.ts"
    assert env["SUPERCLAW_CLAWWORK_EXECUTABLE"] == "/k/clawwork"


def test_build_env_does_not_override_explicit_clawwork_env(tmp_path, monkeypatch):
    # An explicit operator override (env passthrough) must win over the kernel's
    # auto-resolved default — mirrors the adapter's own env-override precedence.
    import superclaw.backends as backends

    monkeypatch.setenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", "/operator/ext.ts")
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", "/operator/clawwork")
    monkeypatch.setattr(
        backends, "resolve_clawwork_runtime_paths", lambda: ("/k/ext.ts", "/k/clawwork")
    )
    sup = _make_supervisor(tmp_path, port=3100)
    env = sup.build_env()
    assert env["SUPERCLAW_CLAWWORK_GOVERNANCE_EXT"] == "/operator/ext.ts"
    assert env["SUPERCLAW_CLAWWORK_EXECUTABLE"] == "/operator/clawwork"


def test_build_env_skips_unresolved_clawwork_paths(tmp_path, monkeypatch):
    # When the kernel cannot resolve a path (unbuilt harness, no bundle), do NOT set
    # an empty/bogus value — leave the key absent so the adapter falls back to its
    # own walk-up and fails closed if that also fails (never run ungoverned).
    import superclaw.backends as backends

    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.setattr(backends, "resolve_clawwork_runtime_paths", lambda: (None, None))
    sup = _make_supervisor(tmp_path, port=3100)
    env = sup.build_env()
    assert "SUPERCLAW_CLAWWORK_GOVERNANCE_EXT" not in env
    assert "SUPERCLAW_CLAWWORK_EXECUTABLE" not in env


def test_build_env_frozen_handoff_resolves_bundle_paths(tmp_path, monkeypatch):
    # End-to-end with the REAL resolver (NOT mocked): the actual target scenario.
    # In a frozen .app the Node adapter cannot walk up to third_party/clawwork — it
    # ships at <backend>/clawwork/. Stage that bundle layout and prove build_env hands
    # the Node child the BUNDLE's governance ext + binary, so a packaged app runs
    # ClawWork governed (mirrors backends._frozen_clawwork_dir's <sys.executable dir>
    # anchor). This closes the gap a helper-mocked test cannot: that the kernel's
    # frozen discovery actually produces <backend>/clawwork/... paths.
    import superclaw.backends as backends

    backend_dir = tmp_path / "backend"
    clawwork = backend_dir / "clawwork"
    (clawwork / "extensions").mkdir(parents=True)
    frozen_exe = backend_dir / "superclaw-backend"
    frozen_exe.write_text("", encoding="utf-8")
    # Platform-correct bundled-binary name: the frozen bundle ships clawwork.exe on
    # Windows, clawwork elsewhere (backends._frozen_clawwork_binary_name), and
    # _frozen_clawwork_dir looks for exactly that name — so the fixture must match it.
    binary = clawwork / backends._frozen_clawwork_binary_name()
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    binary.chmod(0o755)
    gov = clawwork / "extensions" / "superclaw-governance.ts"
    gov.write_text("// gov", encoding="utf-8")

    # Build the supervisor BEFORE flipping sys.frozen so its constructor sees a normal
    # (non-frozen) tree; only the ClawWork handoff inside build_env should see frozen.
    sup = _make_supervisor(tmp_path, port=3100)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.setattr(backends.sys, "frozen", True, raising=False)
    monkeypatch.setattr(backends.sys, "executable", str(frozen_exe))

    env = sup.build_env()

    # _frozen_clawwork_dir anchors on Path(sys.executable).resolve().parent, so the
    # expected paths are the RESOLVED (canonical) bundle paths.
    base = frozen_exe.resolve().parent
    assert env["SUPERCLAW_CLAWWORK_GOVERNANCE_EXT"] == str(base / "clawwork" / "extensions" / "superclaw-governance.ts")
    assert env["SUPERCLAW_CLAWWORK_EXECUTABLE"] == str(base / "clawwork" / backends._frozen_clawwork_binary_name())


def test_build_env_clawwork_handoff_failure_is_nonfatal(tmp_path, monkeypatch):
    # Path discovery touches the filesystem; a failure must NOT block Node startup.
    # The adapter self-resolves + fails closed on its own, so a best-effort handoff
    # cannot weaken governance. build_env must still return a usable env.
    import superclaw.backends as backends

    def boom():
        raise OSError("disk gone")

    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.setattr(backends, "resolve_clawwork_runtime_paths", boom)
    sup = _make_supervisor(tmp_path, port=3100)
    env = sup.build_env()  # must not raise
    assert env["PORT"] == "3100"
    assert "SUPERCLAW_CLAWWORK_GOVERNANCE_EXT" not in env
    assert "SUPERCLAW_CLAWWORK_EXECUTABLE" not in env


# --------------------------------------------------------------------------- #
# marker + probe                                                               #
# --------------------------------------------------------------------------- #


def test_marker_roundtrip(tmp_path):
    sup = _make_supervisor(tmp_path)
    handle = nr.NodeServiceHandle(base_url="http://127.0.0.1:3100", port=3100, pid=42, start_signature="sig")
    sup._write_marker(handle)
    payload = sup._read_marker()
    assert payload == {"base_url": "http://127.0.0.1:3100", "port": 3100, "pid": 42, "start_signature": "sig"}
    sup._remove_marker()
    assert sup._read_marker() is None
    sup._remove_marker()  # idempotent


@pytest.mark.parametrize("status,expected", [(200, True), (404, False), (500, False), (503, False)])
def test_probe_health_status(monkeypatch, tmp_path, status, expected):
    # Strictly 200: a foreign squatter answering 404/403 must NOT read as "ready".
    monkeypatch.setattr(nr.httpx, "get", lambda url, **kw: DummyResponse(status))
    sup = _make_supervisor(tmp_path, port=3100)
    assert sup.probe_health() is expected


def test_probe_health_connection_error_is_down(monkeypatch, tmp_path):
    def _boom(url, **kw):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(nr.httpx, "get", _boom)
    assert _make_supervisor(tmp_path).probe_health() is False


def test_probe_health_invalid_url_is_down(monkeypatch, tmp_path):
    # A malformed host (e.g. raw IPv6) raises httpx.InvalidURL, which is NOT an
    # HTTPError — probe_health must still swallow it (never escape).
    def _boom(url, **kw):
        raise httpx.InvalidURL("bad host")

    monkeypatch.setattr(nr.httpx, "get", _boom)
    assert _make_supervisor(tmp_path).probe_health() is False


def test_build_env_honors_node_home_env(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_HOME_ENV, str(tmp_path / "custom-home"))
    sup = _make_supervisor(tmp_path)  # no explicit node_home arg
    assert sup.node_home == tmp_path / "custom-home"
    assert sup.build_env()["PAPERCLIP_HOME"] == str(tmp_path / "custom-home")


# --------------------------------------------------------------------------- #
# identity-gated teardown (_teardown_marker_pid)                               #
# --------------------------------------------------------------------------- #


def _seed_marker(sup: nr.NodeServerSupervisor, *, pid, signature="sig"):
    sup.run_dir.mkdir(parents=True, exist_ok=True)
    payload = {"base_url": sup.base_url, "port": sup.port, "pid": pid, "start_signature": signature}
    sup.marker_path.write_text(json.dumps(payload), encoding="utf-8")


def test_teardown_no_marker(tmp_path):
    sup = _make_supervisor(tmp_path)
    assert sup._teardown_marker_pid(wait_timeout_seconds=1.0) == {
        "ok": True,
        "stopped": False,
        "reason": "no_marker",
        "pid": None,
    }


def test_teardown_no_pid_clears_marker(tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=None)
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0)
    assert result == {"ok": True, "stopped": False, "reason": "no_pid", "pid": None}
    assert sup._read_marker() is None


def test_teardown_superseded_on_expect_pid_mismatch(tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321)
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0, expect_pid=9999)
    assert result == {"ok": True, "stopped": False, "reason": "superseded", "pid": 4321}
    assert sup._read_marker() is not None  # left alone


def test_teardown_not_running_clears_marker(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321)
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: False)
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0)
    assert result == {"ok": True, "stopped": False, "reason": "not_running", "pid": 4321}
    assert sup._read_marker() is None


def test_teardown_unidentified_when_no_signature(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0)
    assert result == {"ok": True, "stopped": False, "reason": "unidentified", "pid": 4321}
    assert sup._read_marker() is not None  # kept for a later signed overwrite


def test_teardown_identity_unconfirmed_when_live_sig_unreadable(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: None)
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0)
    assert result == {"ok": True, "stopped": False, "reason": "identity_unconfirmed", "pid": 4321}
    assert sup._read_marker() is not None


def test_teardown_pid_reused_skips_signal_and_clears(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "DIFFERENT")
    killed = []
    monkeypatch.setattr(nr, "shutdown_process_pid", lambda *a, **k: killed.append(a))
    result = sup._teardown_marker_pid(wait_timeout_seconds=1.0)
    assert result == {"ok": True, "stopped": False, "reason": "pid_reused", "pid": 4321}
    assert killed == []  # never signalled a recycled pid
    assert sup._read_marker() is None


def test_teardown_identity_match_group_kills_and_clears(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig")
    calls = {}

    def _kill(pid, *, wait_timeout_seconds, process_group):
        calls.update(pid=pid, process_group=process_group, wait_timeout_seconds=wait_timeout_seconds)
        return True

    monkeypatch.setattr(nr, "shutdown_process_pid", _kill)
    result = sup._teardown_marker_pid(wait_timeout_seconds=2.0)
    assert result == {"ok": True, "stopped": True, "reason": None, "pid": 4321}
    assert calls == {"pid": 4321, "process_group": True, "wait_timeout_seconds": 2.0}
    assert sup._read_marker() is None


def test_preclean_delegates_to_teardown(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig")
    monkeypatch.setattr(nr, "shutdown_process_pid", lambda *a, **k: True)
    result = sup.preclean_stale()
    assert result["reason"] is None
    assert result["stopped"] is True


# --------------------------------------------------------------------------- #
# start() (faked subprocess)                                                   #
# --------------------------------------------------------------------------- #


def _runnable_server(tmp_path: Path) -> Path:
    server = tmp_path / "server"
    (server / "dist").mkdir(parents=True)
    (server / "dist" / "index.js").write_text("//", encoding="utf-8")
    return server


def test_start_not_runnable_returns_none_without_spawn(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path, server_dir="/nonexistent", node_bin="/usr/bin/node")
    sup.server_dir = None  # force not-runnable (the __init__ sentinel would resolve the real repo server dir)
    # Neutralize the (separately unit-tested) pre-clean orphan sweep so this test
    # isolates its actual intent: start() must not spawn the NODE process when not
    # runnable. On Windows the sweep's own subprocess.run would otherwise build a
    # Popen and trip the mock below.
    monkeypatch.setattr(sup, "_windows_sweep_instance_orphans", lambda **k: 0)
    monkeypatch.setattr(nr.subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn"))
    assert sup.start() is None


def test_start_spawns_and_registers_without_blocking(monkeypatch, tmp_path):
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node", port=3100)
    captured = {}

    def _popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return DummyProcess(pid=7777)

    monkeypatch.setattr(nr.subprocess, "Popen", _popen)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig-7777")
    monkeypatch.setattr(sup, "_port_is_available", lambda: True)
    # Readiness is async + diagnostics-only; never block start() on health here.
    monkeypatch.setattr(sup, "probe_health", lambda: pytest.fail("start() must not probe health synchronously"))
    readiness = []
    monkeypatch.setattr(sup, "_spawn_readiness_logger", lambda: readiness.append(True))

    handle = sup.start()
    assert handle is not None
    assert handle.pid == 7777
    assert handle.base_url == "http://127.0.0.1:3100"
    assert handle.start_signature == "sig-7777"
    # spawned with the resolved dist command, cwd=server_dir, own session, isolated env
    assert captured["cmd"] == ["/usr/bin/node", str(server / "dist" / "index.js")]
    assert captured["kwargs"]["cwd"] == str(server)
    assert captured["kwargs"]["start_new_session"] == (os.name != "nt")
    assert captured["kwargs"]["env"]["PORT"] == "3100"
    # marker persisted with identity; readiness confirmation spawned (async)
    payload = sup._read_marker()
    assert payload["pid"] == 7777 and payload["start_signature"] == "sig-7777"
    assert readiness == [True]


def test_start_runs_preclean_before_port_check_and_spawn(monkeypatch, tmp_path):
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    order = []
    monkeypatch.setattr(sup, "preclean_stale", lambda: order.append("preclean") or {"reason": "no_marker"})
    monkeypatch.setattr(sup, "_port_is_available", lambda: order.append("portcheck") or True)
    monkeypatch.setattr(sup, "_spawn_readiness_logger", lambda: None)

    def _popen(cmd, **kwargs):
        order.append("spawn")
        return DummyProcess(pid=10)

    monkeypatch.setattr(nr.subprocess, "Popen", _popen)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "s")
    sup.start()
    assert order == ["preclean", "portcheck", "spawn"]


def test_start_refuses_when_port_busy(monkeypatch, tmp_path):
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    monkeypatch.setattr(sup, "preclean_stale", lambda: {"reason": "no_marker"})
    monkeypatch.setattr(sup, "_port_is_available", lambda: False)  # foreign occupant
    monkeypatch.setattr(nr.subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn onto a busy port"))
    assert sup.start() is None


def test_find_free_port_returns_bindable_port():
    port = nr._find_free_port("127.0.0.1")
    assert isinstance(port, int)
    assert 1 <= port <= 65535


def test_start_dynamic_port_fallback_when_busy(monkeypatch, tmp_path):
    # Frozen desktop: a busy configured port must NOT brick the board — Node
    # co-launches on a free port and the marker (read by the front door) records it.
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(
        tmp_path, server_dir=server, node_bin="/usr/bin/node", port=3100, allow_dynamic_port=True
    )
    monkeypatch.setattr(sup, "preclean_stale", lambda: {"reason": "no_marker"})
    monkeypatch.setattr(sup, "_port_is_available", lambda: False)  # 3100 held by a foreign occupant
    monkeypatch.setattr(nr, "_find_free_port", lambda host: 54321)
    monkeypatch.setattr(sup, "_spawn_readiness_logger", lambda: None)
    captured = {}

    def _popen(cmd, **kwargs):
        captured["env_port"] = kwargs["env"]["PORT"]
        return DummyProcess(pid=42)

    monkeypatch.setattr(nr.subprocess, "Popen", _popen)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig")

    handle = sup.start()
    assert handle is not None
    # self.port re-pointed -> base_url (a property), the marker, AND Node's PORT env all follow.
    assert sup.port == 54321
    assert handle.base_url == "http://127.0.0.1:54321"
    assert handle.port == 54321
    assert captured["env_port"] == "54321"
    payload = sup._read_marker()
    assert payload["base_url"] == "http://127.0.0.1:54321"
    assert payload["port"] == 54321


def test_start_fixed_port_refuses_and_skips_fallback(monkeypatch, tmp_path):
    # Default (dev/source, allow_dynamic_port=False): a busy port still refuses to
    # start AND never picks a dynamic port — the vite proxy hardcodes 3100, so a
    # drift would silently break it. Guards the dev path from the new fallback.
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    assert sup.allow_dynamic_port is False
    monkeypatch.setattr(sup, "preclean_stale", lambda: {"reason": "no_marker"})
    monkeypatch.setattr(sup, "_port_is_available", lambda: False)
    monkeypatch.setattr(nr, "_find_free_port", lambda host: pytest.fail("fixed-port mode must not pick a dynamic port"))
    monkeypatch.setattr(nr.subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn onto a busy port"))
    assert sup.start() is None


def test_start_dynamic_port_no_free_port_skips(monkeypatch, tmp_path):
    # allow_dynamic_port but the OS hands back no free port -> skip co-launch (fail
    # open: never spawn onto an unknown port).
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node", allow_dynamic_port=True)
    monkeypatch.setattr(sup, "preclean_stale", lambda: {"reason": "no_marker"})
    monkeypatch.setattr(sup, "_port_is_available", lambda: False)
    monkeypatch.setattr(nr, "_find_free_port", lambda host: None)
    monkeypatch.setattr(nr.subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn without a port"))
    assert sup.start() is None


def test_start_fail_open_on_spawn_error(monkeypatch, tmp_path):
    server = _runnable_server(tmp_path)
    sup = _make_supervisor(tmp_path, server_dir=server, node_bin="/usr/bin/node")
    monkeypatch.setattr(sup, "_port_is_available", lambda: True)

    def _boom(*a, **k):
        raise OSError("exec format error")

    monkeypatch.setattr(nr.subprocess, "Popen", _boom)
    assert sup.start() is None  # never raises


def test_log_readiness_logs_ready_then_returns(monkeypatch, tmp_path, caplog):
    sup = _make_supervisor(tmp_path, port=3100, boot_timeout_seconds=5.0)
    sup._process = DummyProcess(pid=1)
    monkeypatch.setattr(sup, "probe_health", lambda: True)
    with caplog.at_level("INFO", logger="superclaw.node_runtime"):
        sup._log_readiness()
    assert any("ready at" in r.message for r in caplog.records)


def test_log_readiness_quiet_when_stopping(monkeypatch, tmp_path, caplog):
    sup = _make_supervisor(tmp_path, boot_timeout_seconds=5.0)
    sup._process = DummyProcess(pid=1)
    sup._stopping = True
    monkeypatch.setattr(sup, "probe_health", lambda: pytest.fail("must not probe once stopping"))
    with caplog.at_level("WARNING", logger="superclaw.node_runtime"):
        sup._log_readiness()
    assert caplog.records == []  # deliberate teardown -> no warning


# --------------------------------------------------------------------------- #
# stop()                                                                       #
# --------------------------------------------------------------------------- #


def test_stop_uses_live_process_handle(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    proc = DummyProcess(pid=8888)
    sup._process = proc
    _seed_marker(sup, pid=8888, signature="sig")
    seen = {}

    def _terminate(process, *, wait_timeout_seconds):
        seen.update(process=process, wait_timeout_seconds=wait_timeout_seconds)
        return True

    monkeypatch.setattr(sup, "_terminate_live_process", _terminate)
    result = sup.stop(wait_timeout_seconds=1.5)
    assert result == {"ok": True, "stopped": True, "reason": None, "pid": 8888}
    assert seen == {"process": proc, "wait_timeout_seconds": 1.5}
    assert sup._read_marker() is None
    assert sup._process is None


def test_terminate_live_process_group_signals_and_reaps(monkeypatch):
    proc = DummyProcess(pid=4242)
    signals = []
    monkeypatch.setattr(nr.os, "getpgid", lambda pid: pid)  # leader: pgid == pid
    monkeypatch.setattr(nr.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    stopped = nr.NodeServerSupervisor._terminate_live_process(proc, wait_timeout_seconds=1.0)
    assert stopped is True
    assert signals == [(4242, nr.signal.SIGTERM)]  # died on SIGTERM, no SIGKILL needed
    assert proc.wait_calls == [1.0]  # reaped the direct child


def test_terminate_live_process_escalates_to_sigkill(monkeypatch):
    # poll() stays alive across the SIGTERM wait, forcing a SIGKILL escalation.
    class StubbornProcess(DummyProcess):
        def __init__(self):
            super().__init__(pid=4243)
            self._killed = False

        def wait(self, timeout=None):
            self.wait_calls.append(timeout)
            if self._killed:
                self.returncode = 0
                return 0
            raise nr.subprocess.TimeoutExpired(cmd="x", timeout=timeout)

    proc = StubbornProcess()
    signals = []

    def _killpg(pgid, sig):
        signals.append(sig)
        if sig == nr.signal.SIGKILL:
            proc._killed = True

    monkeypatch.setattr(nr.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(nr.os, "killpg", _killpg)
    stopped = nr.NodeServerSupervisor._terminate_live_process(proc, wait_timeout_seconds=0.5)
    assert stopped is True
    assert signals == [nr.signal.SIGTERM, nr.signal.SIGKILL]


def test_stop_falls_back_to_marker_when_no_live_handle(monkeypatch, tmp_path):
    sup = _make_supervisor(tmp_path)
    _seed_marker(sup, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig")
    monkeypatch.setattr(nr, "shutdown_process_pid", lambda *a, **k: True)
    result = sup.stop()
    assert result["reason"] is None and result["pid"] == 4321


# --------------------------------------------------------------------------- #
# module entry points                                                         #
# --------------------------------------------------------------------------- #


def test_start_if_enabled_off_is_noop(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "off")
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", lambda self: pytest.fail("must not start"))
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_if_enabled_auto_skips_when_not_runnable(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "auto")
    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: False)
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", lambda self: pytest.fail("must not start"))
    monkeypatch.setattr(nr.NodeServerSupervisor, "preclean_stale", lambda self: {"reason": "no_marker"})
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_if_enabled_precleans_even_when_not_runnable(monkeypatch, tmp_path):
    # A checkout that lost its build/tsx must STILL reap a prior session's Node
    # orphan, even though it won't start a new one.
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "auto")
    precleaned = []
    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: False)
    monkeypatch.setattr(nr.NodeServerSupervisor, "preclean_stale", lambda self: precleaned.append(True) or {"reason": "no_marker"})
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", lambda self: pytest.fail("must not start"))
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None
    assert precleaned == [True]


def test_start_if_enabled_on_but_not_runnable_returns_none(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")
    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: False)
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_if_enabled_returns_supervisor_on_success(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")
    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: True)
    handle = nr.NodeServiceHandle(base_url="http://127.0.0.1:3100", port=3100, pid=1)
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", lambda self: handle)
    sup = nr.start_node_sidecar_if_enabled(tmp_path / "state.db")
    assert isinstance(sup, nr.NodeServerSupervisor)
    # run_dir derived from state_path parent
    assert sup.run_dir == tmp_path / "run"


def test_start_if_enabled_none_when_start_returns_none(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")
    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: True)
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", lambda self: None)
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_if_enabled_fail_open_on_exception(monkeypatch, tmp_path):
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")

    def _boom(self):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", _boom)
    assert nr.start_node_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_if_enabled_frozen_enables_dynamic_port(monkeypatch, tmp_path):
    # A frozen desktop bundle reaches Node only through the marker-driven front door,
    # so co-launch may fall back to a free port — allow_dynamic_port must be True.
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")
    monkeypatch.setattr(nr.sys, "frozen", True, raising=False)
    seen = {}

    def _fake_start(self):
        seen["allow"] = self.allow_dynamic_port
        return nr.NodeServiceHandle(base_url="http://127.0.0.1:3100", port=3100, pid=1)

    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: True)
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", _fake_start)
    nr.start_node_sidecar_if_enabled(tmp_path / "state.db")
    assert seen["allow"] is True


def test_start_if_enabled_source_keeps_fixed_port(monkeypatch, tmp_path):
    # A dev/source run keeps the fixed port (the vite proxy hardcodes 3100): a port
    # drift would silently break it, so allow_dynamic_port must stay False.
    monkeypatch.setenv(nr.NODE_SERVER_MODE_ENV, "on")
    monkeypatch.setattr(nr.sys, "frozen", False, raising=False)
    seen = {}

    def _fake_start(self):
        seen["allow"] = self.allow_dynamic_port
        return None

    monkeypatch.setattr(nr.NodeServerSupervisor, "is_runnable", lambda self: True)
    monkeypatch.setattr(nr.NodeServerSupervisor, "start", _fake_start)
    nr.start_node_sidecar_if_enabled(tmp_path / "state.db")
    assert seen["allow"] is False


def test_stop_node_sidecar_marker_driven(monkeypatch, tmp_path):
    run_dir = tmp_path / "run"
    sup_seed = nr.NodeServerSupervisor(run_dir=run_dir)
    _seed_marker(sup_seed, pid=4321, signature="sig")
    monkeypatch.setattr(nr, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(nr, "process_start_signature", lambda pid: "sig")
    monkeypatch.setattr(nr, "shutdown_process_pid", lambda *a, **k: True)
    result = nr.stop_node_sidecar(run_dir)
    assert result["reason"] is None and result["pid"] == 4321


def test_stop_node_sidecar_fail_open(monkeypatch, tmp_path):
    def _boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr(nr.NodeServerSupervisor, "stop", _boom)
    result = nr.stop_node_sidecar(tmp_path / "run")
    assert result["ok"] is False and result["reason"] == "error"


# Only proof-of-absence (or a confirmed kill) releases Node.
@pytest.mark.parametrize(
    "py_result",
    [
        {"reason": None, "stopped": True},  # we signalled AND it died
        {"reason": "not_running", "stopped": False},  # pid not alive — confirmed gone
        {"reason": "pid_reused", "stopped": False},  # pid is a different process — gone
    ],
)
def test_stop_node_for_python_result_reaps_when_released(monkeypatch, tmp_path, py_result):
    called = []
    monkeypatch.setattr(
        nr,
        "stop_node_sidecar",
        lambda run_dir, *, host, wait_timeout_seconds: called.append(host) or {"ok": True, "stopped": True, "reason": None, "pid": 7},
    )
    result = nr.stop_node_sidecar_for_python_result(
        tmp_path / "run", {"ok": True, "pid": 1, **py_result}, host="127.0.0.1"
    )
    assert called == ["127.0.0.1"]
    assert result["pid"] == 7


# Python may still be alive (kill failed / attach-only / ambiguity) -> never reap Node.
@pytest.mark.parametrize(
    "py_result",
    [
        {"reason": None, "stopped": False},  # signalled but kill returned False -> maybe alive
        {"reason": "no_pid"},  # attach-only marker: Python IS running, we just don't own its pid
        {"reason": "no_marker"},  # no known Python service here (not proof of absence)
        {"reason": "superseded"},  # another session's sidecar
        {"reason": "unidentified"},  # alive but identity not captured
        {"reason": "identity_unconfirmed"},  # alive but ps momentarily failed
    ],
)
def test_stop_node_for_python_result_skips_when_python_may_live(monkeypatch, tmp_path, py_result):
    monkeypatch.setattr(nr, "stop_node_sidecar", lambda *a, **k: pytest.fail("must not reap a possibly-live session's Node"))
    result = nr.stop_node_sidecar_for_python_result(
        tmp_path / "run", {"ok": True, "pid": 1, **py_result}, host="127.0.0.1"
    )
    assert result == {"ok": True, "stopped": False, "reason": "skipped_python_retained", "pid": None}


def test_install_signal_teardown_noop_for_none(monkeypatch):
    monkeypatch.setattr(nr.signal, "signal", lambda *a, **k: pytest.fail("must not install handlers without a supervisor"))
    nr.install_signal_teardown(None)


def test_install_signal_teardown_handler_stops_and_reraises(monkeypatch, tmp_path):
    installed = {}
    raised = []
    monkeypatch.setattr(nr.signal, "signal", lambda s, h: installed.__setitem__(s, h))
    monkeypatch.setattr(nr.signal, "raise_signal", lambda s: raised.append(s))
    sup = _make_supervisor(tmp_path)
    stopped = []
    monkeypatch.setattr(sup, "stop", lambda **k: stopped.append(True))

    nr.install_signal_teardown(sup)
    assert nr.signal.SIGINT in installed and nr.signal.SIGTERM in installed
    # Invoke the registered handler as the OS would on SIGTERM.
    installed[nr.signal.SIGTERM](nr.signal.SIGTERM, None)
    assert stopped == [True]
    assert raised == [nr.signal.SIGTERM]  # re-raised for correct exit status


def test_install_signal_teardown_multi_supervisor_reverse_order(monkeypatch):
    """Multiple sidecars are torn down in REVERSE of the start order (last-started
    first), so a signal never kills the Node upstream out from under the gateway that
    depends on it. Callers pass supervisors in start order (node, gateway); None is
    ignored."""
    installed = {}
    monkeypatch.setattr(nr.signal, "signal", lambda s, h: installed.__setitem__(s, h))
    monkeypatch.setattr(nr.signal, "raise_signal", lambda s: None)
    order = []

    class _Sup:
        def __init__(self, name):
            self.name = name

        def stop(self, **_k):
            order.append(self.name)

    nr.install_signal_teardown(_Sup("node"), None, _Sup("gateway"))
    installed[nr.signal.SIGTERM](nr.signal.SIGTERM, None)
    assert order == ["gateway", "node"]  # reverse of start order


def test_ipv6_host_bracketed_in_urls_and_port_family(tmp_path):
    sup = _make_supervisor(tmp_path, host="::1", port=3100)
    assert sup.base_url == "http://[::1]:3100"
    assert sup.health_url == "http://[::1]:3100/api/health"
    # Port check must use the IPv6 family for a raw IPv6 host (no crash / no AF_INET mismatch).
    assert isinstance(sup._port_is_available(), bool)


# --------------------------------------------------------------------------- #
# Integration: real spawn + health-wait + group teardown (serial family)      #
# --------------------------------------------------------------------------- #

_STUB_SERVER = """
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a):
        pass

port = int(os.environ["PORT"])
HTTPServer(("127.0.0.1", port), H).serve_forever()
"""


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group teardown")
def test_integration_real_spawn_health_and_group_teardown(monkeypatch, tmp_path):
    from superclaw.desktop_runtime import _pid_exists, reserve_local_port

    stub = tmp_path / "stub_server.py"
    stub.write_text(_STUB_SERVER, encoding="utf-8")
    port = reserve_local_port()
    server_dir = tmp_path / "server"
    server_dir.mkdir()

    sup = nr.NodeServerSupervisor(
        run_dir=tmp_path / "run",
        host="127.0.0.1",
        port=port,
        server_dir=server_dir,
        node_bin=sys.executable,
        node_home=tmp_path / "node-home",
        boot_timeout_seconds=20.0,
        connect_timeout_seconds=0.5,
    )
    # Drive a real python stub through the genuine Popen + group-teardown path.
    monkeypatch.setattr(sup, "resolve_run_command", lambda: [sys.executable, str(stub)])

    handle = sup.start()  # non-blocking: returns right after spawn
    try:
        assert handle is not None, "stub server should spawn"
        assert handle.pid and _pid_exists(handle.pid)
        assert sup._read_marker()["pid"] == handle.pid
        # Readiness is async now; poll the real stub's /api/health until it answers.
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline and not sup.probe_health():
            time.sleep(0.1)
        assert sup.probe_health() is True, "stub server should become ready"
    finally:
        result = sup.stop(wait_timeout_seconds=5.0)

    assert result["stopped"] is True
    # Give the OS a beat to reap, then confirm the process is truly gone.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and _pid_exists(handle.pid):
        time.sleep(0.05)
    assert not _pid_exists(handle.pid)
    assert sup._read_marker() is None


# --------------------------------------------------------------------------- #
# Coexistence readiness snapshot (web startup gate reads this via               #
# /api/runtime/status). In-process: no spawn, no probe.                         #
# --------------------------------------------------------------------------- #


class _FakeProc:
    """Minimal subprocess.Popen stand-in: poll() returns None while "alive", else exit."""

    def __init__(self, returncode: int | None = None) -> None:
        self._returncode = returncode

    def poll(self) -> int | None:
        return self._returncode


def _quiet_supervisor(tmp_path: Path) -> nr.NodeServerSupervisor:
    # Explicit port/server_dir/node_bin so construction never touches the real
    # environment (no resolution, no spawn) — a pure state holder. No _process, so stop()
    # takes the no-handle teardown path; attach a _FakeProc explicitly where liveness matters.
    return nr.NodeServerSupervisor(run_dir=tmp_path, port=3199, server_dir=tmp_path, node_bin="node")


@pytest.fixture(autouse=True)
def _reset_active_supervisor():
    # start_node_sidecar_if_enabled writes the process-singleton; reset after every test
    # so ordering/parallelism can't leak a stale supervisor between cases.
    yield
    nr._ACTIVE_SUPERVISOR = None


def test_is_ready_requires_cached_flag_and_live_process(tmp_path):
    sup = _quiet_supervisor(tmp_path)
    sup._process = _FakeProc(returncode=None)  # type: ignore[assignment]  # alive
    assert sup.is_ready() is False  # cached flag not set yet → not ready
    sup._ready = True
    assert sup.is_ready() is True  # ready flag + live process
    # Node crashed after first-ready: liveness check must flip it back, so a dead Node is
    # never reported ready (the crux of Codex's desktop false-positive).
    sup._process = _FakeProc(returncode=1)  # type: ignore[assignment]
    assert sup.is_ready() is False
    # A nil process handle cannot be confirmed live → fail-closed not-ready.
    sup._process = None
    assert sup.is_ready() is False


def test_node_runtime_status_snapshot_disabled_when_optional_and_absent(monkeypatch):
    # auto/off with no co-launched Node ⇒ disabled, so the web gate must not wait.
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", None)
    monkeypatch.setenv("SUPERCLAW_NODE_SERVER", "auto")
    assert nr.node_runtime_status_snapshot() == {
        "enabled": False,
        "ready": False,
        "url": None,
        "port": None,
        "error": None,
    }


def test_node_runtime_status_snapshot_required_but_absent_stays_enabled_with_error(monkeypatch):
    # SUPERCLAW_NODE_SERVER=on but no live supervisor (start failed / not runnable): the
    # gate must still WAIT (enabled=true) so the failure surfaces, never masked as "no Node".
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", None)
    monkeypatch.setenv("SUPERCLAW_NODE_SERVER", "on")
    snap = nr.node_runtime_status_snapshot()
    assert snap["enabled"] is True
    assert snap["ready"] is False
    assert snap["error"] and "required" in snap["error"]


def test_node_runtime_status_snapshot_reflects_active_supervisor(monkeypatch, tmp_path):
    sup = _quiet_supervisor(tmp_path)
    sup._process = _FakeProc(returncode=None)  # type: ignore[assignment]  # alive
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", sup)
    snap = nr.node_runtime_status_snapshot()
    assert snap["enabled"] is True
    assert snap["ready"] is False  # cached flag not yet flipped by the readiness logger
    assert snap["url"] == "http://127.0.0.1:3199"
    assert snap["port"] == 3199
    assert snap["error"] is None
    sup._ready = True
    assert nr.node_runtime_status_snapshot()["ready"] is True


def test_node_runtime_status_snapshot_not_ready_when_supervisor_process_died(monkeypatch, tmp_path):
    # ready cached True but process exited → snapshot must report ready=false.
    sup = _quiet_supervisor(tmp_path)
    sup._process = _FakeProc(returncode=0)  # type: ignore[assignment]  # exited
    sup._ready = True
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", sup)
    assert nr.node_runtime_status_snapshot()["ready"] is False


def test_stop_deregisters_active_supervisor_and_clears_ready(monkeypatch, tmp_path):
    sup = _quiet_supervisor(tmp_path)
    sup._ready = True
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", sup)
    monkeypatch.setenv("SUPERCLAW_NODE_SERVER", "auto")
    # No live marker → a best-effort no-op teardown, but it must still deregister and
    # clear the cached ready flag so status stops reporting Node.
    sup.stop()
    assert sup._ready is False
    assert nr.active_node_supervisor() is None
    assert nr.node_runtime_status_snapshot()["enabled"] is False


def test_stop_does_not_deregister_a_different_active_supervisor(monkeypatch, tmp_path):
    # Identity guard: stopping an OLD supervisor must not clear a newer one that
    # replaced it in the process-active slot.
    newer = _quiet_supervisor(tmp_path)
    older = _quiet_supervisor(tmp_path / "older")
    monkeypatch.setattr(nr, "_ACTIVE_SUPERVISOR", newer)
    older.stop()
    assert nr.active_node_supervisor() is newer


# --------------------------------------------------------------------------- #
# Windows orphan reaper (detached embedded-PostgreSQL postmaster)              #
#                                                                             #
# The reaper is pure-Python (postmaster.pid file read + ctypes Toolhelp/       #
# QueryFullProcessImageNameW + os.kill) so it works in a frozen PyInstaller    #
# service where powershell/taskkill silently fail. The reaping LOGIC is tested #
# platform-independently by mocking the three ctypes/os primitives; the real   #
# ctypes primitives get a Windows-native sanity check. os.name is NOT          #
# monkeypatched (that breaks pathlib on Windows).                              #
# --------------------------------------------------------------------------- #

_IS_WINDOWS = os.name == "nt"


def _sweep_supervisor(tmp_path: Path) -> nr.NodeServerSupervisor:
    return nr.NodeServerSupervisor(
        run_dir=tmp_path / "run",
        server_dir=tmp_path / "srv",
        node_home=tmp_path / "home",
        instance_id="superclaw",
        node_bin="node",
    )


def test_instance_home_derivation(tmp_path):
    sup = _sweep_supervisor(tmp_path)
    assert sup.instance_home == tmp_path / "home" / "instances" / "superclaw"


@pytest.mark.skipif(_IS_WINDOWS, reason="exercises the non-Windows early return")
def test_windows_sweep_noop_off_windows(tmp_path):
    sup = _sweep_supervisor(tmp_path)
    assert sup._windows_sweep_instance_orphans(context="test") == 0


def test_reap_verified_tree_kills_postmaster_and_pg_children(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    P, B1, B2, U, Q = 100, 101, 102, 103, 200
    base = [
        (P, 1, "postgres.exe"),   # our postmaster (root)
        (B1, P, "postgres.exe"),  # backend child -> kill
        (B2, P, "postgres.exe"),  # backend child -> kill
        (U, P, "conhost.exe"),    # non-pg child of root -> keep (wrong image)
        (Q, 1, "postgres.exe"),   # unrelated postgres elsewhere -> keep (not in tree)
    ]
    killed: list[int] = []
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: killed.append(pid))
    # Stateful snapshot: killed pids leave the process table, so the gone-check sees P go.
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [t for t in base if t[0] not in killed])
    assert sup._reap_verified_tree(P, "postgres.exe", context="t", kind="postmaster") == 1
    assert sorted(killed) == [P, B1, B2]


def test_reap_verified_tree_skips_recycled_pid(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [(100, 1, "chrome.exe")])
    killed: list[int] = []
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: killed.append(pid))
    # pid 100 is alive but NOT postgres.exe (recycled) -> never touched
    assert sup._reap_verified_tree(100, "postgres.exe", context="t", kind="x") == 0
    assert killed == []


def test_reap_verified_tree_skips_dead_pid(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [(1, 0, "system")])  # 100 absent
    killed: list[int] = []
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: killed.append(pid))
    assert sup._reap_verified_tree(100, "postgres.exe", context="t", kind="x") == 0
    assert killed == []


def test_reap_verified_tree_skips_self_and_supervised(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    killed: list[int] = []
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: killed.append(pid))
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [(nr.os.getpid(), 1, "postgres.exe")])
    assert sup._reap_verified_tree(nr.os.getpid(), "postgres.exe", context="t", kind="x") == 0
    sup._process = DummyProcess(pid=777)
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [(777, 1, "node.exe")])
    assert sup._reap_verified_tree(777, "node.exe", context="t", kind="node") == 0
    assert killed == []


def test_reap_verified_tree_follows_only_same_image_children(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    P, C = 100, 101
    base = [(P, 1, "node.exe"), (C, P, "claude.exe")]  # node with a non-node child
    killed: list[int] = []
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: killed.append(pid))
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [t for t in base if t[0] not in killed])
    assert sup._reap_verified_tree(P, "node.exe", context="t", kind="node") == 1
    assert killed == [P]  # child claude.exe is a different image -> not killed


def test_reap_verified_tree_reports_zero_when_survives(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    # Process never leaves the table (kill is a no-op) -> the bounded gone-poll times
    # out and reports 0. Drive time deterministically so the test is instant.
    monkeypatch.setattr(sup, "_windows_iter_processes", lambda: [(100, 1, "postgres.exe")])
    monkeypatch.setattr(nr.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(nr.time, "sleep", lambda s: None)
    ticks = iter([0.0, 1.0, 2.0, 3.0, 4.0])
    monkeypatch.setattr(nr.time, "monotonic", lambda: next(ticks))
    assert sup._reap_verified_tree(100, "postgres.exe", context="t", kind="x") == 0


def test_reap_orphan_postmaster_reads_pidfile(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    db = sup.instance_home / "db"
    db.mkdir(parents=True)
    (db / "postmaster.pid").write_text("4242\nC:/data\n1700000000\n54329\n", encoding="utf-8")
    seen: dict = {}
    monkeypatch.setattr(
        sup, "_reap_verified_tree",
        lambda pid, exe, *, context, kind: seen.update(pid=pid, exe=exe, kind=kind) or 1,
    )
    assert sup._reap_orphan_postmaster(context="t") == 1
    assert seen == {"pid": 4242, "exe": "postgres.exe", "kind": "postmaster"}


def test_reap_orphan_postmaster_missing_pidfile(tmp_path):
    sup = _sweep_supervisor(tmp_path)
    assert sup._reap_orphan_postmaster(context="t") == 0  # no lockfile -> no-op


def test_reap_orphan_node_reads_marker(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    sup.run_dir.mkdir(parents=True, exist_ok=True)
    sup._write_marker(nr.NodeServiceHandle(base_url="http://127.0.0.1:3100", port=3100, pid=5150))
    seen: dict = {}
    monkeypatch.setattr(
        sup, "_reap_verified_tree",
        lambda pid, exe, *, context, kind: seen.update(pid=pid, exe=exe, kind=kind) or 1,
    )
    assert sup._reap_orphan_node(context="t") == 1
    assert seen == {"pid": 5150, "exe": "node.exe", "kind": "node"}


def test_reap_orphan_node_no_marker(tmp_path):
    sup = _sweep_supervisor(tmp_path)
    assert sup._reap_orphan_node(context="t") == 0


@pytest.mark.skipif(not _IS_WINDOWS, reason="ctypes Toolhelp snapshot is Windows-only")
def test_windows_ctypes_primitives_sane():
    procs = nr.NodeServerSupervisor._windows_iter_processes()
    pids = {pid for pid, _pp, _n in procs}
    assert len(procs) > 5  # a real snapshot has many processes
    assert nr.os.getpid() in pids  # our own process shows up in the snapshot
    assert all(isinstance(n, str) for _p, _pp, n in procs)  # image base names resolved


def test_preclean_runs_sweep_at_most_once(monkeypatch, tmp_path):
    # Platform-independent: the sweep METHOD is replaced with a spy, so the one-shot
    # guard in preclean_stale is what is under test (not the os.name branch inside).
    sup = _sweep_supervisor(tmp_path)
    calls = {"n": 0}
    monkeypatch.setattr(
        sup, "_windows_sweep_instance_orphans", lambda **k: calls.__setitem__("n", calls["n"] + 1) or 0
    )
    sup.preclean_stale()
    sup.preclean_stale()
    assert calls["n"] == 1  # one-shot guard dedupes the two boot-path pre-cleans


def test_stop_sweep_runs_even_after_preclean(monkeypatch, tmp_path):
    sup = _sweep_supervisor(tmp_path)
    contexts: list[str] = []
    monkeypatch.setattr(
        sup, "_windows_sweep_instance_orphans", lambda *, context: contexts.append(context) or 0
    )
    sup.preclean_stale()  # -> "pre-clean"
    sup.stop()            # -> "stop" (NOT gated by the one-shot guard)
    assert contexts == ["pre-clean", "stop"]


# --------------------------------------------------------------------------- #
# PGlite promotion (desktop default for FRESH installs)                        #
# --------------------------------------------------------------------------- #


def _pglite_env_supervisor(tmp_path: Path, monkeypatch) -> nr.NodeServerSupervisor:
    sup = _sweep_supervisor(tmp_path)
    # Isolate build_env to the decision under test: no filesystem side channels.
    monkeypatch.setattr(sup, "_inject_workshop_receipt_config", lambda env: None)
    monkeypatch.setattr(sup, "_inject_clawwork_paths", lambda env: None)
    monkeypatch.setattr(nr, "desktop_toolchain_env", lambda: {})
    monkeypatch.delenv("SUPERCLAW_DESKTOP_PGLITE", raising=False)
    return sup


def test_build_env_defaults_fresh_install_to_pglite(monkeypatch, tmp_path):
    sup = _pglite_env_supervisor(tmp_path, monkeypatch)
    env = sup.build_env()  # no legacy cluster (no db/PG_VERSION)
    assert env.get("SUPERCLAW_DESKTOP_PGLITE") == "1"


def test_build_env_keeps_embedded_for_legacy_cluster(monkeypatch, tmp_path):
    sup = _pglite_env_supervisor(tmp_path, monkeypatch)
    db = sup.instance_home / "db"
    db.mkdir(parents=True)
    (db / "PG_VERSION").write_text("18\n", encoding="utf-8")
    env = sup.build_env()
    assert "SUPERCLAW_DESKTOP_PGLITE" not in env  # legacy data stays on embedded PG


def test_build_env_explicit_pglite_choice_wins(monkeypatch, tmp_path):
    sup = _pglite_env_supervisor(tmp_path, monkeypatch)
    # Explicit opt-out on a FRESH install (auto would have said "1").
    sup.env_overrides = {"SUPERCLAW_DESKTOP_PGLITE": "0"}
    assert sup.build_env().get("SUPERCLAW_DESKTOP_PGLITE") == "0"
    # Explicit opt-in on a LEGACY install (auto would have stayed embedded).
    db = sup.instance_home / "db"
    db.mkdir(parents=True)
    (db / "PG_VERSION").write_text("18\n", encoding="utf-8")
    sup.env_overrides = {"SUPERCLAW_DESKTOP_PGLITE": "1"}
    assert sup.build_env().get("SUPERCLAW_DESKTOP_PGLITE") == "1"
