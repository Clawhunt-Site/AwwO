from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from superclaw.process_scripts import command_for_script


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SCHEMA_PATH = ROOT / "schemas" / "superclaw-plugin.schema.json"
CONFIG_SCHEMA_PATH = ROOT / "schemas" / "plugin-configuration-policy.schema.json"
EVIDENCE_SCHEMA_PATH = ROOT / "schemas" / "plugin-invocation-evidence.schema.json"

VALID_PLUGIN_DIRS = [
    ROOT / "examples" / "plugins" / "hello-world",
    ROOT / "examples" / "plugins" / "repo-scanner",
    ROOT / "examples" / "plugins" / "github-scanner",
]


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(path: Path) -> Draft202012Validator:
    schema = _load_json(path)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _non_expensive_manifest() -> dict:
    manifest = _load_json(ROOT / "examples" / "plugins" / "hello-world" / "superclaw-plugin.json")
    manifest.pop("resource_profile", None)
    manifest["acceptance"]["latency_budget_ms"] = 1000
    manifest["limits"] = {
        "startup_timeout_ms": 1000,
        "tool_timeout_ms": 10000,
        "max_model_output_bytes": 32768,
        "max_evidence_bytes": 1048576,
        "max_memory_mb": 256,
    }
    return manifest


def test_phase0_schemas_are_valid_json_schema_documents():
    for path in [PLUGIN_SCHEMA_PATH, CONFIG_SCHEMA_PATH, EVIDENCE_SCHEMA_PATH]:
        Draft202012Validator.check_schema(_load_json(path))


@pytest.mark.parametrize("plugin_dir", VALID_PLUGIN_DIRS)
def test_valid_plugin_manifests_validate_and_reference_existing_files(plugin_dir: Path):
    manifest = _load_json(plugin_dir / "superclaw-plugin.json")
    _validator(PLUGIN_SCHEMA_PATH).validate(manifest)

    referenced_paths = [
        manifest["runtime"]["entrypoint"],
        *manifest["acceptance"]["tests"],
        *manifest["acceptance"]["evidence_fixtures"],
    ]
    for relative_path in referenced_paths:
        assert (plugin_dir / relative_path).exists(), f"missing fixture path: {relative_path}"


def test_invalid_manifest_fails_for_missing_id_with_deterministic_error():
    invalid_manifest = _load_json(ROOT / "examples" / "plugins" / "invalid-missing-id" / "superclaw-plugin.json")

    with pytest.raises(ValidationError) as exc_info:
        _validator(PLUGIN_SCHEMA_PATH).validate(invalid_manifest)

    assert "'id' is a required property" in str(exc_info.value)


def test_plugin_manifest_accepts_optional_package_local_logo():
    manifest = _load_json(ROOT / "examples" / "plugins" / "hello-world" / "superclaw-plugin.json")
    manifest["logo"] = "assets/logo.svg"

    _validator(PLUGIN_SCHEMA_PATH).validate(manifest)


def test_plugin_manifest_rejects_logo_paths_that_escape_package():
    manifest = _load_json(ROOT / "examples" / "plugins" / "hello-world" / "superclaw-plugin.json")
    manifest["logo"] = "../logo.svg"

    with pytest.raises(ValidationError):
        _validator(PLUGIN_SCHEMA_PATH).validate(manifest)


@pytest.mark.parametrize(
    ("limit_name", "over_budget_value"),
    [
        ("startup_timeout_ms", 3001),
        ("tool_timeout_ms", 30001),
        ("max_model_output_bytes", 65537),
        ("max_evidence_bytes", 5242881),
        ("max_memory_mb", 513),
    ],
)
def test_manifest_limits_cannot_exceed_v1_platform_budgets(
    limit_name: str, over_budget_value: int
):
    manifest = _load_json(ROOT / "examples" / "plugins" / "repo-scanner" / "superclaw-plugin.json")
    manifest["limits"][limit_name] = over_budget_value

    with pytest.raises(ValidationError) as exc_info:
        _validator(PLUGIN_SCHEMA_PATH).validate(manifest)

    assert "is greater than the maximum" in str(exc_info.value)


def test_non_expensive_manifest_can_omit_resource_profile():
    _validator(PLUGIN_SCHEMA_PATH).validate(_non_expensive_manifest())


@pytest.mark.parametrize(
    ("section_name", "field_name", "expensive_value"),
    [
        ("acceptance", "latency_budget_ms", 10001),
        ("limits", "tool_timeout_ms", 10001),
        ("limits", "max_model_output_bytes", 32769),
        ("limits", "max_evidence_bytes", 1048577),
        ("limits", "max_memory_mb", 257),
    ],
)
def test_expensive_manifest_requires_resource_profile(
    section_name: str, field_name: str, expensive_value: int
):
    manifest = _non_expensive_manifest()
    manifest[section_name][field_name] = expensive_value

    with pytest.raises(ValidationError) as exc_info:
        _validator(PLUGIN_SCHEMA_PATH).validate(manifest)

    assert "'resource_profile' is a required property" in str(exc_info.value)


def test_resource_profile_rejects_unknown_classes():
    manifest = _load_json(ROOT / "examples" / "plugins" / "repo-scanner" / "superclaw-plugin.json")
    manifest["resource_profile"]["latency_class"] = "instant"

    with pytest.raises(ValidationError) as exc_info:
        _validator(PLUGIN_SCHEMA_PATH).validate(manifest)

    assert "'instant' is not one of" in str(exc_info.value)


def test_configuration_policy_fixture_validates_without_secret_values():
    policy = _load_json(ROOT / "examples" / "plugins" / "github-scanner" / "configuration-policy.json")

    _validator(CONFIG_SCHEMA_PATH).validate(policy)
    serialized = json.dumps(policy).lower()
    assert "secret_value" not in serialized
    assert "value" not in policy["secrets"][0]
    assert "ghp_" not in serialized
    assert "github_pat_" not in serialized


@pytest.mark.parametrize("plugin_dir", VALID_PLUGIN_DIRS)
def test_evidence_fixtures_validate(plugin_dir: Path):
    manifest = _load_json(plugin_dir / "superclaw-plugin.json")
    validator = _validator(EVIDENCE_SCHEMA_PATH)

    for relative_path in manifest["acceptance"]["evidence_fixtures"]:
        evidence = _load_json(plugin_dir / relative_path)
        validator.validate(evidence)
        assert evidence["plugin_id"] == manifest["id"]
        assert evidence["plugin_version"] == manifest["version"]


@pytest.mark.parametrize("plugin_dir", VALID_PLUGIN_DIRS)
def test_smoke_scripts_pass_without_cloud_credentials(plugin_dir: Path):
    for relative_path in _load_json(plugin_dir / "superclaw-plugin.json")["acceptance"]["tests"]:
        result = subprocess.run(
            command_for_script(plugin_dir / relative_path),
            cwd=plugin_dir,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        assert result.returncode == 0, result.stderr or result.stdout


def test_developer_guide_references_phase0_artifacts():
    guide = (ROOT / "docs" / "plugin-developer-guide.md").read_text(encoding="utf-8")

    for relative_path in [
        "schemas/superclaw-plugin.schema.json",
        "schemas/plugin-configuration-policy.schema.json",
        "schemas/plugin-invocation-evidence.schema.json",
        "examples/plugins/hello-world",
        "examples/plugins/repo-scanner",
        "examples/plugins/github-scanner",
        "examples/plugins/invalid-missing-id",
    ]:
        assert relative_path in guide
        assert (ROOT / relative_path).exists()
