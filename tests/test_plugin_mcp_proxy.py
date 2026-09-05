from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
from io import StringIO
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_mcp_proxy import (
    AggregatePluginMcpProxyOptions,
    AggregatePluginMcpProxyServer,
    META_CALL_TOOL,
    META_DESCRIBE_TOOL,
    META_LIST_TOOLS,
    PluginMcpProxyOptions,
    PluginMcpProxyServer,
    build_aggregate_mcp_config,
    build_mcp_config,
    project_plugin_tools,
    projected_tool_name,
    serve_stdio,
)
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _copy_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign_plugin(plugin_dir: Path, private_key: Ed25519PrivateKey) -> None:
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _cache_signed_fixture(tmp_path: Path, name: str = "hello-world") -> tuple[Path, Path, str]:
    plugin_dir = _copy_fixture(tmp_path, name)
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    cache_root = tmp_path / "cache"
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    return plugin_dir, cache_root, public_key


def _write_sidecar(plugin_dir: Path, script_name: str, body: str) -> None:
    script = plugin_dir / "bin" / script_name
    script.write_text(body, encoding="utf-8")
    script.chmod(0o755)


def _entitlement_file(tmp_path: Path, plugin_id: str, version: str = "0.1.0") -> Path:
    path = tmp_path / "entitlements.json"
    path.write_text(
        json.dumps({"entitlements": [{"plugin_id": plugin_id, "version": version, "entitlement_id": "ent_test"}]}),
        encoding="utf-8",
    )
    return path


def test_tool_projection_hides_sidecar_cache_and_secret_details(tmp_path: Path):
    _plugin_dir, cache_root, _public_key = _cache_signed_fixture(tmp_path)

    tools = project_plugin_tools("dev.superclaw.hello-world", cache_root=cache_root)
    text = json.dumps(tools, ensure_ascii=False)

    assert tools == [
        {
            "name": "hello_world",
            "description": "Return a deterministic greeting for plugin contract smoke tests.",
            "inputSchema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        }
    ]
    assert "bin/hello-world" not in text
    assert os.fspath(cache_root) not in text
    assert "provenance" not in text


def test_mcp_config_points_to_superclaw_proxy_without_plugin_paths(tmp_path: Path):
    _plugin_dir, cache_root, _public_key = _cache_signed_fixture(tmp_path)

    config = build_mcp_config("dev.superclaw.hello-world", python_executable="/usr/bin/python3")
    text = json.dumps(config, ensure_ascii=False)

    assert "superclaw.plugin_mcp_proxy" in text
    assert "dev.superclaw.hello-world" in text
    assert "bin/hello-world" not in text
    assert os.fspath(cache_root) not in text
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in text


def test_runtime_version_threads_to_proxy_execution():
    # The projection gate and the execution gate must use the same runtime
    # version: a non-default value reaches the proxy via config args and the
    # aggregate snapshot, and the options carry it for invoke_cached_plugin_tool.
    from superclaw.plugin_mcp_proxy import build_mcp_config
    from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION

    config = build_mcp_config("dev.example.tool", runtime_version="9.9.9")
    args = config["mcpServers"]["superclaw-dev-example-tool"]["args"]
    assert "--runtime-version" in args and "9.9.9" in args
    # Default value is not threaded redundantly.
    default_args = build_mcp_config("dev.example.tool")["mcpServers"]["superclaw-dev-example-tool"]["args"]
    assert "--runtime-version" not in default_args

    opts = AggregatePluginMcpProxyOptions(plugins=(("a", "1"),))
    assert opts.runtime_version == DEFAULT_RUNTIME_VERSION


def test_aggregate_snapshot_round_trips_runtime_version(tmp_path: Path):
    from superclaw.plugin_mcp_proxy import _load_plugin_set
    from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION

    snap = tmp_path / "set.json"
    snap.write_text(json.dumps({"plugins": [{"id": "a", "version": "1"}], "mode": "dispatch", "runtime_version": "0.2.0"}), encoding="utf-8")
    assert _load_plugin_set(snap)["runtime_version"] == "0.2.0"
    snap.write_text(json.dumps({"plugins": [], "mode": "dispatch"}), encoding="utf-8")
    assert _load_plugin_set(snap)["runtime_version"] == DEFAULT_RUNTIME_VERSION


def test_plugin_cli_mcp_config_returns_tools_without_sensitive_paths(tmp_path: Path, monkeypatch):
    _plugin_dir, cache_root, _public_key = _cache_signed_fixture(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))

    result = CliRunner().invoke(app, ["plugin", "mcp-config", "dev.superclaw.hello-world", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    text = json.dumps(payload, ensure_ascii=False)
    assert payload["tools"][0]["name"] == projected_tool_name("dev.superclaw.hello-world", "hello_world")
    assert "superclaw.plugin_mcp_proxy" in text
    assert "bin/hello-world" not in text
    assert os.fspath(cache_root) not in text


def test_mcp_server_handles_initialize_list_and_call_without_exposing_sidecar(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server = PluginMcpProxyServer(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.hello-world",
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        )
    )

    initialized = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    listed = server.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    called = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": projected_tool_name("dev.superclaw.hello-world", "hello_world"), "arguments": {"name": "Ada"}},
        }
    )

    assert initialized["result"]["capabilities"] == {"tools": {}}
    assert listed["result"]["tools"][0]["name"] == projected_tool_name("dev.superclaw.hello-world", "hello_world")
    assert called["result"]["isError"] is False
    assert json.loads(called["result"]["content"][0]["text"]) == {"text": "hello from SuperClaw"}
    combined = json.dumps([initialized, listed, called], ensure_ascii=False)
    assert "bin/hello-world" not in combined
    assert os.fspath(cache_root) not in combined
    assert list((tmp_path / "artifacts").glob("plugininv_*.json"))


def test_mcp_stdio_process_allows_agent_tool_call_through_proxy(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{ROOT / 'packages' / 'superclaw' / 'src'}{os.pathsep}{ROOT}"
    env["SUPERCLAW_PLUGIN_CACHE_PATH"] = str(cache_root)
    env["SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"] = public_key
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "superclaw.plugin_mcp_proxy",
            "serve",
            "--plugin-id",
            "dev.superclaw.hello-world",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    try:
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}) + "\n")
        process.stdin.flush()
        listed = json.loads(process.stdout.readline())
        process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": projected_tool_name("dev.superclaw.hello-world", "hello_world"), "arguments": {"name": "Ada"}},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        called = json.loads(process.stdout.readline())
    finally:
        process.terminate()
        process.wait(timeout=5)

    assert listed["result"]["tools"][0]["name"] == projected_tool_name("dev.superclaw.hello-world", "hello_world")
    assert called["result"]["isError"] is False
    assert json.loads(called["result"]["content"][0]["text"]) == {"text": "hello from SuperClaw"}
    assert "bin/hello-world" not in json.dumps([listed, called], ensure_ascii=False)


def test_mcp_server_returns_proxy_level_tool_error(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server = PluginMcpProxyServer(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.hello-world",
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        )
    )

    response = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": projected_tool_name("dev.superclaw.hello-world", "not_declared"), "arguments": {}},
        }
    )

    assert response["result"]["isError"] is True
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload["error"]["code"] == "PLUGIN_TOOL_NOT_DECLARED"
    assert list((tmp_path / "artifacts").glob("plugininv_*.json"))


def test_mcp_server_routes_nonfree_plugin_entitlement_denial_without_sidecar(tmp_path: Path):
    plugin_dir, cache_root, _public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    marker = tmp_path / "sidecar-started"
    _write_sidecar(
        plugin_dir,
        "github-scanner",
        f"#!/usr/bin/env sh\nset -eu\ntouch {marker}\nprintf '%s\\n' '{{\"text\":\"started\",\"artifacts\":[]}}'\n",
    )
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    shutil.rmtree(cache_root)
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    server = PluginMcpProxyServer(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.github-scanner",
            cache_root=cache_root,
            public_key=public_key,
            entitlement_file=tmp_path / "missing-entitlements.json",
            artifact_dir=tmp_path / "artifacts",
        )
    )

    response = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": projected_tool_name("dev.superclaw.github-scanner", "github_scan"),
                "arguments": {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
            },
        }
    )

    assert response["result"]["isError"] is True
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload["error"]["code"] == "PLUGIN_ENTITLEMENT_MISSING"
    assert not marker.exists()


def test_mcp_server_requires_secret_before_sidecar_start(tmp_path: Path, monkeypatch):
    plugin_dir, cache_root, _public_key = _cache_signed_fixture(tmp_path, "github-scanner")
    marker = tmp_path / "sidecar-started"
    _write_sidecar(
        plugin_dir,
        "github-scanner",
        f"#!/usr/bin/env sh\nset -eu\ntouch {marker}\nprintf '%s\\n' '{{\"text\":\"started\",\"artifacts\":[]}}'\n",
    )
    private_key, public_key = _keypair()
    _sign_plugin(plugin_dir, private_key)
    shutil.rmtree(cache_root)
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    server = PluginMcpProxyServer(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.github-scanner",
            cache_root=cache_root,
            public_key=public_key,
            entitlement_file=_entitlement_file(tmp_path, "dev.superclaw.github-scanner"),
            artifact_dir=tmp_path / "artifacts",
        )
    )

    response = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": projected_tool_name("dev.superclaw.github-scanner", "github_scan"),
                "arguments": {"owner": "ClawHunt-Store", "repo": "SuperClaw"},
            },
        }
    )

    assert response["result"]["isError"] is True
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload["error"]["code"] == "PLUGIN_CONFIG_REQUIRED"
    assert not marker.exists()


def test_mcp_server_unsupported_method_fails_closed(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server = PluginMcpProxyServer(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.hello-world",
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        )
    )

    response = server.handle_message({"jsonrpc": "2.0", "id": 9, "method": "resources/list", "params": {}})

    assert response["error"]["code"] == -32601
    assert "unsupported method" in response["error"]["message"]


def test_stdio_malformed_frame_returns_jsonrpc_error(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    stdout = StringIO()

    serve_stdio(
        PluginMcpProxyOptions(
            plugin_id="dev.superclaw.hello-world",
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        ),
        stdin=StringIO("not-json\n"),
        stdout=stdout,
    )

    response = json.loads(stdout.getvalue())
    assert response["error"]["code"] == -32700


# ---------------------------------------------------------------------------
# Aggregate proxy (single process, dispatch meta-tools, startup-cached catalog)
# ---------------------------------------------------------------------------

HELLO_ID = "dev.superclaw.hello-world"


def _aggregate_server(tmp_path: Path, *, mode: str = "dispatch"):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server = AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=((HELLO_ID, "0.1.0"),),
            mode=mode,
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        )
    )
    return server, cache_root


def _call(server, message_id, name, arguments):
    return server.handle_message(
        {"jsonrpc": "2.0", "id": message_id, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    )


def test_aggregate_dispatch_exposes_three_meta_tools(tmp_path: Path):
    server, _cache_root = _aggregate_server(tmp_path)
    listed = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    names = [tool["name"] for tool in listed["result"]["tools"]]
    assert names == [META_LIST_TOOLS, META_DESCRIBE_TOOL, META_CALL_TOOL]


def test_aggregate_dispatch_list_describe_call(tmp_path: Path):
    server, _cache_root = _aggregate_server(tmp_path)
    projected = projected_tool_name(HELLO_ID, "hello_world")

    listed = _call(server, 2, META_LIST_TOOLS, {})
    catalog = json.loads(listed["result"]["content"][0]["text"])["tools"]
    assert catalog == [{"name": projected, "plugin_id": HELLO_ID, "description": "Return a deterministic greeting for plugin contract smoke tests."}]

    described = _call(server, 3, META_DESCRIBE_TOOL, {"name": projected})
    schema = json.loads(described["result"]["content"][0]["text"])["inputSchema"]
    assert schema["required"] == ["name"]

    called = _call(server, 4, META_CALL_TOOL, {"name": projected, "arguments": {"name": "Ada"}})
    assert called["result"]["isError"] is False
    assert json.loads(called["result"]["content"][0]["text"]) == {"text": "hello from SuperClaw"}


def test_aggregate_dispatch_filters_by_plugin_id(tmp_path: Path):
    server, _cache_root = _aggregate_server(tmp_path)
    listed = _call(server, 5, META_LIST_TOOLS, {"plugin_id": "nope.not.installed"})
    assert json.loads(listed["result"]["content"][0]["text"])["tools"] == []


def test_aggregate_full_mode_exposes_tools_with_schema(tmp_path: Path):
    server, _cache_root = _aggregate_server(tmp_path, mode="full")
    listed = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    tools = listed["result"]["tools"]
    assert tools[0]["name"] == projected_tool_name(HELLO_ID, "hello_world")
    assert "inputSchema" in tools[0]


def test_aggregate_catalog_built_once_survives_cache_deletion(tmp_path: Path):
    # Catalog is built at construction; a later tools/list must not re-read disk.
    server, cache_root = _aggregate_server(tmp_path, mode="full")
    shutil.rmtree(cache_root)
    listed = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    assert listed["result"]["tools"][0]["name"] == projected_tool_name(HELLO_ID, "hello_world")


def test_aggregate_skips_unloadable_plugin(tmp_path: Path):
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server = AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=((HELLO_ID, "0.1.0"), ("bogus.missing.plugin", None)),
            cache_root=cache_root,
            public_key=public_key,
            artifact_dir=tmp_path / "artifacts",
        )
    )
    listed = _call(server, 1, META_LIST_TOOLS, {})
    plugin_ids = {row["plugin_id"] for row in json.loads(listed["result"]["content"][0]["text"])["tools"]}
    assert plugin_ids == {HELLO_ID}


def test_aggregate_unknown_meta_tool_fails_closed(tmp_path: Path):
    server, _cache_root = _aggregate_server(tmp_path)
    response = _call(server, 1, "superclaw__not_a_meta_tool", {})
    assert response["error"]["code"] == -32601


def test_build_aggregate_mcp_config_single_server(tmp_path: Path):
    config = build_aggregate_mcp_config(tmp_path / "set.json", mode="dispatch")
    servers = config["mcpServers"]
    assert list(servers.keys()) == ["superclaw"]
    args = servers["superclaw"]["args"]
    assert "serve-aggregate" in args and "--mode" in args and "dispatch" in args


def test_aggregate_call_revalidates_governance_even_if_catalog_listed_tool(tmp_path: Path):
    # Defense in depth: the catalog is a startup snapshot; a tool that is revoked
    # after the catalog is built must still be refused at call time.
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    revocation_file = tmp_path / "revocations.json"
    revocation_file.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    server = AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=((HELLO_ID, "0.1.0"),),
            cache_root=cache_root,
            public_key=public_key,
            revocation_file=revocation_file,
            artifact_dir=tmp_path / "artifacts",
        )
    )
    projected = projected_tool_name(HELLO_ID, "hello_world")
    # Catalog still lists it...
    listed = _call(server, 1, META_LIST_TOOLS, {})
    assert json.loads(listed["result"]["content"][0]["text"])["tools"][0]["name"] == projected
    # ...but after revocation the actual call is refused (fail-closed).
    revocation_file.write_text(json.dumps({"revoked": [{"plugin_id": HELLO_ID}]}), encoding="utf-8")
    called = _call(server, 2, META_CALL_TOOL, {"name": projected, "arguments": {"name": "Ada"}})
    assert called["result"]["isError"] is True
    assert "PLUGIN_REVOKED" in json.dumps(called["result"], ensure_ascii=False)


def test_load_plugin_set_reads_self_contained_fields(tmp_path: Path):
    from superclaw.plugin_mcp_proxy import _load_plugin_set

    p = tmp_path / "set.json"
    p.write_text(
        json.dumps({"mode": "dispatch", "plugins": [{"id": "x", "version": "1"}], "cache_root": "/c", "public_key": "pk"}),
        encoding="utf-8",
    )
    s = _load_plugin_set(p)
    assert s["plugins"] == (("x", "1"),)
    assert s["cache_root"] == "/c"
    assert s["public_key"] == "pk"
    assert s["mode"] == "dispatch"


def test_aggregate_servers_have_isolated_catalogs(tmp_path: Path):
    # Two runs each spawn their OWN aggregate proxy instance with its OWN catalog.
    # A proxy built for a run that has no plugins cannot see another run's plugins.
    _plugin_dir, cache_root, public_key = _cache_signed_fixture(tmp_path)
    server_with = AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=((HELLO_ID, "0.1.0"),), cache_root=cache_root, public_key=public_key, artifact_dir=tmp_path / "a"
        )
    )
    server_without = AggregatePluginMcpProxyServer(
        AggregatePluginMcpProxyOptions(
            plugins=(), cache_root=cache_root, public_key=public_key, artifact_dir=tmp_path / "b"
        )
    )
    with_tools = json.loads(_call(server_with, 1, META_LIST_TOOLS, {})["result"]["content"][0]["text"])["tools"]
    without_tools = json.loads(_call(server_without, 2, META_LIST_TOOLS, {})["result"]["content"][0]["text"])["tools"]
    assert [t["plugin_id"] for t in with_tools] == [HELLO_ID]
    assert without_tools == []  # isolated: cannot see the other instance's catalog
    # The route is per-instance too: the empty server refuses a tool the other one routes.
    refused = _call(server_without, 3, META_CALL_TOOL, {"name": projected_tool_name(HELLO_ID, "hello_world"), "arguments": {}})
    assert refused["result"]["isError"] is True
