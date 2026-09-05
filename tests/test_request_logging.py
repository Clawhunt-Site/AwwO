"""FastAPI request-logging middleware (P0a-D): access log metadata + trace correlation."""
from __future__ import annotations

import json
import logging

from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.logging_config import configure_logging


def _read_access(log_file) -> list[dict]:
    for handler in logging.getLogger("superclaw").handlers:
        handler.flush()
    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    rows = [json.loads(line) for line in lines if line.strip()]
    return [r for r in rows if r.get("logger") == "superclaw.api.access"]


def _promote_latest_route_before_spa_fallback(app) -> None:
    latest = app.router.routes.pop()
    for index, route in enumerate(app.router.routes):
        if getattr(route, "path", None) == "/{full_path:path}":
            app.router.routes.insert(index, latest)
            return
    app.router.routes.append(latest)


def test_request_id_echoed_and_logged(monkeypatch, tmp_path):
    log_file = tmp_path / "access.log"
    monkeypatch.setenv("SUPERCLAW_LOG_FILE", str(log_file))
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "json")
    configure_logging(force=True)  # create_app's call is idempotent; force a re-read of env
    app = create_app(str(tmp_path / "state.db"))
    client = TestClient(app)

    resp = client.get("/health", headers={"X-Request-Id": "req_custom"})
    assert resp.status_code == 200
    # Inbound request id is honoured + echoed back to the client.
    assert resp.headers["x-request-id"] == "req_custom"

    access = _read_access(log_file)
    done = [r for r in access if "request.done" in r["msg"]]
    assert done, "no request.done access log emitted"
    last = done[-1]
    assert "path=/health" in last["msg"]
    assert "status=200" in last["msg"]
    assert last["request_id"] == "req_custom"  # trace correlation injected
    assert "trace_id" in last  # a trace_id was bound for the request


def test_request_id_generated_when_absent(monkeypatch, tmp_path):
    log_file = tmp_path / "access.log"
    monkeypatch.setenv("SUPERCLAW_LOG_FILE", str(log_file))
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "json")
    configure_logging(force=True)  # create_app's call is idempotent; force a re-read of env
    app = create_app(str(tmp_path / "state.db"))
    client = TestClient(app)

    resp = client.get("/health")
    assert resp.status_code == 200
    generated = resp.headers["x-request-id"]
    assert generated.startswith("req_")  # generated when no inbound header

    access = _read_access(log_file)
    done = [r for r in access if "request.done" in r["msg"]]
    assert done and done[-1]["request_id"] == generated


def test_unsafe_inbound_request_id_is_replaced(monkeypatch, tmp_path):
    log_file = tmp_path / "access.log"
    monkeypatch.setenv("SUPERCLAW_LOG_FILE", str(log_file))
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "json")
    configure_logging(force=True)
    app = create_app(str(tmp_path / "state.db"))
    client = TestClient(app)

    # A crafted, non-token request id must NOT be honoured/echoed; a fresh one is used.
    resp = client.get("/health", headers={"X-Request-Id": "not a safe id !!!"})
    assert resp.status_code == 200
    echoed = resp.headers["x-request-id"]
    assert echoed.startswith("req_")
    assert echoed != "not a safe id !!!"


def test_error_path_response_carries_request_id(monkeypatch, tmp_path):
    log_file = tmp_path / "access.log"
    monkeypatch.setenv("SUPERCLAW_LOG_FILE", str(log_file))
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "json")
    configure_logging(force=True)
    app = create_app(str(tmp_path / "state.db"))

    @app.get("/_boom_test")
    def _boom():
        raise RuntimeError("kaboom")

    _promote_latest_route_before_spa_fallback(app)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/_boom_test", headers={"X-Request-Id": "req_err"})
    # The unhandled-exception 500 — the case that most needs correlation — must
    # still echo X-Request-Id and the error must be logged with the same id.
    assert resp.status_code == 500
    assert resp.headers["x-request-id"] == "req_err"
    access = _read_access(log_file)
    err = [r for r in access if "request.error" in r["msg"]]
    assert err and err[-1]["request_id"] == "req_err"


def test_streaming_response_still_carries_request_id(monkeypatch, tmp_path):
    # Contract: even though completion/duration semantics are headers-ready (not
    # body-finished) for streaming, the X-Request-Id correlation header is still
    # attached and the body is delivered intact.
    log_file = tmp_path / "access.log"
    monkeypatch.setenv("SUPERCLAW_LOG_FILE", str(log_file))
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "json")
    configure_logging(force=True)
    app = create_app(str(tmp_path / "state.db"))

    @app.get("/_stream_test")
    def _stream():
        def gen():
            yield "a"
            yield "b"
        return StreamingResponse(gen(), media_type="text/plain")

    _promote_latest_route_before_spa_fallback(app)
    client = TestClient(app)
    resp = client.get("/_stream_test", headers={"X-Request-Id": "req_stream"})
    assert resp.status_code == 200
    assert resp.text == "ab"
    assert resp.headers["x-request-id"] == "req_stream"
