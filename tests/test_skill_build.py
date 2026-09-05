"""PR-2: build_and_install_skill_plugin — SKILL.md → equippable local skill.

Round-trip: a self-built SKILL.md installs as a `local`-graded, equippable
skill-origin plugin SIGN-FREE (no SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST), funnelled
through the same fail-closed gate the execution path enforces. Signing is
optional and a self-signature does NOT upgrade the `local` grade (no spoof).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from typer.testing import CliRunner

import superclaw.team_kernel as team_kernel
from superclaw.cli import app
from superclaw.models import AgentProfile
from superclaw.plugin_provenance import read_install_provenance
from superclaw.plugin_proxy import load_cached_package, verify_cached_package_before_execution
from superclaw.skill_build import (
    InstalledSkillPlugin,
    SkillBuildError,
    build_and_install_skill_plugin,
)

SKILL_MD = """---
name: Changelog Formatter
description: Group commits by type and render a release changelog.
---

# Changelog Formatter

Group commits by type. Render a clean changelog.
"""


def _write_skill(tmp_path: Path) -> Path:
    skill_dir = tmp_path / "changelog-formatter"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    return skill_dir


def _signing_key() -> str:
    pk = Ed25519PrivateKey.generate()
    raw = pk.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return base64.b64encode(raw).decode("ascii")


def test_build_installs_local_equippable_sign_free(tmp_path, monkeypatch):
    # No local-dev-trust env: sign-free admission must come from local provenance.
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"

    result = build_and_install_skill_plugin(skill, cache_root=cache_root)

    assert isinstance(result, InstalledSkillPlugin)
    assert result.plugin_id == "skill.changelog-formatter"
    assert result.trust_state == "local"
    assert result.equippable is True
    assert result.signed is False
    assert result.package_digest.startswith("sha256:")

    # The cached package carries a digest-matched `local` provenance stamp and
    # passes the SHARED runtime primitive sign-free.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    pkg = load_cached_package("skill.changelog-formatter", version="0.1.0")
    assert pkg is not None
    assert read_install_provenance(pkg) == "local"
    assert verify_cached_package_before_execution(pkg) is None

    # And it is equippable to a team agent that asks for it.
    assert "skill.changelog-formatter" in team_kernel.available_skill_ids()
    profile = AgentProfile(
        name="Eng", role="engineer", skill_allowlist=["skill.changelog-formatter"]
    )
    resolution = team_kernel.resolve_equipment(profile)
    assert resolution.skills_granted == ("skill.changelog-formatter",)


def test_build_signed_still_grades_local_no_spoof(tmp_path, monkeypatch):
    # A self-signature must NOT upgrade local to developer/official.
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"

    result = build_and_install_skill_plugin(
        skill, cache_root=cache_root, signing_private_key=_signing_key()
    )
    assert result.signed is True
    assert result.trust_state == "local"  # NOT developer/official
    assert result.equippable is True


def test_build_custom_plugin_id_and_version(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"

    result = build_and_install_skill_plugin(
        skill, plugin_id="skill.my-custom", version="2.1.0", cache_root=cache_root
    )
    assert result.plugin_id == "skill.my-custom"
    assert result.version == "2.1.0"
    assert result.trust_state == "local"


def test_build_missing_skill_raises(tmp_path):
    with pytest.raises(SkillBuildError):
        build_and_install_skill_plugin(tmp_path / "nope", cache_root=tmp_path / "cache")


def test_build_force_is_a_real_replacement_gate(tmp_path, monkeypatch):
    # force is NOT a silent no-op: a second build of the same id/version is refused
    # without force, and succeeds with force.
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"
    build_and_install_skill_plugin(skill, cache_root=cache_root)

    with pytest.raises(SkillBuildError, match="already installed"):
        build_and_install_skill_plugin(skill, cache_root=cache_root)

    # force=True replaces it.
    again = build_and_install_skill_plugin(skill, cache_root=cache_root, force=True)
    assert again.trust_state == "local"


def test_build_rolls_back_on_post_install_untrusted(tmp_path, monkeypatch):
    # A reserved-namespace local skill derives UNTRUSTED at the post-install gate.
    # The build must FAIL and ROLL BACK the cache entry (no poisoning partial state).
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"
    with pytest.raises(SkillBuildError, match="did not derive to a local equippable grade"):
        build_and_install_skill_plugin(
            skill, plugin_id="superclaw.evil", cache_root=cache_root
        )
    # The bad entry must NOT remain in the cache.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    assert load_cached_package("superclaw.evil", version="0.1.0") is None


def test_build_never_writes_cache_outside_local_entry(tmp_path, monkeypatch):
    # Arch guard: the only path into the cache is the local install entry, so the
    # built skill always carries a `local` provenance record (never absent =>
    # never silently graded remote).
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    skill = _write_skill(tmp_path)
    cache_root = tmp_path / "cache"
    build_and_install_skill_plugin(skill, cache_root=cache_root)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    pkg = load_cached_package("skill.changelog-formatter", version="0.1.0")
    assert pkg is not None
    assert read_install_provenance(pkg) == "local"


# --------------------------------------------------------------------------- #
# PR-3: CLI `skill build` — parity with the kernel orchestration.
# --------------------------------------------------------------------------- #


def test_cli_skill_build_installs_local_equippable(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "cache"))
    skill = _write_skill(tmp_path)

    result = CliRunner().invoke(app, ["skill", "build", str(skill), "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["plugin_id"] == "skill.changelog-formatter"
    assert payload["trust_state"] == "local"
    assert payload["equippable"] is True
    assert payload["signed"] is False
    # Equippable: it lands in the gated universe (read from the same cache).
    assert "skill.changelog-formatter" in team_kernel.available_skill_ids()


def test_cli_skill_install_is_alias_of_build(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "cache"))
    skill = _write_skill(tmp_path)

    result = CliRunner().invoke(
        app, ["skill", "install", str(skill), "--plugin-id", "skill.aliased", "--json"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["plugin_id"] == "skill.aliased"
    assert payload["trust_state"] == "local"


def test_cli_skill_build_missing_path_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "cache"))
    result = CliRunner().invoke(app, ["skill", "build", str(tmp_path / "nope"), "--json"])
    assert result.exit_code == 1
    assert json.loads(result.output)["ok"] is False
