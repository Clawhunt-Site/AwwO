from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from superclaw.plugins import MANIFEST_NAME, compute_package_digest, load_plugin_package


INGESTION_METADATA_NAME = "clawhunt-ingestion.json"
MCP_SERVER_CONFIG_NAME = "mcp/server.json"
REPLAY_FIXTURE_NAME = "replay/plugin-invocation.json"
STAGING_SIGNATURE = "ed25519:unsigned"


class ClawHuntPluginIngestionError(ValueError):
    """Raised when a ClawHunt delivery cannot become a reusable plugin package."""


@dataclass(frozen=True)
class ClawHuntPluginIngestionResult:
    plugin_id: str
    version: str
    package_root: Path
    manifest_path: Path
    metadata_path: Path
    source_digest: str
    package_digest: str


def ingest_clawhunt_delivery_plugin(
    delivery_root: Path,
    *,
    manifest_path: Path | None = None,
    output_root: Path,
) -> ClawHuntPluginIngestionResult:
    """Build an unsigned local plugin package from a reusable ClawHunt delivery.

    The package is intentionally staged, not platform-signed. A later signing
    step must replace the staging signature before runtime verification accepts it.
    """
    root = delivery_root.resolve()
    manifest_file = (root / (manifest_path or Path("delivery-manifest.json"))).resolve()
    _ensure_inside(root, manifest_file)
    delivery_manifest = _read_json(manifest_file)
    _validate_delivery_manifest(delivery_manifest)
    _validate_declared_files(root, delivery_manifest)

    wrapper = delivery_manifest["wrapper"]
    plugin_id = str(wrapper["plugin_id"])
    version = str(wrapper.get("version") or "0.1.0")
    # plugin_id/version come from the (untrusted) delivery manifest and are joined
    # into a path that is rmtree'd + written. Reject absolute/".."/empty segments
    # and require the resolved destination to live strictly under output_root, or a
    # malicious manifest could delete/overwrite arbitrary directories.
    _assert_safe_relative_path(plugin_id)
    _assert_safe_relative_path(version)
    output_resolved = output_root.resolve()
    package_root = (output_resolved / plugin_id / version).resolve()
    if output_resolved not in package_root.parents:
        raise ClawHuntPluginIngestionError(
            f"unsafe plugin package destination: {plugin_id}/{version}"
        )
    if package_root.exists():
        shutil.rmtree(package_root)
    package_root.mkdir(parents=True)

    copied_paths = _copy_declared_files(root, package_root, delivery_manifest)
    plugin_manifest = _build_plugin_manifest(delivery_manifest, copied_paths=copied_paths)
    generated_paths = _write_generated_contract_files(package_root, delivery_manifest, plugin_manifest)
    copied_paths.update(generated_paths)
    plugin_manifest["acceptance"]["evidence_fixtures"] = [
        *list(plugin_manifest["acceptance"].get("evidence_fixtures") or []),
        str(generated_paths["replay_fixture"]),
    ]
    manifest_output = package_root / MANIFEST_NAME
    manifest_output.write_text(json.dumps(plugin_manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    source_digest = _source_digest(root, manifest_file, copied_paths)
    plugin_manifest["provenance"]["source_digest"] = source_digest
    manifest_output.write_text(json.dumps(plugin_manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    metadata = _build_ingestion_metadata(delivery_manifest, copied_paths=copied_paths, source_digest=source_digest)
    metadata_output = package_root / INGESTION_METADATA_NAME
    metadata_output.write_text(json.dumps(metadata, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    package = load_plugin_package(package_root)
    try:
        package_digest = compute_package_digest(package)
    finally:
        package.cleanup()
    plugin_manifest["provenance"]["package_digest"] = package_digest
    manifest_output.write_text(json.dumps(plugin_manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    return ClawHuntPluginIngestionResult(
        plugin_id=plugin_id,
        version=version,
        package_root=package_root,
        manifest_path=manifest_output,
        metadata_path=metadata_output,
        source_digest=source_digest,
        package_digest=package_digest,
    )


def _validate_delivery_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("accepted") is not True:
        raise ClawHuntPluginIngestionError("delivery must be accepted before plugin ingestion")
    if not manifest.get("problem_id"):
        raise ClawHuntPluginIngestionError("delivery manifest missing problem_id")
    if not manifest.get("evidence_bundle_ref"):
        raise ClawHuntPluginIngestionError("delivery manifest missing evidence_bundle_ref")
    wrapper = manifest.get("wrapper")
    if not isinstance(wrapper, dict):
        raise ClawHuntPluginIngestionError("delivery manifest missing reusable wrapper contract")
    required_wrapper_fields = {
        "plugin_id",
        "tool_name",
        "entrypoint",
        "description",
        "input_schema",
        "output_schema",
    }
    missing = sorted(field for field in required_wrapper_fields if field not in wrapper)
    if missing:
        raise ClawHuntPluginIngestionError(f"wrapper contract missing required fields: {', '.join(missing)}")
    _validate_json_schema(wrapper["input_schema"], "wrapper.input_schema")
    _validate_json_schema(wrapper["output_schema"], "wrapper.output_schema")
    if not manifest.get("acceptance_tests"):
        raise ClawHuntPluginIngestionError("delivery manifest missing acceptance_tests")
    if not manifest.get("evidence_fixtures"):
        raise ClawHuntPluginIngestionError("delivery manifest missing evidence_fixtures")
    permissions = wrapper.get("permissions") or {}
    if permissions.get("environment"):
        raise ClawHuntPluginIngestionError("Phase 3A ingestion does not accept environment-secret wrappers")
    if wrapper.get("requires_private_account_state"):
        raise ClawHuntPluginIngestionError("wrapper requiring private account state is not reusable")
    if wrapper.get("downloads_executable_code"):
        raise ClawHuntPluginIngestionError("wrapper that downloads executable code is not reusable")
    _validate_revenue_attribution(manifest)


def _copy_declared_files(root: Path, package_root: Path, manifest: dict[str, Any]) -> dict[str, list[str] | str]:
    wrapper = manifest["wrapper"]
    entrypoint = _copy_relative_file(root, package_root, str(wrapper["entrypoint"]), executable=True)
    tests = [
        _copy_relative_file(root, package_root, str(path), executable=True)
        for path in manifest.get("acceptance_tests", [])
    ]
    evidence_fixtures = [
        _copy_relative_file(root, package_root, str(path), executable=False)
        for path in manifest.get("evidence_fixtures", [])
    ]
    evidence_ref = str(manifest["evidence_bundle_ref"])
    _assert_safe_relative_path(evidence_ref)
    evidence_bundle = _copy_relative_file(root, package_root, evidence_ref, executable=False)
    readme = manifest.get("readme")
    if readme:
        readme_path = _copy_relative_file(root, package_root, str(readme), executable=False)
    else:
        readme_path = _write_default_readme(package_root, manifest)
    return {
        "entrypoint": entrypoint,
        "tests": tests,
        "evidence_fixtures": evidence_fixtures,
        "evidence_bundle_ref": evidence_bundle,
        "readme": readme_path,
    }


def _validate_declared_files(root: Path, manifest: dict[str, Any]) -> None:
    wrapper = manifest["wrapper"]
    paths = [
        str(wrapper["entrypoint"]),
        str(manifest["evidence_bundle_ref"]),
        *[str(path) for path in manifest.get("acceptance_tests", [])],
        *[str(path) for path in manifest.get("evidence_fixtures", [])],
    ]
    if manifest.get("readme"):
        paths.append(str(manifest["readme"]))
    for relative_path in paths:
        _assert_safe_relative_path(relative_path)
        source = (root / relative_path).resolve()
        _ensure_inside(root, source)
        if not source.is_file():
            raise ClawHuntPluginIngestionError(f"declared delivery file missing: {relative_path}")


def _build_plugin_manifest(manifest: dict[str, Any], *, copied_paths: dict[str, list[str] | str]) -> dict[str, Any]:
    wrapper = manifest["wrapper"]
    permissions = wrapper.get("permissions") or {}
    return {
        "schema_version": "0.1.0",
        "id": str(wrapper["plugin_id"]),
        "name": str(wrapper.get("name") or manifest.get("title") or wrapper["plugin_id"]),
        "version": str(wrapper.get("version") or "0.1.0"),
        "summary": str(wrapper.get("summary") or manifest.get("summary") or wrapper["description"])[:240],
        "source": {
            "type": "clawhunt_delivery",
            "clawhunt_problem_id": str(manifest["problem_id"]),
            "developer_id": str(manifest.get("submitter_id") or manifest.get("maintainer_id") or "unknown"),
        },
        "runtime": {
            "type": "mcp_sidecar",
            "entrypoint": copied_paths["entrypoint"],
            "args": list(wrapper.get("args") or []),
            "transport": "stdio",
            "mcp_protocol_versions": list(wrapper.get("mcp_protocol_versions") or ["2025-06-18"]),
            "platforms": list(wrapper.get("platforms") or ["darwin-arm64", "linux-x64"]),
        },
        "tools": [
            {
                "name": str(wrapper["tool_name"]),
                "description": str(wrapper["description"]),
                "input_schema": wrapper["input_schema"],
                "output_schema": wrapper["output_schema"],
            }
        ],
        "permissions": {
            "filesystem": list(permissions.get("filesystem") or []),
            "network": list(permissions.get("network") or []),
            "environment": list(permissions.get("environment") or []),
        },
        "acceptance": {
            "level": str(wrapper.get("acceptance_level") or "L2"),
            "tests": copied_paths["tests"],
            "evidence_fixtures": copied_paths["evidence_fixtures"],
            "latency_budget_ms": int(wrapper.get("latency_budget_ms") or 10000),
        },
        "limits": {
            "startup_timeout_ms": int(wrapper.get("startup_timeout_ms") or 3000),
            "tool_timeout_ms": int(wrapper.get("tool_timeout_ms") or 30000),
            "max_model_output_bytes": int(wrapper.get("max_model_output_bytes") or 65536),
            "max_evidence_bytes": int(wrapper.get("max_evidence_bytes") or 5242880),
            "max_memory_mb": int(wrapper.get("max_memory_mb") or 512),
        },
        "resource_profile": _build_resource_profile(wrapper),
        "commerce": {
            "pricing_model": str(wrapper.get("pricing_model") or "free"),
            "metering": str(wrapper.get("metering") or "per_invocation"),
        },
        "provenance": {
            "build_type": "clawhunt_delivery",
            "source_digest": "sha256:" + ("0" * 64),
            "package_digest": "sha256:" + ("0" * 64),
            "signature": STAGING_SIGNATURE,
        },
    }


def _build_resource_profile(wrapper: dict[str, Any]) -> dict[str, Any]:
    if isinstance(wrapper.get("resource_profile"), dict):
        return dict(wrapper["resource_profile"])
    permissions = wrapper.get("permissions") or {}
    filesystem_permissions = permissions.get("filesystem") or []
    if permissions.get("network"):
        io_profile = "network"
    elif any(
        item.get("mode") in {"write", "readwrite"}
        for item in filesystem_permissions
        if isinstance(item, dict)
    ):
        io_profile = "filesystem_write"
    elif filesystem_permissions:
        io_profile = "filesystem_read"
    else:
        io_profile = "none"
    latency_budget_ms = int(wrapper.get("latency_budget_ms") or 10000)
    max_memory_mb = int(wrapper.get("max_memory_mb") or 512)
    return {
        "latency_class": "standard" if latency_budget_ms <= 10000 else "batch",
        "expected_p95_latency_ms": min(max(latency_budget_ms, 1), 30000),
        "cpu_class": "medium",
        "memory_class": "high" if max_memory_mb > 256 else "medium",
        "io_profile": io_profile,
    }


def _build_ingestion_metadata(manifest: dict[str, Any], *, copied_paths: dict[str, list[str] | str], source_digest: str) -> dict[str, Any]:
    return {
        "schema_version": "0.1.0",
        "source": "clawhunt_delivery",
        "problem_id": str(manifest["problem_id"]),
        "submitter_id": manifest.get("submitter_id"),
        "maintainer_id": manifest.get("maintainer_id"),
        "evidence_bundle_ref": copied_paths["evidence_bundle_ref"],
        "mcp_server_config": copied_paths.get("mcp_server_config"),
        "replay_fixture": copied_paths.get("replay_fixture"),
        "source_artifacts": list(manifest.get("source_artifacts") or []),
        "revenue_attribution": _build_revenue_attribution(manifest),
        "copied_paths": copied_paths,
        "source_digest": source_digest,
        "staging_signature": STAGING_SIGNATURE,
    }


def _validate_revenue_attribution(manifest: dict[str, Any]) -> None:
    wrapper = manifest["wrapper"]
    pricing_model = str(wrapper.get("pricing_model") or "free")
    if pricing_model == "free":
        return
    if not manifest.get("submitter_id"):
        raise ClawHuntPluginIngestionError("paid ClawHunt plugin ingestion requires submitter_id for revenue attribution")
    if not (manifest.get("package_owner_id") or manifest.get("maintainer_id")):
        raise ClawHuntPluginIngestionError(
            "paid ClawHunt plugin ingestion requires package_owner_id or maintainer_id for revenue attribution"
        )


def _build_revenue_attribution(manifest: dict[str, Any]) -> dict[str, Any]:
    wrapper = manifest["wrapper"]
    package_owner_id = manifest.get("package_owner_id") or manifest.get("maintainer_id") or manifest.get("submitter_id")
    return {
        "schema_version": "0.1.0",
        "source": "clawhunt_delivery",
        "policy": "attribution_only",
        "settlement_status": "not_settled",
        "problem_id": str(manifest["problem_id"]),
        "pricing_model": str(wrapper.get("pricing_model") or "free"),
        "metering": str(wrapper.get("metering") or "per_invocation"),
        "original_submitter_id": _optional_string(manifest.get("submitter_id")),
        "package_owner_id": _optional_string(package_owner_id),
        "maintainer_id": _optional_string(manifest.get("maintainer_id")),
        "bounty_sponsor_id": _optional_string(manifest.get("bounty_sponsor_id")),
    }


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _write_generated_contract_files(package_root: Path, delivery_manifest: dict[str, Any], plugin_manifest: dict[str, Any]) -> dict[str, str]:
    mcp_config = _build_mcp_server_config(plugin_manifest)
    mcp_path = package_root / MCP_SERVER_CONFIG_NAME
    mcp_path.parent.mkdir(parents=True, exist_ok=True)
    mcp_path.write_text(json.dumps(mcp_config, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    replay = _build_replay_fixture(delivery_manifest, plugin_manifest)
    replay_path = package_root / REPLAY_FIXTURE_NAME
    replay_path.parent.mkdir(parents=True, exist_ok=True)
    replay_path.write_text(json.dumps(replay, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return {
        "mcp_server_config": MCP_SERVER_CONFIG_NAME,
        "replay_fixture": REPLAY_FIXTURE_NAME,
    }


def _build_mcp_server_config(plugin_manifest: dict[str, Any]) -> dict[str, Any]:
    runtime = plugin_manifest["runtime"]
    return {
        "schema_version": "0.1.0",
        "plugin_id": plugin_manifest["id"],
        "plugin_version": plugin_manifest["version"],
        "transport": runtime["transport"],
        "entrypoint": runtime["entrypoint"],
        "args": runtime.get("args", []),
        "proxy_required": True,
        "tools": [
            {
                "name": tool["name"],
                "input_schema": tool["input_schema"],
                "output_schema": tool["output_schema"],
            }
            for tool in plugin_manifest.get("tools", [])
        ],
    }


def _build_replay_fixture(delivery_manifest: dict[str, Any], plugin_manifest: dict[str, Any]) -> dict[str, Any]:
    tool = plugin_manifest["tools"][0]
    replay_input = delivery_manifest.get("replay_input") or delivery_manifest["wrapper"].get("replay_input")
    if replay_input is None:
        replay_input = _example_from_schema(tool["input_schema"])
    return {
        "schema_version": "0.1.0",
        "source": "clawhunt_delivery",
        "problem_id": str(delivery_manifest["problem_id"]),
        "plugin_id": plugin_manifest["id"],
        "plugin_version": plugin_manifest["version"],
        "tool_name": tool["name"],
        "input": replay_input,
        "expected_output_schema": tool["output_schema"],
        "evidence_bundle_ref": str(delivery_manifest["evidence_bundle_ref"]),
        "requires_superclaw_proxy": True,
    }


def _example_from_schema(schema: dict[str, Any]) -> Any:
    if schema.get("type") == "object":
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        required = schema.get("required") if isinstance(schema.get("required"), list) else []
        keys = required or list(properties.keys())
        return {str(key): _example_from_schema(properties.get(key, {})) for key in keys}
    if schema.get("type") == "array":
        return []
    if schema.get("type") == "integer":
        return 0
    if schema.get("type") == "number":
        return 0
    if schema.get("type") == "boolean":
        return False
    if schema.get("enum"):
        return schema["enum"][0]
    return "."


def _copy_relative_file(root: Path, package_root: Path, relative_path: str, *, executable: bool) -> str:
    _assert_safe_relative_path(relative_path)
    source = (root / relative_path).resolve()
    _ensure_inside(root, source)
    if not source.is_file():
        raise ClawHuntPluginIngestionError(f"declared delivery file missing: {relative_path}")
    target = (package_root / relative_path).resolve()
    _ensure_inside(package_root, target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    if executable:
        target.chmod(target.stat().st_mode | 0o755)
    return relative_path


def _write_default_readme(package_root: Path, manifest: dict[str, Any]) -> str:
    path = package_root / "README.md"
    path.write_text(
        "\n".join(
            [
                f"# {manifest.get('title') or manifest['wrapper']['plugin_id']}",
                "",
                "Generated from a reusable ClawHunt delivery by SuperClaw.",
                "",
                f"- Problem id: {manifest['problem_id']}",
                f"- Tool: {manifest['wrapper']['tool_name']}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return "README.md"


def _source_digest(root: Path, manifest_file: Path, copied_paths: dict[str, list[str] | str]) -> str:
    paths: list[str] = [manifest_file.relative_to(root).as_posix()]
    for value in copied_paths.values():
        if isinstance(value, list):
            paths.extend(value)
        else:
            paths.append(value)
    digest = hashlib.sha256()
    for relative in sorted(set(paths)):
        path = (root / relative).resolve()
        if not path.exists():
            path = (manifest_file.parent / relative).resolve()
        if not path.exists():
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def _validate_json_schema(schema: Any, field_name: str) -> None:
    if not isinstance(schema, dict):
        raise ClawHuntPluginIngestionError(f"{field_name} must be a JSON Schema object")
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:
        raise ClawHuntPluginIngestionError(f"{field_name} is not a valid JSON Schema: {exc}") from exc


def _assert_safe_relative_path(value: str) -> None:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not value:
        raise ClawHuntPluginIngestionError(f"unsafe delivery path: {value}")


def _ensure_inside(root: Path, path: Path) -> None:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    if resolved_path != resolved_root and resolved_root not in resolved_path.parents:
        raise ClawHuntPluginIngestionError(f"path escapes delivery/package root: {path}")


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
