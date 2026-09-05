"""CLI + contract tests for the reference-viewer file capability (A line stage 2).

Confirms `superclaw file show` drives the SAME kernel logic and stable error
codes as the API/Web will (CLI-is-kernel parity), and that the shared contract
exposes the limits/codes surfaces must render from.
"""
from __future__ import annotations

import json
import os

from typer.testing import CliRunner

from superclaw import file_view, workspace_resolver as wr
from superclaw.cli import app
from superclaw.models import GoalSpec, WorkspaceKind, WorkspaceTrustStatus
from superclaw.state import StateStore
from superclaw.ui_contracts import build_file_view_contract

runner = CliRunner()


def _seed(tmp_path, monkeypatch, body: str = "# Title\n\nhello", name: str = "README.md"):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / name).write_text(body, encoding="utf-8")
    state = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state))
    store = StateStore(state)
    ws = wr.WorkspaceProfile(
        name="proj",
        repo_path=str(repo),
        kind=WorkspaceKind.REPO.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        repo_identity=wr.resolve_repo_identity(repo),
    )
    store.save_workspace_profile(ws)
    goal = store.create_goal(GoalSpec(title="t", description="d"))
    run = store.create_run(goal.goal_id)
    run.execution_context = {"repo_path": str(os.path.realpath(repo))}
    store.save_run(run)
    return run


def test_cli_file_show_text(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch)
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", "README.md"])
    assert result.exit_code == 0
    assert "# Title" in result.stdout


def test_cli_file_show_json(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch)
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", "README.md", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["is_text"] is True
    assert payload["mime"] == "text/markdown"
    assert payload["path"] == "README.md"


def test_cli_file_show_sensitive_denied_nonzero_exit(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch, body="SECRET=x", name=".env")
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", ".env"])
    assert result.exit_code == 1
    assert "file_error=sensitive_denied" in result.output


def test_cli_file_show_path_escape_exact_code(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch)
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", "../escape"])
    assert result.exit_code == 1
    assert "file_error=path_not_allowed" in result.output


def test_cli_file_show_binary_metadata_only_no_download_claim(tmp_path, monkeypatch):
    repo_run = _seed(tmp_path, monkeypatch)
    repo = tmp_path / "repo"
    (repo / "blob.bin").write_bytes(b"\x00\x01\x02\xff")
    result = runner.invoke(app, ["file", "show", repo_run.run_id, "--path", "blob.bin"])
    assert result.exit_code == 0
    assert "[binary]" in result.output
    assert "metadata only" in result.output
    # must NOT imply a download path exists on any surface (contract parity)
    assert "download" not in result.output.replace("no content returned", "")


def test_cli_file_show_truncation_notice(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch, body="x" * 5000, name="big.txt")
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", "big.txt", "--max-bytes", "100"])
    assert result.exit_code == 0
    assert "truncated to 100 bytes" in result.output


def test_cli_file_show_rejects_nonpositive_max_bytes(tmp_path, monkeypatch):
    run = _seed(tmp_path, monkeypatch)
    result = runner.invoke(app, ["file", "show", run.run_id, "--path", "README.md", "--max-bytes", "0"])
    # Typer min=1 -> usage error, not a silent coercion to the default.
    assert result.exit_code != 0
    assert "file_error" not in result.output


def test_contract_exposes_limits_and_error_codes():
    contract = build_file_view_contract()
    assert contract["max_bytes"] == file_view.FILE_VIEW_MAX_BYTES
    assert contract["scan_cap_bytes"] == file_view.FILE_VIEW_SCAN_CAP
    assert contract["binary_download"] is False
    assert "markdown" in contract["render_categories"]
    # the surfaces map FROM this exact, ordered code list — lock order + dupes
    assert tuple(contract["error_codes"]) == tuple(file_view.FILE_VIEW_ERROR_CODES)
