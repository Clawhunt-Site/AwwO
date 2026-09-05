"""Node-owned route manifest — the single source of truth for which URL prefixes
the coexist split forwards to the vendored Node control plane (server/server).

The manifest lives in ``node_routes.json`` next to this module and is consumed by
BOTH surfaces so dev and production/desktop can never drift:

* ``apps/web/vite.config.mjs`` builds its dev/preview proxy from the same JSON.
* The Python front door (``apps/api``) reverse-proxies these prefixes to the
  co-launched Node server; everything NOT listed falls through to Python.

This module only loads, validates and exposes the manifest as typed records. It
makes no network calls and has no side effects at import time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

MANIFEST_NAME = "node_routes.json"
MANIFEST_PATH = Path(__file__).resolve().parent / MANIFEST_NAME

# Python catch-all prefixes the Node manifest must never collide with directly,
# but which it may legitimately precede with a longer, more specific prefix
# (e.g. Node owns ``/v1/skills`` while Python owns ``/v1``). Used only by the
# ordering invariant check below.
_PY_CATCHALLS = ("/api", "/a2a", "/v1", "/health", "/.well-known")


@dataclass(frozen=True)
class RouteRewrite:
    """A path rewrite applied before forwarding to Node (e.g. ``/paperclip-api`` ->
    ``/api``). ``from_`` is an anchored regex; ``to`` is the replacement."""

    from_: str
    to: str


@dataclass(frozen=True)
class SseEndpoint:
    """A streaming (``text/event-stream``) endpoint under a Node prefix the front
    door must forward without buffering."""

    method: str
    path: str


@dataclass(frozen=True)
class NodeRoute:
    """One Node-owned route prefix and its transport metadata.

    ``match`` is ``"prefix"`` (default — the whole subtree under ``prefix`` is
    Node-owned) or ``"exact"`` (only the exact path is Node-owned; sub-paths stay
    Python). Use ``"exact"`` when Node serves just one path under a prefix that
    Python also extends — e.g. Node owns ``GET /v1/skills`` for the composer, but
    Python still owns ``/v1/skills/build|import|sync``."""

    prefix: str
    rewrite: RouteRewrite | None = None
    ws: bool = False
    sse: SseEndpoint | None = None
    match: str = "prefix"
    note: str = ""


class NodeRoutesError(ValueError):
    """Raised when the manifest is missing, malformed, or violates an invariant."""


def _coerce_rewrite(raw: Any, prefix: str) -> RouteRewrite | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or "from" not in raw or "to" not in raw:
        raise NodeRoutesError(f"route {prefix!r}: 'rewrite' must be {{from, to}}")
    frm, to = raw["from"], raw["to"]
    if not isinstance(frm, str) or not isinstance(to, str) or not frm:
        raise NodeRoutesError(f"route {prefix!r}: 'rewrite.from'/'rewrite.to' must be non-empty strings")
    return RouteRewrite(from_=frm, to=to)


def _coerce_sse(raw: Any, prefix: str) -> SseEndpoint | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or "method" not in raw or "path" not in raw:
        raise NodeRoutesError(f"route {prefix!r}: 'sse' must be {{method, path}}")
    method, path = raw["method"], raw["path"]
    if not isinstance(method, str) or not isinstance(path, str) or not method or not path.startswith("/"):
        raise NodeRoutesError(f"route {prefix!r}: 'sse.method' non-empty and 'sse.path' must start with '/'")
    return SseEndpoint(method=method.upper(), path=path)


def _coerce_route(raw: Any, index: int) -> NodeRoute:
    if not isinstance(raw, dict):
        raise NodeRoutesError(f"nodeRoutes[{index}] must be an object")
    prefix = raw.get("prefix")
    if not isinstance(prefix, str) or not prefix.startswith("/") or prefix == "/":
        raise NodeRoutesError(f"nodeRoutes[{index}]: 'prefix' must be a non-root path starting with '/'")
    ws = raw.get("ws", False)
    if not isinstance(ws, bool):
        raise NodeRoutesError(f"route {prefix!r}: 'ws' must be a boolean")
    match = raw.get("match", "prefix")
    if match not in ("prefix", "exact"):
        raise NodeRoutesError(f"route {prefix!r}: 'match' must be 'prefix' or 'exact'")
    note = raw.get("note", "")
    if not isinstance(note, str):
        raise NodeRoutesError(f"route {prefix!r}: 'note' must be a string")
    return NodeRoute(
        prefix=prefix,
        rewrite=_coerce_rewrite(raw.get("rewrite"), prefix),
        ws=ws,
        sse=_coerce_sse(raw.get("sse"), prefix),
        match=match,
        note=note,
    )


def _validate(routes: list[NodeRoute]) -> None:
    """Enforce manifest invariants: non-empty, no duplicate prefixes, and that no
    Node prefix is exactly a Python catch-all (a Node prefix may be *longer* than a
    catch-all, e.g. ``/v1/skills`` under ``/v1``, but never equal to it)."""
    if not routes:
        raise NodeRoutesError("manifest 'nodeRoutes' must not be empty")
    seen: set[str] = set()
    for route in routes:
        if route.prefix in seen:
            raise NodeRoutesError(f"duplicate Node prefix {route.prefix!r}")
        seen.add(route.prefix)
        if route.prefix in _PY_CATCHALLS:
            raise NodeRoutesError(
                f"Node prefix {route.prefix!r} collides with a Python catch-all; "
                "use a longer, more specific prefix instead"
            )


@lru_cache(maxsize=1)
def load_node_routes(manifest_path: str | None = None) -> tuple[NodeRoute, ...]:
    """Load, validate and return the Node-owned routes in manifest order.

    Cached for the default manifest. Raises :class:`NodeRoutesError` when the file
    is missing or malformed (fail-closed: callers must not silently route nothing).
    """
    path = Path(manifest_path) if manifest_path else MANIFEST_PATH
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise NodeRoutesError(f"Node routes manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise NodeRoutesError(f"Node routes manifest is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise NodeRoutesError(f"manifest root must be an object: {path}")
    raw_routes = data.get("nodeRoutes")
    if not isinstance(raw_routes, list):
        raise NodeRoutesError("manifest must contain a 'nodeRoutes' array")
    routes = [_coerce_route(raw, i) for i, raw in enumerate(raw_routes)]
    _validate(routes)
    return tuple(routes)


def node_route_prefixes(manifest_path: str | None = None) -> tuple[str, ...]:
    """Just the ordered Node-owned prefixes (convenience for prefix matching)."""
    return tuple(route.prefix for route in load_node_routes(manifest_path))
