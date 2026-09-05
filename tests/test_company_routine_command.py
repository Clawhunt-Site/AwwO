"""P2: routine.author write command (author a recurring routine from chat).

The operator can schedule recurring work from chat. The command runs the routine
authoring helper and persists ONLY a ready/disabled schedule; a spec that needs
governance approval is refused and directed to the dedicated routine flow (so the
company command gate is never layered on the routine's own approval). Covered:

  * dispatch: a ready spec is authored + persisted; an invalid spec surfaces the
    helper's errors (fail-closed, no schedule written);
  * risk: reversible (a schedule can be disabled/removed) → LOW;
  * governance: a CONFINED agent is default-denied (operator-only);
  * scope: the routine's company (off the spec) must be in scope.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import AuthorRoutineCommand, get_command_model
from superclaw.company_handler import execute_company_command
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import AgentProfile, CompanyProfile, WorkspaceProfile
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _setup(store, *, name="Acme"):
    c = store.save_company_profile(CompanyProfile(name=name, owner_id="u"))
    ws = store.save_workspace_profile(WorkspaceProfile(name="ws", company_profile_id=c.company_profile_id))
    ag = store.save_agent_profile(
        AgentProfile(name="A", role="eng", company_profile_id=c.company_profile_id, workspace_id=ws.workspace_id)
    )
    return c, ws, ag


def _spec(company_id, workspace_id, agent_id):
    return {
        "title": "Daily triage",
        "enabled": True,
        "owner_id": "u",
        "company_profile_id": company_id,
        "workspace_id": workspace_id,
        "agent_profile_id": agent_id,
        "cadence": {"interval_sec": 3600},
        "issue_seed": {"title": "Review", "description": "x", "priority": "medium"},
        "governance": {"requested_budget_seconds": 300, "max_budget_seconds": 600},
    }


def _operator(company_id):
    return CompanyScope(principal_id="u", actor_company_id=company_id, is_admin=True)


def _run(store, scope, args):
    return execute_company_command(
        get_command_model("routine.author").from_dict(args), scope=scope, store=store, requested_by="u"
    )


def test_author_ready_spec_persists(store):
    c, ws, ag = _setup(store)
    spec = _spec(c.company_profile_id, ws.workspace_id, ag.profile_id)
    res = _run(store, _operator(c.company_profile_id), {"spec": spec})
    assert res.outcome == "executed"
    assert res.detail["created"] is True
    assert len(store.list_team_routine_schedules()) == 1


def test_author_invalid_spec_surfaces_errors_no_write(store):
    c, _ws, _ag = _setup(store)
    # missing owner_id / workspace_id → invalid
    res_err = None
    try:
        _run(store, _operator(c.company_profile_id), {"spec": {"company_profile_id": c.company_profile_id, "title": "x"}})
    except ValueError as exc:
        res_err = str(exc)
    assert res_err is not None and "invalid routine spec" in res_err
    assert store.list_team_routine_schedules() == []


def test_author_requires_approval_spec_refused_no_write_no_approval(store):
    # The critical "avoid double approval" contract: a spec the authoring helper marks
    # requires_approval (here: requested budget > max budget, needing a budget_override
    # grant) is REFUSED in the LOW dispatch — raised as ValueError, NOT routed to a
    # company HIGH approval — and nothing is persisted.
    c, ws, ag = _setup(store)
    spec = _spec(c.company_profile_id, ws.workspace_id, ag.profile_id)
    spec["governance"] = {"requested_budget_seconds": 600, "max_budget_seconds": 300}
    with pytest.raises(ValueError) as exc:
        _run(store, _operator(c.company_profile_id), {"spec": spec})
    assert "requires governance approval" in str(exc.value)
    assert store.list_team_routine_schedules() == []  # no schedule written
    # No company HIGH approval was created (refused, not routed to the approval gate).
    assert store.list_approvals() == []


def test_author_disabled_spec_is_persisted(store):
    # Intentional divergence from the old `team routine author` (which did not persist
    # a disabled routine): the company command persists ready AND disabled schedules,
    # so a chat operator can pre-author a routine in the off state. Lock it down.
    c, ws, ag = _setup(store)
    spec = _spec(c.company_profile_id, ws.workspace_id, ag.profile_id)
    spec["enabled"] = False
    res = _run(store, _operator(c.company_profile_id), {"spec": spec})
    assert res.outcome == "executed"
    schedules = store.list_team_routine_schedules()
    assert len(schedules) == 1
    assert schedules[0].enabled is False


def test_author_confined_denied(store):
    c, ws, ag = _setup(store)
    spec = _spec(c.company_profile_id, ws.workspace_id, ag.profile_id)
    conf = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, conf, {"spec": spec})


def test_author_cross_company_forbidden(store):
    a, ws, ag = _setup(store, name="Acme")
    b = store.save_company_profile(CompanyProfile(name="Beta", owner_id="u"))
    spec = _spec(b.company_profile_id, ws.workspace_id, ag.profile_id)  # targets B
    scoped_to_a = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, scoped_to_a, {"spec": spec})


def test_author_validation_fail_closed():
    # spec must be a non-empty mapping
    with pytest.raises(ValueError):
        AuthorRoutineCommand.from_dict({"spec": {}}).validate()
    # spec must name a company
    with pytest.raises(ValueError):
        AuthorRoutineCommand.from_dict({"spec": {"title": "x"}}).validate()
    # unknown field rejected
    with pytest.raises(ValueError):
        AuthorRoutineCommand.from_dict({"spec": {"company_profile_id": "c"}, "bogus": 1})


def _other_company_workspace_agent(store):
    b = store.save_company_profile(CompanyProfile(name="Beta", owner_id="u"))
    wsb = store.save_workspace_profile(WorkspaceProfile(name="wsB", company_profile_id=b.company_profile_id))
    agb = store.save_agent_profile(AgentProfile(name="agB", role="eng", company_profile_id=b.company_profile_id, workspace_id=wsb.workspace_id))
    return b, wsb, agb


def test_author_cross_company_workspace_ref_forbidden(store):
    # B8 nested-ref: a routine declaring company A but pinning a workspace in company B
    # is forbidden at the scope gate (same-origin), even for an admin — not deferred to
    # the authoring helper's 400.
    a, ws, ag = _setup(store)
    _b, wsb, _agb = _other_company_workspace_agent(store)
    admin = CompanyScope(
        principal_id="u", actor_company_id=a.company_profile_id,
        allowed_company_ids=frozenset({a.company_profile_id, _b.company_profile_id}), is_admin=True,
    )
    spec = _spec(a.company_profile_id, wsb.workspace_id, ag.profile_id)  # workspace in B
    with pytest.raises(CompanyScopeError):
        _run(store, admin, {"spec": spec})


def test_author_cross_company_agent_ref_forbidden(store):
    a, ws, ag = _setup(store)
    b, _wsb, agb = _other_company_workspace_agent(store)
    admin = CompanyScope(
        principal_id="u", actor_company_id=a.company_profile_id,
        allowed_company_ids=frozenset({a.company_profile_id, b.company_profile_id}), is_admin=True,
    )
    spec = _spec(a.company_profile_id, ws.workspace_id, agb.profile_id)  # agent in B
    with pytest.raises(CompanyScopeError):
        _run(store, admin, {"spec": spec})


def test_author_lifecycle_blocks_when_nested_company_frozen(store):
    # B5: every company the routine touches must be active. Freeze the company that owns
    # the referenced workspace/agent → the lifecycle gate refuses even if the routine's
    # own (declared) company is active.
    from superclaw.company_lifecycle import CompanyFrozenError, freeze_company_for_archive

    a, ws, ag = _setup(store)
    # Reference the same company for clarity, then freeze it.
    spec = _spec(a.company_profile_id, ws.workspace_id, ag.profile_id)
    freeze_company_for_archive(store, a.company_profile_id)
    with pytest.raises(CompanyFrozenError):
        _run(store, _operator(a.company_profile_id), {"spec": spec})


def test_lifecycle_target_set_includes_nested_company(store):
    # B5 contract門 point: _resolved_target_company_ids must include the workspace's
    # and agent's REAL companies, not just the routine's declared company. (Tested
    # directly because the scope gate's same-origin check rejects a cross-company
    # routine before lifecycle runs — so this is the only way to exercise the set.)
    from superclaw.company_handler import _resolved_target_company_ids
    from superclaw.company_scope import CompanyScope

    a, ws, ag = _setup(store)  # company A owns ws + ag
    b, wsb, agb = _other_company_workspace_agent(store)  # company B owns wsb + agb
    cmd = AuthorRoutineCommand(spec=_spec(a.company_profile_id, wsb.workspace_id, agb.profile_id))
    scope = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=True)
    targets = _resolved_target_company_ids(cmd, scope=scope, store=store)
    assert targets == {a.company_profile_id, b.company_profile_id}  # A (declared) + B (ws/agent)


def test_routine_spec_refs_extracts_nested():
    from superclaw.company_commands import routine_spec_refs

    r = routine_spec_refs({"company_profile_id": "c", "workspace_id": "w", "agent_profile_id": "a"})
    assert r == {"company_profile_id": "c", "workspace_id": "w", "agent_profile_id": "a"}
    r2 = routine_spec_refs({"references": {"company_profile_id": "c2", "workspace_id": "w2"}})
    assert r2["company_profile_id"] == "c2" and r2["workspace_id"] == "w2" and r2["agent_profile_id"] == ""


def test_company_extracted_from_references_too():
    from superclaw.company_commands import routine_spec_company_id

    assert routine_spec_company_id({"company_profile_id": "c1"}) == "c1"
    assert routine_spec_company_id({"references": {"company_profile_id": "c2"}}) == "c2"
    assert routine_spec_company_id({"title": "x"}) == ""
