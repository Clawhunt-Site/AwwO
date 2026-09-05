"""Tests for the native-approval broker + its orchestrator wiring (P2/D5 C2/C3).

The StoreNativeApprovalBroker bridges codex requestApproval into the escalation queue:
``open`` persists a runtime_tool escalation, ``poll`` atomically consumes the single-use
grant once a human approves (via the same store path as /api/escalations/respond), and is
fail-closed on unknown ids / denies / double-consume. The orchestrator wires it only when
opted in (flag) under a non-full posture.
"""

from superclaw.escalation import (
    EscalationStatus,
    StoreNativeApprovalBroker,
    native_approval_broker_enabled,
)
from superclaw.models import GoalSpec
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore

_KEY = "na-broker-test-key-0123456789"
_METHOD = "item/commandExecution/requestApproval"
_ACTION = {"method": _METHOD, "params": {"command": "touch ok"}}


def _broker(tmp_path, monkeypatch, **kw):
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", _KEY)
    store = StateStore(tmp_path / "state.db")
    return store, StoreNativeApprovalBroker(
        store=store, run_id="run-1", session_id=None, principal="local_user", timeout_seconds=60, **kw
    )


def test_broker_open_pending_then_allow_after_human_approve(tmp_path, monkeypatch):
    store, broker = _broker(tmp_path, monkeypatch)
    eid = broker.open(method=_METHOD, action=_ACTION, prompt_text="run touch ok?", reserved_path=None)
    assert eid
    assert broker.poll(eid) == "pending"  # no decision yet → fail-closed wait
    # human approves through the SAME store path the REST respond endpoint uses
    store.resolve_escalation(eid, decision_option_id="approve", approver="local_user", principal="local_user")
    assert broker.poll(eid) == "allow"  # consumes the single-use grant
    assert broker.poll(eid) == "deny"  # single-use: already consumed
    assert store.get_escalation(eid).status == EscalationStatus.CONSUMED.value


def test_broker_deny_after_human_deny(tmp_path, monkeypatch):
    store, broker = _broker(tmp_path, monkeypatch)
    eid = broker.open(method=_METHOD, action=_ACTION, prompt_text="?", reserved_path=None)
    store.resolve_escalation(eid, decision_option_id="deny", approver="local_user", principal="local_user")
    assert broker.poll(eid) == "deny"


def test_broker_unknown_id_fails_closed(tmp_path, monkeypatch):
    _store, broker = _broker(tmp_path, monkeypatch)
    assert broker.poll("esc_never_opened") == "deny"


def test_broker_distinct_actions_get_distinct_grants(tmp_path, monkeypatch):
    # Approving one action must NOT authorize a different one (digest binding).
    store, broker = _broker(tmp_path, monkeypatch)
    eid_a = broker.open(method=_METHOD, action={"method": _METHOD, "params": {"command": "a"}}, prompt_text="a", reserved_path=None)
    eid_b = broker.open(method=_METHOD, action={"method": _METHOD, "params": {"command": "b"}}, prompt_text="b", reserved_path=None)
    store.resolve_escalation(eid_a, decision_option_id="approve", approver="local_user", principal="local_user")
    assert broker.poll(eid_a) == "allow"
    assert broker.poll(eid_b) == "pending"  # b was never approved


def test_flag_default_off_strict_truthy(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_NATIVE_APPROVAL_BROKER", raising=False)
    assert native_approval_broker_enabled() is False
    for on in ("1", "true", "yes", "on", "ON", "True"):
        monkeypatch.setenv("SUPERCLAW_NATIVE_APPROVAL_BROKER", on)
        assert native_approval_broker_enabled() is True
    for off in ("0", "false", "", "maybe"):
        monkeypatch.setenv("SUPERCLAW_NATIVE_APPROVAL_BROKER", off)
        assert native_approval_broker_enabled() is False


def test_orchestrator_gates_broker_by_flag_and_posture(tmp_path, monkeypatch):
    from superclaw.backends import WorkerLimits
    from superclaw.orchestrator import SuperClawOrchestrator

    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", _KEY)
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="T", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=tmp_path)
    limits_workspace = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path, permission_policy=PermissionPolicy(mode="acceptEdits")
    )

    # flag OFF → never wire (back-compat static decision)
    monkeypatch.delenv("SUPERCLAW_NATIVE_APPROVAL_BROKER", raising=False)
    assert orch._build_native_approval_broker(session, limits_workspace) is None

    # flag ON + non-full posture → broker wired
    monkeypatch.setenv("SUPERCLAW_NATIVE_APPROVAL_BROKER", "1")
    assert orch._build_native_approval_broker(session, limits_workspace) is not None

    # flag ON + full posture (bypass) → None (codex uses approvalPolicy=never, no requestApproval)
    limits_full = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path, permission_policy=PermissionPolicy(mode="bypassPermissions")
    )
    assert orch._build_native_approval_broker(session, limits_full) is None
