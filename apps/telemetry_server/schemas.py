"""Wire schemas for the ingest API (mirrors §8.2 of the upload architecture).

One envelope per batch. ``rows`` is a list of row dicts:

* Tier A/B — redacted plaintext fields (the server stores known columns,
  ignores unknown keys rather than 500ing on schema drift, but the *envelope*
  shape itself is validated).
* Tier C — each row is an encryption envelope with base64 ``ciphertext_b64`` /
  ``nonce_b64`` / ``wrapped_cek_b64``; the server decodes to bytes and stores
  the ciphertext only (zero-knowledge).
"""
from __future__ import annotations

import base64
import binascii
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# Server-side scalar guard for Tier C cleartext correlation columns. The collector
# must NOT trust the client's own scrubbing: any uploader holding the ingest token
# could send a raw path / free-text here. Mirrors the client's _scrub_scalar intent
# (path/whitespace ⇒ redacted), implemented locally so the collector keeps zero
# superclaw deps. A correlation id is an enum/uuid-shaped token; anything else is not.
_PATHISH_RE = re.compile(
    r"(^[~/]|~[\\/]|\.\.[\\/]|://|[A-Za-z]:[\\/]|\\|"
    r"/(?:Users|home|var|tmp|etc|root|private|mnt|opt|srv|data|usr|dev|sys|Volumes|Library)/)",
    re.IGNORECASE,
)
# Common secret/token signatures (api keys, PATs, AWS/GCP keys, JWTs, PEM blocks).
# A correlation id is an enum/uuid-shaped token and never matches these; a leaked
# credential smuggled into a cleartext column does. Mirrors the intent of the
# client's redact_secrets without pulling in the superclaw dependency.
_SECRETISH_RE = re.compile(
    r"(sk-|pk-|rk_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|"
    r"-----BEGIN|eyJ[A-Za-z0-9_-]{8,}\.)",
)


def _safe_correlation(value: Any) -> Any:
    """Server-side redaction of a Tier C correlation column. Numbers/None pass;
    a string with whitespace, a path signature, or a secret/token signature ⇒
    ``<redacted>``; else a capped token. Never raises."""
    if value is None or (isinstance(value, (int, float)) and not isinstance(value, bool)):
        return value
    if not isinstance(value, str):
        return None
    if any(ch.isspace() for ch in value) or _PATHISH_RE.search(value) or _SECRETISH_RE.search(value):
        return "<redacted>"
    return value[:128]


def _coerce_epoch(value: Any) -> float | None:
    """A ttl must be numeric; coerce anything else to None so it can't ride a
    cleartext column as free text / a path."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


class IngestEnvelope(BaseModel):
    schema_version: int = 1
    upload_id: str = Field(min_length=1, max_length=256)
    device_id: str = Field(min_length=1, max_length=256)
    tier: Literal["A", "B", "C"]
    agreement_version: str | None = Field(default=None, max_length=64)
    rows: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("rows")
    @classmethod
    def _bounded_rows(cls, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # A single batch is capped; the spooler also enforces a byte cap. This is
        # a server-side backstop against an oversized/abusive payload.
        if len(rows) > 5000:
            raise ValueError("too many rows in one batch (max 5000)")
        return rows


class IngestAck(BaseModel):
    upload_id: str
    status: Literal["accepted", "duplicate", "rejected"]
    accepted_rows: int = 0
    reason: str | None = None


_TIER_C_ENVELOPE = (
    ("ciphertext_b64", "ciphertext"),
    ("nonce_b64", "nonce"),
    ("wrapped_cek_b64", "wrapped_cek"),
)

# A Tier C row may carry ONLY the encrypted envelope + these cleartext correlation/
# routing columns. Anything else (most importantly a ``plaintext_b64`` / raw field)
# is rejected at ingest — the zero-knowledge boundary is a server-enforced code gate,
# not a trust-the-client assumption.
_TIER_C_ALLOWED_FIELDS = frozenset(
    {b64 for b64, _ in _TIER_C_ENVELOPE}
    | {"key_id", "trace_id", "run_id", "payload_kind", "ttl_expires_at"}
)


def decode_tier_c_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn base64 envelope fields into bytes for storage. Fail-closed: a Tier C
    row MUST carry the full encryption envelope (ciphertext + nonce + wrapped
    CEK) and NOTHING outside the allowlist. A missing envelope field, or ANY
    disallowed field (e.g. a smuggled ``plaintext_b64``), is rejected — never
    stored, never silently accepted on the wire. That keeps the zero-knowledge
    contract enforced server-side rather than relying on the client to behave."""
    decoded: list[dict[str, Any]] = []
    for row in rows:
        disallowed = set(row) - _TIER_C_ALLOWED_FIELDS
        if disallowed:
            raise ValueError(
                f"tier C row carries disallowed field(s) {sorted(disallowed)}; only the "
                "encrypted envelope + correlation columns may be sent (zero-knowledge)"
            )
        out = dict(row)
        for b64_field, raw_field in _TIER_C_ENVELOPE:
            value = row.get(b64_field)
            if value is None:
                raise ValueError(f"tier C row missing required envelope field {b64_field}")
            try:
                out[raw_field] = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError(f"invalid base64 in {b64_field}") from exc
            out.pop(b64_field, None)
        # Server-side sanitation of the cleartext correlation columns — the collector
        # does NOT trust the uploader's own scrubbing. A path/free-text trace_id or a
        # non-numeric ttl is neutralized HERE, so a regressed or hostile client can't
        # land raw filesystem paths / secrets in the queryable cleartext columns.
        for col in ("trace_id", "run_id", "payload_kind"):
            if col in out:
                out[col] = _safe_correlation(out[col])
        if "ttl_expires_at" in out:
            out["ttl_expires_at"] = _coerce_epoch(out["ttl_expires_at"])
        decoded.append(out)
    return decoded
