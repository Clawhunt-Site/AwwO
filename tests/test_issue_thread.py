"""Tests for the issue thread (phase 3a): comments, mentions, QA bounce loop.

The thread is how an organization talks: @-mentions and comments become
deterministic wakeups, a review rejection bounces work back and wakes the
assignee for rework, and blocked issues carry a durable reason instead of
dying silently. Positive + fail-closed negative coverage throughout.
"""

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import (
    AgentProfile,
    AgentWakeupRequest,
    Issue,
    IssueStatus,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def make_profile(store, name="Eng", company="local", **kwargs):
    profile = AgentProfile(name=name, role="engineer", company_profile_id=company,
                           backend_policy="local", **kwargs)
    store.save_agent_profile(profile)
    return profile


def make_issue(store, profile=None, *, title="Ship login", company="local"):
    issue = Issue(title=title, description="work", company_profile_id=company)
    store.save_issue(issue)
    if profile is not None:
        issue = team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    return issue


def queued_wakeups(store, profile_id):
    return store.list_wakeups(agent_profile_id=profile_id, status="queued")


def drain_wakeups(store):
    """Consume queued wakeups (assign_issue now emits assignment wakeups)."""
    while True:
        wakeup = store.claim_next_wakeup()
        if wakeup is None:
            return
        store.finish_wakeup(wakeup.wakeup_id, status="finished", detail="test-drain")


# --- comments + mentions ------------------------------------------------------


def test_comment_persists_in_thread_order(store):
    issue = make_issue(store)
    team_kernel.post_issue_comment(store, issue.issue_id, body="first")
    team_kernel.post_issue_comment(store, issue.issue_id, body="second")
    bodies = [c.body for c in store.list_issue_comments(issue.issue_id)]
    assert bodies == ["first", "second"]


def test_empty_comment_rejected(store):
    issue = make_issue(store)
    with pytest.raises(ValueError):
        team_kernel.post_issue_comment(store, issue.issue_id, body="   ")


def test_mention_by_name_and_id_wakes_target(store):
    eng = make_profile(store, name="Eng")
    qa = make_profile(store, name="QA")
    issue = make_issue(store)
    _, interactions = team_kernel.post_issue_comment(
        store, issue.issue_id, body=f"@Eng and @{qa.profile_id} please look"
    )
    assert {i.target_agent_profile_id for i in interactions} == {eng.profile_id, qa.profile_id}
    assert all(i.kind == "mention" for i in interactions)
    assert len(queued_wakeups(store, eng.profile_id)) == 1
    assert len(queued_wakeups(store, qa.profile_id)) == 1


def test_unknown_and_cross_company_mentions_resolve_to_nothing(store):
    from superclaw.models import CompanyProfile

    other = CompanyProfile(name="OtherCo")
    store.save_company_profile(other)
    make_profile(store, name="Stranger", company=other.company_profile_id)
    issue = make_issue(store, company="local")
    _, interactions = team_kernel.post_issue_comment(
        store, issue.issue_id, body="@Nobody @Stranger hello?"
    )
    # A name can never address another company's agent (governance boundary).
    assert interactions == []


def test_comment_from_non_assignee_wakes_assignee(store):
    eng = make_profile(store)
    issue = make_issue(store, eng)
    drain_wakeups(store)  # clear the assignment wakeup; focus on the comment
    team_kernel.post_issue_comment(store, issue.issue_id, body="status?", author_id="local_user")
    assert len(queued_wakeups(store, eng.profile_id)) == 1


def test_assignee_own_comment_does_not_self_wake(store):
    eng = make_profile(store)
    issue = make_issue(store, eng)
    drain_wakeups(store)
    team_kernel.post_issue_comment(
        store, issue.issue_id, body="working on it", author_type="agent", author_id=eng.profile_id
    )
    assert queued_wakeups(store, eng.profile_id) == []


# --- blocked semantics ----------------------------------------------------------


def test_block_requires_reason_and_hides_from_scheduler(store, tmp_path):
    eng = make_profile(store)
    issue = make_issue(store, eng)
    with pytest.raises(ValueError):
        team_kernel.block_issue(store, issue.issue_id, reason="  ", by="local_user")
    team_kernel.block_issue(store, issue.issue_id, reason="waiting on credentials")
    assert store.get_issue(issue.issue_id).status == IssueStatus.BLOCKED.value
    # The scheduler never claims blocked work: a wake services to idle.
    daemon = HeartbeatDaemon(store, repo_path=tmp_path, artifact_dir=tmp_path / "a")
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id))
    assert daemon.service_once().detail == "idle"
    # The reason is durable on the thread.
    assert any("waiting on credentials" in c.body for c in store.list_issue_comments(issue.issue_id))


def test_unblock_returns_to_queue_and_wakes_assignee(store):
    eng = make_profile(store)
    issue = make_issue(store, eng)
    team_kernel.block_issue(store, issue.issue_id, reason="blocked")
    before = len(queued_wakeups(store, eng.profile_id))
    team_kernel.unblock_issue(store, issue.issue_id, note="credentials arrived")
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value
    assert len(queued_wakeups(store, eng.profile_id)) >= max(before, 1)
    with pytest.raises(ValueError):
        team_kernel.unblock_issue(store, issue.issue_id)  # not blocked anymore


# --- the QA bounce loop ---------------------------------------------------------


def _reviewed_issue(store, profile):
    """Drive an issue to in_review the kernel way (checkout → submit)."""
    issue = make_issue(store, profile)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_1", holder=profile.profile_id)
    _, approval = team_kernel.submit_for_review(store, issue.issue_id, requested_by=profile.profile_id)
    return store.get_issue(issue.issue_id), approval


def test_rejection_bounces_back_and_wakes_assignee(store):
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="tests are missing")
    refreshed = store.get_issue(issue.issue_id)
    assert refreshed.status == IssueStatus.IN_PROGRESS.value
    # Durable trail: a rejection comment + a pending qa_rejection interaction.
    assert any("tests are missing" in c.body for c in store.list_issue_comments(issue.issue_id))
    rejections = store.list_issue_interactions(issue_id=issue.issue_id, kind="qa_rejection", status="pending")
    assert len(rejections) == 1 and rejections[0].target_agent_profile_id == eng.profile_id
    # The assignee is woken to rework (automation source).
    wakes = queued_wakeups(store, eng.profile_id)
    assert any(w.source == "automation" and w.reason.startswith("qa_rejection") for w in wakes)


def test_approval_resolves_thread_without_waking(store):
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    drain_wakeups(store)  # clear the assignment wakeup from setup
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_issue(issue.issue_id).status == IssueStatus.DONE.value
    completions = store.list_issue_interactions(issue_id=issue.issue_id, kind="completion")
    assert len(completions) == 1 and completions[0].status == "resolved"
    assert queued_wakeups(store, eng.profile_id) == []


def test_rework_loop_executes_without_new_checkout(store, tmp_path):
    class _StubOrchestrator:
        def __init__(self):
            self.calls = 0

        def run_goal(self, **kwargs):
            import types

            self.calls += 1
            return types.SimpleNamespace(
                session=types.SimpleNamespace(run_id=f"run_rework_{self.calls}", status="completed")
            )

        def reconcile_stale_runs(self, **kwargs):
            return []

    orchestrator = _StubOrchestrator()
    daemon = HeartbeatDaemon(store, orchestrator, repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="rework it")

    # The rejection wakeup drives a rework pass: no fresh checkout (the agent
    # still holds the claim), execution, and a NEW review request.
    outcome = daemon.service_once()
    assert outcome.status == "finished"
    assert outcome.detail.endswith("submitted_for_review")
    refreshed = store.get_issue(issue.issue_id)
    assert refreshed.status == IssueStatus.IN_REVIEW.value
    assert refreshed.execution_run_id == "run_rework_1"
    # The answered rejection is resolved — the loop cannot spin on it forever.
    assert store.list_issue_interactions(issue_id=issue.issue_id, kind="qa_rejection", status="pending") == []
    assert len([a for a in store.list_approvals(status="pending") if a.issue_id == issue.issue_id]) == 1


def test_wreckage_is_never_auto_reworked(store, tmp_path):
    daemon = HeartbeatDaemon(store, repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = make_profile(store)
    issue = make_issue(store, eng)
    # A failed run's scene: in_progress + lock held + NO pending rejection.
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_dead", holder=eng.profile_id)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id))
    outcome = daemon.service_once()
    assert outcome.detail == "idle"
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value


# --- advisor-driven hardening (3a round 2) --------------------------------------


def test_failed_rework_spends_the_rejection_no_burn_loop(store, tmp_path):
    class _FailingOrchestrator:
        def run_goal(self, **kwargs):
            import types

            return types.SimpleNamespace(
                session=types.SimpleNamespace(run_id="run_fail_1", status="failed")
            )

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _FailingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="rework it")

    first = daemon.service_once()
    assert first.detail.endswith("failed")
    # The rejection is SPENT: resolved with the failed run recorded, so the
    # next heartbeat does NOT re-pick the wreckage (one rejection = one attempt).
    spent = store.list_issue_interactions(issue_id=issue.issue_id, kind="qa_rejection")
    assert spent and spent[0].status == "resolved"
    assert spent[0].payload.get("rework_failed_run_id") == "run_fail_1"
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id))
    assert daemon.service_once().detail == "idle"
    # The scene is preserved for inspection.
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value


def test_block_unblock_releases_lock_and_recheckout_succeeds(store):
    eng = make_profile(store)
    issue = make_issue(store, eng)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_1", holder=eng.profile_id)
    # Blocking returns the claim — the workspace lock must not outlive it.
    team_kernel.block_issue(store, issue.issue_id, reason="waiting on vendor")
    assert store.get_workspace_lock(team_kernel.workspace_lock_key(issue)) is None
    team_kernel.unblock_issue(store, issue.issue_id, note="vendor replied")
    # The full claim cycle works again (no stranded-lock deadlock).
    reclaimed = team_kernel.checkout_issue(store, issue.issue_id, run_id="run_2", holder=eng.profile_id)
    assert reclaimed.status == IssueStatus.IN_PROGRESS.value


def test_requeue_recovers_wreckage_via_cli(store, tmp_path, monkeypatch):
    import json as _json

    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    cli_store = StateStore(tmp_path / "state.db")
    eng = make_profile(cli_store)
    issue = make_issue(cli_store, eng)
    team_kernel.checkout_issue(cli_store, issue.issue_id, run_id="run_dead", holder=eng.profile_id)

    result = CliRunner().invoke(app, ["issue", "requeue", issue.issue_id])
    assert result.exit_code == 0, result.output
    payload = _json.loads(result.output)
    assert payload["status"] == "todo"
    assert cli_store.get_workspace_lock(team_kernel.workspace_lock_key(issue)) is None


def test_duplicate_names_are_ambiguous_and_wake_nobody(store):
    a = make_profile(store, name="Eng")
    b = make_profile(store, name="Eng")
    issue = make_issue(store)
    _, interactions = team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng look")
    # Fail-closed: an ambiguous name resolves to nobody; the id form still works.
    assert interactions == []
    _, by_id = team_kernel.post_issue_comment(store, issue.issue_id, body=f"@{a.profile_id} look")
    assert [i.target_agent_profile_id for i in by_id] == [a.profile_id]
    assert b.profile_id != a.profile_id


def test_rework_run_carries_rejection_reason(store, tmp_path):
    captured = {}

    class _CapturingOrchestrator:
        def run_goal(self, **kwargs):
            import types

            captured.update(kwargs)
            return types.SimpleNamespace(
                session=types.SimpleNamespace(run_id="run_rw", status="completed")
            )

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="tests are missing")
    outcome = daemon.service_once()
    assert outcome.detail.endswith("submitted_for_review")
    # The worker saw WHY it bounced — reason and thread tail in the description.
    assert "Continuation context" in captured["description"]
    assert "tests are missing" in captured["description"]
    # A fresh (non-rework) claim carries the plain description. Approve the
    # reworked issue first so its workspace lock releases.
    new_approval = [a for a in store.list_approvals(status="pending") if a.issue_id == issue.issue_id][0]
    team_kernel.decide_approval(store, new_approval.approval_id, approved=True)
    make_issue(store, eng, title="Fresh")
    captured.clear()
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id, idempotency_key="fresh"))
    daemon.service_once()
    assert "Continuation context" not in captured["description"]


def test_decision_flip_is_atomic_with_lock_release(store):
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    # One transaction: done issue + approved approval + released lock agree.
    assert store.get_issue(issue.issue_id).status == IssueStatus.DONE.value
    assert store.get_approval(approval.approval_id).status == "approved"
    assert store.get_workspace_lock(team_kernel.workspace_lock_key(issue)) is None


def test_failed_rework_via_exception_also_spends_the_rejection(store, tmp_path):
    class _CrashAfterPersist:
        """run_goal persists a real run (as the orchestrator does) then raises."""

        def __init__(self, store):
            self.store = store

        def run_goal(self, **kwargs):
            from superclaw.models import GoalSpec

            goal = self.store.create_goal(GoalSpec(title="x", description="y"))
            session = self.store.create_run(goal.goal_id)
            session.execution_context = {
                **session.execution_context,
                **(kwargs.get("execution_context_extra") or {}),
            }
            self.store.save_run(session)
            raise RuntimeError("rework died mid-execution")

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _CrashAfterPersist(store), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    eng = make_profile(store)
    issue, approval = _reviewed_issue(store, eng)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="rework it")

    first = daemon.service_once()
    assert first.status == "skipped" and first.detail.startswith("run_error")
    # The rejection is spent on BOTH failure shapes (status and raise): the
    # next heartbeat must not re-pick the wreckage.
    spent = store.list_issue_interactions(issue_id=issue.issue_id, kind="qa_rejection")
    assert spent and spent[0].status == "resolved"
    assert spent[0].payload.get("rework_failed_run_id") == first.run_id
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=eng.profile_id, idempotency_key="again"))
    assert daemon.service_once().detail == "idle"
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value
