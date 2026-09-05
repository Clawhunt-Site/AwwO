"""Kernel tests for the runtime_tool escalation primitives (native-approval C1).

These pin the typed authorizer for codex native approvals: a runtime_tool grant
authorizes ONLY the exact codex action (method + canonical-action digest) by the bound
principal in the bound run/session, and the kind branch is HARD-isolated — a permission
grant can never authorize a runtime_tool action, nor vice versa (Codex design-review
must-fix). Pure kernel; nothing wires it yet (C2 is the broker).
"""

from superclaw.escalation import (
    EscalationStatus,
    compute_args_digest,
    grant_authorizes,
    grant_authorizes_runtime_tool,
    make_permission_escalation,
    make_runtime_tool_escalation,
    verify_envelope,
)
from superclaw.state import StateStore

_TICKET_KEY = "runtime-tool-test-key-0123456789"
_METHOD = "item/commandExecution/requestApproval"
_ACTION = {"command": "echo hi", "cwd": "/repo", "reason": "demo"}


def _store(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", _TICKET_KEY)
    return StateStore(tmp_path / "state.db")


def _approved_runtime_tool(store, *, run_id="run-1", principal="local_user", method=_METHOD, action=_ACTION):
    env = make_runtime_tool_escalation(
        method=method,
        action=action,
        prompt_text="Allow codex to run `echo hi`?",
        principal=principal,
        run_id=run_id,
    )
    store.create_escalation(env)  # validate_new_envelope must accept RUNTIME_TOOL
    return store.resolve_escalation(
        env.request_id, decision_option_id="approve", approver=principal, principal=principal
    )


def test_make_runtime_tool_escalation_is_valid_pending(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    env = make_runtime_tool_escalation(
        method=_METHOD, action=_ACTION, prompt_text="ok?", principal="local_user", run_id="run-1"
    )
    assert env.kind == "runtime_tool"
    assert env.status == EscalationStatus.PENDING.value
    assert env.tool_name == _METHOD
    assert env.args_digest == compute_args_digest(_ACTION)
    assert verify_envelope(env)
    # accepted into the store (validate_new_envelope covers runtime_tool)
    store.create_escalation(env)


def test_runtime_tool_grant_authorizes_exact_action(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    approved = _approved_runtime_tool(store)
    assert approved.status == EscalationStatus.APPROVED.value
    assert grant_authorizes_runtime_tool(
        approved,
        run_id="run-1",
        principal="local_user",
        method=_METHOD,
        action_digest=compute_args_digest(_ACTION),
    )


def test_runtime_tool_grant_refuses_mismatches(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    approved = _approved_runtime_tool(store)
    good = dict(run_id="run-1", principal="local_user", method=_METHOD, action_digest=compute_args_digest(_ACTION))
    # wrong method
    assert not grant_authorizes_runtime_tool(approved, **{**good, "method": "item/fileChange/requestApproval"})
    # byte-changed action → different digest → not authorized
    assert not grant_authorizes_runtime_tool(
        approved, **{**good, "action_digest": compute_args_digest({**_ACTION, "command": "echo HI"})}
    )
    # wrong principal / run
    assert not grant_authorizes_runtime_tool(approved, **{**good, "principal": "mallory"})
    assert not grant_authorizes_runtime_tool(approved, **{**good, "run_id": "run-2"})


def test_kind_isolation_permission_vs_runtime_tool(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    # An APPROVED runtime_tool grant must NOT authorize via the PERMISSION authorizer.
    rt = _approved_runtime_tool(store)
    assert not grant_authorizes(
        rt, run_id="run-1", principal="local_user", tool_name=_METHOD, args_digest=compute_args_digest(_ACTION)
    )
    # An APPROVED permission grant must NOT authorize via the runtime_tool authorizer.
    penv = make_permission_escalation(
        tool_name="run_shell", args={"cmd": "ls"}, prompt_text="?", principal="local_user", run_id="run-1"
    )
    store.create_escalation(penv)
    papproved = store.resolve_escalation(
        penv.request_id, decision_option_id="approve", approver="local_user", principal="local_user"
    )
    assert not grant_authorizes_runtime_tool(
        papproved,
        run_id="run-1",
        principal="local_user",
        method="run_shell",
        action_digest=compute_args_digest({"cmd": "ls"}),
    )
    # sanity: each authorizes its OWN kind
    assert grant_authorizes(
        papproved, run_id="run-1", principal="local_user", tool_name="run_shell", args_digest=compute_args_digest({"cmd": "ls"})
    )


def test_store_consume_path_skips_runtime_tool_grant(tmp_path, monkeypatch):
    # Cross-LAYER kind isolation (Codex review): the B-class gate's store consume path
    # (find_consumable_grant / resolve_gate_decision) uses the PERMISSION authorizer, so an
    # APPROVED runtime_tool grant — even with the SAME tool_name + args_digest as a B-class
    # request — must never be consumed by the in-process tool gate.
    store = _store(tmp_path, monkeypatch)
    # runtime_tool grant whose method/action collide with a permission request shape.
    approved = _approved_runtime_tool(store, method="run_shell", action={"cmd": "ls"})
    assert approved.kind == "runtime_tool"
    digest = compute_args_digest({"cmd": "ls"})
    # The PERMISSION consume lookup does NOT see the runtime_tool grant.
    assert (
        store.find_consumable_grant(
            run_id="run-1", principal="local_user", tool_name="run_shell", args_digest=digest
        )
        is None
    )
    # And the atomic B-class gate decision for that exact action stays PENDING (it opens a
    # fresh permission escalation rather than consuming the runtime_tool grant).
    pending = make_permission_escalation(
        tool_name="run_shell", args={"cmd": "ls"}, prompt_text="?", principal="local_user", run_id="run-1"
    )
    decision, _env = store.resolve_gate_decision(pending)
    assert decision == "pending"


def test_runtime_tool_pending_grant_not_yet_authorized(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    env = make_runtime_tool_escalation(
        method=_METHOD, action=_ACTION, prompt_text="ok?", principal="local_user", run_id="run-1"
    )
    store.create_escalation(env)
    # still PENDING (no human decision) → fail-closed, not authorized
    assert not grant_authorizes_runtime_tool(
        env, run_id="run-1", principal="local_user", method=_METHOD, action_digest=compute_args_digest(_ACTION)
    )
