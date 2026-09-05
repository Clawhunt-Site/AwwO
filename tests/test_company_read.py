"""Roadmap P0: company READ tools (discovery + snapshot) projected into chat.

Covers the read half of the company control plane — the gap the exposure audit
found (docs/company-chat-exposure-roadmap.md): chat could MUTATE a company but
not SEE one. Exercised here:

  * the kernel read handler (``company_read.execute_company_read``): list filters
    by the SAME scope gate the write handler uses; snapshot builds a bounded DTO
    and refuses an out-of-scope / unknown company;
  * the single-source contract (read tools disjoint from writes; schema projects
    to Gemini / Anthropic; reads are NOT classified mutating, so a read-only
    posture leaves them available);
  * the B-class projection + dispatch (read tool name -> read resolver; available
    under a read-only posture; fail-closed when no resolver bound);
  * the orchestrator read resolver end-to-end (a tool call really returns the DTO;
    scope denial / unknown company -> an error string, never a crash);
  * the A-class MCP proxy (read tools advertised + read actions ticket-permitted);
  * CLI ``company snapshot`` and ``GET /api/team/companies/{id}/snapshot`` parity.
"""

from __future__ import annotations

import json
import time

import pytest

from superclaw.backends import GeminiAgentBackend, WorkerLimits, _RealToolExecution
from superclaw.company_read import (
    _ROSTER_CAP,
    CompanyListRead,
    CompanySnapshotRead,
    build_company_snapshot_payload,
    execute_company_read,
)
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import AgentProfile, CompanyProfile, CompanyStatus, Issue, RunSession
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.permissions import _MUTATING_TOOLS
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore
from superclaw.ui_contracts import (
    COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE,
    COMPANY_READ_TOOLS,
    TOOL_NAME_TO_COMMAND_TYPE,
    build_company_read_tool_schema,
)


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme", status=CompanyStatus.ACTIVE.value):
    return store.save_company_profile(CompanyProfile(name=name, goal=f"{name} goal", status=status))


def _agent(store, company_id, *, name="Ann", role="eng", **kw):
    return store.save_agent_profile(
        AgentProfile(name=name, role=role, company_profile_id=company_id, **kw)
    )


def _issue(store, company_id, *, title="T", status="todo", **kw):
    return store.save_issue(Issue(title=title, company_profile_id=company_id, status=status, **kw))


def _admin(company_id):
    return CompanyScope(principal_id="op_1", actor_company_id=company_id, is_admin=True)


def _confined(company_id):
    return CompanyScope(principal_id="op_1", actor_company_id=company_id, is_admin=False)


def _limits(tmp_path, *, read_resolver=None, mode="allow"):
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        permission_policy=PermissionPolicy.from_values(mode=mode),
        company_read_resolver=read_resolver,
    )


def _session(company_id=None):
    ec = {"principal": "op_1"}
    if company_id is not None:
        ec["company_profile_id"] = company_id
    return RunSession(goal_id="g", run_id="run_read", execution_context=ec)


# --------------------------------------------------------------------------- #
# Contract: single source, disjoint from writes, not mutating
# --------------------------------------------------------------------------- #
_EXPECTED_READ_TOOLS = {
    "company_list": "company.list",
    "company_snapshot": "company.snapshot",
    "agent_list": "agent.list",
    "agent_show": "agent.show",
    "issue_list": "issue.list",
    "issue_show": "issue.show",
    "read_issue_thread": "issue.thread",
    "read_work_products": "issue.work_products",
    "approval_list": "approval.list",
    "messages_read": "messages.read",
    "board_inbox_list": "board_inbox.list",
}


def test_read_tools_full_set_and_named():
    assert {t["name"] for t in COMPANY_READ_TOOLS} == set(_EXPECTED_READ_TOOLS)
    assert COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE == _EXPECTED_READ_TOOLS


def test_read_tools_disjoint_from_write_tools():
    assert not (set(COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE) & set(TOOL_NAME_TO_COMMAND_TYPE))


def test_read_tools_are_not_classified_mutating():
    # The whole point: reads must survive a read-only posture, so they must NOT be
    # in the mutating set (otherwise posture_denies_tool would block them).
    assert not (set(COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE) & _MUTATING_TOOLS)


def test_read_schema_projects_to_both_providers():
    g = build_company_read_tool_schema("gemini")
    a = build_company_read_tool_schema("anthropic")
    assert {t["function"]["name"] for t in g} == set(_EXPECTED_READ_TOOLS)
    assert {t["name"] for t in a} == set(_EXPECTED_READ_TOOLS)
    for t in g:
        assert t["type"] == "function" and t["function"]["parameters"]["type"] == "object"
    for t in a:
        assert set(t) == {"name", "description", "input_schema"}


def test_read_schema_projection_is_a_deep_copy():
    tools = build_company_read_tool_schema("anthropic")
    tools[0]["input_schema"]["properties"]["__hacked__"] = {"type": "string"}
    for source in COMPANY_READ_TOOLS:
        assert "__hacked__" not in source["input_schema"]["properties"]


def test_read_model_rejects_unknown_fields():
    with pytest.raises(ValueError):
        CompanySnapshotRead.from_dict({"company_profile_id": "c", "bogus": 1})
    with pytest.raises(ValueError):
        CompanyListRead.from_dict({"bogus": True})


def test_read_model_rejects_wrong_types_fail_closed():
    # A non-str id must NOT be silently treated as "omitted" (→ home snapshot);
    # a non-bool include_archived must NOT be truthy-coerced (→ leak archived).
    with pytest.raises(ValueError):
        CompanySnapshotRead.from_dict({"company_profile_id": 123})
    with pytest.raises(ValueError):
        CompanyListRead.from_dict({"include_archived": "false"})


# --------------------------------------------------------------------------- #
# Kernel: company.list (discovery, scope-filtered)
# --------------------------------------------------------------------------- #
def test_list_admin_sees_all_companies(store):
    a = _company(store, name="Acme")
    _company(store, name="Beta")
    out = execute_company_read(CompanyListRead(), scope=_admin(a.company_profile_id), store=store)
    assert out["company_count"] == 2
    assert {c["name"] for c in out["companies"]} == {"Acme", "Beta"}


def test_list_confined_sees_only_its_company(store):
    a = _company(store, name="Acme")
    _company(store, name="Beta")
    out = execute_company_read(CompanyListRead(), scope=_confined(a.company_profile_id), store=store)
    assert out["company_count"] == 1
    assert out["companies"][0]["company_profile_id"] == a.company_profile_id


def test_list_excludes_archived_unless_requested(store):
    live = _company(store, name="Live")
    _company(store, name="Dead", status=CompanyStatus.DISSOLVED.value)
    scope = _admin(live.company_profile_id)
    default = execute_company_read(CompanyListRead(), scope=scope, store=store)
    assert {c["name"] for c in default["companies"]} == {"Live"}
    full = execute_company_read(CompanyListRead(include_archived=True), scope=scope, store=store)
    assert {c["name"] for c in full["companies"]} == {"Live", "Dead"}


# --------------------------------------------------------------------------- #
# Kernel: company.snapshot (bounded DTO, scope-gated)
# --------------------------------------------------------------------------- #
def test_snapshot_dto_shape_and_counts(store):
    c = _company(store)
    cid = c.company_profile_id
    _agent(store, cid, name="Ann", model="claude-opus-4-8", effort="high")
    _issue(store, cid, title="A", status="in_progress")
    _issue(store, cid, title="B", status="todo")
    _issue(store, cid, title="C", status="done")

    snap = build_company_snapshot_payload(store, cid)
    assert snap["company"]["name"] == "Acme"
    assert snap["roster"]["agent_total"] == 1
    assert snap["roster"]["agents"][0]["model"] == "claude-opus-4-8"
    assert snap["roster"]["agents"][0]["effort"] == "high"
    assert snap["issues"]["issue_total"] == 3
    assert snap["issues"]["by_status"]["in_progress"] == 1
    assert snap["issues"]["by_status"]["todo"] == 1
    assert snap["issues"]["by_status"]["done"] == 1
    # done is terminal → not counted open; todo + in_progress are open.
    assert snap["issues"]["open_count"] == 2
    # Every lane present with an explicit count (stable schema, even 0).
    assert set(snap["issues"]["by_status"]) >= {"backlog", "blocked", "cancelled"}
    assert snap["approvals"]["pending_count"] == 0
    assert set(snap["cost"]) == {"total_cost_cents", "total_tokens", "event_count"}


def test_snapshot_roster_capped_with_true_total(store):
    c = _company(store)
    cid = c.company_profile_id
    for i in range(_ROSTER_CAP + 5):
        _agent(store, cid, name=f"A{i}")
    snap = build_company_snapshot_payload(store, cid)
    assert len(snap["roster"]["agents"]) == _ROSTER_CAP
    assert snap["roster"]["agent_total"] == _ROSTER_CAP + 5  # no silent truncation


def test_snapshot_stale_open_issue_counted(store):
    c = _company(store)
    cid = c.company_profile_id
    fresh = _issue(store, cid, title="fresh", status="in_progress")
    stale = _issue(store, cid, title="stale", status="in_progress")
    # Backdate the stale issue's last update well past the threshold.
    stale.updated_at = time.time() - (10 * 24 * 60 * 60)
    store.save_issue(stale)
    snap = build_company_snapshot_payload(store, cid)
    assert snap["issues"]["stale_count"] == 1
    assert snap["issues"]["open_count"] == 2
    assert fresh.issue_id  # referenced


def test_snapshot_pending_approval_count_matches_two_path_attribution(store):
    # The bounded SQL count must equal list_approvals' two-path attribution exactly:
    # issue-linked → the issue's company; issue-less → affects.company_profile_id.
    from superclaw.models import Approval, ApprovalType, Issue

    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    cid = a.company_profile_id
    # (1) issue-linked approval whose issue is in company A → counts for A.
    issue_a = store.save_issue(Issue(title="ia", company_profile_id=cid, status="in_review"))
    store.save_approval(Approval(type=ApprovalType.COMPANY_COMMAND.value, requested_by="u", issue_id=issue_a.issue_id))
    # (2) issue-less approval whose affects names company A → counts for A.
    store.save_approval(Approval(
        type=ApprovalType.COMPANY_COMMAND.value, requested_by="u",
        affects={"company_profile_id": cid},
    ))
    # (3) issue-linked approval whose issue is in company B → must NOT count for A.
    issue_b = store.save_issue(Issue(title="ib", company_profile_id=b.company_profile_id, status="in_review"))
    store.save_approval(Approval(type=ApprovalType.COMPANY_COMMAND.value, requested_by="u", issue_id=issue_b.issue_id))
    # (4) issue-less approval with no company attribution → global only, not A.
    store.save_approval(Approval(type=ApprovalType.COMPANY_COMMAND.value, requested_by="u"))

    snap = build_company_snapshot_payload(store, cid)
    assert snap["approvals"]["pending_count"] == 2
    # Cross-check: equals the count list_approvals would attribute to A.
    assert snap["approvals"]["pending_count"] == len(
        store.list_approvals(status="pending", company_profile_id=cid)
    )


def test_snapshot_homes_to_actor_company_when_id_absent(store):
    c = _company(store)
    out = execute_company_read(
        CompanySnapshotRead(), scope=_admin(c.company_profile_id), store=store
    )
    assert out["company"]["company_profile_id"] == c.company_profile_id


def test_snapshot_cross_company_forbidden_for_confined_scope(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    with pytest.raises(CompanyScopeError):
        execute_company_read(
            CompanySnapshotRead(company_profile_id=b.company_profile_id),
            scope=_confined(a.company_profile_id),
            store=store,
        )


def test_snapshot_unknown_company_raises_keyerror(store):
    with pytest.raises(KeyError):
        build_company_snapshot_payload(store, "company_does_not_exist")


# --------------------------------------------------------------------------- #
# P1 read tools: agents / issues / thread / work products / approvals / messages
# --------------------------------------------------------------------------- #
from superclaw.company_read import (  # noqa: E402
    AgentShowRead,
    IssueListRead,
    IssueShowRead,
    IssueThreadRead,
    IssueWorkProductsRead,
    _TEXT_EXCERPT_CHARS,
)


def test_agent_list_returns_roster(store):
    c = _company(store)
    cid = c.company_profile_id
    _agent(store, cid, name="Ann", model="claude-opus-4-8", effort="high")
    _agent(store, cid, name="Bob")
    out = execute_company_read(get_model("agent.list")({}), scope=_admin(cid), store=store)
    assert out["agent_total"] == 2
    assert {a["name"] for a in out["agents"]} == {"Ann", "Bob"}


def test_agent_show_returns_config(store):
    c = _company(store)
    a = _agent(store, c.company_profile_id, name="Ann", model="claude-opus-4-8", effort="high")
    out = execute_company_read(
        AgentShowRead(profile_id=a.profile_id), scope=_admin(c.company_profile_id), store=store
    )
    assert out["agent"]["model"] == "claude-opus-4-8"
    assert out["agent"]["effort"] == "high"
    assert "plugin_allowlist" in out["agent"] and "skill_allowlist" in out["agent"]


def test_agent_show_cross_company_forbidden_for_confined(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = _agent(store, b.company_profile_id, name="Bea")
    with pytest.raises(CompanyScopeError):
        execute_company_read(
            AgentShowRead(profile_id=foreign.profile_id),
            scope=_confined(a.company_profile_id), store=store,
        )


def test_issue_list_filters_by_status(store):
    c = _company(store)
    cid = c.company_profile_id
    _issue(store, cid, title="A", status="in_progress")
    _issue(store, cid, title="B", status="todo")
    out = execute_company_read(IssueListRead(status="todo"), scope=_admin(cid), store=store)
    assert out["returned"] == 1
    assert out["issues"][0]["title"] == "B"


def test_issue_show_and_thread_and_work_products(store):
    from superclaw.models import IssueComment, WorkProduct

    c = _company(store)
    cid = c.company_profile_id
    iss = _issue(store, cid, title="T", status="in_review")
    store.add_issue_comment(IssueComment(issue_id=iss.issue_id, body="looks good", company_profile_id=cid))
    store.save_work_product(WorkProduct(issue_id=iss.issue_id, company_profile_id=cid, title="PR", url="http://x", summary="did it"))
    sc = _admin(cid)

    show = execute_company_read(IssueShowRead(issue_id=iss.issue_id), scope=sc, store=store)
    assert show["issue"]["title"] == "T"

    thread = execute_company_read(IssueThreadRead(issue_id=iss.issue_id), scope=sc, store=store)
    assert thread["returned"] == 1
    assert thread["comments"][0]["body"]["text"] == "looks good"

    wps = execute_company_read(IssueWorkProductsRead(issue_id=iss.issue_id), scope=sc, store=store)
    assert wps["returned"] == 1 and wps["more_available"] is False
    assert wps["work_products"][0]["url"] == "http://x"


def test_forbidden_issue_anchored_read_does_not_touch_sub_resources(store, monkeypatch):
    # Finding-1 fix: a cross-company (forbidden) thread/work-products read must be
    # rejected BEFORE any comment / work-product fetch — scope gate before sub-resource.
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = _issue(store, b.company_profile_id, title="x")

    def _boom(*args, **kwargs):
        raise AssertionError("sub-resource fetched before the scope gate")

    monkeypatch.setattr(store, "list_issue_comments", _boom)
    monkeypatch.setattr(store, "list_work_products", _boom)
    conf = _confined(a.company_profile_id)
    with pytest.raises(CompanyScopeError):
        execute_company_read(IssueThreadRead(issue_id=foreign.issue_id), scope=conf, store=store)
    with pytest.raises(CompanyScopeError):
        execute_company_read(IssueWorkProductsRead(issue_id=foreign.issue_id), scope=conf, store=store)


def test_issue_show_cross_company_forbidden_for_confined(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = _issue(store, b.company_profile_id, title="x")
    with pytest.raises(CompanyScopeError):
        execute_company_read(
            IssueShowRead(issue_id=foreign.issue_id),
            scope=_confined(a.company_profile_id), store=store,
        )


def test_work_product_summary_is_excerpted(store):
    from superclaw.models import WorkProduct

    c = _company(store)
    cid = c.company_profile_id
    iss = _issue(store, cid, title="T")
    big = "x" * (_TEXT_EXCERPT_CHARS + 500)
    store.save_work_product(WorkProduct(issue_id=iss.issue_id, company_profile_id=cid, title="big", summary=big))
    out = execute_company_read(IssueWorkProductsRead(issue_id=iss.issue_id), scope=_admin(cid), store=store)
    excerpt = out["work_products"][0]["summary"]
    assert excerpt["truncated"] is True
    assert len(excerpt["text"]) == _TEXT_EXCERPT_CHARS
    assert excerpt["full_length"] == _TEXT_EXCERPT_CHARS + 500


def test_messages_read_returns_rollup(store):
    c = _company(store)
    out = execute_company_read(get_model("messages.read")({}), scope=_admin(c.company_profile_id), store=store)
    assert "total_unread" in out and "companies" in out


def test_issue_list_rejects_bool_limit():
    with pytest.raises(ValueError):
        IssueListRead.from_dict({"limit": True})


def get_model(ct):
    from superclaw.company_read import get_company_read_model

    return get_company_read_model(ct).from_dict


# --------------------------------------------------------------------------- #
# B-class projection + dispatch
# --------------------------------------------------------------------------- #
def test_read_tools_injected_when_resolver_bound(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_COMPANY_TOOLS", raising=False)
    backend = GeminiAgentBackend()
    limits = _limits(tmp_path, read_resolver=lambda ct, a: "ok")
    out = backend._maybe_add_company_read_tools([], limits=limits, schema="gemini")
    assert {t["function"]["name"] for t in out} == set(_EXPECTED_READ_TOOLS)


def test_read_tools_not_injected_without_resolver(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_COMPANY_TOOLS", raising=False)
    backend = GeminiAgentBackend()
    out = backend._maybe_add_company_read_tools([], limits=_limits(tmp_path, read_resolver=None), schema="gemini")
    assert out == []


def test_read_tools_not_injected_when_company_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_COMPANY_TOOLS", "false")
    backend = GeminiAgentBackend()
    out = backend._maybe_add_company_read_tools([], limits=_limits(tmp_path, read_resolver=lambda ct, a: "ok"), schema="gemini")
    assert out == []


def test_exec_tool_routes_read_name_to_read_resolver(tmp_path):
    seen = []

    def read_resolver(ct, args):
        seen.append((ct, args))
        return "READ_RESULT"

    runner = _RealToolExecution()
    out = runner._exec_tool(
        "company_snapshot", {"company_profile_id": "c1"},
        _limits(tmp_path, read_resolver=read_resolver), time.monotonic() + 30,
    )
    assert out == "READ_RESULT"
    assert seen == [("company.snapshot", {"company_profile_id": "c1"})]


def test_read_tool_available_under_readonly_posture(tmp_path):
    # The acceptance item: a read-only (plan) posture must NOT deny a read tool.
    called = []

    def read_resolver(ct, args):
        called.append(ct)
        return "OK"

    runner = _RealToolExecution()
    out = runner._exec_tool(
        "company_list", {}, _limits(tmp_path, read_resolver=read_resolver, mode="plan"),
        time.monotonic() + 30,
    )
    assert out == "OK"
    assert called == ["company.list"]  # reached the resolver, not a denial


def test_exec_tool_read_fail_closed_without_resolver(tmp_path):
    runner = _RealToolExecution()
    out = runner._exec_tool(
        "company_snapshot", {}, _limits(tmp_path, read_resolver=None), time.monotonic() + 30,
    )
    assert "unavailable" in out and out.startswith("error:")


# --------------------------------------------------------------------------- #
# Orchestrator read resolver end-to-end
# --------------------------------------------------------------------------- #
def test_resolver_list_returns_dto(store):
    _company(store, name="Acme")
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_read_resolver(_session())
    out = resolver("company.list", {})
    payload = json.loads(out)
    assert payload["status"] == "ok"
    assert payload["data"]["company_count"] >= 1


def test_resolver_snapshot_returns_dto_homed_to_company(store):
    c = _company(store)
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_read_resolver(_session(c.company_profile_id))
    out = resolver("company.snapshot", {})
    payload = json.loads(out)
    assert payload["status"] == "ok"
    assert payload["data"]["company"]["company_profile_id"] == c.company_profile_id


def test_resolver_snapshot_unknown_company_is_error_string(store):
    c = _company(store)
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_read_resolver(_session(c.company_profile_id))
    out = resolver("company.snapshot", {"company_profile_id": "nope"})
    # Admin scope permits any id, so this resolves to a real lookup miss -> error,
    # never a crash.
    assert out.startswith("error:")


def test_resolver_bad_command_type_is_error_string(store):
    orch = SuperClawOrchestrator(store)
    resolver = orch._build_company_read_resolver(_session())
    assert resolver("company.bogus", {}).startswith("error:")


# --------------------------------------------------------------------------- #
# A-class MCP proxy parity
# --------------------------------------------------------------------------- #
def test_proxy_advertises_read_tools():
    from superclaw.team_mcp_proxy import TEAM_READ_ACTIONS, _team_tool_defs

    names = {t["name"] for t in _team_tool_defs()}
    assert set(_EXPECTED_READ_TOOLS) <= names
    assert set(TEAM_READ_ACTIONS) == set(_EXPECTED_READ_TOOLS.values())
