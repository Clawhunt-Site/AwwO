"""P3: ClawHunt marketplace tool projection into the chat (B-class) backends.

Mirrors test_company_tools.py for the marketplace namespace: the SOLVER marketplace
commands projected as in-process agent tools, dispatched through the orchestrator-
bound resolver into marketplace_handler.execute_marketplace_command. Covers:
single-source schema (buyer-side excluded), the projection toggle (default ON,
fail-closed), the _exec_tool dispatch (route → resolver; mutating writes denied
under read-only posture; reads allowed), mutating classification, and the resolver
end-to-end (browse read → executed; claim write → pending approval; no agent key →
error string, never a crash).
"""

from __future__ import annotations

import json
import time

import pytest

from superclaw import marketplace_handler
from superclaw.backends import (
    AnthropicAgentBackend,
    GeminiAgentBackend,
    WorkerLimits,
    _RealToolExecution,
)
from superclaw.marketplace_commands import (
    MARKETPLACE_SOLVER_TOOL_NAMES,
    MARKETPLACE_WRITE_TOOL_NAMES,
)
from superclaw.models import CompanyProfile, MarketplaceOrderStatus, RunSession
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.permissions import _MUTATING_TOOLS
from superclaw.runtime import PermissionPolicy
from superclaw.state import StateStore
from superclaw.ui_contracts import (
    MARKETPLACE_COMMAND_TOOLS,
    MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE,
    build_marketplace_command_tool_schema,
)


class _Settings:
    def __init__(self, agent_api_key="cph_test", base_url="https://clawhunt.test"):
        self.agent_api_key = agent_api_key
        self.base_url = base_url


class FakeClient:
    def __init__(self, agent_api_key="cph_test"):
        self.settings = _Settings(agent_api_key)

    def browse(self, *, skip=0, limit=50, status=None):
        return {"ok": True, "status_code": 200, "body": {"problems": [{"id": 1}, {"id": 2}, {"id": 3}]}}


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store):
    return store.save_company_profile(CompanyProfile(name="Acme"))


def _limits(tmp_path, *, resolver=None, mode="allow"):
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        permission_policy=PermissionPolicy.from_values(mode=mode),
        marketplace_command_resolver=resolver,
    )


def _session(company_id=None):
    ec = {"principal": "op_1"}
    if company_id is not None:
        ec["company_profile_id"] = company_id
    return RunSession(goal_id="g", run_id="run_direct", execution_context=ec)


def _connect_fake(monkeypatch, *, agent_api_key="cph_test"):
    monkeypatch.setattr(marketplace_handler, "_default_client_factory",
                        lambda: FakeClient(agent_api_key))


# --- single-source schema ----------------------------------------------------


def test_schema_is_solver_set_buyer_side_excluded():
    names = set(MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE)
    assert names == set(MARKETPLACE_SOLVER_TOOL_NAMES)
    # buyer-side accept/accept_bid are NOT projected
    assert "marketplace_accept" not in names and "marketplace_accept_bid" not in names
    assert len(MARKETPLACE_COMMAND_TOOLS) == len(names)


def test_gemini_and_anthropic_schemas_match():
    g = {t["function"]["name"] for t in build_marketplace_command_tool_schema("gemini")}
    a = {t["name"] for t in build_marketplace_command_tool_schema("anthropic")}
    assert g == a == set(MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE)
    for t in build_marketplace_command_tool_schema("gemini"):
        assert t["type"] == "function" and set(t["function"]) == {"name", "description", "parameters"}


def test_schema_is_deep_copy():
    tools = build_marketplace_command_tool_schema("anthropic")
    tools[0]["input_schema"]["properties"]["__hacked__"] = {"type": "string"}
    for src in MARKETPLACE_COMMAND_TOOLS:
        assert "__hacked__" not in src["input_schema"]["properties"]


# --- projection toggle + fail-closed injection -------------------------------


def _injects(backend, tmp_path, schema, *, resolver, env=None, monkeypatch=None):
    if monkeypatch is not None:
        if env is None:
            monkeypatch.delenv("SUPERCLAW_MARKETPLACE_TOOLS", raising=False)
        else:
            monkeypatch.setenv("SUPERCLAW_MARKETPLACE_TOOLS", env)
    out = backend._maybe_add_marketplace_tools([], limits=_limits(tmp_path, resolver=resolver), schema=schema)
    if schema == "gemini":
        return {t["function"]["name"] for t in out}
    return {t["name"] for t in out}


def test_injected_when_enabled_and_resolver_bound(tmp_path, monkeypatch):
    names = _injects(GeminiAgentBackend(), tmp_path, "gemini",
                     resolver=lambda ct, a: "ok", monkeypatch=monkeypatch)
    assert names == set(MARKETPLACE_TOOL_NAME_TO_COMMAND_TYPE)


def test_not_injected_without_resolver(tmp_path, monkeypatch):
    names = _injects(AnthropicAgentBackend(), tmp_path, "anthropic", resolver=None, monkeypatch=monkeypatch)
    assert names == set()


def test_not_injected_when_disabled_or_garbled(tmp_path, monkeypatch):
    for env in ("false", "maybe"):
        names = _injects(GeminiAgentBackend(), tmp_path, "gemini",
                         resolver=lambda ct, a: "ok", env=env, monkeypatch=monkeypatch)
        assert names == set(), env


# --- _exec_tool dispatch -----------------------------------------------------


def test_exec_tool_routes_marketplace_name_to_resolver(tmp_path):
    seen = []
    runner = _RealToolExecution()
    out = runner._exec_tool(
        "marketplace_browse", {"limit": 5},
        _limits(tmp_path, resolver=lambda ct, a: seen.append((ct, a)) or "RESOLVED"),
        time.monotonic() + 30,
    )
    assert out == "RESOLVED"
    assert seen == [("marketplace.browse", {"limit": 5})]


def test_exec_tool_fail_closed_without_resolver(tmp_path):
    runner = _RealToolExecution()
    out = runner._exec_tool("marketplace_claim", {"problem_id": "1", "company_profile_id": "c"},
                            _limits(tmp_path, resolver=None), time.monotonic() + 30)
    assert out.startswith("error: marketplace tool 'marketplace_claim' is unavailable")


def test_exec_tool_write_denied_under_readonly_posture(tmp_path):
    called = []
    runner = _RealToolExecution()
    out = runner._exec_tool("marketplace_claim", {"problem_id": "1", "company_profile_id": "c"},
                            _limits(tmp_path, resolver=lambda ct, a: called.append(1) or "ok", mode="plan"),
                            time.monotonic() + 30)
    assert "permission denied" in out and "read-only" in out
    assert not called  # write never reached the resolver


def test_writes_mutating_reads_not():
    assert set(MARKETPLACE_WRITE_TOOL_NAMES) <= _MUTATING_TOOLS
    assert "marketplace_browse" not in _MUTATING_TOOLS
    assert "marketplace_inspect" not in _MUTATING_TOOLS


# --- orchestrator resolver end-to-end ----------------------------------------


def test_resolver_browse_read_executes(store, monkeypatch):
    _connect_fake(monkeypatch)
    company = _company(store)
    resolver = SuperClawOrchestrator(store)._build_marketplace_command_resolver(
        _session(company.company_profile_id))
    payload = json.loads(resolver("marketplace.browse", {"status": "open"}))
    assert payload["status"] == "executed"
    assert payload["detail"]["count"] == 3


def test_resolver_claim_pending_approval(store, monkeypatch):
    _connect_fake(monkeypatch)
    company = _company(store)
    resolver = SuperClawOrchestrator(store)._build_marketplace_command_resolver(
        _session(company.company_profile_id))
    payload = json.loads(resolver(
        "marketplace.claim",
        {"problem_id": "42", "company_profile_id": company.company_profile_id}))
    assert payload["status"] == "pending_approval"
    assert payload["executed"] is False and "STOP" in payload["message"]
    order_id = payload["detail"]["order_id"]
    assert store.get_marketplace_order(order_id).status == \
        MarketplaceOrderStatus.CLAIM_APPROVAL_PENDING.value


def test_resolver_no_agent_key_returns_error_not_crash(store, monkeypatch):
    _connect_fake(monkeypatch, agent_api_key=None)
    company = _company(store)
    resolver = SuperClawOrchestrator(store)._build_marketplace_command_resolver(
        _session(company.company_profile_id))
    out = resolver("marketplace.browse", {})
    assert out.startswith("error: ClawHunt not connected")


def test_resolver_malformed_args_returns_error(store, monkeypatch):
    _connect_fake(monkeypatch)
    company = _company(store)
    resolver = SuperClawOrchestrator(store)._build_marketplace_command_resolver(
        _session(company.company_profile_id))
    out = resolver("marketplace.claim", {"problem_id": "1", "company_profile_id": "c", "evil": 1})
    assert out.startswith("error: invalid marketplace command")
