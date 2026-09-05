"""Node front door — the production/desktop equivalent of apps/web's Vite dev
proxy. A pure-ASGI reverse proxy that forwards Node-owned route prefixes (from the
shared ``node_routes.json`` manifest) to the co-launched vendored Node control
plane (server/server), so the SAME routing that Vite fakes in dev also happens when
the Python service hosts apps/web's static bundle (browser-on-Python, desktop).

Design (locked with Codex GPT-5.5 + AgY Gemini 3.1 Pro):

* **Pure ASGI**, not Starlette ``BaseHTTPMiddleware`` — it streams the RESPONSE at
  the (scope, receive, send) level, so Server-Sent Events (``/api/chat/stream``) flow
  chunk-by-chunk with no buffering. A forwarded request body is always sent
  Content-Length framed, NEVER chunked (the co-launched Node reads a chunked request
  body as empty and 400s the write): when a valid inbound ``Content-Length`` survives
  the scope the body is streamed and that length restored; when it does not (the
  PyInstaller-frozen desktop / a body-replaying outer middleware drops it) the body is
  buffered once — bounded by ``_MAX_BUFFERED_BODY_BYTES`` (413 beyond it) — so an
  accurate length can be set. See ``_prepare_forward_body``.
* **Marker-gated, three states.** It activates only when *this* process co-launched
  Node (the ``node-service.json`` marker exists). With NO marker — plain-Python
  deployments and the whole test suite — it delegates to the wrapped app, so Python's
  own routes serve unchanged (zero regression). With a marker present but the Node
  base URL missing/corrupt, OR present-and-Node-unreachable, Node-owned prefixes
  fail **closed** with ``503`` — they are NEVER allowed to fall through to Python's
  legacy implementation of the same path (which would be a silent wrong-engine).

The middleware is installed INNERMOST (added before CORS/request-log) so proxied
requests still pass through CORS and the access-log/X-Request-Id middleware.
WebSocket scope is passed through here; the dedicated WS bridge lands in a later PR.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
from websockets.exceptions import ConnectionClosed

from superclaw.logging_config import get_logger
from superclaw.node_routes import NodeRoute, load_node_routes
from superclaw.node_runtime import node_marker_exists, read_node_base_url

logger = get_logger("api.node_front_door")

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
RawHeaders = list[tuple[bytes, bytes]]

# Static hop-by-hop headers (RFC 7230 §6.1) a proxy must not forward. ``host`` and
# ``content-length`` are dropped from the forwarded REQUEST too: httpx sets ``host``
# from the target URL and frames the streamed body itself. Headers named in a
# ``Connection`` header are ALSO hop-by-hop and stripped dynamically (see below).
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)
_DROP_REQUEST_HEADERS = _HOP_BY_HOP | {"host", "content-length"}

# HTTP methods that semantically carry a request body. Their body is forwarded
# UNCONDITIONALLY (streamed from ``receive``), never gated on the inbound
# ``Content-Length`` header — which an outer body-buffering middleware or the
# frozen desktop runtime may have dropped from the scope (see ``_proxy``).
_ALWAYS_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})

# Upper bound for buffering a write body when NO usable inbound ``Content-Length``
# survives the scope (the frozen-desktop / body-replaying-middleware case). We must
# read the body whole to forward it with an explicit length, so bound it to avoid
# unbounded Python memory. Mirrors the co-launched Node's own max request size; a
# larger write fails closed with 413 rather than OOMing the proxy.
_MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024

# No read timeout (SSE/long downloads must never be cut); a short connect timeout so
# an unreachable Node fails closed fast instead of hanging the request.
_PROXY_TIMEOUT = httpx.Timeout(None, connect=2.0)

# Read timeout for ORDINARY (non-SSE) proxied requests. A *wedged* Node — one whose TCP
# listener still accepts, so ``connect`` succeeds, but which never writes a response — is
# not covered by the connect timeout. With an unbounded read every such request hung until
# Cloud Run's 900s request cap, and each one held a concurrency slot for those 15 minutes;
# once the slots were gone the whole control plane was unreachable even though CPU sat near
# idle (2026-07-20 outage). Bounding the read turns that into a fast 504 per request, so a
# wedge degrades one call instead of the service. WebSocket upgrades never reach this path
# (they are served by ``_handle_websocket`` off the ASGI "websocket" scope), so the only
# HTTP stream that legitimately needs the unbounded read is the route's declared SSE
# endpoint — see ``_is_sse_request``.
_PROXY_READ_TIMEOUT_SECONDS = 30.0
_PROXY_TIMEOUT_BOUNDED = httpx.Timeout(None, connect=2.0, read=_PROXY_READ_TIMEOUT_SECONDS)


def _is_sse_request(route: NodeRoute, method: str, path: str) -> bool:
    """True when this request is the route's declared ``text/event-stream`` endpoint.

    ``path`` must be the UPSTREAM (post-rewrite) path, which is what ``sse.path`` records.
    """
    sse = route.sse
    return sse is not None and method == sse.method and path == sse.path


class _ClientDisconnected(Exception):
    """Raised from the request-body pump when the downstream client disconnects mid
    upload, so httpx aborts the upstream request instead of forwarding a body that
    looks complete but was truncated."""


class _RequestBodyTooLarge(Exception):
    """A write body had no usable inbound ``Content-Length`` and, when buffered so the
    proxy could forward it with an explicit length, exceeded
    ``_MAX_BUFFERED_BODY_BYTES``. Surfaced to the client as 413."""


class NodeFrontDoorMiddleware:
    """ASGI middleware reverse-proxying Node-owned prefixes to the co-launched Node."""

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        run_dir: Path | str,
        routes: tuple[NodeRoute, ...] | None = None,
        client: httpx.AsyncClient | None = None,
        ws_connect: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        self.app = app
        self.run_dir = Path(run_dir)
        self.routes = routes if routes is not None else load_node_routes()
        self._client = client
        self._ws_connect = ws_connect
        self._compiled: list[tuple[NodeRoute, re.Pattern[str] | None]] = [
            (route, re.compile(route.rewrite.from_) if route.rewrite else None) for route in self.routes
        ]

    def _client_or_default(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT, follow_redirects=False)
        return self._client

    def _match(self, path: str) -> tuple[NodeRoute, re.Pattern[str] | None] | None:
        """First manifest route that matches: an ``exact`` route matches only its
        exact path; a ``prefix`` route matches the whole subtree (mirroring Vite's
        context matching). Order is significant, declared in node_routes.json."""
        for route, pattern in self._compiled:
            if route.match == "exact":
                if path == route.prefix:
                    return route, pattern
            elif path.startswith(route.prefix):
                return route, pattern
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await self._handle_websocket(scope, receive, send)
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        matched = self._match(scope["path"])
        if matched is None:
            await self.app(scope, receive, send)
            return
        route = matched[0]
        if not node_marker_exists(self.run_dir):
            # No marker -> Node was not co-launched here (plain Python / tests). The
            # front door is inactive; the wrapped app serves its own routes.
            await self.app(scope, receive, send)
            return
        base_url = read_node_base_url(self.run_dir)
        if not base_url:
            # Marker present but unreadable / missing base_url: Node is meant to be up
            # but its address is unknown. Fail CLOSED — never leak to Python's engine.
            logger.warning("node_front_door.marker_unreadable prefix=%s -> 503", route.prefix)
            await _send_unavailable(send, route.prefix)
            return
        await self._proxy(scope, receive, send, route, matched[1], base_url)

    async def _proxy(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        route: NodeRoute,
        pattern: re.Pattern[str] | None,
        base_url: str,
    ) -> None:
        path = scope["path"]
        if pattern is not None and route.rewrite is not None:
            path = pattern.sub(route.rewrite.to, path)
        query: bytes = scope.get("query_string", b"")
        url = base_url.rstrip("/") + path
        if query:
            url = f"{url}?{query.decode('latin-1')}"
        method: str = scope["method"]
        raw_headers: RawHeaders = scope.get("headers", [])
        dynamic_hop = _connection_hop_headers(raw_headers)
        headers = _request_headers(raw_headers, dynamic_hop)
        # Forward the request body with an EXPLICIT Content-Length so httpx never
        # falls back to chunked transfer-encoding — the co-launched Node reads a
        # chunked request body as empty and 400s EVERY write (create company, chat,
        # hire …) while reads (no body) proxy fine. The trap: an outer body-replaying
        # middleware (Starlette ``BaseHTTPMiddleware``) and the PyInstaller-frozen
        # desktop runtime drop the inbound ``Content-Length`` from the scope (the body
        # is replayed via ``receive``); a streamed body with no length then goes out
        # chunked. ``_prepare_forward_body`` restores a length in every case (stream +
        # restore when one survives, else buffer once + compute), shared with the
        # gateway front door. See tests/test_front_door_body_wire.py for the real-wire
        # regression (MockTransport cannot reproduce chunked framing).
        try:
            content = await _prepare_forward_body(receive, raw_headers, headers, method)
        except _RequestBodyTooLarge:
            logger.warning("node_front_door.body_too_large prefix=%s -> 413", route.prefix)
            await _send_payload_too_large(send, route.prefix)
            return
        except _ClientDisconnected:
            # Client vanished mid-upload while we buffered the body (the buffered path
            # reads eagerly, before the httpx call, so its disconnect surfaces HERE —
            # the streaming path's disconnect is caught around client.stream below).
            logger.info("node_front_door.client_disconnect prefix=%s", route.prefix)
            return
        client = self._client_or_default()
        started = False
        try:
            timeout = _PROXY_TIMEOUT if _is_sse_request(route, method, path) else _PROXY_TIMEOUT_BOUNDED
            async with client.stream(
                method, url, headers=headers, content=content, timeout=timeout
            ) as upstream:
                resp_hop = _connection_hop_headers(upstream.headers.raw)
                await send(
                    {
                        "type": "http.response.start",
                        "status": upstream.status_code,
                        "headers": _response_headers(upstream.headers.raw, resp_hop),
                    }
                )
                started = True
                async for chunk in upstream.aiter_raw():
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
                await send({"type": "http.response.body", "body": b"", "more_body": False})
            logger.info("node_front_door.proxy method=%s prefix=%s status=%s", method, route.prefix, upstream.status_code)
        except _ClientDisconnected:
            # The downstream client vanished mid upload; httpx has aborted the upstream
            # request. Nothing to send back.
            logger.info("node_front_door.client_disconnect prefix=%s", route.prefix)
        except httpx.HTTPError as exc:
            if started:
                # Headers already flushed — cannot change status. End the (truncated)
                # body; the client sees a closed stream. Logged for diagnosis.
                logger.warning("node_front_door.mid_stream_error prefix=%s err=%r", route.prefix, exc)
                await send({"type": "http.response.body", "body": b"", "more_body": False})
                return
            logger.warning("node_front_door.unreachable prefix=%s err=%r -> 503", route.prefix, exc)
            await _send_unavailable(send, route.prefix)

    # --- WebSocket bridge ----------------------------------------------------

    async def _handle_websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        matched = self._match(scope["path"])
        if matched is None or not matched[0].ws:
            # Not a Node-owned WebSocket route -> let the wrapped app handle/reject it.
            await self.app(scope, receive, send)
            return
        route, pattern = matched
        if not node_marker_exists(self.run_dir):
            await self.app(scope, receive, send)
            return
        base_url = read_node_base_url(self.run_dir)
        if not base_url:
            # Marker present but Node address unknown -> fail closed: reject the
            # handshake rather than leak to a Python app that does not own this WS.
            await _reject_ws(receive, send)
            return
        await self._bridge_websocket(scope, receive, send, route, pattern, base_url)

    async def _bridge_websocket(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        route: NodeRoute,
        pattern: re.Pattern[str] | None,
        base_url: str,
    ) -> None:
        connect_msg = await receive()
        if connect_msg.get("type") != "websocket.connect":
            return
        path = scope["path"]
        if pattern is not None and route.rewrite is not None:
            path = pattern.sub(route.rewrite.to, path)
        query: bytes = scope.get("query_string", b"")
        url = _http_to_ws(base_url.rstrip("/")) + path
        if query:
            url = f"{url}?{query.decode('latin-1')}"
        subprotocols = list(scope.get("subprotocols", []))
        headers = _ws_forward_headers(scope.get("headers", []))
        connect = self._ws_connect or _default_ws_connect
        try:
            node_ws = await connect(url, subprotocols, headers)
        except Exception as exc:  # noqa: BLE001 — any connect failure fails closed
            logger.warning("node_front_door.ws_connect_failed prefix=%s err=%r", route.prefix, exc)
            await _reject_ws(receive, send, already_connected=True)
            return
        try:
            accept: dict[str, Any] = {"type": "websocket.accept"}
            negotiated = getattr(node_ws, "subprotocol", None)
            if negotiated:
                accept["subprotocol"] = negotiated
            await send(accept)
            await _pump_websocket(receive, send, node_ws)
        finally:
            await _safe_ws_close(node_ws)

    # --- end WebSocket bridge ------------------------------------------------


def _connection_hop_headers(raw: RawHeaders) -> frozenset[str]:
    """Header names listed in a ``Connection`` header are connection-specific
    (hop-by-hop, RFC 7230 §6.1) and must not be forwarded."""
    names: set[str] = set()
    for name, value in raw:
        if name.decode("latin-1").lower() == "connection":
            for token in value.decode("latin-1").split(","):
                token = token.strip().lower()
                if token:
                    names.add(token)
    return frozenset(names)


def _request_headers(raw: RawHeaders, dynamic_hop: frozenset[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for name, value in raw:
        lower = name.decode("latin-1").lower()
        if lower in _DROP_REQUEST_HEADERS or lower in dynamic_hop:
            continue
        out.append((name.decode("latin-1"), value.decode("latin-1")))
    return out


def _response_headers(raw: RawHeaders, dynamic_hop: frozenset[str]) -> RawHeaders:
    return [
        (name, value)
        for name, value in raw
        if (lower := name.decode("latin-1").lower()) not in _HOP_BY_HOP and lower not in dynamic_hop
    ]


def _request_has_body(raw: RawHeaders) -> bool:
    """True when the request declares a body (a Content-Length > 0 or any
    Transfer-Encoding). A bodyless GET/HEAD must not be turned into a chunked
    request — that would diverge from the Vite proxy and surprise read-only Node
    endpoints."""
    for name, value in raw:
        lower = name.decode("latin-1").lower()
        if lower == "transfer-encoding":
            return True
        if lower == "content-length":
            try:
                if int(value.decode("latin-1").strip()) > 0:
                    return True
            except ValueError:
                return True  # malformed length -> assume a body, be safe
    return False


async def _stream_request_body(receive: Receive) -> AsyncIterator[bytes]:
    """Yield the request body chunk-by-chunk from the ASGI receive channel, so a
    large upload is streamed to Node rather than buffered whole in Python memory. A
    mid-upload client disconnect raises :class:`_ClientDisconnected` so the upstream
    request is aborted instead of completed with a truncated body."""
    while True:
        message = await receive()
        if message["type"] == "http.request":
            body = message.get("body", b"")
            if body:
                yield body
            if not message.get("more_body", False):
                return
        elif message["type"] == "http.disconnect":
            raise _ClientDisconnected


def _declared_content_length(raw: RawHeaders) -> int | None:
    """A single, unambiguous, non-negative inbound ``Content-Length`` usable to stream
    the body upstream while preserving its exact framing. Returns ``None`` — meaning
    "buffer the body and compute a fresh length" — when the length is absent,
    malformed, negative, contradicted by a duplicate ``Content-Length``, or accompanied
    by ``Transfer-Encoding`` (RFC 7230 §3.3.3: Transfer-Encoding wins and any
    Content-Length must be ignored). An ambiguous length must never frame an upstream
    request, or the body would be truncated or the connection would hang."""
    lengths: list[int] = []
    for name, value in raw:
        lower = name.decode("latin-1").lower()
        if lower == "transfer-encoding":
            return None
        if lower == "content-length":
            try:
                lengths.append(int(value.decode("latin-1").strip()))
            except ValueError:
                return None
    if not lengths:
        return None
    first = lengths[0]
    if first < 0 or any(other != first for other in lengths[1:]):
        return None
    return first


async def _read_request_body(receive: Receive, *, max_bytes: int) -> bytes:
    """Buffer the whole request body from the ASGI receive channel so the proxy can
    forward it with an explicit ``Content-Length``. Bounded at ``max_bytes`` — a larger
    body raises :class:`_RequestBodyTooLarge` (surfaced as 413) instead of growing
    Python memory without limit. A mid-upload disconnect still raises
    :class:`_ClientDisconnected` (propagated from :func:`_stream_request_body`)."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in _stream_request_body(receive):
        total += len(chunk)
        if total > max_bytes:
            raise _RequestBodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


async def _prepare_forward_body(
    receive: Receive,
    raw_headers: RawHeaders,
    headers: list[tuple[str, str]],
    method: str,
    *,
    max_buffer_bytes: int | None = None,
) -> Any:
    """Decide how to forward the request body upstream, GUARANTEEING a forwarded write
    body is always ``Content-Length`` framed and never chunked. Shared by both front
    doors (Node + gateway). Returns the ``content`` to hand ``httpx``:

    * bodyless method with no declared body -> ``None`` (no Content-Length added).
    * a single valid inbound ``Content-Length`` survives -> stream and restore that
      exact length; httpx honours the explicit length and does NOT chunk (verified
      against httpx 0.28.1), keeping large uploads memory-efficient.
    * no usable length (frozen desktop / body-replaying middleware dropped it) ->
      buffer the body once (bounded) and hand ``httpx`` the bytes, which sets an
      accurate Content-Length itself.

    Raises :class:`_RequestBodyTooLarge` when the buffered path exceeds the cap.
    """
    has_body = method.upper() in _ALWAYS_BODY_METHODS or _request_has_body(raw_headers)
    if not has_body:
        return None
    declared = _declared_content_length(raw_headers)
    if declared is not None:
        headers.append(("content-length", str(declared)))
        return _stream_request_body(receive)
    cap = _MAX_BUFFERED_BODY_BYTES if max_buffer_bytes is None else max_buffer_bytes
    return await _read_request_body(receive, max_bytes=cap)


async def _send_payload_too_large(send: Send, prefix: str) -> None:
    body = json.dumps(
        {"detail": "Request body too large", "error": "payload_too_large", "prefix": prefix}
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("latin-1")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


async def _send_unavailable(send: Send, prefix: str) -> None:
    body = json.dumps(
        {"detail": "Node control plane unavailable", "error": "node_unavailable", "prefix": prefix}
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 503,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("latin-1")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


def _http_to_ws(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    return url


def _ws_forward_headers(raw: RawHeaders) -> list[tuple[str, str]]:
    """Only safe handshake headers (cookie/authorization) are forwarded to Node; the
    WebSocket handshake's own ``Upgrade``/``Connection``/``Sec-WebSocket-*`` headers
    are produced by the client library, not relayed verbatim."""
    forward = {"cookie", "authorization"}
    return [
        (name.decode("latin-1"), value.decode("latin-1"))
        for name, value in raw
        if name.decode("latin-1").lower() in forward
    ]


async def _default_ws_connect(url: str, subprotocols: list[str], headers: list[tuple[str, str]]) -> Any:
    # The new asyncio client (websockets >= 13) — its ClientConnection exposes
    # send()/async-iteration/close()/subprotocol, exactly what the bridge uses.
    from websockets.asyncio.client import connect

    return await connect(
        url,
        subprotocols=subprotocols or None,
        additional_headers=headers or None,
    )


async def _reject_ws(receive: Receive, send: Send, already_connected: bool = False) -> None:
    """Fail-closed for a WebSocket: close the handshake (1011) instead of bridging."""
    if not already_connected:
        await receive()  # consume websocket.connect
    await send({"type": "websocket.close", "code": 1011})


async def _safe_ws_close(node_ws: Any) -> None:
    try:
        await node_ws.close()
    except (ConnectionClosed, OSError):
        pass


def _ws_close_code(node_ws: Any) -> int:
    """Node's real close code, mapping abnormal / no-close-frame (None/1005/1006) to
    1011 so an upstream crash is never reported downstream as a normal 1000."""
    code = getattr(node_ws, "close_code", None)
    return code if code not in (None, 1005, 1006) else 1011


async def _pump_websocket(receive: Receive, send: Send, node_ws: Any) -> None:
    """Bidirectionally relay frames between the downstream client and the upstream
    Node socket. When EITHER side ends, the other is torn down (no zombie half-open
    bridge) and the client gets exactly ONE controlled close carrying Node's real
    close code — an upstream abnormal close is never masked as a normal 1000."""
    closing = {"code": 1000}

    async def client_to_node() -> None:
        while True:
            message = await receive()
            mtype = message.get("type")
            if mtype == "websocket.receive":
                data = message.get("text")
                if data is None:
                    data = message.get("bytes")
                if data is not None:
                    try:
                        await node_ws.send(data)
                    except ConnectionClosed:
                        # Upstream gone — capture its real close code HERE too, before
                        # the other task is cancelled and loses the chance to read it.
                        closing["code"] = _ws_close_code(node_ws)
                        return
            elif mtype == "websocket.disconnect":
                return

    async def node_to_client() -> None:
        try:
            async for message in node_ws:
                if isinstance(message, str):
                    await send({"type": "websocket.send", "text": message})
                else:
                    await send({"type": "websocket.send", "bytes": message})
        except ConnectionClosed:
            pass
        closing["code"] = _ws_close_code(node_ws)

    tasks = [asyncio.ensure_future(client_to_node()), asyncio.ensure_future(node_to_client())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, ConnectionClosed, OSError, RuntimeError):
                pass
        # Exactly one controlled close to the downstream client (no-op if it already
        # disconnected). Centralised here so neither direction races to close it.
        try:
            await send({"type": "websocket.close", "code": closing["code"]})
        except (RuntimeError, OSError, ConnectionClosed):
            pass
