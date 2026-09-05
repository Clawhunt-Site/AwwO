"""API parity for governed ClawHunt marketplace participation (P2).

The handler/saga logic is covered in test_marketplace_handler.py / _saga.py; here
we verify the REST surface routes the SAME execute_marketplace_command / saga path
(CLAUDE.md 铁律: zero drift), injects a server operator scope, and maps outcomes /
errors to HTTP. Uses a fake ClawHuntClient so no network is touched.
"""

import pytest
from fastapi.testclient import TestClient

from superclaw import marketplace_handler
from apps.api.main import create_app
from superclaw.models import CompanyProfile, MarketplaceOrder, MarketplaceOrderStatus
from superclaw.state import StateStore


class _Settings:
    def __init__(self, agent_api_key="cph_test", base_url="https://clawhunt.test"):
        self.agent_api_key = agent_api_key
        self.base_url = base_url


class FakeClient:
    def __init__(self, agent_api_key="cph_test"):
        self.settings = _Settings(agent_api_key)

    def browse(self, *, skip=0, limit=50, status=None):
        return {"ok": True, "status_code": 200, "body": {"problems": [{"id": 1}, {"id": 2}]}}


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setattr(marketplace_handler, "_default_client_factory", lambda: FakeClient())
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    company = CompanyProfile(name="Acme")
    store.save_company_profile(company)
    app = create_app(state_path=state_path)
    return TestClient(app), store, company


def test_browse_command_executes(ctx):
    client, _store, company = ctx
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.browse",
        "payload": {"status": "open", "limit": 10},
        "actor_company_id": company.company_profile_id,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "executed"
    assert body["detail"]["count"] == 2


def test_no_agent_key_is_409(ctx, monkeypatch):
    client, _store, company = ctx
    monkeypatch.setattr(marketplace_handler, "_default_client_factory",
                        lambda: FakeClient(agent_api_key=None))
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.browse", "payload": {},
        "actor_company_id": company.company_profile_id,
    })
    assert r.status_code == 409


def test_unknown_command_type_422(ctx):
    client, _store, company = ctx
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.nope", "payload": {},
        "actor_company_id": company.company_profile_id,
    })
    assert r.status_code == 422


def test_claim_returns_pending_approval_and_creates_order(ctx):
    client, store, company = ctx
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.claim",
        "payload": {"problem_id": "42", "company_profile_id": company.company_profile_id},
        "actor_company_id": company.company_profile_id,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "pending_approval"
    order_id = body["detail"]["order_id"]
    # the ledger really holds the reserved order
    listed = client.get("/api/marketplace/orders").json()
    assert any(o["order_id"] == order_id for o in listed["orders"])
    detail = client.get(f"/api/marketplace/orders/{order_id}").json()
    assert detail["status"] == "claim_approval_pending"


def test_unknown_order_detail_404(ctx):
    client, _store, _company = ctx
    assert client.get("/api/marketplace/orders/order_nope").status_code == 404


def test_advance_no_agent_blocks_and_returns_hint(ctx):
    client, store, company = ctx
    # a claimed order whose company has no agent → advance blocks (no run started)
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
    )
    store.create_marketplace_order(order)
    r = client.post("/api/marketplace/orders/advance", json={"order_id": order.order_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "blocked"
    # zero-drift with the CLI: the advance response carries the same next-step hint
    assert body["hint"]


def test_buyer_side_command_rejected(ctx):
    """The API must not expose buyer-side accept/accept_bid (no governed CLI parity)
    — zero-new-surface-semantics."""
    client, _store, company = ctx
    for ct in ("marketplace.accept", "marketplace.accept_bid"):
        r = client.post("/api/marketplace/commands", json={
            "command_type": ct, "payload": {"problem_id": "1", "bid_id": "2"},
            "actor_company_id": company.company_profile_id,
        })
        assert r.status_code == 422, (ct, r.text)


def test_envelope_extra_forbid(ctx):
    client, _store, company = ctx
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.browse", "payload": {},
        "actor_company_id": company.company_profile_id, "is_admin": True,
    })
    assert r.status_code == 422  # stray top-level key rejected by the envelope


def test_payload_unknown_field_rejected(ctx):
    client, _store, company = ctx
    r = client.post("/api/marketplace/commands", json={
        "command_type": "marketplace.claim",
        "payload": {"problem_id": "1", "company_profile_id": company.company_profile_id, "evil": 1},
        "actor_company_id": company.company_profile_id,
    })
    assert r.status_code == 422  # from_dict rejects unknown command field


def test_advance_value_error_maps_to_422(ctx, monkeypatch):
    """A saga ValueError (e.g. bad precondition) maps to 422, not a bare 500."""
    client, store, company = ctx
    order = MarketplaceOrder(
        problem_id="42", base_url="https://clawhunt.test",
        company_profile_id=company.company_profile_id,
        status=MarketplaceOrderStatus.CLAIMED_REMOTE.value,
    )
    store.create_marketplace_order(order)

    import superclaw.marketplace_saga as saga

    def _boom(*a, **k):
        raise ValueError("bad precondition")

    monkeypatch.setattr(saga, "advance_marketplace_order", _boom)
    r = client.post("/api/marketplace/orders/advance", json={"order_id": order.order_id})
    assert r.status_code == 422
