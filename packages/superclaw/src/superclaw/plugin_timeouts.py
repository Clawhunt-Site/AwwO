"""Opt-in env override for the *default* plugin sidecar / smoke timeouts.

Production behaviour is unchanged: when ``SUPERCLAW_PLUGIN_TIMEOUT_SECONDS`` is
unset (the production default), callers get their normal default timeout. When
it IS set, it raises the floor for the *default* timeout only — never the
explicit per-tool manifest / policy / parameter values that some tests
deliberately tighten (e.g. ``tool_timeout_ms=100``) to exercise the timeout path.

Why this exists: a plugin sidecar is a real subprocess. Under a parallel test
run (pytest-xdist) or on an otherwise-busy host, a trivially-fast sidecar can be
CPU-starved past a tight wall-clock budget and reported as a *false*
``PLUGIN_TIMEOUT`` / "sidecar timed out". Raising the default timeout in the test
environment lets the real sidecar still run (keeping the security boundary under
test) without load-induced flakiness.

Scope of what it relaxes (NOT overclaimed): it adjusts only the *liveness /
resource* bound — how long a sidecar is allowed to run before being killed. It
does NOT touch any trust / signing / governance / sandbox gate; those are
enforced independently of how long the sidecar runs (a process that runs to the
raised limit is still bound by the same sandbox, env scrubbing, and audit). It
only ever *lengthens* the default and only when explicitly opted in via the env
var, so it cannot shorten a production resource limit by accident.
"""

import math
import os

_ENV_VAR = "SUPERCLAW_PLUGIN_TIMEOUT_SECONDS"


def floor_default_timeout_seconds(base_seconds: float) -> float:
    """Return ``base_seconds``, raised to ``SUPERCLAW_PLUGIN_TIMEOUT_SECONDS`` if
    that env var is set to a larger, finite, positive value. Never lowers a
    timeout; a missing, malformed, non-finite (``inf``/``nan``), or non-positive
    value is ignored so the production default always wins."""
    raw = os.environ.get(_ENV_VAR)
    if not raw:
        return base_seconds
    try:
        override = float(raw)
    except (TypeError, ValueError):
        return base_seconds
    if not math.isfinite(override) or override <= 0:
        return base_seconds
    return max(base_seconds, override)
