"""Tests for the unified company-management command handler.

Exercises the fixed fail-closed order (validate -> scope -> active -> risk ->
branch), the LOW direct-execution path, the HIGH approval path, the company
scope/lifecycle hard gates, server-side owner injection, and the grant-time
TOCTOU re-check that runs when a HIGH company-command approval is granted.

Uses a real :class:`StateStore` on ``tmp_path`` so the kernel mutations and the
approval round-trip are checked against persisted state.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.company_commands import (
    AssignIssueCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    HireAgentCommand,
    UpdateAgentCommand,
)
from superclaw.company_handler import (
    _scope_from_dict,
    execute_company_command,
)
from superclaw.company_lifecycle import CompanyFrozenError
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import (
    AgentProfile,
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    CompanyStatus,
    Issue,
    WorkspaceProfile,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _no_equipment(profile):
    """Equipment-resolver stub: a role with no granted plugins/skills (minimal)."""
    return team_kernel.EquipmentResolution(
        profile_id=getattr(profile, "profile_id", "_stub"),
        granted=(),
        dropped=(),
        available=(),
        skills_granted=(),
        skills_dropped=(),
        skills_available=(),
    )


def _company(store: StateStore, *, name="Acme", status=CompanyStatus.ACTIVE.value):
    company = CompanyProfile(name=name, status=status)
    store.save_company_profile(company)
    return company


def _scope(company_id: str, *, principal_id="op_1", is_admin: bool = True) -> CompanyScope:
    # Default to the OPERATOR (admin): most handler tests here exercise operator-
    # driven LOW/HIGH flows. Confined-agent tests pass is_admin=False explicitly
    # (e.g. the autonomous-hire red-line test); dedicated confinement coverage
    # lives in test_company_autonomy.py.
    return CompanyScope(
        principal_id=principal_id, actor_company_id=company_id, is_admin=is_admin
    )


# --- LOW path: direct execution --------------------------------------------


def test_low_create_company_executes_and_persists(store):
    # A bare-namespace create is LOW: it must run straight through and land.
    scope = _scope("home_co", principal_id="op_create")
    cmd = CompanyCreateCommand(name="NewCo")

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_create"
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    new_id = result.detail["company_profile_id"]
    saved = store.get_company_profile(new_id)
    assert saved.name == "NewCo"
    assert saved.status == CompanyStatus.ACTIVE.value


def test_low_create_structured_unassigned_issue_executes(store):
    company = _company(store)
    # Operator scope: root issue_create is LOW for the operator (a confined agent
    # is gated separately — see test_company_autonomy.py).
    scope = _scope(company.company_profile_id, is_admin=True)
    cmd = CreateIssueCommand(title="ship docs", kind="delivery")

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    issue = store.get_issue(result.detail["issue_id"])
    assert issue.title == "ship docs"
    assert issue.company_profile_id == company.company_profile_id
    assert issue.assignee_agent_profile_id is None


def test_operator_hire_creates_agent_directly(store):
    # An OPERATOR-triggered hire (is_admin=True: the owner acting through their own
    # chat) is LOW: it creates + persists the agent IMMEDIATELY (no PENDING hire
    # approval round-trip), via the shared kernel creation point.
    company = _company(store)
    scope = _scope(company.company_profile_id, is_admin=True)
    cmd = HireAgentCommand(
        spec={
            "name": "Bob",
            "role": "dev",
            "company_profile_id": company.company_profile_id,
        }
    )

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    assert result.detail["created"] == "agent"
    # The agent really exists in the store (not a pending hire_approval).
    profile = store.get_agent_profile(result.detail["profile_id"])
    assert profile.name == "Bob"
    assert profile.role == "dev"
    assert profile.company_profile_id == company.company_profile_id
    assert store.list_approvals() == []


def test_autonomous_agent_hire_records_pending_approval_not_direct_create(store):
    # RED LINE: an autonomous agent (is_admin=False, the scope an orchestrated team
    # run derives from the agent profile) hiring must NOT create a profile directly.
    # It records a PENDING approval; a human grant later runs the same create path.
    company = _company(store)
    scope = _scope(company.company_profile_id, is_admin=False)
    cmd = HireAgentCommand(
        spec={
            "name": "Bob",
            "role": "dev",
            "company_profile_id": company.company_profile_id,
        }
    )

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="agent_ceo"
    )

    assert result.outcome == "pending_approval"
    assert result.verdict.is_high
    # No agent was created — only a pending approval exists.
    approvals = store.list_approvals()
    assert len(approvals) == 1
    assert result.detail["approval_id"] == approvals[0].approval_id
    assert not any(
        getattr(p, "name", None) == "Bob" for p in store.list_agent_profiles()
    )


# --- LOW path: company update runs straight through -------------------------


def test_low_company_update_executes_directly(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    # Under the re-ratified threat model (design §1) a company update is a
    # reversible, user-triggered operation -> LOW, applied immediately.
    cmd = CompanyUpdateCommand(
        company_profile_id=company.company_profile_id, goal="new mission"
    )

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    # The company was mutated immediately (no approval round-trip).
    assert store.get_company_profile(company.company_profile_id).goal == "new mission"
    assert store.list_approvals() == []


# --- HIGH path: pending approval (only the irreversible archive) ------------


def test_high_company_archive_records_pending_approval(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    # Archive is the sole irreversible/destructive command -> HIGH, pauses for a
    # human "are you sure?" confirmation rather than executing.
    cmd = CompanyArchiveCommand(company_profile_id=company.company_profile_id)

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )

    assert result.outcome == "pending_approval"
    assert result.verdict.is_high
    approval = store.get_approval(result.detail["approval_id"])
    assert approval.status == ApprovalStatus.PENDING.value
    assert approval.type == ApprovalType.COMPANY_COMMAND.value
    assert approval.resume_action["kernel"] == "company.command"
    assert approval.resume_action["command_type"] == "company.archive"
    # Two-phase archive (contract E): recording the PENDING approval is PHASE 1 —
    # the company is FROZEN immediately so it hosts no new work during the human
    # "are you sure?" window (it is NOT dissolved yet — that only lands on grant).
    frozen = store.get_company_profile(company.company_profile_id)
    assert frozen.status == CompanyStatus.FROZEN.value
    assert frozen.epoch == company.epoch + 1
    # The approval is attributed to its company so a company-scoped inbox / the
    # archive cascade can find this issue-less approval.
    assert approval.affects["company_profile_id"] == company.company_profile_id


# --- scope门 runs BEFORE risk (hard forbidden) -----------------------------


def test_cross_company_command_raises_scope_error_before_risk(store):
    company = _company(store)
    # Actor scoped to a DIFFERENT company than the update target. Non-admin: an
    # admin would permit all of its own companies (the cross-company hard gate is
    # what confines a non-admin), so this boundary test must be a confined scope.
    scope = _scope("other_co", is_admin=False)
    cmd = CompanyUpdateCommand(
        company_profile_id=company.company_profile_id, goal="x"
    )

    with pytest.raises(CompanyScopeError):
        execute_company_command(cmd, scope=scope, store=store, requested_by="op_1")
    # No approval was recorded — the forbidden command never reached the ask path.
    assert store.list_approvals() == []


# --- active门: frozen company refused --------------------------------------


def test_frozen_company_update_raises_frozen_error(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    scope = _scope(company.company_profile_id)
    cmd = CompanyUpdateCommand(
        company_profile_id=company.company_profile_id, name="renamed"
    )

    with pytest.raises(CompanyFrozenError):
        execute_company_command(cmd, scope=scope, store=store, requested_by="op_1")


def test_frozen_company_blocks_low_issue_create(store):
    # The active门 also fences implicit-target commands (issue create in the
    # actor's home company) so a frozen company hosts no new work.
    company = _company(store, status=CompanyStatus.FROZEN.value)
    scope = _scope(company.company_profile_id)
    cmd = CreateIssueCommand(title="should be blocked", kind="delivery")

    with pytest.raises(CompanyFrozenError):
        execute_company_command(cmd, scope=scope, store=store, requested_by="op_1")


# --- validate门 runs FIRST -------------------------------------------------


def test_validate_failure_raises_value_error_first(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    # Empty required title → validate() raises before any scope/active/risk work.
    cmd = CreateIssueCommand(title="")

    with pytest.raises(ValueError):
        execute_company_command(cmd, scope=scope, store=store, requested_by="op_1")
    # Nothing was created.
    assert store.list_issues(company_profile_id=company.company_profile_id) == []


# --- owner_id is server-injected -------------------------------------------


def test_create_company_owner_is_server_injected_not_from_command(store):
    # The server stamps the scope principal as owner regardless of the command.
    scope = _scope("home_co", principal_id="real_operator")
    cmd = CompanyCreateCommand(name="OwnedCo")

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="real_operator"
    )

    saved = store.get_company_profile(result.detail["company_profile_id"])
    assert saved.owner_id == "real_operator"


def test_explicit_owner_id_ignored_server_stamps_principal(store):
    # A create runs straight through (LOW) now, but an explicit owner_id in the
    # command must STILL be ignored — the server always stamps the scope
    # principal as owner, never the command's owner_id.
    scope = _scope("home_co", principal_id="real_operator")
    cmd = CompanyCreateCommand(name="RepointCo", owner_id="other_user")

    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="real_operator"
    )
    assert result.outcome == "executed"
    assert result.verdict.tier == "low"

    companies = [c for c in store.list_company_profiles() if c.name == "RepointCo"]
    assert len(companies) == 1
    assert companies[0].owner_id == "real_operator"


# --- LOW company update lands immediately ----------------------------------


def test_low_company_update_applies_goal(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    cmd = CompanyUpdateCommand(
        company_profile_id=company.company_profile_id, goal="shipped mission"
    )
    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    assert store.get_company_profile(company.company_profile_id).goal == "shipped mission"


# --- HIGH approval grant re-checks lifecycle (TOCTOU) ----------------------


def test_archive_grant_proceeds_on_frozen_company(store):
    # Two-phase archive: the request FROZE the company; the grant must apply the
    # archive ON that frozen company (the generic active-only lifecycle re-check
    # is deliberately bypassed for the archive's OWN target — refusing a frozen
    # company would make archive impossible). End state: DISSOLVED + approved.
    company = _company(store)
    scope = _scope(company.company_profile_id)
    cmd = CompanyArchiveCommand(company_profile_id=company.company_profile_id)
    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="op_1"
    )
    assert result.outcome == "pending_approval"
    approval_id = result.detail["approval_id"]
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.FROZEN.value
    )

    approval, _ = team_kernel.decide_approval(store, approval_id, approved=True)

    assert approval.status == ApprovalStatus.APPROVED.value
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.DISSOLVED.value
    )


# --- LOW assign path (exercises kernel dispatch end to end) ----------------


def test_low_assign_minimal_in_company_agent_executes(store):
    company = _company(store)
    cid = company.company_profile_id
    # Operator scope: assign to any in-company agent is LOW for the operator (a
    # confined agent is subtree-gated separately — see test_company_autonomy.py).
    scope = _scope(cid, is_admin=True)
    # A minimal in-company agent + a backlog issue in the same company.
    agent = AgentProfile(name="Worker", role="dev", company_profile_id=cid)
    store.save_agent_profile(agent)
    issue = store.save_issue(Issue(title="task", company_profile_id=cid))

    cmd = AssignIssueCommand(issue_id=issue.issue_id, profile_id=agent.profile_id)
    result = execute_company_command(
        cmd,
        scope=scope,
        store=store,
        requested_by="op_1",
        equipment_resolver=_no_equipment,
    )

    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    reloaded = store.get_issue(issue.issue_id)
    assert reloaded.assignee_agent_profile_id == agent.profile_id


# --- _scope_from_dict: strict fail-closed deserialization ------------------


def test_scope_from_dict_rejects_string_is_admin():
    # bool("false") is True — a tampered string must NOT flip the actor to admin.
    scope = _scope_from_dict(
        {
            "principal_id": "op",
            "actor_company_id": "A",
            "allowed_company_ids": ["A"],
            "is_admin": "false",
        }
    )
    assert scope.is_admin is False
    # Likewise "true" / 1 are not the strict boolean True.
    assert _scope_from_dict({"is_admin": "true"}).is_admin is False
    assert _scope_from_dict({"is_admin": 1}).is_admin is False
    # Only the real boolean True is admin.
    assert _scope_from_dict({"is_admin": True}).is_admin is True


def test_scope_from_dict_malformed_allowed_degrades_to_home_only():
    # A non-list allow-set, or one with non-str/blank elements, degrades to the
    # actor's home company only (via CompanyScope.__post_init__).
    for bad in ([123], "x", None, ["", 5, None]):
        scope = _scope_from_dict(
            {"actor_company_id": "home", "allowed_company_ids": bad}
        )
        assert scope.allowed_company_ids == frozenset({"home"})
    # A well-formed allow-set is preserved (plus the always-folded home company).
    scope = _scope_from_dict(
        {"actor_company_id": "home", "allowed_company_ids": ["home", "B"]}
    )
    assert scope.allowed_company_ids == frozenset({"home", "B"})


# --- active gate checks the ENTITY's real company, not the home company -----


def test_assign_against_frozen_foreign_company_is_refused(store):
    # Admin scope spanning A (home, active) + B (frozen). An assign whose issue +
    # assignee live in the FROZEN company B must be refused even though A is active.
    _company(store, name="A", status=CompanyStatus.ACTIVE.value)
    company_b = CompanyProfile(name="B", status=CompanyStatus.FROZEN.value)
    store.save_company_profile(company_b)
    bid = company_b.company_profile_id
    scope = CompanyScope(
        principal_id="admin",
        actor_company_id="A_home",
        allowed_company_ids=frozenset({"A_home", bid}),
        is_admin=True,
    )
    agent = AgentProfile(name="W", role="dev", company_profile_id=bid)
    store.save_agent_profile(agent)
    issue = store.save_issue(Issue(title="t", company_profile_id=bid))

    cmd = AssignIssueCommand(issue_id=issue.issue_id, profile_id=agent.profile_id)
    with pytest.raises(CompanyFrozenError):
        execute_company_command(
            cmd,
            scope=scope,
            store=store,
            requested_by="admin",
            equipment_resolver=_no_equipment,
        )


def test_update_agent_in_frozen_foreign_company_is_refused(store):
    company_b = CompanyProfile(name="B", status=CompanyStatus.FROZEN.value)
    store.save_company_profile(company_b)
    bid = company_b.company_profile_id
    scope = CompanyScope(
        principal_id="admin",
        actor_company_id="A_home",
        allowed_company_ids=frozenset({"A_home", bid}),
        is_admin=True,
    )
    agent = AgentProfile(name="W", role="dev", company_profile_id=bid)
    store.save_agent_profile(agent)

    cmd = UpdateAgentCommand(profile_id=agent.profile_id, patch={"title": "Lead"})
    with pytest.raises(CompanyFrozenError):
        execute_company_command(
            cmd, scope=scope, store=store, requested_by="admin"
        )


def test_assign_against_active_foreign_company_passes(store):
    # Same admin/cross-company shape, but B is ACTIVE — the active gate must NOT
    # block it. Assignment is a reversible operation -> LOW under the re-ratified
    # threat model, so it executes straight through; the point here is the
    # lifecycle gate lets B through.
    company_b = CompanyProfile(name="B", status=CompanyStatus.ACTIVE.value)
    store.save_company_profile(company_b)
    bid = company_b.company_profile_id
    scope = CompanyScope(
        principal_id="admin",
        actor_company_id="A_home",
        allowed_company_ids=frozenset({"A_home", bid}),
        is_admin=True,
    )
    agent = AgentProfile(name="W", role="dev", company_profile_id=bid)
    store.save_agent_profile(agent)
    issue = store.save_issue(Issue(title="t", company_profile_id=bid))

    cmd = AssignIssueCommand(issue_id=issue.issue_id, profile_id=agent.profile_id)
    result = execute_company_command(
        cmd,
        scope=scope,
        store=store,
        requested_by="admin",
        equipment_resolver=_no_equipment,
    )
    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    assert store.get_issue(issue.issue_id).assignee_agent_profile_id == agent.profile_id


def test_create_issue_with_workspace_lands_in_workspace_company(store):
    # CreateIssue naming a workspace in company B (admin scope) must write the
    # issue's company_profile_id == B (the workspace's company), NOT the home A.
    company_b = CompanyProfile(name="B", status=CompanyStatus.ACTIVE.value)
    store.save_company_profile(company_b)
    bid = company_b.company_profile_id
    ws = WorkspaceProfile(name="ws-b", company_profile_id=bid)
    store.save_workspace_profile(ws)
    scope = CompanyScope(
        principal_id="admin",
        actor_company_id="A_home",
        allowed_company_ids=frozenset({"A_home", bid}),
        is_admin=True,
    )

    # CreateIssue is reversible -> LOW now; it executes straight through and the
    # _dispatch path resolves the issue's company from the named workspace.
    cmd = CreateIssueCommand(
        title="cross", kind="delivery", workspace_id=ws.workspace_id
    )
    result = execute_company_command(
        cmd, scope=scope, store=store, requested_by="admin"
    )
    assert result.outcome == "executed"
    assert result.verdict.tier == "low"

    issues = [i for i in store.list_issues(company_profile_id=bid) if i.title == "cross"]
    assert len(issues) == 1
    assert issues[0].company_profile_id == bid
    assert issues[0].workspace_id == ws.workspace_id
