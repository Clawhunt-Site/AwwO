"""Tests for the B-side schema lock: memberships, instance roles, cost money lane.

Phase 1d of the daemon pivot (docs/agent-team-kernel-daemon-pivot.md §4/§5):
schema decisions are locked now because adding them later means a data
migration. Humans and agents share one membership table (Paperclip principal
model); cost_cents/billing_lane ride the CostEvent payload.
"""

import pytest

from superclaw.models import AgentProfile, CompanyProfile, CostEvent
from superclaw.pricing import PRICE_TABLE_ENV, estimate_cost_cents
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- memberships -----------------------------------------------------------


def test_company_save_seeds_owner_membership(store):
    company = CompanyProfile(name="Acme", owner_id="local_user")
    store.save_company_profile(company)
    members = store.list_company_memberships(company_profile_id=company.company_profile_id)
    assert len(members) == 1
    assert members[0].principal_type == "user"
    assert members[0].principal_id == "local_user"
    assert members[0].membership_role == "owner"


def test_agent_save_seeds_agent_membership_idempotently(store):
    company = CompanyProfile(name="Acme")
    store.save_company_profile(company)
    profile = AgentProfile(name="Eng", role="engineer", company_profile_id=company.company_profile_id)
    store.save_agent_profile(profile)
    store.save_agent_profile(profile)  # re-save must not duplicate
    members = store.list_company_memberships(company_profile_id=company.company_profile_id)
    agent_rows = [m for m in members if m.principal_type == "agent"]
    assert len(agent_rows) == 1
    assert agent_rows[0].principal_id == profile.profile_id
    assert agent_rows[0].membership_role == "member"


def test_membership_seed_never_demotes_existing_role(store):
    company = CompanyProfile(name="Acme", owner_id="local_user")
    store.save_company_profile(company)
    # A later seed with a weaker role must not overwrite the owner row.
    again = store.ensure_company_membership(
        company.company_profile_id, "user", "local_user", membership_role="member"
    )
    assert again.membership_role == "owner"


def test_membership_listing_by_principal(store):
    a = CompanyProfile(name="A")
    b = CompanyProfile(name="B")
    store.save_company_profile(a)
    store.save_company_profile(b)
    mine = store.list_company_memberships(principal_id="local_user")
    assert {m.company_profile_id for m in mine} == {a.company_profile_id, b.company_profile_id}


def test_instance_root_role_seeded(store):
    roles = store.list_instance_user_roles(user_id="local_user")
    assert [r.role for r in roles] == ["instance_admin"]


# --- money lane (cost_cents / billing_lane) ---------------------------------


def test_cost_event_money_fields_round_trip(store):
    event = CostEvent(
        idempotency_key="k1",
        run_id="run_1",
        cost_cents=42,
        billing_lane="relay",
    )
    assert store.record_cost_event(event) is True
    stored = store.list_cost_events(run_id="run_1")[0]
    assert stored.cost_cents == 42
    assert stored.billing_lane == "relay"


def test_cost_summary_rolls_up_money_lanes(store):
    store.record_cost_event(
        CostEvent(idempotency_key="k1", run_id="r", cost_cents=100, billing_lane="relay", input_tokens=10, output_tokens=5)
    )
    store.record_cost_event(CostEvent(idempotency_key="k2", run_id="r", cost_cents=7, billing_lane="byo"))
    summary = store.summarize_cost(run_id="r")
    assert summary["total_cost_cents"] == 107
    # Lanes never blend silently: relay = authoritative receipts, byo = estimates.
    assert summary["by_billing_lane"]["relay"] == {"events": 1, "cost_cents": 100, "total_tokens": 15}
    assert summary["by_billing_lane"]["byo"]["cost_cents"] == 7


def test_cost_event_old_payload_defaults_to_byo_zero():
    # Pre-1d payloads carry no money fields — tolerant from_dict keeps them
    # readable with the honest defaults (0 cents, byo lane).
    old = {"idempotency_key": "k0", "run_id": "r0"}
    event = CostEvent.from_dict(old)
    assert event.cost_cents == 0
    assert event.billing_lane == "byo"


# --- pricing (byo reference estimates) --------------------------------------


def test_estimate_uses_configured_table():
    env = {
        PRICE_TABLE_ENV: (
            '{"model-x": {"input_cents_per_mtok": 1000,'
            ' "output_cents_per_mtok": 5000,'
            ' "cached_input_cents_per_mtok": 100}}'
        )
    }
    cents = estimate_cost_cents(
        "model-x",
        input_tokens=2_000_000,
        output_tokens=1_000_000,
        cached_input_tokens=1_000_000,
        env=env,
    )
    # 1M fresh input @1000 + 1M cached @100 + 1M output @5000 = 6100
    assert cents == 6100


def test_estimate_unknown_model_returns_none_not_zero():
    env = {PRICE_TABLE_ENV: '{"model-x": {"input_cents_per_mtok": 1}}'}
    assert estimate_cost_cents("model-y", input_tokens=10, env=env) is None
    assert estimate_cost_cents(None, input_tokens=10, env=env) is None


def test_estimate_fails_open_on_malformed_table():
    env = {PRICE_TABLE_ENV: "{not json"}
    assert estimate_cost_cents("model-x", input_tokens=10, env=env) is None


def test_estimate_without_table_returns_none():
    assert estimate_cost_cents("model-x", input_tokens=10, env={}) is None
