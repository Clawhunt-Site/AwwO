"""Import a standard SKILL.md into a governed SuperClaw plugin package.

SuperClaw's native skill format is, by construction, the Anthropic/Claude
``SKILL.md`` format (YAML frontmatter + Markdown body). A skill, however, is
model-visible *prose* (progressive-disclosure instructions), not an executable
tool — yet the marketplace's only first-class, installable, governed object is a
plugin package (manifest + signature + digest + revocation + cache).

This module bridges the two **without changing the manifest schema**: it wraps a
standalone ``SKILL.md`` as an ``mcp_sidecar`` plugin that exposes a single tool
which returns the skill body. The model "loads" the skill by invoking that tool
through the same governed plugin proxy as any other plugin call, so an imported
third-party skill inherits the full trust chain (digest, signature, revocation,
entitlement, policy) for free.

The output is an unsigned local package directory, identical in spirit to
``superclaw plugin init``: the caller then runs ``plugin pack`` / ``plugin
install`` (or passes ``pack=True`` here for the dev convenience path). This keeps
the capability in the kernel and exposed via the CLI, per the SuperClaw contract
that capabilities land in the core harness before any surface consumes them.
"""

from __future__ import annotations

import json
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from superclaw.harness import parse_markdown_with_frontmatter, split_skill_body

# Contract constants kept byte-identical to their owning modules but duplicated
# here on purpose: generating a package needs no signing, yet plugins.py and
# plugin_devkit both pull in the cryptography stack at import time. Re-declaring
# the handful of constants this module needs keeps the pure file-emission path
# free of that dependency, so an imported skill can be produced even where signing
# is unavailable. test_skill_import asserts these stay equal to their sources so
# the two can never drift.
MANIFEST_NAME = "superclaw-plugin.json"  # mirror of plugins.MANIFEST_NAME
PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$")  # mirror of plugin_devkit.PLUGIN_ID_RE
TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")  # mirror of plugin_devkit.TOOL_NAME_RE

# The sidecar returns the skill body verbatim through the MCP proxy. Keep the
# returned text comfortably under the manifest's max_model_output_bytes so the
# governed output cap never truncates a legitimate skill; anything larger spills
# into skill/reference.md with an in-body pointer (same convention as the harness
# body splitter used for external targets).
DEFAULT_SKILL_BODY_CAP_BYTES = 32768
MANIFEST_MAX_OUTPUT_BYTES = 65536


class SkillImportError(ValueError):
    """Raised when a SKILL.md cannot be wrapped into a plugin package."""


@dataclass(frozen=True)
class SkillImportResult:
    plugin_id: str
    version: str
    tool_name: str
    skill_name: str
    package_root: Path
    created_files: list[Path]
    warnings: list[str]


def import_skill_as_plugin(
    skill_path: Path,
    *,
    output_dir: Path | None = None,
    plugin_id: str | None = None,
    version: str = "0.1.0",
    developer_id: str = "local-dev",
    force: bool = False,
    body_cap_bytes: int = DEFAULT_SKILL_BODY_CAP_BYTES,
) -> SkillImportResult:
    """Wrap a standard SKILL.md into a schema-valid mcp_sidecar plugin package."""
    source_file = _resolve_skill_file(skill_path)
    frontmatter, body = parse_markdown_with_frontmatter(source_file.read_text(encoding="utf-8"))

    skill_name = _skill_name(frontmatter, source_file)
    description = _skill_description(frontmatter)
    slug = _slugify(skill_name)
    resolved_plugin_id = plugin_id or f"skill.{slug}"
    _validate_plugin_id(resolved_plugin_id)
    tool_name = _tool_name(slug)
    script_name = _safe_script_name(resolved_plugin_id)

    warnings: list[str] = []
    head, overflow = split_skill_body(body.rstrip() + "\n", body_cap_bytes)
    if overflow:
        warnings.append(f"skill body exceeded {body_cap_bytes} bytes; overflow moved to skill/reference.md")

    target = (output_dir or Path(resolved_plugin_id)).resolve()
    if target.exists():
        if not force:
            raise SkillImportError(f"output directory already exists: {target}")
        if not target.is_dir():
            raise SkillImportError(f"output path is not a directory: {target}")
        shutil.rmtree(target)

    manifest = _build_manifest(
        plugin_id=resolved_plugin_id,
        name=skill_name,
        version=version,
        description=description,
        tool_name=tool_name,
        script_name=script_name,
        developer_id=developer_id,
    )
    normalized_skill = _normalized_skill_markdown(name=slug, description=description, body=head)

    files: list[tuple[Path, str, bool]] = [
        (Path(MANIFEST_NAME), json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", False),
        (Path("bin") / script_name, _sidecar_source(script_name), True),
        (Path("skill") / "body.md", head, False),
        (Path("skill") / "SKILL.md", normalized_skill, False),
        (Path("tests") / "smoke.sh", _smoke_test(script_name, tool_name), True),
        (Path("evidence-fixtures") / "smoke.json", _evidence_fixture(resolved_plugin_id, version, tool_name), False),
        (Path("README.md"), _readme(skill_name, resolved_plugin_id, tool_name), False),
    ]
    if overflow:
        files.append((Path("skill") / "reference.md", overflow if overflow.endswith("\n") else overflow + "\n", False))

    created: list[Path] = []
    for relative, content, executable in files:
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        created.append(path)

    return SkillImportResult(
        plugin_id=resolved_plugin_id,
        version=version,
        tool_name=tool_name,
        skill_name=skill_name,
        package_root=target,
        created_files=created,
        warnings=warnings,
    )


def _resolve_skill_file(skill_path: Path) -> Path:
    source = skill_path.resolve()
    if source.is_dir():
        candidate = source / "SKILL.md"
        if not candidate.exists():
            raise SkillImportError(f"missing SKILL.md in {source}")
        return candidate
    if source.is_file():
        return source
    raise SkillImportError(f"skill path not found: {skill_path}")


def _skill_name(frontmatter: dict[str, Any], source_file: Path) -> str:
    raw = frontmatter.get("name")
    name = str(raw).strip() if isinstance(raw, str) else ""
    if not name:
        # Fall back to the enclosing directory (Anthropic skills live in
        # <skill-name>/SKILL.md) so a frontmatter without a name still imports.
        name = source_file.parent.name if source_file.parent.name not in {"", "."} else source_file.stem
    if not name:
        raise SkillImportError("skill has no name in frontmatter and none could be derived from the path")
    return name


def _skill_description(frontmatter: dict[str, Any]) -> str:
    raw = frontmatter.get("description")
    description = str(raw).strip() if isinstance(raw, str) else ""
    if not description:
        raise SkillImportError("skill frontmatter must declare a description (used as the plugin summary and tool description)")
    return description


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise SkillImportError(f"cannot derive a plugin slug from skill name: {value!r}")
    if not slug[0].isalpha():
        slug = f"s-{slug}"
    return slug


def _tool_name(slug: str) -> str:
    candidate = f"{slug.replace('-', '_')}_skill"
    if not candidate[0].isalpha():
        candidate = f"s_{candidate}"
    if not TOOL_NAME_RE.fullmatch(candidate):
        raise SkillImportError(f"cannot derive a valid tool name from skill slug: {slug!r}")
    return candidate


def _validate_plugin_id(plugin_id: str) -> None:
    if not PLUGIN_ID_RE.fullmatch(plugin_id):
        raise SkillImportError(f"derived plugin id is not a valid reverse-DNS id: {plugin_id} (pass --plugin-id)")


def _safe_script_name(plugin_id: str) -> str:
    return plugin_id.split(".")[-1].replace("_", "-")


def _build_manifest(
    *,
    plugin_id: str,
    name: str,
    version: str,
    description: str,
    tool_name: str,
    script_name: str,
    developer_id: str,
) -> dict[str, Any]:
    summary = description if len(description) <= 240 else description[:237].rstrip() + "..."
    return {
        "schema_version": "0.1.0",
        "id": plugin_id,
        "name": name,
        "version": version,
        "summary": summary,
        # Kernel-owned classification: this lives in the signed manifest (not just
        # registry metadata or an id-prefix guess) so the marketplace skill view,
        # governance, and every surface read the same authoritative fact, and a
        # surface can never fake or miss it.
        "skill_origin": True,
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
                "description": description,
                "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
                "output_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            }
        ],
        # A skill is pure model-visible prose. It needs no filesystem, network, or
        # environment access — declare none (fail-closed) so the governed runtime
        # never grants this package any capability beyond returning its own text.
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
            "max_model_output_bytes": MANIFEST_MAX_OUTPUT_BYTES,
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


def _sidecar_source(script_name: str) -> str:
    # The sidecar carries no skill text inline: it reads the sibling skill/body.md
    # and returns it verbatim. Keeping the body in a real file (not embedded in the
    # script) keeps it human-readable, keeps the script trivial/deterministic, and
    # makes the body part of the package digest without any escaping hazard.
    return f'''#!/usr/bin/env python3
import json
import os
import sys

if len(sys.argv) < 2 or sys.argv[1] != "mcp":
    print("usage: {script_name} mcp", file=sys.stderr)
    raise SystemExit(2)

try:
    json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    pass

here = os.path.dirname(os.path.abspath(__file__))
body_path = os.path.join(here, "..", "skill", "body.md")
with open(body_path, "r", encoding="utf-8") as handle:
    body = handle.read()

print(json.dumps({{"text": body}}, ensure_ascii=False))
'''


def _smoke_test(script_name: str, tool_name: str) -> str:
    # L1 acceptance: prove the sidecar starts and returns a non-empty text field.
    # Content-independent on purpose — the body is arbitrary user prose, so the
    # smoke asserts the contract (a JSON object with "text"), not specific words.
    return f"""#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$(printf '%s' '{{"tool":"{tool_name}","input":{{}}}}' | "$ROOT/bin/{script_name}" mcp)"
printf '%s' "$OUTPUT" | grep -q '"text"'
test -n "$OUTPUT"
"""


def _evidence_fixture(plugin_id: str, version: str, tool_name: str) -> str:
    fixture = {
        "run_id": f"run_fixture_{plugin_id.split('.')[-1].replace('-', '_')}",
        "plugin_id": plugin_id,
        "plugin_version": version,
        "package_digest": "sha256:" + "0" * 64,
        "tool_name": tool_name,
        "started_at": "2026-06-01T00:00:00Z",
        "finished_at": "2026-06-01T00:00:01Z",
        "status": "ok",
        "entitlement_id": None,
        "input_digest": "sha256:" + "1" * 64,
        "output_digest": "sha256:" + "2" * 64,
        "evidence_artifact_id": "artifact_imported_skill_smoke",
        "policy_decision": "allowed",
        "sandbox_exit_status": 0,
    }
    return json.dumps(fixture, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _normalized_skill_markdown(*, name: str, description: str, body: str) -> str:
    front = f"---\nname: {name}\ndescription: {_yaml_scalar(description)}\n---\n\n"
    return front + (body if body.endswith("\n") else body + "\n")


def _yaml_scalar(value: str) -> str:
    if re.search(r"[:#\[\]{}\n]", value) or value.strip() != value:
        return json.dumps(value, ensure_ascii=False)
    return value


def _readme(skill_name: str, plugin_id: str, tool_name: str) -> str:
    return f"""# {skill_name}

Imported skill, wrapped as a governed SuperClaw plugin.

This package was generated from a standard `SKILL.md` by `superclaw plugin
import-skill`. It exposes a single tool, `{tool_name}`, that returns the skill's
instructions through the SuperClaw MCP proxy. The original skill body lives in
`skill/body.md` (returned verbatim) and `skill/SKILL.md` (normalized source).

## Next steps

```bash
superclaw plugin dev . --tool {tool_name}
superclaw plugin pack . --dev-sign --dist-dir dist
```

`{plugin_id}` carries no filesystem, network, or environment permissions: it only
returns its own prose. Install it through the SuperClaw marketplace flow; do not
load this directory directly into another runtime.
"""
