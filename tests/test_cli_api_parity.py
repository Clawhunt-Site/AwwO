"""CLI/API parity ledger for the team governance surface."""

import tempfile
from pathlib import Path

from apps.api.main import create_app
from superclaw.cli import app as cli_app


_TEAM_GROUPS = {"issue", "agent", "approve", "workspace", "company", "team"}


def _walk_cli_commands(typer_app, prefix: tuple[str, ...]) -> set[str]:
    out: set[str] = set()
    for cmd in getattr(typer_app, "registered_commands", []):
        name = cmd.name or (cmd.callback.__name__ if cmd.callback else "")
        out.add(" ".join((*prefix, name)))
    for group in getattr(typer_app, "registered_groups", []):
        out |= _walk_cli_commands(group.typer_instance, (*prefix, group.name))
    return out


def _team_cli_commands() -> set[str]:
    out: set[str] = set()
    for group in cli_app.registered_groups:
        if group.name not in _TEAM_GROUPS:
            continue
        out |= _walk_cli_commands(group.typer_instance, (group.name,))
    return out


def _api_routes() -> set[tuple[str, str]]:
    app = create_app(state_path=Path(tempfile.mkdtemp()) / "state.db")
    routes: set[tuple[str, str]] = set()
    for route in app.routes:
        path = getattr(route, "path", "")
        for method in getattr(route, "methods", None) or set():
            if method not in {"HEAD", "OPTIONS"}:
                routes.add((method, path))
    return routes


def _team_api_routes() -> set[tuple[str, str]]:
    return {route for route in _api_routes() if route[1].startswith("/api/team")}


_CLI_TO_TEAM_API: dict[str, tuple[str, str]] = {
    "agent create-profile": ("POST", "/api/team/agents"),
    "agent list": ("GET", "/api/team/agents"),
    "agent show": ("GET", "/api/team/agents/{profile_id}"),
    "agent update-profile": ("PATCH", "/api/team/agents/{profile_id}"),
    "agent update-charter": ("POST", "/api/team/agents/{profile_id}/charter"),
    "agent request-config-change": ("POST", "/api/team/agents/{profile_id}/request-config-change"),
    "agent request-hire": ("POST", "/api/team/agents/request-hire"),
    "approve grant": ("POST", "/api/team/approvals/{approval_id}/grant"),
    "approve reject": ("POST", "/api/team/approvals/{approval_id}/reject"),
    "approve revision": ("POST", "/api/team/approvals/{approval_id}/request-revision"),
    "approve list": ("GET", "/api/team/approvals"),
    "approve show": ("GET", "/api/team/approvals/{approval_id}"),
    "company init": ("POST", "/api/team/companies"),
    "company list": ("GET", "/api/team/companies"),
    "company show": ("GET", "/api/team/companies/{company_profile_id}"),
    "company snapshot": ("GET", "/api/team/companies/{company_profile_id}/snapshot"),
    # Chat-driven company management — CLI, chat tool projection, and REST all
    # route the SAME company_handler.execute_company_command (zero divergence).
    "company create": ("POST", "/api/team/companies/commands"),
    "company update": ("POST", "/api/team/companies/commands"),
    "company archive": ("POST", "/api/team/companies/commands"),
    "company hire": ("POST", "/api/team/companies/commands"),
    "company update-agent": ("POST", "/api/team/companies/commands"),
    "company create-issue": ("POST", "/api/team/companies/commands"),
    "company assign-issue": ("POST", "/api/team/companies/commands"),
    "company delegate-issue": ("POST", "/api/team/companies/commands"),
    "company comment": ("POST", "/api/team/companies/commands"),
    "company attach-work-product": ("POST", "/api/team/companies/commands"),
    "company submit-review": ("POST", "/api/team/companies/commands"),
    "company set-charter": ("POST", "/api/team/companies/commands"),
    "company update-work-product": ("POST", "/api/team/companies/commands"),
    "company block-issue": ("POST", "/api/team/companies/commands"),
    "company unblock-issue": ("POST", "/api/team/companies/commands"),
    "company hold-issue": ("POST", "/api/team/companies/commands"),
    "company unhold-issue": ("POST", "/api/team/companies/commands"),
    "company requeue-issue": ("POST", "/api/team/companies/commands"),
    "company author-routine": ("POST", "/api/team/companies/commands"),
    "company pause-issue-tree": ("POST", "/api/team/companies/commands"),
    "company resume-issue-tree": ("POST", "/api/team/companies/commands"),
    "company cancel-issue-tree": ("POST", "/api/team/companies/commands"),
    "company messages": ("GET", "/api/team/messages"),
    "company mark-read": ("POST", "/api/team/messages/mark-read"),
    "workspace create": ("POST", "/api/team/workspaces"),
    "workspace trust": ("POST", "/api/team/workspaces/trust"),
    "workspace list": ("GET", "/api/team/workspaces"),
    "workspace containment": ("POST", "/api/team/workspaces/{workspace_id}/containment"),
    "issue create": ("POST", "/api/team/issues"),
    "issue list": ("GET", "/api/team/issues"),
    "issue assign": ("POST", "/api/team/issues/{issue_id}/assign"),
    "issue checkout": ("POST", "/api/team/issues/{issue_id}/checkout"),
    "issue submit": ("POST", "/api/team/issues/{issue_id}/submit"),
    "issue requeue": ("POST", "/api/team/issues/{issue_id}/requeue"),
    "issue block": ("POST", "/api/team/issues/{issue_id}/block"),
    "issue unblock": ("POST", "/api/team/issues/{issue_id}/unblock"),
    "issue delegate": ("POST", "/api/team/issues/{issue_id}/delegate"),
    "issue comment": ("POST", "/api/team/issues/{issue_id}/comments"),
    "issue comments": ("GET", "/api/team/issues/{issue_id}/comments"),
    "issue hold": ("POST", "/api/team/issues/{issue_id}/hold"),
    "issue unhold": ("POST", "/api/team/issues/{issue_id}/unhold"),
    "issue tree": ("GET", "/api/team/issues/{issue_id}/tree"),
    "issue pause-tree": ("POST", "/api/team/issues/{issue_id}/tree/pause"),
    "issue resume-tree": ("POST", "/api/team/issues/{issue_id}/tree/resume"),
    "issue cancel-tree": ("POST", "/api/team/issues/{issue_id}/tree/cancel"),
    "issue work-product": ("POST", "/api/team/issues/{issue_id}/work-products"),
    "issue work-products": ("GET", "/api/team/issues/{issue_id}/work-products"),
    "issue work-product-update": ("PATCH", "/api/team/work-products/{work_product_id}"),
    "issue work-product-remove": ("DELETE", "/api/team/work-products/{work_product_id}"),
    "team bootstrap": ("POST", "/api/team/bootstrap"),
    "team inventory": ("GET", "/api/team/inventory"),
    "team catalog inspect": ("POST", "/api/team/catalog/preview"),
    "team board-inbox list": ("GET", "/api/team/board-inbox"),
    "team board-inbox resolve": ("POST", "/api/team/board-inbox/{interaction_id}/resolve"),
    "team board-inbox assign": ("POST", "/api/team/board-inbox/{interaction_id}/assign"),
    "team routine author": ("POST", "/api/team/routines/author"),
    "team routine list": ("GET", "/api/team/routines"),
    "team routine runs": ("GET", "/api/team/routines/{routine_id}/runs"),
}


_CLI_TO_OTHER_API: dict[str, tuple[str, str]] = {
    "company export": ("POST", "/api/companies/{company_profile_id}/export"),
    "company set-logo": ("POST", "/api/companies/{company_profile_id}/logo"),
    "company clear-logo": ("DELETE", "/api/companies/{company_profile_id}/logo"),
    "workspace create-personal": ("POST", "/api/workspaces"),
    "workspace archive-session": ("POST", "/api/chat/sessions/{session_id}/archive"),
    "workspace unarchive-session": ("POST", "/api/chat/sessions/{session_id}/archive"),
    "workspace pin-session": ("POST", "/api/chat/sessions/{session_id}/pin"),
    "workspace unpin-session": ("POST", "/api/chat/sessions/{session_id}/pin"),
    "workspace move-session": ("POST", "/api/chat/sessions/{session_id}/move"),
    "workspace sessions": ("GET", "/api/chat/sessions"),
    "workspace pin": ("POST", "/api/workspaces/{workspace_id}/pin"),
    "workspace unpin": ("POST", "/api/workspaces/{workspace_id}/pin"),
    "workspace rename": ("PATCH", "/api/workspaces/{workspace_id}"),
    "workspace remove": ("DELETE", "/api/workspaces/{workspace_id}"),
}


_CLI_ONLY: dict[str, str] = {
    "agent run-context": "operator/debug introspection of a profile's resolved run context",
    "company template validate": "local package validation; API preview uses team catalog inspect",
    "workspace adopt": "local filesystem directory adoption; not a remote API operation",
}


_KNOWN_PARITY_GAPS: dict[str, str] = {}


_TEAM_API_ONLY: dict[tuple[str, str], str] = {
    ("GET", "/api/team/locks"): "workspace-lock observability",
    ("GET", "/api/team/wakeups"): "wakeup-queue observability",
    ("GET", "/api/team/issues/{issue_id}/runs"): "issue run-ledger observability; read-only projection of existing wakeup/run facts",
    ("GET", "/api/team/daemon/status"): "daemon status; CLI twin is top-level daemon status",
    ("GET", "/api/team/daemon/broker/status"): "daemon broker control-plane observability",
    ("POST", "/api/team/daemon/broker/sessions"): "daemon broker control-plane session issuance",
    ("POST", "/api/team/daemon/broker/tokens"): "daemon broker control-plane token issuance",
    ("POST", "/api/team/daemon/broker/tokens/validate"): "daemon broker control-plane token validation",
    ("POST", "/api/team/daemon/broker/materializations"): "daemon broker materialization control plane",
    ("DELETE", "/api/team/daemon/broker/sessions/{session_id}"): "daemon broker session close",
}


def test_classification_buckets_are_disjoint():
    cli_buckets = [
        set(_CLI_TO_TEAM_API),
        set(_CLI_TO_OTHER_API),
        set(_CLI_ONLY),
        set(_KNOWN_PARITY_GAPS),
    ]
    for i, left in enumerate(cli_buckets):
        for right in cli_buckets[i + 1 :]:
            overlap = left & right
            assert not overlap, f"CLI command classified twice: {sorted(overlap)}"
    api_buckets = [set(_CLI_TO_TEAM_API.values()), set(_TEAM_API_ONLY)]
    for i, left in enumerate(api_buckets):
        for right in api_buckets[i + 1 :]:
            overlap = left & right
            assert not overlap, f"API route classified twice: {sorted(overlap)}"


def test_every_team_cli_command_is_classified_for_parity():
    commands = _team_cli_commands()
    classified = set(_CLI_TO_TEAM_API) | set(_CLI_TO_OTHER_API) | set(_CLI_ONLY) | set(_KNOWN_PARITY_GAPS)
    undeclared = commands - classified
    assert not undeclared, f"team CLI commands not declared in parity ledger: {sorted(undeclared)}"
    stale = classified - commands
    assert not stale, f"parity ledger references non-existent CLI commands: {sorted(stale)}"


def test_every_mapped_api_route_exists():
    routes = _api_routes()
    mapped = set(_CLI_TO_TEAM_API.values()) | set(_CLI_TO_OTHER_API.values()) | set(_TEAM_API_ONLY)
    missing = mapped - routes
    assert not missing, f"parity ledger maps API routes that do not exist: {sorted(missing)}"


def test_every_team_api_route_is_in_the_ledger():
    routes = _team_api_routes()
    ledgered = set(_CLI_TO_TEAM_API.values()) | set(_TEAM_API_ONLY)
    unledgered = routes - ledgered
    assert not unledgered, f"/api/team routes not in parity ledger: {sorted(unledgered)}"


def test_known_parity_gaps_are_recorded_with_reasons():
    for command, reason in _KNOWN_PARITY_GAPS.items():
        assert reason.strip(), f"parity gap {command!r} recorded without a reason"
