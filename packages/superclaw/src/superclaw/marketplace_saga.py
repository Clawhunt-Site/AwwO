"""Marketplace order saga: claim → company delivery → completion gate → submit-ready.

The bridge that turns a CLAIMED ClawHunt order into a verifiable company delivery
(advisor阻断项: "接单 = 一次可验收交付", problem ↔ order ↔ issue ↔ run aligned). It
drives the durable :class:`~superclaw.models.MarketplaceOrder` ledger forward by
INSPECTING the bound issue/run state — idempotent and reconciler-friendly, so it
can be called from the CLI, the API, or a daemon reconcile tick without ever
double-acting:

  claimed_remote → (create company delivery Issue)        → issue_bound
  issue_bound    → (start delivery run, bind to issue)     → run_started
  run_started    → run completed → (submit_for_review:      → review_pending
                    opens the issue COMPLETION human gate)
                 → run failed                               → run_failed
  review_pending → issue passed its completion gate (done) → ready_to_submit

The delivery run uses the EXISTING orchestrator engine (multi-role E→P→I→V→R +
verifier + evidence), scoped to the order's company via ``execution_context_extra``
— that is how "company 作为底座调用多个 Agent" is realised: the company is the org
context (budget/policy/attribution) and the run is the multi-agent engine. No
parallel execution path is invented.

Two human gates, by design (money-bearing): (1) the issue COMPLETION gate — accept
the delivery as done (review_policy ``human_final``); (2) the marketplace SUBMIT
gate — approve sending the evidence to ClawHunt (HIGH, in marketplace_handler).
The saga only reaches ``ready_to_submit`` AFTER the issue is ``done`` — so
"completed run" never auto-implies "submittable" (advisor阻断项 6: completion gate ≠
submission gate).

This module performs NO remote ClawHunt calls (claim/submit live in
marketplace_handler, human-gated). It only orchestrates local kernel state +
starts a local run. Operator authority: the saga acts as the operator (the human
who approved the claim), so it may move the delivery issue through its lifecycle
without an agent checkout lock — the order ledger's one-live-slot invariant already
serialises work per problem.
"""

from __future__ import annotations

from typing import Any

from superclaw.models import (
    ChainVerdict,
    Issue,
    IssueKind,
    IssueStatus,
    MarketplaceOrder,
    MarketplaceOrderStatus,
    ReviewPolicy,
    RunStatus,
    TERMINAL_RUN_STATUSES,
    WorkspaceKind,
    WorkspaceProfile,
    WorkspaceTrustStatus,
    _id,
)
from superclaw.state import StateStore


def advance_hint(status: str) -> str:
    """Operator-facing next-step hint for an order's saga status.

    Single source for BOTH the CLI (`marketplace advance`) and the API
    (`/api/marketplace/orders/advance`) response, so the two surfaces never drift
    on what they tell the operator to do next (CLAUDE.md 铁律: zero divergence).
    """
    return {
        MarketplaceOrderStatus.RUN_STARTED.value:
            "delivery run finished; re-run advance to open the completion gate",
        MarketplaceOrderStatus.REVIEW_PENDING.value:
            "accept the issue-completion approval (`superclaw approve grant <id>`), "
            "then re-run advance",
        MarketplaceOrderStatus.READY_TO_SUBMIT.value:
            "ready — submit with `superclaw marketplace submit <order_id>`",
        MarketplaceOrderStatus.RUN_FAILED.value:
            "delivery run failed; inspect the run, then abandon the order if giving up",
        MarketplaceOrderStatus.BLOCKED.value:
            "order is blocked (ambiguous remote state / no agent / no release "
            "endpoint); needs reconciliation",
    }.get(status, "")


def ensure_company_workspace(
    store: StateStore, company_profile_id: str, *, repo_path: str = "."
) -> WorkspaceProfile:
    """Return the company's delivery workspace, creating a MANAGED one if absent.

    A delivery Issue needs a workspace (the execution/trust boundary). A company
    created for marketplace work may have none yet; rather than fail, we provision
    a MANAGED (app-owned, trusted-by-construction) workspace for it. Reuses the
    first existing workspace if the company already has one (deterministic).
    """
    existing = store.list_workspace_profiles(company_profile_id=company_profile_id)
    if existing:
        return existing[0]
    workspace = WorkspaceProfile(
        name=f"marketplace delivery ({company_profile_id})",
        company_profile_id=company_profile_id,
        repo_path=repo_path,
        kind=WorkspaceKind.MANAGED.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        trust_source="managed",
    )
    return store.save_workspace_profile(workspace)


def advance_marketplace_order(
    store: StateStore,
    order_id: str,
    *,
    orchestrator: Any,
    requested_by: str = "local_user",
    repo_path: str = ".",
    backend_policy: str = "claude",
    budget_seconds: int = 60,
) -> MarketplaceOrder:
    """Drive one order forward as far as its bound state allows (idempotent).

    Returns the (possibly-unchanged) order. Safe to call repeatedly / from a
    reconciler: each phase only acts when the order is exactly in that phase, and
    every kernel write goes through the saga transition guard. ``orchestrator`` is
    only needed for the ``issue_bound`` → ``run_started`` step (starting the run);
    pass the real orchestrator from a surface, or a fake in tests.
    """
    order = store.get_marketplace_order(order_id)
    if order.status == MarketplaceOrderStatus.CLAIMED_REMOTE.value:
        return _bind_delivery_issue(store, order, requested_by=requested_by, repo_path=repo_path)
    if order.status == MarketplaceOrderStatus.ISSUE_BOUND.value:
        return _start_delivery_run(
            store, order, orchestrator=orchestrator, requested_by=requested_by,
            repo_path=repo_path, backend_policy=backend_policy, budget_seconds=budget_seconds,
        )
    if order.status == MarketplaceOrderStatus.RUN_STARTED.value:
        return _observe_run(store, order, requested_by=requested_by)
    if order.status == MarketplaceOrderStatus.REVIEW_PENDING.value:
        return _observe_completion(store, order)
    # claim_approval_pending / claiming / ready_to_submit / submit_* / blocked /
    # terminal: nothing the saga drives automatically (waiting on a human gate, a
    # remote call, or already settled). Return as-is.
    return order


def _block(store: StateStore, order: MarketplaceOrder, reason: str) -> MarketplaceOrder:
    """Move an order to BLOCKED with a reason (recoverable; needs a human)."""
    order.status = MarketplaceOrderStatus.BLOCKED.value
    order.last_error = reason
    return store.save_marketplace_order(order)


def _bind_delivery_issue(
    store: StateStore, order: MarketplaceOrder, *, requested_by: str, repo_path: str
) -> MarketplaceOrder:
    """claimed_remote → create the company delivery Issue (assigned to a company
    agent), bind it atomically, → issue_bound.

    The delivery is owned by the company and EXECUTED BY ITS AGENT — that is the
    "company 作为底座调用 Agent" core. We assign the delivery issue to a company
    agent so the kernel's ``checkout_issue`` (hold/budget/secret/workspace-lock
    gates) governs the run (advisor阻断项 3). Fail-closed: a company with no agent
    cannot deliver → BLOCKED with a "hire an agent" hint (recoverable). The create +
    bind is atomic (``bind_marketplace_delivery_issue``) so concurrent advances can
    never orphan a duplicate issue (advisor阻断项 1).
    """
    agents = store.list_agent_profiles(company_profile_id=order.company_profile_id)
    if not agents:
        return _block(
            store, order,
            "company has no agent to deliver this order; hire one then re-advance",
        )
    agent = agents[0]
    snapshot = order.problem_snapshot if isinstance(order.problem_snapshot, dict) else {}
    title = str(snapshot.get("title") or f"ClawHunt order {order.problem_id}")
    description = str(snapshot.get("description") or snapshot.get("summary") or "")
    workspace = ensure_company_workspace(
        store, order.company_profile_id, repo_path=repo_path
    )
    issue = Issue(
        title=f"[marketplace] {title}",
        description=description,
        kind=IssueKind.DELIVERY.value,
        # human_final: a person accepts the delivery before it can be submitted —
        # the first of the two money-bearing human gates.
        review_policy=ReviewPolicy.HUMAN_FINAL.value,
        company_profile_id=order.company_profile_id,
        workspace_id=workspace.workspace_id,
        # Assigned + ready-to-work (TODO): checkout_issue requires an assignee, and
        # TODO → in_progress is the legal checkout edge.
        assignee_agent_profile_id=agent.profile_id,
        status=IssueStatus.TODO.value,
        created_by=requested_by,
        owner_id=requested_by,
        metadata={
            "marketplace_order_id": order.order_id,
            "clawhunt_problem_id": order.problem_id,
            "clawhunt_base_url": order.base_url,
        },
    )
    bound, _created = store.bind_marketplace_delivery_issue(order.order_id, issue)
    return bound


def _start_delivery_run(
    store: StateStore,
    order: MarketplaceOrder,
    *,
    orchestrator: Any,
    requested_by: str,
    repo_path: str,
    backend_policy: str,
    budget_seconds: int,
) -> MarketplaceOrder:
    """issue_bound → checkout the issue (kernel gates + lock), run the delivery,
    anchor the run → run_started.

    Mirrors the daemon's race-safe sequence (advisor阻断项 3, daemon.service_once):
    ``checkout_issue`` (hold/assignee/secret/budget gates + durable workspace lock —
    the lock serialises concurrent advances, closing the run-start race of 阻断项 1)
    → ``run_goal`` carrying the assignee agent's charter/model/equipment (the company
    agent does the work) → ``anchor_run_on_issue`` CAS (records the run only if the
    issue is still on THIS claim). The run is synchronous here (operator-driven, like
    the daemon); a held / requeued issue is respected, never clobbered.
    """
    from superclaw import team_kernel

    if not order.issue_id:
        raise ValueError(f"order {order.order_id} has no bound issue to run")
    issue = store.get_issue(order.issue_id)
    if not issue.assignee_agent_profile_id:
        return _block(store, order, "delivery issue has no assignee; cannot checkout")
    agent_id = issue.assignee_agent_profile_id

    # Checkout claim token (ownership lock id), distinct from the execution run id.
    token = _id("mktco")
    try:
        issue = team_kernel.checkout_issue(
            store, issue.issue_id, run_id=token, holder=agent_id,
            expected_assignee=agent_id,
        )
    except team_kernel.IssueHeldError:
        return _block(store, order, "delivery issue is on hold; release it then re-advance")
    except team_kernel.ReassignedError:
        return _block(store, order, "delivery issue was reassigned; re-advance to re-checkout")
    except Exception as exc:  # noqa: BLE001 - workspace locked / budget / secret gate
        # Recoverable defer: stay issue_bound (a re-advance retries once the lock
        # frees / budget restores). A CONCURRENT advance may already have won the
        # checkout and moved the order to run_started; re-read and only persist the
        # last_error if the order is STILL issue_bound (else return the winner's
        # state) — never save a stale issue_bound over run_started, which would hit
        # the transition guard and raise (advisor阻断项, Codex: must be benign no-op).
        fresh = store.get_marketplace_order(order.order_id)
        if fresh.status == MarketplaceOrderStatus.ISSUE_BOUND.value:
            fresh.last_error = f"checkout deferred: {type(exc).__name__}: {exc}"
            return store.save_marketplace_order(fresh)
        return fresh

    try:
        # run_goal creates its own goal from title/description (no separate
        # create_goal). The delivery's requirements ride the issue (built from the
        # claimed problem's snapshot in _bind_delivery_issue).
        result = orchestrator.run_goal(
            title=issue.title,
            description=issue.description or issue.title,
            source="clawhunt",
            backend_policy=backend_policy,
            repo_path=repo_path,
            budget_seconds=budget_seconds,
            verification_policy="adversarial",
            agent_profile_id=agent_id,
            execution_context_extra={
                "company_profile_id": order.company_profile_id,
                "issue_id": order.issue_id,
                "marketplace_order_id": order.order_id,
            },
        )
    except Exception as exc:  # noqa: BLE001 - run launch failed
        try:
            team_kernel.abort_checkout(store, issue.issue_id, holder=agent_id)
        except Exception:  # pragma: no cover - best-effort unwind
            pass
        return _block(store, order, f"delivery run failed to launch: {type(exc).__name__}: {exc}")

    run_id = result.session.run_id
    # Anchor with CAS: record the run only if the issue is still on this claim. A
    # human who blocked/requeued the issue during the run wins; we never clobber.
    anchored = store.anchor_run_on_issue(
        issue.issue_id, run_id, expected_checkout_run_id=token
    )
    if anchored is None:
        return _block(
            store, order,
            f"issue moved during delivery run {run_id}; reconcile before retry",
        )

    # Stamp the delivery run id DURABLY into the issue metadata. The kernel clears
    # issue.execution_run_id when the issue completes (decide_approval), so submit's
    # binding re-check must NOT rely on that field — it reads this durable stamp
    # instead, so a delivery that passed its completion gate (issue done) can still
    # prove "the evidence I'm submitting is THIS order's run" (advisor阻断项, e2e).
    anchored.metadata = {**(anchored.metadata or {}), "marketplace_run_id": run_id}
    store.save_issue(anchored)

    order.run_id = run_id
    order.status = MarketplaceOrderStatus.RUN_STARTED.value
    return store.save_marketplace_order(order)


def _observe_run(
    store: StateStore, order: MarketplaceOrder, *, requested_by: str
) -> MarketplaceOrder:
    """run_started → completed+verdict-not-FAIL: open the completion gate; completed
    but verify FAIL, or failed/cancelled: run_failed. Still running: no-op.

    A ``completed`` run is NOT automatically deliverable (advisor阻断项 2): the
    adversarial verifier's ``chain_verdict == FAIL`` means the delivery did not pass,
    so it must NOT open the acceptance gate. Only a non-FAIL verdict proceeds to
    ``submit_for_review`` — and the order advances to ``review_pending`` ONLY IF that
    open actually succeeded (advisor阻断项 4): a held / claim-changed issue leaves the
    order put (BLOCKED), never a phantom review_pending with no approval.
    """
    from superclaw import team_kernel

    if not order.run_id:
        raise ValueError(f"order {order.order_id} has no bound run to observe")
    run = store.get_run(order.run_id)
    if run.status not in TERMINAL_RUN_STATUSES:
        return order  # still running — nothing to advance yet

    if run.status != RunStatus.COMPLETED.value:
        order.status = MarketplaceOrderStatus.RUN_FAILED.value
        order.last_error = f"delivery run {order.run_id} ended {run.status}"
        return store.save_marketplace_order(order)

    # Completed — gate on the verifier verdict, fail-closed on a FAIL (or missing) verdict.
    try:
        evidence = store.get_evidence(order.run_id)
        verdict = evidence.chain_verdict
    except KeyError:
        return _block(store, order, f"run {order.run_id} completed but has no evidence")
    if verdict == ChainVerdict.FAIL:
        order.status = MarketplaceOrderStatus.RUN_FAILED.value
        order.last_error = f"delivery run {order.run_id} verification verdict FAIL"
        return store.save_marketplace_order(order)

    # Open the issue COMPLETION human gate, bound to this checkout's claim token.
    issue = store.get_issue(order.issue_id) if order.issue_id else None
    if issue is None:
        return _block(store, order, "order has no bound issue to submit for review")
    if issue.status != IssueStatus.IN_PROGRESS.value:
        # A human blocked / requeued the issue. Do NOT fake review_pending (that
        # would deadlock with no approval). Block for reconciliation.
        return _block(
            store, order,
            f"delivery issue is {issue.status}, not in_progress; cannot open completion gate",
        )
    # Serialise the completion-gate open via an atomic order CAS (advisor阻断项,
    # Codex): two concurrent observers must not BOTH call submit_for_review and open
    # two pending ISSUE_COMPLETION approvals. Only the CAS winner (run_started →
    # review_pending) opens the gate; a loser sees review_pending and returns.
    won = store.cas_marketplace_order_status(
        order.order_id,
        expected=MarketplaceOrderStatus.RUN_STARTED.value,
        new=MarketplaceOrderStatus.REVIEW_PENDING.value,
    )
    if won is None:
        return store.get_marketplace_order(order.order_id)  # another observer won
    try:
        team_kernel.submit_for_review(
            store, issue.issue_id, requested_by=requested_by,
            summary="marketplace delivery run completed (verified); accept to enable submission",
            expected_checkout_run_id=issue.checkout_run_id,
        )
    except Exception as exc:  # noqa: BLE001 - the CAS already advanced the order
        # The CAS already moved the order to review_pending, but the gate could NOT
        # be opened. submit_for_review can fail in several ways — IssueHeldError,
        # ClaimChangedError, OR a ValueError if a human requeued the issue out of
        # in_progress between our status check and this call (advisor阻断项, Codex).
        # Catch ALL of them and settle to BLOCKED so we never leave a phantom
        # review_pending with no approval AND never let the exception escape into a
        # half-advanced order. A reconciler / human resolves the BLOCKED order.
        return _block(
            store, store.get_marketplace_order(order.order_id),
            f"could not open completion gate: {type(exc).__name__}: {exc}",
        )
    return won


def _observe_completion(store: StateStore, order: MarketplaceOrder) -> MarketplaceOrder:
    """review_pending → issue passed its completion gate (done): ready_to_submit.

    The issue reaching ``done`` means a human granted its ISSUE_COMPLETION approval
    (or no_completion_gate auto-closed it). Only THEN is the order submittable —
    this is the completion-gate / submission-gate separation (advisor阻断项 6). If the
    issue is still in_review (awaiting the human) we no-op.
    """
    if not order.issue_id:
        # No completion gate possible without an issue → leave for human/reconciler.
        return order
    issue = store.get_issue(order.issue_id)
    if issue.status == IssueStatus.DONE.value:
        order.status = MarketplaceOrderStatus.READY_TO_SUBMIT.value
        return store.save_marketplace_order(order)
    return order  # still in_review / blocked — waiting on the human acceptance gate
