from __future__ import annotations

from pathlib import Path


def backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / "frontend").exists() and (parent / "orchestrator").exists():
            return parent
    return None
