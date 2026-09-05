"""Canonical secret-scanning patterns shared by redaction and adversarial detection.

This module is the single source of truth so that what we *scrub before
persistence* (``redact_secrets``) and what we *detect as a leak* (the adversarial
``secret_redaction`` rule) can never drift apart. Keep it dependency-free (stdlib
only) to avoid import cycles with ``runtime`` and ``adversarial``.
"""
from __future__ import annotations

import re

# Ordered, broad-but-targeted coverage of common real-world secret formats.
SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    # ClawHunt agent keys.
    re.compile(r"\bcph_[A-Za-z0-9_-]{8,}\b"),
    # GitHub classic tokens (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained PATs.
    re.compile(r"\bgh[opusr]_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}"),
    # OpenAI / Anthropic style keys (sk-..., sk-ant-..., sk-proj-...).
    re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9]{2,}-?[A-Za-z0-9_-]{16,}"),
    # AWS access key ids (long-term + temporary).
    re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b"),
    # AWS secret-key assignments.
    re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+]{40}"),
    # Google API keys.
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    # Slack tokens.
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    # JSON Web Tokens (three base64url segments).
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    # Bearer authorization headers.
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{16,}\b", re.IGNORECASE),
    # PEM private key blocks.
    re.compile(r"BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |)PRIVATE KEY"),
    # Token-style assignments: any key name ending in "token" (token,
    # session_token, csrf_token, ...) with a credential-like value. The value
    # must contain a digit and be >=8 chars, so plain status text — short or long,
    # quoted or not (token: "enabled", token: "temporarily-disabled") — is never
    # redacted. Real tokens are base62/hex and effectively always contain digits;
    # the well-known named forms (access_token/auth_token/refresh_token) are also
    # covered digit-free by the generic credential pattern below as a safety net.
    re.compile(r"(?i)\b[\w-]*token\b\s*[=:]\s*['\"]?(?=[^\s'\"]*\d)[^\s'\"]{8,}['\"]?"),
    # Generic credential assignments (key = value / key: value).
    re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|"
        r"client[_-]?secret|refresh[_-]?token|private[_-]?key)\b\s*[=:]\s*['\"]?[^\s'\"]{8,}"
    ),
)

REDACTION_PLACEHOLDER = "[REDACTED]"


def redact_secrets(value: str) -> str:
    """Replace every secret-like span with a fixed placeholder."""
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(REDACTION_PLACEHOLDER, redacted)
    return redacted


def iter_secret_matches(text: str) -> list[str]:
    """Return the pattern sources that match ``text`` (used for finding detail)."""
    return [pattern.pattern for pattern in SECRET_PATTERNS if pattern.search(text)]


def contains_secret(text: str) -> bool:
    """True if any secret pattern matches ``text``."""
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)
