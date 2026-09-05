import json

import httpx
import pytest

import superclaw.desktop_runtime as desktop_runtime


class DummyResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return dict(self._payload)


class DummyProcess:
    def __init__(self, pid: int = 4321, poll_values: list[int | None] | None = None):
        self.pid = pid
        self._poll_values = list(poll_values or [None])
        self.returncode = None
        self.terminated = False
        self.killed = False
        self.wait_calls: list[float] = []

    def poll(self):
        if self._poll_values:
            value = self._poll_values.pop(0)
            if value is not None:
                self.returncode = value
            return value
        return None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout: float):
        self.wait_calls.append(timeout)
        if self.killed:
            self.returncode = -9
        elif self.terminated:
            self.returncode = 0
        return self.returncode

    def kill(self):
        self.killed = True


def test_probe_service_status_returns_none_on_http_error(monkeypatch):
    def _boom(*args, **kwargs):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(desktop_runtime.httpx, "get", _boom)

    assert desktop_runtime.probe_service_status(base_url="http://127.0.0.1:8788", control_token="secret") is None


def test_probe_service_status_requires_health_and_runtime(monkeypatch):
    seen = []

    def _fake_get(url, **kwargs):
        seen.append((url, kwargs))
        if url.endswith("/health"):
            return DummyResponse(200, {"ok": True})
        return DummyResponse(200, {"service": {"name": "superclaw"}})

    monkeypatch.setattr(desktop_runtime.httpx, "get", _fake_get)
    status = desktop_runtime.probe_service_status(
        base_url="http://127.0.0.1:8788",
        control_token="secret-control",
        timeout_seconds=0.25,
    )

    assert status == {
        "health": {"ok": True},
        "runtime": {"service": {"name": "superclaw"}},
    }
    assert seen[1][1]["headers"] == {"X-SuperClaw-Token": "secret-control"}


def test_probe_service_status_ready_on_health_even_if_runtime_times_out(monkeypatch):
    """Readiness keys off /health only; a slow/failing runtime probe must not
    block boot (the bundled backend's /api/runtime/status does live toolchain
    detection that can exceed the probe timeout under a GUI-launched env)."""

    def _fake_get(url, **kwargs):
        if url.endswith("/health"):
            return DummyResponse(200, {"ok": True})
        raise httpx.ReadTimeout("runtime status too slow")

    monkeypatch.setattr(desktop_runtime.httpx, "get", _fake_get)
    status = desktop_runtime.probe_service_status(
        base_url="http://127.0.0.1:8788",
        control_token="secret-control",
        timeout_seconds=0.25,
    )
    assert status == {"health": {"ok": True}, "runtime": None}


def test_probe_service_status_none_when_health_unavailable(monkeypatch):
    def _fake_get(url, **kwargs):
        if url.endswith("/health"):
            return DummyResponse(503, {"ok": False})
        return DummyResponse(200, {"service": {"name": "superclaw"}})

    monkeypatch.setattr(desktop_runtime.httpx, "get", _fake_get)
    assert (
        desktop_runtime.probe_service_status(
            base_url="http://127.0.0.1:8788", control_token="secret-control"
        )
        is None
    )


def test_supervisor_reuses_existing_service(monkeypatch, tmp_path):
    monkeypatch.setattr(desktop_runtime, "generate_control_token", lambda: "generated-control")
    monkeypatch.setattr(
        desktop_runtime.DesktopRuntimeSupervisor,
        "probe",
        lambda self, control_token: {"health": {"ok": True}, "runtime": {"service": {"name": "superclaw"}}},
    )

    def _unexpected_popen(*args, **kwargs):
        raise AssertionError("subprocess should not be used when service already exists")

    monkeypatch.setattr(desktop_runtime.subprocess, "Popen", _unexpected_popen)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "state.db", port=8788)

    handle = supervisor.start_or_connect()

    assert handle.owned is False
    assert handle.control_token == "generated-control"
    assert handle.base_url == "http://127.0.0.1:8788"


def test_supervisor_reuses_persisted_handle_before_allocating_new_service(monkeypatch, tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "desktop-service.json").write_text(
        json.dumps(
            {
                "base_url": "http://127.0.0.1:61234",
                "control_token": "persisted-control",
                "state_path": str(tmp_path / "runtime-state.db"),
                "owned": False,
                "pid": 2468,
            }
        ),
        encoding="utf-8",
    )
    seen = {}

    def _fake_probe_service_status(**kwargs):
        seen.update(kwargs)
        return {"health": {"ok": True}, "runtime": None}

    def _unexpected_popen(*args, **kwargs):
        raise AssertionError("subprocess should not be used when persisted handle is healthy")

    monkeypatch.setattr(desktop_runtime, "probe_service_status", _fake_probe_service_status)
    monkeypatch.setattr(desktop_runtime.subprocess, "Popen", _unexpected_popen)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db")

    handle = supervisor.start_or_connect()

    assert handle.owned is False
    assert handle.pid == 2468
    assert handle.base_url == "http://127.0.0.1:61234"
    assert handle.control_token == "persisted-control"
    assert seen["base_url"] == "http://127.0.0.1:61234"
    assert seen["control_token"] == "persisted-control"


def test_supervisor_spawns_service_until_ready(monkeypatch, tmp_path):
    probe_results = [
        None,
        {"health": {"ok": True}, "runtime": {"service": {"name": "superclaw"}}},
    ]
    process = DummyProcess(pid=9001, poll_values=[None, None])
    seen = {}

    def _fake_probe(self, control_token):
        seen.setdefault("tokens", []).append(control_token)
        return probe_results.pop(0)

    def _fake_popen(command, **kwargs):
        seen["command"] = command
        seen["env"] = kwargs["env"]
        return process

    monkeypatch.setattr(desktop_runtime.DesktopRuntimeSupervisor, "probe", _fake_probe)
    monkeypatch.setattr(desktop_runtime.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(desktop_runtime, "generate_control_token", lambda: "desktop-token")
    monkeypatch.setattr(desktop_runtime, "reserve_local_port", lambda host: 8788)
    # Identity signature is captured via `ps`; stub it so the spawn path does not
    # shell out (and so the fake Popen above only sees the service command).
    monkeypatch.setattr(desktop_runtime, "process_start_signature", lambda pid: f"sig-{pid}")
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db",
        host="127.0.0.1",
        python_executable="/tmp/python3",
    )

    handle = supervisor.start_or_connect()

    assert handle.owned is True
    assert handle.pid == 9001
    assert handle.control_token == "desktop-token"
    assert seen["command"] == [
        "/tmp/python3",
        "-m",
        "superclaw.cli",
        "service",
        "--host",
        "127.0.0.1",
        "--port",
        "8788",
        "--state-path",
        str(tmp_path / "runtime-state.db"),
        "--log-level",
        "warning",
    ]
    assert seen["env"]["SUPERCLAW_CONTROL_TOKEN"] == "desktop-token"
    persisted = json.loads((tmp_path / "run" / "desktop-service.json").read_text(encoding="utf-8"))
    assert persisted["base_url"] == "http://127.0.0.1:8788"
    assert persisted["control_token"] == "desktop-token"
    assert persisted["owned"] is False
    assert persisted["pid"] == 9001
    assert persisted["start_signature"] == "sig-9001"  # identity captured at spawn


def test_supervisor_build_service_env_uses_desktop_toolchain_path(monkeypatch, tmp_path):
    calls = []

    def fake_toolchain_env(base_env=None):
        calls.append(base_env)
        return {"PATH": "/node/bin:/usr/bin"}

    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", fake_toolchain_env)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)

    env = supervisor.build_service_env("desktop-token")

    assert env["SUPERCLAW_CONTROL_TOKEN"] == "desktop-token"
    assert env["PATH"] == "/node/bin:/usr/bin"
    assert calls == [None]


def test_supervisor_build_service_env_resets_pyinstaller_environment(monkeypatch, tmp_path):
    # The frozen onefile launcher shares its extracted _MEI dir with children. The
    # long-lived service worker outlives that launcher, which deletes the dir on
    # exit — which would take lazily loaded bundled data (e.g. certifi's cacert.pem,
    # needed for every outbound HTTPS call such as ClawHunt login) with it and break
    # the worker mid-run. We use PyInstaller's documented public switch so the
    # worker unpacks its own _MEI bound to its lifetime, rather than poking at the
    # private bootloader vars.
    monkeypatch.setattr(
        desktop_runtime,
        "desktop_toolchain_env",
        lambda base_env=None: {"PATH": "/node/bin", "SUPERCLAW_KEEP_ME": "1"},
    )
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)

    env = supervisor.build_service_env("desktop-token")

    assert env["PYINSTALLER_RESET_ENVIRONMENT"] == "1"
    # Unrelated environment is left untouched.
    assert env["SUPERCLAW_KEEP_ME"] == "1"
    assert env["SUPERCLAW_CONTROL_TOKEN"] == "desktop-token"


def test_supervisor_build_service_env_reset_survives_env_overrides(monkeypatch, tmp_path):
    # The reset flag is set after env_overrides so an operator override can never
    # accidentally clobber it and re-break the worker's bundled-data lifetime.
    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", lambda base_env=None: {"PATH": "/node/bin"})
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db",
        port=8788,
        env_overrides={"PYINSTALLER_RESET_ENVIRONMENT": "0", "SUPERCLAW_EXTRA": "x"},
    )

    env = supervisor.build_service_env("desktop-token")

    assert env["PYINSTALLER_RESET_ENVIRONMENT"] == "1"
    assert env["SUPERCLAW_EXTRA"] == "x"


def test_supervisor_build_service_env_enables_daemon_autostart_by_default(monkeypatch, tmp_path):
    # Engine-ready-on-open: the desktop shell opts the in-process drain loop in
    # so event-driven wakeups run the moment the app opens.
    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", lambda base_env=None: {"PATH": "/node/bin"})
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)

    env = supervisor.build_service_env("desktop-token")

    assert env["SUPERCLAW_DAEMON_AUTOSTART"] == "1"


def test_supervisor_build_service_env_autostart_override_wins(monkeypatch, tmp_path):
    # An explicit override (e.g. an operator who pinned autostart off) must win
    # over the shell's convenience default — setdefault never clobbers it.
    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", lambda base_env=None: {"PATH": "/node/bin"})
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db", port=8788, env_overrides={"SUPERCLAW_DAEMON_AUTOSTART": "0"}
    )

    env = supervisor.build_service_env("desktop-token")

    assert env["SUPERCLAW_DAEMON_AUTOSTART"] == "0"


def test_supervisor_build_service_env_includes_persisted_runtime_config(monkeypatch, tmp_path):
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(
        json.dumps({"SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST": "1", "SUPERCLAW_GEMINI_API_KEY": "secret"}),
        encoding="utf-8",
    )

    def fake_toolchain_env(base_env=None):
        return {"PATH": "/node/bin:/usr/bin"}

    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", fake_toolchain_env)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)

    env = supervisor.build_service_env("desktop-token")

    assert env["SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST"] == "1"
    assert "SUPERCLAW_GEMINI_API_KEY" not in env


def test_supervisor_build_service_env_preserves_existing_env_over_persisted_config(monkeypatch, tmp_path):
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(json.dumps({"SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST": "1"}), encoding="utf-8")

    def fake_toolchain_env(base_env=None):
        return {"PATH": "/node/bin:/usr/bin", "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST": "0"}

    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    monkeypatch.setattr(desktop_runtime, "desktop_toolchain_env", fake_toolchain_env)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db",
        port=8788,
        env_overrides={"SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST": "override"},
    )

    env = supervisor.build_service_env("desktop-token")

    assert env["SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST"] == "override"


def test_supervisor_timeout_terminates_process(monkeypatch, tmp_path):
    process = DummyProcess(pid=9002, poll_values=[None, None, None, None, None])
    monotonic_values = iter([0.0, 0.1, 0.2, 0.31])

    monkeypatch.setattr(desktop_runtime.DesktopRuntimeSupervisor, "probe", lambda self, control_token: None)
    monkeypatch.setattr(desktop_runtime.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(desktop_runtime.time, "monotonic", lambda: next(monotonic_values))
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db",
        port=8788,
        boot_timeout_seconds=0.3,
    )

    with pytest.raises(RuntimeError, match="did not become ready"):
        supervisor.start_or_connect(control_token="secret")

    assert process.terminated is True
    assert process.wait_calls[-1] == 2.0


def test_supervisor_cleans_up_process_if_probe_raises(monkeypatch, tmp_path):
    process = DummyProcess(pid=9004, poll_values=[None, None])
    calls = {"count": 0}

    def _boom(self, control_token):
        calls["count"] += 1
        if calls["count"] == 1:
            return None
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(desktop_runtime.DesktopRuntimeSupervisor, "probe", _boom)
    monkeypatch.setattr(desktop_runtime.subprocess, "Popen", lambda *args, **kwargs: process)
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "runtime-state.db",
        port=8788,
        boot_timeout_seconds=0.3,
    )

    with pytest.raises(RuntimeError, match="probe exploded"):
        supervisor.start_or_connect(control_token="secret")

    assert process.terminated is True
    assert process.wait_calls[-1] == 2.0


def test_shutdown_owned_service_terminates_process(tmp_path):
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)
    process = DummyProcess(pid=9003, poll_values=[None])
    handle = desktop_runtime.DesktopServiceHandle(
        base_url="http://127.0.0.1:8788",
        control_token="secret",
        state_path=tmp_path / "runtime-state.db",
        owned=True,
        pid=9003,
        process=process,
    )

    stopped = supervisor.shutdown_owned_service(handle, wait_timeout_seconds=0.5)

    assert stopped is True
    assert process.terminated is True
    assert process.wait_calls == [0.5]


def test_shutdown_owned_service_ignores_unowned_handles(tmp_path):
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "runtime-state.db", port=8788)
    handle = desktop_runtime.DesktopServiceHandle(
        base_url="http://127.0.0.1:8788",
        control_token="secret",
        state_path=tmp_path / "runtime-state.db",
        owned=False,
    )

    assert supervisor.shutdown_owned_service(handle) is False


def test_desktop_service_handle_payload_omits_process_object(tmp_path):
    handle = desktop_runtime.DesktopServiceHandle(
        base_url="http://127.0.0.1:8788",
        control_token="secret",
        state_path=tmp_path / "runtime-state.db",
        owned=True,
        pid=9005,
        start_signature="Tue Jun 23 18:50:04 2026",
        process=DummyProcess(pid=9005),
    )

    assert desktop_runtime.desktop_service_handle_payload(handle) == {
        "base_url": "http://127.0.0.1:8788",
        "control_token": "secret",
        "state_path": str(tmp_path / "runtime-state.db"),
        "owned": True,
        "pid": 9005,
        "start_signature": "Tue Jun 23 18:50:04 2026",
    }


def test_shutdown_process_pid_returns_false_for_non_positive_pid():
    assert desktop_runtime.shutdown_process_pid(0) is False


def test_shutdown_process_pid_escalates_to_sigkill(monkeypatch):
    signals: list[tuple[int, int]] = []
    monotonic_values = iter([0.0, 0.01, 0.02, 0.03, 0.04, 0.15, 0.16, 0.17])
    states = {"exists": True}
    force_signal = getattr(desktop_runtime.signal, "SIGKILL", desktop_runtime.signal.SIGTERM)
    term_seen = {"value": False}

    def _fake_kill(pid: int, sig: int):
        signals.append((pid, sig))
        if sig == 0:
            if states["exists"]:
                return None
            raise ProcessLookupError(pid)
        if sig == desktop_runtime.signal.SIGTERM and not term_seen["value"]:
            term_seen["value"] = True
            return None
        if sig == force_signal:
            states["exists"] = False

    monkeypatch.setattr(desktop_runtime.os, "kill", _fake_kill)
    monkeypatch.setattr(desktop_runtime.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(4444, wait_timeout_seconds=0.1, poll_interval_seconds=0.01)

    assert stopped is True
    assert signals[0] == (4444, desktop_runtime.signal.SIGTERM)
    assert (4444, force_signal) in signals[1:]


def test_shutdown_process_pid_returns_false_when_missing(monkeypatch):
    def _missing(pid: int, sig: int):
        raise ProcessLookupError(pid)

    monkeypatch.setattr(desktop_runtime.os, "kill", _missing)

    assert desktop_runtime.shutdown_process_pid(7777) is False


def test_shutdown_process_pid_escalates_to_process_group(monkeypatch):
    # Target IS its own group leader (pgid == pid) and lives in a different group
    # than the caller → safe to tear down the whole group.
    leader = 5000
    killpg_calls: list[tuple[int, int]] = []
    kill_calls: list[tuple[int, int]] = []
    states = {"alive": True}

    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 4242)
    monkeypatch.setattr(
        desktop_runtime.os, "getpgid", lambda pid: leader if pid == leader else 999
    )

    def _fake_killpg(pgid: int, sig: int) -> None:
        killpg_calls.append((pgid, sig))
        if sig == 0:  # group liveness probe
            if states["alive"]:
                return None
            raise ProcessLookupError(pgid)
        if sig == desktop_runtime.signal.SIGTERM:
            states["alive"] = False

    def _fake_kill(pid: int, sig: int):
        kill_calls.append((pid, sig))
        return None

    monkeypatch.setattr(desktop_runtime.os, "killpg", _fake_killpg)
    monkeypatch.setattr(desktop_runtime.os, "kill", _fake_kill)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(
        leader, wait_timeout_seconds=0.1, process_group=True
    )

    assert stopped is True
    assert killpg_calls[0] == (leader, desktop_runtime.signal.SIGTERM)
    # Group teardown signals the group, never the single leader pid directly.
    assert kill_calls == []


def test_shutdown_process_pid_single_pid_when_not_group_leader(monkeypatch):
    # pgid != pid → the target is not a group leader → never escalate.
    killpg_calls: list[tuple[int, int]] = []
    states = {"alive": True}

    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 4242)
    monkeypatch.setattr(
        desktop_runtime.os, "getpgid", lambda pid: 4242 if pid == 4242 else 7777
    )
    monkeypatch.setattr(
        desktop_runtime.os, "killpg", lambda *a: killpg_calls.append(a)
    )

    def _fake_kill(pid: int, sig: int):
        if sig == 0:
            if states["alive"]:
                return None
            raise ProcessLookupError(pid)
        if sig == desktop_runtime.signal.SIGTERM:
            states["alive"] = False

    monkeypatch.setattr(desktop_runtime.os, "kill", _fake_kill)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(
        6000, wait_timeout_seconds=0.1, process_group=True
    )

    assert stopped is True
    assert killpg_calls == []


def test_shutdown_process_pid_never_signals_own_group(monkeypatch):
    # Target is a group leader, but it is the leader of OUR OWN group → signalling
    # it would kill the caller. The guard must refuse to escalate.
    killpg_calls: list[tuple[int, int]] = []
    states = {"alive": True}

    # We are pid 8888, in group 5555; the target 5555 is that group's leader.
    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 8888)
    monkeypatch.setattr(desktop_runtime.os, "getpgid", lambda pid: 5555)
    monkeypatch.setattr(
        desktop_runtime.os, "killpg", lambda *a: killpg_calls.append(a)
    )

    def _fake_kill(pid: int, sig: int):
        if sig == 0:
            if states["alive"]:
                return None
            raise ProcessLookupError(pid)
        if sig == desktop_runtime.signal.SIGTERM:
            states["alive"] = False

    monkeypatch.setattr(desktop_runtime.os, "kill", _fake_kill)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(
        5555, wait_timeout_seconds=0.1, process_group=True
    )

    assert stopped is True
    assert killpg_calls == []


def test_shutdown_process_pid_group_eperm_degrades_to_single_pid(monkeypatch):
    # killpg denied (EPERM) → degrade to single-pid signalling rather than abort.
    kill_term: list[int] = []
    states = {"alive": True}

    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 4242)
    monkeypatch.setattr(
        desktop_runtime.os, "getpgid", lambda pid: 5000 if pid == 5000 else 999
    )

    def _fake_killpg(pgid: int, sig: int) -> None:
        raise PermissionError("EPERM")

    def _fake_kill(pid: int, sig: int):
        if sig == 0:
            if states["alive"]:
                return None
            raise ProcessLookupError(pid)
        if sig == desktop_runtime.signal.SIGTERM:
            kill_term.append(pid)
            states["alive"] = False

    monkeypatch.setattr(desktop_runtime.os, "killpg", _fake_killpg)
    monkeypatch.setattr(desktop_runtime.os, "kill", _fake_kill)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(
        5000, wait_timeout_seconds=0.1, process_group=True
    )

    assert stopped is True
    assert kill_term == [5000]


def test_shutdown_process_pid_group_waits_for_stubborn_child(monkeypatch):
    # Leader (uvicorn) dies instantly on SIGTERM, but a child keeps the group
    # alive until the SIGKILL escalation. Liveness must track the GROUP, not just
    # the leader pid — otherwise we'd return before SIGKILL and orphan the child.
    leader = 5000
    killpg_sigs: list[int] = []
    # The group stays alive until SIGKILL is delivered to it.
    group_alive = {"value": True}

    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 4242)
    monkeypatch.setattr(
        desktop_runtime.os, "getpgid", lambda pid: leader if pid == leader else 999
    )

    force = getattr(desktop_runtime.signal, "SIGKILL", desktop_runtime.signal.SIGTERM)

    def _fake_killpg(pgid: int, sig: int) -> None:
        if sig == 0:
            # Liveness probe on the group.
            if group_alive["value"]:
                return None
            raise ProcessLookupError(pgid)
        killpg_sigs.append(sig)
        if sig == force:
            group_alive["value"] = False  # the stubborn child finally dies

    # Leader pid itself appears dead right after SIGTERM (returns from os.kill 0).
    monkeypatch.setattr(
        desktop_runtime.os,
        "kill",
        lambda pid, sig: (_ for _ in ()).throw(ProcessLookupError(pid)) if sig == 0 else None,
    )
    monkeypatch.setattr(desktop_runtime.os, "killpg", _fake_killpg)
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda seconds: None)

    stopped = desktop_runtime.shutdown_process_pid(
        leader, wait_timeout_seconds=0.05, process_group=True
    )

    assert stopped is True
    # Must have escalated to SIGKILL on the group — proof we did not stop at the
    # leader's death.
    assert desktop_runtime.signal.SIGTERM in killpg_sigs
    assert force in killpg_sigs


def test_shutdown_process_pid_windows_uses_taskkill(monkeypatch):
    captured: dict[str, object] = {}

    class _Result:
        returncode = 0

    def _fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _Result()

    monkeypatch.setattr(desktop_runtime.os, "name", "nt")
    monkeypatch.setattr(desktop_runtime.subprocess, "run", _fake_run)

    stopped = desktop_runtime.shutdown_process_pid(4321, process_group=True)

    assert stopped is True
    assert captured["cmd"] == ["taskkill", "/F", "/T", "/PID", "4321"]


def test_shutdown_process_pid_windows_no_tree_still_uses_taskkill(monkeypatch):
    # Even --no-tree must not fall to the POSIX os.kill path on Windows (where
    # os.kill(pid, 0) would *kill* rather than probe): single-process taskkill.
    captured: dict[str, object] = {}

    class _Result:
        returncode = 0

    def _fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _Result()

    monkeypatch.setattr(desktop_runtime.os, "name", "nt")
    monkeypatch.setattr(desktop_runtime.subprocess, "run", _fake_run)
    # os.kill must never be reached on Windows.
    monkeypatch.setattr(
        desktop_runtime.os,
        "kill",
        lambda *a: pytest.fail("os.kill must not run on the Windows path"),
    )

    stopped = desktop_runtime.shutdown_process_pid(4321, process_group=False)

    assert stopped is True
    assert captured["cmd"] == ["taskkill", "/F", "/PID", "4321"]  # no /T


def _supervisor_with_marker(tmp_path, *, pid, signature="SIG"):
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "state.db", port=9000
    )
    handle = desktop_runtime.DesktopServiceHandle(
        base_url="http://127.0.0.1:9000",
        control_token="tok",
        state_path=tmp_path / "state.db",
        owned=True,
        pid=pid,
        start_signature=signature,
    )
    supervisor._write_persisted_handle(handle)
    return supervisor


def _force_signal_identity(monkeypatch, *, alive=True, live_signature="SIG"):
    """Make the live pid look alive with the given start-time signature."""
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: alive)
    monkeypatch.setattr(desktop_runtime, "process_start_signature", lambda pid: live_signature)


def test_stop_service_no_marker_is_noop(tmp_path):
    supervisor = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=tmp_path / "state.db", port=9000
    )
    assert supervisor.stop_service() == {
        "ok": True,
        "stopped": False,
        "reason": "no_marker",
        "pid": None,
    }


def test_stop_service_kills_group_and_removes_marker(monkeypatch, tmp_path):
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    assert supervisor.handle_path.exists()
    # Live pid carries the same start signature recorded at spawn -> it's ours.
    _force_signal_identity(monkeypatch, alive=True, live_signature="SIG")

    calls: dict[str, object] = {}

    def _fake_shutdown(pid, *, wait_timeout_seconds, process_group):
        calls["pid"] = pid
        calls["process_group"] = process_group
        calls["wait_timeout_seconds"] = wait_timeout_seconds
        return True

    monkeypatch.setattr(desktop_runtime, "shutdown_process_pid", _fake_shutdown)

    result = supervisor.stop_service(wait_timeout_seconds=1.0)

    assert result == {"ok": True, "stopped": True, "reason": None, "pid": 4321}
    assert calls == {"pid": 4321, "process_group": True, "wait_timeout_seconds": 1.0}
    assert not supervisor.handle_path.exists()


def test_stop_service_kills_hung_sidecar_via_signature(monkeypatch, tmp_path):
    # The identity check does NOT depend on HTTP: even if the sidecar's HTTP layer
    # is wedged, a matching start signature means it's our live process -> reap it.
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    _force_signal_identity(monkeypatch, alive=True, live_signature="SIG")
    # Make any HTTP probe blow up to prove it is not on the kill path.
    monkeypatch.setattr(
        desktop_runtime,
        "probe_service_status",
        lambda **k: pytest.fail("stop must not depend on HTTP probe"),
    )
    killed = {"pid": None}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda pid, **k: killed.__setitem__("pid", pid) or True,
    )

    result = supervisor.stop_service()

    assert result["stopped"] is True and result["pid"] == 4321
    assert killed["pid"] == 4321
    assert not supervisor.handle_path.exists()


def test_stop_service_honors_process_group_flag(monkeypatch, tmp_path):
    supervisor = _supervisor_with_marker(tmp_path, pid=4321)
    _force_signal_identity(monkeypatch, alive=True, live_signature="SIG")
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda pid, *, wait_timeout_seconds, process_group: seen.update(process_group=process_group) or True,
    )

    supervisor.stop_service(process_group=False)

    assert seen["process_group"] is False


def test_stop_service_pid_reused_skips_signal(monkeypatch, tmp_path):
    # The pid is alive but its start signature differs from the one recorded at
    # spawn -> the original died and the number was recycled. Never signal it.
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SPAWN_SIG")
    _force_signal_identity(monkeypatch, alive=True, live_signature="DIFFERENT_SIG")
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service()

    assert result == {"ok": True, "stopped": False, "reason": "pid_reused", "pid": 4321}
    assert called["value"] is False  # never signalled a recycled pid
    assert not supervisor.handle_path.exists()  # stale marker dropped


def test_stop_service_not_running_clears_marker(monkeypatch, tmp_path):
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: False)
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service()

    assert result == {"ok": True, "stopped": False, "reason": "not_running", "pid": 4321}
    assert called["value"] is False
    assert not supervisor.handle_path.exists()


def test_stop_service_superseded_when_expect_pid_mismatches(monkeypatch, tmp_path):
    # Session ownership: the marker now points at a DIFFERENT sidecar than the one
    # this session spawned -> refuse, and leave it (and its marker) untouched.
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )
    # _pid_exists/signature must not even be consulted past the ownership gate.
    result = supervisor.stop_service(expect_pid=9999)

    assert result == {"ok": True, "stopped": False, "reason": "superseded", "pid": 4321}
    assert called["value"] is False
    assert supervisor.handle_path.exists()  # not our sidecar -> marker preserved


def test_stop_service_expect_pid_match_kills(monkeypatch, tmp_path):
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    _force_signal_identity(monkeypatch, alive=True, live_signature="SIG")
    killed = {"pid": None}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda pid, **k: killed.__setitem__("pid", pid) or True,
    )

    result = supervisor.stop_service(expect_pid=4321)

    assert result["stopped"] is True and result["pid"] == 4321
    assert killed["pid"] == 4321


def test_stop_service_unidentified_when_no_signature_and_no_ownership(monkeypatch, tmp_path):
    # No recorded signature (legacy marker / ps unavailable at spawn) AND no
    # expect_pid: we cannot prove the pid is ours -> refuse to blind-kill, keep
    # the marker. Positive identity is REQUIRED before signalling.
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature=None)
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(
        desktop_runtime,
        "process_start_signature",
        lambda pid, **k: pytest.fail("must not be consulted when nothing was recorded"),
    )
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service()

    assert result == {"ok": True, "stopped": False, "reason": "unidentified", "pid": 4321}
    assert called["value"] is False
    assert supervisor.handle_path.exists()  # keep the anchor; never blind-kill


def test_stop_service_unidentified_even_when_session_owned(monkeypatch, tmp_path):
    # A bare pid-number match (expect_pid) is OWNERSHIP, not process-instance
    # identity: if the original sidecar died and the number was recycled, killing
    # on expect_pid alone would hit an unrelated process. So with NO recorded
    # signature we still refuse to signal, even when expect_pid matches.
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature=None)
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(
        desktop_runtime,
        "process_start_signature",
        lambda pid, **k: pytest.fail("no recorded signature -> nothing to compare against"),
    )
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service(expect_pid=4321)

    assert result == {"ok": True, "stopped": False, "reason": "unidentified", "pid": 4321}
    assert called["value"] is False  # ownership alone never authorises a kill
    assert supervisor.handle_path.exists()


def test_stop_service_identity_unconfirmed_when_live_ps_fails(monkeypatch, tmp_path):
    # A signature WAS recorded, but reading the live one fails right now (ps
    # blip). That is uncertain — NOT proven reuse: signal nothing, and KEEP the
    # marker (do not abandon a possibly-live owned tree / lose the anchor).
    supervisor = _supervisor_with_marker(tmp_path, pid=4321, signature="SIG")
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: True)
    monkeypatch.setattr(desktop_runtime, "process_start_signature", lambda pid, **k: None)
    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service()

    assert result == {"ok": True, "stopped": False, "reason": "identity_unconfirmed", "pid": 4321}
    assert called["value"] is False  # never signalled on an unreadable identity
    assert supervisor.handle_path.exists()  # marker kept for a later retry


def test_process_start_signature_retries_transient_failure(monkeypatch):
    # A transient ps failure (non-zero rc) is retried before giving up, so a
    # momentary blip at spawn does not silently produce a signature-less marker.
    class _R:
        def __init__(self, rc, out=""):
            self.returncode = rc
            self.stdout = out

    results = iter([_R(1), _R(1), _R(0, "Tue Jun 23 18:50:04 2026\n")])
    monkeypatch.setattr(desktop_runtime.os, "name", "posix")
    monkeypatch.setattr(desktop_runtime.subprocess, "run", lambda *a, **k: next(results))
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda s: None)

    assert desktop_runtime.process_start_signature(4321) == "Tue Jun 23 18:50:04 2026"


def test_stop_service_marker_without_pid_clears_marker(monkeypatch, tmp_path):
    supervisor = _supervisor_with_marker(tmp_path, pid=None)
    assert supervisor.handle_path.exists()

    called = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "shutdown_process_pid",
        lambda *a, **k: called.__setitem__("value", True),
    )

    result = supervisor.stop_service()

    assert result == {"ok": True, "stopped": False, "reason": "no_pid", "pid": None}
    assert called["value"] is False  # nothing to signal
    assert not supervisor.handle_path.exists()


def test_process_start_signature_distinguishes_reused_pid(monkeypatch):
    # Two ps invocations returning different start times => different identity.
    outputs = iter(["Tue Jun 23 18:50:04 2026", "Wed Jun 24 09:00:00 2026"])

    class _R:
        returncode = 0

        def __init__(self, out):
            self.stdout = out

    monkeypatch.setattr(desktop_runtime.os, "name", "posix")
    monkeypatch.setattr(
        desktop_runtime.subprocess, "run", lambda *a, **k: _R(next(outputs) + "   \n")
    )
    first = desktop_runtime.process_start_signature(4321)
    second = desktop_runtime.process_start_signature(4321)
    assert first == "Tue Jun 23 18:50:04 2026"
    assert second != first


def test_process_start_signature_none_on_windows(monkeypatch):
    monkeypatch.setattr(desktop_runtime.os, "name", "nt")
    monkeypatch.setattr(
        desktop_runtime.subprocess,
        "run",
        lambda *a, **k: pytest.fail("ps must not run on Windows"),
    )
    assert desktop_runtime.process_start_signature(4321) is None


def test_run_ui_watchdog_reaps_group_when_ui_exits(monkeypatch):
    # Poll while the UI pid is alive; once it disappears, tear down our own group.
    alive = {"value": True}
    monkeypatch.setattr(desktop_runtime, "_pid_exists", lambda pid: alive["value"])
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda s: alive.__setitem__("value", False))
    reaped = {"value": False}
    monkeypatch.setattr(
        desktop_runtime,
        "terminate_own_process_group",
        lambda **k: reaped.__setitem__("value", True),
    )

    desktop_runtime.run_ui_watchdog(4321, poll_seconds=0.0, grace_seconds=0.0)

    assert reaped["value"] is True


def test_run_ui_watchdog_ignores_invalid_pid(monkeypatch):
    monkeypatch.setattr(
        desktop_runtime,
        "terminate_own_process_group",
        lambda **k: pytest.fail("must not reap for a non-positive pid"),
    )
    desktop_runtime.run_ui_watchdog(0)
    desktop_runtime.run_ui_watchdog(-1)


def test_terminate_own_process_group_reaps_descendants_then_group(monkeypatch):
    force = getattr(desktop_runtime.signal, "SIGKILL", desktop_runtime.signal.SIGTERM)
    kills: list[tuple[int, int]] = []
    killpgs: list[tuple[int, int]] = []
    # Spawned backends live in their own sessions -> reached as descendants, not via
    # the group. They must be SIGTERM'd then SIGKILL'd FIRST (on others), so the
    # reaper survives to escalate; the own group is then SIGKILL'd atomically.
    monkeypatch.setattr(desktop_runtime, "_descendant_pids", lambda root: [101, 102])
    monkeypatch.setattr(desktop_runtime.os, "name", "posix")
    monkeypatch.setattr(desktop_runtime.os, "getpid", lambda: 99)
    monkeypatch.setattr(desktop_runtime.os, "getpgid", lambda who: 5000)
    monkeypatch.setattr(desktop_runtime.os, "kill", lambda pid, sig: kills.append((pid, sig)))
    monkeypatch.setattr(desktop_runtime.os, "killpg", lambda pgid, sig: killpgs.append((pgid, sig)))
    monkeypatch.setattr(desktop_runtime.time, "sleep", lambda s: None)

    desktop_runtime.terminate_own_process_group(grace_seconds=0.0)

    sigterm = desktop_runtime.signal.SIGTERM
    assert kills == [(101, sigterm), (102, sigterm), (101, force), (102, force)]
    # Own group is reaped LAST, with a single atomic SIGKILL (no SIGTERM-self race).
    assert killpgs == [(5000, force)]


def test_build_service_command_watch_ui_pid(tmp_path):
    from pathlib import Path

    sup = desktop_runtime.DesktopRuntimeSupervisor(
        state_path=Path(tmp_path / "state.db"), port=9000, watch_ui_pid=12345
    )
    cmd = sup.build_service_command()
    assert "--watch-ui-pid" in cmd and "12345" in cmd
    sup_none = desktop_runtime.DesktopRuntimeSupervisor(state_path=Path(tmp_path / "state.db"), port=9000)
    assert "--watch-ui-pid" not in sup_none.build_service_command()


def test_resolve_boot_timeout_default_is_generous_for_cold_start():
    # No explicit value, no env → the cold-start-safe default (a freshly built
    # ad-hoc-signed onefile pays a one-time Gatekeeper dylib assessment on first
    # load that the old 10s budget undershot).
    assert desktop_runtime.resolve_boot_timeout_seconds(None) == desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS
    assert desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS >= 30.0


def test_resolve_boot_timeout_env_override(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", "45")
    assert desktop_runtime.resolve_boot_timeout_seconds(None) == 45.0


def test_resolve_boot_timeout_explicit_wins_over_env(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", "45")
    # An explicit caller value (e.g. a test passing a tiny budget) is never
    # clobbered by the env default.
    assert desktop_runtime.resolve_boot_timeout_seconds(0.3) == 0.3


def test_resolve_boot_timeout_rejects_non_finite_and_caps(monkeypatch):
    # A non-finite explicit value would break the "dead backend still times out"
    # guarantee → fall back to the bounded default.
    assert desktop_runtime.resolve_boot_timeout_seconds(float("inf")) == desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS
    assert desktop_runtime.resolve_boot_timeout_seconds(float("nan")) == desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS
    # A finite explicit (incl 0.0 "probe once") is honored.
    assert desktop_runtime.resolve_boot_timeout_seconds(0.0) == 0.0
    # An absurd but finite env value is capped, not honored unbounded.
    monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", "1000000")
    assert desktop_runtime.resolve_boot_timeout_seconds(None) == desktop_runtime.MAX_BOOT_TIMEOUT_SECONDS
    # inf/1e309 via env → not finite → default.
    for bad in ("inf", "1e309", "nan"):
        monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", bad)
        assert desktop_runtime.resolve_boot_timeout_seconds(None) == desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS


def test_resolve_boot_timeout_bad_env_falls_back(monkeypatch):
    for bad in ("", "abc", "0", "-5"):
        monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", bad)
        assert desktop_runtime.resolve_boot_timeout_seconds(None) == desktop_runtime.DEFAULT_BOOT_TIMEOUT_SECONDS


def test_supervisor_uses_resolved_boot_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_DESKTOP_BOOT_TIMEOUT", "33")
    sup = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "state.db", port=9100)
    assert sup.boot_timeout_seconds == 33.0
    sup_default = desktop_runtime.DesktopRuntimeSupervisor(state_path=tmp_path / "state.db", port=9101, boot_timeout_seconds=7.0)
    assert sup_default.boot_timeout_seconds == 7.0
