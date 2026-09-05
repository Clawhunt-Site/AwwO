"""Phase 3 end-to-end acceptance: the full organizational loop, unattended.

The pivot plan's acceptance script (docs/agent-team-kernel-daemon-pivot.md §7
阶段 3): the CEO wakes up, breaks the work down to an engineer, the engineer
delivers, QA bounces the root once, the CEO reworks and resubmits — and the
only human touches in the whole story are approval decisions. Everything else
is heartbeats, wakeups, locks and worktrees doing their job.
"""

import subprocess
import types

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import AgentProfile, Issue, IssueStatus, WorkspaceProfile
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def git_repo(tmp_path):
    repo = tmp_path / "company-repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=repo, check=True,
    )
    return repo


class _CompanyOrchestrator:
    """Scripted worker: the CEO's FIRST pass delegates (as a real agent would
    via `superclaw issue delegate`), every pass completes. Captures calls."""

    def __init__(self, store, ceo, eng):
        self.store = store
        self.ceo = ceo
        self.eng = eng
        self.calls = []
        self._delegated = False

    def run_goal(self, **kwargs):
        from superclaw.models import GoalSpec

        self.calls.append(kwargs)
        context = kwargs.get("execution_context_extra") or {}
        # Persist a REAL run (legal status walk) so downstream consumers —
        # prior-pass context, recovery probes — see what production would see.
        goal = self.store.create_goal(GoalSpec(title=kwargs.get("title") or "t", description="d"))
        session = self.store.create_run(goal.goal_id)
        session.execution_context = {
            **session.execution_context,
            **context,
            "agent_profile_id": kwargs.get("agent_profile_id"),
        }
        for status in ("queued", "running", "verifying", "completed"):
            session.status = status
            self.store.save_run(session)
        run_id = session.run_id
        if (
            kwargs.get("agent_profile_id") == self.ceo.profile_id
            and not self._delegated
        ):
            # The CEO's worker shells out to the kernel exactly like the CLI.
            team_kernel.delegate_sub_issue(
                self.store,
                context["issue_id"],
                assignee_agent_profile_id=self.eng.profile_id,
                title="Implement the API",
                description="build it",
                requested_by=self.ceo.profile_id,
                origin_run_id=run_id,
            )
            self._delegated = True
        return types.SimpleNamespace(
            session=types.SimpleNamespace(run_id=run_id, status="completed")
        )

    def reconcile_stale_runs(self, **kwargs):
        return []


def pending_approvals(store, issue_id):
    return [a for a in store.list_approvals(status="pending") if a.issue_id == issue_id]


def test_phase3_full_company_loop_unattended(store, tmp_path):
    repo = git_repo(tmp_path)
    workspace = WorkspaceProfile(name="HQ", repo_path=str(repo), concurrency="per_issue")
    store.save_workspace_profile(workspace)
    ceo = AgentProfile(
        name="CEO", role="ceo", backend_policy="local",
        workspace_id=workspace.workspace_id,
        runtime_config={"heartbeat": {"enabled": True, "interval_sec": 100}},
        charter="Delegate, integrate, ship.",
    )
    eng = AgentProfile(
        name="Eng", role="engineer", backend_policy="local",
        workspace_id=workspace.workspace_id,
        runtime_config={"heartbeat": {"enabled": True, "interval_sec": 100}},
    )
    store.save_agent_profile(ceo)
    store.save_agent_profile(eng)
    orchestrator = _CompanyOrchestrator(store, ceo, eng)
    daemon = HeartbeatDaemon(store, orchestrator, repo_path=tmp_path, artifact_dir=tmp_path / "a")

    # Touch #0: the human ASK — filing the issue and pointing it at the CEO.
    # (Assignment is part of the ask; the count below proves no human ever
    # checked out, ran, or resubmitted anything.)
    root = Issue(title="Ship the feature", description="end to end",
                 workspace_id=workspace.workspace_id)
    store.save_issue(root)
    team_kernel.assign_issue(store, root.issue_id, ceo.profile_id)

    # — Act 1: the CEO heartbeat claims the root, delegates, submits. —
    drained = []
    while True:
        outcome = daemon.service_once()
        if outcome is None:
            break
        drained.append(outcome)
    assert store.get_issue(root.issue_id).status == IssueStatus.IN_REVIEW.value
    child = next(i for i in store.list_issues() if i.parent_id == root.issue_id)
    assert child.origin_kind == "delegation"
    ceo_first_run = store.get_run(child.origin_run_id)  # provenance points at a REAL run
    assert ceo_first_run.execution_context["agent_profile_id"] == ceo.profile_id
    # Fresh first pass carried NO continuation/prior context (negative).
    assert "Prior pass" not in orchestrator.calls[0]["description"]
    assert "Continuation context" not in orchestrator.calls[0]["description"]
    # The engineer's pass ran in ITS OWN worktree (per-issue isolation).
    eng_calls = [c for c in orchestrator.calls if c.get("agent_profile_id") == eng.profile_id]
    assert len(eng_calls) == 1
    eng_repo = eng_calls[0]["repo_path"]
    assert str(eng_repo).endswith(child.issue_id)
    assert (eng_repo / ".git").exists()  # a real attached worktree, not a plain dir
    assert store.get_issue(child.issue_id).status == IssueStatus.IN_REVIEW.value

    # — Act 2 (human touch #1): approve the child. Flow-back wakes the CEO. —
    child_approval = pending_approvals(store, child.issue_id)[0]
    team_kernel.decide_approval(store, child_approval.approval_id, approved=True)
    assert store.get_issue(child.issue_id).status == IssueStatus.DONE.value

    # Honest asynchrony: the CEO's child_done wakeup fires NOW, while the root
    # is still in_review — that pass services to idle (nothing executable yet)
    # and the durable pending fact SURVIVES it. The wakeup is a hint; the fact
    # is the truth that converges later. No test choreography hides this.
    idle_pass = daemon.service_once()
    assert idle_pass is not None and idle_pass.detail == "idle"
    assert [
        i for i in store.list_issue_interactions(issue_id=root.issue_id, status="pending", kind="completion")
        if i.continuation_policy == "notify_parent"
    ]

    # — Act 3 (human touch #2): QA bounces the ROOT once. —
    root_approval = pending_approvals(store, root.issue_id)[0]
    team_kernel.decide_approval(
        store, root_approval.approval_id, approved=False, note="integrate the child's API"
    )

    # — Act 4: the CEO reworks unattended, seeing BOTH facts in its brief. —
    while True:
        outcome = daemon.service_once()
        if outcome is None:
            break
        drained.append(outcome)
    rework_call = orchestrator.calls[-1]
    assert rework_call["agent_profile_id"] == ceo.profile_id
    assert "integrate the child's API" in rework_call["description"]          # the rejection
    assert "Delegated child finished" in rework_call["description"]           # the flow-back
    assert "Prior pass: run" in rework_call["description"]                    # session continuity
    assert "finished completed" in rework_call["description"]                 # …with the real terminal status
    refreshed = store.get_issue(root.issue_id)
    assert refreshed.status == IssueStatus.IN_REVIEW.value                    # resubmitted
    # Consumed continuations are resolved — the loop converged.
    assert team_kernel and not [
        i for i in store.list_issue_interactions(issue_id=root.issue_id, status="pending")
        if i.kind in ("qa_rejection", "completion")
    ]

    # — Act 5 (human touch #3): final approval. The company delivered. —
    final = pending_approvals(store, root.issue_id)[0]
    team_kernel.decide_approval(store, final.approval_id, approved=True)
    assert store.get_issue(root.issue_id).status == IssueStatus.DONE.value
    # Every lock is back home.
    assert store.list_workspace_locks() == []
    # Audit: the whole story is on the threads.
    root_kinds = {i.kind for i in store.list_issue_interactions(issue_id=root.issue_id)}
    assert {"delegation", "qa_rejection", "completion"} <= root_kinds
    # The only human acts were the three approval decisions (plus the ask in
    # Touch #0) — no human ever checked out, ran, or resubmitted anything.
    decided = [a for a in store.list_approvals() if a.decided_by == "local_user" and a.status != "pending"]
    assert len(decided) == 3
