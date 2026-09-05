"""Tests for the marketplace order saga (P1): claim → delivery issue → run →
completion gate → ready_to_submit.

Drives the idempotent ``advance_marketplace_order`` with a fake orchestrator and a
real StateStore, asserting each saga hop, the two-gate semantics (issue completion
gate distinct from the marketplace submit gate), and idempotency.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.marketplace_saga import advance_marketplace_order, ensure_company_workspace
from superclaw.models import (
    AgentProfile,
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    EvidenceBundle,
    GoalSpec,
    IssueKind,
    IssueStatus,
    MarketplaceOrder,
    MarketplaceOrderStatus,
    ReviewPolicy,
    RunSession,
    RunStatus,
    VerificationFinding,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, with_agent=True):
    c = CompanyProfile(name="Acme")
    store.save_company_profile(c)
    if with_agent:
        store.save_agent_profile(
            AgentProfile(name="Eng", role="engineer", company_profile_id=c.company_profile_id)
        )
    return c


def _claimed_order(store, company, *, problem_id="42", snapshot=None):
    order = MarketplaceOrder(
        problem_id=problem_id, base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        problem_snapshot=snapshot or {"title": "Fix the bug", "description": "details"},
    )
    return store.create_marketplace_order(order)


class FakeOrchestrator:
    """Synchronous run_goal stand-in: persists a run (+ evidence) with a controllable
    status and verdict, mirroring orchestrator.run_goal's RunResult shape."""

    def __init__(self, store, *, run_status=RunStatus.COMPLETED.value, verdict_fail=False):
        self.store = store
        self.run_status = run_status
        self.verdict_fail = verdict_fail
        self.calls: list[dict] = []

    def run_goal(self, *, title, description, **kwargs):
        self.calls.append({"title": title, "description": description, **kwargs})
        goal = self.store.create_goal(GoalSpec(title=title, description=description))
        session = RunSession(goal_id=goal.goal_id, status=self.run_status)
        self.store.save_run(session)
        bundle = EvidenceBundle(run_id=session.run_id)
        if self.verdict_fail:
            bundle.findings.append(
                VerificationFinding(name="adversarial", passed=False, detail="probe failed")
            )
        self.store.save_evidence(bundle)
        return _RunResult(session)


class _RunResult:
    def __init__(self, session):
        self.session = session


# --- ensure_company_workspace ------------------------------------------------


def test_ensure_workspace_creates_then_reuses(store):
    company = _company(store)
    ws1 = ensure_company_workspace(store, company.company_profile_id)
    ws2 = ensure_company_workspace(store, company.company_profile_id)
    assert ws1.workspace_id == ws2.workspace_id
    assert ws1.company_profile_id == company.company_profile_id


# --- claimed_remote → issue_bound --------------------------------------------


def test_bind_creates_delivery_issue_human_final(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.ISSUE_BOUND.value
    assert out.issue_id
    issue = store.get_issue(out.issue_id)
    assert issue.kind == IssueKind.DELIVERY.value
    assert issue.review_policy == ReviewPolicy.HUMAN_FINAL.value
    assert issue.company_profile_id == company.company_profile_id
    assert issue.metadata["marketplace_order_id"] == order.order_id


# --- issue_bound → run_started -----------------------------------------------


def test_no_agent_blocks_fail_closed(store):
    """A company with no agent cannot deliver — the order BLOCKS (recoverable),
    never proceeds ungoverned (advisor阻断项 3: checkout needs an assignee agent)."""
    company = _company(store, with_agent=False)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.BLOCKED.value
    assert "agent" in out.last_error.lower()


def test_run_started_checks_out_issue_and_anchors_run(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.RUNNING.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # → issue_bound
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)  # → run_started
    assert out.status == MarketplaceOrderStatus.RUN_STARTED.value
    assert out.run_id
    issue = store.get_issue(out.issue_id)
    # checkout moved it in_progress + anchor bound the execution run (CAS)
    assert issue.status == IssueStatus.IN_PROGRESS.value
    assert issue.execution_run_id == out.run_id
    # the run carried the assignee agent's id + company/issue/order context
    assert orch.calls and orch.calls[0]["agent_profile_id"]
    assert orch.calls[0]["execution_context_extra"]["company_profile_id"] == company.company_profile_id


def test_run_still_running_is_noop(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.RUNNING.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)  # run still running
    assert out.status == MarketplaceOrderStatus.RUN_STARTED.value


def test_completed_run_with_fail_verdict_marks_run_failed(store):
    """A completed run whose verifier verdict is FAIL must NOT open the acceptance
    gate (advisor阻断项 2: completed ≠ verified)."""
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.COMPLETED.value, verdict_fail=True)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.RUN_FAILED.value
    assert "FAIL" in out.last_error


# --- run_started → review_pending (completion gate opens) --------------------


def test_completed_run_opens_completion_gate(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.COMPLETED.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # issue_bound
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # run_started (run already COMPLETED)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)  # observe → review_pending
    assert out.status == MarketplaceOrderStatus.REVIEW_PENDING.value
    issue = store.get_issue(out.issue_id)
    assert issue.status == IssueStatus.IN_REVIEW.value
    # an ISSUE_COMPLETION approval was opened (the human acceptance gate)
    pend = [a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
            if a.type == ApprovalType.ISSUE_COMPLETION.value and a.issue_id == issue.issue_id]
    assert len(pend) == 1


def test_failed_run_marks_run_failed(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.FAILED.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.RUN_FAILED.value


# --- review_pending → ready_to_submit (only after issue passes the gate) -----


def test_ready_to_submit_only_after_completion_granted(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.COMPLETED.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # review_pending
    issue_id = store.get_marketplace_order(order.order_id).issue_id

    # before granting completion: still review_pending (the gate holds)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.REVIEW_PENDING.value

    # human grants the issue completion approval → issue done
    approval = next(a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
                    if a.type == ApprovalType.ISSUE_COMPLETION.value and a.issue_id == issue_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_issue(issue_id).status == IssueStatus.DONE.value

    # now the saga advances to ready_to_submit (completion gate ≠ submit gate)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.READY_TO_SUBMIT.value


def test_open_gate_failure_blocks_not_escapes(store, monkeypatch):
    """If submit_for_review fails for ANY reason after the order CAS'd to
    review_pending (e.g. the issue was requeued out of in_progress), the saga must
    settle the order to BLOCKED — never let the exception escape leaving a phantom
    review_pending with no approval (advisor阻断项, Codex)."""
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store, run_status=RunStatus.COMPLETED.value)
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # issue_bound
    advance_marketplace_order(store, order.order_id, orchestrator=orch)  # run_started

    def _boom(*a, **k):
        raise ValueError("issue must be in_progress")

    monkeypatch.setattr(team_kernel, "submit_for_review", _boom)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)  # observe
    assert out.status == MarketplaceOrderStatus.BLOCKED.value
    assert "could not open completion gate" in out.last_error


def test_advance_is_noop_on_terminal_and_ready(store):
    company = _company(store)
    order = _claimed_order(store, company)
    orch = FakeOrchestrator(store)
    # drive to ready-ish then check a no-advance state: ready_to_submit stays put
    o = store.get_marketplace_order(order.order_id)
    o.status = MarketplaceOrderStatus.ISSUE_BOUND.value  # legal from claimed_remote
    store.save_marketplace_order(o)
    o = store.get_marketplace_order(order.order_id)
    o.issue_id = "issue_x"
    o.status = MarketplaceOrderStatus.RUN_STARTED.value
    store.save_marketplace_order(o)
    o = store.get_marketplace_order(order.order_id)
    o.status = MarketplaceOrderStatus.REVIEW_PENDING.value
    store.save_marketplace_order(o)
    o = store.get_marketplace_order(order.order_id)
    o.status = MarketplaceOrderStatus.READY_TO_SUBMIT.value
    store.save_marketplace_order(o)
    # advance on ready_to_submit → no-op (saga does not auto-submit)
    out = advance_marketplace_order(store, order.order_id, orchestrator=orch)
    assert out.status == MarketplaceOrderStatus.READY_TO_SUBMIT.value
