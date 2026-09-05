"""Run **diagnostic context bundle** — "where did it get stuck, what decision, why?"
(P2a, observability/diagnostics).

A *pure, derive-only* builder: given a ``run_id`` it composes a redacted,
operator-facing **diagnostic context** for a run — the span parent/child tree,
the lifecycle timeline, the governance decision codes, cost, the run conditions
(reused from the P1 condition manifest), and derived root-cause hints. It is the
``superclaw diagnose <run_id>`` payload.

**Honest boundary (hard-coded).** This is *diagnostic context*, NOT decision
replay. Replay needs Tier C (recorded raw LLM/tool I/O), which does not exist
yet, so ``_meta.decision_replay = "unavailable"`` and
``decision_replay_reason = "tier_c_recording_absent"``. We never fake replay from
unstructured transcripts.

Privacy is fail-closed and reuses the P1 contract: telemetry is read **read-only**
(``mode=ro``, never via ``DiagnosticsStore``); every value is allowlist-redacted
(a diagnostic bundle may be forwarded to a manager, so redaction is NOT relaxed
just because it is "local"); a missing/pruned telemetry store degrades to
``completeness = incomplete`` (not a hard failure) unless ``require_complete``.
Run-not-found / state read failure → ``ExportError``. This module imports no HTTP
client and is CLI-surface only — the API/Web never build or serve it.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.request import pathname2url

from .condition_manifest import _scrub_scalar, build_condition_manifest
from .diagnostics_owners import GOVERNANCE_DECISION
from .diagnostics_redaction import redact
from .diagnostics_store import SCHEMA_VERSION as TELEMETRY_SCHEMA_VERSION
from .diagnostics_store import resolve_telemetry_path
from .operator_export import ExportError

DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1

_SPAN_KINDS = ("span.start", "span.end", "span.error")
_MAX_HINTS = 64
_MAX_GOVERNANCE = 1000


# ---------------------------------------------------------------------------
# Governance decisions (dedicated read — the condition manifest projects span.*
# payloads only, so it drops a governance receipt's decision/tool/reason facet).
# ---------------------------------------------------------------------------
def _gov_field(value: Any) -> Any:
    """Project a governance string field with the FULL P1 guard. ``redact()`` alone
    only does secret/URL/cap — it does NOT block whitespace / paths / free text, and
    the producer API accepts arbitrary ``tool_name``/``reason``. So re-scrub here."""
    return _scrub_scalar(value) if isinstance(value, str) else value


def _read_governance_decisions(
    path: Path, run_id: str
) -> tuple[list[dict[str, Any]] | None, str | None, bool]:
    """Read this run's ``governance.decision`` receipts via a strictly read-only
    connection. Returns ``(decisions, reason, truncated)`` — ``(None, reason, False)``
    when the store is unavailable (degradable), ``truncated=True`` when more than
    ``_MAX_GOVERNANCE`` decisions existed (the surplus is dropped → completeness
    must drop to incomplete, never a silent truncation under require_complete)."""
    if not path.exists():
        return None, "telemetry_db_absent", False
    uri = "file:" + pathname2url(str(path.resolve())) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error:
        return None, "telemetry_db_unreadable", False
    try:
        conn.row_factory = sqlite3.Row
        user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if user_version > TELEMETRY_SCHEMA_VERSION:
            return None, "telemetry_schema_newer", False
        # Push the cap into SQL (LIMIT _MAX+1) so a runaway run with hundreds of
        # thousands of decisions can never balloon memory before truncation.
        rows = conn.execute(
            "SELECT occurred_at, payload FROM receipts "
            "WHERE run_id = ? AND kind = ? ORDER BY occurred_at ASC, id ASC LIMIT ?",
            (run_id, GOVERNANCE_DECISION, _MAX_GOVERNANCE + 1),
        ).fetchall()
    except sqlite3.Error:
        return None, "telemetry_query_failed", False
    finally:
        conn.close()

    truncated = len(rows) > _MAX_GOVERNANCE
    decisions: list[dict[str, Any]] = []
    for row in rows[:_MAX_GOVERNANCE]:
        try:
            payload = json.loads(row["payload"])
        except (ValueError, TypeError):
            payload = {}
        # Idempotent central allowlist, THEN the P1 free-text/path guard.
        projected = redact(GOVERNANCE_DECISION, payload if isinstance(payload, dict) else {})
        occurred = row["occurred_at"]
        decisions.append(
            {
                "occurred_at": occurred if isinstance(occurred, (int, float)) and not isinstance(occurred, bool) else None,
                "decision": _gov_field(projected.get("decision")),
                "tool_name": _gov_field(projected.get("tool_name")),
                "reason": _gov_field(projected.get("reason")),
                # The AUTHORITATIVE state.db escalation id is carried IN the payload
                # (a domain id), not the engine correlation column.
                "escalation_request_id": _gov_field(projected.get("request_id")),
            }
        )
    return decisions, None, truncated


# ---------------------------------------------------------------------------
# Span parent/child organisation (from the condition manifest's telemetry_spans).
# ---------------------------------------------------------------------------
def _organize_spans(telemetry_spans: Any) -> list[dict[str, Any]]:
    """Merge the per-receipt span.start/end/error rows into one node per span_id,
    carrying parent_span_id (the tree is encoded by the parent pointers — we keep
    a flat, sorted list to stay totality-safe against hostile/cyclic pointers)."""
    if not isinstance(telemetry_spans, list):
        return []
    nodes: dict[Any, dict[str, Any]] = {}
    order: list[Any] = []
    anon = 0
    for entry in telemetry_spans:
        if not isinstance(entry, dict):
            continue
        if entry.get("kind") not in _SPAN_KINDS:
            continue
        span_id = entry.get("span_id")
        # Use an INTEGER key for a missing span_id so it can never collide with a
        # real (hostile) string span_id like "_anon_0" and wrongly merge nodes.
        if isinstance(span_id, str):
            key: Any = span_id
        else:
            key = anon
            anon += 1
        node = nodes.get(key)
        if node is None:
            node = {
                "span_id": span_id,
                "parent_span_id": entry.get("parent_span_id"),
                "name": None,
                "span_kind": None,
                "started_at": None,
                "duration_ms": None,
                "error_type": None,
                "has_error": False,
            }
            nodes[key] = node
            order.append(key)
        payload = entry.get("span") if isinstance(entry.get("span"), dict) else {}
        if node["name"] is None and payload.get("name") is not None:
            node["name"] = payload.get("name")
        if node["span_kind"] is None and payload.get("span_kind") is not None:
            node["span_kind"] = payload.get("span_kind")
        if payload.get("duration_ms") is not None:
            node["duration_ms"] = payload.get("duration_ms")
        if entry.get("kind") == "span.start" and node["started_at"] is None:
            node["started_at"] = entry.get("occurred_at")
        if entry.get("kind") == "span.error":
            node["has_error"] = True
            if payload.get("error_type") is not None:
                node["error_type"] = payload.get("error_type")
        # a node missing parent on the start row may get it from end/error
        if node["parent_span_id"] is None and entry.get("parent_span_id") is not None:
            node["parent_span_id"] = entry.get("parent_span_id")
    return [nodes[k] for k in order]


# ---------------------------------------------------------------------------
# Root-cause hints (derived from already-collected, already-redacted facets).
# ---------------------------------------------------------------------------
# Trusted, STATIC human notes (zero user data) — safe to emit verbatim. The
# data-bearing parts go in ``fields`` (each value individually scrubbed); the
# free-text "why" lives here as a constant so it is never fed through
# ``_scrub_scalar`` (which would collapse any whitespace sentence to "<redacted>").
_HINT_NOTES: dict[str, str] = {
    "run_terminal_not_done": "run ended in a terminal non-done state",
    "governance_denied": "a governance gate denied a tool",
    "span_error": "a span recorded an error",
    "governance_truncated": "governance decisions exceeded the cap and were truncated",
    "diagnostic_context_incomplete": (
        "telemetry spans/decisions may be missing (store absent or pruned); "
        "this is diagnostic context, not a guaranteed-complete record"
    ),
    "no_spans_recorded": "no spans recorded for this run — instrumentation may not cover this path",
}


def _root_cause_hints(
    *,
    run_status: Any,
    spans: list[dict[str, Any]],
    governance: list[dict[str, Any]] | None,
    governance_truncated: bool,
    completeness_status: str,
) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []

    def _add(code: str, **fields: Any) -> None:
        if len(hints) >= _MAX_HINTS:
            return
        # Scrub each data-bearing field component individually (enums/ids have no
        # whitespace so they survive); the human "why" is the trusted static note.
        safe = {k: (_scrub_scalar(v) if isinstance(v, str) else v) for k, v in fields.items()}
        hints.append({"code": code, "note": _HINT_NOTES.get(code, ""), "fields": safe})

    # System-level honesty hints FIRST — a flood of per-item denied/error hints
    # must never crowd out "this view is truncated / incomplete" past the _MAX cap.
    if governance_truncated:
        _add("governance_truncated", cap=_MAX_GOVERNANCE)
    if completeness_status != "complete":
        _add("diagnostic_context_incomplete")

    if isinstance(run_status, str) and run_status in ("failed", "error", "cancelled"):
        _add("run_terminal_not_done", status=run_status)

    for d in governance or []:
        if d.get("decision") in ("denied", "deny"):
            _add("governance_denied", tool=d.get("tool_name") or "?", reason=d.get("reason") or "?")

    for node in spans:
        if node.get("has_error"):
            _add("span_error", name=node.get("name") or "?", error_type=node.get("error_type") or "?")

    if completeness_status == "complete" and not spans:
        _add("no_spans_recorded")

    return hints


# ---------------------------------------------------------------------------
# _meta (honest boundary — hard-coded)
# ---------------------------------------------------------------------------
def _meta_block(now: float) -> dict[str, Any]:
    return {
        "schema_version": DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
        "kind": "run_diagnostic",
        "mode": "diagnostic_context",
        # Honest boundary: this locates "which step / what decision / why"; it is
        # NOT decision replay. Replay needs Tier C (recorded raw I/O), not built.
        "decision_replay": "unavailable",
        "decision_replay_reason": "tier_c_recording_absent",
        "reconstructable": False,
        "contains_cleartext_environment": False,
        "contains_tier_c": False,
        "built_at": now,
        "limitations": [
            "This is DIAGNOSTIC CONTEXT (span tree + timeline + decision codes + "
            "root-cause hints + run conditions), not a byte-for-byte reproduction.",
            "Decision replay (dry-run over recorded LLM/tool I/O) is UNAVAILABLE: it "
            "requires Tier C raw-I/O recording, which is not implemented. We never "
            "fake replay from unstructured transcripts.",
            "All values are allowlist-redacted and identifiers are HMAC fingerprints "
            "(reused from the P1 condition manifest) — redaction is not relaxed for "
            "local use, since a bundle may be forwarded to an operator.",
            "Telemetry is best-effort: when the telemetry store is absent or pruned, "
            "completeness.status is 'incomplete', not a failure.",
        ],
    }


# ---------------------------------------------------------------------------
# Public builder
# ---------------------------------------------------------------------------
def build_diagnostic_bundle(
    store: Any,
    *,
    run_id: str,
    telemetry_path: str | Any | None = None,
    operator_secret: str | None = None,
    now: float | None = None,
    require_complete: bool = False,
) -> dict[str, Any]:
    """Build the diagnostic context bundle for ``run_id`` (pure, derive-only).

    Reuses the P1 condition manifest for the run/conditions/timeline/spans/cost
    facets (all already redacted) and adds the governance decision codes, the
    span parent/child organisation, and derived root-cause hints. Fail-closed on
    an unknown run; degrades (not fails) when telemetry is missing unless
    ``require_complete``.
    """
    built_at = now if now is not None else time.time()
    telemetry_p = Path(telemetry_path) if telemetry_path is not None else resolve_telemetry_path()

    # The condition manifest is the single source for run/conditions/timeline/
    # spans/cost/completeness (it is itself fail-closed on an unknown run). Never
    # probe external tools here — diagnose is about the run, not the host toolchain.
    condition = build_condition_manifest(
        store,
        run_id=run_id,
        telemetry_path=telemetry_p,
        operator_secret=operator_secret,
        now=built_at,
        probe_external_tools=False,
        require_complete=False,
    )

    governance, governance_reason, governance_truncated = _read_governance_decisions(telemetry_p, run_id)
    spans = _organize_spans(condition.get("telemetry_spans"))

    # Completeness merges the condition's telemetry status with the governance read.
    # ``or {}``/``or []`` tolerate an explicitly-null section (not just a missing key).
    cond_complete = condition.get("completeness") or {}
    missing = list(cond_complete.get("missing") or [])
    if governance is None:
        missing.append({"source": "governance_decisions", "reason": governance_reason or "unavailable"})
    if governance_truncated:
        # Silent truncation would forge a "complete" answer — drop to incomplete.
        missing.append({"source": "governance_decisions", "reason": "truncated_over_cap"})
    status = "complete" if not missing else "incomplete"
    if require_complete and status != "complete":
        raise ExportError(
            "diagnostic bundle is incomplete and --require-complete was set: "
            + ", ".join(f"{m.get('source', '?')}({m.get('reason', '?')})" for m in missing)
        )

    try:
        run_section = condition.get("run") or {}
        hints = _root_cause_hints(
            run_status=run_section.get("status"),
            spans=spans,
            governance=governance,
            governance_truncated=governance_truncated,
            completeness_status=status,
        )
        bundle: dict[str, Any] = {
            "_meta": _meta_block(built_at),
            "run": run_section,
            "execution_parameters": condition.get("execution_parameters"),
            "identifiers": condition.get("identifiers"),
            "spans": spans,
            "governance_decisions": governance,
            "timeline": condition.get("lifecycle_events"),
            "cost": condition.get("cost_summary"),
            "root_cause_hints": hints,
            "host": {
                "version_contract": condition.get("version_contract"),
                "dependencies": condition.get("dependencies"),
                "environment_fingerprint": condition.get("environment_fingerprint"),
            },
            "sources": condition.get("sources"),
            "completeness": {"status": status, "missing": missing},
        }
    except Exception as exc:  # noqa: BLE001 - fail-closed: never leak a raw traceback
        # ``from None`` severs the __cause__ chain so a caller that prints the
        # exception can't surface the original traceback (type name only).
        raise ExportError(
            f"failed to assemble diagnostic bundle for {run_id!r} ({type(exc).__name__})"
        ) from None
    return bundle


__all__ = [
    "DIAGNOSTIC_BUNDLE_SCHEMA_VERSION",
    "build_diagnostic_bundle",
]
