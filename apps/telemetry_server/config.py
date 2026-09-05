"""Environment-driven configuration for the telemetry collection server.

The whole point of this module is the *seamless local→prod switch*: the same
server code runs against a local SQLite file or a production PostgreSQL purely
by changing ``TELEMETRY_DATABASE_URL``. Nothing else in the server hardcodes a
database, host, port, or token.

Env vars (all optional locally; production MUST set the token):

* ``TELEMETRY_DATABASE_URL``   — ``sqlite:///./telemetry.db`` (default) or
  ``postgresql://user:pass@host:5432/telemetry``.
* ``TELEMETRY_INGEST_TOKEN``   — bearer token clients must present. Empty in
  local dev means "accept any client" (logged loudly); in production it MUST be
  set or ingest fails closed.
* ``TELEMETRY_HOST`` / ``TELEMETRY_PORT`` — bind address (default 127.0.0.1:8900).
* ``TELEMETRY_TIER_C_RETENTION_DAYS`` — how long Tier C (encrypted raw) rows
  live before the retention pass deletes them (default 7).
* ``TELEMETRY_ENV`` — ``local`` (default) or ``production``. In production an
  empty ingest token is a hard error (fail-closed).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_DATABASE_URL = "sqlite:///./telemetry.db"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8900
DEFAULT_TIER_C_RETENTION_DAYS = 7


class ConfigError(RuntimeError):
    """Server configuration is invalid / unsafe (fail-closed)."""


@dataclass(frozen=True)
class ServerConfig:
    database_url: str
    ingest_token: str
    query_token: str
    host: str
    port: int
    tier_c_retention_days: int
    env: str
    retention_interval_seconds: float
    # Tier C envelope-encryption PUBLIC key (PEM) this collector advertises via
    # /v1/telemetry/keys, plus its key_id (the client-side fingerprint). The PRIVATE
    # key is NEVER configured here — the collector is zero-knowledge and only stores
    # ciphertext; unsealing is a separate offline operator action. Empty ⇒ /keys
    # advertises "not configured" and clients send nothing for Tier C.
    tier_c_public_key: str = ""
    tier_c_key_id: str = ""

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def auth_required(self) -> bool:
        return bool(self.ingest_token)

    @property
    def query_auth_required(self) -> bool:
        return bool(self.query_token)

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "ServerConfig":
        env_map = os.environ if environ is None else environ
        database_url = env_map.get("TELEMETRY_DATABASE_URL", DEFAULT_DATABASE_URL).strip()
        if not database_url:
            raise ConfigError("TELEMETRY_DATABASE_URL must not be empty")

        token = env_map.get("TELEMETRY_INGEST_TOKEN", "").strip()
        query_token = env_map.get("TELEMETRY_QUERY_TOKEN", "").strip()
        env = env_map.get("TELEMETRY_ENV", "local").strip().lower() or "local"
        if env == "production" and not token:
            # Production with no token would accept telemetry from anyone — refuse.
            raise ConfigError(
                "TELEMETRY_INGEST_TOKEN is required when TELEMETRY_ENV=production"
            )
        if env == "production" and not query_token:
            # Without a SEPARATE operator token, any uploading client (which holds
            # the ingest token) could read/delete the whole dataset. Require it.
            raise ConfigError(
                "TELEMETRY_QUERY_TOKEN is required when TELEMETRY_ENV=production "
                "(must differ from TELEMETRY_INGEST_TOKEN)"
            )
        if query_token and query_token == token:
            raise ConfigError(
                "TELEMETRY_QUERY_TOKEN must differ from TELEMETRY_INGEST_TOKEN "
                "(operator read/admin must not be grantable to uploading clients)"
            )

        host = env_map.get("TELEMETRY_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
        port = _int_env(env_map, "TELEMETRY_PORT", DEFAULT_PORT)
        retention = _int_env(
            env_map, "TELEMETRY_TIER_C_RETENTION_DAYS", DEFAULT_TIER_C_RETENTION_DAYS
        )
        if retention < 0:
            raise ConfigError("TELEMETRY_TIER_C_RETENTION_DAYS must be >= 0")
        retention_interval = float(
            _int_env(env_map, "TELEMETRY_RETENTION_INTERVAL_SECONDS", 3600)
        )

        tier_c_public_key = env_map.get("TELEMETRY_TIER_C_PUBLIC_KEY", "").strip()
        # Fail closed at startup on a Tier C key that is NOT a usable RSA public key:
        # private-key material (which /keys would leak), a non-RSA key, a weak key, or
        # junk. /keys must only ever advertise a valid public key, so refuse to boot
        # rather than publish a broken/dangerous key contract.
        problem = tier_c_public_key_problem(tier_c_public_key)
        if problem:
            raise ConfigError(f"TELEMETRY_TIER_C_PUBLIC_KEY {problem}; refusing to start")

        return cls(
            database_url=database_url,
            ingest_token=token,
            query_token=query_token,
            host=host,
            port=port,
            tier_c_retention_days=retention,
            env=env,
            retention_interval_seconds=retention_interval,
            tier_c_public_key=tier_c_public_key,
            # key_id is DERIVED from the (already-validated) public key, never taken
            # from the environment — the fingerprint is the single source of truth.
            tier_c_key_id=derive_tier_c_key_id(tier_c_public_key) if tier_c_public_key else "",
        )


def tier_c_public_key_problem(pem: str) -> str | None:
    """Return a human reason if ``pem`` is NOT a usable Tier C public key, else None.
    Empty is fine (Tier C optional). Rejects private-key material, non-RSA keys, weak
    keys (<3072), and junk. Mirrors the client's ``is_public_key_pem`` so both ends of
    the contract reject the same keys; the collector enforces it independently rather
    than trusting whoever configured it."""
    if not pem:
        return None
    if "PRIVATE KEY" in pem.upper():
        return "contains PRIVATE key material"
    try:
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
    except ImportError:  # pragma: no cover - cryptography is a pinned server dep
        # FAIL CLOSED: a non-empty key we cannot validate must NOT be accepted or
        # published. Falling through to None would regress to "only the PRIVATE-KEY
        # string guard runs", letting junk/non-RSA/weak keys through if the dep is
        # missing. Refuse instead.
        return "cannot be validated (the cryptography package is not installed)"
    try:
        key = load_pem_public_key(pem.encode("utf-8"))
    except (ValueError, TypeError):
        return "is not a valid public key"
    if not isinstance(key, rsa.RSAPublicKey):
        return "is not an RSA public key"
    if key.key_size < 3072:
        return f"is too weak ({key.key_size} bits; need >= 3072)"
    return None


def derive_tier_c_key_id(pem: str) -> str:
    """The key_id IS the public-key fingerprint (SHA-256 of DER SubjectPublicKeyInfo,
    first 32 hex), derived server-side from the validated public key. /keys advertises
    THIS, never a caller-supplied key_id, so a forged/mismatched key_id can't pollute
    the fingerprint/rotation contract. Assumes ``pem`` already passed
    ``tier_c_public_key_problem``."""
    import hashlib

    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
        load_pem_public_key,
    )

    key = load_pem_public_key(pem.encode("utf-8"))
    der = key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:32]


def _int_env(env_map: dict[str, str], name: str, default: int) -> int:
    raw = env_map.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
