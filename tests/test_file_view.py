"""Tests for the kernel file-view capability (docs/reference-viewer-panel.md §6).

Covers the trust gate (ACTIVE workspace required, managed inode tamper),
path-safety (absolute/escape/symlink), the fixed sensitivity order (name ->
binary -> bounded content scan -> oversize fail-closed), truncation, and binary
metadata-only behaviour.
"""
from __future__ import annotations

import os

import pytest

from superclaw import file_view, workspace_resolver as wr
from superclaw.models import GoalSpec, WorkspaceKind, WorkspaceTrustStatus
from superclaw.state import StateStore


def _store(tmp_path) -> StateStore:
    return StateStore(tmp_path / "superclaw.db")


def _trusted_repo_workspace(store: StateStore, repo: os.PathLike) -> None:
    """Register an ACTIVE repo workspace covering ``repo`` (worktree-safe match
    is by fingerprint/canonical path, so recording the repo_path suffices)."""
    ws = wr.WorkspaceProfile(
        name="proj",
        repo_path=str(repo),
        kind=WorkspaceKind.REPO.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        repo_identity=wr.resolve_repo_identity(repo),
    )
    store.save_workspace_profile(ws)


def _run_in(store: StateStore, repo: os.PathLike):
    goal = store.create_goal(GoalSpec(title="t", description="d"))
    run = store.create_run(goal.goal_id)
    run.execution_context = {"repo_path": str(os.path.realpath(repo))}
    store.save_run(run)
    return run


def test_reads_markdown_with_markdown_mime(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("# Hello\n\nbody", encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)

    result = file_view.read_run_file(store, run.run_id, "README.md")
    assert result.is_text is True
    assert result.mime == "text/markdown"
    assert result.content == "# Hello\n\nbody"
    assert result.truncated is False


def test_run_not_found(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, "run_missing", "x.txt")
    assert exc.value.code == "not_found"


def test_untrusted_when_no_covering_workspace(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "a.txt").write_text("hi", encoding="utf-8")
    store = _store(tmp_path)
    run = _run_in(store, repo)  # no workspace registered
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "a.txt")
    assert exc.value.code == "untrusted_workspace"


def test_untrusted_when_workspace_not_active(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "a.txt").write_text("hi", encoding="utf-8")
    store = _store(tmp_path)
    ws = wr.WorkspaceProfile(
        name="proj",
        repo_path=str(repo),
        kind=WorkspaceKind.REPO.value,
        trust_status=WorkspaceTrustStatus.QUARANTINED.value,
        repo_identity=wr.resolve_repo_identity(repo),
    )
    store.save_workspace_profile(ws)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "a.txt")
    assert exc.value.code == "untrusted_workspace"


@pytest.mark.parametrize("bad", ["/etc/passwd", "../escape.txt", "~/secret", "a/../../b"])
def test_path_escape_and_absolute_rejected(tmp_path, bad):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "ok.txt").write_text("ok", encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, bad)
    assert exc.value.code in {"path_not_allowed", "not_found"}


def test_symlink_escaping_root_is_rejected(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    secret = tmp_path / "outside.txt"
    secret.write_text("top secret outside", encoding="utf-8")
    os.symlink(str(secret), str(repo / "link.txt"))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "link.txt")
    assert exc.value.code == "path_not_allowed"


@pytest.mark.parametrize("name", [".env", "config/.env", "id_rsa", "deploy/id_rsa", "app.sqlite", "x.pem"])
def test_sensitive_filename_denied(tmp_path, name):
    repo = tmp_path / "repo"
    (repo / "config").mkdir(parents=True)
    (repo / "deploy").mkdir(parents=True)
    target = repo / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("SECRET=value", encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, name)
    assert exc.value.code == "sensitive_denied"


def test_symlink_to_internal_sensitive_is_refused(tmp_path):
    # harmless.txt -> .env (both inside the checkout): the no-symlink fd walk
    # must refuse it (closes the agy bypass where a benign name aliases a secret).
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env").write_text("API_TOKEN=supersecretvalue", encoding="utf-8")
    os.symlink(str(repo / ".env"), str(repo / "harmless.txt"))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "harmless.txt")
    assert exc.value.code == "path_not_allowed"


def test_symlinked_intermediate_dir_is_refused(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "f.txt").write_text("leak", encoding="utf-8")
    os.symlink(str(outside), str(repo / "linkdir"))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "linkdir/f.txt")
    # O_NOFOLLOW on a symlinked dir yields ELOOP/ENOTDIR depending on platform;
    # either way it is a fail-closed refusal that never reads the outside file.
    assert exc.value.code in {"path_not_allowed", "not_found"}


def test_hardlink_alias_to_sensitive_is_refused(tmp_path):
    # ln .env harmless.txt — a hard link gives a sensitive inode a benign name,
    # bypassing the name denylist; refuse any multi-linked file rather than read.
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env").write_text("API_TOKEN=plainsecret", encoding="utf-8")
    os.link(str(repo / ".env"), str(repo / "harmless.txt"))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "harmless.txt")
    assert exc.value.code == "path_not_allowed"


def test_checkout_root_replaced_by_symlink_fails_closed(tmp_path):
    # The trusted root anchor is opened O_NOFOLLOW; if the checkout root itself
    # is swapped for a symlink (to /etc), opening the anchor fails closed.
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "a.txt").write_text("ok", encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    # healthy first
    assert file_view.read_run_file(store, run.run_id, "a.txt").content == "ok"
    import shutil

    shutil.rmtree(repo)
    os.symlink("/etc", str(repo))
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "a.txt")
    assert exc.value.code in {"workspace_compromised", "untrusted_workspace"}


def test_fifo_is_not_a_regular_file(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    os.mkfifo(str(repo / "pipe"))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "pipe")
    assert exc.value.code in {"not_found", "path_not_allowed"}


@pytest.mark.parametrize("name", [".git-credentials", ".envrc", ".ssh/config", ".git/config", ".aws/credentials"])
def test_credential_files_and_dirs_denied(tmp_path, name):
    repo = tmp_path / "repo"
    target = repo / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("https://user:token@example.com", encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, name)
    assert exc.value.code == "sensitive_denied"


def test_oversize_multibyte_text_fails_closed_not_binary(tmp_path):
    # multi-byte chars so the SCAN_CAP boundary splits a codepoint — must still
    # be classified text and fail closed, never misreported as binary.
    repo = tmp_path / "repo"
    repo.mkdir()
    big = repo / "huge_zh.txt"
    body = ("中" * ((file_view.FILE_VIEW_SCAN_CAP // 3) + 100)).encode("utf-8")
    big.write_bytes(body)
    assert len(body) > file_view.FILE_VIEW_SCAN_CAP
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "huge_zh.txt")
    assert exc.value.code == "sensitive_scan_unbounded"


def test_sensitive_content_denied(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    # A plausible secret pattern that secrets_scan flags.
    (repo / "notes.txt").write_text(
        "here is a key\nAKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
        encoding="utf-8",
    )
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "notes.txt")
    assert exc.value.code == "sensitive_denied"


def test_binary_returns_metadata_only(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "blob.bin").write_bytes(b"\x00\x01\x02binary\xff")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    result = file_view.read_run_file(store, run.run_id, "blob.bin")
    assert result.is_text is False
    assert result.content is None
    assert result.encoding == "binary"


def test_truncation_flag_and_utf8_safe(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    # multi-byte chars so a byte-boundary truncation would split a codepoint
    body = "héllo " * 5000
    (repo / "big.txt").write_text(body, encoding="utf-8")
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    result = file_view.read_run_file(store, run.run_id, "big.txt", max_bytes=1024)
    assert result.truncated is True
    assert result.is_text is True
    assert result.content is not None  # no UnicodeDecodeError crash


def test_oversize_text_fails_closed(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    big = repo / "huge.txt"
    big.write_bytes(b"a" * (file_view.FILE_VIEW_SCAN_CAP + 10))
    store = _store(tmp_path)
    _trusted_repo_workspace(store, repo)
    run = _run_in(store, repo)
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "huge.txt")
    assert exc.value.code == "sensitive_scan_unbounded"


def test_managed_dir_tamper_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    path, dev, ino = wr.create_managed_project_dir("proj")
    (path / "doc.md").write_text("# ok", encoding="utf-8")
    store = _store(tmp_path)
    ws = wr.WorkspaceProfile(
        name="proj",
        repo_path=str(path),
        kind=WorkspaceKind.MANAGED.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        repo_identity=wr.resolve_repo_identity(path),
        metadata={"creation_mode": wr.REAL_FOLDER_CREATION_MODE, "dir_pin": {"dev": dev, "ino": ino}},
    )
    store.save_workspace_profile(ws)
    run = _run_in(store, path)
    # healthy read first
    assert file_view.read_run_file(store, run.run_id, "doc.md").is_text is True
    # swap the pinned dir -> fail closed
    import shutil

    shutil.rmtree(path)
    os.symlink("/etc", str(path))
    with pytest.raises(file_view.FileViewError) as exc:
        file_view.read_run_file(store, run.run_id, "doc.md")
    assert exc.value.code == "workspace_compromised"
