from __future__ import annotations

import os
from pathlib import Path

from studio_app.infrastructure.paths import backend_dir, repo_root


def generated_media_root() -> Path:
    configured = os.environ.get("STUDIO_GENERATED_DIR")
    root = repo_root()
    backend = backend_dir()
    candidates = [
        Path(configured) if configured else None,
        root / "frontend" / "dist" / "generated" if root else None,
        backend / "frontend" / "dist" / "generated",
        Path("/app/frontend/dist/generated"),
    ]
    for candidate in candidates:
        if candidate:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
    raise RuntimeError("No generated media directory configured")


def resolve_generated_media_path(url: str) -> Path | None:
    if not url.startswith("/generated/"):
        return None
    root = generated_media_root()
    relative = url.removeprefix("/generated/").lstrip("/")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate if candidate.exists() else None
