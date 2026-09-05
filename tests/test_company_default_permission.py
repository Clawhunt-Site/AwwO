"""Company agents default to the max-permission runtime posture (doctrine).

A governed company agent with no explicit permission policy must default to
``bypassPermissions`` so it can actually act (hire, delegate, run tools), while
the daemon's fail-closed ``plan`` floor stays UNCHANGED for everything else —
config loss / non-company / unknown-company never silently escalates to max.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.models import CompanyProfile
from superclaw.state import StateStore
from superclaw.team_templates import build_bootstrap_proposal


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store) -> str:
    return store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id


def test_company_hire_with_no_policy_defaults_to_bypass(store):
    cid = _company(store)
    agent = team_kernel.create_agent_from_spec(
        store, {"name": "Eng", "role": "engineer", "company_profile_id": cid}, requested_by="op"
    )
    assert agent.permission_policy == {"mode": "bypassPermissions"}


def test_explicit_policy_on_company_hire_still_wins(store):
    cid = _company(store)
    agent = team_kernel.create_agent_from_spec(
        store,
        {
            "name": "Reader",
            "role": "analyst",
            "company_profile_id": cid,
            "permission_policy": {"mode": "plan"},
        },
        requested_by="op",
    )
    # A deliberately read-only role stays read-only — the default never overrides it.
    assert agent.permission_policy == {"mode": "plan"}


def test_local_hire_does_not_get_max(store):
    # No company (home "local") — stays empty so the daemon floor keeps it read-only.
    agent = team_kernel.create_agent_from_spec(
        store, {"name": "Solo", "role": "helper"}, requested_by="op"
    )
    assert agent.permission_policy == {}


def test_unknown_company_id_does_not_get_max(store):
    # A non-persisted / crafted company id is NOT a governed company → no escalation.
    assert team_kernel._is_governed_company_id(store, "company_does_not_exist") is False
    with pytest.raises(ValueError, match="unknown company"):
        team_kernel.create_agent_from_spec(
            store,
            {"name": "Ghost", "role": "x", "company_profile_id": "company_does_not_exist"},
            requested_by="op",
        )


def test_is_governed_company_id_positive_check(store):
    cid = _company(store)
    assert team_kernel._is_governed_company_id(store, cid) is True
    assert team_kernel._is_governed_company_id(store, "local") is False
    assert team_kernel._is_governed_company_id(store, "") is False
    assert team_kernel._is_governed_company_id(store, None) is False
    assert team_kernel._is_governed_company_id(store, "company_nope") is False


def test_template_company_role_defaults_to_bypass():
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": "co_tmpl", "name": "Acme"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [{"id": "ceo", "name": "CEO", "role": "ceo", "charter": "Lead"}],
    }
    proposal = build_bootstrap_proposal(spec)
    assert not proposal.blocked
    ceo = next(a for a in proposal.would_create["agent_profiles"] if a["role"] == "ceo")
    assert ceo["permission_policy"] == {"mode": "bypassPermissions"}


def test_template_explicit_role_policy_wins():
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": "co_tmpl", "name": "Acme"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [
            {"id": "ceo", "name": "CEO", "role": "ceo", "charter": "Lead",
             "permission_policy": {"mode": "plan"}},
        ],
    }
    proposal = build_bootstrap_proposal(spec)
    ceo = next(a for a in proposal.would_create["agent_profiles"] if a["role"] == "ceo")
    assert ceo["permission_policy"] == {"mode": "plan"}
