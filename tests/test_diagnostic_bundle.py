"""Diagnostic context bundle (P2a): span tree + timeline + governance decisions +
root-cause hints + honest replay-unavailable contract + redaction sentinel."""
from __future__ import annotations

import json

import pytest

from superclaw import diagnostic_bundle as db
from superclaw import diagnostics_store as ds
from superclaw import trace_context as tc
from superclaw.operator_export import ExportError
from superclaw.state import StateStore


def _store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _make_run(store, *, status="failed"):
    session = store.create_run("goal_diag")
    session.status = status
    session.execution_context = {
        "backend_policy": "claude",
        "model": "claude-opus-4-8",
        "budget_seconds": 60,
        "principal": "SENTINEL_PRINCIPAL",
        "repo_path": "/Users/secret/SENTINEL_REPO",
        "agent_run_context": {"charter": "SENTINEL_CHARTER"},
    }
    store.save_run(session)
    store.add_event(session.run_id, "run.queued", {"goal_id": "goal_diag", "status": "queued"})
    store.add_event(session.run_id, "run.failed", {"status": status, "text": "SENTINEL_OUTPUT"})
    return session.run_id


def _record_telemetry(tele_path, run_id, *, with_governance=True, with_error=True):
    from superclaw import diagnostics_span as dspan
    from superclaw.diagnostics_span import SpanKind

    store = ds.DiagnosticsStore(tele_path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="trace_d", run_id=run_id):
            # A real span via the span() primitive emits start+end sharing one span_id.
            with dspan.span("worker.tool", kind=SpanKind.TOOL, critical=True, store=store):
                pass
            if with_error:
                # An error span emits start+error sharing one span_id; the original
                # exception always propagates.
                try:
                    with dspan.span("config.resolve", kind=SpanKind.CONFIG, critical=True, store=store):
                        raise ValueError("SENTINEL_ERROR_TEXT")
                except ValueError:
                    pass
            if with_governance:
                from superclaw import diagnostics_owners as owners

                owners.record_governance_decision(
                    decision="denied",
                    tool_name="Bash",
                    reason="fail_closed",
                    request_id="esc_123",
                    store=store,
                )
    finally:
        store.close()


def test_bundle_basic_structure_and_honest_contract(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    _record_telemetry(tele, run_id)
    bundle = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele, now=42.0)

    meta = bundle["_meta"]
    assert meta["kind"] == "run_diagnostic"
    assert meta["mode"] == "diagnostic_context"
    assert meta["decision_replay"] == "unavailable"
    assert meta["decision_replay_reason"] == "tier_c_recording_absent"
    assert meta["built_at"] == 42.0
    assert bundle["run"]["run_id"] == run_id
    assert bundle["completeness"]["status"] == "complete"


def test_span_tree_organized_by_span_id(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    _record_telemetry(tele, run_id)
    bundle = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)
    spans = bundle["spans"]
    # Two spans: a successful tool span (start+end merge → duration) and an error
    # config span (start+error merge → error_type), each one node per span_id.
    assert len(spans) == 2
    by_name = {s["name"]: s for s in spans}
    tool = by_name["worker.tool"]
    assert tool["span_kind"] == "tool"
    assert tool["duration_ms"] is not None
    assert tool["has_error"] is False
    cfg = by_name["config.resolve"]
    assert cfg["span_kind"] == "config"
    assert cfg["has_error"] is True
    assert cfg["error_type"] == "ValueError"


def test_governance_decisions_surfaced(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    _record_telemetry(tele, run_id)
    decisions = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)["governance_decisions"]
    assert decisions is not None and len(decisions) == 1
    assert decisions[0]["decision"] == "denied"
    assert decisions[0]["tool_name"] == "Bash"
    assert decisions[0]["reason"] == "fail_closed"


def test_root_cause_hints_derived(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store, status="failed")
    tele = tmp_path / "telemetry.db"
    _record_telemetry(tele, run_id)
    hints = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)["root_cause_hints"]
    by_code = {h["code"]: h for h in hints}
    assert "run_terminal_not_done" in by_code
    assert "governance_denied" in by_code
    assert "span_error" in by_code
    # The "why" survives as structured fields + a trusted note (NOT a whitespace
    # sentence that _scrub_scalar would collapse to "<redacted>").
    assert by_code["run_terminal_not_done"]["fields"]["status"] == "failed"
    assert by_code["governance_denied"]["fields"]["tool"] == "Bash"
    assert by_code["governance_denied"]["fields"]["reason"] == "fail_closed"
    assert by_code["span_error"]["fields"]["error_type"] == "ValueError"
    assert by_code["span_error"]["note"]  # trusted static human note present
    assert "<redacted>" not in json.dumps(hints)


def test_redaction_sentinel_no_cleartext(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    _record_telemetry(tele, run_id)
    bundle = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)
    blob = json.dumps(bundle)
    for leaked in (
        "SENTINEL_PRINCIPAL",
        "SENTINEL_REPO",
        "SENTINEL_CHARTER",
        "SENTINEL_OUTPUT",
        "SENTINEL_ERROR_TEXT",  # span error message free text must not survive
    ):
        assert leaked not in blob, f"cleartext leak: {leaked}"
    # identifiers are present as fingerprints
    assert bundle["identifiers"]["principal_fp"] is not None


def test_governance_field_path_freetext_is_scrubbed(tmp_path):
    """tool_name/reason come from a producer API that accepts arbitrary strings;
    redact() alone won't block a path/free-text — the P1 guard must."""
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    tstore = ds.DiagnosticsStore(tele, install_signal_handlers=False)
    try:
        from superclaw import diagnostics_owners as owners

        with tc.bind(trace_id="t", run_id=run_id):
            owners.record_governance_decision(
                decision="denied",
                tool_name="/Users/secret/SENTINEL_TOOLPATH",
                reason="free text with SENTINEL_REASON inside",
                store=tstore,
            )
    finally:
        tstore.close()
    decisions = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)["governance_decisions"]
    blob = json.dumps(decisions)
    assert "SENTINEL_TOOLPATH" not in blob  # path → <path-redacted>
    assert "SENTINEL_REASON" not in blob  # whitespace free text → <redacted>
    assert decisions[0]["tool_name"] == "<path-redacted>"
    assert decisions[0]["reason"] == "<redacted>"


def test_governance_secret_pattern_is_redacted(tmp_path):
    """Guards _gov_field's redact() layer too — a secret token in reason/escalation
    id must not survive (so nobody later deletes _gov_field thinking it's redundant)."""
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    tstore = ds.DiagnosticsStore(tele, install_signal_handlers=False)
    try:
        from superclaw import diagnostics_owners as owners

        with tc.bind(trace_id="t", run_id=run_id):
            owners.record_governance_decision(
                decision="denied",
                tool_name="Bash",
                reason="ghp_SENTINELSECRETabcdefghijklmnopqrstuvwx",
                request_id="sk-SENTINELESCALATIONabcdefghij",
                store=tstore,
            )
    finally:
        tstore.close()
    decisions = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)["governance_decisions"]
    blob = json.dumps(decisions)
    assert "ghp_SENTINELSECRET" not in blob
    assert "sk-SENTINELESCALATION" not in blob


def test_governance_truncation_marks_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_MAX_GOVERNANCE", 2)
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele = tmp_path / "telemetry.db"
    tstore = ds.DiagnosticsStore(tele, install_signal_handlers=False)
    try:
        from superclaw import diagnostics_owners as owners

        with tc.bind(trace_id="t", run_id=run_id):
            for _ in range(5):  # > cap of 2
                owners.record_governance_decision(
                    decision="allow", tool_name="Read", store=tstore
                )
    finally:
        tstore.close()
    bundle = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele)
    assert len(bundle["governance_decisions"]) == 2  # capped
    assert bundle["completeness"]["status"] == "incomplete"  # not a silent truncation
    reasons = {m["reason"] for m in bundle["completeness"]["missing"]}
    assert "truncated_over_cap" in reasons
    assert "governance_truncated" in {h["code"] for h in bundle["root_cause_hints"]}
    # require_complete must FAIL when truncated, never forge "complete".
    with pytest.raises(ExportError):
        db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tele, require_complete=True)


def test_telemetry_absent_is_incomplete_not_failure(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    bundle = db.build_diagnostic_bundle(store, run_id=run_id, telemetry_path=tmp_path / "absent.db")
    assert bundle["completeness"]["status"] == "incomplete"
    sources = {m["source"] for m in bundle["completeness"]["missing"]}
    assert "telemetry_db" in sources and "governance_decisions" in sources
    assert bundle["governance_decisions"] is None
    codes = {h["code"] for h in bundle["root_cause_hints"]}
    assert "diagnostic_context_incomplete" in codes


def test_require_complete_raises_on_missing_telemetry(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    with pytest.raises(ExportError):
        db.build_diagnostic_bundle(
            store, run_id=run_id, telemetry_path=tmp_path / "absent.db", require_complete=True
        )


def test_run_not_found_fails_closed(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(ExportError):
        db.build_diagnostic_bundle(store, run_id="run_nope")
