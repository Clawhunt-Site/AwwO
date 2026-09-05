"""Unified, fail-closed handler for ClawHunt marketplace participation commands.

The SINGLE execution entry point for every marketplace mutation/read, across CLI
/ API / chat (advisor裁决 2026-06-24, Codex gpt-5.5 + Antigravity Gemini 3.1 Pro).
It deliberately mirrors the SHAPE of :mod:`superclaw.company_handler` (validate →
scope → risk → LOW-direct / HIGH-approval, reusing the Approval state machine)
but adds the two things marketplace needs that company does not:

  1. A connected-agent-key AUTH gate run for EVERY governed command — reads
     included. Anonymous public browse stays a Dock-only discovery surface
     (``/api/clawhunt/tasks``); the governed agent-tool path NEVER silently
     degrades to public data (advisor阻断项 3). No key → ``MarketplaceAuthError``.

  2. A durable ``MarketplaceOrder`` ledger for the claim → deliver → submit saga,
     so a remote-committed order can never be locally lost or double-claimed
     (advisor阻断项 2). A claim reserves the ``(base_url, problem_id)`` slot via the
     ledger BEFORE the remote commitment; the slot is freed only on a terminal
     ``claim_failed`` / ``abandoned``.

Fixed, fail-closed order in :func:`execute_marketplace_command`:

  (a) ``command.validate()`` — stateless business validation (single source).
  (b) AUTH gate — a connected agent key is required; no key is a hard refusal
      BEFORE risk, never an approval (you cannot approve your way past "not
      connected").
  (c) SCOPE gate — for a command that names a local company/order target (claim /
      submit / abandon), the actor's server-injected :class:`CompanyScope` must
      permit that company; a cross-company target raises ``CompanyScopeError``
      (contract B8: authority flows from scope, never the command body).
  (d) RISK — :func:`marketplace_risk.classify_marketplace_action`. Reads are LOW;
      EVERY write is HIGH.
  (e) branch: LOW (read) → dispatch the read NOW through the one ClawHuntClient
      and return its result. HIGH (write) → record a PENDING
      ``MARKETPLACE_COMMAND`` approval (and, for a claim, reserve the ledger slot)
      and return ``pending_approval``. The remote write happens ONLY at grant time
      in :func:`apply_marketplace_command` (so payment/commitment never runs on the
      default path — 项目铁律).

NOT a parallel ClawHunt client: every remote call goes through the ONE
:class:`superclaw.clawhunt.ClawHuntClient` (the single fact source for the API).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from superclaw.company_risk import RiskVerdict
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.marketplace_commands import (
    MarketplaceAbandonCommand,
    MarketplaceAcceptBidCommand,
    MarketplaceAcceptCommand,
    MarketplaceBidCommand,
    MarketplaceBrowseCommand,
    MarketplaceClaimCommand,
    MarketplaceInspectCommand,
    MarketplacePostTaskCommand,
    MarketplaceSubmitCommand,
    get_marketplace_command_model,
)
from superclaw.marketplace_risk import classify_marketplace_action
from superclaw.models import (
    Approval,
    ApprovalStatus,
    ApprovalType,
    MarketplaceOrder,
    MarketplaceOrderStatus,
    TERMINAL_MARKETPLACE_ORDER_STATUSES,
)
from superclaw.state import StateStore

# Stable kernel tag stored in an approval's resume_action so a granted marketplace
# approval routes back through this handler's grant-time applier rather than the
# company / agent-hire branches. Mirrors company_handler.RESUME_KERNEL.
RESUME_KERNEL = "marketplace.command"

Outcome = Literal["executed", "pending_approval"]

#: A ClawHuntClient factory — injected so tests/surfaces control the base_url +
#: transport. The handler never constructs a bare client itself except through
#: :func:`_default_client_factory` (which tests monkeypatch for the grant path).
ClientFactory = Callable[[], Any]


class MarketplaceAuthError(RuntimeError):
    """Raised when a governed marketplace command runs without a connected agent key.

    A HARD, fail-closed refusal (advisor阻断项 3): the governed agent path must
    never act on anonymous/public data nor attempt a write without credentials.
    Distinct from a scope error (you ARE the right actor, you are just not
    connected) and from a risk approval (you cannot approve your way past "not
    connected"). Surfaces map this to a clear "connect ClawHunt first" message.
    """


@dataclass(frozen=True)
class MarketplaceCommandResult:
    """The result of running a marketplace command through the handler.

    ``outcome``:
      * ``"executed"`` — a LOW read that ran straight through. ``detail`` carries
        the read result (``ok`` / ``status_code`` / ``count`` / ``body``).
      * ``"pending_approval"`` — a HIGH write converted into a PENDING approval for
        human confirmation. ``detail`` carries ``{"approval_id": ...}`` and, for a
        claim, the reserved ``{"order_id": ...}``.

    ``verdict`` is the risk classification that drove the branch (kept for audit).
    """

    outcome: Outcome
    verdict: RiskVerdict
    detail: dict[str, Any] = field(default_factory=dict)


def _default_client_factory() -> Any:
    """Build a ClawHuntClient from the ambient env (agent key already hydrated).

    The grant-time path (driven by ``team_kernel.decide_approval``) has no client
    seam to thread, so it falls back to this env-built client. Tests monkeypatch
    THIS function to inject a fake transport — they never hit the network.
    Imported lazily so importing this handler does not pull in httpx eagerly.
    """
    from superclaw.clawhunt import ClawHuntClient

    return ClawHuntClient()


# --- public API: the single execute choke point ------------------------------


def execute_marketplace_command(
    command: Any,
    *,
    scope: CompanyScope,
    store: StateStore,
    requested_by: str,
    client_factory: ClientFactory | None = None,
    idempotency_key: str = "",
) -> MarketplaceCommandResult:
    """Validate, auth-check, scope-check, classify, then read-now / approve-later.

    See the module docstring for the fixed (a)–(e) order. ``client_factory`` builds
    the ONE ClawHuntClient (defaults to the env-built client); it is used to (i)
    prove a connected agent key and (ii) dispatch a LOW read immediately. A HIGH
    write does NO remote call here — it records an approval; the remote effect
    lands in :func:`apply_marketplace_command` at grant time.
    """
    factory = client_factory or _default_client_factory

    # (a) Stateless validation.
    command.validate()

    # (b) AUTH gate (fail-closed): a connected agent key is required for the whole
    # governed path. Build the client once and reuse it for a LOW read dispatch.
    client = factory()
    _assert_agent_key_connected(client)

    # (c) SCOPE gate: a command that names a local company/order target must be in
    # the actor's scope (authority flows from scope, never the body).
    _assert_marketplace_command_in_scope(command, scope=scope, store=store)

    # (d) RISK: reads LOW, every write HIGH.
    verdict = classify_marketplace_action(command)

    # (e) Branch on the tier.
    if not verdict.is_high:
        detail = _dispatch_read(command, client=client)
        return MarketplaceCommandResult(outcome="executed", verdict=verdict, detail=detail)

    # HIGH → record a PENDING approval. A claim ALSO reserves the ledger slot first
    # so two concurrent claims can never both proceed (advisor阻断项 2).
    detail = _record_write_approval(
        command,
        scope=scope,
        requested_by=requested_by,
        store=store,
        client=client,
        idempotency_key=idempotency_key,
    )
    return MarketplaceCommandResult(
        outcome="pending_approval", verdict=verdict, detail=detail
    )


# --- (b) auth gate -----------------------------------------------------------


def _assert_agent_key_connected(client: Any) -> None:
    """Fail-closed: refuse the governed path unless an agent key is connected.

    Reads the key off the client's settings (no network). A blank/missing key
    raises ``MarketplaceAuthError`` so an agent can never browse/inspect degraded
    public data or attempt a write uncredentialed (advisor阻断项 3).
    """
    settings = getattr(client, "settings", None)
    agent_api_key = getattr(settings, "agent_api_key", None)
    if not isinstance(agent_api_key, str) or not agent_api_key.strip():
        raise MarketplaceAuthError(
            "ClawHunt marketplace participation requires a connected agent key "
            "(cph_…). Connect/login first; anonymous browsing is available only in "
            "the marketplace dock, never the governed agent path."
        )


# --- (c) scope gate ----------------------------------------------------------


def _assert_marketplace_command_in_scope(
    command: Any, *, scope: CompanyScope, store: StateStore
) -> None:
    """A command naming a local company/order target must be in the actor's scope.

    * claim → its ``company_profile_id`` (the company that will own the delivery)
      must exist, be ACTIVE, and be permitted by ``scope`` (CompanyScopeError 403
      otherwise). This is the contract-B8 seam: the company is a TARGET, the
      authority is the server-injected scope.
    * submit / abandon → the order's bound ``company_profile_id`` must be in scope.
    * browse / inspect / post / bid / accept / accept_bid → no LOCAL company
      target; remote authority is carried by the agent key, so there is nothing to
      scope-check here (the auth gate already proved the key).

    Fail-closed: an unknown company / order propagates ``KeyError`` rather than
    being treated as permitted.
    """
    from superclaw.company_lifecycle import assert_company_active

    if isinstance(command, MarketplaceClaimCommand):
        company = store.get_company_profile(command.company_profile_id)  # KeyError if unknown
        if not scope.permits(company.company_profile_id):
            raise CompanyScopeError(
                f"company {company.company_profile_id!r} is outside the actor's scope",
                target_company=company.company_profile_id,
            )
        assert_company_active(company)
        return

    if isinstance(command, (MarketplaceSubmitCommand, MarketplaceAbandonCommand)):
        order = store.get_marketplace_order(command.order_id)  # KeyError if unknown
        if not scope.permits(order.company_profile_id):
            raise CompanyScopeError(
                f"marketplace order {order.order_id!r} belongs to company "
                f"{order.company_profile_id!r}, outside the actor's scope",
                target_company=order.company_profile_id,
            )
        # The order's owning company must still exist and be ACTIVE — a frozen /
        # dissolved company can never drive a new external submission (Codex#4 /
        # contract B5). KeyError (vanished company) propagates fail-closed.
        company = store.get_company_profile(order.company_profile_id)
        assert_company_active(company)
        return

    # No local company/order target — nothing to scope-check (remote authority is
    # the agent key, already proven by the auth gate).


def _marketplace_target_company(command: Any, *, store: StateStore) -> str | None:
    """The local company a command's delivery is bound to (None if none).

    claim → its company_profile_id; submit/abandon → the order's company; the
    remote-only writes (post/bid/accept/accept_bid) have no local company target.
    """
    if isinstance(command, MarketplaceClaimCommand):
        return command.company_profile_id
    if isinstance(command, (MarketplaceSubmitCommand, MarketplaceAbandonCommand)):
        return store.get_marketplace_order(command.order_id).company_profile_id
    return None


def _reassert_live_agent_authority(
    command: Any, *, scope: CompanyScope, store: StateStore
) -> None:
    """Grant-time live re-derivation of a CONFINED agent's authority (TOCTOU defence).

    The scope persisted on an approval is a SNAPSHOT from request time. For a
    confined agent (``actor_agent_profile_id`` set, not an operator), that snapshot
    must not be trusted at grant time: between request and grant the agent could
    have been deleted or moved to a different company. Re-load the agent NOW and
    fail-closed unless it (a) still exists and (b) still belongs to the company the
    command targets. An operator (is_admin, no bound agent) is the live human
    authority and is exempt — the human granting IS the current authority.

    Raises ``CompanyScopeError`` (mapped to 403 by surfaces) on any mismatch.
    """
    agent_id = scope.actor_agent_profile_id
    if not agent_id:
        return  # operator / no bound agent → human grant is the live authority
    try:
        agent = store.get_agent_profile(agent_id)
    except KeyError as exc:
        raise CompanyScopeError(
            f"acting agent {agent_id!r} no longer exists; refuse to apply a stale "
            f"marketplace approval (fail-closed)",
            target_company=scope.actor_company_id,
        ) from exc
    target_company = _marketplace_target_company(command, store=store)
    if target_company is not None and agent.company_profile_id != target_company:
        raise CompanyScopeError(
            f"acting agent {agent_id!r} now belongs to company "
            f"{agent.company_profile_id!r}, not the command's target "
            f"{target_company!r}; refuse to apply a stale marketplace approval",
            target_company=target_company,
        )


# --- (e) read dispatch (LOW) -------------------------------------------------


def _dispatch_read(command: Any, *, client: Any) -> dict[str, Any]:
    """Run a LOW read NOW through the one ClawHuntClient and shape its result.

    Uses the AGENT-gated endpoints (``browse`` / ``get_problem``), NOT the public
    ones — the governed path requires a key (auth gate) and a solver inspecting a
    claimed order must receive the privileged detail, never a silently-degraded
    public payload (advisor阻断项 3).
    """
    if isinstance(command, MarketplaceBrowseCommand):
        from superclaw.clawhunt import browse_has_more, extract_problem_items

        result = client.browse(
            skip=command.skip, limit=command.limit, status=command.status
        )
        ok = bool(result.get("ok"))
        body = result.get("body")
        # Count via the SINGLE shared ClawHunt parser (same one the dock uses), which
        # recurses the nested `data`/`result` envelope — a hand-rolled list-only walk
        # under-counted to 0 there. `has_more` is the authoritative "more orders
        # exist beyond this page" signal, so a count of `limit` is not mistaken for
        # "that's all there is".
        #
        # Fail-closed on a non-OK response (Codex#2): a failed browse must NOT fabricate
        # an order count by parsing an error envelope that happens to carry a `problems`
        # key — that would mislead "how many orders". Report 0 / no-more, exactly as the
        # dock does, and keep the raw body for diagnostics. The count is only meaningful
        # when the query actually succeeded.
        items = extract_problem_items(body) if ok else []
        return {
            "read": "browse",
            "ok": ok,
            "status_code": result.get("status_code"),
            "count": len(items),
            "has_more": browse_has_more(body, len(items), command.limit) if ok else False,
            "body": body,
        }

    if isinstance(command, MarketplaceInspectCommand):
        result = client.get_problem(command.problem_id)
        return {
            "read": "inspect",
            "ok": bool(result.get("ok")),
            "status_code": result.get("status_code"),
            "problem_id": command.problem_id,
            "body": result.get("body"),
        }

    raise ValueError(f"not a marketplace read command: {type(command).__name__!r}")


# --- (e) write approval (HIGH) -----------------------------------------------


#: Order states from which a SUBMIT may be armed (the work is delivered & the run
#: passed its completion gate — the saga sets ready_to_submit — or a prior submit
#: failed and is retriable). Gating approval creation on this set closes the
#: stale-approval hole (advisor阻断项 5/Codex#2): an approval is NEVER created for an
#: order that is not actually submit-ready, so a premature human grant cannot ride
#: a later state change into an unauthorized submission.
_SUBMIT_ARMABLE_STATES = frozenset(
    {
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.SUBMIT_FAILED.value,
    }
)

#: Order states from which an ABANDON may be requested (a live, non-terminal order
#: holding a remote commitment). Abandoning a terminal/settled order is a no-op the
#: handler refuses up front so no dangling approval is created.
_ABANDONABLE_STATES = frozenset(
    {
        MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.RUN_FAILED.value,
        MarketplaceOrderStatus.REVIEW_PENDING.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value,
        MarketplaceOrderStatus.SUBMIT_FAILED.value,
        MarketplaceOrderStatus.BLOCKED.value,
    }
)


def _record_write_approval(
    command: Any,
    *,
    scope: CompanyScope,
    requested_by: str,
    store: StateStore,
    client: Any,
    idempotency_key: str,
) -> dict[str, Any]:
    """Record a PENDING marketplace approval; for a claim, reserve the ledger slot.

    The approval carries the serialized command + actor scope (so the grant
    re-checks scope and dispatches the EXACT command). A claim additionally reserves
    the ``MarketplaceOrder`` slot — order + approval committed in ONE transaction
    (``create_marketplace_claim``) so a crash can never orphan a slot-holding order
    with no approval (advisor阻断项). submit/abandon are gated on the order being in a
    valid state BEFORE any approval is created, so a premature grant cannot bypass
    the completion gate (advisor阻断项 5).
    """
    if isinstance(command, MarketplaceClaimCommand):
        base_url = _client_base_url(client)
        approval = _build_marketplace_approval(
            command, scope=scope, requested_by=requested_by, store=store, order_id=None
        )
        order = MarketplaceOrder(
            problem_id=str(command.problem_id),
            base_url=base_url,
            company_profile_id=command.company_profile_id,
            status=MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value,
            requested_by=requested_by,
            idempotency_key=idempotency_key,
            claim_approval_id=approval.approval_id,
        )
        # Stamp the reserved order id into the approval so the grant knows which
        # ledger row to advance, then commit BOTH atomically.
        approval.affects["order_id"] = order.order_id
        approval.resume_action["order_id"] = order.order_id
        saved_order, saved_approval, _created = store.create_marketplace_claim(order, approval)
        return {
            "approval_id": saved_approval.approval_id,
            "order_id": saved_order.order_id,
        }

    if isinstance(command, MarketplaceSubmitCommand):
        order = store.get_marketplace_order(command.order_id)
        if order.status not in _SUBMIT_ARMABLE_STATES:
            raise ValueError(
                f"order {order.order_id} is not submit-ready (status {order.status}); "
                f"no submission approval created"
            )
        approval = _build_marketplace_approval(
            command, scope=scope, requested_by=requested_by, store=store,
            order_id=order.order_id,
        )
        # Atomically: enforce one-live-approval-per-order, save the approval, AND arm
        # the order — all in one transaction (advisor阻断项, Codex: the per-order
        # single-approval invariant must be transactional, not a racy pre-check).
        store.open_marketplace_order_approval(order.order_id, approval, arm_submit=True)
        return {"approval_id": approval.approval_id, "order_id": order.order_id}

    if isinstance(command, MarketplaceAbandonCommand):
        order = store.get_marketplace_order(command.order_id)
        if order.status not in _ABANDONABLE_STATES:
            raise ValueError(
                f"order {order.order_id} cannot be abandoned from status "
                f"{order.status}; no approval created"
            )
        approval = _build_marketplace_approval(
            command, scope=scope, requested_by=requested_by, store=store,
            order_id=order.order_id,
        )
        # Same transactional one-live-approval-per-order guard (no order arm for
        # abandon — it does not change the order state until grant time).
        store.open_marketplace_order_approval(order.order_id, approval, arm_submit=False)
        return {"approval_id": approval.approval_id, "order_id": order.order_id}

    # post / bid / accept / accept_bid: an approval only — no local ledger row.
    approval = _build_marketplace_approval(
        command, scope=scope, requested_by=requested_by, store=store, order_id=None
    )
    store.save_approval(approval)
    return {"approval_id": approval.approval_id}


def _build_marketplace_approval(
    command: Any,
    *,
    scope: CompanyScope,
    requested_by: str,
    store: StateStore,
    order_id: str | None,
) -> Approval:
    """Build (do NOT save) a PENDING ``MARKETPLACE_COMMAND`` approval.

    Mirrors ``company_handler._create_company_approval`` but returns the unsaved
    object so the claim path can persist it in the SAME transaction as the order
    (atomicity). Non-claim callers save it themselves. The command is stored
    verbatim in ``resume_action`` so a grant applies that EXACT command, and the
    actor scope is persisted so the grant rebuilds the SAME scope to re-check
    (TOCTOU defence) — never a fresh wider one.
    """
    return Approval(
        type=ApprovalType.MARKETPLACE_COMMAND.value,
        requested_by=requested_by,
        requested_permission={
            "action": "marketplace.command",
            "command_type": command.command_type,
        },
        affects={
            "command": command.to_dict(),
            "command_type": command.command_type,
            "company_profile_id": _command_company_id(command, scope, store),
            "order_id": order_id,
        },
        resume_action={
            "kernel": RESUME_KERNEL,
            "command_type": command.command_type,
            "command": command.to_dict(),
            "scope": _scope_to_dict(scope),
            "requested_by": requested_by,
            "order_id": order_id,
        },
    )


def _command_company_id(command: Any, scope: CompanyScope, store: StateStore) -> str:
    """The company a marketplace approval is attributed to (for company-scoped listing)."""
    company_id = getattr(command, "company_profile_id", None)
    if isinstance(company_id, str) and company_id:
        return company_id
    order_id = getattr(command, "order_id", None)
    if isinstance(order_id, str) and order_id:
        try:
            return store.get_marketplace_order(order_id).company_profile_id
        except KeyError:
            pass
    return scope.actor_company_id


def _client_base_url(client: Any) -> str:
    settings = getattr(client, "settings", None)
    base_url = getattr(settings, "base_url", None)
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("ClawHunt client has no base_url; cannot key the order slot")
    return base_url


# --- scope (de)serialization (mirrors company_handler) -----------------------


def _scope_to_dict(scope: CompanyScope) -> dict[str, Any]:
    return {
        "principal_id": scope.principal_id,
        "actor_company_id": scope.actor_company_id,
        "allowed_company_ids": sorted(scope.allowed_company_ids),
        "is_admin": scope.is_admin,
        "actor_agent_profile_id": scope.actor_agent_profile_id,
    }


def _scope_from_dict(data: dict[str, Any]) -> CompanyScope:
    """Rebuild a CompanyScope from an approval, fail-closed on malformed values.

    Identical hardening to ``company_handler._scope_from_dict``: ``is_admin`` is
    True only for strict ``True``; a malformed allow-set degrades to "own company
    only"; non-str ids degrade to ``""`` / None.
    """
    raw_allowed = data.get("allowed_company_ids")
    if isinstance(raw_allowed, (list, tuple)):
        allowed = frozenset(v for v in raw_allowed if isinstance(v, str) and v)
    else:
        allowed = frozenset()
    principal = data.get("principal_id")
    actor = data.get("actor_company_id")
    acting_agent = data.get("actor_agent_profile_id")
    return CompanyScope(
        principal_id=principal if isinstance(principal, str) else "",
        actor_company_id=actor if isinstance(actor, str) else "",
        allowed_company_ids=allowed,
        is_admin=data.get("is_admin") is True,
        actor_agent_profile_id=(
            acting_agent if (isinstance(acting_agent, str) and acting_agent) else None
        ),
    )


# --- grant-time application (HIGH path, the ONLY place a write hits the wire) -


def apply_marketplace_command(
    store: StateStore,
    resume_action: dict[str, Any],
    *,
    approval_id: str | None = None,
    client_factory: ClientFactory | None = None,
) -> dict[str, Any]:
    """Apply a granted marketplace approval — the ONE place a write hits the wire.

    Invoked from ``team_kernel._apply_agent_approval`` when a granted approval's
    ``resume_action["kernel"] == RESUME_KERNEL``. Rebuilds the command + the SAME
    actor scope, re-runs validate + auth + scope (TOCTOU / tamper defence), then
    performs the remote ClawHunt action and advances the ledger. Raises on any
    failure so ``decide_approval`` leaves the approval PENDING rather than recording
    a grant whose effect never landed.
    """
    factory = client_factory or _default_client_factory

    # Idempotent re-grant guard (advisor阻断项, Codex): the shared approval state
    # machine allows ``approved → approved``, and an idempotent claim retry can
    # re-expose an already-granted approval id — so a second ``approve grant`` would
    # otherwise re-run this applier and repeat the external ClawHunt write. Apply
    # runs BEFORE ``decide_approval`` stamps the status, so on the FIRST grant the
    # approval is still PENDING (proceed); on a RE-grant it is already non-PENDING →
    # no-op. This single check makes EVERY marketplace write (claim/submit/post/bid/
    # accept) re-grant-safe, regardless of the shared machine's APPROVED→APPROVED edge.
    if approval_id:
        try:
            current = store.get_approval(approval_id)
        except KeyError:
            current = None
        if current is not None and current.status != ApprovalStatus.PENDING.value:
            return {"applied": False, "idempotent": True, "reason": "approval already decided"}

    command_type = resume_action.get("command_type")
    if not isinstance(command_type, str):
        raise ValueError("marketplace approval missing command_type")
    model = get_marketplace_command_model(command_type)  # KeyError -> unknown
    raw = resume_action.get("command")
    if not isinstance(raw, dict):
        raise ValueError("marketplace approval missing command payload")
    command = model.from_dict(raw)  # strict: rejects unknown fields
    scope = _scope_from_dict(resume_action.get("scope") or {})

    # Re-run the hard gates at grant time (a grant authorizes THIS exact command,
    # never a bypass of the boundary gates).
    command.validate()
    client = factory()
    _assert_agent_key_connected(client)
    # Live authority re-derivation (advisor阻断项 3): if the requester was a CONFINED
    # agent, the stored scope is a SNAPSHOT from request time. Re-load that agent
    # NOW — if it was removed, or moved to a different company than the command
    # targets, the grant must fail-closed rather than trust the frozen snapshot.
    # An operator (is_admin) grant is the live human authority, so it skips this.
    _reassert_live_agent_authority(command, scope=scope, store=store)
    _assert_marketplace_command_in_scope(command, scope=scope, store=store)

    if isinstance(command, MarketplaceClaimCommand):
        return _apply_claim(store, command, client=client,
                            resume_action=resume_action, approval_id=approval_id)
    if isinstance(command, MarketplaceSubmitCommand):
        return _apply_submit(store, command, client=client, approval_id=approval_id)
    if isinstance(command, MarketplaceAbandonCommand):
        return _apply_abandon(store, command, client=client)
    if isinstance(command, MarketplacePostTaskCommand):
        return _remote_result(
            "posted",
            client.post_problem(
                {
                    "title": command.title,
                    "description": command.description,
                    "price": command.price,
                    "category": command.category,
                    "difficulty": command.difficulty,
                    "routing_mode": command.routing_mode,
                    **(
                        {"target_agent_id": command.target_agent_id}
                        if command.target_agent_id
                        else {}
                    ),
                }
            ),
        )
    if isinstance(command, MarketplaceBidCommand):
        return _remote_result(
            "bid",
            client.bid(command.problem_id, amount=command.amount, message=command.message),
        )
    if isinstance(command, MarketplaceAcceptCommand):
        return _remote_result("accepted", client.accept(command.problem_id))
    if isinstance(command, MarketplaceAcceptBidCommand):
        return _remote_result(
            "accepted_bid", client.accept_bid(command.problem_id, command.bid_id)
        )

    raise ValueError(f"no grant-time apply for marketplace command: {type(command).__name__!r}")


def _apply_claim(
    store: StateStore,
    command: MarketplaceClaimCommand,
    *,
    client: Any,
    resume_action: dict[str, Any],
    approval_id: str | None,
) -> dict[str, Any]:
    """Grant-time claim: advance the reserved order through the remote commitment.

    Bound to the EXACT order-arming (advisor阻断项, Codex): proceeds only if the order
    is still the one THIS approval reserved (``claim_approval_id`` matches) and is in
    a pre-claim phase (``claim_approval_pending``). Any other state means the order
    already advanced (a re-grant, or a superseding action) → idempotent no-op, never
    a second remote claim. Then: ``claiming`` → remote claim → ``claimed_remote`` on
    ok / ``claim_failed`` (4xx, slot freed) / ``blocked`` (5xx or exception:
    ambiguous, slot retained). Every branch RETURNS (never raises into a zombie).
    """
    order_id = resume_action.get("order_id")
    if not isinstance(order_id, str) or not order_id:
        raise ValueError("marketplace claim approval missing reserved order_id")
    order = store.get_marketplace_order(order_id)
    if (
        order.status != MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value
        or (approval_id and order.claim_approval_id != approval_id)
    ):
        # The order is no longer awaiting THIS claim (re-grant / superseded). No-op.
        return {"claimed": "superseded", "order_id": order_id, "status": order.status}

    order.status = MarketplaceOrderStatus.CLAIMING.value
    store.save_marketplace_order(order)

    # Three outcomes, each fail-closed for an EXTERNAL commitment:
    #   * exception (timeout / disconnect / no response) → AMBIGUOUS: the remote may
    #     or may not have claimed. We must NOT assume "not claimed" (that risks a
    #     double-claim on retry or a wrong slot release). Park the order in BLOCKED
    #     (slot RETAINED) for reconciliation and RETURN — the grant is processed,
    #     outcome unknown (advisor阻断项, Codex: ambiguous ≠ "definitely not done").
    #   * clean "not ok" (the server responded with a rejection, e.g. 409) →
    #     DEFINITIVE: settle claim_failed (slot freed), RETURN.
    #   * ok → claimed_remote.
    # In every branch we RETURN (never raise), so decide_approval settles the
    # approval (APPROVED) instead of leaving a re-grantable zombie.
    try:
        result = client.claim(command.problem_id)
    except Exception as exc:  # noqa: BLE001 - any remote error is an ambiguous outcome
        order = store.get_marketplace_order(order_id)
        order.status = MarketplaceOrderStatus.BLOCKED.value
        order.last_error = (
            f"remote claim ambiguous (no confirmation: {type(exc).__name__}); "
            f"slot retained — reconcile remote state before retry or release"
        )
        store.save_marketplace_order(order)
        return {"claimed": "ambiguous", "order_id": order_id,
                "problem_id": command.problem_id, "blocked": True}
    order = store.get_marketplace_order(order_id)
    if not result.get("ok"):
        status_code = result.get("status_code")
        if _is_ambiguous_status(status_code):
            # 5xx / unknown: the server may have committed before erroring (advisor
            # refinement, AGY). Treat as AMBIGUOUS → BLOCKED (slot retained), never
            # claim_failed (which would free a slot the remote may still hold).
            order.status = MarketplaceOrderStatus.BLOCKED.value
            order.last_error = (
                f"remote claim {status_code} (server error) — outcome ambiguous; "
                f"slot retained, reconcile before retry or release"
            )
            store.save_marketplace_order(order)
            return {"claimed": "ambiguous", "order_id": order_id,
                    "problem_id": command.problem_id, "blocked": True,
                    "status_code": status_code}
        # 4xx: a definitive server rejection (e.g. 409 already claimed). Free slot.
        order.status = MarketplaceOrderStatus.CLAIM_FAILED.value
        order.last_error = f"remote claim rejected: status {status_code}"
        store.save_marketplace_order(order)
        return {
            "claimed": False,
            "order_id": order_id,
            "problem_id": command.problem_id,
            "status_code": status_code,
        }

    # Capture the (now-privileged) problem detail as the durable snapshot so the
    # delivery has the order's requirements even if the key later lapses.
    snapshot = _safe_problem_snapshot(client, command.problem_id)
    order.status = MarketplaceOrderStatus.CLAIMED_REMOTE.value
    if snapshot:
        order.problem_snapshot = snapshot
    store.save_marketplace_order(order)
    return {"claimed": True, "order_id": order_id, "problem_id": command.problem_id}


def _apply_submit(
    store: StateStore, command: MarketplaceSubmitCommand, *, client: Any,
    approval_id: str | None,
) -> dict[str, Any]:
    """Grant-time submit: push the bound run's evidence to the claimed order.

    Bound to the EXACT arming (advisor阻断项, Codex): proceeds ONLY if the order is in
    ``submit_approval_pending`` AND its ``submit_approval_id`` matches THIS approval.
    This closes the "stale pending submit revives through a blocked → ready_to_submit
    cycle" hole — after such a cycle the order is ``ready_to_submit`` (not
    ``submit_approval_pending``), so the stale approval is SUPERSEDED, never a real
    submit. The completion-gate (issue passed review) is the P1 saga's job before it
    arms the order; here we fail-closed if the order is not the armed-and-bound one.
    """
    order = store.get_marketplace_order(command.order_id)
    if (
        order.status != MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value
        or (approval_id and order.submit_approval_id != approval_id)
    ):
        # The order is not armed for THIS submit (moved / re-armed / cycled / already
        # submitted). Settle as a SUPERSEDED no-op (no raise → no PENDING zombie).
        return {
            "submitted": False,
            "superseded": True,
            "order_id": order.order_id,
            "status": order.status,
        }
    if not order.run_id:
        raise RuntimeError(f"order {order.order_id} has no bound run to submit")
    # Grant-time RE-VERIFICATION (advisor阻断项 5, Codex): never submit on ledger
    # status alone. Re-check, fail-closed, that the delivery actually passed and
    # that the evidence we are about to send is THIS order's verified delivery:
    #   (a) a bound delivery issue exists and reached `done` (the human completion
    #       gate). A submittable marketplace order ALWAYS has a bound issue (the
    #       saga binds it); a missing issue_id is an ungoverned order → refuse.
    #   (b) the bound issue's execution run IS this order's run, and the issue is
    #       stamped with THIS order id — so a recovery / manual edit cannot splice a
    #       stale run's evidence into the submission.
    #   (c) the bound run's evidence verdict is not FAIL.
    from superclaw.models import ChainVerdict, IssueStatus

    if not order.issue_id:
        raise RuntimeError(
            f"order {order.order_id} has no bound delivery issue; refuse to submit "
            f"an ungoverned order (no completion gate)"
        )
    try:
        issue = store.get_issue(order.issue_id)
    except KeyError as exc:
        raise RuntimeError(
            f"order {order.order_id} references a missing issue {order.issue_id!r}"
        ) from exc
    if issue.status != IssueStatus.DONE.value:
        raise RuntimeError(
            f"order {order.order_id}: delivery issue {order.issue_id} has not "
            f"passed its completion gate (status {issue.status}); refuse to submit"
        )
    # Bind via the DURABLE run stamp, NOT issue.execution_run_id: the kernel clears
    # execution_run_id when the issue completes (decide_approval), so a completed,
    # accepted delivery would otherwise always fail this check (advisor阻断项, e2e).
    # The saga stamps issue.metadata['marketplace_run_id'] = run_id at run-start; it
    # survives completion and proves the evidence we send is THIS order's run.
    if (issue.metadata or {}).get("marketplace_run_id") != order.run_id:
        raise RuntimeError(
            f"order {order.order_id}: bound issue's run "
            f"{(issue.metadata or {}).get('marketplace_run_id')!r} ≠ order run "
            f"{order.run_id!r}; refuse to submit a mismatched delivery"
        )
    if (issue.metadata or {}).get("marketplace_order_id") != order.order_id:
        raise RuntimeError(
            f"order {order.order_id}: bound issue is not stamped with this order id; "
            f"refuse to submit (binding inconsistent — possible recovery/manual edit)"
        )
    evidence = store.get_evidence(order.run_id)  # KeyError if no evidence
    if evidence.chain_verdict == ChainVerdict.FAIL:
        raise RuntimeError(
            f"order {order.order_id}: run {order.run_id} evidence verdict is FAIL; "
            f"refuse to submit a failed delivery"
        )

    order.status = MarketplaceOrderStatus.SUBMITTING.value
    store.save_marketplace_order(order)

    # Same fail-closed discipline as _apply_claim: an AMBIGUOUS remote error (no
    # response) parks the order in BLOCKED (the remote may have received the
    # solution — never assume "not submitted" and re-submit) and RETURNS; a clean
    # "not ok" settles submit_failed (retriable via a fresh submit) and RETURNS.
    try:
        result = client.submit_solution(
            order.problem_id,
            command.solution_text or "",
            evidence=evidence.to_dict(),
            attachments=[f"superclaw-run:{order.run_id}"],
        )
    except Exception as exc:  # noqa: BLE001 - ambiguous remote outcome
        order = store.get_marketplace_order(command.order_id)
        order.status = MarketplaceOrderStatus.BLOCKED.value
        order.last_error = (
            f"remote submit ambiguous (no confirmation: {type(exc).__name__}); "
            f"reconcile remote state before any re-submit"
        )
        store.save_marketplace_order(order)
        return {"submitted": "ambiguous", "order_id": order.order_id,
                "problem_id": order.problem_id, "blocked": True}
    order = store.get_marketplace_order(command.order_id)
    if not result.get("ok"):
        status_code = result.get("status_code")
        if _is_ambiguous_status(status_code):
            # 5xx: the remote may have accepted the solution before erroring (AGY
            # refinement). Ambiguous → BLOCKED, never submit_failed (which a fresh
            # submit could re-attempt against an already-accepted order).
            order.status = MarketplaceOrderStatus.BLOCKED.value
            order.last_error = (
                f"remote submit {status_code} (server error) — outcome ambiguous; "
                f"reconcile before any re-submit"
            )
            store.save_marketplace_order(order)
            return {"submitted": "ambiguous", "order_id": order.order_id,
                    "problem_id": order.problem_id, "blocked": True,
                    "status_code": status_code}
        # 4xx: definitive rejection. submit_failed is retriable via a fresh submit
        # (re-arms ready_to_submit → a new approval); the old approval is settled.
        order.status = MarketplaceOrderStatus.SUBMIT_FAILED.value
        order.last_error = f"remote submit failed: status {status_code}"
        store.save_marketplace_order(order)
        return {
            "submitted": False,
            "order_id": order.order_id,
            "problem_id": order.problem_id,
            "status_code": status_code,
        }
    order.status = MarketplaceOrderStatus.SUBMITTED.value
    order.submission_response = result if isinstance(result, dict) else {}
    store.save_marketplace_order(order)
    return {"submitted": True, "order_id": order.order_id, "problem_id": order.problem_id}


def _apply_abandon(
    store: StateStore, command: MarketplaceAbandonCommand, *, client: Any
) -> dict[str, Any]:
    """Grant-time abandon: attempt to release the remote commitment, settle honestly.

    The compensation path (advisor阻断项 2B). ClawHunt has NO first-class "release"
    endpoint today, so we CANNOT prove the remote commitment was released. Settling
    straight to ``abandoned`` (which FREES the local slot) would be fail-OPEN — it
    would pretend a still-held remote order is gone and let the slot be re-claimed
    while ClawHunt still counts the original against the agent (advisor阻断项 6,
    Codex#5). So we move the order to ``blocked`` (the slot stays occupied,
    honestly reflecting the unreleased remote commitment) and record that a human /
    remote timeout must settle it. Only a PROVEN remote release (future endpoint)
    may transition ``abandoning → abandoned`` and free the slot.
    """
    order = store.get_marketplace_order(command.order_id)
    if order.status in TERMINAL_MARKETPLACE_ORDER_STATUSES or order.status not in {
        MarketplaceOrderStatus.CLAIMED_REMOTE.value,
        MarketplaceOrderStatus.ISSUE_BOUND.value,
        MarketplaceOrderStatus.RUN_STARTED.value,
        MarketplaceOrderStatus.RUN_FAILED.value,
        MarketplaceOrderStatus.REVIEW_PENDING.value,
        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
        MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value,
        MarketplaceOrderStatus.SUBMIT_FAILED.value,
        MarketplaceOrderStatus.BLOCKED.value,
    }:
        # The order already settled / moved past an abandonable state (e.g. it was
        # submitted by a competing grant). Settle as a SUPERSEDED no-op rather than
        # raising into decide_approval (no local-race zombie — Codex).
        return {
            "abandoned": "superseded",
            "order_id": order.order_id,
            "status": order.status,
        }
    order.status = MarketplaceOrderStatus.ABANDONING.value
    order.last_error = command.reason or "abandon requested"
    store.save_marketplace_order(order)
    # No remote release API → cannot prove release. Fail-closed to BLOCKED (slot
    # retained). When ClawHunt adds a release endpoint, call it here and only on a
    # proven release advance abandoning → abandoned (freeing the slot).
    order = store.get_marketplace_order(command.order_id)
    order.status = MarketplaceOrderStatus.BLOCKED.value
    order.last_error = (
        f"{command.reason or 'abandon requested'} — no remote release endpoint; "
        f"slot retained until ClawHunt releases the order or it times out "
        f"(operator must confirm release before re-claim)"
    )
    store.save_marketplace_order(order)
    return {"abandoned": "requested", "order_id": order.order_id,
            "status": order.status, "problem_id": order.problem_id}


def _is_ambiguous_status(status_code: Any) -> bool:
    """True when a remote status leaves the commitment's outcome UNKNOWN.

    A clean 4xx is a definitive server-side rejection (nothing committed). A 5xx —
    or a missing/garbled status — may mean the server committed and then failed to
    serialise the response (advisor refinement, AGY): the outcome is ambiguous, so
    the order must park in BLOCKED (slot retained), never a slot-freeing failure
    state. Treat anything that is not a clean 4xx (400–499) as ambiguous,
    fail-closed.

    EXCEPTION (Codex refinement): ``408 Request Timeout`` is a 4xx but a gateway /
    proxy can emit it after the upstream already processed the request — its
    outcome is NOT definitive. Classify it (and any non-int / non-4xx) as
    ambiguous so it parks in BLOCKED rather than freeing a possibly-held slot.
    """
    if not isinstance(status_code, int):
        return True
    if status_code == 408:  # Request Timeout — upstream may have committed
        return True
    return not (400 <= status_code < 500)


def _remote_result(action: str, result: dict[str, Any]) -> dict[str, Any]:
    """Shape a non-ledger remote write result, fail-closed on a non-ok response."""
    if not result.get("ok"):
        raise RuntimeError(
            f"ClawHunt {action} failed (status {result.get('status_code')})"
        )
    return {action: True, "status_code": result.get("status_code"), "body": result.get("body")}


def _safe_problem_snapshot(client: Any, problem_id: Any) -> dict[str, Any]:
    """Best-effort privileged problem snapshot; never fails the claim on a read error."""
    try:
        detail = client.get_problem(problem_id)
    except Exception:  # noqa: BLE001 - snapshot is best-effort, never blocks claim
        return {}
    body = detail.get("body") if isinstance(detail, dict) else None
    return body if isinstance(body, dict) else {}


# --- reject hook (free the slot / re-arm) ------------------------------------


def free_marketplace_order_on_reject(store: StateStore, approval: Approval) -> None:
    """Settle a marketplace order whose approval was REJECTED.

    Mirrors ``team_kernel._restore_company_on_archive_reject``: only fires for a
    ``marketplace.command`` approval that carries an ``order_id``. A rejected CLAIM
    frees the reserved slot (``claim_approval_pending`` → ``claim_failed``); a
    rejected SUBMIT re-arms the order to ``ready_to_submit`` (the work is done, the
    human just declined THIS submission). Best-effort + fail-soft: the rejection is
    already durable, so a settle failure must not turn a clean reject into a 500.
    """
    action = approval.resume_action or {}
    if action.get("kernel") != RESUME_KERNEL:
        return
    order_id = action.get("order_id")
    if not isinstance(order_id, str) or not order_id:
        return
    try:
        order = store.get_marketplace_order(order_id)
    except KeyError:
        return
    try:
        # A rejected pre-grant CLAIM frees the reserved slot (nothing was attempted).
        if order.status == MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value:
            order.status = MarketplaceOrderStatus.CLAIM_FAILED.value
            order.last_error = "claim approval rejected"
            store.save_marketplace_order(order)
        # An in-flight CLAIMING/SUBMITTING at reject time means a grant crashed
        # mid-attempt (SIGKILL before the except ran). The remote outcome is
        # AMBIGUOUS, so we settle to BLOCKED (slot RETAINED) — NOT claim_failed /
        # submit_failed, which would assume "not done" and risk a double-claim or a
        # wrong slot release (advisor阻断项, Codex: ambiguous ≠ definitely-not-done).
        elif order.status in {
            MarketplaceOrderStatus.CLAIMING.value,
            MarketplaceOrderStatus.SUBMITTING.value,
        }:
            order.status = MarketplaceOrderStatus.BLOCKED.value
            order.last_error = (
                "approval rejected while in-flight; remote outcome ambiguous — "
                "reconcile before retry or release"
            )
            store.save_marketplace_order(order)
        # A rejected pre-submit re-arms the order to ready_to_submit (the work is
        # done, the human just declined THIS submission).
        elif order.status == MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value:
            order.status = MarketplaceOrderStatus.READY_TO_SUBMIT.value
            order.last_error = "submit approval rejected"
            store.save_marketplace_order(order)
    except (KeyError, ValueError):
        # Anomalous/raced ledger state — leave it for an operator rather than
        # turning a valid rejection into an exception.
        return
