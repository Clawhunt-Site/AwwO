"""Field-level UI schema contract for runtime config entries (settings-redesign PR-5a).

The kernel is the single source of truth for how each runtime config value is
edited; every surface renders from `entries[].ui` instead of hardcoding
per-field widgets. These tests pin that contract.
"""

from __future__ import annotations

import os

import pytest

from superclaw.runtime_config import (
    RUNTIME_CONFIG_UI_SECTIONS,
    RUNTIME_CONFIG_UI_TYPES,
    RuntimeConfigSpec,
    runtime_config_payload,
    runtime_config_specs,
    runtime_config_ui_descriptor,
    set_runtime_config,
)


def test_every_entry_carries_a_valid_ui_descriptor(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    payload = runtime_config_payload()
    assert payload["ui_sections"] == list(RUNTIME_CONFIG_UI_SECTIONS)
    assert payload["entries"], "payload must expose entries"
    for entry in payload["entries"]:
        ui = entry["ui"]
        assert ui["type"] in RUNTIME_CONFIG_UI_TYPES, entry["name"]
        assert ui["section"] in RUNTIME_CONFIG_UI_SECTIONS, entry["name"]
        if ui["choices"] is not None:
            assert isinstance(ui["choices"], list) and ui["choices"], entry["name"]


def test_secret_specs_render_as_secret_and_never_persist():
    for name, spec in runtime_config_specs().items():
        if spec.secret:
            ui = runtime_config_ui_descriptor(spec)
            assert ui["type"] == "secret", name
            assert spec.persist_allowed is False, name


def test_mode_is_a_kernel_enforced_select():
    spec = runtime_config_specs()["mode"]
    ui = runtime_config_ui_descriptor(spec)
    assert ui["type"] == "select"
    assert ui["choices"] == ["auto", "chat", "delivery"]
    assert ui["section"] == "basic"


def test_app_env_is_not_a_runtime_config_entry():
    """APP_ENV is a compile-time build identity baked into the bundle, never a runtime
    config entry — it must not be surfaced, persisted, or editable through settings."""
    specs = runtime_config_specs()
    assert "APP_ENV" not in specs
    payload = runtime_config_payload()
    assert all(entry["name"] != "APP_ENV" for entry in payload["entries"])
    assert "APP_ENV" not in payload["writable_names"]


def test_executables_are_basic_path_fields():
    for name, spec in runtime_config_specs().items():
        if name.endswith("_EXECUTABLE"):
            ui = runtime_config_ui_descriptor(spec)
            assert ui["type"] == "path", name
            assert ui["section"] == "basic", name


def test_boolean_and_number_fields_have_dedicated_controls():
    specs = runtime_config_specs()
    for name in (
        "SUPERCLAW_HTTP_ALLOW_PRIVATE",
        "SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE",
        "SUPERCLAW_AUTO_PROJECT_PLUGINS",
        "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST",
    ):
        assert runtime_config_ui_descriptor(specs[name])["type"] == "toggle", name
    for name in (
        "SUPERCLAW_CODEX_APP_SERVER_POST_TOOL_TIMEOUT_SECONDS",
        "SUPERCLAW_GEMINI_MAX_ITERATIONS",
        "SUPERCLAW_GEMINI_MAX_TOKENS",
    ):
        assert runtime_config_ui_descriptor(specs[name])["type"] == "number", name
    # the run-budget sentinel keeps this one a text field on purpose
    assert runtime_config_ui_descriptor(specs["SUPERCLAW_HTTP_TIMEOUT_SEC"])["type"] == "text"


def test_url_fields_derive_url_type():
    specs = runtime_config_specs()
    # Neither ClawHunt nor RunningHub carries a static localhost default: ClawHunt is
    # resolved per-environment from APP_ENV, and RunningHub falls back to its localhost
    # dev mock only when running from source (fail-closed in a bundle). Advertising a
    # localhost default the kernel would not actually use in a bundle would mislead the
    # surface, so the schema exposes no default (only an explicit value configures them).
    assert specs["CLAWHUNT_BASE_URL"].default is None
    assert specs["SUPERCLAW_RUNNINGHUB_BASE_URL"].default is None
    assert runtime_config_ui_descriptor(specs["CLAWHUNT_BASE_URL"])["type"] == "url"
    assert runtime_config_ui_descriptor(specs["SUPERCLAW_HTTP_URL"])["type"] == "url"
    assert runtime_config_ui_descriptor(specs["SUPERCLAW_OPENCLAW_GATEWAY_URL"])["type"] == "url"


def test_declared_choices_are_kernel_enforced(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    with pytest.raises(ValueError, match="mode must be one of"):
        set_runtime_config("mode", "bogus")

    # the generic enforcement branch must reject and accept for a non-mode
    # choice spec; choices are matched verbatim (no case folding) on purpose
    import superclaw.runtime_config as rc

    spec = RuntimeConfigSpec("X_TEST_CHOICE", "shell", "test", choices=("alpha", "beta"))
    assert runtime_config_ui_descriptor(spec)["type"] == "select"
    patched = dict(rc._RUNTIME_CONFIG_SPECS)
    patched["X_TEST_CHOICE"] = spec
    monkeypatch.setattr(rc, "_RUNTIME_CONFIG_SPECS", patched)
    with pytest.raises(ValueError, match="X_TEST_CHOICE must be one of: alpha, beta"):
        set_runtime_config("X_TEST_CHOICE", "gamma")
    with pytest.raises(ValueError, match="must be one of"):
        set_runtime_config("X_TEST_CHOICE", "ALPHA")  # verbatim match, no lower()
    result = set_runtime_config("X_TEST_CHOICE", "alpha")
    assert result["value"] == "alpha"


def test_explicit_ui_type_override_wins():
    spec = RuntimeConfigSpec("X_TEST_URL", "shell", "test", ui_type="text")
    assert runtime_config_ui_descriptor(spec)["type"] == "text"


def test_delegation_toggle_defaults_off_and_renders_as_toggle(tmp_path, monkeypatch):
    # Cross-runtime delegation switch (roadmap §5/§6, P0): a kernel config, not a
    # frontend-only slider. fail-closed default off; renders as a toggle.
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    from superclaw.runtime_config import configured_shell_delegation

    spec = runtime_config_specs()["delegation"]
    assert spec.category == "shell"
    assert spec.default == "false"
    assert runtime_config_ui_descriptor(spec)["type"] == "toggle"

    entries = {entry["name"]: entry for entry in runtime_config_payload()["entries"]}
    assert entries["delegation"]["value"] == "false"
    assert entries["delegation"]["source"] == "default"
    assert entries["delegation"]["configured"] is False
    assert configured_shell_delegation() is None

    # shell `/config set delegation true` persists; the payload reflects it.
    set_runtime_config("delegation", "true")
    assert configured_shell_delegation() == "true"
    entries = {entry["name"]: entry for entry in runtime_config_payload()["entries"]}
    assert entries["delegation"]["value"] == "true"
    assert entries["delegation"]["source"] == "persisted"
    assert entries["delegation"]["configured"] is True


def test_delegation_is_shell_scoped_not_hydrated_as_env_var(tmp_path, monkeypatch):
    # Shell-scoped like backend/mode/repo: it must never be hydrated into the
    # process environment as if it were a SUPERCLAW_* env var.
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    from superclaw.runtime_config import persisted_runtime_environment

    set_runtime_config("delegation", "true")
    assert "delegation" not in persisted_runtime_environment()


def test_delegation_rejects_non_boolean_values(tmp_path, monkeypatch):
    # A governance toggle must not let an arbitrary string become "configured".
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    with pytest.raises(ValueError, match="must be a boolean"):
        set_runtime_config("delegation", "maybe")
    # the four accepted boolean spellings pass.
    for value in ("true", "false", "1", "0"):
        assert set_runtime_config("delegation", value)["value"] == value


def test_delegation_set_does_not_hydrate_process_env(tmp_path, monkeypatch):
    # Even via the CLI/TUI apply_process_env path, the shell-scoped toggle must
    # not be written into os.environ as a lowercase "delegation" var, and it is
    # read live so it never requires a restart.
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    monkeypatch.delenv("delegation", raising=False)
    result = set_runtime_config("delegation", "true", apply_process_env=True)
    assert "delegation" not in os.environ
    assert result["restart_required"] is False


def test_delegation_read_path_is_fail_closed_on_illegal_persisted_value(tmp_path, monkeypatch):
    # The write path validates booleans, but the kernel never trusts persisted
    # state: a hand-edited / legacy config with a non-boolean delegation value
    # must read as unset (-> default off), never surface as configured.
    import json

    from superclaw.runtime_config import configured_shell_delegation

    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"delegation": "maybe"}), encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(config_path))

    assert configured_shell_delegation() is None
    entries = {entry["name"]: entry for entry in runtime_config_payload()["entries"]}
    assert entries["delegation"]["value"] == "false"
    assert entries["delegation"]["source"] == "default"
    assert entries["delegation"]["configured"] is False


def test_delegation_enabled_is_a_fail_closed_bool(tmp_path, monkeypatch):
    # The effective on/off reader returns a real bool; ONLY 'true'/'1' enable.
    # Critically, explicit-off spellings must NOT be misread as truthy strings
    # (the string "false" is truthy in Python — bool(configured_shell_delegation())
    # would be wrong; delegation_enabled() is the safe contract).
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    from superclaw.runtime_config import delegation_enabled

    assert delegation_enabled() is False  # unset -> off
    for off_value in ("false", "0"):
        set_runtime_config("delegation", off_value)
        assert delegation_enabled() is False, off_value
    for on_value in ("true", "1"):
        set_runtime_config("delegation", on_value)
        assert delegation_enabled() is True, on_value
