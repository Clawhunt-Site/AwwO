"""Tests for the ClawHunt marketplace command handler + order ledger (P0).

Exercises the fixed fail-closed order (validate -> auth -> scope -> risk ->
read-now / approve-later), the durable MarketplaceOrder saga ledger (one-live-
order-per-slot, transition guards, slot-free-on-abandon/reject), the connected-
agent-key auth gate, the company scope gate on claim/submit, the grant-time
remote dispatch, and the team_kernel grant/reject wiring.

Uses a real :class:`StateStore` on ``tmp_path`` and a fake ClawHuntClient so the
saga round-trips against persisted state with zero network.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.marketplace_commands import (
    MarketplaceAbandonCommand,
    MarketplaceBidCommand,
    MarketplaceBrowseCommand,
    MarketplaceClaimCommand,
    MarketplaceInspectCommand,
    MarketplacePostTaskCommand,
    MarketplaceSubmitCommand,
)
from superclaw import marketplace_handler
from superclaw.marketplace_handler import (
    MarketplaceAuthError,
    apply_marketplace_command,
    execute_marketplace_command,
)
from superclaw.marketplace_risk import classify_marketplace_action
from superclaw.models import (
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    CompanyStatus,
    EvidenceBundle,
    IssueStatus,
    MarketplaceOrder,
    MarketplaceOrderStatus,
)
from superclaw.state import StateStore


# --- fakes / helpers ---------------------------------------------------------


class _Settings:
    def __init__(self, agent_api_key, base_url="https://clawhunt.test"):
        self.agent_api_key = agent_api_key
        self.base_url = base_url


class FakeClawHuntClient:
    """In-process ClawHuntClient stand-in: records calls, returns canned results."""

    def __init__(self, *, agent_api_key="cph_test", base_url="https://clawhunt.test",
                 claim_ok=True, submit_ok=True, post_ok=True, bid_ok=True,
                 claim_raises=False, submit_raises=False,
                 claim_fail_status=409, submit_fail_status=400):
        self.settings = _Settings(agent_api_key, base_url)
        self.claim_ok = claim_ok
        self.submit_ok = submit_ok
        self.post_ok = post_ok
        self.bid_ok = bid_ok
        self.claim_raises = claim_raises
        self.submit_raises = submit_raises
        # Default failure statuses are 4xx (definitive); tests pass 5xx to exercise
        # the ambiguous → BLOCKED path.
        self.claim_fail_status = claim_fail_status
        self.submit_fail_status = submit_fail_status
        self.calls: list[tuple] = []

    def browse(self, *, skip=0, limit=50, status=None):
        self.calls.append(("browse", skip, limit, status))
        return {"ok": True, "status_code": 200,
                "body": {"problems": [{"id": 1}, {"id": 2}, {"id": 3}]}}

    def get_problem(self, problem_id):
        self.calls.append(("get_problem", problem_id))
        return {"ok": True, "status_code": 200,
                "body": {"id": problem_id, "secret_repo": "git@private"}}

    def claim(self, problem_id):
        self.calls.append(("claim", problem_id))
        if self.claim_raises:
            raise ConnectionError("simulated network timeout")
        return {"ok": self.claim_ok,
                "status_code": 200 if self.claim_ok else self.claim_fail_status, "body": {}}

    def submit_solution(self, problem_id, solution, evidence=None, *, attachments=None):
        self.calls.append(("submit_solution", problem_id, solution, attachments))
        if self.submit_raises:
            raise ConnectionError("simulated network timeout")
        return {"ok": self.submit_ok,
                "status_code": 200 if self.submit_ok else self.submit_fail_status,
                "body": {"accepted": self.submit_ok}}

    def post_problem(self, payload):
        self.calls.append(("post_problem", payload))
        return {"ok": self.post_ok, "status_code": 200 if self.post_ok else 400,
                "body": {"id": 99}}

    def bid(self, problem_id, amount=None, message=""):
        self.calls.append(("bid", problem_id, amount, message))
        return {"ok": self.bid_ok, "status_code": 200, "body": {}}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme", status=CompanyStatus.ACTIVE.value):
    company = CompanyProfile(name=name, status=status)
    store.save_company_profile(company)
    return company


def _scope(company_id, *, principal_id="op_1", is_admin=True, allowed=None):
    return CompanyScope(
        principal_id=principal_id,
        actor_company_id=company_id,
        allowed_company_ids=frozenset(allowed or ()),
        is_admin=is_admin,
    )


def _factory(client):
    return lambda: client


# --- risk classification -----------------------------------------------------


def test_reads_are_low_writes_are_high():
    assert not classify_marketplace_action(MarketplaceBrowseCommand()).is_high
    assert not classify_marketplace_action(MarketplaceInspectCommand(problem_id="1")).is_high
    for cmd in (
        MarketplacePostTaskCommand(title="t", description="d"),
        MarketplaceBidCommand(problem_id="1"),
        MarketplaceClaimCommand(problem_id="1", company_profile_id="c"),
        MarketplaceSubmitCommand(order_id="o"),
        MarketplaceAbandonCommand(order_id="o"),
    ):
        assert classify_marketplace_action(cmd).is_high, cmd


def test_unknown_command_is_high():
    class _Weird:
        pass

    assert classify_marketplace_action(_Weird()).is_high


# --- command validation (fail-closed) ----------------------------------------


def test_browse_validation_rejects_bad_status_and_limits():
    with pytest.raises(ValueError):
        MarketplaceBrowseCommand(status="not-a-status").validate()
    with pytest.raises(ValueError):
        MarketplaceBrowseCommand(limit=0).validate()
    with pytest.raises(ValueError):
        MarketplaceBrowseCommand(limit=999).validate()
    with pytest.raises(ValueError):
        MarketplaceBrowseCommand(skip=-1).validate()


def test_problem_id_validation_rejects_bool_and_blank():
    with pytest.raises(ValueError):
        MarketplaceInspectCommand(problem_id="").validate()
    with pytest.raises(ValueError):
        MarketplaceInspectCommand(problem_id=True).validate()  # bool is not an int id
    # positive int and non-blank str are both fine
    MarketplaceInspectCommand(problem_id=5).validate()
    MarketplaceInspectCommand(problem_id="5").validate()


def test_post_task_requires_positive_price():
    with pytest.raises(ValueError):
        MarketplacePostTaskCommand(title="t", description="d", price=0).validate()
    with pytest.raises(ValueError):
        MarketplacePostTaskCommand(title="", description="d").validate()


def test_strict_from_dict_rejects_unknown_fields():
    with pytest.raises(ValueError):
        MarketplaceClaimCommand.from_dict(
            {"problem_id": "1", "company_profile_id": "c", "evil": 1}
        )


# --- auth gate ---------------------------------------------------------------


def test_no_agent_key_is_fail_closed_even_for_reads(store):
    company = _company(store)
    client = FakeClawHuntClient(agent_api_key=None)
    with pytest.raises(MarketplaceAuthError):
        execute_marketplace_command(
            MarketplaceBrowseCommand(),
            scope=_scope(company.company_profile_id),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )
    # never dispatched the read
    assert client.calls == []


def test_blank_agent_key_rejected(store):
    company = _company(store)
    client = FakeClawHuntClient(agent_api_key="   ")
    with pytest.raises(MarketplaceAuthError):
        execute_marketplace_command(
            MarketplaceInspectCommand(problem_id="1"),
            scope=_scope(company.company_profile_id),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )


# --- read dispatch (LOW) -----------------------------------------------------


def test_browse_read_runs_now_and_counts(store):
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceBrowseCommand(status="open", limit=10),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    assert result.outcome == "executed"
    assert result.detail["count"] == 3
    assert result.detail["read"] == "browse"
    assert ("browse", 0, 10, "open") in client.calls


def test_browse_counts_nested_data_envelope_and_surfaces_has_more(store):
    """ClawHunt also returns the list NESTED under a `data`/`result` envelope. The
    count must recurse into it (a list-only walk returned 0 here) and surface the
    authoritative upstream `has_more` so "how many orders" is honest."""

    class _NestedClient:
        settings = _Settings("cph_test")

        def browse(self, *, skip=0, limit=50, status=None):
            return {
                "ok": True, "status_code": 200,
                "body": {"success": True, "data": {
                    "problems": [{"id": 1, "title": "a"}, {"id": 2, "title": "b"}],
                    "has_more": True,
                }},
            }

    company = _company(store)
    result = execute_marketplace_command(
        MarketplaceBrowseCommand(limit=2),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=lambda: _NestedClient(),
    )
    assert result.detail["count"] == 2  # NOT 0 — recurses the nested envelope
    assert result.detail["has_more"] is True  # authoritative upstream signal


def test_browse_failure_reports_zero_not_a_fabricated_count(store):
    """A non-OK browse must NOT fabricate an order count from an error envelope that
    happens to carry a `problems`/`has_more` key (Codex#2). It reports 0 / no-more —
    exactly like the dock — so "how many orders" is never misleading on failure."""

    class _FailingClient:
        settings = _Settings("cph_test")

        def browse(self, *, skip=0, limit=50, status=None):
            return {
                "ok": False, "status_code": 502,
                # An error envelope that deceptively carries list-shaped data.
                "body": {"detail": "upstream down", "problems": [{"id": 1, "title": "x"}],
                         "has_more": True},
            }

    company = _company(store)
    result = execute_marketplace_command(
        MarketplaceBrowseCommand(limit=2),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=lambda: _FailingClient(),
    )
    assert result.detail["ok"] is False
    assert result.detail["count"] == 0  # NOT 1 — failure never fabricates a count
    assert result.detail["has_more"] is False
    assert result.detail["body"] is not None  # raw body kept for diagnostics


def test_inspect_uses_agent_gated_detail(store):
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceInspectCommand(problem_id="7"),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    assert result.outcome == "executed"
    # privileged (agent-gated) detail, NOT a public payload
    assert result.detail["body"]["secret_repo"] == "git@private"
    assert ("get_problem", "7") in client.calls


# --- scope gate on claim -----------------------------------------------------


def test_claim_out_of_scope_company_forbidden(store):
    home = _company(store, name="Home")
    other = _company(store, name="Other")
    client = FakeClawHuntClient()
    # actor is scoped to Home only (not admin, no allowed extras)
    with pytest.raises(CompanyScopeError):
        execute_marketplace_command(
            MarketplaceClaimCommand(problem_id="1", company_profile_id=other.company_profile_id),
            scope=_scope(home.company_profile_id, is_admin=False),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )


def test_claim_frozen_company_forbidden(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    client = FakeClawHuntClient()
    with pytest.raises(Exception):  # CompanyFrozenError
        execute_marketplace_command(
            MarketplaceClaimCommand(problem_id="1", company_profile_id=company.company_profile_id),
            scope=_scope(company.company_profile_id),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )


# --- claim write: reserve order + approval, no remote call yet ----------------


def test_claim_reserves_order_and_pends_approval_without_remote_call(store):
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    assert result.outcome == "pending_approval"
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value
    assert order.company_profile_id == company.company_profile_id
    assert order.claim_approval_id == result.detail["approval_id"]
    # the remote claim must NOT have happened on the default path
    assert all(call[0] != "claim" for call in client.calls)
    approval = store.get_approval(result.detail["approval_id"])
    assert approval.type == ApprovalType.MARKETPLACE_COMMAND.value
    assert approval.status == ApprovalStatus.PENDING.value


def test_double_claim_same_problem_refused(store):
    company = _company(store)
    client = FakeClawHuntClient()

    def _claim():
        return execute_marketplace_command(
            MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
            scope=_scope(company.company_profile_id),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )

    _claim()
    with pytest.raises(ValueError):
        _claim()  # live slot already held → refused, not merged


# --- grant-time apply: remote claim + ledger advance --------------------------


def test_grant_claim_calls_remote_and_advances_to_claimed_remote(store):
    company = _company(store)
    client = FakeClawHuntClient(claim_ok=True)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.CLAIMED_REMOTE.value
    assert ("claim", "42") in client.calls
    # captured the privileged snapshot
    assert order.problem_snapshot.get("secret_repo") == "git@private"


def test_grant_claim_remote_failure_settles_without_zombie(store):
    """A definitive remote claim rejection settles the order (claim_failed, slot
    freed) and RETURNS — it must NOT raise, so decide_approval can finish and no
    zombie PENDING approval is left pointing at a terminal order (advisor阻断项 4)."""
    company = _company(store)
    client = FakeClawHuntClient(claim_ok=False)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["claimed"] is False
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.CLAIM_FAILED.value
    # slot freed → a fresh claim may now re-take it (no deadlock, no zombie)
    assert store.get_live_marketplace_order_for_problem(
        base_url="https://clawhunt.test", problem_id="42"
    ) is None


def test_reclaim_after_remote_failure_succeeds(store, monkeypatch):
    """End-to-end: a failed claim through decide_approval leaves the approval
    settled (not PENDING) and the slot free, so a brand-new claim works."""
    company = _company(store)
    client = FakeClawHuntClient(claim_ok=False)
    monkeypatch.setattr(marketplace_handler, "_default_client_factory", lambda: client)
    first = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    # grant the (doomed) claim — decide_approval must NOT raise; approval settles.
    team_kernel.decide_approval(store, first.detail["approval_id"], approved=True)
    assert store.get_approval(first.detail["approval_id"]).status == ApprovalStatus.APPROVED.value
    # a fresh claim on the freed slot is accepted
    good = FakeClawHuntClient(claim_ok=True)
    second = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(good),
    )
    assert second.detail["order_id"] != first.detail["order_id"]


# --- reject hook frees the slot ----------------------------------------------


def test_reject_claim_approval_frees_slot(store, monkeypatch):
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    team_kernel.decide_approval(store, result.detail["approval_id"], approved=False)
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.CLAIM_FAILED.value


def test_grant_through_decide_approval_routes_to_handler(store, monkeypatch):
    company = _company(store)
    client = FakeClawHuntClient()
    # decide_approval's grant path builds a default client; inject the fake.
    monkeypatch.setattr(marketplace_handler, "_default_client_factory", lambda: client)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    team_kernel.decide_approval(store, result.detail["approval_id"], approved=True)
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.CLAIMED_REMOTE.value
    assert ("claim", "42") in client.calls


# --- submit lifecycle --------------------------------------------------------


def _bound_order_ready_to_submit(store, company, *, run_id="run_x", problem_id="42",
                                 issue_done=True):
    """Hand-build a ledger order advanced to ready_to_submit with a bound DONE issue
    + run + evidence — mirroring what the saga produces, so grant-time submit
    re-verification (issue done + run/order binding match + verdict) is satisfied."""
    from superclaw.models import Issue, IssueKind, ReviewPolicy, WorkspaceProfile

    order = MarketplaceOrder(
        problem_id=problem_id, base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value, run_id=run_id,
    )
    store.create_marketplace_order(order)
    # a bound delivery issue, stamped with this order id + its execution run
    ws = WorkspaceProfile(name="w", company_profile_id=company.company_profile_id)
    store.save_workspace_profile(ws)
    issue = Issue(
        title="delivery", kind=IssueKind.DELIVERY.value,
        review_policy=ReviewPolicy.HUMAN_FINAL.value,
        company_profile_id=company.company_profile_id, workspace_id=ws.workspace_id,
        status=(IssueStatus.DONE.value if issue_done else IssueStatus.IN_REVIEW.value),
        execution_run_id=run_id,
        metadata={"marketplace_order_id": order.order_id, "marketplace_run_id": run_id},
    )
    store.save_issue(issue)
    order.issue_id = issue.issue_id
    for nxt in (
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.REVIEW_PENDING.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
    ):
        order.status = nxt
        store.save_marketplace_order(order)
    bundle = EvidenceBundle(run_id=run_id)
    store.save_evidence(bundle)
    return store.get_marketplace_order(order.order_id)


def test_submit_arms_order_and_grant_pushes_evidence(store):
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id, solution_text="done"),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    assert result.outcome == "pending_approval"
    armed = store.get_marketplace_order(order.order_id)
    assert armed.status == MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value

    approval = store.get_approval(result.detail["approval_id"])
    apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    done = store.get_marketplace_order(order.order_id)
    assert done.status == MarketplaceOrderStatus.SUBMITTED.value
    assert any(call[0] == "submit_solution" for call in client.calls)


def test_submit_remote_failure_marks_submit_failed(store):
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient(submit_ok=False)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["submitted"] is False
    failed = store.get_marketplace_order(order.order_id)
    assert failed.status == MarketplaceOrderStatus.SUBMIT_FAILED.value


def test_submit_out_of_scope_order_forbidden(store):
    home = _company(store, name="Home")
    other = _company(store, name="Other")
    order = _bound_order_ready_to_submit(store, other)
    client = FakeClawHuntClient()
    with pytest.raises(CompanyScopeError):
        execute_marketplace_command(
            MarketplaceSubmitCommand(order_id=order.order_id),
            scope=_scope(home.company_profile_id, is_admin=False),
            store=store,
            requested_by="op_1",
            client_factory=_factory(client),
        )


# --- abandon (compensation) --------------------------------------------------


def test_abandon_blocks_order_and_retains_slot(store):
    """Without a remote release endpoint, abandon is fail-closed: the order goes to
    BLOCKED (not abandoned) and the slot stays HELD — we must not pretend a still-
    committed remote order is released (advisor阻断项 6)."""
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
    )
    store.create_marketplace_order(order)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceAbandonCommand(order_id=order.order_id, reason="run failed"),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
        client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    settled = store.get_marketplace_order(order.order_id)
    assert settled.status == MarketplaceOrderStatus.BLOCKED.value
    # slot RETAINED — the remote commitment is not provably released
    live = store.get_live_marketplace_order_for_problem(
        base_url="https://clawhunt.test", problem_id="42"
    )
    assert live is not None and live.order_id == order.order_id


def test_submit_on_not_ready_order_refused_without_approval(store):
    """A submit for an order that is not submit-ready must be refused up front, with
    NO approval created (advisor阻断项 5: no premature approval to ride a later state
    change into an unauthorized submission)."""
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value, run_id="run_x",
    )
    store.create_marketplace_order(order)
    client = FakeClawHuntClient()
    with pytest.raises(ValueError):
        execute_marketplace_command(
            MarketplaceSubmitCommand(order_id=order.order_id),
            scope=_scope(company.company_profile_id),
            store=store, requested_by="op_1", client_factory=_factory(client),
        )
    # no approval was created
    assert store.list_approvals() == []


def test_submit_frozen_company_refused(store):
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    # freeze the company after the order is ready
    company.status = CompanyStatus.FROZEN.value
    store.save_company_profile(company)
    client = FakeClawHuntClient()
    with pytest.raises(Exception):  # CompanyFrozenError
        execute_marketplace_command(
            MarketplaceSubmitCommand(order_id=order.order_id),
            scope=_scope(company.company_profile_id),
            store=store, requested_by="op_1", client_factory=_factory(client),
        )


def test_claim_idempotent_retry_returns_same_order(store):
    company = _company(store)
    client = FakeClawHuntClient()

    def _claim():
        return execute_marketplace_command(
            MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
            scope=_scope(company.company_profile_id),
            store=store, requested_by="op_1",
            client_factory=_factory(client), idempotency_key="retry-key-1",
        )

    first = _claim()
    second = _claim()  # same idempotency key → SAME order, not a double-claim error
    assert first.detail["order_id"] == second.detail["order_id"]
    assert first.detail["approval_id"] == second.detail["approval_id"]


def test_claim_order_and_approval_are_atomically_linked(store):
    """The reserved order and its approval are committed together: the order's
    claim_approval_id always points at a real, existing approval."""
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.claim_approval_id == result.detail["approval_id"]
    # the linked approval really exists
    assert store.get_approval(order.claim_approval_id).type == ApprovalType.MARKETPLACE_COMMAND.value


def test_grant_with_removed_agent_fails_closed(store):
    """A confined-agent claim approval must fail-closed at grant if the agent no
    longer exists — the frozen scope snapshot is never trusted (advisor阻断项 3)."""
    company = _company(store)
    client = FakeClawHuntClient()
    # agent-scoped request (is_admin=False, bound to an agent id that we never
    # create / will be "gone" by grant time)
    agent_scope = CompanyScope(
        principal_id="op_1",
        actor_company_id=company.company_profile_id,
        is_admin=False,
        actor_agent_profile_id="agent_gone",
    )
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=agent_scope,
        store=store, requested_by="agent_gone", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(CompanyScopeError):
        apply_marketplace_command(
            store, approval.resume_action,
            approval_id=approval.approval_id, client_factory=_factory(client),
        )


# --- ledger transition guard -------------------------------------------------


def test_illegal_saga_transition_rejected(store):
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value,
    )
    store.create_marketplace_order(order)
    # teleport straight to submitted (never claimed) → rejected
    order.status = MarketplaceOrderStatus.SUBMITTED.value
    with pytest.raises(ValueError):
        store.save_marketplace_order(order)


def test_save_unknown_order_raises_keyerror(store):
    order = MarketplaceOrder(
        problem_id="1", base_url="https://x", company_profile_id="c",
    )
    with pytest.raises(KeyError):
        store.save_marketplace_order(order)  # never created


# --- conflicting-approval race (Codex blocker) -------------------------------


def test_second_pending_approval_on_order_refused(store):
    """Once a submit approval is pending on an order, an abandon (or another
    submit) must be refused — at-most-one live marketplace approval per order
    serialises governance and kills the stale-approval race zombie."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient()
    # open a submit approval (arms order → submit_approval_pending)
    execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    # a competing abandon on the same order is refused, no second approval created
    with pytest.raises(ValueError):
        execute_marketplace_command(
            MarketplaceAbandonCommand(order_id=order.order_id),
            scope=_scope(company.company_profile_id),
            store=store, requested_by="op_1", client_factory=_factory(client),
        )
    pending = [a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)]
    assert len(pending) == 1


def test_blocked_order_cannot_jump_to_abandoned(store):
    """The slot-freeing ``abandoned`` terminal is unreachable from ``blocked`` via
    the generic save guard — only a future proven-remote-release path may free the
    slot (Codex blocker: no local bypass of the proven-release rule)."""
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.BLOCKED.value,
    )
    store.create_marketplace_order(order)
    order.status = MarketplaceOrderStatus.ABANDONED.value
    with pytest.raises(ValueError):
        store.save_marketplace_order(order)


def test_grant_submit_on_superseded_order_returns_without_zombie(store):
    """If the order moved out from under a submit approval (e.g. it was blocked),
    granting the submit settles as a superseded no-op rather than raising into a
    PENDING zombie."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    # move the order to BLOCKED behind the approval's back (legal edge)
    moved = store.get_marketplace_order(order.order_id)
    moved.status = MarketplaceOrderStatus.BLOCKED.value
    store.save_marketplace_order(moved)
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["submitted"] is False and out["superseded"] is True


def test_reject_in_flight_claiming_goes_blocked(store):
    """A reject of an in-flight CLAIMING order (crashed grant) settles to BLOCKED —
    NOT claim_failed: the remote outcome is ambiguous, so we retain the slot and
    park for reconciliation rather than assume "not claimed" (Codex)."""
    company = _company(store)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    # simulate a grant that persisted CLAIMING then crashed before resolving
    order = store.get_marketplace_order(result.detail["order_id"])
    order.status = MarketplaceOrderStatus.CLAIMING.value
    store.save_marketplace_order(order)
    team_kernel.decide_approval(store, result.detail["approval_id"], approved=False)
    settled = store.get_marketplace_order(result.detail["order_id"])
    assert settled.status == MarketplaceOrderStatus.BLOCKED.value
    # slot retained (ambiguous → fail-closed)
    assert store.get_live_marketplace_order_for_problem(
        base_url="https://clawhunt.test", problem_id="42"
    ) is not None


def test_grant_claim_ambiguous_network_error_blocks_and_retains_slot(store):
    """A network exception during a claim grant is AMBIGUOUS: the order parks in
    BLOCKED (slot retained), never claim_failed — we must not assume "not claimed"
    and risk a double-claim on retry (Codex blocker)."""
    company = _company(store)
    client = FakeClawHuntClient(claim_raises=True)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["claimed"] == "ambiguous" and out["blocked"] is True
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.BLOCKED.value
    # slot retained — do NOT free a slot whose remote state is unknown
    assert store.get_live_marketplace_order_for_problem(
        base_url="https://clawhunt.test", problem_id="42"
    ) is not None


def test_grant_submit_ambiguous_network_error_blocks(store):
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient(submit_raises=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["submitted"] == "ambiguous" and out["blocked"] is True
    assert store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.BLOCKED.value


def test_transactional_single_approval_blocks_second_abandon(store):
    """Two abandon requests on one order: the second is refused by the
    transactional one-live-approval-per-order constraint (Codex concurrency
    window), so only one pending approval exists."""
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
    )
    store.create_marketplace_order(order)
    client = FakeClawHuntClient()

    def _abandon():
        return execute_marketplace_command(
            MarketplaceAbandonCommand(order_id=order.order_id),
            scope=_scope(company.company_profile_id),
            store=store, requested_by="op_1", client_factory=_factory(client),
        )

    _abandon()
    with pytest.raises(ValueError):
        _abandon()
    assert len([a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)]) == 1


# --- re-grant idempotency + stale-revival (Codex round-4 blockers) ------------


def test_regrant_approved_claim_is_idempotent_noop(store, monkeypatch):
    """Granting an already-APPROVED claim approval a second time must NOT re-claim
    remotely — the approval-status guard makes re-grant a no-op (Codex)."""
    company = _company(store)
    client = FakeClawHuntClient(claim_ok=True)
    monkeypatch.setattr(marketplace_handler, "_default_client_factory", lambda: client)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    team_kernel.decide_approval(store, result.detail["approval_id"], approved=True)
    claims_after_first = [c for c in client.calls if c[0] == "claim"]
    assert len(claims_after_first) == 1
    # re-grant the same (now APPROVED) approval — must be a no-op, no second claim
    team_kernel.decide_approval(store, result.detail["approval_id"], approved=True)
    claims_after_second = [c for c in client.calls if c[0] == "claim"]
    assert len(claims_after_second) == 1  # NOT re-claimed
    assert store.get_marketplace_order(result.detail["order_id"]).status == \
        MarketplaceOrderStatus.CLAIMED_REMOTE.value


def test_stale_submit_approval_superseded_after_blocked_ready_cycle(store):
    """A pending submit approval that the order cycled away from (submit_approval_
    pending → blocked → ready_to_submit) must NOT submit when granted — it is
    superseded, because the order is no longer armed for THIS approval (Codex)."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient()
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    # order is now submit_approval_pending; cycle it blocked → ready_to_submit
    o = store.get_marketplace_order(order.order_id)
    o.status = MarketplaceOrderStatus.BLOCKED.value
    store.save_marketplace_order(o)
    o = store.get_marketplace_order(order.order_id)
    o.status = MarketplaceOrderStatus.READY_TO_SUBMIT.value
    store.save_marketplace_order(o)
    # grant the stale approval → must be superseded, NO remote submit
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["submitted"] is False and out["superseded"] is True
    assert all(c[0] != "submit_solution" for c in client.calls)


def _order_ready_with_issue(store, company, *, issue_status, verdict_fail=False,
                            run_id="run_y", problem_id="55"):
    """Build a ready_to_submit order bound to a real issue (in a given status) +
    run evidence, with the issue stamped with the order id + execution run (so the
    grant-time binding-consistency checks are exercised), for the re-verification tests."""
    from superclaw.models import Issue, IssueKind, ReviewPolicy, WorkspaceProfile, VerificationFinding

    ws = WorkspaceProfile(name="w", company_profile_id=company.company_profile_id)
    store.save_workspace_profile(ws)
    order = MarketplaceOrder(
        problem_id=problem_id, base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value, run_id=run_id,
    )
    store.create_marketplace_order(order)
    issue = Issue(title="t", kind=IssueKind.DELIVERY.value,
                  review_policy=ReviewPolicy.HUMAN_FINAL.value,
                  company_profile_id=company.company_profile_id, workspace_id=ws.workspace_id,
                  status=issue_status, execution_run_id=run_id,
                  metadata={"marketplace_order_id": order.order_id, "marketplace_run_id": run_id})
    store.save_issue(issue)
    order.issue_id = issue.issue_id
    for nxt in (MarketplaceOrderStatus.ISSUE_BOUND.value, MarketplaceOrderStatus.RUN_STARTED.value,
                MarketplaceOrderStatus.REVIEW_PENDING.value, MarketplaceOrderStatus.READY_TO_SUBMIT.value):
        order.status = nxt
        store.save_marketplace_order(order)
    bundle = EvidenceBundle(run_id=run_id)
    if verdict_fail:
        bundle.findings.append(VerificationFinding(name="adv", passed=False, detail="fail"))
    store.save_evidence(bundle)
    return store.get_marketplace_order(order.order_id)


def test_submit_grant_refuses_if_issue_not_done(store):
    """B5: grant-time submit re-verifies the bound issue passed its completion gate —
    an issue not `done` must NOT submit even if the ledger says ready_to_submit."""
    from superclaw.models import IssueStatus

    company = _company(store)
    order = _order_ready_with_issue(store, company, issue_status=IssueStatus.IN_REVIEW.value)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(RuntimeError):
        apply_marketplace_command(store, approval.resume_action,
                                  approval_id=approval.approval_id, client_factory=_factory(client))
    assert all(c[0] != "submit_solution" for c in client.calls)


def test_submit_grant_refuses_on_fail_verdict(store):
    """B5: grant-time submit refuses a run whose evidence verdict is FAIL."""
    from superclaw.models import IssueStatus

    company = _company(store)
    order = _order_ready_with_issue(store, company, issue_status=IssueStatus.DONE.value,
                                    verdict_fail=True)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(RuntimeError):
        apply_marketplace_command(store, approval.resume_action,
                                  approval_id=approval.approval_id, client_factory=_factory(client))
    assert all(c[0] != "submit_solution" for c in client.calls)


def test_submit_grant_refuses_without_bound_issue(store):
    """B5: a submittable marketplace order MUST have a bound delivery issue; an
    order with no issue_id is ungoverned (no completion gate) → refuse."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    # strip the bound issue (simulate an ungoverned/hand-built order)
    o = store.get_marketplace_order(order.order_id)
    o.issue_id = None
    store.save_marketplace_order(o)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(RuntimeError):
        apply_marketplace_command(store, approval.resume_action,
                                  approval_id=approval.approval_id, client_factory=_factory(client))
    assert all(c[0] != "submit_solution" for c in client.calls)


def test_submit_grant_refuses_on_run_mismatch(store):
    """B5: refuse if the bound issue's execution run ≠ the order's run (stale splice)."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company, run_id="run_x")
    # tamper: point the order at a different run than the issue's execution run
    o = store.get_marketplace_order(order.order_id)
    o.run_id = "run_OTHER"
    store.save_marketplace_order(o)
    store.save_evidence(EvidenceBundle(run_id="run_OTHER"))
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(RuntimeError):
        apply_marketplace_command(store, approval.resume_action,
                                  approval_id=approval.approval_id, client_factory=_factory(client))
    assert all(c[0] != "submit_solution" for c in client.calls)


def test_submit_grant_refuses_on_metadata_mismatch(store):
    """B5: refuse if the bound issue is not stamped with THIS order id."""
    from superclaw.models import Issue, IssueKind, ReviewPolicy, WorkspaceProfile

    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    # rebind to an issue stamped with a DIFFERENT order id
    ws = WorkspaceProfile(name="w2", company_profile_id=company.company_profile_id)
    store.save_workspace_profile(ws)
    # The foreign issue passes the run-binding check (marketplace_run_id matches the
    # order's run) AND is done — so the ONLY thing that refuses it is the order-id
    # binding (marketplace_order_id ≠ this order). This isolates the order_id guard.
    foreign = Issue(title="foreign", kind=IssueKind.DELIVERY.value,
                    review_policy=ReviewPolicy.HUMAN_FINAL.value,
                    company_profile_id=company.company_profile_id, workspace_id=ws.workspace_id,
                    status=IssueStatus.DONE.value, execution_run_id="run_x",
                    metadata={"marketplace_order_id": "order_SOMEONE_ELSE",
                              "marketplace_run_id": "run_x"})
    store.save_issue(foreign)
    o = store.get_marketplace_order(order.order_id)
    o.issue_id = foreign.issue_id
    store.save_marketplace_order(o)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    with pytest.raises(RuntimeError):
        apply_marketplace_command(store, approval.resume_action,
                                  approval_id=approval.approval_id, client_factory=_factory(client))
    assert all(c[0] != "submit_solution" for c in client.calls)


def test_submit_grant_proceeds_when_issue_done_and_verdict_ok(store):
    """B5: with the bound issue done AND a non-FAIL verdict, submit proceeds."""
    from superclaw.models import IssueStatus

    company = _company(store)
    order = _order_ready_with_issue(store, company, issue_status=IssueStatus.DONE.value)
    client = FakeClawHuntClient(submit_ok=True)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(store, approval.resume_action,
                                    approval_id=approval.approval_id, client_factory=_factory(client))
    assert out["submitted"] is True
    assert store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.SUBMITTED.value


def test_claim_5xx_is_ambiguous_blocked_not_failed(store):
    """A 5xx claim response is ambiguous (server may have committed) → BLOCKED, slot
    retained — never claim_failed which would free a possibly-held slot (AGY)."""
    company = _company(store)
    client = FakeClawHuntClient(claim_ok=False, claim_fail_status=503)
    result = execute_marketplace_command(
        MarketplaceClaimCommand(problem_id="42", company_profile_id=company.company_profile_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["claimed"] == "ambiguous"
    order = store.get_marketplace_order(result.detail["order_id"])
    assert order.status == MarketplaceOrderStatus.BLOCKED.value
    assert store.get_live_marketplace_order_for_problem(
        base_url="https://clawhunt.test", problem_id="42"
    ) is not None


def test_submit_5xx_is_ambiguous_blocked(store):
    """A 5xx submit response is ambiguous (the remote may have accepted) → BLOCKED,
    not submit_failed (which a fresh submit could re-attempt)."""
    company = _company(store)
    order = _bound_order_ready_to_submit(store, company)
    client = FakeClawHuntClient(submit_ok=False, submit_fail_status=503)
    result = execute_marketplace_command(
        MarketplaceSubmitCommand(order_id=order.order_id),
        scope=_scope(company.company_profile_id),
        store=store, requested_by="op_1", client_factory=_factory(client),
    )
    approval = store.get_approval(result.detail["approval_id"])
    out = apply_marketplace_command(
        store, approval.resume_action,
        approval_id=approval.approval_id, client_factory=_factory(client),
    )
    assert out["submitted"] == "ambiguous"
    assert store.get_marketplace_order(order.order_id).status == MarketplaceOrderStatus.BLOCKED.value


def test_ambiguous_status_classification():
    """Only a clean 4xx (except 408) is definitive; everything else is ambiguous."""
    from superclaw.marketplace_handler import _is_ambiguous_status

    # definitive client rejections (free the slot)
    for code in (400, 401, 403, 404, 409, 422, 499):
        assert _is_ambiguous_status(code) is False, code
    # ambiguous (retain the slot, fail-closed)
    for code in (408, 500, 502, 503, 504, 200, 300, None, "oops", -1):
        assert _is_ambiguous_status(code) is True, code


def test_idempotent_retry_with_missing_approval_fails_closed(store):
    """A corrupt ledger (live order whose claim_approval_id row is gone) must
    fail-closed on an idempotent retry, never hand back an unsaved approval."""
    company = _company(store)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        idempotency_key="k1", claim_approval_id="approval_gone",
    )
    store.create_marketplace_order(order)
    from superclaw.models import Approval as _Approval

    retry = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id, idempotency_key="k1",
    )
    with pytest.raises(RuntimeError):
        store.create_marketplace_claim(retry, _Approval(type="marketplace_command"))
