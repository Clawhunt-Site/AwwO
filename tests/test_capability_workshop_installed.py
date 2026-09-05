"""Kernel read/uninstall of Node-S4-landed capabilities (loopback)."""

from __future__ import annotations

from typing import Any

import pytest

import superclaw.capability_workshop_installed as mod
from superclaw.capability_workshop_installed import (
    WorkshopInstalledReadError,
    list_installed_node_capabilities,
    uninstall_node_capability,
)


class _Resp:
    def __init__(self, status_code: int, payload: Any = None):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _node(monkeypatch, base="http://127.0.0.1:3100"):
    monkeypatch.setattr(mod, "resolve_node_base_url", lambda explicit=None: base)


# ------------------------------------------------------------------ list


def test_list_includes_only_official_workshop_installs(monkeypatch):
    # /api/super-plugins is the UNIFIED runtime catalog (super + native JS). Only official=true
    # (workshop-cosigned, super-format, uninstallable) entries are surfaced; native JS plugins
    # (official=false) and the un-uninstallable mismatch are dropped. Raw runtime kind
    # ("super"/"paperclip_js") is normalized to the capability kind "plugin".
    _node(monkeypatch)
    payload = [
        {"pluginKey": "acme.tool", "kind": "super", "name": "Acme", "version": "1.0.0", "official": True},
        {"pluginKey": "native.js", "kind": "paperclip_js", "name": "JS", "version": "2.0.0", "official": False},
        # STALE official provenance on a JS plugin: official=true but NOT super → not removable
        # via DELETE /api/super-plugins → must be dropped (official alone is insufficient).
        {"pluginKey": "stale.js", "kind": "paperclip_js", "name": "Stale", "version": "1.0.0", "official": True},
        {"pluginKey": "no.official", "kind": "super", "name": "N", "version": "1.0.0"},  # missing official → drop
        {"no_key": True, "kind": "super", "official": True},  # malformed → dropped
    ]
    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp(200, payload))
    caps, available = list_installed_node_capabilities()
    assert available is True
    assert caps == [
        {"origin": "node-workshop", "kind": "plugin", "capability_id": "acme.tool", "native_key": "acme.tool",
         "version": "1.0.0", "name": "Acme", "official": True, "configurable": False, "uninstallable": True},
    ]


def test_list_degraded_when_no_colaunched_node(monkeypatch):
    monkeypatch.setattr(mod, "resolve_node_base_url", lambda explicit=None: None)
    assert list_installed_node_capabilities() == ([], False)


def test_list_degraded_on_non_200(monkeypatch):
    _node(monkeypatch)
    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp(403))  # authenticated-mode loopback
    assert list_installed_node_capabilities() == ([], False)


def test_list_degraded_on_http_error(monkeypatch):
    _node(monkeypatch)

    def boom(*a, **k):
        raise mod.httpx.ConnectError("node down")

    monkeypatch.setattr(mod.httpx, "get", boom)
    assert list_installed_node_capabilities() == ([], False)


def test_list_degraded_on_non_list_body(monkeypatch):
    _node(monkeypatch)
    monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _Resp(200, {"not": "a list"}))
    assert list_installed_node_capabilities() == ([], False)


# ------------------------------------------------------------------ uninstall


def test_uninstall_success(monkeypatch):
    _node(monkeypatch)
    seen: dict = {}

    def fake_request(method, url, **k):
        seen.update(method=method, url=url)
        return _Resp(204)

    monkeypatch.setattr(mod.httpx, "request", fake_request)
    out = uninstall_node_capability("acme.tool")
    assert out == {"ok": True, "origin": "node-workshop", "native_key": "acme.tool"}
    assert seen["method"] == "DELETE"
    assert seen["url"].endswith("/api/super-plugins/acme.tool")


def test_uninstall_percent_encodes_key(monkeypatch):
    _node(monkeypatch)
    seen: dict = {}
    monkeypatch.setattr(mod.httpx, "request", lambda method, url, **k: seen.update(url=url) or _Resp(200))
    uninstall_node_capability("a/b evil")
    # No raw slash/space — can't inject a different route segment.
    assert seen["url"].endswith("/api/super-plugins/a%2Fb%20evil")


def test_uninstall_requires_native_key(monkeypatch):
    _node(monkeypatch)
    with pytest.raises(WorkshopInstalledReadError, match="native_key is required"):
        uninstall_node_capability("  ")


def test_uninstall_fails_closed_without_node(monkeypatch):
    monkeypatch.setattr(mod, "resolve_node_base_url", lambda explicit=None: None)
    with pytest.raises(WorkshopInstalledReadError, match="no co-launched Node"):
        uninstall_node_capability("acme.tool")


def test_uninstall_fails_closed_on_non_2xx(monkeypatch):
    _node(monkeypatch)
    monkeypatch.setattr(mod.httpx, "request", lambda method, url, **k: _Resp(404))
    with pytest.raises(WorkshopInstalledReadError, match="HTTP 404"):
        uninstall_node_capability("ghost")
