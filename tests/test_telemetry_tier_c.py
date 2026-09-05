"""Tier C envelope-encrypted upload path: client seals → server stores ciphertext
zero-knowledge → operator unseals. Plus the fail-closed guards (no key ⇒ inert),
file-scoped idempotency, and poison/transient-failure handling.

RSA keygen is slow, so one module-scoped keypair is reused.
"""
from __future__ import annotations

import base64
import json
import sqlite3

import pytest

from apps.telemetry_server.config import ServerConfig
from apps.telemetry_server.db import Database
from apps.telemetry_server.main import create_app
from superclaw.state import StateStore
from superclaw.telemetry_envelope import generate_keypair, key_id_for, unseal
from superclaw.telemetry_upload import TelemetryConfig, UploadError, UploadSpooler
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def keypair():
    return generate_keypair()


def _server(tmp_path, keypair=None, token=""):
    pub, _ = keypair if keypair else ("", "")
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'collector.db'}",
        ingest_token=token, query_token="", host="127.0.0.1", port=8900,
        tier_c_retention_days=7, env="local", retention_interval_seconds=0.0,
        tier_c_public_key=pub, tier_c_key_id=key_id_for(pub) if pub else "",
    )
    db = Database(cfg.database_url)
    return create_app(cfg, db), db, cfg


def _asgi_poster(app):
    client = TestClient(app)

    def poster(url, payload, token):
        headers = {"authorization": f"Bearer {token}"} if token else {}
        resp = client.post("/v1/telemetry/ingest", json=payload, headers=headers)
        if resp.status_code >= 400:
            raise UploadError(f"HTTP {resp.status_code}")
        return resp.json()

    return poster


def _spooler(app, home, *, public_key="", poster=None):
    cfg = TelemetryConfig(
        endpoint="http://collector.test", token="", enabled_env=True, kill=False,
        max_batch_rows=1000, timeout_seconds=5.0, base_dir=home,
        max_batches_per_tick=1000, max_tick_seconds=1e9, tier_c_public_key=public_key,
    )
    sp = UploadSpooler(StateStore(str(home / "state.db")), cfg,
                       poster=poster or _asgi_poster(app))
    sp.set_consent(enabled=True, agreement_version="2026-06-23")
    return sp, cfg


def _spool_file(home, name, plaintext: bytes, **meta):
    spool = home / "tier-c-spool"
    spool.mkdir(exist_ok=True)
    rec = {"plaintext_b64": base64.b64encode(plaintext).decode(), **meta}
    (spool / f"{name}.json").write_text(json.dumps(rec), encoding="utf-8")


def test_keys_endpoint_publishes_configured_public_key(tmp_path, keypair):
    app, _, _ = _server(tmp_path, keypair)
    body = TestClient(app).get("/v1/telemetry/keys").json()
    assert body["public_key"] == keypair[0]
    assert body["key_id"] == key_id_for(keypair[0])


def test_keys_endpoint_fail_closed_when_unconfigured(tmp_path):
    app, _, _ = _server(tmp_path)  # no keypair
    body = TestClient(app).get("/v1/telemetry/keys").json()
    assert body["public_key"] is None and body["key_id"] is None


def test_tier_c_seal_upload_store_unseal_roundtrip(tmp_path, keypair):
    pub, priv = keypair
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    secret = "raw prompt with /Users/leon/secret and full model output".encode()
    _spool_file(home, "rec_001", secret, trace_id="t1", run_id="r1",
                payload_kind="llm.response", occurred_at=100.0, ttl_expires_at=700.0)
    sp, _ = _spooler(app, home, public_key=pub)

    result = sp.tick(drain=True)
    assert not result.errors and result.batches == 1 and result.rows == 1
    assert not (home / "tier-c-spool" / "rec_001.json").exists()  # cleaned up

    # Server stored ONLY ciphertext (zero-knowledge).
    conn = sqlite3.connect(tmp_path / "srv" / "collector.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM tier_c").fetchone()
    assert row["key_id"] == key_id_for(pub)
    assert row["payload_kind"] == "llm.response" and row["trace_id"] == "t1"
    assert secret not in row["ciphertext"]

    # Operator (holding the private key) can recover the plaintext.
    env = {
        "ciphertext_b64": base64.b64encode(row["ciphertext"]).decode(),
        "nonce_b64": base64.b64encode(row["nonce"]).decode(),
        "wrapped_cek_b64": base64.b64encode(row["wrapped_cek"]).decode(),
        "key_id": row["key_id"],
    }
    assert unseal(env, priv) == secret


def test_tier_c_inert_without_public_key(tmp_path, keypair):
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec_001", b"x", trace_id="t", payload_kind="k")
    sp, _ = _spooler(app, home, public_key="")  # fail-closed: no key

    result = sp.tick(drain=True)
    assert result.rows == 0  # nothing sealed/uploaded
    assert (home / "tier-c-spool" / "rec_001.json").exists()  # left untouched
    assert db.stats()["tier_c_rows"] == 0


def test_tier_c_idempotent_resend_no_double_insert(tmp_path, keypair):
    pub, _ = keypair
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    payload = b"same-file"
    _spool_file(home, "rec_dup", payload, payload_kind="k")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)
    # Simulate crash between POST and unlink: the same file reappears.
    _spool_file(home, "rec_dup", payload, payload_kind="k")
    result = sp.tick(drain=True)
    assert result.duplicates == 1  # same file_id => same upload_id => server dedupes
    assert db.stats()["tier_c_rows"] == 1  # never doubled


def test_tier_c_poison_file_dropped_not_wedged(tmp_path, keypair):
    pub, _ = keypair
    app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    spool = home / "tier-c-spool"
    spool.mkdir()
    (spool / "bad.json").write_text("{not valid json", encoding="utf-8")  # poison
    (spool / "nopayload.json").write_text(json.dumps({"trace_id": "t"}), encoding="utf-8")
    sp, _ = _spooler(app, home, public_key=pub)

    result = sp.tick(drain=True)
    assert len(result.errors) == 2 and all("unreadable, dropped" in e for e in result.errors)
    assert not list(spool.glob("*.json"))  # both dropped, queue not wedged


def test_tier_c_network_failure_leaves_file_for_retry(tmp_path, keypair):
    pub, _ = keypair
    app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec_net", b"x", payload_kind="k")

    def failing_poster(url, payload, token):
        raise UploadError("network down")

    sp, _ = _spooler(app, home, public_key=pub, poster=failing_poster)
    result = sp.tick(drain=True)
    assert result.errors and result.rows == 0
    assert (home / "tier-c-spool" / "rec_net.json").exists()  # kept for retry


def test_tier_c_correlation_columns_are_scrubbed(tmp_path, keypair):
    pub, _ = keypair
    app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    # A hostile spool file trying to smuggle a path through a cleartext column.
    _spool_file(home, "rec_evil", b"x", trace_id="/Users/leon/.ssh/id_rsa",
                payload_kind="llm.response")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)

    conn = sqlite3.connect(tmp_path / "srv" / "collector.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT trace_id FROM tier_c").fetchone()
    assert "/Users/leon" not in str(row["trace_id"])  # path guard fired


def test_tier_c_invalid_public_key_is_inert(tmp_path, keypair):
    """A misconfigured key (private key where the public key belongs) keeps Tier C
    inert and leaves the spool file untouched — never churns or half-processes it."""
    _, priv = keypair
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec", b"x", payload_kind="k")
    sp, _ = _spooler(app, home, public_key=priv)  # private key fed as public

    result = sp.tick(drain=True)
    assert result.rows == 0 and db.stats()["tier_c_rows"] == 0
    assert (home / "tier-c-spool" / "rec.json").exists()


def test_tier_c_non_numeric_ttl_is_dropped(tmp_path, keypair):
    pub, _ = keypair
    app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec", b"x", payload_kind="k", ttl_expires_at="/etc/passwd")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)

    conn = sqlite3.connect(tmp_path / "srv" / "collector.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT ttl_expires_at FROM tier_c").fetchone()
    assert row["ttl_expires_at"] is None  # non-numeric coerced away, not stored as text


def test_tier_c_same_name_different_content_not_deduped(tmp_path, keypair):
    """upload_id binds file id AND content hash, so reusing a filename for new
    content is NOT mistaken for a duplicate (which would silently drop it)."""
    pub, _ = keypair
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec", b"content-A", payload_kind="k")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)
    _spool_file(home, "rec", b"content-B", payload_kind="k")  # same name, NEW content
    result = sp.tick(drain=True)
    assert result.duplicates == 0 and db.stats()["tier_c_rows"] == 2  # both retained


def test_server_rejects_smuggled_plaintext_field():
    """The zero-knowledge boundary is server-enforced: a row carrying any field
    outside the allowlist (e.g. plaintext_b64) is rejected at decode."""
    from apps.telemetry_server.schemas import decode_tier_c_rows

    row = {
        "ciphertext_b64": "AA==", "nonce_b64": "AA==", "wrapped_cek_b64": "AA==",
        "plaintext_b64": "c2VjcmV0",  # smuggled raw payload
    }
    with pytest.raises(ValueError, match="disallowed"):
        decode_tier_c_rows([row])


def test_server_keys_never_publishes_private_key(tmp_path, keypair):
    """Even a hand-built config with private material must not leak it via /keys."""
    _, priv = keypair
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'c.db'}", ingest_token="", query_token="",
        host="127.0.0.1", port=8900, tier_c_retention_days=7, env="local",
        retention_interval_seconds=0.0, tier_c_public_key=priv, tier_c_key_id="x",
    )
    app = create_app(cfg, Database(cfg.database_url))
    body = TestClient(app).get("/v1/telemetry/keys").json()
    assert body["public_key"] is None and body["key_id"] is None


def test_server_config_refuses_private_key_at_startup(keypair):
    from apps.telemetry_server.config import ConfigError

    _, priv = keypair
    with pytest.raises(ConfigError, match="PRIVATE"):
        ServerConfig.from_env({"TELEMETRY_TIER_C_PUBLIC_KEY": priv})


def test_server_decode_sanitizes_correlation_and_ttl_independently():
    """The collector neutralizes a hostile/regressed client's cleartext columns on
    its own — not relying on the client having scrubbed them."""
    from apps.telemetry_server.schemas import decode_tier_c_rows

    row = {
        "ciphertext_b64": "AA==", "nonce_b64": "AA==", "wrapped_cek_b64": "AA==",
        "trace_id": "/Users/leon/.ssh/id_rsa", "ttl_expires_at": "/etc/passwd",
        "payload_kind": "llm.response",
    }
    out = decode_tier_c_rows([row])[0]
    assert out["trace_id"] == "<redacted>"  # path neutralized server-side
    assert out["ttl_expires_at"] is None  # non-numeric ttl dropped server-side
    assert out["payload_kind"] == "llm.response"  # clean enum survives


def test_server_config_rejects_junk_public_key():
    from apps.telemetry_server.config import ConfigError

    with pytest.raises(ConfigError, match="not a valid public key"):
        ServerConfig.from_env({"TELEMETRY_TIER_C_PUBLIC_KEY": "not a pem at all"})


def test_server_keys_refuses_invalid_public_key(tmp_path):
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'c.db'}", ingest_token="", query_token="",
        host="127.0.0.1", port=8900, tier_c_retention_days=7, env="local",
        retention_interval_seconds=0.0, tier_c_public_key="junk-not-a-key", tier_c_key_id="x",
    )
    app = create_app(cfg, Database(cfg.database_url))
    body = TestClient(app).get("/v1/telemetry/keys").json()
    assert body["public_key"] is None  # invalid key never advertised


def test_server_keys_derives_key_id_ignoring_configured_value(tmp_path, keypair):
    """A forged/mismatched configured key_id is ignored; /keys advertises the
    fingerprint derived from the public key itself (rotation contract integrity)."""
    pub, _ = keypair
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'c.db'}", ingest_token="", query_token="",
        host="127.0.0.1", port=8900, tier_c_retention_days=7, env="local",
        retention_interval_seconds=0.0, tier_c_public_key=pub, tier_c_key_id="forged",
    )
    app = create_app(cfg, Database(cfg.database_url))
    body = TestClient(app).get("/v1/telemetry/keys").json()
    assert body["key_id"] == key_id_for(pub) and body["key_id"] != "forged"


def test_server_decode_redacts_secret_tokens():
    """A credential smuggled into a cleartext correlation column is redacted
    server-side, not just paths/whitespace."""
    from apps.telemetry_server.schemas import decode_tier_c_rows

    row = {
        "ciphertext_b64": "AA==", "nonce_b64": "AA==", "wrapped_cek_b64": "AA==",
        "trace_id": "sk-proj-ABCDEF1234567890SECRETTOKEN",
    }
    out = decode_tier_c_rows([row])[0]
    assert out["trace_id"] == "<redacted>"


# -- operator unseal path -----------------------------------------------------
def test_sealed_export_endpoint_roundtrip_and_query_hides_ciphertext(tmp_path, keypair):
    """The privileged /api/tier-c/sealed endpoint hands over ciphertext the operator
    can unseal; the day-to-day query_tier still never exposes it."""
    pub, priv = keypair
    app, db, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    secret = b"raw model output to recover later"
    _spool_file(home, "rec", secret, trace_id="t1", payload_kind="llm.response")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)

    plain_rows = db.query_tier("C")
    assert plain_rows and "ciphertext" not in plain_rows[0] and "ciphertext_b64" not in plain_rows[0]

    body = TestClient(app).get("/api/tier-c/sealed").json()
    assert body["count"] == 1
    row = body["rows"][0]
    env = {k: row[k] for k in ("ciphertext_b64", "nonce_b64", "wrapped_cek_b64", "key_id")}
    assert unseal(env, priv) == secret


def test_sealed_export_requires_operator_token(tmp_path, keypair):
    pub, _ = keypair
    cfg = ServerConfig(
        database_url=f"sqlite:///{tmp_path/'c.db'}", ingest_token="ingest",
        query_token="operator-tok", host="127.0.0.1", port=8900, tier_c_retention_days=7,
        env="local", retention_interval_seconds=0.0, tier_c_public_key=pub, tier_c_key_id="",
    )
    client = TestClient(create_app(cfg, Database(cfg.database_url)))
    assert client.get("/api/tier-c/sealed").status_code == 401
    ok = client.get("/api/tier-c/sealed", headers={"Authorization": "Bearer operator-tok"})
    assert ok.status_code == 200


def test_cli_unseal_tier_c_decrypts_locally(tmp_path, keypair, monkeypatch):
    """The operator CLI fetches sealed rows and decrypts them with the private key;
    plaintext is printed and the server is never asked to decrypt."""
    import httpx
    from typer.testing import CliRunner

    from superclaw.cli import app as cli_app

    pub, priv = keypair
    srv_app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    secret = "解封还原的原始内容".encode()
    _spool_file(home, "rec", secret, trace_id="t9", payload_kind="llm.response")
    sp, _ = _spooler(srv_app, home, public_key=pub)
    sp.tick(drain=True)
    sealed = TestClient(srv_app).get("/api/tier-c/sealed").json()

    class _Resp:
        def json(self):
            return sealed

        def raise_for_status(self):
            return None

    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp())
    key_file = tmp_path / "operator.pem"
    key_file.write_text(priv, encoding="utf-8")

    result = CliRunner().invoke(
        cli_app,
        ["telemetry", "unseal-tier-c", "--private-key", str(key_file),
         "--server", "http://collector.example", "--query-token", "x"],
    )
    assert result.exit_code == 0, result.output
    assert "解封还原的原始内容" in result.output and "t9" in result.output


def test_sealed_export_is_audited_server_side(tmp_path, keypair, caplog):
    """Every ciphertext hand-out is traced server-side — even a raw client that
    bypasses the CLI leaves an audit record."""
    import logging

    pub, _ = keypair
    app, _, _ = _server(tmp_path / "srv", keypair)
    home = tmp_path / "client"
    home.mkdir()
    _spool_file(home, "rec", b"x", trace_id="taudit", payload_kind="k")
    sp, _ = _spooler(app, home, public_key=pub)
    sp.tick(drain=True)
    with caplog.at_level(logging.INFO, logger="telemetry_server"):
        TestClient(app).get("/api/tier-c/sealed?trace_id=taudit")
    assert any(
        "tier_c_sealed export" in r.getMessage() and "taudit" in r.getMessage()
        for r in caplog.records
    )


def test_cli_unseal_fail_closed_on_unexpected_response(tmp_path, keypair, monkeypatch):
    """A 200 from the wrong service / a schema regression with no 'rows' must NOT be
    treated as an empty success."""
    import httpx
    from typer.testing import CliRunner

    from superclaw.cli import app as cli_app

    _, priv = keypair

    class _Resp:
        def json(self):
            return {"unexpected": "no rows here"}

        def raise_for_status(self):
            return None

    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp())
    key_file = tmp_path / "k.pem"
    key_file.write_text(priv, encoding="utf-8")
    result = CliRunner().invoke(
        cli_app,
        ["telemetry", "unseal-tier-c", "--private-key", str(key_file), "--server", "http://x"],
    )
    assert result.exit_code == 1
    assert "rows" in result.output.lower()
