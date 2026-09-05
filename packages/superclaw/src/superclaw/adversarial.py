from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from superclaw.models import EvidenceBundle, VerificationFinding
from superclaw.secrets_scan import iter_secret_matches


@dataclass(frozen=True)
class VerifierRuleSpec:
    name: str
    input_fields: tuple[str, ...]
    fail_mode: str
    severity: str
    remediation: str


ADVERSARIAL_RULE_SPECS: dict[str, VerifierRuleSpec] = {
    "command_backed_verification": VerifierRuleSpec(
        name="command_backed_verification",
        input_fields=("commands",),
        fail_mode="fail_closed",
        severity="high",
        remediation="Persist at least one successful command-backed verification output before final verdict.",
    ),
    "non_happy_path_probe": VerifierRuleSpec(
        name="non_happy_path_probe",
        input_fields=("probes",),
        fail_mode="fail_closed",
        severity="high",
        remediation="Record at least one protected or negative-path probe with a recognized status code and marker.",
    ),
    "evidence_consistency": VerifierRuleSpec(
        name="evidence_consistency",
        input_fields=("commands", "probes", "artifacts", "submitted_to_clawhunt"),
        fail_mode="fail_closed",
        severity="high",
        remediation="Repair missing command, probe, artifact, or submission evidence fields before accepting the run.",
    ),
    "secret_redaction": VerifierRuleSpec(
        name="secret_redaction",
        input_fields=("commands", "worker_results", "artifacts", "submission_response"),
        fail_mode="fail_closed",
        severity="critical",
        remediation="Redact secret-like material from transcripts, command output, and serialized evidence before persistence.",
    ),
    "backend_readiness_classification": VerifierRuleSpec(
        name="backend_readiness_classification",
        input_fields=("commands", "worker_results", "probes", "submission_response"),
        fail_mode="fail_closed",
        severity="critical",
        remediation="Classify auth, raw-mode, or quota blockers as runtime-readiness failures instead of successful delivery evidence.",
    ),
    "submission_artifact_consistency": VerifierRuleSpec(
        name="submission_artifact_consistency",
        input_fields=("submitted_to_clawhunt", "submission_response", "artifacts"),
        fail_mode="fail_closed",
        severity="high",
        remediation="Persist accepted submission responses together with evidence-json and worker artifact references.",
    ),
    "artifact_integrity": VerifierRuleSpec(
        name="artifact_integrity",
        input_fields=("artifacts", "worker_results"),
        fail_mode="fail_closed",
        severity="high",
        remediation="Ensure every artifact has a kind, path, valid sensitivity, and unique id, and that worker artifact/transcript references resolve to declared artifacts.",
    ),
    "plugin_policy_boundary": VerifierRuleSpec(
        name="plugin_policy_boundary",
        input_fields=("commands", "worker_results", "probes", "artifacts", "submission_response"),
        fail_mode="fail_closed",
        severity="critical",
        remediation="Route plugin access through the SuperClaw proxy only; remove direct plugin directories, entitlement tokens, revoked-success evidence, and secret-bearing plugin output from model-visible evidence.",
    ),
}


PROFILE_FINDING_NAMES = {
    *ADVERSARIAL_RULE_SPECS.keys(),
}

_NEGATIVE_STATUS_CODES = {400, 401, 403, 404, 409, 422, 429, 500, 503}
_NEGATIVE_NAME_MARKERS = (
    "negative",
    "non_happy",
    "protected",
    "unauthorized",
    "forbidden",
    "not_found",
    "missing_auth",
    "invalid_auth",
)
_BACKEND_BLOCK_MARKERS = {
    # --- Authentication / login required ---
    "sign in with chatgpt": "AUTH_REQUIRED",
    "sign in to continue": "AUTH_REQUIRED",
    "please sign in": "AUTH_REQUIRED",
    "please log in": "AUTH_REQUIRED",
    "log in to continue": "AUTH_REQUIRED",
    "not logged in": "AUTH_REQUIRED",
    "paste an api key": "AUTH_REQUIRED",
    "api key required": "AUTH_REQUIRED",
    "missing api key": "AUTH_REQUIRED",
    "no api key": "AUTH_REQUIRED",
    "set your api key": "AUTH_REQUIRED",
    "not authenticated": "AUTH_REQUIRED",
    "authentication required": "AUTH_REQUIRED",
    "authentication failed": "AUTH_REQUIRED",
    "please authenticate": "AUTH_REQUIRED",
    "login required": "AUTH_REQUIRED",
    "invalid api key": "AUTH_REQUIRED",
    "incorrect api key": "AUTH_REQUIRED",
    "credentials not found": "AUTH_REQUIRED",
    "claude login": "AUTH_REQUIRED",
    "codex login": "AUTH_REQUIRED",
    "session has expired": "AUTH_REQUIRED",
    "session expired": "AUTH_REQUIRED",
    "token has expired": "AUTH_REQUIRED",
    "token expired": "AUTH_REQUIRED",
    # --- Usage / quota / rate limiting ---
    "out of extra usage": "USAGE_QUOTA_EXHAUSTED",
    "usage limit": "USAGE_QUOTA_EXHAUSTED",
    "quota exceeded": "USAGE_QUOTA_EXHAUSTED",
    "insufficient quota": "USAGE_QUOTA_EXHAUSTED",
    "insufficient_quota": "USAGE_QUOTA_EXHAUSTED",
    "rate limit exceeded": "USAGE_QUOTA_EXHAUSTED",
    "rate_limit_exceeded": "USAGE_QUOTA_EXHAUSTED",
    "too many requests": "USAGE_QUOTA_EXHAUSTED",
    "out of credits": "USAGE_QUOTA_EXHAUSTED",
    "credit balance is too low": "USAGE_QUOTA_EXHAUSTED",
    "plan limit reached": "USAGE_QUOTA_EXHAUSTED",
    "upgrade your plan": "USAGE_QUOTA_EXHAUSTED",
    # --- Non-interactive / raw mode unsupported ---
    "raw mode is not supported": "STDIN_RAW_MODE_UNSUPPORTED",
    "raw mode not supported": "STDIN_RAW_MODE_UNSUPPORTED",
    "stdin is not a tty": "STDIN_RAW_MODE_UNSUPPORTED",
    "requires an interactive terminal": "STDIN_RAW_MODE_UNSUPPORTED",
}

_PLUGIN_PROTECTED_MARKERS = (
    ".superclaw/plugins/cache",
    "/.superclaw/plugins/cache",
    "\\.superclaw\\plugins\\cache",
    "\"plugin_dirs\"",
    "'plugin_dirs'",
    "--plugin-dir",
    "\"plugin_dir\"",
    "'plugin_dir'",
    "entitlement_jwt",
    "entitlement_token",
    "license_token",
)
_PLUGIN_RAW_OUTPUT_KEYS = {
    "output",
    "output_payload",
    "raw_output",
    "stdout",
    "stderr",
    "tool_output",
}


def _bundle_text(bundle: EvidenceBundle) -> str:
    return json.dumps(bundle.to_dict(), ensure_ascii=False, default=str)


def _successful_commands(bundle: EvidenceBundle) -> list[dict[str, Any]]:
    return [
        command
        for command in bundle.commands
        if command.get("exit_code") == 0 and bool(str(command.get("output") or "").strip())
    ]


def _negative_probes(bundle: EvidenceBundle) -> list[dict[str, Any]]:
    probes: list[dict[str, Any]] = []
    for probe in bundle.probes:
        name = str(probe.get("name") or "").lower()
        status_code = probe.get("status_code")
        if status_code in _NEGATIVE_STATUS_CODES and any(marker in name for marker in _NEGATIVE_NAME_MARKERS):
            probes.append(probe)
    return probes


def _consistency_errors(bundle: EvidenceBundle) -> list[str]:
    errors: list[str] = []
    if not bundle.commands:
        errors.append("missing command evidence")
    for command in bundle.commands:
        if not command.get("command"):
            errors.append("command missing command text")
        if not isinstance(command.get("exit_code"), int):
            errors.append("command missing integer exit_code")
        if command.get("output") is None:
            errors.append("command missing output")
        if command.get("exit_code") not in (0, None):
            errors.append(f"command failed: {command.get('command')}")

    if not bundle.probes:
        errors.append("missing probe evidence")
    for probe in bundle.probes:
        if not probe.get("name"):
            errors.append("probe missing name")
        if not isinstance(probe.get("status_code"), int):
            errors.append("probe missing integer status_code")

    for artifact in bundle.artifacts:
        if not artifact.path:
            errors.append(f"artifact missing path: {artifact.kind}")

    if bundle.submitted_to_clawhunt and not bundle.artifacts:
        errors.append("submission marked without artifact evidence")
    return errors


_VALID_ARTIFACT_SENSITIVITIES = {"public", "internal", "sensitive"}


def _artifact_integrity_errors(bundle: EvidenceBundle) -> list[str]:
    errors: list[str] = []
    seen_ids: set[str] = set()
    artifact_paths = {artifact.path for artifact in bundle.artifacts if artifact.path}
    for artifact in bundle.artifacts:
        if not artifact.kind:
            errors.append("artifact missing kind")
        if not artifact.path:
            errors.append(f"artifact missing path: {artifact.kind or 'unknown'}")
        if artifact.sensitivity not in _VALID_ARTIFACT_SENSITIVITIES:
            errors.append(f"artifact invalid sensitivity: {artifact.sensitivity!r}")
        if artifact.artifact_id:
            if artifact.artifact_id in seen_ids:
                errors.append(f"duplicate artifact_id: {artifact.artifact_id}")
            seen_ids.add(artifact.artifact_id)
    # Worker artifact/transcript references must resolve to a declared artifact.
    for result in bundle.worker_results:
        if result.artifact_path and result.artifact_path not in artifact_paths:
            errors.append(f"dangling worker artifact_path: {result.task_id}")
        if result.transcript_path and result.transcript_path not in artifact_paths:
            errors.append(f"dangling worker transcript_path: {result.task_id}")
    return errors


def _visible_plugin_policy_surfaces(bundle: EvidenceBundle) -> list[str]:
    surfaces: list[str] = []
    surfaces.extend(str(command.get("command") or "") for command in bundle.commands)
    surfaces.extend(str(command.get("output") or "") for command in bundle.commands)
    for result in bundle.worker_results:
        surfaces.append(result.command)
        surfaces.append(result.output)
    surfaces.extend(json.dumps(probe, ensure_ascii=False, default=str) for probe in bundle.probes)
    surfaces.extend(json.dumps(artifact.metadata, ensure_ascii=False, default=str) for artifact in bundle.artifacts)
    if bundle.submission_response is not None:
        surfaces.append(json.dumps(bundle.submission_response, ensure_ascii=False, default=str))
    return surfaces


def _iter_nested_dicts(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(_iter_nested_dicts(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_iter_nested_dicts(child))
    return found


def _plugin_invocation_records(bundle: EvidenceBundle) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for probe in bundle.probes:
        if probe.get("name") == "plugin_invocation":
            body = probe.get("body")
            if isinstance(body, dict):
                records.append(body)
    return records


def _plugin_output_secret_errors(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for nested in _iter_nested_dicts(record):
        for key, value in nested.items():
            if str(key) not in _PLUGIN_RAW_OUTPUT_KEYS:
                continue
            serialized = json.dumps(value, ensure_ascii=False, default=str)
            if iter_secret_matches(serialized):
                plugin_id = str(record.get("plugin_id") or "unknown")
                tool_name = str(record.get("tool_name") or "unknown")
                errors.append(f"secret-bearing plugin output exposed for {plugin_id}.{tool_name}")
    return errors


def _plugin_policy_boundary_errors(bundle: EvidenceBundle) -> list[str]:
    errors: list[str] = []
    for surface in _visible_plugin_policy_surfaces(bundle):
        lowered = surface.lower()
        for marker in _PLUGIN_PROTECTED_MARKERS:
            if marker in lowered:
                errors.append(f"protected plugin policy material exposed: {marker}")
                break

    for record in _plugin_invocation_records(bundle):
        status = str(record.get("status") or "").lower()
        decision = json.dumps(
            {
                "policy_decision": record.get("policy_decision"),
                "error_code": record.get("error_code"),
                "error": record.get("error"),
            },
            ensure_ascii=False,
            default=str,
        ).lower()
        if status == "ok" and ("plugin_revoked" in decision or record.get("revoked") is True):
            plugin_id = str(record.get("plugin_id") or "unknown")
            tool_name = str(record.get("tool_name") or "unknown")
            errors.append(f"revoked plugin recorded as successful: {plugin_id}.{tool_name}")
        errors.extend(_plugin_output_secret_errors(record))
    return errors


def _backend_blockers(bundle: EvidenceBundle) -> list[tuple[str, str]]:
    blocked: list[tuple[str, str]] = []
    surfaces: list[str] = []
    surfaces.extend(str(command.get("output") or "") for command in bundle.commands)
    surfaces.extend(result.output for result in bundle.worker_results)
    # Probe bodies are scanned only for SUCCESS-status (<400) probes: a 2xx
    # response that still carries an auth/quota/raw-mode prompt signals a
    # fake-ready backend. Negative-path probes (4xx/5xx) legitimately echo
    # auth-failure text and must not be misclassified as backend blockers.
    for probe in bundle.probes:
        status = probe.get("status_code")
        if isinstance(status, int) and status < 400:
            surfaces.append(json.dumps(probe.get("body"), ensure_ascii=False, default=str))
    # An echoed blocker inside the submission response means delivery never
    # really completed even if a payload came back.
    if bundle.submission_response is not None:
        surfaces.append(json.dumps(bundle.submission_response, ensure_ascii=False, default=str))
    for surface in surfaces:
        lowered = surface.lower()
        for marker, code in _BACKEND_BLOCK_MARKERS.items():
            if marker in lowered:
                blocked.append((marker, code))
    return blocked


def _submission_consistency_errors(bundle: EvidenceBundle) -> list[str]:
    if not bundle.submitted_to_clawhunt:
        return []
    errors: list[str] = []
    response = bundle.submission_response or {}
    status_code = response.get("status_code")
    body = response.get("body") if isinstance(response.get("body"), dict) else {}
    accepted = bool(body.get("accepted") or body.get("success"))
    if not response:
        errors.append("submission marked without response payload")
    elif not isinstance(status_code, int):
        errors.append("submission response missing integer status_code")
    elif status_code >= 400:
        errors.append(f"submission response failed with status {status_code}")
    elif not accepted:
        errors.append("submission response did not confirm acceptance")

    artifact_kinds = {artifact.kind for artifact in bundle.artifacts}
    if "evidence-json" not in artifact_kinds:
        errors.append("submitted run missing evidence-json artifact")
    if "worker-log" not in artifact_kinds and "worker-transcript" not in artifact_kinds:
        errors.append("submitted run missing worker artifact evidence")
    return errors


def adversarial_rule_specs() -> dict[str, VerifierRuleSpec]:
    return dict(ADVERSARIAL_RULE_SPECS)


def _build_rule_finding(name: str, *, passed: bool, detail: str) -> VerificationFinding:
    spec = ADVERSARIAL_RULE_SPECS[name]
    return VerificationFinding(
        name=name,
        passed=passed,
        detail=detail,
        severity=spec.severity,  # type: ignore[arg-type]
        input_fields=list(spec.input_fields),
        fail_mode=spec.fail_mode,  # type: ignore[arg-type]
        remediation=spec.remediation,
    )


def run_adversarial_profile(bundle: EvidenceBundle) -> list[VerificationFinding]:
    successful_commands = _successful_commands(bundle)
    negative_probes = _negative_probes(bundle)
    consistency_errors = _consistency_errors(bundle)
    backend_blockers = _backend_blockers(bundle)
    submission_errors = _submission_consistency_errors(bundle)
    artifact_errors = _artifact_integrity_errors(bundle)
    plugin_policy_errors = _plugin_policy_boundary_errors(bundle)
    leaked_patterns = iter_secret_matches(_bundle_text(bundle))

    findings = [
        _build_rule_finding(
            "command_backed_verification",
            passed=bool(successful_commands),
            detail=(
                f"{len(successful_commands)} successful command output(s) present"
                if successful_commands
                else "No successful command-backed verification output found"
            ),
        ),
        _build_rule_finding(
            "non_happy_path_probe",
            passed=bool(negative_probes),
            detail=(
                f"{len(negative_probes)} protected or negative probe(s) present"
                if negative_probes
                else "No protected/negative probe evidence found"
            ),
        ),
        _build_rule_finding(
            "evidence_consistency",
            passed=not consistency_errors,
            detail="Evidence fields are internally consistent"
            if not consistency_errors
            else "; ".join(consistency_errors[:5]),
        ),
        _build_rule_finding(
            "secret_redaction",
            passed=not leaked_patterns,
            detail="No secret-like material found"
            if not leaked_patterns
            else f"{len(leaked_patterns)} secret-like pattern(s) found",
        ),
        _build_rule_finding(
            "backend_readiness_classification",
            passed=not backend_blockers,
            detail="No backend auth/readiness blocker markers found"
            if not backend_blockers
            else "; ".join(f"{code} via marker {marker!r}" for marker, code in backend_blockers[:3]),
        ),
        _build_rule_finding(
            "submission_artifact_consistency",
            passed=not submission_errors,
            detail="Submission response and artifact set are internally consistent"
            if not submission_errors
            else "; ".join(submission_errors[:5]),
        ),
        _build_rule_finding(
            "artifact_integrity",
            passed=not artifact_errors,
            detail="Artifact references are well-formed and resolvable"
            if not artifact_errors
            else "; ".join(artifact_errors[:5]),
        ),
        _build_rule_finding(
            "plugin_policy_boundary",
            passed=not plugin_policy_errors,
            detail="Plugin policy boundary evidence is proxy-only and secret-free"
            if not plugin_policy_errors
            else "; ".join(plugin_policy_errors[:5]),
        ),
    ]
    return findings


def apply_adversarial_profile(bundle: EvidenceBundle) -> list[VerificationFinding]:
    findings = run_adversarial_profile(bundle)
    bundle.findings = [finding for finding in bundle.findings if finding.name not in PROFILE_FINDING_NAMES]
    bundle.findings.extend(findings)
    return findings


# ---------------------------------------------------------------------------
# Verification strategy (kept in-core, not a plugin): verification holds the run
# mutation lease and drives the state machine, so it must run synchronously in
# the orchestrator. The strategy seam lets that policy be swapped/injected
# without externalizing the lease/atomicity.
# ---------------------------------------------------------------------------


class VerificationStrategy(Protocol):
    def verify(self, bundle: EvidenceBundle) -> list[VerificationFinding]:
        """Inspect a finished run's evidence and return (and attach) findings."""
        ...


class AdversarialProfileStrategy:
    """Default strategy: the built-in adversarial evidence profile."""

    def verify(self, bundle: EvidenceBundle) -> list[VerificationFinding]:
        return apply_adversarial_profile(bundle)


class TrustVerificationStrategy:
    """Light strategy for non-delivery tasks (research, plugin calls, Q&A).

    It adds no adversarial findings, so the run is not required to produce
    command-backed delivery evidence. The chain verdict is then computed purely
    from what actually happened (a successful worker yields CONTROL_PLANE_READY
    instead of a forced FAIL). Use this for everyday tasks; reserve the
    adversarial profile for verifiable delivery / bounty fulfillment.
    """

    def verify(self, bundle: EvidenceBundle) -> list[VerificationFinding]:
        return []


def default_verification_strategies() -> dict[str, VerificationStrategy]:
    """Built-in registry mapping a verification_policy name to a strategy.

    - ``adversarial``: full evidence profile, for verifiable delivery / bounties.
    - ``trust`` / ``none``: no-op, for light agentic tasks that should not be
      held to delivery-grade evidence requirements.
    """
    trust = TrustVerificationStrategy()
    return {
        "adversarial": AdversarialProfileStrategy(),
        "trust": trust,
        "none": trust,
    }
