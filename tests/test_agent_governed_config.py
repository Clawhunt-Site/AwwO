"""Tests for L2: agent-governed config change + hire (approval-gated).

A running agent can REQUEST an org change — reconfigure a role or hire a new
one — but the kernel never applies it directly. The request records a PENDING
approval; the same human gate that ships issues is what finally applies it,
through update_agent_profile / a profile create. Every authoritative gate
(permission, reports_to acyclicity, governance scope) runs at APPLY time, so an
approval whose apply would violate a rule fails closed: it stays pending instead
of recording a grant whose effect never landed.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw import team_kernel
from superclaw.cli import app
from superclaw.models import AgentProfile, Approval, ApprovalStatus, ApprovalType
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def make_profile(store, **kwargs):
    profile = AgentProfile(
        name=kwargs.pop("name", "Eng"),
        role=kwargs.pop("role", "engineer"),
        backend_policy=kwargs.pop("backend_policy", "claude"),
        **kwargs,
    )
    store.save_agent_profile(profile)
    return profile


# --- config change: request records, grant applies, reject does not -----------


def test_request_config_change_records_pending_does_not_apply(store):
    p = make_profile(store, model="claude-opus-4-8")
    approval = team_kernel.request_agent_config_change(
        store, target_profile_id=p.profile_id, patch={"model": "claude-sonnet-4-6"}, requested_by=p.profile_id
    )
    assert approval.type == ApprovalType.AGENT_CONFIG_CHANGE.value
    assert approval.status == ApprovalStatus.PENDING.value
    # NOT applied yet — the model is still the original.
    assert store.get_agent_profile(p.profile_id).model == "claude-opus-4-8"


def test_grant_applies_the_config_change(store):
    p = make_profile(store, model="claude-opus-4-8")
    approval = team_kernel.request_agent_config_change(
        store, target_profile_id=p.profile_id, patch={"model": "claude-sonnet-4-6"}, requested_by=p.profile_id
    )
    decided, issue = team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert issue is None
    assert decided.status == ApprovalStatus.APPROVED.value
    # Now applied through update_agent_profile.
    assert store.get_agent_profile(p.profile_id).model == "claude-sonnet-4-6"


def test_reject_does_not_apply(store):
    p = make_profile(store, model="claude-opus-4-8")
    approval = team_kernel.request_agent_config_change(
        store, target_profile_id=p.profile_id, patch={"model": "x"}, requested_by=p.profile_id
    )
    decided, _ = team_kernel.decide_approval(store, approval.approval_id, approved=False)
    assert decided.status == ApprovalStatus.REJECTED.value
    assert store.get_agent_profile(p.profile_id).model == "claude-opus-4-8"


# --- request-time validation ---------------------------------------------------


def test_request_unknown_target_raises(store):
    with pytest.raises(KeyError):
        team_kernel.request_agent_config_change(
            store, target_profile_id="nope", patch={"model": "x"}, requested_by="r"
        )


def test_request_empty_patch_rejected(store):
    p = make_profile(store)
    with pytest.raises(ValueError, match="empty patch"):
        team_kernel.request_agent_config_change(
            store, target_profile_id=p.profile_id, patch={}, requested_by="r"
        )


def test_request_non_editable_field_rejected(store):
    p = make_profile(store)
    with pytest.raises(ValueError, match="not editable"):
        team_kernel.request_agent_config_change(
            store, target_profile_id=p.profile_id, patch={"workspace_id": "x"}, requested_by="r"
        )


# --- the authoritative gate runs at APPLY (fail-closed) ------------------------


def test_apply_failure_leaves_approval_pending(store):
    # A patch that is well-formed at request time but would violate the kernel's
    # reports_to acyclicity at apply: the request records it, but the grant's
    # apply raises and the approval must stay PENDING (re-decidable), never
    # recording a grant whose effect never landed.
    ceo = make_profile(store, name="CEO", role="ceo")
    mgr = make_profile(store, name="Mgr", role="manager", reports_to=ceo.profile_id)
    approval = team_kernel.request_agent_config_change(
        store, target_profile_id=ceo.profile_id, patch={"reports_to": mgr.profile_id}, requested_by=ceo.profile_id
    )
    with pytest.raises(ValueError, match="cycle"):
        team_kernel.decide_approval(store, approval.approval_id, approved=True)
    # Fail-closed: approval untouched, target unchanged.
    assert store.get_approval(approval.approval_id).status == ApprovalStatus.PENDING.value
    assert store.get_agent_profile(ceo.profile_id).reports_to is None


@pytest.mark.parametrize("resume", [{"kernel": "agent.bogus"}, {}, {"kernel": ""}])
def test_grant_unknown_or_missing_kernel_fails_closed(store, resume):
    # A non-issue approval whose resume_action does not resolve to a known apply
    # must NOT be grantable into an approved no-op — the grant raises and the
    # approval stays pending (fail-closed).
    approval = Approval(type=ApprovalType.AGENT_CONFIG_CHANGE.value, requested_by="r", resume_action=resume)
    store.save_approval(approval)
    with pytest.raises(ValueError):
        team_kernel.decide_approval(store, approval.approval_id, approved=True)
    assert store.get_approval(approval.approval_id).status == ApprovalStatus.PENDING.value


def test_request_hire_rejects_invalid_permission_at_kernel(store):
    # The kernel entry — not only the CLI — gates the permission mode.
    with pytest.raises(ValueError, match="permission_policy"):
        team_kernel.request_hire(
            store,
            spec={"name": "X", "role": "r", "permission_policy": {"mode": "wide-open"}},
            requested_by="ceo",
        )


def test_apply_runs_skill_fail_closed(store):
    # An ungoverned skill requested via the approval is stored on the allowlist
    # but stays dropped by resolve_equipment at apply — granting cannot bestow
    # ungoverned capability.
    p = make_profile(store)
    approval = team_kernel.request_agent_config_change(
        store, target_profile_id=p.profile_id, patch={"skill_allowlist": ["made-up-skill"]}, requested_by="r"
    )
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    updated = store.get_agent_profile(p.profile_id)
    assert updated.skill_allowlist == ["made-up-skill"]
    assert "made-up-skill" not in team_kernel.resolve_equipment(updated).skills_granted


# --- hire: request records, grant creates -------------------------------------


def test_request_hire_records_pending_does_not_create(store):
    approval = team_kernel.request_hire(
        store, spec={"name": "NewEng", "role": "engineer", "model": "claude-opus-4-8"}, requested_by="ceo"
    )
    assert approval.type == ApprovalType.AGENT_HIRE.value
    assert approval.status == ApprovalStatus.PENDING.value
    # No profile created yet.
    assert all(a.name != "NewEng" for a in store.list_agent_profiles())


def test_grant_hire_creates_the_profile(store):
    approval = team_kernel.request_hire(
        store, spec={"name": "NewEng", "role": "engineer", "model": "claude-sonnet-4-6"}, requested_by="ceo"
    )
    team_kernel.decide_approval(store, approval.approval_id, approved=True)
    hired = [a for a in store.list_agent_profiles() if a.name == "NewEng"]
    assert len(hired) == 1
    assert hired[0].role == "engineer" and hired[0].model == "claude-sonnet-4-6"


def test_reject_hire_creates_nothing(store):
    approval = team_kernel.request_hire(store, spec={"name": "Ghost", "role": "engineer"}, requested_by="ceo")
    team_kernel.decide_approval(store, approval.approval_id, approved=False)
    assert all(a.name != "Ghost" for a in store.list_agent_profiles())


def test_request_hire_requires_name_and_role(store):
    with pytest.raises(ValueError, match="name and role"):
        team_kernel.request_hire(store, spec={"name": "Nameless"}, requested_by="ceo")


def test_request_hire_rejects_unknown_spec_fields(store):
    with pytest.raises(ValueError, match="unknown hire spec"):
        team_kernel.request_hire(
            store, spec={"name": "X", "role": "r", "profile_id": "forged"}, requested_by="ceo"
        )


# --- create_agent_from_spec: shared direct-creation point ----------------------


def test_create_agent_from_spec_creates_and_persists(store):
    # The direct, user-triggered creation point (also reused by the grant path):
    # validates + builds + saves the agent in one shot, returning the profile.
    profile = team_kernel.create_agent_from_spec(
        store,
        {"name": "Bob", "role": "engineer", "model": "claude-sonnet-4-6"},
        requested_by="user",
    )
    assert profile.name == "Bob" and profile.role == "engineer"
    assert store.get_agent_profile(profile.profile_id).model == "claude-sonnet-4-6"


def test_create_agent_from_spec_validates_name_and_role(store):
    with pytest.raises(ValueError, match="name and role"):
        team_kernel.create_agent_from_spec(
            store, {"name": "Nameless"}, requested_by="user"
        )


def test_create_agent_from_spec_rejects_unknown_fields(store):
    with pytest.raises(ValueError, match="unknown hire spec"):
        team_kernel.create_agent_from_spec(
            store, {"name": "X", "role": "r", "profile_id": "forged"}, requested_by="user"
        )


def test_create_agent_from_spec_rejects_invalid_permission(store):
    with pytest.raises(ValueError, match="permission_policy"):
        team_kernel.create_agent_from_spec(
            store,
            {"name": "X", "role": "r", "permission_policy": {"mode": "wide-open"}},
            requested_by="user",
        )


# --- CLI surface ---------------------------------------------------------------


def test_cli_request_config_change_and_grant(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    created = runner.invoke(app, ["agent", "create-profile", "CEO", "ceo", "--model", "claude-opus-4-8"])
    pid = json.loads(created.output)["profile"]["profile_id"]
    req = runner.invoke(
        app, ["agent", "request-config-change", pid, "--by", pid, "--model", "claude-sonnet-4-6"]
    )
    assert req.exit_code == 0, req.output
    approval_id = json.loads(req.output)["approval_id"]
    # Still the old model until granted.
    store = StateStore(tmp_path / "state.db")
    assert store.get_agent_profile(pid).model == "claude-opus-4-8"
    granted = runner.invoke(app, ["approve", "grant", approval_id])
    assert granted.exit_code == 0, granted.output
    assert store.get_agent_profile(pid).model == "claude-sonnet-4-6"


def test_cli_request_hire(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    out = runner.invoke(app, ["agent", "request-hire", "NewEng", "engineer", "--by", "ceo", "--model", "m"])
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["type"] == "agent_hire"
