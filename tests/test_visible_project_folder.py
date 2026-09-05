"""Security tests for the visible real-folder project model (Codex-like).

Covers the fd-relative race-free creation primitive, the execution-time inode
integrity gate, slug safety, collision fail-closed, and unsafe-location refusal.
"""
from __future__ import annotations

import os
import shutil

import pytest

from superclaw import workspace_resolver as wr
from superclaw.state import StateStore


def _root(tmp_path):
    root = tmp_path / "SuperClaw"
    os.environ["SUPERCLAW_PROJECT_ROOT"] = str(root)
    return root


def test_create_managed_project_dir_makes_visible_0700_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    path, dev, ino = wr.create_managed_project_dir("你好")
    assert path.is_dir()
    assert path.name == "你好"  # unicode display name preserved as the folder leaf
    assert (path.stat().st_mode & 0o777) == 0o700
    assert (dev, ino) == (path.stat().st_dev, path.stat().st_ino)


def test_assert_managed_dir_unchanged_passes_then_fails_closed_on_swap(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    path, dev, ino = wr.create_managed_project_dir("proj")
    ws = wr.WorkspaceProfile(
        name="proj",
        repo_path=str(path),
        kind=wr.WorkspaceKind.MANAGED.value,
        metadata={"creation_mode": wr.REAL_FOLDER_CREATION_MODE, "dir_pin": {"dev": dev, "ino": ino}},
    )
    # healthy: returns the validated path
    assert wr.assert_managed_dir_unchanged(ws) == path
    # swap the directory for a symlink to a sensitive path → fail-closed
    shutil.rmtree(path)
    os.symlink("/etc", str(path))
    with pytest.raises(wr.WorkspaceDirCompromised):
        wr.assert_managed_dir_unchanged(ws)


def test_assert_managed_dir_unchanged_noop_for_non_real_folder(tmp_path):
    # legacy hidden-scratch managed / repo workspaces have no creation_mode marker
    # → the gate is a pass-through (returns the path, no inode check).
    ws = wr.WorkspaceProfile(name="legacy", repo_path=str(tmp_path), metadata={"personal": True})
    assert wr.assert_managed_dir_unchanged(ws) == tmp_path


def test_assert_managed_dir_unchanged_fails_closed_when_deleted(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    path, dev, ino = wr.create_managed_project_dir("gone")
    ws = wr.WorkspaceProfile(
        name="gone",
        repo_path=str(path),
        metadata={"creation_mode": wr.REAL_FOLDER_CREATION_MODE, "dir_pin": {"dev": dev, "ino": ino}},
    )
    shutil.rmtree(path)
    with pytest.raises(wr.WorkspaceDirCompromised):
        wr.assert_managed_dir_unchanged(ws)


def test_collision_is_rejected_never_adopted(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    wr.create_managed_project_dir("dup")
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.create_managed_project_dir("dup")


@pytest.mark.parametrize("name", ["../escape", "a/b/c", "..", ".", "x" * 200, "   ", "/"])
def test_slug_is_traversal_safe(name):
    # Either neutralized to a single safe component, or rejected — never a path
    # that escapes the root.
    try:
        slug = wr._project_slug(name)
    except wr.WorkspaceRootRejected:
        return
    assert "/" not in slug and os.sep not in slug and slug not in {".", ".."}


def test_group_writable_root_is_rejected(tmp_path, monkeypatch):
    root = tmp_path / "gwroot"
    root.mkdir()
    os.chmod(root, 0o775)  # explicit group-writable, bypassing umask
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(root))
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.create_managed_project_dir("x")


def test_world_writable_ancestor_is_rejected(tmp_path, monkeypatch):
    ww = tmp_path / "wwparent"
    ww.mkdir()
    os.chmod(ww, 0o777)  # world-writable ancestor → swap surface
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(ww / "SuperClaw"))
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.create_managed_project_dir("y")


def test_sticky_world_writable_ancestor_is_accepted(tmp_path, monkeypatch):
    # A world-writable ancestor WITH the sticky bit (e.g. Linux /tmp = 1777) is
    # NOT a swap surface — only a child's own owner may rename/delete it — so it
    # must be accepted. Without this exemption every test using pytest's tmp_path
    # (rooted under /tmp on CI) fails closed; this is the exact "本地绿 CI 红" trap
    # the CI-engineering-discipline 铁律 in CLAUDE.md locks down. The leaf must
    # still be ours and 0700.
    sticky = tmp_path / "stickyparent"
    sticky.mkdir()
    os.chmod(sticky, 0o1777)  # rwxrwxrwt — world-writable + sticky, like /tmp
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(sticky / "SuperClaw"))
    path, _dev, _ino = wr.create_managed_project_dir("z")
    assert path.is_dir()
    assert (path.stat().st_mode & 0o777) == 0o700


def test_assert_dir_fd_safe_writable_truth_table(tmp_path):
    # Lock the exact truth table the sticky-bit exemption introduces, in
    # isolation: only world/group-writable WITHOUT the sticky bit is a swap
    # surface. A future edit to the bit math trips this immediately.
    def check(mode, *, require_owner):
        d = tmp_path / f"d_{mode:o}_{require_owner}"
        d.mkdir()
        os.chmod(d, mode)
        fd = os.open(str(d), wr._O_NOFOLLOW_DIR)
        try:
            return wr._assert_dir_fd_safe(fd, str(d), require_owner=require_owner)
        finally:
            os.close(fd)

    assert check(0o1777, require_owner=False)  # sticky world-writable → exempt (e.g. /tmp)
    assert check(0o0700, require_owner=True)  # private, ours → leaf OK
    with pytest.raises(wr.WorkspaceRootRejected):
        check(0o0777, require_owner=False)  # world-writable, NO sticky → swap surface
    with pytest.raises(wr.WorkspaceRootRejected):
        check(0o0775, require_owner=False)  # group-writable, NO sticky → swap surface
    with pytest.raises(wr.WorkspaceRootRejected):
        check(0o0775, require_owner=True)  # group-writable leaf → rejected


def test_sticky_exemption_does_not_bypass_owner_gate(tmp_path, monkeypatch):
    # The sticky exemption must NOT weaken the ancestor owner gate: a
    # world-writable+sticky dir owned by an UNTRUSTED user (neither us nor root)
    # is still rejected. We inject a foreign owner by stubbing os.fstat for the one
    # check call, so the test holds regardless of the uid the suite runs as
    # (monkeypatching getuid would misfire under root, where a real root-owned dir
    # is legitimately trusted).
    import types

    d = tmp_path / "stickyforeign"
    d.mkdir()
    os.chmod(d, 0o1777)
    fd = os.open(str(d), wr._O_NOFOLLOW_DIR)
    real = os.fstat(fd)
    foreign_uid = os.getuid() + 424242  # guaranteed neither getuid() nor 0
    fake = types.SimpleNamespace(st_mode=real.st_mode, st_uid=foreign_uid)
    monkeypatch.setattr(os, "fstat", lambda _fd: fake)
    try:
        with pytest.raises(wr.WorkspaceRootRejected):
            wr._assert_dir_fd_safe(fd, str(d), require_owner=False)
    finally:
        monkeypatch.undo()
        os.close(fd)


def test_precreated_leaf_under_sticky_parent_is_never_adopted(tmp_path, monkeypatch):
    # Under a sticky world-writable parent (the now-exempt case), a pre-existing
    # leaf — real dir OR symlink — must NEVER be silently adopted (fail-closed).
    parent = tmp_path / "stickyhome"
    parent.mkdir()
    os.chmod(parent, 0o1777)
    root = parent / "SuperClaw"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(root))
    (root / "proj").mkdir()  # attacker pre-creates the slug as a real dir
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.create_managed_project_dir("proj")
    os.symlink("/etc", str(root / "evil"))  # ...or as a symlink to a sensitive path
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.create_managed_project_dir("evil")


def test_execution_choke_point_fails_closed_on_swapped_project_dir(tmp_path, monkeypatch):
    # The kernel execution gate (called by the orchestrator + API before any
    # backend uses the cwd) must fail closed when a real-folder project's dir was
    # deleted/replaced — keyed only by the repo PATH (no workspace handle needed).
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    store = StateStore(tmp_path / "state.db")
    ws = wr.create_personal_workspace(store, "proj")

    # healthy: pass-through, and reported as a protected cwd (backends must not re-create)
    assert wr.assert_execution_repo_safe(store, ws.repo_path) == __import__("pathlib").Path(ws.repo_path)
    assert wr.is_protected_project_repo(store, ws.repo_path) is True

    # swap the project directory for a symlink → fail-closed at the gate
    shutil.rmtree(ws.repo_path)
    os.symlink("/etc", ws.repo_path)
    with pytest.raises(wr.WorkspaceDirCompromised):
        wr.assert_execution_repo_safe(store, ws.repo_path)


def test_execution_choke_point_noop_for_non_project_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    store = StateStore(tmp_path / "state.db")
    # an unregistered plain directory is not protected and passes the gate
    assert wr.is_protected_project_repo(store, str(tmp_path)) is False
    assert wr.assert_execution_repo_safe(store, str(tmp_path)) == __import__("pathlib").Path(str(tmp_path))


def test_execute_direct_chat_turn_forwards_protected_cwd(monkeypatch):
    # The protected_cwd flag must reach the generic backend's WorkerLimits so it
    # skips re-creating an inode-pinned project cwd (callers compute it from
    # is_protected_project_repo). Lock the forwarding.
    import superclaw.chat_turn as ct
    from pathlib import Path as _P

    seen = {}

    def fake_generic(*, content, backend, repo, budget_seconds, context_text, history,
                     model, effort=None, permission_mode=None, event_sink=None, protected_cwd=False,
                     skill_ids=(), available_skill_catalog=""):
        seen["protected_cwd"] = protected_cwd
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "ok"}

    monkeypatch.setattr(ct, "_execute_generic_direct_chat_turn", fake_generic)
    ct.execute_direct_chat_turn(
        content="hi", backend="gemini", repo=_P("."), budget_seconds=5, protected_cwd=True
    )
    assert seen["protected_cwd"] is True


def test_orphan_dir_is_reclaimed_when_db_save_fails(tmp_path, monkeypatch):
    # If registering the workspace fails AFTER the folder was created, the empty
    # folder must be reclaimed — otherwise the atomic mkdir(exist_ok=False) would
    # reject every future create of the same name forever.
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    store = StateStore(tmp_path / "state.db")

    def boom(_ws):
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(store, "save_workspace_profile", boom)
    with pytest.raises(RuntimeError):
        wr.create_personal_workspace(store, "doomed")
    # the orphan folder was cleaned up → the name is creatable again
    assert not (tmp_path / "SuperClaw" / "doomed").exists()
    monkeypatch.undo()
    store2 = StateStore(tmp_path / "state.db")
    ws = wr.create_personal_workspace(store2, "doomed")  # no FileExistsError
    assert os.path.isdir(ws.repo_path)


def test_create_personal_workspace_default_is_visible_real_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    store = StateStore(tmp_path / "state.db")
    ws = wr.create_personal_workspace(store, "赚钱小助手")
    assert ws.kind == wr.WorkspaceKind.MANAGED.value
    assert ws.metadata["creation_mode"] == wr.REAL_FOLDER_CREATION_MODE
    assert ws.metadata["dir_pin"]["dev"] and ws.metadata["dir_pin"]["ino"]
    # repo_path is the VISIBLE folder, not the old hidden ~/.superclaw/workspaces/<id>
    assert ws.repo_path == str(tmp_path / "SuperClaw" / "赚钱小助手")
    assert ".superclaw/workspaces" not in ws.repo_path
    assert os.path.isdir(ws.repo_path)
