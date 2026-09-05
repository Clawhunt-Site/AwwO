"""CLI + contract tests for the URL preview-proxy (B line stage 2).

`superclaw web preview` drives the same fetch_url_preview kernel logic and stable
error codes the API/Web will, and build_preview_contract() projects them.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from typer.testing import CliRunner

from superclaw import web_preview as wp
from superclaw.cli import app
from superclaw.ui_contracts import build_preview_contract

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_ambient_proxy(monkeypatch):
    """Env-independence: neutralize any OS proxy so the resolve-and-pin path is the
    default here regardless of the dev machine's HTTP(S)_PROXY (the kernel now
    consults the OS proxy by default; without this a proxied dev box would route
    these SSRF tests through the real proxy)."""
    import urllib.request

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_GET(self):  # noqa: N802
        body = b'<html><body><p>hello</p><a href="https://e.com/x">link</a></body></html>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()


def test_cli_web_preview_text(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)  # allow loopback
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    result = runner.invoke(app, ["web", "preview", url])
    assert result.exit_code == 0, result.output
    assert "status=200" in result.output
    assert "extracted_links=1" in result.output
    assert "https://e.com/x" in result.output
    # the faithful styled view is surfaced alongside the inert reader (CLI/Web parity)
    assert "page_html_chars=" in result.output


def test_cli_web_preview_json(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    result = runner.invoke(app, ["web", "preview", url, "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert "<p>hello</p>" in payload["sanitized_html"]
    assert payload["extracted_links"][0]["url"] == "https://e.com/x"
    # the sanitized body never carries an href/src (zero-attribute)
    assert "href=" not in payload["sanitized_html"]
    # the faithful styled view is also emitted: real body + script-blocking page CSP
    assert "<p>hello</p>" in payload["page_html"]
    assert "script-src 'none'" in payload["page_html"]


def test_cli_web_preview_blocks_non_http():
    result = runner.invoke(app, ["web", "preview", "file:///etc/passwd"])
    assert result.exit_code == 1
    assert "preview_error=blocked_protocol" in result.output


def test_cli_web_preview_blocks_private(monkeypatch):
    import socket

    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
    )
    result = runner.invoke(app, ["web", "preview", "http://evil.example/"])
    assert result.exit_code == 1
    assert "preview_error=blocked_private" in result.output


def test_contract_projects_error_codes_and_posture():
    contract = build_preview_contract()
    assert tuple(contract["error_codes"]) == tuple(wp._PREVIEW_ERROR_CODES)
    assert contract["max_bytes"] == wp.PREVIEW_MAX_BYTES
    assert contract["ticket_ttl_seconds"] == wp.PREVIEW_TICKET_TTL_S
    assert contract["posture"]["renders_subresources"] is False
    assert contract["posture"]["navigable"] is False
    assert contract["posture"]["credentials_forwarded"] is False


def test_cli_web_preview_no_proxy_forces_pin(monkeypatch):
    import socket

    # Even if a proxy is "available", --no-proxy must skip it and use resolve-and-
    # pin, which rejects the private resolution with the stable error code.
    monkeypatch.setattr(wp, "_proxy_for_host", lambda scheme, host: "http://127.0.0.1:9")
    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
    )
    result = runner.invoke(app, ["web", "preview", "http://evil.example/", "--no-proxy"])
    assert result.exit_code == 1
    assert "preview_error=blocked_private" in result.output
