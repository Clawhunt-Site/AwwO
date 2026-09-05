"""Per-kind redaction allowlist projection for diagnostic receipts (P0b-1c).

The §7.1 owner ⑨ "redactor / truncator" — the SINGLE function every receipt payload
passes through before it is persisted (telemetry.db AND the emergency journal). It
replaces P0a's one-size ``_scrub`` (which collapsed every container to ``<non-scalar>``
and so threw away the Tier-B diagnostic value — tool-arg KEY structure, a value-redacted
result summary). Here, redaction is **allowlist-by-kind**:

* **Deny by omission.** For each static receipt ``kind`` an allowlist names exactly which
  payload keys may persist and how each value is treated. Any key NOT on the list is
  dropped. An UNKNOWN kind fails closed — its whole payload is dropped (a new owner MUST
  declare its allowlist here; this is the redaction half of "instrumentation as a
  contract").
* **Value treatment, key structure preserved.** Scalars pass (numbers as-is; strings
  scrubbed via :func:`redact_secrets` + URL userinfo/query stripped + length-capped); ids
  are length-capped; free-form ``attributes`` are recursed with the KEYS kept and the
  VALUES redacted (depth / breadth / length bounded) so structure stays legible while
  secrets don't leak.
* **Pattern scrub, not high-entropy.** :func:`redact_secrets` is a known-pattern scrubber;
  the allowlist is the primary defence (only declared fields persist at all), the scrub is
  defence-in-depth on the strings that do.
* **Total + deterministic.** Never raises (it runs on the persistence path) and has no
  hidden "off" switch — the projection is unconditional.

NOTE on HMAC attribution: the roadmap lists HMAC pseudonymisation for high-cardinality
sensitive ids. None of the CURRENT receipt fields need it — ``args_digest`` is already a
hash, ``request_id`` is a random id, and ``principal`` must stay human-readable for the
governance audit ("who denied?"). An HMAC value-rule is therefore intentionally deferred
to the first owner field that needs it (e.g. an email / filesystem path), rather than
applied where it would destroy audit legibility or be dead code.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .secrets_scan import redact_secrets

REDACTION_SCHEMA_VERSION = 1

# Length caps (bytes/chars) per value class. Bounds column size + blast radius.
_ENUM_MAX = 128  # static enum-ish fields (decision, span_kind, name, error_type, reason)
_ID_MAX = 256  # correlation / domain ids (request_id, args_digest, span ids, principal)
_TEXT_MAX = 1024  # free text (error message)
_ATTR_STR_MAX = 512  # a string value inside attributes
_ATTR_MAX_DEPTH = 4  # recursion depth for nested attributes
_ATTR_MAX_ITEMS = 64  # keys per dict / items per list inside attributes
# TOTAL node budget across the WHOLE attribute tree — without this, per-container
# limits still allow 64**4 nodes (a size/CPU blowup). Shared across the recursion.
_ATTR_MAX_NODES = 512

# Sentinel: a value rule returns this to DROP the key entirely (e.g. a number field
# handed a dict). Dropping (not coercing) keeps the fact source honest.
_DROP: Any = object()

_USERINFO_RE = re.compile(r"://[^/@\s]*@")  # scheme://user:pass@host  →  scheme://host
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#]+)\?[^\s#]*")  # strip ?query from http(s) URLs


def _clean_url(text: str) -> str:
    """Strip URL userinfo (``user:pass@``) and the query string of http(s) URLs — both
    common carriers of credentials/tokens that a pattern scrub can miss."""
    text = _USERINFO_RE.sub("://", text)
    text = _URL_QUERY_RE.sub(r"\1", text)
    return text


def _scrub_text(value: str, maxlen: int) -> str:
    # redact_secrets FIRST (catches token=... even inside a query), then URL cleanse,
    # then cap. Order matters: cleanse after scrub so a stripped query can't hide a token.
    return _clean_url(redact_secrets(value))[:maxlen]


def _rule_enum(value: Any) -> Any:
    return _scrub_text(value, _ENUM_MAX) if isinstance(value, str) else _DROP


def _rule_id(value: Any) -> Any:
    # Ids aren't secrets, but scrub anyway (defence in depth) and cap length.
    return redact_secrets(value)[:_ID_MAX] if isinstance(value, str) else _DROP


def _rule_text(value: Any) -> Any:
    return _scrub_text(value, _TEXT_MAX) if isinstance(value, str) else _DROP


def _rule_number(value: Any) -> Any:
    # bool is an int subclass — accepted; strings/containers are dropped (a number field
    # must not smuggle free text).
    return value if isinstance(value, (bool, int, float)) else _DROP


class _Budget:
    """Mutable total-node budget shared across one attribute-tree redaction."""

    __slots__ = ("remaining",)

    def __init__(self, total: int) -> None:
        self.remaining = total

    def take(self) -> bool:
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        return True


def _redact_attr_value(value: Any, depth: int, budget: _Budget) -> Any:
    """Recurse arbitrary attribute values: KEEP keys/shape, REDACT values, bound size.

    Bounded on THREE axes so a hostile/huge attribute tree can never blow up CPU or
    storage: per-container item count, recursion depth, and a TOTAL node budget shared
    across the whole tree (the last is essential — per-container limits alone permit
    ``items**depth`` nodes)."""
    if not budget.take():
        return "_budget-exceeded"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _scrub_text(value, _ATTR_STR_MAX)
    if depth >= _ATTR_MAX_DEPTH:
        return "<max-depth>"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= _ATTR_MAX_ITEMS or budget.remaining <= 0:
                out["_truncated_keys"] = True
                break
            # The KEY is caller-controlled too (SpanHandle.set(key, ...)), so a secret in a
            # key must be scrubbed exactly like a value — not just length-capped.
            out[_scrub_text(str(k), _ID_MAX)] = _redact_attr_value(v, depth + 1, budget)
        return out
    if isinstance(value, (list, tuple)):
        out_list: list[Any] = []
        for i, v in enumerate(value):
            if i >= _ATTR_MAX_ITEMS or budget.remaining <= 0:
                out_list.append("_truncated_items")
                break
            out_list.append(_redact_attr_value(v, depth + 1, budget))
        return out_list
    return "<unredactable>"  # unknown type → never persist its raw repr


def _rule_attrs(value: Any) -> Any:
    if not isinstance(value, (dict, list, tuple)):
        return _DROP
    return _redact_attr_value(value, 0, _Budget(_ATTR_MAX_NODES))


# Per-kind allowlist: kind -> {payload_key: value_rule}. Deny by omission; a key not
# listed is never persisted. Receipt kinds are static enums (no per-call interpolation),
# so this table is the complete set a build understands.
_SPAN_FIELDS: dict[str, Callable[[Any], Any]] = {
    "name": _rule_enum,
    "span_kind": _rule_enum,
    "parent_span_id": _rule_id,
    "duration_ms": _rule_number,
    "error_type": _rule_enum,
    "error": _rule_text,
    "attributes": _rule_attrs,
}

_ALLOWLISTS: dict[str, dict[str, Callable[[Any], Any]]] = {
    "governance.decision": {
        "decision": _rule_enum,
        "tool_name": _rule_enum,
        "reason": _rule_enum,
        "args_digest": _rule_id,
        "request_id": _rule_id,
        "principal": _rule_id,
    },
    "span.start": _SPAN_FIELDS,
    "span.end": _SPAN_FIELDS,
    "span.error": _SPAN_FIELDS,
    "diagnostic_loss": {
        "count": _rule_number,
        "reasons": _rule_attrs,
    },
}


def is_allowlisted_kind(kind: str) -> bool:
    """True iff ``kind`` has a declared redaction allowlist (used by arch tests)."""
    return kind in _ALLOWLISTS


def redact(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Project ``payload`` through ``kind``'s allowlist (the single redaction choke point).

    Deny-by-omission: only declared keys survive, each value-redacted. An UNKNOWN kind
    fails closed (whole payload dropped) — a new owner must declare its allowlist here.
    Never raises.
    """
    rules = _ALLOWLISTS.get(kind)
    if rules is None:
        return {"_unredacted_kind": True}  # fail-closed: undeclared kind persists no payload
    if not isinstance(payload, dict):
        return {}  # total: a non-dict payload (None / scalar) projects to nothing, never raises
    out: dict[str, Any] = {}
    for key, rule in rules.items():
        # Read ONLY the allowlisted keys, via the UNBOUND base-dict methods. This:
        #  (1) bypasses any subclass override of __contains__/__getitem__/keys/__iter__
        #      (a hostile/buggy subclass can't raise, hang, or OOM us), and
        #  (2) stays O(allowlist) — we NEVER copy or iterate the whole payload, so a giant
        #      bag of unknown top-level fields (deny-by-omission) costs nothing.
        try:
            if not dict.__contains__(payload, key):
                continue
            raw = dict.__getitem__(payload, key)
        except Exception:  # noqa: BLE001 - totality on the persist path; never raise
            continue
        try:
            result = rule(raw)
        except Exception:  # noqa: BLE001 - drop a value that blew up rather than leak it
            continue
        if result is not _DROP:
            out[key] = result
    return out
