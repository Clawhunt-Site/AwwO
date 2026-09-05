"""Unit tests for the gateway front door ASGI middleware.

Drives requests through the middleware with a fake ASGI receive/send and an httpx
MockTransport upstream, covering: prefix matching, marker gating (delegate vs
fail-closed 503), the ``/gateway-api`` -> ``/api`` rewrite, server-side control-token
injection (and dropping a client-supplied spoof), and reachable-proxy success.
End-user ``Authorization`` is preserved independently for the SSO identity route.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx

from superclaw.gateway_front_door import (
    GatewayFrontDoorMiddleware,
    read_gateway_control_token,
    read_gateway_port,
)
from superclaw.node_front_door import _PROXY_TIMEOUT


class _InnerApp:
    def __init__(self) -> None:
        self.called = False
        self.scope: dict[str, Any] | None = None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        self.called = True
        self.scope = scope
        await send({"type": "http.response.start", "status": 222, "headers": []})
        await send({"type": "http.response.body", "body": b"inner"})


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)

    async def __aiter__(self) -> Any:
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _http_scope(path: str, *, method: str = "GET", query: bytes = b"", headers: list | None = None) -> dict[str, Any]:
    return {"type": "http", "path": path, "method": method, "query_string": query, "headers": headers or []}


def _drive(middleware: GatewayFrontDoorMiddleware, scope: dict[str, Any], body: bytes = b"") -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []
    pending = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive() -> dict[str, Any]:
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    return sent


def _write_gateway_marker(tmp_path: Path, *, port: int | None = 8796, token: str | None = "secret-token") -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"pid": 4242, "startSignature": "SIG", "instanceId": "i1"}
    if port is not None:
        payload["port"] = port
    (run_dir / "gateway-marker.json").write_text(json.dumps(payload), encoding="utf-8")
    if token is not None:
        (tmp_path / "gateway-control-token").write_text(token, encoding="utf-8")
    return run_dir


def _mock_client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=_PROXY_TIMEOUT)


# --- marker reads -----------------------------------------------------------


def test_read_gateway_port_and_token(tmp_path: Path) -> None:
    run_dir = _write_gateway_marker(tmp_path, port=9001, token="tok")
    assert read_gateway_port(run_dir) == 9001
    assert read_gateway_control_token(run_dir) == "tok"


def test_read_gateway_port_missing_or_invalid(tmp_path: Path) -> None:
    run_dir = _write_gateway_marker(tmp_path, port=None)
    assert read_gateway_port(run_dir) is None
    # absent marker
    assert read_gateway_port(tmp_path / "nope") is None


# --- routing / gating -------------------------------------------------------


def test_non_matching_path_delegates(tmp_path: Path) -> None:
    inner = _InnerApp()
    mw = GatewayFrontDoorMiddleware(inner, run_dir=_write_gateway_marker(tmp_path))
    _drive(mw, _http_scope("/api/automations"))  # not under /gateway-api
    assert inner.called is True


def test_gateway_prefix_without_marker_delegates(tmp_path: Path) -> None:
    inner = _InnerApp()
    run_dir = tmp_path / "run"  # no marker written
    mw = GatewayFrontDoorMiddleware(inner, run_dir=run_dir)
    _drive(mw, _http_scope("/gateway-api/automations"))
    assert inner.called is True  # delegate -> route 404s as before, never spawns


def test_marker_present_but_port_unreadable_fails_closed(tmp_path: Path) -> None:
    inner = _InnerApp()
    run_dir = _write_gateway_marker(tmp_path, port=None)
    mw = GatewayFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive(mw, _http_scope("/gateway-api/automations"))
    assert inner.called is False  # never delegates to Python
    assert sent[0]["status"] == 503


def test_marker_present_but_token_missing_fails_closed(tmp_path: Path) -> None:
    inner = _InnerApp()
    run_dir = _write_gateway_marker(tmp_path, port=8796, token=None)  # marker, no token file
    mw = GatewayFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive(mw, _http_scope("/gateway-api/automations"))
    assert inner.called is False
    assert sent[0]["status"] == 503  # 503, not a forwarded tokenless 401


def test_proxy_rewrites_prefix_and_injects_token(tmp_path: Path) -> None:
    run_dir = _write_gateway_marker(tmp_path, port=8796, token="real-token")
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["path"] = request.url.path
        captured["token"] = request.headers.get("x-superclaw-gateway-token")
        return httpx.Response(201, stream=_ChunkStream([b"{}"]), headers={"content-type": "application/json"})

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    # client tries to spoof a token — it must be dropped and replaced by the real one.
    headers = [(b"x-superclaw-gateway-token", b"spoofed")]
    sent = _drive(mw, _http_scope("/gateway-api/automations", method="POST", headers=headers), body=b"{}")

    assert captured["path"] == "/api/automations"  # ^/gateway-api -> /api
    assert captured["token"] == "real-token"  # server-side token wins over spoof
    assert "127.0.0.1:8796" in captured["url"]  # targets the marker's port
    assert sent[0]["status"] == 201


def test_proxy_preserves_query_string(tmp_path: Path) -> None:
    run_dir = _write_gateway_marker(tmp_path)
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, stream=_ChunkStream([b"[]"]))

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    _drive(mw, _http_scope("/gateway-api/automations", query=b"sessionIssueId=abc"))
    assert captured["url"].endswith("/api/automations?sessionIssueId=abc")


def test_proxy_preserves_user_bearer_separately_from_control_token(tmp_path: Path) -> None:
    run_dir = _write_gateway_marker(tmp_path, token="gateway-control")
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        captured["control"] = request.headers.get("x-superclaw-gateway-token")
        return httpx.Response(200, stream=_ChunkStream([b'{"id":42,"username":"alice"}']))

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    sent = _drive(
        mw,
        _http_scope(
            "/gateway-api/auth/me",
            headers=[(b"authorization", b"Bearer signed.jwt.token")],
        ),
    )

    assert sent[0]["status"] == 200
    assert captured == {
        "authorization": "Bearer signed.jwt.token",
        "control": "gateway-control",
    }


# --- body framing (shares _prepare_forward_body with the Node front door) ----


def test_gateway_post_body_buffered_sets_content_length_never_chunked(tmp_path: Path) -> None:
    # Same root fix as the Node front door: with no Content-Length on the scope (frozen
    # desktop), the write body is buffered and forwarded with an explicit length, never
    # chunked — the co-launched gateway also reads a chunked request body as empty.
    run_dir = _write_gateway_marker(tmp_path, port=8796, token="real-token")
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        captured["content_length"] = request.headers.get("content-length")
        captured["transfer_encoding"] = request.headers.get("transfer-encoding")
        return httpx.Response(201, stream=_ChunkStream([b"{}"]), headers={"content-type": "application/json"})

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    scope = _http_scope("/gateway-api/automations", method="POST", headers=[(b"content-type", b"application/json")])
    sent = _drive(mw, scope, body=b'{"name":"acme"}')
    assert captured["body"] == b'{"name":"acme"}'
    assert captured["content_length"] == str(len(b'{"name":"acme"}'))
    assert captured["transfer_encoding"] is None
    assert sent[0]["status"] == 201


def test_gateway_post_body_over_cap_returns_413(tmp_path: Path, monkeypatch: Any) -> None:
    # A buffered gateway write beyond the cap fails closed with 413, never reaching upstream.
    import superclaw.node_front_door as nfd

    monkeypatch.setattr(nfd, "_MAX_BUFFERED_BODY_BYTES", 8)
    run_dir = _write_gateway_marker(tmp_path, port=8796, token="real-token")
    called = {"upstream": False}

    async def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        called["upstream"] = True
        return httpx.Response(201)

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    scope = _http_scope("/gateway-api/automations", method="POST", headers=[(b"content-type", b"application/json")])
    sent = _drive(mw, scope, body=b'{"name":"way-too-long-to-buffer"}')
    assert sent[0]["status"] == 413
    assert called["upstream"] is False


def test_gateway_post_body_client_disconnect_mid_buffer_is_swallowed(tmp_path: Path) -> None:
    # Symmetric to the Node front door: a mid-upload disconnect while the buffered path
    # (no Content-Length) reads the body must be swallowed, never propagate, never reach
    # the upstream gateway with a truncated body.
    run_dir = _write_gateway_marker(tmp_path, port=8796, token="real-token")
    called = {"upstream": False}

    async def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        called["upstream"] = True
        return httpx.Response(201)

    mw = GatewayFrontDoorMiddleware(_InnerApp(), run_dir=run_dir, client=_mock_client(handler))
    sent: list[dict[str, Any]] = []
    pending = [
        {"type": "http.request", "body": b'{"partial":', "more_body": True},
        {"type": "http.disconnect"},
    ]

    async def receive() -> dict[str, Any]:
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = _http_scope("/gateway-api/automations", method="POST", headers=[(b"content-type", b"application/json")])
    asyncio.run(mw(scope, receive, send))  # must NOT raise
    assert called["upstream"] is False
    assert sent == []
