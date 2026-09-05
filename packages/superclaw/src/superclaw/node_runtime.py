"""Co-launch and co-teardown of the vendored Node control-plane server.

The SuperClaw backend is being re-platformed onto the vendored Node server under
``server/``. During the transition both backends run side by side: the Python
FastAPI service (the legacy/source-of-truth kernel surface) and the Node control
plane (chat / workspaces / agents / skills). The web dev proxy
(``apps/web/vite.config.mjs``) already routes the Node-owned routes to the Node
target, but nothing in the launch pipeline brought the Node server up — so this
module makes the **Python service process** the single owner of the Node server's
lifecycle:

* **Co-launch** — when the long-lived ``service`` process starts (whether spawned
  by the desktop App via ``desktop start`` or run directly for web dev), it also
  starts the Node server as a child process. One entry point, both servers up.

* **Co-teardown (exit cleanup)** — the Node server is a *descendant* of the
  service process, so the existing desktop watchdog
  (``terminate_own_process_group``) already reaps it on UI death via its ppid tree
  walk. The clean-exit path (uvicorn returns / web-dev Ctrl+C) tears it down
  explicitly via :meth:`NodeServerSupervisor.stop`, and the marker-driven
  ``desktop stop`` (CLI / migration) tears it down via :func:`stop_node_sidecar`.

* **Startup pre-clean** — before binding, :meth:`NodeServerSupervisor.start`
  identity-gated-reaps any Node orphan from a prior crashed session (recorded in
  the on-disk marker). This matters because the Node server auto-shifts to the
  next free port (``detect-port``) when its configured port is taken, which would
  silently break the web proxy that targets a fixed port — so a leftover Node must
  be cleared first, not worked around.

Design constraints honored here:

* The Python supervisor (``desktop_runtime.py``) and its 6-round-reviewed
  ``stop_service`` identity gate are **left untouched**; all Node logic lives here
  and is wired in additively at the call sites.
* Fail-open: a Node that cannot be located, built, or made ready never bricks the
  Python service — the service still comes up; the failure is logged.
* Identity gates mirror the Python sidecar's: we signal a pid only when a
  start-time signature proves it is the very instance we spawned, so a recycled
  pid is never group-killed.

``PAPERCLIP_*`` env names below are the vendored upstream server's own configuration
identifiers; setting them is required to drive that server (the "去 Paperclip 命名"
rule's exception for referencing upstream identifiers).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from superclaw.desktop_runtime import (
    _pid_exists,
    process_start_signature,
    shutdown_process_pid,
)
from superclaw.runtime import desktop_toolchain_env, desktop_toolchain_path

logger = logging.getLogger("superclaw.node_runtime")


# --- Configuration knobs (env-overridable; never hardcode host paths/ports) ---

# Whether the Python service co-launches the Node server.
#   auto (default) — start iff the server is locatable AND runnable (built dist or
#                    a tsx dev binary) AND a node executable is found; else skip
#                    silently. This is the "just works once built, invisible until
#                    then" default.
#   on             — always attempt; if not runnable, log a warning and fail open.
#   off            — never start (restores the legacy Python-only behaviour).
NODE_SERVER_MODE_ENV = "SUPERCLAW_NODE_SERVER"
# Absolute path to the vendored ``server/server`` package directory. When unset we
# search upward from this file. Set by a packaged app pointing at its bundled copy.
NODE_SERVER_DIR_ENV = "SUPERCLAW_NODE_SERVER_DIR"
# Node executable. When unset we use ``shutil.which("node")``. A packaged app sets
# this to its bundled node binary.
NODE_BIN_ENV = "SUPERCLAW_NODE_BIN"
# Port the Node server binds. Default mirrors apps/web/vite.config.mjs's nodeTarget
# (http://127.0.0.1:3100), so the dev proxy reaches it without extra config.
NODE_PORT_ENV = "SUPERCLAW_NODE_PORT"
# Data home for the Node server (its embedded pg datadir etc.). Kept isolated from
# any other Node instance to avoid datadir/port collisions; defaults under the
# SuperClaw data root, NOT cwd-relative.
NODE_HOME_ENV = "SUPERCLAW_NODE_HOME"
# Stable instance id for the Node server.
NODE_INSTANCE_ID_ENV = "SUPERCLAW_NODE_INSTANCE_ID"
# Readiness budget (seconds) for the Node server's /api/health after spawn.
NODE_BOOT_TIMEOUT_ENV = "SUPERCLAW_NODE_BOOT_TIMEOUT"

DEFAULT_NODE_PORT = 3100
DEFAULT_NODE_INSTANCE_ID = "superclaw"
DEFAULT_NODE_BOOT_TIMEOUT_SECONDS = 60.0
MAX_NODE_BOOT_TIMEOUT_SECONDS = 600.0

# Marker recording the co-launched Node server, alongside the Python sidecar's
# ``desktop-service.json`` in the same run dir so the marker-driven stop path finds
# both.
NODE_MARKER_NAME = "node-service.json"
NODE_LOG_NAME = "node-server.log"


def node_server_mode() -> str:
    """Resolve the co-launch mode (``auto`` | ``on`` | ``off``); default ``auto``."""
    raw = (os.environ.get(NODE_SERVER_MODE_ENV) or "").strip().lower()
    if raw in {"auto", "on", "off"}:
        return raw
    # Tolerate common truthy/falsey spellings rather than silently defaulting.
    if raw in {"1", "true", "yes", "enabled"}:
        return "on"
    if raw in {"0", "false", "no", "disabled"}:
        return "off"
    return "auto"


def _frozen_node_runtime_dir() -> Path | None:
    """Locate the Node runtime shipped inside a frozen desktop bundle.

    A packaged app has no source tree to walk up and no ``node`` on the user's
    PATH. The build ships a self-contained Node runtime next to the frozen backend
    executable: ``<sys.executable dir>/node-runtime/`` holds the ``node`` binary and
    ``server/`` (the built ``server/server`` tree — ``dist/index.js`` + pruned prod
    ``node_modules``).

    Gated on ``sys.frozen`` (the bundle's tamper-proof marker, mirroring
    :func:`superclaw.backends._frozen_clawwork_dir`) so a source checkout never
    resolves here. Returns the dir ONLY when BOTH the runnable ``node`` binary AND
    the built ``server/dist/index.js`` are present — a partial/half-shipped bundle
    resolves to ``None`` so the front door reports Node unavailable rather than
    half-launching (fail-closed; in frozen we never fall back to an ambient
    ``node`` or a source tree)."""
    if not getattr(sys, "frozen", False):
        return None
    try:
        base = Path(sys.executable).resolve().parent
    except (OSError, ValueError):
        return None
    home = base / "node-runtime"
    # Windows ships node.exe; POSIX ships an extensionless `node`.
    node_bin = home / ("node.exe" if os.name == "nt" else "node")
    server_entry = home / "server" / "dist" / "index.js"
    if node_bin.is_file() and os.access(node_bin, os.X_OK) and server_entry.is_file():
        return home
    return None


def resolve_node_server_dir() -> Path | None:
    """Locate the vendored ``server/server`` package dir.

    Honors ``SUPERCLAW_NODE_SERVER_DIR`` (e.g. a packaged app's bundled copy), then
    — in a frozen bundle — the embedded ``node-runtime/server`` (and ONLY that; no
    source-tree fallback), else walks up from this module looking for
    ``server/server/package.json``. Returns ``None`` when it cannot be found
    (caller skips Node).
    """
    override = (os.environ.get(NODE_SERVER_DIR_ENV) or "").strip()
    if override:
        candidate = Path(override).expanduser()
        return candidate if (candidate / "package.json").is_file() else None
    if getattr(sys, "frozen", False):
        frozen = _frozen_node_runtime_dir()
        if frozen is None:
            return None
        candidate = frozen / "server"
        return candidate if (candidate / "package.json").is_file() else None
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "server" / "server"
        if (candidate / "package.json").is_file():
            return candidate
    return None


def resolve_node_executable() -> str | None:
    """Resolve the ``node`` executable: ``SUPERCLAW_NODE_BIN`` override (validated),
    then — in a frozen bundle — the embedded ``node-runtime/node`` (and ONLY that;
    never an ambient PATH ``node``), else ``shutil.which("node")``; ``None`` when
    unavailable."""
    override = (os.environ.get(NODE_BIN_ENV) or "").strip()
    if override:
        path = Path(override).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        return None
    if getattr(sys, "frozen", False):
        frozen = _frozen_node_runtime_dir()
        if frozen is None:
            return None
        return str(frozen / ("node.exe" if os.name == "nt" else "node"))
    return shutil.which("node")


def resolve_node_port() -> int:
    raw = (os.environ.get(NODE_PORT_ENV) or "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if 1 <= value <= 65535:
            return value
    return DEFAULT_NODE_PORT


def _find_free_port(host: str) -> int | None:
    """Ask the OS for a free ephemeral port on ``host`` (bind to port 0).

    Used by the frozen desktop bundle when the configured Node port is occupied:
    the front door discovers the server's ACTUAL port via the run-dir marker
    (:func:`read_node_base_url`), so the co-launched Node has no fixed-port
    requirement there — unlike the dev vite proxy, which hardcodes 3100. Best-effort:
    the port is released on return, so a racing bind between here and Node's own
    bind is possible (the same window the fixed-port precheck already tolerates);
    a lost race surfaces via Node's readiness probe (front door reports 503).
    Returns ``None`` when even an ephemeral bind fails.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.bind((host, 0))
            return int(probe.getsockname()[1])
    except OSError:
        return None


def resolve_node_boot_timeout(explicit: float | None = None) -> float:
    """Boot-readiness budget for the Node server. Mirrors the Python sidecar's
    resolver: a finite explicit value wins, else the env (finite, positive, capped),
    else the default."""
    if explicit is not None:
        import math

        return explicit if math.isfinite(explicit) else DEFAULT_NODE_BOOT_TIMEOUT_SECONDS
    raw = os.environ.get(NODE_BOOT_TIMEOUT_ENV)
    if raw:
        import math

        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if math.isfinite(value) and value > 0:
            return min(value, MAX_NODE_BOOT_TIMEOUT_SECONDS)
    return DEFAULT_NODE_BOOT_TIMEOUT_SECONDS


@dataclass
class NodeServiceHandle:
    base_url: str
    port: int
    pid: int | None = None
    start_signature: str | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False)


def node_service_handle_payload(handle: NodeServiceHandle) -> dict[str, Any]:
    return {
        "base_url": handle.base_url,
        "port": handle.port,
        "pid": handle.pid,
        "start_signature": handle.start_signature,
    }


class NodeServerSupervisor:
    """Owns the lifecycle of one co-launched Node control-plane server."""

    def __init__(
        self,
        *,
        run_dir: Path,
        host: str = "127.0.0.1",
        port: int | None = None,
        server_dir: Path | None = None,
        node_bin: str | None = None,
        node_home: Path | None = None,
        instance_id: str | None = None,
        boot_timeout_seconds: float | None = None,
        connect_timeout_seconds: float = 0.5,
        env_overrides: dict[str, str] | None = None,
        allow_dynamic_port: bool = False,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.host = host
        self.port = port if port is not None else resolve_node_port()
        self.server_dir = server_dir if server_dir is not None else resolve_node_server_dir()
        self.node_bin = node_bin if node_bin is not None else resolve_node_executable()
        if node_home is not None:
            self.node_home = Path(node_home)
        else:
            env_home = (os.environ.get(NODE_HOME_ENV) or "").strip()
            self.node_home = Path(env_home).expanduser() if env_home else (self.run_dir.parent / "node-runtime")
        self.instance_id = instance_id or os.environ.get(NODE_INSTANCE_ID_ENV) or DEFAULT_NODE_INSTANCE_ID
        self.boot_timeout_seconds = resolve_node_boot_timeout(boot_timeout_seconds)
        self.connect_timeout_seconds = connect_timeout_seconds
        self.env_overrides = dict(env_overrides or {})
        # When True (frozen desktop bundle), a busy configured port falls back to a
        # free ephemeral one instead of aborting co-launch — the front door finds the
        # actual port via the run-dir marker. A dev checkout leaves this False so the
        # port stays fixed at 3100 (the vite proxy hardcodes it).
        self.allow_dynamic_port = allow_dynamic_port
        self.marker_path = self.run_dir / NODE_MARKER_NAME
        self._process: subprocess.Popen[str] | None = None
        # Set by stop(); read by the background readiness logger so it stays quiet
        # when the server was deliberately torn down (vs. crashed).
        self._stopping = False
        # Flipped True once the background readiness logger confirms Node answered its
        # health route. Read (non-blocking) by node_runtime_status_snapshot() so the web
        # startup gate can wait for Node via the kernel's /api/runtime/status contract
        # without each poll paying a live health probe. A plain bool: single writer
        # (the daemon logger), atomic reads under the GIL.
        self._ready = False
        # One-shot guard so the two back-to-back pre-clean calls on the boot path
        # (start_node_sidecar_if_enabled → start) don't each spawn the PowerShell
        # orphan sweep. stop()'s sweep is NOT gated by this (a different lifecycle
        # moment that must always reap).
        self._preclean_swept = False

    @property
    def base_url(self) -> str:
        # Bracket a raw IPv6 literal so the URL is valid (http://[::1]:3100).
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"http://{host}:{self.port}"

    @property
    def health_url(self) -> str:
        # The Node ``api`` router mounts /health under the /api prefix (app.ts).
        return f"{self.base_url}/api/health"

    @property
    def instance_home(self) -> Path:
        """The vendored node server's per-instance home
        (``<node_home>/instances/<instance_id>``). The embedded PostgreSQL datadir
        lives under it (``.../db``), which holds the ``postmaster.pid`` lockfile the
        Windows orphan reaper reads to find a leftover postmaster."""
        return self.node_home / "instances" / self.instance_id

    def is_ready(self) -> bool:
        """Readiness for /api/runtime/status: Node confirmed healthy once AND our process
        is still alive.

        Non-blocking — combines the cached first-ready edge (set by the background logger,
        avoids a live HTTP probe per status poll) with a ``poll()`` liveness check so a
        Node that became ready then crashed BEFORE the startup gate released is not still
        reported ready (which on desktop — where the lists are Python-served — would let
        the splash lift onto a dead Node). A nil process handle cannot be confirmed live,
        so it reads not-ready (fail-closed)."""
        if not self._ready:
            return False
        proc = self._process
        return proc is not None and proc.poll() is None

    # --- runnability / command building -------------------------------------

    def resolve_run_command(self) -> list[str] | None:
        """Return the argv to launch the Node server (run with cwd=server_dir), or
        ``None`` when nothing runnable exists.

        Prefers the built ``dist/index.js`` (``node dist/index.js`` — the prod
        artifact). Falls back to a ``tsx`` dev binary (``tsx src/index.ts``) when
        present (source-only checkout). A bare source tree with neither a build nor
        tsx is not runnable here — we never trigger a heavy ``pnpm install``/build
        as a side effect of starting the service.
        """
        if self.server_dir is None:
            return None
        dist_entry = self.server_dir / "dist" / "index.js"
        if dist_entry.is_file():
            if not self.node_bin:
                return None
            return [self.node_bin, str(dist_entry)]
        src_entry = self.server_dir / "src" / "index.ts"
        if src_entry.is_file():
            tsx = self._resolve_tsx_bin()
            if tsx is not None:
                return [tsx, str(src_entry)]
        return None

    def _resolve_tsx_bin(self) -> str | None:
        if self.server_dir is None:
            return None
        # pnpm places a per-package .bin; also check the workspace root one dir up.
        candidates = [
            self.server_dir / "node_modules" / ".bin" / "tsx",
            self.server_dir.parent / "node_modules" / ".bin" / "tsx",
        ]
        for candidate in candidates:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        return None

    def is_runnable(self) -> bool:
        return self.resolve_run_command() is not None

    def build_env(self) -> dict[str, str]:
        # Start from a PATH augmented for macOS GUI-launched desktop subprocesses.
        # The Python service is spawned by the Tauri shell from Finder/Dock, whose
        # PATH omits Homebrew / npm-global dirs — so a bare ``claude`` / ``codex``
        # spawned by the Node server's ``*_local`` adapters would not resolve. We
        # reuse the kernel's existing desktop_toolchain helper (the same one the
        # legacy Python backends use to locate codex) so the Node server and every
        # CLI it spawns inherit a PATH that finds the user's locally-installed
        # tools — the BYO path that lets us ship without vendoring those CLIs.
        env = desktop_toolchain_env()
        env["HOST"] = self.host
        env["PORT"] = str(self.port)
        # Upstream server config identifiers (see module docstring).
        env["PAPERCLIP_HOME"] = str(self.node_home)
        env["PAPERCLIP_INSTANCE_ID"] = self.instance_id
        env["PAPERCLIP_MIGRATION_AUTO_APPLY"] = "true"
        env["PAPERCLIP_MIGRATION_PROMPT"] = "never"
        env.update(self.env_overrides)
        # PGlite promotion — the desktop DEFAULT for fresh installs. When the operator
        # has not chosen (env unset/blank) and this instance has NO legacy embedded-
        # PostgreSQL cluster yet, run the node server on in-process PGlite: no child
        # postmaster, so the orphaned-cluster 503 class cannot occur, and boot drops
        # from ~40-150s to seconds. An EXISTING cluster keeps embedded PG so no user
        # data disappears (the reaper still guards it); an explicit "0"/"1" from the
        # operator always wins. Fail-open: an unreadable path just keeps embedded.
        if not (env.get("SUPERCLAW_DESKTOP_PGLITE") or "").strip():
            try:
                legacy_cluster = self.instance_home / "db" / "PG_VERSION"
                if not legacy_cluster.is_file():
                    env["SUPERCLAW_DESKTOP_PGLITE"] = "1"
            except OSError:
                pass
        # Hand the ClawHunt LLM-gate relay credentials to the Node control plane so its
        # claude_local adapter can route the Claude CLI at the platform gate (which exposes
        # an Anthropic-compatible /v1/messages endpoint) when the user has NOT supplied their
        # own ANTHROPIC_* auth. We only forward an ALREADY-resolved key (manual env override
        # or a key provisioned by a prior login) — provisioning a fresh key is a heavyweight,
        # network- and filesystem-touching operation (it acquires the provision lock + hardens
        # the secrets dir, which on Windows spawns a subprocess) and MUST NOT run on the Node
        # spawn hot path; it belongs to the explicit login/ensure flow. Best-effort + fail-open:
        # if no key resolves (e.g. not logged in), claude_local falls back to its own auth (BYO
        # ANTHROPIC_API_KEY or a Claude subscription) instead of breaking the Node boot.
        # setdefault so an explicit SUPERCLAW_RELAY_* already in the environment always wins.
        if not env.get("SUPERCLAW_RELAY_API_KEY"):
            try:
                from superclaw import relay_key as _relay_key

                key, _src = _relay_key.resolve_relay_api_key()
                if key:
                    env["SUPERCLAW_RELAY_API_KEY"] = key
                    env.setdefault("SUPERCLAW_RELAY_BASE_URL", _relay_key.resolve_relay_base_url())
            except Exception:  # noqa: BLE001 — never let relay wiring block the Node sidecar
                logger.debug("node server: relay credential injection skipped", exc_info=True)
        # A key provided EXPLICITLY by the environment (e.g. a Cloud Run secret binding) skips the
        # resolve branch above — but the claude_local adapter's relay route requires BOTH the key
        # AND the base URL to be non-empty (adapters/claude-local execute.ts), so a key without a
        # base silently deactivates the relay and the Claude CLI runs credential-less (it then
        # hangs/fails against api.anthropic.com — the exact Cloud Run chat outage this fixes).
        # Backfill the per-environment base for an explicit key; an explicit base still wins.
        if env.get("SUPERCLAW_RELAY_API_KEY") and not env.get("SUPERCLAW_RELAY_BASE_URL"):
            try:
                from superclaw import relay_key as _relay_key

                env["SUPERCLAW_RELAY_BASE_URL"] = _relay_key.resolve_relay_base_url()
            except Exception:  # noqa: BLE001 — never let relay wiring block the Node sidecar
                logger.debug("node server: relay base backfill skipped", exc_info=True)
        # An explicit PATH override (e.g. tests / a custom launcher) must take
        # precedence: its entries stay FIRST so a deliberately-pinned binary wins
        # over a same-named one in a standard dir. The toolchain dirs are appended
        # only as a fallback (deduped, order-preserving) so child CLIs still resolve
        # if the override is itself incomplete.
        if "PATH" in self.env_overrides:
            override_entries = self.env_overrides["PATH"].split(os.pathsep)
            toolchain_entries = desktop_toolchain_path().split(os.pathsep)
            merged = [entry for entry in (*override_entries, *toolchain_entries) if entry]
            env["PATH"] = os.pathsep.join(dict.fromkeys(merged))
        self._inject_clawwork_paths(env)
        self._inject_workshop_receipt_config(env)
        return env

    @staticmethod
    def _inject_workshop_receipt_config(env: dict[str, str]) -> None:
        """Provision the 0600 workshop-receipt key file and hand its PATH (never its VALUE) +
        app_env to the co-launched Node import, so Node can verify the receipts the Python
        download bridge signs (H-architecture: Python verifies cosign + fetches bytes, Node
        lands).

        The HMAC key is a HIGH-VALUE local secret (whoever reads it can forge an
        ``official:true`` receipt). We pass only the FILE PATH — Node reads the key from the
        0600 file (``workshop_receipt_key.py`` writes it, ``workshop-receipt.ts`` reads it). The
        secret therefore never enters Node's ``process.env``, so no child process Node later
        spawns (agent / plugin / runtime / git / ssh / tar / npm — local or remote) can inherit
        it via the environment. The path itself is not sensitive. ``SUPERCLAW_APP_ENV`` is the
        receipt's required env binding (it does NOT affect the Node deployment mode, which is
        set by the node-home config / PAPERCLIP env).

        Fail-soft: if the key file cannot be provisioned safely, leave the path unset — Node's
        workshop-import stays fail-closed (503 "not configured") rather than blocking the whole
        server boot for a workshop-only feature.
        """
        from superclaw.environment import app_environment
        from superclaw.workshop_receipt_key import (
            WORKSHOP_RECEIPT_HMAC_KEY_ENV,
            WORKSHOP_RECEIPT_KEY_FILE_ENV,
            WorkshopReceiptKeyError,
            ensure_workshop_receipt_key,
            workshop_receipt_key_path,
        )

        # Defence in depth: the Node child env is a COPY of os.environ (via desktop_toolchain_env).
        # If the parent Python env ever carries the key VALUE, strip it here so it can NEVER reach
        # Node's process.env (where a Node-spawned child could inherit it) — Node reads the key
        # from the file, not the env, so this var has no legitimate place in the child env.
        env.pop(WORKSHOP_RECEIPT_HMAC_KEY_ENV, None)
        env["SUPERCLAW_APP_ENV"] = app_environment()
        try:
            ensure_workshop_receipt_key()  # provision the 0600 file; the VALUE stays on disk
            env[WORKSHOP_RECEIPT_KEY_FILE_ENV] = str(workshop_receipt_key_path())
        except (WorkshopReceiptKeyError, OSError) as exc:
            env.pop(WORKSHOP_RECEIPT_KEY_FILE_ENV, None)  # never leave a stale/partial path
            logger.warning("workshop receipt key unavailable; workshop install disabled: %s", exc)

    @staticmethod
    def _inject_clawwork_paths(env: dict[str, str]) -> None:
        """Hand the kernel-resolved ClawWork governance ext + executable to the Node
        ``clawwork-local`` adapter via env.

        The adapter resolves these by walking up to ``third_party/clawwork`` from its
        own module, which breaks in a frozen/relocated desktop bundle (ClawWork ships
        at ``<backend>/clawwork/``, not as an ancestor of the Node server tree). Let
        the kernel be the single source of truth (see
        :func:`superclaw.backends.resolve_clawwork_runtime_paths`) so a packaged app
        drives ClawWork governed instead of failing closed (``CLAWWORK_UNGOVERNED``).

        Contract: never override an explicit operator value already present in the
        env (the adapter's own env-override precedence is preserved), and never block
        Node startup on a resolution failure — the adapter still fails closed on its
        own if the paths stay unresolved, so a best-effort handoff cannot weaken
        governance. The broad guard below is deliberate (path discovery touches the
        filesystem and an unbuilt/odd checkout can raise OSError/ValueError/etc.);
        it is logged, never silently swallowed, and degrades to the adapter's own
        walk-up rather than failing closed at the wrong layer.
        """
        try:
            from superclaw.backends import resolve_clawwork_runtime_paths

            gov_ext, executable = resolve_clawwork_runtime_paths()
        except Exception:  # noqa: BLE001 - best-effort handoff; adapter self-resolves + fails closed
            logger.warning(
                "ClawWork path handoff to Node failed; adapter will self-resolve",
                exc_info=True,
            )
            return
        if gov_ext and not env.get("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT"):
            env["SUPERCLAW_CLAWWORK_GOVERNANCE_EXT"] = gov_ext
        if executable and not env.get("SUPERCLAW_CLAWWORK_EXECUTABLE"):
            env["SUPERCLAW_CLAWWORK_EXECUTABLE"] = executable

    # --- on-disk marker -----------------------------------------------------

    def _read_marker(self) -> dict[str, Any] | None:
        try:
            payload = json.loads(self.marker_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _write_marker(self, handle: NodeServiceHandle) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_text(
            json.dumps(node_service_handle_payload(handle), ensure_ascii=False),
            encoding="utf-8",
        )

    def _remove_marker(self) -> None:
        try:
            self.marker_path.unlink()
        except (FileNotFoundError, OSError):
            pass

    # --- readiness ----------------------------------------------------------

    def probe_health(self) -> bool:
        """True when OUR Node server answers its health route with 200.

        Strictly 200 (not merely "< 500"): a foreign process squatting the port
        could answer 404/403, and we must not mistake it for our server — combined
        with ``_port_is_available`` (we only start when the port is ours), this keeps
        readiness/diagnostics honest. Any error (connection refused, malformed URL,
        timeout) means "not our healthy server"."""
        try:
            response = httpx.get(self.health_url, timeout=self.connect_timeout_seconds)
        except Exception:  # noqa: BLE001 — a health probe must never raise; any failure == not-ready
            return False
        return response.status_code == 200

    def _port_is_available(self) -> bool:
        """True when nothing is listening on the configured (host, port).

        The vendored Node server auto-shifts to the next free port via
        ``detect-port`` when its configured port is taken — which would silently
        break the web proxy and marker that both assume the fixed port. So we only
        spawn Node when the port is genuinely free (after pre-clean has removed any
        of OUR own leftovers); a foreign squatter means we refuse to start rather
        than let Node drift to an unknown port. Best-effort: this is a precheck, not
        an atomic reservation — a foreign process binding between here and Node's own
        bind can still cause a shift; a bind error other than "in use" is treated as
        available and left to Node to surface."""
        family = socket.AF_INET6 if ":" in self.host else socket.AF_INET
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.bind((self.host, self.port))
            return True
        except OSError as exc:
            import errno

            if exc.errno in {errno.EADDRINUSE, errno.EACCES}:
                return False
            return True

    # --- Windows orphan sweep (detached embedded-PG reaper) ------------------

    def _windows_sweep_instance_orphans(self, *, context: str) -> int:
        """Windows-only: reap THIS instance's orphaned embedded-PostgreSQL postmaster
        (and orphaned node) left by a prior session — using pure-Python signals only,
        NO subprocess.

        Why this exists (the recurring desktop 503 root cause): the vendored node
        server starts its embedded PostgreSQL via ``pg_ctl``, which launches the
        ``postgres.exe`` postmaster as its OWN detached process — NOT a child of node.
        On desktop exit the watchdog's ``taskkill /F /T`` reaps the Python -> node
        tree, but the detached postmaster is outside that tree and survives, holding
        the fixed PG port + datadir. The next launch then removes the "stale" lock and
        starts a SECOND postgres on the SAME datadir; the two collide and every query
        fails with ECONNREFUSED / ECONNRESET, so the whole board 503s
        (``node_unavailable``). The marker pre-clean cannot fix it (it only knows the
        node pid — and on Windows even that is unusable because the start signature is
        often null).

        Why pure ctypes / no subprocess: the backend runs FROZEN (PyInstaller), and a
        frozen service cannot reliably spawn ``powershell`` / ``taskkill`` — the
        enumeration silently fails-open and nothing is reaped (observed against the
        v0.1.6 frozen build). So we:
          * find the postmaster from PostgreSQL's OWN ``<datadir>/postmaster.pid``
            lockfile (line 1 is the postmaster pid) — a plain file read;
          * VERIFY the pid is a live ``postgres.exe`` (guards pid reuse) via a Toolhelp
            snapshot + QueryFullProcessImageNameW — ctypes;
          * TerminateProcess the postmaster + its ``postgres.exe`` backend children —
            ctypes / ``os.kill``.
        The orphan node (holds the fixed port; correctness is already covered by the
        dynamic-port fallback) is reaped best-effort the same way, keyed off the
        run-dir marker's recorded node pid + a ``node.exe`` image-name check.

        Called at startup pre-clean (so the new embedded PG owns its datadir
        exclusively — the actual fix) and on clean-exit stop(). Fail-open; returns the
        number of process trees reaped (0 off Windows)."""
        if os.name != "nt":
            return 0
        # Audit facts up front. Pre-clean runs BEFORE uvicorn attaches its file log
        # handler, so logger output here never reaches the service log — record to a
        # run-dir file so orphan issues stay diagnosable in support.
        audit: dict[str, Any] = {"context": context}
        try:
            audit["run_dir"] = str(self.run_dir)
            audit["node_home"] = str(self.node_home)
            audit["instance_home"] = str(self.instance_home)
            audit["instance_id"] = self.instance_id
            pidfile = self.instance_home / "db" / "postmaster.pid"
            audit["pidfile"] = pidfile.is_file()
            if pidfile.is_file():
                audit["pid1"] = pidfile.read_text(encoding="utf-8", errors="ignore").splitlines()[0].strip()
            audit["nprocs"] = len(self._windows_iter_processes())
        except Exception as exc:  # noqa: BLE001 — audit must never fail the sweep
            audit["audit_err"] = repr(exc)
        reaped = 0
        try:
            reaped += self._reap_orphan_postmaster(context=context)
            reaped += self._reap_orphan_node(context=context)
        except Exception as exc:  # noqa: BLE001 — reaping is best-effort, never blocks start/stop
            audit["reap_err"] = repr(exc)
            logger.warning("node server: instance orphan reap errored (%s)", context, exc_info=True)
        audit["reaped"] = reaped
        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            with (self.run_dir / "orphan-sweep.log").open("a", encoding="utf-8") as fh:
                fh.write(f"{audit}\n")
        except OSError:
            pass
        return reaped

    def _reap_orphan_postmaster(self, *, context: str) -> int:
        """Reap the postmaster recorded in ``<instance_home>/db/postmaster.pid`` when
        it is a live ``postgres.exe`` squatting this instance's datadir. A stale (dead)
        pid or a missing lockfile is a no-op — the vendored server clears the stale
        lock itself once the datadir is unowned."""
        pidfile = self.instance_home / "db" / "postmaster.pid"
        try:
            first_line = pidfile.read_text(encoding="utf-8", errors="ignore").splitlines()[0].strip()
            pid = int(first_line)
        except (OSError, ValueError, IndexError):
            return 0
        return self._reap_verified_tree(pid, "postgres.exe", context=context, kind="postmaster")

    def _reap_orphan_node(self, *, context: str) -> int:
        """Best-effort: reap the prior session's node (from the run-dir marker) when it
        is a live ``node.exe`` — frees the fixed port so we need not drift to a dynamic
        one. The marker start_signature is often null on Windows, so we verify by image
        name instead of the (missing) signature."""
        payload = self._read_marker()
        if not payload:
            return 0
        pid = payload.get("pid")
        if not isinstance(pid, int):
            return 0
        return self._reap_verified_tree(pid, "node.exe", context=context, kind="node")

    def _reap_verified_tree(self, pid: int, expect_exe: str, *, context: str, kind: str) -> int:
        """TerminateProcess ``pid`` and its same-image descendants IFF ``pid`` is a live
        process whose image name is ``expect_exe`` — never ourselves or the node we
        actively supervise. The image-name check (and following only same-image
        children) guards against Windows pid reuse / stale ppids. Returns 1 when the
        root was reaped, else 0."""
        if pid <= 0 or pid == os.getpid():
            return 0
        if self._process is not None and pid == self._process.pid:
            return 0
        procs = self._windows_iter_processes()
        name_of = {p: n for (p, _pp, n) in procs}
        if name_of.get(pid) != expect_exe:
            return 0  # dead, inaccessible, or recycled to a different image — never touch
        children: dict[int, list[int]] = {}
        for p, pp, _n in procs:
            children.setdefault(pp, []).append(p)
        # Root + descendants that share the same image (postgres postmaster -> its
        # postgres.exe backends). Following only same-image edges keeps a recycled ppid
        # from pulling an unrelated process into the kill set.
        order: list[int] = []
        seen: set[int] = set()
        stack = [pid]
        while stack:
            cur = stack.pop()
            if cur in seen or name_of.get(cur) != expect_exe:
                continue
            seen.add(cur)
            order.append(cur)
            stack.extend(children.get(cur, ()))
        for victim in reversed(order):  # children before the root
            try:
                os.kill(victim, signal.SIGTERM)  # Windows: TerminateProcess
            except (OSError, ValueError):
                pass
        # TerminateProcess is not instantaneous — the terminated process object lingers
        # briefly (an OpenProcess handle can still resolve it). Confirm the root has
        # actually LEFT the process table via a fresh Toolhelp snapshot (which clears
        # faster), bounded so a wedged process can never hang startup.
        deadline = time.monotonic() + 3.0
        while True:
            if pid not in {p for (p, _pp, _n) in self._windows_iter_processes()}:
                logger.info("node server: reaped orphan %s tree pid=%s n=%d (%s)", kind, pid, len(order), context)
                return 1
            if time.monotonic() >= deadline:
                logger.warning("node server: could not reap orphan %s pid=%s (%s)", kind, pid, context)
                return 0
            time.sleep(0.15)

    # --- pure-ctypes process primitives (frozen-safe; no subprocess) ---------

    @staticmethod
    def _windows_iter_processes() -> "list[tuple[int, int, str]]":
        """[(pid, ppid, image_base_name_lower), ...] for all live processes via a
        Toolhelp snapshot (ctypes). Empty list on any failure."""
        if os.name != "nt":
            return []
        import ctypes
        from ctypes import wintypes

        th32cs_snapprocess = 0x00000002

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260),
            ]

        out: list[tuple[int, int, str]] = []
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except OSError:
            return out
        k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        snap = k32.CreateToolhelp32Snapshot(th32cs_snapprocess, 0)
        invalid = ctypes.cast(-1, wintypes.HANDLE).value
        if not snap or snap == invalid:
            return out
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if not k32.Process32FirstW(snap, ctypes.byref(entry)):
                return out
            while True:
                out.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID), entry.szExeFile.lower()))
                if not k32.Process32NextW(snap, ctypes.byref(entry)):
                    break
        finally:
            k32.CloseHandle(snap)
        return out

    # --- teardown primitives (identity-gated, mirrors stop_service) ----------

    def _teardown_marker_pid(self, *, wait_timeout_seconds: float, expect_pid: int | None = None) -> dict[str, Any]:
        """Identity-gated teardown of the Node server recorded in the marker.

        Mirrors the Python sidecar's ``stop_service`` gate: signal only when a
        start-time signature proves the live pid is the instance we spawned. The
        Node server is its own process-group leader (spawned with
        ``start_new_session``), so a proven kill tears down its whole group.
        """
        payload = self._read_marker()
        if payload is None:
            return {"ok": True, "stopped": False, "reason": "no_marker", "pid": None}
        pid = payload.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            self._remove_marker()
            return {"ok": True, "stopped": False, "reason": "no_pid", "pid": None}
        if expect_pid is not None and pid != expect_pid:
            return {"ok": True, "stopped": False, "reason": "superseded", "pid": pid}
        if not _pid_exists(pid):
            self._remove_marker()
            return {"ok": True, "stopped": False, "reason": "not_running", "pid": pid}
        recorded = payload.get("start_signature")
        if not isinstance(recorded, str) or not recorded:
            # No identity captured — pid-number equality is not proof; refuse to
            # signal and keep the marker for a later signed overwrite.
            return {"ok": True, "stopped": False, "reason": "unidentified", "pid": pid}
        live = process_start_signature(pid)
        if live is None:
            return {"ok": True, "stopped": False, "reason": "identity_unconfirmed", "pid": pid}
        if live != recorded:
            self._remove_marker()
            return {"ok": True, "stopped": False, "reason": "pid_reused", "pid": pid}
        stopped = shutdown_process_pid(pid, wait_timeout_seconds=wait_timeout_seconds, process_group=True)
        self._remove_marker()
        return {"ok": True, "stopped": stopped, "reason": None, "pid": pid}

    def preclean_stale(self) -> dict[str, Any]:
        """Reap a Node orphan from a prior session (recorded in the marker) before
        binding, so a leftover does not hold the configured port (which would force
        the new Node server to auto-shift ports and break the web proxy)."""
        result = self._teardown_marker_pid(wait_timeout_seconds=2.0)
        if result["reason"] not in {"no_marker", "not_running"}:
            logger.info("node server pre-clean: %s (pid=%s)", result["reason"], result["pid"])
        # The marker gate above only knows the node pid. A prior session's DETACHED
        # embedded-PostgreSQL postmaster (pg_ctl daemon) is not a node descendant, so
        # it survives the watchdog's taskkill and squats this instance's datadir/port.
        # Sweep it (and any orphan node for this instance) by path BEFORE we start, so
        # the new embedded PG owns its datadir exclusively — the fix for the recurring
        # ECONNRESET/`node_unavailable` 503. Best-effort; never blocks pre-clean.
        try:
            if not self._preclean_swept:
                self._windows_sweep_instance_orphans(context="pre-clean")
                self._preclean_swept = True
        except Exception:  # noqa: BLE001 — sweep is best-effort, never blocks start
            logger.warning("node server: instance orphan sweep failed (continuing)", exc_info=True)
        return result

    # --- start / stop -------------------------------------------------------

    def start(self) -> NodeServiceHandle | None:
        """Spawn the Node server and register it, returning IMMEDIATELY after spawn.

        Deliberately does NOT block on readiness: the Python service must serve
        ``/health`` promptly (the desktop launcher kills it if it misses its own boot
        deadline), so a slow Node cold-start must never delay it. Readiness is
        confirmed asynchronously and only logged (diagnostics). Fail-open: returns
        ``None`` (never raises) when not runnable / port busy / spawn fails.
        """
        try:
            self.preclean_stale()
        except Exception:  # noqa: BLE001 — pre-clean is best-effort, never blocks start
            logger.warning("node server pre-clean failed (continuing)", exc_info=True)

        command = self.resolve_run_command()
        if command is None:
            return None

        # Only spawn when we can own the configured port; otherwise the vendored
        # server's detect-port would silently drift to another port and break the
        # web proxy + marker. Pre-clean above already freed any of OUR leftovers.
        if not self._port_is_available():
            if self.allow_dynamic_port:
                # Frozen desktop: the front door discovers the actual port via the
                # run-dir marker, so a foreign occupant on the configured port must
                # NOT brick the board — fall back to a free ephemeral port. Updating
                # self.port re-points base_url (a property) and the marker we write.
                free_port = _find_free_port(self.host)
                if free_port is None:
                    logger.warning(
                        "node server: port %s:%s busy and no free port available; skipping co-launch.",
                        self.host,
                        self.port,
                    )
                    return None
                logger.info(
                    "node server: port %s:%s busy; co-launching on free port %s "
                    "(front door discovers the actual port via the run-dir marker).",
                    self.host,
                    self.port,
                    free_port,
                )
                self.port = free_port
            else:
                logger.warning(
                    "node server: port %s:%s is busy (foreign occupant); not starting Node to avoid a port shift. "
                    "Free the port or set SUPERCLAW_NODE_PORT.",
                    self.host,
                    self.port,
                )
                return None

        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            self.node_home.mkdir(parents=True, exist_ok=True)
            log_file = (self.run_dir / NODE_LOG_NAME).open("a", encoding="utf-8")
        except OSError:
            logger.warning("node server: could not prepare run/home dirs (skipping)", exc_info=True)
            return None

        # On Windows the bundled node.exe is a console-subsystem binary, so spawning it
        # normally allocates a visible (empty) console window that stays up for the
        # server's whole lifetime. Its stdio is already redirected to the log file, so
        # the console is pure noise — suppress it with CREATE_NO_WINDOW. (POSIX has no
        # such window; the flag is Windows-only.)
        win_creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            process: subprocess.Popen[str] = subprocess.Popen(
                command,
                cwd=str(self.server_dir),
                stdout=log_file,
                stderr=log_file,
                stdin=subprocess.DEVNULL,
                text=True,
                env=self.build_env(),
                # Own session/group leader: keeps the Node tree separable for a
                # clean group teardown, and (as a descendant by ppid) still reaped
                # by the service's watchdog tree walk.
                start_new_session=os.name != "nt",
                creationflags=win_creationflags,
            )
        except (OSError, ValueError):
            logger.warning("node server: failed to spawn %r (skipping)", command[0], exc_info=True)
            log_file.close()
            return None

        # The child keeps writing to log_file for its lifetime; intentionally left
        # open (closed when the process exits / is reaped).
        self._process = process
        handle = NodeServiceHandle(
            base_url=self.base_url,
            port=self.port,
            pid=process.pid,
            start_signature=process_start_signature(process.pid),
            process=process,
        )
        try:
            self._write_marker(handle)
        except OSError:
            logger.warning("node server: marker write failed (continuing)", exc_info=True)
        logger.info("node server spawned (pid=%s); confirming readiness at %s asynchronously", process.pid, self.base_url)
        self._spawn_readiness_logger()
        return handle

    def _spawn_readiness_logger(self) -> None:
        """Confirm readiness off the hot path (diagnostics only — no lifecycle role)."""
        thread = threading.Thread(target=self._log_readiness, name="node-server-readiness", daemon=True)
        thread.start()

    def _log_readiness(self) -> None:
        deadline = time.monotonic() + self.boot_timeout_seconds
        try:
            while time.monotonic() < deadline:
                if self._stopping:
                    return  # torn down on purpose; nothing to report
                proc = self._process
                if proc is None or proc.poll() is not None:
                    # Re-check: stop() may have raced in between the top-of-loop
                    # check and here, niling _process — that is a deliberate
                    # teardown, not a crash, so stay quiet.
                    if self._stopping:
                        return
                    logger.warning(
                        "node server exited before readiness; see %s",
                        self.run_dir / NODE_LOG_NAME,
                    )
                    return
                if self.probe_health():
                    self._ready = True
                    logger.info("node server ready at %s", self.base_url)
                    return
                time.sleep(0.5)
            logger.warning(
                "node server not ready within %.1fs at %s (continuing; clients will retry)",
                self.boot_timeout_seconds,
                self.base_url,
            )
        except Exception:  # noqa: BLE001 — a diagnostics thread must never crash the process
            logger.warning("node server readiness logger errored", exc_info=True)

    def stop(self, *, wait_timeout_seconds: float = 2.0) -> dict[str, Any]:
        """Tear down the Node server. Prefers the live process handle (this service
        spawned it); otherwise resolves it from the marker (identity-gated)."""
        self._stopping = True  # silence the readiness logger (deliberate teardown)
        self._ready = False
        # Deregister from the process-active slot so /api/runtime/status stops reporting
        # this (now torn-down) Node as enabled. Guard on identity: never clear a different
        # supervisor that may have replaced us.
        global _ACTIVE_SUPERVISOR
        if _ACTIVE_SUPERVISOR is self:
            _ACTIVE_SUPERVISOR = None
        process = self._process
        if process is not None and process.poll() is None:
            pid = process.pid
            stopped = self._terminate_live_process(process, wait_timeout_seconds=wait_timeout_seconds)
            self._process = None
            self._remove_marker()
            result: dict[str, Any] = {"ok": True, "stopped": stopped, "reason": None, "pid": pid}
        else:
            self._process = None
            result = self._teardown_marker_pid(wait_timeout_seconds=wait_timeout_seconds)
        # Reap the detached embedded-PostgreSQL postmaster (and any lingering instance
        # node): killing node does NOT stop its pg_ctl-detached postgres.exe, which
        # would otherwise squat the datadir/port for the next launch. Windows-only,
        # path-scoped to this instance; no-op elsewhere. Best-effort.
        try:
            self._windows_sweep_instance_orphans(context="stop")
        except Exception:  # noqa: BLE001 — teardown must never raise on the exit path
            logger.warning("node server: instance orphan sweep on stop failed", exc_info=True)
        return result

    @staticmethod
    def _terminate_live_process(process: subprocess.Popen[str], *, wait_timeout_seconds: float) -> bool:
        """Tear down a Node server we hold a live ``Popen`` for (clean-exit path).

        Signals the whole process group (Node leads its own session, so this also
        reaches its children) and then REAPS the direct child via ``Popen.wait`` —
        which is the part the marker path cannot do. Reaping matters because, while
        this parent service keeps running, an un-reaped child lingers as a zombie
        that a group-liveness probe would mis-read as still alive (and would also
        burn the full timeout). Escalates SIGTERM -> SIGKILL. Windows has no process
        groups, so it falls back to ``terminate``/``kill`` on the single process.
        """
        pid = process.pid

        def _signal(sig: int) -> None:
            if os.name == "nt":
                # No POSIX groups; signal the process directly.
                try:
                    process.send_signal(sig)
                except (OSError, ValueError):
                    pass
                return
            try:
                os.killpg(os.getpgid(pid), sig)
                return
            except (ProcessLookupError, PermissionError, OSError):
                # Group signal unavailable (already gone / denied / not a leader):
                # degrade to the single pid rather than abandoning teardown.
                try:
                    os.kill(pid, sig)
                except (ProcessLookupError, OSError):
                    pass

        _signal(signal.SIGTERM)
        try:
            process.wait(timeout=wait_timeout_seconds)
        except subprocess.TimeoutExpired:
            _signal(getattr(signal, "SIGKILL", signal.SIGTERM))
            try:
                process.wait(timeout=wait_timeout_seconds)
            except subprocess.TimeoutExpired:
                pass
        return process.poll() is not None


def node_marker_exists(run_dir: Path | str) -> bool:
    """Whether the Node co-launch marker exists in ``run_dir`` — i.e. *this* process
    co-launched Node. The front door distinguishes "no marker" (plain Python / tests
    -> delegate) from "marker present but Node unreadable/unreachable" (fail closed)."""
    return (Path(run_dir) / NODE_MARKER_NAME).is_file()


def read_node_base_url(run_dir: Path | str) -> str | None:
    """Return the co-launched Node server's base URL from its on-disk marker, or
    ``None`` when no marker exists (Node was never co-launched here).

    This is the front door's gate: a present marker means "this process co-launched
    Node" (so Node-owned routes should be reverse-proxied / fail-closed), while an
    absent marker means a plain-Python deployment (tests, no coexist) — the front
    door stays inactive and Python's own routes serve. The marker carries the ACTUAL
    bound base URL, so a port that drifted from the default is still resolved
    correctly. A stale marker (Node crashed) still returns a URL; the caller's
    connection attempt then fails closed."""
    marker = Path(run_dir) / NODE_MARKER_NAME
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    base = payload.get("base_url") if isinstance(payload, dict) else None
    return base if isinstance(base, str) and base else None


# Process-singleton handle to the Node supervisor co-launched by the running service.
# The supervisor and the FastAPI app share ONE process (uvicorn.run is invoked right
# after start_node_sidecar_if_enabled in the same process — see cli.py / desktop
# superclaw_service.py), so the API's /api/runtime/status handler reads this to report
# Node coexistence readiness without threading the supervisor through create_app().
# Set when a server actually starts; cleared on stop().
_ACTIVE_SUPERVISOR: "NodeServerSupervisor | None" = None


def active_node_supervisor() -> "NodeServerSupervisor | None":
    """The Node supervisor co-launched in this process, or None when none is running."""
    return _ACTIVE_SUPERVISOR


def node_runtime_status_snapshot() -> dict[str, Any]:
    """Node coexistence state for the /api/runtime/status contract (single source).

    ``enabled``: the web startup gate should WAIT for Node — true when a Node server is
    co-launched in THIS process, OR when one is REQUIRED (``SUPERCLAW_NODE_SERVER=on``)
    but not currently up (so a required-but-failed Node surfaces as a held splash +
    ``error``, never masquerading as "no Node here"). ``auto``/``off`` with no live
    server ⇒ enabled=false (optional/absent — don't block). ``ready``: Node is confirmed
    healthy AND its process is still alive (non-blocking). ``error``: reason a required
    Node is not ready, else null. ``url``/``port``: diagnostics.
    """
    supervisor = _ACTIVE_SUPERVISOR
    if supervisor is not None:
        return {
            "enabled": True,
            "ready": supervisor.is_ready(),
            "url": supervisor.base_url,
            "port": supervisor.port,
            "error": None,
        }
    # No live supervisor in this process. Distinguish "required but not running" (mode=on)
    # from "optional/disabled" (auto/off) so the gate neither masks a real failure nor
    # waits for a Node this deployment never intended to run.
    required = node_server_mode() == "on"
    return {
        "enabled": required,
        "ready": False,
        "url": None,
        "port": None,
        "error": ("node server required (SUPERCLAW_NODE_SERVER=on) but not running" if required else None),
    }


def start_node_sidecar_if_enabled(state_path: Path, *, host: str = "127.0.0.1") -> NodeServerSupervisor | None:
    """Co-launch the Node server alongside the Python service, honoring
    ``SUPERCLAW_NODE_SERVER``. Returns the supervisor (so the caller can tear it
    down on service exit) when a server was started, else ``None``.

    Fail-open: any failure logs and returns ``None`` — the Python service must come
    up regardless of the Node server's fate.
    """
    mode = node_server_mode()
    if mode == "off":
        return None
    try:
        run_dir = Path(state_path).parent / "run"
        # A frozen desktop bundle reaches Node ONLY through the Python front door,
        # which discovers the server's port from the run-dir marker — so a busy
        # configured port (3100, or anything an unrelated process holds on the user's
        # machine) should fall back to a free port rather than leave the board dark.
        # A dev/source run keeps the fixed port (the vite proxy hardcodes 3100).
        allow_dynamic_port = bool(getattr(sys, "frozen", False))
        supervisor = NodeServerSupervisor(run_dir=run_dir, host=host, allow_dynamic_port=allow_dynamic_port)
        # Pre-clean a stale orphan from a PRIOR (then-runnable) session BEFORE the
        # runnable gate — otherwise a checkout that lost its build/tsx would leave a
        # previous session's Node running forever (start()'s own pre-clean is never
        # reached when not runnable).
        try:
            supervisor.preclean_stale()
        except Exception:  # noqa: BLE001 — best-effort; never blocks the service
            logger.warning("node server pre-clean failed (continuing)", exc_info=True)
        if not supervisor.is_runnable():
            if mode == "on":
                logger.warning(
                    "SUPERCLAW_NODE_SERVER=on but the Node server is not runnable "
                    "(no built dist/index.js or tsx dev binary, or node not found); "
                    "build it with `pnpm install && pnpm -r build` under server/. Continuing Python-only."
                )
            else:
                logger.debug("node server not runnable; skipping co-launch (mode=auto)")
            return None
        handle = supervisor.start()
        if handle is None:
            return None
        # Register as the process-active supervisor so /api/runtime/status (same process)
        # can report Node readiness. Only after a confirmed start — a never-started
        # supervisor must read as enabled=False so the gate doesn't wait for absent Node.
        global _ACTIVE_SUPERVISOR
        _ACTIVE_SUPERVISOR = supervisor
        return supervisor
    except Exception:  # noqa: BLE001 — never let Node orchestration brick the service
        logger.warning("node server co-launch failed (continuing Python-only)", exc_info=True)
        return None


def stop_node_sidecar(
    run_dir: Path,
    *,
    host: str = "127.0.0.1",
    wait_timeout_seconds: float = 2.0,
) -> dict[str, Any]:
    """Marker-driven teardown of a co-launched Node server. Identity-gated (start-time
    signature, so a recycled pid is never killed); idempotent and fail-open."""
    try:
        supervisor = NodeServerSupervisor(run_dir=Path(run_dir), host=host)
        return supervisor.stop(wait_timeout_seconds=wait_timeout_seconds)
    except Exception as exc:  # noqa: BLE001 — teardown must never raise on the exit path
        logger.warning("node server stop failed", exc_info=True)
        return {"ok": False, "stopped": False, "reason": "error", "error": str(exc), "pid": None}


# Python stop_service ``reason`` values that PROVE the sidecar is gone (not merely
# "we declined to touch it"): the pid is not alive, or the pid was recycled into a
# different process. In both, the Python service is absent, so its co-launched Node
# is an orphan we may reap. Everything else is NOT proof of absence:
#   - ``None`` is "we signalled it" — only a release when ``stopped is True``
#     (a kill that returned False may have left Python alive), handled separately.
#   - ``no_pid`` is the ATTACH-ONLY marker (desktop attached to an existing service,
#     no owned pid) — Python is alive; reaping its Node would orphan a live service.
#   - ``no_marker`` is "no Python service known here" — not proof one is absent; any
#     true Node orphan is reaped by the next startup pre-clean instead.
#   - ``superseded`` / ``unidentified`` / ``identity_unconfirmed`` = deliberately
#     retained (another session's, or unverifiable identity) → leave its Node.
# Node's own signature gate cannot tell WHICH Python session owns it, so we defer to
# the Python ownership decision here (conservative: leak-then-clean-at-startup beats
# killing a live session's Node).
_PYTHON_REASONS_RELEASE_NODE = frozenset({"not_running", "pid_reused"})


def stop_node_sidecar_for_python_result(
    run_dir: Path,
    python_result: dict[str, Any],
    *,
    host: str = "127.0.0.1",
    wait_timeout_seconds: float = 2.0,
) -> dict[str, Any]:
    """Tear down the co-launched Node server ONLY when the paired Python teardown
    proves its sidecar was stopped or is absent — never when Python may still be
    alive (kill failed, attach-only marker, ownership/identity ambiguity)."""
    reason = python_result.get("reason")
    released = (reason is None and python_result.get("stopped") is True) or reason in _PYTHON_REASONS_RELEASE_NODE
    if not released:
        return {"ok": True, "stopped": False, "reason": "skipped_python_retained", "pid": None}
    return stop_node_sidecar(run_dir, host=host, wait_timeout_seconds=wait_timeout_seconds)


def install_signal_teardown(*supervisors: "Any | None") -> None:
    """Install SIGINT/SIGTERM handlers (main thread) that tear down the co-launched
    sidecars (Node control plane, automation gateway, …) before the service process
    dies. Each argument is any object exposing ``.stop()`` (``None`` is ignored).

    Why this is needed in addition to the ``finally`` around ``uvicorn.run``: uvicorn
    CAPTURES SIGINT/SIGTERM and RE-RAISES them on shutdown, so the process is
    terminated by the signal and the ``finally`` never runs — a web-dev Ctrl+C /
    ``kill`` would otherwise orphan the sidecars. uvicorn restores the pre-existing
    (our) handlers before re-raising, so a handler installed here runs at that point.
    (The desktop App's exit is handled separately by the ``--watch-ui-pid`` watchdog,
    which reaps descendants regardless of signals.) A SINGLE combined handler tears
    down ALL supervisors — installing one per supervisor would have each
    ``signal.signal`` overwrite the last, leaking every sidecar but the final one.
    No-op when no supervisor is live or on Windows / off the main thread.
    """
    live = [s for s in supervisors if s is not None]
    if not live or os.name == "nt":
        return

    def _handler(signum, _frame):  # type: ignore[no-untyped-def]
        # Tear down in REVERSE of the start order (last-started first), matching the
        # clean-exit ``finally`` blocks: the gateway (started after Node, and a client
        # of it) is stopped BEFORE the Node upstream, so a signal never kills Node out
        # from under a still-running gateway. Callers pass supervisors in start order.
        for supervisor in reversed(live):
            try:
                supervisor.stop()
            except Exception:  # noqa: BLE001 — teardown must never mask the exit
                logger.warning("sidecar teardown in signal handler failed", exc_info=True)
        # Restore the default disposition and re-raise so the exit status still
        # reflects the signal (and any outer handler/uvicorn semantics hold).
        signal.signal(signum, signal.SIG_DFL)
        signal.raise_signal(signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            # Not the main thread, or signal unsupported — fall back to the finally.
            pass
