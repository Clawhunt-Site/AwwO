"""CLI parity for governed ClawHunt marketplace participation (`superclaw marketplace ...`).

The handler/ledger logic is covered in test_marketplace_handler.py; here we verify
the CLI surface routes the SAME ``execute_marketplace_command`` path (CLAUDE.md
铁律: CLI single source of truth, zero drift) — reads run through, writes pend an
approval + persist a ledger order, and the no-agent-key path fails closed with a
friendly message + non-zero exit.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw import marketplace_handler
from superclaw.cli import app
from superclaw.state import StateStore


class _Settings:
    def __init__(self, agent_api_key, base_url="https://clawhunt.test"):
        self.agent_api_key = agent_api_key
        self.base_url = base_url


class FakeClient:
    def __init__(self, agent_api_key="cph_test"):
        self.settings = _Settings(agent_api_key)

    def browse(self, *, skip=0, limit=50, status=None):
        return {"ok": True, "status_code": 200, "body": {"problems": [{"id": 1}, {"id": 2}]}}


@pytest.fixture
def state_path(tmp_path, monkeypatch):
    p = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(p))
    return p


def _invoke(args):
    return CliRunner().invoke(app, args)


def _connect_fake(monkeypatch, *, agent_api_key="cph_test"):
    monkeypatch.setattr(
        marketplace_handler, "_default_client_factory", lambda: FakeClient(agent_api_key)
    )


def test_browse_requires_connected_key(state_path, monkeypatch):
    _connect_fake(monkeypatch, agent_api_key=None)
    result = _invoke(["marketplace", "browse"])
    assert result.exit_code != 0
    assert "not connected" in result.output.lower()


def test_browse_runs_when_connected(state_path, monkeypatch):
    _connect_fake(monkeypatch)
    result = _invoke(["marketplace", "browse", "--status", "open", "--limit", "5"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "executed"
    assert payload["detail"]["count"] == 2


def test_claim_creates_order_and_pends_approval(state_path, monkeypatch):
    _connect_fake(monkeypatch)
    # a company to own the delivery
    created = _invoke(["company", "create", "--name", "Acme"])
    company_id = json.loads(created.output)["detail"]["company_profile_id"]

    result = _invoke(["marketplace", "claim", "42", "--company", company_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "pending_approval"
    order_id = payload["detail"]["order_id"]

    # the ledger really holds the reserved order
    order = StateStore(state_path).get_marketplace_order(order_id)
    assert order.company_profile_id == company_id
    assert order.status == "claim_approval_pending"

    # and it shows up in `marketplace orders`
    listed = _invoke(["marketplace", "orders"])
    assert listed.exit_code == 0
    orders = json.loads(listed.output)
    assert any(o["order_id"] == order_id for o in orders["orders"])


def test_claim_unknown_company_fails_closed(state_path, monkeypatch):
    _connect_fake(monkeypatch)
    result = _invoke(["marketplace", "claim", "42", "--company", "company_does_not_exist"])
    assert result.exit_code != 0
    assert "unknown id" in result.output.lower()


def test_legacy_clawhunt_claim_disabled_by_default(state_path, monkeypatch):
    """The legacy direct-write `clawhunt claim` is fail-closed disabled by default
    (governed `marketplace claim` is authoritative); it errors pointing there."""
    monkeypatch.delenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", raising=False)
    result = _invoke(["clawhunt", "claim", "42"])
    assert result.exit_code != 0
    assert "marketplace claim" in result.output


def test_legacy_clawhunt_buyer_side_disabled_by_default(state_path, monkeypatch):
    """Buyer/payment-side legacy writes (accept/accept-bid) are also fail-closed
    disabled by default (支付永不默认路径) — and the remote client is NEVER reached
    (the gate fires before any client call)."""
    monkeypatch.delenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", raising=False)
    calls = []

    class _C:
        settings = type("S", (), {"agent_api_key": "cph", "base_url": "https://x"})()

        def accept(self, *a, **k):
            calls.append("accept")
            return {"ok": True, "status_code": 200, "body": {}}

        def accept_bid(self, *a, **k):
            calls.append("accept_bid")
            return {"ok": True, "status_code": 200, "body": {}}

    monkeypatch.setattr("superclaw.cli.ClawHuntClient", lambda *a, **k: _C())
    for args in (["clawhunt", "accept", "7"], ["clawhunt", "accept-bid", "7", "3"]):
        result = _invoke(args)
        assert result.exit_code != 0, args
    assert calls == []  # the gate blocked before any remote call


def test_legacy_clawhunt_claim_override_opt_in(state_path, monkeypatch):
    """With the explicit operator opt-in, the legacy command runs (raw passthrough)."""
    monkeypatch.setenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", "1")

    class _C:
        settings = type("S", (), {"agent_api_key": "cph", "base_url": "https://x"})()

        def claim(self, pid):
            return {"ok": True, "status_code": 200, "body": {"claimed": pid}}

    monkeypatch.setattr("superclaw.cli.ClawHuntClient", lambda *a, **k: _C())
    result = _invoke(["clawhunt", "claim", "42"])
    assert result.exit_code == 0
