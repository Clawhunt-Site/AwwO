"""Tests for the delegation loop (phase 3b): break down, wake, flow back.

Delegation is how a manager-agent turns one issue into many without polling:
the child carries provenance, the delegate is woken to start, and an approved
child flows back to the parent's thread + wakes the delegator.
"""

import pytest

from superclaw import team_kernel
from superclaw.models import AgentProfile, Issue, IssueStatus
from superclaw.state import StateStore
from superclaw.team_kernel import MAX_CHILD_ISSUES_PER_PARENT


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def make_profile(store, name="Eng", **kwargs):
    profile = AgentProfile(name=name, role="engineer", backend_policy="local", **kwargs)
    store.save_agent_profile(profile)
    return profile


def make_issue(store, profile=None, *, title="Parent work"):
    issue = Issue(title=title, description="work")
    store.save_issue(issue)
    if profile is not None:
        issue = team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    return issue


def queued_wakeups(store, profile_id):
    return store.list_wakeups(agent_profile_id=profile_id, status="queued")


# --- delegation provenance + wakeups ------------------------------------------


def test_delegate_sets_provenance_and_wakes_assignee(store):
    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent = make_issue(store, ceo)
    child = team_kernel.delegate_sub_issue(
        store,
        parent.issue_id,
        assignee_agent_profile_id=eng.profile_id,
        title="Build the API",
        requested_by=ceo.profile_id,
        origin_run_id="run_ceo_1",
    )
    assert child.parent_id == parent.issue_id
    # Business kind (typed-issue): a delegated sub-issue IS a delegation, not a root
    # delivery — distinct from origin_kind (audit-only provenance).
    assert child.kind == "delegation"
    # Per execution-plan §2.7 a delegated child is accepted by its parent/QA, NOT a
    # human final approval — so it must NOT inherit the default human_final policy.
    assert child.review_policy == "parent_accept"
    assert child.origin_kind == "delegation"
    assert child.origin_run_id == "run_ceo_1"
    assert child.status == IssueStatus.TODO.value
    # The delegate is woken (assignment source) — no polling.
    wakes = queued_wakeups(store, eng.profile_id)
    assert len(wakes) == 1 and wakes[0].source == "assignment"
    # The delegation is a durable thread fact on the PARENT.
    facts = store.list_issue_interactions(issue_id=parent.issue_id, kind="delegation")
    assert len(facts) == 1
    assert facts[0].payload["child_issue_id"] == child.issue_id
    assert facts[0].source_run_id == "run_ceo_1"


def test_assignment_wakes_the_new_assignee(store):
    eng = make_profile(store)
    issue = Issue(title="solo", description="d")
    store.save_issue(issue)
    team_kernel.assign_issue(store, issue.issue_id, eng.profile_id)
    wakes = queued_wakeups(store, eng.profile_id)
    assert len(wakes) == 1 and wakes[0].source == "assignment"


def test_child_cap_fails_closed(store):
    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent = make_issue(store, ceo)
    for index in range(MAX_CHILD_ISSUES_PER_PARENT):
        team_kernel.delegate_sub_issue(
            store, parent.issue_id,
            assignee_agent_profile_id=eng.profile_id, title=f"part {index}",
        )
    with pytest.raises(ValueError, match="cap"):
        team_kernel.delegate_sub_issue(
            store, parent.issue_id,
            assignee_agent_profile_id=eng.profile_id, title="one too many",
        )


# --- completion flows back to the parent -----------------------------------------


def drain_wakeups(store):
    while True:
        wakeup = store.claim_next_wakeup()
        if wakeup is None:
            return
        store.finish_wakeup(wakeup.wakeup_id, status="finished", detail="test-drain")


def _approved_child(store, ceo, eng):
    parent = make_issue(store, ceo)
    drain_wakeups(store)  # clear setup assignment wakeups; focus on flow-back
    child = team_kernel.delegate_sub_issue(
        store, parent.issue_id,
        assignee_agent_profile_id=eng.profile_id, title="Child work",
        requested_by=ceo.profile_id,
    )
    drain_wakeups(store)  # consume the delegate's assignment wakeup
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_c", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    return parent, child


def test_approved_child_flows_back_to_parent(store):
    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent, child = _approved_child(store, ceo, eng)
    assert store.get_issue(child.issue_id).status == IssueStatus.DONE.value
    # The parent's thread records the completion as a PENDING fact (the
    # manager-continuation pass consumes it; crash-safe because it is written
    # before the approval flips)...
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    assert len(notes) == 1
    assert notes[0].continuation_policy == "notify_parent"
    assert notes[0].status == "pending"
    assert notes[0].payload["child_issue_id"] == child.issue_id
    assert any("[child done]" in c.body for c in store.list_issue_comments(parent.issue_id))
    # ...and the delegator gets exactly ONE wakeup (the system comment does
    # not double-wake; the explicit automation wake is the continuation).
    wakes = queued_wakeups(store, ceo.profile_id)
    child_wakes = [w for w in wakes if w.reason == f"child_done:{child.issue_id}"]
    assert len(child_wakes) == 1 and child_wakes[0].source == "automation"
    assert len(wakes) == 1


def test_orphan_issue_approval_does_not_notify_anyone(store):
    eng = make_profile(store)
    issue = make_issue(store, eng, title="standalone")
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_s", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, issue.issue_id, requested_by=eng.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    # No parent → no notify_parent interaction anywhere.
    assert all(
        i.continuation_policy != "notify_parent"
        for i in store.list_issue_interactions(kind="completion")
    )


# --- advisor-driven hardening (3b round 2) ---------------------------------------


def test_delegation_depth_cap_fails_closed(store):
    from superclaw.team_kernel import MAX_DELEGATION_DEPTH

    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    current = make_issue(store, ceo)
    # Build a relay chain down to the cap (root=0, deepest child=MAX)…
    for index in range(MAX_DELEGATION_DEPTH):
        current = team_kernel.delegate_sub_issue(
            store, current.issue_id,
            assignee_agent_profile_id=eng.profile_id, title=f"layer {index}",
        )
    # …the next hop exceeds MAX_DELEGATION_DEPTH and must fail closed.
    with pytest.raises(ValueError, match="too deep"):
        team_kernel.delegate_sub_issue(
            store, current.issue_id,
            assignee_agent_profile_id=eng.profile_id, title="one layer too far",
        )


def test_child_cap_counts_only_active_children(store):
    from superclaw.models import IssueStatus as _S

    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent = make_issue(store, ceo)
    children = [
        team_kernel.delegate_sub_issue(
            store, parent.issue_id,
            assignee_agent_profile_id=eng.profile_id, title=f"part {i}",
        )
        for i in range(MAX_CHILD_ISSUES_PER_PARENT)
    ]
    with pytest.raises(ValueError, match="cap"):
        team_kernel.delegate_sub_issue(
            store, parent.issue_id,
            assignee_agent_profile_id=eng.profile_id, title="over",
        )
    # Finishing a child frees its slot — the error message and the semantics
    # agree ("finish or cancel some first").
    done = children[0]
    team_kernel.checkout_issue(store, done.issue_id, run_id="r", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, done.issue_id, requested_by=eng.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_issue(done.issue_id).status == _S.DONE.value
    replacement = team_kernel.delegate_sub_issue(
        store, parent.issue_id,
        assignee_agent_profile_id=eng.profile_id, title="replacement",
    )
    assert replacement.parent_id == parent.issue_id


def test_manager_continuation_consumes_child_done(store, tmp_path):
    """The full flow-back: child done → parent woken → parent re-runs WITH the
    child context → re-submits → the pending completion fact is consumed."""
    from superclaw.daemon import HeartbeatDaemon

    captured = {}

    class _CapturingOrchestrator:
        def run_goal(self, **kwargs):
            import types

            captured.update(kwargs)
            return types.SimpleNamespace(
                session=types.SimpleNamespace(run_id="run_mgr", status="completed")
            )

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent, child = _approved_child(store, ceo, eng)

    # The child_done wakeup drives the CEO's continuation pass on the parent.
    outcome = daemon.service_once()
    assert outcome.status == "finished"
    assert outcome.issue_id == parent.issue_id
    assert outcome.detail.endswith("submitted_for_review")
    # The manager saw the finished child in its brief…
    assert "Delegated child finished" in captured["description"]
    assert "Child work" in captured["description"]
    # …and the consumed fact is resolved (no infinite re-trigger).
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    assert all(n.status == "resolved" for n in notes if n.continuation_policy == "notify_parent")
    assert store.get_issue(parent.issue_id).status == IssueStatus.IN_REVIEW.value


def test_tree_active_cap_fails_closed(store):
    from superclaw.team_kernel import MAX_ACTIVE_ISSUES_PER_TREE

    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    root = make_issue(store, ceo)
    # Fill the tree breadth-first under multiple parents (within depth+width
    # caps) until the TREE cap trips.
    created = 1
    frontier = [root]
    tripped = False
    try:
        while frontier:
            parent = frontier.pop(0)
            for i in range(team_kernel.MAX_CHILD_ISSUES_PER_PARENT):
                child = team_kernel.delegate_sub_issue(
                    store, parent.issue_id,
                    assignee_agent_profile_id=eng.profile_id, title=f"n{created}",
                )
                created += 1
                frontier.append(child)
    except ValueError as exc:
        tripped = "tree" in str(exc)
    assert tripped, f"tree cap never tripped after {created} issues"
    assert created <= MAX_ACTIVE_ISSUES_PER_TREE + 1


def test_flow_back_escalates_to_board_when_parent_unassigned(store):
    _ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    parent = make_issue(store)  # NO assignee on the parent
    drain_wakeups(store)
    child = team_kernel.delegate_sub_issue(
        store, parent.issue_id, assignee_agent_profile_id=eng.profile_id, title="orphan parent child",
    )
    drain_wakeups(store)
    team_kernel.checkout_issue(store, child.issue_id, run_id="r", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    notes = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    # Nobody to wake → the fact escalates to the board instead of vanishing.
    assert len(notes) == 1 and notes[0].continuation_policy == "escalate_to_board"
    assert store.list_wakeups(status="queued") == []


def test_child_done_converges_on_parent_despite_other_todos(store, tmp_path):
    """Directionality: the parent with a pending child-done fact outranks an
    older, higher-priority plain todo (the Codex round-3 scenario)."""
    from superclaw.daemon import HeartbeatDaemon

    captured = {}

    class _CapturingOrchestrator:
        def run_goal(self, **kwargs):
            import types

            captured.update(kwargs)
            return types.SimpleNamespace(
                session=types.SimpleNamespace(run_id="run_dir", status="completed")
            )

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    ceo = make_profile(store, name="CEO")
    eng = make_profile(store, name="Eng")
    # An OLDER, HIGHER-priority unrelated todo for the CEO…
    distraction = Issue(title="Old urgent thing", description="d", priority="high")
    store.save_issue(distraction)
    team_kernel.assign_issue(store, distraction.issue_id, ceo.profile_id)
    # …then the delegation story creates the parent with a pending fact.
    parent, child = _approved_child(store, ceo, eng)

    outcome = daemon.service_once()
    # The continuation debt wins over the older/higher-priority fresh todo.
    assert outcome.issue_id == parent.issue_id
    assert "Delegated child finished" in captured["description"]
