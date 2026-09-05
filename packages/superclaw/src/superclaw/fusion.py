from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from superclaw.environment import local_service_url, superclaw_data_path
from superclaw.secrets_scan import contains_secret, redact_secrets


FUSION_SCHEMA_VERSION = "0.1.0"
FUSION_NATIVE_REPORT_VERSION = "0.1.0"


class FusionPermissionError(PermissionError):
    """Raised when a fusion action requires a SuperClaw human gate."""


@dataclass(frozen=True)
class FusionComponent:
    key: str
    display_name: str
    repo: str
    commit: str
    license: str
    source_dir: str
    toolchain: str
    dev_command: list[str]
    test_commands: list[list[str]]
    plugin_id: str
    passive_tools: list[str]
    active_tools: list[str]


@dataclass(frozen=True)
class FusionCapability:
    id: str
    component: str
    title: str
    upstream_evidence: list[str]
    projected_tools: list[str]
    delivery_surfaces: list[str]
    gate: Literal["passive", "human_gate", "operator_control"] = "passive"


FUSION_COMPONENTS: dict[str, FusionComponent] = {
    "osiris": FusionComponent(
        key="osiris",
        display_name="OSIRIS",
        repo="simplifaisoul/osiris",
        commit="21c3dde7d4e48154aa3918829f86965f4e646e67",
        license="MIT",
        source_dir="third_party/osiris",
        toolchain="npm",
        dev_command=["npm", "run", "dev"],
        test_commands=[["npm", "run", "lint"], ["npm", "run", "build"]],
        plugin_id="com.superclaw.osiris",
        passive_tools=[
            "intel_layers",
            "map_snapshot",
            "api_route_catalog",
            "aviation_layer",
            "maritime_layer",
            "cctv_layer",
            "seismic_layer",
            "fires_layer",
            "weather_layer",
            "space_layer",
            "news_streams",
            "telegram_osint",
            "conflict_zones",
            "crypto_wallet_trace",
            "sanctions_search",
            "dns_lookup",
            "whois_lookup",
            "ssl_tls_inspector",
            "ip_intelligence",
            "cve_lookup",
            "bgp_lookup",
            "github_osint",
            "leak_lookup",
            "phone_lookup",
            "mac_lookup",
            "threat_feed",
            "ai_briefing",
            "region_dossier",
        ],
        active_tools=["port_scan", "vulnerability_scan", "scanner_sweep", "service_fingerprint", "shodan_search"],
    ),
    "open-design": FusionComponent(
        key="open-design",
        display_name="Open Design",
        repo="nexu-io/open-design",
        commit="324e9fd909d005f5d1d86982d3f15d39d747bc34",
        license="Apache-2.0",
        source_dir="third_party/open-design",
        toolchain="pnpm",
        dev_command=["pnpm", "tools-dev"],
        test_commands=[["pnpm", "typecheck"], ["pnpm", "guard"]],
        plugin_id="com.superclaw.open-design",
        passive_tools=[
            "agents_catalog",
            "byok_proxy_catalog",
            "skills_catalog",
            "run_skill_artifact",
            "design_systems_catalog",
            "visual_directions_catalog",
            "device_frames_catalog",
            "artifact_preview",
            "export_bundle",
            "critique_self_check",
            "media_generation_catalog",
            "prompt_templates_catalog",
            "claude_design_import",
            "project_persistence",
            "tools_dev_lifecycle",
            "desktop_shell",
            "mcp_live_artifacts",
            "deploy_handoff",
            "plugin_catalog",
            "i18n_catalog",
        ],
        active_tools=["agent_spawn", "byok_model_stream", "media_generation_request", "desktop_sidecar_control", "deploy_publish"],
    ),
    "openpencil": FusionComponent(
        key="openpencil",
        display_name="OpenPencil",
        repo="ZSeven-W/openpencil",
        commit="e8ed1985b94ba954c22441a68539ef3cd3be8e6f",
        license="MIT",
        source_dir="third_party/openpencil",
        toolchain="bun",
        dev_command=["bun", "--bun", "run", "dev"],
        test_commands=[["bun", "run", "test"], ["bun", "run", "build"], ["bun", "run", "mcp:compile"]],
        plugin_id="com.superclaw.openpencil",
        passive_tools=[
            "open_document",
            "document_open",
            "batch_get",
            "get_selection",
            "snapshot_layout",
            "find_empty_space",
            "add_page",
            "remove_page",
            "rename_page",
            "reorder_page",
            "duplicate_page",
            "insert_node",
            "update_node",
            "delete_node",
            "move_node",
            "copy_node",
            "replace_node",
            "import_svg",
            "get_design_prompt",
            "batch_design",
            "design_skeleton",
            "design_content",
            "design_refine",
            "read_nodes",
            "codegen_plan",
            "codegen_submit_chunk",
            "codegen_assemble",
            "codegen_clean",
            "codegen_export",
            "get_variables",
            "set_variables",
            "set_themes",
            "get_design_md",
            "set_design_md",
            "export_design_md",
            "save_theme_preset",
            "load_theme_preset",
            "list_theme_presets",
            "theme_presets",
            "get_style_guide_tags",
            "get_style_guide",
            "search_all_unique_properties",
            "replace_all_matching_properties",
            "figma_import",
            "cli_control",
            "sdk_embed",
            "desktop_shell",
            "agent_team_orchestration",
            "acp_server",
        ],
        active_tools=["debug_validation_report", "debug_logs_tail", "debug_screenshot"],
    ),
}

FUSION_PROFILES: dict[str, list[str]] = {
    "all": ["superclaw", "osiris", "open-design", "openpencil"],
    "osiris": ["osiris"],
    "design": ["open-design"],
    "pencil": ["openpencil"],
}

ACTIVE_NETWORK_TOOLS = {
    "port_scan",
    "vulnerability_scan",
    "scanner_sweep",
    "tcp_scan",
    "service_fingerprint",
    "shodan_search",
}

ACTIVE_NETWORK_INTENT_TERMS = {
    "external",
    "exploit",
    "fingerprint",
    "masscan",
    "nmap",
    "port",
    "ports",
    "probe",
    "scan",
    "scanner",
    "shodan",
    "sweep",
    "tcp",
    "udp",
    "vuln",
    "vulnerability",
}

ACTIVE_NETWORK_PAYLOAD_KEYS = {
    "port",
    "ports",
    "probe_type",
    "scan_type",
    "scanner",
    "service_fingerprint",
}


FUSION_CAPABILITIES: tuple[FusionCapability, ...] = (
    FusionCapability(
        id="osiris.global_intelligence_layers",
        component="osiris",
        title="Global intelligence layers and map snapshots",
        upstream_evidence=["third_party/osiris/README.md", "third_party/osiris/src/app/api/*/route.ts"],
        projected_tools=[
            "intel_layers",
            "map_snapshot",
            "api_route_catalog",
            "aviation_layer",
            "maritime_layer",
            "cctv_layer",
            "seismic_layer",
            "fires_layer",
            "weather_layer",
            "space_layer",
            "news_streams",
            "telegram_osint",
            "conflict_zones",
        ],
        delivery_surfaces=["plugin", "api", "workbench_iframe", "evidence_bundle"],
    ),
    FusionCapability(
        id="osiris.recon_osint",
        component="osiris",
        title="Passive RECON OSINT lookups",
        upstream_evidence=["third_party/osiris/README.md", "third_party/osiris/src/app/api/osint/*/route.ts"],
        projected_tools=[
            "dns_lookup",
            "whois_lookup",
            "ssl_tls_inspector",
            "ip_intelligence",
            "cve_lookup",
            "bgp_lookup",
            "github_osint",
            "leak_lookup",
            "phone_lookup",
            "mac_lookup",
            "crypto_wallet_trace",
            "sanctions_search",
            "threat_feed",
        ],
        delivery_surfaces=["plugin", "api", "evidence_bundle"],
    ),
    FusionCapability(
        id="osiris.active_recon_gate",
        component="osiris",
        title="Active scanner and external recon gate",
        upstream_evidence=["third_party/osiris/README.md", "third_party/osiris/src/app/api/scanner/route.ts"],
        projected_tools=["port_scan", "vulnerability_scan", "scanner_sweep", "service_fingerprint", "shodan_search"],
        delivery_surfaces=["permission_gate", "human_gate", "evidence_bundle"],
        gate="human_gate",
    ),
    FusionCapability(
        id="osiris.ai_briefing_dossiers",
        component="osiris",
        title="AI analysis, briefings, and regional dossiers",
        upstream_evidence=[
            "third_party/osiris/src/app/api/ai/analyze/route.ts",
            "third_party/osiris/src/app/api/ai/briefing/route.ts",
            "third_party/osiris/src/app/api/region-dossier/route.ts",
        ],
        projected_tools=["ai_briefing", "region_dossier"],
        delivery_surfaces=["plugin", "api", "evidence_bundle"],
    ),
    FusionCapability(
        id="open-design.agent_runtime",
        component="open-design",
        title="Local agent runtime, CLI discovery, and BYOK proxy",
        upstream_evidence=["third_party/open-design/README.md", "third_party/open-design/apps/daemon/src/runtimes"],
        projected_tools=["agents_catalog", "byok_proxy_catalog", "agent_spawn", "byok_model_stream"],
        delivery_surfaces=["plugin", "api", "daemon", "evidence_bundle"],
        gate="human_gate",
    ),
    FusionCapability(
        id="open-design.skills_and_design_systems",
        component="open-design",
        title="Skills, design systems, visual directions, and device frames",
        upstream_evidence=["third_party/open-design/skills", "third_party/open-design/design-systems"],
        projected_tools=[
            "skills_catalog",
            "run_skill_artifact",
            "design_systems_catalog",
            "visual_directions_catalog",
            "device_frames_catalog",
        ],
        delivery_surfaces=["plugin", "api", "workbench_iframe", "evidence_bundle"],
    ),
    FusionCapability(
        id="open-design.artifact_delivery",
        component="open-design",
        title="Sandboxed artifacts, export bundles, critique, imports, and persistence",
        upstream_evidence=[
            "third_party/open-design/apps/daemon/src/artifact-create.ts",
            "third_party/open-design/apps/daemon/src/claude-design-import.ts",
            "third_party/open-design/apps/daemon/src/db.ts",
        ],
        projected_tools=[
            "artifact_preview",
            "export_bundle",
            "critique_self_check",
            "claude_design_import",
            "project_persistence",
        ],
        delivery_surfaces=["plugin", "api", "workbench_iframe", "evidence_bundle"],
    ),
    FusionCapability(
        id="open-design.media_and_handoff",
        component="open-design",
        title="Media generation, prompt templates, lifecycle, MCP live artifacts, desktop, deploy, plugins, and i18n",
        upstream_evidence=[
            "third_party/open-design/apps/daemon/src/media.ts",
            "third_party/open-design/apps/daemon/src/mcp-live-artifacts-server.ts",
            "third_party/open-design/apps/daemon/src/deploy.ts",
            "third_party/open-design/plugins",
        ],
        projected_tools=[
            "media_generation_catalog",
            "media_generation_request",
            "prompt_templates_catalog",
            "tools_dev_lifecycle",
            "desktop_shell",
            "desktop_sidecar_control",
            "mcp_live_artifacts",
            "deploy_handoff",
            "deploy_publish",
            "plugin_catalog",
            "i18n_catalog",
        ],
        delivery_surfaces=["plugin", "api", "compose_profile", "evidence_bundle"],
        gate="operator_control",
    ),
    FusionCapability(
        id="openpencil.document_canvas_mcp",
        component="openpencil",
        title=".op document, canvas, page, node, and SVG MCP operations",
        upstream_evidence=["third_party/openpencil/packages/pen-mcp/src/routes/document-routes.ts", "third_party/openpencil/packages/pen-mcp/src/routes/node-routes.ts"],
        projected_tools=[
            "open_document",
            "document_open",
            "batch_get",
            "get_selection",
            "snapshot_layout",
            "find_empty_space",
            "add_page",
            "remove_page",
            "rename_page",
            "reorder_page",
            "duplicate_page",
            "insert_node",
            "update_node",
            "delete_node",
            "move_node",
            "copy_node",
            "replace_node",
            "import_svg",
        ],
        delivery_surfaces=["plugin", "api", "workbench_iframe", "evidence_bundle"],
    ),
    FusionCapability(
        id="openpencil.design_codegen_variables",
        component="openpencil",
        title="Layered design workflow, codegen pipeline, variables, themes, and design.md",
        upstream_evidence=[
            "third_party/openpencil/packages/pen-mcp/src/routes/design-routes.ts",
            "third_party/openpencil/packages/pen-mcp/src/routes/codegen-routes.ts",
            "third_party/openpencil/packages/pen-mcp/src/routes/variable-routes.ts",
        ],
        projected_tools=[
            "get_design_prompt",
            "batch_design",
            "design_skeleton",
            "design_content",
            "design_refine",
            "read_nodes",
            "codegen_plan",
            "codegen_submit_chunk",
            "codegen_assemble",
            "codegen_clean",
            "codegen_export",
            "get_variables",
            "set_variables",
            "set_themes",
            "get_design_md",
            "set_design_md",
            "export_design_md",
            "save_theme_preset",
            "load_theme_preset",
            "list_theme_presets",
            "theme_presets",
        ],
        delivery_surfaces=["plugin", "api", "evidence_bundle"],
    ),
    FusionCapability(
        id="openpencil.style_platform_sdk",
        component="openpencil",
        title="Style guides, style operations, Figma import, CLI, desktop, ACP, SDK, and agent teams",
        upstream_evidence=["third_party/openpencil/README.md", "third_party/openpencil/packages", "third_party/openpencil/apps"],
        projected_tools=[
            "get_style_guide_tags",
            "get_style_guide",
            "search_all_unique_properties",
            "replace_all_matching_properties",
            "figma_import",
            "cli_control",
            "sdk_embed",
            "desktop_shell",
            "agent_team_orchestration",
            "acp_server",
        ],
        delivery_surfaces=["plugin", "api", "compose_profile", "evidence_bundle"],
    ),
    FusionCapability(
        id="openpencil.debug_diagnostics_gate",
        component="openpencil",
        title="Debug validation, logs, and screenshot diagnostics",
        upstream_evidence=["third_party/openpencil/packages/pen-mcp/src/routes/debug-routes.ts"],
        projected_tools=["debug_validation_report", "debug_logs_tail", "debug_screenshot"],
        delivery_surfaces=["permission_gate", "human_gate", "evidence_bundle"],
        gate="human_gate",
    ),
)


def fusion_root() -> Path:
    configured = os.environ.get("SUPERCLAW_FUSION_ROOT")
    if configured:
        return Path(configured).resolve()
    return Path.cwd().resolve()


def fusion_artifact_dir(path: Path | None = None) -> Path:
    configured = os.environ.get("SUPERCLAW_FUSION_ARTIFACT_DIR")
    return Path(configured).resolve() if configured else (path or superclaw_data_path("artifacts", "fusion")).resolve()


def fusion_status(root: Path | None = None, *, include_paths: bool = False) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    capabilities = fusion_capability_catalog(root=root)
    payload = {
        "schema_version": FUSION_SCHEMA_VERSION,
        "network_policy": {
            "passive_default": "allowed",
            "active_probe_default": "human_gate_required",
            "evidence": "action_artifact_required",
        },
        "profiles": FUSION_PROFILES,
        "capability_summary": capabilities["summary"],
        "components": {
            key: _component_status(component, root, include_paths=include_paths)
            for key, component in FUSION_COMPONENTS.items()
        },
    }
    if include_paths:
        payload["root"] = str(root)
    return payload


def fusion_capability_catalog(root: Path | None = None, *, include_paths: bool = False) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    capabilities = [_capability_payload(item, include_paths=include_paths) for item in FUSION_CAPABILITIES]
    by_component: dict[str, list[dict[str, Any]]] = {key: [] for key in FUSION_COMPONENTS}
    for item in capabilities:
        by_component.setdefault(str(item["component"]), []).append(item)
    return {
        "schema_version": FUSION_SCHEMA_VERSION,
        "source_inventory": fusion_source_inventory(root, include_paths=include_paths),
        "summary": {
            "capability_count": len(capabilities),
            "components": {key: len(value) for key, value in by_component.items()},
            "gated_capability_count": sum(1 for item in capabilities if item["gate"] != "passive"),
        },
        "components": by_component,
    }


def fusion_capability_audit(root: Path | None = None) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    inventory = fusion_source_inventory(root)
    native_verification = load_fusion_native_report(root=root)
    findings: list[dict[str, Any]] = []
    for component in FUSION_COMPONENTS.values():
        source = root / component.source_dir
        findings.append(
            _finding(
                f"{component.key}_source_imported",
                source.exists() and (source / "README.md").exists() and (source / "LICENSE").exists() and (source / "UPSTREAM_COMMIT").exists(),
                f"source={component.source_dir} readme/license/upstream_commit required",
            )
        )
    for capability in FUSION_CAPABILITIES:
        component = FUSION_COMPONENTS[capability.component]
        exposed = set(component.passive_tools + component.active_tools)
        missing = sorted(set(capability.projected_tools) - exposed)
        findings.append(
            _finding(
                f"{capability.id}_projected",
                not missing,
                f"missing_tools={missing}",
            )
        )
        if capability.gate != "passive":
            gated_tools = sorted(set(capability.projected_tools) & set(component.active_tools))
            ungated = [tool for tool in gated_tools if not _requires_human_gate(component.key, tool)]
            findings.append(
                _finding(
                    f"{capability.id}_gated",
                    bool(gated_tools) and not ungated,
                    f"gated_tools={gated_tools} ungated_tools={ungated}",
                )
            )
    open_design = inventory["open-design"]
    findings.append(
        _finding(
            "open_design_skill_catalog_count",
            int(open_design["skills_count"]) >= 100,
            f"skills_count={open_design['skills_count']}",
        )
    )
    findings.append(
        _finding(
            "open_design_design_system_catalog_count",
            int(open_design["design_systems_count"]) >= 100,
            f"design_systems_count={open_design['design_systems_count']}",
        )
    )
    osiris = inventory["osiris"]
    findings.append(
        _finding(
            "osiris_api_routes_cataloged",
            int(osiris["api_route_count"]) >= 25 and "api_route_catalog" in FUSION_COMPONENTS["osiris"].passive_tools,
            f"api_route_count={osiris['api_route_count']}",
        )
    )
    openpencil = inventory["openpencil"]
    mcp_tools = set(openpencil["mcp_tool_names"])
    exposed_openpencil = set(FUSION_COMPONENTS["openpencil"].passive_tools + FUSION_COMPONENTS["openpencil"].active_tools)
    missing_mcp = sorted(mcp_tools - exposed_openpencil)
    findings.append(
        _finding(
            "openpencil_mcp_tools_projected",
            not missing_mcp,
            f"mcp_tools={len(mcp_tools)} missing={missing_mcp}",
        )
    )
    findings.append(
        _finding(
            "active_tools_fail_closed",
            all(_requires_human_gate(component.key, tool) for component in FUSION_COMPONENTS.values() for tool in component.active_tools),
            "all active_tools require SuperClaw human gate",
        )
    )
    return {
        "schema_version": FUSION_SCHEMA_VERSION,
        "ok": all(item["passed"] for item in findings),
        "source_inventory": inventory,
        "native_verification": native_verification,
        "findings": findings,
    }


def fusion_source_inventory(root: Path | None = None, *, include_paths: bool = False) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    osiris_root = root / "third_party" / "osiris"
    open_design_root = root / "third_party" / "open-design"
    openpencil_root = root / "third_party" / "openpencil"
    agent_native_root = openpencil_root / "packages" / "agent-native"
    osiris_routes = sorted(_relative_posix(path, osiris_root) for path in (osiris_root / "src" / "app" / "api").glob("**/route.ts"))
    open_design_skills = sorted(path.name for path in (open_design_root / "skills").glob("*") if path.is_dir())
    open_design_systems = sorted(path.name for path in (open_design_root / "design-systems").glob("*") if path.is_dir())
    openpencil_tools = _openpencil_mcp_tool_names(openpencil_root)
    inventory: dict[str, Any] = {
        "osiris": {
            "api_route_count": len(osiris_routes),
            "api_routes": osiris_routes,
        },
        "open-design": {
            "skills_count": len(open_design_skills),
            "design_systems_count": len(open_design_systems),
            "sample_skills": open_design_skills[:12],
            "sample_design_systems": open_design_systems[:12],
        },
        "openpencil": {
            "package_count": len([path for path in (openpencil_root / "packages").glob("*") if path.is_dir()]),
            "mcp_tool_count": len(openpencil_tools),
            "mcp_tool_names": openpencil_tools,
            "agent_native_present": agent_native_root.exists() and (agent_native_root / "napi" / "package.json").exists(),
            "agent_native_commit": _read_optional_text(agent_native_root / "UPSTREAM_COMMIT"),
        },
    }
    if include_paths:
        inventory["osiris"]["root"] = _display_path(osiris_root)
        inventory["open-design"]["root"] = _display_path(open_design_root)
        inventory["openpencil"]["root"] = _display_path(openpencil_root)
    return inventory


def fusion_source_fingerprint(root: Path | None = None) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    components: dict[str, Any] = {}
    for key, component in FUSION_COMPONENTS.items():
        source_root = root / component.source_dir
        data: dict[str, Any] = {
            "upstream_commit": _read_optional_text(source_root / "UPSTREAM_COMMIT"),
            "test_commands": component.test_commands,
        }
        if key == "openpencil":
            data["agent_native_commit"] = _read_optional_text(source_root / "packages" / "agent-native" / "UPSTREAM_COMMIT")
        components[key] = data
    body = {"schema_version": FUSION_NATIVE_REPORT_VERSION, "components": components}
    return {**body, "digest": _stable_digest(body)}


def load_fusion_native_report(root: Path | None = None) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    configured = os.environ.get("SUPERCLAW_FUSION_NATIVE_REPORT")
    report_path = Path(configured).resolve() if configured else root / ".superclaw" / "fusion-native-report.json"
    if not report_path.exists():
        return {"schema_version": FUSION_NATIVE_REPORT_VERSION, "report_present": False, "ok": None, "results": []}
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "schema_version": FUSION_NATIVE_REPORT_VERSION,
            "report_present": True,
            "ok": False,
            "error": f"native report unreadable: {exc}",
            "results": [],
        }
    results = list(report.get("results", [])) if isinstance(report, dict) else []
    statuses = [str(item.get("status", "unknown")) for item in results if isinstance(item, dict)]
    expected_fingerprint = fusion_source_fingerprint(root=root)
    reported_fingerprint = report.get("source_fingerprint") if isinstance(report, dict) else None
    source_fingerprint_ok = (
        isinstance(reported_fingerprint, dict)
        and reported_fingerprint.get("digest") == expected_fingerprint["digest"]
    )
    source_fingerprint_status = "matched" if source_fingerprint_ok else ("missing" if not reported_fingerprint else "mismatch")
    report_ok = bool(report.get("ok")) if isinstance(report, dict) and "ok" in report else all(status == "passed" for status in statuses)
    return {
        "schema_version": str(report.get("schema_version", FUSION_NATIVE_REPORT_VERSION)) if isinstance(report, dict) else FUSION_NATIVE_REPORT_VERSION,
        "report_present": True,
        "ok": report_ok and source_fingerprint_ok,
        "generated_at": report.get("generated_at") if isinstance(report, dict) else None,
        "source_fingerprint": reported_fingerprint,
        "expected_source_fingerprint": expected_fingerprint,
        "source_fingerprint_ok": source_fingerprint_ok,
        "source_fingerprint_status": source_fingerprint_status,
        "summary": {
            "total": len(statuses),
            "passed": statuses.count("passed"),
            "failed": statuses.count("failed"),
            "blocked": statuses.count("blocked"),
        },
        "results": results,
    }


def fusion_start_plan(
    profile: str,
    *,
    root: Path | None = None,
    execute: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    if profile not in FUSION_PROFILES:
        return {
            "profile": profile,
            "execute": execute,
            "ok": False,
            "status": "unknown_profile",
            "detail": f"unknown fusion profile: {profile}",
            "steps": [],
        }
    components = _profile_components(profile)
    steps: list[dict[str, Any]] = []
    for component_key in components:
        if component_key == "superclaw":
            steps.append(
                {
                    "component": "superclaw",
                    "cwd": str(root),
                    "command": ["python", "-m", "uvicorn", "apps.api.main:app", "--host", "127.0.0.1", "--port", "8788"],
                    "url": "http://127.0.0.1:8788",
                }
            )
            steps.append(
                {
                    "component": "superclaw-web",
                    "cwd": str(root / "apps" / "web"),
                    "command": ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "5174"],
                    "url": "http://127.0.0.1:5174",
                }
            )
            continue
        component = FUSION_COMPONENTS[component_key]
        steps.append(
            {
                "component": component.key,
                "cwd": _display_path(root / component.source_dir),
                "command": component.dev_command,
                "url": _component_url(component.key),
            }
        )
    payload: dict[str, Any] = {"profile": profile, "execute": execute, "steps": steps}
    if execute:
        payload["execution"] = _execute_fusion_compose_profile(profile, root=root, timeout_seconds=timeout_seconds)
    return payload


def _run_fusion_compose(
    command: list[str],
    *,
    root: Path,
    timeout_seconds: int,
    success_status: str,
    success_detail: str,
    failure_detail: str,
) -> dict[str, Any]:
    """Run a docker compose command at the fusion root, fail-closed on every error path.

    Returns a sanitized execution record. Used by start/stop/run-status so the
    docker invocation, redaction, and error classification live in one place.
    """
    compose_file = root / "docker-compose.yml"
    base: dict[str, Any] = {
        "command": command,
        "cwd": str(root),
        "compose_file": "docker-compose.yml",
    }
    if not compose_file.exists():
        return {
            **base,
            "ok": False,
            "status": "compose_file_missing",
            "detail": "docker-compose.yml was not found at the fusion root.",
        }
    try:
        completed = subprocess.run(
            command,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError:
        return {
            **base,
            "ok": False,
            "status": "docker_unavailable",
            "detail": "docker executable was not found on PATH.",
        }
    except subprocess.TimeoutExpired as exc:
        return {
            **base,
            "ok": False,
            "status": "timeout",
            "detail": f"docker compose did not finish within {timeout_seconds}s.",
            "stdout": _redact_execution_text(exc.stdout or "", root=root),
            "stderr": _redact_execution_text(exc.stderr or "", root=root),
        }
    except OSError as exc:
        # PermissionError (e.g. docker socket denied) and other OS errors must
        # fail closed with a sanitized message, never escape unstructured.
        return {
            **base,
            "ok": False,
            "status": "exec_error",
            "detail": _redact_execution_text(f"{type(exc).__name__}: {exc}", root=root),
        }

    stdout = _redact_execution_text(completed.stdout or "", root=root)
    stderr = _redact_execution_text(completed.stderr or "", root=root)
    if completed.returncode != 0:
        return {
            **base,
            "ok": False,
            "status": "failed",
            "detail": failure_detail,
            "returncode": completed.returncode,
            "stdout": stdout,
            "stderr": stderr,
        }
    return {
        **base,
        "ok": True,
        "status": success_status,
        "detail": success_detail,
        "returncode": completed.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }


def _execute_fusion_compose_profile(profile: str, *, root: Path, timeout_seconds: int) -> dict[str, Any]:
    return _run_fusion_compose(
        ["docker", "compose", "--profile", profile, "up", "--build", "-d"],
        root=root,
        timeout_seconds=timeout_seconds,
        success_status="started",
        success_detail="docker compose profile started.",
        failure_detail="docker compose up failed.",
    )


def fusion_stop_plan(
    profile: str,
    *,
    root: Path | None = None,
    execute: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    """Emit (or execute) a teardown plan for the imported product surfaces of a profile."""
    root = (root or fusion_root()).resolve()
    if profile not in FUSION_PROFILES:
        return {
            "profile": profile,
            "execute": execute,
            "ok": False,
            "status": "unknown_profile",
            "detail": f"unknown fusion profile: {profile}",
            "components": [],
            "command": [],
        }
    components = _profile_components(profile)
    command = ["docker", "compose", "--profile", profile, "down"]
    # No plan-level cwd: the operator-safe plan should not echo the host fusion
    # root. The execute path's cwd comes from the shared runner (matching the
    # test-locked start contract) only when --execute actually runs the command.
    payload: dict[str, Any] = {
        "profile": profile,
        "execute": execute,
        "components": components,
        "command": command,
    }
    if execute:
        payload["execution"] = _run_fusion_compose(
            command,
            root=root,
            timeout_seconds=timeout_seconds,
            success_status="stopped",
            success_detail="docker compose profile stopped.",
            failure_detail="docker compose down failed.",
        )
    return payload


# docker-compose.yml service names -> fusion component keys. Mirrors the service
# definitions in docker-compose.yml; the compose file is the contract.
_COMPOSE_SERVICE_TO_COMPONENT: dict[str, str] = {
    "superclaw-api": "superclaw",
    "fusion-osiris": "osiris",
    "fusion-open-design": "open-design",
    "fusion-openpencil": "openpencil",
}


def _is_service_record(record: dict[str, Any]) -> bool:
    """A real compose-ps record always identifies its service (Service/Name)."""
    return bool(str(record.get("Service") or record.get("Name") or "").strip())


def _records_from_value(value: Any) -> tuple[list[dict[str, Any]], bool]:
    """Extract service records from one parsed JSON value.

    Returns ``(records, shape_ok)``. ``shape_ok`` is True only when ``value`` is
    a recognizable compose-ps shape — a service dict, or a list whose every
    non-empty element is a service dict (an empty list is the legitimate "nothing
    running" case). Scalars, null, non-service dicts, and lists containing junk
    elements are rejected (``shape_ok=False``) so the caller fails closed instead
    of treating valid-but-wrong-shape JSON as "no services".
    """
    if isinstance(value, dict):
        return ([value], True) if _is_service_record(value) else ([], False)
    if isinstance(value, list):
        records: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict) and _is_service_record(item):
                records.append(item)
            else:
                return [], False
        return records, True
    return [], False


def _parse_compose_ps(stdout: str) -> tuple[list[dict[str, Any]], bool]:
    """Parse `docker compose ps --format json` output.

    Returns ``(records, parsed_ok)``. Compose emits either a single JSON array
    (newer releases) or newline-delimited JSON objects (older releases); accept
    both. When the whole-text parse fails (e.g. a stray warning line), fall back
    to per-line parsing — there a line may itself be an array, so reuse
    ``_records_from_value`` rather than silently dropping list-shaped lines.

    ``parsed_ok`` is False when stdout was non-empty but no recognizable
    compose-ps shape could be read from it (garbage text, scalars, or
    valid-but-wrong-shape JSON): the caller must fail closed instead of reporting
    "nothing running", since an empty service list would otherwise mask it.
    """
    text = (stdout or "").strip()
    if not text:
        return [], True
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return _records_from_value(parsed)
    records: list[dict[str, Any]] = []
    recognized = False
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # Non-JSON line (e.g. a stray docker warning) — ignore it.
            continue
        line_records, shape_ok = _records_from_value(parsed)
        if not shape_ok:
            # A JSON-parseable line with a wrong shape means the output is not
            # trustworthy compose-ps data: fail closed rather than silently
            # dropping it and reporting the surviving lines as the full picture.
            return [], False
        recognized = True
        records.extend(line_records)
    return records, recognized


def fusion_run_status(
    profile: str,
    *,
    root: Path | None = None,
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    """Report the live docker compose state for the surfaces of a profile.

    Fail-closed: docker/compose problems return ``ok=False`` with a classified
    status instead of pretending nothing is running. On success only sanitized
    per-service fields are surfaced (no raw stdout, no host paths).
    """
    root = (root or fusion_root()).resolve()
    if profile not in FUSION_PROFILES:
        return {
            "profile": profile,
            "components": [],
            "command": [],
            "ok": False,
            "status": "unknown_profile",
            "detail": f"unknown fusion profile: {profile}",
            "services": [],
        }
    components = _profile_components(profile)
    command = ["docker", "compose", "--profile", profile, "ps", "--format", "json", "--all"]
    execution = _run_fusion_compose(
        command,
        root=root,
        timeout_seconds=timeout_seconds,
        success_status="queried",
        success_detail="docker compose ps queried.",
        failure_detail="docker compose ps failed.",
    )
    payload: dict[str, Any] = {
        "profile": profile,
        "components": components,
        "command": command,
        "ok": bool(execution.get("ok")),
        "status": execution["status"],
        "detail": execution["detail"],
    }
    if not execution.get("ok"):
        # Preserve sanitized diagnostics but never the raw ps payload.
        for key in ("returncode", "stderr"):
            if key in execution:
                payload[key] = execution[key]
        payload["services"] = []
        return payload

    records, parsed_ok = _parse_compose_ps(execution.get("stdout", ""))
    if not parsed_ok:
        # Compose exited 0 but its output was non-empty and unparsable: fail
        # closed rather than reporting an empty (looks-like-nothing-running) list.
        payload["ok"] = False
        payload["status"] = "parse_failed"
        payload["detail"] = "docker compose ps returned output that could not be parsed."
        payload["services"] = []
        return payload

    services: list[dict[str, Any]] = []
    for record in records:
        service_name = str(record.get("Service") or record.get("Name") or "")
        component = _COMPOSE_SERVICE_TO_COMPONENT.get(service_name)
        state = str(record.get("State") or "").lower()
        health_raw = record.get("Health")
        health = str(health_raw).lower() if health_raw else None
        services.append(
            {
                "service": service_name,
                "component": component,
                "state": state,
                "running": state == "running",
                "health": health or None,
                "url": _component_url(component) if component and component != "superclaw" else None,
            }
        )
    payload["services"] = services
    return payload


def fusion_test_plan(profile: str, *, root: Path | None = None) -> dict[str, Any]:
    root = (root or fusion_root()).resolve()
    components = _profile_components(profile)
    third_party_components = {component for component in components if component != "superclaw"}
    native_report = load_fusion_native_report(root=root)
    native_results = [
        item
        for item in native_report.get("results", [])
        if isinstance(item, dict) and item.get("component") in third_party_components
    ]
    native_by_command = {
        (str(item.get("component")), tuple(item.get("command", []))): item
        for item in native_results
        if isinstance(item.get("command"), list)
    }
    steps: list[dict[str, Any]] = []
    for component_key in components:
        if component_key == "superclaw":
            audit = fusion_capability_audit(root=root)
            steps.append(
                {
                    "component": "superclaw",
                    "cwd": str(root),
                    "command": ["python", "-m", "superclaw.cli", "fusion", "audit", "--json"],
                    "status": "passed" if audit["ok"] else "failed",
                    "detail": f"fusion capability audit {'passed' if audit['ok'] else 'failed'}",
                }
            )
            continue
        component = FUSION_COMPONENTS[component_key]
        for command in component.test_commands:
            reported = native_by_command.get((component.key, tuple(command)))
            step: dict[str, Any] = {"component": component.key, "cwd": _display_path(root / component.source_dir), "command": command}
            if reported:
                step["status"] = str(reported.get("status", "unknown"))
                if reported.get("detail"):
                    step["native_detail"] = str(reported["detail"])
            else:
                step["status"] = "not_reported"
            steps.append(step)

    statuses = [str(step.get("status", "unknown")) for step in steps if step.get("status") != "not_reported"]
    not_reported_steps = sum(1 for step in steps if step.get("status") == "not_reported")
    profile_native_ok = (
        bool(native_report.get("report_present"))
        and native_report.get("source_fingerprint_ok") is True
        and statuses.count("failed") == 0
        and statuses.count("blocked") == 0
        and not_reported_steps == 0
        and len(statuses) == len(steps)
    )
    summary = {
        "native_report_present": bool(native_report.get("report_present")),
        "source_fingerprint_ok": native_report.get("source_fingerprint_ok"),
        "native_ok": profile_native_ok,
        "reported": len(statuses),
        "passed": statuses.count("passed"),
        "failed": statuses.count("failed"),
        "blocked": statuses.count("blocked"),
        "not_reported_steps": not_reported_steps,
    }
    summary["ok"] = (
        summary["native_report_present"]
        and summary["native_ok"] is True
        and summary["failed"] == 0
        and summary["blocked"] == 0
        and summary["not_reported_steps"] == 0
        and summary["reported"] == len(steps)
    )
    return {
        "profile": profile,
        "steps": steps,
        "summary": summary,
        "native_verification": {
            "schema_version": native_report.get("schema_version", FUSION_NATIVE_REPORT_VERSION),
            "report_present": bool(native_report.get("report_present")),
            "ok": native_report.get("ok"),
            "generated_at": native_report.get("generated_at"),
            "source_fingerprint": native_report.get("source_fingerprint"),
            "expected_source_fingerprint": native_report.get("expected_source_fingerprint"),
            "source_fingerprint_ok": native_report.get("source_fingerprint_ok"),
            "source_fingerprint_status": native_report.get("source_fingerprint_status"),
            "results": native_results,
        },
    }


def record_fusion_action(
    *,
    component: str,
    action: str,
    tool_name: str | None = None,
    payload: dict[str, Any] | None = None,
    artifact_refs: list[dict[str, Any]] | None = None,
    artifact_dir: Path | None = None,
    human_gate_approved: bool = False,
    permission_result: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    safe_component = _require_component(component)
    safe_action = _safe_segment(action)
    safe_tool = _safe_segment(tool_name or "none")
    payload = payload or {}
    requires_gate = _requires_human_gate(safe_component, safe_tool, action=safe_action, payload=payload)
    if requires_gate:
        if not human_gate_approved:
            raise FusionPermissionError(f"fusion tool requires human gate: {safe_component}.{safe_tool}")
        if not _permission_result_approved(permission_result):
            raise FusionPermissionError(f"fusion tool requires approved permission result: {safe_component}.{safe_tool}")

    artifact_refs = [_sanitize_artifact_ref(item) for item in (artifact_refs or []) if isinstance(item, dict)]
    safe_permission_result = _sanitize_permission_result(permission_result) if permission_result else None
    now = datetime.now(UTC).isoformat()
    digest = _stable_digest(payload)
    artifact_id = f"fusion_{safe_component}_{safe_action}_{digest[-12:]}_{uuid.uuid4().hex[:12]}"
    record = {
        "schema_version": FUSION_SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "run_id": run_id,
        "component": safe_component,
        "action": safe_action,
        "tool_name": safe_tool,
        "status": "recorded",
        "human_gate_approved": human_gate_approved,
        "payload_digest": digest,
        "artifact_refs": artifact_refs,
        "recorded_at": now,
    }
    if safe_permission_result:
        record["permission_result"] = safe_permission_result
    root = fusion_artifact_dir(artifact_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{artifact_id}.json").write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    return {"status": "recorded", "artifact_id": artifact_id}


def load_fusion_artifact(artifact_id: str, *, artifact_dir: Path | None = None) -> dict[str, Any]:
    requested_id = str(artifact_id)
    safe_id = _safe_segment(requested_id)
    if safe_id != requested_id:
        raise FileNotFoundError("fusion artifact not found")
    path = fusion_artifact_dir(artifact_dir) / f"{safe_id}.json"
    if not path.exists():
        raise FileNotFoundError("fusion artifact not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _sanitize_artifact_ref(ref: dict[str, Any]) -> dict[str, str]:
    artifact_id = _safe_public_identifier(ref.get("artifact_id") or ref.get("id"), default="artifact")
    kind = _safe_public_identifier(ref.get("kind"), default="artifact")
    return {"artifact_id": artifact_id, "kind": kind}


def _permission_result_approved(result: dict[str, Any] | None) -> bool:
    if not isinstance(result, dict):
        return False
    decision = str(result.get("decision") or result.get("status") or "").lower()
    return decision in {"approved", "granted", "allowed", "allow", "passed"}


def _sanitize_permission_result(result: dict[str, Any] | None) -> dict[str, str] | None:
    if not isinstance(result, dict):
        return None
    safe: dict[str, str] = {}
    decision = str(result.get("decision") or result.get("status") or "").lower()
    if decision:
        safe["decision"] = _safe_segment(decision)
    if result.get("artifact_id") or result.get("id"):
        safe["artifact_id"] = _safe_public_identifier(result.get("artifact_id") or result.get("id"), default="permission")
    if result.get("policy_id"):
        safe["policy_id"] = _safe_public_identifier(result["policy_id"], default="policy")
    return safe or None


def _safe_public_identifier(value: Any, *, default: str) -> str:
    text = str(value or default)
    if contains_secret(text):
        return default
    return _safe_segment(text)


def sanitized_plugin_projection(plugin_id: str) -> list[dict[str, Any]]:
    component = next((item for item in FUSION_COMPONENTS.values() if item.plugin_id == plugin_id), None)
    if component is None:
        raise KeyError(f"unknown fusion plugin: {plugin_id}")
    return [
        {
            "name": tool,
            "description": f"{component.display_name} fusion capability: {tool.replace('_', ' ')}.",
            "inputSchema": {"type": "object", "additionalProperties": True},
        }
        for tool in [*component.passive_tools, *component.active_tools]
    ]


def _capability_payload(capability: FusionCapability, *, include_paths: bool = False) -> dict[str, Any]:
    data = asdict(capability)
    if not include_paths:
        data["upstream_evidence"] = [item.replace("\\", "/") for item in capability.upstream_evidence]
    return data


def _component_status(component: FusionComponent, root: Path, *, include_paths: bool = False) -> dict[str, Any]:
    source_path = root / component.source_dir
    data = asdict(component)
    data.update(
        {
            "present": source_path.exists(),
            "readme_present": (source_path / "README.md").exists(),
            "license_present": (source_path / "LICENSE").exists(),
        }
    )
    if include_paths:
        data["source_path"] = _display_path(source_path)
    else:
        data.pop("source_dir", None)
    return data


def _finding(name: str, passed: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "detail": detail}


def _relative_posix(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _openpencil_mcp_tool_names(openpencil_root: Path) -> list[str]:
    source_root = openpencil_root / "packages" / "pen-mcp" / "src"
    files = list((source_root / "routes").glob("*.ts"))
    files.extend((source_root / "tools").glob("layered-design-defs.ts"))
    names: set[str] = set()
    pattern = re.compile(r"name:\s*'([A-Za-z0-9_:-]+)'")
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        names.update(match.group(1) for match in pattern.finditer(text))
    return sorted(names)


def _read_optional_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _profile_components(profile: str) -> list[str]:
    if profile not in FUSION_PROFILES:
        raise ValueError(f"unknown fusion profile: {profile}")
    return FUSION_PROFILES[profile]


def _component_url(component: str) -> str | None:
    env_urls = {
        "osiris": "SUPERCLAW_FUSION_OSIRIS_URL",
        "open-design": "SUPERCLAW_FUSION_OPEN_DESIGN_URL",
        "openpencil": "SUPERCLAW_FUSION_OPENPENCIL_URL",
    }
    local_defaults = {
        "osiris": "http://127.0.0.1:3000",
        "open-design": "http://127.0.0.1:3001",
        "openpencil": "http://127.0.0.1:3002",
    }
    env_name = env_urls.get(component)
    if env_name:
        return local_service_url(env_name, local_defaults[component])
    return local_defaults.get(component)


def _require_component(component: str) -> str:
    safe = _safe_segment(component)
    if safe not in FUSION_COMPONENTS:
        raise ValueError(f"unknown fusion component: {component}")
    return safe


def _requires_human_gate(
    component: str,
    tool_name: str,
    *,
    action: str | None = None,
    payload: dict[str, Any] | None = None,
) -> bool:
    if tool_name in ACTIVE_NETWORK_TOOLS:
        return True
    fusion_component = FUSION_COMPONENTS.get(component)
    if fusion_component and tool_name in fusion_component.active_tools:
        return True
    if component == "osiris" and _has_active_network_intent(tool_name, action=action, payload=payload):
        return True
    return False


def _has_active_network_intent(tool_name: str, *, action: str | None = None, payload: dict[str, Any] | None = None) -> bool:
    text = " ".join(str(value or "") for value in (tool_name, action)).lower()
    tokens = {token for token in re.split(r"[^a-z0-9]+", text) if token}
    if tokens & ACTIVE_NETWORK_INTENT_TERMS:
        return True
    return _payload_has_active_network_intent(payload)


def _payload_has_active_network_intent(value: Any, *, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if isinstance(value, dict):
        for key, child in value.items():
            if _payload_key_has_active_network_intent(str(key)):
                return True
            if _payload_has_active_network_intent(child, depth=depth + 1):
                return True
    elif isinstance(value, list):
        return any(_payload_has_active_network_intent(item, depth=depth + 1) for item in value)
    return False


def _payload_key_has_active_network_intent(key: str) -> bool:
    safe_key = _safe_payload_key(key)
    if safe_key in ACTIVE_NETWORK_PAYLOAD_KEYS:
        return True
    tokens = {token for token in safe_key.split("_") if token}
    return bool(tokens & ACTIVE_NETWORK_INTENT_TERMS)


def _safe_payload_key(key: str) -> str:
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key)
    return re.sub(r"[^a-z0-9]+", "_", normalized.lower()).strip("_")


def _safe_segment(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in str(value))
    if not safe:
        raise ValueError("empty fusion identifier")
    return safe


def _redact_execution_text(text: str, *, root: Path, max_length: int = 4000) -> str:
    value = str(text or "")
    if not value:
        return ""
    # Replace the (more specific) fusion root first, then the home directory, so
    # host absolute paths under the user's home are not echoed in diagnostics.
    root_text = str(root)
    root_posix = root.as_posix()
    if root_text:
        value = value.replace(root_text, "[FUSION_ROOT]")
    if root_posix and root_posix != root_text:
        value = value.replace(root_posix, "[FUSION_ROOT]")
    try:
        home = Path.home()
    except (RuntimeError, OSError):
        home = None
    if home is not None:
        home_text = str(home)
        home_posix = home.as_posix()
        if home_text:
            value = value.replace(home_text, "[HOME]")
        if home_posix and home_posix != home_text:
            value = value.replace(home_posix, "[HOME]")
    # Secret scrubbing goes through the canonical scanner (single source of truth
    # shared with adversarial detection) — never a fusion-local regex that would
    # drift from it. See superclaw.secrets_scan.SECRET_PATTERNS.
    value = redact_secrets(value)
    if len(value) > max_length:
        value = value[:max_length].rstrip() + "...[truncated]"
    return value


def _stable_digest(payload: Any) -> str:
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(body).hexdigest()}"


def _display_path(path: Path) -> str:
    return path.as_posix()
