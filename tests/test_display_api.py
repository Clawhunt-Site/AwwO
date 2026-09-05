"""PR-4 API wire-contract tests: the snapshot endpoint + SSE event.id + the
terminate-by-status close. These lock the HTTP/SSE shape the front-end reducer
(PR-5/PR-6) consumes, beyond the StateStore-level tests in
``test_display_persistence``.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import GoalSpec
from superclaw.state import StateStore


def test_snapshot_endpoint_excludes_deltas_and_stamps_sqlite_ids(tmp_path):
    db = tmp_path / "state.db"
    # Seed a run + events directly on the same DB file the app will open.
    store = StateStore(db)
    goal = store.create_goal(GoalSpec(title="Display", description="api"))
    run = store.create_run(goal.goal_id)
    store.add_event(run.run_id, "tool.started", {"k": 1})
    store.add_event(run.run_id, "tool.delta", {"chunk": "x"})
    store.add_event(run.run_id, "message.delta", {"text": "y"})
    store.add_event(run.run_id, "tool.completed", {"k": 2})

    client = TestClient(create_app(state_path=db))
    resp = client.get(f"/api/runs/{run.run_id}/events/snapshot")
    assert resp.status_code == 200
    body = resp.json()

    types = [e["type"] for e in body["events"]]
    assert types == ["tool.started", "tool.completed"]  # *.delta excluded (A2)
    assert body["event_count"] == 2
    assert body["run_id"] == run.run_id
    assert body["latest_event"]["type"] == "tool.completed"
    for event in body["events"]:
        assert isinstance(event["id"], int)
        # The durable SQLite id is stamped into the payload + tagged sqlite (DL5/T2).
        assert event["payload"]["id"] == event["id"]
        assert event["payload"]["id_source"] == "sqlite"


def test_snapshot_endpoint_404_for_unknown_run(tmp_path):
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    assert client.get("/api/runs/nope/events/snapshot").status_code == 404


def test_sse_events_emit_id_lines_and_sqlite_id_source(tmp_path):
    # A dry-run completes synchronously -> terminal -> the SSE closes, so we can
    # read the whole stream.
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    goal = client.post("/api/goals", json={"title": "Ship", "description": "Build"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    stream = client.get(f"/api/runs/{run['run_id']}/events")
    assert stream.status_code == 200
    text = stream.text
    assert "event: run.completed" in text
    assert "\nid: " in text or text.startswith("id: ")  # SSE id line present (T2)
    assert '"id_source": "sqlite"' in text  # durable id stamped into payload


def test_sse_closes_on_terminal_status_without_terminal_event(tmp_path):
    # G1: a run whose STATUS is terminal but which has NO run.* terminal event
    # (safe-write may drop it) must still close the SSE — never hang. The bounded
    # wait makes this take ~1s, not forever.
    db = tmp_path / "state.db"
    store = StateStore(db)
    goal = store.create_goal(GoalSpec(title="Display", description="g1"))
    run = store.create_run(goal.goal_id)
    store.add_event(run.run_id, "tool.started", {"k": 1})
    store.add_event(run.run_id, "tool.completed", {"k": 2})
    session = store.get_run(run.run_id)
    session.status = "failed"  # terminal status (created->failed is valid), NO run.* event
    store.save_run(session)

    client = TestClient(create_app(state_path=db))
    stream = client.get(f"/api/runs/{run.run_id}/events")  # must return, not hang
    assert stream.status_code == 200
    assert "event: tool.completed" in stream.text
    assert "event: run.failed" not in stream.text  # there genuinely was none


def test_sse_delivers_trailing_terminal_event(tmp_path):
    # The run flow commits terminal STATUS before the run.* terminal event; the
    # bounded tail-poll must still deliver that trailing event, not miss it (G1
    # without losing the tail).
    db = tmp_path / "state.db"
    store = StateStore(db)
    goal = store.create_goal(GoalSpec(title="Display", description="tail"))
    run = store.create_run(goal.goal_id)
    store.add_event(run.run_id, "tool.completed", {"k": 1})
    session = store.get_run(run.run_id)
    session.status = "failed"
    store.save_run(session)
    store.add_event(run.run_id, "run.failed", {"status": "failed"})  # trailing terminal event

    import time as _t

    client = TestClient(create_app(state_path=db))
    start = _t.monotonic()
    stream = client.get(f"/api/runs/{run.run_id}/events")
    elapsed = _t.monotonic() - start
    assert stream.status_code == 200
    assert "event: run.failed" in stream.text  # delivered by the bounded tail-poll
    assert "event: tool.completed" in stream.text
    assert '"id_source": "sqlite"' in stream.text
    # Terminal event was already in the backfill -> early-exit, no ~1s poll wait.
    assert elapsed < 0.7


def test_sse_bounded_poll_catches_event_committed_after_status(tmp_path):
    # The actual stale-token race (Codex r2/r3): the SSE sees terminal STATUS with
    # NO terminal event in the backfill, and the trailing run.* event is committed
    # shortly AFTER. The bounded tail-poll (active re-read, not a single doorbell
    # token) must catch it and close well under the 1s bound.
    import threading
    import time as _t

    db = tmp_path / "state.db"
    store = StateStore(db)
    goal = store.create_goal(GoalSpec(title="Display", description="race"))
    run = store.create_run(goal.goal_id)
    store.add_event(run.run_id, "tool.completed", {"k": 1})
    session = store.get_run(run.run_id)
    session.status = "failed"  # terminal status visible; NO run.failed yet
    store.save_run(session)

    def _late_writer():
        _t.sleep(0.15)
        StateStore(db).add_event(run.run_id, "run.failed", {"status": "failed"})

    writer = threading.Thread(target=_late_writer)
    writer.start()
    try:
        client = TestClient(create_app(state_path=db))
        start = _t.monotonic()
        stream = client.get(f"/api/runs/{run.run_id}/events")
        elapsed = _t.monotonic() - start
    finally:
        writer.join()
    assert stream.status_code == 200
    assert "event: run.failed" in stream.text  # caught by the active bounded poll
    assert elapsed < 0.9  # broke early on catch, did not exhaust the 1s bound


def test_sse_final_read_catches_event_committed_during_last_sleep(tmp_path, monkeypatch):
    # The last-window blind spot (Codex r4): an event committed during the FINAL
    # poll sleep — after the last read, before close — must still be delivered by
    # the for/else final read. Deterministic (no flaky wall-clock): commit the
    # terminal event exactly on the 20th (last) sleep, so ONLY the final read can
    # catch it. A naive "sleep then break" would miss it.
    import apps.api.main as main_mod

    db = tmp_path / "state.db"
    store = StateStore(db)
    goal = store.create_goal(GoalSpec(title="Display", description="lastwin"))
    run = store.create_run(goal.goal_id)
    store.add_event(run.run_id, "tool.completed", {"k": 1})
    session = store.get_run(run.run_id)
    session.status = "failed"  # terminal status; NO run.failed in backfill
    store.save_run(session)

    calls = {"n": 0}

    def fake_sleep(_secs):  # no real wait; commit on the final sleep
        calls["n"] += 1
        if calls["n"] == 20:
            StateStore(db).add_event(run.run_id, "run.failed", {"status": "failed"})

    monkeypatch.setattr(main_mod.time, "sleep", fake_sleep)

    stream = TestClient(create_app(state_path=db)).get(f"/api/runs/{run.run_id}/events")
    assert stream.status_code == 200
    assert "event: run.failed" in stream.text  # delivered ONLY by the for/else final read
    assert calls["n"] == 20  # the loop genuinely exhausted (event arrived on the last sleep)
