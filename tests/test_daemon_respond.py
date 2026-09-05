"""A @mention / comment wake drives a RESPOND run (reply in thread), not idle.

Before this, a thread-directed wake fell through work selection and finished
`idle` — a human @mention woke the agent but it never answered. The respond path
runs the agent on the wake's issue WITHOUT checking it out / claiming it / moving
its status, so the agent can read the thread and reply.
"""

from __future__ import annotations

import types

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import AgentProfile, CompanyProfile, Issue, IssueStatus
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name)).company_profile_id


def _agent(store, company_id, name="Eng"):
    return store.save_agent_profile(
        AgentProfile(name=name, role="engineer", backend_policy="local", company_profile_id=company_id)
    )


def _issue(store, company_id, *, assignee=None, status="todo"):
    issue = Issue(title="Login", description="ship it", company_profile_id=company_id,
                  workspace_id="local", status=status, assignee_agent_profile_id=assignee)
    return store.save_issue(issue)


class _RespondStub:
    """Stands in for the model turn: optionally posts a reply comment as the agent."""

    def __init__(self, store, *, reply=True):
        self.store = store
        self.reply = reply
        self.calls: list[dict] = []

    def run_goal(self, **kwargs):
        self.calls.append(kwargs)
        if self.reply:
            team_kernel.post_issue_comment(
                self.store,
                kwargs["execution_context_extra"]["issue_id"],
                body="done — @local_user",
                author_type="agent",
                author_id=kwargs["agent_profile_id"],
            )
        return types.SimpleNamespace(
            session=types.SimpleNamespace(run_id="run_resp", status="completed")
        )

    def reconcile_stale_runs(self, **kwargs):
        return []


def _daemon(store, stub, tmp_path):
    return HeartbeatDaemon(store, stub, repo_path=tmp_path, artifact_dir=tmp_path / "art")


def test_mention_wake_drives_a_respond_run_not_idle(store, tmp_path):
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id, status="todo")
    # A human @-mentions the agent → a mention wake is enqueued.
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng are you done?",
                                   author_type="user", author_id="local_user")
    stub = _RespondStub(store, reply=True)
    outcome = _daemon(store, stub, tmp_path).service_once()
    assert outcome is not None
    # It RAN (respond), it did not idle.
    assert outcome.detail == "ran:run_resp:responded"
    assert len(stub.calls) == 1
    assert stub.calls[0]["execution_context_extra"]["respond_mode"] is True
    assert stub.calls[0]["execution_context_extra"]["issue_id"] == issue.issue_id
    # The agent posted a reply in the thread.
    assert any(c.author_id == eng.profile_id for c in store.list_issue_comments(issue.issue_id))
    # No checkout / no disposition change — the issue stays as it was.
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value


def test_respond_run_with_no_reply_records_no_response_not_idle(store, tmp_path):
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id)
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng ping",
                                   author_type="user", author_id="local_user")
    stub = _RespondStub(store, reply=False)
    outcome = _daemon(store, stub, tmp_path).service_once()
    # The wake DID drive a run; silence is recorded as no_response, never idle.
    assert outcome.detail == "ran:run_resp:no_response"
    assert len(stub.calls) == 1


def test_respond_cooldown_skips_a_second_attempt(store, tmp_path):
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id)
    stub = _RespondStub(store, reply=True)
    daemon = _daemon(store, stub, tmp_path)
    # First @ → a respond run actually executes (an ATTEMPT goes on record).
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng status?",
                                   author_type="user", author_id="local_user")
    first = daemon.service_once()
    assert first.detail.startswith("ran:")
    assert len(stub.calls) == 1
    # A second @ within the cooldown → loop/DoW backstop: NO new run.
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng and now?",
                                   author_type="user", author_id="local_user")
    second = daemon.service_once()
    assert second.detail == "respond_cooldown"
    assert len(stub.calls) == 1  # the second wake burned no run


def test_no_response_attempt_still_cools_down(store, tmp_path):
    # A respond run that left NO comment is still an attempt — the next wake must
    # cool down (else a no_response run could be re-burned immediately).
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id)
    stub = _RespondStub(store, reply=False)
    daemon = _daemon(store, stub, tmp_path)
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng ping",
                                   author_type="user", author_id="local_user")
    assert daemon.service_once().detail == "ran:run_resp:no_response"
    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng ping again",
                                   author_type="user", author_id="local_user")
    assert daemon.service_once().detail == "respond_cooldown"
    assert len(stub.calls) == 1


def test_thread_directed_issue_is_company_fenced(store, tmp_path):
    cid_a = _company(store, "A")
    cid_b = _company(store, "B")
    eng = _agent(store, cid_a, name="Eng")
    foreign = _issue(store, cid_b)  # an issue in a DIFFERENT company
    daemon = _daemon(store, _RespondStub(store), tmp_path)
    wake = types.SimpleNamespace(
        reason=f"mention:{foreign.issue_id}",
        context_snapshot={"issue_id": foreign.issue_id, "comment_id": "c1"},
    )
    # A cross-company issue never resolves to a respond target (fail-closed).
    assert daemon._thread_directed_issue(wake, eng) is None


def test_comment_wake_is_not_a_respond_trigger(store, tmp_path):
    # NO-BURN regression: a bare `comment:` wake (the kernel also raises one for a
    # SYSTEM `[review rejected]` / `[revision requested]` audit comment waking the
    # assignee) must NOT drive a respond run — it stays on the work/rework path, so a
    # spent rejection is never re-burned. Only an explicit `mention:` responds.
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id)
    daemon = _daemon(store, _RespondStub(store), tmp_path)
    wake = types.SimpleNamespace(
        reason=f"comment:{issue.issue_id}",
        context_snapshot={"issue_id": issue.issue_id, "comment_id": "c1"},
    )
    assert daemon._thread_directed_issue(wake, eng) is None


def test_mention_during_rework_defers_to_work_path(store, tmp_path):
    # NO-BURN defense in depth: even an explicit @mention does not respond while the
    # issue is in active rework (a pending qa_rejection continuation) — the work path
    # owns that wake (it reads the recent thread anyway), so respond never pre-empts
    # rework / re-burns an attempt.
    from superclaw.models import IssueThreadInteraction

    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id, status="in_progress")
    store.save_issue_interaction(IssueThreadInteraction(
        issue_id=issue.issue_id, company_profile_id=cid, kind="qa_rejection", status="pending",
        target_agent_profile_id=eng.profile_id, payload={},
    ))
    daemon = _daemon(store, _RespondStub(store), tmp_path)
    wake = types.SimpleNamespace(
        reason=f"mention:{issue.issue_id}",
        context_snapshot={"issue_id": issue.issue_id, "comment_id": "c1"},
    )
    assert daemon._thread_directed_issue(wake, eng) is None



def test_agent_is_not_woken_by_its_own_comment(store):
    # Invariant the respond path relies on (in place of a self-loop guard):
    # post_issue_comment never wakes a comment's own author — the mention and the
    # assignee continuations both skip the author — so an agent is never
    # thread-woken by its own comment, even one that @-mentions itself.
    cid = _company(store)
    eng = _agent(store, cid, name="Eng")
    issue = _issue(store, cid, assignee=eng.profile_id)
    team_kernel.post_issue_comment(store, issue.issue_id, body="note to self @Eng",
                                   author_type="agent", author_id=eng.profile_id)
    assert store.list_wakeups(agent_profile_id=eng.profile_id, status="queued") == []
