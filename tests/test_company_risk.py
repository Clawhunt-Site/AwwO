"""Tests for the company-management risk gate (irreversibility policy).

Exercises :func:`superclaw.company_risk.classify_company_action` under the
threat model the owner re-ratified on 2026-06-22 (design §1): SuperClaw is a
single-user local tool whose agent acts on the user's own instructions, so
**user-triggered actions run straight through (LOW)** and only **irreversible /
destructive** operations pause for a lightweight human "are you sure?"
confirmation (HIGH). Today the sole irreversible command is
``CompanyArchiveCommand``; an unrecognised command type is HIGH as a
conservative default-deny against a wiring bug (not against a hostile agent).

The ``store`` / ``equipment_resolver`` parameters are retained on the signature
(so the handler call site is unchanged) but no longer influence the verdict.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import (
    AssignIssueCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    UpdateAgentCommand,
)
from superclaw.company_risk import (
    RiskTier,
    RiskVerdict,
    classify_company_action,
)

ACTOR = "company_actor"


# --------------------------------------------------------------------------- #
# RiskVerdict / RiskTier
# --------------------------------------------------------------------------- #
def test_risk_tier_values():
    assert RiskTier.LOW.value == "low"
    assert RiskTier.HIGH.value == "high"


def test_risk_verdict_is_high_property():
    assert RiskVerdict(tier=RiskTier.HIGH.value).is_high is True
    assert RiskVerdict(tier=RiskTier.LOW.value).is_high is False


def test_risk_verdict_carries_reasons():
    v = RiskVerdict(tier=RiskTier.HIGH.value, reasons=("a", "b"))
    assert v.reasons == ("a", "b")


# --------------------------------------------------------------------------- #
# HIGH: only the irreversible / destructive command (archive)
# --------------------------------------------------------------------------- #
def test_company_archive_is_high():
    v = classify_company_action(
        CompanyArchiveCommand(company_profile_id=ACTOR),
        actor_company_id=ACTOR,
    )
    assert v.is_high
    assert v.tier == RiskTier.HIGH.value
    assert any("irreversible" in r or "destructive" in r for r in v.reasons)


def test_company_archive_high_regardless_of_extra_params():
    # The unused store / equipment_resolver seams do not change the verdict.
    v = classify_company_action(
        CompanyArchiveCommand(company_profile_id=ACTOR, reason="cleanup"),
        actor_company_id=ACTOR,
        store=None,
        equipment_resolver=lambda profile: None,  # never consulted
    )
    assert v.is_high


# --------------------------------------------------------------------------- #
# LOW: every reversible, user-triggered command
# --------------------------------------------------------------------------- #
def test_company_create_low():
    v = classify_company_action(
        CompanyCreateCommand(name="Acme"),
        actor_company_id=ACTOR,
    )
    assert not v.is_high
    assert v.tier == RiskTier.LOW.value


def test_company_create_with_owner_and_grants_still_low():
    # Under the new threat model these are reversible user-triggered settings, no
    # longer an anti-rogue-agent escalation signal -> LOW.
    v = classify_company_action(
        CompanyCreateCommand(
            name="Acme",
            owner_id="someone_else",
            allowed_plugins=["pay-switch"],
            default_token_budget=1000,
            default_budget_seconds=600,
        ),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


def test_company_update_low():
    v = classify_company_action(
        CompanyUpdateCommand(company_profile_id=ACTOR, name="renamed"),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


def test_update_agent_low():
    v = classify_company_action(
        UpdateAgentCommand(profile_id="agent_x", patch={"name": "new"}),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


def test_hire_by_operator_low():
    # The human operator hiring is a normal, reversible user action → LOW (direct).
    v = classify_company_action(
        HireAgentCommand(spec={"name": "Bob", "role": "worker"}),
        actor_company_id=ACTOR,
        actor_is_operator=True,
    )
    assert not v.is_high


def test_hire_by_operator_with_equipment_and_elevated_mode_still_low():
    # Equipment grants / elevated permission mode / cross-company spec no longer
    # raise the tier — the OPERATOR hiring an equipped agent is a normal operation.
    v = classify_company_action(
        HireAgentCommand(
            spec={
                "name": "Bob",
                "role": "worker",
                "plugin_allowlist": ["pay-switch"],
                "permission_policy": {"mode": "auto"},
                "company_profile_id": "other_co",
            }
        ),
        actor_company_id=ACTOR,
        actor_is_operator=True,
    )
    assert not v.is_high


def test_hire_by_autonomous_agent_is_high():
    # RED LINE: an autonomous agent (is_admin=False ⇒ actor_is_operator=False)
    # hiring must pause for human approval — it never creates a profile directly.
    v = classify_company_action(
        HireAgentCommand(spec={"name": "Bob", "role": "worker"}),
        actor_company_id=ACTOR,
        actor_is_operator=False,
    )
    assert v.is_high
    assert any("human approval" in r for r in v.reasons)


def test_hire_defaults_to_high_when_actor_unknown():
    # Fail-closed: a caller that forgets actor_is_operator gets the conservative
    # approval path (HIGH), never a silent direct-create.
    v = classify_company_action(
        HireAgentCommand(spec={"name": "Bob", "role": "worker"}),
        actor_company_id=ACTOR,
    )
    assert v.is_high


def test_create_issue_structured_kind_low():
    v = classify_company_action(
        CreateIssueCommand(title="Do work", kind="delivery"),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


def test_create_issue_freeform_or_assigned_still_low():
    # Freeform body / bundled assignee / explicit workspace are all reversible
    # user-triggered choices now -> LOW.
    for cmd in (
        CreateIssueCommand(title="vague", kind=None),
        CreateIssueCommand(
            title="Do work", kind="delivery", assignee_agent_profile_id="agent_x"
        ),
        CreateIssueCommand(title="Do work", kind="delivery", workspace_id="ws_other"),
    ):
        v = classify_company_action(cmd, actor_company_id=ACTOR)
        assert not v.is_high


def test_assign_issue_low():
    v = classify_company_action(
        AssignIssueCommand(issue_id="issue_1", profile_id="agent_x"),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


def test_assign_issue_low_without_store():
    # No store needed any more: assignment is reversible -> LOW regardless.
    v = classify_company_action(
        AssignIssueCommand(issue_id="issue_1", profile_id="agent_x"),
        actor_company_id=ACTOR,
        store=None,
    )
    assert not v.is_high


def test_delegate_issue_low():
    v = classify_company_action(
        DelegateIssueCommand(
            parent_id="issue_p",
            assignee_agent_profile_id="agent_x",
            title="child",
        ),
        actor_company_id=ACTOR,
    )
    assert not v.is_high


# --------------------------------------------------------------------------- #
# Default-deny: an unrecognized command type is still HIGH (wiring-bug guard)
# --------------------------------------------------------------------------- #
def test_unrecognized_command_is_high():
    class NotACommand:
        pass

    v = classify_company_action(NotACommand(), actor_company_id=ACTOR)
    assert v.is_high
    assert any("unrecognized" in r for r in v.reasons)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
