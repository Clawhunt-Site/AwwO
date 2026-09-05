"""Neutral installed-union + origin-routed uninstall BFF.

``GET /api/capabilities/installed`` unions the legacy Python plugin cache with the Node S4
store (origin-tagged, node_available signal). ``POST /api/capabilities/uninstall`` routes by
origin to the cache or Node. The Node read/uninstall kernel is covered by
tests/test_capability_workshop_installed.py; here we assert the BFF wiring.
"""

from __future__ import annotations

import superclaw.capability_workshop_installed as node_installed
from fastapi.testclient import TestClient

from apps.api import main as api_main
from apps.api.main import create_app


def _client(tmp_path, monkeypatch, *, cache_plugins=None, node_caps=None, node_available=True):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "staging")
    # Cache side: stub the status payload the front door reads.
    monkeypatch.setattr(
        api_main, "build_plugin_status_payload", lambda **kwargs: {"plugins": cache_plugins or []}
    )
    # Node side: stub the loopback read.
    monkeypatch.setattr(
        node_installed,
        "list_installed_node_capabilities",
        lambda **kwargs: (list(node_caps or []), node_available),
    )
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _node_cap(native_key="acme.tool", kind="plugin", official=True):
    return {
        "origin": "node-workshop", "kind": kind, "capability_id": native_key, "native_key": native_key,
        "version": "1.0.0", "name": native_key, "official": official, "configurable": False, "uninstallable": True,
    }


def test_installed_unions_cache_and_node_origin_tagged(tmp_path, monkeypatch):
    cache = [{"id": "leg.plugin", "version": "0.9.0", "name": "Legacy", "skill_origin": False}]
    client = _client(tmp_path, monkeypatch, cache_plugins=cache, node_caps=[_node_cap()], node_available=True)
    body = client.get("/api/capabilities/installed").json()
    assert body["node_available"] is True
    by_origin = {c["origin"] for c in body["capabilities"]}
    assert by_origin == {"cache", "node-workshop"}
    cache_entry = next(c for c in body["capabilities"] if c["origin"] == "cache")
    assert cache_entry["kind"] == "plugin" and cache_entry["capability_id"] == "leg.plugin"
    assert cache_entry["configurable"] is True
    node_entry = next(c for c in body["capabilities"] if c["origin"] == "node-workshop")
    assert node_entry["native_key"] == "acme.tool" and node_entry["configurable"] is False


def test_installed_maps_cache_skill_origin_to_skill_kind(tmp_path, monkeypatch):
    cache = [{"id": "skill.demo", "version": "1.0.0", "name": "S", "skill_origin": True}]
    client = _client(tmp_path, monkeypatch, cache_plugins=cache, node_caps=[])
    body = client.get("/api/capabilities/installed").json()
    assert body["capabilities"][0]["kind"] == "skill"


def test_installed_degraded_when_node_unavailable(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, cache_plugins=[], node_caps=[], node_available=False)
    body = client.get("/api/capabilities/installed").json()
    assert body["node_available"] is False
    assert body["capabilities"] == []


def test_uninstall_cache_routes_to_cache(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(
        api_main,
        "uninstall_cached_plugin",
        lambda pid, **kw: seen.update(pid=pid, version=kw.get("version")) or {"plugin_id": pid, "removed": True},
    )
    client = _client(tmp_path, monkeypatch)
    r = client.post(
        "/api/capabilities/uninstall",
        json={"origin": "cache", "capability_id": "leg.plugin", "version": "0.9.0"},
    )
    assert r.status_code == 200, r.text
    assert seen == {"pid": "leg.plugin", "version": "0.9.0"}
    assert r.json()["origin"] == "cache"


def test_uninstall_node_routes_to_node_with_native_key(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(
        node_installed,
        "uninstall_node_capability",
        lambda native_key, **kw: seen.update(native_key=native_key) or {"ok": True, "origin": "node-workshop", "native_key": native_key},
    )
    client = _client(tmp_path, monkeypatch)
    r = client.post(
        "/api/capabilities/uninstall",
        json={"origin": "node-workshop", "capability_id": "acme.tool", "native_key": "acme.tool@1"},
    )
    assert r.status_code == 200, r.text
    assert seen["native_key"] == "acme.tool@1"  # native_key preferred over capability_id


def test_uninstall_failure_is_502_generic(tmp_path, monkeypatch):
    def boom(native_key, **kw):
        raise node_installed.WorkshopInstalledReadError("node down at https://internal/secret")

    monkeypatch.setattr(node_installed, "uninstall_node_capability", boom)
    client = _client(tmp_path, monkeypatch)
    r = client.post("/api/capabilities/uninstall", json={"origin": "node-workshop", "capability_id": "x"})
    assert r.status_code == 502
    assert r.json()["detail"] == "uninstall failed"
    assert "internal/secret" not in r.text


def test_uninstall_rejects_unknown_origin(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    r = client.post("/api/capabilities/uninstall", json={"origin": "elsewhere", "capability_id": "x"})
    assert r.status_code == 422
