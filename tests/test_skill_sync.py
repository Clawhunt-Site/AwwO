from __future__ import annotations

import base64
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package
from superclaw.skill_store import import_skill
from superclaw.skill_import import import_skill_as_plugin
from superclaw.skill_sync import (
    MANAGED_MARKER,
    NATIVE_TIER,
    PROXY_TIER,
    ProjectionRecord,
    RUNTIME_TARGETS,
    SkillSyncError,
    _digest,
    load_projection_lock,
    native_skill_status,
    plan_native_skill_sync,
    plan_plugin_skill_sync,
    render_proxy_skill,
    resolve_targets,
    save_projection_lock,
    sync_native_skills,
    sync_plugin_skills,
    unsync_plugin_skills,
)

ROOT = Path(__file__).resolve().parents[1]


def FIXED_NOW() -> datetime:
    return datetime(2026, 6, 9, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Signed-package fixtures — sync routes through the fail-closed governance gate.
# --------------------------------------------------------------------------- #


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(
        private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    return private_key, public_key


def _sign_and_install(
    pkg: Path,
    cache_root: Path,
    private_key: Ed25519PrivateKey,
    public_key: str,
    *,
    provenance: str | None = None,
    install_entry: str = "test",
) -> str:
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
    verify_plugin_package(
        pkg,
        public_key=public_key,
        cache_root=cache_root,
        provenance=provenance,
        install_entry=install_entry,
    )
    return str(manifest["id"])


def _install_skill(work: Path, cache_root: Path, private_key, public_key, plugin_id: str = "skill.greeter") -> str:
    skill_md = work / f"{plugin_id}-SKILL.md"
    skill_md.write_text("---\nname: greeter\ndescription: Greet\n---\n\n# Greet\n", encoding="utf-8")
    pkg = work / f"pkg-{plugin_id}"
    import_skill_as_plugin(skill_md, output_dir=pkg, plugin_id=plugin_id)
    # A self-built skill is installed through a LOCAL entry (sign-free equippable
    # under the provenance model); stamp it so the gate grades it `local`.
    return _sign_and_install(
        pkg, cache_root, private_key, public_key, provenance="local", install_entry="skill-build"
    )


def _install_governed(work: Path, cache_root: Path, private_key, public_key) -> str:
    pkg = work / "pkg-hello"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", pkg)
    return _sign_and_install(pkg, cache_root, private_key, public_key)


# --------------------------------------------------------------------------- #
# Target resolution (de-hardcoded; absolute env override)
# --------------------------------------------------------------------------- #


def test_env_override_wins(tmp_path):
    target = RUNTIME_TARGETS["codex"]
    override = tmp_path / "custom-skills"
    resolved = target.skills_dir(home=tmp_path, env={"SUPERCLAW_CODEX_SKILLS_DIR": str(override)})
    assert resolved == override.resolve()


def test_relative_env_override_rejected(tmp_path):
    target = RUNTIME_TARGETS["codex"]
    with pytest.raises(SkillSyncError):
        target.skills_dir(home=tmp_path, env={"SUPERCLAW_CODEX_SKILLS_DIR": "relative/path"})


def test_probe_prefers_existing_alternate(tmp_path):
    target = RUNTIME_TARGETS["codex"]
    (tmp_path / ".agents" / "skills").mkdir(parents=True)
    resolved = target.skills_dir(home=tmp_path, env={})
    assert resolved == tmp_path / ".agents" / "skills"


def test_default_when_nothing_exists(tmp_path):
    target = RUNTIME_TARGETS["codex"]
    resolved = target.skills_dir(home=tmp_path, env={})
    assert resolved == tmp_path / ".codex" / "skills"


def test_resolve_targets_unknown_raises():
    with pytest.raises(SkillSyncError):
        resolve_targets(("not-a-runtime",))


# --------------------------------------------------------------------------- #
# Rendering (discovery-only / proxy, B-fast)
# --------------------------------------------------------------------------- #


def test_proxy_render_names_tool_and_carries_marker():
    manifest = {"id": "scanner.repo", "tools": [{"name": "scan"}]}
    content = render_proxy_skill(manifest, {"name": "scan", "description": "Scan a repo", "input_schema": {"type": "object"}})
    assert MANAGED_MARKER in content
    assert "superclaw__scanner_repo__scan" in content
    assert "MCP proxy" in content


# --------------------------------------------------------------------------- #
# Native skill projection — full file copy from skill_store, no plugin gate
# --------------------------------------------------------------------------- #


def _write_native_skill(tmp_path: Path) -> Path:
    source = tmp_path / "native-greeter"
    (source / "assets").mkdir(parents=True)
    (source / "SKILL.md").write_text(
        "---\nname: Native Greeter\ndescription: Native greeting helper\n---\n\n# Native Greeter\n\nUse directly.\n",
        encoding="utf-8",
    )
    (source / "assets" / "guide.md").write_text("# Guide\n", encoding="utf-8")
    return source


def test_native_sync_copies_full_skill_and_assets(tmp_path):
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"

    plans = plan_native_skill_sync(store_dir=store, targets=("codex",), home=tmp_path, env={})
    assert {Path(plan["path"]).name for plan in plans} == {"SKILL.md", "guide.md"}
    assert {plan["tier"] for plan in plans} == {NATIVE_TIER}

    result = sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)

    skill_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    asset_path = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "guide.md"
    assert str(skill_path) in result.written
    assert str(asset_path) in result.written
    content = skill_path.read_text(encoding="utf-8")
    assert "# Native Greeter" in content
    assert "MCP proxy" not in content
    assert MANAGED_MARKER not in content
    assert asset_path.read_text(encoding="utf-8") == "# Guide\n"
    records = load_projection_lock(lock)
    assert records[str(skill_path)].tier == "native"
    assert records[str(asset_path)].tier == "native"


def test_native_sync_preserves_asset_mode(tmp_path):
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    script = source / "assets" / "run.sh"
    script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | 0o111)
    import_skill(source, store_dir=store, allow_executable=True)
    lock = tmp_path / "projections.lock"

    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)

    projected = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "run.sh"
    assert projected.stat().st_mode & 0o111


def test_native_sync_respects_local_override_and_reconciles_store_removal(tmp_path):
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    skill_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    asset_path = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "guide.md"
    skill_path.write_text("user edit", encoding="utf-8")

    shutil.rmtree(store / "native-greeter")
    result = sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)

    assert str(skill_path) in result.skipped_local_override
    assert skill_path.exists()
    assert str(asset_path) in result.reclaimed
    assert not asset_path.exists()
    assert (tmp_path / ".codex" / "skills").is_dir()


def test_native_sync_reclaims_previously_projected_revoked_skill(tmp_path):
    """PR-0 §5 5c: a skill revoked AFTER projection is reclaimed on re-sync.

    The revocation closes end-to-end — not just "refuse new" — so a skill that
    was already copied into a runtime skill dir is deleted when it lands on the
    revocation list and sync runs again.
    """
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    record = import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    skill_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    asset_path = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "guide.md"
    assert skill_path.exists()
    assert asset_path.exists()

    revocations = tmp_path / "revocations.json"
    revocations.write_text(json.dumps({"revoked": [{"store_digest": record.store_digest}]}), encoding="utf-8")

    result = sync_native_skills(
        store_dir=store,
        targets=("codex",),
        home=tmp_path,
        env={},
        lock_path=lock,
        revocation_file=revocations,
        now=FIXED_NOW,
    )

    assert str(skill_path) in result.reclaimed
    assert str(asset_path) in result.reclaimed
    assert not skill_path.exists()
    assert not asset_path.exists()
    # Ledger no longer tracks the reclaimed projections.
    records = load_projection_lock(lock)
    assert str(skill_path) not in records
    assert str(asset_path) not in records


def test_native_reconcile_does_not_remove_runtime_skills_root(tmp_path):
    store = tmp_path / "store"
    source = tmp_path / "solo"
    source.mkdir()
    (source / "SKILL.md").write_text(
        "---\nname: Solo\ndescription: Solo helper\n---\n\n# Solo\n",
        encoding="utf-8",
    )
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    skills_root = tmp_path / ".codex" / "skills"
    assert skills_root.is_dir()

    shutil.rmtree(store / "solo")
    result = sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)

    assert result.reclaimed == [str(skills_root / "solo" / "SKILL.md")]
    assert skills_root.is_dir()


def test_native_and_proxy_projections_coexist_without_shadowing(tmp_path):
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    proxy_path = tmp_path / ".codex" / "skills" / "skill-native-greeter-tool" / "SKILL.md"
    proxy_content = render_proxy_skill({"id": "skill.native-greeter"}, {"name": "tool", "input_schema": {}})
    proxy_path.parent.mkdir(parents=True, exist_ok=True)
    proxy_path.write_text(proxy_content, encoding="utf-8")
    save_projection_lock(
        lock,
        {
            str(proxy_path): ProjectionRecord(
                "skill.native-greeter",
                "0.1.0",
                "codex",
                PROXY_TIER,
                str(proxy_path),
                _digest(proxy_content),
                "sha256:proxy",
                FIXED_NOW().isoformat(),
            )
        },
    )

    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)

    records = load_projection_lock(lock)
    assert records[str(proxy_path)].tier == PROXY_TIER
    assert proxy_path.read_text(encoding="utf-8") == proxy_content
    native_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    assert records[str(native_path)].tier == NATIVE_TIER
    assert records[str(native_path)].plugin_id == "native-greeter"


def test_plugin_sync_ignores_native_projection_records(tmp_path):
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.proxy-greeter")
    lock = tmp_path / "projections.lock"
    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    native_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    assert native_path.exists()

    result = sync_plugin_skills(
        cache_root=cache_root,
        targets=("codex",),
        home=tmp_path,
        env={},
        public_key=public_key,
        lock_path=lock,
        now=FIXED_NOW,
    )

    assert str(native_path) not in result.reclaimed
    assert native_path.exists()
    records = load_projection_lock(lock)
    assert records[str(native_path)].tier == NATIVE_TIER
    assert any(record.tier == PROXY_TIER for record in records.values())


# --------------------------------------------------------------------------- #
# Governance gate — only allowed plugins are projected
# --------------------------------------------------------------------------- #


def test_unsigned_plugin_is_not_projected(tmp_path):
    cache_root = tmp_path / "cache"
    plugin_dir = cache_root / "skill.rogue" / "1.0.0"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "superclaw-plugin.json").write_text(
        json.dumps({"id": "skill.rogue", "version": "1.0.0", "provenance": {"package_digest": "sha256:" + "0" * 64}}),
        encoding="utf-8",
    )
    plans = plan_plugin_skill_sync(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key="")
    assert plans == []


# --------------------------------------------------------------------------- #
# sync + idempotency + drift
# --------------------------------------------------------------------------- #


def test_sync_writes_and_is_idempotent(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"

    first = sync_plugin_skills(
        cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key,
        lock_path=lock, now=FIXED_NOW,
    )
    assert len(first.written) == 1
    written_path = Path(first.written[0])
    assert written_path.exists()
    assert MANAGED_MARKER in written_path.read_text(encoding="utf-8")

    second = sync_plugin_skills(
        cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key,
        lock_path=lock, now=FIXED_NOW,
    )
    assert second.written == []
    assert second.unchanged == [str(written_path)]
    assert load_projection_lock(lock)[str(written_path)].tier == "proxy"


def test_sync_respects_local_override(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))
    Path(written).write_text("user hand-edited this, no marker", encoding="utf-8")

    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert result.skipped_local_override == [written]
    assert Path(written).read_text(encoding="utf-8") == "user hand-edited this, no marker"


# --------------------------------------------------------------------------- #
# Reconcile (the acceptance blocker) — stale projections are reclaimed
# --------------------------------------------------------------------------- #


def test_full_sync_reclaims_uninstalled(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))
    assert Path(written).exists()

    # Simulate uninstall: drop the plugin from the cache, then re-sync.
    shutil.rmtree(cache_root / "skill.greeter")
    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert result.reclaimed == [written]
    assert not Path(written).exists()
    assert load_projection_lock(lock) == {}


def test_full_sync_tombstones_revoked(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    pid = _install_governed(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    revocation = tmp_path / "revocations.json"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, revocation_file=revocation, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))

    # Revoke the plugin, then re-sync: the projection must be tombstoned.
    revocation.write_text(json.dumps({"revoked": [{"plugin_id": pid}]}), encoding="utf-8")
    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, revocation_file=revocation, lock_path=lock, now=FIXED_NOW)
    assert result.tombstoned == [written]
    assert "revoked" in Path(written).read_text(encoding="utf-8").lower()


def test_full_sync_does_not_nuke_on_missing_key(tmp_path):
    # The footgun guard: an enumeration that returns nothing (e.g. wrong key)
    # must NOT reclaim existing projections — the plugin is still installed.
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))

    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key="", lock_path=lock, now=FIXED_NOW)
    assert result.reclaimed == []
    assert result.tombstoned == []
    assert Path(written).exists()  # still installed -> kept


def test_full_sync_reclaims_removed_tool(tmp_path):
    # A plugin stays installed but one of its tools is removed: the stale tool's
    # SKILL.md must be reclaimed (not left as a discovery hallucination).
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    pid = _install_governed(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)

    # Inject a stale record for a tool the plugin no longer declares.
    records = load_projection_lock(lock)
    stale = tmp_path / ".codex" / "skills" / f"{pid.replace('.', '-')}-ghost" / "SKILL.md"
    stale.parent.mkdir(parents=True, exist_ok=True)
    content = render_proxy_skill({"id": pid}, {"name": "ghost", "input_schema": {}})
    stale.write_text(content, encoding="utf-8")
    from superclaw.skill_sync import ProjectionRecord, _digest, save_projection_lock

    records[str(stale)] = ProjectionRecord(pid, "0.1.0", "codex", "proxy", str(stale), _digest(content), "", "x")
    save_projection_lock(lock, records)

    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert str(stale) in result.reclaimed
    assert not stale.exists()


def test_full_sync_reclaims_when_plugin_drops_to_zero_tools(tmp_path):
    # B2: a plugin that passes the gate but now declares no tools must still be
    # recognized as allowed so its orphaned projection is reclaimed.
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    pid = _install_governed(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))
    assert Path(written).exists()

    # Re-sign the installed package with an empty tools list, then re-sync.
    manifest_path = cache_root / pid / "0.1.0" / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["tools"] = []
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(cache_root / pid / "0.1.0"))
    sig = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{sig}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert result.reclaimed == [written]
    assert not Path(written).exists()
    assert load_projection_lock(lock) == {}


def test_precise_revocation_spares_other_version(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    pid = _install_governed(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    revocation = tmp_path / "revocations.json"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, revocation_file=revocation, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))

    # Revoke a *different* version: the installed 0.1.0 projection must survive.
    revocation.write_text(json.dumps({"revoked": [{"plugin_id": pid, "version": "9.9.9"}]}), encoding="utf-8")
    result = sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, revocation_file=revocation, lock_path=lock, now=FIXED_NOW)
    assert result.tombstoned == []
    assert Path(written).exists()


def test_scoped_sync_reclaims_same_plugins_removed_tool(tmp_path):
    # The install --sync-skills upgrade case: a scoped sync must reclaim a tool
    # the *same* plugin no longer declares, while leaving other plugins alone.
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    pid = _install_governed(tmp_path, cache_root, private_key, public_key)
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.other")
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)

    # Inject a stale ghost tool for the governed plugin (as if removed on upgrade).
    from superclaw.skill_sync import ProjectionRecord, _digest, save_projection_lock

    records = load_projection_lock(lock)
    ghost = tmp_path / ".codex" / "skills" / f"{pid.replace('.', '-')}-ghost" / "SKILL.md"
    ghost.parent.mkdir(parents=True, exist_ok=True)
    content = render_proxy_skill({"id": pid}, {"name": "ghost", "input_schema": {}})
    ghost.write_text(content, encoding="utf-8")
    records[str(ghost)] = ProjectionRecord(pid, "0.1.0", "codex", "proxy", str(ghost), _digest(content), "", "x")
    save_projection_lock(lock, records)

    other_before = {k for k, v in load_projection_lock(lock).items() if v.plugin_id == "skill.other"}
    result = sync_plugin_skills(plugin_id=pid, cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert str(ghost) in result.reclaimed
    assert not ghost.exists()
    # The unrelated plugin's projection is untouched by the scoped sync.
    assert other_before <= set(load_projection_lock(lock))


def test_scoped_sync_does_not_reconcile(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.greeter")
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.other")
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert len(load_projection_lock(lock)) == 2

    shutil.rmtree(cache_root / "skill.other")
    # A scoped sync of one plugin must not touch the other's projection.
    result = sync_plugin_skills(plugin_id="skill.greeter", cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    assert result.reclaimed == []
    assert len(load_projection_lock(lock)) == 2


# --------------------------------------------------------------------------- #
# unsync
# --------------------------------------------------------------------------- #


def test_concurrent_sync_keeps_lock_consistent(tmp_path):
    # Two syncs racing on the same ledger must not corrupt it (file-locked RMW).
    import threading

    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.greeter")
    _install_skill(tmp_path, cache_root, private_key, public_key, "skill.other")
    lock = tmp_path / "projections.lock"

    def run():
        sync_plugin_skills(cache_root=cache_root, targets=("codex", "claude"), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    records = load_projection_lock(lock)  # parses -> not corrupted
    # 2 plugins x 2 targets x 1 tool each = 4 stable projections.
    assert len(records) == 4


def test_unsync_removes_managed_file(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))

    result = unsync_plugin_skills(plugin_id="skill.greeter", lock_path=lock)
    assert result.removed == [written]
    assert not Path(written).exists()
    assert load_projection_lock(lock) == {}


def test_unsync_keeps_local_override(tmp_path):
    cache_root = tmp_path / "cache"
    private_key, public_key = _keypair()
    _install_skill(tmp_path, cache_root, private_key, public_key)
    lock = tmp_path / "projections.lock"
    sync_plugin_skills(cache_root=cache_root, targets=("codex",), home=tmp_path, env={}, public_key=public_key, lock_path=lock, now=FIXED_NOW)
    written = next(iter(load_projection_lock(lock)))
    Path(written).write_text("user owns this now", encoding="utf-8")

    result = unsync_plugin_skills(plugin_id="skill.greeter", lock_path=lock)
    assert result.skipped_local_override == [written]
    assert Path(written).exists()


# --------------------------------------------------------------------------- #
# Collision / force safety (A): native sync must never seize a same-named skill
# it did not project, even under --force, and must never inject asset files into
# a stranger's same-named skill directory.
# --------------------------------------------------------------------------- #


def test_native_sync_never_overwrites_foreign_skill_even_with_force(tmp_path):
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)
    lock = tmp_path / "projections.lock"
    # A foreign skill (authored by the user / another tool) already occupies the
    # slot. We have NO ledger record for it.
    foreign = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    foreign.parent.mkdir(parents=True)
    foreign.write_text("FOREIGN — not ours\n", encoding="utf-8")

    result = sync_native_skills(
        store_dir=store, targets=("codex",), home=tmp_path, env={},
        lock_path=lock, force=True, now=FIXED_NOW,
    )

    # Even with --force, the foreign file is preserved and reported, never written.
    assert str(foreign) in result.skipped_local_override
    assert str(foreign) not in result.written
    assert foreign.read_text(encoding="utf-8") == "FOREIGN — not ours\n"


def test_native_sync_does_not_inject_assets_into_foreign_skill_dir(tmp_path):
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)  # has assets/guide.md
    lock = tmp_path / "projections.lock"
    # Foreign SKILL.md present, but the foreign dir has none of our asset files.
    foreign_root = tmp_path / ".codex" / "skills" / "native-greeter"
    foreign_root.mkdir(parents=True)
    (foreign_root / "SKILL.md").write_text("FOREIGN\n", encoding="utf-8")

    result = sync_native_skills(
        store_dir=store, targets=("codex",), home=tmp_path, env={},
        lock_path=lock, now=FIXED_NOW,
    )

    # The whole skill is held back (directory-atomic): our asset is NOT injected.
    assert result.written == []
    assert not (foreign_root / "assets" / "guide.md").exists()
    # The collision is reported once at the SKILL.md slot.
    assert str(foreign_root / "SKILL.md") in result.skipped_local_override


def test_native_sync_force_still_reasserts_our_own_hand_edited_projection(tmp_path):
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)
    lock = tmp_path / "projections.lock"
    sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    skill_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    skill_path.write_text("user edit of OUR projection", encoding="utf-8")

    # Without force: our hand-edited projection is preserved.
    no_force = sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, now=FIXED_NOW)
    assert str(skill_path) in no_force.skipped_local_override

    # With force: it IS re-asserted (this is the documented force purpose — it
    # only ever touches files we have a ledger record for).
    forced = sync_native_skills(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock, force=True, now=FIXED_NOW)
    assert str(skill_path) in forced.written
    assert "# Native Greeter" in skill_path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# native_skill_status (D): read-only projection-health report surfaces the drift
# the silent file-copy model would otherwise hide.
# --------------------------------------------------------------------------- #


def _status_for(rows, slug, target):
    for row in rows:
        if row["slug"] == slug and row["target"] == target:
            return row["status"]
    return None


def test_native_skill_status_reports_full_lifecycle(tmp_path):
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)

    # Before sync: governed in store but not active in any runtime.
    rows = native_skill_status(**common)
    assert _status_for(rows, "native-greeter", "codex") == "not_projected"

    # After sync: ok.
    sync_native_skills(now=FIXED_NOW, **common)
    rows = native_skill_status(**common)
    assert _status_for(rows, "native-greeter", "codex") == "ok"

    # Hand-edit our projection: drift_local_edit.
    skill_path = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    skill_path.write_text("hand edit", encoding="utf-8")
    rows = native_skill_status(**common)
    assert _status_for(rows, "native-greeter", "codex") == "drift_local_edit"


def test_native_skill_status_flags_foreign_and_stale(tmp_path):
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)

    # Foreign collision: a same-named SKILL.md we never projected.
    foreign = tmp_path / ".codex" / "skills" / "native-greeter" / "SKILL.md"
    foreign.parent.mkdir(parents=True)
    foreign.write_text("FOREIGN\n", encoding="utf-8")
    rows = native_skill_status(**common)
    assert _status_for(rows, "native-greeter", "codex") == "foreign_collision"

    # Stale-revoked: project ours, then remove from store; the file lingers until
    # the next sync reclaims it, and status must flag it meanwhile.
    foreign.unlink()
    sync_native_skills(now=FIXED_NOW, **common)
    shutil.rmtree(store / "native-greeter")
    rows = native_skill_status(**common)
    assert _status_for(rows, "native-greeter", "codex") == "stale_revoked"


def test_native_skill_status_detects_asset_drift_not_just_skill_md(tmp_path):
    """Regression (advisor-flagged): status aggregates over EVERY projected file.
    An asset edited/deleted with SKILL.md untouched must NOT read as ok — that
    would disagree with what sync actually does (it skips the drifted asset)."""
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)  # has assets/guide.md
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)
    sync_native_skills(now=FIXED_NOW, **common)
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "ok"

    asset = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "guide.md"
    # SKILL.md untouched; only the asset drifts.
    asset.write_text("hand-edited asset", encoding="utf-8")
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "drift_local_edit"

    # A deleted asset surfaces as a missing projection (still not ok).
    asset.write_text("# Guide\n", encoding="utf-8")  # restore digest first
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "ok"
    asset.unlink()
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "missing_projection"


def test_native_skill_status_stale_revoked_is_one_row_per_skill(tmp_path):
    """Regression (advisor-flagged): a revoked skill with assets must collapse to
    a single stale_revoked row per (skill, target), not one row per asset file."""
    store = tmp_path / "store"
    import_skill(_write_native_skill(tmp_path), store_dir=store)  # SKILL.md + asset
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)
    sync_native_skills(now=FIXED_NOW, **common)
    shutil.rmtree(store / "native-greeter")  # both files linger on disk

    rows = native_skill_status(**common)
    stale = [r for r in rows if r["slug"] == "native-greeter" and r["status"] == "stale_revoked"]
    assert len(stale) == 1


def test_native_skill_status_store_added_asset_is_drift_store_updated(tmp_path):
    """Advisor follow-up: a NEW asset added to the store after projection (via a
    legitimate re-import that regenerates provenance — a direct store edit would
    trip tamper detection) surfaces as drift_store_updated (re-sync to pick up)."""
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)
    sync_native_skills(now=FIXED_NOW, **common)
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "ok"

    # Legitimately update the store skill: add an asset to the SOURCE and re-import
    # (force replaces the stored build and regenerates its provenance digest).
    (source / "assets" / "extra.md").write_text("# Extra\n", encoding="utf-8")
    import_skill(source, store_dir=store, force=True)
    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "drift_store_updated"


def test_native_skill_status_foreign_file_at_asset_slot_is_drift_not_resync(tmp_path):
    """Advisor follow-up: when an unrecorded file already occupies an asset slot,
    sync skips it (local override), so status must NOT claim a clean re-sync —
    it reports drift_local_edit, the honest, sync-consistent state."""
    store = tmp_path / "store"
    source = _write_native_skill(tmp_path)
    import_skill(source, store_dir=store)
    lock = tmp_path / "projections.lock"
    common = dict(store_dir=store, targets=("codex",), home=tmp_path, env={}, lock_path=lock)
    sync_native_skills(now=FIXED_NOW, **common)

    # Store gains a new asset (legit re-import) AND a foreign file already sits at
    # its runtime slot — sync would hold the slot back, so status must say drift,
    # not a clean "re-sync".
    (source / "assets" / "extra.md").write_text("# Extra\n", encoding="utf-8")
    import_skill(source, store_dir=store, force=True)
    slot = tmp_path / ".codex" / "skills" / "native-greeter" / "assets" / "extra.md"
    slot.parent.mkdir(parents=True, exist_ok=True)
    slot.write_text("FOREIGN at asset slot\n", encoding="utf-8")

    assert _status_for(native_skill_status(**common), "native-greeter", "codex") == "drift_local_edit"
