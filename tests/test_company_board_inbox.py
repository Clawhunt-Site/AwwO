"""P2: board-inbox resolve/assign write commands + board_inbox_list read tool.

The human-escalation queue (durable ESCALATE_TO_BOARD interactions) projected into
chat: the operator can clear an escalation (resolve) or assign its issue to an agent
(assign) — and SEE the queue (board_inbox_list) — routed through the SAME
execute_company_command / execute_company_read choke points as every other company
operation, and through the SAME team_kernel.*_board_inbox_item functions the CLI and
REST drive (single source, no inline drift). Covered here:

  * single-source contract: registry / tool map / schema / read-tool map in lockstep;
  * dispatch (operator, end-to-end): resolve (idempotent), assign (+ optional resolve);
  * kernel guards: non-board interaction refused, assign requires pending, unknown id;
  * risk tiers: both write commands are reversible → LOW (direct);
  * governance: a CONFINED agent is default-denied resolve AND assign (operator-only —
    an agent must not clear its own escalation to the human board);
  * scope: same-origin assignee enforced; an unknown item is fail-closed forbidden;
  * lifecycle: a frozen company refuses the command;
  * read tool: scope-filtered, board-only, status-filtered, capped honestly.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.company_commands import (
    COMMAND_REGISTRY,
    COMMAND_TYPE_TO_TOOL_NAME,
    get_command_model,
)
from superclaw.company_handler import execute_company_command
from superclaw.company_lifecycle import CompanyFrozenError
from superclaw.company_read import BoardInboxListRead, execute_company_read
from superclaw.company_risk import RiskTier, classify_company_action
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    CompanyStatus,
    ContinuationPolicy,
    Issue,
    IssueThreadInteraction,
)
from superclaw.state import StateStore
from superclaw.ui_contracts import (
    COMPANY_COMMAND_TOOLS,
    COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE,
    COMPANY_READ_TOOLS,
    TOOL_NAME_TO_COMMAND_TYPE,
)

_WRITE_TYPES = {"board_inbox.resolve", "board_inbox.assign"}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name, owner_id="u"))


def _agent(store, company_id, *, name="A"):
    return store.save_agent_profile(
        AgentProfile(name=name, role="eng", company_profile_id=company_id)
    )


def _issue(store, company_id, *, status="todo", assignee=None):
    return store.save_issue(
        Issue(
            title="T",
            company_profile_id=company_id,
            status=status,
            assignee_agent_profile_id=assignee,
        )
    )


def _board_item(store, issue, *, status="pending", kind="qa_rejection"):
    return store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            kind=kind,
            continuation_policy=ContinuationPolicy.ESCALATE_TO_BOARD.value,
            status=status,
        )
    )


def _plain_interaction(store, issue):
    # A non-board interaction (different continuation policy) — must be refused.
    return store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            kind="mention",
            continuation_policy=ContinuationPolicy.WAKE_ASSIGNEE.value,
            status="pending",
        )
    )


def _operator(company_id):
    return CompanyScope(principal_id="u", actor_company_id=company_id, is_admin=True)


def _confined(company_id, agent_id):
    return CompanyScope(
        principal_id="u",
        actor_company_id=company_id,
        is_admin=False,
        actor_agent_profile_id=agent_id,
    )


def _run(store, scope, command_type, args):
    cmd = get_command_model(command_type).from_dict(args)
    return execute_company_command(cmd, scope=scope, store=store, requested_by="u")


# --- single-source contract -------------------------------------------------
def test_board_inbox_registered_and_mapped():
    assert _WRITE_TYPES <= set(COMMAND_REGISTRY)
    assert _WRITE_TYPES <= set(COMMAND_TYPE_TO_TOOL_NAME)
    schema_names = {t["name"] for t in COMPANY_COMMAND_TOOLS}
    for ctype in _WRITE_TYPES:
        assert COMMAND_TYPE_TO_TOOL_NAME[ctype] in schema_names
        assert COMMAND_TYPE_TO_TOOL_NAME[ctype] in TOOL_NAME_TO_COMMAND_TYPE
    # The read tool is a READ (never a mutation) and lives in the read map only.
    assert "board_inbox.list" in COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE.values()
    assert "board_inbox_list" in {t["name"] for t in COMPANY_READ_TOOLS}
    assert "board_inbox_list" not in TOOL_NAME_TO_COMMAND_TYPE  # disjoint from writes


# --- risk: both reversible → LOW --------------------------------------------
@pytest.mark.parametrize(
    "ctype,args",
    [
        ("board_inbox.resolve", {"interaction_id": "x"}),
        ("board_inbox.assign", {"interaction_id": "x", "profile_id": "p"}),
    ],
)
def test_board_inbox_writes_are_low(ctype, args):
    cmd = get_command_model(ctype).from_dict(args)
    verdict = classify_company_action(cmd, actor_company_id="c", actor_is_operator=True)
    assert verdict.tier == RiskTier.LOW.value


# --- dispatch (operator, end-to-end) ----------------------------------------
def test_resolve_board_item_idempotent(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    item = _board_item(store, iss)
    op = _operator(c.company_profile_id)

    res = _run(store, op, "board_inbox.resolve", {"interaction_id": item.interaction_id})
    assert res.outcome == "executed" and res.detail["status"] == "resolved"
    assert store.get_issue_interaction(item.interaction_id).status == "resolved"
    # The issue is untouched by a resolve.
    assert store.get_issue(iss.issue_id).assignee_agent_profile_id is None

    # Idempotent: a second resolve is a no-op, not an error.
    res2 = _run(store, op, "board_inbox.resolve", {"interaction_id": item.interaction_id})
    assert res2.outcome == "executed" and res2.detail["status"] == "resolved"


def test_resolve_non_board_interaction_refused(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    plain = _plain_interaction(store, iss)
    op = _operator(c.company_profile_id)
    with pytest.raises(ValueError, match="not a board inbox item"):
        _run(store, op, "board_inbox.resolve", {"interaction_id": plain.interaction_id})
    # The non-board interaction is left untouched (still pending).
    assert store.get_issue_interaction(plain.interaction_id).status == "pending"


def test_assign_board_item_resolves_by_default(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, status="todo")
    item = _board_item(store, iss)
    op = _operator(c.company_profile_id)

    res = _run(
        store, op, "board_inbox.assign",
        {"interaction_id": item.interaction_id, "profile_id": ag.profile_id},
    )
    assert res.outcome == "executed" and res.detail["resolved"] is True
    assert store.get_issue(iss.issue_id).assignee_agent_profile_id == ag.profile_id
    assert store.get_issue_interaction(item.interaction_id).status == "resolved"


def test_assign_board_item_keep_open(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, status="todo")
    item = _board_item(store, iss)
    op = _operator(c.company_profile_id)

    res = _run(
        store, op, "board_inbox.assign",
        {"interaction_id": item.interaction_id, "profile_id": ag.profile_id, "resolve": False},
    )
    assert res.outcome == "executed" and res.detail["resolved"] is False
    assert store.get_issue(iss.issue_id).assignee_agent_profile_id == ag.profile_id
    assert store.get_issue_interaction(item.interaction_id).status == "pending"


def test_assign_requires_pending(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, status="todo")
    item = _board_item(store, iss, status="resolved")
    op = _operator(c.company_profile_id)
    with pytest.raises(ValueError, match="not pending"):
        _run(
            store, op, "board_inbox.assign",
            {"interaction_id": item.interaction_id, "profile_id": ag.profile_id},
        )
    # No assignment leaked.
    assert store.get_issue(iss.issue_id).assignee_agent_profile_id is None


# --- governance: confined agents are default-denied (operator-only) ----------
def test_confined_agent_denied_resolve(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, assignee=ag.profile_id)
    item = _board_item(store, iss)
    conf = _confined(c.company_profile_id, ag.profile_id)
    with pytest.raises(CompanyScopeError):
        _run(store, conf, "board_inbox.resolve", {"interaction_id": item.interaction_id})
    assert store.get_issue_interaction(item.interaction_id).status == "pending"


def test_confined_agent_denied_assign(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    iss = _issue(store, c.company_profile_id, status="todo", assignee=ag.profile_id)
    item = _board_item(store, iss)
    conf = _confined(c.company_profile_id, ag.profile_id)
    with pytest.raises(CompanyScopeError):
        _run(
            store, conf, "board_inbox.assign",
            {"interaction_id": item.interaction_id, "profile_id": ag.profile_id},
        )


# --- scope / fail-closed -----------------------------------------------------
def test_assign_cross_company_assignee_forbidden(store):
    c1 = _company(store, name="A")
    c2 = _company(store, name="B")
    iss = _issue(store, c1.company_profile_id, status="todo")
    foreign = _agent(store, c2.company_profile_id)
    item = _board_item(store, iss)
    op = _operator(c1.company_profile_id)
    # Same-origin: the escalation's issue (A) and the assignee (B) must share a
    # company — even for the admin operator.
    with pytest.raises(CompanyScopeError):
        _run(
            store, op, "board_inbox.assign",
            {"interaction_id": item.interaction_id, "profile_id": foreign.profile_id},
        )
    assert store.get_issue(iss.issue_id).assignee_agent_profile_id is None


def test_unknown_interaction_fail_closed(store):
    c = _company(store)
    op = _operator(c.company_profile_id)
    with pytest.raises(CompanyScopeError, match="unknown board inbox item"):
        _run(store, op, "board_inbox.resolve", {"interaction_id": "nope"})


# --- lifecycle: frozen company refuses --------------------------------------
def test_frozen_company_refuses_resolve(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    item = _board_item(store, iss)
    c.status = CompanyStatus.FROZEN.value
    store.save_company_profile(c)
    op = _operator(c.company_profile_id)
    with pytest.raises(CompanyFrozenError):
        _run(store, op, "board_inbox.resolve", {"interaction_id": item.interaction_id})


# --- kernel functions (single source) ---------------------------------------
def test_kernel_resolve_unknown_keyerror(store):
    with pytest.raises(KeyError):
        team_kernel.resolve_board_inbox_item(store, "nope")


def test_kernel_assign_unknown_keyerror(store):
    with pytest.raises(KeyError):
        team_kernel.assign_board_inbox_item(store, "nope", "p")


# --- read tool: board_inbox_list --------------------------------------------
def test_board_inbox_list_board_only_and_scoped(store):
    c = _company(store)
    other = _company(store, name="Other")
    iss = _issue(store, c.company_profile_id)
    item = _board_item(store, iss)
    _plain_interaction(store, iss)  # non-board → excluded
    # A board item in ANOTHER company → excluded by the company filter.
    other_iss = _issue(store, other.company_profile_id)
    _board_item(store, other_iss)

    op = _operator(c.company_profile_id)
    payload = execute_company_read(
        BoardInboxListRead.from_dict({"company_profile_id": c.company_profile_id}),
        scope=op,
        store=store,
    )
    ids = {it["interaction_id"] for it in payload["items"]}
    assert ids == {item.interaction_id}
    assert payload["returned"] == 1 and payload["capped"] is False
    assert payload["status_filter"] == "pending"


def test_board_inbox_list_capped_is_honest(store, monkeypatch):
    # Exactly cap rows with no overflow → NOT capped; cap+1 → capped (Codex R1).
    import superclaw.company_read as cr

    monkeypatch.setattr(cr, "_BOARD_INBOX_CAP", 2)
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    op = _operator(c.company_profile_id)

    for _ in range(2):
        _board_item(store, iss)
    exact = execute_company_read(BoardInboxListRead.from_dict({}), scope=op, store=store)
    assert exact["returned"] == 2 and exact["capped"] is False

    _board_item(store, iss)  # the 3rd (overflow)
    over = execute_company_read(BoardInboxListRead.from_dict({}), scope=op, store=store)
    assert over["returned"] == 2 and over["capped"] is True


def test_board_inbox_list_status_filter(store):
    c = _company(store)
    iss = _issue(store, c.company_profile_id)
    pending = _board_item(store, iss)
    resolved = _board_item(store, iss, status="resolved")
    op = _operator(c.company_profile_id)

    # Default = pending only.
    pend = execute_company_read(BoardInboxListRead.from_dict({}), scope=op, store=store)
    assert {it["interaction_id"] for it in pend["items"]} == {pending.interaction_id}

    # status=all → both.
    allp = execute_company_read(
        BoardInboxListRead.from_dict({"status": "all"}), scope=op, store=store
    )
    assert {it["interaction_id"] for it in allp["items"]} == {
        pending.interaction_id,
        resolved.interaction_id,
    }
