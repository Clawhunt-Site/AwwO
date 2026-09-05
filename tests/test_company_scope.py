"""Tests for the B8 hard scope门 (``superclaw.company_scope``).

Covers: in-company commands pass; every cross-company variant (company / agent /
workspace / issue / parent) is forbidden; nested-ref same-origin (assign / delegate
mixing companies is forbidden either way); fail-closed on missing store, missing
entity, and malformed (non-string) company ids; admin bypass still proves
existence; explicit multi-company allow-set; and the empty-allow-set normalisation.

See docs/company-chat-management-design.md (contract B8).
"""

import pytest

from superclaw.company_commands import (
    AssignIssueCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    UpdateAgentCommand,
)
from superclaw.company_scope import (
    CompanyScope,
    CompanyScopeError,
    _require_resolved_company,
    assert_command_in_scope,
)
from superclaw.models import AgentProfile, CompanyProfile, Issue, WorkspaceProfile
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


@pytest.fixture
def world(store):
    """Two companies A (the actor's) and B, each with a workspace/agent/issue."""
    company_a = CompanyProfile(name="Acme")
    company_b = CompanyProfile(name="Beta")
    store.save_company_profile(company_a)
    store.save_company_profile(company_b)

    ws_a = WorkspaceProfile(name="ws-a", company_profile_id=company_a.company_profile_id)
    ws_b = WorkspaceProfile(name="ws-b", company_profile_id=company_b.company_profile_id)
    store.save_workspace_profile(ws_a)
    store.save_workspace_profile(ws_b)

    agent_a = AgentProfile(
        name="Eng A",
        role="engineer",
        company_profile_id=company_a.company_profile_id,
        workspace_id=ws_a.workspace_id,
    )
    agent_b = AgentProfile(
        name="Eng B",
        role="engineer",
        company_profile_id=company_b.company_profile_id,
        workspace_id=ws_b.workspace_id,
    )
    store.save_agent_profile(agent_a)
    store.save_agent_profile(agent_b)

    issue_a = Issue(
        title="Issue A",
        company_profile_id=company_a.company_profile_id,
        workspace_id=ws_a.workspace_id,
    )
    issue_b = Issue(
        title="Issue B",
        company_profile_id=company_b.company_profile_id,
        workspace_id=ws_b.workspace_id,
    )
    store.save_issue(issue_a)
    store.save_issue(issue_b)

    return {
        "store": store,
        "company_a": company_a,
        "company_b": company_b,
        "ws_a": ws_a,
        "ws_b": ws_b,
        "agent_a": agent_a,
        "agent_b": agent_b,
        "issue_a": issue_a,
        "issue_b": issue_b,
    }


@pytest.fixture
def scope(world):
    """An ordinary (non-admin) scope for company A only."""
    return CompanyScope(
        principal_id="op-1",
        actor_company_id=world["company_a"].company_profile_id,
    )


# --- CompanyScope construction / permits ----------------------------------


def test_empty_allow_set_includes_actor_company():
    sc = CompanyScope(principal_id="op", actor_company_id="A")
    assert "A" in sc.allowed_company_ids
    assert sc.permits("A") is True


def test_permits_blank_and_none_means_own_company():
    sc = CompanyScope(principal_id="op", actor_company_id="A")
    assert sc.permits(None) is True
    assert sc.permits("") is True


def test_permits_rejects_other_company_and_non_string():
    sc = CompanyScope(principal_id="op", actor_company_id="A")
    assert sc.permits("B") is False
    assert sc.permits(123) is False
    assert sc.permits(["A"]) is False


def test_admin_permits_any_company():
    sc = CompanyScope(principal_id="op", actor_company_id="A", is_admin=True)
    assert sc.permits("B") is True


def test_explicit_allow_set_folds_in_actor():
    sc = CompanyScope(
        principal_id="op", actor_company_id="A", allowed_company_ids=frozenset({"B"})
    )
    assert sc.permits("A") is True
    assert sc.permits("B") is True
    assert sc.permits("C") is False


# --- in-company commands pass (no raise) ----------------------------------


def test_company_create_always_permitted(scope, world):
    # No existing-company target — even with a foreign-looking owner the create
    # itself crosses no company boundary.
    assert_command_in_scope(
        CompanyCreateCommand(name="New", owner_id="someone-else"),
        scope,
        world["store"],
    )


def test_in_company_update_archive(scope, world):
    cid = world["company_a"].company_profile_id
    assert_command_in_scope(CompanyUpdateCommand(company_profile_id=cid, name="x"), scope)
    assert_command_in_scope(CompanyArchiveCommand(company_profile_id=cid), scope)


def test_in_company_update_agent(scope, world):
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id, patch={"title": "Lead"}
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_in_company_hire(scope, world):
    cid = world["company_a"].company_profile_id
    cmd = HireAgentCommand(spec={"name": "n", "role": "r", "company_profile_id": cid})
    assert_command_in_scope(cmd, scope, world["store"])
    # No company in the spec → the actor's home company, in scope.
    cmd2 = HireAgentCommand(spec={"name": "n", "role": "r"})
    assert_command_in_scope(cmd2, scope, world["store"])


def test_in_company_create_issue(scope, world):
    cmd = CreateIssueCommand(title="t", workspace_id=world["ws_a"].workspace_id)
    assert_command_in_scope(cmd, scope, world["store"])
    # No workspace ref → home company, in scope without a store.
    assert_command_in_scope(CreateIssueCommand(title="t"), scope)


def test_in_company_assign(scope, world):
    cmd = AssignIssueCommand(
        issue_id=world["issue_a"].issue_id, profile_id=world["agent_a"].profile_id
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_in_company_delegate(scope, world):
    cmd = DelegateIssueCommand(
        parent_id=world["issue_a"].issue_id,
        assignee_agent_profile_id=world["agent_a"].profile_id,
        title="child",
    )
    assert_command_in_scope(cmd, scope, world["store"])


# --- cross-company variants forbidden -------------------------------------


def test_cross_company_update_forbidden(scope, world):
    cmd = CompanyUpdateCommand(
        company_profile_id=world["company_b"].company_profile_id, name="x"
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope)


def test_cross_company_archive_forbidden(scope, world):
    cmd = CompanyArchiveCommand(company_profile_id=world["company_b"].company_profile_id)
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope)


def test_cross_company_update_agent_forbidden(scope, world):
    cmd = UpdateAgentCommand(profile_id=world["agent_b"].profile_id, patch={"title": "x"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_cross_company_hire_forbidden(scope, world):
    cmd = HireAgentCommand(
        spec={
            "name": "n",
            "role": "r",
            "company_profile_id": world["company_b"].company_profile_id,
        }
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_cross_company_create_issue_workspace_forbidden(scope, world):
    cmd = CreateIssueCommand(title="t", workspace_id=world["ws_b"].workspace_id)
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_cross_company_assign_issue_forbidden(scope, world):
    # Both issue and assignee live in B.
    cmd = AssignIssueCommand(
        issue_id=world["issue_b"].issue_id, profile_id=world["agent_b"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_cross_company_delegate_parent_forbidden(scope, world):
    cmd = DelegateIssueCommand(
        parent_id=world["issue_b"].issue_id,
        assignee_agent_profile_id=world["agent_a"].profile_id,
        title="child",
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


# --- nested-ref same-origin (mixed companies) -----------------------------


def test_assign_issue_in_a_assignee_in_b_forbidden(scope, world):
    cmd = AssignIssueCommand(
        issue_id=world["issue_a"].issue_id, profile_id=world["agent_b"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_assign_issue_in_b_assignee_in_a_forbidden(scope, world):
    cmd = AssignIssueCommand(
        issue_id=world["issue_b"].issue_id, profile_id=world["agent_a"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_delegate_parent_in_a_assignee_in_b_forbidden(scope, world):
    cmd = DelegateIssueCommand(
        parent_id=world["issue_a"].issue_id,
        assignee_agent_profile_id=world["agent_b"].profile_id,
        title="child",
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


# --- fail-closed: missing store / missing entity / dirty data -------------


def test_store_none_when_resolution_needed_forbidden(scope, world):
    # UpdateAgent needs the store to resolve the agent's company.
    cmd = UpdateAgentCommand(profile_id=world["agent_a"].profile_id, patch={"title": "x"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, None)


def test_unknown_agent_forbidden(scope, world):
    cmd = UpdateAgentCommand(profile_id="does-not-exist", patch={"title": "x"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_unknown_issue_forbidden(scope, world):
    cmd = AssignIssueCommand(
        issue_id="nope", profile_id=world["agent_a"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_dirty_non_string_company_id_forbidden(scope, world):
    cmd = CompanyUpdateCommand(company_profile_id=123, name="x")  # type: ignore[arg-type]
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope)


def test_dirty_non_string_hire_company_id_forbidden(scope, world):
    cmd = HireAgentCommand(spec={"name": "n", "role": "r", "company_profile_id": 123})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_scope_error_carries_target(scope, world):
    cid = world["company_b"].company_profile_id
    with pytest.raises(CompanyScopeError) as excinfo:
        assert_command_in_scope(CompanyUpdateCommand(company_profile_id=cid), scope)
    assert excinfo.value.target_company == cid
    assert excinfo.value.reason


# --- admin bypass still proves existence ----------------------------------


def test_admin_crosses_to_b(world):
    admin = CompanyScope(
        principal_id="root",
        actor_company_id=world["company_a"].company_profile_id,
        is_admin=True,
    )
    cmd = CompanyUpdateCommand(
        company_profile_id=world["company_b"].company_profile_id, name="x"
    )
    assert_command_in_scope(cmd, admin)  # no raise


def test_admin_still_forbids_unknown_agent(world):
    admin = CompanyScope(
        principal_id="root",
        actor_company_id=world["company_a"].company_profile_id,
        is_admin=True,
    )
    cmd = UpdateAgentCommand(profile_id="ghost", patch={"title": "x"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin, world["store"])


# --- explicit multi-company allow-set -------------------------------------


def test_allowed_set_a_plus_b_crosses_to_b_but_not_c(world):
    sc = CompanyScope(
        principal_id="op",
        actor_company_id=world["company_a"].company_profile_id,
        allowed_company_ids=frozenset({world["company_b"].company_profile_id}),
    )
    # B is now in scope.
    assert_command_in_scope(
        CompanyUpdateCommand(
            company_profile_id=world["company_b"].company_profile_id, name="x"
        ),
        sc,
    )
    # A third company C is still forbidden.
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(
            CompanyUpdateCommand(company_profile_id="company-c", name="x"), sc
        )


# --- default-deny unknown command -----------------------------------------


def test_unknown_command_forbidden(scope):
    class Bogus:
        pass

    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(Bogus(), scope)


# --- nested ref: Hire spec.workspace_id (fix 1) ---------------------------


def test_hire_with_own_workspace_passes(scope, world):
    cmd = HireAgentCommand(
        spec={"name": "n", "role": "r", "workspace_id": world["ws_a"].workspace_id}
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_hire_with_foreign_workspace_forbidden(scope, world):
    cmd = HireAgentCommand(
        spec={"name": "n", "role": "r", "workspace_id": world["ws_b"].workspace_id}
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_hire_with_workspace_store_none_forbidden(scope, world):
    cmd = HireAgentCommand(
        spec={"name": "n", "role": "r", "workspace_id": world["ws_a"].workspace_id}
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, None)


def test_hire_with_own_manager_passes(scope, world):
    manager = AgentProfile(
        name="Mgr", role="lead", company_profile_id=world["company_a"].company_profile_id
    )
    world["store"].save_agent_profile(manager)
    cmd = HireAgentCommand(spec={"name": "n", "role": "r", "reports_to": manager.profile_id})
    assert_command_in_scope(cmd, scope, world["store"])


def test_hire_with_foreign_manager_forbidden(scope, world):
    # _HIRE_SPEC_FIELDS permits reports_to; a hire pinning a foreign manager must
    # be forbidden at creation, not slip a cross-company reporting line in.
    cmd = HireAgentCommand(
        spec={"name": "n", "role": "r", "reports_to": world["agent_b"].profile_id}
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_hire_with_manager_store_none_forbidden(scope, world):
    cmd = HireAgentCommand(spec={"name": "n", "role": "r", "reports_to": "anybody"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, None)


# --- nested ref: CreateIssue assignee (fix 2, most dangerous) --------------


def test_create_issue_with_own_assignee_passes(scope, world):
    cmd = CreateIssueCommand(
        title="t", assignee_agent_profile_id=world["agent_a"].profile_id
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_create_issue_no_assignee_passes(scope, world):
    # No assignee, no workspace → home company, no store needed.
    assert_command_in_scope(CreateIssueCommand(title="t"), scope)


def test_create_issue_with_foreign_assignee_forbidden(scope, world):
    cmd = CreateIssueCommand(
        title="t", assignee_agent_profile_id=world["agent_b"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_create_issue_assignee_store_none_forbidden(scope, world):
    cmd = CreateIssueCommand(
        title="t", assignee_agent_profile_id=world["agent_a"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, None)


# --- nested ref: UpdateAgent patch refs (fix 3) ---------------------------


def test_update_agent_patch_reports_to_same_company_passes(scope, world):
    # A second in-company agent acts as the new manager.
    manager = AgentProfile(
        name="Mgr A",
        role="manager",
        company_profile_id=world["company_a"].company_profile_id,
        workspace_id=world["ws_a"].workspace_id,
    )
    world["store"].save_agent_profile(manager)
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id,
        patch={"reports_to": manager.profile_id},
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_update_agent_patch_reports_to_foreign_forbidden(scope, world):
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id,
        patch={"reports_to": world["agent_b"].profile_id},
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_update_agent_non_dict_patch_forbidden(scope, world):
    # Dirty-data fail-closed: the scope gate refuses a malformed (non-dict) patch
    # itself rather than coercing it to {} (workspace_id is NOT an editable field
    # per EDITABLE_PROFILE_FIELDS, so it is deliberately not scope-checked).
    cmd = UpdateAgentCommand(profile_id=world["agent_a"].profile_id, patch={"title": "X"})
    object.__setattr__(cmd, "patch", "not-a-dict")
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


def test_update_agent_patch_scalar_only_passes(scope, world):
    # A patch with no entity ref needs only the target-agent resolution.
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id, patch={"title": "X"}
    )
    assert_command_in_scope(cmd, scope, world["store"])


def test_update_agent_patch_ref_store_none_forbidden(scope, world):
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id,
        patch={"reports_to": "anybody"},
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, None)


def test_admin_still_rejects_non_string_company_id(world):
    # An admin may target any *valid* company, but a non-str (malformed) id is
    # unverifiable and must fail closed even for admin — the type check precedes
    # the admin short-circuit in permits().
    admin = CompanyScope(
        principal_id="op",
        actor_company_id=world["company_a"].company_profile_id,
        is_admin=True,
    )
    cmd = CompanyUpdateCommand(company_profile_id=123)  # type: ignore[arg-type]
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin, world["store"])


def test_hire_non_dict_spec_forbidden(scope, world):
    # Dirty-data fail-closed: a non-dict spec is refused by the gate itself, not
    # coerced to {} and waved through to the home company.
    cmd = HireAgentCommand(spec={"name": "n", "role": "r"})
    object.__setattr__(cmd, "spec", "not-a-dict")
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, world["store"])


# --------------------------------------------------------------------------- #
# contract B8 same-origin: under admin / multi-company scope, related refs     #
# must share a company even when each is individually permitted.              #
# --------------------------------------------------------------------------- #


@pytest.fixture
def admin_scope(world):
    # An admin permits BOTH companies individually — so only the same-origin
    # check (not the in-scope check) can stop a cross-company pairing.
    return CompanyScope(
        principal_id="root",
        actor_company_id=world["company_a"].company_profile_id,
        is_admin=True,
    )


def test_admin_assign_cross_origin_issue_a_assignee_b_forbidden(admin_scope, world):
    cmd = AssignIssueCommand(
        issue_id=world["issue_a"].issue_id, profile_id=world["agent_b"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_admin_assign_same_origin_both_b_passes(admin_scope, world):
    cmd = AssignIssueCommand(
        issue_id=world["issue_b"].issue_id, profile_id=world["agent_b"].profile_id
    )
    assert_command_in_scope(cmd, admin_scope, world["store"])


def test_admin_delegate_cross_origin_forbidden(admin_scope, world):
    cmd = DelegateIssueCommand(
        parent_id=world["issue_a"].issue_id,
        assignee_agent_profile_id=world["agent_b"].profile_id,
        title="t",
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_admin_hire_workspace_cross_origin_forbidden(admin_scope, world):
    # Hire into company A but pin company B's workspace: both permitted by admin,
    # but cross-origin -> forbidden.
    cmd = HireAgentCommand(
        spec={
            "name": "n",
            "role": "r",
            "company_profile_id": world["company_a"].company_profile_id,
            "workspace_id": world["ws_b"].workspace_id,
        }
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_admin_create_issue_workspace_a_assignee_b_forbidden(admin_scope, world):
    cmd = CreateIssueCommand(
        title="t",
        workspace_id=world["ws_a"].workspace_id,
        assignee_agent_profile_id=world["agent_b"].profile_id,
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_admin_update_agent_reports_to_cross_origin_forbidden(admin_scope, world):
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id,
        patch={"reports_to": world["agent_b"].profile_id},
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_multi_company_allow_set_cross_origin_assign_forbidden(world):
    # Non-admin but allowed in BOTH A and B: each ref individually in scope, yet
    # issue-A + assignee-B is cross-origin and must be forbidden (same path as
    # the admin case — locks the non-admin multi-company branch too).
    multi = CompanyScope(
        principal_id="op",
        actor_company_id=world["company_a"].company_profile_id,
        allowed_company_ids=frozenset(
            {world["company_a"].company_profile_id, world["company_b"].company_profile_id}
        ),
    )
    cmd = AssignIssueCommand(
        issue_id=world["issue_a"].issue_id, profile_id=world["agent_b"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi, world["store"])


def test_multi_company_allow_set_same_origin_assign_passes(world):
    multi = CompanyScope(
        principal_id="op",
        actor_company_id=world["company_a"].company_profile_id,
        allowed_company_ids=frozenset(
            {world["company_a"].company_profile_id, world["company_b"].company_profile_id}
        ),
    )
    cmd = AssignIssueCommand(
        issue_id=world["issue_b"].issue_id, profile_id=world["agent_b"].profile_id
    )
    assert_command_in_scope(cmd, multi, world["store"])


def test_resolved_entity_with_blank_company_forbidden(scope, store, world):
    # A corrupt persisted agent with a blank company must fail closed — NOT be
    # treated as the actor's home company (which would let two blank entities
    # pass same-origin).
    dirty = AgentProfile(name="dirty", role="r", company_profile_id="")
    store.save_agent_profile(dirty)
    cmd = UpdateAgentCommand(profile_id=dirty.profile_id, patch={"title": "x"})
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, store)


# --------------------------------------------------------------------------- #
# coverage completeness: non-admin multi-company same-origin (all 5 commands)  #
# + resolved-entity dirty-company in all three forms.                          #
# --------------------------------------------------------------------------- #


@pytest.fixture
def multi_scope(world):
    return CompanyScope(
        principal_id="op",
        actor_company_id=world["company_a"].company_profile_id,
        allowed_company_ids=frozenset(
            {world["company_a"].company_profile_id, world["company_b"].company_profile_id}
        ),
    )


def test_multi_hire_workspace_cross_origin_forbidden(multi_scope, world):
    cmd = HireAgentCommand(
        spec={
            "name": "n",
            "role": "r",
            "company_profile_id": world["company_a"].company_profile_id,
            "workspace_id": world["ws_b"].workspace_id,
        }
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi_scope, world["store"])


def test_multi_hire_reports_to_cross_origin_forbidden(multi_scope, world):
    cmd = HireAgentCommand(
        spec={
            "name": "n",
            "role": "r",
            "company_profile_id": world["company_a"].company_profile_id,
            "reports_to": world["agent_b"].profile_id,
        }
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi_scope, world["store"])


def test_admin_hire_reports_to_cross_origin_forbidden(admin_scope, world):
    cmd = HireAgentCommand(
        spec={
            "name": "n",
            "role": "r",
            "company_profile_id": world["company_a"].company_profile_id,
            "reports_to": world["agent_b"].profile_id,
        }
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, admin_scope, world["store"])


def test_multi_create_issue_cross_origin_forbidden(multi_scope, world):
    cmd = CreateIssueCommand(
        title="t",
        workspace_id=world["ws_a"].workspace_id,
        assignee_agent_profile_id=world["agent_b"].profile_id,
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi_scope, world["store"])


def test_multi_update_agent_reports_to_cross_origin_forbidden(multi_scope, world):
    cmd = UpdateAgentCommand(
        profile_id=world["agent_a"].profile_id,
        patch={"reports_to": world["agent_b"].profile_id},
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi_scope, world["store"])


def test_multi_delegate_cross_origin_forbidden(multi_scope, world):
    cmd = DelegateIssueCommand(
        parent_id=world["issue_a"].issue_id,
        assignee_agent_profile_id=world["agent_b"].profile_id,
        title="t",
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, multi_scope, world["store"])


@pytest.mark.parametrize("bad", [None, "", 123, [], {}])
def test_require_resolved_company_rejects_all_dirty_forms(bad):
    # Direct unit cover: None / "" / non-str resolved-entity company all forbidden.
    with pytest.raises(CompanyScopeError):
        _require_resolved_company(bad, label="x", kind="agent")


def test_require_resolved_company_accepts_concrete_str():
    _require_resolved_company("company_x", label="x", kind="agent")  # no raise


def test_resolved_issue_blank_company_forbidden(scope, store, world):
    # Dirty persisted ISSUE (blank company) on Assign must fail closed.
    dirty_issue = Issue(title="dirty", company_profile_id="")
    store.save_issue(dirty_issue)
    cmd = AssignIssueCommand(
        issue_id=dirty_issue.issue_id, profile_id=world["agent_a"].profile_id
    )
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, store)


def test_resolved_workspace_blank_company_forbidden(scope, store):
    # Dirty persisted WORKSPACE (blank company) on CreateIssue must fail closed.
    dirty_ws = WorkspaceProfile(name="dirty", company_profile_id="")
    store.save_workspace_profile(dirty_ws)
    cmd = CreateIssueCommand(title="t", workspace_id=dirty_ws.workspace_id)
    with pytest.raises(CompanyScopeError):
        assert_command_in_scope(cmd, scope, store)
