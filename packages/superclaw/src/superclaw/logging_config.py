"""Structured logging root configuration for SuperClaw (CLI + API).

Single, **idempotent** configuration point for the project's logging. Until
``configure_logging()`` is called, the ``superclaw.*`` loggers have no handler
and emit nothing (Python's default), which is exactly why production logs were
previously invisible. This wires one handler on the ``superclaw`` namespace
logger (NOT the root logger, so we never fight uvicorn / third-party logging),
with optional JSON formatting, an optional rotating file sink, and mandatory
secret redaction — all controlled by ``SUPERCLAW_LOG_*`` env vars.

This is P0a of the observability roadmap (docs/observability-diagnostics-roadmap.md).
trace-context fields (trace_id/run_id/...) are injected by
``TraceContextInjectingFilter`` from the kernel ``trace_context``; cross-thread /
cross-process propagation of that context is wired in the next commit.

Redaction is **record-level**: the filter scrubs the message, freezes a redacted
exception/stack text onto the record while clearing ``exc_info``, and redacts
string-valued ``extra=`` fields. This makes the common rendering paths
(message/exc/stack/str-extra) safe for a downstream/root handler or caplog. It is
**best-effort, not a total guarantee**: nested-container or arbitrary-object
``extra`` rendered via ``%(field)s``/``%(field)r`` by a foreign formatter is NOT
scrubbed. The standing guard for those is ``propagate=False`` **by default**
(defence in depth) — ``superclaw.*`` records never **bubble to a parent/root**
handler unless an operator opts in via ``SUPERCLAW_LOG_PROPAGATE``. (Scope of the
guarantee: the *managed* handlers we install always redact; a handler a caller
attaches directly to the ``superclaw`` logger is outside this guard and is the
caller's responsibility.) As always, callers must not place secrets in structured
log fields in the first place.

Kept to stdlib + ``secrets_scan`` + ``trace_context`` (all stdlib-only beneath)
to avoid import cycles.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler

from . import trace_context
from .secrets_scan import redact_secrets

# --- env knobs --------------------------------------------------------------
LOG_LEVEL_ENV = "SUPERCLAW_LOG_LEVEL"  # DEBUG|INFO|WARNING|ERROR|CRITICAL
LOG_FORMAT_ENV = "SUPERCLAW_LOG_FORMAT"  # "text" (default) | "json"
LOG_FILE_ENV = "SUPERCLAW_LOG_FILE"  # optional path -> rotating file handler
LOG_FILE_MAX_BYTES_ENV = "SUPERCLAW_LOG_FILE_MAX_BYTES"
LOG_FILE_BACKUPS_ENV = "SUPERCLAW_LOG_FILE_BACKUPS"
LOG_PROPAGATE_ENV = "SUPERCLAW_LOG_PROPAGATE"  # opt-in propagation (caplog/aggregation)

_DEFAULT_LEVEL = "INFO"
_DEFAULT_FORMAT = "text"
_VALID_FORMATS = ("text", "json")
_DEFAULT_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB
_DEFAULT_BACKUPS = 5
_LOG_FILE_MODE = 0o600
_TRUTHY = ("1", "true", "yes", "on")

_BASE_LOGGER = "superclaw"
_TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
# Extra record attributes surfaced into structured output once trace context
# (next commit) starts setting them. Listed here so JSON output is stable.
_TRACE_FIELDS = ("trace_id", "run_id", "span_id", "parent_span_id", "export_id", "request_id")

# Marker attributes so re-invocation is a no-op and our handlers are replaceable.
_CONFIGURED_FLAG = "_superclaw_logging_configured"
_MANAGED_HANDLER_FLAG = "_superclaw_managed"

# Stateless helper to render exception tuples for record-level redaction.
_EXC_RENDERER = logging.Formatter()

# Standard LogRecord attributes; anything else on a record is caller-provided
# ``extra=`` payload that must be redacted before it can reach a foreign handler.
_STD_RECORD_FIELDS = frozenset(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "taskName"}


class SecretRedactingFilter(logging.Filter):
    """Scrub secrets from the record itself before it reaches any handler.

    The single source of truth for *what* counts as a secret is ``secrets_scan``
    (shared with adversarial leak detection), so redaction here can never drift
    from detection there. We redact the rendered message, freeze a redacted
    exception/stack text onto the record while dropping the raw ``exc_info``
    (otherwise a downstream/root handler or ``caplog`` would re-render the
    original traceback and leak it), and redact string-valued ``extra=`` fields
    (best-effort: nested containers / arbitrary objects are NOT covered — the
    standing guard for those is ``propagate=False`` by default).

    Failure policy: **fail-closed on content, fail-open on control flow**. A
    filter that raises propagates the exception straight back into the caller's
    ``logger.info(...)`` (unlike ``emit`` errors, which go through
    ``handleError``), so we must catch broadly and substitute a visible marker
    rather than crash the emitting code path or pass content through unredacted.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            record.msg = redact_secrets(message)
            record.args = ()
        except Exception:  # noqa: BLE001 - logging must never crash its caller
            record.msg = "[log-redaction-error]"
            record.args = ()
        try:
            if record.exc_info:
                record.exc_text = redact_secrets(_EXC_RENDERER.formatException(record.exc_info))
                record.exc_info = None
            elif record.exc_text:
                record.exc_text = redact_secrets(record.exc_text)
            if record.stack_info:
                record.stack_info = redact_secrets(record.stack_info)
        except Exception:  # noqa: BLE001 - never let traceback rendering crash logging
            record.exc_text = "[log-exc-redaction-error]"
            record.exc_info = None
            record.stack_info = None
        # Caller-provided ``extra=`` fields ride on the record too; redact their
        # string values so a foreign/root handler that renders them can't leak.
        try:
            for key, value in list(record.__dict__.items()):
                if key not in _STD_RECORD_FIELDS and isinstance(value, str):
                    record.__dict__[key] = redact_secrets(value)
        except Exception:  # noqa: BLE001 - extra-field redaction must not crash logging
            pass
        return True


class TraceContextInjectingFilter(logging.Filter):
    """Stamp the current trace/correlation fields onto each record.

    Reads the kernel ``trace_context`` (a ContextVar set at the operation's
    entry) so every log line emitted within an operation carries its
    ``trace_id``/``run_id``/etc. A caller that set the field explicitly via
    ``extra=`` wins (we never overwrite). Never raises — logging must not crash
    its caller.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            for key, value in trace_context.current().items():
                if not hasattr(record, key):
                    setattr(record, key, value)
        except Exception:  # noqa: BLE001 - trace injection must not break logging
            pass
        return True


class JsonLogFormatter(logging.Formatter):
    """Emit one JSON object per record (UTC ms timestamps, stable key set)."""

    def format(self, record: logging.LogRecord) -> str:
        ts = (
            time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z"
        )
        payload: dict[str, object] = {
            "ts": ts,
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for field in _TRACE_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        # exc_info is normally cleared by the filter into exc_text; honour both.
        if record.exc_text:
            payload["exc"] = record.exc_text
        elif record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = record.stack_info
        # Final-output redaction backstop: idempotent, and replacing secret spans
        # inside string values keeps the JSON valid.
        return redact_secrets(json.dumps(payload, ensure_ascii=False))


class RedactingTextFormatter(logging.Formatter):
    """Text formatter that redacts the fully-rendered line (msg + exc + stack)."""

    def format(self, record: logging.LogRecord) -> str:
        return redact_secrets(super().format(record))


class SecureRotatingFileHandler(RotatingFileHandler):
    """RotatingFileHandler that re-applies 0600 on every (re)open, incl. rollover.

    ``_open`` is called for the initial file and again after each rollover, so
    chmod here keeps the active file private; rotated backups inherit the mode
    because rollover renames the already-hardened active file.
    """

    def _open(self):  # type: ignore[override]
        stream = super()._open()
        try:
            os.chmod(self.baseFilename, _LOG_FILE_MODE)
        except OSError:
            pass  # platform may not support chmod (e.g. Windows); non-fatal
        return stream


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _resolve_propagate() -> bool:
    """Default False (production safety: never bubble ``superclaw.*`` records to a
    parent/root handler). Opt in via ``SUPERCLAW_LOG_PROPAGATE`` for
    caplog/aggregation — record-level redaction keeps that path safe too."""
    raw = os.environ.get(LOG_PROPAGATE_ENV)
    if raw is None:
        return False
    return raw.strip().lower() in _TRUTHY


def _make_handler(stream_or_path: object, fmt: str) -> logging.Handler:
    if isinstance(stream_or_path, str):
        handler: logging.Handler = SecureRotatingFileHandler(
            stream_or_path,
            maxBytes=_int_env(LOG_FILE_MAX_BYTES_ENV, _DEFAULT_MAX_BYTES),
            backupCount=_int_env(LOG_FILE_BACKUPS_ENV, _DEFAULT_BACKUPS),
            encoding="utf-8",
        )
    else:
        handler = logging.StreamHandler(stream_or_path)
    handler.setFormatter(
        JsonLogFormatter() if fmt == "json" else RedactingTextFormatter(_TEXT_FORMAT)
    )
    # Inject trace fields first, then redact (trace ids are not secrets, but the
    # redaction filter's extra-scan harmlessly passes over them).
    handler.addFilter(TraceContextInjectingFilter())
    handler.addFilter(SecretRedactingFilter())
    setattr(handler, _MANAGED_HANDLER_FLAG, True)
    return handler


def configure_logging(*, force: bool = False) -> None:
    """Configure the ``superclaw`` namespace logger. Idempotent by default.

    Safe to call from every entry point (CLI ``main()``, API ``create_app()``);
    repeated calls are a no-op unless ``force=True`` (used by tests to re-read
    env). Never raises: a logging-setup failure must not take down the app.
    """
    base = logging.getLogger(_BASE_LOGGER)
    if getattr(base, _CONFIGURED_FLAG, False) and not force:
        return

    level_name = (os.environ.get(LOG_LEVEL_ENV) or _DEFAULT_LEVEL).upper()
    level = getattr(logging, level_name, None)
    if not isinstance(level, int):
        level = logging.INFO
    fmt = (os.environ.get(LOG_FORMAT_ENV) or _DEFAULT_FORMAT).lower()
    if fmt not in _VALID_FORMATS:
        fmt = _DEFAULT_FORMAT

    # Drop + close any handler we previously installed (idempotent re-config,
    # releasing file descriptors); leave foreign handlers untouched.
    for handler in list(base.handlers):
        if getattr(handler, _MANAGED_HANDLER_FLAG, False):
            base.removeHandler(handler)
            handler.close()

    base.addHandler(_make_handler(sys.stderr, fmt))

    log_file = os.environ.get(LOG_FILE_ENV)
    if log_file:
        try:
            base.addHandler(_make_handler(log_file, fmt))
        except OSError as exc:
            base.warning("could not open log file %s: %s", log_file, exc)

    base.setLevel(level)
    base.propagate = _resolve_propagate()
    setattr(base, _CONFIGURED_FLAG, True)


def get_logger(name: str) -> logging.Logger:
    """Return a ``superclaw.*`` child logger (the namespace this module configures)."""
    if name == _BASE_LOGGER or name.startswith(_BASE_LOGGER + "."):
        return logging.getLogger(name)
    return logging.getLogger(f"{_BASE_LOGGER}.{name}")
