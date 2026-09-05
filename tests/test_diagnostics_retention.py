"""P0b-1d: bounded-growth retention — delete OLD diagnostics, NEVER touch criticals."""
from __future__ import annotations

import sqlite3
import time

from superclaw import diagnostics_store as ds


def _make_receipts_db(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_uid TEXT NOT NULL UNIQUE,
            occurred_at REAL NOT NULL,
            kind TEXT NOT NULL,
            receipt_class TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        """
    )
    conn.commit()
    return conn


def _insert(conn: sqlite3.Connection, uid: str, cls: str, occurred_at: float) -> None:
    conn.execute(
        "INSERT INTO receipts (receipt_uid, occurred_at, kind, receipt_class, payload) "
        "VALUES (?, ?, ?, ?, ?)",
        (uid, occurred_at, "k", cls, "{}"),
    )
    conn.commit()


def _uids(conn: sqlite3.Connection) -> set[str]:
    return {r["receipt_uid"] for r in conn.execute("SELECT receipt_uid FROM receipts")}


def test_retention_deletes_old_diagnostics_keeps_critical(tmp_path):
    conn = _make_receipts_db(tmp_path / "t.db")
    now = 1000.0
    _insert(conn, "old_diag", "diagnostic", now - 100)
    _insert(conn, "new_diag", "diagnostic", now - 1)
    _insert(conn, "old_crit", "critical", now - 100)  # old, but critical → kept

    deleted, complete = ds._run_retention(conn, retention_seconds=50, max_diag_rows=1000, now=now)

    rows = _uids(conn)
    assert "old_diag" not in rows  # aged-out diagnostic deleted
    assert "new_diag" in rows  # recent diagnostic kept
    assert "old_crit" in rows  # critical NEVER pruned (audit boundary §7.2)
    assert deleted == 1
    assert complete is True  # full pass (no yield, no busy checkpoint)


def test_retention_row_cap_keeps_newest_diagnostics(tmp_path):
    conn = _make_receipts_db(tmp_path / "t.db")
    now = 1000.0
    for i in range(5):
        _insert(conn, f"d{i}", "diagnostic", now - 1)  # all recent: age won't delete

    deleted, complete = ds._run_retention(conn, retention_seconds=10_000, max_diag_rows=2, now=now)

    rows = [r["receipt_uid"] for r in conn.execute("SELECT receipt_uid FROM receipts ORDER BY id")]
    assert rows == ["d3", "d4"]  # newest 2 (highest id) kept
    assert deleted == 3
    assert complete is True


def test_retention_row_cap_never_evicts_critical(tmp_path):
    conn = _make_receipts_db(tmp_path / "t.db")
    now = 1000.0
    for i in range(5):
        _insert(conn, f"c{i}", "critical", now - 1)

    deleted, complete = ds._run_retention(conn, retention_seconds=10_000, max_diag_rows=1, now=now)

    assert len(_uids(conn)) == 5  # all criticals survive despite max_diag_rows=1
    assert deleted == 0
    assert complete is True


def test_resolve_retention_env(monkeypatch):
    monkeypatch.delenv(ds._RETENTION_ENV_DAYS, raising=False)
    assert ds._resolve_retention_seconds() == ds._DEFAULT_RETENTION_DAYS * 86_400.0
    monkeypatch.setenv(ds._RETENTION_ENV_DAYS, "3")
    assert ds._resolve_retention_seconds() == 3 * 86_400.0
    monkeypatch.setenv(ds._RETENTION_ENV_DAYS, "garbage")
    assert ds._resolve_retention_seconds() == ds._DEFAULT_RETENTION_DAYS * 86_400.0

    monkeypatch.delenv(ds._RETENTION_ENV_MAX_ROWS, raising=False)
    assert ds._resolve_max_diag_rows() == ds._DEFAULT_MAX_DIAG_ROWS
    monkeypatch.setenv(ds._RETENTION_ENV_MAX_ROWS, "10")
    assert ds._resolve_max_diag_rows() == 10
    monkeypatch.setenv(ds._RETENTION_ENV_MAX_ROWS, "-5")  # invalid → default
    assert ds._resolve_max_diag_rows() == ds._DEFAULT_MAX_DIAG_ROWS


def test_daemon_enforces_row_cap_end_to_end(tmp_path):
    # Integration: the single-writer daemon actually runs retention on its own
    # connection. retention_interval=0 so every tick prunes; max_diag_rows=1.
    store = ds.DiagnosticsStore(
        tmp_path / "t.db",
        install_signal_handlers=False,
        retention_seconds=10_000.0,
        max_diag_rows=1,
        retention_interval=0.0,
    )
    try:
        for i in range(6):
            store.record("test.diag", {"i": i}, critical=False)
        deadline = time.monotonic() + 5.0
        diag_count = 99
        while time.monotonic() < deadline:
            time.sleep(0.3)
            reader = sqlite3.connect(tmp_path / "t.db")
            reader.row_factory = sqlite3.Row
            diag_count = reader.execute(
                "SELECT COUNT(*) c FROM receipts WHERE receipt_class = 'diagnostic'"
            ).fetchone()["c"]
            reader.close()
            if diag_count <= 1:
                break
        assert diag_count <= 1  # daemon retention capped diagnostics on its writer
    finally:
        store.close()


def test_retention_yields_to_pending_critical(tmp_path):
    # A retention pass must stop between chunks when a critical is waiting, leaving
    # the rest for the next pass — never starving the governance path (Codex #2).
    conn = _make_receipts_db(tmp_path / "t.db")
    now = 1000.0
    for i in range(10):
        _insert(conn, f"d{i}", "diagnostic", now - 100)  # all aged-out

    deleted, complete = ds._run_retention(
        conn, retention_seconds=50, max_diag_rows=1000, now=now,
        chunk=3, should_yield=lambda: True,  # a critical is "always" waiting
    )
    assert deleted == 3  # only the first chunk; yielded before the rest
    assert complete is False  # incomplete → caller must continue next tick, not in an hour
    assert conn.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 7


def test_retention_chunked_deletes_all_when_not_yielding(tmp_path):
    conn = _make_receipts_db(tmp_path / "t.db")
    now = 1000.0
    for i in range(10):
        _insert(conn, f"d{i}", "diagnostic", now - 100)

    deleted, complete = ds._run_retention(
        conn, retention_seconds=50, max_diag_rows=1000, now=now, chunk=3,
    )  # no yield → loops chunk-by-chunk until done
    assert deleted == 10
    assert complete is True
    assert conn.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 0


def test_should_run_retention_first_pass_not_gated():
    # first-tick sentinel (Codex/agy #5): the very first pass (last is None) runs
    # even when uptime `now` < interval — the old 0.0-vs-monotonic baseline gated
    # retention OFF for the first `interval` seconds after boot.
    assert ds._should_run_retention(None, 300.0, 3600.0) is True
    # already ran recently, still within interval → gated off
    assert ds._should_run_retention(100.0, 300.0, 3600.0) is False
    # interval elapsed since last run → runs again
    assert ds._should_run_retention(100.0, 4000.0, 3600.0) is True
