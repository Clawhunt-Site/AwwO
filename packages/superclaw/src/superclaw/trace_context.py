"""Process-wide trace / correlation context for SuperClaw (CLI + API + workers).

A single kernel-level source of correlation ids that thread through logs and
(later) span receipts, so one operation can be followed across the orchestrator,
workers, backends, and async / cross-process boundaries. Ids are generated in the
kernel — NOT in the HTTP layer — so a CLI invocation and an API request get
equivalent correlation (the roadmap's §5 "entry" requirement and the rule that
correlation must not be bound to FastAPI middleware).

This is P0a of the observability roadmap (docs/observability-diagnostics-roadmap.md).
Field set mirrors ``logging_config._TRACE_FIELDS``. Kept dependency-free
(stdlib only) so any module can import it without cycles.
"""
from __future__ import annotations

import contextvars
import os
import uuid
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager

# Correlation fields, each its own ContextVar (per-context, restored on reset).
_trace_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("superclaw_trace_id", default=None)
_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("superclaw_run_id", default=None)
_span_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("superclaw_span_id", default=None)
_parent_span_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "superclaw_parent_span_id", default=None
)
_export_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("superclaw_export_id", default=None)
_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("superclaw_request_id", default=None)

_VARS: dict[str, contextvars.ContextVar[str | None]] = {
    "trace_id": _trace_id,
    "run_id": _run_id,
    "span_id": _span_id,
    "parent_span_id": _parent_span_id,
    "export_id": _export_id,
    "request_id": _request_id,
}

# Cross-process channel: a child process inherits these env vars; a *superclaw*
# child reads them back via import_env() to continue the same trace. External
# backend CLIs ignore them (harmless), but the correlation is still recorded.
_ENV_PREFIX = "SUPERCLAW_TRACE_"
_ENV_NAMES: dict[str, str] = {key: f"{_ENV_PREFIX}{key.upper()}" for key in _VARS}


def new_id(prefix: str) -> str:
    """Generate a correlation id, matching the project's ``prefix_12hex`` shape."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def current() -> dict[str, str]:
    """Snapshot the currently-set (non-None) correlation fields."""
    snapshot: dict[str, str] = {}
    for key, var in _VARS.items():
        value = var.get()
        if value is not None:
            snapshot[key] = value
    return snapshot


def get(field: str) -> str | None:
    """Return one correlation field's current value (or None)."""
    var = _VARS.get(field)
    return var.get() if var is not None else None


@contextmanager
def bind(**fields: str | None) -> Iterator[dict[str, str]]:
    """Bind correlation fields for the duration of the block, restored on exit.

    Unknown keys are ignored; ``None`` values leave that field unchanged. Nesting
    is safe — each bind restores exactly what it set (ContextVar tokens), so an
    inner block can't clobber an outer one's values.
    """
    tokens: list[tuple[contextvars.ContextVar[str | None], contextvars.Token]] = []
    for key, value in fields.items():
        var = _VARS.get(key)
        if var is None or value is None:
            continue
        tokens.append((var, var.set(value)))
    try:
        yield current()
    finally:
        for var, token in reversed(tokens):
            var.reset(token)


def start_trace(
    *,
    trace_id: str | None = None,
    run_id: str | None = None,
    request_id: str | None = None,
    span_id: str | None = None,
) -> AbstractContextManager[dict[str, str]]:
    """Begin a trace: bind a fresh ``trace_id`` (generated if absent) + optional ids."""
    return bind(
        trace_id=trace_id or new_id("trace"),
        run_id=run_id,
        request_id=request_id,
        span_id=span_id,
    )


def export_env() -> dict[str, str]:
    """Current correlation fields rendered as env vars for a child to inherit.

    **Span boundary remap (P0b-1b):** a child process must NOT reuse the parent's
    (possibly already-ended) ``span_id``. So across the boundary the *current* span
    becomes the child's ``parent_span_id`` — the child opens its own fresh root span
    (via :func:`superclaw.diagnostics_span.span`) whose parent is this inherited id.
    The current ``parent_span_id`` is therefore dropped (the child's parent is the
    current span, not the current span's parent).
    """
    env: dict[str, str] = {}
    snapshot = current()
    have_span = "span_id" in snapshot
    for key, value in snapshot.items():
        # Drop the inherited parent ONLY when a current span supersedes it. With no
        # active span (e.g. a child that imported a parent but hasn't opened its own
        # span yet, then spawns a grandchild), the inherited parent_span_id MUST pass
        # through unchanged — otherwise the grandchild's root span becomes an orphan
        # and the cross-process trace is severed.
        if key == "parent_span_id" and have_span:
            continue
        target = "parent_span_id" if key == "span_id" else key
        if target in _ENV_NAMES:
            env[_ENV_NAMES[target]] = value
    return env


def child_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Build a child-process environment that carries the current trace context.

    Use this at every agent-spawning subprocess boundary so trace correlation
    follows the child (kernel ContextVar values never live in ``os.environ``).
    Starts from ``base`` (or a copy of ``os.environ``), **scrubs any stale
    ``SUPERCLAW_TRACE_*`` inherited in that base**, then stamps ONLY the current
    context — otherwise a parent's leftover trace env (e.g. a long-lived base env,
    or a superclaw child whose own parent set it) would leak into, or mix with,
    the child when the current context is empty or only partially bound.
    """
    env = dict(base) if base is not None else dict(os.environ)
    for env_name in _ENV_NAMES.values():
        env.pop(env_name, None)
    env.update(export_env())
    return env


def import_env(environ: dict[str, str] | None = None) -> AbstractContextManager[dict[str, str]]:
    """Bind correlation fields read back from a parent's env (returns a bind() CM).

    A child NEVER inherits ``span_id`` — it opens its own root span (see
    :func:`export_env`). We enforce that on the import side too, so a legacy / manual /
    stale ``SUPERCLAW_TRACE_SPAN_ID`` (e.g. from an older build or a long-lived worker)
    can't make the child reuse the parent's span: such a value is remapped to
    ``parent_span_id`` (only when an explicit ``PARENT_SPAN_ID`` is absent).
    """
    source = environ if environ is not None else os.environ
    fields: dict[str, str | None] = {}
    for key, env_name in _ENV_NAMES.items():
        if key == "span_id":
            continue  # never bind span_id from env — the child opens its own root span
        value = source.get(env_name)
        if value:
            fields[key] = value
    if not fields.get("parent_span_id"):
        legacy_span = source.get(_ENV_NAMES["span_id"])
        if legacy_span:
            fields["parent_span_id"] = legacy_span  # legacy SPAN_ID → child's parent
    return bind(**fields)
