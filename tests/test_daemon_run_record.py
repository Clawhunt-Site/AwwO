"""Every agent run leaves its output as a durable thread comment (Paperclip parity).

So the issue thread IS the readable conversation — visible live or after, without
depending on a live transcript stream. The record is written record-only (no
mention/assignee continuations), so it can never spawn a wake or a respond loop.
"""

from __future__ import annotations

import types

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import AgentProfile, CompanyProfile, Issue
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _setup(store):
    cid = store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id
    eng = store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", backend_policy="local", company_profile_id=cid)
    )
    issue = store.save_issue(Issue(title="t", company_profile_id=cid, workspace_id="local",
                                   status="todo", assignee_agent_profile_id=eng.profile_id))
    return cid, eng, issue


def _daemon(store, tmp_path, orch=None):
    return HeartbeatDaemon(store, orch or types.SimpleNamespace(reconcile_stale_runs=lambda **k: []),
                           repo_path=tmp_path, artifact_dir=tmp_path / "a")


def test_run_output_text_extracts_message_completed(store, tmp_path):
    _setup(store)
    store.add_event("run_x", "reasoning.completed", {"text": "thinking..."})
    store.add_event("run_x", "message.completed", {"text": "Hired plan ready."})
    store.add_event("run_x", "message.completed", {"text": "Delegated to Eng."})
    d = _daemon(store, tmp_path)
    out = d._run_output_text("run_x")
    # Only message.completed text, in order; reasoning is not the message.
    assert out == "Hired plan ready.\n\nDelegated to Eng."


def test_run_output_text_truncates(store, tmp_path):
    big = "x" * (HeartbeatDaemon._RUN_RECORD_MAX_CHARS + 500)
    store.add_event("run_big", "message.completed", {"text": big})
    out = _daemon(store, tmp_path)._run_output_text("run_big")
    assert len(out) <= HeartbeatDaemon._RUN_RECORD_MAX_CHARS + 60
    assert "truncated" in out


def test_post_run_record_writes_agent_comment_and_fires_no_wake(store, tmp_path):
    cid, eng, issue = _setup(store)
    store.add_event("run_r", "message.completed", {"text": "Here is the hiring plan."})
    # Drain any queue so we can assert the record fires NO new wakeup.
    while store.claim_next_wakeup() is not None:
        pass
    _daemon(store, tmp_path)._post_run_record(issue, eng, "run_r", "completed")
    comments = store.list_issue_comments(issue.issue_id)
    assert len(comments) == 1
    assert comments[0].author_type == "agent"
    assert comments[0].author_id == eng.profile_id
    assert comments[0].body == "Here is the hiring plan."
    # Record-only: it must NOT enqueue any continuation wake (no loop risk).
    assert store.list_wakeups(status="queued") == []


def test_post_run_record_noop_when_no_output(store, tmp_path):
    cid, eng, issue = _setup(store)
    _daemon(store, tmp_path)._post_run_record(issue, eng, "run_empty", "completed")
    assert store.list_issue_comments(issue.issue_id) == []


def test_respond_no_reply_still_records_output(store, tmp_path):
    # A respond run that posts no reply of its own still surfaces its output as a
    # record, so a reader is never left with a silent no_response.
    cid, eng, issue = _setup(store)

    class _SilentRespondStub:
        def run_goal(self, **kwargs):
            rid = "run_resp"
            # The model produced output but the agent didn't call the comment tool.
            self_store = store
            self_store.add_event(rid, "message.completed", {"text": "Status: still sourcing candidates."})
            return types.SimpleNamespace(session=types.SimpleNamespace(run_id=rid, status="completed"))

        def reconcile_stale_runs(self, **kwargs):
            return []

    team_kernel.post_issue_comment(store, issue.issue_id, body="@Eng status?",
                                   author_type="user", author_id="local_user")
    out = _daemon(store, tmp_path, _SilentRespondStub()).service_once()
    assert out.detail == "ran:run_resp:no_response"
    bodies = [c.body for c in store.list_issue_comments(issue.issue_id)]
    assert "Status: still sourcing candidates." in bodies


def test_post_run_record_is_fail_soft(store, tmp_path):
    # A record must NEVER raise out of the run-completion tail (it runs before the
    # lock release / finish_wakeup). Even a broken event store is swallowed.
    cid, eng, issue = _setup(store)
    d = _daemon(store, tmp_path)

    def _boom(_run_id):
        raise RuntimeError("events table on fire")

    d.store.list_events = _boom  # simulate a store hiccup mid-extraction
    # Must not raise, and must post nothing.
    d._post_run_record(issue, eng, "run_boom", "completed")
    assert store.list_issue_comments(issue.issue_id) == []
    # _run_output_text itself also degrades to '' rather than raising.
    assert d._run_output_text("run_boom") == ""
