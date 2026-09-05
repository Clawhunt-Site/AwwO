"""Tests for T11 runtime containment (low-trust review fence).

Every fail-closed property carries an explicit negative: a low-trust fence is
resolved by risk (not opt-in), strictest source wins, an uncontainable backend
is REFUSED (not downgraded), the in-process tool loop denies shell/writes under
the fence, and a low-trust review cannot fan out a deep delegation tree.
"""

import pytest

from superclaw import team_kernel
from superclaw.backends import WorkerLimits, backend_supports_containment, default_backends
from superclaw.containment import (
    CONTAINMENT_PRESETS,
    STANDARD_MAX_DELEGATION_DEPTH,
    ContainmentPolicy,
    containment_denies_tool,
    get_preset,
    resolve_containment_policy,
)
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    GoalSpec,
    Issue,
    IssueStatus,
    WorkspaceKind,
    WorkspaceProfile,
)
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- presets + resolution ----------------------------------------------------


def test_preset_table_shape_and_unknown_falls_back_to_standard():
    assert set(CONTAINMENT_PRESETS) == {"standard", "low_trust_review"}
    low = get_preset("low_trust_review")
    assert low.is_low_trust and low.network_egress == "deny" and low.filesystem == "read_only"
    assert low.permission_mode_floor == "plan" and low.max_delegation_depth == 1
    # An unknown / empty preset name must not widen the fence to something weaker
    # than intended — it resolves to standard (and risk-based floors add strictness
    # where it matters).
    assert get_preset("bogus").preset == "standard"
    assert get_preset(None).preset == "standard"


def test_standard_depth_matches_team_kernel_global_cap():
    # The standard preset's depth must equal the global blast-radius cap; defined
    # twice only to avoid an import cycle, so a parity test pins them together.
    assert STANDARD_MAX_DELEGATION_DEPTH == team_kernel.MAX_DELEGATION_DEPTH


def test_resolution_strictest_source_wins(store):
    co = store.save_company_profile(CompanyProfile(name="Co"))
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="repo", company_profile_id=co.company_profile_id)
    )
    # standard workspace + standard company → standard
    assert resolve_containment_policy(
        store, workspace_id=ws.workspace_id, company_profile_id=co.company_profile_id
    ).preset == "standard"
    # an issue marked low-trust pulls the run into the fence (override stricter)
    issue = Issue(title="review fork PR", metadata={"containment_preset": "low_trust_review"})
    assert resolve_containment_policy(
        store, workspace_id=ws.workspace_id, company_profile_id=co.company_profile_id, issue=issue
    ).is_low_trust


def test_resolution_is_risk_based_not_opt_in(store):
    # A remote-anchored workspace floors to low-trust EVEN without setting a
    # preset — fail-closed by risk, not opt-in. A plain repo stays standard.
    remote = store.save_workspace_profile(WorkspaceProfile(name="remote", kind=WorkspaceKind.REMOTE.value))
    assert resolve_containment_policy(store, workspace_id=remote.workspace_id).is_low_trust
    fork = store.save_workspace_profile(
        WorkspaceProfile(name="fork", metadata={"source_risk": "external"})
    )
    assert resolve_containment_policy(store, workspace_id=fork.workspace_id).is_low_trust
    own = store.save_workspace_profile(WorkspaceProfile(name="own-repo"))
    assert resolve_containment_policy(store, workspace_id=own.workspace_id).preset == "standard"


def test_company_floor_applies_to_all_its_work(store):
    co = store.save_company_profile(
        CompanyProfile(name="UntrustedCo", high_risk_policies={"containment_preset": "low_trust_review"})
    )
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="repo", company_profile_id=co.company_profile_id)
    )
    assert resolve_containment_policy(
        store, workspace_id=ws.workspace_id, company_profile_id=co.company_profile_id
    ).is_low_trust


def test_policy_from_dict_cannot_widen_the_fence():
    # A persisted/tampered dict is canonicalized through the preset table: the
    # preset NAME is authoritative, so flipping a field cannot relax the fence.
    forged = {"preset": "low_trust_review", "network_egress": "allow", "permission_mode_floor": "bypassPermissions"}
    restored = ContainmentPolicy.from_dict(forged)
    assert restored.network_egress == "deny" and restored.permission_mode_floor == "plan"


# --- in-process (B-class) enforcement ---------------------------------------


def test_containment_denies_mutating_tools_even_under_allow_mode():
    low = get_preset("low_trust_review")
    std = get_preset("standard")
    # The fence floor wins over the run's own (permissive) mode.
    assert containment_denies_tool(low, "run_shell", mode="bypassPermissions") is True
    assert containment_denies_tool(low, "write_file", mode="bypassPermissions") is True
    assert containment_denies_tool(low, "read_file", mode="bypassPermissions") is False
    assert containment_denies_tool(low, "list_files", mode="bypassPermissions") is False
    assert containment_denies_tool(low, "delegate", mode="bypassPermissions") is True
    # standard never tightens; no policy is a no-op (standard runs unchanged).
    assert containment_denies_tool(std, "run_shell", mode="bypassPermissions") is False
    assert containment_denies_tool(None, "run_shell", mode="bypassPermissions") is False


def test_b_class_exec_tool_refuses_shell_under_low_trust(tmp_path):
    from superclaw.backends import _RealToolExecution

    runner = _RealToolExecution()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "a",
        containment_policy=get_preset("low_trust_review"),
    )
    out = runner._exec_tool("run_shell", {"command": "echo hi"}, limits, deadline=9e18)
    assert "permission denied" in out and "containment" in out
    # read stays allowed (reviewing = reading)
    (tmp_path / "f.txt").write_text("data")
    assert runner._exec_tool("read_file", {"path": "f.txt"}, limits, deadline=9e18) == "data"


def test_b_class_exec_tool_allows_contained_delegate_request(tmp_path):
    from superclaw.backends import _RealToolExecution
    from superclaw.cross_runtime_delegation import DelegationRequested
    from superclaw.runtime import PermissionPolicy

    runner = _RealToolExecution()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "a",
        permission_policy=PermissionPolicy(mode="plan"),
        containment_policy=get_preset("low_trust_review"),
    )

    with pytest.raises(DelegationRequested) as exc:
        runner._exec_tool(
            "delegate",
            {"subtask": "inspect source without executing it", "runtime": "gemini"},
            limits,
            deadline=9e18,
            parent_tool_call_id="call_contained_delegate",
        )

    assert exc.value.request.subtask == "inspect source without executing it"
    assert exc.value.parent_tool_call_id == "call_contained_delegate"


# --- backend capability contract (fail-closed) ------------------------------


def test_backend_supports_containment_is_fail_closed(monkeypatch):
    reg = default_backends()
    low = get_preset("low_trust_review")
    std = get_preset("standard")
    # standard admitted everywhere (today's behaviour).
    assert all(backend_supports_containment(b, std) for b in reg.values())
    assert backend_supports_containment(reg["local"], None) is True
    # low-trust admitted ONLY by the B-class in-process loop, which OWNS tool
    # execution and enforces containment_denies_read_path (PR-A). Empirical PR-B
    # finding (real-binary canary): A-class native runtimes (codex/claude) cannot be
    # proven to realize the secret-read fence — codex --sandbox read-only does not
    # block reads, and claude's flag-projection read-fence is unverifiable — and the
    # iron law forbids wrapping them in an external OS sandbox, so they are REFUSED.
    assert backend_supports_containment(reg["anthropic-agent"], low) is True
    assert backend_supports_containment(reg["gemini"], low) is True
    assert backend_supports_containment(reg["local"], low) is False
    assert backend_supports_containment(reg["http"], low) is False
    assert backend_supports_containment(reg["grok"], low) is False
    assert backend_supports_containment(reg["anthropic"], low) is False
    # A-class native CLIs (and the codex app-server) are all refused for low-trust.
    assert backend_supports_containment(reg["codex"], low) is False
    assert backend_supports_containment(reg["codex-app-server"], low) is False
    assert backend_supports_containment(reg["claude"], low) is False


# --- orchestrator fail-closed dispatch --------------------------------------


def test_low_trust_run_on_uncontainable_backend_is_refused(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="review", repo_path=str(tmp_path), containment_preset="low_trust_review")
    )
    profile = store.save_agent_profile(
        AgentProfile(name="Reviewer", role="reviewer", backend_policy="local", workspace_id=ws.workspace_id)
    )
    goal = store.create_goal(GoalSpec(title="review", description="review the fork PR"))
    result = orch.run_existing_goal(
        goal,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=10,
        artifact_dir=tmp_path / "artifacts",
        agent_profile_id=profile.profile_id,
    )
    session = result.session if hasattr(result, "session") else result
    # The local (shell-out) backend cannot prove the fence → REFUSED, not run.
    assert session.status == "failed"
    findings = [f for f in store.get_evidence(session.run_id).findings if f.name == "containment_enforced"]
    assert findings and not findings[0].passed
    # And the resolved fence was persisted on the run for audit/resume.
    assert session.execution_context["containment_policy"]["preset"] == "low_trust_review"


# --- delegation depth fence -------------------------------------------------


def test_low_trust_caps_delegation_depth_tighter(store):
    co = store.save_company_profile(CompanyProfile(name="Co"))
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="review", company_profile_id=co.company_profile_id, containment_preset="low_trust_review")
    )
    reviewer = store.save_agent_profile(
        AgentProfile(name="Rev", role="reviewer", company_profile_id=co.company_profile_id, workspace_id=ws.workspace_id)
    )
    root = store.save_issue(
        Issue(title="review PR", company_profile_id=co.company_profile_id, workspace_id=ws.workspace_id,
              status=IssueStatus.TODO.value, assignee_agent_profile_id=reviewer.profile_id)
    )
    # depth 0 -> 1 child is allowed (a reviewer may fan out ONE analysis layer)...
    child = team_kernel.delegate_sub_issue(store, root.issue_id, assignee_agent_profile_id=reviewer.profile_id, title="static-analysis")
    # ...but a SECOND layer is fenced (low_trust max_delegation_depth=1), well
    # below the global cap of 8.
    with pytest.raises(ValueError, match="too deep.*low_trust_review"):
        team_kernel.delegate_sub_issue(store, child.issue_id, assignee_agent_profile_id=reviewer.profile_id, title="deeper")


# --- surface (CLI / API / contract) — thin projection, zero new semantics ----


def test_cli_workspace_containment_sets_preset(tmp_path, monkeypatch):
    import json as _json

    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    wid = _json.loads(runner.invoke(app, ["workspace", "create", "review", "--repo-path", "."]).output)["workspace_id"]
    out = runner.invoke(app, ["workspace", "containment", wid, "low_trust_review"])
    assert out.exit_code == 0, out.output
    assert _json.loads(out.output)["workspace"]["containment_preset"] == "low_trust_review"
    # Unknown preset fails closed.
    assert runner.invoke(app, ["workspace", "containment", wid, "bogus"]).exit_code != 0


def test_api_workspace_containment_endpoint(tmp_path):
    from fastapi.testclient import TestClient

    from apps.api.main import create_app

    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    wid = client.post("/api/team/workspaces", json={"name": "review", "repo_path": "."}).json()["workspace"]["workspace_id"]
    resp = client.post(f"/api/team/workspaces/{wid}/containment", json={"preset": "low_trust_review"})
    assert resp.status_code == 200 and resp.json()["workspace"]["containment_preset"] == "low_trust_review"
    assert client.post(f"/api/team/workspaces/{wid}/containment", json={"preset": "bogus"}).status_code == 422
    assert client.post("/api/team/workspaces/missing/containment", json={"preset": "standard"}).status_code == 404


def test_workspace_projection_carries_effective_containment(store):
    from superclaw.ui_contracts import workspace_projection

    remote = store.save_workspace_profile(WorkspaceProfile(name="remote", kind=WorkspaceKind.REMOTE.value))
    proj = workspace_projection(remote)
    # Stored preset is the default; the EFFECTIVE fence reflects the risk floor.
    assert proj["containment_preset"] == "standard"
    assert proj["effective_containment"] == "low_trust_review"


def test_fanout_child_inherits_parent_containment_fence(tmp_path):
    # A low-trust parent's fan-out child must INHERIT the fence (never escape into
    # an uncontained child) — and so is refused on an uncontainable backend.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="parent", description="review the fork PR"))
    parent = orch.create_run_session(
        goal, backend_policy="local", repo_path=tmp_path, budget_seconds=10, artifact_dir=tmp_path / "a"
    )
    parent.execution_context["containment_policy"] = get_preset("low_trust_review").to_dict()
    parent.status = "running"
    parent.task_graph.tasks[0].status = "running"
    store.save_run(parent)

    child = orch.spawn_child_run(
        parent_run_id=parent.run_id,
        parent_task_id=parent.task_graph.tasks[0].task_id,
        title="child",
        description="sub-review",
        backend_policy="local",
    )
    cs = child.session
    assert cs.execution_context["containment_policy"]["preset"] == "low_trust_review"
    # Inherited fence + uncontainable local backend → refused, not run.
    assert cs.status == "failed"
    findings = [f for f in store.get_evidence(cs.run_id).findings if f.name == "containment_enforced"]
    assert findings and not findings[0].passed


# --- single choke-point resolution (covers non-run_existing_goal paths) ------


def test_resolve_run_containment_covers_bypass_paths(tmp_path):
    # A run created by a path that does NOT pre-resolve (start_existing_goal,
    # /api/chat, autorun) still gets fenced: execute_existing_session resolves
    # from the bound profile's workspace at the single choke point.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    ws = store.save_workspace_profile(WorkspaceProfile(name="review", containment_preset="low_trust_review"))
    profile = store.save_agent_profile(AgentProfile(name="R", role="reviewer", workspace_id=ws.workspace_id))
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=tmp_path, artifact_dir=tmp_path / "a")
    session.execution_context["agent_profile_id"] = profile.profile_id
    session.execution_context.pop("containment_policy", None)
    policy = orch._resolve_run_containment(session)
    assert policy.is_low_trust
    assert session.execution_context["containment_policy"]["preset"] == "low_trust_review"
    # An already-resolved policy is re-used, never relaxed.
    assert orch._resolve_run_containment(session).is_low_trust


# --- read-only fence blocks secret reads (not just shell/writes) -------------


def test_low_trust_read_file_blocks_secret_paths(tmp_path):
    from superclaw.backends import _RealToolExecution

    runner = _RealToolExecution()
    low = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", containment_policy=get_preset("low_trust_review"))
    (tmp_path / ".env").write_text("SECRET=xyz")
    (tmp_path / "app.py").write_text("print(1)")
    blocked = runner._exec_tool("read_file", {"path": ".env"}, low, deadline=9e18)
    assert "permission denied" in blocked and "secret" in blocked.lower()
    # The untrusted SOURCE is still readable — reviewing means reading the diff.
    assert runner._exec_tool("read_file", {"path": "app.py"}, low, deadline=9e18) == "print(1)"
    # Standard runs read anything (no regression).
    std = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", containment_policy=get_preset("standard"))
    assert "SECRET" in runner._exec_tool("read_file", {"path": ".env"}, std, deadline=9e18)


def test_low_trust_read_file_blocks_secret_symlink_and_hardlink(tmp_path):
    from superclaw.backends import _RealToolExecution

    runner = _RealToolExecution()
    low = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", containment_policy=get_preset("low_trust_review"))
    secret = tmp_path / ".env"
    secret.write_text("SECRET=xyz")
    symlink = tmp_path / "safe-name.txt"
    hardlink = tmp_path / "safe-hardlink.txt"
    symlink.symlink_to(secret)
    hardlink.hardlink_to(secret)

    via_symlink = runner._exec_tool("read_file", {"path": "safe-name.txt"}, low, deadline=9e18)
    via_hardlink = runner._exec_tool("read_file", {"path": "safe-hardlink.txt"}, low, deadline=9e18)

    assert "permission denied" in via_symlink
    assert "permission denied" in via_hardlink


# --- delegated child explicitly carries the fence ----------------------------


def test_delegate_stamps_low_trust_on_child_issue(store):
    co = store.save_company_profile(CompanyProfile(name="Co"))
    ws = store.save_workspace_profile(
        WorkspaceProfile(name="review", company_profile_id=co.company_profile_id, containment_preset="low_trust_review")
    )
    rev = store.save_agent_profile(
        AgentProfile(name="R", role="reviewer", company_profile_id=co.company_profile_id, workspace_id=ws.workspace_id)
    )
    root = store.save_issue(
        Issue(title="review", company_profile_id=co.company_profile_id, workspace_id=ws.workspace_id,
              status=IssueStatus.TODO.value, assignee_agent_profile_id=rev.profile_id)
    )
    child = team_kernel.delegate_sub_issue(store, root.issue_id, assignee_agent_profile_id=rev.profile_id, title="analysis")
    assert child.metadata.get("containment_preset") == "low_trust_review"


# --- round-2: cover remaining bypass paths + harden read fence ---------------


def test_resolve_falls_back_to_repo_path_workspace_lookup(tmp_path):
    # An /api/runs-style run carries only repo_path (no workspace_id/profile).
    # The choke point must reverse-look-up the workspace from repo_path so a run
    # whose repo IS a low-trust workspace is still fenced.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    store.save_workspace_profile(
        WorkspaceProfile(name="rev", repo_path=str(tmp_path), containment_preset="low_trust_review")
    )
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=tmp_path, artifact_dir=tmp_path / "a")
    session.execution_context.pop("containment_policy", None)
    session.execution_context.pop("workspace_id", None)
    assert orch._resolve_run_containment(session).is_low_trust


def test_read_fence_covers_more_secret_paths():
    from superclaw.containment import containment_denies_read_path

    low = get_preset("low_trust_review")
    for secret in (".envrc", ".kube/config", ".docker/config.json", "service-account.json",
                   "application_default_credentials.json", "api_token.txt", "my-private-key.pem", ".ssh/id_rsa"):
        assert containment_denies_read_path(low, secret), secret
    for source in ("app.py", "src/main.rs", "README.md", "package.json"):
        assert not containment_denies_read_path(low, source), source


def test_chat_inline_task_refused_in_low_trust_workspace(tmp_path):
    from fastapi.testclient import TestClient

    from apps.api.main import create_app

    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    wid = client.post("/api/team/workspaces", json={"name": "review", "repo_path": "."}).json()["workspace"]["workspace_id"]
    client.post(f"/api/team/workspaces/{wid}/containment", json={"preset": "low_trust_review"})
    # A task-intent chat turn (an @overlay turn) runs the adapter directly
    # (uncontained) — must be refused fail-closed in a low-trust workspace.
    resp = client.post("/api/chat/stream", json={"message": "@skill:review run it", "mode": "auto", "workspace_id": wid})
    assert resp.status_code == 403 and "low_trust_review" in resp.json()["detail"]


def test_pure_chat_turn_also_refused_in_low_trust_workspace(tmp_path):
    # Not just task-intent: ANY interactive chat turn runs the adapter uncontained,
    # so a low-trust workspace refuses pure chat too (contained run-path only).
    from fastapi.testclient import TestClient

    from apps.api.main import create_app

    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    wid = client.post("/api/team/workspaces", json={"name": "review", "repo_path": "."}).json()["workspace"]["workspace_id"]
    client.post(f"/api/team/workspaces/{wid}/containment", json={"preset": "low_trust_review"})
    resp = client.post("/api/chat/stream", json={"message": "what does this code do?", "mode": "chat", "workspace_id": wid})
    assert resp.status_code == 403 and "low_trust_review" in resp.json()["detail"]


def test_resume_picks_up_tightened_fence_never_relaxes(tmp_path):
    # Strictest(persisted, fresh): a run persisted as standard before its workspace
    # was tightened to low-trust must pick up the fence on re-resolution (resume);
    # a persisted low-trust is never relaxed by a later standard scope.
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    ws = store.save_workspace_profile(WorkspaceProfile(name="rev", repo_path=str(tmp_path)))
    profile = store.save_agent_profile(AgentProfile(name="R", role="reviewer", workspace_id=ws.workspace_id))
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=tmp_path, artifact_dir=tmp_path / "a")
    session.execution_context["agent_profile_id"] = profile.profile_id
    session.execution_context["containment_policy"] = get_preset("standard").to_dict()  # persisted standard
    # The workspace is tightened to low-trust AFTER the run was created.
    ws.containment_preset = "low_trust_review"
    store.save_workspace_profile(ws)
    assert orch._resolve_run_containment(session).is_low_trust  # picked up on re-resolve


def test_resolve_takes_strictest_across_session_and_repo_workspaces(tmp_path):
    # A run whose chat-session workspace is standard but whose execution repo is a
    # low-trust workspace must be fenced by the STRICTER of the two (no escape via
    # mismatched scopes).
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    std_ws = store.save_workspace_profile(WorkspaceProfile(name="std", repo_path=str(tmp_path / "std")))
    low_dir = tmp_path / "lowrepo"
    low_dir.mkdir()
    store.save_workspace_profile(WorkspaceProfile(name="low", repo_path=str(low_dir), containment_preset="low_trust_review"))
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=low_dir, artifact_dir=tmp_path / "a")
    # context points the workspace at the STANDARD ws but repo_path at the LOW-trust repo
    session.execution_context["workspace_id"] = std_ws.workspace_id
    session.execution_context["repo_path"] = str(low_dir)
    session.execution_context.pop("containment_policy", None)
    assert orch._resolve_run_containment(session).is_low_trust


def test_chat_guard_refuses_low_trust_repo_with_standard_session(tmp_path):
    from fastapi.testclient import TestClient

    from apps.api.main import create_app

    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    std_dir = tmp_path / "stdrepo"
    std_dir.mkdir()
    low_dir = tmp_path / "lowrepo"
    low_dir.mkdir()
    client.post("/api/team/workspaces", json={"name": "std", "repo_path": str(std_dir)})
    low = client.post("/api/team/workspaces", json={"name": "low", "repo_path": str(low_dir)}).json()["workspace"]["workspace_id"]
    client.post(f"/api/team/workspaces/{low}/containment", json={"preset": "low_trust_review"})
    # Create a real STANDARD-workspace chat session, then point the turn's repo_path
    # at the low-trust repo: the strictest of session+repo wins → refused.
    client.post("/api/chat/stream", json={"message": "hi", "mode": "chat", "repo_path": str(std_dir)})
    sessions = client.get("/api/chat/sessions").json()
    std_sid = (sessions[0] if isinstance(sessions, list) else sessions.get("sessions", [{}])[0]).get("session_id")
    resp = client.post(
        "/api/chat/stream",
        json={"message": "review this", "mode": "chat", "session_id": std_sid, "repo_path": str(low_dir)},
    )
    assert resp.status_code == 403 and "low_trust_review" in resp.json()["detail"]


def test_company_floor_only_low_trust_repo_is_fenced(tmp_path):
    # A workspace whose OWN preset is standard but whose COMPANY declares a
    # low-trust floor must still be fenced — both at the run choke point and the
    # chat guard (the company floor is derived per candidate workspace).
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    co = store.save_company_profile(
        CompanyProfile(name="UntrustedCo", high_risk_policies={"containment_preset": "low_trust_review"})
    )
    repo_dir = tmp_path / "corepo"
    repo_dir.mkdir()
    store.save_workspace_profile(
        WorkspaceProfile(name="repo", company_profile_id=co.company_profile_id, repo_path=str(repo_dir))
    )  # workspace preset itself is standard
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=repo_dir, artifact_dir=tmp_path / "a")
    session.execution_context["repo_path"] = str(repo_dir)
    session.execution_context.pop("containment_policy", None)
    assert orch._resolve_run_containment(session).is_low_trust


def test_resolve_fails_closed_when_repo_lookup_errors(tmp_path, monkeypatch):
    # The run choke point must fail-closed (not silently standard) when it cannot
    # determine a repo's trust state — same posture as the API/CLI chat guards.
    from superclaw import workspace_resolver

    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="g", description="d"))
    session = orch.create_run_session(goal, backend_policy="local", repo_path=tmp_path, artifact_dir=tmp_path / "a")
    session.execution_context["repo_path"] = str(tmp_path)
    session.execution_context.pop("containment_policy", None)

    def _boom(*a, **k):
        raise RuntimeError("workspace lookup backend down")

    monkeypatch.setattr(workspace_resolver, "find_workspace_for_path", _boom)
    assert orch._resolve_run_containment(session).is_low_trust
