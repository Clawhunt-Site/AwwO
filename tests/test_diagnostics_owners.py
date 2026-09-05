"""§7.1 owner receipt emitters: governance decision (P0b-2)."""
from __future__ import annotations

from typing import Any

import pytest

from superclaw import diagnostics_store as ds
from superclaw.diagnostics_owners import (
    GOVERNANCE_DECISION,
    record_governance_decision,
)


class _FakeStore:
    def __init__(self, *, raise_on_critical: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any], bool]] = []
        self._raise = raise_on_critical

    def record(self, kind: str, payload: dict[str, Any] | None = None, *, critical: bool = False) -> None:
        if critical and self._raise:
            raise ds.DiagnosticPersistError("sink down")
        self.calls.append((kind, dict(payload or {}), critical))


def test_records_denied_decision_as_critical() -> None:
    store = _FakeStore()
    record_governance_decision(
        decision="denied",
        tool_name="run_shell",
        args_digest="abc123",
        reason="sticky_human_deny",
        request_id="esc_1",
        principal="local_user",
        store=store,
    )
    assert len(store.calls) == 1
    kind, payload, critical = store.calls[0]
    assert kind == GOVERNANCE_DECISION
    assert critical is True  # governance decisions are durable-or-journalled
    assert payload["decision"] == "denied"
    assert payload["tool_name"] == "run_shell"
    assert payload["args_digest"] == "abc123"  # the action HASH, never raw args
    assert payload["reason"] == "sticky_human_deny"


def test_persist_failure_never_raises() -> None:
    # Observability must never break governance: a telemetry failure is swallowed
    # (state.db remains the authoritative verdict ledger).
    store = _FakeStore(raise_on_critical=True)
    record_governance_decision(decision="allow", tool_name="run_shell", store=store)  # must not raise


def test_unexpected_store_error_never_raises(caplog: pytest.LogCaptureFixture) -> None:
    class _Broken:
        def record(self, *a: Any, **k: Any) -> None:
            raise RuntimeError("telemetry infra broken")

    with caplog.at_level("ERROR", logger="superclaw.diagnostics.owners"):
        record_governance_decision(decision="denied", tool_name="x", store=_Broken())  # must not raise
    assert any("state.db authoritative" in r.message for r in caplog.records)
