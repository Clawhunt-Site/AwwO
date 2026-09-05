"""P2: issue-tree write commands (pause/resume/cancel a delegated work subtree).

The operator can manage a whole delegated work hierarchy from chat. The kernel
tree primitives stop active runs via a ``run_canceller``; this is built from the
STORE inside the dispatcher (``run_cancel.cancel_run_in_store`` is store-portable),
so cancellation works from EVERY surface — chat, the A-class proxy subprocess, CLI,
REST, and the grant-time apply path — with no runtime handle to thread. Covered:

  * the store-portable canceller really stops an active run (status → cancelled);
  * tree_pause / tree_resume are LOW (direct); tree_cancel is HIGH (human approval,
    nothing cancelled until granted), and the GRANT path actually cancels;
  * governance: a CONFINED agent is default-denied every tree command (operator-only);
  * scope: a cross-company target is forbidden.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import COMMAND_REGISTRY, get_command_model
from superclaw.company_handler import apply_company_command, execute_company_command
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import ApprovalStatus, CompanyProfile, Issue, RunSession
from superclaw.run_cancel import cancel_run_in_store
from superclaw.state import StateStore

_TREE_TYPES = {"issue.tree_pause", "issue.tree_resume", "issue.tree_cancel"}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name, owner_id="u"))


def _issue_with_run(store, company_id, *, run_id="runX"):
    iss = store.save_issue(Issue(title="T", company_profile_id=company_id, status="in_progress"))
    store.save_run(RunSession(goal_id="g", run_id=run_id, status="running"))
    iss.execution_run_id = run_id
    return store.save_issue(iss)


def _operator(company_id):
    return CompanyScope(principal_id="u", actor_company_id=company_id, is_admin=True)


def _run(store, scope, command_type, args):
    return execute_company_command(
        get_command_model(command_type).from_dict(args), scope=scope, store=store, requested_by="u"
    )


# --- the store-portable canceller really stops a run ------------------------
def test_cancel_run_in_store_stops_active_run(store):
    store.save_run(RunSession(goal_id="g", run_id="r1", status="running"))
    res = cancel_run_in_store(store, "r1")
    assert res.accepted and store.get_run("r1").status == "cancelled"
    # idempotent-ish: already terminal non-cancelled is ignored
    store.save_run(RunSession(goal_id="g", run_id="r2", status="completed"))
    assert cancel_run_in_store(store, "r2").accepted is False


def test_cancel_run_in_store_propagates_to_children(store):
    from superclaw.models import ChildExecution

    store.save_run(RunSession(goal_id="g", run_id="child1", status="running"))
    parent = RunSession(goal_id="g", run_id="parent1", status="running")
    parent.child_executions = [
        ChildExecution(
            child_task_id="t", child_run_id="child1", parent_run_id="parent1",
            parent_task_id="pt", backend="local", status="running",
        )
    ]
    store.save_run(parent)
    cancel_run_in_store(store, "parent1")
    assert store.get_run("child1").status == "cancelled"  # propagated


# --- contract --------------------------------------------------------------
def test_tree_commands_registered():
    assert _TREE_TYPES <= set(COMMAND_REGISTRY)


# --- dispatch (operator) ----------------------------------------------------
def test_tree_pause_cancels_active_run(store):
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    assert _run(store, _operator(c.company_profile_id), "issue.tree_pause", {"issue_id": iss.issue_id}).outcome == "executed"
    # the subtree's active run was really stopped via the store-portable canceller.
    assert store.get_run("runX").status == "cancelled"


def test_tree_resume_runs(store):
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    op = _operator(c.company_profile_id)
    _run(store, op, "issue.tree_pause", {"issue_id": iss.issue_id})
    assert _run(store, op, "issue.tree_resume", {"issue_id": iss.issue_id}).outcome == "executed"


# --- tree_cancel: HIGH, and the GRANT path actually cancels -----------------
def test_tree_cancel_is_high_then_grant_cancels(store):
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    res = _run(store, _operator(c.company_profile_id), "issue.tree_cancel", {"issue_id": iss.issue_id, "reason": "scrap"})
    assert res.outcome == "pending_approval"
    approval = next(a for a in store.list_approvals() if a.approval_id == res.detail["approval_id"])
    assert approval.status == ApprovalStatus.PENDING.value
    # NOT cancelled yet.
    assert store.get_issue(iss.issue_id).status != "cancelled"
    # Grant → apply → the subtree is really cancelled (store-portable canceller works
    # at grant time too, no orchestrator threaded): both the ISSUE and its active RUN.
    apply_company_command(store, approval.resume_action, approval_id=approval.approval_id)
    assert store.get_issue(iss.issue_id).status == "cancelled"
    assert store.get_run("runX").status == "cancelled"


def test_tree_cancel_grant_fail_closed_when_run_unstoppable(store, monkeypatch):
    # If a run cannot be stopped (canceller raises → frozen_in_place), the HIGH grant
    # must NOT be marked done: apply raises so the approval stays re-decidable.
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    res = _run(store, _operator(c.company_profile_id), "issue.tree_cancel", {"issue_id": iss.issue_id})
    approval = next(a for a in store.list_approvals() if a.approval_id == res.detail["approval_id"])

    import superclaw.run_cancel as rc
    from superclaw import team_kernel
    from superclaw.models import ApprovalStatus

    def _boom(store_, run_id, **kw):
        raise RuntimeError("canceller down")

    monkeypatch.setattr(rc, "cancel_run_in_store", _boom)
    # Drive the REAL grant path: decide_approval(approved=True) → _apply_agent_approval
    # → apply_company_command raises (frozen_in_place) → the approval must stay PENDING
    # (re-decidable), never flip to approved.
    with pytest.raises(Exception):
        team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_approval(approval.approval_id).status == ApprovalStatus.PENDING.value


# --- governance: confined agents default-denied -----------------------------
@pytest.mark.parametrize("ctype", sorted(_TREE_TYPES))
def test_confined_agent_denied_every_tree_command(store, ctype):
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    conf = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, conf, ctype, {"issue_id": iss.issue_id})


def test_requeue_cancels_active_run_then_requeues(store):
    # Requeue must cancel the stuck run FIRST (no orphan), then reset to todo.
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    res = _run(store, _operator(c.company_profile_id), "issue.requeue", {"issue_id": iss.issue_id})
    assert res.outcome == "executed"
    assert res.detail["cancelled_run"] == "runX"
    refreshed = store.get_issue(iss.issue_id)
    assert refreshed.status == "todo"
    assert refreshed.execution_run_id is None
    assert store.get_run("runX").status == "cancelled"  # not orphaned


def test_requeue_cancels_real_run_in_daemon_checkout_window(store):
    # The daemon checks out with a wakeup_id token BEFORE anchoring the real run_id to
    # execution_run_id. requeue must still find + cancel the real run (stamped with the
    # checkout's wakeup_id) — not mistake the token for a run id and miss the live run.
    c = _company(store)
    iss = store.save_issue(Issue(title="T", company_profile_id=c.company_profile_id, status="in_progress", assignee_agent_profile_id="ag"))
    store.save_run(RunSession(goal_id="g", run_id="realRun", status="running", execution_context={"wakeup_id": "wk_1"}))
    iss.checkout_run_id = "wk_1"  # the token, not yet the anchored run_id
    store.save_issue(iss)
    res = _run(store, _operator(c.company_profile_id), "issue.requeue", {"issue_id": iss.issue_id})
    assert res.outcome == "executed"
    assert res.detail["cancelled_run"] == "realRun"  # resolved via the wakeup_id
    assert store.get_run("realRun").status == "cancelled"  # not orphaned
    assert store.get_issue(iss.issue_id).status == "todo"


def test_requeue_no_run_just_requeues(store):
    c = _company(store)
    iss = store.save_issue(Issue(title="T", company_profile_id=c.company_profile_id, status="in_progress", assignee_agent_profile_id="ag"))
    res = _run(store, _operator(c.company_profile_id), "issue.requeue", {"issue_id": iss.issue_id})
    assert res.outcome == "executed" and res.detail["cancelled_run"] is None
    assert store.get_issue(iss.issue_id).status == "todo"


def test_requeue_confined_denied(store):
    c = _company(store)
    iss = _issue_with_run(store, c.company_profile_id)
    conf = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, conf, "issue.requeue", {"issue_id": iss.issue_id})


def test_cross_company_tree_pause_forbidden(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = store.save_issue(Issue(title="x", company_profile_id=b.company_profile_id))
    scoped_to_a = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, scoped_to_a, "issue.tree_pause", {"issue_id": foreign.issue_id})
