"""Tests for the run-layer cost ledger — the foundation that unifies Chat and
Team cost governance. The single-point acceptance: every backend worker turn
ends with one idempotent, queryable CostEvent.
"""

import pytest

from superclaw.backends import _extract_cost_snapshot
from superclaw.models import CostEvent, CostSnapshot
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- ledger primitive -----------------------------------------------------


def test_list_cost_events_after_seq_is_monotonic_by_insertion(store):
    # The rowid cursor used by telemetry upload: returns rows inserted AFTER a
    # given seq in insertion order, regardless of occurred_at. A backfilled event
    # with an ancient timestamp still appears (higher seq), and a future-dated
    # one does not strand later inserts.
    store.record_cost_event(CostEvent(idempotency_key="a", run_id="rA", occurred_at=200.0))
    store.record_cost_event(CostEvent(idempotency_key="b", run_id="rB", occurred_at=300.0))
    first = store.list_cost_events_after_seq(0)
    assert [e.run_id for _s, e in first] == ["rA", "rB"]
    seq_after_two = first[-1][0]

    # Backfill an ancient-timestamp event and a future-dated one.
    store.record_cost_event(CostEvent(idempotency_key="old", run_id="rOLD", occurred_at=1.0))
    store.record_cost_event(CostEvent(idempotency_key="fut", run_id="rFUT", occurred_at=5e9))
    after = store.list_cost_events_after_seq(seq_after_two)
    assert [e.run_id for _s, e in after] == ["rOLD", "rFUT"]  # both seen, in insert order
    assert [s for s, _e in after] == sorted(s for s, _e in after)  # seqs strictly increase
    assert len(store.list_cost_events_after_seq(0, limit=1)) == 1

    # max_cost_event_seq + until_seq bound the streaming spooler's per-tick window.
    assert store.max_cost_event_seq() == 4
    windowed = store.list_cost_events_after_seq(0, until_seq=2)
    assert [e.run_id for _s, e in windowed] == ["rA", "rB"]  # excludes seq>2 (rOLD/rFUT)
    assert store.list_cost_events_after_seq(0, limit=10, until_seq=3)[-1][0] == 3

    # INSERT OR IGNORE (duplicate idempotency_key) must NOT churn the seq space:
    # an ignored insert allocates no rowid, so the cursor is undisturbed.
    max_seq = store.list_cost_events_after_seq(0)[-1][0]
    assert store.record_cost_event(CostEvent(idempotency_key="a", run_id="dupe")) is False
    assert store.list_cost_events_after_seq(max_seq) == []  # no new seq created


def test_max_cost_event_seq_empty_ledger(store):
    assert store.max_cost_event_seq() == 0  # empty ledger → 0, never None


def test_cost_events_delete_is_aborted_by_db_trigger(store):
    # PRIMARY, unbypassable enforcement of the append-only invariant: the
    # BEFORE-DELETE trigger aborts ANY delete at the DB layer (regardless of how
    # the SQL was built — ORM/string-concat/truncate). This is what guarantees
    # the telemetry rowid cursor never skips a reused rowid.
    import sqlite3

    store.record_cost_event(CostEvent(idempotency_key="k", run_id="r"))
    with store._connect() as conn:  # noqa: SLF001 - white-box invariant check
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM cost_events WHERE idempotency_key = 'k'")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM cost_events")  # WHERE-less truncate also aborts
    # the row is still there — nothing was deleted
    assert any(e.run_id == "r" for _s, e in store.list_cost_events_after_seq(0))


def test_cost_events_is_append_only():
    # Defence-in-depth for STRUCTURAL ops the row trigger can't catch (DROP
    # TABLE drops the trigger itself). Source-scan the codebase: if anyone adds a
    # destructive cost_events op, this fails and points them at the cursor
    # coupling (see state.list_cost_events_after_seq). The DB trigger
    # (test_cost_events_delete_is_aborted_by_db_trigger) is the primary guard.
    import pathlib
    import re

    roots = [
        pathlib.Path(__file__).resolve().parents[1] / "packages/superclaw/src/superclaw",
        pathlib.Path(__file__).resolve().parents[1] / "apps",
    ]
    # cost_events preceded by any destructive verb (DELETE FROM / DROP TABLE [IF
    # EXISTS] / TRUNCATE [TABLE]), tolerating IF EXISTS / TABLE keywords between.
    pattern = re.compile(
        r"(DELETE\s+FROM|DROP\s+TABLE(\s+IF\s+EXISTS)?|TRUNCATE(\s+TABLE)?)\s+cost_events",
        re.IGNORECASE,
    )
    offenders = []
    for root in roots:
        for py in root.rglob("*.py"):
            text = py.read_text(encoding="utf-8")
            # Skip this very test file's own pattern string if it lived here.
            if pattern.search(text):
                offenders.append(str(py.relative_to(root.parents[0])))
    assert not offenders, (
        "cost_events must stay append-only — the telemetry rowid cursor depends "
        f"on it (see state.list_cost_events_after_seq). Destructive SQL found in: {offenders}"
    )


def test_record_cost_event_is_idempotent(store):
    e1 = CostEvent(idempotency_key="k1", run_id="run_1", input_tokens=10, output_tokens=5, usage_status="actual")
    assert store.record_cost_event(e1) is True
    # same idempotency key -> no double count
    e2 = CostEvent(idempotency_key="k1", run_id="run_1", input_tokens=999, output_tokens=999)
    assert store.record_cost_event(e2) is False
    events = store.list_cost_events(run_id="run_1")
    assert len(events) == 1
    assert events[0].input_tokens == 10  # first write wins


def test_summarize_cost_rolls_up_by_scope(store):
    store.record_cost_event(CostEvent(idempotency_key="a", agent_profile_id="ag1", provider="anthropic", input_tokens=100, output_tokens=20, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="b", agent_profile_id="ag1", provider="anthropic", input_tokens=50, output_tokens=10, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="c", agent_profile_id="ag2", provider="openai", input_tokens=7, usage_status="actual"))
    summary = store.summarize_cost(agent_profile_id="ag1")
    assert summary["event_count"] == 2
    assert summary["input_tokens"] == 150
    assert summary["output_tokens"] == 30
    assert summary["total_tokens"] == 180
    assert summary["by_provider"]["anthropic"]["events"] == 2
    # scoping isolates ag2
    assert store.summarize_cost(agent_profile_id="ag2")["total_tokens"] == 7


def test_cost_time_window_filters_by_occurred_at(store):
    # Three events at distinct instants. The window is half-open [since, until):
    # `since` inclusive, `until` exclusive — so a boundary instant is counted at
    # most once across adjacent windows (no double-count on day rollups).
    store.record_cost_event(CostEvent(idempotency_key="t0", run_id="r", occurred_at=100.0, input_tokens=1, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="t1", run_id="r", occurred_at=200.0, input_tokens=2, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="t2", run_id="r", occurred_at=300.0, input_tokens=4, usage_status="actual"))

    mid = store.list_cost_events(run_id="r", since=200.0, until=300.0)
    assert [e.idempotency_key for e in mid] == ["t1"]  # 300 excluded by half-open upper bound
    assert {e.idempotency_key for e in store.list_cost_events(run_id="r", since=200.0)} == {"t1", "t2"}
    assert {e.idempotency_key for e in store.list_cost_events(run_id="r", until=300.0)} == {"t0", "t1"}
    # summarize_cost threads the window through to the same ledger query
    assert store.summarize_cost(run_id="r", since=200.0, until=300.0)["input_tokens"] == 2
    # no window => unchanged full rollup (backward compatible)
    assert store.summarize_cost(run_id="r")["input_tokens"] == 7


def test_list_cost_events_rejects_non_finite_window(store):
    # NaN/Inf must fail-closed: `occurred_at < NaN` silently matches zero rows in
    # SQLite, which would forge a "zero cost" answer instead of erroring.
    import math

    store.record_cost_event(CostEvent(idempotency_key="f", run_id="r", occurred_at=100.0, input_tokens=5, usage_status="actual"))
    for bad in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValueError):
            store.list_cost_events(run_id="r", since=bad)
        with pytest.raises(ValueError):
            store.list_cost_events(run_id="r", until=bad)
    # an inverted FINITE window must also fail closed at the core method — never
    # rely on the CLI/API resolver to have pre-validated; a silent empty set here
    # would forge a "zero cost" answer.
    with pytest.raises(ValueError):
        store.list_cost_events(run_id="r", since=300.0, until=200.0)
    with pytest.raises(ValueError):
        store.summarize_cost(run_id="r", since=300.0, until=200.0)
    # a finite ordered window still works
    assert len(store.list_cost_events(run_id="r", since=50.0, until=200.0)) == 1


def test_resolve_cost_window_today_is_full_calendar_day(store):
    from superclaw.state import resolve_cost_window

    # A fixed instant inside a known local day; --today must be the whole day
    # [midnight, next midnight) — excluding both the prior day and the next.
    ref = 1_700_000_000.0  # 2023-11-14T... local
    start, end = resolve_cost_window(today=True, now=ref)
    assert start is not None and end is not None
    assert start <= ref < end
    assert 23 * 3600 <= (end - start) <= 25 * 3600  # one local day (DST-tolerant)
    # mutual exclusion + bad input fail-closed (kernel raises; surfaces translate)
    for kwargs in (
        dict(today=True, since="2026-06-01"),
        dict(since="not-a-date"),
        dict(since=""),
        dict(since="2026-06-20", until="2026-06-01"),
    ):
        with pytest.raises(ValueError):
            resolve_cost_window(**kwargs)
    assert resolve_cost_window() == (None, None)


# --- byo reference pricing (USD estimate) ---------------------------------


def test_byo_lane_fills_reference_usd_estimate_from_price_table(store, monkeypatch):
    # byo lane + a configured price table => cost_cents is estimated at record
    # time so USD becomes non-zero; token counts stay the honest truth.
    monkeypatch.setenv(
        "SUPERCLAW_MODEL_PRICE_TABLE",
        '{"claude-opus-4-8": {"input_cents_per_mtok": 1500, "output_cents_per_mtok": 7500}}',
    )
    store.record_cost_event(
        CostEvent(
            idempotency_key="byo1", agent_profile_id="ag1", model="claude-opus-4-8",
            input_tokens=1_000_000, output_tokens=1_000_000, billing_lane="byo", usage_status="actual",
        )
    )
    [stored] = store.list_cost_events(agent_profile_id="ag1")
    assert stored.cost_cents == 1500 + 7500  # 1M in @1500/Mtok + 1M out @7500/Mtok


def test_relay_and_explicit_cost_are_never_re_estimated(store, monkeypatch):
    monkeypatch.setenv(
        "SUPERCLAW_MODEL_PRICE_TABLE",
        '{"m": {"input_cents_per_mtok": 1000, "output_cents_per_mtok": 1000}}',
    )
    # relay lane: authoritative receipt, never re-priced even when cost_cents=0.
    store.record_cost_event(
        CostEvent(idempotency_key="relay1", run_id="r", model="m", input_tokens=1_000_000,
                  billing_lane="relay", cost_cents=0, usage_status="actual")
    )
    assert store.list_cost_events(run_id="r")[0].cost_cents == 0
    # byo lane with an explicit non-zero cost is preserved, not overwritten.
    store.record_cost_event(
        CostEvent(idempotency_key="byo2", run_id="r2", model="m", input_tokens=1_000_000,
                  billing_lane="byo", cost_cents=42, usage_status="actual")
    )
    assert store.list_cost_events(run_id="r2")[0].cost_cents == 42


def test_summarize_cost_breaks_down_by_agent_and_model(store, monkeypatch):
    monkeypatch.setenv(
        "SUPERCLAW_MODEL_PRICE_TABLE",
        '{"opus": {"input_cents_per_mtok": 100, "output_cents_per_mtok": 100}}',
    )
    store.record_cost_event(CostEvent(idempotency_key="x1", company_profile_id="co", agent_profile_id="ag1",
                                      model="opus", input_tokens=1_000_000, output_tokens=0, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="x2", company_profile_id="co", agent_profile_id="ag2",
                                      model="opus", input_tokens=2_000_000, output_tokens=0, usage_status="actual"))
    s = store.summarize_cost(company_profile_id="co")
    assert s["total_cost_cents"] == 100 + 200
    assert s["by_agent"]["ag1"]["cost_cents"] == 100
    assert s["by_agent"]["ag2"]["cost_cents"] == 200
    assert s["by_model"]["opus"]["cost_cents"] == 300
    assert s["by_model"]["opus"]["events"] == 2
    assert s["by_provider"]["unknown"]["cost_cents"] == 300  # provider rollup now carries cents


def test_extract_cost_snapshot_resolves_model_from_nested_runtime_spec():
    # The model can ride the nested local_agent_runtime spec (what _runtime_extra
    # emits), not only the top-level extra — byo pricing needs it resolved.
    snap = _extract_cost_snapshot(
        backend_name="claude",
        duration=1.0,
        transcript_extra={"local_agent_runtime": {"model": "claude-opus-4-8"}, "usage": {"input_tokens": 100}},
        status="completed",
    )
    assert snap["model"] == "claude-opus-4-8"
    # A top-level model still takes priority (the model actually used this turn).
    snap2 = _extract_cost_snapshot(
        backend_name="claude",
        duration=1.0,
        transcript_extra={"model": "top", "local_agent_runtime": {"model": "nested"}, "usage": {}},
        status="completed",
    )
    assert snap2["model"] == "top"


def test_extract_cost_snapshot_resolves_provider_from_nested_runtime_spec():
    # Regression: provider was read ONLY from the top-level key (which _runtime_extra
    # never writes), so every backend missing from _PROVIDER_BY_BACKEND (clawwork,
    # grok, cursor, …) collapsed to "unknown" even though it declared its provider in
    # the nested runtime spec. Provider must now resolve symmetrically with model.
    snap = _extract_cost_snapshot(
        backend_name="clawwork",
        duration=1.0,
        transcript_extra={"local_agent_runtime": {"provider": "clawrelay", "model": "claude-opus-4-8"}},
        status="completed",
    )
    assert snap["provider"] == "clawrelay"
    assert snap["model"] == "claude-opus-4-8"
    # A backend present in the static map keeps its NORMALISED value (the map wins
    # over the backend's finer-grained nested label, preserving existing groupings).
    snap2 = _extract_cost_snapshot(
        backend_name="codex",
        duration=1.0,
        transcript_extra={"local_agent_runtime": {"provider": "openai-codex"}},
        status="completed",
    )
    assert snap2["provider"] == "openai"
    # No mapping AND no nested provider → honest "unknown" (fail-closed, unchanged).
    snap3 = _extract_cost_snapshot(
        backend_name="mystery", duration=1.0, transcript_extra={}, status="completed"
    )
    assert snap3["provider"] == "unknown"


def test_extract_cost_snapshot_ignores_bare_usage_field_names():
    # ClawWork's bare input/output/cacheRead usage names are normalised to canonical
    # token keys at the clawwork ADAPTER boundary (ClawWorkBackend.run), NOT by the
    # generic snapshot extractor. Guard that deliberate scoping: a non-clawwork usage
    # dict whose "input" means something else must NOT be mis-counted as tokens.
    extra = {"local_agent_runtime": {"provider": "x"}, "usage": {"input": 999, "output": 7}}
    snap = _extract_cost_snapshot(backend_name="x", duration=1.0, transcript_extra=extra, status="completed")
    assert snap["input_tokens"] is None
    assert snap["output_tokens"] is None
    assert snap["usage_status"] == "unavailable"
    # Canonical token keys (what the clawwork adapter emits after normalising) ARE read.
    snap2 = _extract_cost_snapshot(
        backend_name="clawwork",
        duration=1.0,
        transcript_extra={"usage": {"input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 800}},
        status="completed",
    )
    assert snap2["input_tokens"] == 1200
    assert snap2["output_tokens"] == 300
    assert snap2["cached_input_tokens"] == 800
    assert snap2["usage_status"] == "actual"


def test_unavailable_event_is_still_recorded(store):
    # usage missing must NOT be dropped — fail-open but leave an auditable row.
    store.record_cost_event(CostEvent(idempotency_key="u", run_id="r", usage_status="unavailable", duration_seconds=1.2))
    events = store.list_cost_events(run_id="r")
    assert len(events) == 1
    assert events[0].usage_status == "unavailable"
    assert store.summarize_cost(run_id="r")["usage_status_counts"]["unavailable"] == 1


# --- backend usage extraction --------------------------------------------


def test_extract_cost_snapshot_reads_real_tokens():
    extra = {"provider": "claude-code", "model": "claude-opus-4-8", "usage": {"input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 800}}
    snap = _extract_cost_snapshot(backend_name="claude", duration=2.5, transcript_extra=extra, status="completed")
    assert snap["input_tokens"] == 1200
    assert snap["output_tokens"] == 300
    assert snap["cached_input_tokens"] == 800
    assert snap["usage_status"] == "actual"
    assert snap["meter_kind"] == "model_tokens"


def test_extract_cost_snapshot_without_usage_is_unavailable():
    snap = _extract_cost_snapshot(backend_name="codex", duration=3.0, transcript_extra={"provider": "openai"}, status="completed")
    assert snap["input_tokens"] is None
    assert snap["usage_status"] == "unavailable"
    assert snap["meter_kind"] == "wall_clock"
    assert snap["duration_seconds"] == 3.0


def test_cost_snapshot_roundtrip():
    snap = CostSnapshot(backend="claude", provider="anthropic", input_tokens=5, usage_status="actual")
    assert CostSnapshot.from_dict(snap.to_dict()).input_tokens == 5
    event = CostEvent.from_snapshot(snap, idempotency_key="x", source="delivery", run_id="r")
    assert event.provider == "anthropic"
    assert event.input_tokens == 5
    assert event.total_tokens == 5


# --- integration: a real run emits idempotent events ----------------------


def test_delivery_run_emits_one_cost_event_per_worker(tmp_path):
    orch = SuperClawOrchestrator.from_path(tmp_path / "run.db")
    res = orch.run_goal(
        title="smoke",
        description="exercise the cost ledger",
        backend_policy="local",
        dry_run=False,
        repo_path=".",
        concurrency=1,
        budget_seconds=30,
    )
    run_id = res.session.run_id
    events = orch.store.list_cost_events(run_id=run_id)
    assert len(events) >= 1, "every backend worker turn must leave a CostEvent"
    for e in events:
        assert e.source == "delivery"
        assert e.run_id == run_id
        # local backend has no token cost — recorded as not_applicable, not dropped
        assert e.usage_status == "not_applicable"
    summary = orch.store.summarize_cost(run_id=run_id)
    assert summary["event_count"] == len(events)

    # the orchestrator recorder is idempotent: emitting the SAME worker result
    # twice (retry/fallback path) collapses to one ledger row.
    before = len(orch.store.list_cost_events(run_id=run_id))
    fake_result = type(
        "R",
        (),
        {
            "cost": {"backend": "local", "provider": "local", "duration_seconds": 1.0, "usage_status": "unavailable"},
            "task_id": "task_retry",
            "attempt_index": 1,
            "backend": "local",
            "transcript_artifact_id": "fixed-transcript-id",
            "duration_seconds": 1.0,
            "exit_code": 0,
        },
    )()
    orch._record_worker_cost(res.session, fake_result)
    after_first = len(orch.store.list_cost_events(run_id=run_id))
    orch._record_worker_cost(res.session, fake_result)  # identical re-emit
    after_second = len(orch.store.list_cost_events(run_id=run_id))
    assert after_first == before + 1   # new event recorded
    assert after_second == after_first  # second identical emit deduped


def test_cost_cli_filters(store, monkeypatch):
    import json
    import time
    from typer.testing import CliRunner
    from superclaw.cli import app
    from superclaw.models import CostEvent

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(store.path))

    now = time.localtime()
    today_midnight = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, -1))

    # Seed events
    # Yesterday
    store.record_cost_event(CostEvent(idempotency_key="e_yesterday", run_id="r", occurred_at=today_midnight - 3600, input_tokens=10, usage_status="actual"))
    # Today
    store.record_cost_event(CostEvent(idempotency_key="e_today", run_id="r", occurred_at=today_midnight + 3600, input_tokens=20, usage_status="actual"))
    # Tomorrow
    store.record_cost_event(CostEvent(idempotency_key="e_tomorrow", run_id="r", occurred_at=today_midnight + 86400 + 3600, input_tokens=40, usage_status="actual"))

    runner = CliRunner()

    # 1. Test basic list (all 3)
    res = runner.invoke(app, ["cost", "list"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert len(data) == 3

    # 2. --today is the FULL calendar day [midnight, next midnight): today only,
    #    NOT tomorrow (future-dated rows are excluded, not "midnight onward").
    res = runner.invoke(app, ["cost", "list", "--today"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert {e["idempotency_key"] for e in data} == {"e_today"}

    # 3. Test mutual exclusivity with --today and --since
    res = runner.invoke(app, ["cost", "list", "--today", "--since", "2026-06-20"])
    assert res.exit_code == 1
    assert "error: --today cannot be combined with --since/--until" in res.output

    # 4. Test invalid date format
    res = runner.invoke(app, ["cost", "list", "--since", "2026/06/20"])
    assert res.exit_code == 1
    assert "error: invalid date (expected YYYY-MM-DD)" in res.output

    # 5. Test reverse bounds order
    res = runner.invoke(app, ["cost", "list", "--since", "2026-06-21", "--until", "2026-06-20"])
    assert res.exit_code == 1
    assert "error: --until must be after --since" in res.output

    # 6. Test valid date window filtering (since today_midnight to today_midnight + 86400)
    today_str = time.strftime("%Y-%m-%d", now)
    tomorrow_str = time.strftime("%Y-%m-%d", time.localtime(today_midnight + 86400 + 3600))
    res = runner.invoke(app, ["cost", "list", "--since", today_str, "--until", tomorrow_str])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert [e["idempotency_key"] for e in data] == ["e_today"]

    # 7. Test summary command with window filtering
    res = runner.invoke(app, ["cost", "summary", "--since", today_str, "--until", tomorrow_str])
    assert res.exit_code == 0
    summary = json.loads(res.output)
    assert summary["input_tokens"] == 20

