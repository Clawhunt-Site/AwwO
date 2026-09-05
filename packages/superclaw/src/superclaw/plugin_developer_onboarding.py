from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping


V1_COMMERCE_STATES = frozenset({"free", "private_beta", "paid_manual"})
IDENTITY_TYPES = frozenset({"individual", "organization"})
PAYOUT_STATUSES = frozenset({"declared", "verified", "manual_review"})
SENSITIVE_FIELD_NAMES = frozenset(
    {
        "account_number",
        "api_key",
        "bank_account",
        "card_number",
        "client_secret",
        "password",
        "private_key",
        "routing_number",
        "secret",
        "ssn",
        "tax_id",
        "token",
    }
)
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$")


@dataclass(frozen=True)
class PluginDeveloperOnboardingFinding:
    code: str
    field: str
    message: str


@dataclass(frozen=True)
class PluginDeveloperOnboardingResult:
    ok: bool
    developer_id: str | None
    commerce_state: str | None
    findings: list[PluginDeveloperOnboardingFinding]
    sanitized_profile: dict[str, Any]


def validate_plugin_developer_onboarding(
    profile: Mapping[str, Any],
    *,
    repo_root: Path | None = None,
) -> PluginDeveloperOnboardingResult:
    """Validate the local Section 12 developer-onboarding contract."""
    findings: list[PluginDeveloperOnboardingFinding] = []
    _find_sensitive_fields(profile, "", findings)

    developer_id = _string_field(profile, "developer_id", findings, pattern=_SAFE_ID)
    display_name = _string_field(profile, "display_name", findings, max_length=120)
    commerce_state = _enum_field(profile, "commerce_state", V1_COMMERCE_STATES, findings)

    identity = profile.get("identity")
    if not isinstance(identity, Mapping):
        findings.append(_finding("missing_identity", "identity", "identity must be an object"))
    else:
        _enum_field(identity, "type", IDENTITY_TYPES, findings, prefix="identity")
        verification_status = _string_field(identity, "verification_status", findings, prefix="identity")
        if verification_status and verification_status != "verified":
            findings.append(
                _finding(
                    "identity_not_verified",
                    "identity.verification_status",
                    "developer identity must already be verified",
                )
            )
        _string_field(identity, "verification_ref", findings, prefix="identity")

    payout_profile = profile.get("payout_profile")
    if not isinstance(payout_profile, Mapping):
        findings.append(_finding("missing_payout_profile", "payout_profile", "payout_profile must be an object"))
    else:
        _enum_field(payout_profile, "status", PAYOUT_STATUSES, findings, prefix="payout_profile")
        _string_field(payout_profile, "payout_profile_ref", findings, prefix="payout_profile")

    support_contact = _contact_field(profile, "support_contact", findings)
    vulnerability_contact = _contact_field(profile, "vulnerability_disclosure_contact", findings)
    license_declaration = _string_field(profile, "license", findings, max_length=120)
    _policy_acceptance(profile.get("policy_acceptance"), findings)
    sample_evidence_fixture = _sample_evidence_fixture(
        profile.get("sample_evidence_fixture"),
        findings,
        repo_root=repo_root,
    )

    sanitized_profile = {
        "developer_id": developer_id,
        "display_name": display_name,
        "commerce_state": commerce_state,
        "identity": _sanitized_identity(identity),
        "payout_profile": _sanitized_payout_profile(payout_profile),
        "support_contact_present": support_contact is not None,
        "vulnerability_disclosure_contact_present": vulnerability_contact is not None,
        "license": license_declaration,
        "policy_acceptance": _sanitized_policy_acceptance(profile.get("policy_acceptance")),
        "sample_evidence_fixture": sample_evidence_fixture,
    }
    return PluginDeveloperOnboardingResult(
        ok=not findings,
        developer_id=developer_id,
        commerce_state=commerce_state,
        findings=findings,
        sanitized_profile=sanitized_profile,
    )


def plugin_developer_onboarding_payload(result: PluginDeveloperOnboardingResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "developer_id": result.developer_id,
        "commerce_state": result.commerce_state,
        "findings": [
            {"code": finding.code, "field": finding.field, "message": finding.message}
            for finding in result.findings
        ],
        "profile": result.sanitized_profile,
    }


def _string_field(
    profile: Mapping[str, Any],
    field: str,
    findings: list[PluginDeveloperOnboardingFinding],
    *,
    prefix: str | None = None,
    max_length: int = 256,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    value = profile.get(field)
    field_name = f"{prefix}.{field}" if prefix else field
    if not isinstance(value, str) or not value.strip():
        findings.append(_finding("missing_string", field_name, f"{field_name} must be a non-empty string"))
        return None
    value = value.strip()
    if len(value) > max_length:
        findings.append(_finding("string_too_long", field_name, f"{field_name} is too long"))
        return None
    if pattern and not pattern.fullmatch(value):
        findings.append(_finding("invalid_identifier", field_name, f"{field_name} has an invalid identifier format"))
        return None
    return value


def _enum_field(
    profile: Mapping[str, Any],
    field: str,
    allowed: frozenset[str],
    findings: list[PluginDeveloperOnboardingFinding],
    *,
    prefix: str | None = None,
) -> str | None:
    value = _string_field(profile, field, findings, prefix=prefix)
    field_name = f"{prefix}.{field}" if prefix else field
    if value and value not in allowed:
        findings.append(_finding("unsupported_value", field_name, f"{field_name} is not supported by the local contract"))
        return None
    return value


def _contact_field(
    profile: Mapping[str, Any],
    field: str,
    findings: list[PluginDeveloperOnboardingFinding],
) -> str | None:
    value = profile.get(field)
    if not _valid_contact(value):
        findings.append(_finding("invalid_contact", field, f"{field} must be an email address or https URL"))
        return None
    return value.strip()


def _valid_contact(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    if not value:
        return False
    if value.startswith("https://") and " " not in value:
        return True
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value))


def _policy_acceptance(value: Any, findings: list[PluginDeveloperOnboardingFinding]) -> None:
    if not isinstance(value, Mapping):
        findings.append(_finding("missing_policy_acceptance", "policy_acceptance", "policy_acceptance must be an object"))
        return
    if value.get("accepted") is not True:
        findings.append(_finding("policy_not_accepted", "policy_acceptance.accepted", "plugin policy must be accepted"))
    _string_field(value, "version", findings, prefix="policy_acceptance")
    accepted_at = _string_field(value, "accepted_at", findings, prefix="policy_acceptance")
    if accepted_at:
        try:
            datetime.fromisoformat(accepted_at.replace("Z", "+00:00"))
        except ValueError:
            findings.append(
                _finding(
                    "invalid_timestamp",
                    "policy_acceptance.accepted_at",
                    "policy acceptance timestamp must be ISO-8601",
                )
            )


def _sample_evidence_fixture(
    value: Any,
    findings: list[PluginDeveloperOnboardingFinding],
    *,
    repo_root: Path | None,
) -> str | None:
    if not isinstance(value, str) or not value.strip():
        findings.append(_finding("missing_sample_evidence_fixture", "sample_evidence_fixture", "sample evidence is required"))
        return None
    rel = Path(value)
    if rel.is_absolute() or ".." in rel.parts:
        findings.append(
            _finding(
                "unsafe_sample_evidence_fixture",
                "sample_evidence_fixture",
                "sample evidence fixture must be a repo-relative path",
            )
        )
        return None
    if repo_root is not None and not (repo_root / rel).is_file():
        findings.append(
            _finding(
                "missing_sample_evidence_fixture",
                "sample_evidence_fixture",
                "sample evidence fixture must exist in the repository",
            )
        )
    return value.strip()


def _find_sensitive_fields(
    value: Any,
    field_path: str,
    findings: list[PluginDeveloperOnboardingFinding],
) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_text = str(key)
            child_path = f"{field_path}.{key_text}" if field_path else key_text
            if key_text.lower() in SENSITIVE_FIELD_NAMES:
                findings.append(
                    _finding(
                        "raw_sensitive_field",
                        child_path,
                        "raw sensitive payment, identity, or secret fields are not allowed in onboarding payloads",
                    )
                )
            _find_sensitive_fields(child, child_path, findings)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _find_sensitive_fields(child, f"{field_path}[{index}]", findings)


def _sanitized_identity(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    return {
        "type": value.get("type") if isinstance(value.get("type"), str) else None,
        "verification_status": value.get("verification_status")
        if isinstance(value.get("verification_status"), str)
        else None,
        "verification_ref_present": isinstance(value.get("verification_ref"), str) and bool(value.get("verification_ref")),
    }


def _sanitized_payout_profile(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    return {
        "status": value.get("status") if isinstance(value.get("status"), str) else None,
        "payout_profile_ref_present": isinstance(value.get("payout_profile_ref"), str)
        and bool(value.get("payout_profile_ref")),
    }


def _sanitized_policy_acceptance(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    return {
        "accepted": value.get("accepted") is True,
        "version": value.get("version") if isinstance(value.get("version"), str) else None,
        "accepted_at": value.get("accepted_at") if isinstance(value.get("accepted_at"), str) else None,
    }


def _finding(code: str, field: str, message: str) -> PluginDeveloperOnboardingFinding:
    return PluginDeveloperOnboardingFinding(code=code, field=field, message=message)
