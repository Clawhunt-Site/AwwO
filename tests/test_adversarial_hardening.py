"""Hardening coverage for the adversarial verifier's secret and backend-blocker detection.

These cases pin the broadened (but still fail-closed) detection surface so future
edits cannot silently regress coverage of common real-world secret formats and
agent-backend auth/quota failure phrasings.
"""
import pytest

from superclaw.adversarial import run_adversarial_profile
from superclaw.models import ArtifactRef, EvidenceBundle, WorkerResult


def _findings(bundle: EvidenceBundle):
    return {finding.name: finding for finding in run_adversarial_profile(bundle)}


def _base(run_id: str = "run_harden") -> EvidenceBundle:
    """A bundle that otherwise passes, so each test isolates one rule."""
    bundle = EvidenceBundle(run_id=run_id)
    bundle.add_command("python -m pytest -q", 0, "17 passed")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})
    bundle.add_artifact(ArtifactRef(kind="report", path="artifacts/evidence.json", sensitivity="public"))
    return bundle


@pytest.mark.parametrize(
    "secret",
    [
        "AKIAIOSFODNN7EXAMPLE",                              # AWS access key id
        "ASIAIOSFODNN7EXAMPLE",                              # AWS temporary access key id
        "sk-proj-" + "a" * 48,                              # OpenAI project key
        "sk-ant-api03-" + "A1b2" * 12,                      # Anthropic key
        "AIza" + "b" * 35,                                  # Google API key
        "xoxb-123456789012-abcdefABCDEF1234",               # Slack bot token
        "eyJhbGciOiJIUzI1Ni3.eyJzdWIiOiIxMjM4OTk2.dQw4w9WgXcQ",  # JWT
        "github_pat_" + "A" * 22 + "_" + "b" * 30,          # GitHub fine-grained PAT
    ],
)
def test_expanded_secret_formats_are_detected(secret: str) -> None:
    bundle = _base()
    bundle.add_command("dump-config", 0, f"value={secret}")
    assert _findings(bundle)["secret_redaction"].passed is False, secret


@pytest.mark.parametrize(
    "text",
    [
        "password = hunter2supersecret",
        "api_key: 'abcdef1234567890'",
        "client_secret=abcdef0123456789ZZ",
        "AWS_SECRET_ACCESS_KEY=" + "A" * 40,
    ],
)
def test_generic_credential_assignments_are_detected(text: str) -> None:
    bundle = _base()
    bundle.add_command("env", 0, text)
    assert _findings(bundle)["secret_redaction"].passed is False, text


@pytest.mark.parametrize(
    "text,expected_code",
    [
        ("Please log in to continue", "AUTH_REQUIRED"),
        ("Authentication failed for backend", "AUTH_REQUIRED"),
        ("Run `claude login` to authenticate", "AUTH_REQUIRED"),
        ("Please run codex login first", "AUTH_REQUIRED"),
        ("Error: your session has expired", "AUTH_REQUIRED"),
        ("Error: insufficient_quota", "USAGE_QUOTA_EXHAUSTED"),
        ("rate limit exceeded, retry later", "USAGE_QUOTA_EXHAUSTED"),
        ("Your credit balance is too low", "USAGE_QUOTA_EXHAUSTED"),
        ("You have hit your usage limit reached for today", "USAGE_QUOTA_EXHAUSTED"),
        ("stdin is not a tty", "STDIN_RAW_MODE_UNSUPPORTED"),
        ("Raw mode not supported on this terminal", "STDIN_RAW_MODE_UNSUPPORTED"),
    ],
)
def test_expanded_backend_blockers_are_detected(text: str, expected_code: str) -> None:
    bundle = _base()
    bundle.add_command("agent exec", 0, text)
    finding = _findings(bundle)["backend_readiness_classification"]
    assert finding.passed is False, text
    assert expected_code in finding.detail


def test_clean_evidence_is_not_flagged_by_expanded_rules() -> None:
    """Guard against false positives from the broadened patterns/markers."""
    bundle = _base()
    bundle.add_command("curl -s /health", 0, '200 OK\n{"status": "ready", "uptime": 1234}')
    bundle.add_command("ls artifacts", 0, "evidence.json  worker.log  transcript.json")
    bundle.add_command("git rev-parse HEAD", 0, "f6816480ab12cd34ef56aa00bb11cc22dd33ee44")
    findings = _findings(bundle)
    assert findings["secret_redaction"].passed is True
    assert findings["backend_readiness_classification"].passed is True
    assert findings["command_backed_verification"].passed is True


def test_backend_blocker_detection_remains_case_insensitive() -> None:
    bundle = _base()
    bundle.add_command("agent", 0, "RATE LIMIT EXCEEDED")
    assert _findings(bundle)["backend_readiness_classification"].passed is False


def test_backend_blocker_in_success_probe_body_is_detected() -> None:
    bundle = _base()
    bundle.add_probe("agent_status", 200, {"message": "Please sign in to continue"})
    finding = _findings(bundle)["backend_readiness_classification"]
    assert finding.passed is False
    assert "AUTH_REQUIRED" in finding.detail


def test_auth_text_in_negative_path_probe_body_is_not_misclassified() -> None:
    # A 4xx negative-path probe legitimately echoes auth-failure text and must
    # not be read as an unauthenticated backend.
    bundle = EvidenceBundle(run_id="run_negprobe")
    bundle.add_command("python -m pytest -q", 0, "17 passed")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "authentication required"})
    assert _findings(bundle)["backend_readiness_classification"].passed is True


def test_backend_blocker_in_submission_response_is_detected() -> None:
    bundle = _base()
    bundle.mark_submitted({"status_code": 200, "body": {"error": "quota exceeded"}})
    finding = _findings(bundle)["backend_readiness_classification"]
    assert finding.passed is False
    assert "USAGE_QUOTA_EXHAUSTED" in finding.detail


# --- artifact_integrity rule ---


def _worker(**overrides) -> WorkerResult:
    base = dict(
        task_id="t1", role="implement", backend="local", command="run",
        exit_code=0, output="ok", duration_seconds=0.1,
    )
    base.update(overrides)
    return WorkerResult(**base)


def test_artifact_integrity_passes_for_well_formed_artifacts() -> None:
    assert _findings(_base())["artifact_integrity"].passed is True


def test_artifact_integrity_flags_missing_path() -> None:
    bundle = _base()
    bundle.artifacts.append(ArtifactRef(kind="report", path="", sensitivity="public"))
    finding = _findings(bundle)["artifact_integrity"]
    assert finding.passed is False
    assert "missing path" in finding.detail


def test_artifact_integrity_flags_missing_kind() -> None:
    bundle = _base()
    bundle.artifacts.append(ArtifactRef(kind="", path="artifacts/x.log"))
    finding = _findings(bundle)["artifact_integrity"]
    assert finding.passed is False
    assert "missing kind" in finding.detail


def test_artifact_integrity_flags_invalid_sensitivity() -> None:
    bundle = _base()
    bundle.artifacts.append(ArtifactRef(kind="report", path="artifacts/x", sensitivity="top-secret"))  # type: ignore[arg-type]
    finding = _findings(bundle)["artifact_integrity"]
    assert finding.passed is False
    assert "sensitivity" in finding.detail


def test_artifact_integrity_flags_duplicate_artifact_id() -> None:
    bundle = _base()
    bundle.artifacts.append(ArtifactRef(kind="a", path="p1", artifact_id="dup"))
    bundle.artifacts.append(ArtifactRef(kind="b", path="p2", artifact_id="dup"))
    finding = _findings(bundle)["artifact_integrity"]
    assert finding.passed is False
    assert "duplicate artifact_id" in finding.detail


def test_artifact_integrity_flags_dangling_worker_reference() -> None:
    bundle = _base()
    bundle.add_worker_result(_worker(artifact_path="artifacts/missing.log"))
    finding = _findings(bundle)["artifact_integrity"]
    assert finding.passed is False
    assert "dangling" in finding.detail


def test_artifact_integrity_passes_when_worker_references_resolve() -> None:
    bundle = _base()
    bundle.add_artifact(ArtifactRef(kind="worker-log", path="artifacts/t1.log", sensitivity="internal"))
    bundle.add_worker_result(_worker(artifact_path="artifacts/t1.log"))
    assert _findings(bundle)["artifact_integrity"].passed is True


# --- plugin_policy_boundary rule ---


def test_plugin_policy_boundary_passes_for_proxy_only_invocation_evidence() -> None:
    bundle = _base()
    bundle.add_probe(
        "plugin_invocation",
        200,
        {
            "plugin_id": "dev.superclaw.hello-world",
            "plugin_version": "0.1.0",
            "tool_name": "hello",
            "status": "ok",
            "policy_decision": "allowed",
            "input_digest": "sha256:" + "a" * 64,
            "output_digest": "sha256:" + "b" * 64,
            "evidence_artifact_id": "plugininv_safe",
        },
    )
    bundle.add_artifact(
        ArtifactRef(
            kind="plugin-invocation",
            path=".superclaw/artifacts/plugins/plugininv_safe.json",
            sensitivity="internal",
            metadata={"plugin_id": "dev.superclaw.hello-world", "tool_name": "hello", "status": "ok"},
        )
    )

    assert _findings(bundle)["plugin_policy_boundary"].passed is True


@pytest.mark.parametrize(
    "surface",
    [
        "codex --plugin-dir .superclaw/plugins/cache/dev.superclaw.hello-world/0.1.0",
        '{"mcp_servers":{"x":{"plugin_dirs":[".superclaw/plugins/cache/dev.superclaw.hello-world"]}}}',
        "entitlement_token=local-license-token",
    ],
)
def test_plugin_policy_boundary_detects_policy_bypass_surfaces(surface: str) -> None:
    bundle = _base()
    bundle.add_command("agent backend", 0, surface)

    finding = _findings(bundle)["plugin_policy_boundary"]

    assert finding.passed is False
    assert "protected plugin policy material" in finding.detail


def test_plugin_policy_boundary_detects_revoked_plugin_recorded_as_success() -> None:
    bundle = _base()
    bundle.add_probe(
        "plugin_invocation",
        200,
        {
            "plugin_id": "dev.superclaw.revoked",
            "plugin_version": "0.1.0",
            "tool_name": "run",
            "status": "ok",
            "policy_decision": "PLUGIN_REVOKED: local revocation matched",
        },
    )

    finding = _findings(bundle)["plugin_policy_boundary"]

    assert finding.passed is False
    assert "revoked plugin recorded as successful" in finding.detail


def test_plugin_policy_boundary_allows_revoked_denial_evidence() -> None:
    bundle = _base()
    bundle.add_probe(
        "plugin_invocation",
        400,
        {
            "plugin_id": "dev.superclaw.revoked",
            "plugin_version": "0.1.0",
            "tool_name": "run",
            "status": "denied",
            "policy_decision": "PLUGIN_REVOKED",
        },
    )

    assert _findings(bundle)["plugin_policy_boundary"].passed is True


def test_plugin_policy_boundary_detects_secret_bearing_plugin_output() -> None:
    bundle = _base()
    bundle.add_probe(
        "plugin_invocation",
        200,
        {
            "plugin_id": "dev.superclaw.secret",
            "plugin_version": "0.1.0",
            "tool_name": "dump",
            "status": "ok",
            "policy_decision": "allowed",
            "output_payload": {"token": "sk-proj-" + "a" * 48},
        },
    )

    finding = _findings(bundle)["plugin_policy_boundary"]

    assert finding.passed is False
    assert "secret-bearing plugin output" in finding.detail
