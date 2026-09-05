"""Collection-server unit tests (SQLite backend via TestClient)."""
from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from apps.telemetry_server.config import ConfigError, ServerConfig
from apps.telemetry_server.db import Database
from apps.telemetry_server.main import create_app


def _config(tmp_path, *, token: str = "", query_token: str = "", env: str = "local") -> ServerConfig:
    return ServerConfig(
        database_url=f"sqlite:///{tmp_path/'tele.db'}",
        ingest_token=token,
        query_token=query_token,
        host="127.0.0.1",
        port=8900,
        tier_c_retention_days=7,
        env=env,
        retention_interval_seconds=0.0,  # no background thread in tests
    )


def _client(tmp_path, **kw) -> TestClient:
    cfg = _config(tmp_path, **kw)
    return TestClient(create_app(cfg, Database(cfg.database_url)))


def test_health_ok(tmp_path):
    client = _client(tmp_path)
    r = client.get("/v1/telemetry/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_ingest_tier_a_then_query(tmp_path):
    client = _client(tmp_path)
    envelope = {
        "upload_id": "u1", "device_id": "devA", "tier": "A",
        "rows": [{"trace_id": "t1", "run_id": "r1", "model": "claude-opus-4-8",
                  "input_tokens": 10, "output_tokens": 5, "cost_cents": 42,
                  "status": "completed", "billing_lane": "byo", "occurred_at": 100.0}],
    }
    ack = client.post("/v1/telemetry/ingest", json=envelope).json()
    assert ack["status"] == "accepted" and ack["accepted_rows"] == 1

    stats = client.get("/api/stats").json()
    assert stats["tier_a_rows"] == 1 and stats["devices"] == 1
    assert stats["total_cost_cents"] == 42.0

    rows = client.get("/api/query", params={"tier": "A", "trace_id": "t1"}).json()["rows"]
    assert len(rows) == 1 and rows[0]["model"] == "claude-opus-4-8"


def test_ingest_is_idempotent_on_upload_id(tmp_path):
    client = _client(tmp_path)
    envelope = {"upload_id": "dup", "device_id": "d", "tier": "A",
                "rows": [{"run_id": "r", "cost_cents": 1, "occurred_at": 1.0}]}
    first = client.post("/v1/telemetry/ingest", json=envelope).json()
    second = client.post("/v1/telemetry/ingest", json=envelope).json()
    assert first["status"] == "accepted"
    assert second["status"] == "duplicate" and second["accepted_rows"] == 0
    assert client.get("/api/stats").json()["tier_a_rows"] == 1  # not double-inserted


def test_tier_c_stores_ciphertext_and_query_hides_it(tmp_path):
    client = _client(tmp_path)
    blob = base64.b64encode(b"secret-ciphertext").decode()
    envelope = {
        "upload_id": "c1", "device_id": "d", "tier": "C",
        "rows": [{"trace_id": "t", "payload_kind": "prompt", "key_id": "k1",
                  "ciphertext_b64": blob, "nonce_b64": base64.b64encode(b"n").decode(),
                  "wrapped_cek_b64": base64.b64encode(b"w").decode(),
                  "ttl_expires_at": 9999999999.0}]}
    assert client.post("/v1/telemetry/ingest", json=envelope).json()["status"] == "accepted"
    rows = client.get("/api/query", params={"tier": "C"}).json()["rows"]
    assert len(rows) == 1
    # Ciphertext bytes NEVER come back over the query API — metadata only.
    assert "ciphertext" not in rows[0] and "payload_kind" in rows[0]


def test_tier_c_bad_base64_rejected(tmp_path):
    client = _client(tmp_path)
    import base64 as _b64
    good = _b64.b64encode(b"x").decode()
    envelope = {"upload_id": "c2", "device_id": "d", "tier": "C",
                "rows": [{"payload_kind": "prompt", "ciphertext_b64": "!!notb64!!",
                          "nonce_b64": good, "wrapped_cek_b64": good}]}
    ack = client.post("/v1/telemetry/ingest", json=envelope).json()
    assert ack["status"] == "rejected" and "base64" in (ack["reason"] or "")


def test_tier_c_missing_envelope_field_rejected(tmp_path):
    # Fail-closed: a Tier C row without the full envelope must NOT be stored.
    client = _client(tmp_path)
    envelope = {"upload_id": "c3", "device_id": "d", "tier": "C",
                "rows": [{"payload_kind": "prompt", "trace_id": "t"}]}  # no ciphertext
    ack = client.post("/v1/telemetry/ingest", json=envelope).json()
    assert ack["status"] == "rejected" and "envelope" in (ack["reason"] or "")
    assert client.get("/api/stats").json()["tier_c_rows"] == 0


def test_query_token_separate_from_ingest_token(tmp_path):
    # A client holding only the ingest token must NOT be able to read the dataset.
    client = _client(tmp_path, token="ingest-tok", query_token="operator-tok")
    envelope = {"upload_id": "q1", "device_id": "d", "tier": "A",
                "rows": [{"run_id": "r", "cost_cents": 1, "occurred_at": 1.0}]}
    # ingest works with ingest token
    assert client.post("/v1/telemetry/ingest", json=envelope,
                       headers={"authorization": "Bearer ingest-tok"}).status_code == 200
    # but the ingest token cannot query
    assert client.get("/api/stats", headers={"authorization": "Bearer ingest-tok"}).status_code == 401
    # operator token can
    assert client.get("/api/stats", headers={"authorization": "Bearer operator-tok"}).status_code == 200


def test_production_requires_distinct_tokens():
    base = {"TELEMETRY_ENV": "production", "TELEMETRY_INGEST_TOKEN": "a"}
    with pytest.raises(ConfigError):  # missing query token
        ServerConfig.from_env(base)
    with pytest.raises(ConfigError):  # query == ingest
        ServerConfig.from_env({**base, "TELEMETRY_QUERY_TOKEN": "a"})
    cfg = ServerConfig.from_env({**base, "TELEMETRY_QUERY_TOKEN": "b",
                                 "TELEMETRY_DATABASE_URL": "sqlite:///x.db"})
    assert cfg.is_production and cfg.query_auth_required


def test_dialect_translate_is_quote_aware():
    db = Database("postgresql://u:p@h:5432/db")
    assert db.dialect.sql("WHERE a = ?") == "WHERE a = %s"
    # a literal ? inside single quotes must NOT be turned into %s
    assert db.dialect.sql("SELECT '?' WHERE a = ?") == "SELECT '?' WHERE a = %s"
    # nor inside a dollar-quoted literal
    assert db.dialect.sql("SELECT $$?$$ WHERE a = ?") == "SELECT $$?$$ WHERE a = %s"
    assert db.dialect.sql("SELECT $t$a?b$t$ WHERE c = ?") == "SELECT $t$a?b$t$ WHERE c = %s"
    # '' escape inside a literal stays intact
    assert db.dialect.sql("WHERE a = '' AND b = ?") == "WHERE a = '' AND b = %s"
    # an UNTERMINATED dollar-quote must not swallow the rest: real placeholders
    # after it still translate (malformed SQL is the caller's bug, not ours)
    assert db.dialect.sql("SELECT $x$open ? WHERE a = ?") == "SELECT $x$open %s WHERE a = %s"


def test_record_batch_duplicate_rolls_back_not_commit():
    # Drives the duplicate→rollback→return("duplicate",0) path with a fake
    # connection (dialect-agnostic code), so the PostgreSQL fix — rollback the
    # aborted tx instead of letting an implicit commit raise — has automated
    # evidence without needing a live postgres.
    import sqlite3 as _sqlite

    class FakeCursor:
        def execute(self, sql, params=()):
            raise _sqlite.IntegrityError("duplicate key")

    class FakeConn:
        def __init__(self):
            self.rolled_back = False
            self.committed = False
        def cursor(self):
            return FakeCursor()
        def rollback(self):
            self.rolled_back = True
        def commit(self):
            self.committed = True
        def close(self):
            pass

    db = Database("sqlite:///unused.db")
    fake = FakeConn()
    db.connect = lambda: fake  # type: ignore[method-assign]
    status, n = db.record_batch(upload_id="dup", device_id="d", tier="A",
                                agreement_version=None, rows=[{"run_id": "r"}])
    assert (status, n) == ("duplicate", 0)
    assert fake.rolled_back and not fake.committed


def test_auth_required_when_token_set(tmp_path):
    client = _client(tmp_path, token="sekret")
    envelope = {"upload_id": "a", "device_id": "d", "tier": "A", "rows": []}
    assert client.post("/v1/telemetry/ingest", json=envelope).status_code == 401
    ok = client.post("/v1/telemetry/ingest", json=envelope,
                     headers={"authorization": "Bearer sekret"})
    assert ok.status_code == 200


def test_unknown_tier_envelope_rejected_by_schema(tmp_path):
    client = _client(tmp_path)
    r = client.post("/v1/telemetry/ingest",
                    json={"upload_id": "x", "device_id": "d", "tier": "Z", "rows": []})
    assert r.status_code == 422  # pydantic Literal rejects unknown tier


def test_tier_c_retention_deletes_expired(tmp_path):
    cfg = _config(tmp_path)
    db = Database(cfg.database_url)
    db.init_schema()
    db.record_batch(upload_id="old", device_id="d", tier="C", agreement_version=None,
                    rows=[{"payload_kind": "p", "ttl_expires_at": 1.0,
                           "ciphertext": b"x", "nonce": b"n", "wrapped_cek": b"w"}])
    deleted = db.apply_retention(retention_days=7, now=1000.0)
    assert deleted == 1 and db.stats()["tier_c_rows"] == 0


def test_production_requires_token():
    with pytest.raises(ConfigError):
        ServerConfig.from_env({"TELEMETRY_ENV": "production"})


def test_postgres_url_recognized_without_driver():
    # Constructing the Database for a postgres URL must not require psycopg until
    # a connection is attempted — the dialect is recognized eagerly though.
    try:
        db = Database("postgresql://u:p@h:5432/db")
    except Exception as exc:  # noqa: BLE001
        # Only acceptable failure is the lazy psycopg import for IntegrityError.
        assert "psycopg" in str(exc)
    else:
        assert db.dialect.name == "postgres"
