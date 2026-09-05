"""Tests for charter consumption: agent_prompt composition + orchestrator binding.

The charter became a *consumed* contract in phase 1 of the daemon pivot
(docs/agent-team-kernel-daemon-pivot.md §7): build_agent_run_context output is
rendered into a system-prompt prefix and the bound profile's model rides
WorkerLimits.model_override. Positive and fail-closed negative coverage per the
feature-boundary discipline.
"""

import dataclasses

from superclaw.agent_prompt import compose_agent_system_prompt
from superclaw.backends import WorkerLimits
from superclaw.models import AgentProfile, GoalSpec
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


def _context(**overrides):
    base = {
        "agent_profile_id": "agent_x",
        "agent_name": "Eng",
        "agent_role": "engineer",
        "agent_title": "Senior Engineer",
        "agent_persona": "terse and precise",
        "agent_charter": "Implement issues end to end. Never edit docs without an issue.",
        "agent_default_instructions": "Prefer small diffs.",
        "reports_to": "agent_ceo",
        "manager_chain": ["agent_ceo"],
        "backend_policy": "codex",
        "model": "gpt-5.5",
        "equipment": {
            "requested": ["git", "revoked-tool"],
            "granted": ["git"],
            "dropped": ["revoked-tool"],
            "skills": {"requested": ["deploy"], "granted": [], "dropped": ["deploy"]},
        },
    }
    base.update(overrides)
    return base


# --- prompt composition ----------------------------------------------------


def test_compose_renders_identity_charter_chain_and_granted_only():
    prompt = compose_agent_system_prompt(_context())
    assert "Eng — engineer — Senior Engineer" in prompt
    assert "terse and precise" in prompt
    assert "Never edit docs without an issue." in prompt
    assert "Prefer small diffs." in prompt
    assert "You report to: agent_ceo" in prompt
    assert "Plugins: git" in prompt
    # Withheld equipment is named as unavailable — never presented as usable.
    assert "revoked-tool" in prompt and "unavailable" in prompt
    assert "deploy" in prompt
    # The inviolable approval-gate rule always rides along.
    assert "human approval" in prompt


def test_compose_carries_team_collaboration_protocol():
    # A team-bound run is told to coordinate through the issue thread (comment +
    # @mention) and to reply to whoever pinged it — the standing protocol that
    # makes the kernel's mention-wake actually produce a reply (Paperclip parity).
    prompt = compose_agent_system_prompt(_context())
    assert "Team collaboration protocol" in prompt
    assert "@-mention" in prompt
    assert "must get a reply" in prompt


def test_envelope_charter_layer_carries_collaboration_protocol():
    from superclaw.agent_prompt import build_agent_prompt_envelope

    env = build_agent_prompt_envelope(_context(), user_turn="do the thing")
    charter_layer = next(
        layer for layer in env.layers if layer.kind.value == "agent_charter"
    )
    assert "Team collaboration protocol" in charter_layer.content
    assert "@-mention" in charter_layer.content


def test_collaboration_protocol_absent_without_team_identity():
    # No identity → not a team run → no collaboration block (nothing to coordinate).
    # Both builders early-return on missing identity BEFORE the protocol is appended,
    # so even a context that carries a charter / equipment but no name+role must NOT
    # leak the protocol into a non-team run.
    from superclaw.agent_prompt import build_agent_prompt_envelope

    assert "Team collaboration protocol" not in compose_agent_system_prompt({})
    no_identity = {"agent_charter": "do things", "equipment": {"granted": ["git"]}}
    assert compose_agent_system_prompt(no_identity) == ""
    assert "Team collaboration protocol" not in compose_agent_system_prompt(no_identity)
    env = build_agent_prompt_envelope(no_identity, user_turn="x")
    charter_layer = next(layer for layer in env.layers if layer.kind.value == "agent_charter")
    assert "Team collaboration protocol" not in charter_layer.content


def test_compose_empty_context_returns_empty_prefix():
    assert compose_agent_system_prompt({}) == ""
    assert compose_agent_system_prompt({"equipment": {"granted": ["x"]}}) == ""


def test_compose_tolerates_missing_keys():
    prompt = compose_agent_system_prompt({"agent_name": "Solo"})
    assert "Solo" in prompt
    assert "Plugins: (none)" in prompt
    assert "Skills: (none)" in prompt


# --- orchestrator binding (the consumption point) --------------------------


def test_bind_agent_identity_prefixes_goal_and_fills_model(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="T", description="Do the thing"))
    # The run's backend MUST match the bound profile's (the ctx is for "codex"):
    # the model/effort projection is runtime-gated, so a mismatched backend would
    # (correctly) skip it — that gated case is covered separately in test_orchestrator.
    session = orchestrator.create_run_session(goal, backend_policy="codex", repo_path=tmp_path)
    session.execution_context["agent_run_context"] = _context()

    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path)
    bound_goal, bound_limits = orchestrator._bind_agent_identity(session, goal, limits)
    assert bound_goal.description == "Do the thing"
    assert bound_limits.prompt_envelope is not None
    charter = bound_limits.prompt_envelope.get("agent_charter")
    assert charter is not None
    assert "Never edit docs without an issue." in charter.content
    assert bound_limits.model_override == "gpt-5.5"
    # The stored goal stays clean — binding is in-memory only.
    assert store.get_goal(goal.goal_id).description == "Do the thing"


def test_bind_agent_identity_explicit_model_wins(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="T", description="Do the thing"))
    session = orchestrator.create_run_session(goal, backend_policy="local", repo_path=tmp_path)
    session.execution_context["agent_run_context"] = _context()

    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path, model_override="surface-pick")
    _, bound_limits = orchestrator._bind_agent_identity(session, goal, limits)
    assert bound_limits.model_override == "surface-pick"


def test_bind_agent_identity_noop_without_context(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="T", description="Do the thing"))
    session = orchestrator.create_run_session(goal, backend_policy="local", repo_path=tmp_path)

    # Seed a non-default field so the "everything except the gate is preserved" check
    # below actually exercises preservation rather than comparing all-defaults.
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path, model_override="surface-pick")
    same_goal, same_limits = orchestrator._bind_agent_identity(session, goal, limits)
    # No agent context → identity binding is a noop: the goal is untouched and the caller's
    # model override is preserved (not stripped, not overridden). The ONLY deltas are the
    # two ALWAYS-wired in-process tool hooks: the B-class escalation gate (Direction 4 D1,
    # so the tool layer fail-closes rather than running unsupervised) and the
    # company-command resolver (so the direct user can manage their own companies from chat
    # — it is wired even without agent context). Assert both are attached and that nothing
    # else changed, rather than the (now stale) `same_limits is limits`.
    assert same_goal is goal
    assert same_limits.model_override == limits.model_override
    assert same_limits.escalation_gate is not None
    assert same_limits.company_command_resolver is not None
    # P3: the marketplace resolver is the third ALWAYS-wired hook (same rationale as
    # the company resolver — the direct user can manage the marketplace from chat
    # even without agent context).
    assert same_limits.marketplace_command_resolver is not None
    # Roadmap P0: the company READ resolver is the fourth ALWAYS-wired hook (the
    # direct user can SEE their companies from chat even without agent context).
    assert same_limits.company_read_resolver is not None
    assert dataclasses.replace(
        same_limits, escalation_gate=None, company_command_resolver=None,
        marketplace_command_resolver=None, company_read_resolver=None,
    ) == dataclasses.replace(
        limits, escalation_gate=None, company_command_resolver=None,
        marketplace_command_resolver=None, company_read_resolver=None,
    )


# --- child-run identity: never claim a ghost profile ------------------------


def _running_parent(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent", description="Spawn children"))
    session = orchestrator.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path
    )
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    return store, orchestrator, session


def test_child_run_never_claims_a_ghost_profile(tmp_path):
    store, orchestrator, session = _running_parent(tmp_path)
    _, child_session, _ = orchestrator._create_linked_child(
        session,
        session.task_graph.tasks[0].task_id,
        title="Child",
        description="work",
        agent_profile_id="agent_ghost",
    )
    # Degrade must not attribute the run (and its cost) to a profile that does
    # not exist — and it must leave a durable trace for the operator.
    assert "agent_profile_id" not in child_session.execution_context
    assert "agent_run_context" not in child_session.execution_context
    events = store.list_events(session.run_id)
    assert any(e["type"] == "agent.profile_missing" for e in events)
    # The spawn event must not claim the ghost identity either — only record
    # what was *requested*.
    spawned = next(e for e in events if e["type"] == "child_run.spawned")
    assert spawned["payload"]["agent_profile_id"] is None
    assert spawned["payload"]["requested_agent_profile_id"] == "agent_ghost"


def test_child_run_binds_real_profile_identity_and_model(tmp_path):
    store, orchestrator, session = _running_parent(tmp_path)
    profile = AgentProfile(name="Eng", role="engineer", model="gpt-5.5", charter="Build.")
    store.save_agent_profile(profile)
    _, child_session, exec_kwargs = orchestrator._create_linked_child(
        session,
        session.task_graph.tasks[0].task_id,
        title="Child",
        description="work",
        agent_profile_id=profile.profile_id,
    )
    assert child_session.execution_context["agent_profile_id"] == profile.profile_id
    assert child_session.execution_context["agent_run_context"]["agent_name"] == "Eng"
    # The bound profile's model became the child's model default.
    assert exec_kwargs["model"] == "gpt-5.5"


# --- root-run profile binding ----------------------------------------------


def test_run_goal_binds_root_run_to_profile(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    # The run uses the profile's OWN backend (the normal path — the daemon/CLI pass
    # backend_policy=profile.backend_policy). Only then does the profile's model become
    # the run default; a run forced onto a DIFFERENT backend is gated (runtime-specific
    # model/effort), covered in test_orchestrator.
    profile = AgentProfile(name="Eng", role="engineer", backend_policy="local", model="gpt-5.5", charter="Build.")
    store.save_agent_profile(profile)

    result = orchestrator.run_goal(
        title="Bound",
        description="Do bound work",
        dry_run=True,
        backend_policy="local",
        repo_path=tmp_path,
        agent_profile_id=profile.profile_id,
    )
    saved = store.get_run(result.session.run_id)
    assert saved.execution_context["agent_profile_id"] == profile.profile_id
    ctx = saved.execution_context["agent_run_context"]
    assert ctx["agent_name"] == "Eng"
    assert ctx["model"] == "gpt-5.5"
    # The profile's model became the run's default model.
    assert saved.execution_context["model"] == "gpt-5.5"


def test_run_goal_unknown_profile_fails_closed(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)
    try:
        orchestrator.run_goal(
            title="Bound",
            description="Do bound work",
            dry_run=True,
            backend_policy="local",
            repo_path=tmp_path,
            agent_profile_id="agent_missing",
        )
    except KeyError:
        return
    raise AssertionError("unknown agent_profile_id must fail closed, not run unbound")
