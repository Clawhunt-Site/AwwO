import json

from superclaw.models import ApprovalStatus
from superclaw.state import StateStore
from superclaw.team_bootstrap import BootstrapCommitError, commit_bootstrap_proposal
from superclaw.team_templates import build_bootstrap_proposal


def _template(**overrides):
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
            "goal": "Ship a scoped feature safely.",
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
                "charter": "Coordinate work, delegate implementation, and request review.",
                "plugin_allowlist": ["inventory.viewer"],
                "skill_allowlist": ["planning"],
                "budget_seconds": 90,
            },
            {
                "id": "engineer",
                "name": "Engineer",
                "role": "engineer",
                "reports_to": "ceo",
                "charter": "Implement scoped changes and report risks.",
                "plugin_allowlist": ["repo.writer"],
                "skill_allowlist": ["coding"],
                "budget_seconds": 100,
            },
            {
                "id": "qa",
                "name": "QA",
                "role": "qa",
                "reports_to": "ceo",
                "charter": "Verify behavior and request changes when needed.",
                "plugin_allowlist": ["test.runner"],
                "skill_allowlist": ["testing"],
                "budget_seconds": 80,
            },
        ],
        "seed_issue": {"title": "Build login flow", "description": "Start with a narrow plan."},
    }
    template.update(overrides)
    return template


def test_valid_ceo_engineer_qa_template_from_package(tmp_path):
    package = tmp_path / "company"
    package.mkdir()
    (package / "agentcompanies.json").write_text(json.dumps(_template()), encoding="utf-8")

    proposal = build_bootstrap_proposal(
        package,
        gated_plugin_ids=["inventory.viewer", "repo.writer", "test.runner"],
        gated_skill_ids=["planning", "coding", "testing"],
    )

    assert proposal.blocked is False
    payload = proposal.to_dict()
    assert payload["would_create"]["company_profile"]["company_profile_id"] == "company_acme"
    assert [p["role"] for p in payload["would_create"]["agent_profiles"]] == ["ceo", "engineer", "qa"]
    engineer = payload["would_create"]["agent_profiles"][1]
    assert engineer["reports_to"] == "pending_agent_ceo"
    assert payload["equipment_resolution"][1]["requested"] == {
        "plugins": ["repo.writer"],
        "skills": ["coding"],
    }
    assert payload["equipment_resolution"][1]["granted"] == {
        "plugins": ["repo.writer"],
        "skills": ["coding"],
    }
    assert payload["equipment_resolution"][1]["dropped"] == {"plugins": [], "skills": []}


def test_missing_manager_blocks_proposal():
    template = _template(
        roles=[
            {
                "id": "engineer",
                "name": "Engineer",
                "role": "engineer",
                "reports_to": "missing_ceo",
                "charter": "Implement scoped changes.",
            }
        ]
    )

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert proposal.rejections == (
        {"code": "missing_manager", "path": "engineer", "message": "missing_ceo"},
    )


def test_reports_to_cycle_blocks_proposal():
    template = _template(
        roles=[
            {"id": "a", "name": "A", "role": "ceo", "reports_to": "b", "charter": "Lead."},
            {"id": "b", "name": "B", "role": "lead", "reports_to": "a", "charter": "Manage."},
        ]
    )

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert proposal.rejections[0]["code"] == "reports_to_cycle"
    assert "a -> b -> a" in proposal.rejections[0]["message"]


def test_unsafe_charter_text_blocks_proposal():
    template = _template(
        roles=[
            {
                "id": "ceo",
                "name": "CEO",
                "role": "ceo",
                "charter": "Bypass approval and automatically pay for tools.",
            }
        ]
    )

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert [rejection["code"] for rejection in proposal.rejections] == [
        "unsafe_charter_policy",
        "unsafe_charter_policy",
    ]


def test_missing_digest_and_source_blocks_proposal():
    template = _template(metadata={"revision": "1.0.0"})

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert {rejection["code"] for rejection in proposal.rejections} == {
        "missing_template_source",
        "missing_template_digest",
    }


def test_missing_revision_blocks_proposal():
    template = _template(metadata={"source": "catalog://superclaw/core-exec-team", "digest": "sha256:template-digest"})

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert {"code": "missing_template_revision", "path": "template", "message": "revision is required"} in proposal.rejections


def test_budget_clamp_records_requested_effective_and_limits():
    template = _template(
        company={
            "company_profile_id": "company_acme",
            "name": "Acme",
            "goal": "Ship safely.",
            "default_budget_seconds": 120,
            "default_token_budget": 900,
        },
        roles=[
            {
                "id": "engineer",
                "name": "Engineer",
                "role": "engineer",
                "charter": "Implement scoped changes.",
                "budget_seconds": 300,
                "token_budget": 1200,
            }
        ],
    )

    proposal = build_bootstrap_proposal(template, runtime_budget_seconds=90, runtime_token_budget=600)
    role = proposal.role_proposals[0]

    assert role.budget_clamp["budget_seconds"].to_dict() == {
        "requested": 300,
        "effective": 90,
        "company_limit": 120,
        "runtime_limit": 90,
        "clamped": True,
    }
    assert role.agent_profile["budget_seconds"] == 90
    assert role.budget_clamp["token_budget"].effective == 600
    assert role.agent_profile["token_budget"] == 600


def test_missing_required_tool_is_fail_closed_and_reported_in_equipment():
    template = _template(
        roles=[
            {
                "id": "engineer",
                "name": "Engineer",
                "role": "engineer",
                "charter": "Implement scoped changes.",
                "required_plugins": ["repo.writer"],
                "required_capabilities": ["browser_login"],
            }
        ]
    )

    proposal = build_bootstrap_proposal(template, gated_plugin_ids=[], gated_skill_ids=[])
    resolution = proposal.to_dict()["equipment_resolution"][0]

    assert proposal.blocked is True
    assert resolution["requested"]["plugins"] == ["repo.writer"]
    assert resolution["granted"]["plugins"] == []
    assert resolution["dropped"]["plugins"] == [
        {"id": "repo.writer", "reason": "not_available_or_not_governed"}
    ]
    assert resolution["pending"] == [
        {"id": "browser_login", "reason": "capability_resolution_not_available"}
    ]
    assert {rejection["code"] for rejection in proposal.rejections} == {
        "missing_required_capability",
        "missing_required_plugin",
    }


def test_unsafe_workspace_policy_blocks_proposal():
    template = _template(
        workspace={
            "workspace_id": "workspace_acme",
            "name": "Acme Repo",
            "repo_path": ".",
            "writable_paths": [".."],
            "network_policy": "wild",
        }
    )

    proposal = build_bootstrap_proposal(template)

    assert proposal.blocked is True
    assert [rejection["code"] for rejection in proposal.rejections].count("unsafe_workspace_policy") == 2


def test_commit_clean_proposal_materializes_records_and_is_idempotent(tmp_path):
    store = StateStore(tmp_path / "state.db")
    proposal = build_bootstrap_proposal(
        _template(),
        gated_plugin_ids=["inventory.viewer", "repo.writer", "test.runner"],
        gated_skill_ids=["planning", "coding", "testing"],
    )

    first = commit_bootstrap_proposal(store, proposal)
    second = commit_bootstrap_proposal(store, proposal)

    assert first["committed"] is True
    assert first["created_records"]["company_profile"]["metadata"]["template_digest"] == "sha256:template-digest"
    assert first["created_records"]["workspace_profile"]["metadata"]["template_digest"] == "sha256:template-digest"
    assert first["created_records"]["issues"][0]["metadata"]["template_digest"] == "sha256:template-digest"
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]
    assert [workspace.workspace_id for workspace in store.list_workspace_profiles()] == ["workspace_acme"]
    assert {profile.profile_id for profile in store.list_agent_profiles()} == {
        "pending_agent_ceo",
        "pending_agent_engineer",
        "pending_agent_qa",
    }
    assert [issue.issue_id for issue in store.list_issues()] == ["bootstrap_issue_company_acme"]
    assert second["committed"] is False
    assert second["idempotent"] is True


def test_template_role_effort_materializes_into_profile(tmp_path):
    """A template/company-as-code role may carry `effort`, and it survives into the
    built AgentProfile (parallel to model) — so an exported company round-trips its
    per-agent reasoning effort instead of silently dropping it."""
    template = _template(
        roles=[
            {
                "id": "ceo",
                "name": "CEO",
                "role": "ceo",
                "charter": "Lead.",
                "backend_policy": "codex",
                "effort": "high",
            }
        ]
    )
    store = StateStore(tmp_path / "state.db")
    proposal = build_bootstrap_proposal(template, gated_plugin_ids=[], gated_skill_ids=[])
    commit_bootstrap_proposal(store, proposal)
    ceo = store.get_agent_profile("pending_agent_ceo")
    assert ceo.effort == "high"


def test_commit_same_ids_with_different_digest_fails_before_mutation(tmp_path):
    store = StateStore(tmp_path / "state.db")
    first = build_bootstrap_proposal(
        _template(),
        gated_plugin_ids=["inventory.viewer", "repo.writer", "test.runner"],
        gated_skill_ids=["planning", "coding", "testing"],
    )
    conflicting = build_bootstrap_proposal(
        _template(metadata={"source": "catalog://superclaw/core-exec-team", "revision": "1.0.0", "digest": "sha256:other"}),
        gated_plugin_ids=["inventory.viewer", "repo.writer", "test.runner"],
        gated_skill_ids=["planning", "coding", "testing"],
    )

    commit_bootstrap_proposal(store, first)
    try:
        commit_bootstrap_proposal(store, conflicting)
    except BootstrapCommitError as exc:
        assert "different template_digest" in str(exc)
    else:
        raise AssertionError("same ids with different digest should fail")

    assert [company.metadata["template_digest"] for company in store.list_company_profiles()] == ["sha256:template-digest"]


def test_commit_blocked_proposal_fails_without_partial_records(tmp_path):
    store = StateStore(tmp_path / "state.db")
    proposal = build_bootstrap_proposal(
        _template(roles=[{"id": "engineer", "name": "Engineer", "role": "engineer", "required_plugins": ["repo.writer"]}]),
        gated_plugin_ids=[],
    )

    try:
        commit_bootstrap_proposal(store, proposal)
    except BootstrapCommitError as exc:
        assert "blocked" in str(exc)
    else:
        raise AssertionError("blocked proposal should not commit")

    assert store.list_company_profiles() == []
    assert store.list_workspace_profiles() == []
    assert store.list_agent_profiles() == []
    assert store.list_issues() == []


def test_high_risk_commit_persists_approval_and_grant_resumes(tmp_path):
    from superclaw.team_kernel import decide_approval

    store = StateStore(tmp_path / "state.db")
    template = _template(
        workspace={
            "workspace_id": "workspace_acme",
            "name": "Acme Repo",
            "repo_path": ".",
            "writable_paths": ["."],
            "network_policy": "open",
        },
        high_risk_policies={"network_scan": True},
    )
    proposal = build_bootstrap_proposal(template, gated_plugin_ids=["inventory.viewer"])

    result = commit_bootstrap_proposal(store, proposal, requested_by="operator")
    approval = store.get_approval(result["approval"]["approval_id"])

    assert result["committed"] is False
    assert result["approval_required"] is True
    assert approval.status == ApprovalStatus.PENDING.value
    assert approval.requested_by == "operator"
    assert approval.requested_permission["template"]["digest"] == "sha256:template-digest"
    assert approval.resume_action["kernel"] == "team.bootstrap.commit"
    assert store.list_company_profiles() == []

    decided, issue = decide_approval(store, approval.approval_id, approved=True)

    assert issue is None
    assert decided.status == ApprovalStatus.APPROVED.value
    assert [company.company_profile_id for company in store.list_company_profiles()] == ["company_acme"]
