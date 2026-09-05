"""Capability atlas: the embedded profile of every capability unit SuperClaw can draw on.

The atlas catalogs skills, plugins, tools, and services from the OpenClaw/ClawHunt
ecosystem (self-built skills, vendored external skills, the wshobson plugin arsenal,
OpenClaw built-ins, and external tools/services) as one queryable, typed registry.

Data lives in ``capability_atlas.json`` next to this module and ships with the
package. Every unit carries provenance (``origin`` + ``source_url``) and an
``availability`` grade so coverage gaps stay visible instead of silently assumed.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

ATLAS_RESOURCE = Path(__file__).parent / "capability_atlas.json"

CAPABILITY_CATEGORIES = (
    "engineering",
    "security",
    "data-analytics",
    "media-generation",
    "marketing-seo",
    "productivity-workflow",
    "agent-orchestration",
    "knowledge-research",
    "platform-integration",
    "finance-trading",
    "communication",
    "self-improvement",
)
CAPABILITY_AVAILABILITIES = ("vendored", "local", "external", "declared")
CAPABILITY_INTEGRATIONS = ("skill", "plugin", "tool", "service")

# Units that can flow through the harness adapt/emit pipeline once a source
# checkout is present; tools and services integrate through runtime config instead.
ADAPTABLE_INTEGRATIONS = ("skill", "plugin")

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#-]*")


@dataclass(frozen=True)
class CapabilityUnit:
    capability_id: str
    name: str
    category: str
    origin: str
    source_url: str
    description: str
    triggers: tuple[str, ...]
    integration: str
    availability: str

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["triggers"] = list(self.triggers)
        return payload

    @property
    def adaptable(self) -> bool:
        return self.integration in ADAPTABLE_INTEGRATIONS and self.availability in {"vendored", "local"}


class CapabilityAtlasError(ValueError):
    """Raised when the packaged atlas data is missing or malformed."""


def _coerce_unit(raw: dict[str, Any], *, index: int) -> CapabilityUnit:
    capability_id = str(raw.get("id") or "").strip().lower()
    if not capability_id:
        raise CapabilityAtlasError(f"atlas entry {index} is missing id")
    category = str(raw.get("category") or "").strip()
    if category not in CAPABILITY_CATEGORIES:
        raise CapabilityAtlasError(f"atlas entry {capability_id!r} has unknown category {category!r}")
    integration = str(raw.get("integration") or "").strip()
    if integration not in CAPABILITY_INTEGRATIONS:
        raise CapabilityAtlasError(f"atlas entry {capability_id!r} has unknown integration {integration!r}")
    availability = str(raw.get("availability") or "").strip()
    if availability not in CAPABILITY_AVAILABILITIES:
        raise CapabilityAtlasError(f"atlas entry {capability_id!r} has unknown availability {availability!r}")
    triggers = tuple(str(item).strip().lower() for item in raw.get("triggers") or [] if str(item).strip())
    return CapabilityUnit(
        capability_id=capability_id,
        name=str(raw.get("name") or capability_id),
        category=category,
        origin=str(raw.get("origin") or "unknown"),
        source_url=str(raw.get("source_url") or ""),
        description=str(raw.get("description") or ""),
        triggers=triggers,
        integration=integration,
        availability=availability,
    )


def load_capability_atlas(path: str | Path | None = None) -> tuple[CapabilityUnit, ...]:
    if path is None:
        return _load_packaged_atlas()
    return _load_atlas_file(Path(path))


@lru_cache(maxsize=1)
def _load_packaged_atlas() -> tuple[CapabilityUnit, ...]:
    return _load_atlas_file(ATLAS_RESOURCE)


def _load_atlas_file(path: Path) -> tuple[CapabilityUnit, ...]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CapabilityAtlasError(f"capability atlas not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CapabilityAtlasError(f"capability atlas is not valid JSON: {path}") from exc
    entries = payload.get("capabilities") if isinstance(payload, dict) else payload
    if not isinstance(entries, list) or not entries:
        raise CapabilityAtlasError(f"capability atlas has no entries: {path}")
    units: dict[str, CapabilityUnit] = {}
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise CapabilityAtlasError(f"atlas entry {index} is not an object")
        unit = _coerce_unit(raw, index=index)
        if unit.capability_id in units:
            raise CapabilityAtlasError(f"duplicate capability id: {unit.capability_id}")
        units[unit.capability_id] = unit
    return tuple(units[key] for key in sorted(units))


def get_capability(capability_id: str, *, atlas: tuple[CapabilityUnit, ...] | None = None) -> CapabilityUnit:
    units = atlas if atlas is not None else load_capability_atlas()
    wanted = capability_id.strip().lower()
    for unit in units:
        if unit.capability_id == wanted:
            return unit
    raise KeyError(f"unknown capability {capability_id!r}; run capability search or summary for known ids")


def search_capabilities(
    query: str = "",
    *,
    category: str | None = None,
    origin: str | None = None,
    availability: str | None = None,
    integration: str | None = None,
    atlas: tuple[CapabilityUnit, ...] | None = None,
) -> list[CapabilityUnit]:
    units = atlas if atlas is not None else load_capability_atlas()
    needle = query.strip().lower()
    results: list[CapabilityUnit] = []
    for unit in units:
        if category and unit.category != category:
            continue
        if origin and unit.origin != origin:
            continue
        if availability and unit.availability != availability:
            continue
        if integration and unit.integration != integration:
            continue
        if needle:
            haystack = " ".join((unit.capability_id, unit.name.lower(), unit.description.lower(), " ".join(unit.triggers)))
            if needle not in haystack:
                continue
        results.append(unit)
    return results


def suggest_capabilities(
    goal_text: str,
    *,
    limit: int = 8,
    atlas: tuple[CapabilityUnit, ...] | None = None,
) -> list[dict[str, Any]]:
    """Rank capability units against free-form goal text for run planning.

    Trigger-phrase hits dominate, goal words that appear in the capability id
    are a strong signal (this keeps English tokens inside mixed-language goals
    working), and bare word overlap with the name/description breaks ties. Only
    units with a positive score are returned, so an unrelated goal yields an
    empty suggestion list instead of noise.
    """
    if limit <= 0:
        return []
    units = atlas if atlas is not None else load_capability_atlas()
    text = goal_text.strip().lower()
    if not text:
        return []
    words = set(_WORD_RE.findall(text))
    scored: list[tuple[float, CapabilityUnit, list[str]]] = []
    for unit in units:
        matched: list[str] = []
        score = 0.0
        for trigger in unit.triggers:
            if trigger and trigger in text:
                score += 3.0
                matched.append(trigger)
                continue
            trigger_words = set(_WORD_RE.findall(trigger))
            if trigger_words and trigger_words.issubset(words):
                score += 2.0
                matched.append(trigger)
        id_words = set(_WORD_RE.findall(unit.capability_id.replace("-", " ")))
        id_hits = words & id_words
        score += 1.0 * len(id_hits)
        unit_words = set(_WORD_RE.findall(f"{unit.name.lower()} {unit.description.lower()}")) | id_words
        overlap = words & unit_words
        score += 0.25 * len(overlap)
        if matched or id_hits or len(overlap) >= 2:
            scored.append((score, unit, matched))
    scored.sort(key=lambda item: (-item[0], item[1].capability_id))
    return [
        {
            "capability": unit.to_dict(),
            "score": round(score, 2),
            "matched_triggers": matched,
        }
        for score, unit, matched in scored[:limit]
        if score > 0
    ]


def validate_facets(
    *,
    category: str | None = None,
    availability: str | None = None,
    integration: str | None = None,
    origin: str | None = None,
    atlas: tuple[CapabilityUnit, ...] | None = None,
) -> list[str]:
    """Return human-readable problems for unknown facet filter values.

    A typo in a filter should fail loudly with the known values instead of
    silently returning an empty result set.
    """
    problems: list[str] = []
    if category and category not in CAPABILITY_CATEGORIES:
        problems.append(f"unknown category {category!r}; known: {', '.join(CAPABILITY_CATEGORIES)}")
    if availability and availability not in CAPABILITY_AVAILABILITIES:
        problems.append(f"unknown availability {availability!r}; known: {', '.join(CAPABILITY_AVAILABILITIES)}")
    if integration and integration not in CAPABILITY_INTEGRATIONS:
        problems.append(f"unknown integration {integration!r}; known: {', '.join(CAPABILITY_INTEGRATIONS)}")
    if origin:
        units = atlas if atlas is not None else load_capability_atlas()
        known_origins = sorted({unit.origin for unit in units})
        if origin not in known_origins:
            problems.append(f"unknown origin {origin!r}; known: {', '.join(known_origins)}")
    return problems


def atlas_summary(*, atlas: tuple[CapabilityUnit, ...] | None = None) -> dict[str, Any]:
    units = atlas if atlas is not None else load_capability_atlas()
    return {
        "total": len(units),
        "by_category": _count_by(units, lambda unit: unit.category),
        "by_origin": _count_by(units, lambda unit: unit.origin),
        "by_availability": _count_by(units, lambda unit: unit.availability),
        "by_integration": _count_by(units, lambda unit: unit.integration),
        "adaptable": sum(1 for unit in units if unit.adaptable),
    }


def coverage_report(*, atlas: tuple[CapabilityUnit, ...] | None = None) -> dict[str, Any]:
    """Availability-graded coverage with the actionable gap list spelled out."""
    units = atlas if atlas is not None else load_capability_atlas()
    declared = [unit for unit in units if unit.availability == "declared"]
    external = [unit for unit in units if unit.availability == "external"]
    ready = [unit for unit in units if unit.availability in {"vendored", "local"}]
    return {
        "total": len(units),
        "ready": len(ready),
        "ready_ratio": round(len(ready) / len(units), 3) if units else 0.0,
        "external_count": len(external),
        "declared_gaps": [
            {"id": unit.capability_id, "origin": unit.origin, "source_url": unit.source_url}
            for unit in declared
        ],
        "external_dependencies": [
            {"id": unit.capability_id, "integration": unit.integration, "source_url": unit.source_url}
            for unit in external
        ],
        "remediation": {
            "declared": "vendor the skill source into the catalog repo, then flip availability to vendored",
            "external": "pin the upstream and mirror it locally, or accept the runtime network dependency",
        },
    }


def category_matrix(*, atlas: tuple[CapabilityUnit, ...] | None = None) -> dict[str, dict[str, int]]:
    units = atlas if atlas is not None else load_capability_atlas()
    matrix: dict[str, dict[str, int]] = {category: {grade: 0 for grade in CAPABILITY_AVAILABILITIES} for category in CAPABILITY_CATEGORIES}
    for unit in units:
        matrix[unit.category][unit.availability] += 1
    return {category: grades for category, grades in matrix.items() if any(grades.values())}


def adaptable_capabilities(*, atlas: tuple[CapabilityUnit, ...] | None = None) -> list[CapabilityUnit]:
    """Units eligible for the harness adapt/emit pipeline (skills and plugins with a local source)."""
    units = atlas if atlas is not None else load_capability_atlas()
    return [unit for unit in units if unit.adaptable]


def _count_by(units: tuple[CapabilityUnit, ...], key: Any) -> dict[str, int]:
    counts: dict[str, int] = {}
    for unit in units:
        counts[key(unit)] = counts.get(key(unit), 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))
