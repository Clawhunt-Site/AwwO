"""Tests for the frozen-backend CLI shim's desktop fast-path.

The shipped .app invokes the PyInstaller-frozen `superclaw-backend` binary,
whose `_run_desktop_fast` intercepts `desktop start/probe/stop` before the Typer
CLI loads. Its `stop` behaviour MUST stay in lockstep with the Typer
`desktop stop` command in `superclaw.cli` — the desktop shell hits whichever
entry point ships, and exit-time cleanup relies on the marker-driven (no `--pid`)
form working identically in both.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import apps.desktop.backend.superclaw_service as shim
import superclaw.desktop_runtime as desktop_runtime
import superclaw.node_runtime as node_runtime


def test_desktop_fast_stop_without_pid_uses_marker(monkeypatch, capsys):
    captured: dict[str, object] = {}

    class _FakeSupervisor:
        def __init__(self, *, state_path, host):
            captured["state_path"] = str(state_path)
            captured["host"] = host
            self.run_dir = Path(state_path).parent / "run"

        def stop_service(self, *, wait_timeout_seconds=2.0, process_group=True, expect_pid=None):
            captured["wait_timeout_seconds"] = wait_timeout_seconds
            captured["process_group"] = process_group
            captured["expect_pid"] = expect_pid
            return {"ok": True, "stopped": True, "reason": None, "pid": 4321}

    def _fake_stop_node(run_dir, *, host, wait_timeout_seconds):
        captured["node_run_dir"] = str(run_dir)
        captured["node_host"] = host
        captured["node_wait"] = wait_timeout_seconds
        return {"ok": True, "stopped": False, "reason": "no_marker", "pid": None}

    monkeypatch.setattr(desktop_runtime, "DesktopRuntimeSupervisor", _FakeSupervisor)
    monkeypatch.setattr(node_runtime, "stop_node_sidecar", _fake_stop_node)

    handled = shim._run_desktop_fast(
        ["desktop", "stop", "--wait-timeout", "1.5", "--expect-pid", "4321", "--state-path", "/tmp/st/state.db"]
    )

    assert handled is True
    # The Python teardown result is unchanged; the Node teardown is an additive key.
    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "stopped": True,
        "reason": None,
        "pid": 4321,
        "node": {"ok": True, "stopped": False, "reason": "no_marker", "pid": None},
    }
    assert captured["wait_timeout_seconds"] == 1.5
    assert captured["host"] == "127.0.0.1"
    assert captured["process_group"] is True
    assert captured["expect_pid"] == 4321  # session-ownership scope flows through (CLI parity)
    # Node teardown is marker-driven off the SAME run dir, host, and wait budget.
    assert captured["node_run_dir"] == str(Path("/tmp/st") / "run")
    assert captured["node_host"] == "127.0.0.1"
    assert captured["node_wait"] == 1.5


def test_desktop_fast_stop_with_pid_respects_no_owned(monkeypatch, capsys):
    # Parity with Typer CLI: --no-owned must NOT force-kill, and the response must
    # carry the pid field. The frozen shim is the entry point the shipped app hits.
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    handled = shim._run_desktop_fast(["desktop", "stop", "--pid", "9123", "--no-owned"])

    assert handled is True
    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "stopped": False,
        "reason": "not_owned",
        "pid": 9123,
    }
    assert called["value"] is False  # unowned handle never signalled


def test_desktop_fast_stop_with_pid_defaults_to_process_group(monkeypatch, capsys):
    seen: dict[str, object] = {}

    def _fake_shutdown(pid, *, wait_timeout_seconds=2.0, process_group=False):
        seen["pid"] = pid
        seen["process_group"] = process_group
        return True

    monkeypatch.setattr(desktop_runtime, "shutdown_process_pid", _fake_shutdown)
    monkeypatch.setattr(
        node_runtime,
        "stop_node_sidecar",
        lambda *a, **k: pytest.fail("--pid is Python-only; it must not reap Node"),
    )

    handled = shim._run_desktop_fast(["desktop", "stop", "--pid", "8123"])

    assert handled is True
    # --pid is Python-only (no "node" key) — parity with the Typer command.
    assert json.loads(capsys.readouterr().out) == {"ok": True, "stopped": True, "pid": 8123}
    assert seen == {"pid": 8123, "process_group": True}


def test_desktop_fast_stop_with_pid_no_tree_disables_group(monkeypatch, capsys):
    seen: dict[str, object] = {}

    def _fake_shutdown(pid, *, wait_timeout_seconds=2.0, process_group=False):
        seen["process_group"] = process_group
        return False

    monkeypatch.setattr(desktop_runtime, "shutdown_process_pid", _fake_shutdown)
    monkeypatch.setattr(
        node_runtime,
        "stop_node_sidecar",
        lambda *a, **k: pytest.fail("--pid is Python-only; it must not reap Node"),
    )

    handled = shim._run_desktop_fast(["desktop", "stop", "--pid", "8123", "--no-tree"])

    assert handled is True
    assert json.loads(capsys.readouterr().out) == {"ok": True, "stopped": False, "pid": 8123}
    assert seen["process_group"] is False


def test_desktop_fast_start_passes_watch_ui_pid(monkeypatch):
    captured: dict[str, object] = {}

    class _FakeHandle:
        base_url = "http://127.0.0.1:9000"
        control_token = "t"

    class _FakeSupervisor:
        connect_timeout_seconds = 0.5

        def __init__(self, **kwargs):
            captured["watch_ui_pid"] = kwargs.get("watch_ui_pid")

        def start_or_connect(self, *, control_token=None):
            return _FakeHandle()

    monkeypatch.setattr(desktop_runtime, "DesktopRuntimeSupervisor", _FakeSupervisor)
    monkeypatch.setattr(desktop_runtime, "desktop_service_handle_payload", lambda h: {"pid": 1})
    monkeypatch.setattr(desktop_runtime, "probe_service_status", lambda **k: {"health": {"ok": True}})

    shim._run_desktop_fast(["desktop", "start", "--watch-ui-pid", "4321"])

    assert captured["watch_ui_pid"] == 4321


def test_service_fast_starts_ui_watchdog(monkeypatch):
    started: dict[str, object] = {}

    class _Thread:
        def __init__(self, *, target, args, daemon):
            started["target_name"] = getattr(target, "__name__", str(target))
            started["args"] = args
            started["daemon"] = daemon

        def start(self):
            started["started"] = True

    import threading as _threading

    monkeypatch.setattr(_threading, "Thread", _Thread)
    # Stub the heavy bits so _run_service_fast returns without booting a server.
    import apps.api.main as _apimain

    monkeypatch.setattr(_apimain, "create_app", lambda **k: object())
    import uvicorn as _uv

    monkeypatch.setattr(_uv, "run", lambda *a, **k: None)
    from superclaw import runtime_config as _rc

    monkeypatch.setattr(_rc, "hydrate_runtime_environment", lambda: None)

    shim._run_service_fast(["--port", "9000", "--watch-ui-pid", "4321"])

    assert started.get("started") is True
    assert started["target_name"] == "run_ui_watchdog"
    assert started["args"] == (4321,)
    assert started["daemon"] is True
