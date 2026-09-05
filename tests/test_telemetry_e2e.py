"""End-to-end connectivity: real StateStore → real httpx → real server → real DB.

Uses ``httpx.ASGITransport`` so the full wire path (JSON serialization, real
httpx client, pydantic validation, FastAPI routing, SQLite persistence, ack
parsing, cursor advance) is exercised without a flaky bound socket. A real
bound-socket smoke is run separately from the shell.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from apps.telemetry_server.config import ServerConfig
from apps.telemetry_server.db import Database
from apps.telemetry_server.main import create_app
from superclaw.models import CostEvent
from superclaw.state import StateStore
from superclaw.telemetry_upload import TelemetryConfig, UploadError, UploadSpooler


def _server(tmp_path, token=""):
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'collector.db'}",
        ingest_token=token, query_token="", host="127.0.0.1", port=8900,
        tier_c_retention_days=7, env="local", retention_interval_seconds=0.0,
    )
    db = Database(cfg.database_url)
    app = create_app(cfg, db)
    return app, db


def _asgi_poster(app):
    """Drive the real FastAPI app over a real HTTP client (Starlette TestClient).

    httpx 0.28's ASGITransport is async-only; TestClient is the sync real-HTTP
    path over ASGI. The actual ``_httpx_poster`` (TCP) is covered by the shell
    smoke test, not here.
    """
    client = TestClient(app)

    def poster(url: str, payload: dict, token: str) -> dict:
        headers = {"authorization": f"Bearer {token}"} if token else {}
        path = url.split("collector.test", 1)[-1]
        resp = client.post(path, json=payload, headers=headers)
        if resp.status_code >= 400:
            raise UploadError(f"HTTP {resp.status_code}")
        return resp.json()

    return poster


def _seed_store(tmp_path) -> StateStore:
    store = StateStore(str(tmp_path / "state.db"))
    store.record_cost_event(CostEvent(idempotency_key="e1", run_id="run-1",
                                      model="claude-opus-4-8", input_tokens=100,
                                      output_tokens=20, cost_cents=15,
                                      billing_lane="byo", occurred_at=100.0))
    store.record_cost_event(CostEvent(idempotency_key="e2", run_id="run-2",
                                      model="claude-haiku-4-5", input_tokens=10,
                                      output_tokens=2, cost_cents=3,
                                      billing_lane="byo", occurred_at=200.0))
    return store


def test_end_to_end_upload_lands_and_is_queryable(tmp_path):
    app, db = _server(tmp_path / "srv", token="shared-secret")
    store = _seed_store(tmp_path / "client")
    cfg = TelemetryConfig(
        endpoint="http://collector.test", token="shared-secret", enabled_env=False,
        kill=False, max_batch_rows=1000, timeout_seconds=5.0,
        base_dir=tmp_path / "client" / "home", max_batches_per_tick=1000, max_tick_seconds=1e9,
    )
    spooler = UploadSpooler(store, cfg, poster=_asgi_poster(app))
    spooler.set_consent(enabled=True, agreement_version="2026-06-23")

    result = spooler.tick()
    assert not result.skipped, result.reason
    assert result.rows == 2 and result.batches == 1 and not result.errors

    # Data really landed in the server DB.
    stats = db.stats()
    assert stats["tier_a_rows"] == 2 and stats["devices"] == 1
    assert stats["total_cost_cents"] == 18.0

    rows = db.query_tier("A", trace_id="run-1")
    assert len(rows) == 1 and rows[0]["model"] == "claude-opus-4-8"
    assert rows[0]["device_id"] == spooler.consent().device_id


def test_end_to_end_idempotent_no_double_insert(tmp_path):
    app, db = _server(tmp_path / "srv")
    store = _seed_store(tmp_path / "client")
    cfg = TelemetryConfig(
        endpoint="http://collector.test", token="", enabled_env=True, kill=False,
        max_batch_rows=1000, timeout_seconds=5.0, base_dir=tmp_path / "home",
        max_batches_per_tick=1000, max_tick_seconds=1e9,
    )
    spooler = UploadSpooler(store, cfg, poster=_asgi_poster(app))
    spooler.tick()
    # Force a re-send of the same rows by wiping the local cursor; the server's
    # deterministic upload_id dedup must prevent a double insert.
    (cfg.base_dir / "telemetry-upload-state.json").unlink()
    result = spooler.tick()
    assert result.duplicates == 1  # server recognized the re-sent batch
    assert db.stats()["tier_a_rows"] == 2  # never doubled


def test_end_to_end_auth_rejected_with_wrong_token(tmp_path):
    app, _ = _server(tmp_path / "srv", token="right")
    store = _seed_store(tmp_path / "client")
    cfg = TelemetryConfig(
        endpoint="http://collector.test", token="wrong", enabled_env=True, kill=False,
        max_batch_rows=1000, timeout_seconds=5.0, base_dir=tmp_path / "home",
        max_batches_per_tick=1000, max_tick_seconds=1e9,
    )
    spooler = UploadSpooler(store, cfg, poster=_asgi_poster(app))
    result = spooler.tick()
    assert result.errors and "401" in result.errors[0]
