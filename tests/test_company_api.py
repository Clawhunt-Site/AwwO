"""REST parity for chat-driven company management (`POST /api/team/companies/commands`).

This endpoint is a THIN projection of ``company_handler.execute_company_command``
— the SAME kernel entry the CLI (`superclaw company ...`) and the chat tool
projection use (CLAUDE.md 铁律: CLI is the single source of truth, zero drift).
These tests prove the REST layer faithfully (1) builds the typed command from
``command_type`` + ``payload``, (2) injects a SERVER-side admin operator scope
(authority never read from the body), (3) dispatches, and (4) maps the handler's
outcome / typed errors onto HTTP exactly as the CLI maps them onto JSON/exit
codes.
"""

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import AgentProfile, CompanyProfile, Issue
from superclaw.state import StateStore


def _client(tmp_path):
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _store(tmp_path) -> StateStore:
    return StateStore(tmp_path / "state.db")


def _command(client, command_type, payload, actor_company_id="local"):
    return client.post(
        "/api/team/companies/commands",
        json={
            "command_type": command_type,
            "payload": payload,
            "actor_company_id": actor_company_id,
        },
    )


# --- P2 write parity: agent.charter / work_product.update via /commands -----


def test_api_agent_charter_via_commands(tmp_path):
    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "C"}).json()["detail"]["company_profile_id"]
    profile_id = _command(
        client, "agent.hire",
        {"spec": {"name": "Eng", "role": "engineer", "company_profile_id": company_id}},
        actor_company_id=company_id,
    ).json()["detail"]["profile_id"]
    res = _command(
        client, "agent.charter", {"profile_id": profile_id, "charter": "Be precise"},
        actor_company_id=company_id,
    )
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "executed"
    assert _store(tmp_path).get_agent_profile(profile_id).charter == "Be precise"


def test_api_work_product_update_via_commands(tmp_path):
    from superclaw.models import Issue, WorkProduct

    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "C"}).json()["detail"]["company_profile_id"]
    store = _store(tmp_path)
    iss = store.save_issue(Issue(title="T", company_profile_id=company_id))
    wp = store.save_work_product(WorkProduct(issue_id=iss.issue_id, company_profile_id=company_id, title="PR", status="open"))
    res = _command(
        client, "work_product.update", {"work_product_id": wp.work_product_id, "status": "merged"},
        actor_company_id=company_id,
    )
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "executed"
    assert _store(tmp_path).get_work_product(wp.work_product_id).status == "merged"


# --- read: snapshot parity (roadmap P0) ------------------------------------


def test_api_company_snapshot_returns_dto(tmp_path):
    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "SnapCo"}).json()["detail"][
        "company_profile_id"
    ]
    _command(
        client, "issue.create", {"title": "work"}, actor_company_id=company_id
    )
    res = client.get(f"/api/team/companies/{company_id}/snapshot")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["company"]["company_profile_id"] == company_id
    assert body["issues"]["issue_total"] == 1
    assert set(body["cost"]) == {"total_cost_cents", "total_tokens", "event_count"}


def test_api_company_snapshot_unknown_is_404(tmp_path):
    client = _client(tmp_path)
    res = client.get("/api/team/companies/nope/snapshot")
    assert res.status_code == 404


# --- happy paths -----------------------------------------------------------


def test_api_company_create_executed(tmp_path):
    client = _client(tmp_path)
    res = _command(client, "company.create", {"name": "Acme", "goal": "Ship."})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["outcome"] == "executed"
    company_id = body["detail"]["company_profile_id"]
    # The company really exists; owner is the server-injected operator.
    company = _store(tmp_path).get_company_profile(company_id)
    assert company.name == "Acme"
    assert company.owner_id == "api_operator"


def test_api_company_hire_executed(tmp_path):
    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "HireCo"}).json()["detail"][
        "company_profile_id"
    ]
    res = _command(
        client,
        "agent.hire",
        {"spec": {"name": "Eng", "role": "engineer", "company_profile_id": company_id}},
        actor_company_id=company_id,
    )
    assert res.status_code == 200, res.text
    profile_id = res.json()["detail"]["profile_id"]
    profile = _store(tmp_path).get_agent_profile(profile_id)
    assert profile.role == "engineer"
    assert profile.company_profile_id == company_id


def test_api_company_create_assign_delegate_issue(tmp_path):
    client = _client(tmp_path)
    store = _store(tmp_path)
    company_id = _command(client, "company.create", {"name": "IssueCo"}).json()["detail"][
        "company_profile_id"
    ]
    profile_id = _command(
        client,
        "agent.hire",
        {"spec": {"name": "Dev", "role": "engineer", "company_profile_id": company_id}},
        actor_company_id=company_id,
    ).json()["detail"]["profile_id"]

    parent_id = _command(
        client, "issue.create", {"title": "Parent"}, actor_company_id=company_id
    ).json()["detail"]["issue_id"]
    assert store.get_issue(parent_id).title == "Parent"

    assign = _command(
        client,
        "issue.assign",
        {"issue_id": parent_id, "profile_id": profile_id},
        actor_company_id=company_id,
    )
    assert assign.status_code == 200, assign.text
    assert _store(tmp_path).get_issue(parent_id).assignee_agent_profile_id == profile_id

    delegate = _command(
        client,
        "issue.delegate",
        {
            "parent_id": parent_id,
            "assignee_agent_profile_id": profile_id,
            "title": "Child",
        },
        actor_company_id=company_id,
    )
    assert delegate.status_code == 200, delegate.text
    child_id = delegate.json()["detail"]["issue_id"]
    assert _store(tmp_path).get_issue(child_id).parent_id == parent_id


def test_api_company_archive_pending_approval(tmp_path):
    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "ArchiveCo"}).json()["detail"][
        "company_profile_id"
    ]
    res = _command(
        client,
        "company.archive",
        {"company_profile_id": company_id, "reason": "done"},
        actor_company_id=company_id,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["outcome"] == "pending_approval"
    approval_id = body["approval_id"]
    assert approval_id
    assert "/api/team/approvals/" in body["hint"]

    store = _store(tmp_path)
    assert store.get_approval(approval_id).status == "pending"
    # Two-phase archive froze (not dissolved) the company.
    assert store.get_company_profile(company_id).status != "active"

    # The hinted approval gate really dissolves it (same shared approval system).
    grant = client.post(f"/api/team/approvals/{approval_id}/grant", json={"by": "leon"})
    assert grant.status_code == 200, grant.text
    assert _store(tmp_path).get_company_profile(company_id).status == "dissolved"


# --- error mapping ---------------------------------------------------------


def test_api_unknown_command_type_422(tmp_path):
    client = _client(tmp_path)
    res = _command(client, "company.nope", {"name": "X"})
    assert res.status_code == 422
    assert "unknown company command type" in res.json()["detail"]


def test_api_unknown_payload_field_422(tmp_path):
    client = _client(tmp_path)
    res = _command(client, "company.create", {"name": "X", "bogus": 1})
    assert res.status_code == 422
    assert "unknown field" in res.json()["detail"].lower()


def test_api_unknown_top_level_envelope_field_422(tmp_path):
    """The envelope is fail-closed: a stray top-level key (e.g. an attempted
    ``is_admin`` privilege injection) is rejected by ``extra="forbid"`` rather
    than silently dropped — authority is never body-supplied."""
    client = _client(tmp_path)
    res = client.post(
        "/api/team/companies/commands",
        json={
            "command_type": "company.create",
            "payload": {"name": "X"},
            "actor_company_id": "local",
            "is_admin": True,
        },
    )
    assert res.status_code == 422


def test_api_validation_error_422(tmp_path):
    """An empty patch fails the command model's stateless validate() → 422."""
    client = _client(tmp_path)
    company_id = _command(client, "company.create", {"name": "ValCo"}).json()["detail"][
        "company_profile_id"
    ]
    res = _command(
        client,
        "company.update",
        {"company_profile_id": company_id},
        actor_company_id=company_id,
    )
    assert res.status_code == 422
    assert "empty patch" in res.json()["detail"].lower()


def test_api_unknown_id_404(tmp_path):
    client = _client(tmp_path)
    res = _command(
        client, "company.update", {"company_profile_id": "company_nope", "name": "X"}
    )
    assert res.status_code == 404
    assert "unknown id" in res.json()["detail"].lower()


def test_api_cross_company_nested_ref_403(tmp_path):
    """Assigning a company-A issue to a company-B agent is a same-origin breach."""
    # Seed two companies + an issue in A and an agent in B directly in the store
    # the app reads from.
    store = _store(tmp_path)
    store.save_company_profile(CompanyProfile(name="A", company_profile_id="company_a"))
    store.save_company_profile(CompanyProfile(name="B", company_profile_id="company_b"))
    issue_a = store.save_issue(Issue(title="A-issue", company_profile_id="company_a"))
    agent_b = store.save_agent_profile(
        AgentProfile(name="Bob", role="engineer", company_profile_id="company_b")
    )

    client = _client(tmp_path)
    res = _command(
        client,
        "issue.assign",
        {"issue_id": issue_a.issue_id, "profile_id": agent_b.profile_id},
        actor_company_id="company_a",
    )
    assert res.status_code == 403, res.text
    assert "same-origin" in res.json()["detail"] or "scope" in res.json()["detail"]


def test_api_frozen_target_409(tmp_path):
    """A command targeting a frozen company is a lifecycle conflict (409)."""
    store = _store(tmp_path)
    store.save_company_profile(CompanyProfile(name="Frozen", company_profile_id="company_frz"))

    client = _client(tmp_path)
    # First archive freezes it (phase 1) and opens a pending approval.
    first = _command(
        client,
        "company.archive",
        {"company_profile_id": "company_frz"},
        actor_company_id="company_frz",
    )
    assert first.status_code == 200, first.text
    assert first.json()["outcome"] == "pending_approval"

    # Now updating the (frozen) company must conflict, not run.
    res = _command(
        client,
        "company.update",
        {"company_profile_id": "company_frz", "name": "Renamed"},
        actor_company_id="company_frz",
    )
    assert res.status_code == 409, res.text


# --- security: authority is server-injected, never from the body -----------


def test_api_body_cannot_smuggle_authority(tmp_path):
    """is_admin / principal_id in the payload are rejected as unknown fields.

    The command model's from_dict is fail-closed, so an attempt to smuggle
    authority through the command payload is refused outright (422) — it can never
    reach the scope, which is fixed server-side regardless.
    """
    client = _client(tmp_path)
    res = _command(
        client,
        "company.create",
        {"name": "Sneaky", "is_admin": True, "principal_id": "root"},
    )
    assert res.status_code == 422
    detail = res.json()["detail"].lower()
    assert "unknown field" in detail


def test_api_owner_is_always_the_server_operator(tmp_path):
    """Even an owner_id in the payload does not become the company owner.

    owner_id IS a known CompanyCreateCommand field (recorded for reference), but
    the handler sets the company's owner to the server-injected principal, so the
    body can never make itself the owner.
    """
    client = _client(tmp_path)
    res = _command(client, "company.create", {"name": "OwnCo", "owner_id": "attacker"})
    assert res.status_code == 200, res.text
    company_id = res.json()["detail"]["company_profile_id"]
    assert _store(tmp_path).get_company_profile(company_id).owner_id == "api_operator"
