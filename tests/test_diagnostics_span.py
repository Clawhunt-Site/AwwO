"""The span() primitive: parent tracking, token reset, cross-process stitching (P0b-1b)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from superclaw import diagnostics_store as ds
from superclaw import trace_context as tc
from superclaw.diagnostics_span import SpanKind, span


class _FakeStore:
    """Deterministic in-memory sink: records (kind, payload, critical) tuples."""

    def __init__(self, *, raise_on_critical: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any], bool]] = []
        self._raise_on_critical = raise_on_critical

    def record(self, kind: str, payload: dict[str, Any] | None = None, *, critical: bool = False) -> None:
        if critical and self._raise_on_critical:
            raise ds.DiagnosticPersistError("injected critical failure")
        self.calls.append((kind, dict(payload or {}), critical))


def _payload(store: _FakeStore, kind: str) -> dict[str, Any]:
    return next(p for k, p, _ in store.calls if k == kind)


# -- lifecycle receipts ----------------------------------------------------


def test_span_records_start_and_end() -> None:
    store = _FakeStore()
    with span("config.resolve", kind=SpanKind.CONFIG, store=store) as handle:
        assert tc.get("span_id") == handle.span_id  # span_id is bound inside the block
    kinds = [k for k, _, _ in store.calls]
    assert kinds == ["span.start", "span.end"]
    start = _payload(store, "span.start")
    assert start["name"] == "config.resolve"
    assert start["span_kind"] == "config"
    end = _payload(store, "span.end")
    assert "duration_ms" in end


def test_span_id_is_reset_after_block() -> None:
    store = _FakeStore()
    assert tc.get("span_id") is None
    with span("x", kind=SpanKind.TOOL, store=store):
        assert tc.get("span_id") is not None
    assert tc.get("span_id") is None  # token reset restores prior (None)
    assert tc.get("parent_span_id") is None


def test_nested_span_parent_is_outer_span_id() -> None:
    store = _FakeStore()
    with span("outer", kind=SpanKind.ORCHESTRATION, store=store) as outer:
        with span("inner", kind=SpanKind.TOOL, store=store) as inner:
            assert inner.parent_span_id == outer.span_id
            assert tc.get("parent_span_id") == outer.span_id
        # After inner exits, the outer values are restored exactly.
        assert tc.get("span_id") == outer.span_id
    inner_start = next(p for k, p, _ in store.calls if k == "span.start" and p["name"] == "inner")
    assert inner_start["parent_span_id"] == outer.span_id
    outer_start = next(p for k, p, _ in store.calls if k == "span.start" and p["name"] == "outer")
    assert "parent_span_id" not in outer_start  # root span has no parent


def test_span_error_records_error_receipt_and_reraises() -> None:
    store = _FakeStore()
    with pytest.raises(ValueError, match="boom"):
        with span("risky", kind=SpanKind.BACKEND, store=store):
            raise ValueError("boom")
    kinds = [k for k, _, _ in store.calls]
    assert kinds == ["span.start", "span.error"]  # no span.end on the error path
    err = _payload(store, "span.error")
    assert err["error_type"] == "ValueError"
    assert err["error"] == "boom"
    assert "duration_ms" in err


def test_span_handle_attributes_merged_into_end() -> None:
    store = _FakeStore()
    with span("t", kind=SpanKind.TOOL, store=store) as handle:
        handle.set("exit_code", 0)
        handle.update(result="ok")
    end = _payload(store, "span.end")
    assert end["attributes"] == {"exit_code": 0, "result": "ok"}
    start = _payload(store, "span.start")
    assert "attributes" not in start  # attributes set during the block ride the end receipt


def test_critical_span_propagates_persist_error() -> None:
    store = _FakeStore(raise_on_critical=True)
    with pytest.raises(ds.DiagnosticPersistError):
        with span("gov.deny", kind=SpanKind.GOVERNANCE, critical=True, store=store):
            pass  # the span.start critical write fails → caller must fail-closed


def test_error_receipt_failure_does_not_mask_original_exception() -> None:
    # A failing error-receipt write must not shadow the in-flight business exception.
    class _StartOkThenFail:
        def __init__(self) -> None:
            self.n = 0

        def record(self, kind: str, payload: Any = None, *, critical: bool = False) -> None:
            self.n += 1
            if self.n > 1:  # fail on span.error
                raise ds.DiagnosticPersistError("sink down")

    with pytest.raises(ValueError, match="original"):
        with span("x", kind=SpanKind.TOOL, store=_StartOkThenFail()):
            raise ValueError("original")


def test_critical_error_receipt_failure_does_not_mask_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A critical span whose span.error write fails must still surface the ORIGINAL
    # business exception (not the persist error) AND log a span-level degradation.
    class _StartOkThenFail:
        def __init__(self) -> None:
            self.n = 0

        def record(self, kind: str, payload: Any = None, *, critical: bool = False) -> None:
            self.n += 1
            if self.n > 1:
                raise ds.DiagnosticPersistError("sink down")

    with caplog.at_level("ERROR", logger="superclaw.diagnostics.span"):
        with pytest.raises(ValueError, match="boom"):
            with span("gov.deny", kind=SpanKind.GOVERNANCE, critical=True, store=_StartOkThenFail()):
                raise ValueError("boom")
    assert any("critical span.error receipt failed to persist" in r.message for r in caplog.records)


def test_span_ids_reset_after_exception() -> None:
    store = _FakeStore()
    assert tc.get("span_id") is None
    with pytest.raises(ValueError):
        with span("x", kind=SpanKind.TOOL, store=store):
            assert tc.get("span_id") is not None
            raise ValueError("e")
    # Even on the exception path, the ContextVar tokens are reset.
    assert tc.get("span_id") is None
    assert tc.get("parent_span_id") is None


# -- cross-process stitching ----------------------------------------------


def test_child_root_span_parent_is_inherited_parent_span_id() -> None:
    store = _FakeStore()
    # Simulate a child process that imported parent_span_id from env (span_id unset).
    with tc.bind(trace_id="trace_x", parent_span_id="span_parent"):
        assert tc.get("span_id") is None
        with span("backend.run", kind=SpanKind.BACKEND, store=store) as handle:
            # The child's fresh root span continues under the inherited parent.
            assert handle.parent_span_id == "span_parent"
    start = _payload(store, "span.start")
    assert start["parent_span_id"] == "span_parent"


# -- end-to-end through the real engine ------------------------------------


def _read(path: Path) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM receipts ORDER BY id")]
    finally:
        conn.close()


def test_span_persists_through_real_store(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="trace_e2e", run_id="run_e2e"):
            with span("state.transition", kind=SpanKind.STATE, critical=True, store=store):
                pass
        rows = _read(path)
        kinds = [r["kind"] for r in rows]
        assert "span.start" in kinds and "span.end" in kinds
        start = next(r for r in rows if r["kind"] == "span.start")
        assert start["trace_id"] == "trace_e2e"
        assert start["run_id"] == "run_e2e"
        assert start["span_id"]  # the bound span_id is captured on the receipt
        payload = json.loads(start["payload"])
        assert payload["name"] == "state.transition"
    finally:
        store.close()
