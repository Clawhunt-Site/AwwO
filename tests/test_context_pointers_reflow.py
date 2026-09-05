"""Reflow wiring for context-pointers: the child's captured pointers must reach
the parent through BOTH the issue-completion path (team_kernel → completion
payload → daemon _rework_brief render) and survive malformed/absent records.
"""

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import (
    AgentProfile,
    ContinuationPolicy,
    Issue,
    IssueInteractionKind,
    IssueThreadInteraction,
)
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore

_POINTERS = {"status": "captured", "paths": ["login.py", "auth.py"], "total_count": 2}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _agent(store, name, role):
    p = AgentProfile(name=name, role=role, company_profile_id="local", backend_policy="local")
    store.save_agent_profile(p)
    return p


def test_child_completion_payload_carries_context_pointers(store):
    """team_kernel.decide_approval reads the child run's evidence pointers into the
    parent's completion notification."""
    ceo = _agent(store, "CEO", "ceo")
    eng = _agent(store, "Eng", "engineer")
    parent = Issue(title="root", company_profile_id="local")
    store.save_issue(parent)
    team_kernel.assign_issue(store, parent.issue_id, ceo.profile_id)

    child = Issue(title="login", company_profile_id="local", parent_id=parent.issue_id)
    store.save_issue(child)
    team_kernel.assign_issue(store, child.issue_id, eng.profile_id)
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_child", holder=eng.profile_id)
    # The child run's evidence carries the captured pointers.
    ev = store.create_evidence("run_child")
    ev.backend_summary = {"context_pointers": dict(_POINTERS)}
    store.save_evidence(ev)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)

    team_kernel.decide_approval(store, approval.approval_id, approved=True)

    comps = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    assert comps, "parent must receive a child-done completion"
    assert comps[0].payload.get("context_pointers", {}).get("paths") == ["login.py", "auth.py"]


def test_child_completion_without_evidence_omits_pointers(store):
    """No child evidence → the completion still fires, just without a pointers key
    (never a fabricated/empty record)."""
    ceo = _agent(store, "CEO", "ceo")
    eng = _agent(store, "Eng", "engineer")
    parent = Issue(title="root", company_profile_id="local")
    store.save_issue(parent)
    team_kernel.assign_issue(store, parent.issue_id, ceo.profile_id)
    child = Issue(title="x", company_profile_id="local", parent_id=parent.issue_id)
    store.save_issue(child)
    team_kernel.assign_issue(store, child.issue_id, eng.profile_id)
    team_kernel.checkout_issue(store, child.issue_id, run_id="run_no_ev", holder=eng.profile_id)
    _, approval = team_kernel.submit_for_review(store, child.issue_id, requested_by=eng.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    comps = store.list_issue_interactions(issue_id=parent.issue_id, kind="completion")
    assert comps and "context_pointers" not in comps[0].payload


def test_a2a_delegate_tool_result_surfaces_pointers(store):
    """The A2A reflow path: the parent's delegate tool result carries the child's
    pointers (read from the child run's evidence) in both the summary and content."""
    from superclaw.models import ChildExecution, RunSession

    orch = SuperClawOrchestrator(store)
    child = RunSession(goal_id="g", run_id="run_a2a_child", execution_context={})
    child.status = "completed"
    ev = store.create_evidence("run_a2a_child")
    ev.backend_summary = {"context_pointers": dict(_POINTERS)}
    store.save_evidence(ev)
    parent = RunSession(goal_id="g", run_id="run_a2a_parent", execution_context={})
    ce = ChildExecution(
        child_task_id="ct", child_run_id="run_a2a_child", parent_run_id="run_a2a_parent",
        parent_task_id="pt", backend="local", status="completed", chain_verdict="passed",
    )
    wait = {"parent_tool_call_id": "tc1", "request_key": "rk1", "parent_task_id": "pt", "child_task_id": "ct"}

    result = orch._build_delegate_tool_result(parent_session=parent, wait=wait, child_execution=ce, child_session=child)

    assert result["content"]["context_pointers"]["paths"] == ["login.py", "auth.py"]
    assert "login.py" in result["content"]["summary"]


def test_a2a_delegate_tool_result_without_pointers_is_null(store):
    """A child whose evidence has no pointers yields a null content field and no
    misleading UNKNOWN appended to the summary."""
    from superclaw.models import ChildExecution, RunSession

    orch = SuperClawOrchestrator(store)
    child = RunSession(goal_id="g", run_id="run_a2a_child2", execution_context={})
    child.status = "completed"
    store.create_evidence("run_a2a_child2")  # evidence exists but carries no pointers
    parent = RunSession(goal_id="g", run_id="run_a2a_parent2", execution_context={})
    ce = ChildExecution(
        child_task_id="ct", child_run_id="run_a2a_child2", parent_run_id="run_a2a_parent2",
        parent_task_id="pt", backend="local", status="completed", chain_verdict="passed",
    )
    wait = {"parent_tool_call_id": "tc", "request_key": "rk", "parent_task_id": "pt", "child_task_id": "ct"}
    result = orch._build_delegate_tool_result(parent_session=parent, wait=wait, child_execution=ce, child_session=child)
    assert result["content"]["context_pointers"] is None
    assert "UNKNOWN" not in result["content"]["summary"]


def _completion(store, issue_id, payload):
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue_id,
            company_profile_id="local",
            kind=IssueInteractionKind.COMPLETION.value,
            continuation_policy=ContinuationPolicy.NOTIFY_PARENT.value,
            status="pending",
            created_by_type="system",
            created_by_id="sys",
            payload=payload,
        )
    )


def test_rework_brief_renders_pointers_only_when_present(store, tmp_path):
    daemon = HeartbeatDaemon(store, SuperClawOrchestrator(store), repo_path=tmp_path, artifact_dir=tmp_path / "a")

    with_ptr = Issue(title="p1", company_profile_id="local")
    store.save_issue(with_ptr)
    _completion(store, with_ptr.issue_id, {"child_title": "Login", "child_issue_id": "c1", "context_pointers": dict(_POINTERS)})
    brief = daemon._rework_brief(store.get_issue(with_ptr.issue_id))
    assert "login.py" in brief and "auth.py" in brief

    # A completion predating this feature (no pointers key) must NOT render UNKNOWN.
    without_ptr = Issue(title="p2", company_profile_id="local")
    store.save_issue(without_ptr)
    _completion(store, without_ptr.issue_id, {"child_title": "Old", "child_issue_id": "c2"})
    brief2 = daemon._rework_brief(store.get_issue(without_ptr.issue_id))
    assert "Old" in brief2 and "UNKNOWN" not in brief2 and "Files changed" not in brief2


def _task_session(store, profile, issue, *, last_run_id):
    from superclaw.models import AgentTaskSession
    store.save_agent_task_session(
        AgentTaskSession(agent_profile_id=profile.profile_id, task_key=issue.issue_id,
                         company_profile_id="local", last_run_id=last_run_id)
    )


def test_prior_pass_surfaces_the_issues_own_changed_files(store, tmp_path):
    # Paperclip-style "Files Touched" (#1): the continuation brief now also shows the
    # changed-file pointers from the issue's OWN last run (not only delegated-child
    # pointers), so a resumed pass sees what it already changed.
    daemon = HeartbeatDaemon(store, SuperClawOrchestrator(store), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = _agent(store, "Eng", "engineer")
    issue = Issue(title="own-files", company_profile_id="local", assignee_agent_profile_id=eng.profile_id)
    store.save_issue(issue)
    ev = store.create_evidence("run_prev")
    ev.backend_summary = {"context_pointers": dict(_POINTERS)}
    store.save_evidence(ev)
    _task_session(store, eng, issue, last_run_id="run_prev")

    brief = daemon._rework_brief(store.get_issue(issue.issue_id), eng)
    assert "Files you changed last pass" in brief
    assert "login.py" in brief and "auth.py" in brief


def test_prior_pass_without_evidence_omits_files_touched(store, tmp_path):
    # A prior run with no captured pointers (or no evidence) must NOT render a
    # misleading "Files you changed last pass" / UNKNOWN line.
    daemon = HeartbeatDaemon(store, SuperClawOrchestrator(store), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = _agent(store, "Eng2", "engineer")
    issue = Issue(title="no-files", company_profile_id="local", assignee_agent_profile_id=eng.profile_id)
    store.save_issue(issue)
    _task_session(store, eng, issue, last_run_id="run_missing")  # no evidence saved
    brief = daemon._rework_brief(store.get_issue(issue.issue_id), eng)
    assert "Files you changed last pass" not in brief and "UNKNOWN" not in brief


@pytest.mark.parametrize("bad_pointers", [
    {"bogus": 1, "paths": "not-a-list"},  # dict with wrong field types
    [1, 2, 3],                             # not a dict at all (corrupt/legacy)
    "garbage-string",                      # not a dict at all
])
def test_rework_brief_survives_malformed_pointers(store, tmp_path, bad_pointers):
    daemon = HeartbeatDaemon(store, SuperClawOrchestrator(store), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    issue = Issue(title="p3", company_profile_id="local")
    store.save_issue(issue)
    # A corrupt context_pointers value (wrong field types OR not even a dict) must
    # never crash the parent's continuation render (from_dict tolerates non-dicts).
    _completion(store, issue.issue_id, {"child_title": "Weird", "child_issue_id": "c3", "context_pointers": bad_pointers})
    brief = daemon._rework_brief(store.get_issue(issue.issue_id))
    assert "Weird" in brief  # render did not raise
