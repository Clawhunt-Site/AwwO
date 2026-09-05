"""The redaction scrubber and the adversarial detector must share one pattern set."""
import pytest

from superclaw import adversarial, runtime
from superclaw.secrets_scan import contains_secret, iter_secret_matches, redact_secrets


@pytest.mark.parametrize(
    "secret",
    [
        "cph_abcd1234efgh",
        "ghp_" + "a" * 20,
        "AKIAIOSFODNN7EXAMPLE",
        "sk-proj-" + "a" * 48,
        "sk-ant-api03-" + "A1b2" * 12,
        "AIza" + "b" * 35,
        "xoxb-123456789012-abcdefABCDEF1234",
        "eyJhbGciOiJIUzI1Ni3.eyJzdWIiOiIxMjM4OTk2.dQw4w9WgXcQ",
        "password=hunter2supersecret",
        "token=secret-value-12345678",
        "session_token=secret-value-12345678",
        'csrf_token: "AbCdEfGh12345678"',
    ],
)
def test_broad_secret_types_are_both_detected_and_redacted(secret: str) -> None:
    text = f"leaked value={secret} end"
    # Detection (adversarial secret_redaction relies on this).
    assert contains_secret(text) is True, secret
    assert iter_secret_matches(text), secret
    # Redaction (runtime scrubs before persistence using the same patterns).
    scrubbed = redact_secrets(text)
    assert secret not in scrubbed, secret
    assert "[REDACTED]" in scrubbed


def test_runtime_redact_is_the_shared_implementation() -> None:
    """runtime.redact_secrets is re-exported from the canonical module (no drift)."""
    assert runtime.redact_secrets is redact_secrets


def test_adversarial_uses_shared_matcher_not_a_local_copy() -> None:
    assert not hasattr(adversarial, "_SECRET_PATTERNS")
    assert adversarial.iter_secret_matches is iter_secret_matches


@pytest.mark.parametrize(
    "text",
    [
        "17 passed, 200 OK, file evidence.json at f6816480ab12cd34",
        # token-family keys with non-credential status values must not be flagged.
        "api token: disabled",
        "token: enabled",
        "refresh token: expired",
        'token: "enabled"',
        'session token: "disabled"',
        'token: "temporarily-disabled"',
        'session_token: "configurationpending"',
    ],
)
def test_clean_text_is_not_redacted_or_flagged(text: str) -> None:
    assert contains_secret(text) is False
    assert redact_secrets(text) == text
