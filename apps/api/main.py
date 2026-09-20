from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import inspect
import logging
import math
import base64
import binascii
import mimetypes
import os
import queue
import re
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from superclaw import appearance as appearance_kernel
from superclaw.adversarial import adversarial_rule_specs, apply_adversarial_profile
from superclaw.backends import default_backends
from superclaw.file_view import FILE_VIEW_SCAN_CAP
from superclaw.budget_policy import BudgetGateError
from superclaw.capability_atlas import (
    atlas_summary,
    coverage_report,
    get_capability,
    search_capabilities,
    suggest_capabilities,
    validate_facets,
)
from superclaw.capability_surface import (
    CapabilitySurface,
    SurfaceDiffAction,
    classify_surface_diff,
    current_capability_surface,
    render_capability_change_notice,
    resolve_resume_action,
)
from superclaw.capability_submission import (
    DeveloperCapabilitySubmissionError,
    capability_submission_prefix,
    publish_capability_distribution,
    sanitize_capability_distribution_payload,
    submit_developer_capability_upload,
)
from superclaw.capability_registry import (
    CapabilityRegistryError,
    get_capability_registry_download_reference,
    latest_approved_capability_manifests,
)
from superclaw.catalog_resolver import (
    CATALOG_KINDS,
    default_companies_root,
    default_registry_root,
    refresh_catalog,
    resolve_catalog,
    resolve_trust_state,
    trust_derivation_to_dict,
)
from superclaw.clawhunt import (
    ClawHuntClient,
    browse_has_more as _clawhunt_browse_has_more,
    extract_problem_items as _clawhunt_extract_problem_items,
    extract_problem_payload as _clawhunt_extract_problem_payload,
)
from superclaw.clawhunt_auth import (
    CLAWHUNT_BROWSER_LOGIN_STATE_TTL_SECONDS,
    ClawHuntAccountClient,
    SUPERCLAW_LOGIN_SOURCE,
    build_clawhunt_browser_login_url,
    classify_login_probe_result,
    clawhunt_auth_summary,
    clear_clawhunt_auth,
    extract_login_session,
    hydrate_clawhunt_auth_environment,
    load_clawhunt_auth,
    login_probe_error_result,
    save_clawhunt_auth,
    saved_clawhunt_access_token,
    _safe_user_payload,
)
from superclaw.daemon import LocalDaemonBrokerControl
from superclaw.capability_cosign import verify_official_cosignature
from superclaw.capability_r2 import CapabilityR2Error, fetch_r2_object, list_r2_object_keys, load_r2_config
from superclaw.environment import (
    app_environment,
    clawhunt_base_url,
    default_artifact_dir,
    default_state_path,
    hydrate_official_root_public_keys,
    official_root_public_key,
    superclaw_data_path,
)
from superclaw.evals import CASE_ID, EvalRunner, default_eval_root
from superclaw.fusion import (
    FusionPermissionError,
    fusion_capability_audit,
    fusion_capability_catalog,
    fusion_run_status,
    fusion_start_plan,
    fusion_status,
    fusion_stop_plan,
    load_fusion_artifact,
    record_fusion_action,
)
from superclaw.harness import (
    emit_harness_artifacts,
    harness_matrix,
    inventory_plugins,
    runtime_profile,
    validate_harness_artifacts,
)
from superclaw.media import (
    RunningHubMediaError,
    RunningHubMediaRequest,
    RunningHubMediaRenderRequest,
    RunningHubMediaUploadRequest,
    load_runninghub_media_artifact,
    query_runninghub_media_task,
    render_runninghub_media_task,
    runninghub_media_catalog,
    runninghub_media_doctor,
    runninghub_media_status,
    submit_runninghub_media_task,
    upload_runninghub_media_file,
)
from superclaw.liveness import ACTIVE_RUN_STATUSES, EXECUTING_RUN_STATUSES, chat_session_activity, effective_run_state
from superclaw import trace_context
from superclaw.logging_config import configure_logging, get_logger
from superclaw.gateway_front_door import GatewayFrontDoorMiddleware
from superclaw.node_front_door import NodeFrontDoorMiddleware
from superclaw.models import (
    AgentProfile,
    ArtifactRef,
    ChildAggregationPolicy,
    CompanyProfile,
    ContinuationPolicy,
    CostEvent,
    GoalSpec,
    Issue,
    IssueKind,
    ReviewPolicy,
    TaskNode,
    TaskTopology,
    WorkerRole,
    WorkspaceProfile,
    _id,
)
from superclaw import workspace_resolver
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw import team_kernel
from superclaw.run_ledger import build_issue_run_ledger
from superclaw.team_routines import author_routine
from superclaw.company_template import company_local_dev_trust_enabled, default_company_revocation_file
from superclaw.team_bootstrap import BootstrapCommitError, commit_bootstrap_proposal
from superclaw.team_templates import CompanyTrustGateError, TeamTemplateError, build_bootstrap_proposal
from superclaw.plugin_ingestion import ClawHuntPluginIngestionError, ingest_clawhunt_delivery_plugin
from superclaw.plugin_submission import DeveloperUploadReviewError
from superclaw.desktop_runtime import generate_control_token
from superclaw.plugin_cloud import (
    DEFAULT_CLOUD_ROOT,
    get_registry_download_reference,
    get_registry_plugin_version,
    get_revocations,
    get_runtime_policy,
    install_plugin_from_cloud_metadata,
    list_registry_plugins,
    resolve_registry_plugin_version,
    store_evidence_summary,
    sync_entitlements_for_device,
)
from superclaw.plugin_config import (
    PluginConfigurationError,
    delete_plugin_secret,
    normalize_manifest_setting_value,
    plugin_configuration_status,
    set_plugin_secret,
    set_plugin_setting,
    validate_manifest_secret_name,
)
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import MANIFEST_NAME, PluginVerificationError, is_skill_origin_plugin, plugin_cache_root, uninstall_cached_plugin, verify_plugin_package
from superclaw.protocol_adapter import build_clawhunt_delivery_protocol_payload, build_clawhunt_submission_payload, default_solution_text
from superclaw.runtime import PermissionPolicy, find_codex_executable, redact_secrets, runtime_cli_comparison, runtime_manifest, runtime_mcp_status
from superclaw.codex_app_server import CodexAppServerClient, CodexAppServerSession, CodexApprovalDecision
from superclaw.runtime_config import (
    configured_shell_backend,
    configured_shell_mode,
    load_onboarding_state,
    reset_onboarding_state,
    runtime_config_payload,
    set_onboarding_completed,
    set_runtime_config,
    shell_config_path,
)
from superclaw.permissions import PRESET_TO_MODE
from superclaw.state import StateStore, resolve_cost_window
from superclaw.chat_runtime import resolve_chat_runtime
from superclaw.chat_prompt import (
    ChatPromptEnvelope,
    build_chat_prompt_envelope,
    format_chat_history as _canonical_format_chat_history,
)
from superclaw.chat_turn import (
    CODEX_DIRECT_CHAT_BACKENDS,
    NATIVE_SESSION_CHAT_BACKENDS,
    classify_intent,
    extract_plugin_id,
    friendly_chat_failure,
    parse_chat_route,
)
from superclaw.agent_runtime import (
    CODEX_APP_SERVER_RUNTIME_ID,
    EventBus,
    RuntimeCapabilityError,
    RuntimeTurnRequest,
    default_runtime_manager,
)
from superclaw.escalation import EscalationError, escalation_summary, verify_envelope
from superclaw.skill_build import SkillBuildError, build_and_install_skill_plugin
from superclaw.skill_sync import (
    SkillSyncError,
    default_projection_lock,
    load_projection_lock,
    sync_native_skills,
    sync_plugin_skills,
    unsync_plugin_skills,
)
from superclaw.skill_store import (
    SkillImportRecord,
    SkillStoreError,
    default_skill_revocation_file,
    import_skill as import_native_skill,
    list_skills as list_native_skills,
)
from superclaw.ui_contracts import (
    build_agent_inventory,
    build_agent_summary,
    build_capability_upload_contract,
    build_catalog_contract_payload,
    build_clawhunt_auth_payload,
    build_run_ledger_contract,
    build_desktop_acceptance_payload,
    build_desktop_onboarding_payload,
    build_plugin_diagnostics_payload,
    build_desktop_toolchain_payload,
    build_plugin_status_payload,
    build_runtime_status_payload,
    build_skill_build_contract,
    build_skill_sync_contract,
    build_tui_acceptance_payload,
    build_team_inventory_payload,
    build_company_export_payload,
    build_approval_queue_payload,
    build_workspace_inventory,
    build_workspace_locks_payload,
    workspace_projection,
)

def _execute_direct_chat_turn(**kwargs: Any) -> dict[str, Any]:
    # Late-bound delegation (NOT an import-time alias) so tests can monkeypatch
    # superclaw.chat_turn.execute_direct_chat_turn and have every API call site
    # observe the patch.
    import superclaw.chat_turn as _chat_turn

    return _chat_turn.execute_direct_chat_turn(**kwargs)


def _native_chat_executor(backend: str):
    """Resolve the native-session chat executor for a backend (Tier 2 dispatch map).

    Each native backend drives its OWN runtime session but shares the API binding /
    turn_plan / move-guard lifecycle. Late-bound (not an import-time alias) so tests can
    monkeypatch the chat_turn executors. The codex-app-server inline daemon path is
    SEPARATE and is never routed here."""
    import superclaw.chat_turn as _chat_turn

    executors = {
        "claude": _chat_turn.execute_claude_native_chat_turn,
        "clawwork": _chat_turn.execute_clawwork_native_chat_turn,
    }
    return executors[backend]

# Structured logger for fail-open paths that must never break the request but
# must also never swallow errors silently (project rule: no `except: pass`).
_LOGGER = logging.getLogger("superclaw.api")

# How often the background sweeper converges stale "executing" runs; liveness
# itself is judged by the lease TTL in superclaw.liveness, not this cadence.
RECONCILE_SWEEP_INTERVAL_SECONDS = 60.0

# Contract: a chat turn's outbound ``run_id`` is a POLLABLE run handle — it is present
# iff a real run resource exists (an @task inline run, or a delivery run), so a client
# may GET /api/runs/<id> (+ /evidence, /events/snapshot) on it. A PURE chat turn has no
# run resource, so its outbound ``run_id`` is None — NEVER the internal cost-ledger id
# (``chat_turn_run_id``), which is unresolvable at /api/runs/<id> (404) and would make a
# successful chat render as a failed run. ``chat_turn_run_id`` stays internal: it only
# keys ``_record_chat_cost_event``. See docs/local-session-lookup.md §5.
_CHAT_RUN_HANDLE_CONTRACT = "outbound run_id present iff a real pollable run exists; pure chat → None"

CHAT_DELIVERY_CONTEXT_MAX_MESSAGES = 20
CHAT_DELIVERY_CONTEXT_MESSAGE_MAX_CHARS = 2000
CHAT_DELIVERY_CONTEXT_TOTAL_MAX_CHARS = 16000
CHAT_CONTEXT_REF_MAX_ITEMS = 12
CHAT_CONTEXT_REF_TEXT_MAX_CHARS = 12000
CHAT_CONTEXT_REF_ITEM_MAX_CHARS = 2000
CHAT_CONTEXT_FILE_MAX_CHARS = 6000
CHAT_CONTEXT_TEXT_ARTIFACT_SUFFIXES = {".csv", ".html", ".json", ".log", ".md", ".txt", ".yaml", ".yml"}
CHAT_ATTACHMENT_MAX_ITEMS = 8
CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
PLUGIN_LOGO_MAX_BYTES = 256 * 1024
PLUGIN_LOGO_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/svg+xml"}
CATALOG_CACHE_TTL_SECONDS = 5.0


if "app" not in inspect.signature(httpx.Client.__init__).parameters:
    _httpx_client_init = httpx.Client.__init__

    def _httpx_client_init_compat(self, *args, app=None, **kwargs):
        return _httpx_client_init(self, *args, **kwargs)

    httpx.Client.__init__ = _httpx_client_init_compat


def _run_artifact_root(execution_context: dict[str, Any], run_id: str) -> Path:
    artifact_dir = execution_context.get("artifact_dir") or str(default_artifact_dir())
    return (Path(str(artifact_dir)).resolve() / run_id).resolve()


def _native_skill_payload(record: SkillImportRecord) -> dict[str, Any]:
    description = record.description
    return {
        "slug": record.slug,
        "id": record.slug,
        "name": record.name,
        "description": description,
        "summary": description,
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
        "kind": "skill",
        "source": "native",
        "trust": record.label,
        "trust_reasons": [f"native_label:{record.label}"],
        "plugin_id": None,
        "version": None,
        "install_state": {"installed": True, "installed_versions": [], "update_available": False},
        "instantiable": True,
    }


def _sanitize_native_skill_error(exc: Exception, *, context: str = "native skill import") -> str:
    fallback = f"{context} failed validation"
    detail = str(exc)[:300]
    if "/" in detail or "\\" in detail:
        return fallback
    return detail or fallback


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class GoalRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    clawhunt_problem: dict[str, Any] | None = None


def _effective_permission_mode(permission_preset: str | None, permission_mode: str) -> str:
    """Two-state shell (docs/permission-mode-framework.md): an explicit Ask/Allow
    preset projects onto the underlying mode via the kernel contract; absent a
    preset, the legacy permission_mode passes through (acceptEdits default kept)."""
    if permission_preset:
        return PRESET_TO_MODE[permission_preset]
    return permission_mode


class RunRequest(BaseModel):
    goal_id: str = Field(..., min_length=1)
    dry_run: bool = True
    async_execution: bool = False
    backend_policy: str = "claude"
    model: str | None = None  # per-run model override; None = backend env default
    effort: str | None = None  # per-run reasoning-effort; honored by effort-capable backends, fail-closed elsewhere
    harness_policy: str = "codex"
    concurrency: int = Field(1, ge=1, le=64)
    repo_path: str = "."
    budget_seconds: int = Field(60, ge=1, le=86400)
    artifact_dir: str = Field(default_factory=lambda: str(default_artifact_dir()))
    verification_policy: str = "adversarial"
    task_topology: TaskTopology = TaskTopology.LINEAR
    permission_mode: str = "acceptEdits"  # auto-approve plugin (MCP) tool calls + file edits; shell commands are NOT auto-approved
    permission_preset: Literal["ask", "allow"] | None = None  # two-state shell; when set, projects onto permission_mode via PRESET_TO_MODE
    allowed_tools: list[str] = Field(default_factory=list)
    disallowed_tools: list[str] = Field(default_factory=list)
    mcp_configs: list[str] = Field(default_factory=list)
    plugin_dirs: list[str] = Field(default_factory=list)
    chat_session_id: str | None = None


class VerifyRequest(BaseModel):
    run_id: str = Field(..., min_length=1)


class PreviewTicketRequest(BaseModel):
    url: str = Field(..., min_length=1)
    # Allow routing the server-side fetch through the OS proxy (default on) so the
    # reader works behind fake-IP/split-tunnel proxies; the Security tab can opt
    # out. HMAC-signed into the ticket so it cannot be tampered before the fetch.
    allow_proxy: bool = True


class DelegationReviewRequest(BaseModel):
    request_key: str = Field(..., min_length=1)
    approved: bool
    reviewed_by: str | None = Field(None, min_length=1)


class SubmitRequest(BaseModel):
    problem_id: int = Field(..., ge=1)
    run_id: str = Field(..., min_length=1)


class ProtocolExportRequest(BaseModel):
    github_pr_url: str | None = None
    github_pr_number: int | None = None


class EntitlementSyncRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    runtime_version: str = Field(..., min_length=1)
    plugin_ids: list[str] = Field(default_factory=list)


class EvidenceSummaryUploadRequest(BaseModel):
    summary: dict[str, Any] = Field(default_factory=dict)


class CatalogRefreshRequest(BaseModel):
    source_url: str | None = None
    public_key: str | None = None


class ClawHuntIngestionRequest(BaseModel):
    delivery_root: str = Field(..., min_length=1)
    manifest_path: str | None = None
    output_root: str | None = None


class DeveloperSubmissionCreateRequest(BaseModel):
    developer_id: str | None = None
    plugin_id: str | None = None
    capability_id: str | None = None
    requested_acceptance_level: str | None = None


class DeveloperCapabilityCreateRequest(DeveloperSubmissionCreateRequest):
    kind: Literal["plugin", "skill", "company"]


class CapabilityReviewSubmissionRequest(BaseModel):
    schema_version: str | None = None
    kind: Literal["plugin", "skill", "company"]
    capability_id: str | None = None
    plugin_id: str | None = None
    skill_id: str | None = None
    company_id: str | None = None
    version: str = Field(..., min_length=1)
    artifact_digest: str | None = None
    package_digest: str | None = None
    artifact_ref: str = Field(..., min_length=1)
    artifact_filename: str | None = None
    package_format: str | None = None
    name: str | None = None
    summary: str | None = None
    requested_status: str | None = None
    auto_approve: bool = False
    developer_ref: str | None = None


class DeveloperSubmissionArtifactRequest(BaseModel):
    package_path: str = Field(..., min_length=1)
    signing_private_key: str | None = None
    # Omitted → None → the kernel applies its default smoke timeout (and the
    # env-overridable test floor, SUPERCLAW_PLUGIN_TIMEOUT_SECONDS) so a real
    # smoke sidecar starved on a busy/parallel host is not falsely rejected as a
    # timeout. An explicit caller value is still bounded to (0, 60].
    smoke_timeout_seconds: float | None = Field(None, gt=0, le=60)


class AdminCapabilityReviewRequest(BaseModel):
    decision: Literal["publish", "revoke", "replace", "sign"]
    actor_ref: str = Field(..., min_length=1)
    artifact_ref: str | None = None
    signing_authority_ref: str | None = None
    entitlement_ref: str | None = None
    replacement_for_digest: str | None = None


class HumanGateRequest(BaseModel):
    reason: str = "human input required"


class EscalationRespondRequest(BaseModel):
    # decision is the option id to choose (e.g. "approve" / "deny"). NOTE: the
    # responder principal is deliberately NOT accepted from the client. Over a
    # network-exposed surface a client-asserted principal is not an authenticated
    # identity — a control-token holder could read the bound principal (it is shown
    # in the queue) and replay it to approve as anyone. The responder identity is
    # therefore derived server-side (see _operator_principal), so a caller can only
    # act as this instance's configured operator and can never impersonate another
    # principal. The kernel still enforces principal == the escalation's binding.
    decision: str = Field(..., min_length=1)
    note: str | None = None


class RuntimeConfigSetRequest(BaseModel):
    name: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)


class AppearanceSetRequest(BaseModel):
    # Both optional: a surface may set just the active preset, just the custom
    # palette, or both. The kernel validates/normalizes and fails closed on an
    # unknown preset; malformed custom colors are dropped (returned as warnings).
    active_preset: str | None = Field(default=None)
    custom: dict[str, Any] | None = Field(default=None)


class AppearanceImportRequest(BaseModel):
    # The raw bundle produced by ``GET /api/appearance/export`` / ``appearance export``.
    bundle: dict[str, Any] = Field(...)


class AppearanceCustomColorRequest(BaseModel):
    # A single-token edit. Routed to the kernel's locked read-modify-write merge so
    # concurrent edits to different tokens can never clobber each other (unlike a
    # whole-map replace built from a possibly-stale client snapshot).
    canvas: str = Field(..., min_length=1)
    token: str = Field(..., min_length=1)
    color: str = Field(..., min_length=1)


class OnboardingCompleteRequest(BaseModel):
    version: int = Field(0, ge=0)


class CreateWorkspaceRequest(BaseModel):
    # No min_length here: the blank-name rule lives in the one kernel entry
    # (create_personal_workspace), which raises ValueError → 422. Validating only
    # in the kernel keeps CLI/API/Web on a single source of truth.
    name: str
    # attach a real directory (REPO workspace) instead of a folder scratch.
    attach_repo: str | None = None
    # fail-closed: attaching a real dir requires the caller to attest it obtained
    # explicit human trust confirmation first (workspace-sidebar-rework §4.4).
    trust_confirmed: bool = False


class ArchiveSessionRequest(BaseModel):
    archived: bool = True


class PinSessionRequest(BaseModel):
    # Default True so an empty POST pins (mirrors ArchiveSessionRequest).
    pinned: bool = True


class RenameWorkspaceRequest(BaseModel):
    # No min_length here: the blank-name rule lives in the one kernel entry
    # (rename_workspace) so CLI/API/Web share one validator (→ 422 on blank).
    name: str


class PinWorkspaceRequest(BaseModel):
    pinned: bool = True


class MoveSessionRequest(BaseModel):
    workspace_id: str | None = None
    # fail-closed move guard (§4.5): a move that changes the execution boundary
    # resets the chat's runtime resume state; the caller must acknowledge it.
    acknowledge_boundary_change: bool = False


def _profile_permission_policy(preset: str | None) -> dict[str, Any]:
    """Map an agent-create permission preset to a stored permission_policy.

    Mirrors the CLI exactly: None → {} (inherit the workspace default, else the
    daemon's fail-closed read-only floor); 'none' → explicit read-only plan
    (does not inherit); 'ask'/'allow' → bypassPermissions (max-permission
    doctrine: the runtime is a pure execution engine; SuperClaw governs above)."""
    from superclaw.permissions import PRESET_TO_MODE

    mode_map = {"none": "plan", **PRESET_TO_MODE}
    if preset is None:
        return {}
    if preset not in mode_map:
        raise HTTPException(status_code=422, detail="permission must be 'none', 'ask', or 'allow'")
    return {"mode": mode_map[preset]}


class TeamProfileCreateRequest(BaseModel):
    # Self-defending: reject unknown fields (422) instead of silently dropping them.
    # A surface that sends a kernel field name (e.g. backend_policy) instead of the
    # wire field (backend) gets a loud error at dev time, not a silently-wrong agent.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1)
    role: str = Field(..., min_length=1)
    title: str | None = None
    workspace: str = "local"
    company: str = "local"
    backend: str = "claude"
    model: str = ""
    effort: str = ""  # per-agent reasoning-effort; honored by effort-capable backends, fail-closed elsewhere
    permission: Literal["none", "ask", "allow"] | None = None  # None=inherit; 'none'=explicit read-only
    plugin_allowlist: list[str] = Field(default_factory=list)
    skill_allowlist: list[str] = Field(default_factory=list)
    budget_seconds: int = Field(default=0, ge=0)
    token_budget: int = Field(default=0, ge=0)
    context_mode: str = "thin"
    reports_to: str | None = None
    persona: str = ""
    charter: str = ""
    default_instructions: str = ""
    # Heartbeat policy (runtime_config.heartbeat) — the daemon's per-agent
    # schedule. None = not heartbeat-driven (fail-closed default).
    heartbeat_enabled: bool = False
    heartbeat_interval_sec: int = Field(default=300, ge=10)


class TeamBootstrapTemplateRequest(BaseModel):
    template: dict[str, Any] | None = None
    from_template: str | None = None
    # Instantiate a CATALOGED company by id (+ optional version): the server resolves it
    # to its local company source via the catalog resolver, then routes it through the
    # SAME verify-before-instantiate gate. Lets the Web/Desktop offer "instantiate the
    # company I see in the catalog" without the surface inventing a filesystem path.
    company_catalog_id: str | None = None
    company_version: str | None = None
    mode: Literal["proposal", "commit"] = "proposal"
    proposal_id: str = "bootstrap_template_proposal"
    available_plugin_ids: list[str] | None = None
    available_skill_ids: list[str] | None = None
    runtime_budget_seconds: int = Field(default=0, ge=0)
    runtime_token_budget: int = Field(default=0, ge=0)
    requested_by: str = "local_user"
    # Mirrors the CLI `--trust local` flag: only an explicit "local" admits an
    # unsigned/self-built company template; reserved namespaces always hard-fail.
    trust: Literal["local"] | None = None


class TeamProfileUpdateRequest(BaseModel):
    """Partial edit of an existing agent profile (PATCH).

    Every field is optional; only the fields actually present in the request
    body (``model_fields_set``) are applied, so omitting a field leaves it
    unchanged while sending ``null`` clears it (e.g. reports_to). permission
    takes an extra 'inherit' to reset to the workspace default ({}). Identity/
    scope and the charter are not editable here (mirrors the kernel whitelist).
    """

    # Self-defending: reject unknown fields (422) instead of silently dropping them
    # (e.g. a wrong-named runtime field would otherwise no-op the edit silently).
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    backend: str | None = None
    model: str | None = None
    effort: str | None = None
    permission: Literal["inherit", "none", "ask", "allow"] | None = None
    plugin_allowlist: list[str] | None = None
    skill_allowlist: list[str] | None = None
    budget_seconds: int | None = Field(default=None, ge=0)
    token_budget: int | None = Field(default=None, ge=0)
    context_mode: str | None = None
    reports_to: str | None = None
    persona: str | None = None
    heartbeat_enabled: bool | None = None
    heartbeat_interval_sec: int = Field(default=300, ge=10)
    # Optimistic concurrency: the revision the client edited against. When set,
    # a concurrent edit is rejected (CAS) instead of silently clobbered.
    expected_revision_id: str | None = None


class TeamAgentCharterRequest(BaseModel):
    charter: str | None = None
    persona: str | None = None


class TeamAgentConfigChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    by: str = Field(..., min_length=1)
    title: str | None = None
    backend: str | None = None
    model: str | None = None
    effort: str | None = None
    permission: Literal["inherit", "none", "ask", "allow"] | None = None
    heartbeat: bool | None = None
    heartbeat_interval_sec: int = Field(default=300, ge=10)
    skill_allowlist: list[str] | None = None
    reports_to: str | None = None
    persona: str | None = None
    note: str = ""


class TeamMessagesMarkReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Exactly one selection mode (kernel enforces XOR): explicit item_keys, OR a
    # company_profile_id. BOTH require seen_as_of — the server-issued snapshot the
    # client echoes back from a prior GET /api/team/messages (kernel clamps it to
    # min(seen, now), so a forged future value cannot ack unseen events).
    item_keys: list[str] | None = None
    company_profile_id: str | None = None
    seen_as_of: float


class TeamAgentHireRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    by: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    role: str = Field(..., min_length=1)
    title: str | None = None
    workspace: str = "local"
    company: str = "local"
    backend: str = "claude"
    model: str = ""
    effort: str = ""  # per-agent reasoning-effort; honored by effort-capable backends, fail-closed elsewhere
    permission: Literal["none", "ask", "allow"] | None = None
    skill_allowlist: list[str] = Field(default_factory=list)
    reports_to: str | None = None
    persona: str = ""
    charter: str = ""
    note: str = ""


class TeamIssueCommentRequest(BaseModel):
    body: str = Field(..., min_length=1)
    author: str = "local_user"
    author_type: str = "user"


class TeamIssueBlockRequest(BaseModel):
    reason: str = Field(..., min_length=1)
    by: str = "local_user"
    unblock_owner: str | None = None


class TeamIssueUnblockRequest(BaseModel):
    by: str = "local_user"
    note: str = ""


class TeamIssueRequeueRequest(BaseModel):
    holder: str | None = None


class TeamIssueHoldRequest(BaseModel):
    reason: str = ""
    by: str = "local_user"


class TeamIssueUnholdRequest(BaseModel):
    by: str = "local_user"


class TeamIssueTreeOpRequest(BaseModel):
    reason: str = ""
    by: str = "local_user"
    # resume only: release just this pause's holds (omit = all tree-scoped holds).
    operation_id: str | None = None


class TeamIssueCreateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    description: str = ""
    workspace: str = "local"
    company: str = "local"
    priority: str = "medium"
    # Typed-issue (mirrors CLI `issue create --kind/--review-policy`). Validated in
    # the kernel (Issue construction), so an invalid value surfaces a 409 here — the
    # team API's standard mapping for a kernel ValueError (same rejection the CLI hits).
    kind: str = IssueKind.DELIVERY.value
    review_policy: str = ReviewPolicy.HUMAN_FINAL.value
    goal: str | None = None
    parent: str | None = None


class TeamIssueDelegateRequest(BaseModel):
    profile_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    description: str = ""
    by: str | None = None


class TeamCompanyCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    goal: str = ""
    default_budget_seconds: int = Field(default=0, ge=0)
    default_token_budget: int = Field(default=0, ge=0)
    # One-step workspace binding (Paperclip pattern): an existing local repo
    # (safety gates apply) OR a git URL cloned into a managed checkout.
    repo_path: str | None = None
    repo_url: str | None = None


class TeamCompanyCommandRequest(BaseModel):
    """Thin REST envelope for a chat-driven company-management command.

    The REST surface owns NO parallel mutation logic: it parses ``command_type``
    + ``payload`` into the SAME typed ``superclaw.company_commands`` model the CLI
    and chat tool projection build, injects a SERVER-side operator scope (never
    read from the body — authority is server-derived), and dispatches through the
    ONE ``company_handler.execute_company_command`` entry every surface shares
    (CLAUDE.md 铁律: CLI is the single source of truth; zero divergence). Only
    ``actor_company_id`` is an accepted body input — it is a *target* anchor, not
    authority (``is_admin`` / ``principal_id`` are fixed server-side).

    ``extra="forbid"``: the envelope itself is fail-closed, so an unknown top-level
    key (e.g. a stray ``is_admin``) is rejected at the boundary, matching the inner
    command model's ``from_dict`` posture rather than being silently dropped.
    """

    model_config = ConfigDict(extra="forbid")

    command_type: str = Field(..., min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    actor_company_id: str = "local"


class MarketplaceCommandRequest(BaseModel):
    """Thin REST envelope for a governed ClawHunt marketplace command.

    Mirrors :class:`TeamCompanyCommandRequest` for the marketplace namespace: the
    REST layer owns NO parallel logic — it parses ``command_type`` + ``payload``
    into the SAME typed ``superclaw.marketplace_commands`` model the CLI and chat
    tool projection build, injects a SERVER-side operator scope (authority never
    read from the body), and dispatches through the ONE
    ``marketplace_handler.execute_marketplace_command`` entry. Reads run straight
    through; every write returns a pending approval (human-gated). Fail-closed
    envelope (``extra="forbid"``).
    """

    model_config = ConfigDict(extra="forbid")

    command_type: str = Field(..., min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    actor_company_id: str = "local"


class MarketplaceAdvanceRequest(BaseModel):
    """Drive a claimed marketplace order's saga forward (build issue → run → gate)."""

    model_config = ConfigDict(extra="forbid")

    order_id: str = Field(..., min_length=1)
    repo_path: str = "."
    backend_policy: str = "claude"
    budget_seconds: int = Field(default=60, ge=1)


class TeamWorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    company: str = "local"
    repo_path: str = "."
    writable_paths: list[str] = Field(default_factory=lambda: ["."])
    network_policy: str = "restricted"
    concurrency: str = "serial"


class TeamWorkspaceTrustRequest(BaseModel):
    path: str = Field(..., min_length=1)
    name: str | None = None
    company: str = "local"


class TeamWorkspaceContainmentRequest(BaseModel):
    preset: str = Field(..., min_length=1)  # standard | low_trust_review


class TeamIssueAssignRequest(BaseModel):
    profile_id: str = Field(..., min_length=1)


class TeamBoardInboxResolveRequest(BaseModel):
    by: str = "local_user"
    note: str = ""


class TeamBoardInboxAssignRequest(BaseModel):
    profile_id: str = Field(..., min_length=1)
    resolve: bool = True


class TeamRoutineAuthorRequest(BaseModel):
    spec: dict[str, Any] = Field(default_factory=dict)


class TeamIssueCheckoutRequest(BaseModel):
    run_id: str | None = None
    holder: str | None = None


class TeamIssueSubmitRequest(BaseModel):
    by: str | None = None
    summary: str = ""


class TeamApprovalDecisionRequest(BaseModel):
    by: str = "local_user"
    note: str | None = None


class TeamWorkProductRequest(BaseModel):
    type: str = Field(..., min_length=1)
    title: str = ""
    url: str | None = None
    provider: str = "local"
    external_id: str | None = None
    status: str | None = None
    summary: str = ""
    is_primary: bool = False


class TeamWorkProductUpdateRequest(BaseModel):
    status: str | None = None
    title: str | None = None
    url: str | None = None
    summary: str | None = None
    is_primary: bool | None = None


class MediaGenerateRequest(BaseModel):
    template: str = Field(..., min_length=1)
    prompt: str | None = None
    negative_prompt: str | None = None
    source_image: str | None = None
    source_video: str | None = None
    node_info_list: list[dict[str, Any]] = Field(default_factory=list)
    inputs: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False
    artifact_dir: str | None = None
    run_id: str | None = None
    timeout_seconds: float = Field(60.0, gt=0, le=600)


class MediaRenderRequest(MediaGenerateRequest):
    wait_for_outputs: bool = True
    max_polls: int = Field(24, ge=0, le=240)
    poll_interval_seconds: float = Field(5.0, ge=0, le=3600)
    query_timeout_seconds: float = Field(30.0, gt=0, le=600)


class MediaUploadRequest(BaseModel):
    file_path: str = Field(..., min_length=1)
    file_type: str = "input"
    dry_run: bool = False
    artifact_dir: str | None = None
    run_id: str | None = None
    timeout_seconds: float = Field(60.0, gt=0, le=600)


class MediaTaskQueryRequest(BaseModel):
    task_id: str = Field(..., min_length=1)
    mode: str = "standard-api"
    artifact_dir: str | None = None
    run_id: str | None = None
    timeout_seconds: float = Field(30.0, gt=0, le=600)


class ClawHuntLoginRequest(BaseModel):
    agent_api_key: str = Field(..., min_length=1)


class ClawHuntAccountLoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class ClawHuntAgentKeyCreateRequest(BaseModel):
    agent_id: int = Field(..., ge=1)
    name: str = Field(default="SuperClaw Desktop", min_length=1)
    permissions: list[str] = Field(default_factory=lambda: ["browse", "bid", "post", "solve"])


class PluginInstallRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None


class PluginUninstallRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None


class PluginSkillSyncRequest(BaseModel):
    plugin_id: str | None = None
    targets: list[str] | None = None
    force: bool = False


class PluginSkillUnsyncRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    revoked: bool = False
    force: bool = False


class NativeSkillImportRequest(BaseModel):
    path: str = Field(..., min_length=1)
    label: str = "local-dev"
    publisher: str | None = None
    source_url: str | None = None
    signature: str | None = None
    public_key: str | None = None
    importer: str = "superclaw-api"
    allow_executable: bool = False
    force: bool = False


class NativeSkillSyncRequest(BaseModel):
    skill_slug: str | None = None
    targets: list[str] | None = None
    force: bool = False


class SkillBuildRequest(BaseModel):
    path: str = Field(..., min_length=1)
    plugin_id: str | None = None
    version: str = "0.1.0"
    developer_id: str = "local-dev"
    # Signing is OPTIONAL (owner's provenance model): a local skill is equippable
    # unsigned, and a self-signature never upgrades its `local` grade.
    sign: bool = False
    signing_private_key: str | None = None
    force: bool = False


class LocalPluginInstallRequest(BaseModel):
    package_path: str = Field(..., min_length=1)


class GithubPluginInstallRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None


# GitHub download kit: the catalog of marketplace plugins whose signed .scplug is
# distributed via a public GitHub release. To make a NEW plugin installable from
# GitHub, add one entry here — both the install endpoint and the web client read
# this single list. The client only sends plugin_id+version; the server resolves
# the trusted release URL so the browser never supplies a download URL (no SSRF).
# Currently empty: the pay-switch-agent entry was removed when its signed .scplug
# release asset was lost with the GitHub org suspension (ClawHunt-Store/pay-switch-0.2.0
# is private with no releases). To make a plugin installable from GitHub again, add one
# entry with a public release "url"; the install endpoint resolves the trusted URL from
# here so the browser never supplies a download URL (no SSRF).
GITHUB_PLUGIN_CATALOG: list[dict[str, str]] = []


class WorkshopInstallRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None


class CapabilityInstallRequest(BaseModel):
    """Neutral install request (plugin/skill/company) for the Node S4 landing path —
    the API mirror of the CLI `capabilities workshop install` (same kernel bridge)."""

    capability_id: str = Field(..., min_length=1)
    version: str = Field(..., min_length=1)
    kind: Literal["plugin", "skill", "company"] = "plugin"


class CapabilityUninstallRequest(BaseModel):
    """Neutral uninstall request. ``origin`` selects the store: ``cache`` (legacy Python plugin
    cache, keyed by capability_id+version) or ``node-workshop`` (Node S4 store, keyed by
    native_key=Node pluginKey)."""

    origin: Literal["cache", "node-workshop"]
    capability_id: str = Field(..., min_length=1)
    version: str | None = None
    native_key: str | None = None


# Capability artifact bytes live in Cloudflare R2 (the configured resource store);
# ClawHunt's workshop feed is metadata-only (it stores NO package bytes — see the
# hunt verifier "does not upload package bytes" and plugin_cloud "Phase 5A … local
# registry … no production networking"). The published entry's ``artifact_ref``
# (``superclaw-object://capabilities/...``) is the single source of truth for WHERE
# the bytes are: it maps 1:1 to the R2 object key (prefix stripped). The install
# endpoint fetches via authenticated get-object and enforces authenticity TWICE:
# (1) the feed entry's official co-signature verifies against the baked official
# key, and (2) the downloaded package's content digest equals that co-signed
# package_digest.
_WORKSHOP_OBJECT_SCHEME = "superclaw-object://"


def _r2_artifact_bucket() -> str:
    """The R2 artifact bucket for the active environment, STRICTLY derived from
    APP_ENV: a staging build reads only ``clawhunt-capability-artifacts-staging`` and
    a production build only ``...-prod``. Deliberately NOT overridable by env — the
    "staging must never touch production object storage" isolation must not be
    defeatable by configuration (co-signature/digest protect package authenticity,
    not environment separation)."""
    suffix = "staging" if app_environment() == "staging" else "prod"
    return f"clawhunt-capability-artifacts-{suffix}"


def _artifact_ref_to_r2_key(artifact_ref: Any) -> str | None:
    """Map a published ``artifact_ref`` to its R2 object key, or None if it is not a
    well-formed opaque capability object ref. Rejects any local-path / scheme markers
    so a poisoned feed entry can never redirect the fetch off the object store."""
    if not isinstance(artifact_ref, str):
        return None
    ref = artifact_ref.strip()
    if not ref.startswith(_WORKSHOP_OBJECT_SCHEME):
        return None
    key = ref[len(_WORKSHOP_OBJECT_SCHEME):]
    if not key.startswith("capabilities/"):
        return None
    if "\\" in key or "file://" in key.lower() or any(part in {"", ".", ".."} for part in key.split("/")):
        return None
    return key


def _plugin_marketplace_catalog_url() -> str:
    override = os.environ.get("SUPERCLAW_PLUGIN_MARKETPLACE_CATALOG_URL")
    if override:
        return override
    return f"{clawhunt_base_url()}/api/plugins/marketplace-catalog"


# Default surface icon per capability kind. ClawHunt submissions do not yet carry
# a display ``icon``/``category`` (the kernel submission payload is identity-only),
# so the surface projection supplies a stable default; a future submission field
# can override it without changing this contract.
_CAPABILITY_KIND_ICON = {"plugin": "runtime", "skill": "developer", "company": "productivity"}

# Bilingual display label per kind so the localized {en, zh} surface shape carries a
# real translation rather than an English string mirrored into both locales.
_CAPABILITY_KIND_LABEL = {
    "plugin": {"en": "Plugin", "zh": "插件"},
    "skill": {"en": "Skill", "zh": "技能"},
    "company": {"en": "Company", "zh": "公司"},
}


def _capability_workshop_catalog_url() -> str:
    override = os.environ.get("SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL")
    if override:
        return override
    # Lives under /v1/capabilities/* so the staging Cloudflare Access allowlist
    # serves it without a service token — the workshop list is intentionally public.
    return f"{clawhunt_base_url()}/v1/capabilities/published"


def _localized_text(value: Any) -> dict[str, str]:
    """Wrap a single-language ClawHunt string into the surface's {en, zh} shape.

    ClawHunt stores name/summary as one language; the web surface renders the
    localized object shape (matching the mock catalog). We mirror the same value
    into both locales rather than fabricating a translation.
    """
    text = (value or "").strip() if isinstance(value, str) else ""
    return {"en": text, "zh": text}


def _opt_str(value: Any) -> str | None:
    """Fail-closed string coercion for UNTRUSTED upstream-feed fields: keep a real
    string, drop anything else (dict/list/number/None) to ``None``. The public
    ``/v1/capabilities/published`` feed is an untrusted source, so a poisoned entry
    that swapped a string for an object must never pass through structurally to a
    strongly-typed surface."""
    return value if isinstance(value, str) else None


def _map_capability_entry_to_marketplace(entry: dict[str, Any], *, official_verified: bool = False) -> dict[str, Any]:
    """Project a ClawHunt published-capability entry into the marketplace catalog
    shape the web surface already consumes (``MarketplaceCatalogPluginInfo``).

    Presentation fields (localized labels, icon, category) are derived here. The
    one trust verdict this projection emits is ``trust``: it is set to ``official``
    ONLY when ``official_verified`` is True — i.e. the caller has already verified
    the entry's official co-signature against the LOCALLY-baked official public key
    (``capability_cosign.verify_official_cosignature``). It is NEVER derived from a
    self-reported feed flag. ``official_verified`` defaults False (fail-closed): an
    unverified entry carries no ``trust``, so the surface shows no official badge.
    """
    kind = entry.get("kind") or "plugin"
    capability_id = entry.get("capability_id") or entry.get("plugin_id") or ""
    status = str(entry.get("status") or entry.get("review_status") or "").lower()
    return {
        "plugin_id": capability_id,
        "version": entry.get("version") or "",
        "kind": kind,
        "name": _localized_text(entry.get("name") or capability_id),
        "summary": _localized_text(entry.get("summary")),
        "category": kind,
        "category_label": _CAPABILITY_KIND_LABEL.get(kind, _localized_text(kind.title())),
        "icon": _CAPABILITY_KIND_ICON.get(kind, "runtime"),
        "runtime": entry.get("runtime") or kind,
        "pricing_model": entry.get("pricing_model") or "free",
        # ``verified`` is passed through UNCHANGED from the kernel/ClawHunt entry,
        # where it means "developer signature cryptographically verified at submit
        # time". The surface MUST NOT redefine it (e.g. as review-approval) — doing
        # so would render unsigned capabilities with a green "verified" badge and
        # add a governance semantic the kernel never asserted. Review-approval is
        # carried separately by ``capability_status`` (drives the lifecycle badge).
        # NOTE(trust-debt): ``verified`` / ``signature_verified`` are ALSO self-
        # reported upstream booleans (a poisoned feed could set them too). They are
        # passed through here only for legacy UI compatibility and carry NO local
        # cryptographic weight; the marketplace never derives the OFFICIAL badge from
        # them (that comes solely from the kernel's ``trust === 'official'`` state).
        # They should eventually migrate to kernel-derived trust like ``official`` —
        # which is exactly why the official self-reported verdict below is dropped
        # rather than echoed (we don't add new self-reported trust booleans).
        "verified": bool(entry.get("verified")),
        "signature_verified": bool(entry.get("signature_verified")),
        "signer_keyid": _opt_str(entry.get("signer_keyid")),
        # OFFICIAL co-signature EVIDENCE — opaque, UNVERIFIED material only. The prior
        # behaviour dropped these, so a consumer that wants to verify the co-signature
        # against the baked official public key had nothing to verify. We carry just
        # the raw material that the endpoint independently VERIFIED against the baked
        # official key to compute ``official_verified`` (see ``trust`` below):
        #   - ``official_signature`` / ``official_signer_keyid`` are the opaque bytes
        #     from the public feed, carried for other consumers (CLI/desktop) that may
        #     re-verify. They are evidence, not a verdict.
        #   - ClawHunt's self-reported ``signature_verified_official`` verdict is
        #     INTENTIONALLY NOT projected: echoing a verified-shaped official boolean
        #     from a feed a MITM could poison would be untrusted. The OFFICIAL trust
        #     verdict comes solely from local re-verification (``official_verified``).
        "official_signature": _opt_str(entry.get("official_signature")),
        "official_signer_keyid": _opt_str(entry.get("official_signer_keyid")),
        # Locally-verified OFFICIAL endorsement -> kernel ``trust`` state the web badge
        # keys off (``trust === 'official'``). Set ONLY when the co-signature verified
        # against the baked official key; otherwise omitted (no badge) — fail-closed.
        "trust": "official" if official_verified else None,
        "capability_status": status or "published",
        "entitlement_required": bool(entry.get("entitlement_required", False)),
        "featured": False,
        "skill_origin": kind == "skill",
        # Company capabilities are organization templates, not installable packages.
        "instantiable": kind != "company",
        "package_digest": entry.get("package_digest"),
        "artifact_blob_digest": entry.get("blob_digest"),
        "source": "clawhunt_workshop",
    }


def _github_plugin_entry(plugin_id: str, version: str | None) -> dict[str, str] | None:
    """Resolve a GitHub catalog entry by id (+ optional version; else latest)."""
    matches = [entry for entry in GITHUB_PLUGIN_CATALOG if entry["plugin_id"] == plugin_id]
    if not matches:
        return None
    if version:
        match = next((entry for entry in matches if entry["version"] == version), None)
        if match:
            return match
        # Fall back to the latest catalog entry so a stale client-sent version
        # (e.g. an old marketplace card) still resolves to the current release.
    return sorted(matches, key=lambda entry: entry["version"])[-1]


class PluginSettingRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None
    name: str = Field(..., min_length=1)
    value: Any = ""


class PluginConfigInvokeRequest(BaseModel):
    """Invoke a setting's declared dynamic-config tool (options_source or action)."""

    version: str | None = None
    setting: str = Field(..., min_length=1)
    action_id: str | None = None  # None -> the setting's options_source; else match an action by id/tool
    arguments: dict[str, Any] = Field(default_factory=dict)


class PluginSecretSetRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None
    name: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)
    version_range: str = "*"


class PluginSecretDeleteRequest(BaseModel):
    plugin_id: str = Field(..., min_length=1)
    version: str | None = None
    name: str = Field(..., min_length=1)


class ChatContextRef(BaseModel):
    type: Literal[
        "chat_session", "run", "evidence", "plugin", "message", "artifact", "file", "company", "company_create"
    ]
    id: str = Field(..., min_length=1)
    label: str | None = None
    source: str | None = None
    visible_token: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ChatAttachment(BaseModel):
    kind: Literal["file", "image", "local_path"] = "file"
    name: str | None = None
    path: str | None = None
    mime: str | None = None
    size: int | None = Field(None, ge=0)
    data_url: str | None = None
    source: str | None = None


class ChatTurnRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: str | None = None
    continue_last: bool = False
    mode: Literal["auto", "chat", "delivery"] = "auto"
    dry_run: bool = False
    # None = nothing requested this turn -> the chat's sticky runtime applies
    # (kernel resolve_chat_runtime: request > sticky > default). model="" is the
    # explicit clear (REQUEST_CLEAR).
    backend_policy: str | None = None
    model: str | None = None
    # Per-turn reasoning-effort / thinking level; sticky per chat (same rules as
    # model). "" is the explicit clear (REQUEST_CLEAR). Honored by effort-capable
    # backends only; others fail closed on an explicit value.
    effort: str | None = None
    # runtime_id selects the (pluggable) agent runtime for the unified task
    # entry adapter path. None = derive from the chat's resolved runtime.
    runtime_id: str | None = None
    # Explicit override for the backend that answers a plain chat turn. None
    # (the default) means the turn executes on the chat's resolved runtime —
    # the same backend the runtime selector picked. Surfaces should not send
    # this; it exists for tests and deliberate pinning. DEPRECATED in favor of
    # runtime_id.
    direct_chat_backend: str | None = None
    harness_policy: str = "codex"
    # None = pure chat: the turn lives (and executes) in the managed Chat
    # workspace scratch home instead of the server cwd.
    repo_path: str | None = None
    # Workspace this turn belongs to. None = derive from repo_path via the
    # kernel resolver (fail-closed); explicit ids move the session (pure
    # regrouping) and never exempt repo_path from the trust gate.
    workspace_id: str | None = None
    # With continue_last: widen the session pick across all workspaces.
    all_sessions: bool = False
    budget_seconds: int = Field(60, ge=1, le=86400)
    artifact_dir: str = Field(default_factory=lambda: str(default_artifact_dir()))
    verification_policy: str = "adversarial"
    task_topology: TaskTopology = TaskTopology.LINEAR
    permission_mode: str = "acceptEdits"  # auto-approve plugin (MCP) tool calls + file edits; shell commands are NOT auto-approved
    permission_preset: Literal["ask", "allow"] | None = None  # two-state shell; when set, projects onto permission_mode via PRESET_TO_MODE
    strict_resume: bool = False  # promote a revoked-capability resume from inject-notice to hard-block (fresh thread)
    allowed_tools: list[str] = Field(default_factory=list)
    disallowed_tools: list[str] = Field(default_factory=list)
    mcp_configs: list[str] = Field(default_factory=list)
    plugin_dirs: list[str] = Field(default_factory=list)
    context_refs: list[ChatContextRef] = Field(default_factory=list)
    attachments: list[ChatAttachment] = Field(default_factory=list)


class GoalPlanRequest(BaseModel):
    """Plan a goal (Goal Mode). The Web '计划模式' toggle posts here on send; the
    response is a goal in ``awaiting_confirmation`` (i.e. confirmation required)."""

    title: str = Field(..., min_length=1)
    description: str = ""
    topology: TaskTopology = TaskTopology.LINEAR
    metadata: dict[str, Any] = Field(default_factory=dict)


class GoalRosterEntryRequest(BaseModel):
    source: Literal["backend"] = "backend"
    # None = the lead entry (covers every otherwise-unbound slot); a role name binds
    # this agent to that plan slot (PR4 multi-agent role casting).
    role: str | None = None
    backend: str | None = None
    model: str | None = None
    effort: str | None = None


class GoalConfirmRequest(BaseModel):
    revision: int = Field(..., ge=0)
    plan_hash: str = Field(..., min_length=1)
    # The roster the goal is confirmed with — the execution source of truth. PR2:
    # a single backend entry; the per-agent runtime selectors in the dialog fill it.
    roster: list[GoalRosterEntryRequest] = Field(default_factory=list)
    start: bool = True
    repo_path: str | None = None
    budget_seconds: int = Field(60, ge=1, le=86400)
    dry_run: bool = False
    # Goal token budget (PR7): required to confirm a concurrent fan-out plan
    # (IMPLEMENT_FANOUT); it is the admission ceiling so concurrent workers cannot
    # collectively overspend. per_worker_tokens overrides the per-worker slice.
    token_budget: int | None = Field(None, ge=0)
    per_worker_tokens: int | None = Field(None, ge=0)


class GoalStartRequest(BaseModel):
    repo_path: str | None = None
    budget_seconds: int = Field(60, ge=1, le=86400)
    dry_run: bool = False


class GoalReviseRequest(BaseModel):
    revision: int = Field(..., ge=0)


class GoalReplanRequest(BaseModel):
    revision: int = Field(..., ge=0)
    topology: TaskTopology | None = None
    description: str | None = None


class GoalCancelRequest(BaseModel):
    revision: int = Field(..., ge=0)


class GoalAutonomyRequest(BaseModel):
    enabled: bool


class GoalContinueRequest(BaseModel):
    force: bool = False
    repo_path: str | None = None
    budget_seconds: int = Field(60, ge=1, le=86400)
    max_goals: int = Field(5, ge=0, le=100)


class DirectChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    backend_policy: str = "codex"
    model: str | None = None  # honored only by the codex exec path; legacy CLI mode fails closed
    effort: str | None = None  # per-turn reasoning-effort; honored by effort-capable backends, fail-closed elsewhere
    # None = pure chat: executes in the managed Chat workspace scratch home
    # (same trust-gate semantics as the unified entry; no server-cwd execution).
    repo_path: str | None = None
    budget_seconds: int = Field(60, ge=1, le=86400)


class PaymentIntentRequest(BaseModel):
    amount: int | None = Field(None, ge=0)
    currency: str = "USD"
    confirm_governed_tool: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class HarnessInventoryRequest(BaseModel):
    source_root: str = Field(..., min_length=1)


class HarnessEmitRequest(BaseModel):
    source_root: str = Field(..., min_length=1)
    output_root: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)
    plugins: list[str] | None = None


class HarnessValidateRequest(BaseModel):
    output_root: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)


class GovernanceApprovalRequest(BaseModel):
    source: str = Field("clawwork-governance", min_length=1)
    run_id: str | None = None
    intent: str = Field(..., min_length=1)  # e.g. "payment" / "network_scan"
    tool: str | None = None
    command: str | None = None


class EvalRunRequest(BaseModel):
    agent: str = "all"
    case_id: str = CASE_ID
    timeout_seconds: int = Field(900, ge=1, le=86400)
    async_execution: bool = True


class FusionActionRequest(BaseModel):
    component: str = Field(..., min_length=1)
    action: str = Field(..., min_length=1)
    tool_name: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    artifact_refs: list[dict[str, Any]] = Field(default_factory=list)
    human_gate_approved: bool = False
    permission_result: dict[str, Any] | None = None
    run_id: str | None = None


class FusionRunRequest(BaseModel):
    profile: str = Field("all", min_length=1)
    execute: bool = False


class FanoutChildSpec(BaseModel):
    title: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1)
    backend_policy: str | None = None
    dry_run: bool = False
    budget_seconds: int | None = Field(None, ge=1, le=86400)
    harness_policy: str | None = None
    verification_policy: str | None = None


class FanoutRequest(BaseModel):
    parent_task_id: str | None = None
    children: list[FanoutChildSpec] = Field(..., min_length=1)
    aggregation: ChildAggregationPolicy = ChildAggregationPolicy.ALL_SUCCEED
    max_concurrency: int = Field(4, ge=1, le=32)
    quorum: int | None = Field(None, ge=1)


class TaskNodeSpec(BaseModel):
    task_id: str | None = None
    role: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    depends_on: list[str] = Field(default_factory=list)


class ExpandRequest(BaseModel):
    tasks: list[TaskNodeSpec] = Field(..., min_length=1)


def _agent_card() -> dict[str, Any]:
    base_url = os.environ.get("SUPERCLAW_PUBLIC_URL", "https://superclaw.local").rstrip("/")
    return {
        "protocolVersion": "0.3.0",
        "name": "SuperClaw",
        "description": "End-to-end ClawHunt delivery agent with parallel harness and adversarial evidence.",
        "url": base_url,
        "version": "0.1.0",
        "preferredTransport": "HTTP+JSON",
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["application/json", "text/event-stream"],
        "endpoints": {
            "a2a": f"{base_url}/a2a",
            "webhook": f"{base_url}/api/clawhunt/webhook",
            "events": f"{base_url}/api/runs/{{run_id}}/events",
        },
        "securitySchemes": {
            "controlToken": {
                "type": "apiKey",
                "in": "header",
                "name": "X-SuperClaw-Token",
            }
        },
        "skills": [
            {
                "id": "clawhunt_delivery",
                "name": "ClawHunt End-to-End Delivery",
                "description": "Plan, execute, verify, and submit ClawHunt problem solutions.",
                "tags": ["clawhunt", "delivery", "verification", "parallel-agents"],
            }
        ],
    }


def _truncate_chat_context_text(value: str, max_chars: int = CHAT_DELIVERY_CONTEXT_MESSAGE_MAX_CHARS) -> str:
    text = value.strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _chat_context_messages(chat_session) -> list[dict[str, Any]]:
    messages = chat_session.messages[-CHAT_DELIVERY_CONTEXT_MAX_MESSAGES:]
    return [
        {
            "role": message.role,
            "content": _truncate_chat_context_text(message.content),
            "run_id": message.run_id,
            "created_at": message.created_at,
            "context_refs": list(getattr(message, "context_refs", [])),
        }
        for message in messages
        if message.content.strip()
    ]


def _json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str))


# Terminal run lifecycle event types — used to break the bounded tail-poll early
# once the trailing terminal event has actually been delivered (the run flow
# commits terminal STATUS before this event, so readers poll briefly for it).
_RUN_TERMINAL_EVENT_TYPES = frozenset(
    {"run.completed", "run.failed", "run.cancelled", "run.paused"}
)


def _snapshot_events_with_ids(rows: list[dict[str, Any]], *, id_source: str = "sqlite") -> list[dict[str, Any]]:
    """Stamp the durable id into each snapshot event's payload (DL5/T2).

    The run channel's canonical id is the SQLite ``events.id``; we copy it into the
    payload (overriding the projector's synthetic id) and tag ``id_source`` so every
    run-channel surface — live SSE, the snapshot endpoint, and the session-detail
    history — hands the front-end reducer the SAME shape for dedup/anchoring. A
    legacy backend with no id passes ``id_source="none"`` (reducer falls back to
    ordered append)."""
    events: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("payload")
        if isinstance(payload, dict):
            payload = {**payload, "id": row.get("id"), "id_source": id_source}
        events.append({"id": row.get("id"), "type": row.get("type"), "payload": payload})
    return events


def _chat_context_ref_dict(ref: ChatContextRef) -> dict[str, Any]:
    data = ref.model_dump() if hasattr(ref, "model_dump") else ref.dict()
    return {
        "type": str(data.get("type") or "").strip(),
        "id": str(data.get("id") or "").strip(),
        "label": str(data.get("label") or "").strip() or None,
        "source": str(data.get("source") or "").strip() or None,
        "visible_token": str(data.get("visible_token") or "").strip() or None,
        "metadata": _json_safe(data.get("metadata") or {}),
    }


def _chat_context_ref_dicts(refs: list[ChatContextRef]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for ref in refs[:CHAT_CONTEXT_REF_MAX_ITEMS]:
        item = _chat_context_ref_dict(ref)
        key = (item["type"], item["id"])
        if not item["type"] or not item["id"] or key in seen:
            continue
        seen.add(key)
        normalized.append(item)
    return normalized


def _bounded_ref_text(value: Any, *, limit: int = CHAT_CONTEXT_REF_ITEM_MAX_CHARS) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _not_found_ref_text(ref: dict[str, Any]) -> str:
    return f"Reference not found: {ref.get('type')}:{ref.get('id')}"


def _chat_context_ref_metadata(ref: dict[str, Any]) -> dict[str, Any]:
    metadata = ref.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _artifact_path_for_context(artifact: ArtifactRef) -> str:
    if artifact.sensitivity == "sensitive":
        return "[redacted-sensitive-path]"
    return artifact.path


def _artifact_context_line(index: int, *, prefix: str, run_id: str, artifact: ArtifactRef) -> str:
    metadata_text = _bounded_ref_text(_json_safe(artifact.metadata), limit=500)
    return (
        f"[{index}] {prefix} {artifact.artifact_id}: run_id={run_id} kind={artifact.kind} "
        f"sensitivity={artifact.sensitivity} path={_artifact_path_for_context(artifact)} metadata={metadata_text}"
    )


def _artifact_is_text_like(artifact: ArtifactRef) -> bool:
    kind = artifact.kind.lower()
    path = artifact.path.lower()
    return (
        "json" in kind
        or "log" in kind
        or "text" in kind
        or "transcript" in kind
        or any(path.endswith(suffix) for suffix in CHAT_CONTEXT_TEXT_ARTIFACT_SUFFIXES)
    )


def _read_artifact_file_excerpt(store: StateStore, *, run_id: str, artifact: ArtifactRef) -> str:
    if artifact.sensitivity == "sensitive":
        return "content=[redacted-sensitive-artifact]"
    if artifact.path.startswith("superclaw-local://fusion/artifacts/"):
        return "content=[not-read-fusion-artifact]"
    if not _artifact_is_text_like(artifact):
        return "content=[not-read-non-text-artifact]"
    session = store.get_run(run_id)
    path = Path(artifact.path).resolve()
    allowed_root = _run_artifact_root(session.execution_context, run_id)
    if not _path_is_within(path, allowed_root):
        raise KeyError(artifact.artifact_id)
    if not path.is_file():
        raise KeyError(artifact.artifact_id)
    data = path.read_bytes()[: CHAT_CONTEXT_FILE_MAX_CHARS + 1]
    truncated = len(data) > CHAT_CONTEXT_FILE_MAX_CHARS
    if truncated:
        data = data[:CHAT_CONTEXT_FILE_MAX_CHARS]
    text = data.decode("utf-8", errors="replace")
    text = _bounded_ref_text(text, limit=CHAT_CONTEXT_FILE_MAX_CHARS)
    suffix = "\n[truncated]" if truncated else ""
    return f"content:\n{text}{suffix}"


def _safe_attachment_name(value: str | None, fallback: str) -> str:
    name = Path(str(value or "").strip()).name
    if not name:
        name = fallback
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", name)[:120] or fallback


def _chat_attachment_storage_dir(repo_path: str, session_id: str) -> Path:
    safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", session_id)[:80] or "session"
    # Attachments are WORKSPACE data: they must live inside the execution repo so the
    # backend (e.g. codex, read-only sandbox rooted at `--cd repo`) can actually open
    # them. So this stays repo-relative — deliberately NOT moved to the HOME data root.
    # For a project-less chat, `repo_path` is already a managed workspace under
    # ~/.superclaw/chats (off the iCloud-synced checkout); for a real repo the
    # attachments belong with that repo's own (already-syncing) files.
    root = (Path(repo_path or ".").expanduser().resolve() / ".superclaw" / "chat-attachments" / safe_session).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _decode_data_url(data_url: str) -> tuple[str | None, bytes]:
    header, sep, payload = data_url.partition(",")
    if not sep or not header.startswith("data:"):
        raise ValueError("invalid data URL")
    mime = header[5:].split(";", 1)[0] or None
    if ";base64" in header:
        return mime, base64.b64decode(payload, validate=True)
    return mime, payload.encode("utf-8")


def _attachment_context_line(index: int, *, kind: str, name: str, path: Path, mime: str | None, size: int) -> str:
    return f"[{index}] attachment {kind}: name={name} mime={mime or 'unknown'} size={size} path={path}"


def _resolve_chat_attachments(repo_path: str, session_id: str, attachments: list[ChatAttachment]) -> str:
    """Persist each upload to a path the runtime can reach, then hand the runtime
    those paths — nothing else.

    The surface deliberately does NOT read, excerpt, sniff, or truncate attachment
    content. Deciding what to open, how to parse it, and how much to read belongs
    to the underlying runtime (codex runs with repo read access), which can do it
    better and without an artificial cap. Pre-digesting here would be redundant and
    would bound what the runtime is allowed to use.
    """
    lines: list[str] = []
    storage_dir = _chat_attachment_storage_dir(repo_path, session_id) if attachments else None
    seen_paths: set[str] = set()
    for index, attachment in enumerate(attachments[:CHAT_ATTACHMENT_MAX_ITEMS], start=1):
        data = attachment.model_dump() if hasattr(attachment, "model_dump") else attachment.dict()
        kind = str(data.get("kind") or "file")
        name = _safe_attachment_name(data.get("name"), f"attachment-{index}")
        mime = str(data.get("mime") or "").strip() or None
        try:
            if kind == "local_path":
                raw_path = str(data.get("path") or "").strip()
                if not raw_path:
                    lines.append(f"[{index}] attachment local_path: status=missing-path")
                    continue
                if raw_path.startswith("file://"):
                    raw_path = raw_path[7:]
                path = Path(raw_path).expanduser().resolve()
                path_key = str(path)
                if path_key in seen_paths:
                    continue
                seen_paths.add(path_key)
                if not path.is_file():
                    lines.append(f"[{index}] attachment local_path: path={path} status=not-found-or-not-file")
                    continue
                inferred_mime = mime or mimetypes.guess_type(path.name)[0]
                size = path.stat().st_size
                lines.append(_attachment_context_line(index, kind="local_path", name=path.name, path=path, mime=inferred_mime, size=size))
                continue

            data_url = str(data.get("data_url") or "")
            if not data_url:
                lines.append(f"[{index}] attachment {kind}: name={name} status=missing-data")
                continue
            decoded_mime, payload = _decode_data_url(data_url)
            if len(payload) > CHAT_ATTACHMENT_MAX_BYTES:
                lines.append(f"[{index}] attachment {kind}: name={name} status=too-large size={len(payload)}")
                continue
            assert storage_dir is not None
            suffix = Path(name).suffix or (mimetypes.guess_extension(decoded_mime or mime or "") or "")
            stem = Path(name).stem or f"attachment-{index}"
            saved_name = _safe_attachment_name(f"{stem}-{uuid.uuid4().hex[:8]}{suffix}", f"attachment-{index}{suffix}")
            saved_path = (storage_dir / saved_name).resolve()
            saved_path.write_bytes(payload)
            resolved_mime = mime or decoded_mime or mimetypes.guess_type(saved_path.name)[0]
            resolved_kind = "image" if kind == "image" or (resolved_mime or "").startswith("image/") else "file"
            lines.append(_attachment_context_line(index, kind=resolved_kind, name=name, path=saved_path, mime=resolved_mime, size=len(payload)))
        except (OSError, ValueError, binascii.Error) as error:
            lines.append(f"[{index}] attachment {kind}: name={name} status=failed detail={str(error)}")
    return "\n".join(lines).strip()


def _merge_selected_context(*parts: str) -> str:
    sections = [part.strip() for part in parts if part and part.strip()]
    if not sections:
        return ""
    return "\n\n".join(sections)


def _parse_artifact_ref_id(ref_id: str) -> tuple[str | None, str]:
    if ":" not in ref_id:
        return None, ref_id
    run_id, artifact_id = ref_id.split(":", 1)
    return run_id.strip() or None, artifact_id.strip()


def _resolve_artifact_ref(store: StateStore, ref: dict[str, Any]) -> tuple[str, ArtifactRef]:
    ref_id = str(ref.get("id") or "")
    metadata = _chat_context_ref_metadata(ref)
    parsed_run_id, parsed_artifact_id = _parse_artifact_ref_id(ref_id)
    run_id = str(metadata.get("run_id") or parsed_run_id or "").strip()
    artifact_id = str(metadata.get("artifact_id") or parsed_artifact_id or ref_id).strip()
    if not run_id or not artifact_id:
        raise KeyError(ref_id)
    evidence = store.get_evidence(run_id)
    for artifact in evidence.artifacts:
        if artifact.artifact_id == artifact_id:
            return run_id, artifact
    raise KeyError(ref_id)


def _resolve_file_ref(store: StateStore, ref: dict[str, Any]) -> tuple[str, ArtifactRef]:
    run_id, artifact = _resolve_artifact_ref(store, ref)
    metadata = _chat_context_ref_metadata(ref)
    requested_path = str(metadata.get("path") or ref.get("id") or "").strip()
    if requested_path and requested_path != artifact.path:
        raise KeyError(str(ref.get("id") or ""))
    return run_id, artifact


# Persistent codex app-server thread per chat session for streaming direct chat.
# Reusing the thread gives native conversation memory; streaming flows via on_event.
_CHAT_CODEX_SESSIONS: dict[str, dict[str, Any]] = {}
_CHAT_CODEX_GUARD = threading.Lock()

# Unified task entry: runtime selection + capability negotiation live behind the
# pluggable runtime manager. codex-app-server is the default and (today) only
# full-capability runtime; other adapters declare degraded capability so overlay
# turns fail closed rather than silently differ. See docs/unified-task-entry.md.
_RUNTIME_MANAGER = default_runtime_manager()

# Per-chat-session locks serializing NATIVE-session turns (claude --resume et
# al.): two concurrent turns on one chat must never fork or interleave the
# same native session (advisor G4/B1). Codex inline turns already serialize on
# their conv lock.
_CHAT_NATIVE_LOCKS: dict[str, threading.Lock] = {}
_CHAT_NATIVE_LOCKS_GUARD = threading.Lock()


def _chat_native_lock(session_id: str) -> threading.Lock:
    with _CHAT_NATIVE_LOCKS_GUARD:
        return _CHAT_NATIVE_LOCKS.setdefault(session_id, threading.Lock())
# Adapter-namespace runtime ids normalized onto kernel backend names so an
# explicit runtime_id accepts either spelling.
_RUNTIME_ID_ALIASES = {"claude-cli": "claude", CODEX_APP_SERVER_RUNTIME_ID: "codex-app-server"}


def _sse_event(event_type: str, payload: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _get_chat_codex_session(
    chat_session_id: str,
    repo: str,
    *,
    resume_thread_id: str | None = None,
    extra_args: list[str] | None = None,
    model: str | None = None,
    permission_mode: str | None = None,
) -> dict[str, Any] | None:
    extra_args = list(extra_args or [])
    model = (model or "").strip() or None
    # Reasoning effort is NOT baked into the app-server process here: it rides the
    # native per-turn ``turn/start.effort`` field (see CodexAppServerSession.run_turn),
    # so changing effort never rebuilds the app-server or rebinds the thread. It is
    # therefore deliberately absent from extra_args / the session-rebuild key below.
    # Native runtime turn: the user's ask/allow preset maps onto codex's own
    # sandbox/approval — the SAME mapping the kernel CodexAppServerBackend uses
    # for a delivery run (zero divergence between chat and delivery semantics).
    mode = (permission_mode or "").strip() or "acceptEdits"
    if mode in {"bypassPermissions", "dontAsk"}:
        sandbox = "danger-full-access"
        approval_policy = "never"
        approval_decision = CodexApprovalDecision(
            accept_command=True, accept_file_change=True, accept_permissions=True, accept_mcp_tool=True, scope="session"
        )
    elif mode == "plan":
        sandbox = "read-only"
        approval_policy = "never"
        approval_decision = CodexApprovalDecision(accept_mcp_tool=True)
    else:  # acceptEdits / default / auto
        sandbox = "workspace-write"
        approval_policy = "on-request"
        approval_decision = CodexApprovalDecision(accept_file_change=True, accept_mcp_tool=True)
    # Canonicalize so different spellings of the SAME dir (relative / symlink /
    # a/../a) don't trigger spurious rebuilds — aligned with the generic native
    # chat resolver (repo_now = str(Path(repo_path).resolve())). A genuine
    # workspace-move to a different dir still changes this key and rebuilds.
    cwd_key = str(Path(repo).expanduser().resolve())
    stale: dict[str, Any] | None = None
    with _CHAT_CODEX_GUARD:
        conv = _CHAT_CODEX_SESSIONS.get(chat_session_id)
        if conv is not None and (
            conv.get("extra_args", []) != extra_args
            or conv.get("model") != model
            or conv.get("permission_mode") != mode
            or conv.get("cwd") != cwd_key
        ):
            # The projected plugin MCP set, the chat's model selection, the
            # permission mode, OR the execution cwd changed: the app-server client
            # bakes MCP servers in at launch, a live thread keeps the model it was
            # started with, a live session keeps its sandbox/approval posture, and
            # a live session is pinned to the cwd it was launched in — silently
            # reusing any of them would diverge from the user's selection. The cwd
            # check is the live-process half of the workspace-move resume guard
            # (workspace-sidebar-rework §4.5): after a session moves to a different
            # execution boundary, the persisted codex_thread_id is dropped AND this
            # in-process session is rebuilt against the new cwd, so the next turn
            # never resumes the old repo. Rebuild; thread/resume (when still set)
            # preserves the conversation's native memory.
            stale = conv
            conv = None
        if conv is None:
            executable, _source = find_codex_executable(os.environ.get("SUPERCLAW_CODEX_EXECUTABLE"))
            if not executable:
                return None
            client = CodexAppServerClient(executable=executable, request_timeout=25.0, extra_args=extra_args)
            session = CodexAppServerSession(
                cwd=Path(repo),
                client=client,
                sandbox=sandbox,
                approval_policy=approval_policy,
                approval_decision=approval_decision,
                post_tool_quiet_timeout_seconds=40,
                # Persist a rollout (non-ephemeral) and reattach to it when a prior
                # thread id is known, so chat keeps codex-native memory + compaction
                # across backend restarts.
                resume_thread_id=resume_thread_id,
                ephemeral=False,
                model=model,
            )
            conv = {
                "session": session,
                "lock": threading.Lock(),
                "turns": 0,
                "extra_args": extra_args,
                "model": model,
                "permission_mode": mode,
                "cwd": cwd_key,
            }
            _CHAT_CODEX_SESSIONS[chat_session_id] = conv
    if stale is not None and stale.get("session") is not None:
        try:
            stale["session"].close()
        except Exception:
            pass
    return conv


def _drop_chat_codex_session(chat_session_id: str) -> None:
    with _CHAT_CODEX_GUARD:
        conv = _CHAT_CODEX_SESSIONS.pop(chat_session_id, None)
    if conv and conv.get("session") is not None:
        try:
            conv["session"].close()
        except Exception:
            pass


def _chat_plugin_projection(repo: str) -> tuple[list[str], str | None]:
    """Project installed plugins as codex MCP `-c` overrides for the chat session.

    Returns (extra_args, capabilities_note). Empty when auto-projection is off or
    no plugin is available, so chat stays a plain conversation. Uses the low-context
    dispatch meta-tools by default. This is what lets `@plugin:<id> …` be answered
    inline in the chat (streaming tool calls + result) instead of spawning a run.
    """
    if os.environ.get("SUPERCLAW_AUTO_PROJECT_PLUGINS", "1").strip().lower() not in {"1", "true", "yes", "on"}:
        return [], None
    try:
        from superclaw.backends import _codex_mcp_config_overrides
        from superclaw.plugin_runtime_projection import build_runtime_plugin_policy_addition

        mode = os.environ.get("SUPERCLAW_PLUGIN_PROJECTION_MODE", "dispatch")
        # Plugin MCP projection files live under the HOME data root (not repo-relative —
        # that would sync into an iCloud checkout), namespaced by the resolved repo path
        # so concurrent chats in different repos do not overwrite each other's snapshot
        # (preserving the per-repo isolation the old `<repo>/.superclaw/...` path had).
        # The backend reads the projection by absolute --mcp-config path, so its location
        # is free to move off the repo tree.
        repo_key = hashlib.sha256(str(Path(repo).resolve()).encode()).hexdigest()[:16]
        mcp_path, note = build_runtime_plugin_policy_addition(
            artifact_dir=superclaw_data_path("artifacts", "chat-plugins", repo_key),
            mode=mode if mode in {"dispatch", "full"} else "dispatch",
            public_key=os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
        )
        if not mcp_path:
            return [], None
        return _codex_mcp_config_overrides([mcp_path]), note
    except Exception:
        return [], None


def _format_chat_history(messages: list[Any], *, max_messages: int = 20, max_chars: int = 6000) -> str:
    """Render recent chat turns as a transcript so direct chat has memory."""
    return _canonical_format_chat_history(messages, max_messages=max_messages, max_chars=max_chars)


def _plugin_task_prompt_envelope(
    message: str,
    *,
    plugin_note: str | None = None,
    active_plugin_id: str | None = None,
    history_text: str = "",
    context_text: str = "",
    runtime_notice: str = "",
    skill_ids: tuple[str, ...] = (),
    mcp_projected: bool = False,
) -> ChatPromptEnvelope:
    lines = [
        "You are SuperClaw's assistant. Carry out the user's request using the available plugin tools.",
        "Use superclaw__list_tools / superclaw__describe_tool / superclaw__call_tool to actually call the plugin",
        "— do not merely describe it. Then report the result (or any error) clearly to the user.",
        "Never execute a real payment/charge unless the user has explicitly confirmed it in this turn.",
        "For Pay-Switch submit_intent calls, map the current user message to execution fields instead of leaving safe defaults:",
        "- If the current user message explicitly asks to buy, purchase, subscribe, top up, pay, confirm payment, or execute payment for a concrete item, pass execute=true and dry_run=false.",
        "- If the current user message asks to inspect, price-check, prepare, simulate, test, dry-run, or only asks a question, pass execute=false and dry_run=true.",
        "- If the request is ambiguous about item, amount, payee, or target account/profile, call read-only/status/list tools first and ask for the missing confirmation instead of executing.",
        "- Do not ask for a Chrome profile when the Pay-Switch tool output includes configured_profile.configured=true; use that configured profile.",
    ]
    if active_plugin_id:
        lines += [
            "",
            f"Active plugin for this chat session: @plugin:{active_plugin_id}.",
            "Treat this turn as a continuation of that plugin task unless the user explicitly switches mode or plugin.",
        ]
    # A turn carrying BOTH @plugin and @skill: also apply the skill overlay so an
    # explicit @skill is never silently dropped on the plugin path.
    if skill_ids:
        lines += _skill_overlay_lines(tuple(skill_ids), mcp_projected=mcp_projected)
    if plugin_note:
        lines += ["", plugin_note]
    return build_chat_prompt_envelope(
        message,
        history_text=history_text,
        context_text=context_text,
        runtime_notice=runtime_notice,
        tool_contract="\n".join(lines),
        history_heading="Conversation so far (your memory of this session):",
    )


def _plugin_task_prompt(
    message: str,
    *,
    plugin_note: str | None = None,
    active_plugin_id: str | None = None,
    history_text: str = "",
    context_text: str = "",
    runtime_notice: str = "",
) -> str:
    return _plugin_task_prompt_envelope(
        message,
        plugin_note=plugin_note,
        active_plugin_id=active_plugin_id,
        history_text=history_text,
        context_text=context_text,
        runtime_notice=runtime_notice,
    ).prompt


def _skill_overlay_lines(skill_ids: tuple[str, ...], *, mcp_projected: bool) -> list[str]:
    """Resolve @skill overlays into prompt lines (P3). Shared by the skill-only
    turn and a plugin turn that also carries @skill (so an explicit @skill is
    never silently dropped when a plugin is present).

    PROSE skills are inlined (guaranteed activation). TOOL skills point at the MCP
    proxy ONLY when the plugin/MCP projection actually happened this turn
    (``mcp_projected``); otherwise they are reported unavailable rather than
    instructing the model to call a tool that was never projected. Unknown /
    unreadable / too-large / unsupported skills are reported honestly.
    """
    from superclaw.skill_runtime import BackendSkillCapability, resolve_skill_overlay_for_prompt

    overlay = resolve_skill_overlay_for_prompt(
        tuple(skill_ids), capability=BackendSkillCapability.mcp_backend()
    )
    lines: list[str] = []
    for slug, name, body in overlay.prose:
        lines += ["", f"Apply this SuperClaw skill now — «{name}» ({slug}):", body]
    unavailable_notes = [f"{u.requested_id} ({u.reason.value})" for u in overlay.unavailable]
    # A tool-skill is only callable if the MCP server was projected this turn AND
    # the requested plugin id is in the ACTUALLY-projectable set. The overlay's
    # tool resolution uses the gate WITHOUT the tool-count filter; the MCP
    # projection uses available_plugins (drops zero-tool / projection-failed
    # plugins). Verify per-plugin against that set so we never instruct the model
    # to call a skill.<slug> that another plugin's projection made `mcp_projected`
    # true for but which is itself not in the catalog.
    projected_ids: set[str] = set()
    if mcp_projected and overlay.tool:
        try:
            from superclaw.plugin_runtime_projection import available_plugins

            projected_ids = {
                p.plugin_id
                for p in available_plugins(public_key=os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"))
                if p.tools
            }
        except Exception:
            projected_ids = set()
    callable_tools = [(slug, pid) for slug, pid in overlay.tool if pid and pid in projected_ids]
    uncallable_tools = [(slug, pid) for slug, pid in overlay.tool if not (pid and pid in projected_ids)]
    if callable_tools:
        tool_names = ", ".join(slug for slug, _ in callable_tools)
        lines += [
            "",
            f"The skill(s) {tool_names} are governed tools projected through the SuperClaw MCP proxy.",
            "Use superclaw__list_tools / superclaw__describe_tool / superclaw__call_tool to find and call",
            "the tool(s) — do not merely describe them. Then report the result (or any error) clearly.",
        ]
    unavailable_notes += [f"{slug} (mcp_not_projected)" for slug, _ in uncallable_tools]
    if unavailable_notes:
        lines += ["", f"These requested skill(s) are not available on this runtime: {'; '.join(unavailable_notes)}."]
    return lines


def _skill_task_prompt_envelope(
    message: str,
    *,
    skill_ids: tuple[str, ...],
    plugin_note: str | None = None,
    history_text: str = "",
    context_text: str = "",
    runtime_notice: str = "",
    mcp_projected: bool = False,
) -> ChatPromptEnvelope:
    """Prompt for a skill-overlay turn (codex family). Skills are NOT plugin tasks
    — the plugin-specific instructions (payment mapping etc.) must not be applied.

    P3: each requested @skill is resolved through the kernel — PROSE skills inlined
    (guaranteed activation), TOOL skills via the MCP proxy when projected, anything
    else reported honestly (see :func:`_skill_overlay_lines`)."""
    skills = ", ".join(skill_ids)
    lines = [f"You are SuperClaw's assistant. The user invoked the SuperClaw skill(s): {skills}."]
    lines += _skill_overlay_lines(tuple(skill_ids), mcp_projected=mcp_projected)
    if plugin_note:
        lines += ["", plugin_note]
    return build_chat_prompt_envelope(
        message,
        history_text=history_text,
        context_text=context_text,
        runtime_notice=runtime_notice,
        tool_contract="\n".join(lines),
        history_heading="Conversation so far (your memory of this session):",
    )


def _skill_task_prompt(
    message: str,
    *,
    skill_ids: tuple[str, ...],
    plugin_note: str | None = None,
    history_text: str = "",
    context_text: str = "",
    runtime_notice: str = "",
) -> str:
    return _skill_task_prompt_envelope(
        message,
        skill_ids=skill_ids,
        plugin_note=plugin_note,
        history_text=history_text,
        context_text=context_text,
        runtime_notice=runtime_notice,
    ).prompt


def _resolve_chat_effective_intent(
    store: StateStore,
    *,
    session_id: str,
    message: str,
    mode: str,
    base_intent: str,
    context_refs: list[dict[str, Any]] | None = None,
) -> tuple[str, str | None, bool]:
    """Apply sticky plugin context after explicit per-turn routing is classified."""
    selected_mode = mode.strip().lower()
    if selected_mode != "auto":
        try:
            store.clear_chat_active_plugin_id(session_id)
        except KeyError:
            pass
        return base_intent, None, False

    # A company-management overlay (@company / @company:create) MUST run the
    # orchestrator turn: intent="delivery" is the ONLY chat execution path that wires
    # the Stage-1 company tool channel (team MCP proxy). A "task"/"chat" turn streams
    # the native/codex runtime inline with NO company tools — a "@company …" turn there
    # would carry only the injected guidance text and no tool to act on it. The design
    # already earmarks delivery as the future Agent-company runtime, so this is the
    # aligned bridge. The selected company HOMES the operator scope via
    # ``execution_context_extra`` at the orchestrator run-creation sites.
    if _has_company_overlay(context_refs):
        try:
            store.clear_chat_active_plugin_id(session_id)
        except KeyError:
            pass
        return "delivery", None, False

    explicit_plugin_id = extract_plugin_id(message) or _selected_plugin_id_from_context_refs(context_refs)
    if explicit_plugin_id:
        try:
            store.set_chat_active_plugin_id(session_id, explicit_plugin_id)
        except KeyError:
            pass
        return "task", explicit_plugin_id, False

    # NOTE: @skill needs no branch here — the kernel router already classifies it
    # as an overlay turn ("task"), and the fall-through below returns it with no
    # sticky plugin. Surfaces must not duplicate kernel parsing.

    if base_intent == "delivery":
        try:
            store.clear_chat_active_plugin_id(session_id)
        except KeyError:
            pass
        return base_intent, None, False

    if base_intent == "chat":
        active_plugin_id = store.get_chat_active_plugin_id(session_id)
        if active_plugin_id:
            return "task", active_plugin_id, True

    return base_intent, None, False


def _selected_plugin_id_from_context_refs(refs: list[dict[str, Any]] | None) -> str | None:
    for ref in refs or []:
        if str(ref.get("type") or "") != "plugin":
            continue
        plugin_id = str(ref.get("id") or "").strip()
        if plugin_id and extract_plugin_id(f"@plugin:{plugin_id}") == plugin_id:
            return plugin_id
    return None


def _has_company_overlay(refs: list[dict[str, Any]] | None) -> bool:
    """True if the turn carries a company-management overlay (@company / @company:create).

    Such a turn must route to the orchestrator (intent="delivery") so the Stage-1
    company tool channel is wired — see ``_resolve_chat_effective_intent``.
    """
    return any(str(ref.get("type") or "") in {"company", "company_create"} for ref in refs or [])


def _resolve_chat_context_refs(store: StateStore, refs: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for index, ref in enumerate(refs, start=1):
        ref_type = str(ref.get("type") or "")
        ref_id = str(ref.get("id") or "")
        label = str(ref.get("label") or ref_id)
        try:
            if ref_type == "chat_session":
                session = store.get_chat_session(ref_id)
                lines.append(f"[{index}] chat_session {session.session_id}: {session.title}")
                for message in session.messages[-5:]:
                    content = _bounded_ref_text(message.content, limit=500)
                    run_suffix = f" run_id={message.run_id}" if message.run_id else ""
                    lines.append(f"    - {message.role}{run_suffix}: {content}")
            elif ref_type == "run":
                run = store.get_run(ref_id)
                lines.append(
                    f"[{index}] run {run.run_id}: status={run.status} goal_id={run.goal_id} dry_run={run.dry_run}"
                )
            elif ref_type == "evidence":
                evidence = store.get_evidence(ref_id)
                lines.append(f"[{index}] evidence {evidence.run_id}: chain_verdict={evidence.chain_verdict.value}")
                for finding in evidence.findings[:5]:
                    lines.append(
                        "    - "
                        + _bounded_ref_text(
                            f"finding={finding.name} passed={finding.passed} severity={finding.severity} detail={finding.detail}",
                            limit=500,
                        )
                    )
                for command in evidence.commands[:3]:
                    lines.append(
                        "    - "
                        + _bounded_ref_text(
                            f"command={command.get('command')} exit_code={command.get('exit_code')} output={command.get('output')}",
                            limit=500,
                        )
                    )
            elif ref_type == "plugin":
                metadata = ref.get("metadata") or {}
                lines.append(f"[{index}] plugin {ref_id}: {label} metadata={_bounded_ref_text(_json_safe(metadata), limit=800)}")
            elif ref_type == "artifact":
                artifact_run_id, artifact = _resolve_artifact_ref(store, ref)
                lines.append(_artifact_context_line(index, prefix="artifact", run_id=artifact_run_id, artifact=artifact))
            elif ref_type == "file":
                artifact_run_id, artifact = _resolve_file_ref(store, ref)
                lines.append(_artifact_context_line(index, prefix="file", run_id=artifact_run_id, artifact=artifact))
                lines.append("    " + _read_artifact_file_excerpt(store, run_id=artifact_run_id, artifact=artifact).replace("\n", "\n    "))
            elif ref_type == "company":
                # The user @-selected an EXISTING company to manage. Resolve it and
                # steer the agent to the kernel company tools targeting THIS company —
                # the routing that makes "@company → 看任务/派活" deterministic rather
                # than the model improvising with files. Authority is unchanged: the
                # operator scope + execute_company_command still gate every mutation.
                company = store.get_company_profile(ref_id)
                status = str(getattr(company, "status", "") or "active")
                lines.append(
                    f"[{index}] company {company.company_profile_id} ({company.name}): status={status}. "
                    f"This chat turn is SCOPED to this company — newly created issues / hires land in "
                    f"it by default. Use the company-management tools (issue_create / issue_assign / "
                    f"issue_delegate / issue_comment / agent_hire / company_update / …) to manage it; to "
                    f"target a specific team inside it, name its workspace_id. Do not create files to "
                    f"represent or simulate the company's state."
                )
                # A few recent issues so "show me the tasks" has immediate context.
                for issue in store.list_issues(company_profile_id=company.company_profile_id)[:5]:
                    lines.append(
                        "    - "
                        + _bounded_ref_text(
                            f"issue {issue.issue_id}: {issue.title} status={issue.status} "
                            f"assignee={getattr(issue, 'assignee_agent_profile_id', None)}",
                            limit=300,
                        )
                    )
            elif ref_type == "company_create":
                # The user @-selected "create a new company" — an INTENT, not an entity.
                # Steer the agent to the company_create tool so a claude/codex chat builds
                # a real SuperClaw company (Stage-1 surfaces that tool to every runtime),
                # not a folder of files (the failure this affordance exists to fix).
                requested = str((ref.get("metadata") or {}).get("name_hint") or "").strip()
                name_hint = (
                    f' The user typed "{requested}" as a starting hint for the name.'
                    if requested
                    else ""
                )
                lines.append(
                    f"[{index}] intent=create_company: the user has EXPLICITLY chosen to create a new "
                    f"SuperClaw company (an Agent company with its own agents and issues). Use the "
                    f"company_create tool to create the company entity, deriving the name and goal from "
                    f"the user's message.{name_hint} Do NOT create files or directories to represent the company."
                )
            else:
                lines.append(f"[{index}] {_not_found_ref_text(ref)}")
        except KeyError:
            lines.append(f"[{index}] {_not_found_ref_text(ref)}")
    text = "\n".join(lines).strip()
    if len(text) <= CHAT_CONTEXT_REF_TEXT_MAX_CHARS:
        return text
    return text[: CHAT_CONTEXT_REF_TEXT_MAX_CHARS - 3].rstrip() + "..."


def _chat_selected_company_id(store: StateStore, refs: list[dict[str, Any]]) -> str | None:
    """The company a user @-selected to manage, or None.

    Used to HOME the chat run's operator scope to that company
    (``execution_context.company_profile_id`` → ``_company_scope_for_run`` →
    ``actor_company_id``), so a "@company X … create an issue" turn lands the issue
    in X rather than the default ``local`` home. Fail-closed: the id is verified
    against the store (an unknown / hard-deleted company → None, never a phantom
    scope). The FIRST company ref wins (one home per turn); the resolver-injected
    guidance text already lists every selected company's issues for context.
    """
    for ref in refs:
        if str(ref.get("type") or "") != "company":
            continue
        company_id = str(ref.get("id") or "")
        if not company_id:
            return None
        try:
            store.get_company_profile(company_id)
        except KeyError:
            return None
        return company_id
    return None


def _delivery_description_from_chat(
    *,
    request_message: str,
    context_messages: list[dict[str, Any]],
    selected_context_text: str = "",
) -> str:
    lines = [
        "Current delivery request:",
        request_message.strip(),
        "",
        "Conversation context from the originating SuperClaw chat session, oldest to newest:",
    ]
    for index, message in enumerate(context_messages, start=1):
        role = str(message.get("role") or "unknown")
        content = str(message.get("content") or "").strip()
        run_id = message.get("run_id")
        run_suffix = f" run_id={run_id}" if run_id else ""
        lines.append(f"[{index}] {role}{run_suffix}: {content}")
    if selected_context_text.strip():
        lines.extend(["", "Selected context references:", selected_context_text.strip()])
    description = "\n".join(lines).strip()
    if len(description) <= CHAT_DELIVERY_CONTEXT_TOTAL_MAX_CHARS:
        return description
    return description[: CHAT_DELIVERY_CONTEXT_TOTAL_MAX_CHARS - 3].rstrip() + "..."


class SecretCreateRequest(BaseModel):
    name: str
    value: str
    description: str = ""
    company: str = "local"


class SecretValueRequest(BaseModel):
    value: str
    company: str = "local"


class SecretArchiveRequest(BaseModel):
    archived: bool = True
    company: str = "local"


class SecretBindRequest(BaseModel):
    target_type: str
    target_id: str
    env: str
    required: bool = True
    company: str = "local"


class InstanceSettingsPatchRequest(BaseModel):
    patch: dict[str, Any]


class DaemonBrokerOpenSessionRequest(BaseModel):
    subject: str | None = None
    ttl_seconds: float | None = Field(default=None, gt=0)


class DaemonBrokerIssueTokenRequest(BaseModel):
    session_id: str
    scopes: list[str]
    ttl_seconds: float | None = Field(default=None, gt=0)
    subject: str | None = None


class DaemonBrokerValidateTokenRequest(BaseModel):
    token: str
    required_scope: str


class DaemonBrokerMaterializeRequest(BaseModel):
    token: str
    plugin_id: str
    manifest: dict[str, Any] = Field(default_factory=dict)
    files: dict[str, str] = Field(default_factory=dict)


def _env_truthy(value: str | None) -> bool:
    """A conservative truthy parse for env opt-in flags (fail-closed on unset)."""
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _export_zip_filename(company_profile_id: str) -> str:
    """A Content-Disposition-safe download filename for a company export zip.

    Whitelist-cleans the company id to ``[A-Za-z0-9._-]`` so a hostile id (quotes,
    CR/LF) can never break out of the header (response splitting / MIME break).
    Module-level + pure so the sanitization is unit-tested directly, not only
    through routing (where the framework may pre-reject a malicious path)."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", company_profile_id).strip("-") or "company"
    return f"{safe}-export.zip"


_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def create_app(state_path: str | Path | None = None) -> FastAPI:
    # state_path defaults to the shared canonical resolver (~/.superclaw/state.db,
    # honoring SUPERCLAW_STATE_PATH) so the API surface lands the state singleton in
    # the SAME place as the CLI/desktop entrypoints — never cwd-relative, which would
    # drift the DB into an iCloud-synced repo checkout. Explicit callers (tests, the
    # desktop sidecar) still pass their own path.
    if state_path is None:
        state_path = default_state_path()
    configure_logging()
    hydrate_clawhunt_auth_environment()
    # Default the kind-scoped trust roots to the build-baked official public key
    # (frozen builds only; explicit env override wins). No-op from source/tests.
    hydrate_official_root_public_keys()
    app = FastAPI(title="SuperClaw API", version="0.1.0")

    # Node front door — reverse-proxy the Node-owned prefixes from node_routes.json
    # (the SAME manifest the Vite dev proxy uses) to the co-launched Node control
    # plane, so production/desktop hosting of apps/web's static bundle routes like dev
    # does. Added FIRST so it ends up INNERMOST in the ASGI stack (Starlette's
    # add_middleware prepends): proxied requests still pass through CORS and the
    # access-log / X-Request-Id middleware below. Marker-gated + fail-closed —
    # delegates to the Python app when Node was not co-launched here (plain-Python
    # deployments, the whole test suite), else 503 (never a silent Python fallthrough)
    # when Node is meant to be up but unreachable.
    app.add_middleware(NodeFrontDoorMiddleware, run_dir=Path(state_path).parent / "run")

    # Gateway front door — the production/desktop equivalent of the Vite proxy's
    # ``/gateway-api`` rule: reverse-proxy ``/gateway-api/*`` to the co-launched Node
    # automation gateway (different target + control token than the Node control
    # plane, so it is a separate thin middleware). Same marker-gated, fail-closed
    # semantics keyed on the gateway's own marker — delegates when the gateway was not
    # co-launched here (the route 404s as before), else 503 when it is up but
    # unreachable. Added alongside the Node front door (distinct prefix; order between
    # them is immaterial).
    app.add_middleware(GatewayFrontDoorMiddleware, run_dir=Path(state_path).parent / "run")

    configured_origins = os.environ.get("SUPERCLAW_CORS_ORIGINS")
    allow_origins = [
        origin.strip()
        for origin in (configured_origins.split(",") if configured_origins else [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://tauri.localhost",
            "tauri://localhost",
        ])
        if origin.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        # The desktop D1 model keeps the window on tauri://localhost and has the
        # board/plugins reach this front door cross-origin on the loopback port. The
        # requesting origin is the webview's tauri://localhost (already allow-listed
        # above); its fetch uses credentials:'include' and plugin EventSource sets
        # withCredentials, so the browser requires Access-Control-Allow-Credentials.
        # Safe because allow_origins is an explicit allow-list (never "*").
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _request_log_middleware(request, call_next):
        """Per-request structured access log + trace correlation.

        Metadata only — never the body or query string. Binds a request_id (from
        an inbound ``X-Request-Id`` or freshly generated) plus a trace_id so every
        log line the request emits is correlated, and echoes ``X-Request-Id`` back
        to the client. This is a presentation-layer self-observation (it does not
        add any business semantics or export surface).

        **Scope of the completion semantics (intentional, not a gap):** for a
        STREAMING / SSE response, ``request.done`` and ``duration_ms`` are recorded
        when the response object is ready (headers), NOT when the streamed body
        finishes — duration is time-to-response, and a failure that happens mid
        stream is not observed here. Streaming lifecycle diagnostics belong to the
        EventBus / SSE event layer (roadmap §5 ⑧), not this access middleware.
        ``X-Request-Id`` is still attached to streaming responses, and an unhandled
        error BEFORE the response object is returned is captured + 500'd here."""
        incoming = request.headers.get("x-request-id")
        # Inbound request id is untrusted: only honour a safe token, otherwise
        # generate one — prevents log/header injection via a crafted X-Request-Id.
        request_id = incoming if incoming and _SAFE_REQUEST_ID.fullmatch(incoming) else trace_context.new_id("req")
        access = get_logger("api.access")
        started = time.monotonic()
        with trace_context.start_trace(request_id=request_id):
            try:
                response = await call_next(request)
            except Exception:
                # Take over the unhandled-exception 500 ourselves (instead of
                # re-raising to the outer ServerErrorMiddleware) so the error
                # response — the case that most needs correlation — also carries
                # X-Request-Id. The traceback is preserved in the access log.
                duration_ms = (time.monotonic() - started) * 1000.0
                access.exception(
                    "request.error method=%s path=%s duration_ms=%.1f",
                    request.method, request.url.path, duration_ms,
                )
                response = JSONResponse({"detail": "Internal Server Error"}, status_code=500)
            else:
                duration_ms = (time.monotonic() - started) * 1000.0
                access.info(
                    "request.done method=%s path=%s status=%s duration_ms=%.1f",
                    request.method, request.url.path, response.status_code, duration_ms,
                )
            response.headers["x-request-id"] = request_id
            return response

    event_bus = EventBus()
    store = StateStore(state_path, event_bus=event_bus)
    orchestrator = SuperClawOrchestrator(store)
    eval_runner = EvalRunner(os.environ.get("SUPERCLAW_EVAL_ROOT") or default_eval_root())
    plugin_cloud_root = Path(os.environ.get("SUPERCLAW_PLUGIN_CLOUD_PATH", os.fspath(DEFAULT_CLOUD_ROOT)))
    daemon_broker_state = Path(state_path).parent / "daemon-broker.json"
    daemon_broker_temp_root = Path(state_path).parent / "daemon-broker-sessions"
    app.state.started_at = time.time()
    app.state.control_token = os.environ.get("SUPERCLAW_CONTROL_TOKEN")
    app.state.store = store
    app.state.event_bus = event_bus
    app.state.orchestrator = orchestrator
    app.state.eval_runner = eval_runner
    app.state.plugin_cloud_root = plugin_cloud_root
    app.state.daemon_broker_control = LocalDaemonBrokerControl(
        state_file=daemon_broker_state,
        temp_root=daemon_broker_temp_root,
    )
    app.state.eval_threads = {}
    app.state.webhook_events = []

    # Ghost-state eradication: converge runs whose stored status claims an
    # execution that no live lease backs (crash / kill -9 leftovers) once at
    # startup, then keep converging in the background. Reads stay truthful via
    # effective_run_state regardless; the sweeper repairs the stored record.
    try:
        app.state.startup_reconciled_run_ids = [result.run_id for result in orchestrator.reconcile_stale_runs()]
    except Exception:
        app.state.startup_reconciled_run_ids = []
    reconcile_sweeper_stop = threading.Event()
    app.state.reconcile_sweeper_stop = reconcile_sweeper_stop

    def _reconcile_sweep_loop() -> None:
        while not reconcile_sweeper_stop.wait(RECONCILE_SWEEP_INTERVAL_SECONDS):
            try:
                orchestrator.reconcile_stale_runs()
            except Exception:
                continue

    threading.Thread(target=_reconcile_sweep_loop, name="run-reconcile-sweeper", daemon=True).start()

    # Engine-ready-on-open: when the app launcher opts in
    # (SUPERCLAW_DAEMON_AUTOSTART truthy — set by the desktop/web shell, NOT by a
    # bare create_app() in tests), run the heartbeat daemon's drain loop in-process
    # so event-driven wakeups (issue comment / @mention / assignment) are serviced
    # the moment the app opens — no separate `superclaw daemon start` needed. The
    # autonomous TIMER scheduler stays gated by the instance master switch
    # (heartbeat_enabled, default off) INSIDE the loop, so autostart only turns on
    # the safe event-driven channel, never unattended self-pickup. A second gate —
    # the instance setting general.daemon_autostart (default true) — lets an
    # operator disable the engine from the surface even when the launcher opted in.
    heartbeat_daemon_stop = threading.Event()
    app.state.heartbeat_daemon_stop = heartbeat_daemon_stop
    app.state.heartbeat_daemon_running = False

    def _daemon_autostart_requested() -> bool:
        if not _env_truthy(os.environ.get("SUPERCLAW_DAEMON_AUTOSTART")):
            return False
        try:
            settings = store.get_instance_settings()
            return bool(settings.general.get("daemon_autostart", True))
        except Exception:
            # A broken governance store must never be the thing that lets the
            # engine run unattended — fail closed.
            return False

    if _daemon_autostart_requested():
        try:
            from superclaw.daemon import HeartbeatDaemon

            engine = HeartbeatDaemon(
                store,
                orchestrator,
                repo_path=os.environ.get("SUPERCLAW_REPO", "."),
                artifact_dir=str(default_artifact_dir()),
            )
            app.state.heartbeat_daemon = engine

            def _heartbeat_daemon_loop() -> None:
                app.state.heartbeat_daemon_running = True
                try:
                    engine.run_forever(
                        interval_seconds=float(os.environ.get("SUPERCLAW_DAEMON_INTERVAL", "5") or 5),
                        stop_check=heartbeat_daemon_stop.is_set,
                    )
                except Exception:  # pragma: no cover - the engine must not crash boot
                    pass
                finally:
                    app.state.heartbeat_daemon_running = False

            threading.Thread(target=_heartbeat_daemon_loop, name="heartbeat-daemon", daemon=True).start()
        except Exception:  # pragma: no cover - autostart is best-effort, never fatal
            app.state.heartbeat_daemon_running = False

    @app.exception_handler(ValueError)
    async def _value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
        # Unified contract: domain validation errors surface as 400 with a stable
        # shape instead of leaking as unhandled 500s. Endpoints that want a more
        # specific status (e.g. resume -> 409) still catch ValueError locally.
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def _request_validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI's default 422 body echoes the submitted `input` (and `ctx`),
        # reflecting attacker-controlled values / accidental secrets back in the
        # error. Keep the 422 status and field location/message/type, but drop
        # the echoed input so no request content is mirrored. Applies app-wide.
        errors = [
            {"loc": list(err.get("loc", [])), "msg": err.get("msg", ""), "type": err.get("type", "")}
            for err in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})

    def require_control_token(
        authorization: str | None = Header(default=None),
        x_superclaw_token: str | None = Header(default=None),
        token: str | None = None,
    ) -> None:
        expected = getattr(app.state, "control_token", None)
        if not expected:
            return
        provided = x_superclaw_token or token
        if not provided and authorization and authorization.lower().startswith("bearer "):
            provided = authorization.split(None, 1)[1].strip()
        if provided != expected:
            raise HTTPException(status_code=401, detail="SuperClaw control token required")

    def current_control_token() -> str | None:
        return getattr(app.state, "control_token", None)

    def media_request_artifact_dir(run_id: str | None, artifact_dir: str | None) -> Path | None:
        if not run_id:
            return Path(artifact_dir) if artifact_dir else None
        try:
            session = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        try:
            store.get_evidence(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run evidence not found") from exc
        run_root = _run_artifact_root(session.execution_context, run_id)
        target = (Path(artifact_dir) if artifact_dir else run_root / "media").expanduser().resolve()
        if not _path_is_within(target, run_root):
            raise HTTPException(status_code=400, detail="media artifact_dir must be inside run artifact root")
        return target

    def attach_media_result_to_run(
        result: dict[str, Any],
        run_id: str | None,
        *,
        artifact_kind: str,
        event_type: str,
    ) -> dict[str, Any]:
        payload = dict(result)
        payload["run_id"] = run_id
        payload["evidence_attached"] = False
        if not run_id:
            return payload
        try:
            session = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        try:
            evidence = store.get_evidence(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run evidence not found") from exc
        artifact_id = str(payload.get("artifact_id") or "")
        artifact_path = str(payload.get("artifact_path") or "")
        if not artifact_id or not artifact_path:
            raise HTTPException(status_code=500, detail="media artifact result missing artifact reference")
        resolved_path = Path(artifact_path).resolve()
        run_root = _run_artifact_root(session.execution_context, run_id)
        if not _path_is_within(resolved_path, run_root):
            raise HTTPException(status_code=500, detail="media artifact path not attachable")
        template = payload.get("template") if isinstance(payload.get("template"), dict) else {}
        metadata = {
            "provider": payload.get("provider"),
            "status": payload.get("status"),
            "template_id": template.get("id") if isinstance(template, dict) else None,
            "query": payload.get("query"),
            "task_id": payload.get("task_id"),
            "file_name": payload.get("file_name"),
            "runninghub_endpoint": payload.get("endpoint"),
            "media_artifact_url": payload.get("artifact_url"),
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
                "status": payload.get("status"),
                "task_id": payload.get("task_id"),
                "query": payload.get("query"),
                "endpoint": f"/api/runs/{run_id}/artifacts/{artifact_id}",
            },
        )
        payload["evidence_attached"] = True
        payload["run_artifact_url"] = f"/api/runs/{run_id}/artifacts/{artifact_id}"
        return payload

    media_render_step_attachments = {
        "generate": ("runninghub-media-task-json", "media.generate.recorded"),
        "status": ("runninghub-media-status-json", "media.task_status.recorded"),
        "outputs": ("runninghub-media-outputs-json", "media.outputs.recorded"),
    }

    def attach_media_render_to_run(result: dict[str, Any], run_id: str | None) -> dict[str, Any]:
        payload = dict(result)
        payload["run_id"] = run_id
        payload["evidence_attached"] = False
        if not run_id:
            return payload
        attached_steps: list[dict[str, Any]] = []
        for step in payload.get("steps", []):
            if not isinstance(step, dict) or not isinstance(step.get("result"), dict):
                attached_steps.append(step)
                continue
            artifact_kind, event_type = media_render_step_attachments.get(
                str(step.get("step")),
                ("runninghub-media-task-json", "media.generate.recorded"),
            )
            attached = attach_media_result_to_run(
                step["result"],
                run_id,
                artifact_kind=artifact_kind,
                event_type=event_type,
            )
            updated_step = dict(step)
            updated_step["result"] = attached
            attached_steps.append(updated_step)
        payload["steps"] = attached_steps
        payload["artifacts"] = [
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
        payload["evidence_attached"] = any(
            isinstance(step.get("result"), dict) and step["result"].get("evidence_attached")
            for step in attached_steps
            if isinstance(step, dict)
        )
        return payload

    def cloud_root() -> Path:
        return Path(app.state.plugin_cloud_root)

    def clawhunt_ingestion_root() -> Path:
        return cloud_root() / "clawhunt-ingestions"

    def clawhunt_ingestion_package_ref(plugin_id: str, version: str) -> str:
        return f"superclaw-local://clawhunt-ingestions/packages/{plugin_id}/{version}"

    def developer_submission_root() -> Path:
        return cloud_root() / "developer-submissions"

    def developer_submission_record_path(submission_id: str) -> Path:
        return developer_submission_root() / "jobs" / f"{submission_id}.json"

    def developer_submission_signed_ref(submission_id: str) -> str:
        return f"superclaw-local://developer-submissions/{submission_id}/signed-package"

    catalog_cache: dict[str, tuple[float, Any]] = {}

    def clear_catalog_cache() -> None:
        catalog_cache.clear()

    def catalog_resolution(kind: str | None = None):
        if kind is not None and kind not in CATALOG_KINDS:
            raise HTTPException(status_code=400, detail=f"unknown catalog kind: {kind!r}")
        cache_key = kind or "__all__"
        now = time.monotonic()
        cached = catalog_cache.get(cache_key)
        if cached is not None and now - cached[0] < CATALOG_CACHE_TTL_SECONDS:
            return cached[1]
        try:
            resolution = resolve_catalog(
                kind=kind,
                cache_root=plugin_cache_root(),
                cloud_root=cloud_root(),
                registry_root=default_registry_root(),
                companies_root=default_companies_root(),
                revocation_file=cloud_root() / "governance" / "revocations.json",
                company_revocation_file=default_company_revocation_file(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        catalog_cache[cache_key] = (now, resolution)
        return resolution

    def catalog_items_by_plugin_ref(resolution) -> dict[tuple[str, str], dict[str, Any]]:
        items: dict[tuple[str, str], dict[str, Any]] = {}
        for item in resolution.items:
            payload = item.to_dict()
            items[(item.plugin_id, item.version)] = payload
        return items

    def catalog_trust_backfill(row: dict[str, Any], catalog_items: dict[tuple[str, str], dict[str, Any]]) -> dict[str, Any]:
        plugin_id = str(row.get("plugin_id") or "")
        version = str(row.get("version") or "")
        item = catalog_items.get((plugin_id, version))
        if item is None:
            return {
                **row,
                "catalog_kind": "plugin",
                "trust": "untrusted",
                "trust_reasons": ["catalog_item_unresolved"],
                "signer_class": "none",
                "namespace_reserved": False,
                "install_state": {"installed": False, "installed_versions": [], "update_available": False},
                "entitlement_state": "required" if row.get("entitlement_required") else "not_required",
                "revoked": False,
                "sources": ["registry"],
                "instantiable": True,
            }
        return {
            **row,
            "catalog_kind": item["kind"],
            "trust": item["trust"],
            "trust_reasons": item["trust_reasons"],
            "signer_class": item["signer_class"],
            "namespace_reserved": item["namespace_reserved"],
            "install_state": item["install_state"],
            "entitlement_state": item["entitlement_state"],
            "revoked": item["revoked"],
            "sources": item["sources"],
            "instantiable": item["instantiable"],
        }

    def sanitize_clawhunt_ingestion_error(exc: Exception) -> str:
        detail = str(exc)[:300]
        if "/" in detail or "\\" in detail:
            return "clawhunt ingestion request failed validation"
        return detail or "clawhunt ingestion request failed validation"

    def sanitize_developer_submission_error(exc: Exception) -> str:
        detail = str(exc)[:300]
        if "/" in detail or "\\" in detail:
            return "developer submission request failed validation"
        return detail or "developer submission request failed validation"

    def sanitize_developer_gate(gate: dict[str, Any]) -> dict[str, Any]:
        detail = str(gate.get("detail") or "")
        if "/" in detail or "\\" in detail:
            detail = "gate failed validation"
        return {
            "name": gate.get("name"),
            "passed": bool(gate.get("passed")),
            "detail": detail,
        }

    def sanitize_developer_submission_record(record: dict[str, Any], *, capability_view: bool = False) -> dict[str, Any]:
        submission_id = str(record.get("submission_id") or "")
        kind = str(record.get("kind") or "plugin")
        signed = bool(record.get("signed_package_path"))
        payload = {
            "schema_version": "0.1.0",
            "submission_id": submission_id,
            "kind": kind,
            "status": record.get("status"),
            "capability_status": record.get("capability_status"),
            "capability_id": record.get("capability_id") or record.get("plugin_id") or record.get("skill_id") or record.get("company_id"),
            "plugin_id": record.get("plugin_id"),
            "skill_id": record.get("skill_id"),
            "company_id": record.get("company_id"),
            "version": record.get("version"),
            "ready_for_signing": bool(record.get("ready_for_signing")),
            "ready_for_review": bool(record.get("ready_for_review")),
            "requested_acceptance_level": record.get("requested_acceptance_level"),
            "listing_review_level": record.get("listing_review_level"),
            "acceptance_recommendation": record.get("acceptance_recommendation"),
            "certified_allowed": bool(record.get("certified_allowed")),
            "l3_allowed": bool(record.get("l3_allowed")),
            "package_digest": record.get("package_digest"),
            "artifact_blob_digest": record.get("artifact_blob_digest"),
            "artifact_ref": record.get("artifact_ref"),
            "admin_decision": record.get("admin_decision"),
            "registry_status": record.get("registry_status"),
            "published": record.get("published"),
            "gates": [sanitize_developer_gate(gate) for gate in record.get("gates", [])],
            "signature_issued": signed,
            "signed_package_ref": developer_submission_signed_ref(submission_id) if signed else None,
            "signing_public_key": record.get("signing_public_key"),
            "out_of_scope": [
                "production_developer_upload_api",
                "real_artifact_upload",
                "production_signing",
                "marketplace_listing",
                "payment",
                "payout",
                "settlement",
                "entitlement_sync",
                "runtime_proxy_changes",
            ],
        }
        if capability_view and kind == "plugin" and record.get("capability_status"):
            payload["plugin_status"] = record.get("status")
            payload["status"] = record.get("capability_status")
        return {key: value for key, value in payload.items() if value is not None}

    def create_developer_submission_record(
        kind: Literal["plugin", "skill", "company"],
        request: DeveloperSubmissionCreateRequest,
        *,
        legacy_plugin_status: bool = False,
    ) -> dict[str, Any]:
        submission_id = _id(capability_submission_prefix(kind))
        capability_id = request.capability_id or (request.plugin_id if kind == "plugin" else None)
        record = {
            "schema_version": "0.1.0",
            "submission_id": submission_id,
            "kind": kind,
            "status": "created" if legacy_plugin_status else "draft",
            "developer_id": request.developer_id,
            "capability_id": capability_id,
            "plugin_id": capability_id if kind == "plugin" else None,
            "skill_id": capability_id if kind == "skill" else None,
            "company_id": capability_id if kind == "company" else None,
            "requested_acceptance_level": request.requested_acceptance_level,
            "artifact_uploaded": False,
            "out_of_scope": [
                "production_developer_upload_api",
                "real_artifact_upload",
                "production_signing",
                "marketplace_listing",
                "payment",
                "payout",
                "settlement",
                "entitlement_sync",
                "runtime_proxy_changes",
            ],
        }
        write_developer_submission_record(record)
        return {key: value for key, value in record.items() if value is not None}

    def create_capability_review_submission_record(request: CapabilityReviewSubmissionRequest) -> dict[str, Any]:
        if request.auto_approve:
            raise HTTPException(status_code=400, detail="capability review submissions cannot auto-approve")
        kind = request.kind
        capability_id = request.capability_id or getattr(request, f"{kind}_id") or (request.plugin_id if kind == "plugin" else None)
        capability_id = str(capability_id or "").strip()
        version = str(request.version or "").strip()
        artifact_ref = str(request.artifact_ref or "").strip()
        package_digest = str(request.package_digest or request.artifact_digest or "").strip()
        artifact_digest = str(request.artifact_digest or request.package_digest or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{1,160}", capability_id):
            raise HTTPException(status_code=400, detail="capability_id must be a safe identifier")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:+-]{0,80}", version):
            raise HTTPException(status_code=400, detail="version must be a safe identifier")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", package_digest):
            raise HTTPException(status_code=400, detail="package_digest must be sha256:<hex>")
        if artifact_digest and artifact_digest != package_digest:
            raise HTTPException(status_code=400, detail="artifact_digest and package_digest must match")
        if not artifact_ref.startswith("superclaw-object://capabilities/") or artifact_ref.startswith(("file://", "/", "~")) or "\\" in artifact_ref:
            raise HTTPException(status_code=400, detail="artifact_ref must be an opaque capability object-store reference")
        rendered_public_payload = json.dumps(
            {
                "capability_id": capability_id,
                "version": version,
                "artifact_ref": artifact_ref,
                "developer_ref": request.developer_ref,
            },
            sort_keys=True,
            default=str,
        ).lower()
        if any(marker in rendered_public_payload for marker in ("private_key", "password=", "bearer ", "sk-", "ghp_", "/users/", "/tmp/")):
            raise HTTPException(status_code=400, detail="review submission contains private or secret-like material")

        submission_id = _id(capability_submission_prefix(kind))
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        record = {
            "schema_version": "superclaw.capability_review_status.v1",
            "source_schema_version": request.schema_version,
            "submission_id": submission_id,
            "kind": kind,
            "status": "pending_review",
            "capability_status": "pending_review",
            "review_status": "pending_review",
            "developer_ref": request.developer_ref,
            "capability_id": capability_id,
            "plugin_id": capability_id if kind == "plugin" else None,
            "skill_id": capability_id if kind == "skill" else None,
            "company_id": capability_id if kind == "company" else None,
            "version": version,
            "name": request.name,
            "summary": request.summary,
            "artifact_uploaded": True,
            "artifact_ref": artifact_ref,
            "artifact_filename": request.artifact_filename,
            "package_format": request.package_format,
            "artifact_blob_digest": package_digest,
            "package_digest": package_digest,
            "ready_for_review": True,
            "metadata_review_only": True,
            "created_at": now,
            "out_of_scope": [
                "auto_approval",
                "production_signing",
                "marketplace_listing",
                "payment",
                "payout",
                "settlement",
            ],
        }
        write_developer_submission_record(record)
        payload = sanitize_developer_submission_record(record, capability_view=True)
        return {"ok": True, **payload}

    def upload_developer_submission_artifact(
        submission_id: str,
        request: DeveloperSubmissionArtifactRequest,
        *,
        expected_kind: Literal["plugin", "skill", "company"] | None = None,
        capability_view: bool = False,
    ) -> dict[str, Any]:
        record_path = developer_submission_record_path(submission_id)
        if not record_path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        existing = json.loads(record_path.read_text(encoding="utf-8"))
        kind = str(existing.get("kind") or expected_kind or "plugin")
        if expected_kind is not None and kind != expected_kind:
            raise HTTPException(status_code=404, detail="developer submission not found")
        if request.signing_private_key:
            raise HTTPException(
                status_code=400,
                detail="submit must not carry a signing key; signing is a separate post-review step",
            )
        try:
            result = submit_developer_capability_upload(
                kind,
                Path(request.package_path),
                submission_root=developer_submission_root() / "reviews",
                smoke_timeout_seconds=request.smoke_timeout_seconds,
                submission_id=submission_id,
            )
        except (DeveloperCapabilitySubmissionError, DeveloperUploadReviewError, OSError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=sanitize_developer_submission_error(exc)) from exc
        record = sanitize_developer_submission_record(result.record, capability_view=capability_view)
        record["artifact_uploaded"] = True
        write_developer_submission_record(record)
        return record

    def list_developer_capability_submissions() -> list[dict[str, Any]]:
        jobs_dir = developer_submission_root() / "jobs"
        if not jobs_dir.exists():
            return []
        records: list[dict[str, Any]] = []
        for path in sorted(jobs_dir.glob("*.json")):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if str(record.get("kind") or "plugin") in {"plugin", "skill", "company"}:
                records.append(sanitize_developer_submission_record(record, capability_view=True))
        return records

    def admin_capability_submission_payload(submission_id: str) -> dict[str, Any]:
        path = developer_submission_record_path(submission_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        record = json.loads(path.read_text(encoding="utf-8"))
        return sanitize_developer_submission_record(record, capability_view=True)

    def admin_publish_capability_submission(
        submission_id: str,
        request: AdminCapabilityReviewRequest,
    ) -> dict[str, Any]:
        if not developer_submission_record_path(submission_id).exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        try:
            result = publish_capability_distribution(
                submission_id,
                submission_root=developer_submission_root() / "reviews",
                cloud_root=cloud_root(),
                decision=request.decision,
                actor_ref=request.actor_ref,
                artifact_ref=request.artifact_ref,
                signing_authority_ref=request.signing_authority_ref,
                entitlement_ref=request.entitlement_ref,
                replacement_for_digest=request.replacement_for_digest,
            )
        except (DeveloperCapabilitySubmissionError, CapabilityRegistryError, OSError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=sanitize_developer_submission_error(exc)) from exc

        status_path = developer_submission_record_path(submission_id)
        job_record = json.loads(status_path.read_text(encoding="utf-8"))
        public_decision = sanitize_capability_distribution_payload(result.record)
        job_record.update(
            {
                "admin_decision": result.decision,
                "registry_status": public_decision.get("registry_status"),
                "artifact_ref": result.artifact_ref,
                "artifact_blob_digest": result.artifact_blob_digest,
                "published": result.decision in {"publish", "sign", "replace"},
            }
        )
        write_developer_submission_record(job_record)
        clear_catalog_cache()
        return {
            "ok": True,
            "submission": sanitize_developer_submission_record(job_record, capability_view=True),
            "decision": public_decision,
            "registry": {
                "status": public_decision.get("registry_status"),
                "sync_url": "/api/admin/capabilities/registry/sync",
            },
            "download": {
                "url": (
                    f"/api/admin/capabilities/{result.kind}/{result.capability_id}"
                    f"/versions/{result.version}/download"
                ),
                "artifact_ref": result.artifact_ref,
                "artifact_blob_digest": result.artifact_blob_digest,
            },
        }

    def backend_inventory() -> list[dict[str, Any]]:
        return build_agent_inventory(backends=default_backends(), config_payload=runtime_config_payload())

    def clawhunt_auth_payload() -> dict[str, Any]:
        hydrate_clawhunt_auth_environment()
        client = ClawHuntClient()
        summary = clawhunt_auth_summary()
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

    def save_clawhunt_account_session(*, access_token: str, user: dict[str, Any], account_source: str) -> None:
        save_clawhunt_auth(
            {
                "access_token": access_token,
                "account_user": user,
                "account_source": account_source,
                "login_source": SUPERCLAW_LOGIN_SOURCE,
                "browser_login_state": None,
                "browser_login_state_expires_at": None,
                "browser_login_provider": None,
            }
        )

    def html_auth_callback(title: str, detail: str, *, status_code: int = 200) -> HTMLResponse:
        safe_title = str(title).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        safe_detail = str(detail).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return HTMLResponse(
            f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{safe_title}</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:40px;line-height:1.5;">
    <h1>{safe_title}</h1>
    <p>{safe_detail}</p>
  </body>
</html>""",
            status_code=status_code,
        )

    # Browse-response parsing is the SINGLE shared kernel source (superclaw.clawhunt)
    # so the dock and the governed marketplace handler count "how many orders"
    # identically — never two hand-rolled walks that can drift (one such drift
    # under-counted the nested `data` envelope to 0).
    def clawhunt_problem_payload(body: Any) -> dict[str, Any] | None:
        return _clawhunt_extract_problem_payload(body)

    def clawhunt_problem_items(body: Any) -> list[dict[str, Any]]:
        return _clawhunt_extract_problem_items(body)

    def clawhunt_problem_has_more(body: Any, item_count: int, limit: int) -> bool:
        return _clawhunt_browse_has_more(body, item_count, limit)

    def clawhunt_task_summary(payload: dict[str, Any]) -> dict[str, Any]:
        owner = payload.get("owner") or payload.get("creator") or payload.get("poster")
        if isinstance(owner, dict):
            owner_label = owner.get("handle") or owner.get("name") or owner.get("id")
        else:
            owner_label = owner
        tags = payload.get("tags")
        return {
            "id": payload.get("id") or payload.get("problem_id"),
            "title": payload.get("title") or payload.get("name") or "Untitled ClawHunt task",
            "summary": payload.get("summary") or payload.get("description") or payload.get("brief") or "",
            "status": payload.get("status") or payload.get("state") or payload.get("stage") or "unknown",
            "category": payload.get("category"),
            "difficulty": payload.get("difficulty"),
            "bounty": payload.get("bounty"),
            "price": payload.get("price"),
            "owner": owner_label,
            "url": payload.get("url"),
            "tags": tags if isinstance(tags, list) else [],
        }

    def plugin_status_payload() -> dict[str, Any]:
        return build_plugin_status_payload(
            cache_root=plugin_cache_root(),
            cloud_root=cloud_root(),
            developer_submission_root=developer_submission_root(),
            clawhunt_ingestion_root=clawhunt_ingestion_root(),
        )

    def safe_plugin_cache_segment(value: str) -> str:
        candidate = value.strip()
        path_candidate = Path(candidate)
        if (
            candidate != value
            or not candidate
            or candidate in {".", ".."}
            or "/" in candidate
            or "\\" in candidate
            or path_candidate.is_absolute()
            or path_candidate.drive
            or path_candidate.root
        ):
            raise HTTPException(status_code=404, detail="plugin not installed")
        return candidate

    def cached_plugin_manifest(plugin_id: str, version: str | None = None) -> tuple[dict[str, Any], str]:
        cache_root = plugin_cache_root().resolve()
        safe_plugin_id = safe_plugin_cache_segment(plugin_id)
        plugin_root = (cache_root / safe_plugin_id).resolve()
        if not _path_is_within(plugin_root, cache_root):
            raise HTTPException(status_code=404, detail="plugin not installed")
        if version:
            safe_version = safe_plugin_cache_segment(version)
            manifest_path = (plugin_root / safe_version / MANIFEST_NAME).resolve()
            if not _path_is_within(manifest_path, plugin_root):
                raise HTTPException(status_code=404, detail="plugin not installed")
            if not manifest_path.exists():
                raise HTTPException(status_code=404, detail="plugin not installed")
            return json.loads(manifest_path.read_text(encoding="utf-8")), safe_version
        versions = sorted(plugin_root.glob(f"*/{MANIFEST_NAME}"))
        if not versions:
            raise HTTPException(status_code=404, detail="plugin not installed")
        manifest_path = versions[-1].resolve()
        if not _path_is_within(manifest_path, plugin_root):
            raise HTTPException(status_code=404, detail="plugin not installed")
        resolved_version = manifest_path.parent.name
        return json.loads(manifest_path.read_text(encoding="utf-8")), resolved_version

    def cached_plugin_root(plugin_id: str, version: str | None = None) -> tuple[Path, dict[str, Any], str]:
        manifest, resolved_version = cached_plugin_manifest(plugin_id, version=version)
        cache_root = plugin_cache_root().resolve()
        safe_plugin_id = safe_plugin_cache_segment(plugin_id)
        safe_version = safe_plugin_cache_segment(resolved_version)
        plugin_root = (cache_root / safe_plugin_id / safe_version).resolve()
        if not _path_is_within(plugin_root, cache_root) or not plugin_root.exists():
            raise HTTPException(status_code=404, detail="plugin not installed")
        return plugin_root, manifest, resolved_version

    def resolve_cached_plugin_logo(plugin_id: str, version: str | None = None) -> tuple[Path, str]:
        plugin_root, manifest, _resolved_version = cached_plugin_root(plugin_id, version=version)
        logo = manifest.get("logo")
        if not isinstance(logo, str) or not logo.strip():
            raise HTTPException(status_code=404, detail="plugin logo not configured")
        logo_path = (plugin_root / logo.strip()).resolve()
        if not _path_is_within(logo_path, plugin_root) or not logo_path.is_file():
            raise HTTPException(status_code=404, detail="plugin logo not found")
        if logo_path.stat().st_size > PLUGIN_LOGO_MAX_BYTES:
            raise HTTPException(status_code=413, detail="plugin logo too large")
        mime = mimetypes.guess_type(logo_path.name)[0] or "application/octet-stream"
        if mime not in PLUGIN_LOGO_MIME_TYPES:
            raise HTTPException(status_code=415, detail="plugin logo type unsupported")
        return logo_path, mime

    def runtime_status_payload() -> dict[str, Any]:
        context = store.context_usage()
        runs = store.list_runs()
        # Single source of truth (liveness.ACTIVE_RUN_STATUSES) — keeps this in
        # lockstep with the CLI's `superclaw status` active-run set; a human-gated
        # run stays counted instead of vanishing from the runtime status surface.
        active_runs = [run.run_id for run in runs if run.status in ACTIVE_RUN_STATUSES]
        backends = backend_inventory()
        plugins = plugin_status_payload()
        # Node coexistence readiness for the web startup gate. The supervisor (when one
        # was co-launched) lives in THIS process, so node_runtime exposes its state via a
        # process-singleton — no app.state threading. Absent ⇒ enabled=False (no Node to
        # wait for). Local import keeps the API↔runtime edge lazy.
        from superclaw.node_runtime import node_runtime_status_snapshot

        return build_runtime_status_payload(
            runtime_version=app.version,
            repo=Path(".").resolve(),
            state_path=Path(state_path),
            artifact_dir=default_artifact_dir().resolve(),
            backend=configured_shell_backend() or "claude",
            mode=configured_shell_mode() or "auto",
            started_at=float(app.state.started_at),
            control_token_required=bool(current_control_token()),
            clawhunt_agent_api_key_configured=bool(os.environ.get("CLAWHUNT_AGENT_API_KEY")),
            context=context,
            active_run_ids=active_runs,
            recent_run_id=runs[0].run_id if runs else None,
            config_path=shell_config_path(),
            agents=backends,
            plugins=plugins,
            service_pid=os.getpid(),
            service_bind=os.environ.get("SUPERCLAW_SERVICE_BIND") or "127.0.0.1",
            service_control_token="set" if current_control_token() else "unset",
            node=node_runtime_status_snapshot(),
        )

    def write_developer_submission_record(record: dict[str, Any]) -> None:
        path = developer_submission_record_path(str(record["submission_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def require_webhook_signature(request: Request, raw_body: bytes) -> None:
        secret = os.environ.get("SUPERCLAW_WEBHOOK_SECRET")
        if not secret:
            return
        signature = (
            request.headers.get("x-cph-webhook-signature")
            or request.headers.get("x-cph-probe-signature")
            or ""
        )
        timestamp = (
            request.headers.get("x-cph-webhook-timestamp")
            or request.headers.get("x-cph-probe-timestamp")
            or ""
        )
        if not signature.startswith("sha256=") or not timestamp:
            raise HTTPException(status_code=401, detail="Missing ClawHunt webhook signature")
        try:
            ts = int(timestamp)
        except ValueError:
            raise HTTPException(status_code=401, detail="Invalid ClawHunt webhook timestamp") from None
        if abs(time.time() - ts) > 300:
            raise HTTPException(status_code=401, detail="Expired ClawHunt webhook signature")
        digest = hmac.new(
            secret.encode("utf-8"),
            msg=timestamp.encode("utf-8") + b"." + raw_body,
            digestmod=hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(f"sha256={digest}", signature):
            raise HTTPException(status_code=401, detail="Invalid ClawHunt webhook signature")

    def run_and_maybe_submit(goal: GoalSpec, session, problem_id: int | None) -> None:
        try:
            result = orchestrator.execute_existing_session(
                goal,
                session,
                dry_run=False,
                backend_policy=os.environ.get("SUPERCLAW_WEBHOOK_BACKEND", "claude"),
                repo_path=os.environ.get("SUPERCLAW_WEBHOOK_REPO_PATH", "."),
                concurrency=1,
                budget_seconds=int(os.environ.get("SUPERCLAW_WEBHOOK_BUDGET_SECONDS", "60")),
                artifact_dir=os.environ.get("SUPERCLAW_WEBHOOK_ARTIFACT_DIR", "/tmp/superclaw-artifacts"),
                verification_policy="adversarial",
                harness_policy=os.environ.get("SUPERCLAW_WEBHOOK_HARNESS", "codex"),
            )
            # Webhook auto-submit is an UNGOVERNED write path (no marketplace order
            # ledger, no human approval, no completion/verdict gate). It is
            # DISABLED by default (advisor阻断项 6, Codex): a completed run no longer
            # auto-sends just because CLAWHUNT_AGENT_API_KEY is present. The governed
            # path is `superclaw marketplace submit <order_id>`. A deliberate
            # operator override remains via SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1.
            auto_submit_ok = (
                problem_id
                and result.session.status == "completed"
                and os.environ.get("CLAWHUNT_AGENT_API_KEY")
                and os.environ.get("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE") == "1"
            )
            if (
                problem_id
                and result.session.status == "completed"
                and os.environ.get("CLAWHUNT_AGENT_API_KEY")
                and not auto_submit_ok
            ):
                # Would have auto-submitted under the old behaviour — record that it
                # was withheld so the operator knows to use the governed path.
                store.add_event(
                    result.session.run_id,
                    "clawhunt.auto_submit_disabled",
                    {
                        "problem_id": problem_id,
                        "reason": "ungoverned webhook auto-submit disabled; use "
                        "`superclaw marketplace submit` or set "
                        "SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1",
                    },
                )
            if auto_submit_ok:
                submission = build_clawhunt_submission_payload(
                    solution_text=default_solution_text(result.session.run_id),
                    evidence=result.evidence,
                    attachments=[f"superclaw-run:{result.session.run_id}"],
                )
                response = ClawHuntClient().submit_solution(problem_id, submission)
                if response.get("ok"):
                    result.evidence.mark_submitted(response)
                else:
                    result.evidence.add_finding(
                        "clawhunt_submission",
                        False,
                        f"submit failed with status {response.get('status_code')}",
                        "high",
                    )
                store.save_evidence(result.evidence)
                store.add_event(result.session.run_id, "clawhunt.submission", response)
        except Exception as exc:  # pragma: no cover - background safety
            try:
                store.add_event(session.run_id, "run.failed", {"detail": f"{type(exc).__name__}: {str(exc)[:300]}"})
            except Exception:
                pass

    def run_eval_background(eval_id: str, request: EvalRunRequest) -> None:
        try:
            eval_runner.run_delivery_gap(
                agent=request.agent,
                case_id=request.case_id,
                output=eval_runner.root / eval_id,
                timeout_seconds=request.timeout_seconds,
                eval_id=eval_id,
            )
        except Exception as exc:  # pragma: no cover - defensive background eval safety
            eval_dir = eval_runner.root / eval_id
            eval_dir.mkdir(parents=True, exist_ok=True)
            (eval_dir / "report.json").write_text(
                json.dumps(
                    {
                        "eval_id": eval_id,
                        "case_id": request.case_id,
                        "status": "failed",
                        "verdict": "FAIL",
                        "agents": [],
                        "score_summary": {"max_score": 0, "average_score": 0, "agents": {}},
                        "artifacts": [],
                        "error": f"{type(exc).__name__}: {str(exc)[:400]}",
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "superclaw"}

    @app.get("/.well-known/agent-card.json")
    def agent_card() -> dict[str, Any]:
        return _agent_card()

    @app.get("/api/backends")
    def backends(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"backends": backend_inventory()}

    @app.get("/api/agents")
    def agents(_: None = Depends(require_control_token)) -> dict[str, Any]:
        items = backend_inventory()
        return {
            "agents": items,
            "summary": build_agent_summary(items),
        }

    @app.get("/api/agents/probe")
    def agents_probe(backend: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Deep runtime reachability probe — actively verify which runtimes are
        usable right now (an authenticated model-list round-trip, tool-free and
        spend-free). Read-only projection of the kernel ``runtime_probe``; the CLI
        ``superclaw doctor --deep`` is the same mechanism, so CLI/API/Web agree.

        ``?backend=<name>`` probes one runtime (404 if unknown); omitted probes all.
        Each result is a three-state verdict (runtime_ready / runtime_present /
        runtime_fail) the surface renders verbatim — it must NOT re-derive it. This
        is an on-demand "test" action (it makes live calls), never run on page load."""
        from superclaw.runtime_probe import probe_backend, probe_runtimes

        backends = default_backends()
        if backend is not None:
            if backend not in backends:
                raise HTTPException(status_code=404, detail=f"unknown backend {backend!r}")
            results = [probe_backend(backend, backends=backends)]
        else:
            results = probe_runtimes(backends=backends)
        return {"probes": [result.to_dict() for result in results]}

    @app.get("/api/agents/{backend_name}/models")
    def agent_models(
        backend_name: str, refresh: int = 0, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """The REAL model catalog for one backend — live from the runtime when it
        exposes a listing channel, otherwise the static contract hints with an
        honest ``source`` marker. Probed on demand (selector dropdown open), not
        inside the inventory, so /api/agents stays fast. Results are cached in
        the kernel (60s live / 10s failed); ``?refresh=1`` forces a re-probe."""
        from superclaw.model_discovery import discover_models

        catalog = discover_models(backend_name, backends=default_backends(), force_refresh=bool(refresh))
        payload = catalog.to_dict()
        if payload.get("error"):
            payload["error"] = redact_secrets(str(payload["error"]))
        return payload

    @app.get("/api/relay/packages")
    def relay_packages_endpoint(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The SuperClaw packages (套餐) the relay's super groups expose — the
        post-login tier abstraction (core/plus/max…) instead of the relay's raw
        model ids. Single source with the CLI ``superclaw relay packages``: both
        call the kernel ``relay_packages()`` (catalog → groups → defaults, all
        fail-safe). ``available`` is True only when logged in with a usable relay
        key; otherwise the default tier floor is returned for preview.

        档位解锁（issue #452）：附 ``tier_ceiling``（账号解锁上限，None=未登录）+ 给每个套餐打
        ``locked``（越级标记）。**越级裁决留在内核**（``is_tier_locked`` 纯比较，前端不得自造
        tier 序——CLI 唯一事实源 + 铁律第 6 条），前端零计算地灰显/禁选越级档并引导升级。
        ``locked`` 与 backends run 的硬 clamp 同源，故 Web/CLI/run 零偏差。"""
        from superclaw.relay_key import cached_or_refresh_tier_ceiling, is_tier_locked
        from superclaw.relay_packages import relay_packages

        hydrate_clawhunt_auth_environment()
        payload = relay_packages()
        # ceiling：已登录但从未缓存上限时刷新一次（覆盖刚登录——save 清旧 ceiling——的 plus/max
        # 用户，否则套餐会被 cached-only 误标 locked，Codex 复审阻断项 #1），之后纯缓存零网络；
        # 逐个标 locked 用 is_tier_locked 纯比较（不再各刷一次 /me）。
        ceiling = cached_or_refresh_tier_ceiling()
        payload["tier_ceiling"] = ceiling
        for package in payload.get("packages", []):
            if isinstance(package, dict):
                package["locked"] = is_tier_locked(package.get("id"), ceiling)
        return payload

    def _relay_key_error_payload(exc: Exception) -> dict[str, Any]:
        """Shape a kernel RelayKeyError into a fail-soft surface payload.

        The kernel raises actionable, prefixed errors (``RELAY_LOGIN_REQUIRED: …``,
        ``RELAY_BALANCE_UNREACHABLE: …``). Mirroring ``/api/relay/packages`` we never
        let "not logged in / relay unreachable" surface as a 500 — it is an expected
        pre-login state. We return HTTP 200 with ``ok=false`` plus a machine-readable
        ``code`` (the prefix) so the Web surface can distinguish "login required"
        from a transient outage and render guidance instead of a hard error. The
        message is already masked by the kernel (never echoes the plaintext key)."""
        message = str(exc)
        code = message.split(":", 1)[0].strip() if ":" in message else "RELAY_ERROR"
        return {"ok": False, "code": code, "error": message}

    @app.get("/api/relay/status")
    def relay_status_endpoint(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The clawwork relay-key chain state (always masked, never plaintext).

        Single source with the CLI ``superclaw relay status``: both call the kernel
        ``relay_status()``. Wrapped in ``ok=true`` for a uniform surface envelope."""
        from superclaw.relay_key import relay_status

        hydrate_clawhunt_auth_environment()
        return {"ok": True, **relay_status()}

    @app.get("/api/relay/balance")
    def relay_balance_endpoint(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The relay account balance via LLMgate ``/v1/user/balance``.

        Single source with the CLI ``superclaw relay balance``: both call the kernel
        ``relay_balance()`` over the resolved relay key (same chain as the rest of
        clawwork, so it is always the logged-in account's key). The kernel returns a
        masked summary (balance + currency + active flag + key prefix), never the
        plaintext key. Not-logged-in / unreachable degrades to ``ok=false`` (see
        ``_relay_key_error_payload``) rather than erroring, matching the packages
        endpoint's fail-soft contract."""
        from superclaw.relay_key import RelayKeyError, ensure_relay_key, relay_balance, resolve_relay_api_key

        hydrate_clawhunt_auth_environment()
        # Self-heal: a ClawHunt account can be logged in (access_token saved) without a
        # relay key ever having been exchanged, which left balance/usage stuck at
        # "unknown". Provision on demand ONLY when no key is already resolvable — this
        # avoids ensure_relay_key()'s provision lock (+ a redundant exchange) on the
        # common cached path, and the wasted attempt when not logged in. The real
        # not-logged-in / bridge-down state still surfaces via relay_balance() ->
        # RelayKeyError -> fail-soft payload below.
        try:
            existing, _ = resolve_relay_api_key()
            if not existing:
                ensure_relay_key()
        except RelayKeyError as exc:
            _LOGGER.debug("relay self-heal skipped: %s", getattr(exc, "code", exc))
        except Exception:
            _LOGGER.debug("relay self-heal failed", exc_info=True)
        try:
            return {"ok": True, **relay_balance()}
        except RelayKeyError as exc:
            return _relay_key_error_payload(exc)

    @app.get("/api/relay/usage")
    def relay_usage_endpoint(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """This relay key's consumption + quota via LLMgate ``/v1/user/usage``.

        Single source with the CLI ``superclaw relay usage``: both call the kernel
        ``relay_usage()`` over the resolved relay key. The kernel returns a masked
        summary (this key's credits used + quota limit [0 = unlimited] + account
        balance + active flag + key prefix), never the plaintext key; missing/dirty
        numeric fields degrade to ``None`` (surface renders "unknown"). Not-logged-in
        / unreachable degrades to ``ok=false`` rather than erroring, matching the
        packages endpoint's fail-soft contract."""
        from superclaw.relay_key import RelayKeyError, ensure_relay_key, relay_usage, resolve_relay_api_key

        hydrate_clawhunt_auth_environment()
        # Self-heal the relay key on demand (see /api/relay/balance for rationale):
        # provision only when none is resolvable, so the cached path skips the lock and
        # the not-logged-in path doesn't do a wasted exchange; never breaks the read.
        try:
            existing, _ = resolve_relay_api_key()
            if not existing:
                ensure_relay_key()
        except RelayKeyError as exc:
            _LOGGER.debug("relay self-heal skipped: %s", getattr(exc, "code", exc))
        except Exception:
            _LOGGER.debug("relay self-heal failed", exc_info=True)
        try:
            return {"ok": True, **relay_usage()}
        except RelayKeyError as exc:
            return _relay_key_error_payload(exc)

    @app.get("/api/relay/packages/{tier}/models")
    def relay_package_models_endpoint(
        tier: str, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Models inside one package tier (core/plus/max) — the clawwork composer's
        second-level model picker (first level = package, second = a model in it).

        Single source with the CLI ``superclaw relay package-models <tier>``: both call
        the kernel ``relay_package_models(tier)``, which binds the relay key to the tier
        (reusing the per-(account,tier) cache) and queries LLMgate ``/v1/models`` — that
        endpoint narrows to the key's group, so the result is the ``superclaw-{tier}``
        group's models. Fail-soft to ``ok=false`` (never the plaintext key), matching
        the packages/usage endpoints; an invalid tier or not-logged-in degrades rather
        than erroring."""
        from superclaw.relay_key import RelayKeyError, relay_package_models

        hydrate_clawhunt_auth_environment()
        try:
            return relay_package_models(tier)
        except RelayKeyError as exc:
            return _relay_key_error_payload(exc)

    @app.get("/api/relay/account")
    def relay_account_endpoint(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """Normalized account info for the settings panel: purchased package vs
        effective entitlement vs self-funded relay usage, kept as distinct sources.

        Single source with the CLI ``superclaw relay account``: both call the kernel
        ``account_overview()``, which aggregates ``superclaw_plan`` (billing_plan from
        ClawHunt /me), the effective entitlement + source (ClawHunt
        /api/agent-chat/usage: unlimited/free/credits — same source as the web
        "Pro · unlimited" badge), and the LLMgate relay usage. All sub-queries are
        best-effort, so an admin/unsubscribed account (billing_plan null but
        unlimited) renders honestly without conflating the bypass with a purchase.
        Never returns the plaintext token/key (each sub-query masks)."""
        from superclaw.relay_key import account_overview

        hydrate_clawhunt_auth_environment()
        return account_overview()

    def _governance_approvals_path() -> Path:
        # Lives next to the state db so it shares the workspace lifecycle. This is
        # the human-gate INBOX: the ClawWork governance extension (and any other
        # surface) files a pending approval here when it blocks a pay/scan intent.
        return Path(state_path).resolve().parent / "governance-approvals.json"

    def _load_governance_approvals() -> list[dict[str, Any]]:
        path = _governance_approvals_path()
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        return data if isinstance(data, list) else []

    @app.post("/api/governance/approvals")
    def file_governance_approval(request: GovernanceApprovalRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Human-gate inbox: a governed runtime that BLOCKED a pay/scan intent
        files the approval request here so it surfaces in SuperClaw. The block has
        already taken effect on the runtime side — this only routes the request to
        a human; it never grants execution."""
        approvals = _load_governance_approvals()
        record = {
            "approval_id": _id("gov_approval"),
            "status": "pending",
            "source": request.source,
            "run_id": request.run_id,
            "intent": request.intent,
            "tool": request.tool,
            "detail": redact_secrets(str(request.command or ""))[:2000],
            "filed_at": time.time(),
        }
        approvals.append(record)
        path = _governance_approvals_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(approvals[-500:], ensure_ascii=False), encoding="utf-8")
        return {"ok": True, "approval_id": record["approval_id"], "status": "pending"}

    @app.get("/api/governance/approvals")
    def list_governance_approvals(_: None = Depends(require_control_token)) -> dict[str, Any]:
        approvals = _load_governance_approvals()
        pending = [a for a in approvals if a.get("status") == "pending"]
        return {"approvals": approvals[-100:], "pending_count": len(pending), "status_url": "/api/governance/approvals"}

    # --- Escalations: the fail-closed approval queue for B-class tool actions ---
    # (Direction 4 P1 D2). A THIN transport over the SAME StateStore the
    # ``superclaw escalation`` CLI drives — zero parallel implementation, zero new
    # authorization. The durable store (and the CLI/REST snapshot over it) is the
    # authority. The per-run SSE channel (/api/runs/{run_id}/events) carries
    # escalation.requested when a run suspends, but it CLOSES once the run is
    # WAITING_FOR_HUMAN_GATE — so a surface discovers pending items by polling this
    # queue (triggered by that event) and closes its prompt from the respond RESULT.
    # escalation.resolved is a DURABLE lifecycle event (cockpit timeline / snapshot /
    # audit), not a live-delivery channel.
    def _operator_principal() -> str:
        """The single server-side operator identity a REST responder acts as. Read
        from the instance config, NEVER from the request body — a network caller must
        not be able to assert an arbitrary principal (that would defeat the kernel's
        principal binding: the bound principal is shown in the queue, so a body-chosen
        principal could just be replayed). Defaults to the bootstrapped local admin."""
        return (os.environ.get("SUPERCLAW_OPERATOR_PRINCIPAL") or "local_user").strip() or "local_user"

    @app.get("/api/escalations")
    def list_escalations_api(
        status: str = "pending",
        run: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """The approval queue. Defaults to ``pending`` to match the CLI
        (``superclaw escalation list``) EXACTLY — same default scope, no wider default
        visibility; pass ``status=all`` for the full history. Filtering is by EFFECTIVE
        status (an overdue record reads ``expired`` even before housekeeping persists
        it). ``pending_count`` is always over the full (run-scoped) set for a surface
        badge, independent of the status filter."""
        all_summaries = [escalation_summary(env) for env in store.list_escalations(run_id=run)]
        pending_count = sum(1 for s in all_summaries if s["status"] == "pending")
        normalized = None if status in {"all", "*"} else status
        visible = (
            all_summaries
            if normalized is None
            else [s for s in all_summaries if s["status"] == normalized]
        )
        return {"escalations": visible, "pending_count": pending_count}

    @app.get("/api/escalations/{request_id}")
    def get_escalation_api(
        request_id: str, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """One escalation in full (no HMAC material on the wire) plus a derived
        ``signature_valid`` so a surface can show the binding is untampered."""
        try:
            env = store.get_escalation(request_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown escalation") from exc
        payload = escalation_summary(env)
        payload["signature_valid"] = verify_envelope(env)
        return payload

    @app.post("/api/escalations/{request_id}/respond")
    def respond_escalation_api(
        request_id: str,
        request: EscalationRespondRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Apply a human decision to a PENDING escalation. Fail-closed, ZERO new
        authorization: delegates to the SAME ``store.resolve_escalation`` the CLI
        uses (which also emits the durable escalation.resolved lifecycle event), so
        REST and CLI behave identically. The responder principal is derived
        server-side (``_operator_principal``), NEVER taken from the client, so a
        caller can only act as this instance's operator and cannot impersonate the
        bound principal. The kernel refuses a tampered/expired record, a principal
        mismatch, a non-pending status or an unknown option (all fail-closed, no state
        mutation). A ``grants`` option mints a single-use grant the suspended run
        consumes on resume; any other option is a sticky DENY."""
        responder = _operator_principal()
        try:
            env = store.resolve_escalation(
                request_id,
                decision_option_id=request.decision,
                approver=responder,
                principal=responder,
                last_action_id=request.note,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown escalation") from exc
        except EscalationError as exc:
            # Fail-closed: a tampered/expired record, principal mismatch, non-pending
            # status or unknown option could not be applied. The kernel message says
            # which; the action is REFUSED with no state mutation.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return escalation_summary(env)

    @app.get("/api/harnesses")
    def harnesses() -> dict[str, Any]:
        return {"harnesses": harness_matrix(), "runtime_profile": runtime_profile()}

    @app.get("/api/capabilities")
    def capabilities(
        q: str = "",
        category: str = "",
        origin: str = "",
        availability: str = "",
        integration: str = "",
    ) -> dict[str, Any]:
        problems = validate_facets(
            category=category or None,
            origin=origin or None,
            availability=availability or None,
            integration=integration or None,
        )
        if problems:
            raise HTTPException(status_code=422, detail="; ".join(problems))
        units = search_capabilities(
            q,
            category=category or None,
            origin=origin or None,
            availability=availability or None,
            integration=integration or None,
        )
        return {
            "summary": atlas_summary(),
            "total": len(units),
            "capabilities": [unit.to_dict() for unit in units],
        }

    @app.get("/api/capabilities/coverage")
    def capabilities_coverage() -> dict[str, Any]:
        return coverage_report()

    @app.get("/api/capabilities/suggest")
    def capabilities_suggest(goal: str, limit: int = 8) -> dict[str, Any]:
        return {"goal": goal, "suggestions": suggest_capabilities(goal, limit=limit)}

    @app.post("/api/capabilities/install")
    def capability_install(
        request: CapabilityInstallRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Download a published capability and land it via the co-launched Node S4 super-workshop.

        Neutral surface mirroring the CLI ``capabilities workshop install`` (same kernel bridge
        ``install_published_capability``): the bridge resolves the loopback Node base URL, the
        baked official co-signature key, the 0600 receipt key file, and the app env — only the
        identity is supplied here. Returns the kernel envelope verbatim. Every fail-closed
        pipeline outcome (not published / not officially co-signed / unresolvable artifact /
        download or digest/identity mismatch / no co-launched Node / receipt key not provisioned
        / Node import rejected) surfaces as 502 with a generic reason (no internals leaked);
        malformed requests are 422 (kind/identity validation).
        """
        from superclaw.capability_workshop_install_bridge import (
            WorkshopInstallBridgeError,
            install_published_capability,
        )

        try:
            return install_published_capability(request.kind, request.capability_id, request.version)
        except WorkshopInstallBridgeError as exc:
            # The bridge's message can carry internal context (key-file path, R2 errors, a Node
            # response snippet). Keep it server-side; the network response stays generic.
            _LOGGER.warning(
                "capability install failed: kind=%s id=%s version=%s: %s",
                request.kind,
                request.capability_id,
                request.version,
                exc,
            )
            raise HTTPException(status_code=502, detail="workshop install failed") from exc

    @app.get("/api/capabilities/distribution")
    def capability_distribution(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """Published workshop capabilities of ALL kinds (plugin/skill/company) installable via
        the Node S4 path — the neutral, all-kinds mirror of ``/api/plugins/workshop-distribution``
        that the web reads to know which cards offer a real install. A capability is installable
        iff R2 is configured AND its live feed entry is officially co-signed AND its artifact
        bytes are ACTUALLY present in R2 (a published-but-never-uploaded ghost is discovery-only).

        The listed kind is ALWAYS the entry's signed raw ``kind`` (the official co-signature
        covers ``kind``, and the install bridge matches the feed entry on the exact kind), so we
        never re-label. A skill-origin entry mislabeled ``kind:'plugin'`` (a ``skill.*`` id or
        ``skill_origin`` flag) is DROPPED entirely — it is not installable as a plugin (the guard
        refuses) nor as a skill (no signed skill identity), so advertising it would dead-end at
        install. It re-appears only once upstream re-publishes it with the correct kind + signs.
        The declared kind is also bound to the artifact location (``capabilities/<kind>/``). The
        real admission still happens at install time in the kernel bridge (cosign + digest +
        identity re-checked), so this list is only an install hint.

        NB: registered BEFORE ``/api/capabilities/{capability_id}`` so the literal path is not
        shadowed by the path-parameter route.
        """
        try:
            r2_config = load_r2_config()
        except CapabilityR2Error:
            r2_config = None
        r2_ready = r2_config is not None
        capabilities: list[dict[str, str]] = []
        error: str | None = None
        if r2_ready and r2_config is not None:
            try:
                official_key = official_root_public_key()
                artifact_bucket = _r2_artifact_bucket()
                # One round-trip for the whole capability keyspace; membership is a local lookup.
                present_keys = set(list_r2_object_keys(artifact_bucket, "capabilities/", config=r2_config))
                for entry in _fetch_workshop_entries():
                    cid = entry.get("capability_id") or entry.get("plugin_id")
                    ver = entry.get("version")
                    if not (isinstance(cid, str) and cid and isinstance(ver, str) and ver):
                        continue
                    kind = entry.get("kind") or "plugin"
                    if kind not in ("plugin", "skill", "company"):
                        continue  # unknown kind — never advertise
                    # Drop skill-origin entries mislabeled as a non-skill kind: not installable
                    # under either kind, so advertising would dead-end. (A genuine skill keeps
                    # kind=='skill' and is listed.) We never re-label a signed kind.
                    if kind != "skill" and is_skill_origin_plugin(str(cid), entry.get("skill_origin")):
                        continue
                    r2_key = _artifact_ref_to_r2_key(entry.get("artifact_ref"))
                    # Bind declared kind to artifact location AND require the bytes to be present.
                    if r2_key is None or not r2_key.startswith(f"capabilities/{kind}/") or r2_key not in present_keys:
                        continue
                    if not verify_official_cosignature(entry, official_public_key=official_key):
                        continue
                    capabilities.append({"kind": kind, "capability_id": cid, "version": ver})
            except (httpx.HTTPError, ValueError, CapabilityR2Error) as exc:
                # Keep the raw cause server-side (it can carry an env path / R2 / AWS-CLI stderr /
                # bucket+endpoint); the network response stays a fixed generic code (no internals),
                # consistent with POST /api/capabilities/install.
                _LOGGER.warning("capability distribution unavailable: %s", exc)
                error = "distribution_unavailable"
        return {"capabilities": capabilities, "r2_configured": r2_ready, "error": error}

    @app.get("/api/capabilities/installed")
    def capability_installed(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """Neutral, origin-tagged view of INSTALLED capabilities, unioning the legacy Python
        plugin cache with the Node S4 super-workshop store — the single surface the web reads.

        Each entry carries an explicit ``origin`` (``cache`` | ``node-workshop``) and
        ``native_key`` so uninstall can route back to the right store; entries are NOT merged
        across origins/kinds (a cache ``plugin/foo@1`` and a Node ``skill/foo@1`` are distinct).
        ``node_available`` is False when Node was never co-launched or its loopback read is
        degraded — a signal the surface must show, never a silent "nothing installed".
        Registered BEFORE ``/{capability_id}`` so the literal path is not shadowed.
        """
        from superclaw.capability_workshop_installed import list_installed_node_capabilities

        capabilities: list[dict[str, Any]] = []
        cache_status = plugin_status_payload()
        for plugin in cache_status.get("plugins", []) or []:
            pid = plugin.get("id")
            ver = plugin.get("version")
            if not isinstance(pid, str) or not pid:
                continue
            capabilities.append(
                {
                    "origin": "cache",
                    "kind": "skill" if plugin.get("skill_origin") else "plugin",
                    "capability_id": pid,
                    "native_key": pid,
                    "version": ver if isinstance(ver, str) else None,
                    "name": plugin.get("name") if isinstance(plugin.get("name"), str) else pid,
                    "official": False,  # the cache view does not carry a workshop-cosign tag here
                    "configurable": True,  # legacy cache plugins have a Python config surface
                    "uninstallable": True,
                }
            )
        node_caps, node_available = list_installed_node_capabilities()
        capabilities.extend(node_caps)
        return {"capabilities": capabilities, "node_available": node_available}

    @app.post("/api/capabilities/uninstall")
    def capability_uninstall(
        request: CapabilityUninstallRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Neutral uninstall that routes by ``origin`` to the legacy Python cache or the Node S4
        store. Fail-closed: a store error surfaces as 502 with a generic reason (raw cause kept
        server-side), never a false success; an unknown native_key for a node uninstall is the
        caller's responsibility (Node returns 404 -> 502 here)."""
        if request.origin == "cache":
            try:
                result = uninstall_cached_plugin(
                    request.capability_id, version=request.version, cache_root=plugin_cache_root()
                )
            except (PluginVerificationError, OSError, ValueError) as exc:
                _LOGGER.warning("cache uninstall failed: %s@%s: %s", request.capability_id, request.version, exc)
                raise HTTPException(status_code=502, detail="uninstall failed") from exc
            return {"ok": True, "origin": "cache", "capability_id": request.capability_id, "result": result}
        # origin == "node-workshop"
        from superclaw.capability_workshop_installed import (
            WorkshopInstalledReadError,
            uninstall_node_capability,
        )

        native_key = request.native_key or request.capability_id
        try:
            return uninstall_node_capability(native_key)
        except WorkshopInstalledReadError as exc:
            _LOGGER.warning("node uninstall failed: %s: %s", native_key, exc)
            raise HTTPException(status_code=502, detail="uninstall failed") from exc

    @app.get("/api/capabilities/{capability_id}")
    def capability_detail(capability_id: str) -> dict[str, Any]:
        try:
            return get_capability(capability_id).to_dict()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc

    @app.get("/api/runtime")
    def runtime(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runtime_manifest()

    @app.get("/api/runtime/compare")
    def runtime_compare(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runtime_cli_comparison()

    @app.get("/api/runtime/context")
    def runtime_context(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return store.context_usage()

    @app.get("/api/runtime/status")
    def runtime_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runtime_status_payload()

    @app.post("/api/runtime/control-token/rotate")
    def runtime_control_token_rotate(_: None = Depends(require_control_token)) -> dict[str, Any]:
        current = current_control_token()
        if not current:
            raise HTTPException(status_code=409, detail="runtime control token is not configured")
        rotated = generate_control_token()
        app.state.control_token = rotated
        os.environ["SUPERCLAW_CONTROL_TOKEN"] = rotated
        return {
            "ok": True,
            "control_token": rotated,
            "rotated_at": time.time(),
            "service": {
                "control_token": "set",
            },
        }

    @app.get("/api/config")
    def runtime_config(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runtime_config_payload()

    @app.post("/api/config/set")
    def runtime_config_set(request: RuntimeConfigSetRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        updated = set_runtime_config(request.name, request.value, allow_secret=False, apply_process_env=False)
        return {
            "updated": updated,
            "config_path": str(shell_config_path()),
            "defaults": runtime_config_payload()["defaults"],
        }

    @app.get("/api/appearance")
    def appearance_get(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return appearance_kernel.appearance_payload()

    @app.post("/api/appearance/set")
    def appearance_set(request: AppearanceSetRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            _config, warnings = appearance_kernel.apply_appearance(
                active_preset=request.active_preset, custom=request.custom
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        payload = appearance_kernel.appearance_payload()
        payload["warnings"] = warnings
        return payload

    @app.post("/api/appearance/custom-color")
    def appearance_custom_color(
        request: AppearanceCustomColorRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            appearance_kernel.set_custom_color(request.canvas, request.token, request.color)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return appearance_kernel.appearance_payload()

    @app.get("/api/appearance/export")
    def appearance_export(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return appearance_kernel.build_appearance_export()

    @app.post("/api/appearance/import")
    def appearance_import(request: AppearanceImportRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            _config, warnings = appearance_kernel.import_appearance_bundle(request.bundle)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        payload = appearance_kernel.appearance_payload()
        payload["warnings"] = warnings
        return payload

    @app.get("/api/onboarding")
    def onboarding_state(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return load_onboarding_state()

    @app.post("/api/onboarding/complete")
    def onboarding_complete(
        request: OnboardingCompleteRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            return set_onboarding_completed(int(request.version))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/onboarding/reset")
    def onboarding_reset(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return reset_onboarding_state()

    @app.get("/api/media/status")
    def media_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runninghub_media_status()

    @app.get("/api/media/templates")
    def media_templates(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runninghub_media_catalog()

    @app.get("/api/media/doctor")
    def media_doctor(
        live_metadata: bool = False,
        timeout_seconds: float = 20.0,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            return runninghub_media_doctor(live_metadata=live_metadata, timeout_seconds=timeout_seconds)
        except RunningHubMediaError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/media/generate")
    def media_generate(request: MediaGenerateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = submit_runninghub_media_task(
                RunningHubMediaRequest(
                    template=request.template,
                    prompt=request.prompt,
                    negative_prompt=request.negative_prompt,
                    source_image=request.source_image,
                    source_video=request.source_video,
                    node_info_list=tuple(request.node_info_list),
                    inputs=request.inputs,
                    dry_run=request.dry_run,
                    artifact_dir=media_request_artifact_dir(request.run_id, request.artifact_dir),
                    timeout_seconds=request.timeout_seconds,
                )
            )
            return attach_media_result_to_run(
                result,
                request.run_id,
                artifact_kind="runninghub-media-task-json",
                event_type="media.generate.recorded",
            )
        except RunningHubMediaError as exc:
            return JSONResponse(
                status_code=400,
                content={"code": "MEDIA_REQUEST_BLOCKED", "detail": str(exc)},
                headers={"X-SuperClaw-Media-Code": "MEDIA_REQUEST_BLOCKED"},
            )

    @app.post("/api/media/render")
    def media_render(request: MediaRenderRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = render_runninghub_media_task(
                RunningHubMediaRenderRequest(
                    generation=RunningHubMediaRequest(
                        template=request.template,
                        prompt=request.prompt,
                        negative_prompt=request.negative_prompt,
                        source_image=request.source_image,
                        source_video=request.source_video,
                        node_info_list=tuple(request.node_info_list),
                        inputs=request.inputs,
                        dry_run=request.dry_run,
                        artifact_dir=media_request_artifact_dir(request.run_id, request.artifact_dir),
                        timeout_seconds=request.timeout_seconds,
                    ),
                    wait_for_outputs=request.wait_for_outputs,
                    max_polls=request.max_polls,
                    poll_interval_seconds=request.poll_interval_seconds,
                    query_timeout_seconds=request.query_timeout_seconds,
                )
            )
            return attach_media_render_to_run(result, request.run_id)
        except RunningHubMediaError as exc:
            return JSONResponse(
                status_code=400,
                content={"code": "MEDIA_REQUEST_BLOCKED", "detail": str(exc)},
                headers={"X-SuperClaw-Media-Code": "MEDIA_REQUEST_BLOCKED"},
            )

    @app.post("/api/media/upload")
    def media_upload(request: MediaUploadRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = upload_runninghub_media_file(
                RunningHubMediaUploadRequest(
                    file_path=Path(request.file_path),
                    file_type=request.file_type,
                    dry_run=request.dry_run,
                    artifact_dir=media_request_artifact_dir(request.run_id, request.artifact_dir),
                    timeout_seconds=request.timeout_seconds,
                )
            )
            return attach_media_result_to_run(
                result,
                request.run_id,
                artifact_kind="runninghub-media-upload-json",
                event_type="media.upload.recorded",
            )
        except RunningHubMediaError as exc:
            return JSONResponse(
                status_code=400,
                content={"code": "MEDIA_REQUEST_BLOCKED", "detail": str(exc)},
                headers={"X-SuperClaw-Media-Code": "MEDIA_REQUEST_BLOCKED"},
            )

    @app.post("/api/media/task-status")
    def media_task_status(request: MediaTaskQueryRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = query_runninghub_media_task(
                request.task_id,
                query="status",
                mode=request.mode,  # type: ignore[arg-type]
                artifact_dir=media_request_artifact_dir(request.run_id, request.artifact_dir),
                timeout_seconds=request.timeout_seconds,
            )
            return attach_media_result_to_run(
                result,
                request.run_id,
                artifact_kind="runninghub-media-status-json",
                event_type="media.task_status.recorded",
            )
        except RunningHubMediaError as exc:
            return JSONResponse(
                status_code=400,
                content={"code": "MEDIA_REQUEST_BLOCKED", "detail": str(exc)},
                headers={"X-SuperClaw-Media-Code": "MEDIA_REQUEST_BLOCKED"},
            )

    @app.post("/api/media/outputs")
    def media_outputs(request: MediaTaskQueryRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = query_runninghub_media_task(
                request.task_id,
                query="outputs",
                mode=request.mode,  # type: ignore[arg-type]
                artifact_dir=media_request_artifact_dir(request.run_id, request.artifact_dir),
                timeout_seconds=request.timeout_seconds,
            )
            return attach_media_result_to_run(
                result,
                request.run_id,
                artifact_kind="runninghub-media-outputs-json",
                event_type="media.outputs.recorded",
            )
        except RunningHubMediaError as exc:
            return JSONResponse(
                status_code=400,
                content={"code": "MEDIA_REQUEST_BLOCKED", "detail": str(exc)},
                headers={"X-SuperClaw-Media-Code": "MEDIA_REQUEST_BLOCKED"},
            )

    @app.get("/api/media/artifacts/{artifact_id}")
    def media_artifact(artifact_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return load_runninghub_media_artifact(artifact_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="media artifact not found") from exc
        except RunningHubMediaError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/auth/status")
    def auth_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return clawhunt_auth_payload()

    @app.get("/api/auth/clawhunt/browser/start")
    def auth_clawhunt_browser_start(
        request: Request,
        provider: str = "google",
        invite_code: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        client = ClawHuntAccountClient()
        state = secrets.token_urlsafe(24)
        expires_at = time.time() + CLAWHUNT_BROWSER_LOGIN_STATE_TTL_SECONDS
        callback_base = str(request.base_url).rstrip("/") + "/api/auth/clawhunt/browser/callback"
        callback_url = f"{callback_base}?{urlencode({'state': state, 'source': SUPERCLAW_LOGIN_SOURCE})}"
        try:
            login_url = build_clawhunt_browser_login_url(
                base_url=client.settings.base_url,
                callback_url=callback_url,
                provider=provider,
                invite_code=invite_code,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        save_clawhunt_auth(
            {
                "browser_login_state": state,
                "browser_login_state_expires_at": expires_at,
                "browser_login_provider": provider.strip().lower() if provider.strip() else "google",
                "login_source": SUPERCLAW_LOGIN_SOURCE,
            }
        )
        return {
            "ok": True,
            "source": SUPERCLAW_LOGIN_SOURCE,
            "provider": provider,
            "login_url": login_url,
            "callback_url": callback_url,
            "expires_in_seconds": CLAWHUNT_BROWSER_LOGIN_STATE_TTL_SECONDS,
        }

    @app.get("/api/auth/clawhunt/browser/callback")
    def auth_clawhunt_browser_callback(
        state: str,
        source: str = "",
        token: str | None = None,
        handoff_code: str | None = None,
        clawhunt_sso_token: str | None = None,
        error: str | None = None,
        clawhunt_sso_error: str | None = None,
    ) -> HTMLResponse:
        auth = load_clawhunt_auth()
        expected_state = auth.get("browser_login_state")
        expires_at = auth.get("browser_login_state_expires_at")
        provider = str(auth.get("browser_login_provider") or "google")
        clear_browser_state = {
            "browser_login_state": None,
            "browser_login_state_expires_at": None,
            "browser_login_provider": None,
        }
        if source != SUPERCLAW_LOGIN_SOURCE:
            return html_auth_callback("SuperClaw login rejected", "Missing SuperClaw login source marker.", status_code=400)
        if not isinstance(expected_state, str) or not expected_state or not secrets.compare_digest(state, expected_state):
            return html_auth_callback("SuperClaw login rejected", "The ClawHunt login state did not match.", status_code=401)
        if not isinstance(expires_at, (int, float)) or float(expires_at) < time.time():
            save_clawhunt_auth(clear_browser_state)
            return html_auth_callback("SuperClaw login expired", "Start ClawHunt login again from SuperClaw.", status_code=401)
        save_clawhunt_auth(clear_browser_state)
        if error or clawhunt_sso_error:
            return html_auth_callback("SuperClaw login failed", error or clawhunt_sso_error or "ClawHunt returned an error.", status_code=400)

        account_source = f"clawhunt_{provider}_browser"
        try:
            if handoff_code:
                exchanged = ClawHuntAccountClient().exchange_cli_handoff(handoff_code)
                access_token, user = extract_login_session(exchanged)
            else:
                access_token = (token or clawhunt_sso_token or "").strip()
                if not access_token:
                    return html_auth_callback("SuperClaw login failed", "ClawHunt did not return a token.", status_code=400)
                profile = ClawHuntAccountClient().profile(access_token)
                if not profile.get("ok"):
                    profile = ClawHuntAccountClient().me(access_token)
                body = profile.get("body") if profile.get("ok") else {}
                user = body.get("user") if isinstance(body, dict) and isinstance(body.get("user"), dict) else body if isinstance(body, dict) else {}
            save_clawhunt_account_session(access_token=access_token, user=user, account_source=account_source)
        except (httpx.HTTPError, ValueError) as exc:
            return html_auth_callback("SuperClaw login failed", f"Could not complete ClawHunt login: {exc}", status_code=502)
        return html_auth_callback("SuperClaw login complete", "You can return to SuperClaw. The desktop app and CLI now share this ClawHunt account.")

    @app.post("/api/auth/clawhunt/login")
    def auth_clawhunt_login(request: ClawHuntLoginRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        key = request.agent_api_key.strip()
        if not key:
            raise HTTPException(status_code=400, detail="agent_api_key must be non-empty")
        save_clawhunt_auth(
            {
                "agent_api_key": key,
                "agent_key_source": "manual",
                "agent_key_name": "Manual agent key",
            }
        )
        return clawhunt_auth_payload()

    @app.post("/api/auth/clawhunt/logout")
    def auth_clawhunt_logout(_: None = Depends(require_control_token)) -> dict[str, Any]:
        clear_clawhunt_auth()
        return clawhunt_auth_payload()

    @app.get("/api/auth/clawhunt/account/login-probe")
    def auth_clawhunt_account_login_probe(_: None = Depends(require_control_token)) -> dict[str, Any]:
        client = ClawHuntAccountClient()
        try:
            response = client.login_probe()
        except httpx.HTTPError as exc:
            return login_probe_error_result(base_url=client.settings.base_url, exc=exc)
        return classify_login_probe_result(base_url=client.settings.base_url, response=response)

    def saved_clawhunt_account_token_or_401() -> str:
        access_token = saved_clawhunt_access_token()
        if not access_token:
            raise HTTPException(status_code=401, detail="clawhunt account auth not configured")
        return access_token

    def account_response_status(response: dict[str, Any]) -> int:
        raw = response.get("status_code")
        return raw if isinstance(raw, int) and 400 <= raw < 500 else 502

    @app.post("/api/auth/clawhunt/account/login")
    def auth_clawhunt_account_login(request: ClawHuntAccountLoginRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        username = request.username.strip()
        password = request.password
        if not username or not password.strip():
            raise HTTPException(status_code=400, detail="username and password must be non-empty")
        try:
            response = ClawHuntAccountClient().login(username, password)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"clawhunt account login failed: {exc.__class__.__name__}") from exc
        try:
            access_token, user = extract_login_session(response)
        except ValueError as exc:
            raise HTTPException(status_code=account_response_status(response), detail=str(exc)) from exc
        save_clawhunt_auth({"access_token": access_token, "account_user": user, "account_source": "password", "login_source": SUPERCLAW_LOGIN_SOURCE})
        return {"auth": clawhunt_auth_payload(), "user": user}

    @app.get("/api/auth/clawhunt/account/me")
    def auth_clawhunt_account_me(_: None = Depends(require_control_token)) -> dict[str, Any]:
        access_token = saved_clawhunt_account_token_or_401()
        try:
            response = ClawHuntAccountClient().me(access_token)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"clawhunt account profile failed: {exc.__class__.__name__}") from exc
        if response.get("ok") and isinstance(response.get("body"), dict):
            # Filter through the SAME whitelist as /api/auth/status (_safe_user_payload)
            # so neither the persisted auth file NOR this response leaks unwhitelisted
            # upstream UserResponse fields — the sibling /api/auth/status path already
            # filters on read, and this path must match it (no asymmetric boundary).
            safe = _safe_user_payload(response["body"])
            save_clawhunt_auth({"account_user": safe})
            response = {**response, "body": safe}
        return response

    @app.get("/api/auth/clawhunt/account/agents")
    def auth_clawhunt_account_agents(_: None = Depends(require_control_token)) -> dict[str, Any]:
        access_token = saved_clawhunt_account_token_or_401()
        try:
            return ClawHuntAccountClient().agents(access_token)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"clawhunt account agents failed: {exc.__class__.__name__}") from exc

    @app.post("/api/auth/clawhunt/agent-key")
    def auth_clawhunt_agent_key_create(request: ClawHuntAgentKeyCreateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        access_token = saved_clawhunt_account_token_or_401()
        name = request.name.strip()
        permissions = [permission.strip() for permission in request.permissions if permission.strip()]
        if not name:
            raise HTTPException(status_code=400, detail="name must be non-empty")
        if not permissions:
            raise HTTPException(status_code=400, detail="permissions must be non-empty")
        try:
            response = ClawHuntAccountClient().create_agent_key(
                access_token,
                name=name,
                agent_id=request.agent_id,
                permissions=permissions,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"clawhunt agent key creation failed: {exc.__class__.__name__}") from exc
        body = response.get("body")
        key = body.get("key") if isinstance(body, dict) else None
        if not response.get("ok") or not isinstance(key, str) or not key.strip():
            detail = body.get("detail") if isinstance(body, dict) else None
            raise HTTPException(status_code=account_response_status(response), detail=str(detail or "clawhunt agent key creation did not return a key"))
        save_clawhunt_auth(
            {
                "agent_api_key": key.strip(),
                "agent_key_source": "account",
                "agent_key_name": name,
                "agent_id": request.agent_id,
            }
        )
        return {"auth": clawhunt_auth_payload(), "agent_key": {"status": "set", "source": "account", "name": name, "agent_id": request.agent_id}}

    @app.get("/api/auth/clawhunt/me")
    def auth_clawhunt_me(_: None = Depends(require_control_token)) -> dict[str, Any]:
        client = ClawHuntClient()
        if not client.settings.agent_api_key:
            raise HTTPException(status_code=401, detail="clawhunt auth not configured")
        return client.me()

    @app.get("/api/clawhunt/live-readiness")
    def clawhunt_live_readiness(
        authenticated_read: bool = False,
        require_payment: bool = False,
        include_probe: bool = True,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return ClawHuntClient().live_readiness_report(
            authenticated_read=authenticated_read,
            require_payment=require_payment,
            include_probe=include_probe,
        )

    @app.get("/api/clawhunt/tasks")
    def clawhunt_tasks(
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        # Mirror the CLI `clawhunt browse` pagination surface exactly. The CLI
        # rejects out-of-range values (typer min/max), so the API rejects them
        # too instead of silently clamping — one shared pagination contract.
        if skip < 0 or limit < 1 or limit > 50:
            raise HTTPException(status_code=422, detail="skip must be >= 0 and limit in 1..50")
        normalized_status = status.strip() if status else None
        params: dict[str, Any] = {"skip": skip, "limit": limit}
        if normalized_status:
            params["status"] = normalized_status
        # Context-aware browse: with NO linked agent key the dock shows ClawHunt's
        # public, anonymous marketplace (so the board displays without a login); with
        # a key it shows the agent's personalized/visibility-filtered listing. The
        # kernel (browse_marketplace) owns that choice — surfaces just project it.
        response = ClawHuntClient().browse_marketplace(**params)
        ok = bool(response.get("ok", False))
        # Fail closed: never surface tasks parsed from a failed upstream response
        # (e.g. a CF-gate or upstream error body). The Web dock renders this
        # ok:false as "marketplace unavailable" rather than an empty market.
        items = (
            [clawhunt_task_summary(item) for item in clawhunt_problem_items(response.get("body"))]
            if ok
            else []
        )
        # Fail closed: a failed upstream means the market is unavailable, so there is
        # no "next page" to chase. Only a successful response carries a real
        # has_more signal (or its full-page fallback) for the Web dock to page on.
        has_more = clawhunt_problem_has_more(response.get("body"), len(items), limit) if ok else False
        return {
            "ok": ok,
            "status_code": response.get("status_code", 0),
            "tasks": items,
            "count": len(items),
            "skip": skip,
            "limit": limit,
            "has_more": has_more,
            # Fail closed all the way: a failed upstream body can itself carry
            # problems — never echo it back via `raw`. Only successful responses
            # expose the raw body (the side task browser relies on it).
            "raw": response.get("body") if ok else None,
        }

    @app.get("/api/clawhunt/tasks/{problem_id}")
    def clawhunt_task_detail(problem_id: int, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # Context-aware detail to match the listing: agent-gated (privileged,
        # post-claim) detail when a key is linked, else the anonymous public detail.
        response = ClawHuntClient().get_problem_marketplace(problem_id)
        ok = bool(response.get("ok", False))
        # Fail closed, mirroring the list endpoint: a failed upstream (CF-gate
        # challenge, 401/5xx) must never surface a parsed task or echo the error
        # body back through `raw`. The Web dock then keeps the teaser card instead of
        # rendering a half-broken detail.
        payload = (clawhunt_problem_payload(response.get("body")) or {"id": problem_id}) if ok else None
        return {
            "ok": ok,
            "status_code": response.get("status_code", 0),
            "task": clawhunt_task_summary(payload) if payload is not None else None,
            "problem_payload": payload,
            "raw": response.get("body") if ok else None,
        }

    @app.get("/api/runtime/mcp-status")
    def runtime_mcp(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return runtime_mcp_status()

    @app.get("/api/plugins/status")
    def plugin_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return plugin_status_payload()

    @app.get("/api/plugins/{plugin_id}/logo")
    def plugin_logo(plugin_id: str, version: str | None = None) -> FileResponse:
        path, mime = resolve_cached_plugin_logo(plugin_id, version=version)
        return FileResponse(
            path,
            media_type=mime,
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/plugins/diagnostics")
    def plugin_diagnostics(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_plugin_diagnostics_payload(artifact_dir=superclaw_data_path("artifacts", "plugins"))

    @app.get("/api/plugins/diagnostics/events")
    def plugin_diagnostics_events(once: bool = False, _: None = Depends(require_control_token)) -> StreamingResponse:
        def stream():
            previous = None
            while True:
                payload = build_plugin_diagnostics_payload(artifact_dir=superclaw_data_path("artifacts", "plugins"))
                current = json.dumps(payload, ensure_ascii=False, sort_keys=True)
                if current != previous:
                    yield "event: plugin.diagnostics\n"
                    yield f"data: {current}\n\n"
                    previous = current
                    if once:
                        break
                time.sleep(1.0)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/api/desktop/toolchain")
    def desktop_toolchain(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_desktop_toolchain_payload(workspace_root=Path(".").resolve())

    @app.get("/api/desktop/acceptance")
    def desktop_acceptance(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_desktop_acceptance_payload(workspace_root=Path(".").resolve())

    @app.get("/api/tui/acceptance")
    def tui_acceptance(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_tui_acceptance_payload(workspace_root=Path(".").resolve())

    @app.get("/api/desktop/onboarding")
    def desktop_onboarding(_: None = Depends(require_control_token)) -> dict[str, Any]:
        workspace_root = Path(".").resolve()
        agents = backend_inventory()
        return build_desktop_onboarding_payload(
            workspace_root=workspace_root,
            runtime_status=runtime_status_payload(),
            agents=agents,
            auth_payload=clawhunt_auth_payload(),
            plugin_status=plugin_status_payload(),
            toolchain_payload=build_desktop_toolchain_payload(workspace_root=workspace_root),
            acceptance_payload=build_desktop_acceptance_payload(workspace_root=workspace_root),
        )

    @app.post("/api/plugins/install")
    def plugin_install(request: PluginInstallRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        public_key = os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY")
        if not public_key:
            raise HTTPException(status_code=400, detail="SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY is not configured")
        try:
            resolved_version = resolve_registry_plugin_version(cloud_root(), request.plugin_id, request.version)
            result = install_plugin_from_cloud_metadata(
                cloud_root(),
                request.plugin_id,
                resolved_version,
                public_key=public_key,
                cache_root=plugin_cache_root(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        clear_catalog_cache()
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "version": result.version,
            "digest": result.digest,
            "installed": True,
            "status": plugin_status_payload(),
        }

    @app.post("/api/plugins/install-local")
    def plugin_install_local(request: LocalPluginInstallRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # The root public key is OPTIONAL here: a LOCAL-provenance skill-origin
        # package is equippable sign-free (design §3.6), so install-local must not
        # hard-require a key (that would create CLI↔API drift — CLI
        # `plugin verify --cache` installs a local skill keyless). The kernel still
        # enforces a signature for a non-skill / generic local package
        # (resolve_signature_trust raises a clear error surfaced as 400 below), so
        # dropping the up-front 400 narrows nothing for generic plugins.
        public_key = os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY")
        try:
            result = verify_plugin_package(
                Path(request.package_path).expanduser(),
                public_key=public_key,
                cache_root=plugin_cache_root(),
                revocation_file=cloud_root() / "governance" / "revocations.json",
                cache=True,
                # User-chosen local package path => LOCAL provenance (sign-free
                # equippable for skill-origin packages, design §3.7).
                provenance="local",
                install_entry="install-local",
            )
        except (PluginVerificationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        clear_catalog_cache()
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "version": result.version,
            "digest": result.digest,
            "installed": True,
            "package_path": request.package_path,
            "status": plugin_status_payload(),
        }

    @app.get("/api/plugins/github-catalog")
    def plugin_github_catalog(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"plugins": [dict(entry) for entry in GITHUB_PLUGIN_CATALOG]}

    @app.get("/api/plugins/marketplace-catalog")
    def plugin_marketplace_catalog(_: None = Depends(require_control_token)) -> dict[str, Any]:
        catalog_url = _plugin_marketplace_catalog_url()
        try:
            response = httpx.get(catalog_url, follow_redirects=True, timeout=8.0)
            response.raise_for_status()
            payload = response.json()
            plugins = payload.get("plugins", payload.get("items", [])) if isinstance(payload, dict) else []
            if not isinstance(plugins, list):
                plugins = []
            return {
                "source": payload.get("source", "clawhunt_server") if isinstance(payload, dict) else "clawhunt_server",
                "catalog_url": catalog_url,
                "total": len(plugins),
                "plugins": plugins,
                "error": None,
            }
        except (httpx.HTTPError, ValueError) as exc:
            return {
                "source": "unavailable",
                "catalog_url": catalog_url,
                "total": 0,
                "plugins": [],
                "error": str(exc),
            }

    @app.get("/api/plugins/workshop-catalog")
    def capability_workshop_catalog(
        kind: str | None = None, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Live capability-workshop catalog, projected from ClawHunt's public
        ``/v1/capabilities/published`` feed into the marketplace surface shape.

        This makes the workshop list real-time: every capability ClawHunt has
        approved/published surfaces here, replacing the static mock fallback. It
        is a thin surface proxy — no governance decision happens here; the kernel
        (ClawHunt review) decides what is published, and this only re-shapes the
        already-public projection for the web surface.
        """
        catalog_url = _capability_workshop_catalog_url()
        params = {"kind": kind} if kind else None
        try:
            response = httpx.get(catalog_url, params=params, follow_redirects=True, timeout=8.0)
            response.raise_for_status()
            payload = response.json()
            entries = payload.get("entries", []) if isinstance(payload, dict) else []
            if not isinstance(entries, list):
                entries = []
            # Independently re-verify each entry's official co-signature against the
            # LOCALLY-baked official public key — the only trustworthy basis for an
            # "officially endorsed" badge (never the feed's self-reported flag). The
            # baked key is per-environment; empty (production pre-bake) -> all False.
            official_key = official_root_public_key()
            plugins = [
                _map_capability_entry_to_marketplace(
                    entry,
                    official_verified=verify_official_cosignature(entry, official_public_key=official_key),
                )
                for entry in entries
                if isinstance(entry, dict)
            ]
            return {
                "source": "clawhunt_workshop",
                "catalog_url": catalog_url,
                "total": len(plugins),
                "plugins": plugins,
                "error": None,
            }
        except (httpx.HTTPError, ValueError) as exc:
            return {
                "source": "unavailable",
                "catalog_url": catalog_url,
                "total": 0,
                "plugins": [],
                "error": str(exc),
            }

    @app.post("/api/plugins/install-github")
    def plugin_install_github(request: GithubPluginInstallRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        entry = _github_plugin_entry(request.plugin_id, request.version)
        if not entry:
            raise HTTPException(status_code=404, detail=f"no GitHub release configured for {request.plugin_id}")
        # Red line (capability-workshop): install-github is another plugin install sink —
        # refuse a skill-origin capability here too (single source is_skill_origin_plugin;
        # the "skill." id prefix is the operative signal since the github catalog carries
        # no skill_origin field) so it can never bypass the kernel registry-install guard.
        if is_skill_origin_plugin(request.plugin_id, entry.get("skill_origin")):
            raise HTTPException(status_code=400, detail=f"{request.plugin_id} is a skill capability, not installable via the plugin pipeline")
        url = entry["url"]
        # Verification key: env override, else the local root public key file.
        public_key = os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY")
        if not public_key:
            key_file = superclaw_data_path("keys", "official-root.pub")
            if key_file.exists():
                public_key = key_file.read_text(encoding="utf-8").strip()
        if not public_key:
            raise HTTPException(status_code=400, detail="no plugin verification key available")
        # Download the signed .scplug from the public GitHub release, then verify
        # its signature + digest before it is cached (the download source is never
        # trusted — only the signature against the root key is).
        tmp_dir = Path(tempfile.mkdtemp(prefix="superclaw-gh-"))
        tmp_pkg = tmp_dir / "package.scplug"
        try:
            with httpx.stream("GET", url, follow_redirects=True, timeout=180.0) as response:
                response.raise_for_status()
                with tmp_pkg.open("wb") as fh:
                    for chunk in response.iter_bytes():
                        fh.write(chunk)
            result = verify_plugin_package(
                tmp_pkg,
                public_key=public_key,
                cache_root=plugin_cache_root(),
                revocation_file=cloud_root() / "governance" / "revocations.json",
                cache=True,
                # GitHub release download is a REMOTE entry: must verify under the
                # root key, never sign-free local (design §3.7). reject_skill_origin
                # is the manifest backstop so an advertised-as-plugin skill cannot
                # be installed through this sink (capability-workshop red line).
                provenance="remote",
                install_entry="install-github",
                reject_skill_origin=True,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"download failed: {exc}") from exc
        except (PluginVerificationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        # Identity/digest re-check: the verified package must be exactly the catalog
        # entry we resolved (defends against a swapped GitHub release asset, even one
        # validly signed). On mismatch, roll back the cache write and reject.
        expected_digest = entry.get("package_digest")
        if (
            result.plugin_id != entry["plugin_id"]
            or result.version != entry["version"]
            or (expected_digest and result.digest != expected_digest)
        ):
            uninstall_cached_plugin(result.plugin_id, version=result.version, cache_root=plugin_cache_root())
            clear_catalog_cache()
            raise HTTPException(
                status_code=409,
                detail=f"downloaded package does not match catalog: got {result.plugin_id}@{result.version}",
            )
        clear_catalog_cache()
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "version": result.version,
            "digest": result.digest,
            "installed": True,
            "source": "github",
            "url": url,
            "status": plugin_status_payload(),
        }

    def _fetch_workshop_entries() -> list[dict[str, Any]]:
        """Fetch the live workshop feed and return its entries.

        Feed-fetch failures (network / non-2xx) and a malformed-but-200 payload both
        RAISE (httpx.HTTPError / ValueError) so a transient outage or upstream defect
        maps to 502 — never a false 404 "not published". The feed is the same
        untrusted public source the catalog endpoint reads; callers MUST re-verify the
        official co-signature."""
        response = httpx.get(_capability_workshop_catalog_url(), follow_redirects=True, timeout=8.0)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("entries", []), list):
            raise ValueError("malformed workshop feed payload")
        return [entry for entry in payload.get("entries", []) if isinstance(entry, dict)]

    def _published_workshop_entry(plugin_id: str, version: str) -> dict[str, Any] | None:
        """The published entry for an exact plugin_id@version, or None when the feed
        loaded but has no such entry. Raises on feed failure (see _fetch_workshop_entries)."""
        for entry in _fetch_workshop_entries():
            entry_id = entry.get("capability_id") or entry.get("plugin_id")
            if entry_id == plugin_id and str(entry.get("version") or "") == str(version):
                return entry
        return None

    @app.get("/api/plugins/workshop-distribution")
    def plugin_workshop_distribution(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The PUBLISHED workshop capabilities the kernel can fetch+install from R2.

        A capability is installable iff R2 is configured AND its live feed entry is a
        plugin with a verified official co-signature and a resolvable artifact object
        ref. The web reads this to know which workshop cards offer a real install (vs.
        discovery-only). No hardcoded per-plugin list — it generalizes to everything
        ClawHunt has published + co-signed.

        Installability requires the artifact bytes to ACTUALLY exist in R2, not merely
        that the feed entry names a well-formed object ref: a capability can be
        "published" (metadata + co-signature) while its package was never uploaded (a
        publish-without-upload gap). Such a ghost entry must NOT surface an install
        button — clicking it dead-ends at a 502 ``NoSuchKey``. We list the plugin
        artifacts ONCE (single ``list-objects-v2``, not one HEAD per candidate) and
        only report a plugin installable when its object key is really present."""
        # load_r2_config normalizes a missing/unreadable config (incl. filesystem
        # faults) into CapabilityR2Error, so an IO/permission fault degrades to
        # discovery-only here instead of a 500.
        try:
            r2_config = load_r2_config()
        except CapabilityR2Error:
            r2_config = None
        r2_ready = r2_config is not None
        plugins: list[dict[str, str]] = []
        error: str | None = None
        if r2_ready and r2_config is not None:
            try:
                official_key = official_root_public_key()
                artifact_bucket = _r2_artifact_bucket()
                # One R2 round-trip for the whole plugin-artifact keyspace; membership
                # is then a local set lookup. A list failure raises CapabilityR2Error
                # (caught below) so installability fails closed to "none" rather than
                # falsely advertising every entry.
                present_keys = list_r2_object_keys(artifact_bucket, "capabilities/plugin/", config=r2_config)
                for entry in _fetch_workshop_entries():
                    # Skill predicate must match the install-workshop guard AND the kernel
                    # single source: a drifted entry that is kind:'plugin' but skill_origin
                    # or a "skill." id is still a skill and must never be advertised as
                    # installable (else the front end gets a real plugin-install path).
                    cid = entry.get("capability_id") or entry.get("plugin_id")
                    if (entry.get("kind") or "plugin") != "plugin" or is_skill_origin_plugin(str(cid or ""), entry.get("skill_origin")):
                        continue
                    r2_key = _artifact_ref_to_r2_key(entry.get("artifact_ref"))
                    if r2_key is None:
                        continue
                    if not verify_official_cosignature(entry, official_public_key=official_key):
                        continue
                    # The package bytes must be present in the artifact store; a
                    # published-but-never-uploaded entry is discovery-only, not
                    # installable.
                    if r2_key not in present_keys:
                        continue
                    cid = entry.get("capability_id") or entry.get("plugin_id")
                    ver = entry.get("version")
                    if isinstance(cid, str) and cid and isinstance(ver, str) and ver:
                        plugins.append({"plugin_id": cid, "version": ver})
            except (httpx.HTTPError, ValueError, CapabilityR2Error) as exc:
                # Keep the raw cause server-side (it can carry an env path / R2 / AWS-CLI stderr /
                # bucket+endpoint); the response stays a fixed generic code (no internals),
                # consistent with /api/capabilities/distribution and the install endpoints.
                _LOGGER.warning("workshop distribution unavailable: %s", exc)
                error = "distribution_unavailable"
        return {"plugins": plugins, "r2_configured": r2_ready, "error": error}

    @app.post("/api/plugins/install-workshop")
    def plugin_install_workshop(request: WorkshopInstallRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """DEPRECATED (plugin-only, legacy Python-cache install). Superseded by
        ``POST /api/capabilities/install`` (all kinds, lands via the Node S4 super-workshop) —
        the web no longer calls this. Kept for back-compat (and pure-Python deployments with no
        co-launched Node, where the neutral path fail-closes); the response carries
        ``deprecated: true``. Behaviour is unchanged.

        Install a PUBLISHED capability-workshop capability from R2.

        ClawHunt's workshop is metadata-only; the package bytes live in the configured
        Cloudflare R2 artifact store. The published entry's ``artifact_ref`` is the
        single source of truth for the object location (it maps 1:1 to the R2 key).
        Admission is fail-closed on BOTH authenticity checks:
          1. the live feed entry's official co-signature verifies against the baked
             official key (an unendorsed / feed-poisoned entry installs nothing); and
          2. the downloaded package's CONTENT digest equals that co-signed
             ``package_digest`` (the bytes ARE the officially-endorsed package).
        Bytes are fetched via authenticated R2 get-object (server-resolved bucket+key;
        the browser never supplies a URL/key -> no SSRF). The package still passes the
        normal install/verify gate (provenance="remote"), so a host without a trust
        root or local-dev trust fail-closes there too. The download is probed
        cache=False FIRST (digest+identity bind BEFORE any cache write), committed
        cache=True only on a clean bind — a tampered/mismatched package never writes
        to, overwrites, or leaves debris in the cache.
        """
        _LOGGER.warning(
            "deprecated endpoint /api/plugins/install-workshop used (%s@%s); prefer "
            "POST /api/capabilities/install (Node S4)",
            request.plugin_id,
            request.version,
        )
        if not request.version:
            raise HTTPException(status_code=400, detail="version is required for a workshop install (digest-bound to one published entry)")
        # (1) Require a valid official co-signature on the live published entry. A feed
        # outage is a 502 (transient), NOT a 404 "not published" (genuinely absent).
        try:
            entry = _published_workshop_entry(request.plugin_id, request.version)
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=f"workshop feed unavailable: {exc}") from exc
        if entry is None:
            raise HTTPException(status_code=404, detail=f"capability not published in workshop: {request.plugin_id}@{request.version}")
        # This route installs through the PLUGIN pipeline only. A co-signed skill or
        # company has different install/instantiate semantics; refuse so one is never
        # cached as a plugin (skills build/install locally; companies instantiate).
        # Same skill predicate as workshop-distribution + the kernel single source: refuse
        # not only kind:'skill'/'company' but also a drifted kind:'plugin' entry that is
        # skill_origin:true or carries a "skill." capability id (never cache a skill as a plugin).
        cid = entry.get("capability_id") or entry.get("plugin_id")
        if (entry.get("kind") or "plugin") != "plugin" or is_skill_origin_plugin(str(cid or ""), entry.get("skill_origin")):
            raise HTTPException(status_code=400, detail=f"workshop install supports plugin capabilities only; {request.plugin_id} is a skill capability")
        if not verify_official_cosignature(entry, official_public_key=official_root_public_key()):
            raise HTTPException(status_code=403, detail="capability is not officially co-signed; refusing workshop install")
        cosigned_digest = entry.get("package_digest")
        if not isinstance(cosigned_digest, str) or not cosigned_digest:
            raise HTTPException(status_code=502, detail="published workshop entry is missing a co-signed package_digest")
        r2_key = _artifact_ref_to_r2_key(entry.get("artifact_ref"))
        if r2_key is None:
            raise HTTPException(status_code=502, detail="published workshop entry has no resolvable artifact object ref")
        # (2) Fetch the bytes from the configured R2 artifact store (authenticated).
        try:
            r2_config = load_r2_config()
        except CapabilityR2Error as exc:
            raise HTTPException(status_code=503, detail=f"capability artifact store (R2) is not configured: {exc}") from exc
        public_key = os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY")
        if not public_key:
            key_file = superclaw_data_path("keys", "official-root.pub")
            if key_file.exists():
                public_key = key_file.read_text(encoding="utf-8").strip()
        tmp_dir = Path(tempfile.mkdtemp(prefix="superclaw-workshop-"))
        tmp_pkg = tmp_dir / "package.scplug"
        artifact_bucket = _r2_artifact_bucket()
        try:
            try:
                fetch_r2_object(artifact_bucket, r2_key, tmp_pkg, config=r2_config)
            except CapabilityR2Error as exc:
                # Distinguish a publish-without-upload ghost (entry is co-signed and
                # "published" but its bytes were never uploaded) from a genuinely
                # transient download failure, so the caller gets an actionable message
                # instead of a raw NoSuchKey — without a second CLI round-trip (we let
                # the single get-object surface the absence). The web already hides
                # install for these via ``workshop-distribution``; this is defensive for
                # a direct API call.
                lowered = str(exc).lower()
                if "nosuchkey" in lowered or "does not exist" in lowered or "not found" in lowered:
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "capability is published but its package bytes are not in the artifact "
                            "store (publish-without-upload); cannot install"
                        ),
                    ) from exc
                raise HTTPException(status_code=502, detail=f"artifact download from R2 failed: {exc}") from exc
            raw_bytes_before = hashlib.sha256(tmp_pkg.read_bytes()).hexdigest()
            # Verify WITHOUT caching first: computes the content digest + runs the
            # signature/integrity/revocation gate but touches NOTHING in the real cache.
            # The endorsement binding (digest + identity) is checked BEFORE any cache
            # write, so a tampered/mismatched/version-skewed package can never delete or
            # overwrite an existing good install, nor leave cache/provenance debris.
            probe = verify_plugin_package(
                tmp_pkg,
                public_key=public_key,
                cache_root=plugin_cache_root(),
                revocation_file=cloud_root() / "governance" / "revocations.json",
                cache=False,
                provenance="remote",
                install_entry="install-workshop",
                # Manifest backstop: a co-signed entry whose SIGNED manifest is
                # skill_origin:true is a skill, not plugin-installable, regardless
                # of how the workshop feed graded kind/id (capability-workshop red
                # line). Rejected at the probe, before any cache write.
                reject_skill_origin=True,
            )
            if (
                probe.plugin_id != request.plugin_id
                or probe.version != request.version
                or probe.digest != cosigned_digest
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "downloaded package does not match the co-signed workshop entry: "
                        f"got {probe.plugin_id}@{probe.version} {probe.digest}"
                    ),
                )
            # Guard the probe->commit window against a temp-file swap (TOCTOU): the
            # exact bytes that just passed the bind MUST be the bytes committed. If the
            # on-disk package changed underfoot, abort BEFORE the cache write (nothing
            # is overwritten/rolled back).
            if hashlib.sha256(tmp_pkg.read_bytes()).hexdigest() != raw_bytes_before:
                raise HTTPException(status_code=409, detail="downloaded package changed during verification; aborting install")
            # Bytes are bound to the official endorsement -> commit to the cache.
            result = verify_plugin_package(
                tmp_pkg,
                public_key=public_key,
                cache_root=plugin_cache_root(),
                revocation_file=cloud_root() / "governance" / "revocations.json",
                cache=True,
                provenance="remote",
                install_entry="install-workshop",
                # Manifest backstop (mirrors the probe above): never commit a
                # skill_origin:true package to the plugin cache through this sink.
                reject_skill_origin=True,
            )
        except (PluginVerificationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        # AIRTIGHT post-commit bind: ``result.digest`` is computed from the SAME load
        # that was cached, so this proves the CACHED bytes equal the co-signed digest
        # (and identity). The pre-commit probe + raw-bytes guard already make this
        # unreachable in normal operation; it only fires if the temp package was
        # swapped DURING the commit's own read (an active same-user local race). On
        # mismatch, roll the just-written entry back and refuse — the cache never
        # retains bytes that aren't the officially-endorsed package.
        if (
            result.plugin_id != request.plugin_id
            or result.version != request.version
            or result.digest != cosigned_digest
        ):
            uninstall_cached_plugin(result.plugin_id, version=result.version, cache_root=plugin_cache_root())
            clear_catalog_cache()
            raise HTTPException(
                status_code=409,
                detail="package changed during install commit; rolled back (cached bytes did not match the co-signed entry)",
            )
        clear_catalog_cache()
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "version": result.version,
            "digest": result.digest,
            "installed": True,
            "source": "clawhunt_workshop",
            "artifact_ref": entry.get("artifact_ref"),
            "status": plugin_status_payload(),
            # Deprecation signal: this legacy Python-cache install is superseded by the neutral
            # Node S4 path. (Behaviour is unchanged; the field is additive.)
            "deprecated": True,
            "superseded_by": "/api/capabilities/install",
        }

    @app.post("/api/plugins/uninstall")
    def plugin_uninstall(request: PluginUninstallRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = uninstall_cached_plugin(
                request.plugin_id,
                version=request.version,
                cache_root=plugin_cache_root(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not result["removed"]:
            raise HTTPException(status_code=404, detail="plugin not installed")
        clear_catalog_cache()
        return {
            "ok": True,
            "plugin_id": request.plugin_id,
            "version": request.version,
            "removed": True,
            "removed_versions": result["versions"],
            "status": plugin_status_payload(),
        }

    @app.get("/api/plugins/skills/contract")
    def plugin_skills_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The shared skill-sync capability contract (runtime targets, operations)."""
        return build_skill_sync_contract()

    @app.get("/api/contracts/catalog")
    def catalog_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The shared catalog contract for API, Web, Desktop, and CLI projections."""
        return build_catalog_contract_payload()

    @app.get("/api/contracts/skill-build")
    def skill_build_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The shared `skill build` contract (endpoint, fields, provenance grades)."""
        return build_skill_build_contract()

    @app.get("/api/contracts/capability-upload")
    def capability_upload_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The shared local developer-upload contract (kinds, package contents,
        acceptance levels, source mode, excluded steps) for Web/Desktop/CLI."""
        return build_capability_upload_contract()

    @app.get("/api/contracts/run-ledger")
    def run_ledger_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The shared issue-run-ledger contract (normalized run-state vocabulary,
        per-status tone, active set) so surfaces render run state identically."""
        return build_run_ledger_contract()

    @app.get("/api/plugins/skills/projections")
    def plugin_skills_projections(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """List every tracked skill projection from the ledger."""
        records = load_projection_lock(default_projection_lock())
        return {
            "ok": True,
            "lock_path": str(default_projection_lock()),
            "records": [record.to_dict() for record in records.values()],
        }

    @app.post("/api/plugins/skills/sync")
    def plugin_skills_sync(request: PluginSkillSyncRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Project governed skills into native runtime dirs (same core as the CLI)."""
        try:
            result = sync_plugin_skills(
                plugin_id=request.plugin_id,
                targets=tuple(request.targets) if request.targets else None,
                public_key=os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
                force=request.force,
            )
        except (SkillSyncError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, **result.to_dict()}

    @app.post("/api/plugins/skills/unsync")
    def plugin_skills_unsync(request: PluginSkillUnsyncRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Reclaim a plugin's projected skills (delete, or tombstone on revoke)."""
        try:
            result = unsync_plugin_skills(
                plugin_id=request.plugin_id,
                revoked=request.revoked,
                force=request.force,
            )
        except (SkillSyncError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, **result.to_dict()}

    @app.get("/api/plugins/{plugin_id}/configuration")
    def plugin_configuration(plugin_id: str, version: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        manifest, resolved_version = cached_plugin_manifest(plugin_id, version=version)
        return {
            "plugin_id": plugin_id,
            "version": resolved_version,
            "name": manifest.get("name") or plugin_id,
            "runtime": manifest.get("runtime", {}),
            "configuration": plugin_configuration_status(plugin_id, manifest, plugin_version=resolved_version),
        }

    @app.post("/api/plugins/config/set")
    def plugin_config_set(request: PluginSettingRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            manifest, _resolved_version = cached_plugin_manifest(request.plugin_id, version=request.version)
            value = normalize_manifest_setting_value(manifest, request.name, request.value)
            result = set_plugin_setting(request.plugin_id, request.name, value)
        except (PluginConfigurationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "setting": result.name,
            "configured": True,
        }

    def _plugin_config_setting(plugin_id: str, version: str | None, setting_name: str) -> tuple[dict[str, Any], str]:
        manifest, resolved_version = cached_plugin_manifest(plugin_id, version=version)
        cfg = plugin_configuration_status(plugin_id, manifest, plugin_version=resolved_version)
        setting = next((s for s in cfg.get("settings", []) if s.get("name") == setting_name), None)
        if setting is None:
            raise HTTPException(status_code=404, detail=f"setting not declared by plugin: {setting_name}")
        return setting, resolved_version

    def _invoke_plugin_config_tool(plugin_id: str, version: str, invocation: dict[str, Any], extra_args: dict[str, Any], run_id: str) -> Any:
        args = {**(invocation.get("arguments") or {}), **(extra_args or {})}
        result = invoke_cached_plugin_tool(
            plugin_id,
            str(invocation["tool"]),
            args,
            version=version,
            run_id=run_id,
            artifact_dir=superclaw_data_path("artifacts", "plugins"),
        )
        if not getattr(result, "ok", False):
            detail = "plugin config tool failed"
            resp = getattr(result, "model_response", None)
            if isinstance(resp, dict):
                detail = str((resp.get("error") or {}).get("code") or resp.get("text") or detail)
            raise HTTPException(status_code=400, detail=detail)
        return getattr(result, "model_response", None)

    def _extract_config_options(response: Any) -> list[dict[str, Any]]:
        raw = response.get("options") if isinstance(response, dict) else response
        if not isinstance(raw, list):
            return []
        # Pass through optional structured fields so the config UI can render
        # distinct columns (e.g. profile name + account email) instead of one blob.
        passthrough = ("name", "email", "user_data_dir", "detail")
        options: list[dict[str, Any]] = []
        for item in raw:
            if isinstance(item, dict) and "value" in item:
                option = {"value": item["value"], "label": str(item.get("label") or item["value"])}
                for key in passthrough:
                    if item.get(key) is not None:
                        option[key] = item[key]
                options.append(option)
            elif isinstance(item, (str, int, float, bool)):
                options.append({"value": item, "label": str(item)})
        return options

    @app.post("/api/plugins/{plugin_id}/configuration/options")
    def plugin_config_options(plugin_id: str, request: PluginConfigInvokeRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Populate a setting's searchable select by calling its declared options_source tool (governed)."""
        try:
            setting, resolved_version = _plugin_config_setting(plugin_id, request.version, request.setting)
            source = setting.get("options_source")
            if not isinstance(source, dict) or not source.get("tool"):
                raise HTTPException(status_code=404, detail=f"setting has no options_source: {request.setting}")
            response = _invoke_plugin_config_tool(plugin_id, resolved_version, source, request.arguments, "plugin_config_options")
        except (PluginConfigurationError, PluginVerificationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "plugin_id": plugin_id, "setting": request.setting, "options": _extract_config_options(response)}

    @app.post("/api/plugins/{plugin_id}/configuration/action")
    def plugin_config_action(plugin_id: str, request: PluginConfigInvokeRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Run a setting's declared config action (e.g. bind/login profile) through the governed proxy."""
        try:
            setting, resolved_version = _plugin_config_setting(plugin_id, request.version, request.setting)
            actions = setting.get("actions") or []
            action = None
            for candidate in actions:
                if not isinstance(candidate, dict):
                    continue
                if request.action_id in (candidate.get("id"), candidate.get("tool")) or request.action_id is None:
                    action = candidate
                    break
            if action is None:
                raise HTTPException(status_code=404, detail=f"action not declared for setting {request.setting}: {request.action_id}")
            response = _invoke_plugin_config_tool(plugin_id, resolved_version, action, request.arguments, "plugin_config_action")
        except (PluginConfigurationError, PluginVerificationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "plugin_id": plugin_id, "setting": request.setting, "result": response}

    @app.post("/api/plugins/secret/set")
    def plugin_secret_set_api(request: PluginSecretSetRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            manifest, _resolved_version = cached_plugin_manifest(request.plugin_id, version=request.version)
            validate_manifest_secret_name(manifest, request.name)
            result = set_plugin_secret(request.plugin_id, request.name, request.value, version_range=request.version_range)
        except (PluginConfigurationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "secret": result.name,
            "configured": True,
            "version_range": result.version_range,
        }

    @app.post("/api/plugins/secret/delete")
    def plugin_secret_delete_api(request: PluginSecretDeleteRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            manifest, _resolved_version = cached_plugin_manifest(request.plugin_id, version=request.version)
            validate_manifest_secret_name(manifest, request.name)
            result = delete_plugin_secret(request.plugin_id, request.name)
        except (PluginConfigurationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "ok": True,
            "plugin_id": result.plugin_id,
            "secret": result.name,
            "configured": False,
            "deleted": result.deleted,
        }

    @app.get("/api/fusion/status")
    def api_fusion_status() -> dict[str, Any]:
        return fusion_status()

    @app.get("/api/fusion/capabilities")
    def api_fusion_capabilities(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return fusion_capability_catalog()

    @app.get("/api/fusion/audit")
    def api_fusion_audit(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return fusion_capability_audit()

    @app.post("/api/fusion/start")
    def api_fusion_start(request: FusionRunRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        payload = fusion_start_plan(request.profile, execute=request.execute)
        if payload.get("status") == "unknown_profile":
            raise HTTPException(status_code=400, detail="unknown fusion profile")
        return payload

    @app.post("/api/fusion/stop")
    def api_fusion_stop(request: FusionRunRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        payload = fusion_stop_plan(request.profile, execute=request.execute)
        if payload.get("status") == "unknown_profile":
            raise HTTPException(status_code=400, detail="unknown fusion profile")
        return payload

    @app.get("/api/fusion/run-status")
    def api_fusion_run_status(profile: str = "all", _: None = Depends(require_control_token)) -> dict[str, Any]:
        payload = fusion_run_status(profile)
        if payload.get("status") == "unknown_profile":
            raise HTTPException(status_code=400, detail="unknown fusion profile")
        return payload

    @app.post("/api/fusion/actions")
    def api_fusion_actions(request: FusionActionRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        evidence = None
        if request.run_id:
            try:
                evidence = store.get_evidence(request.run_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="run evidence not found") from exc
        try:
            result = record_fusion_action(
                component=request.component,
                action=request.action,
                tool_name=request.tool_name,
                payload=request.payload,
                artifact_refs=request.artifact_refs,
                human_gate_approved=request.human_gate_approved,
                permission_result=request.permission_result,
                run_id=request.run_id,
            )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"code": "FUSION_INVALID_ACTION", "detail": "invalid fusion action"},
                headers={"X-SuperClaw-Fusion-Code": "FUSION_INVALID_ACTION"},
            )
        except FusionPermissionError as exc:
            return JSONResponse(
                status_code=403,
                content={"code": "FUSION_HUMAN_GATE_REQUIRED", "detail": str(exc)},
                headers={"X-SuperClaw-Fusion-Code": "FUSION_HUMAN_GATE_REQUIRED"},
            )
        result["run_id"] = request.run_id
        result["evidence_attached"] = False
        if request.run_id and evidence is not None:
            artifact_id = str(result["artifact_id"])
            fusion_ref = f"superclaw-local://fusion/artifacts/{artifact_id}"
            artifact_record = load_fusion_artifact(artifact_id)
            evidence.add_artifact(
                ArtifactRef(
                    kind="fusion-action-json",
                    path=fusion_ref,
                    artifact_id=artifact_id,
                    sensitivity="internal",
                    metadata={
                        "component": artifact_record["component"],
                        "action": artifact_record["action"],
                        "tool_name": artifact_record["tool_name"],
                        "endpoint": f"/api/fusion/artifacts/{artifact_id}",
                    },
                )
            )
            store.save_evidence(evidence)
            store.add_event(
                request.run_id,
                "fusion.action.recorded",
                {
                    "artifact_id": artifact_id,
                    "component": artifact_record["component"],
                    "action": artifact_record["action"],
                    "tool_name": artifact_record["tool_name"],
                    "artifact_ref": fusion_ref,
                },
            )
            result["evidence_attached"] = True
        return result

    @app.get("/api/fusion/artifacts/{artifact_id}")
    def api_fusion_artifact(artifact_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return load_fusion_artifact(artifact_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="fusion artifact not found") from exc

    @app.post("/api/evals")
    def create_eval(request: EvalRunRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        eval_id = f"eval_{uuid.uuid4().hex[:12]}"
        if request.async_execution:
            thread = threading.Thread(target=run_eval_background, args=(eval_id, request), daemon=True)
            app.state.eval_threads[eval_id] = thread
            thread.start()
            return {"eval_id": eval_id, "status": "running", "case_id": request.case_id, "agent": request.agent}
        report = eval_runner.run_delivery_gap(
            agent=request.agent,
            case_id=request.case_id,
            output=eval_runner.root / eval_id,
            timeout_seconds=request.timeout_seconds,
            eval_id=eval_id,
        )
        return report

    @app.get("/api/evals")
    def list_evals(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"evals": eval_runner.list_reports()}

    @app.get("/api/evals/{eval_id}")
    def get_eval(eval_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return eval_runner.get_report(eval_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail="eval not found") from exc

    @app.get("/api/evals/{eval_id}/events")
    def get_eval_events(eval_id: str, _: None = Depends(require_control_token)) -> StreamingResponse:
        if not (eval_runner.root / eval_id).exists() and eval_id not in app.state.eval_threads:
            raise HTTPException(status_code=404, detail="eval events not found")

        def stream():
            emitted = 0
            while True:
                events = eval_runner.events(eval_id)
                for event in events[emitted:]:
                    yield f"event: {event['type']}\n"
                    yield f"data: {json.dumps(event['payload'], ensure_ascii=False)}\n\n"
                emitted = len(events)
                thread = app.state.eval_threads.get(eval_id)
                if (thread is None or not thread.is_alive()) and (eval_runner.root / eval_id / "report.json").exists():
                    break
                time.sleep(0.1)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/api/evals/{eval_id}/cancel")
    def cancel_eval(eval_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if not (eval_runner.root / eval_id).exists() and eval_id not in app.state.eval_threads:
            raise HTTPException(status_code=404, detail="eval not found")
        return eval_runner.cancel(eval_id)

    @app.get("/api/evals/{eval_id}/report")
    def get_eval_report(eval_id: str, _: None = Depends(require_control_token)) -> FileResponse:
        path = eval_runner.root / eval_id / "report.md"
        if not path.exists():
            raise HTTPException(status_code=404, detail="eval report not found")
        return FileResponse(path, media_type="text/markdown", filename=f"{eval_id}-report.md")

    @app.get("/api/evals/{eval_id}/report.pdf")
    def get_eval_report_pdf(eval_id: str, _: None = Depends(require_control_token)) -> FileResponse:
        try:
            path = eval_runner.report_pdf_path(eval_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail="eval report not found") from exc
        return FileResponse(path, media_type="application/pdf", filename=f"{eval_id}-technical-report.pdf")

    @app.get("/api/evals/{eval_id}/artifacts/{artifact_id}")
    def get_eval_artifact(eval_id: str, artifact_id: str, _: None = Depends(require_control_token)) -> FileResponse:
        try:
            path = eval_runner.artifact_path(eval_id, artifact_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail="eval artifact not found") from exc
        return FileResponse(path)

    @app.post("/api/harnesses/inventory")
    def harness_inventory(request: HarnessInventoryRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return inventory_plugins(request.source_root).to_dict()

    @app.post("/api/harnesses/emit")
    def harness_emit(request: HarnessEmitRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return emit_harness_artifacts(
            request.source_root,
            request.output_root,
            target=request.target,
            plugins=request.plugins,
        ).to_dict()

    @app.post("/api/harnesses/validate")
    def harness_validate(request: HarnessValidateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return validate_harness_artifacts(request.output_root, target=request.target).to_dict()

    @app.post("/a2a")
    def a2a(payload: dict[str, Any], _: None = Depends(require_control_token)) -> dict[str, Any]:
        text = payload.get("message") or payload.get("text") or json.dumps(payload, ensure_ascii=False)
        goal = store.create_goal(GoalSpec(title="A2A request", description=str(text), source="a2a"))
        return {"goal_id": goal.goal_id, "accepted": True}

    @app.post("/api/goals")
    def create_goal(request: GoalRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if request.clawhunt_problem:
            goal = GoalSpec.from_clawhunt_problem(request.clawhunt_problem)
        else:
            if not request.title or not request.description:
                raise HTTPException(status_code=422, detail="title and description are required")
            goal = GoalSpec(title=request.title, description=request.description)
        store.create_goal(goal)
        return {"goal_id": goal.goal_id, "goal": goal.to_dict()}

    def run_read_payload(run) -> dict[str, Any]:
        """Run dict extended with the liveness-backed view: surfaces decide
        "is it running" from is_live/effective_status, never the raw status."""
        payload = run.to_dict()
        state = effective_run_state(run)
        payload["effective_status"] = state["effective_status"]
        payload["liveness"] = state["liveness"]
        payload["is_live"] = state["is_live"]
        payload["stale_reason"] = state["stale_reason"]
        return payload

    def _budget_conflict_detail(payload: dict[str, Any]) -> dict[str, Any]:
        return {"code": "BUDGET_BLOCKED", "budget": payload}

    def _budget_gate_conflict(exc: BudgetGateError) -> HTTPException:
        return HTTPException(status_code=409, detail=_budget_conflict_detail(exc.preflight.to_dict()))

    def _raise_if_budget_blocked(session: Any) -> None:
        preflight = (getattr(session, "execution_context", {}) or {}).get("budget_preflight")
        if isinstance(preflight, dict) and preflight.get("allowed") is False:
            raise HTTPException(status_code=409, detail=_budget_conflict_detail(preflight))

    def _chat_scope_ids(chat_session: Any | None) -> dict[str, str | None]:
        workspace_id = str(getattr(chat_session, "workspace_id", "") or "") or None
        company_id = None
        if workspace_id:
            try:
                workspace = store.get_workspace_profile(workspace_id)
                company_id = workspace.company_profile_id
            except KeyError:
                company_id = None
        return {"workspace_id": workspace_id, "company_profile_id": company_id}

    def _latest_chat_message_id(session_id: str, *, role: str = "assistant") -> str | None:
        try:
            session = store.get_chat_session(session_id)
        except KeyError:
            return None
        for message in reversed(session.messages):
            if getattr(message, "role", None) == role:
                return getattr(message, "message_id", None)
        return None

    def _chat_turn_usage(result: dict[str, Any]) -> dict[str, int] | None:
        """The runtime's token tally for THIS turn, persisted on the assistant
        ChatMessage so the chat surface's metering row survives a reload and
        matches the live Display Protocol ``usage`` event (same provider-native
        keys are kept verbatim — e.g. claude's ``cache_read_input_tokens``).
        Returns None when the runtime reported no token usage (codex app-server,
        wall-clock-only turns) so the surface shows timing without a misleading
        all-zero token row."""
        usage = result.get("usage")
        if not isinstance(usage, dict):
            return None
        # Keep only finite, non-negative token counts: a malformed runtime payload
        # (nan/inf/negative) must NOT crash the turn — int(nan) raises and int(inf)
        # overflows, which would 500 the sync turn or land a successful reply as a
        # failed assistant. Bad fields are dropped, not persisted.
        kept = {
            key: int(value)
            for key, value in usage.items()
            if isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        }
        return kept or None

    def _turn_meter(result: dict[str, Any], duration_seconds: float) -> tuple[dict[str, int] | None, float | None]:
        """Per-turn metering passed to the assistant append: (token usage,
        wall-clock elapsed in ms). A completed turn always took a real (>=0) span,
        so report it clamped to >=0 — NOT ``duration > 0 else None``: time.monotonic()
        has ~15ms resolution on Windows, so a sub-tick turn measures as exactly 0.0
        and that guard would drop elapsed_ms to None (a real, fast turn is not
        "bogus"; 0ms is the honest value below clock resolution)."""
        usage = _chat_turn_usage(result)
        elapsed_ms = max(0, round(duration_seconds * 1000)) if duration_seconds is not None else None
        return usage, elapsed_ms

    def _chat_cost_snapshot(result: dict[str, Any], *, backend: str, duration_seconds: float) -> dict[str, Any]:
        raw_cost = result.get("cost")
        if isinstance(raw_cost, dict):
            snapshot = dict(raw_cost)
        else:
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            input_tokens = usage.get("input_tokens", usage.get("prompt_tokens"))
            output_tokens = usage.get("output_tokens", usage.get("completion_tokens"))
            has_tokens = input_tokens is not None or output_tokens is not None
            snapshot = {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cached_input_tokens": usage.get("cached_input_tokens", usage.get("cache_read_input_tokens")),
                "reasoning_tokens": usage.get("reasoning_tokens"),
                "raw_usage": usage or None,
                "meter_kind": "model_tokens" if has_tokens else "wall_clock",
                "usage_status": "actual" if has_tokens else "unavailable",
                "usage_source": "provider_response" if has_tokens else "local_timer",
            }
        snapshot.setdefault("backend", result.get("backend") or backend)
        snapshot.setdefault("provider", "openai" if snapshot["backend"] in CODEX_DIRECT_CHAT_BACKENDS else "unknown")
        snapshot.setdefault("duration_seconds", float(result.get("duration_seconds") or duration_seconds or 0.0))
        snapshot.setdefault("usage_status", "unavailable")
        snapshot.setdefault("usage_source", "local_timer")
        snapshot.setdefault("meter_kind", "wall_clock")
        return snapshot

    def _record_chat_cost_event(
        *,
        run_id: str,
        turn_id: str,
        result: dict[str, Any],
        backend: str,
        chat_session: Any | None = None,
        chat_message_id: str | None = None,
        status: str = "completed",
        model: str | None = None,
        duration_seconds: float = 0.0,
    ) -> None:
        try:
            snapshot = _chat_cost_snapshot(result, backend=backend, duration_seconds=duration_seconds)
            invocation = snapshot.get("invocation_id") or result.get("turn_id") or turn_id
            scope_ids = _chat_scope_ids(chat_session)
            event = CostEvent.from_snapshot(
                snapshot,
                idempotency_key=f"chat:{run_id}:{turn_id}:{snapshot.get('backend') or backend}:{invocation}",
                source="chat",
                run_id=run_id,
                chat_session_id=getattr(chat_session, "session_id", None),
                company_profile_id=scope_ids["company_profile_id"],
                workspace_id=scope_ids["workspace_id"],
                status=status,
            )
            event.chat_message_id = chat_message_id
            if not event.model and model:
                event.model = model
            store.record_cost_event(event)
        except Exception:
            # Cost recording is fail-open: a ledger hiccup must never break the
            # user's chat turn. But it must NOT be silent — a swallowed write is
            # lost billing/audit data, so surface it with full context for ops.
            _LOGGER.warning(
                "chat cost event not recorded (fail-open) run_id=%s turn_id=%s backend=%s",
                run_id,
                turn_id,
                backend,
                exc_info=True,
            )

    def chat_session_payload(chat_session, *, include_run_details: bool = False) -> dict[str, Any]:
        payload = chat_session.to_dict()
        message_run_ids = {
            str(message.run_id)
            for message in chat_session.messages
            if getattr(message, "run_id", None)
        }
        linked_run_sessions = []
        linked_runs = []
        for run in store.list_runs():
            if run.chat_session_id != chat_session.session_id and run.run_id not in message_run_ids:
                continue
            linked_run_sessions.append(run)
            run_payload = run_read_payload(run)
            if include_run_details:
                # Snapshot read (A2): structured events only (no *.delta), so a long
                # run's raw delta stream never bloats this detail response. Stamp the
                # durable SQLite id/id_source into each payload (matching the /events
                # and /events/snapshot wire shape) so the front-end reducer can anchor
                # cards and dedup history against the live SSE (DL5/T2).
                events = _snapshot_events_with_ids(store.list_events_snapshot(run.run_id))
                run_payload["event_count"] = len(events)
                run_payload["latest_event"] = events[-1] if events else None
                run_payload["events"] = events
                try:
                    evidence = store.get_evidence(run.run_id)
                    run_payload["evidence"] = evidence.to_dict()
                except KeyError:
                    run_payload["evidence"] = None
            linked_runs.append(run_payload)
        payload["run_ids"] = [run["run_id"] for run in linked_runs]
        payload["run_count"] = len(linked_runs)
        payload["runs"] = linked_runs
        payload["activity"] = chat_session_activity(chat_session, linked_run_sessions)
        return payload

    @app.get("/api/workspaces")
    def list_workspaces_surface(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """Chat-surface workspace inventory (sidebar groups + Inbox count).

        Ensures the built-in Chat workspace exists so the sidebar always has
        a home for pure chats.
        """
        workspace_resolver.ensure_chat_workspace(store)
        return build_workspace_inventory(store)

    @app.get("/api/chat/sessions")
    def list_chat_sessions(
        workspace: str | None = None,
        unassigned: bool = False,
        include_archived: bool = False,
        personal_only: bool = False,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        # ``include_archived`` defaults False so the sidebar hides archived
        # sessions; the surface passes True to render the "archived" view — the
        # retrieval path that keeps archiving reversible, not a one-way black hole
        # (workspace-sidebar-rework §4.6/§5).
        # ``personal_only`` scopes to the personal chat sidebar (unassigned +
        # company="local" sessions); company-workspace sessions stay in the Team
        # surface and must not leak into chat grouping (§4.2). Mutually exclusive
        # with an explicit workspace/unassigned filter.
        try:
            if personal_only:
                if workspace is not None or unassigned:
                    raise ValueError("personal_only is mutually exclusive with workspace/unassigned")
                sessions = store.list_personal_chat_sessions(include_archived=include_archived)
            else:
                sessions = store.list_chat_sessions(
                    workspace_id=workspace,
                    unassigned_only=unassigned,
                    include_archived=include_archived,
                )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"sessions": [chat_session_payload(session) for session in sessions]}

    @app.get("/api/chat/sessions/{session_id}")
    def get_chat_session(session_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return chat_session_payload(store.get_chat_session(session_id), include_run_details=True)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat session not found") from exc

    @app.post("/api/workspaces")
    def create_workspace_surface(
        request: CreateWorkspaceRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Create a PERSONAL (company="local") workspace from the sidebar.

        Folder mode (no attach_repo) builds a locked MANAGED scratch; attach_repo
        builds a REPO workspace and is fail-closed — the kernel rejects it unless
        trust_confirmed=True (workspace-sidebar-rework §4.3/§4.4). Surfaces never
        re-implement the gate; they call this one kernel entry.
        """
        try:
            workspace = workspace_resolver.create_personal_workspace(
                store,
                request.name,
                attach_repo=request.attach_repo,
                trust_confirmed=request.trust_confirmed,
                trust_source="api",
            )
        except ValueError as exc:
            # fail-closed trust gate / unsafe root → 422 (never a silent trust)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return workspace_projection(workspace, session_count=0)

    @app.patch("/api/workspaces/{workspace_id}")
    def rename_workspace_surface(
        workspace_id: str,
        request: RenameWorkspaceRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Rename a workspace's display name (the CLI twin: ``workspace rename``).

        The blank-name rule lives in the one kernel entry (rename_workspace) →
        422, so CLI/API/Web share a single validator. Repo path / trust / grouping
        are untouched."""
        try:
            workspace = store.rename_workspace(workspace_id, request.name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return workspace_projection(
            workspace, session_count=len(store.list_chat_sessions(workspace_id=workspace_id))
        )

    @app.post("/api/workspaces/{workspace_id}/pin")
    def pin_workspace_surface(
        workspace_id: str,
        request: PinWorkspaceRequest | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Pin (float to the sidebar's top zone) or unpin a workspace group.

        Body is optional — an empty POST pins. Cross-surface, presentation-only:
        trust, grouping, and the execution boundary are untouched."""
        pinned = request.pinned if request is not None else True
        try:
            workspace = store.set_workspace_pinned(workspace_id, pinned)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc
        return workspace_projection(
            workspace, session_count=len(store.list_chat_sessions(workspace_id=workspace_id))
        )

    @app.delete("/api/workspaces/{workspace_id}")
    def remove_workspace_surface(
        workspace_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Remove a workspace from the registry (the CLI twin: ``workspace
        remove``). The on-disk folder is NEVER deleted — this only unregisters the
        project. Its conversations are archived (recoverable via the archived
        view). The built-in Chat workspace can never be removed (→ 422)."""
        try:
            archived = store.remove_workspace(workspace_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"workspace_id": workspace_id, "removed": True, "archived_sessions": archived}

    @app.post("/api/chat/sessions/{session_id}/archive")
    def archive_chat_session(
        session_id: str,
        request: ArchiveSessionRequest | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Archive (hide from the default list) or unarchive a chat session.

        Body is optional — an empty POST archives (archived defaults True).
        Reversible and never destructive; the archived view is reachable via
        ``GET /api/chat/sessions?include_archived=true`` (§4.6)."""
        archived = request.archived if request is not None else True
        try:
            session = store.set_chat_session_archived(session_id, archived)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat session not found") from exc
        return chat_session_payload(session)

    @app.post("/api/chat/sessions/{session_id}/pin")
    def pin_chat_session(
        session_id: str,
        request: PinSessionRequest | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Pin (float to the sidebar's top zone) or unpin a chat session.

        Body is optional — an empty POST pins (pinned defaults True). Cross-surface
        and purely navigational: workspace membership, history, and the execution
        boundary are untouched, so unpinning returns the session to its group."""
        pinned = request.pinned if request is not None else True
        try:
            session = store.set_chat_session_pinned(session_id, pinned)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat session not found") from exc
        return chat_session_payload(session)

    @app.post("/api/chat/sessions/{session_id}/move")
    def move_chat_session(
        session_id: str,
        request: MoveSessionRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Move a chat session to another workspace (regroup).

        Fail-closed move guard (§4.5): if the move changes the execution boundary
        (the target resolves to a different directory than the session runs in
        now), the runtime resume state is reset — so the caller MUST acknowledge
        it (409 otherwise). On a confirmed boundary change the kernel drops the
        persisted resume handles AND this API process drops the in-process codex
        app-server session, so the next turn runs in the new dir, never the old.
        """
        try:
            store.get_chat_session(session_id)  # 404 fast on unknown session
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="chat session not found") from exc
        if request.workspace_id is not None:
            try:
                store.get_workspace_profile(request.workspace_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="unknown workspace") from exc
        boundary_changed = store.chat_move_changes_execution_boundary(session_id, request.workspace_id)
        if boundary_changed and not request.acknowledge_boundary_change:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "execution_boundary_change",
                    "execution_boundary_changed": True,
                    "message": (
                        "moving to a different execution boundary resets this chat's "
                        "runtime state; re-send with acknowledge_boundary_change=true"
                    ),
                },
            )
        session = store.set_chat_session_workspace(session_id, request.workspace_id)
        if boundary_changed:
            # live-process half of the resume guard: drop the cached codex
            # app-server session so it can't resume the old repo's cwd.
            _drop_chat_codex_session(session_id)
        payload = chat_session_payload(session)
        payload["execution_boundary_changed"] = boundary_changed
        return payload

    def resolve_chat_session(request: ChatTurnRequest):
        """Resolve the turn's workspace (fail-closed), then its chat session.

        The API is a non-interactive surface: an unknown or untrusted
        execution repo is 403 WORKSPACE_TRUST_REQUIRED — never a silently
        created workspace (ADR: docs/workspace-trust-container.md). A turn
        without a repo is a pure chat and lives (and executes) in the managed
        Chat workspace scratch home, mirroring the CLI's resolver semantics
        exactly (same kernel function, zero divergence).
        """
        try:
            resolution = workspace_resolver.resolve_workspace_for_chat(
                store, workspace_id=request.workspace_id, repo=request.repo_path
            )
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"unknown workspace: {request.workspace_id}"
            ) from exc
        if resolution.status == "trust_required":
            raise HTTPException(
                status_code=403,
                detail=f"{workspace_resolver.WORKSPACE_TRUST_REQUIRED}: {resolution.reason}",
            )
        workspace = resolution.workspace
        if request.session_id:
            try:
                chat_session = store.get_chat_session(request.session_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="chat session not found") from exc
            if (
                request.workspace_id is not None
                and chat_session.workspace_id != workspace.workspace_id
            ):
                # Explicit --workspace moves the session: pure regrouping,
                # history (runs/cost) keeps its execution-time stamps.
                chat_session = store.set_chat_session_workspace(
                    chat_session.session_id, workspace.workspace_id
                )
        elif request.continue_last and (
            _sessions := (
                store.list_chat_sessions()
                if request.all_sessions
                else store.list_chat_sessions(workspace_id=workspace.workspace_id)
            )
        ):
            chat_session = _sessions[0]
        else:
            chat_session = store.create_chat_session(
                request.message[:80] or "SuperClaw session", workspace_id=workspace.workspace_id
            )
        if request.repo_path is None:
            # Execution boundary follows the SESSION's own workspace, not the
            # repo-resolved default: a continued project session executes in ITS
            # project, never the managed Chat scratch (parity with the CLI). Re-run
            # the same trust gate so a quarantined/deleted binding fails closed; a
            # legacy session with no binding keeps the resolved default (Chat home).
            exec_workspace = workspace
            session_ws_id = getattr(chat_session, "workspace_id", None)
            if session_ws_id is not None and session_ws_id != workspace.workspace_id:
                try:
                    exec_resolution = workspace_resolver.resolve_workspace_for_chat(
                        store, workspace_id=session_ws_id, repo=None
                    )
                except KeyError as exc:
                    raise HTTPException(
                        status_code=404, detail=f"unknown workspace: {session_ws_id}"
                    ) from exc
                if exec_resolution.status == "trust_required":
                    raise HTTPException(
                        status_code=403,
                        detail=f"{workspace_resolver.WORKSPACE_TRUST_REQUIRED}: {exec_resolution.reason}",
                    )
                exec_workspace = exec_resolution.workspace
            request.repo_path = exec_workspace.repo_path
        return chat_session

    def _guard_chat_containment(chat_session, repo_path: str | None = None) -> None:
        """T11 fail-closed: a low-trust workspace permits ONLY governed, contained
        execution (the team/run path, which the orchestrator fences). An
        interactive chat turn — chat OR task intent — runs the runtime adapter
        directly with full tool access and is NOT contained, so it is refused in a
        low-trust workspace until the chat runtime gains native containment (PR-B).

        The fence is the STRICTER of the chat session's workspace AND the
        EXECUTION repo's workspace: a standard session pointed at a low-trust repo
        (or vice-versa) is still refused. Company-level floor is honoured by
        deriving the company from each workspace."""
        from superclaw.containment import get_preset, resolve_for_workspace

        candidates = []
        ws_id = getattr(chat_session, "workspace_id", None)
        if ws_id:
            candidates.append(resolve_for_workspace(store, ws_id))
        if repo_path:
            try:
                matched = workspace_resolver.find_workspace_for_path(store, repo_path)
            except Exception:
                # Cannot determine the repo's trust state — fail-closed: treat as
                # low-trust rather than silently allow an unknown into uncontained chat.
                matched = None
                candidates.append(get_preset("low_trust_review"))
            if matched is not None:
                candidates.append(resolve_for_workspace(store, matched.workspace_id))
        if candidates and max(candidates, key=lambda p: p.strictness).is_low_trust:
            raise HTTPException(
                status_code=403,
                detail=(
                    "containment 'low_trust_review': this workspace is fenced for untrusted "
                    "review; interactive chat turns run uncontained — run the work through the "
                    "governed team/run path or lift the workspace's containment_preset"
                ),
            )
        # Execution choke point for the direct/native chat path (which bypasses the
        # orchestrator's _execute_run gate): re-verify a real-folder project's
        # pinned directory inode before any backend uses repo_path as a cwd. Runs
        # here (before any streaming begins) at every chat entry, so a deleted or
        # symlink-swapped project directory is refused fail-closed, never executed.
        if repo_path:
            try:
                workspace_resolver.assert_execution_repo_safe(store, repo_path)
            except workspace_resolver.WorkspaceDirCompromised as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

    def resolve_turn_runtime(chat_session, request: ChatTurnRequest):
        """Resolve this turn's runtime via the kernel (request > sticky > default).
        Pure — call persist_turn_runtime() only for a turn that actually executes
        on the resolved backend."""
        return resolve_chat_runtime(
            chat_session.metadata,
            requested_backend=request.backend_policy,
            requested_model=request.model,
            requested_effort=request.effort,
            default_backend=configured_shell_backend() or "claude",
        )

    def persist_turn_runtime(chat_session, selection) -> None:
        """Record the chat's sticky runtime + the in-chat handoff marker.

        Only for turns that EXECUTE on the resolved backend. A plain chat turn
        streams over the direct-chat backend (codex) today; a runtime that did
        not execute must never be recorded as the chat's sticky runtime —
        sticky means "what this chat runs on", not "what was clicked".
        """
        if selection.backend_switched and selection.handoff_note:
            store.append_chat_message(chat_session.session_id, "system", selection.handoff_note)
        store.set_chat_runtime(
            chat_session.session_id, backend=selection.backend, model=selection.model, effort=selection.effort
        )

    def delivery_goal_from_chat(
        chat_session,
        request: ChatTurnRequest,
        intent: str,
        *,
        context_refs: list[dict[str, Any]],
        selected_context_text: str,
    ) -> GoalSpec:
        context_messages = _chat_context_messages(chat_session)
        return GoalSpec(
            title=chat_session.title,
            description=_delivery_description_from_chat(
                request_message=request.message,
                context_messages=context_messages,
                selected_context_text=selected_context_text,
            ),
            metadata={
                "chat_session_id": chat_session.session_id,
                "chat_turn_mode": request.mode,
                "chat_turn_intent": intent,
                "chat_context_message_count": len(context_messages),
                "chat_context_messages": context_messages,
                "chat_context_ref_count": len(context_refs),
                "chat_context_refs": context_refs,
            },
        )

    def _run_profile_for_intent(intent: str, request: ChatTurnRequest) -> tuple[str, list[WorkerRole] | None, bool]:
        """Map a routed intent to (verification_policy, worker roles, dry_run).

        'delivery' (opt-in via @delivery) -> heavy verifiable pipeline: the
        requested policy (adversarial) + full EXPLORE→…→REVIEW role set, and it
        honors the caller's dry-run preference (preview a delivery safely).
        'task' (e.g. @plugin) -> light single-turn agentic run with trust
        verification, so everyday plugin/research tasks are not held to
        delivery-grade evidence requirements (which would false-fail them).
        A task ALWAYS runs live: dry-run only plans and never executes the
        agent/plugin, so a dry-run plugin call would silently do nothing.
        """
        if intent == "delivery":
            return request.verification_policy, None, request.dry_run
        return "trust", [WorkerRole.IMPLEMENT], False

    @app.post("/api/chat/turn")
    def chat_turn_unified(request: ChatTurnRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        chat_session = resolve_chat_session(request)
        # The session's boundary AT TURN START — captured immediately after resolve,
        # BEFORE any append/guard DB op, so a concurrent move landing mid-turn is
        # always detected by the resume-pin guards (§4.5). Re-reading it later would
        # reopen the very race the guard closes (Codex r9).
        turn_start_workspace_id = chat_session.workspace_id
        _guard_chat_containment(chat_session, request.repo_path)
        runtime = resolve_turn_runtime(chat_session, request)
        context_refs = _chat_context_ref_dicts(request.context_refs)
        intent = classify_intent(request.message, mode=request.mode)
        intent, active_plugin_id, _sticky_plugin_context = _resolve_chat_effective_intent(
            store,
            session_id=chat_session.session_id,
            message=request.message,
            mode=request.mode,
            base_intent=intent,
            context_refs=context_refs,
        )
        # A skill-only overlay turn (@skill with no @plugin) is routed INLINE below
        # (with skill_ids) rather than to the orchestrator, so the skill is actually
        # applied fail-closed instead of silently dropped. It is an overlay turn only
        # in AUTO mode (classify_intent projects an overlay → "task"); an explicit
        # mode=chat/delivery makes intent ignore the overlay, so @skill would be
        # silently dropped — refuse that contradiction instead (consistent with the
        # streaming endpoint). (active_plugin_id None → not a sticky-plugin turn.)
        _chat_plan = parse_chat_route(request.message, mode=request.mode)
        # This endpoint APPLIES @skill only as a STANDALONE overlay in auto mode (no
        # @plugin) — routed inline below with skill_ids. Any other shape that carries
        # @skill (a forced mode, or @plugin+@skill, which this endpoint cannot compose)
        # would silently DROP the skill on the delivery/orchestrator path, so refuse it
        # fail-closed instead. (@plugin+@skill composition is a streaming-endpoint
        # capability — /api/chat/stream.) Note: in a session with a STICKY plugin, an
        # explicit @skill turn is treated as skill-only (the explicit overlay wins for
        # this turn, the sticky plugin resumes next turn) — same as the streaming path's
        # skill-only branch; the user's explicit @skill is applied, never dropped.
        skill_only_turn = (
            bool(_chat_plan.skill_ids)
            and not _chat_plan.plugin_ids
            and active_plugin_id is None
            and intent == "task"
        )
        overlay_skill_ids = tuple(_chat_plan.skill_ids) if skill_only_turn else ()
        if _chat_plan.skill_ids and not skill_only_turn:
            return {
                "session_id": chat_session.session_id,
                "run_id": None,
                "status": "failed",
                "failure_reason": (
                    "SKILL_OVERLAY_UNSUPPORTED: this endpoint applies @skill only as a "
                    f"standalone overlay in auto mode; a forced mode ({request.mode}) or an "
                    "@plugin+@skill turn drops it — drop the mode/@plugin or use /api/chat/stream"
                ),
            }
        # A plain chat turn executes on the chat's resolved runtime (selector >
        # sticky > default) unless the request pins an explicit override; tasks
        # and deliveries always run the resolved backend. Sticky only persists
        # for a turn that actually executes on the resolved backend.
        direct_backend = request.direct_chat_backend or runtime.backend or "codex"
        runtime_is_executed = intent != "chat" or runtime.backend == direct_backend
        # task/delivery always execute the resolved backend (orchestrator), so
        # persist now. A plain chat turn persists ONLY after it actually answers
        # on the resolved backend (below) — a failed/unavailable backend must not
        # become the chat's sticky runtime.
        # A skill-only turn runs INLINE on the chat path below (not the orchestrator),
        # so it persists sticky ONLY after it actually answers — like a plain chat turn,
        # not up front like a task/delivery (a refused/unavailable skill must not become
        # the chat's sticky runtime).
        if intent != "chat" and not skill_only_turn and runtime_is_executed:
            persist_turn_runtime(chat_session, runtime)
        chat_session = store.append_chat_message(chat_session.session_id, "user", request.message, context_refs=context_refs)
        chat_turn_id = chat_session.messages[-1].message_id if chat_session.messages else _id("msg")
        chat_turn_run_id = _id("run")  # INTERNAL cost-ledger id only — never exposed as outbound run_id (see _CHAT_RUN_HANDLE_CONTRACT)
        selected_context_text = _merge_selected_context(
            _resolve_chat_context_refs(store, context_refs),
            _resolve_chat_attachments(request.repo_path, chat_session.session_id, request.attachments),
        )
        if intent == "chat" and direct_backend in NATIVE_SESSION_CHAT_BACKENDS:
            # NATIVE runtime session — same binding the streaming endpoint uses
            # (one SuperClaw chat = one native runtime session), minus the deltas.
            # Dispatch by backend to its executor; claude and clawwork share the
            # binding/turn_plan/move-guard lifecycle but drive different runtimes.
            native_executor = _native_chat_executor(direct_backend)

            native_lock = _chat_native_lock(chat_session.session_id)
            with native_lock:
                turn_plan = _prepare_native_chat_turn(
                    session_id=chat_session.session_id,
                    backend=direct_backend,
                    repo_path=request.repo_path,
                    permission_preset=request.permission_preset,
                    strict_resume=request.strict_resume,
                    prior_messages=chat_session.messages[:-1],
                    turn_start_workspace_id=turn_start_workspace_id,
                )
                started_at = time.monotonic()
                native_kwargs = dict(
                    content=request.message,
                    repo=Path(request.repo_path),
                    budget_seconds=request.budget_seconds,
                    model=runtime.model if runtime.backend == direct_backend else None,
                    effort=runtime.effort if runtime.backend == direct_backend else None,
                    permission_mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
                    native_session_id=turn_plan["native_id"],
                    is_resume=turn_plan["is_resume"],
                    history_seed=turn_plan["seed"],
                    catch_up=turn_plan["catch_up"],
                    context_text=selected_context_text,
                )
                if direct_backend == "clawwork":
                    # clawwork's durable session dir is keyed on the SuperClaw chat id;
                    # expect_resume (strict file-must-exist) is distinct from is_resume so
                    # a reused PENDING binding isn't hard-failed before its creator lands.
                    native_kwargs["chat_session_id"] = chat_session.session_id
                    native_kwargs["expect_resume"] = turn_plan["expect_resume"]
                result = native_executor(**native_kwargs)
                duration_seconds = time.monotonic() - started_at
                if result.get("status") == "completed":
                    if runtime_is_executed:
                        persist_turn_runtime(chat_session, runtime)
                    _native_usage, _native_elapsed_ms = _turn_meter(result, duration_seconds)
                    _complete_native_chat_turn(
                        chat_session.session_id, direct_backend, turn_plan["native_id"], turn_plan["repo_now"],
                        str(result.get("response") or "").strip(),
                        expected_workspace_id=turn_plan["start_workspace_id"],
                        usage=_native_usage, elapsed_ms=_native_elapsed_ms,
                    )
                    chat_message_id = _latest_chat_message_id(chat_session.session_id)
                else:
                    if result.get("retire_native_session"):
                        store.drop_chat_native_session_id(chat_session.session_id, direct_backend)
                    friendly = _record_chat_failure(chat_session.session_id, direct_backend, result.get("failure_reason"))
                    result = {**result, "failure_reason": friendly}
                    chat_message_id = _latest_chat_message_id(chat_session.session_id)
                _record_chat_cost_event(
                    run_id=chat_turn_run_id,
                    turn_id=chat_turn_id,
                    result=result,
                    backend=direct_backend,
                    chat_session=chat_session,
                    chat_message_id=chat_message_id,
                    status="completed" if result.get("status") == "completed" else "failed",
                    model=runtime.model if runtime.backend == direct_backend else None,
                    duration_seconds=duration_seconds,
                )
            return {
                "session_id": chat_session.session_id,
                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                "turn_id": chat_turn_id,
                **{k: v for k, v in result.items() if k != "retire_native_session"},
            }
        # A skill-only overlay turn (@skill, no @plugin) runs INLINE on the resolved
        # backend through the kernel choke (same as the streaming path treats it), not
        # the orchestrator — so the skill prose is actually applied (fail-closed via
        # _execute_direct_chat_turn) instead of silently dropped on the task→orchestrator
        # path. Threaded as skill_ids so it rides the prompt-driven backend's overlay.
        if intent == "chat" or skill_only_turn:
            # Feed prior turns so direct chat has conversation memory. chat_session
            # now ends with the just-appended user message, so exclude it; cap the
            # window to bound prompt size (non-thread backends resend the full prompt).
            history_text = _format_chat_history(chat_session.messages[:-1])
            started_at = time.monotonic()
            result = _execute_direct_chat_turn(
                content=request.message,
                backend=direct_backend,
                repo=Path(request.repo_path),
                budget_seconds=request.budget_seconds,
                context_text=selected_context_text,
                history=history_text,
                # The chat's model selection only applies when the turn executes
                # on the resolved backend — model ids are not portable, so an
                # explicit direct_chat_backend override never inherits it.
                model=runtime.model if runtime.backend == direct_backend else None,
                effort=runtime.effort if runtime.backend == direct_backend else None,
                # Native runtime turn: the user's ask/allow preset passes
                # through to the runtime's own sandbox mapping.
                permission_mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
                # Inode-pinned real-folder project → the backend must not re-create
                # a deleted/swapped cwd (already validated upstream by the guard).
                protected_cwd=workspace_resolver.is_protected_project_repo(store, request.repo_path),
                # @skill overlays (skill-only turn): the kernel resolves them
                # fail-closed and inlines the prose; empty for a plain chat turn.
                skill_ids=overlay_skill_ids,
            )
            duration_seconds = time.monotonic() - started_at
            # A turn SUCCEEDS only if it completed AND produced a reply. A
            # "completed" status with an empty response is treated as a failure
            # end-to-end: no sticky-runtime advance, status=failed to the client,
            # and a status=failed assistant persisted (no blank bubble on reload).
            failure_reason = result.get("failure_reason")
            final = str(result.get("response") or "").strip()
            succeeded = result.get("status") == "completed" and bool(final)
            if runtime_is_executed and succeeded:
                persist_turn_runtime(chat_session, runtime)
            if succeeded:
                _generic_usage, _generic_elapsed_ms = _turn_meter(result, duration_seconds)
                updated_session = store.append_chat_message(
                    chat_session.session_id, "assistant", final, usage=_generic_usage, elapsed_ms=_generic_elapsed_ms
                )
                chat_message_id = updated_session.messages[-1].message_id if updated_session.messages else None
            else:
                failure_reason = _record_chat_failure(
                    chat_session.session_id, direct_backend, failure_reason or "backend returned no reply"
                )
                chat_message_id = _latest_chat_message_id(chat_session.session_id)
            _record_chat_cost_event(
                run_id=chat_turn_run_id,
                turn_id=chat_turn_id,
                result=result,
                backend=direct_backend,
                chat_session=chat_session,
                chat_message_id=chat_message_id,
                status="completed" if succeeded else "failed",
                model=runtime.model if runtime.backend == direct_backend else None,
                duration_seconds=duration_seconds,
            )
            return {
                "intent": "chat",
                "session_id": chat_session.session_id,
                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                "turn_id": chat_turn_id,
                "status": "completed" if succeeded else "failed",
                "backend": result.get("backend", direct_backend),
                "response": result.get("response") if succeeded else None,
                "failure_reason": failure_reason,
                # Real tool cards from an api-agent turn (gemini/anthropic): the
                # sync endpoint hands them back so execution is never silent.
                "display_events": result.get("display_events") or [],
            }

        policy = PermissionPolicy.from_values(
            mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
            allowed_tools=request.allowed_tools,
            disallowed_tools=request.disallowed_tools,
            mcp_configs=request.mcp_configs,
            plugin_dirs=request.plugin_dirs,
            session_id=chat_session.session_id,
        )
        goal = store.create_goal(
            delivery_goal_from_chat(
                chat_session,
                request,
                intent,
                context_refs=context_refs,
                selected_context_text=selected_context_text,
            )
        )
        run_verification, run_roles, run_dry_run = _run_profile_for_intent(intent, request)
        # HOME the run's operator scope to the @-selected company (if any) so
        # issue_create / agent_hire land in THAT company, not the default `local`
        # home. None when no company was selected — additive, never clobbers.
        selected_company_id = _chat_selected_company_id(store, context_refs)
        session = orchestrator.start_existing_goal(
            goal,
            dry_run=run_dry_run,
            backend_policy=runtime.backend,
            model=runtime.model,
            effort=runtime.effort,
            harness_policy=request.harness_policy,
            concurrency=1,
            repo_path=request.repo_path,
            budget_seconds=request.budget_seconds,
            artifact_dir=request.artifact_dir,
            verification_policy=run_verification,
            task_topology=request.task_topology,
            permission_policy=policy if policy != PermissionPolicy() else None,
            chat_session_id=chat_session.session_id,
            roles=run_roles,
            execution_context_extra=(
                {"company_profile_id": selected_company_id} if selected_company_id else None
            ),
        )
        verdict = "CONTROL_PLANE_READY"
        try:
            verdict = store.get_evidence(session.run_id).chain_verdict.value
        except KeyError:
            pass
        store.append_chat_message(
            chat_session.session_id,
            "assistant",
            f"run_id={session.run_id} status={session.status} chain_verdict={verdict}",
            run_id=session.run_id,
        )
        return {
            "intent": intent,
            "session_id": chat_session.session_id,
            "run_id": session.run_id,
            "status": session.status,
            "chain_verdict": verdict,
            "events_url": f"/api/runs/{session.run_id}/events",
        }

    def _prepare_native_chat_turn(
        *,
        session_id: str,
        backend: str,
        repo_path: str,
        permission_preset: str | None,
        strict_resume: bool,
        prior_messages: list[Any],
        turn_start_workspace_id: Any,
    ) -> dict[str, Any]:
        """Resolve the native-session binding for this turn (under the chat's
        native lock): capability guard (G2), repo-change retirement (G5),
        pending bind before execution (B1), and the cross-runtime catch-up /
        seed blocks (G1, plumbing filtered per B2)."""
        from superclaw.chat_turn import build_catch_up_block, format_chat_history as _fmt, unseen_messages_since

        # Capability-surface resume guard — same semantics the codex inline
        # channel applies: a WIDENED permission posture hard-blocks the native
        # session so the runtime's remembered world-view resets (the catch-up
        # seed restores conversational context without the stale frame).
        try:
            live_surface = current_capability_surface(
                permission_mode=(permission_preset or ""), backend=backend, model=""
            )
            stored_surface = store.get_chat_capability_surface(session_id)
            if stored_surface:
                surface_diffs = classify_surface_diff(CapabilitySurface.from_dict(stored_surface), live_surface)
                if resolve_resume_action(surface_diffs, strict=strict_resume) is SurfaceDiffAction.HARD_BLOCK:
                    store.drop_chat_native_session_id(session_id, backend)
            store.set_chat_capability_surface(session_id, live_surface.to_dict())
        except Exception:
            # Fail-CLOSED by retirement (Tier 2 design): a guard error must not let a
            # native session resume with a possibly-stale/over-privileged world-view.
            # Drop the binding so this turn full-seeds a fresh session instead of
            # blocking the turn (no 500) — the catch-up seed restores context safely.
            try:
                store.drop_chat_native_session_id(session_id, backend)
            except Exception:
                pass

        repo_now = str(Path(repo_path).resolve())
        # turn_start_workspace_id is captured by the caller right after
        # resolve_chat_session (the true turn start). The write-back pins below are
        # skipped if a concurrent move changes the boundary — including a move to the
        # Inbox (grouped→unassigned), §4.5 fail-closed. (Re-reading workspace_id HERE
        # would sit after append/guard DB ops and reopen the race — Codex r9.)
        start_workspace_id = turn_start_workspace_id
        binding = store.get_chat_native_session(session_id, backend)
        if binding and binding.get("repo_path") and binding["repo_path"] != repo_now:
            # Native sessions are per-workspace: a repo switch retires the
            # binding and rebuilds with a full context seed (G5).
            store.drop_chat_native_session_id(session_id, backend)
            binding = None
        # ClawWork native sessions are a plaintext file on disk; a binding can outlive
        # its file (dir cleared / never persisted / a same-id race left it ambiguous).
        # Unlike claude's --resume (fails loudly when gone), clawwork's --session-id
        # SILENTLY starts an empty session, so a believed-resume would inject only
        # catch-up and lose all prior context (canary-confirmed). Header-verify on disk
        # (id + cwd + uniqueness) before trusting the binding; anything but a unique
        # match retires it so the turn full-seeds a fresh session (Tier 2 design A).
        #
        # ONLY pre-flight a binding whose prior turn actually COMPLETED — i.e. one that
        # advanced ``last_seen_message_id``, which means ClawWork persisted a session
        # file. A pending bind written by an in-flight first turn (no last_seen yet, file
        # not created until that turn's spawn) MUST NOT be treated as "lost": doing so
        # lets a concurrent turn drop it and fork a second session, breaking the
        # "pending bind before execution" reuse semantic (review blocker). The backend's
        # under-lock re-verify still fails closed if a real resume's file vanished.
        if binding and backend == "clawwork" and binding.get("last_seen_message_id"):
            from superclaw.clawwork_session import is_resumable_native_session, native_session_dir

            session_dir = native_session_dir(session_id, backend=backend, create=False)
            if not is_resumable_native_session(session_dir, binding["id"], expected_repo=repo_now):
                store.drop_chat_native_session_id(session_id, backend)
                binding = None
        native_id = binding["id"] if binding else str(uuid.uuid4())
        is_resume = binding is not None
        # expect_resume is the STRICT "a prior turn COMPLETED, so the durable session
        # file MUST already exist" signal (binding advanced last_seen). It is distinct
        # from is_resume: a PENDING binding (written by an in-flight first turn, no
        # last_seen yet) is reused by a concurrent turn but its file may not exist yet,
        # so the backend must NOT hard-fail (CLAWWORK_NATIVE_SESSION_LOST) on it — both
        # turns attach to the same id via --session-id create-if-missing under the file
        # lock (first creates, the rest open). Only a TRUE resume enforces file presence.
        expect_resume = bool(binding and binding.get("last_seen_message_id"))
        seed = "" if is_resume else _fmt(unseen_messages_since(prior_messages, None))
        catch_up = build_catch_up_block(prior_messages, binding.get("last_seen_message_id")) if binding else ""
        # Pending bind BEFORE execution: a concurrent turn arriving mid-stream
        # must reuse this native session, not fork a second one (B1).
        # expected_repo/expected_workspace_id=turn-start boundary: if a move landed
        # between resolve and this pending bind, don't write a binding pinned to the
        # old boundary (§4.5 fail-closed; covers move-to-Inbox too).
        store.set_chat_native_session(
            session_id, backend, native_id, repo_path=repo_now,
            expected_repo=repo_now, expected_workspace_id=start_workspace_id,
        )
        return {
            "native_id": native_id, "is_resume": is_resume, "expect_resume": expect_resume,
            "seed": seed, "catch_up": catch_up, "repo_now": repo_now,
            "start_workspace_id": start_workspace_id,
        }

    def _complete_native_chat_turn(
        session_id: str, backend: str, native_id: str, repo_now: str, final_text: str,
        *, expected_workspace_id: Any,
        usage: dict[str, int] | None = None, elapsed_ms: float | None = None,
    ) -> None:
        """Persist the reply and advance the binding's last-seen watermark to
        the just-appended assistant message (the runtime has now seen the whole
        transcript up to here)."""
        last_seen = None
        if final_text:
            updated = store.append_chat_message(session_id, "assistant", final_text, usage=usage, elapsed_ms=elapsed_ms)
            last_seen = updated.messages[-1].message_id if updated.messages else None
        # expected_repo/expected_workspace_id = the turn-start boundary: fail-closed
        # move guard — if a concurrent move changed the session's boundary mid-turn
        # (incl. a move to the Inbox), skip pinning a binding to the old boundary
        # (§4.5; symmetric with the codex resume guard).
        store.set_chat_native_session(
            session_id, backend, native_id,
            last_seen_message_id=last_seen, repo_path=repo_now,
            expected_repo=repo_now, expected_workspace_id=expected_workspace_id,
        )

    def _record_chat_failure(session_id: str, backend: str, failure_reason: str | None) -> str:
        """Persist a failed chat turn as a status=failed assistant message and
        return the user-friendly reason. Single point so EVERY chat entry
        (native/generic, /turn and /stream, codex inline) recovers the same way:
        a reload still shows WHY it failed (with a login hint for auth), and the
        failed row is excluded from runtime history/catch-up. Best-effort: a
        store hiccup never masks the original failure surfaced over SSE."""
        friendly = friendly_chat_failure(failure_reason, backend)
        try:
            store.append_chat_message(session_id, "assistant", friendly, status="failed")
        except Exception:
            pass
        return friendly

    def _run_legacy_delivery_turn(
        request: ChatTurnRequest,
        *,
        chat_session: Any,
        session_id: str,
        context_refs: list[dict[str, Any]],
        selected_context_text: str,
        runtime: Any,
    ) -> StreamingResponse:
        """DEPRECATED legacy delivery path (unified-task-entry).

        Isolated from the unified runtime entry: it starts the heavy verifiable
        orchestrator run and returns a single passthrough SSE event so the client
        switches to the run cockpit, plus a deprecation notice. To be replaced by
        an Agent company (``company_runtime``); do not extend this — extend the
        runtime turn path instead.
        """
        policy = PermissionPolicy.from_values(
            mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
            allowed_tools=request.allowed_tools,
            disallowed_tools=request.disallowed_tools,
            mcp_configs=request.mcp_configs,
            plugin_dirs=request.plugin_dirs,
            session_id=session_id,
        )
        goal = store.create_goal(
            delivery_goal_from_chat(chat_session, request, "delivery", context_refs=context_refs, selected_context_text=selected_context_text)
        )
        run_verification, run_roles, run_dry_run = _run_profile_for_intent("delivery", request)
        # HOME the orchestrator run to the @-selected company (streaming path parity
        # with the sync /api/chat/turn handler) so issue_create / agent_hire land in
        # THAT company, not the default `local` home. None when no company selected.
        selected_company_id = _chat_selected_company_id(store, context_refs)
        session = orchestrator.start_existing_goal(
            goal,
            dry_run=run_dry_run,
            backend_policy=runtime.backend,
            model=runtime.model,
            effort=runtime.effort,
            harness_policy=request.harness_policy,
            concurrency=1,
            repo_path=request.repo_path,
            budget_seconds=request.budget_seconds,
            artifact_dir=request.artifact_dir,
            verification_policy=run_verification,
            task_topology=request.task_topology,
            permission_policy=policy if policy != PermissionPolicy() else None,
            chat_session_id=session_id,
            roles=run_roles,
            execution_context_extra=(
                {"company_profile_id": selected_company_id} if selected_company_id else None
            ),
        )
        verdict = "CONTROL_PLANE_READY"
        try:
            verdict = store.get_evidence(session.run_id).chain_verdict.value
        except KeyError:
            pass
        store.append_chat_message(session_id, "assistant", f"run_id={session.run_id} status={session.status} chain_verdict={verdict}", run_id=session.run_id)

        def gen_delivery():
            yield _sse_event(
                "delivery.deprecated",
                {"replacement": "runtime_turn", "future": "agent_company", "session_id": session_id, "run_id": session.run_id},
            )
            yield _sse_event(
                "delivery",
                {"intent": "delivery", "session_id": session_id, "run_id": session.run_id, "status": session.status, "chain_verdict": verdict, "events_url": f"/api/runs/{session.run_id}/events", "deprecated": True},
            )

        return StreamingResponse(gen_delivery(), media_type="text/event-stream")

    @app.post("/api/chat/stream")
    def chat_stream(request: ChatTurnRequest, _: None = Depends(require_control_token)) -> StreamingResponse:
        """Streaming chat: direct chat streams codex deltas over a persistent codex
        app-server thread (native memory); delivery intent emits one passthrough
        event so the client switches to the run cockpit."""
        chat_session = resolve_chat_session(request)
        # Boundary AT TURN START — captured right after resolve, before any append/
        # guard DB op, so a concurrent move is always detected by the codex/native
        # resume-pin guards (§4.5). Used for BOTH the codex pin and native prepare;
        # re-reading it later would reopen the race the guard closes (Codex r9).
        turn_start_workspace_id = chat_session.workspace_id
        _guard_chat_containment(chat_session, request.repo_path)
        runtime = resolve_turn_runtime(chat_session, request)
        context_refs = _chat_context_ref_dicts(request.context_refs)
        # Unified entry: parse the turn once into a route plan (one runtime turn +
        # overlays). `intent` is the legacy projection of the same plan; "task"
        # means "overlay turn", NOT "plugin turn" — use plan.plugin_ids /
        # plan.skill_ids (and the sticky active_plugin_id) for the distinction.
        plan = parse_chat_route(request.message, mode=request.mode)
        intent = classify_intent(request.message, mode=request.mode)
        session_id = chat_session.session_id
        intent, active_plugin_id, sticky_plugin_context = _resolve_chat_effective_intent(
            store,
            session_id=session_id,
            message=request.message,
            mode=request.mode,
            base_intent=intent,
            context_refs=context_refs,
        )
        # Conversational create on the codex-session path (A3b): on a pure-chat
        # turn (not an @plugin/@skill task) the short directive is injected and the
        # reply harvested. Intent is the runtime LLM's call (it emits a proposal
        # only when it understands the user wants a skill) — NOT a keyword gate.
        from superclaw.chat_turn import _skill_create_enabled

        skill_create_turn = intent != "task" and _skill_create_enabled()
        # delivery runs on the resolved backend; a plain chat turn now executes
        # on the resolved backend too (codex family streams over the app-server
        # thread, every other backend answers over its kernel run() channel).
        # Inline @plugin tasks still stream over the codex app-server (the only
        # runtime with MCP plugin projection), so they only persist sticky when
        # the selection actually IS the codex family.
        # An EXPLICIT runtime_id outranks the sticky runtime and must be a known
        # backend — an unknown id fails closed BEFORE any channel dispatch (it
        # must never silently fall through to the sticky/generic path). Adapter
        # ids (e.g. "claude-cli") normalize onto their backend names.
        explicit_runtime_id = (request.runtime_id or "").strip()
        def _fail_stream(reason: str) -> StreamingResponse:
            def gen_failed():
                yield _sse_event(
                    "chat.completed",
                    {"intent": intent, "session_id": session_id, "status": "failed", "failure_reason": reason},
                )
            return StreamingResponse(gen_failed(), media_type="text/event-stream")

        if explicit_runtime_id:
            explicit_runtime_id = _RUNTIME_ID_ALIASES.get(explicit_runtime_id, explicit_runtime_id)

            if explicit_runtime_id not in default_backends():
                return _fail_stream(f"unknown runtime_id: {explicit_runtime_id!r}")
            if intent == "task" and explicit_runtime_id not in CODEX_DIRECT_CHAT_BACKENDS:
                # Plugin/skill overlays project over the MCP bridge, which only
                # the codex app-server runtime carries today. Refuse honestly
                # instead of silently running the overlay-less prompt.
                return _fail_stream(
                    f"RUNTIME_CAPABILITY_UNSUPPORTED: runtime {explicit_runtime_id} cannot run plugin/skill "
                    f"overlays (no MCP bridge); use codex-app-server for overlay turns"
                )
        # Fail-closed @skill pre-flight (kernel choke): a turn that addressed
        # @skill:x must REFUSE up front when x is unknown / too-large / unreadable —
        # not run with a "could not load x" note the model may ignore (the legacy
        # _skill_overlay_lines is fail-open). Tool-skills stay on the existing MCP
        # path (mcp_backend admits them; their real availability is the mcp_projected
        # check downstream), so this only hard-stops the unambiguous unavailable cases.
        if plan.skill_ids:
            # @skill is only APPLIED on the overlay path (intent=="task", auto mode).
            # An EXPLICIT mode=chat/delivery makes classify_intent ignore the overlay,
            # so the skill would be silently dropped — refuse that contradiction up
            # front rather than running without the skill (no silent no-op).
            if intent != "task":
                return _fail_stream(
                    f"SKILL_OVERLAY_UNSUPPORTED: a forced mode ({request.mode}) does not apply "
                    "@skill overlays; remove the mode (use auto) or drop the @skill"
                )
            from superclaw.skill_runtime import (
                BackendSkillCapability,
                SkillRuntimeError,
                prepare_inline_skill_overlay,
            )

            try:
                prepare_inline_skill_overlay(
                    tuple(plan.skill_ids), capability=BackendSkillCapability.mcp_backend()
                )
            except SkillRuntimeError as exc:
                return _fail_stream(f"SKILL_UNAVAILABLE: {exc}")
        direct_backend = explicit_runtime_id or request.direct_chat_backend or runtime.backend or "codex"
        executes_on_resolved = (
            intent == "delivery"
            or (intent == "chat" and runtime.backend == direct_backend)
            or (intent == "task" and runtime.backend in CODEX_DIRECT_CHAT_BACKENDS)
        )
        # The generic (non-codex) chat path persists sticky ONLY after a real
        # answer (inside the worker thread below) — a failed/unavailable backend
        # must not become the chat's sticky runtime. delivery/task and the codex
        # inline path execute the resolved backend deterministically, so they
        # persist up front.
        generic_chat = intent == "chat" and direct_backend not in CODEX_DIRECT_CHAT_BACKENDS
        if executes_on_resolved and not generic_chat:
            persist_turn_runtime(chat_session, runtime)
        chat_session = store.append_chat_message(chat_session.session_id, "user", request.message, context_refs=context_refs)
        chat_turn_id = chat_session.messages[-1].message_id if chat_session.messages else _id("msg")
        chat_turn_run_id = _id("run")  # INTERNAL cost-ledger id only — never exposed as outbound run_id (see _CHAT_RUN_HANDLE_CONTRACT)
        selected_context_text = _merge_selected_context(
            _resolve_chat_context_refs(store, context_refs),
            _resolve_chat_attachments(request.repo_path, chat_session.session_id, request.attachments),
        )

        # DEPRECATED legacy branch (unified-task-entry): only explicit @delivery
        # runs the heavy verifiable orchestrator. This whole path is isolated in
        # _run_legacy_delivery_turn so it can be ripped out when delivery is
        # re-expressed as an Agent company; the unified runtime entry below never
        # touches it. Everything else — plain chat AND @plugin/@skill overlay
        # tasks — streams inline as a runtime turn.
        if intent == "delivery":
            return _run_legacy_delivery_turn(
                request,
                chat_session=chat_session,
                session_id=session_id,
                context_refs=context_refs,
                selected_context_text=selected_context_text,
                runtime=runtime,
            )

        if intent == "chat" and direct_backend in NATIVE_SESSION_CHAT_BACKENDS:
            # NATIVE runtime session (unified chat entry): this chat session is
            # bound to ONE persistent session inside the runtime itself (claude
            # --session-id / --resume), so the conversation continues in the
            # runtime's native memory — no transcript replay — and streams
            # token deltas over the same message.delta SSE contract the codex
            # inline channel uses.
            native_executor = _native_chat_executor(direct_backend)

            native_lock = _chat_native_lock(session_id)
            with native_lock:
                turn_plan = _prepare_native_chat_turn(
                    session_id=session_id,
                    backend=direct_backend,
                    repo_path=request.repo_path,
                    permission_preset=request.permission_preset,
                    strict_resume=request.strict_resume,
                    prior_messages=chat_session.messages[:-1],
                    turn_start_workspace_id=turn_start_workspace_id,
                )
            native_id = turn_plan["native_id"]
            is_resume = turn_plan["is_resume"]
            native_q: queue.Queue = queue.Queue()

            def run_native_turn():
                try:
                    # Serialize turns per chat: two concurrent turns must never
                    # interleave writes into one native session (G4).
                    with native_lock:
                        started_at = time.monotonic()
                        native_kwargs = dict(
                            content=request.message,
                            repo=Path(request.repo_path),
                            budget_seconds=request.budget_seconds,
                            model=runtime.model if runtime.backend == direct_backend else None,
                            effort=runtime.effort if runtime.backend == direct_backend else None,
                            permission_mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
                            native_session_id=native_id,
                            is_resume=is_resume,
                            history_seed=turn_plan["seed"],
                            catch_up=turn_plan["catch_up"],
                            context_text=selected_context_text,
                            on_event=lambda etype, payload: native_q.put((etype, payload)),
                        )
                        if direct_backend == "clawwork":
                            native_kwargs["chat_session_id"] = session_id
                            # Re-judge expect_resume UNDER the worker lock: it was frozen
                            # at prepare time, but a concurrent creator turn may have
                            # completed since (writing last_seen + the session file) — this
                            # pending follower is now a TRUE resume. Re-read the live binding
                            # so a file lost in the prepare→spawn window still fails closed
                            # (CLAWWORK_NATIVE_SESSION_LOST) instead of silently starting an
                            # empty session. Stream-only: the sync path holds the lock across
                            # prepare+execute, so it has no such window.
                            expect_resume_now = turn_plan["expect_resume"]
                            if not expect_resume_now:
                                live = store.get_chat_native_session(session_id, direct_backend)
                                if live and live.get("id") == native_id and live.get("last_seen_message_id"):
                                    expect_resume_now = True
                            native_kwargs["expect_resume"] = expect_resume_now
                        result = native_executor(**native_kwargs)
                        duration_seconds = time.monotonic() - started_at
                        if result.get("status") == "completed":
                            if executes_on_resolved:
                                persist_turn_runtime(chat_session, runtime)
                            _stream_usage, _stream_elapsed_ms = _turn_meter(result, duration_seconds)
                            _complete_native_chat_turn(
                                session_id, direct_backend, native_id, turn_plan["repo_now"],
                                str(result.get("response") or "").strip(),
                                expected_workspace_id=turn_plan["start_workspace_id"],
                                usage=_stream_usage, elapsed_ms=_stream_elapsed_ms,
                            )
                            chat_message_id = _latest_chat_message_id(session_id)
                            done_payload = {
                                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                                "turn_id": chat_turn_id,
                                "backend": direct_backend,
                                "status": "completed",
                                "response": str(result.get("response") or "").strip() or None,
                                "failure_reason": None,
                                # Server-authoritative metering so the LIVE turn shows the same
                                # token tally + elapsed the reload (persisted) shows — zero jump
                                # (the web sets createdAt from the client clock for "刚刚完成").
                                "usage": _stream_usage,
                                "elapsed_ms": _stream_elapsed_ms,
                            }
                        else:
                            if result.get("retire_native_session"):
                                # A broken resume must not pin the chat to a dead session.
                                store.drop_chat_native_session_id(session_id, direct_backend)
                            # Persist the failure so a reload still shows WHY (and
                            # how to recover) instead of a blank — but DON'T advance
                            # the native watermark (the runtime never saw it).
                            friendly = friendly_chat_failure(result.get("failure_reason"), direct_backend)
                            store.append_chat_message(session_id, "assistant", friendly, status="failed")
                            chat_message_id = _latest_chat_message_id(session_id)
                            done_payload = {
                                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                                "turn_id": chat_turn_id,
                                "backend": direct_backend,
                                "status": result.get("status", "failed"),
                                "response": None,
                                "failure_reason": friendly,
                            }
                        _record_chat_cost_event(
                            run_id=chat_turn_run_id,
                            turn_id=chat_turn_id,
                            result=result,
                            backend=direct_backend,
                            chat_session=chat_session,
                            chat_message_id=chat_message_id,
                            status="completed" if result.get("status") == "completed" else "failed",
                            model=runtime.model if runtime.backend == direct_backend else None,
                            duration_seconds=duration_seconds,
                        )
                    native_q.put(("__done__", done_payload))
                except Exception as exc:
                    friendly = friendly_chat_failure(f"{type(exc).__name__}: {exc}", direct_backend)
                    try:
                        store.append_chat_message(session_id, "assistant", friendly, status="failed")
                    except Exception:
                        pass
                    native_q.put(("__done__", {
                        "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                        "turn_id": chat_turn_id,
                        "backend": direct_backend,
                        "status": "failed",
                        "response": None,
                        "failure_reason": friendly,
                    }))

            threading.Thread(target=run_native_turn, daemon=True).start()

            def gen_native():
                yield _sse_event(
                    "chat.started",
                    {
                        "intent": intent,
                        "session_id": session_id,
                        "backend": direct_backend,
                        "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                        "turn_id": chat_turn_id,
                    },
                )
                while True:
                    etype, payload = native_q.get()
                    if etype == "__done__":
                        yield _sse_event("chat.completed", {"intent": intent, "session_id": session_id, **payload})
                        break
                    yield _sse_event(etype, payload)

            return StreamingResponse(gen_native(), media_type="text/event-stream")

        if intent == "chat" and direct_backend not in CODEX_DIRECT_CHAT_BACKENDS:
            # The selected runtime is not the codex family: answer over the
            # kernel's generic direct-chat channel (one-shot, no native thread).
            # No token deltas — the surface gets chat.started and a final
            # chat.completed; conversation memory is our own transcript replay.
            history_text = _format_chat_history(chat_session.messages[:-1])
            generic_q: queue.Queue = queue.Queue()

            def run_generic_turn():
                try:
                    started_at = time.monotonic()
                    result = _execute_direct_chat_turn(
                        content=request.message,
                        backend=direct_backend,
                        repo=Path(request.repo_path),
                        budget_seconds=request.budget_seconds,
                        context_text=selected_context_text,
                        history=history_text,
                        model=runtime.model if runtime.backend == direct_backend else None,
                        effort=runtime.effort if runtime.backend == direct_backend else None,
                        # Native runtime turn: the user's ask/allow preset passes
                        # through to the runtime's own sandbox mapping.
                        permission_mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
                        # api-agent backends (gemini/anthropic) project real tool
                        # cards into the chat stream via this sink — queued ahead of
                        # the final result so the surface shows what was executed.
                        event_sink=lambda etype, payload: generic_q.put({"_display": (etype, payload)}),
                        # Inode-pinned real-folder project → backend must not
                        # re-create a deleted/swapped cwd (validated upstream).
                        protected_cwd=workspace_resolver.is_protected_project_repo(store, request.repo_path),
                    )
                    duration_seconds = time.monotonic() - started_at
                    final = str(result.get("response") or "").strip()
                    # Succeed only on a completed turn WITH a reply — a completed
                    # turn with no text is a failure (no sticky, status=failed).
                    succeeded = result.get("status") == "completed" and bool(final)
                    if executes_on_resolved and succeeded:
                        persist_turn_runtime(chat_session, runtime)
                    if succeeded:
                        _gen_usage, _gen_elapsed_ms = _turn_meter(result, duration_seconds)
                        updated_session = store.append_chat_message(
                            session_id, "assistant", final, usage=_gen_usage, elapsed_ms=_gen_elapsed_ms
                        )
                        chat_message_id = updated_session.messages[-1].message_id if updated_session.messages else None
                        generic_q.put(
                            {
                                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                                "turn_id": chat_turn_id,
                                "status": "completed",
                                "backend": result.get("backend", direct_backend),
                                "response": final or None,
                                "failure_reason": None,
                                # Server-authoritative metering on the live turn (== persisted).
                                "usage": _gen_usage,
                                "elapsed_ms": _gen_elapsed_ms,
                            }
                        )
                    else:
                        # Persist the failure (with recovery hint) so a reload still
                        # shows WHY instead of a blank. A completed-but-empty turn is
                        # reported as failed too — never success status to the client.
                        friendly = _record_chat_failure(
                            session_id, direct_backend, result.get("failure_reason") or "backend returned no reply"
                        )
                        chat_message_id = _latest_chat_message_id(session_id)
                        generic_q.put(
                            {
                                "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                                "turn_id": chat_turn_id,
                                "status": "failed",
                                "backend": result.get("backend", direct_backend),
                                "response": None,
                                "failure_reason": friendly,
                            }
                        )
                    _record_chat_cost_event(
                        run_id=chat_turn_run_id,
                        turn_id=chat_turn_id,
                        result=result,
                        backend=direct_backend,
                        chat_session=chat_session,
                        chat_message_id=chat_message_id,
                        status="completed" if succeeded else "failed",
                        model=runtime.model if runtime.backend == direct_backend else None,
                        duration_seconds=duration_seconds,
                    )
                except Exception as exc:
                    friendly = friendly_chat_failure(f"{type(exc).__name__}: {exc}", direct_backend)
                    try:
                        store.append_chat_message(session_id, "assistant", friendly, status="failed")
                    except Exception:
                        pass
                    generic_q.put(
                        {
                            "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                            "turn_id": chat_turn_id,
                            "status": "failed",
                            "backend": direct_backend,
                            "response": None,
                            "failure_reason": friendly,
                        }
                    )

            threading.Thread(target=run_generic_turn, daemon=True).start()

            def gen_generic_chat():
                yield _sse_event(
                    "chat.started",
                    {
                        "intent": intent,
                        "session_id": session_id,
                        "backend": direct_backend,
                        "run_id": None,  # pure chat has no run resource; see _CHAT_RUN_HANDLE_CONTRACT
                        "turn_id": chat_turn_id,
                    },
                )
                # DL4 batch diagnostic ONLY for backends that do NOT surface live
                # tools. An api-agent backend (gemini/anthropic, surfaces_live_tools=
                # True) projects its REAL tool cards through event_sink, so a "no live
                # tools" diagnostic would be misleading — it DID run tools (which on
                # acceptEdits can write files). Honesty: show the tools, not a denial.
                _backend_obj = default_backends().get(direct_backend)
                if not getattr(_backend_obj, "surfaces_live_tools", False):
                    from superclaw.display_projection import build_adapter_diagnostic

                    _diag = build_adapter_diagnostic(
                        direct_backend,
                        f"{direct_backend} answers as a batch (non-streaming) runtime; tool calls are not surfaced live",
                        event_id=f"adapter.diagnostic:chat:{session_id}:{direct_backend}",
                    )
                    yield _sse_event(_diag.type, _diag.to_dict())
                # Drain the queue: tool display events (queued by the backend's
                # event_sink) stream out first; the final result dict ends the turn.
                while True:
                    item = generic_q.get()
                    display = item.get("_display") if isinstance(item, dict) else None
                    if display is not None:
                        yield _sse_event(display[0], display[1])
                        continue
                    yield _sse_event("chat.completed", {"intent": intent, "session_id": session_id, **item})
                    break

            return StreamingResponse(gen_generic_chat(), media_type="text/event-stream")

        inline_task_run_id: str | None = None
        if intent == "task":
            # Low-trust workspaces are already refused up-front by
            # _guard_chat_containment (this whole stream turn never starts), so the
            # inline task below is only ever reached in a non-fenced workspace.
            goal = store.create_goal(
                GoalSpec(
                    title=chat_session.title,
                    description=request.message,
                    metadata={
                        "chat_session_id": session_id,
                        "chat_turn_mode": request.mode,
                        "chat_turn_intent": intent,
                        "active_plugin_id": active_plugin_id,
                    },
                )
            )
            inline_task_run = store.create_run(goal.goal_id, dry_run=False)
            inline_task_run.chat_session_id = session_id
            inline_task_run.status = "queued"
            store.save_run(inline_task_run)
            store.add_event(
                inline_task_run.run_id,
                "chat.task.queued",
                {"run_id": inline_task_run.run_id, "session_id": session_id, "active_plugin_id": active_plugin_id},
            )
            inline_task_run_id = inline_task_run.run_id

        # Everything below executes on the codex app-server inline channel:
        # plain chat whose resolved runtime IS the codex family, and @plugin
        # tasks (the only runtime with MCP plugin projection today).
        inline_chat_backend = direct_backend if direct_backend in CODEX_DIRECT_CHAT_BACKENDS else "codex"
        # Unified task entry: resolve the (pluggable) runtime + negotiate
        # capabilities. runtime_id supersedes the deprecated direct_chat_backend;
        # by default it derives from the chat's resolved runtime (codex family →
        # the app-server adapter). has_overlay is true exactly when this turn
        # carries a plugin/skill overlay (intent == "task"), so overlays on a
        # non-MCP runtime fail closed.
        resolved_runtime_id = request.runtime_id or (
            CODEX_APP_SERVER_RUNTIME_ID if inline_chat_backend in CODEX_DIRECT_CHAT_BACKENDS else inline_chat_backend
        )
        has_overlay = intent == "task"
        runtime_error: str | None = None
        # Validate the chat's effort selection up front (fail-loud, same levels as
        # the kernel codex backend) so an invalid value reports cleanly through the
        # existing failure path instead of codex rejecting `-c` mid-turn.
        _codex_effort = (runtime.effort or "").strip().lower() if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else ""
        if _codex_effort:
            from superclaw.backends import CodexCliBackend as _CodexCliBackend

            if _codex_effort not in _CodexCliBackend.EFFORT_LEVELS:
                runtime_error = (
                    f"EFFORT_INVALID: effort={_codex_effort!r} is not one of "
                    f"{'/'.join(_CodexCliBackend.EFFORT_LEVELS)}; fix or clear the effort selection"
                )
        try:
            adapter = _RUNTIME_MANAGER.resolve(resolved_runtime_id)
            _RUNTIME_MANAGER.require_overlay_support(adapter, has_overlay=has_overlay)
            if adapter.runtime_id != CODEX_APP_SERVER_RUNTIME_ID:
                # Only codex-app-server is wired for execution today; other
                # adapters declare capability but aren't executable yet.
                raise RuntimeCapabilityError(
                    adapter.runtime_id, "run_turn", "runtime declared but not wired for execution yet; use codex-app-server"
                )
        except KeyError:
            runtime_error = f"unknown runtime_id: {resolved_runtime_id!r}"
        except RuntimeCapabilityError as exc:
            runtime_error = f"{exc.code}: {exc}"
        if runtime_error is not None:
            if inline_task_run_id:
                failed_run = store.get_run(inline_task_run_id)
                failed_run.status = "failed"
                store.save_run(failed_run)
                store.add_event(inline_task_run_id, "chat.task.failed", {"run_id": inline_task_run_id, "reason": runtime_error})
            friendly = _record_chat_failure(session_id, inline_chat_backend, runtime_error)
            if not inline_task_run_id:
                _record_chat_cost_event(
                    run_id=chat_turn_run_id,
                    turn_id=chat_turn_id,
                    result={"backend": inline_chat_backend, "status": "failed"},
                    backend=inline_chat_backend,
                    chat_session=chat_session,
                    chat_message_id=_latest_chat_message_id(session_id),
                    status="failed",
                    model=runtime.model if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else None,
                )
            def gen_unsupported():
                yield _sse_event(
                    "chat.completed",
                    {
                        "intent": intent,
                        "session_id": session_id,
                        "run_id": inline_task_run_id,  # real run iff @task; None for pure chat (see _CHAT_RUN_HANDLE_CONTRACT)
                        "turn_id": chat_turn_id,
                        "status": "failed",
                        "failure_reason": friendly,
                    },
                )
            return StreamingResponse(gen_unsupported(), media_type="text/event-stream")

        # Lazy overlay (unified-task-entry): only project plugins when this turn
        # actually carries an overlay — an explicit @plugin or a sticky active
        # plugin both surface as intent == "task". A pure chat turn projects
        # nothing (extra_args == []), so it stays a zero-overhead native runtime
        # turn (no fail-closed gate scan / snapshot write). See
        # docs/unified-task-entry.md (PR-3 lazy overlay).
        if intent == "task":
            plugin_extra_args, plugin_note = _chat_plugin_projection(request.repo_path)
        else:
            plugin_extra_args, plugin_note = [], None
        # Reattach to the codex thread persisted for this chat session (if any) so
        # the conversation keeps its native memory across backend restarts.
        persisted_thread_id = store.get_chat_codex_thread_id(session_id)
        # Codex-resume repo change guard (workspace-sidebar-rework §4.5): if the
        # repo directory changed, we must drop the persisted thread ID to prevent
        # resuming across different repos.
        repo_now = str(Path(request.repo_path).expanduser().resolve())
        prior_dir = store._session_prior_execution_dir(chat_session)
        if prior_dir is not None and prior_dir != repo_now:
            try:
                store.set_chat_codex_thread_id(session_id, "")
            except Exception:
                pass
            persisted_thread_id = None

        # Capability-surface resume guard: the model's context still "remembers" the
        # skills / plugin tools / permission posture from when this session started.
        # Re-fingerprint the live surface, grade the difference, and act:
        #  - HARD_BLOCK (an authority widening or safety downgrade): drop the codex
        #    thread so the native world-view resets; our own transcript replay still
        #    preserves conversational context, but the stale (over-authorized) frame
        #    is gone. (ask↔allow is equal authority under the max doctrine, so it is
        #    NOT a widening and keeps the thread.)
        #  - INJECT_NOTICE / CONFIRM / SILENT_NOTE: keep the thread, inject one notice
        #    so the model learns what changed (revoked tools framed as "do NOT use").
        resume_notice = ""
        try:
            live_surface = current_capability_surface(
                permission_mode=(request.permission_preset or ""),
                backend=inline_chat_backend,
                model="",
            )
            stored_surface = store.get_chat_capability_surface(session_id)
            if stored_surface:
                surface_diffs = classify_surface_diff(
                    CapabilitySurface.from_dict(stored_surface), live_surface
                )
                action = resolve_resume_action(surface_diffs, strict=request.strict_resume)
                if action is SurfaceDiffAction.HARD_BLOCK:
                    persisted_thread_id = None  # force a fresh codex thread
                    # Wipe the persisted bindings too (advisor B3): without this
                    # a later switch-away/switch-back would re-fetch the stale
                    # over-authorized thread from the store.
                    try:
                        store.set_chat_codex_thread_id(session_id, "")
                    except Exception:
                        pass
                    store.drop_chat_native_session_id(session_id, "codex-app-server")
                resume_notice = render_capability_change_notice(surface_diffs)
            store.set_chat_capability_surface(session_id, live_surface.to_dict())
        except Exception:
            resume_notice = ""  # fail-soft: a guard error never blocks a turn

        # The dir this turn runs in (its execution boundary). If a concurrent
        # workspace MOVE changes the session's boundary before the turn finishes,
        # the write-back below must NOT pin this codex thread/binding — it would
        # resume the old repo even though the session moved (§4.5). Captured here
        # as a stable repo (not a late workspace_id read). The turn-start
        # workspace_id (captured right after resolve, NOT re-read here where
        # chat_session has already been overwritten by append_chat_message) pairs
        # with it so a move to the Inbox (grouped→unassigned) is also detected as a
        # boundary change (§4.5; Codex r9).
        turn_repo = str(Path(request.repo_path).expanduser().resolve())
        turn_workspace_id = turn_start_workspace_id
        conv = _get_chat_codex_session(
            session_id,
            request.repo_path,
            resume_thread_id=persisted_thread_id,
            extra_args=plugin_extra_args,
            # Streaming chat runs codex; the chat's model selection applies only
            # when the selected runtime IS codex (model ids are not portable across
            # runtimes). Effort is NOT passed here — it rides the per-turn
            # turn/start.effort on run_turn below, so a changed effort never
            # rebuilds this session.
            model=runtime.model if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else None,
            # Native runtime turn: the user's ask/allow preset passes through to
            # codex's own sandbox/approval mapping.
            permission_mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
        )
        if conv is None:
            if inline_task_run_id:
                failed_run = store.get_run(inline_task_run_id)
                failed_run.status = "failed"
                store.save_run(failed_run)
                store.add_event(inline_task_run_id, "chat.task.failed", {"run_id": inline_task_run_id, "reason": "codex executable not found"})
            friendly = _record_chat_failure(session_id, inline_chat_backend, "codex executable not found; configure SUPERCLAW_CODEX_EXECUTABLE")
            if not inline_task_run_id:
                _record_chat_cost_event(
                    run_id=chat_turn_run_id,
                    turn_id=chat_turn_id,
                    result={"backend": inline_chat_backend, "status": "failed"},
                    backend=inline_chat_backend,
                    chat_session=chat_session,
                    chat_message_id=_latest_chat_message_id(session_id),
                    status="failed",
                    model=runtime.model if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else None,
                )
            def gen_nocodex():
                yield _sse_event(
                    "chat.completed",
                    {
                        "intent": intent,
                        "session_id": session_id,
                        "run_id": inline_task_run_id,  # real run iff @task; None for pure chat (see _CHAT_RUN_HANDLE_CONTRACT)
                        "turn_id": chat_turn_id,
                        "status": "failed",
                        "failure_reason": friendly,
                    },
                )
            return StreamingResponse(gen_nocodex(), media_type="text/event-stream")

        # Snapshot prior turns now (the current user message was already appended)
        # so we can replay them if codex cannot restore the thread from disk.
        prior_messages = list(chat_session.messages[:-1])

        events_q: queue.Queue = queue.Queue()

        def run_turn_thread():
            with conv["lock"]:
                try:
                    if inline_task_run_id:
                        running_run = store.get_run(inline_task_run_id)
                        running_run.status = "running"
                        store.save_run(running_run)
                        store.add_event(inline_task_run_id, "chat.task.started", {"run_id": inline_task_run_id, "session_id": session_id})
                    session_obj = conv["session"]
                    # Establish or resume the codex thread before framing the turn.
                    session_obj.ensure_started()
                    needs_history = conv["turns"] == 0 and not session_obj.resumed
                    history_text = _format_chat_history(prior_messages) if needs_history or sticky_plugin_context else ""
                    # Cross-runtime catch-up (advisor G1/G3): the thread's native
                    # memory only covers turns IT ran. The last-seen watermark
                    # (advanced after every completed codex turn) exposes the
                    # turns that happened on another runtime — or before an app
                    # restart — as a one-time sync block. A fresh thread has no
                    # watermark and syncs the full (filtered) dialogue, which
                    # also supersedes the raw needs_history replay below.
                    from superclaw.chat_turn import build_catch_up_block

                    codex_binding = store.get_chat_native_session(session_id, "codex-app-server")
                    codex_last_seen = codex_binding.get("last_seen_message_id") if codex_binding else None
                    catch_up_text = build_catch_up_block(prior_messages, codex_last_seen if not needs_history else None)
                    runtime_notice = f"[SuperClaw capability notice]\n{resume_notice}" if resume_notice else ""
                    # Whether the SuperClaw MCP server was actually projected for
                    # this turn (drives tool-skill availability: a tool-skill is only
                    # callable if its MCP proxy is present).
                    mcp_projected = bool(plugin_extra_args)
                    turn_prompt_bundle: ChatPromptEnvelope | None = None
                    if intent == "task" and active_plugin_id is None and plan.skill_ids and not plan.plugin_ids:
                        # A skill-only overlay turn: skills are not plugin tasks —
                        # never apply the plugin-specific prompt (payment mapping etc.).
                        turn_prompt_bundle = _skill_task_prompt_envelope(
                            request.message,
                            skill_ids=plan.skill_ids,
                            plugin_note=plugin_note,
                            history_text=history_text,
                            context_text=selected_context_text,
                            runtime_notice=runtime_notice,
                            mcp_projected=mcp_projected,
                        )
                        turn_prompt = turn_prompt_bundle.prompt
                    elif intent == "task":
                        # An @plugin (or sticky-plugin) task: instruct codex to USE
                        # the projected plugin tools. If the turn ALSO carries @skill,
                        # the skill overlay is applied too (never silently dropped).
                        turn_prompt_bundle = _plugin_task_prompt_envelope(
                            request.message,
                            plugin_note=plugin_note,
                            active_plugin_id=active_plugin_id,
                            history_text=history_text,
                            context_text=selected_context_text,
                            runtime_notice=runtime_notice,
                            skill_ids=plan.skill_ids,
                            mcp_projected=mcp_projected,
                        )
                        turn_prompt = turn_prompt_bundle.prompt
                    elif needs_history:
                        # Brand-new thread, or resume failed (rollout pruned/lost):
                        # replay our own transcript so memory survives regardless.
                        turn_prompt_bundle = build_chat_prompt_envelope(
                            request.message,
                            context_text=selected_context_text,
                            history_text=history_text,
                            runtime_notice=runtime_notice,
                        )
                        turn_prompt = turn_prompt_bundle.prompt
                    else:
                        # Resumed (or continuing live) thread: rely on codex's
                        # native memory, plus the one-time cross-runtime catch-up
                        # for turns it missed while the chat ran elsewhere.
                        turn_prompt_bundle = build_chat_prompt_envelope(
                            request.message,
                            history_text=catch_up_text,
                            context_text=selected_context_text,
                            runtime_notice=runtime_notice,
                            history_heading="Runtime catch-up turns:",
                        )
                        turn_prompt = turn_prompt_bundle.prompt
                    # Conversational create (A3b): on a create-intent chat turn,
                    # append SuperClaw's short skill-creation directive so codex
                    # hands a governed proposal back (harvested after the turn)
                    # rather than writing a file itself.
                    if skill_create_turn:
                        from superclaw.skill_author import SKILL_CREATION_DIRECTIVE

                        turn_prompt = f"{turn_prompt}\n\n{SKILL_CREATION_DIRECTIVE}"
                    # Plugin tasks (tool calls, browser-runner handoffs) need more
                    # headroom than a plain chat reply.
                    turn_budget = float(max(request.budget_seconds, 240)) if intent == "task" else float(request.budget_seconds)
                    # Execution goes through the runtime adapter (unified-task-entry):
                    # the handler no longer calls codex's session directly, so a
                    # future runtime is a drop-in. ensure_started() above is
                    # idempotent with the adapter's own start.
                    # Composed sink (DL10): 实时 chat SSE（events_q）+ 持久 run events
                    # （store）双写,让 chat-linked task run 在 run cockpit 的
                    # /events/snapshot 能重放工具卡/审批/诊断（否则 inline run 的 cockpit
                    # 显示为空——PR-4/PR-6 在 chat 链路上不完整,Codex 收敛复核阻断）。
                    # store.add_event 是 best-effort（PR-4 safe-write）,持久化失败绝不打断
                    # 实时 chat 流;纯 chat（无 inline_task_run_id）只写实时队列,不写 run events。
                    def _inline_display_sink(event_type: str, payload: dict) -> None:
                        events_q.put((event_type, payload))
                        if inline_task_run_id:
                            store.add_event(inline_task_run_id, event_type, payload)

                    started_at = time.monotonic()
                    turn_result = adapter.run_turn(
                        session_obj,
                        RuntimeTurnRequest(
                            prompt=turn_prompt,
                            budget_seconds=turn_budget,
                            prompt_envelope=turn_prompt_bundle.envelope if turn_prompt_bundle else None,
                            projection_audit=turn_prompt_bundle.projection_audit if turn_prompt_bundle else {},
                            legacy_prompt_fallback=turn_prompt_bundle.legacy_fallback if turn_prompt_bundle else {},
                            # Per-turn reasoning effort rides turn/start.effort (validated
                            # up front against EFFORT_LEVELS). Only the codex family honors
                            # it; an empty selection falls back to the thread's baseline.
                            effort=runtime.effort if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else None,
                        ),
                        _inline_display_sink,
                    )
                    duration_seconds = time.monotonic() - started_at
                    final = (turn_result.final_text or "").strip()
                    ok = not (turn_result.error or turn_result.cancelled or turn_result.timed_out)
                    failure_reason = turn_result.error
                    if turn_result.timed_out and not failure_reason:
                        failure_reason = f"timeout: codex app-server turn exceeded {int(turn_budget)}s"
                    elif turn_result.cancelled and not failure_reason:
                        failure_reason = "codex app-server turn was cancelled"
                    # Succeed only when the turn is ok AND produced a reply. An
                    # ok-but-empty turn is a failure: no thread pin (resume must not
                    # reattach a thread that produced nothing visible), a status=failed
                    # assistant persisted, and status=failed to the client.
                    succeeded = ok and bool(final)
                    # Conversational create (A3b): on a successful create-intent
                    # chat turn, harvest the governed skill proposal codex emitted,
                    # register it through the kernel, strip the raw block, and
                    # rewrite `final` (used by both the persisted append and the
                    # __done__/chat.completed payload) to the confirmation. Same
                    # governed pipeline as the generic path; registration uses the
                    # user's default store.
                    # SCOPE: this sanitizes the PERSISTED message and the completion
                    # payload. The live message.delta events were already streamed
                    # before run_turn() returned, so a client may briefly see the raw
                    # proposal block until the web surface (A5) collapses/replaces it
                    # on the completion event — the durable record is always clean.
                    if succeeded and skill_create_turn:
                        from superclaw.skill_author import (
                            created_skill_receipt,
                            harvest_skill_proposals,
                            strip_skill_proposals,
                        )

                        _created, _skill_errors = harvest_skill_proposals(final)
                        if _created or _skill_errors:
                            final = strip_skill_proposals(final)
                            if _created:
                                _created_slugs = [record.slug for record in _created]
                                final = (final + "\n\n" + created_skill_receipt(_created_slugs)).strip()
                            if _skill_errors:
                                final = (final + "\n\n⚠ Skill not created: " + "; ".join(_skill_errors)).strip()
                            succeeded = bool(final)
                    # codex app-server surfaces no token usage; the wall-clock timer
                    # still gives the turn's elapsed. Computed ONCE here (duration_seconds
                    # is already assigned unconditionally above) and reused by both the
                    # persisted append and the live __done__ event, so the two never drift.
                    _inline_elapsed_ms = round(duration_seconds * 1000) if duration_seconds and duration_seconds > 0 else None
                    if succeeded:
                        # Append the reply AND pin the codex resume thread/binding
                        # in ONE atomic transaction, conditional on the session
                        # still being in the workspace this turn ran under (§4.5
                        # race): a concurrent move can neither lose this append nor
                        # let the turn pin a thread for a boundary it already left.
                        # The reply always persists; only the resume handle is
                        # conditional (skipped if moved → next turn re-resolves).
                        try:
                            updated_session, _pinned = store.append_assistant_message_and_pin_codex(
                                session_id,
                                final,
                                run_id=inline_task_run_id,
                                thread_id=turn_result.thread_id,
                                repo_path=turn_repo,
                                expected_repo=turn_repo,
                                expected_workspace_id=turn_workspace_id,
                                elapsed_ms=_inline_elapsed_ms,
                            )
                            chat_message_id = updated_session.messages[-1].message_id if updated_session.messages else None
                        except Exception:
                            # Never drop the reply if the atomic pin path fails.
                            updated_session = store.append_chat_message(
                                session_id, "assistant", final, run_id=inline_task_run_id, elapsed_ms=_inline_elapsed_ms
                            )
                            chat_message_id = updated_session.messages[-1].message_id if updated_session.messages else None
                    else:
                        # Failure (error / cancel / timeout / ok-but-empty): persist
                        # status=failed so a reload still shows WHY, and DON'T pin the
                        # thread/watermark — resume must never reattach a thread that
                        # produced no visible turn.
                        failure_reason = _record_chat_failure(
                            session_id, direct_backend, failure_reason or "codex app-server returned no reply"
                        )
                        chat_message_id = _latest_chat_message_id(session_id)
                    if inline_task_run_id:
                        finished_run = store.get_run(inline_task_run_id)
                        if succeeded:
                            finished_run.status = "verifying"
                            store.save_run(finished_run)
                            finished_run.status = "completed"
                            store.save_run(finished_run)
                            store.add_event(inline_task_run_id, "chat.task.completed", {"run_id": inline_task_run_id})
                        else:
                            finished_run.status = "failed"
                            store.save_run(finished_run)
                            store.add_event(inline_task_run_id, "chat.task.failed", {"run_id": inline_task_run_id, "reason": failure_reason})
                    if not inline_task_run_id:
                        _record_chat_cost_event(
                            run_id=chat_turn_run_id,
                            turn_id=chat_turn_id,
                            result={
                                "backend": inline_chat_backend,
                                "status": "completed" if succeeded else "failed",
                                "duration_seconds": duration_seconds,
                            },
                            backend=inline_chat_backend,
                            chat_session=chat_session,
                            chat_message_id=chat_message_id,
                            status="completed" if succeeded else "failed",
                            model=runtime.model if runtime.backend in CODEX_DIRECT_CHAT_BACKENDS else None,
                            duration_seconds=duration_seconds,
                        )
                    events_q.put((
                        "__done__",
                        {
                            "run_id": inline_task_run_id,  # real run iff @task; None for pure chat (see _CHAT_RUN_HANDLE_CONTRACT)
                            "turn_id": chat_turn_id,
                            "status": "completed" if succeeded else "failed",
                            "response": final if succeeded else None,
                            "failure_reason": failure_reason,
                            # codex app-server reports no token usage; the wall-clock elapsed
                            # (same value persisted on the message) rides the live completion
                            # so the meter row shows 用时. None on a failed turn (no metering).
                            "usage": None,
                            "elapsed_ms": _inline_elapsed_ms if succeeded else None,
                        },
                    ))
                    if turn_result.should_retire_session:
                        _drop_chat_codex_session(session_id)
                except Exception as exc:  # surface to the stream, drop the (possibly broken) thread
                    reason = f"{type(exc).__name__}: {exc}"
                    if inline_task_run_id:
                        try:
                            failed_run = store.get_run(inline_task_run_id)
                            failed_run.status = "failed"
                            store.save_run(failed_run)
                            store.add_event(inline_task_run_id, "chat.task.failed", {"run_id": inline_task_run_id, "reason": reason})
                        except Exception:
                            pass
                    friendly = _record_chat_failure(session_id, direct_backend, reason)
                    events_q.put(("__done__", {"run_id": inline_task_run_id, "status": "failed", "failure_reason": friendly}))
                    _drop_chat_codex_session(session_id)
                finally:
                    conv["turns"] += 1

        threading.Thread(target=run_turn_thread, daemon=True).start()

        def gen_chat():
            yield _sse_event(
                "chat.started",
                {
                    "intent": intent,
                    "session_id": session_id,
                    "backend": inline_chat_backend,
                    "run_id": inline_task_run_id,  # real run iff @task; None for pure chat (see _CHAT_RUN_HANDLE_CONTRACT)
                    "turn_id": chat_turn_id,
                },
            )
            while True:
                etype, payload = events_q.get()
                if etype == "__done__":
                    yield _sse_event("chat.completed", {"intent": intent, "session_id": session_id, "backend": inline_chat_backend, **payload})
                    break
                yield _sse_event(etype, payload)

        return StreamingResponse(gen_chat(), media_type="text/event-stream")

    @app.post("/api/chat")
    def chat_turn(request: ChatTurnRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        chat_session = resolve_chat_session(request)
        _guard_chat_containment(chat_session, request.repo_path)
        # Fail-closed: this legacy endpoint wraps the message into a delivery and runs
        # the orchestrator directly — it has no @skill overlay handling, so a message
        # addressing @skill would be silently run WITHOUT the skill. Refuse instead of
        # dropping it; the overlay-capable entries are /api/chat/turn and /api/chat/stream.
        if parse_chat_route(request.message, mode=request.mode).skill_ids:
            return {
                "session_id": chat_session.session_id,
                "run_id": None,
                "status": "failed",
                "failure_reason": (
                    "SKILL_OVERLAY_UNSUPPORTED: the legacy /api/chat endpoint does not run @skill "
                    "overlays; use /api/chat/turn or /api/chat/stream"
                ),
            }
        runtime = resolve_turn_runtime(chat_session, request)
        persist_turn_runtime(chat_session, runtime)  # legacy /api/chat always runs the resolved backend
        context_refs = _chat_context_ref_dicts(request.context_refs)
        chat_session = store.append_chat_message(chat_session.session_id, "user", request.message, context_refs=context_refs)
        selected_context_text = _merge_selected_context(
            _resolve_chat_context_refs(store, context_refs),
            _resolve_chat_attachments(request.repo_path, chat_session.session_id, request.attachments),
        )
        policy = PermissionPolicy.from_values(
            mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
            allowed_tools=request.allowed_tools,
            disallowed_tools=request.disallowed_tools,
            mcp_configs=request.mcp_configs,
            plugin_dirs=request.plugin_dirs,
            session_id=chat_session.session_id,
        )
        result = orchestrator.run_goal(
            title=chat_session.title,
            description=_delivery_description_from_chat(
                request_message=request.message,
                context_messages=[],
                selected_context_text=selected_context_text,
            ),
            dry_run=request.dry_run,
            backend_policy=runtime.backend,
            model=runtime.model,
            effort=runtime.effort,
            harness_policy=request.harness_policy,
            repo_path=request.repo_path,
            budget_seconds=request.budget_seconds,
            artifact_dir=request.artifact_dir,
            task_topology=request.task_topology,
            permission_policy=policy if policy != PermissionPolicy() else None,
            chat_session_id=chat_session.session_id,
        )
        _raise_if_budget_blocked(result.session)
        store.append_chat_message(
            chat_session.session_id,
            "assistant",
            f"run_id={result.session.run_id} status={result.session.status} chain_verdict={result.evidence.chain_verdict.value}",
            run_id=result.session.run_id,
        )
        return {
            "session_id": chat_session.session_id,
            "run_id": result.session.run_id,
            "status": result.session.status,
            "chain_verdict": result.evidence.chain_verdict.value,
        }

    @app.post("/api/chat/direct")
    def direct_chat_turn(request: DirectChatRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # DEPRECATED (unified-task-entry): the streaming /api/chat/stream is the
        # single unified entry. This non-streaming endpoint is a legacy compat
        # shell over the same kernel one-shot channel (any registered backend,
        # honors the per-turn model override). See docs/unified-task-entry.md.
        # Deprecated does not mean exempt: the execution repo passes the same
        # kernel trust gate as every other chat entry (fail-closed 403).
        resolution = workspace_resolver.resolve_workspace_for_chat(store, repo=request.repo_path)
        if resolution.status == "trust_required":
            raise HTTPException(
                status_code=403,
                detail=f"{workspace_resolver.WORKSPACE_TRUST_REQUIRED}: {resolution.reason}",
            )
        # T11 fail-closed: this legacy one-shot also runs the adapter directly —
        # refuse it in a low-trust workspace (same fence as the other chat entries).
        if getattr(resolution, "workspace", None) is not None:
            _guard_chat_containment(resolution.workspace, request.repo_path)
        repo_path = request.repo_path or resolution.workspace.repo_path
        chat_turn_run_id = _id("run")  # INTERNAL cost-ledger id only — never exposed as outbound run_id (see _CHAT_RUN_HANDLE_CONTRACT)
        chat_turn_id = _id("msg")
        started_at = time.monotonic()
        result = _execute_direct_chat_turn(
            content=request.message,
            backend=request.backend_policy,
            repo=Path(repo_path),
            budget_seconds=request.budget_seconds,
            model=request.model,
            effort=request.effort,
            # Inode-pinned real-folder project → backend must not re-create a
            # deleted/swapped cwd (validated upstream by the guard).
            protected_cwd=workspace_resolver.is_protected_project_repo(store, repo_path),
        )
        duration_seconds = time.monotonic() - started_at
        succeeded = result.get("status") == "completed" and bool(str(result.get("response") or "").strip())
        _record_chat_cost_event(
            run_id=chat_turn_run_id,
            turn_id=chat_turn_id,
            result=result,
            backend=request.backend_policy,
            status="completed" if succeeded else "failed",
            model=request.model,
            duration_seconds=duration_seconds,
        )
        return {
            **result,
            "run_id": None,  # deprecated direct chat has no run resource (see _CHAT_RUN_HANDLE_CONTRACT)
            "turn_id": chat_turn_id,
            "deprecated": True,
            "replacement": "/api/chat/stream",
        }

    @app.get("/api/goals/{goal_id}")
    def get_goal(goal_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return store.get_goal(goal_id).to_dict()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="goal not found") from exc

    @app.post("/api/runs")
    def create_run(request: RunRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            goal = store.get_goal(request.goal_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="goal not found") from exc
        if request.async_execution:
            policy = PermissionPolicy.from_values(
                mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
                allowed_tools=request.allowed_tools,
                disallowed_tools=request.disallowed_tools,
                mcp_configs=request.mcp_configs,
                plugin_dirs=request.plugin_dirs,
                session_id=request.chat_session_id,
            )
            session = orchestrator.start_existing_goal(
                goal,
                dry_run=request.dry_run,
                backend_policy=request.backend_policy,
                model=request.model,
                effort=request.effort,
                harness_policy=request.harness_policy,
                concurrency=request.concurrency,
                repo_path=request.repo_path,
                budget_seconds=request.budget_seconds,
                artifact_dir=request.artifact_dir,
                verification_policy=request.verification_policy,
                task_topology=request.task_topology,
                permission_policy=policy if policy != PermissionPolicy() else None,
                chat_session_id=request.chat_session_id,
            )
            verdict = "CONTROL_PLANE_READY"
            try:
                verdict = store.get_evidence(session.run_id).chain_verdict.value
            except KeyError:
                pass
            _raise_if_budget_blocked(session)
            return {"run_id": session.run_id, "status": session.status, "chain_verdict": verdict}
        policy = PermissionPolicy.from_values(
            mode=_effective_permission_mode(request.permission_preset, request.permission_mode),
            allowed_tools=request.allowed_tools,
            disallowed_tools=request.disallowed_tools,
            mcp_configs=request.mcp_configs,
            plugin_dirs=request.plugin_dirs,
            session_id=request.chat_session_id,
        )
        result = orchestrator.run_existing_goal(
            goal,
            dry_run=request.dry_run,
            backend_policy=request.backend_policy,
            model=request.model,
            effort=request.effort,
            harness_policy=request.harness_policy,
            concurrency=request.concurrency,
            repo_path=request.repo_path,
            budget_seconds=request.budget_seconds,
            artifact_dir=request.artifact_dir,
            verification_policy=request.verification_policy,
            task_topology=request.task_topology,
            permission_policy=policy if policy != PermissionPolicy() else None,
            chat_session_id=request.chat_session_id,
        )
        _raise_if_budget_blocked(result.session)
        return {
            "run_id": result.session.run_id,
            "status": result.session.status,
            "chain_verdict": result.evidence.chain_verdict.value,
        }

    @app.get("/api/runs")
    def list_runs(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"runs": [run_read_payload(run) for run in store.list_runs()]}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            run = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        # Lazy reconcile: a single-run read that catches a dead "executing"
        # claim repairs it through the full reconcile state machine (lease
        # mutex inside) instead of returning the stale story.
        if run.status in EXECUTING_RUN_STATUSES and not effective_run_state(run)["is_live"]:
            try:
                orchestrator.reconcile_run(run_id)
                run = store.get_run(run_id)
            except Exception:
                pass
        return run_read_payload(run)

    @app.post("/api/runs/{run_id}/cancel")
    def cancel_run(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = orchestrator.cancel_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        return {
            "run_id": result.run_id,
            "status": result.status,
            "previous_status": result.previous_status,
            "accepted": result.accepted,
            "event_type": result.event_type,
            "detail": result.detail,
        }

    @app.post("/api/runs/{run_id}/human-gate")
    def pause_for_human_gate(run_id: str, request: HumanGateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            session = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        previous_status = session.status
        session.status = "WAITING_FOR_HUMAN_GATE"
        store.save_run(session)
        store.add_event(run_id, "run.paused", {"run_id": run_id, "reason": request.reason, "previous_status": previous_status})
        return {"run_id": run_id, "status": session.status, "reason": request.reason}

    @app.post("/api/runs/{run_id}/resume")
    def resume_run(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = orchestrator.resume_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        except BudgetGateError as exc:
            raise _budget_gate_conflict(exc) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if hasattr(result, "session"):
            _raise_if_budget_blocked(result.session)
            return {
                "run_id": result.session.run_id,
                "status": result.session.status,
                "chain_verdict": result.evidence.chain_verdict.value,
            }
        return {"run_id": run_id, "status": result.status}

    @app.post("/api/runs/{run_id}/delegation-review")
    def review_delegation_result(run_id: str, request: DelegationReviewRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = orchestrator.review_child_delegation_result(
                run_id,
                request.request_key,
                approved=request.approved,
                reviewed_by=request.reviewed_by or "local_user",
            )
            session = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"run_id": run_id, "status": session.status, "result": result}

    @app.post("/api/runs/{run_id}/reconcile")
    def reconcile_run(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            result = orchestrator.reconcile_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        return {
            "run_id": result.run_id,
            "previous_status": result.previous_status,
            "status": result.status,
            "classification": result.classification,
            "resumable": result.resumable,
            "detail": result.detail,
        }

    @app.post("/api/runs/{run_id}/fanout")
    def fanout_run(run_id: str, request: FanoutRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            session = orchestrator.store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        parent_task_id = request.parent_task_id or (
            session.task_graph.tasks[0].task_id if session.task_graph and session.task_graph.tasks else None
        )
        if not parent_task_id:
            raise HTTPException(status_code=422, detail="run has no task to fan out")
        # Domain ValueErrors (terminal parent, unknown task, quorum) surface as the unified 400.
        result = orchestrator.spawn_child_runs(
            parent_run_id=run_id,
            parent_task_id=parent_task_id,
            children=[spec.model_dump() for spec in request.children],
            aggregation=request.aggregation,
            max_concurrency=request.max_concurrency,
            quorum=request.quorum,
        )
        child_run_ids = {child["child_run_id"] for child in result.children}
        parent_evidence = orchestrator.store.get_evidence(run_id)
        child_executions = [
            child.to_dict()
            for child in parent_evidence.child_executions
            if child.child_run_id in child_run_ids
        ]
        return {
            "parent_run_id": result.parent_run_id,
            "parent_task_id": result.parent_task_id,
            "policy": result.policy,
            "succeeded": result.succeeded,
            "total": result.total,
            "completed": result.completed,
            "failed": result.failed,
            "children": result.children,
            "child_executions": child_executions,
        }

    @app.post("/api/runs/{run_id}/expand")
    def expand_run(run_id: str, request: ExpandRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            new_tasks = [
                TaskNode(
                    task_id=spec.task_id or _id("task"),
                    role=WorkerRole(spec.role),
                    title=spec.title,
                    depends_on=list(spec.depends_on),
                )
                for spec in request.tasks
            ]
        except ValueError as exc:  # invalid worker role
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            session = orchestrator.expand_task_graph(run_id, new_tasks)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        # Domain ValueErrors (terminal/cycle/dangling/duplicate/live-thread) -> unified 400.
        return {
            "run_id": run_id,
            "added": [task.task_id for task in new_tasks],
            "task_ids": [task.task_id for task in session.task_graph.tasks],
        }

    @app.get("/api/runs/{run_id}/events")
    def get_events(run_id: str, _: None = Depends(require_control_token)) -> StreamingResponse:
        try:
            store.get_run(run_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="run events not found")

        def stream():
            terminal = {"completed", "failed", "cancelled", "WAITING_FOR_HUMAN_GATE"}

            def _frame(event: dict[str, Any]) -> str:
                # Durable run channel (DL5/T2): stamp the SQLite events.id as the
                # canonical event id (overriding the projector's synthetic id) and
                # emit it on the SSE `id:` line so the front-end reducer can dedup
                # by event.id across reconnects (the read restarts from last_id=0).
                payload = event["payload"]
                if isinstance(payload, dict):
                    payload = {**payload, "id": event["id"], "id_source": "sqlite"}
                return (
                    f"id: {event['id']}\n"
                    f"event: {event['type']}\n"
                    f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                )

            # Subscribe before the first read so no event committed after the
            # backfill read can be missed: a post-subscribe notify is queued and
            # the next wait() returns immediately.
            subscription = event_bus.subscribe(run_id)
            try:
                last_id = 0
                saw_terminal_event = False
                while True:
                    for event in store.list_events_after(run_id, last_id):
                        last_id = event["id"]
                        if event["type"] in _RUN_TERMINAL_EVENT_TYPES:
                            saw_terminal_event = True
                        yield _frame(event)
                    try:
                        session = store.get_run(run_id)
                    except KeyError:
                        break
                    if session.status in terminal:
                        # Terminate by STATUS, not by having seen a run.* terminal
                        # event: safe-write (DL8) may drop it, so requiring it would
                        # hang the stream forever (G1). But the run flow commits the
                        # terminal STATUS *before* the trailing run.* event
                        # (orchestrator save_run -> add_event), and a single doorbell
                        # wait() can be satisfied by a stale token from an
                        # already-drained event. So actively POLL a BOUNDED number of
                        # times for that trailing event rather than trusting one
                        # token: lossless in the common case, breaks early once it
                        # arrives, and a genuinely dropped event still closes the
                        # stream within the bound — anything missed from the LIVE
                        # stream is recovered via /events/snapshot on reconnect (DL5).
                        # If the terminal event already arrived (backfill / coalesced
                        # with earlier events), close IMMEDIATELY — no needless wait.
                        if not saw_terminal_event:
                            for _ in range(20):  # hard upper bound ~1s at 50ms
                                for event in store.list_events_after(run_id, last_id):
                                    last_id = event["id"]
                                    if event["type"] in _RUN_TERMINAL_EVENT_TYPES:
                                        saw_terminal_event = True
                                    yield _frame(event)
                                if saw_terminal_event:
                                    break
                                time.sleep(0.05)
                            else:
                                # Loop exhausted without the terminal event: do ONE
                                # final read so an event committed during the LAST
                                # sleep is still delivered (no last-window blind spot)
                                # before closing.
                                for event in store.list_events_after(run_id, last_id):
                                    last_id = event["id"]
                                    yield _frame(event)
                        break
                    # Wake instantly when a new event is committed; the 1s timeout
                    # is a safety net for events whose writer did not ring the bell
                    # (e.g. lease bookkeeping) and for terminal-status detection.
                    subscription.wait(timeout=1.0)
            finally:
                subscription.close()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/api/runs/{run_id}/events/snapshot")
    def get_events_snapshot(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Non-streaming terminal / replay snapshot (S1): structured events only
        (excludes *.delta), each carrying the durable SQLite id. The front-end pulls
        this once for a terminal run and feeds it through the SAME ToolCallCard
        reducer as the live SSE — so a terminal run renders its tool cards without
        re-subscribing to a full delta replay."""
        try:
            store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        snapshot_reader = getattr(store, "list_events_snapshot", None)
        if callable(snapshot_reader):
            events = _snapshot_events_with_ids(snapshot_reader(run_id), id_source="sqlite")
        else:
            # Frozen/older backend without the snapshot reader: degrade to a
            # filtered list_events (which gives no id) and signal the reducer to
            # fall back to ordered append (DL5 degraded shape), never crash.
            excluded = {"tool.delta", "reasoning.delta", "message.delta"}
            rows = [e for e in store.list_events(run_id) if e.get("type") not in excluded]
            events = _snapshot_events_with_ids(rows, id_source="none")
        return {
            "run_id": run_id,
            "events": events,
            "event_count": len(events),
            "latest_event": events[-1] if events else None,
        }

    @app.get("/api/runs/{run_id}/evidence")
    def get_evidence(run_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return store.get_evidence(run_id).to_dict()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="evidence not found") from exc

    @app.post("/v1/developer/plugins")
    def v1_developer_plugin_submission(
        request: DeveloperSubmissionCreateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return create_developer_submission_record("plugin", request, legacy_plugin_status=True)

    @app.post("/v1/developer/plugins/{submission_id}/artifact")
    def v1_developer_plugin_artifact(
        submission_id: str,
        request: DeveloperSubmissionArtifactRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return upload_developer_submission_artifact(submission_id, request, expected_kind="plugin")

    @app.get("/v1/developer/plugins/{submission_id}/verification")
    def v1_developer_plugin_verification(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        path = developer_submission_record_path(submission_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        return json.loads(path.read_text(encoding="utf-8"))

    @app.post("/v1/developer/capabilities")
    def v1_developer_capability_submission(
        request: DeveloperCapabilityCreateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return create_developer_submission_record(request.kind, request)

    @app.post("/v1/developer/capabilities/{submission_id}/artifact")
    def v1_developer_capability_artifact(
        submission_id: str,
        request: DeveloperSubmissionArtifactRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return upload_developer_submission_artifact(submission_id, request, capability_view=True)

    @app.get("/v1/developer/capabilities/{submission_id}/verification")
    def v1_developer_capability_verification(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        path = developer_submission_record_path(submission_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        record = json.loads(path.read_text(encoding="utf-8"))
        return sanitize_developer_submission_record(record, capability_view=True)

    @app.get("/v1/developer/capabilities/{submission_id}/status")
    def v1_developer_capability_status(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return v1_developer_capability_verification(submission_id)

    @app.post("/v1/capabilities/submissions")
    def v1_capability_review_submission(
        request: CapabilityReviewSubmissionRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return create_capability_review_submission_record(request)

    @app.get("/v1/capabilities/submissions/{submission_id}")
    def v1_capability_review_submission_status(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return v1_developer_capability_verification(submission_id)

    @app.get("/api/admin/capabilities/submissions")
    def api_admin_capability_submissions(_: None = Depends(require_control_token)) -> dict[str, Any]:
        submissions = list_developer_capability_submissions()
        return {"submissions": submissions, "count": len(submissions)}

    @app.get("/api/admin/capabilities/submissions/{submission_id}")
    def api_admin_capability_submission(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return admin_capability_submission_payload(submission_id)

    @app.post("/api/admin/capabilities/submissions/{submission_id}/review")
    def api_admin_capability_submission_review(
        submission_id: str,
        request: AdminCapabilityReviewRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return admin_publish_capability_submission(submission_id, request)

    @app.get("/api/admin/capabilities/registry/sync")
    def api_admin_capability_registry_sync(_: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            registry_source = os.environ.get("SUPERCLAW_CAPABILITY_REGISTRY_SOURCE") or os.environ.get(
                "SUPERCLAW_CAPABILITY_REGISTRY_URL"
            )
            manifests = list(latest_approved_capability_manifests(cloud_root(), source=registry_source))
        except (CapabilityRegistryError, OSError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=sanitize_developer_submission_error(exc)) from exc
        grouped = {kind: [item for item in manifests if item["kind"] == kind] for kind in ("plugin", "skill", "company")}
        return {
            "schema_version": "superclaw.capability_registry_sync.v1",
            "source": registry_source or "local",
            "capabilities": grouped,
            "items": manifests,
            "count": len(manifests),
        }

    @app.get("/api/admin/capabilities/{kind}/{capability_id}/versions/{version}/download")
    def api_admin_capability_download(
        kind: str,
        capability_id: str,
        version: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            return get_capability_registry_download_reference(
                cloud_root(),
                kind=kind,
                capability_id=capability_id,
                version=version,
            )
        except CapabilityRegistryError as exc:
            raise HTTPException(status_code=404, detail=sanitize_developer_submission_error(exc)) from exc

    @app.post("/v1/developer/skills")
    def v1_developer_skill_submission(
        request: DeveloperSubmissionCreateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return create_developer_submission_record("skill", request)

    @app.post("/v1/developer/skills/{submission_id}/artifact")
    def v1_developer_skill_artifact(
        submission_id: str,
        request: DeveloperSubmissionArtifactRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return upload_developer_submission_artifact(submission_id, request, expected_kind="skill", capability_view=True)

    @app.get("/v1/developer/skills/{submission_id}/verification")
    def v1_developer_skill_verification(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        path = developer_submission_record_path(submission_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("kind") != "skill":
            raise HTTPException(status_code=404, detail="developer submission not found")
        return sanitize_developer_submission_record(record, capability_view=True)

    @app.get("/v1/developer/skills/{submission_id}/status")
    def v1_developer_skill_status(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return v1_developer_skill_verification(submission_id)

    @app.post("/v1/developer/companies")
    def v1_developer_company_submission(
        request: DeveloperSubmissionCreateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return create_developer_submission_record("company", request)

    @app.post("/v1/developer/companies/{submission_id}/artifact")
    def v1_developer_company_artifact(
        submission_id: str,
        request: DeveloperSubmissionArtifactRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return upload_developer_submission_artifact(submission_id, request, expected_kind="company", capability_view=True)

    @app.get("/v1/developer/companies/{submission_id}/verification")
    def v1_developer_company_verification(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        path = developer_submission_record_path(submission_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="developer submission not found")
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("kind") != "company":
            raise HTTPException(status_code=404, detail="developer submission not found")
        return sanitize_developer_submission_record(record, capability_view=True)

    @app.get("/v1/developer/companies/{submission_id}/status")
    def v1_developer_company_status(submission_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return v1_developer_company_verification(submission_id)

    @app.post("/v1/clawhunt/ingestions")
    def v1_clawhunt_ingestions(request: ClawHuntIngestionRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        ingestion_id = _id("ing")
        output_root = Path(request.output_root) if request.output_root else clawhunt_ingestion_root() / "packages"
        try:
            result = ingest_clawhunt_delivery_plugin(
                Path(request.delivery_root),
                manifest_path=Path(request.manifest_path) if request.manifest_path else None,
                output_root=output_root,
            )
        except (ClawHuntPluginIngestionError, OSError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=sanitize_clawhunt_ingestion_error(exc)) from exc
        package_ref = clawhunt_ingestion_package_ref(result.plugin_id, result.version)
        record = {
            "schema_version": "0.1.0",
            "ingestion_id": ingestion_id,
            "status": "staged",
            "plugin_id": result.plugin_id,
            "version": result.version,
            "package_digest": result.package_digest,
            "source_digest": result.source_digest,
            "package_ref": package_ref,
            "requires_signing": True,
            "out_of_scope": [
                "production_clawhunt_cloud",
                "automatic_wrapper_synthesis",
                "production_signing",
                "registry_upload",
                "marketplace_listing",
                "payment",
                "settlement",
            ],
        }
        job_dir = clawhunt_ingestion_root() / "jobs"
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / f"{ingestion_id}.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return record

    @app.get("/v1/catalog")
    def v1_catalog(kind: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """Capability Workshop catalog contract backed by the CLI resolver."""
        return catalog_resolution(kind=kind).to_dict()

    @app.get("/v1/catalog/trust/{plugin_id}/{version}")
    def v1_catalog_trust(plugin_id: str, version: str, kind: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if kind is not None and kind not in CATALOG_KINDS:
            raise HTTPException(status_code=400, detail=f"unknown catalog kind: {kind!r}")
        derivation = resolve_trust_state(
            plugin_id,
            version,
            kind=kind,
            cache_root=plugin_cache_root(),
            cloud_root=cloud_root(),
            registry_root=default_registry_root(),
            companies_root=default_companies_root(),
            revocation_file=cloud_root() / "governance" / "revocations.json",
            company_revocation_file=default_company_revocation_file(),
        )
        return trust_derivation_to_dict(plugin_id, version, derivation)

    @app.post("/v1/catalog/refresh")
    def v1_catalog_refresh(request: CatalogRefreshRequest, _: None = Depends(require_control_token)) -> Any:
        result = refresh_catalog(registry_root=default_registry_root(), source_url=request.source_url, public_key=request.public_key)
        payload = result.to_dict()
        if not result.ok:
            return JSONResponse(status_code=503, content=payload)
        clear_catalog_cache()
        return payload

    @app.get("/v1/plugins")
    def v1_plugins(
        category: str | None = None,
        runtime: str | None = None,
        platform: str | None = None,
        acceptance_level: str | None = None,
        verified: str | None = None,
        pricing_model: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Local Phase 5B registry-search contract backed by fake-cloud files."""
        filters = {
            "category": category,
            "runtime": runtime,
            "platform": platform,
            "acceptance_level": acceptance_level,
            "verified": verified,
            "pricing_model": pricing_model,
        }
        resolution = catalog_resolution()
        catalog_items = catalog_items_by_plugin_ref(resolution)
        rows = [catalog_trust_backfill(row, catalog_items) for row in list_registry_plugins(cloud_root(), filters=filters)]
        return {"plugins": rows, "conflicts": list(resolution.conflicts)}

    @app.get("/v1/skills")
    def v1_skills(
        platform: str | None = None,
        acceptance_level: str | None = None,
        verified: str | None = None,
        pricing_model: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Native skill-store listing for the user-facing skill surface."""
        _ = (platform, acceptance_level, verified, pricing_model)
        return {
            "skills": [
                _native_skill_payload(record)
                for record in list_native_skills(revocation_file=default_skill_revocation_file())
            ],
            "conflicts": [],
        }

    @app.post("/v1/skills/import")
    def v1_skills_import(
        request: NativeSkillImportRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            record = import_native_skill(
                Path(request.path),
                label=request.label,
                publisher=request.publisher,
                source_url=request.source_url,
                signature=request.signature,
                public_key=request.public_key,
                importer=request.importer,
                allow_executable=request.allow_executable,
                force=request.force,
                revocation_file=default_skill_revocation_file(),
            )
        except SkillStoreError as exc:
            raise HTTPException(status_code=400, detail=_sanitize_native_skill_error(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail="native skill import failed validation") from exc
        return {"ok": True, "skill": _native_skill_payload(record)}

    @app.post("/v1/skills/sync")
    def v1_skills_sync(
        request: NativeSkillSyncRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            result = sync_native_skills(
                skill_slug=request.skill_slug,
                targets=tuple(request.targets) if request.targets else None,
                force=request.force,
                revocation_file=default_skill_revocation_file(),
            )
        except (SkillSyncError, OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=_sanitize_native_skill_error(exc)) from exc
        return {"ok": True, **result.to_dict()}

    @app.post("/v1/skills/build")
    def v1_skills_build(
        request: SkillBuildRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Build a SKILL.md into a governed, equippable `local` skill plugin.

        Surface parity with CLI `skill build` (铁律 2): same kernel call
        (build_and_install_skill_plugin), same validation/errors, same fields.
        Signing is optional; the kernel grades the result `local` by provenance.
        """
        try:
            result = build_and_install_skill_plugin(
                Path(request.path),
                plugin_id=request.plugin_id,
                version=request.version,
                developer_id=request.developer_id,
                sign=request.sign,
                signing_private_key=request.signing_private_key,
                cache_root=plugin_cache_root(),
                force=request.force,
            )
        except SkillBuildError as exc:
            raise HTTPException(
                status_code=400, detail=_sanitize_native_skill_error(exc, context="skill build")
            ) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail="skill build failed validation") from exc
        # The build wrote into the plugin cache; invalidate the memoized catalog so
        # the just-built skill is visible to catalog-backed surfaces immediately
        # (parity with every other install route — design §6 blocking gap 3).
        clear_catalog_cache()
        return {
            "ok": True,
            "skill": {
                "plugin_id": result.plugin_id,
                "version": result.version,
                "package_digest": result.package_digest,
                "trust_state": result.trust_state,
                "equippable": result.equippable,
                "signed": result.signed,
                "warnings": result.warnings,
            },
        }

    @app.get("/v1/plugins/{plugin_id}/versions/{version}")
    def v1_plugin_version(plugin_id: str, version: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return get_registry_plugin_version(cloud_root(), plugin_id, version)

    @app.get("/v1/plugins/{plugin_id}/versions/{version}/download")
    def v1_plugin_download(plugin_id: str, version: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return get_registry_download_reference(cloud_root(), plugin_id, version)

    @app.post("/v1/entitlements/sync")
    def v1_entitlements_sync(request: EntitlementSyncRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return sync_entitlements_for_device(
            cloud_root(),
            device_id=request.device_id,
            runtime_version=request.runtime_version,
            plugin_ids=request.plugin_ids,
        )

    @app.get("/v1/plugins/revocations")
    def v1_plugin_revocations(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return get_revocations(cloud_root())

    @app.get("/v1/policies/runtime")
    def v1_runtime_policy(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return get_runtime_policy(cloud_root())

    @app.post("/v1/evidence/plugin-invocations")
    def v1_evidence_plugin_invocations(request: EvidenceSummaryUploadRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        uploaded = store_evidence_summary(request.summary, cloud_root=cloud_root())
        return {"ok": True, "upload_id": uploaded.upload_id, "summary_digest": uploaded.summary_digest}

    @app.get("/api/runs/{run_id}/artifacts/{artifact_id}")
    def get_artifact(run_id: str, artifact_id: str, _: None = Depends(require_control_token)) -> Any:
        try:
            bundle = store.get_evidence(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="evidence not found") from exc
        artifact = next((item for item in bundle.artifacts if item.artifact_id == artifact_id), None)
        if not artifact:
            raise HTTPException(status_code=404, detail="artifact not found")
        fusion_ref_prefix = "superclaw-local://fusion/artifacts/"
        if artifact.path.startswith(fusion_ref_prefix):
            referenced_artifact_id = artifact.path.removeprefix(fusion_ref_prefix)
            if referenced_artifact_id != artifact_id:
                raise HTTPException(status_code=404, detail="artifact reference mismatch")
            try:
                return load_fusion_artifact(artifact_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail="fusion artifact not found") from exc
        try:
            session = store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="artifact path not allowed") from exc
        path = Path(artifact.path).resolve()
        allowed_root = _run_artifact_root(session.execution_context, run_id)
        if not _path_is_within(path, allowed_root):
            raise HTTPException(status_code=404, detail="artifact path not allowed")
        if not path.exists():
            raise HTTPException(status_code=404, detail="artifact file not found")
        return FileResponse(path)

    # FileViewError.code -> (HTTP status, client-safe message). The stable code
    # is always returned so the CLI/API/Web map the identical kernel code set
    # (zero-divergence); the HTTP status + message are API presentation only.
    # The remote-facing message is a fixed generic string per code — the raw
    # kernel message is never echoed to clients, so this surface cannot leak any
    # server path even if a future kernel message were to include one (structural
    # guarantee, not message-hygiene-dependent). 404 hides not-found/path
    # refusals, 403 trust/sensitivity, 409 tampered checkout, 413 too large.
    _FILE_VIEW_RESPONSE = {
        "not_found": (404, "file not found"),
        "path_not_allowed": (404, "file not found"),
        "untrusted_workspace": (403, "run checkout is not a trusted workspace"),
        "workspace_compromised": (409, "run checkout changed since the run started"),
        "sensitive_denied": (403, "file is sensitive and cannot be viewed"),
        "sensitive_scan_unbounded": (413, "file is too large to view safely"),
    }

    @app.get("/api/runs/{run_id}/files")
    def get_run_file(
        run_id: str,
        path: str = Query(..., description="Relative file path inside the run checkout"),
        max_bytes: int | None = Query(default=None, gt=0, le=FILE_VIEW_SCAN_CAP),
        _: None = Depends(require_control_token),
    ) -> Any:
        from superclaw.file_view import FILE_VIEW_MAX_BYTES, FileViewError, read_run_file

        limit = max_bytes or FILE_VIEW_MAX_BYTES
        try:
            result = read_run_file(store, run_id, path, max_bytes=limit)
        except FileViewError as exc:
            # Map through the known set only; an unrecognised code is collapsed to
            # a fixed "request_refused" so neither the status, message, NOR the
            # echoed code can carry an unexpected (possibly path-bearing) value.
            if exc.code in _FILE_VIEW_RESPONSE:
                status, message = _FILE_VIEW_RESPONSE[exc.code]
                code = exc.code
            else:
                status, message, code = 400, "request refused", "request_refused"
            raise HTTPException(
                status_code=status, detail={"code": code, "message": message}
            ) from exc
        return result.to_dict()

    # --- URL preview-proxy (docs §10). The Web fetches these via JS fetch() (so
    # it CAN send the control token) and injects the JSON into a sandboxed
    # <iframe srcdoc>. Auth is BOTH the control token (operator) AND the signed
    # ticket (binds a canonical URL + 60s TTL), so a ticket that leaks into an
    # access log is useless without the token. The kernel runs every SSRF / DoS /
    # sanitize guard. Responses are no-store so no surface caches the body/ticket.
    _PREVIEW_STATUS = {
        "blocked_protocol": 400, "blocked_private": 403, "blocked_dns": 502,
        "blocked_redirect": 400, "bad_content_type": 415, "too_large": 413,
        "timeout": 504, "throttled": 429, "fetch_failed": 502, "invalid_ticket": 401,
    }
    _PREVIEW_HEADERS = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }

    def _preview_refuse(exc: Any) -> HTTPException:
        status = _PREVIEW_STATUS.get(exc.code, 400)
        code = exc.code if exc.code in _PREVIEW_STATUS else "request_refused"
        return HTTPException(
            status_code=status, detail={"code": code, "message": exc.message}, headers=_PREVIEW_HEADERS
        )

    def _preview_sign_key() -> bytes:
        # The HMAC ticket key. Atomic create (temp file + os.replace) so a
        # concurrent reader can NEVER observe a 0-byte file and HMAC with an empty
        # key (which would let an attacker forge tickets). A non-32-byte file is
        # treated as corrupt and regenerated; the returned key is asserted 32 B.
        key_path = Path.home() / ".superclaw" / "preview-sign.key"
        try:
            key = key_path.read_bytes()
            if len(key) == 32:
                return key
        except FileNotFoundError:
            pass
        key_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = key_path.parent / f".preview-sign.key.{os.getpid()}.{secrets.token_hex(6)}.tmp"
        # Windows text-mode writes translate random LF bytes into CRLF, which
        # corrupts the fixed-length signing key. Keep these bytes binary.
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        try:
            os.write(fd, secrets.token_bytes(32))
        finally:
            os.close(fd)
        os.replace(str(tmp), str(key_path))  # atomic: readers see old-or-new, never partial
        key = key_path.read_bytes()  # converge on whatever atomically landed
        if len(key) != 32:
            raise HTTPException(
                status_code=500,
                detail={"code": "key_error", "message": "sign key unavailable"},
                headers=_PREVIEW_HEADERS,
            )
        return key

    def _preview_principal() -> str:
        # Bind the ticket to the current operator session: a rotated control
        # token changes the fingerprint and invalidates previously-minted tickets.
        token = current_control_token()
        return hashlib.sha256((token or "local").encode()).hexdigest()[:16]

    def _preview_unauthorized() -> HTTPException:
        return HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "control token required"},
            headers=_PREVIEW_HEADERS,
        )

    def _require_preview_token(
        request: Request,
        authorization: str | None = Header(default=None),
        x_superclaw_token: str | None = Header(default=None),
    ) -> None:
        # Auth for the preview endpoints. The control token is HEADER-ONLY (never
        # a ?token= query — the bearer ticket already sits in the URL, so the
        # token must not also land in the access log). When NO control token is
        # configured the endpoint is fail-closed to LOOPBACK callers only, so a
        # service bound to a non-loopback host without a token is never an open
        # unauthenticated preview proxy (the "local operator" assumption is
        # enforced, not just asserted).
        expected = current_control_token()
        if not expected:
            client_host = request.client.host if request.client else ""
            try:
                if ipaddress.ip_address(client_host).is_loopback:
                    return
            except ValueError:
                pass
            raise _preview_unauthorized()
        provided = x_superclaw_token
        if not provided and authorization and authorization.lower().startswith("bearer "):
            provided = authorization[7:].strip()  # never index-errors on a bare "Bearer "
        if not provided or not secrets.compare_digest(provided, expected):
            raise _preview_unauthorized()

    @app.post("/api/preview/tickets")
    def mint_preview_ticket(
        request: PreviewTicketRequest, _: None = Depends(_require_preview_token)
    ) -> Any:
        from superclaw.web_preview import (
            PreviewError,
            canonical_preview_url,
            sign_preview_ticket,
        )

        try:
            canonical = canonical_preview_url(request.url)
        except PreviewError as exc:
            raise _preview_refuse(exc) from exc
        ticket = sign_preview_ticket(
            canonical, _preview_principal(), _preview_sign_key(),
            now=time.time(), nonce=secrets.token_hex(8),
            allow_proxy=request.allow_proxy,
        )
        return JSONResponse(content={"ticket": ticket}, headers=_PREVIEW_HEADERS)

    @app.get("/api/preview/{ticket}")
    def get_preview(ticket: str, _: None = Depends(_require_preview_token)) -> Any:
        # Control token (operator, header-only) AND the signed ticket (URL+TTL)
        # are both required — a leaked ticket alone cannot be replayed.
        from superclaw.web_preview import (
            PreviewError,
            fetch_url_preview,
            verify_preview_ticket,
        )

        try:
            claims = verify_preview_ticket(
                ticket, _preview_sign_key(), now=time.time(), expected_principal=_preview_principal()
            )
            # Legacy tickets (pre-proxy) omit the claim -> default to allowed.
            result = fetch_url_preview(claims["url"], allow_proxy=bool(claims.get("allow_proxy", True)))
        except PreviewError as exc:
            raise _preview_refuse(exc) from exc
        return JSONResponse(content=result.to_dict(), headers=_PREVIEW_HEADERS)

    @app.post("/api/verify/adversarial")
    def adversarial_verify(request: VerifyRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            bundle = store.get_evidence(request.run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run evidence not found") from exc
        findings = apply_adversarial_profile(bundle)
        store.save_evidence(bundle)
        for finding in findings:
            store.add_event(request.run_id, "verification.finding", finding.__dict__)
        return {
            "run_id": request.run_id,
            "findings": [finding.__dict__ for finding in findings],
            "rule_specs": {name: spec.__dict__ for name, spec in adversarial_rule_specs().items()},
            "chain_verdict": bundle.chain_verdict.value,
        }

    @app.post("/api/clawhunt/submit")
    def clawhunt_submit(request: SubmitRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # Legacy direct submit: takes a bare run_id + problem_id and sends to
        # ClawHunt, bypassing the marketplace order ledger + issue completion gate +
        # submit approval (advisor阻断项 6, Codex: an ungoverned write path). DISABLED
        # by default (fail-closed); the governed path is the marketplace order saga +
        # `superclaw marketplace submit <order_id>`. A deliberate operator override
        # remains via SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1 (this endpoint already
        # requires a control token, so the override is operator-scoped).
        if os.environ.get("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE") != "1":
            raise HTTPException(
                status_code=403,
                detail=(
                    "direct /api/clawhunt/submit is disabled (bypasses the marketplace "
                    "order ledger + completion + approval gates); use the marketplace "
                    "order saga, or set SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE=1 to override"
                ),
            )
        try:
            bundle = store.get_evidence(request.run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run evidence not found") from exc
        submission = build_clawhunt_submission_payload(
            solution_text=default_solution_text(request.run_id),
            evidence=bundle,
            attachments=[f"superclaw-run:{request.run_id}"],
        )
        response = ClawHuntClient().submit_solution(request.problem_id, submission)
        if response.get("ok"):
            bundle.mark_submitted(response)
        else:
            bundle.add_finding("clawhunt_submission", False, f"submit failed with status {response.get('status_code')}", "high")
        store.save_evidence(bundle)
        return {"response": response}

    @app.post("/api/runs/{run_id}/protocol-export")
    def export_protocol_payload(
        run_id: str,
        request: ProtocolExportRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            session = store.get_run(run_id)
            goal = store.get_goal(session.goal_id)
            bundle = store.get_evidence(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run or evidence not found") from exc
        payload = build_clawhunt_delivery_protocol_payload(
            solution_text=default_solution_text(run_id),
            name=goal.title,
            summary=goal.description,
            evidence=bundle,
            github_pr_url=request.github_pr_url,
            github_pr_number=request.github_pr_number,
            attachments=[f"superclaw-run:{run_id}"],
        )
        return payload.to_dict()

    @app.get("/api/pay-switch/status")
    def pay_switch_status() -> dict[str, Any]:
        return {
            "mode": "governed_optional",
            "probe": ClawHuntClient().live_read_only_probe(),
        }

    @app.get("/api/pay-switch/config")
    def pay_switch_config() -> dict[str, Any]:
        base_url = os.environ.get("PAYSWITCH_BASE_URL") or os.environ.get("PAY_SWITCH_BASE_URL")
        payment_intent_url = os.environ.get("PAYSWITCH_PAYMENT_INTENT_URL")
        token = os.environ.get("PAYSWITCH_AGENT_TOKEN") or os.environ.get("PAY_SWITCH_AGENT_TOKEN")
        return {
            "mode": "governed_optional",
            "base_url_configured": bool(base_url),
            "payment_intent_configured": bool(payment_intent_url or base_url),
            "agent_token": "set" if token else "unset",
        }

    @app.get("/api/pay-switch/human-gate")
    def pay_switch_human_gate() -> dict[str, Any]:
        return {
            "mode": "run_pause_resume",
            "pause_status": "WAITING_FOR_HUMAN_GATE",
            "requires_human_for": ["payment", "login", "qr", "cvv", "otp", "final_authorization"],
        }

    @app.post("/api/pay-switch/payment-intent")
    def pay_switch_payment_intent(request: PaymentIntentRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if not request.confirm_governed_tool:
            raise HTTPException(status_code=403, detail="governed Pay-Switch tool confirmation required")

        base_url = os.environ.get("PAYSWITCH_BASE_URL") or os.environ.get("PAY_SWITCH_BASE_URL")
        endpoint = os.environ.get("PAYSWITCH_PAYMENT_INTENT_URL")
        if not endpoint and base_url:
            endpoint = base_url.rstrip("/") + "/api/payment-intents"
        if not endpoint:
            return {
                "status": "not_configured",
                "ok": False,
                "detail": "PAYSWITCH_BASE_URL or PAYSWITCH_PAYMENT_INTENT_URL is required for live payment-intent calls",
            }

        token = os.environ.get("PAYSWITCH_AGENT_TOKEN") or os.environ.get("PAY_SWITCH_AGENT_TOKEN")
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(timeout=20.0, trust_env=False) as client:
                response = client.post(
                    endpoint,
                    headers=headers,
                    json={"amount": request.amount, "currency": request.currency, "metadata": request.metadata},
                )
            try:
                body: Any = response.json()
            except ValueError:
                body = response.text[:1000]
            return {
                "status": "requested",
                "ok": 200 <= response.status_code < 300,
                "response": {"status_code": response.status_code, "body": body},
            }
        except httpx.HTTPError as exc:
            return {"status": "error", "ok": False, "detail": str(exc)}

    @app.post("/api/clawhunt/webhook")
    async def clawhunt_webhook(request: Request) -> dict[str, Any]:
        raw_body = await request.body()
        require_webhook_signature(request, raw_body)
        try:
            payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON payload") from exc
        event_type = str(payload.get("event_type") or payload.get("event") or "unknown")
        probe_id = payload.get("probe_id")
        probe_type = payload.get("probe_type")
        if event_type == "capability_probe" and probe_id:
            if probe_type == "file_transfer":
                return {
                    "probe_id": probe_id,
                    "result": {
                        "file_hash": "sha256:d0905bbe450c9315eae1a761dcfde4d36ca579069b2290431a750b122bff5c6e",
                        "file_size": 374,
                        "content_preview": "This is the CPH capability probe test file v1. It contains sample content for verifying that an AI a",
                    },
                }
            if probe_type == "visual_observation":
                return {
                    "probe_id": probe_id,
                    "result": {
                        "description": "The image shows a Login form with Email and Password fields and a Sign In button.",
                    },
                }
            return {"probe_id": probe_id, "result": {"status": "unsupported_probe_type", "probe_type": probe_type}}

        problem_payload = payload.get("problem") if isinstance(payload.get("problem"), dict) else {}
        problem_id = problem_payload.get("id") if isinstance(problem_payload, dict) else None
        goal = store.create_goal(
            GoalSpec(
                title=str(problem_payload.get("title") or f"ClawHunt webhook {event_type}"),
                description=json.dumps(payload, ensure_ascii=False),
                source="clawhunt",
                external_id=str(problem_id) if problem_id is not None else None,
                metadata={"event_type": event_type},
            )
        )
        item = {"event_type": event_type, "goal_id": goal.goal_id, "problem_id": problem_id}
        app.state.webhook_events.append(item)
        app.state.webhook_events = app.state.webhook_events[-100:]

        run_id = None
        if event_type == "problem_assigned" and os.environ.get("SUPERCLAW_WEBHOOK_AUTORUN", "").lower() in {"1", "true", "yes"}:
            session = orchestrator.create_run_session(goal, dry_run=False)
            run_id = session.run_id
            thread = threading.Thread(
                target=run_and_maybe_submit,
                args=(goal, session, int(problem_id) if problem_id is not None else None),
                daemon=True,
            )
            thread.start()
        return {"accepted": True, "event_type": event_type, "goal_id": goal.goal_id, "run_id": run_id}

    @app.get("/api/clawhunt/webhook-events")
    def clawhunt_webhook_events(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"events": app.state.webhook_events}

    web_dist = Path(__file__).resolve().parents[1] / "web" / "dist"
    if web_dist.exists():
        assets_dir = web_dist / "assets"

        @app.get("/")
        def web_index() -> FileResponse:
            return FileResponse(web_dist / "index.html")

        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="web-assets")

    # --- Agent Team Kernel surface (REST projection of the CLI kernel) ----
    #
    # GET routes return the same ui_contracts read models the CLI/TUI use.
    # POST routes call team_kernel — the identical code path `superclaw agent /
    # issue / approve` drives. No organization semantics live here; this is a
    # transport over the one kernel. Error codes mirror the kernel: unknown
    # entity -> 404, governance/lock conflict (the CLI's non-zero exit) -> 409.

    def _team_value_error(exc: ValueError) -> HTTPException:
        if isinstance(exc, BudgetGateError):
            return _budget_gate_conflict(exc)
        return HTTPException(status_code=409, detail=str(exc))

    def _team_bootstrap_template_source(request: TeamBootstrapTemplateRequest) -> dict[str, Any] | str:
        provided = [
            name
            for name, value in (
                ("template", request.template),
                ("from_template", request.from_template),
                ("company_catalog_id", request.company_catalog_id),
            )
            if value
        ]
        if len(provided) != 1:
            raise HTTPException(
                status_code=422,
                detail="provide exactly one of template, from_template, or company_catalog_id",
            )
        if request.company_catalog_id:
            # Resolve a CATALOGED company id -> its local source path via the SAME
            # kernel resolver the CLI uses (`--from-catalog`). The returned path is then
            # routed through the verify-before-instantiate gate downstream; the surface
            # never invents a path. A version is required when the id has multiple local
            # versions (fail-closed). Not found => 404.
            from superclaw.catalog_resolver import resolve_company_source_path
            from superclaw.company_template import CompanyTemplateError as _CompanyTemplateError

            version = request.company_version
            if not version:
                versions = _local_company_versions_for(request.company_catalog_id)
                if not versions:
                    raise HTTPException(status_code=404, detail=f"no local company source matches {request.company_catalog_id!r}")
                if len(versions) > 1:
                    raise HTTPException(
                        status_code=422,
                        detail=f"company {request.company_catalog_id!r} has multiple local versions; specify company_version",
                    )
                version = versions[0]
            try:
                return str(resolve_company_source_path(request.company_catalog_id, version, companies_root=default_companies_root()))
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except _CompanyTemplateError as exc:
                # Ambiguous: >1 local dir declares the same id@version (fail-closed) => 422.
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        if request.template is not None:
            # Inline company dicts have no file → no digest/signature → cannot be
            # verified by the verify-before-instantiate gate, so reject them at the
            # API edge with 422 (design §3.5). Legacy non-company inline templates
            # (agentcompanies/v1) keep working.
            if isinstance(request.template, dict) and request.template.get("kind") == "company":
                raise HTTPException(
                    status_code=422,
                    detail="inline company templates are not accepted; submit a signed .sccompany "
                    "package or a path to a verifiable company directory",
                )
            return request.template
        return request.from_template  # type: ignore[return-value]  # guaranteed truthy by the exactly-one check

    def _local_company_versions_for(plugin_id: str) -> list[str]:
        from superclaw.company_template import CompanyTemplateError, load_company_template

        root = default_companies_root()
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

    def _team_bootstrap_allow_local_opt_in(request: TeamBootstrapTemplateRequest) -> bool:
        if request.trust == "local":
            return True
        return company_local_dev_trust_enabled()

    def _team_bootstrap_proposal_payload(request: TeamBootstrapTemplateRequest) -> dict[str, Any]:
        try:
            # §3.8: the request-supplied lists are intersection HINTS only.
            # build_bootstrap_proposal derives the authoritative gated universe
            # from the fail-closed kernel enumerators, so a request that names an
            # ungated id can never have it appear as `granted`.
            proposal = build_bootstrap_proposal(
                _team_bootstrap_template_source(request),
                available_plugin_ids=request.available_plugin_ids,
                available_skill_ids=request.available_skill_ids,
                runtime_budget_seconds=request.runtime_budget_seconds,
                runtime_token_budget=request.runtime_token_budget,
                proposal_id=request.proposal_id,
                allow_local_opt_in=_team_bootstrap_allow_local_opt_in(request),
            )
        except CompanyTrustGateError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except TeamTemplateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return proposal.to_dict()

    def _team_bootstrap_commit_payload(request: TeamBootstrapTemplateRequest) -> dict[str, Any]:
        try:
            proposal = build_bootstrap_proposal(
                _team_bootstrap_template_source(request),
                available_plugin_ids=request.available_plugin_ids,
                available_skill_ids=request.available_skill_ids,
                runtime_budget_seconds=request.runtime_budget_seconds,
                runtime_token_budget=request.runtime_token_budget,
                proposal_id=request.proposal_id,
                allow_local_opt_in=_team_bootstrap_allow_local_opt_in(request),
            )
            return commit_bootstrap_proposal(
                store,
                proposal,
                requested_by=request.requested_by,
                allow_local_opt_in=_team_bootstrap_allow_local_opt_in(request),
            )
        except CompanyTrustGateError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except TeamTemplateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except BootstrapCommitError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/team/inventory")
    def team_inventory(
        workspace: str | None = None,
        company: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return build_team_inventory_payload(store, workspace_id=workspace, company_profile_id=company)

    def _company_export_payload(
        company_profile_id: str,
        *,
        include: list[str] | None,
        revision: str | None,
        include_files: bool,
    ) -> dict[str, Any]:
        """Shared helper: every company-export endpoint goes through the ONE
        contract (build_company_export_payload) so the API never forks the export
        shape from the CLI/Web. Unknown company → 404; over-budget → 413 (the
        kernel budgets the FILE-BODY map as it is built and aborts before
        materializing the full file bodies; lighter roster/manifest metadata is
        built first — see DEFAULT_MAX_EXPORT_BYTES)."""
        from superclaw.company_export import CompanyExportError, CompanyExportTooLarge

        # Accept both repeated (?include=issues&include=work-products) and
        # comma-joined (?include=issues,work-products) forms so a client can't
        # silently no-op an include by guessing the wrong delimiter.
        wanted = {token for value in (include or []) for token in value.split(",") if token}
        try:
            return build_company_export_payload(
                store,
                company_profile_id,
                include_issues="issues" in wanted,
                include_work_products=("work-products" in wanted or "work_products" in wanted),
                revision=revision,
                include_files=include_files,
            )
        except CompanyExportTooLarge as exc:  # subclass — must precede the 404 catch
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except CompanyExportError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/companies/{company_profile_id}/export/preview")
    def company_export_preview(
        company_profile_id: str,
        include: list[str] = Query(default=[]),
        revision: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Preview an export: manifest + file tree + warnings, WITHOUT file bodies
        — so a surface can show what would be written before downloading."""
        return _company_export_payload(
            company_profile_id, include=include, revision=revision, include_files=False
        )

    @app.post("/api/companies/{company_profile_id}/export")
    def company_export(
        company_profile_id: str,
        include: list[str] = Query(default=[]),
        revision: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Full export: manifest + file bodies + warnings, for a client that will
        write/zip the bundle itself."""
        return _company_export_payload(
            company_profile_id, include=include, revision=revision, include_files=True
        )

    @app.get("/api/companies/{company_profile_id}/export.zip")
    def company_export_zip(
        company_profile_id: str,
        include: list[str] = Query(default=[]),
        revision: str | None = None,
        _: None = Depends(require_control_token),
    ) -> StreamingResponse:
        """One-click zip download. Only the bundle's ``files`` enter the archive —
        never warnings or other operator metadata (a warning can echo a dropped
        local path), mirroring the CLI's disk-write contract."""
        import tempfile
        import zipfile

        from superclaw.company_export import is_safe_bundle_path

        # The kernel budgets the file-body map during construction (→ 413 here),
        # so an over-budget export aborts before its file bodies are fully built.
        payload = _company_export_payload(
            company_profile_id, include=include, revision=revision, include_files=True
        )
        files = payload.get("files") or {}
        # Spool to disk past 8 MiB so a large export never pins the full archive in
        # memory; small exports stay in RAM.
        spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        with zipfile.ZipFile(spool, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path, content in sorted(files.items()):
                # Second line of defense (same predicate the CLI writer uses): a
                # zip entry path must be a clean POSIX-relative path, so a crafted
                # entry can never traverse on extraction.
                if not is_safe_bundle_path(path):
                    raise HTTPException(status_code=500, detail=f"unsafe bundle path: {path!r}")
                zf.writestr(path, content)
        spool.seek(0)
        return StreamingResponse(
            spool,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{_export_zip_filename(company_profile_id)}"'},
        )

    # --- company custom logo (instance-level visual asset, not export logic) ---
    # All validation lives in the kernel set_company_logo gate the CLI also uses
    # (铁律2: CLI 与客户端 APP 必须功能统一); these endpoints are a thin transport
    # that only maps the kernel's typed failure codes onto HTTP status.
    _LOGO_ERROR_STATUS = {"empty": 400, "too_large": 413, "unsupported_type": 415}

    @app.post("/api/companies/{company_profile_id}/logo")
    async def company_set_logo(
        company_profile_id: str,
        request: Request,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Upload a company's custom logo as the raw request body.

        The image bytes are the body (Content-Type e.g. image/png) — no
        multipart dependency. The stream read is bounded to the limit + 1 byte so
        an oversized upload is rejected (413) without buffering the whole body in
        memory; the kernel gate then re-checks size/format/magic bytes
        authoritatively (the sniffed bytes win — a lying Content-Type cannot
        smuggle a non-image through).
        """
        from superclaw.company_logo import (
            COMPANY_LOGO_MAX_BYTES,
            CompanyLogoError,
            set_company_logo,
        )

        cap = COMPANY_LOGO_MAX_BYTES + 1
        buf = bytearray()
        async for chunk in request.stream():
            # Append only up to the remaining capacity so ``buf`` itself never
            # grows past cap, even if the ASGI layer hands us one huge chunk.
            if len(buf) < cap:
                buf.extend(chunk[: cap - len(buf)])
            if len(buf) >= cap:
                break  # at cap (= MAX + 1) — kernel rejects with too_large
        data = bytes(buf)
        try:
            profile = set_company_logo(store, company_profile_id, data)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown company profile") from exc
        except CompanyLogoError as exc:
            status = _LOGO_ERROR_STATUS.get(exc.code, 400)
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        return profile.to_dict()

    @app.get("/api/companies/{company_profile_id}/logo")
    def company_get_logo(company_profile_id: str) -> FileResponse:
        """Serve a company's custom logo for rendering.

        Deliberately ungated (mirrors the plugin-logo precedent) so a Web
        ``<img src>`` can load it. Returns 404 both for an unknown company and an
        unset/missing logo — no enumeration oracle — and the surface then falls
        back to its deterministic identicon.
        """
        from superclaw.company_logo import resolve_company_logo

        resolved = resolve_company_logo(store, company_profile_id)
        if resolved is None:
            raise HTTPException(status_code=404, detail="company logo not set")
        path, mime = resolved
        return FileResponse(
            path,
            media_type=mime,
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.delete("/api/companies/{company_profile_id}/logo")
    def company_clear_logo(
        company_profile_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Remove a company's custom logo (reverts the Web surface to its
        identicon). Idempotent; unknown company → 404."""
        from superclaw.company_logo import clear_company_logo

        try:
            profile = clear_company_logo(store, company_profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown company profile") from exc
        return profile.to_dict()

    @app.get("/api/team/agents")
    def team_agents(
        workspace: str | None = None,
        company: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return {
            "agents": [
                p.to_dict()
                for p in store.list_agent_profiles(workspace_id=workspace, company_profile_id=company)
            ]
        }

    @app.post("/api/team/catalog/preview")
    def team_catalog_preview(
        request: TeamBootstrapTemplateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        if request.mode != "proposal":
            raise HTTPException(status_code=422, detail="catalog preview only supports mode=proposal")
        return _team_bootstrap_proposal_payload(request)

    @app.post("/api/team/bootstrap")
    def team_bootstrap(
        request: TeamBootstrapTemplateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        if request.mode == "proposal":
            return _team_bootstrap_proposal_payload(request)
        return _team_bootstrap_commit_payload(request)

    @app.get("/api/team/agents/{profile_id}")
    def team_agent_detail(profile_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            profile = store.get_agent_profile(profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="agent profile not found") from exc
        resolution = team_kernel.resolve_equipment(profile)
        return {
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

    # --- Goal Mode (计划模式) -------------------------------------------------
    # Thin REST projection of the SAME goal_mode kernel the CLI drives (铁律1/2:
    # zero divergence — the API adds no business logic, only HTTP framing). The Web
    # '计划模式' toggle + confirmation dialog are surfaces over these endpoints.
    def _goal_http(exc: Exception) -> "HTTPException":
        from superclaw.goal_mode import GoalConflict, GoalRosterError
        from superclaw.state import GoalRevisionConflict

        if isinstance(exc, KeyError):
            return HTTPException(status_code=404, detail="goal not found")
        if isinstance(exc, (GoalRevisionConflict, GoalConflict)):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, GoalRosterError):
            return HTTPException(status_code=422, detail=str(exc))
        return HTTPException(status_code=422, detail=str(exc))

    # NOTE: a legacy GET /api/goals/{goal_id} (returns a bare GoalSpec) already
    # exists earlier in this module. To avoid shadowing it, the Goal-Mode lifecycle
    # contract is served top-level and the rich GoalRecord under a 2-segment path.
    @app.get("/api/goal-autonomy")
    def goal_autonomy_get(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The autonomous goal-continuation flag (PR8, default OFF)."""
        from superclaw.runtime_config import goal_autonomous_continuation_enabled

        return {"goal_autonomous_continuation": goal_autonomous_continuation_enabled()}

    @app.post("/api/goal-autonomy")
    def goal_autonomy_set(
        request: GoalAutonomyRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw.runtime_config import set_goal_autonomous_continuation

        set_goal_autonomous_continuation(bool(request.enabled))
        return {"goal_autonomous_continuation": bool(request.enabled)}

    @app.post("/api/goals/continue")
    def goals_continue(
        request: GoalContinueRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Run one autonomous-continuation tick — auto-start confirmed active goals. A
        no-op unless autonomy is enabled (or force=true). Each run keeps its own
        governance; this only decides WHEN an approved goal runs."""
        from superclaw import goal_mode

        continued = goal_mode.continue_active_goals(
            orchestrator,
            enabled=True if request.force else None,
            repo_path=request.repo_path or ".",
            budget_seconds=request.budget_seconds,
            max_goals=request.max_goals,
        )
        return {"continued": continued}

    @app.get("/api/goal-status-contract")
    def goal_status_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        """The Goal Mode status-machine contract (single source from the model). The
        agent/model/effort choices for the dialog come from /api/agents (the same
        runtime-linked inventory), so this is the lifecycle half of the contract."""
        from superclaw.ui_contracts import build_goal_status_contract

        return build_goal_status_contract()

    @app.get("/api/goals")
    def goals_list(
        status: str | None = None, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        statuses = {status} if status else None
        return {"goals": [r.to_dict() for r in store.list_goal_records(statuses=statuses)]}

    @app.get("/api/goals/{goal_id}/record")
    def goal_get_record(goal_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return store.get_goal_record(goal_id).to_dict()
        except KeyError as exc:
            raise _goal_http(exc) from exc

    @app.post("/api/goals/plan")
    def goal_plan(
        request: GoalPlanRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        try:
            record = goal_mode.plan_goal(
                store,
                title=request.title,
                description=request.description,
                topology=request.topology,
                metadata=request.metadata,
            )
        except ValueError as exc:
            raise _goal_http(exc) from exc
        return {"confirmation_required": True, "goal": record.to_dict()}

    @app.post("/api/goals/{goal_id}/confirm")
    def goal_confirm(
        goal_id: str, request: GoalConfirmRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        roster = None
        if request.roster:
            roster = {"entries": [e.model_dump() for e in request.roster]}
        try:
            budget = None
            if request.token_budget is not None or request.per_worker_tokens is not None:
                budget = {
                    "token_budget": request.token_budget or 0,
                    "per_worker_tokens": request.per_worker_tokens or 0,
                }
            record = goal_mode.confirm_goal(
                store,
                goal_id,
                expected_revision=request.revision,
                plan_hash=request.plan_hash,
                roster=roster,
                known_backends=set(orchestrator.backends),
                budget=budget,
            )
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        if not request.start:
            return {"goal": record.to_dict()}
        try:
            result = goal_mode.start_confirmed_goal_run(
                orchestrator,
                record,
                repo_path=request.repo_path or ".",
                budget_seconds=request.budget_seconds,
                dry_run=request.dry_run,
            )
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        fresh = store.get_goal_record(goal_id)
        return {"goal": fresh.to_dict(), "run": result.session.to_dict()}

    @app.post("/api/goals/{goal_id}/start")
    def goal_start(
        goal_id: str, request: GoalStartRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        try:
            record = store.get_goal_record(goal_id)
            result = goal_mode.start_confirmed_goal_run(
                orchestrator,
                record,
                repo_path=request.repo_path or ".",
                budget_seconds=request.budget_seconds,
                dry_run=request.dry_run,
            )
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        fresh = store.get_goal_record(goal_id)
        return {"goal": fresh.to_dict(), "run": result.session.to_dict()}

    @app.post("/api/goals/{goal_id}/revise")
    def goal_revise(
        goal_id: str, request: GoalReviseRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        try:
            record = goal_mode.revise_goal(store, goal_id, expected_revision=request.revision)
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        return record.to_dict()

    @app.post("/api/goals/{goal_id}/replan")
    def goal_replan(
        goal_id: str, request: GoalReplanRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        try:
            record = goal_mode.replan_goal(
                store,
                goal_id,
                expected_revision=request.revision,
                topology=request.topology,
                description=request.description,
            )
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        return record.to_dict()

    @app.post("/api/goals/{goal_id}/cancel")
    def goal_cancel(
        goal_id: str, request: GoalCancelRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        from superclaw import goal_mode

        try:
            record = goal_mode.cancel_goal(store, goal_id, expected_revision=request.revision)
        except (KeyError, ValueError) as exc:
            raise _goal_http(exc) from exc
        return record.to_dict()

    @app.get("/api/team/issues")
    def team_issues(
        workspace: str | None = None,
        status: str | None = None,
        company: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return {
            "issues": [
                i.to_dict()
                for i in store.list_issues(
                    workspace_id=workspace, status=status, company_profile_id=company
                )
            ]
        }

    @app.get("/api/team/approvals")
    def team_approvals(
        status: str | None = "pending",
        company: str | None = None,
        workspace: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        normalized = None if status in {"all", "*"} else status
        return build_approval_queue_payload(
            store, status=normalized, company_profile_id=company, workspace_id=workspace
        )

    @app.get("/api/team/messages")
    def team_messages(
        company: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Tiered Agent-company message roll-up (the "Agent 组" notification center).

        Pure read — projects the SAME kernel aggregation the CLI uses (no
        front-end / surface re-derivation). ``company`` narrows to one company;
        omitted = the all-companies view. The returned ``snapshot_as_of`` is the
        server-issued value the client MUST echo back to mark-read.
        """
        from superclaw.company_messages import build_company_messages_payload

        return build_company_messages_payload(store, company_profile_id=company)

    @app.post("/api/team/messages/mark-read")
    def team_messages_mark_read(
        request: TeamMessagesMarkReadRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Mark messages read by explicit item_keys OR by company (with the
        server-issued ``seen_as_of`` snapshot echoed from a prior GET). The kernel
        enforces XOR + clamps seen_as_of; a malformed selection is a 400."""
        from superclaw.company_messages import mark_messages_read

        try:
            return mark_messages_read(
                store,
                item_keys=request.item_keys,
                company_profile_id=request.company_profile_id,
                seen_as_of=request.seen_as_of,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/team/approvals/{approval_id}")
    def team_approval_detail(
        approval_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            return {"approval": store.get_approval(approval_id).to_dict()}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="approval not found") from exc

    @app.get("/api/team/board-inbox")
    def team_board_inbox(
        status: str | None = "pending",
        company: str | None = None,
        workspace: str | None = None,
        limit: int = Query(default=100, ge=1),
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Read-only board inbox over durable ESCALATE_TO_BOARD interactions."""
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
        return {
            "status_filter": normalized,
            "company_profile_id": company,
            "workspace_id": workspace,
            "count": len(rows),
            "items": rows,
        }

    def _board_inbox_interaction(interaction_id: str):
        # Bounded PK lookup; the ESCALATE_TO_BOARD gate + the resolve/assign mutation
        # live in team_kernel.*_board_inbox_item (the single source CLI/chat drive).
        try:
            interaction = store.get_issue_interaction(interaction_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="board inbox item not found") from None
        if interaction.continuation_policy != ContinuationPolicy.ESCALATE_TO_BOARD.value:
            raise HTTPException(status_code=409, detail="interaction is not a board inbox item")
        return interaction

    @app.post("/api/team/board-inbox/{interaction_id}/resolve")
    def team_board_inbox_resolve(
        interaction_id: str,
        request: TeamBoardInboxResolveRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Resolve a durable ESCALATE_TO_BOARD item without changing issue state."""
        interaction = _board_inbox_interaction(interaction_id)
        if interaction.status == "resolved":
            return {
                "action": "resolve",
                "status": "already_resolved",
                "resolved_by": request.by,
                "note": request.note,
                "interaction": interaction.to_dict(),
            }
        resolved = team_kernel.resolve_board_inbox_item(store, interaction_id)
        return {
            "action": "resolve",
            "status": "resolved",
            "resolved_by": request.by,
            "note": request.note,
            "interaction": resolved.to_dict(),
        }

    @app.post("/api/team/board-inbox/{interaction_id}/assign")
    def team_board_inbox_assign(
        interaction_id: str,
        request: TeamBoardInboxAssignRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Assign the board item's issue through the Team Kernel assignment gate."""
        interaction = _board_inbox_interaction(interaction_id)
        if interaction.status != "pending":
            raise HTTPException(status_code=409, detail=f"board inbox item is {interaction.status}, not pending")
        try:
            issue, resolved = team_kernel.assign_board_inbox_item(
                store, interaction_id, request.profile_id, resolve=request.resolve
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue or profile not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {
            "action": "assign",
            "status": "assigned",
            "resolved": resolved.status == "resolved",
            "issue": issue.to_dict(),
            "interaction": resolved.to_dict(),
        }

    def _routine_authoring_payload(spec: dict[str, Any]) -> dict[str, Any]:
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
                schedule, existing = store.save_team_routine_schedule(
                    result.to_team_routine_schedule()
                )
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            payload.update(
                {
                    "scheduled": True,
                    "created": not existing,
                    "schedule": schedule.to_dict(),
                }
            )
        return payload

    @app.post("/api/team/routines/author")
    def team_routine_author(
        request: TeamRoutineAuthorRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return _routine_authoring_payload(request.spec)

    @app.get("/api/team/routines")
    def team_routine_schedules(
        agent: str | None = None,
        enabled: bool | None = None,
        limit: int = Query(default=100, ge=1),
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        schedules = store.list_team_routine_schedules(
            agent_profile_id=agent, enabled=enabled, limit=limit
        )
        return {
            "agent_profile_id": agent,
            "enabled": enabled,
            "count": len(schedules),
            "schedules": [schedule.to_dict() for schedule in schedules],
        }

    @app.get("/api/team/routines/{routine_id}/runs")
    def team_routine_runs(
        routine_id: str,
        limit: int = Query(default=50, ge=1),
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        runs = store.list_routine_runs(routine_id, limit=limit)
        return {"routine_id": routine_id, "count": len(runs), "runs": runs}

    @app.get("/api/team/locks")
    def team_locks(workspace: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_workspace_locks_payload(store, workspace_id=workspace)

    @app.post("/api/team/agents")
    def team_create_profile(request: TeamProfileCreateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        profile = AgentProfile(
            name=request.name,
            role=request.role,
            title=request.title,
            workspace_id=request.workspace,
            company_profile_id=request.company,
            backend_policy=request.backend,
            model=request.model,
            effort=request.effort,
            permission_policy=_profile_permission_policy(request.permission),
            plugin_allowlist=list(request.plugin_allowlist),
            skill_allowlist=list(request.skill_allowlist),
            budget_seconds=request.budget_seconds,
            token_budget=request.token_budget,
            context_mode=request.context_mode,
            reports_to=request.reports_to,
            persona=request.persona,
            charter=request.charter,
            default_instructions=request.default_instructions,
            runtime_config=(
                {"heartbeat": {"enabled": True, "interval_sec": request.heartbeat_interval_sec}}
                if request.heartbeat_enabled
                else {}
            ),
        )
        try:
            store.save_agent_profile(profile)
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        resolution = team_kernel.resolve_equipment(profile)
        return {
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

    @app.patch("/api/team/agents/{profile_id}")
    def team_update_profile(
        profile_id: str,
        request: TeamProfileUpdateRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Edit an existing agent's config (Paperclip's per-agent settings edit).

        Calls the same kernel update as the CLI — only whitelisted fields move,
        identity/scope and the charter are rejected, and the creation-time
        fail-closed gates (permission, reports_to acyclicity, governance scope,
        skill projection) apply to every edit.
        """
        sent = request.model_fields_set
        patch: dict[str, Any] = {}
        if "title" in sent:
            patch["title"] = request.title
        if "backend" in sent:
            patch["backend_policy"] = request.backend
        if "model" in sent:
            patch["model"] = request.model
        if "effort" in sent:
            patch["effort"] = request.effort
        if "permission" in sent:
            patch["permission_policy"] = (
                {} if request.permission in (None, "inherit")
                else _profile_permission_policy(request.permission)
            )
        if "plugin_allowlist" in sent:
            patch["plugin_allowlist"] = list(request.plugin_allowlist or [])
        if "skill_allowlist" in sent:
            patch["skill_allowlist"] = list(request.skill_allowlist or [])
        if "budget_seconds" in sent:
            patch["budget_seconds"] = request.budget_seconds
        if "token_budget" in sent:
            patch["token_budget"] = request.token_budget
        if "context_mode" in sent:
            patch["context_mode"] = request.context_mode
        if "reports_to" in sent:
            patch["reports_to"] = request.reports_to
        if "persona" in sent:
            patch["persona"] = request.persona
        if "heartbeat_enabled" in sent:
            try:
                current = store.get_agent_profile(profile_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"unknown agent profile: {profile_id}") from exc
            patch["runtime_config"] = team_kernel.apply_heartbeat(
                current.runtime_config,
                enabled=bool(request.heartbeat_enabled),
                interval_sec=request.heartbeat_interval_sec,
            )
        if not patch:
            raise HTTPException(status_code=400, detail="empty patch: provide at least one field to update")
        try:
            profile, resolution = team_kernel.update_agent_profile(
                store, profile_id, patch=patch, expected_revision_id=request.expected_revision_id
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown agent profile: {profile_id}") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {
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

    @app.post("/api/team/agents/{profile_id}/charter")
    def team_update_charter(
        profile_id: str,
        request: TeamAgentCharterRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        # Single charter-write entry shared with the chat ``agent.charter`` command
        # (team_kernel.update_agent_charter) — no second inline write path.
        try:
            profile = team_kernel.update_agent_charter(
                store, profile_id, charter=request.charter, persona=request.persona
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="agent profile not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"profile": profile.to_dict()}

    @app.post("/api/team/agents/{profile_id}/request-config-change")
    def team_request_config_change(
        profile_id: str,
        request: TeamAgentConfigChangeRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            current = store.get_agent_profile(profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="agent profile not found") from exc
        sent = request.model_fields_set
        nullable_intent = {"by", "note", "heartbeat", "heartbeat_interval_sec"}
        explicit_nulls = [
            field
            for field in sent
            if field not in nullable_intent and getattr(request, field) is None
        ]
        if explicit_nulls:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"fields {sorted(explicit_nulls)} cannot be null; omit to leave "
                    "unchanged, or use reset values ('inherit' for permission, "
                    "'none' for reports_to)"
                ),
            )
        patch: dict[str, Any] = {}
        if "title" in sent:
            patch["title"] = request.title
        if "backend" in sent:
            patch["backend_policy"] = request.backend
        if "model" in sent:
            patch["model"] = request.model
        if "effort" in sent:
            patch["effort"] = request.effort
        if "permission" in sent:
            patch["permission_policy"] = (
                {} if request.permission in (None, "inherit")
                else _profile_permission_policy(request.permission)
            )
        if "heartbeat" in sent and request.heartbeat is not None:
            patch["runtime_config"] = team_kernel.apply_heartbeat(
                current.runtime_config,
                enabled=request.heartbeat,
                interval_sec=request.heartbeat_interval_sec,
            )
        if "skill_allowlist" in sent:
            patch["skill_allowlist"] = list(request.skill_allowlist or [])
        if "reports_to" in sent:
            patch["reports_to"] = (
                None
                if (request.reports_to or "").strip().lower() == "none"
                else request.reports_to
            )
        if "persona" in sent:
            patch["persona"] = request.persona
        try:
            approval = team_kernel.request_agent_config_change(
                store,
                target_profile_id=profile_id,
                patch=patch,
                requested_by=request.by,
                note=request.note or None,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="agent profile not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"approval": approval.to_dict()}

    @app.post("/api/team/agents/request-hire")
    def team_request_hire(
        request: TeamAgentHireRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        spec: dict[str, Any] = {
            "name": request.name,
            "role": request.role,
            "workspace_id": request.workspace,
            "company_profile_id": request.company,
            "backend_policy": request.backend,
            "model": request.model,
            "effort": request.effort,
            "skill_allowlist": list(request.skill_allowlist),
            "persona": request.persona,
            "charter": request.charter,
        }
        if request.title is not None:
            spec["title"] = request.title
        if request.reports_to is not None:
            spec["reports_to"] = request.reports_to
        if request.permission is not None:
            spec["permission_policy"] = _profile_permission_policy(request.permission)
        try:
            approval = team_kernel.request_hire(
                store,
                spec=spec,
                requested_by=request.by,
                note=request.note or None,
            )
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"approval": approval.to_dict()}

    @app.post("/api/team/issues")
    def team_create_issue(request: TeamIssueCreateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            # Construction validates the typed fields (Issue.__post_init__), so build
            # INSIDE the try: an invalid kind/review_policy surfaces the same 409 as a
            # save-gate ValueError, not a 500.
            issue = Issue(
                title=request.title,
                description=request.description,
                workspace_id=request.workspace,
                company_profile_id=request.company,
                priority=request.priority,
                kind=request.kind,
                review_policy=request.review_policy,
                goal_id=request.goal,
                parent_id=request.parent,
            )
            store.save_issue(issue)
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/delegate")
    def team_delegate_issue(issue_id: str, request: TeamIssueDelegateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            child = team_kernel.delegate_sub_issue(
                store, issue_id, assignee_agent_profile_id=request.profile_id,
                title=request.title, description=request.description, requested_by=request.by,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="parent issue or profile not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": child.to_dict()}

    # --- Governance namespace: company / workspace ------------------------

    @app.get("/api/team/companies")
    def team_companies(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"companies": [c.to_dict() for c in store.list_company_profiles()]}

    @app.get("/api/team/companies/{company_profile_id}")
    def team_company_detail(
        company_profile_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            return {"company": store.get_company_profile(company_profile_id).to_dict()}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="company not found") from exc

    @app.get("/api/team/companies/{company_profile_id}/snapshot")
    def team_company_snapshot(
        company_profile_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """Bounded dashboard snapshot of ONE company (roster + issue counts + cost).

        Thin projection of ``company_read.build_company_snapshot_payload`` — the SAME
        DTO the CLI (``company snapshot``) and the chat ``company_snapshot`` tool
        consume, so the three surfaces never drift (roadmap P0)."""
        from superclaw.company_read import build_company_snapshot_payload

        try:
            return build_company_snapshot_payload(store, company_profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="company not found") from exc

    @app.post("/api/team/companies")
    def team_create_company(request: TeamCompanyCreateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if request.repo_path and request.repo_url:
            raise HTTPException(status_code=422, detail="repo_path and repo_url are mutually exclusive")
        company = CompanyProfile(
            name=request.name, goal=request.goal,
            default_budget_seconds=request.default_budget_seconds,
            default_token_budget=request.default_token_budget,
        )
        workspace = None
        if request.repo_path or request.repo_url:
            # Pre-validate before persisting (governance scope needs the
            # company row before its workspace; avoid half-initialized state).
            if request.repo_path:
                existing = workspace_resolver.find_workspace_for_path(store, request.repo_path)
                if existing is not None and existing.company_profile_id != "local":
                    raise HTTPException(
                        status_code=409,
                        detail=f"workspace {existing.workspace_id} already belongs to company "
                        f"{existing.company_profile_id}",
                    )
                if existing is None:
                    try:
                        workspace_resolver.assert_safe_workspace_root(request.repo_path)
                    except workspace_resolver.WorkspaceRootRejected as exc:
                        raise HTTPException(status_code=409, detail=str(exc)) from exc
            store.save_company_profile(company)
            try:
                workspace = workspace_resolver.materialize_company_workspace(
                    store,
                    company.company_profile_id,
                    company.name,
                    repo=request.repo_path,
                    repo_url=request.repo_url,
                    trust_source="api",
                )
            except (workspace_resolver.WorkspaceRootRejected, ValueError) as exc:
                raise HTTPException(
                    status_code=409,
                    detail=f"company {company.company_profile_id} created but workspace "
                    f"binding failed: {exc}",
                ) from exc
        else:
            store.save_company_profile(company)
        payload: dict[str, Any] = {"company": company.to_dict()}
        if workspace is not None:
            payload["workspace"] = workspace.to_dict()
        return payload

    @app.post("/api/team/companies/commands")
    def team_company_command(
        request: TeamCompanyCommandRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Run a chat-driven company-management command via the shared handler.

        Thin projection of ``company_handler.execute_company_command`` — the SAME
        kernel entry the CLI (`superclaw company ...`) and the chat tool
        projection use. The REST layer adds NO business logic: it (1) resolves the
        typed command model from ``command_type``, (2) builds it from ``payload``
        (fail-closed: unknown fields rejected by ``from_dict``), (3) injects a
        SERVER-side operator scope mirroring the CLI's ``_cli_operator_scope``
        (``is_admin`` / ``principal_id`` are fixed here, NEVER read from the body),
        (4) dispatches, and (5) maps the handler's outcome / typed errors onto
        HTTP — exactly as the CLI maps them onto JSON/exit codes (zero drift).
        """
        from superclaw.company_commands import get_command_model
        from superclaw.company_handler import execute_company_command
        from superclaw.company_lifecycle import CompanyFrozenError
        from superclaw.company_scope import CompanyScope, CompanyScopeError

        try:
            model = get_command_model(request.command_type)
        except KeyError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"unknown company command type: {request.command_type!r}",
            ) from exc
        try:
            command = model.from_dict(request.payload)
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # Authority is SERVER-injected (mirrors the CLI operator scope): a single
        # local user who is an admin over their own companies. The body may carry
        # a target company anchor, but never is_admin / principal_id.
        scope = CompanyScope(
            principal_id="api_operator",
            actor_company_id=request.actor_company_id,
            allowed_company_ids=frozenset(),
            is_admin=True,
        )
        try:
            result = execute_company_command(
                command, scope=scope, store=store, requested_by="api_operator"
            )
        except CompanyScopeError as exc:
            raise HTTPException(status_code=403, detail=exc.reason) from exc
        except CompanyFrozenError as exc:
            # A frozen/dissolved target is a conflict (the lifecycle gate). Caught
            # BEFORE the generic ValueError branch because CompanyFrozenError IS a
            # ValueError subclass.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"unknown id: {exc.args[0] if exc.args else exc}",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if result.outcome == "pending_approval":
            approval_id = result.detail.get("approval_id")
            return {
                "outcome": result.outcome,
                "risk": result.verdict.tier,
                "approval_id": approval_id,
                "detail": result.detail,
                "hint": (
                    f"archive needs confirmation: approve via "
                    f"POST /api/team/approvals/{approval_id}/grant "
                    f"(or the Web approvals inbox)"
                ),
            }
        return {
            "outcome": result.outcome,
            "risk": result.verdict.tier,
            "detail": result.detail,
        }

    @app.post("/api/marketplace/commands")
    def marketplace_command(
        request: MarketplaceCommandRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Run a governed ClawHunt marketplace command via the shared handler.

        Thin projection of ``marketplace_handler.execute_marketplace_command`` — the
        SAME kernel entry the CLI (`superclaw marketplace ...`) and chat tool
        projection use. REST adds NO business logic: resolve typed command from
        ``command_type``, build from ``payload`` (fail-closed from_dict), inject a
        SERVER operator scope (authority never from body), dispatch, map outcome /
        errors to HTTP. Reads → executed; writes → pending_approval (human-gated).
        """
        from superclaw.company_lifecycle import CompanyFrozenError
        from superclaw.company_scope import CompanyScope, CompanyScopeError
        from superclaw.marketplace_commands import get_marketplace_command_model
        from superclaw.marketplace_handler import (
            MarketplaceAuthError,
            execute_marketplace_command,
        )

        try:
            model = get_marketplace_command_model(request.command_type)
        except KeyError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"unknown marketplace command type: {request.command_type!r}",
            ) from exc
        # Zero-new-surface-semantics (advisor阻断项, Codex): the API must expose ONLY
        # the governed commands the CLI exposes. The CLI `marketplace` group is the
        # SOLVER surface (browse/inspect/post/bid/claim/submit/abandon); buyer-side
        # accept/accept_bid are NOT governed CLI commands, so the API must not become
        # a new business entry for them. Reject buyer_side here until they have a
        # governed CLI + tests (kept fail-closed, not silently exposed).
        if getattr(model, "buyer_side", False):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"marketplace command {request.command_type!r} is buyer/payment-side "
                    f"and not exposed via the governed API (no governed CLI parity)"
                ),
            )
        try:
            command = model.from_dict(request.payload)
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        scope = CompanyScope(
            principal_id="api_operator",
            actor_company_id=request.actor_company_id,
            allowed_company_ids=frozenset(),
            is_admin=True,
        )
        try:
            result = execute_marketplace_command(
                command, scope=scope, store=store, requested_by="api_operator"
            )
        except MarketplaceAuthError as exc:
            # No connected agent key — a precondition failure, not an auth-z 403.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except CompanyScopeError as exc:
            raise HTTPException(status_code=403, detail=exc.reason) from exc
        except CompanyFrozenError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"unknown id: {exc.args[0] if exc.args else exc}"
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        payload: dict[str, Any] = {
            "outcome": result.outcome,
            "risk": result.verdict.tier,
            "detail": result.detail,
        }
        if result.outcome == "pending_approval":
            approval_id = result.detail.get("approval_id")
            payload["approval_id"] = approval_id
            payload["hint"] = (
                f"marketplace write needs confirmation: approve via "
                f"POST /api/team/approvals/{approval_id}/grant (the remote ClawHunt "
                f"action runs only on grant — payment never on the default path)"
            )
        return payload

    @app.get("/api/marketplace/orders")
    def marketplace_orders(
        status: str | None = None,
        company: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        """List marketplace order ledger rows (the claim → deliver → submit saga)."""
        orders = store.list_marketplace_orders(status=status, company_profile_id=company)
        return {"count": len(orders), "orders": [o.to_dict() for o in orders]}

    @app.get("/api/marketplace/orders/{order_id}")
    def marketplace_order_detail(
        order_id: str, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            order = store.get_marketplace_order(order_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown order: {order_id}") from exc
        return order.to_dict()

    @app.post("/api/marketplace/orders/advance")
    def marketplace_order_advance(
        request: MarketplaceAdvanceRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        """Drive a claimed order's saga forward (idempotent; same as CLI `marketplace advance`)."""
        from superclaw.marketplace_saga import advance_hint, advance_marketplace_order

        try:
            store.get_marketplace_order(request.order_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown order: {request.order_id}") from exc
        seen: set[str] = set()
        order = None
        try:
            for _ in range(8):
                order = advance_marketplace_order(
                    store, request.order_id, orchestrator=orchestrator,
                    requested_by="api_operator", repo_path=request.repo_path,
                    backend_policy=request.backend_policy, budget_seconds=request.budget_seconds,
                )
                if order.status in seen:
                    break
                seen.add(order.status)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "order_id": order.order_id,
            "status": order.status,
            "issue_id": order.issue_id,
            "run_id": order.run_id,
            "last_error": order.last_error,
            # Same operator next-step hint the CLI emits (shared source, zero drift).
            "hint": advance_hint(order.status),
        }

    @app.get("/api/team/workspaces")
    def team_workspaces(company: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"workspaces": [w.to_dict() for w in store.list_workspace_profiles(company_profile_id=company)]}

    @app.post("/api/team/workspaces")
    def team_create_workspace(request: TeamWorkspaceCreateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            team_kernel.validate_workspace_concurrency(request.repo_path, request.concurrency)
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        workspace = WorkspaceProfile(
            name=request.name, company_profile_id=request.company, repo_path=request.repo_path,
            writable_paths=list(request.writable_paths), network_policy=request.network_policy,
            concurrency=request.concurrency,
        )
        try:
            store.save_workspace_profile(workspace)
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"workspace": workspace.to_dict()}

    @app.post("/api/team/workspaces/trust")
    def team_trust_workspace(
        request: TeamWorkspaceTrustRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        existing = workspace_resolver.find_workspace_for_path(store, request.path)
        if existing is not None:
            if not existing.is_trusted:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"workspace {existing.workspace_id} already exists but "
                        f"is {existing.trust_status}"
                    ),
                )
            if request.company != "local" and existing.company_profile_id != request.company:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"workspace {existing.workspace_id} belongs to company "
                        f"{existing.company_profile_id}, not {request.company}"
                    ),
                )
            return {"workspace": existing.to_dict(), "created": False}
        try:
            created = workspace_resolver.create_trusted_workspace(
                store,
                request.path,
                name=request.name,
                trust_source="api",
                company_profile_id=request.company,
            )
        except workspace_resolver.WorkspaceRootRejected as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"workspace": created.to_dict(), "created": True}

    @app.post("/api/team/workspaces/{workspace_id}/containment")
    def team_set_workspace_containment(
        workspace_id: str, request: TeamWorkspaceContainmentRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        # Kernel-identical to `workspace containment` (T11): set the runtime fence
        # for a workspace. Unknown preset / workspace fail closed.
        from superclaw.containment import CONTAINMENT_PRESETS

        if request.preset not in CONTAINMENT_PRESETS:
            raise HTTPException(status_code=422, detail=f"unknown containment preset: {request.preset}")
        try:
            workspace = store.get_workspace_profile(workspace_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc
        workspace.containment_preset = request.preset
        store.save_workspace_profile(workspace)
        return {"workspace": workspace.to_dict()}

    # --- Cost tracing: run-layer ledger (Chat + Team read the same ledger) -

    @app.get("/api/cost/events")
    def cost_events(
        run: str | None = None, chat: str | None = None, agent: str | None = None,
        issue: str | None = None, company: str | None = None,
        today: bool = False, since: str | None = None, until: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        # Same window resolver the CLI uses — zero CLI/API divergence.
        try:
            since_epoch, until_epoch = resolve_cost_window(today=today, since=since, until=until)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        events = store.list_cost_events(
            run_id=run, chat_session_id=chat, agent_profile_id=agent, issue_id=issue,
            company_profile_id=company, since=since_epoch, until=until_epoch,
        )
        return {"events": [e.to_dict() for e in events]}

    @app.get("/api/cost/summary")
    def cost_summary(
        run: str | None = None, chat: str | None = None, agent: str | None = None,
        issue: str | None = None, company: str | None = None,
        today: bool = False, since: str | None = None, until: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            since_epoch, until_epoch = resolve_cost_window(today=today, since=since, until=until)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return store.summarize_cost(
            run_id=run, chat_session_id=chat, agent_profile_id=agent, issue_id=issue,
            company_profile_id=company, since=since_epoch, until=until_epoch,
        )

    @app.post("/api/team/issues/{issue_id}/assign")
    def team_assign_issue(issue_id: str, request: TeamIssueAssignRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            issue = team_kernel.assign_issue(store, issue_id, request.profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue or profile not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/checkout")
    def team_checkout_issue(issue_id: str, request: TeamIssueCheckoutRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        token = request.run_id or _id("run")
        try:
            issue = team_kernel.checkout_issue(store, issue_id, run_id=token, holder=request.holder)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/submit")
    def team_submit_issue(issue_id: str, request: TeamIssueSubmitRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            issue, approval = team_kernel.submit_for_review(store, issue_id, requested_by=request.by, summary=request.summary)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        # approval is None for a no_completion_gate issue: the kernel auto-completed
        # it (no human gate), so there is no approval to grant.
        return {
            "issue": issue.to_dict(),
            "approval": approval.to_dict() if approval is not None else None,
            "auto_completed": approval is None,
        }

    @app.get("/api/team/issues/{issue_id}/comments")
    def team_issue_comments(issue_id: str, limit: int = Query(default=200, ge=1), _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            store.get_issue(issue_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        return {
            "comments": [c.to_dict() for c in store.list_issue_comments(issue_id, limit=limit)],
            "interactions": [i.to_dict() for i in store.list_issue_interactions(issue_id=issue_id)],
        }

    @app.get("/api/team/issues/{issue_id}/runs")
    def team_issue_runs(issue_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        """The issue run ledger: the recent wakeups/runs that targeted this issue
        (bounded scan, newest-first), each with a normalized status (running /
        failed / timed_out / no_response / deferred / waiting / …) plus the failure
        reason (exit_code / timed_out) — a read-only projection of existing
        StateStore facts so the surface can show *why* an issue is stuck."""
        try:
            store.get_issue(issue_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        return build_issue_run_ledger(store, issue_id).to_dict()

    @app.post("/api/team/issues/{issue_id}/comments")
    def team_issue_comment(issue_id: str, request: TeamIssueCommentRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            comment, interactions = team_kernel.post_issue_comment(
                store, issue_id, body=request.body, author_type=request.author_type, author_id=request.author
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"comment": comment.to_dict(), "interactions": [i.to_dict() for i in interactions]}

    @app.get("/api/team/issues/{issue_id}/work-products")
    def team_issue_work_products(issue_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            products = team_kernel.list_work_products(store, issue_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        return {"work_products": [wp.to_dict() for wp in products]}

    @app.post("/api/team/issues/{issue_id}/work-products")
    def team_attach_work_product(issue_id: str, request: TeamWorkProductRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            wp = team_kernel.attach_work_product(
                store, issue_id, type=request.type, title=request.title, url=request.url,
                provider=request.provider, external_id=request.external_id, status=request.status,
                summary=request.summary, is_primary=request.is_primary,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"work_product": wp.to_dict()}

    @app.patch("/api/team/work-products/{work_product_id}")
    def team_update_work_product(work_product_id: str, request: TeamWorkProductUpdateRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            wp = team_kernel.update_work_product(
                store, work_product_id, status=request.status, title=request.title,
                url=request.url, summary=request.summary, is_primary=request.is_primary,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="work product not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"work_product": wp.to_dict()}

    @app.delete("/api/team/work-products/{work_product_id}")
    def team_remove_work_product(work_product_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        return {"removed": team_kernel.remove_work_product(store, work_product_id)}

    @app.post("/api/team/issues/{issue_id}/block")
    def team_issue_block(issue_id: str, request: TeamIssueBlockRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            issue = team_kernel.block_issue(store, issue_id, reason=request.reason, by=request.by, unblock_owner=request.unblock_owner)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/unblock")
    def team_issue_unblock(issue_id: str, request: TeamIssueUnblockRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            issue = team_kernel.unblock_issue(store, issue_id, by=request.by, note=request.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/requeue")
    def team_issue_requeue(issue_id: str, request: TeamIssueRequeueRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            issue = team_kernel.abort_checkout(store, issue_id, holder=request.holder)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"issue": issue.to_dict()}

    @app.post("/api/team/issues/{issue_id}/hold")
    def team_issue_hold(issue_id: str, request: TeamIssueHoldRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # A hold is a ledger marker, not a status — kernel-identical to `issue hold`.
        try:
            hold = team_kernel.hold_issue(store, issue_id, reason=request.reason, by=request.by)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"hold": hold.to_dict()}

    @app.post("/api/team/issues/{issue_id}/unhold")
    def team_issue_unhold(issue_id: str, request: TeamIssueUnholdRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            hold = team_kernel.release_issue_hold(store, issue_id, by=request.by)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"hold": hold.to_dict()}

    @app.get("/api/team/issues/{issue_id}/tree")
    def team_issue_tree(issue_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # Read-only preview powering the "this affects N issues" confirmation.
        try:
            return team_kernel.preview_issue_tree(store, issue_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc

    @app.post("/api/team/issues/{issue_id}/tree/pause")
    def team_issue_tree_pause(issue_id: str, request: TeamIssueTreeOpRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        # cancel_run comes from THIS app's orchestrator so active runs actually
        # stop; the kernel governance (holds, lock release) is identical to CLI.
        try:
            return team_kernel.pause_issue_tree(
                store, issue_id, by=request.by, reason=request.reason,
                run_canceller=orchestrator.cancel_run,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc

    @app.post("/api/team/issues/{issue_id}/tree/resume")
    def team_issue_tree_resume(issue_id: str, request: TeamIssueTreeOpRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return team_kernel.resume_issue_tree(
                store, issue_id, by=request.by, operation_id=request.operation_id
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc

    @app.post("/api/team/issues/{issue_id}/tree/cancel")
    def team_issue_tree_cancel(issue_id: str, request: TeamIssueTreeOpRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            return team_kernel.cancel_issue_tree(
                store, issue_id, by=request.by, reason=request.reason,
                run_canceller=orchestrator.cancel_run,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="issue not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc

    @app.get("/api/team/wakeups")
    def team_wakeups(
        agent: str | None = None, status: str | None = None, limit: int = Query(default=100, ge=1),
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        return {
            "wakeups": [
                w.to_dict()
                for w in store.list_wakeups(agent_profile_id=agent, status=status, limit=limit)
            ]
        }

    @app.post("/api/backup")
    def backup_state(_: None = Depends(require_control_token)) -> dict[str, Any]:
        # A consistent SQLite snapshot via the online backup API (safe while the
        # store is in use). The path is server-derived and anchored NEXT TO the
        # state DB (never client-supplied, never the process cwd), so a control-
        # token holder cannot write the snapshot to an arbitrary path and a server
        # launched from any cwd snapshots the right project.
        path = store.backup()
        return {"backup": str(path), "schema_version": store.schema_version()}

    @app.get("/api/team/daemon/status")
    def team_daemon_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        # Observation only (CLI parity: `superclaw daemon status` minus pid —
        # the API cannot probe another host's processes).
        settings = store.get_instance_settings()
        counts = {
            status: len(store.list_wakeups(status=status, limit=10_000))
            for status in ("queued", "claimed", "finished", "skipped")
        }
        # engine_running reflects the in-process drain loop only (the channel that
        # services event-driven wakeups). It does NOT probe a separate
        # `superclaw daemon start` process — the API cannot see another host's
        # PIDs. The surface uses this to tell the operator WHY a queued wakeup is
        # not moving: queued > 0 with engine_running false means "nothing is
        # draining the queue — open the engine".
        return {
            "heartbeat_enabled": bool(settings.general.get("heartbeat_enabled", False)),
            "autostart_enabled": bool(settings.general.get("daemon_autostart", True)),
            "engine_running": bool(getattr(app.state, "heartbeat_daemon_running", False)),
            "wakeups": counts,
        }

    @app.get("/api/team/daemon/broker/status")
    def team_daemon_broker_status(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return app.state.daemon_broker_control.status_payload()

    @app.post("/api/team/daemon/broker/sessions")
    def team_daemon_broker_open_session(
        request: DaemonBrokerOpenSessionRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        session = app.state.daemon_broker_control.open_session(
            subject=request.subject,
            ttl_seconds=request.ttl_seconds,
        )
        return {"session": session.to_status_payload()}

    @app.post("/api/team/daemon/broker/tokens")
    def team_daemon_broker_issue_token(
        request: DaemonBrokerIssueTokenRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        token, metadata = app.state.daemon_broker_control.issue_token(
            request.session_id,
            request.scopes,
            ttl_seconds=request.ttl_seconds,
            subject=request.subject,
        )
        return {"token": token, "metadata": metadata.to_status_payload()}

    @app.post("/api/team/daemon/broker/tokens/validate")
    def team_daemon_broker_validate_token(
        request: DaemonBrokerValidateTokenRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        metadata = app.state.daemon_broker_control.validate_token(
            request.token,
            required_scope=request.required_scope,
        )
        return {"valid": metadata is not None, "metadata": metadata.to_status_payload() if metadata else None}

    @app.post("/api/team/daemon/broker/materializations")
    def team_daemon_broker_materialize(
        request: DaemonBrokerMaterializeRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            materialized = app.state.daemon_broker_control.materialize_plugin_view(
                request.token,
                plugin_id=request.plugin_id,
                manifest=request.manifest,
                files=request.files,
            )
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"materialization": materialized.to_status_payload()}

    @app.delete("/api/team/daemon/broker/sessions/{session_id}")
    def team_daemon_broker_close_session(
        session_id: str,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        app.state.daemon_broker_control.close_session(session_id)
        return {"closed": True, "session_id": session_id}

    @app.post("/api/team/approvals/{approval_id}/grant")
    def team_grant_approval(approval_id: str, request: TeamApprovalDecisionRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            approval, issue = team_kernel.decide_approval(store, approval_id, approved=True, decided_by=request.by, note=request.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="approval not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None}

    @app.post("/api/team/approvals/{approval_id}/reject")
    def team_reject_approval(approval_id: str, request: TeamApprovalDecisionRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            approval, issue = team_kernel.decide_approval(store, approval_id, approved=False, decided_by=request.by, note=request.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="approval not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None}

    @app.post("/api/team/approvals/{approval_id}/request-revision")
    def team_request_revision(approval_id: str, request: TeamApprovalDecisionRequest, _: None = Depends(require_control_token)) -> dict[str, Any]:
        try:
            approval, issue = team_kernel.request_revision(store, approval_id, note=request.note, requested_by=request.by)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="approval not found") from exc
        except ValueError as exc:
            raise _team_value_error(exc) from exc
        return {"approval": approval.to_dict(), "issue": issue.to_dict() if issue else None}

    # --- Company secrets + instance settings（surface over secrets_store 内核） --
    # Audit actor is SERVER-derived for every mutation: a client-supplied actor
    # would let any control-token holder forge the audit trail (a capability
    # the CLI does not have — surfaces must not add kernel-absent semantics).
    _API_AUDIT_ACTOR = "api_user"
    # Read models are masked ledger metadata only; there is deliberately NO
    # resolve endpoint — plaintext never crosses an API response, mirroring the
    # CLI posture. Mutations call the same kernel functions as the CLI (zero
    # divergence), so audit events and fail-closed rules are identical.

    from superclaw import secrets_store as _secrets_store
    from superclaw.ui_contracts import build_secrets_contract

    def _secret_error(exc: _secrets_store.SecretStoreError) -> HTTPException:
        detail = str(exc)
        status = 404 if "not found" in detail else 400
        return HTTPException(status_code=status, detail=detail)

    @app.get("/api/secrets/contract")
    def secrets_contract(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return build_secrets_contract()

    @app.get("/api/secrets/bindings")
    def secrets_bindings(
        target_type: str | None = None,
        target_id: str | None = None,
        company: str | None = None,
        secret: str | None = None,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        secret_id = None
        if secret is not None:
            found = store.find_secret_by_name(secret, company_profile_id=company or "local")
            if found is None:
                raise HTTPException(status_code=404, detail="secret not found")
            secret_id = found.secret_id
        rows = store.list_secret_bindings(
            secret_id=secret_id,
            target_type=target_type,
            target_id=target_id,
            company_profile_id=company,
        )
        return {"bindings": [b.to_dict() for b in rows]}

    @app.delete("/api/secrets/bindings/{binding_id}")
    def secrets_unbind(binding_id: str, _: None = Depends(require_control_token)) -> dict[str, Any]:
        if not _secrets_store.unbind_secret(store, binding_id=binding_id, actor=_API_AUDIT_ACTOR):
            raise HTTPException(status_code=404, detail="binding not found")
        return {"removed": binding_id}

    @app.get("/api/secrets/invokability")
    def secrets_invokability(
        target_type: str,
        target_id: str,
        company: str = "local",
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        result = _secrets_store.check_invokability(
            store, target_type=target_type, target_id=target_id, company_profile_id=company
        )
        return {"ok": result.ok, "missing": list(result.missing), "reason": result.reason()}

    @app.get("/api/secrets")
    def secrets_list(
        company: str | None = None, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        return {"secrets": _secrets_store.list_secret_summaries(store, company_profile_id=company)}

    @app.post("/api/secrets")
    def secrets_create(
        request: SecretCreateRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            summary = _secrets_store.create_secret(
                store,
                name=request.name,
                value=request.value,
                company_profile_id=request.company,
                actor=_API_AUDIT_ACTOR,
                description=request.description,
            )
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc
        return {"secret": summary}

    @app.post("/api/secrets/{name}/rotate")
    def secrets_rotate(
        name: str, request: SecretValueRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            summary = _secrets_store.rotate_secret(
                store, name=name, value=request.value,
                company_profile_id=request.company, actor=_API_AUDIT_ACTOR,
            )
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc
        return {"secret": summary}

    @app.post("/api/secrets/{name}/archive")
    def secrets_archive(
        name: str, request: SecretArchiveRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            summary = _secrets_store.set_secret_archived(
                store, name=name, archived=request.archived,
                company_profile_id=request.company, actor=_API_AUDIT_ACTOR,
            )
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc
        return {"secret": summary}

    @app.post("/api/secrets/{name}/bindings")
    def secrets_bind(
        name: str, request: SecretBindRequest, _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            binding = _secrets_store.bind_secret(
                store,
                name=name,
                target_type=request.target_type,
                target_id=request.target_id,
                config_path=request.env,
                required=request.required,
                company_profile_id=request.company,
                actor=_API_AUDIT_ACTOR,
            )
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc
        return {"binding": binding.to_dict()}

    @app.get("/api/secrets/{name}/access-log")
    def secrets_access_log(
        name: str,
        company: str = "local",
        limit: int = 50,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        secret_id = _secrets_store.find_audit_secret_id(
            store, name=name, company_profile_id=company
        )
        if secret_id is None:
            raise HTTPException(status_code=404, detail="secret not found (and no delete trace)")
        events = store.list_secret_access_events(secret_id=secret_id, limit=limit)
        return {"events": [e.to_dict() for e in events]}

    @app.delete("/api/secrets/{name}")
    def secrets_delete(
        name: str, company: str = "local", _: None = Depends(require_control_token)
    ) -> dict[str, Any]:
        try:
            summary = _secrets_store.delete_secret(
                store, name=name, company_profile_id=company, actor=_API_AUDIT_ACTOR
            )
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc
        return {"deleted": summary["secret_id"]}

    @app.get("/api/instance-settings")
    def instance_settings_get(_: None = Depends(require_control_token)) -> dict[str, Any]:
        return _secrets_store.get_instance_settings(store)

    @app.patch("/api/instance-settings/{bucket}")
    def instance_settings_patch(
        bucket: str,
        request: InstanceSettingsPatchRequest,
        _: None = Depends(require_control_token),
    ) -> dict[str, Any]:
        try:
            return _secrets_store.update_instance_settings(store, bucket=bucket, patch=request.patch)
        except _secrets_store.SecretStoreError as exc:
            raise _secret_error(exc) from exc

    # SPA fallback — registered LAST so every real route above wins first. In the
    # desktop D2 model the webview loads the app FROM this Python origin, so a
    # client-side deep link or reload (e.g. /company/<id>) must return index.html for
    # the SPA router. An UNMATCHED API-ish path must still 404, not silently serve
    # the shell, so the front-end can't mistake a missing endpoint for an empty page.
    # The Node front door intercepts its prefixes upstream of routing, so they never
    # reach here.
    if web_dist.exists():
        _spa_index = web_dist / "index.html"
        _spa_api_prefixes = ("api/", "gateway-api/", "paperclip-api/", "_plugins/", "v1/", "a2a/", "health", ".well-known/")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa_fallback(full_path: str) -> FileResponse:
            if full_path.startswith(_spa_api_prefixes):
                raise HTTPException(status_code=404, detail="Not Found")
            return FileResponse(_spa_index)

    return app


def __getattr__(name: str) -> Any:
    # Lazily materialize the ASGI app for the ``uvicorn apps.api.main:app`` entrypoint
    # (PEP 562). Importing this module for its FACTORY (``create_app``) or helpers must
    # NOT have the side effect of opening a default ``state.db`` — otherwise every
    # consumer that does ``from apps.api.main import create_app`` (the CLI service
    # builder, the desktop sidecar, streamtest) would create a stray default DB at
    # import time even when it goes on to pass an explicit ``state_path``. Only a real
    # ``app`` attribute access (the ASGI server) builds it; the result is cached.
    if name == "app":
        application = create_app()
        globals()["app"] = application
        return application
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
