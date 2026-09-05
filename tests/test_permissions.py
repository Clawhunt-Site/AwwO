"""Unit tests for the permission mode contract module (no backend wiring)."""

from __future__ import annotations

import pytest

from superclaw.permissions import (
    PRESET_LABELS,
    PRESET_TO_MODE,
    REQUIRED_PRESETS,
    PresetRealization,
    check_preset_map,
    make_presets,
    permission_mode_contract,
    posture_denies_tool,
    posture_for_mode,
    serialize_preset_map,
)


def _valid_map():
    return make_presets(
        ask=PresetRealization(native="x", interactive=False, note_key="k.ask"),
        allow=PresetRealization(native="y", interactive=False, note_key="k.allow"),
    )


def test_two_presets_only():
    assert REQUIRED_PRESETS == frozenset({"ask", "allow"})
    assert set(PRESET_LABELS) == {"ask", "allow"}
    # Max-permission doctrine (owner decision 2026-06-22): the runtime is a pure
    # execution engine handed its max permission, so BOTH presets map to
    # bypassPermissions. Governance moves to SuperClaw's upper layer; low-trust
    # runs stay floored read-only by ContainmentPolicy, independent of the preset.
    assert PRESET_TO_MODE == {"ask": "bypassPermissions", "allow": "bypassPermissions"}


def test_check_preset_map_accepts_valid():
    check_preset_map("demo", _valid_map())  # no raise


@pytest.mark.parametrize(
    "bad",
    [
        {"ask": PresetRealization("x", False, "k")},  # missing allow
        {
            "ask": PresetRealization("x", False, "k"),
            "allow": PresetRealization("", False, "k"),  # empty native
        },
        {
            "ask": PresetRealization("x", False, ""),  # empty note_key
            "allow": PresetRealization("y", False, "k"),
        },
    ],
)
def test_check_preset_map_rejects_gaps(bad):
    with pytest.raises(ValueError):
        check_preset_map("demo", bad)


def test_posture_mapping():
    assert posture_for_mode("plan") == "readonly"
    assert posture_for_mode("default") == "workspace"
    assert posture_for_mode("acceptEdits") == "workspace"
    assert posture_for_mode("auto") == "workspace"
    assert posture_for_mode("bypassPermissions") == "full"
    assert posture_for_mode("dontAsk") == "full"
    assert posture_for_mode(None) == "workspace"


def test_posture_denies_only_mutating_under_readonly():
    assert posture_denies_tool("readonly", "write_file") is True
    assert posture_denies_tool("readonly", "run_shell") is True
    assert posture_denies_tool("readonly", "read_file") is False
    assert posture_denies_tool("readonly", "list_files") is False
    # non-readonly postures never deny
    assert posture_denies_tool("workspace", "write_file") is False
    assert posture_denies_tool("full", "run_shell") is False


def test_serialize_and_contract():
    payload = serialize_preset_map(_valid_map())
    assert payload["ask"] == {"native": "x", "interactive": False, "note_key": "k.ask", "preset_driven": True}
    contract = permission_mode_contract()
    assert sorted(contract["presets"]) == ["allow", "ask"]
    assert contract["preset_to_mode"]["allow"] == "bypassPermissions"
    assert contract["preset_to_mode"]["ask"] == "bypassPermissions"
