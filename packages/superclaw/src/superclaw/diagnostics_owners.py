"""§7.1 Coverage-Owner receipt emitters (P0b-2).

The roadmap's §7.1 owner map assigns each §5 environment a SINGLE kernel choke point
that emits its diagnostic receipt. This module holds the typed emitters for the owners
that don't fall naturally on the Tool/Backend/EventBus base classes — starting with the
**governance decision** owner (§5④): the B-class permission gate's allow / pending /
denied verdict.

**Observability is decoupled from the governed verdict.** The AUTHORITATIVE governance
ledger is ``state.db`` (the ``escalations`` + ``consumed_grants`` tables — a denial is a
sticky DENIED row, an authorization is a CONSUMED grant). The receipt emitted here is a
*unified-observability projection* of that decision into the telemetry view, emitted only
AFTER the verdict is committed to ``state.db``. It is ``critical`` so it lands durably
(engine journal fallback on failure).

Two distinct guarantees, neither of which lets telemetry dictate security posture:
  * It NEVER **changes** the verdict — a telemetry failure (``DiagnosticPersistError`` or
    anything broader) is logged, never raised; the verdict is already durable in ``state.db``.
  * It may add a BOUNDED audit wait before the verdict is **delivered** back to the caller
    (a critical receipt blocks on the engine commit ACK, ≤ the engine's critical timeout —
    normally sub-millisecond), paid AFTER the decision is already committed to ``state.db``.
    This §7.1 "governance decisions must persist" tradeoff cannot flip allow↔deny.
Wiring an emitter that could fail-closed the gate on a telemetry hiccup would let
observability dictate security posture — the exact inversion §7.2 warns against.
"""
from __future__ import annotations

from typing import Any

from .diagnostics_redaction import redact
from .diagnostics_store import DiagnosticPersistError, DiagnosticsStore, get_store
from .logging_config import get_logger

_log = get_logger("diagnostics.owners")

# Static, low-cardinality receipt kind for the §5④ governance decision owner.
GOVERNANCE_DECISION = "governance.decision"

# The enumerable verdicts a governance choke point can record (bounds the payload's
# decision field across owners — the B-class gate and the native-approval broker both
# normalise into this vocabulary).
GOVERNANCE_DECISIONS = ("allow", "pending", "denied", "expired")


def record_governance_decision(
    *,
    decision: str,
    tool_name: str,
    args_digest: str | None = None,
    reason: str | None = None,
    request_id: str | None = None,
    principal: str | None = None,
    store: DiagnosticsStore | None = None,
) -> None:
    """Project a B-class gate verdict into the telemetry view (§5④ / §7.1).

    ``decision`` is one of :data:`GOVERNANCE_DECISIONS`. ``request_id`` is the
    AUTHORITATIVE ``state.db`` escalation id (a DOMAIN id, carried in the receipt PAYLOAD
    — not the engine's correlation ``request_id`` column, which is the API request id;
    query it with ``json_extract(payload,'$.request_id')``). Only attribution metadata is
    recorded — ``args_digest`` is the action hash, never the raw args. NEVER raises: the
    verdict is authoritative in ``state.db`` and must not be weakened by telemetry state.
    """
    if decision not in GOVERNANCE_DECISIONS:
        # Defensive: an unknown verdict would pollute the fact source's decision facet.
        _log.error("governance.decision called with unknown decision %r (tool=%s)", decision, tool_name)
    payload: dict[str, Any] = {"decision": decision, "tool_name": tool_name}
    if args_digest:
        payload["args_digest"] = args_digest
    if reason:
        payload["reason"] = reason
    if request_id:
        payload["request_id"] = request_id
    if principal:
        payload["principal"] = principal
    # Resolve the sink FIRST and separately: get_store() can fail-fast at construction
    # (unwritable dir / ready timeout) BEFORE any receipt or journal exists — that is NOT
    # an "engine journalled" case, so it must not log that false audit-safety claim.
    try:
        sink = store if store is not None else get_store()
    except Exception as exc:  # noqa: BLE001 - observability must NEVER break governance
        _log.error(
            "governance.decision sink unavailable; receipt NOT recorded (state.db "
            "authoritative) decision=%s tool=%s: %s",
            decision,
            tool_name,
            exc,
        )
        return
    try:
        # Redact at the owner choke point (P0b-1c) before the generic sink persists it.
        sink.record(GOVERNANCE_DECISION, redact(GOVERNANCE_DECISION, payload), critical=True)
    except DiagnosticPersistError as exc:
        # record() journalled the receipt before raising (P0b-1a no-recursive fallback);
        # state.db remains the authoritative ledger. Surface, never raise.
        _log.error(
            "governance.decision receipt not durable in telemetry (engine journalled; "
            "state.db authoritative) decision=%s tool=%s: %s",
            decision,
            tool_name,
            exc,
        )
    except Exception as exc:  # noqa: BLE001 - observability must NEVER break governance
        _log.error(
            "governance.decision receipt failed (state.db authoritative) decision=%s tool=%s: %s",
            decision,
            tool_name,
            exc,
        )
