"""Project installed SuperClaw plugins into a local agent run.

This is the bridge that was missing: it enumerates the plugins an agent is
*actually allowed* to use right now (installed ∩ signature-valid ∩ not-revoked ∩
entitled ∩ policy-allowed — fail-closed), and turns them into a single aggregate
MCP config plus a short capabilities note that the agent runtime injects when it
invokes codex / Claude Code.

Governance is reused verbatim from ``plugin_proxy`` (the same checks the call
path enforces), so projection can never widen what a plugin is permitted to do —
it only decides whether a plugin is *offered*. Every actual tool call still goes
through the full ``invoke_cached_plugin_tool`` gate at execution time.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from superclaw.plugin_mcp_proxy import build_aggregate_mcp_config, project_plugin_tools, projected_tool_name
from superclaw.plugin_proxy import (
    DEFAULT_RUNTIME_VERSION,
    default_entitlement_file,
    default_policy_file,
    load_cached_package,
    resolve_entitlement,
    resolve_runtime_policy,
    verify_cached_package_before_execution,
)
from superclaw.plugin_versions import version_tuple
from superclaw.plugins import (
    default_revocation_file,
    is_skill_origin_plugin,
    list_cached_plugins,
    local_dev_trust_enabled,
    plugin_cache_root,
    plugin_signer_identity,
)


@dataclass(frozen=True)
class AvailablePluginTool:
    projected_name: str
    tool_name: str
    short_description: str


@dataclass(frozen=True)
class AvailablePlugin:
    plugin_id: str
    version: str
    name: str
    tools: tuple[AvailablePluginTool, ...]
    # True when this is a skill-origin package. It still appears in
    # available_plugins so a tool-skill can be MCP-projected (superclaw__call_tool /
    # _skill_overlay_lines), but it must NEVER be granted as plugin equipment — the
    # plugin grant in team_kernel.resolve_equipment excludes it on this flag.
    skill_origin: bool = False


def _gate_passes(
    package,
    *,
    public_key: str | None,
    revocation_file: Path,
    entitlement_file: Path,
    policy_file: Path,
    runtime_version: str,
) -> bool:
    """The fail-closed gate, shared so every enumerator decides identically."""
    if verify_cached_package_before_execution(package, public_key=public_key, revocation_file=revocation_file):
        return False
    if resolve_entitlement(package, entitlement_file).get("error_code"):
        return False
    if resolve_runtime_policy(package, policy_file, runtime_version=runtime_version).get("error_code"):
        return False
    return True


def _latest_non_conflicting_plugins(
    *,
    cache_root: Path | None,
    public_key: str | None,
) -> dict[str, str]:
    """Return latest version per plugin id, excluding same-id signer conflicts.

    Route-map direction two requires a hard conflict when the same plugin id is
    present under multiple signer identities. Do this before picking "latest" so
    a malicious newer local/dev package cannot shadow an existing official one.
    """
    latest: dict[str, str] = {}
    signer_by_id: dict[str, str] = {}
    conflicts: set[str] = set()
    for row in list_cached_plugins(cache_root=cache_root):
        pid, ver = row["id"], row["version"]
        package = None
        try:
            package = load_cached_package(pid, version=ver, cache_root=cache_root)
            if package is None:
                continue
            signer = plugin_signer_identity(package, public_key=public_key)
        except Exception:
            signer = "invalid"
        finally:
            if package is not None:
                package.cleanup()
        if pid in signer_by_id and signer_by_id[pid] != signer:
            conflicts.add(pid)
            continue
        signer_by_id.setdefault(pid, signer)
        if pid not in latest or _version_gt(ver, latest[pid]):
            latest[pid] = ver
    for pid in conflicts:
        latest.pop(pid, None)
    return latest


def gate_passing_plugins(
    *,
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    runtime_version: str = DEFAULT_RUNTIME_VERSION,
) -> list[tuple[str, str]]:
    """Return ``(plugin_id, version)`` for every latest-version plugin that
    passes the *same* fail-closed gate as :func:`available_plugins`, **without**
    filtering on tool count.

    ``available_plugins`` drops a plugin that declares no tools (nothing to offer
    a runtime). Skill-sync reconciliation needs the opposite: a plugin that
    upgraded to zero tools is still "allowed", so its now-orphaned projections
    can be reclaimed. Both share :func:`_gate_passes`, so the governance decision
    can never diverge.
    """
    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    policy_file = policy_file or default_policy_file()

    latest = _latest_non_conflicting_plugins(cache_root=cache_root, public_key=public_key)

    allowed: list[tuple[str, str]] = []
    for plugin_id, version in sorted(latest.items()):
        package = None
        try:
            package = load_cached_package(plugin_id, version=version, cache_root=cache_root)
            if package is None:
                continue
            if _gate_passes(
                package,
                public_key=public_key,
                revocation_file=revocation_file,
                entitlement_file=entitlement_file,
                policy_file=policy_file,
                runtime_version=runtime_version,
            ):
                allowed.append((plugin_id, version))
        except Exception:
            continue
        finally:
            if package is not None:
                package.cleanup()
    return allowed


def available_plugins(
    *,
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    runtime_version: str = DEFAULT_RUNTIME_VERSION,
) -> list[AvailablePlugin]:
    """Return the plugins an agent may use now, after fail-closed governance.

    A plugin that fails any gate (load/signature/revocation/entitlement/policy)
    is silently dropped rather than raising, so one bad plugin never blocks the
    whole projection.
    """
    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    policy_file = policy_file or default_policy_file()

    # Keep only the highest installed version per plugin id, after excluding
    # same-id signer conflicts.
    latest = _latest_non_conflicting_plugins(cache_root=cache_root, public_key=public_key)

    result: list[AvailablePlugin] = []
    for plugin_id, version in sorted(latest.items()):
        package = None
        try:
            package = load_cached_package(plugin_id, version=version, cache_root=cache_root)
            if package is None:
                continue
            if not _gate_passes(
                package,
                public_key=public_key,
                revocation_file=revocation_file,
                entitlement_file=entitlement_file,
                policy_file=policy_file,
                runtime_version=runtime_version,
            ):
                continue
            tools = tuple(
                AvailablePluginTool(
                    projected_name=projected_tool_name(plugin_id, str(tool["name"])),
                    tool_name=str(tool["name"]),
                    short_description=_short(tool.get("description", "")),
                )
                for tool in project_plugin_tools(plugin_id, version=version, cache_root=cache_root)
            )
            if not tools:
                continue
            display_name = str(package.manifest.get("name") or plugin_id)
            # Carry skill_origin so the PLUGIN-equipment grant (resolve_equipment) can
            # exclude skills while the MCP projection / @skill overlay still see
            # tool-skills here. A skill-origin package is in this list ONLY for
            # tool-skill MCP projection, NEVER to be granted as plugin equipment.
            result.append(
                AvailablePlugin(
                    plugin_id=plugin_id,
                    version=version,
                    name=display_name,
                    tools=tools,
                    skill_origin=is_skill_origin_plugin(plugin_id, package.manifest.get("skill_origin")),
                )
            )
        except Exception:
            continue
        finally:
            if package is not None:
                package.cleanup()
    return result


def build_runtime_plugin_policy_addition(
    *,
    artifact_dir: Path,
    mode: str = "dispatch",
    server_name: str = "superclaw",
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    runtime_version: str = DEFAULT_RUNTIME_VERSION,
    python_executable: str | None = None,
    allowed_plugin_ids: frozenset[str] | None = None,
) -> tuple[str | None, str | None]:
    """Materialize an aggregate MCP config for the available plugins.

    Returns ``(mcp_config_path, capabilities_note)``. Both are None when there is
    nothing to offer, so the caller can cheaply no-op. The written files contain
    only command/args (secret-free) — plugin secrets are still injected by the
    sidecar inside ``invoke_cached_plugin_tool`` and never enter the MCP config.

    ``allowed_plugin_ids`` is the per-agent EQUIPMENT NARROWING (Agent Team Kernel
    §2.6 item 4: "装备投影"). When it is None (a non-team run — plain chat / generic
    delivery) the full trust-chain-entitled plugin set is projected as today. When
    it is a set (a team-bound run carries ``equipment.granted``), only plugins whose
    id is in the set are projected — and an EMPTY set projects NOTHING, fail-closed,
    so a CEO with no granted equipment cannot reach any plugin tool. This is the
    enforcement layer for the granted/dropped split the kernel already computes: the
    aggregate MCP config is the model's only handle on plugin tools, so narrowing it
    here means an un-granted plugin is never exposed OR invocable, not merely hidden.
    """
    plugins = available_plugins(
        cache_root=cache_root,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
        runtime_version=runtime_version,
    )
    if not plugins:
        return None, None
    if allowed_plugin_ids is not None:
        # Per-agent narrowing: keep only granted plugins. An empty grant set ⇒ no
        # projection at all (fail-closed; the CEO/least-equipped agent gets nothing).
        plugins = [p for p in plugins if p.plugin_id in allowed_plugin_ids]
        if not plugins:
            return None, None

    artifact_dir = Path(artifact_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)

    # Self-contained snapshot: embed the resolved cache root and the (public)
    # verification key so the aggregate proxy works even if the spawning agent
    # does not forward environment variables to MCP child processes.
    plugin_set_path = (artifact_dir / "superclaw-plugin-set.json").resolve()
    snapshot: dict = {
        "mode": mode,
        "plugins": [{"id": p.plugin_id, "version": p.version} for p in plugins],
        "cache_root": str(plugin_cache_root(cache_root)),
        # Execute under the same runtime version the gate used to select these
        # plugins, so the projection gate and the execution gate never disagree.
        "runtime_version": runtime_version,
    }
    if public_key:
        snapshot["public_key"] = public_key
    # Carry the local-dev trust decision into the proxy subprocess: codex/claude
    # do not forward env to MCP children, so the snapshot must be self-contained.
    if local_dev_trust_enabled():
        snapshot["local_dev_trust"] = True
    # Record the per-agent grant in the snapshot as a FALLBACK only — the proxy's
    # authoritative narrowing comes from the ``--allowed-plugins`` argv below
    # (tamper-proof once the process starts). The snapshot lives in the run
    # artifact dir and a full-shell agent could rewrite it; it is not authority.
    if allowed_plugin_ids is not None:
        snapshot["granted_plugin_ids"] = sorted(allowed_plugin_ids)
    plugin_set_path.write_text(json.dumps(snapshot, ensure_ascii=False, sort_keys=True), encoding="utf-8")

    mcp_config = build_aggregate_mcp_config(
        plugin_set_path,
        server_name=server_name,
        mode=mode,
        python_executable=python_executable,
        allowed_plugin_ids=allowed_plugin_ids,
    )
    mcp_config_path = (artifact_dir / "superclaw-plugins.mcp.json").resolve()
    mcp_config_path.write_text(json.dumps(mcp_config, ensure_ascii=False, sort_keys=True), encoding="utf-8")

    note = _capabilities_note(plugins, mode=mode)
    return os.fspath(mcp_config_path), note


def _capabilities_note(plugins: list[AvailablePlugin], *, mode: str) -> str:
    names = ", ".join(p.name for p in plugins)
    if mode == "full":
        return (
            f"Available SuperClaw plugins: {names}. Their tools are listed directly "
            f"as superclaw__<plugin>__<tool> — call them when useful."
        )
    return (
        f"Available SuperClaw plugins: {names}. Use superclaw__list_tools to see their tools, "
        f"superclaw__describe_tool for a tool's arguments, and superclaw__call_tool to run one."
    )


def _short(text: str, *, limit: int = 140) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _version_gt(candidate: str, current: str) -> bool:
    try:
        return version_tuple(candidate) > version_tuple(current)
    except Exception:
        return candidate > current
