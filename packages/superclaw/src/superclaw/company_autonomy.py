"""Autonomy gates for AUTONOMOUS-agent company commands (柱子 1b).

A *human operator* driving their own single-user tool (``scope.is_admin=True``)
is trusted to do whatever they ask — the design §1 threat model treats their
actions as user-triggered. These gates do NOT apply to the operator.

ANY non-admin scope (``scope.is_admin=False``) is a confined actor here — a team
run acting on its own between human gates. The orchestrator binds such a run's
agent into ``scope.actor_agent_profile_id`` (server-injected, never self-reported).
Confinement is fail-closed: a non-admin scope that cannot identify its acting
agent can prove no ownership / management relationship, so every issue-anchored
command is REFUSED rather than waved through (we never key confinement off
"happens to carry an agent id" — that was a fail-open hole). The design (§3 柱子
1b / §6.1) confines a confined actor to:

  * **Root issue creation is reserved.** ``issue_create`` makes a NEW root
    runnable work item — a confined actor must break work down with
    ``issue_delegate`` (a child of an issue it already owns), so a root
    ``issue_create`` is REFUSED.
  * **Work routing stays inside the org subtree.** ``assign`` / ``delegate`` may
    only target the acting agent itself or an agent in its reports-to subtree.
  * **Issue-anchored writes stay on owned issues.** ``comment`` / ``attach`` /
    ``submit_review`` (and the parent of a ``delegate``) may only touch an issue
    the acting agent OWNS — its assignee is the acting agent or in its subtree.
    This is what makes "only the current issue/tree" real (design §6.1): without
    it, a confined actor could spam comments / file fake delivery facts / submit
    review on ANY issue in the company.
  * **submit_review is run-bound AND owner-bound.** A confined actor MUST supply
    a non-empty ``expected_checkout_run_id`` (so the kernel binds the flip to the
    issue's live checkout run) AND must be the issue's owner. The operator may
    omit the run id (a trusted force-submit) — the kernel treats ``None`` as "do
    not bind", which is only safe for the operator.
  * **Fan-out is budget-gated up front.** Before a confined actor creates
    runnable work (delegate), the relevant budget scope must still have room.

Consulted by the SINGLE choke point ``company_handler.execute_company_command``
(after the hard scope + lifecycle gates, before risk) AND re-run at grant time in
``apply_company_command``, so CLI / B-class in-loop / A-class MCP all inherit the
same confinement with zero divergence. A blocked gate raises
:class:`AutonomyGateError` (a :class:`~superclaw.company_scope.CompanyScopeError`
subclass), which the existing surfaces already map to a hard *forbidden*.

NOTE on the threat boundary (honest residual): ``expected_checkout_run_id`` binds
the submit to the live claim — it defeats stale/ABA re-checkout, but a ``run_id``
is an identifier, not an authorization secret. The OWNER-bound check here
(assignee ∈ acting subtree) is what stops a different agent that merely learned an
issue_id + run_id from submitting foreign work. Cryptographic actor binding (the
run-bound ticket whose audience is the acting agent) is PR-3/PR-4; until then the
owner check is the authorization line, the run id is the freshness line.

See docs/agent-company-autonomy-design.md §3 柱子 1b / §6.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from superclaw.company_commands import (
    AssignIssueCommand,
    AttachWorkProductCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    PostIssueCommentCommand,
    SubmitReviewCommand,
)
from superclaw.company_scope import CompanyScope, CompanyScopeError

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from superclaw.models import Issue
    from superclaw.state import StateStore


class AutonomyGateError(CompanyScopeError):
    """A confined actor attempted an action reserved from autonomy (柱子 1b).

    A :class:`CompanyScopeError` subclass so every surface that already maps a
    scope violation to a hard *forbidden* (the CLI ``_run_company_command``, the
    B-class in-loop resolver, the future A-class MCP proxy) treats an autonomy
    breach identically — there is no second error contract to thread through.
    Distinct *type* so an audit log / test can tell an autonomy refusal apart
    from a plain cross-company scope refusal.
    """


# How far up a reports_to chain we walk before giving up (cycle/corruption
# guard). Mirrors ``team_kernel._manager_chain``'s bound: a real org is shallow,
# and a longer-than-this chain is a data bug we fail closed on rather than loop.
_MAX_REPORTS_TO_WALK = 32


def is_confined_actor(scope: CompanyScope) -> bool:
    """True iff ``scope`` is a confined actor (anything that is NOT the operator).

    Confinement keys off ``is_admin`` ALONE (server-derived from the run's bound
    profile): the operator (``is_admin=True``) is trusted, everything else is
    confined — INCLUDING a non-admin scope that failed to bind an agent id. That
    unidentified actor is the fail-closed case: the gates below refuse its
    issue-anchored commands because it can prove no ownership, rather than letting
    a missing agent id silently disable confinement.
    """
    return not scope.is_admin


def is_autonomous_agent(scope: CompanyScope) -> bool:
    """True iff ``scope`` is a confined actor WITH an identified acting agent.

    A stricter predicate than :func:`is_confined_actor`: it additionally requires
    a server-injected ``actor_agent_profile_id`` (``__post_init__`` degraded a
    blank/non-str id to ``None``). Used where an action needs a concrete acting
    agent to attribute to (e.g. comment authorship). Confinement itself uses
    :func:`is_confined_actor` so a missing agent id fails closed, never open.
    """
    return (not scope.is_admin) and scope.actor_agent_profile_id is not None


# Commands a confined actor may PROPOSE but never execute directly: the risk gate
# (``company_risk.classify_company_action``, which runs AFTER this gate) routes
# them to a PENDING human approval. The autonomy gate lets them THROUGH so that
# "agent proposes, human grants" red line can run (design §3 柱子 1 / PR-1); the
# actual mutation only lands after a human grant (which re-runs every gate,
# including this one, via ``apply_company_command``).
#
# ONLY ``HireAgentCommand`` qualifies: its pending-approval phase records an
# approval and mutates NOTHING (no profile is created until grant). ``Company-
# ArchiveCommand`` is DELIBERATELY EXCLUDED — its phase-1 (the moment the pending
# approval is saved) FREEZES the company (``company_handler._create_company_approval``
# → ``freeze_company_for_archive``), so merely *proposing* an archive already
# stops the company hosting new work. Letting a confined agent propose archive
# would be a DoS that needs no human grant. Archive is operator-only; a confined
# agent's archive falls through to default-deny below.
_CONFINED_ESCALATES_TO_APPROVAL = (HireAgentCommand,)


def assert_autonomy_allowed(
    command: Any, scope: CompanyScope, store: "StateStore"
) -> None:
    """Confine a non-operator actor's command (柱子 1b). No-op for the operator.

    DEFAULT-DENY for a confined actor: a command is allowed ONLY if it matches an
    explicit branch below; anything not enumerated is REFUSED. This is the
    fail-closed posture — a newly added command type can never silently become an
    autonomous-agent capability just because the autonomy gate forgot to list it
    (the hole that let ``UpdateAgentCommand`` / ``CompanyUpdateCommand`` escalate).

    Runs AFTER the hard scope + lifecycle gates (refs proven in-scope/active),
    BEFORE risk, and is RE-RUN at grant time. The operator (``is_admin=True``) is
    unaffected. For a confined actor (any non-admin scope) the allowed set is:

      * ``AssignIssueCommand`` → the issue being reassigned must ALREADY be owned by
        the acting agent, AND the new assignee must be the acting agent or in its
        reports-to subtree. (Owner check first, so an agent cannot grab a foreign
        issue by assigning it to itself.)
      * ``DelegateIssueCommand`` → the PARENT issue must be owned by the acting
        agent, the assignee must be in its subtree, and fan-out budget must allow.
      * ``PostIssueCommentCommand`` / ``AttachWorkProductCommand`` /
        ``SubmitReviewCommand`` → the target issue must be owned by the acting
        agent (assignee ∈ acting subtree). ``SubmitReviewCommand`` additionally
        requires a non-empty ``expected_checkout_run_id``.
      * ``HireAgentCommand`` → passed THROUGH to the risk gate, which routes it to
        a human approval (the agent proposes, a human grants — design §3 柱子 1).
        It never executes directly here; its pending-approval phase mutates nothing.

    Everything else for a confined actor — root ``issue_create`` (always a root),
    ``company.create`` / ``company.update``, ``agent.update`` (the reports_to /
    permission / charter escalation vector), ``company.archive`` (whose phase-1
    freeze would let a mere proposal DoS the company), and any future command — is
    REFUSED: a configuration / governance / namespace / destructive mutation by an
    autonomous agent must go through a human, not a direct write or an agent-
    triggered freeze.

    Fail-closed: a confined actor with no bound agent (``actor_agent_profile_id is
    None``) can own nothing and manage nobody, so every owned/subtree-checked
    command is refused (the helpers raise on a missing acting agent).
    """
    if not is_confined_actor(scope):
        # The operator is trusted (design §1). Autonomy confinement does not apply.
        return

    if isinstance(command, AssignIssueCommand):
        # The agent may only REASSIGN an issue it ALREADY owns, and only TO an agent
        # in its subtree. Owner check FIRST — otherwise an agent could grab a
        # foreign issue by assigning it to itself (target==self passes the subtree
        # check), then "own" it for every downstream command (R2 finding).
        _assert_acting_agent_owns_issue(scope, store, command.issue_id, action="assign")
        _assert_target_in_subtree(
            scope, store, target_profile_id=command.profile_id, action="assign"
        )
        return

    if isinstance(command, DelegateIssueCommand):
        # The agent may only delegate UNDER an issue it owns, and only TO an agent
        # in its subtree. Owner check first (cheapest, most specific reason).
        _assert_acting_agent_owns_issue(scope, store, command.parent_id, action="delegate")
        _assert_target_in_subtree(
            scope,
            store,
            target_profile_id=command.assignee_agent_profile_id,
            action="delegate",
        )
        _assert_fanout_budget_ok(command, store)
        return

    if isinstance(command, PostIssueCommentCommand):
        # A comment is normally owner-gated, BUT a run-scoped respond grant (#2)
        # lets an @-mentioned / human-triggered respond run reply ONCE on a
        # non-owned thread. The grant is a single server-injected value (kernel
        # mint / scope build only — never from a command body), scoped to exactly
        # this one issue + comment + run. It applies ONLY when it EXACTLY equals
        # this command's issue id, so a grant for issue A can never authorize a
        # comment on issue B; anything else falls back to the ownership check.
        #
        # SINGLE-USE: the grant is CONSUMED atomically in the store keyed by
        # (run_id, issue_id). The FIRST non-owned comment in this run on this issue
        # spends the grant (consume → True); a SECOND comment in the same run on
        # the same issue gets consume → False and falls back to the ownership check
        # (refused) — enforcing the "reply once" semantics and capping the @mention
        # fan-out. ``run_id`` is required to consume (it keys the ledger row); a
        # scope with a respond grant but no run_id cannot consume and falls back to
        # ownership (fail-closed). This branch runs EXACTLY ONCE per real command
        # (PostIssueCommentCommand is LOW → never the grant-time re-run path), so
        # the grant is never burned without a comment actually being dispatched.
        respond_ok = False
        if (
            scope.respond_issue_id is not None
            and scope.respond_issue_id == command.issue_id
            and scope.run_id
        ):
            respond_ok = store.consume_respond_grant(scope.run_id, command.issue_id)
        if not respond_ok:
            _assert_acting_agent_owns_issue(
                scope, store, command.issue_id, action="comment"
            )
        return

    if isinstance(command, AttachWorkProductCommand):
        # Attaching a work product is NOT widened by the respond grant — it stays
        # owner-gated (the grant authorizes only the comment action).
        _assert_acting_agent_owns_issue(
            scope, store, command.issue_id, action="attach"
        )
        return

    if isinstance(command, SubmitReviewCommand):
        # A confined actor MUST run-bind its submit (the operator may force-submit
        # with no run id; the kernel treats None as "do not bind", only safe for a
        # trusted operator). Owner-bind too: only the issue's owner may submit it.
        if not (
            isinstance(command.expected_checkout_run_id, str)
            and command.expected_checkout_run_id
        ):
            raise AutonomyGateError(
                "submit_review by a confined agent requires a non-empty "
                "expected_checkout_run_id (bind the submit to this issue's live "
                "checkout run); only the operator may force-submit without one",
                target_company=scope.actor_company_id,
            )
        _assert_acting_agent_owns_issue(
            scope, store, command.issue_id, action="submit_review"
        )
        return

    if isinstance(command, _CONFINED_ESCALATES_TO_APPROVAL):
        # Let it through to the risk gate (hire → human approval). The profile is
        # only created after a human grant, which re-runs this gate. (Archive is
        # NOT here — its proposal-time freeze would DoS the company; see the
        # _CONFINED_ESCALATES_TO_APPROVAL definition above.)
        return

    # DEFAULT-DENY: every other command (root issue_create, company create/update,
    # agent.update, and any future unenumerated type) is a configuration /
    # governance mutation a confined agent may not perform directly.
    raise AutonomyGateError(
        f"{type(command).__name__} is not permitted for an autonomous agent "
        "(confined actor, default-deny); it is a governance/configuration mutation "
        "that must go through a human (operator action or approval), or — for root "
        "work — be broken down with issue_delegate under an issue you already own",
        target_company=scope.actor_company_id,
    )


def _acting_agent_id(scope: CompanyScope, *, action: str) -> str:
    """The acting agent id for a confined command, or fail closed if unidentified.

    A confined actor that cannot be identified can prove no ownership / management
    relationship — there is no agent to match an issue's assignee or an org subtree
    against — so it is refused here rather than allowed to act unattributed.
    """
    actor_id = scope.actor_agent_profile_id
    if actor_id is None:
        raise AutonomyGateError(
            f"{action} requires an identified acting agent; this confined run has "
            "no bound agent profile (fail-closed)",
            target_company=scope.actor_company_id,
        )
    return actor_id


def _assert_acting_agent_owns_issue(
    scope: CompanyScope, store: "StateStore", issue_id: str, *, action: str
) -> None:
    """Refuse unless the acting agent OWNS ``issue_id`` (assignee ∈ acting subtree).

    "Owns" = the issue's assignee is the acting agent itself, or an agent that
    reports (directly/transitively) to it. This keeps a confined actor's
    comment/attach/submit/delegate-parent on issues within its own reach (design
    §6.1 "只限当前 issue/tree"), not on any issue in the company. The hard scope
    gate already proved the issue is in the actor's company; this adds the
    ownership line on top.

    Fail-closed: an unidentified acting agent, an unknown issue, or an issue with
    NO assignee (nobody owns it, so a confined actor certainly does not) is refused.
    """
    actor_id = _acting_agent_id(scope, action=action)
    try:
        issue = store.get_issue(issue_id)
    except KeyError:
        raise AutonomyGateError(
            f"{action}: unknown issue {issue_id!r} (fail-closed)",
            target_company=scope.actor_company_id,
        ) from None
    assignee = getattr(issue, "assignee_agent_profile_id", None)
    if not (isinstance(assignee, str) and assignee):
        raise AutonomyGateError(
            f"{action}: issue {issue_id!r} has no assignee, so a confined agent "
            "cannot own it (assign it first / let its owner act)",
            target_company=scope.actor_company_id,
        )
    if not _is_in_subtree(store, manager_id=actor_id, target_id=assignee):
        raise AutonomyGateError(
            f"{action}: issue {issue_id!r} is owned by {assignee!r}, who is not "
            f"the acting agent {actor_id!r} nor in its reports-to subtree; a "
            "confined agent may only act on issues it owns",
            target_company=scope.actor_company_id,
        )


def _assert_target_in_subtree(
    scope: CompanyScope,
    store: "StateStore",
    *,
    target_profile_id: str,
    action: str,
) -> None:
    """Refuse unless ``target_profile_id`` is the acting agent or in its subtree."""
    actor_id = _acting_agent_id(scope, action=action)
    if not _is_in_subtree(store, manager_id=actor_id, target_id=target_profile_id):
        raise AutonomyGateError(
            f"{action} target {target_profile_id!r} is not the acting agent "
            f"{actor_id!r} nor in its reports-to subtree; a confined agent may "
            "only route work to itself or its (direct/transitive) reports",
            target_company=scope.actor_company_id,
        )


def _is_in_subtree(store: "StateStore", *, manager_id: str, target_id: str) -> bool:
    """Is ``target_id`` the manager itself, or somewhere under it in reports_to?

    Walks UP from the target through its ``reports_to`` chain (cycle-safe, bounded)
    looking for the manager. ``target == manager`` is in-subtree by definition. An
    unknown target, or a chain that exceeds the walk bound / loops without reaching
    the manager, returns ``False`` — the gate then fails closed.
    """
    if not (isinstance(target_id, str) and target_id):
        return False
    if not (isinstance(manager_id, str) and manager_id):
        return False
    if target_id == manager_id:
        return True
    seen: set[str] = {target_id}
    current: str = target_id
    for _ in range(_MAX_REPORTS_TO_WALK):
        try:
            profile = store.get_agent_profile(current)
        except KeyError:
            return False
        manager = getattr(profile, "reports_to", None)
        if not (isinstance(manager, str) and manager):
            return False  # reached a root with no manager: not under ``manager_id``
        if manager == manager_id:
            return True
        if manager in seen:
            return False  # cycle: cannot prove the relationship → fail closed
        seen.add(manager)
        current = manager
    return False  # walk bound exhausted → fail closed


def _assert_fanout_budget_ok(command: DelegateIssueCommand, store: "StateStore") -> None:
    """Budget preflight before a confined actor creates runnable work (delegate).

    Reuses the SAME budget primitive checkout uses (``issue_start_budget_preflight``
    over the would-be child's company/agent/issue checks) so the fan-out gate and
    the run-start gate read one budget source — no parallel budget logic. The
    child inherits the parent's workspace + company and is assigned to
    ``assignee_agent_profile_id``, so we preflight against THAT prospective agent +
    the parent's company. A blocked preflight refuses the delegate here, before any
    child issue is written or any downstream checkout is attempted.

    This is an EARLY best-effort gate (it does not reserve budget): the
    authoritative hard stop stays at checkout (``checkout_issue`` re-runs the same
    preflight and raises ``BudgetGateError``), so a concurrent double-delegate that
    slips past two preflights is still caught at the (serialized) checkout. The
    value here is failing fast at fan-out time instead of after a child is created.

    Fail-closed: an unresolvable parent/assignee propagates as ``KeyError``.
    """
    from superclaw import team_kernel
    from superclaw.models import Issue

    parent = store.get_issue(command.parent_id)  # KeyError → fail-closed
    store.get_agent_profile(command.assignee_agent_profile_id)  # KeyError → fail-closed
    prospective_child: Issue = Issue(
        title=command.title,
        company_profile_id=parent.company_profile_id,
        workspace_id=parent.workspace_id,
        assignee_agent_profile_id=command.assignee_agent_profile_id,
        parent_id=parent.issue_id,
    )
    preflight = team_kernel.issue_start_budget_preflight(
        store, prospective_child, action="delegate"
    )
    if not preflight.allowed:
        blocked = preflight.blocked
        reason = blocked[0].message if blocked else "budget exhausted"
        raise AutonomyGateError(
            f"delegate refused: fan-out budget preflight blocked it ({reason}); "
            "a confined agent cannot create runnable work once its budget is "
            "exhausted",
            target_company=parent.company_profile_id,
        )
