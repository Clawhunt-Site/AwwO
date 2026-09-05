"""PR1 — Goal Mode lifecycle ledger (docs/goal-mode-design.md §5).

Covers the durable GoalRecord ledger that grafts codex's goal status machine onto
super's ``goals`` table: the additive schema migration (legacy rows preserved),
the GoalRecord round-trip, the optimistic-concurrency (revision CAS) guard, and the
fail-closed status-transition validation.
"""

import json
import sqlite3

import pytest

from superclaw.models import (
    GoalRecord,
    GoalSpec,
    GoalStatus,
    is_valid_goal_status_transition,
)
from superclaw.state import GoalRevisionConflict, StateStore


def _spec(title: str = "ship feature") -> GoalSpec:
    return GoalSpec(title=title, description="do the thing")


# --- status machine (model single source) ----------------------------------


def test_status_transition_guard_allows_lifecycle_and_blocks_shortcuts():
    # draft -> awaiting_confirmation -> active is the legal path; replan rollback
    # (awaiting_confirmation -> draft) is allowed.
    assert is_valid_goal_status_transition("draft", "awaiting_confirmation")
    assert is_valid_goal_status_transition("awaiting_confirmation", "active")
    assert is_valid_goal_status_transition("awaiting_confirmation", "draft")
    # budget_limited only returns to active (the human-override path).
    assert is_valid_goal_status_transition("budget_limited", "active")
    # No draft -> complete shortcut; completion only from active.
    assert not is_valid_goal_status_transition("draft", "complete")
    assert is_valid_goal_status_transition("active", "complete")
    # Terminal states are absorbing.
    assert not is_valid_goal_status_transition("complete", "active")
    assert not is_valid_goal_status_transition("cancelled", "active")
    # Self-transition always allowed (idempotent saves).
    assert is_valid_goal_status_transition("active", "active")


def test_goal_record_round_trips_all_lifecycle_fields():
    record = GoalRecord(
        spec=_spec(),
        status=GoalStatus.AWAITING_CONFIRMATION.value,
        revision=3,
        plan={"topology": "linear", "slots": []},
        roster={"entries": [{"source": "backend", "backend": "claude"}]},
        budget_policy={"max_tokens": 10000},
        usage_rollup={"tokens": 42},
        completion_gate={"root_issue_id": "issue_1"},
        plan_hash="ph",
        roster_hash="rh",
        confirmation_nonce="nonce",
        worktree_digest="wd",
    )
    restored = GoalRecord.from_dict(json.loads(json.dumps(record.to_dict())))
    assert restored.goal_id == record.goal_id
    assert restored.status == GoalStatus.AWAITING_CONFIRMATION.value
    assert restored.revision == 3
    assert restored.plan == {"topology": "linear", "slots": []}
    assert restored.roster_hash == "rh"
    assert restored.worktree_digest == "wd"
    assert restored.completion_gate == {"root_issue_id": "issue_1"}


# --- create / get / list ----------------------------------------------------


def test_create_and_get_goal_record(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    fetched = store.get_goal_record(record.goal_id)
    assert fetched.goal_id == record.goal_id
    assert fetched.status == GoalStatus.DRAFT.value
    assert fetched.revision == 0


def test_create_goal_record_fails_closed_on_duplicate(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    with pytest.raises(ValueError, match="already exists"):
        store.create_goal_record(record)


def test_get_missing_goal_record_raises_keyerror(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    with pytest.raises(KeyError):
        store.get_goal_record("goal_does_not_exist")


def test_create_goal_record_rejects_non_draft_initial_status(tmp_path):
    # The status machine is enforced at CREATE, not only at update: a public write
    # 口 must not be able to mint an active/complete/arbitrary goal and bypass the
    # transition guard.
    store = StateStore(tmp_path / "superclaw.db")
    with pytest.raises(ValueError, match="must be created in 'draft'"):
        store.create_goal_record(GoalRecord.new(_spec(), status=GoalStatus.ACTIVE.value))
    with pytest.raises(ValueError, match="must be created in 'draft'"):
        store.create_goal_record(GoalRecord.new(_spec(), status=GoalStatus.COMPLETE.value))


def test_create_goal_record_rejects_nonzero_initial_revision(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    record.revision = 7
    with pytest.raises(ValueError, match="must start at revision 0"):
        store.create_goal_record(record)


def test_list_goal_records_filters_by_status(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    draft = GoalRecord.new(_spec("draft one"))
    store.create_goal_record(draft)
    moved = GoalRecord.new(_spec("moved one"))
    store.create_goal_record(moved)
    moved.status = GoalStatus.AWAITING_CONFIRMATION.value
    moved.revision = 1
    store.update_goal_record(moved, expected_revision=0)
    all_records = store.list_goal_records()
    assert {r.goal_id for r in all_records} == {draft.goal_id, moved.goal_id}
    only_awaiting = store.list_goal_records(
        statuses={GoalStatus.AWAITING_CONFIRMATION.value}
    )
    assert [r.goal_id for r in only_awaiting] == [moved.goal_id]


# --- revision CAS (optimistic concurrency) ----------------------------------


def test_update_goal_record_cas_success_and_transition(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    record.revision = 1
    store.update_goal_record(record, expected_revision=0)
    fetched = store.get_goal_record(record.goal_id)
    assert fetched.status == GoalStatus.AWAITING_CONFIRMATION.value
    assert fetched.revision == 1


def test_update_goal_record_stale_revision_raises_conflict(tmp_path):
    # Two surfaces (e.g. two browser tabs) both read revision 0; the first write
    # wins, the second must fail closed instead of clobbering it.
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)

    first = store.get_goal_record(record.goal_id)
    second = store.get_goal_record(record.goal_id)

    first.status = GoalStatus.AWAITING_CONFIRMATION.value
    first.revision = 1
    store.update_goal_record(first, expected_revision=0)

    second.status = GoalStatus.CANCELLED.value
    second.revision = 1
    with pytest.raises(GoalRevisionConflict):
        store.update_goal_record(second, expected_revision=0)
    # The losing write never landed.
    assert store.get_goal_record(record.goal_id).status == GoalStatus.AWAITING_CONFIRMATION.value


def test_update_goal_record_illegal_transition_raises(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    record.status = GoalStatus.BLOCKED.value  # draft -> blocked is illegal
    record.revision = 1
    with pytest.raises(ValueError, match="illegal goal status transition"):
        store.update_goal_record(record, expected_revision=0)


def test_update_goal_record_rejects_revision_rollback_and_no_bump(tmp_path):
    # Every whole-record write must bump revision by exactly one; a same-revision
    # or rolled-back write is rejected (else two readers at N both write N and the
    # second silently clobbers the first — the lost-update race).
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    # no bump: revision stays 0
    record.revision = 0
    with pytest.raises(ValueError, match="must bump revision"):
        store.update_goal_record(record, expected_revision=0)
    # jump by two
    record.revision = 2
    with pytest.raises(ValueError, match="must bump revision"):
        store.update_goal_record(record, expected_revision=0)


def test_update_goal_record_refuses_complete_write(tmp_path):
    # 'complete' is reachable only through the completion gate (PR5); the generic
    # ledger update must refuse it so no caller can self-close a goal.
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec())
    store.create_goal_record(record)
    # advance to active first (draft -> awaiting_confirmation -> active)
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    record.revision = 1
    store.update_goal_record(record, expected_revision=0)
    record.status = GoalStatus.ACTIVE.value
    record.revision = 2
    store.update_goal_record(record, expected_revision=1)
    # active -> complete is a structurally legal edge, but the write口 refuses it
    record.status = GoalStatus.COMPLETE.value
    record.revision = 3
    with pytest.raises(ValueError, match="completion gate"):
        store.update_goal_record(record, expected_revision=2)


def test_update_missing_goal_record_raises_keyerror(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    ghost = GoalRecord.new(_spec())
    ghost.revision = 1
    with pytest.raises(KeyError):
        store.update_goal_record(ghost, expected_revision=0)


# --- migration: legacy rows preserved ---------------------------------------


def test_legacy_goalspec_api_still_works_after_migration(tmp_path):
    # The historical GoalSpec API (create_goal / get_goal / list_goals) must keep
    # working — the lifecycle columns are purely additive.
    store = StateStore(tmp_path / "superclaw.db")
    spec = _spec("legacy goal")
    store.create_goal(spec)
    assert store.get_goal(spec.goal_id).title == "legacy goal"
    assert spec.goal_id in {g.goal_id for g in store.list_goals()}


def test_legacy_goal_surfaces_as_legacy_record(tmp_path):
    # A goal written via the legacy API gets a 'legacy' lifecycle status so it is
    # never mistaken for a fresh Goal-Mode draft and never enters the state machine.
    store = StateStore(tmp_path / "superclaw.db")
    spec = _spec("legacy goal")
    store.create_goal(spec)
    record = store.get_goal_record(spec.goal_id)
    assert record.status == GoalStatus.LEGACY.value
    assert record.goal_id == spec.goal_id


def test_migration_backfills_preexisting_rows(tmp_path):
    # Simulate a DB created before the lifecycle migration: a bare goals table with
    # only (goal_id, payload). Reopening through StateStore must ALTER + backfill.
    db = tmp_path / "superclaw.db"
    spec = _spec("preexisting")
    raw = sqlite3.connect(db)
    raw.execute("CREATE TABLE goals (goal_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
    raw.execute(
        "INSERT INTO goals(goal_id, payload) VALUES(?, ?)",
        (spec.goal_id, json.dumps(spec.to_dict())),
    )
    raw.commit()
    raw.close()

    store = StateStore(db)  # triggers _migrate_goals_lifecycle_columns
    columns = {row[1] for row in sqlite3.connect(db).execute("PRAGMA table_info(goals)")}
    assert {"status", "revision", "record_payload"} <= columns
    record = store.get_goal_record(spec.goal_id)
    assert record.status == GoalStatus.LEGACY.value
    assert record.spec.title == "preexisting"


def test_legacy_create_goal_does_not_clobber_lifecycle_record(tmp_path):
    # The legacy GoalSpec write path (create_goal) must never wipe the lifecycle
    # columns of a goal that was upgraded to a GoalRecord — INSERT OR REPLACE would
    # DELETE + re-INSERT and reset status/revision/record_payload.
    store = StateStore(tmp_path / "superclaw.db")
    record = GoalRecord.new(_spec("lifecycle goal"))
    store.create_goal_record(record)
    record.status = GoalStatus.AWAITING_CONFIRMATION.value
    record.revision = 1
    store.update_goal_record(record, expected_revision=0)

    # A stray legacy create_goal on the SAME goal_id (e.g. an old delivery path).
    store.create_goal(GoalSpec(title="overwritten title", description="x", goal_id=record.goal_id))

    after = store.get_goal_record(record.goal_id)
    assert after.status == GoalStatus.AWAITING_CONFIRMATION.value  # lifecycle preserved
    assert after.revision == 1
    # The legacy payload column was updated, but the lifecycle record_payload wins.
    assert after.spec.title == "lifecycle goal"


def test_legacy_record_read_is_idempotent(tmp_path):
    # Reading the same legacy goal twice must yield identical timestamps — a read
    # must not stamp time() on the fly (it would drift created_at every call).
    store = StateStore(tmp_path / "superclaw.db")
    spec = _spec("legacy goal")
    store.create_goal(spec)
    first = store.get_goal_record(spec.goal_id)
    second = store.get_goal_record(spec.goal_id)
    assert first.created_at == second.created_at == 0.0
    assert first.updated_at == second.updated_at == 0.0


def test_legacy_row_can_be_updated_to_active_lifecycle_path(tmp_path):
    # A legacy goal is inert, but the guard still applies: legacy is absorbing, so
    # an attempt to move it into the live lifecycle fails closed.
    store = StateStore(tmp_path / "superclaw.db")
    spec = _spec("legacy goal")
    store.create_goal(spec)
    record = store.get_goal_record(spec.goal_id)
    record.status = GoalStatus.ACTIVE.value
    record.revision = 1
    with pytest.raises(ValueError, match="illegal goal status transition"):
        store.update_goal_record(record, expected_revision=0)
