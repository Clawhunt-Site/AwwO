from collections import Counter

from superclaw.adversarial import ADVERSARIAL_RULE_SPECS, PROFILE_FINDING_NAMES, adversarial_rule_specs, apply_adversarial_profile, run_adversarial_profile
from superclaw.models import ArtifactRef, EvidenceBundle, VerificationFinding


def _findings_by_name(bundle: EvidenceBundle):
    return {finding.name: finding for finding in run_adversarial_profile(bundle)}


def test_adversarial_profile_requires_successful_commands_and_real_negative_probe():
    bundle = EvidenceBundle(run_id="run_bad")
    bundle.add_command("pytest", 1, "failed")
    bundle.add_probe("health", 200, {"ok": True})

    findings = _findings_by_name(bundle)

    assert findings["command_backed_verification"].passed is False
    assert "successful" in findings["command_backed_verification"].detail
    assert findings["non_happy_path_probe"].passed is False
    assert findings["evidence_consistency"].passed is False


def test_adversarial_profile_passes_for_consistent_gray_run_evidence():
    bundle = EvidenceBundle(run_id="run_good")
    bundle.add_command("python -m pytest -q", 0, "17 passed")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})
    bundle.add_artifact(ArtifactRef(kind="report", path="artifacts/evidence.json", sensitivity="public"))

    findings = _findings_by_name(bundle)

    assert findings["command_backed_verification"].passed is True
    assert findings["non_happy_path_probe"].passed is True
    assert findings["evidence_consistency"].passed is True
    assert findings["secret_redaction"].passed is True
    assert findings["backend_readiness_classification"].passed is True
    assert findings["submission_artifact_consistency"].passed is True
    assert findings["secret_redaction"].severity == "critical"
    assert findings["secret_redaction"].fail_mode == "fail_closed"
    assert findings["secret_redaction"].input_fields
    assert "Redact secret-like material" in findings["secret_redaction"].remediation


def test_adversarial_profile_detects_bearer_style_secret_leaks():
    bundle = EvidenceBundle(run_id="run_secret")
    bundle.add_command("probe", 0, "Authorization: " + "Bearer " + ("x" * 24))
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})

    findings = _findings_by_name(bundle)

    assert findings["secret_redaction"].passed is False
    assert "secret-like" in findings["secret_redaction"].detail


def test_adversarial_profile_detects_backend_auth_and_quota_blockers():
    bundle = EvidenceBundle(run_id="run_blocked")
    bundle.add_command("codex exec", 0, "Sign in with ChatGPT to generate an API key")
    bundle.add_command("claude --print", 1, "You're out of extra usage · resets 4:20pm (Asia/Shanghai)")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})
    bundle.add_artifact(ArtifactRef(kind="report", path="artifacts/evidence.json", sensitivity="public"))

    findings = _findings_by_name(bundle)

    assert findings["backend_readiness_classification"].passed is False
    assert "AUTH_REQUIRED" in findings["backend_readiness_classification"].detail
    assert "USAGE_QUOTA_EXHAUSTED" in findings["backend_readiness_classification"].detail


def test_adversarial_profile_requires_submission_response_and_worker_artifacts():
    bundle = EvidenceBundle(run_id="run_submit_bad")
    bundle.add_command("python -m pytest -q", 0, "17 passed")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})
    bundle.add_artifact(ArtifactRef(kind="browser", path="artifacts/run.png", sensitivity="public"))
    bundle.mark_submitted({"status_code": 200, "body": {"accepted": True}})

    findings = _findings_by_name(bundle)

    assert findings["submission_artifact_consistency"].passed is False
    assert "missing evidence-json artifact" in findings["submission_artifact_consistency"].detail


def test_apply_adversarial_profile_is_idempotent():
    bundle = EvidenceBundle(run_id="run_idempotent")
    bundle.add_command("python -m pytest -q", 0, "17 passed")
    bundle.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth"})
    bundle.add_artifact(ArtifactRef(kind="report", path="artifacts/evidence.json", sensitivity="public"))

    apply_adversarial_profile(bundle)
    apply_adversarial_profile(bundle)

    counts = Counter(finding.name for finding in bundle.findings)
    assert counts == {
        "command_backed_verification": 1,
        "non_happy_path_probe": 1,
        "evidence_consistency": 1,
        "secret_redaction": 1,
        "backend_readiness_classification": 1,
        "submission_artifact_consistency": 1,
        "artifact_integrity": 1,
        "plugin_policy_boundary": 1,
    }


def test_adversarial_rule_specs_are_machine_readable_and_complete():
    specs = adversarial_rule_specs()

    assert set(specs) == PROFILE_FINDING_NAMES == set(ADVERSARIAL_RULE_SPECS)
    for spec in specs.values():
        assert spec.input_fields
        assert spec.fail_mode in {"fail_open", "fail_closed"}
        assert spec.severity in {"info", "warning", "high", "critical"}
        assert spec.remediation


def test_adversarial_findings_round_trip_rule_contract_fields():
    finding = VerificationFinding(
        name="secret_redaction",
        passed=False,
        detail="1 secret-like pattern found",
        severity="critical",
        input_fields=["commands", "worker_results"],
        fail_mode="fail_closed",
        remediation="Redact output before persistence.",
    )
    bundle = EvidenceBundle(run_id="run_contract")
    bundle.findings.append(finding)

    restored = EvidenceBundle.from_dict(bundle.to_dict())

    assert restored.findings[0].input_fields == ["commands", "worker_results"]
    assert restored.findings[0].fail_mode == "fail_closed"
    assert restored.findings[0].remediation == "Redact output before persistence."
