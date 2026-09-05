"""Unit tests for the Node-owned route manifest loader (node_routes.py).

In-process, instant, no subprocess — the manifest is pure data + validation.
Verifies the single-source-of-truth manifest loads in order with the right
transport metadata, and that malformed manifests fail closed (raise), never
silently route nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from superclaw.node_routes import (
    MANIFEST_PATH,
    NodeRoutesError,
    load_node_routes,
    node_route_prefixes,
)

# The canonical Node-owned prefixes, in manifest order. This list is the contract
# the Python front door AND apps/web/vite.config.mjs both consume; if it changes,
# update node_routes.json (the single source) and this expectation together.
EXPECTED_PREFIXES = (
    "/paperclip-api",
    "/_plugins",
    "/api/chat",
    "/api/workspaces",
    "/api/backends",
    "/api/agents",
    "/v1/skills",
)


def _write_manifest(tmp_path: Path, routes: list[dict]) -> str:
    path = tmp_path / "node_routes.json"
    path.write_text(json.dumps({"version": 1, "nodeRoutes": routes}), encoding="utf-8")
    return str(path)


def test_default_manifest_exists_next_to_module() -> None:
    assert MANIFEST_PATH.name == "node_routes.json"
    assert MANIFEST_PATH.is_file()


def test_load_default_manifest_order_and_prefixes() -> None:
    assert node_route_prefixes() == EXPECTED_PREFIXES


def test_paperclip_api_carries_rewrite_and_ws() -> None:
    routes = {route.prefix: route for route in load_node_routes()}
    pc = routes["/paperclip-api"]
    assert pc.ws is True
    assert pc.rewrite is not None
    assert pc.rewrite.from_ == "^/paperclip-api"
    assert pc.rewrite.to == "/api"


def test_chat_prefix_declares_sse_stream() -> None:
    routes = {route.prefix: route for route in load_node_routes()}
    chat = routes["/api/chat"]
    assert chat.sse is not None
    assert chat.sse.method == "POST"
    assert chat.sse.path == "/api/chat/stream"


def test_plain_prefix_has_no_transport_metadata() -> None:
    routes = {route.prefix: route for route in load_node_routes()}
    plain = routes["/api/workspaces"]
    assert plain.ws is False
    assert plain.rewrite is None
    assert plain.sse is None
    assert plain.match == "prefix"


def test_skills_route_is_exact_match() -> None:
    routes = {route.prefix: route for route in load_node_routes()}
    assert routes["/v1/skills"].match == "exact"


def test_rejects_invalid_match(tmp_path: Path) -> None:
    with pytest.raises(NodeRoutesError, match="'match' must be"):
        load_node_routes(_write_manifest(tmp_path, [{"prefix": "/x", "match": "wildcard"}]))


def test_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(NodeRoutesError, match="not found"):
        load_node_routes(str(tmp_path / "does-not-exist.json"))


def test_rejects_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "node_routes.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(NodeRoutesError, match="not valid JSON"):
        load_node_routes(str(path))


def test_rejects_empty_routes(tmp_path: Path) -> None:
    with pytest.raises(NodeRoutesError, match="must not be empty"):
        load_node_routes(_write_manifest(tmp_path, []))


def test_rejects_duplicate_prefix(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, [{"prefix": "/api/chat"}, {"prefix": "/api/chat"}])
    with pytest.raises(NodeRoutesError, match="duplicate"):
        load_node_routes(manifest)


def test_rejects_root_prefix(tmp_path: Path) -> None:
    with pytest.raises(NodeRoutesError, match="non-root path"):
        load_node_routes(_write_manifest(tmp_path, [{"prefix": "/"}]))


def test_rejects_prefix_without_leading_slash(tmp_path: Path) -> None:
    with pytest.raises(NodeRoutesError, match="starting with"):
        load_node_routes(_write_manifest(tmp_path, [{"prefix": "api/chat"}]))


def test_rejects_collision_with_python_catchall(tmp_path: Path) -> None:
    # A Node prefix may be LONGER than a catch-all (/v1/skills under /v1) but never
    # exactly equal to one (/api, /v1, ...), which would shadow Python entirely.
    with pytest.raises(NodeRoutesError, match="catch-all"):
        load_node_routes(_write_manifest(tmp_path, [{"prefix": "/api"}]))


def test_rejects_malformed_rewrite(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, [{"prefix": "/x", "rewrite": {"from": "^/x"}}])
    with pytest.raises(NodeRoutesError, match="rewrite"):
        load_node_routes(manifest)


def test_rejects_malformed_sse(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, [{"prefix": "/x", "sse": {"method": "POST", "path": "no-slash"}}])
    with pytest.raises(NodeRoutesError, match="sse"):
        load_node_routes(manifest)


def test_rejects_non_object_root(tmp_path: Path) -> None:
    # A top-level JSON array must fail closed as NodeRoutesError (clean error
    # contract), not leak an AttributeError from data.get(...).
    path = tmp_path / "node_routes.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(NodeRoutesError, match="root must be an object"):
        load_node_routes(str(path))


def test_manifest_is_declared_in_package_data() -> None:
    # The front door + frozen desktop load the manifest as installed package data.
    # If it is not in pyproject package-data, a wheel/frozen build silently ships
    # without it and the "single source of truth" breaks at runtime — guard that.
    import tomllib

    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    config = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    package_data = config["tool"]["setuptools"]["package-data"]["superclaw"]
    assert "node_routes.json" in package_data
