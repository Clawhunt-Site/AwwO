"""Kernel tests for the runtime reachability probe.

These prove the design the adversarial review converged on: the probe is a
tool-free, spend-free, authenticated model-list round-trip (Paperclip's adapter
test logic), NEVER the agentic ``backend.run`` loop — so it cannot expose
read/list tools and cannot run an agent turn. Plus the three-state verdict
(ready / present / fail) and its honest depth/reason classification."""

from __future__ import annotations

import pytest

import superclaw.runtime_probe as runtime_probe
from superclaw.backends import BackendAvailability
from superclaw.model_discovery import ModelCatalog
from superclaw.ui_contracts import AGENT_CONTROL_SPECS
from superclaw.runtime_probe import (
    ProbeVerdict,
    probe_backend,
    probe_runtimes,
)


class _FakeBackend:
    """A backend double that records whether the agentic ``run`` loop was ever
    invoked (it must never be) and exposes a controllable shallow availability."""

    def __init__(self, name: str = "fake", *, available: bool = True, version: str | None = "1.0") -> None:
        self.name = name
        self._available = available
        self._version = version
        self.run_calls = 0

    def available(self) -> BackendAvailability:
        if self._available:
            return BackendAvailability(name=self.name, available=True, executable="/bin/fake", version=self._version)
        return BackendAvailability(name=self.name, available=False, reason="fake not found on PATH")

    def run(self, *_a, **_k):  # noqa: ANN002, ANN003 - must never be called
        self.run_calls += 1
        raise AssertionError("probe must never invoke the agentic run loop")


@pytest.fixture()
def patch_discovery(monkeypatch):
    """Install a fake ``discover_models`` and return a setter for the catalog the
    next probe will see."""

    holder: dict[str, ModelCatalog] = {}

    def _fake_discover(backend_name, *, backends=None, force_refresh=False):  # noqa: ANN001
        return holder.get(backend_name, ModelCatalog(backend=backend_name, source="static"))

    monkeypatch.setattr(runtime_probe, "discover_models", _fake_discover)

    def _set(backend_name: str, catalog: ModelCatalog) -> None:
        holder[backend_name] = catalog

    return _set


# --- The core invariant: never the agent loop, never a tool surface ---------


def test_probe_never_invokes_run_loop(patch_discovery) -> None:
    patch_discovery("fake", ModelCatalog(backend="fake", source="live", models=["m1", "m2"]))
    backend = _FakeBackend("fake")
    probe_backend("fake", backends={"fake": backend})
    assert backend.run_calls == 0  # tool-free, no agent turn, ever


# --- Three-state verdict ----------------------------------------------------


def test_live_reachability_is_ready(patch_discovery) -> None:
    patch_discovery("fake", ModelCatalog(backend="fake", source="live", models=["a", "b", "c"], default_model="a"))
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake")})
    assert res.verdict is ProbeVerdict.RUNTIME_READY
    assert res.depth == "live"
    assert res.models_count == 3
    assert res.default_model == "a"
    assert res.latency_ms is not None
    assert res.failure_reason is None


def test_auth_failure_is_fail_with_auth_reason(patch_discovery) -> None:
    patch_discovery("fake", ModelCatalog(backend="fake", source="static", error="auth: HTTP 401: Unauthorized"))
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake")})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "auth"
    assert res.depth == "live"


def test_network_failure_is_fail_with_network_reason(patch_discovery) -> None:
    patch_discovery("fake", ModelCatalog(backend="fake", source="static", error="network: timed out"))
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake")})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "network"


def test_present_but_no_live_channel_is_present(patch_discovery) -> None:
    # static catalog, no error, backend installed → honest "present, unverified".
    patch_discovery("fake", ModelCatalog(backend="fake", source="static"))
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake", version="2.1")})
    assert res.verdict is ProbeVerdict.RUNTIME_PRESENT
    assert res.depth == "shallow"
    assert res.present is True
    assert res.version == "2.1"
    assert res.failure_reason is None


def test_not_installed_and_no_live_channel_is_fail(patch_discovery) -> None:
    patch_discovery("fake", ModelCatalog(backend="fake", source="unavailable"))
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake", available=False)})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "unavailable"
    assert res.present is False


def test_unknown_backend_is_fail(patch_discovery) -> None:
    res = probe_backend("does-not-exist", backends={})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "unavailable"


def test_not_locally_runnable_is_never_ready_even_if_remote_reachable(monkeypatch) -> None:
    # runtime_ready requires BOTH local runnability AND remote reachability. A
    # backend whose available() is False (missing SDK / executable / required
    # config) can NEVER be ready off a remote model list — the run would not even
    # start. And we must not even probe (no point hitting the network for a backend
    # that cannot run). Guards the "key/network OK but SDK not installed" false-ready.
    def _explode(*_a, **_k):
        raise AssertionError("must not probe a backend that is not locally runnable")

    monkeypatch.setattr(runtime_probe, "discover_models", _explode)
    res = probe_backend("fake", backends={"fake": _FakeBackend("fake", available=False)})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "unavailable"


# --- Batch ------------------------------------------------------------------


def test_probe_runtimes_maps_each_backend(patch_discovery) -> None:
    patch_discovery("ready", ModelCatalog(backend="ready", source="live", models=["m"]))
    patch_discovery("broken", ModelCatalog(backend="broken", source="static", error="auth: HTTP 403"))
    backends = {"ready": _FakeBackend("ready"), "broken": _FakeBackend("broken")}
    results = probe_runtimes(backends=backends)
    by_name = {r.backend: r for r in results}
    assert by_name["ready"].verdict is ProbeVerdict.RUNTIME_READY
    assert by_name["broken"].verdict is ProbeVerdict.RUNTIME_FAIL
    assert by_name["broken"].failure_reason == "auth"
    # No agent loop invoked for any backend in the batch.
    assert all(b.run_calls == 0 for b in backends.values())


# --- Honesty: non-faithful discovery channels never read ready/fail (R2 fix) --


def test_relay_package_backend_is_present_not_ready(monkeypatch) -> None:
    # clawwork's discovery is the relay's fail-safe SYNTHETIC package list (always
    # non-empty), so it must NEVER be read as runtime_ready. And discovery must
    # not even be called — we skip the synthetic round-trip.
    def _explode(*_a, **_k):
        raise AssertionError("discovery must be skipped for a relay-package backend")

    monkeypatch.setattr(runtime_probe, "discover_models", _explode)
    res = probe_backend("clawwork", backends={"clawwork": _FakeBackend("clawwork")})
    assert res.verdict is ProbeVerdict.RUNTIME_PRESENT
    assert res.depth == "shallow"
    assert "relay" in res.detail.lower()


def test_claude_cross_plane_no_api_key_is_present_not_fail(monkeypatch) -> None:
    # claude runs off the Claude CLI session; the discovery probe tests the
    # Anthropic API plane (different credential). A healthy installed claude must
    # be runtime_present, never runtime_fail off that wrong-plane probe.
    def _explode(*_a, **_k):
        raise AssertionError("discovery must be skipped for a cross-plane backend")

    monkeypatch.setattr(runtime_probe, "discover_models", _explode)
    res = probe_backend("claude", backends={"claude": _FakeBackend("claude")})
    assert res.verdict is ProbeVerdict.RUNTIME_PRESENT
    assert res.failure_reason is None


def test_http_cross_plane_is_present_not_ready(monkeypatch) -> None:
    # http discovery probes the sibling /v1/models route, but the run lane POSTs to
    # the configured chat endpoint — a different route. So a model list there is not
    # run-endpoint reachability: present, never a false ready/fail off discovery.
    def _explode(*_a, **_k):
        raise AssertionError("discovery must be skipped for a cross-plane backend")

    monkeypatch.setattr(runtime_probe, "discover_models", _explode)
    res = probe_backend("http", backends={"http": _FakeBackend("http")})
    assert res.verdict is ProbeVerdict.RUNTIME_PRESENT


def test_non_faithful_backend_not_installed_is_fail(monkeypatch) -> None:
    monkeypatch.setattr(runtime_probe, "discover_models", lambda *a, **k: None)
    res = probe_backend("claude", backends={"claude": _FakeBackend("claude", available=False)})
    assert res.verdict is ProbeVerdict.RUNTIME_FAIL
    assert res.failure_reason == "unavailable"


# --- Completeness lock: every probed backend must DECLARE its faithfulness ----


def test_every_probed_backend_declares_discovery_reachability() -> None:
    # A backend with a live model-discovery prober can produce a ready/fail verdict
    # off that probe, so it MUST declare whether that probe faithfully reflects its
    # run plane — otherwise a newly-added prober silently defaults to "faithful" and
    # can paint a broken backend ready (the http/claude/clawwork class of bug). This
    # lock forces every prober author to classify reachability in the contract.
    from superclaw.model_discovery import _PROBERS

    valid = {"faithful", "synthetic", "cross_plane"}
    for name in _PROBERS:
        spec = AGENT_CONTROL_SPECS.get(name)
        assert spec is not None, f"probed backend {name!r} missing from AGENT_CONTROL_SPECS"
        declared = spec.get("discovery_reachability")
        assert declared in valid, (
            f"probed backend {name!r} must declare discovery_reachability "
            f"(one of {sorted(valid)}); got {declared!r}"
        )


# The reviewed, expected STATIC discovery_reachability class for every backend
# with a live discovery prober. This matrix locks "declaration CORRECT", not just
# "declaration exists" — a typo or a wrong reclassification fails here.
_EXPECTED_DISCOVERY_CLASS = {
    "codex": "faithful",  # runtime-refined to cross_plane on a legacy binary
    "codex-app-server": "faithful",
    "claude": "cross_plane",
    "opencode": "faithful",
    "cursor": "faithful",
    "grok": "faithful",
    "clawwork": "synthetic",
    "http": "cross_plane",
    "gemini": "faithful",
    "anthropic": "faithful",
    "anthropic-agent": "faithful",
}


def test_probed_backend_static_class_matrix() -> None:
    # Lock the exact expected static class of every probed backend, and that the
    # matrix stays in lockstep with the prober set (a new prober without an
    # expected entry fails — forcing a reviewed classification).
    from superclaw.model_discovery import _PROBERS

    assert set(_PROBERS) == set(_EXPECTED_DISCOVERY_CLASS), (
        "prober set and expected-class matrix drifted; classify the new/removed backend"
    )
    for name, expected in _EXPECTED_DISCOVERY_CLASS.items():
        actual = AGENT_CONTROL_SPECS.get(name, {}).get("discovery_reachability")
        assert actual == expected, f"{name}: expected discovery_reachability={expected!r}, got {actual!r}"


def test_codex_faithfulness_is_capability_conditioned(monkeypatch) -> None:
    # A legacy codex runs delivery fine but exposes no app-server model/list, so
    # its discovery would false-fail. The backend must refine its faithfulness to
    # cross_plane in legacy mode → the probe degrades to PRESENT, never a false
    # runtime_fail. And discovery must not even be called in that case.
    from superclaw.runtime_probe import discovery_reachability_class

    class _CodexLike:
        name = "codex"

        def __init__(self, mode: str) -> None:
            self._mode = mode
            self.run_calls = 0

        def available(self) -> BackendAvailability:
            return BackendAvailability(name="codex", available=True, executable="/bin/codex", version=f"codex ({self._mode})")

        def resolve_discovery_reachability(self) -> str:
            return "faithful" if self._mode == "exec" else "cross_plane"

        def run(self, *_a, **_k):
            self.run_calls += 1
            raise AssertionError("probe must never run the agent loop")

    legacy = _CodexLike("legacy")
    assert discovery_reachability_class("codex", legacy) == "cross_plane"

    def _explode(*_a, **_k):
        raise AssertionError("discovery must be skipped for a legacy (cross_plane) codex")

    monkeypatch.setattr(runtime_probe, "discover_models", _explode)
    res = probe_backend("codex", backends={"codex": legacy})
    assert res.verdict is ProbeVerdict.RUNTIME_PRESENT

    # And an exec-capable codex stays faithful (the static spec also says faithful).
    assert discovery_reachability_class("codex", _CodexLike("exec")) == "faithful"


def test_faithful_api_backends_satisfy_their_prober_contract() -> None:
    # "declaration TRUE to implementation", not just "declaration present": the
    # API-plane probers (_probe_anthropic / _probe_gemini) read base_url +
    # _resolve_api_key OFF THE REAL BACKEND. A backend declared faithful but
    # missing them would structurally false-fail every probe (the anthropic R5
    # bug). Exercise the REAL default_backends() objects so spec/impl drift is
    # caught at merge, not in production.
    from superclaw.backends import default_backends

    backends = default_backends()
    for name in ("gemini", "anthropic", "anthropic-agent"):
        if AGENT_CONTROL_SPECS.get(name, {}).get("discovery_reachability") != "faithful":
            continue
        backend = backends[name]
        assert getattr(backend, "base_url", None), (
            f"{name}: declared faithful but its real backend exposes no base_url for the API-plane prober"
        )
        assert callable(getattr(backend, "_resolve_api_key", None)), (
            f"{name}: declared faithful but its real backend exposes no _resolve_api_key"
        )


def test_real_codex_app_server_capability_gates_faithfulness(monkeypatch) -> None:
    # exec-capable is NOT app-server-ready: codex discovery uses the app-server
    # model/list, so an exec codex whose app-server is broken/unsupported must
    # resolve to cross_plane (probe degrades to present), never a false fail.
    import superclaw.backends as backends_mod
    from superclaw.backends import CodexCliBackend

    codex = CodexCliBackend(executable="/bin/codex")

    monkeypatch.setattr(backends_mod, "codex_cli_mode", lambda _e: "exec")
    monkeypatch.setattr(backends_mod, "check_codex_app_server_binary", lambda _e: (True, "ok"))
    assert codex.resolve_discovery_reachability() == "faithful"

    monkeypatch.setattr(backends_mod, "check_codex_app_server_binary", lambda _e: (False, "no app-server"))
    assert codex.resolve_discovery_reachability() == "cross_plane"

    monkeypatch.setattr(backends_mod, "codex_cli_mode", lambda _e: "legacy")
    assert codex.resolve_discovery_reachability() == "cross_plane"


def test_real_codex_backend_exposes_capability_hook() -> None:
    # Nail the real CodexCliBackend hook (not just the _CodexLike fake): the
    # capability refinement must exist on the shipped backend and return a valid
    # class, so the codex legacy/exec split can never silently regress.
    from superclaw.backends import default_backends

    codex = default_backends()["codex"]
    resolver = getattr(codex, "resolve_discovery_reachability", None)
    assert callable(resolver), "real CodexCliBackend must expose resolve_discovery_reachability"
    assert resolver() in {"faithful", "cross_plane"}


def test_relay_package_backends_are_never_faithful() -> None:
    # Cross-check the relay invariant: a relay-package backend's discovery is the
    # synthetic fail-safe floor, so it can NEVER be declared faithful — even if a
    # future relay backend forgets, this catches it.
    for name, spec in AGENT_CONTROL_SPECS.items():
        if spec.get("uses_relay_packages"):
            assert spec.get("discovery_reachability") == "synthetic", (
                f"relay-package backend {name!r} must be discovery_reachability=synthetic"
            )


def test_force_refresh_is_threaded_to_discovery(monkeypatch) -> None:
    seen: dict[str, bool] = {}

    def _fake_discover(backend_name, *, backends=None, force_refresh=False):  # noqa: ANN001
        seen["force_refresh"] = force_refresh
        return ModelCatalog(backend=backend_name, source="live", models=["m"])

    monkeypatch.setattr(runtime_probe, "discover_models", _fake_discover)
    probe_backend("fake", backends={"fake": _FakeBackend("fake")}, force_refresh=True)
    assert seen["force_refresh"] is True
