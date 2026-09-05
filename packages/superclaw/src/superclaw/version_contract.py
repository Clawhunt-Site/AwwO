"""Multi-dimensional version contract — the single source of truth (方向三 C1).

"One VERSION is not enough": desktop shell, bundled core, CLI core, API contract,
state schema, plugin contract and projection schema each evolve independently, and
a release manifest's ``min_supported_*`` is compared per-dimension. This module
derives every runtime version from the ``VERSION`` file (+ schema/state sources)
so no module hard-codes ``"0.1.0"`` again.

Kept dependency-light: ``state.StateStore.SCHEMA_VERSION`` is read via a lazy
import only when a contract is built, so importing this module does not pull in
the heavy state graph.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path

# Compatibility dimensions — each evolves independently; release manifests compare
# min_supported per dimension.
DESKTOP_SHELL_DIM = "desktop_shell"          # Tauri shell (Cargo/tauri.conf) — OS-package swap grain
BUNDLED_CORE_DIM = "bundled_core"            # PyInstaller backend frozen into the .app
CLI_CORE_DIM = "cli_core"                    # pip-installed superclaw package
API_CONTRACT_DIM = "api_contract"            # REST/SSE contract (bump only on a breaking change)
STATE_SCHEMA_DIM = "state_schema"            # state.db schema version (state.StateStore.SCHEMA_VERSION)
PLUGIN_CONTRACT_DIM = "plugin_contract"      # superclaw-plugin manifest contract
PROJECTION_SCHEMA_DIM = "projection_schema"  # ui_contracts projection contract

# Integer contract versions (bumped manually on a breaking change to that surface).
API_CONTRACT_VERSION = 1
# Mirrors schemas/superclaw-plugin.schema.json "x-superclaw-contract-version".
# Kept as a constant (always available, incl. installed wheels where the repo
# schema dir is not packaged) rather than read at runtime; a drift-guard test
# (test_version_contract) reads the schema and fails if they diverge — single
# source enforced at CI, deployment-safe at runtime.
PLUGIN_CONTRACT_VERSION = 1
PROJECTION_SCHEMA_VERSION = 1

# Injected by the shell/packaging layer; absent (None) on the pip/CLI path.
DESKTOP_SHELL_ENV = "SUPERCLAW_DESKTOP_SHELL_VERSION"
BUNDLED_CORE_ENV = "SUPERCLAW_BUNDLED_CORE_VERSION"
GIT_SHA_ENV = "SUPERCLAW_GIT_SHA"
RELEASE_CHANNEL_ENV = "SUPERCLAW_RELEASE_CHANNEL"
DEFAULT_CHANNEL = "beta"
_VALID_CHANNELS = ("stable", "beta", "dev")


@dataclass(frozen=True)
class VersionContract:
    product_version: str         # top-level semantic version (VERSION file = single source)
    cli_core: str                # == product_version
    bundled_core: str | None     # injected only in the installed app; None for pip
    desktop_shell: str | None    # injected only by the Tauri shell; None for CLI
    api_contract: int
    state_schema: int            # == state.StateStore.SCHEMA_VERSION
    plugin_contract: int
    projection_schema: int
    git_sha: str | None          # injected at build (CI); read-only at runtime
    channel: str                 # stable|beta|dev


def read_product_version() -> str:
    """The product version: installed package metadata first, else the VERSION
    file, else ``"0.1.0"`` (mirrors cli._superclaw_version, single source)."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("superclaw")
        except PackageNotFoundError:
            pass
    except ImportError:  # pragma: no cover - importlib.metadata is stdlib on 3.11
        pass
    version_file = Path(__file__).resolve().parents[4] / "VERSION"
    return version_file.read_text(encoding="utf-8").strip() if version_file.exists() else "0.1.0"


def _state_schema_version() -> int:
    from superclaw.state import StateStore  # lazy: keep this module import-light

    return int(StateStore.SCHEMA_VERSION)


def _channel(channel: str | None) -> str:
    value = (channel or os.environ.get(RELEASE_CHANNEL_ENV) or DEFAULT_CHANNEL).strip().lower()
    if value not in _VALID_CHANNELS:
        # fail-closed: a typo'd channel must not silently route updates to the
        # wrong (e.g. beta) manifest channel — surface the misconfiguration.
        raise ValueError(
            f"invalid release channel {value!r}; must be one of {_VALID_CHANNELS}"
        )
    return value


def build_version_contract(
    *,
    desktop_shell: str | None = None,
    bundled_core: str | None = None,
    channel: str | None = None,
) -> VersionContract:
    """Build the contract. ``desktop_shell``/``bundled_core`` come ONLY from the
    shell/packaging layer (arg or env); a low-level module can never override the
    derived dimensions."""
    product = read_product_version()
    return VersionContract(
        product_version=product,
        cli_core=product,
        bundled_core=bundled_core or os.environ.get(BUNDLED_CORE_ENV) or None,
        desktop_shell=desktop_shell or os.environ.get(DESKTOP_SHELL_ENV) or None,
        api_contract=API_CONTRACT_VERSION,
        state_schema=_state_schema_version(),
        plugin_contract=PLUGIN_CONTRACT_VERSION,
        projection_schema=PROJECTION_SCHEMA_VERSION,
        git_sha=os.environ.get(GIT_SHA_ENV) or None,
        channel=_channel(channel),
    )


def version_contract_payload(**kwargs) -> dict:
    """``asdict`` + an ordered ``dimensions`` list, shared by CLI and API."""
    contract = build_version_contract(**kwargs)
    data = asdict(contract)
    data["dimensions"] = [
        CLI_CORE_DIM,
        BUNDLED_CORE_DIM,
        DESKTOP_SHELL_DIM,
        API_CONTRACT_DIM,
        STATE_SCHEMA_DIM,
        PLUGIN_CONTRACT_DIM,
        PROJECTION_SCHEMA_DIM,
    ]
    return data


__all__ = [
    "VersionContract",
    "API_CONTRACT_VERSION",
    "PLUGIN_CONTRACT_VERSION",
    "PROJECTION_SCHEMA_VERSION",
    "DEFAULT_CHANNEL",
    "read_product_version",
    "build_version_contract",
    "version_contract_payload",
]
