"""review_policy completion gate: who may move an issue in_review -> done.

Covers the kernel authorization rules (human universal; agent only for an
authorized parent_accept close bound to the parent's live run), the cross-field
guard (parent_accept / no_completion_gate require a parent), and the
no_completion_gate machine auto-close. The agent-decision path has no surface
caller yet (it lands with the manager loop); these lock the kernel invariants in.
"""

import pytest

from superclaw import team_kernel
from superclaw.models import (
    ApprovalStatus,
    ApprovalType,
    DeciderType,
    Issue,
    IssueStatus,
    ReviewPolicy,
    assert_valid_issue_typed_fields,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _profile(store, name):
    from superclaw.models import AgentProfile

    return store.save_agent_profile(AgentProfile(name=name, role="engineer", backend_policy="local"))


def _live_parent(store, ceo, *, run="run_parent"):
    """A parent issue in_progress and owned by ``run`` (its live checkout)."""
    return store.save_issue(
        Issue(
            title="parent",
            description="x",
            company_profile_id=ceo.company_profile_id,
            workspace_id=ceo.workspace_id,
            status=IssueStatus.IN_PROGRESS.value,
            assignee_agent_profile_id=ceo.profile_id,
            checkout_run_id=run,
            execution_run_id=run,
        )
    )


def _child_in_review(store, parent, eng):
    """A parent_accept child checked out, submitted, now in_review with a pending
    completion approval."""
    child = team_kernel.delegate_sub_issue(
        store, parent.issue_id, assignee_agent_profile_id=eng.profile_id, title="child"
    )
    assert child.review_policy == ReviewPolicy.PARENT_ACCEPT.value
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_child", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    assert approval is not None
    assert store.get_issue(child.issue_id).status == IssueStatus.IN_REVIEW.value
    return child, approval


# --- cross-field guard: human-less policy requires a parent --------------------


def test_parentless_humanless_policy_rejected():
    # The most dangerous bypass: a root/top-level issue configured to skip the
    # human gate. parent_accept / no_completion_gate require a parent.
    for policy in (ReviewPolicy.PARENT_ACCEPT.value, ReviewPolicy.NO_COMPLETION_GATE.value):
        with pytest.raises(ValueError, match="requires a parent"):
            Issue(title="root", review_policy=policy)  # no parent_id
    # human_final / qa_accept stay human-gated, so they are valid with no parent.
    assert Issue(title="root", review_policy=ReviewPolicy.HUMAN_FINAL.value).parent_id is None
    assert Issue(title="bug", review_policy=ReviewPolicy.QA_ACCEPT.value).parent_id is None
    # With a parent the human-less policies are valid.
    assert Issue(title="child", review_policy=ReviewPolicy.PARENT_ACCEPT.value, parent_id="issue_p")
    # The persistence gate enforces it too (post-construction mutation).
    ok = Issue(title="c", review_policy=ReviewPolicy.HUMAN_FINAL.value, parent_id="p")
    ok.review_policy = ReviewPolicy.NO_COMPLETION_GATE.value
    ok.parent_id = None
    with pytest.raises(ValueError, match="requires a parent"):
        assert_valid_issue_typed_fields(ok)


# --- human_final: human only ---------------------------------------------------


def test_human_final_agent_decision_rejected(store):
    eng = _profile(store, "Eng")
    issue = store.save_issue(
        Issue(
            title="root delivery",
            company_profile_id=eng.company_profile_id,
            workspace_id=eng.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=eng.profile_id,
        )
    )
    assert issue.review_policy == ReviewPolicy.HUMAN_FINAL.value
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_e", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, issue.issue_id, requested_by=eng.profile_id)
    # An agent may NOT close a human_final issue (charter cannot mark final done).
    with pytest.raises(ValueError, match="only parent_accept"):
        team_kernel.decide_approval(
            store,
            approval.approval_id,
            approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=eng.profile_id,
            deciding_run_id="run_e",
        )
    # The human gate still works and is the default.
    _, done = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert done.status == IssueStatus.DONE.value


# --- parent_accept: human, or the parent's live-run assignee -------------------


def test_parent_accept_authorized_agent_closes(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    approval2, done = team_kernel.decide_approval(
        store,
        approval.approval_id,
        approved=True,
        decided_by="ceo-run",
        decided_by_type=DeciderType.AGENT.value,
        deciding_agent_profile_id=ceo.profile_id,
        deciding_run_id="run_parent",
    )
    assert done.status == IssueStatus.DONE.value
    # Audit honesty: the decision + thread record it as an agent close, not "user".
    assert approval2.decided_by_type == DeciderType.AGENT.value
    assert approval2.deciding_agent_profile_id == ceo.profile_id
    completion = store.list_issue_interactions(issue_id=child.issue_id, kind="completion")
    assert completion and all(c.created_by_type == "agent" for c in completion)


def test_parent_accept_human_always_allowed(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo)
    _, approval = _child_in_review(store, parent, eng)
    _, done = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert done.status == IssueStatus.DONE.value


def test_parent_accept_rejects_unauthorized_agents(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    other = _profile(store, "Other")
    parent = _live_parent(store, ceo, run="run_parent")

    # child assignee (the worker) is NOT the authority — only the parent is.
    child, approval = _child_in_review(store, parent, eng)
    with pytest.raises(ValueError, match="current assignee"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=eng.profile_id, deciding_run_id="run_parent",
        )
    # a sibling/other agent is not the parent assignee either.
    with pytest.raises(ValueError, match="current assignee"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=other.profile_id, deciding_run_id="run_parent",
        )


def test_parent_accept_rejects_stale_run(store):
    # Zombie-run bypass: the parent assignee is unchanged, but the deciding run is
    # NOT the parent's current checkout — a stale/preempted run cannot authorize.
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    _, approval = _child_in_review(store, parent, eng)
    with pytest.raises(ValueError, match="currently holds the parent's checkout"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=ceo.profile_id, deciding_run_id="run_STALE",
        )


def test_parent_accept_rejects_when_parent_terminal(store):
    # Parent already done -> cannot accept a child. Walk it there along valid
    # edges (in_progress -> in_review -> done) since direct flips are gated.
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    parent.status = IssueStatus.IN_REVIEW.value
    store.save_issue(parent)
    parent.status = IssueStatus.DONE.value
    store.save_issue(parent)
    with pytest.raises(ValueError, match="not in_progress"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=ceo.profile_id, deciding_run_id="run_parent",
        )


def test_parent_accept_rejects_when_parent_held(store):
    # Held parent -> an agent may not advance the child's completion.
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    team_kernel.hold_issue(store, parent.issue_id, reason="freeze")
    with pytest.raises(ValueError, match="on hold"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=ceo.profile_id, deciding_run_id="run_parent",
        )


# --- qa_accept: human-only in this MVP -----------------------------------------


def test_qa_accept_agent_rejected_human_allowed(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    # A qa_accept child (no QA primitive yet -> human-only, fail-closed for agents).
    child = store.save_issue(
        Issue(
            title="qa child",
            company_profile_id=ceo.company_profile_id,
            workspace_id=ceo.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=eng.profile_id,
            parent_id=parent.issue_id,
            review_policy=ReviewPolicy.QA_ACCEPT.value,
        )
    )
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_child", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    with pytest.raises(ValueError, match="only parent_accept"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True,
            decided_by_type=DeciderType.AGENT.value,
            deciding_agent_profile_id=ceo.profile_id, deciding_run_id="run_parent",
        )
    _, done = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert done.status == IssueStatus.DONE.value


# --- no_completion_gate: kernel auto-close, no approval ------------------------


def test_no_completion_gate_auto_closes_without_approval(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child = store.save_issue(
        Issue(
            title="machine sub-work",
            company_profile_id=ceo.company_profile_id,
            workspace_id=ceo.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=eng.profile_id,
            parent_id=parent.issue_id,
            review_policy=ReviewPolicy.NO_COMPLETION_GATE.value,
        )
    )
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_child", holder=eng.profile_id)
    issue, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    # Auto-completed: no approval opened, issue done, no pending completion approval.
    assert approval is None
    assert store.get_issue(child.issue_id).status == IssueStatus.DONE.value
    pending = [
        a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
        if a.issue_id == child.issue_id and a.type == ApprovalType.ISSUE_COMPLETION.value
    ]
    assert not pending
    # The parent is notified exactly like a human/agent approval (flow-back fact).
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    assert any(n.payload.get("child_issue_id") == child.issue_id for n in notes)
    # The child's own audit event is system-authored (machine close).
    own = store.list_issue_interactions(issue_id=child.issue_id, kind="completion")
    assert own and all(o.created_by_type == "system" for o in own)


def test_no_gate_bogus_parent_rejected_at_creation(store):
    # The root-masquerade bypass: a human-less policy pinned to a non-existent
    # parent must be refused where untrusted creation lands (save_issue), so it can
    # never be checked out and auto-completed past the human gate.
    eng = _profile(store, "Eng")
    with pytest.raises(ValueError, match="does not exist"):
        store.save_issue(
            Issue(
                title="fake-root",
                company_profile_id=eng.company_profile_id,
                workspace_id=eng.workspace_id,
                status=IssueStatus.TODO.value,
                assignee_agent_profile_id=eng.profile_id,
                parent_id="issue_does_not_exist",
                review_policy=ReviewPolicy.NO_COMPLETION_GATE.value,
            )
        )


def test_parent_scoped_cross_scope_parent_rejected(store):
    # A human-less child must share its parent's governance scope — else a child in
    # one workspace could be pinned to a parent in another to dodge the gate.
    from superclaw.models import WorkspaceProfile

    ceo = _profile(store, "CEO")
    parent = _live_parent(store, ceo, run="run_parent")  # workspace "local"
    # Register a second VALID workspace so governance-scope passes and the
    # parent-scope mismatch (not the unknown-workspace guard) is what trips.
    store.save_workspace_profile(WorkspaceProfile(name="other", workspace_id="other-workspace"))
    with pytest.raises(ValueError, match="different governance scope"):
        store.save_issue(
            Issue(
                title="cross-scope child",
                company_profile_id=ceo.company_profile_id,
                workspace_id="other-workspace",
                status=IssueStatus.TODO.value,
                parent_id=parent.issue_id,
                review_policy=ReviewPolicy.PARENT_ACCEPT.value,
            )
        )


def test_mutate_then_resave_bogus_parent_rejected(store):
    # The mutate-then-resave hole: a root human_final issue cannot be flipped to a
    # human-less policy + bogus parent on a later save. The parent guard runs on
    # EVERY save of a parent-scoped issue, not just creation.
    eng = _profile(store, "Eng")
    issue = store.save_issue(
        Issue(
            title="root",
            company_profile_id=eng.company_profile_id,
            workspace_id=eng.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=eng.profile_id,
        )
    )
    issue.review_policy = ReviewPolicy.NO_COMPLETION_GATE.value
    issue.parent_id = "issue_bogus"
    with pytest.raises(ValueError, match="does not exist"):
        store.save_issue(issue)


def test_intxn_authz_rejects_policy_changed_child(store):
    # If the child's committed policy is no longer parent_accept, the in-transaction
    # gate refuses an agent close even if everything else matches.
    from superclaw.models import ApprovalStatus

    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    # Flip the committed child policy out from under the decision.
    stored = store.get_issue(child.issue_id)
    stored.review_policy = ReviewPolicy.HUMAN_FINAL.value
    store.save_issue(stored)
    child_done = store.get_issue(child.issue_id)
    child_done.status = IssueStatus.DONE.value
    approval.status = ApprovalStatus.APPROVED.value
    with pytest.raises(ValueError, match="not parent_accept"):
        store.apply_approval_decision(
            child_done, approval, require_agent_authz=(ceo.profile_id, "run_parent")
        )


def test_auto_complete_issue_refuses_non_no_gate(store):
    # The state primitive is fail-closed: it only closes a no_completion_gate issue
    # to done, so no internal caller can use it to bypass the approval gate.
    eng = _profile(store, "Eng")
    issue = store.save_issue(
        Issue(
            title="human_final work",
            company_profile_id=eng.company_profile_id,
            workspace_id=eng.workspace_id,
            status=IssueStatus.IN_REVIEW.value,
            assignee_agent_profile_id=eng.profile_id,
        )
    )
    issue.status = IssueStatus.DONE.value
    with pytest.raises(ValueError, match="only closes a no_completion_gate issue"):
        store.auto_complete_issue(issue)


def test_apply_decision_intxn_authz_rejects_held_parent(store):
    # The authoritative gate is transactional: even if the kernel pre-check passed,
    # a hold landing on the parent before the write commit is caught INSIDE the
    # apply transaction and rolls the close back (TOCTOU closed).
    from superclaw.models import ApprovalStatus

    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    # Simulate the race: hold lands AFTER a (hypothetical) passing pre-check.
    team_kernel.hold_issue(store, parent.issue_id, reason="freeze mid-decision")
    child_done = store.get_issue(child.issue_id)
    child_done.status = IssueStatus.DONE.value
    approval.status = ApprovalStatus.APPROVED.value
    with pytest.raises(ValueError, match="on hold"):
        store.apply_approval_decision(
            child_done, approval, require_agent_authz=(ceo.profile_id, "run_parent")
        )
    # Rolled back: the child is still in_review, not done.
    assert store.get_issue(child.issue_id).status == IssueStatus.IN_REVIEW.value


def test_state_primitives_fail_closed_on_missing_row(store):
    # auto_complete_issue / apply_approval_decision are authoritative WRITE primitives:
    # a direct call with a fabricated issue that has no committed row must be refused,
    # not inserted (else it bypasses the "transition of an existing issue" invariant).
    from superclaw.models import Approval, ApprovalStatus, ApprovalType

    eng = _profile(store, "Eng")
    parent = store.save_issue(
        Issue(
            title="real parent",
            company_profile_id=eng.company_profile_id,
            workspace_id=eng.workspace_id,
            status=IssueStatus.IN_PROGRESS.value,
            assignee_agent_profile_id=eng.profile_id,
        )
    )
    ghost = Issue(
        title="ghost",
        company_profile_id=eng.company_profile_id,
        workspace_id=eng.workspace_id,
        status=IssueStatus.DONE.value,
        parent_id=parent.issue_id,
        review_policy=ReviewPolicy.NO_COMPLETION_GATE.value,
    )
    with pytest.raises(ValueError, match="does not exist"):
        store.auto_complete_issue(ghost)
    appr = Approval(
        type=ApprovalType.ISSUE_COMPLETION.value,
        issue_id=ghost.issue_id,
        status=ApprovalStatus.APPROVED.value,
    )
    with pytest.raises(ValueError, match="does not exist"):
        store.apply_approval_decision(ghost, appr)


def test_save_delegated_child_rejects_parent_id_mismatch(store):
    # The delegated-child primitive cannot be used to launder a child onto a parent
    # it does not actually name.
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    foreign = store.save_issue(
        Issue(
            title="foreign",
            company_profile_id=ceo.company_profile_id,
            workspace_id=ceo.workspace_id,
            status=IssueStatus.TODO.value,
        )
    )
    child = Issue(
        title="child",
        company_profile_id=ceo.company_profile_id,
        workspace_id=ceo.workspace_id,
        status=IssueStatus.TODO.value,
        assignee_agent_profile_id=eng.profile_id,
        parent_id=foreign.issue_id,  # claims a different parent than named below
        review_policy=ReviewPolicy.PARENT_ACCEPT.value,
    )
    with pytest.raises(ValueError, match="parent_id"):
        store.save_delegated_child(child, parent_id=parent.issue_id)


def test_invalid_decided_by_type_rejected(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo)
    _, approval = _child_in_review(store, parent, eng)
    with pytest.raises(ValueError, match="invalid decided_by_type"):
        team_kernel.decide_approval(
            store, approval.approval_id, approved=True, decided_by_type="robot"
        )


# --- §2.7② context pointers survive the agent / auto-close completion paths ----
# Regression for the merge of #291 (completion gate) with #293 (context pointers):
# both the agent parent_accept close and the no_completion_gate auto-close clear
# issue.execution_run_id BEFORE the parent flow-back runs, so the child's run id
# must be captured up-front or the pointers silently vanish on those paths.

_PTRS = {"status": "captured", "paths": ["login.py"], "total_count": 1}


def _seed_child_pointers(store, run_id):
    ev = store.create_evidence(run_id)
    ev.backend_summary = {"context_pointers": dict(_PTRS)}
    store.save_evidence(ev)


def test_parent_accept_agent_close_carries_child_context_pointers(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child, approval = _child_in_review(store, parent, eng)
    _seed_child_pointers(store, "run_child")
    team_kernel.decide_approval(
        store,
        approval.approval_id,
        approved=True,
        decided_by="ceo-run",
        decided_by_type=DeciderType.AGENT.value,
        deciding_agent_profile_id=ceo.profile_id,
        deciding_run_id="run_parent",
    )
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    carrying = [n for n in notes if n.payload.get("child_issue_id") == child.issue_id]
    assert carrying, "parent must receive the child-done flow-back"
    assert carrying[0].payload.get("context_pointers", {}).get("paths") == ["login.py"]


def test_no_completion_gate_auto_close_carries_child_context_pointers(store):
    ceo = _profile(store, "CEO")
    eng = _profile(store, "Eng")
    parent = _live_parent(store, ceo, run="run_parent")
    child = store.save_issue(
        Issue(
            title="machine sub-work",
            company_profile_id=ceo.company_profile_id,
            workspace_id=ceo.workspace_id,
            status=IssueStatus.TODO.value,
            assignee_agent_profile_id=eng.profile_id,
            parent_id=parent.issue_id,
            review_policy=ReviewPolicy.NO_COMPLETION_GATE.value,
        )
    )
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_child", holder=eng.profile_id)
    _seed_child_pointers(store, "run_child")
    team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    carrying = [n for n in notes if n.payload.get("child_issue_id") == child.issue_id]
    assert carrying, "parent must receive the child-done flow-back"
    assert carrying[0].payload.get("context_pointers", {}).get("paths") == ["login.py"]
