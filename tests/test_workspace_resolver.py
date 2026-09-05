"""Workspace trust container kernel tests (ADR: workspace-trust-container).

Covers: ChatSession workspace membership (indexed column + filters +
migration), repo identity fingerprinting (worktree normalization), the
fail-closed safety gates of trust-as-creation, the managed Chat workspace,
and the shared resolution path all surfaces must use.
"""

import json
import sqlite3
import subprocess

import pytest

from superclaw import workspace_resolver as wr
from superclaw.models import ChatSession, WorkspaceKind, WorkspaceProfile, WorkspaceTrustStatus
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    return path


# --- ChatSession workspace membership --------------------------------------


def test_chat_session_workspace_id_round_trips(store):
    session = store.create_chat_session("grouped", workspace_id="workspace_abc")
    loaded = store.get_chat_session(session.session_id)
    assert loaded.workspace_id == "workspace_abc"
    # column projection matches payload
    with sqlite3.connect(store.path) as conn:
        row = conn.execute(
            "SELECT workspace_id, payload FROM chat_sessions WHERE session_id = ?",
            (session.session_id,),
        ).fetchone()
    assert row[0] == "workspace_abc"
    assert json.loads(row[1])["workspace_id"] == "workspace_abc"


def test_list_chat_sessions_filters_by_workspace(store):
    store.create_chat_session("a", workspace_id="ws_1")
    store.create_chat_session("b", workspace_id="ws_2")
    store.create_chat_session("legacy")  # no workspace
    assert [s.title for s in store.list_chat_sessions(workspace_id="ws_1")] == ["a"]
    assert [s.title for s in store.list_chat_sessions(unassigned_only=True)] == ["legacy"]
    assert len(store.list_chat_sessions()) == 3
    with pytest.raises(ValueError):
        store.list_chat_sessions(workspace_id="ws_1", unassigned_only=True)


def test_move_session_between_workspaces_is_pure_regrouping(store):
    session = store.create_chat_session("movable", workspace_id="ws_1")
    moved = store.set_chat_session_workspace(session.session_id, "ws_2")
    assert moved.workspace_id == "ws_2"
    assert [s.session_id for s in store.list_chat_sessions(workspace_id="ws_2")] == [
        session.session_id
    ]


def test_legacy_rows_backfill_workspace_column(tmp_path):
    """A pre-migration database (payload-only rows) gains the indexed column."""
    db = tmp_path / "state.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        payload = ChatSession(title="old", workspace_id="ws_old").to_dict()
        conn.execute(
            "INSERT INTO chat_sessions(session_id, payload) VALUES(?, ?)",
            (payload["session_id"], json.dumps(payload)),
        )
    store = StateStore(db)
    assert [s.title for s in store.list_chat_sessions(workspace_id="ws_old")] == ["old"]


# --- repo identity & fingerprint --------------------------------------------


def test_worktrees_share_a_fingerprint(tmp_path):
    repo = _git_repo(tmp_path / "proj")
    subprocess.run(
        ["git", "-C", str(repo), "commit", "--allow-empty", "-q", "-m", "init"],
        check=True,
        env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
             "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    worktree = tmp_path / "proj-wt"
    subprocess.run(
        ["git", "-C", str(repo), "worktree", "add", "-q", str(worktree)], check=True
    )
    main_id = wr.resolve_repo_identity(repo)
    wt_id = wr.resolve_repo_identity(worktree)
    assert main_id["git_common_dir"] == wt_id["git_common_dir"]
    assert wr.repo_fingerprint(main_id) == wr.repo_fingerprint(wt_id)


def test_non_git_dir_fingerprint_falls_back_to_path(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    identity = wr.resolve_repo_identity(plain)
    assert identity["is_git"] is False
    assert wr.repo_fingerprint(identity).startswith("path:")


# --- trust-as-creation safety gates ------------------------------------------


def test_dangerous_roots_are_rejected():
    from pathlib import Path

    with pytest.raises(wr.WorkspaceRootRejected):
        wr.assert_safe_workspace_root(Path.home())
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.assert_safe_workspace_root("/")


def test_markerless_directory_is_rejected(tmp_path):
    bare = tmp_path / "bare"
    bare.mkdir()
    with pytest.raises(wr.WorkspaceRootRejected):
        wr.assert_safe_workspace_root(bare)


def test_create_trusted_workspace_records_identity(store, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = wr.create_trusted_workspace(store, repo, trust_source="cli_prompt")
    assert workspace.kind == WorkspaceKind.REPO.value
    assert workspace.trust_status == WorkspaceTrustStatus.ACTIVE.value
    assert workspace.trust_source == "cli_prompt"
    assert workspace.trusted_at is not None
    assert workspace.writable_paths == ["."]  # relative, never absolute home paths
    assert workspace.repo_identity["git_common_dir"]
    # find it back from a symlinked path (canonicalization)
    link = tmp_path / "link"
    link.symlink_to(repo)
    assert wr.find_workspace_for_path(store, link).workspace_id == workspace.workspace_id


def test_legacy_workspace_rows_stay_trusted(store):
    """Pre-ADR rows (no trust fields in payload) deserialize as ACTIVE repo."""
    legacy = WorkspaceProfile(name="old", repo_path="/tmp/x")
    data = legacy.to_dict()
    for key in ("kind", "trust_status", "trusted_at", "trust_source", "policy_version", "repo_identity"):
        data.pop(key)
    restored = WorkspaceProfile.from_dict(data)
    assert restored.is_trusted
    assert restored.kind == WorkspaceKind.REPO.value
    assert restored.policy_version == 1


# --- managed Chat workspace ---------------------------------------------------


def test_ensure_chat_workspace_is_idempotent_and_trusted(store, tmp_path):
    root = tmp_path / "chats"
    first = wr.ensure_chat_workspace(store, root=root)
    second = wr.ensure_chat_workspace(store, root=root)
    assert first.workspace_id == second.workspace_id
    assert first.kind == WorkspaceKind.MANAGED.value
    assert first.is_trusted and first.trust_source == "managed"
    assert root.is_dir()  # materialized scratch home


# --- the shared resolution path ----------------------------------------------


def test_resolution_explicit_id_wins(store, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = wr.create_trusted_workspace(store, repo)
    result = wr.resolve_workspace_for_chat(store, workspace_id=workspace.workspace_id)
    assert result.status == "matched"
    assert result.workspace.workspace_id == workspace.workspace_id


def test_resolution_unknown_explicit_id_raises(store):
    with pytest.raises(KeyError):
        wr.resolve_workspace_for_chat(store, workspace_id="workspace_missing")


def test_explicit_workspace_does_not_exempt_untrusted_repo(store, tmp_path):
    """--workspace picks grouping; the execution repo still needs trust."""
    repo_a = _git_repo(tmp_path / "a")
    workspace_a = wr.create_trusted_workspace(store, repo_a)
    repo_b = _git_repo(tmp_path / "b")  # never trusted

    result = wr.resolve_workspace_for_chat(
        store, workspace_id=workspace_a.workspace_id, repo=repo_b
    )
    assert result.status == "trust_required"
    assert "not covered by a trusted workspace" in result.reason

    # both trusted: explicit workspace wins the grouping, repo provides identity
    workspace_b = wr.create_trusted_workspace(store, repo_b)
    ok = wr.resolve_workspace_for_chat(store, workspace_id=workspace_a.workspace_id, repo=repo_b)
    assert ok.status == "matched"
    assert ok.workspace.workspace_id == workspace_a.workspace_id
    assert ok.identity["canonical_path"] == wr.resolve_repo_identity(repo_b)["canonical_path"]
    assert workspace_b.is_trusted


def test_resolution_pending_trust_is_fail_closed(store, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = wr.create_trusted_workspace(store, repo)
    workspace.trust_status = WorkspaceTrustStatus.PENDING_TRUST.value
    store.save_workspace_profile(workspace)
    result = wr.resolve_workspace_for_chat(store, workspace_id=workspace.workspace_id)
    assert result.status == "trust_required"
    by_repo = wr.resolve_workspace_for_chat(store, repo=repo)
    assert by_repo.status == "trust_required"


def test_resolution_repo_match_via_worktree(store, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    subprocess.run(
        ["git", "-C", str(repo), "commit", "--allow-empty", "-q", "-m", "init"],
        check=True,
        env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
             "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    worktree = tmp_path / "proj-wt"
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(worktree)], check=True)
    workspace = wr.create_trusted_workspace(store, repo)
    result = wr.resolve_workspace_for_chat(store, repo=worktree)
    assert result.status == "matched"
    assert result.workspace.workspace_id == workspace.workspace_id


def test_resolution_unknown_repo_requires_trust_never_creates(store, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    before = len(store.list_workspace_profiles())
    result = wr.resolve_workspace_for_chat(store, repo=repo)
    assert result.status == "trust_required"
    assert result.workspace is None
    assert len(store.list_workspace_profiles()) == before  # nothing created silently


def test_resolution_no_repo_falls_back_to_chat_workspace(store, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    result = wr.resolve_workspace_for_chat(store)
    assert result.status == "chat_fallback"
    assert result.workspace.metadata["builtin"] == wr.CHAT_WORKSPACE_MARKER
    assert result.workspace.is_trusted


def test_quarantined_chat_workspace_is_fail_closed(store, tmp_path, monkeypatch):
    """A quarantined managed Chat workspace must not host new sessions."""
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    chat = wr.ensure_chat_workspace(store)
    chat.trust_status = WorkspaceTrustStatus.QUARANTINED.value
    store.save_workspace_profile(chat)
    result = wr.resolve_workspace_for_chat(store)
    assert result.status == "trust_required"
    assert result.workspace.workspace_id == chat.workspace_id


def test_forged_origin_clone_does_not_inherit_trust(store, tmp_path):
    """Pointing origin at a trusted remote must NOT bypass the trust gate.

    Independent clones have distinct git common dirs, so the combined
    fingerprint (remote + common dir) keeps them separate workspaces.
    """
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"}
    trusted = _git_repo(tmp_path / "trusted")
    subprocess.run(["git", "-C", str(trusted), "remote", "add", "origin",
                    "https://example.com/org/proj.git"], check=True)
    workspace = wr.create_trusted_workspace(store, trusted)
    assert workspace.repo_identity["remote_url"] == "https://example.com/org/proj.git"

    attacker = _git_repo(tmp_path / "attacker")
    subprocess.run(["git", "-C", str(attacker), "remote", "add", "origin",
                    "https://example.com/org/proj.git"], check=True)
    subprocess.run(["git", "-C", str(attacker), "commit", "--allow-empty", "-q",
                    "-m", "x"], check=True, env=env)

    assert wr.find_workspace_for_path(store, attacker) is None
    result = wr.resolve_workspace_for_chat(store, repo=attacker)
    assert result.status == "trust_required"
    assert result.workspace is None


# --- company workspace materialization (Paperclip pattern) -------------------


def test_materialize_company_workspace_binds_existing_repo(store, tmp_path):
    from superclaw.models import CompanyProfile

    company = store.save_company_profile(CompanyProfile(name="Acme"))
    repo = _git_repo(tmp_path / "proj")
    workspace = wr.materialize_company_workspace(
        store, company.company_profile_id, company.name, repo=repo, trust_source="cli_flag"
    )
    assert workspace.company_profile_id == company.company_profile_id
    assert workspace.is_trusted
    # idempotent rebind reuses the same workspace
    again = wr.materialize_company_workspace(
        store, company.company_profile_id, company.name, repo=repo
    )
    assert again.workspace_id == workspace.workspace_id


def test_materialize_rehomes_local_workspace_but_not_foreign(store, tmp_path):
    from superclaw.models import CompanyProfile

    acme = store.save_company_profile(CompanyProfile(name="Acme"))
    globex = store.save_company_profile(CompanyProfile(name="Globex"))
    repo = _git_repo(tmp_path / "proj")
    # personal ("local") workspace gets re-homed into the company
    personal = wr.create_trusted_workspace(store, repo)
    rehomed = wr.materialize_company_workspace(
        store, acme.company_profile_id, acme.name, repo=repo
    )
    assert rehomed.workspace_id == personal.workspace_id
    assert rehomed.company_profile_id == acme.company_profile_id
    # but another company's workspace is never silently stolen
    with pytest.raises(ValueError, match="already belongs to company"):
        wr.materialize_company_workspace(store, globex.company_profile_id, globex.name, repo=repo)


def test_materialize_refuses_untrusted_existing_workspace(store, tmp_path):
    """A pending/quarantined workspace cannot be bound into a company."""
    from superclaw.models import CompanyProfile

    company = store.save_company_profile(CompanyProfile(name="Acme"))
    repo = _git_repo(tmp_path / "proj")
    workspace = wr.create_trusted_workspace(store, repo)
    workspace.trust_status = WorkspaceTrustStatus.QUARANTINED.value
    store.save_workspace_profile(workspace)
    with pytest.raises(ValueError, match="resolve its trust state"):
        wr.materialize_company_workspace(
            store, company.company_profile_id, company.name, repo=repo
        )


def test_materialize_clones_repo_url_into_managed_checkout(store, tmp_path, monkeypatch):
    from superclaw.models import CompanyProfile, WorkspaceKind

    monkeypatch.setenv("SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(tmp_path / "companies"))
    company = store.save_company_profile(CompanyProfile(name="Acme Corp"))
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"}
    origin = _git_repo(tmp_path / "origin-proj")
    subprocess.run(["git", "-C", str(origin), "commit", "--allow-empty", "-q", "-m", "init"],
                   check=True, env=env)
    workspace = wr.materialize_company_workspace(
        store, company.company_profile_id, company.name, repo_url=str(origin)
    )
    assert workspace.kind == WorkspaceKind.MANAGED.value
    assert workspace.is_trusted and workspace.trust_source == "managed"
    company_dir = f"Acme-Corp-{company.company_profile_id[-8:]}"
    assert (tmp_path / "companies" / company_dir / "origin-proj" / ".git").exists()
    assert workspace.metadata["managed_origin"] == str(origin)
    # rejects exactly-one-of violations and existing non-empty targets
    with pytest.raises(ValueError, match="exactly one"):
        wr.materialize_company_workspace(store, company.company_profile_id, company.name)
    with pytest.raises(ValueError, match="already exists"):
        wr.materialize_company_workspace(
            store, company.company_profile_id, company.name, repo_url=str(origin)
        )


def test_materialize_rejects_option_injection_urls(store, tmp_path, monkeypatch):
    """A hostile repo_url starting with '-' must reach git AFTER the '--'
    separator, so git treats it as a (failing) path, never as an option."""
    from superclaw.models import CompanyProfile

    monkeypatch.setenv("SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(tmp_path / "companies"))
    company = store.save_company_profile(CompanyProfile(name="Acme"))
    with pytest.raises(ValueError, match="git clone failed"):
        wr.materialize_company_workspace(
            store, company.company_profile_id, company.name,
            repo_url="--upload-pack=touch /tmp/pwned",
        )
    import os as _os
    assert not _os.path.exists("/tmp/pwned")


def test_materialize_clone_failure_raises(store, tmp_path, monkeypatch):
    from superclaw.models import CompanyProfile

    monkeypatch.setenv("SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(tmp_path / "companies"))
    company = store.save_company_profile(CompanyProfile(name="Acme"))
    with pytest.raises(ValueError, match="git clone failed"):
        wr.materialize_company_workspace(
            store, company.company_profile_id, company.name,
            repo_url=str(tmp_path / "does-not-exist"),
        )


# --- create_personal_workspace (workspace-sidebar-rework §5 PR-A) -----------


def test_create_personal_workspace_folder_is_visible_real_folder(store, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    ws = wr.create_personal_workspace(store, "My notes")

    assert ws.name == "My notes"
    assert ws.company_profile_id == "local"
    assert ws.kind == WorkspaceKind.MANAGED.value
    assert ws.trust_status == WorkspaceTrustStatus.ACTIVE.value  # trusted by construction
    assert ws.trust_source == "managed"  # not a granted prompt
    assert ws.metadata.get("personal") is True
    # writes LOCKED to the project folder itself (no global write / shell) — §4.3
    assert ws.writable_paths == ["."]
    assert ws.network_policy == "restricted"
    assert all(not p.startswith("/") and ".." not in p.split("/") for p in ws.writable_paths)
    # NEW model: a VISIBLE real folder ~/SuperClaw/<name>, materialized on disk,
    # NOT the old hidden ~/.superclaw/workspaces/<id> scratch.
    project = tmp_path / "SuperClaw" / "My notes"
    assert ws.repo_path == str(project)
    assert ".superclaw/workspaces" not in ws.repo_path
    assert project.is_dir()
    # trusted-by-creation integrity pin: the durable identity re-checked per run.
    assert ws.metadata["creation_mode"] == wr.REAL_FOLDER_CREATION_MODE
    assert ws.metadata["dir_pin"]["dev"] == project.stat().st_dev
    assert ws.metadata["dir_pin"]["ino"] == project.stat().st_ino
    # still the proven-safe MANAGED, trusted-by-construction write surface (§4.3).
    chat = wr.ensure_chat_workspace(store)
    assert (ws.kind, ws.writable_paths, ws.network_policy, ws.trust_source) == (
        chat.kind, chat.writable_paths, chat.network_policy, chat.trust_source
    )
    assert store.get_workspace_profile(ws.workspace_id).kind == WorkspaceKind.MANAGED.value


def test_create_personal_workspace_is_not_the_builtin_chat_workspace(store, tmp_path, monkeypatch):
    # A user-created folder must not be mistaken for the singleton Chat workspace.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    personal = wr.create_personal_workspace(store, "Scratchpad")
    chat = wr.ensure_chat_workspace(store)
    assert personal.workspace_id != chat.workspace_id
    assert personal.metadata.get("builtin") != wr.CHAT_WORKSPACE_MARKER


def test_create_personal_workspace_attach_repo_is_trusted_repo(store, tmp_path):
    repo = _git_repo(tmp_path / "code" / "myapp")
    ws = wr.create_personal_workspace(
        store, "myapp", attach_repo=repo, trust_confirmed=True, trust_source="cli_prompt"
    )
    assert ws.kind == WorkspaceKind.REPO.value
    assert ws.is_trusted
    assert ws.company_profile_id == "local"
    assert ws.repo_identity["canonical_path"] == str(repo.resolve())


def test_create_personal_workspace_attach_repo_without_confirmation_fails_closed(store, tmp_path):
    # fail-closed governance §4.4: a real directory is never silently trusted —
    # the gate is code-enforced, not a docstring convention, so a surface that
    # forgets the prompt gets a hard error and NOTHING is created.
    repo = _git_repo(tmp_path / "code" / "myapp")
    with pytest.raises(ValueError, match="trust_confirmed"):
        wr.create_personal_workspace(store, "myapp", attach_repo=repo)
    assert wr.find_workspace_for_path(store, repo) is None  # no workspace materialized


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_create_personal_workspace_rejects_blank_name(store, tmp_path, monkeypatch, blank):
    # The blank-name rule lives in this one kernel entry so CLI/API/Web share it
    # (no per-surface validator to drift, no silent "Workspace" placeholder).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with pytest.raises(ValueError, match="name must not be empty"):
        wr.create_personal_workspace(store, blank)
    assert store.list_workspace_profiles(company_profile_id="local") == []
