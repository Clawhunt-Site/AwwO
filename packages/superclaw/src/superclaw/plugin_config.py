from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from superclaw.environment import superclaw_home
from superclaw.plugin_versions import PluginVersionRangeError, normalize_version_range, version_satisfies_range
from superclaw import clawhunt_auth


# Plugin runtime config lives under the user-global plugin state root, so a
# globally-installed plugin is configured once and usable from any working
# directory (matching the user-global cache/governance). Resolved at call time so
# the env override is honored after import; ``SUPERCLAW_PLUGIN_CONFIG_PATH`` still
# overrides just this file, and ``SUPERCLAW_PLUGIN_STATE_ROOT`` redirects the root.
# Anchored on the single data root (``superclaw_home``) so it tracks SUPERCLAW_HOME;
# the root is read directly (not via ``plugins.plugin_state_root``) to avoid the
# plugins -> plugin_config import cycle; the env contract is identical.
def _default_plugin_config_file() -> Path:
    state_root = os.environ.get("SUPERCLAW_PLUGIN_STATE_ROOT")
    root = Path(state_root).expanduser() if state_root else superclaw_home() / "plugins"
    return root / "local-config.json"


# Back-compat constant (import-time snapshot); prefer ``plugin_config_path()``.
DEFAULT_PLUGIN_CONFIG_FILE = _default_plugin_config_file()
DEFAULT_PLUGIN_USER_ID = "local-user"
DEFAULT_PLUGIN_DEVICE_ID = "local-device"
PLUGIN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$")
IDENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$")
SETTING_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
# A plugin tool name referenced by a config options_source / action.
CONFIG_TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
# Two-tier configuration contract. Every setting/secret a plugin exposes belongs
# to exactly one tier:
#   - "basic":    a required, step-by-step operation a user must complete before
#                 the plugin is usable. Basic items are ordered into Step 1 / 2 /
#                 ... by their `ui.step` and rendered up-front by every surface.
#   - "advanced": optional / diagnostic settings that surfaces collapse behind an
#                 advanced disclosure so they never crowd the must-do steps.
# The tier is declared via `ui.section`; the legacy boolean `ui.advanced: true`
# is still honored as section == "advanced". When unset, an item defaults to
# "basic" (a plain plugin with no advanced settings is all steps).
CONFIG_UI_SECTIONS = {"basic", "advanced"}


def _normalize_config_invocation(raw: Any) -> dict[str, Any] | None:
    """Normalize a setting `options_source` / `action` descriptor.

    Shape: {"tool": <plugin tool name>, "label"?: str, "arguments"?: {...},
    "id"?: str}. The referenced tool is invoked through the SAME governed plugin
    proxy (`invoke_cached_plugin_tool`) as any other plugin call, so dynamic
    config discovery/actions inherit signature/entitlement/policy enforcement.
    Returns None when the descriptor is missing or malformed (fail-soft: a bad
    options_source just means no dynamic options, not a broken config UI).
    """
    if not isinstance(raw, dict):
        return None
    tool = str(raw.get("tool") or "").strip()
    if not tool or not CONFIG_TOOL_NAME_RE.fullmatch(tool):
        return None
    arguments = raw.get("arguments")
    out: dict[str, Any] = {"tool": tool}
    if isinstance(raw.get("id"), str) and raw["id"].strip():
        out["id"] = raw["id"].strip()
    if isinstance(raw.get("label"), str) and raw["label"].strip():
        out["label"] = raw["label"].strip()
    if isinstance(arguments, dict):
        out["arguments"] = arguments
    return out


class PluginConfigurationError(ValueError):
    """Raised when local plugin configuration cannot be loaded safely."""


@dataclass(frozen=True)
class PluginConfigWriteResult:
    plugin_id: str
    name: str
    config_file: Path
    version_range: str | None = None
    user_id: str | None = None
    device_id: str | None = None


@dataclass(frozen=True)
class PluginConfigDeleteResult:
    plugin_id: str
    name: str
    config_file: Path
    deleted: bool
    user_id: str
    device_id: str


def plugin_config_path(path: Path | None = None) -> Path:
    if path is not None:
        return path
    configured = os.environ.get("SUPERCLAW_PLUGIN_CONFIG_PATH")
    # Call-time so SUPERCLAW_PLUGIN_STATE_ROOT set after import is honored.
    return Path(configured) if configured else _default_plugin_config_file()


def plugin_local_identity(*, user_id: str | None = None, device_id: str | None = None) -> tuple[str, str]:
    resolved_user_id = user_id or os.environ.get("SUPERCLAW_USER_ID") or DEFAULT_PLUGIN_USER_ID
    resolved_device_id = device_id or os.environ.get("SUPERCLAW_DEVICE_ID") or DEFAULT_PLUGIN_DEVICE_ID
    _validate_identity_id(resolved_user_id, "user id")
    _validate_identity_id(resolved_device_id, "device id")
    return resolved_user_id, resolved_device_id


def set_plugin_setting(plugin_id: str, name: str, value: Any, *, config_file: Path | None = None) -> PluginConfigWriteResult:
    _validate_plugin_id(plugin_id)
    _validate_setting_name(name)
    _validate_plain_config_value(value, "plugin setting value")
    path = plugin_config_path(config_file)
    payload = _read_config(path)
    plugin = _plugin_record(payload, plugin_id)
    plugin.setdefault("settings", {})[name] = {"value": value, "updated_at": _utc_now()}
    _write_config(path, payload)
    return PluginConfigWriteResult(plugin_id=plugin_id, name=name, config_file=path)


def normalize_manifest_setting_value(manifest: dict[str, Any], name: str, value: Any) -> Any:
    descriptor = _manifest_setting_descriptor(manifest, name)
    setting_type = str(descriptor.get("type") or "string")
    normalized = _normalize_setting_type_value(setting_type, value)
    _validate_manifest_setting_rules(descriptor, normalized)
    return normalized


def validate_manifest_secret_name(manifest: dict[str, Any], name: str) -> None:
    _manifest_secret_descriptor(manifest, name)


def account_bridge_token_env(manifest: dict[str, Any]) -> str | None:
    """Return the env name of the credential the ClawHunt account bridge provisions.

    Single source of truth for "this secret is auto-provisioned from login state",
    reused by the config-status derivation, the manifest contract validator, and
    the runtime sidecar gate so the kernel and runtime never disagree about whether
    a bridged secret is something the user must enter.
    """
    bridge = manifest.get("clawhunt_account_bridge")
    if isinstance(bridge, dict) and bridge.get("type") == "pay_switch_agent_token":
        env = str(bridge.get("token_env") or "PAY_SWITCH_AGENT_TOKEN").strip()
        return env or None
    return None


def is_account_bridge_secret(manifest: dict[str, Any], name: str, env_name: str) -> bool:
    token_env = account_bridge_token_env(manifest)
    return bool(token_env and (env_name == token_env or name == token_env))


def validate_manifest_configuration_contract(manifest: dict[str, Any]) -> None:
    configuration = manifest.get("configuration")
    if not isinstance(configuration, dict):
        return

    setting_names: set[str] = set()
    for descriptor in configuration.get("settings", []) or []:
        if not isinstance(descriptor, dict):
            raise PluginConfigurationError("plugin setting descriptor must be an object")
        name = str(descriptor.get("name") or "")
        _validate_setting_name(name)
        if name in setting_names:
            raise PluginConfigurationError(f"duplicate plugin setting descriptor: {name}")
        setting_names.add(name)
        _validate_manifest_setting_descriptor(descriptor)
        # Tier contract: "basic" is the required, step-by-step tier and "advanced"
        # is optional. A required item hidden in the collapsed advanced tier would
        # let a surface report the plugin ready while a mandatory value is still
        # unset, so reject it fail-closed.
        if bool(descriptor.get("required")) and config_ui_is_advanced(descriptor.get("ui")):
            raise PluginConfigurationError(f"required plugin setting must not be advanced: {name}")

    secret_names: set[str] = set()
    for descriptor in configuration.get("secrets", []) or []:
        if not isinstance(descriptor, dict):
            raise PluginConfigurationError("plugin secret descriptor must be an object")
        name = str(descriptor.get("name") or "")
        env_name = str(descriptor.get("env_name") or name)
        _validate_secret_name(name)
        _validate_secret_name(env_name)
        if name in secret_names:
            raise PluginConfigurationError(f"duplicate plugin secret descriptor: {name}")
        secret_names.add(name)
        secret_ui = descriptor.get("ui")
        if secret_ui is not None and not isinstance(secret_ui, dict):
            raise PluginConfigurationError("plugin secret ui must be an object")
        if isinstance(secret_ui, dict):
            _validate_config_ui_tier(secret_ui)
        if bool(descriptor.get("required")) and config_ui_is_advanced(secret_ui):
            raise PluginConfigurationError(f"required plugin secret must not be advanced: {name}")
        # Auto-provisioned credentials are supplied by SuperClaw from login state,
        # so they can never be a user-required field. Reject required:true here so
        # the manifest contract, the config-status payload, and the runtime gate
        # all agree (otherwise the UI shows "not required" while the sidecar gate
        # still blocks with PLUGIN_CONFIG_REQUIRED).
        if bool(descriptor.get("required")) and is_account_bridge_secret(manifest, name, env_name):
            raise PluginConfigurationError(f"auto-provisioned plugin secret must not be required: {name}")


def set_plugin_secret(
    plugin_id: str,
    name: str,
    value: str,
    *,
    version_range: str | None = None,
    user_id: str | None = None,
    device_id: str | None = None,
    config_file: Path | None = None,
) -> PluginConfigWriteResult:
    _validate_plugin_id(plugin_id)
    _validate_secret_name(name)
    resolved_user_id, resolved_device_id = plugin_local_identity(user_id=user_id, device_id=device_id)
    try:
        normalized_version_range = normalize_version_range(version_range)
    except PluginVersionRangeError as exc:
        raise PluginConfigurationError("invalid plugin version range") from exc
    path = plugin_config_path(config_file)
    payload = _read_config(path)
    plugin = _plugin_record(payload, plugin_id)
    plugin.setdefault("secrets", {})[name] = {
        "value": value,
        "user_id": resolved_user_id,
        "device_id": resolved_device_id,
        "version_range": normalized_version_range,
        "updated_at": _utc_now(),
    }
    _write_config(path, payload)
    return PluginConfigWriteResult(plugin_id=plugin_id, name=name, config_file=path, version_range=normalized_version_range, user_id=resolved_user_id, device_id=resolved_device_id)


def delete_plugin_secret(plugin_id: str, name: str, *, user_id: str | None = None, device_id: str | None = None, config_file: Path | None = None) -> PluginConfigDeleteResult:
    _validate_plugin_id(plugin_id)
    _validate_secret_name(name)
    resolved_user_id, resolved_device_id = plugin_local_identity(user_id=user_id, device_id=device_id)
    path = plugin_config_path(config_file)
    payload = _read_config(path)
    plugin = _plugin_record(payload, plugin_id)
    secrets = plugin.setdefault("secrets", {})
    if not isinstance(secrets, dict):
        raise PluginConfigurationError("local plugin config has invalid secrets payload")
    record = secrets.get(name)
    deleted = isinstance(record, dict) and _record_matches_identity(record, resolved_user_id, resolved_device_id)
    if deleted:
        secrets.pop(name, None)
    _write_config(path, payload)
    return PluginConfigDeleteResult(plugin_id=plugin_id, name=name, config_file=path, deleted=deleted, user_id=resolved_user_id, device_id=resolved_device_id)


def plugin_secret_status(plugin_id: str, *, user_id: str | None = None, device_id: str | None = None, config_file: Path | None = None) -> list[dict[str, Any]]:
    _validate_plugin_id(plugin_id)
    resolved_user_id, resolved_device_id = plugin_local_identity(user_id=user_id, device_id=device_id)
    payload = _read_config(plugin_config_path(config_file))
    plugin = payload.get("plugins", {}).get(plugin_id, {})
    secrets = plugin.get("secrets", {}) if isinstance(plugin, dict) else {}
    return [
        {
            "name": name,
            "configured": True,
            "user_id": _record_user_id(record),
            "device_id": _record_device_id(record),
            "version_range": str(record.get("version_range") or "*"),
            "updated_at": record.get("updated_at"),
        }
        for name, record in sorted(secrets.items())
        if isinstance(record, dict) and "value" in record and _record_matches_identity(record, resolved_user_id, resolved_device_id)
    ]


def plugin_setting_status(plugin_id: str, *, config_file: Path | None = None) -> list[dict[str, Any]]:
    _validate_plugin_id(plugin_id)
    payload = _read_config(plugin_config_path(config_file))
    plugin = payload.get("plugins", {}).get(plugin_id, {})
    settings = plugin.get("settings", {}) if isinstance(plugin, dict) else {}
    configured_settings: list[dict[str, Any]] = []
    for name, record in sorted(settings.items()):
        if not isinstance(record, dict) or "value" not in record:
            continue
        value = _clean_plain_config_value(record.get("value"))
        if value is None:
            continue
        configured_settings.append(
            {
                "name": name,
                "configured": True,
                "value": value,
                "updated_at": record.get("updated_at"),
            }
        )
    return configured_settings


def plugin_configuration_status(
    plugin_id: str,
    manifest: dict[str, Any],
    *,
    plugin_version: str | None = None,
    user_id: str | None = None,
    device_id: str | None = None,
    config_file: Path | None = None,
) -> dict[str, list[dict[str, Any]]]:
    _validate_plugin_id(plugin_id)
    settings_payload = {item["name"]: item for item in plugin_setting_status(plugin_id, config_file=config_file)}
    secret_payload = {item["name"]: item for item in plugin_secret_status(plugin_id, user_id=user_id, device_id=device_id, config_file=config_file)}

    # Account-bridge-managed config is never user-facing basic setup. The bridge
    # (part of the signed package, so this survives reinstall without any ui edit)
    # declares the credential env it auto-provisions plus the service-endpoint
    # envs it manages; the kernel folds all of them into the advanced tier so only
    # genuine user steps stay in the basic checklist.
    bridge = manifest.get("clawhunt_account_bridge")
    auto_provision_env = account_bridge_token_env(manifest)
    bridge_endpoint_envs: set[str] = set()
    if isinstance(bridge, dict) and bridge.get("type") == "pay_switch_agent_token":
        for endpoint_key in ("config_url_env", "panel_url_env"):
            endpoint_env = str(bridge.get(endpoint_key) or "").strip()
            if endpoint_env:
                bridge_endpoint_envs.add(endpoint_env)

    settings: list[dict[str, Any]] = []
    for descriptor in manifest.get("configuration", {}).get("settings", []):
        if not isinstance(descriptor, dict):
            continue
        name = str(descriptor.get("name") or "")
        if not name or not SETTING_NAME_RE.fullmatch(name):
            continue
        configured = settings_payload.get(name)
        setting_env = str(descriptor.get("env_name") or "").strip()
        ui = descriptor.get("ui") if isinstance(descriptor.get("ui"), dict) else {}
        required = bool(descriptor.get("required"))
        # Service endpoints managed by the account bridge (config/panel URLs) are
        # not user setup — fold them into advanced and never require them.
        if setting_env and setting_env in bridge_endpoint_envs:
            ui = {**ui, "section": "advanced"}
            required = False
        settings.append(
            {
                "name": name,
                "type": descriptor.get("type"),
                "env_name": descriptor.get("env_name") if SECRET_NAME_RE.fullmatch(str(descriptor.get("env_name") or "")) else None,
                "description": descriptor.get("description"),
                "default": descriptor.get("default"),
                "validation": descriptor.get("validation") if isinstance(descriptor.get("validation"), dict) else {},
                "ui": ui,
                "required": required,
                "configured": bool(configured),
                "value": configured.get("value") if configured else descriptor.get("default"),
                "updated_at": configured.get("updated_at") if configured else None,
                # Dynamic config protocol: a setting may declare an options_source
                # (a plugin tool the config UI calls to populate a searchable
                # select at config time) and/or actions (plugin tools the config
                # UI exposes as buttons, e.g. "bind profile" / "login").
                "options_source": _normalize_config_invocation(descriptor.get("options_source")),
                "actions": [
                    inv
                    for inv in (_normalize_config_invocation(a) for a in (descriptor.get("actions") or []))
                    if inv is not None
                ],
            }
        )

    secrets: list[dict[str, Any]] = []
    for descriptor in manifest.get("configuration", {}).get("secrets", []):
        if not isinstance(descriptor, dict):
            continue
        name = str(descriptor.get("name") or "")
        env_name = str(descriptor.get("env_name") or name)
        if not name or not SECRET_NAME_RE.fullmatch(name) or not SECRET_NAME_RE.fullmatch(env_name):
            continue
        configured = secret_payload.get(name)
        if configured and plugin_version is not None and configured.get("version_range") not in {None, "*"}:
            try:
                if not version_satisfies_range(plugin_version, str(configured.get("version_range"))):
                    configured = None
            except PluginVersionRangeError as exc:
                raise PluginConfigurationError("local plugin secret has invalid version range") from exc

        is_auto_provisioned = bool(auto_provision_env and (env_name == auto_provision_env or name == auto_provision_env))
        ui = descriptor.get("ui") if isinstance(descriptor.get("ui"), dict) else {}
        required = bool(descriptor.get("required"))

        if is_auto_provisioned:
            ui = {**ui, "section": "advanced"}
            required = False

        secrets.append(
            {
                "name": name,
                "env_name": env_name,
                "description": descriptor.get("description"),
                "ui": ui,
                "required": required,
                "configured": bool(configured),
                "version_range": configured.get("version_range") if configured else None,
                "updated_at": configured.get("updated_at") if configured else None,
                "auto_provisioned": is_auto_provisioned,
                "provisioning_provider": "ClawHunt Account" if is_auto_provisioned else None,
                "provisioning_status": ("available" if clawhunt_auth.saved_clawhunt_access_token() else "unavailable") if is_auto_provisioned else None,
            }
        )

    return {"settings": settings, "secrets": secrets}


def load_plugin_secret_environment(
    plugin_id: str,
    manifest: dict[str, Any],
    *,
    plugin_version: str | None = None,
    user_id: str | None = None,
    device_id: str | None = None,
    config_file: Path | None = None,
) -> dict[str, str]:
    """Return only manifest-declared secret values from local SuperClaw config."""
    _validate_plugin_id(plugin_id)
    resolved_user_id, resolved_device_id = plugin_local_identity(user_id=user_id, device_id=device_id)
    payload = _read_config(plugin_config_path(config_file))
    plugin = payload.get("plugins", {}).get(plugin_id, {})
    secrets = plugin.get("secrets", {}) if isinstance(plugin, dict) else {}
    env: dict[str, str] = {}
    for descriptor in manifest.get("configuration", {}).get("secrets", []):
        if not isinstance(descriptor, dict):
            continue
        name = str(descriptor.get("name") or "")
        env_name = str(descriptor.get("env_name") or name)
        if not name or not SECRET_NAME_RE.fullmatch(name) or not SECRET_NAME_RE.fullmatch(env_name):
            continue
        record = secrets.get(name)
        if isinstance(record, dict) and isinstance(record.get("value"), str):
            if not _record_matches_identity(record, resolved_user_id, resolved_device_id):
                continue
            version_range = str(record.get("version_range") or "*")
            try:
                if plugin_version is None and normalize_version_range(version_range) != "*":
                    continue
                if plugin_version is not None and not version_satisfies_range(plugin_version, version_range):
                    continue
            except PluginVersionRangeError as exc:
                raise PluginConfigurationError("local plugin secret has invalid version range") from exc
            env[env_name] = str(record["value"])
    return env


def load_plugin_setting_environment(
    plugin_id: str,
    manifest: dict[str, Any],
    *,
    config_file: Path | None = None,
) -> dict[str, str]:
    """Return manifest-declared non-secret settings as environment variables.

    A setting may declare ``env_name`` (an UPPER_SNAKE env var). Its configured
    value (or, if unset, its manifest default) is exported under that name so the
    plugin sidecar receives the user's configuration at runtime — the runtime
    half of the config protocol. Only declared settings with an ``env_name`` and
    a non-empty value are emitted.
    """
    _validate_plugin_id(plugin_id)
    payload = _read_config(plugin_config_path(config_file))
    plugin = payload.get("plugins", {}).get(plugin_id, {})
    settings = plugin.get("settings", {}) if isinstance(plugin, dict) else {}
    env: dict[str, str] = {}
    for descriptor in manifest.get("configuration", {}).get("settings", []):
        if not isinstance(descriptor, dict):
            continue
        name = str(descriptor.get("name") or "")
        env_name = str(descriptor.get("env_name") or "")
        if not name or not SETTING_NAME_RE.fullmatch(name) or not env_name or not SECRET_NAME_RE.fullmatch(env_name):
            continue
        record = settings.get(name) if isinstance(settings, dict) else None
        value: Any = record.get("value") if isinstance(record, dict) else None
        if value is None:
            value = descriptor.get("default")
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        env[env_name] = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return env


def _record_user_id(record: dict[str, Any]) -> str:
    return str(record.get("user_id") or DEFAULT_PLUGIN_USER_ID)


def _record_device_id(record: dict[str, Any]) -> str:
    return str(record.get("device_id") or DEFAULT_PLUGIN_DEVICE_ID)


def _record_matches_identity(record: dict[str, Any], user_id: str, device_id: str) -> bool:
    return _record_user_id(record) == user_id and _record_device_id(record) == device_id


def _plugin_record(payload: dict[str, Any], plugin_id: str) -> dict[str, Any]:
    plugins = payload.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        raise PluginConfigurationError("local plugin config has invalid plugins payload")
    plugin = plugins.setdefault(plugin_id, {})
    if not isinstance(plugin, dict):
        raise PluginConfigurationError("local plugin config has invalid plugin record")
    return plugin


def _read_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"plugins": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PluginConfigurationError("local plugin config is invalid JSON") from exc
    if not isinstance(payload, dict):
        raise PluginConfigurationError("local plugin config must be a JSON object")
    payload.setdefault("plugins", {})
    return payload


def _write_config(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _validate_plugin_id(plugin_id: str) -> None:
    if not PLUGIN_ID_RE.fullmatch(plugin_id):
        raise PluginConfigurationError("invalid plugin id")


def _validate_identity_id(value: str, label: str) -> None:
    if not IDENTITY_ID_RE.fullmatch(value):
        raise PluginConfigurationError(f"invalid plugin {label}")


def _validate_setting_name(name: str) -> None:
    if not SETTING_NAME_RE.fullmatch(name):
        raise PluginConfigurationError("invalid plugin setting name")


def _validate_secret_name(name: str) -> None:
    if not SECRET_NAME_RE.fullmatch(name):
        raise PluginConfigurationError("invalid plugin secret name")


def _contains_control_character(value: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _manifest_setting_descriptor(manifest: dict[str, Any], name: str) -> dict[str, Any]:
    _validate_setting_name(name)
    for descriptor in manifest.get("configuration", {}).get("settings", []):
        if isinstance(descriptor, dict) and descriptor.get("name") == name:
            return descriptor
    raise PluginConfigurationError("plugin setting is not declared by manifest")


def _manifest_secret_descriptor(manifest: dict[str, Any], name: str) -> dict[str, Any]:
    _validate_secret_name(name)
    for descriptor in manifest.get("configuration", {}).get("secrets", []):
        if isinstance(descriptor, dict) and descriptor.get("name") == name:
            return descriptor
    raise PluginConfigurationError("plugin secret is not declared by manifest")


def _validate_manifest_setting_descriptor(descriptor: dict[str, Any]) -> None:
    setting_type = str(descriptor.get("type") or "")
    if setting_type not in {"string", "integer", "number", "boolean"}:
        raise PluginConfigurationError("plugin setting has unsupported type")
    validation = descriptor.get("validation")
    if validation is not None and not isinstance(validation, dict):
        raise PluginConfigurationError("plugin setting validation must be an object")
    ui = descriptor.get("ui")
    if ui is not None and not isinstance(ui, dict):
        raise PluginConfigurationError("plugin setting ui must be an object")
    env_name = descriptor.get("env_name")
    if env_name is not None and (not isinstance(env_name, str) or not SECRET_NAME_RE.fullmatch(env_name)):
        raise PluginConfigurationError("plugin setting env_name must be an UPPER_SNAKE_CASE identifier")
    _validate_setting_validation_shape(setting_type, validation if isinstance(validation, dict) else {})
    _validate_setting_ui_shape(
        setting_type,
        validation if isinstance(validation, dict) else {},
        ui if isinstance(ui, dict) else {},
        has_dynamic_options=_normalize_config_invocation(descriptor.get("options_source")) is not None,
    )
    if "default" in descriptor:
        normalized_default = _normalize_setting_type_value(setting_type, descriptor.get("default"))
        _validate_manifest_setting_rules(descriptor, normalized_default)
    enum_values = validation.get("enum") if isinstance(validation, dict) else None
    if isinstance(enum_values, list):
        for item in enum_values:
            if not _value_matches_setting_type(setting_type, item):
                raise PluginConfigurationError("plugin setting enum values must match setting type")
            _validate_manifest_setting_rules({**descriptor, "validation": {key: value for key, value in validation.items() if key != "enum"}}, item)


def _normalize_setting_type_value(setting_type: str, value: Any) -> Any:
    if setting_type == "string":
        if not isinstance(value, str):
            raise PluginConfigurationError("plugin setting value must be a string")
        return value
    if setting_type == "integer":
        if isinstance(value, bool):
            raise PluginConfigurationError("plugin setting value must be an integer")
        if isinstance(value, int):
            return value
        if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
            return int(value.strip())
        raise PluginConfigurationError("plugin setting value must be an integer")
    if setting_type == "number":
        if isinstance(value, bool):
            raise PluginConfigurationError("plugin setting value must be a number")
        if isinstance(value, int | float):
            return value
        if isinstance(value, str):
            try:
                parsed = float(value.strip())
            except ValueError as exc:
                raise PluginConfigurationError("plugin setting value must be a number") from exc
            if parsed.is_integer():
                return int(parsed)
            return parsed
        raise PluginConfigurationError("plugin setting value must be a number")
    if setting_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
            return value.strip().lower() == "true"
        raise PluginConfigurationError("plugin setting value must be a boolean")
    raise PluginConfigurationError("plugin setting has unsupported type")


def _validate_manifest_setting_rules(descriptor: dict[str, Any], value: Any) -> None:
    _validate_plain_config_value(value, "plugin setting value")
    validation = descriptor.get("validation")
    if not isinstance(validation, dict):
        return
    enum_values = validation.get("enum")
    if isinstance(enum_values, list) and value not in enum_values:
        raise PluginConfigurationError("plugin setting value is not an allowed option")
    if isinstance(value, str):
        min_length = validation.get("minLength")
        max_length = validation.get("maxLength")
        pattern = validation.get("pattern")
        if isinstance(min_length, int) and len(value) < min_length:
            raise PluginConfigurationError("plugin setting value is too short")
        if isinstance(max_length, int) and len(value) > max_length:
            raise PluginConfigurationError("plugin setting value is too long")
        if isinstance(pattern, str) and not re.fullmatch(pattern, value):
            raise PluginConfigurationError("plugin setting value does not match required pattern")
        if validation.get("format") == "uri" and not _is_valid_uri(value):
            raise PluginConfigurationError("plugin setting value must be a valid URI")
    if isinstance(value, int | float) and not isinstance(value, bool):
        minimum = validation.get("minimum")
        maximum = validation.get("maximum")
        step = validation.get("step")
        if isinstance(minimum, int | float) and value < minimum:
            raise PluginConfigurationError("plugin setting value is below minimum")
        if isinstance(maximum, int | float) and value > maximum:
            raise PluginConfigurationError("plugin setting value is above maximum")
        if isinstance(step, int | float):
            base = minimum if isinstance(minimum, int | float) else 0
            quotient = (float(value) - float(base)) / float(step)
            if not math.isclose(quotient, round(quotient), rel_tol=0, abs_tol=1e-9):
                raise PluginConfigurationError("plugin setting value does not match required step")


def _validate_setting_validation_shape(setting_type: str, validation: dict[str, Any]) -> None:
    has_numeric_rule = any(key in validation for key in ("minimum", "maximum", "step"))
    has_string_rule = any(key in validation for key in ("minLength", "maxLength", "pattern", "format"))
    if has_numeric_rule and setting_type not in {"integer", "number"}:
        raise PluginConfigurationError("numeric validation rules require integer or number setting type")
    if has_string_rule and setting_type != "string":
        raise PluginConfigurationError("string validation rules require string setting type")
    minimum = validation.get("minimum")
    maximum = validation.get("maximum")
    if isinstance(minimum, int | float) and isinstance(maximum, int | float) and minimum > maximum:
        raise PluginConfigurationError("plugin setting minimum must be less than or equal to maximum")
    min_length = validation.get("minLength")
    max_length = validation.get("maxLength")
    if isinstance(min_length, int) and isinstance(max_length, int) and min_length > max_length:
        raise PluginConfigurationError("plugin setting minLength must be less than or equal to maxLength")
    if "format" in validation and validation.get("format") != "uri":
        raise PluginConfigurationError("plugin setting validation format is unsupported")


def config_ui_is_advanced(ui: Any) -> bool:
    """Return True when a setting/secret opts into the collapsed advanced tier.

    The single source of truth for tier classification, shared by the kernel and
    mirrored verbatim by every surface: an item is advanced iff it declares
    ``ui.section == "advanced"`` or the legacy boolean ``ui.advanced is True``.
    Everything else (including missing ui) is a basic, up-front step.
    """
    if not isinstance(ui, dict):
        return False
    return ui.get("section") == "advanced" or ui.get("advanced") is True


def _validate_config_ui_tier(ui: dict[str, Any]) -> None:
    """Validate the two-tier (basic / advanced + step ordering) UI metadata.

    Shared by setting and secret descriptors so the tier contract is enforced
    identically wherever configuration is declared (see CONFIG_UI_SECTIONS).
    Unknown keys are tolerated (forward-compat), but the tiering keys must have
    the right shape or the manifest is rejected fail-closed at install time.
    """
    section = ui.get("section")
    if section is not None and section not in CONFIG_UI_SECTIONS:
        raise PluginConfigurationError('plugin config ui section must be "basic" or "advanced"')
    advanced = ui.get("advanced")
    if advanced is not None and not isinstance(advanced, bool):
        raise PluginConfigurationError("plugin config ui advanced flag must be a boolean")
    step = ui.get("step")
    if step is not None and (isinstance(step, bool) or not isinstance(step, int) or step < 1):
        raise PluginConfigurationError("plugin config ui step must be a positive integer")
    for key in ("label", "help", "placeholder", "step_title", "step_description"):
        if key in ui and not isinstance(ui[key], str):
            raise PluginConfigurationError(f"plugin config ui {key} must be a string")


def _validate_setting_ui_shape(setting_type: str, validation: dict[str, Any], ui: dict[str, Any], *, has_dynamic_options: bool = False) -> None:
    _validate_config_ui_tier(ui)
    control = ui.get("control")
    if control is None:
        return
    if control == "switch" and setting_type != "boolean":
        raise PluginConfigurationError("switch control requires boolean setting type")
    if control == "number" and setting_type not in {"integer", "number"}:
        raise PluginConfigurationError("number control requires integer or number setting type")
    if control in {"text", "textarea", "url"} and setting_type != "string":
        raise PluginConfigurationError(f"{control} control requires string setting type")
    if control == "url" and validation.get("format") != "uri":
        raise PluginConfigurationError("url control requires validation.format=uri")
    if control == "select" and not isinstance(validation.get("enum"), list) and not has_dynamic_options:
        raise PluginConfigurationError("select control requires validation.enum or a dynamic options_source")


def _value_matches_setting_type(setting_type: str, value: Any) -> bool:
    if setting_type == "string":
        return isinstance(value, str)
    if setting_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if setting_type == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if setting_type == "boolean":
        return isinstance(value, bool)
    return False


def _is_valid_uri(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _clean_plain_config_value(value: Any) -> Any | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value
    if not isinstance(value, str):
        return None
    if _contains_control_character(value):
        return None
    return value


def _validate_plain_config_value(value: Any, label: str) -> None:
    if isinstance(value, str) and _contains_control_character(value):
        raise PluginConfigurationError(f"{label} must not contain control characters")
    if isinstance(value, list | dict) or value is None:
        raise PluginConfigurationError(f"{label} must be a scalar value")


def _utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
