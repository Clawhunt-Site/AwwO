"""API tests for the URL preview-proxy ticket endpoints (B line stage 3).

POST /api/preview/tickets mints a signed bearer ticket; GET /api/preview/{ticket}
verifies it and returns the sanitized reader JSON. Both require the control token
(HEADER-ONLY, never a ?token= query) AND, for GET, a valid ticket; when no token
is configured the endpoints are fail-closed to loopback callers only. All content
guards are delegated to the kernel.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw import web_preview as wp

_TOKEN = "test-token"
_HDR = {"X-SuperClaw-Token": _TOKEN}


@pytest.fixture(autouse=True)
def _no_ambient_proxy(monkeypatch):
    """Env-independence: neutralize any OS proxy so these endpoint tests fetch via
    the resolve-and-pin path regardless of the dev machine's HTTP(S)_PROXY."""
    import urllib.request

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_GET(self):  # noqa: N802
        body = b'<html><body><p>hi</p><a href="https://e.com/x">L</a></body></html>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def http_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()


@pytest.fixture
def client(tmp_path, monkeypatch):
    # isolate the signing-key file under a temp HOME; configure a control token so
    # the TestClient (a non-loopback peer) authenticates via the header.
    monkeypatch.setenv("HOME", str(tmp_path))
    app = create_app(state_path=tmp_path / "state.db")
    app.state.control_token = _TOKEN
    return TestClient(app)


def _mint(client, url: str, headers=None):
    return client.post("/api/preview/tickets", json={"url": url}, headers=headers if headers is not None else _HDR)


def test_mint_rejects_non_http(client):
    resp = _mint(client, "file:///etc/passwd")
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "blocked_protocol"


def test_preview_roundtrip(client, http_server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)  # allow loopback fetch target
    url = f"http://127.0.0.1:{http_server.server_address[1]}/"
    ticket = _mint(client, url).json()["ticket"]
    resp = client.get(f"/api/preview/{ticket}", headers=_HDR)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "<p>hi</p>" in body["sanitized_html"]
    assert "href=" not in body["sanitized_html"]  # zero-attribute
    # the faithful styled view rides the same response (real body + script-block CSP)
    assert "<p>hi</p>" in body["page_html"]
    assert "script-src 'none'" in body["page_html"]
    assert f'<base href="{url}"' in body["page_html"]
    assert body["extracted_links"][0]["url"] == "https://e.com/x"
    assert resp.headers["cache-control"] == "no-store"


def test_get_rejects_tampered_ticket(client):
    resp = client.get("/api/preview/not.a.valid.ticket", headers=_HDR)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "invalid_ticket"


def test_principal_rotation_invalidates_ticket(client, http_server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    client.app.state.control_token = "token-A"
    url = f"http://127.0.0.1:{http_server.server_address[1]}/"
    ticket = client.post(
        "/api/preview/tickets", json={"url": url}, headers={"X-SuperClaw-Token": "token-A"}
    ).json()["ticket"]
    # rotate the operator session -> the ticket's principal no longer matches
    client.app.state.control_token = "token-B"
    resp = client.get(f"/api/preview/{ticket}", headers={"X-SuperClaw-Token": "token-B"})
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "invalid_ticket"


def test_get_requires_control_token(client):
    # no token header -> 401 (header-only token required)
    resp = client.get("/api/preview/whatever.ticket")
    assert resp.status_code == 401


def test_mint_response_is_no_store(client):
    resp = _mint(client, "https://example.com/")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"


def test_corrupt_sign_key_is_regenerated(client, http_server, monkeypatch, tmp_path):
    # a short/corrupt key file must be regenerated (len-32 invariant), never used
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    key_path = tmp_path / ".superclaw" / "preview-sign.key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(b"short")  # 5 bytes -> corrupt
    url = f"http://127.0.0.1:{http_server.server_address[1]}/"
    ticket = _mint(client, url).json()["ticket"]
    assert client.get(f"/api/preview/{ticket}", headers=_HDR).status_code == 200
    assert len(key_path.read_bytes()) == 32  # regenerated to the full key


def test_mint_requires_control_token(client):
    # no token header -> 401
    assert _mint(client, "https://example.com/", headers={}).status_code == 401
    # correct token -> 200
    assert _mint(client, "https://example.com/").status_code == 200


def test_preview_token_query_param_is_rejected(client):
    # the control token must be header-only — a ?token= query would land in the
    # access log alongside the ticket (log-replay).
    assert client.post(
        "/api/preview/tickets?token=" + _TOKEN, json={"url": "https://example.com/"}
    ).status_code == 401
    assert client.get("/api/preview/some.ticket?token=" + _TOKEN).status_code == 401


def test_tokenless_non_loopback_caller_is_refused(tmp_path, monkeypatch):
    # With NO control token configured, a non-loopback caller (TestClient's peer
    # is "testclient", not a loopback IP) must be refused — a non-loopback bind
    # without a token can never be an open unauthenticated preview proxy.
    monkeypatch.setenv("HOME", str(tmp_path))
    app = create_app(state_path=tmp_path / "state.db")
    app.state.control_token = None
    c = TestClient(app)
    assert c.post("/api/preview/tickets", json={"url": "https://example.com/"}).status_code == 401
    assert c.get("/api/preview/some.ticket").status_code == 401


def test_allow_proxy_bound_into_ticket_and_passed_to_fetch(client, monkeypatch):
    # The per-request allow_proxy choice must be HMAC-bound into the ticket at mint
    # and flow to the kernel fetch at GET — default True, explicit False honoured.
    captured: dict = {}

    def _fake_fetch(url, **kw):
        captured["url"] = url
        captured["allow_proxy"] = kw.get("allow_proxy")
        return wp.PreviewResult(
            ok=True, final_url=url, status=200, content_type="text/html",
            sanitized_html="<p>x</p>", extracted_links=[], truncated=False,
        )

    monkeypatch.setattr(wp, "fetch_url_preview", _fake_fetch)

    # default: allow_proxy omitted -> True
    r = client.post("/api/preview/tickets", json={"url": "https://example.com/"}, headers=_HDR)
    assert r.status_code == 200
    ticket = r.json()["ticket"]
    assert client.get(f"/api/preview/{ticket}", headers=_HDR).status_code == 200
    assert captured["allow_proxy"] is True

    # explicit opt-out: allow_proxy false -> bound + forwarded
    captured.clear()
    r = client.post("/api/preview/tickets", json={"url": "https://example.com/", "allow_proxy": False}, headers=_HDR)
    ticket = r.json()["ticket"]
    assert client.get(f"/api/preview/{ticket}", headers=_HDR).status_code == 200
    assert captured["allow_proxy"] is False
