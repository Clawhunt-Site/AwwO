"""P0 承重墙 tests: charter into runtime (gap C), delegation, and the
company/workspace governance namespace.
"""

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.models import AgentProfile, CompanyProfile, Issue, WorkspaceProfile
from superclaw.state import StateStore
from superclaw import team_kernel


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- charter (gap C) ------------------------------------------------------


def test_charter_is_a_first_class_field(store):
    p = store.save_agent_profile(AgentProfile(name="CEO", role="ceo", charter="Delegate; never write code.", persona="decisive"))
    loaded = store.get_agent_profile(p.profile_id)
    assert loaded.charter == "Delegate; never write code."
    assert loaded.persona == "decisive"
    assert loaded.charter_revision_id  # has a revision for auditing


def test_build_agent_run_context_carries_charter_equipment_and_chain(store):
    ceo = store.save_agent_profile(AgentProfile(name="CEO", role="ceo"))
    eng = store.save_agent_profile(AgentProfile(name="Eng", role="engineer", charter="ship in same heartbeat", reports_to=ceo.profile_id, plugin_allowlist=["git"]))
    ctx = team_kernel.build_agent_run_context(store, eng, available_ids=["git", "other"])
    assert ctx["agent_charter"] == "ship in same heartbeat"
    assert ctx["reports_to"] == ceo.profile_id
    assert ctx["manager_chain"] == [ceo.profile_id]
    # equipment is the governed intersection — git granted, nothing widened
    assert ctx["equipment"]["granted"] == ["git"]


def test_build_agent_run_context_caps_granted_to_parent_constraint(store):
    # layer 3:cross-runtime 委派的 parent_plugin_constraint 进一步收窄 equipment.granted
    # (child ⊆ parent,防提权);capped-out 进 dropped(保持可观测,prompt 与投影一致)。
    eng = store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", plugin_allowlist=["git", "docker"])
    )
    ctx = team_kernel.build_agent_run_context(
        store, eng, available_ids=["git", "docker"], parent_plugin_constraint=frozenset({"git"})
    )
    assert ctx["equipment"]["granted"] == ["git"]
    assert "docker" in ctx["equipment"]["dropped"]


def test_build_agent_run_context_no_constraint_unchanged(store):
    # parent_plugin_constraint=None(顶层 team run / 普通 fan-out)→ 不额外收窄(零行为变化)。
    eng = store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", plugin_allowlist=["git", "docker"])
    )
    ctx = team_kernel.build_agent_run_context(store, eng, available_ids=["git", "docker"])
    assert sorted(ctx["equipment"]["granted"]) == ["docker", "git"]


def test_manager_chain_is_cycle_safe(store):
    a = store.save_agent_profile(AgentProfile(name="A", role="a"))
    b = store.save_agent_profile(AgentProfile(name="B", role="b", reports_to=a.profile_id))
    # force a cycle a -> b -> a
    a.reports_to = b.profile_id
    store.save_agent_profile(a)
    chain = team_kernel.build_agent_run_context(store, b)["manager_chain"]
    assert a.profile_id in chain and len(chain) <= 2  # terminates, no infinite loop


# --- delegation -----------------------------------------------------------


def test_delegate_sub_issue_creates_assigned_child(store):
    eng = store.save_agent_profile(AgentProfile(name="Eng", role="engineer"))
    store.save_workspace_profile(WorkspaceProfile(name="repoA", workspace_id="repoA"))
    parent = store.save_issue(Issue(title="big feature", workspace_id="repoA", goal_id="goal_1"))
    child = team_kernel.delegate_sub_issue(store, parent.issue_id, assignee_agent_profile_id=eng.profile_id, title="subtask")
    assert child.parent_id == parent.issue_id
    assert child.assignee_agent_profile_id == eng.profile_id
    assert child.workspace_id == "repoA"      # inherits parent's execution boundary
    assert child.goal_id == "goal_1"          # keeps goal ancestry
    assert child.status == "todo"


def test_delegate_unknown_profile_fails_closed(store):
    parent = store.save_issue(Issue(title="x"))
    with pytest.raises(KeyError):
        team_kernel.delegate_sub_issue(store, parent.issue_id, assignee_agent_profile_id="nope", title="t")


# --- governance namespace -------------------------------------------------


def test_company_and_workspace_profiles_roundtrip(store):
    c = store.save_company_profile(CompanyProfile(name="Acme", goal="ship", default_token_budget=1000))
    assert store.get_company_profile(c.company_profile_id).default_token_budget == 1000
    w = store.save_workspace_profile(WorkspaceProfile(name="local", company_profile_id=c.company_profile_id, writable_paths=["src"], network_policy="none"))
    got = store.get_workspace_profile(w.workspace_id)
    assert got.writable_paths == ["src"]
    assert got.network_policy == "none"          # execution boundary, not the lock
    assert [x.workspace_id for x in store.list_workspace_profiles(company_profile_id=c.company_profile_id)] == [w.workspace_id]


# --- CLI face -------------------------------------------------------------


def test_cli_charter_delegate_and_cost(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    charter_file = tmp_path / "AGENTS.md"
    charter_file.write_text("You are CEO. Delegate via child issues. Never write code.")

    import json

    ceo = json.loads(runner.invoke(app, ["agent", "create-profile", "CEO", "ceo", "--charter-file", str(charter_file)]).output)
    assert ceo["profile"]["charter_source"] == "template"
    assert "Delegate" in ceo["profile"]["charter"]
    ceo_id = ceo["profile"]["profile_id"]

    eng_id = json.loads(runner.invoke(app, ["agent", "create-profile", "Eng", "engineer", "--reports-to", ceo_id]).output)["profile"]["profile_id"]
    ctx = json.loads(runner.invoke(app, ["agent", "run-context", eng_id]).output)
    assert ctx["manager_chain"] == [ceo_id]

    issue_id = json.loads(runner.invoke(app, ["issue", "create", "Build login"]).output)["issue_id"]
    child = runner.invoke(app, ["issue", "delegate", issue_id, eng_id, "--title", "impl OAuth"])
    assert child.exit_code == 0
    assert json.loads(child.output)["parent_id"] == issue_id

    summary = runner.invoke(app, ["cost", "summary"])
    assert summary.exit_code == 0
    assert json.loads(summary.output)["event_count"] == 0  # no runs yet


def test_unregistered_workspace_is_rejected_fail_closed(store):
    """The free-form workspace bypass is closed (ADR: workspace-trust-container).

    Work may only attach to a registered workspace — the trust container —
    or to the implicit "local" namespace.
    """
    with pytest.raises(ValueError, match="unknown workspace"):
        store.save_issue(Issue(title="orphan", workspace_id="never-registered"))
    with pytest.raises(ValueError, match="unknown workspace"):
        store.save_agent_profile(
            AgentProfile(name="Ghost", role="engineer", workspace_id="never-registered")
        )
    # "" is not an escape hatch either — only the implicit "local" namespace is.
    with pytest.raises(ValueError, match="unknown workspace"):
        store.save_issue(Issue(title="empty", workspace_id=""))
