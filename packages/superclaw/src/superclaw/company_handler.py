"""Unified handler for chat-driven company-management commands.

This is the SINGLE execution entry point the future tool projection (PR-F) will
call to turn a typed :mod:`superclaw.company_commands` model into a kernel
mutation. It wires together the four PR-A foundation primitives in a fixed,
fail-closed order:

  1. ``command.validate()`` — stateless single-source business validation (A.2).
  2. ``company_scope.assert_command_in_scope`` — the hard, *forbidden* boundary:
     a target outside the actor's scope raises ``CompanyScopeError`` (403), never
     reaches the ask path (A.4 / contract B8).
  3. ``company_lifecycle.assert_company_active`` — a frozen/dissolved company can
     never host new work, on EVERY command that targets an existing company
     (contract B5).
  4. ``company_risk.classify_company_action`` — LOW (run straight through) vs.
     HIGH (pause for human approval) (A.3 / contracts B1/B2).

Then it BRANCHES on the risk tier:

  * LOW  → dispatch directly to the matching kernel function (see ``_dispatch``).
  * HIGH → record a PENDING :class:`~superclaw.models.Approval` whose
    ``resume_action`` carries the serialized command, and return
    ``pending_approval``. The existing human-gate (``team_kernel.decide_approval``)
    is what later applies it — see :func:`team_kernel._apply_agent_approval`'s
    ``company.command`` branch, which re-runs steps 2+3 (TOCTOU re-check) before
    dispatching.

SCOPE (business decision, owner 2026-06-22; see contract裁决 in
docs/company-chat-management-design.md §"实现范围裁决"): high-risk company
approvals REUSE the existing Approval system (``models.Approval`` +
``team_kernel.decide_approval``). NO new ledger, NO new state machine, NO change
to escalation. This handler is the LOW→direct / HIGH→ask switch that裁决 calls
"由 company 命令 handler 承接".

WIRED to chat (PR-F): the tool projection exposes the ``company_*`` mutation tools
to every runtime — B-class in-loop via ``WorkerLimits.company_command_resolver``
(``orchestrator._build_company_command_resolver``) and A-class via the team MCP
proxy (``team_mcp_proxy._execute``) — and the CLI / REST call this same entry. The
read half (``company_read.execute_company_read``) is its read-only sibling.

See docs/company-chat-management-design.md (contracts B1/B2/B5/B8 + the范围裁决).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from superclaw.company_autonomy import assert_autonomy_allowed
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
    get_command_model,
)
from superclaw.company_lifecycle import assert_company_active
from superclaw.company_risk import RiskVerdict, classify_company_action
from superclaw.company_scope import CompanyScope, assert_command_in_scope
from superclaw.models import Approval, ApprovalType, CompanyProfile, Issue
from superclaw.state import StateStore

# P2 issue-lifecycle commands — issue-anchored (target = the issue's own company),
# all carrying a single ``issue_id``. Grouped so the lifecycle gate + dispatcher
# enumerate them in one place (mirrors company_scope._ISSUE_ANCHORED_LIFECYCLE).
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

# Stable kernel tag stored in an approval's resume_action so a granted
# company-command approval routes back through this handler's dispatcher rather
# than the agent-hire/config-change branches. Mirrors the existing
# "agent.hire" / "agent.update_profile" / "team.bootstrap.commit" convention.
RESUME_KERNEL = "company.command"

Outcome = Literal["executed", "pending_approval"]


@dataclass(frozen=True)
class CompanyCommandResult:
    """The result of running a company-management command through the handler.

    ``outcome`` (under the re-ratified threat model, design §1 — user-triggered
    operations run directly; only irreversible ones pause for confirmation):
      * ``"executed"`` — a LOW-tier command that ran straight through. ``detail``
        carries the created/affected object id(s). A hire is LOW: the handler
        creates the agent directly via ``team_kernel.create_agent_from_spec``
        (``detail = {"created": "agent", "profile_id": ...}``) — NO approval, the
        role exists immediately. (The separate ``request_hire`` approval flow,
        for an *agent* requesting a hire, is unchanged and unrelated.)
      * ``"pending_approval"`` — a HIGH-tier (irreversible/destructive, i.e.
        archive) command the handler converted into a PENDING approval for a
        lightweight human "are you sure?" confirmation. ``detail`` carries
        ``{"approval_id": ...}``.

    ``verdict`` is the risk classification that drove the branch (kept so a
    surface/audit log can render WHY a command paused or ran).

    ``detail`` is a small dict of result identifiers — never the command's full
    payload (that lives in the approval's ``resume_action`` for the HIGH path).
    """

    outcome: Outcome
    verdict: RiskVerdict
    detail: dict[str, Any] = field(default_factory=dict)


def execute_company_command(
    command: Any,
    *,
    scope: CompanyScope,
    store: StateStore,
    requested_by: str,
    equipment_resolver: Callable[..., Any] | None = None,
) -> CompanyCommandResult:
    """Validate, scope-check, lifecycle-check, classify, then dispatch ``command``.

    The order is FIXED and fail-closed — any step raising aborts the whole
    operation, and no mutation happens until the dispatch step:

      (a) ``command.validate()`` — stateless business validation.
      (b) ``assert_command_in_scope`` — cross-company target → ``CompanyScopeError``
          (a hard *forbidden*, raised BEFORE risk so a forbidden target never
          reaches the ask path; contract B8).
      (c) company-active gate — for a command targeting an EXISTING company, load
          it and assert ACTIVE; a frozen/dissolved company raises
          ``CompanyFrozenError`` (contract B5). ``CompanyCreateCommand`` has no
          existing target and skips this.
      (d) ``classify_company_action`` — LOW vs HIGH (contracts B1/B2).
      (e) branch: LOW → dispatch directly (``outcome="executed"``); HIGH → record
          a PENDING approval (``outcome="pending_approval"``).

    Parameters mirror the foundation primitives' seams: ``scope`` is the
    server-injected actor authority (NEVER read from the command body — contract
    B8), ``requested_by`` is the acting principal recorded on any approval, and
    ``equipment_resolver`` is the test/inject seam threaded into the risk gate.

    Wired to chat (B-class in-loop + A-class MCP proxy) and the CLI / REST; see the
    module docstring.
    """
    # (a) Stateless validation — single source of truth (contract B6/B7).
    command.validate()

    # (b) Hard scope门 BEFORE risk: a cross-company target is forbidden (403),
    # never an ask. Raises CompanyScopeError.
    assert_command_in_scope(command, scope, store)

    # (c) Lifecycle门: any command targeting an EXISTING company must find it
    # ACTIVE. CompanyCreate has no existing target → skip. Raises
    # CompanyFrozenError for a frozen/dissolved target.
    _assert_targets_active(command, scope=scope, store=store)

    # (c2) Autonomy门 (柱子 1b): an AUTONOMOUS agent (is_admin=False with a bound
    # agent profile) is confined — no root issue_create, assign/delegate only
    # inside its reports-to subtree, fan-out budget-gated up front. No-op for the
    # operator. Runs AFTER scope+lifecycle (the refs are proven in-scope/active)
    # and BEFORE risk so a confined breach is a hard forbidden, never an ask.
    # Raises AutonomyGateError (a CompanyScopeError → mapped to forbidden).
    assert_autonomy_allowed(command, scope, store)

    # (d) Risk classification (contracts B1/B2). ``actor_is_operator`` carries the
    # kernel-derived authority (scope.is_admin): an autonomous agent (is_admin=
    # False) hiring is routed to a human approval, never a direct create.
    verdict = classify_company_action(
        command,
        actor_company_id=scope.actor_company_id,
        actor_is_operator=scope.is_admin,
        store=store,
        equipment_resolver=equipment_resolver,
    )

    # (e) Branch on the tier.
    if verdict.is_high:
        approval = _create_company_approval(
            command, scope=scope, requested_by=requested_by, store=store
        )
        return CompanyCommandResult(
            outcome="pending_approval",
            verdict=verdict,
            detail={"approval_id": approval.approval_id},
        )

    # LOW → direct execution through the single dispatcher (also reused by the
    # grant-time path so there is exactly ONE execution point per command).
    detail = _dispatch(command, scope=scope, store=store, requested_by=requested_by)
    return CompanyCommandResult(outcome="executed", verdict=verdict, detail=detail)


def _assert_targets_active(
    command: Any, *, scope: CompanyScope, store: StateStore
) -> None:
    """Contract B5: EVERY company a command actually touches must be ACTIVE.

    Resolves the REAL company of each entity the command targets — by looking the
    entity up in the store, NOT by assuming the actor's home company. This matters
    under an admin / multi-company scope: an actor whose HOME company A is active
    could otherwise assign/delegate/update against an entity in a FROZEN company B
    and slip past a home-only check (a contract-B5 bypass). We check the
    *resolved* company of the issue / agent / workspace each command names, so a
    frozen B blocks the operation even when A is active.

    ``CompanyCreateCommand`` has no existing company target and is skipped.

    Fail-closed: an unresolvable target (unknown company / unknown entity)
    propagates the underlying ``KeyError`` rather than being treated as active.
    """
    for company_id in _resolved_target_company_ids(command, scope=scope, store=store):
        company = store.get_company_profile(company_id)  # KeyError -> unknown
        assert_company_active(company)


def _resolved_target_company_ids(
    command: Any, *, scope: CompanyScope, store: StateStore
) -> set[str]:
    """The set of REAL company ids a command touches (resolved via the store).

    ``CompanyCreateCommand`` → empty (no existing company). For every other
    command, each named entity is looked up and its persisted
    ``company_profile_id`` collected, so the lifecycle gate checks the entity's
    actual company — never an assumed home company. Implicit, no-entity targets
    (a hire/issue with no workspace) fall back to the actor's home company, which
    IS the company that will host the new work.

    Entity lookups propagate ``KeyError`` for an unknown id (fail-closed): the
    scope gate runs first and already forbids out-of-scope refs, so a surviving
    unknown id here is a corrupt/missing entity, not a benign one.
    """
    if isinstance(command, CompanyCreateCommand):
        return set()

    if isinstance(command, (CompanyUpdateCommand, CompanyArchiveCommand)):
        return {command.company_profile_id}

    if isinstance(command, AuthorRoutineCommand):
        # EVERY company the routine touches must be active (B5): its own company AND
        # the companies of its nested workspace / agent refs (resolved via the store).
        from superclaw.company_commands import routine_spec_refs

        refs = routine_spec_refs(command.spec)
        targets = {refs["company_profile_id"]}
        if refs["workspace_id"]:
            targets.add(store.get_workspace_profile(refs["workspace_id"]).company_profile_id)
        if refs["agent_profile_id"]:
            targets.add(store.get_agent_profile(refs["agent_profile_id"]).company_profile_id)
        return targets

    if isinstance(command, HireAgentCommand):
        spec = command.spec if isinstance(command.spec, dict) else {}
        targets: set[str] = set()
        spec_company = spec.get("company_profile_id")
        targets.add(spec_company if isinstance(spec_company, str) and spec_company
                    else scope.actor_company_id)
        ws_id = spec.get("workspace_id")
        if ws_id:
            targets.add(store.get_workspace_profile(ws_id).company_profile_id)
        return targets

    if isinstance(command, CreateIssueCommand):
        targets = set()
        if command.workspace_id is not None:
            targets.add(
                store.get_workspace_profile(command.workspace_id).company_profile_id
            )
        else:
            targets.add(scope.actor_company_id)
        if command.assignee_agent_profile_id is not None:
            targets.add(
                store.get_agent_profile(
                    command.assignee_agent_profile_id
                ).company_profile_id
            )
        return targets

    if isinstance(command, AssignIssueCommand):
        return {
            store.get_issue(command.issue_id).company_profile_id,
            store.get_agent_profile(command.profile_id).company_profile_id,
        }

    if isinstance(command, ResolveBoardInboxCommand):
        # The board item's issue's company (authoritative, via the interaction).
        interaction = store.get_issue_interaction(command.interaction_id)
        return {store.get_issue(interaction.issue_id).company_profile_id}

    if isinstance(command, AssignBoardInboxCommand):
        interaction = store.get_issue_interaction(command.interaction_id)
        return {
            store.get_issue(interaction.issue_id).company_profile_id,
            store.get_agent_profile(command.profile_id).company_profile_id,
        }

    if isinstance(command, DelegateIssueCommand):
        return {
            store.get_issue(command.parent_id).company_profile_id,
            store.get_agent_profile(
                command.assignee_agent_profile_id
            ).company_profile_id,
        }

    if isinstance(command, (UpdateAgentCommand, UpdateAgentCharterCommand)):
        return {store.get_agent_profile(command.profile_id).company_profile_id}

    if isinstance(command, UpdateWorkProductCommand):
        # Work-product-anchored: the authoritative company is the work product's own.
        return {store.get_work_product(command.work_product_id).company_profile_id}

    if isinstance(
        command,
        (PostIssueCommentCommand, AttachWorkProductCommand, SubmitReviewCommand)
        + _ISSUE_ANCHORED_LIFECYCLE,
    ):
        # Issue-anchored mutations: the authoritative company is the issue's own
        # (the kernel surfaces — post_issue_comment / attach_work_product /
        # submit_for_review and the P2 lifecycle ops block/unblock/hold/unhold — all
        # take their company from the ISSUE, never the caller), so the lifecycle gate
        # must check that same company.
        return {store.get_issue(command.issue_id).company_profile_id}

    # Default-deny: an unrecognised command cannot be proven to target an active
    # company. (The scope gate already forbids it; this is defence in depth.)
    raise ValueError(
        f"cannot resolve target company for command: {type(command).__name__!r}"
    )


# --- dispatch: the single execution point per command ----------------------


def _dispatch(
    command: Any,
    *,
    scope: CompanyScope,
    store: StateStore,
    requested_by: str,
    superseding_approval_id: str | None = None,
) -> dict[str, Any]:
    """Execute ``command`` against the kernel — the ONE place a command runs.

    Called by the LOW path of :func:`execute_company_command` AND by the
    grant-time path (``team_kernel._apply_agent_approval``'s ``company.command``
    branch) so there is a single execution point: a LOW command and a granted
    HIGH command run through exactly the same kernel calls. Returns a small
    ``detail`` dict of result identifiers.

    ``superseding_approval_id`` is set ONLY on the grant-time archive path: it is
    the approval being granted, passed through so the archive cascade can EXCLUDE
    it when superseding the company's other pending approvals (it must never
    cancel the approval whose grant is in flight — that would deadlock).

    Imports ``team_kernel`` LAZILY: ``team_kernel`` imports the risk gate (via
    ``resolve_equipment``), so importing it at module load would create a cycle
    with this handler's ``company_risk`` import.
    """
    from superclaw import team_kernel

    if isinstance(command, CompanyCreateCommand):
        # owner_id is SERVER-injected from the authenticated principal, never from
        # the command body (contract B8: the body carries targets, not authority).
        company = CompanyProfile(
            name=command.name,
            goal=command.goal or "",
            owner_id=scope.principal_id,
            default_budget_seconds=command.default_budget_seconds or 0,
            default_token_budget=command.default_token_budget or 0,
            allowed_plugins=list(command.allowed_plugins or []),
        )
        saved = store.save_company_profile(company)
        return {"created": "company", "company_profile_id": saved.company_profile_id}

    if isinstance(command, CompanyUpdateCommand):
        company = store.get_company_profile(command.company_profile_id)
        # Merge only the fields the patch actually set (None = leave unchanged).
        # A company update is a reversible, user-triggered operation -> LOW under
        # the re-ratified threat model (design §1), so it runs straight through
        # here, owner_id included (the scope gate has already proven the company
        # is in scope; only archive needs a human "are you sure?" confirmation).
        for fld in (
            "name",
            "goal",
            "owner_id",
            "default_budget_seconds",
            "default_token_budget",
            "allowed_plugins",
        ):
            value = getattr(command, fld)
            if value is not None:
                setattr(company, fld, value)
        saved = store.save_company_profile(company)
        return {"updated": "company", "company_profile_id": saved.company_profile_id}

    if isinstance(command, HireAgentCommand):
        # Reached only for an OPERATOR-triggered hire (LOW: is_admin=True) or at
        # GRANT time after a human approved an autonomous agent's hire proposal
        # (the risk gate routes an agent-initiated hire — is_admin=False — to a
        # PENDING approval; see company_risk.classify_company_action). Both flows
        # land here on the SINGLE kernel creation point, sharing one validation +
        # construction path.
        saved = team_kernel.create_agent_from_spec(
            store, dict(command.spec), requested_by=requested_by
        )
        return {"created": "agent", "profile_id": saved.profile_id}

    if isinstance(command, CreateIssueCommand):
        # The issue's company is the WORKSPACE's company when a workspace is
        # named (the scope gate's same-origin anchor), else the actor's home
        # company. Writing the home company unconditionally would create a
        # cross-origin issue (company A holding a workspace-B issue) that the
        # scope gate took pains to forbid; keep the issue same-origin with its
        # workspace.
        if command.workspace_id is not None:
            issue_company = store.get_workspace_profile(
                command.workspace_id
            ).company_profile_id
        else:
            issue_company = scope.actor_company_id
        issue = Issue(
            title=command.title,
            description=command.description or "",
            company_profile_id=issue_company,
            assignee_agent_profile_id=command.assignee_agent_profile_id,
            created_by=requested_by,
            owner_id=scope.principal_id,
            **_issue_kind_kwargs(command),
        )
        if command.workspace_id is not None:
            issue.workspace_id = command.workspace_id
        saved = store.save_issue(issue)
        return {"created": "issue", "issue_id": saved.issue_id}

    if isinstance(command, AssignIssueCommand):
        issue = team_kernel.assign_issue(store, command.issue_id, command.profile_id)
        return {
            "assigned": "issue",
            "issue_id": issue.issue_id,
            "profile_id": command.profile_id,
        }

    if isinstance(command, DelegateIssueCommand):
        child = team_kernel.delegate_sub_issue(
            store,
            command.parent_id,
            assignee_agent_profile_id=command.assignee_agent_profile_id,
            title=command.title,
            description=command.description or "",
            requested_by=requested_by,
            priority=command.priority or "medium",
            origin_run_id=command.origin_run_id,
        )
        return {
            "created": "delegated_issue",
            "issue_id": child.issue_id,
            "parent_id": command.parent_id,
        }

    if isinstance(command, UpdateAgentCommand):
        # Agent updates are reversible, user-triggered edits -> LOW (design §1),
        # so this runs straight through. Apply the patch directly through the
        # kernel's edit path (the same gate update_agent_profile uses).
        profile, _resolution = team_kernel.update_agent_profile(
            store, command.profile_id, patch=dict(command.patch)
        )
        return {"updated": "agent", "profile_id": profile.profile_id}

    if isinstance(command, UpdateAgentCharterCommand):
        # The charter is the revisioned behavior-contract path (distinct from the
        # scalar/allowlist patch above; persona stays a scalar field on agent.update).
        # Single kernel entry shared with the REST charter endpoint; reversible → LOW.
        profile = team_kernel.update_agent_charter(
            store, command.profile_id, charter=command.charter
        )
        return {"updated": "agent_charter", "profile_id": profile.profile_id}

    if isinstance(command, PostIssueCommentCommand):
        # Author identity is SERVER-injected from the acting scope (contract B8),
        # NEVER from the command body (the model has no author field). The branch
        # keys off WHO the actor is, fail-closed:
        #   * operator (is_admin) → authors as the user.
        #   * confined agent WITH a bound profile → authors as that agent.
        #   * confined agent with NO bound profile → REFUSED: an unidentified
        #     non-admin must NOT be able to post as "user" and impersonate the
        #     operator (it is not the operator). Issue-anchored commands from such
        #     a scope are already refused by the autonomy gate; this is the
        #     dispatch-level belt-and-suspenders so no path can forge a user author.
        if scope.is_admin:
            author_type, author_id = "user", scope.principal_id or "local_user"
        elif scope.actor_agent_profile_id is not None:
            author_type, author_id = "agent", scope.actor_agent_profile_id
        else:
            from superclaw.company_scope import CompanyScopeError

            raise CompanyScopeError(
                "issue.comment: a non-operator actor with no bound agent cannot "
                "author a comment (fail-closed; would otherwise impersonate the user)",
                target_company=scope.actor_company_id,
            )
        comment, _interactions = team_kernel.post_issue_comment(
            store,
            command.issue_id,
            body=command.body,
            author_type=author_type,
            author_id=author_id,
        )
        return {
            "created": "issue_comment",
            "issue_id": command.issue_id,
            "comment_id": comment.comment_id,
        }

    if isinstance(command, AttachWorkProductCommand):
        # The work product's company is taken from the ISSUE inside the kernel
        # (never the caller), so a delivery fact can never be filed under a foreign
        # company. type/status are validated against the closed enums at apply time.
        wp = team_kernel.attach_work_product(
            store,
            command.issue_id,
            type=command.type,
            title=command.title,
            url=command.url,
            provider=command.provider,
            external_id=command.external_id,
            status=command.status,
            summary=command.summary,
            is_primary=command.is_primary,
        )
        return {
            "attached": "work_product",
            "issue_id": command.issue_id,
            "work_product_id": wp.work_product_id,
        }

    if isinstance(command, UpdateWorkProductCommand):
        # Patch the work product's mutable fields (the kernel validates status against
        # the closed enum and rejects an empty update — single source). LOW.
        wp = team_kernel.update_work_product(
            store,
            command.work_product_id,
            status=command.status,
            title=command.title,
            url=command.url,
            summary=command.summary,
            is_primary=command.is_primary,
        )
        return {"updated": "work_product", "work_product_id": wp.work_product_id}

    if isinstance(command, (PauseIssueTreeCommand, ResumeIssueTreeCommand, CancelIssueTreeCommand)):
        # The tree primitives stop active runs through a ``run_canceller``. We build
        # it from the STORE (run_cancel.cancel_run_in_store is store-portable — flips
        # the run status so the live worker stops), so cancellation works from EVERY
        # surface (chat / A-class proxy subprocess / CLI / REST / grant-time apply),
        # not just where an in-process orchestrator exists. No runtime handle to thread.
        from superclaw.run_cancel import cancel_run_in_store

        def _canceller(rid: str) -> Any:
            return cancel_run_in_store(store, rid)

        if isinstance(command, PauseIssueTreeCommand):
            result = team_kernel.pause_issue_tree(
                store, command.issue_id, by=requested_by, reason=command.reason or "",
                run_canceller=_canceller,
            )
            return {"paused": "issue_tree", "issue_id": command.issue_id, "result": result}
        if isinstance(command, ResumeIssueTreeCommand):
            result = team_kernel.resume_issue_tree(store, command.issue_id, by=requested_by)
            return {"resumed": "issue_tree", "issue_id": command.issue_id, "result": result}
        # CancelIssueTreeCommand — HIGH path: reached only AFTER a human grant.
        result = team_kernel.cancel_issue_tree(
            store, command.issue_id, by=requested_by, reason=command.reason or "",
            run_canceller=_canceller,
        )
        # Fail-CLOSED on an incomplete irreversible cancel: cancel_issue_tree leaves
        # any issue whose run could NOT be stopped in ``frozen_in_place`` (the
        # canceller raised / the run resisted). For a HIGH "are you sure?" cancel we
        # must NOT let the grant be marked approved when the subtree was not fully
        # cancelled — raise so apply_company_command propagates and decide_approval
        # keeps the approval PENDING (re-decidable). A re-grant retries the still-
        # frozen issues (the already-cancelled ones are terminal and skipped).
        frozen = result.get("frozen_in_place") or []
        if frozen:
            raise ValueError(
                f"issue tree cancel incomplete: {len(frozen)} issue(s) could not be "
                f"stopped ({frozen}); the approval stays pending — retry once the "
                f"runs are stoppable"
            )
        return {"cancelled": "issue_tree", "issue_id": command.issue_id, "result": result}

    if isinstance(command, SubmitReviewCommand):
        # expected_checkout_run_id is REQUIRED (柱子 1b): the kernel binds the
        # in_review flip to the issue's live checkout run, so an agent that merely
        # knows an issue_id cannot submit work belonging to a different run's
        # checkout (a stale/foreign-run submit is refused inside submit_for_review).
        issue, approval = team_kernel.submit_for_review(
            store,
            command.issue_id,
            requested_by=requested_by,
            summary=command.summary,
            expected_checkout_run_id=command.expected_checkout_run_id,
        )
        return {
            "submitted": "issue",
            "issue_id": issue.issue_id,
            "status": issue.status,
            # no_completion_gate auto-completes without opening an approval → None.
            "approval_id": approval.approval_id if approval is not None else None,
        }

    # --- P2 issue lifecycle: dispatch to the existing kernel primitives ----------
    # ``by`` is the SERVER-injected acting principal (scope.principal_id via
    # requested_by), never a body field — the same authority every other command
    # records. Each returns a small detail dict of the affected issue id(s).
    if isinstance(command, BlockIssueCommand):
        issue = team_kernel.block_issue(
            store, command.issue_id, reason=command.reason, by=requested_by,
            unblock_owner=command.unblock_owner,
        )
        return {"blocked": "issue", "issue_id": issue.issue_id}

    if isinstance(command, UnblockIssueCommand):
        issue = team_kernel.unblock_issue(
            store, command.issue_id, by=requested_by, note=command.note or ""
        )
        return {"unblocked": "issue", "issue_id": issue.issue_id}

    if isinstance(command, HoldIssueCommand):
        hold = team_kernel.hold_issue(
            store, command.issue_id, reason=command.reason or "", by=requested_by
        )
        return {"held": "issue", "issue_id": command.issue_id, "hold_id": hold.hold_id}

    if isinstance(command, UnholdIssueCommand):
        hold = team_kernel.release_issue_hold(store, command.issue_id, by=requested_by)
        return {"unheld": "issue", "issue_id": command.issue_id, "hold_id": hold.hold_id}

    if isinstance(command, RequeueIssueCommand):
        # Recover a stuck issue. ``abort_checkout`` only releases the lock + resets to
        # todo — it does NOT stop a live run, so we CANCEL the issue's live run FIRST
        # (via the store-portable canceller) so a requeue never orphans a worker.
        # ``find_issue_live_run`` resolves the REAL run robustly — including the daemon
        # checkout window where the issue holds a wakeup_id token, not yet the anchored
        # run_id — so we never mistake a checkout token for a run id (and never miss a
        # live run because it is not yet anchored).
        from superclaw.run_cancel import cancel_run_in_store

        issue = store.get_issue(command.issue_id)
        live_run = team_kernel.find_issue_live_run(store, issue)
        if live_run:
            cancel_run_in_store(store, live_run)
        requeued = team_kernel.abort_checkout(store, command.issue_id)
        return {
            "requeued": "issue",
            "issue_id": requeued.issue_id,
            "cancelled_run": live_run,
        }

    if isinstance(command, ResolveBoardInboxCommand):
        # Resolve a human-escalation queue item (no issue change). Idempotent in the
        # kernel (already-resolved → returned unchanged).
        interaction = team_kernel.resolve_board_inbox_item(store, command.interaction_id)
        return {
            "action": "resolve",
            "status": interaction.status,
            "interaction_id": interaction.interaction_id,
            "issue_id": interaction.issue_id,
        }

    if isinstance(command, AssignBoardInboxCommand):
        # Assign the escalation's issue through the SAME assignment gate as
        # issue.assign (same-company + assignable-status enforced in assign_issue),
        # then resolve the item unless the caller kept it open.
        issue, interaction = team_kernel.assign_board_inbox_item(
            store, command.interaction_id, command.profile_id, resolve=command.resolve
        )
        return {
            "action": "assign",
            "resolved": interaction.status == "resolved",
            "issue_id": issue.issue_id,
            "assignee_agent_profile_id": issue.assignee_agent_profile_id,
            "interaction_id": interaction.interaction_id,
        }

    if isinstance(command, AuthorRoutineCommand):
        # Author + persist a recurring routine. The authoring helper validates the
        # spec against the known companies/workspaces/agents (and same-company refs);
        # we then persist ONLY a ``ready``/``disabled`` schedule. A spec the helper
        # marks ``requires_approval`` is REFUSED here (raised as a ValueError) and
        # directed to the dedicated routine-approval flow, so the company command gate
        # is never layered on top of the routine's own governance approval. An invalid
        # spec surfaces the helper's errors verbatim (fail-closed, no schedule written).
        from superclaw.team_routines import author_routine

        agents = store.list_agent_profiles()
        result = author_routine(
            dict(command.spec),
            known_companies=[c.company_profile_id for c in store.list_company_profiles()],
            known_workspaces=[w.workspace_id for w in store.list_workspace_profiles()],
            known_agents=[a.profile_id for a in agents],
            agent_company_map={a.profile_id: a.company_profile_id for a in agents},
            workspace_company_map={
                w.workspace_id: w.company_profile_id for w in store.list_workspace_profiles()
            },
        )
        if result.status == "invalid":
            raise ValueError(f"invalid routine spec: {result.errors}")
        if result.status == "requires_approval":
            raise ValueError(
                "this routine requires governance approval; author it through the "
                "dedicated routine-approval flow (not the chat command path)"
            )
        if result.proposal is None:
            raise ValueError("routine authoring produced no schedulable proposal")
        schedule, existing = store.save_team_routine_schedule(result.to_team_routine_schedule())
        return {
            "authored": "routine",
            "schedule_id": getattr(schedule, "schedule_id", None) or getattr(schedule, "routine_id", None),
            "created": not existing,
        }

    if isinstance(command, CompanyArchiveCommand):
        # Phase 2a of the two-phase archive (contract E): the request already
        # froze the company (see _create_company_approval); a human grant now
        # dissolves it + runs the cascade circuit-breaker. The grant-time
        # lifecycle gate is deliberately BYPASSED for the archive's OWN target —
        # the company is intentionally FROZEN by phase 1, and archive_company
        # asserts archivability (FROZEN) itself. ``superseding_approval_id`` is
        # the archive approval driving this grant; archive_company EXCLUDES it so
        # the cascade never cancels the very approval being granted (deadlock).
        result = team_kernel.archive_company(
            store,
            command.company_profile_id,
            requested_by=requested_by,
            reason=command.reason,
            excluded_approval_ids=(
                frozenset({superseding_approval_id})
                if superseding_approval_id
                else frozenset()
            ),
        )
        return {
            "archived": "company",
            "company_profile_id": result["archived"],
            "cascade": result,
        }

    # Default-deny: an unrecognised command can never be dispatched.
    raise ValueError(f"no dispatch for command: {type(command).__name__!r}")


def _issue_kind_kwargs(command: CreateIssueCommand) -> dict[str, Any]:
    """Pass kind/review_policy through ONLY when set, so the Issue defaults apply.

    ``validate()`` already proved any provided ``kind`` / ``review_policy`` is a
    member of the closed enum, so we never coerce here — an absent value just
    lets the :class:`~superclaw.models.Issue` dataclass default stand.
    """
    kwargs: dict[str, Any] = {}
    if command.kind is not None:
        kwargs["kind"] = command.kind
    if command.review_policy is not None:
        kwargs["review_policy"] = command.review_policy
    return kwargs


# --- HIGH path: record a PENDING approval ----------------------------------


def _create_company_approval(
    command: Any, *, scope: CompanyScope, requested_by: str, store: StateStore
) -> Approval:
    """Record a PENDING approval carrying the serialized command (HIGH path).

    Reuses the existing Approval system (owner裁决): no new ledger. The command
    is stored verbatim in ``resume_action`` (the same shape ``team_kernel``'s
    hire/config approvals use) so that — and ONLY that — exact command is what a
    human grant later applies. We also persist the actor scope so the grant-time
    path can rebuild the SAME scope to re-check (TOCTOU defence), rather than
    trusting a fresh, possibly wider scope at decision time.

    A new ``ApprovalType.COMPANY_COMMAND`` carries the semantics (closest
    existing types — AGENT_HIRE / AGENT_CONFIG_CHANGE — are agent-specific; a
    company create/update/archive is a different subject), but it rides the SAME
    state machine and the SAME ``decide_approval`` gate.
    """
    approval = Approval(
        type=ApprovalType.COMPANY_COMMAND.value,
        requested_by=requested_by,
        requested_permission={
            "action": "company.command",
            "command_type": command.command_type,
        },
        affects={
            "command": command.to_dict(),
            "command_type": command.command_type,
            # Attribute the approval to its company so list_approvals(company=...)
            # (used by the archive cascade to find siblings to supersede, and by
            # any company-scoped inbox) finds this issue-less approval.
            "company_profile_id": _command_company_id(command, scope, store),
        },
        resume_action={
            "kernel": RESUME_KERNEL,
            "command_type": command.command_type,
            "command": command.to_dict(),
            # Server-injected actor authority, persisted so the grant re-checks
            # against the ORIGINAL scope (not a fresh one) — see apply_company_command.
            "scope": _scope_to_dict(scope),
            "requested_by": requested_by,
        },
    )
    store.save_approval(approval)

    # Two-phase archive (contract E): freezing the company is PHASE 1. The moment
    # the pending "are you sure?" approval exists, the company stops hosting new
    # work (assert_company_active rejects FROZEN). A human grant later dissolves
    # it (phase 2a); a reject restores it to ACTIVE (phase 2b, in decide_approval).
    # Archive is the ONLY HIGH command, but we gate the freeze on the type rather
    # than assuming, so a future HIGH command does not silently freeze a company.
    # Freeze AFTER saving the approval so a freeze failure cannot orphan a frozen
    # company with no approval to drive it back.
    if isinstance(command, CompanyArchiveCommand):
        from superclaw.company_lifecycle import freeze_company_for_archive

        freeze_company_for_archive(store, command.company_profile_id)
    return approval


def _command_company_id(command: Any, scope: CompanyScope, store: StateStore) -> str:
    """The company a HIGH approval is attributed to (for company-scoped listing).

    A command that NAMES its company directly (archive/update) uses that. An
    ENTITY-anchored HIGH command (e.g. work_product.delete) must attribute to the
    entity's RESOLVED company — not the actor's home — so a cross-company admin's
    pending approval lands in the right ``list_approvals(company=...)`` inbox rather
    than the admin's home company. We reuse ``_resolved_target_company_ids`` (the
    same resolution the scope/lifecycle gates use). Only on an unresolvable target
    (which the scope gate has already forbidden upstream) do we fall back to the
    actor's home company.
    """
    company_id = getattr(command, "company_profile_id", None)
    if isinstance(company_id, str) and company_id:
        return company_id
    try:
        targets = _resolved_target_company_ids(command, scope=scope, store=store)
    except (KeyError, ValueError):
        targets = set()
    resolved = sorted(t for t in targets if isinstance(t, str) and t)
    return resolved[0] if resolved else scope.actor_company_id


def _scope_to_dict(scope: CompanyScope) -> dict[str, Any]:
    """Serialize a :class:`CompanyScope` for an approval's resume_action."""
    return {
        "principal_id": scope.principal_id,
        "actor_company_id": scope.actor_company_id,
        "allowed_company_ids": sorted(scope.allowed_company_ids),
        "is_admin": scope.is_admin,
        # The acting agent id is persisted so a granted approval rebuilds the SAME
        # confined scope (柱子 1b autonomy门) it was requested under — never a wider
        # one. None for an operator-initiated approval.
        "actor_agent_profile_id": scope.actor_agent_profile_id,
    }


def _scope_from_dict(data: dict[str, Any]) -> CompanyScope:
    """Rebuild a :class:`CompanyScope` from an approval's resume_action.

    Fail-closed on MALFORMED / MISSING values — each field degrades to its most
    restrictive interpretation rather than being coerced into something more
    permissive:

      * ``is_admin`` is True ONLY for the strict boolean ``True``. A truthy
        non-bool (``"false"``, ``"true"``, ``1`` — note ``bool("false") is True``)
        degrades to ``False``: a string can never become admin.
      * ``allowed_company_ids`` must be a list/tuple of non-empty ``str``; any
        other shape, or any non-str/blank element, is dropped, so a malformed
        allow-set degrades to "own company only" (via ``__post_init__``).
      * ``principal_id`` / ``actor_company_id`` that are not ``str`` become ``""``.

    This guards a malformed/incomplete STORED payload — it does NOT defend against
    an attacker who can rewrite an approval row at will (e.g. flip a well-formed
    ``"is_admin": true`` or inject extra company ids). Defeating row tampering
    requires binding the approval to an unforgeable digest / signature (PR-C's
    human-present signing); that cryptographic anti-forgery is out of scope here.
    """
    raw_allowed = data.get("allowed_company_ids")
    if isinstance(raw_allowed, (list, tuple)):
        allowed = frozenset(v for v in raw_allowed if isinstance(v, str) and v)
    else:
        allowed = frozenset()

    principal = data.get("principal_id")
    actor = data.get("actor_company_id")
    # A non-str/blank acting-agent id degrades to None (no identified agent), which
    # CompanyScope.__post_init__ also enforces — an unverifiable agent id can never
    # be matched against an org subtree (fail-closed).
    acting_agent = data.get("actor_agent_profile_id")
    return CompanyScope(
        principal_id=principal if isinstance(principal, str) else "",
        actor_company_id=actor if isinstance(actor, str) else "",
        allowed_company_ids=allowed,
        # Strict boolean identity — a string/int can never flip this to admin.
        is_admin=data.get("is_admin") is True,
        actor_agent_profile_id=acting_agent if (isinstance(acting_agent, str) and acting_agent) else None,
    )


def apply_company_command(
    store: StateStore,
    resume_action: dict[str, Any],
    *,
    approval_id: str | None = None,
) -> None:
    """Apply a granted company-command approval (the grant-time execution path).

    Invoked from ``team_kernel._apply_agent_approval`` when a granted approval's
    ``resume_action["kernel"] == RESUME_KERNEL``. Reconstructs the command from
    the registry (fail-closed: an unknown ``command_type`` raises) and the SAME
    actor scope the request was made under, then RE-RUNS the hard gates before
    dispatching:

      * ``assert_command_in_scope`` — the company may not have changed, but the
        re-check is cheap and closes any approval-tampering hole.
      * ``assert_company_active`` (via ``_assert_targets_active``) — TOCTOU
        defence: a company that was ACTIVE when the approval was created may have
        been FROZEN/dissolved between request and grant; applying the command now
        must refuse it (raises ``CompanyFrozenError``, leaving the approval
        re-decidable — the kernel's apply contract).

    The risk/approval BRANCH is deliberately skipped (the human grant IS the
    approval), but validation + scope + lifecycle are NOT — a grant authorizes
    *this exact command*, not a bypass of the boundary gates. Dispatch then runs
    through the SAME :func:`_dispatch` the LOW path uses (single execution point).

    Raises on any failure so ``decide_approval`` leaves the approval PENDING
    rather than recording a grant whose effect never landed.
    """
    command_type = resume_action.get("command_type")
    if not isinstance(command_type, str):
        raise ValueError("company-command approval missing command_type")
    model = get_command_model(command_type)  # KeyError -> unknown command_type
    raw = resume_action.get("command")
    if not isinstance(raw, dict):
        raise ValueError("company-command approval missing command payload")
    command = model.from_dict(raw)  # strict: rejects unknown fields

    scope = _scope_from_dict(resume_action.get("scope") or {})
    requested_by = str(resume_action.get("requested_by") or "")

    # Re-validate the reconstructed command (defence-in-depth: the stored payload
    # must still satisfy the same stateless contract).
    command.validate()
    # Re-run the hard scope gate at GRANT time — scope tampering defence (applies
    # to every command type; the company being in scope is unaffected by status).
    assert_command_in_scope(command, scope, store)
    # Re-run the lifecycle (company-active) gate as a TOCTOU defence — EXCEPT for
    # the archive command's own target. Two-phase archive deliberately FROZE that
    # company at request time, so an "active" re-check would refuse the very
    # archive it is supposed to apply; archive_company asserts FROZEN itself.
    if not isinstance(command, CompanyArchiveCommand):
        _assert_targets_active(command, scope=scope, store=store)
    # Re-run the autonomy门 at grant time too (柱子 1b): the persisted scope carries
    # the original actor (operator vs confined agent), so a granted command must
    # honour the SAME confinement it was requested under — a grant authorizes this
    # exact command, never an escalation past the autonomy boundary. Mirrors the
    # scope/lifecycle re-checks above (single choke point, no grant-time bypass).
    assert_autonomy_allowed(command, scope, store)

    _dispatch(
        command,
        scope=scope,
        store=store,
        requested_by=requested_by,
        superseding_approval_id=approval_id,
    )
