"""Tests for the team-company MCP proxy (PR-4, 柱子 2).

Covers the A-class company-command projection: the MCP server (list_tools schema,
call_tool verify-pass / verify-fail / unknown-tool / scope re-derivation / error
mapping), the config builder (no secret in argv/config), and the orchestrator
wiring (A-class team run mints a confined team ticket; the A-class OPERATOR direct
chat mints an admin operator-channel ticket — parity with the B-class in-loop
resolver — while B-class / unresolved runs do NOT get a proxy).
"""

from __future__ import annotations

import json

import pytest

from superclaw.backends import (
    AnthropicAgentBackend,
    ClaudeCliBackend,
    CodexAppServerBackend,
    CodexCliBackend,
    GeminiAgentBackend,
    WorkerLimits,
)
from superclaw.company_ticket import issue_run_ticket
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    CompanyStatus,
    RunSession,
)
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore
from superclaw.team_mcp_proxy import (
    OPERATOR_MCP_AUDIENCE,
    TEAM_COMMAND_ACTIONS,
    TEAM_MCP_AUDIENCE,
    TeamMcpProxyOptions,
    TeamMcpProxyServer,
    build_team_mcp_config,
    write_ticket_file,
)
from superclaw.ui_contracts import (
    COMPANY_COMMAND_TOOLS,
    COMPANY_READ_TOOLS,
    TOOL_NAME_TO_COMMAND_TYPE,
)

# The audit principal the direct user chat carries in its execution_context (matches
# _direct_session below). The operator MCP channel MUST attribute company commands to
# THIS principal (not a constant) so owner_id / requested_by are zero-drift with the
# B-class in-loop chat.
_DIRECT_PRINCIPAL = "op_1"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name, status=CompanyStatus.ACTIVE.value))


def _agent(store, company_id, *, name="Worker", role="implementer"):
    return store.save_agent_profile(AgentProfile(name=name, role=role, company_profile_id=company_id))


def _options(
    store, *, run_id, agent_profile_id, company_id, token, audience=TEAM_MCP_AUDIENCE, operator_scope=False
):
    # Stage the token in a 0600 sidecar next to the store (the real transport).
    # A None token = no sidecar (unauthenticated channel).
    ticket_file = None
    if token is not None:
        ticket_file = str(store.path.parent / f"ticket-{run_id}.key")
        write_ticket_file(ticket_file, token)
    return TeamMcpProxyOptions(
        state_path=str(store.path),
        run_id=run_id,
        agent_profile_id=agent_profile_id,
        company_id=company_id,
        ticket_file=ticket_file,
        audience=audience,
        operator_scope=operator_scope,
    )


def _call(server, name, arguments):
    """Invoke a tools/call and return the parsed (text, isError)."""
    resp = server.handle_message(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    )
    result = resp["result"]
    text = result["content"][0]["text"]
    return text, result["isError"]


# --------------------------------------------------------------------------- #
# list_tools / schema
# --------------------------------------------------------------------------- #
def test_list_tools_returns_full_company_schema(store):
    server = TeamMcpProxyServer(_options(store, run_id="r", agent_profile_id="a", company_id="c", token="x"))
    resp = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = resp["result"]["tools"]
    # The proxy advertises the mutation tools AND the read tools (roadmap P0:
    # discovery + snapshot), so an A-class agent can SEE a company, not only mutate it.
    assert {t["name"] for t in tools} == (
        {t["name"] for t in COMPANY_COMMAND_TOOLS} | {t["name"] for t in COMPANY_READ_TOOLS}
    )
    # Every projected tool carries an MCP-shaped inputSchema (a guide; from_dict is
    # the authority).
    for tool in tools:
        assert set(tool) == {"name", "description", "inputSchema"}
        assert tool["inputSchema"]["type"] == "object"


def test_list_tools_returns_a_fresh_copy(store):
    """A client mutating the result must never corrupt the contract source."""
    server = TeamMcpProxyServer(_options(store, run_id="r", agent_profile_id="a", company_id="c", token="x"))
    resp = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    resp["result"]["tools"][0]["inputSchema"]["properties"].clear()
    # The canonical source is untouched.
    assert COMPANY_COMMAND_TOOLS[0]["input_schema"]["properties"]


def test_initialize_advertises_tools_capability(store):
    server = TeamMcpProxyServer(_options(store, run_id="r", agent_profile_id="a", company_id="c", token="x"))
    resp = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert resp["result"]["capabilities"] == {"tools": {}}


def test_team_command_actions_match_the_contract():
    assert set(TEAM_COMMAND_ACTIONS) == set(TOOL_NAME_TO_COMMAND_TYPE.values())


# --------------------------------------------------------------------------- #
# call_tool: happy path through the single choke point
# --------------------------------------------------------------------------- #
def test_call_tool_executes_company_read_snapshot(store):
    # Roadmap P0: an A-class (codex/claude) agent can SEE its company via the proxy.
    # The ticket must permit the read action (TEAM_READ_ACTIONS) and the read
    # dispatch must run execute_company_read under the SAME confined scope.
    from superclaw.team_mcp_proxy import TEAM_READ_ACTIONS

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_read",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=[*TEAM_COMMAND_ACTIONS, *TEAM_READ_ACTIONS],
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_read", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    text, is_error = _call(server, "company_snapshot", {})
    assert not is_error, text
    payload = json.loads(text)
    assert payload["status"] == "ok"
    assert payload["data"]["company"]["company_profile_id"] == company.company_profile_id
    assert payload["data"]["roster"]["agent_total"] == 1


def test_call_tool_executes_low_risk_command(store):
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    # issue_comment is a low-risk, issue-anchored mutation. First create an issue
    # directly in the store so the comment has a same-origin target.
    from superclaw.models import Issue

    issue = store.save_issue(
        Issue(title="t", company_profile_id=company.company_profile_id, assignee_agent_profile_id=agent.profile_id)
    )
    text, is_error = _call(server, "issue_comment", {"issue_id": issue.issue_id, "body": "hello"})
    assert not is_error, text
    assert json.loads(text)["status"] == "executed"


def test_respond_grant_on_ticket_lets_non_owner_comment_via_proxy(store):
    # End-to-end A-class parity (#2): a ticket carrying a respond grant for issueA
    # lets the (non-owning) agent post a single comment on issueA through the proxy.
    from superclaw.models import Issue

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    owner = _agent(store, company.company_profile_id, name="Owner")
    issue = store.save_issue(
        Issue(
            title="t",
            company_profile_id=company.company_profile_id,
            assignee_agent_profile_id=owner.profile_id,  # NOT the acting agent
        )
    )
    token, _ = issue_run_ticket(
        store,
        run_id="run_resp",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
        respond_issue_id=issue.issue_id,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="run_resp",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            token=token,
        )
    )
    text, is_error = _call(server, "issue_comment", {"issue_id": issue.issue_id, "body": "replying"})
    assert not is_error, text
    assert json.loads(text)["status"] == "executed"
    comments = store.list_issue_comments(issue.issue_id)
    assert comments[-1].author_type == "agent"
    assert comments[-1].author_id == agent.profile_id


def test_respond_grant_on_ticket_is_single_use_via_proxy(store):
    # A-class parity for single-use (#2): the proxy binds scope.run_id =
    # verified.run_id, so a SECOND comment in the same run on the same issue is
    # refused (the grant is consumed once). Caps the @mention fan-out.
    from superclaw.models import Issue

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    owner = _agent(store, company.company_profile_id, name="Owner")
    issue = store.save_issue(
        Issue(
            title="t",
            company_profile_id=company.company_profile_id,
            assignee_agent_profile_id=owner.profile_id,
        )
    )
    token, _ = issue_run_ticket(
        store,
        run_id="run_single",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
        respond_issue_id=issue.issue_id,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="run_single",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            token=token,
        )
    )
    # First comment succeeds (grant consumed).
    text1, err1 = _call(server, "issue_comment", {"issue_id": issue.issue_id, "body": "first"})
    assert not err1, text1
    assert json.loads(text1)["status"] == "executed"
    # Second comment in the same run on the same issue is refused.
    text2, err2 = _call(server, "issue_comment", {"issue_id": issue.issue_id, "body": "second"})
    assert err2
    assert len(store.list_issue_comments(issue.issue_id)) == 1


def test_respond_grant_on_ticket_does_not_authorize_other_issue_via_proxy(store):
    # The grant is single-issue: a grant for issueA cannot comment on issueB.
    from superclaw.models import Issue

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    owner = _agent(store, company.company_profile_id, name="Owner")
    issue_a = store.save_issue(
        Issue(title="A", company_profile_id=company.company_profile_id,
              assignee_agent_profile_id=owner.profile_id)
    )
    issue_b = store.save_issue(
        Issue(title="B", company_profile_id=company.company_profile_id,
              assignee_agent_profile_id=owner.profile_id)
    )
    token, _ = issue_run_ticket(
        store,
        run_id="run_resp_b",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
        respond_issue_id=issue_a.issue_id,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="run_resp_b",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            token=token,
        )
    )
    text, is_error = _call(server, "issue_comment", {"issue_id": issue_b.issue_id, "body": "x"})
    assert is_error
    assert store.list_issue_comments(issue_b.issue_id) == []


# --------------------------------------------------------------------------- #
# call_tool: fail-closed verification
# --------------------------------------------------------------------------- #
def test_call_tool_without_token_is_refused(store):
    server = TeamMcpProxyServer(_options(store, run_id="r", agent_profile_id="a", company_id="c", token=None))
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert text.startswith("error: forbidden: no run ticket")


def test_call_tool_with_unknown_tool_is_refused(store):
    server = TeamMcpProxyServer(_options(store, run_id="r", agent_profile_id="a", company_id="c", token="x"))
    text, is_error = _call(server, "not_a_company_tool", {})
    assert is_error
    assert "unknown tool" in text


def test_call_tool_with_tampered_token_is_refused(store):
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token + "x")
    )
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert text.startswith("error: forbidden: ticket verification failed")


def test_call_tool_with_wrong_run_is_refused(store):
    """The proxy pins the orchestrator's expected run; a ticket for a DIFFERENT
    run fails the scope-match even with a valid secret."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_OTHER",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_THIS", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert "ticket verification failed" in text


def test_call_tool_with_wrong_audience_is_refused(store):
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience="some-other-surface",
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert "ticket verification failed" in text


def test_call_tool_with_action_outside_allow_list_is_refused(store):
    """A ticket whose allowed_actions omits the action's command_type is refused
    even though the tool name is valid (closed action allow-list)."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    # Allow only company.update — a company_create call (company.create) is outside.
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=["company.update"],
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert "ticket verification failed" in text


# --------------------------------------------------------------------------- #
# call_tool: scope is re-derived from the ticket, never self-reported
# --------------------------------------------------------------------------- #
def test_scope_is_confined_to_ticket_company_not_args(store):
    """Even if the tool args name a DIFFERENT company, the re-derived (non-admin)
    scope confines the actor to its ticket company → cross-company target is a
    hard forbidden, never executed."""
    home = _company(store, name="Home")
    other = _company(store, name="Other")
    agent = _agent(store, home.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=home.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=home.company_profile_id, token=token)
    )
    # Target the OTHER company in the args — the confined scope forbids it.
    text, is_error = _call(server, "company_update", {"company_profile_id": other.company_profile_id, "name": "Renamed"})
    assert is_error
    assert "forbidden" in text
    # The other company was NOT renamed.
    assert store.get_company_profile(other.company_profile_id).name == "Other"


def test_malformed_args_map_to_error_string_not_crash(store):
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    # An unknown field is rejected by the command model's fail-closed from_dict.
    text, is_error = _call(server, "company_create", {"name": "X", "not_a_field": 1})
    assert is_error
    assert text.startswith("error: invalid company command")


def test_archive_by_confined_agent_is_forbidden(store):
    """A confined (ticket-authed, non-admin) agent may NOT archive a company at
    all — the autonomy gate default-denies it (it is NOT even routed to an
    approval; that DoS-freeze path is reserved for the operator). The proxy maps
    the autonomy denial to a forbidden error string, never a crash."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    text, is_error = _call(server, "company_archive", {"company_profile_id": company.company_profile_id})
    assert is_error
    assert "forbidden" in text
    # The company was NOT archived.
    assert store.get_company_profile(company.company_profile_id).status == CompanyStatus.ACTIVE.value


# --------------------------------------------------------------------------- #
# config builder: no secret in argv / config
# --------------------------------------------------------------------------- #
def test_build_team_mcp_config_carries_no_secret(tmp_path):
    secret = "super-secret-token-value"
    ticket_file = tmp_path / "ticket.key"
    write_ticket_file(ticket_file, secret)
    config = build_team_mcp_config(
        run_id="run_1",
        agent_profile_id="agent_1",
        company_id="co_1",
        state_path=tmp_path / "state.db",
        ticket_file=ticket_file,
    )
    server = config["mcpServers"]["superclaw-team"]
    blob = json.dumps(config)
    # The pins + the ticket-file PATH are present; the secret VALUE is NOT.
    assert "run_1" in server["args"]
    assert "agent_1" in server["args"]
    assert "co_1" in server["args"]
    assert TEAM_MCP_AUDIENCE in server["args"]
    assert str(ticket_file) in server["args"]
    assert secret not in blob  # the token value never lands in the config
    assert "env" not in server  # no env block at all


# --------------------------------------------------------------------------- #
# ticket-file transport: 0600 sidecar, fail-closed read
# --------------------------------------------------------------------------- #
def test_write_ticket_file_is_0600(tmp_path):
    import stat

    path = write_ticket_file(tmp_path / "t.key", "secret")
    assert path.read_text() == "secret"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_write_ticket_file_reasserts_mode_on_existing(tmp_path):
    import os
    import stat

    path = tmp_path / "t.key"
    path.write_text("old")
    os.chmod(path, 0o644)  # pre-existing world-readable file
    write_ticket_file(path, "new")
    assert path.read_text() == "new"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_read_ticket_token_missing_file_is_none(tmp_path):
    opts = TeamMcpProxyOptions(
        state_path=str(tmp_path / "state.db"),
        run_id="r",
        agent_profile_id="a",
        company_id="c",
        ticket_file=str(tmp_path / "does-not-exist.key"),
    )
    assert opts.read_ticket_token() is None


def test_read_ticket_token_none_file_is_none(tmp_path):
    opts = TeamMcpProxyOptions(
        state_path=str(tmp_path / "state.db"),
        run_id="r",
        agent_profile_id="a",
        company_id="c",
        ticket_file=None,
    )
    assert opts.read_ticket_token() is None


def test_read_ticket_token_corrupt_bytes_is_none(tmp_path):
    """A non-UTF-8 / corrupted sidecar degrades to None (not a raised
    UnicodeDecodeError that would escape the fail-closed contract)."""
    bad = tmp_path / "bad.key"
    bad.write_bytes(b"\xff\xfe\x00\x80not-utf8")
    opts = TeamMcpProxyOptions(
        state_path=str(tmp_path / "state.db"),
        run_id="r",
        agent_profile_id="a",
        company_id="c",
        ticket_file=str(bad),
    )
    assert opts.read_ticket_token() is None


def test_corrupt_sidecar_call_tool_is_model_facing_error(store):
    """A corrupted sidecar must surface as a model-facing isError tools/call result
    (fail-closed 'no run ticket'), NOT a raw JSON-RPC frame error."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    bad = store.path.parent / "corrupt.key"
    bad.write_bytes(b"\xff\xfe\x00")
    server = TeamMcpProxyServer(
        TeamMcpProxyOptions(
            state_path=str(store.path),
            run_id="run_1",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            ticket_file=str(bad),
        )
    )
    resp = server.handle_message(
        {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "company_create", "arguments": {"name": "X"}}}
    )
    # A proper result with isError (NOT a top-level JSON-RPC 'error' / id null).
    assert "error" not in resp
    assert resp["id"] == 7
    assert resp["result"]["isError"] is True
    assert "no run ticket" in resp["result"]["content"][0]["text"]


def test_unexpected_handler_error_maps_to_error_string(store, monkeypatch):
    """Any UNEXPECTED exception from execute_company_command maps to a model-facing
    error string (the catch-all), never crashing the agent loop."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )
    # Force an arbitrary RuntimeError out of the choke point. The proxy imports
    # execute_company_command lazily inside _execute, so patch the source symbol.
    def _boom(*a, **k):
        raise RuntimeError("unexpected kernel failure")

    monkeypatch.setattr("superclaw.company_handler.execute_company_command", _boom)
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert "company command failed" in text
    assert "RuntimeError" in text


def test_unexpected_verify_error_is_model_facing_not_frame_error(store, monkeypatch):
    """An exception escaping _execute (e.g. verify_run_ticket raising a non-TicketError)
    must still surface as a model-facing isError tools/call result via the outermost
    _handle_call boundary, NEVER a raw JSON-RPC id:null frame error."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="run_1",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(store, run_id="run_1", agent_profile_id=agent.profile_id, company_id=company.company_profile_id, token=token)
    )

    def _boom(*a, **k):
        raise RuntimeError("verifier blew up")

    monkeypatch.setattr("superclaw.company_ticket.verify_run_ticket", _boom)
    resp = server.handle_message(
        {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "company_create", "arguments": {"name": "X"}}}
    )
    assert "error" not in resp  # no top-level JSON-RPC error / id null
    assert resp["id"] == 9
    assert resp["result"]["isError"] is True
    assert "company command failed" in resp["result"]["content"][0]["text"]


# --------------------------------------------------------------------------- #
# orchestrator wiring: who gets the team MCP config
# --------------------------------------------------------------------------- #
def _team_session(store, agent, *, run_id="run_team"):
    return RunSession(
        goal_id="g",
        run_id=run_id,
        execution_context={
            "principal": "op_1",
            "company_profile_id": agent.company_profile_id,
            "agent_run_context": {"agent_profile_id": agent.profile_id},
        },
    )


def _direct_session(store, *, run_id="run_direct"):
    return RunSession(goal_id="g", run_id=run_id, execution_context={"principal": "op_1"})


def _limits(tmp_path):
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(mode="allow"),
    )


def _team_config_path(bound):
    return next((c for c in bound.permission_policy.mcp_configs if "superclaw-team.mcp.json" in c), None)


def _ticket_file_from_config(config_path):
    payload = json.loads(open(config_path).read())
    args = payload["mcpServers"]["superclaw-team"]["args"]
    return args[args.index("--ticket-file") + 1]


def _operator_config_path(bound):
    return next(
        (c for c in bound.permission_policy.mcp_configs if "superclaw-operator.mcp.json" in c), None
    )


def _operator_args_from_config(config_path):
    payload = json.loads(open(config_path).read())
    return payload["mcpServers"]["superclaw-operator"]["args"]


@pytest.mark.parametrize("backend_factory", [CodexCliBackend, ClaudeCliBackend, CodexAppServerBackend])
def test_aclass_team_run_gets_ticket_and_config(store, tmp_path, backend_factory):
    """Every MCP-capable A-class backend (incl. codex-app-server) is wired
    identically: a sidecar + config, the token never in the config, the staged
    ticket verifies for THIS run/agent/company."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent, run_id=f"run_{backend_factory.__name__}")
    bound = orch._maybe_bind_team_mcp(backend_factory(), session, _limits(tmp_path))
    config_path = _team_config_path(bound)
    assert config_path is not None
    # The sidecar exists, is 0600, and the config carries only its PATH (not the token).
    import stat

    ticket_file = _ticket_file_from_config(config_path)
    assert stat.S_IMODE(__import__("os").stat(ticket_file).st_mode) == 0o600
    token = open(ticket_file).read().strip()
    assert token and token not in open(config_path).read()
    # The staged token verifies for THIS run/agent/company.
    from superclaw.company_ticket import verify_run_ticket

    verified = verify_run_ticket(
        store,
        token,
        action="company.create",
        audience=TEAM_MCP_AUDIENCE,
        expected_run_id=session.run_id,
        expected_agent_profile_id=agent.profile_id,
        expected_company_id=company.company_profile_id,
    )
    assert verified.agent_profile_id == agent.profile_id


def test_aclass_team_run_appends_not_replaces_existing_mcp(store, tmp_path):
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(mode="allow", mcp_configs=["/existing/plugins.mcp.json"]),
    )
    bound = orch._maybe_bind_team_mcp(ClaudeCliBackend(), session, limits)
    configs = bound.permission_policy.mcp_configs
    assert any("plugins.mcp.json" in c for c in configs)  # plugin aggregate preserved
    assert any("superclaw-team.mcp.json" in c for c in configs)


def test_bclass_team_run_is_skipped(store, tmp_path):
    """A B-class backend executes company tools in-loop and must NOT also receive
    the MCP proxy (no double-stacking)."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    for backend in (GeminiAgentBackend(), AnthropicAgentBackend()):
        bound = orch._maybe_bind_team_mcp(backend, session, _limits(tmp_path))
        assert not any("superclaw-team" in c for c in bound.permission_policy.mcp_configs)


@pytest.mark.parametrize("backend_factory", [CodexCliBackend, ClaudeCliBackend, CodexAppServerBackend])
def test_operator_direct_run_gets_operator_channel(store, tmp_path, backend_factory):
    """The operator (admin) direct chat now gets the OPERATOR-scope MCP channel on
    every A-class backend — parity with the B-class in-loop resolver — instead of
    being skipped. The config is the operator one (--operator-scope, operator
    audience), NOT the team config, and the staged ticket verifies on the operator
    audience pinned to the SESSION principal (op_1) + home company "local"."""
    orch = SuperClawOrchestrator(store)
    session = _direct_session(store, run_id=f"op_{backend_factory.__name__}")
    bound = orch._maybe_bind_team_mcp(backend_factory(), session, _limits(tmp_path))
    # It is the OPERATOR config, and NOT the (confined) team config.
    assert _team_config_path(bound) is None
    config_path = _operator_config_path(bound)
    assert config_path is not None
    args = _operator_args_from_config(config_path)
    assert "--operator-scope" in args
    assert args[args.index("--audience") + 1] == OPERATOR_MCP_AUDIENCE
    # Sidecar is 0600 and the token is not inlined in the config.
    import os
    import stat

    ticket_file = args[args.index("--ticket-file") + 1]
    assert stat.S_IMODE(os.stat(ticket_file).st_mode) == 0o600
    token = open(ticket_file).read().strip()
    assert token and token not in open(config_path).read()
    # The staged token verifies for THIS run on the operator audience, pinned to the
    # SESSION principal (NOT a constant) + home company — so audit attribution matches
    # the B-class in-loop operator chat for the same execution_context.
    from superclaw.company_ticket import verify_run_ticket

    verified = verify_run_ticket(
        store,
        token,
        action="company.create",
        audience=OPERATOR_MCP_AUDIENCE,
        expected_run_id=session.run_id,
        expected_agent_profile_id=_DIRECT_PRINCIPAL,
        expected_company_id="local",
    )
    assert verified.agent_profile_id == _DIRECT_PRINCIPAL


def test_operator_channel_appends_not_replaces_existing_mcp(store, tmp_path):
    """The operator channel APPENDS to the plugin aggregate, never replaces it."""
    orch = SuperClawOrchestrator(store)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(
            mode="allow", mcp_configs=["/existing/plugins.mcp.json"]
        ),
    )
    bound = orch._maybe_bind_team_mcp(ClaudeCliBackend(), _direct_session(store), limits)
    configs = bound.permission_policy.mcp_configs
    assert any("plugins.mcp.json" in c for c in configs)
    assert any("superclaw-operator.mcp.json" in c for c in configs)


def test_operator_channel_respects_company_tools_toggle(store, tmp_path, monkeypatch):
    """The operator channel honours the SAME env toggle as every other channel."""
    monkeypatch.setenv("SUPERCLAW_COMPANY_TOOLS", "0")
    orch = SuperClawOrchestrator(store)
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), _direct_session(store), _limits(tmp_path))
    assert _operator_config_path(bound) is None


def _assert_ticket_read_only(store, token, *, audience, run_id, agent_profile_id, company_id):
    """The ticket permits READ company actions but REFUSES write (mutation) ones."""
    from superclaw.company_ticket import TicketError, verify_run_ticket

    # A read action verifies.
    verify_run_ticket(
        store, token, action="company.snapshot", audience=audience,
        expected_run_id=run_id, expected_agent_profile_id=agent_profile_id,
        expected_company_id=company_id,
    )
    # A write action is refused (not in the ticket's allowed_actions).
    with pytest.raises(TicketError):
        verify_run_ticket(
            store, token, action="company.create", audience=audience,
            expected_run_id=run_id, expected_agent_profile_id=agent_profile_id,
            expected_company_id=company_id,
        )


def test_operator_channel_readonly_projects_read_only(store, tmp_path):
    """A read-only posture (mode=plan) denies WRITE company tools, but READ tools
    (company_list / company_snapshot) stay available for parity with B-class. The
    operator admin channel projects the proxy with a READ-only ticket: a write
    action fails ticket verification, a read action passes."""
    orch = SuperClawOrchestrator(store)
    session = _direct_session(store)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(mode="plan"),
    )
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, limits)
    config_path = _operator_config_path(bound)
    assert config_path is not None  # projected (no longer skipped)
    args = _operator_args_from_config(config_path)
    token = open(args[args.index("--ticket-file") + 1]).read().strip()
    _assert_ticket_read_only(
        store, token, audience=OPERATOR_MCP_AUDIENCE, run_id=session.run_id,
        agent_profile_id=_DIRECT_PRINCIPAL, company_id="local",
    )


def test_operator_channel_non_mcp_backend_is_skipped(store, tmp_path):
    """A non-MCP-capable backend (e.g. bobo) never gets the operator proxy either."""
    from superclaw.backends import BoboCliBackend

    orch = SuperClawOrchestrator(store)
    bound = orch._maybe_bind_team_mcp(BoboCliBackend(), _direct_session(store), _limits(tmp_path))
    assert _operator_config_path(bound) is None


def test_bclass_operator_run_is_skipped(store, tmp_path):
    """A B-class backend executes operator company tools in-loop; it must NOT also
    receive the operator MCP proxy (no double-stacking the same vocabulary)."""
    orch = SuperClawOrchestrator(store)
    for backend in (GeminiAgentBackend(), AnthropicAgentBackend()):
        bound = orch._maybe_bind_team_mcp(backend, _direct_session(store), _limits(tmp_path))
        assert _operator_config_path(bound) is None


# --------------------------------------------------------------------------- #
# operator proxy: admin scope re-derivation + the audience-isolation seam
# --------------------------------------------------------------------------- #
def test_operator_proxy_executes_with_admin_scope_cross_company(store):
    """An operator-mode proxy (operator-audience ticket + --operator-scope) re-derives
    an ADMIN scope: it can update a company it is NOT bound to. This is the authority
    the confined team channel does NOT have (asserted in the next test)."""
    home = _company(store, name="Home")
    other = _company(store, name="Other")
    token, _ = issue_run_ticket(
        store,
        run_id="op_run",
        agent_profile_id=_DIRECT_PRINCIPAL,
        company_id="local",  # the operator home pin — NOT a confinement
        audience=OPERATOR_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="op_run",
            agent_profile_id=_DIRECT_PRINCIPAL,
            company_id="local",
            token=token,
            audience=OPERATOR_MCP_AUDIENCE,
            operator_scope=True,
        )
    )
    text, is_error = _call(
        server, "company_update", {"company_profile_id": other.company_profile_id, "name": "Renamed"}
    )
    assert not is_error, text
    assert json.loads(text)["status"] == "executed"
    assert store.get_company_profile(other.company_profile_id).name == "Renamed"
    # The home pin really was non-confining (sanity: it can also touch its home).
    assert home.company_profile_id  # referenced


def test_team_proxy_cannot_cross_company_without_operator_scope(store):
    """The CONFINED team channel (no operator_scope) refuses to update a company
    outside its bound scope — the exact authority gap the operator channel closes."""
    bound_co = _company(store, name="Bound")
    other = _company(store, name="Other")
    agent = _agent(store, bound_co.company_profile_id)
    token, _ = issue_run_ticket(
        store,
        run_id="team_run",
        agent_profile_id=agent.profile_id,
        company_id=bound_co.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="team_run",
            agent_profile_id=agent.profile_id,
            company_id=bound_co.company_profile_id,
            token=token,
        )
    )
    text, is_error = _call(
        server, "company_update", {"company_profile_id": other.company_profile_id, "name": "Hijacked"}
    )
    assert is_error
    assert "forbidden" in text
    assert store.get_company_profile(other.company_profile_id).name == "Other"  # untouched


def test_operator_mode_refuses_team_audience_ticket_no_escalation(store):
    """THE escalation seam: a confined team ticket (audience=team-mcp) presented to an
    operator-mode proxy is REFUSED by the audience match — so flipping --operator-scope
    on a team run's argv can never upgrade a confined ticket to admin authority."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    team_token, _ = issue_run_ticket(
        store,
        run_id="r",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,  # a TEAM ticket
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    # Proxy launched in operator mode but expecting the operator audience.
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="r",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            token=team_token,
            audience=OPERATOR_MCP_AUDIENCE,
            operator_scope=True,
        )
    )
    text, is_error = _call(server, "company_update", {"company_profile_id": company.company_profile_id, "name": "X"})
    assert is_error
    assert "ticket verification failed" in text


def test_team_mode_refuses_operator_audience_ticket(store):
    """Symmetric seam: an operator-audience ticket cannot be replayed on the confined
    team-mode proxy either (single-audience: no cross-channel replay in any direction)."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    op_token, _ = issue_run_ticket(
        store,
        run_id="r",
        agent_profile_id=agent.profile_id,
        company_id=company.company_profile_id,
        audience=OPERATOR_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="r",
            agent_profile_id=agent.profile_id,
            company_id=company.company_profile_id,
            token=op_token,
            audience=TEAM_MCP_AUDIENCE,
        )
    )
    text, is_error = _call(server, "company_create", {"name": "X"})
    assert is_error
    assert "ticket verification failed" in text


def test_operator_scope_with_team_audience_is_refused_no_escalation(store):
    """THE escalation attack (advisor agy R1): a confined team agent rewrites its own
    MCP config to KEEP --audience team-mcp (so its valid team ticket passes the audience
    match) while ALSO adding --operator-scope (hoping to get admin). The (0) binding
    guard refuses the mismatch BEFORE any verification, so a valid team ticket can NEVER
    be laundered into admin by toggling the flag. Without the guard this call would
    execute a cross-company update under is_admin=True."""
    bound_co = _company(store, name="Bound")
    other = _company(store, name="Other")
    agent = _agent(store, bound_co.company_profile_id)
    # A perfectly valid TEAM ticket for the agent's own confined run.
    team_token, _ = issue_run_ticket(
        store,
        run_id="r",
        agent_profile_id=agent.profile_id,
        company_id=bound_co.company_profile_id,
        audience=TEAM_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    # The attacker's proxy: team audience (so the token verifies) + operator_scope.
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="r",
            agent_profile_id=agent.profile_id,
            company_id=bound_co.company_profile_id,
            token=team_token,
            audience=TEAM_MCP_AUDIENCE,
            operator_scope=True,
        )
    )
    text, is_error = _call(
        server, "company_update", {"company_profile_id": other.company_profile_id, "name": "Hijacked"}
    )
    assert is_error
    assert "operator scope requires the operator-mcp audience" in text
    # The cross-company target was NOT mutated — the guard fired before dispatch.
    assert store.get_company_profile(other.company_profile_id).name == "Other"


def test_operator_channel_attributes_owner_to_session_principal(store):
    """Audit parity (advisor codex R2): a company created over the operator MCP channel
    is owned by the SESSION principal — the SAME attribution the B-class in-loop direct
    chat produces (test_company_tools asserts owner_id == the chat principal). The
    operator channel must NOT relabel ownership to a constant, or owner_id / approval
    requested_by would drift between A-class and B-class for the same chat."""
    token, _ = issue_run_ticket(
        store,
        run_id="op_run",
        agent_profile_id=_DIRECT_PRINCIPAL,  # = _run_principal(session) for the direct chat
        company_id="local",
        audience=OPERATOR_MCP_AUDIENCE,
        allowed_actions=list(TEAM_COMMAND_ACTIONS),
        ttl_seconds=300.0,
    )
    server = TeamMcpProxyServer(
        _options(
            store,
            run_id="op_run",
            agent_profile_id=_DIRECT_PRINCIPAL,
            company_id="local",
            token=token,
            audience=OPERATOR_MCP_AUDIENCE,
            operator_scope=True,
        )
    )
    text, is_error = _call(server, "company_create", {"name": "FreshCo"})
    assert not is_error, text
    new_id = json.loads(text)["detail"]["company_profile_id"]
    assert store.get_company_profile(new_id).owner_id == _DIRECT_PRINCIPAL


def test_unresolved_team_agent_gets_no_ticket(store, tmp_path):
    """A team run whose agent profile cannot be resolved → no ticket (fail-closed)."""
    orch = SuperClawOrchestrator(store)
    session = RunSession(
        goal_id="g",
        run_id="run_ghost",
        execution_context={"principal": "op_1", "agent_run_context": {"agent_profile_id": "ghost_agent"}},
    )
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, _limits(tmp_path))
    assert _team_config_path(bound) is None


def test_non_mcp_backend_team_run_is_skipped(store, tmp_path):
    """A team run on a non-MCP-capable backend (e.g. bobo) gets no proxy."""
    from superclaw.backends import BoboCliBackend

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    bound = orch._maybe_bind_team_mcp(BoboCliBackend(), session, _limits(tmp_path))
    assert _team_config_path(bound) is None


def test_company_tools_disabled_skips_projection(store, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_COMPANY_TOOLS", "0")
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, _limits(tmp_path))
    assert _team_config_path(bound) is None


def test_nan_budget_does_not_mint_immortal_ticket(store, tmp_path):
    """A non-finite budget is sanitized to the floor; the ticket has a FINITE,
    bounded expiry (never NaN → never-expiring)."""
    import math

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent, run_id="run_nan")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=float("nan"),  # type: ignore[arg-type]
        permission_policy=PermissionPolicy.from_values(mode="allow"),
    )
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, limits)
    config_path = _team_config_path(bound)
    assert config_path is not None  # still wired (budget sanitized, not refused)
    # The persisted ticket's expiry is finite and bounded by the cap.
    token = open(_ticket_file_from_config(config_path)).read().strip()
    from superclaw.company_ticket import _hash_secret

    record = store.get_run_ticket_by_hash(_hash_secret(token.split(".")[-1]))
    assert record is not None
    assert math.isfinite(record.expires_at)
    assert record.expires_at - record.issued_at == pytest.approx(360.0)  # floor 60 + 300


def test_readonly_posture_projects_read_only(store, tmp_path):
    """A read-only posture (mode=plan) DENIES mutating company tools for B-class but
    keeps the READ tools; the A-class proxy must match — project the proxy with a
    READ-only ticket (write action ticket-denied, read action permitted)."""
    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(mode="plan"),
    )
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, limits)
    config_path = _team_config_path(bound)
    assert config_path is not None  # projected (no longer skipped)
    token = open(_ticket_file_from_config(config_path)).read().strip()
    _assert_ticket_read_only(
        store, token, audience=TEAM_MCP_AUDIENCE, run_id=session.run_id,
        agent_profile_id=agent.profile_id, company_id=company.company_profile_id,
    )


def test_low_trust_containment_projects_read_only(store, tmp_path):
    """A low-trust containment fence floors the run read-only; WRITE company tools
    are denied for B-class but READS stay, so the A-class proxy projects a READ-only
    ticket too (write ticket-denied, read permitted)."""
    from superclaw.containment import get_preset

    company = _company(store)
    agent = _agent(store, company.company_profile_id)
    orch = SuperClawOrchestrator(store)
    session = _team_session(store, agent)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        budget_seconds=120,
        permission_policy=PermissionPolicy.from_values(mode="bypassPermissions"),
        containment_policy=get_preset("low_trust_review"),
    )
    bound = orch._maybe_bind_team_mcp(CodexCliBackend(), session, limits)
    config_path = _team_config_path(bound)
    assert config_path is not None  # projected (no longer skipped)
    token = open(_ticket_file_from_config(config_path)).read().strip()
    _assert_ticket_read_only(
        store, token, audience=TEAM_MCP_AUDIENCE, run_id=session.run_id,
        agent_profile_id=agent.profile_id, company_id=company.company_profile_id,
    )


def test_write_ticket_file_refuses_symlink(tmp_path):
    """A pre-planted symlink at the sidecar path is refused (O_NOFOLLOW), so the
    secret cannot be redirected/pre-read through a symlink."""
    import os

    target = tmp_path / "real-target"
    link = tmp_path / "ticket.key"
    target.write_text("")
    os.symlink(target, link)
    with pytest.raises(OSError):
        write_ticket_file(link, "secret")
    # The symlink target was NOT written through.
    assert target.read_text() == ""


def test_agent_shell_cannot_read_ticket_sidecar(store, tmp_path, monkeypatch):
    """The team-ticket sidecar is name-blacklisted in credential_guard so an
    agent's own File/Command tool cannot read its bearer secret out of the state
    dir (defense in depth; leakage reduction)."""
    from superclaw.credential_guard import is_protected_path

    # The sidecar lives next to state.db under a HOME-rooted ~/.superclaw to match
    # the blacklist scope; simulate by pointing HOME at tmp and naming the file.
    home = tmp_path
    sc = home / ".superclaw"
    sc.mkdir(parents=True, exist_ok=True)
    sidecar = sc / "superclaw-team-ticket-run_x.key"
    sidecar.write_text("secret")
    assert is_protected_path(str(sidecar), home=home) is True
