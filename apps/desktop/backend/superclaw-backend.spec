# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec that freezes the ClawHunt Python backend (FastAPI service +
orchestrator + Typer CLI) into a self-contained onefile executable for the
macOS app.

Build from the repo root:
    .venv/bin/pyinstaller --noconfirm --clean \
        --distpath apps/desktop/backend/dist \
        --workpath apps/desktop/backend/build \
        apps/desktop/backend/superclaw-backend.spec
"""

import os

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

SPEC_DIR = os.path.abspath(SPECPATH)
REPO_ROOT = os.path.abspath(os.path.join(SPEC_DIR, "..", "..", ".."))
SRC = os.path.join(REPO_ROOT, "packages", "superclaw", "src")

hiddenimports = []
# Our own code is imported dynamically in places (CLI subcommands, FastAPI app,
# plugin/runtime modules), so pull every submodule in explicitly.
hiddenimports += collect_submodules("superclaw")
hiddenimports += collect_submodules("apps")
# uvicorn selects its protocol/loop/lifespan implementations at runtime via
# "auto" import strings PyInstaller cannot see statically.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "anyio._backends._asyncio",
]

datas = []
binaries = []
# Our own package ships data files that are NOT Python modules, so
# collect_submodules above does not pick them up — notably node_routes.json (the
# Node-owned route manifest the front door loads at startup) and
# capability_atlas.json. collect_data_files bundles them into the frozen tree so
# `superclaw.node_routes` / capability code can read them at runtime.
datas += collect_data_files("superclaw")
# Packages that ship data files / have non-trivial dynamic imports.
for pkg in (
    "anthropic",
    "jsonschema",
    "jsonschema_specifications",
    "certifi",
    "typer",
    "click",
    "pydantic",
    "fastapi",
    "starlette",
    "prompt_toolkit",
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:  # pragma: no cover - best effort per package
        pass

a = Analysis(
    [os.path.join(SPEC_DIR, "superclaw_service.py")],
    pathex=[SRC, REPO_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyInstaller", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="superclaw-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
