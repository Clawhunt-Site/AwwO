"""Typed command models + central registry for chat-driven ClawHunt marketplace
participation (browse / post / bid / claim / submit / accept).

Single source of truth for the marketplace mutation contract. Each command is a
typed dataclass with up-front, fail-closed, *stateless* business validation plus
the project's standard ``to_dict`` and a fail-closed ``from_dict`` (no Pydantic).
It deliberately mirrors the SHAPE of :mod:`superclaw.company_commands` (so the
handler / CLI / API / tool-schema derivation are uniform across the two
capability namespaces) WITHOUT sharing its risk semantics.

Why a SEPARATE vocabulary from company_commands (advisor裁决, 2026-06-24, Codex
gpt-5.5 + Antigravity Gemini 3.1 Pro, both blocking):

  * company commands are LOCAL, single-user, reversible org edits — the risk gate
    treats nearly everything as LOW ("if the user triggered it, allow it").
  * marketplace commands cross an EXTERNAL network boundary, make COMMITMENTS to a
    third party (ClawHunt), and may move MONEY. They can NEVER inherit the
    permissive "user-triggered ⇒ LOW" premise. So the classifier lives in
    :mod:`superclaw.marketplace_risk` (writes are HIGH), and this module only
    defines the vocabulary. We reuse the Approval/serialization/registry STRUCTURE,
    never the classification.

Two command CLASSES, distinguished for the handler:

  * READ commands (``MarketplaceBrowseCommand`` / ``MarketplaceInspectCommand``):
    list/count orders, inspect one order. LOW risk, but the GOVERNED handler still
    requires a connected agent key — anonymous public browse stays a Dock-only
    discovery surface (``/api/clawhunt/tasks``), never the agent-tool path, so an
    agent can never silently act on degraded public data (advisor阻断项 3).
  * WRITE commands (post/bid/claim/submit/accept/accept_bid): every one is HIGH
    (human approval) AND requires a connected agent key, fail-closed.

NOT a parallel ClawHunt client. These models are dispatched by
:mod:`superclaw.marketplace_handler`, which calls the SINGLE
:class:`superclaw.clawhunt.ClawHuntClient` — the one fact source for the remote
API. Surfaces (CLI / API / chat tools) derive their argument lists and JSON
schemas from THIS registry; none hand-copies a command list.

Kept dependency-light at MODULE level (no kernel/state/backends import) so every
layer can import it without a cycle.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, ClassVar

# The closed set of ClawHunt problem-status filters a browse may pass through.
# Mirrors the upstream marketplace vocabulary; an unknown value is rejected
# (fail-closed) rather than forwarded blindly to the remote API.
MARKETPLACE_STATUS_FILTERS: frozenset[str] = frozenset(
    {"open", "bidding", "claimed", "in_progress", "verifying", "closed", "all"}
)

# Hard ceiling on a single browse page — mirrors the existing
# ``/api/clawhunt/tasks`` cap (1 ≤ limit ≤ 50) so the governed tool path can never
# request an unbounded page the REST projection would reject.
MARKETPLACE_BROWSE_LIMIT_MAX = 50


def _require_nonempty(value: Any, field_name: str) -> None:
    """Fail-closed: raise ValueError unless ``value`` is a non-blank ``str``."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} is required and must be a non-empty string")


def _require_problem_id(value: Any, field_name: str = "problem_id") -> None:
    """Fail-closed: a problem id must be a positive int OR a non-blank str.

    ClawHunt problem ids are integers upstream, but ids flow through JSON / CLI as
    strings too. Accept both shapes, reject everything else (None, 0/negative,
    blank, float, list) rather than coercing — a malformed id must never reach the
    remote API or the ledger's unique key.
    """
    if isinstance(value, bool):  # bool is an int subclass; never a valid id
        raise ValueError(f"{field_name} must be a positive integer or non-empty string")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError(f"{field_name} must be a positive integer")
        return
    if isinstance(value, str):
        if not value.strip():
            raise ValueError(f"{field_name} must not be blank")
        return
    raise ValueError(f"{field_name} must be a positive integer or non-empty string")


def _require_positive_int(value: Any, field_name: str) -> None:
    """Fail-closed: a money/amount field must be a positive int (cents)."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field_name} must be a positive integer (cents)")


def _strict_from_dict(cls: type, data: dict[str, Any]) -> Any:
    """Construct ``cls`` from ``data``, rejecting unknown keys (fail-closed).

    Like :func:`superclaw.company_commands._strict_from_dict`: a marketplace
    command is what gets approved / summarised / submitted, so silently dropping
    an unrecognised key would let the action that is approved diverge from the
    request that was sent. An unknown key is an error.
    """
    if not isinstance(data, dict):
        raise ValueError(f"{cls.__name__} payload must be a mapping")
    known = set(cls.__dataclass_fields__)  # type: ignore[attr-defined]
    unknown = [k for k in data if k not in known]
    if unknown:
        raise ValueError(
            f"unknown fields for {cls.__name__}: {sorted(unknown)} "
            f"(known: {sorted(known)})"
        )
    return cls(**data)


# --- READ commands (LOW risk; governed path still requires an agent key) ------


@dataclass
class MarketplaceBrowseCommand:
    """List/count marketplace orders (drives ``ClawHuntClient.browse``)."""

    command_type: ClassVar[str] = "marketplace.browse"
    #: READ commands never mutate remote state — the handler/risk layers key off
    #: this so a read can be dispatched directly without an approval.
    is_read: ClassVar[bool] = True

    status: str | None = None
    skip: int = 0
    limit: int = 20

    def validate(self) -> None:
        if self.status is not None and self.status not in MARKETPLACE_STATUS_FILTERS:
            raise ValueError(
                f"invalid status filter: {self.status!r} "
                f"(one of {sorted(MARKETPLACE_STATUS_FILTERS)})"
            )
        if isinstance(self.skip, bool) or not isinstance(self.skip, int) or self.skip < 0:
            raise ValueError("skip must be a non-negative integer")
        if isinstance(self.limit, bool) or not isinstance(self.limit, int) or self.limit < 1:
            raise ValueError("limit must be a positive integer")
        if self.limit > MARKETPLACE_BROWSE_LIMIT_MAX:
            raise ValueError(
                f"limit must be ≤ {MARKETPLACE_BROWSE_LIMIT_MAX} (got {self.limit})"
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceBrowseCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceInspectCommand:
    """Inspect one marketplace order's detail (drives ``ClawHuntClient.get_problem``)."""

    command_type: ClassVar[str] = "marketplace.inspect"
    is_read: ClassVar[bool] = True

    problem_id: str

    def validate(self) -> None:
        _require_problem_id(self.problem_id)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceInspectCommand":
        return _strict_from_dict(cls, data)


# --- WRITE commands (every one is HIGH + requires an agent key) ---------------


@dataclass
class MarketplacePostTaskCommand:
    """Publish a problem/task to the marketplace (drives ``ClawHuntClient.post_problem``).

    Creates an EXTERNAL artifact on ClawHunt → HIGH (human approval). Field set
    mirrors the existing ``superclaw clawhunt post`` CLI surface so the governed
    path can never drift from the legacy direct command it收编s.
    """

    command_type: ClassVar[str] = "marketplace.post_task"
    is_read: ClassVar[bool] = False

    title: str
    description: str
    price: int = 1
    category: str = "testing"
    difficulty: str = "easy"
    routing_mode: str = "tiered_overflow"
    target_agent_id: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.title, "title")
        _require_nonempty(self.description, "description")
        _require_positive_int(self.price, "price")
        _require_nonempty(self.category, "category")
        _require_nonempty(self.difficulty, "difficulty")
        _require_nonempty(self.routing_mode, "routing_mode")
        if self.target_agent_id is not None:
            _require_nonempty(self.target_agent_id, "target_agent_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplacePostTaskCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceBidCommand:
    """Bid on a marketplace order (drives ``ClawHuntClient.bid``).

    A commitment to a third party → HIGH. ``amount`` (cents) is optional upstream
    (a bid may carry only a message), but when present must be a positive int.
    """

    command_type: ClassVar[str] = "marketplace.bid"
    is_read: ClassVar[bool] = False

    problem_id: str
    amount: int | None = None
    message: str = ""

    def validate(self) -> None:
        _require_problem_id(self.problem_id)
        if self.amount is not None:
            _require_positive_int(self.amount, "amount")
        if not isinstance(self.message, str):
            raise ValueError("message must be a string")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceBidCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceClaimCommand:
    """Claim a marketplace order and bind it to a delivery company (HIGH).

    Claiming makes a remote COMMITMENT and starts the order's countdown → HIGH
    (human approval). ``company_profile_id`` names the company that will OWN the
    delivery (its delivery Issue + run live under that company); it is a TARGET the
    scope gate validates, NEVER authority — the acting authority is the
    server-injected :class:`~superclaw.company_scope.CompanyScope` (contract B8).

    The handler creates a durable ``MarketplaceOrder`` ledger row keyed by
    ``(base_url, problem_id)`` so two concurrent chats can never both claim the
    same order; the saga (claim → issue → run → submit) advances that row.
    """

    command_type: ClassVar[str] = "marketplace.claim"
    is_read: ClassVar[bool] = False

    problem_id: str
    company_profile_id: str

    def validate(self) -> None:
        _require_problem_id(self.problem_id)
        _require_nonempty(self.company_profile_id, "company_profile_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceClaimCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceSubmitCommand:
    """Submit a completed delivery's evidence to a claimed order (HIGH).

    Targets the ledger ``order_id`` (not a bare problem_id): the handler reads the
    order's bound issue + run, asserts the issue passed its review/completion gate
    (NOT just "evidence exists" — advisor阻断项 6), and only then submits the run's
    evidence bundle via ``ClawHuntClient.submit_solution``. ``solution_text`` is an
    optional human/agent override of the default protocol summary.
    """

    command_type: ClassVar[str] = "marketplace.submit"
    is_read: ClassVar[bool] = False

    order_id: str
    solution_text: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.order_id, "order_id")
        if self.solution_text is not None and not isinstance(self.solution_text, str):
            raise ValueError("solution_text must be a string")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceSubmitCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceAbandonCommand:
    """Abandon a claimed order, releasing the remote commitment (HIGH).

    The compensation action (advisor阻断项 2B): when a claimed order's delivery run
    fails / is cancelled, the order must not deadlock on the remote side until it
    times out and the agent loses reputation. Abandon releases it (or, if ClawHunt
    has no release endpoint, flags the order BLOCKED for human handling) and moves
    the ledger row to a terminal ``abandoned`` state. Releasing a remote
    commitment is itself a deliberate, externally-visible act → HIGH.
    """

    command_type: ClassVar[str] = "marketplace.abandon"
    is_read: ClassVar[bool] = False

    order_id: str
    reason: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.order_id, "order_id")
        if self.reason is not None and not isinstance(self.reason, str):
            raise ValueError("reason must be a string")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceAbandonCommand":
        return _strict_from_dict(cls, data)


# --- BUYER-side commands (default NOT projected to solver chat) ---------------
# accept / accept_bid are payment-side actions a problem POSTER takes, not a
# solver. They are HIGH and require an agent key like every write, but the chat
# tool projection (P3) deliberately omits them from the solver tool set
# (advisor阻断项 3, Codex): a solver agent should never be able to accept its own
# solution or pay out a bid. They remain reachable via the explicit CLI/API for a
# poster, where the human is unambiguously the actor.


@dataclass
class MarketplaceAcceptCommand:
    """Accept a submitted solution on a posted order (drives ``ClawHuntClient.accept``)."""

    command_type: ClassVar[str] = "marketplace.accept"
    is_read: ClassVar[bool] = False
    #: Buyer/payment-side: omitted from the solver chat tool projection (P3).
    buyer_side: ClassVar[bool] = True

    problem_id: str

    def validate(self) -> None:
        _require_problem_id(self.problem_id)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceAcceptCommand":
        return _strict_from_dict(cls, data)


@dataclass
class MarketplaceAcceptBidCommand:
    """Accept a bid on a posted order (drives ``ClawHuntClient.accept_bid``)."""

    command_type: ClassVar[str] = "marketplace.accept_bid"
    is_read: ClassVar[bool] = False
    buyer_side: ClassVar[bool] = True

    problem_id: str
    bid_id: str

    def validate(self) -> None:
        _require_problem_id(self.problem_id)
        _require_nonempty(self.bid_id, "bid_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceAcceptBidCommand":
        return _strict_from_dict(cls, data)


# --- Central registry ---------------------------------------------------------

#: The single map from a stable command_type string to its model class. The
#: handler / CLI / API / tool-schema derivation all index this one map so no
#: surface hand-copies a command list. Mirrors
#: ``company_commands.COMMAND_REGISTRY``.
MARKETPLACE_COMMAND_REGISTRY: dict[str, type] = {
    cls.command_type: cls
    for cls in (
        MarketplaceBrowseCommand,
        MarketplaceInspectCommand,
        MarketplacePostTaskCommand,
        MarketplaceBidCommand,
        MarketplaceClaimCommand,
        MarketplaceSubmitCommand,
        MarketplaceAbandonCommand,
        MarketplaceAcceptCommand,
        MarketplaceAcceptBidCommand,
    )
}

#: Canonical chat-tool NAME for each command_type (P3 tool projection). Kept here
#: — the light vocabulary module — so BOTH the tool-schema source
#: (``ui_contracts``) AND the mutating-tool taxonomy (``permissions``) derive from
#: ONE map and can never drift. Mirrors
#: ``company_commands.COMMAND_TYPE_TO_TOOL_NAME``.
MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME: dict[str, str] = {
    "marketplace.browse": "marketplace_browse",
    "marketplace.inspect": "marketplace_inspect",
    "marketplace.post_task": "marketplace_post_task",
    "marketplace.bid": "marketplace_bid",
    "marketplace.claim": "marketplace_claim",
    "marketplace.submit": "marketplace_submit",
    "marketplace.abandon": "marketplace_abandon",
    "marketplace.accept": "marketplace_accept",
    "marketplace.accept_bid": "marketplace_accept_bid",
}

# Defence against drift: every registered command_type MUST have a tool name and
# vice-versa. A mismatch is a programming error caught at import time.
assert set(MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME) == set(MARKETPLACE_COMMAND_REGISTRY), (
    "MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME drifted from MARKETPLACE_COMMAND_REGISTRY"
)

#: The closed set of chat tool names that are marketplace MUTATIONS (writes only).
#: The permission/containment fence keys off this; reads are not in it.
MARKETPLACE_WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME[ct]
    for ct, cls in MARKETPLACE_COMMAND_REGISTRY.items()
    if not getattr(cls, "is_read", False)
)

#: Tool names that are SOLVER-facing (the chat projection in P3 offers these). The
#: buyer/payment-side accept commands are deliberately excluded — a solver agent
#: must never accept its own solution or pay out a bid (advisor阻断项 3).
MARKETPLACE_SOLVER_TOOL_NAMES: frozenset[str] = frozenset(
    MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME[ct]
    for ct, cls in MARKETPLACE_COMMAND_REGISTRY.items()
    if not getattr(cls, "buyer_side", False)
)


def get_marketplace_command_model(command_type: str) -> type:
    """Return the marketplace command model class for ``command_type``.

    Fail-closed: an unknown command_type raises ``KeyError`` rather than returning
    a default, so a surface can never dispatch an unrecognised mutation.
    """
    try:
        return MARKETPLACE_COMMAND_REGISTRY[command_type]
    except KeyError as exc:
        raise KeyError(
            f"unknown marketplace command_type: {command_type!r} "
            f"(one of {sorted(MARKETPLACE_COMMAND_REGISTRY)})"
        ) from exc
