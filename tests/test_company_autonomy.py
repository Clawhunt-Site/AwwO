"""Tests for the autonomous-agent autonomy gates (柱子 1b).

Covers the confinement an AUTONOMOUS agent (``is_admin=False`` + a server-injected
``actor_agent_profile_id``) is held to when it drives company commands through the
SINGLE choke point ``execute_company_command``, vs the trusted operator
(``is_admin=True``) and the unidentified non-admin scope (no agent id):

  * root ``issue_create`` is refused for an agent (must use ``issue_delegate``);
    the operator may still create root issues directly.
  * ``assign``/``delegate`` targets must be the acting agent or in its reports-to
    subtree; a non-report target is refused.
  * ``submit_for_review`` is bound to the issue's live checkout run — a stale /
    foreign ``expected_checkout_run_id`` is refused.
  * fan-out (delegate) is budget-gated up front — a budget-exhausted agent is
    stopped at creation time.
  * a posted comment's author is server-injected from the scope (agent vs user),
    never from the command body.
  * attaching a work product files it under the ISSUE's company.

Uses a real :class:`StateStore` so the gates run against persisted org/budget state.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.company_autonomy import (
    AutonomyGateError,
    is_autonomous_agent,
    is_confined_actor,
)
from superclaw.company_commands import (
    AssignIssueCommand,
    AttachWorkProductCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    SubmitReviewCommand,
    PostIssueCommentCommand,
    UpdateAgentCommand,
)
from superclaw.company_handler import execute_company_command
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    CostEvent,
    Issue,
    WorkspaceProfile,
)
from superclaw.company_scope import CompanyScope
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


_CID = "co_auto"


def _company(store: StateStore) -> CompanyProfile:
    company = CompanyProfile(name="Acme", company_profile_id=_CID)
    store.save_company_profile(company)
    return company


def _agent(store: StateStore, *, name: str, reports_to: str | None = None, **kw) -> AgentProfile:
    profile = AgentProfile(
        name=name, role="dev", company_profile_id=_CID, reports_to=reports_to, **kw
    )
    return store.save_agent_profile(profile)


def _operator_scope() -> CompanyScope:
    return CompanyScope(principal_id="local_user", actor_company_id=_CID, is_admin=True)


def _agent_scope(profile_id: str) -> CompanyScope:
    """A confined autonomous-agent scope (server-injected: is_admin=False + agent id)."""
    return CompanyScope(
        principal_id="local_user",
        actor_company_id=_CID,
        allowed_company_ids=frozenset({_CID}),
        is_admin=False,
        actor_agent_profile_id=profile_id,
    )


def _register_workspace(store: StateStore, workspace_id: str = "local") -> None:
    if workspace_id != "local":
        try:
            store.get_workspace_profile(workspace_id)
        except KeyError:
            store.save_workspace_profile(
                WorkspaceProfile(
                    name=workspace_id, workspace_id=workspace_id, company_profile_id=_CID
                )
            )


# --- is_autonomous_agent: the actor definition ------------------------------


def test_actor_predicates_operator_vs_confined():
    op = _operator_scope()
    agent = _agent_scope("agent_x")
    bare = CompanyScope(principal_id="p", actor_company_id=_CID, is_admin=False)
    blank = CompanyScope(
        principal_id="p", actor_company_id=_CID, is_admin=False, actor_agent_profile_id=""
    )
    # is_confined_actor: EVERYTHING non-admin is confined (incl. unidentified) —
    # confinement never keys off "has an agent id" (that was the fail-open hole).
    assert is_confined_actor(op) is False
    assert is_confined_actor(agent) is True
    assert is_confined_actor(bare) is True
    assert is_confined_actor(blank) is True
    # is_autonomous_agent: stricter — confined AND identified (for attribution).
    assert is_autonomous_agent(op) is False
    assert is_autonomous_agent(agent) is True
    assert is_autonomous_agent(bare) is False
    assert blank.actor_agent_profile_id is None  # blank degrades to None
    assert is_autonomous_agent(blank) is False


# --- root issue_create gate -------------------------------------------------


def test_agent_root_issue_create_is_gated(store):
    _company(store)
    ceo = _agent(store, name="CEO")
    cmd = CreateIssueCommand(title="ship feature")
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            cmd, scope=_agent_scope(ceo.profile_id), store=store, requested_by="local_user"
        )
    assert "issue_delegate" in str(exc.value)


def test_operator_root_issue_create_is_direct(store):
    _company(store)
    result = execute_company_command(
        CreateIssueCommand(title="ship feature"),
        scope=_operator_scope(),
        store=store,
        requested_by="local_user",
    )
    assert result.outcome == "executed"
    assert result.verdict.tier == "low"
    assert store.get_issue(result.detail["issue_id"]).title == "ship feature"


def test_unidentified_non_admin_is_confined_fail_closed(store):
    # A non-admin scope WITHOUT a bound agent is STILL confined (fail-closed): it
    # cannot create a root issue. This closes the fail-open hole where a missing
    # agent id silently disabled confinement.
    _company(store)
    scope = CompanyScope(principal_id="p", actor_company_id=_CID, is_admin=False)
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            CreateIssueCommand(title="ok"), scope=scope, store=store, requested_by="p"
        )


def test_unidentified_non_admin_cannot_assign_fail_closed(store):
    # A confined actor with no bound agent can prove no subtree → assign refused.
    _company(store)
    target = _agent(store, name="Target")
    issue = store.save_issue(Issue(title="t", company_profile_id=_CID))
    scope = CompanyScope(principal_id="p", actor_company_id=_CID, is_admin=False)
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            AssignIssueCommand(issue_id=issue.issue_id, profile_id=target.profile_id),
            scope=scope,
            store=store,
            requested_by="p",
        )
    assert "identified acting agent" in str(exc.value)


# --- assign/delegate org-subtree constraint ---------------------------------


def test_agent_delegate_to_direct_report_ok(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    report = _agent(store, name="Eng", reports_to=ceo.profile_id)
    # A parent issue the CEO already owns (delegation needs an existing parent).
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    cmd = DelegateIssueCommand(
        parent_id=parent.issue_id,
        assignee_agent_profile_id=report.profile_id,
        title="sub task",
    )
    result = execute_company_command(
        cmd, scope=_agent_scope(ceo.profile_id), store=store, requested_by=ceo.profile_id
    )
    assert result.outcome == "executed"
    child = store.get_issue(result.detail["issue_id"])
    assert child.parent_id == parent.issue_id
    assert child.assignee_agent_profile_id == report.profile_id


def test_agent_delegate_to_transitive_report_ok(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    lead = _agent(store, name="Lead", reports_to=ceo.profile_id)
    ic = _agent(store, name="IC", reports_to=lead.profile_id)
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    result = execute_company_command(
        DelegateIssueCommand(
            parent_id=parent.issue_id, assignee_agent_profile_id=ic.profile_id, title="t"
        ),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "executed"


def test_agent_delegate_to_self_ok(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    result = execute_company_command(
        DelegateIssueCommand(
            parent_id=parent.issue_id, assignee_agent_profile_id=ceo.profile_id, title="t"
        ),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "executed"


def test_agent_delegate_to_non_report_rejected(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    peer = _agent(store, name="Peer")  # reports to nobody → not under the CEO
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            DelegateIssueCommand(
                parent_id=parent.issue_id, assignee_agent_profile_id=peer.profile_id, title="t"
            ),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert "subtree" in str(exc.value)
    # Fail-closed: no child issue was created.
    assert [i for i in store.list_issues(company_profile_id=_CID) if i.parent_id] == []


def test_agent_assign_to_non_report_rejected(store):
    _company(store)
    ceo = _agent(store, name="CEO")
    peer = _agent(store, name="Peer")
    # CEO owns the issue (so the owner check passes); the rejection is on the
    # TARGET not being in the CEO's subtree.
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            AssignIssueCommand(issue_id=issue.issue_id, profile_id=peer.profile_id),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert "subtree" in str(exc.value)
    assert store.get_issue(issue.issue_id).assignee_agent_profile_id == ceo.profile_id


def test_agent_reassign_owned_issue_to_direct_report_ok(store):
    _company(store)
    ceo = _agent(store, name="CEO")
    report = _agent(store, name="Eng", reports_to=ceo.profile_id)
    # CEO owns the issue and reassigns it down to a direct report.
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    result = execute_company_command(
        AssignIssueCommand(issue_id=issue.issue_id, profile_id=report.profile_id),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "executed"
    assert store.get_issue(issue.issue_id).assignee_agent_profile_id == report.profile_id


def test_agent_cannot_hijack_unowned_issue_by_assigning_to_self(store):
    # R2 finding: an agent must NOT be able to grab a FOREIGN issue by assigning it
    # to itself (target==self passes the subtree check). The owner check refuses it.
    _company(store)
    ceo = _agent(store, name="CEO")
    intruder = _agent(store, name="Intruder")  # owns nothing, manages nobody
    # The CEO's own issue.
    issue = store.save_issue(
        Issue(title="ceo work", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            AssignIssueCommand(issue_id=issue.issue_id, profile_id=intruder.profile_id),
            scope=_agent_scope(intruder.profile_id),
            store=store,
            requested_by=intruder.profile_id,
        )
    assert "owned by" in str(exc.value)
    # The issue's assignee is unchanged — the hijack was refused.
    assert store.get_issue(issue.issue_id).assignee_agent_profile_id == ceo.profile_id


def test_agent_cannot_assign_unassigned_issue(store):
    # An unassigned issue is owned by nobody → a confined agent cannot claim it
    # (it must come to the agent via delegation, not a self-assign land-grab).
    _company(store)
    ceo = _agent(store, name="CEO")
    issue = store.save_issue(Issue(title="unowned", company_profile_id=_CID))
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            AssignIssueCommand(issue_id=issue.issue_id, profile_id=ceo.profile_id),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert store.get_issue(issue.issue_id).assignee_agent_profile_id is None


def test_operator_assign_to_any_in_company_ok(store):
    # The operator is NOT subtree-confined: it can assign to any in-company agent.
    _company(store)
    peer = _agent(store, name="Peer")
    issue = store.save_issue(Issue(title="task", company_profile_id=_CID))
    result = execute_company_command(
        AssignIssueCommand(issue_id=issue.issue_id, profile_id=peer.profile_id),
        scope=_operator_scope(),
        store=store,
        requested_by="local_user",
    )
    assert result.outcome == "executed"


# --- default-deny: governance/config mutations refused for a confined agent ---


def test_agent_update_agent_refused_default_deny(store):
    # R2 finding (privilege escalation): a confined agent must NOT be able to edit
    # an agent profile (e.g. repoint reports_to to capture the org, or rewrite a
    # senior agent's charter). It is not in the allowed set → default-deny.
    _company(store)
    ceo = _agent(store, name="CEO")
    victim = _agent(store, name="Approver")
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            UpdateAgentCommand(profile_id=victim.profile_id, patch={"reports_to": ceo.profile_id}),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert "default-deny" in str(exc.value)
    # Fail-closed: the victim's reports_to is unchanged.
    assert store.get_agent_profile(victim.profile_id).reports_to is None


def test_agent_company_update_refused_default_deny(store):
    _company(store)
    ceo = _agent(store, name="CEO")
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            CompanyUpdateCommand(company_profile_id=_CID, goal="rewritten by agent"),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert store.get_company_profile(_CID).goal != "rewritten by agent"


def test_agent_company_create_refused_default_deny(store):
    _company(store)
    ceo = _agent(store, name="CEO")
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            CompanyCreateCommand(name="ShadowCo"),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )


def test_operator_update_agent_ok(store):
    # The operator may edit agent profiles directly (LOW, not confined).
    _company(store)
    victim = _agent(store, name="Eng")
    result = execute_company_command(
        UpdateAgentCommand(profile_id=victim.profile_id, patch={"title": "Senior Eng"}),
        scope=_operator_scope(),
        store=store,
        requested_by="local_user",
    )
    assert result.outcome == "executed"
    assert store.get_agent_profile(victim.profile_id).title == "Senior Eng"


def test_agent_hire_passes_through_to_human_approval(store):
    # Hire by a confined agent is NOT refused by the autonomy门 — it is passed
    # through so the risk gate routes it to a PENDING human approval (the agent
    # proposes, a human grants; design §3 柱子 1). No profile is created directly.
    _company(store)
    ceo = _agent(store, name="CEO")
    result = execute_company_command(
        HireAgentCommand(spec={"name": "NewHire", "role": "dev", "company_profile_id": _CID}),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "pending_approval"
    assert result.verdict.tier == "high"


def test_agent_archive_refused_not_even_proposed(store):
    # Archive by a confined agent is REFUSED (default-deny), NOT turned into a
    # pending approval: archive's phase-1 freezes the company the moment the
    # pending approval is saved, so even *proposing* it would DoS the company
    # without a human grant. Archive is operator-only.
    _company(store)
    ceo = _agent(store, name="CEO")
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            CompanyArchiveCommand(company_profile_id=_CID, reason="agent-proposed"),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    # No approval was recorded and the company is NOT frozen (still ACTIVE).
    assert store.list_approvals() == []
    assert store.get_company_profile(_CID).status == "active"


def test_subtree_cycle_in_reports_to_fails_closed(store):
    # A→B→A reports_to cycle must not let the walk loop or falsely match; an actor
    # not actually above the target is refused.
    _company(store)
    a = _agent(store, name="A")
    b = _agent(store, name="B")
    # Build the cycle directly in the store (bypassing the kernel's acyclicity
    # guard) to prove the autonomy walk is itself cycle-safe.
    a.reports_to = b.profile_id
    b.reports_to = a.profile_id
    store.save_agent_profile(a)
    store.save_agent_profile(b)
    # A third agent C reports to nobody; A (in the cycle) is not above C.
    c = _agent(store, name="C")
    issue = store.save_issue(Issue(title="task", company_profile_id=_CID))
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            AssignIssueCommand(issue_id=issue.issue_id, profile_id=c.profile_id),
            scope=_agent_scope(a.profile_id),
            store=store,
            requested_by=a.profile_id,
        )


# --- fan-out budget gate ----------------------------------------------------


def test_agent_delegate_blocked_when_assignee_budget_exhausted(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    # A direct report with a token budget already fully spent.
    report = _agent(store, name="Eng", reports_to=ceo.profile_id, token_budget=100)
    store.record_cost_event(
        CostEvent(idempotency_key="spend", agent_profile_id=report.profile_id, input_tokens=100)
    )
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            DelegateIssueCommand(
                parent_id=parent.issue_id, assignee_agent_profile_id=report.profile_id, title="t"
            ),
            scope=_agent_scope(ceo.profile_id),
            store=store,
            requested_by=ceo.profile_id,
        )
    assert "budget" in str(exc.value)
    # Fail-closed: the delegate did not create a child despite passing the subtree gate.
    assert [i for i in store.list_issues(company_profile_id=_CID) if i.parent_id] == []


def test_agent_delegate_ok_when_assignee_has_budget_remaining(store):
    _company(store)
    _register_workspace(store)
    ceo = _agent(store, name="CEO")
    report = _agent(store, name="Eng", reports_to=ceo.profile_id, token_budget=100)
    store.record_cost_event(
        CostEvent(idempotency_key="spend", agent_profile_id=report.profile_id, input_tokens=10)
    )
    parent = store.save_issue(
        Issue(title="parent", company_profile_id=_CID, assignee_agent_profile_id=ceo.profile_id)
    )
    result = execute_company_command(
        DelegateIssueCommand(
            parent_id=parent.issue_id, assignee_agent_profile_id=report.profile_id, title="t"
        ),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "executed"


# --- submit_for_review: expected_checkout_run_id binding --------------------


def _in_progress_issue(store: StateStore, assignee: AgentProfile, run_id: str) -> Issue:
    _register_workspace(store)
    issue = store.save_issue(
        Issue(title="work", company_profile_id=_CID, assignee_agent_profile_id=assignee.profile_id)
    )
    team_kernel.assign_issue(store, issue.issue_id, assignee.profile_id)
    return team_kernel.checkout_issue(store, issue.issue_id, run_id=run_id)


def test_submit_review_with_matching_run_ok(store):
    _company(store)
    eng = _agent(store, name="Eng")
    issue = _in_progress_issue(store, eng, run_id="run_real")
    result = execute_company_command(
        SubmitReviewCommand(issue_id=issue.issue_id, expected_checkout_run_id="run_real"),
        scope=_agent_scope(eng.profile_id),
        store=store,
        requested_by=eng.profile_id,
    )
    assert result.outcome == "executed"
    assert result.detail["status"] == "in_review"
    assert store.get_issue(issue.issue_id).status == "in_review"


def test_submit_review_with_stale_run_rejected(store):
    _company(store)
    eng = _agent(store, name="Eng")
    issue = _in_progress_issue(store, eng, run_id="run_real")
    # An agent that merely knows the issue_id but passes a foreign/stale run id
    # must NOT be able to submit work it does not own.
    with pytest.raises(ValueError) as exc:
        execute_company_command(
            SubmitReviewCommand(issue_id=issue.issue_id, expected_checkout_run_id="run_stale"),
            scope=_agent_scope(eng.profile_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert "claim changed" in str(exc.value).lower()
    # The issue stays in_progress (not flipped to review).
    assert store.get_issue(issue.issue_id).status == "in_progress"


def test_submit_review_blank_run_id_rejected_at_validation(store):
    # A PROVIDED but blank expected_checkout_run_id is malformed → rejected by
    # stateless validation. (None is allowed: it means "operator force-submit".)
    with pytest.raises(ValueError):
        SubmitReviewCommand(issue_id="i1", expected_checkout_run_id="").validate()
    # None is legal at the model layer (operator path).
    SubmitReviewCommand(issue_id="i1", expected_checkout_run_id=None).validate()


def test_submit_review_agent_without_run_id_rejected(store):
    # A confined agent MUST run-bind: omitting expected_checkout_run_id is refused
    # by the autonomy门 (only the operator may force-submit without one).
    _company(store)
    eng = _agent(store, name="Eng")
    issue = _in_progress_issue(store, eng, run_id="run_real")
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            SubmitReviewCommand(issue_id=issue.issue_id, expected_checkout_run_id=None),
            scope=_agent_scope(eng.profile_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert "expected_checkout_run_id" in str(exc.value)
    assert store.get_issue(issue.issue_id).status == "in_progress"


def test_submit_review_operator_force_submit_without_run_id_ok(store):
    # The operator (trusted) may force-submit without a run id.
    _company(store)
    eng = _agent(store, name="Eng")
    issue = _in_progress_issue(store, eng, run_id="run_real")
    result = execute_company_command(
        SubmitReviewCommand(issue_id=issue.issue_id, expected_checkout_run_id=None),
        scope=_operator_scope(),
        store=store,
        requested_by="local_user",
    )
    assert result.outcome == "executed"
    assert store.get_issue(issue.issue_id).status == "in_review"


def test_submit_review_agent_cannot_submit_unowned_issue(store):
    # An agent that knows another agent's issue_id + run_id still cannot submit it:
    # the owner-bound check refuses it (the run id is not an authorization secret).
    _company(store)
    owner = _agent(store, name="Owner")
    intruder = _agent(store, name="Intruder")  # not above the owner
    issue = _in_progress_issue(store, owner, run_id="run_real")
    with pytest.raises(AutonomyGateError) as exc:
        execute_company_command(
            SubmitReviewCommand(issue_id=issue.issue_id, expected_checkout_run_id="run_real"),
            scope=_agent_scope(intruder.profile_id),
            store=store,
            requested_by=intruder.profile_id,
        )
    assert "owned by" in str(exc.value)
    assert store.get_issue(issue.issue_id).status == "in_progress"


# --- comment author server-injected + ownership -----------------------------


def test_comment_author_is_agent_when_acting_agent(store):
    _company(store)
    eng = _agent(store, name="Eng")
    # The agent owns the issue (assignee) → may comment.
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=eng.profile_id)
    )
    result = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="working on it"),
        scope=_agent_scope(eng.profile_id),
        store=store,
        requested_by=eng.profile_id,
    )
    assert result.outcome == "executed"
    comments = store.list_issue_comments(issue.issue_id)
    assert len(comments) == 1
    assert comments[0].author_type == "agent"
    assert comments[0].author_id == eng.profile_id
    assert comments[0].body == "working on it"


def test_comment_author_is_user_for_operator(store):
    # The operator may comment on any issue (no ownership confinement).
    _company(store)
    issue = store.save_issue(Issue(title="task", company_profile_id=_CID))
    result = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="please update"),
        scope=_operator_scope(),
        store=store,
        requested_by="local_user",
    )
    assert result.outcome == "executed"
    comments = store.list_issue_comments(issue.issue_id)
    assert comments[0].author_type == "user"
    assert comments[0].author_id == "local_user"


def test_comment_on_unowned_issue_rejected(store):
    # A confined agent cannot comment on an issue it does not own (spam guard).
    _company(store)
    eng = _agent(store, name="Eng")
    other = _agent(store, name="Other")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=other.profile_id)
    )
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="spam"),
            scope=_agent_scope(eng.profile_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert store.list_issue_comments(issue.issue_id) == []


def test_comment_on_unassigned_issue_rejected_for_agent(store):
    # An unassigned issue is owned by nobody → a confined agent cannot comment.
    _company(store)
    eng = _agent(store, name="Eng")
    issue = store.save_issue(Issue(title="task", company_profile_id=_CID))
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="hi"),
            scope=_agent_scope(eng.profile_id),
            store=store,
            requested_by=eng.profile_id,
        )


def test_manager_can_comment_on_reports_issue(store):
    # A manager OWNS a report's issue (assignee in its subtree) → may comment.
    _company(store)
    ceo = _agent(store, name="CEO")
    report = _agent(store, name="Eng", reports_to=ceo.profile_id)
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=report.profile_id)
    )
    result = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="how's it going?"),
        scope=_agent_scope(ceo.profile_id),
        store=store,
        requested_by=ceo.profile_id,
    )
    assert result.outcome == "executed"


def test_comment_author_never_taken_from_body(store):
    # The command model has NO author field, so a malicious payload cannot set one;
    # this asserts from_dict rejects an injected author field (fail-closed).
    with pytest.raises((ValueError, TypeError)):
        PostIssueCommentCommand.from_dict(
            {"issue_id": "i1", "body": "x", "author_id": "someone_else"}
        )


def test_comment_non_admin_no_agent_cannot_forge_user_author(store):
    # Defence-in-depth at dispatch: even if the autonomy gate were bypassed, a
    # non-admin scope with no bound agent must NOT post as "user" (impersonation).
    # We exercise the dispatch directly with an unassigned-issue-less path by going
    # through the public entry on an OWNED issue is impossible (no agent), so assert
    # the autonomy gate refuses it first (the real, layered behaviour).
    from superclaw.company_scope import CompanyScopeError

    _company(store)
    eng = _agent(store, name="Eng")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=eng.profile_id)
    )
    scope = CompanyScope(principal_id="local_user", actor_company_id=_CID, is_admin=False)
    with pytest.raises(CompanyScopeError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="forged"),
            scope=scope,
            store=store,
            requested_by="local_user",
        )
    assert store.list_issue_comments(issue.issue_id) == []


# --- run-scoped respond grant (#2) ------------------------------------------


def _respond_scope(
    profile_id: str, respond_issue_id: str, *, run_id: str = "run_respond"
) -> CompanyScope:
    """A confined agent scope carrying a run-scoped respond grant for one issue.

    ``run_id`` keys the single-use consume; it defaults to a fixed value so a
    fresh scope (one per test) consumes a fresh grant. Pass an explicit value to
    simulate the SAME run looping the comment tool (the second call must be
    refused)."""
    return CompanyScope(
        principal_id="local_user",
        actor_company_id=_CID,
        allowed_company_ids=frozenset({_CID}),
        is_admin=False,
        actor_agent_profile_id=profile_id,
        respond_issue_id=respond_issue_id,
        run_id=run_id,
    )


def test_respond_grant_lets_non_owner_comment(store):
    # An agent that does NOT own issueA but carries a run-scoped respond grant for
    # issueA may post a single comment on issueA's thread.
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    result = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="@eng replying"),
        scope=_respond_scope(eng.profile_id, issue.issue_id),
        store=store,
        requested_by=eng.profile_id,
    )
    assert result.outcome == "executed"
    comments = store.list_issue_comments(issue.issue_id)
    assert len(comments) == 1
    # Attribution stays the AGENT (server-injected), never the owner / user.
    assert comments[0].author_type == "agent"
    assert comments[0].author_id == eng.profile_id


def test_respond_grant_for_a_does_not_authorize_b(store):
    # A grant for issueA must NOT authorize a comment on a DIFFERENT issueB the
    # agent does not own (exact-equality, single-issue scope).
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue_a = store.save_issue(
        Issue(title="A", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    issue_b = store.save_issue(
        Issue(title="B", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue_b.issue_id, body="cross-issue"),
            scope=_respond_scope(eng.profile_id, issue_a.issue_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert store.list_issue_comments(issue_b.issue_id) == []


def test_no_respond_grant_still_owner_gated(store):
    # Without a grant, the ordinary ownership gate still rejects a non-owner.
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="spam"),
            scope=_agent_scope(eng.profile_id),  # no respond_issue_id
            store=store,
            requested_by=eng.profile_id,
        )
    assert store.list_issue_comments(issue.issue_id) == []


def test_respond_grant_does_not_widen_attach(store):
    # The grant authorizes ONLY the comment action — AttachWorkProduct on a
    # non-owned issue stays owner-gated even with a respond grant for it.
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            AttachWorkProductCommand(
                issue_id=issue.issue_id,
                type="pull_request",
                title="PR",
                url="http://x/pr/1",
                is_primary=True,
            ),
            scope=_respond_scope(eng.profile_id, issue.issue_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert team_kernel.list_work_products(store, issue.issue_id) == []


def test_respond_grant_blank_degrades_to_none(store):
    # A blank respond grant carries NO authorization (degrades to None), so a
    # non-owner is still rejected — a malformed value can never authorize.
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    scope = CompanyScope(
        principal_id="local_user",
        actor_company_id=_CID,
        allowed_company_ids=frozenset({_CID}),
        is_admin=False,
        actor_agent_profile_id=eng.profile_id,
        respond_issue_id="   ",
    )
    assert scope.respond_issue_id is None
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="x"),
            scope=scope,
            store=store,
            requested_by=eng.profile_id,
        )


def test_respond_grant_is_single_use_per_run(store):
    # SINGLE-USE: a non-owner respond run may comment ONCE on the non-owned
    # issue; a SECOND comment in the SAME run on the SAME issue is refused (the
    # grant was already consumed → falls back to the ownership check).
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    scope = _respond_scope(eng.profile_id, issue.issue_id, run_id="run_one")
    # First comment succeeds (grant consumed).
    first = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="first reply"),
        scope=scope,
        store=store,
        requested_by=eng.profile_id,
    )
    assert first.outcome == "executed"
    # Second comment in the SAME run on the SAME issue is refused — the grant is
    # spent, so the comment falls back to the (failing) ownership check.
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="second reply"),
            scope=scope,
            store=store,
            requested_by=eng.profile_id,
        )
    # Exactly one comment landed — the fan-out is capped.
    assert len(store.list_issue_comments(issue.issue_id)) == 1


def test_respond_grant_without_run_id_falls_back_to_ownership(store):
    # A respond grant whose scope carries NO run_id cannot be consumed (the
    # ledger is keyed by run_id), so a non-owner comment falls back to the
    # ownership check (refused) — fail-closed.
    _company(store)
    eng = _agent(store, name="Eng")
    owner = _agent(store, name="Owner")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=owner.profile_id)
    )
    scope = CompanyScope(
        principal_id="local_user",
        actor_company_id=_CID,
        allowed_company_ids=frozenset({_CID}),
        is_admin=False,
        actor_agent_profile_id=eng.profile_id,
        respond_issue_id=issue.issue_id,
        run_id=None,  # no run binding → grant cannot be consumed
    )
    assert scope.run_id is None
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body="x"),
            scope=scope,
            store=store,
            requested_by=eng.profile_id,
        )
    assert store.list_issue_comments(issue.issue_id) == []


def test_owner_can_comment_multiple_times_unaffected_by_single_use(store):
    # The single-use grant constrains only the NON-owner path. The issue's OWNER
    # may comment many times (even if a grant for this issue exists and is
    # consumed on the first call, subsequent calls pass via ownership).
    _company(store)
    eng = _agent(store, name="Eng")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=eng.profile_id)
    )
    # Owner scope ALSO carrying a respond grant for its own issue (first comment
    # may consume the grant; later comments must still pass via ownership).
    scope = _respond_scope(eng.profile_id, issue.issue_id, run_id="run_owner")
    for body in ("c1", "c2", "c3"):
        result = execute_company_command(
            PostIssueCommentCommand(issue_id=issue.issue_id, body=body),
            scope=scope,
            store=store,
            requested_by=eng.profile_id,
        )
        assert result.outcome == "executed"
    assert len(store.list_issue_comments(issue.issue_id)) == 3


# --- work product attach ----------------------------------------------------


def test_attach_work_product_files_under_issue_company(store):
    _company(store)
    eng = _agent(store, name="Eng")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=eng.profile_id)
    )
    result = execute_company_command(
        AttachWorkProductCommand(
            issue_id=issue.issue_id,
            type="pull_request",
            title="PR #1",
            url="http://x/pr/1",
            is_primary=True,
        ),
        scope=_agent_scope(eng.profile_id),
        store=store,
        requested_by=eng.profile_id,
    )
    assert result.outcome == "executed"
    products = team_kernel.list_work_products(store, issue.issue_id)
    assert len(products) == 1
    assert products[0].company_profile_id == _CID  # company taken from the issue
    assert products[0].type == "pull_request"
    assert products[0].is_primary is True


def test_attach_work_product_on_unowned_issue_rejected(store):
    _company(store)
    eng = _agent(store, name="Eng")
    other = _agent(store, name="Other")
    issue = store.save_issue(
        Issue(title="task", company_profile_id=_CID, assignee_agent_profile_id=other.profile_id)
    )
    with pytest.raises(AutonomyGateError):
        execute_company_command(
            AttachWorkProductCommand(issue_id=issue.issue_id, type="pull_request"),
            scope=_agent_scope(eng.profile_id),
            store=store,
            requested_by=eng.profile_id,
        )
    assert team_kernel.list_work_products(store, issue.issue_id) == []


def test_attach_work_product_unknown_type_rejected(store):
    _company(store)
    issue = store.save_issue(Issue(title="task", company_profile_id=_CID))
    with pytest.raises(ValueError):
        execute_company_command(
            AttachWorkProductCommand(issue_id=issue.issue_id, type="not_a_real_type"),
            scope=_operator_scope(),
            store=store,
            requested_by="local_user",
        )


def test_attach_work_product_non_bool_primary_rejected(store):
    # is_primary must be a real bool — a truthy string must not flip the primary
    # delivery fact (stateless validation, fail-closed).
    with pytest.raises(ValueError):
        AttachWorkProductCommand(issue_id="i1", type="pr", is_primary="yes").validate()
