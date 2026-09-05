"""API surface tests for the escalation approval queue (Direction 4 P1 D2).

These prove ``/api/escalations`` is a faithful transport over the SAME StateStore
the ``superclaw escalation`` CLI drives:

* the queue defaults to ``pending`` (same scope as the CLI), never leaks HMAC
  material, and reports ``pending_count`` for a surface badge;
* respond is fail-closed and delegates to ``store.resolve_escalation``; the
  responder principal is derived SERVER-SIDE (never from the request body), so a
  caller can only act as the instance operator and cannot impersonate the bound
  principal — an escalation bound to a different principal is refused;
* a successful respond produces the durable ``escalation.resolved`` lifecycle event
  via the kernel (the single emit point shared by CLI and REST).
"""

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.escalation import make_permission_escalation

# Deterministic ticket key (>=16 bytes) so mint + the app's verify share a key
# without touching the instance secrets store.
_TICKET_KEY = "escalation-api-test-key-0123456789"


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", _TICKET_KEY)
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _seed_pending(
    client,
    *,
    run_id="run-1",
    principal="local_user",
    tool_name="run_shell",
    args=None,
    prompt="Allow shell `ls`?",
):
    env = make_permission_escalation(
        tool_name=tool_name,
        args=args if args is not None else {"cmd": "ls"},
        prompt_text=prompt,
        principal=principal,
        run_id=run_id,
    )
    client.app.state.store.create_escalation(env)
    return env


def test_list_returns_pending_queue_without_hmac(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client)
    resp = client.get("/api/escalations")
    assert resp.status_code == 200
    body = resp.json()
    assert body["pending_count"] == 1
    assert len(body["escalations"]) == 1
    summary = body["escalations"][0]
    assert summary["request_id"] == env.request_id
    assert summary["status"] == "pending"
    assert summary["tool_name"] == "run_shell"
    # HMAC material is an authorization internal — never on the wire.
    for secret in ("signature", "grant_signature", "nonce"):
        assert secret not in summary
    opt_ids = {o["id"] for o in summary["options"]}
    assert opt_ids == {"approve", "deny"}
    assert all("style" in o and "grants" in o for o in summary["options"])


def test_list_default_is_pending_matching_cli(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    keep = _seed_pending(client, run_id="run-keep")
    resolved = _seed_pending(client, run_id="run-resolved")
    # Deny one so it leaves the pending queue.
    assert (
        client.post(
            f"/api/escalations/{resolved.request_id}/respond",
            json={"decision": "deny"},
        ).status_code
        == 200
    )
    # Default (no status) mirrors the CLI's `--status pending`: only the open one.
    default = client.get("/api/escalations").json()
    assert [s["request_id"] for s in default["escalations"]] == [keep.request_id]
    assert default["pending_count"] == 1
    # status=all reveals the full history.
    everything = client.get("/api/escalations", params={"status": "all"}).json()
    ids = {s["request_id"] for s in everything["escalations"]}
    assert ids == {keep.request_id, resolved.request_id}
    assert everything["pending_count"] == 1


def test_list_status_filter_keeps_pending_count(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    _seed_pending(client)
    resp = client.get("/api/escalations", params={"status": "approved"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalations"] == []  # none approved
    assert body["pending_count"] == 1  # badge still counts the pending one


def test_get_detail_reports_signature_valid(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client)
    resp = client.get(f"/api/escalations/{env.request_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["signature_valid"] is True
    assert body["request_id"] == env.request_id
    for secret in ("signature", "grant_signature", "nonce"):
        assert secret not in body


def test_get_unknown_returns_404(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.get("/api/escalations/esc_does_not_exist")
    assert resp.status_code == 404


def test_respond_approve_transitions_and_emits_resolved(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client, run_id="run-approve")
    resp = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "approve"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"
    assert resp.json()["decision"] == "approve"
    store = client.app.state.store
    stored = store.get_escalation(env.request_id)
    assert stored.status == "approved"
    assert stored.grant_signature  # approval attestation minted by the kernel
    assert stored.approver == "local_user"  # server-derived operator, not a body value
    # escalation.resolved landed on the run's durable channel (kernel single emit).
    types = [e["type"] for e in store.list_events("run-approve")]
    assert "escalation.resolved" in types
    # Re-responding to an already-resolved (non-pending) record is refused.
    again = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "approve"},
    )
    assert again.status_code == 409


def test_respond_deny_sets_denied(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client)
    resp = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "deny"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"


def test_respond_non_operator_principal_refused_no_mutation(tmp_path, monkeypatch):
    # An escalation bound to a principal that is NOT this instance's operator cannot
    # be approved over REST: the responder identity is server-derived (local_user),
    # so the kernel's principal binding refuses it. The client has no way to assert
    # the bound principal.
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client, principal="alice")
    resp = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "approve"},
    )
    assert resp.status_code == 409
    stored = client.app.state.store.get_escalation(env.request_id)
    assert stored.status == "pending"  # fail-closed: no mutation
    assert stored.decision is None


def test_respond_uses_configured_operator_principal(tmp_path, monkeypatch):
    # With the instance operator configured to "alice", an alice-bound escalation
    # resolves — proving the responder principal comes from server config, not the
    # request body.
    monkeypatch.setenv("SUPERCLAW_OPERATOR_PRINCIPAL", "alice")
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client, principal="alice")
    resp = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "approve"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"
    assert client.app.state.store.get_escalation(env.request_id).approver == "alice"


def test_respond_unknown_option_refused(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    env = _seed_pending(client)
    resp = client.post(
        f"/api/escalations/{env.request_id}/respond",
        json={"decision": "bogus"},
    )
    assert resp.status_code == 409
    assert client.app.state.store.get_escalation(env.request_id).status == "pending"


def test_respond_unknown_escalation_404(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.post(
        "/api/escalations/esc_missing/respond",
        json={"decision": "approve"},
    )
    assert resp.status_code == 404


def test_endpoints_require_control_token_when_configured(tmp_path, monkeypatch):
    # When a control token is configured, the escalation endpoints — like every other
    # governed API endpoint (e.g. /api/governance/approvals, /api/team/approvals/*) —
    # reject calls that don't present it and accept those that do. (No token configured
    # is the instance-wide localhost-only local-trust posture shared by all endpoints;
    # production sets one via desktop_runtime.) This proves the D2 endpoints are gated.
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", _TICKET_KEY)
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-token")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    env = make_permission_escalation(
        tool_name="run_shell",
        args={"cmd": "ls"},
        prompt_text="Allow shell?",
        principal="local_user",
        run_id="run-tok",
    )
    client.app.state.store.create_escalation(env)
    auth = {"x-superclaw-token": "secret-token"}
    # Unauthenticated → 401 on reads AND on the mutating respond.
    assert client.get("/api/escalations").status_code == 401
    assert client.get(f"/api/escalations/{env.request_id}").status_code == 401
    assert (
        client.post(
            f"/api/escalations/{env.request_id}/respond", json={"decision": "deny"}
        ).status_code
        == 401
    )
    # Fail-closed: the rejected respond mutated nothing.
    assert client.app.state.store.get_escalation(env.request_id).status == "pending"
    # Authenticated → allowed.
    assert client.get("/api/escalations", headers=auth).status_code == 200
    assert (
        client.post(
            f"/api/escalations/{env.request_id}/respond",
            json={"decision": "deny"},
            headers=auth,
        ).status_code
        == 200
    )
