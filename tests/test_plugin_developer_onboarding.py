from __future__ import annotations

from pathlib import Path

from superclaw.plugin_developer_onboarding import (
    plugin_developer_onboarding_payload,
    validate_plugin_developer_onboarding,
)


def _valid_profile(fixture_path: str = "fixtures/evidence/sample.json") -> dict[str, object]:
    return {
        "developer_id": "dev:acme.tools",
        "display_name": "Acme Tools",
        "commerce_state": "paid_manual",
        "identity": {
            "type": "organization",
            "verification_status": "verified",
            "verification_ref": "identity-review-123",
        },
        "payout_profile": {
            "status": "declared",
            "payout_profile_ref": "payout-profile-123",
        },
        "support_contact": "support@example.com",
        "license": "Apache-2.0",
        "vulnerability_disclosure_contact": "https://example.com/security",
        "policy_acceptance": {
            "accepted": True,
            "version": "2026-06-01",
            "accepted_at": "2026-06-01T00:00:00Z",
        },
        "sample_evidence_fixture": fixture_path,
    }


def test_developer_onboarding_accepts_verified_profile_with_existing_fixture(tmp_path: Path):
    fixture = tmp_path / "fixtures" / "evidence" / "sample.json"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"ok": true}\n', encoding="utf-8")

    result = validate_plugin_developer_onboarding(_valid_profile(), repo_root=tmp_path)
    payload = plugin_developer_onboarding_payload(result)

    assert result.ok is True
    assert payload["ok"] is True
    assert payload["developer_id"] == "dev:acme.tools"
    assert payload["commerce_state"] == "paid_manual"
    assert payload["profile"]["identity"]["verification_ref_present"] is True
    assert payload["profile"]["payout_profile"]["payout_profile_ref_present"] is True


def test_developer_onboarding_requires_verified_identity(tmp_path: Path):
    profile = _valid_profile()
    profile["identity"] = {
        "type": "individual",
        "verification_status": "pending",
        "verification_ref": "identity-review-123",
    }

    result = validate_plugin_developer_onboarding(profile, repo_root=tmp_path)

    assert result.ok is False
    assert _codes(result) == {"identity_not_verified", "missing_sample_evidence_fixture"}


def test_developer_onboarding_rejects_raw_sensitive_payment_fields_without_value_leakage(tmp_path: Path):
    profile = _valid_profile()
    profile["payout_profile"] = {
        "status": "declared",
        "payout_profile_ref": "payout-profile-123",
        "account_number": "1234567890",
        "routing_number": "021000021",
    }

    result = validate_plugin_developer_onboarding(profile, repo_root=tmp_path)
    payload = plugin_developer_onboarding_payload(result)

    assert result.ok is False
    assert "raw_sensitive_field" in _codes(result)
    assert "1234567890" not in str(payload)
    assert "021000021" not in str(payload)
    assert payload["profile"]["payout_profile"]["payout_profile_ref_present"] is True


def test_developer_onboarding_rejects_unsafe_evidence_paths_without_absolute_path_leakage(tmp_path: Path):
    unsafe_path = str(tmp_path / "sample.json")
    profile = _valid_profile(fixture_path=unsafe_path)

    result = validate_plugin_developer_onboarding(profile, repo_root=tmp_path)
    payload = plugin_developer_onboarding_payload(result)

    assert result.ok is False
    assert "unsafe_sample_evidence_fixture" in _codes(result)
    assert unsafe_path not in str(payload)


def test_developer_onboarding_rejects_missing_policy_contacts_license_and_future_commerce(tmp_path: Path):
    profile = _valid_profile()
    profile["commerce_state"] = "subscription"
    profile["support_contact"] = ""
    profile["license"] = ""
    profile["vulnerability_disclosure_contact"] = "http://example.com/security"
    profile["policy_acceptance"] = {
        "accepted": False,
        "version": "2026-06-01",
        "accepted_at": "not-a-date",
    }

    result = validate_plugin_developer_onboarding(profile, repo_root=tmp_path)

    assert result.ok is False
    assert {
        "unsupported_value",
        "invalid_contact",
        "missing_string",
        "policy_not_accepted",
        "invalid_timestamp",
        "missing_sample_evidence_fixture",
    } <= _codes(result)


def _codes(result) -> set[str]:
    return {finding.code for finding in result.findings}
