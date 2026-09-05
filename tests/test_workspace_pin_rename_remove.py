"""Sidebar pin / rename / remove — kernel + CLI + API parity.

The sidebar "pin to top", "rename", and "remove from list" actions are
cross-surface kernel capabilities (CLAUDE.md: capability lands in the core and is
exposed via the CLI first; API/Web only call the same kernel logic). These tests
pin down the kernel semantics and assert the CLI and API are faithful, zero-drift
projections of them.

Invariants under test:
  * pinning is navigation-only — it never changes workspace membership, the
    archived flag, history, or the execution boundary; unpinning fully reverts.
  * pin/unpin are idempotent and order-stable (re-pin keeps the first stamp).
  * rename validates the blank-name rule in ONE kernel entry (CLI/API share it).
  * remove unregisters the project + archives AND unassigns its sessions (never
    deletes them, never leaves them dangling on a dead workspace id); the
    built-in Chat workspace can never be removed (fail-closed).
  * pinned_at survives a to_dict/from_dict round trip, and legacy rows that
    predate the field deserialize as unpinned (None).
"""

import json
import os

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from apps.api.main import create_app
from superclaw.cli import app
from superclaw.models import ChatSession, CompanyProfile, WorkspaceProfile
from superclaw.state import StateStore
from superclaw import workspace_resolver as wr


runner = CliRunner()


@pytest.fixture(autouse=True)
def _isolate_environ():
    snapshot = os.environ.copy()
    yield
    os.environ.clear()
    os.environ.update(snapshot)


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


@pytest.fixture
def cli_state(tmp_path, monkeypatch):
    path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(path))
    return path


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chats"))
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    return client, StateStore(tmp_path / "state.db")


def _ws(store, name="proj", **kw):
    return store.save_workspace_profile(
        WorkspaceProfile(name=name, repo_path=".", trust_source="api", **kw)
    )


# --- model round-trip ---------------------------------------------------------


def test_pinned_at_round_trips_through_dict():
    session = ChatSession(title="t", pinned_at=123.5)
    assert ChatSession.from_dict(session.to_dict()).pinned_at == 123.5
    ws = WorkspaceProfile(name="w", pinned_at=99.0)
    assert WorkspaceProfile.from_dict(ws.to_dict()).pinned_at == 99.0


def test_legacy_rows_without_pinned_at_are_unpinned():
    # A row written before the field existed: deserialize as not-pinned, never crash.
    session = ChatSession.from_dict({"session_id": "s1", "title": "t"})
    assert session.pinned_at is None
    ws = WorkspaceProfile.from_dict({"name": "w", "workspace_id": "ws1"})
    assert ws.pinned_at is None


# --- kernel: session pin ------------------------------------------------------


def test_set_chat_session_pinned_is_navigation_only(store):
    ws = _ws(store)
    session = store.create_chat_session("hello", workspace_id=ws.workspace_id)
    pinned = store.set_chat_session_pinned(session.session_id, True, now=10.0)
    assert pinned.pinned_at == 10.0
    # membership / archived untouched
    assert pinned.workspace_id == ws.workspace_id
    assert pinned.archived is False
    # re-pin keeps the FIRST stamp (order-stable, idempotent)
    assert store.set_chat_session_pinned(session.session_id, True, now=20.0).pinned_at == 10.0
    # unpin reverts fully, membership still intact
    unpinned = store.set_chat_session_pinned(session.session_id, False)
    assert unpinned.pinned_at is None
    assert unpinned.workspace_id == ws.workspace_id
    # persisted, not just in-memory
    assert store.get_chat_session(session.session_id).pinned_at is None


def test_set_chat_session_pinned_unknown_raises(store):
    with pytest.raises(KeyError):
        store.set_chat_session_pinned("session_missing", True)


# --- kernel: workspace pin ----------------------------------------------------


def test_set_workspace_pinned_idempotent_and_reversible(store):
    ws = _ws(store)
    assert store.set_workspace_pinned(ws.workspace_id, True, now=5.0).pinned_at == 5.0
    assert store.set_workspace_pinned(ws.workspace_id, True, now=9.0).pinned_at == 5.0
    assert store.set_workspace_pinned(ws.workspace_id, False).pinned_at is None
    assert store.get_workspace_profile(ws.workspace_id).pinned_at is None


def test_set_workspace_pinned_unknown_raises(store):
    with pytest.raises(KeyError):
        store.set_workspace_pinned("workspace_missing", True)


# --- kernel: rename -----------------------------------------------------------


def test_rename_workspace_changes_name_only(store):
    ws = _ws(store, name="old")
    renamed = store.rename_workspace(ws.workspace_id, "  New Name  ")
    assert renamed.name == "New Name"  # trimmed
    assert renamed.workspace_id == ws.workspace_id
    assert renamed.repo_path == ws.repo_path  # path untouched
    assert store.get_workspace_profile(ws.workspace_id).name == "New Name"


def test_rename_workspace_blank_is_rejected(store):
    ws = _ws(store, name="old")
    with pytest.raises(ValueError):
        store.rename_workspace(ws.workspace_id, "   ")
    assert store.get_workspace_profile(ws.workspace_id).name == "old"  # unchanged


def test_rename_workspace_unknown_raises(store):
    with pytest.raises(KeyError):
        store.rename_workspace("workspace_missing", "x")


# --- kernel: remove -----------------------------------------------------------


def test_remove_workspace_archives_and_unassigns_sessions(store):
    ws = _ws(store, name="proj")
    s1 = store.create_chat_session("a", workspace_id=ws.workspace_id)
    s2 = store.create_chat_session("b", workspace_id=ws.workspace_id)
    store.set_chat_session_pinned(s2.session_id, True)  # pinned session must un-pin on remove
    n = store.remove_workspace(ws.workspace_id)
    assert n == 2
    # profile gone
    with pytest.raises(KeyError):
        store.get_workspace_profile(ws.workspace_id)
    # sessions retained, archived + unassigned + unpinned (recoverable, never dangling)
    for sid in (s1.session_id, s2.session_id):
        got = store.get_chat_session(sid)
        assert got.archived is True
        assert got.workspace_id is None
        assert got.pinned_at is None
    # they remain reachable via the archived view (not orphaned out of the query)
    archived_ids = {s.session_id for s in store.list_chat_sessions(include_archived=True)}
    assert {s1.session_id, s2.session_id} <= archived_ids


def test_remove_builtin_chat_workspace_is_refused(store):
    chat_ws = wr.ensure_chat_workspace(store)
    with pytest.raises(ValueError):
        store.remove_workspace(chat_ws.workspace_id)
    # still registered after the refusal
    assert store.get_workspace_profile(chat_ws.workspace_id) is not None


def test_remove_workspace_unknown_raises(store):
    with pytest.raises(KeyError):
        store.remove_workspace("workspace_missing")


def test_remove_company_workspace_is_refused(store):
    # The personal-sidebar "remove" twin must NOT delete a company's execution
    # boundary (fail-closed governance) — those are owned by the team surface.
    cid = store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="acme-proj", repo_path=".", company_profile_id=cid, trust_source="api")
    )
    with pytest.raises(ValueError):
        store.remove_workspace(ws.workspace_id)
    assert store.get_workspace_profile(ws.workspace_id) is not None  # untouched


# --- CLI parity ---------------------------------------------------------------


def test_cli_pin_unpin_session(cli_state):
    store = StateStore(cli_state)
    session = store.create_chat_session("hi")
    out = runner.invoke(app, ["workspace", "pin-session", session.session_id])
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["pinned_at"] is not None
    out = runner.invoke(app, ["workspace", "unpin-session", session.session_id])
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["pinned_at"] is None


def test_cli_pin_unpin_rename_workspace(cli_state):
    store = StateStore(cli_state)
    ws = _ws(store, name="old")
    assert runner.invoke(app, ["workspace", "pin", ws.workspace_id]).exit_code == 0
    assert store.get_workspace_profile(ws.workspace_id).pinned_at is not None
    assert runner.invoke(app, ["workspace", "unpin", ws.workspace_id]).exit_code == 0
    assert store.get_workspace_profile(ws.workspace_id).pinned_at is None
    out = runner.invoke(app, ["workspace", "rename", ws.workspace_id, "Fresh"])
    assert out.exit_code == 0, out.output
    assert store.get_workspace_profile(ws.workspace_id).name == "Fresh"


def test_cli_rename_blank_fails(cli_state):
    store = StateStore(cli_state)
    ws = _ws(store, name="old")
    out = runner.invoke(app, ["workspace", "rename", ws.workspace_id, "   "])
    assert out.exit_code == 1  # _fail → Exit(1)
    assert "error:" in out.output
    assert store.get_workspace_profile(ws.workspace_id).name == "old"


def test_cli_remove_requires_yes_non_interactive(cli_state):
    store = StateStore(cli_state)
    ws = _ws(store, name="old")
    out = runner.invoke(app, ["workspace", "remove", ws.workspace_id])
    assert out.exit_code == 1  # fail-closed: no --yes, non-interactive → _fail → Exit(1)
    assert store.get_workspace_profile(ws.workspace_id) is not None  # untouched
    out = runner.invoke(app, ["workspace", "remove", ws.workspace_id, "--yes"])
    assert out.exit_code == 0, out.output
    with pytest.raises(KeyError):
        store.get_workspace_profile(ws.workspace_id)


# --- API parity ---------------------------------------------------------------


def test_api_pin_session_round_trip(api):
    client, store = api
    session = store.create_chat_session("hi")
    r = client.post(f"/api/chat/sessions/{session.session_id}/pin")
    assert r.status_code == 200, r.text
    assert r.json()["pinned_at"] is not None
    r = client.post(f"/api/chat/sessions/{session.session_id}/pin", json={"pinned": False})
    assert r.json()["pinned_at"] is None
    assert client.post("/api/chat/sessions/missing/pin").status_code == 404


def test_api_pin_rename_remove_workspace(api):
    client, store = api
    ws = _ws(store, name="old")
    # pin → projection reflects it
    r = client.post(f"/api/workspaces/{ws.workspace_id}/pin")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pinned"] is True and body["pinned_at"] is not None
    # rename
    r = client.patch(f"/api/workspaces/{ws.workspace_id}", json={"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed"
    # blank rename → 422 from the single kernel validator
    assert client.patch(f"/api/workspaces/{ws.workspace_id}", json={"name": "  "}).status_code == 422
    # remove → 200 + gone; idempotent second remove → 404
    s = store.create_chat_session("c", workspace_id=ws.workspace_id)
    r = client.delete(f"/api/workspaces/{ws.workspace_id}")
    assert r.status_code == 200, r.text
    assert r.json()["removed"] is True and r.json()["archived_sessions"] == 1
    assert store.get_chat_session(s.session_id).archived is True
    assert client.delete(f"/api/workspaces/{ws.workspace_id}").status_code == 404


def test_api_remove_builtin_chat_is_422(api):
    client, store = api
    chat_ws = wr.ensure_chat_workspace(store)
    assert client.delete(f"/api/workspaces/{chat_ws.workspace_id}").status_code == 422


def test_api_inventory_exposes_pinned(api):
    client, store = api
    ws = _ws(store, name="proj")
    store.set_workspace_pinned(ws.workspace_id, True)
    inventory = client.get("/api/workspaces").json()
    target = next(w for w in inventory["workspaces"] if w["workspace_id"] == ws.workspace_id)
    assert target["pinned"] is True
    assert target["pinned_at"] is not None
