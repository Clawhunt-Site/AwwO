"""Reference pricing for the byo cost lane (CostEvent.cost_cents).

Two billing lanes (docs/agent-team-kernel-daemon-pivot.md §5):

- ``relay``: the relay server's metering is authoritative — its receipt sets
  ``cost_cents`` and this module is never consulted.
- ``byo``: the user's own runtime. Cost in money terms is a *reference
  estimate* computed from a configured price table; it is observational and
  never billed.

Model prices change too often to hardcode (and the project convention forbids
hardcoding model names), so the table is configuration:

``SUPERCLAW_MODEL_PRICE_TABLE`` — either inline JSON or ``@/path/to/table.json``
mapping a model id to integer USD cents per million tokens::

    {"claude-opus-4-8": {"input_cents_per_mtok": 1500,
                          "output_cents_per_mtok": 7500,
                          "cached_input_cents_per_mtok": 150}}

An unknown model (or no table) yields ``None`` — callers keep ``cost_cents=0``
and the token counts remain the honest source of truth. Fail-open on parse
errors with an empty table: bad pricing config must never break a run.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

PRICE_TABLE_ENV = "SUPERCLAW_MODEL_PRICE_TABLE"

_MTOK = 1_000_000


def _load_table_text(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if not text:
        return {}
    if text.startswith("@"):
        path = Path(text[1:]).expanduser()
        if not path.is_file():
            return {}
        text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    return data if isinstance(data, dict) else {}


@lru_cache(maxsize=1)
def _cached_table(raw: str) -> dict[str, Any]:
    try:
        return _load_table_text(raw)
    except Exception:
        return {}


def load_price_table(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The configured model price table; empty when unset or malformed."""
    source = (env or os.environ).get(PRICE_TABLE_ENV, "")
    return _cached_table(source)


def estimate_cost_cents(
    model: str | None,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_input_tokens: int | None = None,
    env: Mapping[str, str] | None = None,
) -> int | None:
    """Reference cost in integer cents, or ``None`` when not estimable.

    ``None`` (unknown model / no table) is deliberately distinct from ``0``
    (a priced model that consumed nothing): callers must not record a confident
    zero for usage they simply could not price.
    """
    if not model:
        return None
    entry = load_price_table(env).get(str(model))
    if not isinstance(entry, dict):
        return None
    try:
        input_rate = int(entry.get("input_cents_per_mtok") or 0)
        output_rate = int(entry.get("output_cents_per_mtok") or 0)
        cached_rate = int(entry.get("cached_input_cents_per_mtok") or input_rate)
        cached = int(cached_input_tokens or 0)
        # Cached input is billed at the cached rate; the remainder at full rate.
        billable_input = max(0, int(input_tokens or 0) - cached)
        cents = (
            billable_input * input_rate
            + cached * cached_rate
            + int(output_tokens or 0) * output_rate
        ) / _MTOK
        return int(round(cents))
    except Exception:
        return None
