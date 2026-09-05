"""Tests for lock granularity (phase 3c): per-issue locks + worktree isolation.

The workspace-wide lock retires where execution can isolate: a ``per_issue``
workspace locks each issue by itself and the daemon runs every issue in its
own git worktree. Where isolation is impossible (non-git), the kernel refuses
the declaration at the source and the daemon serializes defensively.
"""

import subprocess

import pytest

from superclaw import team_kernel
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import AgentProfile, AgentWakeupRequest, Issue, IssueStatus, WorkspaceProfile
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def git_repo(tmp_path, name="repo"):
    repo = tmp_path / name
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=repo, check=True,
    )
    return repo


def per_issue_workspace(store, repo):
    workspace = WorkspaceProfile(name="iso", repo_path=str(repo), concurrency="per_issue")
    store.save_workspace_profile(workspace)
    return workspace


def make_profile(store, workspace, name="Eng"):
    profile = AgentProfile(
        name=name, role="engineer", backend_policy="local",
        workspace_id=workspace.workspace_id,
    )
    store.save_agent_profile(profile)
    return profile


def assigned_issue(store, profile, workspace, *, title="Work"):
    issue = Issue(title=title, description="d", workspace_id=workspace.workspace_id)
    store.save_issue(issue)
    issue = team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    while True:  # drain the assignment wakeup; these tests drive their own
        wakeup = store.claim_next_wakeup()
        if wakeup is None:
            break
        store.finish_wakeup(wakeup.wakeup_id, status="finished", detail="test-drain")
    return issue


# --- declaration gate ------------------------------------------------------------


def test_per_issue_requires_git_repo(tmp_path):
    with pytest.raises(ValueError, match="git repo"):
        team_kernel.validate_workspace_concurrency(str(tmp_path), "per_issue")
    team_kernel.validate_workspace_concurrency(str(git_repo(tmp_path)), "per_issue")
    team_kernel.validate_workspace_concurrency(str(tmp_path), "serial")
    with pytest.raises(ValueError, match="unknown"):
        team_kernel.validate_workspace_concurrency(str(tmp_path), "parallel")


# --- lock key granularity ----------------------------------------------------------


def test_serial_workspace_keeps_workspace_lock(store):
    issue = Issue(title="t", workspace_id="local")
    assert team_kernel.workspace_lock_key(issue, store=store) == "workspace:local"
    # No store → fail-safe serial too.
    assert team_kernel.workspace_lock_key(issue) == "workspace:local"


def test_per_issue_workspace_locks_each_issue(store, tmp_path):
    repo = git_repo(tmp_path)
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    a = assigned_issue(store, profile, workspace, title="A")
    b = assigned_issue(store, profile, workspace, title="B")
    assert team_kernel.workspace_lock_key(a, store=store) == f"issue:{a.issue_id}"
    # Two issues of the SAME workspace can both be checked out (the old
    # workspace-wide lock would have refused the second).
    team_kernel.checkout_issue(store, a.issue_id, run_id="r1", holder=profile.profile_id)
    team_kernel.checkout_issue(store, b.issue_id, run_id="r2", holder=profile.profile_id)
    assert store.get_issue(a.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert store.get_issue(b.issue_id).status == IssueStatus.IN_PROGRESS.value
    # And the full release path agrees on the key (approve releases B's lock).
    _, approval = team_kernel.submit_for_review(store, b.issue_id, requested_by=profile.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_workspace_lock(f"issue:{b.issue_id}") is None
    assert store.get_workspace_lock(f"issue:{a.issue_id}") is not None


# --- daemon worktree isolation -------------------------------------------------------


class _CapturingOrchestrator:
    def __init__(self):
        self.calls = []

    def run_goal(self, **kwargs):
        import types

        self.calls.append(kwargs)
        return types.SimpleNamespace(
            session=types.SimpleNamespace(run_id=f"run_{len(self.calls)}", status="completed")
        )

    def reconcile_stale_runs(self, **kwargs):
        return []


def test_daemon_runs_each_issue_in_its_own_worktree(store, tmp_path):
    repo = git_repo(tmp_path)
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    orchestrator = _CapturingOrchestrator()
    daemon = HeartbeatDaemon(store, orchestrator, repo_path=tmp_path, artifact_dir=tmp_path / "a")
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.detail.endswith("submitted_for_review")
    exec_repo = orchestrator.calls[0]["repo_path"]
    expected = repo / ".superclaw" / "worktrees" / issue.issue_id
    assert exec_repo == expected
    # It is a real attached git worktree on the issue branch.
    head = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=expected,
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert head == f"issue/{issue.issue_id}"


def test_worktree_is_reused_across_passes(store, tmp_path):
    repo = git_repo(tmp_path)
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    first, _ = daemon._execution_isolation(issue)
    second, _ = daemon._execution_isolation(issue)
    assert first == second  # rework continues in the same working state


def drifted_per_issue_workspace(store, tmp_path, name="bad"):
    """A LEGALLY created per_issue workspace whose repo later lost its .git
    (drift the creation gate cannot prevent) — the daemon's guard territory."""
    import shutil

    repo = git_repo(tmp_path, name=f"{name}-repo")
    workspace = WorkspaceProfile(name=name, repo_path=str(repo), concurrency="per_issue")
    store.save_workspace_profile(workspace)
    shutil.rmtree(repo / ".git")
    return workspace


def test_unisolatable_per_issue_serializes_with_guard(store, tmp_path):
    # Drifted workspace: declared per_issue, repo no longer git. The daemon
    # must not let two runs write the same directory — the guard serializes.
    workspace = drifted_per_issue_workspace(store, tmp_path, name="bad")
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    # Someone else already holds the guard…
    store.acquire_workspace_lock(
        f"workspace-guard:{workspace.workspace_id}",
        workspace_id=workspace.workspace_id, holder="other", run_id="other",
    )
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.detail == "workspace_guard_busy:deferred"
    # The claim was unwound — the issue is reclaimable, not stranded.
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value


def test_guard_released_after_run(store, tmp_path):
    workspace = drifted_per_issue_workspace(store, tmp_path, name="bad2")
    profile = make_profile(store, workspace)
    assigned_issue(store, profile, workspace)
    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.detail.endswith("submitted_for_review")
    assert store.get_workspace_lock(f"workspace-guard:{workspace.workspace_id}") is None


# --- advisor-driven hardening (3c round 2) ----------------------------------------


def test_lock_key_pinned_across_concurrency_flip(store, tmp_path):
    """C1: the release frees what checkout actually took, even after the
    workspace declaration changes between the two moments."""
    repo = git_repo(tmp_path, name="pin-repo")
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    issue = team_kernel.checkout_issue(store, issue.issue_id, run_id="r", holder=profile.profile_id)
    assert issue.lock_key == f"issue:{issue.issue_id}"
    # Flipping concurrency mid-claim is refused at the write entry…
    workspace.concurrency = "serial"
    with pytest.raises(ValueError, match="mid-claim"):
        store.save_workspace_profile(workspace)
    # …and even if the profile read failed at release time, the PINNED key is
    # what gets freed (no stranded issue:* lock).
    _, approval = team_kernel.submit_for_review(store, issue.issue_id, requested_by=profile.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_workspace_lock(f"issue:{issue.issue_id}") is None
    assert store.get_issue(issue.issue_id).lock_key is None


def test_save_workspace_rejects_relative_or_nongit_per_issue(store, tmp_path):
    """C2: the single write entry enforces what the CLI/API door enforces."""
    with pytest.raises(ValueError, match="absolute"):
        store.save_workspace_profile(WorkspaceProfile(name="rel", repo_path=".", concurrency="per_issue"))
    plain = tmp_path / "noget"
    plain.mkdir()
    with pytest.raises(ValueError, match="git repo"):
        store.save_workspace_profile(WorkspaceProfile(name="ng", repo_path=str(plain), concurrency="per_issue"))
    with pytest.raises(ValueError, match="unknown"):
        store.save_workspace_profile(WorkspaceProfile(name="uk", repo_path=str(plain), concurrency="parallel"))


def test_corrupt_worktree_dir_falls_back_to_guard(store, tmp_path):
    """C4: a half-created plain directory at the worktree path is never
    trusted as the execution target."""
    repo = git_repo(tmp_path, name="corrupt-repo")
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    fake = repo / ".superclaw" / "worktrees" / issue.issue_id
    fake.mkdir(parents=True)  # plain dir, no .git file
    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    exec_repo, guard_key = daemon._execution_isolation(issue)
    assert exec_repo == repo
    assert guard_key == f"workspace-guard:{workspace.workspace_id}"


def test_concurrency_flip_blocked_by_held_lock_even_without_status(store, tmp_path):
    """Codex round-3: the flip gate also counts LIVE LOCKS in the same
    transaction — a claim mid-flight (lock taken, status not yet written)
    still blocks the flip."""
    repo = git_repo(tmp_path, name="flip-repo")
    workspace = per_issue_workspace(store, repo)
    store.acquire_workspace_lock(
        "issue:half-claimed", workspace_id=workspace.workspace_id,
        holder="someone", issue_id="half-claimed", run_id="r",
    )
    workspace.concurrency = "serial"
    with pytest.raises(ValueError, match="lock"):
        store.save_workspace_profile(workspace)


def test_rework_lookup_uses_pinned_key(store, tmp_path):
    """The rework scheduler finds its claim by the pinned key, not a fresh
    derivation — drift between the two can never hide bounced work."""
    repo = git_repo(tmp_path, name="pin2-repo")
    workspace = per_issue_workspace(store, repo)
    profile = make_profile(store, workspace)
    issue = assigned_issue(store, profile, workspace)
    issue = team_kernel.checkout_issue(store, issue.issue_id, run_id="r", holder=profile.profile_id)
    _, approval = team_kernel.submit_for_review(store, issue.issue_id, requested_by=profile.profile_id)
    team_kernel.decide_approval(store, approval.approval_id, approved=False, note="redo")
    daemon = HeartbeatDaemon(store, _CapturingOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a")
    picked, needs_checkout = daemon._next_work(profile)
    assert picked is not None and picked.issue_id == issue.issue_id
    assert needs_checkout is False  # found via the pinned issue:* lock
