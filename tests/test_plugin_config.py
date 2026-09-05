from __future__ import annotations

import base64
import json
import os
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_config import (
    PluginConfigurationError,
    load_plugin_secret_environment,
    plugin_configuration_status,
    plugin_setting_status,
    set_plugin_secret,
    set_plugin_setting,
)
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _copy_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign_plugin(plugin_dir: Path, private_key: Ed25519PrivateKey) -> str:
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return digest


def _cache_signed_fixture(tmp_path: Path, name: str) -> tuple[Path, Path, str]:
    plugin_dir = _copy_fixture(tmp_path, name)
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    cache_root = tmp_path / "cache"
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    return plugin_dir, cache_root, public_key


def _entitlement_file(tmp_path: Path, plugin_id: str, version: str = "0.1.0") -> Path:
    path = tmp_path / "entitlements.json"
    path.write_text(
        json.dumps({"entitlements": [{"plugin_id": plugin_id, "version": version, "entitlement_id": "ent_test"}]}),
        encoding="utf-8",
    )
    return path


def test_plugin_config_and_secret_cli_do_not_print_secret_values(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    runner = CliRunner()

    setting = runner.invoke(
        app,
        ["plugin", "config", "set", "dev.superclaw.github-scanner", "default_owner", "ClawHunt-Store", "--config-file", str(config_file), "--json"],
    )
    secret = runner.invoke(
        app,
        ["plugin", "secret", "set", "dev.superclaw.github-scanner", "GITHUB_TOKEN", "--value", "ghp_abcdefghijklmnop", "--config-file", str(config_file), "--json"],
    )
    status = runner.invoke(app, ["plugin", "secret", "status", "dev.superclaw.github-scanner", "--config-file", str(config_file), "--json"])

    assert setting.exit_code == 0, setting.output
    assert secret.exit_code == 0, secret.output
    assert status.exit_code == 0, status.output
    joined_output = setting.output + secret.output + status.output
    assert "ghp_abcdefghijklmnop" not in joined_output
    assert json.loads(status.output)["secrets"] == [
        {
            "name": "GITHUB_TOKEN",
            "configured": True,
            "user_id": "local-user",
            "device_id": "local-device",
            "version_range": "*",
            "updated_at": json.loads(status.output)["secrets"][0]["updated_at"],
        }
    ]
    if os.name != "nt":
        assert config_file.stat().st_mode & 0o777 == 0o600


def test_plugin_setting_rejects_control_character_values(tmp_path: Path):
    config_file = tmp_path / "local-config.json"

    with pytest.raises(PluginConfigurationError, match="control characters"):
        set_plugin_setting(
            "dev.superclaw.github-scanner",
            "default_owner",
            "ClawHunt-Store\rGITHUB_TOKEN=ghp_pollutedsetting",
            config_file=config_file,
        )

    assert not config_file.exists()


def test_plugin_configuration_ignores_persisted_control_character_settings(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    config_file.write_text(
        json.dumps(
            {
                "plugins": {
                    "dev.superclaw.github-scanner": {
                        "settings": {
                            "default_owner": {
                                "value": "ClawHunt-Store\rGITHUB_TOKEN=ghp_pollutedsetting",
                                "updated_at": "2026-06-04T00:00:00Z",
                            },
                            "default_repo": {
                                "value": "SuperClaw",
                                "updated_at": "2026-06-04T00:00:00Z",
                            },
                        }
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    manifest = {
        "configuration": {
            "settings": [
                {"name": "default_owner", "type": "string", "default": "ClawHunt-Store"},
                {"name": "default_repo", "type": "string", "default": "SuperClaw"},
            ]
        }
    }

    settings = plugin_setting_status("dev.superclaw.github-scanner", config_file=config_file)
    payload = plugin_configuration_status("dev.superclaw.github-scanner", manifest, config_file=config_file)
    payload_text = json.dumps(payload)

    assert settings == [
        {
            "name": "default_repo",
            "configured": True,
            "value": "SuperClaw",
            "updated_at": "2026-06-04T00:00:00Z",
        }
    ]
    assert payload["settings"][0]["name"] == "default_owner"
    assert payload["settings"][0]["configured"] is False
    assert payload["settings"][0]["value"] == "ClawHunt-Store"
    assert payload["settings"][1]["configured"] is True
    assert "ghp_pollutedsetting" not in payload_text


def test_plugin_call_loads_declared_secret_from_local_config_without_leaking_it(tmp_path: Path, monkeypatch):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    config_file = tmp_path / "local-config.json"
    artifact_dir = tmp_path / "artifacts"
    set_plugin_secret("dev.superclaw.github-scanner", "GITHUB_TOKEN", "ghp_abcdefghijklmnop", config_file=config_file)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    runner = CliRunner()

    call = runner.invoke(
        app,
        [
            "plugin",
            "call",
            "dev.superclaw.github-scanner",
            "github_scan",
            "--input-json",
            '{"owner":"ClawHunt-Store","repo":"SuperClaw"}',
            "--public-key",
            public_key,
            "--entitlement-file",
            str(_entitlement_file(tmp_path, "dev.superclaw.github-scanner")),
            "--config-file",
            str(config_file),
            "--artifact-dir",
            str(artifact_dir),
            "--json",
        ],
    )

    assert call.exit_code == 0, call.output
    assert "ghp_abcdefghijklmnop" not in call.output
    payload = json.loads(call.output)
    assert payload["ok"] is True
    artifact_text = "\n".join(path.read_text(encoding="utf-8") for path in artifact_dir.rglob("*.json"))
    assert "ghp_abcdefghijklmnop" not in artifact_text


def test_proxy_does_not_inherit_parent_shell_secret_by_default(tmp_path: Path, monkeypatch):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_abcdefghijklmnop")

    result = invoke_cached_plugin_tool(
        "dev.superclaw.github-scanner",
        "github_scan",
        {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
        cache_root=cache_root,
        public_key=public_key,
        artifact_dir=tmp_path / "artifacts",
        entitlement_file=_entitlement_file(tmp_path, "dev.superclaw.github-scanner"),
        config_file=tmp_path / "missing-local-config.json",
    )

    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_CONFIG_REQUIRED"


def test_plugin_secret_cli_rejects_invalid_secret_name(tmp_path: Path):
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["plugin", "secret", "set", "dev.superclaw.github-scanner", "github_token", "--value", "ghp_abcdefghijklmnop", "--config-file", str(tmp_path / "config.json"), "--json"],
    )

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert "invalid plugin secret name" in payload["error"]
    assert "ghp_abcdefghijklmnop" not in result.output


def test_plugin_secret_cli_rejects_invalid_version_range_without_leaking_value(tmp_path: Path):
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "secret",
            "set",
            "dev.superclaw.github-scanner",
            "GITHUB_TOKEN",
            "--value",
            "ghp_invalidrangevalue",
            "--version-range",
            "not-a-range",
            "--config-file",
            str(tmp_path / "config.json"),
            "--json",
        ],
    )

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert "invalid plugin version range" in payload["error"]
    assert "ghp_invalidrangevalue" not in result.output


def test_plugin_secret_set_rotates_value_without_retaining_old_secret(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    manifest = {"configuration": {"secrets": [{"name": "GITHUB_TOKEN", "env_name": "GITHUB_TOKEN"}]}}
    runner = CliRunner()

    first = runner.invoke(
        app,
        ["plugin", "secret", "set", "dev.superclaw.github-scanner", "GITHUB_TOKEN", "--value", "ghp_oldsecretvalue123", "--config-file", str(config_file), "--json"],
    )
    second = runner.invoke(
        app,
        ["plugin", "secret", "set", "dev.superclaw.github-scanner", "GITHUB_TOKEN", "--value", "ghp_newsecretvalue456", "--config-file", str(config_file), "--json"],
    )

    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output
    assert "ghp_oldsecretvalue123" not in first.output + second.output
    assert "ghp_newsecretvalue456" not in first.output + second.output
    assert load_plugin_secret_environment("dev.superclaw.github-scanner", manifest, config_file=config_file) == {"GITHUB_TOKEN": "ghp_newsecretvalue456"}
    stored_text = config_file.read_text(encoding="utf-8")
    assert "ghp_oldsecretvalue123" not in stored_text
    assert "ghp_newsecretvalue456" in stored_text


def test_plugin_secret_delete_removes_value_and_keeps_cli_output_sanitized(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    manifest = {"configuration": {"secrets": [{"name": "GITHUB_TOKEN", "env_name": "GITHUB_TOKEN"}]}}
    runner = CliRunner()
    set_plugin_secret("dev.superclaw.github-scanner", "GITHUB_TOKEN", "ghp_deletevalue123", config_file=config_file)

    deleted = runner.invoke(
        app,
        ["plugin", "secret", "delete", "dev.superclaw.github-scanner", "GITHUB_TOKEN", "--config-file", str(config_file), "--json"],
    )
    status = runner.invoke(app, ["plugin", "secret", "status", "dev.superclaw.github-scanner", "--config-file", str(config_file), "--json"])

    assert deleted.exit_code == 0, deleted.output
    assert status.exit_code == 0, status.output
    assert "ghp_deletevalue123" not in deleted.output + status.output
    assert json.loads(deleted.output) == {
        "ok": True,
        "plugin_id": "dev.superclaw.github-scanner",
        "secret": "GITHUB_TOKEN",
        "user_id": "local-user",
        "device_id": "local-device",
        "deleted": True,
        "configured": False,
    }
    assert json.loads(status.output)["secrets"] == []
    assert load_plugin_secret_environment("dev.superclaw.github-scanner", manifest, config_file=config_file) == {}
    assert "ghp_deletevalue123" not in config_file.read_text(encoding="utf-8")
    if os.name != "nt":
        assert config_file.stat().st_mode & 0o777 == 0o600


def test_plugin_secret_version_range_loads_only_matching_package_version(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    manifest = {"configuration": {"secrets": [{"name": "GITHUB_TOKEN", "env_name": "GITHUB_TOKEN"}]}}
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "secret",
            "set",
            "dev.superclaw.github-scanner",
            "GITHUB_TOKEN",
            "--value",
            "ghp_rangedvalue123",
            "--version-range",
            ">=0.1.0 <0.2.0",
            "--config-file",
            str(config_file),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["version_range"] == ">=0.1.0 <0.2.0"
    assert "ghp_rangedvalue123" not in result.output
    assert load_plugin_secret_environment("dev.superclaw.github-scanner", manifest, plugin_version="0.1.0", config_file=config_file) == {
        "GITHUB_TOKEN": "ghp_rangedvalue123"
    }
    assert load_plugin_secret_environment("dev.superclaw.github-scanner", manifest, plugin_version="0.2.0", config_file=config_file) == {}


def test_plugin_call_returns_config_required_for_mismatched_secret_version_range(tmp_path: Path, monkeypatch):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    config_file = tmp_path / "local-config.json"
    set_plugin_secret("dev.superclaw.github-scanner", "GITHUB_TOKEN", "ghp_mismatchvalue123", version_range=">=0.2.0 <0.3.0", config_file=config_file)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    runner = CliRunner()

    call = runner.invoke(
        app,
        [
            "plugin",
            "call",
            "dev.superclaw.github-scanner",
            "github_scan",
            "--input-json",
            '{"owner":"ClawHunt-Store","repo":"SuperClaw"}',
            "--public-key",
            public_key,
            "--entitlement-file",
            str(_entitlement_file(tmp_path, "dev.superclaw.github-scanner")),
            "--config-file",
            str(config_file),
            "--json",
        ],
    )

    assert call.exit_code == 1
    assert "ghp_mismatchvalue123" not in call.output
    payload = json.loads(call.output)
    assert payload["ok"] is False
    assert payload["response"]["error"]["code"] == "PLUGIN_CONFIG_REQUIRED"


def test_plugin_secret_identity_scope_loads_only_matching_user_and_device(tmp_path: Path):
    config_file = tmp_path / "local-config.json"
    manifest = {"configuration": {"secrets": [{"name": "GITHUB_TOKEN", "env_name": "GITHUB_TOKEN"}]}}
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "plugin",
            "secret",
            "set",
            "dev.superclaw.github-scanner",
            "GITHUB_TOKEN",
            "--value",
            "ghp_identityvalue123",
            "--user-id",
            "user_alpha",
            "--device-id",
            "device_alpha",
            "--config-file",
            str(config_file),
            "--json",
        ],
    )
    status = runner.invoke(
        app,
        [
            "plugin",
            "secret",
            "status",
            "dev.superclaw.github-scanner",
            "--user-id",
            "user_alpha",
            "--device-id",
            "device_alpha",
            "--config-file",
            str(config_file),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert status.exit_code == 0, status.output
    assert "ghp_identityvalue123" not in result.output + status.output
    payload = json.loads(result.output)
    assert payload["user_id"] == "user_alpha"
    assert payload["device_id"] == "device_alpha"
    status_payload = json.loads(status.output)
    assert status_payload["secrets"][0]["user_id"] == "user_alpha"
    assert status_payload["secrets"][0]["device_id"] == "device_alpha"
    assert load_plugin_secret_environment(
        "dev.superclaw.github-scanner",
        manifest,
        user_id="user_alpha",
        device_id="device_alpha",
        config_file=config_file,
    ) == {"GITHUB_TOKEN": "ghp_identityvalue123"}
    assert (
        load_plugin_secret_environment(
            "dev.superclaw.github-scanner",
            manifest,
            user_id="user_beta",
            device_id="device_alpha",
            config_file=config_file,
        )
        == {}
    )
    assert (
        load_plugin_secret_environment(
            "dev.superclaw.github-scanner",
            manifest,
            user_id="user_alpha",
            device_id="device_beta",
            config_file=config_file,
        )
        == {}
    )


def test_plugin_call_returns_config_required_for_mismatched_local_identity(tmp_path: Path, monkeypatch):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    config_file = tmp_path / "local-config.json"
    set_plugin_secret(
        "dev.superclaw.github-scanner",
        "GITHUB_TOKEN",
        "ghp_identitymismatch123",
        user_id="user_alpha",
        device_id="device_alpha",
        config_file=config_file,
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_USER_ID", "user_beta")
    monkeypatch.setenv("SUPERCLAW_DEVICE_ID", "device_alpha")
    runner = CliRunner()

    call = runner.invoke(
        app,
        [
            "plugin",
            "call",
            "dev.superclaw.github-scanner",
            "github_scan",
            "--input-json",
            '{"owner":"ClawHunt-Store","repo":"SuperClaw"}',
            "--public-key",
            public_key,
            "--entitlement-file",
            str(_entitlement_file(tmp_path, "dev.superclaw.github-scanner")),
            "--config-file",
            str(config_file),
            "--json",
        ],
    )

    assert call.exit_code == 1
    assert "ghp_identitymismatch123" not in call.output
    payload = json.loads(call.output)
    assert payload["ok"] is False
    assert payload["response"]["error"]["code"] == "PLUGIN_CONFIG_REQUIRED"


def test_plugin_configuration_status_surfaces_dynamic_options_and_actions():
    """A setting may declare options_source + actions; the status payload exposes
    them normalized so the config UI can render a searchable select + buttons."""
    from superclaw.plugin_config import plugin_configuration_status

    manifest = {
        "id": "dev.example.demo",
        "configuration": {
            "settings": [
                {
                    "name": "profile",
                    "type": "string",
                    "description": "Chrome profile to drive",
                    "ui": {"control": "select"},
                    "options_source": {"tool": "list_profiles", "label": "Available profiles", "arguments": {"kind": "chrome"}},
                    "actions": [
                        {"id": "bind", "tool": "bind_profile", "label": "Bind"},
                        {"tool": "login"},  # id falls back to tool
                        {"label": "no tool -> dropped"},  # malformed -> dropped
                    ],
                }
            ]
        },
    }
    status = plugin_configuration_status("dev.example.demo", manifest)
    setting = status["settings"][0]
    assert setting["options_source"] == {"tool": "list_profiles", "label": "Available profiles", "arguments": {"kind": "chrome"}}
    assert setting["actions"] == [
        {"id": "bind", "tool": "bind_profile", "label": "Bind"},
        {"tool": "login"},
    ]


def test_plugin_configuration_status_omits_dynamic_fields_when_absent():
    from superclaw.plugin_config import plugin_configuration_status

    manifest = {"id": "dev.example.plain", "configuration": {"settings": [{"name": "config_url", "type": "string"}]}}
    setting = plugin_configuration_status("dev.example.plain", manifest)["settings"][0]
    assert setting["options_source"] is None
    assert setting["actions"] == []


def test_load_plugin_setting_environment_delivers_settings_to_runtime(tmp_path):
    from superclaw.plugin_config import load_plugin_setting_environment, set_plugin_setting

    cfg = tmp_path / "local-config.json"
    manifest = {
        "id": "dev.example.demo",
        "configuration": {
            "settings": [
                {"name": "chrome_profile", "type": "string", "env_name": "PAY_SWITCH_CHROME_PROFILE_DIRECTORY"},
                {"name": "region", "type": "string", "env_name": "DEMO_REGION", "default": "cn"},
                {"name": "no_env", "type": "string", "default": "x"},  # no env_name -> not delivered
            ]
        },
    }
    # Unconfigured: only the default-bearing env-mapped setting is delivered.
    env = load_plugin_setting_environment("dev.example.demo", manifest, config_file=cfg)
    assert env == {"DEMO_REGION": "cn"}

    set_plugin_setting("dev.example.demo", "chrome_profile", "Profile 2", config_file=cfg)
    env = load_plugin_setting_environment("dev.example.demo", manifest, config_file=cfg)
    assert env["PAY_SWITCH_CHROME_PROFILE_DIRECTORY"] == "Profile 2"
    assert env["DEMO_REGION"] == "cn"
    assert "DEMO_X" not in env and len(env) == 2  # settings without env_name never delivered


def test_setting_env_name_must_be_upper_snake():
    import pytest as _pytest

    from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract

    bad = {"configuration": {"settings": [{"name": "x", "type": "string", "env_name": "lower-bad"}]}}
    with _pytest.raises(PluginConfigurationError):
        validate_manifest_configuration_contract(bad)
    good = {"configuration": {"settings": [{"name": "x", "type": "string", "env_name": "GOOD_NAME"}]}}
    validate_manifest_configuration_contract(good)  # no raise


def test_select_control_accepts_dynamic_options_source():
    """A select-control setting is valid with EITHER a static validation.enum OR a
    dynamic options_source (so plugins can offer runtime-discovered choices)."""
    import pytest as _pytest

    from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract

    dynamic = {
        "configuration": {
            "settings": [
                {
                    "name": "profile",
                    "type": "string",
                    "ui": {"control": "select"},
                    "options_source": {"tool": "list_profiles"},
                }
            ]
        }
    }
    validate_manifest_configuration_contract(dynamic)  # no raise

    static = {
        "configuration": {
            "settings": [
                {"name": "region", "type": "string", "ui": {"control": "select"}, "validation": {"enum": ["cn", "us"]}}
            ]
        }
    }
    validate_manifest_configuration_contract(static)  # no raise

    bad = {"configuration": {"settings": [{"name": "x", "type": "string", "ui": {"control": "select"}}]}}
    with _pytest.raises(PluginConfigurationError):
        validate_manifest_configuration_contract(bad)


def test_two_tier_ui_metadata_accepts_section_and_step():
    """Settings and secrets may declare the two-tier exposure contract: a
    `section` (basic/advanced) plus step ordering + titles for basic items."""
    from superclaw.plugin_config import validate_manifest_configuration_contract

    manifest = {
        "configuration": {
            "settings": [
                {
                    "name": "profile",
                    "type": "string",
                    "ui": {
                        "control": "text",
                        "section": "basic",
                        "step": 1,
                        "step_title": "Pick a profile",
                        "step_description": "Choose the signed-in profile.",
                    },
                },
                {"name": "endpoint", "type": "string", "ui": {"section": "advanced"}},
            ],
            "secrets": [
                {"name": "TOKEN", "ui": {"section": "advanced"}},
            ],
        }
    }
    validate_manifest_configuration_contract(manifest)  # no raise


def test_two_tier_ui_metadata_rejects_bad_shapes():
    import pytest as _pytest

    from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract

    bad_section = {"configuration": {"settings": [{"name": "x", "type": "string", "ui": {"section": "primary"}}]}}
    with _pytest.raises(PluginConfigurationError, match="section"):
        validate_manifest_configuration_contract(bad_section)

    bad_step = {"configuration": {"settings": [{"name": "x", "type": "string", "ui": {"step": 0}}]}}
    with _pytest.raises(PluginConfigurationError, match="step"):
        validate_manifest_configuration_contract(bad_step)

    bad_step_type = {"configuration": {"settings": [{"name": "x", "type": "string", "ui": {"step": "1"}}]}}
    with _pytest.raises(PluginConfigurationError, match="step"):
        validate_manifest_configuration_contract(bad_step_type)

    bad_title = {"configuration": {"settings": [{"name": "x", "type": "string", "ui": {"step_title": 5}}]}}
    with _pytest.raises(PluginConfigurationError, match="step_title"):
        validate_manifest_configuration_contract(bad_title)

    bad_secret_section = {"configuration": {"secrets": [{"name": "TOKEN", "ui": {"section": "nope"}}]}}
    with _pytest.raises(PluginConfigurationError, match="section"):
        validate_manifest_configuration_contract(bad_secret_section)


def test_required_item_must_not_be_advanced():
    """Tier contract: basic == required tier, advanced == optional. A required
    setting/secret hidden in advanced is rejected fail-closed so a surface can
    never report the plugin ready while a mandatory value is unset."""
    import pytest as _pytest

    from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract

    bad_setting = {
        "configuration": {
            "settings": [{"name": "endpoint", "type": "string", "required": True, "ui": {"section": "advanced"}}]
        }
    }
    with _pytest.raises(PluginConfigurationError, match="advanced"):
        validate_manifest_configuration_contract(bad_setting)

    bad_setting_legacy = {
        "configuration": {
            "settings": [{"name": "endpoint", "type": "string", "required": True, "ui": {"advanced": True}}]
        }
    }
    with _pytest.raises(PluginConfigurationError, match="advanced"):
        validate_manifest_configuration_contract(bad_setting_legacy)

    bad_secret = {"configuration": {"secrets": [{"name": "TOKEN", "required": True, "ui": {"section": "advanced"}}]}}
    with _pytest.raises(PluginConfigurationError, match="advanced"):
        validate_manifest_configuration_contract(bad_secret)

    # required + basic, and optional + advanced, are both fine
    good = {
        "configuration": {
            "settings": [{"name": "endpoint", "type": "string", "required": True, "ui": {"section": "basic"}}],
            "secrets": [{"name": "TOKEN", "required": False, "ui": {"section": "advanced"}}],
        }
    }
    validate_manifest_configuration_contract(good)  # no raise


def test_configuration_status_surfaces_tier_ui_for_settings_and_secrets():
    """The status payload carries `ui` for both settings and secrets so every
    surface can render the same basic/advanced + step grouping."""
    from superclaw.plugin_config import plugin_configuration_status

    manifest = {
        "configuration": {
            "settings": [
                {"name": "profile", "type": "string", "ui": {"section": "basic", "step": 1}},
            ],
            "secrets": [
                {"name": "TOKEN", "ui": {"section": "advanced"}},
            ],
        }
    }
    status = plugin_configuration_status("dev.example.tiered", manifest)
    setting = status["settings"][0]
    assert setting["ui"] == {"section": "basic", "step": 1}
    secret = status["secrets"][0]
    assert secret["ui"] == {"section": "advanced"}


def test_plugin_configuration_status_identifies_auto_provisioned_secret(monkeypatch):
    """If a secret matches the clawhunt_account_bridge token_env, it is marked
    as auto_provisioned, forced to advanced section, and marked as not required."""
    from superclaw import clawhunt_auth

    manifest = {
        "id": "dev.example.bridge",
        "clawhunt_account_bridge": {
            "type": "pay_switch_agent_token",
            "token_env": "MY_SCOPED_TOKEN"
        },
        "configuration": {
            "secrets": [
                {
                    "name": "MY_SCOPED_TOKEN",
                    "required": True,
                    "ui": {"section": "basic", "step": 1}
                },
                {
                    "name": "OTHER_SECRET",
                    "required": True,
                    "ui": {"section": "basic", "step": 2}
                }
            ]
        }
    }

    # Case 1: Logged in
    monkeypatch.setattr(clawhunt_auth, "saved_clawhunt_access_token", lambda: "token_abc")
    status = plugin_configuration_status("dev.example.bridge", manifest)

    # Check MY_SCOPED_TOKEN (auto-provisioned)
    secret1 = next(s for s in status["secrets"] if s["name"] == "MY_SCOPED_TOKEN")
    assert secret1["auto_provisioned"] is True
    assert secret1["required"] is False  # Coerced
    assert secret1["ui"]["section"] == "advanced"  # Coerced
    assert secret1["provisioning_provider"] == "ClawHunt Account"
    assert secret1["provisioning_status"] == "available"

    # Check OTHER_SECRET (normal)
    secret2 = next(s for s in status["secrets"] if s["name"] == "OTHER_SECRET")
    assert secret2.get("auto_provisioned", False) is False
    assert secret2["required"] is True
    assert secret2["ui"]["section"] == "basic"

    # Case 2: Not logged in
    monkeypatch.setattr(clawhunt_auth, "saved_clawhunt_access_token", lambda: None)
    status = plugin_configuration_status("dev.example.bridge", manifest)
    secret1 = next(s for s in status["secrets"] if s["name"] == "MY_SCOPED_TOKEN")
    assert secret1["provisioning_status"] == "unavailable"
    assert secret1["required"] is False  # Still False


def test_plugin_configuration_status_uses_default_token_env_name(monkeypatch):
    """If token_env is missing from bridge config, it defaults to PAY_SWITCH_AGENT_TOKEN."""
    from superclaw import clawhunt_auth

    manifest = {
        "id": "dev.example.default-bridge",
        "clawhunt_account_bridge": {
            "type": "pay_switch_agent_token"
        },
        "configuration": {
            "secrets": [
                {
                    "name": "PAY_SWITCH_AGENT_TOKEN",
                    "required": True
                }
            ]
        }
    }

    monkeypatch.setattr(clawhunt_auth, "saved_clawhunt_access_token", lambda: "token_abc")
    status = plugin_configuration_status("dev.example.default-bridge", manifest)
    secret = status["secrets"][0]
    assert secret["name"] == "PAY_SWITCH_AGENT_TOKEN"
    assert secret["auto_provisioned"] is True


def test_contract_rejects_required_auto_provisioned_secret():
    """An account-bridge credential is supplied from login state, so it can never
    be a user-required field. The contract rejects required:true so the manifest,
    the config-status payload, and the runtime sidecar gate cannot disagree."""
    from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract

    bad = {
        "clawhunt_account_bridge": {"type": "pay_switch_agent_token", "token_env": "PAY_SWITCH_AGENT_TOKEN"},
        "configuration": {"secrets": [{"name": "PAY_SWITCH_AGENT_TOKEN", "required": True}]},
    }
    with pytest.raises(PluginConfigurationError, match="auto-provisioned"):
        validate_manifest_configuration_contract(bad)

    good = {
        "clawhunt_account_bridge": {"type": "pay_switch_agent_token", "token_env": "PAY_SWITCH_AGENT_TOKEN"},
        "configuration": {"secrets": [{"name": "PAY_SWITCH_AGENT_TOKEN", "required": False}]},
    }
    validate_manifest_configuration_contract(good)  # no raise


def test_account_bridge_endpoint_settings_coerced_to_advanced():
    """Settings the account bridge manages (config/panel URLs) are service
    endpoints, not user setup — the status payload folds them to advanced and
    drops required, even when the (installed/signed) manifest has no ui.section."""
    manifest = {
        "clawhunt_account_bridge": {
            "type": "pay_switch_agent_token",
            "token_env": "PAY_SWITCH_AGENT_TOKEN",
            "config_url_env": "PAY_SWITCH_CONFIG_URL",
            "panel_url_env": "PAY_SWITCH_PANEL_URL",
        },
        "configuration": {
            "settings": [
                {"name": "config_url", "type": "string", "env_name": "PAY_SWITCH_CONFIG_URL", "required": True},
                {"name": "panel_url", "type": "string", "env_name": "PAY_SWITCH_PANEL_URL"},
                {"name": "chrome_profile_directory", "type": "string"},
            ]
        },
    }
    status = plugin_configuration_status("dev.clawhunt.pay-switch-agent", manifest)
    by_name = {s["name"]: s for s in status["settings"]}
    assert by_name["config_url"]["ui"].get("section") == "advanced"
    assert by_name["config_url"]["required"] is False
    assert by_name["panel_url"]["ui"].get("section") == "advanced"
    # A genuine user step keeps its basic default.
    assert by_name["chrome_profile_directory"]["ui"].get("section") != "advanced"
