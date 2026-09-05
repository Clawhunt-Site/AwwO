"""Real-wire regression for request-body framing through BOTH front doors.

The unit tests in test_node_front_door.py / test_gateway_front_door.py use httpx
``MockTransport`` — it hands the request OBJECT to a handler and therefore CANNOT
reproduce chunked wire framing. That blind spot is exactly why the desktop 400
outage shipped "green": a streamed body with no ``Content-Length`` goes out on the
wire as ``Transfer-Encoding: chunked``, and the co-launched Node reads a chunked
request body as EMPTY -> 400 on every write.

These tests drive the ACTUAL middleware with a REAL ``httpx.AsyncClient`` over a REAL
loopback TCP socket and inspect the raw bytes the upstream receives, asserting the
invariant the fix guarantees: a forwarded write body is ALWAYS ``Content-Length``
framed, never chunked. A final contrast test pins the httpx behaviour the fix guards
against (stream + no length -> chunked), so a dependency change can't silently
reintroduce the bug.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

import httpx

from superclaw.gateway_front_door import GatewayFrontDoorMiddleware
from superclaw.node_front_door import (
    _PROXY_TIMEOUT,
    NodeFrontDoorMiddleware,
    _stream_request_body,
)
from superclaw.node_runtime import NODE_MARKER_NAME


class _RawUpstream:
    """A minimal REAL TCP server that records the raw HTTP request bytes of one
    connection and replies with a fixed, Content-Length-framed 201 so httpx completes
    cleanly. Reads the full request honouring either Content-Length or chunked framing
    so the capture is reliable regardless of how the body was sent."""

    def __init__(self) -> None:
        self.raw = b""
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        return int(self._server.sockets[0].getsockname()[1])

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        data = b""
        try:
            while b"\r\n\r\n" not in data:
                chunk = await asyncio.wait_for(reader.read(4096), timeout=1.0)
                if not chunk:
                    break
                data += chunk
            head, _, rest = data.partition(b"\r\n\r\n")
            headers = head.lower()
            if b"transfer-encoding: chunked" in headers:
                while b"0\r\n\r\n" not in rest:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=1.0)
                    if not chunk:
                        break
                    rest += chunk
            elif (m := re.search(rb"content-length:\s*(\d+)", headers)) is not None:
                clen = int(m.group(1))
                while len(rest) < clen:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=1.0)
                    if not chunk:
                        break
                    rest += chunk
            self.raw = head + b"\r\n\r\n" + rest
        except (TimeoutError, asyncio.TimeoutError):
            self.raw = data
        body = b'{"ok":true}'
        writer.write(
            b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: %d\r\n\r\n%s"
            % (len(body), body)
        )
        try:
            await writer.drain()
        except OSError:
            pass
        writer.close()

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()

    # --- assertions over the captured raw request ---
    def head(self) -> bytes:
        return self.raw.split(b"\r\n\r\n", 1)[0].lower()

    def is_chunked(self) -> bool:
        return b"transfer-encoding: chunked" in self.head()

    def content_length(self) -> int | None:
        m = re.search(rb"content-length:\s*(\d+)", self.head())
        return int(m.group(1)) if m else None

    def body(self) -> bytes:
        return self.raw.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in self.raw else b""


def _http_scope(path: str, *, method: str, headers: list[tuple[bytes, bytes]]) -> dict[str, Any]:
    return {"type": "http", "path": path, "method": method, "query_string": b"", "headers": headers}


async def _drive_async(middleware: Any, scope: dict[str, Any], body: bytes) -> list[dict[str, Any]]:
    """Drive the middleware in the CURRENT event loop (so the real upstream server is
    reachable), unlike the asyncio.run-based _drive helpers in the unit test files."""
    sent: list[dict[str, Any]] = []
    pending = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive() -> dict[str, Any]:
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await middleware(scope, receive, send)
    return sent


def _node_marker(tmp_path: Path, port: int) -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / NODE_MARKER_NAME).write_text(
        json.dumps({"base_url": f"http://127.0.0.1:{port}", "port": port}), encoding="utf-8"
    )
    return run_dir


def _gateway_marker(tmp_path: Path, port: int, token: str = "real-token") -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "gateway-marker.json").write_text(json.dumps({"port": port, "pid": 1}), encoding="utf-8")
    (tmp_path / "gateway-control-token").write_text(token, encoding="utf-8")
    return run_dir


def test_node_post_without_content_length_forwarded_content_length_framed(tmp_path: Path) -> None:
    async def scenario() -> None:
        up = _RawUpstream()
        port = await up.start()
        client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
        try:
            mw = NodeFrontDoorMiddleware(_inner(), run_dir=_node_marker(tmp_path, port), client=client)
            # Frozen-desktop condition: scope carries NO content-length; body via receive.
            scope = _http_scope("/paperclip-api/companies", method="POST", headers=[(b"content-type", b"application/json")])
            sent = await _drive_async(mw, scope, body=b'{"name":"acme"}')
        finally:
            await client.aclose()
            await up.stop()
        assert not up.is_chunked(), up.head()
        assert up.content_length() == len(b'{"name":"acme"}')
        assert b'{"name":"acme"}' in up.body()
        assert sent[0]["status"] == 201

    asyncio.run(scenario())


def test_node_post_with_declared_length_forwarded_content_length_framed(tmp_path: Path) -> None:
    body = b'{"name":"acme"}'

    async def scenario() -> None:
        up = _RawUpstream()
        port = await up.start()
        client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
        try:
            mw = NodeFrontDoorMiddleware(_inner(), run_dir=_node_marker(tmp_path, port), client=client)
            scope = _http_scope(
                "/paperclip-api/companies",
                method="POST",
                headers=[(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode("latin-1"))],
            )
            sent = await _drive_async(mw, scope, body=body)
        finally:
            await client.aclose()
            await up.stop()
        assert not up.is_chunked(), up.head()
        assert up.content_length() == len(body)
        assert body in up.body()
        assert sent[0]["status"] == 201

    asyncio.run(scenario())


def test_gateway_post_without_content_length_forwarded_content_length_framed(tmp_path: Path) -> None:
    async def scenario() -> None:
        up = _RawUpstream()
        port = await up.start()
        client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
        try:
            mw = GatewayFrontDoorMiddleware(_inner(), run_dir=_gateway_marker(tmp_path, port), client=client)
            scope = _http_scope("/gateway-api/automations", method="POST", headers=[(b"content-type", b"application/json")])
            sent = await _drive_async(mw, scope, body=b'{"name":"acme"}')
        finally:
            await client.aclose()
            await up.stop()
        assert not up.is_chunked(), up.head()
        assert up.content_length() == len(b'{"name":"acme"}')
        assert b'{"name":"acme"}' in up.body()
        assert sent[0]["status"] == 201

    asyncio.run(scenario())


def test_httpx_streams_chunked_without_content_length_is_the_trap(tmp_path: Path) -> None:
    # Pins the exact httpx behaviour the fix guards against: a streamed body with NO
    # Content-Length header goes out as Transfer-Encoding: chunked on the real wire.
    # This is what the front doors used to do and what the co-launched Node reads as an
    # empty body. If a future httpx changes this, this test flags it.
    async def scenario() -> None:
        up = _RawUpstream()
        port = await up.start()
        client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
        try:
            # Drive the shared streaming primitive directly, with no content-length header.
            pending = [{"type": "http.request", "body": b'{"name":"acme"}', "more_body": False}]

            async def receive() -> dict[str, Any]:
                return pending.pop(0) if pending else {"type": "http.disconnect"}

            async with client.stream(
                "POST",
                f"http://127.0.0.1:{port}/api/x",
                headers=[("content-type", "application/json")],
                content=_stream_request_body(receive),
            ) as resp:
                await resp.aread()
        finally:
            await client.aclose()
            await up.stop()
        assert up.is_chunked(), up.head()
        assert up.content_length() is None

    asyncio.run(scenario())


class _inner:
    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:  # pragma: no cover
        await send({"type": "http.response.start", "status": 222, "headers": []})
        await send({"type": "http.response.body", "body": b"inner"})
