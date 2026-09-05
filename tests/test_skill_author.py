"""Acceptance for the superclaw-skill-author meta-skill.

The meta-skill is prose that orchestrates existing CLI, so the thing worth
testing is that the flow it documents actually produces governed packages, and
that the skill doc cannot silently drift away from the real CLI it invokes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from superclaw.harness import parse_markdown_with_frontmatter
from superclaw.plugins import MANIFEST_NAME, is_skill_origin_plugin
from superclaw.skill_import import import_skill_as_plugin

ROOT = Path(__file__).resolve().parents[1]
META_SKILL = ROOT / "skills" / "superclaw-skill-author" / "SKILL.md"
DOC = ROOT / "docs" / "superclaw-skill-author.md"
FIXTURES = ROOT / "examples" / "skills"


@pytest.mark.parametrize(
    "fixture, plugin_id",
    [
        ("greeting-coach", "skill.greeting-coach"),  # Route A: authored from zero
        ("imported-from-codex", "skill.changelog-summarizer"),  # Route B: converted
    ],
)
def test_example_skill_imports_into_governed_package(tmp_path, fixture, plugin_id):
    source = FIXTURES / fixture / "SKILL.md"
    out = tmp_path / fixture
    result = import_skill_as_plugin(source, output_dir=out, plugin_id=plugin_id)

    manifest = json.loads((Path(result.package_root) / MANIFEST_NAME).read_text(encoding="utf-8"))
    # A pure-prose skill must land as a governed, skill_origin mcp_sidecar plugin
    # with no declared capability — exactly what skill_sync treats as projectable.
    assert is_skill_origin_plugin(manifest["id"], manifest.get("skill_origin"))
    assert manifest["runtime"]["type"] == "mcp_sidecar"
    assert manifest["permissions"] == {"filesystem": [], "network": [], "environment": []}
    assert (Path(result.package_root) / "skill" / "SKILL.md").is_file()


def test_meta_skill_has_valid_frontmatter():
    frontmatter, body = parse_markdown_with_frontmatter(META_SKILL.read_text(encoding="utf-8"))
    assert frontmatter.get("name") == "superclaw-skill-author"
    assert frontmatter.get("description")
    assert body.strip()


def test_meta_skill_only_references_real_cli_commands():
    text = META_SKILL.read_text(encoding="utf-8")
    # Every plugin subcommand the meta-skill tells the agent to run must exist in
    # the CLI, so the doc can't drift into inventing commands.
    cli = (ROOT / "packages" / "superclaw" / "src" / "superclaw" / "cli.py").read_text(encoding="utf-8")
    declared = {
        line.split('"')[1]
        for line in cli.splitlines()
        if "@plugin_app.command(" in line
    }
    for referenced in ("import-skill", "init", "dev", "pack", "conformance", "submit", "install", "sync-skills"):
        assert referenced in declared, f"meta-skill references unknown CLI command: {referenced}"
        assert f"plugin {referenced}" in text


def test_meta_skill_states_the_prose_vs_plugin_rule():
    text = META_SKILL.read_text(encoding="utf-8").lower()
    # The one safety invariant must be present and explicit.
    assert "pure prose" in text
    assert "side effect" in text
    assert DOC.is_file()
