from __future__ import annotations

import html
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from superclaw.telemetry_upload import UploadSpooler

import httpx
import typer

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion
    from prompt_toolkit.formatted_text import HTML, FormattedText
    from prompt_toolkit.history import FileHistory, InMemoryHistory
    from prompt_toolkit.styles import Style
except ModuleNotFoundError:  # pragma: no cover - package dependency installs it; fallback keeps source-tree runs usable.
    PromptSession = None
    Completer = object
    Completion = None
    HTML = None
    FormattedText = None
    FileHistory = None
    InMemoryHistory = None
    Style = None

from superclaw.adversarial import adversarial_rule_specs, apply_adversarial_profile
from superclaw.backends import default_backends
from superclaw.logging_config import configure_logging
from superclaw.clawhunt import ClawHuntClient
from superclaw.file_view import FILE_VIEW_SCAN_CAP
from superclaw.clawhunt_auth import (
    ClawHuntAccountClient,
    SUPERCLAW_LOGIN_SOURCE,
    build_clawhunt_browser_login_url,
    classify_login_probe_result,
    clawhunt_auth_summary,
    clear_clawhunt_auth,
    extract_login_session,
    hydrate_clawhunt_auth_environment,
    login_probe_error_result,
    save_clawhunt_auth,
    saved_clawhunt_access_token,
)
from superclaw.environment import (
    app_environment,
    clawhunt_base_url,
    default_artifact_dir,
    default_state_path,
    hydrate_official_root_public_keys,
    superclaw_data_path,
    superclaw_home,
)
from superclaw import chat_turn as chat_turn_module
from superclaw.chat_runtime import resolve_chat_runtime
from superclaw.proc_compat import pid_is_alive, terminate_pid
from superclaw.relay_key import (
    RelayKeyError,
    clear_relay_key,
    ensure_relay_key,
    relay_balance,
    relay_status,
    relay_usage,
)
from superclaw.relay_packages import relay_packages
from superclaw.chat_turn import SHELL_MODES, classify_intent, direct_chat_prompt, execute_direct_chat_turn, format_chat_history
from superclaw import workspace_resolver
from superclaw.desktop_runtime import (
    DesktopServiceHandle,  # noqa: F401 — tests patch/construct via cli_module attribute
    DesktopRuntimeSupervisor,
    desktop_service_handle_payload,
    probe_service_status,
    shutdown_process_pid,
)
from superclaw.capability_atlas import (
    CapabilityAtlasError,
    adaptable_capabilities,
    atlas_summary,
    category_matrix,
    coverage_report,
    get_capability,
    load_capability_atlas,
    search_capabilities,
    suggest_capabilities,
    validate_facets,
)
from superclaw.capability_submission import (
    DeveloperCapabilitySubmissionError,
    get_developer_capability_submission,
    submit_developer_capability_upload,
)
from superclaw.capability_devtools import (
    CapabilityDevtoolError,
    build_capability_artifact,
    list_approved_capability_registry,
    query_capability_review_status,
    submit_capability_for_review,
    sync_approved_capability_registry,
    validate_capability_artifact,
)
from superclaw.capability_r2 import CapabilityR2Error, load_r2_config, publish_local_capability_cloud_to_r2
from superclaw.catalog_resolver import (
    CATALOG_KINDS,
    default_companies_root,
    default_registry_root,
    refresh_catalog,
    resolve_catalog,
    resolve_trust_state,
    trust_derivation_to_dict,
)
from superclaw.evals import CASE_ID, EvalRunner, default_eval_root
from superclaw.liveness import ACTIVE_RUN_STATUSES
from superclaw.fusion import (
    fusion_capability_audit,
    fusion_capability_catalog,
    fusion_run_status,
    fusion_start_plan,
    fusion_status,
    fusion_stop_plan,
    fusion_test_plan,
    load_fusion_native_report,
)
from superclaw.harness import (
    adapt_agent,
    adapt_skill,
    emit_harness_artifacts,
    get_harness_profile,
    harness_matrix,
    inventory_plugins,
    parse_markdown_with_frontmatter,
    runtime_profile,
    validate_harness_artifacts,
)
from superclaw.media import (
    RunningHubMediaError,
    RunningHubMediaRequest,
    RunningHubMediaRenderRequest,
    RunningHubMediaUploadRequest,
    query_runninghub_media_task,
    render_runninghub_media_task,
    runninghub_media_catalog,
    runninghub_media_doctor,
    runninghub_media_status,
    submit_runninghub_media_task,
    upload_runninghub_media_file,
)
from superclaw.models import AgentProfile, ArtifactRef, ChildAggregationPolicy, CompanyProfile, ContinuationPolicy, GoalSpec, ISSUE_KINDS, Issue, IssueKind, REVIEW_POLICIES, ReviewPolicy, RunSession, TaskTopology, WorkspaceProfile
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw import team_kernel
from superclaw import goal_mode
from superclaw.company_scope import CompanyScope
from superclaw.team_routines import author_routine
from superclaw.plugin_cloud import (
    DEFAULT_CLOUD_ROOT,
    PluginCloudSyncError,
    install_plugin_from_cloud_metadata,
    resolve_registry_plugin_version,
    search_registry_plugins,
    sync_cloud_governance,
    upload_evidence_summary,
)
from superclaw.plugin_conformance import plugin_conformance_payload, run_plugin_conformance
from superclaw.plugin_codex_view import PluginCodexViewError, export_codex_compatible_view
from superclaw.skill_build import (
    SkillBuildError,
    build_and_install_skill_plugin,
)
from superclaw.skill_store import (
    SkillImportRecord,
    SkillStoreError,
    default_skill_revocation_file as _default_skill_revocation_file,
    import_skill as import_native_skill,
    list_skills as list_native_skills,
)
from superclaw.skill_sync import (
    SkillSyncError,
    native_skill_status,
    sync_native_skills,
    sync_plugin_skills,
    unsync_plugin_skills,
)
from superclaw.plugin_config import (
    PluginConfigurationError,
    delete_plugin_secret,
    plugin_secret_status,
    set_plugin_secret,
    set_plugin_setting,
)
from superclaw.plugin_devkit import PluginDevkitError, init_plugin_package, pack_plugin_package, run_plugin_dev
from superclaw.plugin_evidence import clear_plugin_evidence, diagnose_plugin_runtime, list_plugin_evidence, prune_plugin_evidence
from superclaw.plugin_ingestion import ClawHuntPluginIngestionError, ingest_clawhunt_delivery_plugin
from superclaw.plugin_mcp_proxy import build_mcp_config, project_plugin_tools, projected_tool_name
from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION, default_entitlement_file, default_policy_file, invoke_cached_plugin_tool
from superclaw.plugin_release import (
    load_manual_release_evidence,
    plugin_release_checklist_payload,
    run_plugin_release_checklist,
)
from superclaw.plugin_submission import DeveloperUploadReviewError, get_developer_plugin_submission, submit_developer_plugin_upload
from superclaw.plugin_updates import PluginUpdateReviewError, review_plugin_update
from superclaw.plugin_workflow import plugin_workflow_gate_payload, run_plugin_workflow_gate
from superclaw.plugins import PluginVerificationError, default_revocation_file, list_cached_plugins, plugin_cache_root, uninstall_cached_plugin, verify_plugin_package
from superclaw.protocol_adapter import build_clawhunt_delivery_protocol_payload, build_clawhunt_submission_payload, default_solution_text
from superclaw.permissions import PRESET_TO_MODE
from superclaw.runtime import (
    PermissionPolicy,
    codex_cli_mode,
    desktop_toolchain_env,
    find_codex_executable,
    redact_secrets,
    runtime_cli_comparison,
    runtime_manifest,
    runtime_mcp_status,
)
from superclaw.runtime_config import (
    configured_shell_backend as _configured_shell_backend,
    configured_shell_mode as _configured_shell_mode,
    configured_shell_repo as _configured_shell_repo,
    hydrate_runtime_environment,
    load_onboarding_state,
    reset_onboarding_state,
    runtime_config_payload,
    runtime_config_specs,
    save_shell_config_value as _save_shell_config_value,
    set_onboarding_completed,
    set_runtime_config,
    shell_config_path as _shell_config_path,
)
from superclaw import appearance as _appearance
from superclaw.escalation import EscalationError, escalation_summary, verify_envelope
from superclaw.state import StateStore, resolve_cost_window
from superclaw.tui import (
    TuiBootstrapError,
    build_tui_snapshot,
    dispatch_tui_action,
    dispatch_tui_composer,
    render_tui_run_events,
    run_tui,
    write_tui_snapshot_artifact,
)
from superclaw.tui_acceptance import run_tui_acceptance
from superclaw.ui_contracts import AGENT_CONTROL_SPECS, build_agent_inventory, build_agent_summary, build_clawhunt_auth_payload, build_runtime_status_payload, build_shell_status_lines

app = typer.Typer(help="SuperClaw end-to-end delivery harness")
clawhunt_app = typer.Typer(help="ClawHunt API helpers")
harness_app = typer.Typer(help="Harness portability and adapter helpers")
capability_app = typer.Typer(help="Capability atlas: the embedded profile of every skill, plugin, tool, and service SuperClaw can draw on")
capability_workshop_app = typer.Typer(help="Capability Workshop developer packaging, review, and registry sync")
runtime_app = typer.Typer(help="Runtime, MCP, plugin, and permission inspection")
eval_app = typer.Typer(help="Delivery-gap evaluation product")
plugin_app = typer.Typer(help="Local SuperClaw plugin package verification")
skill_app = typer.Typer(help="Native SuperClaw skill store")
catalog_app = typer.Typer(help="Capability Workshop catalog resolver")
trust_app = typer.Typer(help="Capability Workshop trust-state inspection")
fusion_app = typer.Typer(help="Fusion monorepo orchestration for imported product surfaces")
media_app = typer.Typer(help="Governed image/video generation through RunningHub")
desktop_app = typer.Typer(help="Desktop runtime supervision helpers")
plugin_config_app = typer.Typer(help="Local plugin non-secret settings")
plugin_secret_app = typer.Typer(help="Local plugin secret descriptors and values")
agent_app = typer.Typer(help="Agent Team Kernel: agent profiles (roles + equipment)")
goal_app = typer.Typer(help="Goal Mode (计划模式): plan a goal, confirm its roster, run it across agents")
issue_app = typer.Typer(help="Agent Team Kernel: issues (delegated work + checkout locks)")
delegate_review_app = typer.Typer(help="Review delegated child results before parent continuation")
approve_app = typer.Typer(help="Agent Team Kernel: approval gate for shipping work")
cost_app = typer.Typer(help="Cost tracing: the run-layer ledger (chat + team)")
company_app = typer.Typer(help="Governance namespace: company profiles")
marketplace_app = typer.Typer(help="ClawHunt marketplace participation: governed browse / post / claim / submit (one fact source, fail-closed, human-gated writes)")
company_template_app = typer.Typer(help="Company templates: signed company blueprints (Capability Workshop 方向一)")
workspace_app = typer.Typer(help="Governance namespace: workspace profiles (execution boundary)")
team_app = typer.Typer(help="Agent Team Kernel: cross-entity read models (inventory)")
team_catalog_app = typer.Typer(help="Agent Team Kernel template catalog inspection")
team_board_inbox_app = typer.Typer(help="Agent Team Kernel: board escalation inbox")
team_routine_app = typer.Typer(help="Agent Team Kernel: routine authoring and schedules")
relay_app = typer.Typer(help="LLMgate model-relay key chain for the clawwork runtime")
secret_app = typer.Typer(help="Company secrets: encrypted ledger + bindings + audit (local_encrypted; plaintext never echoes)")
instance_app = typer.Typer(help="Instance settings: the singleton general/experimental configuration buckets")
daemon_app = typer.Typer(help="Heartbeat daemon: the engine that runs Agent Teams unattended (timer wakeups + gated claims)")
daemon_broker_app = typer.Typer(help="Local daemon broker sessions, scoped tokens, and governed plugin views")
escalation_app = typer.Typer(help="Escalations: the fail-closed approval queue for B-class tool actions (Direction 4 P0/D1)")
file_app = typer.Typer(help="Reference viewer: read a file from a run's trusted checkout (fail-closed)")
web_app = typer.Typer(help="Reference viewer: SSRF-guarded sanitized reader preview of a URL")
appearance_app = typer.Typer(help="Appearance: color-scheme presets + custom palette (shared by CLI / API / Web)")


@web_app.callback(invoke_without_command=True)
def _web_launch(ctx: typer.Context) -> None:
    """`superclaw web` (no subcommand) launches the web workbench (= `superclaw service`).
    `superclaw web preview <url>` still works."""
    if ctx.invoked_subcommand is None:
        _launch_web_service("127.0.0.1", 8788, None, "info", None)
app.add_typer(clawhunt_app, name="clawhunt")
app.add_typer(relay_app, name="relay")
app.add_typer(harness_app, name="harness")
app.add_typer(capability_app, name="capabilities")
capability_app.add_typer(capability_workshop_app, name="workshop")
app.add_typer(runtime_app, name="runtime")
app.add_typer(eval_app, name="eval")
app.add_typer(plugin_app, name="plugin")
app.add_typer(skill_app, name="skill")
app.add_typer(catalog_app, name="catalog")
app.add_typer(trust_app, name="trust")
app.add_typer(fusion_app, name="fusion")
app.add_typer(media_app, name="media")
app.add_typer(desktop_app, name="desktop")
app.add_typer(agent_app, name="agent")
app.add_typer(goal_app, name="goal")
app.add_typer(issue_app, name="issue")
app.add_typer(delegate_review_app, name="delegate-review")
app.add_typer(approve_app, name="approve")
app.add_typer(cost_app, name="cost")
app.add_typer(company_app, name="company")
company_app.add_typer(company_template_app, name="template")
app.add_typer(marketplace_app, name="marketplace")
app.add_typer(workspace_app, name="workspace")
app.add_typer(team_app, name="team")
team_app.add_typer(team_catalog_app, name="catalog")
team_app.add_typer(team_board_inbox_app, name="board-inbox")
team_app.add_typer(team_routine_app, name="routine")
app.add_typer(secret_app, name="secret")
app.add_typer(instance_app, name="instance")
app.add_typer(daemon_app, name="daemon")
app.add_typer(escalation_app, name="escalation")
app.add_typer(file_app, name="file")
app.add_typer(web_app, name="web")
app.add_typer(appearance_app, name="appearance")
plugin_app.add_typer(plugin_config_app, name="config")
plugin_app.add_typer(plugin_secret_app, name="secret")
daemon_app.add_typer(daemon_broker_app, name="broker")

telemetry_app = typer.Typer(
    help="Remote telemetry upload to the operator collection server "
    "(opt-in, fail-closed; default OFF)."
)
app.add_typer(telemetry_app, name="telemetry")


def _state_path() -> Path:
    # Single source of truth shared with the API/desktop entrypoints — see
    # default_state_path(). Default under ~/.superclaw (HOME), not cwd-relative.
    return default_state_path()


def _telemetry_spooler() -> "UploadSpooler":
    from superclaw.telemetry_upload import TelemetryConfig, UploadSpooler

    return UploadSpooler(StateStore(_state_path()), TelemetryConfig.from_env())


@telemetry_app.command("status")
def telemetry_status() -> None:
    """Show the upload gate state, endpoint, device id, and why it would skip."""
    spooler = _telemetry_spooler()
    consent = spooler.consent()
    enabled, reason = spooler.is_enabled()
    typer.echo(f"consent_state={consent.state}")
    typer.echo(f"would_upload={'yes' if enabled else 'no'}")
    if not enabled:
        typer.echo(f"reason={reason}")
    typer.echo(f"endpoint={spooler._cfg.endpoint or '(unset)'}")
    typer.echo(f"device_id={consent.device_id}")
    typer.echo(f"agreement_version={consent.agreement_version or '(none)'}")


@telemetry_app.command("enable")
def telemetry_enable(
    agreement_version: str = typer.Option(
        ..., "--agreement-version",
        help="Version of the user agreement the operator/user consented to.",
    ),
) -> None:
    """Turn uploads ON (records consent). Still needs SUPERCLAW_TELEMETRY_ENDPOINT."""
    spooler = _telemetry_spooler()
    state = spooler.set_consent(enabled=True, agreement_version=agreement_version)
    typer.echo(f"telemetry enabled (agreement_version={state.agreement_version})")
    if not spooler._cfg.endpoint:
        typer.echo(
            "warning: SUPERCLAW_TELEMETRY_ENDPOINT is unset — nothing will upload.",
            err=True,
        )


@telemetry_app.command("disable")
def telemetry_disable() -> None:
    """Turn uploads OFF and wipe the pending upload cursor."""
    _telemetry_spooler().set_consent(enabled=False)
    typer.echo("telemetry disabled (cursor cleared)")


@telemetry_app.command("spool")
def telemetry_spool(
    drain: bool = typer.Option(
        False, "--drain",
        help="Upload the ENTIRE current backlog now (unbounded), instead of one "
        "bounded tick. Use for an operator catch-up; the daemon uses bounded ticks.",
    ),
) -> None:
    """Run one upload tick now (schedule it via cron/launchd for background use)."""
    result = _telemetry_spooler().tick(drain=drain)
    if result.skipped:
        typer.echo(f"skipped: {result.reason}")
        return
    typer.echo(
        f"batches={result.batches} rows={result.rows} duplicates={result.duplicates}"
    )
    for err in result.errors:
        typer.echo(f"error: {err}", err=True)
    if result.errors:
        raise typer.Exit(1)


@telemetry_app.command("unseal-tier-c")
def telemetry_unseal_tier_c(
    private_key: Path = typer.Option(
        ..., "--private-key", exists=True, dir_okay=False, readable=True,
        help="Path to the operator's RSA private key (PEM). OPERATOR ONLY — a normal "
        "client never holds this; without it nothing here can decrypt.",
    ),
    server: str = typer.Option(
        ..., "--server", help="Collector base URL, e.g. https://collector.example",
    ),
    query_token: str = typer.Option(
        "", "--query-token", help="Operator query token (the collector's TELEMETRY_QUERY_TOKEN).",
    ),
    trace_id: str = typer.Option(None, "--trace-id", help="Only unseal this trace."),
    limit: int = typer.Option(100, "--limit", min=1, max=1000),
) -> None:
    """Operator-only: fetch sealed Tier C rows from the collector and decrypt them
    LOCALLY with the private key. The collector stays zero-knowledge — it only hands
    over ciphertext; decryption happens here and never touches the server."""
    import logging

    import httpx

    from superclaw.telemetry_envelope import EnvelopeError, unseal

    audit = logging.getLogger("superclaw.telemetry")
    private_pem = private_key.read_text(encoding="utf-8")
    url = server.rstrip("/") + "/api/tier-c/sealed"
    headers = {"Authorization": f"Bearer {query_token}"} if query_token else {}
    params: dict[str, Any] = {"limit": limit}
    if trace_id:
        params["trace_id"] = trace_id
    try:
        resp = httpx.get(url, params=params, headers=headers, timeout=30.0, trust_env=False)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        typer.echo(f"failed to fetch sealed rows: {exc}", err=True)
        raise typer.Exit(1) from exc
    try:
        payload = resp.json()
    except ValueError as exc:
        typer.echo(f"server returned non-JSON from {url}: {exc}", err=True)
        raise typer.Exit(1) from exc
    # Fail closed on an unexpected shape: a 200 from the wrong service / a schema
    # regression with no 'rows' must NOT be treated as "0 rows, success".
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
        typer.echo(
            f"unexpected response from {url} (no 'rows' list — wrong endpoint or schema?)",
            err=True,
        )
        raise typer.Exit(1)
    rows = payload["rows"]
    ok = failed = 0
    for row in rows:
        envelope = {
            "ciphertext_b64": row.get("ciphertext_b64"),
            "nonce_b64": row.get("nonce_b64"),
            "wrapped_cek_b64": row.get("wrapped_cek_b64"),
            "key_id": row.get("key_id"),
        }
        try:
            plaintext = unseal(envelope, private_pem)
        except EnvelopeError as exc:
            failed += 1
            typer.echo(f"[trace={row.get('trace_id')}] unseal failed: {exc}", err=True)
            continue
        ok += 1
        typer.echo(
            f"--- trace_id={row.get('trace_id')} run_id={row.get('run_id')} "
            f"kind={row.get('payload_kind')} ---"
        )
        typer.echo(plaintext.decode("utf-8", errors="replace"))
    # Audit trail: record THAT an unseal happened + its scope, never the decrypted
    # content. The decision to unseal is the operator's; this leaves a trace of it.
    audit.info(
        "tier_c_unseal performed: server=%s trace_id=%s rows=%d ok=%d failed=%d",
        server, trace_id or "*", len(rows), ok, failed,
    )
    typer.echo(f"\n# unsealed {ok}, failed {failed} (of {len(rows)})", err=True)
    if failed:
        raise typer.Exit(1)


@file_app.command("show")
def file_show(
    run_id: str = typer.Argument(..., help="Run id whose trusted checkout to read from"),
    path: str = typer.Option(..., "--path", help="Relative file path inside the run checkout"),
    max_bytes: Optional[int] = typer.Option(
        None, "--max-bytes", min=1, max=FILE_VIEW_SCAN_CAP,
        help="Max bytes returned for display (default: contract max)",
    ),
    json_out: bool = typer.Option(False, "--json", help="Emit the FileViewResult as JSON"),
) -> None:
    """Read one file from a run's trusted checkout (fail-closed; same kernel
    logic and error codes as the API/Web reference viewer)."""
    from superclaw.file_view import FILE_VIEW_MAX_BYTES, FileViewError, read_run_file

    store = StateStore(_state_path())
    limit = max_bytes or FILE_VIEW_MAX_BYTES  # Typer rejects <1; None -> default
    try:
        result = read_run_file(store, run_id, path, max_bytes=limit)
    except FileViewError as exc:
        typer.echo(f"file_error={exc.code}: {exc.message}", err=True)
        raise typer.Exit(1) from exc

    if json_out:
        typer.echo(json.dumps(result.to_dict(), ensure_ascii=False))
        return
    if not result.is_text:
        # Binary repo files are metadata-only on every surface — no content, no
        # download (contract binary_download=False). Do not imply a download path.
        typer.echo(
            f"[binary] {result.path} — {result.size_bytes} bytes ({result.mime}); "
            "metadata only, no content returned",
            err=True,
        )
        return
    if result.content is not None:
        typer.echo(result.content)
    if result.truncated:
        typer.echo(f"[truncated to {limit} bytes of {result.size_bytes}]", err=True)


@web_app.command("preview")
def web_preview(
    url: str = typer.Argument(..., help="http(s) URL to fetch and sanitize"),
    json_out: bool = typer.Option(False, "--json", help="Emit the PreviewResult as JSON"),
    proxy: bool = typer.Option(
        True,
        "--proxy/--no-proxy",
        help="Route through the OS-configured proxy when present (fixes fake-IP / "
        "split-tunnel proxies). --no-proxy forces the resolve-and-pin SSRF path.",
    ),
) -> None:
    """Server-side SSRF-guarded preview of a URL (kernel baseline; same logic and
    error codes as the API/Web). Prints metadata + extracted links; the HTML bodies
    are meant for the Web srcdoc surface, not the terminal — ``sanitized_html`` is
    the inert text-only reader, ``page_html`` the faithful styled view (real CSS/
    images, scripts blocked) the Web reference viewer embeds for desktop parity."""
    from superclaw.web_preview import PreviewError, fetch_url_preview

    try:
        result = fetch_url_preview(url, allow_proxy=proxy)
    except PreviewError as exc:
        typer.echo(f"preview_error={exc.code}: {exc.message}", err=True)
        raise typer.Exit(1) from exc

    if json_out:
        typer.echo(json.dumps(result.to_dict(), ensure_ascii=False))
        return
    typer.echo(f"final_url={result.final_url}")
    typer.echo(f"status={result.status} content_type={result.content_type} truncated={result.truncated}")
    typer.echo(f"sanitized_html_chars={len(result.sanitized_html)}")
    typer.echo(f"page_html_chars={len(result.page_html)}")
    typer.echo(f"extracted_links={len(result.extracted_links)}")
    for link in result.extracted_links[:20]:
        typer.echo(f"  - {link['url']}")
    if len(result.extracted_links) > 20:
        typer.echo(f"  … (showing first 20 of {len(result.extracted_links)}; use --json for all)")


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _run_artifact_root_from_session(session: Any, run_id: str) -> Path:
    artifact_dir = getattr(session, "execution_context", {}).get("artifact_dir") or default_artifact_dir()
    return (Path(str(artifact_dir)).resolve() / run_id).resolve()


def _media_cli_artifact_dir_and_store(run_id: str | None, artifact_dir: Path | None) -> tuple[Path | None, StateStore | None]:
    if not run_id:
        return artifact_dir, None
    store = StateStore(_state_path())
    try:
        session = store.get_run(run_id)
    except KeyError as exc:
        typer.echo("media_error=run not found", err=True)
        raise typer.Exit(1) from exc
    try:
        store.get_evidence(run_id)
    except KeyError as exc:
        typer.echo("media_error=run evidence not found", err=True)
        raise typer.Exit(1) from exc
    run_root = _run_artifact_root_from_session(session, run_id)
    target = (artifact_dir if artifact_dir else run_root / "media").expanduser().resolve()
    if not _path_is_within(target, run_root):
        typer.echo("media_error=media artifact_dir must be inside run artifact root", err=True)
        raise typer.Exit(1)
    return target, store


def _attach_media_cli_result(
    payload: dict[str, Any],
    run_id: str | None,
    store: StateStore | None,
    *,
    artifact_kind: str,
    event_type: str,
) -> dict[str, Any]:
    result = dict(payload)
    result["run_id"] = run_id
    result["evidence_attached"] = False
    if not run_id:
        return result
    if store is None:
        store = StateStore(_state_path())
    try:
        session = store.get_run(run_id)
        evidence = store.get_evidence(run_id)
    except KeyError as exc:
        typer.echo("media_error=run evidence not found", err=True)
        raise typer.Exit(1) from exc
    artifact_id = str(result.get("artifact_id") or "")
    artifact_path = str(result.get("artifact_path") or "")
    if not artifact_id or not artifact_path:
        typer.echo("media_error=media artifact result missing artifact reference", err=True)
        raise typer.Exit(1)
    resolved_path = Path(artifact_path).resolve()
    run_root = _run_artifact_root_from_session(session, run_id)
    if not _path_is_within(resolved_path, run_root):
        typer.echo("media_error=media artifact path not attachable", err=True)
        raise typer.Exit(1)
    template = result.get("template") if isinstance(result.get("template"), dict) else {}
    metadata = {
        "provider": result.get("provider"),
        "status": result.get("status"),
        "template_id": template.get("id") if isinstance(template, dict) else None,
        "query": result.get("query"),
        "task_id": result.get("task_id"),
        "file_name": result.get("file_name"),
        "runninghub_endpoint": result.get("endpoint"),
        "media_artifact_url": result.get("artifact_url"),
        "endpoint": f"/api/runs/{run_id}/artifacts/{artifact_id}",
    }
    evidence.add_artifact(
        ArtifactRef(
            kind=artifact_kind,
            path=str(resolved_path),
            artifact_id=artifact_id,
            sensitivity="internal",
            metadata={key: value for key, value in metadata.items() if value is not None},
        )
    )
    store.save_evidence(evidence)
    store.add_event(run_id, "artifact.added", {"artifact_id": artifact_id, "kind": artifact_kind, "path": str(resolved_path)})
    store.add_event(
        run_id,
        event_type,
        {
            "artifact_id": artifact_id,
            "kind": artifact_kind,
            "status": result.get("status"),
            "task_id": result.get("task_id"),
            "query": result.get("query"),
            "endpoint": f"/api/runs/{run_id}/artifacts/{artifact_id}",
        },
    )
    result["evidence_attached"] = True
    result["run_artifact_url"] = f"/api/runs/{run_id}/artifacts/{artifact_id}"
    return result


_MEDIA_RENDER_STEP_ATTACHMENTS = {
    "generate": ("runninghub-media-task-json", "media.generate.recorded"),
    "status": ("runninghub-media-status-json", "media.task_status.recorded"),
    "outputs": ("runninghub-media-outputs-json", "media.outputs.recorded"),
}


def _attach_media_cli_render_result(payload: dict[str, Any], run_id: str | None, store: StateStore | None) -> dict[str, Any]:
    result = dict(payload)
    result["run_id"] = run_id
    result["evidence_attached"] = False
    if not run_id:
        return result
    attached_steps: list[dict[str, Any]] = []
    for step in result.get("steps", []):
        if not isinstance(step, dict) or not isinstance(step.get("result"), dict):
            attached_steps.append(step)
            continue
        artifact_kind, event_type = _MEDIA_RENDER_STEP_ATTACHMENTS.get(
            str(step.get("step")),
            ("runninghub-media-task-json", "media.generate.recorded"),
        )
        attached = _attach_media_cli_result(
            step["result"],
            run_id,
            store,
            artifact_kind=artifact_kind,
            event_type=event_type,
        )
        updated_step = dict(step)
        updated_step["result"] = attached
        attached_steps.append(updated_step)
    result["steps"] = attached_steps
    result["artifacts"] = [
        {
            "step": step.get("step"),
            "attempt": step.get("attempt"),
            "artifact_id": step.get("result", {}).get("artifact_id") if isinstance(step.get("result"), dict) else None,
            "artifact_url": step.get("result", {}).get("artifact_url") if isinstance(step.get("result"), dict) else None,
            "run_artifact_url": step.get("result", {}).get("run_artifact_url") if isinstance(step.get("result"), dict) else None,
            "status": step.get("result", {}).get("status") if isinstance(step.get("result"), dict) else None,
            "query": step.get("result", {}).get("query") if isinstance(step.get("result"), dict) else None,
        }
        for step in attached_steps
        if isinstance(step, dict)
    ]
    result["evidence_attached"] = any(
        isinstance(step.get("result"), dict) and step["result"].get("evidence_attached")
        for step in attached_steps
        if isinstance(step, dict)
    )
    return result


_SHELL_MODES = SHELL_MODES
_SHELL_HISTORY_ENV = "SUPERCLAW_SHELL_HISTORY_PATH"


def _eval_root() -> Path:
    return default_eval_root()


def _permission_policy(
    *,
    permission_mode: str,
    permission_preset: str | None = None,
    allowed_tool: list[str] | None = None,
    disallowed_tool: list[str] | None = None,
    mcp_config: list[str] | None = None,
    plugin_dir: list[str] | None = None,
    session_id: str | None = None,
) -> PermissionPolicy | None:
    # Two-state shell (docs/permission-mode-framework.md): an explicit Ask/Allow
    # preset projects onto the underlying mode; otherwise the mode passes through.
    policy = PermissionPolicy.from_values(
        mode=PRESET_TO_MODE[permission_preset] if permission_preset else permission_mode,
        allowed_tools=allowed_tool,
        disallowed_tools=disallowed_tool,
        mcp_configs=mcp_config,
        plugin_dirs=plugin_dir,
        session_id=session_id,
    )
    return None if policy == PermissionPolicy() else policy


def _plugin_cache_path() -> Path:
    # Delegate to the kernel resolver so the cache is user-global by default
    # (~/.superclaw/plugins/cache) and honors both SUPERCLAW_PLUGIN_CACHE_PATH and
    # SUPERCLAW_PLUGIN_STATE_ROOT — same source of truth the API and gate use.
    return plugin_cache_root()


def _plugin_submission_path() -> Path:
    # Plugin developer-upload submission store: aligned with the merged plugin-state
    # design (PR#351), this stays cwd-relative by default (honors the env override).
    return Path(os.environ.get("SUPERCLAW_PLUGIN_SUBMISSION_PATH", ".superclaw/plugins/submissions"))


def _capability_submission_path() -> Path:
    configured = os.environ.get("SUPERCLAW_CAPABILITY_SUBMISSION_PATH")
    return Path(configured) if configured else superclaw_data_path("capabilities", "submissions")


def _plugin_cloud_path() -> Path:
    # Fake-cloud SOURCE registry is per-project (cwd-relative default), not installed
    # plugin state — honors SUPERCLAW_PLUGIN_CLOUD_PATH, else DEFAULT_CLOUD_ROOT.
    return Path(os.environ.get("SUPERCLAW_PLUGIN_CLOUD_PATH", os.fspath(DEFAULT_CLOUD_ROOT)))


def _build_service_app(state_path: Path) -> Any:
    from apps.api.main import create_app

    hydrate_runtime_environment()
    return create_app(state_path=state_path)


def _uvicorn_module() -> Any:
    try:
        import uvicorn
    except ModuleNotFoundError as exc:
        typer.echo("error: uvicorn is required for `superclaw service`; install the SuperClaw runtime dependencies first")
        raise typer.Exit(1) from exc

    return uvicorn


def _parse_plugin_ref(plugin_ref: str) -> tuple[str, str | None]:
    plugin_id, marker, version = plugin_ref.partition("@")
    return plugin_id, version if marker else None


def _run_summary(result: Any, artifact_dir: Path) -> dict[str, Any]:
    summary = {
        "run_id": result.session.run_id,
        "status": result.session.status,
        "chain_verdict": result.evidence.chain_verdict.value,
        "evidence_path": str((Path(artifact_dir).resolve() / result.session.run_id / "evidence.json")),
    }
    failure_reason = _failure_reason_from_evidence(result.evidence)
    if failure_reason:
        summary["failure_reason"] = failure_reason
    return summary


def _failure_reason_from_evidence(evidence: Any) -> str | None:
    timed_out_workers = [result for result in getattr(evidence, "worker_results", []) if getattr(result, "timed_out", False)]
    if timed_out_workers:
        selected_worker = sorted(timed_out_workers, key=lambda result: float(getattr(result, "duration_seconds", 0.0) or 0.0), reverse=True)[0]
        duration = int(round(float(getattr(selected_worker, "duration_seconds", 0.0) or 0.0)))
        return (
            f"timeout: {getattr(selected_worker, 'backend', 'worker')} "
            f"{getattr(selected_worker, 'role', 'task')} exceeded {duration}s"
        )
    failed = [finding for finding in getattr(evidence, "findings", []) if not getattr(finding, "passed", True)]
    if not failed:
        return None
    severity_rank = {"critical": 0, "high": 1, "warning": 2, "info": 3}
    name_rank = {
        "backend_readiness_classification": 0,
        "worker_execution": 1,
        "evidence_consistency": 2,
        "command_backed_verification": 3,
    }
    selected = sorted(
        failed,
        key=lambda finding: (
            severity_rank.get(str(getattr(finding, "severity", "info")), 9),
            name_rank.get(str(getattr(finding, "name", "")), 9),
        ),
    )[0]
    detail = redact_secrets(str(getattr(selected, "detail", "") or "")).replace("\n", " ")
    if len(detail) > 240:
        detail = detail[:237].rstrip() + "..."
    return f"{getattr(selected, 'name', 'failure')}: {detail}"


def _print_run_summary(result: Any, artifact_dir: Path, *, json_output: bool = False) -> None:
    summary = _run_summary(result, artifact_dir)
    if json_output:
        typer.echo(json.dumps(summary, ensure_ascii=False))
        return
    for key, value in summary.items():
        typer.echo(f"{key}={value}")


def _safe_path_display(path: str) -> str:
    """Render a filesystem path for prompts/errors without letting control
    characters or newlines forge UI text (trust prompts especially)."""
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in path):
        return json.dumps(path, ensure_ascii=True)
    return path


def _is_interactive() -> bool:
    """Both ends must be a TTY for trust-as-creation prompts; pipes and CI
    take the fail-closed path instead."""
    return sys.stdin.isatty() and sys.stdout.isatty()


def _resolve_chat_workspace_or_exit(store, *, workspace_id: str | None, repo: Path | None):
    """Resolve the workspace a chat belongs to via the shared kernel resolver.

    Interactive terminals get the trust-as-creation prompt; non-interactive
    invocations fail closed with WORKSPACE_TRUST_REQUIRED — never a silent
    workspace (ADR: docs/workspace-trust-container.md).
    """
    try:
        resolution = workspace_resolver.resolve_workspace_for_chat(
            store, workspace_id=workspace_id, repo=repo
        )
    except KeyError:
        typer.echo(f"error: unknown workspace: {workspace_id}", err=True)
        raise typer.Exit(2) from None
    if resolution.status != "trust_required":
        return resolution.workspace
    canonical = resolution.identity.get("canonical_path") or (str(repo) if repo is not None else "the chat workspace")
    shown = _safe_path_display(canonical)
    if resolution.workspace is not None:
        # Registered but not ACTIVE (pending/quarantined): only an explicit
        # trust decision may unfreeze it — never this code path.
        typer.echo(
            f"error: {workspace_resolver.WORKSPACE_TRUST_REQUIRED}: {resolution.reason}",
            err=True,
        )
        raise typer.Exit(3)
    if _is_interactive():
        if typer.confirm(f"Trust {shown} and create a workspace for it?", default=False):
            try:
                workspace_resolver.create_trusted_workspace(
                    store, canonical, trust_source="cli_prompt"
                )
            except workspace_resolver.WorkspaceRootRejected as exc:
                typer.echo(f"error: {exc}", err=True)
                raise typer.Exit(3) from None
            # Re-resolve so an explicit --workspace keeps its grouping even
            # when the prompt just trusted the execution repo.
            return _resolve_chat_workspace_or_exit(
                store, workspace_id=workspace_id, repo=repo
            )
    typer.echo(
        f"error: {workspace_resolver.WORKSPACE_TRUST_REQUIRED}: no trusted workspace for "
        f"{shown}; run `superclaw workspace trust {shown}` first",
        err=True,
    )
    raise typer.Exit(3)


def _execute_chat_turn(
    *,
    content: str,
    session_id: str | None,
    continue_last: bool,
    backend: str | None,
    repo: Path | None,
    budget_seconds: int,
    artifact_dir: Path,
    harness: str,
    task_topology: TaskTopology,
    dry: bool,
    permission_mode: str,
    allowed_tool: list[str] | None,
    disallowed_tool: list[str] | None,
    mcp_config: list[str] | None,
    plugin_dir: list[str] | None,
    model: str | None = None,
    effort: str | None = None,
    workspace_id: str | None = None,
    all_sessions: bool = False,
) -> dict[str, Any]:
    store = SuperClawOrchestrator.from_path(_state_path()).store
    # Every turn executes in `repo`, so every turn passes the trust gate —
    # no branch (explicit --session-id, shell /repo, --continue --all) may
    # reach the orchestrator with an untrusted execution directory.
    workspace = _resolve_chat_workspace_or_exit(store, workspace_id=workspace_id, repo=repo)
    if session_id:
        # An explicit session continues where it lives; only an explicit
        # --workspace moves it (pure regrouping, history untouched).
        session = store.get_chat_session(session_id)
        if workspace_id is not None and session.workspace_id != workspace.workspace_id:
            session = store.set_chat_session_workspace(session.session_id, workspace.workspace_id)
    elif continue_last:
        # Codex-resume semantics: --continue stays inside the workspace the
        # current repo resolves to; --all widens the *pick* to every
        # workspace (the trust gate above still applies).
        if all_sessions:
            sessions = store.list_chat_sessions()
        else:
            sessions = store.list_chat_sessions(workspace_id=workspace.workspace_id)
        session = sessions[0] if sessions else store.create_chat_session(
            content[:80] or "SuperClaw session", workspace_id=workspace.workspace_id
        )
    else:
        session = store.create_chat_session(
            content[:80] or "SuperClaw session", workspace_id=workspace.workspace_id
        )

    # Execution boundary follows the SESSION's own workspace, not the repo-resolved
    # default: an explicit --repo wins, otherwise we run in the workspace the
    # session actually lives in (a continued --session-id / --continue --all project
    # chat executes in ITS project, never the default Chat scratch). A pure new chat
    # lands in the managed Chat workspace, so this is its scratch root. Mirrors the
    # API (apps/api/main.py resolve_chat_session) and the Web rule (execution
    # follows the session's binding), so CLI and Web stay byte-for-byte in parity.
    if repo is not None:
        execution_repo = repo
    else:
        exec_workspace = workspace
        session_workspace_id = getattr(session, "workspace_id", None)
        if session_workspace_id is not None and session_workspace_id != workspace.workspace_id:
            # The session lives in a DIFFERENT workspace than the repo-resolved
            # default (e.g. --session-id / --continue --all into a project): execute
            # in THAT workspace, but re-run the SAME trust gate first so a
            # quarantined or deleted binding fails closed (Exit 2/3) instead of
            # silently running. A legacy session (workspace_id None) keeps the
            # already-resolved default (the managed Chat scratch).
            exec_workspace = _resolve_chat_workspace_or_exit(
                store, workspace_id=session_workspace_id, repo=None
            )
        execution_repo = Path(exec_workspace.repo_path)

    # Per-chat runtime stickiness (kernel rules): explicit request > the chat's
    # sticky runtime > configured default. A mid-chat backend switch stays in
    # this chat — mark the handoff in the transcript so both the user and the
    # replayed history show where the runtime changed.
    selection = resolve_chat_runtime(
        session.metadata,
        requested_backend=backend,
        requested_model=model,
        requested_effort=effort,
        default_backend=_configured_shell_backend() or "claude",
    )
    if selection.backend_switched and selection.handoff_note:
        session = store.append_chat_message(session.session_id, "system", selection.handoff_note)
    store.set_chat_runtime(
        session.session_id, backend=selection.backend, model=selection.model, effort=selection.effort
    )
    # Replay prior turns (incl. the handoff marker) into the goal so the worker
    # actually receives the conversation context — a runtime, switched or not,
    # has no native memory of this chat's earlier delivery turns.
    history_text = format_chat_history(session.messages)
    description = content
    if history_text:
        description = (
            f"{content}\n\n"
            "Conversation so far (oldest first; context for this task — the runtime has no native memory of it):\n"
            f"{history_text}"
        )
    store.append_chat_message(session.session_id, "user", content)

    policy = _permission_policy(
        permission_mode=permission_mode,
        allowed_tool=allowed_tool,
        disallowed_tool=disallowed_tool,
        mcp_config=mcp_config,
        plugin_dir=plugin_dir,
        session_id=session.session_id,
    )
    orchestrator = SuperClawOrchestrator(store)
    result = orchestrator.run_goal(
        title=session.title,
        description=description,
        dry_run=dry,
        backend_policy=selection.backend,
        model=selection.model,
        effort=selection.effort,
        repo_path=execution_repo,
        budget_seconds=budget_seconds,
        artifact_dir=artifact_dir,
        harness_policy=harness,
        task_topology=task_topology,
        permission_policy=policy,
        chat_session_id=session.session_id,
    )
    assistant_text = (
        f"run_id={result.session.run_id} status={result.session.status} "
        f"chain_verdict={result.evidence.chain_verdict.value}"
    )
    store.append_chat_message(session.session_id, "assistant", assistant_text, run_id=result.session.run_id)
    summary = _run_summary(result, artifact_dir)
    summary["session_id"] = session.session_id
    summary["backend"] = selection.backend
    if selection.model:
        summary["model"] = selection.model
    return summary


_classify_shell_intent = classify_intent
_direct_chat_prompt = direct_chat_prompt


def _execute_direct_chat_turn(
    *, content: str, backend: str, repo: Path, budget_seconds: int, model: str | None = None,
    permission_mode: str | None = None, protected_cwd: bool = False,
) -> dict[str, Any]:
    original_find = chat_turn_module.find_codex_executable
    original_mode = chat_turn_module.codex_cli_mode
    original_env = chat_turn_module.desktop_toolchain_env
    original_subprocess = chat_turn_module.subprocess
    chat_turn_module.find_codex_executable = find_codex_executable
    chat_turn_module.codex_cli_mode = codex_cli_mode
    chat_turn_module.desktop_toolchain_env = desktop_toolchain_env
    chat_turn_module.subprocess = subprocess
    try:
        return execute_direct_chat_turn(
            content=content, backend=backend, repo=repo, budget_seconds=budget_seconds, model=model,
            permission_mode=permission_mode, protected_cwd=protected_cwd,
        )
    finally:
        chat_turn_module.find_codex_executable = original_find
        chat_turn_module.codex_cli_mode = original_mode
        chat_turn_module.desktop_toolchain_env = original_env
        chat_turn_module.subprocess = original_subprocess


_SHELL_COMMANDS = [
    {
        "group": "core",
        "command": "/help",
        "insert": "/help",
        "description": "Show slash commands.",
        "usage": "/help",
    },
    {
        "group": "core",
        "command": "/exit",
        "insert": "/exit",
        "description": "Quit the shell.",
        "usage": "/exit",
    },
    {
        "group": "runtime",
        "command": "/status",
        "insert": "/status",
        "description": "Show high-signal runtime status and counts.",
        "usage": "/status",
    },
    {
        "group": "runtime",
        "command": "/setup",
        "insert": "/setup",
        "description": "Guide backend, mode, repo, and auth-related configuration.",
        "usage": "/setup [BACKEND]",
    },
    {
        "group": "runtime",
        "command": "/session",
        "insert": "/session",
        "description": "Show current session, backend, repo, and auth status.",
        "usage": "/session",
    },
    {
        "group": "runtime",
        "command": "/mode",
        "insert": "/mode ",
        "description": "Set input routing mode: auto, chat, or delivery.",
        "usage": "/mode auto|chat|delivery",
    },
    {
        "group": "turns",
        "command": "/ask",
        "insert": "/ask ",
        "description": "Ask the selected direct-chat agent without delivery orchestration.",
        "usage": "/ask MESSAGE",
    },
    {
        "group": "turns",
        "command": "/deliver",
        "insert": "/deliver ",
        "description": "Force a SuperClaw delivery turn with evidence and verification.",
        "usage": "/deliver TASK",
    },
    {
        "group": "inspect",
        "command": "/last",
        "insert": "/last",
        "description": "Show the last run id.",
        "usage": "/last",
    },
    {
        "group": "runtime",
        "command": "/backend",
        "insert": "/backend ",
        "description": "Switch backend, e.g. hermes, claude, codex, openclaw, local.",
        "usage": "/backend NAME",
    },
    {
        "group": "runtime",
        "command": "/model",
        "insert": "/model ",
        "description": "Show, set, or clear the model for this chat (sticky; cleared on backend switch).",
        "usage": "/model [NAME|clear]",
    },
    {
        "group": "runtime",
        "command": "/models",
        "insert": "/models",
        "description": "List the REAL model catalog for the current backend (live from the runtime when possible).",
        "usage": "/models [BACKEND]",
    },
    {
        "group": "runtime",
        "command": "/permission",
        "insert": "/permission ",
        "description": "Show or set the permission preset for this shell: ask or allow. Both currently run the runtime at max permission (the runtime is a pure execution engine; SuperClaw governs above); the two-state slot is kept for a future gated 'ask'.",
        "usage": "/permission [ask|allow]",
    },
    {
        "group": "runtime",
        "command": "/repo",
        "insert": "/repo ",
        "description": "Switch target repository.",
        "usage": "/repo PATH",
    },
    {
        "group": "runtime",
        "command": "/config",
        "insert": "/config",
        "description": "Show safe runtime configuration.",
        "usage": "/config",
    },
    {
        "group": "runtime",
        "command": "/config set",
        "insert": "/config set ",
        "description": "Set a supported runtime environment value for this shell.",
        "usage": "/config set NAME VALUE",
    },
    {
        "group": "runtime",
        "command": "/agents",
        "insert": "/agents",
        "description": "Show local agent/backend readiness and configuration hints.",
        "usage": "/agents",
    },
    {
        "group": "auth",
        "command": "/login",
        "insert": "/login ",
        "description": "Set the ClawHunt agent key for this shell without printing it.",
        "usage": "/login CLAWHUNT_AGENT_KEY",
    },
    {
        "group": "auth",
        "command": "/logout",
        "insert": "/logout",
        "description": "Clear the ClawHunt agent key for this shell.",
        "usage": "/logout",
    },
    {
        "group": "auth",
        "command": "/me",
        "insert": "/me",
        "description": "Read the current ClawHunt agent profile.",
        "usage": "/me",
    },
    {
        "group": "inspect",
        "command": "/runs",
        "insert": "/runs",
        "description": "List recent runs with backend and verdict summary.",
        "usage": "/runs",
    },
    {
        "group": "inspect",
        "command": "/run",
        "insert": "/run ",
        "description": "Inspect one run in detail.",
        "usage": "/run RUN_ID",
    },
    {
        "group": "inspect",
        "command": "/evidence",
        "insert": "/evidence ",
        "description": "Show a concise evidence summary for one run.",
        "usage": "/evidence RUN_ID",
    },
    {
        "group": "plugins",
        "command": "/plugins",
        "insert": "/plugins",
        "description": "List cached SuperClaw plugins.",
        "usage": "/plugins",
    },
    {
        "group": "plugins",
        "command": "/plugins doctor",
        "insert": "/plugins doctor",
        "description": "Show local plugin runtime diagnostics from evidence.",
        "usage": "/plugins doctor",
    },
]


def _shell_help_text() -> str:
    groups = [
        ("core", "Core"),
        ("runtime", "Runtime"),
        ("turns", "Turns"),
        ("inspect", "Inspect"),
        ("auth", "Auth"),
        ("plugins", "Plugins"),
    ]
    lines = ["Slash commands:"]
    for group_key, label in groups:
        lines.append(f"  {label}:")
        for spec in _SHELL_COMMANDS:
            if spec.get("group") == group_key:
                lines.append(f"    {spec['usage']:<27} {spec['description']}")
    lines.extend(
        [
            "",
            "In auto mode, questions are routed to direct chat and delivery requests use SuperClaw orchestration.",
        ]
    )
    return "\n".join(lines)


def _superclaw_version() -> str:
    try:
        return version("superclaw")
    except PackageNotFoundError:
        version_file = Path(__file__).resolve().parents[4] / "VERSION"
        return version_file.read_text(encoding="utf-8").strip() if version_file.exists() else "0.1.0"


def _terminal_color_enabled() -> bool:
    return sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _paint(text: str, *, color: str | None = None, bold: bool = False, enabled: bool = False) -> str:
    return typer.style(text, fg=color, bold=bold) if enabled else text


def _short_path(path: Path) -> str:
    resolved = path.expanduser()
    try:
        absolute = resolved.resolve()
    except OSError:
        absolute = resolved
    home = Path.home()
    if absolute == home:
        return "~"
    try:
        return "~/" + absolute.relative_to(home).as_posix()
    except ValueError:
        return absolute.as_posix()


def _shell_auth_label(*, use_color: bool) -> str:
    hydrate_clawhunt_auth_environment()
    if os.environ.get("CLAWHUNT_AGENT_API_KEY"):
        return _paint("[SET]", color=typer.colors.GREEN, bold=True, enabled=use_color)
    return _paint("[UNSET]", color=typer.colors.YELLOW, bold=True, enabled=use_color)


def _backend_availability(name: str) -> Any | None:
    backend = default_backends().get(name)
    if not backend:
        return None
    return backend.available()


def _agent_config_hint(name: str) -> str:
    spec = AGENT_CONTROL_SPECS.get(name)
    if not spec:
        return "select a supported backend with /backend NAME"
    return str(spec["configure"])


def _agent_status_summary(name: str) -> str:
    availability = _backend_availability(name)
    if availability is None:
        return f"{name}: UNKNOWN backend"
    if availability.available:
        detail = availability.version or availability.executable or "ready"
        return f"{name}: READY ({redact_secrets(str(detail))})"
    reason = availability.reason or "not configured"
    return f"{name}: MISSING ({redact_secrets(str(reason))}) configure: {_agent_config_hint(name)}"


def _agent_status_lines(*, selected_backend: str | None = None, include_all: bool = False) -> list[str]:
    inventory = {
        item["name"]: item
        for item in build_agent_inventory(backends=default_backends(), config_payload=runtime_config_payload())
    }
    names = list(default_backends())
    if selected_backend and selected_backend not in names:
        names.insert(0, selected_backend)
    if not include_all and selected_backend:
        names = [selected_backend]

    lines = ["Local agents:"]
    for name in names:
        agent = inventory.get(name)
        spec = AGENT_CONTROL_SPECS.get(name, {})
        kind = spec.get("kind", "backend")
        env_name = agent.get("config_env") if agent else spec.get("env")
        model_env = agent.get("model_env") if agent else spec.get("model_env")
        if agent is None:
            lines.append(f"  {name:<15} UNKNOWN kind={kind} configure={_agent_config_hint(name)}")
            continue
        status = "READY" if agent.get("available") else "MISSING"
        detail = agent.get("version") or agent.get("executable") or agent.get("reason") or "not configured"
        lines.append(f"  {name:<15} {status:<7} kind={kind} detail={redact_secrets(str(detail))}")
        if agent.get("available") and agent.get("executable"):
            lines.append(f"  {'':<15} executable={redact_secrets(str(agent['executable']))}")
        if env_name:
            lines.append(f"  {'':<15} config={env_name}:{agent.get('config_state', 'unset')}")
        if model_env:
            lines.append(f"  {'':<15} model={model_env}:{redact_secrets(str(agent.get('model_state', 'configured-default')))}")
        if not agent.get("available"):
            lines.append(f"  {'':<15} configure={_agent_config_hint(name)}")
    if not include_all:
        lines.append("  Use /agents to inspect all backends.")
    return lines


class _SlashCommandCompleter(Completer):
    def get_completions(self, document: Any, complete_event: Any) -> Any:
        if Completion is None:
            return
        text = document.text_before_cursor
        if not text.startswith("/") or "\n" in text:
            return
        stripped = text.strip()
        if " " in stripped and not any(spec["command"].startswith(stripped) for spec in _SHELL_COMMANDS):
            return

        for spec in _SHELL_COMMANDS:
            command = spec["command"]
            insert = spec["insert"]
            if command.startswith(stripped):
                yield Completion(insert, start_position=-len(text), display=command, display_meta=spec["description"])


def _shell_prompt_message() -> Any:
    if FormattedText is None:
        return _shell_prompt(use_color=False)
    return FormattedText(
        [
            ("class:frame", "\n╭─ "),
            ("class:label", "input"),
            ("class:frame", "\n╰─ "),
            ("class:prompt", "lobster-claw> "),
        ]
    )


def _shell_prompt_style() -> Any:
    if Style is None:
        return None
    return Style.from_dict(
        {
            "frame": "ansicyan",
            "label": "ansicyan bold",
            "prompt": "ansired bold",
            "toolbar": "bg:#1c1c1c #d0d0d0",
            "toolbar.key": "bg:#1c1c1c ansicyan bold",
            "toolbar.warn": "bg:#1c1c1c ansiyellow bold",
            "completion-menu.completion": "bg:#202020 #e5e5e5",
            "completion-menu.completion.current": "bg:#005f5f #ffffff bold",
            "completion-menu.meta.completion": "bg:#202020 #a8a8a8",
            "completion-menu.meta.completion.current": "bg:#005f5f #ffffff",
        }
    )


def _shell_toolbar_plain(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None, model: str | None = None) -> str:
    hydrate_clawhunt_auth_environment()
    auth = "set" if os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset"
    model_segment = f" | model={model}" if model else ""
    return (
        f" backend={backend}{model_segment} | mode={mode} | repo={_short_path(repo)} | auth={auth} | "
        f"session={session_id or '-'} | last={last_run_id or '-'} | type / for commands "
    )


def _shell_bottom_toolbar(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None, model: str | None = None) -> Any:
    hydrate_clawhunt_auth_environment()
    auth = "set" if os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset"
    if HTML is None:
        return _shell_toolbar_plain(session_id=session_id, backend=backend, mode=mode, repo=repo, last_run_id=last_run_id, model=model)
    return HTML(
        " <toolbar.key>backend</toolbar.key>="
        + html.escape(backend)
        + (" | <toolbar.key>model</toolbar.key>=" + html.escape(model) if model else "")
        + " | <toolbar.key>mode</toolbar.key>="
        + html.escape(mode)
        + " | <toolbar.key>repo</toolbar.key>="
        + html.escape(_short_path(repo))
        + " | <toolbar.key>auth</toolbar.key>="
        + (html.escape(auth) if auth == "set" else "<toolbar.warn>unset</toolbar.warn>")
        + " | <toolbar.key>session</toolbar.key>="
        + html.escape(session_id or "-")
        + " | <toolbar.key>last</toolbar.key>="
        + html.escape(last_run_id or "-")
        + " | type <toolbar.key>/</toolbar.key> for commands "
    )


def _shell_history_path() -> Path:
    configured = os.environ.get(_SHELL_HISTORY_ENV)
    if configured:
        return Path(configured)
    return _shell_config_path().with_name("history.txt")


def _shell_history_allows(content: str) -> bool:
    stripped = content.strip()
    if not stripped:
        return False
    if stripped.startswith("/login "):
        return False
    if stripped.startswith("/config set "):
        parts = stripped.split(None, 3)
        if len(parts) >= 4:
            spec = runtime_config_specs().get(parts[2])
            if spec and spec.secret:
                return False
    return True


class _SafeShellHistory(FileHistory if FileHistory is not None else object):
    def append_string(self, string: str) -> None:  # type: ignore[override]
        if not _shell_history_allows(string):
            return
        super().append_string(string)  # type: ignore[misc]


def _build_shell_prompt_session() -> Any:
    if PromptSession is None or InMemoryHistory is None:
        return None
    if FileHistory is not None:
        history_path = _shell_history_path()
        history_path.parent.mkdir(parents=True, exist_ok=True)
        history: Any = _SafeShellHistory(str(history_path))
    else:
        history = InMemoryHistory()
    return PromptSession(
        completer=_SlashCommandCompleter(),
        complete_while_typing=True,
        history=history,
        style=_shell_prompt_style(),
    )


def _clawhunt_base_url_display() -> str:
    try:
        return clawhunt_base_url()
    except RuntimeError as exc:
        return f"(unconfigured: {exc})"


def _clawhunt_base_url_prompt_default() -> str:
    configured = os.environ.get("CLAWHUNT_BASE_URL", "").strip()
    if configured:
        return configured
    try:
        return clawhunt_base_url()
    except RuntimeError:
        return ""


def _shell_config_lines(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None) -> list[str]:
    _hydrate_cli_environment()
    auth_status = "set" if os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset"
    persisted_backend = _configured_shell_backend() or "(unset)"
    persisted_mode = _configured_shell_mode() or "(unset)"
    return [
        f"session_id={session_id or '(not started)'}",
        f"last_run_id={last_run_id or '(none)'}",
        f"backend={backend}",
        f"backend_default={persisted_backend}",
        f"mode={mode}",
        f"mode_default={persisted_mode}",
        f"backend_status={_agent_status_summary(backend)}",
        f"repo={repo}",
        f"shell_config_path={_shell_config_path()}",
        f"shell_history_path={_shell_history_path()}",
        f"state_path={_state_path()}",
        f"APP_ENV={app_environment()}",
        f"CLAWHUNT_BASE_URL={_clawhunt_base_url_display()}",
        f"CLAWHUNT_AGENT_API_KEY={auth_status}",
        f"SUPERCLAW_CODEX_EXECUTABLE={'set' if os.environ.get('SUPERCLAW_CODEX_EXECUTABLE') else 'PATH:auto'}",
        f"SUPERCLAW_CLAUDE_EXECUTABLE={'set' if os.environ.get('SUPERCLAW_CLAUDE_EXECUTABLE') else 'PATH:auto'}",
        f"SUPERCLAW_HERMES_EXECUTABLE={'set' if os.environ.get('SUPERCLAW_HERMES_EXECUTABLE') else 'PATH:auto'}",
        f"SUPERCLAW_HERMES_MODEL={os.environ.get('SUPERCLAW_HERMES_MODEL', 'configured-default')}",
        f"SUPERCLAW_OPENCLAW_EXECUTABLE={'set' if os.environ.get('SUPERCLAW_OPENCLAW_EXECUTABLE') else 'PATH:auto'}",
        f"SUPERCLAW_OPENCLAW_MODEL={os.environ.get('SUPERCLAW_OPENCLAW_MODEL', 'configured-default')}",
    ]


def _task_status_counts(session: Any) -> dict[str, int]:
    counts: dict[str, int] = {}
    graph = getattr(session, "task_graph", None)
    for task in getattr(graph, "tasks", []) or []:
        status = str(getattr(task, "status", "unknown") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def _evidence_artifact_path(bundle: Any) -> str | None:
    for artifact in getattr(bundle, "artifacts", []) or []:
        if getattr(artifact, "kind", None) == "evidence-json":
            return str(getattr(artifact, "path", ""))
    return None


def _shell_status_lines(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None) -> list[str]:
    _hydrate_cli_environment()
    store = SuperClawOrchestrator.from_path(_state_path()).store
    context = store.context_usage()
    active_runs = [run.run_id for run in store.list_runs() if str(run.status) in ACTIVE_RUN_STATUSES]
    runtime_status = build_runtime_status_payload(
        runtime_version=_superclaw_version(),
        repo=repo,
        state_path=_state_path(),
        artifact_dir=default_artifact_dir(),
        backend=backend,
        mode=mode,
        started_at=time.time(),
        control_token_required=bool(os.environ.get("SUPERCLAW_CONTROL_TOKEN")),
        clawhunt_agent_api_key_configured=bool(os.environ.get("CLAWHUNT_AGENT_API_KEY")),
        context=context,
        active_run_ids=active_runs,
        recent_run_id=last_run_id,
        config_path=_shell_config_path(),
        agents=build_agent_inventory(backends=default_backends(), config_payload=runtime_config_payload()),
        plugins={"plugin_count": len(list_cached_plugins(cache_root=_plugin_cache_path()))},
    )
    return build_shell_status_lines(
        runtime_status,
        session_id=session_id,
        last_run_id=last_run_id,
        backend_status=_agent_status_summary(backend),
    )


def _shell_runs_lines() -> list[str]:
    store = SuperClawOrchestrator.from_path(_state_path()).store
    runs = store.list_runs()
    if not runs:
        return ["No runs recorded."]
    lines = [f"Recent runs ({len(runs)} total):"]
    for session in runs[:10]:
        backend = str(session.execution_context.get("backend_policy") or "-")
        topology = str(session.execution_context.get("task_topology") or "linear")
        line = (
            f"{session.run_id} status={session.status} backend={backend} "
            f"topology={topology} dry_run={str(bool(session.dry_run)).lower()}"
        )
        try:
            evidence = store.get_evidence(session.run_id)
        except KeyError:
            pass
        else:
            line += f" chain_verdict={evidence.chain_verdict.value}"
        lines.append(line)
    return lines


def _shell_run_lines(run_id: str) -> list[str]:
    store = SuperClawOrchestrator.from_path(_state_path()).store
    session = store.get_run(run_id)
    counts = _task_status_counts(session)
    lines = [
        f"run_id={session.run_id}",
        f"goal_id={session.goal_id}",
        f"status={session.status}",
        f"dry_run={str(bool(session.dry_run)).lower()}",
        f"backend={session.execution_context.get('backend_policy', '-')}",
        f"repo={session.execution_context.get('repo_path', '.')}",
        f"task_topology={session.execution_context.get('task_topology', 'linear')}",
        f"chat_session_id={session.chat_session_id or '(none)'}",
        f"parent_run_id={session.parent_run_id or '(none)'}",
        f"parent_task_id={session.parent_task_id or '(none)'}",
        f"depth={session.depth}",
        f"child_execution_count={len(session.child_executions)}",
        f"task_count={len(getattr(session.task_graph, 'tasks', []) or [])}",
        "task_status_counts=" + ",".join(f"{name}:{counts[name]}" for name in sorted(counts)) if counts else "task_status_counts=(none)",
    ]
    lease = session.active_mutation_lease
    if lease is None:
        lines.append("active_lease=(none)")
    else:
        lines.append(
            f"active_lease={lease.lease_id} owner={lease.owner} mode={lease.mode.value} "
            f"pid={lease.worker_pid or '-'} host={lease.worker_host or '-'}"
        )
    try:
        evidence = store.get_evidence(run_id)
    except KeyError:
        lines.append("chain_verdict=(missing)")
    else:
        lines.append(f"chain_verdict={evidence.chain_verdict.value}")
        failure_reason = _failure_reason_from_evidence(evidence)
        if failure_reason:
            lines.append(f"failure_reason={failure_reason}")
    return lines


def _shell_evidence_lines(run_id: str) -> list[str]:
    bundle = SuperClawOrchestrator.from_path(_state_path()).store.get_evidence(run_id)
    evidence_path = _evidence_artifact_path(bundle)
    lines = [
        f"run_id={bundle.run_id}",
        f"chain_verdict={bundle.chain_verdict.value}",
        f"probes={len(bundle.probes)}",
        f"commands={len(bundle.commands)}",
        f"worker_results={len(bundle.worker_results)}",
        f"artifacts={len(bundle.artifacts)}",
        f"child_executions={len(bundle.child_executions)}",
        f"findings={len(bundle.findings)}",
        f"submitted_to_clawhunt={str(bool(bundle.submitted_to_clawhunt)).lower()}",
    ]
    if evidence_path:
        lines.append(f"evidence_artifact_path={evidence_path}")
    failure_reason = _failure_reason_from_evidence(bundle)
    if failure_reason:
        lines.append(f"failure_reason={failure_reason}")
    for finding in bundle.findings[:5]:
        lines.append(
            f"finding={finding.name} passed={str(bool(finding.passed)).lower()} severity={finding.severity}"
        )
    remaining = len(bundle.findings) - min(len(bundle.findings), 5)
    if remaining > 0:
        lines.append(f"finding_more={remaining}")
    return lines


def _shell_plugin_doctor_lines(*, artifact_dir: Path) -> list[str]:
    payload = diagnose_plugin_runtime(artifact_dir / "plugins")
    lines = [
        "Plugin doctor:",
        f"ok={str(bool(payload['ok'])).lower()}",
        f"artifact_count={payload['artifact_count']}",
    ]
    for key, value in payload["summary"].items():
        lines.append(f"{key}={value}")
    findings = payload.get("findings", [])
    if not findings:
        lines.append("findings=(none)")
        return lines
    for finding in findings[:5]:
        lines.append(
            f"finding={finding['code']} plugin_id={finding['plugin_id']} "
            f"version={finding['plugin_version']} tool={finding['tool_name']} severity={finding['severity']}"
        )
    remaining = len(findings) - min(len(findings), 5)
    if remaining > 0:
        lines.append(f"finding_more={remaining}")
    return lines


def _shell_prompt_value(
    prompt_session: Any,
    label: str,
    *,
    default: str | None = None,
    password: bool = False,
) -> str:
    suffix = f" [{default}]" if default not in {None, ""} else ""
    prompt_text = f"{label}{suffix}: "
    if password and PromptSession is not None and InMemoryHistory is not None:
        secret_session = PromptSession(history=InMemoryHistory(), style=_shell_prompt_style())
        value = secret_session.prompt(prompt_text, is_password=True)
    elif prompt_session is not None and hasattr(prompt_session, "prompt"):
        value = prompt_session.prompt(prompt_text, is_password=password)
    else:
        value = input(prompt_text)
    resolved = str(value).strip()
    return default if not resolved and default is not None else resolved


def _shell_setup_backend_keys(backend: str) -> list[str]:
    keys: list[str] = []
    spec = AGENT_CONTROL_SPECS.get(backend, {})
    env_name = spec.get("env")
    model_env = spec.get("model_env")
    if isinstance(env_name, str):
        keys.append(env_name)
    if backend == "codex":
        keys.append("SUPERCLAW_CODEX_MODE")
    if isinstance(model_env, str):
        keys.append(model_env)
    if backend == "hermes":
        keys.extend(["SUPERCLAW_HERMES_PROVIDER", "SUPERCLAW_HERMES_TOOLSETS", "SUPERCLAW_HERMES_SKILLS"])
    if backend == "openclaw":
        keys.append("SUPERCLAW_OPENCLAW_ARGS")
    if backend == "gemini":
        keys.extend(["SUPERCLAW_GEMINI_API_KEY", "SUPERCLAW_GEMINI_BASE_URL", "SUPERCLAW_GEMINI_MAX_ITERATIONS", "SUPERCLAW_GEMINI_MAX_TOKENS"])
    if backend in {"anthropic", "anthropic-agent"}:
        keys.append("ANTHROPIC_API_KEY")
    return list(dict.fromkeys(keys))


def _shell_setup_defaults(key: str) -> str:
    payload = runtime_config_specs().get(key)
    return str(os.environ.get(key) or (payload.default if payload and payload.default is not None else ""))


def _shell_setup_apply(
    prompt_session: Any,
    *,
    current_backend: str,
    current_mode: str,
    current_repo: Path,
) -> dict[str, Any]:
    configured_names: list[str] = []
    skipped_secrets: list[str] = []
    backend_default = _configured_shell_backend() or current_backend
    selected_backend = _shell_prompt_value(prompt_session, "Backend", default=backend_default).lower().strip() or current_backend
    if selected_backend not in default_backends():
        raise ValueError(f"unsupported backend: {selected_backend}")
    mode_default = _configured_shell_mode() or current_mode
    selected_mode = _shell_prompt_value(prompt_session, "Mode", default=mode_default).lower().strip() or current_mode
    if selected_mode not in _SHELL_MODES:
        raise ValueError("mode must be one of: auto, chat, delivery")
    repo_value = _shell_prompt_value(prompt_session, "Repo", default=str(current_repo))
    selected_repo = Path(repo_value).expanduser() if repo_value else current_repo
    clawhunt_base = _shell_prompt_value(
        prompt_session,
        "ClawHunt base URL",
        default=_clawhunt_base_url_prompt_default(),
    )
    if clawhunt_base:
        _set_shell_config("CLAWHUNT_BASE_URL", clawhunt_base)
        configured_names.append("CLAWHUNT_BASE_URL")
    _save_shell_config_value("backend", selected_backend)
    _save_shell_config_value("mode", selected_mode)
    _save_shell_config_value("repo", str(selected_repo))
    configured_names.extend(["backend", "mode", "repo"])

    for key in _shell_setup_backend_keys(selected_backend):
        spec = runtime_config_specs().get(key)
        if spec is None:
            continue
        description = spec.description
        default = _shell_setup_defaults(key)
        if spec.secret:
            value = _shell_prompt_value(prompt_session, f"{key} ({description}; blank to skip)", default="", password=True)
            if not value:
                skipped_secrets.append(key)
                continue
            set_runtime_config(key, value, allow_secret=True, apply_process_env=True)
            configured_names.append(key)
            continue
        value = _shell_prompt_value(prompt_session, f"{key} ({description}; blank keeps current/default)", default=default)
        if value == "":
            continue
        _set_shell_config(key, value)
        configured_names.append(key)

    return {
        "backend": selected_backend,
        "mode": selected_mode,
        "repo": selected_repo,
        "configured": configured_names,
        "skipped_secrets": skipped_secrets,
    }


def _shell_dashboard_lines(
    *,
    session_id: str | None,
    backend: str,
    mode: str,
    repo: Path,
    last_run_id: str | None,
    full: bool,
    use_color: bool,
) -> list[str]:
    if not full:
        return [
            "SuperClaw Runtime Shell",
            "Type natural language to chat or run a delivery turn, or /help for slash commands.",
            *_shell_config_lines(session_id=session_id, backend=backend, mode=mode, repo=repo, last_run_id=last_run_id),
        ]

    red = typer.colors.RED
    cyan = typer.colors.CYAN
    white = typer.colors.WHITE
    yellow = typer.colors.YELLOW
    claw = [
        "        _.-.        .-._",
        "     .-(    \\______/    )-.",
        "    /   `-.  \\    /  .-'   \\",
        "   |       )  |  |  (       |",
        "    \\   _.'  /    \\  '._   /",
        "     `-.__.-'  /\\  `-.__.-'",
        "          \\___/  \\___/",
    ]
    rule = "─" * 68
    lines = [_paint(f"╭{rule}╮", color=red, bold=True, enabled=use_color)]
    lines.extend(_paint(f"│{line:^68}│", color=red, bold=True, enabled=use_color) for line in claw)
    lines.append(_paint(f"╰{rule}╯", color=red, bold=True, enabled=use_color))
    lines.extend(
        [
            "",
            _paint("SuperClaw Runtime Shell", color=cyan, bold=True, enabled=use_color)
            + _paint(f"  v{_superclaw_version()}", color=white, enabled=use_color),
            _paint("End-to-end delivery AgentOS for tasks, plugins, evidence, and verification.", color=white, enabled=use_color),
            "",
            _paint("[ Context ]", color=cyan, bold=True, enabled=use_color),
            f"  Backend   {_paint(backend, color=white, bold=True, enabled=use_color)}",
            f"  Mode      {_paint(mode, color=white, bold=True, enabled=use_color)}",
            f"  Agent     {_paint(_agent_status_summary(backend), color=white, bold=True, enabled=use_color)}",
            f"  Repo      {_paint(_short_path(repo), color=white, bold=True, enabled=use_color)}",
            f"  Session   {session_id or '(not started)'}",
            f"  Last run  {last_run_id or '(none)'}",
            "",
            _paint("[ Authentication ]", color=cyan, bold=True, enabled=use_color),
            f"  ClawHunt  {_shell_auth_label(use_color=use_color)}  /login CLAWHUNT_AGENT_KEY",
            f"  API       {_clawhunt_base_url_display()}",
            "",
            _paint("[ Slash Commands ]", color=cyan, bold=True, enabled=use_color),
            f"  {_paint('/help', color=yellow, bold=True, enabled=use_color)}      show commands"
            f"        {_paint('/config', color=yellow, bold=True, enabled=use_color)}    runtime config",
            f"  {_paint('/mode', color=yellow, bold=True, enabled=use_color)}      auto/chat/delivery"
            f" {_paint('/ask', color=yellow, bold=True, enabled=use_color)}       direct chat",
            f"  {_paint('/backend', color=yellow, bold=True, enabled=use_color)}   switch agent"
            f"        {_paint('/agents', color=yellow, bold=True, enabled=use_color)}    local agents",
            f"  {_paint('/repo', color=yellow, bold=True, enabled=use_color)}      switch workspace"
            f"      {_paint('/deliver', color=yellow, bold=True, enabled=use_color)}   force delivery",
            f"  {_paint('/plugins', color=yellow, bold=True, enabled=use_color)}   cached plugins"
            f"     {_paint('/exit', color=yellow, bold=True, enabled=use_color)}      quit",
            "",
            _paint("Input box", color=cyan, bold=True, enabled=use_color)
            + _paint(": ask a question, type a task, or type / to open command suggestions.", color=white, enabled=use_color),
            _paint("Example", color=yellow, bold=True, enabled=use_color)
            + _paint(": fix the failing tests and verify the result", color=white, enabled=use_color),
        ]
    )
    return lines


def _print_shell_home(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None, full: bool, use_color: bool) -> None:
    for line in _shell_dashboard_lines(
        session_id=session_id,
        backend=backend,
        mode=mode,
        repo=repo,
        last_run_id=last_run_id,
        full=full,
        use_color=use_color,
    ):
        typer.echo(line)


def _print_shell_dashboard(*, session_id: str | None, backend: str, mode: str, repo: Path, last_run_id: str | None, full: bool, use_color: bool) -> None:
    for line in _shell_dashboard_lines(
        session_id=session_id,
        backend=backend,
        mode=mode,
        repo=repo,
        last_run_id=last_run_id,
        full=full,
        use_color=use_color,
    ):
        typer.echo(line)


def _shell_prompt(*, use_color: bool) -> str:
    label = _paint("input", color=typer.colors.CYAN, bold=True, enabled=use_color)
    prompt = _paint("lobster-claw> ", color=typer.colors.RED, bold=True, enabled=use_color)
    return f"\n╭─ {label}\n╰─ {prompt}"


def _shell_working_status_line(*, frame: str, intent: str, backend: str, repo: Path, elapsed_seconds: int) -> str:
    return f"{frame} working intent={intent} backend={backend} elapsed={elapsed_seconds}s repo={_short_path(repo)}"


class _ShellWorkingIndicator:
    def __init__(self, *, enabled: bool, intent: str, backend: str, repo: Path, interval_seconds: float = 0.2) -> None:
        self.enabled = enabled
        self.intent = intent
        self.backend = backend
        self.repo = repo
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at = 0.0
        self._last_width = 0

    def __enter__(self) -> "_ShellWorkingIndicator":
        if not self.enabled:
            return self
        self._started_at = time.monotonic()
        self._thread = threading.Thread(target=self._run, name="superclaw-shell-working", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if not self.enabled:
            return None
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval_seconds * 2)
        self._clear_line()
        return None

    def _run(self) -> None:
        frames = "|/-\\"
        index = 0
        while not self._stop.is_set():
            elapsed_seconds = int(time.monotonic() - self._started_at)
            line = _shell_working_status_line(
                frame=frames[index % len(frames)],
                intent=self.intent,
                backend=self.backend,
                repo=self.repo,
                elapsed_seconds=elapsed_seconds,
            )
            self._last_width = max(self._last_width, len(line))
            sys.stdout.write("\r" + line)
            sys.stdout.flush()
            index += 1
            self._stop.wait(self.interval_seconds)

    def _clear_line(self) -> None:
        sys.stdout.write("\r" + (" " * self._last_width) + "\r")
        sys.stdout.flush()


def _set_shell_config(name: str, value: str) -> str:
    return str(set_runtime_config(name, value, allow_secret=True, apply_process_env=True)["name"])


def _shell_turn_start_line(*, intent: str, mode: str, backend: str, repo: Path) -> str:
    return f"turn_status=working intent={intent} mode={mode} backend={backend} repo={repo} shell_status=working"


def _shell_turn_done_line(*, status: str) -> str:
    return f"turn_status={status} shell_status=ready"


def _format_token_count(value: int) -> str:
    """1234 -> 1.2K, 999 -> 999, 1500000 -> 1.5M. Mirrors the web chat metering
    row so CLI and Web show the same compact token counts (zero divergence)."""
    n = int(value)
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.1f}K".replace(".0K", "K")
    return f"{n / 1_000_000:.1f}M".replace(".0M", "M")


def _format_elapsed(elapsed_ms: float) -> str:
    """Wall-clock duration as a single parseable token (no inner space): "12.3s",
    "16s", "1m35s". The NUMBER is computed identically to the web
    formatElapsedDuration (App.tsx) — half-up rounding, total-seconds derived so the
    minute path never carries to ":60" — so CLI and Web agree on the figure (zero
    divergence); only the separator differs (CLI stays single-token for key=value
    parsing, Web uses "1m 35s" for readability)."""
    seconds = elapsed_ms / 1000
    if seconds < 10:
        return f"{seconds:.1f}s"
    total_seconds = int(seconds + 0.5)  # half-up, matching JS Math.round for non-negative
    if total_seconds < 60:
        return f"{total_seconds}s"
    return f"{total_seconds // 60}m{total_seconds % 60}s"


# Ordered metering fields with provider-native key aliases, kept BYTE-FOR-BYTE in
# sync with the web USAGE_FIELDS (apps/web/src/ToolCallCard.tsx) so the CLI and Web
# count the same fields and total — zero divergence. A claude cache_read_input_tokens
# and a codex-style cached_input_tokens collapse to one field on both surfaces.
_USAGE_METER_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("in", ("input_tokens", "prompt_tokens")),
    ("out", ("output_tokens", "completion_tokens")),
    ("cache_read", ("cache_read_input_tokens", "cached_input_tokens", "cache_read_tokens")),
    ("cache_write", ("cache_creation_input_tokens", "cache_creation_tokens")),
)


def _shell_turn_meter_line(usage: dict[str, Any] | None, elapsed_ms: float | None) -> str | None:
    """One parseable metering line for a completed direct-chat turn — the CLI
    parity of the web chat's hover meta row (token usage + elapsed). Returns
    None when there is nothing to report (no tokens and no timer)."""
    parts: list[str] = []
    if isinstance(usage, dict):
        total = 0
        count = 0
        for short, keys in _USAGE_METER_FIELDS:
            value: float | None = None
            for key in keys:
                candidate = usage.get(key)
                if isinstance(candidate, (int, float)) and not isinstance(candidate, bool) and math.isfinite(candidate) and candidate >= 0:
                    value = candidate
                    break
            if value is not None:
                parts.append(f"{short}:{_format_token_count(int(value))}")
                total += int(value)
                count += 1
        # Total is only informative with ≥2 fields (a single field repeats itself);
        # mirrors the web formatUsageMeter so CLI and Web agree on when to show it.
        if count >= 2 and total:
            parts.append(f"total:{_format_token_count(total)}")
    if elapsed_ms and elapsed_ms > 0:
        parts.append(f"elapsed={_format_elapsed(elapsed_ms)}")
    if not parts:
        return None
    return "turn_meter " + " ".join(parts)


# Top-level data-root names that now default under ``superclaw_home()`` and are therefore
# safe to migrate out of a legacy cwd ``.superclaw/`` into HOME. This is an ALLOWLIST: a
# legacy ``.superclaw/`` may also hold repo/workspace-bound trees that must stay put
# (``chat-attachments`` — read inside the backend's repo sandbox; ``worktrees`` — git
# worktree semantics; ``fusion-native-report.json``; the ``desktop``/``tui`` acceptance
# reports), so we only move known data roots, never sweep the whole directory.
_MIGRATABLE_DATA_NAMES = frozenset(
    {"artifacts", "plugins", "companies", "registry", "capabilities", "evals", "keys"}
)
# db + WAL/SHM/journal sidecars (streamtest harness DB included).
_MIGRATABLE_DATA_PREFIXES = ("state.db", "telemetry.db", "streamtest-state.db")


def _db_family_base(name: str) -> str | None:
    """The DB base for ``name`` if it is a known DB file or one of its SQLite sidecars
    (``<db>``, ``<db>-wal``, ``<db>-shm``, ``<db>-journal``), else None. Matches the base
    or ``base + "-"`` ONLY, so an unrelated ``state.db.backup`` is not swept in."""
    for base in _MIGRATABLE_DATA_PREFIXES:
        if name == base or name.startswith(base + "-"):
            return base
    return None


def _is_migratable_data_entry(name: str) -> bool:
    return name in _MIGRATABLE_DATA_NAMES or _db_family_base(name) is not None


def _migration_group_key(name: str) -> str:
    """Group key for atomic migration. A SQLite DB and its WAL/SHM/journal sidecars share
    one key (the DB base) so they move as an inseparable family — splitting them (e.g.
    moving ``state.db`` but leaving ``state.db-wal``) risks losing committed WAL data.
    Standalone roots (artifacts, plugins, ...) are their own single-member group."""
    base = _db_family_base(name)
    return base if base is not None else name


def _plan_home_migration(src: Path, dest: Path) -> dict[str, Any]:
    """Plan a legacy ``.superclaw/`` → HOME data-root migration (pure; no filesystem
    mutation). Groups entries into atomic units (DB families share a group) and buckets
    each GROUP whole: ``move`` (every member clean), ``conflict`` (any member already at
    dest — never overwritten, so the whole family stays to avoid a split), ``symlink``
    (any member is a SYMLINK — moving the link would leave HOME pointing back at the
    original), ``skip`` (not a migratable data root). ``move_groups`` lists the movable
    families as units so the executor can roll a partial group back on failure; the flat
    buckets are for reporting."""
    plan: dict[str, Any] = {"move": [], "move_groups": [], "conflict": [], "symlink": [], "skip": []}
    if not src.is_dir():
        return plan
    groups: dict[str, list[str]] = {}
    for entry in sorted(src.iterdir(), key=lambda p: p.name):
        name = entry.name
        if not _is_migratable_data_entry(name):
            plan["skip"].append(name)
            continue
        groups.setdefault(_migration_group_key(name), []).append(name)
    for _key, names in sorted(groups.items()):
        names.sort()
        if any((src / n).is_symlink() for n in names):
            plan["symlink"].extend(names)
        elif any(os.path.lexists(dest / n) for n in names):  # lexists catches broken symlink at dest
            plan["conflict"].extend(names)
        else:
            plan["move"].extend(names)
            plan["move_groups"].append(names)
    return plan


def _restore_data_member(src_member: Path, dest_member: Path) -> bool:
    """Best-effort restore of one member to ``src_member`` after a failed group move,
    SAFE under a cross-filesystem partial move. ``shutil.move`` is rename (atomic) on the
    same filesystem, but copy-then-unlink across filesystems — so on failure the source may
    still be intact while a partial/duplicate sits at ``dest_member``. Rule: if the source
    still exists, the original is authoritative — only clear the dest leftover (never
    overwrite src). If the source is gone, the only copy is at dest — move it back into the
    now-free src slot. Returns True if the member ended up cleanly at src with no leftover."""
    if os.path.lexists(src_member):
        if os.path.lexists(dest_member):
            try:
                if dest_member.is_dir() and not dest_member.is_symlink():
                    shutil.rmtree(dest_member)
                else:
                    dest_member.unlink()
            except OSError:
                return False
        return True
    if os.path.lexists(dest_member):
        try:
            shutil.move(os.fspath(dest_member), os.fspath(src_member))
        except OSError:
            return False
    return True


@app.command("migrate-home")
def migrate_home_command(
    source: Path | None = typer.Option(
        None, "--from", help="Legacy data dir to migrate (default: ./.superclaw in the current directory)"
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would move without moving anything"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Move legacy cwd-relative ``.superclaw/`` data into the HOME data root (~/.superclaw).

    Relocates the migratable data roots (state.db + telemetry.db with their WAL/SHM/journal
    sidecars, artifacts, plugins, companies, registry, capabilities, evals, keys) so data
    created before the HOME-root change actually leaves an iCloud-synced checkout. NEVER
    overwrites anything already at the destination (such names are reported as conflicts and
    left untouched), NEVER migrates a symlinked data root (reported separately — moving the
    link would leave HOME pointing back at the original), and NEVER moves repo/workspace-bound
    trees (chat-attachments, git worktrees, fusion/acceptance reports). Stop any running
    ``superclaw service`` / ``desktop`` first so the state DB is not open during the move.
    """
    src = (source or Path(".superclaw")).expanduser().resolve()
    dest = superclaw_home().resolve()

    def _emit(payload: dict[str, Any]) -> None:
        if json_output:
            typer.echo(json.dumps(payload, ensure_ascii=False))
        else:
            typer.echo(f"source={payload['source']}")
            typer.echo(f"dest={payload['dest']}")
            if payload.get("note"):
                typer.echo(payload["note"])
            for name in payload.get("moved", []):
                typer.echo(f"moved: {name}")
            for name in payload.get("conflict", []):
                typer.echo(f"conflict (left in place, not overwritten): {name}")
            for name in payload.get("symlink", []):
                typer.echo(f"symlink (left in place, not migrated): {name}")
            for name in payload.get("skip", []):
                typer.echo(f"skip (not a HOME data root): {name}")

    def _base(note: str) -> dict[str, Any]:
        return {"source": str(src), "dest": str(dest), "ok": True, "moved": [], "conflict": [], "symlink": [], "skip": [], "note": note}

    if src == dest:
        _emit(_base("source is the HOME data root; nothing to migrate"))
        return
    # Refuse nested src/dest: moving a data root while one tree contains the other would
    # corrupt the move (e.g. relocating a parent into its own child). Equality is handled
    # above; here we reject strict containment in either direction.
    if dest == src or src in dest.parents or dest in src.parents:
        payload = _base("refusing to migrate: source and destination are nested")
        payload["ok"] = False
        _emit(payload)
        raise typer.Exit(1)
    if not src.is_dir():
        _emit(_base("no legacy data directory found; nothing to migrate"))
        return

    plan = _plan_home_migration(src, dest)
    if dry_run:
        _emit({"source": str(src), "dest": str(dest), "ok": True, "dry_run": True, "moved": plan["move"], "conflict": plan["conflict"], "symlink": plan["symlink"], "skip": plan["skip"], "note": "dry run — no files moved"})
        return

    moved: list[str] = []
    failed: list[dict[str, str]] = []
    if plan["move_groups"]:
        dest.mkdir(parents=True, exist_ok=True)
    # Move each family as an atomic unit: if any member can't move, restore the whole
    # group so a DB and its sidecars never end up split across roots.
    for names in plan["move_groups"]:
        group_error: str | None = None
        moved_in_group: list[str] = []
        failed_member: str | None = None
        for name in names:
            target = dest / name
            # Re-check immediately before the move (never overwrite). lexists() also catches
            # a broken symlink that appeared at the destination since planning.
            if os.path.lexists(target):
                # A foreign object appeared at dest since planning — NOT created by this
                # command, so it must never be touched/cleaned during rollback.
                group_error = f"destination already exists: {name}"
                break
            try:
                shutil.move(os.fspath(src / name), os.fspath(target))
                moved_in_group.append(name)
            except OSError as exc:
                failed_member = name  # may have left a partial dest copy (cross-fs)
                group_error = str(exc)
                break
        if group_error is None:
            moved.extend(names)
            continue
        # Restore ONLY the members this command actually touched: the ones we moved, plus
        # the member whose move failed (to clear any partial cross-fs dest copy). The
        # conflict member (foreign dest) is deliberately excluded. _restore_data_member is
        # safe under a cross-fs partial move: it never overwrites an intact source.
        to_restore = list(moved_in_group)
        if failed_member is not None:
            to_restore.append(failed_member)
        # Evaluate EVERY restore (no short-circuit) so one failure can't strand the rest.
        results = [_restore_data_member(src / name, dest / name) for name in reversed(to_restore)]
        rolled_back = all(results)
        failed.append({
            "family": _migration_group_key(names[0]),
            "members": ",".join(names),
            "error": group_error,
            "rolled_back": "yes" if rolled_back else "partial",
        })
    payload = {
        "source": str(src),
        "dest": str(dest),
        "ok": not failed,
        "moved": moved,
        "conflict": plan["conflict"],
        "symlink": plan["symlink"],
        "skip": plan["skip"],
        "failed": failed,
    }
    _emit(payload)
    if failed:
        raise typer.Exit(1)


@app.command()
def doctor(
    deep: bool = typer.Option(
        False,
        "--deep",
        help="Actively reachability-probe each runtime (authenticated model-list round-trip) where its discovery channel faithfully reflects its run plane; report presence-only where it does not.",
    ),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Limit the --deep probe to a single backend by name (e.g. claude).",
    ),
    json_output: bool = typer.Option(False, "--json", help="Emit the deep-probe result as JSON."),
) -> None:
    """Check local configuration without printing secret values.

    With ``--deep`` each runtime whose discovery channel faithfully reflects its
    run plane is reachability-probed (the same authenticated model-list round-trip
    the model selector uses) — proving credentials + provider reachability, not
    just presence on PATH. Backends whose discovery is synthetic or cross-plane
    (relay package floor, CLI-session lanes) report presence only, never a false
    ready/fail. Tool-free and spend-free: a model list is metadata, never a billed
    turn."""
    _hydrate_cli_environment()
    if deep:
        _doctor_deep(backend=backend, json_output=json_output)
        return
    client = ClawHuntClient()
    typer.echo("SuperClaw doctor")
    typer.echo(f"state_path={_state_path()}")
    typer.echo(f"CLAWHUNT_BASE_URL={client.settings.base_url}")
    typer.echo(f"CLAWHUNT_AGENT_API_KEY: {'set' if client.settings.agent_api_key else 'unset'}")
    typer.echo("default_backend=claude")
    typer.echo(f"codex_executable={os.environ.get('SUPERCLAW_CODEX_EXECUTABLE', 'PATH:auto')}")
    typer.echo(f"claude_executable={os.environ.get('SUPERCLAW_CLAUDE_EXECUTABLE', 'PATH:auto')}")
    typer.echo(f"claude_model={os.environ.get('SUPERCLAW_CLAUDE_MODEL', 'claude-opus-4-8')}")
    typer.echo(f"anthropic_model={os.environ.get('SUPERCLAW_ANTHROPIC_MODEL', 'claude-opus-4-8')}")
    typer.echo(f"hermes_executable={os.environ.get('SUPERCLAW_HERMES_EXECUTABLE', 'PATH:auto')}")
    typer.echo(f"hermes_model={os.environ.get('SUPERCLAW_HERMES_MODEL', 'configured-default')}")
    typer.echo(f"hermes_provider={os.environ.get('SUPERCLAW_HERMES_PROVIDER', 'configured-default')}")
    typer.echo(f"bobo_model={os.environ.get('SUPERCLAW_BOBO_MODEL', 'configured-default')}")
    typer.echo(f"gemini_model={os.environ.get('SUPERCLAW_GEMINI_MODEL', 'gemini-2.5-flash')}")
    typer.echo(f"anthropic_agent_model={os.environ.get('SUPERCLAW_ANTHROPIC_AGENT_MODEL', os.environ.get('SUPERCLAW_ANTHROPIC_MODEL', 'claude-opus-4-8'))}")
    typer.echo(f"openclaw_executable={os.environ.get('SUPERCLAW_OPENCLAW_EXECUTABLE', 'PATH:auto')}")
    typer.echo(f"openclaw_args={os.environ.get('SUPERCLAW_OPENCLAW_ARGS', '--print')}")
    typer.echo(f"openclaw_model={os.environ.get('SUPERCLAW_OPENCLAW_MODEL', 'configured-default')}")
    typer.echo(f"ANTHROPIC_API_KEY: {'set' if os.environ.get('ANTHROPIC_API_KEY') else 'unset'}")
    typer.echo(f"GEMINI_API_KEY: {'set' if (os.environ.get('SUPERCLAW_GEMINI_API_KEY') or os.environ.get('GEMINI_API_KEY')) else 'unset'}")
    for backend in default_backends().values():
        availability = backend.available()
        typer.echo(f"backend.{availability.name}={'available' if availability.available else 'unavailable'}")


_PROBE_VERDICT_GLYPH = {
    "runtime_ready": "ready",
    "runtime_present": "present",
    "runtime_fail": "FAIL",
}


def _doctor_deep(*, backend: str | None, json_output: bool) -> None:
    """Deep runtime reachability probe — projects the kernel ``runtime_probe``
    onto the CLI. The CLI is the source-of-truth surface; the API/Web read the
    same mechanism. Tool-free and spend-free (authenticated model-list)."""
    from superclaw.runtime_probe import probe_backend, probe_runtimes

    backends = default_backends()
    if backend is not None:
        if backend not in backends:
            typer.echo(f"unknown backend '{backend}' (known: {', '.join(sorted(backends))})", err=True)
            raise typer.Exit(code=2)
        results = [probe_backend(backend, backends=backends)]
    else:
        results = probe_runtimes(backends=backends)

    if json_output:
        typer.echo(json.dumps({"probes": [r.to_dict() for r in results]}, ensure_ascii=False, sort_keys=True))
        return

    typer.echo("SuperClaw doctor --deep (runtime reachability — authenticated model-list round-trip)")
    any_fail = False
    for res in results:
        glyph = _PROBE_VERDICT_GLYPH.get(res.verdict.value, res.verdict.value)
        line = f"runtime.{res.backend}={glyph}"
        if res.depth == "live" and res.models_count is not None:
            line += f" models={res.models_count}"
        if res.latency_ms is not None:
            line += f" latency_ms={res.latency_ms}"
        if res.version:
            line += f" version={res.version}"
        if res.failure_reason:
            line += f" reason={res.failure_reason}"
        typer.echo(line)
        if res.verdict.value == "runtime_fail":
            any_fail = True
    # Exit-code contract:
    #  * single --backend: the caller asked "is THIS runtime reachable" — anything
    #    but runtime_ready (a fail, or present-but-unverified) is non-zero, so a
    #    CI/pipeline can never read an unverified runtime as ready.
    #  * batch: exit non-zero only on a real runtime_fail; a present-but-no-live-
    #    channel runtime must not make a routine "test all" red.
    if backend is not None:
        if results and results[0].verdict.value != "runtime_ready":
            raise typer.Exit(code=1)
    elif any_fail:
        raise typer.Exit(code=1)


@fusion_app.command("status")
def fusion_status_command(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show operator-safe fusion component status without local source paths."""
    payload = fusion_status()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    summary = payload["capability_summary"]
    typer.echo(
        "Fusion status "
        f"capabilities={summary['capability_count']} "
        f"gated={summary['gated_capability_count']} "
        f"active_probe_default={payload['network_policy']['active_probe_default']}"
    )
    for key, component in payload["components"].items():
        status = "present" if component["present"] else "missing"
        typer.echo(f"{key}={status} toolchain={component['toolchain']} plugin={component['plugin_id']}")


@fusion_app.command("doctor")
def fusion_doctor(json_output: bool = typer.Option(False, "--json")) -> None:
    """Inspect imported fusion sources, profiles, and guardrails."""
    payload = fusion_status(include_paths=True)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    typer.echo("SuperClaw fusion doctor")
    typer.echo(f"network.active_probe_default={payload['network_policy']['active_probe_default']}")
    for key, component in payload["components"].items():
        status = "present" if component["present"] else "missing"
        typer.echo(f"{key}={status} toolchain={component['toolchain']} plugin={component['plugin_id']}")


@fusion_app.command("capabilities")
def fusion_capabilities(json_output: bool = typer.Option(False, "--json")) -> None:
    """List the audited upstream capability families projected through SuperClaw."""
    payload = fusion_capability_catalog()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    typer.echo(f"Fusion capability families={payload['summary']['capability_count']}")
    for key, capabilities in payload["components"].items():
        typer.echo(f"{key}={len(capabilities)}")


@fusion_app.command("audit")
def fusion_audit(json_output: bool = typer.Option(False, "--json")) -> None:
    """Verify fusion capability coverage against the imported upstream sources."""
    payload = fusion_capability_audit()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        typer.echo(f"Fusion capability audit ok={payload['ok']}")
        for finding in payload["findings"]:
            typer.echo(f"{finding['name']}={'PASS' if finding['passed'] else 'FAIL'} {finding['detail']}")
    if not payload["ok"]:
        raise typer.Exit(1)


@fusion_app.command("native-report")
def fusion_native_report(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show the latest local native verification report, if one has been recorded."""
    payload = load_fusion_native_report()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    typer.echo(f"Fusion native report present={payload['report_present']} ok={payload['ok']}")
    for result in payload.get("results", []):
        typer.echo(f"{result.get('component')}.{result.get('command_id')}={result.get('status')} {result.get('detail', '')}")


@fusion_app.command("start")
def fusion_start(
    profile: str = typer.Option("all", "--profile", help="Fusion profile: all, osiris, design, or pencil"),
    json_output: bool = typer.Option(False, "--json"),
    execute: bool = typer.Option(False, "--execute", help="Run the Docker Compose profile with build and detached startup."),
) -> None:
    """Emit or execute a launch plan for the selected imported product surface."""
    payload = fusion_start_plan(profile, execute=execute)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        if payload.get("ok") is False or payload.get("execution", {}).get("ok") is False:
            raise typer.Exit(1)
        return
    if payload.get("ok") is False:
        typer.echo(f"Fusion start plan profile={payload['profile']} ok=False status={payload['status']} detail={payload['detail']}")
        raise typer.Exit(1)
    typer.echo(f"Fusion start plan profile={payload['profile']} execute={payload['execute']}")
    for step in payload["steps"]:
        typer.echo(f"{step['component']}: cwd={step['cwd']} command={' '.join(step['command'])}")
    execution = payload.get("execution")
    if isinstance(execution, dict):
        typer.echo(f"execution_status={execution['status']} ok={execution['ok']} detail={execution['detail']}")
        if execution.get("ok") is False:
            raise typer.Exit(1)


@fusion_app.command("test")
def fusion_test(
    profile: str = typer.Option("all", "--profile", help="Fusion profile: all, osiris, design, or pencil"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Emit the native test plan and latest verification summary for the selected product surface."""
    payload = fusion_test_plan(profile)
    summary = payload["summary"]
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        if not summary["ok"]:
            raise typer.Exit(1)
        return
    typer.echo(
        "Fusion test profile="
        f"{payload['profile']} native_report_present={summary['native_report_present']} "
        f"native_ok={summary['native_ok']} ok={summary['ok']} reported={summary['reported']} "
        f"passed={summary['passed']} failed={summary['failed']} blocked={summary['blocked']}"
    )
    for step in payload["steps"]:
        typer.echo(f"{step['component']}: status={step['status']} cwd={step['cwd']} command={' '.join(step['command'])}")
    if not summary["ok"]:
        raise typer.Exit(1)


@fusion_app.command("stop")
def fusion_stop(
    profile: str = typer.Option("all", "--profile", help="Fusion profile: all, osiris, design, or pencil"),
    json_output: bool = typer.Option(False, "--json"),
    execute: bool = typer.Option(False, "--execute", help="Run the Docker Compose profile teardown (compose down)."),
) -> None:
    """Emit or execute a teardown plan for the selected imported product surface."""
    payload = fusion_stop_plan(profile, execute=execute)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        if payload.get("ok") is False or payload.get("execution", {}).get("ok") is False:
            raise typer.Exit(1)
        return
    if payload.get("ok") is False:
        typer.echo(f"Fusion stop plan profile={payload['profile']} ok=False status={payload['status']} detail={payload['detail']}")
        raise typer.Exit(1)
    typer.echo(f"Fusion stop plan profile={payload['profile']} execute={payload['execute']}")
    typer.echo(f"components={','.join(payload['components'])} command={' '.join(payload['command'])}")
    execution = payload.get("execution")
    if isinstance(execution, dict):
        typer.echo(f"execution_status={execution['status']} ok={execution['ok']} detail={execution['detail']}")
        if execution.get("ok") is False:
            raise typer.Exit(1)


@fusion_app.command("ps")
def fusion_ps(
    profile: str = typer.Option("all", "--profile", help="Fusion profile: all, osiris, design, or pencil"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Report the live docker compose run status for the selected imported product surface."""
    payload = fusion_run_status(profile)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        if not payload["ok"]:
            raise typer.Exit(1)
        return
    typer.echo(
        f"Fusion run status profile={payload['profile']} ok={payload['ok']} "
        f"status={payload['status']} detail={payload['detail']}"
    )
    for service in payload["services"]:
        typer.echo(
            f"{service['service']}: component={service['component']} state={service['state']} "
            f"running={service['running']} health={service['health']} url={service['url']}"
        )
    if not payload["ok"]:
        raise typer.Exit(1)


def _load_json_cli_value(value: str | None, *, expected: str) -> Any:
    if value is None:
        return [] if expected == "list" else {}
    raw = value
    if raw.startswith("@"):
        raw = Path(raw[1:]).expanduser().read_text(encoding="utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        typer.echo(f"media JSON parse error: {exc}", err=True)
        raise typer.Exit(1) from exc
    if expected == "list" and not isinstance(payload, list):
        typer.echo("media JSON parse error: expected a JSON list", err=True)
        raise typer.Exit(1)
    if expected == "object" and not isinstance(payload, dict):
        typer.echo("media JSON parse error: expected a JSON object", err=True)
        raise typer.Exit(1)
    return payload


@media_app.command("status")
def media_status_command(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show RunningHub media capability status without printing keys."""
    payload = runninghub_media_status()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo("SuperClaw media status")
    typer.echo(f"provider={payload['provider']}")
    typer.echo(f"configured={payload['configured']}")
    typer.echo(f"configured_key_count={payload['configured_key_count']}")
    typer.echo(f"base_url={payload['base_url']}")
    typer.echo(f"artifact_root={payload['artifact_root']}")
    typer.echo(f"templates={len(payload['templates'])}")


@media_app.command("templates")
def media_templates_command(json_output: bool = typer.Option(False, "--json")) -> None:
    """List RunningHub media templates and their configured node state."""
    payload = runninghub_media_catalog()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo("RunningHub media templates")
    for template in payload["templates"]:
        required = ",".join(template["required_inputs"]) or "none"
        configured = "yes" if template["default_nodes_configured"] or template["field_map_configured"] else "request-required"
        typer.echo(
            f"{template['id']} webapp_id={template['webapp_id']} "
            f"output={template['output_kind']} required={required} nodes={configured}"
        )


@media_app.command("doctor")
def media_doctor_command(
    live_metadata: bool = typer.Option(False, "--live-metadata", help="Read RunningHub SKU metadata without submitting generation tasks"),
    timeout_seconds: float = typer.Option(20.0, "--timeout", min=0.1, max=120.0),
    strict: bool = typer.Option(False, "--strict", help="Exit non-zero when error-severity doctor checks fail"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Validate RunningHub media readiness without printing keys."""
    try:
        payload = runninghub_media_doctor(live_metadata=live_metadata, timeout_seconds=timeout_seconds)
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        summary = payload["summary"]
        typer.echo(
            "RunningHub media doctor "
            f"ok={payload['ok']} live_metadata={payload['live_metadata']} "
            f"ready_for_live_generation={payload['ready_for_live_generation']} "
            f"passed={summary['passed']} failed={summary['failed']} warnings={summary['warnings']}"
        )
        for check in payload["checks"]:
            status = "PASS" if check["passed"] else "FAIL"
            typer.echo(f"{status} {check['severity']} {check['name']}: {check['detail']}")
    if strict and not payload["ok"]:
        raise typer.Exit(1)


@media_app.command("generate")
def media_generate_command(
    template: str = typer.Argument(..., help="Template id: text_to_image, image_to_image, image_to_video, text_to_video"),
    prompt: str | None = typer.Option(None, "--prompt", help="Prompt text for text/image/video templates"),
    negative_prompt: str | None = typer.Option(None, "--negative-prompt", help="Optional negative prompt"),
    source_image: str | None = typer.Option(None, "--source-image", help="RunningHub image value or uploaded image reference"),
    source_video: str | None = typer.Option(None, "--source-video", help="RunningHub video value or uploaded video reference"),
    node_json: str | None = typer.Option(None, "--node-json", help="JSON list or @file containing RunningHub nodeInfoList"),
    input_json: str | None = typer.Option(None, "--input-json", help="JSON object or @file with extra logical input values"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir", help="Directory for sanitized media task artifacts"),
    run_id: str | None = typer.Option(None, "--run-id", help="Attach the media artifact to an existing run EvidenceBundle"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Write a sanitized artifact without calling RunningHub"),
    timeout_seconds: float = typer.Option(60.0, "--timeout", min=0.1, max=600.0),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Submit or dry-run a governed RunningHub image/video generation task."""
    node_info_list = _load_json_cli_value(node_json, expected="list")
    inputs = _load_json_cli_value(input_json, expected="object")
    resolved_artifact_dir, media_store = _media_cli_artifact_dir_and_store(run_id, artifact_dir)
    try:
        payload = submit_runninghub_media_task(
            RunningHubMediaRequest(
                template=template,
                prompt=prompt,
                negative_prompt=negative_prompt,
                source_image=source_image,
                source_video=source_video,
                node_info_list=tuple(dict(item) for item in node_info_list),
                inputs=inputs,
                dry_run=dry_run,
                artifact_dir=resolved_artifact_dir,
                timeout_seconds=timeout_seconds,
            )
        )
        payload = _attach_media_cli_result(
            payload,
            run_id,
            media_store,
            artifact_kind="runninghub-media-task-json",
            event_type="media.generate.recorded",
        )
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"status={payload['status']}")
    typer.echo(f"template={payload['template']['id']}")
    typer.echo(f"artifact_id={payload['artifact_id']}")
    typer.echo(f"artifact_path={payload['artifact_path']}")
    typer.echo(f"evidence_attached={str(payload.get('evidence_attached', False)).lower()}")
    if payload.get("run_artifact_url"):
        typer.echo(f"run_artifact_url={payload['run_artifact_url']}")
    if payload.get("task_id"):
        typer.echo(f"task_id={payload['task_id']}")


@media_app.command("render")
def media_render_command(
    template: str = typer.Argument(..., help="Template id: text_to_image, image_to_image, image_to_video, text_to_video"),
    prompt: str | None = typer.Option(None, "--prompt", help="Prompt text for text/image/video templates"),
    negative_prompt: str | None = typer.Option(None, "--negative-prompt", help="Optional negative prompt"),
    source_image: str | None = typer.Option(None, "--source-image", help="RunningHub image value or uploaded image reference"),
    source_video: str | None = typer.Option(None, "--source-video", help="RunningHub video value or uploaded video reference"),
    node_json: str | None = typer.Option(None, "--node-json", help="JSON list or @file containing RunningHub nodeInfoList"),
    input_json: str | None = typer.Option(None, "--input-json", help="JSON object or @file with extra logical input values"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir", help="Directory for sanitized media artifacts"),
    run_id: str | None = typer.Option(None, "--run-id", help="Attach every media step artifact to an existing run EvidenceBundle"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Write a sanitized generate artifact without calling RunningHub"),
    wait_for_outputs: bool = typer.Option(True, "--wait/--no-wait", help="After live submit, poll status and outputs until URLs are available"),
    max_polls: int = typer.Option(24, "--max-polls", min=0, max=240, help="Maximum status/output polling attempts"),
    poll_interval_seconds: float = typer.Option(5.0, "--poll-interval", min=0.0, max=3600.0, help="Seconds between polling attempts"),
    timeout_seconds: float = typer.Option(60.0, "--timeout", min=0.1, max=600.0, help="Timeout for the initial generate request"),
    query_timeout_seconds: float = typer.Option(30.0, "--query-timeout", min=0.1, max=600.0, help="Timeout for each status/output query"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Submit a media task and optionally wait for output URLs in one evidence chain."""
    node_info_list = _load_json_cli_value(node_json, expected="list")
    inputs = _load_json_cli_value(input_json, expected="object")
    resolved_artifact_dir, media_store = _media_cli_artifact_dir_and_store(run_id, artifact_dir)
    try:
        payload = render_runninghub_media_task(
            RunningHubMediaRenderRequest(
                generation=RunningHubMediaRequest(
                    template=template,
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    source_image=source_image,
                    source_video=source_video,
                    node_info_list=tuple(dict(item) for item in node_info_list),
                    inputs=inputs,
                    dry_run=dry_run,
                    artifact_dir=resolved_artifact_dir,
                    timeout_seconds=timeout_seconds,
                ),
                wait_for_outputs=wait_for_outputs,
                max_polls=max_polls,
                poll_interval_seconds=poll_interval_seconds,
                query_timeout_seconds=query_timeout_seconds,
            )
        )
        payload = _attach_media_cli_render_result(payload, run_id, media_store)
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"status={payload['status']}")
    typer.echo(f"template={payload['template']['id']}")
    typer.echo(f"task_id={payload.get('task_id') or ''}")
    typer.echo(f"artifact_count={payload.get('artifact_count', len(payload.get('artifacts', [])))}")
    typer.echo(f"evidence_attached={str(payload.get('evidence_attached', False)).lower()}")
    for artifact in payload.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        label = f"{artifact.get('step')}[{artifact.get('attempt')}]"
        typer.echo(f"artifact={label}:{artifact.get('artifact_id')}")
        if artifact.get("run_artifact_url"):
            typer.echo(f"run_artifact_url={artifact['run_artifact_url']}")
    for url in payload.get("output_urls", []):
        typer.echo(f"output_url={url}")


@media_app.command("upload")
def media_upload_command(
    file_path: Path = typer.Argument(..., help="Local image, video, audio, or ZIP file to upload to RunningHub"),
    file_type: str = typer.Option("input", "--file-type", help="RunningHub upload fileType value, usually input"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir", help="Directory for sanitized media upload artifacts"),
    run_id: str | None = typer.Option(None, "--run-id", help="Attach the media artifact to an existing run EvidenceBundle"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Write a sanitized artifact without uploading"),
    timeout_seconds: float = typer.Option(60.0, "--timeout", min=0.1, max=600.0),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Upload a local resource to RunningHub and return the provider fileName."""
    resolved_artifact_dir, media_store = _media_cli_artifact_dir_and_store(run_id, artifact_dir)
    try:
        payload = upload_runninghub_media_file(
            RunningHubMediaUploadRequest(
                file_path=file_path,
                file_type=file_type,
                dry_run=dry_run,
                artifact_dir=resolved_artifact_dir,
                timeout_seconds=timeout_seconds,
            )
        )
        payload = _attach_media_cli_result(
            payload,
            run_id,
            media_store,
            artifact_kind="runninghub-media-upload-json",
            event_type="media.upload.recorded",
        )
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"status={payload['status']}")
    typer.echo(f"artifact_id={payload['artifact_id']}")
    typer.echo(f"artifact_path={payload['artifact_path']}")
    typer.echo(f"evidence_attached={str(payload.get('evidence_attached', False)).lower()}")
    if payload.get("run_artifact_url"):
        typer.echo(f"run_artifact_url={payload['run_artifact_url']}")
    if payload.get("file_name"):
        typer.echo(f"file_name={payload['file_name']}")


@media_app.command("task-status")
def media_task_status_command(
    task_id: str = typer.Argument(..., help="RunningHub taskId"),
    mode: str = typer.Option("standard-api", "--mode", help="Query mode: standard-api or webapp"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir", help="Directory for sanitized media query artifacts"),
    run_id: str | None = typer.Option(None, "--run-id", help="Attach the media artifact to an existing run EvidenceBundle"),
    timeout_seconds: float = typer.Option(30.0, "--timeout", min=0.1, max=600.0),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Query RunningHub task status without printing key values."""
    resolved_artifact_dir, media_store = _media_cli_artifact_dir_and_store(run_id, artifact_dir)
    try:
        payload = query_runninghub_media_task(
            task_id,
            query="status",
            mode=mode,  # type: ignore[arg-type]
            artifact_dir=resolved_artifact_dir,
            timeout_seconds=timeout_seconds,
        )
        payload = _attach_media_cli_result(
            payload,
            run_id,
            media_store,
            artifact_kind="runninghub-media-status-json",
            event_type="media.task_status.recorded",
        )
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"task_id={payload['task_id']}")
    typer.echo(f"artifact_id={payload['artifact_id']}")
    typer.echo(f"artifact_path={payload['artifact_path']}")
    typer.echo(f"evidence_attached={str(payload.get('evidence_attached', False)).lower()}")
    if payload.get("run_artifact_url"):
        typer.echo(f"run_artifact_url={payload['run_artifact_url']}")
    typer.echo(f"status_response={json.dumps(payload['response'], ensure_ascii=False)}")


@media_app.command("outputs")
def media_outputs_command(
    task_id: str = typer.Argument(..., help="RunningHub taskId"),
    mode: str = typer.Option("standard-api", "--mode", help="Query mode: standard-api or webapp"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir", help="Directory for sanitized media query artifacts"),
    run_id: str | None = typer.Option(None, "--run-id", help="Attach the media artifact to an existing run EvidenceBundle"),
    timeout_seconds: float = typer.Option(30.0, "--timeout", min=0.1, max=600.0),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Query RunningHub task output URLs without printing key values."""
    resolved_artifact_dir, media_store = _media_cli_artifact_dir_and_store(run_id, artifact_dir)
    try:
        payload = query_runninghub_media_task(
            task_id,
            query="outputs",
            mode=mode,  # type: ignore[arg-type]
            artifact_dir=resolved_artifact_dir,
            timeout_seconds=timeout_seconds,
        )
        payload = _attach_media_cli_result(
            payload,
            run_id,
            media_store,
            artifact_kind="runninghub-media-outputs-json",
            event_type="media.outputs.recorded",
        )
    except RunningHubMediaError as exc:
        typer.echo(f"media_error={exc}", err=True)
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"task_id={payload['task_id']}")
    typer.echo(f"artifact_id={payload['artifact_id']}")
    typer.echo(f"artifact_path={payload['artifact_path']}")
    typer.echo(f"evidence_attached={str(payload.get('evidence_attached', False)).lower()}")
    if payload.get("run_artifact_url"):
        typer.echo(f"run_artifact_url={payload['run_artifact_url']}")
    typer.echo(f"outputs_response={json.dumps(payload['response'], ensure_ascii=False)}")


@plugin_app.command("verify")
def plugin_verify(
    path: Path = typer.Argument(..., help="Plugin directory or .scplug archive"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key; defaults to SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Plugin revocation list; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/revocations.json"),
    cache: bool = typer.Option(True, "--cache/--no-cache"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Verify a local plugin package and cache it only after checks pass."""
    revocation_file = revocation_file or default_revocation_file()
    try:
        result = verify_plugin_package(
            path,
            public_key=public_key,
            cache_root=_plugin_cache_path(),
            revocation_file=revocation_file,
            cache=cache,
            # `plugin verify` operates on a user-chosen LOCAL package path, so a
            # skill-origin package it caches is local-provenance (sign-free
            # equippable, design §3.7). The CLI registry install path
            # (install_plugin_from_cloud_metadata) stamps `remote` itself.
            provenance="local" if cache else None,
            install_entry="plugin-verify-local",
        )
    except PluginVerificationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "digest": result.digest,
        "cached_path": str(result.cached_path) if result.cached_path else None,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("list")
def plugin_list(json_output: bool = typer.Option(False, "--json")) -> None:
    """List locally cached plugins."""
    rows = list_cached_plugins(cache_root=_plugin_cache_path())
    if json_output:
        typer.echo(json.dumps({"plugins": rows}, ensure_ascii=False))
        return
    if not rows:
        typer.echo("No cached plugins.")
        return
    for row in rows:
        typer.echo(f"{row['id']}@{row['version']} {row['path']}")


def _native_skill_payload(record: SkillImportRecord) -> dict[str, Any]:
    return {
        "slug": record.slug,
        "id": record.slug,
        "name": record.name,
        "description": record.description,
        "label": record.label,
        "source_digest": record.source_digest,
        "store_digest": record.store_digest,
        "signature": record.signature,
        "signed": bool(record.signature),
        "executable": record.executable,
        "executable_assets": list(record.executable_assets),
        "imported_at": record.imported_at,
        "importer": record.importer,
        "skill_origin": True,
        "catalog_kind": "skill",
        "source": "native",
    }


def _run_native_skill_import(
    *,
    skill_path: Path,
    store_dir: Path | None,
    label: str,
    publisher: str | None,
    source_url: str | None,
    signature: str | None,
    public_key: str | None,
    importer: str,
    allow_executable: bool,
    force: bool,
    json_output: bool,
    revocation_file: Path | None = None,
    migration_warning: str | None = None,
) -> None:
    try:
        record = import_native_skill(
            skill_path,
            store_dir=store_dir,
            label=label,
            publisher=publisher,
            source_url=source_url,
            signature=signature,
            public_key=public_key,
            importer=importer,
            allow_executable=allow_executable,
            force=force,
            revocation_file=revocation_file or _default_skill_revocation_file(),
        )
    except (SkillStoreError, OSError) as exc:
        if json_output:
            payload: dict[str, Any] = {"ok": False, "error": str(exc)}
            if migration_warning:
                payload["warning"] = migration_warning
            typer.echo(json.dumps(payload, ensure_ascii=False))
        else:
            if migration_warning:
                typer.echo(f"warning: {migration_warning}", err=True)
            typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    payload = {"ok": True, "skill": _native_skill_payload(record)}
    if migration_warning:
        payload["warning"] = migration_warning
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    if migration_warning:
        typer.echo(f"warning: {migration_warning}", err=True)
    for key, value in payload["skill"].items():
        typer.echo(f"{key}={value}")


@skill_app.command("list")
def skill_list(
    store_dir: Path | None = typer.Option(None, "--store-dir", help="Native skill store directory; defaults to ~/.superclaw/skills"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Native-skill revocation list; defaults to SUPERCLAW_SKILL_REVOCATION_FILE or ~/.superclaw/skills/revocations.json"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List imported native skills."""
    rows = [
        _native_skill_payload(record)
        for record in list_native_skills(
            store_dir=store_dir,
            revocation_file=revocation_file or _default_skill_revocation_file(),
        )
    ]
    if json_output:
        typer.echo(json.dumps({"skills": rows}, ensure_ascii=False))
        return
    if not rows:
        typer.echo("No native skills imported.")
        return
    for row in rows:
        typer.echo(f"{row['slug']} {row['name']} label={row['label']} executable={str(bool(row['executable'])).lower()}")


@skill_app.command("import")
def skill_import(
    skill_path: Path = typer.Argument(..., help="Path to a SKILL.md file or a directory containing one"),
    store_dir: Path | None = typer.Option(None, "--store-dir", help="Native skill store directory; defaults to ~/.superclaw/skills"),
    label: str = typer.Option("local-dev", "--label", help="Skill trust label: official, reviewed, community, local-dev"),
    publisher: str | None = typer.Option(None, "--publisher", help="Publisher metadata recorded in provenance"),
    source_url: str | None = typer.Option(None, "--source-url", help="Source URL metadata recorded in provenance"),
    signature: str | None = typer.Option(None, "--signature", help="Ed25519 signature for non-local labels"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key for non-local labels"),
    importer: str = typer.Option("superclaw-cli", "--importer", help="Importer id recorded in provenance"),
    yes_executable: bool = typer.Option(False, "--yes-executable", help="Import after explicitly reviewing executable assets or script blocks"),
    force: bool = typer.Option(False, "--force", help="Replace an existing native skill with the same slug"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Native-skill revocation list; defaults to SUPERCLAW_SKILL_REVOCATION_FILE or ~/.superclaw/skills/revocations.json"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Import a SKILL.md into the native skill store (chat-runtime projection).

    Use `skill build` instead to produce a governed, *equippable* skill plugin a
    team agent can be granted.
    """
    _run_native_skill_import(
        skill_path=skill_path,
        store_dir=store_dir,
        label=label,
        publisher=publisher,
        source_url=source_url,
        signature=signature,
        public_key=public_key,
        importer=importer,
        allow_executable=yes_executable,
        force=force,
        revocation_file=revocation_file,
        json_output=json_output,
    )


def _run_skill_build(
    *,
    skill_path: Path,
    plugin_id: str | None,
    version: str,
    developer_id: str,
    sign: bool,
    signing_private_key: str | None,
    force: bool,
    json_output: bool,
) -> None:
    try:
        result = build_and_install_skill_plugin(
            skill_path,
            plugin_id=plugin_id,
            version=version,
            developer_id=developer_id,
            sign=sign,
            signing_private_key=signing_private_key,
            cache_root=_plugin_cache_path(),
            force=force,
        )
    except SkillBuildError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "package_digest": result.package_digest,
        "trust_state": result.trust_state,
        "equippable": result.equippable,
        "signed": result.signed,
        "warnings": result.warnings,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for warning in result.warnings:
        typer.echo(f"warning: {warning}", err=True)
    for key in ("plugin_id", "version", "package_digest", "trust_state", "equippable", "signed"):
        value = payload[key]
        typer.echo(f"{key}={str(value).lower() if isinstance(value, bool) else value}")


@skill_app.command("build")
def skill_build(
    skill_path: Path = typer.Argument(..., help="Path to a SKILL.md file or a directory containing one"),
    plugin_id: str | None = typer.Option(None, "--plugin-id", help="Plugin id (default: skill.<slug>)"),
    version: str = typer.Option("0.1.0", "--version", help="Package version"),
    developer_id: str = typer.Option("local-dev", "--developer-id", help="Developer id recorded in the manifest source (advisory only)"),
    sign: bool = typer.Option(False, "--sign", help="Generate an ephemeral dev signature (OPTIONAL; a local skill is equippable unsigned and a self-signature does NOT upgrade its `local` grade)"),
    signing_private_key: str | None = typer.Option(None, "--signing-private-key", help="Base64 Ed25519 private key to sign with (optional; does not change the `local` grade)"),
    force: bool = typer.Option(False, "--force", help="Replace an existing build of the same id/version"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Build a SKILL.md into a governed, equippable `local` skill plugin.

    Wraps the SKILL.md as a skill-origin plugin and installs it through the LOCAL
    install entry, so it is graded `local` and equippable by a team agent SIGN-FREE
    (owner's provenance model). Signing is optional and never upgrades the grade.
    Unlike `skill import` (native chat-runtime projection), `skill build` produces
    the equippable governed object the equipment resolver reads.
    """
    _run_skill_build(
        skill_path=skill_path,
        plugin_id=plugin_id,
        version=version,
        developer_id=developer_id,
        sign=sign,
        signing_private_key=signing_private_key,
        force=force,
        json_output=json_output,
    )


@skill_app.command("install")
def skill_install(
    skill_path: Path = typer.Argument(..., help="Path to a SKILL.md file or a directory containing one"),
    plugin_id: str | None = typer.Option(None, "--plugin-id", help="Plugin id (default: skill.<slug>)"),
    version: str = typer.Option("0.1.0", "--version", help="Package version"),
    developer_id: str = typer.Option("local-dev", "--developer-id", help="Developer id recorded in the manifest source (advisory only)"),
    sign: bool = typer.Option(False, "--sign", help="Generate an ephemeral dev signature (optional; does not change the `local` grade)"),
    signing_private_key: str | None = typer.Option(None, "--signing-private-key", help="Base64 Ed25519 private key to sign with (optional)"),
    force: bool = typer.Option(False, "--force", help="Replace an existing build of the same id/version"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Alias of `skill build`: build a SKILL.md and install it as an equippable `local` skill."""
    _run_skill_build(
        skill_path=skill_path,
        plugin_id=plugin_id,
        version=version,
        developer_id=developer_id,
        sign=sign,
        signing_private_key=signing_private_key,
        force=force,
        json_output=json_output,
    )


@skill_app.command("sync")
def skill_sync(
    skill_slug: str | None = typer.Option(None, "--skill", help="Sync only this native skill slug"),
    target: list[str] = typer.Option([], "--target", help="Runtime target(s): codex, claude, gemini (default: all)"),
    store_dir: Path | None = typer.Option(None, "--store-dir", help="Native skill store directory; defaults to ~/.superclaw/skills"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Native-skill revocation list; defaults to SUPERCLAW_SKILL_REVOCATION_FILE or ~/.superclaw/skills/revocations.json"),
    lock_path: Path | None = typer.Option(None, "--lock", help="Projection lock file; defaults under SUPERCLAW_HOME (or SUPERCLAW_PROJECTION_LOCK)"),
    force: bool = typer.Option(False, "--force", help="Re-assert SuperClaw's own hand-edited projections (never overwrites a same-named skill SuperClaw did not project)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Project native stored skills into runtime skill directories."""
    try:
        result = sync_native_skills(
            skill_slug=skill_slug,
            targets=tuple(target) or None,
            store_dir=store_dir,
            revocation_file=revocation_file or _default_skill_revocation_file(),
            lock_path=lock_path,
            force=force,
        )
    except (SkillSyncError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, **result.to_dict()}, ensure_ascii=False))
        return
    for path in result.written:
        typer.echo(f"written={path}")
    for path in result.unchanged:
        typer.echo(f"unchanged={path}")
    for path in result.skipped_local_override:
        typer.echo(f"skipped-local-override={path}")
    for path in result.reclaimed:
        typer.echo(f"reclaimed={path}")


@skill_app.command("status")
def skill_status(
    skill_slug: str | None = typer.Option(None, "--skill", help="Report only this native skill slug"),
    target: list[str] = typer.Option([], "--target", help="Runtime target(s): codex, claude, gemini (default: all)"),
    store_dir: Path | None = typer.Option(None, "--store-dir", help="Native skill store directory; defaults to ~/.superclaw/skills"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Native-skill revocation list; defaults to SUPERCLAW_SKILL_REVOCATION_FILE or ~/.superclaw/skills/revocations.json"),
    lock_path: Path | None = typer.Option(None, "--lock", help="Projection lock file; defaults under SUPERCLAW_HOME (or SUPERCLAW_PROJECTION_LOCK)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Report native-skill projection health (drift / stale / collisions) — read-only."""
    try:
        rows = native_skill_status(
            skill_slug=skill_slug,
            targets=tuple(target) or None,
            store_dir=store_dir,
            revocation_file=revocation_file or _default_skill_revocation_file(),
            lock_path=lock_path,
        )
    except (SkillSyncError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))
        return
    if not rows:
        typer.echo("no native skills")
        return
    for row in rows:
        typer.echo(f"{row['status']}\t{row['slug']}\t{row['target']}\t{row['detail']}")


def _resolve_catalog_cli(
    *,
    kind: str | None,
    cache_root: Path | None,
    cloud_root: Path | None,
    registry_root: Path | None,
    companies_root: Path | None,
    entitlement_file: Path | None,
    revocation_file: Path | None,
    policy_file: Path | None,
    public_key: str | None,
    runtime_version: str,
):
    if kind is not None and kind not in CATALOG_KINDS:
        _fail(f"unknown catalog kind: {kind!r}")
    try:
        return resolve_catalog(
            kind=kind,
            cache_root=cache_root or _plugin_cache_path(),
            cloud_root=cloud_root or _plugin_cloud_path(),
            registry_root=registry_root or default_registry_root(),
            companies_root=companies_root or default_companies_root(),
            entitlement_file=entitlement_file,
            revocation_file=revocation_file,
            policy_file=policy_file,
            public_key=public_key,
            runtime_version=runtime_version,
        )
    except ValueError as exc:
        _fail(str(exc))


@catalog_app.command("resolve")
def catalog_resolve_command(
    kind: str | None = typer.Option(None, "--kind", help="plugin | skill | company"),
    cache_root: Path | None = typer.Option(None, "--cache-root"),
    cloud_root: Path | None = typer.Option(None, "--cloud-root"),
    registry_root: Path | None = typer.Option(None, "--registry-root"),
    companies_root: Path | None = typer.Option(None, "--companies-root"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file"),
    policy_file: Path | None = typer.Option(None, "--policy-file"),
    public_key: str | None = typer.Option(None, "--public-key"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Resolve the read-only Capability Workshop catalog union."""
    resolution = _resolve_catalog_cli(
        kind=kind,
        cache_root=cache_root,
        cloud_root=cloud_root,
        registry_root=registry_root,
        companies_root=companies_root,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
        runtime_version=runtime_version,
    )
    payload = resolution.to_dict()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"resolved_at={payload['resolved_at']}")
    for item in payload["items"]:
        typer.echo(f"{item['kind']} {item['plugin_id']}@{item['version']} trust={item['trust']} sources={','.join(item['sources'])}")
    for conflict in payload["conflicts"]:
        typer.echo(f"conflict {conflict['plugin_id']}: {conflict['reason']}")


@catalog_app.command("list")
def catalog_list_command(
    kind: str = typer.Option(..., "--kind", help="plugin | skill | company"),
    cache_root: Path | None = typer.Option(None, "--cache-root"),
    cloud_root: Path | None = typer.Option(None, "--cloud-root"),
    registry_root: Path | None = typer.Option(None, "--registry-root"),
    companies_root: Path | None = typer.Option(None, "--companies-root"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file"),
    policy_file: Path | None = typer.Option(None, "--policy-file"),
    public_key: str | None = typer.Option(None, "--public-key"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List one catalog kind using the same resolver as ``catalog resolve``."""
    resolution = _resolve_catalog_cli(
        kind=kind,
        cache_root=cache_root,
        cloud_root=cloud_root,
        registry_root=registry_root,
        companies_root=companies_root,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
        runtime_version=runtime_version,
    )
    payload = {"ok": True, "kind": kind, "items": [item.to_dict() for item in resolution.items], "conflicts": list(resolution.conflicts)}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    if not payload["items"]:
        typer.echo(f"No {kind} catalog items.")
        return
    for item in payload["items"]:
        typer.echo(f"{item['plugin_id']}@{item['version']} trust={item['trust']}")


@catalog_app.command("refresh")
def catalog_refresh_command(
    source_url: str | None = typer.Option(None, "--source-url"),
    registry_root: Path | None = typer.Option(None, "--registry-root"),
    public_key: str | None = typer.Option(None, "--public-key"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Refresh catalog trust metadata without clearing existing cached state."""
    result = refresh_catalog(registry_root=registry_root or default_registry_root(), source_url=source_url, public_key=public_key)
    payload = result.to_dict()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
    else:
        typer.echo(f"ok={str(payload['ok']).lower()} kept_cached={str(payload['kept_cached']).lower()}")
        if payload.get("error"):
            typer.echo(f"error={payload['error']}")
    if not result.ok:
        raise typer.Exit(1)


@trust_app.command("state")
def trust_state_command(
    plugin_ref: str = typer.Argument(..., help="Artifact id and version, for example dev.acme.pay@0.2.0"),
    kind: str | None = typer.Option(None, "--kind", help="plugin | skill | company"),
    cache_root: Path | None = typer.Option(None, "--cache-root"),
    cloud_root: Path | None = typer.Option(None, "--cloud-root"),
    registry_root: Path | None = typer.Option(None, "--registry-root"),
    companies_root: Path | None = typer.Option(None, "--companies-root"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file"),
    policy_file: Path | None = typer.Option(None, "--policy-file"),
    public_key: str | None = typer.Option(None, "--public-key"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Resolve one catalog artifact's authoritative TrustState."""
    plugin_id, marker, version = plugin_ref.partition("@")
    if not marker or not plugin_id or not version:
        _fail("trust state expects <id>@<version>")
    if kind is not None and kind not in CATALOG_KINDS:
        _fail(f"unknown catalog kind: {kind!r}")
    derivation = resolve_trust_state(
        plugin_id,
        version,
        kind=kind,
        cache_root=cache_root or _plugin_cache_path(),
        cloud_root=cloud_root or _plugin_cloud_path(),
        registry_root=registry_root or default_registry_root(),
        companies_root=companies_root or default_companies_root(),
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
        runtime_version=runtime_version,
    )
    payload = trust_derivation_to_dict(plugin_id, version, derivation)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"{plugin_id}@{version} trust={payload['trust']} signer={payload['signer_class']}")


@plugin_config_app.command("set")
def plugin_config_set(
    plugin_id: str = typer.Argument(..., help="Plugin id"),
    setting_name: str = typer.Argument(..., help="Non-secret setting name"),
    value: str = typer.Argument(..., help="Setting value"),
    config_file: Path | None = typer.Option(None, "--config-file", help="Local plugin config store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Store a local non-secret plugin setting."""
    try:
        result = set_plugin_setting(plugin_id, setting_name, value, config_file=config_file)
    except PluginConfigurationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, "plugin_id": result.plugin_id, "setting": result.name, "configured": True}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, item in payload.items():
        typer.echo(f"{key}={item}")


@plugin_secret_app.command("set")
def plugin_secret_set(
    plugin_id: str = typer.Argument(..., help="Plugin id"),
    secret_name: str = typer.Argument(..., help="Manifest-declared secret name"),
    value: str = typer.Option(..., "--value", prompt=True, hide_input=True, help="Secret value; never printed"),
    version_range: str = typer.Option("*", "--version-range", help="Plugin version range this secret applies to"),
    user_id: str | None = typer.Option(None, "--user-id", help="Local SuperClaw user id scope"),
    device_id: str | None = typer.Option(None, "--device-id", help="Local SuperClaw device id scope"),
    config_file: Path | None = typer.Option(None, "--config-file", help="Local plugin config store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Store a local plugin secret for later proxy injection."""
    try:
        result = set_plugin_secret(plugin_id, secret_name, value, version_range=version_range, user_id=user_id, device_id=device_id, config_file=config_file)
    except PluginConfigurationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "secret": result.name,
        "user_id": result.user_id,
        "device_id": result.device_id,
        "version_range": result.version_range,
        "configured": True,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, item in payload.items():
        typer.echo(f"{key}={item}")


@plugin_secret_app.command("delete")
def plugin_secret_delete(
    plugin_id: str = typer.Argument(..., help="Plugin id"),
    secret_name: str = typer.Argument(..., help="Manifest-declared secret name"),
    user_id: str | None = typer.Option(None, "--user-id", help="Local SuperClaw user id scope"),
    device_id: str | None = typer.Option(None, "--device-id", help="Local SuperClaw device id scope"),
    config_file: Path | None = typer.Option(None, "--config-file", help="Local plugin config store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Delete a local plugin secret without printing its value."""
    try:
        result = delete_plugin_secret(plugin_id, secret_name, user_id=user_id, device_id=device_id, config_file=config_file)
    except PluginConfigurationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "secret": result.name,
        "user_id": result.user_id,
        "device_id": result.device_id,
        "deleted": result.deleted,
        "configured": False,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, item in payload.items():
        typer.echo(f"{key}={item}")


@plugin_secret_app.command("status")
def plugin_secret_status_command(
    plugin_id: str = typer.Argument(..., help="Plugin id"),
    user_id: str | None = typer.Option(None, "--user-id", help="Local SuperClaw user id scope"),
    device_id: str | None = typer.Option(None, "--device-id", help="Local SuperClaw device id scope"),
    config_file: Path | None = typer.Option(None, "--config-file", help="Local plugin config store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Report configured local plugin secrets without printing values."""
    try:
        rows = plugin_secret_status(plugin_id, user_id=user_id, device_id=device_id, config_file=config_file)
    except PluginConfigurationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, "plugin_id": plugin_id, "secrets": rows}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    if not rows:
        typer.echo("No configured plugin secrets.")
        return
    for row in rows:
        typer.echo(f"{row['name']} configured={row['configured']}")


@plugin_app.command("search")
def plugin_search(
    query: str = typer.Argument("", help="Search text matched against sanitized registry metadata"),
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root", help="Local Phase 5 fake-cloud root"),
    category: str | None = typer.Option(None, "--category"),
    runtime: str | None = typer.Option(None, "--runtime"),
    platform: str | None = typer.Option(None, "--platform"),
    acceptance_level: str | None = typer.Option(None, "--acceptance-level"),
    verified: str | None = typer.Option(None, "--verified"),
    pricing_model: str | None = typer.Option(None, "--pricing-model"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Search local fake-cloud registry metadata without exposing package paths."""
    filters = {
        "category": category,
        "runtime": runtime,
        "platform": platform,
        "acceptance_level": acceptance_level,
        "verified": verified,
        "pricing_model": pricing_model,
    }
    try:
        rows = search_registry_plugins(_plugin_cloud_path() if cloud_root == DEFAULT_CLOUD_ROOT else cloud_root, query, filters=filters)
    except PluginCloudSyncError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, "query": query, "plugins": rows}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    if not rows:
        typer.echo("No registry plugins matched.")
        return
    for row in rows:
        typer.echo(
            f"{row['plugin_id']}@{row['version']} {row.get('name') or row['plugin_id']} "
            f"verified={row['verified']} pricing={row.get('pricing_model')}"
        )


@plugin_app.command("init")
def plugin_init(
    plugin_id: str = typer.Argument(..., help="Reverse-DNS plugin id, for example com.example.repo-scanner"),
    output_dir: Path | None = typer.Option(None, "--output-dir", help="Starter package directory; defaults to the plugin id"),
    name: str | None = typer.Option(None, "--name", help="Human-readable plugin name"),
    tool_name: str = typer.Option("hello_world", "--tool-name", help="Starter tool name"),
    developer_id: str = typer.Option("local-dev", "--developer-id", help="Local developer id recorded in manifest provenance"),
    force: bool = typer.Option(False, "--force", help="Replace an existing output directory"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Create a schema-valid local starter plugin package."""
    try:
        result = init_plugin_package(
            plugin_id,
            output_dir=output_dir,
            name=name,
            tool_name=tool_name,
            developer_id=developer_id,
            force=force,
        )
    except PluginDevkitError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "tool_name": result.tool_name,
        "package_root": str(result.package_root),
        "created_files": [path.relative_to(result.package_root).as_posix() for path in result.created_files],
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("dev")
def plugin_dev(
    package_root: Path = typer.Argument(Path("."), help="Local plugin package directory"),
    tool_name: str = typer.Option(..., "--tool", help="Declared tool to run"),
    input_json: str = typer.Option("{}", "--json", help="JSON object used as the tool input"),
    timeout_seconds: float | None = typer.Option(None, "--timeout-seconds"),
    json_output: bool = typer.Option(False, "--output-json"),
) -> None:
    """Run a local starter sidecar for development without cloud or entitlement state."""
    try:
        payload = json.loads(input_json)
    except json.JSONDecodeError as exc:
        typer.echo(f"error: invalid --json: {exc}")
        raise typer.Exit(1) from exc
    if not isinstance(payload, dict):
        typer.echo("error: --json must be a JSON object")
        raise typer.Exit(1)
    try:
        result = run_plugin_dev(package_root, tool_name=tool_name, input_payload=payload, timeout_seconds=timeout_seconds)
    except (PluginDevkitError, PluginVerificationError, OSError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    output = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "tool_name": result.tool_name,
        "response": result.response,
    }
    if json_output:
        typer.echo(json.dumps(output, ensure_ascii=False))
        return
    typer.echo(json.dumps(result.response, ensure_ascii=False))


@plugin_app.command("pack")
def plugin_pack(
    package_root: Path = typer.Argument(Path("."), help="Local plugin package directory"),
    dist_dir: Path = typer.Option(Path("dist"), "--dist-dir", help="Output directory for the .scplug archive"),
    signing_private_key: str | None = typer.Option(None, "--signing-private-key", help="Base64 Ed25519 private key; local/dev signing only"),
    dev_sign: bool = typer.Option(False, "--dev-sign", help="Generate an ephemeral local signing key and print the public key"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Pack a local plugin directory into a .scplug archive."""
    try:
        result = pack_plugin_package(package_root, dist_dir=dist_dir, signing_private_key=signing_private_key, dev_sign=dev_sign)
    except (PluginDevkitError, PluginVerificationError, OSError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "package_path": str(result.package_path),
        "package_digest": result.package_digest,
        "signed": result.signed,
        "public_key": result.public_key,
        "requires_platform_signing": not result.signed,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("import-skill")
def plugin_import_skill(
    skill_path: Path = typer.Argument(..., help="Path to a standard SKILL.md file or a directory containing one"),
    store_dir: Path | None = typer.Option(None, "--store-dir", help="Native skill store directory; defaults to ~/.superclaw/skills"),
    label: str = typer.Option("local-dev", "--label", help="Skill trust label: official, reviewed, community, local-dev"),
    publisher: str | None = typer.Option(None, "--publisher", help="Publisher metadata recorded in provenance"),
    source_url: str | None = typer.Option(None, "--source-url", help="Source URL metadata recorded in provenance"),
    signature: str | None = typer.Option(None, "--signature", help="Ed25519 signature for non-local labels"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key for non-local labels"),
    importer: str = typer.Option("superclaw-cli-legacy-alias", "--importer", help="Importer id recorded in provenance"),
    yes_executable: bool = typer.Option(False, "--yes-executable", help="Import after explicitly reviewing executable assets or script blocks"),
    force: bool = typer.Option(False, "--force", help="Replace an existing native skill with the same slug"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Migration alias for ``superclaw skill import``."""
    warning = "superclaw plugin import-skill is deprecated; use superclaw skill import. Imported into the native skill store."
    _run_native_skill_import(
        skill_path=skill_path,
        store_dir=store_dir,
        label=label,
        publisher=publisher,
        source_url=source_url,
        signature=signature,
        public_key=public_key,
        importer=importer,
        allow_executable=yes_executable,
        force=force,
        json_output=json_output,
        migration_warning=warning,
    )


@plugin_app.command("install")
def plugin_install(
    plugin_ref: str = typer.Argument(..., help="Plugin id with optional @version, for example com.example.tool@0.1.0"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key; defaults to SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root", help="Local Phase 5 fake-cloud root"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file", help="Plugin entitlement grants; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/entitlements.json"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Plugin revocation list; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/revocations.json"),
    policy_file: Path | None = typer.Option(None, "--policy-file", help="Plugin runtime policy; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/runtime-policy.json"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version", help="Runtime version used for policy checks"),
    sync_skills: bool = typer.Option(False, "--sync-skills", help="Also project the installed plugin's skills into native runtime dirs"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Install a plugin from local fake-cloud registry metadata.

    Pass --sync-skills to also project the plugin's skills into the native
    runtime skill directories in one step, using the same governance gate inputs
    as execution. Projection is off by default (it writes into the user's runtime
    dirs); when requested, a projection failure fails the command (exit 1) while
    still reporting installed:true.
    """
    plugin_id, requested_version = _parse_plugin_ref(plugin_ref)
    resolved_cloud_root = _plugin_cloud_path() if cloud_root == DEFAULT_CLOUD_ROOT else cloud_root
    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    policy_file = policy_file or default_policy_file()
    resolved_public_key = public_key or os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY") or ""
    try:
        version = resolve_registry_plugin_version(resolved_cloud_root, plugin_id, requested_version)
        result = install_plugin_from_cloud_metadata(
            resolved_cloud_root,
            plugin_id,
            version,
            public_key=resolved_public_key,
            cache_root=_plugin_cache_path(),
            revocation_file=revocation_file,
        )
    except (PluginCloudSyncError, PluginVerificationError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload: dict[str, Any] = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "digest": result.digest,
        "installed": True,
    }
    if sync_skills:
        # The plugin is already installed; an explicit --sync-skills that fails
        # must surface as a non-success exit (don't let automation read it as
        # "installed and projected"), while still reporting installed:true.
        try:
            sync_result = sync_plugin_skills(
                plugin_id=result.plugin_id,
                public_key=resolved_public_key or None,
                entitlement_file=entitlement_file,
                revocation_file=revocation_file,
                policy_file=policy_file,
                runtime_version=runtime_version,
            )
            payload["skills_synced"] = sync_result.written
        except (SkillSyncError, OSError, ValueError) as exc:
            payload["ok"] = False
            payload["sync_error"] = str(exc)
            if json_output:
                typer.echo(json.dumps(payload, ensure_ascii=False))
            else:
                for key, value in payload.items():
                    typer.echo(f"{key}={value}")
            raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("uninstall")
def plugin_uninstall(
    plugin_ref: str = typer.Argument(..., help="Plugin id with optional @version"),
    lock_path: Path | None = typer.Option(None, "--lock", help="Projection lock file; defaults under SUPERCLAW_HOME (or SUPERCLAW_PROJECTION_LOCK)"),
    keep_skills: bool = typer.Option(False, "--keep-skills", help="Leave projected native skills in place"),
    force: bool = typer.Option(False, "--force", help="Remove the cache even if reclaiming projected skills failed"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Uninstall a cached plugin and reclaim its projected native skills.

    The projected skill files are reclaimed before the cache is removed (use
    --keep-skills to leave them). If reclaiming fails the cache is kept so the
    manifest stays available for a retry — pass --force to remove anyway. A
    user's hand-edited file is never deleted.
    """
    plugin_id, requested_version = _parse_plugin_ref(plugin_ref)
    payload: dict[str, Any] = {"ok": True, "plugin_id": plugin_id}
    if not keep_skills:
        # Reclaim before removing the cache. If reclaim hard-fails, abort the
        # cache removal (unless --force) so we don't orphan files we can no
        # longer trace back to a manifest.
        try:
            unsynced = unsync_plugin_skills(plugin_id=plugin_id, lock_path=lock_path)
            payload["skills_removed"] = unsynced.removed
            payload["skills_kept_local_override"] = unsynced.skipped_local_override
        except (SkillSyncError, OSError, ValueError) as exc:
            payload["unsync_error"] = str(exc)
            if not force:
                payload["ok"] = False
                payload["removed"] = False
                if json_output:
                    typer.echo(json.dumps(payload, ensure_ascii=False))
                else:
                    for key, value in payload.items():
                        typer.echo(f"{key}={value}")
                raise typer.Exit(1) from exc
    try:
        result = uninstall_cached_plugin(
            plugin_id,
            version=requested_version,
            cache_root=_plugin_cache_path(),
        )
    except PluginVerificationError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload["removed"] = result["removed"]
    payload["versions"] = result["versions"]
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("call")
def plugin_call(
    plugin_id: str = typer.Argument(..., help="Installed plugin id"),
    tool_name: str = typer.Argument(..., help="Declared plugin tool name"),
    input_json: str = typer.Option("{}", "--input-json", help="JSON object sent to the plugin proxy"),
    version: str | None = typer.Option(None, "--version", help="Plugin version; defaults to latest cached version"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key; defaults to SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file", help="Plugin entitlement grants; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/entitlements.json"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Plugin revocation list; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/revocations.json"),
    policy_file: Path | None = typer.Option(None, "--policy-file", help="Plugin runtime policy; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/runtime-policy.json"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version", help="Local SuperClaw runtime version used for synced policy checks"),
    config_file: Path | None = typer.Option(None, "--config-file"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    run_id: str = typer.Option("plugin_proxy_cli", "--run-id"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Call a cached plugin tool through the local SuperClaw proxy boundary."""
    try:
        payload = json.loads(input_json)
    except json.JSONDecodeError as exc:
        typer.echo(f"error: invalid --input-json: {exc}")
        raise typer.Exit(1) from exc
    if not isinstance(payload, dict):
        typer.echo("error: --input-json must be a JSON object")
        raise typer.Exit(1)

    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    policy_file = policy_file or default_policy_file()
    result = invoke_cached_plugin_tool(
        plugin_id,
        tool_name,
        payload,
        version=version,
        public_key=public_key,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        runtime_version=runtime_version,
        config_file=config_file,
        artifact_dir=artifact_dir,
        run_id=run_id,
    )
    output = {
        "ok": result.ok,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "tool_name": result.tool_name,
        "response": result.model_response,
        "evidence_artifact_id": result.evidence_record["evidence_artifact_id"],
    }
    if json_output:
        typer.echo(json.dumps(output, ensure_ascii=False))
    else:
        typer.echo(f"ok={result.ok}")
        typer.echo(f"plugin_id={result.plugin_id}")
        typer.echo(f"version={result.version}")
        typer.echo(f"tool_name={result.tool_name}")
        if result.ok:
            typer.echo(f"response={json.dumps(result.model_response, ensure_ascii=False)}")
        else:
            typer.echo(f"error_code={result.model_response['error']['code']}")
        typer.echo(f"evidence_artifact_id={result.evidence_record['evidence_artifact_id']}")
    if not result.ok:
        raise typer.Exit(1)


@plugin_app.command("evidence-list")
def plugin_evidence_list(
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List local plugin invocation evidence without printing raw outputs."""
    rows = list_plugin_evidence(artifact_dir)
    if json_output:
        typer.echo(json.dumps({"evidence": rows}, ensure_ascii=False))
        return
    if not rows:
        typer.echo("No plugin invocation evidence.")
        return
    for row in rows:
        typer.echo(
            f"{row['artifact_id']} {row['plugin_id']}@{row['plugin_version']} "
            f"{row['tool_name']} status={row['status']} locked={row['locked']}"
        )


@plugin_app.command("evidence-prune")
def plugin_evidence_prune(
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    retention_days: int = typer.Option(7, "--retention-days"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Prune successful local plugin evidence older than the retention window."""
    try:
        result = prune_plugin_evidence(artifact_dir, retention_days=retention_days)
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"deleted": result.deleted, "kept": result.kept, "locked": result.locked, "missing": result.missing}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={len(value)}")


@plugin_app.command("evidence-clear")
def plugin_evidence_clear(
    artifact_id: list[str] = typer.Argument(..., help="Evidence artifact id(s) to clear"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Clear selected local plugin evidence unless it is locked for review."""
    try:
        result = clear_plugin_evidence(artifact_id, artifact_dir)
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"deleted": result.deleted, "kept": result.kept, "locked": result.locked, "missing": result.missing}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={len(value)}")


@plugin_app.command("diagnostics")
def plugin_diagnostics(
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    slow_call_ms: int = typer.Option(30_000, "--slow-call-ms"),
    failure_rate_threshold: float = typer.Option(0.5, "--failure-rate-threshold"),
    failure_rate_min_invocations: int = typer.Option(3, "--failure-rate-min-invocations"),
    sandbox_kill_threshold: int = typer.Option(2, "--sandbox-kill-threshold"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Summarize local plugin runtime health from invocation evidence."""
    try:
        payload = diagnose_plugin_runtime(
            artifact_dir,
            slow_call_ms=slow_call_ms,
            failure_rate_threshold=failure_rate_threshold,
            failure_rate_min_invocations=failure_rate_min_invocations,
            sandbox_kill_threshold=sandbox_kill_threshold,
        )
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"ok={payload['ok']}")
    for key, value in payload["summary"].items():
        typer.echo(f"{key}={value}")
    for finding in payload["findings"]:
        typer.echo(
            f"{finding['code']} {finding['plugin_id']}@{finding['plugin_version']} "
            f"{finding['tool_name']} severity={finding['severity']}"
        )


@plugin_app.command("conformance")
def plugin_conformance(
    run: bool = typer.Option(False, "--run", help="Run the mapped conformance commands instead of dry-run listing them"),
    check_id: list[str] | None = typer.Option(None, "--check-id", help="Run or list only a specific conformance check id"),
    repo_root: Path = typer.Option(Path("."), "--repo-root", help="Repository root for running conformance commands"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List or run the Section 22 plugin conformance suite."""
    try:
        results = run_plugin_conformance(repo_root=repo_root, run=run, check_ids=check_id or [])
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = plugin_conformance_payload(results)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
    else:
        for row in payload["checks"]:
            typer.echo(f"{row['section']} {row['check_id']} status={row['status']} command={' '.join(row['command'])}")
    if not payload["ok"]:
        raise typer.Exit(1)


@plugin_app.command("release-checklist")
def plugin_release_checklist(
    run: bool = typer.Option(False, "--run", help="Run mapped conformance checks instead of dry-run listing them"),
    repo_root: Path = typer.Option(Path("."), "--repo-root", help="Repository root for running release checklist commands"),
    manual_evidence: Path | None = typer.Option(None, "--manual-evidence", help="JSON file with operator evidence for manual release gates"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List or run the Section 25 local plugin release checklist."""
    try:
        manual_evidence_by_id = (
            load_manual_release_evidence(manual_evidence, repo_root=repo_root) if manual_evidence is not None else None
        )
        results = run_plugin_release_checklist(repo_root=repo_root, run=run, manual_evidence=manual_evidence_by_id)
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = plugin_release_checklist_payload(results)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
    else:
        for row in payload["items"]:
            typer.echo(f"{row['section']} {row['item_id']} status={row['status']}")
    if not payload["ok"]:
        raise typer.Exit(1)


@plugin_app.command("workflow-gate")
def plugin_workflow_gate(
    repo_root: Path = typer.Option(Path("."), "--repo-root", help="Repository root for checking Section 27 workflow gates"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Check local Section 27 engineering workflow gates without mutating the repo."""
    try:
        results = run_plugin_workflow_gate(repo_root=repo_root)
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = plugin_workflow_gate_payload(results)
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
    else:
        for row in payload["gates"]:
            typer.echo(f"{row['gate_id']} status={row['status']}")
    if not payload["ok"]:
        raise typer.Exit(1)


@plugin_app.command("mcp-config")
def plugin_mcp_config(
    plugin_id: str = typer.Argument(..., help="Installed plugin id"),
    version: str | None = typer.Option(None, "--version", help="Plugin version; defaults to latest cached version"),
    server_name: str | None = typer.Option(None, "--server-name", help="Generated MCP server name"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Generate an agent-facing MCP config that points to the SuperClaw proxy."""
    tools = project_plugin_tools(plugin_id, version=version, cache_root=_plugin_cache_path())
    projected_tools = [{**tool, "name": projected_tool_name(plugin_id, str(tool["name"]))} for tool in tools]
    payload = {
        "plugin_id": plugin_id,
        "version": version,
        "tools": projected_tools,
        "mcp_config": build_mcp_config(plugin_id, version=version, server_name=server_name),
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(json.dumps(payload["mcp_config"], ensure_ascii=False))


@plugin_app.command("codex-view")
def plugin_codex_view(
    package_path: Path = typer.Argument(..., help="Plugin package directory or .scplug archive"),
    output_dir: Path = typer.Option(..., "--output-dir", help="Output directory for the derived Codex-compatible view"),
    force: bool = typer.Option(False, "--force", help="Replace an existing output directory"),
    python_executable: str | None = typer.Option(None, "--python-executable", help="Python executable used in generated .mcp.json"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Generate a Codex-compatible proxy view without exporting protected plugin source."""
    try:
        result = export_codex_compatible_view(
            package_path,
            output_dir=output_dir,
            force=force,
            python_executable=python_executable,
        )
    except (PluginCodexViewError, PluginVerificationError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "output_dir": str(result.output_dir),
        "written_files": [str(path) for path in result.written_files],
        "record": result.record,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key in ("plugin_id", "version", "output_dir"):
        typer.echo(f"{key}={payload[key]}")
    for path in result.written_files:
        typer.echo(f"written={path}")


@plugin_app.command("sync-skills")
def plugin_sync_skills(
    plugin_id: str | None = typer.Option(None, "--plugin-id", help="Sync only this plugin (default: all installed)"),
    target: list[str] = typer.Option([], "--target", help="Runtime target(s): codex, claude, gemini (default: all)"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key; defaults to SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
    entitlement_file: Path | None = typer.Option(None, "--entitlement-file", help="Plugin entitlement grants; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/entitlements.json"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Plugin revocation list; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/revocations.json"),
    policy_file: Path | None = typer.Option(None, "--policy-file", help="Plugin runtime policy; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/runtime-policy.json"),
    runtime_version: str = typer.Option(DEFAULT_RUNTIME_VERSION, "--runtime-version", help="Runtime version used for policy checks"),
    lock_path: Path | None = typer.Option(None, "--lock", help="Projection lock file; defaults under SUPERCLAW_HOME (or SUPERCLAW_PROJECTION_LOCK)"),
    force: bool = typer.Option(False, "--force", help="Overwrite files a user has hand-edited"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Project governed skills into native runtime skill directories (managed write).

    Only plugins that pass the fail-closed governance gate (signed, not revoked,
    entitled, policy-allowed) are projected, using the same gate inputs as
    execution. A full sync also reclaims projections for plugins since
    uninstalled (delete) or revoked (tombstone).
    """
    entitlement_file = entitlement_file or default_entitlement_file()
    revocation_file = revocation_file or default_revocation_file()
    policy_file = policy_file or default_policy_file()
    try:
        result = sync_plugin_skills(
            plugin_id=plugin_id,
            targets=tuple(target) or None,
            public_key=public_key,
            entitlement_file=entitlement_file,
            revocation_file=revocation_file,
            policy_file=policy_file,
            runtime_version=runtime_version,
            lock_path=lock_path,
            force=force,
        )
    except (SkillSyncError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, **result.to_dict()}, ensure_ascii=False))
        return
    for path in result.written:
        typer.echo(f"written={path}")
    for path in result.unchanged:
        typer.echo(f"unchanged={path}")
    for path in result.skipped_local_override:
        typer.echo(f"skipped-local-override={path}")


@plugin_app.command("unsync-skills")
def plugin_unsync_skills(
    plugin_id: str = typer.Argument(..., help="Plugin whose projected skills to reclaim"),
    lock_path: Path | None = typer.Option(None, "--lock", help="Projection lock file; defaults under SUPERCLAW_HOME (or SUPERCLAW_PROJECTION_LOCK)"),
    revoked: bool = typer.Option(False, "--revoked", help="Write a tombstone instead of deleting (for revocation)"),
    force: bool = typer.Option(False, "--force", help="Reclaim even files a user has hand-edited"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Reclaim a plugin's projected native skills on uninstall or revoke."""
    try:
        result = unsync_plugin_skills(
            plugin_id=plugin_id,
            lock_path=lock_path,
            revoked=revoked,
            force=force,
        )
    except (SkillSyncError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, **result.to_dict()}, ensure_ascii=False))
        return
    for path in result.removed:
        typer.echo(f"removed={path}")
    for path in result.tombstoned:
        typer.echo(f"tombstoned={path}")
    for path in result.skipped_local_override:
        typer.echo(f"skipped-local-override={path}")


@plugin_app.command("ingest-clawhunt")
def plugin_ingest_clawhunt(
    delivery_root: Path = typer.Argument(..., help="Accepted ClawHunt delivery directory"),
    manifest_path: Path = typer.Option(Path("delivery-manifest.json"), "--manifest", help="Delivery manifest path relative to delivery root"),
    output_root: Path = typer.Option(Path("dist/superclaw-plugins"), "--output-root", help="Output root for the staged plugin package"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Build an unsigned plugin package candidate from a reusable ClawHunt delivery."""
    try:
        result = ingest_clawhunt_delivery_plugin(
            delivery_root,
            manifest_path=manifest_path,
            output_root=output_root,
        )
    except ClawHuntPluginIngestionError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "package_root": str(result.package_root),
        "manifest_path": str(result.manifest_path),
        "metadata_path": str(result.metadata_path),
        "source_digest": result.source_digest,
        "package_digest": result.package_digest,
        "requires_signing": True,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("submit")
def plugin_submit(
    package_path: Path = typer.Argument(..., help="Developer-upload plugin package directory or .scplug archive"),
    submission_root: Path | None = typer.Option(None, "--submission-root", help="Local Phase 4A submission store"),
    smoke_timeout_seconds: float | None = typer.Option(None, "--smoke-timeout-seconds"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Run local developer-upload review gates and store an immutable submission.

    Submit NEVER signs (no signing key here, by design — closes the 'any key →
    verified' bypass). On a passing review the status is 'ready_for_signing'; sign
    it as a separate step with `superclaw plugin sign-submission`."""
    try:
        result = submit_developer_plugin_upload(
            package_path,
            submission_root=submission_root or _plugin_submission_path(),
            smoke_timeout_seconds=smoke_timeout_seconds,
        )
    except (DeveloperUploadReviewError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": result.ready_for_signing,
        "submission_id": result.submission_id,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "status": result.status,
        "ready_for_signing": result.ready_for_signing,
        "review_path": str(result.review_path),
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")
    if not result.ready_for_signing:
        raise typer.Exit(1)


@plugin_app.command("sign-submission")
def plugin_sign_submission(
    submission_id: str = typer.Argument(..., help="A submission that passed review (status ready_for_signing)"),
    signing_private_key: str | None = typer.Option(None, "--signing-private-key", help="Base64 Ed25519 official key; defaults to SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY"),
    submission_root: Path | None = typer.Option(None, "--submission-root"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Isolated post-review signing step: re-derive the digest from the stored blob
    and sign a reviewed submission. The ONLY place signing happens (kept apart from
    submit so submit can't mint a 'verified' artifact)."""
    from superclaw.plugin_submission import sign_reviewed_submission

    key = signing_private_key or os.environ.get("SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY")
    if not key:
        _fail("missing signing key: pass --signing-private-key or set SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY")
    root = submission_root or _plugin_submission_path()
    try:
        record = sign_reviewed_submission(submission_id, submission_root=root, signing_private_key=key)
    except (DeveloperUploadReviewError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": record.get("status") == "verified",
        "submission_id": submission_id,
        "status": record.get("status"),
        "signed_package_path": record.get("signed_package_path"),
        "signing_public_key": record.get("signing_public_key"),
    }
    typer.echo(json.dumps(payload, ensure_ascii=False) if json_output else "\n".join(f"{k}={v}" for k, v in payload.items()))


@plugin_app.command("submission-status")
def plugin_submission_status(
    submission_id: str = typer.Argument(..., help="Local developer-upload submission id"),
    submission_root: Path | None = typer.Option(None, "--submission-root", help="Local Phase 4A submission store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Read a local Phase 4A developer-upload review record."""
    try:
        record = get_developer_plugin_submission(
            submission_id,
            submission_root=submission_root or _plugin_submission_path(),
        )
    except DeveloperUploadReviewError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, "submission": record}, ensure_ascii=False))
        return
    for key in ("submission_id", "plugin_id", "version", "status", "ready_for_signing", "signed_package_path"):
        typer.echo(f"{key}={record.get(key)}")


@plugin_app.command("update-preflight")
def plugin_update_preflight(
    previous_package: Path = typer.Argument(..., help="Previous plugin package directory or .scplug archive"),
    candidate_package: Path = typer.Argument(..., help="Candidate plugin package directory or .scplug archive"),
    output_dir: Path | None = typer.Option(None, "--output-dir", help="Optional directory for plugin-update-preflight.json"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Compare two local plugin versions and report required update-review gates."""
    try:
        result = review_plugin_update(previous_package, candidate_package, output_dir=output_dir)
    except (PluginUpdateReviewError, PluginVerificationError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": result.status != "rejected",
        "plugin_id": result.plugin_id,
        "previous_version": result.previous_version,
        "candidate_version": result.candidate_version,
        "status": result.status,
        "automated_review_allowed": result.automated_review_allowed,
        "required_reviews": result.record["required_reviews"],
        "review_path": str(result.review_path) if result.review_path else None,
        "record": result.record,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key in ("plugin_id", "previous_version", "candidate_version", "status", "automated_review_allowed", "required_reviews", "review_path"):
        typer.echo(f"{key}={payload[key]}")
    if result.status == "rejected":
        raise typer.Exit(1)


@plugin_app.command("cloud-install")
def plugin_cloud_install(
    plugin_id: str = typer.Argument(..., help="Plugin id in the local fake-cloud registry"),
    version: str = typer.Argument(..., help="Plugin version in the local fake-cloud registry"),
    public_key: str | None = typer.Option(None, "--public-key", help="Base64 Ed25519 public key; defaults to SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root", help="Local Phase 5A fake-cloud root"),
    revocation_file: Path | None = typer.Option(None, "--revocation-file", help="Plugin revocation list; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins/revocations.json"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Install a plugin from local fake-cloud registry metadata."""
    revocation_file = revocation_file or default_revocation_file()
    try:
        result = install_plugin_from_cloud_metadata(
            _plugin_cloud_path() if cloud_root == DEFAULT_CLOUD_ROOT else cloud_root,
            plugin_id,
            version,
            public_key=public_key or os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY") or "",
            cache_root=_plugin_cache_path(),
            revocation_file=revocation_file,
        )
    except (PluginCloudSyncError, PluginVerificationError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "plugin_id": result.plugin_id,
        "version": result.version,
        "digest": result.digest,
        "installed": True,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("cloud-sync")
def plugin_cloud_sync(
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root", help="Local Phase 5A fake-cloud root"),
    local_state_root: Path | None = typer.Option(None, "--local-state-root", help="Local plugin governance state root; defaults to SUPERCLAW_PLUGIN_STATE_ROOT or ~/.superclaw/plugins (same dir the gate reads)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Sync fake-cloud entitlement, revocation, and runtime policy metadata locally."""
    try:
        result = sync_cloud_governance(
            _plugin_cloud_path() if cloud_root == DEFAULT_CLOUD_ROOT else cloud_root,
            local_state_root=local_state_root,
        )
    except PluginCloudSyncError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "entitlement_count": result.entitlement_count,
        "revocation_count": result.revocation_count,
        "policy_digest": result.policy_digest,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@plugin_app.command("evidence-upload-local")
def plugin_evidence_upload_local(
    evidence_path: Path = typer.Argument(..., help="EvidenceBundle JSON file to summarize for fake-cloud upload"),
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root", help="Local Phase 5A fake-cloud root"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Upload a cloud-safe evidence summary without raw command or workspace output."""
    try:
        result = upload_evidence_summary(evidence_path, cloud_root=_plugin_cloud_path() if cloud_root == DEFAULT_CLOUD_ROOT else cloud_root)
    except PluginCloudSyncError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": True,
        "upload_id": result.upload_id,
        "summary_path": str(result.summary_path),
        "summary_digest": result.summary_digest,
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")


@app.command()
def goal(
    title: str = typer.Option(..., "--title"),
    description: str = typer.Option(..., "--description"),
) -> None:
    """Create a goal without starting a run."""
    created = SuperClawOrchestrator.from_path(_state_path()).store.create_goal(GoalSpec(title=title, description=description))
    typer.echo(f"goal_id={created.goal_id}")


@app.command("models")
def models_command(
    backend: str = typer.Argument(..., help="Backend whose model catalog to list (e.g. opencode, grok, clawwork)"),
    json_output: bool = typer.Option(False, "--json"),
    refresh: bool = typer.Option(False, "--refresh", help="Bypass the 60s kernel catalog cache and re-probe now."),
) -> None:
    """List the REAL model catalog for a backend (live from the runtime when it
    exposes a listing channel; otherwise the static contract hints, honestly
    marked as such)."""
    _hydrate_cli_environment()
    from superclaw.model_discovery import discover_models

    catalog = discover_models(backend, backends=default_backends(), force_refresh=refresh)
    if json_output:
        # 与文本路径(3254)及 API 端点一致：error 字段也过 redact_secrets 再输出，
        # 避免未来探测错误若夹带凭据时经 --json 原样泄露（顾问 F-N1，一致性纵深）。
        payload = catalog.to_dict()
        if payload.get("error"):
            payload["error"] = redact_secrets(str(payload["error"]))
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"backend={catalog.backend} source={catalog.source}")
    if catalog.error:
        typer.echo(f"probe_error={redact_secrets(catalog.error)}")
    if catalog.default_model:
        typer.echo(f"default_model={catalog.default_model}")
    if not catalog.models:
        typer.echo("(no models reported)")
        return
    for model in catalog.models:
        typer.echo(f"  {model}")


@app.command("run")
def run_command(
    ctx: typer.Context,
    title: str = typer.Option(..., "--title"),
    description: str = typer.Option(..., "--description"),
    dry: bool = typer.Option(False, "--dry"),
    backend: str = typer.Option("claude", "--backend"),
    model: str | None = typer.Option(None, "--model", help="Per-run model override; defaults to the backend's SUPERCLAW_*_MODEL env / its own configured model."),
    effort: str | None = typer.Option(None, "--effort", help="Per-run reasoning-effort / thinking level (e.g. low/medium/high/xhigh/max). Honored only by effort-capable backends (codex / codex-app-server / claude / opencode); others fail closed on an explicit value."),
    agent_profile: str | None = typer.Option(None, "--agent-profile", help="Run as a team role: the profile's charter/equipment bind the run; its backend/model become the defaults."),
    repo: Path = typer.Option(Path("."), "--repo"),
    concurrency: int = typer.Option(1, "--concurrency"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    harness: str = typer.Option("codex", "--harness"),
    task_topology: TaskTopology = typer.Option(TaskTopology.LINEAR, "--task-topology"),
    permission_mode: str = typer.Option("default", "--permission-mode"),
    permission_preset: str | None = typer.Option(None, "--permission-preset", help="Two-state shell: 'ask' or 'allow'; overrides --permission-mode via the kernel contract."),
    allowed_tool: list[str] | None = typer.Option(None, "--allowed-tool"),
    disallowed_tool: list[str] | None = typer.Option(None, "--disallowed-tool"),
    mcp_config: list[str] | None = typer.Option(None, "--mcp-config"),
    plugin_dir: list[str] | None = typer.Option(None, "--plugin-dir"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Run a goal through the local harness."""
    _hydrate_cli_environment()
    artifact_dir = artifact_dir or default_artifact_dir()
    if permission_preset is not None and permission_preset not in PRESET_TO_MODE:
        raise typer.BadParameter("--permission-preset must be 'ask' or 'allow'")
    policy = _permission_policy(
        permission_mode=permission_mode,
        permission_preset=permission_preset,
        allowed_tool=allowed_tool,
        disallowed_tool=disallowed_tool,
        mcp_config=mcp_config,
        plugin_dir=plugin_dir,
    )
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    if agent_profile:
        # The role's backend is the default for a bound run; an explicit
        # --backend on the command line still wins (CLI parity with run_goal's
        # model precedence). Unknown profile ids fail closed.
        try:
            profile = orchestrator.store.get_agent_profile(agent_profile)
        except KeyError:
            _fail(f"unknown agent profile: {agent_profile}")
        backend_source = ctx.get_parameter_source("backend")
        if backend_source is None or backend_source.name == "DEFAULT":
            backend = profile.backend_policy
    result = orchestrator.run_goal(
        title=title,
        description=description,
        dry_run=dry,
        backend_policy=backend,
        model=model,
        effort=effort,
        agent_profile_id=agent_profile,
        repo_path=repo,
        concurrency=concurrency,
        budget_seconds=budget_seconds,
        artifact_dir=artifact_dir,
        harness_policy=harness,
        task_topology=task_topology,
        permission_policy=policy,
    )
    _print_run_summary(result, artifact_dir, json_output=json_output)
    if result.session.status not in {"completed", "WAITING_FOR_HUMAN_GATE"}:
        raise typer.Exit(1)


@app.command()
def chat(
    message: str | None = typer.Option(None, "--message", "-m"),
    session_id: str | None = typer.Option(None, "--session-id"),
    continue_last: bool = typer.Option(False, "--continue"),
    workspace: str | None = typer.Option(None, "--workspace", help="Workspace id this chat belongs to; defaults to the workspace the --repo resolves to (trust container, ADR workspace-trust-container)."),
    all_sessions: bool = typer.Option(False, "--all", help="With --continue: pick the most recent session across all workspaces instead of only the current one."),
    backend: str | None = typer.Option(None, "--backend", help="Backend for this turn; defaults to the chat's sticky runtime, then the configured shell default."),
    model: str | None = typer.Option(None, "--model", help="Model for this turn; sticky per chat. Pass an empty value to clear the chat's model selection."),
    effort: str | None = typer.Option(None, "--effort", help="Reasoning-effort / thinking level for this turn; sticky per chat. Honored by effort-capable backends only. Pass an empty value to clear the chat's effort selection."),
    repo: Path | None = typer.Option(None, "--repo", help="Execution directory for this chat. Default (omitted) = the managed Chat workspace, a private scratch the agent can't use to touch your real files. Pass a path, or --workspace <id>, to chat about a real repo (trust container, ADR workspace-trust-container)."),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    harness: str = typer.Option("codex", "--harness"),
    task_topology: TaskTopology = typer.Option(TaskTopology.LINEAR, "--task-topology"),
    dry: bool = typer.Option(False, "--dry"),
    permission_mode: str = typer.Option("default", "--permission-mode"),
    allowed_tool: list[str] | None = typer.Option(None, "--allowed-tool"),
    disallowed_tool: list[str] | None = typer.Option(None, "--disallowed-tool"),
    mcp_config: list[str] | None = typer.Option(None, "--mcp-config"),
    plugin_dir: list[str] | None = typer.Option(None, "--plugin-dir"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Create or continue a SuperClaw chat session and execute one delivery turn."""
    _hydrate_cli_environment()
    artifact_dir = artifact_dir or default_artifact_dir()
    if message is not None:
        content = message
    elif sys.stdin.isatty():
        content = typer.prompt("Goal")
    else:
        content = sys.stdin.read().strip()
    if not content:
        content = typer.prompt("Goal")
    summary = _execute_chat_turn(
        content=content,
        session_id=session_id,
        continue_last=continue_last,
        workspace_id=workspace,
        all_sessions=all_sessions,
        backend=backend,
        model=model,
        effort=effort,
        repo=repo,
        budget_seconds=budget_seconds,
        artifact_dir=artifact_dir,
        harness=harness,
        task_topology=task_topology,
        dry=dry,
        permission_mode=permission_mode,
        allowed_tool=allowed_tool,
        disallowed_tool=disallowed_tool,
        mcp_config=mcp_config,
        plugin_dir=plugin_dir,
    )
    if json_output:
        typer.echo(json.dumps(summary, ensure_ascii=False))
    else:
        typer.echo(f"session_id={summary['session_id']}")
        for key, value in summary.items():
            if key != "session_id":
                typer.echo(f"{key}={value}")
    if summary["status"] not in {"completed", "WAITING_FOR_HUMAN_GATE"}:
        raise typer.Exit(1)


@app.command("shell")
def interactive_shell(
    session_id: str | None = typer.Option(None, "--session-id"),
    continue_last: bool = typer.Option(False, "--continue"),
    backend: str | None = typer.Option(None, "--backend"),
    model: str | None = typer.Option(None, "--model", help="Model for this shell's turns; sticky per chat, cleared on /backend switch."),
    repo: Path = typer.Option(Path("."), "--repo"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    harness: str = typer.Option("codex", "--harness"),
    task_topology: TaskTopology = typer.Option(TaskTopology.LINEAR, "--task-topology"),
    dry: bool = typer.Option(False, "--dry"),
    permission_mode: str = typer.Option("default", "--permission-mode"),
    allowed_tool: list[str] | None = typer.Option(None, "--allowed-tool"),
    disallowed_tool: list[str] | None = typer.Option(None, "--disallowed-tool"),
    mcp_config: list[str] | None = typer.Option(None, "--mcp-config"),
    plugin_dir: list[str] | None = typer.Option(None, "--plugin-dir"),
) -> None:
    """Start a persistent SuperClaw chat shell without removing scriptable chat."""
    hydrate_runtime_environment()
    artifact_dir = artifact_dir or default_artifact_dir()
    current_session_id = session_id
    current_backend = backend or _configured_shell_backend() or "claude"
    current_model = (model or "").strip() or None
    # Two-state permission preset for native chat turns; passes through to the
    # runtime's own sandbox mapping (PRESET_TO_MODE). Default "ask".
    current_permission_preset = "ask"
    resume_session_id = session_id
    if not resume_session_id and continue_last:
        try:
            sessions = SuperClawOrchestrator.from_path(_state_path()).store.list_chat_sessions()
            resume_session_id = sessions[0].session_id if sessions else None
        except Exception:
            resume_session_id = None
    if resume_session_id:
        # Resuming a known chat: adopt its sticky runtime unless this invocation
        # explicitly chose one (the chat "remembers" its backend/model). The shell
        # state then IS the per-turn request — what the toolbar shows is what runs.
        try:
            sticky = SuperClawOrchestrator.from_path(_state_path()).store.get_chat_runtime(resume_session_id)
        except Exception:
            sticky = None
        if sticky:
            if not backend and sticky.get("backend"):
                current_backend = str(sticky["backend"])
            if model is None and sticky.get("model"):
                current_model = str(sticky["model"])
    current_mode = _configured_shell_mode() or "auto"
    current_repo = repo.expanduser() if repo != Path(".") else Path(_configured_shell_repo() or ".").expanduser()
    current_continue = continue_last
    last_run_id: str | None = None
    scripted = not sys.stdin.isatty()
    full_ui = not scripted and sys.stdout.isatty()
    use_color = full_ui and _terminal_color_enabled()
    prompt_session = _build_shell_prompt_session() if full_ui else None

    _print_shell_home(
        session_id=current_session_id,
        backend=current_backend,
        mode=current_mode,
        repo=current_repo,
        last_run_id=last_run_id,
        full=full_ui,
        use_color=use_color,
    )
    while True:
        try:
            if scripted:
                raw = sys.stdin.readline()
                if raw == "":
                    break
                content = raw.strip()
            elif prompt_session is not None:
                content = prompt_session.prompt(
                    _shell_prompt_message(),
                    bottom_toolbar=lambda: _shell_bottom_toolbar(
                        session_id=current_session_id,
                        backend=current_backend,
                        mode=current_mode,
                        repo=current_repo,
                        last_run_id=last_run_id,
                        model=current_model,
                    ),
                ).strip()
            else:
                content = input(_shell_prompt(use_color=use_color)).strip()
        except (EOFError, KeyboardInterrupt):
            typer.echo()
            break
        if not content:
            continue
        if content in {"/exit", "/quit", "exit", "quit"}:
            break
        if content == "/help":
            typer.echo(_shell_help_text())
            continue
        if content == "/setup" or content.startswith("/setup "):
            requested_backend = content.split(None, 1)[1].strip().lower() if content.startswith("/setup ") else current_backend
            if requested_backend and requested_backend not in default_backends():
                typer.echo(f"setup_error=unsupported backend: {requested_backend}")
                continue
            try:
                setup_result = _shell_setup_apply(
                    prompt_session,
                    current_backend=requested_backend or current_backend,
                    current_mode=current_mode,
                    current_repo=current_repo,
                )
            except ValueError as exc:
                typer.echo(f"setup_error={exc}")
                continue
            current_backend = str(setup_result["backend"])
            current_mode = str(setup_result["mode"])
            current_repo = Path(setup_result["repo"])
            typer.echo("setup_complete=true")
            typer.echo(f"backend={current_backend}")
            typer.echo(f"backend_default={_configured_shell_backend() or current_backend}")
            typer.echo(f"mode={current_mode}")
            typer.echo(f"mode_default={_configured_shell_mode() or current_mode}")
            typer.echo(f"repo={current_repo}")
            configured = ",".join(dict.fromkeys(setup_result["configured"])) if setup_result["configured"] else "(none)"
            typer.echo(f"configured={configured}")
            skipped = ",".join(dict.fromkeys(setup_result["skipped_secrets"])) if setup_result["skipped_secrets"] else "(none)"
            typer.echo(f"skipped_secrets={skipped}")
            continue
        if content == "/status":
            for line in _shell_status_lines(
                session_id=current_session_id,
                backend=current_backend,
                mode=current_mode,
                repo=current_repo,
                last_run_id=last_run_id,
            ):
                typer.echo(line)
            continue
        if content == "/session":
            _print_shell_dashboard(
                session_id=current_session_id,
                backend=current_backend,
                mode=current_mode,
                repo=current_repo,
                last_run_id=last_run_id,
                full=False,
                use_color=False,
            )
            continue
        if content == "/last":
            typer.echo(f"last_run_id={last_run_id or '(none)'}")
            continue
        if content == "/config":
            _print_shell_dashboard(
                session_id=current_session_id,
                backend=current_backend,
                mode=current_mode,
                repo=current_repo,
                last_run_id=last_run_id,
                full=False,
                use_color=False,
            )
            continue
        if content == "/agents":
            for line in _agent_status_lines(selected_backend=current_backend, include_all=True):
                typer.echo(line)
            continue
        if content.startswith("/config set "):
            parts = content.split(None, 3)
            if len(parts) < 4:
                typer.echo("usage: /config set NAME VALUE")
                continue
            try:
                configured_name = _set_shell_config(parts[2], parts[3])
            except ValueError as exc:
                typer.echo(f"config_error={exc}")
                continue
            typer.echo(f"{configured_name}=set")
            continue
        if content.startswith("/login "):
            key = content.split(None, 1)[1].strip()
            if not key:
                typer.echo("usage: /login CLAWHUNT_AGENT_KEY")
                continue
            save_clawhunt_auth(
                {
                    "agent_api_key": key,
                    "agent_key_source": "manual",
                    "agent_key_name": "Manual agent key",
                }
            )
            typer.echo("CLAWHUNT_AGENT_API_KEY=set")
            continue
        if content == "/logout":
            clear_clawhunt_auth()
            typer.echo("CLAWHUNT_AGENT_API_KEY=unset")
            continue
        if content == "/me":
            typer.echo(json.dumps(ClawHuntClient().me(), ensure_ascii=False))
            continue
        if content == "/plugins":
            typer.echo(json.dumps({"plugins": list_cached_plugins(cache_root=_plugin_cache_path())}, ensure_ascii=False))
            continue
        if content == "/run":
            typer.echo("usage: /run RUN_ID")
            continue
        if content == "/runs":
            for line in _shell_runs_lines():
                typer.echo(line)
            continue
        if content.startswith("/run "):
            requested_run_id = content.split(None, 1)[1].strip()
            if not requested_run_id:
                typer.echo("usage: /run RUN_ID")
                continue
            try:
                for line in _shell_run_lines(requested_run_id):
                    typer.echo(line)
            except KeyError:
                typer.echo(f"run_not_found={requested_run_id}")
            continue
        if content == "/evidence":
            typer.echo("usage: /evidence RUN_ID")
            continue
        if content.startswith("/evidence "):
            requested_run_id = content.split(None, 1)[1].strip()
            if not requested_run_id:
                typer.echo("usage: /evidence RUN_ID")
                continue
            try:
                for line in _shell_evidence_lines(requested_run_id):
                    typer.echo(line)
            except KeyError:
                typer.echo(f"evidence_not_found={requested_run_id}")
            continue
        if content == "/plugins doctor":
            for line in _shell_plugin_doctor_lines(artifact_dir=artifact_dir):
                typer.echo(line)
            continue
        if content.startswith("/backend "):
            requested_backend = content.split(None, 1)[1].strip()
            try:
                _save_shell_config_value("backend", requested_backend)
            except ValueError as exc:
                typer.echo(f"config_error={exc}")
                continue
            if requested_backend != current_backend and current_model:
                # Model ids are not portable across runtimes (kernel rule); an
                # explicit /model after the switch re-selects one.
                current_model = None
                typer.echo("model=(cleared: backend switched)")
            current_backend = requested_backend
            typer.echo(f"backend={current_backend}")
            typer.echo(f"backend_default={current_backend}")
            continue
        if content == "/model" or content.startswith("/model "):
            argument = content.split(None, 1)[1].strip() if content.startswith("/model ") else ""
            if not argument:
                typer.echo(f"model={current_model or '(backend default)'}")
                continue
            if argument.lower() in {"clear", "default", "none"}:
                current_model = None
                typer.echo("model=(backend default)")
                continue
            current_model = argument
            typer.echo(f"model={current_model}")
            typer.echo(f"model_backend={current_backend}")
            continue
        if content == "/models" or content.startswith("/models "):
            target_backend = content.split(None, 1)[1].strip() if content.startswith("/models ") else current_backend
            from superclaw.model_discovery import discover_models

            catalog = discover_models(target_backend, backends=default_backends())
            typer.echo(f"backend={catalog.backend} source={catalog.source}")
            if catalog.error:
                typer.echo(f"probe_error={redact_secrets(catalog.error)}")
            for model_name in catalog.models:
                typer.echo(f"  {model_name}")
            if not catalog.models:
                typer.echo("(no models reported)")
            continue
        if content == "/permission" or content.startswith("/permission "):
            argument = content.split(None, 1)[1].strip().lower() if content.startswith("/permission ") else ""
            if not argument:
                typer.echo(f"permission={current_permission_preset} (mode={PRESET_TO_MODE[current_permission_preset]})")
                continue
            if argument not in PRESET_TO_MODE:
                typer.echo("usage: /permission [ask|allow]")
                continue
            current_permission_preset = argument
            typer.echo(f"permission={current_permission_preset} (mode={PRESET_TO_MODE[current_permission_preset]})")
            continue
        if content.startswith("/mode "):
            requested_mode = content.split(None, 1)[1].strip().lower()
            if requested_mode not in _SHELL_MODES:
                typer.echo("usage: /mode auto|chat|delivery")
                continue
            current_mode = requested_mode
            try:
                _save_shell_config_value("mode", current_mode)
            except ValueError as exc:
                typer.echo(f"config_error={exc}")
                continue
            typer.echo(f"mode={current_mode}")
            typer.echo(f"mode_default={current_mode}")
            continue
        if content.startswith("/repo "):
            current_repo = Path(content.split(None, 1)[1].strip()).expanduser()
            typer.echo(f"repo={current_repo}")
            continue

        forced_intent: str | None = None
        if content.startswith("/ask "):
            content = content.split(None, 1)[1].strip()
            forced_intent = "chat"
        elif content.startswith("/deliver "):
            content = content.split(None, 1)[1].strip()
            forced_intent = "delivery"
        if forced_intent and not content:
            typer.echo("usage: /ask MESSAGE" if forced_intent == "chat" else "usage: /deliver TASK")
            continue
        if content.startswith("/"):
            typer.echo(f"unknown command: {content}")
            continue
        try:
            intent = forced_intent or _classify_shell_intent(content, mode=current_mode)
        except ValueError as exc:
            typer.echo(f"turn_error={exc}")
            typer.echo("shell_status=ready")
            continue

        if intent == "chat":
            # T11 fail-closed: a low-trust workspace permits ONLY governed,
            # contained execution. An interactive shell chat turn runs the runtime
            # directly (uncontained), so refuse it in a low-trust workspace — run
            # the work as a governed `superclaw run` or lift the containment_preset.
            try:
                from superclaw import workspace_resolver as _wsr
                from superclaw.containment import resolve_for_workspace as _rfw

                _store = _team_store()
                _matched_ws = _wsr.find_workspace_for_path(_store, str(current_repo))
                # A repo that is not a registered workspace is standard (allow); a
                # matched workspace derives its company floor via resolve_for_workspace.
                _is_low_trust = _matched_ws is not None and _rfw(
                    _store, _matched_ws.workspace_id
                ).is_low_trust
            except Exception:
                # Cannot verify the repo's trust state — fail-closed: refuse the
                # uncontained chat turn rather than silently allow it.
                _is_low_trust = True
            if _is_low_trust:
                typer.echo(
                    "turn_error=containment 'low_trust_review': this workspace is fenced for "
                    "untrusted review; chat turns run uncontained — run a governed `superclaw run` "
                    "or lift the workspace containment_preset"
                )
                typer.echo("shell_status=ready")
                continue
            # Execution choke point (parity with the API _guard / orchestrator gate):
            # the interactive shell's direct chat bypasses run_goal, so re-verify a
            # real-folder project's pinned inode HERE before _execute_direct_chat_turn —
            # a deleted/swapped project dir is refused fail-closed, never re-created.
            try:
                _wsr.assert_execution_repo_safe(_store, current_repo)
                _chat_protected = _wsr.is_protected_project_repo(_store, current_repo)
            except _wsr.WorkspaceDirCompromised as _exc:
                typer.echo(f"turn_error={_exc}")
                typer.echo("shell_status=ready")
                continue
            if scripted:
                typer.echo(_shell_turn_start_line(intent="chat", mode=current_mode, backend=current_backend, repo=current_repo))
            _chat_turn_started = time.monotonic()
            try:
                with _ShellWorkingIndicator(enabled=full_ui, intent="chat", backend=current_backend, repo=current_repo):
                    chat_summary = _execute_direct_chat_turn(
                        content=content,
                        backend=current_backend,
                        repo=current_repo,
                        budget_seconds=budget_seconds,
                        model=current_model,
                        permission_mode=PRESET_TO_MODE[current_permission_preset],
                        protected_cwd=_chat_protected,
                    )
            except Exception as exc:
                typer.echo(f"turn_error={redact_secrets(type(exc).__name__ + ': ' + str(exc))}")
                typer.echo("shell_status=ready")
                continue
            _chat_turn_elapsed_ms = (time.monotonic() - _chat_turn_started) * 1000
            typer.echo(f"intent=chat backend={current_backend} status={chat_summary['status']}")
            if chat_summary["status"] == "completed":
                response = str(chat_summary.get("response") or "").strip()
                if response:
                    typer.echo(response)
                # CLI parity of the web chat metering row: token usage + elapsed.
                meter_line = _shell_turn_meter_line(chat_summary.get("usage"), _chat_turn_elapsed_ms)
                if meter_line:
                    typer.echo(meter_line)
                if scripted:
                    typer.echo(_shell_turn_done_line(status="completed"))
            else:
                typer.echo(f"failure_reason={chat_summary.get('failure_reason', 'direct chat failed')}")
                if scripted:
                    typer.echo(_shell_turn_done_line(status="failed"))
            continue

        if scripted:
            typer.echo(_shell_turn_start_line(intent="delivery", mode=current_mode, backend=current_backend, repo=current_repo))
        try:
            with _ShellWorkingIndicator(enabled=full_ui, intent="delivery", backend=current_backend, repo=current_repo):
                summary = _execute_chat_turn(
                    content=content,
                    session_id=current_session_id,
                    continue_last=current_continue,
                    backend=current_backend,
                    # The shell's visible state is the explicit per-turn request:
                    # "" clears a sticky model the user dropped via /model clear.
                    model=current_model or "",
                    repo=current_repo,
                    budget_seconds=budget_seconds,
                    artifact_dir=artifact_dir,
                    harness=harness,
                    task_topology=task_topology,
                    dry=dry,
                    permission_mode=permission_mode,
                    allowed_tool=allowed_tool,
                    disallowed_tool=disallowed_tool,
                    mcp_config=mcp_config,
                    plugin_dir=plugin_dir,
                )
        except Exception as exc:
            typer.echo(f"turn_error={redact_secrets(type(exc).__name__ + ': ' + str(exc))}")
            typer.echo("shell_status=ready")
            continue
        current_session_id = str(summary["session_id"])
        current_continue = False
        last_run_id = str(summary["run_id"])
        typer.echo("intent=delivery")
        typer.echo(
            f"run_id={summary['run_id']} status={summary['status']} "
            f"chain_verdict={summary['chain_verdict']}"
        )
        if summary["status"] not in {"completed", "WAITING_FOR_HUMAN_GATE"}:
            if summary.get("failure_reason"):
                typer.echo(f"failure_reason={summary['failure_reason']}")
            if scripted:
                typer.echo(_shell_turn_done_line(status="failed"))
            continue
        turn_status = "waiting_for_human_gate" if summary["status"] == "WAITING_FOR_HUMAN_GATE" else "completed"
        if scripted:
            typer.echo(_shell_turn_done_line(status=turn_status))


@app.command()
def validate(
    backends: str = typer.Option("local,codex,claude,hermes,bobo,gemini,openclaw", "--backends"),
    repo: Path = typer.Option(Path("."), "--repo"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    fail_under: float = typer.Option(1.0, "--fail-under"),
    live_probe: bool = typer.Option(False, "--live-probe"),
) -> None:
    """Run a real backend validation matrix and print a success-rate report."""
    artifact_dir = artifact_dir or default_artifact_dir()
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    selected = [item.strip() for item in backends.split(",") if item.strip()]
    rows: list[dict[str, Any]] = []
    for backend in selected:
        started = time.monotonic()
        try:
            result = orchestrator.run_goal(
                title=f"SuperClaw validation {backend}",
                description=f"Run real {backend} backend validation.",
                dry_run=False,
                backend_policy=backend,
                repo_path=repo,
                budget_seconds=budget_seconds,
                artifact_dir=artifact_dir / backend,
                harness_policy="codex",
            )
            success = result.session.status == "completed" and result.evidence.chain_verdict.value in {
                "CHAIN_PARTIAL",
                "E2E_PROVEN",
            }
            rows.append(
                {
                    "backend": backend,
                    "success": success,
                    "run_id": result.session.run_id,
                    "status": result.session.status,
                    "chain_verdict": result.evidence.chain_verdict.value,
                    "duration_seconds": round(time.monotonic() - started, 3),
                    "evidence_path": str((artifact_dir / backend / result.session.run_id / "evidence.json").resolve()),
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "backend": backend,
                    "success": False,
                    "run_id": None,
                    "status": "error",
                    "chain_verdict": "FAIL",
                    "duration_seconds": round(time.monotonic() - started, 3),
                    "error": f"{type(exc).__name__}: {str(exc)[:400]}",
                }
            )
    total = len(rows)
    successes = len([row for row in rows if row["success"]])
    report: dict[str, Any] = {
        "total": total,
        "success": successes,
        "success_rate": round(successes / total, 4) if total else 0,
        "rows": rows,
    }
    if live_probe:
        report["live_probe"] = ClawHuntClient().live_read_only_probe()
    typer.echo(json.dumps(report, ensure_ascii=False, indent=2))
    if report["success_rate"] < fail_under:
        raise typer.Exit(1)


@app.command()
def verify(run_id: str, json_output: bool = typer.Option(False, "--json")) -> None:
    """Run adversarial verification and print the stored evidence verdict."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    bundle = orchestrator.store.get_evidence(run_id)
    findings = apply_adversarial_profile(bundle)
    orchestrator.store.save_evidence(bundle)
    if json_output:
        typer.echo(
            json.dumps(
                {
                    "run_id": run_id,
                    "findings": [finding.__dict__ for finding in findings],
                    "rule_specs": {name: spec.__dict__ for name, spec in adversarial_rule_specs().items()},
                    "chain_verdict": bundle.chain_verdict.value,
                },
                ensure_ascii=False,
            )
        )
        return
    for finding in findings:
        typer.echo(f"{finding.name}={'PASS' if finding.passed else 'FAIL'}")
    typer.echo(f"chain_verdict={bundle.chain_verdict.value}")


@app.command()
def fanout(
    run_id: str,
    task_id: str = typer.Option(None, "--task"),
    branches: int = typer.Option(2, "--branches", min=1),
    title: str = typer.Option("Subagent branch", "--title"),
    description: str = typer.Option(..., "--description"),
    aggregation: ChildAggregationPolicy = typer.Option(ChildAggregationPolicy.ALL_SUCCEED, "--aggregation"),
    max_concurrency: int = typer.Option(4, "--max-concurrency", min=1),
    quorum: int = typer.Option(None, "--quorum"),
    backend: str = typer.Option(None, "--backend"),
    dry: bool = typer.Option(False, "--dry"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Fan a parent task out into N parallel subagents and aggregate the result."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        session = orchestrator.store.get_run(run_id)
    except KeyError:
        typer.echo(f"error: run not found: {run_id}")
        raise typer.Exit(1)
    resolved_task = task_id or (
        session.task_graph.tasks[0].task_id if session.task_graph and session.task_graph.tasks else None
    )
    if not resolved_task:
        typer.echo("error: run has no task to fan out")
        raise typer.Exit(1)
    children = [
        {"title": f"{title} {index + 1}", "description": description, "backend_policy": backend, "dry_run": dry}
        for index in range(branches)
    ]
    try:
        result = orchestrator.spawn_child_runs(
            parent_run_id=run_id,
            parent_task_id=resolved_task,
            children=children,
            aggregation=aggregation,
            max_concurrency=max_concurrency,
            quorum=quorum,
        )
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    summary = {
        "parent_run_id": result.parent_run_id,
        "parent_task_id": result.parent_task_id,
        "policy": result.policy,
        "succeeded": result.succeeded,
        "total": result.total,
        "completed": result.completed,
        "failed": result.failed,
        "children": result.children,
    }
    if json_output:
        typer.echo(json.dumps(summary, ensure_ascii=False))
    else:
        for key in ("parent_run_id", "policy", "succeeded", "total", "completed", "failed"):
            typer.echo(f"{key}={summary[key]}")
    if not result.succeeded:
        raise typer.Exit(1)


@app.command()
def onboarding(
    reset: bool = typer.Option(False, "--reset", help="Clear the saved state so the web tour shows again."),
    complete: int | None = typer.Option(
        None, "--complete", help="Mark the web tour completed for the given content version."
    ),
) -> None:
    """Inspect or manage the web onboarding-tour state (kernel shell config).

    Mirrors the ``/api/onboarding`` surface so the CLI and clients agree on the
    single source of truth. With no flags it prints the current state as JSON.
    """
    if reset and complete is not None:
        raise typer.BadParameter("use either --reset or --complete, not both")
    if reset:
        state = reset_onboarding_state()
    elif complete is not None:
        if complete < 0:
            raise typer.BadParameter("--complete version must be a non-negative integer")
        state = set_onboarding_completed(complete)
    else:
        state = load_onboarding_state()
    typer.echo(json.dumps(state, ensure_ascii=False, indent=2))


@app.command()
def evidence(run_id: str) -> None:
    """Print a normalized evidence bundle as JSON."""
    bundle = SuperClawOrchestrator.from_path(_state_path()).store.get_evidence(run_id)
    typer.echo(json.dumps(bundle.to_dict(), ensure_ascii=False, indent=2))


@app.command()
def events(run_id: str) -> None:
    """Print run events as JSON lines."""
    for event in SuperClawOrchestrator.from_path(_state_path()).store.list_events(run_id):
        typer.echo(json.dumps(event, ensure_ascii=False))


@app.command()
def cancel(run_id: str) -> None:
    """Request cancellation for a queued or running run."""
    result = SuperClawOrchestrator.from_path(_state_path()).cancel_run(run_id)
    typer.echo(f"run_id={result.run_id}")
    typer.echo(f"status={result.status}")
    typer.echo(f"previous_status={result.previous_status}")
    typer.echo(f"accepted={str(result.accepted).lower()}")
    typer.echo(f"event_type={result.event_type}")
    typer.echo(f"detail={result.detail}")


@app.command()
def reconcile(
    run_id: str | None = typer.Argument(None),
    all_stale: bool = typer.Option(False, "--all", help="Reconcile every stale executing run instead of a single one."),
) -> None:
    """Reconcile a stale run into a resumable or failed-closed terminal state."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    if all_stale or run_id is None:
        results = orchestrator.reconcile_stale_runs()
        typer.echo(f"reconciled={len(results)}")
        for result in results:
            typer.echo(
                f"run_id={result.run_id} previous_status={result.previous_status} "
                f"status={result.status} classification={result.classification} detail={result.detail}"
            )
        return
    result = orchestrator.reconcile_run(run_id)
    typer.echo(f"run_id={result.run_id}")
    typer.echo(f"previous_status={result.previous_status}")
    typer.echo(f"status={result.status}")
    typer.echo(f"classification={result.classification}")
    typer.echo(f"resumable={str(result.resumable).lower()}")
    typer.echo(f"detail={result.detail}")


@app.command()
def watch(
    run_id: str,
    interval: float = typer.Option(0.2, "--interval"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Follow a run's structured events until it reaches a terminal STATUS.

    Reads the snapshot stream (structured events, no raw stdout/delta flood) and
    terminates on the run's STATUS — not on a terminal ``run.*`` event, which
    safe-write (DL8) may drop — so ``watch`` can never hang waiting for an event
    that was never written.
    """
    store = SuperClawOrchestrator.from_path(_state_path()).store
    terminal = {"completed", "failed", "cancelled", "WAITING_FOR_HUMAN_GATE"}
    terminal_events = {"run.completed", "run.failed", "run.cancelled", "run.paused"}

    def _echo(event: dict) -> None:
        if json_output:
            typer.echo(json.dumps(event, ensure_ascii=False))
        else:
            typer.echo(f"{event['type']} {json.dumps(event['payload'], ensure_ascii=False)}")

    emitted = 0
    saw_terminal_event = False
    while True:
        events = store.list_events_snapshot(run_id)
        for event in events[emitted:]:
            if event["type"] in terminal_events:
                saw_terminal_event = True
            _echo(event)
        emitted = len(events)
        try:
            status = store.get_run(run_id).status
        except KeyError:
            break
        if status in terminal:
            # If the terminal event already printed (in the main loop), stop now.
            # Otherwise the run flow commits terminal STATUS before the trailing
            # run.* event, so poll a BOUNDED number of times for it (breaking early
            # once it arrives) — a fast run's tail event is not missed, while a
            # genuinely dropped event (safe-write) still stops watch within the bound.
            if not saw_terminal_event:
                for _ in range(20):
                    events = store.list_events_snapshot(run_id)
                    for event in events[emitted:]:
                        if event["type"] in terminal_events:
                            saw_terminal_event = True
                        _echo(event)
                    emitted = len(events)
                    if saw_terminal_event:
                        break
                    time.sleep(0.05)
                else:
                    # Loop exhausted without the terminal event: ONE final read so
                    # an event committed during the last sleep is still printed
                    # (no last-window blind spot) before stopping.
                    events = store.list_events_snapshot(run_id)
                    for event in events[emitted:]:
                        _echo(event)
                    emitted = len(events)
            break
        time.sleep(interval)


# --- Agent Team Kernel commands -------------------------------------------
#
# These expose the team kernel on the CLI (the single source of truth). Every
# surface — API / Web / Desktop — must drive the same operations through this
# command face; none may invent organization semantics the CLI does not have.


def _team_store() -> StateStore:
    return SuperClawOrchestrator.from_path(_state_path()).store


def _emit_json(payload: Any) -> None:
    typer.echo(json.dumps(payload, ensure_ascii=False, indent=2))


def _fail(message: str) -> None:
    typer.echo(f"error: {message}")
    raise typer.Exit(1)


def _board_inbox_interaction_or_exit(store: StateStore, interaction_id: str):
    # Bounded PK lookup (replaces the old O(n) scan). The ESCALATE_TO_BOARD gate +
    # the actual resolve/assign mutation live in the team_kernel.*_board_inbox_item
    # functions (the single source chat/REST also drive) — this helper only renders
    # the CLI's 404 / already-resolved presentation around them.
    try:
        interaction = store.get_issue_interaction(interaction_id)
    except KeyError:
        _fail(f"unknown board inbox item: {interaction_id}")
    if interaction.continuation_policy != ContinuationPolicy.ESCALATE_TO_BOARD.value:
        _fail("interaction is not a board inbox item")
    return interaction


def _team_routine_author_payload(store: StateStore, spec: dict[str, Any]) -> dict[str, Any]:
    companies = store.list_company_profiles()
    workspaces = store.list_workspace_profiles()
    agents = store.list_agent_profiles()
    result = author_routine(
        spec,
        known_companies=[company.company_profile_id for company in companies],
        known_workspaces=[workspace.workspace_id for workspace in workspaces],
        known_agents=[agent.profile_id for agent in agents],
        agent_company_map={agent.profile_id: agent.company_profile_id for agent in agents},
        workspace_company_map={
            workspace.workspace_id: workspace.company_profile_id for workspace in workspaces
        },
    )
    payload: dict[str, Any] = {
        "authoring": result.to_dict(),
        "scheduled": False,
        "created": False,
        "schedule": None,
    }
    if result.status == "ready" and result.proposal is not None and result.proposal.enabled:
        try:
            schedule, existing = store.save_team_routine_schedule(result.to_team_routine_schedule())
        except ValueError as exc:
            _fail(str(exc))
        payload.update({"scheduled": True, "created": not existing, "schedule": schedule.to_dict()})
    return payload


def _load_json_object_or_exit(*, spec_json: str | None, spec_file: Path | None) -> dict[str, Any]:
    if spec_json and spec_file is not None:
        _fail("specify exactly one of --spec-json or --spec-file")
    if not spec_json and spec_file is None:
        _fail("specify --spec-json or --spec-file")
    try:
        raw = spec_file.read_text(encoding="utf-8") if spec_file is not None else str(spec_json)
        data = json.loads(raw)
    except OSError as exc:
        _fail(str(exc))
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON: {exc}")
    if not isinstance(data, dict):
        _fail("routine spec must be a JSON object")
    return data


def _build_team_bootstrap_proposal_or_exit(
    template_source: str,
    *,
    mode: str,
    proposal_id: str,
    available_plugin: list[str],
    available_skill: list[str],
    runtime_budget_seconds: int,
    runtime_token_budget: int,
    allow_local_opt_in: bool = False,
) -> dict[str, Any]:
    if mode != "proposal":
        _fail("team catalog inspect only supports preview/proposal mode")
    from superclaw.team_templates import TeamTemplateError, build_bootstrap_proposal

    try:
        proposal = build_bootstrap_proposal(
            template_source,
            available_plugin_ids=list(available_plugin) if available_plugin else None,
            available_skill_ids=list(available_skill) if available_skill else None,
            runtime_budget_seconds=runtime_budget_seconds,
            runtime_token_budget=runtime_token_budget,
            proposal_id=proposal_id,
            allow_local_opt_in=allow_local_opt_in,
        )
    except TeamTemplateError as exc:
        _fail(str(exc))
    return proposal.to_dict()


def _team_bootstrap_commit_or_exit(
    template_source: str,
    *,
    proposal_id: str,
    available_plugin: list[str],
    available_skill: list[str],
    runtime_budget_seconds: int,
    runtime_token_budget: int,
    requested_by: str,
    allow_local_opt_in: bool = False,
) -> dict[str, Any]:
    from superclaw.team_bootstrap import BootstrapCommitError, commit_bootstrap_proposal
    from superclaw.team_templates import TeamTemplateError, build_bootstrap_proposal

    try:
        proposal = build_bootstrap_proposal(
            template_source,
            available_plugin_ids=list(available_plugin) if available_plugin else None,
            available_skill_ids=list(available_skill) if available_skill else None,
            runtime_budget_seconds=runtime_budget_seconds,
            runtime_token_budget=runtime_token_budget,
            proposal_id=proposal_id,
            allow_local_opt_in=allow_local_opt_in,
        )
        return commit_bootstrap_proposal(
            _team_store(),
            proposal,
            requested_by=requested_by,
            allow_local_opt_in=allow_local_opt_in,
        )
    except TeamTemplateError as exc:
        _fail(str(exc))
    except BootstrapCommitError as exc:
        _fail(str(exc))


def _resolve_company_local_opt_in(trust: str | None) -> bool:
    """Map the ``--trust`` flag (and the local-dev env) to allow_local_opt_in.

    Only an explicit ``--trust local`` or ``SUPERCLAW_COMPANY_LOCAL_DEV_TRUST=1``
    admits a ``local`` company template; absent that, an unsigned/local company
    fails closed (design §3.6). Reserved namespace ALWAYS hard-fails regardless.
    """
    if trust is not None:
        if trust != "local":
            _fail("team bootstrap --trust currently supports only 'local'")
        return True
    from superclaw.company_template import company_local_dev_trust_enabled

    return company_local_dev_trust_enabled()


def _resolve_company_catalog_source_or_exit(ref: str, *, companies_root: Path | None) -> str:
    """Resolve a ``--from-catalog`` reference (``id`` or ``id@version``) to its local
    company source path via the catalog resolver. The path is then routed through the
    SAME verify-before-instantiate gate as ``--from-template`` (no trust shortcut)."""
    from superclaw.catalog_resolver import default_companies_root, resolve_company_source_path

    plugin_id, _, version = ref.partition("@")
    plugin_id = plugin_id.strip()
    version = version.strip()
    if not plugin_id:
        _fail("team bootstrap --from-catalog requires a company id (optionally id@version)")
    if not version:
        # Resolve the (single) version present locally; ambiguity is rejected fail-closed.
        root = companies_root or default_companies_root()
        versions = _local_company_versions(root, plugin_id)
        if not versions:
            _fail(f"no local company source matches {plugin_id!r}")
        if len(versions) > 1:
            _fail(f"company {plugin_id!r} has multiple local versions {sorted(versions)}; specify id@version")
        version = versions[0]
    from superclaw.company_template import CompanyTemplateError

    try:
        return str(resolve_company_source_path(plugin_id, version, companies_root=companies_root))
    except FileNotFoundError as exc:
        _fail(str(exc))  # no local source
    except CompanyTemplateError as exc:
        _fail(str(exc))  # ambiguous duplicate id@version (fail-closed)


def _local_company_versions(root: Path, plugin_id: str) -> list[str]:
    from superclaw.company_template import CompanyTemplateError, load_company_template

    if not root.exists():
        return []
    versions: list[str] = []
    for manifest_path in sorted(root.glob("*/superclaw-company.json")):
        template = None
        try:
            template = load_company_template(manifest_path.parent)
            if template.artifact_id == plugin_id:
                versions.append(template.version)
        except (CompanyTemplateError, OSError, ValueError):
            continue
        finally:
            if template is not None:
                template.cleanup()
    return sorted(set(versions))


@team_catalog_app.command("inspect")
def team_catalog_inspect(
    template_source: str = typer.Argument(..., help="agentcompanies/v1 template JSON file or package directory"),
    proposal_id: str = typer.Option("bootstrap_template_proposal", "--proposal-id"),
    available_plugin: list[str] = typer.Option([], "--available-plugin", help="Governed plugin id available to the template (repeatable)"),
    available_skill: list[str] = typer.Option([], "--available-skill", help="Governed skill id available to the template (repeatable)"),
    runtime_budget_seconds: int = typer.Option(0, "--runtime-budget-seconds", min=0),
    runtime_token_budget: int = typer.Option(0, "--runtime-token-budget", min=0),
    trust: str = typer.Option(
        None,
        "--trust",
        help="Admit a local (unsigned/self-built) company template in the preview: --trust local. "
        "Absent this, an unsigned/local company fails closed; reserved namespaces always hard-fail.",
    ),
) -> None:
    """Preview a team template as a non-mutating bootstrap proposal.

    Mirrors ``POST /api/team/catalog/preview`` (which accepts ``trust:"local"``):
    a ``kind=company`` template is verify-gated identically — local (unsigned)
    companies need an explicit ``--trust local`` / ``SUPERCLAW_COMPANY_LOCAL_DEV_TRUST=1``.
    """
    allow_local_opt_in = _resolve_company_local_opt_in(trust)
    _emit_json(
        _build_team_bootstrap_proposal_or_exit(
            template_source,
            mode="proposal",
            proposal_id=proposal_id,
            available_plugin=available_plugin,
            available_skill=available_skill,
            runtime_budget_seconds=runtime_budget_seconds,
            runtime_token_budget=runtime_token_budget,
            allow_local_opt_in=allow_local_opt_in,
        )
    )


@team_app.command("bootstrap")
def team_bootstrap_cmd(
    from_template: str = typer.Option(None, "--from-template", help="agentcompanies/v1 template JSON file or package directory"),
    from_catalog: str = typer.Option(
        None,
        "--from-catalog",
        help="Instantiate a CATALOGED company by id (optionally id@version). Resolves the local "
        "company source via the catalog and routes it through the same verify-before-instantiate gate.",
    ),
    mode: str = typer.Option("proposal", "--mode", help="proposal|commit"),
    proposal_id: str = typer.Option("bootstrap_template_proposal", "--proposal-id"),
    available_plugin: list[str] = typer.Option([], "--available-plugin", help="Governed plugin id available to the template (repeatable)"),
    available_skill: list[str] = typer.Option([], "--available-skill", help="Governed skill id available to the template (repeatable)"),
    runtime_budget_seconds: int = typer.Option(0, "--runtime-budget-seconds", min=0),
    runtime_token_budget: int = typer.Option(0, "--runtime-token-budget", min=0),
    by: str = typer.Option("local_user", "--by"),
    companies_root: Path | None = typer.Option(None, "--companies-root", help="Override the company source root for --from-catalog resolution"),
    trust: str = typer.Option(
        None,
        "--trust",
        help="Admit a local (unsigned/self-built) company template: --trust local. "
        "Absent this, an unsigned/local company fails closed; reserved namespaces always hard-fail.",
    ),
) -> None:
    """Preview or commit a governed bootstrap proposal from a team template.

    Provide EITHER ``--from-template <path>`` (a JSON file / package directory) OR
    ``--from-catalog <id[@version]>`` (a company discovered in the catalog, resolved to
    its local source). Exactly one is required.

    Proposal mode is intentionally side-effect free: it does not create company,
    workspace, agents, issues, equipment grants, or approvals in StateStore.
    Commit mode applies a clean proposal atomically or creates the required
    human approval for high-risk proposals.

    A ``kind=company`` template is verify-gated before any proposal is built:
    untrusted / unsigned / revoked / reserved-namespace companies fail closed.
    Local (unsigned/self-built) companies need an explicit ``--trust local`` (or
    ``SUPERCLAW_COMPANY_LOCAL_DEV_TRUST=1``).
    """
    if bool(from_template) == bool(from_catalog):
        _fail("team bootstrap requires exactly one of --from-template or --from-catalog")
    if from_catalog:
        from_template = _resolve_company_catalog_source_or_exit(from_catalog, companies_root=companies_root)
    allow_local_opt_in = _resolve_company_local_opt_in(trust)
    if mode == "proposal":
        _emit_json(
            _build_team_bootstrap_proposal_or_exit(
                from_template,
                mode=mode,
                proposal_id=proposal_id,
                available_plugin=available_plugin,
                available_skill=available_skill,
                runtime_budget_seconds=runtime_budget_seconds,
                runtime_token_budget=runtime_token_budget,
                allow_local_opt_in=allow_local_opt_in,
            )
        )
        return
    if mode != "commit":
        _fail("team bootstrap --mode must be proposal or commit")
    _emit_json(
        _team_bootstrap_commit_or_exit(
            from_template,
            proposal_id=proposal_id,
            available_plugin=available_plugin,
            available_skill=available_skill,
            runtime_budget_seconds=runtime_budget_seconds,
            runtime_token_budget=runtime_token_budget,
            requested_by=by,
            allow_local_opt_in=allow_local_opt_in,
        )
    )


@agent_app.command("create-profile")
def agent_create_profile(
    name: str = typer.Argument(..., help="Display name for the agent role"),
    role: str = typer.Argument(..., help="Role, e.g. engineer / reviewer / pm"),
    title: str | None = typer.Option(None, "--title"),
    workspace: str = typer.Option("local", "--workspace"),
    backend: str = typer.Option("claude", "--backend", help="Backend policy for this role's runs"),
    model: str = typer.Option("", "--model", help="Preferred model for this role (empty = backend default; rides the governed model_override channel)"),
    effort: str = typer.Option("", "--effort", help="Preferred reasoning-effort / thinking level for this role (empty = backend default; rides the governed effort_override channel). Honored only by effort-capable backends; others fail closed on an explicit value."),
    permission: str | None = typer.Option(None, "--permission", help="Tool posture for autonomous runs: 'none' (explicit read-only, does not inherit), 'ask'/'allow' (both map to bypassPermissions — runtime runs at max permission; SuperClaw governs above). Omit to inherit the workspace default, else fail-closed read-only."),
    heartbeat: bool = typer.Option(False, "--heartbeat", help="Make this role heartbeat-driven (the daemon wakes it on its own schedule; fail-closed default off)"),
    heartbeat_interval: int = typer.Option(300, "--heartbeat-interval", min=10, help="Seconds between heartbeats (with --heartbeat)"),
    plugin: list[str] = typer.Option([], "--plugin", help="Plugin id to equip (repeatable). Narrows the governed projection."),
    skill: list[str] = typer.Option([], "--skill", help="Governed skill id to equip (repeatable). Narrows the governed projection."),
    budget_seconds: int = typer.Option(0, "--budget-seconds", min=0, help="Wall-clock timeout (NOT a cost budget)"),
    token_budget: int = typer.Option(0, "--token-budget", min=0),
    context_mode: str = typer.Option("thin", "--context-mode", help="thin | fat"),
    reports_to: str | None = typer.Option(None, "--reports-to", help="Manager profile id"),
    company: str = typer.Option("local", "--company", help="Company profile id"),
    persona: str = typer.Option("", "--persona"),
    charter: str = typer.Option("", "--charter", help="Behavior contract text"),
    charter_file: str | None = typer.Option(None, "--charter-file", help="Read charter from a markdown file (e.g. AGENTS.md)"),
    default_instructions: str = typer.Option("", "--default-instructions"),
) -> None:
    """Create a persistent agent profile (a role with equipment + charter)."""
    _PERMISSION_MODE = {"none": "plan", **PRESET_TO_MODE}  # none=explicit read-only
    if permission is not None and permission not in _PERMISSION_MODE:
        raise typer.BadParameter("--permission must be 'none', 'ask', or 'allow'")
    permission_policy = {"mode": _PERMISSION_MODE[permission]} if permission else {}
    store = _team_store()
    charter_text = charter
    charter_source = "manual"
    if charter_file:
        path = Path(charter_file)
        if not path.is_file():
            _fail(f"charter file not found: {charter_file}")
        charter_text = path.read_text(encoding="utf-8")
        charter_source = "template"
    profile = AgentProfile(
        name=name,
        role=role,
        title=title,
        workspace_id=workspace,
        company_profile_id=company,
        backend_policy=backend,
        model=model,
        effort=effort,
        permission_policy=permission_policy,
        plugin_allowlist=list(plugin),
        skill_allowlist=list(skill),
        runtime_config=(
            {"heartbeat": {"enabled": True, "interval_sec": heartbeat_interval}} if heartbeat else {}
        ),
        budget_seconds=budget_seconds,
        token_budget=token_budget,
        context_mode=context_mode,
        reports_to=reports_to,
        persona=persona,
        charter=charter_text,
        default_instructions=default_instructions,
        charter_source=charter_source,
    )
    try:
        store.save_agent_profile(profile)
    except ValueError as exc:
        _fail(str(exc))
    resolution = team_kernel.resolve_equipment(profile)
    _emit_json(
        {
            "profile": profile.to_dict(),
            "equipment": {
                "granted": list(resolution.granted),
                "dropped": list(resolution.dropped),
                "skills": {
                    "granted": list(resolution.skills_granted),
                    "dropped": list(resolution.skills_dropped),
                },
            },
        }
    )


@agent_app.command("list")
def agent_list(
    workspace: str | None = typer.Option(None, "--workspace"),
    company: str | None = typer.Option(None, "--company", help="Company profile id"),
) -> None:
    """List agent profiles, optionally scoped to a workspace and/or company."""
    store = _team_store()
    profiles = store.list_agent_profiles(workspace_id=workspace, company_profile_id=company)
    _emit_json([p.to_dict() for p in profiles])


@agent_app.command("show")
def agent_show(profile_id: str = typer.Argument(...)) -> None:
    """Show a profile and the plugins it may actually carry right now."""
    store = _team_store()
    try:
        profile = store.get_agent_profile(profile_id)
    except KeyError:
        _fail(f"unknown agent profile: {profile_id}")
    resolution = team_kernel.resolve_equipment(profile)
    _emit_json(
        {
            "profile": profile.to_dict(),
            "equipment": {
                "granted": list(resolution.granted),
                "dropped": list(resolution.dropped),
                "available": list(resolution.available),
                "skills": {
                    "granted": list(resolution.skills_granted),
                    "dropped": list(resolution.skills_dropped),
                    "available": list(resolution.skills_available),
                },
            },
        }
    )


@issue_app.command("create")
def issue_create(
    title: str = typer.Argument(...),
    description: str = typer.Option("", "--description"),
    workspace: str = typer.Option("local", "--workspace"),
    company: str = typer.Option("local", "--company"),
    priority: str = typer.Option("medium", "--priority"),
    kind: str = typer.Option(
        IssueKind.DELIVERY.value, "--kind", help=" | ".join(sorted(ISSUE_KINDS))
    ),
    review_policy: str = typer.Option(
        ReviewPolicy.HUMAN_FINAL.value, "--review-policy", help=" | ".join(sorted(REVIEW_POLICIES))
    ),
    goal: str | None = typer.Option(None, "--goal", help="Goal id this issue traces to"),
    parent: str | None = typer.Option(None, "--parent", help="Parent issue id (sub-issue)"),
) -> None:
    """Create a delegated work item (issue)."""
    store = _team_store()
    try:
        # Construction validates the typed fields (Issue.__post_init__), so build
        # INSIDE the try: an invalid --kind/--review-policy is reported, not raised.
        issue = Issue(
            title=title,
            description=description,
            workspace_id=workspace,
            company_profile_id=company,
            priority=priority,
            kind=kind,
            review_policy=review_policy,
            goal_id=goal,
            parent_id=parent,
        )
        store.save_issue(issue)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("delegate")
def issue_delegate(
    parent_id: str = typer.Argument(..., help="Parent issue to delegate under"),
    profile_id: str = typer.Argument(..., help="Assignee agent profile id"),
    title: str = typer.Option(..., "--title"),
    description: str = typer.Option("", "--description"),
    by: str | None = typer.Option(None, "--by", help="Requesting agent profile id"),
    origin_run_id: str | None = typer.Option(None, "--origin-run-id", help="Run that initiated this delegation (audit provenance)"),
) -> None:
    """Delegate a sub-issue to a direct report (creates a child issue, assigned)."""
    store = _team_store()
    try:
        child = team_kernel.delegate_sub_issue(
            store, parent_id, assignee_agent_profile_id=profile_id, title=title, description=description, requested_by=by, origin_run_id=origin_run_id
        )
    except KeyError:
        _fail(f"unknown parent issue or profile: {parent_id}/{profile_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(child.to_dict())


# --- Goal Mode (计划模式) --------------------------------------------------------
# The CLI is the behavioural baseline for Goal Mode (铁律1/2): the Web confirmation
# dialog and the API are surfaces over these same kernel calls. The two-phase flow
# is `goal plan` (materialize a plan, awaiting_confirmation) then `goal confirm`
# (CAS to active + start the run). `--json` everywhere keeps it reproducible — the
# CLI's non-interactive equivalent of the dialog.


@goal_app.command("plan")
def goal_plan(
    title: str = typer.Argument(..., help="Goal title"),
    description: str = typer.Option("", "--description", help="What the goal should achieve"),
    topology: TaskTopology = typer.Option(
        TaskTopology.LINEAR,
        "--topology",
        help="Plan topology. Only LINEAR is executable in PR2; fan-out needs the budget-reservation layer (PR7).",
    ),
) -> None:
    """Plan a goal: materialize its task-slot plan and park it awaiting confirmation."""
    store = _team_store()
    try:
        record = goal_mode.plan_goal(
            store, title=title, description=description, topology=topology
        )
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(record.to_dict())


@goal_app.command("inspect")
def goal_inspect(goal_id: str = typer.Argument(..., help="Goal id")) -> None:
    """Show a goal's lifecycle record (status, revision, plan, roster)."""
    store = _team_store()
    try:
        record = store.get_goal_record(goal_id)
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    _emit_json(record.to_dict())


@goal_app.command("list")
def goal_list(
    status: str | None = typer.Option(None, "--status", help="Filter to a single status"),
) -> None:
    """List goal lifecycle records, newest first."""
    store = _team_store()
    statuses = {status} if status else None
    records = store.list_goal_records(statuses=statuses)
    _emit_json([record.to_dict() for record in records])


@goal_app.command("revise")
def goal_revise(
    goal_id: str = typer.Argument(...),
    revision: int = typer.Option(..., "--revision", help="Expected current revision (CAS)"),
) -> None:
    """Send an awaiting-confirmation goal back to draft so its plan can be redone."""
    store = _team_store()
    try:
        record = goal_mode.revise_goal(store, goal_id, expected_revision=revision)
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(record.to_dict())


@goal_app.command("cancel")
def goal_cancel(
    goal_id: str = typer.Argument(...),
    revision: int = typer.Option(..., "--revision", help="Expected current revision (CAS)"),
) -> None:
    """Cancel a goal (terminal)."""
    store = _team_store()
    try:
        record = goal_mode.cancel_goal(store, goal_id, expected_revision=revision)
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(record.to_dict())


@goal_app.command("confirm")
def goal_confirm(
    ctx: typer.Context,
    goal_id: str = typer.Argument(...),
    revision: int = typer.Option(..., "--revision", help="Expected current revision (CAS)"),
    plan_hash: str = typer.Option(..., "--plan-hash", help="Hash of the plan being confirmed (TOCTOU guard)"),
    backend: str = typer.Option("claude", "--backend", help="Lead runtime — covers every plan slot not bound by an --assign"),
    model: str | None = typer.Option(None, "--model", help="Lead model override (honored if the backend supports it)"),
    effort: str | None = typer.Option(None, "--effort", help="Lead reasoning effort (effort-capable backends only)"),
    assign: list[str] = typer.Option(
        [],
        "--assign",
        help="Bind an agent to one plan slot (PR4 multi-agent), repeatable: "
        "--assign role=implement,backend=codex,model=gpt-5.5,effort=high",
    ),
    token_budget: int = typer.Option(
        0,
        "--token-budget",
        help="Goal token budget (PR7) — required to confirm a concurrent IMPLEMENT_FANOUT plan; "
        "the admission ceiling so concurrent workers cannot overspend it.",
    ),
    per_worker_tokens: int = typer.Option(
        0, "--per-worker-tokens", help="Per-worker reservation slice (default: token-budget / lanes)."
    ),
    repo: Path = typer.Option(Path("."), "--repo"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    dry: bool = typer.Option(False, "--dry"),
    start: bool = typer.Option(True, "--start/--no-start", help="Start the run after confirming (use --no-start to only flip to active)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Confirm a goal's plan + roster and start its run.

    The lead (--backend/--model/--effort) covers every slot; each --assign binds a
    different agent to one plan slot, so a goal can run each serial slot on its own
    agent (multi-agent role casting). With no --assign this is the single-runtime
    roster."""
    _hydrate_cli_environment()
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    store = orchestrator.store
    entries: list[dict[str, Any]] = [
        {"source": "backend", "role": None, "backend": backend, "model": model, "effort": effort}
    ]
    for spec in assign:
        fields: dict[str, str] = {}
        for pair in spec.split(","):
            pair = pair.strip()
            if not pair:
                continue
            if "=" not in pair:
                _fail(f"--assign expects key=value pairs, got {pair!r}")
            key, _, value = pair.partition("=")
            fields[key.strip()] = value.strip()
        role = fields.get("role")
        if not role:
            _fail(f"--assign requires a role= (got {spec!r})")
        entries.append(
            {
                "source": "backend",
                "role": role,
                # 'agent' is accepted as an alias for 'backend' on the command line.
                "backend": fields.get("backend") or fields.get("agent") or backend,
                "model": fields.get("model") or None,
                "effort": fields.get("effort") or None,
            }
        )
    roster = {"entries": entries}
    budget = None
    if token_budget > 0 or per_worker_tokens > 0:
        budget = {"token_budget": token_budget, "per_worker_tokens": per_worker_tokens}
    try:
        record = goal_mode.confirm_goal(
            store,
            goal_id,
            expected_revision=revision,
            plan_hash=plan_hash,
            roster=roster,
            known_backends=set(orchestrator.backends),
            budget=budget,
        )
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    except ValueError as exc:
        _fail(str(exc))
    if not start:
        _emit_json(record.to_dict())
        return
    try:
        result = goal_mode.start_confirmed_goal_run(
            orchestrator,
            record,
            repo_path=repo,
            budget_seconds=budget_seconds,
            dry_run=dry,
        )
    except ValueError as exc:
        _fail(str(exc))
    # Re-read so the output reports the revision the start claim actually persisted,
    # not the pre-claim copy (CLI is the behavioural baseline — it must not report a
    # stale revision).
    fresh = orchestrator.store.get_goal_record(goal_id)
    _emit_json({"goal": fresh.to_dict(), "run": result.session.to_dict()})


@goal_app.command("autonomy")
def goal_autonomy(
    enable: Optional[bool] = typer.Option(
        None, "--enable/--disable", help="Turn autonomous goal continuation on/off (default OFF)."
    ),
) -> None:
    """Show or set the autonomous goal-continuation flag (PR8). Default OFF — autonomy
    is opt-in; the daemon never auto-runs approved goals unless this is explicitly on."""
    from superclaw.runtime_config import (
        goal_autonomous_continuation_enabled,
        set_goal_autonomous_continuation,
    )

    if enable is not None:
        set_goal_autonomous_continuation(enable)
    _emit_json({"goal_autonomous_continuation": goal_autonomous_continuation_enabled()})


@goal_app.command("continue")
def goal_continue(
    repo: Path = typer.Option(Path("."), "--repo"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    max_goals: int = typer.Option(5, "--max-goals", help="Cap goals continued per tick"),
    force: bool = typer.Option(
        False, "--force", help="Run the tick even if autonomy is disabled in config"
    ),
) -> None:
    """Run one autonomous-continuation tick: auto-start CONFIRMED active goals with no
    live run. A no-op unless autonomy is enabled (or --force). Each run keeps its own
    governance; this only decides WHEN an approved goal runs."""
    _hydrate_cli_environment()
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    continued = goal_mode.continue_active_goals(
        orchestrator,
        enabled=True if force else None,
        repo_path=repo,
        budget_seconds=budget_seconds,
        max_goals=max_goals,
    )
    _emit_json({"continued": continued})


@goal_app.command("start")
def goal_start(
    goal_id: str = typer.Argument(..., help="An already-confirmed (active) goal"),
    repo: Path = typer.Option(Path("."), "--repo"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    dry: bool = typer.Option(False, "--dry"),
) -> None:
    """Start the run for an already-confirmed (active) goal — the承接 path for
    `goal confirm --no-start`, and the crash-resume path if a confirm flipped a goal
    to active but the run never started. Refuses to start a duplicate while a run is
    live. Runtime comes from the goal's confirmed roster."""
    _hydrate_cli_environment()
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        record = orchestrator.store.get_goal_record(goal_id)
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    try:
        result = goal_mode.start_confirmed_goal_run(
            orchestrator, record, repo_path=repo, budget_seconds=budget_seconds, dry_run=dry
        )
    except ValueError as exc:
        _fail(str(exc))
    fresh = orchestrator.store.get_goal_record(goal_id)  # report the post-claim revision
    _emit_json({"goal": fresh.to_dict(), "run": result.session.to_dict()})


@goal_app.command("replan")
def goal_replan(
    goal_id: str = typer.Argument(...),
    revision: int = typer.Option(..., "--revision", help="Expected current revision (CAS)"),
    topology: TaskTopology | None = typer.Option(None, "--topology", help="New plan topology (LINEAR only executable in PR2)"),
    description: str | None = typer.Option(None, "--description", help="Revised goal description"),
) -> None:
    """Re-materialize a draft / awaiting-confirmation goal's plan (the path out of
    `goal revise`) and park it awaiting confirmation again with a fresh plan hash."""
    store = _team_store()
    try:
        record = goal_mode.replan_goal(
            store, goal_id, expected_revision=revision, topology=topology, description=description
        )
    except KeyError:
        _fail(f"unknown goal: {goal_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(record.to_dict())


@agent_app.command("update-charter")
def agent_update_charter(
    profile_id: str = typer.Argument(...),
    charter: str = typer.Option("", "--charter"),
    charter_file: str | None = typer.Option(None, "--charter-file"),
    persona: str | None = typer.Option(None, "--persona"),
) -> None:
    """Update a role's behavior charter (bumps charter_revision_id)."""
    store = _team_store()
    try:
        profile = store.get_agent_profile(profile_id)
    except KeyError:
        _fail(f"unknown agent profile: {profile_id}")
    if charter_file:
        path = Path(charter_file)
        if not path.is_file():
            _fail(f"charter file not found: {charter_file}")
        profile.charter = path.read_text(encoding="utf-8")
        profile.charter_source = "template"
    elif charter:
        profile.charter = charter
        profile.charter_source = "manual"
    if persona is not None:
        profile.persona = persona
    profile.charter_revision_id = f"charterrev_{uuid.uuid4().hex[:12]}"
    store.save_agent_profile(profile)
    _emit_json(profile.to_dict())


@agent_app.command("update-profile")
def agent_update_profile(
    profile_id: str = typer.Argument(...),
    title: str | None = typer.Option(None, "--title"),
    backend: str | None = typer.Option(None, "--backend", help="Backend policy"),
    model: str | None = typer.Option(None, "--model", help="Preferred model; pass '' to reset to backend default"),
    effort: str | None = typer.Option(None, "--effort", help="Preferred reasoning-effort / thinking level; pass '' to reset to backend default"),
    permission: str | None = typer.Option(None, "--permission", help="inherit | none | ask | allow (omit to leave unchanged; 'inherit' resets to the workspace default)"),
    heartbeat: bool | None = typer.Option(None, "--heartbeat/--no-heartbeat", help="Toggle heartbeat-driven (omit to leave unchanged)"),
    heartbeat_interval: int = typer.Option(300, "--heartbeat-interval", min=10, help="Seconds between heartbeats (with --heartbeat)"),
    skill: list[str] = typer.Option([], "--skill", help="Skill id (repeatable); applied only with --replace-skills"),
    replace_skills: bool = typer.Option(False, "--replace-skills", help="Set the skill allowlist to exactly --skill (empty = clear)"),
    plugin: list[str] = typer.Option([], "--plugin", help="Plugin id (repeatable); applied only with --replace-plugins"),
    replace_plugins: bool = typer.Option(False, "--replace-plugins", help="Set the plugin allowlist to exactly --plugin (empty = clear)"),
    reports_to: str | None = typer.Option(None, "--reports-to", help="Manager profile id; pass 'none' to clear"),
    persona: str | None = typer.Option(None, "--persona"),
    context_mode: str | None = typer.Option(None, "--context-mode", help="thin | fat"),
    budget_seconds: int | None = typer.Option(None, "--budget-seconds", min=0),
    token_budget: int | None = typer.Option(None, "--token-budget", min=0),
) -> None:
    """Edit an existing role's config after creation (model / skill / permission /
    heartbeat / reports-to / budgets ...).

    Only the flags you pass change; everything else is left as-is. The charter has
    its own command (update-charter); workspace and company are immutable.
    """
    _PERMISSION_MODE = {"none": "plan", **PRESET_TO_MODE}  # none=explicit read-only
    if permission is not None and permission != "inherit" and permission not in _PERMISSION_MODE:
        raise typer.BadParameter("--permission must be 'inherit', 'none', 'ask', or 'allow'")
    store = _team_store()
    try:
        current = store.get_agent_profile(profile_id)
    except KeyError:
        _fail(f"unknown agent profile: {profile_id}")
    patch: dict[str, Any] = {}
    if title is not None:
        patch["title"] = title
    if backend is not None:
        patch["backend_policy"] = backend
    if model is not None:
        patch["model"] = model
    if effort is not None:
        patch["effort"] = effort
    if permission is not None:
        # 'inherit' resets to {} (workspace default); else an explicit mode.
        patch["permission_policy"] = (
            {} if permission == "inherit" else {"mode": _PERMISSION_MODE[permission]}
        )
    if heartbeat is not None:
        # Heartbeat-merge semantics live in the kernel (apply_heartbeat), so the
        # toggle never clobbers other runtime_config keys and every surface shares
        # one definition.
        patch["runtime_config"] = team_kernel.apply_heartbeat(
            current.runtime_config, enabled=heartbeat, interval_sec=heartbeat_interval
        )
    if replace_skills:
        patch["skill_allowlist"] = list(skill)
    if replace_plugins:
        patch["plugin_allowlist"] = list(plugin)
    if reports_to is not None:
        patch["reports_to"] = None if reports_to.strip().lower() == "none" else reports_to
    if persona is not None:
        patch["persona"] = persona
    if context_mode is not None:
        patch["context_mode"] = context_mode
    if budget_seconds is not None:
        patch["budget_seconds"] = budget_seconds
    if token_budget is not None:
        patch["token_budget"] = token_budget
    if not patch:
        _fail("no fields to update (pass at least one option, e.g. --model)")
    try:
        # CAS on the revision read above: a concurrent edit between our read and
        # this write is rejected instead of silently clobbered.
        profile, resolution = team_kernel.update_agent_profile(
            store, profile_id, patch=patch, expected_revision_id=current.revision_id
        )
    except KeyError:
        _fail(f"unknown agent profile: {profile_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(
        {
            "profile": profile.to_dict(),
            "equipment": {
                "granted": list(resolution.granted),
                "dropped": list(resolution.dropped),
                "skills": {
                    "granted": list(resolution.skills_granted),
                    "dropped": list(resolution.skills_dropped),
                },
            },
        }
    )


@agent_app.command("request-config-change")
def agent_request_config_change(
    target_profile_id: str = typer.Argument(..., help="Profile to reconfigure (self or another)"),
    by: str = typer.Option(..., "--by", help="Requesting agent profile id"),
    title: str | None = typer.Option(None, "--title"),
    backend: str | None = typer.Option(None, "--backend"),
    model: str | None = typer.Option(None, "--model", help="Preferred model; '' resets to backend default"),
    effort: str | None = typer.Option(None, "--effort", help="Preferred reasoning-effort / thinking level; '' resets to backend default"),
    permission: str | None = typer.Option(None, "--permission", help="inherit | none | ask | allow"),
    heartbeat: bool | None = typer.Option(None, "--heartbeat/--no-heartbeat"),
    heartbeat_interval: int = typer.Option(300, "--heartbeat-interval", min=10),
    skill: list[str] = typer.Option([], "--skill", help="Skill id (repeatable); needs --replace-skills"),
    replace_skills: bool = typer.Option(False, "--replace-skills"),
    reports_to: str | None = typer.Option(None, "--reports-to", help="Manager profile id; 'none' to clear"),
    persona: str | None = typer.Option(None, "--persona"),
    note: str = typer.Option("", "--note", help="Why (shown to the human reviewer)"),
) -> None:
    """Request a config change to a role (human-gated; NEVER applied directly).

    Opens a pending approval; a human grant is what finally applies it through
    the same kernel update the CLI/API/Web use. This is the agent-facing path —
    a running agent shells out to it to reconfigure the org, fail-closed.
    """
    _PERMISSION_MODE = {"none": "plan", **PRESET_TO_MODE}
    if permission is not None and permission != "inherit" and permission not in _PERMISSION_MODE:
        raise typer.BadParameter("--permission must be 'inherit', 'none', 'ask', or 'allow'")
    store = _team_store()
    try:
        current = store.get_agent_profile(target_profile_id)
    except KeyError:
        _fail(f"unknown agent profile: {target_profile_id}")
    patch: dict[str, Any] = {}
    if title is not None:
        patch["title"] = title
    if backend is not None:
        patch["backend_policy"] = backend
    if model is not None:
        patch["model"] = model
    if effort is not None:
        patch["effort"] = effort
    if permission is not None:
        patch["permission_policy"] = (
            {} if permission == "inherit" else {"mode": _PERMISSION_MODE[permission]}
        )
    if heartbeat is not None:
        patch["runtime_config"] = team_kernel.apply_heartbeat(
            current.runtime_config, enabled=heartbeat, interval_sec=heartbeat_interval
        )
    if replace_skills:
        patch["skill_allowlist"] = list(skill)
    if reports_to is not None:
        patch["reports_to"] = None if reports_to.strip().lower() == "none" else reports_to
    if persona is not None:
        patch["persona"] = persona
    if not patch:
        _fail("no fields to change (pass at least one option, e.g. --model)")
    try:
        approval = team_kernel.request_agent_config_change(
            store, target_profile_id=target_profile_id, patch=patch, requested_by=by, note=note or None
        )
    except KeyError:
        _fail(f"unknown agent profile: {target_profile_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(approval.to_dict())


@agent_app.command("request-hire")
def agent_request_hire(
    name: str = typer.Argument(..., help="Display name for the new role"),
    role: str = typer.Argument(..., help="Role, e.g. engineer / reviewer / pm"),
    by: str = typer.Option(..., "--by", help="Requesting agent profile id"),
    title: str | None = typer.Option(None, "--title"),
    workspace: str = typer.Option("local", "--workspace"),
    company: str = typer.Option("local", "--company"),
    backend: str = typer.Option("claude", "--backend"),
    model: str = typer.Option("", "--model"),
    permission: str | None = typer.Option(None, "--permission", help="none | ask | allow"),
    skill: list[str] = typer.Option([], "--skill"),
    reports_to: str | None = typer.Option(None, "--reports-to"),
    persona: str = typer.Option("", "--persona"),
    charter: str = typer.Option("", "--charter"),
    note: str = typer.Option("", "--note"),
) -> None:
    """Request to hire (create) a new role (human-gated; created only on grant)."""
    _PERMISSION_MODE = {"none": "plan", **PRESET_TO_MODE}
    if permission is not None and permission not in _PERMISSION_MODE:
        raise typer.BadParameter("--permission must be 'none', 'ask', or 'allow'")
    spec: dict[str, Any] = {
        "name": name,
        "role": role,
        "workspace_id": workspace,
        "company_profile_id": company,
        "backend_policy": backend,
        "model": model,
        "skill_allowlist": list(skill),
        "persona": persona,
        "charter": charter,
    }
    if title is not None:
        spec["title"] = title
    if reports_to is not None:
        spec["reports_to"] = reports_to
    if permission is not None:
        spec["permission_policy"] = {"mode": _PERMISSION_MODE[permission]}
    store = _team_store()
    try:
        approval = team_kernel.request_hire(store, spec=spec, requested_by=by, note=note or None)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(approval.to_dict())


@agent_app.command("run-context")
def agent_run_context(profile_id: str = typer.Argument(...)) -> None:
    """Show the run context the orchestrator injects for this role (charter + equipment + chain)."""
    store = _team_store()
    try:
        profile = store.get_agent_profile(profile_id)
    except KeyError:
        _fail(f"unknown agent profile: {profile_id}")
    _emit_json(team_kernel.build_agent_run_context(store, profile))


# --- Cost tracing CLI (the run-layer ledger) ------------------------------


def _cost_time_window(
    *, today: bool, since: str | None, until: str | None
) -> tuple[float | None, float | None]:
    """Thin CLI surface over the kernel ``resolve_cost_window`` (single source of
    truth shared with the API). Validation lives in the kernel; here we only map
    its fail-closed ``ValueError`` to the CLI's exit shape."""
    try:
        return resolve_cost_window(today=today, since=since, until=until)
    except ValueError as exc:
        _fail(str(exc))
        raise  # unreachable — _fail exits; satisfies the type checker


@cost_app.command("list")
def cost_list(
    run: str | None = typer.Option(None, "--run"),
    chat: str | None = typer.Option(None, "--chat"),
    agent: str | None = typer.Option(None, "--agent"),
    issue: str | None = typer.Option(None, "--issue"),
    company: str | None = typer.Option(None, "--company"),
    today: bool = typer.Option(False, "--today", help="Only events in today's local calendar day (excludes future-dated rows)."),
    since: str | None = typer.Option(None, "--since", help="Inclusive lower bound (YYYY-MM-DD, local)."),
    until: str | None = typer.Option(None, "--until", help="Exclusive upper bound (YYYY-MM-DD, local)."),
) -> None:
    """List cost events filtered by scope (run / chat session / agent / issue / company)."""
    store = _team_store()
    since_epoch, until_epoch = _cost_time_window(today=today, since=since, until=until)
    events = store.list_cost_events(
        run_id=run, chat_session_id=chat, agent_profile_id=agent, issue_id=issue,
        company_profile_id=company, since=since_epoch, until=until_epoch,
    )
    _emit_json([e.to_dict() for e in events])


@cost_app.command("summary")
def cost_summary(
    run: str | None = typer.Option(None, "--run"),
    chat: str | None = typer.Option(None, "--chat"),
    agent: str | None = typer.Option(None, "--agent"),
    issue: str | None = typer.Option(None, "--issue"),
    company: str | None = typer.Option(None, "--company"),
    today: bool = typer.Option(False, "--today", help="Only events in today's local calendar day (excludes future-dated rows)."),
    since: str | None = typer.Option(None, "--since", help="Inclusive lower bound (YYYY-MM-DD, local)."),
    until: str | None = typer.Option(None, "--until", help="Exclusive upper bound (YYYY-MM-DD, local)."),
) -> None:
    """Roll up token/duration cost for a scope (Chat and Team read the same ledger)."""
    store = _team_store()
    since_epoch, until_epoch = _cost_time_window(today=today, since=since, until=until)
    _emit_json(
        store.summarize_cost(
            run_id=run, chat_session_id=chat, agent_profile_id=agent, issue_id=issue,
            company_profile_id=company, since=since_epoch, until=until_epoch,
        )
    )


# --- Company / Workspace governance namespace CLI -------------------------


@company_app.command("init")
def company_init(
    name: str = typer.Argument(...),
    goal: str = typer.Option("", "--goal"),
    budget_seconds: int = typer.Option(0, "--default-budget-seconds", min=0),
    token_budget: int = typer.Option(0, "--default-token-budget", min=0),
    repo: Path | None = typer.Option(None, "--repo", help="Existing local repo to bind as the company workspace (trust-as-creation rules apply)."),
    repo_url: str | None = typer.Option(None, "--repo-url", help="Git URL to clone into an app-owned managed checkout (trusted by construction)."),
    yes: bool = typer.Option(False, "--yes", help="Confirm trusting --repo without the interactive prompt."),
) -> None:
    """Create a company profile, optionally binding its workspace in one step.

    Paperclip pattern: setup happens once at company creation; issue runs are
    fully automatic afterwards. --repo binds an existing checkout (interactive
    confirm or --yes; safety gates are non-negotiable); --repo-url clones into
    ~/.superclaw/companies/<company>/<repo>.
    """
    if repo is not None and repo_url:
        _fail("--repo and --repo-url are mutually exclusive")
    store = _team_store()
    company = CompanyProfile(
        name=name, goal=goal, default_budget_seconds=budget_seconds, default_token_budget=token_budget
    )
    workspace = None
    if repo is not None or repo_url:
        # Pre-validate the binding before persisting anything: the governance
        # scope requires the company row to exist before its workspace, so
        # cheap checks run first to avoid a half-initialized company.
        if repo is not None:
            existing = workspace_resolver.find_workspace_for_path(store, repo)
            if existing is not None and existing.company_profile_id != "local":
                _fail(
                    f"workspace {existing.workspace_id} already belongs to company "
                    f"{existing.company_profile_id}"
                )
            if existing is None:
                try:
                    workspace_resolver.assert_safe_workspace_root(repo)
                except workspace_resolver.WorkspaceRootRejected as exc:
                    _fail(str(exc))
        if repo is not None and not yes:
            if not sys.stdin.isatty():
                _fail(
                    f"{workspace_resolver.WORKSPACE_TRUST_REQUIRED}: non-interactive "
                    "--repo binding needs an explicit --yes"
                )
            shown = _safe_path_display(
                workspace_resolver.resolve_repo_identity(repo)["canonical_path"]
            )
            typer.confirm(f"Trust {shown} as the workspace for company {name}?", abort=True)
        store.save_company_profile(company)
        try:
            workspace = workspace_resolver.materialize_company_workspace(
                store,
                company.company_profile_id,
                company.name,
                repo=repo,
                repo_url=repo_url,
                trust_source="cli_flag" if yes else "cli_prompt",
            )
        except (workspace_resolver.WorkspaceRootRejected, ValueError) as exc:
            # The company row already exists (governance scope requires it
            # before its workspace) — say so, so the operator can retry the
            # binding instead of recreating the company.
            _fail(
                f"company {company.company_profile_id} created but workspace "
                f"binding failed: {exc}"
            )
    else:
        store.save_company_profile(company)
    payload: dict[str, Any] = {"company": company.to_dict()}
    if workspace is not None:
        payload["workspace"] = workspace.to_dict()
    _emit_json(payload)


@company_app.command("list")
def company_list() -> None:
    """List company profiles."""
    store = _team_store()
    _emit_json([c.to_dict() for c in store.list_company_profiles()])


@company_app.command("show")
def company_show(company_profile_id: str = typer.Argument(...)) -> None:
    """Show one company profile."""
    store = _team_store()
    try:
        company = store.get_company_profile(company_profile_id)
    except KeyError:
        _fail(f"unknown company profile: {company_profile_id}")
    _emit_json(company.to_dict())


@company_app.command("snapshot")
def company_snapshot_cmd(company_profile_id: str = typer.Argument(...)) -> None:
    """Bounded dashboard snapshot of ONE company (roster + issue counts + cost).

    Read-only projection of ``company_read.build_company_snapshot_payload`` — the
    SAME DTO the API (``GET /api/team/companies/{id}/snapshot``) and the chat
    ``company_snapshot`` tool consume, so the three surfaces never drift.
    """
    from superclaw.company_read import build_company_snapshot_payload

    store = _team_store()
    try:
        payload = build_company_snapshot_payload(store, company_profile_id)
    except KeyError:
        _fail(f"unknown company profile: {company_profile_id}")
    _emit_json(payload)


@company_app.command("messages")
def company_messages_cmd(
    company: str | None = typer.Option(
        None, "--company", help="Scope the roll-up to one company (default: all companies)."
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit the raw message-center payload."),
) -> None:
    """Tiered Agent-company message roll-up (pending approvals + completed-unreviewed + blocked).

    Read-only projection of the kernel message center
    (docs/agent-company-message-center-design.md). The SAME aggregation the API
    and Web surfaces consume — the CLI never re-derives counts.
    """
    from superclaw import ui_contracts

    store = _team_store()
    payload = ui_contracts.build_company_messages_payload(
        store, company_profile_id=company
    )
    if as_json:
        _emit_json(payload)
        return
    typer.echo(f"unread: {payload['total_unread']} (across {len(payload['companies'])} compan{'y' if len(payload['companies']) == 1 else 'ies'})")
    for entry in payload["companies"]:
        typer.echo(
            f"  {entry['name']} [{entry['company_profile_id']}]: "
            f"pending={entry['pending_approvals']} "
            f"completed_unreviewed={entry['completed_unreviewed']} "
            f"blocked={entry['blocked']} "
            f"unread={entry['unread_total']}"
        )


@company_app.command("mark-read")
def company_mark_read_cmd(
    company: str | None = typer.Option(
        None, "--company", help="Mark this company's live messages read up to --seen-as-of."
    ),
    seen_as_of: float | None = typer.Option(
        None,
        "--seen-as-of",
        help="Server snapshot (the snapshot_as_of from `messages --json`). REQUIRED in both modes.",
    ),
    item_key: list[str] = typer.Option(
        None, "--item-key", help="Mark exact itemKey(s) read. Repeatable. Mutually exclusive with --company."
    ),
) -> None:
    """Mark message-center items read, bounded by a server snapshot.

    Two mutually-exclusive selection modes mirror the kernel contract:
    ``--item-key K ... --seen-as-of T`` OR ``--company X --seen-as-of T``. Both
    REQUIRE ``--seen-as-of`` — a mark-read may only acknowledge events the caller
    actually observed (event_time <= the snapshot they read at). The CLI never
    invents a snapshot — pass the ``snapshot_as_of`` from `company messages --json`.
    """
    import math

    from superclaw import company_messages

    keys = list(item_key) if item_key else None
    # Validate the CLI shape BEFORE constructing the store, so malformed/invalid
    # input fails closed without opening or touching any state (fail-before-read).
    if keys and company:
        _fail("pass --item-key OR --company, not both")
    if not keys and not company:
        _fail("pass --item-key, or --company (both with --seen-as-of)")
    if seen_as_of is None:
        _fail("--seen-as-of is required (the snapshot_as_of from `company messages --json`)")
    if not math.isfinite(seen_as_of) or seen_as_of < 0:
        _fail("--seen-as-of must be a finite non-negative epoch (the snapshot_as_of from `company messages --json`)")
    store = _team_store()
    try:
        result = company_messages.mark_messages_read(
            store, item_keys=keys, company_profile_id=company, seen_as_of=seen_as_of
        )
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(result)


@company_app.command("set-logo")
def company_set_logo(
    company_profile_id: str = typer.Argument(...),
    file: Path = typer.Option(..., "--file", "-f", help="Path to a PNG/JPEG/WebP image (≤256 KB)."),
) -> None:
    """Set a company's custom logo from an image file.

    Validation (size / format / magic bytes) lives in the kernel
    ``set_company_logo`` — the same gate the API uses — so the CLI and the Web
    surface can never drift (铁律2). Logos are instance-level visual assets;
    when none is set the Web surface falls back to a deterministic identicon.
    """
    from superclaw.company_logo import COMPANY_LOGO_MAX_BYTES, CompanyLogoError, set_company_logo

    store = _team_store()
    # Cheap stat-based pre-check so a mis-pointed --file (e.g. a multi-GB log or
    # ISO) is rejected without reading it all into memory; the kernel gate then
    # re-checks size/format/magic bytes authoritatively.
    try:
        if file.stat().st_size > COMPANY_LOGO_MAX_BYTES:
            _fail(f"logo file exceeds {COMPANY_LOGO_MAX_BYTES // 1024} KB limit")
        data = file.read_bytes()
    except OSError as exc:
        _fail(f"cannot read logo file: {exc}")
    try:
        profile = set_company_logo(store, company_profile_id, data)
    except KeyError:
        _fail(f"unknown company profile: {company_profile_id}")
    except CompanyLogoError as exc:
        _fail(str(exc))
    _emit_json(profile.to_dict())


@company_app.command("clear-logo")
def company_clear_logo(company_profile_id: str = typer.Argument(...)) -> None:
    """Remove a company's custom logo (the Web surface reverts to its identicon)."""
    from superclaw.company_logo import clear_company_logo

    store = _team_store()
    try:
        profile = clear_company_logo(store, company_profile_id)
    except KeyError:
        _fail(f"unknown company profile: {company_profile_id}")
    _emit_json(profile.to_dict())


# --- chat-driven company management, mirrored onto the CLI (PR-D) ----------
#
# CLI parity for the company-management mutation contract (CLAUDE.md 铁律: CLI is
# the single source of truth; every surface routes the SAME operation through the
# SAME kernel logic — here ``company_handler.execute_company_command``). The CLI
# CANNOT hand-roll a parallel mutation path: each command below builds the typed
# ``company_commands`` model, injects the OPERATOR scope (the CLI is a human at a
# terminal driving their own single-user tool, so it is an admin over all of
# their own companies — design §1 threat model), and dispatches through the one
# handler that the chat tool projection and the API surface also call. The
# handler decides LOW (run straight through) vs HIGH (archive → pending approval
# the operator confirms via ``superclaw approve grant``); the CLI never makes
# that call itself.

def _split_csv(value: str | None) -> list[str]:
    """Split a comma-separated CLI option into a clean list of non-blank tokens.

    ``None`` / empty → ``[]`` so an unset allowlist option becomes the command
    model's empty-list default rather than ``[""]``.
    """
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


# Stable principal id the CLI records as the acting operator. Mirrors the
# ``--by`` default of the approval commands (``approve grant`` / ``reject``) so a
# CLI-created approval and a CLI-granted decision attribute to the same identity.
_CLI_OPERATOR_PRINCIPAL = "local_user"


def _cli_operator_scope(company_profile_id: str) -> CompanyScope:
    """The operator scope every CLI company command is dispatched under.

    The CLI is the single user driving their own local tool, so the scope is an
    admin over all of their own companies (design §1: the scope gate is a
    correctness/same-origin check, not a cross-tenant security wall). Authority is
    SERVER-injected here (never read from a command body) exactly as the handler
    contract requires; ``actor_company_id`` is the company the command targets (or
    the default ``"local"`` home company for create/hire/issue with no explicit
    company), so an implicit, no-target operation lands in the right home company.
    """
    return CompanyScope(
        principal_id=_CLI_OPERATOR_PRINCIPAL,
        actor_company_id=company_profile_id,
        is_admin=True,
    )


def _run_company_command(command: Any, *, actor_company_id: str) -> None:
    """Dispatch ``command`` through the ONE shared handler and render the result.

    This is the single CLI execution point for every company-management command:
    it injects the operator scope, calls ``execute_company_command`` (the same
    entry the chat tool projection and the API use — zero drift), and maps the
    handler's outcome / typed errors onto the CLI's standard JSON-or-``_fail``
    convention:

      * ``executed``  → emit the result detail (created/updated ids).
      * ``pending_approval`` (archive only) → emit the approval id plus a hint to
        confirm it via ``superclaw approve grant`` (or in the Web approvals inbox).
      * ``CompanyScopeError`` (cross-boundary target, 403-equivalent),
        ``CompanyFrozenError`` (frozen/dissolved target), ``ValueError`` (failed
        stateless validation / unknown enum / empty patch), ``KeyError`` (unknown
        company / agent / issue / workspace id) → friendly message + non-zero exit
        via ``_fail``, matching the other team/company CLI commands' error style.
    """
    from superclaw.company_handler import execute_company_command
    from superclaw.company_lifecycle import CompanyFrozenError
    from superclaw.company_scope import CompanyScopeError

    store = _team_store()
    try:
        result = execute_company_command(
            command,
            scope=_cli_operator_scope(actor_company_id),
            store=store,
            requested_by=_CLI_OPERATOR_PRINCIPAL,
        )
    except CompanyScopeError as exc:
        _fail(f"out of scope: {exc.reason}")
    except CompanyFrozenError as exc:
        _fail(str(exc))
    except KeyError as exc:
        # Unknown target id (company / agent / issue / workspace). KeyError's str
        # is the quoted missing key; surface it plainly.
        _fail(f"unknown id: {exc.args[0] if exc.args else exc}")
    except ValueError as exc:
        _fail(str(exc))

    if result.outcome == "pending_approval":
        approval_id = result.detail.get("approval_id")
        _emit_json(
            {
                "outcome": result.outcome,
                "risk": result.verdict.tier,
                "approval_id": approval_id,
                "detail": result.detail,
                "hint": (
                    f"archive needs confirmation: approve with "
                    f"`superclaw approve grant {approval_id}` "
                    f"(or in the Web approvals inbox)"
                ),
            }
        )
        return
    _emit_json(
        {
            "outcome": result.outcome,
            "risk": result.verdict.tier,
            "detail": result.detail,
        }
    )


# Per-field VALUE TYPE for ``company update-agent --set k=v``. Every key here is a
# member of ``team_kernel.EDITABLE_PROFILE_FIELDS``; the type is that field's real
# type on ``models.AgentProfile`` (verified against its annotations). A raw
# ``--set`` token is always a string, so the CLI MUST coerce it to the field's
# real type — otherwise ``--set budget_seconds=120`` would persist the string
# "120" where the typed flags / command model / kernel expect an ``int``, a
# semantic drift the existing typed CLI flags do not have. Buckets:
#   * "int"  → int(v); a non-numeric value fails closed.
#   * "csv"  → _split_csv(v); list[str] allowlist from a comma-separated value.
#   * "json" → json.loads(v) and must be a JSON object (dict).
#   * "str"  → left as the raw string (str / str|None fields).
_AGENT_SET_FIELD_TYPES: dict[str, str] = {
    # int
    "budget_seconds": "int",
    "token_budget": "int",
    "run_count_budget": "int",
    "external_tool_budget": "int",
    # list[str]
    "plugin_allowlist": "csv",
    "skill_allowlist": "csv",
    # dict (JSON object)
    "permission_policy": "json",
    "runtime_config": "json",
    # str / str|None
    "name": "str",
    "role": "str",
    "title": "str",
    "backend_policy": "str",
    "model": "str",
    "effort": "str",
    "context_mode": "str",
    "reports_to": "str",
    "persona": "str",
    "default_instructions": "str",
}


def _parse_agent_set_pairs(pairs: list[str]) -> dict[str, Any]:
    """Parse ``--set k=v`` into a TYPED agent patch, coercing per field type.

    Fail-closed at every step (so an operator never thinks a malformed ``--set``
    took effect, and the patch never carries a value of the wrong type into the
    kernel's typed save path):

      * a token without ``=`` / with an empty key → usage error;
      * an unknown key (not in ``EDITABLE_PROFILE_FIELDS``) → rejected up front
        with the editable-field list, rather than slipping into the patch for a
        later, less specific error (the command model's ``validate()`` re-checks
        the same whitelist — defence in depth);
      * an int field given a non-numeric value, or a JSON field given a non-object
        / unparseable value → a clear per-field error.

    The whitelist is taken LAZILY from ``team_kernel.EDITABLE_PROFILE_FIELDS`` so
    the CLI can never drift from the kernel's authoritative editable set. Every
    member is covered by ``_AGENT_SET_FIELD_TYPES`` (asserted in tests).
    """
    from superclaw.team_kernel import EDITABLE_PROFILE_FIELDS

    patch: dict[str, Any] = {}
    for token in pairs:
        if "=" not in token:
            _fail(f"--set expects key=value, got: {token!r}")
        key, _, raw = token.partition("=")
        if not key:
            _fail(f"--set key must be non-empty, got: {token!r}")
        if key not in EDITABLE_PROFILE_FIELDS:
            _fail(
                f"--set {key}: not an editable agent field "
                f"(one of {sorted(EDITABLE_PROFILE_FIELDS)})"
            )
        kind = _AGENT_SET_FIELD_TYPES[key]
        if kind == "int":
            try:
                patch[key] = int(raw)
            except ValueError:
                _fail(f"--set {key} expects an integer, got: {raw!r}")
        elif kind == "csv":
            patch[key] = _split_csv(raw)
        elif kind == "json":
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                _fail(f"--set {key} expects a JSON object, got: {raw!r}")
            if not isinstance(parsed, dict):
                _fail(f"--set {key} expects a JSON object, got: {raw!r}")
            patch[key] = parsed
        else:  # "str"
            patch[key] = raw
    return patch


# --- marketplace (ClawHunt participation): the governed CLI surface ----------
# Every command below dispatches through the ONE
# ``marketplace_handler.execute_marketplace_command`` (the same entry the API and
# chat tool projection use — zero drift). Reads run straight through (LOW); every
# write is HIGH → pending approval the operator confirms via
# ``superclaw approve grant``. The CLI is the operator (admin over their own
# companies); authority is server-injected, never read from a command body.

_MARKETPLACE_HOME_COMPANY = "local"


def _run_marketplace_command(command: Any, *, actor_company_id: str) -> None:
    """Dispatch a marketplace command through the shared handler and render it.

    Mirrors ``_run_company_command``: injects the operator scope, calls the one
    handler, and maps outcomes / typed errors onto the CLI's JSON-or-``_fail``
    convention. ``MarketplaceAuthError`` (no connected agent key) is surfaced as a
    clear "connect ClawHunt first" failure, distinct from a scope/validation error.
    """
    from superclaw.company_lifecycle import CompanyFrozenError
    from superclaw.company_scope import CompanyScopeError
    from superclaw.marketplace_handler import (
        MarketplaceAuthError,
        execute_marketplace_command,
    )

    store = _team_store()
    try:
        result = execute_marketplace_command(
            command,
            scope=_cli_operator_scope(actor_company_id),
            store=store,
            requested_by=_CLI_OPERATOR_PRINCIPAL,
        )
    except MarketplaceAuthError as exc:
        _fail(f"ClawHunt not connected: {exc}")
    except CompanyScopeError as exc:
        _fail(f"out of scope: {exc.reason}")
    except CompanyFrozenError as exc:
        _fail(str(exc))
    except KeyError as exc:
        _fail(f"unknown id: {exc.args[0] if exc.args else exc}")
    except ValueError as exc:
        _fail(str(exc))

    if result.outcome == "pending_approval":
        approval_id = result.detail.get("approval_id")
        _emit_json(
            {
                "outcome": result.outcome,
                "risk": result.verdict.tier,
                "approval_id": approval_id,
                "detail": result.detail,
                "hint": (
                    f"marketplace write needs confirmation: approve with "
                    f"`superclaw approve grant {approval_id}` "
                    f"(or in the Web approvals inbox). The remote ClawHunt action "
                    f"runs only on grant — payment never on the default path."
                ),
            }
        )
        return
    _emit_json(
        {"outcome": result.outcome, "risk": result.verdict.tier, "detail": result.detail}
    )


@marketplace_app.command("browse")
def marketplace_browse_cmd(
    status: str | None = typer.Option(None, "--status", help="Filter by problem status, e.g. open."),
    skip: int = typer.Option(0, "--skip", min=0),
    limit: int = typer.Option(20, "--limit", min=1, max=50),
) -> None:
    """Browse the marketplace through the governed path (needs a connected agent key)."""
    from superclaw.marketplace_commands import MarketplaceBrowseCommand

    _run_marketplace_command(
        MarketplaceBrowseCommand(status=(status.strip() if status else None), skip=skip, limit=limit),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("inspect")
def marketplace_inspect_cmd(problem_id: str) -> None:
    """Inspect one marketplace order (agent-gated detail; needs a connected key)."""
    from superclaw.marketplace_commands import MarketplaceInspectCommand

    _run_marketplace_command(
        MarketplaceInspectCommand(problem_id=problem_id),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("post")
def marketplace_post_cmd(
    title: str = typer.Option(..., "--title"),
    description: str = typer.Option(..., "--description"),
    price: int = typer.Option(1, "--price"),
    category: str = typer.Option("testing", "--category"),
    difficulty: str = typer.Option("easy", "--difficulty"),
    routing_mode: str = typer.Option("tiered_overflow", "--routing-mode"),
    target_agent_id: str | None = typer.Option(None, "--target-agent-id"),
) -> None:
    """Publish a task to the marketplace (HIGH → pending approval)."""
    from superclaw.marketplace_commands import MarketplacePostTaskCommand

    _run_marketplace_command(
        MarketplacePostTaskCommand(
            title=title, description=description, price=price, category=category,
            difficulty=difficulty, routing_mode=routing_mode, target_agent_id=target_agent_id,
        ),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("bid")
def marketplace_bid_cmd(
    problem_id: str,
    amount: int | None = typer.Option(None, "--amount"),
    message: str = typer.Option("", "--message"),
) -> None:
    """Bid on a marketplace order (HIGH → pending approval)."""
    from superclaw.marketplace_commands import MarketplaceBidCommand

    _run_marketplace_command(
        MarketplaceBidCommand(problem_id=problem_id, amount=amount, message=message),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("claim")
def marketplace_claim_cmd(
    problem_id: str,
    company: str = typer.Option(..., "--company", help="Company that will own the delivery."),
) -> None:
    """Claim a marketplace order, binding it to a delivery company (HIGH → pending approval)."""
    from superclaw.marketplace_commands import MarketplaceClaimCommand

    _run_marketplace_command(
        MarketplaceClaimCommand(problem_id=problem_id, company_profile_id=company),
        actor_company_id=company,
    )


@marketplace_app.command("submit")
def marketplace_submit_cmd(
    order_id: str,
    solution: str | None = typer.Option(None, "--solution", help="Optional solution text override."),
) -> None:
    """Submit a delivered order's evidence to ClawHunt (HIGH → pending approval)."""
    from superclaw.marketplace_commands import MarketplaceSubmitCommand

    _run_marketplace_command(
        MarketplaceSubmitCommand(order_id=order_id, solution_text=solution),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("abandon")
def marketplace_abandon_cmd(
    order_id: str,
    reason: str | None = typer.Option(None, "--reason"),
) -> None:
    """Abandon a claimed order, releasing the remote commitment (HIGH → pending approval)."""
    from superclaw.marketplace_commands import MarketplaceAbandonCommand

    _run_marketplace_command(
        MarketplaceAbandonCommand(order_id=order_id, reason=reason),
        actor_company_id=_MARKETPLACE_HOME_COMPANY,
    )


@marketplace_app.command("orders")
def marketplace_orders_cmd(
    status: str | None = typer.Option(None, "--status", help="Filter by saga status."),
    company: str | None = typer.Option(None, "--company", help="Filter by owning company."),
) -> None:
    """List marketplace order ledger rows (the claim → deliver → submit saga)."""
    store = _team_store()
    orders = store.list_marketplace_orders(status=status, company_profile_id=company)
    _emit_json(
        {
            "count": len(orders),
            "orders": [
                {
                    "order_id": o.order_id,
                    "problem_id": o.problem_id,
                    "company_profile_id": o.company_profile_id,
                    "status": o.status,
                    "issue_id": o.issue_id,
                    "run_id": o.run_id,
                    "last_error": o.last_error,
                }
                for o in orders
            ],
        }
    )


@marketplace_app.command("order")
def marketplace_order_cmd(order_id: str) -> None:
    """Show one marketplace order ledger row."""
    store = _team_store()
    try:
        order = store.get_marketplace_order(order_id)
    except KeyError:
        _fail(f"unknown order: {order_id}")
    _emit_json(order.to_dict())


@marketplace_app.command("advance")
def marketplace_advance_cmd(
    order_id: str,
    repo: Path = typer.Option(Path("."), "--repo", help="Repo path for the delivery run."),
    backend: str = typer.Option("claude", "--backend"),
    budget_seconds: int = typer.Option(60, "--budget-seconds", min=1),
) -> None:
    """Drive a claimed order's saga forward (build delivery issue → run → completion gate).

    Idempotent: advances through every phase whose precondition is met right now.
    The delivery run executes SYNCHRONOUSLY within this command (checkout → run →
    verify), so a single invocation typically drives claimed_remote → issue_bound →
    run_started → review_pending (the run completes and the completion gate opens
    inline). Then accept the issue-completion approval and re-run advance to reach
    ready_to_submit; finally `superclaw marketplace submit <order_id>`.
    """
    from superclaw.marketplace_saga import advance_marketplace_order

    store = _team_store()
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        store.get_marketplace_order(order_id)
    except KeyError:
        _fail(f"unknown order: {order_id}")
    # Drive forward until the status stops changing (bounded). The delivery run is
    # synchronous (run_goal), so one invocation usually walks claimed_remote →
    # review_pending; progress then waits on the human issue-completion approval.
    seen: set[str] = set()
    order = None
    for _ in range(8):
        order = advance_marketplace_order(
            store, order_id, orchestrator=orchestrator,
            requested_by=_CLI_OPERATOR_PRINCIPAL, repo_path=str(repo),
            backend_policy=backend, budget_seconds=budget_seconds,
        )
        if order.status in seen:
            break
        seen.add(order.status)
    _emit_json(
        {
            "order_id": order.order_id,
            "status": order.status,
            "issue_id": order.issue_id,
            "run_id": order.run_id,
            "last_error": order.last_error,
            "hint": _marketplace_advance_hint(order.status),
        }
    )


def _marketplace_advance_hint(status: str) -> str:
    # Single source shared with the API (`/api/marketplace/orders/advance`) so the
    # two surfaces never drift on the operator's next-step guidance.
    from superclaw.marketplace_saga import advance_hint

    return advance_hint(status)


@company_app.command("create")
def company_create_cmd(
    name: str = typer.Option(..., "--name", help="Display name for the new company"),
    goal: str | None = typer.Option(None, "--goal"),
    owner_id: str | None = typer.Option(
        None,
        "--owner-id",
        help="Recorded for reference; the company's owner is the acting operator regardless (authority is server-injected).",
    ),
    budget_seconds: int | None = typer.Option(None, "--budget-seconds", min=0),
    token_budget: int | None = typer.Option(None, "--token-budget", min=0),
    allowed_plugins: str | None = typer.Option(
        None, "--allowed-plugins", help="Comma-separated plugin ids the company may equip."
    ),
) -> None:
    """Create a company through the shared company-management handler.

    Distinct from ``company init`` (which also binds a workspace): this routes the
    CLI through the SAME ``execute_company_command`` path the chat/API surfaces
    use, so the create semantics can never drift across surfaces.
    """
    from superclaw.company_commands import CompanyCreateCommand

    command = CompanyCreateCommand(
        name=name,
        goal=goal,
        owner_id=owner_id,
        default_budget_seconds=budget_seconds,
        default_token_budget=token_budget,
        allowed_plugins=_split_csv(allowed_plugins),
    )
    # Create has no existing target; it lands in the operator's home company.
    _run_company_command(command, actor_company_id="local")


@company_app.command("update")
def company_update_cmd(
    company_id: str = typer.Option(..., "--company-id"),
    name: str | None = typer.Option(None, "--name"),
    goal: str | None = typer.Option(None, "--goal"),
    owner_id: str | None = typer.Option(None, "--owner-id"),
    budget_seconds: int | None = typer.Option(None, "--budget-seconds", min=0),
    token_budget: int | None = typer.Option(None, "--token-budget", min=0),
    allowed_plugins: str | None = typer.Option(
        None, "--allowed-plugins", help="Comma-separated plugin ids (replaces the set)."
    ),
) -> None:
    """Patch a company profile (reversible → runs straight through)."""
    from superclaw.company_commands import CompanyUpdateCommand

    command = CompanyUpdateCommand(
        company_profile_id=company_id,
        name=name,
        goal=goal,
        owner_id=owner_id,
        default_budget_seconds=budget_seconds,
        default_token_budget=token_budget,
        allowed_plugins=(
            _split_csv(allowed_plugins) if allowed_plugins is not None else None
        ),
    )
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("archive")
def company_archive_cmd(
    company_id: str = typer.Option(..., "--company-id"),
    reason: str | None = typer.Option(None, "--reason"),
) -> None:
    """Archive (dissolve) a company — IRREVERSIBLE, so it opens a confirmation.

    Archive is the one HIGH-risk company command: the handler freezes the company
    and records a PENDING approval rather than dissolving it outright. Confirm
    with ``superclaw approve grant <approval_id>`` (or reject to restore it).
    """
    from superclaw.company_commands import CompanyArchiveCommand

    command = CompanyArchiveCommand(company_profile_id=company_id, reason=reason)
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("hire")
def company_hire_cmd(
    name: str = typer.Option(..., "--name", help="Display name for the agent role"),
    role: str = typer.Option(..., "--role", help="Role, e.g. engineer / reviewer / pm"),
    title: str | None = typer.Option(None, "--title"),
    company_id: str = typer.Option("local", "--company-id", help="Company the role belongs to"),
    workspace_id: str | None = typer.Option(None, "--workspace-id"),
    backend: str | None = typer.Option(None, "--backend", help="Backend policy for this role's runs"),
    model: str | None = typer.Option(None, "--model", help="Preferred model (rides the governed model_override channel)"),
    effort: str | None = typer.Option(None, "--effort", help="Preferred reasoning-effort / thinking level (rides the governed effort_override channel; effort-capable backends only)"),
    reports_to: str | None = typer.Option(None, "--reports-to", help="Manager profile id"),
    charter: str | None = typer.Option(None, "--charter", help="Behavior contract text"),
    persona: str | None = typer.Option(None, "--persona"),
    budget_seconds: int | None = typer.Option(None, "--budget-seconds", min=0),
    token_budget: int | None = typer.Option(None, "--token-budget", min=0),
    context_mode: str | None = typer.Option(None, "--context-mode", help="thin | fat"),
    plugin: list[str] = typer.Option([], "--plugin", help="Plugin id to equip (repeatable)."),
    skill: list[str] = typer.Option([], "--skill", help="Governed skill id to equip (repeatable)."),
) -> None:
    """Hire (create) an agent role through the shared handler.

    The ``spec`` mirrors ``team_kernel._HIRE_SPEC_FIELDS``; only fields the
    operator actually set are included, so unset fields fall back to the kernel's
    own defaults rather than being pinned to a CLI-chosen value.
    """
    from superclaw.company_commands import HireAgentCommand

    # Build the spec from only the options the operator set — an absent option
    # leaves the kernel's default in force (single source of defaults).
    spec: dict[str, Any] = {"name": name, "role": role, "company_profile_id": company_id}
    for key, value in (
        ("title", title),
        ("workspace_id", workspace_id),
        ("backend_policy", backend),
        ("model", model),
        ("effort", effort),
        ("reports_to", reports_to),
        ("charter", charter),
        ("persona", persona),
        ("budget_seconds", budget_seconds),
        ("token_budget", token_budget),
        ("context_mode", context_mode),
    ):
        if value is not None:
            spec[key] = value
    if plugin:
        spec["plugin_allowlist"] = list(plugin)
    if skill:
        spec["skill_allowlist"] = list(skill)

    command = HireAgentCommand(spec=spec)
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("update-agent")
def company_update_agent_cmd(
    profile_id: str = typer.Option(..., "--profile-id"),
    company_id: str = typer.Option(
        "local",
        "--company-id",
        help="Company the target agent belongs to (scope/same-origin anchor).",
    ),
    set_: list[str] = typer.Option(
        [],
        "--set",
        help="Field to patch as key=value (repeatable). Keys must be in the kernel's editable-field whitelist.",
    ),
) -> None:
    """Patch an existing agent role (reversible → runs straight through).

    ``--set k=v`` builds the patch; the kernel's editable-field whitelist and the
    command's ``validate()`` are the authority on which fields/shapes are allowed
    (an out-of-whitelist or empty patch fails closed with a clear message).
    """
    from superclaw.company_commands import UpdateAgentCommand

    patch = _parse_agent_set_pairs(set_)
    command = UpdateAgentCommand(profile_id=profile_id, patch=patch)
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("create-issue")
def company_create_issue_cmd(
    title: str = typer.Option(..., "--title"),
    description: str | None = typer.Option(None, "--description"),
    kind: str | None = typer.Option(None, "--kind", help=" | ".join(sorted(ISSUE_KINDS))),
    review_policy: str | None = typer.Option(
        None, "--review-policy", help=" | ".join(sorted(REVIEW_POLICIES))
    ),
    company_id: str = typer.Option(
        "local", "--company-id", help="Home company when no workspace is named."
    ),
    workspace_id: str | None = typer.Option(None, "--workspace-id"),
    assignee: str | None = typer.Option(
        None, "--assignee", help="Agent profile id to assign on creation."
    ),
) -> None:
    """Create an issue through the shared handler."""
    from superclaw.company_commands import CreateIssueCommand

    command = CreateIssueCommand(
        title=title,
        description=description,
        kind=kind,
        review_policy=review_policy,
        workspace_id=workspace_id,
        assignee_agent_profile_id=assignee,
    )
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("assign-issue")
def company_assign_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    profile_id: str = typer.Option(..., "--profile-id", help="Assignee agent profile id"),
    company_id: str = typer.Option(
        "local", "--company-id", help="Company the issue/agent belong to (scope anchor)."
    ),
) -> None:
    """Assign an issue to an agent through the shared handler."""
    from superclaw.company_commands import AssignIssueCommand

    command = AssignIssueCommand(issue_id=issue_id, profile_id=profile_id)
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("delegate-issue")
def company_delegate_issue_cmd(
    parent_id: str = typer.Option(..., "--parent-id", help="Parent issue to delegate under"),
    assignee: str = typer.Option(..., "--assignee", help="Assignee agent profile id"),
    title: str = typer.Option(..., "--title"),
    description: str | None = typer.Option(None, "--description"),
    priority: str | None = typer.Option(None, "--priority"),
    origin_run_id: str | None = typer.Option(
        None, "--origin-run-id", help="Run that initiated this delegation (audit provenance)."
    ),
    company_id: str = typer.Option(
        "local", "--company-id", help="Company the parent issue/assignee belong to (scope anchor)."
    ),
) -> None:
    """Delegate a child issue under a parent through the shared handler."""
    from superclaw.company_commands import DelegateIssueCommand

    command = DelegateIssueCommand(
        parent_id=parent_id,
        assignee_agent_profile_id=assignee,
        title=title,
        description=description,
        priority=priority,
        origin_run_id=origin_run_id,
    )
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("comment")
def company_comment_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    body: str = typer.Option(..., "--body", help="Comment text (@mentions wake the named agent)."),
    company_id: str = typer.Option(
        "local", "--company-id", help="Company the issue belongs to (scope anchor)."
    ),
) -> None:
    """Post a comment on an issue's thread through the shared handler.

    Operator-authored from the CLI: the handler injects the author identity from
    the acting scope (operator → user), never from the command body.
    """
    from superclaw.company_commands import PostIssueCommentCommand

    command = PostIssueCommentCommand(issue_id=issue_id, body=body)
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("attach-work-product")
def company_attach_work_product_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    type: str = typer.Option(..., "--type", help="Work-product type (closed enum)."),
    title: str = typer.Option("", "--title"),
    url: str | None = typer.Option(None, "--url"),
    provider: str = typer.Option("local", "--provider"),
    external_id: str | None = typer.Option(None, "--external-id"),
    status: str | None = typer.Option(None, "--status", help="Work-product status (closed enum)."),
    summary: str = typer.Option("", "--summary"),
    is_primary: bool = typer.Option(False, "--primary", help="Mark as the issue's primary delivery fact."),
    company_id: str = typer.Option(
        "local", "--company-id", help="Company the issue belongs to (scope anchor)."
    ),
) -> None:
    """Attach a delivery fact (PR / commit / preview / …) to an issue (audit-only)."""
    from superclaw.company_commands import AttachWorkProductCommand

    command = AttachWorkProductCommand(
        issue_id=issue_id,
        type=type,
        title=title,
        url=url,
        provider=provider,
        external_id=external_id,
        status=status,
        summary=summary,
        is_primary=is_primary,
    )
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("submit-review")
def company_submit_review_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    expected_checkout_run_id: str | None = typer.Option(
        None,
        "--expected-checkout-run-id",
        help="The run id holding this issue's checkout; the submit is bound to it "
        "so a stale/foreign-run submission is refused. Optional for the operator "
        "(force-submit); a confined agent MUST supply it.",
    ),
    summary: str = typer.Option("", "--summary"),
    company_id: str = typer.Option(
        "local", "--company-id", help="Company the issue belongs to (scope anchor)."
    ),
) -> None:
    """Submit an in-progress issue for review through the shared handler.

    The CLI is the OPERATOR (admin scope), so ``--expected-checkout-run-id`` is
    optional here — the operator may force-submit (the kernel treats an absent run
    id as "do not bind"). A CONFINED agent driving the SAME command via the chat /
    MCP surface MUST supply it (the autonomy门 refuses an agent submit without it).
    """
    from superclaw.company_commands import SubmitReviewCommand

    command = SubmitReviewCommand(
        issue_id=issue_id,
        expected_checkout_run_id=expected_checkout_run_id,
        summary=summary,
    )
    _run_company_command(command, actor_company_id=company_id)


@company_app.command("update-work-product")
def company_update_work_product_cmd(
    work_product_id: str = typer.Option(..., "--work-product-id"),
    status: str | None = typer.Option(None, "--status", help="New status (closed enum)."),
    title: str | None = typer.Option(None, "--title"),
    url: str | None = typer.Option(None, "--url"),
    summary: str | None = typer.Option(None, "--summary"),
    is_primary: bool | None = typer.Option(None, "--primary/--no-primary", help="Mark/unmark as primary delivery fact."),
    company_id: str = typer.Option("local", "--company-id", help="Company the work product belongs to (scope anchor)."),
) -> None:
    """Patch a delivery fact's mutable fields (reversible)."""
    from superclaw.company_commands import UpdateWorkProductCommand

    _run_company_command(
        UpdateWorkProductCommand(
            work_product_id=work_product_id, status=status, title=title, url=url,
            summary=summary, is_primary=is_primary,
        ),
        actor_company_id=company_id,
    )


@company_app.command("set-charter")
def company_set_charter_cmd(
    profile_id: str = typer.Option(..., "--profile-id"),
    charter: str = typer.Option(..., "--charter", help="The role's behavior contract."),
    company_id: str = typer.Option("local", "--company-id", help="Company the agent belongs to (scope anchor)."),
) -> None:
    """Set an agent's behavioral charter (revisioned path; charter only — use
    update-agent for persona).

    Routed through the SAME execute_company_command handler as the chat
    ``agent_charter`` tool (one governed path)."""
    from superclaw.company_commands import UpdateAgentCharterCommand

    _run_company_command(
        UpdateAgentCharterCommand(profile_id=profile_id, charter=charter),
        actor_company_id=company_id,
    )


# --- P2 issue-lifecycle commands (three-surface parity with the chat tools) ----
# Routed through the SAME execute_company_command choke point as the chat /
# MCP / REST-commands surfaces (NOT the legacy direct ``superclaw issue ...``
# kernel routes), so the governance (scope / lifecycle / autonomy / risk) is
# identical across surfaces — zero divergence (铁律 2/3).


@company_app.command("block-issue")
def company_block_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    reason: str = typer.Option(..., "--reason", help="Why the issue is blocked."),
    unblock_owner: str | None = typer.Option(None, "--unblock-owner", help="Agent who should unblock it."),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Mark an issue blocked (reversible: company unblock-issue clears it)."""
    from superclaw.company_commands import BlockIssueCommand

    _run_company_command(
        BlockIssueCommand(issue_id=issue_id, reason=reason, unblock_owner=unblock_owner),
        actor_company_id=company_id,
    )


@company_app.command("unblock-issue")
def company_unblock_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    note: str | None = typer.Option(None, "--note"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Clear an issue's blocked state."""
    from superclaw.company_commands import UnblockIssueCommand

    _run_company_command(
        UnblockIssueCommand(issue_id=issue_id, note=note), actor_company_id=company_id
    )


@company_app.command("hold-issue")
def company_hold_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    reason: str | None = typer.Option(None, "--reason"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Pause a single issue with a hold (reversible: company unhold-issue releases it)."""
    from superclaw.company_commands import HoldIssueCommand

    _run_company_command(
        HoldIssueCommand(issue_id=issue_id, reason=reason), actor_company_id=company_id
    )


@company_app.command("unhold-issue")
def company_unhold_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Release a single issue's active hold."""
    from superclaw.company_commands import UnholdIssueCommand

    _run_company_command(UnholdIssueCommand(issue_id=issue_id), actor_company_id=company_id)


@company_app.command("author-routine")
def company_author_routine_cmd(
    spec_json: str = typer.Option(..., "--spec-json", help="The routine spec as a JSON object."),
    company_id: str = typer.Option("local", "--company-id", help="Company the routine belongs to (scope anchor)."),
) -> None:
    """Author a recurring routine schedule for a company (from a JSON spec).

    Routed through the SAME execute_company_command handler as the chat
    ``routine_author`` tool. A spec that needs governance approval is refused —
    use the dedicated routine-approval flow for those."""
    import json

    from superclaw.company_commands import AuthorRoutineCommand

    try:
        spec = json.loads(spec_json)
    except json.JSONDecodeError as exc:
        _fail(f"--spec-json is not valid JSON: {exc}")
    _run_company_command(AuthorRoutineCommand(spec=spec), actor_company_id=company_id)


@company_app.command("requeue-issue")
def company_requeue_issue_cmd(
    issue_id: str = typer.Option(..., "--issue-id"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Recover a stuck issue: cancel its live run (if any) and return it to the queue."""
    from superclaw.company_commands import RequeueIssueCommand

    _run_company_command(RequeueIssueCommand(issue_id=issue_id), actor_company_id=company_id)


@company_app.command("pause-issue-tree")
def company_pause_issue_tree_cmd(
    issue_id: str = typer.Option(..., "--issue-id", help="Root issue id of the subtree."),
    reason: str | None = typer.Option(None, "--reason"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Pause a whole issue subtree (cancels active runs in it). Reversible."""
    from superclaw.company_commands import PauseIssueTreeCommand

    _run_company_command(
        PauseIssueTreeCommand(issue_id=issue_id, reason=reason), actor_company_id=company_id
    )


@company_app.command("resume-issue-tree")
def company_resume_issue_tree_cmd(
    issue_id: str = typer.Option(..., "--issue-id", help="Root issue id of the subtree."),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Resume a paused issue subtree."""
    from superclaw.company_commands import ResumeIssueTreeCommand

    _run_company_command(ResumeIssueTreeCommand(issue_id=issue_id), actor_company_id=company_id)


@company_app.command("cancel-issue-tree")
def company_cancel_issue_tree_cmd(
    issue_id: str = typer.Option(..., "--issue-id", help="Root issue id of the subtree."),
    reason: str | None = typer.Option(None, "--reason"),
    company_id: str = typer.Option("local", "--company-id", help="Company the issue belongs to (scope anchor)."),
) -> None:
    """Cancel a whole issue subtree — IRREVERSIBLE (pauses for human confirmation)."""
    from superclaw.company_commands import CancelIssueTreeCommand

    _run_company_command(
        CancelIssueTreeCommand(issue_id=issue_id, reason=reason), actor_company_id=company_id
    )


@company_app.command("export")
def company_export(
    company_profile_id: str = typer.Argument(...),
    out: Path = typer.Option(..., "--out", help="Directory (or .zip path with --zip) to write the export bundle into."),
    include: list[str] = typer.Option(
        [], "--include", help="Extra content: 'issues' and/or 'work-products' (documentation-only)."
    ),
    revision: str | None = typer.Option(None, "--revision", help="Package revision (defaults to metadata['version'] or 1.0.0)."),
    zip_bundle: bool = typer.Option(False, "--zip", help="Write a single .zip instead of a directory."),
    force: bool = typer.Option(False, "--force", help="Overwrite an existing non-empty output target."),
) -> None:
    """Export a company to a portable, re-importable markdown bundle (company-as-code).

    Writes COMPANY.md / agents/<role>/AGENTS.md / manifest.json / .superclaw.yaml /
    README.md (and issues/ with --include issues). The manifest round-trips through
    `superclaw team bootstrap`. Export warnings are printed in the JSON summary —
    they are deliberately NEVER written into a bundle file (a warning can echo a
    dropped local path), so only ``bundle.files`` reach disk.
    """
    from superclaw.company_export import CompanyExportError, build_company_export

    include_issues = "issues" in include
    include_work_products = "work-products" in include or "work_products" in include
    store = _team_store()
    try:
        bundle = build_company_export(
            store,
            company_profile_id,
            include_issues=include_issues,
            include_work_products=include_work_products,
            revision=revision,
        )
    except CompanyExportError as exc:
        _fail(str(exc))

    written = _write_export_bundle(bundle.files, out, zip_bundle=zip_bundle, force=force)
    # Emit the ONE shared surface projection (no hand-rolled shape that could fork
    # from the API/Web output) plus the CLI-only write facts. include_files=False:
    # the bodies are on disk, the summary carries only the file_tree.
    payload = bundle.surface_payload(include_files=False)
    payload.update({"out": str(out), "format": "zip" if zip_bundle else "directory", "written": written})
    _emit_json(payload)


def _assert_safe_bundle_path(rel: str) -> None:
    """Reject any bundle path that is not a clean POSIX-relative path — the
    explicit second line of defense a writing surface owns, on top of the
    exporter's slug sanitization. Shares the SINGLE predicate with the API zip
    surface (``superclaw.company_export.is_safe_bundle_path``)."""
    from superclaw.company_export import is_safe_bundle_path

    if not is_safe_bundle_path(rel):
        _fail(f"refusing to write unsafe bundle path: {rel!r}")


def _write_export_bundle(
    files: dict[str, str], out: Path, *, zip_bundle: bool, force: bool
) -> int:
    """Write an export bundle's ``path -> text`` map to ``out`` (dir or .zip).

    Only ``files`` are written — never warnings or any other operator-facing
    metadata. Every relative path is re-validated (defense in depth) so a bundle
    can never escape ``out``. Overwrite is fail-closed and symlink-refusing; a
    forced directory overwrite is a CLEAN replace (stale files removed), not an
    overlay that would leave foreign files inside a shareable bundle.
    """
    import shutil

    for rel in files:
        _assert_safe_bundle_path(rel)

    if zip_bundle:
        import zipfile

        if out.suffix == ".zip":
            target = out
        else:
            # --out is a container directory to drop export.zip into. An existing
            # NON-directory target is fail-closed (no mkdir-on-a-file crash), and a
            # symlinked container dir is refused (no writing through a symlink).
            if out.is_symlink():
                _fail(f"refusing to write through a symlink: {out}")
            if out.exists() and not out.is_dir():
                _fail(f"{out} exists and is not a directory; pass a .zip path or a directory")
            target = out / "export.zip"
        if target.is_symlink():
            _fail(f"refusing to overwrite a symlink: {target}")
        if target.exists():
            if not force:
                _fail(f"{target} already exists (use --force to overwrite)")
            if not target.is_file():
                _fail(f"{target} exists and is not a regular file")
        # The container of an explicit .zip path may be a file or a symlink — check
        # the nearest existing ancestor before mkdir (no mkdir-on-a-file crash, no
        # writing through a symlinked parent).
        _assert_writable_container(target)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for rel, content in sorted(files.items()):
                    zf.writestr(rel, content)
        except OSError as exc:  # belt-and-suspenders: any fs edge → fail-closed
            _fail(f"failed to write {target}: {exc}")
        return len(files)

    # Directory mode.
    if out.is_symlink():
        _fail(f"refusing to write through a symlink: {out}")
    if out.exists() and not out.is_dir():
        _fail(f"{out} exists and is not a directory")
    try:
        non_empty = out.is_dir() and any(out.iterdir())
    except OSError as exc:  # unreadable dir → fail-closed, not a traceback
        _fail(f"cannot read output directory {out}: {exc}")
    if non_empty:
        if not force:
            _fail(f"{out} exists and is not empty (use --force to overwrite)")
        # A forced overwrite must NOT blindly rmtree an arbitrary directory — that
        # turns `--out . --force` into "wipe the cwd". Only a directory that is our
        # OWN prior export (and not a sensitive/ancestor path) is clean-replaced.
        _assert_safe_overwrite_dir(out)
        try:
            shutil.rmtree(out)
        except OSError as exc:  # locked file / permission denied → fail-closed
            _fail(f"failed to clear prior export {out}: {exc}")

    _assert_writable_container(out)
    out_root = out.resolve()
    try:
        out_root.mkdir(parents=True, exist_ok=True)
        for rel, content in sorted(files.items()):
            dest = (out_root / rel).resolve()
            if out_root not in dest.parents and dest != out_root:
                _fail(f"refusing to write outside {out_root}: {rel!r}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
    except OSError as exc:  # belt-and-suspenders: any fs edge → fail-closed
        _fail(f"failed to write into {out_root}: {exc}")
    return len(files)


def _assert_writable_container(target: Path) -> None:
    """Fail-closed if the nearest EXISTING ancestor of ``target`` is not a real
    directory (e.g. ``--out /tmp/afile/export.zip`` where ``/tmp/afile`` is a
    file) — closes the mkdir-on-a-file crash.

    It does NOT reject symlinks in the path: following a symlinked PARENT is the
    expected, correct behaviour for a user-chosen ``--out`` (on macOS ``/tmp``
    itself is a symlink to ``/private/tmp``, so rejecting symlinked ancestors
    would break the common ``--out /tmp/export`` case). Escape is prevented where
    it matters — the BUNDLE's own relative paths are clamped to ``out.resolve()``
    by the dest-containment check, and ``--force`` refuses to rmtree a symlinked
    ``out`` itself."""
    ancestor = target.parent
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    if ancestor.exists() and not ancestor.is_dir():
        _fail(f"{ancestor} is not a directory; cannot write under it")


def _looks_like_export_manifest(path: Path) -> bool:
    """True only for a real SuperClaw company-export ``manifest.json``.

    Beyond structural checks (schema + non-empty roles + company + workspace +
    source prefix), it requires the recorded ``digest`` to be a 64-hex sha256 that
    MATCHES the digest recomputed from the manifest's own payload — so the
    manifest is internally self-consistent the way the exporter produces it. A
    random or hand-stubbed look-alike will not satisfy this, so a destructive
    ``--force`` never clean-replaces a directory that is not genuinely a prior
    export. A symlinked ``manifest.json`` is refused outright (don't trust a file
    pointed elsewhere)."""
    import re as _re

    from superclaw.company_export import manifest_self_digest

    if path.is_symlink() or not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    metadata = data.get("metadata")
    roles = data.get("roles")
    if not (
        data.get("schema") == "agentcompanies/v1"
        and isinstance(roles, list)
        and len(roles) > 0
        and isinstance(data.get("company"), dict)
        and isinstance(data.get("workspace"), dict)
        and isinstance(metadata, dict)
        and str(metadata.get("source", "")).startswith("superclaw:company:")
    ):
        return False
    recorded = str(metadata.get("digest", ""))
    if not _re.fullmatch(r"[0-9a-f]{64}", recorded):
        return False
    return manifest_self_digest(data) == recorded


def _assert_safe_overwrite_dir(out: Path) -> None:
    """Guard a forced ``rmtree`` so it can never destroy something it shouldn't.

    Refuses sensitive roots (``/``, ``$HOME``, the cwd) and any ancestor of the
    cwd, and requires the directory to be a PRIOR SuperClaw EXPORT (a structurally
    valid ``manifest.json``, not merely a file by that name). So ``--force`` only
    ever clean-replaces a directory this command itself produced — never an
    arbitrary folder that happens to contain a ``manifest.json``."""
    resolved = out.resolve()
    cwd = Path.cwd().resolve()
    sensitive = {Path("/"), Path(resolved.anchor), Path.home().resolve(), cwd}
    if resolved in sensitive or resolved in cwd.parents:
        _fail(f"refusing to force-overwrite a sensitive directory: {resolved}")
    if not _looks_like_export_manifest(resolved / "manifest.json"):
        _fail(
            f"{out} is not empty and is not a prior SuperClaw export; "
            f"choose a fresh directory or clear it manually"
        )


@company_template_app.command("validate")
def company_template_validate(
    path: str = typer.Argument(..., help="directory or .sccompany file"),
    verify_signature: bool = typer.Option(
        False, "--verify-signature", help="also check integrity digest + signature trust + revocation"
    ),
) -> None:
    """Validate a company template against the schema + relational contract (roles
    unique, equipment references roles, reports_to acyclic). With --verify-signature
    also runs the full trust chain (digest/signature/revocation). fail-closed."""
    from superclaw.company_template import (
        CompanyTemplateError,
        load_company_template,
        validate_company_template_contract,
        verify_company_template,
    )

    target = Path(path)
    try:
        if verify_signature:
            template, trust_class = verify_company_template(target)
            try:
                payload = {
                    "valid": True,
                    "signature_checked": True,
                    "trust_class": trust_class,
                    # honest: only a root-key verification is a real signature check;
                    # local_dev_trust merely ADMITTED an unverifiable artifact.
                    "signature_verified": trust_class == "official",
                    "id": template.artifact_id, "version": template.version, "kind": template.kind,
                    "roles": template.role_names,
                }
            finally:
                template.cleanup()
        else:
            template = load_company_template(target)
            try:
                validate_company_template_contract(template.manifest)
                payload = {
                    "valid": True, "signature_checked": False,
                    "id": template.artifact_id, "version": template.version, "kind": template.kind,
                    "roles": template.role_names,
                }
            finally:
                template.cleanup()
    except CompanyTemplateError as exc:
        _fail(str(exc))
    _emit_json(payload)


@workspace_app.command("create")
def workspace_create(
    name: str = typer.Argument(...),
    company: str = typer.Option("local", "--company"),
    repo_path: str = typer.Option(".", "--repo-path"),
    writable: list[str] = typer.Option(["."], "--writable", help="Writable path (repeatable)"),
    network_policy: str = typer.Option("restricted", "--network-policy", help="restricted | none | open"),
    concurrency: str = typer.Option("serial", "--concurrency", help="serial | per_issue (per_issue requires a git repo: execution isolates via worktrees)"),
) -> None:
    """Create a workspace profile (execution boundary: repo/writable-paths/network)."""
    store = _team_store()
    try:
        team_kernel.validate_workspace_concurrency(repo_path, concurrency)
    except ValueError as exc:
        _fail(str(exc))
    workspace = WorkspaceProfile(
        name=name,
        company_profile_id=company,
        repo_path=repo_path,
        writable_paths=list(writable),
        network_policy=network_policy,
        concurrency=concurrency,
    )
    try:
        store.save_workspace_profile(workspace)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(workspace.to_dict())


@workspace_app.command("list")
def workspace_list(company: str | None = typer.Option(None, "--company")) -> None:
    """List workspace profiles, optionally scoped to a company."""
    store = _team_store()
    _emit_json([w.to_dict() for w in store.list_workspace_profiles(company_profile_id=company)])


@workspace_app.command("trust")
def workspace_trust(
    path: Path = typer.Argument(Path("."), help="Project directory to trust (repo root preferred)."),
    name: str | None = typer.Option(None, "--name"),
    company: str = typer.Option("local", "--company"),
    yes: bool = typer.Option(False, "--yes", help="Confirm trust without the interactive prompt (explicit authorization for scripts)."),
) -> None:
    """Trust a project directory and create its workspace (trust-as-creation).

    Idempotent: a directory whose repo identity already matches a registered
    workspace returns that workspace instead of creating a duplicate.
    """
    store = _team_store()
    existing = workspace_resolver.find_workspace_for_path(store, path)
    if existing is not None:
        if not existing.is_trusted:
            _fail(
                f"workspace {existing.workspace_id} already exists but is "
                f"{existing.trust_status}; resolve its trust state explicitly"
            )
        if company != "local" and existing.company_profile_id != company:
            _fail(
                f"workspace {existing.workspace_id} belongs to company "
                f"{existing.company_profile_id}, not {company}"
            )
        _emit_json({"workspace": existing.to_dict(), "created": False})
        return
    if not yes:
        if not sys.stdin.isatty():
            _fail(
                f"{workspace_resolver.WORKSPACE_TRUST_REQUIRED}: non-interactive trust needs "
                "an explicit --yes"
            )
        canonical = _safe_path_display(
            workspace_resolver.resolve_repo_identity(path)["canonical_path"]
        )
        typer.confirm(f"Trust {canonical} and create a workspace for it?", abort=True)
    try:
        created = workspace_resolver.create_trusted_workspace(
            store,
            path,
            name=name,
            trust_source="cli_flag" if yes else "cli_prompt",
            company_profile_id=company,
        )
    except (workspace_resolver.WorkspaceRootRejected, ValueError) as exc:
        _fail(str(exc))
    _emit_json({"workspace": created.to_dict(), "created": True})


@workspace_app.command("containment")
def workspace_containment(
    workspace_id: str = typer.Argument(..., help="Workspace to fence"),
    preset: str = typer.Argument(..., help="standard | low_trust_review"),
) -> None:
    """Set a workspace's runtime containment fence (T11).

    ``low_trust_review`` fences every run in the workspace to a read-only, no
    data-plane-egress, shallow-delegation posture for reviewing untrusted external
    code. Orthogonal to trust_status (which gates whether the workspace may host
    work at all). Remote/untrusted-source workspaces already floor to low-trust by
    risk; this is the explicit operator control."""
    from superclaw.containment import CONTAINMENT_PRESETS

    if preset not in CONTAINMENT_PRESETS:
        _fail(f"unknown containment preset: {preset!r} (choose: {', '.join(sorted(CONTAINMENT_PRESETS))})")
    store = _team_store()
    try:
        workspace = store.get_workspace_profile(workspace_id)
    except KeyError:
        _fail(f"unknown workspace: {workspace_id}")
    workspace.containment_preset = preset
    saved = store.save_workspace_profile(workspace)
    _emit_json({"workspace": saved.to_dict()})


@workspace_app.command("sessions")
def workspace_sessions(
    workspace_id: str = typer.Argument(..., help="Workspace id, or 'unassigned' for legacy sessions."),
    include_archived: bool = typer.Option(
        False, "--include-archived", "--all",
        help="Also list archived sessions (hidden by default). Archived sessions are never deleted; this is how you find them to unarchive.",
    ),
) -> None:
    """List the chat sessions grouped under one workspace."""
    store = _team_store()
    if workspace_id == "unassigned":
        sessions = store.list_chat_sessions(unassigned_only=True, include_archived=include_archived)
    else:
        try:
            store.get_workspace_profile(workspace_id)
        except KeyError:
            _fail(f"unknown workspace: {workspace_id}")
        sessions = store.list_chat_sessions(workspace_id=workspace_id, include_archived=include_archived)
    _emit_json(
        [
            {
                "session_id": item.session_id,
                "title": item.title,
                "updated_at": item.updated_at,
                "workspace_id": item.workspace_id,
                "archived": item.archived,
                "messages": len(item.messages),
            }
            for item in sessions
        ]
    )


@workspace_app.command("archive-session")
def workspace_archive_session(
    session_id: str = typer.Argument(..., help="Chat session id to archive (hidden from the default list, never deleted)."),
) -> None:
    """Archive a chat session — hide it from the default sidebar/list (reversible)."""
    store = _team_store()
    try:
        session = store.set_chat_session_archived(session_id, True)
    except KeyError:
        _fail(f"unknown chat session: {session_id}")
    _emit_json({"session_id": session.session_id, "archived": session.archived})


@workspace_app.command("unarchive-session")
def workspace_unarchive_session(
    session_id: str = typer.Argument(..., help="Chat session id to restore into the default list."),
) -> None:
    """Unarchive a chat session — restore it to the default sidebar/list."""
    store = _team_store()
    try:
        session = store.set_chat_session_archived(session_id, False)
    except KeyError:
        _fail(f"unknown chat session: {session_id}")
    _emit_json({"session_id": session.session_id, "archived": session.archived})


@workspace_app.command("pin-session")
def workspace_pin_session(
    session_id: str = typer.Argument(..., help="Chat session id to pin to the sidebar's top zone."),
) -> None:
    """Pin a chat session — float it to the sidebar's top "Pinned" zone (every
    surface). Navigation only: workspace membership/history are untouched."""
    store = _team_store()
    try:
        session = store.set_chat_session_pinned(session_id, True)
    except KeyError:
        _fail(f"unknown chat session: {session_id}")
    _emit_json({"session_id": session.session_id, "pinned_at": session.pinned_at})


@workspace_app.command("unpin-session")
def workspace_unpin_session(
    session_id: str = typer.Argument(..., help="Chat session id to remove from the top zone."),
) -> None:
    """Unpin a chat session — return it to its original group untouched."""
    store = _team_store()
    try:
        session = store.set_chat_session_pinned(session_id, False)
    except KeyError:
        _fail(f"unknown chat session: {session_id}")
    _emit_json({"session_id": session.session_id, "pinned_at": session.pinned_at})


@workspace_app.command("pin")
def workspace_pin(
    workspace_id: str = typer.Argument(..., help="Workspace id to pin to the sidebar's top zone."),
) -> None:
    """Pin a workspace — float its whole project group to the top "Pinned" zone."""
    store = _team_store()
    try:
        workspace = store.set_workspace_pinned(workspace_id, True)
    except KeyError:
        _fail(f"unknown workspace: {workspace_id}")
    _emit_json({"workspace_id": workspace.workspace_id, "pinned_at": workspace.pinned_at})


@workspace_app.command("unpin")
def workspace_unpin(
    workspace_id: str = typer.Argument(..., help="Workspace id to remove from the top zone."),
) -> None:
    """Unpin a workspace — return its group to the normal Projects list."""
    store = _team_store()
    try:
        workspace = store.set_workspace_pinned(workspace_id, False)
    except KeyError:
        _fail(f"unknown workspace: {workspace_id}")
    _emit_json({"workspace_id": workspace.workspace_id, "pinned_at": workspace.pinned_at})


@workspace_app.command("rename")
def workspace_rename(
    workspace_id: str = typer.Argument(..., help="Workspace id to rename."),
    name: str = typer.Argument(..., help="New display name (the repo path / trust are untouched)."),
) -> None:
    """Rename a workspace (display name only). The CLI twin of the Web rename and
    ``PATCH /api/workspaces/{id}`` — one shared kernel entry validates the name."""
    store = _team_store()
    try:
        workspace = store.rename_workspace(workspace_id, name)
    except KeyError:
        _fail(f"unknown workspace: {workspace_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"workspace_id": workspace.workspace_id, "name": workspace.name})


@workspace_app.command("remove")
def workspace_remove(
    workspace_id: str = typer.Argument(..., help="Workspace id to remove from the registry."),
    yes: bool = typer.Option(
        False, "--yes", "-y",
        help="Skip the interactive confirmation (required for non-interactive use).",
    ),
) -> None:
    """Remove a workspace from the registry — it disappears from every surface's
    project list. The on-disk folder is NEVER deleted; this only unregisters the
    project. Its chat conversations are ARCHIVED (recoverable via the archived
    view), never deleted. The built-in Chat workspace can never be removed.

    The CLI twin of the Web "Remove" action and ``DELETE /api/workspaces/{id}``.
    """
    store = _team_store()
    # fail-closed confirmation: in a TTY, prompt; non-interactively, demand --yes
    # so a scripted invocation can't silently unregister a project.
    if not yes:
        if _is_interactive():
            typer.confirm(
                f"Remove workspace {workspace_id} from the list and archive its "
                "conversations? (on-disk files are NOT deleted)",
                abort=True,
            )
        else:
            _fail("refusing to remove non-interactively without --yes")
    try:
        archived = store.remove_workspace(workspace_id)
    except KeyError:
        _fail(f"unknown workspace: {workspace_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"workspace_id": workspace_id, "removed": True, "archived_sessions": archived})


@workspace_app.command("create-personal")
def workspace_create_personal(
    name: str = typer.Argument(..., help="Display name for the personal workspace."),
    attach_repo: str | None = typer.Option(
        None, "--attach-repo",
        help="Attach a real directory as a REPO workspace instead of a folder-only scratch. Requires --trust (fail-closed).",
    ),
    trust: bool = typer.Option(
        False, "--trust",
        help="Attest you trust the --attach-repo directory for agent execution (required to attach a real dir; §4.4).",
    ),
) -> None:
    """Create a PERSONAL (company="local") workspace — the CLI twin of the Web
    "new workspace" / ``POST /api/workspaces`` (one shared kernel entry).

    Default (no --attach-repo) builds a locked MANAGED scratch folder: a pure
    grouping folder the agent cannot use to touch your real files. --attach-repo
    adopts a real directory and is fail-closed — it needs an explicit trust
    attestation (--trust, or an interactive confirmation).
    """
    # Name validation (empty/whitespace) lives in the one kernel entry
    # create_personal_workspace, so CLI/API/Web share the identical rule — a blank
    # name raises ValueError there and is surfaced as _fail below (CLI↔API zero
    # divergence; no per-surface validator to drift).
    store = _team_store()
    trust_confirmed = bool(trust)
    trust_source = "cli_flag"
    if attach_repo is not None and not trust and _is_interactive():
        # Interactive ONLY: offer the trust confirmation the kernel can't prompt
        # for. The non-interactive path is deliberately NOT pre-failed here — the
        # kernel enforces the trust gate (and validates the name first), so a
        # malformed invocation gets the SAME error (and order) as the API, which
        # also routes straight through the kernel (CLI↔API zero divergence).
        shown = _safe_path_display(str(Path(attach_repo).expanduser()))
        typer.confirm(f"Trust {shown} and attach it as a workspace?", abort=True)
        trust_confirmed = True
        trust_source = "cli_prompt"
    try:
        workspace = workspace_resolver.create_personal_workspace(
            store,
            name,
            attach_repo=attach_repo,
            trust_confirmed=trust_confirmed,
            trust_source=trust_source,
        )
    except (workspace_resolver.WorkspaceRootRejected, ValueError) as exc:
        _fail(str(exc))
    _emit_json(workspace.to_dict())


@workspace_app.command("move-session")
def workspace_move_session(
    session_id: str = typer.Argument(..., help="Chat session id to move."),
    workspace_id: str | None = typer.Option(
        None, "--workspace", help="Target workspace id."
    ),
    to_inbox: bool = typer.Option(
        False, "--to-inbox", help="Move to the flat Chats list (no workspace)."
    ),
    yes: bool = typer.Option(
        False, "--yes",
        help="Acknowledge an execution-boundary change without the interactive prompt (§4.5).",
    ),
) -> None:
    """Move a chat session to another workspace (regroup) — the CLI twin of
    ``POST /api/chat/sessions/{id}/move``.

    Fail-closed move guard (§4.5): if the move changes the execution boundary,
    the chat's runtime resume state is reset, so you MUST acknowledge it (--yes
    or an interactive confirmation). Specify exactly one of --workspace / --to-inbox.
    """
    if to_inbox and workspace_id is not None:
        _fail("specify exactly one of --workspace or --to-inbox, not both")
    if not to_inbox and workspace_id is None:
        _fail("specify a target: --workspace <id> or --to-inbox")
    target = None if to_inbox else workspace_id
    store = _team_store()
    try:
        store.get_chat_session(session_id)
    except KeyError:
        _fail(f"unknown chat session: {session_id}")
    if target is not None:
        try:
            store.get_workspace_profile(target)
        except KeyError:
            _fail(f"unknown workspace: {target}")
    boundary_changed = store.chat_move_changes_execution_boundary(session_id, target)
    if boundary_changed and not yes:
        if not _is_interactive():
            _fail(
                "moving to a different execution boundary resets this chat's runtime "
                "state; re-run with --yes to acknowledge"
            )
        typer.confirm(
            "This move changes the execution boundary and resets the chat's runtime "
            "resume. Continue?",
            abort=True,
        )
    session = store.set_chat_session_workspace(session_id, target)
    _emit_json(
        {
            "session_id": session.session_id,
            "workspace_id": session.workspace_id,
            "execution_boundary_changed": boundary_changed,
        }
    )


@workspace_app.command("adopt")
def workspace_adopt(
    apply: bool = typer.Option(False, "--apply", help="Write the proposed memberships. Default is a dry-run report."),
) -> None:
    """Backfill legacy (unassigned) sessions into workspaces by repo evidence.

    Evidence is each session's recorded native-session repo_path matched via
    the repo-identity fingerprint. Sessions without evidence or without a
    matching registered workspace are left untouched — adoption never trusts
    or creates anything (ADR: workspace-trust-container).
    """
    store = _team_store()
    proposals: list[dict[str, Any]] = []
    for session in store.list_chat_sessions(unassigned_only=True):
        native = session.metadata.get("native_sessions") or {}
        evidence = sorted(
            (str(entry.get("repo_path")), backend, str(entry.get("id") or ""))
            for backend, entry in native.items()
            if isinstance(entry, dict) and entry.get("repo_path")
        )
        for repo_path, backend, native_id in evidence:
            workspace = workspace_resolver.find_workspace_for_path(store, repo_path)
            if workspace is None:
                continue
            proposals.append(
                {
                    "session_id": session.session_id,
                    "title": session.title,
                    "workspace_id": workspace.workspace_id,
                    "workspace_name": workspace.name,
                    "evidence_repo_path": repo_path,
                    "evidence_backend": backend,
                    "evidence_native_session_id": native_id,
                }
            )
            break
    if apply:
        for proposal in proposals:
            store.set_chat_session_workspace(proposal["session_id"], proposal["workspace_id"])
    _emit_json(
        {
            "applied": apply,
            "note": (
                "adoption is a best-effort inference from recorded native-session "
                "repo paths; review proposals before --apply"
            ),
            "proposals": proposals,
        }
    )


@issue_app.command("comment")
def issue_comment(
    issue_id: str = typer.Argument(...),
    body: str = typer.Option(..., "--body", help="Comment text; @name / @profile_id wakes the mentioned agent"),
    author: str = typer.Option("local_user", "--author", help="Author id (agent profile id or user id)"),
    author_type: str = typer.Option("user", "--author-type", help="user | agent | system"),
) -> None:
    """Post a comment on an issue's thread (mentions + assignee wakeups fire)."""
    store = _team_store()
    try:
        comment, interactions = team_kernel.post_issue_comment(
            store, issue_id, body=body, author_type=author_type, author_id=author
        )
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(
        {
            "comment": comment.to_dict(),
            "interactions": [i.to_dict() for i in interactions],
        }
    )


@issue_app.command("comments")
def issue_comments(
    issue_id: str = typer.Argument(...),
    limit: int = typer.Option(200, "--limit", min=1),
) -> None:
    """Read an issue's thread (comments oldest-first)."""
    store = _team_store()
    try:
        store.get_issue(issue_id)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    _emit_json([c.to_dict() for c in store.list_issue_comments(issue_id, limit=limit)])


@issue_app.command("block")
def issue_block(
    issue_id: str = typer.Argument(...),
    reason: str = typer.Option(..., "--reason", help="Why the issue is blocked (required, fail-closed)"),
    by: str = typer.Option("local_user", "--by"),
    unblock_owner: str | None = typer.Option(None, "--unblock-owner", help="Who can unblock (mentioned on the thread)"),
) -> None:
    """Mark an issue blocked with a durable reason on its thread."""
    store = _team_store()
    try:
        issue = team_kernel.block_issue(store, issue_id, reason=reason, by=by, unblock_owner=unblock_owner)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("unblock")
def issue_unblock(
    issue_id: str = typer.Argument(...),
    by: str = typer.Option("local_user", "--by"),
    note: str = typer.Option("", "--note"),
) -> None:
    """Return a blocked issue to the claimable queue (wakes the assignee)."""
    store = _team_store()
    try:
        issue = team_kernel.unblock_issue(store, issue_id, by=by, note=note)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("requeue")
def issue_requeue(
    issue_id: str = typer.Argument(...),
    holder: str | None = typer.Option(None, "--holder", help="Lock holder to release (defaults to the assignee)"),
) -> None:
    """Return a stranded in_progress issue (wreckage) to the claimable queue.

    The operator's standard recovery tool: releases the workspace lock and puts
    the issue back to todo so the next wakeup can claim it fresh."""
    store = _team_store()
    try:
        issue = team_kernel.abort_checkout(store, issue_id, holder=holder)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("hold")
def issue_hold(
    issue_id: str = typer.Argument(...),
    reason: str = typer.Option("", "--reason", help="Why the issue is paused (audit)"),
    by: str = typer.Option("local_user", "--by", help="Who placed the hold"),
) -> None:
    """Place an administrative hold on an issue (a ledger marker, NOT a status).

    A held issue is refused at checkout and skipped by the daemon until released;
    its real status (todo/in_progress/…) is untouched, so it flows again on
    unhold without any status surgery."""
    store = _team_store()
    try:
        hold = team_kernel.hold_issue(store, issue_id, reason=reason, by=by)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(hold.to_dict())


@issue_app.command("unhold")
def issue_unhold(
    issue_id: str = typer.Argument(...),
    by: str = typer.Option("local_user", "--by", help="Who released the hold"),
) -> None:
    """Release an issue's active administrative hold."""
    store = _team_store()
    try:
        hold = team_kernel.release_issue_hold(store, issue_id, by=by)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(hold.to_dict())


@issue_app.command("tree")
def issue_tree(
    root_id: str = typer.Argument(..., help="Root issue of the delegation subtree"),
) -> None:
    """Preview a delegation subtree (read-only): how many live issues, active
    runs, and holds a pause/cancel would affect."""
    store = _team_store()
    try:
        preview = team_kernel.preview_issue_tree(store, root_id)
    except KeyError:
        _fail(f"unknown issue: {root_id}")
    _emit_json(preview)


@issue_app.command("pause-tree")
def issue_pause_tree(
    root_id: str = typer.Argument(..., help="Root issue of the delegation subtree"),
    reason: str = typer.Option("", "--reason", help="Why the subtree is paused (audit)"),
    by: str = typer.Option("local_user", "--by", help="Who paused the subtree"),
) -> None:
    """Pause a whole delegation subtree: hold every live issue, cancel its active
    run, and release its workspace lock (reversible via resume-tree)."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        result = team_kernel.pause_issue_tree(
            orchestrator.store, root_id, by=by, reason=reason,
            run_canceller=orchestrator.cancel_run,
        )
    except KeyError:
        _fail(f"unknown issue: {root_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(result)


@issue_app.command("resume-tree")
def issue_resume_tree(
    root_id: str = typer.Argument(..., help="Root issue of the delegation subtree"),
    by: str = typer.Option("local_user", "--by", help="Who resumed the subtree"),
    operation_id: str | None = typer.Option(None, "--operation-id", help="Release only this pause's holds (omit = all tree holds)"),
) -> None:
    """Resume a paused subtree: release the tree-scoped holds a pause set (a
    deliberate single-issue hold is left intact)."""
    store = _team_store()
    try:
        result = team_kernel.resume_issue_tree(store, root_id, by=by, operation_id=operation_id)
    except KeyError:
        _fail(f"unknown issue: {root_id}")
    _emit_json(result)


@issue_app.command("cancel-tree")
def issue_cancel_tree(
    root_id: str = typer.Argument(..., help="Root issue of the delegation subtree"),
    reason: str = typer.Option("", "--reason", help="Why the subtree is cancelled (audit)"),
    by: str = typer.Option("local_user", "--by", help="Who cancelled the subtree"),
) -> None:
    """Cancel a whole delegation subtree: stop active runs, release locks, and
    transition every live issue to cancelled (terminal)."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        result = team_kernel.cancel_issue_tree(
            orchestrator.store, root_id, by=by, reason=reason,
            run_canceller=orchestrator.cancel_run,
        )
    except KeyError:
        _fail(f"unknown issue: {root_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(result)


@issue_app.command("assign")
def issue_assign(
    issue_id: str = typer.Argument(...),
    profile_id: str = typer.Argument(..., help="Agent profile id to assign"),
) -> None:
    """Assign an issue to exactly one agent profile."""
    store = _team_store()
    try:
        issue = team_kernel.assign_issue(store, issue_id, profile_id)
    except KeyError as exc:
        _fail(f"unknown issue or profile: {exc}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("checkout")
def issue_checkout(
    issue_id: str = typer.Argument(...),
    run_id: str | None = typer.Option(None, "--run-id", help="Run that owns this checkout (generated if omitted)"),
    holder: str | None = typer.Option(None, "--holder", help="Lock holder (defaults to the assignee)"),
) -> None:
    """Take the durable workspace lock and move the issue into in_progress."""
    store = _team_store()
    token = run_id or f"run_{uuid.uuid4().hex[:12]}"
    try:
        issue = team_kernel.checkout_issue(store, issue_id, run_id=token, holder=holder)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(issue.to_dict())


@issue_app.command("submit")
def issue_submit(
    issue_id: str = typer.Argument(...),
    by: str | None = typer.Option(None, "--by", help="Requesting agent profile id"),
    summary: str = typer.Option("", "--summary", help="What was done, for the reviewer"),
) -> None:
    """Request review: move in_progress -> in_review and open a completion approval.

    A no_completion_gate issue has no human gate: the kernel auto-completes it and
    reports ``approval: null`` with ``auto_completed: true`` instead.
    """
    store = _team_store()
    try:
        issue, approval = team_kernel.submit_for_review(store, issue_id, requested_by=by, summary=summary)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({
        "issue": issue.to_dict(),
        "approval": approval.to_dict() if approval is not None else None,
        "auto_completed": approval is None,
    })


@issue_app.command("list")
def issue_list(
    workspace: str | None = typer.Option(None, "--workspace"),
    status: str | None = typer.Option(None, "--status"),
    company: str | None = typer.Option(None, "--company", help="Company profile id"),
) -> None:
    """List issues, optionally filtered by workspace, status and company."""
    store = _team_store()
    issues = store.list_issues(workspace_id=workspace, status=status, company_profile_id=company)
    _emit_json([i.to_dict() for i in issues])


@issue_app.command("work-product")
def issue_work_product_add(
    issue_id: str = typer.Argument(...),
    type: str = typer.Option(..., "--type", help="pull_request|branch|commit|preview|deployment|artifact|document|link"),
    title: str = typer.Option("", "--title"),
    url: str | None = typer.Option(None, "--url"),
    provider: str = typer.Option("local", "--provider", help="github|local|clawhunt|custom"),
    external_id: str | None = typer.Option(None, "--external-id"),
    status: str | None = typer.Option(None, "--status", help="open|ready|merged|closed|failed"),
    summary: str = typer.Option("", "--summary"),
    primary: bool = typer.Option(False, "--primary", help="Mark as the issue's headline deliverable"),
) -> None:
    """Attach a delivery fact (PR / preview / artifact / …) to an issue."""
    store = _team_store()
    try:
        wp = team_kernel.attach_work_product(
            store, issue_id, type=type, title=title, url=url, provider=provider,
            external_id=external_id, status=status, summary=summary, is_primary=primary,
        )
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(wp.to_dict())


@issue_app.command("work-products")
def issue_work_products_list(issue_id: str = typer.Argument(...)) -> None:
    """List an issue's delivery ledger (primary first)."""
    store = _team_store()
    try:
        products = team_kernel.list_work_products(store, issue_id)
    except KeyError:
        _fail(f"unknown issue: {issue_id}")
    _emit_json([wp.to_dict() for wp in products])


@issue_app.command("work-product-update")
def issue_work_product_update(
    work_product_id: str = typer.Argument(...),
    status: str | None = typer.Option(None, "--status", help="open|ready|merged|closed|failed"),
    title: str | None = typer.Option(None, "--title"),
    url: str | None = typer.Option(None, "--url"),
    summary: str | None = typer.Option(None, "--summary"),
    primary: bool | None = typer.Option(None, "--primary/--no-primary", help="Mark/unmark as the issue's headline deliverable"),
) -> None:
    """Patch a delivery fact's mutable fields (status/title/url/summary/primary).

    Mirrors the API PATCH /api/team/work-products/{id} and the Web status
    control — the kernel's update_work_product is the single source of truth
    (an unknown status fails closed). Only the flags you pass are changed.
    """
    store = _team_store()
    if status is None and title is None and url is None and summary is None and primary is None:
        _fail("nothing to update: pass at least one of --status/--title/--url/--summary/--primary")
    try:
        wp = team_kernel.update_work_product(
            store, work_product_id, status=status, title=title, url=url, summary=summary, is_primary=primary,
        )
    except KeyError:
        _fail(f"unknown work product: {work_product_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(wp.to_dict())


@issue_app.command("work-product-remove")
def issue_work_product_remove(work_product_id: str = typer.Argument(...)) -> None:
    """Detach a delivery fact from its issue."""
    store = _team_store()
    _emit_json({"removed": team_kernel.remove_work_product(store, work_product_id)})


@team_board_inbox_app.command("list")
def team_board_inbox_list(
    status: str = typer.Option("pending", "--status"),
    company: str | None = typer.Option(None, "--company", help="Company profile id"),
    workspace: str | None = typer.Option(None, "--workspace"),
    limit: int = typer.Option(100, "--limit", min=1),
) -> None:
    """List durable ESCALATE_TO_BOARD interactions."""
    store = _team_store()
    normalized = None if status in {"all", "*"} else status
    rows: list[dict[str, Any]] = []
    for interaction in store.list_issue_interactions(status=normalized, limit=limit):
        if interaction.continuation_policy != ContinuationPolicy.ESCALATE_TO_BOARD.value:
            continue
        try:
            issue = store.get_issue(interaction.issue_id)
        except KeyError:
            issue = None
        if company and (issue is None or issue.company_profile_id != company):
            continue
        if workspace and (issue is None or issue.workspace_id != workspace):
            continue
        item = interaction.to_dict()
        item["issue"] = issue.to_dict() if issue is not None else None
        rows.append(item)
    _emit_json(
        {
            "status_filter": normalized,
            "company_profile_id": company,
            "workspace_id": workspace,
            "count": len(rows),
            "items": rows,
        }
    )


@team_board_inbox_app.command("resolve")
def team_board_inbox_resolve(
    interaction_id: str = typer.Argument(..., help="Board inbox interaction id"),
    by: str = typer.Option("local_user", "--by"),
    note: str = typer.Option("", "--note"),
) -> None:
    """Resolve a board inbox item without changing its issue."""
    store = _team_store()
    interaction = _board_inbox_interaction_or_exit(store, interaction_id)
    if interaction.status == "resolved":
        _emit_json(
            {
                "action": "resolve",
                "status": "already_resolved",
                "resolved_by": by,
                "note": note,
                "interaction": interaction.to_dict(),
            }
        )
        return
    resolved = team_kernel.resolve_board_inbox_item(store, interaction_id)
    _emit_json(
        {
            "action": "resolve",
            "status": "resolved",
            "resolved_by": by,
            "note": note,
            "interaction": resolved.to_dict(),
        }
    )


@team_board_inbox_app.command("assign")
def team_board_inbox_assign(
    interaction_id: str = typer.Argument(..., help="Board inbox interaction id"),
    profile_id: str = typer.Argument(..., help="Agent profile id to assign"),
    resolve: bool = typer.Option(True, "--resolve/--keep-open", help="Resolve the board item after assignment."),
) -> None:
    """Assign the board item's issue through the Team Kernel assignment gate."""
    store = _team_store()
    interaction = _board_inbox_interaction_or_exit(store, interaction_id)
    if interaction.status != "pending":
        _fail(f"board inbox item is {interaction.status}, not pending")
    try:
        issue, resolved = team_kernel.assign_board_inbox_item(
            store, interaction_id, profile_id, resolve=resolve
        )
    except KeyError as exc:
        _fail(f"unknown issue or profile: {exc}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(
        {
            "action": "assign",
            "status": "assigned",
            "resolved": resolved.status == "resolved",
            "issue": issue.to_dict(),
            "interaction": resolved.to_dict(),
        }
    )


@team_routine_app.command("author")
def team_routine_author(
    spec_json: str | None = typer.Option(None, "--spec-json", help="Routine spec as a JSON object."),
    spec_file: Path | None = typer.Option(None, "--spec-file", help="Path to a routine spec JSON file."),
) -> None:
    """Author a routine and persist it only when it is ready and enabled."""
    store = _team_store()
    spec = _load_json_object_or_exit(spec_json=spec_json, spec_file=spec_file)
    _emit_json(_team_routine_author_payload(store, spec))


@team_routine_app.command("list")
def team_routine_list(
    agent: str | None = typer.Option(None, "--agent", help="Agent profile id"),
    enabled_only: bool = typer.Option(False, "--enabled", help="Show only enabled schedules."),
    disabled_only: bool = typer.Option(False, "--disabled", help="Show only disabled schedules."),
    limit: int = typer.Option(100, "--limit", min=1),
) -> None:
    """List durable routine schedules."""
    if enabled_only and disabled_only:
        _fail("specify only one of --enabled or --disabled")
    enabled = True if enabled_only else False if disabled_only else None
    store = _team_store()
    schedules = store.list_team_routine_schedules(agent_profile_id=agent, enabled=enabled, limit=limit)
    _emit_json(
        {
            "agent_profile_id": agent,
            "enabled": enabled,
            "count": len(schedules),
            "schedules": [schedule.to_dict() for schedule in schedules],
        }
    )


@team_routine_app.command("runs")
def team_routine_runs(
    routine_id: str = typer.Argument(..., help="Routine id to list the fire history for."),
    limit: int = typer.Option(50, "--limit", min=1),
) -> None:
    """List a routine's fire history — each issue it materialized + its run status."""
    store = _team_store()
    runs = store.list_routine_runs(routine_id, limit=limit)
    _emit_json({"routine_id": routine_id, "count": len(runs), "runs": runs})


@team_app.command("inventory")
def team_inventory_cmd(
    workspace: str | None = typer.Option(None, "--workspace"),
    company: str | None = typer.Option(None, "--company", help="Company profile id"),
) -> None:
    """The team read model: agents, issue status counts, open approvals.

    Same kernel projection the API serves at /api/team/inventory — the Web
    dashboard renders exactly this payload.
    """
    store = _team_store()
    _emit_json(team_kernel.team_inventory(store, workspace_id=workspace, company_profile_id=company))


@approve_app.command("list")
def approve_list(
    status: str = typer.Option("pending", "--status"),
    company: str | None = typer.Option(None, "--company", help="Company profile id (scoped via each approval's issue)"),
    workspace: str | None = typer.Option(None, "--workspace"),
) -> None:
    """List approvals (default: the pending queue), optionally scoped to a company/workspace."""
    store = _team_store()
    normalized = None if status in {"all", "*"} else status
    approvals = store.list_approvals(status=normalized, company_profile_id=company, workspace_id=workspace)
    _emit_json([a.to_dict() for a in approvals])


@approve_app.command("show")
def approve_show(approval_id: str = typer.Argument(...)) -> None:
    """Show one approval record, including what it affects and its resume action."""
    store = _team_store()
    try:
        approval = store.get_approval(approval_id)
    except KeyError:
        _fail(f"unknown approval: {approval_id}")
    _emit_json(approval.to_dict())


@approve_app.command("grant")
def approve_grant(
    approval_id: str = typer.Argument(...),
    by: str = typer.Option("local_user", "--by"),
    note: str | None = typer.Option(None, "--note"),
) -> None:
    """Approve: apply the resume action (issue in_review -> done, release lock)."""
    store = _team_store()
    try:
        approval, issue = team_kernel.decide_approval(store, approval_id, approved=True, decided_by=by, note=note)
    except KeyError:
        _fail(f"unknown approval: {approval_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None})


@approve_app.command("reject")
def approve_reject(
    approval_id: str = typer.Argument(...),
    by: str = typer.Option("local_user", "--by"),
    note: str | None = typer.Option(None, "--note"),
) -> None:
    """Reject: send the issue back to in_progress for another pass."""
    store = _team_store()
    try:
        approval, issue = team_kernel.decide_approval(store, approval_id, approved=False, decided_by=by, note=note)
    except KeyError:
        _fail(f"unknown approval: {approval_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None})


@approve_app.command("revision")
def approve_revision(
    approval_id: str = typer.Argument(...),
    by: str = typer.Option("local_user", "--by"),
    note: str | None = typer.Option(None, "--note"),
) -> None:
    """Request revision: bounce the issue back for rework but keep the approval
    open as revision_requested (the agent's next submit reopens the same one)."""
    store = _team_store()
    try:
        approval, issue = team_kernel.request_revision(store, approval_id, note=note, requested_by=by)
    except KeyError:
        _fail(f"unknown approval: {approval_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None})


def _delegate_tool_results_for_run(store: StateStore, run_id: str, status: str) -> tuple[RunSession, list[dict[str, Any]]]:
    if status not in {"pending_review", "approved", "rejected", "all"}:
        _fail("status must be pending_review, approved, rejected, or all")
    try:
        session = store.get_run(run_id)
    except KeyError:
        _fail(f"run not found: {run_id}")
    raw_results = (session.execution_context or {}).get("delegate_tool_results")
    results = [dict(item) for item in raw_results] if isinstance(raw_results, list) else []
    if status != "all":
        results = [item for item in results if item.get("status") == status]
    return session, results


@delegate_review_app.command("list")
def delegate_review_list(
    run_id: str = typer.Argument(...),
    status: str = typer.Option("pending_review", "--status", help="pending_review, approved, rejected, or all"),
) -> None:
    """List delegated child results recorded on a parent run."""
    store = SuperClawOrchestrator.from_path(_state_path()).store
    session, results = _delegate_tool_results_for_run(store, run_id, status)
    _emit_json({"run_id": run_id, "status": session.status, "reviews": results})


def _review_delegate_result(run_id: str, request_key: str, *, approved: bool, by: str) -> None:
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    try:
        result = orchestrator.review_child_delegation_result(
            run_id,
            request_key,
            approved=approved,
            reviewed_by=by,
        )
        session = orchestrator.store.get_run(run_id)
    except KeyError:
        _fail(f"run not found: {run_id}")
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"run_id": run_id, "status": session.status, "result": result})


@delegate_review_app.command("approve")
def delegate_review_approve(
    run_id: str = typer.Argument(...),
    request_key: str = typer.Argument(...),
    by: str = typer.Option(..., "--by", help="Reviewing principal"),
) -> None:
    """Approve a delegated child result; parent still requires explicit resume."""
    _review_delegate_result(run_id, request_key, approved=True, by=by)


@delegate_review_app.command("reject")
def delegate_review_reject(
    run_id: str = typer.Argument(...),
    request_key: str = typer.Argument(...),
    by: str = typer.Option(..., "--by", help="Reviewing principal"),
) -> None:
    """Reject a delegated child result and fail the parent through the kernel."""
    _review_delegate_result(run_id, request_key, approved=False, by=by)


def _escalation_summary(env: Any) -> dict[str, Any]:
    """Operator-facing queue view: the decision context + lifecycle, no HMAC noise.

    Delegates to the kernel projector so the CLI and the ``/api/escalations`` REST
    surface render the SAME shape (single source, zero drift)."""
    return escalation_summary(env)


@escalation_app.command("list")
def escalation_list(
    status: str = typer.Option("pending", "--status", help="pending|approved|denied|expired|consumed|all"),
    run: str | None = typer.Option(None, "--run", help="scope to one run_id"),
) -> None:
    """List escalations (default: the pending approval queue), optionally scoped to a run.

    Filtering is by EFFECTIVE status: an overdue record reads ``expired`` even before
    housekeeping persists the transition, so it never lingers in the pending queue."""
    store = _team_store()
    normalized = None if status in {"all", "*"} else status
    summaries = [_escalation_summary(env) for env in store.list_escalations(run_id=run)]
    if normalized is not None:
        summaries = [s for s in summaries if s["status"] == normalized]
    _emit_json(summaries)


@escalation_app.command("show")
def escalation_show(request_id: str = typer.Argument(...)) -> None:
    """Show one escalation in full, including the signature-validity of its binding."""
    store = _team_store()
    try:
        env = store.get_escalation(request_id)
    except KeyError:
        _fail(f"unknown escalation: {request_id}")
    payload = env.to_dict()
    payload["effective_status"] = env.effective_status()
    payload["signature_valid"] = verify_envelope(env)  # operator confidence: binding untampered
    _emit_json(payload)


@escalation_app.command("respond")
def escalation_respond(
    request_id: str = typer.Argument(...),
    decision: str = typer.Option(..., "--decision", help="the option id to choose, e.g. approve|deny"),
    principal: str = typer.Option("local_user", "--principal", help="responder identity; MUST match the bound principal"),
    note: str | None = typer.Option(None, "--note", help="fingerprint/audit note (last_action_id)"),
) -> None:
    """Respond to a pending escalation. Fail-closed: refuses a tampered/expired record,
    a non-bound principal, or an unknown option. A 'grants' option APPROVES (minting a
    single-use grant the run consumes on resume); any other option DENIES."""
    store = _team_store()
    try:
        env = store.resolve_escalation(
            request_id,
            decision_option_id=decision,
            approver=principal,
            principal=principal,
            last_action_id=note,
        )
    except KeyError:
        _fail(f"unknown escalation: {request_id}")
    except EscalationError as exc:
        _fail(str(exc))
    _emit_json(_escalation_summary(env))


@app.command("human-gate")
def human_gate(run_id: str, reason: str = typer.Option("human input required", "--reason")) -> None:
    """Pause a run for foreground human-gate handling."""
    store = SuperClawOrchestrator.from_path(_state_path()).store
    session = store.get_run(run_id)
    previous_status = session.status
    session.status = "WAITING_FOR_HUMAN_GATE"
    store.save_run(session)
    store.add_event(run_id, "run.paused", {"run_id": run_id, "reason": reason, "previous_status": previous_status})
    typer.echo(f"run_id={run_id}")
    typer.echo(f"status={session.status}")


@app.command("backup")
def backup(out: str | None = typer.Option(None, "--out", help="Snapshot path (default: next to the state DB under backups/)")) -> None:
    """Write a consistent SQLite snapshot of the state DB (safe while running).

    With no --out the snapshot lands next to the state DB (anchored, not cwd).
    An explicit --out is a local operator choice and may be any path the caller
    can write."""
    store = _team_store()
    path = store.backup(out)
    _emit_json({"backup": str(path), "schema_version": store.schema_version()})


@app.command()
def resume(run_id: str) -> None:
    """Resume a run after human-gate handling."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    result = orchestrator.resume_run(run_id)
    typer.echo(f"run_id={run_id}")
    if hasattr(result, "session"):
        summary = _run_summary(result, Path(result.session.execution_context.get("artifact_dir") or default_artifact_dir()))
        for key, value in summary.items():
            typer.echo(f"{key}={value}")
        return
    typer.echo(f"status={result.status}")


@app.command()
def supervise() -> None:
    """Emit a small supervision snapshot suitable for CI."""
    typer.echo("SuperClaw supervise: local state available")


@app.command()
def submit(problem_id: int, run_id: str) -> None:
    """Submit stored run evidence to ClawHunt."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    bundle = orchestrator.store.get_evidence(run_id)
    submission = build_clawhunt_submission_payload(
        solution_text=default_solution_text(run_id),
        evidence=bundle,
        attachments=[f"superclaw-run:{run_id}"],
    )
    response = ClawHuntClient().submit_solution(problem_id, submission)
    if response.get("ok"):
        bundle.mark_submitted(response)
    else:
        bundle.add_finding("clawhunt_submission", False, f"submit failed with status {response.get('status_code')}", "high")
    orchestrator.store.save_evidence(bundle)
    typer.echo(json.dumps({"response": response, "chain_verdict": bundle.chain_verdict.value}, ensure_ascii=False))


@app.command("export")
def export_cmd(
    out: str = typer.Option(..., "--out", help="Local output file path (URLs are rejected)."),
    kind: str = typer.Option("cost", "--kind", help="What to export: cost | run-condition."),
    fmt: str = typer.Option("jsonl", "--format", help="Output format (cost): jsonl | csv | sqlite."),
    today: bool = typer.Option(False, "--today", help="Only today's local calendar day (cost)."),
    since: str | None = typer.Option(None, "--since", help="Inclusive lower bound (YYYY-MM-DD, local; cost)."),
    until: str | None = typer.Option(None, "--until", help="Exclusive upper bound (YYYY-MM-DD, local; cost)."),
    run_id: str | None = typer.Option(None, "--run-id", help="Run id (required for --kind run-condition)."),
    require_complete: bool = typer.Option(
        False, "--require-complete", help="Fail if telemetry is missing (run-condition)."
    ),
    probe_tools: bool = typer.Option(
        True, "--probe-tools/--no-probe-tools", help="Probe external tool versions (run-condition)."
    ),
) -> None:
    """Export an operator telemetry/audit artifact to a LOCAL file + sidecar manifest.

    The output is allowlisted + redacted and written to a local file you copy into
    your own analysis tool — it is NEVER uploaded (``--out`` rejects URLs).

    ``--kind cost`` exports the cost-event ledger over a date window. ``--kind
    run-condition`` exports one run's condition manifest (P1): the allowlisted,
    HMAC-fingerprinted record of *under what conditions* a run executed. Configure
    ``SUPERCLAW_OPERATOR_FINGERPRINT_SECRET`` for keyed identifier fingerprints
    (otherwise weak_hash is flagged).
    """
    from superclaw.operator_export import ExportError, export_run_condition
    from superclaw.operator_export import export as _export

    # Construct the store only AFTER argument validation — a pure parameter error
    # (e.g. a missing --run-id) must fail-closed without touching/initializing state.
    try:
        if kind == "run-condition":
            if not run_id:
                raise ExportError("--run-id is required for --kind run-condition")
            manifest = export_run_condition(
                _team_store(),
                run_id=run_id,
                out=out,
                require_complete=require_complete,
                probe_external_tools=probe_tools,
            )
        else:
            since_epoch, until_epoch = _cost_time_window(today=today, since=since, until=until)
            manifest = _export(_team_store(), kind=kind, out=out, fmt=fmt, since=since_epoch, until=until_epoch)
    except (ExportError, ValueError) as exc:
        typer.echo(f"export failed: {exc}", err=True)
        raise typer.Exit(1) from exc
    _emit_json(manifest)


@app.command("diagnose")
def diagnose_cmd(
    run_id: str = typer.Argument(..., help="The run to diagnose."),
    out: str | None = typer.Option(
        None, "--out", help="Local file to export the redacted bundle to (URLs rejected). Omit to print to stdout."
    ),
    require_complete: bool = typer.Option(
        False, "--require-complete", help="Fail if telemetry / governance is missing or truncated."
    ),
) -> None:
    """Show a run's DIAGNOSTIC CONTEXT — "where did it get stuck, what decision, why?".

    Composes the span tree, lifecycle timeline, governance decision codes, cost, the
    run conditions, and root-cause hints — all allowlist-redacted. Omit ``--out`` to
    print to stdout; pass ``--out`` to write a redacted local file + sidecar you copy
    into your own tool (it is NEVER uploaded; ``--out`` rejects URLs).

    This is diagnostic CONTEXT, not decision replay: replay needs Tier C raw-I/O
    recording, which is not implemented (the bundle says ``decision_replay:
    unavailable``). Configure ``SUPERCLAW_OPERATOR_FINGERPRINT_SECRET`` for keyed
    identifier fingerprints.
    """
    from superclaw.diagnostic_bundle import build_diagnostic_bundle
    from superclaw.operator_export import ExportError, export_diagnostic_bundle

    try:
        if out:
            result = export_diagnostic_bundle(
                _team_store(), run_id=run_id, out=out, require_complete=require_complete
            )
        else:
            result = build_diagnostic_bundle(
                _team_store(), run_id=run_id, require_complete=require_complete
            )
    except (ExportError, ValueError) as exc:
        typer.echo(f"diagnose failed: {exc}", err=True)
        raise typer.Exit(1) from exc
    _emit_json(result)


@app.command("export-protocol")
def export_protocol(
    run_id: str,
    github_pr_url: str | None = typer.Option(None, "--github-pr-url"),
    github_pr_number: int | None = typer.Option(None, "--github-pr-number"),
) -> None:
    """Export a stored run as a ClawHunt Delivery Protocol payload."""
    orchestrator = SuperClawOrchestrator.from_path(_state_path())
    session = orchestrator.store.get_run(run_id)
    goal = orchestrator.store.get_goal(session.goal_id)
    bundle = orchestrator.store.get_evidence(run_id)
    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(run_id),
        name=goal.title,
        summary=goal.description,
        evidence=bundle,
        github_pr_url=github_pr_url,
        github_pr_number=github_pr_number,
        attachments=[f"superclaw-run:{run_id}"],
    )
    typer.echo(json.dumps(payload.to_dict(), ensure_ascii=False, indent=2))


@app.command()
def deploy() -> None:
    """Placeholder deploy command for gray rollout automation."""
    typer.echo("Gray deployment is configured through Docker/Cloud Run artifacts.")


def _launch_web_service(
    host: str, port: int, state_path, log_level: str, watch_ui_pid, sidecar_host: str | None = None
) -> None:
    """Start FastAPI + co-launch Node/gateway sidecars. Shared by `service` and `web`.

    ``sidecar_host`` decouples the loopback-only Node sidecars from the public FastAPI
    bind: a container (Cloud Run) must serve uvicorn on ``0.0.0.0`` yet the vendored
    control plane refuses any non-loopback host in ``local_trusted`` mode, so the
    entrypoint passes ``host=0.0.0.0`` (uvicorn) + ``sidecar_host=127.0.0.1`` (Node +
    gateway). Defaults to ``host`` so every existing caller is unchanged.
    """
    sidecar_bind = sidecar_host or host
    os.environ["SUPERCLAW_SERVICE_BIND"] = host
    os.environ["SUPERCLAW_SERVICE_PORT"] = str(port)
    if watch_ui_pid is not None and watch_ui_pid > 0:
        # Spawned by the desktop App: outlive nothing. A daemon thread reaps this
        # sidecar (and its child backends) the moment the owning window exits —
        # the robust cleanup path that survives a swallowed Cmd+Q / crash / kill.
        import threading

        from superclaw.desktop_runtime import run_ui_watchdog

        threading.Thread(target=run_ui_watchdog, args=(watch_ui_pid,), daemon=True).start()
    # Co-launch the vendored Node control-plane server as a child of this
    # long-lived service process. As a descendant it is reaped by the watchdog on
    # UI death; the finally below tears it down on a clean service exit (web-dev
    # Ctrl+C / SIGTERM). Honors SUPERCLAW_NODE_SERVER; fail-open (None when the
    # Node server is absent/disabled). MUST mirror superclaw_service._run_service_fast.
    from superclaw.gateway_runtime import start_gateway_sidecar_if_enabled
    from superclaw.node_runtime import install_signal_teardown, start_node_sidecar_if_enabled

    resolved_state_path = state_path or _state_path()
    # Hydrate persisted runtime env BEFORE launching Node so the co-launched server
    # inherits the same configuration as the Python app — and so this matches the
    # frozen shim, which hydrates before its Node launch (铁律2 parity). The later
    # _build_service_app re-hydrate is idempotent.
    hydrate_runtime_environment()
    node_supervisor = start_node_sidecar_if_enabled(resolved_state_path, host=sidecar_bind)
    # Co-launch the automation gateway AFTER Node so the upstream's node-service.json
    # marker exists when the gateway self-discovers it. Honors SUPERCLAW_GATEWAY;
    # fail-open (None when absent/disabled). MUST mirror superclaw_service._run_service_fast.
    gateway_supervisor = start_gateway_sidecar_if_enabled(resolved_state_path, host=sidecar_bind)
    # uvicorn re-raises SIGINT/SIGTERM on shutdown, bypassing the finally — so a
    # web-dev Ctrl+C / kill needs a signal handler to reap both sidecars. (Desktop exit
    # is handled by the watchdog.) The finally still covers a clean uvicorn return.
    install_signal_teardown(node_supervisor, gateway_supervisor)
    try:
        _uvicorn_module().run(_build_service_app(resolved_state_path), host=host, port=port, log_level=log_level)
    finally:
        if gateway_supervisor is not None:
            gateway_supervisor.stop()
        if node_supervisor is not None:
            node_supervisor.stop()


@app.command("service")
def service_command(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8788, "--port", min=1, max=65535),
    state_path: Path | None = typer.Option(None, "--state-path"),
    log_level: str = typer.Option("info", "--log-level"),
    sidecar_host: str | None = typer.Option(
        None,
        "--sidecar-host",
        help="Host for the loopback-only Node/gateway sidecars (default: --host). Set 127.0.0.1 when "
        "--host is 0.0.0.0 (e.g. Cloud Run) so the control plane still binds loopback.",
    ),
    watch_ui_pid: int | None = typer.Option(
        None,
        "--watch-ui-pid",
        help="Self-terminate (tear down this sidecar's process group) once the given GUI pid exits.",
    ),
) -> None:
    """Run the local SuperClaw FastAPI service for desktop/web clients."""
    _launch_web_service(host, port, state_path, log_level, watch_ui_pid, sidecar_host=sidecar_host)


@desktop_app.command("start")
def desktop_start_command(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int | None = typer.Option(None, "--port", min=1, max=65535),
    state_path: Path | None = typer.Option(None, "--state-path"),
    python_executable: str | None = typer.Option(None, "--python-executable"),
    control_token: str | None = typer.Option(None, "--control-token"),
    connect_timeout_seconds: float = typer.Option(0.5, "--connect-timeout"),
    boot_timeout_seconds: float | None = typer.Option(None, "--boot-timeout"),
    log_level: str = typer.Option("warning", "--log-level"),
    watch_ui_pid: int | None = typer.Option(
        None,
        "--watch-ui-pid",
        help="Make a NEWLY-spawned sidecar self-terminate when this GUI pid exits (desktop App only).",
    ),
) -> None:
    """Start or attach to the local desktop runtime sidecar and emit a JSON handle."""
    supervisor = DesktopRuntimeSupervisor(
        state_path=state_path or _state_path(),
        host=host,
        port=port,
        python_executable=python_executable,
        connect_timeout_seconds=connect_timeout_seconds,
        boot_timeout_seconds=boot_timeout_seconds,
        log_level=log_level,
        watch_ui_pid=watch_ui_pid,
    )
    try:
        handle = supervisor.start_or_connect(control_token=control_token)
    except Exception as exc:
        typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise typer.Exit(1) from exc
    typer.echo(
        json.dumps(
            {
                "ok": True,
                "handle": desktop_service_handle_payload(handle),
                # The supervisor owns probing (it already knows base_url/timeouts);
                # going through it keeps the start->probe contract in one place.
                "status": supervisor.probe(handle.control_token),
            },
            ensure_ascii=False,
        )
    )


@desktop_app.command("probe")
def desktop_probe_command(
    base_url: str = typer.Option(..., "--base-url"),
    control_token: str | None = typer.Option(None, "--control-token"),
    timeout_seconds: float = typer.Option(0.5, "--timeout"),
) -> None:
    """Probe a desktop runtime sidecar and emit its current health/runtime payload."""
    payload = probe_service_status(base_url=base_url, control_token=control_token, timeout_seconds=timeout_seconds)
    typer.echo(json.dumps({"ok": payload is not None, "status": payload}, ensure_ascii=False))


@desktop_app.command("stop")
def desktop_stop_command(
    pid: int | None = typer.Option(None, "--pid"),
    expect_pid: int | None = typer.Option(
        None,
        "--expect-pid",
        help="Marker-driven stop only proceeds if the running sidecar's pid matches (session ownership).",
    ),
    host: str = typer.Option("127.0.0.1", "--host"),
    owned: bool = typer.Option(True, "--owned/--no-owned"),
    tree: bool = typer.Option(
        True,
        "--tree/--no-tree",
        help="Also terminate the sidecar's child process group so spawned backends do not linger.",
    ),
    wait_timeout_seconds: float = typer.Option(2.0, "--wait-timeout"),
    state_path: Path | None = typer.Option(None, "--state-path"),
) -> None:
    """Stop the desktop runtime sidecar and emit a JSON result.

    With ``--pid`` the given process is stopped directly. Without it, the
    currently-running sidecar is resolved from the on-disk handle marker (the
    path the desktop shell uses on exit). By default the whole child process
    group is torn down (``--tree``) so spawned backends do not become orphans.
    ``--expect-pid`` scopes the marker-driven stop to the sidecar a given session
    spawned, so it never tears down one it merely attached to.
    """
    if pid is None:
        # Marker-driven teardown: the single capability the desktop shell calls
        # on exit, also usable as `superclaw desktop stop` from the CLI. The host
        # must match the marker's recorded base_url, so it is parameterised here
        # in lockstep with the frozen-backend shim (铁律2).
        supervisor = DesktopRuntimeSupervisor(state_path=state_path or _state_path(), host=host)
        result = supervisor.stop_service(
            wait_timeout_seconds=wait_timeout_seconds, process_group=tree, expect_pid=expect_pid
        )
        # Also tear down the co-launched Node server, gated on the SAME ownership
        # decision (skipped when the Python sidecar was deliberately retained, e.g.
        # superseded). Additive "node" key; the Python result shape is unchanged.
        # MUST mirror superclaw_service._run_desktop_fast's stop branch (铁律2).
        from superclaw.node_runtime import stop_node_sidecar_for_python_result

        result["node"] = stop_node_sidecar_for_python_result(
            supervisor.run_dir, result, host=host, wait_timeout_seconds=wait_timeout_seconds
        )
        typer.echo(json.dumps(result, ensure_ascii=False))
        return
    if not owned:
        typer.echo(json.dumps({"ok": True, "stopped": False, "reason": "not_owned", "pid": pid}, ensure_ascii=False))
        return
    try:
        stopped = shutdown_process_pid(pid, wait_timeout_seconds=wait_timeout_seconds, process_group=tree)
    except PermissionError as exc:
        typer.echo(json.dumps({"ok": False, "error": str(exc), "pid": pid}, ensure_ascii=False))
        raise typer.Exit(1) from exc
    # `--pid` is a low-level direct kill of one named pid; it carries no reliable
    # marker/state-path context (the desktop shell does not pass --state-path here),
    # so it does NOT also reap Node — that would risk the wrong run dir. The Node
    # server is reaped by the sidecar watchdog on real desktop exit, by the
    # marker-driven `desktop stop` (no --pid), or by the clean-exit finally.
    typer.echo(json.dumps({"ok": True, "stopped": stopped, "pid": pid}, ensure_ascii=False))


@app.command("tui")
def tui_command(
    backend: str | None = typer.Option(None, "--backend"),
    mode: str | None = typer.Option(None, "--mode"),
    repo: Path | None = typer.Option(None, "--repo"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
    selected_run_id: str | None = typer.Option(None, "--run-id"),
    selected_plugin_id: str | None = typer.Option(None, "--plugin-id"),
    dispatch_action: str | None = typer.Option(None, "--dispatch-action"),
    message: str | None = typer.Option(None, "--message"),
    continue_last: bool = typer.Option(False, "--continue"),
    budget_seconds: int = typer.Option(60, "--budget-seconds"),
    dry_run: bool | None = typer.Option(None, "--dry/--no-dry"),
    backend_override: str | None = typer.Option(None, "--backend-override"),
    submit_composer: str | None = typer.Option(None, "--submit-composer"),
    dump_snapshot: bool = typer.Option(False, "--dump-snapshot"),
    snapshot_file: Path | None = typer.Option(None, "--snapshot-file"),
    dump_events: str | None = typer.Option(None, "--dump-events"),
) -> None:
    """Run the experimental full-screen TUI proof of concept."""
    artifact_dir = artifact_dir or default_artifact_dir()
    resolved_backend = backend or _configured_shell_backend() or "claude"
    resolved_mode = (mode or _configured_shell_mode() or "auto").strip().lower()
    if resolved_mode not in _SHELL_MODES:
        typer.echo("error: mode must be one of auto, chat, delivery")
        raise typer.Exit(1)
    configured_repo = _configured_shell_repo()
    resolved_repo = Path(repo or configured_repo or ".").resolve()
    if dump_events:
        for line in render_tui_run_events(StateStore(_state_path()), dump_events):
            typer.echo(line)
        return
    if dispatch_action:
        typer.echo(
            json.dumps(
                dispatch_tui_action(
                    state_path=_state_path(),
                    action_id=dispatch_action,
                    backend=resolved_backend,
                    mode=resolved_mode,
                    repo=resolved_repo,
                    artifact_dir=artifact_dir.resolve(),
                    prompt=message,
                    run_id=selected_run_id,
                    plugin_id=selected_plugin_id,
                    continue_last=continue_last,
                    dry_run=dry_run,
                    budget_seconds=budget_seconds,
                    backend_override=backend_override,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if submit_composer is not None:
        typer.echo(
            json.dumps(
                dispatch_tui_composer(
                    state_path=_state_path(),
                    backend=resolved_backend,
                    mode=resolved_mode,
                    repo=resolved_repo,
                    artifact_dir=artifact_dir.resolve(),
                    value=submit_composer,
                    selected_action_id=None,
                    run_id=selected_run_id,
                    plugin_id=selected_plugin_id,
                    continue_last=continue_last,
                    dry_run=dry_run,
                    budget_seconds=budget_seconds,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if dump_snapshot:
        snapshot = build_tui_snapshot(
            state_path=_state_path(),
            backend=resolved_backend,
            mode=resolved_mode,
            repo=resolved_repo,
            artifact_dir=artifact_dir.resolve(),
            selected_run_id=selected_run_id,
            selected_plugin_id=selected_plugin_id,
        )
        typer.echo(json.dumps(snapshot, ensure_ascii=False, indent=2))
        return
    if snapshot_file is not None:
        snapshot = build_tui_snapshot(
            state_path=_state_path(),
            backend=resolved_backend,
            mode=resolved_mode,
            repo=resolved_repo,
            artifact_dir=artifact_dir.resolve(),
            selected_run_id=selected_run_id,
            selected_plugin_id=selected_plugin_id,
        )
        written = write_tui_snapshot_artifact(snapshot, snapshot_file.expanduser().resolve())
        typer.echo(
            json.dumps(
                {
                    "status": "completed",
                    "snapshot_path": str(written),
                    "selected_run_id": snapshot["sidebar"].get("selected_run_id"),
                    "selected_session_id": snapshot["sidebar"].get("selected_session_id"),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    try:
        run_tui(
            state_path=_state_path(),
            backend=resolved_backend,
            mode=resolved_mode,
            repo=resolved_repo,
            artifact_dir=artifact_dir.resolve(),
            selected_run_id=selected_run_id,
            selected_plugin_id=selected_plugin_id,
            budget_seconds=budget_seconds,
            dry_run=dry_run,
        )
    except TuiBootstrapError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc


@app.command("tui-acceptance")
def tui_acceptance_command(
    report_file: Path | None = typer.Option(None, "--report-file"),
    snapshot_file: Path | None = typer.Option(None, "--snapshot-file"),
    python_executable: Path | None = typer.Option(None, "--python-executable"),
) -> None:
    """Run the TUI acceptance suite and emit a JSON report."""
    report = run_tui_acceptance(
        workspace_root=Path(".").resolve(),
        python_executable=python_executable,
        report_path=report_file,
        snapshot_file=snapshot_file,
    )
    typer.echo(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get("success") is not True:
        raise typer.Exit(1)


def _print_response(response: dict[str, Any]) -> None:
    typer.echo(json.dumps(response, ensure_ascii=False, indent=2))


def _hydrate_cli_environment() -> None:
    hydrate_runtime_environment()
    hydrate_clawhunt_auth_environment()
    # Default the kind-scoped trust roots to the build-baked official public key
    # (frozen builds only; explicit env override wins). No-op from source/tests.
    hydrate_official_root_public_keys()


def _clawhunt_auth_status_payload() -> dict[str, Any]:
    _hydrate_cli_environment()
    summary = clawhunt_auth_summary()
    client = ClawHuntAccountClient()
    return build_clawhunt_auth_payload(
        base_url=client.settings.base_url,
        agent_api_key_configured=summary["agent_api_key"] == "set",
        account_configured=summary["account"] == "set",
        account_user=summary.get("account_user"),
        agent_key_source=summary.get("agent_key_source"),
        agent_key_name=summary.get("agent_key_name"),
        account_source=summary.get("account_source"),
        login_source=summary.get("login_source"),
    )


def _clawhunt_account_token_or_exit() -> str:
    _hydrate_cli_environment()
    access_token = saved_clawhunt_access_token()
    if not access_token:
        typer.echo("error: run `superclaw clawhunt exchange-handoff-code` or complete ClawHunt browser login first")
        raise typer.Exit(1)
    return access_token


def _print_clawhunt_auth_status(payload: dict[str, Any]) -> None:
    clawhunt = payload["clawhunt"]
    typer.echo(f"account={clawhunt['account']}")
    typer.echo(f"agent_api_key={clawhunt['agent_api_key']}")
    typer.echo(f"base_url={clawhunt['base_url']}")
    if clawhunt.get("account_user"):
        user = clawhunt["account_user"]
        typer.echo(f"account_user={user.get('username') or user.get('email') or user.get('id') or 'set'}")
    if clawhunt.get("agent_key_source"):
        typer.echo(f"agent_key_source={clawhunt['agent_key_source']}")
    if clawhunt.get("agent_key_name"):
        typer.echo(f"agent_key_name={clawhunt['agent_key_name']}")
    if clawhunt.get("account_source"):
        typer.echo(f"account_source={clawhunt['account_source']}")
    if clawhunt.get("login_source"):
        typer.echo(f"login_source={clawhunt['login_source']}")


def _read_harness_source(path: Path) -> str:
    """Read a harness source file with a clean CLI error instead of a traceback."""
    if not path.is_file():
        typer.echo(f"error: file not found: {path}")
        raise typer.Exit(1)
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        typer.echo(f"error: could not read {path}: {exc}")
        raise typer.Exit(1) from exc


@runtime_app.command("list")
def runtime_list(
    output_json: bool = typer.Option(
        True, "--json/--table", help="Machine-readable JSON (default) or a human-readable table."
    ),
) -> None:
    """List runtime backends: availability ∩ model ∩ strengths in one shot. 跨 runtime 委派
    (P1)的单一 CLI 事实源——编排模型读它自选委派目标,Web/Desktop 同源消费 build_agent_inventory。
    """
    inventory = build_agent_inventory(
        backends=default_backends(), config_payload=runtime_config_payload()
    )
    if output_json:
        _print_response({"runtimes": inventory, "summary": build_agent_summary(inventory)})
        return
    for entry in inventory:
        avail = "ready" if entry.get("available") else "unavailable"
        model = entry.get("default_model") or "-"
        typer.echo(f"{entry['name']:<18} {avail:<12} {model:<24} {entry.get('strengths', '')}")


@runtime_app.command("inspect")
def runtime_inspect() -> None:
    """Inspect local Codex/Claude runtime features without printing secrets."""
    _print_response(runtime_manifest())


@runtime_app.command("compare")
def runtime_compare() -> None:
    """Compare SuperClaw against locally available coding-agent CLIs."""
    _print_response(runtime_cli_comparison())


@runtime_app.command("context")
def runtime_context() -> None:
    """Summarize local SuperClaw state, evidence, transcript, and chat usage."""
    store = SuperClawOrchestrator.from_path(_state_path()).store
    _print_response(store.context_usage())


@runtime_app.command("mcp-status")
def runtime_mcp_status_command(
    config: list[Path] | None = typer.Option(None, "--config"),
    no_cli_probe: bool = typer.Option(False, "--no-cli-probe"),
) -> None:
    """Inspect MCP config/readiness and optional Codex MCP CLI status without printing secrets."""
    _print_response(runtime_mcp_status([str(path) for path in config or []], run_cli_probe=not no_cli_probe))


@runtime_app.command("policy")
def runtime_policy(
    permission_mode: str = typer.Option("default", "--permission-mode"),
    allowed_tool: list[str] | None = typer.Option(None, "--allowed-tool"),
    disallowed_tool: list[str] | None = typer.Option(None, "--disallowed-tool"),
    mcp_config: list[str] | None = typer.Option(None, "--mcp-config"),
    plugin_dir: list[str] | None = typer.Option(None, "--plugin-dir"),
) -> None:
    """Render the normalized permission/MCP/plugin policy that run/chat will apply."""
    policy = _permission_policy(
        permission_mode=permission_mode,
        allowed_tool=allowed_tool,
        disallowed_tool=disallowed_tool,
        mcp_config=mcp_config,
        plugin_dir=plugin_dir,
    ) or PermissionPolicy()
    _print_response(policy.to_dict())


@eval_app.command("delivery-gap")
def eval_delivery_gap(
    agent: str = typer.Option("all", "--agent"),
    case: str = typer.Option(CASE_ID, "--case"),
    timeout_seconds: int = typer.Option(900, "--timeout-seconds"),
    output: Path | None = typer.Option(None, "--output"),
) -> None:
    """Run the plug-and-play local delivery-gap evaluation app."""
    report = EvalRunner(_eval_root()).run_delivery_gap(
        agent=agent,
        case_id=case,
        output=output,
        timeout_seconds=timeout_seconds,
    )
    typer.echo(json.dumps(report, ensure_ascii=False, indent=2))


def _explicit_eval_output_dir(eval_ref: str) -> Path | None:
    path = Path(eval_ref).expanduser()
    if path.exists():
        return path.resolve()
    return None


@eval_app.command("report")
def eval_report(eval_id: str) -> None:
    """Print a stored eval report as JSON."""
    output_dir = _explicit_eval_output_dir(eval_id)
    if output_dir is not None:
        _print_response(json.loads((output_dir / "report.json").read_text(encoding="utf-8")))
        return
    _print_response(EvalRunner(_eval_root()).get_report(eval_id))


@eval_app.command("report-pdf")
def eval_report_pdf(eval_id: str) -> None:
    """Render or print the path to a stored eval technical PDF report."""
    runner = EvalRunner(_eval_root())
    output_dir = _explicit_eval_output_dir(eval_id)
    if output_dir is not None:
        path = output_dir / "report.pdf"
        if not path.exists():
            report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
            runner.write_pdf_report(report, path)
    else:
        path = runner.report_pdf_path(eval_id)
    _print_response({"eval_id": eval_id, "report_pdf": str(path.resolve())})


@eval_app.command("open")
def eval_open(eval_id: str) -> None:
    """Print local paths for a stored eval report and markdown summary."""
    root = _explicit_eval_output_dir(eval_id) or EvalRunner(_eval_root()).eval_dir(eval_id)
    _print_response(
        {
            "eval_id": eval_id,
            "root": str(root.resolve()),
            "report_json": str((root / "report.json").resolve()),
            "report_md": str((root / "report.md").resolve()),
            "report_pdf": str((root / "report.pdf").resolve()),
        }
    )


@harness_app.command("matrix")
def harness_matrix_command() -> None:
    """Print supported harness capabilities and Claude Code runtime alignment."""
    _print_response({"harnesses": harness_matrix(), "runtime_profile": runtime_profile()})


@harness_app.command("inventory")
def harness_inventory(source_root: Path) -> None:
    """Inspect an Agents-style plugin root without copying its contents."""
    _print_response(inventory_plugins(source_root).to_dict())


@harness_app.command("emit")
def harness_emit(
    source_root: Path,
    output_root: Path,
    target: str = typer.Option(..., "--target"),
    plugins: str = typer.Option("", "--plugins"),
) -> None:
    """Generate harness-native artifacts into an output directory."""
    selected = [item.strip() for item in plugins.split(",") if item.strip()] or None
    _print_response(emit_harness_artifacts(source_root, output_root, target=target, plugins=selected).to_dict())


@harness_app.command("validate")
def harness_validate(
    output_root: Path,
    target: str = typer.Option(..., "--target"),
    strict: bool = typer.Option(False, "--strict"),
) -> None:
    """Validate generated harness artifacts for one target."""
    report = validate_harness_artifacts(output_root, target=target)
    _print_response(report.to_dict())
    if not report.ok or (strict and report.findings):
        raise typer.Exit(1)


@harness_app.command("adapt-agent")
def harness_adapt_agent(
    agent_path: Path,
    target: str = typer.Option("codex", "--target"),
    plugin: str = typer.Option("", "--plugin"),
) -> None:
    """Adapt one Claude-style agent markdown file into a target harness summary."""
    frontmatter, body = parse_markdown_with_frontmatter(_read_harness_source(agent_path))
    try:
        artifact = adapt_agent(plugin=plugin, name=str(frontmatter.get("name") or agent_path.stem), frontmatter=frontmatter, body=body, target=target)
    except KeyError as exc:
        typer.echo(f"error: unknown target harness: {target}")
        raise typer.Exit(1) from exc
    _print_response(artifact.to_dict())


@harness_app.command("adapt-skill")
def harness_adapt_skill(
    skill_path: Path,
    target: str = typer.Option("codex", "--target"),
    plugin: str = typer.Option("", "--plugin"),
) -> None:
    """Adapt one Claude/Codex-style SKILL.md into a target harness summary."""
    frontmatter, body = parse_markdown_with_frontmatter(_read_harness_source(skill_path))
    name = str(frontmatter.get("name") or skill_path.parent.name)
    try:
        artifact = adapt_skill(plugin=plugin, name=name, frontmatter=frontmatter, body=body, target=target)
    except KeyError as exc:
        typer.echo(f"error: unknown target harness: {target}")
        raise typer.Exit(1) from exc
    _print_response(artifact.to_dict())


@clawhunt_app.command("auth-status")
def clawhunt_auth_status(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show shared ClawHunt account and agent-key status without printing secrets."""
    payload = _clawhunt_auth_status_payload()
    if json_output:
        _print_response(payload)
        return
    _print_clawhunt_auth_status(payload)


@clawhunt_app.command("login-probe")
def clawhunt_login_probe(json_output: bool = typer.Option(False, "--json")) -> None:
    """Probe the configured ClawHunt account login endpoint with invalid credentials."""
    _hydrate_cli_environment()
    client = ClawHuntAccountClient()
    try:
        response = client.login_probe()
    except httpx.HTTPError as exc:
        payload = login_probe_error_result(base_url=client.settings.base_url, exc=exc)
    else:
        payload = classify_login_probe_result(base_url=client.settings.base_url, response=response)
    if json_output:
        _print_response(payload)
        return
    typer.echo(f"ok={str(bool(payload['ok'])).lower()}")
    typer.echo(f"reachable={str(bool(payload['reachable'])).lower()}")
    typer.echo(f"login_endpoint={str(bool(payload['login_endpoint'])).lower()}")
    typer.echo(f"base_url={payload['base_url']}")
    typer.echo(f"status_code={payload['status_code']}")
    typer.echo(f"detail={payload['detail']}")
    if not payload["ok"]:
        raise typer.Exit(1)


@clawhunt_app.command("account-login")
def clawhunt_account_login(
    username: str = typer.Option(..., "--username"),
    password: str = typer.Option(..., "--password", prompt=True, hide_input=True),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Sign in with a ClawHunt account and save the shared CLI/desktop login state."""
    _hydrate_cli_environment()
    username = username.strip()
    if not username or not password.strip():
        typer.echo("error: username and password must be non-empty")
        raise typer.Exit(1)
    try:
        response = ClawHuntAccountClient().login(username, password)
        access_token, user = extract_login_session(response)
    except (httpx.HTTPError, ValueError) as exc:
        if json_output:
            _print_response({"ok": False, "error": str(exc)})
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    save_clawhunt_auth({"access_token": access_token, "account_user": user, "account_source": "password", "login_source": SUPERCLAW_LOGIN_SOURCE})
    # On login (identity established) ensure the account's escrowed developer signing
    # keypair (server-held, recoverable; cached locally). Best-effort: never break login.
    from superclaw.developer_identity import ensure_developer_key_registered

    developer_key = ensure_developer_key_registered(access_token, user)
    payload = {"ok": True, "auth": _clawhunt_auth_status_payload(), "user": user, "developer_key": developer_key}
    if json_output:
        _print_response(payload)
        return
    typer.echo("account=set")
    if user:
        typer.echo(f"account_user={user.get('username') or user.get('email') or user.get('id') or 'set'}")
    if developer_key.get("ok"):
        typer.echo(f"developer_key=ensured keyid={developer_key.get('keyid') or 'set'}")
    else:
        typer.echo(f"developer_key=deferred ({developer_key.get('reason') or developer_key.get('error') or 'unavailable'})")


@clawhunt_app.command("register-developer-key")
def clawhunt_register_developer_key(
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Ensure the account's escrowed developer signing keypair (server-held, recoverable).

    Idempotent retry for the ensure normally done at login — useful when login happened
    offline, or to recover the keypair on a new device. The keypair is held server-side
    (encrypted at rest) and cached locally; a lost local key is recovered rather than
    replaced.
    """
    _hydrate_cli_environment()
    from superclaw.clawhunt_auth import load_clawhunt_auth
    from superclaw.developer_identity import ensure_developer_key_registered

    auth = load_clawhunt_auth()
    result = ensure_developer_key_registered(auth.get("access_token"), auth.get("account_user"))
    if json_output:
        _print_response({"ok": bool(result.get("ok")), "developer_key": result})
        return
    if result.get("ok"):
        typer.echo(f"developer_key=ensured developer_id={result.get('developer_id')} keyid={result.get('keyid') or 'set'}")
    else:
        typer.echo(f"developer_key=not-ensured ({result.get('reason') or result.get('error') or 'unavailable'})")
        raise typer.Exit(1)


@clawhunt_app.command("login-url")
def clawhunt_login_url(
    callback_url: str = typer.Option(..., "--callback-url"),
    provider: str = typer.Option("google", "--provider"),
    invite_code: str | None = typer.Option(None, "--invite-code"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Render the ClawHunt website login URL with the SuperClaw source marker."""
    try:
        login_url = build_clawhunt_browser_login_url(
            base_url=ClawHuntAccountClient().settings.base_url,
            callback_url=callback_url,
            provider=provider,
            invite_code=invite_code,
        )
    except ValueError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, "source": SUPERCLAW_LOGIN_SOURCE, "provider": provider, "login_url": login_url, "callback_url": callback_url}
    if json_output:
        _print_response(payload)
        return
    typer.echo(login_url)


@clawhunt_app.command("exchange-handoff-code")
def clawhunt_exchange_handoff_code(
    handoff_code: str = typer.Option(..., "--handoff-code", prompt=True, hide_input=True),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Exchange a ClawHunt browser handoff code and save the shared CLI/desktop account state."""
    code = handoff_code.strip()
    if not code:
        typer.echo("error: handoff code must be non-empty")
        raise typer.Exit(1)
    try:
        response = ClawHuntAccountClient().exchange_cli_handoff(code)
        access_token, user = extract_login_session(response)
    except (httpx.HTTPError, ValueError) as exc:
        if json_output:
            _print_response({"ok": False, "error": str(exc)})
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    save_clawhunt_auth(
        {
            "access_token": access_token,
            "account_user": user,
            "account_source": "clawhunt_cli_handoff",
            "login_source": SUPERCLAW_LOGIN_SOURCE,
        }
    )
    payload = {"ok": True, "auth": _clawhunt_auth_status_payload(), "user": user}
    if json_output:
        _print_response(payload)
        return
    typer.echo("account=set")
    if user:
        typer.echo(f"account_user={user.get('username') or user.get('email') or user.get('id') or 'set'}")


@clawhunt_app.command("account-agents")
def clawhunt_account_agents(json_output: bool = typer.Option(False, "--json")) -> None:
    """List agents owned by the signed-in ClawHunt account."""
    access_token = _clawhunt_account_token_or_exit()
    try:
        payload = ClawHuntAccountClient().agents(access_token)
    except httpx.HTTPError as exc:
        typer.echo(f"error: {exc.__class__.__name__}")
        raise typer.Exit(1) from exc
    if json_output:
        _print_response(payload)
        return
    body = payload.get("body")
    items = body if isinstance(body, list) else body.get("agents", []) if isinstance(body, dict) else []
    if not items:
        typer.echo("No ClawHunt account agents returned.")
        return
    for item in items:
        if isinstance(item, dict):
            typer.echo(f"{item.get('id')} {item.get('name') or item.get('display_name') or item.get('handle') or 'agent'}")


@clawhunt_app.command("create-agent-key")
def clawhunt_create_agent_key(
    agent_id: int = typer.Option(..., "--agent-id"),
    name: str = typer.Option("SuperClaw Desktop", "--name"),
    permission: list[str] | None = typer.Option(None, "--permission"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Create a ClawHunt agent API key through the signed-in account and save it shared."""
    access_token = _clawhunt_account_token_or_exit()
    permissions = [item.strip() for item in (permission or ["browse", "bid", "post", "solve"]) if item.strip()]
    if not permissions:
        typer.echo("error: at least one --permission is required")
        raise typer.Exit(1)
    try:
        response = ClawHuntAccountClient().create_agent_key(
            access_token,
            name=name.strip() or "SuperClaw Desktop",
            agent_id=agent_id,
            permissions=permissions,
        )
    except httpx.HTTPError as exc:
        typer.echo(f"error: {exc.__class__.__name__}")
        raise typer.Exit(1) from exc
    body = response.get("body")
    key = body.get("key") if isinstance(body, dict) else None
    if not response.get("ok") or not isinstance(key, str) or not key.strip():
        detail = body.get("detail") if isinstance(body, dict) else "agent key creation failed"
        if json_output:
            _print_response({"ok": False, "error": detail, "status_code": response.get("status_code")})
        else:
            typer.echo(f"error: {detail}")
        raise typer.Exit(1)
    key_name = name.strip() or "SuperClaw Desktop"
    save_clawhunt_auth(
        {
            "agent_api_key": key.strip(),
            "agent_key_source": "account",
            "agent_key_name": key_name,
            "agent_id": agent_id,
        }
    )
    payload = {"ok": True, "auth": _clawhunt_auth_status_payload(), "agent_key": {"status": "set", "source": "account", "name": key_name, "agent_id": agent_id}}
    if json_output:
        _print_response(payload)
        return
    typer.echo("agent_api_key=set")
    typer.echo("agent_key_source=account")


@clawhunt_app.command("logout")
def clawhunt_logout(json_output: bool = typer.Option(False, "--json")) -> None:
    """Clear the shared ClawHunt account and agent-key state."""
    clear_clawhunt_auth()
    payload = _clawhunt_auth_status_payload()
    if json_output:
        _print_response(payload)
        return
    _print_clawhunt_auth_status(payload)


def _print_relay_summary(payload: dict[str, Any]) -> None:
    for key, value in payload.items():
        if value is not None:
            typer.echo(f"{key}={value}")


@relay_app.command("status")
def relay_status_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show the clawwork relay-key chain state (always masked, never plaintext)."""
    _hydrate_cli_environment()
    payload = relay_status()
    if json_output:
        _print_response(payload)
        return
    _print_relay_summary(payload)


@relay_app.command("balance")
def relay_balance_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Query the relay account balance via LLMgate /v1/user/balance.

    Uses the resolved relay key (same chain as the rest of clawwork). Masked output:
    balance + currency + active flag + key prefix, never the plaintext key. Fail-closed
    with actionable guidance when no key / no base URL is configured."""
    _hydrate_cli_environment()
    try:
        payload = relay_balance()
    except RelayKeyError as exc:
        if json_output:
            _print_response({"ok": False, "error": str(exc)})
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1)
    if json_output:
        _print_response(payload)
        return
    # 非 json：balance 缺失（服务端未返回数值）时显式显示 unknown，避免该行被静默跳过（顾问）。
    display = dict(payload)
    if display.get("balance") is None:
        display["balance"] = "unknown"
    _print_relay_summary(display)


@relay_app.command("usage")
def relay_usage_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Query this relay key's consumption + quota via LLMgate /v1/user/usage.

    Uses the resolved relay key (same chain as the rest of clawwork). Masked output:
    this key's credits used + quota limit (0 = unlimited) + account balance + active
    flag + key prefix, never the plaintext key. Fail-closed with actionable guidance
    when no key / no base URL is configured."""
    _hydrate_cli_environment()
    try:
        payload = relay_usage()
    except RelayKeyError as exc:
        if json_output:
            _print_response({"ok": False, "error": str(exc)})
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1)
    if json_output:
        _print_response(payload)
        return
    # 非 json：三个数值字段缺失（服务端未返回）时显式显示 unknown，避免该行被静默跳过（顾问）。
    display = dict(payload)
    for field in ("key_credits_used", "key_quota_limit", "account_balance"):
        if display.get(field) is None:
            display[field] = "unknown"
    _print_relay_summary(display)


@relay_app.command("account")
def relay_account_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show the normalized account overview: purchased package vs effective
    entitlement vs self-funded relay usage, as distinct sources.

    Single source with the Web settings panel / ``GET /api/relay/account``: all call
    the kernel ``account_overview()``. ``billing_plan`` = the v18 card-pack you bought
    (basic/standard/advanced, or none); ``entitlement`` + ``entitlement_source`` = what
    you can use now and why (admin/trial/grant/subscription/payg/free — so an admin's
    unlimited bypass is never shown as a purchased package); ``relay`` = your
    self-funded LLMgate usage. Best-effort, never prints the plaintext token/key."""
    from superclaw.relay_key import account_overview

    _hydrate_cli_environment()
    payload = account_overview()
    if json_output:
        _print_response(payload)
        return
    relay = payload.get("relay") or {}
    flat = {
        "logged_in": payload.get("logged_in"),
        "billing_plan": payload.get("billing_plan") or "none",
        "entitlement": payload.get("entitlement"),
        "entitlement_source": payload.get("entitlement_source"),
        "unlimited": payload.get("unlimited"),
        "free_chats_remaining": payload.get("free_chats_remaining"),
        "free_chat_limit": payload.get("free_chat_limit"),
        "chat_credits": payload.get("chat_credits"),
        "relay_account_balance": relay.get("account_balance") if relay.get("ok") else "unavailable",
    }
    _print_relay_summary(flat)


@relay_app.command("packages")
def relay_packages_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """List the SuperClaw packages (套餐) offered by the relay's super groups.

    After ClawHunt login, this shows the configured tiers (core/plus/max…) the
    super grouping exposes — NOT the relay's raw model ids. Priority: dynamic
    catalog (/api/v1/bridge/packages) → groups (/api/v1/groups) → built-in
    defaults. Fail-safe: any relay/network error degrades to the default tiers
    rather than erroring. ``available`` reflects whether you are logged in with a
    usable relay key."""
    _hydrate_cli_environment()
    payload = relay_packages()
    if json_output:
        _print_response(payload)
        return
    packages = payload.get("packages") or []
    source = payload.get("source", "default")
    available = "yes" if payload.get("available") else "no (login required)"
    typer.echo(f"packages (source={source}, available={available}):")
    if not packages:
        typer.echo("  (none)")
        return
    width = max((len(str(p.get("id", ""))) for p in packages), default=4)
    for package in packages:
        pid = str(package.get("id", ""))
        name = str(package.get("name", "")) or pid
        typer.echo(f"  - {pid.ljust(width)}  {name}")


@relay_app.command("package-models")
def relay_package_models_cmd(
    tier: str = typer.Argument(..., help="Package tier: core / plus / max"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List the concrete models inside one package tier (core/plus/max).

    Single source with the Web composer's second-level model picker and
    ``GET /api/relay/packages/{tier}/models``: all call the kernel
    ``relay_package_models(tier)``, which binds the relay key to the tier (reusing
    the per-(account,tier) cache) and queries LLMgate ``/v1/models`` — group-narrowed,
    so the result is the ``superclaw-{tier}`` group's models. Fail-closed with
    actionable guidance when the tier is invalid / no key / unreachable."""
    from superclaw.relay_key import relay_package_models

    _hydrate_cli_environment()
    try:
        payload = relay_package_models(tier)
    except RelayKeyError as exc:
        if json_output:
            _print_response({"ok": False, "error": str(exc)})
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1)
    if json_output:
        _print_response(payload)
        return
    models = payload.get("models") or []
    typer.echo(f"{payload.get('tier')} ({payload.get('group_slug')}) models:")
    if not models:
        typer.echo("  (none)")
        return
    for mid in models:
        typer.echo(f"  - {mid}")


@relay_app.command("ensure-key")
def relay_ensure_key_cmd(
    tier: str = typer.Option("", "--tier", help="套餐档位（core/plus/max）；留空则跟随账号解锁上限"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Idempotently provision this device's clawwork relay key via the ClawHunt bridge.

    Chain: SUPERCLAW_RELAY_API_KEY env override → cached auto key → exchange the
    saved ClawHunt login for a scoped bridge token and mint a quota-capped key.

    档位（issue #452）：``--tier`` 指定套餐，使 key 绑定 ``superclaw-{tier}`` 分组（计费倍率 +
    模型路由）；留空跟随账号解锁上限（登录即默认已购档位）。越级（超过解锁上限）fail-closed
    拒绝并引导升级。Fail-closed with actionable guidance when none of these is possible."""
    _hydrate_cli_environment()
    from superclaw.relay_key import (
        cached_tier_ceiling,
        check_tier_within_ceiling,
        refresh_tier_ceiling,
    )

    # 先刷新一次解锁上限（登录/升级后让本地 ceiling 与账号一致），再决定默认档与越级 clamp。
    refresh_tier_ceiling()
    selected = tier.strip().lower() or (cached_tier_ceiling() or "")
    if selected:
        allowed, ceiling, _norm = check_tier_within_ceiling(selected)
        if not allowed:
            err = (
                f"TIER_NOT_UNLOCKED: 当前账号解锁上限为 {ceiling}，无法发放 {selected} 档；"
                f"请在 ClawHunt 升级套餐，或改用 ≤{ceiling} 的档位。"
            )
            if json_output:
                _print_response({"ok": False, "error": err})
            else:
                typer.echo(f"error: {err}")
            raise typer.Exit(1)
    try:
        summary = ensure_relay_key(tier=selected or None)
    except RelayKeyError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1)
    if json_output:
        _print_response(summary)
        return
    _print_relay_summary(summary)


@relay_app.command("rotate-key")
def relay_rotate_key_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Rotate the auto-provisioned relay key (new key first, old keys revoked server-side)."""
    _hydrate_cli_environment()
    try:
        summary = ensure_relay_key(rotate=True)
    except RelayKeyError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1)
    if json_output:
        _print_response(summary)
        return
    _print_relay_summary(summary)


@relay_app.command("clear-key")
def relay_clear_key_cmd(json_output: bool = typer.Option(False, "--json")) -> None:
    """Forget the locally cached relay key (local only; rotate to revoke remotely)."""
    had = clear_relay_key()
    payload = {"cleared": had, **relay_status()}
    if json_output:
        _print_response(payload)
        return
    _print_relay_summary(payload)


def _exit_on_facet_problems(
    *,
    category: str = "",
    origin: str = "",
    availability: str = "",
    integration: str = "",
) -> None:
    problems = validate_facets(
        category=category or None,
        origin=origin or None,
        availability=availability or None,
        integration=integration or None,
    )
    if problems:
        for problem in problems:
            typer.echo(f"error: {problem}")
        raise typer.Exit(1)


@capability_app.command("summary")
def capability_summary() -> None:
    """Print capability atlas totals by category, origin, availability, and integration."""
    _print_response(atlas_summary())


@capability_app.command("list")
def capability_list(
    category: str = typer.Option("", "--category"),
    origin: str = typer.Option("", "--origin"),
    availability: str = typer.Option("", "--availability"),
    integration: str = typer.Option("", "--integration"),
) -> None:
    """List capability units, optionally filtered."""
    _exit_on_facet_problems(category=category, origin=origin, availability=availability, integration=integration)
    units = search_capabilities(
        category=category or None,
        origin=origin or None,
        availability=availability or None,
        integration=integration or None,
    )
    _print_response({"total": len(units), "capabilities": [unit.to_dict() for unit in units]})


@capability_app.command("show")
def capability_show(capability_id: str) -> None:
    """Show one capability unit by id."""
    try:
        _print_response(get_capability(capability_id).to_dict())
    except KeyError as exc:
        typer.echo(f"error: {exc.args[0]}")
        raise typer.Exit(1) from exc


@capability_app.command("search")
def capability_search(
    query: str,
    category: str = typer.Option("", "--category"),
    availability: str = typer.Option("", "--availability"),
) -> None:
    """Search capability ids, names, descriptions, and triggers."""
    _exit_on_facet_problems(category=category, availability=availability)
    units = search_capabilities(query, category=category or None, availability=availability or None)
    _print_response({"query": query, "total": len(units), "capabilities": [unit.to_dict() for unit in units]})


@capability_app.command("suggest")
def capability_suggest(
    goal: str,
    limit: int = typer.Option(8, "--limit"),
) -> None:
    """Rank capability units against free-form goal text for run planning."""
    _print_response({"goal": goal, "suggestions": suggest_capabilities(goal, limit=limit)})


@capability_app.command("coverage")
def capability_coverage() -> None:
    """Report availability coverage with declared gaps and external dependencies."""
    _print_response(coverage_report())


@capability_app.command("matrix")
def capability_matrix_command() -> None:
    """Print the category x availability capability matrix."""
    _print_response({"matrix": category_matrix()})


@capability_app.command("adaptable")
def capability_adaptable(
    target: str = typer.Option("", "--target", help="Optional harness target to annotate adapt notes"),
) -> None:
    """List units eligible for the harness adapt/emit pipeline."""
    units = adaptable_capabilities()
    payload: dict[str, Any] = {"total": len(units), "capabilities": [unit.to_dict() for unit in units]}
    if target:
        try:
            profile = get_harness_profile(target)
        except KeyError as exc:
            typer.echo(f"error: {exc.args[0]}")
            raise typer.Exit(1) from exc
        payload["target"] = profile.to_dict()
    _print_response(payload)


@capability_app.command("submit")
def capability_submit(
    kind: str = typer.Argument(..., help="Capability kind: plugin, skill, or company"),
    artifact_path: Path = typer.Argument(..., help="Local package/artifact path to upload into the local submission store"),
    submission_root: Path | None = typer.Option(
        None,
        "--submission-root",
        help="Local capability submission store",
    ),
    smoke_timeout_seconds: float | None = typer.Option(None, "--smoke-timeout-seconds"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Run local developer submission gates for plugin, skill, or company artifacts."""
    root = submission_root or _capability_submission_path()
    try:
        result = submit_developer_capability_upload(
            kind,
            artifact_path,
            submission_root=root,
            smoke_timeout_seconds=smoke_timeout_seconds,
        )
    except (DeveloperCapabilitySubmissionError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {
        "ok": result.ready_for_review,
        "submission_id": result.submission_id,
        "kind": result.kind,
        "capability_id": result.capability_id,
        "version": result.version,
        "status": result.status,
        "review_record_status": result.record.get("status"),
        "ready_for_review": result.ready_for_review,
        "artifact_blob_digest": result.artifact_blob_digest,
        "review_path": str(result.review_path),
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        typer.echo(f"{key}={value}")
    if not result.ready_for_review:
        raise typer.Exit(1)


@capability_app.command("submit-company")
def capability_submit_company(
    capability_id: str = typer.Option(..., "--capability-id", help="Marketplace publish id (lowercase slug)"),
    version: str = typer.Option(..., "--version", help="Publish version MAJOR.MINOR.PATCH"),
    from_company: str | None = typer.Option(
        None, "--from-company", help="Export a live Paperclip company by id via the co-launched Node"
    ),
    bundle: Path | None = typer.Option(
        None, "--bundle", help="A pre-exported CompanyPortability bundle directory (contains COMPANY.md)"
    ),
    node_base_url: str | None = typer.Option(
        None, "--node-base-url", help="Override the co-launched Node base URL (else auto-discovered)"
    ),
    submission_root: Path | None = typer.Option(None, "--submission-root", help="Local capability submission store"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Submit a company as a Paperclip CompanyPortability bundle (round-trips with workshop import).

    Provide EXACTLY ONE source: ``--from-company <id>`` exports a live company via the
    co-launched Node, or ``--bundle <dir>`` uses a pre-exported portability bundle. The
    legacy ``superclaw-company.json`` template path remains ``capability submit company <template>``.
    """
    import shutil
    import tempfile

    from superclaw.capability_submission import submit_company_portability_upload
    from superclaw.company_portability_loopback import (
        CompanyExportLoopbackError,
        export_company_portability,
        freeze_export_to_dir,
        make_preview_fn,
        resolve_node_base_url,
    )

    def _fail(message: str) -> None:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        else:
            typer.echo(f"error: {message}")
        raise typer.Exit(1)

    if bool(from_company) == bool(bundle):
        _fail("provide exactly one of --from-company or --bundle")

    root = submission_root or _capability_submission_path()
    try:
        base_url = resolve_node_base_url(node_base_url)
    except CompanyExportLoopbackError as exc:
        _fail(str(exc))
        return
    if base_url is None:
        _fail("no co-launched Node server found; start it (superclaw serve) or pass --node-base-url")
    preview_fn = make_preview_fn(base_url)  # type: ignore[arg-type]

    workdir = Path(tempfile.mkdtemp(prefix="cosub-portability-"))
    try:
        if from_company:
            export_result = export_company_portability(from_company, base_url=base_url)  # type: ignore[arg-type]
            bundle_dir = freeze_export_to_dir(export_result, workdir / "bundle")
        else:
            bundle_dir = Path(bundle)  # type: ignore[arg-type]
            if not bundle_dir.is_dir():
                _fail(f"--bundle is not a directory: {bundle_dir}")
        result = submit_company_portability_upload(
            bundle_dir,
            capability_id=capability_id,
            version=version,
            submission_root=root,
            preview_fn=preview_fn,
        )
    except (CompanyExportLoopbackError, DeveloperCapabilitySubmissionError, OSError, ValueError) as exc:
        _fail(str(exc))
        return
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    payload = {
        "ok": result.ready_for_review,
        "submission_id": result.submission_id,
        "kind": result.kind,
        "capability_id": result.capability_id,
        "version": result.version,
        "status": result.status,
        "company_source_format": "portability",
        "ready_for_review": result.ready_for_review,
        "artifact_blob_digest": result.artifact_blob_digest,
        "review_path": str(result.review_path),
    }
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
    else:
        for key, value in payload.items():
            typer.echo(f"{key}={value}")
    if not result.ready_for_review:
        raise typer.Exit(1)


@capability_app.command("submission-status")
def capability_submission_status(
    submission_id: str = typer.Argument(..., help="Local capability submission id"),
    submission_root: Path | None = typer.Option(
        None,
        "--submission-root",
        help="Local capability submission store",
    ),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Read a local capability developer-submission review record."""
    root = submission_root or _capability_submission_path()
    try:
        record = get_developer_capability_submission(submission_id, submission_root=root)
    except DeveloperCapabilitySubmissionError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, "submission": record}, ensure_ascii=False))
        return
    for key in ("submission_id", "kind", "capability_id", "version", "status", "ready_for_review"):
        typer.echo(f"{key}={record.get(key)}")


@capability_workshop_app.command("validate")
def capability_workshop_validate(
    kind: str = typer.Argument(..., help="Capability kind: plugin, skill, or company"),
    artifact_path: Path = typer.Argument(..., help="Capability package directory or deterministic archive"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Validate developer capability package metadata without submitting it."""
    try:
        metadata = validate_capability_artifact(kind, artifact_path)
    except (CapabilityDevtoolError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, **metadata.to_dict()}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key in ("kind", "capability_id", "version", "artifact_digest", "package_format"):
        typer.echo(f"{key}={payload[key]}")


@capability_workshop_app.command("build")
def capability_workshop_build(
    kind: str = typer.Argument(..., help="Capability kind: plugin, skill, or company"),
    artifact_path: Path = typer.Argument(..., help="Source package directory or artifact"),
    dist_dir: Path = typer.Option(Path("dist"), "--dist-dir"),
    dev_sign_plugin: bool = typer.Option(False, "--dev-sign-plugin", help="Generate a throwaway development signature for plugin packages only"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Build a deterministic local capability package for digest pinning."""
    try:
        result = build_capability_artifact(kind, artifact_path, dist_dir=dist_dir, dev_sign_plugin=dev_sign_plugin)
    except (CapabilityDevtoolError, PluginDevkitError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = {"ok": True, **result.to_dict()}
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key in ("kind", "capability_id", "version", "artifact_digest", "package_path"):
        typer.echo(f"{key}={payload[key]}")


def _resolve_workshop_signing_key() -> str | None:
    """Recover the developer's escrowed signing key for a workshop upload.

    Returns the ``ed25519:<base64>`` private material, or None when no key can be
    obtained. Reads the locally-cached escrowed key first; if absent, performs a
    lazy best-effort ensure from the saved ClawHunt login (mirroring the login-time
    hook) so a first upload right after login still signs. The private material is
    returned for in-process signing only and is never logged.
    """
    from superclaw.developer_identity import (
        _read_local_key_material,
        developer_key_path,
        ensure_developer_key_registered,
    )

    path = developer_key_path()
    # Reuse developer_identity's reader rather than a raw read_text: it self-heals
    # over-broad (0644) key permissions, validates the ed25519 format, and returns
    # None for a corrupt/unreadable key so we fall through to lazy ensure to recover
    # the authoritative escrowed pair instead of signing with garbage.
    material = _read_local_key_material(path)
    if material is not None:
        return material[0]
    # Lazy ensure from the saved login (best-effort; the escrow call recovers the
    # account's canonical pair and caches it locally for offline signing).
    from superclaw.clawhunt_auth import load_clawhunt_auth

    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if token:
        ensure_developer_key_registered(token, auth.get("account_user"))
        material = _read_local_key_material(path)
        if material is not None:
            return material[0]
    return None


@capability_workshop_app.command("submit-review")
def capability_workshop_submit_review(
    kind: str = typer.Argument(..., help="Capability kind: plugin, skill, or company"),
    artifact_path: Path = typer.Argument(..., help="Built package or source artifact to identify"),
    api_url: str = typer.Option(..., "--api-url", help="Capability review API base URL"),
    artifact_ref: str = typer.Option(..., "--artifact-ref", help="Opaque object-store artifact reference, never a local path"),
    developer_ref: str | None = typer.Option(None, "--developer-ref", help="Opaque developer/account reference"),
    sign: bool = typer.Option(
        True,
        "--sign/--no-sign",
        help="Sign the submission with your escrowed developer key (recovered via ClawHunt login). --no-sign submits unsigned.",
    ),
    timeout_seconds: float = typer.Option(10.0, "--timeout-seconds"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Submit immutable capability metadata and artifact reference for review."""
    try:
        signing_private_key: str | None = None
        if sign:
            # Inside the try: a lazy-ensure OSError / corrupt-cache read must surface as
            # a clean error line, never a raw traceback.
            signing_private_key = _resolve_workshop_signing_key()
            if not signing_private_key:
                raise CapabilityDevtoolError(
                    "no developer signing key available — run 'superclaw clawhunt "
                    "account-login' first (it provisions your escrowed signing key), "
                    "or pass --no-sign to submit unsigned"
                )
        result = submit_capability_for_review(
            kind,
            artifact_path,
            api_url=api_url,
            artifact_ref=artifact_ref,
            developer_ref=developer_ref,
            signing_private_key=signing_private_key,
            timeout_seconds=timeout_seconds,
        )
    except (CapabilityDevtoolError, httpx.HTTPError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    payload = result.to_dict()
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for key in ("ok", "submission_id", "status"):
        typer.echo(f"{key}={payload.get(key)}")


@capability_workshop_app.command("review-status")
def capability_workshop_review_status(
    submission_id: str = typer.Argument(..., help="Review submission id from the Capability Workshop API"),
    api_url: str = typer.Option(..., "--api-url", help="Capability review API base URL"),
    timeout_seconds: float = typer.Option(10.0, "--timeout-seconds"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Query Capability Workshop review state without changing approval status."""
    try:
        payload = query_capability_review_status(submission_id, api_url=api_url, timeout_seconds=timeout_seconds)
    except (CapabilityDevtoolError, httpx.HTTPError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps({"ok": True, "submission": payload}, ensure_ascii=False))
        return
    for key in ("submission_id", "kind", "capability_id", "version", "status", "review_status"):
        if key in payload:
            typer.echo(f"{key}={payload.get(key)}")


@capability_workshop_app.command("install")
def capability_workshop_install(
    capability_id: str = typer.Argument(..., help="Published capability id (e.g. acme.tool or skill.demo)"),
    version: str = typer.Argument(..., help="Exact published version (digest-bound to one published entry)"),
    kind: str = typer.Option("plugin", "--kind", help="Capability kind: plugin | skill | company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Download a published capability and land it via the co-launched Node S4 super-workshop.

    The kernel bridge resolves everything from the running environment (the loopback Node base
    URL, the baked official co-signature key, the 0600 receipt key file, and the app env), so
    only the identity is required here — this is the kernel/CLI baseline the API/Web surfaces
    mirror. Fail-closed on: not published / not officially co-signed / unresolvable artifact /
    download or digest/identity mismatch / no co-launched Node / receipt key not provisioned /
    Node import rejected.
    """
    from superclaw.capability_workshop_install_bridge import (
        WorkshopInstallBridgeError,
        install_published_capability,
    )

    try:
        # The bridge returns the stable kernel envelope:
        #   {ok, kind, capability_id, version, package_digest, outcome: <node outcome>}
        # where the nested `outcome` carries the Node import result (nativeId/official/...).
        result = install_published_capability(kind, capability_id, version)
    except WorkshopInstallBridgeError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        # Emit the kernel envelope verbatim — do NOT re-wrap (the API/Web surfaces mirror this).
        typer.echo(json.dumps(result, ensure_ascii=False))
        return
    typer.echo(f"installed {result['kind']} {result['capability_id']}@{result['version']}")
    if result.get("package_digest"):
        typer.echo(f"digest={result['package_digest']}")
    node_outcome = result.get("outcome")
    if isinstance(node_outcome, dict):
        if node_outcome.get("nativeId"):
            typer.echo(f"nativeId={node_outcome['nativeId']}")
        typer.echo(f"official={node_outcome.get('official')}")


@capability_workshop_app.command("installed")
def capability_workshop_installed(
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List capabilities the co-launched Node S4 super-workshop has landed (loopback read).

    Degraded (empty + node_available=false) when Node was never co-launched or its loopback read
    fails — never a silent "nothing installed". The API surface (`/api/capabilities/installed`)
    additionally unions the legacy Python plugin cache; this CLI baseline shows the Node store.
    """
    from superclaw.capability_workshop_installed import list_installed_node_capabilities

    capabilities, node_available = list_installed_node_capabilities()
    if json_output:
        typer.echo(json.dumps({"capabilities": capabilities, "node_available": node_available}, ensure_ascii=False))
        return
    if not node_available:
        typer.echo("node_available=false (no co-launched Node or loopback read degraded)")
        return
    if not capabilities:
        typer.echo("no node-installed capabilities")
        return
    for cap in capabilities:
        typer.echo(f"{cap['kind']} {cap['native_key']}@{cap.get('version')} official={cap['official']}")


@capability_workshop_app.command("uninstall")
def capability_workshop_uninstall(
    native_key: str = typer.Argument(..., help="Node native key (pluginKey) of the installed capability"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Uninstall a Node-S4-landed capability by its native key (loopback DELETE). Fail-closed:
    no co-launched Node / non-2xx -> error exit (never a false success)."""
    from superclaw.capability_workshop_installed import (
        WorkshopInstalledReadError,
        uninstall_node_capability,
    )

    try:
        result = uninstall_node_capability(native_key)
    except WorkshopInstalledReadError as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(result, ensure_ascii=False))
        return
    typer.echo(f"uninstalled {native_key}")


@capability_workshop_app.command("sync-registry")
def capability_workshop_sync_registry(
    source: str = typer.Argument(..., help="Approved registry JSON file, file:// URL, HTTPS URL, or r2://bucket/key"),
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root"),
    include_revoked: bool = typer.Option(False, "--include-revoked"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Sync approved registry metadata without mutating approved artifacts."""
    try:
        payload = sync_approved_capability_registry(source, cloud_root=cloud_root, include_revoked=include_revoked)
    except (CapabilityDevtoolError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"synced={payload['count']}")
    for item in payload["synced"]:
        typer.echo(f"{item['kind']} {item['capability_id']}@{item['version']} digest={item['package_digest']}")


@capability_workshop_app.command("list-registry")
def capability_workshop_list_registry(
    source: str = typer.Argument(..., help="Approved registry JSON file, file:// URL, HTTPS URL, or r2://bucket/key"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List approved plugin, skill, and company registry metadata."""
    try:
        payload = list_approved_capability_registry(source)
    except (CapabilityDevtoolError, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    if not payload["items"]:
        typer.echo("No approved capability registry items.")
        return
    for item in payload["items"]:
        typer.echo(f"{item['kind']} {item['capability_id']}@{item['version']} digest={item['package_digest']}")


@capability_workshop_app.command("publish-r2")
def capability_workshop_publish_r2(
    cloud_root: Path = typer.Option(DEFAULT_CLOUD_ROOT, "--cloud-root"),
    env_file: Path = typer.Option(Path("~/.config/superclaw/cloudflare-r2.env").expanduser(), "--env-file"),
    prefix: str = typer.Option("", "--prefix", help="Optional R2 object key prefix, e.g. smoke/20260617"),
    registry_key: str = typer.Option("capabilities.json", "--registry-key"),
    registry_bucket: str | None = typer.Option(None, "--registry-bucket"),
    artifact_bucket: str | None = typer.Option(None, "--artifact-bucket"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Publish approved local capability registry/artifacts to private Cloudflare R2."""
    try:
        config = load_r2_config(env_file=env_file, registry_bucket=registry_bucket, artifact_bucket=artifact_bucket)
        payload = publish_local_capability_cloud_to_r2(
            cloud_root,
            config=config,
            prefix=prefix,
            registry_key=registry_key,
            dry_run=dry_run,
        )
    except (CapabilityR2Error, OSError, ValueError) as exc:
        if json_output:
            typer.echo(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    registry = payload["registry"]
    typer.echo(f"registry=r2://{registry['bucket']}/{registry['key']}")
    typer.echo(f"artifacts={payload['artifact_count']}")
    if payload.get("dry_run"):
        typer.echo("dry_run=true")


@capability_app.command("doctor")
def capability_doctor() -> None:
    """Validate the packaged capability atlas data file."""
    try:
        units = load_capability_atlas()
    except CapabilityAtlasError as exc:
        _print_response({"ok": False, "error": str(exc)})
        raise typer.Exit(1) from exc
    _print_response({"ok": True, "total": len(units), "summary": atlas_summary(atlas=units)})


@clawhunt_app.command()
def browse(
    skip: int = typer.Option(0, "--skip", min=0, help="Number of problems to skip (pagination offset)."),
    limit: int = typer.Option(50, "--limit", min=1, max=50, help="Maximum problems to return (ClawHunt caps at 50)."),
    status: str | None = typer.Option(None, "--status", help="Filter by problem status, e.g. open."),
    public: bool | None = typer.Option(
        None,
        "--public/--agent",
        help="Force the public anonymous marketplace (--public, no agent key needed) or your agent-gated "
        "personalized view (--agent, needs a linked key). Default is auto, matching the web dock: agent view "
        "when a key is linked, public view otherwise.",
    ),
) -> None:
    """Browse ClawHunt problems."""
    normalized_status = status.strip() if status else None
    response = ClawHuntClient().browse_marketplace(
        skip=skip, limit=limit, status=normalized_status, public=public
    )
    _print_response(response)


@clawhunt_app.command()
def detail(
    problem_id: int,
    public: bool | None = typer.Option(
        None,
        "--public/--agent",
        help="Force public anonymous detail (--public) or the agent-gated detail (--agent, may expose "
        "post-claim private fields). Default is auto: agent detail when a key is linked, public otherwise.",
    ),
) -> None:
    """Read one ClawHunt problem."""
    _print_response(ClawHuntClient().get_problem_marketplace(problem_id, public=public))


@clawhunt_app.command("post")
def post_problem(
    title: str = typer.Option(..., "--title"),
    description: str = typer.Option(..., "--description"),
    price: int = typer.Option(1, "--price"),
    category: str = typer.Option("testing", "--category"),
    difficulty: str = typer.Option("easy", "--difficulty"),
    routing_mode: str = typer.Option("tiered_overflow", "--routing-mode"),
    target_agent_id: int | None = typer.Option(None, "--target-agent-id"),
) -> None:
    """Post a ClawHunt problem draft."""
    payload: dict[str, Any] = {
        "title": title,
        "description": description,
        "price": price,
        "category": category,
        "difficulty": difficulty,
        "routing_mode": routing_mode,
    }
    if target_agent_id is not None:
        payload["target_agent_id"] = target_agent_id
    _print_response(ClawHuntClient().post_problem(payload))


_LEGACY_CLAWHUNT_WRITE_ENV = "SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE"


def _legacy_clawhunt_gate(governed: str) -> None:
    """Fail-closed gate disabling a legacy direct-write command by default.

    The legacy ``clawhunt bid/claim/submit`` call ClawHunt directly, bypassing the
    marketplace order ledger + human approval gate + evidence/completion gating —
    an ungoverned write path (advisor阻断项 6, Codex+AGY: a stderr warning is not
    governance; the path must be CLOSED). So it is DISABLED by default: the command
    fails directing the operator to the governed ``superclaw marketplace …`` path.
    A deliberate operator override remains via the explicit env opt-in
    ``SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1`` (still warned), so a human who truly
    needs the raw escape hatch can take it — but no automation/script silently
    bypasses governance.
    """
    if os.environ.get(_LEGACY_CLAWHUNT_WRITE_ENV) == "1":
        typer.echo(
            f"[legacy override] direct ClawHunt write enabled via "
            f"{_LEGACY_CLAWHUNT_WRITE_ENV}=1; bypasses the marketplace ledger + "
            f"approval gate. Prefer `{governed}`.",
            err=True,
        )
        return
    _fail(
        f"this direct ClawHunt write is disabled (it bypasses the marketplace order "
        f"ledger + human approval + evidence gate). Use `{governed}`. To override "
        f"deliberately, set {_LEGACY_CLAWHUNT_WRITE_ENV}=1."
    )


@clawhunt_app.command()
def bid(
    problem_id: int,
    amount: int | None = typer.Option(None, "--amount"),
    message: str = typer.Option("", "--message"),
) -> None:
    """[legacy] Bid on a ClawHunt problem (direct; prefer `superclaw marketplace bid`)."""
    _legacy_clawhunt_gate("superclaw marketplace bid")
    _print_response(ClawHuntClient().bid(problem_id, amount=amount, message=message))


@clawhunt_app.command()
def claim(problem_id: int) -> None:
    """[legacy] Claim a ClawHunt problem (direct; prefer `superclaw marketplace claim`)."""
    _legacy_clawhunt_gate("superclaw marketplace claim --company <id>")
    _print_response(ClawHuntClient().claim(problem_id))


@clawhunt_app.command()
def accept(problem_id: int) -> None:
    """[legacy] Accept a submitted ClawHunt solution directly (buyer/payment-side).

    Disabled by default — accepting a solution is a buyer/payment-side write that
    bypasses governance; set SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1 to override.
    """
    _legacy_clawhunt_gate("the governed marketplace flow")
    _print_response(ClawHuntClient().accept(problem_id))


@clawhunt_app.command("accept-bid")
def accept_bid(problem_id: int, bid_id: int) -> None:
    """[legacy] Accept a ClawHunt bid directly (buyer/payment-side).

    Disabled by default — paying out a bid is a buyer/payment-side write that
    bypasses governance; set SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1 to override.
    """
    _legacy_clawhunt_gate("the governed marketplace flow")
    _print_response(ClawHuntClient().accept_bid(problem_id, bid_id))


@clawhunt_app.command("bids")
def bids(problem_id: int) -> None:
    """List bids for a ClawHunt problem."""
    _print_response(ClawHuntClient().get_problem_bids(problem_id))


@clawhunt_app.command("submit")
def submit_solution(problem_id: int, run_id: str) -> None:
    """[legacy] Submit a stored evidence bundle to ClawHunt directly.

    Prefer the governed `superclaw marketplace submit <order_id>` — it submits a
    claimed order's evidence only after the delivery passed its issue completion
    gate, behind a human approval, with the order ledger tracking the lifecycle.
    This direct form bypasses all of that and is kept only as an operator escape hatch.
    """
    _legacy_clawhunt_gate("superclaw marketplace submit <order_id>")
    submit(problem_id, run_id)


@clawhunt_app.command("export-protocol")
def clawhunt_export_protocol(
    run_id: str,
    github_pr_url: str | None = typer.Option(None, "--github-pr-url"),
    github_pr_number: int | None = typer.Option(None, "--github-pr-number"),
) -> None:
    """Export a stored run as a ClawHunt Delivery Protocol payload."""
    export_protocol(run_id, github_pr_url=github_pr_url, github_pr_number=github_pr_number)


@clawhunt_app.command()
def wallet() -> None:
    """Read ClawHunt wallet status."""
    _print_response(ClawHuntClient().wallet())


@clawhunt_app.command("capability-probe")
def capability_probe() -> None:
    """Read ClawHunt capability-probe status."""
    _print_response(ClawHuntClient().capability_probe_status())


@clawhunt_app.command("live-readiness")
def live_readiness(
    authenticated_read: bool = typer.Option(False, "--authenticated-read", help="Also summarize GET-only authenticated ClawHunt surfaces."),
    require_payment: bool = typer.Option(False, "--require-payment", help="Treat Pay-Switch path failures as blocking."),
    no_probe: bool = typer.Option(False, "--no-probe", help="Omit raw unauthenticated probe payloads from output."),
    fail_on_partial: bool = typer.Option(False, "--fail-on-partial", help="Exit nonzero for partial readiness as well as blocked readiness."),
) -> None:
    """Run a non-mutating ClawHunt production readiness gate."""
    report = ClawHuntClient().live_readiness_report(
        authenticated_read=authenticated_read,
        require_payment=require_payment,
        include_probe=not no_probe,
    )
    _print_response(report)
    if report["status"] == "blocked" or (fail_on_partial and report["status"] == "partial"):
        raise typer.Exit(1)


@clawhunt_app.command()
def me() -> None:
    """Read the current ClawHunt agent profile."""
    _print_response(ClawHuntClient().me())


@clawhunt_app.command()
def skills() -> None:
    """Read ClawHunt skills."""
    _print_response(ClawHuntClient().skills())


@clawhunt_app.command()
def memories() -> None:
    """Read ClawHunt memories."""
    _print_response(ClawHuntClient().memories())


@clawhunt_app.command()
def subtasks(problem_id: int) -> None:
    """Read ClawHunt subtasks for a problem."""
    _print_response(ClawHuntClient().subtasks(problem_id))




# --- Company secrets + instance settings（Paperclip 拿取清单 §6，本地 v1） -----


def _read_secret_value(value: str | None, use_stdin: bool) -> str:
    """Collect the plaintext without ever echoing it. Priority: --stdin > --value
    > hidden interactive prompt. --value is discouraged (shell history)."""
    if use_stdin:
        # Strip ONLY one trailing newline (the echo/pipe artifact). Anything
        # else — multi-line private keys, meaningful whitespace — is the value.
        raw = sys.stdin.read()
        return raw[:-1] if raw.endswith("\n") else raw
    if value is not None:
        return value
    return typer.prompt("Secret value", hide_input=True)


def _print_secret_summary(summary: dict[str, Any]) -> None:
    for key in ("secret_id", "name", "provider", "current_version", "archived", "description"):
        typer.echo(f"{key}={summary.get(key)}")


@secret_app.command("create")
def secret_create(
    name: str = typer.Argument(..., help="Unique secret name within the company"),
    value: str | None = typer.Option(None, "--value", help="Plaintext value (discouraged: lands in shell history; prefer --stdin or the hidden prompt)"),
    stdin: bool = typer.Option(False, "--stdin", help="Read the value from stdin"),
    description: str = typer.Option("", "--description"),
    company: str = typer.Option("local", "--company", help="Company profile id"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Create a secret (encrypted at rest; the plaintext is never echoed back)."""
    from superclaw.secrets_store import SecretStoreError, create_secret

    try:
        summary = create_secret(
            _team_store(), name=name, value=_read_secret_value(value, stdin),
            company_profile_id=company, description=description,
        )
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(summary, ensure_ascii=False)) if json_output else _print_secret_summary(summary)


@secret_app.command("list")
def secret_list(
    company: str | None = typer.Option(None, "--company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List secrets (masked ledger view only)."""
    from superclaw.secrets_store import list_secret_summaries

    summaries = list_secret_summaries(_team_store(), company_profile_id=company)
    if json_output:
        typer.echo(json.dumps(summaries, ensure_ascii=False))
        return
    if not summaries:
        typer.echo("no secrets")
        return
    for summary in summaries:
        flag = " [archived]" if summary["archived"] else ""
        typer.echo(f"{summary['name']} v{summary['current_version']} ({summary['provider']}){flag}")


@secret_app.command("rotate")
def secret_rotate(
    name: str = typer.Argument(...),
    value: str | None = typer.Option(None, "--value"),
    stdin: bool = typer.Option(False, "--stdin"),
    company: str = typer.Option("local", "--company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Store a new version of the secret (old versions stay decryptable for audit)."""
    from superclaw.secrets_store import SecretStoreError, rotate_secret

    try:
        summary = rotate_secret(
            _team_store(), name=name, value=_read_secret_value(value, stdin), company_profile_id=company
        )
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(summary, ensure_ascii=False)) if json_output else _print_secret_summary(summary)


@secret_app.command("archive")
def secret_archive(
    name: str = typer.Argument(...),
    restore: bool = typer.Option(False, "--restore", help="Un-archive instead"),
    company: str = typer.Option("local", "--company"),
) -> None:
    """Archive a secret (fail-closed: archived secrets never resolve; required
    bindings on it make their target NOT invokable). --restore reverses it."""
    from superclaw.secrets_store import SecretStoreError, set_secret_archived

    try:
        summary = set_secret_archived(
            _team_store(), name=name, archived=not restore, company_profile_id=company
        )
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    _print_secret_summary(summary)


@secret_app.command("delete")
def secret_delete(
    name: str = typer.Argument(...),
    yes: bool = typer.Option(False, "--yes", help="Skip the confirmation prompt"),
    company: str = typer.Option("local", "--company"),
) -> None:
    """Hard-delete a secret, its versions, and its bindings (audit events survive)."""
    from superclaw.secrets_store import SecretStoreError, delete_secret

    if not yes and not typer.confirm(f"Delete secret '{name}' and all its versions?"):
        raise typer.Exit(0)
    try:
        delete_secret(_team_store(), name=name, company_profile_id=company)
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    typer.echo(f"deleted {name}")


@secret_app.command("bind")
def secret_bind(
    name: str = typer.Argument(...),
    target_type: str = typer.Option(..., "--target-type", help="agent_profile | plugin | backend | company | runtime"),
    target_id: str = typer.Option(..., "--target-id"),
    env: str = typer.Option(..., "--env", help="Destination config path (environment variable name)"),
    optional: bool = typer.Option(False, "--optional", help="Missing/archived secret does NOT block the target"),
    company: str = typer.Option("local", "--company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Grant ONE consumer access to a secret and declare where it lands.
    Required bindings feed the invokability gate (missing -> target cannot take work)."""
    from superclaw.secrets_store import SecretStoreError, bind_secret

    try:
        binding = bind_secret(
            _team_store(), name=name, target_type=target_type, target_id=target_id,
            config_path=env, required=not optional, company_profile_id=company,
        )
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    if json_output:
        typer.echo(json.dumps(binding.to_dict(), ensure_ascii=False))
    else:
        typer.echo(f"bound {name} -> {target_type}:{target_id} as {env} (binding_id={binding.binding_id})")


@secret_app.command("unbind")
def secret_unbind(binding_id: str = typer.Argument(...)) -> None:
    """Revoke one binding by id (see `secret bindings`)."""
    from superclaw.secrets_store import unbind_secret

    if unbind_secret(_team_store(), binding_id=binding_id):
        typer.echo(f"unbound {binding_id}")
    else:
        typer.echo(f"error: binding {binding_id} not found")
        raise typer.Exit(1)


@secret_app.command("bindings")
def secret_bindings(
    target_type: str | None = typer.Option(None, "--target-type"),
    target_id: str | None = typer.Option(None, "--target-id"),
    name: str | None = typer.Option(None, "--name", help="Filter to one secret's bindings"),
    company: str | None = typer.Option(None, "--company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List bindings (optionally filtered by secret, consumer, and company)."""
    store = _team_store()
    secret_id = None
    if name is not None:
        found = store.find_secret_by_name(name, company_profile_id=company or "local")
        if found is None:
            typer.echo(f"error: secret '{name}' not found")
            raise typer.Exit(1)
        secret_id = found.secret_id
    rows = store.list_secret_bindings(secret_id=secret_id, target_type=target_type, target_id=target_id, company_profile_id=company)
    if json_output:
        typer.echo(json.dumps([b.to_dict() for b in rows], ensure_ascii=False))
        return
    if not rows:
        typer.echo("no bindings")
        return
    for b in rows:
        try:
            secret_name = store.get_secret(b.secret_id).name
        except KeyError:
            secret_name = f"<deleted:{b.secret_id}>"
        req = "required" if b.required else "optional"
        typer.echo(f"{b.binding_id}: {secret_name} -> {b.target_type}:{b.target_id} as {b.config_path} ({req})")


@secret_app.command("access-log")
def secret_access_log(
    name: str | None = typer.Argument(None, help="Filter to one secret"),
    limit: int = typer.Option(50, "--limit"),
    company: str = typer.Option("local", "--company"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Show the append-only access audit (resolve / denied / lifecycle events)."""
    from superclaw.secrets_store import find_audit_secret_id

    store = _team_store()
    secret_id = None
    if name is not None:
        secret_id = find_audit_secret_id(store, name=name, company_profile_id=company)
        if secret_id is None:
            typer.echo(f"error: secret '{name}' not found (and no delete trace)")
            raise typer.Exit(1)
    events = store.list_secret_access_events(secret_id=secret_id, limit=limit)
    if json_output:
        typer.echo(json.dumps([e.to_dict() for e in events], ensure_ascii=False))
        return
    if not events:
        typer.echo("no access events")
        return
    for e in events:
        target = f" {e.target_type}:{e.target_id}" if e.target_type else ""
        detail = f" — {e.detail}" if e.detail else ""
        typer.echo(f"{e.occurred_at:.0f} {e.action}{target} (actor={e.actor}){detail}")


@instance_app.command("settings")
def instance_settings_show(json_output: bool = typer.Option(False, "--json")) -> None:
    """Show the singleton instance settings (general + experimental buckets)."""
    from superclaw.secrets_store import get_instance_settings

    payload = get_instance_settings(_team_store())
    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return
    for bucket in ("general", "experimental"):
        typer.echo(f"[{bucket}]")
        values = payload.get(bucket) or {}
        if not values:
            typer.echo("  (empty)")
        for key, value in sorted(values.items()):
            typer.echo(f"  {key}={json.dumps(value, ensure_ascii=False)}")


@instance_app.command("set")
def instance_settings_set(
    bucket: str = typer.Argument(..., help="general | experimental"),
    key: str = typer.Argument(...),
    value: str = typer.Argument(..., help="JSON value (e.g. true, 5, \"text\"); bare strings accepted"),
) -> None:
    """Set one key in a bucket. Values parse as JSON, falling back to raw string."""
    from superclaw.secrets_store import SecretStoreError, update_instance_settings

    try:
        parsed: Any = json.loads(value)
    except json.JSONDecodeError:
        parsed = value
    try:
        payload = update_instance_settings(_team_store(), bucket=bucket, patch={key: parsed})
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    typer.echo(f"{bucket}.{key}={json.dumps((payload.get(bucket) or {}).get(key), ensure_ascii=False)}")


@instance_app.command("unset")
def instance_settings_unset(
    bucket: str = typer.Argument(..., help="general | experimental"),
    key: str = typer.Argument(...),
) -> None:
    """Remove one key from a bucket."""
    from superclaw.secrets_store import SecretStoreError, update_instance_settings

    try:
        update_instance_settings(_team_store(), bucket=bucket, patch={key: None})
    except SecretStoreError as exc:
        typer.echo(f"error: {exc}")
        raise typer.Exit(1) from exc
    typer.echo(f"unset {bucket}.{key}")


# --- heartbeat daemon (phase 2: the engine that runs Agent Teams unattended) --


def _daemon_paths() -> tuple[Path, Path]:
    root = _state_path().parent
    return root / "daemon.pid", root / "daemon.log"


def _daemon_broker_control():
    from superclaw.daemon import LocalDaemonBrokerControl

    root = _state_path().parent
    return LocalDaemonBrokerControl(
        state_file=root / "daemon-broker.json",
        temp_root=root / "daemon-broker-sessions",
    )


def _load_daemon_broker_manifest(
    plugin_id: str,
    *,
    manifest_path: Path | None,
    manifest_json: str | None,
) -> dict[str, Any]:
    if manifest_path is not None and manifest_json is not None:
        raise ValueError("--manifest and --manifest-json are mutually exclusive")
    if manifest_json is not None:
        payload = json.loads(manifest_json)
    elif manifest_path is not None:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        payload = {"id": plugin_id, "name": plugin_id, "version": "0.0.0"}
    if not isinstance(payload, dict):
        raise ValueError("plugin manifest must be a JSON object")
    return payload


def _load_daemon_broker_files(entries: list[str]) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for entry in entries:
        if "=" not in entry:
            raise ValueError("materialized files must use relative/path=source/path")
        relative_path, source_path = entry.split("=", 1)
        if not relative_path or not source_path:
            raise ValueError("materialized files must use relative/path=source/path")
        files[relative_path] = Path(source_path).read_bytes()
    return files


def _daemon_pid() -> int | None:
    """Best-effort liveness from the pidfile (os.kill(pid, 0) probe).

    A reused pid can false-positive; the pidfile is a convenience probe, not
    the concurrency boundary — the durable per-agent claim locks are what
    actually prevent double-running work.
    """
    pid_file, _ = _daemon_paths()
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    # pid_is_alive, not os.kill(pid, 0): the latter terminates the process on
    # Windows instead of probing it (see proc_compat).
    if not pid_is_alive(pid):
        return None
    return pid


def _claim_pidfile(pid_file: Path) -> None:
    """Atomically claim the pidfile (O_CREAT|O_EXCL); reap one stale file.

    Creation is the mutual-exclusion point: two concurrent starts cannot both
    win the O_EXCL create. A leftover file from a dead process is removed once
    and the claim retried.
    """
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    for attempt in (1, 2):
        try:
            fd = os.open(pid_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
            return
        except FileExistsError:
            if _daemon_pid() is not None:
                _fail(f"daemon already running (pid {_daemon_pid()}); `superclaw daemon stop` first")
            if attempt == 1:
                pid_file.unlink(missing_ok=True)  # stale file from a dead process
                continue
            _fail("could not claim daemon pidfile (concurrent start?)")


@daemon_app.command("start")
def daemon_start(
    interval: float = typer.Option(15.0, "--interval", help="Scheduler cycle in seconds"),
    foreground: bool = typer.Option(False, "--foreground", help="Run the loop in this process (no detach)"),
    repo: Path = typer.Option(Path("."), "--repo"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
) -> None:
    """Start the heartbeat daemon (detached by default; pidfile + logfile)."""
    artifact_dir = artifact_dir or default_artifact_dir()
    pid_file, log_file = _daemon_paths()
    if foreground:
        from superclaw.daemon import HeartbeatDaemon

        # The O_EXCL pidfile claim is the single-daemon mutual exclusion point.
        _claim_pidfile(pid_file)
        typer.echo(f"daemon running in foreground (pid {os.getpid()}); Ctrl-C to stop")
        if not HeartbeatDaemon(_team_store(), repo_path=repo, artifact_dir=artifact_dir).heartbeats_enabled():
            typer.echo(
                "note: heartbeat master switch is OFF; only event-driven (assignment/mention) "
                "wakeups run. Enable timers: superclaw instance set general heartbeat_enabled true",
                err=True,
            )
        daemon = HeartbeatDaemon(
            _team_store(), repo_path=repo, artifact_dir=artifact_dir
        )
        try:
            daemon.run_forever(interval_seconds=interval)
        finally:
            pid_file.unlink(missing_ok=True)
        return
    # Detached: re-exec ourselves in foreground mode with output to the logfile.
    # The child claims the pidfile atomically; the parent only reports.
    import subprocess
    import time as _time

    if _daemon_pid() is not None:
        _fail(f"daemon already running (pid {_daemon_pid()}); `superclaw daemon stop` first")
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log_handle = open(log_file, "a", encoding="utf-8")
    # Detach the child from this terminal's session/process group so it survives
    # the parent exiting. start_new_session (setsid) is POSIX-only and silently
    # ignored on Windows; there the equivalent is DETACHED_PROCESS +
    # CREATE_NEW_PROCESS_GROUP creation flags.
    if os.name == "nt":
        detach_kwargs = {
            "creationflags": getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        }
    else:
        detach_kwargs = {"start_new_session": True}
    process = subprocess.Popen(
        [sys.executable, "-m", "superclaw.cli", "daemon", "start", "--foreground",
         "--interval", str(interval), "--repo", str(repo), "--artifact-dir", str(artifact_dir)],
        stdout=log_handle,
        stderr=log_handle,
        stdin=subprocess.DEVNULL,
        **detach_kwargs,
    )
    for _ in range(50):  # confirm the child claimed the pidfile (≤5s)
        if _daemon_pid() == process.pid:
            typer.echo(f"daemon started (pid {process.pid}); log: {log_file}")
            return
        if process.poll() is not None:
            _fail(f"daemon exited at startup (code {process.returncode}); see {log_file}")
        _time.sleep(0.1)
    typer.echo(f"daemon spawned (pid {process.pid}) but pidfile unconfirmed; check {log_file}")


@daemon_app.command("stop")
def daemon_stop() -> None:
    """Stop the running daemon (SIGTERM on POSIX / taskkill on Windows, via pidfile)."""
    import time as _time

    pid_file, _ = _daemon_paths()
    pid = _daemon_pid()
    if pid is None:
        pid_file.unlink(missing_ok=True)  # reap a stale file
        typer.echo("daemon not running")
        return
    terminate_pid(pid)  # POSIX SIGTERM / Windows taskkill (NOT os.kill, which kills on probe)
    for _ in range(100):  # wait for actual exit (≤10s) before reaping the pidfile
        if not pid_is_alive(pid):
            pid_file.unlink(missing_ok=True)
            typer.echo(f"daemon stopped (pid {pid})")
            return
        _time.sleep(0.1)
    typer.echo(f"daemon (pid {pid}) did not exit within 10s; pidfile kept — investigate before retrying")
    raise typer.Exit(1)


@daemon_app.command("status")
def daemon_status() -> None:
    """Daemon liveness + queue depth + per-status wakeup counts."""
    store = _team_store()
    pid = _daemon_pid()
    counts: dict[str, int] = {}
    for status in ("queued", "claimed", "finished", "skipped"):
        counts[status] = len(store.list_wakeups(status=status, limit=10_000))
    settings = store.get_instance_settings()
    _emit_json(
        {
            "running": pid is not None,
            "pid": pid,
            "heartbeat_enabled": bool(settings.general.get("heartbeat_enabled", False)),
            "wakeups": counts,
        }
    )


@daemon_broker_app.command("open-session")
def daemon_broker_open_session(
    subject: str | None = typer.Option(None, "--subject"),
    ttl: float | None = typer.Option(None, "--ttl", min=0.001, help="Session TTL in seconds"),
) -> None:
    """Open a short-lived local broker session."""
    try:
        session = _daemon_broker_control().open_session(subject=subject, ttl_seconds=ttl)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"session": session.to_status_payload()})


@daemon_broker_app.command("issue-token")
def daemon_broker_issue_token(
    session_id: str = typer.Argument(...),
    scope: list[str] = typer.Option([], "--scope", help="Allowed token scope; repeat for multiple scopes"),
    ttl: float | None = typer.Option(None, "--ttl", min=0.001, help="Token TTL in seconds"),
    subject: str | None = typer.Option(None, "--subject"),
) -> None:
    """Issue one opaque scoped token for an active broker session."""
    try:
        token, metadata = _daemon_broker_control().issue_token(
            session_id,
            scope,
            ttl_seconds=ttl,
            subject=subject,
        )
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"token": token, "metadata": metadata.to_status_payload()})


@daemon_broker_app.command("validate-token")
def daemon_broker_validate_token(
    token: str = typer.Argument(...),
    scope: str = typer.Option(..., "--scope", help="Required scope"),
) -> None:
    """Validate a token for one required scope; returns metadata only."""
    try:
        metadata = _daemon_broker_control().validate_token(token, required_scope=scope)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"valid": metadata is not None, "metadata": metadata.to_status_payload() if metadata else None})


@daemon_broker_app.command("materialize")
def daemon_broker_materialize(
    token: str = typer.Argument(...),
    plugin_id: str = typer.Argument(...),
    manifest: Path | None = typer.Option(None, "--manifest", exists=True, dir_okay=False, readable=True),
    manifest_json: str | None = typer.Option(None, "--manifest-json"),
    file: list[str] = typer.Option([], "--file", help="Materialize relative/path=source/path; repeatable"),
) -> None:
    """Materialize a governed plugin view into a private session directory."""
    try:
        materialized = _daemon_broker_control().materialize_plugin_view(
            token,
            plugin_id=plugin_id,
            manifest=_load_daemon_broker_manifest(
                plugin_id,
                manifest_path=manifest,
                manifest_json=manifest_json,
            ),
            files=_load_daemon_broker_files(file),
        )
    except PermissionError as exc:
        _fail(str(exc))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _fail(str(exc))
    _emit_json({"materialization": materialized.to_status_payload()})


@daemon_broker_app.command("close-session")
def daemon_broker_close_session(session_id: str = typer.Argument(...)) -> None:
    """Close a broker session, revoking tokens and cleaning materializations."""
    try:
        _daemon_broker_control().close_session(session_id)
    except ValueError as exc:
        _fail(str(exc))
    _emit_json({"closed": True, "session_id": session_id})


@daemon_broker_app.command("status")
def daemon_broker_status() -> None:
    """Audit-safe broker status without token secrets or digests."""
    try:
        payload = _daemon_broker_control().status_payload()
    except ValueError as exc:
        _fail(str(exc))
    _emit_json(payload)


@daemon_app.command("tick")
def daemon_tick(
    max_services: int = typer.Option(8, "--max-services", min=1),
    repo: Path = typer.Option(Path("."), "--repo"),
    artifact_dir: Path | None = typer.Option(None, "--artifact-dir"),
) -> None:
    """One scheduler cycle: tick timers, then drain up to N wakeups (cron-friendly)."""
    artifact_dir = artifact_dir or default_artifact_dir()
    from superclaw.daemon import HeartbeatDaemon

    daemon = HeartbeatDaemon(_team_store(), repo_path=repo, artifact_dir=artifact_dir)
    if not daemon.heartbeats_enabled():
        typer.echo(
            "note: heartbeat master switch is OFF (fail-closed default); timer wakeups are "
            "skipped. Enable autonomous scheduling with: "
            "superclaw instance set general heartbeat_enabled true",
            err=True,
        )
    enqueued = daemon.tick_timers()
    outcomes = []
    for _ in range(max_services):
        outcome = daemon.service_once()
        if outcome is None:
            break
        outcomes.append(
            {
                "wakeup_id": outcome.wakeup_id,
                "agent_profile_id": outcome.agent_profile_id,
                "status": outcome.status,
                "detail": outcome.detail,
                "run_id": outcome.run_id,
                "issue_id": outcome.issue_id,
            }
        )
    # Autonomous goal continuation (PR8) — a strict no-op unless the flag is on.
    continued_goals = daemon.tick_goal_continuation()
    _emit_json({"enqueued": len(enqueued), "serviced": outcomes, "continued_goals": continued_goals})


# --- appearance: color-scheme presets + custom palette ----------------------
# The CLI is the capability baseline; the API/Web read the same kernel functions.


def _print_appearance_state(payload: dict[str, Any]) -> None:
    typer.echo(f"active_preset={payload['active_preset']}")
    typer.echo(f"config_path={payload['config_path']}")
    for canvas in payload["canvases"]:
        overrides = payload["custom"].get(canvas, {})
        if overrides:
            joined = " ".join(f"{tok}={val}" for tok, val in sorted(overrides.items()))
            typer.echo(f"custom.{canvas}: {joined}")


@appearance_app.command("list-presets")
def appearance_list_presets(as_json: bool = typer.Option(False, "--json", help="Emit the raw contract as JSON.")) -> None:
    """List the curated color-scheme presets and editable tokens."""
    contract = _appearance.build_appearance_contract()
    if as_json:
        typer.echo(json.dumps(contract, ensure_ascii=False, indent=2))
        return
    typer.echo("presets:")
    for preset in contract["presets"]:
        typer.echo(f"  {preset['id']:<14} {preset['label']} — {preset['description']}")
    typer.echo("tokens (custom-editable):")
    for tok in contract["tokens"]:
        typer.echo(f"  {tok['id']:<14} {tok['css_var']} ({tok['group']})")


@appearance_app.command("show")
def appearance_show(as_json: bool = typer.Option(False, "--json", help="Emit the full payload as JSON.")) -> None:
    """Show the active color scheme and any custom overrides."""
    payload = _appearance.appearance_payload()
    if as_json:
        typer.echo(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    _print_appearance_state(payload)


@appearance_app.command("set-preset")
def appearance_set_preset(preset_id: str = typer.Argument(..., help="A preset id, or 'custom'.")) -> None:
    """Activate a preset (or 'custom' to use your saved palette)."""
    try:
        _appearance.set_active_preset(preset_id)
    except ValueError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    _print_appearance_state(_appearance.appearance_payload())


@appearance_app.command("set-color")
def appearance_set_color(
    canvas: str = typer.Argument(..., help="'light' or 'dark'."),
    token: str = typer.Argument(..., help="A token id (see list-presets)."),
    color: str = typer.Argument(..., help="A hex color, e.g. #4f5fd6."),
) -> None:
    """Set one custom token color and switch the active scheme to 'custom'."""
    try:
        _appearance.set_custom_color(canvas, token, color)
    except ValueError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    _print_appearance_state(_appearance.appearance_payload())


@appearance_app.command("reset")
def appearance_reset() -> None:
    """Reset to the stock default and drop all custom colors."""
    _appearance.reset_appearance()
    _print_appearance_state(_appearance.appearance_payload())


@appearance_app.command("export")
def appearance_export(
    path: Path | None = typer.Argument(None, help="Write the bundle here; omit to print to stdout."),
) -> None:
    """Export the active scheme + custom palette as an importable JSON bundle."""
    bundle = _appearance.build_appearance_export()
    text = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    if path is None:
        typer.echo(text, nl=False)
        return
    path.write_text(text, encoding="utf-8")
    typer.echo(f"exported {path}")


@appearance_app.command("import")
def appearance_import(path: Path = typer.Argument(..., help="A bundle written by 'appearance export'.")) -> None:
    """Import an appearance bundle (re-validated against the current preset catalog)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        typer.echo(f"error: cannot read bundle: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    try:
        _config, warnings = _appearance.import_appearance_bundle(data)
    except ValueError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    for warning in warnings:
        typer.echo(f"warning: {warning}", err=True)
    _print_appearance_state(_appearance.appearance_payload())


# --- module entry (MUST stay at the very end) -------------------------------
# Typer commands register at import time, top to bottom. Calling ``app()``
# before the last @command definition silently drops every command defined
# below it for `python -m superclaw.cli` and the installed entry point —
# exactly the bug that hid the daemon commands while CliRunner tests (which
# import the fully-loaded module object) stayed green.
def main() -> None:
    configure_logging()
    # GLOBAL trust-root default for the CLI: a frozen build defaults the kind-scoped
    # SUPERCLAW_*_ROOT_PUBLIC_KEY to the baked official public key here, before ANY
    # command runs — so every root-key consumer (plugin install / cloud-install /
    # verify, etc.) gets the same official root as the API/desktop surface (no
    # CLI-vs-API parity split). Source/dev runs and explicit env overrides are
    # untouched. Idempotent with the per-command _hydrate_cli_environment().
    hydrate_official_root_public_keys()
    if len(sys.argv) == 1:
        interactive_shell(
            session_id=None,
            continue_last=False,
            backend=None,
            model=None,
            repo=Path("."),
            budget_seconds=60,
            artifact_dir=default_artifact_dir(),
            harness="codex",
            task_topology=TaskTopology.LINEAR,
            dry=False,
            permission_mode="default",
            allowed_tool=None,
            disallowed_tool=None,
            mcp_config=None,
            plugin_dir=None,
        )
        return
    app()


if __name__ == "__main__":
    main()
