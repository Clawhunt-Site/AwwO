"""Tests for the human-edit path: team_kernel.update_agent_profile.

The creation path could already SET model/skill/permission/charter; this is the
missing half — changing them AFTER creation (Paperclip's per-agent settings
edit). Only whitelisted fields move, identity/scope and the charter are rejected,
and the same fail-closed gates the creation path uses (permission mode,
reports_to acyclicity, governance scope) apply to every edit.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw import team_kernel
from superclaw.cli import app
from superclaw.models import AgentProfile, WorkspaceProfile
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


# --- partial update + revision -------------------------------------------------


def test_update_changes_only_provided_fields(store):
    p = make_profile(store, model="claude-opus-4-8", title="Senior", persona="terse")
    before_rev = p.revision_id
    updated, _ = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"model": "claude-sonnet-4-6"}
    )
    assert updated.model == "claude-sonnet-4-6"
    # untouched fields survive
    assert updated.title == "Senior"
    assert updated.persona == "terse"
    # revision bumped + persisted
    assert updated.revision_id != before_rev
    assert store.get_agent_profile(p.profile_id).model == "claude-sonnet-4-6"


def test_update_applies_effort_and_persists(store):
    """effort is an editable profile field parallel to model: the human-edit path
    moves it (EDITABLE_PROFILE_FIELDS), it persists, and it round-trips."""
    p = make_profile(store, model="claude-opus-4-8")
    assert p.effort == ""  # empty default = backend's own default effort
    updated, _ = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"effort": "high"}
    )
    assert updated.effort == "high"
    assert updated.model == "claude-opus-4-8"  # untouched
    assert store.get_agent_profile(p.profile_id).effort == "high"


def test_update_unknown_profile_raises_keyerror(store):
    with pytest.raises(KeyError):
        team_kernel.update_agent_profile(store, "nope", patch={"model": "x"})


# --- immutable / non-editable fields -------------------------------------------


@pytest.mark.parametrize(
    "field",
    [
        "profile_id", "workspace_id", "company_profile_id", "owner_id",
        "charter", "charter_source", "charter_revision_id", "revision_id",
        "workspace_policy", "created_at", "metadata",
    ],
)
def test_immutable_fields_rejected(store, field):
    p = make_profile(store)
    with pytest.raises(ValueError, match="not editable"):
        team_kernel.update_agent_profile(store, p.profile_id, patch={field: "x"})


def test_empty_patch_rejected(store):
    # The kernel — not just the CLI — refuses a no-op edit so a stray empty
    # call cannot bump revision_id with no behavioural change.
    p = make_profile(store)
    before = p.revision_id
    with pytest.raises(ValueError, match="empty patch"):
        team_kernel.update_agent_profile(store, p.profile_id, patch={})
    assert store.get_agent_profile(p.profile_id).revision_id == before


def test_reports_to_overlong_chain_fails_closed(store):
    # A chain longer than the manager-walk bound cannot be proven acyclic; the
    # kernel must REJECT (fail-closed), not walk off the end and silently allow.
    chain_len = team_kernel._MAX_MANAGER_CHAIN + 3
    prev = None
    head = None
    for i in range(chain_len):
        node = make_profile(store, name=f"m{i}", reports_to=prev)
        if head is None:
            head = node  # m0, the deepest (reports to nothing)
        prev = node.profile_id
    tail = make_profile(store, name="tail")  # independent profile
    # tail -> prev (the chain head) makes a chain_len-deep walk -> over the bound.
    with pytest.raises(ValueError, match="exceeds|cycle"):
        team_kernel.update_agent_profile(store, tail.profile_id, patch={"reports_to": prev})


def test_apply_heartbeat_helper_preserves_siblings(store):
    rc = {"heartbeat": {"enabled": True, "interval_sec": 30}, "other_setting": "keep"}
    off = team_kernel.apply_heartbeat(rc, enabled=False)
    assert "heartbeat" not in off and off["other_setting"] == "keep"
    on = team_kernel.apply_heartbeat({"other_setting": "keep"}, enabled=True, interval_sec=99)
    assert on["heartbeat"] == {"enabled": True, "interval_sec": 99}
    assert on["other_setting"] == "keep"
    assert team_kernel.apply_heartbeat(None, enabled=False) == {}


# --- permission validation (same gate as creation) -----------------------------


def test_permission_mode_validated(store):
    p = make_profile(store)
    with pytest.raises(ValueError, match="permission_policy"):
        team_kernel.update_agent_profile(
            store, p.profile_id, patch={"permission_policy": {"mode": "wide-open"}}
        )
    # a valid mode applies
    updated, _ = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"permission_policy": {"mode": "plan"}}
    )
    assert updated.permission_policy == {"mode": "plan"}
    # empty policy (inherit) is allowed
    updated, _ = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"permission_policy": {}}
    )
    assert updated.permission_policy == {}


# --- reports_to acyclicity -----------------------------------------------------


def test_reports_to_self_rejected(store):
    p = make_profile(store)
    with pytest.raises(ValueError, match="report to itself"):
        team_kernel.update_agent_profile(store, p.profile_id, patch={"reports_to": p.profile_id})


def test_reports_to_cycle_rejected(store):
    ceo = make_profile(store, name="CEO", role="ceo")
    mgr = make_profile(store, name="Mgr", role="manager", reports_to=ceo.profile_id)
    # ceo -> mgr would close the cycle ceo->mgr->ceo
    with pytest.raises(ValueError, match="cycle"):
        team_kernel.update_agent_profile(store, ceo.profile_id, patch={"reports_to": mgr.profile_id})


def test_reports_to_dangling_manager_allowed(store):
    # The creation path permits a not-yet-created manager ref; so does edit.
    p = make_profile(store)
    updated, _ = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"reports_to": "profile_not_created_yet"}
    )
    assert updated.reports_to == "profile_not_created_yet"


def test_reports_to_valid_chain_allowed(store):
    ceo = make_profile(store, name="CEO", role="ceo")
    eng = make_profile(store, name="Eng")
    updated, _ = team_kernel.update_agent_profile(
        store, eng.profile_id, patch={"reports_to": ceo.profile_id}
    )
    assert updated.reports_to == ceo.profile_id


# --- skill edit flows through the fail-closed equipment gate --------------------


def test_skill_allowlist_edit_resolves_fail_closed(store):
    p = make_profile(store)
    # An unknown skill is stored on the allowlist but DROPPED by resolve_equipment
    # (no governed plugin backs it) — editing cannot grant ungoverned capability.
    updated, resolution = team_kernel.update_agent_profile(
        store, p.profile_id, patch={"skill_allowlist": ["totally-made-up-skill"]}
    )
    assert updated.skill_allowlist == ["totally-made-up-skill"]
    assert "totally-made-up-skill" not in resolution.skills_granted


# --- optimistic concurrency ----------------------------------------------------


def test_expected_revision_guard(store):
    p = make_profile(store)
    stale_rev = p.revision_id
    # First edit succeeds and moves the revision.
    team_kernel.update_agent_profile(
        store, p.profile_id, patch={"title": "A"}, expected_revision_id=stale_rev
    )
    # A second edit holding the now-stale revision is rejected (no clobber).
    with pytest.raises(ValueError, match="modified"):
        team_kernel.update_agent_profile(
            store, p.profile_id, patch={"title": "B"}, expected_revision_id=stale_rev
        )


# --- governance scope still enforced on save -----------------------------------


def test_update_preserves_governance_scope(store):
    ws = WorkspaceProfile(name="HQ", repo_path=".")
    store.save_workspace_profile(ws)
    p = make_profile(store, workspace_id=ws.workspace_id)
    # A normal edit on a registered workspace saves fine (scope assertion passes).
    updated, _ = team_kernel.update_agent_profile(store, p.profile_id, patch={"model": "m"})
    assert updated.model == "m"


# --- CLI surface (agent update-profile) ----------------------------------------


def test_cli_update_profile_partial(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    created = runner.invoke(
        app, ["agent", "create-profile", "CEO", "ceo", "--model", "claude-opus-4-8", "--title", "Boss"]
    )
    assert created.exit_code == 0, created.output
    pid = json.loads(created.output)["profile"]["profile_id"]

    updated = runner.invoke(
        app,
        ["agent", "update-profile", pid, "--model", "claude-sonnet-4-6", "--heartbeat", "--permission", "allow"],
    )
    assert updated.exit_code == 0, updated.output
    profile = json.loads(updated.output)["profile"]
    assert profile["model"] == "claude-sonnet-4-6"
    assert profile["title"] == "Boss"  # untouched field preserved
    assert profile["runtime_config"]["heartbeat"]["enabled"] is True
    assert profile["permission_policy"] == {"mode": "bypassPermissions"}


def test_cli_create_and_update_effort(tmp_path, monkeypatch):
    """--effort rides the CLI create/update path the same way --model does (per-
    agent persistent reasoning effort)."""
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    created = runner.invoke(
        app, ["agent", "create-profile", "Eng", "engineer", "--backend", "codex", "--effort", "high"]
    )
    assert created.exit_code == 0, created.output
    profile = json.loads(created.output)["profile"]
    assert profile["effort"] == "high"
    pid = profile["profile_id"]

    # '' resets to backend default (parallel to --model reset semantics).
    updated = runner.invoke(app, ["agent", "update-profile", pid, "--effort", ""])
    assert updated.exit_code == 0, updated.output
    assert json.loads(updated.output)["profile"]["effort"] == ""


def test_cli_update_profile_requires_a_field(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    created = runner.invoke(app, ["agent", "create-profile", "Eng", "engineer"])
    pid = json.loads(created.output)["profile"]["profile_id"]
    empty = runner.invoke(app, ["agent", "update-profile", pid])
    assert empty.exit_code == 1
    assert "no fields to update" in empty.output


def test_cli_update_profile_unknown_id(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    out = runner.invoke(app, ["agent", "update-profile", "nope", "--model", "x"])
    assert out.exit_code == 1
    assert "unknown agent profile" in out.output


def _cli_create(runner, *args):
    out = runner.invoke(app, ["agent", "create-profile", *args])
    assert out.exit_code == 0, out.output
    return json.loads(out.output)["profile"]["profile_id"]


def test_cli_no_heartbeat_removes_only_heartbeat(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    pid = _cli_create(runner, "Eng", "engineer", "--heartbeat")
    # Seed a sibling runtime_config key directly, then toggle heartbeat off.
    store = StateStore(tmp_path / "state.db")
    prof = store.get_agent_profile(pid)
    prof.runtime_config = {**prof.runtime_config, "other_setting": "keep"}
    store.save_agent_profile(prof)
    out = runner.invoke(app, ["agent", "update-profile", pid, "--no-heartbeat"])
    assert out.exit_code == 0, out.output
    rc = json.loads(out.output)["profile"]["runtime_config"]
    assert "heartbeat" not in rc
    assert rc["other_setting"] == "keep"  # sibling preserved


def test_cli_reports_to_none_clears(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    ceo = _cli_create(runner, "CEO", "ceo")
    eng = _cli_create(runner, "Eng", "engineer", "--reports-to", ceo)
    out = runner.invoke(app, ["agent", "update-profile", eng, "--reports-to", "none"])
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["profile"]["reports_to"] is None


def test_cli_permission_inherit_resets(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    pid = _cli_create(runner, "Eng", "engineer", "--permission", "allow")
    out = runner.invoke(app, ["agent", "update-profile", pid, "--permission", "inherit"])
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["profile"]["permission_policy"] == {}


def test_cli_self_report_error_passthrough(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    pid = _cli_create(runner, "Eng", "engineer")
    out = runner.invoke(app, ["agent", "update-profile", pid, "--reports-to", pid])
    assert out.exit_code == 1
    assert "report to itself" in out.output
