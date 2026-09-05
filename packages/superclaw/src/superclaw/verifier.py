from __future__ import annotations

import operator
import re
from typing import Any


class VerificationExpressionError(ValueError):
    """Raised when a verifier expression is outside the safe supported subset."""


_COMPARATORS = {
    ">=": operator.ge,
    "<=": operator.le,
    "==": operator.eq,
    "!=": operator.ne,
    ">": operator.gt,
    "<": operator.lt,
}
_SAFE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:-]+$")


def _coerce(raw: str, metrics: dict[str, Any]) -> Any:
    if raw in metrics:
        return metrics[raw]
    lowered = raw.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    try:
        if "." in raw:
            return float(raw)
        return int(raw)
    except ValueError:
        return raw


def _eval_atom(expression: str, metrics: dict[str, Any]) -> bool:
    expression = expression.strip()
    if not expression:
        raise VerificationExpressionError("empty verifier expression")
    if any(token in expression for token in ("__", "(", ")", "[", "]", "{", "}", ";")):
        raise VerificationExpressionError(f"unsupported verifier expression: {expression}")

    for symbol, compare in _COMPARATORS.items():
        if symbol not in expression:
            continue
        left, right = [part.strip() for part in expression.split(symbol, 1)]
        if not _SAFE_NAME.match(left) or not _SAFE_VALUE.match(right):
            raise VerificationExpressionError(f"unsupported verifier expression: {expression}")
        if left not in metrics:
            return False
        return bool(compare(_coerce(left, metrics), _coerce(right, metrics)))

    if not _SAFE_NAME.match(expression):
        raise VerificationExpressionError(f"unsupported verifier expression: {expression}")
    return bool(metrics.get(expression, False))


def evaluate_expression(expression: str, metrics: dict[str, Any]) -> bool:
    """Evaluate the fail-closed verifier subset used by OpenClaw loop configs."""
    atoms = [part.strip() for part in re.split(r"\band\b", expression)]
    return all(_eval_atom(atom, metrics) for atom in atoms)

