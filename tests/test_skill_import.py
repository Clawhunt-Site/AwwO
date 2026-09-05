from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from superclaw import plugin_devkit, plugins, skill_import
from superclaw.cli import app
from superclaw.plugin_devkit import pack_plugin_package
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import verify_plugin_package
from superclaw.skill_store import compute_skill_source_digest


ROOT = Path(__file__).resolve().parents[1]

SKILL_MD = """---
name: Changelog Formatter
description: Use this when you need to turn raw git commits into grouped markdown changelog sections.
allowed-tools: [Bash, Read]
model: claude-opus-4-8
---

# Changelog Formatter

Group commits by type, then render markdown.

1. Read the commit list.
2. Classify each commit.
3. Emit grouped sections.
"""


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_skill(tmp_path: Path) -> Path:
    skill_dir = tmp_path / "changelog-formatter"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    return skill_dir


def _public_key(private_key: Ed25519PrivateKey) -> str:
    return base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")


def test_native_skill_import_and_list_cli(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    store = tmp_path / "store"
    runner = CliRunner()

    result = runner.invoke(app, ["skill", "import", str(skill_dir), "--store-dir", str(store), "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["skill"]["slug"] == "changelog-formatter"
    assert payload["skill"]["name"] == "Changelog Formatter"
    assert payload["skill"]["label"] == "local-dev"
    assert payload["skill"]["executable"] is False
    assert payload["skill"]["source_digest"].startswith("sha256:")

    listed = runner.invoke(app, ["skill", "list", "--store-dir", str(store), "--json"])
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["skills"][0]["slug"] == "changelog-formatter"

    synced = runner.invoke(
        app,
        [
            "skill",
            "sync",
            "--skill",
            "changelog-formatter",
            "--target",
            "codex",
            "--store-dir",
            str(store),
            "--lock",
            str(tmp_path / "projection.lock"),
            "--json",
        ],
        env={"SUPERCLAW_CODEX_SKILLS_DIR": str(tmp_path / "codex-skills")},
    )
    assert synced.exit_code == 0, synced.output
    sync_payload = json.loads(synced.output)
    assert sync_payload["ok"] is True
    written = Path(sync_payload["written"][0])
    assert written == tmp_path / "codex-skills" / "changelog-formatter" / "SKILL.md"
    assert written.exists()


def test_legacy_plugin_import_skill_warns_and_uses_native_store(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    store = tmp_path / "store"
    runner = CliRunner()

    result = runner.invoke(app, ["plugin", "import-skill", str(skill_dir), "--store-dir", str(store), "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert "deprecated" in payload["warning"]
    assert payload["skill"]["slug"] == "changelog-formatter"
    assert (store / "changelog-formatter" / "SKILL.md").exists()


def test_cli_native_skill_import_requires_signature_for_non_local_labels(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    runner = CliRunner()

    unsigned = runner.invoke(app, ["skill", "import", str(skill_dir), "--store-dir", str(tmp_path / "unsigned"), "--label", "community", "--json"])
    assert unsigned.exit_code == 1
    assert "require an Ed25519 signature" in json.loads(unsigned.output)["error"]

    private_key = Ed25519PrivateKey.generate()
    digest = compute_skill_source_digest(skill_dir)
    signature = "ed25519:" + base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    signed = runner.invoke(
        app,
        [
            "skill",
            "import",
            str(skill_dir),
            "--store-dir",
            str(tmp_path / "signed"),
            "--label",
            "community",
            "--signature",
            signature,
            "--public-key",
            _public_key(private_key),
            "--json",
        ],
    )

    assert signed.exit_code == 0, signed.output
    assert json.loads(signed.output)["skill"]["label"] == "community"


def test_cli_native_skill_import_requires_explicit_executable_opt_in(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    bin_dir = skill_dir / "assets" / "bin"
    bin_dir.mkdir(parents=True)
    script = bin_dir / "run.sh"
    script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | 0o111)
    runner = CliRunner()

    blocked = runner.invoke(app, ["skill", "import", str(skill_dir), "--store-dir", str(tmp_path / "blocked"), "--json"])
    assert blocked.exit_code == 1
    assert "--yes-executable" in json.loads(blocked.output)["error"]

    imported = runner.invoke(
        app,
        ["skill", "import", str(skill_dir), "--store-dir", str(tmp_path / "allowed"), "--yes-executable", "--json"],
    )
    assert imported.exit_code == 0, imported.output
    assert json.loads(imported.output)["skill"]["executable"] is True


def test_import_skill_module_still_produces_schema_valid_governed_plugin(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    target = tmp_path / "out"

    result = skill_import.import_skill_as_plugin(skill_dir, output_dir=target)

    assert result.plugin_id == "skill.changelog-formatter"
    assert result.tool_name == "changelog_formatter_skill"
    assert result.skill_name == "Changelog Formatter"

    manifest = _load_json(target / "superclaw-plugin.json")
    Draft202012Validator(_load_json(ROOT / "schemas" / "superclaw-plugin.schema.json")).validate(manifest)

    # A skill is pure prose: the wrapper must grant zero capabilities and route the
    # body through a single mcp_sidecar tool.
    assert manifest["runtime"]["type"] == "mcp_sidecar"
    assert manifest["skill_origin"] is True
    assert manifest["permissions"] == {"filesystem": [], "network": [], "environment": []}
    assert manifest["commerce"]["pricing_model"] == "free"
    assert [tool["name"] for tool in manifest["tools"]] == ["changelog_formatter_skill"]
    assert manifest["tools"][0]["description"].startswith("Use this when you need")

    # The sidecar returns the body verbatim and the normalized SKILL.md keeps the
    # skill source; Claude-only frontmatter that has no meaning here is gone.
    assert "Group commits by type" in (target / "skill" / "body.md").read_text(encoding="utf-8")
    normalized = (target / "skill" / "SKILL.md").read_text(encoding="utf-8")
    assert "allowed-tools" not in normalized
    assert "model:" not in normalized


def test_imported_skill_packs_signs_verifies_and_returns_body(tmp_path: Path):
    skill_dir = _write_skill(tmp_path)
    target = tmp_path / "out"
    dist = tmp_path / "dist"
    cache = tmp_path / "cache"
    artifacts = tmp_path / "artifacts"
    imported = skill_import.import_skill_as_plugin(skill_dir, output_dir=target)
    packed = pack_plugin_package(imported.package_root, dist_dir=dist, dev_sign=True)
    assert packed.signed is True
    assert packed.public_key

    # The packed archive clears the full trust chain (digest + signature) and the
    # governed proxy returns the skill body — third-party skill, native governance.
    # Installed through a LOCAL entry (a self-built skill) so the provenance gate
    # grades it `local` (sign-free equippable) and the proxy lets it execute.
    verified = verify_plugin_package(
        packed.package_path,
        public_key=packed.public_key,
        cache_root=cache,
        provenance="local",
        install_entry="skill-build",
    )
    assert verified.plugin_id == "skill.changelog-formatter"

    result = invoke_cached_plugin_tool(
        "skill.changelog-formatter",
        "changelog_formatter_skill",
        {},
        cache_root=cache,
        public_key=packed.public_key,
        artifact_dir=artifacts,
    )
    assert result.ok is True
    assert "Group commits by type" in json.dumps(result.model_response, ensure_ascii=False)


def test_import_skill_requires_a_description(tmp_path: Path):
    skill_dir = tmp_path / "no-desc"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: No Desc\n---\n\nBody only.\n", encoding="utf-8")
    runner = CliRunner()

    result = runner.invoke(app, ["skill", "import", str(skill_dir), "--store-dir", str(tmp_path / "out"), "--json"])

    assert result.exit_code == 1
    assert json.loads(result.output)["ok"] is False


def test_skill_origin_classifier_prefers_manifest_flag_with_prefix_fallback():
    # Authoritative signal: the signed manifest flag.
    assert plugins.is_skill_origin_plugin("com.example.anything", True) is True
    # Backward-compat fallback for skill packages produced before the field existed.
    assert plugins.is_skill_origin_plugin("skill.legacy-thing", None) is True
    # A plain tool plugin is never a skill.
    assert plugins.is_skill_origin_plugin("com.example.repo-scanner", None) is False
    assert plugins.is_skill_origin_plugin("com.example.repo-scanner", False) is False


def test_skill_import_constants_match_their_owning_modules():
    # The constants are duplicated to keep the file-emission path free of the
    # cryptography signing stack; this guard fails if they ever drift.
    assert skill_import.MANIFEST_NAME == plugins.MANIFEST_NAME
    assert skill_import.PLUGIN_ID_RE.pattern == plugin_devkit.PLUGIN_ID_RE.pattern
    assert skill_import.TOOL_NAME_RE.pattern == plugin_devkit.TOOL_NAME_RE.pattern
