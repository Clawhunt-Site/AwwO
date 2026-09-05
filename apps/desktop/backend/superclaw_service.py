"""Frozen entry point for the bundled ClawHunt backend.

PyInstaller freezes this script into a self-contained executable that ships
inside the macOS .app (Contents/Resources/backend). The desktop shell invokes
it exactly like the `superclaw` console script (e.g. `superclaw-backend service
--host 127.0.0.1 --port <p> --state-path <db>`), so it simply delegates to the
Typer CLI.
"""

from __future__ import annotations

import multiprocessing
import sys
from pathlib import Path
from typing import Any


def run() -> None:
    from superclaw.cli import main

    main()


def _option_value(argv: list[str], flag: str, default: str | None = None) -> str | None:
    try:
        index = argv.index(flag)
    except ValueError:
        return default
    if index + 1 >= len(argv):
        return default
    return argv[index + 1]


def _float_option(argv: list[str], flag: str, default: float) -> float:
    value = _option_value(argv, flag)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _float_option_optional(argv: list[str], flag: str) -> float | None:
    """Like ``_float_option`` but returns ``None`` when the flag is ABSENT (or
    unparseable), so a caller can defer to a downstream resolver instead of
    baking a hardcoded default here. Used for ``--boot-timeout`` so the desktop
    app's omitted flag flows to ``resolve_boot_timeout_seconds`` (env /
    cold-start-safe default) rather than the old hardcoded 10s that undershot a
    frozen cold start."""
    value = _option_value(argv, flag)
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _int_option(argv: list[str], flag: str) -> int | None:
    value = _option_value(argv, flag)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _json_echo(payload: dict[str, Any], exit_code: int = 0) -> None:
    import json

    print(json.dumps(payload, ensure_ascii=False), flush=True)
    if exit_code:
        raise SystemExit(exit_code)


def _run_service_fast(argv: list[str]) -> None:
    import os

    import uvicorn
    from apps.api.main import create_app
    from superclaw.runtime_config import hydrate_runtime_environment

    from superclaw.environment import default_state_path

    host = _option_value(argv, "--host", "127.0.0.1") or "127.0.0.1"
    port = _int_option(argv, "--port") or 8788
    state_path_opt = _option_value(argv, "--state-path")
    state_path = Path(state_path_opt) if state_path_opt else default_state_path()
    log_level = _option_value(argv, "--log-level", "info") or "info"
    os.environ["SUPERCLAW_SERVICE_BIND"] = host
    os.environ["SUPERCLAW_SERVICE_PORT"] = str(port)
    # MUST mirror the Typer `service` command: a sidecar spawned by the desktop App
    # carries --watch-ui-pid and self-terminates when that window exits. The shipped
    # app runs the service through THIS fast path, so the watchdog has to live here
    # too or the bundled sidecar would never self-reap.
    watch_ui_pid = _int_option(argv, "--watch-ui-pid")
    if watch_ui_pid is not None and watch_ui_pid > 0:
        import threading

        from superclaw.desktop_runtime import run_ui_watchdog

        threading.Thread(target=run_ui_watchdog, args=(watch_ui_pid,), daemon=True).start()
    hydrate_runtime_environment()
    # Co-launch the vendored Node control-plane server as a child of this service.
    # MUST mirror the Typer `service` command (superclaw.cli.service_command) — the
    # shipped app runs the service through THIS fast path, so the Node co-launch has
    # to live here too or the bundled backend would never bring Node up / tear it
    # down. Honors SUPERCLAW_NODE_SERVER; fail-open.
    from superclaw.gateway_runtime import start_gateway_sidecar_if_enabled
    from superclaw.node_runtime import install_signal_teardown, start_node_sidecar_if_enabled

    node_supervisor = start_node_sidecar_if_enabled(state_path, host=host)
    # Co-launch the automation gateway AFTER Node (so it self-discovers the upstream
    # marker). Honors SUPERCLAW_GATEWAY; fail-open. MUST mirror the Typer `service`
    # command (铁律2) — the shipped app runs the service through THIS fast path.
    gateway_supervisor = start_gateway_sidecar_if_enabled(state_path, host=host)
    # uvicorn re-raises SIGINT/SIGTERM on shutdown, bypassing the finally — a signal
    # handler is needed to reap both sidecars on a non-desktop kill. MUST mirror the
    # Typer `service` command (铁律2).
    install_signal_teardown(node_supervisor, gateway_supervisor)
    try:
        uvicorn.run(create_app(state_path=state_path), host=host, port=port, log_level=log_level)
    finally:
        if gateway_supervisor is not None:
            gateway_supervisor.stop()
        if node_supervisor is not None:
            node_supervisor.stop()


def _run_desktop_fast(argv: list[str]) -> bool:
    if not argv or argv[0] != "desktop" or len(argv) < 2:
        return False
    command = argv[1]
    rest = argv[2:]
    if command == "start":
        from superclaw.desktop_runtime import DesktopRuntimeSupervisor, desktop_service_handle_payload, probe_service_status
        from superclaw.environment import default_state_path

        state_path_opt = _option_value(rest, "--state-path")
        supervisor = DesktopRuntimeSupervisor(
            state_path=Path(state_path_opt) if state_path_opt else default_state_path(),
            host=_option_value(rest, "--host", "127.0.0.1") or "127.0.0.1",
            port=_int_option(rest, "--port"),
            connect_timeout_seconds=_float_option(rest, "--connect-timeout", 0.5),
            boot_timeout_seconds=_float_option_optional(rest, "--boot-timeout"),
            log_level=_option_value(rest, "--log-level", "warning") or "warning",
            watch_ui_pid=_int_option(rest, "--watch-ui-pid"),
        )
        try:
            handle = supervisor.start_or_connect(control_token=_option_value(rest, "--control-token"))
        except Exception as exc:
            _json_echo({"ok": False, "error": str(exc)}, exit_code=1)
        _json_echo(
            {
                "ok": True,
                "handle": desktop_service_handle_payload(handle),
                "status": probe_service_status(
                    base_url=handle.base_url,
                    control_token=handle.control_token,
                    timeout_seconds=supervisor.connect_timeout_seconds,
                ),
            }
        )
        return True
    if command == "probe":
        from superclaw.desktop_runtime import probe_service_status

        base_url = _option_value(rest, "--base-url")
        if not base_url:
            _json_echo({"ok": False, "status": None, "error": "--base-url is required"}, exit_code=1)
        payload = probe_service_status(
            base_url=base_url,
            control_token=_option_value(rest, "--control-token"),
            timeout_seconds=_float_option(rest, "--timeout", 0.5),
        )
        _json_echo({"ok": payload is not None, "status": payload})
        return True
    if command == "stop":
        from superclaw.desktop_runtime import DesktopRuntimeSupervisor, shutdown_process_pid

        # This branch MUST stay byte-for-byte equivalent in behaviour to the Typer
        # `desktop stop` command in superclaw.cli — the desktop shell hits whichever
        # entry point ships (frozen binary here, console script there), so any
        # divergence is a silent inconsistency in the installed app (铁律2).
        wait_timeout = _float_option(rest, "--wait-timeout", 2.0)
        # `--tree` (default) also tears down the sidecar's child process group;
        # `--no-tree` restores the legacy single-pid behaviour.
        tree = "--no-tree" not in rest
        pid = _int_option(rest, "--pid")
        if pid is None:
            # Marker-driven teardown (no --pid): resolve the running sidecar from
            # its on-disk handle and tear down the whole child process group. This
            # is the path the desktop shell invokes on exit. `--expect-pid` scopes
            # it to the sidecar this session spawned (session ownership). The state
            # path MUST resolve identically to the `start` branch (default_state_path,
            # the HOME data root) or the marker would be looked up in the wrong place.
            from superclaw.environment import default_state_path

            state_path_opt = _option_value(rest, "--state-path")
            host = _option_value(rest, "--host", "127.0.0.1") or "127.0.0.1"
            supervisor = DesktopRuntimeSupervisor(
                state_path=Path(state_path_opt) if state_path_opt else default_state_path(),
                host=host,
            )
            result = supervisor.stop_service(
                wait_timeout_seconds=wait_timeout,
                process_group=tree,
                expect_pid=_int_option(rest, "--expect-pid"),
            )
            # Also tear down the co-launched Node server, gated on the SAME ownership
            # decision (skipped when the Python sidecar was deliberately retained).
            # Additive "node" key. MUST mirror the Typer `desktop stop` command (铁律2).
            from superclaw.node_runtime import stop_node_sidecar_for_python_result

            result["node"] = stop_node_sidecar_for_python_result(
                supervisor.run_dir, result, host=host, wait_timeout_seconds=wait_timeout
            )
            _json_echo(result)
            return True
        if "--no-owned" in rest:
            # Parity with Typer CLI: an unowned handle is never force-killed.
            _json_echo({"ok": True, "stopped": False, "reason": "not_owned", "pid": pid})
            return True
        stopped = shutdown_process_pid(pid, wait_timeout_seconds=wait_timeout, process_group=tree)
        # `--pid` is a low-level direct kill with no reliable marker/state-path
        # context; it does NOT also reap Node (would risk the wrong run dir). Node is
        # reaped by the watchdog / marker-driven stop / clean-exit finally. MUST
        # mirror the Typer `desktop stop` command (铁律2).
        _json_echo({"ok": True, "stopped": stopped, "pid": pid})
        return True
    return False


def _run_module(module: str, argv_rest: list[str]) -> None:
    """Emulate `python -m <module>` for the frozen binary.

    ClawHunt re-spawns helper processes (notably the aggregate plugin MCP proxy)
    as `sys.executable -m superclaw.plugin_mcp_proxy ...`. In a PyInstaller binary
    sys.executable is this frozen executable, which has no native `-m` support, so
    we route the call to the module's main()/__main__ here instead.
    """
    import importlib
    import runpy

    if module == "superclaw.cli" and argv_rest[:1] == ["service"]:
        _run_service_fast(argv_rest[1:])
        return
    sys.argv = [module] + argv_rest
    mod = importlib.import_module(module)
    entry = getattr(mod, "main", None)
    if callable(entry):
        entry()
    else:
        runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    # Required so a frozen binary can safely spawn helper processes on macOS.
    multiprocessing.freeze_support()
    if len(sys.argv) >= 3 and sys.argv[1] == "-m":
        _run_module(sys.argv[2], sys.argv[3:])
    elif _run_desktop_fast(sys.argv[1:]):
        pass
    else:
        run()
