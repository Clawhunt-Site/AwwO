"""Single-writer durable persistence engine for Tier B diagnostic receipts (P0b-1a).

**Internal kernel foundation — NOT a business API.** This module is the physically
isolated telemetry sink (``telemetry.db``) that the span primitive (P0b-1b) and the
§7.1 Coverage-Owner choke points (P0b-2) write through. Business code MUST NOT call
:meth:`DiagnosticsStore.record` directly — receipts are emitted only at the framework
choke points named in the roadmap's §7.1 owner map, so that "instrumentation as a
contract" (§7) stays a single necessary-passage per concern rather than scattered
``span()`` calls. Direct calls from feature code are a layering violation.

Design (docs/observability-diagnostics-roadmap.md §7.2, three-way adversarial-reviewed):

* **Single writer per process.** SQLite WAL gives single-writer/multi-reader; a second
  connection writing concurrently in the same process would hit ``SQLITE_BUSY``. So
  *every* ``execute`` / ``commit`` runs on one daemon thread that owns one connection
  (created in-thread, so ``check_same_thread`` is honoured). Producer threads
  communicate only via queues. Across *processes* (CLI + workers sharing one
  ``telemetry.db``) each process has its own single writer; SQLite's WAL file lock
  serialises them. ``busy_timeout`` is kept BELOW the critical ACK budget so a
  cross-process lock wait resolves into a real wait, not a premature fail-closed.

* **Critical receipts block on a commit ACK.** A critical receipt (governance denial,
  fail-closed decision, key state transition, signature result) goes on a *dedicated*
  critical queue and the calling thread blocks until the daemon has *committed* it.
  Commit-returned == durable (``synchronous=FULL`` + commit boundary; proven by the
  SIGKILL fault-injection test). On a single monotonic deadline (NOT two stacked
  timeouts) the caller gets :class:`DiagnosticPersistError` and must degrade /
  fail-closed — we never silently drop a critical fact (§7.2). The dedicated critical
  queue means a diagnostic flood can never starve the governance path
  (head-of-line-blocking avoidance).

* **No recursive fallback.** When a critical commit *fails* (or times out, or the
  queue is full), we do NOT re-enter ``telemetry.db`` (that risks the same lock/IO
  fault recursively). Instead the receipt is appended to an emergency append-only
  journal file and a structured error is logged on the §8 root logger. Each receipt
  carries a ``receipt_uid``; the db column is ``UNIQUE`` (``INSERT OR IGNORE``) and an
  operator dedupes db-vs-journal by uid (a late daemon commit after a timeout-journal
  is the only way a fact lands in both).

* **Diagnostic receipts are lossy.** High-noise diagnostic receipts (streaming spans,
  tool deltas, stdout/stderr fragments) ride a separate bounded queue; if it is full
  they are dropped and counted. The merged ``diagnostic_loss`` counter records
  ``{count, reasons}`` as ONE critical row per window — never one synchronous write per
  dropped receipt (which would avalanche under disk pressure). The merged counter is
  flushed on every daemon tick and on clean shutdown; an in-flight count is only lost
  on a hard SIGKILL within a single tick window (accepted for loss-accounting tier).

* **Crash safety.** The SIGTERM/SIGINT handler does the MINIMUM (set closing + wake
  the writer) and then triggers a clean interpreter exit so ``atexit`` drains+joins —
  it never calls ``join`` itself (joining inside a signal handler while a producer
  holds an internal lock would deadlock). ``atexit`` flush + writer ``join`` drain the
  queues on shutdown. A fail-fast directory-writable probe at open time turns an
  unwritable telemetry dir into an immediate, attributable error. A poisoned payload
  (cyclic / pathologically nested) can never kill the writer: serialization is
  defended and the daemon loop has a per-item backstop.

* **Bounded growth (retention, P0b-1d).** ``telemetry.db`` is append-only by nature,
  so the daemon runs a periodic (hourly) retention pass that deletes OLD *diagnostic*
  receipts by age (``SUPERCLAW_TELEMETRY_RETENTION_DAYS``, default 7) and by a row cap
  (``SUPERCLAW_TELEMETRY_MAX_DIAG_ROWS``), then checkpoint-truncates the WAL to reclaim
  disk. CRITICAL (audit) receipts are NEVER pruned (§7.2: cleanup must not erode the
  audit boundary). A retention failure is logged and swallowed — it never kills the
  writer or blocks the receipt path.

This engine is a GENERIC durable sink — its persistence path persists the payload it is
given, applying only structural bounds (kind length, payload byte cap). Per-kind
REDACTION (allowlist projection — :mod:`superclaw.diagnostics_redaction`, P0b-1c) is
applied by each receipt AUTHOR via the shared ``redact`` function: the §7.1 owners (the
span primitive and ``diagnostics_owners``) redact their receipts before calling
``record``, and the engine redacts the ONE receipt it authors itself (``diagnostic_loss``)
in ``_flush_loss``. The generic ``record`` / ``_build_receipt`` path carries no domain
allowlist — redaction is the author's necessary-passage, kept out of the sink mechanics.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import signal
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from . import trace_context
from .diagnostics_redaction import redact as _redact_payload
from .logging_config import get_logger

_log = get_logger("diagnostics")

# Bumped only on a destructive/altering migration (additive CREATE TABLE IF NOT
# EXISTS does not need a bump). Stamped into PRAGMA user_version at open.
SCHEMA_VERSION = 1

# Separate bounded queues so a diagnostic flood can never starve the critical path.
_CRITICAL_QUEUE_MAXSIZE = 4_096  # criticals are rare; full ⇒ writer is wedged/dead
_DIAG_QUEUE_MAXSIZE = 10_000  # lossy by contract; excess is dropped + counted
# Daemon wakes at least this often even with no traffic, so the merged
# diagnostic_loss counter and a pending shutdown are observed promptly.
_DAEMON_TICK_SECONDS = 0.5
# Max receipts pulled from one queue per daemon wake (bounds one transaction).
_DRAIN_BATCH_CAP = 256
# Default per-call budget for a critical receipt to be enqueued AND committed.
# Kept ABOVE the connection busy_timeout so cross-process lock contention waits
# rather than prematurely fail-closing the governance path.
_DEFAULT_CRITICAL_TIMEOUT = 8.0
_BUSY_TIMEOUT_MS = 5_000
_DB_FILE_MODE = 0o600
# Structural bounds (NOT redaction): keep cardinality / disk blowup bounded even if
# an owner mis-supplies a huge kind or payload. Redaction is P0b-1c.
_MAX_KIND_LEN = 128
_MAX_PAYLOAD_BYTES = 64 * 1024
# P0b-1d retention (bounded growth): the daemon periodically deletes OLD *diagnostic*
# receipts by age + a row cap. CRITICAL (audit) receipts are NEVER deleted (§7.2:
# cleanup must not erode the audit boundary). Hourly cadence (not every 0.5s tick).
_RETENTION_ENV_DAYS = "SUPERCLAW_TELEMETRY_RETENTION_DAYS"
_RETENTION_ENV_MAX_ROWS = "SUPERCLAW_TELEMETRY_MAX_DIAG_ROWS"
_DEFAULT_RETENTION_DAYS = 7.0
_DEFAULT_MAX_DIAG_ROWS = 500_000
_RETENTION_INTERVAL_SECONDS = 3600.0
# Delete in bounded chunks, checking for a pending critical between chunks, so a
# big first-run cleanup can never block the governance path past its ACK budget.
_RETENTION_CHUNK = 2_000

_REQUIRED_COLUMNS = frozenset(
    {
        "id", "receipt_uid", "occurred_at", "kind", "receipt_class",
        "trace_id", "run_id", "span_id", "parent_span_id", "request_id",
        "export_id", "payload",
    }
)


class DiagnosticPersistError(RuntimeError):
    """A *critical* receipt could not be confirmed durable (timeout or write fault).

    The caller MUST treat this as fail-closed: mark the run ``degraded`` or abort by
    governance semantics. It is never raised for diagnostic (lossy) receipts.
    """


class ReceiptClass(str, Enum):
    """Durability class of a receipt (§7.2 degradation contract)."""

    CRITICAL = "critical"  # must persist or the caller degrades / fail-closes
    DIAGNOSTIC = "diagnostic"  # best-effort; may be dropped + counted as loss


# Correlation fields snapshotted onto every receipt, mirroring trace_context._VARS
# (captured in the *producer* thread, since context vars are per-context).
_CORRELATION_FIELDS = ("trace_id", "run_id", "span_id", "parent_span_id", "request_id", "export_id")


@dataclass(frozen=True)
class Receipt:
    """An opaque, already-projected/redacted diagnostic fact ready to persist.

    ``kind`` must be a static enum constant supplied by the owner layer (never a
    free/interpolated string) to bound cardinality. ``payload`` is JSON-serializable
    and is treated as opaque by this engine.
    """

    kind: str
    receipt_class: ReceiptClass
    payload: dict[str, Any] = field(default_factory=dict)
    correlation: dict[str, str] = field(default_factory=dict)
    occurred_at: float = 0.0
    receipt_uid: str = ""


@dataclass
class _QueueItem:
    receipt: Receipt
    ack: threading.Event | None  # set after the daemon resolves this item (critical only)
    error: list[BaseException] = field(default_factory=list)  # daemon writes the failure here


def _snapshot_correlation() -> dict[str, str]:
    """Capture the producer thread's current correlation ids (non-None only)."""
    snap: dict[str, str] = {}
    for fieldname in _CORRELATION_FIELDS:
        value = trace_context.get(fieldname)
        if value is not None:
            snap[fieldname] = value
    return snap


def _default_connect(path: Path) -> sqlite3.Connection:
    """Open the single daemon-owned connection (created on the daemon thread)."""
    conn = sqlite3.connect(path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
    # FULL (not NORMAL): this is the critical-audit sink. FULL fsyncs every commit
    # so "commit returned == durable" survives power loss, not just process kill.
    # Volume is low (critical receipts are rare; diagnostics are bounded), so the
    # extra fsync cost is acceptable for a diagnostic store.
    conn.execute("PRAGMA synchronous = FULL")
    return conn


class DiagnosticsStore:
    """The single-writer telemetry engine. One instance per process (see module getter)."""

    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        connect: Callable[[Path], sqlite3.Connection] | None = None,
        critical_timeout: float = _DEFAULT_CRITICAL_TIMEOUT,
        ready_timeout: float = 10.0,
        retention_seconds: float | None = None,
        max_diag_rows: int | None = None,
        retention_interval: float = _RETENTION_INTERVAL_SECONDS,
        install_signal_handlers: bool = True,
    ) -> None:
        self.path = Path(path)
        self._connect = connect or _default_connect
        self._critical_timeout = critical_timeout
        self._ready_timeout = ready_timeout
        self._journal_path = self.path.with_name(self.path.name + ".journal")
        self._critical_queue: queue.Queue[_QueueItem] = queue.Queue(maxsize=_CRITICAL_QUEUE_MAXSIZE)
        self._diag_queue: queue.Queue[_QueueItem] = queue.Queue(maxsize=_DIAG_QUEUE_MAXSIZE)
        self._wake = threading.Event()  # producers ring it; daemon waits on it
        # Merged diagnostic-loss accounting (drained by the daemon, one row/window).
        self._loss_lock = threading.Lock()
        self._loss_count = 0
        self._loss_reasons: dict[str, int] = {}
        self._closing = threading.Event()
        self._closed = threading.Event()
        self._ready = threading.Event()
        self._start_error: list[BaseException] = []
        # Retention (P0b-1d): bound diagnostic growth; criticals are never pruned.
        self._retention_seconds = (
            retention_seconds if retention_seconds is not None else _resolve_retention_seconds()
        )
        self._max_diag_rows = (
            max_diag_rows if max_diag_rows is not None else _resolve_max_diag_rows()
        )
        self._retention_interval = retention_interval  # tests set 0.0 to run every tick
        # None (not 0.0) ⇒ the first pass always runs: comparing a 0.0 baseline to
        # time.monotonic() (uptime) would gate retention OFF for the first hour after
        # boot on a freshly-started host/container.
        self._last_retention: float | None = None

        self._prepare_dir()  # fail-fast: an unwritable telemetry dir errors NOW
        self._thread = threading.Thread(
            target=self._run, name="superclaw-diagnostics-writer", daemon=True
        )
        self._thread.start()
        # Surface a schema/open failure on the daemon thread to the constructor.
        if not self._ready.wait(timeout=self._ready_timeout):
            # The writer never signalled ready (wedged in open / lock wait). Do NOT
            # return a half-built store whose criticals would silently time out —
            # fail-closed at construction (§7.2).
            self._closing.set()
            self._wake.set()
            raise DiagnosticPersistError(
                f"diagnostics writer did not become ready within {self._ready_timeout}s; "
                "refusing to open"
            )
        if self._start_error:
            raise self._start_error[0]

        if install_signal_handlers:
            self._install_signal_handlers()
        atexit.register(self.close)

    # -- producer-side API -------------------------------------------------

    def record(
        self,
        kind: str,
        payload: dict[str, Any] | None = None,
        *,
        critical: bool = False,
    ) -> None:
        """Persist a receipt. Critical receipts block until committed (or raise).

        Diagnostic receipts return immediately; if the queue is full they are dropped
        and counted (``diagnostic_loss``). NOT for direct business use — see module
        docstring; only the span primitive / §7.1 owners call this.
        """
        receipt = _build_receipt(
            kind=kind,
            receipt_class=ReceiptClass.CRITICAL if critical else ReceiptClass.DIAGNOSTIC,
            payload=payload,
            correlation=_snapshot_correlation(),
        )
        if critical:
            self._record_critical(receipt)
        else:
            self._record_diagnostic(receipt)

    def _record_diagnostic(self, receipt: Receipt) -> None:
        if self._closing.is_set():
            self._count_loss("store_closing")
            return
        try:
            self._diag_queue.put_nowait(_QueueItem(receipt=receipt, ack=None))
        except queue.Full:
            self._count_loss("queue_full")
            return
        self._wake.set()

    def _record_critical(self, receipt: Receipt) -> None:
        if self._closing.is_set():
            # No daemon will commit this; journal it so the fact survives, then
            # fail-closed so the caller degrades rather than proceeding silently.
            self._journal(receipt, reason="store_closing")
            raise DiagnosticPersistError(
                f"diagnostics store is shutting down; critical receipt {receipt.kind!r} not committed"
            )
        # A critical fact must persist WHOLE: silently truncating an oversized payload
        # would drop the governance reason / state edge / signature fact. Fail-closed so
        # the owner trims/summarizes (diagnostic receipts truncate; criticals do not).
        self._guard_critical_payload(receipt)
        deadline = time.monotonic() + self._critical_timeout
        item = _QueueItem(receipt=receipt, ack=threading.Event())
        # Criticals are rare and have their own queue: enqueue without blocking. A
        # full critical queue means the writer is wedged/dead → journal + fail-closed.
        try:
            self._critical_queue.put_nowait(item)
        except queue.Full:
            self._journal(receipt, reason="critical_queue_full")
            raise DiagnosticPersistError(
                f"diagnostics critical queue full; receipt {receipt.kind!r} not committed"
            ) from None
        self._wake.set()
        assert item.ack is not None
        remaining = deadline - time.monotonic()  # single budget, not two stacked timeouts
        if remaining <= 0 or not item.ack.wait(timeout=remaining):
            # Daemon too slow / wedged. Journal so the fact is not lost, then
            # fail-closed. The daemon may still commit later (deduped by uid).
            self._journal(receipt, reason="commit_timeout")
            raise DiagnosticPersistError(
                f"diagnostics commit timed out; critical receipt {receipt.kind!r} not confirmed durable"
            )
        if item.error:
            # Daemon already journalled + logged; re-raise to the caller as fail-closed.
            raise DiagnosticPersistError(
                f"diagnostics commit failed; critical receipt {receipt.kind!r} not durable"
            ) from item.error[0]

    def _guard_critical_payload(self, receipt: Receipt) -> None:
        """Reject an oversized *critical* payload (fail-closed, never silent-truncate).

        A poison payload (cyclic / deeply nested) is NOT an oversize error — the daemon
        will persist a safe placeholder for it (writer-protection), so we let it pass.
        """
        try:
            text = json.dumps(receipt.payload, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001 - poison handled downstream as a placeholder
            return
        if len(text.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
            self._journal(receipt, reason="critical_payload_too_large")
            raise DiagnosticPersistError(
                f"critical receipt {receipt.kind!r} payload exceeds {_MAX_PAYLOAD_BYTES} bytes; "
                "trim/summarize before recording (fail-closed: criticals are not truncated)"
            )

    def _count_loss(self, reason: str) -> None:
        with self._loss_lock:
            self._loss_count += 1
            self._loss_reasons[reason] = self._loss_reasons.get(reason, 0) + 1

    # -- daemon-side (single writer) ---------------------------------------

    def _run(self) -> None:
        try:
            conn = self._connect(self.path)
            self._init_schema(conn)
        except BaseException as exc:  # noqa: BLE001 - surface to constructor
            self._start_error.append(exc)
            self._ready.set()
            return
        self._ready.set()
        try:
            while True:
                self._wake.wait(timeout=_DAEMON_TICK_SECONDS)
                self._wake.clear()  # clear BEFORE draining so no wakeup is lost
                criticals = self._drain(self._critical_queue)
                diagnostics = self._drain(self._diag_queue)
                self._flush_loss(conn)  # merged diagnostic_loss → one critical row
                for item in criticals:  # priority: each critical gets its own commit
                    self._commit_critical(conn, item)
                self._flush_diagnostics(conn, diagnostics)
                self._apply_retention(conn)  # bounded growth (P0b-1d); criticals untouched
                if (
                    self._closing.is_set()
                    and self._critical_queue.empty()
                    and self._diag_queue.empty()
                ):
                    self._flush_loss(conn)
                    break
        finally:
            try:
                conn.close()
            except Exception:  # pragma: no cover - close is best-effort
                pass
            self._closed.set()

    @staticmethod
    def _drain(q: queue.Queue[_QueueItem]) -> list[_QueueItem]:
        batch: list[_QueueItem] = []
        while len(batch) < _DRAIN_BATCH_CAP:
            try:
                batch.append(q.get_nowait())
            except queue.Empty:
                break
        return batch

    def _flush_diagnostics(self, conn: sqlite3.Connection, items: list[_QueueItem]) -> None:
        if not items:
            return
        try:
            with conn:
                for item in items:
                    conn.execute(*self._insert_sql(item.receipt))
        except Exception as exc:  # noqa: BLE001 - diagnostics are lossy by contract
            # Don't journal high-noise diagnostics; fold them into the merged counter.
            for _ in items:
                self._count_loss("diagnostic_write_failed")
            _log.warning(
                "diagnostics: dropped %d diagnostic receipts on write failure: %s",
                len(items),
                exc,
            )

    def _commit_critical(self, conn: sqlite3.Connection, item: _QueueItem) -> None:
        receipt = item.receipt
        try:
            with conn:  # commits on clean exit; "commit returned == durable"
                conn.execute(*self._insert_sql(receipt))
        except BaseException as exc:  # noqa: BLE001 - never silently drop a critical fact
            # No recursive fallback into telemetry.db: journal + structured log.
            self._journal(receipt, reason="critical_write_failed")
            _log.error(
                "diagnostics: critical receipt %r failed to persist (journalled): %s",
                receipt.kind,
                exc,
            )
            item.error.append(exc)
        finally:
            if item.ack is not None:
                item.ack.set()

    def _flush_loss(self, conn: sqlite3.Connection) -> None:
        # try-acquire (never block the writer): if a producer is mid-_count_loss —
        # e.g. interrupted there by a signal — the writer must not stall on the lock
        # (that is the signal-handler deadlock class). Defer to the next tick instead.
        if not self._loss_lock.acquire(timeout=0.1):
            return
        try:
            if self._loss_count == 0:
                return
            count, reasons = self._loss_count, dict(self._loss_reasons)
            self._loss_count = 0
            self._loss_reasons = {}
        finally:
            self._loss_lock.release()
        # The engine AUTHORS this one receipt itself (no owner does), so it redacts its
        # own payload through the shared allowlist — every receipt author redacts.
        loss_receipt = _build_receipt(
            kind="diagnostic_loss",
            receipt_class=ReceiptClass.CRITICAL,
            payload=_redact_payload("diagnostic_loss", {"count": count, "reasons": reasons}),
            correlation={},
        )
        try:
            with conn:
                conn.execute(*self._insert_sql(loss_receipt))
        except BaseException as exc:  # noqa: BLE001
            # The loss marker itself is critical; journal it, but DO NOT re-add to
            # the counter (that would spin every tick under a persistent fault).
            self._journal(loss_receipt, reason="loss_marker_write_failed")
            _log.error("diagnostics: diagnostic_loss marker failed to persist (journalled): %s", exc)

    def _apply_retention(self, conn: sqlite3.Connection) -> None:
        """Periodic bounded-growth pass on the single writer (P0b-1d).

        Runs at most hourly (not every tick). Deletes OLD *diagnostic* receipts by
        age + row cap and checkpoint-truncates the WAL; NEVER touches CRITICAL
        receipts (§7.2 audit boundary). Any failure is logged and swallowed — a
        retention fault must never kill the writer or block the receipt path.
        """
        now = time.monotonic()
        if not _should_run_retention(self._last_retention, now, self._retention_interval):
            return
        # Yield the writer to a pending governance receipt: never let a diagnostic
        # maintenance pass delay a critical past its ACK budget (§7.2 — diagnostics
        # must not starve the critical path). Skip this tick; retry next.
        if not self._critical_queue.empty():
            return
        previous = self._last_retention
        self._last_retention = now  # tentative; rewound below if the pass didn't complete
        try:
            deleted, complete = _run_retention(
                conn,
                retention_seconds=self._retention_seconds,
                max_diag_rows=self._max_diag_rows,
                should_yield=lambda: not self._critical_queue.empty(),
            )
            if not complete:
                # Yielded to a pending critical mid-pass: keep the OLD stamp so the NEXT
                # tick continues the backlog instead of waiting a full interval (bounded
                # growth must converge promptly). A busy WAL checkpoint does NOT land here.
                self._last_retention = previous
            if deleted:
                _log.info("diagnostics: retention removed %d old diagnostic receipts", deleted)
        except Exception as exc:  # noqa: BLE001 - retention must never kill the writer
            # A failed pass KEEPS the new stamp: don't hot-loop a failing retention every
            # tick — retry next interval.
            _log.warning("diagnostics: retention pass failed: %s", exc)

    @staticmethod
    def _insert_sql(receipt: Receipt) -> tuple[str, tuple[Any, ...]]:
        corr = receipt.correlation
        return (
            # OR IGNORE: receipt_uid is UNIQUE; a re-attempt of an identical uid is a
            # no-op rather than a duplicate row (db-vs-journal dedup is by uid).
            """
            INSERT OR IGNORE INTO receipts
                (receipt_uid, occurred_at, kind, receipt_class,
                 trace_id, run_id, span_id, parent_span_id, request_id, export_id, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                receipt.receipt_uid,
                receipt.occurred_at,
                receipt.kind,
                receipt.receipt_class.value,
                corr.get("trace_id"),
                corr.get("run_id"),
                corr.get("span_id"),
                corr.get("parent_span_id"),
                corr.get("request_id"),
                corr.get("export_id"),
                _safe_json(receipt.payload),
            ),
        )

    # -- open / schema / hardening -----------------------------------------

    def _prepare_dir(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise DiagnosticPersistError(
                f"telemetry directory {parent} could not be created: {exc}"
            ) from exc
        # Owner-only directory is the real privacy boundary for the db AND its WAL/SHM
        # sidecars (SQLite may recreate sidecars with umask perms after a checkpoint;
        # a 0700 parent keeps them unreadable by other users regardless). Best-effort.
        try:
            os.chmod(parent, 0o700)
        except OSError:  # pragma: no cover - platform without chmod semantics
            pass
        # Fail-fast writable probe: better an immediate, attributable error than a
        # silent per-write failure on the daemon thread later.
        probe = parent / f".telemetry-writeprobe-{uuid.uuid4().hex}"
        try:
            probe.write_text("ok", encoding="utf-8")
        except OSError as exc:
            raise DiagnosticPersistError(
                f"telemetry directory {parent} is not writable: {exc}"
            ) from exc
        finally:
            try:
                probe.unlink()
            except OSError:
                pass

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise DiagnosticPersistError(
                f"telemetry DB schema version {current} is newer than this build "
                f"understands ({SCHEMA_VERSION}); refusing to open"
            )
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.OperationalError:  # pragma: no cover - e.g. :memory:
            pass
        # A pre-existing/foreign ``receipts`` table that lacks our columns must NOT be
        # touched: CREATE TABLE IF NOT EXISTS won't add columns and the index DDL would
        # then fail mid-script on the missing column. Check the shape FIRST, fail-closed.
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(receipts)")}
        if existing:
            missing = _REQUIRED_COLUMNS - existing
            if missing:
                raise DiagnosticPersistError(
                    f"telemetry DB receipts table is missing columns {sorted(missing)}; "
                    "refusing to open a structurally-incompatible database"
                )
            # Columns alone are not enough: a foreign/older table with all columns but
            # no UNIQUE(receipt_uid) would let duplicate criticals land (the db↔journal
            # dedup contract relies on the constraint). Verify it, fail-closed.
            if not _has_unique_index(conn, "receipt_uid"):
                raise DiagnosticPersistError(
                    "telemetry DB receipts table lacks a UNIQUE constraint on receipt_uid; "
                    "refusing to open (duplicate-critical dedup would not hold)"
                )
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS receipts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                receipt_uid TEXT NOT NULL UNIQUE,
                occurred_at REAL NOT NULL,
                kind TEXT NOT NULL,
                receipt_class TEXT NOT NULL,
                trace_id TEXT,
                run_id TEXT,
                span_id TEXT,
                parent_span_id TEXT,
                request_id TEXT,
                export_id TEXT,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_receipts_trace ON receipts(trace_id, id);
            CREATE INDEX IF NOT EXISTS idx_receipts_run ON receipts(run_id, id);
            CREATE INDEX IF NOT EXISTS idx_receipts_kind ON receipts(kind, id);
            -- retention (P0b-1d): make age + row-cap pruning index-bound, not full scans.
            CREATE INDEX IF NOT EXISTS idx_receipts_class_occurred ON receipts(receipt_class, occurred_at);
            CREATE INDEX IF NOT EXISTS idx_receipts_class_id ON receipts(receipt_class, id);
            """
        )
        with conn:
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            # DB-incarnation stamp for the telemetry upload cursor's reincarnation
            # guard: a uuid that changes only when this telemetry.db is recreated.
            from .db_incarnation import ensure_incarnation

            ensure_incarnation(conn)
        self._harden_db_files()

    def _harden_db_files(self) -> None:
        # 0600 on the main db AND its WAL/SHM sidecars — under WAL the -wal file holds
        # committed-but-not-checkpointed receipts, so it is just as sensitive.
        for suffix in ("", "-wal", "-shm"):
            target = self.path if not suffix else self.path.with_name(self.path.name + suffix)
            try:
                if target.exists():
                    os.chmod(target, _DB_FILE_MODE)
            except OSError:  # pragma: no cover - e.g. platform without chmod semantics
                pass

    def _journal(self, receipt: Receipt, *, reason: str) -> None:
        """Emergency append-only journal — the NON-recursive fallback for criticals.

        Never re-enters telemetry.db. Append a JSON line and fsync so the fact
        survives even if telemetry.db is unwritable / locked / corrupt. Serialization
        is fully defended so a poisoned payload can never raise out of here.
        """
        # Bound the payload to a safe VALUE FIRST: a poison/oversized payload would
        # otherwise make the whole line collapse to a placeholder and lose the
        # receipt_uid / kind / reason metadata that the journal exists to preserve.
        line_obj = {
            "reason": reason,
            "receipt_uid": receipt.receipt_uid,
            "occurred_at": receipt.occurred_at,
            "kind": receipt.kind,
            "receipt_class": receipt.receipt_class.value,
            "correlation": receipt.correlation,
            "payload": _bounded_value(receipt.payload),
        }
        try:
            line = json.dumps(line_obj, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001 - never let the journal lose the core metadata
            line = json.dumps(
                {
                    "reason": reason,
                    "receipt_uid": receipt.receipt_uid,
                    "kind": receipt.kind,
                    "_journal_serialize_error": True,
                },
                ensure_ascii=False,
            )
        try:
            fd = os.open(self._journal_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, _DB_FILE_MODE)
            try:
                # O_CREAT mode only applies on creation; tighten an existing journal too.
                if hasattr(os, "fchmod"):  # POSIX only; absent on Windows
                    os.fchmod(fd, _DB_FILE_MODE)
                os.write(fd, (line + "\n").encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as exc:
            # Last resort: the structured root log is the final durable channel.
            _log.error(
                "diagnostics: emergency journal write failed for critical receipt %r (%s): %s",
                receipt.kind,
                reason,
                exc,
            )

    # -- shutdown ----------------------------------------------------------

    def _install_signal_handlers(self) -> None:
        # atexit cannot intercept a container/K8s SIGTERM; install a handler that
        # flushes then chains to the previous one. Only valid on the main thread.
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                previous = signal.getsignal(sig)
                signal.signal(sig, self._make_signal_handler(sig, previous))
            except (ValueError, OSError, RuntimeError):  # pragma: no cover - non-main thread
                pass

    def _make_signal_handler(self, sig: int, previous: Any) -> Callable[[int, Any], None]:
        def handler(signum: int, frame: Any) -> None:
            # MINIMAL work only: a signal handler must NOT join the writer — a
            # producer may be holding an internal lock at the interruption point, so
            # join-here would deadlock. Set closing + wake the writer; the clean
            # interpreter exit below triggers atexit → close() → join on the main
            # thread at a safe point (locks released by stack unwinding).
            self._closing.set()
            self._wake.set()
            if callable(previous):
                previous(signum, frame)  # e.g. default SIGINT handler raises KeyboardInterrupt
            else:
                # No prior handler to chain: exit cleanly (SystemExit runs atexit, so
                # the writer drains+joins) instead of dying by signal (atexit would
                # not run on a re-raised SIG_DFL, losing the flush).
                raise SystemExit(128 + signum)

        return handler

    def close(self, *, join_timeout: float = 10.0) -> None:
        """Drain the queues, commit pending receipts, and join the writer (idempotent)."""
        if self._closed.is_set():
            return
        self._closing.set()
        self._wake.set()  # wake the daemon promptly so it drains and exits
        self._thread.join(timeout=join_timeout)
        if self._thread.is_alive():
            # Don't fail silently: a wedged writer means pending receipts may be
            # unflushed. Surface it on the durable root log (§7.2).
            _log.error(
                "diagnostics: writer did not finish within %.1fs on close; "
                "pending receipts may be unflushed",
                join_timeout,
            )


def _bound_kind(kind: str) -> str:
    """Cap kind length to bound cardinality / column size (structural, not redaction)."""
    text = str(kind)
    return text if len(text) <= _MAX_KIND_LEN else text[:_MAX_KIND_LEN]


def _resolve_retention_seconds() -> float:
    raw = os.environ.get(_RETENTION_ENV_DAYS)
    if raw:
        try:
            days = float(raw)
            if days > 0:
                return days * 86_400.0
        except ValueError:
            pass
    return _DEFAULT_RETENTION_DAYS * 86_400.0


def _resolve_max_diag_rows() -> int:
    raw = os.environ.get(_RETENTION_ENV_MAX_ROWS)
    if raw:
        try:
            rows = int(raw)
            if rows > 0:
                return rows
        except ValueError:
            pass
    return _DEFAULT_MAX_DIAG_ROWS


def _should_run_retention(last: float | None, now: float, interval: float) -> bool:
    """Gate the retention pass. The FIRST pass (``last is None``) always runs —
    comparing a ``0.0`` baseline against ``time.monotonic()`` (uptime) would
    suppress retention for the first ``interval`` seconds after host boot."""
    return last is None or (now - last) >= interval


def _checkpoint_wal(conn: sqlite3.Connection) -> None:
    """Best-effort WAL truncation to reclaim disk after deletes. A BUSY checkpoint (a
    reader held the WAL) is logged and left for the NEXT cycle — we deliberately do NOT
    retry it every tick: retrying a busy TRUNCATE would block the single writer for up to
    ``busy_timeout`` each tick and starve the receipt path. The rows are already deleted,
    so bounded growth is met regardless of whether the WAL truncated this pass. Never raises."""
    try:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    except sqlite3.OperationalError:  # pragma: no cover - e.g. :memory: / non-WAL
        return
    if row is not None and row[0] == 1:  # (busy, log_pages, checkpointed_pages)
        _log.debug("diagnostics: wal_checkpoint(TRUNCATE) busy; WAL truncates next cycle")


def _run_retention(
    conn: sqlite3.Connection,
    *,
    retention_seconds: float,
    max_diag_rows: int,
    now: float | None = None,
    chunk: int = _RETENTION_CHUNK,
    should_yield: Callable[[], bool] | None = None,
) -> tuple[int, bool]:
    """Delete OLD *diagnostic* receipts (by age + row cap) in bounded chunks; returns
    ``(rows_deleted, complete)`` where ``complete`` is False ONLY if the pass yielded to a
    pending critical (caller continues next tick, NOT after a full interval). A BUSY WAL
    checkpoint does NOT make it incomplete: the rows are already deleted (bounded growth
    met) and the WAL truncates best-effort next cycle — retrying a busy checkpoint every
    tick would block the single writer (busy_timeout) and starve the receipt path.

    NEVER deletes CRITICAL receipts (governance denials, fail-closed decisions, key
    state edges, diagnostic_loss markers) — §7.2: retention must not erode the audit
    boundary; both DELETEs are scoped ``WHERE receipt_class = 'diagnostic'``.

    Chunked, and between chunks it checks ``should_yield``: if a critical receipt is
    waiting, it stops early and leaves the rest for the next pass, so a big first-run
    cleanup can never block the governance path past its ACK budget. The WAL is
    checkpoint-truncated only after a pass completes (a yield defers it to next time).
    """
    cutoff = (now if now is not None else time.time()) - retention_seconds
    diag = ReceiptClass.DIAGNOSTIC.value
    deleted = 0

    # 1) age-based, chunked (oldest first), yielding to pending criticals
    while True:
        with conn:
            cur = conn.execute(
                "DELETE FROM receipts WHERE id IN "
                "(SELECT id FROM receipts WHERE receipt_class = ? AND occurred_at < ? "
                " ORDER BY id ASC LIMIT ?)",
                (diag, cutoff, chunk),
            )
            n = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        deleted += n
        if n < chunk:
            break
        if should_yield is not None and should_yield():
            return deleted, False  # defer the rest (and the checkpoint) to the next tick

    # 2) row-cap, chunked: delete oldest diagnostics beyond the cap
    over = (
        conn.execute("SELECT COUNT(*) FROM receipts WHERE receipt_class = ?", (diag,)).fetchone()[0]
        - max_diag_rows
    )
    while over > 0:
        take = min(chunk, over)
        with conn:
            cur = conn.execute(
                "DELETE FROM receipts WHERE id IN "
                "(SELECT id FROM receipts WHERE receipt_class = ? ORDER BY id ASC LIMIT ?)",
                (diag, take),
            )
            n = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        deleted += n
        over -= n
        if n == 0:
            break
        if should_yield is not None and should_yield():
            return deleted, False

    _checkpoint_wal(conn)  # best-effort; a BUSY checkpoint does NOT mark the pass incomplete
    return deleted, True


def _build_receipt(
    *,
    kind: str,
    receipt_class: ReceiptClass,
    payload: dict[str, Any] | None,
    correlation: dict[str, str],
) -> Receipt:
    """Construct a Receipt (shared by ``record()`` and the daemon's ``_flush_loss``).

    The engine is a GENERIC durable sink: it persists what it is given (structurally
    bounded — kind length + payload byte cap). Per-kind REDACTION is a producer concern
    applied at the §7.1 owner choke points (``diagnostics_span.span`` /
    ``diagnostics_owners``) via the shared ``diagnostics_redaction.redact`` before the
    payload reaches here — keeping this sink free of domain allowlist coupling.
    """
    return Receipt(
        kind=_bound_kind(kind),
        receipt_class=receipt_class,
        payload=dict(payload or {}),
        correlation=dict(correlation),
        occurred_at=time.time(),
        receipt_uid=uuid.uuid4().hex,
    )


def _safe_json(payload: Any) -> str:
    """Serialize defensively for the DB column: a poisoned payload (cyclic / deeply
    nested) yields a safe placeholder rather than raising and killing the single
    writer; an oversized payload yields a truncation marker (diagnostics are lossy —
    criticals are guarded against oversize up-front in :meth:`_guard_critical_payload`)."""
    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception as exc:  # noqa: BLE001 - incl. RecursionError (a RuntimeError)
        return json.dumps({"_unserializable": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if len(text.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        return json.dumps(
            {"_truncated": True, "_original_bytes": len(text.encode("utf-8"))},
            ensure_ascii=False,
        )
    return text


def _bounded_value(payload: Any) -> Any:
    """Like :func:`_safe_json` but returns a json-safe, size-bounded VALUE (for nesting
    inside the journal line dict) rather than a serialized string."""
    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception as exc:  # noqa: BLE001 - incl. RecursionError
        return {"_unserializable": f"{type(exc).__name__}: {exc}"}
    if len(text.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        return {"_truncated": True, "_original_bytes": len(text.encode("utf-8"))}
    return payload


def _has_unique_index(conn: sqlite3.Connection, column: str) -> bool:
    """True iff ``receipts`` has a UNIQUE index covering exactly ``column``."""
    for idx in conn.execute("PRAGMA index_list(receipts)"):
        if not idx["unique"]:
            continue
        cols = [r["name"] for r in conn.execute(f'PRAGMA index_info("{idx["name"]}")')]
        if cols == [column]:
            return True
    return False


# -- process-global accessor (lazy; NOT yet wired to any business owner) ----

_ENV_PATH = "SUPERCLAW_TELEMETRY_PATH"
_store_lock = threading.Lock()
_store: DiagnosticsStore | None = None


def resolve_telemetry_path() -> Path:
    """Resolve the telemetry DB path (env override, else ``~/.superclaw/telemetry.db``).

    Defaults under the HOME data root (``superclaw_home()``), NOT cwd-relative — a
    cwd-relative default would land sensitive telemetry inside an iCloud-synced repo
    checkout. NOTE: opening the store chmods the path's PARENT directory to 0700 (the
    privacy boundary for the db + WAL/SHM sidecars). When overriding via
    ``SUPERCLAW_TELEMETRY_PATH`` the parent must be a private / engine-owned directory.
    """
    from .environment import superclaw_data_path

    configured = os.environ.get(_ENV_PATH, "").strip()
    return Path(configured) if configured else superclaw_data_path("telemetry.db")


# -- read-only ledger access for the telemetry upload spooler (Tier B) ----------
#
# The spooler reads receipts to upload them. It MUST NOT construct the
# single-writer ``DiagnosticsStore`` (that opens a writer connection and would
# contend with the daemon's live engine). Instead it opens a STRICTLY read-only
# connection (``mode=ro``), exactly as ``diagnostic_bundle`` does. ``receipts.id``
# is ``INTEGER PRIMARY KEY AUTOINCREMENT`` — a monotonic insertion cursor.
#
# Unlike Tier A's ``cost_events`` (append-only, delete-blocked by trigger),
# receipts are subject to RETENTION (old *diagnostic* receipts are pruned by age /
# row-cap; critical/audit receipts are never pruned). So interior ids CAN vanish
# between cursor saves: callers MUST tolerate gaps and MUST NOT require an exact
# id-range reconstruction (Tier B is lossy by design). Tier B dedupes ROW-LEVEL
# (server (device_id, receipt_uid) ON CONFLICT) plus a content-keyed batch
# upload_id, so a retention-thinned re-send dedupes server-side instead of double-
# inserting the rows that survived (the id range is only the cursor envelope).
_RECEIPT_READ_COLUMNS = (
    "id", "receipt_uid", "occurred_at", "kind", "receipt_class", "trace_id",
    "run_id", "span_id", "parent_span_id", "request_id", "export_id", "payload",
)


def _open_receipts_readonly(path: Path) -> sqlite3.Connection:
    """Open ``path`` read-only (``mode=ro``); caller closes. Raises sqlite3.Error on
    an open failure — callers must let that PROPAGATE (a read failure is NOT 'nothing
    to read'; the absent-file case is handled separately, before this is called)."""
    from urllib.request import pathname2url

    uri = "file:" + pathname2url(str(path.resolve())) + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    return conn


def max_receipt_seq(path: Path | None = None) -> int:
    """The largest ``receipts.id`` (monotonic cursor), or 0 if the DB is ABSENT
    (legitimately empty — nothing recorded yet). Strictly read-only.

    A genuine read error (open/query failure on an existing file) is NOT swallowed
    — it PROPAGATES as ``sqlite3.Error``. The spooler MUST distinguish 'no data' from
    'could not read the data': masking a transient read failure as 0 would let the
    Tier B cursor advance past unread rows and silently drop them."""
    p = path or resolve_telemetry_path()
    if not p.exists():
        return 0
    conn = _open_receipts_readonly(p)
    try:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM receipts").fetchone()
        return int(row["m"]) if row is not None else 0
    finally:
        conn.close()


def read_db_incarnation(path: Path | None = None) -> str | None:
    """This telemetry.db's incarnation uuid via a strictly read-only connection, or
    None if the DB / meta row is absent or unreadable. Lets the telemetry cursor
    detect a reincarnated/restored telemetry.db without opening the writer engine."""
    p = path or resolve_telemetry_path()
    if not p.exists():
        return None
    try:
        conn = _open_receipts_readonly(p)
    except sqlite3.Error:
        return None
    try:
        from .db_incarnation import read_incarnation

        return read_incarnation(conn)
    finally:
        conn.close()


def list_receipts_after_seq(
    after: int,
    *,
    limit: int | None = None,
    until_seq: int | None = None,
    path: Path | None = None,
) -> list[tuple[int, dict[str, Any]]]:
    """Receipts with ``after < id <= until_seq`` (if given), ascending by id,
    capped at ``limit``. Returns ``[(id, row_as_dict), ...]``.

    Strictly read-only. An ABSENT DB returns ``[]`` (legitimately empty). An empty
    result on an EXISTING DB means the rows in that id window were genuinely pruned
    by retention (lossy Tier B) — the caller may advance the cursor past them.

    A genuine read error (open/query failure) is NOT swallowed — it PROPAGATES as
    ``sqlite3.Error``. The caller MUST treat a failed read differently from an empty
    window: advancing the cursor on a read failure would silently drop unread rows."""
    p = path or resolve_telemetry_path()
    if not p.exists():
        return []
    cols = ", ".join(_RECEIPT_READ_COLUMNS)
    sql = f"SELECT {cols} FROM receipts WHERE id > ?"
    params: list[Any] = [int(after)]
    if until_seq is not None:
        sql += " AND id <= ?"
        params.append(int(until_seq))
    sql += " ORDER BY id ASC"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    conn = _open_receipts_readonly(p)
    try:
        rows = conn.execute(sql, tuple(params)).fetchall()
    finally:
        conn.close()
    return [(int(r["id"]), {k: r[k] for k in _RECEIPT_READ_COLUMNS}) for r in rows]


def get_store() -> DiagnosticsStore:
    """Lazily construct the process-global store. Internal foundation only."""
    global _store
    with _store_lock:
        if _store is None:
            _store = DiagnosticsStore(resolve_telemetry_path())
        return _store


def reset_store_for_tests() -> None:
    """Close and drop the process-global store (test isolation)."""
    global _store
    with _store_lock:
        if _store is not None:
            _store.close()
            _store = None
