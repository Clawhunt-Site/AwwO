from __future__ import annotations

import os
from dataclasses import dataclass, field


DEFAULT_CORS_ALLOW_ORIGINS = ["http://127.0.0.1:5174", "http://localhost:5174"]


def _cors_allow_origins() -> list[str]:
    configured = os.environ.get("STUDIO_CORS_ALLOW_ORIGINS", "")
    if not configured.strip():
        return list(DEFAULT_CORS_ALLOW_ORIGINS)
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    if "*" in origins:
        raise ValueError("STUDIO_CORS_ALLOW_ORIGINS must list explicit origins")
    return origins


@dataclass(frozen=True)
class AppSettings:
    """Runtime settings owned by the FastAPI application shell."""

    title: str = "Art Chat Orchestrator"
    version: str = "0.1.0"
    cors_allow_origins: list[str] = field(default_factory=lambda: list(DEFAULT_CORS_ALLOW_ORIGINS))
    cors_allow_credentials: bool = True
    cors_allow_methods: list[str] = field(default_factory=lambda: ["*"])
    cors_allow_headers: list[str] = field(default_factory=lambda: ["*"])
    port: int = 8090


def get_settings() -> AppSettings:
    port = int(os.environ.get("PORT", 8090))
    return AppSettings(cors_allow_origins=_cors_allow_origins(), port=port)
