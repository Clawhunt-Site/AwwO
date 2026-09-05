"""Escalation framework — durable, fail-closed governance escalations.

This is the P0/D1 foundation of capability-workshop **Direction 4** (提权/审批升迁
通道). See ``docs/capability-workshop-impl-roadmap.md`` §7.2 / §7.3 / §8.2 and
``docs/capability-workshop-roadmap.md`` 方向四 for the design and the adversarial
review that produced it.

Two-layer model (roadmap 方向四, "传输/呈现统一，授权硬隔离"):

* **Public envelope** — transport/presentation lifecycle that CLI/REST/SSE/Web all
  render: ``request_id``, ``kind``, ``prompt_text``, ``options``, ``status``,
  timestamps. SSE is only ever a *notification*; the authority is the durable store.
* **Typed binding** — the authorization fact: ``run_id`` + ``tool_name`` +
  ``args_digest`` + ``principal`` + ``nonce``, sealed with an HMAC ``signature``
  that also covers the FULL human-facing decision context (``prompt_text`` and the
  option labels). An approval is a **single-consumption grant bound to the EXACT
  action**. Replay, byte-changes to the payload, cross-run reuse, principal swaps
  and double-consumption are all refused fail-closed.

Hard rules this module enforces (roadmap §8.2):

* It never *executes* anything and never trusts a model- or caller-supplied
  "approved" field. Authorization is read only from a server-minted, store-backed,
  signed grant; a record may only ENTER the store as PENDING (see
  :func:`validate_new_envelope`).
* No UI / no approver wired ⇒ the action stays denied (the run suspends or the
  caller fail-closes); it is **never** silently let through.

This module is deliberately self-contained: pure stdlib + an HMAC ticket key
derived from the instance master key. Persistence lives in :mod:`superclaw.state`
(``escalations`` table) following the same convention as ``approvals``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets as _pysecrets
import threading
import uuid
from dataclasses import dataclass, fields
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any, Mapping

from .diagnostics_owners import record_governance_decision

# Normalise the native broker's runtime_tool verdict strings into the shared
# governance vocabulary (the B-class gate uses "denied"; consume returns "deny").
_NATIVE_DECISION_TO_VERDICT = {"allow": "allow", "deny": "denied", "expired": "expired"}

# Map the AUTHORITATIVE state.db escalation status to the shared governance vocabulary.
# Recording the verdict from the committed escalation status (not the per-thread poll
# return) makes the terminal receipt concurrency-correct: a "deny" returned to a thread
# that lost the consume race still records "allow" because the row is CONSUMED.
_STATUS_TO_VERDICT = {
    "consumed": "allow",  # the single-use grant was consumed → the action WAS authorized
    "denied": "denied",
    "expired": "expired",
}

# ---------------------------------------------------------------------------
# Kinds and statuses
# ---------------------------------------------------------------------------


class EscalationKind(str, Enum):
    """The typed kind of an escalation.

    Each kind routes to its OWN authorization handler — they MUST NOT share one
    generic authorization path (roadmap 方向四: a泛型 EscalationRequest with shared
    auth semantics is a privilege-escalation hole). Only ``PERMISSION`` is wired in
    the D1 foundation; the rest are reserved for P1/P2 (REST/SSE/Web + native
    runtime approval normalization) and are recorded here so the typed routing
    contract exists from day one.
    """

    PERMISSION = "permission"  # B-class in-process tool gate (run_shell / sensitive write)
    GOVERNANCE_GATE = "governance_gate"  # fusion pay/scan/active-network (reserved)
    RUNTIME_TOOL = "runtime_tool"  # native runtime approval callback (reserved, P2)
    PLAN_APPROVAL = "plan_approval"  # reserved, direction 5 P1
    CLARIFYING_QUESTION = "clarifying_question"  # reserved, business question
    ISSUE_COMPLETION = "issue_completion"  # reserved, QA review


class EscalationStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"
    CONSUMED = "consumed"


TERMINAL_ESCALATION_STATUSES: frozenset[str] = frozenset(
    {EscalationStatus.DENIED.value, EscalationStatus.EXPIRED.value, EscalationStatus.CONSUMED.value}
)

# Fail-closed status machine. Anything not listed is refused.
_ALLOWED_ESCALATION_TRANSITIONS: dict[str, set[str]] = {
    EscalationStatus.PENDING.value: {
        EscalationStatus.APPROVED.value,
        EscalationStatus.DENIED.value,
        EscalationStatus.EXPIRED.value,
    },
    EscalationStatus.APPROVED.value: {
        EscalationStatus.CONSUMED.value,
        EscalationStatus.EXPIRED.value,
    },
    EscalationStatus.DENIED.value: set(),
    EscalationStatus.EXPIRED.value: set(),
    EscalationStatus.CONSUMED.value: set(),
}


def is_valid_escalation_status_transition(previous: str, current: str) -> bool:
    if previous == current:
        return True
    return current in _ALLOWED_ESCALATION_TRANSITIONS.get(previous, set())


class EscalationError(Exception):
    """Raised for fail-closed validation failures (bad ticket, expired, wrong
    principal, illegal option/transition). Never let one pass silently."""


class EscalationPending(Exception):
    """Raised by a fail-closed gate (e.g. the B-class ``_exec_tool``) when an
    action needs human approval that is not yet granted.

    Per roadmap §7.2 #1 the gate must NOT block inline waiting for a decision: it
    records a durable PENDING escalation and raises this so the orchestrator can
    suspend the run into ``WAITING_FOR_HUMAN_GATE`` and resume later. Callers with
    no run to suspend (e.g. direct chat) must catch this and fail closed (deny the
    action) — never swallow it as a generic tool error and proceed."""

    def __init__(self, envelope: "EscalationEnvelope") -> None:
        self.envelope = envelope
        super().__init__(
            f"escalation pending: {envelope.request_id} "
            f"kind={envelope.kind} tool={envelope.tool_name}"
        )


class EscalationDenied(Exception):
    """Raised by the gate when this exact action already carries a human DENIAL.

    A denial is sticky: once a human denies an action, re-running it (e.g. after a
    resume) must NOT re-prompt — that would silently ignore the human's decision.
    The gate raises this instead of creating a fresh pending; the in-process tool
    layer turns it into a fail-closed denial returned to the model (the action is
    refused; the run is NOT suspended again)."""

    def __init__(self, envelope: "EscalationEnvelope") -> None:
        self.envelope = envelope
        super().__init__(
            f"escalation denied: {envelope.request_id} "
            f"kind={envelope.kind} tool={envelope.tool_name}"
        )


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class EscalationOption:
    """One answerable option presented to the human.

    ``grants`` is the authorization bit: choosing a ``grants=True`` option is the
    ONLY thing that authorizes the bound action. Labels/styles are presentation
    only and never consulted for authorization (but they ARE covered by the
    signature, so they cannot be relabeled without invalidating the grant)."""

    id: str
    label: str
    style: str = "default"  # default | primary | danger
    grants: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "style": self.style, "grants": self.grants}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EscalationOption":
        # grants is parsed STRICTLY: only a real boolean True authorizes. A string
        # like "false" must never coerce to True (that would be a parse-level auth
        # bug). A tampered grants also breaks the signature, but parse strictly too.
        return cls(
            id=str(data.get("id", "")),
            label=str(data.get("label", "")),
            style=str(data.get("style", "default")),
            grants=data.get("grants") is True,
        )


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


@dataclass
class EscalationEnvelope:
    """Durable record for one escalation. Public fields render to surfaces; the
    binding fields (run_id/tool_name/args_digest/principal/nonce) + signature are
    the authorization fact."""

    request_id: str
    kind: str
    prompt_text: str
    options: list[EscalationOption]
    nonce: str
    created_at: str
    expires_at: str
    status: str = EscalationStatus.PENDING.value
    default_option_id: str | None = None
    # --- binding (authorization fact) ---
    run_id: str | None = None
    session_id: str | None = None
    principal: str | None = None
    tool_name: str | None = None
    args_digest: str | None = None
    reserved_path: str | None = None
    # --- resolution ---
    decision: str | None = None  # chosen option id
    approver: str | None = None
    resolved_at: str | None = None
    consumed_at: str | None = None
    last_action_id: str | None = None  # fingerprint (roadmap Q4.5)
    # --- tamper seal over the immutable binding ---
    signature: str | None = None
    # --- approval attestation: HMAC over (binding + decision/approver/resolved_at),
    # minted by resolve() on APPROVE. grant_authorizes verifies the APPROVAL itself,
    # so flipping a stored row to status=approved without the key forges nothing
    # (the binding signature deliberately does NOT cover mutable status/decision, so
    # this closes the post-insert-mutation hole). None until/unless approved.
    grant_signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "kind": self.kind,
            "prompt_text": self.prompt_text,
            "options": [opt.to_dict() for opt in self.options],
            "nonce": self.nonce,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "status": self.status,
            "default_option_id": self.default_option_id,
            "run_id": self.run_id,
            "session_id": self.session_id,
            "principal": self.principal,
            "tool_name": self.tool_name,
            "args_digest": self.args_digest,
            "reserved_path": self.reserved_path,
            "decision": self.decision,
            "approver": self.approver,
            "resolved_at": self.resolved_at,
            "consumed_at": self.consumed_at,
            "last_action_id": self.last_action_id,
            "signature": self.signature,
            "grant_signature": self.grant_signature,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EscalationEnvelope":
        # Filter to known fields (dirty/forward keys tolerated, mirrors
        # RunSession.from_dict). options are nested dataclasses. Note: tolerance
        # here is for forward-compat only — authorization never relies on it, since
        # every load is re-verified against the signature before it can authorize.
        known = {f.name for f in fields(cls)}
        payload = {k: v for k, v in dict(data).items() if k in known}
        raw_options = payload.get("options") or []
        payload["options"] = [
            EscalationOption.from_dict(o) for o in raw_options if isinstance(o, Mapping)
        ]
        return cls(**payload)

    # -- convenience --
    def option_ids(self) -> set[str]:
        return {opt.id for opt in self.options}

    def option(self, option_id: str) -> EscalationOption | None:
        for opt in self.options:
            if opt.id == option_id:
                return opt
        return None

    def is_expired(self, *, now: datetime | None = None) -> bool:
        deadline = _parse_iso(self.expires_at)
        if deadline is None:
            # Unparseable/absent expiry ⇒ treated as ALREADY expired (fail-closed):
            # a validly-signed ticket with a corrupt expires_at must never become an
            # immortal grant (TTL fail-open). Legit tickets always carry a parseable
            # expiry, enforced at mint by validate_new_envelope.
            return True
        return (now or _now()) >= deadline

    def effective_status(self, *, now: datetime | None = None) -> str:
        """Status as a surface should see it: a pending/approved record past its
        deadline reads EXPIRED even before housekeeping persists the transition."""
        if self.status in {EscalationStatus.PENDING.value, EscalationStatus.APPROVED.value} and self.is_expired(now=now):
            return EscalationStatus.EXPIRED.value
        return self.status


# ---------------------------------------------------------------------------
# Crypto: args digest + binding signature (single-use ticket)
# ---------------------------------------------------------------------------

_TICKET_KEY_ENV = "SUPERCLAW_ESCALATION_TICKET_KEY"
_TICKET_KEY_INFO = b"superclaw/escalation/ticket/v1"


def _assert_canonical_json(obj: Any) -> None:
    """Recursively reject anything that would make the digest non-canonical.

    Python's ``json.dumps`` silently coerces non-string mapping keys to strings
    (so ``{1: "a"}`` and ``{"1": "a"}`` collide) and, without ``allow_nan=False``,
    emits non-standard ``NaN``/``Infinity``. Both would let two distinct argument
    objects share a digest. We forbid non-string keys, non-finite floats, and any
    non-JSON-native scalar (bytes, sets, custom objects) up front, fail-closed."""
    if isinstance(obj, Mapping):
        for key, value in obj.items():
            if not isinstance(key, str):
                raise EscalationError(f"tool argument keys must be strings, got {type(key).__name__}")
            _assert_canonical_json(value)
    elif isinstance(obj, list):
        # list ONLY — a tuple serializes identically to a list, so accepting it would
        # let {"x": (1, 2)} and {"x": [1, 2]} share a digest.
        for value in obj:
            _assert_canonical_json(value)
    elif isinstance(obj, bool) or obj is None or isinstance(obj, (str, int)):
        return
    elif isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise EscalationError("tool arguments must not contain NaN/Infinity")
    else:
        raise EscalationError(f"tool arguments must be canonical-JSON types, got {type(obj).__name__}")


def compute_args_digest(args: Mapping[str, Any] | None) -> str:
    """Stable sha256 over the tool arguments. The grant binds to THIS digest, so
    changing a single byte of the args invalidates the approval (roadmap §8.2:
    "payload 改一字节…全拒").

    Tool arguments must be canonical-JSON expressible. Anything that is not (custom
    objects, sets, bytes, tuples, non-string keys, NaN/Infinity…) is refused
    fail-closed rather than stringified or coerced — a lossy serialization could let
    two distinct argument objects share a digest or drift between mint and check.
    The root must be a JSON object (Mapping) or None; a falsy non-mapping like ``[]``
    or ``""`` is rejected rather than silently folded into ``{}``."""
    if args is None:
        payload: dict[str, Any] = {}
    elif isinstance(args, Mapping):
        payload = dict(args)
    else:
        raise EscalationError(f"tool arguments must be a JSON object (Mapping) or None, got {type(args).__name__}")
    _assert_canonical_json(payload)
    try:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise EscalationError(f"tool arguments are not canonical-JSON serializable: {exc}") from exc
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _decode_key(raw: str) -> bytes | None:
    candidate = raw.strip()
    if not candidate:
        return None
    import base64
    import binascii

    for decoder in (lambda s: base64.b64decode(s, validate=True), bytes.fromhex):
        try:
            decoded = decoder(candidate)
        except (binascii.Error, ValueError):
            continue
        if len(decoded) >= 16:
            return decoded
    encoded = candidate.encode("utf-8")
    return encoded if len(encoded) >= 16 else None


def derive_ticket_key() -> bytes:
    """The HMAC key that seals escalation bindings.

    Resolution: explicit env override > a subkey derived from the instance master
    key via ``HMAC(master, _TICKET_KEY_INFO)``. The domain separator keeps this key
    independent from the secrets-store AES usage of the same master key. The
    override lets tests inject a deterministic key and operators rotate without
    touching the secrets file."""
    override = os.environ.get(_TICKET_KEY_ENV, "")
    if override.strip():
        key = _decode_key(override)
        if key is None:
            raise EscalationError(f"{_TICKET_KEY_ENV} is set but not a usable key (>=16 bytes)")
        return key
    # Lazy import avoids any import cycle and keeps the model layer free of crypto deps.
    from superclaw import secrets_store

    master = secrets_store.load_master_key()
    return hmac.new(master, _TICKET_KEY_INFO, hashlib.sha256).digest()


def _binding_message(env: EscalationEnvelope) -> bytes:
    """Canonical, order-stable serialization of the IMMUTABLE binding fields. The
    signature covers exactly these — never the mutable status/decision/approver, so
    re-signing on resolution is unnecessary and the grant cannot be retargeted to a
    different action by editing the stored payload.

    The binding includes the FULL human-facing decision context — ``prompt_text``
    and each option's ``label``/``style`` — not just the machine binding. Otherwise
    a tampered store could keep ``tool_name``/``args_digest`` intact (signature
    valid) while swapping the prompt the human reads or relabeling the buttons
    (a bait-and-switch). Per roadmap §8.2 "改一字节全拒" the signature must cover
    everything the approver actually decides on."""
    binding = {
        "request_id": env.request_id,
        "kind": env.kind,
        "run_id": env.run_id,
        "session_id": env.session_id,
        "principal": env.principal,
        "tool_name": env.tool_name,
        "args_digest": env.args_digest,
        "reserved_path": env.reserved_path,
        "prompt_text": env.prompt_text,
        "nonce": env.nonce,
        "expires_at": env.expires_at,
        "options": [
            [opt.id, int(opt.grants), opt.label, opt.style]
            for opt in sorted(env.options, key=lambda o: o.id)
        ],
        "default_option_id": env.default_option_id,
    }
    return json.dumps(binding, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign_envelope(env: EscalationEnvelope, *, key: bytes | None = None) -> str:
    k = key if key is not None else derive_ticket_key()
    return hmac.new(k, _binding_message(env), hashlib.sha256).hexdigest()


def verify_envelope(env: EscalationEnvelope, *, key: bytes | None = None) -> bool:
    if not env.signature:
        return False
    k = key if key is not None else derive_ticket_key()
    expected = hmac.new(k, _binding_message(env), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, env.signature)


def _grant_message(env: EscalationEnvelope) -> bytes:
    """Message for the APPROVAL attestation: the immutable binding PLUS the decision
    facts (status/decision/approver/resolved_at). Signing this lets a verifier
    confirm the approval was minted by the kernel — not forged by flipping a stored
    row's status column, which the binding signature intentionally does not cover."""
    decision = {
        "status": env.status,
        "decision": env.decision,
        "approver": env.approver,
        "resolved_at": env.resolved_at,
        "consumed_at": env.consumed_at,
    }
    return (
        b"escalation-grant/v1\n"
        + _binding_message(env)
        + b"\n"
        + json.dumps(decision, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )


def sign_grant(env: EscalationEnvelope, *, key: bytes | None = None) -> str:
    k = key if key is not None else derive_ticket_key()
    return hmac.new(k, _grant_message(env), hashlib.sha256).hexdigest()


def verify_grant(env: EscalationEnvelope, *, key: bytes | None = None) -> bool:
    """True iff this record carries a valid APPROVED attestation. Requires status
    APPROVED and a grant_signature that matches the current decision facts."""
    if env.status != EscalationStatus.APPROVED.value or not env.grant_signature:
        return False
    k = key if key is not None else derive_ticket_key()
    expected = hmac.new(k, _grant_message(env), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, env.grant_signature)


# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------

_DEFAULT_TTL_ENV = "SUPERCLAW_ESCALATION_TTL_SECONDS"
_DEFAULT_TTL_SECONDS = 86_400  # 24h: a suspended run may wait for an offline operator


def _ttl_seconds() -> int:
    raw = os.environ.get(_DEFAULT_TTL_ENV, "").strip()
    if not raw:
        return _DEFAULT_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_TTL_SECONDS
    return value if value > 0 else _DEFAULT_TTL_SECONDS


# Standard two-option set for an allow/deny permission escalation. ``deny`` is the
# default so timeout/non-answer fails closed.
def default_permission_options() -> list[EscalationOption]:
    return [
        EscalationOption(id="deny", label="Deny", style="default", grants=False),
        EscalationOption(id="approve", label="Approve once", style="danger", grants=True),
    ]


def make_permission_escalation(
    *,
    tool_name: str,
    args: Mapping[str, Any] | None,
    prompt_text: str,
    principal: str,
    run_id: str | None = None,
    session_id: str | None = None,
    reserved_path: str | None = None,
    ttl_seconds: int | None = None,
    now: datetime | None = None,
    key: bytes | None = None,
) -> EscalationEnvelope:
    """Mint a signed, PENDING permission escalation bound to one exact tool call.

    ``principal`` is required: a permission grant is bound to (and only resolvable
    by) a principal — "same machine = authorized" is privilege escalation on a
    multi-user host (roadmap Q4.3)."""
    if not (principal or "").strip():
        raise EscalationError("permission escalation requires a non-empty principal")
    if not (tool_name or "").strip():
        raise EscalationError("permission escalation requires a tool_name")
    if not (run_id or "").strip() and not (session_id or "").strip():
        # A grant must be scoped to SOMETHING. A run-less, session-less grant would
        # be consumable in any no-binding context (cross-context replay).
        raise EscalationError("permission escalation must bind a run_id or a non-empty session_id")
    created = now or _now()
    ttl = ttl_seconds if (ttl_seconds and ttl_seconds > 0) else _ttl_seconds()
    options = default_permission_options()
    env = EscalationEnvelope(
        request_id=f"esc_{uuid.uuid4().hex}",
        kind=EscalationKind.PERMISSION.value,
        prompt_text=prompt_text,
        options=options,
        nonce=_pysecrets.token_urlsafe(24),
        created_at=_iso(created),
        expires_at=_iso(created + timedelta(seconds=ttl)),
        status=EscalationStatus.PENDING.value,
        default_option_id="deny",
        run_id=run_id,
        session_id=session_id,
        principal=principal,
        tool_name=tool_name,
        args_digest=compute_args_digest(args),
        reserved_path=reserved_path,
    )
    env.signature = sign_envelope(env, key=key)
    return env


def make_runtime_tool_escalation(
    *,
    method: str,
    action: Mapping[str, Any] | None,
    prompt_text: str,
    principal: str,
    run_id: str | None = None,
    session_id: str | None = None,
    reserved_path: str | None = None,
    ttl_seconds: int | None = None,
    now: datetime | None = None,
    key: bytes | None = None,
) -> EscalationEnvelope:
    """Mint a signed, PENDING runtime_tool escalation for a codex native approval
    request (P2/D5 native-approval normalization).

    ``method`` is the app-server request method (e.g.
    ``item/commandExecution/requestApproval``) and is stored as ``tool_name``.
    ``action`` is the CANONICAL action payload (command+cwd / path+patch / requested
    scope / tool+args) — digested strictly via :func:`compute_args_digest`, so an
    approval binds to THAT exact action and a single byte change invalidates the grant
    (roadmap §digest). Like the permission factory, ``principal`` is required and the
    record must bind a run_id or session_id (no cross-context replay)."""
    if not (principal or "").strip():
        raise EscalationError("runtime_tool escalation requires a non-empty principal")
    if not (method or "").strip():
        raise EscalationError("runtime_tool escalation requires a method")
    if not (run_id or "").strip() and not (session_id or "").strip():
        raise EscalationError("runtime_tool escalation must bind a run_id or a non-empty session_id")
    created = now or _now()
    ttl = ttl_seconds if (ttl_seconds and ttl_seconds > 0) else _ttl_seconds()
    options = default_permission_options()
    env = EscalationEnvelope(
        request_id=f"esc_{uuid.uuid4().hex}",
        kind=EscalationKind.RUNTIME_TOOL.value,
        prompt_text=prompt_text,
        options=options,
        nonce=_pysecrets.token_urlsafe(24),
        created_at=_iso(created),
        expires_at=_iso(created + timedelta(seconds=ttl)),
        status=EscalationStatus.PENDING.value,
        default_option_id="deny",
        run_id=run_id,
        session_id=session_id,
        principal=principal,
        tool_name=method,
        args_digest=compute_args_digest(action),
        reserved_path=reserved_path,
    )
    env.signature = sign_envelope(env, key=key)
    return env


# ---------------------------------------------------------------------------
# Pure validators (used by the persistence layer + CLI)
# ---------------------------------------------------------------------------


def validate_new_envelope(env: EscalationEnvelope, *, key: bytes | None = None) -> None:
    """Fail-closed gate for a record about to ENTER the store.

    Refuses anything a caller could have hand-forged to smuggle in a pre-authorized
    ticket (the most dangerous bypass: mint PENDING, flip ``status``/``decision`` to
    approved before insert, then consume — the signature does NOT cover those mutable
    fields). A new record must therefore be PENDING with no resolution fields, carry
    a parseable expiry, declare non-empty options with unique ids and a real default,
    and verify against its binding signature. Raises EscalationError on any
    violation."""
    if env.status != EscalationStatus.PENDING.value:
        raise EscalationError(f"new escalation must be PENDING, got {env.status!r}")
    if any(v is not None for v in (env.decision, env.approver, env.resolved_at, env.consumed_at)):
        raise EscalationError("new escalation must not carry resolution fields (decision/approver/resolved/consumed)")
    if _parse_iso(env.expires_at) is None:
        raise EscalationError("new escalation has a missing/unparseable expires_at")
    if not env.options:
        raise EscalationError("new escalation must declare at least one option")
    ids = [opt.id for opt in env.options]
    if not all(ids):
        raise EscalationError("escalation option ids must be non-empty")
    if len(ids) != len(set(ids)):
        raise EscalationError("escalation option ids must be unique")
    if env.default_option_id is not None and env.default_option_id not in set(ids):
        raise EscalationError("default_option_id is not among the options")
    # PERMISSION (B-class in-process tool gate) and RUNTIME_TOOL (codex native approval
    # normalization, P2/D5) share the same action-binding invariant: both bind a single
    # exact action by a principal in a run/session, so both require principal + tool_name
    # (RUNTIME_TOOL stores the app-server method here) + args_digest (the action digest) +
    # a run/session scope.
    if env.kind in (EscalationKind.PERMISSION.value, EscalationKind.RUNTIME_TOOL.value):
        if not (env.principal or "").strip():
            raise EscalationError(f"{env.kind} escalation requires a principal")
        if not env.tool_name:
            raise EscalationError(f"{env.kind} escalation requires a tool_name")
        if not env.args_digest:
            raise EscalationError(f"{env.kind} escalation requires an args_digest")
        if not (env.run_id or "").strip() and not (env.session_id or "").strip():
            raise EscalationError(f"{env.kind} escalation must bind a run_id or session_id")
    if not verify_envelope(env, key=key):
        raise EscalationError("new escalation signature is missing/invalid")


def _grant_authorizes_for_kind(
    env: EscalationEnvelope,
    *,
    expected_kind: str,
    run_id: str | None,
    principal: str | None,
    tool_name: str,
    args_digest: str,
    session_id: str | None = None,
    now: datetime | None = None,
    key: bytes | None = None,
) -> bool:
    """Shared consume-eligibility core for a single-use grant. The CALLER fixes
    ``expected_kind`` — the kind branch therefore stays HARD-ISOLATED per public
    authorizer, so a permission grant can never authorize a runtime_tool action (or
    vice versa). All checks fail-closed: status APPROVED, not consumed, not expired,
    kind matches, the binding (run/session/tool/args_digest/principal) matches, BOTH
    signatures verify, and the chosen option ``grants``. Consume-eligibility only —
    the caller still consumes atomically."""
    if env.status != EscalationStatus.APPROVED.value:
        return False
    # A consumed grant can never re-authorize. consumed_at is also covered by the
    # approval attestation (see _grant_message), so flipping a CONSUMED row's status
    # column back to approved cannot revive it: the attestation was minted with
    # consumed_at=None and no longer verifies. This explicit check is belt-and-suspenders.
    if env.consumed_at is not None:
        return False
    if env.is_expired(now=now):
        return False
    if env.kind != expected_kind:
        return False
    if env.tool_name != tool_name:
        return False
    if env.args_digest != args_digest:
        return False
    # run scoping: a grant minted for a run only authorizes that run. A grant with
    # no run binding (run_id is None) never satisfies a run-scoped request.
    if env.run_id != run_id:
        return False
    # session scoping: a run-less grant (run_id None, e.g. direct chat) is bound to
    # its session and must not be replayed in another session.
    if env.session_id != session_id:
        return False
    # principal scoping: the grant authorizes only the principal it was bound to.
    if not env.principal or env.principal != principal:
        return False
    if not verify_envelope(env, key=key):
        return False
    if not verify_grant(env, key=key):
        return False
    chosen = env.option(env.decision or "")
    return bool(chosen and chosen.grants)


def grant_authorizes(
    env: EscalationEnvelope,
    *,
    run_id: str | None,
    principal: str | None,
    tool_name: str,
    args_digest: str,
    session_id: str | None = None,
    now: datetime | None = None,
    key: bytes | None = None,
) -> bool:
    """True iff this record is a still-valid PERMISSION grant for THIS exact tool call
    by THIS principal in THIS run/session (B-class in-process tool gate). The two
    signatures together mean neither the bound action nor the approval decision can be
    forged by editing the stored row without the ticket key. Consume-eligibility — the
    caller must still consume it atomically."""
    return _grant_authorizes_for_kind(
        env,
        expected_kind=EscalationKind.PERMISSION.value,
        run_id=run_id,
        principal=principal,
        tool_name=tool_name,
        args_digest=args_digest,
        session_id=session_id,
        now=now,
        key=key,
    )


def grant_authorizes_runtime_tool(
    env: EscalationEnvelope,
    *,
    run_id: str | None,
    principal: str | None,
    method: str,
    action_digest: str,
    session_id: str | None = None,
    now: datetime | None = None,
    key: bytes | None = None,
) -> bool:
    """True iff this record is a still-valid RUNTIME_TOOL grant for THIS exact codex
    native action by THIS principal in THIS run/session (P2/D5 native-approval). Kind
    is hard-checked as RUNTIME_TOOL, so a permission grant can never authorize a codex
    native action. ``method`` binds to the stored ``tool_name`` (the app-server request
    method) and ``action_digest`` to ``args_digest`` (the strict digest of the
    canonical action payload)."""
    return _grant_authorizes_for_kind(
        env,
        expected_kind=EscalationKind.RUNTIME_TOOL.value,
        run_id=run_id,
        principal=principal,
        tool_name=method,
        args_digest=action_digest,
        session_id=session_id,
        now=now,
        key=key,
    )


# ---------------------------------------------------------------------------
# Surface projection (single source shared by CLI + REST, no HMAC material)
# ---------------------------------------------------------------------------


def escalation_summary(env: EscalationEnvelope) -> dict[str, Any]:
    """Operator/surface-facing queue view of one escalation.

    The SINGLE projection shared by the ``superclaw escalation`` CLI and the
    ``/api/escalations`` REST surface so the two can never drift (CLI is the source
    of truth; REST is a transport over the same shape). It deliberately omits ALL
    HMAC material — ``signature``/``grant_signature``/``nonce`` are authorization
    internals and are NEVER put on the wire (the REST detail adds a derived
    ``signature_valid`` boolean instead). ``status`` is the EFFECTIVE status, so an
    overdue record reads ``expired`` even before housekeeping persists the
    transition. ``style`` is carried so a surface can render button emphasis without
    re-deriving it."""
    return {
        "request_id": env.request_id,
        "kind": env.kind,
        "status": env.effective_status(),  # reads EXPIRED past the deadline
        "run_id": env.run_id,
        "session_id": env.session_id,
        "principal": env.principal,
        "tool_name": env.tool_name,
        "reserved_path": env.reserved_path,
        "prompt_text": env.prompt_text,
        "options": [
            {"id": o.id, "label": o.label, "style": o.style, "grants": o.grants}
            for o in env.options
        ],
        "default_option_id": env.default_option_id,
        "created_at": env.created_at,
        "expires_at": env.expires_at,
        "decision": env.decision,
        "approver": env.approver,
    }


# ---------------------------------------------------------------------------
# Native approval broker (P2/D5): bridge codex requestApproval → escalation queue
# ---------------------------------------------------------------------------

_NATIVE_APPROVAL_BROKER_ENV = "SUPERCLAW_NATIVE_APPROVAL_BROKER"
_NATIVE_APPROVAL_TIMEOUT_ENV = "SUPERCLAW_NATIVE_APPROVAL_TIMEOUT"
# C0 spike: real codex-cli 0.137 tolerated a 30s delayed approval cleanly. 120s is a
# conservative human-decision window well under any observed ceiling; operators can tune
# it. On exceed the broker path fail-closes (decline).
_DEFAULT_NATIVE_APPROVAL_TIMEOUT = 120.0


def native_approval_broker_enabled() -> bool:
    """Opt-in flag for routing codex native ``requestApproval`` through the escalation
    queue (P2/D5). Default OFF (fail-safe back-compat) — codex keeps its static decision.
    Strict truthy parse: only an explicit on value enables it."""
    return os.environ.get(_NATIVE_APPROVAL_BROKER_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def native_approval_timeout_seconds() -> float:
    raw = os.environ.get(_NATIVE_APPROVAL_TIMEOUT_ENV, "").strip()
    if not raw:
        return _DEFAULT_NATIVE_APPROVAL_TIMEOUT
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_NATIVE_APPROVAL_TIMEOUT
    return value if value > 0 else _DEFAULT_NATIVE_APPROVAL_TIMEOUT


class StoreNativeApprovalBroker:
    """Concrete native-approval broker bound to ONE run (store + run/session/principal).

    ``open`` mints + persists a runtime_tool escalation (so the request surfaces in the
    ``/api/escalations`` queue + D3 popup) and remembers its ``(method, action_digest)``
    so ``poll`` can ask the store to atomically consume the single-use grant once the
    human approves. Fail-closed: an unknown escalation id polls as ``deny``; the store
    consume is the single source of the decision (it re-verifies binding + signatures and
    consumes the grant exactly once)."""

    def __init__(self, *, store: Any, run_id: str | None, session_id: str | None, principal: str, timeout_seconds: float | None = None) -> None:
        self._store = store
        self._run_id = run_id
        self._session_id = session_id
        self._principal = principal
        self._timeout = (
            float(timeout_seconds) if timeout_seconds and timeout_seconds > 0 else native_approval_timeout_seconds()
        )
        self._opened: dict[str, tuple[str, str]] = {}  # escalation_request_id -> (method, action_digest)
        self._recorded: set[str] = set()  # ids whose terminal governance receipt was emitted
        self._record_lock = threading.Lock()  # serialize the terminal-dedup check+add

    def open(self, *, method: str, action: dict[str, Any], prompt_text: str, reserved_path: str | None) -> str | None:
        env = make_runtime_tool_escalation(
            method=method,
            action=action,
            prompt_text=prompt_text,
            principal=self._principal,
            run_id=self._run_id,
            session_id=self._session_id,
            reserved_path=reserved_path,
        )
        self._store.create_escalation(env)
        self._opened[env.request_id] = (method, env.args_digest or "")
        return env.request_id

    def poll(self, escalation_request_id: str) -> str:
        info = self._opened.get(escalation_request_id)
        if info is None:
            # Defensive fail-closed guard: this broker never opened this id (so there is
            # no state.db escalation it owns for it). This is NOT a state.db-backed
            # governance decision over a real escalation — it is a "don't recognise it →
            # deny" guard — so it is intentionally NOT emitted as a governance.decision
            # (that owner projects state.db verdicts; a verdict over an unknown id has no
            # authoritative row to project).
            return "deny"
        method, action_digest = info
        decision = self._store.consume_runtime_tool_grant(
            escalation_request_id,
            run_id=self._run_id,
            principal=self._principal,
            method=method,
            action_digest=action_digest,
            session_id=self._session_id,
        )
        # §5④ governance-decision owner (P0b-2): the native broker is the SECOND
        # escalation-based decision choke point (alongside the B-class gate). poll() is a
        # polling loop, so emit the receipt ONCE per id at its TERMINAL verdict
        # (allow/denied/expired), never per "pending" tick. The lock makes the dedup
        # check+add atomic, and the recorded verdict is derived from the AUTHORITATIVE
        # committed escalation status (NOT this thread's poll return), so concurrent polls
        # can never write a wrong terminal fact (a thread that lost the consume race still
        # records "allow" because the row is CONSUMED). Recording never changes the return.
        if decision != "pending":
            should_record = False
            with self._record_lock:
                if escalation_request_id not in self._recorded:
                    self._recorded.add(escalation_request_id)
                    should_record = True
            if should_record:
                record_governance_decision(
                    decision=self._authoritative_verdict(escalation_request_id, decision),
                    tool_name=method,
                    args_digest=action_digest or None,
                    request_id=escalation_request_id,
                    principal=self._principal,
                    reason="native_approval",
                )
        return decision

    def _authoritative_verdict(self, escalation_request_id: str, fallback_decision: str) -> str:
        """Derive the terminal verdict from the COMMITTED escalation status (so it is the
        same for every concurrent poll). Falls back to the per-thread decision mapping if
        the row can't be read — verdict derivation must never break poll()."""
        try:
            env = self._store.get_escalation(escalation_request_id)
            status = env.effective_status(now=datetime.now(UTC))
            if status in _STATUS_TO_VERDICT:
                return _STATUS_TO_VERDICT[status]
        except Exception:  # noqa: BLE001 - observability derivation must never break the gate
            pass
        return _NATIVE_DECISION_TO_VERDICT.get(fallback_decision, fallback_decision)

    def timeout_seconds(self) -> float:
        return self._timeout
