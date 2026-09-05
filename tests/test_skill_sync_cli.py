from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package
from superclaw.skill_import import import_skill_as_plugin

ROOT = Path(__file__).resolve().parents[1]
runner = CliRunner()


def _install_signed_skill(work: Path, cache_root: Path) -> str:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(
        private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    skill_md = work / "greeter-SKILL.md"
    skill_md.write_text("---\nname: greeter\ndescription: Greet\n---\n\n# Greet\n", encoding="utf-8")
    pkg = work / "pkg"
    import_skill_as_plugin(skill_md, output_dir=pkg, plugin_id="skill.greeter")
    manifest_path = pkg / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(pkg))
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    verify_plugin_package(pkg, public_key=public_key, cache_root=cache_root)
    return public_key


def test_sync_skills_default_projection_lock_follows_superclaw_home(tmp_path, monkeypatch):
    """The CLI's default --lock must follow SUPERCLAW_HOME set AFTER import (single root),
    not a frozen import-time snapshot. Guards the option staying call-time resolved."""
    from superclaw.skill_sync import default_projection_lock

    cache_root = tmp_path / "cache"
    public_key = _install_signed_skill(tmp_path, cache_root)
    codex_dir = tmp_path / "codex-skills"
    home = tmp_path / "home" / ".superclaw"

    # `superclaw.cli.app` is already imported at module scope; set SUPERCLAW_HOME now.
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(codex_dir))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    assert default_projection_lock() == home / "projections.lock"

    # No --lock: the default must resolve under the post-import SUPERCLAW_HOME.
    synced = runner.invoke(app, ["plugin", "sync-skills", "--target", "codex", "--json"])
    assert synced.exit_code == 0, synced.stdout
    assert json.loads(synced.stdout)["ok"] is True
    assert (home / "projections.lock").exists()


def test_sync_and_unsync_skills_via_cli(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    public_key = _install_signed_skill(tmp_path, cache_root)
    codex_dir = tmp_path / "codex-skills"
    lock = tmp_path / "projections.lock"

    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(codex_dir))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    synced = runner.invoke(app, ["plugin", "sync-skills", "--target", "codex", "--lock", str(lock), "--json"])
    assert synced.exit_code == 0, synced.stdout
    payload = json.loads(synced.stdout)
    assert payload["ok"] is True
    assert len(payload["written"]) == 1
    written = Path(payload["written"][0])
    assert written.exists()
    assert written.is_relative_to(codex_dir)

    removed = runner.invoke(app, ["plugin", "unsync-skills", "skill.greeter", "--lock", str(lock), "--json"])
    assert removed.exit_code == 0, removed.stdout
    assert json.loads(removed.stdout)["removed"] == [str(written)]
    assert not written.exists()


def test_sync_unknown_target_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "empty-cache"))
    result = runner.invoke(app, ["plugin", "sync-skills", "--target", "not-a-runtime", "--json"])
    assert result.exit_code == 1
    assert json.loads(result.stdout)["ok"] is False
