"""FastAPI collection server: ingest + query + monitoring web UI.

Run locally (zero infra, SQLite):
    TELEMETRY_DATABASE_URL=sqlite:///./telemetry.db \
    uvicorn --factory apps.telemetry_server.main:create_app --port 8900

Switch to production with NO code change — just env vars:
    TELEMETRY_ENV=production \
    TELEMETRY_DATABASE_URL=postgresql://user:pass@db:5432/telemetry \
    TELEMETRY_INGEST_TOKEN=<shared-secret> \
    uvicorn --factory apps.telemetry_server.main:create_app --host 0.0.0.0 --port 8900

``--factory`` keeps app/DB construction out of import time (no side effects on
import); the server is built when uvicorn calls ``create_app()`` at startup.
"""
from __future__ import annotations

import hmac
import logging
import threading
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from .config import ServerConfig
from .db import Database, DatabaseError
from .schemas import IngestAck, IngestEnvelope, decode_tier_c_rows

logger = logging.getLogger("telemetry_server")

_WEBUI_DIR = Path(__file__).resolve().parent / "webui"


def create_app(config: ServerConfig | None = None, db: Database | None = None) -> FastAPI:
    cfg = config or ServerConfig.from_env()
    database = db if db is not None else Database(cfg.database_url)
    # Idempotent (CREATE TABLE IF NOT EXISTS) — safe whether the caller passed a
    # bare Database or none; guarantees tables exist before the first request.
    database.init_schema()

    app = FastAPI(title="SuperClaw Telemetry Collector", version="1")
    app.state.config = cfg
    app.state.db = database

    if not cfg.auth_required:
        logger.warning(
            "telemetry ingest token is EMPTY — accepting any client. "
            "Set TELEMETRY_INGEST_TOKEN (required when TELEMETRY_ENV=production)."
        )

    stop_event = threading.Event()

    @app.on_event("startup")
    def _startup() -> None:
        deleted = _safe_retention(database, cfg)
        logger.info(
            "telemetry collector ready (db=%s, env=%s, tier_c_retention_days=%d, "
            "expired_tier_c_purged=%d)",
            _scheme(cfg.database_url), cfg.env, cfg.tier_c_retention_days, deleted,
        )
        # Periodic Tier C retention — a long-running server may never restart, so
        # startup-only purging would let expired ciphertext pile up forever.
        if cfg.tier_c_retention_days > 0 and cfg.retention_interval_seconds > 0:
            thread = threading.Thread(
                target=_retention_loop,
                args=(database, cfg, stop_event),
                name="tier-c-retention",
                daemon=True,
            )
            thread.start()
            app.state.retention_thread = thread

    @app.on_event("shutdown")
    def _shutdown() -> None:
        stop_event.set()

    def _bearer(request: Request) -> str:
        header = request.headers.get("authorization", "")
        prefix = "bearer "
        return header[len(prefix):].strip() if header.lower().startswith(prefix) else ""

    def require_auth(request: Request) -> None:
        """Auth for uploading clients (ingest token)."""
        if not cfg.auth_required:
            return
        if not hmac.compare_digest(_bearer(request), cfg.ingest_token):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    def require_query_auth(request: Request) -> None:
        """Auth for operator read/admin endpoints. Uses a SEPARATE token from
        ingest so an uploading client (which holds the ingest token) can never
        read or delete the dataset. Open only when no query token is set (local)."""
        if not cfg.query_auth_required:
            return
        if not hmac.compare_digest(_bearer(request), cfg.query_token):
            raise HTTPException(status_code=401, detail="invalid or missing operator token")

    @app.get("/v1/telemetry/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "telemetry-collector", "env": cfg.env}

    @app.get("/v1/telemetry/keys")
    def keys() -> dict[str, Any]:
        # Tier C public-key distribution point. The PRIVATE key is NEVER here — this
        # collector is zero-knowledge. When no public key is configured, advertise
        # "not configured" so clients keep Tier C inert (fail-closed: no key ⇒ no
        # sealed payloads) rather than guessing.
        # Defence in depth: even if a ServerConfig was hand-built (bypassing
        # from_env's startup guard), only ever publish a VALID public key — never
        # private material, a non-RSA/weak key, or junk — and derive the key_id from
        # that key rather than trusting a caller-supplied one.
        from .config import derive_tier_c_key_id, tier_c_public_key_problem

        if not cfg.tier_c_public_key or tier_c_public_key_problem(cfg.tier_c_public_key):
            return {"key_id": None, "public_key": None, "note": "Tier C key not configured"}
        return {
            "key_id": derive_tier_c_key_id(cfg.tier_c_public_key),
            "public_key": cfg.tier_c_public_key,
        }

    @app.post("/v1/telemetry/ingest", response_model=IngestAck)
    def ingest(envelope: IngestEnvelope, _: None = Depends(require_auth)) -> IngestAck:
        rows = envelope.rows
        try:
            if envelope.tier == "C":
                rows = decode_tier_c_rows(rows)
            status, accepted = database.record_batch(
                upload_id=envelope.upload_id,
                device_id=envelope.device_id,
                tier=envelope.tier,
                agreement_version=envelope.agreement_version,
                rows=rows,
            )
        except ValueError as exc:  # bad base64 / schema → reject (client bug)
            return IngestAck(
                upload_id=envelope.upload_id, status="rejected", reason=str(exc)
            )
        except DatabaseError as exc:
            logger.error("ingest persistence failure: %s", exc)
            raise HTTPException(status_code=503, detail="storage unavailable") from exc
        return IngestAck(
            upload_id=envelope.upload_id, status=status, accepted_rows=accepted
        )

    @app.get("/api/stats")
    def api_stats(_: None = Depends(require_query_auth)) -> dict[str, Any]:
        return database.stats()

    @app.get("/api/query")
    def api_query(
        tier: str = Query("A"),
        trace_id: str | None = Query(None),
        device_id: str | None = Query(None),
        limit: int = Query(100, ge=1, le=1000),
        _: None = Depends(require_query_auth),
    ) -> dict[str, Any]:
        try:
            rows = database.query_tier(
                tier.upper(), trace_id=trace_id, device_id=device_id, limit=limit
            )
        except DatabaseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"tier": tier.upper(), "count": len(rows), "rows": rows}

    @app.get("/api/tier-c/sealed")
    def api_tier_c_sealed(
        trace_id: str | None = Query(None),
        device_id: str | None = Query(None),
        limit: int = Query(100, ge=1, le=1000),
        _: None = Depends(require_query_auth),
    ) -> dict[str, Any]:
        """Privileged: hand over Tier C ciphertext envelopes for OFFLINE operator
        decryption (the day-to-day /api/query hides ciphertext). Guarded by the
        operator query token; the server still cannot read the payloads — only the
        operator's private key can unseal them."""
        rows = database.fetch_tier_c_sealed(
            trace_id=trace_id, device_id=device_id, limit=limit
        )
        # Audit the privileged export server-side so EVERY ciphertext hand-out is
        # traced — whether it came through the operator CLI or a raw client. Records
        # the scope + count only; never plaintext (the server can't read it anyway).
        logger.info(
            "tier_c_sealed export: trace_id=%s device_id=%s rows=%d",
            trace_id or "*", device_id or "*", len(rows),
        )
        return {"count": len(rows), "rows": rows}

    @app.post("/api/retention")
    def api_retention(_: None = Depends(require_query_auth)) -> dict[str, Any]:
        deleted = _safe_retention(database, cfg)
        return {"deleted_tier_c": deleted}

    @app.get("/", response_class=HTMLResponse)
    def webui() -> HTMLResponse:
        index = _WEBUI_DIR / "index.html"
        if not index.exists():
            return HTMLResponse("<h1>telemetry collector</h1><p>web ui missing</p>")
        return HTMLResponse(index.read_text(encoding="utf-8"))

    return app


def _safe_retention(database: Database, cfg: ServerConfig) -> int:
    try:
        return database.apply_retention(retention_days=cfg.tier_c_retention_days)
    except DatabaseError as exc:  # retention failure must never crash the server
        logger.error("tier C retention pass failed: %s", exc)
        return 0


def _retention_loop(database: Database, cfg: ServerConfig, stop: threading.Event) -> None:
    """Background loop: purge expired Tier C every retention_interval_seconds.
    Exits promptly when ``stop`` is set (server shutdown)."""
    while not stop.wait(cfg.retention_interval_seconds):
        deleted = _safe_retention(database, cfg)
        if deleted:
            logger.info("periodic retention purged %d expired Tier C rows", deleted)


def _scheme(url: str) -> str:
    return url.split("://", 1)[0] if "://" in url else url
