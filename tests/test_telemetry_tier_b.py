"""Tier B (diagnostic receipts) upload link: reader + projection + e2e + the
retention-tolerant cursor that distinguishes Tier B from append-only Tier A.

Receipts are lossy (retention prunes old diagnostic rows), so Tier B dedupes
ROW-LEVEL on each receipt_uid (server (device_id, receipt_uid) ON CONFLICT) plus a
content-keyed batch upload_id — a retention-thinned re-send dedupes server-side
instead of double-inserting the survivors. That is why Tier B can't reuse Tier A's
fail-closed exact-range reconstruction, so it gets dedicated tests here.
"""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from apps.telemetry_server.config import ServerConfig
from apps.telemetry_server.db import Database
from apps.telemetry_server.main import create_app
from superclaw.diagnostics_store import (
    DiagnosticsStore,
    list_receipts_after_seq,
    max_receipt_seq,
)
from superclaw.state import StateStore
from superclaw.telemetry_upload import (
    TelemetryConfig,
    UploadError,
    UploadSpooler,
    _project_receipt,
)


# -- helpers ------------------------------------------------------------------
def _server(tmp_path, token=""):
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'collector.db'}",
        ingest_token=token, query_token="", host="127.0.0.1", port=8900,
        tier_c_retention_days=7, env="local", retention_interval_seconds=0.0,
    )
    db = Database(cfg.database_url)
    return create_app(cfg, db), db


def _asgi_poster(app):
    client = TestClient(app)

    def poster(url: str, payload: dict, token: str) -> dict:
        headers = {"authorization": f"Bearer {token}"} if token else {}
        path = url.split("collector.test", 1)[-1]
        resp = client.post(path, json=payload, headers=headers)
        if resp.status_code >= 400:
            raise UploadError(f"HTTP {resp.status_code}")
        return resp.json()

    return poster


def _seed_receipts(tele_path) -> None:
    """Write a governance (critical) + two spans (diagnostic) receipt and flush."""
    ds = DiagnosticsStore(tele_path)
    ds.record(
        "governance.decision",
        {"decision": "denied", "tool_name": "shell", "reason": "scan_blocked"},
        critical=True,
    )
    ds.record("span.end", {"name": "backend.call", "span_kind": "backend", "duration_ms": 1234})
    ds.record("span.error", {"name": "tool.exec", "error_type": "TimeoutError", "error": "deadline"})
    ds.close()  # flush the async diagnostic queue


def _spooler(app, store_dir, tele_path, *, token="", base=None):
    cfg = TelemetryConfig(
        endpoint="http://collector.test", token=token, enabled_env=True, kill=False,
        max_batch_rows=1000, timeout_seconds=5.0, base_dir=base or (store_dir / "home"),
        max_batches_per_tick=1000, max_tick_seconds=1e9,
    )
    sp = UploadSpooler(
        StateStore(str(store_dir / "state.db")), cfg,
        poster=_asgi_poster(app), diagnostics_path=tele_path,
    )
    sp.set_consent(enabled=True, agreement_version="2026-06-23")
    return sp, cfg


# -- reader (strictly read-only, gap-tolerant) --------------------------------
def test_max_receipt_seq_absent_and_present(tmp_path):
    missing = tmp_path / "nope.db"
    assert max_receipt_seq(missing) == 0
    tele = tmp_path / "telemetry.db"
    _seed_receipts(tele)
    assert max_receipt_seq(tele) == 3


def test_list_receipts_after_seq_paging_and_gap_tolerance(tmp_path):
    tele = tmp_path / "telemetry.db"
    _seed_receipts(tele)
    page = list_receipts_after_seq(0, limit=2, until_seq=3, path=tele)
    assert [seq for seq, _ in page] == [1, 2]
    # Delete an interior row (simulate retention) — the reader must tolerate the gap.
    conn = sqlite3.connect(tele)
    conn.execute("DELETE FROM receipts WHERE id = 2")
    conn.commit()
    conn.close()
    page = list_receipts_after_seq(0, until_seq=3, path=tele)
    assert [seq for seq, _ in page] == [1, 3]


# -- projection (payload keys -> wide-table columns; explicit, conservative) --
def test_project_receipt_governance_and_span():
    gov = _project_receipt({
        "kind": "governance.decision", "receipt_class": "critical",
        "trace_id": "t1", "run_id": "r1", "occurred_at": 5.0,
        "payload": '{"decision": "denied", "reason": "scan_blocked"}',
    })
    assert gov["decision_code"] == "denied" and gov["summary"] == "scan_blocked"
    assert gov["duration_ms"] is None and gov["trace_id"] == "t1"

    span = _project_receipt({
        "kind": "span.error", "receipt_class": "diagnostic",
        "payload": {"name": "tool.exec", "error_type": "TimeoutError", "error": "deadline"},
    })
    assert span["summary"] == "tool.exec"
    assert span["exception_type"] == "TimeoutError"
    assert span["stack_redacted"] == "deadline"
    assert span["decision_code"] is None


def test_project_receipt_unknown_kind_keeps_only_common_columns():
    wire = _project_receipt({
        "kind": "mystery.kind", "trace_id": "t9", "run_id": "r9",
        "payload": '{"whatever": 1}',
    })
    assert wire["trace_id"] == "t9" and wire["kind"] == "mystery.kind"
    # No guessing: every payload-derived column stays None for an unknown kind.
    for col in ("decision_code", "summary", "duration_ms", "exception_type", "stack_redacted"):
        assert wire[col] is None


def test_project_receipt_malformed_payload_degrades_to_common():
    wire = _project_receipt({"kind": "span.end", "trace_id": "t", "payload": "not-json"})
    assert wire["trace_id"] == "t" and wire["summary"] is None  # never raises


# -- end to end ----------------------------------------------------------------
def test_tier_b_uploads_land_and_map_correctly(tmp_path):
    app, db = _server(tmp_path / "srv", token="secret")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)
    sp, _ = _spooler(app, tmp_path / "client", tele, token="secret")

    result = sp.tick(drain=True)
    assert not result.skipped, result.reason
    assert result.rows == 3 and result.batches == 1 and not result.errors

    assert db.stats()["tier_b_rows"] == 3
    rows = db.query_tier("B")
    by_kind = {r["kind"]: r for r in rows}
    assert by_kind["governance.decision"]["decision_code"] == "denied"
    assert by_kind["span.end"]["duration_ms"] == 1234
    assert by_kind["span.error"]["exception_type"] == "TimeoutError"


def test_tier_b_idempotent_no_double_insert(tmp_path):
    app, db = _server(tmp_path / "srv")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)
    sp, cfg = _spooler(app, tmp_path / "client", tele)
    sp.tick(drain=True)
    # Wipe the local cursor to force a re-send; server dedup must hold.
    (cfg.base_dir / "telemetry-upload-state.json").unlink()
    result = sp.tick(drain=True)
    assert result.duplicates == 1
    assert db.stats()["tier_b_rows"] == 3  # never doubled


def test_tier_b_retention_thinned_resend_does_not_double_insert(tmp_path):
    """THE Tier B invariant: a re-send whose interior rows were pruned by retention
    must NOT double-insert the survivors. Now enforced ROW-LEVEL: the surviving
    receipts carry their stable receipt_uid, so the server's (device_id, receipt_uid)
    ON CONFLICT dedupes each one — independent of id range or batch upload_id."""
    app, db = _server(tmp_path / "srv")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)
    sp, cfg = _spooler(app, tmp_path / "client", tele)

    sp.tick(drain=True)
    assert db.stats()["tier_b_rows"] == 3

    # Simulate a crash that lost the cursor AND retention pruning id=2 afterwards.
    (cfg.base_dir / "telemetry-upload-state.json").unlink()
    conn = sqlite3.connect(tele)
    conn.execute("DELETE FROM receipts WHERE id = 2")
    conn.commit()
    conn.close()

    result = sp.tick(drain=True)
    assert not result.errors
    assert db.stats()["tier_b_rows"] == 3  # still 3 — survivors deduped per receipt_uid


def test_tier_b_row_level_dedupe_across_different_upload_ids(tmp_path):
    """Row-level (device_id, receipt_uid) dedupe must hold even when the batch
    upload_id differs — exactly what a DB restore + full re-scan produces (old
    receipts re-sent in a new batch alongside new ones). Old rows dedupe; new lands."""
    app, db = _server(tmp_path / "srv")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)  # 3 receipts
    sp, cfg = _spooler(app, tmp_path / "client", tele)
    sp.tick(drain=True)
    assert db.stats()["tier_b_rows"] == 3

    # Re-send under a DIFFERENT batch: wipe the cursor AND add a 4th receipt so the
    # page's receipt_uid set — hence the upload_id — changes from the first send.
    (cfg.base_dir / "telemetry-upload-state.json").unlink()
    ds = DiagnosticsStore(tele)
    ds.record("governance.decision", {"decision": "allow", "reason": "ok"}, critical=True)
    ds.close()
    result = sp.tick(drain=True)
    assert not result.errors
    assert db.stats()["tier_b_rows"] == 4  # 3 originals deduped row-level, 1 new landed


def test_tier_b_empty_window_advances_cursor_without_spinning(tmp_path):
    """If the whole (acked, tick_end] window was pruned but the DB still has rows
    beyond tick_end, the drain loop must SUCCESSFULLY read an empty window and
    advance the cursor to tick_end — not spin. Driving ``_upload_tier_b`` directly
    with an explicit tick_end is the only way to actually exercise that branch (via
    ``tick()`` the surviving high id would just raise tick_end)."""
    from superclaw.telemetry_upload import UploadResult

    app, _ = _server(tmp_path / "srv")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)  # ids 1,2,3
    sp, _ = _spooler(app, tmp_path / "client", tele)
    # Prune ids 1 and 2; id 3 survives. The (0, 2] window is now empty BUT the DB
    # is non-empty and the read SUCCEEDS — exactly the genuine-retention-gap case.
    conn = sqlite3.connect(tele)
    conn.execute("DELETE FROM receipts WHERE id IN (1, 2)")
    conn.commit()
    conn.close()

    result = UploadResult()
    sp._upload_tier_b(result, tick_end=2, max_batches=None, max_seconds=None)
    assert not result.errors and result.batches == 0  # nothing posted for an empty window
    acked, pending = sp._load_spool_state("B")
    assert acked == 2 and pending is None  # cursor advanced past the pruned window


def test_tier_b_read_failure_does_not_advance_cursor(tmp_path):
    """A genuine read failure (not an empty window) must leave the cursor untouched
    and surface an error — never silently advance past unread rows."""
    from superclaw.telemetry_upload import UploadResult

    app, _ = _server(tmp_path / "srv")
    tele = tmp_path / "client" / "telemetry.db"
    _seed_receipts(tele)
    sp, _ = _spooler(app, tmp_path / "client", tele)

    import superclaw.diagnostics_store as ds

    def _boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")

    orig = ds.list_receipts_after_seq
    ds.list_receipts_after_seq = _boom
    try:
        result = UploadResult()
        sp._upload_tier_b(result, tick_end=3, max_batches=None, max_seconds=None)
    finally:
        ds.list_receipts_after_seq = orig

    assert result.errors and "read receipts" in result.errors[0]
    acked, pending = sp._load_spool_state("B")
    assert acked == 0  # NOT advanced — the rows are still unread


def test_reader_propagates_read_error_on_existing_db(tmp_path):
    """An existing-but-unreadable DB (no receipts table) must RAISE, not return an
    empty result that the caller would mistake for 'no data'."""
    import sqlite3 as _sq

    from superclaw.diagnostics_store import list_receipts_after_seq, max_receipt_seq

    broken = tmp_path / "telemetry.db"
    _sq.connect(broken).close()  # exists, but has no `receipts` table
    try:
        max_receipt_seq(broken)
        raise AssertionError("max_receipt_seq should have raised on a missing table")
    except _sq.Error:
        pass
    try:
        list_receipts_after_seq(0, until_seq=10, path=broken)
        raise AssertionError("list_receipts_after_seq should have raised")
    except _sq.Error:
        pass


def test_project_receipt_scrubs_paths_and_freetext():
    """Free-text columns leaving the machine must get the full P1 scalar guard:
    paths/URLs/whitespace sentences must never reach the wire in cleartext."""
    span = _project_receipt({
        "kind": "span.error",
        "payload": {"name": "tool.exec", "error": "boom at /Users/leon/secret/key.pem"},
    })
    # A free-text error carrying an absolute path must be redacted (whitespace rule
    # fires first here → <redacted>; either sentinel is acceptable, cleartext is not).
    assert span["stack_redacted"] in ("<redacted>", "<path-redacted>")
    assert "/Users/leon" not in str(span["stack_redacted"])

    gov = _project_receipt({
        "kind": "governance.decision",
        "payload": {"decision": "denied", "reason": "blocked /etc/shadow read"},
    })
    assert "/etc/shadow" not in str(gov["summary"])
    assert gov["decision_code"] == "denied"  # a clean enum token survives
