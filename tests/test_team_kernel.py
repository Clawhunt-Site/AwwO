"""Tests for the Agent Team Kernel: profiles, issues, locks, approvals.

Every feature carries at least one positive and one fail-closed negative test,
per the project's feature-boundary discipline. The security-relevant invariants
(equipment can only narrow the governed projection, checkout locks are atomic,
completion cannot skip the approval gate) all have explicit negative coverage.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw.budget_policy import BudgetGateError
from superclaw.cli import app
from superclaw.models import (
    AgentProfile,
    Approval,
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    CostEvent,
    Issue,
    IssueStatus,
    WorkspaceProfile,
    is_valid_approval_status_transition,
    is_valid_issue_status_transition,
)
from superclaw.state import StateStore
from superclaw import team_kernel


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- equipment narrowing (the plugin security boundary) -------------------


def test_equipment_narrows_allowlist_to_available(store):
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=["a", "b", "c"])
    resolution = team_kernel.resolve_equipment(profile, available_ids=["a", "c", "x"])
    assert resolution.granted == ("a", "c")
    assert resolution.dropped == ("b",)


def test_equipment_never_widens_beyond_projection(store):
    # A profile that asks for a plugin the governed projection withheld must NOT
    # receive it — the allowlist can only ever narrow, never grant.
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=["revoked-tool"])
    resolution = team_kernel.resolve_equipment(profile, available_ids=[])
    assert resolution.granted == ()
    assert resolution.dropped == ("revoked-tool",)


def test_equipment_empty_allowlist_grants_nothing(store):
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=[])
    resolution = team_kernel.resolve_equipment(profile, available_ids=["a", "b"])
    assert resolution.granted == ()
    assert resolution.dropped == ()


# --- skill equipment (same fail-closed gate, separate track) ---------------


def test_skill_equipment_narrows_to_governed_skills(store):
    profile = AgentProfile(name="Eng", role="engineer", skill_allowlist=["s1", "s2"])
    resolution = team_kernel.resolve_equipment(
        profile, available_ids=[], available_skill_ids_override=["s1", "other"]
    )
    assert resolution.skills_granted == ("s1",)
    assert resolution.skills_dropped == ("s2",)
    assert resolution.skills_available == ("s1", "other")


def test_skill_equipment_never_widens_beyond_gate(store):
    # A skill the governance gate withheld must never enter the equipment, even
    # when the profile explicitly asks for it.
    profile = AgentProfile(name="Eng", role="engineer", skill_allowlist=["revoked-skill"])
    resolution = team_kernel.resolve_equipment(
        profile, available_ids=[], available_skill_ids_override=[]
    )
    assert resolution.skills_granted == ()
    assert resolution.skills_dropped == ("revoked-skill",)


def test_skill_equipment_empty_allowlist_skips_enumeration(store):
    # No requested skills → no governed enumeration cost and nothing granted.
    profile = AgentProfile(name="Eng", role="engineer")
    resolution = team_kernel.resolve_equipment(profile, available_ids=["a"])
    assert resolution.skills_granted == ()
    assert resolution.skills_dropped == ()
    assert resolution.skills_available == ()


def test_run_context_carries_model_backend_and_skill_equipment(store):
    ceo = AgentProfile(name="CEO", role="ceo")
    store.save_agent_profile(ceo)
    profile = AgentProfile(
        name="Eng",
        role="engineer",
        backend_policy="codex",
        model="gpt-5.5",
        effort="high",
        plugin_allowlist=["p1", "p2"],
        skill_allowlist=["s1", "s2"],
        reports_to=ceo.profile_id,
        charter="Ship safely.",
    )
    store.save_agent_profile(profile)
    ctx = team_kernel.build_agent_run_context(
        store, profile, available_ids=["p1"], available_skill_ids_override=["s1"]
    )
    assert ctx["backend_policy"] == "codex"
    assert ctx["model"] == "gpt-5.5"
    # effort rides the same identity-bound channel as model (effort_override).
    assert ctx["effort"] == "high"
    assert ctx["equipment"]["granted"] == ["p1"]
    assert ctx["equipment"]["dropped"] == ["p2"]
    assert ctx["equipment"]["skills"]["requested"] == ["s1", "s2"]
    assert ctx["equipment"]["skills"]["granted"] == ["s1"]
    assert ctx["equipment"]["skills"]["dropped"] == ["s2"]
    assert ctx["manager_chain"] == [ceo.profile_id]


def _ctx_with_issue_constraints(store, profile, **kw):
    return team_kernel.build_agent_run_context(
        store, profile,
        available_ids=["p1", "p2", "p3"],
        available_skill_ids_override=["s1", "s2"],
        **kw,
    )


def test_issue_plugin_constraint_narrows_below_agent_grants(store):
    """Per-fire routine context narrows plugins ∩ to a subset; dropped stays
    observable so the prompt and the projection layer agree."""
    profile = AgentProfile(
        name="Eng", role="engineer",
        plugin_allowlist=["p1", "p2", "p3"], skill_allowlist=["s1", "s2"],
    )
    store.save_agent_profile(profile)
    ctx = _ctx_with_issue_constraints(store, profile, issue_plugin_constraint=frozenset({"p1"}))
    assert ctx["equipment"]["granted"] == ["p1"]
    assert set(ctx["equipment"]["dropped"]) == {"p2", "p3"}


def test_issue_plugin_constraint_empty_set_narrows_to_nothing(store):
    """An EXPLICIT empty constraint (routine.context plugin_ids: []) grants zero
    plugins — distinct from None (which would inherit the full set)."""
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=["p1", "p2"])
    store.save_agent_profile(profile)
    empty = _ctx_with_issue_constraints(store, profile, issue_plugin_constraint=frozenset())
    assert empty["equipment"]["granted"] == []
    inherit = _ctx_with_issue_constraints(store, profile, issue_plugin_constraint=None)
    assert inherit["equipment"]["granted"] == ["p1", "p2"]  # None != [] — inherits


def test_issue_constraint_cannot_widen_beyond_agent_grants(store):
    """Fail-closed: naming a plugin/skill the agent was never granted yields
    nothing — the ∩ silently drops it, never an amplification."""
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=["p1"], skill_allowlist=["s1"])
    store.save_agent_profile(profile)
    ctx = _ctx_with_issue_constraints(
        store, profile,
        issue_plugin_constraint=frozenset({"p_unowned"}),
        issue_skill_constraint=frozenset({"s_unowned"}),
    )
    assert ctx["equipment"]["granted"] == []
    assert ctx["equipment"]["skills"]["granted"] == []


def test_issue_skill_constraint_narrows_skills(store):
    profile = AgentProfile(name="Eng", role="engineer", skill_allowlist=["s1", "s2"])
    store.save_agent_profile(profile)
    ctx = _ctx_with_issue_constraints(store, profile, issue_skill_constraint=frozenset({"s2"}))
    assert ctx["equipment"]["skills"]["granted"] == ["s2"]
    assert "s1" in ctx["equipment"]["skills"]["dropped"]


def test_issue_and_parent_constraints_both_apply(store):
    """The per-fire issue constraint and the delegation cap are INDEPENDENT axes;
    both ∩, so the effective grant is the intersection of both."""
    profile = AgentProfile(name="Eng", role="engineer", plugin_allowlist=["p1", "p2", "p3"])
    store.save_agent_profile(profile)
    ctx = _ctx_with_issue_constraints(
        store, profile,
        parent_plugin_constraint=frozenset({"p1", "p2"}),
        issue_plugin_constraint=frozenset({"p2", "p3"}),
    )
    assert ctx["equipment"]["granted"] == ["p2"]  # {p1,p2,p3} ∩ {p1,p2} ∩ {p2,p3}


# --- assignment (single-assignee invariant) -------------------------------


def test_assign_sets_single_assignee_and_promotes_backlog(store):
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer"))
    issue = store.save_issue(Issue(title="build feature"))
    assigned = team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    assert assigned.assignee_agent_profile_id == profile.profile_id
    assert assigned.status == IssueStatus.TODO.value


def test_assign_unknown_profile_fails_closed(store):
    issue = store.save_issue(Issue(title="build feature"))
    with pytest.raises(KeyError):
        team_kernel.assign_issue(store, issue.issue_id, "agent_does_not_exist")


# --- checkout (atomic durable workspace lock) -----------------------------


def _register_workspace(store, workspace_id):
    """Non-local workspaces must be registered first (fail-closed scope)."""
    if workspace_id != "local":
        try:
            store.get_workspace_profile(workspace_id)
        except KeyError:
            store.save_workspace_profile(
                WorkspaceProfile(name=workspace_id, workspace_id=workspace_id)
            )


def _assigned_issue(store, *, workspace="local", title="work"):
    _register_workspace(store, workspace)
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", workspace_id=workspace))
    issue = store.save_issue(Issue(title=title, workspace_id=workspace))
    return team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)


def test_checkout_acquires_lock_and_moves_in_progress(store):
    issue = _assigned_issue(store)
    checked = team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    assert checked.status == IssueStatus.IN_PROGRESS.value
    assert checked.checkout_run_id == "run_one"
    assert checked.execution_run_id == "run_one"
    lock = store.get_workspace_lock("workspace:local")
    assert lock is not None and lock.issue_id == issue.issue_id


def test_checkout_budget_preflight_allows_governed_agent_with_remaining_budget(store):
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", token_budget=100))
    issue = store.save_issue(Issue(title="budgeted work"))
    team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    store.record_cost_event(
        CostEvent(idempotency_key="agent-spend", agent_profile_id=profile.profile_id, input_tokens=99)
    )

    checked = team_kernel.checkout_issue(store, issue.issue_id, run_id="run_budget_ok")

    assert checked.status == IssueStatus.IN_PROGRESS.value
    assert store.get_workspace_lock("workspace:local") is not None


def test_checkout_budget_preflight_blocks_exceeded_governed_agent_before_lock_or_status(store):
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", token_budget=100))
    issue = store.save_issue(Issue(title="blocked work"))
    team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    store.record_cost_event(
        CostEvent(idempotency_key="agent-spend", agent_profile_id=profile.profile_id, input_tokens=100)
    )

    with pytest.raises(BudgetGateError) as excinfo:
        team_kernel.checkout_issue(store, issue.issue_id, run_id="run_budget_blocked")

    assert excinfo.value.preflight.to_dict()["reason_code"] == "budget_limit_exceeded"
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value
    assert store.get_issue(issue.issue_id).checkout_run_id is None
    assert store.get_workspace_lock("workspace:local") is None


def test_checkout_budget_preflight_does_not_block_report_only_issue_scope(store):
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer"))
    issue = store.save_issue(
        Issue(
            title="report-only work",
            metadata={
                "budget_policy": {
                    "cost_governed": False,
                    "hard_limits": {"token_budget": 1},
                }
            },
        )
    )
    team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    store.record_cost_event(CostEvent(idempotency_key="issue-spend", issue_id=issue.issue_id, input_tokens=10))

    checked = team_kernel.checkout_issue(store, issue.issue_id, run_id="run_report_only")

    assert checked.status == IssueStatus.IN_PROGRESS.value


def test_double_checkout_same_workspace_fails_closed(store):
    first = _assigned_issue(store, workspace="repoA", title="first")
    team_kernel.checkout_issue(store, first.issue_id, run_id="run_a")
    second = _assigned_issue(store, workspace="repoA", title="second")
    with pytest.raises(ValueError, match="workspace already locked"):
        team_kernel.checkout_issue(store, second.issue_id, run_id="run_b")


def test_checkout_without_assignee_fails_closed(store):
    issue = store.save_issue(Issue(title="unassigned"))
    with pytest.raises(ValueError, match="no assignee"):
        team_kernel.checkout_issue(store, issue.issue_id, run_id="run_x")


def test_lock_released_after_completion_allows_next_checkout(store):
    first = _assigned_issue(store, workspace="repoB", title="first")
    team_kernel.checkout_issue(store, first.issue_id, run_id="run_a")
    _, approval = team_kernel.submit_for_review(store, first.issue_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_workspace_lock("workspace:repoB") is None
    # A second issue in the same workspace can now be checked out.
    second = _assigned_issue(store, workspace="repoB", title="second")
    checked = team_kernel.checkout_issue(store, second.issue_id, run_id="run_b")
    assert checked.status == IssueStatus.IN_PROGRESS.value


def test_approve_releases_lock_held_by_custom_holder(store):
    """Approve must release the lock by its recorded holder, not the assignee.

    checkout may pin a custom --holder; if approve released by assignee it
    would strand a done issue with a held lock and a forever-pending approval.
    """
    issue = _assigned_issue(store, workspace="repoC")
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_a", holder="ops_supervisor")
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    decided, completed = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert decided.status == ApprovalStatus.APPROVED.value
    assert completed is not None and completed.status == IssueStatus.DONE.value
    assert store.get_workspace_lock("workspace:repoC") is None


def test_approve_leaves_other_issues_lock_alone(store):
    """A done issue must not release a lock now owned by a different issue."""
    issue = _assigned_issue(store, workspace="repoD", title="first")
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_a")
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    # Another issue takes the same workspace lock.
    second = _assigned_issue(store, workspace="repoD", title="second")
    team_kernel.checkout_issue(store, second.issue_id, run_id="run_b")
    lock_before = store.get_workspace_lock("workspace:repoD")
    assert lock_before is not None and lock_before.issue_id == second.issue_id
    # Re-approving is an idempotent self-transition by design; the guard must
    # keep it from releasing the SECOND issue's lock.
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    lock_after = store.get_workspace_lock("workspace:repoD")
    assert lock_after is not None and lock_after.issue_id == second.issue_id


def test_release_lock_conditional_on_issue_id_is_atomic(store):
    """expected_issue_id guards the delete inside the release transaction:
    a lock now owned by a different issue is left untouched (returns None)."""
    store.acquire_workspace_lock(
        "workspace:repoF", workspace_id="repoF", holder="agent_b", issue_id="issue_second"
    )
    # Stale releaser still believes issue_first holds the workspace.
    released = store.release_workspace_lock("workspace:repoF", expected_issue_id="issue_first")
    assert released is None
    still_held = store.get_workspace_lock("workspace:repoF")
    assert still_held is not None and still_held.issue_id == "issue_second"
    # The rightful issue releases it.
    released = store.release_workspace_lock("workspace:repoF", expected_issue_id="issue_second")
    assert released is not None
    assert store.get_workspace_lock("workspace:repoF") is None


def test_reassign_after_checkout_fails_closed(store):
    """In-flight issues cannot swap assignee — the lock/review flow anchors to
    the execution that started it."""
    issue = _assigned_issue(store, workspace="repoE")
    other = store.save_agent_profile(AgentProfile(name="Other", role="engineer"))
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_a")
    with pytest.raises(ValueError, match="cannot be reassigned"):
        team_kernel.assign_issue(store, issue.issue_id, other.profile_id)
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    with pytest.raises(ValueError, match="cannot be reassigned"):
        team_kernel.assign_issue(store, issue.issue_id, other.profile_id)
    # The original flow still completes cleanly.
    _, completed = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert completed is not None and completed.status == IssueStatus.DONE.value
    assert store.get_workspace_lock("workspace:repoE") is None


# --- approval gate (completion cannot skip review) ------------------------


def test_submit_opens_pending_completion_approval(store):
    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    updated, approval = team_kernel.submit_for_review(store, issue.issue_id, summary="done the thing")
    assert updated.status == IssueStatus.IN_REVIEW.value
    assert approval.status == ApprovalStatus.PENDING.value
    assert approval.issue_id == issue.issue_id
    assert approval.resume_action == {"kernel": "issue.complete", "issue_id": issue.issue_id}


def test_grant_completes_issue(store):
    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    decided, completed = team_kernel.decide_approval(store, approval.approval_id, approved=True, decided_by="leon")
    assert decided.status == ApprovalStatus.APPROVED.value
    assert decided.decided_by == "leon"
    assert completed is not None and completed.status == IssueStatus.DONE.value


def test_reject_sends_issue_back_to_in_progress(store):
    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    decided, reverted = team_kernel.decide_approval(store, approval.approval_id, approved=False)
    assert decided.status == ApprovalStatus.REJECTED.value
    assert reverted is not None and reverted.status == IssueStatus.IN_PROGRESS.value


def test_issue_cannot_skip_review_gate_to_done(store):
    # The transition table forbids in_progress -> done; the only route to done is
    # via in_review and an approval. This is the core governance guarantee.
    assert is_valid_issue_status_transition("in_progress", "done") is False
    assert is_valid_issue_status_transition("in_review", "done") is True
    issue = _assigned_issue(store)
    issue = team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    issue.status = IssueStatus.DONE.value
    with pytest.raises(ValueError, match="invalid issue status transition"):
        store.save_issue(issue)


def test_submit_requires_in_progress(store):
    issue = _assigned_issue(store)  # still in todo, never checked out
    with pytest.raises(ValueError, match="must be in_progress"):
        team_kernel.submit_for_review(store, issue.issue_id)


def test_approval_cannot_be_redecided(store):
    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    _, approval = team_kernel.submit_for_review(store, issue.issue_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    with pytest.raises(ValueError):
        team_kernel.decide_approval(store, approval.approval_id, approved=False)


def test_approval_transition_table_is_fail_closed():
    assert is_valid_approval_status_transition("pending", "approved") is True
    assert is_valid_approval_status_transition("approved", "rejected") is False
    assert is_valid_approval_status_transition("rejected", "approved") is False


# --- read models (surface contracts) --------------------------------------


def test_team_inventory_rolls_up_status_and_approvals(store):
    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    team_kernel.submit_for_review(store, issue.issue_id)
    inventory = team_kernel.team_inventory(store)
    assert inventory["issue_total"] == 1
    assert inventory["issue_status_counts"].get("in_review") == 1
    assert inventory["open_approval_count"] == 1
    assert len(inventory["agents"]) == 1


def test_ui_contract_payloads_are_pure_projections(store):
    from superclaw.ui_contracts import (
        build_approval_queue_payload,
        build_team_inventory_payload,
        build_workspace_locks_payload,
    )

    issue = _assigned_issue(store)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_one")
    team_kernel.submit_for_review(store, issue.issue_id)

    locks = build_workspace_locks_payload(store)
    assert locks["count"] == 1
    queue = build_approval_queue_payload(store)
    assert queue["count"] == 1 and queue["status_filter"] == "pending"
    team = build_team_inventory_payload(store)
    assert team["issue_total"] == 1


# --- CLI face (the single source of truth surfaces must call) -------------


def test_cli_issue_lifecycle_happy_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    created = runner.invoke(app, ["agent", "create-profile", "Eng", "engineer"])
    assert created.exit_code == 0, created.output
    profile_id = json.loads(created.output)["profile"]["profile_id"]

    issue_out = runner.invoke(app, ["issue", "create", "Ship login"])
    assert issue_out.exit_code == 0, issue_out.output
    issue_id = json.loads(issue_out.output)["issue_id"]

    assert runner.invoke(app, ["issue", "assign", issue_id, profile_id]).exit_code == 0
    assert runner.invoke(app, ["issue", "checkout", issue_id]).exit_code == 0

    submitted = runner.invoke(app, ["issue", "submit", issue_id, "--summary", "ready"])
    assert submitted.exit_code == 0, submitted.output
    approval_id = json.loads(submitted.output)["approval"]["approval_id"]

    granted = runner.invoke(app, ["approve", "grant", approval_id])
    assert granted.exit_code == 0, granted.output
    assert json.loads(granted.output)["issue"]["status"] == "done"


def test_cli_issue_tree_control(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    pid = json.loads(runner.invoke(app, ["agent", "create-profile", "Eng", "engineer"]).output)["profile"]["profile_id"]
    root = json.loads(runner.invoke(app, ["issue", "create", "root"]).output)["issue_id"]
    runner.invoke(app, ["issue", "assign", root, pid])
    c1 = json.loads(runner.invoke(app, ["issue", "delegate", root, pid, "--title", "c1"]).output)["issue_id"]

    # hold blocks checkout; unhold restores it.
    assert runner.invoke(app, ["issue", "hold", root, "--reason", "wait"]).exit_code == 0
    assert runner.invoke(app, ["issue", "checkout", root]).exit_code != 0
    assert runner.invoke(app, ["issue", "unhold", root]).exit_code == 0

    preview = json.loads(runner.invoke(app, ["issue", "tree", root]).output)
    assert preview["count"] == 2

    paused = json.loads(runner.invoke(app, ["issue", "pause-tree", root]).output)
    assert set(paused["paused"]) == {root, c1}
    resumed = json.loads(runner.invoke(app, ["issue", "resume-tree", root]).output)
    assert set(resumed["released"]) == {root, c1}
    cancelled = json.loads(runner.invoke(app, ["issue", "cancel-tree", root]).output)
    assert set(cancelled["cancelled"]) == {root, c1}


def test_cli_double_checkout_exits_nonzero(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    profile_id = json.loads(
        runner.invoke(app, ["agent", "create-profile", "Eng", "engineer"]).output
    )["profile"]["profile_id"]

    def _new_checked_out_issue(title):
        iid = json.loads(runner.invoke(app, ["issue", "create", title]).output)["issue_id"]
        runner.invoke(app, ["issue", "assign", iid, profile_id])
        return iid

    first = _new_checked_out_issue("first")
    assert runner.invoke(app, ["issue", "checkout", first]).exit_code == 0
    second = _new_checked_out_issue("second")
    result = runner.invoke(app, ["issue", "checkout", second])
    assert result.exit_code == 1
    assert "workspace already locked" in result.output


# --- reports_to governance at the save choke point (CLI + API, create + update) ---


def test_save_agent_profile_rejects_self_report(store):
    a = store.save_agent_profile(AgentProfile(name="Eng", role="engineer"))
    a.reports_to = a.profile_id
    with pytest.raises(ValueError, match="cannot report to itself"):
        store.save_agent_profile(a)


def test_save_agent_profile_allows_dangling_manager_ref(store):
    # A manager that does not exist yet is permitted (matches creation semantics);
    # this is how a forward reference / import-before-manager works.
    profile = AgentProfile(name="Eng", role="engineer", reports_to="agent_does_not_exist")
    saved = store.save_agent_profile(profile)
    assert saved.reports_to == "agent_does_not_exist"


def test_save_agent_profile_rejects_cross_company_manager(store):
    # The blocking gap the hire wizard surfaced: create (not just update) must
    # refuse a reports_to that points across a company boundary.
    co_a = store.save_company_profile(CompanyProfile(name="A"))
    co_b = store.save_company_profile(CompanyProfile(name="B"))
    manager = store.save_agent_profile(
        AgentProfile(name="Boss", role="ceo", company_profile_id=co_a.company_profile_id)
    )
    sub = AgentProfile(
        name="Eng", role="engineer", company_profile_id=co_b.company_profile_id, reports_to=manager.profile_id
    )
    with pytest.raises(ValueError, match="company boundary"):
        store.save_agent_profile(sub)


def test_save_agent_profile_allows_same_company_manager(store):
    co = store.save_company_profile(CompanyProfile(name="A"))
    manager = store.save_agent_profile(
        AgentProfile(name="Boss", role="ceo", company_profile_id=co.company_profile_id)
    )
    sub = store.save_agent_profile(
        AgentProfile(
            name="Eng", role="engineer", company_profile_id=co.company_profile_id, reports_to=manager.profile_id
        )
    )
    assert sub.reports_to == manager.profile_id


# --- request revision (non-terminal third decision + resubmit loop) ---------


def _submitted_approval(store):
    """An issue checked out and submitted for review — yields its pending approval."""
    issue = _assigned_issue(store, workspace="rev", title="ship feature")
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_rev")
    issue2, approval = team_kernel.submit_for_review(store, issue.issue_id)
    assert issue2.status == IssueStatus.IN_REVIEW.value
    assert approval.status == ApprovalStatus.PENDING.value
    return issue2, approval


def test_request_revision_is_non_terminal_and_bounces_issue_back(store):
    _, approval = _submitted_approval(store)
    revised, issue = team_kernel.request_revision(store, approval.approval_id, note="tighten the tests")
    # Non-terminal: the approval is revision_requested (not rejected) and keeps no
    # decided_at, so it can still be approved/rejected later.
    assert revised.status == ApprovalStatus.REVISION_REQUESTED.value
    assert revised.decided_at is None
    assert revised.decision_note == "tighten the tests"
    # The issue went back to in_progress for rework.
    assert issue is not None and issue.status == IssueStatus.IN_PROGRESS.value


def test_resubmit_reuses_the_same_revision_requested_approval(store):
    _, approval = _submitted_approval(store)
    team_kernel.request_revision(store, approval.approval_id, note="please revise")
    # The agent reworks and submits again — the SAME approval reopens (one tracked
    # item across the loop), not a duplicate.
    issue3, approval2 = team_kernel.submit_for_review(store, approval.issue_id)
    assert approval2.approval_id == approval.approval_id
    assert approval2.status == ApprovalStatus.PENDING.value
    assert issue3.status == IssueStatus.IN_REVIEW.value
    assert len(store.list_approvals(company_profile_id=None)) == 1


def test_request_revision_on_decided_approval_fails_closed(store):
    _, approval = _submitted_approval(store)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    with pytest.raises(ValueError, match="cannot move"):
        team_kernel.request_revision(store, approval.approval_id, note="too late")


def test_request_revision_only_on_completion_approval(store):
    # A non-completion approval (e.g. a permission grant) has no rework loop and
    # must never enter revision_requested — narrowed in the kernel, not just the UI.
    appr = Approval(type="permission_grant", status=ApprovalStatus.PENDING.value)
    store.save_approval(appr)
    with pytest.raises(ValueError, match="not an issue completion"):
        team_kernel.request_revision(store, appr.approval_id, note="nope")


def test_company_scope_includes_issue_less_approval_via_affects(store):
    # A pending bootstrap approval has no issue yet — it is scoped to its company
    # ONLY through the kernel-set affects.company_profile_id. It must surface in
    # that company's scoped queue (so the Web can re-hydrate the proposal), never
    # in another company's; an approval with NEITHER attribution stays global-only.
    boot = Approval(
        type="permission_grant", status=ApprovalStatus.PENDING.value,
        affects={"company_profile_id": "co_x"}, resume_action={"kernel": "team.bootstrap.commit"},
    )
    other = Approval(type="permission_grant", status=ApprovalStatus.PENDING.value, affects={"company_profile_id": "co_y"})
    floating = Approval(type="permission_grant", status=ApprovalStatus.PENDING.value, affects={})
    for appr in (boot, other, floating):
        store.save_approval(appr)
    scoped_x = {a.approval_id for a in store.list_approvals(company_profile_id="co_x")}
    assert boot.approval_id in scoped_x          # re-hydratable in its own company scope
    assert other.approval_id not in scoped_x     # never leaks across companies
    assert floating.approval_id not in scoped_x  # no issue + no affects-company → global inbox only
    # The unscoped global inbox still shows every pending approval.
    assert len(store.list_approvals(company_profile_id=None)) == 3


def test_issue_linked_approval_scope_ignores_conflicting_affects(store):
    # The issue is the AUTHORITATIVE scope. An issue-linked approval whose issue
    # belongs to co_a must NEVER leak into co_b's scope even if affects was
    # (wrongly/stalely) stamped co_b — otherwise co_b's page would render an
    # actionable grant/reject on another company's approval.
    co_a = store.save_company_profile(CompanyProfile(name="A"))
    co_b = store.save_company_profile(CompanyProfile(name="B"))
    issue = store.save_issue(Issue(title="co_a work", company_profile_id=co_a.company_profile_id))
    appr = Approval(
        type="permission_grant", status=ApprovalStatus.PENDING.value,
        issue_id=issue.issue_id, affects={"company_profile_id": co_b.company_profile_id},
    )
    store.save_approval(appr)
    in_a = {a.approval_id for a in store.list_approvals(company_profile_id=co_a.company_profile_id)}
    in_b = {a.approval_id for a in store.list_approvals(company_profile_id=co_b.company_profile_id)}
    assert appr.approval_id in in_a       # authoritative issue company
    assert appr.approval_id not in in_b   # conflicting affects must not re-route it


def test_request_revision_requires_issue_in_review(store):
    _, approval = _submitted_approval(store)
    team_kernel.request_revision(store, approval.approval_id, note="revise")  # issue -> in_progress now
    # A second revision request finds the issue in_progress (not in_review) and
    # fails closed before writing any thread artifact.
    with pytest.raises(ValueError, match="not in_review"):
        team_kernel.request_revision(store, approval.approval_id, note="again")


def test_submit_cannot_revive_a_terminal_approval(store):
    # Simulates the race Codex flagged: the resubmit reuse picked an approval id
    # that became terminal before the write. The transactional CAS refuses it.
    issue = store.save_issue(Issue(title="x", status=IssueStatus.IN_PROGRESS.value))
    terminal = Approval(
        type=ApprovalType.ISSUE_COMPLETION.value, issue_id=issue.issue_id, status=ApprovalStatus.APPROVED.value
    )
    store.save_approval(terminal)
    revived = Approval(
        approval_id=terminal.approval_id, type=ApprovalType.ISSUE_COMPLETION.value,
        issue_id=issue.issue_id, status=ApprovalStatus.PENDING.value, workspace_id=issue.workspace_id,
    )
    issue.status = IssueStatus.IN_REVIEW.value
    with pytest.raises(ValueError, match="never be revived"):
        store.submit_issue_for_review(issue, revived)


# --- work products (structured delivery ledger on an issue) ------------------


def test_attach_work_product_inherits_issue_scope_and_lists_primary_first(store):
    company = store.save_company_profile(CompanyProfile(name="Acme"))
    issue = store.save_issue(Issue(title="ship login", company_profile_id=company.company_profile_id))
    team_kernel.attach_work_product(store, issue.issue_id, type="commit", title="abc123")
    wp = team_kernel.attach_work_product(
        store, issue.issue_id, type="pull_request", title="PR #1", url="http://x/pr/1", provider="github", is_primary=True
    )
    # Scope comes from the ISSUE, never the caller.
    assert wp.company_profile_id == company.company_profile_id
    products = team_kernel.list_work_products(store, issue.issue_id)
    assert len(products) == 2
    assert products[0].is_primary and products[0].type == "pull_request"  # primary first


def test_only_one_primary_work_product_per_issue(store):
    issue = store.save_issue(Issue(title="x"))
    team_kernel.attach_work_product(store, issue.issue_id, type="preview", title="p1", is_primary=True)
    team_kernel.attach_work_product(store, issue.issue_id, type="deployment", title="d1", is_primary=True)
    products = team_kernel.list_work_products(store, issue.issue_id)
    assert sum(1 for p in products if p.is_primary) == 1  # promoting one demotes the other
    assert products[0].type == "deployment"


def test_attach_work_product_fails_closed_on_unknown_issue_and_type(store):
    with pytest.raises(KeyError):
        team_kernel.attach_work_product(store, "issue_missing", type="commit")
    issue = store.save_issue(Issue(title="x"))
    with pytest.raises(ValueError, match="unknown work product type"):
        team_kernel.attach_work_product(store, issue.issue_id, type="bogus")


def test_update_and_remove_work_product(store):
    issue = store.save_issue(Issue(title="x"))
    wp = team_kernel.attach_work_product(store, issue.issue_id, type="pull_request", title="PR")
    updated = team_kernel.update_work_product(store, wp.work_product_id, status="merged")
    assert updated.status == "merged"
    with pytest.raises(ValueError, match="unknown work product status"):
        team_kernel.update_work_product(store, wp.work_product_id, status="bogus")
    # An update with no fields is rejected in the kernel, so the CLI and API
    # reject it identically (zero divergence).
    with pytest.raises(ValueError, match="no work product fields to update"):
        team_kernel.update_work_product(store, wp.work_product_id)
    assert team_kernel.remove_work_product(store, wp.work_product_id) is True
    assert team_kernel.list_work_products(store, issue.issue_id) == []


def test_list_work_products_fails_closed_on_unknown_issue(store):
    # The read path honours the same scope iron-law as attach: an unknown issue
    # raises rather than returning an empty list for a non-existent/orphan scope.
    with pytest.raises(KeyError):
        team_kernel.list_work_products(store, "issue_missing")


# --- issue tree control: hold ledger + subtree pause/resume/cancel -----------


def _delegation_tree(store):
    """A small delegation tree: root -> (c1 -> gc), c2. All todo + assigned."""
    profile = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", backend_policy="local"))
    root = store.save_issue(
        Issue(
            title="root",
            company_profile_id=profile.company_profile_id,
            workspace_id=profile.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=profile.profile_id,
        )
    )
    c1 = team_kernel.delegate_sub_issue(store, root.issue_id, assignee_agent_profile_id=profile.profile_id, title="c1")
    c2 = team_kernel.delegate_sub_issue(store, root.issue_id, assignee_agent_profile_id=profile.profile_id, title="c2")
    gc = team_kernel.delegate_sub_issue(store, c1.issue_id, assignee_agent_profile_id=profile.profile_id, title="gc")
    return profile, root, c1, c2, gc


def test_hold_and_release_single_issue(store):
    _, root, *_ = _delegation_tree(store)
    hold = team_kernel.hold_issue(store, root.issue_id, reason="wait on design", by="op")
    assert hold.scope == "single" and hold.status == "active"
    assert store.issue_is_held(root.issue_id) is True
    # The hold is a ledger marker, NOT a status change.
    assert store.get_issue(root.issue_id).status == IssueStatus.TODO.value
    released = team_kernel.release_issue_hold(store, root.issue_id, by="op")
    assert released.status == "released" and released.released_by == "op"
    assert store.issue_is_held(root.issue_id) is False


def test_hold_rejects_terminal_and_double(store):
    _, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.hold_issue(store, c1.issue_id)
    with pytest.raises(ValueError, match="already held"):
        team_kernel.hold_issue(store, c1.issue_id)
    # A terminal issue cannot be held.
    team_kernel.cancel_issue_tree(store, c2.issue_id)
    with pytest.raises(ValueError, match="terminal issues cannot be held"):
        team_kernel.hold_issue(store, c2.issue_id)
    # Releasing a non-held issue fails closed.
    with pytest.raises(ValueError, match="no active hold"):
        team_kernel.release_issue_hold(store, root.issue_id)


def test_checkout_refuses_held_issue(store):
    _, root, *_ = _delegation_tree(store)
    team_kernel.hold_issue(store, root.issue_id)
    with pytest.raises(ValueError, match="on hold"):
        team_kernel.checkout_issue(store, root.issue_id, run_id="run_x")


def _active_run_for(store, run_status="created"):
    from superclaw.models import GoalSpec

    goal = store.create_goal(GoalSpec(title="g", description="d"))
    run = store.create_run(goal.goal_id)
    if run_status != "created":
        run.status = run_status
    store.save_run(run)
    return run


def test_pause_tree_holds_subtree_cancels_runs_and_releases_lock(store):
    profile, root, c1, c2, gc = _delegation_tree(store)
    # Put c1 in_progress under a real run + workspace lock.
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    lock_key = team_kernel.issue_release_key(store.get_issue(c1.issue_id), store=store)
    assert store.get_workspace_lock(lock_key) is not None

    cancelled = []
    res = team_kernel.pause_issue_tree(
        store, root.issue_id, by="op", reason="freeze", run_canceller=cancelled.append
    )
    # All 4 live issues held; the active run was cancelled; the lock was freed.
    assert len(res["paused"]) == 4
    assert run.run_id in res["cancelled_runs"] and cancelled == [run.run_id]
    assert all(store.issue_is_held(i) for i in (root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id))
    # in_progress -> todo (a legal transition; the hold marker keeps it parked),
    # lock released so the workspace is free during the pause.
    c1_after = store.get_issue(c1.issue_id)
    assert c1_after.status == IssueStatus.TODO.value and c1_after.lock_key is None
    assert store.get_workspace_lock(lock_key) is None
    # The per-issue holds share one tree operation id.
    holds = store.list_issue_holds(operation_id=res["operation_id"], status="active")
    assert len(holds) == 4 and all(h.scope == "tree" for h in holds)


def test_resume_tree_releases_every_hold(store):
    _, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.pause_issue_tree(store, root.issue_id)
    rr = team_kernel.resume_issue_tree(store, root.issue_id, by="op")
    assert len(rr["released"]) == 4
    assert not any(store.issue_is_held(i) for i in (root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id))


def test_cancel_tree_cancels_subtree_and_active_runs(store):
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)
    cancelled = []
    cr = team_kernel.cancel_issue_tree(store, root.issue_id, by="op", run_canceller=cancelled.append)
    assert len(cr["cancelled"]) == 4 and run.run_id in cr["cancelled_runs"]
    assert all(
        store.get_issue(i).status == IssueStatus.CANCELLED.value
        for i in (root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id)
    )
    # A cancelled subtree has nothing live left to preview.
    assert team_kernel.preview_issue_tree(store, root.issue_id)["count"] == 0


def test_preview_issue_tree_counts_live_work(store):
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)
    team_kernel.hold_issue(store, c2.issue_id)
    preview = team_kernel.preview_issue_tree(store, root.issue_id)
    assert preview["count"] == 4
    assert preview["active_run_count"] == 1
    assert preview["held_count"] == 1
    assert {i["issue_id"] for i in preview["issues"]} == {
        root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id
    }


def test_subtree_walk_is_company_scoped(store):
    # A foreign-company issue that (corruptly) points its parent_id at our root
    # must NOT be swept into the subtree — the walk is company-scoped fail-closed.
    _, root, *_ = _delegation_tree(store)
    other_co = store.save_company_profile(CompanyProfile(name="Other Co"))
    foreign = store.save_issue(
        Issue(
            title="foreign",
            company_profile_id=other_co.company_profile_id,
            parent_id=root.issue_id,
        )
    )
    ids = {i.issue_id for i in team_kernel._issue_subtree(store, store.get_issue(root.issue_id))}
    assert foreign.issue_id not in ids


def test_pause_without_canceller_freezes_active_run_in_place(store):
    # Freeze-first, fail-closed: an issue whose run cannot be stopped (no
    # canceller) is FROZEN in place (held + in_progress) — never re-queued or
    # unlocked while its run executes — and the op neither raises nor partially
    # mutates the rest of the tree. Runless siblings are cleanly re-queued.
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)

    res = team_kernel.pause_issue_tree(store, root.issue_id)  # no run_canceller
    # The WHOLE subtree is frozen (held) — pass 1 holds before pass 2 touches runs.
    assert all(store.issue_is_held(i) for i in (root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id))
    assert c1.issue_id in res["frozen_in_place"]
    # c1's run was NOT stopped → it stays in_progress (lock retained); siblings -> todo.
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert store.get_issue(c2.issue_id).status == IssueStatus.TODO.value

    # cancel without a canceller likewise terminates the runless issues and leaves
    # the uncancellable active-run issue frozen (never force-terminated mid-run).
    cr = team_kernel.cancel_issue_tree(store, root.issue_id)
    assert c1.issue_id in cr["frozen_in_place"]
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert store.get_issue(c2.issue_id).status == IssueStatus.CANCELLED.value


def test_resume_tree_preserves_a_deliberate_single_hold(store):
    # A targeted single-issue hold (e.g. a security freeze) must survive a
    # resume-tree: resume only lifts the tree-scoped holds a pause created.
    _, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.hold_issue(store, c2.issue_id, reason="security freeze")  # scope=single
    team_kernel.pause_issue_tree(store, root.issue_id)  # c2 already held → kept single
    assert store.get_active_issue_hold(c2.issue_id).scope == "single"
    rr = team_kernel.resume_issue_tree(store, root.issue_id)
    assert c2.issue_id not in rr["released"]
    assert store.issue_is_held(c2.issue_id) is True  # the single hold survives
    assert not any(store.issue_is_held(i) for i in (root.issue_id, c1.issue_id, gc.issue_id))


def test_resume_tree_can_narrow_to_one_operation(store):
    _, root, c1, c2, gc = _delegation_tree(store)
    op1 = team_kernel.pause_issue_tree(store, root.issue_id)["operation_id"]
    # Resuming a different operation id releases nothing.
    assert team_kernel.resume_issue_tree(store, root.issue_id, operation_id="other_op")["released"] == []
    assert store.issue_is_held(root.issue_id) is True
    # Resuming the real op releases the whole tree.
    released = team_kernel.resume_issue_tree(store, root.issue_id, operation_id=op1)["released"]
    assert set(released) == {root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id}


def test_delegate_under_held_parent_is_refused(store):
    profile, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.hold_issue(store, c1.issue_id, reason="paused")
    with pytest.raises(team_kernel.IssueHeldError, match="on hold"):
        team_kernel.delegate_sub_issue(store, c1.issue_id, assignee_agent_profile_id=profile.profile_id, title="leak")


def test_submit_for_review_refused_when_held(store):
    # A hold placed after checkout (status stays in_progress, anchor CAS cannot
    # catch it) must still block the issue from advancing to review.
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)
    team_kernel.hold_issue(store, c1.issue_id, reason="freeze mid-run")
    with pytest.raises(team_kernel.IssueHeldError, match="on hold"):
        team_kernel.submit_for_review(store, c1.issue_id, requested_by=profile.profile_id)


def test_submit_transaction_blocks_hold_landing_after_precheck(store):
    # The AUTHORITATIVE gate is inside the submit transaction: a hold present at
    # commit time blocks the in_review flip even if a caller skipped the kernel
    # pre-check. Drive store.submit_issue_for_review directly to prove it.
    from superclaw.models import Approval, ApprovalType

    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    issue = team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)
    team_kernel.hold_issue(store, c1.issue_id, reason="freeze")
    issue.status = IssueStatus.IN_REVIEW.value
    approval = Approval(type=ApprovalType.ISSUE_COMPLETION.value, issue_id=c1.issue_id)
    with pytest.raises(team_kernel.IssueHeldError, match="on hold"):
        store.submit_issue_for_review(issue, approval)
    # Nothing committed: the issue is still in_progress AND no approval row was
    # written (the whole transaction rolled back, not just the issue flip).
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    with pytest.raises(KeyError):
        store.get_approval(approval.approval_id)


def test_save_delegated_child_blocks_hold_landing_after_precheck(store):
    # The atomic delegate gate: save_delegated_child refuses if the parent is
    # held at write time, closing the check->create race.
    profile, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.hold_issue(store, c1.issue_id, reason="freeze")
    orphan = Issue(
        title="leaked child",
        company_profile_id=c1.company_profile_id,
        workspace_id=c1.workspace_id,
        parent_id=c1.issue_id,
        status=IssueStatus.TODO.value,
    )
    with pytest.raises(team_kernel.IssueHeldError, match="on hold"):
        store.save_delegated_child(orphan, parent_id=c1.issue_id)
    with pytest.raises(KeyError):
        store.get_issue(orphan.issue_id)  # never created


def test_save_delegated_child_rejects_post_construction_typed_mutation(store):
    # save_delegated_child writes issues.payload directly, so it must re-run the
    # typed-field gate — a child mutated AFTER construction (bypassing __post_init__)
    # cannot be persisted with an invalid kind/review_policy through this path.
    profile, root, c1, c2, gc = _delegation_tree(store)
    child = Issue(
        title="valid child",
        company_profile_id=c1.company_profile_id,
        workspace_id=c1.workspace_id,
        parent_id=c1.issue_id,
        status=IssueStatus.TODO.value,
    )
    child.kind = "nonsense"  # bypasses construction validation
    with pytest.raises(ValueError, match="invalid issue kind"):
        store.save_delegated_child(child, parent_id=c1.issue_id)
    with pytest.raises(KeyError):
        store.get_issue(child.issue_id)  # never created (rolled back)

    child.kind = "delegation"
    child.review_policy = "whatever"
    with pytest.raises(ValueError, match="invalid review_policy"):
        store.save_delegated_child(child, parent_id=c1.issue_id)

def test_commit_checkout_blocks_hold_landing_after_precheck(store):
    # The checkout↔pause TOCTOU close: the in_progress flip is refused inside its
    # OWN transaction if the issue is held at commit time (not just at pre-check).
    profile, root, c1, c2, gc = _delegation_tree(store)
    team_kernel.hold_issue(store, c1.issue_id, reason="paused mid-checkout")
    issue = store.get_issue(c1.issue_id)
    issue.status = IssueStatus.IN_PROGRESS.value
    issue.checkout_run_id = "run_x"
    issue.execution_run_id = "run_x"
    with pytest.raises(team_kernel.IssueHeldError, match="on hold"):
        store.commit_checkout(issue)
    # The flip never committed — the issue is still todo.
    assert store.get_issue(c1.issue_id).status == IssueStatus.TODO.value


def test_pause_freezes_in_place_when_canceller_raises(store):
    # A canceller that throws must NOT abort the tree op mid-pass (partial
    # mutation); it degrades to "could not stop" → the issue stays frozen.
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)

    def _boom(run_id):
        raise RuntimeError("cancel backend unavailable")

    res = team_kernel.pause_issue_tree(store, root.issue_id, run_canceller=_boom)
    assert c1.issue_id in res["frozen_in_place"]
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    # The rest of the tree was still cleanly frozen — no partial abort.
    assert all(store.issue_is_held(i) for i in (root.issue_id, c1.issue_id, c2.issue_id, gc.issue_id))
    assert store.get_issue(c2.issue_id).status == IssueStatus.TODO.value


def test_cancel_freezes_in_place_when_canceller_raises(store):
    # Same degradation for cancel-tree (shared helper): a throwing canceller
    # leaves the active-run issue frozen, terminates the rest, never aborts.
    profile, root, c1, c2, gc = _delegation_tree(store)
    run = _active_run_for(store)
    team_kernel.checkout_issue(store, c1.issue_id, run_id=run.run_id, holder=profile.profile_id)

    def _boom(run_id):
        raise RuntimeError("cancel backend unavailable")

    cr = team_kernel.cancel_issue_tree(store, root.issue_id, run_canceller=_boom)
    assert c1.issue_id in cr["frozen_in_place"]
    assert store.get_issue(c1.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert store.get_issue(c2.issue_id).status == IssueStatus.CANCELLED.value


def test_granting_agent_requested_hire_does_not_wake_a_hollow_requester(store):
    """PR-5 scope guard: a granted agent-requested hire creates the new agent but
    must NOT enqueue a hollow ON_DEMAND wake for the requester. Resuming the
    requester's *blocked* issue after the grant is the deferred "blocked-dependency
    autonomous resume" follow-up (it needs the requesting run to park the issue +
    an origin-issue continuation link). Faking the wake here — when the requester's
    issue is already in_review/done so the daemon would only idle — is exactly the
    overclaim this PR avoids."""
    company = store.save_company_profile(CompanyProfile(name="Acme"))
    ceo = store.save_agent_profile(
        AgentProfile(name="CEO", role="ceo", company_profile_id=company.company_profile_id)
    )
    approval = team_kernel.request_hire(
        store,
        spec={"name": "Eng", "role": "engineer", "company_profile_id": company.company_profile_id},
        requested_by=ceo.profile_id,
    )
    # Drain the request-time queue so we observe only what the GRANT enqueues.
    while store.claim_next_wakeup() is not None:
        pass
    team_kernel.decide_approval(store, approval.approval_id, approved=True)

    # The grant created the engineer (the hire applied) ...
    assert any(
        p.role == "engineer"
        for p in store.list_agent_profiles(company_profile_id=company.company_profile_id)
    )
    # ... but emitted no hollow continuation wake for the requester.
    assert [
        w
        for w in store.list_wakeups(agent_profile_id=ceo.profile_id, status="queued")
        if w.reason.startswith("approval_granted:")
    ] == []
