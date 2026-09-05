"""Neutral install endpoint ``POST /api/capabilities/install`` — the API mirror of the CLI
``capabilities workshop install``. Both call the same kernel bridge
``install_published_capability`` (download + cosign + R2 + digest + receipt + Node S4 landing),
so this only asserts the API wiring: identity pass-through, the kernel-envelope response
(verbatim, not re-wrapped), fail-closed -> 502, and request validation -> 422.
"""

from __future__ import annotations

import superclaw.capability_workshop_install_bridge as bridge
from fastapi.testclient import TestClient

from apps.api.main import create_app


def _client(tmp_path):
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _envelope(kind: str, capability_id: str, version: str) -> dict:
    return {
        "ok": True,
        "kind": kind,
        "capability_id": capability_id,
        "version": version,
        "package_digest": "sha256:" + "cd" * 32,
        "outcome": {
            "kind": kind,
            "capabilityId": capability_id,
            "version": version,
            "nativeId": "n_api",
            "official": True,
        },
    }


def test_install_passes_identity_and_returns_kernel_envelope(monkeypatch, tmp_path):
    captured: dict = {}

    def _fake(kind, capability_id, version, **kwargs):
        captured.update(kind=kind, capability_id=capability_id, version=version)
        return _envelope(kind, capability_id, version)

    monkeypatch.setattr(bridge, "install_published_capability", _fake)
    client = _client(tmp_path)
    r = client.post(
        "/api/capabilities/install",
        json={"capability_id": "skill.demo", "version": "1.0.0", "kind": "skill"},
    )
    assert r.status_code == 200, r.text
    assert captured == {"kind": "skill", "capability_id": "skill.demo", "version": "1.0.0"}
    # Verbatim kernel envelope (same shape the CLI emits) — not re-wrapped.
    assert r.json() == _envelope("skill", "skill.demo", "1.0.0")


def test_install_defaults_to_plugin_kind(monkeypatch, tmp_path):
    captured: dict = {}

    def _fake(kind, capability_id, version, **kwargs):
        captured["kind"] = kind
        return _envelope(kind, capability_id, version)

    monkeypatch.setattr(bridge, "install_published_capability", _fake)
    client = _client(tmp_path)
    r = client.post("/api/capabilities/install", json={"capability_id": "acme.tool", "version": "2.0.0"})
    assert r.status_code == 200, r.text
    assert captured["kind"] == "plugin"


def test_install_bridge_failure_is_502_generic_no_internal_leak(monkeypatch, tmp_path):
    # The raw bridge message can carry internal context (key-file path, R2/Node details); the
    # network response must stay generic — the detail must NOT echo the raw cause.
    secret_ish = "/home/user/.secrets/workshop_hmac.key is unreadable"

    def _boom(*a, **k):
        raise bridge.WorkshopInstallBridgeError(secret_ish)

    monkeypatch.setattr(bridge, "install_published_capability", _boom)
    client = _client(tmp_path)
    r = client.post("/api/capabilities/install", json={"capability_id": "acme.tool", "version": "1.0.0"})
    assert r.status_code == 502, r.text
    assert r.json()["detail"] == "workshop install failed"
    assert "secrets" not in r.text and "workshop_hmac" not in r.text


def test_install_rejects_bad_kind_and_missing_version(tmp_path):
    client = _client(tmp_path)
    bad_kind = client.post(
        "/api/capabilities/install",
        json={"capability_id": "acme.tool", "version": "1.0.0", "kind": "widget"},
    )
    assert bad_kind.status_code == 422
    missing_version = client.post("/api/capabilities/install", json={"capability_id": "acme.tool"})
    assert missing_version.status_code == 422
