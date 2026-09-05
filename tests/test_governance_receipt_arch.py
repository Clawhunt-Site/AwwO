"""§7.1 Test-as-Policy: the governance-decision OWNERS emit a decision receipt.

Drives the REAL escalation-based governance choke points to each verdict and asserts the
matching ``governance.decision`` receipt lands in the telemetry sink AND carries the
AUTHORITATIVE state.db ``request_id``. Behavioral owner-coverage (assert the choke point
produces a receipt), NOT a "did it call record()" test — the roadmap's §7.1 shape.

Owners covered here (both escalation-based decision paths):
  * ``_build_escalation_gate`` — the B-class in-process permission gate (allow/pending/denied).
  * ``StoreNativeApprovalBroker.poll`` — the codex native-approval broker (allow/denied/expired),
    emitting once per id on the TERMINAL verdict (never per pending poll).

**Coverage boundary (explicit, not overclaimed).** ``posture_denies_tool`` (static
permission-posture denial, a distinct pre-gate capability filter — §5② posture, not the
§5④ escalation decision) is a SEPARATE owner, not wired/asserted here. A full owner-map
drift guard (enumerate EVERY governance path → each must emit) is a later P0b-2 deliverable.

The telemetry path is the per-test sink the conftest fixture isolates via
``SUPERCLAW_TELEMETRY_PATH``.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from superclaw import diagnostics_store as ds
from superclaw.backends import LocalShellBackend
from superclaw.diagnostics_owners import GOVERNANCE_DECISION
from superclaw.escalation import (
    EscalationDenied,
    EscalationPending,
    StoreNativeApprovalBroker,
    make_runtime_tool_escalation,
)
from superclaw.models import GoalSpec
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore

_TOOL = "run_shell"
_ARGS = {"command": "echo hi"}


def _gate_setup(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store, backends={"local": LocalShellBackend()})
    goal = store.create_goal(GoalSpec(title="g", description="exercise the gate"))
    session = orch.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    gate = orch._build_escalation_gate(session)
    return store, gate


def _gov_receipts(decision: str | None = None) -> list[dict]:
    # The global store (created lazily by the gate) holds the WAL; read committed rows
    # from the per-test telemetry path via a separate connection.
    conn = sqlite3.connect(ds.resolve_telemetry_path())
    conn.row_factory = sqlite3.Row
    try:
        rows = [
            dict(r)
            for r in conn.execute("SELECT * FROM receipts WHERE kind = ?", (GOVERNANCE_DECISION,))
        ]
    except sqlite3.OperationalError:
        rows = []  # no receipt emitted yet → the sink db / table doesn't exist
    finally:
        conn.close()
    out = []
    for row in rows:
        payload = json.loads(row["payload"])
        if decision is None or payload.get("decision") == decision:
            out.append({**row, "_payload": payload})
    return out


def test_gate_pending_emits_pending_receipt(tmp_path) -> None:
    store, gate = _gate_setup(tmp_path)
    # A fresh action with no grant → the gate opens a PENDING and suspends.
    with pytest.raises(EscalationPending):
        gate(_TOOL, _ARGS, None)
    pend = _gov_receipts("pending")
    assert len(pend) == 1
    assert pend[0]["receipt_class"] == "critical"
    assert pend[0]["_payload"]["tool_name"] == _TOOL
    assert pend[0]["_payload"]["args_digest"]  # the action hash is recorded
    # The receipt joins back to the AUTHORITATIVE state.db pending row.
    pending_row = store.list_escalations(status="pending")[0]
    assert pend[0]["_payload"]["request_id"] == pending_row.request_id


def test_gate_denied_emits_denied_receipt(tmp_path) -> None:
    store, gate = _gate_setup(tmp_path)
    # Open a pending, then a human DENIES it → the next gate call is sticky-denied.
    with pytest.raises(EscalationPending):
        gate(_TOOL, _ARGS, None)
    pending = store.list_escalations(status="pending")[0]
    store.resolve_escalation(
        pending.request_id, decision_option_id="deny",
        approver="local_user", principal=pending.principal,
    )
    with pytest.raises(EscalationDenied):
        gate(_TOOL, _ARGS, None)
    denied = _gov_receipts("denied")
    assert len(denied) == 1
    assert denied[0]["receipt_class"] == "critical"
    assert denied[0]["_payload"]["reason"] == "sticky_human_deny"
    # The receipt's request_id is the AUTHORITATIVE denied row, not the fresh request.
    assert denied[0]["_payload"]["request_id"] == pending.request_id


def test_gate_allow_emits_allow_receipt(tmp_path) -> None:
    store, gate = _gate_setup(tmp_path)
    # Open a pending, then a human APPROVES it → the next gate call consumes the grant.
    with pytest.raises(EscalationPending):
        gate(_TOOL, _ARGS, None)
    pending = store.list_escalations(status="pending")[0]
    store.resolve_escalation(
        pending.request_id, decision_option_id="approve",
        approver="local_user", principal=pending.principal,
    )
    gate(_TOOL, _ARGS, None)  # returns (proceed) — the grant authorized the action
    allow = _gov_receipts("allow")
    assert len(allow) == 1
    assert allow[0]["receipt_class"] == "critical"
    assert allow[0]["_payload"]["tool_name"] == _TOOL
    # The receipt's request_id is the AUTHORITATIVE consumed grant, not the fresh request.
    assert allow[0]["_payload"]["request_id"] == pending.request_id


# -- native-approval broker owner (the SECOND escalation-based decision path) --

_METHOD = "shell"
_ACTION = {"command": "echo hi"}


def _broker(tmp_path):
    store = StateStore(tmp_path / "state.db")
    broker = StoreNativeApprovalBroker(
        store=store, run_id="run-1", session_id="sess-1", principal="local_user",
    )
    return store, broker


def test_native_broker_denied_emits_receipt(tmp_path) -> None:
    store, broker = _broker(tmp_path)
    rid = broker.open(method=_METHOD, action=_ACTION, prompt_text="ok?", reserved_path=None)
    store.resolve_escalation(rid, decision_option_id="deny", approver="local_user", principal="local_user")
    assert broker.poll(rid) == "deny"  # terminal verdict
    denied = _gov_receipts("denied")
    assert len(denied) == 1
    assert denied[0]["receipt_class"] == "critical"
    assert denied[0]["_payload"]["request_id"] == rid  # authoritative state.db id
    assert denied[0]["_payload"]["reason"] == "native_approval"


def test_native_broker_allow_emits_receipt(tmp_path) -> None:
    store, broker = _broker(tmp_path)
    rid = broker.open(method=_METHOD, action=_ACTION, prompt_text="ok?", reserved_path=None)
    store.resolve_escalation(rid, decision_option_id="approve", approver="local_user", principal="local_user")
    assert broker.poll(rid) == "allow"
    allow = _gov_receipts("allow")
    assert len(allow) == 1
    assert allow[0]["_payload"]["request_id"] == rid


def test_native_broker_expired_emits_receipt(tmp_path) -> None:
    store, broker = _broker(tmp_path)
    # An escalation created in the past with a tiny TTL is already expired vs real now.
    past = datetime.now(UTC) - timedelta(hours=1)
    env = make_runtime_tool_escalation(
        method=_METHOD, action=_ACTION, prompt_text="ok?", principal="local_user",
        run_id="run-1", session_id="sess-1", ttl_seconds=1, now=past,
    )
    store.create_escalation(env)
    broker._opened[env.request_id] = (_METHOD, env.args_digest or "")
    assert broker.poll(env.request_id) == "expired"  # terminal
    expired = _gov_receipts("expired")
    assert len(expired) == 1
    assert expired[0]["_payload"]["request_id"] == env.request_id


def test_native_broker_pending_emits_nothing_and_terminal_dedups(tmp_path) -> None:
    store, broker = _broker(tmp_path)
    rid = broker.open(method=_METHOD, action=_ACTION, prompt_text="ok?", reserved_path=None)
    # Polling while undecided must NOT emit a receipt per tick.
    assert broker.poll(rid) == "pending"
    assert broker.poll(rid) == "pending"
    assert _gov_receipts() == []
    # Once approved, the terminal verdict emits EXACTLY ONE receipt even if polled again.
    store.resolve_escalation(rid, decision_option_id="approve", approver="local_user", principal="local_user")
    assert broker.poll(rid) == "allow"
    broker.poll(rid)  # a second terminal poll must not double-record
    assert len(_gov_receipts()) == 1


def test_native_broker_concurrent_terminal_records_once(tmp_path) -> None:
    import threading

    store, broker = _broker(tmp_path)
    rid = broker.open(method=_METHOD, action=_ACTION, prompt_text="ok?", reserved_path=None)
    store.resolve_escalation(rid, decision_option_id="approve", approver="local_user", principal="local_user")
    # Concurrent polls of the same terminal id: the dedup lock must yield EXACTLY ONE
    # receipt (no duplicate / contradictory terminal facts for one request_id).
    start = threading.Event()

    def _poll():
        start.wait()
        broker.poll(rid)

    threads = [threading.Thread(target=_poll) for _ in range(8)]
    for t in threads:
        t.start()
    start.set()
    for t in threads:
        t.join()
    receipts = _gov_receipts()
    assert len(receipts) == 1  # dedup: exactly one terminal receipt
    # And it is the AUTHORITATIVE verdict — "allow" — even though most threads' poll()
    # returned "deny" (already-consumed): the verdict is derived from the CONSUMED row,
    # not the per-thread return, so a scheduling quirk cannot record a wrong fact.
    assert receipts[0]["_payload"]["decision"] == "allow"
