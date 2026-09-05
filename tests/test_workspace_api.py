"""API surface tests for the workspace trust container (PR-3 wiring).

The API is a faithful, non-interactive projection of the same kernel
resolver the CLI uses: untrusted repos are 403 WORKSPACE_TRUST_REQUIRED
(never silent creation), pure chats live in the managed Chat workspace,
and the sidebar consumes the ui_contracts projection only.
"""

import os
import shutil

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import WorkspaceProfile, WorkspaceTrustStatus
from superclaw.state import StateStore
from superclaw import workspace_resolver as wr


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    return client, StateStore(tmp_path / "state.db"), tmp_path


def _trust(store, repo, name="proj"):
    return store.save_workspace_profile(
        WorkspaceProfile(name=name, repo_path=str(repo), trust_source="api")
    )


def _chat(client, **overrides):
    payload = {"message": "hi", "mode": "chat", "dry_run": True, "backend_policy": "local"}
    payload.update(overrides)
    return client.post("/api/chat/turn", json=payload)


def test_untrusted_repo_is_403_and_creates_nothing(env, tmp_path):
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    response = _chat(client, repo_path=str(repo))
    assert response.status_code == 403
    assert wr.WORKSPACE_TRUST_REQUIRED in response.json()["detail"]
    assert store.list_chat_sessions() == []
    assert store.list_workspace_profiles() == []


def test_pure_chat_lives_in_managed_chat_workspace(env):
    client, store, _ = env
    response = _chat(client)  # no repo_path: pure chat
    assert response.status_code == 200, response.text
    session = store.get_chat_session(response.json()["session_id"])
    chat_ws = wr.ensure_chat_workspace(store)
    assert session.workspace_id == chat_ws.workspace_id
    assert chat_ws.kind == "managed" and chat_ws.is_trusted


def test_trusted_repo_attaches_session(env, tmp_path):
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = _trust(store, repo)
    response = _chat(client, repo_path=str(repo))
    assert response.status_code == 200, response.text
    session = store.get_chat_session(response.json()["session_id"])
    assert session.workspace_id == workspace.workspace_id


def test_explicit_workspace_does_not_exempt_untrusted_repo(env, tmp_path):
    client, store, _ = env
    repo_a = tmp_path / "a"
    repo_a.mkdir()
    workspace_a = _trust(store, repo_a, name="a")
    repo_b = tmp_path / "b"
    repo_b.mkdir()  # untrusted
    response = _chat(client, repo_path=str(repo_b), workspace_id=workspace_a.workspace_id)
    assert response.status_code == 403


def test_unknown_workspace_is_404(env):
    client, _, _ = env
    assert _chat(client, workspace_id="workspace_missing").status_code == 404


def test_pending_trust_workspace_is_403(env, tmp_path):
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = _trust(store, repo)
    workspace.trust_status = WorkspaceTrustStatus.PENDING_TRUST.value
    store.save_workspace_profile(workspace)
    response = _chat(client, workspace_id=workspace.workspace_id)
    assert response.status_code == 403


def test_explicit_workspace_moves_session(env, tmp_path):
    client, store, _ = env
    repo_a = tmp_path / "a"
    repo_a.mkdir()
    repo_b = tmp_path / "b"
    repo_b.mkdir()
    ws_a = _trust(store, repo_a, name="a")
    ws_b = _trust(store, repo_b, name="b")
    sid = _chat(client, repo_path=str(repo_a)).json()["session_id"]
    moved = _chat(
        client, session_id=sid, repo_path=str(repo_b), workspace_id=ws_b.workspace_id
    )
    assert moved.status_code == 200, moved.text
    assert store.get_chat_session(sid).workspace_id == ws_b.workspace_id
    assert ws_a.workspace_id != ws_b.workspace_id


def test_sessions_filter_by_workspace_and_unassigned(env, tmp_path):
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = _trust(store, repo)
    grouped = store.create_chat_session("grouped", workspace_id=workspace.workspace_id)
    store.create_chat_session("legacy")
    by_ws = client.get(f"/api/chat/sessions?workspace={workspace.workspace_id}").json()
    assert [s["session_id"] for s in by_ws["sessions"]] == [grouped.session_id]
    unassigned = client.get("/api/chat/sessions?unassigned=true").json()
    assert [s["title"] for s in unassigned["sessions"]] == ["legacy"]
    conflict = client.get(
        f"/api/chat/sessions?workspace={workspace.workspace_id}&unassigned=true"
    )
    assert conflict.status_code == 422
    # every session payload carries its workspace_id
    full = client.get("/api/chat/sessions").json()
    assert {s["session_id"]: s["workspace_id"] for s in full["sessions"]} == {
        grouped.session_id: workspace.workspace_id,
        [s for s in full["sessions"] if s["title"] == "legacy"][0]["session_id"]: None,
    }


def test_workspaces_inventory_projection(env, tmp_path):
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = _trust(store, repo)
    store.create_chat_session("grouped", workspace_id=workspace.workspace_id)
    store.create_chat_session("legacy")
    payload = client.get("/api/workspaces").json()
    by_id = {w["workspace_id"]: w for w in payload["workspaces"]}
    assert by_id[workspace.workspace_id]["session_count"] == 1
    assert by_id[workspace.workspace_id]["trust_status"] == "active"
    assert by_id[workspace.workspace_id]["is_trusted"] is True
    assert payload["unassigned_session_count"] == 1
    # the managed Chat workspace is always present for the sidebar
    chat_entries = [w for w in payload["workspaces"] if w["builtin_chat"]]
    assert len(chat_entries) == 1 and chat_entries[0]["kind"] == "managed"


def test_continue_last_scopes_to_workspace(env, tmp_path):
    client, store, _ = env
    repo_a = tmp_path / "a"
    repo_a.mkdir()
    repo_b = tmp_path / "b"
    repo_b.mkdir()
    _trust(store, repo_a, name="a")
    _trust(store, repo_b, name="b")
    sid_a = _chat(client, repo_path=str(repo_a)).json()["session_id"]
    sid_b = _chat(client, repo_path=str(repo_b)).json()["session_id"]
    # widened pick takes the most recently written session regardless of repo
    wide = _chat(client, repo_path=str(repo_a), continue_last=True, all_sessions=True)
    assert wide.json()["session_id"] == sid_b
    # scoped pick stays inside repo A's workspace even though B is more recent
    cont = _chat(client, repo_path=str(repo_a), continue_last=True)
    assert cont.json()["session_id"] == sid_a


def test_chat_workspace_is_singleton_across_pure_chats(env, tmp_path):
    """Repeated pure chats reuse one managed Chat workspace (no duplicates),
    and its scratch home is materialized under the configured root."""
    client, store, _ = env
    sid1 = _chat(client).json()["session_id"]
    sid2 = _chat(client).json()["session_id"]
    chat_workspaces = [
        w for w in store.list_workspace_profiles()
        if w.metadata.get("builtin") == wr.CHAT_WORKSPACE_MARKER
    ]
    assert len(chat_workspaces) == 1
    assert (tmp_path / "chats").is_dir()
    assert store.get_chat_session(sid1).workspace_id == chat_workspaces[0].workspace_id
    assert store.get_chat_session(sid2).workspace_id == chat_workspaces[0].workspace_id


def test_legacy_direct_endpoint_is_trust_gated(env, tmp_path):
    """Deprecated does not mean exempt: /api/chat/direct passes the same gate."""
    client, store, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    response = client.post(
        "/api/chat/direct",
        json={"message": "hi", "backend_policy": "codex", "repo_path": str(repo)},
    )
    assert response.status_code == 403
    assert wr.WORKSPACE_TRUST_REQUIRED in response.json()["detail"]


def test_stream_endpoint_rejects_untrusted_repo_before_sse(env, tmp_path):
    """The 403 must be raised before any StreamingResponse is constructed."""
    client, _, _ = env
    repo = tmp_path / "repo"
    repo.mkdir()
    response = client.post(
        "/api/chat/stream",
        json={"message": "hi", "mode": "chat", "repo_path": str(repo)},
    )
    assert response.status_code == 403
    assert wr.WORKSPACE_TRUST_REQUIRED in response.json()["detail"]


# --- company creation with one-step workspace binding --------------------------


def test_create_company_with_repo_url_clones_managed_checkout(env, tmp_path, monkeypatch):
    import subprocess

    monkeypatch.setenv("SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(tmp_path / "companies"))
    client, store, _ = env
    git_env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"}
    origin = tmp_path / "origin-proj"
    origin.mkdir()
    subprocess.run(["git", "init", "-q", str(origin)], check=True)
    subprocess.run(["git", "-C", str(origin), "commit", "--allow-empty", "-q", "-m", "init"],
                   check=True, env=git_env)
    response = client.post(
        "/api/team/companies", json={"name": "Acme", "repo_url": str(origin)}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    workspace = payload["workspace"]
    assert workspace["company_profile_id"] == payload["company"]["company_profile_id"]
    assert workspace["kind"] == "managed" and workspace["trust_status"] == "active"
    company_dir = f"Acme-{payload['company']['company_profile_id'][-8:]}"
    assert (tmp_path / "companies" / company_dir / "origin-proj" / ".git").exists()


def test_create_company_with_repo_path_binds_trusted_workspace(env, tmp_path):
    import subprocess

    client, store, _ = env
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    response = client.post(
        "/api/team/companies", json={"name": "Acme", "repo_path": str(repo)}
    )
    assert response.status_code == 200, response.text
    assert response.json()["workspace"]["repo_path"].endswith("proj")


def test_create_company_repo_binding_fails_closed(env, tmp_path):
    client, store, _ = env
    bare = tmp_path / "bare"
    bare.mkdir()
    rejected = client.post("/api/team/companies", json={"name": "Acme", "repo_path": str(bare)})
    assert rejected.status_code == 409
    # pre-validation: the company itself was not half-created
    assert client.get("/api/team/companies").json()["companies"] == []
    both = client.post(
        "/api/team/companies",
        json={"name": "Acme", "repo_path": str(bare), "repo_url": "https://x/y.git"},
    )
    assert both.status_code == 422


# --- PR-B: workspace write endpoints (workspace-sidebar-rework §5) ----------


def test_create_personal_workspace_folder_endpoint(env):
    client, store, _ = env
    r = client.post("/api/workspaces", json={"name": "My notes"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "My notes"
    assert body["kind"] == "managed"
    assert body["company_profile_id"] == "local"
    ws = store.get_workspace_profile(body["workspace_id"])
    assert ws.writable_paths == ["."] and ws.trust_source == "managed"
    # NEW model: a visible real folder under the project root, not hidden scratch.
    import os
    # realpath: the kernel resolves a symlinked root prefix once (e.g. macOS
    # /var -> /private/var) before the race-free O_NOFOLLOW walk.
    project_root = os.path.realpath(os.environ["SUPERCLAW_PROJECT_ROOT"])
    assert ws.repo_path == os.path.join(project_root, "My notes")
    assert ".superclaw/workspaces" not in ws.repo_path
    assert ws.metadata["creation_mode"] == "real_folder_v1"
    assert os.path.isdir(ws.repo_path)


def test_create_personal_workspace_attach_repo_without_confirmation_is_422(env, tmp_path):
    import subprocess

    client, store, _ = env
    repo = tmp_path / "code" / "app"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    r = client.post("/api/workspaces", json={"name": "app", "attach_repo": str(repo)})
    assert r.status_code == 422  # fail-closed: a real dir is never silently trusted
    assert "trust_confirmed" in r.text
    assert wr.find_workspace_for_path(store, repo) is None  # nothing created

    ok = client.post(
        "/api/workspaces",
        json={"name": "app", "attach_repo": str(repo), "trust_confirmed": True},
    )
    assert ok.status_code == 200 and ok.json()["kind"] == "repo"


@pytest.mark.parametrize("blank", ["", "   "])
def test_create_personal_workspace_blank_name_is_422(env, blank):
    # The blank-name rule lives only in the kernel (create_personal_workspace);
    # the endpoint surfaces its ValueError as 422 for BOTH empty and whitespace —
    # single source of truth shared with the CLI (no Pydantic min_length here).
    client, store, _ = env
    r = client.post("/api/workspaces", json={"name": blank})
    assert r.status_code == 422, r.text
    assert "name must not be empty" in r.text
    assert store.list_workspace_profiles(company_profile_id="local") == []


def test_create_personal_workspace_blank_name_with_attach_reports_name_first(env, tmp_path):
    # Error-priority parity with the CLI: a doubly-invalid payload (blank name AND
    # an untrusted attach) reports the NAME error first, because the one kernel
    # entry validates the name before the trust gate.
    import subprocess

    client, store, _ = env
    repo = tmp_path / "code" / "app"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    r = client.post("/api/workspaces", json={"name": "", "attach_repo": str(repo)})
    assert r.status_code == 422, r.text
    assert "name must not be empty" in r.text
    assert wr.find_workspace_for_path(store, repo) is None


def test_archive_endpoint_hides_then_unarchive_restores(env):
    client, store, _ = env
    session = store.create_chat_session("s")
    assert client.post(f"/api/chat/sessions/{session.session_id}/archive").json()["archived"] is True
    listed = {s["session_id"] for s in client.get("/api/chat/sessions").json()["sessions"]}
    assert session.session_id not in listed
    shown = {s["session_id"] for s in client.get("/api/chat/sessions?include_archived=true").json()["sessions"]}
    assert session.session_id in shown
    restored = client.post(
        f"/api/chat/sessions/{session.session_id}/archive", json={"archived": False}
    )
    assert restored.json()["archived"] is False
    assert session.session_id in {s["session_id"] for s in client.get("/api/chat/sessions").json()["sessions"]}


def test_archive_unknown_session_is_404(env):
    client, _, _ = env
    assert client.post("/api/chat/sessions/nope/archive").status_code == 404


def test_move_endpoint_no_boundary_change_regroups_without_ack(env):
    client, store, _ = env
    a = wr.create_personal_workspace(store, "A")
    # an unassigned, handle-less session has no prior execution dir -> adopting it
    # is not a boundary change, so the move needs no acknowledgement.
    session = store.create_chat_session("s", workspace_id=None)
    r = client.post(
        f"/api/chat/sessions/{session.session_id}/move", json={"workspace_id": a.workspace_id}
    )
    assert r.status_code == 200, r.text
    assert r.json()["workspace_id"] == a.workspace_id
    assert r.json()["execution_boundary_changed"] is False


def test_move_endpoint_boundary_change_requires_acknowledgement(env):
    client, store, _ = env
    a = wr.create_personal_workspace(store, "A")
    b = wr.create_personal_workspace(store, "B")  # different scratch dir
    session = store.create_chat_session("s", workspace_id=a.workspace_id)
    store.set_chat_native_session(session.session_id, "codex", "n1", repo_path=a.repo_path)

    blocked = client.post(
        f"/api/chat/sessions/{session.session_id}/move", json={"workspace_id": b.workspace_id}
    )
    assert blocked.status_code == 409  # fail-closed until acknowledged
    assert blocked.json()["detail"]["execution_boundary_changed"] is True
    # not moved, handle intact
    assert store.get_chat_session(session.session_id).workspace_id == a.workspace_id
    assert store.get_chat_native_session_id(session.session_id, "codex") == "n1"

    ok = client.post(
        f"/api/chat/sessions/{session.session_id}/move",
        json={"workspace_id": b.workspace_id, "acknowledge_boundary_change": True},
    )
    assert ok.status_code == 200
    assert ok.json()["execution_boundary_changed"] is True
    assert ok.json()["workspace_id"] == b.workspace_id
    assert store.get_chat_native_session_id(session.session_id, "codex") is None  # resume reset


def test_move_to_unknown_workspace_is_404(env):
    client, store, _ = env
    session = store.create_chat_session("s")
    assert client.post(
        f"/api/chat/sessions/{session.session_id}/move", json={"workspace_id": "nope"}
    ).status_code == 404


def test_inventory_excludes_company_workspaces(env, tmp_path):
    from superclaw.models import CompanyProfile

    client, store, _ = env
    personal = wr.create_personal_workspace(store, "mine")
    acme = store.save_company_profile(CompanyProfile(name="Acme"))
    company = store.save_workspace_profile(
        WorkspaceProfile(
            name="Acme HQ",
            repo_path=str(tmp_path / "hq"),
            company_profile_id=acme.company_profile_id,
            trust_source="api",
        )
    )
    ids = {w["workspace_id"] for w in client.get("/api/workspaces").json()["workspaces"]}
    assert personal.workspace_id in ids  # personal shows in chat sidebar
    assert company.workspace_id not in ids  # company workspace stays in Team, not chat


def test_sessions_personal_only_excludes_company_sessions(env, tmp_path):
    from superclaw.models import CompanyProfile

    client, store, _ = env
    local_ws = wr.create_personal_workspace(store, "mine")
    acme = store.save_company_profile(CompanyProfile(name="Acme"))
    company_ws = store.save_workspace_profile(
        WorkspaceProfile(name="HQ", repo_path=str(tmp_path / "hq"),
                         company_profile_id=acme.company_profile_id, trust_source="api")
    )
    mine = store.create_chat_session("mine", workspace_id=local_ws.workspace_id)
    teamy = store.create_chat_session("teamy", workspace_id=company_ws.workspace_id)

    ids = {s["session_id"] for s in client.get("/api/chat/sessions?personal_only=true").json()["sessions"]}
    assert mine.session_id in ids
    assert teamy.session_id not in ids  # company session does not leak into the sidebar
    # mutually exclusive with explicit filters
    assert client.get("/api/chat/sessions?personal_only=true&unassigned=true").status_code == 422


def test_direct_chat_fails_closed_on_swapped_real_folder_dir(env, monkeypatch):
    # The deprecated /api/chat/direct endpoint bypasses the orchestrator's
    # _execute_run gate, so the real-folder inode gate must still fire for it: a
    # deleted-and-recreated (same-path, swapped-inode) project dir must be refused
    # 409 and the turn must NEVER execute (fail-closed). It is enforced via the
    # shared _guard_chat_containment choke point; this locks the guarantee for the
    # legacy endpoint so a future refactor cannot silently drop it.
    client, store, _ = env
    called = {"n": 0}

    def must_not_run(**_kwargs):
        called["n"] += 1
        return {"intent": "chat", "status": "completed", "response": "should not happen"}

    monkeypatch.setattr("superclaw.chat_turn.execute_direct_chat_turn", must_not_run)

    ws = wr.create_personal_workspace(store, "proj")  # real-folder, inode-pinned
    # Swap the project dir for a GUARANTEED-different inode: build a sibling
    # replacement (coexists with the original, so it can never share its inode),
    # then atomically rename it over the path. A bare rmtree+mkdir could reuse the
    # freed inode on some filesystems and flake.
    replacement = os.path.join(os.path.dirname(ws.repo_path), "proj_replacement")
    os.mkdir(replacement, 0o700)
    shutil.rmtree(ws.repo_path)
    os.rename(replacement, ws.repo_path)  # same path, definitively different inode

    resp = client.post(
        "/api/chat/direct",
        json={"message": "hi", "backend_policy": "local", "repo_path": ws.repo_path, "budget_seconds": 5},
    )
    assert resp.status_code == 409, resp.text
    assert called["n"] == 0  # fail-closed: the turn never executed in the swapped dir
