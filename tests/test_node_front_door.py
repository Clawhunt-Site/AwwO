"""Unit tests for the Node front door ASGI reverse proxy (node_front_door.py).

In-process, instant, no real Node and no subprocess: a fake Node is injected via an
httpx.MockTransport client, requests are driven through the middleware with fake
ASGI receive/send, and async paths run under asyncio.run (no pytest-asyncio dep).
Covers prefix routing, marker gating, rewrite, header hygiene, request-body
streaming, SSE chunk streaming, delegation, and fail-closed 503.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
from websockets.exceptions import ConnectionClosed

from superclaw.node_front_door import (
    _PROXY_READ_TIMEOUT_SECONDS,
    _PROXY_TIMEOUT,
    NodeFrontDoorMiddleware,
    _ClientDisconnected,
    _is_sse_request,
    _connection_hop_headers,
    _declared_content_length,
    _http_to_ws,
    _request_has_body,
    _request_headers,
    _response_headers,
    _stream_request_body,
    _ws_forward_headers,
)
from superclaw.node_runtime import NODE_MARKER_NAME


# --- harness ---------------------------------------------------------------


class _InnerApp:
    """Sentinel wrapped app: records whether the middleware delegated to it."""

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


def _drive(middleware: NodeFrontDoorMiddleware, scope: dict[str, Any], body: bytes = b"") -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []
    pending = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive() -> dict[str, Any]:
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    return sent


def _write_marker(tmp_path: Path, base_url: str = "http://127.0.0.1:3100") -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / NODE_MARKER_NAME).write_text(json.dumps({"base_url": base_url, "port": 3100}), encoding="utf-8")
    return run_dir


def _mock_client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=_PROXY_TIMEOUT)


# --- pure helpers ----------------------------------------------------------


def test_request_headers_strip_hop_by_hop_and_host() -> None:
    raw = [(b"host", b"x"), (b"connection", b"keep-alive"), (b"content-length", b"5"), (b"x-keep", b"1")]
    out = dict(_request_headers(raw, _connection_hop_headers(raw)))
    assert out == {"x-keep": "1"}


def test_request_headers_strip_dynamic_connection_hop() -> None:
    # A header named in Connection: is hop-by-hop and must not be forwarded.
    raw = [(b"connection", b"x-custom, keep-alive"), (b"x-custom", b"secret"), (b"x-keep", b"1")]
    out = dict(_request_headers(raw, _connection_hop_headers(raw)))
    assert out == {"x-keep": "1"}


def test_response_headers_strip_transfer_encoding_and_dynamic_hop() -> None:
    raw = [
        (b"transfer-encoding", b"chunked"),
        (b"connection", b"x-trailer"),
        (b"x-trailer", b"drop-me"),
        (b"content-type", b"text/html"),
    ]
    out = _response_headers(raw, _connection_hop_headers(raw))
    assert out == [(b"content-type", b"text/html")]


def test_request_has_body() -> None:
    assert _request_has_body([(b"content-length", b"7")]) is True
    assert _request_has_body([(b"content-length", b"0")]) is False
    assert _request_has_body([(b"transfer-encoding", b"chunked")]) is True
    assert _request_has_body([(b"accept", b"*/*")]) is False
    assert _request_has_body([]) is False


def test_declared_content_length_only_trusts_unambiguous_length() -> None:
    # A single valid non-negative length is usable to restore framing while streaming.
    assert _declared_content_length([(b"content-length", b"7")]) == 7
    assert _declared_content_length([(b"content-length", b"0")]) == 0
    # Ambiguous / unsafe -> None (force buffer + recompute), never frame on a bad length.
    assert _declared_content_length([]) is None  # absent (the frozen-desktop case)
    assert _declared_content_length([(b"content-length", b"-1")]) is None  # negative
    assert _declared_content_length([(b"content-length", b"nope")]) is None  # malformed
    assert _declared_content_length([(b"content-length", b"5"), (b"content-length", b"6")]) is None  # conflict
    assert _declared_content_length([(b"content-length", b"5"), (b"content-length", b"5")]) == 5  # dup-agree
    # RFC 7230 §3.3.3: Transfer-Encoding wins; any Content-Length must be ignored.
    assert _declared_content_length([(b"content-length", b"5"), (b"transfer-encoding", b"chunked")]) is None


def test_match_prefix_vs_exact(tmp_path: Path) -> None:
    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=tmp_path)
    # prefix routes match the whole subtree
    assert mw._match("/paperclip-api/companies")[0].prefix == "/paperclip-api"
    assert mw._match("/api/chat/stream")[0].prefix == "/api/chat"
    # /v1/skills is EXACT: the composer inventory goes to Node, but /v1/skills/build
    # (Python skill tooling) must NOT be captured.
    assert mw._match("/v1/skills")[0].prefix == "/v1/skills"
    assert mw._match("/v1/skills/build") is None
    assert mw._match("/v1/skills/import") is None
    assert mw._match("/api/health") is None
    assert mw._match("/v1/other") is None


def test_exact_route_subpath_delegates_to_python(tmp_path: Path) -> None:
    # marker present, but POST /v1/skills/build is Python-owned tooling -> delegate,
    # never proxied to Node (which only serves GET /v1/skills).
    run_dir = _write_marker(tmp_path)
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive(mw, _http_scope("/v1/skills/build", method="POST"))
    assert inner.called is True
    assert sent[0]["status"] == 222


def test_stream_request_body_yields_then_stops() -> None:
    pending = [
        {"type": "http.request", "body": b"ab", "more_body": True},
        {"type": "http.request", "body": b"cd", "more_body": False},
        {"type": "http.request", "body": b"NEVER", "more_body": False},
    ]

    async def receive() -> dict[str, Any]:
        return pending.pop(0)

    async def collect() -> list[bytes]:
        return [chunk async for chunk in _stream_request_body(receive)]

    assert asyncio.run(collect()) == [b"ab", b"cd"]


def test_stream_request_body_raises_on_disconnect() -> None:
    # A mid-upload disconnect must raise (so httpx aborts the upstream request)
    # rather than quietly ending the body as if it were complete.
    pending = [
        {"type": "http.request", "body": b"partial", "more_body": True},
        {"type": "http.disconnect"},
    ]

    async def receive() -> dict[str, Any]:
        return pending.pop(0)

    async def drain() -> None:
        async for _chunk in _stream_request_body(receive):
            pass

    try:
        asyncio.run(drain())
    except _ClientDisconnected:
        return
    raise AssertionError("expected _ClientDisconnected on mid-upload disconnect")


# --- delegation (front door inactive) --------------------------------------


def test_no_marker_delegates_to_app(tmp_path: Path) -> None:
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=tmp_path)  # no marker written
    sent = _drive(mw, _http_scope("/api/chat/stream", method="POST"))
    assert inner.called is True
    assert sent[0]["status"] == 222


def test_non_node_path_delegates_even_with_marker(tmp_path: Path) -> None:
    # Marker present (Node co-launched) but path is not Node-owned -> still delegate.
    run_dir = _write_marker(tmp_path)
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive(mw, _http_scope("/api/health"))
    assert inner.called is True
    assert sent[0]["status"] == 222


# --- proxying (front door active) ------------------------------------------


def test_proxies_node_path_with_rewrite(tmp_path: Path) -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        # Stream the body (like a real upstream) so aiter_raw() reads it — a Response
        # built with content=bytes is treated as already-read and rejects aiter_raw.
        return httpx.Response(
            200, headers={"content-type": "application/json"}, stream=_ChunkStream([b'{"ok":true}'])
        )

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    sent = _drive(mw, _http_scope("/paperclip-api/companies", query=b"limit=5"))
    # /paperclip-api -> /api rewrite, query preserved
    assert captured["url"] == "http://127.0.0.1:3100/api/companies?limit=5"
    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 200
    body = b"".join(m["body"] for m in sent if m["type"] == "http.response.body")
    assert body == b'{"ok":true}'


def test_post_body_forwarded_when_content_length_absent_from_scope(tmp_path: Path) -> None:
    # Regression: in the PyInstaller-frozen desktop runtime (and behind a body-
    # buffering Starlette BaseHTTPMiddleware) the scope the front door sees can have
    # NO Content-Length and NO Transfer-Encoding header — the body is only reachable
    # via `receive`. A WRITE method (POST) must STILL forward its body; otherwise the
    # co-launched Node rejects every write with 400 `req.body undefined` (the create-
    # company / chat outage). Gating body forwarding on the header silently dropped it.
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        return httpx.Response(201, headers={"content-type": "application/json"}, stream=_ChunkStream([b"{}"]))

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    # Headers deliberately omit content-length / transfer-encoding (the frozen scope).
    scope = _http_scope("/paperclip-api/companies", method="POST", headers=[(b"content-type", b"application/json")])
    sent = _drive(mw, scope, body=b'{"name":"acme"}')
    assert captured["body"] == b'{"name":"acme"}'
    assert sent[0]["status"] == 201


def test_post_body_survives_full_middleware_stack_without_content_length(tmp_path: Path) -> None:
    # Full-stack proof of the fix: wrap the front door in the SAME middleware order as
    # apps/api/main.py — a body-buffering Starlette ``BaseHTTPMiddleware`` access log
    # (outermost) → CORS → ``NodeFrontDoorMiddleware`` (added first ⇒ innermost). Drive
    # a POST whose scope carries NO ``content-length`` (the frozen-desktop condition the
    # live capture observed) with its body only reachable via ``receive``. The body MUST
    # still reach upstream Node — proving it survives the BaseHTTPMiddleware replay and
    # that the fix does not depend on the (frozen-stripped) length header.
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.middleware.cors import CORSMiddleware

    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        return httpx.Response(201, headers={"content-type": "application/json"}, stream=_ChunkStream([b"{}"]))

    front = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))

    async def passthrough_log(request: Any, call_next: Any) -> Any:
        # Mirrors _request_log_middleware: metadata only, never reads the body.
        return await call_next(request)

    app = CORSMiddleware(front, allow_origins=["tauri://localhost"], allow_methods=["*"], allow_headers=["*"])
    app = BaseHTTPMiddleware(app, dispatch=passthrough_log)

    scope = {
        "type": "http",
        "path": "/paperclip-api/companies",
        "method": "POST",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"origin", b"tauri://localhost")],
    }
    sent = _drive(app, scope, body=b'{"name":"acme"}')  # type: ignore[arg-type]
    assert captured["body"] == b'{"name":"acme"}'
    assert any(m["type"] == "http.response.start" and m["status"] == 201 for m in sent)


def test_get_without_body_is_not_chunked(tmp_path: Path) -> None:
    # The flip side of the fix: a genuinely bodyless read (GET, no length header) must
    # NOT be turned into a chunked upload — no body is forwarded, matching the Vite proxy.
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        captured["te"] = request.headers.get("transfer-encoding")
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=_ChunkStream([b"[]"]))

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    sent = _drive(mw, _http_scope("/paperclip-api/companies", method="GET"))
    assert captured["body"] == b""
    assert captured["te"] is None
    assert sent[0]["status"] == 200


def test_post_body_buffered_sets_content_length_never_chunked(tmp_path: Path) -> None:
    # Root fix: when NO Content-Length survives the scope (frozen desktop), the write
    # body is buffered and forwarded with an explicit Content-Length — NEVER chunked.
    # The co-launched Node reads a chunked request body as empty and 400s the write;
    # a Content-Length-framed body arrives intact. (See the real-wire test for proof
    # that MockTransport cannot reproduce chunked framing.)
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        captured["content_length"] = request.headers.get("content-length")
        captured["transfer_encoding"] = request.headers.get("transfer-encoding")
        return httpx.Response(201, headers={"content-type": "application/json"}, stream=_ChunkStream([b"{}"]))

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    scope = _http_scope("/paperclip-api/companies", method="POST", headers=[(b"content-type", b"application/json")])
    sent = _drive(mw, scope, body=b'{"name":"acme"}')
    assert captured["body"] == b'{"name":"acme"}'
    assert captured["content_length"] == str(len(b'{"name":"acme"}'))
    assert captured["transfer_encoding"] is None
    assert sent[0]["status"] == 201


def test_post_body_with_declared_length_restores_length(tmp_path: Path) -> None:
    # When a valid inbound Content-Length survives, the body is streamed (memory-
    # efficient) and that exact length is restored — still never chunked.
    body = b'{"name":"acme"}'
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = await request.aread()
        captured["content_length"] = request.headers.get("content-length")
        captured["transfer_encoding"] = request.headers.get("transfer-encoding")
        return httpx.Response(201, headers={"content-type": "application/json"}, stream=_ChunkStream([b"{}"]))

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    scope = _http_scope(
        "/paperclip-api/companies",
        method="POST",
        headers=[(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode("latin-1"))],
    )
    sent = _drive(mw, scope, body=body)
    assert captured["body"] == body
    assert captured["content_length"] == str(len(body))
    assert captured["transfer_encoding"] is None
    assert sent[0]["status"] == 201


def test_post_body_over_cap_returns_413(tmp_path: Path, monkeypatch: Any) -> None:
    # A buffered write body (no declared length) beyond the cap fails CLOSED with 413
    # instead of growing Python memory without bound — and never reaches the upstream.
    import superclaw.node_front_door as nfd

    monkeypatch.setattr(nfd, "_MAX_BUFFERED_BODY_BYTES", 8)
    called = {"upstream": False}

    async def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        called["upstream"] = True
        return httpx.Response(201)

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    scope = _http_scope("/paperclip-api/companies", method="POST", headers=[(b"content-type", b"application/json")])
    sent = _drive(mw, scope, body=b'{"name":"way-too-long-to-buffer"}')
    assert sent[0]["status"] == 413
    assert called["upstream"] is False


def test_post_body_client_disconnect_mid_buffer_is_swallowed(tmp_path: Path) -> None:
    # The buffered path (no Content-Length) reads the body eagerly, BEFORE the httpx
    # call — so a mid-upload client disconnect surfaces there, not inside client.stream.
    # It must be swallowed (logged + return), never propagate as an unhandled exception,
    # and never reach the upstream with a truncated body.
    called = {"upstream": False}

    async def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        called["upstream"] = True
        return httpx.Response(201)

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    sent: list[dict[str, Any]] = []
    pending = [
        {"type": "http.request", "body": b'{"partial":', "more_body": True},
        {"type": "http.disconnect"},
    ]

    async def receive() -> dict[str, Any]:
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = _http_scope("/paperclip-api/companies", method="POST", headers=[(b"content-type", b"application/json")])
    asyncio.run(mw(scope, receive, send))  # must NOT raise
    assert called["upstream"] is False
    assert sent == []  # nothing sent downstream, mirroring the streaming disconnect path


def test_streams_sse_chunks(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_ChunkStream([b"data: a\n\n", b"data: b\n\n"]),
        )

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    sent = _drive(mw, _http_scope("/api/chat/stream", method="POST"))
    chunks = [m["body"] for m in sent if m["type"] == "http.response.body" and m["body"]]
    assert chunks == [b"data: a\n\n", b"data: b\n\n"]


def test_fail_closed_503_when_node_unreachable(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    inner_was_called = mw.app  # type: ignore[assignment]
    sent = _drive(mw, _http_scope("/api/chat/stream", method="POST"))
    assert sent[0]["status"] == 503
    payload = json.loads(b"".join(m["body"] for m in sent if m["type"] == "http.response.body"))
    assert payload["error"] == "node_unavailable"
    assert payload["prefix"] == "/api/chat"
    assert isinstance(inner_was_called, _InnerApp) and inner_was_called.called is False


def _route_for(path: str) -> Any:
    """Resolve the REAL route (from node_routes.json) that owns ``path``."""
    matched = NodeFrontDoorMiddleware(_InnerApp(), run_dir=Path("."))._match(path)
    assert matched is not None, f"no route owns {path!r}"
    return matched[0]


def test_wedged_node_read_timeout_fails_closed_503(tmp_path: Path) -> None:
    # A WEDGED Node accepts the TCP connection (so the connect timeout never fires) but
    # never writes a response. Before the read was bounded this hung until Cloud Run's
    # 900s cap, holding a concurrency slot the whole time; enough of them took the whole
    # control plane down at near-idle CPU (2026-07-20). It must now fail closed, fast.
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("node accepted but never responded", request=request)

    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=_write_marker(tmp_path), client=_mock_client(handler))
    sent = _drive(mw, _http_scope("/api/chat/sessions"))
    assert sent[0]["status"] == 503
    payload = json.loads(b"".join(m["body"] for m in sent if m["type"] == "http.response.body"))
    assert payload["error"] == "node_unavailable"
    # Never silently falls through to the legacy Python engine.
    assert inner.called is False


def test_is_sse_request_matches_only_the_declared_endpoint() -> None:
    sse_route = _route_for("/api/chat/stream")
    assert _is_sse_request(sse_route, "POST", "/api/chat/stream") is True
    # Same path, wrong method -> ordinary request (bounded read).
    assert _is_sse_request(sse_route, "GET", "/api/chat/stream") is False
    # Same prefix, different path -> ordinary request.
    assert _is_sse_request(sse_route, "POST", "/api/chat/sessions") is False


def test_sse_keeps_unbounded_read_while_ordinary_requests_are_bounded(tmp_path: Path) -> None:
    # The timeout is chosen PER REQUEST: only the declared text/event-stream endpoint may
    # read without a deadline. Everything else -- including other paths under the very same
    # prefix -- must carry the bounded read, otherwise the wedge fix is a no-op.
    def timeout_for(path: str, method: str) -> dict[str, Any]:
        # A fresh client per request: each _drive spins its own event loop, so one
        # AsyncClient cannot be shared across both.
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(request.extensions.get("timeout") or {})
            return httpx.Response(200, stream=_ChunkStream([b"ok"]))

        mw = NodeFrontDoorMiddleware(
            _InnerApp(), run_dir=_write_marker(tmp_path), client=_mock_client(handler)
        )
        _drive(mw, _http_scope(path, method=method))
        return seen

    sse = timeout_for("/api/chat/stream", "POST")
    ordinary = timeout_for("/api/chat/sessions", "GET")

    assert sse["read"] is None
    assert ordinary["read"] == _PROXY_READ_TIMEOUT_SECONDS
    # A dead (not merely wedged) Node must still fail fast on both.
    assert sse["connect"] == 2.0
    assert ordinary["connect"] == 2.0


def test_marker_present_but_corrupt_fails_closed(tmp_path: Path) -> None:
    # Marker exists (Node is meant to be up) but carries no base_url -> fail CLOSED
    # with 503, never a silent fallthrough to Python's legacy engine.
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    (run_dir / NODE_MARKER_NAME).write_text("{}", encoding="utf-8")
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive(mw, _http_scope("/api/chat/stream", method="POST"))
    assert sent[0]["status"] == 503
    assert inner.called is False


# --- WebSocket bridge ------------------------------------------------------


class _FakeNodeWS:
    """Stand-in for the upstream Node websocket connection injected via ws_connect."""

    def __init__(
        self,
        incoming: list | None = None,
        subprotocol: str | None = None,
        block_after: bool = False,
        close_code: int | None = 1000,
        raise_on_send: bool = False,
    ) -> None:
        self._incoming = list(incoming or [])
        self.subprotocol = subprotocol
        self._block_after = block_after
        self.close_code = close_code
        self._raise_on_send = raise_on_send
        self.sent: list[Any] = []
        self.closed = False

    async def send(self, data: Any) -> None:
        if self._raise_on_send:
            raise ConnectionClosed(None, None)
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True

    def __aiter__(self) -> Any:
        return self._iterate()

    async def _iterate(self) -> Any:
        for message in self._incoming:
            yield message
        if self._block_after:
            await asyncio.Event().wait()  # stay open until the bridge cancels us


def _ws_scope(path: str, *, query: bytes = b"", subprotocols: list | None = None, headers: list | None = None) -> dict:
    return {
        "type": "websocket",
        "path": path,
        "query_string": query,
        "subprotocols": subprotocols or [],
        "headers": headers or [],
    }


def _fake_connect(node_ws: _FakeNodeWS, captured: dict | None = None) -> Any:
    async def connect(url: str, subprotocols: list, headers: list) -> _FakeNodeWS:
        if captured is not None:
            captured.update(url=url, subprotocols=subprotocols, headers=headers)
        return node_ws

    return connect


def _drive_ws(mw: NodeFrontDoorMiddleware, scope: dict, after_connect: list, block_client: bool = False) -> list:
    pending = [{"type": "websocket.connect"}, *after_connect]
    sent: list[dict] = []

    async def receive() -> dict:
        if pending:
            return pending.pop(0)
        if block_client:
            await asyncio.Event().wait()
        return {"type": "websocket.disconnect", "code": 1000}

    async def send(message: dict) -> None:
        sent.append(message)

    asyncio.run(mw(scope, receive, send))
    return sent


async def _noop_receive() -> dict:
    return {"type": "websocket.connect"}


async def _noop_send(message: dict) -> None:
    return None


def test_http_to_ws_scheme() -> None:
    assert _http_to_ws("http://127.0.0.1:3100") == "ws://127.0.0.1:3100"
    assert _http_to_ws("https://x:1") == "wss://x:1"


def test_ws_forward_headers_only_cookie_auth() -> None:
    raw = [(b"cookie", b"a=1"), (b"authorization", b"Bearer t"), (b"sec-websocket-key", b"k"), (b"x", b"y")]
    assert dict(_ws_forward_headers(raw)) == {"cookie": "a=1", "authorization": "Bearer t"}


def test_ws_no_marker_delegates(tmp_path: Path) -> None:
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=tmp_path)  # no marker
    asyncio.run(mw(_ws_scope("/paperclip-api/companies/c1/events/ws"), _noop_receive, _noop_send))
    assert inner.called is True


def test_ws_non_ws_route_delegates(tmp_path: Path) -> None:
    # /api/chat is a Node route but ws=False -> a websocket on it is delegated.
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=_write_marker(tmp_path))
    asyncio.run(mw(_ws_scope("/api/chat"), _noop_receive, _noop_send))
    assert inner.called is True


def test_ws_marker_corrupt_rejects(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    (run_dir / NODE_MARKER_NAME).write_text("{}", encoding="utf-8")
    inner = _InnerApp()
    mw = NodeFrontDoorMiddleware(inner, run_dir=run_dir)
    sent = _drive_ws(mw, _ws_scope("/paperclip-api/companies/c1/events/ws"), [])
    assert sent == [{"type": "websocket.close", "code": 1011}]
    assert inner.called is False


def test_ws_connect_failure_rejects(tmp_path: Path) -> None:
    async def failing_connect(url: str, subprotocols: list, headers: list) -> Any:
        raise OSError("connection refused")

    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), ws_connect=failing_connect)
    sent = _drive_ws(mw, _ws_scope("/paperclip-api/companies/c1/events/ws"), [])
    assert sent == [{"type": "websocket.close", "code": 1011}]


def test_ws_bridges_node_to_client_and_rewrites_url(tmp_path: Path) -> None:
    node_ws = _FakeNodeWS(incoming=["hello", b"\x00bin"], subprotocol="json")
    captured: dict = {}
    mw = NodeFrontDoorMiddleware(
        _InnerApp(), run_dir=_write_marker(tmp_path), ws_connect=_fake_connect(node_ws, captured)
    )
    # client never sends -> node delivers its messages then closes, tearing the bridge down.
    sent = _drive_ws(
        mw, _ws_scope("/paperclip-api/companies/c1/events/ws", query=b"since=5"), [], block_client=True
    )
    # /paperclip-api -> /api rewrite, ws scheme, query preserved
    assert captured["url"] == "ws://127.0.0.1:3100/api/companies/c1/events/ws?since=5"
    assert sent[0] == {"type": "websocket.accept", "subprotocol": "json"}
    assert {"type": "websocket.send", "text": "hello"} in sent
    assert {"type": "websocket.send", "bytes": b"\x00bin"} in sent
    assert sent[-1] == {"type": "websocket.close", "code": 1000}
    assert node_ws.closed is True


def test_ws_bridges_client_to_node_then_kills_on_disconnect(tmp_path: Path) -> None:
    node_ws = _FakeNodeWS(incoming=[], block_after=True)  # stays open
    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), ws_connect=_fake_connect(node_ws))
    sent = _drive_ws(
        mw,
        _ws_scope("/paperclip-api/companies/c1/events/ws"),
        [{"type": "websocket.receive", "text": "ping"}, {"type": "websocket.disconnect", "code": 1000}],
    )
    assert sent[0] == {"type": "websocket.accept"}
    assert node_ws.sent == ["ping"]
    # client disconnected -> the still-open node side was torn down (no zombie).
    assert node_ws.closed is True


def test_ws_forwards_abnormal_close_code(tmp_path: Path) -> None:
    # Node closes abnormally (1011) -> the client must see 1011, not a faked 1000.
    node_ws = _FakeNodeWS(incoming=["x"], close_code=1011)
    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), ws_connect=_fake_connect(node_ws))
    sent = _drive_ws(mw, _ws_scope("/paperclip-api/companies/c1/events/ws"), [], block_client=True)
    assert sent[-1] == {"type": "websocket.close", "code": 1011}


def test_ws_client_send_on_closed_upstream_tears_down(tmp_path: Path) -> None:
    # node_ws.send() raising ConnectionClosed (upstream already gone, abnormally with
    # 1011) must not crash, and the client's close must carry the REAL upstream code
    # (1011) — not the default 1000 — even though the node->client task gets cancelled.
    node_ws = _FakeNodeWS(incoming=[], block_after=True, raise_on_send=True, close_code=1011)
    mw = NodeFrontDoorMiddleware(_InnerApp(), run_dir=_write_marker(tmp_path), ws_connect=_fake_connect(node_ws))
    sent = _drive_ws(
        mw, _ws_scope("/paperclip-api/companies/c1/events/ws"), [{"type": "websocket.receive", "text": "ping"}]
    )
    assert sent[0] == {"type": "websocket.accept"}
    assert sent[-1] == {"type": "websocket.close", "code": 1011}
    assert node_ws.closed is True
