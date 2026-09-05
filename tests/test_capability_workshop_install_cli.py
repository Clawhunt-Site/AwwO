"""CLI surface for `capabilities workshop install` — the kernel/CLI baseline that downloads a
published capability and lands it via the co-launched Node S4 super-workshop (the API/Web
surfaces mirror this same `install_published_capability` bridge).

The bridge itself (download + cosign + R2 + digest + receipt + Node loopback) is covered by
tests/test_capability_workshop_install_bridge.py; here we only assert the CLI wiring: identity
pass-through, the kernel-envelope JSON shape (emitted verbatim, not re-wrapped), the human
output, and fail-closed exit codes.
"""

from __future__ import annotations

import json

from typer.testing import CliRunner

import superclaw.capability_workshop_install_bridge as bridge
import superclaw.capability_workshop_installed as installed
from superclaw.cli import app

runner = CliRunner()


def _envelope(kind: str, capability_id: str, version: str, *, native_id: str = "n_1") -> dict:
    """The real shape `install_published_capability` returns (kernel envelope with a NESTED
    Node `outcome`) — mirroring it here is what keeps the test honest about the contract."""
    return {
        "ok": True,
        "kind": kind,
        "capability_id": capability_id,
        "version": version,
        "package_digest": "sha256:" + "ab" * 32,
        "outcome": {
            "kind": kind,
            "capabilityId": capability_id,
            "version": version,
            "nativeId": native_id,
            "official": True,
        },
    }


def test_install_passes_identity_and_emits_kernel_envelope_verbatim(monkeypatch):
    captured: dict = {}

    def _fake(kind, capability_id, version, **kwargs):
        captured.update(kind=kind, capability_id=capability_id, version=version)
        return _envelope(kind, capability_id, version)

    monkeypatch.setattr(bridge, "install_published_capability", _fake)
    res = runner.invoke(
        app,
        ["capabilities", "workshop", "install", "skill.demo", "1.0.0", "--kind", "skill", "--json"],
    )
    assert res.exit_code == 0, res.output
    assert captured == {"kind": "skill", "capability_id": "skill.demo", "version": "1.0.0"}
    payload = json.loads(res.output)
    # Verbatim kernel envelope — not re-wrapped in another {ok, outcome}.
    assert payload == _envelope("skill", "skill.demo", "1.0.0")
    assert payload["outcome"]["nativeId"] == "n_1"


def test_install_human_output_reads_native_outcome(monkeypatch):
    monkeypatch.setattr(
        bridge, "install_published_capability", lambda k, c, v, **kw: _envelope(k, c, v, native_id="plug_42")
    )
    res = runner.invoke(app, ["capabilities", "workshop", "install", "acme.tool", "2.0.0"])
    assert res.exit_code == 0, res.output
    assert "installed plugin acme.tool@2.0.0" in res.output
    assert "nativeId=plug_42" in res.output
    assert "official=True" in res.output


def test_install_defaults_to_plugin_kind(monkeypatch):
    captured: dict = {}

    def _fake(kind, capability_id, version, **kwargs):
        captured["kind"] = kind
        return _envelope(kind, capability_id, version)

    monkeypatch.setattr(bridge, "install_published_capability", _fake)
    res = runner.invoke(app, ["capabilities", "workshop", "install", "acme.tool", "2.0.0", "--json"])
    assert res.exit_code == 0, res.output
    assert captured["kind"] == "plugin"


def test_install_fails_closed_with_exit_1(monkeypatch):
    def _boom(*a, **k):
        raise bridge.WorkshopInstallBridgeError("not officially co-signed")

    monkeypatch.setattr(bridge, "install_published_capability", _boom)
    res = runner.invoke(app, ["capabilities", "workshop", "install", "acme.tool", "1.0.0", "--json"])
    assert res.exit_code == 1
    payload = json.loads(res.output)
    assert payload["ok"] is False
    assert "co-signed" in payload["error"]


def test_install_fails_closed_human_output(monkeypatch):
    def _boom(*a, **k):
        raise bridge.WorkshopInstallBridgeError("no co-launched node")

    monkeypatch.setattr(bridge, "install_published_capability", _boom)
    res = runner.invoke(app, ["capabilities", "workshop", "install", "acme.tool", "1.0.0"])
    assert res.exit_code == 1
    assert "error: no co-launched node" in res.output


def test_installed_lists_node_capabilities(monkeypatch):
    caps = [
        {"origin": "node-workshop", "kind": "skill", "capability_id": "sk", "native_key": "sk",
         "version": "1.0.0", "name": "Sk", "official": True, "configurable": False, "uninstallable": True},
    ]
    monkeypatch.setattr(installed, "list_installed_node_capabilities", lambda **kw: (caps, True))
    res = runner.invoke(app, ["capabilities", "workshop", "installed", "--json"])
    assert res.exit_code == 0, res.output
    payload = json.loads(res.output)
    assert payload["node_available"] is True
    assert payload["capabilities"][0]["native_key"] == "sk"


def test_installed_reports_degraded(monkeypatch):
    monkeypatch.setattr(installed, "list_installed_node_capabilities", lambda **kw: ([], False))
    res = runner.invoke(app, ["capabilities", "workshop", "installed"])
    assert res.exit_code == 0, res.output
    assert "node_available=false" in res.output


def test_uninstall_node_capability_success(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        installed,
        "uninstall_node_capability",
        lambda native_key, **kw: seen.update(k=native_key) or {"ok": True, "origin": "node-workshop", "native_key": native_key},
    )
    res = runner.invoke(app, ["capabilities", "workshop", "uninstall", "acme.tool@1", "--json"])
    assert res.exit_code == 0, res.output
    assert seen["k"] == "acme.tool@1"
    assert json.loads(res.output)["ok"] is True


def test_uninstall_node_capability_fails_closed(monkeypatch):
    def boom(native_key, **kw):
        raise installed.WorkshopInstalledReadError("no co-launched Node")

    monkeypatch.setattr(installed, "uninstall_node_capability", boom)
    res = runner.invoke(app, ["capabilities", "workshop", "uninstall", "x", "--json"])
    assert res.exit_code == 1
    assert json.loads(res.output)["ok"] is False
