from __future__ import annotations

import json

import pytest

import superclaw.model_discovery as md
from superclaw.model_discovery import ModelCatalog, discover_models, live_capable_backends


@pytest.fixture(autouse=True)
def _fresh_catalog_cache():
    md.clear_catalog_cache()
    yield
    md.clear_catalog_cache()


class _CliBackend:
    def __init__(self, executable="/usr/bin/fake"):
        self._executable = executable

    def _resolve_executable(self):
        return self._executable


def test_static_fallback_for_backends_without_live_channel():
    # hermes has no headless model-listing channel: the catalog must be the
    # static contract hints, honestly marked as such.
    catalog = discover_models("hermes", backends={})
    assert catalog.source == "static"
    assert catalog.models  # contract hints offered
    assert catalog.error is None


def test_unknown_backend_degrades_to_static_with_error():
    catalog = discover_models("opencode", backends={})
    assert catalog.source == "static"
    assert catalog.error and "unknown backend" in catalog.error


def test_live_probe_success_marks_source_live(monkeypatch):
    def fake_run(command, **kwargs):
        class R:
            returncode = 0
            stdout = "provider/model-a\nprovider/model-b\nnot a model line\n"
            stderr = ""

        return R()

    monkeypatch.setattr(md.subprocess, "run", fake_run)
    catalog = discover_models("opencode", backends={"opencode": _CliBackend()})
    assert catalog.source == "live"
    assert catalog.models == ["provider/model-a", "provider/model-b"]


def test_live_probe_failure_degrades_to_static_with_error(monkeypatch):
    def fake_run(command, **kwargs):
        class R:
            returncode = 1
            stdout = ""
            stderr = "boom: not logged in"

        return R()

    monkeypatch.setattr(md.subprocess, "run", fake_run)
    catalog = discover_models("grok", backends={"grok": _CliBackend()})
    assert catalog.source == "static"
    assert catalog.error and "boom" in catalog.error
    assert catalog.models  # static hints still offered


def test_grok_output_parsing(monkeypatch):
    def fake_run(command, **kwargs):
        class R:
            returncode = 0
            stdout = (
                "You are logged in with grok.com.\n\n"
                "Default model: grok-build\n\n"
                "Available models:\n"
                "  - grok-composer-2.5-fast\n"
                "  * grok-build (default)\n"
            )
            stderr = ""

        return R()

    monkeypatch.setattr(md.subprocess, "run", fake_run)
    catalog = discover_models("grok", backends={"grok": _CliBackend()})
    assert catalog.source == "live"
    assert catalog.models == ["grok-composer-2.5-fast", "grok-build"]


def test_clawwork_lists_super_packages_not_raw_models(monkeypatch):
    # clawwork is relay-backed: its catalog is the relay's super-group PACKAGES
    # (套餐 ids), NOT the relay's raw /v1/models. The probe rides the kernel
    # relay_packages() — the same source as /api/relay/packages & CLI relay packages.
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {
            "packages": [
                {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
                {"id": "plus", "name": "Plus", "tier": "plus", "group_slug": "superclaw-plus"},
            ],
            "source": "catalog",
            "available": True,
        },
    )
    catalog = discover_models("clawwork", backends={"clawwork": object()})
    assert catalog.source == "live"
    # package ids, never raw model ids
    assert catalog.models == ["core", "plus"]


def test_clawwork_falls_back_to_default_tiers(monkeypatch):
    # relay_packages() is fail-safe: when the relay exposes no dynamic catalog it
    # yields the default tier floor — clawwork discovery still lists packages,
    # never raw models, never an error.
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    catalog = discover_models("clawwork", backends={"clawwork": object()})
    assert catalog.source == "live"
    assert catalog.models == ["core", "plus", "max"]


def test_live_capable_backends_cover_expected_channels():
    capable = live_capable_backends()
    for name in ("opencode", "cursor", "grok", "clawwork", "http", "gemini", "anthropic", "anthropic-agent"):
        assert name in capable, name


def test_catalog_serializes_to_json():
    payload = ModelCatalog(backend="x", models=["a"], source="live").to_dict()
    assert json.loads(json.dumps(payload)) == payload


def test_claude_live_via_anthropic_api_when_key_present(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("SUPERCLAW_ANTHROPIC_BASE_URL", "https://anthropic-proxy.example")
    monkeypatch.delenv("SUPERCLAW_ANTHROPIC_API_KEY", raising=False)
    seen = {}

    def fake_get(url, headers=None):
        seen["url"] = url
        seen["headers"] = dict(headers or {})
        return {"data": [{"id": "claude-fable-5"}, {"id": "claude-opus-4-8"}]}

    monkeypatch.setattr(md, "_http_get_json", fake_get)
    catalog = discover_models("claude", backends={"claude": object()})
    assert catalog.source == "live"
    # The API returns fable verbatim, but the curation denylist strips it from the
    # LIVE catalog too — a key-configured user must not see it in the selector.
    assert catalog.models == ["claude-opus-4-8"]
    assert seen["url"] == "https://anthropic-proxy.example/v1/models?limit=100"
    assert seen["headers"].get("x-api-key") == "k"


class _AnthropicBackend:
    base_url = "https://api.anthropic.example"
    ANTHROPIC_VERSION = "2023-06-01"

    def _resolve_api_key(self):
        return "k"


@pytest.mark.parametrize("backend_name", ["anthropic", "anthropic-agent"])
def test_anthropic_family_live_catalog_curates_fable(monkeypatch, backend_name):
    """anthropic / anthropic-agent both ride _probe_anthropic against the same
    Anthropic /v1/models plane, so the denylist must strip fable from their LIVE
    catalogs too (not just claude)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(
        md,
        "_http_get_json",
        lambda url, headers=None: {"data": [{"id": "claude-fable-5"}, {"id": "claude-opus-4-8"}]},
    )
    catalog = discover_models(backend_name, backends={backend_name: _AnthropicBackend()})
    assert catalog.source == "live"
    assert "claude-fable-5" not in catalog.models
    assert "claude-opus-4-8" in catalog.models


def test_claude_without_api_key_falls_back_to_static_honestly(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("SUPERCLAW_ANTHROPIC_API_KEY", raising=False)
    catalog = discover_models("claude", backends={"claude": object()})
    assert catalog.source == "static"
    # Curated static hints: the 4.X coding family, fable intentionally excluded.
    assert "claude-opus-4-8" in catalog.models
    assert "claude-fable-5" not in catalog.models
    assert catalog.error and "ANTHROPIC_API_KEY" in catalog.error


def test_catalog_cache_hit_and_force_refresh(monkeypatch):
    md.clear_catalog_cache()
    calls = {"n": 0}

    def fake_run(command, **kwargs):
        calls["n"] += 1

        class R:
            returncode = 0
            stdout = "provider/model-a\n"
            stderr = ""

        return R()

    monkeypatch.setattr(md.subprocess, "run", fake_run)
    backends = {"opencode": _CliBackend()}

    first = discover_models("opencode", backends=backends)
    assert first.source == "live" and first.cached is False and calls["n"] == 1

    second = discover_models("opencode", backends=backends)
    assert second.cached is True and second.models == ["provider/model-a"]
    assert calls["n"] == 1  # served from the kernel cache, no second probe

    third = discover_models("opencode", backends=backends, force_refresh=True)
    assert third.cached is False and calls["n"] == 2  # refresh bypasses


def test_failed_probe_uses_short_negative_ttl(monkeypatch):
    md.clear_catalog_cache()
    calls = {"n": 0}

    def fake_run(command, **kwargs):
        calls["n"] += 1

        class R:
            returncode = 1
            stdout = ""
            stderr = "not logged in"

        return R()

    monkeypatch.setattr(md.subprocess, "run", fake_run)
    backends = {"grok": _CliBackend()}

    first = discover_models("grok", backends=backends)
    assert first.source == "static" and calls["n"] == 1
    assert first.error and first.error.startswith("auth:")  # classified

    cached = discover_models("grok", backends=backends)
    assert cached.cached is True and calls["n"] == 1

    # simulate the negative TTL elapsing: backdate the cache entry
    with md._CACHE_LOCK:
        key, (ts, cat) = next(iter(md._CACHE.items()))
        md._CACHE[key] = (ts - md.NEGATIVE_CACHE_TTL_SECONDS - 1, cat)
    again = discover_models("grok", backends=backends)
    assert again.cached is False and calls["n"] == 2  # re-probed quickly


def test_cache_key_invalidates_on_credential_change(monkeypatch):
    md.clear_catalog_cache()
    monkeypatch.setenv("SUPERCLAW_RELAY_BASE_URL", "https://relay-a.example/v1")
    monkeypatch.setenv("SUPERCLAW_RELAY_API_KEY", "key-a")
    calls = {"n": 0}

    # clawwork probes the kernel relay_packages() (super packages), so count THOSE
    # calls. The fingerprint folds the relay key in, so rotating it must re-probe.
    import superclaw.relay_packages as rp

    def fake_packages():
        calls["n"] += 1
        return {"packages": [{"id": "plus", "name": "plus", "tier": "plus", "group_slug": "superclaw-plus"}],
                "source": "catalog", "available": True}

    monkeypatch.setattr(rp, "relay_packages", fake_packages)
    backends = {"clawwork": object()}

    a = discover_models("clawwork", backends=backends)
    assert a.models == ["plus"] and calls["n"] == 1
    assert discover_models("clawwork", backends=backends).cached is True

    monkeypatch.setenv("SUPERCLAW_RELAY_API_KEY", "key-b")  # credential changed
    b = discover_models("clawwork", backends=backends)
    assert b.cached is False and calls["n"] == 2  # new fingerprint -> re-probe


def test_network_error_classified(monkeypatch):
    md.clear_catalog_cache()
    import urllib.error

    # Use an HTTP-probing backend (http) whose probe really hits the network, so a
    # transport failure is classified. (clawwork is now fail-safe via relay_packages
    # and never surfaces a network error — see test_clawwork_* above.)
    def fake_get(url, headers=None):
        raise urllib.error.URLError("unreachable")

    monkeypatch.setattr(md, "_http_get_json", fake_get)
    monkeypatch.setenv("SUPERCLAW_HTTP_URL", "https://http-backend.example/v1/chat/completions")
    catalog = discover_models("http", backends={"http": object()})
    assert catalog.error and catalog.error.startswith("network:")


def test_codex_live_via_app_server_model_list(monkeypatch):
    # codex probes its own app-server protocol (ChatGPT-subscription plane) —
    # NOT the OpenAI Platform API (advisors: separate credential plane).
    import io

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = io.StringIO(
                '{"jsonrpc":"2.0","id":1,"result":{}}\n'
                '{"jsonrpc":"2.0","id":2,"result":{"data":['
                '{"id":"gpt-5.5","displayName":"GPT-5.5","hidden":false,"isDefault":true},'
                '{"id":"gpt-5.4","displayName":"GPT-5.4","hidden":false},'
                '{"id":"secret-model","hidden":true}]}}\n'
            )

        def kill(self):
            pass

    monkeypatch.setattr(md.subprocess, "Popen", lambda *a, **k: FakeProc())
    catalog = discover_models("codex", backends={"codex": _CliBackend()})
    assert catalog.source == "live"
    assert catalog.models == ["gpt-5.5", "gpt-5.4"]  # hidden filtered out
