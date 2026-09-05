"""Read-only company discovery + snapshot for chat-driven company management.

The mutation contract (``company_commands`` / ``company_handler``) lets a chat
agent CHANGE a company but gives it no way to SEE one: the only context is the
thin ``@company`` injection (status + 5 issue titles). An agent that must decide
*who* to assign an issue to, or answer "盘点我有哪些公司 / 这家公司现在什么状态",
is blind. This module is the read half of the control plane — the
``company_list`` (discovery) and ``company_snapshot`` (situational awareness)
tools, mirroring Paperclip's "session-startup: list companies → fetch dashboard"
flow (see docs/company-chat-exposure-roadmap.md §4).

Design constraints (roadmap §5 acceptance items):

  * **Same scope gate, no read-privilege bypass.** Every read reuses the SAME
    :class:`~superclaw.company_scope.CompanyScope` the write handler uses — a
    snapshot of an out-of-scope company raises :class:`CompanyScopeError`, and
    ``company_list`` returns ONLY the companies the scope permits. There is no
    separate, looser read authority.
  * **Bounded, store-level DTO — no N+1 / OOM.** A snapshot loads exactly ONE
    company's roster / issues / approvals / cost rollup via the store's
    company-scoped queries (``list_agent_profiles(company_profile_id=...)`` etc.),
    never a cross-company scan, and caps every embedded list with an explicit
    ``*_total`` count alongside (no silent truncation).
  * **Read-only.** No risk classification, no approval, no lifecycle freeze gate
    (a frozen/archived company is still legitimately *readable* — indeed the
    operator most needs to see an archived company's residue). These reads NEVER
    mutate, so they skip the write handler's machinery entirely.

Single source: :func:`build_company_snapshot_payload` /
:func:`build_company_list_payload` are the ONE DTO builders that CLI, API, and
the chat tool projection all call, so the three surfaces never drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import time
from typing import Any, ClassVar

from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import IssueStatus, TERMINAL_ISSUE_STATUSES
from superclaw.state import StateStore

# Explicit caps so an embedded list can never blow the model's context (or the
# API response). Each capped list ships its real total alongside (``*_total``),
# so a caller always knows when it is seeing a slice — never a silent truncation.
_ROSTER_CAP = 50
_RECENT_ISSUES_CAP = 8
_ISSUE_LIST_CAP = 50
_THREAD_COMMENTS_CAP = 50
_WORK_PRODUCTS_CAP = 30
_APPROVAL_LIST_CAP = 50
_BOARD_INBOX_CAP = 50
# Free-text bodies (comments, work-product summaries) are truncated so a read tool
# can never dump a large blob into the model prompt (the agy fail-safe): the agent
# sees a bounded excerpt + a truncation marker, never the full payload.
_TEXT_EXCERPT_CHARS = 600

# An OPEN (non-terminal) issue whose last update is older than this is "stale"
# (Paperclip dashboard parity: surface neglected work). Counted, not listed.
_STALE_AFTER_SECONDS = 3 * 24 * 60 * 60  # 3 days

# All issue lanes, in board order, so by-status counts are STABLE (every status
# present with an explicit 0) rather than only the statuses that happen to occur.
_ISSUE_STATUS_ORDER: tuple[str, ...] = (
    IssueStatus.BACKLOG.value,
    IssueStatus.TODO.value,
    IssueStatus.IN_PROGRESS.value,
    IssueStatus.IN_REVIEW.value,
    IssueStatus.BLOCKED.value,
    IssueStatus.DONE.value,
    IssueStatus.CANCELLED.value,
)


def _strict_from_dict(cls: type, data: dict[str, Any]) -> Any:
    """Construct ``cls`` from ``data``, rejecting unknown keys (fail-closed).

    Mirrors ``company_commands._strict_from_dict``: a read tool is part of the
    same chat tool contract, so an unrecognised arg is an error (a typo'd field
    must surface, not be silently ignored), keeping the projected JSON schema and
    the model in lockstep.
    """
    known = set(cls.__dataclass_fields__)  # type: ignore[attr-defined]
    unknown = [k for k in data if k not in known]
    if unknown:
        raise ValueError(
            f"unknown fields for {cls.__name__}: {sorted(unknown)} "
            f"(known: {sorted(known)})"
        )
    return cls(**data)


@dataclass
class CompanyListRead:
    """List the companies the actor's scope permits (discovery).

    No company target: this is the "what companies do I have" entry, so scope
    FILTERS the result set (admin → all; otherwise the actor's allow-set) rather
    than rejecting. ``include_archived`` defaults False so the common case sees
    only live companies; the operator can opt into the full set.
    """

    command_type: ClassVar[str] = "company.list"

    include_archived: bool = False

    def validate(self) -> None:
        # Fail-closed on type: a non-bool (e.g. the string "false", which is truthy)
        # must NOT be coerced — it would silently flip archived companies into view.
        if not isinstance(self.include_archived, bool):
            raise ValueError("include_archived must be a boolean")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyListRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class CompanySnapshotRead:
    """A bounded situational-awareness snapshot of ONE company (dashboard parity).

    ``company_profile_id`` is OPTIONAL: absent/blank means the actor's home
    company (the ``@company``-homed scope), so "@company X … give me a snapshot"
    needs no id from the model — exactly the home-company convention the write
    commands use. A provided id is scope-checked like any target.
    """

    command_type: ClassVar[str] = "company.snapshot"

    company_profile_id: str | None = None

    def validate(self) -> None:
        # Fail-closed on type: a non-str, non-None id (e.g. 123 / [..]) is unverifiable.
        # Without this it would slip past the ``isinstance(raw, str)`` home-fallback in
        # execute_company_read and silently return the HOME company snapshot instead of
        # surfacing the malformed target — an absent target and a corrupt one must not
        # look the same.
        if self.company_profile_id is not None and not isinstance(self.company_profile_id, str):
            raise ValueError("company_profile_id must be a string or omitted")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanySnapshotRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


def _require_str(value: Any, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} is required and must be a non-empty string")


def _opt_str_or_none(value: Any, field_name: str) -> None:
    if value is not None and not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string or omitted")


@dataclass
class AgentListRead:
    """List a company's agent roster (id/name/role/model/effort). Discovery."""

    command_type: ClassVar[str] = "agent.list"

    company_profile_id: str | None = None

    def validate(self) -> None:
        _opt_str_or_none(self.company_profile_id, "company_profile_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentListRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class AgentShowRead:
    """One agent's full config + governed equipment (model/effort/budget/skills)."""

    command_type: ClassVar[str] = "agent.show"

    profile_id: str = ""

    def validate(self) -> None:
        _require_str(self.profile_id, "profile_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentShowRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class IssueListRead:
    """A company's issues, optionally filtered by status / assignee (bounded)."""

    command_type: ClassVar[str] = "issue.list"

    company_profile_id: str | None = None
    status: str | None = None
    assignee_agent_profile_id: str | None = None
    limit: int = _ISSUE_LIST_CAP

    def validate(self) -> None:
        _opt_str_or_none(self.company_profile_id, "company_profile_id")
        _opt_str_or_none(self.status, "status")
        _opt_str_or_none(self.assignee_agent_profile_id, "assignee_agent_profile_id")
        # bool is an int subclass — reject it explicitly so True/False can't be a limit.
        if not isinstance(self.limit, int) or isinstance(self.limit, bool) or self.limit <= 0:
            raise ValueError("limit must be a positive integer")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueListRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class IssueShowRead:
    """One issue's detail (title/status/assignee/kind/review_policy/timestamps)."""

    command_type: ClassVar[str] = "issue.show"

    issue_id: str = ""

    def validate(self) -> None:
        _require_str(self.issue_id, "issue_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueShowRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class IssueThreadRead:
    """One issue's comment thread (bounded, bodies excerpted)."""

    command_type: ClassVar[str] = "issue.thread"

    issue_id: str = ""

    def validate(self) -> None:
        _require_str(self.issue_id, "issue_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueThreadRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class IssueWorkProductsRead:
    """One issue's work products (delivery facts) — metadata + excerpted summary."""

    command_type: ClassVar[str] = "issue.work_products"

    issue_id: str = ""

    def validate(self) -> None:
        _require_str(self.issue_id, "issue_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IssueWorkProductsRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class ApprovalListRead:
    """A company's PENDING approvals (id/type/issue/requested_by) — the human gate."""

    command_type: ClassVar[str] = "approval.list"

    company_profile_id: str | None = None

    def validate(self) -> None:
        _opt_str_or_none(self.company_profile_id, "company_profile_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ApprovalListRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class MessagesRead:
    """A company's message-center roll-up (pending/completed-unreviewed/blocked)."""

    command_type: ClassVar[str] = "messages.read"

    company_profile_id: str | None = None

    def validate(self) -> None:
        _opt_str_or_none(self.company_profile_id, "company_profile_id")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MessagesRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


@dataclass
class BoardInboxListRead:
    """A company's durable ESCALATE_TO_BOARD escalations — the human-escalation
    queue. Capped summary; ``status`` defaults to pending (None/"all"/"*" → every
    status). The read tool that lets an operator SEE the items board_inbox.resolve /
    board_inbox.assign act on."""

    command_type: ClassVar[str] = "board_inbox.list"

    company_profile_id: str | None = None
    status: str | None = "pending"

    def validate(self) -> None:
        _opt_str_or_none(self.company_profile_id, "company_profile_id")
        _opt_str_or_none(self.status, "status")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BoardInboxListRead":
        read = _strict_from_dict(cls, data)
        read.validate()
        return read


_READ_REGISTRY: dict[str, type] = {
    CompanyListRead.command_type: CompanyListRead,
    CompanySnapshotRead.command_type: CompanySnapshotRead,
    AgentListRead.command_type: AgentListRead,
    AgentShowRead.command_type: AgentShowRead,
    IssueListRead.command_type: IssueListRead,
    IssueShowRead.command_type: IssueShowRead,
    IssueThreadRead.command_type: IssueThreadRead,
    IssueWorkProductsRead.command_type: IssueWorkProductsRead,
    ApprovalListRead.command_type: ApprovalListRead,
    MessagesRead.command_type: MessagesRead,
    BoardInboxListRead.command_type: BoardInboxListRead,
}


def get_company_read_model(command_type: str) -> type:
    """Return the read model for ``command_type`` (fail-closed: KeyError if unknown)."""
    return _READ_REGISTRY[command_type]


# --- DTO builders: the single source every surface (CLI/API/chat) calls -------


def build_company_list_payload(store: StateStore, scope: CompanyScope, *, include_archived: bool = False) -> dict[str, Any]:
    """Companies the ``scope`` permits, newest first. Discovery, scope-filtered.

    Admin scope sees every company; a non-admin sees only those in its allow-set
    (``scope.permits`` is the SAME gate the write handler uses — no looser read
    authority). Archived companies are excluded unless ``include_archived``.
    """
    out: list[dict[str, Any]] = []
    for company in store.list_company_profiles():
        cid = company.company_profile_id
        if not scope.permits(cid):
            continue
        status = str(getattr(company, "status", "") or "active")
        if not include_archived and status not in ("active", "frozen"):
            continue
        out.append(
            {
                "company_profile_id": cid,
                "name": company.name,
                "status": status,
                "goal": getattr(company, "goal", "") or "",
            }
        )
    return {"companies": out, "company_count": len(out)}


def build_company_snapshot_payload(store: StateStore, company_profile_id: str) -> dict[str, Any]:
    """A bounded dashboard DTO for ONE company. The single snapshot source.

    Genuinely bounded at the STORE layer: issue counts come from a SQLite GROUP BY
    / COUNT (``count_company_issues_by_status`` / ``count_company_stale_open_issues``)
    and the roster / recent lists from SQL ``LIMIT`` queries
    (``list_company_agents`` / ``recent_company_issues``) — so a company with 100k
    issues never materializes 100k ``Issue`` objects in Python just to count them.
    The pending-approval count is a SQLite COUNT too
    (``count_company_pending_approvals``) that replicates the two-path company
    attribution without materializing approval payloads or per-issue N+1 lookups.
    Every embedded list is capped with its true total beside it (no silent
    truncation). Raises ``KeyError`` for an unknown company (the caller has already
    scope-checked the id).
    """
    company = store.get_company_profile(company_profile_id)  # KeyError -> unknown

    # Roster — bounded fetch (SQL LIMIT) + a separate SQL COUNT for the true total,
    # so a >cap roster is capped in the response but never silently undercounted.
    agents = store.list_company_agents(company_profile_id, limit=_ROSTER_CAP)
    agent_total = store.count_company_agents(company_profile_id)
    roster = [
        {
            "profile_id": a.profile_id,
            "name": a.name,
            "role": a.role,
            "title": getattr(a, "title", None),
            "backend": getattr(a, "backend_policy", ""),
            "model": getattr(a, "model", "") or "",
            "effort": getattr(a, "effort", "") or "",
            "reports_to": getattr(a, "reports_to", None),
        }
        for a in agents
    ]

    # Issues — counts aggregated in SQLite (no full-object materialization); every
    # board lane present with an explicit count (stable schema, even 0).
    raw_counts = store.count_company_issues_by_status(company_profile_id)
    by_status = {status: int(raw_counts.get(status, 0)) for status in _ISSUE_STATUS_ORDER}
    issue_total = sum(by_status.values())
    open_count = sum(
        n for status, n in by_status.items() if status not in TERMINAL_ISSUE_STATUSES
    )
    stale_count = store.count_company_stale_open_issues(
        company_profile_id,
        terminal_statuses=tuple(TERMINAL_ISSUE_STATUSES),
        stale_before=time() - _STALE_AFTER_SECONDS,
    )
    recent = [
        {
            "issue_id": i.issue_id,
            "title": i.title,
            "status": i.status,
            "assignee": getattr(i, "assignee_agent_profile_id", None),
        }
        for i in store.recent_company_issues(company_profile_id, limit=_RECENT_ISSUES_CAP)
    ]

    pending_approval_count = store.count_company_pending_approvals(company_profile_id)
    cost = store.summarize_cost(company_profile_id=company_profile_id)

    return {
        "company": {
            "company_profile_id": company.company_profile_id,
            "name": company.name,
            "status": str(getattr(company, "status", "") or "active"),
            "goal": getattr(company, "goal", "") or "",
        },
        "roster": {"agents": roster, "agent_total": agent_total},
        "issues": {
            "by_status": by_status,
            "open_count": open_count,
            "stale_count": stale_count,
            "issue_total": issue_total,
            "recent": recent,
        },
        "approvals": {"pending_count": pending_approval_count},
        "cost": {
            "total_cost_cents": cost.get("total_cost_cents", 0),
            "total_tokens": cost.get("total_tokens", 0),
            "event_count": cost.get("event_count", 0),
        },
    }


# --- scope helpers (reuse the write handler's gate — no read-privilege bypass) ---


def _homed_company(raw: Any, scope: CompanyScope, *, label: str) -> str:
    """A company-scoped read's target: the given id, else the actor's home company.

    Reuses ``scope.permits`` — an out-of-scope id is forbidden, never silently
    widened. A non-str/blank id homes to ``scope.actor_company_id`` (the read
    models already type-reject a non-str non-None id at ``validate``)."""
    company_id = raw if isinstance(raw, str) and raw.strip() else scope.actor_company_id
    if not scope.permits(company_id):
        raise CompanyScopeError(
            f"{label}: company {company_id!r} is outside the actor's scope "
            f"(allowed: {sorted(scope.allowed_company_ids)})",
            target_company=company_id,
        )
    return company_id


def _assert_company_in_scope(company_id: Any, scope: CompanyScope, *, label: str) -> None:
    """An entity-anchored read: the resolved entity's company must be in scope.

    Fail-closed on a corrupt persisted company id: a resolved entity MUST carry a
    concrete non-empty ``str`` company. ``scope.permits(None/"")`` returns True
    (a blank INPUT id means "home"), but a resolved ENTITY with a blank company is
    corrupt data, not a home reference — treating it as home would let a dirty row
    slip the gate. So we reject a non-str/blank resolved id BEFORE ``permits``
    (mirrors the write handler's ``_require_resolved_company``)."""
    if not isinstance(company_id, str) or not company_id:
        raise CompanyScopeError(
            f"{label}: resolved entity has an unverifiable company id {company_id!r} "
            f"(corrupt/blank — fail-closed)",
            target_company=company_id,
        )
    if not scope.permits(company_id):
        raise CompanyScopeError(
            f"{label}: company {company_id!r} is outside the actor's scope",
            target_company=company_id,
        )


def _excerpt(text: Any) -> dict[str, Any]:
    """A bounded text excerpt + truncation marker (never dump a large blob)."""
    s = str(text or "")
    if len(s) <= _TEXT_EXCERPT_CHARS:
        return {"text": s, "truncated": False, "full_length": len(s)}
    return {"text": s[:_TEXT_EXCERPT_CHARS], "truncated": True, "full_length": len(s)}


# --- P1 read DTO builders -----------------------------------------------------


def _agent_summary(a: Any) -> dict[str, Any]:
    return {
        "profile_id": a.profile_id,
        "name": a.name,
        "role": a.role,
        "title": getattr(a, "title", None),
        "backend": getattr(a, "backend_policy", ""),
        "model": getattr(a, "model", "") or "",
        "effort": getattr(a, "effort", "") or "",
        "reports_to": getattr(a, "reports_to", None),
    }


def build_agent_list_payload(store: StateStore, company_profile_id: str) -> dict[str, Any]:
    """A company's roster (capped) + true total — discovery for assign decisions."""
    agents = store.list_company_agents(company_profile_id, limit=_ROSTER_CAP)
    return {
        "company_profile_id": company_profile_id,
        "agents": [_agent_summary(a) for a in agents],
        "agent_total": store.count_company_agents(company_profile_id),
    }


def build_agent_show_payload(store: StateStore, profile_id: str) -> dict[str, Any]:
    """One agent's full config + governed equipment. Raises KeyError if unknown."""
    profile = store.get_agent_profile(profile_id)  # KeyError -> unknown
    detail = dict(_agent_summary(profile))
    detail.update(
        {
            "company_profile_id": profile.company_profile_id,
            "persona": getattr(profile, "persona", None),
            "context_mode": getattr(profile, "context_mode", None),
            "budget_seconds": getattr(profile, "budget_seconds", None),
            "token_budget": getattr(profile, "token_budget", None),
            "plugin_allowlist": list(getattr(profile, "plugin_allowlist", []) or []),
            "skill_allowlist": list(getattr(profile, "skill_allowlist", []) or []),
        }
    )
    # Governed equipment (best-effort: a resolution failure must not break the read).
    try:
        from superclaw.team_kernel import resolve_equipment

        resolution = resolve_equipment(profile)
        detail["granted_tools"] = list(getattr(resolution, "granted", []) or [])
    except Exception:  # noqa: BLE001 — equipment is advisory context, not the read's contract
        detail["granted_tools"] = None
    return {"agent": detail}


def _issue_summary(i: Any) -> dict[str, Any]:
    return {
        "issue_id": i.issue_id,
        "title": i.title,
        "status": i.status,
        "assignee": getattr(i, "assignee_agent_profile_id", None),
        "kind": getattr(i, "kind", None),
        "priority": getattr(i, "priority", None),
        "parent_id": getattr(i, "parent_id", None),
        "updated_at": getattr(i, "updated_at", None),
    }


def build_issue_list_payload(
    store: StateStore,
    company_profile_id: str,
    *,
    status: str | None,
    assignee_agent_profile_id: str | None,
    limit: int,
) -> dict[str, Any]:
    """A company's issues, optionally filtered, SQL-bounded (capped at ``limit``)."""
    capped = min(int(limit), _ISSUE_LIST_CAP)
    issues = store.list_company_issues(
        company_profile_id,
        status=status,
        assignee_agent_profile_id=assignee_agent_profile_id,
        limit=capped,
    )
    return {
        "company_profile_id": company_profile_id,
        "filter": {"status": status, "assignee": assignee_agent_profile_id},
        "issues": [_issue_summary(i) for i in issues],
        "returned": len(issues),
        "limit": capped,
    }


def build_issue_show_payload(issue: Any) -> dict[str, Any]:
    """One issue's detail. Takes an ALREADY-RESOLVED + scope-checked issue (the
    handler fetches it, checks scope, THEN builds — no sub-resource read before the
    gate)."""
    detail = dict(_issue_summary(issue))
    detail.update(
        {
            "company_profile_id": issue.company_profile_id,
            "description": _excerpt(getattr(issue, "description", "")),
            "review_policy": getattr(issue, "review_policy", None),
            "workspace_id": getattr(issue, "workspace_id", None),
            "created_at": getattr(issue, "created_at", None),
            "created_by": getattr(issue, "created_by", None),
        }
    )
    return {"issue": detail}


def build_issue_thread_payload(store: StateStore, issue: Any) -> dict[str, Any]:
    """One issue's comment thread (bounded, bodies excerpted). The handler has
    already resolved the issue + checked scope, so reading the comments here happens
    ONLY after the gate (no read-before-check side channel)."""
    comments = store.list_issue_comments(issue.issue_id, limit=_THREAD_COMMENTS_CAP + 1)
    truncated = len(comments) > _THREAD_COMMENTS_CAP
    rendered = [
        {
            "comment_id": c.comment_id,
            "author_type": c.author_type,
            "author_id": c.author_id,
            "created_at": c.created_at,
            "body": _excerpt(c.body),
        }
        for c in comments[:_THREAD_COMMENTS_CAP]
    ]
    return {
        "issue_id": issue.issue_id,
        "comments": rendered,
        "returned": len(rendered),
        "more_available": truncated,
    }


def build_issue_work_products_payload(store: StateStore, issue: Any) -> dict[str, Any]:
    """One issue's work products — metadata + excerpted summary, NEVER raw bytes.

    The handler has already resolved the issue + checked scope, so the sub-resource
    fetch happens ONLY after the gate. The fetch is itself SQL-bounded (LIMIT
    _WORK_PRODUCTS_CAP+1, to detect "more") so a pathological issue can never
    materialize an unbounded work-product set. A work product is a delivery FACT (a
    link/ref) — the agent gets enough to reason without dumping a large body."""
    products = store.list_work_products(issue_id=issue.issue_id, limit=_WORK_PRODUCTS_CAP + 1)
    truncated = len(products) > _WORK_PRODUCTS_CAP
    rendered = [
        {
            "work_product_id": wp.work_product_id,
            "type": wp.type,
            "title": wp.title,
            "provider": wp.provider,
            "url": wp.url,
            "external_id": wp.external_id,
            "status": wp.status,
            "is_primary": wp.is_primary,
            "summary": _excerpt(wp.summary),
        }
        for wp in products[:_WORK_PRODUCTS_CAP]
    ]
    return {
        "issue_id": issue.issue_id,
        "work_products": rendered,
        "returned": len(rendered),
        "more_available": truncated,
    }


def build_board_inbox_list_payload(
    store: StateStore, company_profile_id: str, *, status: str | None = "pending"
) -> dict[str, Any]:
    """A company's board-inbox escalations — capped summary, store-bounded.

    The store query filters to this company + ESCALATE_TO_BOARD and caps the rows,
    so this never materialises non-board interactions or another company's queue.
    Fetches ONE more than the cap so ``capped`` reports truncation HONESTLY — exactly
    ``_BOARD_INBOX_CAP`` matching rows with no overflow is NOT capped."""
    items = store.list_board_inbox_items(
        company_profile_id, status=status, limit=_BOARD_INBOX_CAP + 1
    )
    capped = len(items) > _BOARD_INBOX_CAP
    rendered = [
        {
            "interaction_id": it.interaction_id,
            "issue_id": it.issue_id,
            "kind": it.kind,
            "status": it.status,
            "target_agent_profile_id": it.target_agent_profile_id,
            "created_at": it.created_at,
        }
        for it in items[:_BOARD_INBOX_CAP]
    ]
    return {
        "company_profile_id": company_profile_id,
        "status_filter": status,
        "items": rendered,
        "returned": len(rendered),
        "capped": capped,
    }


def build_approval_list_payload(store: StateStore, company_profile_id: str) -> dict[str, Any]:
    """A company's PENDING approvals (the human gate) — capped summary."""
    approvals = store.list_approvals(status="pending", company_profile_id=company_profile_id)
    rendered = [
        {
            "approval_id": a.approval_id,
            "type": a.type,
            "issue_id": a.issue_id,
            "requested_by": getattr(a, "requested_by", None),
            "created_at": getattr(a, "created_at", None),
        }
        for a in approvals[:_APPROVAL_LIST_CAP]
    ]
    return {
        "company_profile_id": company_profile_id,
        "approvals": rendered,
        "returned": len(rendered),
        "pending_total": len(approvals),
    }


# --- handler: the single read execution point (mirrors execute_company_command) -


def execute_company_read(
    read: Any, *, scope: CompanyScope, store: StateStore
) -> dict[str, Any]:
    """Run a read against the kernel, scope-gated. Returns the model-facing DTO.

    Reuses ``scope.permits`` (the write handler's gate) so reads never bypass the
    boundary: ``company_list`` filters to permitted companies; ``company_snapshot``
    refuses an out-of-scope target with :class:`CompanyScopeError`. An absent
    snapshot id homes to ``scope.actor_company_id``. Read-only — no risk gate, no
    lifecycle freeze gate, no mutation.
    """
    if isinstance(read, CompanyListRead):
        return build_company_list_payload(
            store, scope, include_archived=read.include_archived
        )

    if isinstance(read, CompanySnapshotRead):
        # Absent/blank id → the actor's home company (server-scoped, same as the
        # write commands' home convention). A provided id is scope-checked.
        raw = read.company_profile_id
        company_id = raw if isinstance(raw, str) and raw.strip() else scope.actor_company_id
        if not scope.permits(company_id):
            raise CompanyScopeError(
                f"company.snapshot: company {company_id!r} is outside the actor's "
                f"scope (allowed: {sorted(scope.allowed_company_ids)})",
                target_company=company_id,
            )
        return build_company_snapshot_payload(store, company_id)

    # --- P1 read tools (same scope gate; entity-anchored reads resolve + check) ---

    if isinstance(read, AgentListRead):
        cid = _homed_company(read.company_profile_id, scope, label="agent.list")
        return build_agent_list_payload(store, cid)

    if isinstance(read, AgentShowRead):
        # Resolve the agent first (KeyError → unknown), then check ITS company is in
        # scope — an agent in a foreign company is forbidden, not silently shown.
        profile = store.get_agent_profile(read.profile_id)
        _assert_company_in_scope(profile.company_profile_id, scope, label="agent.show")
        return build_agent_show_payload(store, read.profile_id)

    if isinstance(read, IssueListRead):
        cid = _homed_company(read.company_profile_id, scope, label="issue.list")
        return build_issue_list_payload(
            store, cid,
            status=read.status,
            assignee_agent_profile_id=read.assignee_agent_profile_id,
            limit=read.limit,
        )

    if isinstance(read, IssueShowRead):
        # Resolve → scope-check → THEN build (no sub-resource read before the gate).
        issue = store.get_issue(read.issue_id)
        _assert_company_in_scope(issue.company_profile_id, scope, label="issue.show")
        return build_issue_show_payload(issue)

    if isinstance(read, IssueThreadRead):
        issue = store.get_issue(read.issue_id)
        _assert_company_in_scope(issue.company_profile_id, scope, label="issue.thread")
        # Comments are read ONLY after the scope gate clears.
        return build_issue_thread_payload(store, issue)

    if isinstance(read, IssueWorkProductsRead):
        issue = store.get_issue(read.issue_id)
        _assert_company_in_scope(issue.company_profile_id, scope, label="issue.work_products")
        # Work products are read ONLY after the scope gate clears.
        return build_issue_work_products_payload(store, issue)

    if isinstance(read, ApprovalListRead):
        cid = _homed_company(read.company_profile_id, scope, label="approval.list")
        return build_approval_list_payload(store, cid)

    if isinstance(read, MessagesRead):
        cid = _homed_company(read.company_profile_id, scope, label="messages.read")
        from superclaw.ui_contracts import build_company_messages_payload

        return build_company_messages_payload(store, company_profile_id=cid)

    if isinstance(read, BoardInboxListRead):
        cid = _homed_company(read.company_profile_id, scope, label="board_inbox.list")
        return build_board_inbox_list_payload(store, cid, status=read.status)

    # Default-deny: an unrecognised read model can never be dispatched.
    raise ValueError(f"no dispatch for company read: {type(read).__name__!r}")
