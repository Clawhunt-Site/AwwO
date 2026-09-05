"""Tests for the run-bound ticket primitive (PR-3, 柱子 2).

Covers the design's fail-closed matrix: issue→verify, expiry, action allow-list,
unknown token, forged/tampered token, scope round-trip, hash-only storage (no
plaintext in the DB), revoke (single + per-run), and prune.
"""

from datetime import UTC, datetime, timedelta

import pytest

from superclaw.company_ticket import (
    TicketError,
    issue_run_ticket,
    verify_run_ticket,
)
from superclaw.state import StateStore


def _store(tmp_path):
    return StateStore(tmp_path / "superclaw.db")


_AUD = "team_mcp_proxy"


def _issue(store, **overrides):
    kwargs = dict(
        run_id="run_1",
        agent_profile_id="agent_1",
        company_id="company_1",
        audience=_AUD,
        allowed_actions=["issue.comment", "issue.delegate"],
        ttl_seconds=60.0,
    )
    kwargs.update(overrides)
    return issue_run_ticket(store, **kwargs)


def _verify(store, token, action="issue.comment", audience=_AUD, **kw):
    return verify_run_ticket(store, token, action=action, audience=audience, **kw)


def test_issue_then_verify_succeeds_and_returns_scope(tmp_path):
    store = _store(tmp_path)
    token, ticket = _issue(store)

    verified = _verify(store, token)
    assert verified.run_id == "run_1"
    assert verified.agent_profile_id == "agent_1"
    assert verified.company_id == "company_1"
    assert verified.audience == _AUD
    assert verified.ticket_id == ticket.ticket_id
    assert verified.action == "issue.comment"
    # The verified result must never carry an admin flag.
    assert not hasattr(verified, "is_admin")


def test_expired_ticket_is_refused(tmp_path):
    store = _store(tmp_path)
    base = datetime(2026, 1, 1, tzinfo=UTC)
    token, _ = _issue(store, ttl_seconds=30.0, now=base)

    # Still valid one second before expiry.
    _verify(store, token, now=base + timedelta(seconds=29))
    # At expiry boundary (>=) and beyond → refused.
    with pytest.raises(TicketError, match="expired"):
        _verify(store, token, now=base + timedelta(seconds=30))
    with pytest.raises(TicketError, match="expired"):
        _verify(store, token, now=base + timedelta(seconds=120))


def test_action_outside_allowed_actions_is_refused(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store, allowed_actions=["issue.comment"])

    _verify(store, token, action="issue.comment")
    with pytest.raises(TicketError, match="not permitted"):
        _verify(store, token, action="hire_agent")


def test_unknown_token_is_refused(tmp_path):
    store = _store(tmp_path)
    _issue(store)
    with pytest.raises(TicketError, match="unknown"):
        _verify(store, "sclw-runticket.ticket_deadbeef.notarealsecret")


def test_malformed_token_is_refused(tmp_path):
    store = _store(tmp_path)
    _issue(store)
    for bad in ("", "garbage", "a.b", "wrongprefix.tid.secret", "sclw-runticket..secret", "sclw-runticket.tid."):
        with pytest.raises(TicketError, match="malformed|unknown"):
            _verify(store, bad)


def test_tampered_token_secret_is_refused(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store)
    prefix, ticket_id, secret = token.split(".")
    # Flip a character of the secret: same ticket_id, different secret → hash miss.
    tampered_secret = ("A" if secret[0] != "A" else "B") + secret[1:]
    tampered = f"{prefix}.{ticket_id}.{tampered_secret}"
    assert tampered != token
    with pytest.raises(TicketError, match="unknown"):
        _verify(store, tampered)


def test_spoofed_ticket_id_with_valid_secret_is_refused(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store)
    prefix, _ticket_id, secret = token.split(".")
    # Valid secret (hash hits a row) but a different wire ticket_id → refused.
    spoofed = f"{prefix}.ticket_not_the_real_one.{secret}"
    with pytest.raises(TicketError, match="malformed"):
        _verify(store, spoofed)


def test_audience_mismatch_is_refused(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store, audience="team_mcp_proxy")
    # A verifier for a different surface must refuse — no cross-surface replay.
    with pytest.raises(TicketError, match="audience mismatch"):
        _verify(store, token, audience="some_other_surface")
    # Missing audience at verify is fail-closed too.
    with pytest.raises(TicketError, match="audience is required"):
        verify_run_ticket(store, token, action="issue.comment", audience="")


def test_scope_match_enforced_in_primitive(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store, run_id="run_X", agent_profile_id="agent_X", company_id="co_X")
    # Matching expectations pass.
    _verify(
        store,
        token,
        expected_run_id="run_X",
        expected_agent_profile_id="agent_X",
        expected_company_id="co_X",
    )
    # Any mismatched dimension is refused inside the primitive.
    with pytest.raises(TicketError, match="run scope mismatch"):
        _verify(store, token, expected_run_id="run_Y")
    with pytest.raises(TicketError, match="agent scope mismatch"):
        _verify(store, token, expected_agent_profile_id="agent_Y")
    with pytest.raises(TicketError, match="company scope mismatch"):
        _verify(store, token, expected_company_id="co_Y")


def test_plaintext_token_is_never_stored(tmp_path):
    import json
    import sqlite3

    db = tmp_path / "superclaw.db"
    store = StateStore(db)
    token, ticket = _issue(store)
    _prefix, _ticket_id, secret = token.split(".")

    # The raw secret must not appear anywhere in the deserialized record.
    record = store.get_run_ticket_by_hash(ticket.token_hash)
    assert record is not None
    assert secret not in record.token_hash
    assert secret not in json.dumps(record.to_dict())
    # And the stored hash is a SHA-256 hex (64 chars), not the secret.
    assert len(record.token_hash) == 64
    assert record.token_hash != secret

    # Stronger: the secret must not appear in the RAW DB row either (catches any
    # accidental raw-payload leakage, not just what survives deserialization).
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute("SELECT token_hash, payload FROM run_tickets").fetchall()
    finally:
        conn.close()
    assert rows
    for token_hash, payload in rows:
        assert secret not in token_hash
        assert secret not in payload


def test_from_dict_fails_closed_on_malformed_allowed_actions(tmp_path):
    # The StateStore is the verification authority, so deserialization must
    # REJECT a tampered/legacy allowed_actions, never coerce it into a
    # surprising permission ("None"/"123"/blank).
    from superclaw.models import RunTicket

    base = dict(
        run_id="run_1",
        agent_profile_id="agent_1",
        company_id="company_1",
        token_hash="x" * 64,
        audience=_AUD,
        expires_at=10.0,
    )
    # A clean payload round-trips.
    RunTicket.from_dict({**base, "allowed_actions": ["issue.comment"]})
    # Bad entries and a bare-str container (would split to chars) both rejected.
    for bad in ([None], [123], ["ok", "  "], "issue.comment", 123, None):
        with pytest.raises(ValueError, match="allowed_actions"):
            RunTicket.from_dict({**base, "allowed_actions": bad})


def test_revoke_single_ticket_refuses_further_use(tmp_path):
    store = _store(tmp_path)
    token, ticket = _issue(store)
    _verify(store, token)

    assert store.revoke_run_ticket(ticket.ticket_id) is True
    with pytest.raises(TicketError, match="revoked"):
        _verify(store, token)
    # Idempotent: revoking again still reports a matched row, no error.
    assert store.revoke_run_ticket(ticket.ticket_id) is True
    # Revoking a missing ticket → False.
    assert store.revoke_run_ticket("ticket_missing") is False


def test_revoke_all_tickets_for_run(tmp_path):
    store = _store(tmp_path)
    t1, _ = _issue(store, run_id="run_A")
    t2, _ = _issue(store, run_id="run_A")
    t_other, _ = _issue(store, run_id="run_B")

    count = store.revoke_run_tickets_for_run("run_A")
    assert count == 2
    for tok in (t1, t2):
        with pytest.raises(TicketError, match="revoked"):
            _verify(store, tok)
    # The other run's ticket is untouched.
    _verify(store, t_other)


def test_prune_removes_only_expired(tmp_path):
    store = _store(tmp_path)
    base = datetime(2026, 1, 1, tzinfo=UTC)
    short, _ = _issue(store, ttl_seconds=10.0, now=base)
    long_token, _ = _issue(store, ttl_seconds=10_000.0, now=base)

    # Prune well after the short one expired but before the long one.
    removed = store.prune_expired_run_tickets(now=base + timedelta(seconds=100))
    assert removed == 1
    # The expired one is gone (unknown now); the long-lived one still verifies.
    with pytest.raises(TicketError, match="unknown"):
        _verify(store, short, now=base + timedelta(seconds=100))
    _verify(store, long_token, now=base + timedelta(seconds=100))


def test_issue_rejects_bad_inputs(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(TicketError, match="required"):
        _issue(store, run_id="")
    with pytest.raises(TicketError, match="required"):
        _issue(store, company_id="")
    with pytest.raises(TicketError, match="audience is required"):
        _issue(store, audience="")
    with pytest.raises(TicketError, match="audience is required"):
        _issue(store, audience="   ")
    with pytest.raises(TicketError, match="non-empty"):
        _issue(store, allowed_actions=[])
    with pytest.raises(TicketError, match="positive"):
        _issue(store, ttl_seconds=0)


def test_issue_rejects_non_string_or_blank_actions(tmp_path):
    store = _store(tmp_path)
    # A non-string entry must NOT be silently coerced into a "None"/"123" action.
    with pytest.raises(TicketError, match="non-blank strings"):
        _issue(store, allowed_actions=["issue.comment", None])
    with pytest.raises(TicketError, match="non-blank strings"):
        _issue(store, allowed_actions=["issue.comment", 123])
    with pytest.raises(TicketError, match="non-blank strings"):
        _issue(store, allowed_actions=["issue.comment", "   "])


def test_issue_rejects_bare_string_allowed_actions(tmp_path):
    store = _store(tmp_path)
    # A bare str is iterable; it must NOT split into one-character "actions".
    with pytest.raises(TicketError, match="must be a list"):
        _issue(store, allowed_actions="issue.comment")


def test_verify_rejects_non_string_or_blank_audience(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store)
    # Whitespace-only and non-string audiences raise the uniform TicketError
    # (not a TypeError from compare_digest).
    with pytest.raises(TicketError, match="audience is required"):
        _verify(store, token, audience="   ")
    with pytest.raises(TicketError, match="audience is required"):
        _verify(store, token, audience=None)


def test_ticket_supports_multiple_verifications_within_life(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store, allowed_actions=["issue.comment", "issue.delegate"])
    # Single-run lifecycle allows many mutations until expiry/revoke.
    for _ in range(3):
        _verify(store, token, action="issue.comment")
        _verify(store, token, action="issue.delegate")


def test_empty_action_is_refused(tmp_path):
    store = _store(tmp_path)
    token, _ = _issue(store)
    with pytest.raises(TicketError, match="action is required"):
        verify_run_ticket(store, token, action="", audience=_AUD)


def test_issue_rejects_non_finite_ttl(tmp_path):
    # NaN/inf ttl would make expires_at non-finite → a never-expiring ticket.
    from superclaw.company_ticket import TicketError, issue_run_ticket
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "s.db")
    for bad in (float("nan"), float("inf")):
        with pytest.raises(TicketError):
            issue_run_ticket(
                store, run_id="r", agent_profile_id="a", company_id="c",
                audience="team-mcp", allowed_actions=["issue.comment"], ttl_seconds=bad,
            )


def test_verify_rejects_non_string_action(tmp_path):
    # A non-str action (e.g. a list) must raise the uniform TicketError, not a raw
    # TypeError from the membership test.
    from superclaw.company_ticket import TicketError, issue_run_ticket, verify_run_ticket
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "s.db")
    token, _ = issue_run_ticket(
        store, run_id="r", agent_profile_id="a", company_id="c",
        audience="team-mcp", allowed_actions=["issue.comment"], ttl_seconds=60,
    )
    with pytest.raises(TicketError):
        verify_run_ticket(store, token, action=["issue.comment"], audience="team-mcp")


def test_from_dict_rejects_non_finite_expiry():
    # The read path is the verification authority: a non-finite expiry is refused.
    from superclaw.models import RunTicket

    base = {
        "run_id": "r", "agent_profile_id": "a", "company_id": "c",
        "token_hash": "h", "audience": "team-mcp", "allowed_actions": ["issue.comment"],
        "issued_at": 1.0, "expires_at": float("nan"),
    }
    with pytest.raises(ValueError):
        RunTicket.from_dict(base)


def test_save_rejects_non_finite_expiry(tmp_path):
    # Defense in depth: json.dumps(allow_nan=False) refuses to persist NaN/inf.
    from superclaw.models import RunTicket
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "s.db")
    bad = RunTicket(
        run_id="r", agent_profile_id="a", company_id="c", token_hash="h",
        audience="team-mcp", allowed_actions=["issue.comment"],
        issued_at=1.0, expires_at=float("inf"),
    )
    with pytest.raises(ValueError):
        store.save_run_ticket(bad)


# --- run-scoped respond grant (#2) ------------------------------------------


def test_respond_issue_id_round_trips_through_verify(tmp_path):
    # A ticket minted with a respond grant carries it into the VerifiedTicket.
    store = _store(tmp_path)
    token, _ = _issue(store, respond_issue_id="issue_A")
    verified = _verify(store, token)
    assert verified.respond_issue_id == "issue_A"


def test_respond_issue_id_default_is_none(tmp_path):
    # No grant minted → None on both the record and the verified result.
    store = _store(tmp_path)
    token, ticket = _issue(store)
    assert ticket.respond_issue_id is None
    assert _verify(store, token).respond_issue_id is None


def test_from_dict_respond_issue_id_fails_closed_and_normalizes_blank():
    from superclaw.models import RunTicket

    base = dict(
        run_id="run_1",
        agent_profile_id="agent_1",
        company_id="company_1",
        token_hash="x" * 64,
        audience=_AUD,
        allowed_actions=["issue.comment"],
        expires_at=10.0,
    )
    # A non-string respond grant is rejected outright (never coerced).
    for bad in (123, ["issue_A"], {"a": 1}):
        with pytest.raises(ValueError, match="respond_issue_id"):
            RunTicket.from_dict({**base, "respond_issue_id": bad})
    # Blank normalizes to None (no grant); a real id round-trips.
    assert RunTicket.from_dict({**base, "respond_issue_id": "   "}).respond_issue_id is None
    assert RunTicket.from_dict({**base, "respond_issue_id": "issue_A"}).respond_issue_id == "issue_A"


def _persist_run(store, run_id, status):
    from superclaw.models import RunSession

    store.save_run(RunSession(goal_id="g", run_id=run_id, status=status))


def test_verify_refuses_ticket_when_run_terminal(tmp_path):
    # A ticket whose run has reached a terminal status is refused at verify time
    # (a second authoritative gate beyond the best-effort revoke).
    from superclaw.models import RunStatus

    store = _store(tmp_path)
    for term in (RunStatus.COMPLETED.value, RunStatus.FAILED.value, RunStatus.CANCELLED.value):
        run_id = f"run_{term}"
        token, _ = _issue(store, run_id=run_id)
        _persist_run(store, run_id, term)
        with pytest.raises(TicketError, match="terminal"):
            _verify(store, token)


def test_verify_allows_ticket_when_run_live(tmp_path):
    # A persisted but non-terminal run does NOT trip the terminal gate.
    from superclaw.models import RunStatus

    store = _store(tmp_path)
    token, _ = _issue(store, run_id="run_live")
    _persist_run(store, "run_live", RunStatus.RUNNING.value)
    assert _verify(store, token).run_id == "run_live"


def test_verify_does_not_refuse_when_run_not_persisted(tmp_path):
    # A ticket whose run was never persisted (KeyError) is NOT refused on that
    # basis — the other checks already bind it to the run.
    store = _store(tmp_path)
    token, _ = _issue(store, run_id="run_unpersisted")
    # No save_run for run_unpersisted.
    assert _verify(store, token).run_id == "run_unpersisted"
