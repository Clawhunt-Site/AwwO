from __future__ import annotations

import base64
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.process_scripts import command_for_script
from superclaw.plugin_timeouts import floor_default_timeout_seconds
from superclaw.plugins import (
    MANIFEST_NAME,
    PluginPackage,
    _validate_cache_segment,
    compute_package_digest,
    load_plugin_package,
)


PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$")
TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class PluginDevkitError(ValueError):
    """Raised when local developer-package tooling fails closed."""


@dataclass(frozen=True)
class PluginInitResult:
    plugin_id: str
    tool_name: str
    package_root: Path
    created_files: list[Path]


@dataclass(frozen=True)
class PluginDevResult:
    plugin_id: str
    version: str
    tool_name: str
    response: dict[str, Any]


@dataclass(frozen=True)
class PluginPackResult:
    plugin_id: str
    version: str
    package_path: Path
    package_digest: str
    signed: bool
    public_key: str | None


def init_plugin_package(
    plugin_id: str,
    *,
    output_dir: Path | None = None,
    name: str | None = None,
    tool_name: str = "hello_world",
    developer_id: str = "local-dev",
    force: bool = False,
) -> PluginInitResult:
    """Create a schema-valid local starter plugin package."""
    _validate_plugin_id(plugin_id)
    _validate_tool_name(tool_name)
    target = (output_dir or Path(plugin_id)).resolve()
    if target.exists():
        if not force:
            raise PluginDevkitError(f"plugin directory already exists: {target}")
        if not target.is_dir():
            raise PluginDevkitError(f"plugin output path is not a directory: {target}")
        shutil.rmtree(target)
    display_name = name or _display_name(plugin_id)
    script_name = _safe_script_name(plugin_id)
    created: list[Path] = []
    for relative, content, executable in _starter_files(
        plugin_id=plugin_id,
        display_name=display_name,
        tool_name=tool_name,
        developer_id=developer_id,
        script_name=script_name,
    ):
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        created.append(path)
    return PluginInitResult(plugin_id=plugin_id, tool_name=tool_name, package_root=target, created_files=created)


def run_plugin_dev(package_root: Path, *, tool_name: str, input_payload: dict[str, Any], timeout_seconds: float | None = None) -> PluginDevResult:
    """Run a starter plugin sidecar locally without cache, cloud, or entitlement state."""
    if timeout_seconds is None:
        timeout_seconds = floor_default_timeout_seconds(10.0)
    package = load_plugin_package(package_root)
    try:
        manifest = package.manifest
        tool = _declared_tool(manifest, tool_name)
        entrypoint = _safe_package_path(package.root, manifest["runtime"]["entrypoint"])
        args = command_for_script(entrypoint, [str(arg) for arg in manifest["runtime"].get("args", [])])
        completed = subprocess.run(
            args,
            input=json.dumps({"tool": tool["name"], "input": input_payload}, ensure_ascii=False),
            cwd=package.root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
            env={"PATH": os.environ.get("PATH", "")},
        )
        if completed.returncode != 0:
            raise PluginDevkitError(_safe_error(f"sidecar exited {completed.returncode}", completed.stderr or completed.stdout))
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise PluginDevkitError("sidecar did not return JSON") from exc
        if not isinstance(response, dict):
            raise PluginDevkitError("sidecar response must be a JSON object")
        return PluginDevResult(plugin_id=str(manifest["id"]), version=str(manifest["version"]), tool_name=tool_name, response=response)
    except subprocess.TimeoutExpired as exc:
        raise PluginDevkitError(f"sidecar timed out after {timeout_seconds:g}s") from exc
    finally:
        package.cleanup()


def pack_plugin_package(
    package_root: Path,
    *,
    dist_dir: Path = Path("dist"),
    signing_private_key: str | None = None,
    dev_sign: bool = False,
) -> PluginPackResult:
    """Create a .scplug archive with a fresh package digest and optional dev signature."""
    package = load_plugin_package(package_root)
    try:
        private_key = _private_key(signing_private_key, dev_sign=dev_sign)
        with tempfile.TemporaryDirectory(prefix="superclaw-plugin-pack-") as temporary:
            staged_root = Path(temporary) / "package"
            shutil.copytree(package.root, staged_root)
            manifest_path = staged_root / MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["provenance"]["package_digest"] = ""
            manifest["provenance"]["signature"] = "ed25519:unsigned-dev-package"
            manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
            unsigned = PluginPackage(source=staged_root, root=staged_root, manifest=manifest)
            digest = compute_package_digest(unsigned)
            public_key: str | None = None
            if private_key:
                signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
                manifest["provenance"]["signature"] = f"ed25519:{signature}"
                public_key = base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
            manifest["provenance"]["package_digest"] = digest
            manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
            dist_dir.mkdir(parents=True, exist_ok=True)
            # SECURITY: id/version come straight from the (untrusted) manifest and
            # are interpolated into the output filename. The manifest schema does
            # not constrain them to safe path components, so id="../../escape" or
            # a version with a path separator could write the .scplug outside
            # dist_dir (traversal). Validate each as a single safe segment first —
            # the same fail-closed guard cache_plugin_package applies to its write
            # path.
            _validate_cache_segment(str(manifest["id"]), label="plugin id")
            _validate_cache_segment(str(manifest["version"]), label="plugin version")
            package_path = dist_dir / f"{manifest['id']}-{manifest['version']}.scplug"
            _write_scplug(staged_root, package_path)
            return PluginPackResult(
                plugin_id=str(manifest["id"]),
                version=str(manifest["version"]),
                package_path=package_path,
                package_digest=digest,
                signed=private_key is not None,
                public_key=public_key,
            )
    finally:
        package.cleanup()


def _starter_files(
    *,
    plugin_id: str,
    display_name: str,
    tool_name: str,
    developer_id: str,
    script_name: str,
) -> list[tuple[Path, str, bool]]:
    manifest = {
        "schema_version": "0.1.0",
        "id": plugin_id,
        "name": display_name,
        "version": "0.1.0",
        "summary": f"Starter SuperClaw plugin for {display_name}.",
        "source": {"type": "developer_upload", "clawhunt_problem_id": None, "developer_id": developer_id},
        "runtime": {
            "type": "mcp_sidecar",
            "entrypoint": f"bin/{script_name}",
            "args": ["mcp"],
            "transport": "stdio",
            "mcp_protocol_versions": ["2025-06-18"],
            "platforms": ["darwin-arm64", "linux-x64"],
        },
        "tools": [
            {
                "name": tool_name,
                "description": "Return a deterministic starter response for local plugin development.",
                "input_schema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                    "additionalProperties": False,
                },
                "output_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            }
        ],
        "permissions": {"filesystem": [], "network": [], "environment": []},
        "acceptance": {
            "level": "L1",
            "tests": ["tests/smoke.sh"],
            "evidence_fixtures": ["evidence-fixtures/smoke.json"],
            "latency_budget_ms": 1000,
        },
        "limits": {
            "startup_timeout_ms": 3000,
            "tool_timeout_ms": 30000,
            "max_model_output_bytes": 65536,
            "max_evidence_bytes": 5242880,
            "max_memory_mb": 128,
        },
        "resource_profile": {
            "latency_class": "interactive",
            "expected_p95_latency_ms": 1000,
            "cpu_class": "low",
            "memory_class": "low",
            "io_profile": "none",
        },
        "commerce": {"pricing_model": "free", "metering": "none"},
        "provenance": {
            "build_type": "developer_upload",
            "source_digest": None,
            "package_digest": "sha256:" + "0" * 64,
            "signature": "ed25519:unsigned-dev-package",
        },
    }
    sidecar = f"""#!/usr/bin/env python3
import json
import sys

if len(sys.argv) < 2 or sys.argv[1] != "mcp":
    print("usage: {script_name} mcp", file=sys.stderr)
    raise SystemExit(2)

try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    payload = {{}}

inputs = payload.get("input", {{}})
name = inputs.get("name") or "SuperClaw"
print(json.dumps({{"text": f"hello {{name}} from {plugin_id}"}}, ensure_ascii=False))
"""
    smoke = f"""#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$(printf '%s\\n' '{{"tool":"{tool_name}","input":{{"name":"developer"}}}}' | "$ROOT/bin/{script_name}" mcp)"
test "$OUTPUT" = '{{"text": "hello developer from {plugin_id}"}}'
"""
    evidence = {
        "run_id": f"run_fixture_{_safe_script_name(plugin_id).replace('-', '_')}",
        "plugin_id": plugin_id,
        "plugin_version": "0.1.0",
        "package_digest": "sha256:" + "0" * 64,
        "tool_name": tool_name,
        "started_at": "2026-06-01T00:00:00Z",
        "finished_at": "2026-06-01T00:00:01Z",
        "status": "ok",
        "entitlement_id": None,
        "input_digest": "sha256:" + "1" * 64,
        "output_digest": "sha256:" + "2" * 64,
        "evidence_artifact_id": "artifact_starter_smoke",
        "policy_decision": "allowed",
        "sandbox_exit_status": 0,
    }
    mcp = {
        "server": "superclaw-plugin-sidecar",
        "transport": "stdio",
        "tools": [{"name": tool_name, "description": manifest["tools"][0]["description"]}],
        "note": "Package-local metadata only. Installed runtimes must call through the SuperClaw MCP proxy.",
    }
    readme = f"""# {display_name}

Local SuperClaw starter plugin.

## Development

```bash
superclaw plugin dev . --tool {tool_name} --json '{{"name":"developer"}}'
superclaw plugin pack . --dev-sign --dist-dir dist
```

Do not install this package directory directly into Codex, Claude Code, Hermes,
or OpenClaw. Installed runtimes should call it through the SuperClaw MCP proxy.
"""
    files = [
        (Path(MANIFEST_NAME), json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", False),
        (Path("bin") / script_name, sidecar, True),
        (Path("skills") / "README.md", "# Model-visible Notes\n\nKeep this file free of secrets, license tokens, and protected implementation details.\n", False),
        (Path("mcp") / "server.json", json.dumps(mcp, indent=2, sort_keys=True, ensure_ascii=False) + "\n", False),
        (Path("tests") / "smoke.sh", smoke, True),
        (Path("evidence-fixtures") / "smoke.json", json.dumps(evidence, indent=2, sort_keys=True, ensure_ascii=False) + "\n", False),
        (Path("README.md"), readme, False),
        (Path("LICENSE"), "Proprietary or custom license. Replace before publication.\n", False),
    ]
    return files


def _write_scplug(root: Path, package_path: Path) -> None:
    if package_path.exists():
        package_path.unlink()
    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            # __pycache__ is interpreter-generated bytecode that the digest
            # excludes and that the verifier rejects inside a .scplug. Exclude it
            # here so pack and verify stay consistent — otherwise a stray
            # __pycache__ in the source tree would produce a self-invalidating
            # archive (packs fine, fails verification).
            if "__pycache__" in path.relative_to(root).parts:
                continue
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(relative)
            info.external_attr = (path.stat().st_mode & 0o777) << 16
            archive.writestr(info, path.read_bytes())


def _private_key(value: str | None, *, dev_sign: bool) -> Ed25519PrivateKey | None:
    if value:
        try:
            raw = base64.b64decode(value.removeprefix("ed25519:"), validate=True)
            return Ed25519PrivateKey.from_private_bytes(raw)
        except Exception as exc:
            raise PluginDevkitError("invalid SuperClaw signing private key") from exc
    if dev_sign:
        return Ed25519PrivateKey.generate()
    return None


def _declared_tool(manifest: dict[str, Any], tool_name: str) -> dict[str, Any]:
    for tool in manifest.get("tools", []):
        if tool.get("name") == tool_name:
            return tool
    raise PluginDevkitError(f"tool is not declared by manifest: {tool_name}")


def _safe_package_path(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise PluginDevkitError("runtime entrypoint escapes package root")
    if not target.exists():
        raise PluginDevkitError(f"runtime entrypoint missing: {relative}")
    return target


def _safe_error(prefix: str, detail: str) -> str:
    sanitized = detail.replace(str(Path.home()), "$HOME")
    return f"{prefix}: {sanitized[:500]}"


def _display_name(plugin_id: str) -> str:
    return " ".join(part.capitalize() for part in plugin_id.split(".")[-1].replace("-", " ").split())


def _safe_script_name(plugin_id: str) -> str:
    return plugin_id.split(".")[-1].replace("_", "-")


def _validate_plugin_id(plugin_id: str) -> None:
    if not PLUGIN_ID_RE.fullmatch(plugin_id):
        raise PluginDevkitError("plugin id must be a reverse-DNS id such as com.example.repo-scanner")


def _validate_tool_name(tool_name: str) -> None:
    if not TOOL_NAME_RE.fullmatch(tool_name):
        raise PluginDevkitError("tool name must be lowercase snake_case")
