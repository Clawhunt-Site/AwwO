import builtins
from dataclasses import dataclass
import io
import json
import os
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace

import httpx
import pytest
from typer.testing import CliRunner

import superclaw.cli as cli_module
from superclaw.cli import app
from superclaw.models import (
    AgentProfile,
    ChildExecution,
    CompanyProfile,
    ContinuationPolicy,
    EvidenceBundle,
    GoalSpec,
    Issue,
    IssueThreadInteraction,
    RunMutationLease,
    RunMutationMode,
    RunSession,
    RunStatus,
    WorkerResult,
    WorkspaceProfile,
)
from superclaw.state import StateStore
from superclaw.orchestrator import SuperClawOrchestrator

def _trust_cwd_workspace(state_path, repo="."):
    """Register a repo as a trusted workspace (ADR workspace-trust-container):
    chat now fails closed in directories without one."""
    StateStore(state_path).save_workspace_profile(
        WorkspaceProfile(name="test-repo", repo_path=str(repo), trust_source="api")
    )


@pytest.fixture(autouse=True)
def isolate_shell_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))


def _guard_process_env(monkeypatch, *names):
    """Keep ``names`` unset during the test and restore pre-test values at teardown.

    Shell commands like ``/config set``, ``/setup``, and ``/login`` write values
    into live ``os.environ``.  A plain ``monkeypatch.delenv(name, raising=False)``
    records no undo entry when the variable starts unset, so those writes leak
    into later tests.  Setting a sentinel first forces monkeypatch to snapshot
    the true pre-test value; the delenv keeps the variable unset for the test,
    and LIFO undo lands on the original value at teardown.
    """
    for name in names:
        monkeypatch.setenv(name, "superclaw-test-env-guard")
        monkeypatch.delenv(name)


def _create_cli_evidence_run(state_path: Path, artifact_root: Path):
    store = StateStore(state_path)
    goal = store.create_goal(GoalSpec(title="Media evidence", description="Attach generated media artifacts"))
    session = store.create_run(goal.goal_id, dry_run=True)
    session.execution_context["artifact_dir"] = str(artifact_root)
    store.save_run(session)
    store.create_evidence(session.run_id)
    return store, session


def _create_cli_delegation_review_run(state_path: Path, repo_path: Path, *, waiting: bool = True):
    orchestrator = SuperClawOrchestrator.from_path(state_path)
    goal = orchestrator.store.create_goal(GoalSpec(title="Delegate review", description="Review a child result"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=repo_path,
        artifact_dir=repo_path / "artifacts",
    )
    request_key = "tool:delegate-call-1"
    session.execution_context["delegate_tool_results"] = [
        {
            "tool_name": "delegate",
            "tool_call_id": "delegate-call-1",
            "request_key": request_key,
            "status": "pending_review",
            "parent_run_id": session.run_id,
            "parent_task_id": "task_parent",
            "child_run_id": "run_child_1",
            "child_task_id": "childtask_1",
            "child_status": "completed",
            "chain_verdict": "CHAIN_PASS",
            "content": {"summary": "child finished", "output": "done"},
            "review": None,
        },
        {
            "tool_name": "delegate",
            "tool_call_id": "delegate-call-2",
            "request_key": "tool:already-approved",
            "status": "approved",
            "parent_run_id": session.run_id,
            "child_run_id": "run_child_2",
            "review": {"reviewed_by": "qa", "approved": True, "reviewed_at": 1.0},
        },
    ]
    session.execution_context["child_delegation_waits"] = [
        {
            "request_key": request_key,
            "parent_tool_call_id": "delegate-call-1",
            "child_run_id": "run_child_1",
            "tool_result_status": "pending_review",
            "status": "pending_review",
        }
    ]
    if waiting:
        session.status = RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    orchestrator.store.save_run(session)
    return session, request_key


def _team_bootstrap_template(**overrides):
    template = {
        "schema_version": "agentcompanies/v1",
        "metadata": {
            "source": "catalog://superclaw/core-exec-team",
            "revision": "1.0.0",
            "digest": "sha256:template-digest",
        },
        "company": {
            "company_profile_id": "company_acme",
            "name": "Acme",
            "goal": "Ship safely.",
            "default_budget_seconds": 120,
            "default_token_budget": 1000,
        },
        "workspace": {
            "workspace_id": "workspace_acme",
            "name": "Acme Repo",
            "repo_path": ".",
            "writable_paths": ["."],
            "network_policy": "restricted",
        },
        "roles": [
            {
                "id": "ceo",
                "name": "CEO",
                "role": "ceo",
                "charter": "Coordinate work and request review.",
                "plugin_allowlist": ["inventory.viewer"],
                "skill_allowlist": ["planning"],
                "budget_seconds": 90,
            }
        ],
        "seed_issue": {"title": "Bootstrap", "description": "Start with a narrow plan."},
    }
    template.update(overrides)
    return template


def _write_team_template(tmp_path: Path, template: dict) -> Path:
    path = tmp_path / "agentcompanies.json"
    path.write_text(json.dumps(template), encoding="utf-8")
    return path


def _assert_empty_team_state(state_path: Path):
    store = StateStore(state_path)
    assert store.list_company_profiles() == []
    assert store.list_workspace_profiles() == []
    assert store.list_agent_profiles() == []
    assert store.list_issues() == []


def _seed_cli_team_ops_state(state_path: Path) -> dict[str, str]:
    store = StateStore(state_path)
    store.save_company_profile(CompanyProfile(name="Acme", company_profile_id="company_acme"))
    store.save_workspace_profile(
        WorkspaceProfile(
            name="Acme Repo",
            workspace_id="workspace_acme",
            company_profile_id="company_acme",
            repo_path=".",
        )
    )
    profile = store.save_agent_profile(
        AgentProfile(
            name="Operator",
            role="operator",
            profile_id="agent_operator",
            workspace_id="workspace_acme",
            company_profile_id="company_acme",
        )
    )
    issue = store.save_issue(
        Issue(
            title="Review blocked child",
            issue_id="issue_parent",
            workspace_id="workspace_acme",
            company_profile_id="company_acme",
        )
    )
    interaction = store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue.issue_id,
            interaction_id="interact_board",
            company_profile_id="company_acme",
            kind="completion",
            continuation_policy=ContinuationPolicy.ESCALATE_TO_BOARD.value,
            payload={"child_issue_id": "issue_child"},
        )
    )
    return {
        "profile_id": profile.profile_id,
        "issue_id": issue.issue_id,
        "interaction_id": interaction.interaction_id,
    }
    assert store.list_issues() == []


def test_cli_team_catalog_inspect_returns_bootstrap_proposal_without_mutation(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    template_path = _write_team_template(tmp_path, _team_bootstrap_template())

    result = CliRunner().invoke(
        app,
        [
            "team",
            "catalog",
            "inspect",
            str(template_path),
            "--available-plugin",
            "inventory.viewer",
            "--available-skill",
            "planning",
            "--runtime-budget-seconds",
            "60",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["blocked"] is False
    assert payload["would_create"]["company_profile"]["company_profile_id"] == "company_acme"
    # Override-drift closure (§3.8): --available-plugin / --available-skill are
    # intersection HINTS, never authority. The gated universe is derived from the
    # fail-closed kernel enumerators (empty cache here), so a requested-but-ungated
    # id is NOT granted (parity with the API path). The request can never grant an
    # id that did not pass the gate.
    assert payload["equipment_resolution"][0]["granted"] == {"plugins": [], "skills": []}
    dropped_plugin_ids = {d["id"] for d in payload["equipment_resolution"][0]["dropped"]["plugins"]}
    dropped_skill_ids = {d["id"] for d in payload["equipment_resolution"][0]["dropped"]["skills"]}
    assert "inventory.viewer" in dropped_plugin_ids
    assert "planning" in dropped_skill_ids
    assert payload["role_proposals"][0]["budget_clamp"]["budget_seconds"]["effective"] == 60
    _assert_empty_team_state(state_path)


def test_cli_team_bootstrap_proposal_blocks_required_equipment_without_mutation(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    template_path = _write_team_template(
        tmp_path,
        _team_bootstrap_template(
            roles=[
                {
                    "id": "engineer",
                    "name": "Engineer",
                    "role": "engineer",
                    "charter": "Implement scoped changes and request review.",
                    "required_plugins": ["repo.writer"],
                }
            ]
        ),
    )

    result = CliRunner().invoke(
        app,
        ["team", "bootstrap", "--from-template", str(template_path), "--mode", "proposal"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["blocked"] is True
    assert {rejection["code"] for rejection in payload["rejections"]} == {"missing_required_plugin"}
    assert payload["equipment_resolution"][0]["dropped"]["plugins"] == [
        {"id": "repo.writer", "reason": "not_available_or_not_governed"}
    ]
    _assert_empty_team_state(state_path)


def test_cli_team_bootstrap_commit_materializes_clean_template(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    template_path = _write_team_template(tmp_path, _team_bootstrap_template())

    result = CliRunner().invoke(
        app,
        [
            "team",
            "bootstrap",
            "--from-template",
            str(template_path),
            "--mode",
            "commit",
            "--available-plugin",
            "inventory.viewer",
            "--available-skill",
            "planning",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["committed"] is True
    assert payload["approval_required"] is False
    store = StateStore(state_path)
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]
    assert [profile.profile_id for profile in store.list_agent_profiles()] == ["pending_agent_ceo"]
    assert [issue.issue_id for issue in store.list_issues()] == ["bootstrap_issue_company_acme"]


def _signed_company_dir(tmp_path: Path):
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from superclaw.company_template import _COMPANY_VERIFIER, CompanyTemplate

    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    pub = "ed25519:" + base64.b64encode(raw).decode()
    manifest = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery Co",
        "version": "1.0.0",
        "summary": "blueprint",
        "kind": "company",
        # Provenance-honest local/self so the local lane (--trust local) may admit it;
        # the official test below sets the root key so it verifies as official regardless.
        "source": {"type": "local", "developer_id": "self"},
        "commerce": {"pricing_model": "free"},
        "roles": [{"name": "lead", "charter": "Lead the team"}],
        "equipment_requirements": {},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "local", "package_digest": "", "signature": ""},
    }
    base = tmp_path / "co"
    base.mkdir(mode=0o700)
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    digest = _COMPANY_VERIFIER.compute_digest(CompanyTemplate(source=base, root=base, manifest=manifest))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base, pub


def test_cli_company_bootstrap_fails_closed_without_trust(tmp_path, monkeypatch):
    """An unsigned/local company template fails closed in the CLI unless an
    explicit --trust local is given (design §3.6); proposal mode writes nothing."""
    monkeypatch.delenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("SUPERCLAW_COMPANY_LOCAL_DEV_TRUST", raising=False)
    base, _pub = _signed_company_dir(tmp_path)
    result = CliRunner().invoke(app, ["team", "bootstrap", "--from-template", str(base), "--mode", "proposal"])
    assert result.exit_code == 1
    # With --trust local it is admitted as a local company.
    ok = CliRunner().invoke(
        app, ["team", "bootstrap", "--from-template", str(base), "--mode", "proposal", "--trust", "local"]
    )
    assert ok.exit_code == 0, ok.output
    payload = json.loads(ok.output)
    assert payload["company_verification"]["trust_state"] == "local"


def test_cli_company_bootstrap_official_proposal(tmp_path, monkeypatch):
    base, pub = _signed_company_dir(tmp_path)
    monkeypatch.setenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", pub)
    result = CliRunner().invoke(app, ["team", "bootstrap", "--from-template", str(base), "--mode", "proposal"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["company_verification"]["trust_state"] == "official"


def test_cli_team_bootstrap_from_catalog_resolves_and_gates(tmp_path, monkeypatch):
    """`team bootstrap --from-catalog <id>` resolves a cataloged company to its local
    source and routes it through the SAME verify-before-instantiate gate. official id
    => proposal built; the gate (not a path shortcut) still governs trust."""
    base, pub = _signed_company_dir(tmp_path)  # tmp_path/co/superclaw-company.json, id acme.delivery
    monkeypatch.setenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", pub)
    # version omitted (single local version) — resolver picks it; companies_root=tmp_path.
    result = CliRunner().invoke(
        app,
        ["team", "bootstrap", "--from-catalog", "acme.delivery", "--companies-root", str(tmp_path), "--mode", "proposal"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["company_verification"]["trust_state"] == "official"
    assert payload["company_verification"]["artifact_id"] == "acme.delivery"


def test_cli_team_bootstrap_requires_exactly_one_source(tmp_path):
    """Exactly one of --from-template / --from-catalog is required."""
    neither = CliRunner().invoke(app, ["team", "bootstrap", "--mode", "proposal"])
    assert neither.exit_code == 1
    both = CliRunner().invoke(
        app, ["team", "bootstrap", "--from-template", "x", "--from-catalog", "y", "--mode", "proposal"]
    )
    assert both.exit_code == 1


def test_cli_team_bootstrap_from_catalog_unknown_id_fails_closed(tmp_path):
    result = CliRunner().invoke(
        app,
        ["team", "bootstrap", "--from-catalog", "no.such.company", "--companies-root", str(tmp_path), "--mode", "proposal"],
    )
    assert result.exit_code == 1


def test_cli_team_bootstrap_from_catalog_ambiguous_duplicate_fails_closed(tmp_path, monkeypatch):
    """Two local dirs declaring the same id@version => the CLI surfaces the resolver's
    ambiguous fail-closed (CompanyTemplateError) as exit 1, not an uncaught crash."""
    import base64
    import json as _json

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from superclaw.company_template import _COMPANY_VERIFIER, CompanyTemplate

    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    pub = "ed25519:" + base64.b64encode(raw).decode()
    monkeypatch.setenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", pub)
    for slug in ("dir-a", "dir-b"):
        m = {
            "schema_version": 1, "id": "acme.dup", "name": "Dup", "version": "1.0.0", "summary": "d",
            "kind": "company", "source": {"type": "local", "developer_id": "self"},
            "commerce": {"pricing_model": "free"}, "roles": [{"name": "lead", "charter": "Lead"}],
            "equipment_requirements": {}, "policies": {"high_risk_policies": {}},
            "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
            "provenance": {"build_type": "local", "package_digest": "", "signature": ""},
        }
        base = tmp_path / slug
        base.mkdir()
        (base / "superclaw-company.json").write_text(_json.dumps(m), encoding="utf-8")
        digest = _COMPANY_VERIFIER.compute_digest(CompanyTemplate(source=base, root=base, manifest=m))
        m["provenance"]["package_digest"] = digest
        m["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
        (base / "superclaw-company.json").write_text(_json.dumps(m), encoding="utf-8")
    result = CliRunner().invoke(
        app,
        ["team", "bootstrap", "--from-catalog", "acme.dup@1.0.0", "--companies-root", str(tmp_path), "--mode", "proposal"],
    )
    assert result.exit_code == 1
    assert "ambiguous" in result.output


def test_cli_team_catalog_inspect_trust_local_parity(tmp_path, monkeypatch):
    """`team catalog inspect` mirrors POST /api/team/catalog/preview: it accepts
    --trust local for company templates (CLI<->API parity). Absent it, a local
    company fails closed; with it the preview admits the template as local."""
    monkeypatch.delenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("SUPERCLAW_COMPANY_LOCAL_DEV_TRUST", raising=False)
    base, _pub = _signed_company_dir(tmp_path)
    closed = CliRunner().invoke(app, ["team", "catalog", "inspect", str(base)])
    assert closed.exit_code == 1
    ok = CliRunner().invoke(app, ["team", "catalog", "inspect", str(base), "--trust", "local"])
    assert ok.exit_code == 0, ok.output
    payload = json.loads(ok.output)
    assert payload["company_verification"]["trust_state"] == "local"


def test_cli_team_bootstrap_commit_blocked_template_does_not_mutate(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    template_path = _write_team_template(
        tmp_path,
        _team_bootstrap_template(
            roles=[
                {
                    "id": "engineer",
                    "name": "Engineer",
                    "role": "engineer",
                    "charter": "Implement scoped changes and request review.",
                    "required_plugins": ["repo.writer"],
                }
            ]
        ),
    )

    result = CliRunner().invoke(
        app,
        ["team", "bootstrap", "--from-template", str(template_path), "--mode", "commit"],
    )

    assert result.exit_code == 1
    assert "blocked" in result.output
    _assert_empty_team_state(state_path)


def test_cli_team_bootstrap_commit_high_risk_waits_for_approval(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    template_path = _write_team_template(
        tmp_path,
        _team_bootstrap_template(
            workspace={
                "workspace_id": "workspace_acme",
                "name": "Acme Repo",
                "repo_path": ".",
                "writable_paths": ["."],
                "network_policy": "open",
            },
            high_risk_policies={"network_scan": True},
        ),
    )
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "team",
            "bootstrap",
            "--from-template",
            str(template_path),
            "--mode",
            "commit",
            "--available-plugin",
            "inventory.viewer",
            "--available-skill",
            "planning",
            "--by",
            "operator",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    approval_id = payload["approval"]["approval_id"]
    assert payload["committed"] is False
    assert payload["approval_required"] is True
    _assert_empty_team_state(state_path)

    grant = runner.invoke(app, ["approve", "grant", approval_id])

    assert grant.exit_code == 0, grant.output
    assert json.loads(grant.output)["approval"]["status"] == "approved"
    store = StateStore(state_path)
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]


def test_cli_daemon_broker_lifecycle_scrubs_and_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    opened = runner.invoke(app, ["daemon", "broker", "open-session", "--subject", "cli-test", "--ttl", "120"])
    assert opened.exit_code == 0, opened.output
    session_id = json.loads(opened.output)["session"]["session_id"]

    issued = runner.invoke(
        app,
        [
            "daemon",
            "broker",
            "issue-token",
            session_id,
            "--scope",
            "plugin:materialize",
            "--ttl",
            "60",
        ],
    )
    assert issued.exit_code == 0, issued.output
    issued_payload = json.loads(issued.output)
    token = issued_payload["token"]
    secret = token.rsplit(".", 1)[-1]

    status = runner.invoke(app, ["daemon", "broker", "status"])
    assert status.exit_code == 0, status.output
    assert token not in status.output
    assert secret not in status.output
    assert "secret_digest" not in status.output

    validated = runner.invoke(app, ["daemon", "broker", "validate-token", token, "--scope", "plugin:materialize"])
    assert validated.exit_code == 0, validated.output
    assert json.loads(validated.output)["valid"] is True

    source_file = tmp_path / "skill.md"
    source_file.write_text("# Skill\n", encoding="utf-8")
    materialized = runner.invoke(
        app,
        [
            "daemon",
            "broker",
            "materialize",
            token,
            "dev.superclaw.cli",
            "--manifest-json",
            json.dumps({"version": "1.0.0", "runtime": {"type": "mcp_sidecar", "secret": "hidden"}}),
            "--file",
            f"skills/skill.md={source_file}",
        ],
    )
    assert materialized.exit_code == 0, materialized.output
    materialized_path = Path(json.loads(materialized.output)["materialization"]["path"])
    assert materialized_path.exists()
    assert materialized_path.stat().st_mode & 0o777 == 0o700
    assert (materialized_path / "superclaw-plugin.json").stat().st_mode & 0o777 == 0o600
    assert "hidden" not in (materialized_path / "superclaw-plugin.json").read_text(encoding="utf-8")

    closed = runner.invoke(app, ["daemon", "broker", "close-session", session_id])
    assert closed.exit_code == 0, closed.output
    assert not materialized_path.exists()

    stale = runner.invoke(app, ["daemon", "broker", "validate-token", token, "--scope", "plugin:materialize"])
    assert stale.exit_code == 0, stale.output
    assert json.loads(stale.output)["valid"] is False


def test_cli_daemon_broker_fails_closed_for_wrong_scope_and_unsafe_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    session_id = json.loads(
        runner.invoke(app, ["daemon", "broker", "open-session"]).output
    )["session"]["session_id"]
    wrong_scope = runner.invoke(
        app,
        ["daemon", "broker", "issue-token", session_id, "--scope", "daemon:status"],
    )
    assert wrong_scope.exit_code == 0, wrong_scope.output
    wrong_scope_token = json.loads(wrong_scope.output)["token"]

    denied = runner.invoke(
        app,
        ["daemon", "broker", "materialize", wrong_scope_token, "dev.superclaw.cli"],
    )
    assert denied.exit_code == 1
    assert "invalid broker token" in denied.output

    materialize_token = json.loads(
        runner.invoke(
            app,
            ["daemon", "broker", "issue-token", session_id, "--scope", "plugin:materialize"],
        ).output
    )["token"]
    source_file = tmp_path / "unsafe.md"
    source_file.write_text("unsafe", encoding="utf-8")
    unsafe = runner.invoke(
        app,
        [
            "daemon",
            "broker",
            "materialize",
            materialize_token,
            "dev.superclaw.cli",
            "--file",
            f"../escape.md={source_file}",
        ],
    )
    assert unsafe.exit_code == 1
    assert "unsafe materialization path" in unsafe.output


def test_cli_runtime_list_emits_inventory_fact_source():
    # `runtime list` is the CLI fact source for cross-runtime delegation: one
    # JSON shot with the folded-in capability + strengths fields every surface
    # projects.
    result = CliRunner().invoke(app, ["runtime", "list"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert set(payload) == {"runtimes", "summary"}
    assert payload["summary"]["count"] == len(payload["runtimes"])
    by_name = {item["name"]: item for item in payload["runtimes"]}
    codex = by_name["codex"]
    assert codex["harness"] == "codex"
    assert codex["task_spawn"] is False
    assert codex["parallel_agents"] is True
    assert codex["strengths"]


def test_cli_capabilities_summary_show_suggest_and_doctor():
    runner = CliRunner()

    summary = runner.invoke(app, ["capabilities", "summary"])
    assert summary.exit_code == 0, summary.output
    summary_payload = json.loads(summary.output)
    assert summary_payload["total"] >= 200
    assert sum(summary_payload["by_availability"].values()) == summary_payload["total"]

    show = runner.invoke(app, ["capabilities", "show", "adversarial-verification"])
    assert show.exit_code == 0, show.output
    assert json.loads(show.output)["capability_id"] == "adversarial-verification"

    missing = runner.invoke(app, ["capabilities", "show", "not-a-real-capability"])
    assert missing.exit_code == 1

    suggest = runner.invoke(app, ["capabilities", "suggest", "generate a product launch video with captions"])
    assert suggest.exit_code == 0, suggest.output
    suggestions = json.loads(suggest.output)["suggestions"]
    assert suggestions
    assert suggestions[0]["score"] >= suggestions[-1]["score"]

    doctor = runner.invoke(app, ["capabilities", "doctor"])
    assert doctor.exit_code == 0, doctor.output
    assert json.loads(doctor.output)["ok"] is True


def test_cli_capabilities_rejects_unknown_facet_values():
    runner = CliRunner()

    bad_category = runner.invoke(app, ["capabilities", "list", "--category", "not-a-category"])
    assert bad_category.exit_code == 1
    assert "unknown category" in bad_category.output

    bad_search = runner.invoke(app, ["capabilities", "search", "seo", "--availability", "nope"])
    assert bad_search.exit_code == 1
    assert "unknown availability" in bad_search.output

    good = runner.invoke(app, ["capabilities", "list", "--category", "engineering"])
    assert good.exit_code == 0, good.output
    assert json.loads(good.output)["total"] >= 1


def test_cli_capabilities_suggest_nonpositive_limit_returns_empty():
    runner = CliRunner()

    result = runner.invoke(app, ["capabilities", "suggest", "ship a payment webhook", "--limit", "0"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["suggestions"] == []


def test_cli_capabilities_adaptable_annotates_harness_target():
    runner = CliRunner()

    result = runner.invoke(app, ["capabilities", "adaptable", "--target", "codex"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["total"] >= 100
    assert all(unit["availability"] in {"vendored", "local"} for unit in payload["capabilities"])
    assert all(unit["integration"] in {"skill", "plugin"} for unit in payload["capabilities"])
    assert payload["target"]["harness_id"] == "codex"

    unknown = runner.invoke(app, ["capabilities", "adaptable", "--target", "nope"])
    assert unknown.exit_code == 1


def test_cli_doctor_reports_secret_safe_status(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 0
    assert "SuperClaw doctor" in result.output
    assert "CLAWHUNT_AGENT_API_KEY" in result.output
    assert "cph_" not in result.output


def test_cli_clawhunt_account_login_and_agent_key_share_auth(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class FakeClawHuntAccountClient:
        settings = SimpleNamespace(base_url="https://clawhunt.test")

        def login(self, username, password):
            assert username == "leon"
            assert password == "secret"
            return {"ok": True, "status_code": 200, "body": {"access_token": "account-token", "user": {"username": "leon"}}}

        def login_probe(self):
            return {"ok": False, "status_code": 401, "body": {"detail": "用户名或密码错误"}}

        def create_agent_key(self, access_token, *, name, agent_id, permissions):
            assert access_token == "account-token"
            assert name == "SuperClaw Desktop"
            assert agent_id == 12
            assert permissions == ["browse"]
            return {"ok": True, "status_code": 201, "body": {"key": "cph_generated_123"}}

    monkeypatch.setattr(cli_module, "ClawHuntAccountClient", FakeClawHuntAccountClient)
    runner = CliRunner()

    probe = runner.invoke(app, ["clawhunt", "login-probe", "--json"])
    login = runner.invoke(app, ["clawhunt", "account-login", "--username", "leon", "--password", "secret", "--json"])
    key = runner.invoke(
        app,
        ["clawhunt", "create-agent-key", "--agent-id", "12", "--name", "SuperClaw Desktop", "--permission", "browse", "--json"],
    )
    status = runner.invoke(app, ["clawhunt", "auth-status", "--json"])

    assert probe.exit_code == 0, probe.output
    assert json.loads(probe.output)["login_endpoint"] is True
    assert login.exit_code == 0, login.output
    assert json.loads(login.output)["auth"]["clawhunt"]["account"] == "set"
    assert key.exit_code == 0, key.output
    key_payload = json.loads(key.output)
    assert key_payload["auth"]["clawhunt"]["agent_api_key"] == "set"
    assert "cph_generated_123" not in key.output
    assert os.environ["CLAWHUNT_AGENT_API_KEY"] == "cph_generated_123"
    assert json.loads(status.output)["clawhunt"]["agent_key_source"] == "account"
    logout = runner.invoke(app, ["clawhunt", "logout", "--json"])
    assert logout.exit_code == 0, logout.output
    assert json.loads(logout.output)["clawhunt"]["account"] == "unset"
    assert json.loads(logout.output)["clawhunt"]["agent_api_key"] == "unset"
    assert not auth_path.exists()
    assert "CLAWHUNT_AGENT_API_KEY" not in os.environ


def test_cli_clawhunt_browse_forwards_public_flag_to_kernel(monkeypatch):
    # `clawhunt browse` mirrors the web dock via the kernel's context-aware
    # browse_marketplace: default passes public=None (auto: agent view when a key is
    # linked, else public), --public forces True, --agent forces False.
    seen: list[object] = []

    class FakeClawHuntClient:
        def browse_marketplace(self, **params):
            seen.append(params.get("public"))
            return {"ok": True, "status_code": 200, "body": []}

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)
    runner = CliRunner()

    assert runner.invoke(app, ["clawhunt", "browse"]).exit_code == 0
    assert runner.invoke(app, ["clawhunt", "browse", "--public"]).exit_code == 0
    assert runner.invoke(app, ["clawhunt", "browse", "--agent"]).exit_code == 0

    assert seen == [None, True, False]


def test_cli_clawhunt_exchange_handoff_code_saves_shared_account(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class FakeClawHuntAccountClient:
        settings = SimpleNamespace(base_url="https://clawhunt.test")

        def exchange_cli_handoff(self, handoff_code):
            assert handoff_code == "handoff-code"
            return {"ok": True, "status_code": 200, "body": {"access_token": "account-token", "user": {"username": "leon"}}}

    monkeypatch.setattr(cli_module, "ClawHuntAccountClient", FakeClawHuntAccountClient)
    runner = CliRunner()

    result = runner.invoke(app, ["clawhunt", "exchange-handoff-code", "--handoff-code", "handoff-code", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["auth"]["clawhunt"]["account"] == "set"
    assert payload["auth"]["clawhunt"]["account_source"] == "clawhunt_cli_handoff"
    assert payload["auth"]["clawhunt"]["login_source"] == "superclaw"
    assert json.loads(auth_path.read_text(encoding="utf-8"))["access_token"] == "account-token"


def test_cli_clawhunt_account_login_failure_does_not_write_shared_auth(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class RejectingClawHuntAccountClient:
        def login(self, username, password):
            return {"ok": False, "status_code": 401, "body": {"detail": "bad credentials"}}

    monkeypatch.setattr(cli_module, "ClawHuntAccountClient", RejectingClawHuntAccountClient)
    runner = CliRunner()

    result = runner.invoke(app, ["clawhunt", "account-login", "--username", "leon", "--password", "wrong", "--json"])

    assert result.exit_code == 1
    assert json.loads(result.output) == {"ok": False, "error": "bad credentials"}
    assert not auth_path.exists()
    assert "CLAWHUNT_AGENT_API_KEY" not in os.environ


def test_cli_clawhunt_login_probe_network_failure_exits_non_json(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))

    class FailingClawHuntAccountClient:
        settings = SimpleNamespace(base_url="https://clawhunt.test")

        def login_probe(self):
            raise httpx.ConnectError("no route")

    monkeypatch.setattr(cli_module, "ClawHuntAccountClient", FailingClawHuntAccountClient)
    runner = CliRunner()

    result = runner.invoke(app, ["clawhunt", "login-probe"])

    assert result.exit_code == 1
    assert "ok=false" in result.output
    assert "reachable=false" in result.output
    assert "ConnectError" in result.output


def test_cli_media_status_reports_key_count_without_values(monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    runner = CliRunner()

    result = runner.invoke(app, ["media", "status", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["configured"] is True
    assert payload["configured_key_count"] == 3
    assert payload["key_rotation"] == "round_robin"
    for value in key_values:
        assert value not in result.output


def test_cli_media_doctor_reports_standard_api_readiness_without_values(monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    runner = CliRunner()

    result = runner.invoke(app, ["media", "doctor", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["ready_for_live_generation"] is True
    assert payload["configured_key_count"] == 3
    assert any(check["name"] == "query_endpoint.standard_api" for check in payload["checks"])
    for value in key_values:
        assert value not in result.output


def test_cli_media_generate_dry_run_writes_sanitized_artifact(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "media",
            "generate",
            "text_to_image",
            "--prompt",
            "studio product photo",
            "--dry-run",
            "--artifact-dir",
            str(tmp_path),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "dry_run"
    artifact_text = Path(payload["artifact_path"]).read_text(encoding="utf-8")
    assert "studio product photo" in artifact_text
    assert "apiKey" not in artifact_text
    for value in key_values:
        assert value not in result.output
        assert value not in artifact_text


def test_cli_media_generate_dry_run_attaches_run_evidence(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    store, session = _create_cli_evidence_run(state_path, tmp_path / "run-artifacts")
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "media",
            "generate",
            "text_to_image",
            "--prompt",
            "studio product photo",
            "--dry-run",
            "--run-id",
            session.run_id,
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    artifact_path = Path(payload["artifact_path"])
    evidence = store.get_evidence(session.run_id)
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    artifact = next(item for item in evidence.artifacts if item.artifact_id == payload["artifact_id"])
    assert payload["evidence_attached"] is True
    assert payload["run_artifact_url"] == f"/api/runs/{session.run_id}/artifacts/{payload['artifact_id']}"
    assert artifact.kind == "runninghub-media-task-json"
    assert artifact.path == str(artifact_path.resolve())
    assert artifact.metadata["provider"] == "runninghub"
    assert artifact.metadata["template_id"] == "text_to_image"
    assert "artifact.added" in event_types
    assert "media.generate.recorded" in event_types
    for value in key_values:
        assert value not in result.output
        assert value not in artifact_path.read_text(encoding="utf-8")


def test_cli_media_render_attaches_generate_status_and_outputs_to_run(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    store, session = _create_cli_evidence_run(state_path, tmp_path / "run-artifacts")

    def fake_render(request):
        artifact_dir = request.generation.artifact_dir
        assert artifact_dir is not None
        artifact_dir.mkdir(parents=True, exist_ok=True)
        steps = []
        for step_name, artifact_id, status, query in [
            ("generate", "runninghub_media_111aaa222bbb", "submitted", None),
            ("status", "runninghub_media_222bbb333ccc", "status_queried", "status"),
            ("outputs", "runninghub_media_333ccc444ddd", "outputs_queried", "outputs"),
        ]:
            artifact_path = artifact_dir / f"{artifact_id}.json"
            artifact_path.write_text(json.dumps({"artifact_id": artifact_id, "step": step_name}) + "\n", encoding="utf-8")
            steps.append(
                {
                    "step": step_name,
                    "attempt": 1,
                    "result": {
                        "ok": True,
                        "provider": "runninghub",
                        "status": status,
                        "template": {"id": "text_to_image"},
                        "query": query,
                        "task_id": "task_render_demo",
                        "endpoint": f"https://www.runninghub.ai/{step_name}",
                        "artifact_id": artifact_id,
                        "artifact_path": str(artifact_path),
                        "artifact_url": f"/api/media/artifacts/{artifact_id}",
                        "output_urls": ["https://cdn.runninghub.ai/render.png"] if query == "outputs" else [],
                    },
                }
            )
        return {
            "ok": True,
            "provider": "runninghub",
            "status": "outputs_ready",
            "template": {"id": "text_to_image"},
            "task_id": "task_render_demo",
            "output_urls": ["https://cdn.runninghub.ai/render.png"],
            "artifact_count": 3,
            "steps": steps,
            "artifacts": [],
        }

    monkeypatch.setattr(cli_module, "render_runninghub_media_task", fake_render)
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "media",
            "render",
            "text_to_image",
            "--prompt",
            "studio product photo",
            "--node-json",
            '[{"nodeId":"6","fieldName":"text","fieldType":"STRING","fieldValue":"studio product photo"}]',
            "--run-id",
            session.run_id,
            "--max-polls",
            "2",
            "--poll-interval",
            "0",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "outputs_ready"
    assert payload["evidence_attached"] is True
    assert payload["artifacts"][-1]["run_artifact_url"] == f"/api/runs/{session.run_id}/artifacts/runninghub_media_333ccc444ddd"
    evidence = store.get_evidence(session.run_id)
    kinds = [item.kind for item in evidence.artifacts if item.artifact_id.startswith("runninghub_media_")]
    assert kinds == [
        "runninghub-media-task-json",
        "runninghub-media-status-json",
        "runninghub-media-outputs-json",
    ]
    event_types = [event["type"] for event in store.list_events(session.run_id)]
    assert "media.generate.recorded" in event_types
    assert "media.task_status.recorded" in event_types
    assert "media.outputs.recorded" in event_types


def test_cli_media_run_attachment_rejects_artifact_dir_outside_run_root(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    _, session = _create_cli_evidence_run(state_path, tmp_path / "run-artifacts")
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "media",
            "generate",
            "text_to_image",
            "--prompt",
            "studio product photo",
            "--dry-run",
            "--run-id",
            session.run_id,
            "--artifact-dir",
            str(tmp_path / "outside-run-root"),
        ],
    )

    assert result.exit_code == 1
    assert "media artifact_dir must be inside run artifact root" in result.output
    assert not (tmp_path / "outside-run-root").exists()


def test_cli_media_upload_dry_run_writes_sanitized_artifact(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    upload_file = tmp_path / "input.png"
    upload_file.write_bytes(b"fake-png")
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "media",
            "upload",
            str(upload_file),
            "--dry-run",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "upload_dry_run"
    assert payload["file_name"] == "input.png"
    artifact_text = Path(payload["artifact_path"]).read_text(encoding="utf-8")
    assert "input.png" in artifact_text
    for value in key_values:
        assert value not in result.output
        assert value not in artifact_text


def test_cli_service_runs_uvicorn_with_runtime_state_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "runtime-state.db"))
    monkeypatch.setenv("SUPERCLAW_NODE_SERVER", "off")  # isolate from Node co-launch
    seen = {}

    def fake_build_service_app(state_path):
        seen["state_path"] = str(state_path)
        return "service-app"

    def fake_uvicorn_run(target, *, host, port, log_level):
        seen["target"] = target
        seen["host"] = host
        seen["port"] = port
        seen["log_level"] = log_level

    monkeypatch.setattr(cli_module, "_build_service_app", fake_build_service_app)
    monkeypatch.setattr(cli_module, "_uvicorn_module", lambda: SimpleNamespace(run=fake_uvicorn_run))
    runner = CliRunner()

    result = runner.invoke(app, ["service", "--host", "0.0.0.0", "--port", "9898", "--log-level", "warning"])

    assert result.exit_code == 0, result.output
    assert seen == {
        "state_path": str(tmp_path / "runtime-state.db"),
        "target": "service-app",
        "host": "0.0.0.0",
        "port": 9898,
        "log_level": "warning",
    }


def test_cli_service_colaunches_and_tears_down_node(tmp_path, monkeypatch):
    """The `service` command co-launches the Node server and tears it down when
    uvicorn returns (clean-exit path), passing the resolved state path + host."""
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "runtime-state.db"))
    seen = {}

    class _FakeNodeSupervisor:
        def stop(self, *, wait_timeout_seconds=2.0):
            seen["node_stopped"] = True

    def _fake_start(state_path, *, host="127.0.0.1"):
        seen["node_state_path"] = str(state_path)
        seen["node_host"] = host
        return _FakeNodeSupervisor()

    class _FakeGatewaySupervisor:
        def stop(self, *, wait_timeout_seconds=2.0):
            seen["gateway_stopped"] = True

    def _fake_gateway_start(state_path, *, host="127.0.0.1"):
        seen["gateway_state_path"] = str(state_path)
        return _FakeGatewaySupervisor()

    monkeypatch.setattr("superclaw.node_runtime.start_node_sidecar_if_enabled", _fake_start)
    # The gateway co-launch must be faked too, or the real one would spawn a Node
    # process during the unit test.
    monkeypatch.setattr("superclaw.gateway_runtime.start_gateway_sidecar_if_enabled", _fake_gateway_start)
    # Do NOT install real SIGINT/SIGTERM handlers into the pytest process; the
    # finally path is what this test exercises (uvicorn.run mocked to return).
    # Variadic to match the multi-supervisor signature.
    monkeypatch.setattr("superclaw.node_runtime.install_signal_teardown", lambda *sup: None)
    monkeypatch.setattr(cli_module, "_build_service_app", lambda state_path: "app")
    monkeypatch.setattr(cli_module, "_uvicorn_module", lambda: SimpleNamespace(run=lambda *a, **k: None))

    result = CliRunner().invoke(app, ["service", "--host", "127.0.0.1", "--port", "9899"])

    assert result.exit_code == 0, result.output
    assert seen["node_state_path"] == str(tmp_path / "runtime-state.db")
    assert seen["node_host"] == "127.0.0.1"
    assert seen["node_stopped"] is True  # torn down in the finally block
    assert seen["gateway_state_path"] == str(tmp_path / "runtime-state.db")
    assert seen["gateway_stopped"] is True  # gateway also torn down in the finally


def test_cli_service_reports_missing_uvicorn_dependency(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "runtime-state.db"))
    monkeypatch.setenv("SUPERCLAW_NODE_SERVER", "off")  # isolate from Node co-launch
    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "uvicorn":
            raise ModuleNotFoundError("No module named 'uvicorn'")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    runner = CliRunner()

    result = runner.invoke(app, ["service"])

    assert result.exit_code == 1
    assert "uvicorn is required for `superclaw service`" in result.output


def test_cli_desktop_start_emits_json_handle_and_status(tmp_path, monkeypatch):
    seen = {}

    class DummySupervisor:
        def __init__(self, **kwargs):
            seen["init"] = kwargs

        def start_or_connect(self, control_token=None):
            seen["control_token"] = control_token
            return cli_module.DesktopServiceHandle(
                base_url="http://127.0.0.1:9999",
                control_token="desktop-token",
                state_path=tmp_path / "runtime-state.db",
                owned=True,
                pid=9123,
            )

        def probe(self, control_token):
            seen["probe_token"] = control_token
            return {"health": {"ok": True}, "runtime": {"service": {"name": "superclaw"}}}

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setattr(cli_module, "DesktopRuntimeSupervisor", DummySupervisor)
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "desktop",
            "start",
            "--host",
            "127.0.0.1",
            "--port",
            "9999",
            "--state-path",
            str(tmp_path / "runtime-state.db"),
            "--python-executable",
            "/tmp/python3",
            "--control-token",
            "provided-token",
            "--connect-timeout",
            "0.25",
            "--boot-timeout",
            "5",
            "--log-level",
            "warning",
        ],
    )

    payload = json.loads(result.output)
    assert result.exit_code == 0, result.output
    assert payload["ok"] is True
    assert payload["handle"]["base_url"] == "http://127.0.0.1:9999"
    assert payload["handle"]["control_token"] == "desktop-token"
    assert payload["handle"]["owned"] is True
    assert payload["status"]["health"]["ok"] is True
    assert seen["init"] == {
        "state_path": tmp_path / "runtime-state.db",
        "host": "127.0.0.1",
        "port": 9999,
        "python_executable": "/tmp/python3",
        "connect_timeout_seconds": 0.25,
        "boot_timeout_seconds": 5.0,
        "log_level": "warning",
        "watch_ui_pid": None,
    }
    assert seen["control_token"] == "provided-token"
    assert seen["probe_token"] == "desktop-token"


def test_cli_desktop_start_reports_supervisor_failure(tmp_path, monkeypatch):
    class FailingSupervisor:
        def __init__(self, **kwargs):
            pass

        def start_or_connect(self, control_token=None):
            raise RuntimeError("boom")

    monkeypatch.setattr(cli_module, "DesktopRuntimeSupervisor", FailingSupervisor)
    runner = CliRunner()

    result = runner.invoke(app, ["desktop", "start", "--state-path", str(tmp_path / "runtime-state.db")])

    assert result.exit_code == 1
    assert json.loads(result.output) == {"ok": False, "error": "boom"}


def test_cli_desktop_probe_returns_json_status(monkeypatch):
    monkeypatch.setattr(
        cli_module,
        "probe_service_status",
        lambda **kwargs: {"health": {"ok": True}, "runtime": {"service": {"name": "superclaw"}}},
    )
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["desktop", "probe", "--base-url", "http://127.0.0.1:8788", "--control-token", "secret", "--timeout", "0.2"],
    )

    assert result.exit_code == 0
    assert json.loads(result.output)["ok"] is True


def test_cli_desktop_stop_respects_owned_flag(monkeypatch):
    called = {"value": False}

    def _unexpected(*args, **kwargs):
        called["value"] = True
        return True

    monkeypatch.setattr(cli_module, "shutdown_process_pid", _unexpected)
    runner = CliRunner()

    result = runner.invoke(app, ["desktop", "stop", "--pid", "9123", "--no-owned"])

    assert result.exit_code == 0
    assert json.loads(result.output) == {"ok": True, "stopped": False, "reason": "not_owned", "pid": 9123}
    assert called["value"] is False


def test_cli_desktop_stop_reports_shutdown_result(monkeypatch):
    seen: dict[str, object] = {}

    def _fake_shutdown(pid, *, wait_timeout_seconds=2.0, process_group=False):
        seen["process_group"] = process_group
        return pid == 8123

    monkeypatch.setattr(cli_module, "shutdown_process_pid", _fake_shutdown)
    monkeypatch.setattr(
        "superclaw.node_runtime.stop_node_sidecar",
        lambda *a, **k: pytest.fail("--pid is Python-only; it must not reap Node (wrong run-dir risk)"),
    )
    runner = CliRunner()

    result = runner.invoke(app, ["desktop", "stop", "--pid", "8123", "--wait-timeout", "0.5"])

    assert result.exit_code == 0
    # --pid is a direct, Python-only kill (no Node "node" key); Node is reaped via
    # the watchdog / marker-driven stop / clean-exit finally instead.
    assert json.loads(result.output) == {"ok": True, "stopped": True, "pid": 8123}
    # --tree defaults on, so a --pid teardown also cleans the child process group.
    assert seen["process_group"] is True


def test_cli_desktop_stop_no_tree_disables_process_group(monkeypatch):
    seen: dict[str, object] = {}

    def _fake_shutdown(pid, *, wait_timeout_seconds=2.0, process_group=False):
        seen["process_group"] = process_group
        return True

    monkeypatch.setattr(cli_module, "shutdown_process_pid", _fake_shutdown)
    runner = CliRunner()

    result = runner.invoke(app, ["desktop", "stop", "--pid", "8123", "--no-tree"])

    assert result.exit_code == 0
    assert seen["process_group"] is False


def test_cli_desktop_stop_without_pid_uses_marker(monkeypatch):
    captured: dict[str, object] = {}

    class _FakeSupervisor:
        def __init__(self, *, state_path, host="127.0.0.1"):
            captured["state_path"] = state_path
            captured["host"] = host
            self.run_dir = Path(state_path).parent / "run"

        def stop_service(self, *, wait_timeout_seconds=2.0, process_group=True, expect_pid=None):
            captured["wait_timeout_seconds"] = wait_timeout_seconds
            captured["process_group"] = process_group
            captured["expect_pid"] = expect_pid
            return {"ok": True, "stopped": True, "reason": None, "pid": 4321}

    def _fake_stop_node(run_dir, *, host, wait_timeout_seconds):
        captured["node_run_dir"] = str(run_dir)
        captured["node_host"] = host
        return {"ok": True, "stopped": False, "reason": "no_marker", "pid": None}

    monkeypatch.setattr(cli_module, "DesktopRuntimeSupervisor", _FakeSupervisor)
    monkeypatch.setattr("superclaw.node_runtime.stop_node_sidecar", _fake_stop_node)
    runner = CliRunner()

    result = runner.invoke(
        app, ["desktop", "stop", "--wait-timeout", "1.0", "--host", "0.0.0.0", "--expect-pid", "4321"]
    )

    assert result.exit_code == 0
    # Python teardown result unchanged; Node teardown is an additive "node" key.
    assert json.loads(result.output) == {
        "ok": True,
        "stopped": True,
        "reason": None,
        "pid": 4321,
        "node": {"ok": True, "stopped": False, "reason": "no_marker", "pid": None},
    }
    assert captured["wait_timeout_seconds"] == 1.0
    assert captured["process_group"] is True  # --tree default flows into marker stop
    assert captured["host"] == "0.0.0.0"  # --host flows to the supervisor (shim parity)
    assert captured["expect_pid"] == 4321  # session-ownership scope flows through
    assert captured["node_host"] == "0.0.0.0"  # Node teardown shares the same host


def test_cli_desktop_stop_without_pid_no_tree_flows_to_supervisor(monkeypatch):
    captured: dict[str, object] = {}

    class _FakeSupervisor:
        def __init__(self, *, state_path, host="127.0.0.1"):
            self.run_dir = Path(state_path).parent / "run"

        def stop_service(self, *, wait_timeout_seconds=2.0, process_group=True, expect_pid=None):
            captured["process_group"] = process_group
            return {"ok": True, "stopped": False, "reason": "not_running", "pid": None}

    monkeypatch.setattr(cli_module, "DesktopRuntimeSupervisor", _FakeSupervisor)
    monkeypatch.setattr(
        "superclaw.node_runtime.stop_node_sidecar",
        lambda run_dir, *, host, wait_timeout_seconds: {"ok": True, "stopped": False, "reason": "no_marker", "pid": None},
    )

    result = CliRunner().invoke(app, ["desktop", "stop", "--no-tree"])

    assert result.exit_code == 0
    assert captured["process_group"] is False  # --no-tree must NOT be silently dropped


def test_cli_desktop_stop_superseded_does_not_touch_node(monkeypatch):
    """Ownership boundary: when stop_service returns `superseded` (the running
    Python sidecar belongs to another session and is left alone), its co-launched
    Node must NOT be reaped either."""

    class _FakeSupervisor:
        def __init__(self, *, state_path, host="127.0.0.1"):
            self.run_dir = Path(state_path).parent / "run"

        def stop_service(self, *, wait_timeout_seconds=2.0, process_group=True, expect_pid=None):
            return {"ok": True, "stopped": False, "reason": "superseded", "pid": 9999}

    monkeypatch.setattr(cli_module, "DesktopRuntimeSupervisor", _FakeSupervisor)
    monkeypatch.setattr(
        "superclaw.node_runtime.stop_node_sidecar",
        lambda *a, **k: pytest.fail("must not reap another session's Node when Python is superseded"),
    )

    result = CliRunner().invoke(app, ["desktop", "stop", "--expect-pid", "4321"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["reason"] == "superseded" and payload["pid"] == 9999
    assert payload["node"] == {"ok": True, "stopped": False, "reason": "skipped_python_retained", "pid": None}


def test_cli_run_dry_outputs_chain_verdict(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    result = runner.invoke(app, ["run", "--title", "Ship", "--description", "Build", "--dry"])

    assert result.exit_code == 0
    assert "CHAIN_PARTIAL" in result.output


def test_cli_run_supports_constrained_dag_topology(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "run",
            "--title",
            "Ship",
            "--description",
            "Build",
            "--dry",
            "--task-topology",
            "implement_fanout",
        ],
    )

    run_id = next(line.split("=", 1)[1] for line in result.output.splitlines() if line.startswith("run_id="))
    session = StateStore(tmp_path / "state.db").get_run(run_id)

    assert result.exit_code == 0
    assert session.execution_context["task_topology"] == "implement_fanout"
    assert len(session.task_graph.tasks) == 6


def test_cli_run_executes_explore_fanout_topology_with_child_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "run",
            "--title",
            "Explore topology",
            "--description",
            "Execute explore fanout",
            "--backend",
            "local",
            "--repo",
            str(tmp_path),
            "--budget-seconds",
            "20",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
            "--task-topology",
            "explore_fanout",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    store = StateStore(tmp_path / "state.db")
    session = store.get_run(payload["run_id"])
    evidence = store.get_evidence(payload["run_id"])
    event_types = [event["type"] for event in store.list_events(payload["run_id"])]
    fanout_report = evidence.backend_summary["subagent_fanouts"][0]

    assert payload["status"] == "completed"
    assert session.execution_context["task_topology"] == "explore_fanout"
    assert len(session.child_executions) == 2
    assert len(evidence.child_executions) == 2
    assert "child_run.spawned" in event_types
    assert "child_evidence.added" in event_types
    assert "child_fanout.completed" in event_types
    assert fanout_report["policy"] == "all_succeed"
    assert fanout_report["total"] == 2
    assert all(child["chain_verdict"] for child in fanout_report["children"])
    assert all(child.evidence_artifact_id for child in evidence.child_executions)


def test_cli_export_protocol_emits_delivery_protocol_payload(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run = runner.invoke(app, ["run", "--title", "Protocol Export", "--description", "Generate manifest", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run.output.splitlines() if line.startswith("run_id="))

    exported = runner.invoke(
        app,
        [
            "export-protocol",
            run_id,
            "--github-pr-url",
            "https://github.com/example/repo/pull/8",
            "--github-pr-number",
            "8",
        ],
    )

    payload = json.loads(exported.output)
    assert exported.exit_code == 0, exported.output
    assert payload["adapter_name"] == "clawhunt.delivery_protocol.v1"
    assert payload["request_json"]["agent_package_manifest"]["name"] == "Protocol Export"
    assert payload["request_json"]["github_pr_number"] == 8


def test_cli_export_protocol_includes_sanitized_child_execution_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run = runner.invoke(app, ["run", "--title", "Child Protocol Export", "--description", "Export children", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run.output.splitlines() if line.startswith("run_id="))
    store = StateStore(tmp_path / "state.db")
    bundle = store.get_evidence(run_id)
    bundle.add_child_execution(
        ChildExecution(
            child_task_id="childtask_cli",
            child_run_id="run_child_cli",
            parent_run_id=run_id,
            parent_task_id="task_parent",
            backend="local",
            status="completed",
            chain_verdict="CHAIN_PARTIAL",
            evidence_artifact_id="child_evidence_cli",
            evidence_path="/private/tmp/superclaw/cli-child/evidence.json",
        )
    )
    store.save_evidence(bundle)

    exported = runner.invoke(app, ["export-protocol", run_id])

    payload = json.loads(exported.output)
    manifest = payload["request_json"]["agent_package_manifest"]
    child_execution = manifest["child_evidence"]["executions"][0]
    manifest_text = str(manifest)
    assert exported.exit_code == 0, exported.output
    assert child_execution["child_run_id"] == "run_child_cli"
    assert child_execution["evidence_artifact_id"] == "child_evidence_cli"
    assert "/private/tmp/superclaw" not in manifest_text
    assert "evidence_path" not in manifest_text


def test_cli_verify_applies_adversarial_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Ship", "--description", "Build", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    result = runner.invoke(app, ["verify", run_id])

    assert result.exit_code == 0
    assert "command_backed_verification=PASS" in result.output
    assert "non_happy_path_probe=PASS" in result.output
    assert "chain_verdict=CHAIN_PARTIAL" in result.output


def test_cli_verify_json_returns_rule_specs(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Verifier Specs", "--description", "Build", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    result = runner.invoke(app, ["verify", run_id, "--json"])

    payload = json.loads(result.output)
    finding_names = {finding["name"] for finding in payload["findings"]}
    assert result.exit_code == 0, result.output
    assert set(payload["rule_specs"]) == finding_names
    plugin_spec = payload["rule_specs"]["plugin_policy_boundary"]
    assert plugin_spec["input_fields"]
    assert plugin_spec["fail_mode"] == "fail_closed"
    assert plugin_spec["severity"] == "critical"
    assert plugin_spec["remediation"]


def test_cli_verify_json_persists_plugin_policy_boundary_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Verifier Failure", "--description", "Build", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))
    store = StateStore(tmp_path / "state.db")
    bundle = store.get_evidence(run_id)
    bundle.add_command(
        "agent backend",
        0,
        "codex --plugin-dir .superclaw/plugins/cache/dev.superclaw.secret/0.1.0",
    )
    store.save_evidence(bundle)

    result = runner.invoke(app, ["verify", run_id, "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    finding = next(item for item in payload["findings"] if item["name"] == "plugin_policy_boundary")
    persisted = next(item for item in store.get_evidence(run_id).findings if item.name == "plugin_policy_boundary")
    assert finding["passed"] is False
    assert finding["fail_mode"] == "fail_closed"
    assert finding["severity"] == "critical"
    assert "protected plugin policy material" in finding["detail"]
    assert persisted.passed is False
    assert persisted.detail == finding["detail"]


def test_cli_local_run_events_and_evidence_share_state(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    run_result = runner.invoke(
        app,
        [
            "run",
            "--title",
            "Local run",
            "--description",
            "Execute",
            "--backend",
            "local",
            "--repo",
            str(tmp_path),
            "--budget-seconds",
            "20",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
    )
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    evidence_result = runner.invoke(app, ["evidence", run_id])
    events_result = runner.invoke(app, ["events", run_id])

    assert run_result.exit_code == 0
    assert "status=completed" in run_result.output
    assert "evidence_path=" in run_result.output
    assert evidence_result.exit_code == 0
    assert '"worker_results"' in evidence_result.output
    assert events_result.exit_code == 0
    assert "command.completed" in events_result.output
    assert "transcript.added" in events_result.output


def test_cli_cancel_marks_run_and_records_event(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Cancel", "--description", "Stop", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    cancel_result = runner.invoke(app, ["cancel", run_id])
    events_result = runner.invoke(app, ["events", run_id])

    assert cancel_result.exit_code == 0
    assert "status=completed" in cancel_result.output
    assert "accepted=false" in cancel_result.output
    assert events_result.exit_code == 0
    assert "run.cancel.ignored" in events_result.output


def test_cli_chat_watch_and_runtime_policy_share_session_state(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    _trust_cwd_workspace(tmp_path / "state.db", repo=tmp_path)
    monkeypatch.setattr(
        cli_module,
        "runtime_manifest",
        lambda: {
            "superclaw": {"sourcemap_alignment": {"control_contract": ["mcp_status"]}},
            "codex": {"available": True},
            "claude": {"available": True},
            "environment": {"CLAWHUNT_AGENT_API_KEY": "unset"},
        },
    )
    monkeypatch.setattr(
        cli_module,
        "runtime_cli_comparison",
        lambda: {
            "observed_clis": {"superclaw": {"available": True}, "codex": {"available": True}},
            "superclaw_gaps": [{"id": "stale_run_reconciliation", "priority": "medium"}],
            "next_iteration": ["add stale-run reconciliation"],
        },
    )
    monkeypatch.setattr(
        cli_module,
        "runtime_mcp_status",
        lambda config_paths=None, *, run_cli_probe=True: {"summary": {"server_count": 1, "ready_count": 1}},
    )
    runner = CliRunner()

    policy = runner.invoke(app, ["runtime", "policy", "--permission-mode", "plan", "--allowed-tool", "Read"])
    runtime = runner.invoke(app, ["runtime", "inspect"])
    compare = runner.invoke(app, ["runtime", "compare"])
    mcp = runner.invoke(app, ["runtime", "mcp-status", "--no-cli-probe"])
    chat = runner.invoke(
        app,
        [
            "chat",
            "--message",
            "Ship this turn",
            "--backend",
            "local",
            "--repo",
            str(tmp_path),
            "--artifact-dir",
            str(tmp_path / "artifacts"),
            "--budget-seconds",
            "20",
            "--json",
        ],
    )
    summary = json.loads(chat.output)
    watch = runner.invoke(app, ["watch", summary["run_id"], "--json", "--interval", "0"])
    context = runner.invoke(app, ["runtime", "context"])
    session = StateStore(tmp_path / "state.db").get_chat_session(summary["session_id"])

    assert policy.exit_code == 0
    assert '"mode": "plan"' in policy.output
    assert runtime.exit_code == 0
    assert '"CLAWHUNT_AGENT_API_KEY": "unset"' in runtime.output
    assert "sourcemap_alignment" in runtime.output
    assert compare.exit_code == 0
    assert "stale_run_reconciliation" in compare.output
    assert mcp.exit_code == 0
    assert '"ready_count": 1' in mcp.output
    assert chat.exit_code == 0, chat.output
    assert summary["status"] == "completed"
    assert session.messages[0].role == "user"
    assert session.messages[-1].run_id == summary["run_id"]
    assert watch.exit_code == 0
    assert "transcript.added" in watch.output
    assert context.exit_code == 0
    assert '"worker_transcripts": 5' in context.output


def test_cli_chat_pure_no_repo_lands_in_managed_chat_scratch(tmp_path, monkeypatch):
    # A pure chat — no --repo, no --workspace — resolves to the managed Chat
    # workspace and EXECUTES in its scratch home, never the caller's cwd. (PR-B:
    # CLI/Web parity for pure chat; mirrors the API repo_path=None behaviour. The
    # cwd is deliberately NOT trusted here, so a regression to cwd-resolution would
    # fail closed with a non-zero exit instead of completing.)
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    chat_root = tmp_path / "chat-scratch"
    chat_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(chat_root))
    runner = CliRunner()

    chat = runner.invoke(
        app,
        [
            "chat",
            "--message",
            "hello with no repo",
            "--backend",
            "local",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
            "--budget-seconds",
            "20",
            "--json",
        ],
    )

    assert chat.exit_code == 0, chat.output
    summary = json.loads(chat.output)
    assert summary["status"] == "completed"
    store = StateStore(tmp_path / "state.db")
    session = store.get_chat_session(summary["session_id"])
    workspace = store.get_workspace_profile(session.workspace_id)
    # resolved to the built-in managed Chat workspace (a private scratch), not a
    # trust-required error on the cwd
    assert workspace.metadata.get("builtin") == "chat"
    # its execution root is the scratch home, proving the turn ran there
    assert Path(workspace.repo_path).resolve() == chat_root.resolve()


def test_cli_chat_continue_project_session_executes_in_its_project(tmp_path, monkeypatch):
    # Continuing an existing PROJECT chat (--session-id) with no --repo must execute
    # in that session's OWN project, never the default Chat scratch. (PR-B:
    # execution follows the session's binding, mirroring the Web rule + the API.)
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(tmp_path / "chat-scratch"))
    project = tmp_path / "proj"
    project.mkdir()
    (project / "package.json").write_text("{}")  # project marker (trust gate)
    from superclaw import workspace_resolver as wr

    store = StateStore(tmp_path / "state.db")
    workspace = wr.create_trusted_workspace(store, project, trust_source="test")
    session = store.create_chat_session("Proj chat", workspace_id=workspace.workspace_id)

    captured: dict[str, object] = {}

    class _Stop(Exception):
        pass

    def fake_run_goal(self, **kwargs):
        captured["repo_path"] = kwargs.get("repo_path")
        raise _Stop()

    monkeypatch.setattr(cli_module.SuperClawOrchestrator, "run_goal", fake_run_goal)

    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "chat",
            "--message",
            "continue here",
            "--session-id",
            session.session_id,
            "--backend",
            "local",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
    )

    assert isinstance(result.exception, _Stop), result.output
    # no --repo, but the session lives in `project` → execute there, NOT the scratch
    assert Path(str(captured["repo_path"])).resolve() == project.resolve()


def test_cli_chat_continue_legacy_session_falls_back_to_chat_scratch(tmp_path, monkeypatch):
    # A legacy session (workspace_id None, never adopted) continued with no --repo
    # must NOT crash on get_workspace_profile(None); it falls back to the managed
    # Chat scratch (the resolved default).
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    chat_root = tmp_path / "chat-scratch"
    monkeypatch.setenv("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(chat_root))
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Legacy", workspace_id=None)

    captured: dict[str, object] = {}

    class _Stop(Exception):
        pass

    def fake_run_goal(self, **kwargs):
        captured["repo_path"] = kwargs.get("repo_path")
        raise _Stop()

    monkeypatch.setattr(cli_module.SuperClawOrchestrator, "run_goal", fake_run_goal)

    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "chat",
            "--message",
            "hi",
            "--session-id",
            session.session_id,
            "--backend",
            "local",
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
    )

    assert isinstance(result.exception, _Stop), result.output  # no KeyError crash
    assert Path(str(captured["repo_path"])).resolve() == chat_root.resolve()


def test_cli_shell_runs_multiple_turns_in_one_session(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    _trust_cwd_workspace(tmp_path / "state.db", repo=tmp_path)
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "shell",
            "--dry",
            "--backend",
            "local",
            "--repo",
            str(tmp_path),
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
        input="/mode delivery\nFirst turn\n/session\nSecond turn\n/last\n/exit\n",
    )
    sessions = StateStore(tmp_path / "state.db").list_chat_sessions()
    session = sessions[0]
    user_messages = [message.content for message in session.messages if message.role == "user"]
    assistant_messages = [message for message in session.messages if message.role == "assistant"]

    assert result.exit_code == 0, result.output
    assert "SuperClaw Runtime Shell" in result.output
    assert result.output.count("run_id=") >= 2
    assert "last_run_id=run_" in result.output
    assert "working backend=" not in result.output
    assert len(sessions) == 1
    assert user_messages == ["First turn", "Second turn"]
    assert len(assistant_messages) == 2
    assert all(message.run_id for message in assistant_messages)


def test_cli_shell_failed_turn_stays_interactive(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    calls = []

    def fake_execute_chat_turn(**kwargs):
        calls.append(kwargs["content"])
        return {
            "session_id": "chat_failed",
            "run_id": "run_failed",
            "status": "failed",
            "chain_verdict": "FAIL",
            "failure_reason": "backend_readiness_classification: AUTH_REQUIRED via marker 'not logged in'",
        }

    monkeypatch.setattr(cli_module, "_execute_chat_turn", fake_execute_chat_turn)
    runner = CliRunner()

    result = runner.invoke(app, ["shell", "--backend", "local", "--repo", str(tmp_path)], input="/deliver 你好\n/last\n/exit\n")

    assert result.exit_code == 0, result.output
    assert f"turn_status=working intent=delivery mode=auto backend=local repo={tmp_path} shell_status=working" in result.output
    assert "run_id=run_failed status=failed chain_verdict=FAIL" in result.output
    assert "intent=delivery" in result.output
    assert "failure_reason=backend_readiness_classification: AUTH_REQUIRED via marker 'not logged in'" in result.output
    assert "turn_status=failed shell_status=ready" in result.output
    assert "last_run_id=run_failed" in result.output
    assert "Traceback" not in result.output
    assert calls == ["你好"]


def test_cli_shell_turn_exception_stays_interactive(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))

    def fake_execute_chat_turn(**kwargs):
        raise RuntimeError("backend exploded with cph_test_secret")

    monkeypatch.setattr(cli_module, "_execute_chat_turn", fake_execute_chat_turn)
    runner = CliRunner()

    result = runner.invoke(app, ["shell", "--backend", "local", "--repo", str(tmp_path)], input="/deliver Fail once\n/session\n/exit\n")

    assert result.exit_code == 0, result.output
    assert "turn_error=RuntimeError: backend exploded with [REDACTED]" in result.output
    assert "shell_status=ready" in result.output
    assert "session_id=(not started)" in result.output
    assert "cph_test_secret" not in result.output
    assert "Traceback" not in result.output


def test_direct_chat_uses_desktop_toolchain_env(tmp_path, monkeypatch):
    seen = {}

    monkeypatch.setattr(cli_module, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    monkeypatch.setattr(cli_module, "codex_cli_mode", lambda executable: "exec")
    monkeypatch.setattr(cli_module, "desktop_toolchain_env", lambda: {"PATH": "/node/bin:/usr/bin"})

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["env"] = kwargs["env"]
        return SimpleNamespace(returncode=0, stdout="direct response", stderr="")

    monkeypatch.setattr(cli_module.subprocess, "run", fake_run)

    result = cli_module._execute_direct_chat_turn(
        content="hello",
        backend="codex",
        repo=tmp_path,
        budget_seconds=5,
    )

    assert result["status"] == "completed"
    assert result["response"] == "direct response"
    assert seen["command"][0] == "/tmp/codex"
    assert seen["env"]["PATH"] == "/node/bin:/usr/bin"


def test_shell_auto_intent_routes_greeting_to_direct_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    chat_calls = []

    def fake_direct_chat_turn(**kwargs):
        chat_calls.append(kwargs["content"])
        return {"intent": "chat", "backend": kwargs["backend"], "status": "completed", "response": "你好，我是 SuperClaw。"}

    def fail_delivery_turn(**kwargs):
        raise AssertionError("delivery should not run for a greeting")

    monkeypatch.setattr(cli_module, "_execute_direct_chat_turn", fake_direct_chat_turn)
    monkeypatch.setattr(cli_module, "_execute_chat_turn", fail_delivery_turn)

    result = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="你好\n/exit\n")

    assert result.exit_code == 0, result.output
    assert f"turn_status=working intent=chat mode=auto backend=codex repo={tmp_path} shell_status=working" in result.output
    assert "intent=chat backend=codex status=completed" in result.output
    assert "你好，我是 SuperClaw。" in result.output
    assert "turn_status=completed shell_status=ready" in result.output
    assert "intent=delivery" not in result.output
    assert "run_id=run_" not in result.output
    assert chat_calls == ["你好"]


def test_shell_auto_intent_routes_delivery_request_to_delivery(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    delivery_calls = []

    def fake_execute_chat_turn(**kwargs):
        delivery_calls.append(kwargs["content"])
        return {"session_id": "chat_test", "run_id": "run_test", "status": "completed", "chain_verdict": "PASS"}

    def fail_direct_chat_turn(**kwargs):
        raise AssertionError("direct chat should not run for a delivery request")

    monkeypatch.setattr(cli_module, "_execute_chat_turn", fake_execute_chat_turn)
    monkeypatch.setattr(cli_module, "_execute_direct_chat_turn", fail_direct_chat_turn)

    result = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="@delivery 修复测试失败\n/exit\n")

    assert result.exit_code == 0, result.output
    assert f"turn_status=working intent=delivery mode=auto backend=codex repo={tmp_path} shell_status=working" in result.output
    assert "intent=delivery" in result.output
    assert "run_id=run_test status=completed chain_verdict=PASS" in result.output
    assert "turn_status=completed shell_status=ready" in result.output
    assert delivery_calls == ["@delivery 修复测试失败"]


def test_shell_ask_command_forces_direct_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    chat_calls = []

    def fake_direct_chat_turn(**kwargs):
        chat_calls.append(kwargs["content"])
        return {"intent": "chat", "backend": kwargs["backend"], "status": "completed", "response": "direct answer"}

    monkeypatch.setattr(cli_module, "_execute_direct_chat_turn", fake_direct_chat_turn)

    result = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="/ask 修复是什么意思？\n/exit\n")

    assert result.exit_code == 0, result.output
    assert f"turn_status=working intent=chat mode=auto backend=codex repo={tmp_path} shell_status=working" in result.output
    assert "intent=chat backend=codex status=completed" in result.output
    assert "direct answer" in result.output
    assert "turn_status=completed shell_status=ready" in result.output
    assert chat_calls == ["修复是什么意思？"]


def test_shell_delivery_waiting_for_human_gate_reports_distinct_turn_status(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))

    def fake_execute_chat_turn(**kwargs):
        return {
            "session_id": "chat_gate",
            "run_id": "run_gate",
            "status": "WAITING_FOR_HUMAN_GATE",
            "chain_verdict": "WAITING_FOR_HUMAN_GATE",
        }

    monkeypatch.setattr(cli_module, "_execute_chat_turn", fake_execute_chat_turn)

    result = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="@delivery 修复测试失败\n/exit\n")

    assert result.exit_code == 0, result.output
    assert "run_id=run_gate status=WAITING_FOR_HUMAN_GATE chain_verdict=WAITING_FOR_HUMAN_GATE" in result.output
    assert "turn_status=waiting_for_human_gate shell_status=ready" in result.output


def test_shell_mode_persists_and_forces_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))

    def fake_direct_chat_turn(**kwargs):
        return {"intent": "chat", "backend": kwargs["backend"], "status": "completed", "response": "chat mode answer"}

    def fail_delivery_turn(**kwargs):
        raise AssertionError("delivery should not run in chat mode")

    monkeypatch.setattr(cli_module, "_execute_direct_chat_turn", fake_direct_chat_turn)
    monkeypatch.setattr(cli_module, "_execute_chat_turn", fail_delivery_turn)

    first = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="/mode chat\n/exit\n")
    second = CliRunner().invoke(app, ["shell", "--backend", "codex", "--repo", str(tmp_path)], input="修复测试失败\n/exit\n")

    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output
    assert "mode=chat" in first.output
    assert "mode_default=chat" in first.output
    assert "intent=chat backend=codex status=completed" in second.output
    assert json.loads(shell_config.read_text(encoding="utf-8"))["mode"] == "chat"


def test_run_summary_includes_redacted_failure_reason(tmp_path):
    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    session = RunSession(goal_id="goal_1", run_id="run_failed", status="failed")
    evidence = EvidenceBundle(run_id="run_failed")
    evidence.add_finding("worker_execution", False, "claude failed explore with cph_test_secret", "high")
    evidence.add_finding("backend_readiness_classification", False, "AUTH_REQUIRED via marker 'not logged in'", "critical")

    summary = cli_module._run_summary(FakeRunResult(session=session, evidence=evidence), tmp_path / "artifacts")

    assert summary["failure_reason"] == "backend_readiness_classification: AUTH_REQUIRED via marker 'not logged in'"
    assert "cph_test_secret" not in summary["failure_reason"]


def test_run_summary_prefers_timeout_failure_reason(tmp_path):
    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    session = RunSession(goal_id="goal_1", run_id="run_timeout", status="failed")
    evidence = EvidenceBundle(run_id="run_timeout")
    evidence.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="explore",
            backend="codex",
            command="codex exec",
            exit_code=124,
            output="Command timed out after 60s",
            duration_seconds=60.064,
            timed_out=True,
        )
    )
    evidence.add_finding("worker_execution", False, "codex failed explore with exit code 124", "high")

    summary = cli_module._run_summary(FakeRunResult(session=session, evidence=evidence), tmp_path / "artifacts")

    assert summary["failure_reason"] == "timeout: codex explore exceeded 60s"


def test_cli_shell_exposes_config_login_and_status_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    _guard_process_env(monkeypatch, "CLAWHUNT_BASE_URL", "CLAWHUNT_AGENT_API_KEY")
    captured = {}

    class FakeClawHuntClient:
        def __init__(self):
            captured["api_key_status"] = "set" if cli_module.os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset"

        def me(self):
            return {"status_code": 200, "ok": True, "body": {"id": "agent_test", "auth": captured["api_key_status"]}}

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["shell", "--dry", "--backend", "local", "--repo", str(tmp_path)],
        input=(
            "/config\n"
            "/config set CLAWHUNT_BASE_URL https://example.test\n"
            "/login cph_test_secret\n"
            "/me\n"
            "/plugins\n"
            "/logout\n"
            "/config\n"
            "/exit\n"
        ),
    )

    assert result.exit_code == 0, result.output
    assert "SuperClaw Runtime Shell" in result.output
    assert "APP_ENV=staging" in result.output
    assert "CLAWHUNT_BASE_URL=https://staging.clawhunt.store" in result.output
    assert "CLAWHUNT_BASE_URL=set" in result.output
    assert "CLAWHUNT_AGENT_API_KEY=set" in result.output
    assert '"id": "agent_test"' in result.output
    assert '"auth": "set"' in result.output
    assert '"plugins": []' in result.output
    assert "CLAWHUNT_AGENT_API_KEY=unset" in result.output
    assert "cph_test_secret" not in result.output


def test_cli_shell_persists_backend_default(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    runner = CliRunner()

    first = runner.invoke(app, ["shell", "--repo", str(tmp_path)], input="/backend codex\n/exit\n")
    second = runner.invoke(app, ["shell", "--repo", str(tmp_path)], input="/config\n/exit\n")

    assert first.exit_code == 0, first.output
    assert "backend=codex" in first.output
    assert "backend_default=codex" in first.output
    assert json.loads(shell_config.read_text(encoding="utf-8"))["backend"] == "codex"
    assert second.exit_code == 0, second.output
    assert "backend=codex" in second.output
    assert "backend_default=codex" in second.output


def test_cli_shell_config_persists_non_secret_values_but_not_secret_values(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    _guard_process_env(monkeypatch, "SUPERCLAW_CODEX_EXECUTABLE", "SUPERCLAW_GEMINI_API_KEY")
    runner = CliRunner()

    first = runner.invoke(
        app,
        ["shell", "--repo", str(tmp_path)],
        input="/config set SUPERCLAW_CODEX_EXECUTABLE /tmp/codex\n/config set SUPERCLAW_GEMINI_API_KEY gemini-secret\n/exit\n",
    )
    # Drop the value the first shell wrote into the live environment so the
    # second shell must read it from the persisted config file.
    os.environ.pop("SUPERCLAW_CODEX_EXECUTABLE", None)
    second = runner.invoke(app, ["shell", "--repo", str(tmp_path)], input="/config\n/exit\n")

    stored = json.loads(shell_config.read_text(encoding="utf-8"))
    assert first.exit_code == 0, first.output
    assert stored["SUPERCLAW_CODEX_EXECUTABLE"] == "/tmp/codex"
    assert "SUPERCLAW_GEMINI_API_KEY" not in stored
    assert second.exit_code == 0, second.output
    assert "SUPERCLAW_CODEX_EXECUTABLE=set" in second.output
    assert "gemini-secret" not in first.output
    assert "gemini-secret" not in second.output


def test_cli_shell_backend_option_overrides_persisted_default_once(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(json.dumps({"backend": "codex"}), encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    runner = CliRunner()

    result = runner.invoke(app, ["shell", "--backend", "local", "--repo", str(tmp_path)], input="/config\n/exit\n")

    assert result.exit_code == 0, result.output
    assert "backend=local" in result.output
    assert "backend_default=codex" in result.output
    assert json.loads(shell_config.read_text(encoding="utf-8"))["backend"] == "codex"


def test_shell_full_dashboard_contains_claw_brand_and_input_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))

    lines = cli_module._shell_dashboard_lines(
        session_id=None,
        backend="hermes",
        mode="auto",
        repo=tmp_path,
        last_run_id=None,
        full=True,
        use_color=False,
    )
    prompt = cli_module._shell_prompt(use_color=False)

    rendered = "\n".join(lines)
    assert "SuperClaw Runtime Shell" in rendered
    assert "End-to-end delivery AgentOS" in rendered
    assert "╭" in rendered
    assert "______/    )-." in rendered
    assert "╰" in rendered
    assert "[ Context ]" in rendered
    assert "[ Authentication ]" in rendered
    assert "[ Slash Commands ]" in rendered
    assert "/login CLAWHUNT_AGENT_KEY" in rendered
    assert "Input box" in rendered
    assert "╭─ input" in prompt
    assert "╰─ lobster-claw> " in prompt


def test_shell_slash_command_completer_lists_matching_commands():
    class FakeDocument:
        text_before_cursor = "/b"

    completions = list(cli_module._SlashCommandCompleter().get_completions(FakeDocument(), None))

    assert any(completion.text == "/backend " for completion in completions)
    assert all(completion.text.startswith("/b") for completion in completions)


def test_shell_slash_command_completer_lists_config_set():
    class FakeDocument:
        text_before_cursor = "/config s"

    completions = list(cli_module._SlashCommandCompleter().get_completions(FakeDocument(), None))

    assert any(completion.text == "/config set " for completion in completions)


def test_shell_slash_command_completer_lists_plugins_doctor():
    class FakeDocument:
        text_before_cursor = "/plugins d"

    completions = list(cli_module._SlashCommandCompleter().get_completions(FakeDocument(), None))

    assert any(completion.text == "/plugins doctor" for completion in completions)


def test_cli_tui_acceptance_command_emits_json_report(tmp_path, monkeypatch):
    def fake_run_tui_acceptance(*, workspace_root, python_executable=None, report_path=None, snapshot_file=None):
        assert workspace_root == Path(".").resolve()
        assert python_executable is None
        assert report_path == tmp_path / "tui-acceptance.json"
        assert snapshot_file == tmp_path / "tui-snapshot.json"
        return {
            "generated_at": "2026-06-04T09:00:00Z",
            "workspace_root": str(workspace_root),
            "snapshot_path": str(snapshot_file),
            "success": True,
            "failed_step": None,
            "steps": [],
        }

    monkeypatch.setattr(cli_module, "run_tui_acceptance", fake_run_tui_acceptance)

    result = CliRunner().invoke(
        app,
        [
            "tui-acceptance",
            "--report-file",
            str(tmp_path / "tui-acceptance.json"),
            "--snapshot-file",
            str(tmp_path / "tui-snapshot.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["failed_step"] is None


def test_shell_help_groups_phase_one_commands():
    rendered = cli_module._shell_help_text()

    assert "Core:" in rendered
    assert "Runtime:" in rendered
    assert "Inspect:" in rendered
    assert "Plugins:" in rendered
    assert "/status" in rendered
    assert "/setup [BACKEND]" in rendered
    assert "/runs" in rendered
    assert "/run RUN_ID" in rendered
    assert "/evidence RUN_ID" in rendered
    assert "/plugins doctor" in rendered


def test_shell_working_status_line_includes_runtime_context(tmp_path):
    line = cli_module._shell_working_status_line(frame="|", intent="chat", backend="codex", repo=tmp_path, elapsed_seconds=7)

    assert line.startswith("| working intent=chat backend=codex elapsed=7s repo=")


def test_shell_working_indicator_disabled_does_not_write(tmp_path, monkeypatch):
    output = io.StringIO()
    monkeypatch.setattr(cli_module.sys, "stdout", output)

    with cli_module._ShellWorkingIndicator(enabled=False, intent="delivery", backend="codex", repo=tmp_path, interval_seconds=0.01):
        time.sleep(0.03)

    assert output.getvalue() == ""


def test_shell_working_indicator_enabled_writes_and_clears_status(tmp_path, monkeypatch):
    output = io.StringIO()
    monkeypatch.setattr(cli_module.sys, "stdout", output)

    with cli_module._ShellWorkingIndicator(enabled=True, intent="delivery", backend="codex", repo=tmp_path, interval_seconds=0.01):
        time.sleep(0.03)

    rendered = output.getvalue()
    assert "working intent=delivery backend=codex" in rendered
    assert "elapsed=0s" in rendered
    assert rendered.endswith("\r")


def test_shell_turn_status_lines_are_machine_readable(tmp_path):
    start = cli_module._shell_turn_start_line(intent="chat", mode="auto", backend="codex", repo=tmp_path)
    done = cli_module._shell_turn_done_line(status="completed")

    assert start == f"turn_status=working intent=chat mode=auto backend=codex repo={tmp_path} shell_status=working"
    assert done == "turn_status=completed shell_status=ready"


def test_shell_toolbar_redacts_agent_key(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAWHUNT_AGENT_API_KEY", "cph_test_secret")

    toolbar = cli_module._shell_toolbar_plain(
        session_id="chat_test",
        backend="hermes",
        mode="auto",
        repo=tmp_path,
        last_run_id="run_test",
    )

    assert "auth=set" in toolbar
    assert "mode=auto" in toolbar
    assert "cph_test_secret" not in toolbar


def test_shell_agent_status_lines_include_config_hint(monkeypatch):
    @dataclass
    class FakeAvailability:
        name: str
        available: bool
        executable: str | None = None
        version: str | None = None
        reason: str | None = None

    class MissingBackend:
        def available(self):
            return FakeAvailability(name="hermes", available=False, reason="hermes executable not found")

        def permission_presets(self):
            from superclaw.permissions import PresetRealization, make_presets

            return make_presets(
                ask=PresetRealization("missing-ask", False, "perm.note.missing.ask"),
                allow=PresetRealization("missing-allow", False, "perm.note.missing.allow"),
            )

    monkeypatch.setattr(cli_module, "default_backends", lambda: {"hermes": MissingBackend()})

    rendered = "\n".join(cli_module._agent_status_lines(selected_backend="hermes", include_all=True))

    assert "Local agents:" in rendered
    assert "hermes" in rendered
    assert "MISSING" in rendered
    assert "/config set SUPERCLAW_HERMES_EXECUTABLE /path/to/hermes" in rendered


def test_cli_shell_exposes_status_runs_and_plugin_doctor(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    runner = CliRunner()

    run_result = runner.invoke(
        app,
        [
            "run",
            "--title",
            "Shell inspect",
            "--description",
            "Create inspectable run",
            "--dry",
            "--backend",
            "local",
            "--repo",
            str(tmp_path),
            "--artifact-dir",
            str(tmp_path / "artifacts"),
        ],
    )
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    result = runner.invoke(
        app,
        ["shell", "--dry", "--backend", "local", "--repo", str(tmp_path), "--artifact-dir", str(tmp_path / "artifacts")],
        input=f"/status\n/runs\n/run {run_id}\n/evidence {run_id}\n/plugins doctor\n/exit\n",
    )

    assert result.exit_code == 0, result.output
    assert "Runtime status:" in result.output
    assert "runs_total=1" in result.output
    assert "Recent runs (1 total):" in result.output
    assert f"run_id={run_id}" in result.output
    assert "task_status_counts=" in result.output
    assert "chain_verdict=CHAIN_PARTIAL" in result.output
    assert "Plugin doctor:" in result.output
    assert "artifact_count=0" in result.output
    assert "findings=(none)" in result.output


def test_cli_shell_setup_guides_backend_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    _guard_process_env(
        monkeypatch,
        "CLAWHUNT_BASE_URL",
        "SUPERCLAW_HERMES_EXECUTABLE",
        "SUPERCLAW_HERMES_MODEL",
        "SUPERCLAW_HERMES_PROVIDER",
        "SUPERCLAW_HERMES_TOOLSETS",
        "SUPERCLAW_HERMES_SKILLS",
    )
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["shell", "--backend", "local", "--repo", str(tmp_path)],
        input=(
            "/setup\n"
            "hermes\n"
            "chat\n"
            f"{tmp_path}\n"
            "https://setup.test\n"
            "/tmp/hermes\n"
            "hermes-pro\n"
            "openrouter\n"
            "toolset-a\n"
            "skill-a\n"
            "/config\n"
            "/exit\n"
        ),
    )

    stored = json.loads(shell_config.read_text(encoding="utf-8"))
    assert result.exit_code == 0, result.output
    assert "setup_complete=true" in result.output
    assert "backend=hermes" in result.output
    assert "backend_default=hermes" in result.output
    assert "mode=chat" in result.output
    assert "mode_default=chat" in result.output
    assert f"repo={tmp_path}" in result.output
    assert "configured=CLAWHUNT_BASE_URL,backend,mode,repo,SUPERCLAW_HERMES_EXECUTABLE,SUPERCLAW_HERMES_MODEL,SUPERCLAW_HERMES_PROVIDER,SUPERCLAW_HERMES_TOOLSETS,SUPERCLAW_HERMES_SKILLS" in result.output
    assert stored["backend"] == "hermes"
    assert stored["mode"] == "chat"
    assert stored["repo"] == str(tmp_path)
    assert stored["CLAWHUNT_BASE_URL"] == "https://setup.test"
    assert stored["SUPERCLAW_HERMES_EXECUTABLE"] == "/tmp/hermes"
    assert stored["SUPERCLAW_HERMES_MODEL"] == "hermes-pro"
    assert stored["SUPERCLAW_HERMES_PROVIDER"] == "openrouter"
    assert stored["SUPERCLAW_HERMES_TOOLSETS"] == "toolset-a"
    assert stored["SUPERCLAW_HERMES_SKILLS"] == "skill-a"


def test_cli_shell_uses_persisted_repo_when_repo_flag_is_omitted(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(
        json.dumps(
            {
                "backend": "local",
                "mode": "chat",
                "repo": str(tmp_path / "persisted-repo"),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    runner = CliRunner()

    result = runner.invoke(app, ["shell"], input="/config\n/exit\n")

    assert result.exit_code == 0, result.output
    assert f"repo={tmp_path / 'persisted-repo'}" in result.output


def test_safe_shell_history_skips_secret_commands(tmp_path):
    history_path = tmp_path / "history.txt"
    history = cli_module._SafeShellHistory(str(history_path))

    history.append_string("/status")
    history.append_string("/login cph_secret_value")
    history.append_string("/config set ANTHROPIC_API_KEY top-secret")
    history.append_string("hello superclaw")

    rendered = history_path.read_text(encoding="utf-8")
    assert "/status" in rendered
    assert "hello superclaw" in rendered
    assert "cph_secret_value" not in rendered
    assert "top-secret" not in rendered


def test_shell_prompt_value_uses_ephemeral_history_for_password(monkeypatch):
    seen = {}

    class FakeSession:
        def __init__(self, *, history=None, style=None):
            seen["history"] = history
            seen["style"] = style

        def prompt(self, prompt_text, is_password=False):
            seen["prompt_text"] = prompt_text
            seen["is_password"] = is_password
            return "secret-value"

    monkeypatch.setattr(cli_module, "PromptSession", FakeSession)

    value = cli_module._shell_prompt_value(object(), "Gemini key", default="", password=True)

    assert value == "secret-value"
    assert isinstance(seen["history"], cli_module.InMemoryHistory)
    assert seen["is_password"] is True


def test_shell_setup_backend_keys_are_unique():
    assert cli_module._shell_setup_backend_keys("gemini").count("SUPERCLAW_GEMINI_API_KEY") == 1
    assert cli_module._shell_setup_backend_keys("anthropic").count("ANTHROPIC_API_KEY") == 1
    assert cli_module._shell_setup_backend_keys("anthropic-agent").count("ANTHROPIC_API_KEY") == 1


def test_shell_history_path_defaults_next_to_shell_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config" / "shell-config.json"))
    monkeypatch.delenv("SUPERCLAW_SHELL_HISTORY_PATH", raising=False)

    assert cli_module._shell_history_path() == tmp_path / "config" / "history.txt"


def test_shell_config_lines_report_selected_backend_status(monkeypatch, tmp_path):
    @dataclass
    class FakeAvailability:
        name: str
        available: bool
        executable: str | None = None
        version: str | None = None
        reason: str | None = None

    class ReadyBackend:
        def available(self):
            return FakeAvailability(name="local", available=True, executable="/usr/bin/python3", version="3.11")

    monkeypatch.setattr(cli_module, "default_backends", lambda: {"local": ReadyBackend()})

    rendered = "\n".join(cli_module._shell_config_lines(session_id=None, backend="local", mode="auto", repo=tmp_path, last_run_id=None))

    assert "backend_status=local: READY" in rendered
    assert "mode=auto" in rendered
    assert "SUPERCLAW_CLAUDE_EXECUTABLE=PATH:auto" in rendered


def test_shell_compact_dashboard_omits_brand_art_and_input_guidance(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))

    lines = cli_module._shell_dashboard_lines(
        session_id="chat_test",
        backend="local",
        mode="auto",
        repo=tmp_path,
        last_run_id="run_test",
        full=False,
        use_color=False,
    )

    rendered = "\n".join(lines)
    assert "SuperClaw Runtime Shell" in rendered
    assert "session_id=chat_test" in rendered
    assert "last_run_id=run_test" in rendered
    assert "______/    )-." not in rendered
    assert "Input box" not in rendered
    assert "[ Slash Commands ]" not in rendered


def test_cli_main_without_args_starts_shell(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setattr(sys, "argv", ["superclaw"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("/exit\n"))

    cli_module.main()

    output = capsys.readouterr().out
    assert "SuperClaw Runtime Shell" in output
    assert "Type natural language to chat or run a delivery turn" in output
    assert "backend=claude" in output
    assert "mode=auto" in output
    assert "repo=." in output
    assert "OptionInfo" not in output


def test_cli_run_returns_nonzero_for_failed_runs(monkeypatch):
    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    class FakeOrchestrator:
        @classmethod
        def from_path(cls, path):
            return cls()

        def run_goal(self, **kwargs):
            return FakeRunResult(
                session=RunSession(goal_id="goal_1", run_id="run_failed", status="failed"),
                evidence=EvidenceBundle(run_id="run_failed"),
            )

    monkeypatch.setattr(cli_module, "SuperClawOrchestrator", FakeOrchestrator)
    result = CliRunner().invoke(app, ["run", "--title", "Fail", "--description", "Backend fail"])

    assert result.exit_code == 1
    assert "run_id=run_failed" in result.output
    assert "status=failed" in result.output


def test_cli_validate_reports_success_rate(monkeypatch, tmp_path):
    calls = []

    @dataclass
    class FakeRunResult:
        session: RunSession
        evidence: EvidenceBundle

    class FakeOrchestrator:
        @classmethod
        def from_path(cls, path):
            return cls()

        def run_goal(self, **kwargs):
            backend = kwargs["backend_policy"]
            calls.append(backend)
            session = RunSession(goal_id=f"goal_{backend}", run_id=f"run_{backend}")
            session.status = "completed" if backend != "bad" else "failed"
            evidence = EvidenceBundle(run_id=session.run_id)
            evidence.add_probe("control_plane", 200, {"ok": True})
            if backend != "bad":
                evidence.add_command("echo ok", 0, "ok")
            else:
                evidence.add_finding("worker_execution", False, "bad backend", "high")
            return FakeRunResult(session=session, evidence=evidence)

    monkeypatch.setattr(cli_module, "SuperClawOrchestrator", FakeOrchestrator)
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))

    result = CliRunner().invoke(
        app,
        [
            "validate",
            "--backends",
            "local,bad",
            "--repo",
            str(tmp_path),
            "--artifact-dir",
            str(tmp_path / "artifacts"),
            "--fail-under",
            "0.5",
        ],
    )

    assert result.exit_code == 0
    assert '"success_rate": 0.5' in result.output
    assert '"backend": "local"' in result.output
    assert '"backend": "bad"' in result.output
    assert calls == ["local", "bad"]


def test_cli_eval_delivery_gap_report_and_open(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_EVAL_ROOT", str(tmp_path / "evals"))
    runner = CliRunner()
    output = tmp_path / "latest"

    run = runner.invoke(app, ["eval", "delivery-gap", "--agent", "superclaw", "--output", str(output), "--timeout-seconds", "120"])
    report = runner.invoke(app, ["eval", "report", str(output)])
    report_pdf = runner.invoke(app, ["eval", "report-pdf", str(output)])
    opened = runner.invoke(app, ["eval", "open", str(output)])

    assert run.exit_code == 0, run.output
    assert '"verdict": "E2E_PROVEN"' in run.output
    assert report.exit_code == 0, report.output
    assert '"case_id": "mini-pay-webhook"' in report.output
    assert report_pdf.exit_code == 0, report_pdf.output
    assert "report_pdf" in report_pdf.output
    assert (output / "report.pdf").exists()
    assert opened.exit_code == 0
    assert "report_md" in opened.output
    assert "report_pdf" in opened.output


def test_cli_harness_matrix_and_inventory(tmp_path):
    plugin_dir = tmp_path / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text('{"description":"Demo"}', encoding="utf-8")
    (plugin_dir / "agents").mkdir()
    (plugin_dir / "agents" / "worker.md").write_text("---\nname: worker\ndescription: work\n---\nBody", encoding="utf-8")

    runner = CliRunner()
    matrix = runner.invoke(app, ["harness", "matrix"])
    inventory = runner.invoke(app, ["harness", "inventory", str(tmp_path)])

    assert matrix.exit_code == 0
    assert '"codex"' in matrix.output
    assert '"local_agent"' in matrix.output
    assert inventory.exit_code == 0
    assert '"plugin_count": 1' in inventory.output
    assert '"agent_count": 1' in inventory.output


def test_cli_harness_emit_writes_selected_target(tmp_path):
    plugin_dir = tmp_path / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text('{"description":"Demo"}', encoding="utf-8")
    (plugin_dir / "agents").mkdir()
    (plugin_dir / "agents" / "worker.md").write_text("---\nname: worker\ndescription: work\n---\nBody", encoding="utf-8")

    output_root = tmp_path / "generated"
    result = CliRunner().invoke(app, ["harness", "emit", str(tmp_path), str(output_root), "--target", "gemini", "--plugins", "demo"])

    assert result.exit_code == 0, result.output
    assert '"target": "gemini"' in result.output
    assert (output_root / "agents" / "demo__worker.md").exists()
    assert (output_root / "GEMINI.md").exists()


def test_cli_harness_validate_reports_ok(tmp_path):
    plugin_dir = tmp_path / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text('{"description":"Demo"}', encoding="utf-8")
    (plugin_dir / "skills" / "ship").mkdir(parents=True)
    (plugin_dir / "skills" / "ship" / "SKILL.md").write_text("---\nname: ship\ndescription: ship\n---\nBody", encoding="utf-8")
    output_root = tmp_path / "generated"
    runner = CliRunner()
    emit = runner.invoke(app, ["harness", "emit", str(tmp_path), str(output_root), "--target", "codex"])

    result = runner.invoke(app, ["harness", "validate", str(output_root), "--target", "codex"])

    assert emit.exit_code == 0, emit.output
    assert result.exit_code == 0, result.output
    assert '"ok": true' in result.output


def test_cli_human_gate_pause_and_resume(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Gate", "--description", "Needs operator", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    pause = runner.invoke(app, ["human-gate", run_id, "--reason", "OTP required"])
    resume = runner.invoke(app, ["resume", run_id])

    assert pause.exit_code == 0
    assert "status=WAITING_FOR_HUMAN_GATE" in pause.output
    assert resume.exit_code == 0
    assert "status=completed" in resume.output


def test_cli_delegate_review_list_filters_results(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    session, request_key = _create_cli_delegation_review_run(state_path, tmp_path)
    runner = CliRunner()

    pending = runner.invoke(app, ["delegate-review", "list", session.run_id])
    all_results = runner.invoke(app, ["delegate-review", "list", session.run_id, "--status", "all"])

    assert pending.exit_code == 0, pending.output
    pending_payload = json.loads(pending.output)
    assert [item["request_key"] for item in pending_payload["reviews"]] == [request_key]
    assert all_results.exit_code == 0, all_results.output
    assert len(json.loads(all_results.output)["reviews"]) == 2


def test_cli_delegate_review_approve_leaves_parent_waiting(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    session, request_key = _create_cli_delegation_review_run(state_path, tmp_path)
    runner = CliRunner()

    result = runner.invoke(app, ["delegate-review", "approve", session.run_id, request_key, "--by", "qa"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert payload["result"]["status"] == "approved"
    assert payload["result"]["review"]["reviewed_by"] == "qa"
    assert StateStore(state_path).get_run(session.run_id).status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value


def test_cli_delegate_review_reject_fails_parent(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    session, request_key = _create_cli_delegation_review_run(state_path, tmp_path)
    runner = CliRunner()

    result = runner.invoke(app, ["delegate-review", "reject", session.run_id, request_key, "--by", "qa"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == RunStatus.FAILED.value
    assert payload["result"]["status"] == "rejected"
    evidence = StateStore(state_path).get_evidence(session.run_id)
    assert any(finding.name == "cross_runtime_delegation_review" for finding in evidence.findings)


def test_cli_delegate_review_errors_are_nonzero(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    session, request_key = _create_cli_delegation_review_run(state_path, tmp_path, waiting=False)
    runner = CliRunner()

    bad_status = runner.invoke(app, ["delegate-review", "list", session.run_id, "--status", "unknown"])
    conflict = runner.invoke(app, ["delegate-review", "approve", session.run_id, request_key, "--by", "qa"])
    missing = runner.invoke(app, ["delegate-review", "approve", "not-a-run", request_key, "--by", "qa"])

    assert bad_status.exit_code == 1
    assert "status must be" in bad_status.output
    assert conflict.exit_code == 1
    assert "cannot review delegate result" in conflict.output
    assert missing.exit_code == 1
    assert "run not found" in missing.output


def test_cli_team_board_inbox_assign_resolves_through_kernel(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    seeded = _seed_cli_team_ops_state(state_path)
    runner = CliRunner()

    listed = runner.invoke(app, ["team", "board-inbox", "list"])
    assigned = runner.invoke(
        app,
        ["team", "board-inbox", "assign", seeded["interaction_id"], seeded["profile_id"]],
    )
    conflict = runner.invoke(
        app,
        ["team", "board-inbox", "assign", seeded["interaction_id"], seeded["profile_id"]],
    )

    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["items"][0]["interaction_id"] == seeded["interaction_id"]
    assert assigned.exit_code == 0, assigned.output
    payload = json.loads(assigned.output)
    assert payload["resolved"] is True
    assert payload["issue"]["assignee_agent_profile_id"] == seeded["profile_id"]
    assert payload["issue"]["status"] == "todo"
    assert payload["interaction"]["status"] == "resolved"
    assert conflict.exit_code == 1
    assert "not pending" in conflict.output


def test_cli_team_routine_author_schedules_only_ready_enabled(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    seeded = _seed_cli_team_ops_state(state_path)
    runner = CliRunner()
    base_spec = {
        "title": "Review incoming issues",
        "enabled": True,
        "cadence": {"kind": "interval", "interval": "5m"},
        "owner_id": "local_user",
        "company_profile_id": "company_acme",
        "workspace_id": "workspace_acme",
        "agent_profile_id": seeded["profile_id"],
        "issue_seed": {"title": "Review incoming issues"},
    }

    ready = runner.invoke(
        app,
        ["team", "routine", "author", "--spec-json", json.dumps(base_spec)],
    )
    disabled = runner.invoke(
        app,
        [
            "team",
            "routine",
            "author",
            "--spec-json",
            json.dumps({**base_spec, "enabled": False, "title": "Disabled review"}),
        ],
    )
    gated = runner.invoke(
        app,
        [
            "team",
            "routine",
            "author",
            "--spec-json",
            json.dumps(
                {
                    **base_spec,
                    "title": "Publish review",
                    "governance": {"risk_flags": ["public_publish"]},
                }
            ),
        ],
    )
    listing = runner.invoke(app, ["team", "routine", "list"])

    assert ready.exit_code == 0, ready.output
    assert json.loads(ready.output)["scheduled"] is True
    assert disabled.exit_code == 0, disabled.output
    disabled_payload = json.loads(disabled.output)
    assert disabled_payload["authoring"]["status"] == "disabled"
    assert disabled_payload["scheduled"] is False
    assert gated.exit_code == 0, gated.output
    gated_payload = json.loads(gated.output)
    assert gated_payload["authoring"]["status"] == "requires_approval"
    assert gated_payload["scheduled"] is False
    assert listing.exit_code == 0, listing.output
    listed = json.loads(listing.output)
    assert listed["count"] == 1
    assert listed["schedules"][0]["title"] == "Review incoming issues"


def test_cli_reconcile_reports_resumable_stale_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    orchestrator = SuperClawOrchestrator.from_path(tmp_path / "state.db")
    goal = orchestrator.store.create_goal(GoalSpec(title="Stale", description="Resume me"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    orchestrator.store.save_run(session)
    orchestrator.store.create_evidence(session.run_id)

    result = CliRunner().invoke(app, ["reconcile", session.run_id])

    assert result.exit_code == 0
    assert "classification=resumable" in result.output
    assert "status=queued" in result.output


def test_cli_reconcile_reports_active_writer_for_fresh_persisted_lease(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    orchestrator = SuperClawOrchestrator.from_path(tmp_path / "state.db")
    goal = orchestrator.store.create_goal(GoalSpec(title="Fresh lease", description="Do not steal"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )
    orchestrator.store.save_run(session)
    orchestrator.store.create_evidence(session.run_id)

    result = CliRunner().invoke(app, ["reconcile", session.run_id])
    persisted = orchestrator.store.get_run(session.run_id)

    assert result.exit_code == 0
    assert "classification=active_writer" in result.output
    assert "status=running" in result.output
    assert persisted.active_mutation_lease is not None
    assert persisted.active_mutation_lease.owner == "execute:live"


def test_cli_reconcile_reclaims_dead_worker_pid_lease_before_ttl(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    orchestrator = SuperClawOrchestrator.from_path(tmp_path / "state.db")
    goal = orchestrator.store.create_goal(GoalSpec(title="Dead pid", description="Reclaim stale local worker"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    dead_pid = 424242
    session.active_mutation_lease = RunMutationLease(
        resource=f"run:{session.run_id}",
        owner=f"execute:{session.run_id}",
        mode=RunMutationMode.EXECUTE,
        worker_pid=dead_pid,
        worker_host=socket.gethostname(),
    )
    orchestrator.store.save_run(session)
    orchestrator.store.create_evidence(session.run_id)

    def fake_kill(pid, signal):
        assert signal == 0
        if pid == dead_pid:
            raise ProcessLookupError(pid)

    monkeypatch.setattr("superclaw.orchestrator.os.kill", fake_kill)

    result = CliRunner().invoke(app, ["reconcile", session.run_id])
    persisted = orchestrator.store.get_run(session.run_id)
    stale_event = next(
        event for event in orchestrator.store.list_events(session.run_id) if event["type"] == "run.lease.stale"
    )

    assert result.exit_code == 0
    assert "classification=resumable" in result.output
    assert "status=queued" in result.output
    assert persisted.active_mutation_lease is None
    assert stale_event["payload"]["worker_pid"] == dead_pid
    assert stale_event["payload"]["stale_reason"] == "worker process is no longer alive"


def test_cli_reconcile_reports_cancelled_stale_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    orchestrator = SuperClawOrchestrator.from_path(tmp_path / "state.db")
    goal = orchestrator.store.create_goal(GoalSpec(title="Stale cancel", description="Cancel me"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    orchestrator.store.save_run(session)
    orchestrator.store.create_evidence(session.run_id)
    orchestrator.store.add_event(session.run_id, "run.cancel.requested", {"run_id": session.run_id})

    result = CliRunner().invoke(app, ["reconcile", session.run_id])

    assert result.exit_code == 0
    assert "classification=cancelled" in result.output
    assert "status=cancelled" in result.output


def test_cli_clawhunt_extended_commands_use_client(monkeypatch):
    # The legacy direct-write commands (bid/claim/submit) are disabled by default
    # (governed marketplace path is authoritative); this test exercises the raw
    # client passthrough, so it opts into the deliberate operator override.
    monkeypatch.setenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", "1")
    calls = []

    class FakeClawHuntClient:
        def post_problem(self, payload):
            calls.append(("post_problem", payload))
            return {"status_code": 201, "ok": True, "body": {"id": 7}}

        def bid(self, problem_id, amount=None, message=""):
            calls.append(("bid", problem_id, amount, message))
            return {"status_code": 200, "ok": True, "body": {"bid": True}}

        def accept(self, problem_id):
            calls.append(("accept", problem_id))
            return {"status_code": 200, "ok": True, "body": {"accepted": True}}

        def accept_bid(self, problem_id, bid_id):
            calls.append(("accept_bid", problem_id, bid_id))
            return {"status_code": 200, "ok": True, "body": {"accepted_bid": True}}

        def get_problem_bids(self, problem_id):
            calls.append(("get_problem_bids", problem_id))
            return {"status_code": 200, "ok": True, "body": {"bids": []}}

        def capability_probe_status(self):
            calls.append(("capability_probe_status",))
            return {"status_code": 200, "ok": True, "body": {"ready": True}}

        def me(self):
            calls.append(("me",))
            return {"status_code": 200, "ok": True, "body": {"id": "agent"}}

        def skills(self):
            calls.append(("skills",))
            return {"status_code": 200, "ok": True, "body": []}

        def memories(self):
            calls.append(("memories",))
            return {"status_code": 200, "ok": True, "body": []}

        def subtasks(self, problem_id):
            calls.append(("subtasks", problem_id))
            return {"status_code": 200, "ok": True, "body": []}

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)
    runner = CliRunner()

    commands = [
        [
            "clawhunt",
            "post",
            "--title",
            "New",
            "--description",
            "Task",
            "--price",
            "25",
            "--routing-mode",
            "directed",
            "--target-agent-id",
            "9",
        ],
        ["clawhunt", "bid", "7", "--amount", "10", "--message", "Ready"],
        ["clawhunt", "accept", "7"],
        ["clawhunt", "accept-bid", "7", "3"],
        ["clawhunt", "bids", "7"],
        ["clawhunt", "capability-probe"],
        ["clawhunt", "me"],
        ["clawhunt", "skills"],
        ["clawhunt", "memories"],
        ["clawhunt", "subtasks", "7"],
    ]
    for command in commands:
        result = runner.invoke(app, command)
        assert result.exit_code == 0, result.output
        assert '"status_code": 200' in result.output or '"status_code": 201' in result.output

    assert calls == [
        (
            "post_problem",
            {
                "title": "New",
                "description": "Task",
                "price": 25,
                "category": "testing",
                "difficulty": "easy",
                "routing_mode": "directed",
                "target_agent_id": 9,
            },
        ),
        ("bid", 7, 10, "Ready"),
        ("accept", 7),
        ("accept_bid", 7, 3),
        ("get_problem_bids", 7),
        ("capability_probe_status",),
        ("me",),
        ("skills",),
        ("memories",),
        ("subtasks", 7),
    ]


def test_cli_clawhunt_live_readiness_uses_non_mutating_gate(monkeypatch):
    calls = []

    class FakeClawHuntClient:
        def live_readiness_report(self, *, authenticated_read=False, require_payment=False, include_probe=True):
            calls.append((authenticated_read, require_payment, include_probe))
            return {
                "status": "ready",
                "scope": "read_only_production_gate",
                "checks": [],
                "requirements": {"mutating_operations_attempted": False},
            }

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)

    result = CliRunner().invoke(
        app,
        ["clawhunt", "live-readiness", "--authenticated-read", "--require-payment", "--no-probe"],
    )

    assert result.exit_code == 0, result.output
    assert '"status": "ready"' in result.output
    assert calls == [(True, True, False)]


def test_cli_clawhunt_live_readiness_can_fail_on_partial(monkeypatch):
    class FakeClawHuntClient:
        def live_readiness_report(self, *, authenticated_read=False, require_payment=False, include_probe=True):
            return {
                "status": "partial",
                "scope": "read_only_production_gate",
                "checks": [{"id": "pay_switch_proxy_health", "passed": False, "severity": "warning"}],
            }

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)

    result = CliRunner().invoke(app, ["clawhunt", "live-readiness", "--fail-on-partial"])

    assert result.exit_code == 1
    assert '"status": "partial"' in result.output


def test_cli_submit_uses_protocol_adapter_payload(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    captured = {}

    class FakeClawHuntClient:
        def submit_solution(self, problem_id, submission, evidence=None, *, attachments=None):
            captured["problem_id"] = problem_id
            captured["submission"] = submission
            captured["evidence"] = evidence
            captured["attachments"] = attachments
            return {"status_code": 200, "ok": True, "body": {"accepted": True}}

    monkeypatch.setattr(cli_module, "ClawHuntClient", FakeClawHuntClient)
    runner = CliRunner()
    run_result = runner.invoke(app, ["run", "--title", "Submit", "--description", "Adapter", "--dry"])
    run_id = next(line.split("=", 1)[1] for line in run_result.output.splitlines() if line.startswith("run_id="))

    result = runner.invoke(app, ["submit", "77", run_id])

    assert result.exit_code == 0
    assert captured["problem_id"] == 77
    assert captured["evidence"] is None
    assert captured["attachments"] is None
    assert captured["submission"].adapter_name == "clawhunt.v1.solution"
    assert captured["submission"].request_json["evidence"]["run_id"] == run_id
    assert '"accepted": true' in result.output


def test_cli_harness_adapt_agent_missing_file_errors_cleanly(tmp_path):
    runner = CliRunner()
    result = runner.invoke(app, ["harness", "adapt-agent", str(tmp_path / "missing.md")])
    assert result.exit_code == 1
    assert "file not found" in result.output


def test_cli_harness_adapt_agent_unknown_target_errors_cleanly(tmp_path):
    agent = tmp_path / "agent.md"
    agent.write_text("---\nname: demo\n---\nBody text here.\n", encoding="utf-8")
    runner = CliRunner()
    result = runner.invoke(app, ["harness", "adapt-agent", str(agent), "--target", "bogus-harness"])
    assert result.exit_code == 1
    assert "unknown target harness" in result.output


def _seed_running_parent(tmp_path):
    from superclaw.state import StateStore
    from superclaw.orchestrator import SuperClawOrchestrator
    store = StateStore(tmp_path / "state.db")
    orch = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Parent", description="cli fanout"))
    session = orch.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    return session


def test_cli_fanout_spawns_parallel_subagents(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    session = _seed_running_parent(tmp_path)
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["fanout", session.run_id, "--branches", "2", "--description", "branch", "--dry", "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output.strip().splitlines()[-1])
    assert payload["total"] == 2
    assert payload["succeeded"] is True
    assert len(payload["children"]) == 2


def test_cli_fanout_unknown_run_errors_cleanly(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    result = runner.invoke(app, ["fanout", "run_missing", "--description", "x", "--dry"])
    assert result.exit_code == 1
    assert "run not found" in result.output


def test_cli_run_model_flag_lands_in_execution_context(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["run", "--title", "Ship", "--description", "Build", "--dry", "--model", "claude-haiku-4-5"],
    )

    assert result.exit_code == 0
    run_id = next(line.split("=", 1)[1] for line in result.output.splitlines() if line.startswith("run_id="))
    session = StateStore(tmp_path / "state.db").get_run(run_id)
    assert session.execution_context["model"] == "claude-haiku-4-5"


def test_cli_chat_records_sticky_runtime_and_reuses_it(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    _trust_cwd_workspace(tmp_path / "state.db")
    runner = CliRunner()

    first = runner.invoke(
        app,
        ["chat", "-m", "First turn", "--dry", "--backend", "hermes", "--model", "anthropic/claude-sonnet-4.6", "--json"],
    )
    assert first.exit_code == 0, first.output
    payload = json.loads(first.output)
    assert payload["backend"] == "hermes"
    assert payload["model"] == "anthropic/claude-sonnet-4.6"

    store = StateStore(tmp_path / "state.db")
    assert store.get_chat_runtime(payload["session_id"]) == {
        "backend": "hermes",
        "model": "anthropic/claude-sonnet-4.6",
    }

    # follow-up turn with NO flags: the chat remembers its runtime
    second = runner.invoke(app, ["chat", "-m", "Second turn", "--dry", "--session-id", payload["session_id"], "--json"])
    assert second.exit_code == 0, second.output
    second_payload = json.loads(second.output)
    assert second_payload["backend"] == "hermes"
    assert second_payload["model"] == "anthropic/claude-sonnet-4.6"
    run = store.get_run(second_payload["run_id"])
    assert run.execution_context["backend_policy"] == "hermes"
    assert run.execution_context["model"] == "anthropic/claude-sonnet-4.6"


def test_cli_chat_backend_switch_appends_handoff_marker_and_drops_model(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    _trust_cwd_workspace(tmp_path / "state.db")
    runner = CliRunner()

    first = runner.invoke(
        app,
        ["chat", "-m", "First turn", "--dry", "--backend", "claude", "--model", "claude-opus-4-8", "--json"],
    )
    payload = json.loads(first.output)
    session_id = payload["session_id"]

    switched = runner.invoke(
        app, ["chat", "-m", "Switch turn", "--dry", "--session-id", session_id, "--backend", "codex", "--json"]
    )
    assert switched.exit_code == 0, switched.output
    switched_payload = json.loads(switched.output)
    assert switched_payload["backend"] == "codex"
    assert "model" not in switched_payload  # selection does not cross the switch

    store = StateStore(tmp_path / "state.db")
    session = store.get_chat_session(session_id)
    markers = [m for m in session.messages if m.role == "system" and "runtime switched" in m.content]
    assert len(markers) == 1 and "claude → codex" in markers[0].content
    assert store.get_chat_runtime(session_id) == {"backend": "codex"}


def test_cli_shell_model_command_sets_clears_and_backend_switch_drops(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell_config.json"))
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["shell", "--backend", "claude", "--repo", str(tmp_path)],
        input="/model\n/model claude-haiku-4-5\n/backend codex\n/model\n/model gpt-5.2-codex\n/model clear\n/exit\n",
    )

    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert "model=(backend default)" in lines  # initial show
    assert "model=claude-haiku-4-5" in lines
    assert "model=(cleared: backend switched)" in lines
    assert "model=gpt-5.2-codex" in lines
    assert lines.count("model=(backend default)") >= 2  # show-after-switch + explicit clear


def test_cli_shell_passes_model_to_turns(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell_config.json"))
    seen: dict = {}

    def fake_chat_turn(**kwargs):
        seen["delivery_model"] = kwargs["model"]
        seen["delivery_backend"] = kwargs["backend"]
        return {"session_id": "chat_x", "run_id": "run_x", "status": "completed", "chain_verdict": "CHAIN_OK"}

    def fake_direct_turn(**kwargs):
        seen["chat_model"] = kwargs["model"]
        return {"intent": "chat", "backend": kwargs["backend"], "status": "completed", "response": "hi"}

    monkeypatch.setattr(cli_module, "_execute_chat_turn", fake_chat_turn)
    monkeypatch.setattr(cli_module, "_execute_direct_chat_turn", fake_direct_turn)
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["shell", "--backend", "codex", "--model", "gpt-5.2-codex", "--repo", str(tmp_path)],
        input="/ask hello\n/deliver build it\n/exit\n",
    )

    assert result.exit_code == 0, result.output
    assert seen["chat_model"] == "gpt-5.2-codex"
    assert seen["delivery_model"] == "gpt-5.2-codex"
    assert seen["delivery_backend"] == "codex"


def test_cli_shell_adopts_sticky_runtime_when_resuming_session(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell_config.json"))
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Resumable chat")
    store.set_chat_runtime(session.session_id, backend="hermes", model="anthropic/claude-sonnet-4.6")
    runner = CliRunner()

    result = runner.invoke(
        app,
        ["shell", "--session-id", session.session_id, "--repo", str(tmp_path)],
        input="/model\n/exit\n",
    )

    assert result.exit_code == 0, result.output
    assert "model=anthropic/claude-sonnet-4.6" in result.output


def test_cli_chat_replays_transcript_context_into_followup_goal(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    _trust_cwd_workspace(tmp_path / "state.db")
    runner = CliRunner()

    first = runner.invoke(app, ["chat", "-m", "Design the gateway flow", "--dry", "--backend", "claude", "--json"])
    payload = json.loads(first.output)
    session_id = payload["session_id"]

    # Backend switch: the new runtime must receive the prior turns + handoff marker
    # through the goal description — the handoff note's claim is now real, not cosmetic.
    second = runner.invoke(
        app, ["chat", "-m", "Now implement it", "--dry", "--session-id", session_id, "--backend", "codex", "--json"]
    )
    assert second.exit_code == 0, second.output
    second_payload = json.loads(second.output)

    store = StateStore(tmp_path / "state.db")
    run = store.get_run(second_payload["run_id"])
    goal = store.get_goal(run.goal_id)
    assert goal.description.startswith("Now implement it")
    assert "Design the gateway flow" in goal.description  # prior turn replayed
    assert "runtime switched: claude → codex" in goal.description  # handoff marker replayed


def test_cli_reconcile_all_sweeps_stale_executing_runs(tmp_path, monkeypatch):
    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    store = StateStore(state_path)
    goal = store.create_goal(GoalSpec(title="Ghost", description="stale running claim"))
    session = store.create_run(goal.goal_id, dry_run=False)
    session.status = "queued"
    store.save_run(session)
    session.status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)

    runner = CliRunner()
    result = runner.invoke(app, ["reconcile", "--all"])

    assert result.exit_code == 0, result.output
    assert "reconciled=1" in result.output
    assert StateStore(state_path).get_run(session.run_id).status in {"queued", "failed"}


def test_format_token_count_compacts_like_web():
    from superclaw.cli import _format_token_count

    assert _format_token_count(0) == "0"
    assert _format_token_count(999) == "999"
    assert _format_token_count(1000) == "1K"
    assert _format_token_count(4391) == "4.4K"
    assert _format_token_count(35710) == "35.7K"
    assert _format_token_count(1_500_000) == "1.5M"


def test_shell_turn_meter_line_matches_web_field_coverage():
    # Zero-divergence with the web formatUsageMeter: the SAME provider-native key
    # aliases must be counted on both surfaces. Claude-native keys...
    from superclaw.cli import _shell_turn_meter_line

    claude = {
        "input_tokens": 4391,
        "output_tokens": 439,
        "cache_read_input_tokens": 35710,
        "cache_creation_input_tokens": 9019,
    }
    assert _shell_turn_meter_line(claude, None) == (
        "turn_meter in:4.4K out:439 cache_read:35.7K cache_write:9K total:49.6K"
    )
    # ...and codex/openai-style aliases must collapse to the same fields (previously
    # the CLI hardcoded only the four canonical keys and dropped these → divergence).
    openai = {"prompt_tokens": 10, "completion_tokens": 3, "cached_input_tokens": 2}
    assert _shell_turn_meter_line(openai, None) == "turn_meter in:10 out:3 cache_read:2 total:15"


def test_shell_turn_meter_line_drops_non_finite_and_negative_tokens():
    from superclaw.cli import _shell_turn_meter_line

    bad = {
        "input_tokens": float("nan"),
        "output_tokens": float("inf"),
        "cache_read_input_tokens": -5,
        "cache_creation_input_tokens": True,  # bool is not a token count
    }
    # Every field is invalid → no token parts; with no timer either, the whole line
    # is suppressed (None) rather than emitting a bogus "turn_meter".
    assert _shell_turn_meter_line(bad, None) is None
    # A lone valid field still renders; the invalid ones are dropped.
    assert _shell_turn_meter_line({**bad, "input_tokens": 12}, None) == "turn_meter in:12"


def test_shell_turn_meter_elapsed_matches_web_rounding():
    from superclaw.cli import _shell_turn_meter_line, _format_elapsed

    # sub-10s keeps one decimal; 10–60s rounds half-up; minute path derives from a
    # single rounded total-seconds value so it never carries to ":60".
    assert _format_elapsed(8_400) == "8.4s"
    assert _format_elapsed(15_500) == "16s"      # half-up, matching JS Math.round(15.5)
    assert _format_elapsed(95_000) == "1m35s"
    assert _format_elapsed(119_600) == "2m0s"    # not "1m60s"
    assert _format_elapsed(59_600) == "1m0s"     # promotes, not "60s"
    # token usage + elapsed compose into one line.
    assert _shell_turn_meter_line({"input_tokens": 12}, 12_300) == "turn_meter in:12 elapsed=12s"
