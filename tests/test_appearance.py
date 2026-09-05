"""Tests for the kernel appearance / color-scheme module + its API surface.

The kernel is the single source of truth; these lock down (a) fail-closed validation
of presets and custom colors, (b) the lock+atomic persistence, (c) round-trippable
import/export, and (d) the CLI/API surfaces reading the same kernel functions.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw import appearance as a


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    # Pin the appearance file under a hermetic temp root so tests never touch a real
    # ~/.superclaw/appearance.json and never collide with each other.
    monkeypatch.setenv("SUPERCLAW_APPEARANCE_CONFIG_PATH", str(tmp_path / "appearance.json"))
    return tmp_path


def test_default_config_when_missing():
    cfg = a.load_appearance_config()
    assert cfg["active_preset"] == a.DEFAULT_PRESET_ID
    assert cfg["custom"] == {"light": {}, "dark": {}}


def test_contract_lists_presets_and_tokens():
    contract = a.build_appearance_contract()
    ids = [p["id"] for p in contract["presets"]]
    assert a.DEFAULT_PRESET_ID in ids
    assert "emerald" in ids
    # Every preset override only touches whitelisted token ids (no drift).
    token_ids = {t["id"] for t in contract["tokens"]}
    for preset in contract["presets"]:
        for canvas in ("light", "dark"):
            assert set(preset["overrides"][canvas]).issubset(token_ids)


def test_set_active_preset_persists_and_rejects_unknown():
    a.set_active_preset("emerald")
    assert a.appearance_payload()["active_preset"] == "emerald"
    with pytest.raises(ValueError):
        a.set_active_preset("does-not-exist")


def test_set_custom_color_normalizes_and_switches_to_custom():
    a.set_custom_color("dark", "accent", "#ABC")  # shorthand expands + lowercases
    payload = a.appearance_payload()
    assert payload["active_preset"] == a.CUSTOM_PRESET_ID
    assert payload["custom"]["dark"]["accent"] == "#aabbcc"


@pytest.mark.parametrize("bad", ["nothex", "#12", "rgb(0,0,0)", "", "#1234567"])
def test_set_custom_color_rejects_bad_hex(bad):
    with pytest.raises(ValueError):
        a.set_custom_color("light", "accent", bad)


def test_set_custom_color_rejects_unknown_token_and_canvas():
    with pytest.raises(ValueError):
        a.set_custom_color("light", "not-a-token", "#ffffff")
    with pytest.raises(ValueError):
        a.set_custom_color("sepia", "accent", "#ffffff")


def test_set_custom_color_merges_without_clobbering():
    # Two token edits on the same canvas must both survive — the lost-update class the
    # atomic per-token merge defends against (vs a whole-map replace from stale state).
    a.set_custom_color("dark", "accent", "#111111")
    a.set_custom_color("dark", "bg_base", "#222222")
    custom = a.appearance_payload()["custom"]["dark"]
    assert custom == {"accent": "#111111", "bg_base": "#222222"}


def test_reset_clears_custom():
    a.set_custom_color("light", "accent", "#123456")
    a.reset_appearance()
    payload = a.appearance_payload()
    assert payload["active_preset"] == a.DEFAULT_PRESET_ID
    assert payload["custom"] == {"light": {}, "dark": {}}


def test_export_import_roundtrip():
    a.set_active_preset("amber")
    a.set_custom_color("dark", "bg_base", "#000000")
    bundle = a.build_appearance_export()
    assert bundle["kind"] == a.EXPORT_KIND
    a.reset_appearance()
    config, warnings = a.import_appearance_bundle(bundle)
    assert warnings == []
    # set_custom_color flipped active to custom; the bundle preserves that.
    assert config["active_preset"] == a.CUSTOM_PRESET_ID
    assert config["custom"]["dark"]["bg_base"] == "#000000"


def test_import_drops_junk_with_warnings():
    config, warnings = a.import_appearance_bundle(
        {
            "kind": a.EXPORT_KIND,
            "active_preset": "custom",
            "custom": {"light": {"accent": "#fff", "bogus": "#000", "warn": "nope"}},
        }
    )
    assert config["custom"]["light"] == {"accent": "#ffffff"}
    assert any("bogus" in w for w in warnings)
    assert any("warn" in w for w in warnings)


def test_import_rejects_non_dict_and_wrong_kind():
    with pytest.raises(ValueError):
        a.import_appearance_bundle("not a dict")
    with pytest.raises(ValueError):
        a.import_appearance_bundle({"kind": "something-else"})


def test_import_unknown_preset_falls_back_with_warning():
    config, warnings = a.import_appearance_bundle({"active_preset": "from-the-future", "custom": {}})
    assert config["active_preset"] == a.DEFAULT_PRESET_ID
    assert any("from-the-future" in w for w in warnings)


def test_corrupt_config_file_falls_back_to_default():
    a.appearance_config_path().write_text("{ not json", encoding="utf-8")
    cfg = a.load_appearance_config()
    assert cfg["active_preset"] == a.DEFAULT_PRESET_ID


# --- API surface -----------------------------------------------------------------


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    return TestClient(app), {"X-SuperClaw-Token": "secret-control"}


def test_api_requires_control_token(tmp_path, monkeypatch):
    client, _headers = _client(tmp_path, monkeypatch)
    assert client.get("/api/appearance").status_code == 401


def test_api_get_set_export_import(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch)

    got = client.get("/api/appearance", headers=headers)
    assert got.status_code == 200, got.text
    assert got.json()["active_preset"] == a.DEFAULT_PRESET_ID

    setres = client.post(
        "/api/appearance/set",
        headers=headers,
        json={"active_preset": "custom", "custom": {"light": {"accent": "#10b981"}}},
    )
    assert setres.status_code == 200, setres.text
    assert setres.json()["custom"]["light"]["accent"] == "#10b981"
    assert setres.json()["warnings"] == []

    exported = client.get("/api/appearance/export", headers=headers)
    assert exported.status_code == 200
    bundle = exported.json()
    assert bundle["custom"]["light"]["accent"] == "#10b981"

    # Reset, then import the bundle back.
    client.post("/api/appearance/set", headers=headers, json={"active_preset": "default"})
    imported = client.post("/api/appearance/import", headers=headers, json={"bundle": bundle})
    assert imported.status_code == 200, imported.text
    assert imported.json()["active_preset"] == a.CUSTOM_PRESET_ID


def test_api_custom_color_atomic_merge(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch)
    first = client.post(
        "/api/appearance/custom-color",
        headers=headers,
        json={"canvas": "dark", "token": "accent", "color": "#111111"},
    )
    assert first.status_code == 200, first.text
    assert first.json()["active_preset"] == a.CUSTOM_PRESET_ID
    second = client.post(
        "/api/appearance/custom-color",
        headers=headers,
        json={"canvas": "dark", "token": "bg_base", "color": "#222222"},
    )
    assert second.status_code == 200, second.text
    # Both edits survive — the endpoint merges one token at a time, no clobber.
    assert second.json()["custom"]["dark"] == {"accent": "#111111", "bg_base": "#222222"}


def test_api_custom_color_rejects_bad_input(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch)
    res = client.post(
        "/api/appearance/custom-color",
        headers=headers,
        json={"canvas": "dark", "token": "accent", "color": "nothex"},
    )
    assert res.status_code == 400


def test_api_set_rejects_unknown_preset(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch)
    res = client.post("/api/appearance/set", headers=headers, json={"active_preset": "nope"})
    assert res.status_code == 400


def test_api_import_rejects_wrong_kind(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch)
    res = client.post(
        "/api/appearance/import",
        headers=headers,
        json={"bundle": {"kind": "not-appearance"}},
    )
    assert res.status_code == 400
