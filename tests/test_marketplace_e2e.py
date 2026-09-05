"""End-to-end wiring proof for the marketplace-as-company接单 chain.

Drives the WHOLE governed lifecycle in one test, with a fake ClawHunt client +
fake orchestrator, to prove every seam connects: claim → grant → saga advance
(build company delivery issue, run it, open the completion gate) → completion
grant → advance (ready_to_submit) → submit → grant → submitted. If this passes,
the company接单底座 is wired end to end (the only thing it does NOT do is
auto-drive the advance steps — those are operator/daemon-triggered by design).
"""

from __future__ import annotations


from superclaw import marketplace_handler, team_kernel
from superclaw.company_scope import CompanyScope
from superclaw.marketplace_commands import MarketplaceClaimCommand, MarketplaceSubmitCommand
from superclaw.marketplace_handler import execute_marketplace_command
from superclaw.marketplace_saga import advance_marketplace_order
from superclaw.models import (
    AgentProfile,
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    EvidenceBundle,
    GoalSpec,
    IssueStatus,
    MarketplaceOrderStatus,
    RunSession,
    RunStatus,
)
from superclaw.state import StateStore


class _Settings:
    agent_api_key = "cph_test"
    base_url = "https://clawhunt.test"


class FakeClient:
    def __init__(self):
        self.settings = _Settings()
        self.calls = []

    def claim(self, pid):
        self.calls.append(("claim", pid))
        return {"ok": True, "status_code": 200, "body": {"id": pid}}

    def get_problem(self, pid):
        return {"ok": True, "status_code": 200, "body": {"id": pid, "title": "Fix it", "secret_repo": "git@x"}}

    def submit_solution(self, pid, solution, evidence=None, *, attachments=None):
        self.calls.append(("submit_solution", pid))
        return {"ok": True, "status_code": 200, "body": {"accepted": True}}


class FakeOrchestrator:
    def __init__(self, store):
        self.store = store

    def run_goal(self, *, title, description, **kwargs):
        goal = self.store.create_goal(GoalSpec(title=title, description=description))
        session = RunSession(goal_id=goal.goal_id, status=RunStatus.COMPLETED.value)
        self.store.save_run(session)
        self.store.save_evidence(EvidenceBundle(run_id=session.run_id))  # no findings → not FAIL

        class _R:
            pass

        r = _R()
        r.session = session
        return r


def _scope(company_id):
    return CompanyScope(principal_id="op", actor_company_id=company_id,
                        allowed_company_ids=frozenset(), is_admin=True)


def test_company_marketplace_take_full_lifecycle(tmp_path, monkeypatch):
    store = StateStore(tmp_path / "state.db")
    client = FakeClient()
    monkeypatch.setattr(marketplace_handler, "_default_client_factory", lambda: client)

    # A company-as-base must have at least one delivery agent (the premise).
    company = CompanyProfile(name="Acme")
    store.save_company_profile(company)
    store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", company_profile_id=company.company_profile_id)
    )
    orch = FakeOrchestrator(store)

    # 1) CLAIM (chat/CLI/API surface) → reserves order + pending claim approval.
    res = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id), store=store, requested_by="op",
        client_factory=lambda: client,
    )
    assert res.outcome == "pending_approval"
    order_id = res.detail["order_id"]
    claim_approval = res.detail["approval_id"]
    assert store.get_marketplace_order(order_id).status == MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value

    # 2) GRANT claim approval (human gate) → remote claim → claimed_remote.
    team_kernel.decide_approval(store, claim_approval, approved=True)
    assert store.get_marketplace_order(order_id).status == MarketplaceOrderStatus.CLAIMED_REMOTE.value
    assert ("claim", "42") in client.calls

    # 3) ADVANCE (operator/daemon-triggered) → build company delivery issue, run the
    #    multi-role delivery, open the completion gate. (Loops through the sync hops.)
    for _ in range(4):
        order = advance_marketplace_order(store, order_id, orchestrator=orch, requested_by="op")
        if order.status == MarketplaceOrderStatus.REVIEW_PENDING.value:
            break
    order = store.get_marketplace_order(order_id)
    assert order.status == MarketplaceOrderStatus.REVIEW_PENDING.value
    assert order.issue_id and order.run_id
    issue = store.get_issue(order.issue_id)
    assert issue.status == IssueStatus.IN_REVIEW.value
    # the delivery issue is the company's, run by the company's agent
    assert issue.company_profile_id == company.company_profile_id
    assert issue.execution_run_id == order.run_id

    # 4) GRANT the issue completion approval (the "accept the delivery" human gate).
    completion = next(
        a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
        if a.type == ApprovalType.ISSUE_COMPLETION.value and a.issue_id == order.issue_id
    )
    team_kernel.decide_approval(store, completion.approval_id, approved=True)
    assert store.get_issue(order.issue_id).status == IssueStatus.DONE.value

    # 5) ADVANCE → ready_to_submit (only AFTER the completion gate passed).
    order = advance_marketplace_order(store, order_id, orchestrator=orch, requested_by="op")
    assert order.status == MarketplaceOrderStatus.READY_TO_SUBMIT.value

    # 6) SUBMIT (surface) → arms the order + pending submit approval (the "send it" gate).
    sres = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order_id),
        scope=_scope(company.company_profile_id), store=store, requested_by="op",
        client_factory=lambda: client,
    )
    assert sres.outcome == "pending_approval"
    submit_approval = sres.detail["approval_id"]
    assert store.get_marketplace_order(order_id).status == MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value

    # 7) GRANT submit approval → evidence sent to ClawHunt → submitted.
    team_kernel.decide_approval(store, submit_approval, approved=True)
    final = store.get_marketplace_order(order_id)
    assert final.status == MarketplaceOrderStatus.SUBMITTED.value
    assert any(c[0] == "submit_solution" for c in client.calls)


def _claimed_order(store, company):
    from superclaw.models import MarketplaceOrder

    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        problem_snapshot={"title": "Fix it"},
    )
    return store.create_marketplace_order(order)


def test_daemon_auto_advance_is_opt_in_fail_closed(tmp_path, monkeypatch):
    """The daemon auto-advance is OFF by default — a claimed order does not progress
    until the operator explicitly opts in (autonomous delivery is fail-closed)."""
    from superclaw.daemon import HeartbeatDaemon

    monkeypatch.delenv("SUPERCLAW_MARKETPLACE_AUTO_ADVANCE", raising=False)
    store = StateStore(tmp_path / "state.db")
    company = CompanyProfile(name="Acme")
    store.save_company_profile(company)
    store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", company_profile_id=company.company_profile_id)
    )
    order = _claimed_order(store, company)
    daemon = HeartbeatDaemon(store, FakeOrchestrator(store), repo_path=tmp_path,
                             artifact_dir=tmp_path / "artifacts")
    assert daemon.reconcile_marketplace_orders() == 0
    assert store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.CLAIMED_REMOTE.value


def test_daemon_auto_advance_drives_saga_when_enabled(tmp_path, monkeypatch):
    """With the opt-in flag, the daemon auto-advances a claimed order through the
    non-gate hops (build issue → run → open completion gate) — no manual advance."""
    from superclaw.daemon import HeartbeatDaemon

    monkeypatch.setenv("SUPERCLAW_MARKETPLACE_AUTO_ADVANCE", "1")
    store = StateStore(tmp_path / "state.db")
    company = CompanyProfile(name="Acme")
    store.save_company_profile(company)
    store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", company_profile_id=company.company_profile_id)
    )
    order = _claimed_order(store, company)
    daemon = HeartbeatDaemon(store, FakeOrchestrator(store), repo_path=tmp_path,
                             artifact_dir=tmp_path / "artifacts")
    # a few ticks drive claimed_remote → … → review_pending (the completion gate)
    for _ in range(4):
        daemon.reconcile_marketplace_orders()
        if store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.REVIEW_PENDING.value:
            break
    final = store.get_marketplace_order(order.order_id)
    assert final.status == MarketplaceOrderStatus.REVIEW_PENDING.value
    assert final.issue_id and final.run_id  # the company delivery issue + run were created
    # but it STOPS at the human completion gate — never auto-submits
    assert final.status != MarketplaceOrderStatus.SUBMITTED.value

    # AFTER the human grants the issue completion gate, the NEXT daemon tick auto-
    # advances review_pending → ready_to_submit (the second non-gate segment) — but
    # still STOPS there (submit stays human-gated; ready_to_submit ∉ advanceable).
    completion = next(
        a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
        if a.type == ApprovalType.ISSUE_COMPLETION.value and a.issue_id == final.issue_id
    )
    team_kernel.decide_approval(store, completion.approval_id, approved=True)
    daemon.reconcile_marketplace_orders()
    after = store.get_marketplace_order(order.order_id)
    assert after.status == MarketplaceOrderStatus.READY_TO_SUBMIT.value
    # a further tick does NOT auto-submit (ready_to_submit is not auto-advanceable)
    daemon.reconcile_marketplace_orders()
    assert store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.READY_TO_SUBMIT.value
