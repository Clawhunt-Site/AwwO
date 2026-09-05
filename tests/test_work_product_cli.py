"""CLI surface tests for `superclaw issue work-product-update`.

The CLI is the kernel baseline: this command is the CLI twin of the API's
PATCH /api/team/work-products/{id} and the Web status control. The kernel's
update_work_product stays the single source of truth (an unknown status fails
closed); the CLI is a thin, parity-checked wrapper over it.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw import team_kernel
from superclaw.cli import app
from superclaw.models import CompanyProfile, Issue
from superclaw.state import StateStore

runner = CliRunner()


@pytest.fixture
def state_path(tmp_path, monkeypatch):
    p = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(p))
    return p


def _seed_work_product(state_path):
    store = StateStore(state_path)
    store.save_company_profile(CompanyProfile(name="Acme", company_profile_id="company_acme"))
    store.save_issue(
        Issue(
            issue_id="issue_1",
            company_profile_id="company_acme",
            title="Ship login",
            status="in_progress",
        )
    )
    wp = team_kernel.attach_work_product(
        store, "issue_1", type="pull_request", title="PR #1", status="open"
    )
    return wp


def test_cli_update_changes_status_through_the_kernel(state_path):
    wp = _seed_work_product(state_path)
    result = runner.invoke(
        app, ["issue", "work-product-update", wp.work_product_id, "--status", "merged"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "merged"
    # persisted, not just echoed
    assert StateStore(state_path).get_work_product(wp.work_product_id).status == "merged"


def test_cli_update_can_also_set_title(state_path):
    wp = _seed_work_product(state_path)
    result = runner.invoke(
        app, ["issue", "work-product-update", wp.work_product_id, "--title", "Renamed PR"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["title"] == "Renamed PR"


def test_cli_update_unknown_status_fails_closed(state_path):
    wp = _seed_work_product(state_path)
    result = runner.invoke(
        app, ["issue", "work-product-update", wp.work_product_id, "--status", "bogus"]
    )
    assert result.exit_code != 0
    # status was NOT mutated
    assert StateStore(state_path).get_work_product(wp.work_product_id).status == "open"


def test_cli_update_with_no_fields_is_rejected(state_path):
    wp = _seed_work_product(state_path)
    result = runner.invoke(app, ["issue", "work-product-update", wp.work_product_id])
    assert result.exit_code != 0
    assert "nothing to update" in result.output


def test_cli_update_unknown_work_product_fails_closed(state_path):
    _seed_work_product(state_path)
    result = runner.invoke(
        app, ["issue", "work-product-update", "wp_missing", "--status", "ready"]
    )
    assert result.exit_code != 0
