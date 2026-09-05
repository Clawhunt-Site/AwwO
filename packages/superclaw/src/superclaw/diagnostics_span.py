"""The ``span()`` primitive — framework foundation for §5 diagnostic spans (P0b-1b).

A span is one bounded step of work (config resolve, governance decision, backend call,
tool exec, state transition, …). Entering a span binds a fresh ``span_id`` for the
block and records a ``span.start`` receipt; leaving it records ``span.end`` (with
duration) or ``span.error`` (with the exception type) — all through the single-writer
:mod:`superclaw.diagnostics_store` engine (P0b-1a). The span tree is reconstructed from
``trace_id`` + ``span_id``/``parent_span_id``.

**Internal foundation — NOT yet wired to business owners.** This commit provides the
primitive and its parent-tracking + cross-process stitching; placing ``span()`` at the
§7.1 Coverage-Owner choke points (config resolver, governance gate, scheduler, …) and
the owner-map architecture tests are P0b-2. Per-kind redaction allowlist is P0b-1c, so
callers must keep span attributes small and non-sensitive until then.

Design (docs/observability-diagnostics-roadmap.md §5/§7):

* **Token reset, not manual parent restore.** The span binds ``span_id`` +
  ``parent_span_id`` via :func:`trace_context.bind`, whose context manager restores both
  on exit (ContextVar tokens). Nesting is automatic: an inner span's parent is the outer
  span's id; on exit the outer values are restored exactly.

* **Parent resolution.** The new span's parent is the current ``span_id`` if one is
  active (in-process nesting), else the inherited ``parent_span_id`` (a cross-process
  root span continues the parent's trace — see :func:`trace_context.export_env`, which
  remaps the parent's current span to the child's ``parent_span_id``). A child process
  therefore opens a fresh root span stitched under the parent span it was spawned from,
  rather than reusing the parent's (possibly already-ended) span id.

* **Bounded cardinality.** ``kind`` is a :class:`SpanKind` enum constant and the receipt
  ``kind`` column is one of three static strings (``span.start`` / ``span.end`` /
  ``span.error``); the span name and attributes live in the payload. This keeps the
  low-cardinality columns enumerable (no per-call interpolated strings).
"""
from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from enum import Enum
from typing import Any

from . import trace_context
from .diagnostics_redaction import redact
from .diagnostics_store import DiagnosticsStore, get_store
from .logging_config import get_logger

_log = get_logger("diagnostics.span")


class SpanKind(str, Enum):
    """The §5 environment a span belongs to (static, bounded set — no free strings)."""

    ENTRY = "entry"  # ① CLI/API entry
    CONFIG = "config"  # ②★ config/settings resolution
    ORCHESTRATION = "orchestration"  # ③ plan / decompose / backend·model selection
    GOVERNANCE = "governance"  # ④ pay-switch / fail-closed / gate / permission / signature
    SCHEDULING = "scheduling"  # ⑤★ claim / lease / lock / reconcile
    BACKEND = "backend"  # ⑥ backend / worker execution
    TOOL = "tool"  # ⑥ tool call
    RETRY = "retry"  # ⑦★ cancel / retry / timeout decision
    PROJECTION = "projection"  # ⑧ DisplayEvent / usage projection
    REDACTION = "redaction"  # ⑨★ redaction / truncation action
    STATE = "state"  # ⑩ lifecycle state transition
    PERSIST = "persist"  # ⑪★ persistence write
    EXIT = "exit"  # ⑬ run completion / verifier
    EXPORT = "export"  # export pipeline


_SPAN_START = "span.start"
_SPAN_END = "span.end"
_SPAN_ERROR = "span.error"


class SpanHandle:
    """Handle yielded by :func:`span`; collects attributes recorded at ``span.end``.

    Attributes set here are merged into the end receipt (NOT the start receipt), so a
    span can record a result summary / outcome computed during the block.
    """

    __slots__ = ("span_id", "parent_span_id", "_attributes")

    def __init__(self, span_id: str, parent_span_id: str | None) -> None:
        self.span_id = span_id
        self.parent_span_id = parent_span_id
        self._attributes: dict[str, Any] = {}

    def set(self, key: str, value: Any) -> None:
        """Record one attribute onto the span's end receipt."""
        self._attributes[key] = value

    def update(self, **attributes: Any) -> None:
        """Record several attributes onto the span's end receipt."""
        self._attributes.update(attributes)


@contextmanager
def span(
    name: str,
    *,
    kind: SpanKind,
    attributes: dict[str, Any] | None = None,
    critical: bool = False,
    store: DiagnosticsStore | None = None,
) -> Iterator[SpanHandle]:
    """Open a diagnostic span for the duration of the block.

    ``name`` must be a static constant (a per-owner identifier, e.g.
    ``"config.resolve"``) — never an interpolated/dynamic string — to bound cardinality.
    ``kind`` is a :class:`SpanKind`. ``critical=True`` marks the span lifecycle receipts
    as critical (durable-or-fail-closed); the default is diagnostic (lossy) for
    high-volume spans.

    Critical-receipt failure semantics:
      * On the **non-error path** (``span.start`` / ``span.end``) a critical
        :class:`DiagnosticPersistError` PROPAGATES to the caller, who must degrade /
        fail-closed (there is no business exception to mask).
      * On the **error path** (the block raised) the ORIGINAL business exception is
        always preserved — a failing ``span.error`` write is NOT propagated (that would
        mask the real error). Durability still holds: the engine journals + logs the
        critical receipt before ``record`` raises (P0b-1a), and a span-level error is
        logged so the degradation is visible.

    Internal foundation — see module docstring; owner wiring is P0b-2.
    """
    sink = store if store is not None else get_store()
    parent_span_id = trace_context.get("span_id") or trace_context.get("parent_span_id")
    span_id = trace_context.new_id("span")
    base_payload: dict[str, Any] = {"name": name, "span_kind": kind.value}
    if parent_span_id is not None:
        base_payload["parent_span_id"] = parent_span_id
    if attributes:
        base_payload["attributes"] = dict(attributes)

    started = time.monotonic()
    with trace_context.bind(span_id=span_id, parent_span_id=parent_span_id):
        # Redact at the owner choke point (P0b-1c): the engine is a generic sink, so the
        # span primitive projects every receipt through the per-kind allowlist (here
        # ``attributes`` is the free-form danger zone — keys kept, values redacted).
        sink.record(_SPAN_START, redact(_SPAN_START, base_payload), critical=critical)
        handle = SpanHandle(span_id, parent_span_id)
        try:
            yield handle
        except BaseException as exc:
            # Frilled error span (aligns with the roadmap's "every except emits a span").
            error_payload = {
                "name": name,
                "span_kind": kind.value,
                "error_type": type(exc).__name__,
                "error": str(exc),
                "duration_ms": round((time.monotonic() - started) * 1000, 3),
            }
            if handle._attributes:
                error_payload["attributes"] = dict(handle._attributes)
            # A failing error-receipt write must NEVER mask the in-flight business
            # exception (the caller's real fail-closed signal). We therefore re-raise
            # the original regardless. Durability is not lost: for a critical span the
            # engine has already journalled + logged the receipt before record() raised
            # (P0b-1a no-recursive fallback); we additionally surface a span-level
            # structured error so the degradation is visible at the span boundary.
            try:
                sink.record(_SPAN_ERROR, redact(_SPAN_ERROR, error_payload), critical=critical)
            except Exception as receipt_exc:  # noqa: BLE001 - never shadow the original
                if critical:
                    _log.error(
                        "span %r: critical span.error receipt failed to persist "
                        "(engine journalled; not masking original error): %s",
                        name,
                        receipt_exc,
                    )
            raise
        else:
            end_payload = {
                "name": name,
                "span_kind": kind.value,
                "duration_ms": round((time.monotonic() - started) * 1000, 3),
            }
            if handle._attributes:
                end_payload["attributes"] = dict(handle._attributes)
            sink.record(_SPAN_END, redact(_SPAN_END, end_payload), critical=critical)
