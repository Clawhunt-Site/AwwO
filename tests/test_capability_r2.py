from __future__ import annotations

import json
from pathlib import Path

from superclaw.capability_r2 import (
    CapabilityR2Config,
    CapabilityR2Error,
    get_r2_object_text,
    list_r2_object_keys,
    load_r2_config,
    publish_local_capability_cloud_to_r2,
)
from superclaw.capability_registry import CapabilityRegistryClient, latest_approved_capability_manifests


def _write_cloud(root: Path) -> None:
    registry = {
        "schema_version": "clawhunt.admin.capability_registry.v1",
        "entries": [
            {
                "kind": "skill",
                "capability_id": "skill.r2-smoke",
                "version": "0.1.0",
                "status": "published",
                "package_digest": "sha256:" + "a" * 64,
                "metadata": {
                    "artifact": {
                        "digest": "sha256:" + "a" * 64,
                        "ref": "superclaw-object://capabilities/skill/r2-smoke/versions/0.1.0/artifacts/" + "a" * 64,
                    }
                },
            }
        ],
    }
    (root / "registry").mkdir(parents=True)
    (root / "registry" / "capabilities.json").write_text(json.dumps(registry), encoding="utf-8")
    artifact = root / "artifacts" / "capabilities" / ("a" * 64) / "artifact"
    artifact.mkdir(parents=True)
    (artifact / "SKILL.md").write_text("# smoke\n", encoding="utf-8")


def _config() -> CapabilityR2Config:
    return CapabilityR2Config(
        endpoint_url="https://example.r2.cloudflarestorage.com",
        access_key_id="access-key",
        secret_access_key="secret-key",
        registry_bucket="registry-bucket",
        artifact_bucket="artifact-bucket",
    )


def test_publish_local_capability_cloud_to_r2_uses_registry_and_artifact_buckets(tmp_path: Path):
    _write_cloud(tmp_path)
    commands: list[list[str]] = []

    def fake_runner(command, *, config):
        commands.append(command)

    payload = publish_local_capability_cloud_to_r2(
        tmp_path,
        config=_config(),
        prefix="prod",
        runner=fake_runner,
    )

    assert payload["ok"] is True
    assert payload["registry"]["source"] == "r2://registry-bucket/prod/capabilities.json"
    assert payload["artifact_count"] == 1
    put_registry = [cmd for cmd in commands if "put-object" in cmd and "registry-bucket" in cmd]
    put_artifact = [cmd for cmd in commands if "put-object" in cmd and "artifact-bucket" in cmd]
    head_registry = [cmd for cmd in commands if "head-object" in cmd and "registry-bucket" in cmd]
    assert put_registry and put_registry[0][put_registry[0].index("--key") + 1] == "prod/capabilities.json"
    assert put_artifact and put_artifact[0][put_artifact[0].index("--key") + 1].endswith("/artifact/SKILL.md")
    assert head_registry
    assert all("secret-key" not in " ".join(cmd) for cmd in commands)


def test_publish_local_capability_cloud_to_r2_dry_run_does_not_call_runner(tmp_path: Path):
    _write_cloud(tmp_path)
    called = False

    def fake_runner(command, *, config):
        nonlocal called
        called = True

    payload = publish_local_capability_cloud_to_r2(tmp_path, config=_config(), prefix="smoke", dry_run=True, runner=fake_runner)

    assert payload["dry_run"] is True
    assert called is False
    assert payload["registry"]["key"] == "smoke/capabilities.json"
    assert payload["artifact_count"] == 1


def test_get_r2_object_text_downloads_private_registry_to_temp_file():
    def fake_runner(command, *, config):
        target = Path(command[-1])
        target.write_text('{"schema_version":"clawhunt.admin.capability_registry.v1","entries":[]}', encoding="utf-8")

    text = get_r2_object_text("r2://registry-bucket/capabilities.json", config=_config(), runner=fake_runner)

    assert json.loads(text)["entries"] == []


class _FakeCompleted:
    def __init__(self, stdout: str):
        self.stdout = stdout


def test_load_r2_config_normalizes_unreadable_env_file_to_capability_error(tmp_path: Path):
    # A filesystem fault reading the env file (here: the path is a directory, so
    # read_text raises IsADirectoryError, an OSError) must surface as CapabilityR2Error,
    # NOT a raw OSError — otherwise callers that only catch CapabilityR2Error (e.g. the
    # install/distribution endpoints) would leak a 500 instead of failing closed.
    bad = tmp_path / "r2.env"
    bad.mkdir()
    try:
        load_r2_config(env_file=bad)
    except CapabilityR2Error:
        pass
    except OSError as exc:  # pragma: no cover - explicit failure path
        raise AssertionError(f"OSError leaked instead of CapabilityR2Error: {exc}") from exc
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("expected CapabilityR2Error for an unreadable env file")


def test_list_r2_object_keys_returns_present_keys_with_one_call():
    seen: list[list[str]] = []
    keys = [
        "capabilities/plugin/a/versions/1.0.0/package.scplug",
        "capabilities/plugin/b/versions/2.0.0/package.scplug",
    ]

    def fake_runner(command, *, config):
        seen.append(command)
        return _FakeCompleted(json.dumps({"Contents": [{"Key": k} for k in keys]}))

    result = list_r2_object_keys("artifact-bucket", "capabilities/plugin/", config=_config(), runner=fake_runner)
    assert result == set(keys)
    # One logical call (list-objects-v2), not one head-object per key.
    assert len(seen) == 1
    assert "list-objects-v2" in seen[0]
    assert seen[0][seen[0].index("--prefix") + 1] == "capabilities/plugin/"


def test_list_r2_object_keys_empty_on_no_contents():
    def fake_runner(command, *, config):
        return _FakeCompleted(json.dumps({}))

    assert list_r2_object_keys("artifact-bucket", "capabilities/plugin/", config=_config(), runner=fake_runner) == set()


def test_list_r2_object_keys_raises_on_runner_failure():
    # A list failure must surface (caller fails closed), not silently read as "no keys".
    def fake_runner(command, *, config):
        raise CapabilityR2Error("AccessDenied")

    try:
        list_r2_object_keys("artifact-bucket", "capabilities/plugin/", config=_config(), runner=fake_runner)
    except CapabilityR2Error:
        pass
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("expected CapabilityR2Error to propagate")


def test_list_r2_object_keys_raises_on_malformed_json():
    def fake_runner(command, *, config):
        return _FakeCompleted("not json{")

    try:
        list_r2_object_keys("artifact-bucket", "capabilities/plugin/", config=_config(), runner=fake_runner)
    except CapabilityR2Error:
        pass
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("expected CapabilityR2Error on malformed list response")


def test_capability_registry_client_loads_r2_source(monkeypatch):
    from superclaw import capability_r2

    monkeypatch.setattr(
        capability_r2,
        "get_r2_object_text",
        lambda uri: json.dumps(
            {
                "schema_version": "clawhunt.admin.capability_registry.v1",
                "entries": [
                    {
                        "kind": "company",
                        "capability_id": "company.r2",
                        "version": "1.0.0",
                        "status": "published",
                        "package_digest": "sha256:" + "b" * 64,
                    }
                ],
            }
        ),
    )

    entries = CapabilityRegistryClient("r2://registry-bucket/capabilities.json").load()

    assert len(entries) == 1
    assert entries[0].kind == "company"
    assert entries[0].capability_id == "company.r2"


def test_latest_approved_capability_manifests_loads_r2_source(monkeypatch, tmp_path: Path):
    from superclaw import capability_r2

    monkeypatch.setattr(
        capability_r2,
        "get_r2_object_text",
        lambda uri: json.dumps(
            {
                "schema_version": "clawhunt.admin.capability_registry.v1",
                "entries": [
                    {
                        "kind": "skill",
                        "capability_id": "skill.r2",
                        "version": "1.0.0",
                        "status": "published",
                        "package_digest": "sha256:" + "c" * 64,
                    }
                ],
            }
        ),
    )

    manifests = latest_approved_capability_manifests(tmp_path, source="r2://registry-bucket/capabilities.json")

    assert len(manifests) == 1
    assert manifests[0]["kind"] == "skill"
    assert manifests[0]["capability_id"] == "skill.r2"
