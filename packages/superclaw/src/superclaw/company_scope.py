"""ExecutionContext scope check for chat-driven company management.

This module answers ONE question for each company-management command:
*does every company the command touches — top-level AND nested ref — fall inside
the scope the caller injected?* If a target falls outside, the command is
refused (raised as a :class:`CompanyScopeError` / ``PermissionError`` subclass).

Role under the re-ratified threat model (design §1, 2026-06-22)
--------------------------------------------------------------
SuperClaw is a **single-user, local tool**; the one user owns all of their
companies, and the agent is that user's own assistant doing what the user told
it to do. So this gate is NOT a security boundary defending one company's data
against a hostile cross-company agent. Its job is **correctness / mistake
prevention**:

  * resolve the REAL company of every entity the command targets (and of nested
    refs — a hire's workspace, an issue's workspace, a reports-to manager) and
    keep all of them **same-origin**, so a command can never accidentally write
    a cross-origin object (e.g. company A holding a workspace-B issue);
  * fail closed on data we cannot interpret (missing store, unknown entity,
    a non-``str`` company id) rather than guessing — a structural-integrity
    check, not an authorization wall.

The acting :class:`CompanyScope` is **injected by the caller** (the PR-F tool
projection / handler wiring derives it server-side). Because the user owns all
their companies, that injected scope can be **wide** (admin / all-companies) so
the user can operate on any of their own companies; this module just verifies
the command's targets are inside whatever scope was injected and are mutually
same-origin. It does NOT itself decide what the user is "allowed" to own.

Relationship to the risk gate (``company_risk.classify_company_action``)
------------------------------------------------------------------------
Two different, complementary checks:

  * The **scope gate** here is a structural correctness check (targets resolve,
    same-origin, inside the injected scope) and runs FIRST.
  * The **risk gate** then decides LOW (run straight through) vs. HIGH (pause for
    a lightweight human "are you sure?" confirmation). Under the re-ratified
    threat model only IRREVERSIBLE operations (archive) are HIGH; everything
    else a user triggers is LOW.

Fail-closed posture
-------------------
  * A command whose target company cannot be *resolved* (a nested ref lookup
    needs the store and the store is ``None``, or the referenced entity does not
    exist) is refused, never assumed benign — we cannot prove same-origin.
  * A ``company_profile_id`` that is not a ``str`` (malformed / corrupt data) is
    refused: a non-string is an unverifiable scope, not an "absent" one, and
    must not slip past a truthiness / ``is not None`` check.
  * An unrecognised command type is refused (default-deny).

See docs/company-chat-management-design.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from superclaw.company_commands import (
    AssignBoardInboxCommand,
    AssignIssueCommand,
    AttachWorkProductCommand,
    AuthorRoutineCommand,
    BlockIssueCommand,
    CancelIssueTreeCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    HoldIssueCommand,
    PauseIssueTreeCommand,
    PostIssueCommentCommand,
    RequeueIssueCommand,
    ResolveBoardInboxCommand,
    ResumeIssueTreeCommand,
    SubmitReviewCommand,
    UnblockIssueCommand,
    UnholdIssueCommand,
    UpdateAgentCharterCommand,
    UpdateAgentCommand,
    UpdateWorkProductCommand,
)

# P2 issue-lifecycle commands: all ISSUE-ANCHORED (the only company target is the
# issue's own, resolved via the store) and carrying a single ``issue_id`` field —
# so the scope / lifecycle gates treat them exactly like the comment/attach/submit
# family. Grouped here so the gates can enumerate them in one place.
_ISSUE_ANCHORED_LIFECYCLE = (
    BlockIssueCommand,
    UnblockIssueCommand,
    HoldIssueCommand,
    UnholdIssueCommand,
    RequeueIssueCommand,
    PauseIssueTreeCommand,
    ResumeIssueTreeCommand,
    CancelIssueTreeCommand,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from superclaw.state import StateStore


class CompanyScopeError(PermissionError):
    """A company-management command crossed the actor's authorized scope.

    A :class:`PermissionError` subclass on purpose: contract B8 maps a cross-
    boundary target to a hard *forbidden* (403), semantically distinct from the
    risk gate's "high-risk → ask" (a ``ValueError`` / verdict, recoverable via
    human approval). Carries the offending target and a human-readable reason so
    the caller / audit log records exactly which boundary was crossed.
    """

    def __init__(self, reason: str, *, target_company: Any = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.target_company = target_company


@dataclass(frozen=True)
class CompanyScope:
    """The server-injected actor scope a command is checked against (contract B8).

    Every field here is authority that the SERVER derives from the authenticated
    principal — NEVER from the request body. The command's own
    ``company_id`` / ``workspace_id`` are request *targets*, checked against this
    scope; they are never the source of permission.

    This is a focused stand-in for the part of the (dict-shaped) RunSession
    execution_context that carries actor authority. It is intentionally minimal:
    just enough to decide whether a target company is in scope.

    Attributes
    ----------
    principal_id:
        The acting operator's identity (server-injected). Recorded for audit;
        not itself a company-scope key.
    actor_company_id:
        The company the acting principal is scoped to. The implicit, always-
        permitted home company.
    allowed_company_ids:
        The full set of companies this principal may operate on. If constructed
        empty it is normalised to ``{actor_company_id}`` (a principal can always
        act within its own company). ``actor_company_id`` is always folded in.
    is_admin:
        Only an explicit cross-company admin may target a company outside
        ``allowed_company_ids``. Defaults to ``False`` (fail-closed): an ordinary
        principal can never cross the boundary.
    actor_agent_profile_id:
        The profile id of the AUTONOMOUS agent acting under this scope, or
        ``None`` for the human operator. Server-injected from the run's bound
        agent profile (orchestrator ``_company_scope_for_run``), NEVER from a
        command body. It identifies WHICH agent is acting so the autonomy gates
        (柱子 1b) can enforce org-subtree delegation/assignment limits and attribute
        a posted comment to its real author. A blank/non-str value degrades to
        ``None`` (no acting agent) and, combined with ``is_admin=False``, fails
        the autonomy gates closed: an agent that cannot be identified can neither
        delegate outside a subtree it cannot prove nor submit work it cannot own.
    """

    principal_id: str
    actor_company_id: str
    allowed_company_ids: frozenset[str] = field(default_factory=frozenset)
    is_admin: bool = False
    actor_agent_profile_id: str | None = None
    respond_issue_id: str | None = None
    """Run-scoped respond grant: when set, the acting agent may post a SINGLE
    comment on this one issue's thread EVEN IF it does not own the issue (an
    @-mentioned / human-triggered respond run). It is a single value (never a
    list — grants do not accumulate), authorizes ONLY the comment action on
    ONLY this issue for ONLY this run, and is server-injected by the kernel from
    the run's RunTicket / execution_context — NEVER taken from a command body. A
    blank/non-str value degrades to None (no grant), so a malformed value can
    never spuriously authorize a non-owned comment.

    The grant is SINGLE-USE: the autonomy gate consumes it atomically in the
    durable store (``state.consume_respond_grant``) keyed by ``(run_id,
    respond_issue_id)``, so a respond run may post EXACTLY ONE non-owned comment
    even if the model loops the comment tool — the second call's consume fails
    and falls back to the ownership check (refused). Consumption requires
    ``run_id`` (below) to be set; without it the grant cannot be consumed and the
    comment falls back to ownership."""
    run_id: str | None = None
    """The run this scope acts under (server-injected). Used SOLELY to bind a
    run-scoped authorization (the respond grant above) to a specific run for
    single-use consumption: the autonomy gate consumes the respond grant in the
    store keyed by ``(run_id, respond_issue_id)``. It is NOT a permission key on
    its own and is never taken from a command body. A blank/non-str value
    degrades to None (so a malformed value cannot key a consume) — same handling
    as ``respond_issue_id``; with ``run_id is None`` a respond grant simply
    cannot be consumed and the comment falls back to the ownership check."""

    def __post_init__(self) -> None:
        # Frozen dataclass: mutate via object.__setattr__. Always include the
        # actor's own company, and coerce to a frozenset so the scope is
        # immutable and an empty allow-set degrades to "own company only".
        normalized = frozenset(self.allowed_company_ids) | {self.actor_company_id}
        object.__setattr__(self, "allowed_company_ids", normalized)
        # A blank / non-str acting-agent id is "no identified agent": degrade to
        # None so the autonomy gates fail closed rather than matching a profile.
        agent_id = self.actor_agent_profile_id
        if not (isinstance(agent_id, str) and agent_id):
            object.__setattr__(self, "actor_agent_profile_id", None)
        # A blank / whitespace-only / non-str respond grant is "no grant": degrade
        # to None so a non-owned comment can never slip through on a malformed
        # value. We strip (stronger than the actor-id empty-only check) because an
        # all-whitespace id can never equal a real issue id and is meaningless.
        respond_id = self.respond_issue_id
        if not (isinstance(respond_id, str) and respond_id.strip()):
            object.__setattr__(self, "respond_issue_id", None)
        # A blank / whitespace-only / non-str run id cannot key a single-use
        # consume: degrade to None (same posture as respond_issue_id) so a
        # malformed value never participates in grant consumption — the comment
        # simply falls back to the ownership check.
        run_id = self.run_id
        if not (isinstance(run_id, str) and run_id.strip()):
            object.__setattr__(self, "run_id", None)

    def permits(self, company_id: Any) -> bool:
        """Is ``company_id`` inside this actor's scope?

        An admin scope permits any company (existence is still proven separately
        by the resolver). Otherwise:

          * ``None`` / ``""`` → ``True``: an absent/blank target means "this
            company" (the server injects the actor's scope; the kernel treats a
            blank id as the actor's home company).
          * a ``str`` in ``allowed_company_ids`` → ``True``.
          * EVERYTHING ELSE — a different company string, OR any non-``str`` type
            (``123`` / ``[...]`` / ``{...}``) — → ``False``. A non-string id is
            not "absent"; it is an unverifiable scope and must fail closed.
        """
        # A non-str, non-None id is an unverifiable scope — rejected FIRST, before
        # the admin short-circuit, so even an admin cannot slip a malformed id
        # (e.g. 123 / [...]) past _check (fail-closed, matches the docstring).
        if company_id is None or company_id == "":
            return True
        if not isinstance(company_id, str):
            return False
        if self.is_admin:
            return True
        return company_id in self.allowed_company_ids


def _check(company_id: Any, scope: CompanyScope, *, label: str) -> None:
    """Raise :class:`CompanyScopeError` unless ``company_id`` is in ``scope``.

    A non-``str`` id is treated as an unverifiable (forbidden) scope, not as an
    absent one — the same type-escape defense the risk gate applies.
    """
    if not scope.permits(company_id):
        if company_id is not None and not isinstance(company_id, str):
            raise CompanyScopeError(
                f"{label}: unverifiable company scope (non-string id {company_id!r})",
                target_company=company_id,
            )
        raise CompanyScopeError(
            f"{label}: company {company_id!r} is outside the actor's scope "
            f"(allowed: {sorted(scope.allowed_company_ids)})",
            target_company=company_id,
        )


def _require_resolved_company(company: Any, *, label: str, kind: str) -> None:
    """A PERSISTED entity must carry a concrete (non-empty str) company.

    Unlike a command's input ``company_profile_id`` — where an absent/blank value
    legitimately means "the actor's home company" (:func:`_normalize_home`) — a
    resolved entity with a ``None`` / ``""`` / non-str company is corrupt and
    unverifiable. Treating it as "home" would let two dirty entities (both blank)
    pass :func:`_assert_same_origin` as if same-origin. Fail closed instead.
    """
    if not isinstance(company, str) or not company:
        raise CompanyScopeError(
            f"{label}: resolved {kind} has an unverifiable company id "
            f"{company!r} (corrupt/blank — fail-closed)",
            target_company=company,
        )


def _resolve_agent_company(
    profile_id: Any, scope: CompanyScope, store: "StateStore | None", *, label: str
) -> Any:
    """Resolve an agent's company, assert it is in scope, and RETURN it.

    ``store is None`` → forbidden (cannot prove same-origin). An unknown profile
    → forbidden. The resolved company is checked via :func:`_check`, then
    returned so the caller can also enforce same-origin across refs.
    """
    if store is None:
        raise CompanyScopeError(
            f"{label}: cannot resolve agent {profile_id!r} without state "
            "(fail-closed)",
            target_company=None,
        )
    try:
        profile = store.get_agent_profile(profile_id)
    except KeyError:
        raise CompanyScopeError(
            f"{label}: unknown agent {profile_id!r} (fail-closed)",
            target_company=None,
        ) from None
    company = getattr(profile, "company_profile_id", None)
    _require_resolved_company(company, label=label, kind="agent")
    _check(company, scope, label=label)
    return company


def _resolve_issue_company(
    issue_id: Any, scope: CompanyScope, store: "StateStore | None", *, label: str
) -> Any:
    """Resolve an issue's company, assert it is in scope, and RETURN it."""
    if store is None:
        raise CompanyScopeError(
            f"{label}: cannot resolve issue {issue_id!r} without state "
            "(fail-closed)",
            target_company=None,
        )
    try:
        issue = store.get_issue(issue_id)
    except KeyError:
        raise CompanyScopeError(
            f"{label}: unknown issue {issue_id!r} (fail-closed)",
            target_company=None,
        ) from None
    company = getattr(issue, "company_profile_id", None)
    _require_resolved_company(company, label=label, kind="issue")
    _check(company, scope, label=label)
    return company


def _resolve_workproduct_company(
    work_product_id: Any, scope: CompanyScope, store: "StateStore | None", *, label: str
) -> Any:
    """Resolve a work product's company, assert it is in scope, and RETURN it.

    A work product carries its company directly (set from its issue at attach time),
    so the company is read off the persisted record — no issue hop needed. ``store
    is None`` / unknown id → forbidden (fail-closed)."""
    if store is None:
        raise CompanyScopeError(
            f"{label}: cannot resolve work product {work_product_id!r} without state "
            "(fail-closed)",
            target_company=None,
        )
    try:
        wp = store.get_work_product(work_product_id)
    except KeyError:
        raise CompanyScopeError(
            f"{label}: unknown work product {work_product_id!r} (fail-closed)",
            target_company=None,
        ) from None
    company = getattr(wp, "company_profile_id", None)
    _require_resolved_company(company, label=label, kind="work_product")
    _check(company, scope, label=label)
    return company


def _resolve_workspace_company(
    workspace_id: Any, scope: CompanyScope, store: "StateStore | None", *, label: str
) -> Any:
    """Resolve a workspace's company, assert it is in scope, and RETURN it."""
    if store is None:
        raise CompanyScopeError(
            f"{label}: cannot resolve workspace {workspace_id!r} without state "
            "(fail-closed)",
            target_company=None,
        )
    try:
        workspace = store.get_workspace_profile(workspace_id)
    except KeyError:
        raise CompanyScopeError(
            f"{label}: unknown workspace {workspace_id!r} (fail-closed)",
            target_company=None,
        ) from None
    company = getattr(workspace, "company_profile_id", None)
    _require_resolved_company(company, label=label, kind="workspace")
    _check(company, scope, label=label)
    return company


def _resolve_interaction_company(
    interaction_id: Any, scope: CompanyScope, store: "StateStore | None", *, label: str
) -> Any:
    """Resolve a board-inbox interaction's company, assert in scope, and RETURN it.

    The authoritative company is the escalation's ISSUE's company (resolved via the
    store), NOT the interaction's denormalised ``company_profile_id`` copy — so the
    boundary check tracks the entity that actually gets mutated/assigned. ``store is
    None`` / unknown interaction → forbidden (fail-closed)."""
    if store is None:
        raise CompanyScopeError(
            f"{label}: cannot resolve interaction {interaction_id!r} without state "
            "(fail-closed)",
            target_company=None,
        )
    try:
        interaction = store.get_issue_interaction(interaction_id)
    except KeyError:
        raise CompanyScopeError(
            f"{label}: unknown board inbox item {interaction_id!r} (fail-closed)",
            target_company=None,
        ) from None
    # Resolve + scope-check via the ISSUE (which also _checks scope and returns its
    # company), so an interaction whose issue is in a foreign company is forbidden.
    return _resolve_issue_company(interaction.issue_id, scope, store, label=label)


def _normalize_home(company: Any, actor_company_id: str) -> Any:
    """A blank/absent company means the actor's home company (server-scoped)."""
    if company is None or company == "":
        return actor_company_id
    return company


def _assert_same_origin(
    anchor: Any, anchor_label: str, others: list[tuple[str, Any]]
) -> None:
    """Contract B8 same-origin: every related ref must share the anchor's company.

    "In scope" is NOT enough: under an admin / multi-company allow-set, two refs
    can each be individually permitted yet belong to DIFFERENT companies (e.g.
    workspace in A + assignee in B). A cross-company relationship between the refs
    is itself a boundary crossing and is forbidden — work never spans companies.
    """
    for label, company in others:
        if company != anchor:
            raise CompanyScopeError(
                f"{label}: company {company!r} is not same-origin with "
                f"{anchor_label} ({anchor!r}) — related refs must share a company",
                target_company=company,
            )


def assert_command_in_scope(
    command: Any, scope: CompanyScope, store: "StateStore | None" = None
) -> None:
    """Hard门: every company a command touches MUST be inside ``scope``.

    Resolves the target company of the command AND every nested ref it carries
    (contract B8: "scope 校验覆盖嵌套 ref ... 不只顶层"). Any target outside the
    actor's scope — or any target that cannot be resolved (missing store, missing
    entity, non-string id) — raises :class:`CompanyScopeError` (forbidden). On
    success returns ``None``.

    Per-command target resolution:

      * ``CompanyCreateCommand`` — no existing-company target (the server injects
        the actor as owner; ``owner_id`` is a principal, not a company, and owner
        attribution is governed by the risk gate / handler). A bare namespace
        create can never cross a company boundary → always permitted here.
      * ``CompanyUpdateCommand`` / ``CompanyArchiveCommand`` — target is
        ``command.company_profile_id`` (top-level, no store needed).
      * ``UpdateAgentCommand`` — resolve the agent's company via the store, AND
        the patch's ``reports_to`` manager (the only entity-naming editable field).
      * ``HireAgentCommand`` also resolves the spec's ``workspace_id`` and
        ``reports_to`` nested refs (both permitted by _HIRE_SPEC_FIELDS).
      * ``HireAgentCommand`` — target is ``spec["company_profile_id"]`` (absent →
        the actor's home company); plus any ``spec["workspace_id"]`` nested ref.
      * ``CreateIssueCommand`` — if ``workspace_id`` is set, resolve the
        workspace's company via the store; if an assignee is pre-bound, resolve
        its company too; absent both → the actor's home company.
      * ``AssignIssueCommand`` — resolve BOTH the issue's company and the
        assignee agent's company; BOTH must be in scope (nested-ref same-origin).
      * ``DelegateIssueCommand`` — resolve BOTH the parent issue's company and
        the assignee agent's company; BOTH must be in scope.
      * Anything else → forbidden (default-deny).
    """
    if isinstance(command, CompanyCreateCommand):
        # No existing-company target — a create cannot cross a boundary.
        return

    if isinstance(command, AuthorRoutineCommand):
        # The routine's company AND its nested refs (workspace + agent) must all be
        # in scope AND same-origin — a routine declaring company A but pinning a
        # workspace/agent in company B is a cross-boundary write, forbidden here (403)
        # rather than deferred to the authoring helper's 400 (contract B8 nested-ref).
        from superclaw.company_commands import routine_spec_refs

        refs = routine_spec_refs(command.spec)
        company = refs["company_profile_id"]
        _check(company, scope, label=command.command_type)
        anchor = _normalize_home(company, scope.actor_company_id)
        others: list[tuple[str, Any]] = []
        if refs["workspace_id"]:
            others.append(
                (
                    f"{command.command_type}.workspace",
                    _resolve_workspace_company(
                        refs["workspace_id"], scope, store, label=f"{command.command_type}.workspace"
                    ),
                )
            )
        if refs["agent_profile_id"]:
            others.append(
                (
                    f"{command.command_type}.agent",
                    _resolve_agent_company(
                        refs["agent_profile_id"], scope, store, label=f"{command.command_type}.agent"
                    ),
                )
            )
        _assert_same_origin(anchor, f"{command.command_type}.company", others)
        return

    if isinstance(command, (CompanyUpdateCommand, CompanyArchiveCommand)):
        _check(command.company_profile_id, scope, label=command.command_type)
        return

    if isinstance(command, HireAgentCommand):
        # Dirty-data fail-closed: a non-dict spec is unverifiable, so this hard
        # gate refuses it itself rather than coercing it to {} (which would let a
        # malformed hire through to the actor's home company).
        if not isinstance(command.spec, dict):
            raise CompanyScopeError(
                f"{command.command_type}: malformed spec (not a mapping)",
                target_company=None,
            )
        spec = command.spec
        _check(spec.get("company_profile_id"), scope, label=command.command_type)
        # The new role's company anchors same-origin (absent → actor home).
        anchor = _normalize_home(spec.get("company_profile_id"), scope.actor_company_id)
        others: list[tuple[str, Any]] = []
        # Nested ref: a hire pinning a FOREIGN workspace must be forbidden here
        # (403), not deferred to the downstream save's ValueError.
        ws_id = spec.get("workspace_id")
        if ws_id is not None:
            ws_company = _resolve_workspace_company(
                ws_id, scope, store, label=f"{command.command_type}.workspace"
            )
            others.append((f"{command.command_type}.workspace", ws_company))
        # Nested ref: _HIRE_SPEC_FIELDS permits ``reports_to``, so a hire can pin
        # a FOREIGN manager and smuggle a cross-company reporting line in.
        manager_id = spec.get("reports_to")
        if manager_id:
            mgr_company = _resolve_agent_company(
                manager_id, scope, store, label=f"{command.command_type}.reports_to"
            )
            others.append((f"{command.command_type}.reports_to", mgr_company))
        # Same-origin: workspace + manager must share the new role's company, even
        # when each is individually in an admin / multi-company allow-set.
        _assert_same_origin(anchor, f"{command.command_type}.company", others)
        return

    if isinstance(command, UpdateWorkProductCommand):
        # Work-product-anchored: the only company target is the work product's own
        # (read directly off the persisted record). No nested ref.
        _resolve_workproduct_company(
            command.work_product_id, scope, store, label=command.command_type
        )
        return

    if isinstance(command, UpdateAgentCharterCommand):
        # Charter/persona edit: the only target is the agent's own company (resolved
        # via the store and checked against scope). No nested entity ref (charter /
        # persona are free text), so there is no same-origin check to make.
        _resolve_agent_company(
            command.profile_id, scope, store, label=command.command_type
        )
        return

    if isinstance(command, UpdateAgentCommand):
        # Dirty-data fail-closed: a non-dict patch is unverifiable, refuse it here.
        if not isinstance(command.patch, dict):
            raise CompanyScopeError(
                f"{command.command_type}: malformed patch (not a mapping)",
                target_company=None,
            )
        agent_company = _resolve_agent_company(
            command.profile_id, scope, store, label=command.command_type
        )
        # Nested ref carried IN the patch must be same-origin too — re-pointing an
        # in-scope agent's manager at a foreign company is a cross-boundary
        # mutation. ``reports_to`` is the ONLY entity-naming field in
        # EDITABLE_PROFILE_FIELDS (verified team_kernel.py:216 — workspace_id is
        # NOT editable; the rest are scalars / allowlists).
        manager_id = command.patch.get("reports_to")
        if manager_id:  # non-None and non-empty (empty/None clears the manager)
            mgr_company = _resolve_agent_company(
                manager_id, scope, store, label=f"{command.command_type}.reports_to"
            )
            # The new manager must be in the SAME company as the agent being
            # edited, not merely somewhere in the actor's allow-set.
            _assert_same_origin(
                agent_company,
                command.command_type,
                [(f"{command.command_type}.reports_to", mgr_company)],
            )
        return

    if isinstance(command, CreateIssueCommand):
        # The issue's company anchors same-origin: the workspace's company if a
        # workspace is named, else the actor's home company.
        anchor = scope.actor_company_id
        if command.workspace_id is not None:
            anchor = _resolve_workspace_company(
                command.workspace_id, scope, store, label=command.command_type
            )
        # A pre-bound assignee is a nested ref: a foreign-company assignee at
        # create time must be forbidden here, not merely flagged HIGH (an operator
        # could be social-engineered into Approving the ask). save_issue() does
        # NOT validate assignee company, so this gate is the only check.
        if command.assignee_agent_profile_id is not None:
            assignee_company = _resolve_agent_company(
                command.assignee_agent_profile_id,
                scope,
                store,
                label=f"{command.command_type}.assignee",
            )
            _assert_same_origin(
                _normalize_home(anchor, scope.actor_company_id),
                f"{command.command_type}.workspace",
                [(f"{command.command_type}.assignee", assignee_company)],
            )
        return

    if isinstance(command, AssignIssueCommand):
        # Nested-ref same-origin: the issue and the assignee must share a company.
        issue_company = _resolve_issue_company(
            command.issue_id, scope, store, label=f"{command.command_type}.issue"
        )
        assignee_company = _resolve_agent_company(
            command.profile_id, scope, store, label=f"{command.command_type}.assignee"
        )
        _assert_same_origin(
            issue_company,
            f"{command.command_type}.issue",
            [(f"{command.command_type}.assignee", assignee_company)],
        )
        return

    if isinstance(command, DelegateIssueCommand):
        parent_company = _resolve_issue_company(
            command.parent_id, scope, store, label=f"{command.command_type}.parent"
        )
        assignee_company = _resolve_agent_company(
            command.assignee_agent_profile_id,
            scope,
            store,
            label=f"{command.command_type}.assignee",
        )
        _assert_same_origin(
            parent_company,
            f"{command.command_type}.parent",
            [(f"{command.command_type}.assignee", assignee_company)],
        )
        return

    if isinstance(
        command,
        (PostIssueCommentCommand, AttachWorkProductCommand, SubmitReviewCommand)
        + _ISSUE_ANCHORED_LIFECYCLE,
    ):
        # Issue-anchored mutations: the only company target is the issue's own
        # company, resolved via the store and checked against scope. There are no
        # other entity refs to keep same-origin (the body carries scalars, not
        # cross-entity ids). The P2 lifecycle commands (block/unblock/hold/unhold)
        # are the same shape — a single ``issue_id`` whose company is authoritative.
        _resolve_issue_company(
            command.issue_id, scope, store, label=command.command_type
        )
        return

    if isinstance(command, ResolveBoardInboxCommand):
        # Interaction-anchored: the only target is the escalation's issue's company.
        _resolve_interaction_company(
            command.interaction_id, scope, store, label=command.command_type
        )
        return

    if isinstance(command, AssignBoardInboxCommand):
        # Nested-ref same-origin: the escalation's issue and the assignee must share
        # a company (mirrors AssignIssueCommand, with the issue reached via the item).
        issue_company = _resolve_interaction_company(
            command.interaction_id, scope, store, label=f"{command.command_type}.issue"
        )
        assignee_company = _resolve_agent_company(
            command.profile_id, scope, store, label=f"{command.command_type}.assignee"
        )
        _assert_same_origin(
            issue_company,
            f"{command.command_type}.issue",
            [(f"{command.command_type}.assignee", assignee_company)],
        )
        return

    # Default-deny: an unrecognised command can never be proven in-scope.
    raise CompanyScopeError(
        f"unrecognized command: {type(command).__name__!r} (default-deny)",
        target_company=None,
    )
