"""Single-writer diagnostics persistence engine (P0b-1a).

Proves the §7.2 degradation contract end-to-end: critical receipts are durable on
commit-return (including across SIGKILL), critical write failures fall back to the
non-recursive emergency journal (never re-entering telemetry.db), and dropped
diagnostic receipts collapse into ONE merged ``diagnostic_loss`` row per window.
"""
from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from superclaw import diagnostics_store as ds
from superclaw import trace_context as tc


def _read_receipts(path: Path) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute("SELECT * FROM receipts ORDER BY id")]
    finally:
        conn.close()


def _wait_for(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


# -- critical durability ---------------------------------------------------


def test_critical_receipt_is_durable_on_return(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="trace_abc", run_id="run_xyz"):
            store.record("governance.denied", {"reason": "fail_closed"}, critical=True)
        # record() returned → the row must already be committed.
        rows = _read_receipts(path)
        assert len(rows) == 1
        assert rows[0]["kind"] == "governance.denied"
        assert rows[0]["receipt_class"] == "critical"
        assert rows[0]["trace_id"] == "trace_abc"
        assert rows[0]["run_id"] == "run_xyz"
        assert json.loads(rows[0]["payload"]) == {"reason": "fail_closed"}
    finally:
        store.close()


def test_diagnostic_receipt_is_persisted_eventually(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        store.record("tool.delta", {"chunk": 1}, critical=False)
        assert _wait_for(lambda: len(_read_receipts(path)) == 1)
        rows = _read_receipts(path)
        assert rows[0]["kind"] == "tool.delta"
        assert rows[0]["receipt_class"] == "diagnostic"
    finally:
        store.close()


def test_close_flushes_pending_and_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    store.record("tool.delta", {"n": 1}, critical=False)
    store.record("tool.delta", {"n": 2}, critical=False)
    store.close()
    store.close()  # idempotent
    assert len(_read_receipts(path)) == 2


# -- SIGKILL fault injection (commit-returned == durable) -------------------


def test_critical_durable_across_sigkill(tmp_path: Path) -> None:
    """A child records a critical receipt, then SIGKILLs itself with NO clean
    shutdown. The committed row must survive — proving durability is at the commit
    boundary, not at flush/join."""
    path = tmp_path / "telemetry.db"
    script = textwrap.dedent(
        f"""
        import os, signal
        from superclaw import diagnostics_store as ds
        store = ds.DiagnosticsStore({str(path)!r}, install_signal_handlers=False)
        store.record("governance.denied", {{"reason": "kill_test"}}, critical=True)
        # record() returned → committed. Die HARD with no flush/join/atexit.
        os.kill(os.getpid(), signal.SIGKILL)
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        env=os.environ.copy(),
        capture_output=True,
        timeout=30,
    )
    # The process was killed by SIGKILL (negative returncode on POSIX), not a clean exit.
    assert proc.returncode == -signal.SIGKILL
    rows = _read_receipts(path)
    assert len(rows) == 1
    assert rows[0]["kind"] == "governance.denied"
    assert json.loads(rows[0]["payload"]) == {"reason": "kill_test"}


# -- critical write failure → non-recursive emergency journal --------------


class _FaultyConn:
    """Wraps a real connection but raises on the receipts INSERT (write-fault injection)."""

    def __init__(self, real: sqlite3.Connection) -> None:
        self._real = real

    def execute(self, sql: str, *args):
        if "INTO receipts" in sql:
            raise sqlite3.OperationalError("injected write failure")
        return self._real.execute(sql, *args)

    def __enter__(self):
        return self._real.__enter__()

    def __exit__(self, *exc):
        return self._real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_critical_write_failure_journals_and_fails_closed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "telemetry.db"

    def faulty_connect(p: Path) -> sqlite3.Connection:
        return _FaultyConn(ds._default_connect(p))  # type: ignore[return-value]

    store = ds.DiagnosticsStore(path, connect=faulty_connect, install_signal_handlers=False)
    try:
        with caplog.at_level("ERROR", logger="superclaw.diagnostics"):
            with pytest.raises(ds.DiagnosticPersistError):
                store.record("governance.denied", {"reason": "fail_closed"}, critical=True)
        # Non-recursive fallback: the fact landed in the append-only journal...
        journal = path.with_name("telemetry.db.journal")
        assert journal.exists()
        entries = [json.loads(line) for line in journal.read_text().splitlines() if line]
        assert any(e["kind"] == "governance.denied" for e in entries)
        assert any(e["reason"] == "critical_write_failed" for e in entries)
        # ...and a structured error was logged on the root diagnostics logger.
        assert any("failed to persist" in r.message for r in caplog.records)
        # The poisoned receipt never reached telemetry.db (no recursion).
        assert _read_receipts(path) == []
    finally:
        store.close()


def test_journal_is_0600(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"

    def faulty_connect(p: Path) -> sqlite3.Connection:
        return _FaultyConn(ds._default_connect(p))  # type: ignore[return-value]

    store = ds.DiagnosticsStore(path, connect=faulty_connect, install_signal_handlers=False)
    try:
        with pytest.raises(ds.DiagnosticPersistError):
            store.record("k", {}, critical=True)
        journal = path.with_name("telemetry.db.journal")
        assert journal.exists()
        assert (journal.stat().st_mode & 0o777) == 0o600
    finally:
        store.close()


# -- diagnostic_loss merged accounting -------------------------------------


def test_diagnostic_loss_merges_into_one_row(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        # Simulate many dropped diagnostics within one window (the merge counter is
        # the choke point; the daemon flushes it as ONE critical row, not N rows).
        for _ in range(50):
            store._count_loss("queue_full")
        store._count_loss("diagnostic_write_failed")

        def _loss_row() -> dict | None:
            for row in _read_receipts(path):
                if row["kind"] == "diagnostic_loss":
                    return row
            return None

        assert _wait_for(lambda: _loss_row() is not None)
        row = _loss_row()
        assert row is not None
        assert row["receipt_class"] == "critical"  # the loss marker is itself critical
        payload = json.loads(row["payload"])
        assert payload["count"] == 51
        assert payload["reasons"] == {"queue_full": 50, "diagnostic_write_failed": 1}
        # Exactly ONE merged row, never one per dropped receipt.
        loss_rows = [r for r in _read_receipts(path) if r["kind"] == "diagnostic_loss"]
        assert len(loss_rows) == 1
    finally:
        store.close()


def test_diagnostic_loss_counter_resets_after_flush(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        store._count_loss("queue_full")
        assert _wait_for(
            lambda: any(r["kind"] == "diagnostic_loss" for r in _read_receipts(path))
        )
        # Counter drained → no second loss row appears without new losses.
        time.sleep(0.6)  # > one daemon tick
        loss_rows = [r for r in _read_receipts(path) if r["kind"] == "diagnostic_loss"]
        assert len(loss_rows) == 1
    finally:
        store.close()


# -- queue-full drop counts as loss (no block on diagnostics) --------------


def test_diagnostic_drop_on_full_queue_is_counted(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    # Tiny queue + a daemon stalled inside the first write so nothing drains.
    import threading

    release = threading.Event()

    def stalling_connect(p: Path) -> sqlite3.Connection:
        real = ds._default_connect(p)

        class _Stall:
            def execute(self, sql: str, *args):
                if "INTO receipts" in sql:
                    release.wait(timeout=5.0)
                return real.execute(sql, *args)

            def __enter__(self):
                return real.__enter__()

            def __exit__(self, *exc):
                return real.__exit__(*exc)

            def __getattr__(self, name):
                return getattr(real, name)

        return _Stall()  # type: ignore[return-value]

    store = ds.DiagnosticsStore(
        path, connect=stalling_connect, install_signal_handlers=False, critical_timeout=2.0
    )
    try:
        # Flood diagnostics; the daemon is stuck on its first INSERT, so the bounded
        # diagnostic queue fills and excess diagnostics are dropped + counted (never block).
        for i in range(ds._DIAG_QUEUE_MAXSIZE + 200):
            store.record("noise", {"i": i}, critical=False)
        with store._loss_lock:
            assert store._loss_count > 0
            assert "queue_full" in store._loss_reasons
    finally:
        release.set()
        store.close()


# -- open-time hardening ---------------------------------------------------


def test_failfast_on_unwritable_directory(tmp_path: Path) -> None:
    # Parent path is a regular FILE → directory creation must fail fast at open.
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x")
    with pytest.raises(ds.DiagnosticPersistError):
        ds.DiagnosticsStore(blocker / "sub" / "telemetry.db", install_signal_handlers=False)


def test_db_file_is_0600(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        assert path.exists()
        assert (path.stat().st_mode & 0o777) == 0o600
    finally:
        store.close()


def test_schema_version_guard_refuses_newer_db(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    store.close()
    # Stamp a future schema version, then reopening must fail closed.
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {ds.SCHEMA_VERSION + 1}")
    conn.commit()
    conn.close()
    with pytest.raises(ds.DiagnosticPersistError):
        ds.DiagnosticsStore(path, install_signal_handlers=False)


# -- process-global accessor ----------------------------------------------


def test_get_store_singleton_and_reset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_PATH", str(tmp_path / "telemetry.db"))
    ds.reset_store_for_tests()
    try:
        a = ds.get_store()
        b = ds.get_store()
        assert a is b
    finally:
        ds.reset_store_for_tests()


# -- poison-pill resilience (a bad payload must never kill the writer) -------


def test_cyclic_payload_does_not_kill_writer(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        cyclic: dict = {}
        cyclic["self"] = cyclic  # circular reference → json.dumps raises
        # The poisoned critical is neutralised at serialization (safe placeholder),
        # so it commits rather than killing the daemon.
        store.record("governance.denied", cyclic, critical=True)
        # The writer is still alive: a subsequent receipt persists normally.
        store.record("governance.denied", {"ok": True}, critical=True)
        rows = _read_receipts(path)
        assert len(rows) == 2
        assert any("_unserializable" in r["payload"] for r in rows)
        assert any(json.loads(r["payload"]) == {"ok": True} for r in rows)
    finally:
        store.close()


def test_deeply_nested_payload_does_not_kill_writer(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        node: dict = {}
        root = node
        for _ in range(20000):  # exceeds the json recursion limit → RecursionError
            child: dict = {}
            node["c"] = child
            node = child
        store.record("governance.denied", root, critical=True)
        store.record("governance.denied", {"ok": True}, critical=True)
        rows = _read_receipts(path)
        assert len(rows) == 2
        assert any(json.loads(r["payload"]) == {"ok": True} for r in rows)
    finally:
        store.close()


def test_oversized_diagnostic_payload_is_truncated(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        big = {"blob": "x" * (ds._MAX_PAYLOAD_BYTES + 1000)}
        store.record("tool.delta", big, critical=False)  # diagnostics are lossy → truncate
        assert _wait_for(lambda: len(_read_receipts(path)) == 1)
        payload = json.loads(_read_receipts(path)[0]["payload"])
        assert payload["_truncated"] is True
    finally:
        store.close()


def test_oversized_critical_payload_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        big = {"reason": "x" * (ds._MAX_PAYLOAD_BYTES + 1000)}
        # A critical fact must persist WHOLE: oversize → fail-closed, NOT silent truncation.
        with pytest.raises(ds.DiagnosticPersistError):
            store.record("governance.denied", big, critical=True)
        # No truncated/partial critical row leaked into the db.
        assert all(r["kind"] != "governance.denied" for r in _read_receipts(path))
    finally:
        store.close()


def test_long_kind_is_bounded(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        store.record("k" * 1000, {}, critical=True)
        rows = _read_receipts(path)
        assert len(rows[0]["kind"]) == ds._MAX_KIND_LEN
    finally:
        store.close()


# -- signal handler: minimal work, no join (deadlock avoidance) -------------


def test_signal_handler_does_not_join_and_sets_closing(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        # SIG_DFL previous → handler must exit cleanly (SystemExit), never join.
        handler = store._make_signal_handler(signal.SIGTERM, signal.SIG_DFL)
        with pytest.raises(SystemExit):
            handler(signal.SIGTERM, None)
        assert store._closing.is_set()
        assert store._wake.is_set()
    finally:
        store.close()


def test_signal_handler_chains_to_previous_callable(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        called: list[int] = []

        def prev(signum, frame):
            called.append(signum)

        handler = store._make_signal_handler(signal.SIGINT, prev)
        handler(signal.SIGINT, None)  # should NOT raise (chains to prev)
        assert called == [signal.SIGINT]
        assert store._closing.is_set()
    finally:
        store.close()


# -- WAL/SHM + existing-journal hardening ----------------------------------


def test_wal_sidecars_are_0600(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        # Force a WAL frame so the -wal sidecar exists.
        store.record("k", {"n": 1}, critical=True)
        wal = path.with_name(path.name + "-wal")
        if wal.exists():  # WAL sidecar present on a real file-backed db
            assert (wal.stat().st_mode & 0o777) == 0o600
    finally:
        store.close()


def test_existing_journal_perms_tightened(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    journal = path.with_name("telemetry.db.journal")
    journal.write_text("preexisting\n")
    os.chmod(journal, 0o644)  # loose perms on a pre-existing journal

    def faulty_connect(p: Path) -> sqlite3.Connection:
        return _FaultyConn(ds._default_connect(p))  # type: ignore[return-value]

    store = ds.DiagnosticsStore(path, connect=faulty_connect, install_signal_handlers=False)
    try:
        with pytest.raises(ds.DiagnosticPersistError):
            store.record("k", {}, critical=True)
        assert (journal.stat().st_mode & 0o777) == 0o600  # tightened on append
    finally:
        store.close()


# -- schema column compatibility -------------------------------------------


def test_incompatible_existing_receipts_table_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    # A foreign/old receipts table missing our columns, user_version still 0.
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE receipts (id INTEGER PRIMARY KEY, foo TEXT)")
    conn.commit()
    conn.close()
    with pytest.raises(ds.DiagnosticPersistError):
        ds.DiagnosticsStore(path, install_signal_handlers=False)


# -- critical receipt uniqueness (no intra-db duplicate on same uid) --------


def test_receipt_uid_is_unique(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        store.record("k", {"n": 1}, critical=True)
    finally:
        store.close()
    # The column is UNIQUE; a manual duplicate uid insert is rejected.
    conn = sqlite3.connect(path)
    try:
        uid = conn.execute("SELECT receipt_uid FROM receipts").fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO receipts (receipt_uid, occurred_at, kind, receipt_class, payload) "
                "VALUES (?, 0.0, 'k', 'critical', '{}')",
                (uid,),
            )
    finally:
        conn.close()


# -- critical budget is a single deadline, not two stacked timeouts ---------


def test_ready_timeout_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"

    def slow_connect(p: Path) -> sqlite3.Connection:
        time.sleep(2.0)  # exceeds the short ready_timeout below
        return ds._default_connect(p)

    with pytest.raises(ds.DiagnosticPersistError):
        ds.DiagnosticsStore(
            path, connect=slow_connect, ready_timeout=0.3, install_signal_handlers=False
        )


def test_existing_table_without_unique_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    # All required columns present, but NO UNIQUE on receipt_uid → dedup contract broken.
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_uid TEXT NOT NULL,
            occurred_at REAL NOT NULL,
            kind TEXT NOT NULL,
            receipt_class TEXT NOT NULL,
            trace_id TEXT, run_id TEXT, span_id TEXT, parent_span_id TEXT,
            request_id TEXT, export_id TEXT, payload TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()
    with pytest.raises(ds.DiagnosticPersistError):
        ds.DiagnosticsStore(path, install_signal_handlers=False)


def test_parent_directory_is_0700(tmp_path: Path) -> None:
    parent = tmp_path / "tele"
    store = ds.DiagnosticsStore(parent / "telemetry.db", install_signal_handlers=False)
    try:
        assert (parent.stat().st_mode & 0o777) == 0o700
    finally:
        store.close()


def test_journal_preserves_metadata_for_poison_payload(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"

    def faulty_connect(p: Path) -> sqlite3.Connection:
        return _FaultyConn(ds._default_connect(p))  # type: ignore[return-value]

    store = ds.DiagnosticsStore(path, connect=faulty_connect, install_signal_handlers=False)
    try:
        cyclic: dict = {}
        cyclic["self"] = cyclic
        with pytest.raises(ds.DiagnosticPersistError):
            store.record("governance.denied", cyclic, critical=True)
        journal = path.with_name("telemetry.db.journal")
        entries = [json.loads(line) for line in journal.read_text().splitlines() if line]
        # The line must NOT collapse to a bare placeholder: uid + kind survive.
        entry = entries[-1]
        assert entry["kind"] == "governance.denied"
        assert entry["receipt_uid"]
        assert "_unserializable" in json.dumps(entry["payload"])
    finally:
        store.close()


def test_cross_process_concurrent_criticals(tmp_path: Path) -> None:
    """Two processes writing criticals to the SAME telemetry.db must both land
    (SQLite WAL file-lock serialises the per-process single writers; no corruption)."""
    path = tmp_path / "telemetry.db"
    script = textwrap.dedent(
        f"""
        from superclaw import diagnostics_store as ds
        store = ds.DiagnosticsStore({str(path)!r}, install_signal_handlers=False)
        for i in range(20):
            store.record("governance.denied", {{"i": i}}, critical=True)
        store.close()
        """
    )
    procs = [
        subprocess.Popen([sys.executable, "-c", script], env=os.environ.copy())
        for _ in range(2)
    ]
    for proc in procs:
        assert proc.wait(timeout=30) == 0
    rows = _read_receipts(path)
    assert len(rows) == 40  # both processes' criticals are durable
    assert len({r["receipt_uid"] for r in rows}) == 40  # all unique, no dup/corruption


def test_critical_timeout_is_single_budget(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"

    import threading

    release = threading.Event()

    def stalling_connect(p: Path) -> sqlite3.Connection:
        real = ds._default_connect(p)

        class _Stall:
            def execute(self, sql: str, *args):
                if "INTO receipts" in sql:
                    release.wait(timeout=10.0)
                return real.execute(sql, *args)

            def __enter__(self):
                return real.__enter__()

            def __exit__(self, *exc):
                return real.__exit__(*exc)

            def __getattr__(self, name):
                return getattr(real, name)

        return _Stall()  # type: ignore[return-value]

    store = ds.DiagnosticsStore(
        path, connect=stalling_connect, install_signal_handlers=False, critical_timeout=1.0
    )
    try:
        start = time.monotonic()
        with pytest.raises(ds.DiagnosticPersistError):
            store.record("governance.denied", {"x": 1}, critical=True)
        elapsed = time.monotonic() - start
        # A single 1.0s budget — NOT 2x (stacked enqueue + ack waits).
        assert elapsed < 1.8
    finally:
        release.set()
        store.close()
