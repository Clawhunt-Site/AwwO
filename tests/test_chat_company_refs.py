"""Chat composer @-mention routing for companies (`_resolve_chat_context_refs`).

The Web composer lets a user @-select either an existing company (to manage / view
its tasks) or "create a new company". Both are projected as chat ``context_refs``
that this resolver turns into model-facing guidance text. Stage 1 already surfaces
the kernel company tools to every runtime; this routing is the表现层 layer that makes
the model use them deterministically instead of improvising with files — without
adding any new business semantics (authority still lives in execute_company_command).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from apps.api.main import (
    _chat_selected_company_id,
    _resolve_chat_context_refs,
    _resolve_chat_effective_intent,
    create_app,
)
from superclaw.company_commands import CreateIssueCommand
from superclaw.company_handler import execute_company_command
from superclaw.models import AgentProfile, CompanyProfile, CompanyStatus, GoalSpec, Issue, RunSession
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


def _store(tmp_path) -> StateStore:
    return StateStore(tmp_path / "state.db")


def test_company_ref_steers_to_company_tools_and_lists_issues(tmp_path):
    store = _store(tmp_path)
    company = store.save_company_profile(
        CompanyProfile(name="Tokyo News", status=CompanyStatus.ACTIVE.value)
    )
    agent = store.save_agent_profile(
        AgentProfile(name="reporter", role="implementer", company_profile_id=company.company_profile_id)
    )
    issue = store.save_issue(
        Issue(
            title="draft the morning brief",
            company_profile_id=company.company_profile_id,
            assignee_agent_profile_id=agent.profile_id,
        )
    )

    text = _resolve_chat_context_refs(
        store,
        [{"type": "company", "id": company.company_profile_id, "label": "Tokyo News"}],
    )

    # Resolved to THIS company + a directive to use the kernel company tools, not files.
    assert company.company_profile_id in text
    assert "Tokyo News" in text
    assert "company-management tools" in text
    assert "Do not create files" in text
    # The company's open issue is surfaced so "show me the tasks" has context.
    assert issue.issue_id in text
    assert "draft the morning brief" in text


def test_company_create_ref_steers_to_company_create_not_files(tmp_path):
    store = _store(tmp_path)
    # The text the user typed after @ rides through as metadata.name_hint (the chip
    # label stays "新建公司"); the resolver echoes it as a starting hint for the name.
    text = _resolve_chat_context_refs(
        store,
        [{"type": "company_create", "id": "__create__", "label": "新建公司", "metadata": {"name_hint": "Tokyo News"}}],
    )
    assert "intent=create_company" in text
    assert "company_create tool" in text
    assert "Tokyo News" in text
    # The whole point: do NOT fall back to building files/folders.
    assert "Do NOT create files" in text


def test_company_create_ref_without_name_hint_is_still_routed(tmp_path):
    store = _store(tmp_path)
    # No name hint yet (user just opened @ and picked create) — still routed, but the
    # resolver must not fabricate a "suggested name" line.
    text = _resolve_chat_context_refs(
        store, [{"type": "company_create", "id": "__create__", "label": "新建公司"}]
    )
    assert "intent=create_company" in text
    assert "company_create tool" in text
    assert "starting hint for the name" not in text


def test_unknown_company_ref_degrades_to_not_found(tmp_path):
    store = _store(tmp_path)
    text = _resolve_chat_context_refs(store, [{"type": "company", "id": "company_missing"}])
    # Fail-closed: an unknown company id does not crash, it resolves to a not-found line.
    assert "company_missing" in text
    assert "company-management tools" not in text


# --------------------------------------------------------------------------- #
# the HARD binding: @-selected company HOMES the operator scope (advisor codex)
# --------------------------------------------------------------------------- #
def test_chat_selected_company_id_resolves_and_fails_closed(tmp_path):
    store = _store(tmp_path)
    company = store.save_company_profile(CompanyProfile(name="X", status=CompanyStatus.ACTIVE.value))
    # The first company ref wins, and only after the id verifies against the store.
    assert (
        _chat_selected_company_id(store, [{"type": "company", "id": company.company_profile_id}])
        == company.company_profile_id
    )
    # Fail-closed: an unknown / hard-deleted company id never homes a phantom scope.
    assert _chat_selected_company_id(store, [{"type": "company", "id": "company_ghost"}]) is None
    # A non-company ref (run/file/…) contributes no home.
    assert _chat_selected_company_id(store, [{"type": "run", "id": "r"}]) is None
    assert _chat_selected_company_id(store, []) is None


def test_create_run_session_threads_company_into_execution_context(tmp_path):
    store = _store(tmp_path)
    company = store.save_company_profile(CompanyProfile(name="X", status=CompanyStatus.ACTIVE.value))
    orch = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="manage", description="manage company X"))
    session = orch.create_run_session(
        goal, execution_context_extra={"company_profile_id": company.company_profile_id}
    )
    assert session.execution_context["company_profile_id"] == company.company_profile_id
    # No selection → the key is simply absent (additive, never a clobber/None spill).
    plain = orch.create_run_session(store.create_goal(GoalSpec(title="plain", description="no company")))
    assert "company_profile_id" not in plain.execution_context


def test_selected_company_homes_operator_scope_and_lands_issue_there(tmp_path):
    """End-to-end (the gap advisor codex flagged): a direct chat with execution_context
    homed to company X derives an ADMIN operator scope whose actor company is X, so a
    bare issue_create (no workspace) lands the issue in X — not the default `local`."""
    store = _store(tmp_path)
    target = store.save_company_profile(CompanyProfile(name="Target", status=CompanyStatus.ACTIVE.value))
    other = store.save_company_profile(CompanyProfile(name="Other", status=CompanyStatus.ACTIVE.value))
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="r",
        execution_context={"principal": "op_1", "company_profile_id": target.company_profile_id},
    )
    scope = orch._company_scope_for_run(session)
    assert scope.is_admin is True
    assert scope.actor_company_id == target.company_profile_id

    result = execute_company_command(
        CreateIssueCommand(title="draft the morning brief"),
        scope=scope,
        store=store,
        requested_by=scope.principal_id,
    )
    assert result.outcome == "executed"
    # The issue lands in the SELECTED company, and nowhere else.
    assert any(i.title == "draft the morning brief" for i in store.list_issues(company_profile_id=target.company_profile_id))
    assert store.list_issues(company_profile_id=other.company_profile_id) == []


def test_company_ref_routes_turn_to_orchestrator_delivery(tmp_path):
    """A @company / @company:create overlay forces intent=delivery — the ONLY chat
    execution path that wires the Stage-1 company tool channel. A plain "chat"/"task"
    turn streams the native/codex runtime inline with NO company tools, so without this
    a "@company …" turn would carry only guidance text and no tool to act on."""
    store = _store(tmp_path)
    company = store.save_company_profile(CompanyProfile(name="X", status=CompanyStatus.ACTIVE.value))
    session = store.create_chat_session("t")

    def _intent(refs):
        intent, plugin_id, _sticky = _resolve_chat_effective_intent(
            store,
            session_id=session.session_id,
            message="派活给团队",
            mode="auto",
            base_intent="chat",
            context_refs=refs,
        )
        return intent, plugin_id

    assert _intent([{"type": "company", "id": company.company_profile_id}]) == ("delivery", None)
    assert _intent([{"type": "company_create", "id": "__create__"}]) == ("delivery", None)
    # No company overlay → routing is unchanged (stays a plain chat turn).
    assert _intent([{"type": "run", "id": "r"}]) == ("chat", None)
    assert _intent([]) == ("chat", None)


def test_chat_turn_route_homes_run_to_selected_company(tmp_path, monkeypatch):
    """ROUTE-LEVEL e2e (advisor codex R3): POST /api/chat/turn with a real
    ``context_refs=[{type:company, id:X}]`` — assert the turn routes to the orchestrator
    AND the created run's execution_context is homed to X (so issue_create lands in X,
    not the default `local`). The async run thread is neutralized so no real backend
    executes; we assert the binding at run creation, which is where the scope is set."""
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    target = store.save_company_profile(CompanyProfile(name="Target", status=CompanyStatus.ACTIVE.value))

    captured: dict[str, object] = {}
    real_create = SuperClawOrchestrator.create_run_session

    def spy_create(self, goal, **kwargs):
        session = real_create(self, goal, **kwargs)
        captured["company_profile_id"] = session.execution_context.get("company_profile_id")
        return session

    monkeypatch.setattr(SuperClawOrchestrator, "create_run_session", spy_create)
    # Neutralize the async delivery run thread — no real backend during the test.
    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_guarded", lambda self, **kwargs: None)

    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/turn",
        json={
            "message": "create an issue for the morning brief",
            "context_refs": [{"type": "company", "id": target.company_profile_id}],
        },
    )
    assert resp.status_code == 200, resp.text
    # The @company ref routed to the orchestrator (delivery) AND homed the run to Target.
    assert captured.get("company_profile_id") == target.company_profile_id


def test_chat_stream_route_homes_run_to_selected_company(tmp_path, monkeypatch):
    """Stream parity (advisor codex R3 follow-up): the MAIN Web link is /api/chat/stream.
    Prove the streaming delivery path ALSO homes its orchestrator run to the @-selected
    company — so a "sync fixed, stream missed" regression can never slip back in."""
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    target = store.save_company_profile(CompanyProfile(name="Target", status=CompanyStatus.ACTIVE.value))

    captured: dict[str, object] = {}
    real_create = SuperClawOrchestrator.create_run_session

    def spy_create(self, goal, **kwargs):
        session = real_create(self, goal, **kwargs)
        captured["company_profile_id"] = session.execution_context.get("company_profile_id")
        return session

    monkeypatch.setattr(SuperClawOrchestrator, "create_run_session", spy_create)
    monkeypatch.setattr(SuperClawOrchestrator, "_execute_existing_session_guarded", lambda self, **kwargs: None)

    client = TestClient(create_app(state_path=state_path))
    resp = client.post(
        "/api/chat/stream",
        json={
            "message": "create an issue for the morning brief",
            "context_refs": [{"type": "company", "id": target.company_profile_id}],
        },
    )
    assert resp.status_code == 200, resp.text
    assert captured.get("company_profile_id") == target.company_profile_id
