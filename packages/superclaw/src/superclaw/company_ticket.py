"""Run-bound ticket primitives for the Agent-company autonomy MCP channel.

This is 柱子 2 of ``docs/agent-company-autonomy-design.md``: an authentication
primitive that lets a running agent prove — over the MCP proxy channel — that it
is the actor the kernel launched, for exactly one run / one agent / one company,
limited to a closed set of tool actions, until expiry.

WHAT THIS MODULE IS (and is NOT):
- It is an *authentication* primitive only. It binds ``run_id +
  agent_profile_id + company_id + audience + allowed_actions + expiry`` to an
  opaque, unforgeable token and verifies that token against the durable
  StateStore on every use. It does NOT compute authorization scope, and it never
  carries or returns an admin flag: a :class:`VerifiedTicket` exposes ONLY the
  identity fields, never ``is_admin``. AUTHORIZATION is the caller's job, derived
  from the verified identity PLUS the verified ``audience`` — never self-reported
  in the token. Two callers exist today (``team_mcp_proxy``): the confined TEAM
  channel re-derives ``is_admin=False`` + a single allowed company; the OPERATOR
  channel (a DISTINCT, separately-minted ``audience``) re-derives ``is_admin=True``
  for the single-owner operator direct chat — parity with the CLI / B-class in-loop
  operator. The admin-ness rides the AUDIENCE the kernel minted, not a ticket field,
  so a confined team ticket (a different audience) can never be re-derived as admin.
  The verifier DOES enforce scope-MATCH (run/agent/company/audience) when the caller
  declares an expectation — the match check lives in the primitive, fail-closed,
  never pushed onto the caller.
- It堵 (closes) ONLY the MCP-layer impersonation surface (forged argv / a
  self-started proxy claiming to be some agent). It does NOT police "an agent
  shelling out to the operator CLI" — that boundary is the route-B containment
  (柱子 0), not this ticket (see design 柱子 2 note).

SECURITY DISCIPLINE:
- The token is minted with ``secrets.token_urlsafe`` (CSPRNG), so it is
  unforgeable without the secret.
- Only a SHA-256 hash of the secret is persisted; verification re-hashes the
  presented secret and compares with ``hmac.compare_digest`` (constant time).
  A read of the DB cannot recover a usable token.
- Verification is fail-closed: an unknown / tampered / expired / revoked token,
  or an action outside ``allowed_actions``, raises rather than returning a
  partial/permissive result.
- A ``now`` clock seam is injected throughout so expiry is testable without
  sleeping.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import secrets
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from superclaw.models import TERMINAL_RUN_STATUSES, RunTicket, VerifiedTicket

if TYPE_CHECKING:
    from superclaw.state import StateStore

# Opaque token wire format: ``<PREFIX>.<ticket_id>.<secret>``. The ticket_id is
# a non-secret correlator (also returned by the verifier for audit); the secret
# is the only thing that proves possession and is the sole input to the hash.
_TOKEN_PREFIX = "sclw-runticket"


class TicketError(Exception):
    """Raised when a run ticket cannot be issued or fails verification.

    Verification failures are deliberately a single exception type with a terse
    reason so callers can fail-closed uniformly without the error text leaking
    which check failed to a caller that should not learn it.
    """


def _hash_secret(secret: str) -> str:
    """Return the stored hash for a token secret (SHA-256 hex).

    Hashing only the secret — not the full wire token — keeps the non-secret
    ``ticket_id`` out of the comparison so a verifier need only re-hash the
    secret it was given.
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _split_token(token: str) -> tuple[str, str] | None:
    """Parse ``<prefix>.<ticket_id>.<secret>`` → (ticket_id, secret) or None.

    Defensive against any malformed input: wrong prefix, wrong segment count, or
    empty parts all yield None so the caller fails closed (treats it as unknown).
    """
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    prefix, ticket_id, secret = parts
    if prefix != _TOKEN_PREFIX or not ticket_id or not secret:
        return None
    return ticket_id, secret


def _now_ts(now: datetime | None) -> float:
    return (now or datetime.now(UTC)).timestamp()


def _normalize_actions(allowed_actions: list[str]) -> list[str]:
    """Reject anything that is not a list of non-blank strings, then dedupe+sort.

    An auth allow-list must be an explicit CONTAINER of real string action
    names. We reject:
    - a non-list/tuple/set container — in particular a bare ``str``, which would
      otherwise iterate into one-character "actions" (``"issue.comment"`` →
      ``[".", "c", "e", …]``), a misconfiguration-to-permission foot-gun;
    - any non-str entry (``None``, ``123``) or blank/whitespace-only string,
      which would become a surprising permission (``"None"``, ``"123"``) or an
      un-matchable entry.
    Refusing rather than silently coercing surfaces a wiring bug at issuance,
    not as a mysterious denial later. ``from_dict`` applies the same rule on the
    read/verify path so the two stay symmetric.
    """
    if not isinstance(allowed_actions, (list, tuple, set)):
        raise TicketError("allowed_actions must be a list of action names")
    cleaned: set[str] = set()
    for action in allowed_actions:
        if not isinstance(action, str) or not action.strip():
            raise TicketError("allowed_actions entries must be non-blank strings")
        cleaned.add(action)
    return sorted(cleaned)


def issue_run_ticket(
    store: StateStore,
    *,
    run_id: str,
    agent_profile_id: str,
    company_id: str,
    audience: str,
    allowed_actions: list[str],
    ttl_seconds: float,
    respond_issue_id: str | None = None,
    now: datetime | None = None,
) -> tuple[str, RunTicket]:
    """Mint a run-bound ticket, persist its hash, and return ``(token, record)``.

    The returned plaintext ``token`` is the ONLY time the secret is available;
    the kernel hands it to the run's MCP proxy config and never reads it back.
    The persisted :class:`RunTicket` holds only the hash.

    Args:
        run_id / agent_profile_id / company_id: the single-run / single-agent /
            single-company binding. All required and non-empty (fail-closed).
        audience: the single verifier surface this ticket is for (e.g. the
            team-MCP proxy id). Required and non-empty; a verifier for a
            different audience refuses the ticket, so it cannot be replayed
            across surfaces sharing the StateStore.
        allowed_actions: the closed allow-list of tool/command names this ticket
            may invoke. Must be a non-empty set of non-blank strings — a ticket
            that can do nothing, or one carrying a non-string/blank action, is a
            misconfiguration, not a useful no-op, and silently issuing one would
            mask a wiring bug.
        ttl_seconds: positive lifetime; ``expires_at = issued_at + ttl``.
        respond_issue_id: optional run-scoped respond grant — when set, the ticket
            additionally authorizes a SINGLE comment on this one issue's thread by
            an agent that does not own it (an @-mentioned / human-triggered respond
            run). The kernel computes this binding from the run's execution_context;
            it is never taken from a command body. A blank value carries no grant
            (RunTicket normalizes blank → None). Note this does NOT widen
            ``allowed_actions``; the comment authorization is enforced by the
            company autonomy gate against the derived scope.
        now: clock seam for tests.

    Raises:
        TicketError: on any missing binding field, missing ``audience``, empty /
            malformed ``allowed_actions``, or non-positive ``ttl_seconds``.
    """
    if not run_id or not agent_profile_id or not company_id:
        raise TicketError("run_id, agent_profile_id and company_id are required")
    if not isinstance(audience, str) or not audience.strip():
        raise TicketError("audience is required")
    normalized = _normalize_actions(allowed_actions)
    if not normalized:
        raise TicketError("allowed_actions must be a non-empty set of action names")
    # Reject NaN/inf BEFORE the <= 0 check: NaN <= 0 is False, which would slip a
    # non-finite ttl through and make expires_at NaN — and `now >= NaN` is always
    # False, minting a ticket that NEVER expires (breaks the expiry fail-closed
    # lifecycle invariant). A non-positive or non-finite ttl is a wiring bug.
    if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
        raise TicketError("ttl_seconds must be a finite positive number")

    issued_at = _now_ts(now)
    secret = secrets.token_urlsafe(32)
    ticket = RunTicket(
        run_id=run_id,
        agent_profile_id=agent_profile_id,
        company_id=company_id,
        token_hash=_hash_secret(secret),
        audience=audience,
        allowed_actions=normalized,
        issued_at=issued_at,
        expires_at=issued_at + float(ttl_seconds),
        revoked_at=None,
        respond_issue_id=respond_issue_id,
    )
    store.save_run_ticket(ticket)
    token = f"{_TOKEN_PREFIX}.{ticket.ticket_id}.{secret}"
    return token, ticket


def verify_run_ticket(
    store: StateStore,
    token: str,
    *,
    action: str,
    audience: str,
    expected_run_id: str | None = None,
    expected_agent_profile_id: str | None = None,
    expected_company_id: str | None = None,
    now: datetime | None = None,
) -> VerifiedTicket:
    """Verify a presented token for an action + audience, fail-closed.

    The durable store is the sole authority. This:
      1. parses the wire token (malformed → refuse);
      2. looks the row up by the re-hashed secret (unknown → refuse);
      3. constant-time compares the stored hash (defends against a partial /
         length-leaking match even though the lookup is already by hash);
      4. authenticates the presented wire ``ticket_id`` against the stored
         record (a token with a valid secret but a mismatched ticket id is
         refused — the wire format is not trusted before verification);
      5. refuses a ticket whose ``audience`` differs from the caller's
         (single-audience: no cross-surface replay);
      6. refuses a revoked ticket;
      7. refuses an expired ticket (``now >= expires_at``);
      8. refuses an ``action`` not in ``allowed_actions``;
      9. when the caller passes ``expected_run_id`` / ``expected_agent_profile_id``
         / ``expected_company_id``, refuses if the ticket does not MATCH — the
         scope-match check lives IN the primitive, not the caller.

    On success it returns a :class:`VerifiedTicket` carrying ONLY the identity
    fields (run/agent/company/audience/ticket id + the checked action) for the
    caller to re-derive scope. It NEVER returns an admin flag.

    Raises:
        TicketError: on any failed check, with a terse reason.
    """
    # action must be a non-blank STRING. A non-str (e.g. a list) would otherwise
    # reach the ``action in set(...)`` membership test below and raise a raw
    # TypeError ("unhashable type: 'list'") instead of the uniform fail-closed
    # TicketError — a malformed action must be refused, not crash differently.
    if not isinstance(action, str) or not action.strip():
        raise TicketError("action is required")
    # Validate audience with the SAME isinstance+strip rule as issuance so a
    # non-string / whitespace-only audience raises the uniform TicketError rather
    # than a TypeError from compare_digest below (single-exception discipline).
    if not isinstance(audience, str) or not audience.strip():
        raise TicketError("audience is required")

    parsed = _split_token(token)
    if parsed is None:
        raise TicketError("malformed ticket")
    wire_ticket_id, secret = parsed

    presented_hash = _hash_secret(secret)
    record = store.get_run_ticket_by_hash(presented_hash)
    if record is None:
        raise TicketError("unknown ticket")
    # Defense-in-depth constant-time compare: the lookup already matched by hash,
    # but comparing here keeps a single non-short-circuiting equality check on the
    # verification path and stays robust if the lookup ever changes.
    if not hmac.compare_digest(record.token_hash, presented_hash):
        raise TicketError("unknown ticket")
    # Authenticate the wire ticket_id against the stored record. The secret is
    # what proves possession, but a presented ticket_id that disagrees with the
    # record means a malformed/spoofed wire token — refuse rather than trust the
    # presented id for audit/routing.
    if not hmac.compare_digest(wire_ticket_id, record.ticket_id):
        raise TicketError("malformed ticket")
    if not hmac.compare_digest(record.audience, audience):
        raise TicketError("ticket audience mismatch")
    if record.revoked_at is not None:
        raise TicketError("revoked ticket")
    if _now_ts(now) >= float(record.expires_at):
        raise TicketError("expired ticket")
    if action not in set(record.allowed_actions):
        raise TicketError("action not permitted by ticket")
    # Scope-match: enforced in the primitive when the caller declares an
    # expectation. None means "do not constrain this dimension here".
    if expected_run_id is not None and record.run_id != expected_run_id:
        raise TicketError("ticket run scope mismatch")
    if expected_agent_profile_id is not None and record.agent_profile_id != expected_agent_profile_id:
        raise TicketError("ticket agent scope mismatch")
    if expected_company_id is not None and record.company_id != expected_company_id:
        raise TicketError("ticket company scope mismatch")

    # Verify-time liveness: a ticket is valid only while its run is live. The
    # ticket's own ``revoked_at`` is the primary, best-effort invalidation set on
    # run teardown, but a crashed / abandoned run may leave the row un-revoked.
    # So we ALSO refuse the ticket if the run has reached a terminal status — a
    # second, authoritative fail-closed gate against a leaked token outliving its
    # run (defense in depth with the explicit revoke on the terminal path). If
    # the run is not persisted yet (KeyError), we do NOT refuse on that basis:
    # the run simply has no status to consult, and the other checks above already
    # bound the ticket to this run.
    try:
        _run = store.get_run(record.run_id)
    except KeyError:
        pass
    else:
        if _run.status in TERMINAL_RUN_STATUSES:
            raise TicketError("ticket run is terminal")

    return VerifiedTicket(
        run_id=record.run_id,
        agent_profile_id=record.agent_profile_id,
        company_id=record.company_id,
        audience=record.audience,
        ticket_id=record.ticket_id,
        action=action,
        respond_issue_id=record.respond_issue_id,
    )
