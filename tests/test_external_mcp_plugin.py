"""External-MCP plugin runtime: a curated, root-signed plugin whose runtime is an
EXTERNAL MCP server (command/args over stdio) instead of an in-package sidecar
script. Exercises the full governance proxy choke point — sign -> cache -> verify
-> gate -> _run_external_mcp -> MCP handshake -> tools/call -> normalized output
-> output-schema validation — plus enumeration/projection and the failure paths.

Hermetic: the "external MCP server" is a tiny stdlib Python script (no npx), so
these run identically in CI.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.plugin_proxy import _sandbox_preflight, invoke_cached_plugin_tool
from superclaw.plugin_runtime_projection import available_plugins
from superclaw.plugins import (
    PluginPackage,
    PluginVerificationError,
    compute_package_digest,
    load_plugin_package,
    verify_plugin_package,
)

# A minimal MCP stdio server: initialize + tools/call for echo / boom / slow.
_FAKE_MCP_SERVER = '''\
import json, sys, time
def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid, method = msg.get("id"), msg.get("method")
    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2025-06-18", "serverInfo": {"name": "fake", "version": "1"}, "capabilities": {}}})
    elif method and method.startswith("notifications/"):
        continue
    elif method == "tools/call":
        params = msg.get("params", {})
        name, args = params.get("name"), params.get("arguments", {})
        if name == "echo":
            emit({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "Echo: " + str(args.get("message", ""))}], "isError": False}})
        elif name == "boom":
            emit({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "tool failed"}], "isError": True}})
        elif name == "slow":
            time.sleep(5)
            emit({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "late"}], "isError": False}})
        elif name == "weird":
            # Valid JSON but NOT a JSON-RPC object, then exit (no real reply): the
            # client must skip the non-dict line and fail closed as "no response".
            sys.stdout.write(json.dumps([1, 2, 3]) + "\\n"); sys.stdout.flush()
            break
        else:
            emit({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown tool"}})
'''

_ECHO_TOOL = {
    "name": "echo",
    "description": "Echoes the input message.",
    "input_schema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
    "output_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {"type": "string"},
            "structured": {"type": ["object", "array", "null"]},
            "block_types": {"type": "array", "items": {"type": "string"}},
            "is_error": {"type": "boolean"},
        },
        "required": ["text", "is_error"],
    },
}


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign(plugin_dir: Path, private_key: Ed25519PrivateKey) -> None:
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(plugin_dir))
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _build_external_mcp_plugin(
    tmp_path: Path,
    monkeypatch,
    *,
    plugin_id: str = "superclaw.fake-mcp",
    command: str | None = None,
    transport: str = "stdio",
    tools: list[dict] | None = None,
    tool_timeout_ms: int = 30000,
    server_args: list[str] | None = None,
    root_public_key: str | None = None,
) -> Path:
    """Create + root-sign a curated external_mcp plugin and cache it.

    Signs with a fresh keypair and installs that key's public half as the product
    ROOT key (``SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY``) — which is exactly how a curated
    first-party (``superclaw.*``) plugin is trusted: signed by the product root key,
    NOT a caller-supplied key (classify_signer only honors the env root). Pass
    ``root_public_key`` to install a DIFFERENT root and exercise rejection.
    """
    server_path = tmp_path / "fake_mcp_server.py"
    server_path.write_text(_FAKE_MCP_SERVER, encoding="utf-8")
    plugin_dir = tmp_path / "src"
    plugin_dir.mkdir()
    manifest = {
        "schema_version": "0.1.0",
        "id": plugin_id,
        "name": "Fake External MCP",
        "version": "0.1.0",
        "summary": "Curated external MCP plugin under test.",
        "source": {"type": "first_party", "clawhunt_problem_id": None, "developer_id": "superclaw"},
        "runtime": {
            "type": "external_mcp",
            # Bare launcher name resolved on PATH (the stdlib-only fake server runs
            # under any python3); absolute sys.executable is intentionally rejected.
            "command": command if command is not None else "python3",
            "args": server_args if server_args is not None else [str(server_path)],
            "transport": transport,
            "mcp_protocol_versions": ["2025-06-18"],
            "platforms": ["darwin-arm64", "linux-x64", "win32-x64"],
        },
        "tools": tools if tools is not None else [_ECHO_TOOL],
        "permissions": {"filesystem": [], "network": [], "environment": []},
        "acceptance": {"level": "L1", "tests": [], "evidence_fixtures": [], "latency_budget_ms": 60000},
        "commerce": {"pricing_model": "free", "metering": "none"},
        "limits": {"tool_timeout_ms": tool_timeout_ms},
        "provenance": {"build_type": "first_party", "package_digest": "", "signature": ""},
    }
    (plugin_dir / "superclaw-plugin.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    private_key, public_key = _keypair()
    _sign(plugin_dir, private_key)
    cache_root = tmp_path / "cache"
    # Install the ROOT env key BEFORE verify: external_mcp is curated-only, so the
    # install/verify face (like the runtime gate) requires a ROOT signer. The happy
    # path signs with the key that is the env root.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", root_public_key or public_key)
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    return cache_root


def _invoke(cache_root: Path, tmp_path: Path, plugin_id: str, tool: str, payload: dict, *, public_key: str | None = None):
    # public_key defaults to None so trust keys off the env root (the real curated
    # path). A caller-supplied public_key must NOT be able to admit external_mcp.
    return invoke_cached_plugin_tool(
        plugin_id,
        tool,
        payload,
        cache_root=cache_root,
        public_key=public_key,
        entitlement_file=tmp_path / "entitlements.json",
        policy_file=tmp_path / "policy.json",
        artifact_dir=tmp_path / "artifacts",
    )


def test_external_mcp_echo_through_full_proxy(tmp_path: Path, monkeypatch):
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch)
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "echo", {"message": "hi-there"})
    assert result.ok is True
    assert result.model_response["text"] == "Echo: hi-there"
    assert result.model_response["is_error"] is False


def test_external_mcp_in_band_tool_error_is_returned_to_model(tmp_path: Path, monkeypatch):
    # MCP tool-level error (isError) is a successful protocol exchange: the model
    # must still SEE the error content, so the proxy call succeeds with is_error.
    boom = {**_ECHO_TOOL, "name": "boom"}
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, tools=[boom])
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "boom", {"message": "x"})
    assert result.ok is True
    assert result.model_response["is_error"] is True
    assert result.model_response["text"] == "tool failed"


def test_external_mcp_launcher_not_found_fails_closed(tmp_path: Path, monkeypatch):
    cache_root = _build_external_mcp_plugin(
        tmp_path, monkeypatch, command="superclaw-no-such-launcher-xyz", server_args=["irrelevant"]
    )
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "echo", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_RUNTIME_ERROR"


def test_external_mcp_unsupported_transport_fails_closed(tmp_path: Path, monkeypatch):
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, transport="sse")
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "echo", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_RUNTIME_ERROR"


def test_external_mcp_timeout_fails_closed(tmp_path: Path, monkeypatch):
    slow = {**_ECHO_TOOL, "name": "slow"}
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, tools=[slow], tool_timeout_ms=500)
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "slow", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_TIMEOUT"


def test_external_mcp_non_root_signer_rejected_at_install(tmp_path: Path, monkeypatch):
    # external_mcp is CURATED-ONLY: it must be product root-signed regardless of
    # namespace. The install/verify face enforces the SAME rule as the runtime gate
    # (one source of truth — no install-vs-runtime split): a non-reserved id signed
    # by a non-root key is rejected at verify EVEN when the caller supplies the
    # matching public_key (which would otherwise pass the generic signature gate).
    signer, signer_public = _keypair()
    _root, root_public = _keypair()
    server_path = tmp_path / "fake_mcp_server.py"
    server_path.write_text(_FAKE_MCP_SERVER, encoding="utf-8")
    plugin_dir = tmp_path / "src"
    plugin_dir.mkdir()
    manifest = {
        "schema_version": "0.1.0",
        "id": "developer.foo-mcp",
        "name": "Dev External MCP",
        "version": "0.1.0",
        "summary": "Non-first-party external MCP that must not install unless root-signed.",
        "source": {"type": "developer_upload", "clawhunt_problem_id": None, "developer_id": "dev"},
        "runtime": {
            "type": "external_mcp",
            "command": "python3",
            "args": [str(server_path)],
            "transport": "stdio",
            "mcp_protocol_versions": ["2025-06-18"],
            "platforms": ["darwin-arm64", "linux-x64"],
        },
        "tools": [_ECHO_TOOL],
        "permissions": {"filesystem": [], "network": [], "environment": []},
        "acceptance": {"level": "L1", "tests": [], "evidence_fixtures": [], "latency_budget_ms": 60000},
        "commerce": {"pricing_model": "free", "metering": "none"},
        "limits": {"tool_timeout_ms": 30000},
        "provenance": {"build_type": "developer_upload", "package_digest": "", "signature": ""},
    }
    (plugin_dir / "superclaw-plugin.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _sign(plugin_dir, signer)
    # Env root is a DIFFERENT key than the signer; passing the signer's own
    # public_key would pass the generic signature gate, but external_mcp keys off
    # the env root only — so install/verify must fail closed.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", root_public)
    with pytest.raises(PluginVerificationError, match="root-signed"):
        verify_plugin_package(plugin_dir, public_key=signer_public, cache_root=tmp_path / "cache")


def test_external_mcp_non_dict_json_reply_fails_closed(tmp_path: Path, monkeypatch):
    # A valid-but-non-dict JSON line (e.g. [1,2,3]) must never crash the exchange
    # into a silent empty success — it fails closed as "no response".
    weird = {**_ECHO_TOOL, "name": "weird"}
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, tools=[weird])
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "weird", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_RUNTIME_ERROR"


def test_external_mcp_path_bearing_command_rejected(tmp_path: Path, monkeypatch):
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, command="/usr/bin/python3")
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "echo", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_RUNTIME_ERROR"


def test_external_mcp_non_allowlisted_launcher_rejected(tmp_path: Path, monkeypatch):
    # Defense in depth atop root-only: a curated manifest may only launch a known
    # MCP server launcher, never an arbitrary PATH binary (e.g. bash/curl).
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch, command="bash", server_args=["-c", "true"])
    result = _invoke(cache_root, tmp_path, "superclaw.fake-mcp", "echo", {"message": "x"})
    assert result.ok is False
    assert result.model_response["error"]["code"] == "PLUGIN_RUNTIME_ERROR"


def test_external_mcp_tool_is_projected_to_agent(tmp_path: Path, monkeypatch):
    cache_root = _build_external_mcp_plugin(tmp_path, monkeypatch)
    plugins = available_plugins(
        cache_root=cache_root,
        entitlement_file=tmp_path / "entitlements.json",
        policy_file=tmp_path / "policy.json",
    )
    assert len(plugins) == 1
    assert plugins[0].plugin_id == "superclaw.fake-mcp"
    tool_names = {t.tool_name for t in plugins[0].tools}
    assert "echo" in tool_names


def test_sandbox_preflight_skips_external_mcp(tmp_path: Path):
    # external_mcp has no in-package entrypoint; the script-sandbox preflight must
    # no-op rather than KeyError on the missing entrypoint.
    manifest = {"runtime": {"type": "external_mcp", "command": "x", "args": [], "transport": "stdio"}}
    package = PluginPackage(source=tmp_path, root=tmp_path, manifest=manifest)
    assert _sandbox_preflight(package) == {}
