"""Gateway front door — the production/desktop equivalent of the Vite dev proxy's
``/gateway-api`` rule. A pure-ASGI reverse proxy that forwards ``/gateway-api/*`` to
the co-launched Node automation gateway (apps/gateway), rewriting the prefix to
``/api`` and injecting the gateway control token, so the SAME routing Vite fakes in
dev also happens when the Python service hosts apps/web's static bundle (desktop).

Why a SEPARATE middleware from :class:`NodeFrontDoorMiddleware` (which proxies the
``node_routes.json`` prefixes to the vendored Node control plane): the gateway is a
DIFFERENT target (its own port, discovered from ``gateway-marker.json``) and requires
a control-token header the upstream routes do not — folding it into the manifest
(whose routes all target one upstream base URL) would be wrong. This is a thin,
focused proxy that reuses the Node front door's streaming primitives.

Marker-gated, fail-closed (mirrors the Node front door):
* No ``gateway-marker.json`` -> the gateway was not co-launched here (plain Python /
  tests) -> delegate to the wrapped app (zero regression; the route 404s as before).
* Marker present but its port is unreadable, OR present-and-gateway-unreachable ->
  ``/gateway-api`` fails **closed** with 503 (never falls through to Python).

The browser holds NO *gateway control token*: that token is read server-side from
``$SUPERCLAW_HOME/gateway-control-token`` (0600, written by the gateway) and injected
on the forwarded request, exactly as the Vite proxy does in dev. Ordinary end-user
``Authorization`` is preserved separately so the SSO identity route can verify the
user's ClawHunt bearer token.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from superclaw.logging_config import get_logger
from superclaw.node_front_door import (
    _PROXY_TIMEOUT,
    _ClientDisconnected,
    _connection_hop_headers,
    _prepare_forward_body,
    _request_headers,
    _RequestBodyTooLarge,
    _response_headers,
    _send_payload_too_large,
    _send_unavailable,
)

logger = get_logger("api.gateway_front_door")

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]

# The browser-facing prefix and what it rewrites to on the gateway (mirrors the Vite
# proxy's ``^/gateway-api -> /api``). The gateway serves its automation routes under
# ``/api`` (e.g. ``/api/automations``), just like the upstream.
_GATEWAY_PREFIX = "/gateway-api"
_GATEWAY_REWRITE_TO = "/api"
# Header carrying the loopback control token (matches the gateway's mutation auth gate
# and the Vite proxy's injected header). This is distinct from an end-user Authorization
# bearer, which is forwarded unchanged for /api/auth/me.
_TOKEN_HEADER = "x-superclaw-gateway-token"

_MARKER_NAME = "gateway-marker.json"
_TOKEN_NAME = "gateway-control-token"


def gateway_marker_exists(run_dir: Path | str) -> bool:
    """Whether the gateway co-launch marker exists — i.e. *this* process co-launched
    the gateway. Distinguishes "no marker" (plain Python / tests -> delegate) from
    "marker present but gateway unreadable/unreachable" (fail closed)."""
    return (Path(run_dir) / _MARKER_NAME).is_file()


def read_gateway_port(run_dir: Path | str) -> int | None:
    """Return the co-launched gateway's ACTUAL bound port from ``gateway-marker.json``
    (written by the gateway's Node lifecycle), or ``None`` when the marker is
    absent/unreadable or carries no valid port. Reading the marker (not a fixed
    constant) means a gateway that bound a different port is still resolved."""
    marker = Path(run_dir) / _MARKER_NAME
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    port = payload.get("port") if isinstance(payload, dict) else None
    return port if isinstance(port, int) and 1 <= port <= 65535 else None


def read_gateway_control_token(run_dir: Path | str) -> str | None:
    """Read the gateway control token from ``$SUPERCLAW_HOME/gateway-control-token``
    (the parent of ``run_dir``), or ``None`` when absent/empty. Injected server-side so
    the browser never holds the secret."""
    token_path = Path(run_dir).parent / _TOKEN_NAME
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


class GatewayFrontDoorMiddleware:
    """ASGI middleware reverse-proxying ``/gateway-api/*`` to the co-launched gateway."""

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        run_dir: Path | str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.app = app
        self.run_dir = Path(run_dir)
        self._client = client

    def _client_or_default(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT, follow_redirects=False)
        return self._client

    def _matches(self, path: str) -> bool:
        return path == _GATEWAY_PREFIX or path.startswith(_GATEWAY_PREFIX + "/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._matches(scope["path"]):
            await self.app(scope, receive, send)
            return
        if not gateway_marker_exists(self.run_dir):
            # No marker -> gateway not co-launched here (plain Python / tests). Inactive;
            # the wrapped app serves (the route 404s, as it would without the gateway).
            await self.app(scope, receive, send)
            return
        port = read_gateway_port(self.run_dir)
        if port is None:
            logger.warning("gateway_front_door.marker_unreadable -> 503")
            await _send_unavailable(send, _GATEWAY_PREFIX)
            return
        await self._proxy(scope, receive, send, port)

    async def _proxy(self, scope: Scope, receive: Receive, send: Send, port: int) -> None:
        # Rewrite ^/gateway-api -> /api (mirrors the Vite proxy).
        path = _GATEWAY_REWRITE_TO + scope["path"][len(_GATEWAY_PREFIX) :]
        query: bytes = scope.get("query_string", b"")
        url = f"http://127.0.0.1:{port}{path}"
        if query:
            url = f"{url}?{query.decode('latin-1')}"
        method: str = scope["method"]
        raw_headers: list[tuple[bytes, bytes]] = scope.get("headers", [])
        dynamic_hop = _connection_hop_headers(raw_headers)
        headers = _request_headers(raw_headers, dynamic_hop)
        # Inject the control token server-side (the browser never holds it). Drop any
        # client-supplied token header first so it cannot spoof/override.
        headers = [(name, value) for (name, value) in headers if name.lower() != _TOKEN_HEADER]
        token = read_gateway_control_token(self.run_dir)
        if not token:
            # Marker present (gateway co-launched) but its control token is missing —
            # forwarding tokenless would draw a misleading 401 from the gateway. Fail
            # CLOSED with 503 (gateway not ready / misconfigured) so the client retries
            # rather than treating it as an auth failure.
            logger.warning("gateway_front_door.token_missing -> 503")
            await _send_unavailable(send, _GATEWAY_PREFIX)
            return
        headers.append((_TOKEN_HEADER, token))
        # Same body-framing guarantee as the Node front door: forward writes with an
        # explicit Content-Length so httpx never chunks (the co-launched gateway, like
        # the Node control plane, reads a chunked request body as empty). Shared helper
        # streams+restores when a length survives, else buffers once (bounded -> 413).
        try:
            content = await _prepare_forward_body(receive, raw_headers, headers, method)
        except _RequestBodyTooLarge:
            logger.warning("gateway_front_door.body_too_large -> 413")
            await _send_payload_too_large(send, _GATEWAY_PREFIX)
            return
        except _ClientDisconnected:
            # Client vanished mid-upload while we buffered the body (see the Node front
            # door for the same guard; the streaming path's disconnect is caught below).
            logger.info("gateway_front_door.client_disconnect")
            return
        client = self._client_or_default()
        started = False
        try:
            async with client.stream(method, url, headers=headers, content=content) as upstream:
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
            logger.info("gateway_front_door.proxy method=%s status=%s", method, upstream.status_code)
        except _ClientDisconnected:
            logger.info("gateway_front_door.client_disconnect")
        except httpx.HTTPError as exc:
            if started:
                logger.warning("gateway_front_door.mid_stream_error err=%r", exc)
                await send({"type": "http.response.body", "body": b"", "more_body": False})
                return
            logger.warning("gateway_front_door.unreachable err=%r -> 503", exc)
            await _send_unavailable(send, _GATEWAY_PREFIX)
