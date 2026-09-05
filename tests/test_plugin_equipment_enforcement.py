"""Layer 2 of Agent Team Kernel §2.6 item 4 — execution-layer equipment narrowing.

These cover the proxy EXECUTION choke point (``invoke_cached_plugin_tool``) and
the aggregate proxy startup plumbing that carries the per-agent grant. Layer 1
(projection-layer narrowing of the MCP config) is covered in
``test_plugin_runtime_projection.py``.

Scope reminder (honest boundary): this gate closes the gap for a CONTAINED agent
that cannot tamper with the orchestrator-generated launch config. A full-shell
agent that rewrites the plugin-set / launches its own proxy / calls the operator
CLI is NOT closed here — that boundary is the backend containment contract.
"""

from __future__ import annotations

import json
from pathlib import Path

from superclaw.plugin_mcp_proxy import (
    PluginMcpProxyOptions,
    PluginMcpProxyServer,
    _load_plugin_set,
    _narrow_plugins_to_grant,
    _parse_allowed_plugins,
    _resolve_effective_grant,
    build_aggregate_mcp_config,
    main,
)
from superclaw.plugin_proxy import invoke_cached_plugin_tool


def _code(result) -> str:
    return result.model_response["error"]["code"]


# --- choke point gate: invoke_cached_plugin_tool -----------------------------


def test_ungranted_plugin_rejected_before_package_load(tmp_path: Path) -> None:
    # 'ghost-plugin' is neither installed nor granted. The grant gate must fire
    # FIRST -> PLUGIN_NOT_GRANTED, not PLUGIN_NOT_INSTALLED. That ordering is the
    # whole point: an un-granted id triggers no install/signature/entitlement work.
    result = invoke_cached_plugin_tool(
        "ghost-plugin",
        "do",
        {},
        granted_plugin_ids=frozenset({"granted-only"}),
        artifact_dir=tmp_path,
    )
    assert not result.ok
    assert _code(result) == "PLUGIN_NOT_GRANTED"


def test_empty_grant_rejects_everything(tmp_path: Path) -> None:
    # A team agent with no granted equipment (CEO with nothing) reaches no plugin.
    result = invoke_cached_plugin_tool(
        "any-plugin",
        "do",
        {},
        granted_plugin_ids=frozenset(),
        artifact_dir=tmp_path,
    )
    assert not result.ok
    assert _code(result) == "PLUGIN_NOT_GRANTED"


def test_none_grant_does_not_narrow(tmp_path: Path) -> None:
    # None = no narrowing (operator / non-team path). Falls through to the load,
    # which fails NOT_INSTALLED for a ghost id — never NOT_GRANTED.
    result = invoke_cached_plugin_tool(
        "ghost-plugin",
        "do",
        {},
        granted_plugin_ids=None,
        artifact_dir=tmp_path,
    )
    assert not result.ok
    assert _code(result) != "PLUGIN_NOT_GRANTED"


def test_granted_id_clears_gate_then_fails_on_missing_package(tmp_path: Path) -> None:
    # A granted id must clear the gate; absent from cache it then fails on load as
    # NOT_INSTALLED — proving the gate does not block a granted plugin.
    result = invoke_cached_plugin_tool(
        "granted-ghost",
        "do",
        {},
        granted_plugin_ids=frozenset({"granted-ghost"}),
        artifact_dir=tmp_path,
    )
    assert not result.ok
    assert _code(result) != "PLUGIN_NOT_GRANTED"


# --- grant parsing / resolution / startup invariant --------------------------


def test_parse_allowed_plugins() -> None:
    assert _parse_allowed_plugins(None) is None  # flag absent -> fall back to snapshot
    assert _parse_allowed_plugins("") == frozenset()  # explicit empty -> fail-closed
    assert _parse_allowed_plugins("a, b ,c") == frozenset({"a", "b", "c"})
    assert _parse_allowed_plugins(" , ") == frozenset()


def test_resolve_effective_grant_cli_is_authoritative() -> None:
    # CLI argv wins over the (tamperable) snapshot field, including an empty grant.
    assert _resolve_effective_grant(frozenset({"x"}), frozenset({"y"})) == frozenset({"x"})
    assert _resolve_effective_grant(frozenset(), frozenset({"y"})) == frozenset()
    assert _resolve_effective_grant(None, frozenset({"y"})) == frozenset({"y"})
    assert _resolve_effective_grant(None, None) is None


def test_narrow_plugins_to_grant_enforces_subset() -> None:
    plugins = (("a", None), ("b", "1"), ("c", None))
    kept, dropped = _narrow_plugins_to_grant(plugins, frozenset({"a", "c"}))
    assert kept == (("a", None), ("c", None))
    assert dropped == ["b"]

    kept_all, dropped_none = _narrow_plugins_to_grant(plugins, None)
    assert kept_all == plugins and dropped_none == []

    kept_empty, dropped_all = _narrow_plugins_to_grant(plugins, frozenset())
    assert kept_empty == () and sorted(dropped_all) == ["a", "b", "c"]


# --- aggregate MCP config injects the authoritative argv ---------------------


def test_aggregate_config_injects_sorted_allowed_plugins() -> None:
    cfg = build_aggregate_mcp_config("/x/ps.json", allowed_plugin_ids=frozenset({"p2", "p1"}))
    args = cfg["mcpServers"]["superclaw"]["args"]
    assert "--allowed-plugins" in args
    assert args[args.index("--allowed-plugins") + 1] == "p1,p2"


def test_aggregate_config_empty_grant_emits_empty_flag() -> None:
    # An empty grant must still emit the flag (empty string) so the proxy narrows
    # to nothing — omitting it would be read as "no narrowing" (fail-open).
    cfg = build_aggregate_mcp_config("/x/ps.json", allowed_plugin_ids=frozenset())
    args = cfg["mcpServers"]["superclaw"]["args"]
    assert "--allowed-plugins" in args
    assert args[args.index("--allowed-plugins") + 1] == ""


def test_aggregate_config_none_grant_omits_flag() -> None:
    cfg = build_aggregate_mcp_config("/x/ps.json", allowed_plugin_ids=None)
    assert "--allowed-plugins" not in cfg["mcpServers"]["superclaw"]["args"]


# --- snapshot load reads the grant fallback ----------------------------------


def _write_snapshot(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_load_plugin_set_reads_granted_field(tmp_path: Path) -> None:
    snap = _write_snapshot(
        tmp_path / "ps.json",
        {
            "plugins": [{"id": "x"}],
            "mode": "dispatch",
            "cache_root": "/c",
            "runtime_version": "1",
            "granted_plugin_ids": ["x", "y"],
        },
    )
    assert _load_plugin_set(snap)["granted_plugin_ids"] == frozenset({"x", "y"})


def test_load_plugin_set_missing_granted_is_none(tmp_path: Path) -> None:
    snap = _write_snapshot(
        tmp_path / "ps.json",
        {"plugins": [{"id": "x"}], "mode": "dispatch", "cache_root": "/c", "runtime_version": "1"},
    )
    assert _load_plugin_set(snap)["granted_plugin_ids"] is None


def test_load_plugin_set_malformed_granted_is_failclosed(tmp_path: Path) -> None:
    # A tampered scalar (e.g. "all" / 123) must NOT fall back to None (no
    # narrowing); it fail-closes to an empty grant (deny everything).
    for bad in ("all", 123, {"x": 1}):
        snap = _write_snapshot(
            tmp_path / "ps.json",
            {
                "plugins": [{"id": "x"}],
                "mode": "dispatch",
                "cache_root": "/c",
                "runtime_version": "1",
                "granted_plugin_ids": bad,
            },
        )
        assert _load_plugin_set(snap)["granted_plugin_ids"] == frozenset()


def test_load_plugin_set_mixed_malformed_granted_is_failclosed(tmp_path: Path) -> None:
    # A mixed-malformed collection (dirty element) fails closed — never silently
    # filter ['x', 5, ''] into {'x'} (laundering parity with _granted_plugin_ids).
    for bad in (["x", 5, ""], ["x", "  "], ["ok", None]):
        snap = _write_snapshot(
            tmp_path / "ps.json",
            {
                "plugins": [{"id": "x"}],
                "mode": "dispatch",
                "cache_root": "/c",
                "runtime_version": "1",
                "granted_plugin_ids": bad,
            },
        )
        assert _load_plugin_set(snap)["granted_plugin_ids"] == frozenset()


# --- single-plugin proxy: grant gate BEFORE any package load -----------------
# Regression cover for the dual-advisor blocker: tools/list -> _projected_tools
# and tools/call -> _tool_route both loaded the package before the grant check.


def _single_server(plugin_id: str, granted: frozenset[str] | None) -> PluginMcpProxyServer:
    return PluginMcpProxyServer(PluginMcpProxyOptions(plugin_id=plugin_id, granted_plugin_ids=granted))


def test_single_proxy_list_projects_nothing_for_ungranted_without_load() -> None:
    # 'ghost' is not installed; if the gate ran AFTER load this would raise on
    # _load_cached_package. An empty result with no exception proves no load.
    server = _single_server("ghost", frozenset({"other"}))
    resp = server.handle_message({"id": 1, "method": "tools/list"})
    assert resp["result"]["tools"] == []


def test_single_proxy_call_rejects_ungranted_before_load() -> None:
    server = _single_server("ghost", frozenset({"other"}))
    resp = server.handle_message(
        {"id": 2, "method": "tools/call", "params": {"name": "superclaw_plugin__ghost__do", "arguments": {}}}
    )
    assert resp["result"]["isError"] is True
    payload = json.loads(resp["result"]["content"][0]["text"])
    # NOT_GRANTED (gate) rather than NOT_INSTALLED (load) proves the gate is first.
    assert payload["error"]["code"] == "PLUGIN_NOT_GRANTED"


def test_single_proxy_empty_grant_denies_everything() -> None:
    server = _single_server("anything", frozenset())
    assert server.handle_message({"id": 3, "method": "tools/list"})["result"]["tools"] == []


def test_single_proxy_none_grant_does_not_deny() -> None:
    # None = operator path: _grant_denied() is False (it would then attempt a real
    # load, which is the pre-existing behavior — not our concern here).
    server = _single_server("ghost", None)
    assert server._grant_denied() is False


def test_main_serve_refuses_to_start_ungranted_plugin() -> None:
    # Startup-layer fail-closed: refuse to start a single proxy for a plugin
    # outside the grant (returns 1 instead of serving).
    rc = main(["serve", "--plugin-id", "ghost", "--allowed-plugins", "other"])
    assert rc == 1


def test_main_serve_empty_grant_refuses_to_start() -> None:
    rc = main(["serve", "--plugin-id", "ghost", "--allowed-plugins", ""])
    assert rc == 1


def test_aggregate_catalog_skips_ungranted_without_load(monkeypatch) -> None:
    # Class-level defense in depth: even if an un-granted plugin slips into
    # options.plugins, _build_catalog must skip it BEFORE project_plugin_tools
    # (load). Spy proves the un-granted id is never loaded.
    import superclaw.plugin_mcp_proxy as mod
    from superclaw.plugin_mcp_proxy import AggregatePluginMcpProxyOptions, AggregatePluginMcpProxyServer

    loaded: list[str] = []

    def _spy(plugin_id, **kwargs):
        loaded.append(plugin_id)
        return [{"name": "do", "description": "d", "inputSchema": {}}]

    monkeypatch.setattr(mod, "project_plugin_tools", _spy)
    AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=(("granted-a", None), ("ungranted-b", None)),
            granted_plugin_ids=frozenset({"granted-a"}),
        )
    )
    assert loaded == ["granted-a"]
