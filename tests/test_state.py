import pytest

from superclaw.models import (
    ArtifactRef,
    GoalSpec,
    PRIMARY_EVIDENCE_TEXT_LIMIT,
    PRIMARY_EVIDENCE_TRUNCATED_FINDING,
    RunMutationMode,
    VerificationFinding,
    WorkerResult,
)
from superclaw.state import StateStore


def test_append_chat_message_persists_turn_metering(tmp_path):
    # The chat surface's metering row (token usage + elapsed) is kernel-persisted
    # on the assistant ChatMessage so it survives a reload and stays identical
    # across CLI/API/Web. The store must round-trip both fields and leave them
    # None for the user turn and for an assistant turn that supplied no metering.
    store = StateStore(tmp_path / "superclaw.db")
    session = store.create_chat_session("metering")
    store.append_chat_message(session.session_id, "user", "hi")
    store.append_chat_message(
        session.session_id,
        "assistant",
        "hello",
        usage={"input_tokens": 4391, "output_tokens": 439},
        elapsed_ms=12345.0,
    )
    store.append_chat_message(session.session_id, "assistant", "plain")

    reloaded = store.get_chat_session(session.session_id)
    user_msg, metered, plain = reloaded.messages
    assert user_msg.usage is None and user_msg.elapsed_ms is None
    assert metered.usage == {"input_tokens": 4391, "output_tokens": 439}
    assert metered.elapsed_ms == 12345.0
    assert plain.usage is None and plain.elapsed_ms is None


def test_state_store_persists_goals_runs_events_and_evidence(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Probe", description="Check ClawHunt"))
    run = store.create_run(goal.goal_id)

    store.add_event(run.run_id, "worker.started", {"role": "explore"})
    bundle = store.create_evidence(run.run_id)
    bundle.add_probe("health", 200, {"ok": True})
    store.save_evidence(bundle)

    assert store.get_goal(goal.goal_id).title == "Probe"
    assert store.get_run(run.run_id).goal_id == goal.goal_id
    assert store.get_run(run.run_id).execution_context == {}
    assert store.list_events(run.run_id)[0]["type"] == "worker.started"
    assert store.get_evidence(run.run_id).probes[0]["name"] == "health"


def test_schema_version_is_stamped(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    assert store.schema_version() == StateStore.SCHEMA_VERSION


def test_backup_produces_a_consistent_reopenable_snapshot(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Probe", description="Check ClawHunt"))

    snap = store.backup(tmp_path / "backups" / "snap.db")

    assert snap.exists()
    restored = StateStore(snap)
    assert restored.schema_version() == StateStore.SCHEMA_VERSION
    assert restored.get_goal(goal.goal_id).title == "Probe"


def test_open_newer_schema_version_fails_closed(tmp_path):
    import sqlite3

    db = tmp_path / "superclaw.db"
    StateStore(db)
    with sqlite3.connect(db) as conn:
        conn.execute(f"PRAGMA user_version = {StateStore.SCHEMA_VERSION + 1}")

    with pytest.raises(RuntimeError, match="newer than this build"):
        StateStore(db)


def test_newer_db_is_refused_untouched_before_any_ddl(tmp_path):
    import sqlite3

    db = tmp_path / "future.db"
    with sqlite3.connect(db) as conn:
        conn.execute(f"PRAGMA user_version = {StateStore.SCHEMA_VERSION + 1}")

    with pytest.raises(RuntimeError, match="newer than this build"):
        StateStore(db)
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert "goals" not in tables and "runs" not in tables


def test_default_backup_path_is_anchored_next_to_the_state_db(tmp_path):
    store = StateStore(tmp_path / "nested" / "superclaw.db")

    snap = store.backup()

    assert snap.parent == tmp_path / "nested" / "backups"
    assert StateStore(snap).schema_version() == StateStore.SCHEMA_VERSION


def test_state_store_rejects_invalid_run_status_transition(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Probe", description="Check ClawHunt"))
    run = store.create_run(goal.goal_id)

    run.status = "queued"
    store.save_run(run)
    run.status = "running"
    store.save_run(run)
    run.status = "verifying"
    store.save_run(run)
    run.status = "completed"
    store.save_run(run)
    run.status = "running"

    try:
        store.save_run(run)
    except ValueError as exc:
        assert "invalid run status transition" in str(exc)
    else:  # pragma: no cover - explicit fail path for readability
        raise AssertionError("expected invalid run status transition to be rejected")


def test_state_store_acquires_and_releases_run_mutation_lease_atomically(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Lease", description="Guard mutations"))
    run = store.create_run(goal.goal_id)

    lease = store.acquire_run_mutation_lease(run.run_id, owner="executor-1", mode=RunMutationMode.EXECUTE)

    persisted = store.get_run(run.run_id)
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.lease_id == lease.lease_id
    assert persisted.active_mutation_lease.owner == "executor-1"
    assert persisted.active_mutation_lease.mode == RunMutationMode.EXECUTE
    assert persisted.active_mutation_lease.worker_pid == lease.worker_pid
    assert persisted.active_mutation_lease.worker_host == lease.worker_host
    acquired_event = store.list_events(run.run_id)[-1]
    assert acquired_event["type"] == "run.lease.acquired"
    assert acquired_event["payload"] == {
        "lease_id": lease.lease_id,
        "owner": "executor-1",
        "mode": "execute",
        "resource": f"run:{run.run_id}",
        "worker_pid": lease.worker_pid,
        "worker_host": lease.worker_host,
    }

    released = store.release_run_mutation_lease(run.run_id, lease_id=lease.lease_id, owner="executor-1")

    assert released.active_mutation_lease is None
    assert store.get_run(run.run_id).active_mutation_lease is None
    assert store.list_events(run.run_id)[-1]["type"] == "run.lease.released"


def test_state_store_rejects_duplicate_run_mutation_lease(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Lease", description="Guard mutations"))
    run = store.create_run(goal.goal_id)
    first = store.acquire_run_mutation_lease(run.run_id, owner="resumer-1", mode=RunMutationMode.RESUME)

    with pytest.raises(ValueError, match="run mutation lease already held"):
        store.acquire_run_mutation_lease(run.run_id, owner="reconciler-1", mode=RunMutationMode.RECONCILE)

    persisted = store.get_run(run.run_id)
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.lease_id == first.lease_id
    assert [event["type"] for event in store.list_events(run.run_id)] == ["run.lease.acquired"]


def test_state_store_records_lease_loss_before_rejecting_mutation(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Lease", description="Guard mutations"))
    run = store.create_run(goal.goal_id)
    lease = store.acquire_run_mutation_lease(run.run_id, owner="executor-1", mode=RunMutationMode.EXECUTE)

    with pytest.raises(ValueError, match="lease_id mismatch"):
        store.require_run_mutation_lease(run.run_id, lease_id="runlease_wrong", owner="executor-1")

    events = store.list_events(run.run_id)
    assert events[-1]["type"] == "run.lease.lost"
    assert events[-1]["payload"]["expected_lease_id"] == "runlease_wrong"
    assert events[-1]["payload"]["current_lease_id"] == lease.lease_id
    assert events[-1]["payload"]["reason"] == "lease_id mismatch"


def test_state_store_rejects_wrong_owner_release_without_clearing_lease(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Lease", description="Guard mutations"))
    run = store.create_run(goal.goal_id)
    lease = store.acquire_run_mutation_lease(run.run_id, owner="executor-1", mode="execute")

    with pytest.raises(ValueError, match="owner mismatch"):
        store.release_run_mutation_lease(run.run_id, lease_id=lease.lease_id, owner="executor-2")

    persisted = store.get_run(run.run_id)
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.lease_id == lease.lease_id
    events = store.list_events(run.run_id)
    assert events[-1]["type"] == "run.lease.release_rejected"
    assert events[-1]["payload"]["reason"] == "owner mismatch"


def test_state_store_normalizes_evidence_duplicates_and_caps_primary_text(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    goal = store.create_goal(GoalSpec(title="Probe", description="Check ClawHunt"))
    run = store.create_run(goal.goal_id)
    bundle = store.create_evidence(run.run_id)
    long_output = "prefix-" + ("x" * 5005)

    bundle.probes.extend(
        [
            {"name": "control_plane", "status_code": 200, "body": {"ok": True}},
            {"name": "control_plane", "status_code": 200, "body": {"ok": True}},
        ]
    )
    bundle.commands.extend(
        [
            {"command": "pytest -q", "exit_code": 0, "output": long_output},
            {"command": "pytest -q", "exit_code": 0, "output": long_output},
        ]
    )
    bundle.artifacts.extend(
        [
            ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"),
            ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"),
        ]
    )
    bundle.findings.extend(
        [
            VerificationFinding(name="worker_execution", passed=False, detail="backend failed", severity="high"),
            VerificationFinding(name="worker_execution", passed=False, detail="backend failed", severity="high"),
        ]
    )
    bundle.worker_results.append(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output=long_output,
            duration_seconds=0.3,
        )
    )
    bundle.worker_results.append(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output="replacement persisted output",
            duration_seconds=0.5,
        )
    )
    bundle.worker_results.append(
        WorkerResult(
            task_id="task_1",
            role="implement",
            backend="local",
            command="pytest -q",
            exit_code=1,
            output="distinct failed outcome",
            duration_seconds=0.6,
        )
    )
    store.save_evidence(bundle)

    restored = store.get_evidence(run.run_id)

    assert len(restored.probes) == 1
    assert len(restored.commands) == 1
    assert len(restored.artifacts) == 1
    assert len(restored.findings) == 2
    assert len(restored.worker_results) == 2
    assert restored.commands[0]["output"] == long_output[-PRIMARY_EVIDENCE_TEXT_LIMIT:]
    assert restored.commands[0]["output_truncated"] is True
    assert restored.commands[0]["output_original_length"] == len(long_output)
    truncation_findings = [
        finding for finding in restored.findings if finding.name == PRIMARY_EVIDENCE_TRUNCATED_FINDING
    ]
    assert len(truncation_findings) == 1
    assert truncation_findings[0].input_fields == ["commands[].output"]
    assert restored.worker_results[0].output == "replacement persisted output"
    assert restored.worker_results[1].exit_code == 1


def test_state_store_persists_codex_thread_id_for_chat_resume(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    session = store.create_chat_session("chat about resume")
    sid = session.session_id

    # Unknown / unset -> None
    assert store.get_chat_codex_thread_id(sid) is None
    assert store.get_chat_codex_thread_id("missing-session") is None

    bound = store.set_chat_codex_thread_id(sid, "thread-abc")
    assert bound.metadata["codex_thread_id"] == "thread-abc"
    assert store.get_chat_codex_thread_id(sid) == "thread-abc"

    # Survives a fresh StateStore (durable, so a restarted backend can resume).
    reopened = StateStore(tmp_path / "superclaw.db")
    assert reopened.get_chat_codex_thread_id(sid) == "thread-abc"

    # Idempotent: re-binding the same id does not raise and keeps the value.
    store.set_chat_codex_thread_id(sid, "thread-abc")
    assert store.get_chat_codex_thread_id(sid) == "thread-abc"

    # Re-binding a new id updates it.
    store.set_chat_codex_thread_id(sid, "thread-xyz")
    assert store.get_chat_codex_thread_id(sid) == "thread-xyz"


# --- chat session archive lifecycle (workspace-sidebar-rework §5 PR-A) ------


def test_chat_session_archive_hides_from_default_list_and_is_reversible(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    keep = store.create_chat_session("keep me")
    gone = store.create_chat_session("archive me")

    archived = store.set_chat_session_archived(gone.session_id, True)
    assert archived.archived is True

    default_ids = {s.session_id for s in store.list_chat_sessions()}
    assert keep.session_id in default_ids
    assert gone.session_id not in default_ids  # hidden by default

    all_ids = {s.session_id for s in store.list_chat_sessions(include_archived=True)}
    assert gone.session_id in all_ids  # never deleted

    # reversible
    store.set_chat_session_archived(gone.session_id, False)
    assert gone.session_id in {s.session_id for s in store.list_chat_sessions()}


def test_chat_session_archived_persists_across_reopen(tmp_path):
    db = tmp_path / "superclaw.db"
    store = StateStore(db)
    session = store.create_chat_session("archive me")
    store.set_chat_session_archived(session.session_id, True)

    reopened = StateStore(db)  # exercises the archived-column migration + filter
    assert session.session_id not in {s.session_id for s in reopened.list_chat_sessions()}
    assert reopened.get_chat_session(session.session_id).archived is True


def test_set_chat_session_archived_is_idempotent(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    session = store.create_chat_session("x")
    first = store.set_chat_session_archived(session.session_id, True)
    again = store.set_chat_session_archived(session.session_id, True)
    assert first.archived is again.archived is True


def test_list_personal_chat_sessions_excludes_company_sessions(tmp_path, monkeypatch):
    # The personal sidebar shows unassigned + local-workspace sessions; a session
    # in a company workspace is a Team execution and must not leak (§4.2).
    from superclaw.models import CompanyProfile, WorkspaceProfile
    from superclaw import workspace_resolver as wr

    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    local_ws = wr.create_personal_workspace(store, "mine")
    acme = store.save_company_profile(CompanyProfile(name="Acme"))
    company_ws = store.save_workspace_profile(
        WorkspaceProfile(name="HQ", repo_path=str(tmp_path / "hq"),
                         company_profile_id=acme.company_profile_id, trust_source="api")
    )
    legacy = store.create_chat_session("legacy", workspace_id=None)
    mine = store.create_chat_session("mine", workspace_id=local_ws.workspace_id)
    teamy = store.create_chat_session("teamy", workspace_id=company_ws.workspace_id)

    ids = {s.session_id for s in store.list_personal_chat_sessions()}
    assert legacy.session_id in ids and mine.session_id in ids  # unassigned + local
    assert teamy.session_id not in ids  # company session excluded


def test_append_and_pin_codex_is_atomic_and_conditional_on_workspace(tmp_path, monkeypatch):
    # §4.5 race: the codex write-back appends the reply AND pins the resume
    # thread/binding in ONE atomic transaction, pinning ONLY if the session is
    # still in the workspace the turn ran under. A late write-back for the OLD
    # boundary persists the reply but withholds the (stale) resume handle.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    a = _personal_ws(store, tmp_path, "A")
    b = _personal_ws(store, tmp_path, "B")
    a_dir = a.repo_identity["canonical_path"]
    session = store.create_chat_session("s", workspace_id=a.workspace_id)

    # boundary intact (still in A) → reply appended AND pinned
    updated, pinned = store.append_assistant_message_and_pin_codex(
        session.session_id, "answer-1", run_id=None,
        thread_id="thread-A", repo_path=a_dir, expected_repo=a_dir,
        expected_workspace_id=a.workspace_id,
    )
    assert pinned is True
    assert updated.messages[-1].content == "answer-1"
    assert store.get_chat_codex_thread_id(session.session_id) == "thread-A"
    assert store.get_chat_native_session_id(session.session_id, "codex-app-server") == "thread-A"

    # a move to B lands; a late write-back captured under the OLD boundary (A)
    # must persist its reply but NOT (re-)pin a thread that would resume A.
    store.set_chat_session_workspace(session.session_id, b.workspace_id)
    assert store.get_chat_codex_thread_id(session.session_id) is None  # move cleared it
    updated2, pinned2 = store.append_assistant_message_and_pin_codex(
        session.session_id, "answer-2", run_id=None,
        thread_id="thread-A", repo_path=a_dir, expected_repo=a_dir,
        expected_workspace_id=a.workspace_id,  # turn ran under A
    )
    assert pinned2 is False  # boundary changed → not re-pinned
    assert updated2.messages[-1].content == "answer-2"  # reply still persisted
    assert updated2.workspace_id == b.workspace_id  # the move was NOT clobbered
    assert store.get_chat_codex_thread_id(session.session_id) is None  # stays clear


def test_resume_pin_not_misskilled_for_unassigned_session(tmp_path):
    # Regression guard: an UNASSIGNED session (workspace_id=None) has no workspace
    # boundary, so the turn's repo stands — the expected_repo guard must NOT skip
    # the pin (a first-turn / legacy session still gets its resume handle).
    store = StateStore(tmp_path / "superclaw.db")
    session = store.create_chat_session("legacy", workspace_id=None)
    _, pinned = store.append_assistant_message_and_pin_codex(
        session.session_id, "hi", run_id=None,
        thread_id="t1", repo_path="/some/repo", expected_repo="/some/repo",
        expected_workspace_id=None,  # was unassigned at turn start
    )
    assert pinned is True  # not mis-killed
    assert store.get_chat_codex_thread_id(session.session_id) == "t1"
    store.set_chat_native_session(
        session.session_id, "claude", "n1", repo_path="/some/repo",
        expected_repo="/some/repo", expected_workspace_id=None,
    )
    assert store.get_chat_native_session_id(session.session_id, "claude") == "n1"  # written


def test_set_chat_native_session_expected_repo_guards_against_move(tmp_path, monkeypatch):
    # The generic/claude turn write-back pins a native binding with
    # expected_repo=repo_now; a concurrent move to a different boundary skips it
    # (fail-closed-at-write, symmetric with the codex guard — §4.5).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    a = _personal_ws(store, tmp_path, "A")
    b = _personal_ws(store, tmp_path, "B")
    a_dir = a.repo_identity["canonical_path"]
    session = store.create_chat_session("s", workspace_id=a.workspace_id)

    # boundary intact (still in A) → binding written
    store.set_chat_native_session(
        session.session_id, "claude", "n1", repo_path=a_dir,
        expected_repo=a_dir, expected_workspace_id=a.workspace_id,
    )
    assert store.get_chat_native_session_id(session.session_id, "claude") == "n1"

    # move to B; a late write-back captured under A must be skipped
    store.set_chat_session_workspace(session.session_id, b.workspace_id)
    store.set_chat_native_session(
        session.session_id, "claude", "n2", repo_path=a_dir,
        expected_repo=a_dir, expected_workspace_id=a.workspace_id,
    )
    # binding for "claude" was not (re)written to the moved session
    assert store.get_chat_native_session_id(session.session_id, "claude") is None


def test_resume_pin_skipped_on_move_to_inbox(tmp_path, monkeypatch):
    # §4.5 regression (Codex r8): a move from workspace A to the INBOX
    # (workspace_id=None) IS a boundary change. A late write-back captured under A
    # must NOT re-pin the codex thread / native binding just because the session is
    # now unassigned — keying the guard on the turn-START workspace_id (not "is it
    # unassigned now") distinguishes this from a first-turn unassigned session.
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    a = _personal_ws(store, tmp_path, "A")
    a_dir = a.repo_identity["canonical_path"]
    session = store.create_chat_session("s", workspace_id=a.workspace_id)

    # pin while grouped in A
    _, pinned = store.append_assistant_message_and_pin_codex(
        session.session_id, "answer-1", run_id=None,
        thread_id="thread-A", repo_path=a_dir, expected_repo=a_dir,
        expected_workspace_id=a.workspace_id,
    )
    assert pinned is True

    # move A → Inbox (unassigned); the move clears the prior pins
    store.set_chat_session_workspace(session.session_id, None)
    moved = store.get_chat_session(session.session_id)
    assert moved.workspace_id is None
    assert store.get_chat_codex_thread_id(session.session_id) is None

    # late codex write-back captured under A must NOT re-pin (boundary changed)
    _, pinned2 = store.append_assistant_message_and_pin_codex(
        session.session_id, "answer-2", run_id=None,
        thread_id="thread-A", repo_path=a_dir, expected_repo=a_dir,
        expected_workspace_id=a.workspace_id,
    )
    assert pinned2 is False
    assert store.get_chat_codex_thread_id(session.session_id) is None

    # ...and a late native write-back captured under A is likewise skipped
    store.set_chat_native_session(
        session.session_id, "claude", "n-late", repo_path=a_dir,
        expected_repo=a_dir, expected_workspace_id=a.workspace_id,
    )
    assert store.get_chat_native_session_id(session.session_id, "claude") is None


# --- move semantics: native-binding invalidation (workspace-sidebar §4.5) ---


def _personal_ws(store, tmp_path, name):
    from superclaw import workspace_resolver as wr

    return wr.create_personal_workspace(store, name)


def test_move_to_different_execution_boundary_clears_native_bindings(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws1 = _personal_ws(store, tmp_path, "one")
    ws2 = _personal_ws(store, tmp_path, "two")  # different scratch dir => different boundary
    session = store.create_chat_session("s", workspace_id=ws1.workspace_id)
    store.set_chat_native_session(session.session_id, "codex", "native-123", repo_path=ws1.repo_path)
    assert store.get_chat_native_session_id(session.session_id, "codex") == "native-123"

    # pre-move query (a surface can warn BEFORE moving)
    assert store.chat_move_changes_execution_boundary(session.session_id, ws2.workspace_id) is True

    moved = store.set_chat_session_workspace(session.session_id, ws2.workspace_id)
    assert moved.workspace_id == ws2.workspace_id
    # stale binding pointing at the old repo is dropped -> next turn re-resolves
    assert store.get_chat_native_session_id(session.session_id, "codex") is None


def test_noop_move_keeps_native_bindings(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws1 = _personal_ws(store, tmp_path, "one")
    session = store.create_chat_session("s", workspace_id=ws1.workspace_id)
    store.set_chat_native_session(session.session_id, "codex", "native-123", repo_path=ws1.repo_path)

    assert store.chat_move_changes_execution_boundary(session.session_id, ws1.workspace_id) is False
    store.set_chat_session_workspace(session.session_id, ws1.workspace_id)  # same workspace
    assert store.get_chat_native_session_id(session.session_id, "codex") == "native-123"


def test_move_to_different_boundary_clears_every_resume_handle(tmp_path, monkeypatch):
    # codex resume lives in codex_thread_id, SEPARATE from native_sessions — a
    # boundary-changing move must drop BOTH, or codex resumes the old repo (§4.5).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws1 = _personal_ws(store, tmp_path, "one")
    ws2 = _personal_ws(store, tmp_path, "two")
    session = store.create_chat_session("s", workspace_id=ws1.workspace_id)
    store.set_chat_codex_thread_id(session.session_id, "thread-old")
    store.set_chat_native_session(session.session_id, "claude", "claude-1", repo_path=ws1.repo_path)

    store.set_chat_session_workspace(session.session_id, ws2.workspace_id)
    assert store.get_chat_codex_thread_id(session.session_id) is None  # codex handle dropped
    assert store.get_chat_native_session_id(session.session_id, "claude") is None


def test_adopting_unassigned_session_to_matching_workspace_keeps_bindings(tmp_path, monkeypatch):
    # A legacy (workspace_id=None) session adopted into the workspace that ALREADY
    # matches the dir its bindings were established under is NOT a boundary change
    # — it must keep its resume state (Codex blocker: adoption != cross-boundary).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws = _personal_ws(store, tmp_path, "home")
    ws_dir = ws.repo_identity["canonical_path"]
    session = store.create_chat_session("legacy", workspace_id=None)
    store.set_chat_native_session(session.session_id, "codex", "native-1", repo_path=ws_dir)

    assert store.chat_move_changes_execution_boundary(session.session_id, ws.workspace_id) is False
    store.set_chat_session_workspace(session.session_id, ws.workspace_id)  # adopt
    assert store.get_chat_native_session_id(session.session_id, "codex") == "native-1"  # kept


def test_move_prunes_only_stale_bindings_keeps_matching(tmp_path, monkeypatch):
    # Per-binding precision: a mixed-backend session keeps the binding already at
    # the target dir and drops the one pinned to the old dir (Codex blocker).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws1 = _personal_ws(store, tmp_path, "one")
    ws2 = _personal_ws(store, tmp_path, "two")
    session = store.create_chat_session("s", workspace_id=ws1.workspace_id)
    store.set_chat_native_session(
        session.session_id, "claude", "c-stale", repo_path=ws1.repo_identity["canonical_path"]
    )
    store.set_chat_native_session(
        session.session_id, "codex-cli", "c-ok", repo_path=ws2.repo_identity["canonical_path"]
    )
    store.set_chat_session_workspace(session.session_id, ws2.workspace_id)
    assert store.get_chat_native_session_id(session.session_id, "claude") is None  # stale dropped
    assert store.get_chat_native_session_id(session.session_id, "codex-cli") == "c-ok"  # match kept


def test_move_clears_codex_thread_for_legacy_session_with_no_repo_evidence(tmp_path, monkeypatch):
    # A legacy session with ONLY a codex_thread_id (no native repo evidence) has an
    # unverifiable boundary -> fail-closed: drop the thread on a move so it cannot
    # resume the old repo (Codex blocker: don't keep ambiguous resume handles).
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws = _personal_ws(store, tmp_path, "home")
    session = store.create_chat_session("legacy", workspace_id=None)
    store.set_chat_codex_thread_id(session.session_id, "thread-orphan")
    store.set_chat_session_workspace(session.session_id, ws.workspace_id)
    assert store.get_chat_codex_thread_id(session.session_id) is None


def test_move_without_native_bindings_just_regroups(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    store = StateStore(tmp_path / "superclaw.db")
    ws1 = _personal_ws(store, tmp_path, "one")
    ws2 = _personal_ws(store, tmp_path, "two")
    session = store.create_chat_session("s", workspace_id=ws1.workspace_id)
    # the boundary changes (different scratch dirs), but with no native bindings
    # the clear is a harmless no-op and the move just regroups without error.
    assert store.chat_move_changes_execution_boundary(session.session_id, ws2.workspace_id) is True
    moved = store.set_chat_session_workspace(session.session_id, ws2.workspace_id)
    assert moved.workspace_id == ws2.workspace_id



def test_issue_hold_active_uniqueness_and_reuse(tmp_path):
    import sqlite3

    from superclaw.models import IssueHold

    store = StateStore(tmp_path / "s.db")
    store.save_issue_hold(IssueHold(issue_id="issue_1", reason="first"))
    # A second ACTIVE hold for the same issue is refused at the DB level.
    with pytest.raises(sqlite3.IntegrityError):
        store.save_issue_hold(IssueHold(issue_id="issue_1", reason="dup"))
    assert store.issue_is_held("issue_1") is True
    # Release frees the partial index → a fresh hold is allowed again.
    active = store.get_active_issue_hold("issue_1")
    active.status = "released"
    store.update_issue_hold(active)
    assert store.issue_is_held("issue_1") is False
    store.save_issue_hold(IssueHold(issue_id="issue_1", reason="second"))
    assert store.issue_is_held("issue_1") is True
    # Ledger keeps the full history (2 released/active + appended), audit-friendly.
    assert len(store.list_issue_holds(issue_id="issue_1")) == 2


# --- status_changed_at choke point (message-center §2.5) --------------------


def test_save_issue_stamps_status_changed_at_only_on_status_transition(tmp_path):
    import time as _time

    from superclaw.models import Issue, IssueStatus

    store = StateStore(tmp_path / "superclaw.db")
    issue = store.save_issue(Issue(title="x", created_at=1000.0))
    # Fresh issue: status_changed_at seeded to created_at, no transition yet.
    assert issue.status_changed_at == 1000.0

    # A metadata/comment-style resave that does NOT change status must leave
    # status_changed_at untouched (so it never re-surfaces as a new event).
    issue.metadata = {"note": "edited"}
    before = _time.time()
    saved = store.save_issue(issue)
    assert saved.status_changed_at == 1000.0
    assert store.get_issue(issue.issue_id).status_changed_at == 1000.0

    # A real status transition advances status_changed_at to ~now.
    issue.status = IssueStatus.TODO.value
    saved = store.save_issue(issue)
    assert saved.status_changed_at >= before
    persisted = store.get_issue(issue.issue_id)
    assert persisted.status_changed_at == saved.status_changed_at
    assert persisted.status_changed_at > 1000.0


def test_block_issue_advances_status_changed_at(tmp_path):
    from superclaw import team_kernel
    from superclaw.models import Issue, IssueStatus

    store = StateStore(tmp_path / "superclaw.db")
    issue = store.save_issue(Issue(title="work", status=IssueStatus.TODO.value, created_at=1000.0))
    blocked = team_kernel.block_issue(store, issue.issue_id, reason="waiting on infra")
    assert blocked.status == IssueStatus.BLOCKED.value
    # status_changed_at moved off the creation seed when status flipped to blocked.
    assert blocked.status_changed_at > 1000.0
    assert store.get_issue(issue.issue_id).status_changed_at == blocked.status_changed_at


def test_consume_respond_grant_is_single_use(tmp_path):
    # The first consume of a (run_id, issue_id) pair returns True (spent now);
    # every subsequent consume of the SAME pair returns False (already spent).
    store = StateStore(tmp_path / "superclaw.db")
    assert store.consume_respond_grant("run_a", "issue_1") is True
    assert store.consume_respond_grant("run_a", "issue_1") is False
    assert store.consume_respond_grant("run_a", "issue_1") is False


def test_consume_respond_grant_independent_per_pair(tmp_path):
    # Consumption is keyed by the (run_id, issue_id) PAIR: a different run, or the
    # same run on a different issue, is an independent grant.
    store = StateStore(tmp_path / "superclaw.db")
    assert store.consume_respond_grant("run_a", "issue_1") is True
    # Different issue, same run → independent grant, first consume True.
    assert store.consume_respond_grant("run_a", "issue_2") is True
    # Different run, same issue → independent grant, first consume True.
    assert store.consume_respond_grant("run_b", "issue_1") is True
    # Each is now individually spent.
    assert store.consume_respond_grant("run_a", "issue_1") is False
    assert store.consume_respond_grant("run_a", "issue_2") is False
    assert store.consume_respond_grant("run_b", "issue_1") is False


def test_consume_respond_grant_blank_keys_return_false(tmp_path):
    # A blank/missing run_id or issue_id cannot key a consume → False, and must
    # NOT leave a ("", "") ledger row that would poison a later real consume.
    store = StateStore(tmp_path / "superclaw.db")
    assert store.consume_respond_grant("", "issue_1") is False
    assert store.consume_respond_grant("run_a", "") is False
    assert store.consume_respond_grant("", "") is False
    # A real consume afterward is unaffected (no poisoned row was written).
    assert store.consume_respond_grant("run_a", "issue_1") is True
