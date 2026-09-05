"""Co-launch and co-teardown of the Node chat-automation gateway (apps/gateway).

The gateway is a self-sufficient Node service that drives the chat-automation
scheduler (set a chat session as a scheduled task; at the slot it injects the
prompt into the SAME chat session via the upstream chat path). In dev it is started
by the Vite plugin; in a **packaged desktop** there is no Vite, so the long-lived
Python service co-launches it here — exactly as it already co-launches the vendored
Node control plane (see :mod:`superclaw.node_runtime`).

The split is strict: **all gateway business logic lives in Node** (scheduling, the
fire dispatcher, governance/approval, isolation to the Personal-Chat company, its
own marker/token/preclean lifecycle). This module is pure *infrastructure* — it only
spawns the process with the right environment and tears it down on a clean exit. The
gateway:

* **self-discovers the upstream** by reading ``$SUPERCLAW_HOME/run/node-service.json``
  (the marker :mod:`superclaw.node_runtime` writes), so we pass NO upstream URL —
  only ``SUPERCLAW_HOME`` so it resolves the same run dir and writes its own
  ``gateway-marker.json`` + ``gateway-control-token`` there;
* **self-precleans** an orphan from a prior crashed session (pid + start-time
  signature gate, Node-side in ``lifecycle.ts``) before binding;
* **self-tears-down** on ``SIGTERM`` (removes its marker), and — as a descendant of
  the service — is also reaped by the desktop ``--watch-ui-pid`` watchdog on UI death.

So Python's teardown only needs to signal the process group on a clean service exit
(``finally`` / signal handler); anything it misses is covered by the watchdog and the
gateway's own startup pre-clean. Fail-open throughout: a gateway that cannot be
located/launched never bricks the Python service.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from superclaw.node_runtime import (
    NodeServerSupervisor,
    _frozen_node_runtime_dir,
    resolve_node_executable,
)
from superclaw.runtime import desktop_toolchain_env

logger = logging.getLogger("superclaw.gateway_runtime")


# --- Configuration knobs (env-overridable; never hardcode host paths/ports) ---

# Whether the Python service co-launches the gateway.
#   auto (default) — start iff a runnable entry (built dist or a tsx dev binary) AND
#                    a node executable are found; else skip silently.
#   on             — always attempt; if not runnable, log a warning and fail open.
#   off            — never start.
GATEWAY_MODE_ENV = "SUPERCLAW_GATEWAY"
# Absolute path to the apps/gateway package dir. When unset we resolve the frozen
# bundle's copy, else walk up from this module to ``apps/gateway``.
GATEWAY_DIR_ENV = "SUPERCLAW_GATEWAY_DIR"
# Port the gateway binds. MUST match the front door's proxy target — but the front
# door reads the ACTUAL port from the gateway's marker, so this is just the value we
# pin via env at spawn (the gateway's own config default would otherwise mirror the
# Python front-door port and collide). 8796 avoids the Python service (8788) and the
# upstream Node (3100).
GATEWAY_PORT_ENV = "SUPERCLAW_GATEWAY_PORT"

DEFAULT_GATEWAY_PORT = 8796
GATEWAY_LOG_NAME = "gateway.log"


def gateway_mode() -> str:
    """Resolve the co-launch mode (``auto`` | ``on`` | ``off``).

    Default (no explicit ``SUPERCLAW_GATEWAY``): ``auto`` in a **packaged app**
    (``sys.frozen``), ``off`` in a **dev/source** run. This asymmetry is deliberate
    and load-bearing: in dev the Vite plugin (apps/web/vite.config.mjs) launches the
    gateway, and the Python service MUST NOT double-launch it — both bind the same
    fixed port and share ONE ``gateway-marker.json``, so a second launcher's identity-
    gated pre-clean would reap the first (the marker can't tell the two launchers
    apart). A packaged app has no Vite, so the service owns the co-launch there.
    Explicit env always wins (e.g. browser-on-Python dev without Vite: set
    ``SUPERCLAW_GATEWAY=on``).
    """
    raw = (os.environ.get(GATEWAY_MODE_ENV) or "").strip().lower()
    if raw in {"auto", "on", "off"}:
        return raw
    if raw in {"1", "true", "yes", "enabled"}:
        return "on"
    if raw in {"0", "false", "no", "disabled"}:
        return "off"
    return "auto" if getattr(sys, "frozen", False) else "off"


def resolve_gateway_port() -> int:
    raw = (os.environ.get(GATEWAY_PORT_ENV) or "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if 1 <= value <= 65535:
            return value
    return DEFAULT_GATEWAY_PORT


def resolve_gateway_dir() -> Path | None:
    """Locate the apps/gateway package dir.

    Honors ``SUPERCLAW_GATEWAY_DIR``, then — in a frozen bundle — the embedded
    ``node-runtime/gateway`` (and ONLY that; no source-tree fallback), else walks up
    from this module looking for ``apps/gateway/package.json``. ``None`` when not
    found (caller skips the gateway).
    """
    override = (os.environ.get(GATEWAY_DIR_ENV) or "").strip()
    if override:
        candidate = Path(override).expanduser()
        return candidate if (candidate / "package.json").is_file() else None
    if getattr(sys, "frozen", False):
        frozen = _frozen_node_runtime_dir()
        if frozen is None:
            return None
        candidate = frozen / "gateway"
        return candidate if (candidate / "package.json").is_file() else None
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "apps" / "gateway"
        if (candidate / "package.json").is_file():
            return candidate
    return None


@dataclass
class GatewayHandle:
    port: int
    pid: int | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False)


class GatewaySupervisor:
    """Owns the lifecycle of one co-launched Node automation gateway."""

    def __init__(
        self,
        *,
        state_path: Path,
        port: int | None = None,
        gateway_dir: Path | None = None,
        node_bin: str | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> None:
        # SUPERCLAW_HOME for the gateway = the data root that holds ``run/`` (where the
        # Node supervisor wrote node-service.json and where the gateway writes its own
        # marker + control token). state_path lives directly under that root.
        self.home = Path(state_path).resolve().parent
        self.run_dir = self.home / "run"
        self.port = port if port is not None else resolve_gateway_port()
        self.gateway_dir = gateway_dir if gateway_dir is not None else resolve_gateway_dir()
        self.node_bin = node_bin if node_bin is not None else resolve_node_executable()
        self.env_overrides = dict(env_overrides or {})
        self._process: subprocess.Popen[str] | None = None

    # --- runnability / command building -------------------------------------

    def resolve_run_command(self) -> list[str] | None:
        """Return the argv to launch the gateway (run with cwd=gateway_dir), or
        ``None`` when nothing runnable exists.

        Prefers the built ``dist/index.js`` (prod artifact). Falls back to a ``tsx``
        dev binary (``tsx src/index.ts``) for a source-only checkout. Never triggers a
        build as a side effect of starting the service.
        """
        if self.gateway_dir is None:
            return None
        dist_entry = self.gateway_dir / "dist" / "index.js"
        if dist_entry.is_file():
            if not self.node_bin:
                return None
            return [self.node_bin, str(dist_entry)]
        src_entry = self.gateway_dir / "src" / "index.ts"
        if src_entry.is_file():
            tsx = self._resolve_tsx_bin()
            if tsx is not None:
                return [tsx, str(src_entry)]
        return None

    def _resolve_tsx_bin(self) -> str | None:
        if self.gateway_dir is None:
            return None
        candidates = [
            self.gateway_dir / "node_modules" / ".bin" / "tsx",
            self.gateway_dir.parent / "node_modules" / ".bin" / "tsx",
            self.gateway_dir.parent.parent / "node_modules" / ".bin" / "tsx",
        ]
        for candidate in candidates:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        return None

    def is_runnable(self) -> bool:
        return self.resolve_run_command() is not None

    def build_env(self) -> dict[str, str]:
        # Reuse the desktop toolchain PATH augmentation so the gateway (and any CLI it
        # would resolve) inherits the same PATH the Node control plane gets.
        env = desktop_toolchain_env()
        # The gateway resolves its home/run-dir/token from SUPERCLAW_HOME; pin it to the
        # SAME data root the Node supervisor used so it reads node-service.json and writes
        # its marker/token in the run dir the front door reads.
        env["SUPERCLAW_HOME"] = str(self.home)
        # Pin the listen port to the front door's target (overriding the gateway's own
        # config default, which would otherwise collide with the Python front-door port).
        env["SUPERCLAW_GATEWAY_PORT"] = str(self.port)
        env.update(self.env_overrides)
        return env

    # --- start / stop -------------------------------------------------------

    def start(self) -> GatewayHandle | None:
        """Spawn the gateway and return IMMEDIATELY after spawn (never blocks on
        readiness — the gateway's own pre-clean + bind happen async; the front door
        retries). Fail-open: returns ``None`` (never raises) when not runnable / spawn
        fails. The gateway self-precleans any orphan of its own before binding.
        """
        command = self.resolve_run_command()
        if command is None:
            return None
        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            log_file = (self.run_dir / GATEWAY_LOG_NAME).open("a", encoding="utf-8")
        except OSError:
            logger.warning("gateway: could not prepare run dir (skipping)", exc_info=True)
            return None
        try:
            process: subprocess.Popen[str] = subprocess.Popen(
                command,
                cwd=str(self.gateway_dir),
                stdout=log_file,
                stderr=log_file,
                stdin=subprocess.DEVNULL,
                text=True,
                env=self.build_env(),
                # Own session/group leader: a clean group teardown reaches its node
                # child; still reaped by the service watchdog's ppid tree walk on UI death.
                start_new_session=os.name != "nt",
            )
        except (OSError, ValueError):
            logger.warning("gateway: failed to spawn %r (skipping)", command[0], exc_info=True)
            log_file.close()
            return None
        self._process = process
        logger.info("gateway spawned (pid=%s) on port %s", process.pid, self.port)
        return GatewayHandle(port=self.port, pid=process.pid, process=process)

    def stop(self, *, wait_timeout_seconds: float = 2.0) -> bool:
        """Tear down the co-launched gateway on a clean service exit. Signals the whole
        process group (the gateway leads its own session) and reaps the child. Reuses
        the Node supervisor's battle-tested terminate-and-reap primitive. Best-effort;
        never raises. A gateway we never held a live handle for is left to its own
        startup pre-clean / the desktop watchdog."""
        process = self._process
        self._process = None
        if process is None or process.poll() is not None:
            return True
        try:
            return NodeServerSupervisor._terminate_live_process(
                process, wait_timeout_seconds=wait_timeout_seconds
            )
        except Exception:  # noqa: BLE001 — teardown must never raise on the exit path
            logger.warning("gateway stop failed", exc_info=True)
            return False


def start_gateway_sidecar_if_enabled(
    state_path: Path, *, host: str = "127.0.0.1"
) -> GatewaySupervisor | None:
    """Co-launch the automation gateway alongside the Python service, honoring
    ``SUPERCLAW_GATEWAY``. Returns the supervisor (so the caller can tear it down on
    service exit) when started, else ``None``.

    Called AFTER :func:`superclaw.node_runtime.start_node_sidecar_if_enabled` so the
    upstream's ``node-service.json`` marker exists by the time the gateway self-
    discovers it. ``host`` is accepted for call-site symmetry with the Node co-launch;
    the gateway always binds loopback. Fail-open: any failure logs and returns ``None``.
    """
    mode = gateway_mode()
    if mode == "off":
        return None
    try:
        supervisor = GatewaySupervisor(state_path=Path(state_path))
        if not supervisor.is_runnable():
            if mode == "on":
                logger.warning(
                    "SUPERCLAW_GATEWAY=on but the gateway is not runnable (no built "
                    "dist/index.js or tsx dev binary, or node not found); build it with "
                    "`npm run build --prefix apps/gateway`. Continuing without automations."
                )
            else:
                logger.debug("gateway not runnable; skipping co-launch (mode=auto)")
            return None
        handle = supervisor.start()
        if handle is None:
            return None
        return supervisor
    except Exception:  # noqa: BLE001 — never let gateway orchestration brick the service
        logger.warning("gateway co-launch failed (continuing without automations)", exc_info=True)
        return None
