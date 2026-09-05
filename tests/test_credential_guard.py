"""Tests for the B3 defense-in-depth credential guard (credential_guard.py).

Covers:
  * is_protected_path: credential material vs managed-workspace subtrees, sibling
    false-match, ``../`` traversal, symlink indirection, empty/None fail-closed.
  * assert_file_access_allowed: protected raises, workspace/ordinary passes.
  * assert_command_allowed: keychain reads, protected-path args (incl. argv0 and
    cwd-relative symlink), ordinary commands, list+str forms, fail-closed.
  * choke-point wiring: _RealToolExecution._exec_tool denies credential reads,
    allows ordinary repo + managed-workspace reads.

All tests inject ``home=tmp_path`` (never the real home).
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "packages" / "superclaw" / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from superclaw.credential_guard import (  # noqa: E402
    CredentialAccessError,
    assert_command_allowed,
    assert_file_access_allowed,
    is_protected_path,
    protected_roots,
)


@pytest.fixture
def fake_home(tmp_path: Path) -> Path:
    """A fake home with credential material AND managed-workspace subtrees."""
    sc = tmp_path / ".superclaw"
    sc.mkdir()
    (sc / "credentials").write_text("SECRET", encoding="utf-8")
    (sc / "secrets.key").write_text("KEY", encoding="utf-8")
    (sc / "config.json").write_text("{}", encoding="utf-8")
    (sc / "state.db").write_text("DB", encoding="utf-8")
    (sc / "clawhunt-auth.staging.json").write_text("{}", encoding="utf-8")
    (sc / "clawhunt-staging-bobo.env").write_text("TOKEN=x", encoding="utf-8")
    # managed-workspace subtrees (must stay allowed)
    (sc / "chats").mkdir()
    (sc / "workspaces").mkdir()
    (sc / "companies").mkdir()
    (tmp_path / ".config" / "superclaw").mkdir(parents=True)
    return tmp_path


# --------------------------------------------------------------------------- #
# is_protected_path — credential material is BLOCKED
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "rel",
    [
        ".superclaw/credentials",
        ".superclaw/secrets.key",
        ".superclaw/config.json",
        ".superclaw/state.db",
        ".superclaw/clawhunt-auth.staging.json",
        ".superclaw/clawhunt-staging-bobo.env",
        ".config/superclaw/anything.txt",
    ],
)
def test_credential_material_protected(fake_home: Path, rel: str) -> None:
    assert is_protected_path(str(fake_home / rel), home=fake_home)


# --------------------------------------------------------------------------- #
# is_protected_path — managed workspaces are ALLOWED (regression-1)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "rel",
    [
        ".superclaw/chats/abc/notes.md",
        ".superclaw/workspaces/p1/main.py",
        ".superclaw/companies/co1/src/x.py",
        ".superclaw",  # the root itself (listing it leaks no file contents)
    ],
)
def test_managed_workspace_allowed(fake_home: Path, rel: str) -> None:
    target = fake_home / rel
    if target.suffix:  # create a real file inside the workspace subtree
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("ok", encoding="utf-8")
    assert is_protected_path(str(target), home=fake_home) is False


def test_non_credential_file_at_root_allowed(fake_home: Path) -> None:
    # A non-credential file directly under ~/.superclaw is not credential material.
    f = fake_home / ".superclaw" / "notes.txt"
    f.write_text("x", encoding="utf-8")
    assert is_protected_path(str(f), home=fake_home) is False


# --------------------------------------------------------------------------- #
# is_protected_path — traversal / symlink / sibling / fail-closed
# --------------------------------------------------------------------------- #


def test_adjacent_sibling_not_protected(fake_home: Path) -> None:
    evil = fake_home / ".superclaw-evil"
    evil.mkdir()
    (evil / "data").write_text("ok", encoding="utf-8")
    assert is_protected_path(str(evil / "data"), home=fake_home) is False


def test_traversal_resolves_to_credentials(fake_home: Path) -> None:
    proj = fake_home / "project"
    proj.mkdir()
    traversal = str(proj / ".." / ".superclaw" / "credentials")
    assert is_protected_path(traversal, home=fake_home)


def test_symlink_into_credentials_protected(fake_home: Path) -> None:
    proj = fake_home / "project"
    proj.mkdir()
    link = proj / "leak"
    link.symlink_to(fake_home / ".superclaw")
    assert is_protected_path(str(link / "credentials"), home=fake_home)


def test_ordinary_project_path_allowed(fake_home: Path) -> None:
    proj = fake_home / "project"
    proj.mkdir()
    (proj / "main.py").write_text("print('hi')", encoding="utf-8")
    assert is_protected_path(str(proj / "main.py"), home=fake_home) is False


def test_empty_and_none_fail_closed(fake_home: Path) -> None:
    assert is_protected_path("", home=fake_home)
    assert is_protected_path(None, home=fake_home)
    assert is_protected_path("   ", home=fake_home)


def test_protected_roots_are_realpathed(fake_home: Path) -> None:
    roots = protected_roots(fake_home)
    assert any(
        r == Path(os.path.realpath(str(fake_home / ".config" / "superclaw"))) for r in roots
    )


# --------------------------------------------------------------------------- #
# cwd resolution (regression-2)
# --------------------------------------------------------------------------- #


def test_relative_path_resolves_against_cwd(fake_home: Path) -> None:
    proj = fake_home / "project"
    proj.mkdir()
    link = proj / "leak"
    link.symlink_to(fake_home / ".superclaw")
    # Relative path 'leak/credentials' is innocuous against process cwd, but maps
    # to credentials when resolved against the tool's cwd=proj.
    assert is_protected_path("leak/credentials", home=fake_home, cwd=str(proj))
    # An ordinary relative file under the same cwd is allowed.
    (proj / "ok.txt").write_text("x", encoding="utf-8")
    assert is_protected_path("ok.txt", home=fake_home, cwd=str(proj)) is False


# --------------------------------------------------------------------------- #
# assert_file_access_allowed
# --------------------------------------------------------------------------- #


def test_assert_file_protected_raises(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_file_access_allowed(str(fake_home / ".superclaw" / "credentials"), home=fake_home)


def test_assert_file_workspace_passes(fake_home: Path) -> None:
    ws = fake_home / ".superclaw" / "chats" / "c1"
    ws.mkdir(parents=True)
    (ws / "f.txt").write_text("x", encoding="utf-8")
    assert_file_access_allowed(str(ws / "f.txt"), home=fake_home)  # no raise


# --------------------------------------------------------------------------- #
# assert_command_allowed
# --------------------------------------------------------------------------- #


def test_command_keychain_read_str_raises(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("security find-generic-password -s mysvc -w", home=fake_home)


def test_command_keychain_read_list_raises(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(["security", "find-internet-password", "-s", "site"], home=fake_home)


def test_command_absolute_security_path_raises(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("/usr/bin/security dump-keychain", home=fake_home)


def test_command_case_insensitive_security(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("SECURITY Find-Generic-Password -w", home=fake_home)


def test_scrub_operator_authority_env_removes_control_token() -> None:
    from superclaw.credential_guard import OPERATOR_AUTHORITY_ENV, scrub_operator_authority_env

    env = {"PATH": "/usr/bin", "SUPERCLAW_CONTROL_TOKEN": "secret", "HOME": "/h"}
    out = scrub_operator_authority_env(env)
    assert "SUPERCLAW_CONTROL_TOKEN" not in out
    assert out["PATH"] == "/usr/bin" and out["HOME"] == "/h"  # non-authority kept
    assert "SUPERCLAW_CONTROL_TOKEN" in OPERATOR_AUTHORITY_ENV
    # idempotent + None-safe on missing key
    assert "SUPERCLAW_CONTROL_TOKEN" not in scrub_operator_authority_env(out)


def test_command_ambient_superclaw_cli_refused(fake_home: Path) -> None:
    # Route B: an agent must not reach ambient-admin authority via the operator
    # CLI. Both bare and absolute invocations of `superclaw` are refused.
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("superclaw company hire-agent --name Bob", home=fake_home)
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(["/usr/local/bin/superclaw", "company", "archive", "x"], home=fake_home)


def test_command_python_m_superclaw_refused(fake_home: Path) -> None:
    # `python -m superclaw ...` is the same ambient-admin entrypoint by another name.
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("python -m superclaw company hire-agent", home=fake_home)
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(["python3", "-m", "superclaw.cli", "company", "list"], home=fake_home)


def test_command_non_superclaw_python_allowed(fake_home: Path) -> None:
    # An ordinary python invocation (not the superclaw module) is not blocked here.
    assert_command_allowed("python -m pytest -q", home=fake_home)
    assert_command_allowed(["python3", "script.py"], home=fake_home)


def test_command_substring_superclaw_not_falsely_blocked(fake_home: Path) -> None:
    # A look-alike executable that merely contains 'superclaw' as a substring is
    # not the operator CLI (basename equality, not substring).
    assert_command_allowed("superclawesome --help", home=fake_home)


def test_command_with_credential_path_arg_raises(fake_home: Path) -> None:
    cred = str(fake_home / ".superclaw" / "credentials")
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(f"cat {cred}", home=fake_home)
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(["cat", cred], home=fake_home)


def test_command_cwd_relative_symlink_raises(fake_home: Path) -> None:
    # regression-2: cat leak/credentials with cwd=repo, repo/leak -> ~/.superclaw
    proj = fake_home / "project"
    proj.mkdir()
    (proj / "leak").symlink_to(fake_home / ".superclaw")
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("cat leak/credentials", cwd=str(proj), home=fake_home)
    # ordinary relative file under the same cwd passes
    (proj / "readme.md").write_text("x", encoding="utf-8")
    assert_command_allowed("cat readme.md", cwd=str(proj), home=fake_home)


def test_command_argv0_credential_path_raises(fake_home: Path) -> None:
    # regression-3: argv[0] is a credential path executed directly.
    tool = str(fake_home / ".superclaw" / "credentials")
    with pytest.raises(CredentialAccessError):
        assert_command_allowed([tool, "arg"], home=fake_home)


def test_command_workspace_path_passes(fake_home: Path) -> None:
    (fake_home / ".superclaw" / "chats" / "c1").mkdir(parents=True)
    ws = str(fake_home / ".superclaw" / "chats" / "c1" / "f.txt")
    Path(ws).write_text("x", encoding="utf-8")
    assert_command_allowed(["cat", ws], home=fake_home)  # no raise


def test_command_ordinary_passes(fake_home: Path) -> None:
    assert_command_allowed("ls -la", home=fake_home)
    assert_command_allowed(["git", "status"], home=fake_home)
    assert_command_allowed("echo hello world", home=fake_home)


def test_command_empty_and_none_fail_closed(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed("", home=fake_home)
    with pytest.raises(CredentialAccessError):
        assert_command_allowed(None, home=fake_home)


def test_command_unparseable_fail_closed(fake_home: Path) -> None:
    with pytest.raises(CredentialAccessError):
        assert_command_allowed('cat "unterminated', home=fake_home)


# --------------------------------------------------------------------------- #
# Choke-point wiring: _RealToolExecution._exec_tool
# --------------------------------------------------------------------------- #


def _make_exec_harness(repo: Path, monkeypatch, fake_home: Path):
    """Build a minimal _RealToolExecution + WorkerLimits whose tool calls route
    through the real _exec_tool choke point, with home pinned to fake_home."""
    import superclaw.credential_guard as cg
    from superclaw.backends import WorkerLimits, _RealToolExecution
    from superclaw.runtime import PermissionPolicy

    monkeypatch.setattr(cg.Path, "home", staticmethod(lambda: fake_home))

    exec_obj = _RealToolExecution()
    limits = WorkerLimits(
        repo_path=Path(repo),
        artifact_dir=Path(repo),
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    return exec_obj, limits


def test_exec_tool_blocks_credential_read(tmp_path: Path, monkeypatch) -> None:
    fake_home = tmp_path / "home"
    (fake_home / ".superclaw").mkdir(parents=True)
    (fake_home / ".superclaw" / "credentials").write_text("TOKEN", encoding="utf-8")
    repo = fake_home / ".superclaw"  # repo IS the credential dir (worst case)

    exec_obj, limits = _make_exec_harness(repo, monkeypatch, fake_home)
    result = exec_obj._exec_tool(
        "read_file", {"path": "credentials"}, limits, deadline=time.monotonic() + 30
    )
    assert "permission denied" in result
    assert "do not retry" in result


def test_exec_tool_blocks_keychain_shell(tmp_path: Path, monkeypatch) -> None:
    fake_home = tmp_path / "home"
    (fake_home / ".superclaw").mkdir(parents=True)
    repo = fake_home / "project"
    repo.mkdir()

    exec_obj, limits = _make_exec_harness(repo, monkeypatch, fake_home)
    result = exec_obj._exec_tool(
        "run_shell",
        {"command": "security find-generic-password -s x -w"},
        limits,
        deadline=time.monotonic() + 30,
    )
    assert "permission denied" in result


def test_exec_tool_allows_managed_workspace_read(tmp_path: Path, monkeypatch) -> None:
    # regression-1: agent read inside ~/.superclaw/chats/<id> is NOT blocked.
    fake_home = tmp_path / "home"
    ws = fake_home / ".superclaw" / "chats" / "c1"
    ws.mkdir(parents=True)
    (ws / "hello.txt").write_text("WORLD", encoding="utf-8")

    exec_obj, limits = _make_exec_harness(ws, monkeypatch, fake_home)
    result = exec_obj._exec_tool(
        "read_file", {"path": "hello.txt"}, limits, deadline=time.monotonic() + 30
    )
    assert "WORLD" in result
    assert "permission denied" not in result


def test_exec_tool_allows_ordinary_read(tmp_path: Path, monkeypatch) -> None:
    fake_home = tmp_path / "home"
    (fake_home / ".superclaw").mkdir(parents=True)
    repo = fake_home / "project"
    repo.mkdir()
    (repo / "hello.txt").write_text("WORLD", encoding="utf-8")

    exec_obj, limits = _make_exec_harness(repo, monkeypatch, fake_home)
    result = exec_obj._exec_tool(
        "read_file", {"path": "hello.txt"}, limits, deadline=time.monotonic() + 30
    )
    assert "WORLD" in result
    assert "permission denied" not in result


def test_exec_tool_allows_ordinary_shell(tmp_path: Path, monkeypatch) -> None:
    fake_home = tmp_path / "home"
    (fake_home / ".superclaw").mkdir(parents=True)
    repo = fake_home / "project"
    repo.mkdir()

    exec_obj, limits = _make_exec_harness(repo, monkeypatch, fake_home)
    result = exec_obj._exec_tool(
        "run_shell", {"command": "echo ok"}, limits, deadline=time.monotonic() + 30
    )
    assert "ok" in result
    assert "permission denied" not in result


@pytest.mark.parametrize("sidecar", ["state.db", "state.db-wal", "state.db-shm", "state.db-journal"])
def test_sqlite_sidecar_files_are_protected(tmp_path, sidecar):
    # WAL/SHM/journal hold recent-transaction plaintext (incl. secrets) — they must
    # be blocked alongside the main state.db, via the state.db* glob.
    assert is_protected_path(str(tmp_path / ".superclaw" / sidecar), home=tmp_path) is True


def test_file_access_env_var_home_is_blocked(tmp_path, monkeypatch):
    # A file-tool path using $HOME must be expanded before the check (the rework
    # had dropped expandvars; this locks it back in for the file path too).
    monkeypatch.setenv("HOME", str(tmp_path))
    assert is_protected_path("$HOME/.superclaw/credentials", home=tmp_path) is True
    with pytest.raises(CredentialAccessError):
        assert_file_access_allowed("$HOME/.superclaw/secrets.key", home=tmp_path)
