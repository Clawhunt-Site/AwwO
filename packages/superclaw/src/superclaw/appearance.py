"""Appearance / color-scheme management — the kernel single source of truth.

The CLI is the project's capability baseline (铁律: CLI 唯一事实源); every surface
(CLI / API / Web / Desktop) reads the same preset vocabulary and the same persisted
preference from here instead of hardcoding its own palette. Appearance is a pure
*presentation* concern, but because the owner wants it persisted as a config FILE in
the data root (importable/exportable), the kernel owns the file so all surfaces read
one authoritative copy rather than a web-only ``localStorage`` shard that would drift
from the CLI.

Two orthogonal concepts:

* **base canvas** — ``light`` / ``dark``. This stays driven by the existing theme
  preference (``data-theme`` on the web root) and is NOT owned here.
* **color scheme** — a named *preset* (or ``custom``) that overrides a curated
  whitelist of semantic color tokens *on top of* the active canvas. This is what this
  module persists. A preset that overrides nothing renders the stock look.

Persistence lives at :func:`appearance_config_path` (``~/.superclaw/appearance.json``
by default, overridable via ``SUPERCLAW_APPEARANCE_CONFIG_PATH``) using the same
lock + atomic-replace discipline as the shell config so a concurrent ``set`` and an
``import`` can never clobber each other or leave a half-written file.

The kernel validates and stores only **solid hex** values for whitelisted tokens; the
translucent companion variables (``--accent-soft`` etc.) are derived by the rendering
surface from each token's ``soft_alpha`` — color math is a presentation detail and is
deliberately kept out of the kernel.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from superclaw.environment import superclaw_home

try:  # POSIX file locking
    import fcntl
except ImportError:  # pragma: no cover - platform dependent
    fcntl = None  # type: ignore[assignment]

try:  # Windows file locking
    import msvcrt
except ImportError:  # pragma: no cover - platform dependent
    msvcrt = None  # type: ignore[assignment]

APPEARANCE_CONFIG_ENV = "SUPERCLAW_APPEARANCE_CONFIG_PATH"
APPEARANCE_SCHEMA_VERSION = "0.1.0"
EXPORT_KIND = "superclaw.appearance"

# The two base canvases a color scheme can layer on top of. ``system`` resolves to
# one of these at render time, so persisted custom palettes are keyed by the concrete
# canvas, never by ``system``.
CANVASES: tuple[str, ...] = ("light", "dark")

DEFAULT_PRESET_ID = "default"
CUSTOM_PRESET_ID = "custom"

_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


# --- Token whitelist -------------------------------------------------------------
# The semantic color anchors a user may override in custom mode (and the only keys a
# preset may touch). Kept deliberately small (~10) — the high-leverage tokens — so the
# customization UI stays usable and a user can't paint themselves into an unreadable
# corner by editing all ~100 raw variables. ``css_var`` is the primary variable the
# surface sets; ``soft_var`` (optional) is a translucent companion the surface derives
# from the same hue at ``soft_alpha``.
APPEARANCE_TOKENS: tuple[dict[str, Any], ...] = (
    {"id": "accent", "label": "Accent", "css_var": "--accent", "soft_var": "--accent-soft", "soft_alpha": 0.14, "group": "accent"},
    {"id": "bg_base", "label": "Background", "css_var": "--bg-base", "group": "surface"},
    {"id": "bg_sidebar", "label": "Sidebar", "css_var": "--bg-sidebar", "group": "surface"},
    {"id": "bg_card", "label": "Card", "css_var": "--bg-card", "group": "surface"},
    {"id": "border_light", "label": "Border", "css_var": "--border-light", "group": "surface"},
    {"id": "text_primary", "label": "Text", "css_var": "--text-primary", "group": "text"},
    {"id": "text_secondary", "label": "Muted text", "css_var": "--text-secondary", "group": "text"},
    {"id": "warn", "label": "Warning", "css_var": "--warn", "soft_var": "--warn-soft", "soft_alpha": 0.14, "group": "status"},
    {"id": "danger", "label": "Danger", "css_var": "--danger-bg", "group": "status"},
    {"id": "agent_running", "label": "Agent running", "css_var": "--agent-running", "soft_var": "--agent-running-soft", "soft_alpha": 0.2, "group": "status"},
)

_TOKEN_IDS: frozenset[str] = frozenset(tok["id"] for tok in APPEARANCE_TOKENS)


def _ov(light: dict[str, str] | None = None, dark: dict[str, str] | None = None) -> dict[str, dict[str, str]]:
    return {"light": dict(light or {}), "dark": dict(dark or {})}


# --- Curated presets -------------------------------------------------------------
# Each preset overrides token ids per canvas; an empty map = stock look for that
# canvas. Values are solid hex; the surface derives soft companions. ``default`` is
# the stock SuperClaw look (no overrides). The kernel is the ONLY place this list is
# defined — surfaces read it via the contract and never hardcode their own.
# Each preset is now a COORDINATED theme, not a single accent swap: it overrides the
# whole high-leverage set per canvas (surfaces + border + text + accent) so it reads as
# a designed look rather than a hue change on the stock greys. Dark is the primary canvas
# (the app defaults to dark); light variants are mostly-white surfaces with a faint themed
# tint + a darker accent for contrast. ``warn``/``danger``/``agent_running`` stay at the
# stock status hues so semantics like "danger = red" are never themed away. Token order
# per map: bg_base / bg_sidebar / bg_card / border_light / text_primary / text_secondary /
# accent.
APPEARANCE_PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": DEFAULT_PRESET_ID,
        "label": "Default",
        "description": "The stock SuperClaw indigo look.",
        "swatch": "#7a8cff",
        "overrides": _ov(),
    },
    {
        "id": "midnight",
        "label": "Midnight",
        "description": "Deep blue-black surfaces with an indigo accent.",
        "swatch": "#7c8cff",
        "overrides": _ov(
            light={"bg_base": "#f6f7fc", "bg_sidebar": "#f6f7fc", "bg_card": "#ffffff", "border_light": "#dde2ef", "text_primary": "#181d2e", "text_secondary": "#5b6478", "accent": "#4f5fd6"},
            dark={"bg_base": "#0a0e1a", "bg_sidebar": "#0a0e1a", "bg_card": "#121829", "border_light": "#242e48", "text_primary": "#e8ecf5", "text_secondary": "#9aa6c2", "accent": "#7c8cff"},
        ),
    },
    {
        "id": "slate",
        "label": "Slate",
        "description": "Neutral cool graphite with a steel-blue accent.",
        "swatch": "#8aa3c8",
        "overrides": _ov(
            light={"bg_base": "#f6f7f9", "bg_sidebar": "#f6f7f9", "bg_card": "#ffffff", "border_light": "#e1e5ea", "text_primary": "#1b1e24", "text_secondary": "#5c6470", "accent": "#3f5b86"},
            dark={"bg_base": "#0e1013", "bg_sidebar": "#0e1013", "bg_card": "#181b21", "border_light": "#2b313b", "text_primary": "#e9ebef", "text_secondary": "#9aa1ac", "accent": "#8aa3c8"},
        ),
    },
    {
        "id": "emerald",
        "label": "Emerald",
        "description": "Deep forest surfaces with an emerald accent.",
        "swatch": "#34d27f",
        "overrides": _ov(
            light={"bg_base": "#f3faf6", "bg_sidebar": "#f3faf6", "bg_card": "#ffffff", "border_light": "#d7e8de", "text_primary": "#0f1d16", "text_secondary": "#4f6a5c", "accent": "#0f9d58"},
            dark={"bg_base": "#07120d", "bg_sidebar": "#07120d", "bg_card": "#0e1d16", "border_light": "#1f3529", "text_primary": "#e6f1ea", "text_secondary": "#93b4a2", "accent": "#34d27f"},
        ),
    },
    {
        "id": "ocean",
        "label": "Ocean",
        "description": "Dark teal surfaces with a cyan accent.",
        "swatch": "#2dd4bf",
        "overrides": _ov(
            light={"bg_base": "#f0f9fb", "bg_sidebar": "#f0f9fb", "bg_card": "#ffffff", "border_light": "#d2e8ec", "text_primary": "#0c1d22", "text_secondary": "#4d6a72", "accent": "#0e7490"},
            dark={"bg_base": "#06131a", "bg_sidebar": "#06131a", "bg_card": "#0d2029", "border_light": "#1d3742", "text_primary": "#e2f0f4", "text_secondary": "#92b3bd", "accent": "#2dd4bf"},
        ),
    },
    {
        "id": "violet",
        "label": "Violet",
        "description": "Deep plum surfaces with a violet accent.",
        "swatch": "#a78bfa",
        "overrides": _ov(
            light={"bg_base": "#f8f5fd", "bg_sidebar": "#f8f5fd", "bg_card": "#ffffff", "border_light": "#e6ddf2", "text_primary": "#1c1428", "text_secondary": "#5f5278", "accent": "#7c3aed"},
            dark={"bg_base": "#110a1a", "bg_sidebar": "#110a1a", "bg_card": "#1b1228", "border_light": "#302244", "text_primary": "#ece6f5", "text_secondary": "#ab9bc6", "accent": "#a78bfa"},
        ),
    },
    {
        "id": "rose",
        "label": "Rose",
        "description": "Warm wine surfaces with a rose accent.",
        "swatch": "#f472a6",
        "overrides": _ov(
            light={"bg_base": "#fdf4f8", "bg_sidebar": "#fdf4f8", "bg_card": "#ffffff", "border_light": "#f0dbe5", "text_primary": "#281019", "text_secondary": "#7a5160", "accent": "#c2185b"},
            dark={"bg_base": "#150a10", "bg_sidebar": "#150a10", "bg_card": "#22121b", "border_light": "#3c2331", "text_primary": "#f3e7ee", "text_secondary": "#c69bae", "accent": "#f472a6"},
        ),
    },
    {
        "id": "amber",
        "label": "Amber",
        "description": "Warm ember surfaces with an amber accent.",
        "swatch": "#f0a93a",
        "overrides": _ov(
            light={"bg_base": "#fdf8f0", "bg_sidebar": "#fdf8f0", "bg_card": "#ffffff", "border_light": "#efe2cd", "text_primary": "#271f12", "text_secondary": "#6e6450", "accent": "#b8730a"},
            dark={"bg_base": "#14100a", "bg_sidebar": "#14100a", "bg_card": "#201810", "border_light": "#38291b", "text_primary": "#f3ece0", "text_secondary": "#bcaa8e", "accent": "#f0a93a"},
        ),
    },
    {
        "id": "high_contrast",
        "label": "High contrast",
        "description": "Maximum text and border contrast for readability.",
        "swatch": "#ffffff",
        "overrides": _ov(
            light={"bg_base": "#ffffff", "bg_sidebar": "#ffffff", "bg_card": "#ffffff", "border_light": "#8a8a8a", "text_primary": "#000000", "text_secondary": "#2e2e2e", "accent": "#1d4ed8"},
            dark={"bg_base": "#000000", "bg_sidebar": "#000000", "bg_card": "#0d0d0d", "border_light": "#6a6a6a", "text_primary": "#ffffff", "text_secondary": "#e2e2e2", "accent": "#93b4ff"},
        ),
    },
    {
        "id": "oled",
        "label": "OLED black",
        "description": "True-black surfaces for OLED displays (dark canvas).",
        "swatch": "#0a0a0a",
        "overrides": _ov(
            dark={"bg_base": "#000000", "bg_sidebar": "#000000", "bg_card": "#0b0b0b", "border_light": "#1c1c1c", "text_primary": "#f4f4f4", "text_secondary": "#a8a8a8", "accent": "#7c8cff"},
        ),
    },
    {
        "id": "cyber",
        "label": "Cyber",
        "description": "Deep-space navy surfaces with a cyan accent (ClawHunt cyber, dark canvas).",
        "swatch": "#00d4ff",
        "overrides": _ov(
            dark={"bg_base": "#08081a", "bg_sidebar": "#0b0b20", "bg_card": "#0f1530", "border_light": "#1e2747", "text_primary": "#eef2fb", "text_secondary": "#b8c2e0", "accent": "#00d4ff"},
        ),
    },
)

_PRESET_IDS: frozenset[str] = frozenset(p["id"] for p in APPEARANCE_PRESETS)


def known_preset_ids() -> tuple[str, ...]:
    return tuple(p["id"] for p in APPEARANCE_PRESETS)


# --- Validation helpers ----------------------------------------------------------

def _normalize_hex(value: Any) -> str | None:
    """Return a canonical ``#rrggbb`` lowercase string, or ``None`` if invalid.

    Accepts ``#rgb`` shorthand and expands it. Anything that is not a well-formed
    3- or 6-digit hex color is rejected (fail-closed) — surfaces never trust a
    hand-edited or imported value to be safe to inject into ``style``.
    """
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not _HEX_RE.match(candidate):
        return None
    body = candidate[1:].lower()
    if len(body) == 3:
        body = "".join(ch * 2 for ch in body)
    return f"#{body}"


def _normalize_canvas_overrides(raw: Any, *, warnings: list[str], canvas: str) -> dict[str, str]:
    """Validate a single canvas's ``{token_id: hex}`` map, dropping bad entries."""
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        if raw is not None:
            warnings.append(f"custom.{canvas}: expected an object, ignored")
        return out
    for key, value in raw.items():
        if key not in _TOKEN_IDS:
            warnings.append(f"custom.{canvas}: unknown token '{key}' dropped")
            continue
        normalized = _normalize_hex(value)
        if normalized is None:
            warnings.append(f"custom.{canvas}.{key}: invalid color '{value}' dropped")
            continue
        out[key] = normalized
    return out


def _normalize_custom(raw: Any, *, warnings: list[str]) -> dict[str, dict[str, str]]:
    custom = {"light": {}, "dark": {}}  # type: dict[str, dict[str, str]]
    if not isinstance(raw, dict):
        return custom
    for canvas in CANVASES:
        custom[canvas] = _normalize_canvas_overrides(raw.get(canvas), warnings=warnings, canvas=canvas)
    return custom


def _normalize_config(raw: Any, *, warnings: list[str]) -> dict[str, Any]:
    """Coerce arbitrary persisted/imported data into a valid config, fail-closed.

    Unknown presets fall back to ``default``; malformed custom entries are dropped
    with a warning. The result is always a well-formed config the surfaces can trust.
    """
    data = raw if isinstance(raw, dict) else {}
    active = data.get("active_preset")
    if active not in _PRESET_IDS and active != CUSTOM_PRESET_ID:
        if active not in (None, ""):
            warnings.append(f"unknown active_preset '{active}', reset to '{DEFAULT_PRESET_ID}'")
        active = DEFAULT_PRESET_ID
    custom = _normalize_custom(data.get("custom"), warnings=warnings)
    # An ``active_preset='custom'`` with no custom colors at all is meaningless; keep
    # it (the surface simply renders the stock look) — do NOT silently rewrite it, so
    # round-tripping export/import is stable.
    return {
        "schema_version": APPEARANCE_SCHEMA_VERSION,
        "active_preset": active,
        "custom": custom,
    }


def _default_config() -> dict[str, Any]:
    return {
        "schema_version": APPEARANCE_SCHEMA_VERSION,
        "active_preset": DEFAULT_PRESET_ID,
        "custom": {"light": {}, "dark": {}},
    }


# --- Persistence (lock + atomic replace) -----------------------------------------

def appearance_config_path() -> Path:
    configured = os.environ.get(APPEARANCE_CONFIG_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    return superclaw_home() / "appearance.json"


@contextmanager
def _hold_appearance_lock() -> Iterator[None]:
    """Serialize the appearance read-modify-write across processes.

    Mirrors the shell-config lock: without a locking primitive we fail closed rather
    than write unlocked, so a concurrent ``appearance set`` and ``appearance import``
    can never lose each other's update.
    """
    path = appearance_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    guard = path.with_name(path.name + ".lock")
    handle = open(guard, "a+")  # noqa: SIM115 - released in finally
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:  # pragma: no cover - platform dependent
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:  # pragma: no cover - platform dependent
            raise RuntimeError("no file-locking primitive available; refusing unlocked appearance write")
        yield
    finally:
        with contextlib.suppress(OSError):
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - platform dependent
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()


def _write_appearance(config: dict[str, Any]) -> None:
    path = appearance_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def load_appearance_config() -> dict[str, Any]:
    """Return the persisted appearance config, normalized + fail-closed.

    A missing file yields the default config. A corrupt/partial file is normalized
    (unknown values dropped) rather than raising — the surface always gets something
    renderable.
    """
    path = appearance_config_path()
    if not path.exists():
        return _default_config()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_config()
    return _normalize_config(raw, warnings=[])


def _locked_update(mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    with _hold_appearance_lock():
        path = appearance_config_path()
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raw = None
        else:
            raw = None
        config = _normalize_config(raw, warnings=[]) if raw is not None else _default_config()
        mutate(config)
        normalized = _normalize_config(config, warnings=[])
        _write_appearance(normalized)
        return normalized


# --- Mutations -------------------------------------------------------------------

def set_active_preset(preset_id: str) -> dict[str, Any]:
    if preset_id not in _PRESET_IDS and preset_id != CUSTOM_PRESET_ID:
        raise ValueError(f"unknown preset '{preset_id}'")
    return _locked_update(lambda cfg: cfg.__setitem__("active_preset", preset_id))


def set_custom_color(canvas: str, token_id: str, value: str) -> dict[str, Any]:
    """Set one custom token for one canvas and switch active scheme to ``custom``.

    Editing a color implies the user wants their custom palette active, so this also
    flips ``active_preset`` to ``custom`` (matching the UX of picking a color).
    """
    if canvas not in CANVASES:
        raise ValueError(f"unknown canvas '{canvas}'")
    if token_id not in _TOKEN_IDS:
        raise ValueError(f"unknown token '{token_id}'")
    normalized = _normalize_hex(value)
    if normalized is None:
        raise ValueError(f"invalid color '{value}'")

    def mutate(cfg: dict[str, Any]) -> None:
        cfg.setdefault("custom", {"light": {}, "dark": {}})
        cfg["custom"].setdefault(canvas, {})
        cfg["custom"][canvas][token_id] = normalized
        cfg["active_preset"] = CUSTOM_PRESET_ID

    return _locked_update(mutate)


def clear_custom_color(canvas: str, token_id: str) -> dict[str, Any]:
    if canvas not in CANVASES:
        raise ValueError(f"unknown canvas '{canvas}'")
    if token_id not in _TOKEN_IDS:
        raise ValueError(f"unknown token '{token_id}'")

    def mutate(cfg: dict[str, Any]) -> None:
        canvas_map = cfg.get("custom", {}).get(canvas, {})
        canvas_map.pop(token_id, None)

    return _locked_update(mutate)


def reset_appearance() -> dict[str, Any]:
    """Reset to the stock default and drop all custom colors."""
    return _locked_update(lambda cfg: cfg.update(_default_config()))


def apply_appearance(*, active_preset: str | None = None, custom: Any = None) -> tuple[dict[str, Any], list[str]]:
    """Apply a whole-scheme update from a surface payload (used by the API set/import).

    Returns ``(config, warnings)``. Invalid custom entries are dropped with warnings
    (fail-closed) rather than rejecting the entire request; an unknown ``active_preset``
    raises so the surface gets a clear error instead of silently storing garbage.
    """
    warnings: list[str] = []
    if active_preset is not None and active_preset not in _PRESET_IDS and active_preset != CUSTOM_PRESET_ID:
        raise ValueError(f"unknown preset '{active_preset}'")
    normalized_custom = _normalize_custom(custom, warnings=warnings) if custom is not None else None

    def mutate(cfg: dict[str, Any]) -> None:
        if active_preset is not None:
            cfg["active_preset"] = active_preset
        if normalized_custom is not None:
            cfg["custom"] = normalized_custom

    return _locked_update(mutate), warnings


# --- Contract + payload ----------------------------------------------------------

def build_appearance_contract() -> dict[str, Any]:
    """The canonical color-scheme vocabulary shared by CLI / API / Web / Desktop.

    Every surface renders the preset picker and the custom-color editor from this
    instead of hardcoding a palette, so the available themes and editable tokens can
    never drift between surfaces (铁律 3: 契约集中).
    """
    return {
        "schema_version": APPEARANCE_SCHEMA_VERSION,
        "canvases": list(CANVASES),
        "default_preset": DEFAULT_PRESET_ID,
        "custom_preset_id": CUSTOM_PRESET_ID,
        "tokens": [dict(tok) for tok in APPEARANCE_TOKENS],
        "presets": [
            {
                "id": p["id"],
                "label": p["label"],
                "description": p["description"],
                "swatch": p["swatch"],
                "overrides": {c: dict(p["overrides"].get(c, {})) for c in CANVASES},
            }
            for p in APPEARANCE_PRESETS
        ],
    }


def appearance_payload() -> dict[str, Any]:
    """The one projection every surface reads: the contract + the persisted state."""
    config = load_appearance_config()
    payload = build_appearance_contract()
    payload["config_path"] = str(appearance_config_path())
    payload["active_preset"] = config["active_preset"]
    payload["custom"] = config["custom"]
    return payload


# --- Import / export -------------------------------------------------------------

def build_appearance_export() -> dict[str, Any]:
    """The round-trippable export bundle (mirrors the company-export shape).

    Carries only the user's *choice* (active preset + custom colors), not the preset
    catalog — the catalog is kernel-owned and may differ across versions, so importing
    a bundle re-validates the choice against the *current* catalog.
    """
    config = load_appearance_config()
    return {
        "kind": EXPORT_KIND,
        "schema_version": APPEARANCE_SCHEMA_VERSION,
        "active_preset": config["active_preset"],
        "custom": config["custom"],
    }


def import_appearance_bundle(data: Any) -> tuple[dict[str, Any], list[str]]:
    """Validate + persist an imported bundle. Returns ``(config, warnings)``.

    Fail-closed: a bundle that is not a dict, or whose ``kind`` is wrong, raises. An
    unknown ``active_preset`` falls back to ``default`` with a warning (an importer
    from a newer version shouldn't hard-fail), and malformed custom colors are dropped
    with warnings. This mirrors how company-import records every lossy normalization
    rather than silently succeeding.
    """
    if not isinstance(data, dict):
        raise ValueError("appearance bundle must be a JSON object")
    kind = data.get("kind")
    if kind is not None and kind != EXPORT_KIND:
        raise ValueError(f"unexpected bundle kind '{kind}', expected '{EXPORT_KIND}'")
    warnings: list[str] = []
    incoming = _normalize_config(
        {"active_preset": data.get("active_preset"), "custom": data.get("custom")},
        warnings=warnings,
    )
    config = _locked_update(lambda cfg: cfg.update(incoming))
    return config, warnings
