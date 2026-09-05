"""P2: issue-lifecycle write commands (block/unblock/hold/unhold).

The first slice of the operational write surface projected into chat — the
operator can manage an issue's board state (block/unblock, hold/unhold) from chat,
routed through the SAME execute_company_command choke point as every other
mutation. These are PURE store-state transitions (no runtime capability, no
orphan-run hazard); requeue (abort_checkout) and the tree ops (pause/resume/cancel)
are deferred to a follow-up that wires the orchestrator run_canceller + an
active-run guard correctly across every surface. Covered here:

  * dispatch: each command runs the matching team_kernel primitive end-to-end;
  * risk tiers: all four are reversible → LOW (direct);
  * governance: a CONFINED agent is default-denied every lifecycle command (they
    are not in the autonomy gate's allowed set — operator-only board management);
  * scope: a cross-company target is forbidden;
  * single-source contract: registry / tool map / schema stay in lockstep;
  * three-surface parity: the company CLI subcommands route through the same handler.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import (
    COMMAND_REGISTRY,
    COMMAND_TYPE_TO_TOOL_NAME,
    get_command_model,
)
from superclaw.company_handler import execute_company_command
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import AgentProfile, CompanyProfile, Issue
from superclaw.state import StateStore
from superclaw.ui_contracts import COMPANY_COMMAND_TOOLS, TOOL_NAME_TO_COMMAND_TYPE

_LIFECYCLE_TYPES = {
    "issue.block",
    "issue.unblock",
    "issue.hold",
    "issue.unhold",
}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name, owner_id="u"))


def _agent(store, company_id, *, name="A"):
    return store.save_agent_profile(AgentProfile(name=name, role="eng", company_profile_id=company_id))


def _issue(store, company_id, *, status="in_progress", assignee=None):
    return store.save_issue(
        Issue(title="T", company_profile_id=company_id, status=status, assignee_agent_profile_id=assignee)
    )


def _operator(company_id):
    return CompanyScope(principal_id="u", actor_company_id=company_id, is_admin=True)


def _confined(company_id, agent_id):
    return CompanyScope(
        principal_id="u", actor_company_id=company_id, is_admin=False, actor_agent_profile_id=agent_id
    )


def _run(store, scope, command_type, args):
    cmd = get_command_model(command_type).from_dict(args)
    return execute_company_command(cmd, scope=scope, store=store, requested_by="u")


# --- single-source contract -------------------------------------------------
def test_lifecycle_commands_registered_and_mapped():
    assert _LIFECYCLE_TYPES <= set(COMMAND_REGISTRY)
    assert _LIFECYCLE_TYPES <= set(COMMAND_TYPE_TO_TOOL_NAME)
    # schema + dispatch map + registry stay in lockstep (the import-time asserts in
    # ui_contracts already enforce this; re-assert the new tools are present).
    schema_names = {t["name"] for t in COMPANY_COMMAND_TOOLS}
    for ctype in _LIFECYCLE_TYPES:
        assert COMMAND_TYPE_TO_TOOL_NAME[ctype] in schema_names
        assert COMMAND_TYPE_TO_TOOL_NAME[ctype] in TOOL_NAME_TO_COMMAND_TYPE


# --- dispatch (operator, end-to-end) ----------------------------------------
def test_block_then_unblock(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    op = _operator(c.company_profile_id)
    assert _run(store, op, "issue.block", {"issue_id": iss.issue_id, "reason": "waiting"}).outcome == "executed"
    assert store.get_issue(iss.issue_id).status == "blocked"
    assert _run(store, op, "issue.unblock", {"issue_id": iss.issue_id}).outcome == "executed"
    assert store.get_issue(iss.issue_id).status != "blocked"


def test_hold_then_unhold(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    op = _operator(c.company_profile_id)
    held = _run(store, op, "issue.hold", {"issue_id": iss.issue_id, "reason": "pause"})
    assert held.outcome == "executed" and held.detail["hold_id"]
    assert store.get_active_issue_hold(iss.issue_id) is not None
    assert _run(store, op, "issue.unhold", {"issue_id": iss.issue_id}).outcome == "executed"
    assert store.get_active_issue_hold(iss.issue_id) is None


# --- governance: confined agents are default-denied -------------------------
@pytest.mark.parametrize("ctype", sorted(_LIFECYCLE_TYPES))
def test_confined_agent_denied_every_lifecycle_command(store, ctype):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, assignee=ag.profile_id)
    conf = _confined(c.company_profile_id, ag.profile_id)
    args = {"issue_id": iss.issue_id}
    if ctype == "issue.block":
        args["reason"] = "x"
    with pytest.raises(CompanyScopeError):
        _run(store, conf, ctype, args)


# --- scope: cross-company target forbidden ----------------------------------
def test_cross_company_block_forbidden(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = _issue(store, b.company_profile_id)
    # An operator scoped (allow-set) to A only, not admin, cannot reach B's issue.
    scoped_to_a = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, scoped_to_a, "issue.block", {"issue_id": foreign.issue_id, "reason": "x"})


# --- validation: fail-closed on bad args ------------------------------------
def test_block_requires_reason():
    # Write-command from_dict constructs; validate() (run by the handler) is the
    # business gate. A blank reason must fail-closed at validate.
    from superclaw.company_commands import BlockIssueCommand

    with pytest.raises(ValueError):
        BlockIssueCommand.from_dict({"issue_id": "i1", "reason": ""}).validate()


def test_block_executes_rejects_blank_reason_via_handler(store):
    # End-to-end: the handler's validate step refuses a blank reason.
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    with pytest.raises(ValueError):
        _run(store, _operator(c.company_profile_id), "issue.block", {"issue_id": iss.issue_id, "reason": "  "})


def test_lifecycle_rejects_unknown_field():
    with pytest.raises(ValueError):
        get_command_model("issue.hold").from_dict({"issue_id": "i1", "bogus": 1})


# --- CLI three-surface parity (routed through the SAME handler) --------------
def test_cli_block_unblock_parity(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    s = StateStore(state_path)
    c = _company(s)
    iss = _issue(s, c.company_profile_id)
    runner = CliRunner()
    r = runner.invoke(app, ["company", "block-issue", "--issue-id", iss.issue_id, "--reason", "waiting", "--company-id", c.company_profile_id])
    assert r.exit_code == 0, r.output
    assert StateStore(state_path).get_issue(iss.issue_id).status == "blocked"
    r2 = runner.invoke(app, ["company", "unblock-issue", "--issue-id", iss.issue_id, "--company-id", c.company_profile_id])
    assert r2.exit_code == 0, r2.output
    assert StateStore(state_path).get_issue(iss.issue_id).status != "blocked"
