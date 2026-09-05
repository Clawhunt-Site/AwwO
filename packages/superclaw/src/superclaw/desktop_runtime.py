from __future__ import annotations

import json
import math
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from superclaw.runtime import desktop_toolchain_env
from superclaw.runtime_config import persisted_runtime_environment


def reserve_local_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(probe.getsockname()[1])


def generate_control_token() -> str:
    return secrets.token_urlsafe(24)


# How long `desktop start` waits for the spawned service to answer /health before
# giving up. A FRESHLY BUILT, ad-hoc-signed PyInstaller onefile backend pays a
# one-time macOS Gatekeeper/syspolicyd assessment of its bundled native dylibs on
# the first cold load (a new `_MEI...` extraction with not-yet-assessed cdhashes);
# this can block the early `dlopen` (e.g. `_pydantic_core`) for ~10–20s+ on a
# busy/contended host before the interpreter even starts. The old 10s budget was
# below that, so the launcher killed a backend that was merely cold-starting and
# the GUI showed a white window. 60s comfortably covers a cold first launch while
# still bounding a genuinely dead backend. Override with
# SUPERCLAW_DESKTOP_BOOT_TIMEOUT (seconds) — no rebuild needed.
DEFAULT_BOOT_TIMEOUT_SECONDS = 60.0
# Upper bound for the env-supplied (untrusted) timeout: a dead/wedged backend
# must always converge to an error in bounded time, so we never honor an
# unbounded or absurd env value — `inf`/`nan` are rejected (math.isfinite) and a
# finite value is capped here. 10 minutes is far above any real cold-start.
MAX_BOOT_TIMEOUT_SECONDS = 600.0


def resolve_boot_timeout_seconds(explicit: float | None = None) -> float:
    """Boot-readiness budget. An explicit (trusted, in-code) caller value wins,
    but only if FINITE — a non-finite explicit (inf/nan) would break the "a dead
    backend still times out" guarantee, so it falls back to the default. Else the
    SUPERCLAW_DESKTOP_BOOT_TIMEOUT env (a finite positive float, capped at
    MAX_BOOT_TIMEOUT_SECONDS); else the cold-start-safe default."""
    if explicit is not None:
        return explicit if math.isfinite(explicit) else DEFAULT_BOOT_TIMEOUT_SECONDS
    raw = os.environ.get("SUPERCLAW_DESKTOP_BOOT_TIMEOUT")
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if math.isfinite(value) and value > 0:
            return min(value, MAX_BOOT_TIMEOUT_SECONDS)
    return DEFAULT_BOOT_TIMEOUT_SECONDS


def probe_service_status(
    *,
    base_url: str,
    control_token: str | None,
    timeout_seconds: float = 0.5,
) -> dict[str, Any] | None:
    headers = {"X-SuperClaw-Token": control_token} if control_token else {}
    # Readiness is keyed off the cheap /health liveness endpoint only. The richer
    # /api/runtime/status performs live toolchain detection (codex/claude probing
    # via subprocesses) that can exceed the boot probe timeout under a minimal
    # GUI-launched environment; coupling readiness to it made the bundled backend
    # appear to "never become ready" even though it was serving. We still attach
    # runtime status when it answers quickly, but never block readiness on it.
    try:
        health = httpx.get(f"{base_url}/health", timeout=timeout_seconds)
    except httpx.HTTPError:
        return None
    if health.status_code != 200:
        return None
    runtime_payload: Any = None
    try:
        runtime = httpx.get(f"{base_url}/api/runtime/status", headers=headers, timeout=timeout_seconds)
        if runtime.status_code == 200:
            runtime_payload = runtime.json()
    except httpx.HTTPError:
        runtime_payload = None
    return {
        "health": health.json(),
        "runtime": runtime_payload,
    }


@dataclass
class DesktopServiceHandle:
    base_url: str
    control_token: str
    state_path: Path
    owned: bool
    pid: int | None = None
    # Stable per-process start-time signature (see ``process_start_signature``).
    # Recorded at spawn so a later stop can prove the marker's pid is still the
    # *same* process instance and not a recycled pid, without depending on the
    # sidecar's HTTP layer being responsive.
    start_signature: str | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False)


def desktop_service_handle_payload(handle: DesktopServiceHandle) -> dict[str, Any]:
    return {
        "base_url": handle.base_url,
        "control_token": handle.control_token,
        "state_path": str(handle.state_path),
        "owned": handle.owned,
        "pid": handle.pid,
        "start_signature": handle.start_signature,
    }


def process_start_signature(pid: int, *, attempts: int = 3, interval_seconds: float = 0.1) -> str | None:
    """Return a stable identity signature for ``pid`` — its kernel-reported start
    time — or ``None`` if it cannot be determined (pid gone, unsupported OS, or
    ``ps`` repeatedly failing).

    A (pid, start-time) pair uniquely identifies a running process instance: a
    recycled pid gets a *different* start time, so comparing this signature is how
    we tell "still our sidecar" from "an unrelated process that inherited the pid".
    Implemented via ``ps`` (present on every POSIX host); returns ``None`` on
    Windows, where teardown goes through ``taskkill`` instead.

    Callers must treat ``None`` as "identity unknown", NOT as any positive
    conclusion. We retry a transient ``ps`` failure (e.g. a fork hiccup under
    load) so a momentary blip does not get mistaken for a permanent answer — both
    when capturing at spawn and when re-reading at stop.
    """
    if os.name == "nt":
        return None
    for attempt in range(attempts):
        try:
            result = subprocess.run(
                ["ps", "-o", "lstart=", "-p", str(pid)],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            result = None
        if result is not None and result.returncode == 0:
            # rc 0 with empty output means the pid is simply gone — a definitive
            # answer, not a transient failure, so do not retry.
            return result.stdout.strip() or None
        if attempt + 1 < attempts:
            time.sleep(interval_seconds)
    return None


class DesktopRuntimeSupervisor:
    def __init__(
        self,
        *,
        state_path: Path,
        host: str = "127.0.0.1",
        port: int | None = None,
        python_executable: str | None = None,
        connect_timeout_seconds: float = 0.5,
        boot_timeout_seconds: float | None = None,
        log_level: str = "warning",
        env_overrides: dict[str, str] | None = None,
        watch_ui_pid: int | None = None,
    ) -> None:
        self.state_path = Path(state_path)
        self.host = host
        self._port_explicit = port is not None
        self.port = port or reserve_local_port(host)
        self.python_executable = python_executable or sys.executable
        self.connect_timeout_seconds = connect_timeout_seconds
        self.boot_timeout_seconds = resolve_boot_timeout_seconds(boot_timeout_seconds)
        self.log_level = log_level
        self.env_overrides = dict(env_overrides or {})
        # When the desktop GUI spawns this sidecar it passes its own pid; the
        # spawned service runs a watchdog that self-terminates when that pid
        # exits, so the sidecar never outlives its window (covers Cmd+Q swallow,
        # SIGKILL, crash, shutdown). A CLI-started sidecar passes None and is
        # never auto-reaped.
        self.watch_ui_pid = watch_ui_pid
        self.run_dir = self.state_path.parent / "run"
        self.handle_path = self.run_dir / "desktop-service.json"

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def build_service_command(self) -> list[str]:
        command = [
            self.python_executable,
            "-m",
            "superclaw.cli",
            "service",
            "--host",
            self.host,
            "--port",
            str(self.port),
            "--state-path",
            str(self.state_path),
            "--log-level",
            self.log_level,
        ]
        if self.watch_ui_pid is not None:
            command.extend(["--watch-ui-pid", str(self.watch_ui_pid)])
        return command

    def build_service_env(self, control_token: str) -> dict[str, str]:
        env = desktop_toolchain_env()
        for name, value in persisted_runtime_environment().items():
            if not env.get(name):
                env[name] = value
        env["SUPERCLAW_CONTROL_TOKEN"] = control_token
        # Engine-ready-on-open: the desktop shell opts the in-process heartbeat
        # drain loop in by default so event-driven wakeups (issue comment /
        # @mention / assignment) run the moment the app opens. This only enables
        # the safe event-driven channel; the autonomous TIMER scheduler stays
        # gated by the instance master switch (heartbeat_enabled, default off).
        # An explicit override in env_overrides still wins.
        env.setdefault("SUPERCLAW_DAEMON_AUTOSTART", "1")
        env.update(self.env_overrides)
        if "PATH" in self.env_overrides:
            env["PATH"] = desktop_toolchain_env({"PATH": self.env_overrides["PATH"]})["PATH"]
        # The frozen PyInstaller onefile launcher shares its extracted _MEI dir
        # with children via private bootloader env vars. This service worker,
        # however, outlives the short-lived `desktop start` launcher, which tears
        # that dir down when it exits — taking lazily-loaded bundled data (e.g.
        # certifi's cacert.pem, needed for every outbound HTTPS call such as
        # ClawHunt account login) with it and breaking the worker mid-run with
        # FileNotFoundError. PyInstaller's public contract for a subprocess that
        # outlives the app is PYINSTALLER_RESET_ENVIRONMENT: the bootloader unpacks
        # a fresh _MEI bound to the worker's own lifetime, then consumes the flag so
        # the worker's later children are unaffected. Set last so it is never
        # clobbered by env_overrides. No-op outside the frozen app.
        # https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
        env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        return env

    def probe(self, control_token: str | None) -> dict[str, Any] | None:
        return probe_service_status(
            base_url=self.base_url,
            control_token=control_token,
            timeout_seconds=self.connect_timeout_seconds,
        )

    def _read_persisted_handle(self) -> DesktopServiceHandle | None:
        try:
            payload = json.loads(self.handle_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        base_url = payload.get("base_url")
        control_token = payload.get("control_token")
        state_path = payload.get("state_path")
        if not (isinstance(base_url, str) and isinstance(control_token, str) and isinstance(state_path, str)):
            return None
        if not base_url.startswith(f"http://{self.host}:"):
            return None
        signature = payload.get("start_signature")
        return DesktopServiceHandle(
            base_url=base_url,
            control_token=control_token,
            state_path=Path(state_path),
            owned=False,
            pid=payload.get("pid") if isinstance(payload.get("pid"), int) else None,
            start_signature=signature if isinstance(signature, str) else None,
        )

    def _write_persisted_handle(self, handle: DesktopServiceHandle) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        payload = desktop_service_handle_payload(handle)
        payload["owned"] = False
        self.handle_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _remove_persisted_handle(self) -> None:
        # Best-effort removal of the on-disk marker. A missing file (already
        # cleaned, or never written) is success, not an error — this runs on the
        # shutdown path and must never raise.
        try:
            self.handle_path.unlink()
        except (FileNotFoundError, OSError):
            pass

    def stop_service(
        self,
        *,
        wait_timeout_seconds: float = 2.0,
        process_group: bool = True,
        expect_pid: int | None = None,
    ) -> dict[str, Any]:
        """Stop the persisted desktop sidecar resolved from the on-disk handle
        marker, tearing down its whole child process group so spawned backends
        (codex/claude/clawwork) do not linger, then remove the marker.

        Idempotent and fail-open: every failure mode is reported via the result
        payload and never raised. This is the single capability the desktop shell
        invokes on exit, and a CLI user can call it via ``superclaw desktop stop``
        with no ``--pid``.

        Identity, not just liveness — this is what makes the teardown both safe
        and complete:

        * ``expect_pid`` (session ownership): the desktop shell passes the pid it
          spawned. If the marker has since been rewritten to a *different* sidecar
          (e.g. one the user started by hand and the GUI merely attached to), the
          pids differ and we refuse — we only tear down what this session owns.

        * start-time signature (process identity): we kill only when the live pid's
          start-time matches the signature captured at spawn. A recycled pid has a
          different start-time, so we never group-kill an unrelated process that
          inherited the number; and because this check does not depend on the
          sidecar's HTTP layer, a *hung-but-alive* sidecar is still correctly
          identified and reaped (no leak), unlike an HTTP probe which would stall.
        """
        handle = self._read_persisted_handle()
        if handle is None:
            return {"ok": True, "stopped": False, "reason": "no_marker", "pid": None}
        pid = handle.pid
        if not isinstance(pid, int) or pid <= 0:
            # Marker exists but carries no usable pid (e.g. an attach-only write
            # that never captured one). Nothing to signal; clear the stale marker.
            self._remove_persisted_handle()
            return {"ok": True, "stopped": False, "reason": "no_pid", "pid": None}
        if expect_pid is not None and pid != expect_pid:
            # The running sidecar is not the one this session spawned (it was
            # replaced/superseded). Leave it — and its marker — alone.
            return {"ok": True, "stopped": False, "reason": "superseded", "pid": pid}
        if not _pid_exists(pid):
            # Genuinely gone: safe to clear the marker, nothing to signal.
            self._remove_persisted_handle()
            return {"ok": True, "stopped": False, "reason": "not_running", "pid": pid}
        # Positive-identity gate: we signal ONLY when a start-time signature proves
        # this live pid is the very process instance we spawned. ``expect_pid`` (the
        # `superseded` check above) is an *ownership* filter — which sidecar — not
        # an identity proof: a bare pid-number match cannot tell our process from an
        # unrelated one that recycled the number. So a missing or unreadable
        # signature is never a licence to kill; it is its own no-signal outcome.
        recorded = handle.start_signature
        if recorded is None:
            # No identity was ever captured (legacy marker, or `ps` unavailable /
            # repeatedly failing at spawn). We cannot prove this pid is the instance
            # we started — pid-number equality is not proof — so refuse to signal it
            # and keep the marker (next spawn overwrites it with a signed one).
            return {"ok": True, "stopped": False, "reason": "unidentified", "pid": pid}
        live = process_start_signature(pid)
        if live is None:
            # Identity momentarily unreadable (ps failed/timed out). Uncertain, NOT
            # proven reused: signal nothing and KEEP the marker so a later, calmer
            # attempt can retry rather than abandon a possibly-live owned tree.
            return {"ok": True, "stopped": False, "reason": "identity_unconfirmed", "pid": pid}
        if live != recorded:
            # Proven recycled: the pid is alive but a different process instance than
            # the one we spawned. Never signal it; drop the stale marker.
            self._remove_persisted_handle()
            return {"ok": True, "stopped": False, "reason": "pid_reused", "pid": pid}
        # Signature matched -> proven identity. Tear it down.
        stopped = shutdown_process_pid(
            pid,
            wait_timeout_seconds=wait_timeout_seconds,
            process_group=process_group,
        )
        self._remove_persisted_handle()
        return {"ok": True, "stopped": stopped, "reason": None, "pid": pid}

    def start_or_connect(self, *, control_token: str | None = None) -> DesktopServiceHandle:
        resolved_token = control_token or os.environ.get("SUPERCLAW_CONTROL_TOKEN") or generate_control_token()
        if not self._port_explicit:
            persisted_handle = self._read_persisted_handle()
            if persisted_handle is not None and (control_token is None or persisted_handle.control_token == resolved_token):
                existing = probe_service_status(
                    base_url=persisted_handle.base_url,
                    control_token=persisted_handle.control_token,
                    timeout_seconds=self.connect_timeout_seconds,
                )
                if existing is not None:
                    return persisted_handle

        existing = self.probe(resolved_token)
        if existing is not None:
            handle = DesktopServiceHandle(
                base_url=self.base_url,
                control_token=resolved_token,
                state_path=self.state_path,
                owned=False,
            )
            if not self._port_explicit:
                self._write_persisted_handle(handle)
            return handle

        self.run_dir.mkdir(parents=True, exist_ok=True)
        log_file = (self.run_dir / "uvicorn.log").open("a", encoding="utf-8")
        process = subprocess.Popen(
            self.build_service_command(),
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            text=True,
            env=self.build_service_env(resolved_token),
            start_new_session=os.name != "nt",
        )
        try:
            deadline = time.monotonic() + self.boot_timeout_seconds
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"superclaw service exited before becoming ready (exit_code={process.returncode})")
                status = self.probe(resolved_token)
                if status is not None:
                    handle = DesktopServiceHandle(
                        base_url=self.base_url,
                        control_token=resolved_token,
                        state_path=self.state_path,
                        owned=True,
                        pid=process.pid,
                        # Capture the identity signature now, while we hold the
                        # freshly-spawned pid, so a later stop can prove it is
                        # still this exact process instance (not a recycled pid).
                        start_signature=process_start_signature(process.pid),
                        process=process,
                    )
                    if not self._port_explicit:
                        self._write_persisted_handle(handle)
                    return handle
                time.sleep(0.1)
            raise RuntimeError(f"superclaw service did not become ready within {self.boot_timeout_seconds:.1f}s")
        except Exception:
            if process.poll() is None:
                self._terminate_process(process)
            raise

    def shutdown_owned_service(self, handle: DesktopServiceHandle, *, wait_timeout_seconds: float = 2.0) -> bool:
        process = handle.process
        if not handle.owned or process is None:
            return False
        if process.poll() is not None:
            return False
        self._terminate_process(process, wait_timeout_seconds=wait_timeout_seconds)
        return True

    @staticmethod
    def _terminate_process(process: subprocess.Popen[str], *, wait_timeout_seconds: float = 2.0) -> None:
        process.terminate()
        try:
            process.wait(timeout=wait_timeout_seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=wait_timeout_seconds)


def _pid_exists(pid: int) -> bool:
    # NOT os.kill(pid, 0): on Windows signal 0 raises OSError [WinError 87] (and a
    # SystemError), which is neither ProcessLookupError nor PermissionError — it
    # would crash run_ui_watchdog's thread on the very first poll, so the sidecar
    # could never detect the GUI exiting and would orphan itself. proc_compat
    # probes via OpenProcess/GetExitCodeProcess on Windows and os.kill(0) on POSIX.
    from superclaw.proc_compat import pid_is_alive

    return pid_is_alive(pid)


def _group_member_alive(pgid: int) -> bool:
    """True while any process remains in the group ``pgid``.

    Used instead of a single-pid liveness check during group teardown: the
    leader (uvicorn) may exit promptly on SIGTERM while a spawned worker is still
    winding down, and we must keep waiting (and escalate to SIGKILL) until the
    whole group is gone — not stop the moment the leader disappears.
    """
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _windows_kill(pid: int, *, tree: bool) -> bool:
    """Best-effort termination on Windows via ``taskkill``.

    Windows has no POSIX process groups, and ``os.kill(pid, 0)`` *kills* rather
    than probes, so the POSIX path's liveness checks are unsafe there. We instead
    shell out to ``taskkill /F`` (force) — adding ``/T`` to also terminate the
    whole child tree when a group teardown was requested — and never touch the
    POSIX single-pid path on Windows, for either ``--tree`` or ``--no-tree``.
    """
    cmd = ["taskkill", "/F", "/PID", str(pid)]
    if tree:
        cmd.insert(2, "/T")  # taskkill /F /T /PID <pid>
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except (OSError, ValueError):
        return False
    return result.returncode == 0


def _eligible_process_group(pid: int) -> int | None:
    """Return the process-group id to signal, or ``None`` to fall back to a
    single-pid signal.

    We only escalate to the whole group when it is *safe*: the target pid must
    be the group leader (``pgid == pid`` — exactly the shape of a sidecar we
    started with ``start_new_session=True``) and the group must NOT be our own
    (signalling our own group would kill the caller, i.e. the GUI shell driving
    shutdown). Anything ambiguous degrades to single-pid signalling.
    """
    getpgid = getattr(os, "getpgid", None)
    killpg = getattr(os, "killpg", None)
    if getpgid is None or killpg is None:  # e.g. Windows: no POSIX process groups
        return None
    try:
        pgid = getpgid(pid)
        own_pgid = getpgid(os.getpid())
    except (ProcessLookupError, PermissionError, OSError):
        return None
    if pgid == pid and pgid != own_pgid:
        return pgid
    return None


def shutdown_process_pid(
    pid: int,
    *,
    wait_timeout_seconds: float = 2.0,
    poll_interval_seconds: float = 0.05,
    process_group: bool = False,
) -> bool:
    if pid <= 0:
        return False

    # Windows has no process groups and an unsafe os.kill; always delegate to
    # taskkill there (with /T iff a tree teardown was requested), never falling
    # through to the POSIX single-pid path below.
    if os.name == "nt":
        return _windows_kill(pid, tree=process_group)

    # When asked to clean up the whole process group, resolve a safe target once
    # up front. ``None`` means "signal the single pid" (the legacy behaviour and
    # the fail-open fallback whenever group escalation is unsafe/unsupported).
    target_pgid = _eligible_process_group(pid) if process_group else None
    # Delivery and liveness MUST agree on the mechanism. If a group signal is
    # ever denied (EPERM) we permanently degrade to single-pid for BOTH, so we
    # never deliver to one target while polling liveness on the other.
    mode = {"group": target_pgid is not None}

    def _deliver(sig: int) -> None:
        if mode["group"]:
            try:
                os.killpg(target_pgid, sig)
                return
            except ProcessLookupError:
                raise
            except OSError:
                # Group delivery denied/failed (e.g. EPERM): degrade to the
                # single pid rather than giving up on the teardown entirely.
                mode["group"] = False
        os.kill(pid, sig)

    def _alive() -> bool:
        # In group mode, completion means the *whole group* is gone, not just the
        # leader pid — otherwise a stubborn child that outlives the leader would
        # make us return before escalating to SIGKILL.
        if mode["group"]:
            return _group_member_alive(target_pgid)
        return _pid_exists(pid)

    try:
        _deliver(signal.SIGTERM)
    except ProcessLookupError:
        return False
    deadline = time.monotonic() + wait_timeout_seconds
    while time.monotonic() < deadline:
        if not _alive():
            return True
        time.sleep(poll_interval_seconds)
    force_signal = getattr(signal, "SIGKILL", signal.SIGTERM)
    try:
        _deliver(force_signal)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + wait_timeout_seconds
    while time.monotonic() < deadline:
        if not _alive():
            return True
        time.sleep(poll_interval_seconds)
    return not _alive()


def _descendant_pids(root: int) -> list[int]:
    """All processes whose ancestry leads back to ``root`` (children, grandchildren,
    …), via ``ps``. A spawned backend starts a NEW session (start_new_session=True),
    so it leaves the service's process group — but it stays a *descendant* by ppid
    while the service lives, so a tree walk still reaches it. Empty on failure /
    Windows."""
    if os.name == "nt":
        return []
    try:
        result = subprocess.run(
            ["ps", "-Ao", "pid=,ppid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    children: dict[int, list[int]] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
    out: list[int] = []
    seen: set[int] = set()
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        if pid in seen or pid == root:
            continue
        seen.add(pid)
        out.append(pid)
        stack.extend(children.get(pid, []))
    return out


def terminate_own_process_group(*, grace_seconds: float = 2.0) -> None:
    """Reap this sidecar's entire subtree on UI death, then exit.

    Two scopes, because a sidecar's tree spans more than one process group:
      1) DESCENDANTS first (spawned agent/backends — they ``start_new_session`` and
         leave our group, but remain descendants by ppid): SIGTERM, grace, SIGKILL.
         Done first, and on *other* processes, so this reaper (a daemon thread) is
         never killed by its own first signal before the escalation runs (the bug
         a plain group-SIGTERM had).
      2) Our own process group last (the service launcher+worker), via a single
         atomic SIGKILL — every member, including self, dies at once, so there is no
         self-death-before-escalation race. SIGKILL is fine here: the UI is already
         gone, and SQLite WAL state is crash-safe.
    """
    if os.name == "nt":  # No POSIX sessions; the desktop watchdog path is POSIX.
        os._exit(0)
    me = os.getpid()
    descendants = _descendant_pids(me)
    for pid in descendants:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    time.sleep(grace_seconds)
    for pid in descendants:
        try:
            os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
        except OSError:
            pass
    try:
        os.killpg(os.getpgid(0), getattr(signal, "SIGKILL", signal.SIGTERM))
    except OSError:
        os._exit(0)


def run_ui_watchdog(
    pid: int,
    *,
    poll_seconds: float = 3.0,
    grace_seconds: float = 2.0,
    max_polls: int | None = None,
) -> None:
    """Block until the owning desktop GUI process ``pid`` exits, then tear down
    this sidecar's whole process group.

    Run on a daemon thread by the ``service`` command when it is started with
    ``--watch-ui-pid`` (i.e. spawned by the desktop App). This is the single,
    robust cleanup mechanism: it does not depend on any UI-side exit event, so it
    covers a swallowed Cmd+Q, a SIGKILL/force-quit, a crash, and system shutdown
    alike. CLI-started sidecars pass no watch pid and are never auto-reaped.

    ``max_polls`` bounds the loop for tests; ``None`` means run until the pid dies.
    """
    if pid <= 0:
        return
    polls = 0
    while _pid_exists(pid):
        if max_polls is not None and polls >= max_polls:
            return
        polls += 1
        time.sleep(poll_seconds)
    terminate_own_process_group(grace_seconds=grace_seconds)
