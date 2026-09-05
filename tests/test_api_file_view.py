"""API tests for GET /api/runs/{run_id}/files (A line stage 3).

The endpoint is a thin projection of the same read_run_file kernel logic the CLI
uses; this locks the HTTP status mapping and confirms the stable code is always
echoed in the body (CLI/API parity).
"""
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw import workspace_resolver as wr
from superclaw.models import GoalSpec, WorkspaceKind, WorkspaceTrustStatus
from superclaw.state import StateStore


def _seed(tmp_path, *, body="# Title\n\nhi", name="README.md", with_workspace=True):
    state_path = tmp_path / "state.db"
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / name).write_text(body, encoding="utf-8")
    store = StateStore(state_path)
    if with_workspace:
        store.save_workspace_profile(
            wr.WorkspaceProfile(
                name="proj",
                repo_path=str(repo),
                kind=WorkspaceKind.REPO.value,
                trust_status=WorkspaceTrustStatus.ACTIVE.value,
                repo_identity=wr.resolve_repo_identity(repo),
            )
        )
    goal = store.create_goal(GoalSpec(title="t", description="d"))
    run = store.create_run(goal.goal_id)
    run.execution_context = {"repo_path": str(os.path.realpath(repo))}
    store.save_run(run)
    app = create_app(state_path=state_path)
    return TestClient(app), run.run_id


def test_api_file_text_ok(tmp_path):
    client, run_id = _seed(tmp_path)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "README.md"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["is_text"] is True
    assert body["mime"] == "text/markdown"
    assert body["content"].startswith("# Title")
    assert body["path"] == "README.md"


def test_api_file_path_escape_404_with_code(tmp_path):
    client, run_id = _seed(tmp_path)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "../escape"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "path_not_allowed"


def test_api_file_sensitive_403_with_code(tmp_path):
    client, run_id = _seed(tmp_path, body="SECRET=x", name=".env")
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": ".env"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "sensitive_denied"


def test_api_file_untrusted_workspace_403(tmp_path):
    client, run_id = _seed(tmp_path, with_workspace=False)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "README.md"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "untrusted_workspace"


def test_api_file_unknown_run_404(tmp_path):
    client, _ = _seed(tmp_path)
    resp = client.get("/api/runs/run_missing/files", params={"path": "README.md"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"


def test_api_file_nonpositive_max_bytes_422(tmp_path):
    client, run_id = _seed(tmp_path)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "README.md", "max_bytes": 0})
    # Query(gt=0) -> FastAPI validation error, not a silent coercion (CLI parity).
    assert resp.status_code == 422


def test_api_file_oversized_max_bytes_422(tmp_path):
    client, run_id = _seed(tmp_path)
    from superclaw.file_view import FILE_VIEW_SCAN_CAP

    resp = client.get(
        f"/api/runs/{run_id}/files",
        params={"path": "README.md", "max_bytes": FILE_VIEW_SCAN_CAP + 1},
    )
    # le=FILE_VIEW_SCAN_CAP guards against an unbounded request (defense in depth).
    assert resp.status_code == 422


def test_api_error_body_has_no_path_separator(tmp_path):
    # the remote-facing message is a fixed generic string per code — never the
    # raw kernel message — so no server path can leak through this surface.
    client, run_id = _seed(tmp_path)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "../escape"})
    assert resp.status_code == 404
    detail = resp.json()["detail"]
    assert detail["code"] == "path_not_allowed"
    assert "/" not in detail["message"]
    assert "\\" not in detail["message"]


def test_api_file_compromised_managed_dir_409(tmp_path, monkeypatch):
    # A managed real-folder workspace carries a durable inode pin; swapping its
    # directory makes read_run_file raise workspace_compromised -> API 409
    # (strict, not the weaker untrusted path).
    import shutil

    monkeypatch.setenv("SUPERCLAW_PROJECT_ROOT", str(tmp_path / "SuperClaw"))
    path, dev, ino = wr.create_managed_project_dir("proj")
    (path / "doc.md").write_text("# ok", encoding="utf-8")
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    store.save_workspace_profile(
        wr.WorkspaceProfile(
            name="proj", repo_path=str(path), kind=WorkspaceKind.MANAGED.value,
            trust_status=WorkspaceTrustStatus.ACTIVE.value, repo_identity=wr.resolve_repo_identity(path),
            metadata={"creation_mode": wr.REAL_FOLDER_CREATION_MODE, "dir_pin": {"dev": dev, "ino": ino}},
        )
    )
    goal = store.create_goal(GoalSpec(title="t", description="d"))
    run = store.create_run(goal.goal_id)
    run.execution_context = {"repo_path": str(path)}
    store.save_run(run)
    client = TestClient(create_app(state_path=state_path))
    assert client.get(f"/api/runs/{run.run_id}/files", params={"path": "doc.md"}).status_code == 200
    # Swap the pinned dir for a DIFFERENT real directory. Build the replacement at a
    # separate path FIRST (while the original still exists, so it gets its own inode),
    # then rename it into place. This guarantees st_ino != the pinned ino even on
    # filesystems (ext4) where rmtree()+mkdir() of the same path reuses the freed
    # inode — that reuse made this assert flaky on the Linux CI runner (got 200).
    attacker = tmp_path / "attacker-dir"
    attacker.mkdir()
    (attacker / "doc.md").write_text("attacker", encoding="utf-8")
    shutil.rmtree(path)
    os.rename(attacker, path)
    resp = client.get(f"/api/runs/{run.run_id}/files", params={"path": "doc.md"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "workspace_compromised"


def test_api_file_oversize_text_413(tmp_path):
    # A real text file over the scan cap exercises the kernel
    # sensitive_scan_unbounded path -> API 413 (distinct from the 422 param guard).
    from superclaw.file_view import FILE_VIEW_SCAN_CAP

    client, run_id = _seed(tmp_path, body="a" * (FILE_VIEW_SCAN_CAP + 16), name="huge.txt")
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "huge.txt"})
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "sensitive_scan_unbounded"


def test_api_unknown_code_collapsed_no_leak(tmp_path, monkeypatch):
    # Regression lock for the unknown-code guard: an out-of-set FileViewError code
    # (here deliberately path-bearing) must NOT reach the client via code OR
    # message — both collapse to the fixed safe "request_refused". This fails if
    # the fallback is ever reverted to echoing exc.code.
    from superclaw import file_view

    client, run_id = _seed(tmp_path)

    def _boom(*_a, **_k):
        raise file_view.FileViewError("/srv/secret/internal-path", "/srv/secret/internal detail")

    monkeypatch.setattr(file_view, "read_run_file", _boom)
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "README.md"})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["code"] == "request_refused"
    assert "/srv/secret" not in detail["code"]
    assert "/srv/secret" not in detail["message"]


def test_api_file_binary_metadata_only(tmp_path):
    client, run_id = _seed(tmp_path)
    (tmp_path / "repo" / "blob.bin").write_bytes(b"\x00\x01\x02\xff")
    resp = client.get(f"/api/runs/{run_id}/files", params={"path": "blob.bin"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_text"] is False
    assert body["content"] is None


def test_api_file_requires_control_token_when_set(tmp_path):
    state_path = tmp_path / "state.db"
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("# t", encoding="utf-8")
    store = StateStore(state_path)
    store.save_workspace_profile(
        wr.WorkspaceProfile(
            name="proj", repo_path=str(repo), kind=WorkspaceKind.REPO.value,
            trust_status=WorkspaceTrustStatus.ACTIVE.value, repo_identity=wr.resolve_repo_identity(repo),
        )
    )
    goal = store.create_goal(GoalSpec(title="t", description="d"))
    run = store.create_run(goal.goal_id)
    run.execution_context = {"repo_path": str(os.path.realpath(repo))}
    store.save_run(run)
    app = create_app(state_path=state_path)
    app.state.control_token = "secret-token"
    client = TestClient(app)
    # no token -> 401
    resp = client.get(f"/api/runs/{run.run_id}/files", params={"path": "README.md"})
    assert resp.status_code == 401
    # correct token -> 200
    resp = client.get(
        f"/api/runs/{run.run_id}/files",
        params={"path": "README.md"},
        headers={"X-SuperClaw-Token": "secret-token"},
    )
    assert resp.status_code == 200
