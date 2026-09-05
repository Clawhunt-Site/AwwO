from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from jsonschema import Draft202012Validator, ValidationError

from superclaw.clawhunt_auth import saved_clawhunt_access_token
from superclaw.environment import superclaw_data_path
from superclaw.models import ArtifactRef, EvidenceBundle, _id
from superclaw.plugin_config import (
    PluginConfigurationError,
    is_account_bridge_secret,
    load_plugin_secret_environment,
    load_plugin_setting_environment,
)
from superclaw.process_scripts import command_for_script
from superclaw.plugin_timeouts import floor_default_timeout_seconds
from superclaw.plugin_versions import PluginVersionRangeError, version_satisfies_range, version_tuple
from superclaw.plugins import (
    MANIFEST_NAME,
    PluginPackage,
    PluginVerificationError,
    check_plugin_revocation,
    compute_package_digest,
    derive_skill_trust,
    load_plugin_package,
    plugin_cache_root,
    plugin_namespace_violation,
    plugin_signer_class,
    plugin_state_root,
    verify_plugin_integrity,
    verify_plugin_package,
)
from superclaw.plugin_provenance import read_install_provenance
from superclaw.trust_state import TrustState
from superclaw.secrets_scan import redact_secrets


# Admission-gate inputs live under the user-global plugin state root (see
# ``plugins.plugin_state_root``) so a globally-installed plugin is entitled /
# policed identically regardless of the working directory it is invoked from.
# Back-compat constants snapshot the default root at import; prefer the call-time
# resolvers, which honor ``SUPERCLAW_PLUGIN_STATE_ROOT`` set after import.
DEFAULT_ENTITLEMENT_FILE = plugin_state_root() / "entitlements.json"
DEFAULT_POLICY_FILE = plugin_state_root() / "runtime-policy.json"


def default_entitlement_file() -> Path:
    """Call-time entitlement-file default under the global plugin state root."""
    return plugin_state_root() / "entitlements.json"


def default_policy_file() -> Path:
    """Call-time runtime-policy-file default under the global plugin state root."""
    return plugin_state_root() / "runtime-policy.json"
def _safe_base_path() -> str:
    """A minimal, sanitized base PATH for sandboxed child processes.

    POSIX: the standard system bin dirs. Windows: the System32 dirs (the
    "/usr/bin:/bin" equivalent) — without these a child handed this string as its
    ENTIRE PATH would get an effectively-empty PATH and fail to resolve even OS
    helpers. The launcher's own directory is prepended separately at spawn time.
    """
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
        return os.pathsep.join(
            os.path.join(system_root, *parts)
            for parts in ((), ("System32",), ("System32", "Wbem"), ("System32", "WindowsPowerShell", "v1.0"))
        )
    return "/usr/bin:/bin:/usr/sbin:/sbin"


SAFE_SIDECAR_PATH = _safe_base_path()
SAFE_SIDECAR_PASSTHROUGH_ENV_NAMES = {
    "CURL_CA_BUNDLE",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PYTHONHTTPSVERIFY",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
}
MAX_OFFLINE_GRACE_SECONDS = 72 * 60 * 60
DEFAULT_RUNTIME_VERSION = "0.1.0"
SEMVERISH_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}$")
BRIDGE_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
# PayAgent's installer authorizes a specific device id with ClawHunt and records it
# here. SuperClaw must bridge/query authorization under the SAME device id, otherwise
# the (valid) grant looks absent and the sidecar reports authorized=false.
PAYAGENT_INSTALLER_ENV_FILE = Path.home() / ".payagent" / "payagent.env"
# Non-secret Pay-Switch identity vars SuperClaw forwards to the sidecar so its own
# ClawHunt status check queries the bridged device/plugin, not the "local-device" default.
BRIDGE_SIDECAR_IDENTITY_ENV_NAMES = ("PAY_SWITCH_DEVICE_ID", "PAY_SWITCH_PLUGIN_ID")


PLUGIN_ERROR_MESSAGES: dict[str, tuple[str, bool, str]] = {
    "PLUGIN_NOT_INSTALLED": ("Plugin is not installed in the local SuperClaw cache.", True, "denied"),
    "PLUGIN_SIGNATURE_INVALID": ("Plugin package verification failed before execution.", False, "denied"),
    "PLUGIN_REVOKED": ("This plugin version has been revoked and cannot run.", False, "denied"),
    "PLUGIN_NAMESPACE_VIOLATION": ("This plugin claims a reserved first-party namespace without an official signature and cannot run.", False, "denied"),
    "PLUGIN_ENTITLEMENT_MISSING": ("This plugin is not available for the current SuperClaw account or device.", True, "denied"),
    "PLUGIN_ENTITLEMENT_EXPIRED": ("This plugin entitlement is expired and must be refreshed.", True, "denied"),
    "PLUGIN_CONFIG_REQUIRED": ("Required local plugin configuration is missing.", True, "denied"),
    "PLUGIN_SECRET_UNAVAILABLE": ("Declared plugin secret could not be loaded by local SuperClaw runtime policy.", True, "denied"),
    "PLUGIN_ACCOUNT_BRIDGE_FAILED": ("SuperClaw could not exchange the active ClawHunt login for a plugin-scoped credential.", True, "denied"),
    "PLUGIN_PERMISSION_DENIED": ("This plugin invocation exceeds the permissions allowed by local SuperClaw runtime policy.", False, "denied"),
    "PLUGIN_NOT_GRANTED": ("This plugin is not in the team agent's granted equipment for this run (per-agent equipment narrowing, fail-closed).", False, "denied"),
    "PLUGIN_SANDBOX_VIOLATION": ("The plugin sidecar attempted behavior outside its declared sandbox.", False, "denied"),
    "PLUGIN_TOOL_NOT_DECLARED": ("The requested plugin tool is not declared by the package manifest.", False, "denied"),
    "PLUGIN_RUNTIME_ERROR": ("The plugin sidecar returned a runtime error.", False, "error"),
    "PLUGIN_TIMEOUT": ("The plugin sidecar exceeded its execution timeout.", True, "timeout"),
    "PLUGIN_OUTPUT_SCHEMA_INVALID": ("The plugin output did not match its declared schema.", False, "error"),
}


@dataclass(frozen=True)
class PluginProxyResult:
    plugin_id: str
    version: str
    tool_name: str
    ok: bool
    model_response: dict[str, Any]
    evidence_record: dict[str, Any]
    evidence_artifact: ArtifactRef | None = None
    # Validated image content the plugin emitted via the reserved
    # `_superclaw_images` output field. Forwarded to the runtime as native MCP
    # image content so a multimodal agent can *see* what the plugin captured
    # (e.g. a full-page screenshot) and plan its next step. Empty for plugins
    # that return text only.
    images: tuple[dict[str, Any], ...] = ()


def invoke_cached_plugin_tool(
    plugin_id: str,
    tool_name: str,
    tool_input: dict[str, Any],
    *,
    version: str | None = None,
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    environment: dict[str, str] | None = None,
    config_file: Path | None = None,
    runtime_version: str = DEFAULT_RUNTIME_VERSION,
    evidence: EvidenceBundle | None = None,
    artifact_dir: Path | None = None,
    run_id: str = "plugin_proxy",
    verification_cache: dict[tuple[str, str], bool] | None = None,
    granted_plugin_ids: frozenset[str] | None = None,
) -> PluginProxyResult:
    """Invoke a cached plugin through SuperClaw's local proxy boundary.

    This is the Phase 2 proxy core, not a raw agent-facing MCP server. It enforces
    the same policy order the MCP server will use before routing a tool call to a
    sidecar: per-agent equipment grant -> installed package -> declared tool ->
    entitlement -> required config -> sidecar -> schema validation -> redacted
    evidence/model output.

    ``granted_plugin_ids`` is the per-agent EQUIPMENT NARROWING (Agent Team Kernel
    §2.6 item 4) enforced at the execution choke point — every plugin invocation
    path (aggregate proxy, single-plugin proxy, any future direct caller) funnels
    through here. ``None`` means no narrowing (a non-team / operator path). A set
    means a team-bound run: a ``plugin_id`` outside it is rejected fail-closed
    BEFORE the package is loaded, so an un-granted plugin cannot even produce an
    install/signature/entitlement side channel. SCOPE: this closes the gap for a
    CONTAINED agent (one that cannot tamper with the orchestrator-generated launch
    config). A full-shell agent that can rewrite the plugin-set / launch its own
    proxy / call the operator CLI is NOT closed here by design — that boundary is
    the backend containment contract (see docs t11-low-trust-containment), not
    per-agent grant. This gate is defense-in-depth + an honest contained boundary,
    not a full-shell authority.
    """
    invocation_id = _id("plugininv")
    if granted_plugin_ids is not None and plugin_id not in granted_plugin_ids:
        # Fail-closed equipment narrowing, evaluated before any package load so an
        # un-granted plugin id triggers no install/signature/entitlement work.
        return _error_result(
            invocation_id,
            run_id,
            plugin_id,
            version or "unknown",
            tool_name,
            "PLUGIN_NOT_GRANTED",
            tool_input,
            evidence=evidence,
            artifact_dir=artifact_dir,
        )
    package = _load_cached_package(plugin_id, version=version, cache_root=cache_root)
    if package is None:
        return _error_result(
            invocation_id,
            run_id,
            plugin_id,
            version or "unknown",
            tool_name,
            "PLUGIN_NOT_INSTALLED",
            tool_input,
            evidence=evidence,
            artifact_dir=artifact_dir,
        )
    try:
        verification_error = _verify_cached_package_before_execution(
            package, public_key=public_key, revocation_file=revocation_file, verification_cache=verification_cache
        )
        if verification_error:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, verification_error, tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package)

        tool = _find_tool(package.manifest, tool_name)
        if tool is None:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_TOOL_NOT_DECLARED", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package)

        entitlement = _resolve_entitlement(package, entitlement_file or default_entitlement_file())
        if entitlement.get("error_code"):
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, str(entitlement["error_code"]), tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package)

        runtime_policy = _resolve_runtime_policy(package, policy_file or default_policy_file(), runtime_version=runtime_version)
        if runtime_policy.get("error_code"):
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, str(runtime_policy["error_code"]), tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, diagnostic=str(runtime_policy.get("diagnostic") or "policy denied"))

        if environment is None:
            try:
                environment = load_plugin_secret_environment(package.plugin_id, package.manifest, plugin_version=package.version, config_file=config_file)
            except PluginConfigurationError as exc:
                return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_SECRET_UNAVAILABLE", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, diagnostic=str(exc))

        # Deliver the user's configured non-secret settings to the sidecar at
        # runtime (the runtime half of the config protocol). Secrets take
        # precedence over settings on any env_name clash.
        try:
            setting_env = load_plugin_setting_environment(package.plugin_id, package.manifest, config_file=config_file)
        except PluginConfigurationError:
            setting_env = {}
        if setting_env:
            environment = {**setting_env, **environment}

        try:
            bridged_env = _resolve_clawhunt_account_bridge(package, environment)
        except PluginConfigurationError as exc:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_ACCOUNT_BRIDGE_FAILED", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, diagnostic=str(exc))
        if bridged_env:
            # Explicit local secrets/config still take precedence. The bridge only
            # fills the gap after the user signs in to ClawHunt through SuperClaw.
            environment = {**bridged_env, **environment}

        sidecar_env = _build_sidecar_environment(package.manifest, environment)
        if sidecar_env.get("error_code"):
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, str(sidecar_env["error_code"]), tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package)
        # Bridge-resolved Pay-Switch identity (device/plugin id) is non-secret and not
        # manifest-declared, so it is dropped by the secret/setting whitelist above.
        # Forward it explicitly so the sidecar queries the authorized device instead of
        # falling back to "local-device".
        if isinstance(sidecar_env.get("env"), dict):
            for _id_env in BRIDGE_SIDECAR_IDENTITY_ENV_NAMES:
                _id_val = bridged_env.get(_id_env)
                if _id_val and not sidecar_env["env"].get(_id_env):
                    sidecar_env["env"][_id_env] = _id_val

        sandbox = _sandbox_preflight(package)
        if sandbox.get("error_code"):
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, str(sandbox["error_code"]), tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, diagnostic=str(sandbox.get("diagnostic") or "sandbox violation"))

        started = _utc_now()
        if str(package.manifest.get("runtime", {}).get("type")) == "external_mcp":
            # Curated external MCP server: forward the call over MCP instead of
            # spawning an in-package sidecar script. Same return contract, so the
            # downstream (output-schema validation, redaction, evidence) is shared.
            completed = _run_external_mcp(package, tool_name, tool_input, sidecar_env["env"], timeout_ms=_max_tool_timeout_ms(package, runtime_policy))
        else:
            completed = _run_sidecar(package, tool_input, sidecar_env["env"], timeout_ms=_max_tool_timeout_ms(package, runtime_policy))
        finished = _utc_now()
        if completed["timed_out"]:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_TIMEOUT", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, started_at=started, finished_at=finished, sandbox_exit_status=None)
        if int(completed["exit_code"]) != 0:
            return _error_result(
                invocation_id,
                run_id,
                package.plugin_id,
                package.version,
                tool_name,
                "PLUGIN_RUNTIME_ERROR",
                tool_input,
                evidence=evidence,
                artifact_dir=artifact_dir,
                package=package,
                started_at=started,
                finished_at=finished,
                sandbox_exit_status=int(completed["exit_code"]),
                diagnostic=completed["stderr"] or completed["stdout"],
            )

        try:
            output = json.loads(str(completed["stdout"] or "{}"))
        except json.JSONDecodeError as exc:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_OUTPUT_SCHEMA_INVALID", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, started_at=started, finished_at=finished, sandbox_exit_status=0, diagnostic=f"invalid JSON output: {exc}")
        # Intercept image content BEFORE the text pipeline so base64 bytes do not
        # hit secret redaction, the undeclared-field drop, the byte budget, or
        # output-schema validation. Forwarded separately as MCP image content.
        output, plugin_images = _extract_plugin_images(output)
        # Redact pattern-detected secrets AND the exact values of the SECRETS
        # SuperClaw injected into the sidecar, so a sidecar can't echo a managed
        # credential back to the model in a non-standard (regex-missed) format.
        # Only secret env values are redacted — non-secret settings (e.g. a chosen
        # Chrome profile directory) are legitimate output and must survive (else a
        # configured value would be scrubbed from its own discovery list).
        _secret_env_names = {
            str(s.get("env_name") or s.get("name"))
            for s in package.manifest.get("configuration", {}).get("secrets", [])
            if isinstance(s, dict)
        }
        injected_secret_values = [v for k, v in sidecar_env.get("env", {}).items() if k in _secret_env_names and v]
        redacted_output = _redact_injected_secrets(
            _drop_undeclared_output_fields(_redact_json(output), tool["output_schema"]),
            injected_secret_values,
        )
        try:
            redacted_output = _enforce_output_budget(redacted_output, _max_model_output_bytes(package, runtime_policy))
        except _OutputBudgetExceeded as exc:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_OUTPUT_SCHEMA_INVALID", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, started_at=started, finished_at=finished, sandbox_exit_status=0, diagnostic=str(exc))
        try:
            Draft202012Validator(tool["output_schema"]).validate(redacted_output)
        except ValidationError as exc:
            return _error_result(invocation_id, run_id, package.plugin_id, package.version, tool_name, "PLUGIN_OUTPUT_SCHEMA_INVALID", tool_input, evidence=evidence, artifact_dir=artifact_dir, package=package, started_at=started, finished_at=finished, sandbox_exit_status=0, diagnostic=exc.message)

        record = _evidence_record(
            invocation_id,
            run_id,
            package,
            tool_name,
            status="ok",
            entitlement_id=entitlement.get("entitlement_id"),
            input_payload=tool_input,
            output_payload=redacted_output,
            started_at=started,
            finished_at=finished,
            sandbox_exit_status=0,
            policy_decision="allowed",
        )
        if plugin_images:
            # Record that images were returned (count/metadata only — never the
            # bytes) so the invocation audit reflects the visual payload.
            record["image_count"] = len(plugin_images)
            record["image_names"] = [img.get("name", "") for img in plugin_images]
        artifact = _write_invocation_artifact(record, artifact_dir)
        record["evidence_artifact_id"] = artifact.artifact_id
        _attach_evidence(evidence, record, artifact, passed=True, detail=f"plugin invocation allowed: {package.plugin_id}.{tool_name}")
        return PluginProxyResult(package.plugin_id, package.version, tool_name, True, redacted_output, record, artifact, images=tuple(plugin_images))
    finally:
        package.cleanup()


def _load_cached_package(plugin_id: str, *, version: str | None, cache_root: Path | None) -> PluginPackage | None:
    root = plugin_cache_root(cache_root) / plugin_id
    if version:
        package_root = root / version
    else:
        versions = sorted(path for path in root.iterdir() if path.is_dir()) if root.exists() else []
        package_root = versions[-1] if versions else None
    if not package_root or not (package_root / MANIFEST_NAME).exists():
        return None
    try:
        return load_plugin_package(package_root)
    except PluginVerificationError:
        return None


def _find_tool(manifest: dict[str, Any], tool_name: str) -> dict[str, Any] | None:
    for tool in manifest.get("tools", []):
        if tool.get("name") == tool_name:
            return tool
    return None


def _verify_cached_package_before_execution(
    package: PluginPackage,
    *,
    public_key: str | None,
    revocation_file: Path | None,
    verification_cache: dict[tuple[str, str], bool] | None = None,
) -> str | None:
    # Resolve skill-origin provenance up front: a digest-matched LOCAL skill is
    # equippable SIGN-FREE (design §3.6), so its integrity check must NOT require
    # a signature — otherwise the generic signature-admission gate below would
    # reject an unsigned local skill before the provenance gate ever runs (and
    # "sign-free local" would secretly depend on SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST).
    # read_install_provenance is fail-closed (no record / mismatch / not-local =>
    # "remote"), so this can only WAIVE the signature for a genuine local stamp;
    # a remote skill still takes the full signature path.
    # The provenance gate applies to a GENUINE skill-origin package — the
    # authoritative signed manifest field ``skill_origin: true``. The bare
    # ``skill.`` id-prefix WITHOUT that field is NOT graded here: it is a
    # namespace hijack handled by plugin_namespace_violation below (preserved,
    # design §2.4), so its error code stays PLUGIN_NAMESPACE_VIOLATION rather than
    # being shadowed by the provenance verdict.
    is_skill = package.manifest.get("skill_origin") is True
    skill_is_local = is_skill and read_install_provenance(package) == "local"
    try:
        if verification_cache is None:
            if skill_is_local:
                # Sign-free local skill: digest + manifest contract + revocation,
                # NO signature admission (cache=False mirrors verify_plugin_package
                # but skips resolve_signature_trust for the local skill).
                verify_plugin_integrity(package, public_key=public_key, require_signature=False)
                check_plugin_revocation(package, revocation_file=revocation_file)
            else:
                verify_plugin_package(
                    package.root, public_key=public_key, revocation_file=revocation_file, cache=False
                )
        else:
            # Warm cache: memoize the expensive, immutable integrity check
            # (digest re-hash + signature) per (package path, digest) for the
            # life of this process; ALWAYS re-check revocation so a mid-run
            # revocation still takes effect (defense in depth, fail-closed).
            #
            # SECURITY: the cache key is the *freshly computed* digest of the
            # current on-disk bytes, NOT the manifest-declared digest. The
            # declared value never changes after signing, so keying on it would
            # let a post-sign on-disk tamper (e.g. chmod +x / chmod u+s on the
            # cached entry binary — now part of the digest) reuse an earlier
            # "verified" cache entry and skip re-verification. Keying on the live
            # computed digest means any such tamper changes the key, forces a
            # cache miss, and runs the full integrity check, which then fails
            # closed because declared != computed.
            computed_digest = compute_package_digest(package)
            key = (str(package.root.resolve()), computed_digest)
            if key not in verification_cache:
                verify_plugin_integrity(
                    package, public_key=public_key, require_signature=not skill_is_local
                )
                verification_cache[key] = True
            check_plugin_revocation(package, revocation_file=revocation_file)
    except PluginVerificationError as exc:
        if "revoked" in str(exc):
            return "PLUGIN_REVOKED"
        return "PLUGIN_SIGNATURE_INVALID"
    # Skill-origin provenance gate (design §3.6, PR-1). Placed OUTSIDE the
    # integrity-memoization block above so it runs on EVERY call (a mid-session
    # revocation OR a provenance-record change takes effect immediately), and at
    # this single primitive so enumeration (_gate_passes), equipment, the proxy's
    # per-tool-call execution, and resume all enforce it identically. A
    # skill-origin package whose provenance does not verify (remote-unverified /
    # stamp mismatch / grade spoof / namespace hijack) derives UNTRUSTED and is
    # dropped here; a digest-matched local stamp passes sign-free. GENERIC
    # (non-skill_origin) plugins never enter this branch — their
    # verify_plugin_package / resolve_signature_trust semantics are unchanged.
    if is_skill:
        if (
            derive_skill_trust(package, public_key=public_key, revocation_file=revocation_file)
            is TrustState.UNTRUSTED
        ):
            return "PLUGIN_SIGNATURE_INVALID"
    # Namespace hard-isolation (方向二 §3.2): a reserved first-party prefix signed
    # by a non-root key is a hijack — reject before execution even though the
    # signature itself verified. Shared by the governed projection enumerators
    # (available_plugins / gate_passing_plugins) via _gate_passes, so a hijack
    # package is also dropped from those; the bare project_plugin_tools projection
    # path is hardened in the §3.3 enumeration PR. (Developer-freshness gating +
    # PLUGIN_TRUST_STALE arrive with the TUF registry, 方向二 §2.)
    if plugin_namespace_violation(package):
        return "PLUGIN_NAMESPACE_VIOLATION"
    # external_mcp executes an external program on the host — a privileged,
    # CURATED-ONLY capability. It MUST be product root-signed regardless of
    # namespace: a developer/local/none signer can never mint an external_mcp
    # plugin (closes the "developer.foo external_mcp runs an external launcher"
    # hole). Evaluated at this single choke point so execution AND projection
    # (_gate_passes -> verify_cached_package_before_execution) both fail closed.
    if str(package.manifest.get("runtime", {}).get("type")) == "external_mcp":
        if plugin_signer_class(package) != "root":
            return "PLUGIN_SIGNATURE_INVALID"
    return None


def _resolve_entitlement(package: PluginPackage, entitlement_file: Path) -> dict[str, Any]:
    pricing_model = package.manifest.get("commerce", {}).get("pricing_model")
    if pricing_model in {None, "", "free"}:
        return {"entitlement_id": None}
    if not entitlement_file.exists():
        return {"error_code": "PLUGIN_ENTITLEMENT_MISSING"}
    payload = json.loads(entitlement_file.read_text(encoding="utf-8"))
    now = datetime.now(UTC)
    for item in payload.get("entitlements", []):
        if item.get("plugin_id") != package.plugin_id:
            continue
        if not _entitlement_matches_version(item, package.version):
            continue
        expires_at = item.get("expires_at")
        if expires_at and _parse_entitlement_time(str(expires_at)) <= now:
            return {"error_code": "PLUGIN_ENTITLEMENT_EXPIRED", "entitlement_id": item.get("entitlement_id")}
        offline_grace_expires_at = item.get("offline_grace_expires_at")
        if offline_grace_expires_at:
            grace_deadline = _parse_entitlement_time(str(offline_grace_expires_at))
            if grace_deadline <= now:
                return {"error_code": "PLUGIN_ENTITLEMENT_EXPIRED", "entitlement_id": item.get("entitlement_id")}
            synced_at = item.get("synced_at")
            if synced_at:
                max_deadline = _parse_entitlement_time(str(synced_at)) + timedelta(seconds=MAX_OFFLINE_GRACE_SECONDS)
                if grace_deadline > max_deadline:
                    return {"error_code": "PLUGIN_ENTITLEMENT_EXPIRED", "entitlement_id": item.get("entitlement_id")}
            elif grace_deadline > now + timedelta(seconds=MAX_OFFLINE_GRACE_SECONDS):
                return {"error_code": "PLUGIN_ENTITLEMENT_EXPIRED", "entitlement_id": item.get("entitlement_id")}
        return {"entitlement_id": item.get("entitlement_id")}
    return {"error_code": "PLUGIN_ENTITLEMENT_MISSING"}


def _entitlement_matches_version(item: dict[str, Any], version: str) -> bool:
    if item.get("version") not in {None, version}:
        return False
    version_range = item.get("version_range")
    if not version_range:
        return True
    try:
        return version_satisfies_range(version, str(version_range))
    except PluginVersionRangeError:
        return False


def _parse_entitlement_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _resolve_runtime_policy(package: PluginPackage, policy_file: Path, *, runtime_version: str) -> dict[str, Any]:
    if not policy_file.exists():
        return {}
    if not SEMVERISH_RE.fullmatch(str(runtime_version)):
        return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "invalid SuperClaw runtime version"}
    payload = json.loads(policy_file.read_text(encoding="utf-8"))
    policies = payload.get("policies", [])
    if not isinstance(policies, list):
        return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "invalid policy payload"}
    resolved: dict[str, Any] = {}
    for policy in policies:
        if policy.get("plugin_id") not in {None, package.plugin_id}:
            continue
        if policy.get("version") not in {None, package.version}:
            continue
        denied = _denylisted_permission_match(package.manifest.get("permissions", {}), policy.get("denylisted_permissions", []))
        if denied:
            return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": f"permission denied by policy: {denied}"}
        minimum_runtime_version = policy.get("minimum_runtime_version")
        if minimum_runtime_version:
            if not SEMVERISH_RE.fullmatch(str(minimum_runtime_version)):
                return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "invalid policy minimum runtime version"}
            if version_tuple(runtime_version) < version_tuple(minimum_runtime_version):
                return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "SuperClaw runtime version below policy minimum"}
        if policy.get("minimum_schema_version") and version_tuple(package.manifest.get("schema_version")) < version_tuple(policy.get("minimum_schema_version")):
            return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "plugin schema version below runtime policy minimum"}
        if policy.get("max_model_output_bytes") is not None:
            resolved["max_model_output_bytes"] = int(policy["max_model_output_bytes"])
        if policy.get("max_tool_timeout_ms") is not None:
            try:
                max_tool_timeout_ms = int(policy["max_tool_timeout_ms"])
            except (TypeError, ValueError):
                return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "invalid policy max tool timeout"}
            if max_tool_timeout_ms <= 0:
                return {"error_code": "PLUGIN_PERMISSION_DENIED", "diagnostic": "invalid policy max tool timeout"}
            resolved["max_tool_timeout_ms"] = max_tool_timeout_ms
    return resolved


def _denylisted_permission_match(permissions: dict[str, Any], denylisted: list[Any]) -> str | None:
    filesystem = permissions.get("filesystem", []) or []
    network = permissions.get("network", []) or []
    environment = permissions.get("environment", []) or []
    for rule in [str(item) for item in denylisted]:
        if rule == "filesystem:*" and filesystem:
            return rule
        if rule == "network:*" and network:
            return rule
        if rule == "environment:*" and environment:
            return rule
        if rule.startswith("network:"):
            host = rule.split(":", 1)[1]
            if any(isinstance(item, dict) and item.get("host") == host for item in network):
                return rule
        if rule.startswith("environment:"):
            name = rule.split(":", 1)[1]
            if name in {str(item) for item in environment}:
                return rule
    return None


def _max_model_output_bytes(package: PluginPackage, runtime_policy: dict[str, Any]) -> int:
    manifest_limit = int(package.manifest.get("limits", {}).get("max_model_output_bytes") or 65536)
    policy_limit = runtime_policy.get("max_model_output_bytes")
    if policy_limit is None:
        return manifest_limit
    return min(manifest_limit, int(policy_limit))


def _max_tool_timeout_ms(package: PluginPackage, runtime_policy: dict[str, Any]) -> int:
    # Bare default (no manifest limit) is env-floored so a CPU-starved host can't
    # trip a false PLUGIN_TIMEOUT; an explicit manifest tool_timeout_ms and a
    # tightening policy max_tool_timeout_ms are both preserved (min() below).
    manifest_limit = int(package.manifest.get("limits", {}).get("tool_timeout_ms") or floor_default_timeout_seconds(30.0) * 1000)
    policy_limit = runtime_policy.get("max_tool_timeout_ms")
    if policy_limit is None:
        return manifest_limit
    return min(manifest_limit, int(policy_limit))


def _build_sidecar_environment(manifest: dict[str, Any], source: dict[str, str]) -> dict[str, Any]:
    # Never let the plugin write Python bytecode (__pycache__/*.pyc) into its
    # cached package dir — that would mutate the package and break the integrity
    # digest on the next verification.
    env = {"PATH": SAFE_SIDECAR_PATH, "PYTHONDONTWRITEBYTECODE": "1"}
    for name in sorted(SAFE_SIDECAR_PASSTHROUGH_ENV_NAMES):
        value = os.environ.get(name)
        if value:
            env[name] = value
    _ensure_sidecar_ca_bundle(env)
    for secret in manifest.get("configuration", {}).get("secrets", []):
        env_name = str(secret.get("env_name") or secret.get("name"))
        # Auto-provisioned credentials (account bridge) are never user-required:
        # SuperClaw fills them from login state earlier in this call, and when the
        # user is not signed in the plugin surfaces its own auth status. Gating on
        # the raw manifest `required` here would contradict the config-status
        # payload (which coerces effective required=false), so use the same rule.
        effective_required = bool(secret.get("required")) and not is_account_bridge_secret(
            manifest, str(secret.get("name") or ""), env_name
        )
        if effective_required and not source.get(env_name):
            return {"error_code": "PLUGIN_CONFIG_REQUIRED"}
        if source.get(env_name):
            env[env_name] = source[env_name]
    # Non-secret settings that declare an env_name are delivered the same way
    # (whitelisted by the manifest so only declared names reach the sidecar).
    for setting in manifest.get("configuration", {}).get("settings", []):
        if not isinstance(setting, dict):
            continue
        env_name = str(setting.get("env_name") or "")
        if env_name and source.get(env_name):
            env[env_name] = source[env_name]
    return {"env": env}


def _ensure_sidecar_ca_bundle(env: dict[str, str]) -> None:
    if env.get("SSL_CERT_FILE") or env.get("REQUESTS_CA_BUNDLE"):
        return
    try:
        import certifi  # type: ignore[import-not-found]
    except Exception:
        return
    bundle = str(certifi.where())
    if bundle:
        env["SSL_CERT_FILE"] = bundle
        env["REQUESTS_CA_BUNDLE"] = bundle


def _payagent_installer_env() -> dict[str, str]:
    """Read identity hints written by the PayAgent installer (~/.payagent/payagent.env).

    Only simple KEY=VALUE lines are parsed and only non-secret identity hints are
    used by callers (the sidecar reads its own scoped token from the keychain).
    Returns {} when the file is absent or unreadable.
    """
    try:
        text = PAYAGENT_INSTALLER_ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        return {}
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key:
            values[key] = value.strip().strip('"').strip("'")
    return values


def _resolve_clawhunt_account_bridge(package: PluginPackage, source: dict[str, str]) -> dict[str, str]:
    """Return scoped credentials derived from the local SuperClaw ClawHunt login.

    This deliberately does not pass the ClawHunt account access token to the
    plugin sidecar. For Pay-Switch, SuperClaw performs the ClawHunt plugin-auth
    exchange itself and injects only the scoped PayAgent token the plugin already
    declares as a secret.
    """
    bridge = package.manifest.get("clawhunt_account_bridge")
    if not isinstance(bridge, dict):
        return {}
    kind = str(bridge.get("type") or "").strip()
    if kind != "pay_switch_agent_token":
        return {}

    env_name = str(bridge.get("token_env") or "PAY_SWITCH_AGENT_TOKEN").strip()
    if not BRIDGE_ENV_NAME_RE.fullmatch(env_name):
        return {}
    if source.get(env_name):
        return {}
    if not _manifest_declares_secret_env(package.manifest, env_name):
        return {}

    account_token = saved_clawhunt_access_token()
    if not account_token:
        return {}

    config_url = _bridge_url(source, bridge, env_key="config_url_env", default_key="default_config_url")
    panel_url = _bridge_url(source, bridge, env_key="panel_url_env", default_key="default_panel_url")
    installer_env = _payagent_installer_env()
    plugin_id = str(bridge.get("plugin_id") or installer_env.get("PAY_SWITCH_PLUGIN_ID") or "pay-switch-agent").strip()
    # Prefer the device id the PayAgent installer actually authorized with ClawHunt
    # over the manifest's "local-device" placeholder; otherwise SuperClaw queries the
    # wrong device and a valid grant looks absent (PLUGIN_CONFIG_REQUIRED).
    device_id = str(
        source.get(str(bridge.get("device_id_env") or ""))
        or installer_env.get("PAY_SWITCH_DEVICE_ID")
        or bridge.get("device_id")
        or "local-device"
    ).strip()
    if not config_url or not panel_url or not plugin_id or not device_id:
        return {}

    try:
        scoped_token = _exchange_pay_switch_agent_token(
            account_token=account_token,
            config_url=config_url,
            panel_url=panel_url,
            plugin_id=plugin_id,
            device_id=device_id,
            superclaw_install_id=str(bridge.get("superclaw_install_id") or "") or None,
        )
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        raise PluginConfigurationError(f"ClawHunt account bridge failed for {plugin_id}: {exc}") from exc
    # Always forward the resolved identity so the sidecar's own ClawHunt status check
    # queries the same device/plugin the bridge authorized (it otherwise defaults to
    # "local-device"). The scoped token is added only when the exchange succeeds.
    resolved = {"PAY_SWITCH_DEVICE_ID": device_id, "PAY_SWITCH_PLUGIN_ID": plugin_id}
    if scoped_token:
        resolved[env_name] = scoped_token
    return resolved


def _manifest_declares_secret_env(manifest: dict[str, Any], env_name: str) -> bool:
    return any(
        isinstance(secret, dict) and str(secret.get("env_name") or secret.get("name")) == env_name
        for secret in manifest.get("configuration", {}).get("secrets", [])
    )


def _bridge_url(source: dict[str, str], bridge: dict[str, Any], *, env_key: str, default_key: str) -> str:
    env_name = str(bridge.get(env_key) or "").strip()
    if env_name and BRIDGE_ENV_NAME_RE.fullmatch(env_name):
        value = str(source.get(env_name) or "").strip()
        if value:
            return value
    return str(bridge.get(default_key) or "").strip()


def _exchange_pay_switch_agent_token(
    *,
    account_token: str,
    config_url: str,
    panel_url: str,
    plugin_id: str,
    device_id: str,
    superclaw_install_id: str | None,
) -> str:
    timeout = httpx.Timeout(10.0, connect=5.0)
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {account_token}",
        "User-Agent": "superclaw-plugin-proxy/0.1.0",
    }
    with httpx.Client(timeout=timeout, headers=headers) as client:
        config_response = client.get(config_url)
        config_response.raise_for_status()
        config = config_response.json()
        if not isinstance(config, dict):
            raise ValueError("Pay-Switch config response must be an object")

        start_url = _config_url_value(config, config_url, "clawhunt_auth_start_url", "plugin_auth_start_url", "payagent_auth_start_url")
        exchange_url = _config_url_value(config, config_url, "plugin_auth_exchange_url")
        if not start_url or not exchange_url:
            raise ValueError("Pay-Switch plugin auth endpoints are missing")

        start_response = client.post(
            start_url,
            json={
                "schema": "clawhunt.pay-switch.plugin-auth.start.v1",
                "plugin_id": plugin_id,
                "device_id": device_id,
                "superclaw_install_id": superclaw_install_id,
                "return_mode": "device_code_or_loopback",
                "payswitch_public_url": str(config.get("public_url") or panel_url).rstrip("/"),
            },
        )
        start_response.raise_for_status()
        start_payload = start_response.json()
        if not isinstance(start_payload, dict):
            raise ValueError("Pay-Switch auth start response must be an object")
        code = str(start_payload.get("code") or "").strip()
        if not code:
            raise ValueError("Pay-Switch auth start response did not include a code")

        exchange_response = client.post(
            exchange_url,
            json={
                "schema": "clawhunt.pay-switch.plugin-auth.exchange.v1",
                "code": code,
                "device_id": device_id,
                "plugin_id": plugin_id,
            },
        )
        exchange_response.raise_for_status()
        exchange_payload = exchange_response.json()
        if not isinstance(exchange_payload, dict):
            raise ValueError("Pay-Switch auth exchange response must be an object")
        payagent_token = str(exchange_payload.get("payagent_token") or "").strip()
        if not payagent_token:
            raise ValueError("Pay-Switch auth exchange response did not include a token")
        return payagent_token


def _config_url_value(config: dict[str, Any], config_url: str, *keys: str) -> str:
    for key in keys:
        value = str(config.get(key) or "").strip()
        if value:
            return _absolute_url(config_url, value)
    return ""


def _absolute_url(reference_url: str, target: str) -> str:
    if re.match(r"^https?://", target):
        return target
    return urljoin(reference_url, target)


def _sandbox_preflight(package: PluginPackage) -> dict[str, Any]:
    """Fail closed on script-visible sandbox violations before sidecar startup.

    This is a lightweight Phase 2C guardrail for local shell-sidecar fixtures. It
    complements, but does not replace, a production OS/container/WASI sandbox.

    external_mcp packages carry no in-package sidecar script (the code lives in an
    external program the launcher resolves), so there is no entrypoint text to
    statically analyze here. Their containment is the per-call spawn + declared
    network/permissions (and a future OS sandbox), not this script guardrail —
    skip it rather than KeyError on the missing ``entrypoint``.
    """
    if str(package.manifest.get("runtime", {}).get("type")) == "external_mcp":
        return {}
    entrypoint = (package.root / package.manifest["runtime"]["entrypoint"]).resolve()
    if package.root.resolve() not in entrypoint.parents:
        return {"error_code": "PLUGIN_SANDBOX_VIOLATION", "diagnostic": "sidecar entrypoint escaped package root"}
    try:
        text = entrypoint.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {}
    text_without_shebang = "\n".join(line for index, line in enumerate(text.splitlines()) if not (index == 0 and line.startswith("#!")))
    checks = (
        _check_declared_environment_access(package.manifest, text_without_shebang),
        _check_declared_network_access(package.manifest, text_without_shebang),
        _check_declared_filesystem_access(package.manifest, text_without_shebang),
        _check_declared_process_access(package.manifest, text_without_shebang),
    )
    for check in checks:
        if check:
            return {"error_code": "PLUGIN_SANDBOX_VIOLATION", "diagnostic": check}
    return {}


def _check_declared_environment_access(manifest: dict[str, Any], text: str) -> str | None:
    declared = set(str(item) for item in manifest.get("permissions", {}).get("environment", []))
    for secret in manifest.get("configuration", {}).get("secrets", []):
        declared.add(str(secret.get("env_name") or secret.get("name")))
    # Settings that declare an env_name are injected by SuperClaw itself (config
    # protocol runtime delivery), so the plugin is allowed to read them — same as
    # secret env_names above.
    for setting in manifest.get("configuration", {}).get("settings", []):
        if isinstance(setting, dict) and setting.get("env_name"):
            declared.add(str(setting["env_name"]))
    local_assignments = set(re.findall(r"(?m)^\s*([A-Z_][A-Z0-9_]*)=", text))
    allowed = declared | local_assignments | {"PATH", "PWD", "OLDPWD", "IFS"}
    for name in sorted(set(re.findall(r"\$(?:\{)?([A-Z_][A-Z0-9_]*)", text))):
        if name not in allowed:
            return f"undeclared environment variable access: {name}"
    return None


def _check_declared_network_access(manifest: dict[str, Any], text: str) -> str | None:
    allowed_hosts = {str(item.get("host")) for item in manifest.get("permissions", {}).get("network", []) if isinstance(item, dict)}
    hosts = set(re.findall(r"https?://([^/'\"\s)]+)", text))
    for host in sorted(hosts):
        if host not in allowed_hosts:
            return f"undeclared network host: {host}"
    return None


def _check_declared_filesystem_access(manifest: dict[str, Any], text: str) -> str | None:
    filesystem_permissions = manifest.get("permissions", {}).get("filesystem", [])
    allowed_scopes = {str(item.get("scope")) for item in filesystem_permissions if isinstance(item, dict)}
    absolute_paths = set(re.findall(r"(?:cat|ls|cp|mv|rm|touch|mkdir|tee|find)\s+(/[^'\"\s]+)", text))
    absolute_paths |= set(re.findall(r"(?:>|>>|<)\s*(/[^'\"\s]+)", text))
    for path in sorted(absolute_paths):
        if path.startswith(("/dev/null", "/usr/bin/env")):
            continue
        if not allowed_scopes:
            return f"undeclared filesystem path: {path}"
        if path.startswith("/tmp/") and "artifact_dir" not in allowed_scopes:
            return f"undeclared filesystem path: {path}"
        if path.startswith("/Users/") and "workspace" not in allowed_scopes:
            return f"undeclared filesystem path: {path}"
    return None


def _check_declared_process_access(manifest: dict[str, Any], text: str) -> str | None:
    permissions = manifest.get("permissions", {})
    process_permissions = permissions.get("process", []) if isinstance(permissions, dict) else []
    allowed = {str(item) for item in process_permissions} if isinstance(process_permissions, list) else set()
    risky_patterns = {
        "python": r"(?m)(?:^|\s)(?:python|python3)\s+-c\b",
        "node": r"(?m)(?:^|\s)node\s+-e\b",
        "shell": r"(?m)(?:^|\s)(?:sh|bash|zsh)\s+-c\b",
        "netcat": r"(?m)(?:^|\s)(?:nc|netcat)\b",
        "open": r"(?m)(?:^|\s)open\s+",
        "osascript": r"(?m)(?:^|\s)osascript\b",
    }
    for name, pattern in risky_patterns.items():
        if re.search(pattern, text) and name not in allowed:
            return f"undeclared process spawn: {name}"
    return None


def _run_sidecar(package: PluginPackage, tool_input: dict[str, Any], env: dict[str, str], *, timeout_ms: int | None = None) -> dict[str, Any]:
    runtime = package.manifest["runtime"]
    entrypoint = (package.root / runtime["entrypoint"]).resolve()
    if package.root.resolve() not in entrypoint.parents:
        return {"exit_code": 1, "stdout": "", "stderr": "sidecar entrypoint escaped package root", "timed_out": False}
    # Only the *bare default* (no explicit timeout_ms, no manifest limit) is
    # env-floored — explicit/manifest values are preserved so the timeout-path
    # tests (e.g. tool_timeout_ms=100) still fire.
    timeout = float(timeout_ms or package.manifest.get("limits", {}).get("tool_timeout_ms") or floor_default_timeout_seconds(30.0) * 1000) / 1000
    try:
        completed = subprocess.run(
            command_for_script(entrypoint, [str(arg) for arg in runtime.get("args", [])]),
            input=json.dumps(tool_input, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=package.root,
            env=env,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {"exit_code": None, "stdout": redact_secrets(exc.stdout or ""), "stderr": redact_secrets(exc.stderr or ""), "timed_out": True}
    except OSError as exc:
        return {"exit_code": 1, "stdout": "", "stderr": redact_secrets(str(exc)), "timed_out": False}
    return {
        "exit_code": completed.returncode,
        "stdout": redact_secrets(completed.stdout or ""),
        "stderr": redact_secrets(completed.stderr or ""),
        "timed_out": False,
    }


_EXTERNAL_MCP_PROTOCOL_VERSION = "2025-06-18"

# Allowlist of launchers an external_mcp plugin may invoke. Defense in depth ON TOP
# OF the root-only curation gate: even a buggy/compromised curated manifest cannot
# point execution at an arbitrary PATH binary (e.g. bash/curl) — only at a known MCP
# server launcher. This narrows the launcher vector; it does NOT verify the bytes the
# launcher then resolves (external npm/uv code is outside the signing trust chain by
# design — that residual is mitigated by curation + version pinning, tracked as the
# OS-sandbox/provenance follow-up).
_EXTERNAL_MCP_ALLOWED_LAUNCHERS = frozenset({"npx", "uvx", "node", "python3", "deno", "bunx", "bun"})


def _external_mcp_exec_env(base_env: dict[str, str], launcher: str) -> dict[str, str]:
    """Exec env for a curated external MCP launcher (npx / uvx / node / ...).

    The launcher + args come from a ROOT-SIGNED curated manifest, so the command
    string is trusted. The sandbox sidecar PATH (/usr/bin:/bin:...) does not
    include version-managed toolchains (e.g. nvm's node), so we PREPEND the
    resolved launcher's own bin dir — just enough for it to find its peer tools
    (npx -> node live in the same dir) — and keep the already-whitelisted HOME for
    the package cache. No broad operator environment leaks: only the config/secret
    names already in ``base_env`` plus this one PATH widening reach the process.
    """
    env = dict(base_env)
    launcher_dir = os.path.dirname(launcher)
    if launcher_dir:
        existing = env.get("PATH", "")
        env["PATH"] = launcher_dir + (os.pathsep + existing if existing else "")
    return env


def _normalize_mcp_result(result: dict[str, Any]) -> dict[str, Any]:
    """Normalize an MCP ``tools/call`` result into a stable, schema-able envelope.

    Joins text content blocks into ``text``; passes ``structuredContent`` through
    as ``structured``; records non-text block types in ``block_types`` (raw bytes
    such as image/audio data are NEVER inlined into the model text path here).
    ``is_error`` reflects the MCP tool-level error flag (an in-band tool error the
    model should still see, distinct from a protocol/transport failure).
    """
    content = result.get("content")
    texts: list[str] = []
    block_types: list[str] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = str(block.get("type") or "")
            if btype == "text":
                texts.append(str(block.get("text") or ""))
            else:
                block_types.append(btype or "unknown")
    structured = result.get("structuredContent")
    return {
        "text": "\n".join(texts),
        "structured": structured if isinstance(structured, (dict, list)) else None,
        "block_types": block_types,
        "is_error": bool(result.get("isError")),
    }


def _terminate_external_mcp(proc: "subprocess.Popen[str]") -> None:
    """Terminate the launcher AND its descendants (npx -> node -> ...).

    The launcher spawns the real MCP server as a child, so terminating only the
    launcher can orphan the server. The process is started in its own session
    (``start_new_session=True``), so signaling its process GROUP reaps the whole
    tree — SIGTERM first, then SIGKILL if it does not exit. Non-POSIX falls back to
    the single-process terminate/kill.
    """
    if proc.poll() is not None:
        return
    for sig, escalate in ((signal.SIGTERM, False), (signal.SIGKILL, True)):
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), sig)
            elif escalate:
                proc.kill()
            else:
                proc.terminate()
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            proc.wait(timeout=2)
            return
        except subprocess.TimeoutExpired:
            continue


def _run_external_mcp(
    package: PluginPackage,
    tool_name: str,
    tool_input: dict[str, Any],
    env: dict[str, str],
    *,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Execute one tool call against a curated EXTERNAL MCP server.

    Mirrors ``_run_sidecar``'s return contract ({exit_code, stdout, stderr,
    timed_out}) so the existing downstream — output-schema validation, secret
    redaction, evidence — is reused unchanged. The server is spawned PER CALL
    (stateless, like the sidecar), handshaked over stdio MCP
    (initialize -> notifications/initialized -> tools/call), and its result
    normalized into the {text, structured, block_types, is_error} envelope the
    curated tool's ``output_schema`` declares.

    Transport ``stdio`` is supported now; ``sse``/``http`` fail closed
    (declared-but-unsupported) rather than silently degrading.
    """
    # Cleanup reaps the launcher + its children via POSIX process-group signals
    # (start_new_session + killpg). There is no equivalent here on non-POSIX, so a
    # timeout/cleanup could orphan the spawned server — fail closed rather than leak
    # a detached process. (Windows Job Object support is a separate follow-up.)
    if os.name != "posix":
        return {"exit_code": 1, "stdout": "", "stderr": "external_mcp is only supported on POSIX hosts in this build", "timed_out": False}
    runtime = package.manifest.get("runtime", {})
    transport = str(runtime.get("transport") or "stdio")
    if transport != "stdio":
        return {"exit_code": 1, "stdout": "", "stderr": f"external_mcp transport not supported yet: {transport}", "timed_out": False}
    command = str(runtime.get("command") or "")
    # A bare launcher NAME only (npx/uvx/node), resolved on the operator PATH.
    # Reject any path-bearing or absolute command so a manifest can never point
    # execution at an arbitrary on-disk binary outside PATH resolution — defense in
    # depth atop the schema pattern. (The launcher's own resolved bytes are still
    # outside the trust chain; curation + root-signing is what admits them.)
    if not command or "/" in command or "\\" in command or os.path.isabs(command):
        return {"exit_code": 1, "stdout": "", "stderr": "external_mcp command must be a bare launcher name (no path)", "timed_out": False}
    if command not in _EXTERNAL_MCP_ALLOWED_LAUNCHERS:
        return {"exit_code": 1, "stdout": "", "stderr": f"external_mcp launcher not allowlisted: {command}", "timed_out": False}
    resolved = shutil.which(command, path=os.environ.get("PATH"))
    if not resolved:
        return {"exit_code": 1, "stdout": "", "stderr": f"external_mcp launcher not found on PATH: {command}", "timed_out": False}
    args = [str(a) for a in runtime.get("args", [])]
    protocol_version = str((runtime.get("mcp_protocol_versions") or [_EXTERNAL_MCP_PROTOCOL_VERSION])[0])
    exec_env = _external_mcp_exec_env(env, resolved)
    timeout = float(timeout_ms or package.manifest.get("limits", {}).get("tool_timeout_ms") or floor_default_timeout_seconds(30.0) * 1000) / 1000

    try:
        proc = subprocess.Popen(
            [resolved, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=package.root,
            env=exec_env,
            # Own session/process-group so a timeout/cleanup can reap the launcher
            # AND the server it spawns (npx -> node), not just the launcher.
            start_new_session=True,
        )
    except OSError as exc:
        return {"exit_code": 1, "stdout": "", "stderr": redact_secrets(str(exc)), "timed_out": False}

    # Drain stderr concurrently so a chatty server cannot fill the stderr pipe and
    # wedge its own stdout reply (which would otherwise surface as a bogus timeout).
    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        try:
            if proc.stderr is not None:
                for line in proc.stderr:
                    stderr_chunks.append(line)
        except (OSError, ValueError):
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    result_box: dict[str, Any] = {}

    def _exchange() -> None:
        try:
            def send(obj: dict[str, Any]) -> None:
                assert proc.stdin is not None
                proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
                proc.stdin.flush()

            def read_reply(want_id: int) -> dict[str, Any] | None:
                assert proc.stdout is not None
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        return None
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # skip server log noise that isn't JSON-RPC
                    if not isinstance(msg, dict):
                        continue  # valid JSON but not a JSON-RPC object — ignore
                    if msg.get("id") == want_id:
                        return msg

            send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": protocol_version, "capabilities": {},
                             "clientInfo": {"name": "superclaw", "version": "1"}}})
            init = read_reply(1)
            if init is None:
                result_box["error"] = "external_mcp initialize: no response"
                return
            if init.get("error"):
                result_box["error"] = f"external_mcp initialize error: {json.dumps(init['error'])}"
                return
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                  "params": {"name": tool_name, "arguments": tool_input}})
            reply = read_reply(2)
            if reply is None:
                result_box["error"] = "external_mcp tools/call: no response"
                return
            if reply.get("error"):
                result_box["error"] = f"external_mcp tools/call error: {json.dumps(reply['error'])}"
                return
            result_box["result"] = reply.get("result", {})
        except Exception as exc:  # noqa: BLE001 — ANY handshake/parse failure must fail closed, never fake-succeed
            result_box["error"] = f"external_mcp exchange failed: {exc}"

    worker = threading.Thread(target=_exchange, daemon=True)
    worker.start()
    worker.join(timeout)
    timed_out = worker.is_alive()

    # Reap the launcher AND its children before reading anything back: a blocking
    # read on a live child waits for an EOF that only arrives on exit (deadlock),
    # and reaping lets the concurrent stderr drain reach EOF and finish.
    _terminate_external_mcp(proc)
    worker.join(2)
    stderr_thread.join(2)
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        try:
            if stream is not None:
                stream.close()
        except OSError:
            pass

    if timed_out:
        return {"exit_code": None, "stdout": "", "stderr": "external_mcp call timed out", "timed_out": True}

    stderr_text = "".join(stderr_chunks)
    # Fail closed if the exchange yielded neither a result nor an error (e.g. the
    # worker died leaving result_box empty) — never fall through to a silent empty
    # "success".
    if "error" not in result_box and "result" not in result_box:
        result_box["error"] = "external_mcp exchange produced no result"

    if "error" in result_box:
        detail = str(result_box["error"]) + (("\n" + stderr_text) if stderr_text else "")
        return {"exit_code": 1, "stdout": "", "stderr": redact_secrets(detail), "timed_out": False}

    # A protocol-level success: even an in-band tool error (is_error=True) is
    # returned to the model (exit_code 0) so it sees the error content, matching
    # MCP semantics — only transport/protocol failures above map to a hard error.
    normalized = _normalize_mcp_result(result_box.get("result", {}) or {})
    return {
        "exit_code": 0,
        "stdout": json.dumps(normalized, ensure_ascii=False),
        "stderr": redact_secrets(stderr_text),
        "timed_out": False,
    }


def _error_result(
    invocation_id: str,
    run_id: str,
    plugin_id: str,
    version: str,
    tool_name: str,
    code: str,
    tool_input: dict[str, Any],
    *,
    evidence: EvidenceBundle | None,
    artifact_dir: Path | None,
    package: PluginPackage | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    sandbox_exit_status: int | None = None,
    diagnostic: str | None = None,
) -> PluginProxyResult:
    message, retryable, status = PLUGIN_ERROR_MESSAGES[code]
    started = started_at or _utc_now()
    finished = finished_at or _utc_now()
    model_response = {"error": {"code": code, "message": message, "retryable": retryable, "evidence_id": invocation_id}}
    output_payload = {"error": {"code": code, "diagnostic": redact_secrets(diagnostic or message)}}
    record = _evidence_record(
        invocation_id,
        run_id,
        package,
        tool_name,
        status=status,
        entitlement_id=None,
        input_payload=tool_input,
        output_payload=output_payload,
        started_at=started,
        finished_at=finished,
        sandbox_exit_status=sandbox_exit_status,
        policy_decision=f"{code}: {redact_secrets(diagnostic)}" if diagnostic else code,
        fallback_plugin_id=plugin_id,
        fallback_version=version,
    )
    artifact = _write_invocation_artifact(record, artifact_dir)
    record["evidence_artifact_id"] = artifact.artifact_id
    model_response["error"]["evidence_id"] = artifact.artifact_id
    _attach_evidence(evidence, record, artifact, passed=False, detail=f"{code}: {message}")
    return PluginProxyResult(plugin_id, version, tool_name, False, model_response, record, artifact)


def _evidence_record(
    invocation_id: str,
    run_id: str,
    package: PluginPackage | None,
    tool_name: str,
    *,
    status: str,
    entitlement_id: str | None,
    input_payload: dict[str, Any],
    output_payload: Any,
    started_at: str,
    finished_at: str,
    sandbox_exit_status: int | None,
    policy_decision: str,
    fallback_plugin_id: str | None = None,
    fallback_version: str | None = None,
) -> dict[str, Any]:
    plugin_id = package.plugin_id if package else str(fallback_plugin_id or "unknown")
    version = package.version if package else str(fallback_version or "unknown")
    package_digest = package.package_digest if package else "sha256:" + ("0" * 64)
    return {
        "run_id": run_id,
        "plugin_id": plugin_id,
        "plugin_version": version,
        "package_digest": package_digest,
        "tool_name": tool_name,
        "started_at": started_at,
        "finished_at": finished_at,
        "status": status,
        "entitlement_id": entitlement_id,
        "input_digest": _digest_json(input_payload),
        "output_digest": _digest_json(output_payload),
        "evidence_artifact_id": invocation_id,
        "policy_decision": policy_decision,
        "sandbox_exit_status": sandbox_exit_status,
    }


def _write_invocation_artifact(record: dict[str, Any], artifact_dir: Path | None) -> ArtifactRef:
    root = artifact_dir or superclaw_data_path("artifacts", "plugins")
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{record['evidence_artifact_id']}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return ArtifactRef(
        kind="plugin-invocation",
        path=str(path),
        sensitivity="internal",
        artifact_id=str(record["evidence_artifact_id"]),
        metadata={"plugin_id": record["plugin_id"], "tool_name": record["tool_name"], "status": record["status"]},
    )


def _attach_evidence(evidence: EvidenceBundle | None, record: dict[str, Any], artifact: ArtifactRef, *, passed: bool, detail: str) -> None:
    if evidence is None:
        return
    evidence.add_artifact(artifact)
    evidence.add_probe("plugin_invocation", 200 if passed else 400, record)
    evidence.add_finding("plugin_proxy_invocation", passed, detail, "info" if passed else "high")


def _digest_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


# Plugins emit image content via the reserved top-level `_superclaw_images`
# output field. It is intercepted before the text redaction/budget/schema
# pipeline (images are binary, not model text) and forwarded to the runtime as
# native MCP image content.
PLUGIN_IMAGE_OUTPUT_FIELD = "_superclaw_images"
_IMAGE_MIME_ALLOWLIST = frozenset({"image/png", "image/jpeg", "image/webp"})
_MAX_PLUGIN_IMAGES = 12
_MAX_PLUGIN_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024  # 8 MiB decoded, across all tiles


def _extract_plugin_images(output: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Pop and validate the reserved image field from raw plugin output.

    Returns ``(output_without_images, images)``. Each returned image is
    ``{"data": <base64>, "mime_type": <allowed mime>}`` plus optional
    ``name``/``caption``. Invalid entries are dropped; the count and decoded
    total bytes are capped so a sidecar cannot blow up the runtime's context.
    Images deliberately bypass secret redaction (binary data, not text) — the
    capture path is responsible for masking sensitive on-page fields.
    """
    if not isinstance(output, dict) or PLUGIN_IMAGE_OUTPUT_FIELD not in output:
        return output, []
    raw = output.pop(PLUGIN_IMAGE_OUTPUT_FIELD)
    if not isinstance(raw, list):
        return output, []
    images: list[dict[str, Any]] = []
    total_bytes = 0
    for entry in raw:
        if len(images) >= _MAX_PLUGIN_IMAGES:
            break
        if not isinstance(entry, dict):
            continue
        data = entry.get("data")
        mime = str(entry.get("mime_type") or "image/png").lower()
        if not isinstance(data, str) or not data or mime not in _IMAGE_MIME_ALLOWLIST:
            continue
        try:
            decoded = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            continue
        if not decoded:
            continue
        total_bytes += len(decoded)
        if total_bytes > _MAX_PLUGIN_IMAGE_TOTAL_BYTES:
            break
        image: dict[str, Any] = {"data": data, "mime_type": mime}
        name = entry.get("name")
        if isinstance(name, str) and name:
            image["name"] = name[:120]
        caption = entry.get("caption")
        if isinstance(caption, str) and caption:
            image["caption"] = caption[:300]
        images.append(image)
    return output, images


class _OutputBudgetExceeded(Exception):
    """Raised when a sidecar's output cannot be brought under the model-output
    byte budget by string truncation (e.g. it fans out many keys)."""


def _redact_json(value: Any) -> Any:
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact_json(item) for key, item in value.items()}
    return value


def _redact_injected_secrets(value: Any, secret_values: list[str]) -> Any:
    """Literal-redact the exact secret values SuperClaw injected into the sidecar,
    independent of regex coverage. Only values >= 8 chars to avoid corrupting
    legitimate short output."""
    secrets = [s for s in secret_values if isinstance(s, str) and len(s) >= 8]
    if not secrets:
        return value
    if isinstance(value, str):
        out = value
        for secret in secrets:
            if secret in out:
                out = out.replace(secret, "[REDACTED]")
        return out
    if isinstance(value, list):
        return [_redact_injected_secrets(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: _redact_injected_secrets(item, secrets) for key, item in value.items()}
    return value


def _drop_undeclared_output_fields(value: Any, schema: dict[str, Any]) -> Any:
    if not isinstance(value, dict) or schema.get("type") != "object":
        return value
    if schema.get("additionalProperties", True) is not False:
        return value
    declared = set((schema.get("properties") or {}).keys())
    return {key: item for key, item in value.items() if key in declared}


def _enforce_output_budget(value: Any, max_bytes: int) -> Any:
    if len(_json_bytes(value)) <= max_bytes:
        return value
    budget = max(0, max_bytes - 16)
    truncated = _truncate_json_strings(value, budget)
    while len(_json_bytes(truncated)) > max_bytes and budget > 0:
        budget = budget // 2
        truncated = _truncate_json_strings(value, budget)
    if len(_json_bytes(truncated)) > max_bytes:
        # Structure/keys (not just string values) exceed the budget — string
        # truncation can't fix this, so reject rather than forward an oversized
        # payload that defeats the model-output cap.
        raise _OutputBudgetExceeded(
            f"plugin output exceeds {max_bytes}-byte model-output budget even after truncation"
        )
    return truncated


def _truncate_json_strings(value: Any, budget: int) -> Any:
    if isinstance(value, str):
        return value.encode("utf-8")[:budget].decode("utf-8", errors="ignore")
    if isinstance(value, list):
        return [_truncate_json_strings(item, budget) for item in value]
    if isinstance(value, dict):
        return {key: _truncate_json_strings(item, budget) for key, item in value.items()}
    return value


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Reusable public API (stable thin wrappers over the internal gate functions),
# so the runtime-projection layer can pre-filter "available" plugins using the
# exact same governance checks the call path enforces. Signatures/return
# contracts mirror the private functions and must stay stable.
# ---------------------------------------------------------------------------


def load_cached_package(plugin_id: str, *, version: str | None = None, cache_root: Path | None = None) -> PluginPackage | None:
    return _load_cached_package(plugin_id, version=version, cache_root=cache_root)


def verify_cached_package_before_execution(package: PluginPackage, *, public_key: str | None = None, revocation_file: Path | None = None) -> str | None:
    """Return a PLUGIN_* error code if signature/revocation fails, else None."""
    return _verify_cached_package_before_execution(package, public_key=public_key, revocation_file=revocation_file)


def resolve_entitlement(package: PluginPackage, entitlement_file: Path | None = None) -> dict[str, Any]:
    return _resolve_entitlement(package, entitlement_file or default_entitlement_file())


def resolve_runtime_policy(package: PluginPackage, policy_file: Path | None = None, *, runtime_version: str = DEFAULT_RUNTIME_VERSION) -> dict[str, Any]:
    return _resolve_runtime_policy(package, policy_file or default_policy_file(), runtime_version=runtime_version)
