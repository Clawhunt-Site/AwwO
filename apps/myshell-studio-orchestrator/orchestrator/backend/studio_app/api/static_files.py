from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from studio_app.infrastructure.paths import backend_dir
from studio_app.infrastructure.storage.media import generated_media_root


def _backend_base() -> str:
    return str(backend_dir())


def _first_existing_path(*paths: str) -> str:
    for path in paths:
        if os.path.exists(path):
            return path
    return paths[0]


def frontend_dist_path() -> str:
    base = _backend_base()
    return _first_existing_path(
        os.path.join(base, "..", "..", "frontend", "dist"),
        os.path.join(base, "..", "frontend", "dist"),
        os.path.join(base, "frontend", "dist"),
    )


def frontend_public_path() -> str:
    base = _backend_base()
    return _first_existing_path(
        os.path.join(base, "..", "..", "frontend", "public"),
        os.path.join(base, "..", "frontend", "public"),
        os.path.join(base, "frontend", "public"),
    )


def mount_static_files(app: FastAPI) -> None:
    frontend_dist = frontend_dist_path()
    frontend_public = frontend_public_path()

    if os.path.exists(frontend_dist):
        assets_dir = os.path.join(frontend_dist, "assets")
        if os.path.exists(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    generated_dir = str(generated_media_root())
    app.mount("/generated", StaticFiles(directory=generated_dir), name="generated")

    canvaspro_dir = _first_existing_path(
        os.path.join(frontend_public, "ai-canvaspro"),
        os.path.join(frontend_dist, "ai-canvaspro"),
    )
    if os.path.exists(canvaspro_dir):
        app.mount("/ai-canvaspro", StaticFiles(directory=canvaspro_dir, html=True), name="ai-canvaspro")

    gallery_dir = os.path.join(frontend_public, "gallery")
    if not os.path.exists(gallery_dir):
        gallery_dir = os.path.join(frontend_dist, "gallery")
    if os.path.exists(gallery_dir):
        app.mount("/gallery", StaticFiles(directory=gallery_dir), name="gallery")


def register_spa_fallback(app: FastAPI) -> None:
    frontend_dist = frontend_dist_path()

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        if os.path.exists(frontend_dist):
            index_path = os.path.join(frontend_dist, "index.html")
            if os.path.exists(index_path):
                with open(index_path, encoding="utf-8") as index_file:
                    return HTMLResponse(index_file.read())
        return HTMLResponse("<h1>Frontend not built</h1>")
