"""PR-F: company-management tool projection into the chat (B-class) backends.

Covers the last wiring of the "chat manages company" feature: the 8 company
commands projected as in-process agent tools, dispatched through the
orchestrator-bound resolver into ``company_handler.execute_company_command``.

What is exercised here:
  * single-source schema derivation (ui_contracts -> Gemini / Anthropic shapes);
  * the projection toggle (default ON; fail-closed on a garbled kill switch; and
    fail-closed when no store/resolver is bound);
  * the ``_exec_tool`` dispatch (a company tool name -> the resolver, error
    fail-closed when no resolver, posture/containment denial);
  * the orchestrator resolver end-to-end (a tool call really creates a company /
    issue; archive -> a persisted pending approval; malformed args -> an error
    string, never a crashed run; the derived scope: admin for direct chat,
    confined for a team/sub-agent run).
"""

from __future__ import annotations

import json
import time

import pytest

from superclaw.backends import (
    AnthropicAgentBackend,
    GeminiAgentBackend,
    WorkerLimits,
    _RealToolExecution,
)
from superclaw.company_commands import (
    COMMAND_REGISTRY,
    COMPANY_TOOL_NAMES,
)
from superclaw.models import (
    AgentProfile,
    ApprovalStatus,
    ApprovalType,
    CompanyProfile,
    CompanyStatus,
    GoalSpec,
    RunSession,
)
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.permissions import _MUTATING_TOOLS
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore
from superclaw.ui_contracts import (
    COMPANY_COMMAND_TOOLS,
    TOOL_NAME_TO_COMMAND_TYPE,
    build_company_command_tool_schema,
)


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #
@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store: StateStore, *, name="Acme") -> CompanyProfile:
    company = CompanyProfile(name=name, status=CompanyStatus.ACTIVE.value)
    return store.save_company_profile(company)


def _agent(store: StateStore, company_id: str, *, name="Worker", role="implementer") -> AgentProfile:
    profile = AgentProfile(name=name, role=role, company_profile_id=company_id)
    return store.save_agent_profile(profile)


def _limits(tmp_path, *, resolver=None, mode="allow", containment=None) -> WorkerLimits:
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        permission_policy=PermissionPolicy.from_values(mode=mode),
        company_command_resolver=resolver,
        containment_policy=containment,
    )


def _direct_chat_session(company_id: str | None = None) -> RunSession:
    ec: dict = {"principal": "op_1"}
    if company_id is not None:
        ec["company_profile_id"] = company_id
    return RunSession(goal_id="g", run_id="run_direct", execution_context=ec)


# --------------------------------------------------------------------------- #
# (2) Single-source schema derivation
# --------------------------------------------------------------------------- #
def test_tool_names_match_command_registry():
    # The closed map and the registry can never drift (the single-source guard).
    assert set(TOOL_NAME_TO_COMMAND_TYPE.values()) == set(COMMAND_REGISTRY)
    assert set(COMPANY_TOOL_NAMES) == set(TOOL_NAME_TO_COMMAND_TYPE)
    assert len(COMPANY_COMMAND_TOOLS) == 24


def test_gemini_schema_derived_from_single_source():
    tools = build_company_command_tool_schema("gemini")
    assert len(tools) == len(COMPANY_COMMAND_TOOLS)
    names = set()
    for tool in tools:
        assert tool["type"] == "function"
        fn = tool["function"]
        assert set(fn) == {"name", "description", "parameters"}
        assert fn["parameters"]["type"] == "object"
        names.add(fn["name"])
    assert names == set(TOOL_NAME_TO_COMMAND_TYPE)


def test_anthropic_schema_derived_from_single_source():
    tools = build_company_command_tool_schema("anthropic")
    assert len(tools) == len(COMPANY_COMMAND_TOOLS)
    names = set()
    for tool in tools:
        assert set(tool) == {"name", "description", "input_schema"}
        assert tool["input_schema"]["type"] == "object"
        names.add(tool["name"])
    assert names == set(TOOL_NAME_TO_COMMAND_TYPE)


def test_schema_projection_is_a_deep_copy():
    # Mutating the projected result must never corrupt the source contract.
    tools = build_company_command_tool_schema("anthropic")
    tools[0]["input_schema"]["properties"]["__hacked__"] = {"type": "string"}
    for source in COMPANY_COMMAND_TOOLS:
        assert "__hacked__" not in source["input_schema"]["properties"]


def test_both_schemas_carry_identical_company_command_set():
    g = {t["function"]["name"] for t in build_company_command_tool_schema("gemini")}
    a = {t["name"] for t in build_company_command_tool_schema("anthropic")}
    assert g == a == set(TOOL_NAME_TO_COMMAND_TYPE)


# --------------------------------------------------------------------------- #
# (1) / (5) Projection toggle + fail-closed injection
# --------------------------------------------------------------------------- #
def _injects(backend, tmp_path, schema, *, resolver, env=None, monkeypatch=None):
    if monkeypatch is not None:
        if env is None:
            monkeypatch.delenv("SUPERCLAW_COMPANY_TOOLS", raising=False)
        else:
            monkeypatch.setenv("SUPERCLAW_COMPANY_TOOLS", env)
    limits = _limits(tmp_path, resolver=resolver)
    out = backend._maybe_add_company_tools([], limits=limits, schema=schema)
    if schema == "gemini":
        return {t["function"]["name"] for t in out}
    return {t["name"] for t in out}


def test_company_tools_injected_when_enabled_and_resolver_bound(tmp_path, monkeypatch):
    backend = GeminiAgentBackend()
    names = _injects(
        backend, tmp_path, "gemini", resolver=lambda ct, a: "ok", monkeypatch=monkeypatch
    )
    assert names == set(TOOL_NAME_TO_COMMAND_TYPE)


def test_company_tools_not_injected_without_resolver(tmp_path, monkeypatch):
    # Fail-closed wiring: even default-ON, no store/resolver => no dead tool.
    backend = AnthropicAgentBackend()
    names = _injects(backend, tmp_path, "anthropic", resolver=None, monkeypatch=monkeypatch)
    assert names == set()


def test_company_tools_not_injected_when_disabled_by_env(tmp_path, monkeypatch):
    backend = GeminiAgentBackend()
    names = _injects(
        backend, tmp_path, "gemini", resolver=lambda ct, a: "ok", env="false", monkeypatch=monkeypatch
    )
    assert names == set()


def test_company_tools_not_injected_on_garbled_env(tmp_path, monkeypatch):
    # A mutating projection's kill switch fails CLOSED on an unrecognized value.
    backend = AnthropicAgentBackend()
    names = _injects(
        backend, tmp_path, "anthropic", resolver=lambda ct, a: "ok", env="maybe", monkeypatch=monkeypatch
    )
    assert names == set()


# --------------------------------------------------------------------------- #
# (3) _exec_tool dispatch
# --------------------------------------------------------------------------- #
def test_exec_tool_routes_company_name_to_resolver(tmp_path):
    seen: list[tuple[str, dict]] = []

    def resolver(command_type: str, args: dict) -> str:
        seen.append((command_type, args))
        return "RESOLVED"

    runner = _RealToolExecution()
    out = runner._exec_tool(
        "company_create",
        {"name": "NewCo"},
        _limits(tmp_path, resolver=resolver),
        time.monotonic() + 30,
    )
    assert out == "RESOLVED"
    assert seen == [("company.create", {"name": "NewCo"})]


def test_exec_tool_company_fail_closed_without_resolver(tmp_path):
    runner = _RealToolExecution()
    out = runner._exec_tool(
        "issue_create",
        {"title": "x"},
        _limits(tmp_path, resolver=None),
        time.monotonic() + 30,
    )
    assert out.startswith("error: company tool 'issue_create' is unavailable")


def test_exec_tool_company_denied_under_readonly_posture(tmp_path):
    # Company tools are MUTATING: a plan-mode run must be denied BEFORE dispatch.
    called = []
    runner = _RealToolExecution()
    out = runner._exec_tool(
        "company_create",
        {"name": "x"},
        _limits(tmp_path, resolver=lambda ct, a: called.append(1) or "ok", mode="plan"),
        time.monotonic() + 30,
    )
    assert "permission denied" in out
    assert "read-only" in out
    assert not called  # never reached the resolver


def test_company_tools_are_classified_mutating():
    assert set(COMPANY_TOOL_NAMES) <= _MUTATING_TOOLS


def test_dispatch_map_and_mutating_set_are_single_source():
    # The dispatch map (ui_contracts), the canonical name source (company_commands),
    # and the mutating-classification (permissions) must describe ONE tool set —
    # not three hand-maintained lists that can silently drift (advisor finding #3).
    from superclaw.marketplace_commands import MARKETPLACE_WRITE_TOOL_NAMES

    dispatch = set(TOOL_NAME_TO_COMMAND_TYPE)
    canonical = set(COMPANY_TOOL_NAMES)
    # _MUTATING_TOOLS now also carries the base shell/file/delegate tools AND the
    # marketplace write tools (P3); subtract both to isolate the company portion.
    mutating_company = (
        _MUTATING_TOOLS
        - {"run_shell", "write_file", "delegate"}
        - set(MARKETPLACE_WRITE_TOOL_NAMES)
    )
    assert dispatch == canonical == mutating_company


# --------------------------------------------------------------------------- #
# (4) / (7) Orchestrator resolver end-to-end + scope derivation
# --------------------------------------------------------------------------- #
def test_resolver_creates_company_end_to_end(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    session = _direct_chat_session()
    resolver = orch._build_company_command_resolver(session)

    out = resolver("company.create", {"name": "ResolvedCo", "goal": "ship"})
    payload = json.loads(out)
    assert payload["status"] == "executed"
    new_id = payload["detail"]["company_profile_id"]
    saved = store.get_company_profile(new_id)
    assert saved.name == "ResolvedCo"
    # owner_id is server-injected from the principal, never the tool args.
    assert saved.owner_id == "op_1"


def test_resolver_creates_issue_end_to_end(tmp_path, store):
    company = _company(store)
    orch = SuperClawOrchestrator(store)
    session = _direct_chat_session(company.company_profile_id)
    resolver = orch._build_company_command_resolver(session)

    out = resolver("issue.create", {"title": "do the thing", "kind": "delivery"})
    payload = json.loads(out)
    assert payload["status"] == "executed"
    issue = store.get_issue(payload["detail"]["issue_id"])
    assert issue.title == "do the thing"
    assert issue.company_profile_id == company.company_profile_id


def test_resolver_archive_returns_pending_approval(tmp_path, store):
    company = _company(store)
    orch = SuperClawOrchestrator(store)
    session = _direct_chat_session(company.company_profile_id)
    resolver = orch._build_company_command_resolver(session)

    out = resolver("company.archive", {"company_profile_id": company.company_profile_id})
    payload = json.loads(out)
    assert payload["status"] == "pending_approval"
    assert payload["executed"] is False
    assert "STOP" in payload["message"]
    approval_id = payload["approval_id"]
    assert approval_id
    # The approval is really persisted (run-state truth, not just prose).
    approvals = store.list_approvals()
    matched = [a for a in approvals if a.approval_id == approval_id]
    assert matched and matched[0].type == ApprovalType.COMPANY_COMMAND.value
    assert matched[0].status == ApprovalStatus.PENDING.value
    # Two-phase archive (contract E): the request FREEZES the company (phase 1)
    # so it hosts no new work during the human confirmation window. It is NOT
    # dissolved yet — that only lands when the human grants the approval.
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.FROZEN.value
    )


def test_resolver_malformed_args_returns_error_not_crash(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    session = _direct_chat_session()
    resolver = orch._build_company_command_resolver(session)

    # Unknown field -> the command model's fail-closed from_dict raises ValueError;
    # the resolver maps it to an error string, never a crashed run.
    out = resolver("company.create", {"name": "X", "bogus_field": 1})
    assert out.startswith("error: invalid company command")
    assert "do not retry" in out


def test_resolver_unknown_command_type_returns_error(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_command_resolver(_direct_chat_session())
    out = resolver("company.nope", {"x": 1})
    assert out.startswith("error: invalid company command")


def test_resolver_scope_denial_returns_forbidden(tmp_path, store):
    # A direct-chat operator is admin, but a NON-existent target still fails the
    # scope/lifecycle resolution -> a clean forbidden/error string, no crash.
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_command_resolver(_direct_chat_session())
    out = resolver("company.update", {"company_profile_id": "ghost", "goal": "x"})
    assert out.startswith("error: forbidden") or out.startswith("error: company command failed")
    assert "do not retry" in out


def test_direct_chat_scope_is_admin(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(_direct_chat_session("home_co"))
    assert scope.is_admin is True
    assert scope.principal_id == "op_1"
    assert scope.actor_company_id == "home_co"


def test_direct_chat_scope_defaults_actor_company_when_absent(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(_direct_chat_session())
    assert scope.is_admin is True
    assert scope.actor_company_id == "local"


def test_team_run_scope_is_confined_not_admin(tmp_path, store):
    # A sub-agent run (carries agent_run_context) is confined to its OWN company
    # and is NEVER admin: it cannot target another company (advisor finding #2).
    company = _company(store)
    other = _company(store, name="Other")
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_team",
        execution_context={
            "principal": "op_1",
            "agent_run_context": {"agent_profile_id": agent.profile_id},
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    assert scope.actor_company_id == company.company_profile_id
    assert scope.permits(company.company_profile_id) is True
    assert scope.permits(other.company_profile_id) is False


def test_respond_run_comment_attributes_to_agent_not_operator(tmp_path, store):
    # Regression lock (attribution): a respond run carries the agent's profile id in
    # execution_context (daemon._respond → run_goal writes agent_profile_id). Its
    # derived scope MUST be is_admin=False with the agent identity, so a thread
    # comment it posts attributes to ("agent", profile_id) — NEVER ("user",
    # "local_user"). A respond run can never launder into the operator/admin branch
    # (is_team_run keys on agent_profile_id KEY PRESENCE), which is why the historical
    # `local_user` reply attribution cannot recur on current code.
    from superclaw.company_commands import PostIssueCommentCommand
    from superclaw.company_handler import execute_company_command
    from superclaw.models import Issue

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    issue = store.save_issue(
        Issue(title="t", company_profile_id=company.company_profile_id,
              assignee_agent_profile_id=agent.profile_id)
    )
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_respond",
        execution_context={
            "principal": "op_1",
            "agent_profile_id": agent.profile_id,  # respond-run shape
            "issue_id": issue.issue_id,
            "respond_mode": True,
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    assert scope.actor_agent_profile_id == agent.profile_id
    # The comment posted under that derived scope is authored as the AGENT, not user.
    result = execute_company_command(
        PostIssueCommentCommand(issue_id=issue.issue_id, body="on it"),
        scope=scope, store=store, requested_by=agent.profile_id,
    )
    assert result.outcome == "executed"
    comment = store.list_issue_comments(issue.issue_id)[0]
    assert comment.author_type == "agent"
    assert comment.author_id == agent.profile_id


def _respond_session(run_id, agent_profile_id, *, issue_id, respond_mode=True):
    ec = {"principal": "op_1", "agent_profile_id": agent_profile_id}
    if issue_id is not None:
        ec["issue_id"] = issue_id
    if respond_mode is not None:
        ec["respond_mode"] = respond_mode
    return RunSession(goal_id="g", run_id=run_id, execution_context=ec)


def test_respond_grant_bound_for_confined_same_company_issue(tmp_path, store):
    # B-class (in-loop) scope: a confined team respond run on a same-company issue
    # carries respond_issue_id == that issue (the run-scoped grant, #2).
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    other = _agent(store, company.company_profile_id, name="Owner")
    from superclaw.models import Issue

    issue = store.save_issue(
        Issue(title="t", company_profile_id=company.company_profile_id,
              assignee_agent_profile_id=other.profile_id)
    )
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(
        _respond_session("run_r", agent.profile_id, issue_id=issue.issue_id)
    )
    assert scope.is_admin is False
    assert scope.respond_issue_id == issue.issue_id
    # The scope is bound to THIS run so the grant can be consumed single-use
    # (autonomy门 keys the consume by (run_id, issue_id)). Without this the grant
    # would never consume and the comment would fall back to ownership.
    assert scope.run_id == "run_r"


def test_respond_grant_absent_without_respond_mode(tmp_path, store):
    # No respond_mode → no grant, even if issue_id is present.
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    from superclaw.models import Issue

    issue = store.save_issue(
        Issue(title="t", company_profile_id=company.company_profile_id)
    )
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(
        _respond_session("run_r", agent.profile_id, issue_id=issue.issue_id, respond_mode=None)
    )
    assert scope.respond_issue_id is None


def test_respond_grant_absent_for_cross_company_issue(tmp_path, store):
    # The issue belongs to a DIFFERENT company than the agent's home → no grant
    # (fail-closed: a respond run can never reach across the company boundary).
    company = _company(store)
    other_co = _company(store, name="Other")
    agent = _agent(store, company.company_profile_id)
    from superclaw.models import Issue

    foreign = store.save_issue(
        Issue(title="t", company_profile_id=other_co.company_profile_id)
    )
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(
        _respond_session("run_r", agent.profile_id, issue_id=foreign.issue_id)
    )
    assert scope.respond_issue_id is None


def test_respond_grant_absent_for_unknown_issue(tmp_path, store):
    # respond_mode set but issue_id does not resolve → no grant (fail-closed).
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(
        _respond_session("run_r", agent.profile_id, issue_id="issue_ghost")
    )
    assert scope.respond_issue_id is None


def test_respond_grant_never_for_operator(tmp_path, store):
    # The direct-chat operator (admin) never gets a respond grant even if its
    # execution_context carries respond_mode + a same-company issue.
    company = _company(store)
    from superclaw.models import Issue

    issue = store.save_issue(
        Issue(title="t", company_profile_id=company.company_profile_id)
    )
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_op",
        execution_context={
            "principal": "op_1",
            "company_profile_id": company.company_profile_id,
            "issue_id": issue.issue_id,
            "respond_mode": True,
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is True  # operator branch (no agent key)
    assert scope.respond_issue_id is None


def test_team_run_scope_ignores_explicit_company_uses_profile(tmp_path, store):
    # A team run whose agent is in company A but whose execution_context names a
    # DIFFERENT company B must be scoped to A (the agent's real company), NOT B —
    # the explicit context id is untrusted for scoping (advisor finding #1).
    company_a = _company(store, name="A")
    company_b = _company(store, name="B")
    agent = _agent(store, company_a.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_team_cross",
        execution_context={
            "principal": "op_1",
            "company_profile_id": company_b.company_profile_id,  # untrusted decoy
            "agent_run_context": {"agent_profile_id": agent.profile_id},
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    assert scope.actor_company_id == company_a.company_profile_id
    assert scope.permits(company_a.company_profile_id) is True
    assert scope.permits(company_b.company_profile_id) is False


def test_team_signal_via_bare_agent_profile_id_is_not_admin(tmp_path, store):
    # A run carrying ONLY agent_profile_id (no/empty agent_run_context) is still a
    # team run and must NEVER fall through to operator-admin (advisor finding #2).
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_bare_profile",
        execution_context={
            "principal": "op_1",
            "agent_profile_id": agent.profile_id,
            "agent_run_context": {},  # empty/malformed — must NOT grant admin
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    assert scope.actor_company_id == company.company_profile_id


@pytest.mark.parametrize(
    "ec",
    [
        {"principal": "op_1", "agent_run_context": {}},
        {"principal": "op_1", "agent_run_context": "nope"},
        {"principal": "op_1", "agent_run_context": None},
    ],
)
def test_malformed_team_context_never_grants_admin(tmp_path, store, ec):
    # The mere PRESENCE of agent_run_context (even empty/non-dict/None) is a team
    # signal: it must fail closed to a confined, non-admin scope, NEVER fall through
    # to operator-admin (advisor finding #2 edge case; mirrors _granted_plugin_ids).
    orch = SuperClawOrchestrator(store)
    session = RunSession(goal_id="g", run_id="run_malformed_ctx", execution_context=ec)
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    assert scope.permits("any_real_company") is False


def test_team_run_scope_fails_closed_when_company_unresolved(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_team_bad",
        execution_context={
            "principal": "op_1",
            # agent_run_context present but no resolvable company.
            "agent_run_context": {"agent_profile_id": "ghost_agent"},
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is False
    # Pinned to a sentinel that matches no real company -> can touch nothing.
    assert scope.permits("any_real_company") is False


def test_team_run_scope_carries_acting_agent_profile_id(tmp_path, store):
    # 柱子 1b: a team run's scope carries the bound agent profile id (server-injected
    # from the profile, never self-reported) so the autonomy门 can enforce subtree
    # confinement and attribute comments.
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_acting_agent",
        execution_context={
            "principal": "op_1",
            "agent_run_context": {"agent_profile_id": agent.profile_id},
        },
    )
    scope = orch._company_scope_for_run(session)
    assert scope.actor_agent_profile_id == agent.profile_id


def test_direct_chat_scope_has_no_acting_agent(tmp_path, store):
    # The operator (direct chat) has no acting AGENT id: autonomy confinement does
    # not apply to it.
    orch = SuperClawOrchestrator(store)
    scope = orch._company_scope_for_run(_direct_chat_session("home_co"))
    assert scope.actor_agent_profile_id is None


def test_bind_agent_identity_wires_company_resolver(tmp_path, store):
    orch = SuperClawOrchestrator(store)
    goal = GoalSpec(title="t", description="d")
    session = _direct_chat_session()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path)
    _bound_goal, bound_limits = orch._bind_agent_identity(session, goal, limits)
    assert bound_limits.company_command_resolver is not None
    # And it really resolves against the store.
    out = bound_limits.company_command_resolver("company.create", {"name": "WiredCo"})
    assert json.loads(out)["status"] == "executed"
