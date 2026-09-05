"""Risk gate for chat-driven ClawHunt marketplace participation.

This module answers ONE question for each marketplace command: *can this action
run straight through (LOW), or must it pause for a human approval (HIGH)?*

It is DELIBERATELY a separate classifier from :mod:`superclaw.company_risk`
(advisor裁决 2026-06-24, Codex gpt-5.5 + Antigravity Gemini 3.1 Pro, both
blocking). company_risk implements a permissive, single-user, "if the user
triggered it, allow it" model where nearly everything is LOW and only an
IRREVERSIBLE local op (archive) is HIGH. Marketplace actions are categorically
different:

  * They cross an EXTERNAL network boundary to a third party (ClawHunt).
  * They make COMMITMENTS (bid / claim) and may MOVE MONEY (accept / accept_bid).
  * "Reversible locally" is meaningless once a commitment is visible remotely.

So the marketplace policy INVERTS the company default:

  * **LOW (direct)** — only READ commands (``marketplace.browse`` /
    ``marketplace.inspect``). They never mutate remote state. (They still require
    a connected agent key — that is an AUTH precondition the handler enforces, not
    a risk tier.)
  * **HIGH (human approval)** — EVERY write: post_task / bid / claim / submit /
    abandon / accept / accept_bid. Network egress + commitment + money never run
    on the default path (项目铁律: "支付永不在默认路径"). An unrecognised command
    type is also HIGH (conservative default-deny).

The verdict shape reuses :mod:`superclaw.company_risk` (``RiskTier`` /
``RiskVerdict``) so the handler's LOW-direct / HIGH-approval branch is identical
across both capability namespaces — only the POLICY differs, never the plumbing.
"""

from __future__ import annotations

from typing import Any

from superclaw.company_risk import RiskTier, RiskVerdict


def _high(*reasons: str) -> RiskVerdict:
    return RiskVerdict(tier=RiskTier.HIGH.value, reasons=tuple(reasons))


def _low(reason: str) -> RiskVerdict:
    return RiskVerdict(tier=RiskTier.LOW.value, reasons=(reason,))


def classify_marketplace_action(command: Any) -> RiskVerdict:
    """Classify a marketplace command as LOW (direct read) or HIGH (approval).

    Fail-closed: the tier is derived from the command's own ``is_read`` class flag
    (defined once in :mod:`superclaw.marketplace_commands`), NOT a hand-maintained
    type list here, so a newly-added command can never silently fall through to
    LOW. A command WITHOUT the flag (an unrecognised / non-marketplace object) is
    HIGH — a never-seen mutation must never run straight through.
    """
    is_read = getattr(command, "is_read", None)
    if is_read is True:
        return _low("read-only marketplace query (no remote mutation)")
    if is_read is False:
        return _high(
            "marketplace write crosses an external boundary and makes a remote "
            "commitment (network egress / bid / claim / submit / payment) — "
            "requires human approval; payment never runs on the default path"
        )
    # No is_read flag → not a recognised marketplace command. Default-deny.
    return _high(f"unrecognized marketplace command: {type(command).__name__!r}")
