"""Canonical display contract for the Agent Runtime Display Protocol.

THE single source of truth for the runtime <-> surface display schema (see
``docs/agent-runtime-display-protocol.md`` and the frozen implementation plan
``docs/agent-runtime-display-protocol-impl-roadmap.md``). Runtime projectors and
surfaces (Web / Desktop / API SSE) both speak this one canonical shape; no
surface re-derives tool/runtime semantics on its own.

First principle -- Full Disclosure:
  * what a runtime CAN provide MUST be shown (no silent drop);
  * what it truly cannot provide is set ``null`` and recorded in
    ``degraded_fields`` (honest degradation, never fabrication);
  * we NEVER reconstruct tool traces from natural-language transcript.

Dependency rule (DL2): this module stays dependency-light -- stdlib only, plus
the stdlib-only ``secrets_scan.redact_secrets`` -- so it can never import-cycle
with ``runtime`` / ``backends`` / ``orchestrator`` / ``ui_contracts``. An
import-cycle test (``test_display_contracts``) locks this down.

PR-1 scope is INERT: this defines the schema, enums, validators, truncation and
redaction helpers, and the field-level capability tier function. It changes NO
runtime emit behaviour and NO declared capability values -- projectors wiring is
PR-2 (codex) / PR-3 (claude).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from superclaw.secrets_scan import REDACTION_PLACEHOLDER, redact_secrets

# Schema version of the DisplayEvent envelope. Bumping it is a contract change
# that requires re-packaging the frozen desktop backend (see PR-7 notes).
SCHEMA_VERSION = 1

# Per-field inline budget. Larger input/output is truncated inline (with a
# ``truncated`` flag) and the full content travels via artifact refs. 10KB.
TRUNCATE_BUDGET_BYTES = 10_240


class EventType(str, Enum):
    """Canonical event catalogue (design doc section 5)."""

    # Streaming runtime MUST emit these.
    MESSAGE_DELTA = "message.delta"
    MESSAGE_COMPLETED = "message.completed"
    TOOL_STARTED = "tool.started"
    TOOL_DELTA = "tool.delta"
    TOOL_COMPLETED = "tool.completed"
    ERROR = "error"
    # Contract-known, capability-gated (emit only when the runtime provides it;
    # never fabricate when it does not).
    REASONING_DELTA = "reasoning.delta"
    REASONING_COMPLETED = "reasoning.completed"
    USAGE = "usage"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_RESOLVED = "approval.resolved"
    ADAPTER_DIAGNOSTIC = "adapter.diagnostic"


# MUST / gated split, surfaced through the contract payload for the front end.
MUST_EVENT_TYPES: tuple[str, ...] = (
    EventType.MESSAGE_DELTA.value,
    EventType.MESSAGE_COMPLETED.value,
    EventType.TOOL_STARTED.value,
    EventType.TOOL_DELTA.value,
    EventType.TOOL_COMPLETED.value,
    EventType.ERROR.value,
)
GATED_EVENT_TYPES: tuple[str, ...] = (
    EventType.REASONING_DELTA.value,
    EventType.REASONING_COMPLETED.value,
    EventType.USAGE.value,
    EventType.APPROVAL_REQUESTED.value,
    EventType.APPROVAL_RESOLVED.value,
    EventType.ADAPTER_DIAGNOSTIC.value,
)


class ToolKind(str, Enum):
    COMMAND = "command"
    FILE = "file"
    MCP = "mcp"
    BUILTIN = "builtin"
    APPROVAL = "approval"
    UNKNOWN = "unknown"


class ToolStatus(str, Enum):
    RUNNING = "running"
    OK = "ok"
    ERROR = "error"
    CANCELLED = "cancelled"


class StreamType(str, Enum):
    """``tool.delta.stream_type`` -- a closed enum so the front end never has to
    guess from a field name."""

    STDOUT = "stdout"
    STDERR = "stderr"
    PATCH = "patch"
    RESULT = "result"
    LOG = "log"
    PROGRESS = "progress"


class CallIdSource(str, Enum):
    RUNTIME = "runtime"
    PROJECTOR = "projector_synthesized"


class IdSource(str, Enum):
    """DisplayEvent identity source (DL5). durable run channel = SQLite id;
    chat-only realtime channel = projector-synthesised monotonic id; legacy
    backends that cannot supply an id = ``none`` (reducer degrades to append)."""

    SQLITE = "sqlite"
    SYNTHETIC = "synthetic"
    NONE = "none"


class CapabilityTier(str, Enum):
    FULL = "full"
    PARTIAL = "partial"
    BATCH = "batch"


# SSE stream-closed states (T1 / DL9). A run in one of these states is read via
# the non-streaming snapshot endpoint rather than the live ``/events`` SSE.
# Deliberately NOT the front end's ACTIVE_RUN_STATUSES (which treats the human
# gate as active). String literals avoid importing the heavy models module.
SNAPSHOT_STATES: frozenset[str] = frozenset(
    {"completed", "failed", "cancelled", "WAITING_FOR_HUMAN_GATE"}
)

_TIER_VALUES = frozenset(t.value for t in CapabilityTier)
_KIND_VALUES = frozenset(k.value for k in ToolKind)
_STATUS_VALUES = frozenset(s.value for s in ToolStatus)
_EVENT_TYPE_VALUES = frozenset(e.value for e in EventType)
_CALL_ID_SOURCE_VALUES = frozenset(s.value for s in CallIdSource)
_ID_SOURCE_VALUES = frozenset(s.value for s in IdSource)


@dataclass
class ToolCall:
    """Typed common fields + JSON escape hatch (DL6).

    ``command``/``file`` are strongly-typed projections; ``mcp``/plugin keep raw
    JSON but still pass through unified redaction + truncation. ``display{}`` and
    ``parent_call_id`` are intentionally dropped in v1 (front end derives
    title/summary from ``kind``; nested calls have no real source yet).
    """

    call_id: str
    call_id_source: str = CallIdSource.RUNTIME.value
    name: str | None = None
    kind: str = ToolKind.UNKNOWN.value
    status: str = ToolStatus.RUNNING.value
    input: Any = None
    output: Any = None
    degraded_fields: list[str] = field(default_factory=list)
    redacted_fields: list[str] = field(default_factory=list)
    truncated: dict[str, bool] = field(
        default_factory=lambda: {"input": False, "output": False}
    )
    artifact_refs: list[dict[str, Any]] | None = None
    exit_code: int | None = None
    duration_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DisplayEvent:
    """Canonical event envelope (design doc section 5 + DL5 id/id_source)."""

    type: str
    runtime_id: str
    seq: int
    ts: str
    capability_tier: str
    payload: dict[str, Any] = field(default_factory=dict)
    schema_version: int = SCHEMA_VERSION
    session_id: str | None = None
    run_id: str | None = None
    turn_id: str | None = None
    id: int | str | None = None
    id_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialise for SSE. Required fields always present; optional fields are
        omitted when ``None`` to keep the wire payload lean."""
        data: dict[str, Any] = {
            "schema_version": self.schema_version,
            "type": self.type,
            "seq": self.seq,
            "ts": self.ts,
            "runtime_id": self.runtime_id,
            "capability_tier": self.capability_tier,
            "payload": self.payload,
        }
        for opt in ("session_id", "run_id", "turn_id", "id", "id_source"):
            value = getattr(self, opt)
            if value is not None:
                data[opt] = value
        return data


def utc_now_iso() -> str:
    """ISO-8601 UTC timestamp helper for ``DisplayEvent.ts``."""
    return datetime.now(timezone.utc).isoformat()


def truncate_field(value: Any, budget: int = TRUNCATE_BUDGET_BYTES) -> tuple[Any, bool]:
    """Truncate a single field to ``budget`` UTF-8 bytes.

    Returns ``(value, was_truncated)``. Strings are byte-truncated in place;
    non-string values that serialise over budget are returned as a truncated
    JSON preview string. ``None`` passes through untouched.
    """
    if value is None:
        return None, False
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        if len(encoded) <= budget:
            return value, False
        return encoded[:budget].decode("utf-8", errors="ignore"), True
    try:
        serialized = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        serialized = str(value)
    encoded = serialized.encode("utf-8")
    if len(encoded) <= budget:
        return value, False
    return encoded[:budget].decode("utf-8", errors="ignore"), True


def redact_payload(value: Any) -> tuple[Any, list[str]]:
    """Recursively scrub secrets from a tool input/output payload.

    Returns ``(redacted_value, redacted_field_paths)``. Every string leaf is run
    through :func:`redact_secrets`; the dotted/bracketed path of each leaf that
    actually changed is recorded so the surface can show "已脱敏". The original
    value is never mutated. Run redaction BEFORE display (design doc section 7.4).

    Dict KEYS are scrubbed too (a secret can appear as a key): the scrubbed key is
    used both in the output and when building child paths, so a raw secret never
    leaks back through ``redacted_fields``. If two keys collide after scrubbing,
    last wins (a redacted view is intentionally lossy). Non-string scalars pass.
    """
    redacted_fields: list[str] = []

    def _walk(node: Any, path: str) -> Any:
        if isinstance(node, str):
            scrubbed = redact_secrets(node)
            if scrubbed != node:
                redacted_fields.append(path or "$")
            return scrubbed
        if isinstance(node, dict):
            result: dict[Any, Any] = {}
            for key, val in node.items():
                safe_key = redact_secrets(key) if isinstance(key, str) else key
                child_path = f"{path}.{safe_key}" if path else str(safe_key)
                if isinstance(key, str) and safe_key != key:
                    redacted_fields.append(f"{child_path} (key)")
                result[safe_key] = _walk(val, child_path)
            return result
        if isinstance(node, list):
            return [_walk(item, f"{path}[{idx}]") for idx, item in enumerate(node)]
        return node

    return _walk(value, ""), redacted_fields


def capability_tier(caps: Any) -> str:
    """Derive the user-visible tier label from a field-level capability object.

    Duck-typed (reads ``streaming``/``tool_lifecycle``/``tool_input``/
    ``tool_output`` attributes) so this module never imports
    ``RuntimeCapabilities`` and stays free of the runtime import graph. The field
    matrix is the source of truth; the tier is just a derived summary.
    """
    if not bool(getattr(caps, "streaming", False)):
        return CapabilityTier.BATCH.value
    if (
        bool(getattr(caps, "tool_lifecycle", False))
        and bool(getattr(caps, "tool_input", False))
        and bool(getattr(caps, "tool_output", False))
    ):
        return CapabilityTier.FULL.value
    return CapabilityTier.PARTIAL.value


def validate_display_event(event: DisplayEvent | dict[str, Any]) -> list[str]:
    """Validate a *canonical* DisplayEvent. Returns violations (empty == valid).

    Fail-closed: ``type`` must be a canonical :class:`EventType` value (so
    non-canonical strings like ``command.started``/``tool.failed``/typos cannot
    pass the contract gate and let a projector "fake-pass"). Task-level run
    lifecycle events (``run.*``/``command.*``) are NOT canonical DisplayEvents and
    are not routed through this validator.
    """
    data = event.to_dict() if isinstance(event, DisplayEvent) else dict(event)
    errors: list[str] = []
    etype = data.get("type")
    if not isinstance(etype, str) or not etype:
        errors.append("type: required non-empty string")
    elif etype not in _EVENT_TYPE_VALUES:
        errors.append(f"type: {etype!r} is not a canonical display event type")
    if data.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version: must be {SCHEMA_VERSION}")
    seq = data.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool):
        errors.append("seq: required int")
    if not data.get("ts"):
        errors.append("ts: required")
    if not data.get("runtime_id"):
        errors.append("runtime_id: required")
    if data.get("capability_tier") not in _TIER_VALUES:
        errors.append(f"capability_tier: must be one of {sorted(_TIER_VALUES)}")
    if not isinstance(data.get("payload"), dict):
        errors.append("payload: required object")
    id_source = data.get("id_source")
    if id_source is not None and id_source not in _ID_SOURCE_VALUES:
        errors.append(f"id_source: must be one of {sorted(_ID_SOURCE_VALUES)} or null")
    return errors


def validate_tool_call(tool_call: ToolCall | dict[str, Any]) -> list[str]:
    """Return a list of ToolCall contract violations (empty == valid)."""
    data = asdict(tool_call) if is_dataclass(tool_call) else dict(tool_call)
    errors: list[str] = []
    if not data.get("call_id"):
        errors.append("call_id: required non-empty string")
    if data.get("call_id_source") not in _CALL_ID_SOURCE_VALUES:
        errors.append(
            f"call_id_source: must be one of {sorted(_CALL_ID_SOURCE_VALUES)}"
        )
    if data.get("kind") not in _KIND_VALUES:
        errors.append(f"kind: must be one of {sorted(_KIND_VALUES)}")
    if data.get("status") not in _STATUS_VALUES:
        errors.append(f"status: must be one of {sorted(_STATUS_VALUES)}")
    truncated = data.get("truncated")
    if (
        not isinstance(truncated, dict)
        or set(truncated) != {"input", "output"}
        or not all(isinstance(v, bool) for v in truncated.values())
    ):
        errors.append("truncated: must be {'input': bool, 'output': bool}")
    return errors


def build_display_contract_payload() -> dict[str, Any]:
    """Machine-readable contract description for the front end to generate /
    lock its TS types from (single semantic source, no hand-kept TS copy)."""
    return {
        "schema_version": SCHEMA_VERSION,
        # Full canonical event vocabulary (union) + the MUST/gated split.
        "event_types": list(MUST_EVENT_TYPES) + list(GATED_EVENT_TYPES),
        "must_event_types": list(MUST_EVENT_TYPES),
        "gated_event_types": list(GATED_EVENT_TYPES),
        "tool_kinds": [k.value for k in ToolKind],
        "tool_statuses": [s.value for s in ToolStatus],
        "stream_types": [s.value for s in StreamType],
        "call_id_sources": [s.value for s in CallIdSource],
        "id_sources": [s.value for s in IdSource],
        "capability_tiers": [t.value for t in CapabilityTier],
        "snapshot_states": sorted(SNAPSHOT_STATES),
        "truncate_budget_bytes": TRUNCATE_BUDGET_BYTES,
        "redaction_placeholder": REDACTION_PLACEHOLDER,
        # Field schema so the front end locks its TS types from here and never
        # hand-writes the core envelope / tool-call structure (DL2).
        "envelope_fields": {
            "required": [
                "schema_version",
                "type",
                "seq",
                "ts",
                "runtime_id",
                "capability_tier",
                "payload",
            ],
            "optional": ["session_id", "run_id", "turn_id", "id", "id_source"],
        },
        # ``required`` mirrors what validate_tool_call() enforces present (incl.
        # truncated's shape); degraded_fields/redacted_fields are not validator-
        # enforced so they stay optional even though instances default them.
        "tool_call_fields": {
            "required": ["call_id", "call_id_source", "kind", "status", "truncated"],
            "optional": [
                "name",
                "input",
                "output",
                "degraded_fields",
                "redacted_fields",
                "artifact_refs",
                "exit_code",
                "duration_ms",
            ],
        },
        # Full machine-readable field types so the front end can generate/lock TS
        # types from here alone (type, nullable, enum binding via *_ref into the
        # vocab lists above, and sub-structure) — no hand-written core schema.
        "envelope_field_types": {
            "schema_version": {"type": "int", "const": SCHEMA_VERSION},
            "type": {"type": "string", "enum_ref": "event_types"},
            "seq": {"type": "int", "nullable": False, "note": "real int, not bool"},
            "ts": {"type": "string", "format": "iso8601"},
            "runtime_id": {"type": "string"},
            "capability_tier": {"type": "string", "enum_ref": "capability_tiers"},
            "payload": {"type": "object"},
            "session_id": {"type": "string", "nullable": True},
            "run_id": {"type": "string", "nullable": True},
            "turn_id": {"type": "string", "nullable": True},
            "id": {"type": ["int", "string"], "nullable": True},
            "id_source": {"type": "string", "enum_ref": "id_sources", "nullable": True},
        },
        "tool_call_field_types": {
            "call_id": {"type": "string"},
            "call_id_source": {"type": "string", "enum_ref": "call_id_sources"},
            "name": {"type": "string", "nullable": True},
            "kind": {"type": "string", "enum_ref": "tool_kinds"},
            "status": {"type": "string", "enum_ref": "tool_statuses"},
            "input": {"type": "json", "nullable": True},
            "output": {"type": ["json", "string"], "nullable": True},
            "degraded_fields": {"type": "array", "items": "string"},
            "redacted_fields": {"type": "array", "items": "string"},
            "truncated": {"type": "object", "shape": {"input": "bool", "output": "bool"}},
            "artifact_refs": {"type": "array", "items": "object", "nullable": True},
            "exit_code": {"type": "int", "nullable": True},
            "duration_ms": {"type": "int", "nullable": True},
        },
        # Where the runtime validation rules live (the contract's behavioural source).
        "validator_rules": {
            "display_event": "display_contracts.validate_display_event",
            "tool_call": "display_contracts.validate_tool_call",
        },
    }


__all__ = [
    "SCHEMA_VERSION",
    "TRUNCATE_BUDGET_BYTES",
    "EventType",
    "MUST_EVENT_TYPES",
    "GATED_EVENT_TYPES",
    "ToolKind",
    "ToolStatus",
    "StreamType",
    "CallIdSource",
    "IdSource",
    "CapabilityTier",
    "SNAPSHOT_STATES",
    "ToolCall",
    "DisplayEvent",
    "utc_now_iso",
    "truncate_field",
    "redact_payload",
    "capability_tier",
    "validate_display_event",
    "validate_tool_call",
    "build_display_contract_payload",
]
