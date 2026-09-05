from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from superclaw.environment import superclaw_data_path
from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION, default_entitlement_file, default_policy_file, invoke_cached_plugin_tool
from superclaw.plugins import MANIFEST_NAME, PluginPackage, PluginVerificationError, default_revocation_file, load_plugin_package, plugin_cache_root


MCP_PROTOCOL_VERSION = "2025-06-18"
TOOL_PREFIX = "superclaw"


@dataclass(frozen=True)
class PluginMcpProxyOptions:
    plugin_id: str
    version: str | None = None
    entitlement_file: Path = field(default_factory=default_entitlement_file)
    revocation_file: Path = field(default_factory=default_revocation_file)
    policy_file: Path = field(default_factory=default_policy_file)
    artifact_dir: Path = field(default_factory=lambda: superclaw_data_path("artifacts", "plugins"))
    run_id: str = "plugin_mcp_proxy"
    cache_root: Path | None = None
    public_key: str | None = None
    runtime_version: str = DEFAULT_RUNTIME_VERSION
    # Per-agent equipment narrowing (Agent Team Kernel §2.6 item 4). None = no
    # narrowing; a set is enforced fail-closed at the invoke choke point.
    granted_plugin_ids: frozenset[str] | None = None


def project_plugin_tools(plugin_id: str, *, version: str | None = None, cache_root: Path | None = None) -> list[dict[str, Any]]:
    """Return the model-visible tool projection for an installed plugin.

    The projection intentionally excludes sidecar entrypoints, cache paths,
    entitlement files, signing internals, and local credential names.
    """
    package = _load_cached_package(plugin_id, version=version, cache_root=cache_root)
    try:
        return [
            {
                "name": str(tool["name"]),
                "description": str(tool["description"]),
                "inputSchema": tool["input_schema"],
            }
            for tool in package.manifest.get("tools", [])
        ]
    finally:
        package.cleanup()


def projected_tool_name(plugin_id: str, tool_name: str) -> str:
    return f"{TOOL_PREFIX}__{_safe_tool_segment(plugin_id)}__{tool_name}"


def build_mcp_config(plugin_id: str, *, version: str | None = None, server_name: str | None = None, python_executable: str | None = None, runtime_version: str = DEFAULT_RUNTIME_VERSION) -> dict[str, Any]:
    """Build an agent-facing MCP config that points only to SuperClaw's proxy."""
    name = server_name or f"superclaw-{plugin_id.replace('.', '-')}"
    args = ["-m", "superclaw.plugin_mcp_proxy", "serve", "--plugin-id", plugin_id]
    if version:
        args.extend(["--version", version])
    if runtime_version != DEFAULT_RUNTIME_VERSION:
        args.extend(["--runtime-version", runtime_version])
    return {
        "mcpServers": {
            name: {
                "command": python_executable or sys.executable,
                "args": args,
            }
        }
    }


class PluginMcpProxyServer:
    def __init__(self, options: PluginMcpProxyOptions):
        self.options = options

    def _grant_denied(self) -> bool:
        """True when this proxy's single plugin is not in the per-agent grant.

        A single-plugin proxy fronts one fixed ``plugin_id``; if it is not granted
        the server must expose NOTHING and route nothing. This is evaluated BEFORE
        any ``project_plugin_tools`` / ``_load_cached_package`` so an un-granted id
        triggers no package load / tool projection / signature / entitlement side
        channel — parity with the aggregate catalog narrowing and the
        ``invoke_cached_plugin_tool`` choke point. ``granted_plugin_ids is None``
        means no narrowing (operator / non-team path), so nothing is denied.
        """
        granted = self.options.granted_plugin_ids
        return granted is not None and self.options.plugin_id not in granted

    def handle_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        message_id = message.get("id")
        if message_id is None:
            return None
        method = str(message.get("method") or "")
        if method == "initialize":
            return self._response(
                message_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "superclaw-plugin-proxy", "version": "0.1.0"},
                },
            )
        if method == "tools/list":
            return self._response(message_id, {"tools": self._projected_tools()})
        if method == "tools/call":
            params = message.get("params") or {}
            projected_name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return self._error(message_id, -32602, "tools/call arguments must be an object")
            # Only projected (namespaced) names are the callable surface. A RAW
            # manifest tool name supplied directly is rejected (it must not bypass
            # the projection); any other unknown name still falls through to a
            # graceful PLUGIN_TOOL_NOT_DECLARED from the proxy (with evidence).
            route = self._tool_route()
            if projected_name not in route and projected_name in set(route.values()):
                return self._error(message_id, -32602, "unknown tool")
            tool_name = route.get(projected_name) or projected_name
            result = invoke_cached_plugin_tool(
                self.options.plugin_id,
                tool_name,
                arguments,
                version=self.options.version,
                cache_root=self.options.cache_root,
                entitlement_file=self.options.entitlement_file,
                revocation_file=self.options.revocation_file,
                policy_file=self.options.policy_file,
                public_key=self.options.public_key,
                artifact_dir=self.options.artifact_dir,
                run_id=self.options.run_id,
                runtime_version=self.options.runtime_version,
                granted_plugin_ids=self.options.granted_plugin_ids,
            )
            content = [{"type": "text", "text": json.dumps(result.model_response, ensure_ascii=False, sort_keys=True)}]
            content.extend(_image_content_blocks(result.images))
            return self._response(
                message_id,
                {"content": content, "isError": not result.ok},
            )
        return self._error(message_id, -32601, f"unsupported method: {method}")

    def _projected_tools(self) -> list[dict[str, Any]]:
        if self._grant_denied():
            # Un-granted plugin → project nothing (fail-closed, no package load).
            return []
        return [
            {**tool, "name": projected_tool_name(self.options.plugin_id, str(tool["name"]))}
            for tool in project_plugin_tools(self.options.plugin_id, version=self.options.version, cache_root=self.options.cache_root)
        ]

    def _tool_route(self) -> dict[str, str]:
        if self._grant_denied():
            # Un-granted plugin → empty route (no package load to build it). A
            # tools/call then falls to the invoke choke point, which returns
            # PLUGIN_NOT_GRANTED before any load.
            return {}
        return {
            projected_tool_name(self.options.plugin_id, str(tool["name"])): str(tool["name"])
            for tool in project_plugin_tools(self.options.plugin_id, version=self.options.version, cache_root=self.options.cache_root)
        }

    def _response(self, message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": message_id, "result": result}

    def _error(self, message_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def serve_stdio(options: PluginMcpProxyOptions, *, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    server = PluginMcpProxyServer(options)
    _serve_loop(server, stdin=stdin, stdout=stdout)


def _serve_loop(server: Any, *, stdin: TextIO, stdout: TextIO) -> None:
    for line in stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("message must be a JSON object")
            response = server.handle_message(message)
        except Exception as exc:  # keep stdio server alive for malformed client frames
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False, sort_keys=True) + "\n")
            stdout.flush()


# ---------------------------------------------------------------------------
# Aggregate proxy: one server process exposing many plugins, with a dispatch
# meta-tool surface that keeps the model's tool list (and thus context) flat
# regardless of how many plugins/tools are installed.
# ---------------------------------------------------------------------------

META_LIST_TOOLS = f"{TOOL_PREFIX}__list_tools"
META_DESCRIBE_TOOL = f"{TOOL_PREFIX}__describe_tool"
META_CALL_TOOL = f"{TOOL_PREFIX}__call_tool"

_META_TOOL_DEFS = [
    {
        "name": META_LIST_TOOLS,
        "description": "List SuperClaw plugin tools available to you (name, plugin, short description). Call this first to discover capabilities.",
        "inputSchema": {
            "type": "object",
            "properties": {"plugin_id": {"type": "string", "description": "Optional: filter to one plugin id."}},
            "additionalProperties": False,
        },
    },
    {
        "name": META_DESCRIBE_TOOL,
        "description": "Get the full input schema and description for one SuperClaw plugin tool (use the name from list_tools).",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": META_CALL_TOOL,
        "description": "Call a SuperClaw plugin tool by name with its arguments (use describe_tool to learn the arguments).",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "arguments": {"type": "object"}},
            "required": ["name", "arguments"],
            "additionalProperties": True,
        },
    },
]


@dataclass(frozen=True)
class AggregatePluginMcpProxyOptions:
    # Each entry is (plugin_id, version|None). This snapshot is taken at startup;
    # call-time still re-validates through invoke_cached_plugin_tool (defense in depth).
    plugins: tuple[tuple[str, str | None], ...]
    mode: str = "dispatch"  # "dispatch" (3 meta-tools) or "full" (every tool exposed)
    entitlement_file: Path = field(default_factory=default_entitlement_file)
    revocation_file: Path = field(default_factory=default_revocation_file)
    policy_file: Path = field(default_factory=default_policy_file)
    artifact_dir: Path = field(default_factory=lambda: superclaw_data_path("artifacts", "plugins"))
    run_id: str = "plugin_mcp_proxy_aggregate"
    cache_root: Path | None = None
    public_key: str | None = None
    runtime_version: str = DEFAULT_RUNTIME_VERSION
    # Per-agent equipment narrowing (Agent Team Kernel §2.6 item 4). None = no
    # narrowing; a set is enforced fail-closed at the invoke choke point AND used
    # at startup to assert ``plugins ⊆ granted`` (snapshot-tamper / generation-bug
    # guard).
    granted_plugin_ids: frozenset[str] | None = None


def _short_description(text: str, *, limit: int = 140) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


class AggregatePluginMcpProxyServer:
    """MCP server that fronts many cached plugins from a single process.

    The tool catalog is built once at construction (no per-request disk reads).
    In ``dispatch`` mode the model only ever sees three meta-tools; tool schemas
    are fetched on demand via ``describe_tool``. In ``full`` mode every projected
    tool is exposed directly (higher context cost, kept as an escape hatch).
    """

    def __init__(self, options: AggregatePluginMcpProxyOptions):
        self.options = options
        self._catalog: list[dict[str, Any]] = []          # {name, plugin_id, tool_name, description}
        self._schema_by_name: dict[str, Any] = {}          # projected_name -> inputSchema
        self._full_by_name: dict[str, dict[str, Any]] = {} # projected_name -> full projected tool
        self._route: dict[str, tuple[str, str | None, str]] = {}  # name -> (plugin_id, version, tool_name)
        # Per-run warm cache: memoizes the expensive immutable integrity check
        # (digest + signature) per plugin for this process's lifetime. Lives and
        # dies with this per-run proxy process, so isolation is preserved;
        # revocation/entitlement/policy are still re-checked on every call.
        self._verification_cache: dict[tuple[str, str], bool] = {}
        self._build_catalog()

    def _build_catalog(self) -> None:
        granted = self.options.granted_plugin_ids
        for plugin_id, version in self.options.plugins:
            if granted is not None and plugin_id not in granted:
                # Defense in depth: never catalog/load an un-granted plugin even if
                # one slipped into options.plugins (the main path pre-narrows, but a
                # direct construction must fail-closed at the class level too).
                continue
            try:
                tools = project_plugin_tools(plugin_id, version=version, cache_root=self.options.cache_root)
            except Exception:
                # A plugin that fails to load is simply not offered (fail-closed).
                continue
            for tool in tools:
                tool_name = str(tool["name"])
                name = projected_tool_name(plugin_id, tool_name)
                self._catalog.append(
                    {
                        "name": name,
                        "plugin_id": plugin_id,
                        "tool_name": tool_name,
                        "description": _short_description(tool.get("description", "")),
                    }
                )
                self._schema_by_name[name] = tool.get("inputSchema")
                self._full_by_name[name] = {**tool, "name": name}
                self._route[name] = (plugin_id, version, tool_name)

    def handle_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        message_id = message.get("id")
        if message_id is None:
            return None
        method = str(message.get("method") or "")
        if method == "initialize":
            return _ok(
                message_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "superclaw-plugin-proxy-aggregate", "version": "0.1.0"},
                },
            )
        if method == "tools/list":
            if self.options.mode == "full":
                return _ok(message_id, {"tools": list(self._full_by_name.values())})
            return _ok(message_id, {"tools": _META_TOOL_DEFS})
        if method == "tools/call":
            return self._handle_call(message_id, message.get("params") or {})
        return _err(message_id, -32601, f"unsupported method: {method}")

    def _handle_call(self, message_id: Any, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _err(message_id, -32602, "tools/call arguments must be an object")

        if self.options.mode != "full":
            if name == META_LIST_TOOLS:
                plugin_filter = arguments.get("plugin_id")
                rows = [
                    {"name": row["name"], "plugin_id": row["plugin_id"], "description": row["description"]}
                    for row in self._catalog
                    if not plugin_filter or row["plugin_id"] == plugin_filter
                ]
                return _content(message_id, {"tools": rows}, is_error=False)
            if name == META_DESCRIBE_TOOL:
                target = str(arguments.get("name") or "")
                if target not in self._full_by_name:
                    return _content(message_id, {"error": "unknown tool", "name": target}, is_error=True)
                tool = self._full_by_name[target]
                return _content(
                    message_id,
                    {"name": target, "description": tool.get("description"), "inputSchema": tool.get("inputSchema")},
                    is_error=False,
                )
            if name == META_CALL_TOOL:
                return self._invoke(message_id, str(arguments.get("name") or ""), arguments.get("arguments") or {})
            return _err(message_id, -32601, f"unknown meta tool: {name}")

        # full mode: the projected tool names are the callable surface directly.
        return self._invoke(message_id, name, arguments)

    def _invoke(self, message_id: Any, name: str, tool_arguments: Any) -> dict[str, Any]:
        if not isinstance(tool_arguments, dict):
            return _err(message_id, -32602, "arguments must be an object")
        route = self._route.get(name)
        if route is None:
            return _content(message_id, {"error": "unknown tool", "name": name}, is_error=True)
        plugin_id, version, tool_name = route
        result = invoke_cached_plugin_tool(
            plugin_id,
            tool_name,
            tool_arguments,
            version=version,
            cache_root=self.options.cache_root,
            entitlement_file=self.options.entitlement_file,
            revocation_file=self.options.revocation_file,
            policy_file=self.options.policy_file,
            public_key=self.options.public_key,
            artifact_dir=self.options.artifact_dir,
            run_id=self.options.run_id,
            runtime_version=self.options.runtime_version,
            verification_cache=self._verification_cache,
            granted_plugin_ids=self.options.granted_plugin_ids,
        )
        return _content(message_id, result.model_response, is_error=not result.ok, images=result.images)


def _ok(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def _err(message_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def _image_content_blocks(images: Any) -> list[dict[str, Any]]:
    """Convert validated plugin images into native MCP image content blocks."""
    blocks: list[dict[str, Any]] = []
    for image in images or ():
        if not isinstance(image, dict):
            continue
        data = image.get("data")
        if not isinstance(data, str) or not data:
            continue
        blocks.append(
            {
                "type": "image",
                "data": data,
                "mimeType": str(image.get("mime_type") or "image/png"),
            }
        )
    return blocks


def _content(
    message_id: Any,
    payload: dict[str, Any],
    *,
    is_error: bool,
    images: Any = (),
) -> dict[str, Any]:
    content = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, sort_keys=True)}]
    content.extend(_image_content_blocks(images))
    return _ok(message_id, {"content": content, "isError": is_error})


def serve_aggregate_stdio(options: AggregatePluginMcpProxyOptions, *, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    _serve_loop(AggregatePluginMcpProxyServer(options), stdin=stdin, stdout=stdout)


def build_aggregate_mcp_config(
    plugin_set_path: str | Path,
    *,
    server_name: str = "superclaw",
    mode: str = "dispatch",
    python_executable: str | None = None,
    allowed_plugin_ids: frozenset[str] | None = None,
) -> dict[str, Any]:
    """One MCP server entry that fronts every available plugin via the aggregate proxy.

    ``allowed_plugin_ids`` is the per-agent equipment grant. When not None it is
    injected as ``--allowed-plugins`` (comma-separated, empty string for an empty
    grant ⇒ fail-closed). This argv is the AUTHORITATIVE narrowing source: it
    cannot be tampered with once the proxy process has started, unlike the
    self-contained snapshot file (which a full-shell agent could rewrite).
    """
    args = [
        "-m", "superclaw.plugin_mcp_proxy", "serve-aggregate",
        "--plugin-set", os.fspath(plugin_set_path),
        "--mode", mode,
    ]
    if allowed_plugin_ids is not None:
        args.extend(["--allowed-plugins", ",".join(sorted(allowed_plugin_ids))])
    return {
        "mcpServers": {
            server_name: {
                "command": python_executable or sys.executable,
                "args": args,
            }
        }
    }


def _load_plugin_set(path: Path) -> dict[str, Any]:
    """Parse a self-contained plugin-set snapshot.

    The snapshot carries everything the aggregate proxy needs so it does not
    depend on environment variables being propagated by the spawning agent
    (codex/claude may not pass env through to MCP child processes): the plugin
    list, mode, the resolved cache root, and the (public) verification key.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    plugins: list[tuple[str, str | None]] = []
    for entry in payload.get("plugins", []):
        if isinstance(entry, dict) and entry.get("id"):
            plugins.append((str(entry["id"]), str(entry["version"]) if entry.get("version") else None))
    # Per-agent equipment narrowing carried in the snapshot. This is a SNAPSHOT
    # fallback, NOT an authority: the snapshot lives in the run artifact dir and a
    # full-shell agent could rewrite it. The authoritative source is the
    # ``--allowed-plugins`` CLI argument the orchestrator injects at launch (an
    # already-started process's argv cannot be tampered with). A missing field ⇒
    # None (no narrowing); a list ⇒ the granted set.
    raw_granted = payload.get("granted_plugin_ids")
    if raw_granted is None:
        # Field absent ⇒ no narrowing (a non-team projection wrote no grant).
        granted_plugin_ids: frozenset[str] | None = None
    elif isinstance(raw_granted, (list, tuple, set, frozenset)):
        # A mixed-malformed collection (any dirty element) fails closed — never
        # silently filter dirty grant into a usable set (laundering parity with
        # _granted_plugin_ids). ['x', 5, ''] ⇒ frozenset(), not {'x'}.
        if all(isinstance(pid, str) and pid.strip() for pid in raw_granted):
            granted_plugin_ids = frozenset(raw_granted)
        else:
            granted_plugin_ids = frozenset()
    else:
        # Present but malformed (e.g. tampered to "all" / 123) ⇒ fail-closed to an
        # empty grant, never fall back to None (which would mean no narrowing).
        granted_plugin_ids = frozenset()
    return {
        "plugins": tuple(plugins),
        "mode": str(payload["mode"]) if payload.get("mode") else None,
        "cache_root": str(payload["cache_root"]) if payload.get("cache_root") else None,
        "public_key": str(payload["public_key"]) if payload.get("public_key") else None,
        "local_dev_trust": bool(payload.get("local_dev_trust", False)),
        "granted_plugin_ids": granted_plugin_ids,
        # The runtime version the gate used to decide what to project; the proxy
        # must execute under the same value so the projection and execution gates
        # never disagree. Self-contained in the snapshot (env isn't forwarded).
        "runtime_version": str(payload["runtime_version"]) if payload.get("runtime_version") else DEFAULT_RUNTIME_VERSION,
    }


def _load_cached_package(plugin_id: str, *, version: str | None, cache_root: Path | None) -> PluginPackage:
    root = plugin_cache_root(cache_root) / plugin_id
    if version:
        package_root = root / version
    else:
        versions = sorted(path for path in root.iterdir() if path.is_dir()) if root.exists() else []
        package_root = versions[-1] if versions else None
    if not package_root or not (package_root / MANIFEST_NAME).exists():
        raise PluginVerificationError(f"plugin not installed: {plugin_id}")
    return load_plugin_package(package_root)


def _safe_tool_segment(value: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in value)


def _parse_allowed_plugins(raw: str | None) -> frozenset[str] | None:
    """Parse the authoritative ``--allowed-plugins`` argv into a grant set.

    ``None`` (flag absent) ⇒ no CLI-level narrowing (fall back to the snapshot).
    An explicit value (including the empty string for an empty grant) ⇒ a set,
    fail-closed: an empty grant narrows to nothing.
    """
    if raw is None:
        return None
    return frozenset(token.strip() for token in raw.split(",") if token.strip())


def _resolve_effective_grant(
    cli_allowed: frozenset[str] | None, snapshot_granted: frozenset[str] | None
) -> frozenset[str] | None:
    """The CLI ``--allowed-plugins`` argv is authoritative; the snapshot field is
    only a fallback. CLI wins whenever present (including an empty grant)."""
    return cli_allowed if cli_allowed is not None else snapshot_granted


def _narrow_plugins_to_grant(
    plugins: tuple[tuple[str, str | None], ...], granted: frozenset[str] | None
) -> tuple[tuple[tuple[str, str | None], ...], list[str]]:
    """Enforce the startup invariant ``plugins ⊆ granted``.

    Returns ``(kept, dropped)``. ``granted=None`` keeps everything (no narrowing).
    Otherwise any plugin not covered by the grant is dropped — a generation bug or
    a tampered snapshot must never widen the runnable set past the grant.
    """
    if granted is None:
        return tuple(plugins), []
    kept = tuple(entry for entry in plugins if entry[0] in granted)
    dropped = [entry[0] for entry in plugins if entry[0] not in granted]
    return kept, dropped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m superclaw.plugin_mcp_proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve_parser = subparsers.add_parser("serve")
    serve_parser.add_argument("--plugin-id", required=True)
    serve_parser.add_argument("--version")
    serve_parser.add_argument("--entitlement-file", default=os.fspath(default_entitlement_file()))
    serve_parser.add_argument("--revocation-file", default=os.fspath(default_revocation_file()))
    serve_parser.add_argument("--policy-file", default=os.fspath(default_policy_file()))
    serve_parser.add_argument("--artifact-dir", default=str(superclaw_data_path("artifacts", "plugins")))
    serve_parser.add_argument("--run-id", default="plugin_mcp_proxy")
    serve_parser.add_argument("--runtime-version", default=DEFAULT_RUNTIME_VERSION)
    serve_parser.add_argument("--allowed-plugins", default=None, help="Authoritative per-agent equipment grant (comma-separated plugin ids; empty string = fail-closed empty grant). Enforced at the invoke choke point.")

    agg_parser = subparsers.add_parser("serve-aggregate")
    agg_parser.add_argument("--plugin-set", required=True, help="JSON file: {\"plugins\":[{\"id\":..,\"version\":..}], \"mode\":..}")
    agg_parser.add_argument("--mode", default=None, choices=["dispatch", "full"])
    agg_parser.add_argument("--entitlement-file", default=os.fspath(default_entitlement_file()))
    agg_parser.add_argument("--revocation-file", default=os.fspath(default_revocation_file()))
    agg_parser.add_argument("--policy-file", default=os.fspath(default_policy_file()))
    agg_parser.add_argument("--artifact-dir", default=str(superclaw_data_path("artifacts", "plugins")))
    agg_parser.add_argument("--run-id", default="plugin_mcp_proxy_aggregate")
    agg_parser.add_argument("--allowed-plugins", default=None, help="Authoritative per-agent equipment grant (comma-separated plugin ids; empty string = fail-closed empty grant). Overrides the snapshot's granted_plugin_ids and is enforced at the invoke choke point.")

    args = parser.parse_args(argv)
    if args.command == "serve":
        serve_granted = _parse_allowed_plugins(args.allowed_plugins)
        # Startup-layer fail-closed (defense in depth on top of the server's
        # _grant_denied gate): refuse to even start a single proxy fronting a
        # plugin outside the grant, so an un-granted id never reaches a live MCP
        # surface. None ⇒ no narrowing (operator path).
        if serve_granted is not None and args.plugin_id not in serve_granted:
            print(
                f"superclaw.plugin_mcp_proxy: plugin_id {args.plugin_id!r} is not in granted equipment "
                f"(fail-closed; refusing to start): {sorted(serve_granted)}",
                file=sys.stderr,
            )
            return 1
        serve_stdio(
            PluginMcpProxyOptions(
                plugin_id=args.plugin_id,
                version=args.version,
                entitlement_file=Path(args.entitlement_file),
                revocation_file=Path(args.revocation_file),
                policy_file=Path(args.policy_file),
                artifact_dir=Path(args.artifact_dir),
                run_id=args.run_id,
                public_key=os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
                runtime_version=args.runtime_version,
                granted_plugin_ids=serve_granted,
            )
        )
        return 0
    if args.command == "serve-aggregate":
        plugin_set = _load_plugin_set(Path(args.plugin_set))
        # The spawning agent (codex/claude) may not forward env to MCP children,
        # so honor the snapshot's local-dev trust decision by re-exposing it in
        # this subprocess's environment, where the verification helpers read it.
        if plugin_set.get("local_dev_trust"):
            os.environ["SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST"] = "1"
        # Per-agent equipment grant: the authoritative source is the
        # ``--allowed-plugins`` argv (tamper-proof once this process started); the
        # snapshot's ``granted_plugin_ids`` is only a fallback. CLI wins when present.
        granted = _resolve_effective_grant(
            _parse_allowed_plugins(args.allowed_plugins), plugin_set["granted_plugin_ids"]
        )
        # Startup invariant ``plugins ⊆ granted`` (fail-closed; audit any drop).
        plugins, dropped = _narrow_plugins_to_grant(plugin_set["plugins"], granted)
        if dropped:
            print(
                f"superclaw.plugin_mcp_proxy: dropping {len(dropped)} plugin(s) not in granted equipment "
                f"(fail-closed plugins⊆granted): {sorted(set(dropped))}",
                file=sys.stderr,
            )
        serve_aggregate_stdio(
            AggregatePluginMcpProxyOptions(
                plugins=plugins,
                mode=args.mode or plugin_set["mode"] or "dispatch",
                entitlement_file=Path(args.entitlement_file),
                revocation_file=Path(args.revocation_file),
                policy_file=Path(args.policy_file),
                artifact_dir=Path(args.artifact_dir),
                run_id=args.run_id,
                # Self-contained snapshot first, env only as a fallback — the
                # spawning agent may not forward env to MCP child processes.
                cache_root=Path(plugin_set["cache_root"]) if plugin_set["cache_root"] else None,
                public_key=plugin_set["public_key"] or os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
                runtime_version=plugin_set["runtime_version"],
                granted_plugin_ids=granted,
            )
        )
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
