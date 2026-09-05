"""Runtime reachability probe — actively verify which agent runtimes are usable
(credentials valid + provider reachable), the SAME mechanism Paperclip's adapter
test uses (an authenticated model-list round-trip), NOT a real agent turn.

This is the kernel for ``superclaw doctor --deep`` and the Web/API runtime-health
surface — the single source of truth every surface (CLI, API, Web) projects.

Why a model-list round-trip, not a real turn:

  * A real delivery turn goes through the agentic ``backend.run`` loop, which
    exposes read/list tools to the model (a read-only fence denies run_shell /
    write_file but NOT read_file / list_files) and wraps its output in
    transcript/headers — so it is neither tool-free nor cleanly parseable, and a
    strict "did it answer the contract" check is unreachable on real backends.
  * Paperclip's adapter test is ``listModels()`` — an authenticated
    ``GET /v1/models`` to the provider. SuperClaw already has the equivalent,
    hardened, kernel primitive: ``model_discovery.discover_models`` (the same
    call the model-selector dropdown already makes, ungated and free; it sets
    ``follow_redirects=False`` + ``trust_env=False`` so a relay key is never
    forwarded to a redirect or a system proxy). A model-list is metadata, not a
    billed generation — there is no spend to gate and no tool surface to expose.

Because this reuses a primitive already invoked freely in production, the probe
introduces NO new governance surface, NO new spend, and NO tool exposure.

Three honest states — a probe proves the CONTROL PLANE is reachable, never
end-to-end deliverability:

  * ``runtime_ready``   — live credentialed reachability succeeded: the provider
                          answered with a model list under the backend's own
                          auth. The strong "this runtime is actually usable now".
  * ``runtime_present`` — the binary/config is present (which + --version) but the
                          backend exposes no live discovery channel to verify
                          against. Presence is confirmed; reachability is not —
                          stated honestly rather than guessed either way.
  * ``runtime_fail``    — the live probe failed (``auth``: missing/invalid/expired
                          key; ``network``: provider unreachable) or the backend
                          is not installed at all.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from superclaw.backends import WorkerBackend, default_backends
from superclaw.model_discovery import discover_models
from superclaw.ui_contracts import AGENT_CONTROL_SPECS

__all__ = [
    "ProbeVerdict",
    "ProbeResult",
    "probe_backend",
    "probe_runtimes",
]

def discovery_reachability_class(backend_name: str, backend: WorkerBackend | None = None) -> str:
    """This backend's model-discovery faithfulness. One backend-owned truth bit —
    the kernel never couples to a backend name. Two layers, both backend-owned:

      1. RUNTIME refinement: if the backend exposes ``resolve_discovery_reachability()``
         it wins, because faithfulness can be CAPABILITY-CONDITIONED — e.g. codex's
         discovery is the app-server ``model/list``, faithful only when the binary
         is BOTH ``exec``-capable AND its app-server answers (exec ≠ app-server-ready);
         a ``legacy`` codex or a broken app-server runs/falls back fine but would
         false-fail discovery, so codex returns ``cross_plane`` then. A static spec
         constant cannot express this.
      2. STATIC default: otherwise the ``discovery_reachability`` declared in the
         single-source ``AGENT_CONTROL_SPECS`` contract.

    Values:
      * ``"faithful"``    — discovery probes the SAME plane the run lane uses
                            (own CLI, or the same API key), so its result is
                            reachability truth. The default for unprobed backends
                            (no live channel ⇒ presence-only anyway).
      * ``"synthetic"``   — discovery returns a fail-safe synthetic list (e.g. a
                            relay package floor) that is non-empty even when the
                            runtime is unreachable; never reachability proof.
      * ``"cross_plane"`` — discovery probes a DIFFERENT credential/transport plane
                            than the run lane (e.g. an API ``/v1/models`` for a
                            CLI-session backend, a sibling endpoint, or a mode the
                            binary does not support), so it is not the run lane's
                            reachability.
    """
    if backend is not None:
        resolver = getattr(backend, "resolve_discovery_reachability", None)
        if callable(resolver):
            resolved = resolver()
            if resolved:
                return str(resolved)
    return str(AGENT_CONTROL_SPECS.get(backend_name, {}).get("discovery_reachability", "faithful"))


def _discovery_reflects_reachability(backend_name: str, backend: WorkerBackend | None = None) -> bool:
    """Whether ``discover_models`` faithfully probes this backend's RUN plane (so
    its result is reachability truth). Non-faithful backends (``synthetic`` /
    ``cross_plane``) cap at ``runtime_present`` when installed — never
    ``runtime_ready``/``runtime_fail`` off discovery (the two R2 honesty bugs)."""
    return discovery_reachability_class(backend_name, backend) == "faithful"


class ProbeVerdict(str, Enum):
    """Three-state runtime reachability outcome. Proves control-plane
    reachability, never end-to-end deliverability."""

    RUNTIME_READY = "runtime_ready"
    RUNTIME_PRESENT = "runtime_present"
    RUNTIME_FAIL = "runtime_fail"


@dataclass(frozen=True)
class ProbeResult:
    """Structured outcome of probing one backend. Surfaces render this verbatim —
    they MUST NOT re-derive the verdict or reclassify ``failure_reason`` (that
    would fork the kernel's single ruling)."""

    backend: str
    verdict: ProbeVerdict
    detail: str
    # How deep the verification went: "live" (credentialed provider round-trip),
    # "shallow" (presence only — no live channel), "none" (not installed).
    depth: str = "none"
    # Shallow presence (which + --version), independent of reachability.
    present: bool = False
    version: str | None = None
    # Live reachability evidence (only when depth == "live").
    models_count: int | None = None
    default_model: str | None = None
    latency_ms: int | None = None
    # Classified hint on a failed live probe: auth / network / probe / unavailable.
    failure_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "verdict": self.verdict.value,
            "detail": self.detail,
            "depth": self.depth,
            "present": self.present,
            "version": self.version,
            "models_count": self.models_count,
            "default_model": self.default_model,
            "latency_ms": self.latency_ms,
            "failure_reason": self.failure_reason,
        }


def _classify_catalog_error(error: str | None) -> str:
    """The discovery layer already classifies its probe errors as
    ``"auth: ..."`` / ``"network: ..."`` / ``"probe: ..."`` (see
    ``model_discovery._classify_probe_error``). Re-use that prefix as the single
    source of the failure reason — never re-pattern-match the raw text here."""
    if not error:
        return "probe"
    head = error.split(":", 1)[0].strip().lower()
    if head in {"auth", "network", "probe"}:
        return head
    return "probe"


def probe_backend(
    backend_name: str,
    *,
    backends: dict[str, WorkerBackend] | None = None,
    force_refresh: bool = True,
) -> ProbeResult:
    """Reachability-probe a single backend and return a three-state verdict.

    ``force_refresh=True`` (the default for an explicit "test") bypasses the
    discovery TTL cache so the probe reflects the runtime's state right now;
    pass ``False`` to accept a recent cached result (cheaper batch sweeps)."""
    table = backends if backends is not None else default_backends()
    backend = table.get(backend_name)
    if backend is None:
        return ProbeResult(
            backend=backend_name,
            verdict=ProbeVerdict.RUNTIME_FAIL,
            detail=f"unknown backend '{backend_name}'",
            failure_reason="unavailable",
        )

    # Cheap, purely-local presence + version (which + --version). Never a model
    # call, never a network round-trip — establishes "installed" independent of
    # reachability so a present-but-unverifiable backend reads honestly.
    availability = backend.available()

    # When discovery cannot faithfully verify THIS backend's run plane (relay
    # synthetic list / claude cross-plane), refuse to read ready/fail off it —
    # report presence only. Skipping discovery here also avoids a pointless
    # (synthetic or wrong-plane) round-trip.
    if not _discovery_reflects_reachability(backend_name, backend):
        if availability.available:
            why = {
                "synthetic": "a model list is the relay's fail-safe package floor and "
                "cannot confirm the relay is reachable or the login valid",
                "cross_plane": "the discovery channel probes a different credential/endpoint "
                "than the run lane uses, so it cannot confirm run-lane reachability",
            }.get(
                discovery_reachability_class(backend_name, backend),
                "this runtime exposes no faithful reachability channel",
            )
            return ProbeResult(
                backend=backend_name,
                verdict=ProbeVerdict.RUNTIME_PRESENT,
                detail=f"installed, but reachability is not verifiable from here: {why}",
                depth="shallow",
                present=True,
                version=availability.version,
            )
        return ProbeResult(
            backend=backend_name,
            verdict=ProbeVerdict.RUNTIME_FAIL,
            detail=availability.reason or "backend not available",
            depth="none",
            present=False,
            version=availability.version,
            failure_reason="unavailable",
        )

    # runtime_ready requires BOTH local runnability AND remote reachability. A
    # backend that is not locally runnable (missing SDK / executable / required
    # config — its own available() says so) can NEVER be ready off a remote model
    # list: the run would not even start. Gate on availability BEFORE probing, so
    # remote reachability never paints a locally-unrunnable backend ready.
    if not availability.available:
        return ProbeResult(
            backend=backend_name,
            verdict=ProbeVerdict.RUNTIME_FAIL,
            detail=availability.reason or "backend not available",
            depth="none",
            present=False,
            version=availability.version,
            failure_reason="unavailable",
        )

    started = time.monotonic()
    catalog = discover_models(backend_name, backends=table, force_refresh=force_refresh)
    latency_ms = int((time.monotonic() - started) * 1000)

    # 1. Locally runnable AND live credentialed reachability — the strong signal.
    if catalog.source == "live":
        return ProbeResult(
            backend=backend_name,
            verdict=ProbeVerdict.RUNTIME_READY,
            detail="installed and reachable: provider answered with the backend's credentials",
            depth="live",
            present=True,
            version=availability.version,
            models_count=len(catalog.models),
            default_model=catalog.default_model,
            latency_ms=latency_ms,
        )

    # 2. A live probe was attempted and FAILED — surface the classified reason.
    #    (The discovery layer redacts secrets and classifies before we see it.)
    if catalog.error:
        reason = _classify_catalog_error(catalog.error)
        detail = {
            "auth": "credentials missing/invalid — the provider rejected the backend's key/login",
            "network": "provider unreachable (network/timeout)",
        }.get(reason, "live reachability probe failed")
        return ProbeResult(
            backend=backend_name,
            verdict=ProbeVerdict.RUNTIME_FAIL,
            detail=detail,
            depth="live",
            present=True,
            version=availability.version,
            latency_ms=latency_ms,
            failure_reason=reason,
        )

    # 3. Installed but the discovery channel returned no live result this run (no
    #    error either) — cannot credential-verify; report presence honestly.
    return ProbeResult(
        backend=backend_name,
        verdict=ProbeVerdict.RUNTIME_PRESENT,
        detail="installed, but this runtime exposes no live channel to verify reachability",
        depth="shallow",
        present=True,
        version=availability.version,
    )


def probe_runtimes(
    backend_names: list[str] | None = None,
    *,
    backends: dict[str, WorkerBackend] | None = None,
    force_refresh: bool = True,
) -> list[ProbeResult]:
    """Reachability-probe many backends (default: all). Each probe is a free,
    tool-free, hardened model-list round-trip — a single "test all" never spends
    and never exposes a tool surface, so there is no paid lane to skip and no
    per-lane approval to manage (unlike a real-turn probe). Paid relay lanes are
    probed exactly like free ones: a model list is metadata, not a billed turn."""
    table = backends if backends is not None else default_backends()
    names = backend_names if backend_names is not None else list(table.keys())
    return [
        probe_backend(name, backends=table, force_refresh=force_refresh)
        for name in names
    ]
