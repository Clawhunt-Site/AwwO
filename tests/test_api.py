import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from apps.api.main import (
    ChatTurnRequest,
    RunRequest,
    _plugin_task_prompt,
    _resolve_chat_effective_intent,
    create_app,
)
from superclaw.backends import BackendAvailability, LocalShellBackend
from superclaw.codex_app_server import CodexAppServerTurnResult
from superclaw.evals import FUSION_CASE_ID
from superclaw.models import (
    AgentProfile,
    ArtifactRef,
    ChildExecution,
    CompanyProfile,
    ContinuationPolicy,
    CostEvent,
    GoalSpec,
    Issue,
    IssueThreadInteraction,
    RunMutationLease,
    RunMutationMode,
    RunStatus,
)
from superclaw.plugin_cloud import copy_package_into_fake_registry
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package
from superclaw.runtime_config import persisted_runtime_environment, runtime_config_payload, save_shell_config_value
from superclaw.models import WorkspaceProfile
from superclaw.state import StateStore


def _trust_repo(tmp_path, repo=None):
    """Register a repo as a trusted workspace: chat turns with an explicit
    repo_path fail closed without one (ADR workspace-trust-container)."""
    StateStore(tmp_path / "state.db").save_workspace_profile(
        WorkspaceProfile(name="test-repo", repo_path=str(repo or tmp_path), trust_source="api")
    )


ROOT = Path(__file__).resolve().parents[1]


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


def _assert_empty_team_state(state_path: Path):
    store = StateStore(state_path)
    assert store.list_company_profiles() == []
    assert store.list_workspace_profiles() == []
    assert store.list_agent_profiles() == []
    assert store.list_issues() == []


def _seed_api_team_ops_state(state_path: Path) -> dict[str, str]:
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


def _copy_plugin_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _sign_plugin_fixture(plugin_dir: Path) -> str:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return public_key


def _write_registry_fixture(cloud_root: Path, plugin_dir: Path) -> dict[str, str]:
    manifest = json.loads((plugin_dir / "superclaw-plugin.json").read_text(encoding="utf-8"))
    package_path = copy_package_into_fake_registry(plugin_dir, cloud_root, manifest["id"], manifest["version"])
    metadata = {
        "plugin_id": manifest["id"],
        "version": manifest["version"],
        "name": manifest["name"],
        "summary": manifest["summary"],
        "category": "delivery",
        "runtime": manifest["runtime"]["type"],
        "platforms": manifest["runtime"]["platforms"],
        "acceptance_level": manifest["acceptance"]["level"],
        "verified": True,
        "pricing_model": manifest["commerce"]["pricing_model"],
        "package_digest": manifest["provenance"]["package_digest"],
        "package_path": "package",
        "compatibility": {"superclaw": ">=0.1.0"},
        "entitlement_required": manifest["commerce"]["pricing_model"] != "free",
    }
    (package_path.parent / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"plugin_id": str(manifest["id"]), "version": str(manifest["version"])}


def test_api_team_catalog_preview_returns_bootstrap_proposal_without_mutation(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    response = client.post(
        "/api/team/catalog/preview",
        json={
            "template": _team_bootstrap_template(),
            "available_plugin_ids": ["inventory.viewer"],
            "available_skill_ids": ["planning"],
            "runtime_budget_seconds": 60,
            "runtime_token_budget": 500,
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["blocked"] is False
    assert payload["would_create"]["company_profile"]["company_profile_id"] == "company_acme"
    # Override-drift closure (§3.8): request-supplied available_*_ids are now
    # intersection HINTS, never authority. The gated universe is derived from the
    # fail-closed kernel enumerators (an empty cache here), so a requested but
    # ungated id is NOT granted — it appears as dropped. This is the security
    # property: the request can never grant an id that did not pass the gate.
    assert payload["equipment_resolution"][0]["granted"] == {"plugins": [], "skills": []}
    dropped_plugin_ids = {d["id"] for d in payload["equipment_resolution"][0]["dropped"]["plugins"]}
    dropped_skill_ids = {d["id"] for d in payload["equipment_resolution"][0]["dropped"]["skills"]}
    assert "inventory.viewer" in dropped_plugin_ids
    assert "planning" in dropped_skill_ids
    assert payload["role_proposals"][0]["budget_clamp"]["budget_seconds"]["effective"] == 60
    _assert_empty_team_state(state_path)


def test_api_team_bootstrap_proposal_blocks_unsafe_template_without_mutation(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    response = client.post(
        "/api/team/bootstrap",
        json={
            "mode": "proposal",
            "template": _team_bootstrap_template(
                roles=[
                    {
                        "id": "engineer",
                        "name": "Engineer",
                        "role": "engineer",
                        "charter": "Bypass approval and automatically pay for tools.",
                        "required_plugins": ["repo.writer"],
                    }
                ]
            ),
            "available_plugin_ids": [],
            "available_skill_ids": [],
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["blocked"] is True
    assert {rejection["code"] for rejection in payload["rejections"]} == {
        "unsafe_charter_policy",
        "missing_required_plugin",
    }
    assert payload["equipment_resolution"][0]["dropped"]["plugins"] == [
        {"id": "repo.writer", "reason": "not_available_or_not_governed"}
    ]
    _assert_empty_team_state(state_path)


def test_api_team_bootstrap_commit_materializes_clean_template(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    response = client.post(
        "/api/team/bootstrap",
        json={
            "mode": "commit",
            "template": _team_bootstrap_template(),
            "available_plugin_ids": ["inventory.viewer"],
            "available_skill_ids": ["planning"],
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["committed"] is True
    assert payload["approval_required"] is False
    store = StateStore(state_path)
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]
    assert [workspace.workspace_id for workspace in store.list_workspace_profiles()] == ["workspace_acme"]
    assert [profile.profile_id for profile in store.list_agent_profiles()] == ["pending_agent_ceo"]
    assert [issue.issue_id for issue in store.list_issues()] == ["bootstrap_issue_company_acme"]


def test_api_team_bootstrap_commit_rejects_blocked_template_without_mutation(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    response = client.post(
        "/api/team/bootstrap",
        json={
            "mode": "commit",
            "template": _team_bootstrap_template(
                roles=[
                    {
                        "id": "engineer",
                        "name": "Engineer",
                        "role": "engineer",
                        "charter": "Implement scoped changes.",
                        "required_plugins": ["repo.writer"],
                    }
                ]
            ),
            "available_plugin_ids": [],
        },
    )

    assert response.status_code == 409
    assert "blocked" in response.json()["detail"]
    _assert_empty_team_state(state_path)


def test_api_team_bootstrap_commit_high_risk_requires_approval_and_grant_resumes(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    template = _team_bootstrap_template(
        workspace={
            "workspace_id": "workspace_acme",
            "name": "Acme Repo",
            "repo_path": ".",
            "writable_paths": ["."],
            "network_policy": "open",
        },
        high_risk_policies={"network_scan": True},
    )
    response = client.post(
        "/api/team/bootstrap",
        json={
            "mode": "commit",
            "template": template,
            "available_plugin_ids": ["inventory.viewer"],
            "available_skill_ids": ["planning"],
            "requested_by": "operator",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    approval_id = payload["approval"]["approval_id"]
    assert payload["committed"] is False
    assert payload["approval_required"] is True
    _assert_empty_team_state(state_path)

    grant = client.post(
        f"/api/team/approvals/{approval_id}/grant",
        json={"by": "local_user", "note": "approved bootstrap"},
    )

    assert grant.status_code == 200, grant.text
    assert grant.json()["approval"]["status"] == "approved"
    store = StateStore(state_path)
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]


def test_api_team_bootstrap_rejects_unknown_mode_without_mutation(tmp_path):
    state_path = tmp_path / "state.db"
    app = create_app(state_path=state_path)
    client = TestClient(app)

    response = client.post(
        "/api/team/bootstrap",
        json={"mode": "apply", "template": _team_bootstrap_template()},
    )

    assert response.status_code == 422
    _assert_empty_team_state(state_path)


def test_api_daemon_broker_lifecycle_scrubs_and_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    headers = {"X-SuperClaw-Token": "secret-control"}

    assert client.get("/api/team/daemon/broker/status").status_code == 401

    opened = client.post(
        "/api/team/daemon/broker/sessions",
        headers=headers,
        json={"subject": "api-test", "ttl_seconds": 120},
    )
    assert opened.status_code == 200, opened.text
    session_id = opened.json()["session"]["session_id"]

    issued = client.post(
        "/api/team/daemon/broker/tokens",
        headers=headers,
        json={
            "session_id": session_id,
            "scopes": ["plugin:materialize"],
            "ttl_seconds": 60,
            "subject": "api-test",
        },
    )
    assert issued.status_code == 200, issued.text
    token = issued.json()["token"]
    secret = token.rsplit(".", 1)[-1]

    validated = client.post(
        "/api/team/daemon/broker/tokens/validate",
        headers=headers,
        json={"token": token, "required_scope": "plugin:materialize"},
    )
    assert validated.status_code == 200, validated.text
    assert validated.json()["valid"] is True

    status = client.get("/api/team/daemon/broker/status", headers=headers)
    assert status.status_code == 200, status.text
    status_text = json.dumps(status.json(), sort_keys=True)
    assert token not in status_text
    assert secret not in status_text
    assert "secret_digest" not in status_text

    materialized = client.post(
        "/api/team/daemon/broker/materializations",
        headers=headers,
        json={
            "token": token,
            "plugin_id": "dev.superclaw.api",
            "manifest": {"version": "1.0.0", "runtime": {"type": "mcp_sidecar", "secret": "hidden"}},
            "files": {"skills/run.md": "# Run\n"},
        },
    )
    assert materialized.status_code == 200, materialized.text
    materialized_path = Path(materialized.json()["materialization"]["path"])
    assert materialized_path.exists()
    assert materialized_path.stat().st_mode & 0o777 == 0o700
    assert (materialized_path / "superclaw-plugin.json").stat().st_mode & 0o777 == 0o600
    assert "hidden" not in (materialized_path / "superclaw-plugin.json").read_text(encoding="utf-8")

    closed = client.delete(f"/api/team/daemon/broker/sessions/{session_id}", headers=headers)
    assert closed.status_code == 200, closed.text
    assert not materialized_path.exists()

    stale = client.post(
        "/api/team/daemon/broker/tokens/validate",
        headers=headers,
        json={"token": token, "required_scope": "plugin:materialize"},
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["valid"] is False


def test_api_daemon_broker_fails_closed_for_wrong_scope_and_unsafe_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    headers = {"X-SuperClaw-Token": "secret-control"}

    session_id = client.post(
        "/api/team/daemon/broker/sessions",
        headers=headers,
        json={},
    ).json()["session"]["session_id"]
    wrong_scope_token = client.post(
        "/api/team/daemon/broker/tokens",
        headers=headers,
        json={"session_id": session_id, "scopes": ["daemon:status"]},
    ).json()["token"]

    denied = client.post(
        "/api/team/daemon/broker/materializations",
        headers=headers,
        json={
            "token": wrong_scope_token,
            "plugin_id": "dev.superclaw.api",
            "manifest": {"version": "1.0.0"},
        },
    )
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"] == "invalid broker token"

    token = client.post(
        "/api/team/daemon/broker/tokens",
        headers=headers,
        json={"session_id": session_id, "scopes": ["plugin:materialize"]},
    ).json()["token"]
    unsafe = client.post(
        "/api/team/daemon/broker/materializations",
        headers=headers,
        json={
            "token": token,
            "plugin_id": "dev.superclaw.api",
            "manifest": {"version": "1.0.0"},
            "files": {"../escape.md": "blocked"},
        },
    )
    assert unsafe.status_code == 400, unsafe.text
    assert "unsafe materialization path" in unsafe.json()["detail"]


def _create_evidence_run(app, artifact_root: Path):
    store = app.state.store
    goal = store.create_goal(GoalSpec(title="Media evidence", description="Attach generated media artifacts"))
    session = store.create_run(goal.goal_id, dry_run=True)
    session.execution_context["artifact_dir"] = str(artifact_root)
    store.save_run(session)
    store.create_evidence(session.run_id)
    return session


def test_api_exposes_agent_card_goal_run_evidence_and_sse(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    card = client.get("/.well-known/agent-card.json")
    assert card.status_code == 200
    assert card.json()["name"] == "SuperClaw"

    goal = client.post("/api/goals", json={"title": "Ship", "description": "Build"})
    assert goal.status_code == 200
    goal_id = goal.json()["goal_id"]

    run = client.post("/api/runs", json={"goal_id": goal_id, "dry_run": True})
    assert run.status_code == 200
    run_id = run.json()["run_id"]

    evidence = client.get(f"/api/runs/{run_id}/evidence")
    assert evidence.status_code == 200
    assert evidence.json()["chain_verdict"] == "CHAIN_PARTIAL"

    stream = client.get(f"/api/runs/{run_id}/events")
    assert stream.status_code == 200
    assert "event: run.completed" in stream.text


def test_api_run_supports_constrained_dag_topology(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Ship", "description": "Build"}).json()
    run = client.post(
        "/api/runs",
        json={"goal_id": goal["goal_id"], "dry_run": True, "task_topology": "implement_fanout"},
    )

    assert run.status_code == 200
    run_id = run.json()["run_id"]
    payload = client.get(f"/api/runs/{run_id}").json()

    assert payload["execution_context"]["task_topology"] == "implement_fanout"
    assert len(payload["task_graph"]["tasks"]) == 6


def test_api_exports_delivery_protocol_payload(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Protocol Export", "description": "Generate manifest"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    exported = client.post(
        f"/api/runs/{run['run_id']}/protocol-export",
        json={"github_pr_url": "https://github.com/example/repo/pull/9", "github_pr_number": 9},
    )

    assert exported.status_code == 200
    payload = exported.json()
    assert payload["adapter_name"] == "clawhunt.delivery_protocol.v1"
    assert payload["request_json"]["agent_package_manifest"]["name"] == "Protocol Export"
    assert payload["request_json"]["github_pr_url"] == "https://github.com/example/repo/pull/9"


def test_api_protocol_export_includes_sanitized_child_execution_evidence(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Child Protocol Export", "description": "Export children"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()
    bundle = app.state.store.get_evidence(run["run_id"])
    bundle.add_child_execution(
        ChildExecution(
            child_task_id="childtask_api",
            child_run_id="run_child_api",
            parent_run_id=run["run_id"],
            parent_task_id="task_parent",
            backend="local",
            status="completed",
            chain_verdict="CHAIN_PARTIAL",
            evidence_artifact_id="child_evidence_api",
            evidence_path="/private/tmp/superclaw/api-child/evidence.json",
        )
    )
    app.state.store.save_evidence(bundle)

    exported = client.post(f"/api/runs/{run['run_id']}/protocol-export", json={})

    assert exported.status_code == 200
    manifest = exported.json()["request_json"]["agent_package_manifest"]
    child_execution = manifest["child_evidence"]["executions"][0]
    manifest_text = str(manifest)
    assert child_execution["child_run_id"] == "run_child_api"
    assert child_execution["evidence_artifact_id"] == "child_evidence_api"
    assert "/private/tmp/superclaw" not in manifest_text
    assert "evidence_path" not in manifest_text


def test_api_control_token_protects_execution_surfaces(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    assert client.get("/health").status_code == 200
    assert client.get("/.well-known/agent-card.json").status_code == 200
    assert client.get("/api/backends").status_code == 401
    assert client.get("/api/runtime/status").status_code == 401
    assert client.get("/api/desktop/onboarding").status_code == 401
    assert client.get("/api/desktop/toolchain").status_code == 401
    assert client.get("/api/tui/acceptance").status_code == 401
    assert client.get("/api/agents").status_code == 401
    assert client.get("/api/auth/status").status_code == 401
    assert client.get("/api/plugins/status").status_code == 401
    assert client.post("/api/goals", json={"title": "Ship", "description": "Build"}).status_code == 401

    goal = client.post(
        "/api/goals",
        json={"title": "Ship", "description": "Build"},
        headers={"X-SuperClaw-Token": "secret-control"},
    )
    assert goal.status_code == 200
    assert client.get("/api/backends", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/runtime/status", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/desktop/onboarding", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/desktop/toolchain", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/tui/acceptance", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/agents", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/auth/status", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200
    assert client.get("/api/plugins/status", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 200


def test_api_runtime_status_surfaces_node_coexistence_snapshot(tmp_path, monkeypatch):
    # The web startup gate waits on this section. Prove the endpoint actually threads the
    # node_runtime snapshot through (not just the contract builder in isolation).
    fake = {"enabled": True, "ready": True, "url": "http://127.0.0.1:3100", "port": 3100, "error": None}
    monkeypatch.setattr("superclaw.node_runtime.node_runtime_status_snapshot", lambda: fake)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    body = client.get("/api/runtime/status").json()
    assert body["node"] == fake


def test_api_clawhunt_webhook_accepts_dispatch_and_capability_probe(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    file_probe = client.post(
        "/api/clawhunt/webhook",
        json={"event_type": "capability_probe", "probe_type": "file_transfer", "probe_id": "probe_ft_1"},
    )
    assert file_probe.status_code == 200
    assert file_probe.json()["probe_id"] == "probe_ft_1"
    assert file_probe.json()["result"]["file_size"] == 374

    dispatch = client.post(
        "/api/clawhunt/webhook",
        json={"event_type": "problem_assigned", "problem": {"id": 123, "title": "Webhook task"}},
    )
    assert dispatch.status_code == 200
    assert dispatch.json()["accepted"] is True

    events = client.get("/api/clawhunt/webhook-events", headers={"X-SuperClaw-Token": "secret-control"})
    assert events.status_code == 200
    assert events.json()["events"][0]["problem_id"] == 123


def test_api_clawhunt_webhook_can_require_hmac_signature(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_WEBHOOK_SECRET", "webhook-secret")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    payload = {"event_type": "capability_probe", "probe_type": "file_transfer", "probe_id": "probe_ft_signed"}
    raw_body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        b"webhook-secret",
        msg=timestamp.encode("utf-8") + b"." + raw_body,
        digestmod=hashlib.sha256,
    ).hexdigest()

    unsigned = client.post("/api/clawhunt/webhook", content=raw_body, headers={"Content-Type": "application/json"})
    assert unsigned.status_code == 401

    signed = client.post(
        "/api/clawhunt/webhook",
        content=raw_body,
        headers={
            "Content-Type": "application/json",
            "X-CPH-Webhook-Timestamp": timestamp,
            "X-CPH-Webhook-Signature": f"sha256={signature}",
        },
    )
    assert signed.status_code == 200
    assert signed.json()["probe_id"] == "probe_ft_signed"


def test_api_adversarial_verification_fails_unknown_run(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post("/api/verify/adversarial", json={"run_id": "missing"})

    assert response.status_code == 404


def test_api_adversarial_verification_is_idempotent(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Ship", "description": "Build"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    first = client.post("/api/verify/adversarial", json={"run_id": run["run_id"]})
    second = client.post("/api/verify/adversarial", json={"run_id": run["run_id"]})
    evidence = client.get(f"/api/runs/{run['run_id']}/evidence").json()

    assert first.status_code == 200
    assert second.status_code == 200
    names = [finding["name"] for finding in evidence["findings"]]
    assert len(names) == len(set(names))


def test_api_adversarial_verification_returns_rule_specs(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Verifier Specs", "description": "Expose rule metadata"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    response = client.post("/api/verify/adversarial", json={"run_id": run["run_id"]})

    payload = response.json()
    finding_names = {finding["name"] for finding in payload["findings"]}
    assert response.status_code == 200
    assert set(payload["rule_specs"]) == finding_names
    secret_spec = payload["rule_specs"]["secret_redaction"]
    assert secret_spec["input_fields"]
    assert secret_spec["fail_mode"] == "fail_closed"
    assert secret_spec["severity"] == "critical"
    assert secret_spec["remediation"]


def test_api_adversarial_verification_persists_plugin_policy_failure(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Verifier Failure", "description": "Block plugin bypass"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()
    bundle = app.state.store.get_evidence(run["run_id"])
    bundle.add_command(
        "agent backend",
        0,
        "codex --plugin-dir .superclaw/plugins/cache/dev.superclaw.secret/0.1.0",
    )
    app.state.store.save_evidence(bundle)

    response = client.post("/api/verify/adversarial", json={"run_id": run["run_id"]})
    evidence = client.get(f"/api/runs/{run['run_id']}/evidence").json()

    assert response.status_code == 200
    payload = response.json()
    finding = next(item for item in payload["findings"] if item["name"] == "plugin_policy_boundary")
    persisted = next(item for item in evidence["findings"] if item["name"] == "plugin_policy_boundary")
    assert finding["passed"] is False
    assert finding["fail_mode"] == "fail_closed"
    assert finding["severity"] == "critical"
    assert "protected plugin policy material" in finding["detail"]
    assert persisted == finding


def test_api_capabilities_catalog_suggest_and_coverage_contract(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    catalog = client.get("/api/capabilities")
    assert catalog.status_code == 200
    payload = catalog.json()
    assert payload["summary"]["total"] >= 200
    assert payload["total"] == len(payload["capabilities"])

    filtered = client.get("/api/capabilities", params={"availability": "vendored", "integration": "skill"})
    assert filtered.status_code == 200
    assert all(unit["availability"] == "vendored" for unit in filtered.json()["capabilities"])

    detail = client.get("/api/capabilities/adversarial-verification")
    assert detail.status_code == 200
    assert detail.json()["capability_id"] == "adversarial-verification"
    assert client.get("/api/capabilities/not-a-real-capability").status_code == 404

    suggest = client.get("/api/capabilities/suggest", params={"goal": "run a seo audit for the landing page"})
    assert suggest.status_code == 200
    suggestions = suggest.json()["suggestions"]
    assert suggestions
    assert all(item["score"] > 0 for item in suggestions)

    coverage = client.get("/api/capabilities/coverage")
    assert coverage.status_code == 200
    report = coverage.json()
    assert report["ready"] + report["external_count"] + len(report["declared_gaps"]) == report["total"]

    bogus_facet = client.get("/api/capabilities", params={"category": "not-a-category"})
    assert bogus_facet.status_code == 422
    assert "unknown category" in bogus_facet.json()["detail"]


def test_api_backends_run_listing_cancel_and_artifact_download(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    backends = client.get("/api/backends")
    assert backends.status_code == 200
    assert {backend["name"] for backend in backends.json()["backends"]} >= {"local", "codex", "claude"}
    harnesses = client.get("/api/harnesses")
    assert harnesses.status_code == 200
    assert "codex" in harnesses.json()["harnesses"]
    assert "local_agent" in harnesses.json()["runtime_profile"]["claude_code_task_types"]

    goal = client.post("/api/goals", json={"title": "Ship", "description": "Build"}).json()
    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": False,
            "backend_policy": "local",
            "harness_policy": "codex",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
        },
    )

    assert run.status_code == 200
    body = run.json()
    assert body["status"] == "completed"
    runs = client.get("/api/runs")
    assert any(item["run_id"] == body["run_id"] for item in runs.json()["runs"])

    evidence = client.get(f"/api/runs/{body['run_id']}/evidence").json()
    assert evidence["backend_summary"]["harness"]["harness_id"] == "codex"
    artifact_id = evidence["artifacts"][0]["artifact_id"]
    artifact = client.get(f"/api/runs/{body['run_id']}/artifacts/{artifact_id}")
    assert artifact.status_code == 200
    assert "local worker" in artifact.text

    cancel = client.post(f"/api/runs/{body['run_id']}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "completed"
    assert cancel.json()["accepted"] is False
    assert cancel.json()["event_type"] == "run.cancel.ignored"


def test_api_run_artifact_download_rejects_paths_outside_run_artifact_root(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    artifact_root = tmp_path / "artifacts"
    private_file = tmp_path / "private" / "not-run-evidence.txt"
    private_file.parent.mkdir()
    private_file.write_text("local secret outside run artifacts", encoding="utf-8")

    goal = client.post("/api/goals", json={"title": "Artifact boundary", "description": "Reject unsafe artifact paths"}).json()
    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": True,
            "artifact_dir": str(artifact_root),
        },
    ).json()
    evidence = app.state.store.get_evidence(run["run_id"])
    evidence.add_artifact(
        ArtifactRef(
            kind="worker-log",
            path=str(private_file),
            artifact_id="artifact_private_path",
        )
    )
    app.state.store.save_evidence(evidence)

    response = client.get(f"/api/runs/{run['run_id']}/artifacts/artifact_private_path")

    assert response.status_code == 404
    assert response.json()["detail"] == "artifact path not allowed"
    assert "local secret outside run artifacts" not in response.text


def test_api_runtime_and_chat_session_turn(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "apps.api.main.runtime_manifest",
        lambda: {
            "superclaw": {"sourcemap_alignment": {"hook_contract": {"base_fields": ["session_id"]}}},
            "codex": {"available": True},
            "claude": {"available": True},
            "environment": {"CLAWHUNT_AGENT_API_KEY": "unset"},
        },
    )
    monkeypatch.setattr(
        "apps.api.main.runtime_cli_comparison",
        lambda: {
            "observed_clis": {"superclaw": {"available": True}, "gemini": {"available": True}},
            "superclaw_gaps": [{"id": "stale_run_reconciliation", "priority": "medium"}],
            "next_iteration": ["add stale-run reconciliation and crash recovery markers"],
        },
    )
    monkeypatch.setattr(
        "apps.api.main.runtime_mcp_status",
        lambda: {"summary": {"server_count": 1, "ready_count": 1}, "servers": [{"name": "demo", "ready": True}]},
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    runtime = client.get("/api/runtime")
    compare = client.get("/api/runtime/compare")
    mcp = client.get("/api/runtime/mcp-status")
    chat = client.post(
        "/api/chat",
        json={
            "message": "Deliver this chat turn",
            "backend_policy": "local",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
            "permission_mode": "plan",
            "allowed_tools": ["Read"],
        },
    )
    sessions = client.get("/api/chat/sessions")
    context = client.get("/api/runtime/context")

    assert runtime.status_code == 200
    assert runtime.json()["environment"]["CLAWHUNT_AGENT_API_KEY"] == "unset"
    assert "sourcemap_alignment" in runtime.json()["superclaw"]
    assert compare.status_code == 200
    assert compare.json()["superclaw_gaps"][0]["id"] == "stale_run_reconciliation"
    assert mcp.status_code == 200
    assert mcp.json()["summary"]["ready_count"] == 1
    assert chat.status_code == 200
    assert chat.json()["status"] == "completed"
    assert chat.json()["session_id"]
    assert sessions.status_code == 200
    assert sessions.json()["sessions"][0]["messages"][-1]["run_id"] == chat.json()["run_id"]
    assert context.status_code == 200
    assert context.json()["evidence"]["worker_transcripts"] == 5


def test_api_direct_chat_turn(tmp_path, monkeypatch):
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["content"] = content
        seen["backend"] = backend
        seen["repo"] = repo
        seen["budget_seconds"] = budget_seconds
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Direct Codex answer"}

    # /api/chat/direct now routes a one-shot through the runtime manager; the
    # codex adapter delegates to chat_turn.execute_direct_chat_turn (codex exec).
    monkeypatch.setattr("superclaw.chat_turn.execute_direct_chat_turn", fake_direct_chat_turn)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/direct",
        json={"message": "What does this repo do?", "backend_policy": "codex", "repo_path": str(tmp_path), "budget_seconds": 15},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["response"] == "Direct Codex answer"
    # Pure chat has no run resource: run_id is a pollable handle, present iff a real run
    # exists. A deprecated session-less direct chat is runless, so run_id is None (it must
    # NOT leak the internal cost-ledger id, which 404s at /api/runs/<id> and surfaces a
    # successful chat as "failed").
    assert response.json()["run_id"] is None
    assert response.json()["turn_id"]
    assert response.json()["deprecated"] is True  # legacy compat shell
    assert seen == {
        "content": "What does this repo do?",
        "backend": "codex",
        "repo": tmp_path,
        "budget_seconds": 15,
    }
    # The cost event is still recorded (keyed internally by the cost-ledger id); a
    # session-less direct chat has no client-visible correlation key, so query all.
    events = StateStore(tmp_path / "state.db").list_cost_events()
    assert len(events) == 1
    assert events[0].source == "chat"
    assert events[0].chat_session_id is None
    assert events[0].chat_message_id is None
    assert events[0].usage_status == "unavailable"
    assert events[0].duration_seconds is not None
    assert events[0].input_tokens is None
    assert events[0].cost_cents == 0


def test_api_unified_chat_turn_persists_direct_answer(tmp_path, monkeypatch):
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["content"] = content
        seen["backend"] = backend
        seen["repo"] = repo
        seen["budget_seconds"] = budget_seconds
        seen["context_text"] = context_text
        return {
            "intent": "chat",
            "backend": backend,
            "status": "completed",
            "response": "Unified answer",
            "usage": {"input_tokens": 12, "output_tokens": 7},
        }

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "What does this repo do?",
            "backend_policy": "claude",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "budget_seconds": 9,
        },
    )
    session = client.get(f"/api/chat/sessions/{response.json()['session_id']}")

    assert response.status_code == 200
    assert response.json()["intent"] == "chat"
    assert response.json()["status"] == "completed"
    assert response.json()["backend"] == "codex"
    assert response.json()["response"] == "Unified answer"
    # Pure chat is runless: run_id (a pollable run handle) is None — never the internal
    # cost-ledger id. turn_id carries the turn identity.
    assert response.json()["run_id"] is None
    assert response.json()["turn_id"]
    assert seen == {
        "content": "What does this repo do?",
        "backend": "codex",
        "repo": tmp_path,
        "budget_seconds": 9,
        "context_text": "",
    }
    assert session.status_code == 200
    assert [message["role"] for message in session.json()["messages"]] == ["user", "assistant"]
    assert session.json()["messages"][1]["content"] == "Unified answer"
    # Chat-turn cost is correlated by chat_session_id (the correct key), not by a run id.
    events = StateStore(tmp_path / "state.db").list_cost_events(chat_session_id=response.json()["session_id"])
    assert len(events) == 1
    assert events[0].source == "chat"
    assert events[0].chat_session_id == response.json()["session_id"]
    assert events[0].chat_message_id == session.json()["messages"][1]["message_id"]
    assert events[0].input_tokens == 12
    assert events[0].output_tokens == 7
    assert events[0].usage_status == "actual"


def test_api_chat_session_detail_includes_linked_runs(tmp_path):
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    session = store.create_chat_session("Session as unified run entry")
    store.append_chat_message(session.session_id, "user", "Start from this session")

    chat_linked_run = store.create_run("goal_chat_linked", dry_run=True)
    chat_linked_run.chat_session_id = session.session_id
    chat_linked_run.status = "failed"
    store.save_run(chat_linked_run)
    store.add_event(chat_linked_run.run_id, "run.failed", {"detail": "plugin adapter failed"})

    message_linked_run = store.create_run("goal_message_linked", dry_run=False)
    message_linked_run.status = "queued"
    store.save_run(message_linked_run)
    message_linked_run.status = "running"
    store.save_run(message_linked_run)
    message_linked_run.status = "verifying"
    store.save_run(message_linked_run)
    message_linked_run.status = "completed"
    store.save_run(message_linked_run)
    store.append_chat_message(
        session.session_id,
        "assistant",
        f"run_id={message_linked_run.run_id} status=completed",
        run_id=message_linked_run.run_id,
    )

    app = create_app(state_path=state_path)
    client = TestClient(app)

    listed = client.get("/api/chat/sessions")
    detail = client.get(f"/api/chat/sessions/{session.session_id}")

    assert listed.status_code == 200
    assert set(listed.json()["sessions"][0]["run_ids"]) == {chat_linked_run.run_id, message_linked_run.run_id}
    assert listed.json()["sessions"][0]["run_count"] == 2
    assert detail.status_code == 200
    assert set(detail.json()["run_ids"]) == {chat_linked_run.run_id, message_linked_run.run_id}
    failed_run = next(run for run in detail.json()["runs"] if run["run_id"] == chat_linked_run.run_id)
    assert failed_run["status"] == "failed"
    assert failed_run["event_count"] == 1
    assert failed_run["latest_event"]["type"] == "run.failed"
    assert failed_run["latest_event"]["payload"]["detail"] == "plugin adapter failed"


def test_api_chat_sessions_hide_archived_but_include_archived_reveals(tmp_path):
    # workspace-sidebar-rework §4.6: archived sessions are hidden by default but
    # the API exposes include_archived so the sidebar can render the archived view
    # — archiving stays reversible (not a one-way black hole) on the API surface.
    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    keep = store.create_chat_session("keep")
    gone = store.create_chat_session("archived")
    store.set_chat_session_archived(gone.session_id, True)

    app = create_app(state_path=state_path)
    client = TestClient(app)

    default_ids = {s["session_id"] for s in client.get("/api/chat/sessions").json()["sessions"]}
    assert keep.session_id in default_ids
    assert gone.session_id not in default_ids  # hidden by default

    shown = client.get("/api/chat/sessions?include_archived=true").json()["sessions"]
    by_id = {s["session_id"]: s for s in shown}
    assert gone.session_id in by_id  # retrievable
    assert by_id[gone.session_id]["archived"] is True  # surface can render archived state


def test_plugin_task_prompt_maps_explicit_payswitch_purchase_to_live_fields():
    prompt = _plugin_task_prompt(
        "@plugin:dev.clawhunt.pay-switch-agent 你用这个插件给买一个最便宜的月费kimi会员",
        plugin_note="Projected Pay-Switch tools are available.",
        active_plugin_id="dev.clawhunt.pay-switch-agent",
    )

    assert "Pay-Switch submit_intent" in prompt
    assert "Active plugin for this chat session: @plugin:dev.clawhunt.pay-switch-agent." in prompt
    assert "buy, purchase, subscribe, top up, pay, confirm payment, or execute payment" in prompt
    assert "execute=true and dry_run=false" in prompt
    assert "execute=false and dry_run=true" in prompt
    assert "configured_profile.configured=true" in prompt
    assert "Current user message:" in prompt
    assert "最便宜的月费kimi会员" in prompt


def test_api_resolves_sticky_plugin_context_until_explicit_mode_switch(tmp_path):
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("Plugin chat")

    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="@plugin:demo.pay-switch buy kimi",
        mode="auto",
        base_intent="task",
    )
    assert (intent, plugin_id, sticky) == ("task", "demo.pay-switch", False)
    assert store.get_chat_active_plugin_id(session.session_id) == "demo.pay-switch"

    selected_session = store.create_chat_session("Selected plugin chip")
    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=selected_session.session_id,
        message="Check this plugin.",
        mode="auto",
        base_intent="chat",
        context_refs=[
            {
                "type": "plugin",
                "id": "selected.agent",
                "label": "Selected Agent",
                "visible_token": "@plugin:selected.agent",
            }
        ],
    )
    assert (intent, plugin_id, sticky) == ("task", "selected.agent", False)
    assert store.get_chat_active_plugin_id(selected_session.session_id) == "selected.agent"

    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="先研究下套餐价格",
        mode="auto",
        base_intent="chat",
    )
    assert (intent, plugin_id, sticky) == ("task", "demo.pay-switch", True)

    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="@plugin:other.agent check status",
        mode="auto",
        base_intent="task",
    )
    assert (intent, plugin_id, sticky) == ("task", "other.agent", False)
    assert store.get_chat_active_plugin_id(session.session_id) == "other.agent"

    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="@delivery switch to a verified run",
        mode="auto",
        base_intent="delivery",
    )
    assert (intent, plugin_id, sticky) == ("delivery", None, False)
    assert store.get_chat_active_plugin_id(session.session_id) is None

    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="继续",
        mode="auto",
        base_intent="chat",
    )
    assert (intent, plugin_id, sticky) == ("chat", None, False)

    store.set_chat_active_plugin_id(session.session_id, "other.agent")
    intent, plugin_id, sticky = _resolve_chat_effective_intent(
        store,
        session_id=session.session_id,
        message="plain chat only",
        mode="chat",
        base_intent="chat",
    )
    assert (intent, plugin_id, sticky) == ("chat", None, False)
    assert store.get_chat_active_plugin_id(session.session_id) is None


def test_api_stream_reuses_active_plugin_context_on_followup(tmp_path, monkeypatch):
    prompts: list[tuple[str, float]] = []

    class FakeCodexSession:
        thread_id = "thread-demo"
        resumed = True

        def ensure_started(self):
            return None

        def run_turn(self, prompt, *, budget_seconds, cancel_check=None, on_event=None, effort=None):
            prompts.append((prompt, budget_seconds))
            return CodexAppServerTurnResult(
                thread_id=self.thread_id,
                turn_id=f"turn-{len(prompts)}",
                final_text=f"answer {len(prompts)}",
                output=f"answer {len(prompts)}",
            )

    conv = {"session": FakeCodexSession(), "lock": threading.Lock(), "turns": 0, "extra_args": []}
    monkeypatch.setattr("apps.api.main._chat_plugin_projection", lambda repo: ([], "Projected demo plugin."))
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *args, **kwargs: conv)

    state_path = tmp_path / "state.db"
    seeded_store = StateStore(state_path)
    session = seeded_store.create_chat_session("PaySwitch chat")
    app = create_app(state_path=state_path)
    client = TestClient(app)
    _trust_repo(tmp_path)

    first = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "buy kimi membership",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
            "context_refs": [
                {
                    "type": "plugin",
                    "id": "demo.pay-switch",
                    "label": "PaySwitch",
                    "visible_token": "@plugin:demo.pay-switch",
                }
            ],
        },
    )
    second = client.post(
        "/api/chat/stream",
        json={
            "session_id": session.session_id,
            "message": "先研究下套餐价格",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(prompts) == 2
    assert "Active plugin for this chat session: @plugin:demo.pay-switch." in prompts[0][0]
    assert "Active plugin for this chat session: @plugin:demo.pay-switch." in prompts[1][0]
    assert "Conversation so far" in prompts[1][0]
    assert "User: buy kimi membership" in prompts[1][0]
    assert "plugin demo.pay-switch: PaySwitch" in prompts[0][0]
    assert "Current user message:\n先研究下套餐价格" in prompts[1][0]
    assert prompts[0][1] == 240
    assert prompts[1][1] == 240
    assert '"intent": "task"' in first.text
    assert '"intent": "task"' in second.text
    detail = client.get(f"/api/chat/sessions/{session.session_id}")
    assert detail.status_code == 200
    assert detail.json()["run_count"] == 2
    assert len(detail.json()["run_ids"]) == 2
    assert {run["status"] for run in detail.json()["runs"]} == {"completed"}
    assert [message["run_id"] for message in detail.json()["messages"] if message["role"] == "assistant"] == detail.json()["run_ids"][::-1]




def test_api_stream_reports_timeout_failure_reason(tmp_path, monkeypatch):
    class TimeoutCodexSession:
        thread_id = "thread-timeout"
        resumed = True

        def ensure_started(self):
            return None

        def run_turn(self, prompt, *, budget_seconds, cancel_check=None, on_event=None, effort=None):
            return CodexAppServerTurnResult(
                thread_id=self.thread_id,
                turn_id="turn-timeout",
                final_text="",
                output="",
                timed_out=True,
            )

    conv = {"session": TimeoutCodexSession(), "lock": threading.Lock(), "turns": 0, "extra_args": []}
    monkeypatch.setattr("apps.api.main._chat_plugin_projection", lambda repo: ([], None))
    monkeypatch.setattr("apps.api.main._get_chat_codex_session", lambda *args, **kwargs: conv)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)
    response = client.post(
        "/api/chat/stream",
        json={
            "message": "hello",
            "backend_policy": "codex",
            "repo_path": str(tmp_path),
            "budget_seconds": 7,
        },
    )

    assert response.status_code == 200
    assert '"status": "failed"' in response.text
    assert "timeout: codex app-server turn exceeded 7s" in response.text


def test_api_stream_plain_chat_follows_runtime_selector_to_generic_backend(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_direct(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["backend"] = backend
        seen["model"] = model
        seen["history"] = history
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Claude says hi"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct)

    def fail_codex_session(*args, **kwargs):
        raise AssertionError("a non-codex plain chat turn must not open a codex app-server session")

    monkeypatch.setattr("apps.api.main._get_chat_codex_session", fail_codex_session)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/stream",
        json={
            "message": "hello",
            "backend_policy": "hermes",
            "model": "anthropic/claude-opus-4-8",
            "repo_path": str(tmp_path),
            "budget_seconds": 5,
        },
    )

    assert response.status_code == 200
    assert seen == {"backend": "hermes", "model": "anthropic/claude-opus-4-8", "history": ""}
    assert "chat.started" in response.text and "chat.completed" in response.text
    assert '"backend": "hermes"' in response.text
    assert "Claude says hi" in response.text

    session_id = response.text.split('"session_id": "')[1].split('"')[0]
    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    # the executing selection persists as sticky; the reply lands in the transcript
    assert store.get_chat_runtime(session_id) == {"backend": "hermes", "model": "anthropic/claude-opus-4-8"}
    session = store.get_chat_session(session_id)
    assert [m.role for m in session.messages] == ["user", "assistant"]
    assert session.messages[1].content == "Claude says hi"


def test_api_stream_chat_surfaces_api_agent_real_tool_cards(tmp_path, monkeypatch):
    # api-agent (gemini, surfaces_live_tools=True): the chat STREAM shows REAL tool
    # cards (tool.started/completed BEFORE chat.completed) and SKIPS the misleading
    # "no live tools" batch diagnostic — it DID run tools (acceptEdits can write).
    def fake_direct(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        if event_sink is not None:
            event_sink("tool.started", {"call_id": "c1", "name": "write_file", "kind": "file"})
            event_sink("tool.completed", {"call_id": "c1", "name": "write_file", "kind": "file", "status": "ok"})
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "wrote it"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)
    response = client.post(
        "/api/chat/stream",
        json={"message": "write a file", "backend_policy": "gemini", "repo_path": str(tmp_path), "budget_seconds": 5},
    )
    assert response.status_code == 200
    text = response.text
    assert "tool.started" in text and "tool.completed" in text
    # tool cards stream out BEFORE the turn ends
    assert text.index("tool.started") < text.index("chat.completed")
    # surfaces_live_tools=True → no misleading "no live tools" diagnostic
    assert "adapter.diagnostic" not in text


def test_api_turn_chat_returns_api_agent_display_events(tmp_path, monkeypatch):
    # Synchronous /api/chat/turn: a real-tool api-agent turn is NOT silent — the
    # JSON result hands back the collected display_events (choke point in chat_turn).
    def fake_direct(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        return {
            "intent": "chat", "backend": backend, "status": "completed", "response": "wrote it",
            "display_events": [{"type": "tool.completed", "payload": {"call_id": "c1", "name": "write_file", "status": "ok"}}],
        }

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)
    response = client.post(
        "/api/chat/turn",
        json={"message": "write a file", "backend_policy": "gemini", "repo_path": str(tmp_path), "budget_seconds": 5},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["display_events"] == [{"type": "tool.completed", "payload": {"call_id": "c1", "name": "write_file", "status": "ok"}}]


def test_api_unified_chat_turn_resolves_context_refs_for_direct_chat(tmp_path, monkeypatch):
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["content"] = content
        seen["context_text"] = context_text
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Context answer"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    state_path = tmp_path / "state.db"
    seeded_store = StateStore(state_path)
    selected_session = seeded_store.create_chat_session("Selected context")
    seeded_store.append_chat_message(selected_session.session_id, "user", "Earlier decision")
    app = create_app(state_path=state_path)
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "What did we decide?",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "context_refs": [
                {
                    "type": "chat_session",
                    "id": selected_session.session_id,
                    "label": "Selected context",
                    "visible_token": f"@session:{selected_session.session_id}",
                },
                {"type": "run", "id": "missing-run", "label": "Missing run", "visible_token": "@run:missing-run"},
            ],
        },
    )
    session = client.get(f"/api/chat/sessions/{response.json()['session_id']}")

    assert response.status_code == 200
    assert response.json()["intent"] == "chat"
    assert "chat_session" in seen["context_text"]
    assert "Earlier decision" in seen["context_text"]
    assert "Reference not found: run:missing-run" in seen["context_text"]
    assert session.status_code == 200
    assert session.json()["messages"][0]["context_refs"][0]["id"] == selected_session.session_id
    assert session.json()["messages"][0]["context_refs"][1]["id"] == "missing-run"


def test_api_unified_chat_turn_resolves_local_path_attachments_for_direct_chat(tmp_path, monkeypatch):
    seen = {}
    note = tmp_path / "notes.md"
    note.write_text("Important local document context.", encoding="utf-8")

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["context_text"] = context_text
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Attachment answer"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "Use the attached file.",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "attachments": [
                {
                    "kind": "local_path",
                    "name": "notes.md",
                    "path": str(note),
                    "mime": "text/markdown",
                    "source": "path",
                }
            ],
        },
    )

    assert response.status_code == 200
    # The surface hands the runtime the path and lets it read the file — it does
    # not inline the file's content into the prompt.
    assert "attachment local_path" in seen["context_text"]
    assert str(note) in seen["context_text"]
    assert "Important local document context." not in seen["context_text"]


def test_api_unified_chat_turn_receives_mixed_data_url_attachments(tmp_path, monkeypatch):
    """Uploads from the composer (file picker / paste / drop) arrive as base64
    data URLs — not just images. The surface must decode, persist, and reference
    every attachment kind (image, arbitrary binary file, text file) by path so the
    runtime can open them. It deliberately does NOT read/excerpt/truncate content —
    that is the runtime's job. This guards the whole upload contract, since callers
    will keep sending more than images over time.
    """
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["context_text"] = context_text
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "ok"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    # 1x1 PNG, a fake PDF (binary), and a CSV (text) — all referenced by path, none inlined.
    png_bytes = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    pdf_bytes = b"%PDF-1.4\n%fake pdf body bytes\n"
    csv_text = "region,amount\nAPAC,42\nEMEA,7\n"

    def data_url(mime: str, payload: bytes) -> str:
        return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "Inspect every attachment.",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "attachments": [
                {"kind": "image", "name": "shot.png", "mime": "image/png", "data_url": data_url("image/png", png_bytes), "source": "paste"},
                {"kind": "file", "name": "report.pdf", "mime": "application/pdf", "data_url": data_url("application/pdf", pdf_bytes), "source": "picker"},
                {"kind": "file", "name": "rows.csv", "mime": "text/csv", "data_url": data_url("text/csv", csv_text.encode("utf-8")), "source": "drop"},
            ],
        },
    )

    assert response.status_code == 200
    context_text = seen["context_text"]

    # Every uploaded attachment is surfaced to the runtime by path, classified by kind.
    assert "attachment image: name=shot.png" in context_text
    assert "attachment file: name=report.pdf" in context_text
    assert "attachment file: name=rows.csv" in context_text
    # The surface hands over paths only — it does NOT read or inline file content
    # (no excerpting, no truncation). The runtime reads the persisted files itself.
    assert "APAC,42" not in context_text
    assert "EMEA,7" not in context_text
    assert "content:" not in context_text
    assert "not-read-non-text-file" not in context_text
    assert "path=" in context_text

    # The bytes are actually persisted to disk so codex (read-only sandbox, --cd repo) can open them.
    storage_root = tmp_path / ".superclaw" / "chat-attachments"
    saved = list(storage_root.rglob("*"))
    saved_files = [p for p in saved if p.is_file()]
    assert len(saved_files) == 3
    assert any(p.read_bytes() == png_bytes for p in saved_files)
    assert any(p.read_bytes() == pdf_bytes for p in saved_files)
    assert any(p.read_bytes() == csv_text.encode("utf-8") for p in saved_files)


def test_api_unified_chat_turn_resolves_artifact_and_file_refs_for_direct_chat(tmp_path, monkeypatch):
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["context_text"] = context_text
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Artifact answer"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    state_path = tmp_path / "state.db"
    seeded_store = StateStore(state_path)
    run = seeded_store.create_run("goal_artifact_context", dry_run=True)
    artifact_root = tmp_path / "artifacts"
    run.execution_context["artifact_dir"] = str(artifact_root)
    seeded_store.save_run(run)
    artifact_path = artifact_root / run.run_id / "worker.log"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text("worker transcript context excerpt", encoding="utf-8")
    evidence = seeded_store.create_evidence(run.run_id)
    evidence.add_artifact(
        ArtifactRef(
            kind="worker-log",
            path=str(artifact_path),
            artifact_id="run_demo_log",
            sensitivity="internal",
            metadata={"summary": "worker transcript"},
        )
    )
    seeded_store.save_evidence(evidence)
    app = create_app(state_path=state_path)
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "Use the artifact context.",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "context_refs": [
                {
                    "type": "artifact",
                    "id": "run_demo_log",
                    "label": "worker-log run_demo_log",
                    "visible_token": "@artifact:run_demo_log",
                    "metadata": {"run_id": run.run_id, "artifact_id": "run_demo_log"},
                },
                {
                    "type": "file",
                    "id": str(artifact_path),
                    "label": "worker.log",
                    "visible_token": "@file:run_demo_log",
                    "metadata": {
                        "run_id": run.run_id,
                        "artifact_id": "run_demo_log",
                        "path": str(artifact_path),
                    },
                },
            ],
        },
    )
    session = client.get(f"/api/chat/sessions/{response.json()['session_id']}")

    assert response.status_code == 200
    assert "artifact run_demo_log" in seen["context_text"]
    assert "file run_demo_log" in seen["context_text"]
    assert f"run_id={run.run_id}" in seen["context_text"]
    assert "kind=worker-log" in seen["context_text"]
    assert str(artifact_path) in seen["context_text"]
    assert "worker transcript context excerpt" in seen["context_text"]
    assert session.status_code == 200
    assert [ref["type"] for ref in session.json()["messages"][0]["context_refs"]] == ["artifact", "file"]
    assert session.json()["messages"][0]["context_refs"][0]["metadata"]["run_id"] == run.run_id


def test_api_unified_chat_turn_rejects_file_refs_outside_run_artifact_root(tmp_path, monkeypatch):
    seen = {}

    def fake_direct_chat_turn(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["context_text"] = context_text
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "Boundary answer"}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct_chat_turn)
    state_path = tmp_path / "state.db"
    seeded_store = StateStore(state_path)
    run = seeded_store.create_run("goal_artifact_boundary", dry_run=True)
    artifact_root = tmp_path / "artifacts"
    run.execution_context["artifact_dir"] = str(artifact_root)
    seeded_store.save_run(run)
    outside_path = tmp_path / "private" / "secret.log"
    outside_path.parent.mkdir(parents=True)
    outside_path.write_text("outside secret should not be injected", encoding="utf-8")
    evidence = seeded_store.create_evidence(run.run_id)
    evidence.add_artifact(ArtifactRef(kind="worker-log", path=str(outside_path), artifact_id="outside_log"))
    seeded_store.save_evidence(evidence)
    app = create_app(state_path=state_path)
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "Use the unsafe file context.",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
            "context_refs": [
                {
                    "type": "file",
                    "id": str(outside_path),
                    "visible_token": "@file:outside_log",
                    "metadata": {"run_id": run.run_id, "artifact_id": "outside_log", "path": str(outside_path)},
                }
            ],
        },
    )

    assert response.status_code == 200
    assert "Reference not found: file:" in seen["context_text"]
    assert "outside secret should not be injected" not in seen["context_text"]


def test_api_unified_chat_turn_routes_delivery_to_async_run(tmp_path, monkeypatch):
    seen = {}

    def fake_start_existing_goal(self, goal, **kwargs):
        seen["goal_description"] = goal.description
        seen["metadata"] = goal.metadata
        seen["backend_policy"] = kwargs["backend_policy"]
        seen["harness_policy"] = kwargs["harness_policy"]
        seen["chat_session_id"] = kwargs["chat_session_id"]
        # Regression (effort fail-closed): the ASYNC delivery path must forward the
        # per-turn effort into the orchestrator, else an unsupported backend would
        # never reach its run() guard (the sync path forwards it, so must async).
        seen["effort"] = kwargs.get("effort")
        session = self.store.create_run(goal.goal_id, dry_run=kwargs["dry_run"])
        session.chat_session_id = kwargs["chat_session_id"]
        session.status = "queued"
        self.store.save_run(session)
        return session

    monkeypatch.setattr("apps.api.main.SuperClawOrchestrator.start_existing_goal", fake_start_existing_goal)
    state_path = tmp_path / "state.db"
    seeded_store = StateStore(state_path)
    seeded_session = seeded_store.create_chat_session("Bug context")
    seeded_store.append_chat_message(seeded_session.session_id, "user", "We are fixing the desktop composer.")
    seeded_store.append_chat_message(seeded_session.session_id, "assistant", "Keep the dry-run toggle enabled.")
    app = create_app(state_path=state_path)
    client = TestClient(app)
    _trust_repo(tmp_path)

    response = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery fix this bug",
            "session_id": seeded_session.session_id,
            "backend_policy": "local",
            "effort": "high",
            "harness_policy": "codex",
            "repo_path": str(tmp_path),
            "artifact_dir": str(tmp_path / "artifacts"),
            "dry_run": True,
            "context_refs": [
                {
                    "type": "chat_session",
                    "id": seeded_session.session_id,
                    "label": "Bug context",
                    "visible_token": f"@session:{seeded_session.session_id}",
                },
                {"type": "run", "id": "missing-run", "label": "Missing run", "visible_token": "@run:missing-run"},
            ],
        },
    )
    payload = response.json()
    run = client.get(f"/api/runs/{payload['run_id']}")
    session = client.get(f"/api/chat/sessions/{payload['session_id']}")

    assert response.status_code == 200
    assert payload["intent"] == "delivery"
    assert payload["status"] == "queued"
    assert payload["events_url"] == f"/api/runs/{payload['run_id']}/events"
    assert run.status_code == 200
    assert run.json()["chat_session_id"] == payload["session_id"]
    assert seen["effort"] == "high"  # async delivery forwards effort to the orchestrator
    assert session.status_code == 200
    assert session.json()["messages"][-1]["run_id"] == payload["run_id"]
    assert session.json()["messages"][-2]["context_refs"][0]["id"] == seeded_session.session_id
    assert "Current delivery request:\n@delivery fix this bug" in seen["goal_description"]
    assert "We are fixing the desktop composer." in seen["goal_description"]
    assert "Keep the dry-run toggle enabled." in seen["goal_description"]
    assert "Selected context references:" in seen["goal_description"]
    assert "Reference not found: run:missing-run" in seen["goal_description"]
    assert seen["metadata"]["chat_session_id"] == payload["session_id"]
    assert seen["metadata"]["chat_context_message_count"] == 3
    assert [message["role"] for message in seen["metadata"]["chat_context_messages"]] == ["user", "assistant", "user"]
    assert seen["metadata"]["chat_context_ref_count"] == 2
    assert seen["metadata"]["chat_context_refs"][0]["id"] == seeded_session.session_id
    assert seen["chat_session_id"] == payload["session_id"]
    assert seen["backend_policy"] == "local"


def test_api_runtime_status_agents_and_plugins_contract(tmp_path, monkeypatch):
    class MissingBackend:
        name = "missing"

        def available(self):
            return BackendAvailability(name="missing", available=False, reason="not configured")

        def permission_presets(self):
            from superclaw.permissions import PresetRealization, make_presets

            return make_presets(
                ask=PresetRealization("missing-ask", False, "perm.note.missing.ask"),
                allow=PresetRealization("missing-allow", False, "perm.note.missing.allow"),
            )

    plugin_root = tmp_path / "plugin-cache" / "demo.plugin" / "0.1.0"
    plugin_root.mkdir(parents=True)
    (plugin_root / "superclaw-plugin.json").write_text(
        json.dumps({"id": "demo.plugin", "name": "Demo Plugin", "version": "0.1.0"}),
        encoding="utf-8",
    )
    registry_root = tmp_path / "plugin-cloud" / "registry" / "plugins" / "dev.superclaw.registry-demo" / "0.1.0"
    registry_root.mkdir(parents=True)
    (registry_root / "metadata.json").write_text(
        json.dumps(
            {
                "plugin_id": "dev.superclaw.registry-demo",
                "version": "0.1.0",
                "name": "Registry Demo",
                "summary": "Registry fixture for the control plane",
                "category": "utility",
                "runtime": "mcp_sidecar",
                "platforms": ["darwin-arm64"],
                "acceptance_level": "L1",
                "verified": True,
                "pricing_model": "free",
                "package_digest": "sha256:" + ("1" * 64),
                "package_path": "package",
                "compatibility": {"superclaw": ">=0.1.0"},
                "entitlement_required": False,
            }
        ),
        encoding="utf-8",
    )
    package_root = registry_root / "package"
    package_root.mkdir()
    (package_root / "superclaw-plugin.json").write_text(
        json.dumps(
            {
                "id": "dev.superclaw.registry-demo",
                "name": "Registry Demo",
                "version": "0.1.0",
                "summary": "Registry fixture for the control plane",
                "runtime": {"type": "mcp_sidecar", "platforms": ["darwin-arm64"]},
                "acceptance": {"level": "L1"},
                "commerce": {"pricing_model": "free"},
                "provenance": {"package_digest": "sha256:" + ("1" * 64), "signature": "ed25519:test"},
            }
        ),
        encoding="utf-8",
    )
    governance_root = tmp_path / "plugin-cloud" / "governance"
    governance_root.mkdir(parents=True)
    (governance_root / "revocations.json").write_text(
        json.dumps(
            {
                "revoked": [
                    {
                        "plugin_id": "dev.superclaw.hello-world",
                        "version": "0.1.0",
                        "package_digest": "sha256:" + ("2" * 64),
                        "reason": "broken_runtime",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance_root / "runtime-policy.json").write_text(
        json.dumps(
            {
                "policies": [
                    {
                        "plugin_id": "dev.superclaw.registry-demo",
                        "version": "0.1.0",
                        "max_model_output_bytes": 1024,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    local_state_root = tmp_path / "plugin-state"
    local_state_root.mkdir(parents=True)
    (local_state_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "demo.plugin",
                        "version": "0.1.0",
                        "entitlement_id": "ent_local_demo",
                        "expires_at": "2030-01-01T00:00:00Z",
                        "token": "local-entitlement.should-not-leak",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(tmp_path / "plugin-cloud"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_STATE_PATH", str(local_state_root))
    monkeypatch.setattr("apps.api.main.default_backends", lambda: {"local": LocalShellBackend(), "missing": MissingBackend()})

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Status", "description": "Create state"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()
    runtime = client.get("/api/runtime/status")
    agents = client.get("/api/agents")
    plugins = client.get("/api/plugins/status")

    assert runtime.status_code == 200
    runtime_payload = runtime.json()
    assert runtime_payload["service"]["name"] == "superclaw"
    assert runtime_payload["service"]["version"] == "0.1.0"
    assert runtime_payload["service"]["pid"] > 0
    assert runtime_payload["service"]["bind"] == "127.0.0.1"
    assert runtime_payload["service"]["control_token"] == "unset"
    assert runtime_payload["service"]["uptime_seconds"] >= 0
    assert runtime_payload["state"]["context"]["counts"]["runs"] == 1
    assert runtime_payload["state"]["active_run_count"] == len(runtime_payload["state"]["active_run_ids"])
    assert runtime_payload["state"]["recent_run_id"] == run["run_id"]
    assert runtime_payload["agents"]["count"] == 2
    assert runtime_payload["agents"]["ready_count"] == 1
    assert runtime_payload["plugins"]["plugin_count"] == 1

    assert agents.status_code == 200
    assert agents.json()["summary"] == {"count": 2, "ready_count": 1}
    assert agents.json()["agents"][0]["name"] == "local"

    assert plugins.status_code == 200
    assert plugins.json()["plugin_count"] == 1
    assert plugins.json()["plugins"][0]["id"] == "demo.plugin"
    assert plugins.json()["cache_root"] == str(tmp_path / "plugin-cache")
    assert plugins.json()["verification"]["public_key_configured"] is False
    assert plugins.json()["verification"]["install_url"] == "/api/plugins/install"
    assert plugins.json()["verification"]["local_install_url"] == "/api/plugins/install-local"
    assert plugins.json()["verification"]["uninstall_url"] == "/api/plugins/uninstall"
    assert plugins.json()["entitlements"]["count"] == 1
    assert plugins.json()["entitlements"]["plugin_count"] == 1
    assert plugins.json()["entitlements"]["status_url"] == "/v1/entitlements/sync"
    assert plugins.json()["entitlements"]["entries"][0]["plugin_id"] == "demo.plugin"
    assert "token" not in plugins.json()["entitlements"]["entries"][0]
    assert plugins.json()["registry"]["count"] == 1
    assert plugins.json()["registry"]["status_url"] == "/v1/plugins"
    assert plugins.json()["governance"]["revocation_count"] == 1
    assert plugins.json()["governance"]["policy_count"] == 1
    assert plugins.json()["governance"]["revocations"][0]["plugin_id"] == "dev.superclaw.hello-world"
    assert plugins.json()["governance"]["revocations"][0]["reason"] == "broken_runtime"
    assert plugins.json()["governance"]["policies"][0]["plugin_id"] == "dev.superclaw.registry-demo"
    assert plugins.json()["governance"]["policies"][0]["max_model_output_bytes"] == 1024
    assert plugins.json()["configuration"]["status_url"] == "/api/plugins/{plugin_id}/configuration"
    assert plugins.json()["diagnostics"]["status_url"] == "/api/plugins/diagnostics"
    assert plugins.json()["diagnostics"]["events_url"] == "/api/plugins/diagnostics/events"


def test_api_plugin_marketplace_catalog_proxies_clawhunt_product_catalog(tmp_path, monkeypatch):
    observed: dict[str, object] = {}

    class FakeCatalogResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "source": "clawhunt_server",
                "items": [
                    {
                        "plugin_id": "dev.clawhunt.pay-switch-agent",
                        "version": "0.3.0",
                        "name": {"en": "Pay-Switch Agent", "zh": "Pay-Switch Agent"},
                        "summary": {"en": "Server catalog entry", "zh": "服务器目录项"},
                        "category": "featured",
                        "icon": "commerce",
                        "runtime": "mcp_sidecar",
                        "pricing_model": "private_beta",
                        "verified": True,
                        "entitlement_required": True,
                    }
                ],
            }

    def fake_get(url: str, **kwargs: object) -> FakeCatalogResponse:
        observed["url"] = url
        observed["kwargs"] = kwargs
        return FakeCatalogResponse()

    monkeypatch.setenv("CLAWHUNT_BASE_URL", "http://clawhunt.local")
    monkeypatch.setattr("apps.api.main.httpx.get", fake_get)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/plugins/marketplace-catalog")

    assert response.status_code == 200
    payload = response.json()
    assert observed["url"] == "http://clawhunt.local/api/plugins/marketplace-catalog"
    assert observed["kwargs"] == {"follow_redirects": True, "timeout": 8.0}
    assert payload["source"] == "clawhunt_server"
    assert payload["total"] == 1
    assert payload["plugins"][0]["plugin_id"] == "dev.clawhunt.pay-switch-agent"
    assert payload["plugins"][0]["version"] == "0.3.0"


def test_api_serves_cached_plugin_logo_from_manifest(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    plugin_dir = _copy_plugin_fixture(tmp_path, "hello-world")
    logo_bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n"
    (plugin_dir / "assets").mkdir()
    (plugin_dir / "assets" / "logo.svg").write_bytes(logo_bytes)
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["logo"] = "assets/logo.svg"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    public_key = _sign_plugin_fixture(plugin_dir)
    verify_plugin_package(plugin_dir, public_key=public_key, cache_root=cache_root)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    status = client.get("/api/plugins/status")
    assert status.status_code == 200
    cached = status.json()["plugins"][0]
    assert cached["logo"] == "assets/logo.svg"
    assert cached["logo_url"] == "/api/plugins/dev.superclaw.hello-world/logo?version=0.1.0"

    logo = client.get(cached["logo_url"])
    assert logo.status_code == 200
    assert logo.headers["content-type"].startswith("image/svg+xml")
    assert logo.content == logo_bytes


def test_api_runtime_status_contract_exposes_service_bind_pid_and_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv("SUPERCLAW_SERVICE_BIND", "127.0.0.99")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/runtime/status", headers={"X-SuperClaw-Token": "secret-control"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["service"]["pid"] == os.getpid()
    assert payload["service"]["bind"] == "127.0.0.99"
    assert payload["service"]["control_token"] == "set"


def test_api_runtime_control_token_rotate_rekeys_protected_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    rotate = client.post("/api/runtime/control-token/rotate", headers={"X-SuperClaw-Token": "secret-control"})

    assert rotate.status_code == 200
    payload = rotate.json()
    assert payload["ok"] is True
    assert payload["control_token"] != "secret-control"
    assert client.get("/api/runtime/status", headers={"X-SuperClaw-Token": "secret-control"}).status_code == 401
    assert client.get("/api/runtime/status", headers={"X-SuperClaw-Token": payload["control_token"]}).status_code == 200


def test_api_desktop_toolchain_contract(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/desktop/toolchain")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/desktop/toolchain"
    workspace_root = Path(payload["workspace_root"])
    assert (workspace_root / "pyproject.toml").exists()
    assert (workspace_root / "packages" / "superclaw" / "src" / "superclaw").exists()
    assert Path(payload["desktop_root"]).parts[-2:] == ("apps", "desktop")
    assert isinstance(payload["source_workspace"], bool)
    assert payload["summary"]["required_count"] == len(payload["tools"])
    assert payload["summary"]["ready_count"] == sum(1 for tool in payload["tools"] if tool["available"])
    assert payload["summary"]["source_build_ready"] == (
        payload["summary"]["ready_count"] == payload["summary"]["required_count"]
    )
    names = {tool["name"] for tool in payload["tools"]}
    assert names == {"python3", "node", "npm", "cargo", "tauri"}


def test_api_desktop_onboarding_contract(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/desktop/onboarding")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/desktop/onboarding"
    assert payload["quickstart_path"] == "docs/desktop-beta-quickstart.md"
    assert payload["summary"]["total_count"] == len(payload["checks"]) == 6
    assert payload["summary"]["ready_count"] <= payload["summary"]["total_count"]
    assert {item["title"] for item in payload["checks"]} == {
        "Runtime service",
        "Desktop toolchain",
        "Dependency doctor",
        "Beta acceptance",
        "ClawHunt login",
        "Plugin trust root",
    }
    assert {item["name"] for item in payload["dependency_targets"]} == {"codex", "hermes", "claude", "openclaw"}


def test_api_plugin_diagnostics_contract_and_events(tmp_path, monkeypatch):
    # The plugin-artifacts root now resolves under the HOME data root; pin it to this
    # test's tmp so the diagnostics endpoint reads the artifacts written below.
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    artifact_root = tmp_path / ".superclaw" / "artifacts" / "plugins"
    artifact_root.mkdir(parents=True)
    (artifact_root / "art_slow.json").write_text(
        json.dumps(
            {
                "evidence_artifact_id": "art_slow",
                "plugin_id": "dev.superclaw.github-scanner",
                "plugin_version": "0.2.0",
                "tool_name": "scan_repo",
                "status": "ok",
                "started_at": "2026-06-04T00:00:00Z",
                "finished_at": "2026-06-04T00:01:00Z",
                "policy_decision": "allow",
            }
        ),
        encoding="utf-8",
    )
    (artifact_root / "art_fail.json").write_text(
        json.dumps(
            {
                "evidence_artifact_id": "art_fail",
                "plugin_id": "dev.superclaw.github-scanner",
                "plugin_version": "0.2.0",
                "tool_name": "scan_repo",
                "status": "sandbox_violation",
                "started_at": "2026-06-04T00:02:00Z",
                "finished_at": "2026-06-04T00:02:01Z",
                "policy_decision": "PLUGIN_SANDBOX_VIOLATION",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/plugins/diagnostics")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/plugins/diagnostics"
    assert payload["events_url"] == "/api/plugins/diagnostics/events"
    assert payload["artifact_dir"].endswith(".superclaw/artifacts/plugins")
    assert payload["artifact_count"] == 2
    assert payload["summary"]["tools"] == 1
    assert payload["summary"]["failures"] == 1
    assert payload["summary"]["slow_calls"] == 1
    assert payload["summary"]["sandbox_kills"] == 1
    assert any(finding["code"] == "PLUGIN_RUNTIME_SLOW_CALL" for finding in payload["findings"])

    with client.stream("GET", "/api/plugins/diagnostics/events?once=1") as stream:
        lines = []
        for line in stream.iter_lines():
            if not line:
                if lines:
                    break
                continue
            lines.append(line)
            if len(lines) >= 2:
                break

    assert lines[0] == "event: plugin.diagnostics"
    assert lines[1].startswith("data: ")
    streamed = json.loads(lines[1][6:])
    assert streamed["artifact_count"] == 2
    assert streamed["status_url"] == "/api/plugins/diagnostics"


def test_api_desktop_acceptance_contract(tmp_path, monkeypatch):
    report_path = tmp_path / "desktop-beta-acceptance.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at": "2026-06-04T05:00:00Z",
                "success": True,
                "failed_step": None,
                "steps": [
                    {
                        "name": "config",
                        "command": "npm run test:config --prefix apps/desktop",
                        "started_at": "2026-06-04T05:00:00Z",
                        "duration_ms": 1200,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                    {
                        "name": "build",
                        "command": "npm run tauri:build --prefix apps/desktop",
                        "started_at": "2026-06-04T05:00:01Z",
                        "duration_ms": 2400,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_DESKTOP_ACCEPTANCE_REPORT", str(report_path))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/desktop/acceptance")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/desktop/acceptance"
    assert payload["generate_command"] == "npm --prefix apps/desktop run test:beta-acceptance"
    assert payload["report_path"] == str(report_path)
    assert payload["exists"] is True
    assert payload["summary"] == {
        "ready": True,
        "success": True,
        "failed_step": None,
        "generated_at": "2026-06-04T05:00:00Z",
        "completed_steps": 2,
        "total_steps": 2,
    }


def test_api_tui_acceptance_contract_reports_failed_summary(tmp_path, monkeypatch):
    report_path = tmp_path / "tui-acceptance.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at": "2026-06-04T06:00:00Z",
                "success": True,
                "failed_step": None,
                "steps": [
                    {
                        "name": "pytest",
                        "command": "python -m pytest tests/test_tui.py",
                        "started_at": "2026-06-04T06:00:00Z",
                        "duration_ms": 900,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                    {
                        "name": "launch_smoke",
                        "command": "python -m superclaw.cli tui --backend local",
                        "started_at": "2026-06-04T06:00:01Z",
                        "duration_ms": 600,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_TUI_ACCEPTANCE_REPORT", str(report_path))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/tui/acceptance")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/tui/acceptance"
    assert payload["generate_command"] == "PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance"
    assert payload["report_path"] == str(report_path)
    assert payload["exists"] is True
    assert payload["summary"] == {
        "ready": True,
        "success": True,
        "failed_step": None,
        "generated_at": "2026-06-04T06:00:00Z",
        "completed_steps": 2,
        "total_steps": 2,
    }
    assert payload["report"]["steps"][0]["name"] == "pytest"
    assert payload["report"]["steps"][1]["name"] == "launch_smoke"


def test_api_tui_acceptance_contract(tmp_path, monkeypatch):
    report_path = tmp_path / "tui-acceptance.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at": "2026-06-04T05:00:00Z",
                "success": False,
                "failed_step": "snapshot_file",
                "steps": [
                    {
                        "name": "pytest",
                        "command": "python -m pytest tests/test_tui.py",
                        "started_at": "2026-06-04T05:00:00Z",
                        "duration_ms": 1200,
                        "code": 0,
                        "signal": None,
                        "ok": True,
                        "stdout_tail": ["ok"],
                        "stderr_tail": [],
                    },
                    {
                        "name": "snapshot_file",
                        "command": "python -m superclaw.cli tui --snapshot-file .superclaw/tui/tui-acceptance-snapshot.json",
                        "started_at": "2026-06-04T05:00:01Z",
                        "duration_ms": 2400,
                        "code": 1,
                        "signal": None,
                        "ok": False,
                        "stdout_tail": [],
                        "stderr_tail": ["boom"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_TUI_ACCEPTANCE_REPORT", str(report_path))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/tui/acceptance")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status_url"] == "/api/tui/acceptance"
    assert payload["generate_command"] == "PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance"
    assert payload["report_path"] == str(report_path)
    assert payload["exists"] is True
    assert payload["summary"] == {
        "ready": True,
        "success": False,
        "failed_step": "snapshot_file",
        "generated_at": "2026-06-04T05:00:00Z",
        "completed_steps": 1,
        "total_steps": 2,
    }
    assert payload["report"]["steps"][0]["name"] == "pytest"
    assert payload["report"]["steps"][1]["name"] == "snapshot_file"


def test_api_plugin_install_and_configuration_control_plane(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin-config.json"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    configuration_before = client.get(f"/api/plugins/{fixture['plugin_id']}/configuration", params={"version": fixture["version"]})
    save_setting = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "name": "default_owner", "value": "ClawHunt-Store"},
    )
    save_secret = client.post(
        "/api/plugins/secret/set",
        json={
            "plugin_id": fixture["plugin_id"],
            "version": fixture["version"],
            "name": "GITHUB_TOKEN",
            "value": "ghp_supersecretfixture",
            "version_range": "=0.1.0",
        },
    )
    configuration_after = client.get(f"/api/plugins/{fixture['plugin_id']}/configuration", params={"version": fixture["version"]})
    clear_secret = client.post("/api/plugins/secret/delete", json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "GITHUB_TOKEN"})
    configuration_cleared = client.get(f"/api/plugins/{fixture['plugin_id']}/configuration", params={"version": fixture["version"]})

    assert installed.status_code == 200
    assert installed.json()["installed"] is True
    assert installed.json()["plugin_id"] == fixture["plugin_id"]
    assert configuration_before.status_code == 200
    before_payload = configuration_before.json()
    assert before_payload["name"] == "GitHub Scanner"
    assert before_payload["configuration"]["settings"] == [
        {
            "configured": False,
            "default": "ClawHunt-Store",
            "description": "Default GitHub owner used when a call omits an owner value.",
            "name": "default_owner",
            "required": False,
            "type": "string",
            "ui": {
                "control": "text",
                "help": "Used only as non-secret local plugin configuration.",
                "label": "Default owner",
                "placeholder": "ClawHunt-Store",
            },
            "updated_at": None,
            "env_name": None,
            "options_source": None,
            "actions": [],
            "validation": {
                "maxLength": 80,
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_.-]{1,80}$",
            },
            "value": "ClawHunt-Store",
        }
    ]
    assert before_payload["configuration"]["secrets"][0]["name"] == "GITHUB_TOKEN"
    assert before_payload["configuration"]["secrets"][0]["configured"] is False
    assert save_setting.status_code == 200
    assert save_secret.status_code == 200
    assert clear_secret.status_code == 200
    after_payload = configuration_after.json()
    assert after_payload["configuration"]["settings"][0]["configured"] is True
    assert after_payload["configuration"]["settings"][0]["value"] == "ClawHunt-Store"
    assert after_payload["configuration"]["secrets"][0]["configured"] is True
    assert after_payload["configuration"]["secrets"][0]["version_range"] == "=0.1.0"
    cleared_payload = configuration_cleared.json()
    assert cleared_payload["configuration"]["secrets"][0]["configured"] is False
    joined = json.dumps([installed.json(), before_payload, after_payload, cleared_payload, save_secret.json()])
    assert "ghp_supersecretfixture" not in joined
    config_text = Path(os.environ["SUPERCLAW_PLUGIN_CONFIG_PATH"]).read_text(encoding="utf-8")
    assert "ClawHunt-Store" in config_text
    assert "ghp_supersecretfixture" not in json.dumps([after_payload, cleared_payload])


def test_api_plugin_config_set_rejects_control_character_values(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    config_path = tmp_path / "plugin-config.json"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    response = client.post(
        "/api/plugins/config/set",
        json={
            "plugin_id": fixture["plugin_id"],
            "name": "default_owner",
            "value": "ClawHunt-Store\rGITHUB_TOKEN=ghp_pollutedsetting",
        },
    )

    assert installed.status_code == 200
    assert response.status_code == 400
    assert "control characters" in response.json()["detail"]
    assert "ghp_pollutedsetting" not in response.text
    assert not config_path.exists()


def test_api_plugin_config_set_requires_manifest_descriptor(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    config_path = tmp_path / "plugin-config.json"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    response = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "undeclared_setting", "value": "x"},
    )

    assert installed.status_code == 200
    assert response.status_code == 400
    assert response.json()["detail"] == "plugin setting is not declared by manifest"
    assert not config_path.exists()


def test_api_plugin_config_set_validates_manifest_setting_type_and_rules(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["configuration"]["settings"].extend(
        [
            {
                "name": "max_depth",
                "type": "integer",
                "description": "Maximum scan depth.",
                "required": False,
                "default": 3,
                "validation": {"minimum": 1, "maximum": 5, "step": 2},
                "ui": {"control": "number", "label": "Max depth"},
            },
            {
                "name": "panel_url",
                "type": "string",
                "description": "Plugin panel URL.",
                "required": False,
                "default": "https://example.com/panel",
                "validation": {"format": "uri"},
                "ui": {"control": "url", "label": "Panel URL"},
            },
            {
                "name": "use_cache",
                "type": "boolean",
                "description": "Use cached GitHub metadata when available.",
                "required": False,
                "default": True,
                "ui": {"control": "switch", "label": "Use cache"},
            },
            {
                "name": "runtime_mode",
                "type": "string",
                "description": "Runtime mode.",
                "required": True,
                "default": "sandbox",
                "validation": {"enum": ["sandbox", "production"]},
                "ui": {"control": "select", "label": "Runtime mode"},
            },
        ]
    )
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    config_path = tmp_path / "plugin-config.json"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    bad_integer = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "max_depth", "value": "too-deep"},
    )
    below_minimum = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "max_depth", "value": 0},
    )
    bad_step = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "max_depth", "value": 4},
    )
    bad_url = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "panel_url", "value": "not-a-url"},
    )
    bad_enum = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "runtime_mode", "value": "debug"},
    )
    good_integer = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "max_depth", "value": "3"},
    )
    good_boolean = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "use_cache", "value": False},
    )
    good_url = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "panel_url", "value": "https://example.com/custom"},
    )
    good_enum = client.post(
        "/api/plugins/config/set",
        json={"plugin_id": fixture["plugin_id"], "version": fixture["version"], "name": "runtime_mode", "value": "production"},
    )
    configuration = client.get(f"/api/plugins/{fixture['plugin_id']}/configuration", params={"version": fixture["version"]})

    assert installed.status_code == 200
    assert bad_integer.status_code == 400
    assert bad_integer.json()["detail"] == "plugin setting value must be an integer"
    assert below_minimum.status_code == 400
    assert below_minimum.json()["detail"] == "plugin setting value is below minimum"
    assert bad_step.status_code == 400
    assert bad_step.json()["detail"] == "plugin setting value does not match required step"
    assert bad_url.status_code == 400
    assert bad_url.json()["detail"] == "plugin setting value must be a valid URI"
    assert bad_enum.status_code == 400
    assert bad_enum.json()["detail"] == "plugin setting value is not an allowed option"
    assert good_integer.status_code == 200
    assert good_boolean.status_code == 200
    assert good_url.status_code == 200
    assert good_enum.status_code == 200
    settings = {item["name"]: item for item in configuration.json()["configuration"]["settings"]}
    assert settings["max_depth"]["value"] == 3
    assert settings["use_cache"]["value"] is False
    assert settings["panel_url"]["value"] == "https://example.com/custom"
    assert settings["runtime_mode"]["value"] == "production"
    assert settings["runtime_mode"]["validation"] == {"enum": ["sandbox", "production"]}
    assert settings["use_cache"]["ui"] == {"control": "switch", "label": "Use cache"}


def test_api_plugin_secret_set_requires_manifest_descriptor(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    config_path = tmp_path / "plugin-config.json"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    response = client.post(
        "/api/plugins/secret/set",
        json={
            "plugin_id": fixture["plugin_id"],
            "version": fixture["version"],
            "name": "UNDECLARED_TOKEN",
            "value": "secret-value",
            "version_range": "=0.1.0",
        },
    )

    assert installed.status_code == 200
    assert response.status_code == 400
    assert response.json()["detail"] == "plugin secret is not declared by manifest"
    assert not config_path.exists()


def test_api_entitlement_sync_contract(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    cloud_root = tmp_path / "plugin-cloud"
    _write_registry_fixture(cloud_root, plugin_dir)
    governance_root = cloud_root / "governance"
    governance_root.mkdir(parents=True, exist_ok=True)
    (governance_root / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_demo",
                        "subject": "device-seat",
                        "expires_at": "2030-01-01T00:00:00Z",
                        "offline_grace_allowed": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post(
        "/v1/entitlements/sync",
        json={
            "device_id": "scdev_fixture",
            "runtime_version": "0.1.0",
            "plugin_ids": ["dev.superclaw.github-scanner"],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["entitlements"]) == 1
    entitlement = payload["entitlements"][0]
    assert entitlement["plugin_id"] == "dev.superclaw.github-scanner"
    assert entitlement["entitlement_id"] == "ent_demo"
    assert entitlement["device_id"] == "scdev_fixture"
    assert entitlement["runtime_version"] == "0.1.0"
    assert entitlement["expires_at"] == "2030-01-01T00:00:00Z"
    assert entitlement["token"].startswith("local-entitlement.")


def test_api_plugin_install_local_and_configuration_control_plane(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "github-scanner")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin-config.json"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install-local", json={"package_path": str(plugin_dir)})
    configuration = client.get("/api/plugins/dev.superclaw.github-scanner/configuration", params={"version": "0.1.0"})
    status = client.get("/api/plugins/status")

    assert installed.status_code == 200
    install_payload = installed.json()
    assert install_payload["installed"] is True
    assert install_payload["plugin_id"] == "dev.superclaw.github-scanner"
    assert install_payload["version"] == "0.1.0"
    assert install_payload["package_path"] == str(plugin_dir)
    assert configuration.status_code == 200
    configuration_payload = configuration.json()
    assert configuration_payload["configuration"]["settings"] == [
        {
            "configured": False,
            "default": "ClawHunt-Store",
            "description": "Default GitHub owner used when a call omits an owner value.",
            "name": "default_owner",
            "required": False,
            "type": "string",
            "ui": {
                "control": "text",
                "help": "Used only as non-secret local plugin configuration.",
                "label": "Default owner",
                "placeholder": "ClawHunt-Store",
            },
            "updated_at": None,
            "env_name": None,
            "options_source": None,
            "actions": [],
            "validation": {
                "maxLength": 80,
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_.-]{1,80}$",
            },
            "value": "ClawHunt-Store",
        }
    ]
    assert configuration_payload["configuration"]["secrets"][0]["name"] == "GITHUB_TOKEN"
    assert configuration_payload["configuration"]["secrets"][0]["configured"] is False
    assert status.status_code == 200
    assert status.json()["plugin_count"] == 1
    assert status.json()["plugins"][0]["id"] == "dev.superclaw.github-scanner"


def test_api_plugin_uninstall_control_plane(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "hello-world")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    installed = client.post("/api/plugins/install", json=fixture)
    status_before = client.get("/api/plugins/status")
    removed = client.post("/api/plugins/uninstall", json=fixture)
    status_after = client.get("/api/plugins/status")
    configuration_missing = client.get(
        f"/api/plugins/{fixture['plugin_id']}/configuration",
        params={"version": fixture["version"]},
    )

    assert installed.status_code == 200
    assert status_before.status_code == 200
    assert status_before.json()["plugin_count"] == 1
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert removed.json()["removed_versions"] == [fixture["version"]]
    assert status_after.status_code == 200
    assert status_after.json()["plugin_count"] == 0
    assert status_after.json()["plugins"] == []
    assert configuration_missing.status_code == 404


def test_api_plugin_configuration_rejects_cache_version_path_traversal(tmp_path, monkeypatch):
    cache_root = tmp_path / "plugin-cache"
    safe_dir = cache_root / "dev.superclaw.safe" / "0.1.0"
    other_dir = cache_root / "dev.superclaw.other" / "0.1.0"
    safe_dir.mkdir(parents=True)
    other_dir.mkdir(parents=True)
    (safe_dir / "superclaw-plugin.json").write_text(
        json.dumps(
            {
                "id": "dev.superclaw.safe",
                "version": "0.1.0",
                "name": "Safe Plugin",
                "runtime": {"type": "local"},
                "configuration": {"settings": [], "secrets": []},
            }
        ),
        encoding="utf-8",
    )
    (other_dir / "superclaw-plugin.json").write_text(
        json.dumps(
            {
                "id": "dev.superclaw.other",
                "version": "0.1.0",
                "name": "Other Plugin Should Stay Private",
                "runtime": {"type": "local"},
                "configuration": {"settings": [], "secrets": []},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin-config.json"))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get(
        "/api/plugins/dev.superclaw.safe/configuration",
        params={"version": "../dev.superclaw.other/0.1.0"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "plugin not installed"
    assert "Other Plugin Should Stay Private" not in response.text


def test_api_plugin_uninstall_rejects_unsafe_path_segments(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    unsafe_plugin = client.post("/api/plugins/uninstall", json={"plugin_id": ".", "version": "0.1.0"})
    unsafe_version = client.post("/api/plugins/uninstall", json={"plugin_id": "dev.superclaw.hello-world", "version": "."})

    assert unsafe_plugin.status_code == 400
    assert "unsafe plugin id path" in unsafe_plugin.json()["detail"]
    assert unsafe_version.status_code == 400
    assert "unsafe plugin version path" in unsafe_version.json()["detail"]


def test_api_runtime_config_lists_defaults_and_redacts_secrets(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(
        json.dumps(
            {
                "backend": "hermes",
                "mode": "chat",
                "SUPERCLAW_CODEX_EXECUTABLE": "/tmp/codex",
                "SUPERCLAW_CLAUDE_MODEL": "claude-sonnet-4-5",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    monkeypatch.setenv("SUPERCLAW_GEMINI_API_KEY", "gemini-secret")

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/config")

    assert response.status_code == 200
    payload = response.json()
    entries = {entry["name"]: entry for entry in payload["entries"]}
    assert payload["config_path"] == str(shell_config)
    assert payload["defaults"] == {"backend": "hermes", "mode": "chat", "repo": None}
    assert payload["auth"]["gemini_api_key"] == "set"
    assert entries["SUPERCLAW_CODEX_EXECUTABLE"]["display_value"] == "/tmp/codex"
    assert entries["SUPERCLAW_CODEX_EXECUTABLE"]["source"] == "persisted"
    assert entries["SUPERCLAW_GEMINI_API_KEY"]["display_value"] == "set"
    assert entries["SUPERCLAW_GEMINI_API_KEY"]["value"] is None
    assert "gemini-secret" not in json.dumps(payload)


def test_api_media_status_reports_runninghub_key_count_without_values(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/media/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["configured"] is True
    assert payload["configured_key_count"] == 3
    assert {template["id"] for template in payload["templates"]} == {
        "text_to_image",
        "image_to_image",
        "image_to_video",
        "text_to_video",
    }
    for value in key_values:
        assert value not in response.text


def test_api_media_status_fail_soft_when_runninghub_unconfigured_in_a_bundle(tmp_path, monkeypatch):
    """A frozen distributed bundle without SUPERCLAW_RUNNINGHUB_BASE_URL is fail-closed for
    RunningHub, but the routine /api/media/status and /api/media/templates probes must NOT
    500 — they report the unconfigured state (base_url: null) so the media surface degrades
    cleanly instead of crashing on startup."""
    import superclaw.environment as environment

    monkeypatch.setattr(environment.sys, "frozen", True, raising=False)
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_BASE_URL", raising=False)
    # Keys present but base URL unresolved: doctor must NOT claim live-generation
    # readiness (generation would still fail-closed without a base URL).
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    status = client.get("/api/media/status")
    templates = client.get("/api/media/templates")
    doctor = client.get("/api/media/doctor")
    doctor_live = client.get("/api/media/doctor", params={"live_metadata": True})

    assert status.status_code == 200, status.text
    assert status.json()["base_url"] is None
    assert templates.status_code == 200, templates.text
    assert templates.json()["base_url"] is None
    # Diagnostics must also degrade cleanly — including the opt-in live-metadata probe,
    # which records a skipped check instead of crashing on the unresolved base URL.
    assert doctor.status_code == 200, doctor.text
    assert doctor.json()["base_url"] is None
    assert doctor_live.status_code == 200, doctor_live.text
    assert doctor_live.json()["base_url"] is None
    assert any(check["name"] == "live_sku.skipped" for check in doctor_live.json()["checks"])
    # No false-positive readiness: keys alone don't make it ready without a base URL.
    assert doctor.json()["ready_for_live_generation"] is False
    assert doctor_live.json()["ready_for_live_generation"] is False


def test_api_media_doctor_reports_readiness_without_key_values(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/media/doctor")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["ready_for_live_generation"] is True
    assert payload["configured_key_count"] == 3
    assert any(check["name"] == "credit_safety.live_metadata" for check in payload["checks"])
    for value in key_values:
        assert value not in response.text


def test_api_media_generate_dry_run_writes_sanitized_artifact(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    artifact_dir = tmp_path / "media-artifacts"

    response = client.post(
        "/api/media/generate",
        json={
            "template": "text_to_image",
            "prompt": "studio product photo",
            "dry_run": True,
            "artifact_dir": str(artifact_dir),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "dry_run"
    assert payload["template"]["webapp_id"] == "2004543847939751938"
    assert payload["template"]["mode"] == "standard-api"
    artifact_path = Path(payload["artifact_path"])
    assert artifact_path.exists()
    artifact_text = artifact_path.read_text(encoding="utf-8")
    assert "studio product photo" in artifact_text
    assert "apiKey" not in artifact_text
    for value in key_values:
        assert value not in response.text
        assert value not in artifact_text


def test_api_media_generate_dry_run_attaches_run_evidence(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _create_evidence_run(app, tmp_path / "run-artifacts")

    response = client.post(
        "/api/media/generate",
        json={
            "template": "text_to_image",
            "prompt": "studio product photo",
            "dry_run": True,
            "run_id": session.run_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["evidence_attached"] is True
    assert payload["run_id"] == session.run_id
    assert payload["run_artifact_url"] == f"/api/runs/{session.run_id}/artifacts/{payload['artifact_id']}"
    artifact_path = Path(payload["artifact_path"])
    assert artifact_path.exists()
    assert artifact_path.parent == (tmp_path / "run-artifacts" / session.run_id / "media").resolve()

    evidence = client.get(f"/api/runs/{session.run_id}/evidence").json()
    artifact = next(item for item in evidence["artifacts"] if item["artifact_id"] == payload["artifact_id"])
    assert artifact["kind"] == "runninghub-media-task-json"
    assert artifact["path"] == str(artifact_path.resolve())
    assert artifact["metadata"]["provider"] == "runninghub"
    assert artifact["metadata"]["template_id"] == "text_to_image"
    assert artifact["metadata"]["endpoint"] == payload["run_artifact_url"]

    download = client.get(payload["run_artifact_url"])
    assert download.status_code == 200
    downloaded_payload = download.json()
    assert downloaded_payload["artifact_id"] == payload["artifact_id"]
    assert downloaded_payload["endpoint"] == "http://127.0.0.1:8790/openapi/v2/rhart-image-n-pro/text-to-image"
    assert downloaded_payload["request"]["prompt"] == "studio product photo"
    assert downloaded_payload["request"]["aspectRatio"] == "9:16"
    assert downloaded_payload["request"]["resolution"] == "1k"

    event_types = [event["type"] for event in app.state.store.list_events(session.run_id)]
    assert "artifact.added" in event_types
    assert "media.generate.recorded" in event_types
    for value in key_values:
        assert value not in response.text
        assert value not in artifact_path.read_text(encoding="utf-8")


def test_api_media_render_attaches_generate_status_and_outputs_to_run(tmp_path, monkeypatch):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _create_evidence_run(app, tmp_path / "run-artifacts")

    def fake_render(request):
        artifact_dir = request.generation.artifact_dir
        assert artifact_dir is not None
        artifact_dir.mkdir(parents=True, exist_ok=True)
        steps = []
        for step_name, artifact_id, status, query in [
            ("generate", "runninghub_media_aaa111bbb222", "submitted", None),
            ("status", "runninghub_media_bbb222ccc333", "status_queried", "status"),
            ("outputs", "runninghub_media_ccc333ddd444", "outputs_queried", "outputs"),
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

    monkeypatch.setattr("apps.api.main.render_runninghub_media_task", fake_render)

    response = client.post(
        "/api/media/render",
        json={
            "template": "text_to_image",
            "prompt": "studio product photo",
            "dry_run": False,
            "run_id": session.run_id,
            "node_info_list": [{"nodeId": "6", "fieldName": "text", "fieldType": "STRING", "fieldValue": "studio product photo"}],
            "max_polls": 2,
            "poll_interval_seconds": 0,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "outputs_ready"
    assert payload["evidence_attached"] is True
    assert payload["output_urls"] == ["https://cdn.runninghub.ai/render.png"]
    assert payload["artifacts"][-1]["run_artifact_url"] == f"/api/runs/{session.run_id}/artifacts/runninghub_media_ccc333ddd444"

    evidence = client.get(f"/api/runs/{session.run_id}/evidence").json()
    kinds = [item["kind"] for item in evidence["artifacts"] if item["artifact_id"].startswith("runninghub_media_")]
    assert kinds == [
        "runninghub-media-task-json",
        "runninghub-media-status-json",
        "runninghub-media-outputs-json",
    ]
    event_types = [event["type"] for event in app.state.store.list_events(session.run_id)]
    assert "media.generate.recorded" in event_types
    assert "media.task_status.recorded" in event_types
    assert "media.outputs.recorded" in event_types


def test_api_media_run_attachment_rejects_artifact_dir_outside_run_root(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _create_evidence_run(app, tmp_path / "run-artifacts")

    response = client.post(
        "/api/media/generate",
        json={
            "template": "text_to_image",
            "prompt": "studio product photo",
            "dry_run": True,
            "run_id": session.run_id,
            "artifact_dir": str(tmp_path / "outside-run-root"),
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "media artifact_dir must be inside run artifact root"
    assert not (tmp_path / "outside-run-root").exists()


def test_api_media_upload_dry_run_writes_sanitized_artifact(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    upload_file = tmp_path / "input.png"
    upload_file.write_bytes(b"fake-png")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    artifact_dir = tmp_path / "media-artifacts"

    response = client.post(
        "/api/media/upload",
        json={
            "file_path": str(upload_file),
            "dry_run": True,
            "artifact_dir": str(artifact_dir),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "upload_dry_run"
    assert payload["file_name"] == "input.png"
    artifact_text = Path(payload["artifact_path"]).read_text(encoding="utf-8")
    assert "input.png" in artifact_text
    for value in key_values:
        assert value not in response.text
        assert value not in artifact_text


def test_api_media_generate_live_requires_key_and_node_info(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_API_KEYS", raising=False)
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_API_KEY", raising=False)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post(
        "/api/media/generate",
        json={
            "template": "text_to_image",
            "prompt": "studio product photo",
            "node_info_list": [{"nodeId": "6", "fieldName": "text", "fieldType": "STRING", "fieldValue": "studio product photo"}],
        },
    )

    assert response.status_code == 400
    assert response.json()["code"] == "MEDIA_REQUEST_BLOCKED"
    assert "SUPERCLAW_RUNNINGHUB_API_KEYS" in response.json()["detail"]


def test_api_media_outputs_query_requires_key(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_API_KEYS", raising=False)
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_API_KEY", raising=False)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post("/api/media/outputs", json={"task_id": "task_demo"})

    assert response.status_code == 400
    assert response.json()["code"] == "MEDIA_REQUEST_BLOCKED"
    assert "SUPERCLAW_RUNNINGHUB_API_KEYS" in response.json()["detail"]


def test_api_runtime_config_lists_runninghub_secret_redacted(tmp_path, monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/config")

    assert response.status_code == 200
    payload = response.json()
    assert payload["auth"]["runninghub_api_keys"] == "set"
    entry = next(item for item in payload["entries"] if item["name"] == "SUPERCLAW_RUNNINGHUB_API_KEYS")
    assert entry["secret"] is True
    assert entry["persist_allowed"] is False
    assert entry["display_value"] == "set"
    assert entry["value"] is None
    for value in key_values:
        assert value not in response.text


def test_api_runtime_config_set_persists_defaults_and_requires_restart_for_runtime_env(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    monkeypatch.delenv("SUPERCLAW_CODEX_EXECUTABLE", raising=False)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    backend = client.post("/api/config/set", json={"name": "backend", "value": "codex"})
    executable = client.post("/api/config/set", json={"name": "SUPERCLAW_CODEX_EXECUTABLE", "value": "/opt/codex"})
    status = client.get("/api/runtime/status")
    config = client.get("/api/config")

    assert backend.status_code == 200
    assert executable.status_code == 200
    assert backend.json()["updated"]["persisted"] is True
    assert backend.json()["updated"]["restart_required"] is False
    assert executable.json()["updated"]["persisted"] is True
    assert executable.json()["updated"]["restart_required"] is True
    assert status.json()["backend"] == "codex"
    assert config.json()["defaults"]["backend"] == "codex"
    assert json.loads(shell_config.read_text(encoding="utf-8")) == {
        "SUPERCLAW_CODEX_EXECUTABLE": "/opt/codex",
        "backend": "codex",
    }
    assert "SUPERCLAW_CODEX_EXECUTABLE" not in os.environ


def test_api_runtime_config_set_rejects_control_character_values(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post(
        "/api/config/set",
        json={"name": "SUPERCLAW_CODEX_EXECUTABLE", "value": "/opt/codex\rSUPERCLAW_GEMINI_API_KEY=leak"},
    )

    assert response.status_code == 400
    assert "control characters" in response.json()["detail"]
    assert "leak" not in response.text
    assert not shell_config.exists()


def test_shell_config_save_rejects_control_character_names_and_values(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))

    for name, value in [
        ("SUPERCLAW_CODEX_EXECUTABLE\rBAD", "/opt/codex"),
        ("SUPERCLAW_CODEX_EXECUTABLE", "/opt/codex\t--unsafe"),
    ]:
        with pytest.raises(ValueError, match="control characters|invalid shell config"):
            save_shell_config_value(name, value)

    assert not shell_config.exists()


def test_runtime_config_ignores_persisted_control_character_values(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(
        json.dumps(
            {
                "SUPERCLAW_CODEX_EXECUTABLE": "/opt/codex\rSUPERCLAW_GEMINI_API_KEY=leak",
                "SUPERCLAW_CLAUDE_MODEL": "claude-sonnet-4-5",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))
    monkeypatch.delenv("SUPERCLAW_CODEX_EXECUTABLE", raising=False)

    persisted = persisted_runtime_environment()
    payload = runtime_config_payload()
    entries = {entry["name"]: entry for entry in payload["entries"]}
    payload_text = json.dumps(payload)

    assert persisted == {"SUPERCLAW_CLAUDE_MODEL": "claude-sonnet-4-5"}
    assert entries["SUPERCLAW_CODEX_EXECUTABLE"]["configured"] is False
    assert entries["SUPERCLAW_CODEX_EXECUTABLE"]["source"] == "default"
    assert "leak" not in payload_text


def test_api_runtime_config_set_rejects_secret_and_auth_only_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    secret = client.post("/api/config/set", json={"name": "SUPERCLAW_GEMINI_API_KEY", "value": "secret"})
    auth = client.post("/api/config/set", json={"name": "CLAWHUNT_AGENT_API_KEY", "value": "secret"})

    assert secret.status_code == 400
    assert "dedicated secret flow" in secret.json()["detail"]
    assert auth.status_code == 400
    assert "use /login CLAWHUNT_AGENT_KEY" in auth.json()["detail"]


def test_api_agents_include_configure_hints_and_config_state(tmp_path, monkeypatch):
    shell_config = tmp_path / "shell-config.json"
    shell_config.write_text(
        json.dumps(
            {
                "SUPERCLAW_CODEX_EXECUTABLE": "/opt/codex",
                "SUPERCLAW_CLAUDE_MODEL": "claude-opus-4-8",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(shell_config))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/agents")

    assert response.status_code == 200
    payload = response.json()
    agents = {item["name"]: item for item in payload["agents"]}
    assert agents["local"]["kind"] == "builtin"
    assert agents["local"]["config_state"] == "built-in"
    assert agents["codex"]["config_env"] == "SUPERCLAW_CODEX_EXECUTABLE"
    assert agents["codex"]["config_state"] == "/opt/codex"
    assert agents["codex"]["configure"].endswith("/path/to/codex")
    assert agents["claude"]["model_env"] == "SUPERCLAW_CLAUDE_MODEL"
    assert agents["claude"]["model_state"] == "claude-opus-4-8"


def test_api_clawhunt_auth_status_login_logout_and_profile(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    # Targets the production ClawHunt host, so declare the production environment —
    # otherwise the default (staging) trips the cross-environment contamination guard.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://clawhunt.store")
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)
    monkeypatch.setattr("apps.api.main.ClawHuntClient.me", lambda self: {"ok": True, "status_code": 200, "body": {"handle": "agent-01"}})

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    status_before = client.get("/api/auth/status")
    profile_before = client.get("/api/auth/clawhunt/me")
    login = client.post("/api/auth/clawhunt/login", json={"agent_api_key": "cph_secret_123"})
    profile_after = client.get("/api/auth/clawhunt/me")

    assert status_before.status_code == 200
    assert status_before.json()["clawhunt"]["agent_api_key"] == "unset"
    assert profile_before.status_code == 401
    assert login.status_code == 200
    assert login.json()["clawhunt"]["agent_api_key"] == "set"
    assert login.json()["clawhunt"]["agent_key_source"] == "manual"
    assert profile_after.status_code == 200
    assert profile_after.json()["body"]["handle"] == "agent-01"
    assert auth_path.exists()
    logout = client.post("/api/auth/clawhunt/logout")
    assert logout.status_code == 200
    assert logout.json()["clawhunt"]["agent_api_key"] == "unset"
    assert logout.json()["clawhunt"]["account"] == "unset"
    assert not auth_path.exists()


def test_api_clawhunt_account_login_and_agent_key_creation(tmp_path, monkeypatch):
    # Production host -> declare production so the staging contamination guard stays quiet.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://clawhunt.store")
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class FakeClawHuntAccountClient:
        settings = type("Settings", (), {"base_url": "https://clawhunt.store"})()

        def login_probe(self):
            return {"ok": False, "status_code": 401, "body": {"detail": "用户名或密码错误"}}

        def login(self, username, password):
            assert username == "leon"
            assert password == "secret"
            return {"ok": True, "status_code": 200, "body": {"access_token": "account-token", "user": {"username": "leon"}}}

        def me(self, access_token):
            assert access_token == "account-token"
            return {"ok": True, "status_code": 200, "body": {"username": "leon", "id": 9}}

        def agents(self, access_token):
            assert access_token == "account-token"
            return {"ok": True, "status_code": 200, "body": {"agents": [{"id": 12, "name": "desktop-agent"}]}}

        def create_agent_key(self, access_token, *, name, agent_id, permissions):
            assert access_token == "account-token"
            assert name == "SuperClaw Desktop"
            assert agent_id == 12
            assert permissions == ["browse", "bid"]
            return {"ok": True, "status_code": 200, "body": {"key": "cph_generated_123"}}

    monkeypatch.setattr("apps.api.main.ClawHuntAccountClient", FakeClawHuntAccountClient)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    status_before = client.get("/api/auth/status")
    login_probe = client.get("/api/auth/clawhunt/account/login-probe")
    login = client.post("/api/auth/clawhunt/account/login", json={"username": " leon ", "password": "secret"})
    me = client.get("/api/auth/clawhunt/account/me")
    agents = client.get("/api/auth/clawhunt/account/agents")
    key = client.post(
        "/api/auth/clawhunt/agent-key",
        json={"agent_id": 12, "name": "SuperClaw Desktop", "permissions": ["browse", "bid"]},
    )
    status_after = client.get("/api/auth/status")

    assert status_before.status_code == 200
    assert status_before.json()["clawhunt"]["account"] == "unset"
    assert login_probe.status_code == 200
    assert login_probe.json()["ok"] is True
    assert login_probe.json()["reachable"] is True
    assert login_probe.json()["login_endpoint"] is True
    assert login_probe.json()["status_code"] == 401
    assert login.status_code == 200
    assert login.json()["auth"]["clawhunt"]["account"] == "set"
    assert login.json()["auth"]["clawhunt"]["account_user"]["username"] == "leon"
    assert me.status_code == 200
    assert me.json()["body"]["id"] == 9
    assert agents.status_code == 200
    assert agents.json()["body"]["agents"][0]["name"] == "desktop-agent"
    assert key.status_code == 200
    assert key.json()["auth"]["clawhunt"]["agent_api_key"] == "set"
    assert key.json()["auth"]["clawhunt"]["agent_key_source"] == "account"
    assert key.json()["agent_key"] == {"status": "set", "source": "account", "name": "SuperClaw Desktop", "agent_id": 12}
    assert "cph_generated_123" not in json.dumps(key.json())
    assert os.environ["CLAWHUNT_AGENT_API_KEY"] == "cph_generated_123"
    assert status_after.json()["clawhunt"]["agent_key_name"] == "SuperClaw Desktop"


def test_api_clawhunt_browser_login_start_and_callback_persist_shared_account(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    # Production host -> declare production so the staging contamination guard stays quiet.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://clawhunt.store")
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class FakeClawHuntAccountClient:
        settings = type("Settings", (), {"base_url": "https://clawhunt.store"})()

        def profile(self, access_token):
            assert access_token == "account-token"
            return {"ok": True, "status_code": 200, "body": {"username": "leon", "email": "leon@example.test"}}

    monkeypatch.setattr("apps.api.main.ClawHuntAccountClient", FakeClawHuntAccountClient)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    start = client.get("/api/auth/clawhunt/browser/start?provider=google")

    assert start.status_code == 200
    start_payload = start.json()
    assert start_payload["source"] == "superclaw"
    assert "google-oauth-bridge.html" in start_payload["login_url"]
    assert "source=superclaw" in start_payload["login_url"]
    assert "client=superclaw" in start_payload["login_url"]
    assert "/api/auth/clawhunt/browser/callback" in start_payload["callback_url"]
    callback_state = start_payload["callback_url"].split("state=", 1)[1].split("&", 1)[0]

    callback = client.get(f"/api/auth/clawhunt/browser/callback?state={callback_state}&source=superclaw&token=account-token")
    status = client.get("/api/auth/status")

    assert callback.status_code == 200
    assert "SuperClaw login complete" in callback.text
    assert status.json()["clawhunt"]["account"] == "set"
    assert status.json()["clawhunt"]["account_user"]["username"] == "leon"
    assert status.json()["clawhunt"]["account_source"] == "clawhunt_google_browser"
    assert status.json()["clawhunt"]["login_source"] == "superclaw"
    saved = json.loads(auth_path.read_text(encoding="utf-8"))
    assert saved["access_token"] == "account-token"
    assert "browser_login_state" not in saved


def test_api_clawhunt_browser_callback_rejects_missing_superclaw_source(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    start = client.get("/api/auth/clawhunt/browser/start?provider=google")
    callback_state = start.json()["callback_url"].split("state=", 1)[1].split("&", 1)[0]
    callback = client.get(f"/api/auth/clawhunt/browser/callback?state={callback_state}&token=account-token")

    assert callback.status_code == 400
    assert "Missing SuperClaw login source marker" in callback.text
    assert json.loads((tmp_path / "clawhunt-auth.json").read_text(encoding="utf-8"))["browser_login_state"] == callback_state


def test_api_clawhunt_browser_callback_consumes_valid_state_on_clawhunt_error(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    start = client.get("/api/auth/clawhunt/browser/start?provider=google")
    callback_state = start.json()["callback_url"].split("state=", 1)[1].split("&", 1)[0]
    callback = client.get(f"/api/auth/clawhunt/browser/callback?state={callback_state}&source=superclaw&error=access_denied")

    assert callback.status_code == 400
    assert "SuperClaw login failed" in callback.text
    saved = json.loads(auth_path.read_text(encoding="utf-8"))
    assert "browser_login_state" not in saved
    replay = client.get(f"/api/auth/clawhunt/browser/callback?state={callback_state}&source=superclaw&token=account-token")
    assert replay.status_code == 401


def test_api_clawhunt_browser_callback_exchanges_handoff_code(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))

    class FakeClawHuntAccountClient:
        settings = type("Settings", (), {"base_url": "https://clawhunt.store"})()

        def exchange_cli_handoff(self, handoff_code):
            assert handoff_code == "handoff-code"
            return {"ok": True, "status_code": 200, "body": {"access_token": "account-token", "user": {"username": "leon"}}}

    monkeypatch.setattr("apps.api.main.ClawHuntAccountClient", FakeClawHuntAccountClient)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    start = client.get("/api/auth/clawhunt/browser/start?provider=website")
    callback_state = start.json()["callback_url"].split("state=", 1)[1].split("&", 1)[0]
    callback = client.get(f"/api/auth/clawhunt/browser/callback?state={callback_state}&source=superclaw&handoff_code=handoff-code")
    status = client.get("/api/auth/status")

    assert callback.status_code == 200
    assert status.json()["clawhunt"]["account"] == "set"
    assert status.json()["clawhunt"]["account_user"]["username"] == "leon"
    assert status.json()["clawhunt"]["account_source"] == "clawhunt_website_browser"


def test_api_clawhunt_account_login_probe_reports_network_error_without_throwing(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))

    class FailingClawHuntAccountClient:
        settings = type("Settings", (), {"base_url": "https://clawhunt.store"})()

        def login_probe(self):
            raise httpx.ConnectError("no route")

    monkeypatch.setattr("apps.api.main.ClawHuntAccountClient", FailingClawHuntAccountClient)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/auth/clawhunt/account/login-probe")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["reachable"] is False
    assert payload["login_endpoint"] is False
    assert payload["status_code"] == 0
    assert "ConnectError" in payload["detail"]


def test_api_clawhunt_failed_account_login_does_not_persist_auth(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    class RejectingClawHuntAccountClient:
        def login(self, username, password):
            return {"ok": False, "status_code": 401, "body": {"detail": "bad credentials"}}

    monkeypatch.setattr("apps.api.main.ClawHuntAccountClient", RejectingClawHuntAccountClient)

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.post("/api/auth/clawhunt/account/login", json={"username": "leon", "password": "wrong"})

    assert response.status_code == 401
    assert response.json()["detail"] == "bad credentials"
    assert not auth_path.exists()
    assert "CLAWHUNT_AGENT_API_KEY" not in os.environ


def test_api_clawhunt_live_readiness_uses_shared_read_only_gate(tmp_path, monkeypatch):
    calls = []

    class FakeClawHuntClient:
        def live_readiness_report(self, *, authenticated_read=False, require_payment=False, include_probe=True):
            calls.append((authenticated_read, require_payment, include_probe))
            return {
                "status": "ready",
                "scope": "read_only_production_gate",
                "credentials": {"agent_api_key": "set"},
                "requirements": {"mutating_operations_attempted": False},
                "readiness": {"read_only_gate": True},
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FakeClawHuntClient)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get(
        "/api/clawhunt/live-readiness",
        params={"authenticated_read": True, "require_payment": True, "include_probe": False},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["requirements"]["mutating_operations_attempted"] is False
    assert calls == [(True, True, False)]


def test_api_clawhunt_task_browser_and_detail(tmp_path, monkeypatch):
    browse_calls = []

    class FakeClawHuntClient:
        # The dock now browses the PUBLIC web endpoint anonymously, which returns a
        # bare array of problems (no agent envelope, no agent key).
        def browse_marketplace(self, **params):
            browse_calls.append(params)
            return {
                "ok": True,
                "status_code": 200,
                "body": [
                    {
                        "id": 101,
                        "title": "Fix webhook retries",
                        "summary": "Duplicate webhook deliveries are not deduped.",
                        "status": "open",
                        "difficulty": "medium",
                        "price": 250,
                        "category": "backend",
                        "tags": ["webhook", "payments"],
                    },
                    {
                        "id": 202,
                        "title": "Repair desktop updater",
                        "description": "Desktop users need a guided update path.",
                        "state": "claimed",
                        "bounty": 480,
                        "owner": {"handle": "ops-12"},
                    },
                ],
            }

        def get_problem_marketplace(self, problem_id):
            assert problem_id == 202
            # Public detail returns the problem object directly (ProblemResponse).
            return {
                "ok": True,
                "status_code": 200,
                "body": {
                    "id": 202,
                    "title": "Repair desktop updater",
                    "description": "Desktop users need a guided update path.",
                    "state": "claimed",
                    "bounty": 480,
                    "owner": {"handle": "ops-12"},
                    "url": "https://clawhunt.store/problems/202",
                },
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FakeClawHuntClient)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    listing = client.get("/api/clawhunt/tasks")
    detail = client.get("/api/clawhunt/tasks/202")

    assert listing.status_code == 200
    assert listing.json()["count"] == 2
    assert listing.json()["tasks"][0]["id"] == 101
    assert listing.json()["tasks"][0]["title"] == "Fix webhook retries"
    assert listing.json()["tasks"][0]["price"] == 250
    assert listing.json()["tasks"][1]["owner"] == "ops-12"
    # Public body is a bare array, surfaced verbatim via `raw`.
    assert listing.json()["raw"][0]["summary"] == "Duplicate webhook deliveries are not deduped."
    # The public list has no upstream has_more and no post-filtering, so the
    # full-page heuristic is exact: 2 items < limit 50 => no more.
    assert listing.json()["has_more"] is False
    # Default page forwards skip/limit to the public browse call.
    assert browse_calls == [{"skip": 0, "limit": 50}]

    # Pagination + status are forwarded verbatim, matching the CLI
    # `clawhunt browse --skip/--limit/--status` contract; status is trimmed.
    paged = client.get("/api/clawhunt/tasks?skip=12&limit=12&status=%20open%20")
    assert paged.status_code == 200
    assert paged.json()["skip"] == 12
    assert paged.json()["limit"] == 12
    assert browse_calls[-1] == {"skip": 12, "limit": 12, "status": "open"}

    # Out-of-range pagination is rejected (422), same as the CLI's typer bounds —
    # the API does not silently clamp.
    assert client.get("/api/clawhunt/tasks?limit=0").status_code == 422
    assert client.get("/api/clawhunt/tasks?skip=-1").status_code == 422
    assert client.get("/api/clawhunt/tasks?limit=99").status_code == 422

    assert detail.status_code == 200
    assert detail.json()["task"]["id"] == 202
    assert detail.json()["task"]["status"] == "claimed"
    assert detail.json()["task"]["bounty"] == 480
    assert detail.json()["problem_payload"]["title"] == "Repair desktop updater"
    assert detail.json()["task"]["url"] == "https://clawhunt.store/problems/202"
    assert detail.json()["raw"]["description"] == "Desktop users need a guided update path."


def test_api_clawhunt_tasks_has_more_from_full_public_page(tmp_path, monkeypatch):
    # The public list returns a bare array with no post-filtering, so a FULL page
    # (item count == limit) is the exact signal that more pages remain, while a
    # short page is the genuine end. The endpoint derives has_more accordingly.
    class FakeClawHuntClient:
        def browse_marketplace(self, **params):
            limit = params["limit"]
            return {
                "ok": True,
                "status_code": 200,
                "body": [{"id": n, "title": f"Task {n}", "status": "open"} for n in range(limit)],
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FakeClawHuntClient)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    full = client.get("/api/clawhunt/tasks?limit=12")
    assert full.status_code == 200
    assert full.json()["count"] == 12
    assert full.json()["has_more"] is True  # full page => more remain


def test_api_clawhunt_tasks_counts_nested_data_envelope(tmp_path, monkeypatch):
    # ClawHunt also returns the list NESTED under a `data` envelope
    # ({success, data:{problems, has_more}}). The dock delegates to the SAME shared
    # kernel parser the governed marketplace handler uses, so it must recurse into the
    # envelope (a list-only walk under-counted to 0) and honour the upstream has_more.
    class NestedClawHuntClient:
        def browse_marketplace(self, **params):
            return {
                "ok": True,
                "status_code": 200,
                "body": {
                    "success": True,
                    "data": {
                        "problems": [
                            {"id": 1, "title": "a", "status": "open"},
                            {"id": 2, "title": "b", "status": "open"},
                        ],
                        "has_more": True,
                    },
                },
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", NestedClawHuntClient)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    resp = client.get("/api/clawhunt/tasks?limit=50")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2  # NOT 0 — recurses the nested `data` envelope
    assert len(body["tasks"]) == 2
    assert body["has_more"] is True  # authoritative upstream signal, not the heuristic


def test_api_clawhunt_tasks_fail_closed_on_upstream_error(tmp_path, monkeypatch):
    # When the upstream browse fails (e.g. a CF-gate challenge or 5xx), the endpoint
    # must NOT surface tasks parsed from the error body — it fails closed with an
    # empty list + ok:false so the Web dock renders "unavailable" rather than
    # leaking problems or showing a misleading empty market.
    class FailingClawHuntClient:
        def browse_marketplace(self, **params):
            return {
                "ok": False,
                "status_code": 401,
                "body": {
                    "detail": "Missing or invalid Authorization header.",
                    "problems": [{"id": 999, "title": "Should not be exposed", "status": "open"}],
                },
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FailingClawHuntClient)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/clawhunt/tasks")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["tasks"] == []
    assert body["count"] == 0
    # Fail-closed: an unavailable market has no next page to chase.
    assert body["has_more"] is False
    # Fail-closed: the failed upstream body (which here carries a stray
    # `problems` entry) must not leak back through `raw` either.
    assert body["raw"] is None


def test_api_clawhunt_task_detail_fails_closed_on_upstream_error(tmp_path, monkeypatch):
    # The detail endpoint must fail closed like the list: a failed upstream (CF gate
    # challenge / 401 / 5xx) must not surface a parsed task or echo the error body
    # back through `raw`, so the dock keeps the teaser instead of a broken detail.
    class FailingClawHuntClient:
        def get_problem_marketplace(self, problem_id, **kwargs):
            return {
                "ok": False,
                "status_code": 502,
                "body": {"id": problem_id, "title": "Should not be exposed", "secret": "leak"},
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FailingClawHuntClient)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.get("/api/clawhunt/tasks/77")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["task"] is None
    assert body["problem_payload"] is None
    assert body["raw"] is None


def test_api_sidecar_cors_allows_local_web_origins(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.options(
        "/api/runtime/status",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-SuperClaw-Token",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "X-SuperClaw-Token".lower() in response.headers["access-control-allow-headers"].lower()


def test_api_eval_product_sync_report_events_and_artifact(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_EVAL_ROOT", str(tmp_path / "evals"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    created = client.post(
        "/api/evals",
        json={"agent": "superclaw", "case_id": "mini-pay-webhook", "async_execution": False, "timeout_seconds": 120},
    )

    assert created.status_code == 200, created.text
    body = created.json()
    eval_id = body["eval_id"]
    assert body["verdict"] == "E2E_PROVEN"
    listing = client.get("/api/evals")
    detail = client.get(f"/api/evals/{eval_id}")
    events = client.get(f"/api/evals/{eval_id}/events")
    report = client.get(f"/api/evals/{eval_id}/report")
    report_pdf = client.get(f"/api/evals/{eval_id}/report.pdf")
    cancel = client.post(f"/api/evals/{eval_id}/cancel")
    artifact_id = body["agents"][0]["artifacts"][0]["artifact_id"]
    artifact = client.get(f"/api/evals/{eval_id}/artifacts/{artifact_id}")

    assert listing.status_code == 200
    assert any(item["eval_id"] == eval_id for item in listing.json()["evals"])
    assert detail.status_code == 200
    assert events.status_code == 200
    assert "event: eval.completed" in events.text
    assert report.status_code == 200
    assert "SuperClaw Delivery Gap Eval" in report.text
    assert report_pdf.status_code == 200
    assert report_pdf.headers["content-type"].startswith("application/pdf")
    assert report_pdf.content.startswith(b"%PDF")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancel_requested"
    assert artifact.status_code == 200
    assert artifact.json()["agent"] == "superclaw"


def test_api_eval_fusion_export_artifacts_are_downloadable(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_EVAL_ROOT", str(tmp_path / "evals"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    created = client.post(
        "/api/evals",
        json={"agent": "superclaw", "case_id": FUSION_CASE_ID, "async_execution": False, "timeout_seconds": 120},
    )

    assert created.status_code == 200, created.text
    body = created.json()
    eval_id = body["eval_id"]
    artifact_id = next(item["artifact_id"] for item in body["agents"][0]["artifacts"] if item["kind"] == "fusion-openpencil-export-html")
    artifact = client.get(f"/api/evals/{eval_id}/artifacts/{artifact_id}")

    assert artifact.status_code == 200
    assert "react-tailwind" in artifact.text


def test_api_eval_artifact_download_rejects_paths_outside_eval_dir(tmp_path, monkeypatch):
    eval_root = tmp_path / "evals"
    monkeypatch.setenv("SUPERCLAW_EVAL_ROOT", str(eval_root))
    private_file = tmp_path / "private" / "not-eval-evidence.txt"
    private_file.parent.mkdir()
    private_file.write_text("local secret outside eval artifacts", encoding="utf-8")
    eval_dir = eval_root / "eval_polluted"
    eval_dir.mkdir(parents=True)
    (eval_dir / "report.json").write_text(
        json.dumps(
            {
                "eval_id": "eval_polluted",
                "case_id": "mini-pay-webhook",
                "status": "completed",
                "verdict": "E2E_PROVEN",
                "agents": [],
                "score_summary": {},
                "artifacts": [
                    {
                        "artifact_id": "eval_private_path",
                        "kind": "evidence-json",
                        "path": str(private_file),
                    }
                ],
                "created_at": time.time(),
                "completed_at": time.time(),
            }
        ),
        encoding="utf-8",
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/evals/eval_polluted/artifacts/eval_private_path")

    assert response.status_code == 404
    assert response.json()["detail"] == "eval artifact not found"
    assert "local secret outside eval artifacts" not in response.text


def test_api_harness_emit_is_controlled_and_writes_artifacts(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    plugin_dir = tmp_path / "source" / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text('{"description":"Demo"}', encoding="utf-8")
    (plugin_dir / "skills" / "ship").mkdir(parents=True)
    (plugin_dir / "skills" / "ship" / "SKILL.md").write_text("---\nname: ship\ndescription: ship\n---\nBody", encoding="utf-8")

    response = client.post(
        "/api/harnesses/emit",
        json={
            "source_root": str(tmp_path / "source"),
            "output_root": str(tmp_path / "generated"),
            "target": "opencode",
            "plugins": ["demo"],
        },
    )

    assert response.status_code == 200
    assert response.json()["target"] == "opencode"
    assert (tmp_path / "generated" / ".opencode" / "skills" / "demo-ship" / "SKILL.md").exists()

    validate = client.post(
        "/api/harnesses/validate",
        json={"output_root": str(tmp_path / "generated"), "target": "opencode"},
    )
    assert validate.status_code == 200
    assert validate.json()["ok"] is True


def test_api_async_run_streams_live_worker_events(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Async", "description": "Run a worker"}).json()

    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": False,
            "async_execution": True,
            "backend_policy": "local",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
        },
    )

    assert run.status_code == 200
    body = run.json()
    assert body["status"] in {"queued", "running", "completed"}
    stream = client.get(f"/api/runs/{body['run_id']}/events")
    assert stream.status_code == 200
    assert "event: run.started" in stream.text
    assert "event: command.started" in stream.text
    assert "event: command.completed" in stream.text
    assert "event: verification.finding" in stream.text
    assert "event: run.completed" in stream.text

    evidence = client.get(f"/api/runs/{body['run_id']}/evidence").json()
    assert evidence["worker_results"]
    assert evidence["findings"]


def test_api_cancel_requests_process_level_worker_cancel(tmp_path):
    class SlowBackend(LocalShellBackend):
        name = "slow"

        def _default_command(self, task, goal):
            return [
                sys.executable,
                "-c",
                "import signal, time; signal.signal(signal.SIGTERM, lambda *_: None); print('slow-start', flush=True); time.sleep(10)",
            ]

    app = create_app(state_path=tmp_path / "state.db")
    app.state.orchestrator.backends["slow"] = SlowBackend()
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Cancel", "description": "Stop active worker"}).json()
    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": False,
            "async_execution": True,
            "backend_policy": "slow",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
        },
    ).json()
    run_id = run["run_id"]

    # Generous timeouts: real-subprocess force-kill escalation can exceed a few
    # seconds under heavy machine load. This keeps the test robust without
    # changing what it verifies — it still breaks out the instant the event fires.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(event["type"] == "command.started" for event in app.state.store.list_events(run_id)):
            break
        time.sleep(0.05)
    else:
        raise AssertionError("worker command did not start")

    cancel = client.post(f"/api/runs/{run_id}/cancel")
    app.state.orchestrator._threads[run_id].join(timeout=30)
    events = client.get(f"/api/runs/{run_id}/events").text
    evidence = client.get(f"/api/runs/{run_id}/evidence").json()

    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"
    assert cancel.json()["accepted"] is True
    assert "event: run.cancel.requested" in events
    assert "event: worker.cancelled" in events
    assert "event: worker.forced_kill" in events
    assert evidence["worker_results"][0]["cancelled"] is True
    assert evidence["worker_results"][0]["exit_code"] == 130
    assert evidence["worker_results"][0]["forced_kill"] is True


def test_api_cancel_ignores_completed_run(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Cancel", "description": "Ignore terminal"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    cancel = client.post(f"/api/runs/{run['run_id']}/cancel")
    events = client.get(f"/api/runs/{run['run_id']}/events").text
    latest = client.get(f"/api/runs/{run['run_id']}").json()

    assert cancel.status_code == 200
    assert cancel.json()["status"] == "completed"
    assert cancel.json()["accepted"] is False
    assert cancel.json()["event_type"] == "run.cancel.ignored"
    assert latest["status"] == "completed"
    assert "event: run.cancel.ignored" in events


def test_api_clawhunt_submit_disabled_by_default(tmp_path, monkeypatch):
    """The legacy direct /api/clawhunt/submit is fail-closed disabled by default —
    it bypasses the marketplace order ledger + completion + approval gates."""
    monkeypatch.delenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", raising=False)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "T", "description": "D"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()
    response = client.post("/api/clawhunt/submit", json={"problem_id": 1, "run_id": run["run_id"]})
    assert response.status_code == 403


def test_api_clawhunt_submit_uses_protocol_adapter_payload(tmp_path, monkeypatch):
    # The legacy direct /api/clawhunt/submit endpoint is fail-closed disabled by
    # default (governed marketplace path is authoritative); this test exercises the
    # raw protocol-adapter payload via the deliberate operator override.
    monkeypatch.setenv("SUPERCLAW_ALLOW_LEGACY_CLAWHUNT_WRITE", "1")
    captured = {}

    class FakeClawHuntClient:
        def submit_solution(self, problem_id, submission, evidence=None, *, attachments=None):
            captured["problem_id"] = problem_id
            captured["submission"] = submission
            captured["evidence"] = evidence
            captured["attachments"] = attachments
            return {"status_code": 200, "ok": True, "body": {"accepted": True}}

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FakeClawHuntClient)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Submit", "description": "Protocol adapter"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    response = client.post("/api/clawhunt/submit", json={"problem_id": 77, "run_id": run["run_id"]})
    evidence = client.get(f"/api/runs/{run['run_id']}/evidence").json()

    assert response.status_code == 200
    assert captured["problem_id"] == 77
    assert captured["evidence"] is None
    assert captured["attachments"] is None
    assert captured["submission"].adapter_name == "clawhunt.v1.solution"
    assert captured["submission"].request_json["solution_text"].startswith(f"SuperClaw completed run {run['run_id']}")
    assert captured["submission"].request_json["attachments"] == [f"superclaw-run:{run['run_id']}"]
    assert captured["submission"].request_json["evidence"]["run_id"] == run["run_id"]
    assert evidence["submitted_to_clawhunt"] is True


def test_api_human_gate_pause_and_resume(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Gate", "description": "Needs human"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    pause = client.post(f"/api/runs/{run['run_id']}/human-gate", json={"reason": "OTP required"})
    resume = client.post(f"/api/runs/{run['run_id']}/resume")
    events = client.get(f"/api/runs/{run['run_id']}/events").text

    assert pause.status_code == 200
    assert pause.json()["status"] == "WAITING_FOR_HUMAN_GATE"
    assert resume.status_code == 200
    assert resume.json()["status"] == "completed"
    assert "event: run.paused" in events
    assert "event: run.resumed" in events


def test_api_reconcile_reports_resumable_stale_run(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = app.state.store.create_goal(GoalSpec(title="Stale", description="Resume me"))
    session = app.state.orchestrator.create_run_session(
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
    app.state.store.save_run(session)
    app.state.store.create_evidence(session.run_id)

    response = client.post(f"/api/runs/{session.run_id}/reconcile")

    assert response.status_code == 200
    assert response.json()["classification"] == "resumable"
    assert response.json()["status"] == "queued"


def _seed_stale_running_run(state_path, repo_path):
    store = StateStore(state_path)
    from superclaw.orchestrator import SuperClawOrchestrator

    orchestrator = SuperClawOrchestrator(store)
    goal = store.create_goal(GoalSpec(title="Ghost", description="claims running, nobody works it"))
    session = orchestrator.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=repo_path,
        artifact_dir=repo_path / "artifacts",
        budget_seconds=20,
    )
    session.status = "running"
    assert session.task_graph is not None
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    store.create_evidence(session.run_id)
    return session.run_id


def test_api_startup_reconciles_stale_running_runs(tmp_path):
    state_path = tmp_path / "state.db"
    run_id = _seed_stale_running_run(state_path, tmp_path)

    app = create_app(state_path=state_path)

    assert run_id in app.state.startup_reconciled_run_ids
    healed = app.state.store.get_run(run_id)
    assert healed.status in {"queued", "failed"}


def test_api_get_run_lazily_reconciles_stale_executing_claim(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    run_id = _seed_stale_running_run(tmp_path / "state.db", tmp_path)

    response = client.get(f"/api/runs/{run_id}")

    assert response.status_code == 200
    assert response.json()["status"] in {"queued", "failed"}
    assert app.state.store.get_run(run_id).status in {"queued", "failed"}


def test_api_chat_session_activity_derives_from_linked_run_liveness(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    store = app.state.store

    ghost = store.create_chat_session("ghost tail")
    store.append_chat_message(ghost.session_id, "user", "你是什么模型")

    settled = store.create_chat_session("settled")
    store.append_chat_message(settled.session_id, "user", "hi")
    store.append_chat_message(settled.session_id, "assistant", "hello")

    live = store.create_chat_session("live")
    store.append_chat_message(live.session_id, "user", "do something")
    goal = store.create_goal(GoalSpec(title="Live", description="worked by a fresh lease"))
    run = store.create_run(goal.goal_id, dry_run=False)
    run.chat_session_id = live.session_id
    run.status = "queued"
    store.save_run(run)
    run.status = "running"
    run.active_mutation_lease = RunMutationLease(
        resource=f"run:{run.run_id}",
        owner="execute:live",
        mode=RunMutationMode.EXECUTE,
    )
    store.save_run(run)

    dead = store.create_chat_session("dead run")
    store.append_chat_message(dead.session_id, "user", "stalled work")
    dead_goal = store.create_goal(GoalSpec(title="Dead", description="claims running, no lease"))
    dead_run = store.create_run(dead_goal.goal_id, dry_run=False)
    dead_run.chat_session_id = dead.session_id
    dead_run.status = "queued"
    store.save_run(dead_run)
    dead_run.status = "running"
    store.save_run(dead_run)

    sessions = {item["session_id"]: item for item in client.get("/api/chat/sessions").json()["sessions"]}

    ghost_activity = sessions[ghost.session_id]["activity"]
    assert ghost_activity["status"] == "interrupted"
    assert ghost_activity["is_live"] is False
    assert ghost_activity["legacy_incomplete_tail"] is True

    settled_activity = sessions[settled.session_id]["activity"]
    assert settled_activity["status"] == "idle"
    assert settled_activity["is_live"] is False

    live_activity = sessions[live.session_id]["activity"]
    assert live_activity["status"] == "live"
    assert live_activity["is_live"] is True
    assert live_activity["run_id"] == run.run_id

    dead_activity = sessions[dead.session_id]["activity"]
    assert dead_activity["status"] == "interrupted"
    assert dead_activity["is_live"] is False
    assert dead_activity["reason"] == "no active mutation lease"

    # Run read payloads carry the liveness-backed view for every surface.
    runs_payload = {item["run_id"]: item for item in client.get("/api/runs").json()["runs"]}
    assert runs_payload[run.run_id]["is_live"] is True
    assert runs_payload[run.run_id]["effective_status"] == "running"
    assert runs_payload[dead_run.run_id]["is_live"] is False
    assert runs_payload[dead_run.run_id]["effective_status"] == "failed"
    assert runs_payload[dead_run.run_id]["stale_reason"] == "no active mutation lease"


def test_api_reconcile_reports_cancelled_stale_run(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = app.state.store.create_goal(GoalSpec(title="Stale cancel", description="Cancel me"))
    session = app.state.orchestrator.create_run_session(
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
    app.state.store.save_run(session)
    app.state.store.create_evidence(session.run_id)
    app.state.store.add_event(session.run_id, "run.cancel.requested", {"run_id": session.run_id})

    response = client.post(f"/api/runs/{session.run_id}/reconcile")

    assert response.status_code == 200
    assert response.json()["classification"] == "cancelled"
    assert response.json()["status"] == "cancelled"


def test_api_reconcile_reclaims_dead_worker_pid_lease_before_ttl(tmp_path, monkeypatch):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = app.state.store.create_goal(GoalSpec(title="Dead pid", description="Reclaim stale local worker"))
    session = app.state.orchestrator.create_run_session(
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
    app.state.store.save_run(session)
    app.state.store.create_evidence(session.run_id)

    def fake_kill(pid, signal):
        assert signal == 0
        if pid == dead_pid:
            raise ProcessLookupError(pid)

    monkeypatch.setattr("superclaw.orchestrator.os.kill", fake_kill)

    response = client.post(f"/api/runs/{session.run_id}/reconcile")
    persisted = app.state.store.get_run(session.run_id)
    stale_event = next(
        event for event in app.state.store.list_events(session.run_id) if event["type"] == "run.lease.stale"
    )

    assert response.status_code == 200
    assert response.json()["classification"] == "resumable"
    assert response.json()["status"] == "queued"
    assert persisted.active_mutation_lease is None
    assert stale_event["payload"]["worker_pid"] == dead_pid
    assert stale_event["payload"]["stale_reason"] == "worker process is no longer alive"


def test_api_pay_switch_is_governed_and_secret_safe(tmp_path, monkeypatch):
    class FakeClawHuntClient:
        def live_read_only_probe(self):
            return {
                "pay_switch_proxy_health": {"status_code": 502, "ok": False, "body": {"reachable": False}},
                "pay_switch_direct_health": {"status_code": 200, "ok": True, "body": {"ok": True}},
            }

    monkeypatch.setattr("apps.api.main.ClawHuntClient", FakeClawHuntClient)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    status = client.get("/api/pay-switch/status")
    config = client.get("/api/pay-switch/config")
    gate = client.get("/api/pay-switch/human-gate")
    blocked = client.post("/api/pay-switch/payment-intent", json={"amount": 100})
    confirmed = client.post(
        "/api/pay-switch/payment-intent",
        json={"amount": 100, "confirm_governed_tool": True},
    )

    assert status.status_code == 200
    assert status.json()["mode"] == "governed_optional"
    assert status.json()["probe"]["pay_switch_proxy_health"]["status_code"] == 502
    assert config.status_code == 200
    assert config.json()["agent_token"] in {"set", "unset"}
    assert gate.status_code == 200
    assert gate.json()["pause_status"] == "WAITING_FOR_HUMAN_GATE"
    assert blocked.status_code == 403
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "not_configured"


def test_api_rejects_out_of_range_run_inputs(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal_id = client.post("/api/goals", json={"title": "x", "description": "y"}).json()["goal_id"]
    assert client.post("/api/runs", json={"goal_id": goal_id, "budget_seconds": 0}).status_code == 422
    assert client.post("/api/runs", json={"goal_id": goal_id, "budget_seconds": -5}).status_code == 422
    assert client.post("/api/runs", json={"goal_id": goal_id, "concurrency": 0}).status_code == 422
    assert client.post("/api/runs", json={"goal_id": goal_id, "concurrency": 9999}).status_code == 422
    assert client.post("/api/runs", json={"goal_id": ""}).status_code == 422


def test_api_rejects_empty_and_out_of_range_misc_inputs(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    assert client.post("/api/verify/adversarial", json={"run_id": ""}).status_code == 422
    assert client.post("/api/chat", json={"message": ""}).status_code == 422
    assert client.post("/api/evals", json={"timeout_seconds": 0}).status_code == 422
    assert client.post("/api/evals", json={"timeout_seconds": 999999}).status_code == 422


def test_api_domain_value_error_returns_unified_400(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal_id = client.post("/api/goals", json={"title": "x", "description": "y"}).json()["goal_id"]
    resp = client.post(
        "/api/runs",
        json={"goal_id": goal_id, "dry_run": False, "backend_policy": "nonexistent-backend"},
    )
    assert resp.status_code == 400
    assert "unknown backend policy" in resp.json()["detail"]


def _seed_running_parent_via_app(app, tmp_path):
    store = app.state.store
    orch = app.state.orchestrator
    goal = store.create_goal(GoalSpec(title="Parent", description="api fanout"))
    session = orch.create_run_session(
        goal, dry_run=False, backend_policy="local", repo_path=tmp_path,
        budget_seconds=20, artifact_dir=tmp_path / "artifacts",
    )
    session.status = "running"
    session.task_graph.tasks[0].status = "running"
    store.save_run(session)
    return session


def _seed_delegation_review_parent_via_app(app, tmp_path, *, waiting: bool = True):
    store = app.state.store
    orch = app.state.orchestrator
    goal = store.create_goal(GoalSpec(title="Delegate review", description="api review"))
    session = orch.create_run_session(
        goal,
        dry_run=False,
        backend_policy="local",
        repo_path=tmp_path,
        budget_seconds=20,
        artifact_dir=tmp_path / "artifacts",
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
        }
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
    store.save_run(session)
    return session, request_key


def test_api_delegation_review_approve_marks_result_reviewed(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session, request_key = _seed_delegation_review_parent_via_app(app, tmp_path)

    resp = client.post(
        f"/api/runs/{session.run_id}/delegation-review",
        json={"request_key": request_key, "approved": True, "reviewed_by": "qa"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == RunStatus.WAITING_FOR_CHILD_DELEGATION.value
    assert body["result"]["status"] == "approved"
    assert body["result"]["review"]["reviewed_by"] == "qa"
    stored = app.state.store.get_run(session.run_id)
    assert stored.execution_context["delegate_tool_results"][0]["status"] == "approved"


def test_api_delegation_review_reject_fails_parent(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session, request_key = _seed_delegation_review_parent_via_app(app, tmp_path)

    resp = client.post(
        f"/api/runs/{session.run_id}/delegation-review",
        json={"request_key": request_key, "approved": False, "reviewed_by": "qa"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == RunStatus.FAILED.value
    assert body["result"]["status"] == "rejected"
    evidence = app.state.store.get_evidence(session.run_id)
    assert any(finding.name == "cross_runtime_delegation_review" for finding in evidence.findings)


def test_api_delegation_review_missing_run_returns_404(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    resp = client.post(
        "/api/runs/run_missing/delegation-review",
        json={"request_key": "tool:delegate-call-1", "approved": True, "reviewed_by": "qa"},
    )

    assert resp.status_code == 404


def test_api_delegation_review_conflict_returns_409(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session, request_key = _seed_delegation_review_parent_via_app(app, tmp_path, waiting=False)

    resp = client.post(
        f"/api/runs/{session.run_id}/delegation-review",
        json={"request_key": request_key, "approved": True, "reviewed_by": "qa"},
    )

    assert resp.status_code == 409
    assert "cannot review delegate result" in resp.json()["detail"]


def test_api_fanout_endpoint_spawns_and_aggregates(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _seed_running_parent_via_app(app, tmp_path)
    resp = client.post(
        f"/api/runs/{session.run_id}/fanout",
        json={
            "children": [
                {"title": "a", "description": "x", "dry_run": True},
                {"title": "b", "description": "x", "dry_run": True},
            ],
            "aggregation": "all_succeed",
            "max_concurrency": 2,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    assert body["succeeded"] is True
    assert len(body["children"]) == 2


def test_api_fanout_returns_persisted_child_lifecycle_contract(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _seed_running_parent_via_app(app, tmp_path)
    parent_task_id = session.task_graph.tasks[0].task_id

    resp = client.post(
        f"/api/runs/{session.run_id}/fanout",
        json={
            "parent_task_id": parent_task_id,
            "children": [
                {"title": "child a", "description": "x", "dry_run": True, "backend_policy": "local", "budget_seconds": 9},
                {"title": "child b", "description": "x", "dry_run": True, "backend_policy": "local", "budget_seconds": 9},
            ],
            "aggregation": "all_succeed",
            "max_concurrency": 2,
        },
    )

    body = resp.json()
    child_executions = body["child_executions"]
    stored_evidence = app.state.store.get_evidence(session.run_id)
    stored_by_run = {child.child_run_id: child for child in stored_evidence.child_executions}
    event_types = [event["type"] for event in app.state.store.list_events(session.run_id)]

    assert resp.status_code == 200, resp.text
    assert len(child_executions) == 2
    assert {child["child_run_id"] for child in child_executions} == {child["child_run_id"] for child in body["children"]}
    for child in child_executions:
        stored_child = stored_by_run[child["child_run_id"]]
        assert child["parent_run_id"] == session.run_id
        assert child["parent_task_id"] == parent_task_id
        assert child["child_task_id"]
        assert child["backend"] == "local"
        assert child["status"] == "completed"
        assert child["depth"] == 1
        assert child["cancellation_mode"] == "linked"
        assert child["timeout_seconds"] == 9
        assert child["evidence_owner"] == "child"
        assert child["chain_verdict"] == stored_child.chain_verdict
        assert child["evidence_artifact_id"] == stored_child.evidence_artifact_id
        assert child["evidence_artifact_id"]
    assert "child_run.spawned" in event_types
    assert "child_evidence.added" in event_types
    assert "child_fanout.completed" in event_types


def test_api_fanout_unknown_run_returns_404(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    resp = client.post("/api/runs/run_missing/fanout", json={"children": [{"title": "a", "description": "x", "dry_run": True}]})
    assert resp.status_code == 404


def test_api_fanout_terminal_parent_returns_unified_400(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "P", "description": "d"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()  # completes synchronously
    resp = client.post(
        f"/api/runs/{run['run_id']}/fanout",
        json={"children": [{"title": "a", "description": "x", "dry_run": True}]},
    )
    assert resp.status_code == 400
    assert "terminal" in resp.json()["detail"]


def test_api_fanout_rejects_empty_children(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _seed_running_parent_via_app(app, tmp_path)
    resp = client.post(f"/api/runs/{session.run_id}/fanout", json={"children": []})
    assert resp.status_code == 422


def test_api_expand_endpoint_adds_discovered_task(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _seed_running_parent_via_app(app, tmp_path)
    first = session.task_graph.tasks[0].task_id
    resp = client.post(
        f"/api/runs/{session.run_id}/expand",
        json={"tasks": [{"role": "implement", "title": "discovered", "depends_on": [first]}]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["added"]) == 1
    assert body["added"][0] in body["task_ids"]


def test_api_expand_rejects_invalid_role(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    session = _seed_running_parent_via_app(app, tmp_path)
    resp = client.post(f"/api/runs/{session.run_id}/expand", json={"tasks": [{"role": "bogus-role", "title": "x"}]})
    assert resp.status_code == 422


def test_api_expand_unknown_run_returns_404(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    resp = client.post("/api/runs/run_missing/expand", json={"tasks": [{"role": "implement", "title": "x"}]})
    assert resp.status_code == 404


def test_api_events_sse_streams_fanout_progress(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "SSE", "description": "stream fanout"}).json()
    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": False,
            "backend_policy": "local",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
            "task_topology": "explore_fanout",
        },
    ).json()
    run_id = run["run_id"]
    stream = client.get(f"/api/runs/{run_id}/events").text
    assert "event: child_run.spawned" in stream
    assert "event: child_fanout.completed" in stream
    assert "event: run.completed" in stream


def test_api_run_executes_review_consensus_topology_with_child_evidence(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    goal = client.post("/api/goals", json={"title": "Review API", "description": "consensus topology"}).json()

    run = client.post(
        "/api/runs",
        json={
            "goal_id": goal["goal_id"],
            "dry_run": False,
            "backend_policy": "local",
            "repo_path": str(tmp_path),
            "budget_seconds": 20,
            "artifact_dir": str(tmp_path / "artifacts"),
            "task_topology": "review_consensus",
        },
    )

    body = run.json()
    run_id = body["run_id"]
    persisted = client.get(f"/api/runs/{run_id}").json()
    evidence = client.get(f"/api/runs/{run_id}/evidence").json()
    stream = client.get(f"/api/runs/{run_id}/events").text
    fanout_report = evidence["backend_summary"]["subagent_fanouts"][0]

    assert run.status_code == 200, run.text
    assert body["status"] == "completed"
    assert persisted["execution_context"]["task_topology"] == "review_consensus"
    assert len(persisted["child_executions"]) == 3
    assert len(evidence["child_executions"]) == 3
    assert fanout_report["policy"] == "consensus"
    assert fanout_report["total"] == 3
    assert fanout_report["completed"] == 3
    assert fanout_report["succeeded"] is True
    assert all(child["chain_verdict"] for child in fanout_report["children"])
    assert all(child["evidence_artifact_id"] for child in evidence["child_executions"])
    assert "event: child_run.spawned" in stream
    assert "event: child_evidence.added" in stream
    assert "event: child_fanout.completed" in stream
    assert "event: run.completed" in stream


def test_api_webhook_autorun_defaults_to_claude_opus_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_WEBHOOK_AUTORUN", "1")
    monkeypatch.delenv("SUPERCLAW_WEBHOOK_BACKEND", raising=False)  # so it falls back to the default
    monkeypatch.setenv("SUPERCLAW_WEBHOOK_ARTIFACT_DIR", str(tmp_path / "art"))
    monkeypatch.setenv("SUPERCLAW_WEBHOOK_REPO_PATH", str(tmp_path))

    app = create_app(state_path=tmp_path / "state.db")

    # Deterministic stand-in for the claude backend so the test never makes a real Opus call.
    class _FakeClaude(LocalShellBackend):
        name = "claude"

        def run(self, task, goal, session, limits):
            return self.run_command(
                [sys.executable, "-c", "print('fake-claude-opus')"],
                task=task, goal=goal, session=session, limits=limits,
            )

    app.state.orchestrator.backends["claude"] = _FakeClaude()
    client = TestClient(app)

    resp = client.post(
        "/api/clawhunt/webhook",
        json={"event_type": "problem_assigned", "problem": {"id": 7, "title": "Webhook autorun"}},
    )
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]
    assert run_id  # auto-run was dispatched

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("webhook auto-run did not finish")

    evidence = client.get(f"/api/runs/{run_id}/evidence").json()
    assert evidence["worker_results"], evidence
    assert all(wr["backend"] == "claude" for wr in evidence["worker_results"])  # routed to the claude (Opus 4.8) backend by default


def test_run_and_chat_requests_default_to_accept_edits():
    # Web/desktop clients omit permission_mode; the API default governs the session.
    # "acceptEdits" auto-approves plugin (MCP) tool calls + file edits without prompting.
    assert RunRequest(goal_id="g1").permission_mode == "acceptEdits"
    assert ChatTurnRequest(message="hi").permission_mode == "acceptEdits"


def test_api_skill_sync_projects_unsync_and_contract(tmp_path, monkeypatch):
    plugin_dir = _copy_plugin_fixture(tmp_path, "hello-world")
    public_key = _sign_plugin_fixture(plugin_dir)
    cloud_root = tmp_path / "plugin-cloud"
    fixture = _write_registry_fixture(cloud_root, plugin_dir)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    # Redirect projection targets + ledger out of the real user home.
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(tmp_path / "codex-skills"))
    monkeypatch.setenv("SUPERCLAW_PROJECTION_LOCK", str(tmp_path / "projections.lock"))

    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    assert client.post("/api/plugins/install", json=fixture).status_code == 200

    contract = client.get("/api/plugins/skills/contract")
    assert contract.status_code == 200
    assert "codex" in {t["name"] for t in contract.json()["targets"]}

    synced = client.post("/api/plugins/skills/sync", json={"targets": ["codex"]})
    assert synced.status_code == 200, synced.text
    body = synced.json()
    assert body["ok"] is True
    assert len(body["written"]) == 1
    written = Path(body["written"][0])
    assert written.exists()
    assert written.is_relative_to(tmp_path / "codex-skills")

    listed = client.get("/api/plugins/skills/projections")
    assert listed.status_code == 200
    assert any(r["path"] == str(written) for r in listed.json()["records"])

    unsynced = client.post("/api/plugins/skills/unsync", json={"plugin_id": fixture["plugin_id"]})
    assert unsynced.status_code == 200
    assert unsynced.json()["removed"] == [str(written)]
    assert not written.exists()


def test_api_native_skill_import_and_list_uses_store(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv("SUPERCLAW_SKILL_STORE_DIR", str(tmp_path / "skill-store"))
    monkeypatch.setenv("SUPERCLAW_CODEX_SKILLS_DIR", str(tmp_path / "codex-skills"))
    monkeypatch.setenv("SUPERCLAW_PROJECTION_LOCK", str(tmp_path / "projection.lock"))
    skill_dir = tmp_path / "native-helper"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: Native Helper\ndescription: Help natively\n---\n\n# Native\n", encoding="utf-8")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    unauthorized = client.post("/v1/skills/import", json={"path": str(skill_dir)})
    imported = client.post(
        "/v1/skills/import",
        json={"path": str(skill_dir), "label": "local-dev"},
        headers={"X-SuperClaw-Token": "secret-control"},
    )
    listed = client.get("/v1/skills", headers={"X-SuperClaw-Token": "secret-control"})
    synced = client.post(
        "/v1/skills/sync",
        json={"skill_slug": "native-helper", "targets": ["codex"]},
        headers={"X-SuperClaw-Token": "secret-control"},
    )

    assert unauthorized.status_code == 401
    assert imported.status_code == 200, imported.text
    skill = imported.json()["skill"]
    assert skill["slug"] == "native-helper"
    assert skill["name"] == "Native Helper"
    assert skill["description"] == "Help natively"
    assert skill["label"] == "local-dev"
    assert skill["source_digest"].startswith("sha256:")
    assert skill["store_digest"].startswith("sha256:")
    assert skill["signature"] is None
    assert skill["signed"] is False
    assert skill["executable"] is False
    assert skill["importer"] == "superclaw-api"
    assert "skill_path" not in skill
    assert "root" not in skill
    assert listed.status_code == 200
    assert listed.json()["skills"][0]["slug"] == "native-helper"
    assert synced.status_code == 200, synced.text
    written = Path(synced.json()["written"][0])
    assert written == tmp_path / "codex-skills" / "native-helper" / "SKILL.md"
    assert written.exists()


def test_api_native_skill_import_fails_closed_on_invalid_request(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv("SUPERCLAW_SKILL_STORE_DIR", str(tmp_path / "skill-store"))
    skill_dir = tmp_path / "native-helper"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Native Helper\ndescription: Help natively\n---\n\n```bash\n#!/bin/sh\necho hi\n```\n",
        encoding="utf-8",
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    bad_label = client.post(
        "/v1/skills/import",
        json={"path": str(skill_dir), "label": "internet"},
        headers={"X-SuperClaw-Token": "secret-control"},
    )
    executable = client.post(
        "/v1/skills/import",
        json={"path": str(skill_dir), "label": "local-dev"},
        headers={"X-SuperClaw-Token": "secret-control"},
    )
    signed_without_signature = client.post(
        "/v1/skills/import",
        json={"path": str(skill_dir), "label": "community"},
        headers={"X-SuperClaw-Token": "secret-control"},
    )

    assert bad_label.status_code == 400
    assert "unknown skill label" in bad_label.json()["detail"]
    assert str(skill_dir) not in bad_label.json()["detail"]
    assert executable.status_code == 400
    assert "--yes-executable" in executable.json()["detail"]
    assert signed_without_signature.status_code == 400
    assert "require an Ed25519 signature" in signed_without_signature.json()["detail"]


def test_api_skill_build_installs_local_equippable(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    skill_dir = tmp_path / "build-me"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Build Me\ndescription: A buildable skill.\n---\n\n# Build Me\n\nDo the thing.\n",
        encoding="utf-8",
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    unauthorized = client.post("/v1/skills/build", json={"path": str(skill_dir)})
    built = client.post(
        "/v1/skills/build",
        json={"path": str(skill_dir)},
        headers={"X-SuperClaw-Token": "secret-control"},
    )

    assert unauthorized.status_code == 401
    assert built.status_code == 200, built.text
    skill = built.json()["skill"]
    assert skill["plugin_id"] == "skill.build-me"
    assert skill["trust_state"] == "local"
    assert skill["equippable"] is True
    assert skill["signed"] is False
    assert skill["package_digest"].startswith("sha256:")

    # Catalog freshness: the just-built skill is visible on a catalog-backed read
    # immediately (clear_catalog_cache was called after the build).
    catalog = client.get("/v1/skills", headers={"X-SuperClaw-Token": "secret-control"})
    assert catalog.status_code == 200


def test_api_skill_build_fails_closed_on_missing_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(tmp_path / "plugin-cache"))
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    resp = client.post(
        "/v1/skills/build",
        json={"path": str(tmp_path / "nope")},
        headers={"X-SuperClaw-Token": "secret-control"},
    )
    assert resp.status_code == 400


def test_api_skill_build_contract_exposes_provenance_grades(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    resp = client.get("/api/contracts/skill-build", headers={"X-SuperClaw-Token": "secret-control"})
    assert resp.status_code == 200, resp.text
    contract = resp.json()
    assert contract["operation"] == {"method": "POST", "url": "/v1/skills/build"}
    assert contract["default_trust_state"] == "local"
    assert set(contract["trust_states"]) == {"official", "developer", "local", "untrusted"}


def test_api_chat_turn_records_sticky_runtime_and_reuses_it(tmp_path, monkeypatch):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    first = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery build it",
            "mode": "delivery",
            "dry_run": True,
            "backend_policy": "hermes",
            "model": "anthropic/claude-sonnet-4.6",
            "repo_path": str(tmp_path),
        },
    )
    assert first.status_code == 200, first.text
    session_id = first.json()["session_id"]

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    assert store.get_chat_runtime(session_id) == {"backend": "hermes", "model": "anthropic/claude-sonnet-4.6"}
    run = store.get_run(first.json()["run_id"])
    assert run.execution_context["backend_policy"] == "hermes"
    assert run.execution_context["model"] == "anthropic/claude-sonnet-4.6"

    # follow-up turn omits backend/model entirely: the chat remembers
    second = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery continue",
            "mode": "delivery",
            "dry_run": True,
            "session_id": session_id,
            "repo_path": str(tmp_path),
        },
    )
    assert second.status_code == 200, second.text
    run2 = store.get_run(second.json()["run_id"])
    assert run2.execution_context["backend_policy"] == "hermes"
    assert run2.execution_context["model"] == "anthropic/claude-sonnet-4.6"


def test_api_chat_turn_backend_switch_marks_handoff_and_drops_model(tmp_path, monkeypatch):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    first = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery start",
            "mode": "delivery",
            "dry_run": True,
            "backend_policy": "claude",
            "model": "claude-opus-4-8",
            "repo_path": str(tmp_path),
        },
    )
    session_id = first.json()["session_id"]

    switched = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery switch",
            "mode": "delivery",
            "dry_run": True,
            "session_id": session_id,
            "backend_policy": "codex",
            "repo_path": str(tmp_path),
        },
    )
    assert switched.status_code == 200, switched.text

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    session = store.get_chat_session(session_id)
    markers = [m for m in session.messages if m.role == "system" and "runtime switched" in m.content]
    assert len(markers) == 1 and "claude → codex" in markers[0].content
    assert store.get_chat_runtime(session_id) == {"backend": "codex"}
    run2 = store.get_run(switched.json()["run_id"])
    assert run2.execution_context["backend_policy"] == "codex"
    assert run2.execution_context["model"] is None


def test_api_chat_turn_executes_on_resolved_backend_and_forwards_its_model(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_direct(*, content, backend, repo, budget_seconds, context_text="", history="", model=None, permission_mode=None, event_sink=None, **_kwargs):
        seen["backend"] = backend
        seen["model"] = model
        return {"intent": "chat", "backend": backend, "status": "completed", "response": "ok"}

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        seen["backend"] = "claude"
        seen["model"] = model
        return {"intent": "chat", "backend": "claude", "status": "completed", "response": "ok",
                "native_session_id": native_session_id}

    monkeypatch.setattr("apps.api.main._execute_direct_chat_turn", fake_direct)
    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    # selected runtime codex -> codex executes the chat turn, model forwarded
    r1 = client.post(
        "/api/chat/turn",
        json={"message": "hello", "backend_policy": "codex", "model": "gpt-5.2-codex", "repo_path": str(tmp_path)},
    )
    assert r1.status_code == 200 and seen == {"backend": "codex", "model": "gpt-5.2-codex"}

    # selected runtime claude -> claude executes the chat turn over its NATIVE
    # session channel (runtime selector governs plain chat too), with its model
    r2 = client.post(
        "/api/chat/turn",
        json={"message": "hello again", "backend_policy": "claude", "model": "claude-opus-4-8", "repo_path": str(tmp_path)},
    )
    assert r2.status_code == 200 and seen == {"backend": "claude", "model": "claude-opus-4-8"}

    # explicit direct_chat_backend override differing from the resolved runtime:
    # the override executes, but the other runtime's model id must NOT leak
    r3 = client.post(
        "/api/chat/turn",
        json={
            "message": "hello once more",
            "backend_policy": "claude",
            "model": "claude-opus-4-8",
            "direct_chat_backend": "codex",
            "repo_path": str(tmp_path),
        },
    )
    assert r3.status_code == 200 and seen == {"backend": "codex", "model": None}


def test_api_create_run_passes_model_to_execution_context(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    goal = client.post("/api/goals", json={"title": "Model run", "description": "with model"})
    goal_id = goal.json()["goal_id"]
    run = client.post(
        "/api/runs",
        json={"goal_id": goal_id, "dry_run": True, "backend_policy": "claude", "model": "claude-haiku-4-5"},
    )
    assert run.status_code == 200, run.text

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    session = store.get_run(run.json()["run_id"])
    assert session.execution_context["model"] == "claude-haiku-4-5"


def test_agent_inventory_carries_runtime_selector_contract(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    payload = client.get("/api/agents").json()
    agents = {agent["name"]: agent for agent in payload["agents"]}

    claude = agents["claude"]
    assert claude["supports_model_selection"] is True
    assert "claude-opus-4-8" in claude["suggested_models"]
    assert claude["label"] == "Claude Code"

    gateway = agents["openclaw-gateway"]
    assert gateway["supports_model_selection"] is False  # kernel fails closed on override

    assert agents["codex-app-server"]["chat_capable"] is True
    # Unified chat entry: the selector tier ships in the contract — chat lists
    # native/upgradeable runtimes; one-shot exec forms and plumbing stay out.
    assert agents["codex-app-server"]["chat_tier"] == "native"
    assert agents["codex"]["chat_tier"] == "oneshot"
    assert agents["claude"]["chat_tier"] == "upgradeable"
    assert agents["local"]["chat_tier"] == "infra"
    # channel-migration backends are now first-class contract entries
    for name in ("opencode", "grok", "cursor", "http"):
        assert agents[name]["label"], name
        assert agents[name]["supports_model_selection"] is True, name


def test_api_plain_chat_turn_records_executing_backend_as_sticky(tmp_path, monkeypatch):
    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        return {"intent": "chat", "backend": "claude", "status": "completed", "response": "ok",
                "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    # plain chat with claude selected now EXECUTES on claude, so the selection
    # IS what this chat runs on and persists as the sticky runtime.
    response = client.post(
        "/api/chat/turn",
        json={"message": "hello", "backend_policy": "claude", "model": "claude-opus-4-8", "repo_path": str(tmp_path)},
    )
    assert response.status_code == 200, response.text
    session_id = response.json()["session_id"]

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    assert store.get_chat_runtime(session_id) == {"backend": "claude", "model": "claude-opus-4-8"}

    # an explicit direct-chat override that differs from the resolved selection
    # executes the override but must NOT be recorded as sticky (sticky = what
    # the chat's resolved runtime is, never a per-turn pin).
    response2 = client.post(
        "/api/chat/turn",
        json={"message": "hello again", "backend_policy": "hermes", "direct_chat_backend": "codex", "repo_path": str(tmp_path)},
    )
    assert response2.status_code == 200, response2.text
    assert store.get_chat_runtime(response2.json()["session_id"]) is None


def test_api_chat_turn_empty_model_explicitly_clears_sticky_model(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    first = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery start",
            "mode": "delivery",
            "dry_run": True,
            "backend_policy": "hermes",
            "model": "anthropic/claude-sonnet-4.6",
            "repo_path": str(tmp_path),
        },
    )
    session_id = first.json()["session_id"]

    cleared = client.post(
        "/api/chat/turn",
        json={
            "message": "@delivery continue on the backend default model",
            "mode": "delivery",
            "dry_run": True,
            "session_id": session_id,
            "model": "",
            "repo_path": str(tmp_path),
        },
    )
    assert cleared.status_code == 200, cleared.text

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    assert store.get_chat_runtime(session_id) == {"backend": "hermes"}
    run = store.get_run(cleared.json()["run_id"])
    assert run.execution_context["model"] is None


def test_chat_codex_session_rebuilds_when_model_changes(tmp_path, monkeypatch):
    import apps.api.main as api_main

    created: list = []

    class FakeSession:
        def __init__(self, **kwargs):
            created.append(kwargs.get("model"))
            self.closed = False

        def close(self):
            self.closed = True

    monkeypatch.setattr(api_main, "CodexAppServerClient", lambda **kwargs: object())
    monkeypatch.setattr(api_main, "CodexAppServerSession", FakeSession)
    monkeypatch.setattr(api_main, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    api_main._CHAT_CODEX_SESSIONS.clear()

    conv1 = api_main._get_chat_codex_session("chat-model-iso", str(tmp_path), model="gpt-5.2-codex")
    conv2 = api_main._get_chat_codex_session("chat-model-iso", str(tmp_path), model="gpt-5.2-codex")
    assert conv1 is not None and conv2 is not None and conv1["session"] is conv2["session"]

    conv3 = api_main._get_chat_codex_session("chat-model-iso", str(tmp_path), model="gpt-5.1-codex-mini")
    assert conv3 is not None and conv3["session"] is not conv1["session"]
    assert created == ["gpt-5.2-codex", "gpt-5.1-codex-mini"]
    assert conv1["session"].closed is True  # stale session was retired, not leaked

    api_main._CHAT_CODEX_SESSIONS.clear()


def test_chat_codex_session_rebuilds_when_cwd_changes(tmp_path, monkeypatch):
    # Live-process half of the workspace-move resume guard (workspace-sidebar-
    # rework §4.5): a cached codex app-server session is pinned to its launch cwd.
    # Moving the chat to a different execution boundary must REBUILD it against the
    # new cwd so the next turn never resumes the old repo (StateStore drops the
    # persisted codex_thread_id on the same move).
    import apps.api.main as api_main

    created_cwds: list = []

    class FakeSession:
        def __init__(self, **kwargs):
            created_cwds.append(str(kwargs.get("cwd")))
            self.closed = False

        def close(self):
            self.closed = True

    monkeypatch.setattr(api_main, "CodexAppServerClient", lambda **kwargs: object())
    monkeypatch.setattr(api_main, "CodexAppServerSession", FakeSession)
    monkeypatch.setattr(api_main, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    api_main._CHAT_CODEX_SESSIONS.clear()

    repo_a = str(tmp_path / "a")
    repo_b = str(tmp_path / "b")
    conv1 = api_main._get_chat_codex_session("chat-cwd-iso", repo_a, model="gpt-5.2-codex")
    conv2 = api_main._get_chat_codex_session("chat-cwd-iso", repo_a, model="gpt-5.2-codex")
    assert conv1 is not None and conv2 is not None and conv1["session"] is conv2["session"]  # same cwd reuses

    conv3 = api_main._get_chat_codex_session("chat-cwd-iso", repo_b, model="gpt-5.2-codex")
    assert conv3 is not None and conv3["session"] is not conv1["session"]  # different cwd rebuilds
    assert conv1["session"].closed is True  # stale session retired against the old cwd
    assert created_cwds == [str(Path(repo_a)), str(Path(repo_b))]

    api_main._CHAT_CODEX_SESSIONS.clear()


def test_api_codex_repo_change_retires_thread(tmp_path, monkeypatch):
    import apps.api.main as api_main
    from superclaw.state import StateStore

    created_sessions = []

    class FakeCodexSession:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.thread_id = "thread-xyz"
            created_sessions.append(self)
            self.closed = False
            self.resumed = bool(kwargs.get("resume_thread_id"))

        def ensure_started(self):
            pass

        def close(self):
            self.closed = True

        def run_turn(self, prompt: str, *, budget_seconds: float, cancel_check=None, on_event=None, effort=None):
            # Return a mock result with a thread ID
            from superclaw.codex_app_server import CodexAppServerTurnResult
            return CodexAppServerTurnResult(
                thread_id="thread-xyz",
                turn_id="turn-1",
                final_text="reply",
                output="reply",
            )

    monkeypatch.setattr(api_main, "CodexAppServerClient", lambda **kwargs: object())
    monkeypatch.setattr(api_main, "CodexAppServerSession", FakeCodexSession)
    monkeypatch.setattr(api_main, "find_codex_executable", lambda override=None: ("/tmp/codex", "test"))
    api_main._CHAT_CODEX_SESSIONS.clear()

    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    app = create_app(state_path=state_path)
    client = TestClient(app)

    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    repo_a.mkdir()
    repo_b.mkdir()
    _trust_repo(tmp_path, repo=repo_a)
    _trust_repo(tmp_path, repo=repo_b)

    r1 = client.post(
        "/api/chat/stream",
        json={"message": "hi", "direct_chat_backend": "codex", "repo_path": str(repo_a)},
    )
    assert r1.status_code == 200
    list(r1.iter_lines())

    sid = store.list_chat_sessions()[0].session_id
    assert store.get_chat_codex_thread_id(sid) == "thread-xyz"

    r2 = client.post(
        "/api/chat/stream",
        json={"session_id": sid, "message": "hello", "direct_chat_backend": "codex", "repo_path": str(repo_b)},
    )
    assert r2.status_code == 200
    list(r2.iter_lines())

    assert len(created_sessions) == 2
    assert created_sessions[0].kwargs.get("resume_thread_id") is None
    # If this fails, it means the thread ID was leaked/resumed across the repo change
    assert created_sessions[1].kwargs.get("resume_thread_id") is None

    api_main._CHAT_CODEX_SESSIONS.clear()





def test_api_team_board_inbox_assign_resolves_through_kernel(tmp_path):
    state_path = tmp_path / "state.db"
    seeded = _seed_api_team_ops_state(state_path)
    app = create_app(state_path=state_path)
    client = TestClient(app)

    listed = client.get("/api/team/board-inbox")
    assert listed.status_code == 200
    assert listed.json()["items"][0]["interaction_id"] == seeded["interaction_id"]

    assigned = client.post(
        f"/api/team/board-inbox/{seeded['interaction_id']}/assign",
        json={"profile_id": seeded["profile_id"]},
    )

    assert assigned.status_code == 200, assigned.text
    payload = assigned.json()
    assert payload["resolved"] is True
    assert payload["issue"]["assignee_agent_profile_id"] == seeded["profile_id"]
    assert payload["issue"]["status"] == "todo"
    assert payload["interaction"]["status"] == "resolved"

    conflict = client.post(
        f"/api/team/board-inbox/{seeded['interaction_id']}/assign",
        json={"profile_id": seeded["profile_id"]},
    )
    assert conflict.status_code == 409


def test_api_team_board_inbox_resolve_is_idempotent(tmp_path):
    state_path = tmp_path / "state.db"
    seeded = _seed_api_team_ops_state(state_path)
    app = create_app(state_path=state_path)
    client = TestClient(app)

    first = client.post(f"/api/team/board-inbox/{seeded['interaction_id']}/resolve", json={})
    second = client.post(f"/api/team/board-inbox/{seeded['interaction_id']}/resolve", json={})

    assert first.status_code == 200, first.text
    assert first.json()["status"] == "resolved"
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "already_resolved"


def test_api_team_issue_checkout_returns_structured_budget_conflict_without_claiming(tmp_path):
    state_path = tmp_path / "state.db"
    seeded = _seed_api_team_ops_state(state_path)
    store = StateStore(state_path)
    issue = store.get_issue(seeded["issue_id"])
    original_status = issue.status
    issue.assignee_agent_profile_id = seeded["profile_id"]
    issue.metadata["budget_policy"] = {"hard_limits": {"token_budget": 1}}
    store.save_issue(issue)
    store.record_cost_event(
        CostEvent(
            idempotency_key="issue-budget-used",
            issue_id=seeded["issue_id"],
            input_tokens=1,
            usage_status="actual",
        )
    )
    app = create_app(state_path=state_path)
    client = TestClient(app)

    blocked = client.post(
        f"/api/team/issues/{seeded['issue_id']}/checkout",
        json={"run_id": "run_checkout_blocked", "holder": "agent_operator"},
    )

    assert blocked.status_code == 409, blocked.text
    detail = blocked.json()["detail"]
    assert detail["code"] == "BUDGET_BLOCKED"
    assert detail["budget"]["allowed"] is False
    assert detail["budget"]["blocked"][0]["scope"] == "issue"
    assert detail["budget"]["blocked"][0]["exceeded"][0]["metric"] == "token_budget"
    fresh = StateStore(state_path).get_issue(seeded["issue_id"])
    assert fresh.status == original_status
    assert fresh.checkout_run_id is None


def test_api_team_routine_author_schedules_only_ready_enabled(tmp_path):
    state_path = tmp_path / "state.db"
    seeded = _seed_api_team_ops_state(state_path)
    app = create_app(state_path=state_path)
    client = TestClient(app)
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

    ready = client.post("/api/team/routines/author", json={"spec": base_spec})
    disabled = client.post(
        "/api/team/routines/author",
        json={"spec": {**base_spec, "enabled": False, "title": "Disabled review"}},
    )
    gated = client.post(
        "/api/team/routines/author",
        json={
            "spec": {
                **base_spec,
                "title": "Publish review",
                "governance": {"risk_flags": ["public_publish"]},
            }
        },
    )
    listing = client.get("/api/team/routines")

    assert ready.status_code == 200, ready.text
    assert ready.json()["scheduled"] is True
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["authoring"]["status"] == "disabled"
    assert disabled.json()["scheduled"] is False
    assert gated.status_code == 200, gated.text
    assert gated.json()["authoring"]["status"] == "requires_approval"
    assert gated.json()["scheduled"] is False
    assert listing.status_code == 200
    assert listing.json()["count"] == 1
    assert listing.json()["schedules"][0]["title"] == "Review incoming issues"

    # The routine_run ledger endpoint resolves + returns an empty fire history for a
    # freshly-authored routine (nothing has fired yet) — proves route/auth/shape.
    routine_id = listing.json()["schedules"][0]["routine_id"]
    runs = client.get(f"/api/team/routines/{routine_id}/runs")
    assert runs.status_code == 200, runs.text
    body = runs.json()
    assert body["routine_id"] == routine_id
    assert body["count"] == 0
    assert body["runs"] == []


def test_api_governance_approvals_inbox_roundtrip(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    # initially empty
    assert client.get("/api/governance/approvals").json()["pending_count"] == 0

    # a governed runtime files a blocked pay/scan intent
    filed = client.post(
        "/api/governance/approvals",
        json={
            "source": "clawwork-governance",
            "run_id": "run_demo",
            "intent": "network_scan",
            "tool": "bash",
            "command": "nmap -sV 10.0.0.0/24",
        },
    )
    assert filed.status_code == 200, filed.text
    body = filed.json()
    assert body["ok"] is True and body["status"] == "pending" and body["approval_id"].startswith("gov_approval")

    listing = client.get("/api/governance/approvals").json()
    assert listing["pending_count"] == 1
    entry = listing["approvals"][-1]
    assert entry["intent"] == "network_scan"
    assert entry["run_id"] == "run_demo"
    assert entry["status"] == "pending"
    assert "nmap" in entry["detail"]


def test_api_governance_approvals_requires_control_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-tok")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    # no token header -> 401
    assert client.post("/api/governance/approvals", json={"intent": "payment"}).status_code == 401
    ok = client.post(
        "/api/governance/approvals",
        json={"intent": "payment"},
        headers={"X-SuperClaw-Token": "secret-tok"},
    )
    assert ok.status_code == 200


def test_api_chat_failed_backend_does_not_become_sticky(tmp_path, monkeypatch):
    # blocker fix: a plain chat turn must persist its runtime as sticky ONLY
    # after it actually answers — a failed/unavailable backend must not stick.
    def fake_failed(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        return {"intent": "chat", "backend": "claude", "status": "failed",
                "failure_reason": "claude not available"}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_failed)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    from superclaw.state import StateStore
    store = StateStore(tmp_path / "state.db")

    r = client.post("/api/chat/turn", json={"message": "hi", "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    assert r.json()["status"] == "failed"
    # failed chat -> NOT sticky
    assert store.get_chat_runtime(sid) is None

    # now a succeeding turn DOES become sticky
    def fake_ok(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        return {"intent": "chat", "backend": "claude", "status": "completed", "response": "ok",
                "native_session_id": native_session_id}
    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_ok)
    r2 = client.post("/api/chat/turn", json={"message": "hi2", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    assert r2.json()["status"] == "completed"
    assert store.get_chat_runtime(sid) == {"backend": "claude"}


def test_api_agent_models_catalog(tmp_path, monkeypatch):
    # The selector's model list is the kernel's discovery catalog (live when the
    # runtime exposes a channel, static contract hints otherwise) — never a
    # frontend-invented list.
    import superclaw.model_discovery as md

    monkeypatch.setattr(
        md,
        "discover_models",
        lambda name, backends=None, force_refresh=False: md.ModelCatalog(backend=name, models=["m1", "m2"], source="live"),
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/agents/opencode/models")
    assert response.status_code == 200
    body = response.json()
    assert body["backend"] == "opencode"
    assert body["models"] == ["m1", "m2"]
    assert body["source"] == "live"


def test_api_agent_models_static_fallback_is_honest(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/agents/claude/models")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "static"  # claude has no live listing channel
    assert "claude-opus-4-8" in body["models"]


def test_api_relay_packages_returns_kernel_payload(tmp_path, monkeypatch):
    # The relay package (套餐) endpoint is a thin pass-through of the kernel's
    # relay_packages() — same source as the CLI `superclaw relay packages`, so
    # CLI/API stay zero-divergence. The frontend renders tiers, never raw models.
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp,
        "relay_packages",
        lambda: {
            "packages": [
                {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
                {"id": "plus", "name": "Plus Tier", "tier": "plus", "group_slug": "superclaw-plus"},
            ],
            "source": "catalog",
            "available": True,
        },
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/relay/packages")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True and body["source"] == "catalog"
    assert [p["id"] for p in body["packages"]] == ["core", "plus"]


def test_api_relay_packages_requires_control_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    assert client.get("/api/relay/packages").status_code == 401
    ok = client.get("/api/relay/packages", headers={"X-SuperClaw-Token": "secret-control"})
    assert ok.status_code == 200
    assert "packages" in ok.json()


def test_api_relay_status_returns_kernel_payload(tmp_path, monkeypatch):
    # /api/relay/status is a thin pass-through of the kernel relay_status() — same
    # source as the CLI `superclaw relay status`, wrapped in an ok=true envelope.
    import superclaw.relay_key as rk

    monkeypatch.setattr(
        rk,
        "relay_status",
        lambda: {"linked": True, "relay_key_prefix": "cph_abc…", "source": "account"},
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    body = client.get("/api/relay/status").json()
    assert body["ok"] is True
    assert body["linked"] is True and body["relay_key_prefix"] == "cph_abc…"


def test_api_relay_balance_and_usage_pass_through_and_fail_soft(tmp_path, monkeypatch):
    # Balance/usage mirror /api/relay/packages' fail-soft contract: a happy call is
    # wrapped in ok=true; a kernel RelayKeyError (not logged in / relay unreachable)
    # is an EXPECTED pre-login state surfaced as HTTP 200 + ok=false + a machine
    # code (the kernel's error prefix), never a 500. The kernel already masks the
    # key, so the surface never sees plaintext.
    import superclaw.relay_key as rk

    # Match the real relay_balance() shape: it returns `balance` (not
    # `account_balance` — that field only exists on relay_usage()).
    monkeypatch.setattr(
        rk,
        "relay_balance",
        lambda: {
            "balance": 12.5,
            "currency": "USD",
            "is_active": True,
            "relay_key_source": "account",
            "relay_key_prefix": "cph_abc…",
        },
    )
    monkeypatch.setattr(
        rk,
        "relay_usage",
        lambda: {
            "key_credits_used": 3.25,
            "key_quota_limit": 0,
            "account_balance": 12.5,
            "currency": "USD",
            "is_active": True,
            "relay_key_prefix": "cph_abc…",
        },
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    balance = client.get("/api/relay/balance").json()
    assert balance["ok"] is True and balance["balance"] == 12.5
    usage = client.get("/api/relay/usage").json()
    assert usage["ok"] is True
    assert usage["key_quota_limit"] == 0 and usage["key_credits_used"] == 3.25

    # Not-logged-in / unreachable degrades to ok=false with the kernel's prefix as a
    # machine code, still HTTP 200 (never a 500 for an expected pre-login state).
    def _raise_login_required():
        raise rk.RelayKeyError("RELAY_LOGIN_REQUIRED: no relay key; run account-login")

    monkeypatch.setattr(rk, "relay_balance", _raise_login_required)
    monkeypatch.setattr(rk, "relay_usage", _raise_login_required)
    for path in ("/api/relay/balance", "/api/relay/usage"):
        soft = client.get(path)
        assert soft.status_code == 200
        payload = soft.json()
        assert payload["ok"] is False and payload["code"] == "RELAY_LOGIN_REQUIRED"


def test_api_relay_status_balance_usage_require_control_token(tmp_path, monkeypatch):
    # All three relay surfacing endpoints sit behind require_control_token, exactly
    # like /api/relay/packages — no token → 401, valid token → 200.
    import superclaw.relay_key as rk

    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setattr(rk, "relay_status", lambda: {"linked": False})
    monkeypatch.setattr(
        rk, "relay_balance", lambda: {"account_balance": None, "currency": "USD", "is_active": False}
    )
    monkeypatch.setattr(
        rk,
        "relay_usage",
        lambda: {
            "key_credits_used": None,
            "key_quota_limit": None,
            "account_balance": None,
            "currency": "USD",
            "is_active": False,
        },
    )
    # account_overview is best-effort (never raises): stub it to a logged-out shape so
    # the endpoint returns ok=true behind the control-token gate like the others.
    monkeypatch.setattr(
        rk,
        "account_overview",
        lambda: {"ok": True, "logged_in": False, "billing_plan": None,
                 "entitlement": "free", "entitlement_source": "free", "unlimited": False,
                 "relay": {"ok": False}},
    )
    # relay_package_models hits the network; stub it to an ok shape for the gate check.
    monkeypatch.setattr(
        rk,
        "relay_package_models",
        lambda tier: {"ok": True, "tier": tier, "group_slug": f"superclaw-{tier}", "models": []},
    )
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    for path in (
        "/api/relay/status",
        "/api/relay/balance",
        "/api/relay/usage",
        "/api/relay/account",
        "/api/relay/packages/plus/models",
    ):
        assert client.get(path).status_code == 401
        ok = client.get(path, headers={"X-SuperClaw-Token": "secret-control"})
        assert ok.status_code == 200 and ok.json()["ok"] is True


def test_api_stream_claude_native_session_binds_and_resumes(tmp_path, monkeypatch):
    # Unified chat entry: one SuperClaw chat = ONE native claude session. First
    # turn creates the binding (--session-id, history seeded); the second turn
    # resumes the SAME id with no replay. Deltas ride the stream as
    # message.delta — the same SSE contract the codex inline channel uses.
    calls = []

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        calls.append({"native_id": native_session_id, "is_resume": is_resume, "seed": history_seed})
        if on_event:
            on_event("message.delta", {"text": "正在"})
            on_event("message.delta", {"text": "回答"})
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "正在回答", "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    r1 = client.post(
        "/api/chat/stream",
        json={"message": "你是谁", "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path), "budget_seconds": 10},
    )
    assert r1.status_code == 200
    assert "message.delta" in r1.text and "chat.completed" in r1.text
    sid = r1.text.split('"session_id": "')[1].split('"')[0]

    from superclaw.state import StateStore

    store = StateStore(tmp_path / "state.db")
    bound = store.get_chat_native_session_id(sid, "claude")
    assert bound == calls[0]["native_id"]  # binding persisted after success
    assert calls[0]["is_resume"] is False

    r2 = client.post(
        "/api/chat/stream",
        json={"message": "继续", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path), "budget_seconds": 10},
    )
    assert r2.status_code == 200
    assert calls[1]["native_id"] == bound  # SAME native session resumed
    assert calls[1]["is_resume"] is True
    assert calls[1]["seed"] == ""  # native memory: no transcript replay


def test_api_native_binding_is_pending_before_turn_completes(tmp_path, monkeypatch):
    # B1: the binding persists BEFORE execution so a concurrent turn reuses the
    # same native session instead of forking a second one.
    from superclaw.state import StateStore

    observed = {}

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        store2 = StateStore(tmp_path / "state.db")
        sid = observed["session_id"]
        observed["binding_during_turn"] = store2.get_chat_native_session_id(sid, "claude")
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "ok", "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("pending bind")
    observed["session_id"] = session.session_id

    r = client.post("/api/chat/turn", json={"message": "hi", "session_id": session.session_id,
                                            "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    assert r.json()["status"] == "completed"
    assert observed["binding_during_turn"]  # bound BEFORE the turn ran


def test_api_native_repo_change_retires_binding(tmp_path, monkeypatch):
    # G5: native sessions are per-workspace — a repo switch rebuilds with a
    # fresh session + full seed instead of resuming into the wrong cwd.
    calls = []

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        calls.append({"id": native_session_id, "resume": is_resume})
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "ok", "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    repo_a = tmp_path / "a"
    repo_a.mkdir()
    repo_b = tmp_path / "b"
    repo_b.mkdir()
    _trust_repo(tmp_path, repo=repo_a)
    _trust_repo(tmp_path, repo=repo_b)

    r1 = client.post("/api/chat/turn", json={"message": "hi", "backend_policy": "claude", "mode": "chat", "repo_path": str(repo_a)})
    sid = r1.json()["session_id"]
    client.post("/api/chat/turn", json={"message": "again", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(repo_a)})
    assert calls[1]["resume"] is True and calls[1]["id"] == calls[0]["id"]  # same repo resumes

    client.post("/api/chat/turn", json={"message": "moved", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(repo_b)})
    assert calls[2]["resume"] is False and calls[2]["id"] != calls[0]["id"]  # repo change -> fresh session


def test_api_native_catch_up_flows_after_runtime_switch(tmp_path, monkeypatch):
    # G1 end-to-end: turns answered on ANOTHER runtime reach claude as a
    # one-time catch-up block when the chat switches back.
    from superclaw.state import StateStore

    calls = []

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        calls.append({"resume": is_resume, "catch_up": catch_up, "seed": history_seed})
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "回答" + str(len(calls)), "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    r1 = client.post("/api/chat/turn", json={"message": "第一轮", "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    sid = r1.json()["session_id"]
    # simulate two turns answered on a DIFFERENT runtime (transcript grows
    # without claude's watermark advancing)
    store = StateStore(tmp_path / "state.db")
    store.append_chat_message(sid, "user", "codex 期间的提问")
    store.append_chat_message(sid, "assistant", "codex 期间的回答")

    client.post("/api/chat/turn", json={"message": "切回来了", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    assert calls[1]["resume"] is True
    assert "codex 期间的提问" in calls[1]["catch_up"] and "codex 期间的回答" in calls[1]["catch_up"]
    assert calls[1]["seed"] == ""  # catch-up replaces full replay on resume

    # third turn with no intervening foreign turns: nothing to catch up
    client.post("/api/chat/turn", json={"message": "再聊", "session_id": sid, "backend_policy": "claude", "mode": "chat", "repo_path": str(tmp_path)})
    assert calls[2]["catch_up"] == ""


def test_api_native_ask_allow_switch_preserves_binding(tmp_path, monkeypatch):
    # Max-permission doctrine: ask and allow both project onto bypassPermissions
    # and run at max (equal authority), so switching ask -> allow is NOT a
    # privilege widening — the native session is PRESERVED (resumes), not reset.
    calls = []

    def fake_native(*, content, repo, budget_seconds, model=None, effort=None, permission_mode=None,
                    native_session_id, is_resume, history_seed="", catch_up="", context_text="", on_event=None):
        calls.append({"id": native_session_id, "resume": is_resume})
        return {"intent": "chat", "backend": "claude", "status": "completed",
                "response": "ok", "native_session_id": native_session_id}

    monkeypatch.setattr("superclaw.chat_turn.execute_claude_native_chat_turn", fake_native)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    _trust_repo(tmp_path)

    r1 = client.post("/api/chat/turn", json={"message": "hi", "backend_policy": "claude", "mode": "chat",
                                             "permission_preset": "ask", "repo_path": str(tmp_path)})
    sid = r1.json()["session_id"]
    client.post("/api/chat/turn", json={"message": "again", "session_id": sid, "backend_policy": "claude", "mode": "chat",
                                        "permission_preset": "ask", "repo_path": str(tmp_path)})
    assert calls[1]["resume"] is True  # same posture resumes

    client.post("/api/chat/turn", json={"message": "now full auto", "session_id": sid, "backend_policy": "claude", "mode": "chat",
                                        "permission_preset": "allow", "repo_path": str(tmp_path)})
    # equal authority (ask == allow == max) -> NOT a widening -> same session resumes
    assert calls[2]["resume"] is True and calls[2]["id"] == calls[1]["id"]


def test_api_agents_probe_projects_kernel_three_state(tmp_path, monkeypatch):
    import superclaw.runtime_probe as runtime_probe
    from superclaw.runtime_probe import ProbeResult, ProbeVerdict

    def _fake_probe_all(backend_names=None, *, backends=None, force_refresh=True):
        return [
            ProbeResult(
                backend="codex", verdict=ProbeVerdict.RUNTIME_READY, detail="ok",
                depth="live", present=True, models_count=4, latency_ms=120,
            ),
            ProbeResult(
                backend="claude", verdict=ProbeVerdict.RUNTIME_PRESENT, detail="present",
                depth="shallow", present=True,
            ),
        ]

    monkeypatch.setattr(runtime_probe, "probe_runtimes", _fake_probe_all)
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)

    response = client.get("/api/agents/probe")
    assert response.status_code == 200, response.text
    payload = response.json()
    by_name = {p["backend"]: p for p in payload["probes"]}
    assert by_name["codex"]["verdict"] == "runtime_ready"
    assert by_name["codex"]["models_count"] == 4
    assert by_name["claude"]["verdict"] == "runtime_present"


def test_api_agents_probe_unknown_backend_is_404(tmp_path):
    app = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    response = client.get("/api/agents/probe", params={"backend": "does-not-exist"})
    assert response.status_code == 404
