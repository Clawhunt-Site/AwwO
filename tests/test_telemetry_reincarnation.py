"""DB reincarnation guard: a recreated/restored ledger must not strand the upload
cursor at a stale high watermark (silent under-collection), and a post-reset
re-scan must not double-insert (row-level idempotency).

Covers Codex's matrix: incarnation change (new rowids low AND high vs old ack),
DB-only restore (seq regression at same incarnation is impossible — uuid rides the
snapshot — so that case is the seq-check unit test), unreadable incarnation = no
reset (red line), and Tier A/B end-to-end re-scan without doubles.
"""
from __future__ import annotations

import gc
import sqlite3
import time

from fastapi.testclient import TestClient

from apps.telemetry_server.config import ServerConfig
from apps.telemetry_server.db import Database
from apps.telemetry_server.main import create_app
from superclaw import db_incarnation
from superclaw.diagnostics_store import DiagnosticsStore
from superclaw.models import CostEvent
from superclaw.state import StateStore
from superclaw.telemetry_upload import TelemetryConfig, UploadError, UploadSpooler


# -- helpers ------------------------------------------------------------------
def _server(tmp_path):
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'collector.db'}", ingest_token="",
        query_token="", host="127.0.0.1", port=8900, tier_c_retention_days=7,
        env="local", retention_interval_seconds=0.0,
    )
    db = Database(cfg.database_url)
    return create_app(cfg, db), db


def _poster(app):
    client = TestClient(app)

    def post(url, payload, token):
        resp = client.post("/v1/telemetry/ingest", json=payload,
                           headers={"authorization": f"Bearer {token}"} if token else {})
        if resp.status_code >= 400:
            raise UploadError(f"HTTP {resp.status_code}")
        return resp.json()

    return post


def _cfg(home):
    return TelemetryConfig(
        endpoint="http://collector.test", token="", enabled_env=True, kill=False,
        max_batch_rows=1000, timeout_seconds=5.0, base_dir=home,
        max_batches_per_tick=1000, max_tick_seconds=1e9,
    )


def _cost(key, eid):
    return CostEvent(idempotency_key=key, event_id=eid, model="claude-opus-4-8",
                     input_tokens=10, output_tokens=2, cost_cents=1, billing_lane="byo",
                     occurred_at=100.0)


def _wipe_db(path):
    # Windows holds an OS lock on an open SQLite file, so a StateStore's per-op
    # connection reaped only by the cyclic GC (not refcounting) can make unlink()
    # fail with PermissionError [WinError 32]. Force a collection to release such
    # handles, then unlink with a brief retry for the lag between close() and the OS
    # releasing the handle. On POSIX gc.collect() is a cheap no-op and unlink of an
    # open file already succeeds, so this keeps the exact same semantics there.
    gc.collect()
    for suffix in ("", "-wal", "-shm"):
        p = path.with_name(path.name + suffix) if suffix else path
        for attempt in range(20):
            try:
                if p.exists():
                    p.unlink()
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.05)


# -- db_incarnation primitive --------------------------------------------------
def test_incarnation_is_stable_then_changes_on_recreate(tmp_path):
    db_path = tmp_path / "x.db"
    conn = sqlite3.connect(db_path)
    first = db_incarnation.ensure_incarnation(conn)
    assert first and db_incarnation.ensure_incarnation(conn) == first  # idempotent
    assert db_incarnation.read_incarnation(conn) == first
    conn.close()
    # A fresh DB file mints a different uuid.
    db_path.unlink()
    conn2 = sqlite3.connect(db_path)
    assert db_incarnation.ensure_incarnation(conn2) != first
    conn2.close()


def test_read_incarnation_absent_returns_none(tmp_path):
    conn = sqlite3.connect(tmp_path / "empty.db")
    assert db_incarnation.read_incarnation(conn) is None  # no meta table
    conn.close()


# -- reconcile unit ------------------------------------------------------------
def test_reconcile_resets_on_incarnation_change(tmp_path):
    home = tmp_path / "h"
    home.mkdir()
    sp = UploadSpooler(StateStore(str(tmp_path / "s.db")), _cfg(home), poster=lambda *a: {})
    sp._save_spool_state("A", 100, None)
    sp._reset_spool_state("A", "old-incarnation")  # bind to an old DB
    sp._save_spool_state("A", 100, None)  # advance under that incarnation
    sp._reconcile_cursor("A", "new-incarnation", max_seq=5)  # DB was recreated
    assert sp._load_spool_state("A") == (0, None)  # reset to re-scan
    assert sp._load_incarnation("A") == "new-incarnation"


def test_reconcile_resets_on_seq_regression(tmp_path):
    home = tmp_path / "h"
    home.mkdir()
    sp = UploadSpooler(StateStore(str(tmp_path / "s.db")), _cfg(home), poster=lambda *a: {})
    sp._reset_spool_state("A", "inc-1")
    sp._save_spool_state("A", 100, None)  # cursor at 100, same incarnation
    sp._reconcile_cursor("A", "inc-1", max_seq=3)  # DB only has 3 rows now
    assert sp._load_spool_state("A") == (0, None)  # rolled back -> reset


def test_reconcile_no_reset_when_incarnation_unreadable(tmp_path):
    """RED LINE: a None incarnation (read failure / legacy DB) must NOT reset, even
    if acked > max_seq — wiping a healthy cursor on a transient read flake is worse."""
    home = tmp_path / "h"
    home.mkdir()
    sp = UploadSpooler(StateStore(str(tmp_path / "s.db")), _cfg(home), poster=lambda *a: {})
    sp._reset_spool_state("A", "inc-1")
    sp._save_spool_state("A", 100, None)
    sp._reconcile_cursor("A", None, max_seq=3)  # cannot confirm DB identity
    assert sp._load_spool_state("A") == (100, None)  # untouched


def test_reconcile_binds_without_reset_on_upgrade(tmp_path):
    """UPGRADE: a cursor that predates the guard (no db_incarnation) keeps its acked —
    that is valid progress, NOT a reincarnation — and just binds the uuid. Resetting
    here would re-scan legacy rows the old upload_id can't dedupe → double insert."""
    home = tmp_path / "h"
    home.mkdir()
    sp = UploadSpooler(StateStore(str(tmp_path / "s.db")), _cfg(home), poster=lambda *a: {})
    sp._save_spool_state("A", 50, None)  # legacy cursor: acked=50, no db_incarnation
    assert sp._load_incarnation("A") is None
    sp._reconcile_cursor("A", "inc-new", max_seq=100)
    assert sp._load_spool_state("A") == (50, None)  # preserved, NOT reset
    assert sp._load_incarnation("A") == "inc-new"  # bound for next time


# -- Tier A end-to-end ---------------------------------------------------------
def test_tier_a_reincarnation_rescans_without_loss_or_double(tmp_path):
    app, db = _server(tmp_path / "srv")
    home = tmp_path / "client"
    home.mkdir()
    st = StateStore(str(home / "state.db"))
    st.record_cost_event(_cost("e1", "cost-1"))
    UploadSpooler(st, _cfg(home), poster=_poster(app)).tick(drain=True)
    assert db.stats()["tier_a_rows"] == 1

    # Reincarnate state.db: delete + recreate. New incarnation, rowids reset to 1.
    _wipe_db(home / "state.db")
    st2 = StateStore(str(home / "state.db"))
    st2.record_cost_event(_cost("e2", "cost-2"))  # rowid 1 again — below the old ack
    result = UploadSpooler(st2, _cfg(home), poster=_poster(app)).tick(drain=True)

    assert not result.errors
    # Without the guard, cost-2 (rowid 1 < old acked 1) would be stranded. With it,
    # the cursor resets and cost-2 uploads. cost-1 is NOT re-uploaded as a duplicate
    # row (event_id row-level dedupe would catch it even if it were re-scanned).
    assert db.stats()["tier_a_rows"] == 2


def test_tier_a_row_level_dedupe_blocks_double_on_rescan(tmp_path):
    """A full re-scan that re-sends an already-uploaded event must not double-insert
    — the server's (device_id, event_id) ON CONFLICT absorbs it."""
    app, db = _server(tmp_path / "srv")
    home = tmp_path / "client"
    home.mkdir()
    st = StateStore(str(home / "state.db"))
    st.record_cost_event(_cost("e1", "cost-1"))
    sp = UploadSpooler(st, _cfg(home), poster=_poster(app))
    sp.tick(drain=True)
    assert db.stats()["tier_a_rows"] == 1
    # Force a from-scratch re-scan of the SAME event (wipe cursor) → row-level dedupe.
    sp._reset_spool_state("A", st.db_incarnation())
    sp.tick(drain=True)
    assert db.stats()["tier_a_rows"] == 1  # not doubled


# -- Tier B end-to-end ---------------------------------------------------------
def test_tier_b_reincarnation_rescans_without_loss(tmp_path):
    app, db = _server(tmp_path / "srv")
    home = tmp_path / "client"
    home.mkdir()
    tele = home / "telemetry.db"
    ds = DiagnosticsStore(tele)
    ds.record("governance.decision", {"decision": "denied", "reason": "x"}, critical=True)
    ds.close()
    UploadSpooler(StateStore(str(home / "state.db")), _cfg(home), poster=_poster(app),
                  diagnostics_path=tele).tick(drain=True)
    assert db.stats()["tier_b_rows"] == 1

    # Reincarnate telemetry.db.
    _wipe_db(tele)
    ds2 = DiagnosticsStore(tele)
    ds2.record("governance.decision", {"decision": "allow", "reason": "y"}, critical=True)
    ds2.close()
    result = UploadSpooler(StateStore(str(home / "state.db")), _cfg(home), poster=_poster(app),
                           diagnostics_path=tele).tick(drain=True)
    assert not result.errors
    assert db.stats()["tier_b_rows"] == 2  # new receipt re-scanned, not stranded


# -- migration / accounting fail-closed ---------------------------------------
def test_add_column_if_missing_surfaces_real_errors_but_swallows_dup(tmp_path):
    import pytest

    from apps.telemetry_server.db import Database

    db = Database(f"sqlite:///{tmp_path/'c.db'}")
    db.init_schema()
    # A real error (missing table) MUST surface — not silently skipped.
    conn = db.connect()
    try:
        with pytest.raises(sqlite3.Error):
            db._add_column_if_missing(conn, "no_such_table", "foo TEXT")
    finally:
        conn.close()
    # A duplicate column (event_id already exists on tier_a) is the expected no-op.
    conn = db.connect()
    try:
        db._add_column_if_missing(conn, "tier_a", "event_id TEXT")  # must not raise
    finally:
        conn.close()


def test_record_batch_accepted_rows_reflects_row_level_dedupe(tmp_path):
    """A re-send under a DIFFERENT upload_id that row-level dedupes must report
    accepted_rows = 0 (real inserts), not len(rows) — honest server accounting."""
    _, db = _server(tmp_path / "srv")  # init_schema runs in create_app
    row = {"event_id": "cost-1", "trace_id": "t", "run_id": "r", "model": "m"}
    s1, n1 = db.record_batch(upload_id="u1", device_id="d", tier="A",
                             agreement_version="v", rows=[row])
    assert (s1, n1) == ("accepted", 1)
    # Same event_id, NEW upload_id (the post-reincarnation re-scan case): the upload
    # row isn't a duplicate, but the data row is — row-level dedupe → 0 real inserts.
    s2, n2 = db.record_batch(upload_id="u2", device_id="d", tier="A",
                             agreement_version="v", rows=[row])
    assert (s2, n2) == ("accepted", 0)
    assert db.stats()["tier_a_rows"] == 1  # not doubled
