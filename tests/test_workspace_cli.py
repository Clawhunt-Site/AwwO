"""CLI surface tests for the workspace trust container (PR-2 wiring).

The CLI is the kernel baseline: chat resolves its workspace through the
shared kernel resolver — fail-closed in non-interactive runs, trust-as-
creation only with explicit confirmation, --continue scoped per workspace.
"""

import json
import os
import subprocess

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.models import WorkspaceProfile
from superclaw.state import StateStore
from superclaw import workspace_resolver as wr

runner = CliRunner()


@pytest.fixture(autouse=True)
def _isolate_environ():
    """chat's _hydrate_cli_environment mutates os.environ process-wide;
    snapshot/restore so these CLI invocations don't leak into other test files."""
    snapshot = os.environ.copy()
    yield
    os.environ.clear()
    os.environ.update(snapshot)


@pytest.fixture
def state(tmp_path, monkeypatch):
    path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(path))
    return path


def _git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    return path


def _trust(state, repo, name="proj"):
    return StateStore(state).save_workspace_profile(
        WorkspaceProfile(name=name, repo_path=str(repo), trust_source="api")
    )


# --- fail-closed chat ---------------------------------------------------------


def test_chat_in_untrusted_repo_fails_closed_non_interactive(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(app, ["chat", "-m", "hi", "--dry", "--repo", str(repo), "--json"])
    assert result.exit_code == 3
    assert wr.WORKSPACE_TRUST_REQUIRED in result.output
    assert "workspace trust" in result.output  # remediation guidance
    # nothing was created silently
    assert StateStore(state).list_workspace_profiles() == []
    assert StateStore(state).list_chat_sessions() == []


def test_chat_with_unknown_explicit_workspace_fails(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(
        app, ["chat", "-m", "hi", "--dry", "--repo", str(repo), "--workspace", "nope", "--json"]
    )
    assert result.exit_code == 2
    assert "unknown workspace" in result.output


def test_chat_attaches_new_session_to_resolved_workspace(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = _trust(state, repo)
    result = runner.invoke(app, ["chat", "-m", "hi", "--dry", "--repo", str(repo), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    session = StateStore(state).get_chat_session(payload["session_id"])
    assert session.workspace_id == workspace.workspace_id


def test_explicit_workspace_cannot_bypass_repo_trust_gate(state, tmp_path):
    """`--workspace <trusted A>` must not smuggle execution into untrusted --repo B."""
    repo_a = _git_repo(tmp_path / "a")
    workspace_a = _trust(state, repo_a, name="a")
    repo_b = _git_repo(tmp_path / "b")  # never trusted
    result = runner.invoke(
        app,
        ["chat", "-m", "hi", "--dry", "--repo", str(repo_b),
         "--workspace", workspace_a.workspace_id, "--json"],
    )
    assert result.exit_code == 3
    assert wr.WORKSPACE_TRUST_REQUIRED in result.output
    assert StateStore(state).list_chat_sessions() == []


def test_interactive_prompt_trusts_repo_but_keeps_explicit_grouping(state, tmp_path, monkeypatch):
    """TTY path: confirming trust for repo B must not steal the grouping
    chosen via an explicit --workspace A."""
    import superclaw.cli as cli_module

    repo_a = _git_repo(tmp_path / "a")
    workspace_a = _trust(state, repo_a, name="a")
    repo_b = _git_repo(tmp_path / "b")
    monkeypatch.setattr(cli_module, "_is_interactive", lambda: True)
    result = runner.invoke(
        app,
        ["chat", "-m", "hi", "--dry", "--repo", str(repo_b),
         "--workspace", workspace_a.workspace_id, "--json"],
        input="y\n",
    )
    assert result.exit_code == 0, result.output
    store = StateStore(state)
    # repo B got trusted (new workspace exists)...
    assert wr.find_workspace_for_path(store, repo_b) is not None
    # ...but the session is grouped under the explicitly chosen workspace A.
    payload = json.loads(result.output[result.output.index("{"):])
    session = store.get_chat_session(payload["session_id"])
    assert session.workspace_id == workspace_a.workspace_id


def test_explicit_session_id_cannot_bypass_trust_gate(state, tmp_path):
    """A known session id must not smuggle execution into an untrusted repo."""
    trusted = _git_repo(tmp_path / "trusted")
    _trust(state, trusted)
    first = runner.invoke(app, ["chat", "-m", "hi", "--dry", "--repo", str(trusted), "--json"])
    session_id = json.loads(first.output)["session_id"]

    untrusted = _git_repo(tmp_path / "untrusted")
    result = runner.invoke(
        app,
        ["chat", "-m", "again", "--dry", "--repo", str(untrusted), "--session-id", session_id, "--json"],
    )
    assert result.exit_code == 3
    assert wr.WORKSPACE_TRUST_REQUIRED in result.output
    # session membership untouched
    assert StateStore(state).get_chat_session(session_id).workspace_id is not None


def test_continue_all_with_empty_table_still_gates_and_attaches(state, tmp_path):
    """--continue --all may widen the pick, never skip the trust gate.

    Untrusted repo + empty session table fails closed; trusted repo + empty
    table creates the new session attached to that repo's workspace, never
    unassigned.
    """
    untrusted = _git_repo(tmp_path / "untrusted")
    blocked = runner.invoke(
        app, ["chat", "-m", "hi", "--dry", "--repo", str(untrusted), "--continue", "--all", "--json"]
    )
    assert blocked.exit_code == 3
    assert StateStore(state).list_chat_sessions() == []

    trusted = _git_repo(tmp_path / "trusted")
    workspace = _trust(state, trusted)
    created = runner.invoke(
        app, ["chat", "-m", "hi", "--dry", "--repo", str(trusted), "--continue", "--all", "--json"]
    )
    assert created.exit_code == 0, created.output
    session = StateStore(state).get_chat_session(json.loads(created.output)["session_id"])
    assert session.workspace_id == workspace.workspace_id


# --- --continue workspace scoping ----------------------------------------------


def test_continue_scopes_to_current_workspace(state, tmp_path):
    repo_a = _git_repo(tmp_path / "a")
    repo_b = _git_repo(tmp_path / "b")
    ws_a = _trust(state, repo_a, name="a")
    _trust(state, repo_b, name="b")

    first = runner.invoke(app, ["chat", "-m", "in a", "--dry", "--repo", str(repo_a), "--json"])
    session_a = json.loads(first.output)["session_id"]
    runner.invoke(app, ["chat", "-m", "in b", "--dry", "--repo", str(repo_b), "--json"])

    # --continue from repo A picks A's session even though B's is more recent.
    cont = runner.invoke(
        app, ["chat", "-m", "again", "--dry", "--repo", str(repo_a), "--continue", "--json"]
    )
    assert cont.exit_code == 0, cont.output
    assert json.loads(cont.output)["session_id"] == session_a
    assert StateStore(state).get_chat_session(session_a).workspace_id == ws_a.workspace_id


def test_continue_all_bypasses_workspace_scope(state, tmp_path):
    repo_a = _git_repo(tmp_path / "a")
    repo_b = _git_repo(tmp_path / "b")
    _trust(state, repo_a, name="a")
    _trust(state, repo_b, name="b")
    runner.invoke(app, ["chat", "-m", "in a", "--dry", "--repo", str(repo_a), "--json"])
    newest = json.loads(
        runner.invoke(app, ["chat", "-m", "in b", "--dry", "--repo", str(repo_b), "--json"]).output
    )["session_id"]
    cont = runner.invoke(
        app,
        ["chat", "-m", "again", "--dry", "--repo", str(repo_a), "--continue", "--all", "--json"],
    )
    assert json.loads(cont.output)["session_id"] == newest


# --- workspace trust ------------------------------------------------------------


def test_workspace_trust_with_yes_creates_active_workspace(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(app, ["workspace", "trust", str(repo), "--yes"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["created"] is True
    assert payload["workspace"]["trust_status"] == "active"
    assert payload["workspace"]["trust_source"] == "cli_flag"
    # idempotent: second trust returns the same workspace
    again = json.loads(runner.invoke(app, ["workspace", "trust", str(repo), "--yes"]).output)
    assert again["created"] is False
    assert again["workspace"]["workspace_id"] == payload["workspace"]["workspace_id"]


def test_workspace_trust_non_interactive_without_yes_fails(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(app, ["workspace", "trust", str(repo)])
    assert result.exit_code != 0
    assert wr.WORKSPACE_TRUST_REQUIRED in result.output


def test_workspace_trust_rejects_markerless_dir(state, tmp_path):
    bare = tmp_path / "bare"
    bare.mkdir()
    result = runner.invoke(app, ["workspace", "trust", str(bare), "--yes"])
    assert result.exit_code != 0
    assert "project markers" in result.output


# --- workspace sessions / adopt --------------------------------------------------


def test_workspace_sessions_lists_grouped_and_unassigned(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = _trust(state, repo)
    store = StateStore(state)
    grouped = store.create_chat_session("grouped", workspace_id=workspace.workspace_id)
    store.create_chat_session("legacy")
    listed = json.loads(
        runner.invoke(app, ["workspace", "sessions", workspace.workspace_id]).output
    )
    assert [item["session_id"] for item in listed] == [grouped.session_id]
    unassigned = json.loads(runner.invoke(app, ["workspace", "sessions", "unassigned"]).output)
    assert [item["title"] for item in unassigned] == ["legacy"]
    missing = runner.invoke(app, ["workspace", "sessions", "workspace_missing"])
    assert missing.exit_code != 0


def test_workspace_adopt_dry_run_then_apply(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    workspace = _trust(state, repo)
    store = StateStore(state)
    legacy = store.create_chat_session("legacy with evidence")
    # Two evidences; only one matches a registered workspace — adoption picks
    # the matching one and records the full evidence chain.
    legacy.metadata["native_sessions"] = {
        "codex": {"id": "x", "repo_path": str(repo)},
        "claude": {"id": "y", "repo_path": str(tmp_path / "elsewhere")},
    }
    store.save_chat_session(legacy)
    store.create_chat_session("legacy without evidence")

    dry = json.loads(runner.invoke(app, ["workspace", "adopt"]).output)
    assert dry["applied"] is False
    assert [p["session_id"] for p in dry["proposals"]] == [legacy.session_id]
    assert dry["proposals"][0]["workspace_id"] == workspace.workspace_id
    assert dry["proposals"][0]["evidence_backend"] == "codex"
    assert dry["proposals"][0]["evidence_native_session_id"] == "x"
    # dry-run wrote nothing
    assert store.get_chat_session(legacy.session_id).workspace_id is None

    applied = json.loads(runner.invoke(app, ["workspace", "adopt", "--apply"]).output)
    assert applied["applied"] is True
    assert store.get_chat_session(legacy.session_id).workspace_id == workspace.workspace_id
    # the evidence-less session stays untouched
    assert len(store.list_chat_sessions(unassigned_only=True)) == 1


# --- company init one-step workspace binding ----------------------------------


def test_company_init_with_repo_binds_workspace(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(
        app, ["company", "init", "Acme", "--repo", str(repo), "--yes"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["workspace"]["company_profile_id"] == payload["company"]["company_profile_id"]
    assert payload["workspace"]["trust_status"] == "active"


def test_company_init_repo_non_interactive_without_yes_fails(state, tmp_path):
    repo = _git_repo(tmp_path / "proj")
    result = runner.invoke(app, ["company", "init", "Acme", "--repo", str(repo)])
    assert result.exit_code != 0
    assert wr.WORKSPACE_TRUST_REQUIRED in result.output
    # nothing half-initialized: no company, no workspace
    store = StateStore(state)
    assert [c for c in store.list_company_profiles()] == []
    assert store.list_workspace_profiles() == []


def test_company_init_rejects_markerless_repo_before_creating_company(state, tmp_path):
    bare = tmp_path / "bare"
    bare.mkdir()
    result = runner.invoke(app, ["company", "init", "Acme", "--repo", str(bare), "--yes"])
    assert result.exit_code != 0
    assert StateStore(state).list_company_profiles() == []


def test_company_init_repo_and_url_mutually_exclusive(state, tmp_path):
    result = runner.invoke(
        app,
        ["company", "init", "Acme", "--repo", str(tmp_path), "--repo-url", "https://x/y.git"],
    )
    assert result.exit_code != 0
    assert "mutually exclusive" in result.output


def test_company_init_repo_url_clone_failure_reports_company_id(state, tmp_path, monkeypatch):
    """A failed clone reports the already-created company id so the operator
    can retry the binding instead of recreating the company."""
    monkeypatch.setenv("SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(tmp_path / "companies"))
    result = runner.invoke(
        app,
        ["company", "init", "Acme", "--repo-url", str(tmp_path / "missing-origin")],
    )
    assert result.exit_code != 0
    assert "created but workspace binding failed" in result.output
    companies = StateStore(state).list_company_profiles()
    assert len(companies) == 1
    assert companies[0].company_profile_id in result.output


# --- archive lifecycle: CLI retrieval path (workspace-sidebar-rework §5) -----


def test_workspace_archive_session_hides_but_stays_findable_and_reversible(state, tmp_path, monkeypatch):
    # The default list hides archived sessions; the CLI (kernel baseline) must
    # still be able to FIND them (--include-archived) and unarchive — otherwise
    # "archived" is a one-way black hole.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(state)
    ws = wr.create_personal_workspace(store, "home")
    session = store.create_chat_session("s", workspace_id=ws.workspace_id)

    r = runner.invoke(app, ["workspace", "archive-session", session.session_id])
    assert r.exit_code == 0, r.output
    assert json.loads(r.output)["archived"] is True

    r = runner.invoke(app, ["workspace", "sessions", ws.workspace_id])
    assert session.session_id not in {s["session_id"] for s in json.loads(r.output)}  # hidden

    r = runner.invoke(app, ["workspace", "sessions", ws.workspace_id, "--include-archived"])
    assert session.session_id in {s["session_id"] for s in json.loads(r.output)}  # findable

    r = runner.invoke(app, ["workspace", "unarchive-session", session.session_id])
    assert json.loads(r.output)["archived"] is False
    r = runner.invoke(app, ["workspace", "sessions", ws.workspace_id])
    assert session.session_id in {s["session_id"] for s in json.loads(r.output)}  # restored


def test_workspace_archive_unknown_session_fails(state):
    r = runner.invoke(app, ["workspace", "archive-session", "nope"])
    assert r.exit_code != 0
    assert "unknown chat session" in r.output


# --- PR-D: create-personal (folder default + attach fail-closed) -------------


def test_workspace_create_personal_folder_default(state, tmp_path, monkeypatch):
    # No --attach-repo → a locked MANAGED scratch personal workspace (company=local),
    # trusted by construction (no real user data to gate).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    r = runner.invoke(app, ["workspace", "create-personal", "Research notes"])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    assert payload["name"] == "Research notes"
    assert payload["company_profile_id"] == "local"
    ws = StateStore(state).get_workspace_profile(payload["workspace_id"])
    assert ws.is_trusted  # scratch is trusted by construction


@pytest.mark.parametrize("blank", ["", "   "])
def test_workspace_create_personal_rejects_blank_name(state, tmp_path, monkeypatch, blank):
    # CLI↔API zero divergence: the shared kernel entry rejects both an empty AND a
    # whitespace-only name, so the CLI surfaces the same error rather than coining
    # a "Workspace" placeholder.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    r = runner.invoke(app, ["workspace", "create-personal", blank])
    assert r.exit_code != 0
    assert StateStore(state).list_workspace_profiles(company_profile_id="local") == []


def test_workspace_create_personal_blank_name_with_attach_reports_name_first(state, tmp_path, monkeypatch):
    # Error-priority parity with the API: for a doubly-invalid invocation (blank
    # name AND an untrusted attach), the kernel validates the name first, so both
    # surfaces report the name error — the CLI no longer pre-fails on trust.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    repo = _git_repo(tmp_path / "proj")
    r = runner.invoke(app, ["workspace", "create-personal", "", "--attach-repo", str(repo)])
    assert r.exit_code != 0
    assert "name must not be empty" in r.output
    assert StateStore(state).list_workspace_profiles(company_profile_id="local") == []


def test_workspace_create_personal_attach_without_trust_fails_closed(state, tmp_path, monkeypatch):
    # --attach-repo without --trust in a non-interactive run is fail-closed
    # (§4.4): never a silent trust of a real directory.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    repo = _git_repo(tmp_path / "proj")
    r = runner.invoke(app, ["workspace", "create-personal", "Proj", "--attach-repo", str(repo)])
    assert r.exit_code != 0
    assert StateStore(state).list_workspace_profiles(company_profile_id="local") == []


def test_workspace_create_personal_attach_with_trust_creates_repo_workspace(state, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    repo = _git_repo(tmp_path / "proj")
    r = runner.invoke(app, ["workspace", "create-personal", "Proj", "--attach-repo", str(repo), "--trust"])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    ws = StateStore(state).get_workspace_profile(payload["workspace_id"])
    assert ws.is_trusted
    assert ws.company_profile_id == "local"


# --- PR-D: move-session (boundary-change acknowledgement) --------------------


def test_workspace_move_session_requires_a_target(state, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(state)
    session = store.create_chat_session("s")
    r = runner.invoke(app, ["workspace", "move-session", session.session_id])
    assert r.exit_code != 0
    assert "--workspace" in r.output or "target" in r.output


def test_workspace_move_session_boundary_change_fails_closed_without_yes(state, tmp_path, monkeypatch):
    # A move that changes the execution boundary resets runtime resume; a
    # non-interactive run without --yes is fail-closed (§4.5; mirrors API 409).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(state)
    ws_a = wr.create_personal_workspace(store, "A")
    ws_b = wr.create_personal_workspace(store, "B")
    session = store.create_chat_session("s", workspace_id=ws_a.workspace_id)
    assert store.chat_move_changes_execution_boundary(session.session_id, ws_b.workspace_id)

    r = runner.invoke(app, ["workspace", "move-session", session.session_id, "--workspace", ws_b.workspace_id])
    assert r.exit_code != 0
    assert "--yes" in r.output
    # the move was NOT applied
    assert store.get_chat_session(session.session_id).workspace_id == ws_a.workspace_id


def test_workspace_move_session_with_yes_acknowledges_and_moves(state, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(state)
    ws_a = wr.create_personal_workspace(store, "A")
    ws_b = wr.create_personal_workspace(store, "B")
    session = store.create_chat_session("s", workspace_id=ws_a.workspace_id)

    r = runner.invoke(app, ["workspace", "move-session", session.session_id, "--workspace", ws_b.workspace_id, "--yes"])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    assert payload["workspace_id"] == ws_b.workspace_id
    assert payload["execution_boundary_changed"] is True
    assert store.get_chat_session(session.session_id).workspace_id == ws_b.workspace_id


def test_workspace_move_session_unknown_session_fails(state):
    r = runner.invoke(app, ["workspace", "move-session", "nope", "--to-inbox"])
    assert r.exit_code != 0
    assert "unknown chat session" in r.output
