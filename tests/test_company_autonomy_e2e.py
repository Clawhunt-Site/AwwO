"""End-to-end orchestration test for Agent-company autonomy (PR-5, 柱子 3).

Proves the "辅助一次完整流程后自动推进" loop is wired under route B: a human only
ever touches GOVERNANCE GATES (the hire approval and the completion review — both
are *meant* to need a human), and wakeups / continuations carry the work between
those gates with no manual assignment or nudge:

    bootstrap (company + seed issue assigned to CEO)
      -> seed-issue assignment WAKEUP enqueued atomically by the commit path
      -> daemon claims it, runs the CEO turn (fake backend) — NO human click
      -> the CEO turn drives a company tool through the run-bound ticket channel
         (the realistic A-class path) and calls ``agent_hire``
      -> hire lands a PENDING agent_hire approval (NOT a direct create — red line)
      -> [GATE 1] a human GRANTS the hire -> the new agent profile is created
      -> [GATE 2] a human reviews the seed completion and sends it back ("the team
         is staffed now — delegate it") -> a qa_rejection continuation reworks the
         seed and the daemon reruns the CEO off that wakeup
      -> the CEO delegates a sub-issue to the new agent -> assignment WAKEUP
      -> daemon claims it and runs the new agent as its bound profile.

Every governance gate is asserted along the way:
  * the seed wakeup is a real ``assignment`` event (the commit path replays it),
  * the autonomous CEO scope is ``is_admin=False`` (cannot self-report admin),
  * an agent-initiated hire is gated to a human approval (the hire red line),
  * a granted hire creates exactly one new agent,
  * delegating to that agent wakes it and the daemon runs it.

Scope honesty: this does NOT claim the hire GRANT alone resumes the CEO. That
"blocked-dependency autonomous resume" (grant -> requester resumes its blocked
issue with no completion-review gate) is a deferred follow-up — it needs the
hire-requesting run to PARK its issue (``WAITING_FOR_HUMAN_GATE``) plus an
origin-issue continuation link, neither of which exists yet. Here turn 2 is
driven by the completion-review gate's qa_rejection continuation (a real kernel
path), not by the grant.

No real LLM / codex — a stub orchestrator stands in for the model turn and
drives the SAME ticket + ``execute_company_command`` choke point a real A-class
backend would. The point under test is the editorial loop wiring, not a model.
"""

from __future__ import annotations

import json

import pytest

from superclaw import team_kernel
from superclaw.company_ticket import issue_run_ticket
from superclaw.daemon import HeartbeatDaemon
from superclaw.models import (
    ApprovalStatus,
    ApprovalType,
    IssueStatus,
    WakeupSource,
)
from superclaw.state import StateStore
from superclaw.team_bootstrap import BootstrapCommitError, commit_bootstrap_proposal
from superclaw.team_mcp_proxy import (
    TEAM_COMMAND_ACTIONS,
    TEAM_MCP_AUDIENCE,
    TeamMcpProxyOptions,
    TeamMcpProxyServer,
    write_ticket_file,
)
from superclaw.team_templates import build_bootstrap_proposal


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #
_COMPANY_ID = "co_e2e"
_CEO_PROFILE_ID = "pending_agent_ceo"  # team-template derives profile ids from role ids


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _bootstrap_company_with_seed(store: StateStore) -> dict:
    """Commit a company whose seed issue is assigned to the CEO role.

    Uses the inline team-template path (no signing needed) through the real
    ``build_bootstrap_proposal`` -> ``commit_bootstrap_proposal`` boundary, so
    the seed-issue assignee resolution and the commit-time wakeup wiring are
    exercised exactly as in production.
    """
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": _COMPANY_ID, "name": "Acme"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [
            {"id": "ceo", "name": "CEO", "role": "ceo", "charter": "Lead", "backend_policy": "local"},
        ],
        "seed_issue": {"title": "Build the product", "assignee": "ceo"},
    }
    proposal = build_bootstrap_proposal(spec)
    assert not proposal.blocked
    assert not proposal.approvals_required  # no high-risk policy -> direct commit
    return commit_bootstrap_proposal(store, proposal)


def _enable_wake(store: StateStore, profile_id: str) -> None:
    """wake_on_demand defaults True, but a heartbeat-disabled profile still needs
    the master switch OFF (design) — assignment events bypass it. We only have to
    ensure the profile exists; nothing else to flip for an event wakeup."""
    # Sanity: the profile must be persisted and event-wakeable by default.
    profile = store.get_agent_profile(profile_id)
    assert profile is not None


def _call_team_tool(
    store: StateStore, *, run_id: str, agent_profile_id: str, company_id: str, name: str, arguments: dict
) -> dict:
    """Drive a company tool through the REAL ticket-authenticated A-class proxy.

    Mints the run-bound ticket the orchestrator would mint for an A-class team
    run, stages it in a 0600 sidecar, and calls the tool through the SAME
    ``TeamMcpProxyServer`` a real codex/claude backend talks to — so the governed
    path (ticket verify -> scope re-derive is_admin=False -> execute_company_command
    choke point -> autonomy/risk gates) runs unchanged. Returns the parsed result.
    """
    token, _ = issue_run_ticket(
        store,
        run_id=run_id,
        agent_profile_id=agent_profile_id,
        company_id=company_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    ticket_file = str(store.path.parent / f"ticket-{run_id}.key")
    write_ticket_file(ticket_file, token)
    server = TeamMcpProxyServer(
        TeamMcpProxyOptions(
            state_path=str(store.path),
            run_id=run_id,
            agent_profile_id=agent_profile_id,
            company_id=company_id,
            ticket_file=ticket_file,
            audience=TEAM_MCP_AUDIENCE,
        )
    )
    resp = server.handle_message(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": name, "arguments": arguments}}
    )
    return json.loads(resp["result"]["content"][0]["text"])


class _CeoOrchestrator:
    """Fake backend standing in for the CEO's model turn (no LLM).

    Both turns drive a company tool through the REAL governed A-class proxy
    (ticket-authed, is_admin=False, the execute_company_command choke point):
      * turn 1 (no engineer yet) -> ``agent_hire`` -> kernel routes it to a human
        approval (the hire red line). The turn completes (it produced a unit of
        work: the hire request) -> the daemon advances the seed to in_review.
      * turn 2 -> after the human grants the hire AND sends the seed back for
        revision ("now staff it"), the daemon REWORKS the seed and reruns the CEO,
        which ``issue_delegate``s a sub-issue to the engineer. delegate_sub_issue
        emits the engineer's assignment wakeup.

    The action is deterministic (a stand-in for the CEO's decision), but the daemon
    DRIVES both turns off real wakeups (seed assignment, then the revision rework)
    and the GOVERNANCE + WAKEUP paths are the real kernel paths — no company tool
    is ever called from the test body.
    """

    def __init__(self, store: StateStore, *, company_id: str, seed_issue_id: str):
        self.store = store
        self.company_id = company_id
        self.seed_issue_id = seed_issue_id
        self.calls = 0
        self.tool_responses: list[dict] = []

    def _engineer(self):
        for p in self.store.list_agent_profiles(company_profile_id=self.company_id):
            if p.role == "engineer":
                return p
        return None

    def run_goal(self, **kwargs):
        import types

        self.calls += 1
        run_id = f"run_ceo_{self.calls}"
        ceo_id = kwargs["agent_profile_id"]
        engineer = self._engineer()
        if engineer is None:
            response = _call_team_tool(
                self.store, run_id=run_id, agent_profile_id=ceo_id, company_id=self.company_id,
                name="agent_hire",
                arguments={"spec": {"name": "Engineer", "role": "engineer",
                                    "company_profile_id": self.company_id,
                                    # Reports to the CEO so the CEO can later
                                    # delegate work to it (subtree autonomy gate).
                                    "reports_to": ceo_id}},
            )
            self.tool_responses.append(response)
            # The CEO produced a unit of work (the hire request); the turn completes
            # and the daemon advances the seed to in_review.
            run_status = "completed"
        else:
            response = _call_team_tool(
                self.store, run_id=run_id, agent_profile_id=ceo_id, company_id=self.company_id,
                name="issue_delegate",
                arguments={"parent_id": self.seed_issue_id,
                           "assignee_agent_profile_id": engineer.profile_id,
                           "title": "Implement the feature", "origin_run_id": run_id},
            )
            self.tool_responses.append(response)
            run_status = "completed"
        return types.SimpleNamespace(
            session=types.SimpleNamespace(run_id=run_id, status=run_status)
        )

    def reconcile_stale_runs(self, **kwargs):
        return []


class _NewAgentOrchestrator:
    """Fake backend for the freshly-hired agent's first run — just records that
    it ran as the bound profile and reports completed."""

    def __init__(self):
        self.ran_as: list[str] = []

    def run_goal(self, **kwargs):
        import types

        self.ran_as.append(kwargs["agent_profile_id"])
        return types.SimpleNamespace(
            session=types.SimpleNamespace(run_id=f"run_new_{len(self.ran_as)}", status="completed")
        )

    def reconcile_stale_runs(self, **kwargs):
        return []


# --------------------------------------------------------------------------- #
# Step 1: bootstrap seeds an assignment wakeup for the CEO
# --------------------------------------------------------------------------- #
def test_bootstrap_seed_issue_enqueues_ceo_assignment_wakeup(store):
    result = _bootstrap_company_with_seed(store)
    assert result["committed"] is True

    # The CEO profile was created and the seed issue is assigned to it.
    ceo = store.get_agent_profile(_CEO_PROFILE_ID)
    assert ceo.company_profile_id == _COMPANY_ID
    issues = store.list_issues(company_profile_id=_COMPANY_ID)
    assert len(issues) == 1
    assert issues[0].assignee_agent_profile_id == _CEO_PROFILE_ID

    # The commit path replayed the assignment wakeup (柱子 3 wiring): a real
    # `assignment` event for the CEO, identical in shape to a runtime assign.
    wakeups = store.list_wakeups(agent_profile_id=_CEO_PROFILE_ID, status="queued")
    assert len(wakeups) == 1
    wakeup = wakeups[0]
    assert wakeup.source == WakeupSource.ASSIGNMENT.value
    assert wakeup.reason == f"issue_assigned:{issues[0].issue_id}"
    assert wakeup.context_snapshot == {"issue_id": issues[0].issue_id}


def test_unassigned_seed_issue_enqueues_no_wakeup(store):
    """Fail-closed: an UN-assigned seed issue (no `assignee`) must NOT wake
    anyone — the wiring fires only for an owned issue."""
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": _COMPANY_ID, "name": "Acme"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [{"id": "ceo", "name": "CEO", "role": "ceo", "charter": "Lead"}],
        "seed_issue": {"title": "Unowned work"},  # no assignee
    }
    commit_bootstrap_proposal(store, build_bootstrap_proposal(spec))
    issue = store.list_issues(company_profile_id=_COMPANY_ID)[0]
    assert issue.assignee_agent_profile_id in (None, "")
    assert store.list_wakeups(status="queued") == []


def test_unknown_seed_assignee_role_blocks_the_proposal(store):
    """Fail-closed: a seed `assignee` that names a role NOT in this template is a
    BLOCKING rejection — the proposal is blocked and commit refuses, rather than
    silently stranding the company with an issue pointed at a profile that was
    never created (and so wakes nobody)."""
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": _COMPANY_ID, "name": "Acme"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [{"id": "ceo", "name": "CEO", "role": "ceo", "charter": "Lead"}],
        "seed_issue": {"title": "Work", "assignee": "ghost_role"},
    }
    proposal = build_bootstrap_proposal(spec)
    assert proposal.blocked is True
    assert any(r["code"] == "unknown_seed_assignee_role" for r in proposal.rejections)
    with pytest.raises(BootstrapCommitError):
        commit_bootstrap_proposal(store, proposal)
    # Nothing was written, and nobody was woken.
    assert store.list_company_profiles() == []
    assert store.list_wakeups(status="queued") == []


def test_commit_rejects_cross_company_seed_assignee(store):
    """Fail-closed at the durable boundary: the raw-SQL seed commit bypasses
    ``team_kernel.assign_issue``'s same-company assignee check, so a crafted /
    stale proposal that assigns a seed issue to a profile NOT created in this
    company must be refused — never persisted (which would otherwise enqueue a
    cross-company wakeup)."""
    from superclaw.team_bootstrap import apply_bootstrap_commit_payload

    payload = {
        "would_create": {
            "company_profile": {"company_profile_id": _COMPANY_ID, "name": "Acme"},
            "workspace_profile": {
                "workspace_id": "local",
                "name": "ws",
                "company_profile_id": _COMPANY_ID,
                "writable_paths": ["."],
                "network_policy": "restricted",
            },
            "agent_profiles": [
                {
                    "profile_id": "pending_agent_ceo",
                    "name": "CEO",
                    "role": "ceo",
                    "company_profile_id": _COMPANY_ID,
                    "workspace_id": "local",
                }
            ],
            "issues": [
                {
                    "issue_id": "seed_1",
                    "title": "Work",
                    "company_profile_id": _COMPANY_ID,
                    "workspace_id": "local",
                    # A FOREIGN profile id never created in this company.
                    "assignee_agent_profile_id": "agent_from_other_company",
                    "status": "todo",
                }
            ],
        }
    }
    with pytest.raises(BootstrapCommitError, match="not a profile created in this company"):
        apply_bootstrap_commit_payload(store, payload)
    # Nothing persisted, nobody woken.
    assert store.list_company_profiles() == []
    assert store.list_wakeups(status="queued") == []


def test_seed_wakeup_is_atomic_with_the_commit(store):
    """The seed assignment wakeup is enqueued on the SAME transaction as the seed
    issue write — a committed company always has its CEO wakeup queued (no
    commit-then-lose window)."""
    result = _bootstrap_company_with_seed(store)
    assert result["committed"] is True
    # The committed issue and its wakeup are both present (one atomic unit).
    issue = store.list_issues(company_profile_id=_COMPANY_ID)[0]
    assert issue.status == IssueStatus.TODO.value
    wakeups = store.list_wakeups(agent_profile_id=_CEO_PROFILE_ID, status="queued")
    assert len(wakeups) == 1
    assert wakeups[0].context_snapshot == {"issue_id": issue.issue_id}


# --------------------------------------------------------------------------- #
# Step 2-6: the full wakeup -> tool -> human gate -> hire -> re-wakeup loop
# --------------------------------------------------------------------------- #
def _make_per_issue_workspace(store: StateStore, tmp_path) -> None:
    """Switch the company's workspace to per_issue concurrency over a real git repo.

    per_issue locking means each issue locks ITSELF, not the whole workspace — so
    the CEO's seed issue and the engineer's delegated child do not serialize on one
    shared lock. This isolates the e2e from serial-workspace contention (which has
    its own daemon coverage); the loop under test is wakeup -> tool -> gate ->
    hire -> delegate -> the new agent running, not lock arbitration.
    """
    import subprocess

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    ws = store.get_workspace_profile("local")
    ws.repo_path = str(repo)
    ws.concurrency = "per_issue"
    team_kernel.validate_workspace_concurrency(ws.repo_path, ws.concurrency)
    store.save_workspace_profile(ws)


def test_full_autonomy_loop_wakeup_hire_gate_grant_rewake(store, tmp_path):
    # --- Step 1: bootstrap; CEO + seed issue + atomic assignment wakeup ---
    _bootstrap_company_with_seed(store)
    _make_per_issue_workspace(store, tmp_path)
    seed_issue = store.list_issues(company_profile_id=_COMPANY_ID)[0]
    _enable_wake(store, _CEO_PROFILE_ID)

    ceo_orch = _CeoOrchestrator(store, company_id=_COMPANY_ID, seed_issue_id=seed_issue.issue_id)
    repo = tmp_path / "repo"
    daemon = HeartbeatDaemon(store, ceo_orch, repo_path=repo, artifact_dir=tmp_path / "artifacts")

    # --- Step 2-3: the daemon claims the SEED wakeup and runs the CEO's first turn
    # (no human click anywhere — the bootstrap wakeup drove this). ---
    outcome = daemon.service_once()
    assert outcome is not None and outcome.agent_profile_id == _CEO_PROFILE_ID
    assert ceo_orch.calls == 1, "the CEO turn ran exactly once off the seed wakeup"
    # The CEO's turn produced a unit of work (the hire request) and completed, so
    # the daemon advanced the seed to in_review with a completion approval.
    assert store.get_issue(seed_issue.issue_id).status == IssueStatus.IN_REVIEW.value

    # --- Step 4 (red line): the CEO's hire was GATED, not directly created ---
    hire_resp = ceo_orch.tool_responses[0]
    assert hire_resp["status"] == "pending_approval"
    assert hire_resp["executed"] is False
    # An agent-initiated hire through the company-command choke point lands as a
    # pending COMPANY_COMMAND approval whose resume action is an ``agent.hire`` (the
    # high-risk gate, NOT a direct create) — the same single choke point all surfaces share.
    hire_approvals = [
        a
        for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
        if a.type == ApprovalType.COMPANY_COMMAND.value
        and (a.resume_action or {}).get("command_type") == "agent.hire"
    ]
    assert len(hire_approvals) == 1, "an agent-initiated hire opens exactly one human gate"
    hire_approval = hire_approvals[0]
    assert hire_approval.approval_id == hire_resp["approval_id"]
    # The new role does NOT exist yet — the hire red line: pending, not created.
    assert [p.profile_id for p in store.list_agent_profiles(company_profile_id=_COMPANY_ID)] == [
        _CEO_PROFILE_ID
    ], "no new agent before the human grant"

    # --- Step 5: a human GRANTS the hire -> the new agent is created ---
    team_kernel.decide_approval(store, hire_approval.approval_id, approved=True)
    new_agents = [
        p for p in store.list_agent_profiles(company_profile_id=_COMPANY_ID)
        if p.profile_id != _CEO_PROFILE_ID
    ]
    assert len(new_agents) == 1, "the grant created exactly one new agent"
    engineer = new_agents[0]
    assert engineer.role == "engineer"
    assert engineer.company_profile_id == _COMPANY_ID
    assert engineer.reports_to == _CEO_PROFILE_ID  # created under the CEO's subtree

    # Scope guard: the grant did NOT fake a hollow "approval_granted" resume wakeup
    # for the CEO (that loop is the deferred blocked-dependency follow-up — see the
    # module docstring). Turn 2 below is driven by the completion-review GATE, not
    # the grant.
    assert [
        w for w in store.list_wakeups(agent_profile_id=_CEO_PROFILE_ID, status="queued")
        if w.reason.startswith("approval_granted:")
    ] == [], "no hollow approval_granted resume wakeup is emitted"

    # --- Step 6 [GATE 2]: the human reviews the seed completion and sends it back
    # ("the team is staffed — now delegate the implementation"). This is a real,
    # intended governance gate (route B: humans touch gates), not a crutch: the seed
    # returns to in_progress under the CEO's claim with a qa_rejection continuation
    # and the CEO is woken by that continuation's own wakeup. The daemon then RERUNS
    # the CEO, whose turn 2 delegates a sub-issue to the engineer through the
    # governed tool — no tool is called from the test body; the daemon drives the
    # whole turn off the continuation. ---
    seed_completion = next(
        a for a in store.list_approvals(status=ApprovalStatus.PENDING.value)
        if a.type == ApprovalType.ISSUE_COMPLETION.value and a.issue_id == seed_issue.issue_id
    )
    # ATTRIBUTION (the point of this revision): prove turn 2 is driven by the
    # completion-review GATE's continuation, not by some other path (heartbeat,
    # generic in_progress scan, stale-run reconcile). Before the gate fires there
    # are NO queued CEO wakeups (turn 1 consumed the seed assignment; the hire grant
    # emits none), so any wakeup the daemon claims next can ONLY be one the gate
    # enqueued.
    assert store.list_wakeups(agent_profile_id=_CEO_PROFILE_ID, status="queued") == []
    team_kernel.request_revision(store, seed_completion.approval_id, note="staff it now")
    assert store.get_issue(seed_issue.issue_id).status == IssueStatus.IN_PROGRESS.value

    # The gate enqueued continuation wakeup(s) for the CEO — among them the revision
    # continuation, identified by source + reason + the approval/issue it points back
    # to. (request_revision also fires the comment continuation, so there can be >1.)
    gate_wakeups = store.list_wakeups(agent_profile_id=_CEO_PROFILE_ID, status="queued")
    gate_wakeup_ids = {w.wakeup_id for w in gate_wakeups}
    assert gate_wakeup_ids, "the completion-review gate enqueued a continuation wakeup"
    revision_wakeups = [
        w for w in gate_wakeups if w.reason == f"revision_requested:{seed_issue.issue_id}"
    ]
    assert len(revision_wakeups) == 1, "the gate enqueued the revision continuation"
    revision_wakeup = revision_wakeups[0]
    assert revision_wakeup.source == WakeupSource.AUTOMATION.value
    assert revision_wakeup.context_snapshot.get("issue_id") == seed_issue.issue_id
    assert revision_wakeup.context_snapshot.get("approval_id") == seed_completion.approval_id
    # ... and the durable continuation FACT the daemon's rework path consumes
    # (``_pending_continuations``) — a pending qa_rejection interaction on the seed.
    assert (
        len(
            store.list_issue_interactions(
                issue_id=seed_issue.issue_id, status="pending", kind="qa_rejection"
            )
        )
        == 1
    )

    # The daemon reworks the seed: the CEO's SECOND turn runs and delegates.
    turn2 = daemon.service_once()
    assert turn2 is not None and turn2.agent_profile_id == _CEO_PROFILE_ID
    # The turn ran off a wakeup the completion-review gate enqueued (NOT a heartbeat /
    # timer / stale-run path — those ids are not in the gate set).
    assert turn2.wakeup_id in gate_wakeup_ids, "turn 2 ran off the completion-review continuation"
    assert ceo_orch.calls == 2, "the daemon reran the CEO off the revision wakeup"
    assert ceo_orch.tool_responses[1]["status"] == "executed", ceo_orch.tool_responses[1]
    # ... and the rework pass consumed the continuation fact (resolved), so it
    # cannot loop forever on a stale interaction.
    assert (
        store.list_issue_interactions(
            issue_id=seed_issue.issue_id, status="pending", kind="qa_rejection"
        )
        == []
    )

    # The CEO's delegation created the engineer's sub-issue (under the seed),
    # assigned to it, and emitted its assignment wakeup — the loop carried the work
    # to the new hire, with no manual assignment anywhere.
    engineer_issues = [
        i for i in store.list_issues(company_profile_id=_COMPANY_ID)
        if i.assignee_agent_profile_id == engineer.profile_id
    ]
    assert len(engineer_issues) == 1
    child = engineer_issues[0]
    assert child.parent_id == seed_issue.issue_id
    eng_wakeups = store.list_wakeups(agent_profile_id=engineer.profile_id, status="queued")
    assert len(eng_wakeups) == 1
    assert eng_wakeups[0].source == WakeupSource.ASSIGNMENT.value

    # --- The freshly-hired agent is woken and the daemon runs it as its bound
    # profile (off its assignment wakeup) — the final "再唤醒" link. ---
    new_orch = _NewAgentOrchestrator()
    new_daemon = HeartbeatDaemon(
        store, new_orch, repo_path=repo, artifact_dir=tmp_path / "artifacts2"
    )
    serviced_agents = []
    while new_orch.ran_as == [] and (serviced := new_daemon.service_once()) is not None:
        serviced_agents.append(serviced.agent_profile_id)
    assert new_orch.ran_as == [engineer.profile_id], "the new agent ran as its bound profile"
    assert engineer.profile_id in serviced_agents
    assert store.get_issue(child.issue_id).status == IssueStatus.IN_REVIEW.value
