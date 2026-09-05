"""Multi-dimensional version contract — single source of truth (方向三 C1)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from superclaw.state import StateStore
from superclaw.version_contract import (
    API_CONTRACT_VERSION,
    DEFAULT_CHANNEL,
    PLUGIN_CONTRACT_VERSION,
    PROJECTION_SCHEMA_VERSION,
    build_version_contract,
    read_product_version,
    version_contract_payload,
)


def test_product_version_is_single_source():
    c = build_version_contract()
    assert c.product_version == read_product_version()
    assert c.cli_core == c.product_version  # cli_core == product_version invariant


def test_state_schema_tracks_store_single_source():
    # state_schema must equal the StateStore's authoritative SCHEMA_VERSION
    assert build_version_contract().state_schema == StateStore.SCHEMA_VERSION


def test_integer_contract_dimensions():
    c = build_version_contract()
    assert c.api_contract == API_CONTRACT_VERSION
    assert c.plugin_contract == PLUGIN_CONTRACT_VERSION
    assert c.projection_schema == PROJECTION_SCHEMA_VERSION


def test_plugin_contract_matches_schema_drift_guard():
    # Single-source enforcement: the runtime constant must equal the schema
    # document's x-superclaw-contract-version (the canonical source). This CI/dev
    # guard fails if they ever drift — runtime stays deployment-safe (constant).
    schema_path = Path(__file__).resolve().parents[1] / "schemas" / "superclaw-plugin.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema["x-superclaw-contract-version"] == PLUGIN_CONTRACT_VERSION


def test_optional_dims_none_on_pip_path(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_BUNDLED_CORE_VERSION", raising=False)
    monkeypatch.delenv("SUPERCLAW_DESKTOP_SHELL_VERSION", raising=False)
    c = build_version_contract()
    assert c.bundled_core is None
    assert c.desktop_shell is None


def test_shell_dims_injected_via_env(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_BUNDLED_CORE_VERSION", "0.2.0")
    monkeypatch.setenv("SUPERCLAW_DESKTOP_SHELL_VERSION", "0.3.0")
    c = build_version_contract()
    assert c.bundled_core == "0.2.0"
    assert c.desktop_shell == "0.3.0"


def test_shell_dim_arg_overrides_default(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_DESKTOP_SHELL_VERSION", raising=False)
    assert build_version_contract(desktop_shell="9.9.9").desktop_shell == "9.9.9"


def test_channel_default_and_validation(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_RELEASE_CHANNEL", raising=False)
    assert build_version_contract().channel == DEFAULT_CHANNEL
    assert build_version_contract(channel="stable").channel == "stable"
    # fail-closed: an invalid channel raises rather than silently routing to beta
    with pytest.raises(ValueError, match="invalid release channel"):
        build_version_contract(channel="bogus")


def test_payload_has_dimensions_and_fields():
    payload = version_contract_payload()
    assert payload["product_version"]
    assert "cli_core" in payload["dimensions"]
    assert "state_schema" in payload["dimensions"]
    assert payload["api_contract"] == API_CONTRACT_VERSION
