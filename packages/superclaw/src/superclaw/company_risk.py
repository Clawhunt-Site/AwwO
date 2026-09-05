"""Risk gate for chat-driven company management — irreversibility policy.

This module answers ONE question for each company-management command:
*can this action run straight through (LOW), or must it pause for a lightweight
human "are you sure?" confirmation (HIGH)?*

It implements the threat model the owner **re-ratified on 2026-06-22** (see
docs/company-chat-management-design.md §1, the "威胁模型重定" block, which takes
priority over the older default-deny / anti-rogue-agent posture):

  * SuperClaw is a **single-user, local tool**; the agent is the user's OWN
    assistant doing what the user told it to do. The governing principle is
    **"if the user triggered it, it should be allowed"**.
  * We do NOT defend against a "rogue in-process agent self-approving behind the
    user's back". That was a mismatched threat model, and the heavyweight
    authentication root it required (hardware-presence signing / kernel
    signature verification / ``operator_proof`` challenge — the former PR-C) is
    **deleted, not implemented**.
  * What we DO guard is **mistakes / the agent misreading the user and causing
    an IRREVERSIBLE loss**. So the only HIGH operations are the destructive /
    irreversible ones, gated behind a lightweight human "are you sure?"
    confirmation (reusing the existing Approval UI — a手滑 speed-bump, NOT a
    cryptographic security boundary against an adversarial agent).

Concretely the policy is:

  * **HIGH (needs human confirmation)** *iff* the command is irreversible /
    destructive — today that is :class:`CompanyArchiveCommand` (dissolve /
    archive). An unrecognised command type is also HIGH (conservative
    default-deny against a wiring bug, not against a hostile agent).
  * **LOW (direct execution)** for everything a user routinely triggers:
    company create / update, hire / update agent, create / assign / delegate
    issue.

The verdict shape (:class:`RiskTier`, :class:`RiskVerdict`) is unchanged so the
handler that consumes it (``company_handler.classify_company_action`` → LOW
direct-dispatch vs HIGH approval) does not change. The kept ``store`` /
``equipment_resolver`` parameters are now unused by the policy but retained on
the signature so no caller has to change; the cross-company / scope correctness
checks live in ``company_scope`` (a separate hard gate), not here.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Callable

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

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from superclaw.models import AgentProfile
    from superclaw.state import StateStore
    from superclaw.team_kernel import EquipmentResolution


class RiskTier(str, Enum):
    """The two tiers the gate emits."""

    LOW = "low"
    HIGH = "high"


@dataclass(frozen=True)
class RiskVerdict:
    """The classification result: a tier plus the reasons it landed there.

    ``reasons`` records *why* — for a HIGH verdict it is the list of facts that
    require confirmation (so an operator/audit log sees the cause), and for a LOW
    verdict it is the single clause that judged it benign.
    """

    tier: str
    reasons: tuple[str, ...] = ()

    @property
    def is_high(self) -> bool:
        return self.tier == RiskTier.HIGH.value


def _high(*reasons: str) -> RiskVerdict:
    return RiskVerdict(tier=RiskTier.HIGH.value, reasons=tuple(reasons))


def _low(reason: str) -> RiskVerdict:
    return RiskVerdict(tier=RiskTier.LOW.value, reasons=(reason,))


def classify_company_action(
    command: Any,
    *,
    actor_company_id: str,
    actor_is_operator: bool = False,
    store: "StateStore | None" = None,
    equipment_resolver: "Callable[[AgentProfile], EquipmentResolution] | None" = None,
) -> RiskVerdict:
    """Classify a company-management command as LOW (direct) or HIGH (confirm).

    Policy (threat model re-ratified 2026-06-22, design §1): operator-triggered
    actions run straight through (LOW); HIGH (human gate) covers two cases —
    (a) IRREVERSIBLE / destructive operations regardless of actor
    (:class:`CompanyArchiveCommand`, archive / dissolve), and (b) an AUTONOMOUS
    agent's :class:`HireAgentCommand` (the red line: an agent proposes a hire, a
    human grants it; ``actor_is_operator`` distinguishes the two). An unrecognised
    command type is HIGH as a conservative default-deny (guards a wiring bug).

    Parameters
    ----------
    command:
        Any :mod:`superclaw.company_commands` model instance.
    actor_company_id:
        The company the acting chat is scoped to. Retained for signature
        stability; cross-company / scope correctness is enforced by the separate
        ``company_scope`` hard gate, not by this risk tier.
    actor_is_operator:
        Whether the actor is the human operator (``CompanyScope.is_admin``), i.e.
        the single owner acting through their own chat/CLI, vs an AUTONOMOUS agent
        run (``is_admin=False``, derived from the agent profile and never
        self-reported). The "user-triggered ⇒ reversible ⇒ LOW" premise only holds
        for the operator; an autonomous agent hiring is NOT a user action, so it
        must pass through a human approval gate (the red line: an agent proposes a
        hire, a human grants it; the agent never creates a profile directly).
        Fail-closed default ``False``: a caller that forgets to pass it gets the
        conservative approval path, never silent direct-create.
    store, equipment_resolver:
        Unused by this policy (the old effective-permission-closure logic served
        the retired anti-rogue-agent threat model). Kept on the signature so the
        handler call site does not change.
    """
    if isinstance(command, CompanyArchiveCommand):
        return _high(
            "archive/dissolve is an irreversible, destructive operation and "
            "requires human confirmation"
        )

    # Cancelling a whole issue subtree terminates every issue under the root — an
    # irreversible, destructive operation (mirrors archive), so it pauses for a human
    # confirmation. Tree pause/resume below are reversible → LOW.
    if isinstance(command, CancelIssueTreeCommand):
        return _high(
            "cancelling an issue subtree is an irreversible, destructive operation "
            "and requires human confirmation"
        )

    # Hiring is actor-aware (red line). The operator hiring is a normal reversible
    # user action → LOW (direct). An AUTONOMOUS agent hiring is NOT user-triggered:
    # it must pause for human approval (HIGH) so a human grants before any agent
    # profile is created. ``is_admin`` is kernel-derived from the agent profile, so
    # an agent cannot launder itself into the operator branch.
    if isinstance(command, HireAgentCommand):
        if actor_is_operator:
            return _low("operator-triggered hire is reversible (direct create)")
        return _high(
            "autonomous agent-initiated hire requires human approval: the agent "
            "proposes the hire; a human grants it before any profile is created"
        )

    # Everything else a user/agent routinely triggers (company create/update,
    # update agent, create/assign/delegate issue, post a comment, attach a delivery
    # fact, request review) is reversible → LOW, direct execution. The thread/
    # delivery/review commands (柱子 1b) are audit-only or move work TOWARD a human
    # gate (submit → in_review is the request, not the grant), so none is itself an
    # irreversible operation; the autonomy门 (company_autonomy) is what confines an
    # AGENT's reach, not this reversibility tier.
    if isinstance(
        command,
        (
            CompanyCreateCommand,
            CompanyUpdateCommand,
            UpdateAgentCommand,
            UpdateAgentCharterCommand,
            CreateIssueCommand,
            AssignIssueCommand,
            DelegateIssueCommand,
            PostIssueCommentCommand,
            AttachWorkProductCommand,
            SubmitReviewCommand,
            # P2 issue lifecycle — reversible store-state transitions: a block/hold
            # is undone by its inverse (unblock/unhold).
            BlockIssueCommand,
            UnblockIssueCommand,
            HoldIssueCommand,
            UnholdIssueCommand,
            # Requeue recovers a stuck issue (cancel its stuck run + back to the queue,
            # re-claimable) → reversible → LOW.
            RequeueIssueCommand,
            # A work-product UPDATE patches mutable fields → reversible → LOW (delete
            # is the irreversible one, handled HIGH above).
            UpdateWorkProductCommand,
            # Tree pause/resume are reversible (resume undoes pause) → LOW.
            PauseIssueTreeCommand,
            ResumeIssueTreeCommand,
            # Authoring a routine creates a schedule that can be disabled/removed →
            # reversible → LOW (the authoring helper routes governance-gated specs to
            # their own approval; the handler refuses those, so no double approval).
            AuthorRoutineCommand,
            # Board-inbox resolve/assign are reversible queue management (resolve flips
            # an escalation; assign re-uses the reversible assign_issue) → LOW. They are
            # operator-only via the autonomy gate (default-deny), not via this tier.
            ResolveBoardInboxCommand,
            AssignBoardInboxCommand,
        ),
    ):
        return _low("reversible user-triggered operation")

    # Default-deny: an unrecognised command type is HIGH (a wiring-bug guard, so
    # a never-seen mutation can never silently run straight through).
    return _high(f"unrecognized command: {type(command).__name__!r}")
