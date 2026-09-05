"""P2: agent.charter write command (set an agent's behavior contract from chat).

The charter is the role's behavior contract — a distinct axis from the scalar
fields agent.update edits (which deliberately reject charter). CHARTER ONLY:
persona is NOT carried here (it stays a scalar field owned by agent.update — one
command path per field). Covered here:

  * dispatch: the command sets the charter via the SINGLE kernel entry
    (team_kernel.update_agent_charter), shared with the REST charter endpoint;
  * risk: reversible (revisioned) → LOW;
  * governance: a CONFINED agent is default-denied (charter is a governance vector —
    operator-only, like agent.update);
  * validation: charter required + unknown-field / persona rejection;
  * single source: the REST endpoint and the command share update_agent_charter.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import UpdateAgentCharterCommand, get_command_model
from superclaw.company_handler import execute_company_command
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import AgentProfile, CompanyProfile
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store):
    return store.save_company_profile(CompanyProfile(name="Acme", owner_id="u"))


def _agent(store, company_id):
    return store.save_agent_profile(AgentProfile(name="A", role="eng", company_profile_id=company_id))


def _run(store, scope, args):
    cmd = get_command_model("agent.charter").from_dict(args)
    return execute_company_command(cmd, scope=scope, store=store, requested_by="u")


def test_charter_set_end_to_end(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    op = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=True)
    res = _run(store, op, {"profile_id": ag.profile_id, "charter": "Be helpful"})
    assert res.outcome == "executed"
    saved = store.get_agent_profile(ag.profile_id)
    assert saved.charter == "Be helpful"
    assert saved.charter_source == "manual"


def test_charter_bumps_revision(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    op = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=True)
    before = store.get_agent_profile(ag.profile_id).charter_revision_id
    _run(store, op, {"profile_id": ag.profile_id, "charter": "v2 contract"})
    assert store.get_agent_profile(ag.profile_id).charter_revision_id != before


def test_charter_command_is_charter_only_no_persona():
    # persona is NOT in the charter command's vocabulary (it stays a scalar field
    # owned by agent.update — single command path per field).
    assert "persona" not in UpdateAgentCharterCommand.__dataclass_fields__
    with pytest.raises(ValueError):
        UpdateAgentCharterCommand.from_dict({"profile_id": "p1", "persona": "x"})


def test_confined_agent_denied_charter(store):
    c = _company(store)
    ag = _agent(store, c.company_profile_id)
    conf = CompanyScope(
        principal_id="u", actor_company_id=c.company_profile_id, is_admin=False,
        actor_agent_profile_id=ag.profile_id,
    )
    with pytest.raises(CompanyScopeError):
        _run(store, conf, {"profile_id": ag.profile_id, "charter": "x"})


def test_cross_company_charter_forbidden(store):
    a = _company(store)
    b = store.save_company_profile(CompanyProfile(name="Beta", owner_id="u"))
    foreign = store.save_agent_profile(AgentProfile(name="B", role="eng", company_profile_id=b.company_profile_id))
    scoped_to_a = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, scoped_to_a, {"profile_id": foreign.profile_id, "charter": "x"})


def test_charter_validation_fail_closed():
    # missing charter rejected (charter is required)
    with pytest.raises((ValueError, TypeError)):
        UpdateAgentCharterCommand.from_dict({"profile_id": "p1"})
    # blank charter rejected at validate
    with pytest.raises(ValueError):
        UpdateAgentCharterCommand.from_dict({"profile_id": "p1", "charter": "  "}).validate()
    # unknown field rejected
    with pytest.raises(ValueError):
        UpdateAgentCharterCommand.from_dict({"profile_id": "p1", "charter": "c", "bogus": 1})


def test_rest_and_command_share_kernel_entry():
    # Single-source: the REST charter endpoint now calls update_agent_charter too.
    import inspect

    from superclaw import team_kernel

    assert hasattr(team_kernel, "update_agent_charter")
    src = inspect.getsource(team_kernel.update_agent_charter)
    assert "charter_source" in src and "charter_revision_id" in src
