from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from superclaw.plugin_mcp_proxy import build_mcp_config, projected_tool_name
from superclaw.plugins import load_plugin_package


CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json"


class PluginCodexViewError(ValueError):
    """Raised when a Codex-compatible view cannot be generated safely."""


@dataclass(frozen=True)
class PluginCodexViewResult:
    plugin_id: str
    version: str
    output_dir: Path
    written_files: list[Path]
    record: dict[str, Any]


def export_codex_compatible_view(
    package_path: Path,
    *,
    output_dir: Path,
    force: bool = False,
    python_executable: str | None = None,
) -> PluginCodexViewResult:
    """Generate a Codex-compatible view that points only to the SuperClaw MCP proxy."""
    if output_dir.exists():
        if not force:
            raise PluginCodexViewError(f"output directory already exists: {output_dir}")
        if not output_dir.is_dir():
            raise PluginCodexViewError(f"output path is not a directory: {output_dir}")
        shutil.rmtree(output_dir)
    package = load_plugin_package(package_path)
    try:
        manifest = package.manifest
        plugin_id = str(manifest["id"])
        version = str(manifest["version"])
        tools = manifest.get("tools", [])
        if not isinstance(tools, list) or not tools:
            raise PluginCodexViewError("plugin manifest must declare at least one tool")
        output_dir.mkdir(parents=True, exist_ok=False)
        written = [
            _write_json(output_dir / CODEX_PLUGIN_MANIFEST, _codex_plugin_manifest(manifest)),
            _write_json(output_dir / ".mcp.json", build_mcp_config(plugin_id, version=version, python_executable=python_executable)),
        ]
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            written.append(_write_text(output_dir / "skills" / _safe_skill_name(str(tool["name"])) / "SKILL.md", _skill_markdown(manifest, tool)))
        record = {
            "schema_version": "0.1.0",
            "view_type": "codex_compatible_proxy_view",
            "plugin_id": plugin_id,
            "version": version,
            "source_of_truth": "superclaw-plugin.json",
            "generated_paths": [path.relative_to(output_dir).as_posix() for path in written],
            "proxy_only": True,
            "out_of_scope": [
                "codex_install",
                "codex_process_start",
                "source_export",
                "plugin_cache_export",
                "entitlement_export",
                "secret_export",
                "marketplace_distribution",
            ],
        }
        return PluginCodexViewResult(plugin_id=plugin_id, version=version, output_dir=output_dir, written_files=written, record=record)
    finally:
        package.cleanup()


def _codex_plugin_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    plugin_id = str(manifest["id"])
    version = str(manifest["version"])
    tools = [
        {
            "name": projected_tool_name(plugin_id, str(tool["name"])),
            "description": str(tool.get("description") or ""),
            "skill": f"skills/{_safe_skill_name(str(tool['name']))}/SKILL.md",
        }
        for tool in manifest.get("tools", [])
        if isinstance(tool, dict) and tool.get("name")
    ]
    return {
        "schema_version": "0.1.0",
        "id": plugin_id,
        "name": str(manifest.get("name") or plugin_id),
        "version": version,
        "description": str(manifest.get("summary") or ""),
        "source_of_truth": "superclaw-plugin.json",
        "runtime": "superclaw_mcp_proxy",
        "mcp_config": ".mcp.json",
        "tools": tools,
    }


def _skill_markdown(manifest: dict[str, Any], tool: dict[str, Any]) -> str:
    plugin_id = str(manifest["id"])
    raw_tool_name = str(tool["name"])
    mcp_tool_name = projected_tool_name(plugin_id, raw_tool_name)
    description = str(tool.get("description") or f"Use SuperClaw plugin tool {raw_tool_name}.")
    input_schema = json.dumps(tool.get("input_schema", {}), indent=2, sort_keys=True, ensure_ascii=False)
    return f"""---
name: {mcp_tool_name}
description: "{_yaml_scalar(description)}"
---

# {mcp_tool_name}

Use this skill when the task needs the SuperClaw plugin tool `{raw_tool_name}`.

Call the MCP tool `{mcp_tool_name}` through the SuperClaw MCP proxy. Do not load
the original plugin directory, sidecar entrypoint, cache directory, license
state, or developer source directly.

Input schema:

```json
{input_schema}
```
"""


def _write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def _write_text(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _safe_skill_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return normalized or "plugin-tool"


def _yaml_scalar(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
