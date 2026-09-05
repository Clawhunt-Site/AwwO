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
from superclaw.skill_sync import load_projection_lock

runner = CliRunner()


def _install_signed_skill(work: Path, cache_root: Path, plugin_id: str = "skill.greeter") -> str:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(
        private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    skill_md = work / f"{plugin_id}-SKILL.md"
    skill_md.write_text("---\nname: greeter\ndescription: Greet\n---\n\n# Greet\n", encoding="utf-8")
    pkg = work / f"pkg-{plugin_id}"
    import_skill_as_plugin(skill_md, output_dir=pkg, plugin_id=plugin_id)
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


def test_uninstall_reclaims_projected_skills(tmp_path, monkeypatch):
    # The CLI install/uninstall happen through the real cache; sync is exercised
    # directly here (install-from-cloud needs registry metadata), then we assert
    # `plugin uninstall` reclaims what sync wrote.
    cache_root = tmp_path / "cache"
    public_key = _install_signed_skill(tmp_path, cache_root)
    codex_dir = tmp_path / "codex-skills"
    lock = tmp_path / "projections.lock"

    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(codex_dir))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    synced = runner.invoke(app, ["plugin", "sync-skills", "--target", "codex", "--lock", str(lock), "--json"])
    assert synced.exit_code == 0, synced.stdout
    written = Path(json.loads(synced.stdout)["written"][0])
    assert written.exists()

    out = runner.invoke(app, ["plugin", "uninstall", "skill.greeter", "--lock", str(lock), "--json"])
    assert out.exit_code == 0, out.stdout
    payload = json.loads(out.stdout)
    assert payload["skills_removed"] == [str(written)]
    assert payload["removed"] is True
    assert not written.exists()
    assert load_projection_lock(lock) == {}


def test_uninstall_keep_skills_leaves_files(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    public_key = _install_signed_skill(tmp_path, cache_root)
    codex_dir = tmp_path / "codex-skills"
    lock = tmp_path / "projections.lock"

    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(codex_dir))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    synced = runner.invoke(app, ["plugin", "sync-skills", "--target", "codex", "--lock", str(lock), "--json"])
    written = Path(json.loads(synced.stdout)["written"][0])

    out = runner.invoke(app, ["plugin", "uninstall", "skill.greeter", "--lock", str(lock), "--keep-skills", "--json"])
    assert out.exit_code == 0, out.stdout
    payload = json.loads(out.stdout)
    assert "skills_removed" not in payload
    assert payload["removed"] is True
    assert written.exists()  # skill files left in place
