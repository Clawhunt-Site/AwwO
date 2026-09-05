"""Tests for the agent-runtime event bus and its StateStore integration.

Covers the phase-B foundation: the in-process doorbell (EventBus) and the
incremental, id-based read path that replaces SQLite polling on the live SSE
route.
"""

from __future__ import annotations

import threading
import time

from superclaw.agent_runtime import EventBus
from superclaw.models import GoalSpec
from superclaw.state import StateStore


def test_wait_returns_false_on_timeout_without_notify():
    bus = EventBus()
    sub = bus.subscribe("run-1")
    try:
        start = time.monotonic()
        assert sub.wait(timeout=0.1) is False
        assert time.monotonic() - start >= 0.1
    finally:
        sub.close()


def test_notify_wakes_subscriber_immediately():
    bus = EventBus()
    sub = bus.subscribe("run-1")
    try:
        bus.notify("run-1")
        # Already-pending wake returns at once, well under the timeout.
        start = time.monotonic()
        assert sub.wait(timeout=2.0) is True
        assert time.monotonic() - start < 0.5
    finally:
        sub.close()


def test_notify_coalesces_multiple_signals():
    bus = EventBus()
    sub = bus.subscribe("run-1")
    try:
        for _ in range(5):
            bus.notify("run-1")
        # First wait consumes the single coalesced token...
        assert sub.wait(timeout=1.0) is True
        # ...and there is no backlog of extra tokens.
        assert sub.wait(timeout=0.1) is False
    finally:
        sub.close()


def test_notify_only_reaches_matching_run():
    bus = EventBus()
    sub_a = bus.subscribe("run-a")
    sub_b = bus.subscribe("run-b")
    try:
        bus.notify("run-a")
        assert sub_a.wait(timeout=1.0) is True
        assert sub_b.wait(timeout=0.1) is False
    finally:
        sub_a.close()
        sub_b.close()


def test_notify_with_no_subscribers_is_noop():
    bus = EventBus()
    bus.notify("nobody")  # must not raise
    assert bus.subscriber_count("nobody") == 0


def test_close_unsubscribes():
    bus = EventBus()
    sub = bus.subscribe("run-1")
    assert bus.subscriber_count("run-1") == 1
    sub.close()
    assert bus.subscriber_count("run-1") == 0
    # close is idempotent
    sub.close()
    assert bus.subscriber_count("run-1") == 0


def test_subscription_context_manager_closes():
    bus = EventBus()
    with bus.subscribe("run-1"):
        assert bus.subscriber_count("run-1") == 1
    assert bus.subscriber_count("run-1") == 0


def test_add_event_rings_the_bus(tmp_path):
    bus = EventBus()
    store = StateStore(tmp_path / "state.db", event_bus=bus)
    sub = bus.subscribe("run-1")
    try:
        woken = threading.Event()

        def waiter():
            if sub.wait(timeout=2.0):
                woken.set()

        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.05)  # ensure the waiter is blocked before we write
        store.add_event("run-1", "message.delta", {"text": "hello"})
        t.join(timeout=2.0)
        assert woken.is_set()
    finally:
        sub.close()


def test_store_without_bus_still_works(tmp_path):
    # Backward compatibility: no bus passed -> add_event must not error.
    store = StateStore(tmp_path / "state.db")
    store.add_event("run-1", "run.started", {"ok": True})
    assert store.list_events("run-1")[0]["type"] == "run.started"


def test_list_events_after_filters_and_includes_ids(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.add_event("run-1", "a", {"i": 1})
    store.add_event("run-1", "b", {"i": 2})
    store.add_event("run-1", "c", {"i": 3})

    all_events = store.list_events_after("run-1", 0)
    assert [e["type"] for e in all_events] == ["a", "b", "c"]
    assert all(isinstance(e["id"], int) for e in all_events)
    ids = [e["id"] for e in all_events]
    assert ids == sorted(ids)

    # Incremental read: only rows after the last seen id.
    after_first = store.list_events_after("run-1", ids[0])
    assert [e["type"] for e in after_first] == ["b", "c"]
    after_last = store.list_events_after("run-1", ids[-1])
    assert after_last == []


def test_list_events_shape_unchanged(tmp_path):
    # The legacy list_events contract (type + payload, no id) is preserved.
    store = StateStore(tmp_path / "state.db")
    store.add_event("run-1", "x", {"k": "v"})
    events = store.list_events("run-1")
    assert events == [{"type": "x", "payload": {"k": "v"}}]


def test_wal_mode_enabled(tmp_path):
    import sqlite3

    db = tmp_path / "state.db"
    StateStore(db)
    conn = sqlite3.connect(db)
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        conn.close()
    assert mode.lower() == "wal"


def test_mutate_run_preserves_concurrent_execution_context_keys(tmp_path):
    store = StateStore(tmp_path / "state.db")
    goal = store.create_goal(GoalSpec(title="RMW", description="preserve context"))
    session = store.create_run(goal.goal_id)
    session.execution_context = {"base": True}
    store.save_run(session)

    ready = threading.Barrier(3)

    def write_key(key: str) -> None:
        ready.wait(timeout=2)

        def mutate(latest):
            context = dict(latest.execution_context or {})
            context[key] = True
            latest.execution_context = context
            return latest

        store.mutate_run(session.run_id, mutate)

    threads = [threading.Thread(target=write_key, args=(key,)) for key in ("left", "right")]
    for thread in threads:
        thread.start()
    ready.wait(timeout=2)
    for thread in threads:
        thread.join(timeout=2)

    context = store.get_run(session.run_id).execution_context
    assert context["base"] is True
    assert context["left"] is True
    assert context["right"] is True
