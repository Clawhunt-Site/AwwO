from __future__ import annotations

import json
import re
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class HarnessCapability:
    harness_id: str
    display_name: str
    skills_native: bool
    agents_native: bool
    commands_native: bool
    plugin_marketplace: bool
    parallel_agents: bool
    tool_allowlist_per_agent: bool
    todowrite: bool
    task_spawn: bool
    mcp_servers: bool
    hooks: bool
    context_file_name: str | None
    context_file_max_lines: int
    skill_body_max_bytes: int
    tool_name_case: str
    bare_model_aliases: bool
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AdaptedArtifact:
    target: str
    name: str
    kind: str
    frontmatter: dict[str, Any]
    body: str
    overflow: str | None = None
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PluginInventory:
    root: str
    plugin_count: int
    agent_count: int
    skill_count: int
    command_count: int
    plugin_details: list[dict[str, Any]]
    warnings: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HarnessEmitReport:
    target: str
    source_root: str
    output_root: str
    plugins: list[str]
    written: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HarnessValidationFinding:
    severity: str
    target: str
    path: str
    message: str
    remediation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HarnessValidationReport:
    target: str
    output_root: str
    checked_files: list[str] = field(default_factory=list)
    findings: list[HarnessValidationFinding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(finding.severity == "error" for finding in self.findings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "output_root": self.output_root,
            "ok": self.ok,
            "checked_files": self.checked_files,
            "findings": [finding.to_dict() for finding in self.findings],
        }


NO_CAP = 0
CODEX_SKILL_CAP_BYTES = 8 * 1024
CODEX_EMIT_BODY_CAP_BYTES = 7400
CONTEXT_FILE_LINE_CAP = 150

READ_ONLY_TOOLS = {
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "ListMcpResources",
    "ReadMcpResource",
    "tool_search",
}
WRITE_TOOLS = {
    "Edit",
    "Write",
    "Bash",
    "NotebookEdit",
    "TodoWrite",
    "Agent",
    "Task",
    "Skill",
    "AskUserQuestion",
    "TaskStop",
}
TERMINAL_TASK_STATUSES = {"completed", "failed", "killed", "cancelled"}
CLAUDE_CODE_TASK_TYPES = {
    "local_bash": {"prefix": "b", "superclaw_lock": "shell", "backgroundable": True},
    "local_agent": {"prefix": "a", "superclaw_lock": "worker", "backgroundable": True},
    "remote_agent": {"prefix": "r", "superclaw_lock": "remote", "backgroundable": True},
    "in_process_teammate": {"prefix": "t", "superclaw_lock": "worker", "backgroundable": True},
    "local_workflow": {"prefix": "w", "superclaw_lock": "workflow", "backgroundable": True},
    "monitor_mcp": {"prefix": "m", "superclaw_lock": "mcp", "backgroundable": True},
    "dream": {"prefix": "d", "superclaw_lock": "worker", "backgroundable": False},
}


HARNESS_CAPABILITIES: dict[str, HarnessCapability] = {
    "claude-code": HarnessCapability(
        harness_id="claude-code",
        display_name="Claude Code",
        skills_native=True,
        agents_native=True,
        commands_native=True,
        plugin_marketplace=True,
        parallel_agents=True,
        tool_allowlist_per_agent=True,
        todowrite=True,
        task_spawn=True,
        mcp_servers=True,
        hooks=True,
        context_file_name="CLAUDE.md",
        context_file_max_lines=CONTEXT_FILE_LINE_CAP,
        skill_body_max_bytes=NO_CAP,
        tool_name_case="CamelCase",
        bare_model_aliases=True,
        notes="Source format for the Agents marketplace. Supports native skills, agents, commands, hooks, MCP, and task spawning.",
    ),
    "codex": HarnessCapability(
        harness_id="codex",
        display_name="OpenAI Codex CLI",
        skills_native=True,
        agents_native=True,
        commands_native=False,
        plugin_marketplace=False,
        parallel_agents=True,
        tool_allowlist_per_agent=False,
        todowrite=False,
        task_spawn=False,
        mcp_servers=True,
        hooks=False,
        context_file_name="AGENTS.md",
        context_file_max_lines=CONTEXT_FILE_LINE_CAP,
        skill_body_max_bytes=CODEX_SKILL_CAP_BYTES,
        tool_name_case="action-verbs",
        bare_model_aliases=False,
        notes="Commands degrade to skills. Agent tool allowlists degrade to sandbox_mode. Skill bodies must fit the 8KB injection cap.",
    ),
    "cursor": HarnessCapability(
        harness_id="cursor",
        display_name="Cursor",
        skills_native=True,
        agents_native=True,
        commands_native=True,
        plugin_marketplace=True,
        parallel_agents=True,
        tool_allowlist_per_agent=False,
        todowrite=False,
        task_spawn=True,
        mcp_servers=True,
        hooks=False,
        context_file_name="AGENTS.md",
        context_file_max_lines=CONTEXT_FILE_LINE_CAP,
        skill_body_max_bytes=NO_CAP,
        tool_name_case="lowercase",
        bare_model_aliases=False,
        notes="Reads Claude-style skill and agent assets, but ignores most per-agent tool restrictions.",
    ),
    "opencode": HarnessCapability(
        harness_id="opencode",
        display_name="OpenCode",
        skills_native=True,
        agents_native=True,
        commands_native=True,
        plugin_marketplace=False,
        parallel_agents=True,
        tool_allowlist_per_agent=True,
        todowrite=True,
        task_spawn=True,
        mcp_servers=True,
        hooks=True,
        context_file_name="AGENTS.md",
        context_file_max_lines=CONTEXT_FILE_LINE_CAP,
        skill_body_max_bytes=NO_CAP,
        tool_name_case="lowercase",
        bare_model_aliases=False,
        notes="Uses strict lowercase tool names and permission blocks rather than Claude tools frontmatter.",
    ),
    "gemini": HarnessCapability(
        harness_id="gemini",
        display_name="Gemini CLI",
        skills_native=True,
        agents_native=True,
        commands_native=True,
        plugin_marketplace=False,
        parallel_agents=True,
        tool_allowlist_per_agent=True,
        todowrite=False,
        task_spawn=True,
        mcp_servers=True,
        hooks=False,
        context_file_name="GEMINI.md",
        context_file_max_lines=CONTEXT_FILE_LINE_CAP,
        skill_body_max_bytes=NO_CAP,
        tool_name_case="lowercase",
        bare_model_aliases=False,
        notes="Uses command TOML and agent references; keep GEMINI.md tight because it is injected every prompt.",
    ),
}


TOOL_NAME_MAPS: dict[str, dict[str, str]] = {
    "claude-code": {},
    "codex": {
        "Read": "open the file",
        "Edit": "edit the file",
        "Write": "create the file",
        "Bash": "run the shell command",
        "Grep": "rg",
        "Glob": "find files matching",
        "WebFetch": "fetch the URL",
        "WebSearch": "search the web",
        "TodoWrite": "track the plan",
        "Agent": "delegate to a worker",
        "Task": "delegate to a worker",
    },
    "cursor": {
        "Read": "read",
        "Edit": "edit",
        "Write": "write",
        "Bash": "run",
        "Grep": "search",
        "Glob": "find",
        "WebFetch": "fetch",
        "WebSearch": "web",
        "TodoWrite": "todo",
        "Agent": "agent",
        "Task": "agent",
    },
    "opencode": {
        "Read": "read",
        "Edit": "edit",
        "Write": "write",
        "Bash": "bash",
        "Grep": "grep",
        "Glob": "glob",
        "WebFetch": "webfetch",
        "WebSearch": "websearch",
        "TodoWrite": "todowrite",
        "Agent": "task",
        "Task": "task",
    },
    "gemini": {
        "Read": "read_file",
        "Edit": "edit_file",
        "Write": "write_file",
        "Bash": "run_shell_command",
        "Grep": "search",
        "Glob": "list_files",
        "WebFetch": "fetch_url",
        "WebSearch": "google_search",
        "TodoWrite": "todo",
        "Agent": "@agent",
        "Task": "@agent",
    },
}


MODEL_ALIASES: dict[str, dict[str, str]] = {
    "claude-code": {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku", "inherit": "inherit"},
    "codex": {"opus": "gpt-5", "sonnet": "gpt-5-mini", "haiku": "gpt-5-nano", "inherit": "gpt-5"},
    "cursor": {"opus": "inherit", "sonnet": "inherit", "haiku": "inherit", "inherit": "inherit"},
    "opencode": {
        "opus": "anthropic/claude-opus-4-7",
        "sonnet": "anthropic/claude-sonnet-4-6",
        "haiku": "anthropic/claude-haiku-4-5-20251001",
        "inherit": "anthropic/claude-sonnet-4-6",
    },
    "gemini": {"opus": "gemini-2.5-pro", "sonnet": "gemini-2.5-pro", "haiku": "gemini-2.5-flash", "inherit": "gemini-2.5-pro"},
}


CLAUDE_ONLY_AGENT_FIELDS = {
    "allowed-tools",
    "color",
    "context",
    "disable-model-invocation",
    "hooks",
    "tools",
    "user-invocable",
}
CLAUDE_ONLY_SKILL_FIELDS = {
    "allowed-tools",
    "agent",
    "context",
    "disable-model-invocation",
    "hooks",
    "model",
    "user-invocable",
}


def harness_matrix() -> dict[str, dict[str, Any]]:
    return {name: capability.to_dict() for name, capability in HARNESS_CAPABILITIES.items()}


def runtime_profile() -> dict[str, Any]:
    return {
        "claude_code_task_types": CLAUDE_CODE_TASK_TYPES,
        "terminal_task_statuses": sorted(TERMINAL_TASK_STATUSES),
        "read_only_tools": sorted(READ_ONLY_TOOLS),
        "write_tools": sorted(WRITE_TOOLS),
        "superclaw_alignment": {
            "task_id_prefixes": "preserved as metadata; SuperClaw still owns run/task ids",
            "tool_orchestration": "read-only tool batches can run concurrently; write or shell tools serialize through resource locks",
            "background_agents": "represented by worker leases, SSE events, and evidence artifacts",
            "context_boundaries": "git/status/user context stays explicit evidence instead of hidden prompt state",
        },
    }


def get_harness_profile(harness_id: str) -> HarnessCapability:
    try:
        return HARNESS_CAPABILITIES[harness_id]
    except KeyError as exc:
        known = ", ".join(sorted(HARNESS_CAPABILITIES))
        raise KeyError(f"unknown harness {harness_id!r}; known: {known}") from exc


def resolve_model(harness_id: str, source_model: str | None) -> tuple[str, str | None]:
    aliases = MODEL_ALIASES.get(harness_id, {})
    source = (source_model or "inherit").strip() or "inherit"
    if source in aliases:
        return aliases[source], None
    fallback = aliases.get("inherit", source)
    return fallback, f"unknown model alias {source!r} for {harness_id}; using {fallback!r}"


def normalize_tools(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    if isinstance(raw, str):
        return [item.strip() for item in _split_inline_list(raw.strip("[] ")) if item.strip()]
    return []


def parse_markdown_with_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    if not content.startswith("---"):
        return {}, content
    end = content.find("\n---", 3)
    if end == -1:
        return {}, content
    block = content[3:end].strip()
    body = content[end + 4 :].lstrip("\n")
    fields: dict[str, Any] = {}
    current_key: str | None = None
    for line in block.splitlines():
        match = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", line)
        if match:
            current_key = match.group(1)
            value = match.group(2).strip()
            if value.startswith("[") and value.endswith("]"):
                fields[current_key] = _split_inline_list(value[1:-1])
            elif value == "":
                fields[current_key] = []
            else:
                fields[current_key] = value.strip('"').strip("'")
            continue
        if current_key and line.startswith(("  - ", "\t- ")):
            existing = fields.get(current_key)
            if not isinstance(existing, list):
                existing = []
                fields[current_key] = existing
            existing.append(line.split("-", 1)[1].strip().strip('"').strip("'"))
        elif current_key and isinstance(fields.get(current_key), str) and line.startswith(("  ", "\t")):
            fields[current_key] = f"{fields[current_key]} {line.strip()}".strip()
    return fields, body


def rewrite_tool_prose(body: str, target: str) -> str:
    mapping = TOOL_NAME_MAPS.get(target, {})
    out = body
    for source, replacement in mapping.items():
        out = re.sub(rf"(?i:\bthe)\s+`?{re.escape(source)}`?\s+tool\b", replacement, out)
        out = re.sub(rf"`{re.escape(source)}`", replacement, out)
    return out


def sandbox_mode_for_tools(frontmatter: dict[str, Any]) -> str:
    if "tools" not in frontmatter:
        return "workspace-write"
    tools = set(normalize_tools(frontmatter.get("tools")))
    return "read-only" if tools.issubset(READ_ONLY_TOOLS) else "workspace-write"


def partition_tool_calls(tool_names: list[str]) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    for tool in tool_names:
        safe = tool in READ_ONLY_TOOLS
        if safe and batches and batches[-1]["is_concurrency_safe"]:
            batches[-1]["tools"].append(tool)
        else:
            batches.append({"is_concurrency_safe": safe, "tools": [tool]})
    return batches


def adapt_agent(
    *,
    plugin: str,
    name: str,
    frontmatter: dict[str, Any],
    body: str,
    target: str = "codex",
) -> AdaptedArtifact:
    profile = get_harness_profile(target)
    agent_id = f"{plugin}__{name}" if plugin else name
    source_model = str(frontmatter.get("model") or "inherit")
    model, model_warning = resolve_model(target, source_model)
    tools = normalize_tools(frontmatter.get("tools"))
    warnings: list[str] = []
    if model_warning:
        warnings.append(model_warning)
    dropped = sorted(key for key in CLAUDE_ONLY_AGENT_FIELDS if key in frontmatter and not profile.tool_allowlist_per_agent)
    if dropped:
        warnings.append(f"dropped unsupported agent fields for {target}: {', '.join(dropped)}")
    if tools and not profile.tool_allowlist_per_agent:
        warnings.append(f"tools frontmatter degraded to {sandbox_mode_for_tools(frontmatter)}")
    developer_instructions = rewrite_tool_prose(body.strip(), target) or str(frontmatter.get("description") or f"{agent_id} subagent.")
    adapted_frontmatter = {
        "name": agent_id,
        "description": str(frontmatter.get("description") or f"{name} from {plugin}"),
        "model": model,
    }
    if target == "codex":
        adapted_frontmatter["sandbox_mode"] = sandbox_mode_for_tools(frontmatter)
    elif tools and profile.tool_allowlist_per_agent:
        adapted_frontmatter["tools"] = [TOOL_NAME_MAPS.get(target, {}).get(tool, tool.lower()) for tool in tools]
    return AdaptedArtifact(
        target=target,
        name=agent_id,
        kind="agent",
        frontmatter=adapted_frontmatter,
        body=developer_instructions,
        warnings=warnings,
        metadata={
            "source_tools": tools,
            "tool_batches": partition_tool_calls(tools),
            "source_model": source_model,
            "task_spawn_supported": profile.task_spawn,
            "hooks_supported": profile.hooks,
        },
    )


def adapt_skill(
    *,
    plugin: str,
    name: str,
    frontmatter: dict[str, Any],
    body: str,
    target: str = "codex",
) -> AdaptedArtifact:
    profile = get_harness_profile(target)
    skill_id = f"{plugin}__{name}" if plugin else name
    warnings: list[str] = []
    dropped = sorted(key for key in CLAUDE_ONLY_SKILL_FIELDS if key in frontmatter)
    adapted_frontmatter = {k: v for k, v in frontmatter.items() if k not in CLAUDE_ONLY_SKILL_FIELDS}
    adapted_frontmatter["name"] = skill_id
    if dropped:
        warnings.append(f"dropped unsupported skill fields for {target}: {', '.join(dropped)}")
    rewritten = rewrite_tool_prose(body.rstrip() + "\n", target)
    cap = CODEX_EMIT_BODY_CAP_BYTES if target == "codex" else profile.skill_body_max_bytes
    head, overflow = split_skill_body(rewritten, cap)
    if overflow:
        warnings.append(f"skill body split for {target} cap: {cap} bytes")
    return AdaptedArtifact(
        target=target,
        name=skill_id,
        kind="skill",
        frontmatter=adapted_frontmatter,
        body=head,
        overflow=overflow,
        warnings=warnings,
        metadata={"source_body_bytes": len(body.encode("utf-8")), "target_body_bytes": len(head.encode("utf-8"))},
    )


def split_skill_body(body: str, cap_bytes: int) -> tuple[str, str | None]:
    if cap_bytes <= 0 or len(body.encode("utf-8")) <= cap_bytes:
        return body, None
    pointer = "\n\n> Detailed reference moved to references/details.md for harness body limits.\n"
    effective = max(0, cap_bytes - len(pointer.encode("utf-8")))
    encoded = body.encode("utf-8")
    cut = _safe_utf8_cut(encoded, effective)
    head = encoded[:cut].decode("utf-8").rstrip() + pointer
    overflow = encoded[cut:].decode("utf-8").lstrip("\n")
    return head, overflow


def inventory_plugins(root: str | Path) -> PluginInventory:
    base = Path(root).expanduser().resolve()
    plugin_root = base / "plugins" if (base / "plugins").is_dir() else base
    warnings: list[str] = []
    details: list[dict[str, Any]] = []
    if not plugin_root.is_dir():
        return PluginInventory(str(base), 0, 0, 0, 0, [], [f"plugin root not found: {plugin_root}"])

    agent_count = 0
    skill_count = 0
    command_count = 0
    for plugin_dir in sorted(path for path in plugin_root.iterdir() if path.is_dir()):
        if "__" in plugin_dir.name:
            warnings.append(f"plugin {plugin_dir.name} contains namespace separator __")
            continue
        manifest = _read_plugin_manifest(plugin_dir)
        agents = sorted((plugin_dir / "agents").glob("*.md")) if (plugin_dir / "agents").is_dir() else []
        skills = sorted((plugin_dir / "skills").glob("*/SKILL.md")) if (plugin_dir / "skills").is_dir() else []
        commands = sorted((plugin_dir / "commands").glob("*.md")) if (plugin_dir / "commands").is_dir() else []
        agent_count += len(agents)
        skill_count += len(skills)
        command_count += len(commands)
        oversized = [
            str(path.relative_to(plugin_dir))
            for path in skills
            if len(path.read_text(encoding="utf-8", errors="replace").encode("utf-8")) > CODEX_SKILL_CAP_BYTES
        ]
        if oversized:
            warnings.append(f"plugin {plugin_dir.name} has {len(oversized)} Codex-oversized skills")
        details.append(
            {
                "name": plugin_dir.name,
                "description": str(manifest.get("description") or ""),
                "version": str(manifest.get("version") or "0.0.0"),
                "agents": len(agents),
                "skills": len(skills),
                "commands": len(commands),
                "codex_oversized_skills": oversized[:20],
            }
        )
    return PluginInventory(
        root=str(plugin_root),
        plugin_count=len(details),
        agent_count=agent_count,
        skill_count=skill_count,
        command_count=command_count,
        plugin_details=details,
        warnings=warnings,
    )


def emit_harness_artifacts(
    source_root: str | Path,
    output_root: str | Path,
    *,
    target: str,
    plugins: list[str] | None = None,
) -> HarnessEmitReport:
    """Emit harness-native artifacts from an Agents-style source tree.

    The source tree is read-only. All generated files are constrained under
    output_root so callers can safely use a scratch directory for validation.
    """
    get_harness_profile(target)
    source_plugins = _plugin_root(source_root)
    output = Path(output_root).expanduser().resolve()
    selected = set(plugins or [])
    written: list[str] = []
    skipped: list[str] = []
    warnings: list[str] = []
    plugin_summaries: list[dict[str, Any]] = []

    if not source_plugins.is_dir():
        return HarnessEmitReport(
            target=target,
            source_root=str(source_plugins),
            output_root=str(output),
            plugins=[],
            warnings=[f"plugin root not found: {source_plugins}"],
        )

    for plugin_dir in sorted(path for path in source_plugins.iterdir() if path.is_dir()):
        if selected and plugin_dir.name not in selected:
            continue
        if "__" in plugin_dir.name:
            skipped.append(f"{plugin_dir.name}: namespace separator __ is not supported")
            continue
        manifest = _read_plugin_manifest(plugin_dir)
        sources = _load_plugin_source_files(plugin_dir)
        plugin_summaries.append(
            {
                "name": plugin_dir.name,
                "description": str(manifest.get("description") or ""),
                "version": str(manifest.get("version") or "0.0.0"),
                "agents": len(sources["agents"]),
                "skills": len(sources["skills"]),
                "commands": len(sources["commands"]),
            }
        )
        plugin_writes, plugin_warnings = _emit_plugin_target(target, output, plugin_dir.name, manifest, sources)
        written.extend(plugin_writes)
        warnings.extend(plugin_warnings)

    global_writes = _emit_global_target(target, output, plugin_summaries)
    written.extend(global_writes)
    return HarnessEmitReport(
        target=target,
        source_root=str(source_plugins),
        output_root=str(output),
        plugins=[item["name"] for item in plugin_summaries],
        written=written,
        skipped=skipped,
        warnings=warnings,
    )


def validate_harness_artifacts(output_root: str | Path, *, target: str) -> HarnessValidationReport:
    get_harness_profile(target)
    root = Path(output_root).expanduser().resolve()
    checked: list[str] = []
    findings: list[HarnessValidationFinding] = []
    if not root.is_dir():
        return HarnessValidationReport(
            target=target,
            output_root=str(root),
            findings=[
                HarnessValidationFinding(
                    severity="error",
                    target=target,
                    path=str(root),
                    message=f"output root not found: {root}",
                    remediation="Run superclaw harness emit before validating.",
                )
            ],
        )
    if target == "codex":
        _validate_codex(root, checked, findings)
    elif target == "cursor":
        _validate_cursor(root, checked, findings)
    elif target == "opencode":
        _validate_opencode(root, checked, findings)
    elif target == "gemini":
        _validate_gemini(root, checked, findings)
    elif target == "claude-code":
        _validate_claude_code(root, checked, findings)
    else:
        findings.append(HarnessValidationFinding("error", target, ".", f"unsupported target: {target}"))
    return HarnessValidationReport(target=target, output_root=str(root), checked_files=checked, findings=findings)


def _split_inline_list(raw: str) -> list[str]:
    if "," not in raw:
        return [raw.strip().strip('"').strip("'")] if raw.strip() else []
    items: list[str] = []
    buffer: list[str] = []
    quote: str | None = None
    for char in raw:
        if quote:
            if char == quote:
                quote = None
            else:
                buffer.append(char)
        elif char in {"'", '"'}:
            quote = char
        elif char == ",":
            item = "".join(buffer).strip().strip('"').strip("'")
            if item:
                items.append(item)
            buffer = []
        else:
            buffer.append(char)
    tail = "".join(buffer).strip().strip('"').strip("'")
    if tail:
        items.append(tail)
    return items


def _safe_utf8_cut(encoded: bytes, cap: int) -> int:
    if cap <= 0:
        return 0
    if cap >= len(encoded):
        return len(encoded)
    end = cap
    while end > 0 and (encoded[end] & 0xC0) == 0x80:
        end -= 1
    newline = encoded.rfind(b"\n", max(0, end - 256), end)
    if newline > end // 2:
        return newline
    return end


def _read_plugin_manifest(plugin_dir: Path) -> dict[str, Any]:
    path = plugin_dir / ".claude-plugin" / "plugin.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _validate_codex(root: Path, checked: list[str], findings: list[HarnessValidationFinding]) -> None:
    agents_dir = root / ".codex" / "agents"
    for path in sorted(agents_dir.glob("*.toml")) if agents_dir.is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        data = _read_toml(path, "codex", rel, findings)
        if data is None:
            continue
        required = {"name", "description", "developer_instructions"}
        missing = sorted(required - set(data))
        if missing:
            findings.append(
                HarnessValidationFinding(
                    "error",
                    "codex",
                    rel,
                    f"missing required TOML fields: {missing}",
                    "Regenerate the agent or add name, description, and developer_instructions.",
                )
            )
        if "sandbox_mode" in data and data["sandbox_mode"] not in {"read-only", "workspace-write", "danger-full-access"}:
            findings.append(
                HarnessValidationFinding(
                    "error",
                    "codex",
                    rel,
                    f"invalid sandbox_mode: {data['sandbox_mode']!r}",
                    "Use read-only, workspace-write, or danger-full-access.",
                )
            )

    skills_dir = root / ".codex" / "skills"
    for path in sorted(skills_dir.glob("*/SKILL.md")) if skills_dir.is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        content = path.read_text(encoding="utf-8", errors="replace")
        frontmatter, _ = parse_markdown_with_frontmatter(content)
        _validate_skill_frontmatter("codex", rel, path.parent.name, frontmatter, findings)
        file_bytes = len(content.encode("utf-8"))
        if file_bytes > CODEX_SKILL_CAP_BYTES:
            findings.append(
                HarnessValidationFinding(
                    "error",
                    "codex",
                    rel,
                    f"file size {file_bytes} B exceeds Codex 8192 B injection cap",
                    "Split detailed content into references/details.md.",
                )
            )

    agents_md = root / "AGENTS.md"
    if agents_md.exists():
        checked.append(_rel(root, agents_md))
        _warn_if_line_cap("codex", root, agents_md, findings)
    else:
        findings.append(HarnessValidationFinding("warning", "codex", "AGENTS.md", "AGENTS.md missing", "Emit Codex global context."))


def _validate_cursor(root: Path, checked: list[str], findings: list[HarnessValidationFinding]) -> None:
    marketplace = root / ".cursor-plugin" / "marketplace.json"
    if marketplace.exists():
        rel = _rel(root, marketplace)
        checked.append(rel)
        data = _read_json(marketplace, "cursor", rel, findings)
        if data is not None:
            if "owner" not in data:
                findings.append(HarnessValidationFinding("error", "cursor", rel, "marketplace.json missing owner", "Add owner metadata."))
            for entry in data.get("plugins", []):
                if "source" not in entry:
                    findings.append(HarnessValidationFinding("error", "cursor", rel, f"plugin entry {entry.get('name', '<unnamed>')} missing source"))
    else:
        findings.append(HarnessValidationFinding("warning", "cursor", ".cursor-plugin/marketplace.json", "Cursor marketplace missing"))

    for path in sorted((root / ".cursor-plugin" / "plugins").glob("*.json")) if (root / ".cursor-plugin" / "plugins").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        data = _read_json(path, "cursor", rel, findings)
        if data is not None and not data.get("name"):
            findings.append(HarnessValidationFinding("error", "cursor", rel, "plugin manifest missing name"))

    allowed_rule_keys = {"description", "globs", "alwaysApply"}
    for path in sorted((root / ".cursor" / "rules").glob("*.mdc")) if (root / ".cursor" / "rules").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        invalid = sorted(set(frontmatter) - allowed_rule_keys)
        if invalid:
            findings.append(HarnessValidationFinding("error", "cursor", rel, f"invalid Cursor rule frontmatter keys: {invalid}"))
        if not frontmatter.get("description"):
            findings.append(HarnessValidationFinding("error", "cursor", rel, "Cursor rule missing description"))

    for path in sorted((root / ".claude" / "skills").glob("*/SKILL.md")) if (root / ".claude" / "skills").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        _validate_skill_frontmatter("cursor", rel, path.parent.name, frontmatter, findings)


def _validate_opencode(root: Path, checked: list[str], findings: list[HarnessValidationFinding]) -> None:
    config = root / "opencode.json"
    if config.exists():
        rel = _rel(root, config)
        checked.append(rel)
        _read_json(config, "opencode", rel, findings)
    else:
        findings.append(HarnessValidationFinding("warning", "opencode", "opencode.json", "opencode.json missing"))

    name_re = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
    for glob in [".opencode/agents/*.md", ".opencode/commands/*.md", ".opencode/skills/*/SKILL.md"]:
        for path in sorted(root.glob(glob)):
            rel = _rel(root, path)
            checked.append(rel)
            content = path.read_text(encoding="utf-8", errors="replace")
            frontmatter, _ = parse_markdown_with_frontmatter(content)
            artifact_name = path.parent.name if path.name == "SKILL.md" else path.stem
            if not name_re.match(artifact_name) or len(artifact_name) > 64:
                findings.append(HarnessValidationFinding("error", "opencode", rel, f"invalid OpenCode artifact name: {artifact_name}"))
            if path.name == "SKILL.md":
                _validate_skill_frontmatter("opencode", rel, artifact_name, frontmatter, findings)
            elif not frontmatter.get("description"):
                findings.append(HarnessValidationFinding("error", "opencode", rel, "missing description in frontmatter"))
            mode = frontmatter.get("mode")
            if mode and mode not in {"primary", "subagent", "all"}:
                findings.append(HarnessValidationFinding("error", "opencode", rel, f"invalid mode: {mode!r}"))
            permissions = _extract_nested_frontmatter_map(content, "permission")
            for key, value in permissions.items():
                if value not in {"allow", "ask", "deny"}:
                    findings.append(HarnessValidationFinding("error", "opencode", rel, f"invalid permission for {key}: {value!r}"))


def _validate_gemini(root: Path, checked: list[str], findings: list[HarnessValidationFinding]) -> None:
    gemini_md = root / "GEMINI.md"
    if gemini_md.exists():
        checked.append(_rel(root, gemini_md))
        _warn_if_line_cap("gemini", root, gemini_md, findings)
    else:
        findings.append(HarnessValidationFinding("warning", "gemini", "GEMINI.md", "GEMINI.md missing"))

    for path in sorted((root / "agents").glob("*.md")) if (root / "agents").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        if not frontmatter.get("name"):
            findings.append(HarnessValidationFinding("error", "gemini", rel, "agent missing name"))
        if not frontmatter.get("description"):
            findings.append(HarnessValidationFinding("error", "gemini", rel, "agent missing description"))
    for path in sorted((root / "skills").glob("*/SKILL.md")) if (root / "skills").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        _validate_skill_frontmatter("gemini", rel, path.parent.name, frontmatter, findings)
    for path in sorted((root / "commands").glob("*/*.toml")) if (root / "commands").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        data = _read_toml(path, "gemini", rel, findings)
        if data is None:
            continue
        missing = sorted({"name", "description", "prompt"} - set(data))
        if missing:
            findings.append(HarnessValidationFinding("error", "gemini", rel, f"command TOML missing fields: {missing}"))


def _validate_claude_code(root: Path, checked: list[str], findings: list[HarnessValidationFinding]) -> None:
    marketplace = root / ".claude-plugin" / "marketplace.json"
    if marketplace.exists():
        rel = _rel(root, marketplace)
        checked.append(rel)
        _read_json(marketplace, "claude-code", rel, findings)
    for path in sorted((root / "plugins").glob("*/agents/*.md")) if (root / "plugins").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        if not frontmatter.get("name"):
            findings.append(HarnessValidationFinding("error", "claude-code", rel, "agent missing name"))
        if not frontmatter.get("description"):
            findings.append(HarnessValidationFinding("error", "claude-code", rel, "agent missing description"))
    for path in sorted((root / "plugins").glob("*/skills/*/SKILL.md")) if (root / "plugins").is_dir() else []:
        rel = _rel(root, path)
        checked.append(rel)
        frontmatter, _ = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        _validate_skill_frontmatter("claude-code", rel, path.parent.name, frontmatter, findings, require_name_match=False)


def _validate_skill_frontmatter(
    target: str,
    rel: str,
    expected_name: str,
    frontmatter: dict[str, Any],
    findings: list[HarnessValidationFinding],
    *,
    require_name_match: bool = True,
) -> None:
    if not frontmatter:
        findings.append(HarnessValidationFinding("error", target, rel, "missing or invalid frontmatter"))
        return
    actual_name = frontmatter.get("name")
    if not actual_name:
        findings.append(HarnessValidationFinding("error", target, rel, "skill frontmatter missing name"))
    elif require_name_match and actual_name != expected_name:
        findings.append(HarnessValidationFinding("error", target, rel, f"frontmatter name {actual_name!r} != directory name {expected_name!r}"))
    if not frontmatter.get("description"):
        findings.append(HarnessValidationFinding("error", target, rel, "skill frontmatter missing description"))


def _warn_if_line_cap(target: str, root: Path, path: Path, findings: list[HarnessValidationFinding]) -> None:
    line_count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
    if line_count > CONTEXT_FILE_LINE_CAP:
        findings.append(
            HarnessValidationFinding(
                "warning",
                target,
                _rel(root, path),
                f"context file has {line_count} lines; recommended cap is {CONTEXT_FILE_LINE_CAP}",
                "Move detailed guidance into docs or generated artifacts.",
            )
        )


def _read_json(path: Path, target: str, rel: str, findings: list[HarnessValidationFinding]) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        findings.append(HarnessValidationFinding("error", target, rel, f"JSON parse error: {exc}"))
        return None
    if not isinstance(value, dict):
        findings.append(HarnessValidationFinding("error", target, rel, "JSON root must be an object"))
        return None
    return value


def _read_toml(path: Path, target: str, rel: str, findings: list[HarnessValidationFinding]) -> dict[str, Any] | None:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        findings.append(HarnessValidationFinding("error", target, rel, f"TOML parse error: {exc}"))
        return None


def _extract_nested_frontmatter_map(content: str, key: str) -> dict[str, str]:
    if not content.startswith("---"):
        return {}
    end = content.find("\n---", 3)
    if end == -1:
        return {}
    block = content[3:end].strip("\n")
    result: dict[str, str] = {}
    in_target = False
    for line in block.splitlines():
        if re.match(r"^[A-Za-z][\w-]*:\s*", line):
            in_target = line.split(":", 1)[0] == key
            continue
        if in_target and line.startswith(("  ", "\t")) and ":" in line:
            subkey, value = line.strip().split(":", 1)
            result[subkey.strip()] = value.strip().strip('"').strip("'")
    return result


def _rel(root: Path, path: Path) -> str:
    return str(path.relative_to(root))


def _plugin_root(root: str | Path) -> Path:
    base = Path(root).expanduser().resolve()
    return base / "plugins" if (base / "plugins").is_dir() else base


def _load_plugin_source_files(plugin_dir: Path) -> dict[str, list[dict[str, Any]]]:
    agents = []
    for path in sorted((plugin_dir / "agents").glob("*.md")) if (plugin_dir / "agents").is_dir() else []:
        frontmatter, body = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        agents.append({"path": path, "name": str(frontmatter.get("name") or path.stem), "frontmatter": frontmatter, "body": body})

    skills = []
    for path in sorted((plugin_dir / "skills").glob("*/SKILL.md")) if (plugin_dir / "skills").is_dir() else []:
        frontmatter, body = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        skills.append({"path": path, "name": str(frontmatter.get("name") or path.parent.name), "frontmatter": frontmatter, "body": body})

    commands = []
    for path in sorted((plugin_dir / "commands").glob("*.md")) if (plugin_dir / "commands").is_dir() else []:
        frontmatter, body = parse_markdown_with_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        commands.append({"path": path, "name": path.stem, "frontmatter": frontmatter, "body": body})
    return {"agents": agents, "skills": skills, "commands": commands}


def _emit_plugin_target(
    target: str,
    output_root: Path,
    plugin: str,
    manifest: dict[str, Any],
    sources: dict[str, list[dict[str, Any]]],
) -> tuple[list[str], list[str]]:
    if target == "codex":
        return _emit_codex_plugin(output_root, plugin, sources)
    if target == "cursor":
        return _emit_cursor_plugin(output_root, plugin, manifest, sources)
    if target == "opencode":
        return _emit_opencode_plugin(output_root, plugin, sources)
    if target == "gemini":
        return _emit_gemini_plugin(output_root, plugin, sources)
    if target == "claude-code":
        return _emit_claude_plugin(output_root, plugin, manifest, sources)
    raise KeyError(f"unsupported target: {target}")


def _emit_codex_plugin(output_root: Path, plugin: str, sources: dict[str, list[dict[str, Any]]]) -> tuple[list[str], list[str]]:
    written: list[str] = []
    warnings: list[str] = []
    for source in sources["agents"]:
        artifact = adapt_agent(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="codex")
        warnings.extend(artifact.warnings)
        content = "\n".join(
            [
                _toml_kv("name", artifact.name),
                _toml_kv("description", artifact.frontmatter.get("description", "")),
                _toml_kv("model", artifact.frontmatter.get("model", "gpt-5")),
                _toml_kv("sandbox_mode", artifact.frontmatter.get("sandbox_mode", "workspace-write")),
                _toml_kv("developer_instructions", artifact.body),
                "",
            ]
        )
        written.append(_write_output(output_root, Path(".codex") / "agents" / f"{artifact.name}.toml", content))
    for source in sources["skills"]:
        artifact = adapt_skill(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="codex")
        warnings.extend(artifact.warnings)
        skill_dir = Path(".codex") / "skills" / artifact.name
        written.append(_write_output(output_root, skill_dir / "SKILL.md", _render_skill_content(artifact)))
        if artifact.overflow:
            written.append(_write_output(output_root, skill_dir / "references" / "details.md", artifact.overflow.rstrip() + "\n"))
    for source in sources["commands"]:
        name = f"{source['name']}__command"
        artifact = adapt_skill(plugin=plugin, name=name, frontmatter={"description": source["frontmatter"].get("description") or f"Command: {source['name']}"}, body=source["body"], target="codex")
        warnings.extend(artifact.warnings)
        skill_dir = Path(".codex") / "skills" / artifact.name
        written.append(_write_output(output_root, skill_dir / "SKILL.md", _render_skill_content(artifact)))
        if artifact.overflow:
            written.append(_write_output(output_root, skill_dir / "references" / "details.md", artifact.overflow.rstrip() + "\n"))
    return written, warnings


def _emit_cursor_plugin(
    output_root: Path,
    plugin: str,
    manifest: dict[str, Any],
    sources: dict[str, list[dict[str, Any]]],
) -> tuple[list[str], list[str]]:
    written: list[str] = []
    warnings: list[str] = []
    for source in sources["agents"]:
        artifact = adapt_agent(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="cursor")
        warnings.extend(artifact.warnings)
        frontmatter = dict(artifact.frontmatter)
        if sandbox_mode_for_tools(source["frontmatter"]) == "read-only":
            frontmatter["readonly"] = True
        written.append(_write_output(output_root, Path(".claude") / "agents" / f"{artifact.name}.md", _frontmatter_block(frontmatter) + "\n\n" + artifact.body.rstrip() + "\n"))
    for source in sources["skills"]:
        artifact = adapt_skill(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="cursor")
        warnings.extend(artifact.warnings)
        written.append(_write_output(output_root, Path(".claude") / "skills" / artifact.name / "SKILL.md", _render_skill_content(artifact)))
    for source in sources["commands"]:
        command_frontmatter = _command_frontmatter(source, target="cursor")
        body = rewrite_tool_prose(source["body"].rstrip() + "\n", "cursor")
        written.append(_write_output(output_root, Path(".claude") / "commands" / plugin / f"{source['name']}.md", _frontmatter_block(command_frontmatter) + "\n\n" + body))
    rule_frontmatter = {
        "description": str(manifest.get("description") or f"{plugin} generated harness assets"),
        "globs": ["**/*"],
        "alwaysApply": False,
    }
    rule_body = f"# {plugin}\n\nGenerated harness pointers for {plugin}. Use .claude/agents, .claude/skills, and .claude/commands for executable content.\n"
    written.append(_write_output(output_root, Path(".cursor") / "rules" / f"{plugin}.mdc", _frontmatter_block(rule_frontmatter) + "\n\n" + rule_body))
    manifest_body = {
        "name": plugin,
        "description": str(manifest.get("description") or ""),
        "version": str(manifest.get("version") or "0.0.0"),
        "generated": {
            "agents": len(sources["agents"]),
            "skills": len(sources["skills"]),
            "commands": len(sources["commands"]),
        },
    }
    written.append(_write_output(output_root, Path(".cursor-plugin") / "plugins" / f"{plugin}.json", json.dumps(manifest_body, ensure_ascii=False, indent=2) + "\n"))
    return written, warnings


def _emit_opencode_plugin(output_root: Path, plugin: str, sources: dict[str, list[dict[str, Any]]]) -> tuple[list[str], list[str]]:
    written: list[str] = []
    warnings: list[str] = []
    for source in sources["agents"]:
        artifact = adapt_agent(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="opencode")
        warnings.extend(artifact.warnings)
        frontmatter: dict[str, Any] = {
            "description": artifact.frontmatter.get("description", ""),
            "model": artifact.frontmatter.get("model", "anthropic/claude-sonnet-4-6"),
            "mode": "subagent",
        }
        permission = _opencode_permission_for_tools(normalize_tools(source["frontmatter"].get("tools")))
        if permission:
            frontmatter["permission"] = permission
        written.append(_write_output(output_root, Path(".opencode") / "agents" / f"{_safe_harness_name(artifact.name)}.md", _frontmatter_block(frontmatter) + "\n\n" + artifact.body.rstrip() + "\n"))
    for source in sources["skills"]:
        artifact = adapt_skill(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="opencode")
        warnings.extend(artifact.warnings)
        artifact = _rename_artifact(artifact, _safe_harness_name(artifact.name))
        written.append(_write_output(output_root, Path(".opencode") / "skills" / artifact.name / "SKILL.md", _render_skill_content(artifact)))
    for source in sources["commands"]:
        command_frontmatter = _command_frontmatter(source, target="opencode")
        body = rewrite_tool_prose(source["body"].rstrip() + "\n", "opencode")
        written.append(_write_output(output_root, Path(".opencode") / "commands" / f"{_safe_harness_name(plugin + '-' + source['name'])}.md", _frontmatter_block(command_frontmatter) + "\n\n" + body))
    return written, warnings


def _emit_gemini_plugin(output_root: Path, plugin: str, sources: dict[str, list[dict[str, Any]]]) -> tuple[list[str], list[str]]:
    written: list[str] = []
    warnings: list[str] = []
    for source in sources["agents"]:
        artifact = adapt_agent(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="gemini")
        warnings.extend(artifact.warnings)
        frontmatter = dict(artifact.frontmatter)
        tools = normalize_tools(source["frontmatter"].get("tools"))
        if tools:
            frontmatter["tools"] = [TOOL_NAME_MAPS["gemini"].get(tool, tool.lower()) for tool in tools]
        written.append(_write_output(output_root, Path("agents") / f"{artifact.name}.md", _frontmatter_block(frontmatter) + "\n\n" + artifact.body.rstrip() + "\n"))
    for source in sources["skills"]:
        artifact = adapt_skill(plugin=plugin, name=source["name"], frontmatter=source["frontmatter"], body=source["body"], target="gemini")
        warnings.extend(artifact.warnings)
        written.append(_write_output(output_root, Path("skills") / artifact.name / "SKILL.md", _render_skill_content(artifact)))
    for source in sources["commands"]:
        body = rewrite_tool_prose(source["body"].rstrip() + "\n", "gemini")
        command_data = {
            "name": f"{plugin}__{source['name']}",
            "description": str(source["frontmatter"].get("description") or f"{source['name']} command"),
            "prompt": body,
        }
        hint = source["frontmatter"].get("argument-hint")
        if hint:
            command_data["argument_hint"] = str(hint)
        written.append(_write_output(output_root, Path("commands") / plugin / f"{source['name']}.toml", _toml_doc(command_data)))
    return written, warnings


def _emit_claude_plugin(
    output_root: Path,
    plugin: str,
    manifest: dict[str, Any],
    sources: dict[str, list[dict[str, Any]]],
) -> tuple[list[str], list[str]]:
    written: list[str] = []
    target_plugin = Path("plugins") / plugin
    written.append(
        _write_output(
            output_root,
            target_plugin / ".claude-plugin" / "plugin.json",
            json.dumps({"name": plugin, **manifest}, ensure_ascii=False, indent=2) + "\n",
        )
    )
    for kind, subdir in (("agents", "agents"), ("skills", "skills"), ("commands", "commands")):
        for source in sources[kind]:
            if kind == "skills":
                rel = target_plugin / subdir / source["name"] / "SKILL.md"
            else:
                rel = target_plugin / subdir / f"{source['name']}.md"
            content = source["path"].read_text(encoding="utf-8", errors="replace")
            written.append(_write_output(output_root, rel, content))
    return written, []


def _emit_global_target(target: str, output_root: Path, plugin_summaries: list[dict[str, Any]]) -> list[str]:
    if target == "cursor":
        data = {
            "owner": {"name": "SuperClaw"},
            "plugins": [
                {
                    "name": item["name"],
                    "description": item["description"],
                    "source": f".cursor-plugin/plugins/{item['name']}.json",
                }
                for item in plugin_summaries
            ],
        }
        return [_write_output(output_root, Path(".cursor-plugin") / "marketplace.json", json.dumps(data, ensure_ascii=False, indent=2) + "\n")]
    if target == "opencode":
        data = {
            "$schema": "https://opencode.ai/config.json",
            "generated_by": "superclaw",
            "plugins": [item["name"] for item in plugin_summaries],
        }
        return [_write_output(output_root, "opencode.json", json.dumps(data, ensure_ascii=False, indent=2) + "\n")]
    if target == "gemini":
        lines = [
            "# SuperClaw Gemini Harness",
            "",
            "Generated harness artifacts from Agents-style plugins.",
            "",
            "Keep this file short; detailed behavior lives in agents/, skills/, and commands/.",
            "",
            "## Plugins",
        ]
        lines.extend(f"- {item['name']}: {item['agents']} agents, {item['skills']} skills, {item['commands']} commands" for item in plugin_summaries)
        return [_write_output(output_root, "GEMINI.md", "\n".join(lines).rstrip() + "\n")]
    if target == "codex":
        lines = [
            "# SuperClaw Codex Harness",
            "",
            "Generated harness artifacts from Agents-style plugins.",
            "",
            "Use .codex/agents and .codex/skills for emitted content.",
        ]
        return [_write_output(output_root, "AGENTS.md", "\n".join(lines) + "\n")]
    if target == "claude-code":
        data = {
            "name": "superclaw-generated",
            "owner": "SuperClaw",
            "plugins": plugin_summaries,
        }
        return [_write_output(output_root, Path(".claude-plugin") / "marketplace.json", json.dumps(data, ensure_ascii=False, indent=2) + "\n")]
    return []


def _write_output(output_root: Path, rel_path: str | Path, content: str) -> str:
    root = output_root.resolve()
    target = (root / rel_path).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"refusing to write outside output root: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return str(target.relative_to(root))


def _render_skill_content(artifact: AdaptedArtifact) -> str:
    return _frontmatter_block(artifact.frontmatter) + "\n\n" + artifact.body.rstrip() + "\n"


def _rename_artifact(artifact: AdaptedArtifact, name: str) -> AdaptedArtifact:
    frontmatter = dict(artifact.frontmatter)
    frontmatter["name"] = name
    return AdaptedArtifact(
        target=artifact.target,
        name=name,
        kind=artifact.kind,
        frontmatter=frontmatter,
        body=artifact.body,
        overflow=artifact.overflow,
        warnings=artifact.warnings,
        metadata=artifact.metadata,
    )


def _command_frontmatter(source: dict[str, Any], *, target: str) -> dict[str, Any]:
    frontmatter = {
        "description": str(source["frontmatter"].get("description") or f"{source['name']} command"),
    }
    hint = source["frontmatter"].get("argument-hint")
    if hint:
        frontmatter["argument-hint"] = str(hint)
    if target == "opencode":
        frontmatter["name"] = _safe_harness_name(str(source["name"]))
    return frontmatter


def _opencode_permission_for_tools(tools: list[str]) -> dict[str, str]:
    permission: dict[str, str] = {}
    for tool in tools:
        mapped = TOOL_NAME_MAPS["opencode"].get(tool, tool.lower())
        if mapped:
            permission[mapped] = "allow"
    return permission


def _safe_harness_name(value: str, max_len: int = 64) -> str:
    safe = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not safe:
        safe = "generated"
    return safe[:max_len].rstrip("-") or "generated"


def _frontmatter_block(frontmatter: dict[str, Any]) -> str:
    lines = ["---"]
    for key, value in frontmatter.items():
        lines.extend(_yaml_lines(key, value))
    lines.append("---")
    return "\n".join(lines)


def _yaml_lines(key: str, value: Any, indent: int = 0) -> list[str]:
    prefix = " " * indent
    if isinstance(value, bool):
        return [f"{prefix}{key}: {'true' if value else 'false'}"]
    if isinstance(value, int):
        return [f"{prefix}{key}: {value}"]
    if isinstance(value, list):
        lines = [f"{prefix}{key}:"]
        for item in value:
            lines.append(f"{prefix}  - {_yaml_scalar(item)}")
        return lines
    if isinstance(value, dict):
        lines = [f"{prefix}{key}:"]
        for subkey, subvalue in value.items():
            lines.extend(_yaml_lines(str(subkey), subvalue, indent + 2))
        return lines
    if value is None:
        return []
    return [f"{prefix}{key}: {_yaml_scalar(value)}"]


def _yaml_scalar(value: Any) -> str:
    text = str(value).replace("\n", " ")
    needs_quote = (
        not text
        or text != text.strip()
        or text[0] in "[]{}*&!|>'\"@`#%,?:-"
        or ": " in text
        or " #" in text
        or text.lower() in {"true", "false", "yes", "no", "on", "off", "null", "~"}
    )
    if needs_quote:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def _toml_doc(data: dict[str, Any]) -> str:
    return "\n".join(_toml_kv(key, value) for key, value in data.items()) + "\n"


def _toml_kv(key: str, value: Any) -> str:
    if isinstance(value, bool):
        return f"{key} = {'true' if value else 'false'}"
    if isinstance(value, int):
        return f"{key} = {value}"
    text = str(value)
    escaped_triple_quotes = text.replace(chr(34) * 3, '\\"' * 3)
    escaped_string = text.replace("\\", "\\\\").replace(chr(34), '\\"')
    if "\n" in text:
        return f'{key} = """\n{escaped_triple_quotes}\n"""'
    return f'{key} = "{escaped_string}"'
