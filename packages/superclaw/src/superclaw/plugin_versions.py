from __future__ import annotations

import re
from typing import Any


VERSION_RANGE_TOKEN_RE = re.compile(r"^(>=|>|<=|<|=)?[0-9]+(?:\.[0-9]+){0,2}$")


class PluginVersionRangeError(ValueError):
    """Raised when a plugin version range cannot be parsed safely."""


def normalize_version_range(version_range: str | None) -> str:
    value = str(version_range or "*").strip()
    if value in {"*", "any"}:
        return "*"
    constraints = [part for part in re.split(r"[,\s]+", value) if part]
    if not constraints:
        return "*"
    for constraint in constraints:
        if not VERSION_RANGE_TOKEN_RE.fullmatch(constraint):
            raise PluginVersionRangeError("invalid plugin version range")
    return " ".join(constraints)


def version_satisfies_range(version: str, version_range: str | None) -> bool:
    normalized = normalize_version_range(version_range)
    if normalized == "*":
        return True
    candidate = version_tuple(version)
    for constraint in normalized.split():
        if constraint.startswith(">="):
            if candidate < version_tuple(constraint[2:]):
                return False
        elif constraint.startswith(">"):
            if candidate <= version_tuple(constraint[1:]):
                return False
        elif constraint.startswith("<="):
            if candidate > version_tuple(constraint[2:]):
                return False
        elif constraint.startswith("<"):
            if candidate >= version_tuple(constraint[1:]):
                return False
        elif constraint.startswith("="):
            if candidate != version_tuple(constraint[1:]):
                return False
        elif candidate != version_tuple(constraint):
            return False
    return True


def version_tuple(value: Any) -> tuple[int, int, int]:
    parts = [int(part) for part in str(value or "0.0.0").split(".")[:3] if part.isdigit()]
    return tuple([*parts, 0, 0, 0][:3])
