"""Permission mode framework — the single source of truth for SuperClaw's
two user-facing permission presets and how each Agent Runtime backend maps
them onto its native sandbox/approval mode.

Design rule (see docs/permission-mode-framework.md):

* SuperClaw exposes exactly TWO presets to users: ``ask`` and ``allow``.
* SuperClaw does NOT make per-action decisions of its own — it is a pass-through
  that translates a preset into whatever the underlying runtime already supports.
* Every backend MUST declare ``permission_presets()`` so that adding a new
  Agent Runtime forces the author to decide how its two states are realized.
  A registry-wide conformance test (tests/test_permission_presets.py) fails if
  any registered backend omits or under-specifies the mapping.

This module deliberately stays tiny: no decision engine, no action taxonomy,
no approval coordinator. Those were considered and rejected as over-engineering
(see docs/permission-broker-plan.md for the discarded design).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

# Single source of the company-management tool names (PR-F). Imported at module
# top (company_commands imports only ``models``, so no cycle) so the mutating-tool
# taxonomy below is derived from it rather than hand-copied.
from superclaw.company_commands import COMPANY_TOOL_NAMES as _COMPANY_TOOL_NAMES
from superclaw.marketplace_commands import (
    MARKETPLACE_WRITE_TOOL_NAMES as _MARKETPLACE_WRITE_TOOL_NAMES,
)

# ---------------------------------------------------------------------------
# The two user-facing states. This is the ONLY permission concept surfaces see.
# ---------------------------------------------------------------------------
PermissionPreset = Literal["ask", "allow"]

REQUIRED_PRESETS: frozenset[PermissionPreset] = frozenset({"ask", "allow"})

# Titles are HONEST about current behavior: under the max-permission doctrine
# both presets run at max, so "ask" must NOT claim to prompt/restrict (it would
# be surface fraud). The two slots are kept for a future gated "ask".
PRESET_LABELS: dict[PermissionPreset, dict[str, str]] = {
    "ask": {"label_key": "perm.preset.ask", "title": "Standard (max today)"},
    "allow": {"label_key": "perm.preset.allow", "title": "Allow all actions"},
}

# Each preset selects one canonical PermissionPolicy.mode. The 6 legacy modes
# remain as advanced/back-compat values underneath the two-state shell.
#
# Doctrine (owner decision 2026-06-22): the underlying runtime is a pure
# EXECUTION ENGINE and is always handed its MAXIMUM permission. Governance does
# NOT live in the runtime's own permission system — for the CLI-class backends
# SuperClaw cannot even intercept the runtime's tool loop, and a runtime's own
# headless permission mode (e.g. claude ``acceptEdits``) silently auto-DENIES
# tools that need approval (WebSearch, MCP tools) instead of escalating, which
# surfaced as mysterious tool "Error"s with no way to grant. So BOTH presets map
# to ``bypassPermissions`` — the universal "max" trigger every backend keys on.
#
# HONEST consequence — be explicit, do not overclaim a governance layer that
# does not exist yet: under this mapping the B-class in-process escalation_gate
# (which only fires when posture != "full") is BYPASSED for preset-driven runs,
# and a standard chat/run executes at full posture with NO per-action human gate.
# There is no live human-approval surface today; "governance moves up" is FUTURE
# work (Web approval inbox), not a currently-present door.
#
# What DOES still gate, independent of this mapping (so it is not a TOTAL blanket
# fail-open — these are the only live brakes):
#   * Low-trust / untrusted runs: ContainmentPolicy.permission_mode_floor takes
#     the STRICTEST of (run mode, floor) — an untrusted run stays read-only even
#     under ``bypassPermissions`` (containment.containment_denies_tool). This
#     covers B-class in-process tools; the orchestrator additionally REFUSES
#     backends that cannot prove containment (backend_supports_containment) for
#     low-trust runs, so CLI-class backends never run untrusted code at max.
#   * Explicit ``plan`` mode (advanced) -> readonly posture for review runs.
#   * Pay-switch / scan-intent hard gates live in fusion/plugins and are
#     independent of the permission preset entirely.
#
# Threat model: single user, user-triggered == allowed; only irreversible actions
# warrant confirmation, and that confirmation is deferred to the future human-gate.
PRESET_TO_MODE: dict[PermissionPreset, str] = {
    "ask": "bypassPermissions",
    "allow": "bypassPermissions",
}


# ---------------------------------------------------------------------------
# What a backend declares for one preset.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PresetRealization:
    """How a single backend realizes one preset.

    native:        free-form but human-readable description of the backend-native
                   setting this preset maps to (flags, sandbox+approval, posture).
    interactive:   does a HUMAN actually get prompted per-action at runtime under
                   this preset? Today this is False everywhere: even the Codex
                   app-server's approval callbacks are auto-answered by SuperClaw
                   policy, so no human ever sees a prompt. It may only become True
                   once an approval queue surfaces requests to a person.
    note_key:      i18n key for an honest, surface-rendered explanation (especially
                   required when interactive is False, so users are not misled).
    preset_driven: does switching the preset actually change this runtime's
                   behavior? Declare False explicitly when it cannot (no native
                   gate, or the flag set is fixed) — the conformance test requires
                   preset-driven pairs to differ and no-gate backends to say so.
    """

    native: str
    interactive: bool
    note_key: str
    preset_driven: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# preset -> PresetRealization
PresetMap = dict[PermissionPreset, PresetRealization]


def make_presets(*, ask: PresetRealization, allow: PresetRealization) -> PresetMap:
    """Build a PresetMap. Backends use this so the two-state shape is uniform."""
    return {"ask": ask, "allow": allow}


def check_preset_map(backend_name: str, presets: PresetMap) -> None:
    """Validate a backend's declaration. Raises ValueError on any gap.

    Used by the registry-wide conformance test AND can be called at registry
    build time. This is the enforcement mechanism that makes declaring the
    mapping a hard requirement for every new backend.
    """
    keys = frozenset(presets)
    if keys != REQUIRED_PRESETS:
        missing = REQUIRED_PRESETS - keys
        extra = keys - REQUIRED_PRESETS
        raise ValueError(
            f"backend {backend_name!r} permission_presets() must declare exactly "
            f"{sorted(REQUIRED_PRESETS)}; missing={sorted(missing)} extra={sorted(extra)}"
        )
    for preset, realization in presets.items():
        if not isinstance(realization, PresetRealization):
            raise ValueError(f"backend {backend_name!r} preset {preset!r} is not a PresetRealization")
        if not (realization.native or "").strip():
            raise ValueError(f"backend {backend_name!r} preset {preset!r} has empty 'native'")
        if not (realization.note_key or "").strip():
            raise ValueError(f"backend {backend_name!r} preset {preset!r} has empty 'note_key'")


def serialize_preset_map(presets: PresetMap) -> dict[str, dict[str, Any]]:
    """Serialize a PresetMap for ui_contracts / surfaces."""
    return {preset: realization.to_dict() for preset, realization in presets.items()}


# ---------------------------------------------------------------------------
# B-class (in-process self-owned) posture helper.
#
# B-class backends (anthropic-agent, gemini-agent) ARE the runtime — there is no
# underlying runtime to delegate to — so SuperClaw enforces a posture directly in
# the tool loop. The posture is derived from the policy mode. Note: only `plan`
# tightens behavior; every other mode preserves today's behavior (zero change).
# ---------------------------------------------------------------------------
Posture = Literal["readonly", "workspace", "full"]


def posture_for_mode(mode: str | None) -> Posture:
    if mode == "plan":
        return "readonly"
    if mode in {"bypassPermissions", "dontAsk"}:
        return "full"
    # default / acceptEdits / auto / unknown -> current workspace behavior
    return "workspace"


# Every in-process (B-class) tool must be classified in exactly one of these
# sets. A conformance test introspects _exec_tool and fails when a new tool is
# added without classifying it here — otherwise read-only posture could be
# silently bypassed by an unclassified mutating tool.
# The company-management tools (PR-F) are KERNEL-STATE mutations (create/update/
# archive a company, hire/update an agent, create/assign/delegate an issue). They
# do not touch the repo filesystem or shell, but they ARE mutating governance
# actions and MUST be denied under a read-only (plan) posture and a low-trust
# containment fence — an untrusted review run must not be able to hire a
# high-privilege agent or restructure a company to escape its sandbox. Folding
# them into _MUTATING_TOOLS makes the SAME fence (posture_denies_tool /
# containment_denies_tool) that already guards run_shell/write_file cover them by
# construction. ``_COMPANY_TOOL_NAMES`` (imported at module top from the single
# command-vocabulary source) ensures this can never drift from what the backend
# actually dispatches.
_MUTATING_TOOLS: frozenset[str] = frozenset(
    {"run_shell", "write_file", "delegate"}
    | set(_COMPANY_TOOL_NAMES)
    # Marketplace WRITES (post/bid/claim/submit/abandon/accept/accept_bid) cross an
    # external boundary + make commitments — mutating by construction, so the same
    # read-only-posture / low-trust-containment fence that guards run_shell covers
    # them too. Reads (browse/inspect) are NOT here (they do not mutate).
    | set(_MARKETPLACE_WRITE_TOOL_NAMES)
)
_READONLY_TOOLS: frozenset[str] = frozenset({"read_file", "list_files"})


def posture_denies_tool(posture: Posture, tool_name: str) -> bool:
    """True when the posture forbids this in-process tool."""
    return posture == "readonly" and tool_name in _MUTATING_TOOLS


def permission_mode_contract() -> dict[str, Any]:
    """Top-level contract block exported to all surfaces via ui_contracts."""
    return {
        "presets": list(REQUIRED_PRESETS),
        "labels": PRESET_LABELS,
        "preset_to_mode": dict(PRESET_TO_MODE),
    }
