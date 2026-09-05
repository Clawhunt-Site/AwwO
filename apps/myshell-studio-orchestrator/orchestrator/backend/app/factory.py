from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.settings import AppSettings, get_settings
from studio_app.composition.studio import register_studio_routes
from studio_app.api.routers.canvaspro import router as canvaspro_router
from studio_app.api.routers.legacy import router as legacy_router
from studio_app.api.static_files import mount_static_files, register_spa_fallback


def create_app(settings: AppSettings | None = None) -> FastAPI:
    """Build the FastAPI app from bounded routers and infrastructure mounts."""

    resolved = settings or get_settings()
    app = FastAPI(title=resolved.title, version=resolved.version)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_allow_origins,
        allow_credentials=resolved.cors_allow_credentials,
        allow_methods=resolved.cors_allow_methods,
        allow_headers=resolved.cors_allow_headers,
    )

    app.include_router(legacy_router)
    register_studio_routes(app)
    app.include_router(canvaspro_router)
    mount_static_files(app)
    register_spa_fallback(app)
    return app
