from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.backends import _secret_free_mcp_servers
from superclaw.plugin_mcp_proxy import projected_tool_name
from superclaw.plugin_runtime_projection import (
    available_plugins,
    build_runtime_plugin_policy_addition,
    gate_passing_plugins,
)
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package

ROOT = Path(__file__).resolve().parents[1]
HELLO_ID = "dev.superclaw.hello-world"


def _cache_hello(tmp_path: Path) -> tuple[Path, str]:
    plugin_dir = tmp_path / "hello-world"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", plugin_dir)
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(
        private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    cache_root = tmp_path / "cache"
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    return cache_root, public_key


def _cache_hello_as(
    tmp_path: Path,
    *,
    version: str,
    private_key: Ed25519PrivateKey,
    public_key: str,
    cache_root: Path,
    source_name: str,
) -> None:
    plugin_dir = tmp_path / source_name
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", plugin_dir)
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = version
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)


def test_available_plugins_lists_installed_free_plugin(tmp_path: Path):
    cache_root, public_key = _cache_hello(tmp_path)
    plugins = available_plugins(cache_root=cache_root, public_key=public_key)
    assert [p.plugin_id for p in plugins] == [HELLO_ID]
    tool = plugins[0].tools[0]
    assert tool.tool_name == "hello_world"
    assert tool.projected_name == projected_tool_name(HELLO_ID, "hello_world")


def test_available_plugins_excludes_revoked(tmp_path: Path):
    cache_root, public_key = _cache_hello(tmp_path)
    revocation_file = tmp_path / "revocations.json"
    revocation_file.write_text(json.dumps({"revoked": [{"plugin_id": HELLO_ID}]}), encoding="utf-8")
    plugins = available_plugins(cache_root=cache_root, public_key=public_key, revocation_file=revocation_file)
    assert plugins == []  # fail-closed: revoked plugin is not offered


def test_same_id_different_signer_is_hard_conflict_before_latest_selection(tmp_path: Path, monkeypatch):
    """A newer local/dev signer must not shadow an older official package."""
    root_key = Ed25519PrivateKey.generate()
    root_public = base64.b64encode(
        root_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    dev_key = Ed25519PrivateKey.generate()
    dev_public = base64.b64encode(
        dev_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    cache_root = tmp_path / "cache"
    _cache_hello_as(
        tmp_path,
        version="0.1.0",
        private_key=root_key,
        public_key=root_public,
        cache_root=cache_root,
        source_name="official",
    )
    _cache_hello_as(
        tmp_path,
        version="0.2.0",
        private_key=dev_key,
        public_key=dev_public,
        cache_root=cache_root,
        source_name="developer",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", root_public)

    assert available_plugins(cache_root=cache_root, public_key=dev_public) == []
    assert gate_passing_plugins(cache_root=cache_root, public_key=dev_public) == []


def test_available_plugins_empty_for_empty_cache(tmp_path: Path):
    assert available_plugins(cache_root=tmp_path / "empty") == []


def test_build_runtime_plugin_policy_addition_secret_free_single_server(tmp_path: Path):
    cache_root, public_key = _cache_hello(tmp_path)
    artifact_dir = tmp_path / "artifacts"
    mcp_path, note = build_runtime_plugin_policy_addition(
        artifact_dir=artifact_dir, cache_root=cache_root, public_key=public_key
    )
    assert mcp_path is not None and note
    assert "superclaw__list_tools" in note

    config = json.loads(Path(mcp_path).read_text(encoding="utf-8"))
    assert list(config["mcpServers"].keys()) == ["superclaw"]
    server = config["mcpServers"]["superclaw"]
    assert "env" not in server  # secret-free
    assert "serve-aggregate" in server["args"]

    # Must pass SuperClaw's secret-free MCP projection guard (used by codex/claude).
    _secret_free_mcp_servers([mcp_path], backend_name="test")


def test_build_runtime_plugin_policy_addition_empty_when_no_plugins(tmp_path: Path):
    mcp_path, note = build_runtime_plugin_policy_addition(artifact_dir=tmp_path / "artifacts", cache_root=tmp_path / "empty")
    assert mcp_path is None and note is None


from types import SimpleNamespace  # noqa: E402

from superclaw.orchestrator import SuperClawOrchestrator  # noqa: E402
from superclaw.state import StateStore  # noqa: E402


def _orchestrator(tmp_path: Path) -> SuperClawOrchestrator:
    return SuperClawOrchestrator(StateStore(tmp_path / "state.db"))


def test_projection_injects_for_mcp_capable_backend(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")

    policy, note = orch._project_plugins_into_policy(None, [backend], tmp_path / "art")

    assert note and "superclaw__list_tools" in note
    assert policy is not None and len(policy.mcp_configs) == 1


def test_projection_skipped_for_non_mcp_backend(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    bobo = SimpleNamespace(name="bobo")

    policy, note = orch._project_plugins_into_policy(None, [bobo], tmp_path / "art")

    # bobo rejects mcp_configs, so it must never be injected (kept unchanged).
    assert policy is None and note is None


def test_projection_skipped_for_mixed_backends(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    backends = [SimpleNamespace(name="codex-app-server"), SimpleNamespace(name="bobo")]

    policy, note = orch._project_plugins_into_policy(None, backends, tmp_path / "art")

    assert policy is None and note is None  # any non-MCP backend disables injection


def test_projection_disabled_by_env(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    monkeypatch.setenv("SUPERCLAW_AUTO_PROJECT_PLUGINS", "0")
    orch = _orchestrator(tmp_path)

    policy, note = orch._project_plugins_into_policy(None, [SimpleNamespace(name="codex-app-server")], tmp_path / "art")

    assert policy is None and note is None  # kill switch honored


def test_projection_suppressed_and_stripped_under_low_trust(tmp_path, monkeypatch):
    # T11: a low-trust review fence must NOT gain an MCP/plugin tool surface (it can
    # reach the data-plane network the fence denies) — projection is suppressed AND
    # any pre-existing mcp_configs/plugin_dirs on the policy are stripped.
    from superclaw.containment import get_preset
    from superclaw.runtime import PermissionPolicy

    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    low = get_preset("low_trust_review")
    backend = SimpleNamespace(name="codex-app-server")

    # No injection even for an MCP-capable backend.
    policy, note = orch._project_plugins_into_policy(None, [backend], tmp_path / "art", low)
    assert policy is None and note is None

    # Pre-existing MCP/plugin surface is stripped (and reported).
    seeded = PermissionPolicy(mode="plan", mcp_configs=["/tmp/x.json"], plugin_dirs=["/tmp/p"])
    stripped, note = orch._project_plugins_into_policy(seeded, [backend], tmp_path / "art", low)
    assert stripped.mcp_configs == [] and stripped.plugin_dirs == []
    assert note and "suppressed" in note


# --- team-bound projection early-exits must fail-closed (Codex R2 blocker) ----
# Every early-exit (disabled env / non-MCP backend / projection failure) must not
# leave a team-bound run with a pre-existing un-narrowed plugin surface.


def _seeded_policy():
    from superclaw.runtime import PermissionPolicy

    return PermissionPolicy(mode="plan", mcp_configs=["/tmp/leftover.json"], plugin_dirs=["/tmp/p"])


def test_team_bound_disabled_env_strips_surface(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_AUTO_PROJECT_PLUGINS", "0")
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")
    stripped, note = orch._project_plugins_into_policy(
        _seeded_policy(), [backend], tmp_path / "art", None, frozenset({"granted-x"})
    )
    assert stripped.mcp_configs == [] and stripped.plugin_dirs == []
    assert note and "stripped" in note


def test_team_bound_non_mcp_backend_strips_surface(tmp_path, monkeypatch):
    orch = _orchestrator(tmp_path)
    bobo = SimpleNamespace(name="bobo")
    stripped, note = orch._project_plugins_into_policy(
        _seeded_policy(), [bobo], tmp_path / "art", None, frozenset({"granted-x"})
    )
    assert stripped.mcp_configs == [] and stripped.plugin_dirs == []
    assert note and "stripped" in note


def test_team_bound_projection_failure_strips_surface(tmp_path, monkeypatch):
    import superclaw.plugin_runtime_projection as proj

    def _boom(**kwargs):
        raise RuntimeError("projection blew up")

    monkeypatch.setattr(proj, "build_runtime_plugin_policy_addition", _boom)
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")
    stripped, note = orch._project_plugins_into_policy(
        _seeded_policy(), [backend], tmp_path / "art", None, frozenset({"granted-x"})
    )
    assert stripped.mcp_configs == [] and stripped.plugin_dirs == []
    assert note and ("fail-closed" in note or "stripped" in note)


def test_non_team_early_exit_does_not_strip(tmp_path, monkeypatch):
    # Zero behavioural change off the team path: a non-team run (allowed=None) keeps
    # its policy unchanged on the same early-exit.
    monkeypatch.setenv("SUPERCLAW_AUTO_PROJECT_PLUGINS", "0")
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")
    policy, note = orch._project_plugins_into_policy(
        _seeded_policy(), [backend], tmp_path / "art", None, None
    )
    assert policy.mcp_configs == ["/tmp/leftover.json"] and policy.plugin_dirs == ["/tmp/p"]
    assert note is None


def test_plugin_set_snapshot_is_self_contained(tmp_path):
    # The proxy is spawned by codex/claude, which may not forward env; the
    # snapshot must carry the cache root + (public) key itself.
    from superclaw.plugins import plugin_cache_root

    cache_root, public_key = _cache_hello(tmp_path)
    artifact_dir = tmp_path / "art"
    build_runtime_plugin_policy_addition(artifact_dir=artifact_dir, cache_root=cache_root, public_key=public_key)
    snap = json.loads((artifact_dir / "superclaw-plugin-set.json").read_text(encoding="utf-8"))
    assert snap["cache_root"] == str(plugin_cache_root(cache_root))
    assert snap["public_key"] == public_key
    assert snap["plugins"][0]["id"] == HELLO_ID


def test_each_run_gets_its_own_proxy_config_and_process(tmp_path):
    # artifact_root is per-run (.../<run_id>), so each run writes its own plugin-set
    # and MCP config -> codex/claude spawn DISTINCT proxy processes (no shared session).
    from superclaw.backends import _codex_mcp_config_overrides

    cache_root, public_key = _cache_hello(tmp_path)
    run_a = tmp_path / "run-aaaa" / "artifacts"  # mimics artifact_root = base/<run_id>
    run_b = tmp_path / "run-bbbb" / "artifacts"
    path_a, _ = build_runtime_plugin_policy_addition(artifact_dir=run_a, cache_root=cache_root, public_key=public_key)
    path_b, _ = build_runtime_plugin_policy_addition(artifact_dir=run_b, cache_root=cache_root, public_key=public_key)

    assert path_a != path_b
    args_a = json.loads(Path(path_a).read_text(encoding="utf-8"))["mcpServers"]["superclaw"]["args"]
    args_b = json.loads(Path(path_b).read_text(encoding="utf-8"))["mcpServers"]["superclaw"]["args"]
    set_a = [a for a in args_a if a.endswith("superclaw-plugin-set.json")]
    set_b = [a for a in args_b if a.endswith("superclaw-plugin-set.json")]
    assert set_a and set_b and set_a != set_b  # distinct per-run plugin-set path

    # The codex session cache keys on extra_args, so distinct configs => distinct
    # codex app-server processes => distinct aggregate proxy children (no cross-talk).
    assert _codex_mcp_config_overrides([path_a]) != _codex_mcp_config_overrides([path_b])


def test_available_plugins_dropped_without_key_or_trust(tmp_path: Path, monkeypatch):
    """Fail-closed default: a plugin we cannot verify (no key) is not offered."""
    cache_root, _ = _cache_hello(tmp_path)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    assert available_plugins(cache_root=cache_root, public_key=None) == []


def test_local_dev_trust_admits_unverified_plugin(tmp_path: Path, monkeypatch):
    """LOCAL_DEV trust (opt-in) lets a locally-installed, unverifiable plugin project."""
    cache_root, _ = _cache_hello(tmp_path)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    plugins = available_plugins(cache_root=cache_root, public_key=None)
    assert [p.plugin_id for p in plugins] == [HELLO_ID]


def test_local_dev_trust_still_enforces_integrity(tmp_path: Path, monkeypatch):
    """LOCAL_DEV trust relaxes only the signature, never package integrity."""
    cache_root, _ = _cache_hello(tmp_path)
    version_dir = next(p for p in (cache_root / HELLO_ID).iterdir() if p.is_dir())
    # Add a stray file after signing so the recomputed package digest no longer matches.
    (version_dir / "TAMPERED.txt").write_text("injected after signing\n", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    assert available_plugins(cache_root=cache_root, public_key=None) == []


def test_snapshot_carries_local_dev_trust(tmp_path: Path, monkeypatch):
    from superclaw.plugin_mcp_proxy import _load_plugin_set

    cache_root, _ = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    artifact_dir = tmp_path / "artifacts"
    mcp_path, _note = build_runtime_plugin_policy_addition(
        artifact_dir=artifact_dir, cache_root=cache_root, public_key=None
    )
    assert mcp_path
    snapshot_path = artifact_dir / "superclaw-plugin-set.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert snapshot.get("local_dev_trust") is True
    assert _load_plugin_set(snapshot_path)["local_dev_trust"] is True


def test_digest_ignores_generated_bytecode(tmp_path: Path):
    """Running a plugin writes __pycache__/*.pyc into its cached dir; that
    generated bytecode must not change the package digest or break verification."""
    from superclaw.plugins import compute_package_digest, load_plugin_package

    cache_root, public_key = _cache_hello(tmp_path)
    version_dir = next(p for p in (cache_root / HELLO_ID).iterdir() if p.is_dir())
    before = compute_package_digest(load_plugin_package(version_dir))

    # Simulate the sidecar importing plugin modules at runtime.
    pycache = version_dir / "scripts" / "__pycache__"
    pycache.mkdir(parents=True, exist_ok=True)
    (pycache / "mod.cpython-313.pyc").write_bytes(b"\x00generated bytecode\x00")

    after = compute_package_digest(load_plugin_package(version_dir))
    assert before == after  # digest stable despite the new .pyc

    # And the plugin still verifies / projects after the pollution.
    plugins = available_plugins(cache_root=cache_root, public_key=public_key)
    assert [p.plugin_id for p in plugins] == [HELLO_ID]


# --- Agent Team Kernel §2.6 item 4: per-agent equipment (plugin) narrowing -----
# The kernel computes equipment.granted/dropped, but the projection must ENFORCE it:
# a team-bound agent only gets its granted plugins as MCP tools (empty grant ⇒ none).


def test_build_runtime_narrows_to_allowed_plugin_ids(tmp_path: Path):
    cache_root, public_key = _cache_hello(tmp_path)

    # Granted set contains the plugin → projected.
    mcp_path, note = build_runtime_plugin_policy_addition(
        artifact_dir=tmp_path / "a1",
        cache_root=cache_root,
        public_key=public_key,
        allowed_plugin_ids=frozenset([HELLO_ID]),
    )
    assert mcp_path is not None and note

    # Granted set does NOT contain the plugin → nothing projected (fail-closed).
    other, other_note = build_runtime_plugin_policy_addition(
        artifact_dir=tmp_path / "a2",
        cache_root=cache_root,
        public_key=public_key,
        allowed_plugin_ids=frozenset(["some.other.plugin"]),
    )
    assert other is None and other_note is None


def test_build_runtime_empty_grant_projects_nothing(tmp_path: Path):
    # An EMPTY grant set (e.g. a CEO with no equipment) projects no plugins — it must
    # NOT fall through to the full entitled set.
    cache_root, public_key = _cache_hello(tmp_path)
    mcp_path, note = build_runtime_plugin_policy_addition(
        artifact_dir=tmp_path / "a",
        cache_root=cache_root,
        public_key=public_key,
        allowed_plugin_ids=frozenset(),
    )
    assert mcp_path is None and note is None


def test_build_runtime_none_grant_is_unchanged(tmp_path: Path):
    # None (a non-team run) keeps today's behaviour: the full entitled set.
    cache_root, public_key = _cache_hello(tmp_path)
    mcp_path, note = build_runtime_plugin_policy_addition(
        artifact_dir=tmp_path / "a",
        cache_root=cache_root,
        public_key=public_key,
        allowed_plugin_ids=None,
    )
    assert mcp_path is not None and note


def test_granted_plugin_ids_helper(tmp_path: Path):
    from superclaw.models import RunSession

    orch = _orchestrator(tmp_path)

    def _session(ctx):
        s = RunSession(goal_id="g", run_id="r")
        s.execution_context = ctx
        return s

    # Non-team run (no agent keys) → None → full set projected as before.
    assert orch._granted_plugin_ids(_session({})) is None
    # Team run (detected via key presence) but empty context → empty frozenset (fail-closed, not None).
    assert orch._granted_plugin_ids(_session({"agent_run_context": {}})) == frozenset()
    assert orch._granted_plugin_ids(_session({"agent_profile_id": "ceo"})) == frozenset()
    # Team run with granted list → that frozenset.
    ctx = {
        "agent_profile_id": "eng",
        "agent_run_context": {"equipment": {"granted": ["dev.superclaw.hello-world", "x.y"]}}
    }
    assert orch._granted_plugin_ids(_session(ctx)) == frozenset(["dev.superclaw.hello-world", "x.y"])
    # Team run with an empty grant → empty frozenset (fail-closed, not None).
    ctx_empty = {
        "agent_profile_id": "eng",
        "agent_run_context": {"equipment": {"granted": []}}
    }
    assert orch._granted_plugin_ids(_session(ctx_empty)) == frozenset()
    # Malformed equipment/granted → empty frozenset (a corrupt team run cannot widen).
    assert orch._granted_plugin_ids(_session({"agent_run_context": "nope"})) == frozenset()
    assert orch._granted_plugin_ids(_session({"agent_profile_id": "ceo", "agent_run_context": "nope"})) == frozenset()
    assert orch._granted_plugin_ids(_session({"agent_run_context": {"equipment": "nope"}})) == frozenset()
    assert orch._granted_plugin_ids(_session({"agent_run_context": {"equipment": {"granted": "nope"}}})) == frozenset()


def test_project_plugins_narrows_for_team_bound_run(tmp_path, monkeypatch):
    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")

    # Granted = [hello] → plugin projected.
    policy, note = orch._project_plugins_into_policy(
        None, [backend], tmp_path / "art1", None, allowed_plugin_ids=frozenset([HELLO_ID])
    )
    assert policy is not None and note and policy.mcp_configs

    # Granted = [] (no equipment) → nothing projected, fail-closed.
    policy2, note2 = orch._project_plugins_into_policy(
        None, [backend], tmp_path / "art2", None, allowed_plugin_ids=frozenset()
    )
    assert policy2 is None and note2 is None

    # None (non-team run) → full set projected (unchanged baseline).
    policy3, note3 = orch._project_plugins_into_policy(None, [backend], tmp_path / "art3", None)
    assert policy3 is not None and note3


def test_team_bound_run_strips_preexisting_mcp_config(tmp_path, monkeypatch):
    # Finding 3: a team-bound run's ONLY plugin surface is its granted-narrowed
    # aggregate — a pre-existing/injected single-plugin MCP config (or plugin_dir)
    # must be stripped so it cannot re-expose an un-granted plugin.
    from superclaw.runtime import PermissionPolicy

    cache_root, public_key = _cache_hello(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    orch = _orchestrator(tmp_path)
    backend = SimpleNamespace(name="codex-app-server")
    seeded = PermissionPolicy(mcp_configs=["/tmp/leftover.json"], plugin_dirs=["/tmp/p"])

    # Team-bound granted=[hello] → only the narrowed aggregate; leftover stripped.
    policy, note = orch._project_plugins_into_policy(
        seeded, [backend], tmp_path / "a", None, allowed_plugin_ids=frozenset([HELLO_ID])
    )
    assert note and "/tmp/leftover.json" not in policy.mcp_configs
    assert policy.plugin_dirs == [] and len(policy.mcp_configs) == 1

    # Team-bound granted=[] → everything stripped, no plugin surface at all.
    policy2, note2 = orch._project_plugins_into_policy(
        seeded, [backend], tmp_path / "b", None, allowed_plugin_ids=frozenset()
    )
    assert policy2.mcp_configs == [] and policy2.plugin_dirs == []

    # Non-team run (None) → leftover preserved, aggregate appended (unchanged baseline).
    policy3, note3 = orch._project_plugins_into_policy(seeded, [backend], tmp_path / "c", None)
    assert "/tmp/leftover.json" in policy3.mcp_configs
