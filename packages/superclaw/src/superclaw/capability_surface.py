"""Capability-surface fingerprint + graded resume guard.

Why this exists
---------------
A chat/run session captures, at start time, a snapshot of *what the model believes
it can do*: which governed skills are discoverable, which plugin tools the
aggregate proxy will answer, what permission mode is in force, which backend/model
is driving. The governance gate keeps execution safe even when that world-view
goes stale (a revoked plugin call is refused at call time) — but it cannot reach
*into the model's context* and erase a capability the model still remembers. A
resumed session therefore keeps trying a tool that no longer exists, burning turns
on refusals, or — worse — resumes under a *wider* permission mode than the one the
earlier turns were planned against.

This module is the missing half of "per-session capability freeze": it fingerprints
the capability surface at session start, re-fingerprints before resume, and grades
the difference into an action. It is deliberately a pure, dependency-free core —
the collectors that read the real projection lock / plugin catalog / revocation
file are thin wrappers at the bottom, so the classification logic is testable
without touching disk.

Grading (least → most disruptive to resume):

- ``SILENT_NOTE``   — capability *added*, mode *narrowed*, model changed: resume
  seamlessly, inject one notice line so the model knows the new surface.
- ``INJECT_NOTICE`` — capability *revoked / removed*: resume is allowed, but inject
  a high-priority "do NOT use X" notice so the model stops trying.
- ``CONFIRM``       — a tool schema or skill body *changed*, or the backend
  changed: the model may rely on a stale shape, so ask the user before resuming.
- ``HARD_BLOCK``    — permission authority *widened* (a lower rank → higher rank
  in ``_PERMISSION_ORDER``) or a safety posture downgraded: never silently resume
  a session into more authority than it started with (privilege-escalation guard).
  Force a fresh session. NOTE: under the max-permission doctrine ``ask`` and
  ``allow`` are equal authority (both rank 0), so switching between them is NOT a
  widening; the guard stays dormant for presets until a future gated ``ask``.

``--strict-resume`` promotes ``INJECT_NOTICE`` to ``HARD_BLOCK`` so a revocation
also forces a fresh session.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

SURFACE_SCHEMA_VERSION = "1"

# Permission presets, ordered by authority. Widening (a lower index → higher
# index) is the privilege-escalation case that must hard-block on resume.
# Under the max-permission doctrine (permissions.py PRESET_TO_MODE) BOTH presets
# project onto bypassPermissions and run identically at max, so they share rank
# 0 — switching ask<->allow is NOT a widening and must not reset the native
# session. The ladder structure is kept for a future gated 'ask' (which would
# then take a lower rank than 'allow').
_PERMISSION_ORDER = {"ask": 0, "allow": 0}


def _digest_mapping(mapping: Mapping[str, str]) -> str:
    """Stable sha256 over a string→string mapping (order-independent)."""
    canonical = json.dumps(dict(sorted(mapping.items())), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _tool_digest(tool_name: str, short_description: str) -> str:
    """Digest of the part of a plugin tool the model actually sees in the catalog."""
    return hashlib.sha256(f"{tool_name}\n{short_description}".encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CapabilitySurface:
    """A fingerprint of everything the model's world-view depends on for a session.

    Each component is kept addressable (not collapsed into one opaque hash) so the
    diff can be graded per item — a single combined hash could only ever say
    "something changed", which would force the same blunt action for a harmless
    add and a privilege escalation.
    """

    skill_digests: dict[str, str] = field(default_factory=dict)
    """Managed native-skill projections: target path → source content digest."""

    plugin_tool_digests: dict[str, str] = field(default_factory=dict)
    """Aggregate-proxy catalog: projected tool name → (name+description) digest."""

    permission_mode: str = "ask"
    backend: str = ""
    model: str = ""
    revocation_epoch: str = ""
    """Digest of the revocation list, so a revocation registers even if the catalog
    snapshot was taken before the offending tool was dropped."""

    @property
    def combined(self) -> str:
        """One hash of the whole surface — cheap equality check before the per-item diff."""
        payload = {
            "v": SURFACE_SCHEMA_VERSION,
            "skills": _digest_mapping(self.skill_digests),
            "tools": _digest_mapping(self.plugin_tool_digests),
            "permission_mode": self.permission_mode,
            "backend": self.backend,
            "model": self.model,
            "revocation_epoch": self.revocation_epoch,
        }
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": SURFACE_SCHEMA_VERSION,
            "skill_digests": dict(self.skill_digests),
            "plugin_tool_digests": dict(self.plugin_tool_digests),
            "permission_mode": self.permission_mode,
            "backend": self.backend,
            "model": self.model,
            "revocation_epoch": self.revocation_epoch,
            "combined": self.combined,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CapabilitySurface":
        return cls(
            skill_digests={str(k): str(v) for k, v in dict(data.get("skill_digests", {})).items()},
            plugin_tool_digests={
                str(k): str(v) for k, v in dict(data.get("plugin_tool_digests", {})).items()
            },
            permission_mode=str(data.get("permission_mode") or "ask"),
            backend=str(data.get("backend") or ""),
            model=str(data.get("model") or ""),
            revocation_epoch=str(data.get("revocation_epoch") or ""),
        )


def compute_capability_surface(
    *,
    skill_digests: Mapping[str, str] | None = None,
    plugin_tool_digests: Mapping[str, str] | None = None,
    permission_mode: str = "ask",
    backend: str = "",
    model: str | None = "",
    revocation_epoch: str = "",
) -> CapabilitySurface:
    """Construct a surface from explicit inputs (kept pure for testability)."""
    return CapabilitySurface(
        skill_digests=dict(skill_digests or {}),
        plugin_tool_digests=dict(plugin_tool_digests or {}),
        permission_mode=str(permission_mode or "ask"),
        backend=str(backend or ""),
        model=str(model or ""),
        revocation_epoch=str(revocation_epoch or ""),
    )


class SurfaceDiffAction(str, Enum):
    """Resume actions, ordered by how disruptive they are (see ``_SEVERITY``)."""

    SILENT_NOTE = "silent_note"
    INJECT_NOTICE = "inject_notice"
    CONFIRM = "confirm"
    HARD_BLOCK = "hard_block"


_SEVERITY = {
    SurfaceDiffAction.SILENT_NOTE: 0,
    SurfaceDiffAction.INJECT_NOTICE: 1,
    SurfaceDiffAction.CONFIRM: 2,
    SurfaceDiffAction.HARD_BLOCK: 3,
}


@dataclass(frozen=True)
class SurfaceDiff:
    """One graded change between two surfaces."""

    action: SurfaceDiffAction
    kind: str  # "skill" | "plugin_tool" | "permission_mode" | "backend" | "model" | "revocation"
    name: str
    detail: str


def classify_surface_diff(
    old: CapabilitySurface, new: CapabilitySurface
) -> list[SurfaceDiff]:
    """Grade every change from ``old`` to ``new`` into per-item resume actions."""
    diffs: list[SurfaceDiff] = []

    # --- Permission mode: widening is the privilege-escalation guard. ----------
    if old.permission_mode != new.permission_mode:
        old_rank = _PERMISSION_ORDER.get(old.permission_mode, 0)
        new_rank = _PERMISSION_ORDER.get(new.permission_mode, 0)
        if new_rank > old_rank:
            diffs.append(
                SurfaceDiff(
                    SurfaceDiffAction.HARD_BLOCK,
                    "permission_mode",
                    new.permission_mode,
                    f"permission mode widened {old.permission_mode!r} → {new.permission_mode!r}; "
                    "resuming would grant more authority than this session was planned under",
                )
            )
        elif new_rank < old_rank:
            diffs.append(
                SurfaceDiff(
                    SurfaceDiffAction.SILENT_NOTE,
                    "permission_mode",
                    new.permission_mode,
                    f"permission mode narrowed {old.permission_mode!r} → {new.permission_mode!r}",
                )
            )
        # else: equal authority (e.g. ask<->allow, which both run at max under the
        # max-permission doctrine) — NOT a privilege change, so emit no diff and
        # preserve the native session rather than resetting it as a fake widening.

    # --- Backend / model. ------------------------------------------------------
    if old.backend != new.backend:
        diffs.append(
            SurfaceDiff(
                SurfaceDiffAction.CONFIRM,
                "backend",
                new.backend,
                f"backend changed {old.backend!r} → {new.backend!r}; tool-call semantics may differ",
            )
        )
    if old.model != new.model:
        diffs.append(
            SurfaceDiff(
                SurfaceDiffAction.SILENT_NOTE,
                "model",
                new.model,
                f"model changed {old.model!r} → {new.model!r}",
            )
        )

    # --- Plugin tools. ---------------------------------------------------------
    diffs.extend(
        _diff_mapping(
            old.plugin_tool_digests,
            new.plugin_tool_digests,
            kind="plugin_tool",
            removed_detail="plugin tool {name} is no longer available (revoked, uninstalled, or de-entitled)",
            added_detail="plugin tool {name} is now available",
            changed_detail="plugin tool {name} signature changed; a remembered call shape may be stale",
        )
    )

    # --- Skills. ---------------------------------------------------------------
    diffs.extend(
        _diff_mapping(
            old.skill_digests,
            new.skill_digests,
            kind="skill",
            removed_detail="skill {name} was removed",
            added_detail="skill {name} was added",
            changed_detail="skill {name} content changed",
        )
    )

    # --- Revocation epoch: a residual signal if nothing item-level surfaced. ----
    # If the revocation list moved but no tool/skill diff explained it, still note
    # it so the change is never completely silent.
    if old.revocation_epoch != new.revocation_epoch and not any(
        d.action in (SurfaceDiffAction.INJECT_NOTICE, SurfaceDiffAction.HARD_BLOCK) for d in diffs
    ):
        diffs.append(
            SurfaceDiff(
                SurfaceDiffAction.SILENT_NOTE,
                "revocation",
                "revocation_epoch",
                "the revocation list changed since this session started",
            )
        )

    return diffs


def _diff_mapping(
    old: Mapping[str, str],
    new: Mapping[str, str],
    *,
    kind: str,
    removed_detail: str,
    added_detail: str,
    changed_detail: str,
) -> list[SurfaceDiff]:
    diffs: list[SurfaceDiff] = []
    for name in sorted(set(old) - set(new)):
        diffs.append(
            SurfaceDiff(SurfaceDiffAction.INJECT_NOTICE, kind, name, removed_detail.format(name=name))
        )
    for name in sorted(set(new) - set(old)):
        diffs.append(
            SurfaceDiff(SurfaceDiffAction.SILENT_NOTE, kind, name, added_detail.format(name=name))
        )
    for name in sorted(set(old) & set(new)):
        if old[name] != new[name]:
            diffs.append(
                SurfaceDiff(SurfaceDiffAction.CONFIRM, kind, name, changed_detail.format(name=name))
            )
    return diffs


def resolve_resume_action(
    diffs: list[SurfaceDiff], *, strict: bool = False
) -> SurfaceDiffAction:
    """Reduce per-item diffs to the single most-disruptive action.

    With ``strict=True`` a revocation (``INJECT_NOTICE``) is promoted to
    ``HARD_BLOCK`` so a withdrawn capability also forces a fresh session.
    """
    if not diffs:
        return SurfaceDiffAction.SILENT_NOTE
    actions = [d.action for d in diffs]
    if strict and SurfaceDiffAction.INJECT_NOTICE in actions:
        actions = [
            SurfaceDiffAction.HARD_BLOCK if a is SurfaceDiffAction.INJECT_NOTICE else a
            for a in actions
        ]
    return max(actions, key=lambda a: _SEVERITY[a])


def render_capability_change_notice(diffs: list[SurfaceDiff]) -> str:
    """Build a system-message body describing the capability change for the model.

    Revocations are framed as imperative ("do NOT use") because the model's context
    still claims they work; additions/changes are framed as informational.
    """
    if not diffs:
        return ""
    revoked = [d for d in diffs if d.action is SurfaceDiffAction.INJECT_NOTICE]
    changed = [d for d in diffs if d.action is SurfaceDiffAction.CONFIRM]
    added = [
        d
        for d in diffs
        if d.action is SurfaceDiffAction.SILENT_NOTE and d.kind in ("skill", "plugin_tool")
    ]
    lines: list[str] = ["The capability surface changed since this session started."]
    if revoked:
        names = ", ".join(d.name for d in revoked)
        lines.append(
            f"CRITICAL — no longer available: {names}. Do NOT attempt to use these; "
            "find an alternative path."
        )
    if changed:
        names = ", ".join(d.name for d in changed)
        lines.append(f"Changed signatures (verify before relying on a remembered shape): {names}.")
    if added:
        names = ", ".join(d.name for d in added)
        lines.append(f"Newly available: {names}.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Collectors (thin wrappers over the real sources; kept out of the pure core). #
# --------------------------------------------------------------------------- #


def collect_skill_digests(lock_path: Path | None = None) -> dict[str, str]:
    """Read native-skill projection digests from the projection lock.

    Keyed by target path so a per-runtime projection of the same skill is tracked
    independently. Returns an empty mapping when nothing has been projected.
    """
    from superclaw.skill_sync import default_projection_lock, load_projection_lock

    path = lock_path or default_projection_lock()
    try:
        records = load_projection_lock(path)
    except Exception:
        return {}
    return {
        record.path: (record.source_digest or record.render_digest)
        for record in records.values()
    }


def collect_plugin_tool_digests(**available_plugins_kwargs: Any) -> dict[str, str]:
    """Fingerprint the governed aggregate-proxy catalog the model would see.

    Runs through the same fail-closed ``available_plugins()`` gate as projection
    and execution, so the fingerprint can never reflect a tool the gate would
    refuse. Returns an empty mapping on any error (fail-soft: a fingerprint we
    cannot compute degrades to "treat as empty", never crashes resume).
    """
    from superclaw.plugin_runtime_projection import available_plugins

    digests: dict[str, str] = {}
    try:
        for plugin in available_plugins(**available_plugins_kwargs):
            for tool in plugin.tools:
                digests[tool.projected_name] = _tool_digest(
                    tool.tool_name, tool.short_description
                )
    except Exception:
        return {}
    return digests


def collect_revocation_epoch(
    revocation_file: Path | None = None,
    skill_revocation_file: Path | None = None,
) -> str:
    """Digest the revocation lists so a revocation registers as a surface change.

    Folds BOTH the plugin revocation list AND the native-skill revocation list.
    A native skill is revoked through its OWN list (``~/.superclaw/skills/
    revocations.json``), independent of the plugin list. The already-projected
    ``SKILL.md`` keeps sitting in the runtime dir until the next ``skill sync``
    reclaims it, so the resume guard is the only thing that can flag the stale
    projection in-session — and it can only do so if the native revocation list
    is part of the epoch. Reading the plugin list alone (the prior behaviour) let
    a revoked native skill's stale prose keep loading with no resume notice.

    Fail-soft: an unreadable list returns "" (treated as a surface change, the
    safe direction); neither list present returns "none".
    """
    from superclaw.plugins import default_revocation_file
    from superclaw.skill_store import default_skill_revocation_file

    sources = (
        ("plugin", revocation_file or default_revocation_file()),
        ("skill", skill_revocation_file or default_skill_revocation_file()),
    )
    hasher = hashlib.sha256()
    saw_any = False
    for label, path in sources:
        try:
            resolved = Path(path)
            if not resolved.exists():
                continue
            saw_any = True
            # Domain-separate each source so an entry moving between lists can
            # never produce a colliding epoch.
            hasher.update(label.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(resolved.read_bytes())
            hasher.update(b"\0")
        except Exception:
            return ""
    if not saw_any:
        return "none"
    return hasher.hexdigest()


def current_capability_surface(
    *,
    permission_mode: str = "ask",
    backend: str = "",
    model: str | None = "",
    lock_path: Path | None = None,
    revocation_file: Path | None = None,
    **available_plugins_kwargs: Any,
) -> CapabilitySurface:
    """Assemble the live surface from the real projection lock / catalog / revocations.

    A convenience for surface points (API, CLI) so they call one function instead
    of wiring three collectors. Each collector is fail-soft, so a missing source
    degrades to "empty" rather than crashing a resume.
    """
    return compute_capability_surface(
        skill_digests=collect_skill_digests(lock_path),
        plugin_tool_digests=collect_plugin_tool_digests(**available_plugins_kwargs),
        permission_mode=permission_mode,
        backend=backend,
        model=model,
        revocation_epoch=collect_revocation_epoch(revocation_file),
    )
