"""CLI surface for the escalation queue: ``superclaw escalation list/show/respond``
(capability-workshop Direction 4 P0/D1). The CLI is a thin operator face over the
durable, fail-closed StateStore methods — no parallel logic."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.escalation import EscalationStatus, make_permission_escalation
from superclaw.state import StateStore

PRINCIPAL = "local_user"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    # Deterministic ticket key shared by the seeding store and the in-process CLI.
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", base64.b64encode(b"k" * 32).decode())
    return tmp_path


def _seed(env, *, now=None, ttl_seconds=None) -> str:
    store = StateStore(str(env / "state.db"))
    envelope = make_permission_escalation(
        tool_name="run_shell", args={"command": "echo hi"},
        prompt_text="Agent wants to run a shell command", principal=PRINCIPAL, run_id="run_1",
        now=now, ttl_seconds=ttl_seconds,
    )
    store.create_escalation(envelope)
    return envelope.request_id


def test_escalation_list_show_respond_roundtrip(env):
    runner = CliRunner()
    rid = _seed(env)

    listed = runner.invoke(app, ["escalation", "list"])
    assert listed.exit_code == 0, listed.output
    items = json.loads(listed.output)
    match = [i for i in items if i["request_id"] == rid]
    assert match and match[0]["status"] == "pending" and match[0]["tool_name"] == "run_shell"
    assert match[0]["prompt_text"] == "Agent wants to run a shell command"

    shown = runner.invoke(app, ["escalation", "show", rid])
    assert shown.exit_code == 0
    payload = json.loads(shown.output)
    assert payload["request_id"] == rid
    assert payload["signature_valid"] is True  # binding untampered
    assert payload["effective_status"] == "pending"

    approved = runner.invoke(app, ["escalation", "respond", rid, "--decision", "approve"])
    assert approved.exit_code == 0, approved.output
    assert json.loads(approved.output)["status"] == EscalationStatus.APPROVED.value


def test_escalation_respond_rejects_wrong_principal(env):
    runner = CliRunner()
    rid = _seed(env)
    bad = runner.invoke(app, ["escalation", "respond", rid, "--decision", "approve", "--principal", "mallory"])
    assert bad.exit_code == 1
    assert "principal mismatch" in bad.output
    # still pending — the bad response did not mutate it
    shown = json.loads(runner.invoke(app, ["escalation", "show", rid]).output)
    assert shown["status"] == "pending"


def test_escalation_respond_deny(env):
    runner = CliRunner()
    rid = _seed(env)
    denied = runner.invoke(app, ["escalation", "respond", rid, "--decision", "deny"])
    assert denied.exit_code == 0, denied.output
    assert json.loads(denied.output)["status"] == EscalationStatus.DENIED.value


def test_escalation_respond_unknown_option_fails(env):
    runner = CliRunner()
    rid = _seed(env)
    res = runner.invoke(app, ["escalation", "respond", rid, "--decision", "maybe"])
    assert res.exit_code == 1
    assert "unknown option" in res.output


def test_escalation_show_unknown_exits_1(env):
    runner = CliRunner()
    res = runner.invoke(app, ["escalation", "show", "esc_does_not_exist"])
    assert res.exit_code == 1
    assert "unknown escalation" in res.output


def test_escalation_list_status_filter(env):
    runner = CliRunner()
    rid = _seed(env)
    runner.invoke(app, ["escalation", "respond", rid, "--decision", "approve"])
    # default queue is pending → now empty
    assert json.loads(runner.invoke(app, ["escalation", "list"]).output) == []
    approved = json.loads(runner.invoke(app, ["escalation", "list", "--status", "approved"]).output)
    assert any(i["request_id"] == rid for i in approved)


def test_escalation_respond_rejects_tampered_record(env):
    runner = CliRunner()
    rid = _seed(env)
    # Tamper the stored payload's args_digest (breaks the binding signature).
    store = StateStore(str(env / "state.db"))
    with store._connect() as conn:
        row = conn.execute("SELECT payload FROM escalations WHERE request_id = ?", (rid,)).fetchone()
        payload = json.loads(row["payload"])
        payload["args_digest"] = "deadbeef"
        conn.execute("UPDATE escalations SET payload = ? WHERE request_id = ?", (json.dumps(payload), rid))
    res = runner.invoke(app, ["escalation", "respond", rid, "--decision", "approve"])
    assert res.exit_code == 1
    assert "signature" in res.output  # tampered binding refused


def test_escalation_respond_rejects_expired(env):
    runner = CliRunner()
    # Mint already-expired: created 2h ago with a 1h TTL.
    past = datetime.now(UTC) - timedelta(hours=2)
    rid = _seed(env, now=past, ttl_seconds=3600)
    res = runner.invoke(app, ["escalation", "respond", rid, "--decision", "approve"])
    assert res.exit_code == 1
    assert "expired" in res.output
    # the overdue record is no longer in the pending queue (effective-status filter)
    assert json.loads(runner.invoke(app, ["escalation", "list"]).output) == []
