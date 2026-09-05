"""CLI parity for chat-driven company management (`superclaw company ...`).

The kernel/handler logic is covered in test_company_handler.py; here we verify
the CLI surface routes the SAME ``execute_company_command`` path (CLAUDE.md 铁律:
CLI is the single source of truth, zero drift across surfaces) — that each
subcommand builds the right typed command, injects an operator (admin) scope,
persists the real mutation, renders the outcome, and fails closed with a
friendly message + non-zero exit on bad input.
"""

import json

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.state import StateStore


@pytest.fixture
def state_path(tmp_path, monkeypatch):
    p = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(p))
    return p


def _store(state_path) -> StateStore:
    return StateStore(state_path)


def _invoke(args):
    return CliRunner().invoke(app, args)


# --- create ----------------------------------------------------------------


def test_company_snapshot_emits_dto(state_path):
    company_id = json.loads(
        _invoke(["company", "create", "--name", "SnapCo"]).output
    )["detail"]["company_profile_id"]
    _invoke(["company", "create-issue", "--company-id", company_id, "--title", "work"])
    result = _invoke(["company", "snapshot", company_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["company"]["company_profile_id"] == company_id
    assert payload["issues"]["issue_total"] == 1
    assert "roster" in payload and "cost" in payload


def test_company_snapshot_unknown_fails(state_path):
    result = _invoke(["company", "snapshot", "nope"])
    assert result.exit_code != 0


def test_company_create_persists_company(state_path):
    result = _invoke(
        ["company", "create", "--name", "Acme", "--goal", "Ship safely.", "--budget-seconds", "120"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "executed"
    company_id = payload["detail"]["company_profile_id"]

    # The company really exists in the store the CLI wrote to.
    company = _store(state_path).get_company_profile(company_id)
    assert company.name == "Acme"
    assert company.goal == "Ship safely."
    assert company.default_budget_seconds == 120
    # Authority is server-injected: the operator owns it.
    assert company.owner_id == "local_user"


def test_company_create_allowed_plugins_csv(state_path):
    result = _invoke(
        ["company", "create", "--name", "Beta", "--allowed-plugins", "a, b ,c"]
    )
    assert result.exit_code == 0, result.output
    company_id = json.loads(result.output)["detail"]["company_profile_id"]
    company = _store(state_path).get_company_profile(company_id)
    assert company.allowed_plugins == ["a", "b", "c"]


# --- hire ------------------------------------------------------------------


def test_company_hire_creates_agent(state_path):
    create = _invoke(["company", "create", "--name", "HireCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]

    result = _invoke(
        [
            "company",
            "hire",
            "--name",
            "Engineer",
            "--role",
            "engineer",
            "--company-id",
            company_id,
            "--charter",
            "Build features.",
        ]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "executed"
    profile_id = payload["detail"]["profile_id"]

    profile = _store(state_path).get_agent_profile(profile_id)
    assert profile.name == "Engineer"
    assert profile.role == "engineer"
    assert profile.company_profile_id == company_id
    assert profile.charter == "Build features."


def test_company_hire_carries_effort(state_path):
    """`company hire --effort` persists the role's reasoning effort (parallel to
    --model), riding the same _HIRE_SPEC_FIELDS whitelist."""
    create = _invoke(["company", "create", "--name", "EffortCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]
    result = _invoke(
        [
            "company", "hire", "--name", "Dev", "--role", "engineer",
            "--company-id", company_id, "--backend", "codex", "--effort", "high",
        ]
    )
    assert result.exit_code == 0, result.output
    profile_id = json.loads(result.output)["detail"]["profile_id"]
    assert _store(state_path).get_agent_profile(profile_id).effort == "high"


# --- issues ----------------------------------------------------------------


def test_company_create_and_assign_issue(state_path):
    store = _store(state_path)
    create = _invoke(["company", "create", "--name", "IssueCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]

    hire = _invoke(
        ["company", "hire", "--name", "Dev", "--role", "engineer", "--company-id", company_id]
    )
    profile_id = json.loads(hire.output)["detail"]["profile_id"]

    issue_res = _invoke(
        [
            "company",
            "create-issue",
            "--title",
            "Fix bug",
            "--company-id",
            company_id,
        ]
    )
    assert issue_res.exit_code == 0, issue_res.output
    issue_id = json.loads(issue_res.output)["detail"]["issue_id"]
    assert store.get_issue(issue_id).title == "Fix bug"

    assign_res = _invoke(
        [
            "company",
            "assign-issue",
            "--issue-id",
            issue_id,
            "--profile-id",
            profile_id,
            "--company-id",
            company_id,
        ]
    )
    assert assign_res.exit_code == 0, assign_res.output
    assert _store(state_path).get_issue(issue_id).assignee_agent_profile_id == profile_id


def test_company_delegate_issue_creates_child(state_path):
    store = _store(state_path)
    company_id = json.loads(
        _invoke(["company", "create", "--name", "DelegCo"]).output
    )["detail"]["company_profile_id"]
    profile_id = json.loads(
        _invoke(
            ["company", "hire", "--name", "Dev", "--role", "engineer", "--company-id", company_id]
        ).output
    )["detail"]["profile_id"]
    parent_id = json.loads(
        _invoke(
            ["company", "create-issue", "--title", "Parent", "--company-id", company_id]
        ).output
    )["detail"]["issue_id"]

    result = _invoke(
        [
            "company",
            "delegate-issue",
            "--parent-id",
            parent_id,
            "--assignee",
            profile_id,
            "--title",
            "Child task",
            "--company-id",
            company_id,
        ]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "executed"
    child_id = payload["detail"]["issue_id"]
    child = store.get_issue(child_id)
    assert child.title == "Child task"
    assert child.parent_id == parent_id
    assert child.assignee_agent_profile_id == profile_id


# --- comment / attach-work-product / submit-review (柱子 1b new commands) -----


def _company_with_issue(state_path):
    company_id = json.loads(
        _invoke(["company", "create", "--name", "ThreadCo"]).output
    )["detail"]["company_profile_id"]
    issue_id = json.loads(
        _invoke(
            ["company", "create-issue", "--title", "Work", "--company-id", company_id]
        ).output
    )["detail"]["issue_id"]
    return company_id, issue_id


def test_company_comment_posts_operator_authored(state_path):
    store = _store(state_path)
    company_id, issue_id = _company_with_issue(state_path)
    result = _invoke(
        [
            "company",
            "comment",
            "--issue-id",
            issue_id,
            "--body",
            "Please update",
            "--company-id",
            company_id,
        ]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["outcome"] == "executed"
    comments = store.list_issue_comments(issue_id)
    assert len(comments) == 1
    # CLI is the operator: author is server-injected as the user, not the body.
    assert comments[0].author_type == "user"
    assert comments[0].author_id == "local_user"
    assert comments[0].body == "Please update"


def test_company_attach_work_product(state_path):
    from superclaw import team_kernel

    store = _store(state_path)
    company_id, issue_id = _company_with_issue(state_path)
    result = _invoke(
        [
            "company",
            "attach-work-product",
            "--issue-id",
            issue_id,
            "--type",
            "pull_request",
            "--title",
            "PR #1",
            "--url",
            "http://x/pr/1",
            "--primary",
            "--company-id",
            company_id,
        ]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["outcome"] == "executed"
    products = team_kernel.list_work_products(store, issue_id)
    assert len(products) == 1
    assert products[0].type == "pull_request"
    assert products[0].company_profile_id == company_id
    assert products[0].is_primary is True


def test_company_attach_work_product_unknown_type_fails(state_path):
    company_id, issue_id = _company_with_issue(state_path)
    result = _invoke(
        [
            "company",
            "attach-work-product",
            "--issue-id",
            issue_id,
            "--type",
            "not_a_type",
            "--company-id",
            company_id,
        ]
    )
    assert result.exit_code != 0


def test_company_submit_review_binds_checkout_run(state_path):
    from superclaw import team_kernel
    from superclaw.models import AgentProfile, Issue, WorkspaceProfile

    store = _store(state_path)
    company_id, _ = _company_with_issue(state_path)
    # An assigned, checked-out issue (in_progress with a live checkout run).
    store.save_workspace_profile(
        WorkspaceProfile(name="ws", workspace_id="ws_sr", company_profile_id=company_id)
    )
    agent = store.save_agent_profile(
        AgentProfile(name="Eng", role="dev", company_profile_id=company_id, workspace_id="ws_sr")
    )
    issue = store.save_issue(
        Issue(title="work", company_profile_id=company_id, workspace_id="ws_sr")
    )
    team_kernel.assign_issue(store, issue.issue_id, agent.profile_id)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_live")

    # A matching run id submits; a stale one is refused.
    ok = _invoke(
        [
            "company",
            "submit-review",
            "--issue-id",
            issue.issue_id,
            "--expected-checkout-run-id",
            "run_live",
            "--company-id",
            company_id,
        ]
    )
    assert ok.exit_code == 0, ok.output
    assert _store(state_path).get_issue(issue.issue_id).status == "in_review"


def test_company_submit_review_stale_run_fails(state_path):
    from superclaw import team_kernel
    from superclaw.models import AgentProfile, Issue, WorkspaceProfile

    store = _store(state_path)
    company_id, _ = _company_with_issue(state_path)
    store.save_workspace_profile(
        WorkspaceProfile(name="ws", workspace_id="ws_sr2", company_profile_id=company_id)
    )
    agent = store.save_agent_profile(
        AgentProfile(name="Eng", role="dev", company_profile_id=company_id, workspace_id="ws_sr2")
    )
    issue = store.save_issue(
        Issue(title="work", company_profile_id=company_id, workspace_id="ws_sr2")
    )
    team_kernel.assign_issue(store, issue.issue_id, agent.profile_id)
    team_kernel.checkout_issue(store, issue.issue_id, run_id="run_live")

    bad = _invoke(
        [
            "company",
            "submit-review",
            "--issue-id",
            issue.issue_id,
            "--expected-checkout-run-id",
            "run_stale",
            "--company-id",
            company_id,
        ]
    )
    assert bad.exit_code != 0
    # The issue stays in_progress (the stale submit was refused).
    assert _store(state_path).get_issue(issue.issue_id).status == "in_progress"


# --- archive (HIGH → pending approval) -------------------------------------


def test_company_archive_opens_pending_approval(state_path):
    create = _invoke(["company", "create", "--name", "ArchiveCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]

    result = _invoke(
        ["company", "archive", "--company-id", company_id, "--reason", "done"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["outcome"] == "pending_approval"
    approval_id = payload["approval_id"]
    assert approval_id
    assert "approve grant" in payload["hint"]

    store = _store(state_path)
    # The approval exists and is pending.
    approval = store.get_approval(approval_id)
    assert approval.status == "pending"
    # Two-phase archive froze the company (phase 1) rather than dissolving it.
    company = store.get_company_profile(company_id)
    assert company.status != "active"


def test_company_archive_then_grant_dissolves(state_path):
    create = _invoke(["company", "create", "--name", "GrantCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]
    archive = _invoke(["company", "archive", "--company-id", company_id])
    approval_id = json.loads(archive.output)["approval_id"]

    # Confirm via the SAME existing approval gate the hint points to.
    grant = _invoke(["approve", "grant", approval_id])
    assert grant.exit_code == 0, grant.output
    company = _store(state_path).get_company_profile(company_id)
    assert company.status == "dissolved"


# --- error handling --------------------------------------------------------


def test_company_create_missing_name_fails(state_path):
    result = _invoke(["company", "create"])
    assert result.exit_code != 0
    # Typer reports the missing required option.
    combined = result.output + str(result.exception or "")
    assert "name" in combined.lower()


def test_company_update_unknown_id_friendly_error(state_path):
    result = _invoke(["company", "update", "--company-id", "company_nope", "--name", "X"])
    assert result.exit_code != 0
    assert "unknown id" in result.output.lower() or "unknown" in result.output.lower()


def test_company_update_empty_patch_fails(state_path):
    create = _invoke(["company", "create", "--name", "PatchCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]
    result = _invoke(["company", "update", "--company-id", company_id])
    assert result.exit_code != 0
    assert "empty patch" in result.output.lower()


def _hire_for_set(state_path, company_name):
    create = _invoke(["company", "create", "--name", company_name])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]
    hire = _invoke(
        ["company", "hire", "--name", "A", "--role", "engineer", "--company-id", company_id]
    )
    profile_id = json.loads(hire.output)["detail"]["profile_id"]
    return company_id, profile_id


def _update_agent(company_id, profile_id, *set_tokens):
    args = ["company", "update-agent", "--profile-id", profile_id, "--company-id", company_id]
    for token in set_tokens:
        args += ["--set", token]
    return _invoke(args)


def test_company_update_agent_bad_set_fails(state_path):
    company_id, profile_id = _hire_for_set(state_path, "SetCo")
    result = _update_agent(company_id, profile_id, "no_equals_sign")
    assert result.exit_code != 0
    assert "key=value" in result.output


def test_company_update_agent_field_type_map_covers_editable_fields():
    """Every kernel-editable field has an explicit --set coercion type (no gaps)."""
    from superclaw.cli import _AGENT_SET_FIELD_TYPES
    from superclaw.team_kernel import EDITABLE_PROFILE_FIELDS

    assert set(_AGENT_SET_FIELD_TYPES) == set(EDITABLE_PROFILE_FIELDS)


def test_company_update_agent_int_coercion(state_path):
    company_id, profile_id = _hire_for_set(state_path, "IntCo")
    result = _update_agent(company_id, profile_id, "budget_seconds=120")
    assert result.exit_code == 0, result.output
    profile = _store(state_path).get_agent_profile(profile_id)
    # Stored as a real int, not the string "120".
    assert profile.budget_seconds == 120
    assert isinstance(profile.budget_seconds, int)


def test_company_update_agent_list_coercion(state_path):
    company_id, profile_id = _hire_for_set(state_path, "ListCo")
    result = _update_agent(company_id, profile_id, "plugin_allowlist=a,b")
    assert result.exit_code == 0, result.output
    profile = _store(state_path).get_agent_profile(profile_id)
    assert profile.plugin_allowlist == ["a", "b"]


def test_company_update_agent_json_dict_coercion(state_path):
    company_id, profile_id = _hire_for_set(state_path, "JsonCo")
    result = _update_agent(company_id, profile_id, 'permission_policy={"mode":"plan"}')
    assert result.exit_code == 0, result.output
    profile = _store(state_path).get_agent_profile(profile_id)
    assert profile.permission_policy == {"mode": "plan"}


def test_company_update_agent_int_bad_value_fails(state_path):
    company_id, profile_id = _hire_for_set(state_path, "BadIntCo")
    result = _update_agent(company_id, profile_id, "budget_seconds=abc")
    assert result.exit_code != 0
    assert "expects an integer" in result.output


def test_company_update_agent_json_non_object_fails(state_path):
    company_id, profile_id = _hire_for_set(state_path, "BadJsonCo")
    result = _update_agent(company_id, profile_id, "runtime_config=[1,2]")
    assert result.exit_code != 0
    assert "expects a JSON object" in result.output


def test_company_update_agent_unknown_field_fails(state_path):
    company_id, profile_id = _hire_for_set(state_path, "BogusCo")
    result = _update_agent(company_id, profile_id, "bogus=1")
    assert result.exit_code != 0
    assert "not an editable agent field" in result.output


# --- scope: the CLI injects an admin operator scope ------------------------


def test_company_update_agent_applies_via_operator_scope(state_path):
    """The CLI's injected is_admin operator scope lets it patch an agent."""
    create = _invoke(["company", "create", "--name", "ScopeCo"])
    company_id = json.loads(create.output)["detail"]["company_profile_id"]
    hire = _invoke(
        ["company", "hire", "--name", "Worker", "--role", "engineer", "--company-id", company_id]
    )
    profile_id = json.loads(hire.output)["detail"]["profile_id"]

    result = _invoke(
        [
            "company",
            "update-agent",
            "--profile-id",
            profile_id,
            "--company-id",
            company_id,
            "--set",
            "title=Senior Engineer",
        ]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["outcome"] == "executed"
    assert _store(state_path).get_agent_profile(profile_id).title == "Senior Engineer"


# --- message center: company messages / mark-read --------------------------


def test_company_messages_renders_rollup_and_json(state_path):
    from superclaw import team_kernel
    from superclaw.models import CompanyProfile, Issue, IssueStatus

    store = _store(state_path)
    store.save_company_profile(CompanyProfile(company_profile_id="co_a", name="Alpha"))
    issue = store.save_issue(
        Issue(title="work", company_profile_id="co_a", status=IssueStatus.TODO.value)
    )
    team_kernel.block_issue(store, issue.issue_id, reason="waiting")

    # Human-readable roll-up.
    result = _invoke(["company", "messages"])
    assert result.exit_code == 0, result.output
    assert "unread:" in result.output
    assert "Alpha" in result.output

    # JSON payload carries the contract shape + server snapshot.
    result_json = _invoke(["company", "messages", "--json"])
    assert result_json.exit_code == 0, result_json.output
    payload = json.loads(result_json.output)
    assert payload["total_unread"] == 1
    assert "snapshot_as_of" in payload
    assert any(c["company_profile_id"] == "co_a" for c in payload["companies"])


def test_company_mark_read_by_item_key(state_path):
    from superclaw import team_kernel
    from superclaw.models import CompanyProfile, Issue, IssueStatus

    store = _store(state_path)
    store.save_company_profile(CompanyProfile(company_profile_id="co_a", name="Alpha"))
    issue = store.save_issue(
        Issue(title="work", company_profile_id="co_a", status=IssueStatus.TODO.value)
    )
    team_kernel.block_issue(store, issue.issue_id, reason="waiting")
    key = f"issue:{issue.issue_id}:blocked"

    # Caller echoes the server snapshot from `messages --json`.
    snap = json.loads(_invoke(["company", "messages", "--json"]).output)["snapshot_as_of"]
    result = _invoke(["company", "mark-read", "--item-key", key, "--seen-as-of", str(snap)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["marked"] == 1

    after = _invoke(["company", "messages", "--json"])
    assert json.loads(after.output)["total_unread"] == 0


def test_company_mark_read_requires_seen_as_of(state_path):
    # Both modes require --seen-as-of (mark-read only acknowledges observed events).
    result = _invoke(["company", "mark-read", "--company", "co_a"])
    assert result.exit_code == 1
    assert "seen-as-of" in result.output
    result2 = _invoke(["company", "mark-read", "--item-key", "k"])
    assert result2.exit_code == 1
    assert "seen-as-of" in result2.output


def test_company_mark_read_rejects_both_modes(state_path):
    result = _invoke(
        ["company", "mark-read", "--item-key", "k", "--company", "co_a", "--seen-as-of", "1.0"]
    )
    assert result.exit_code == 1


def test_company_mark_read_rejects_malformed_seen_as_of(state_path):
    # A non-finite / negative snapshot must fail closed at the CLI (exit 1) BEFORE
    # any state is opened/read/mutated/pruned (fail-before-read). The state DB must
    # not even be created by these rejected calls.
    assert not state_path.exists()
    for bad in ("nan", "inf", "-1"):
        result = _invoke(["company", "mark-read", "--company", "co_a", "--seen-as-of", bad])
        assert result.exit_code == 1, f"{bad!r} -> {result.output}"
    # Validation happened before _team_store(): no state file was created.
    assert not state_path.exists()


def test_company_mark_read_invalid_shape_does_not_open_state(state_path):
    # Mode-shape errors (both modes / missing mode / missing seen_as_of) must also
    # fail before the store is constructed.
    assert not state_path.exists()
    for args in (
        ["company", "mark-read"],  # missing mode
        ["company", "mark-read", "--item-key", "k"],  # missing seen_as_of
        ["company", "mark-read", "--item-key", "k", "--company", "c", "--seen-as-of", "1.0"],  # both
    ):
        result = _invoke(args)
        assert result.exit_code == 1, f"{args} -> {result.output}"
    assert not state_path.exists()


# --- logo (set-logo / clear-logo) ------------------------------------------
#
# The kernel gate is covered in test_company_logo.py; here we verify the CLI
# surface reads the file, routes through the SAME kernel function the API uses,
# persists the reference, and fails closed with a friendly message.

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _seed_company(state_path) -> str:
    from superclaw.models import CompanyProfile

    company = _store(state_path).save_company_profile(CompanyProfile(name="Acme"))
    return company.company_profile_id


def test_company_set_and_clear_logo(state_path, tmp_path):
    company_id = _seed_company(state_path)
    img = tmp_path / "logo.png"
    img.write_bytes(_PNG)

    result = _invoke(["company", "set-logo", company_id, "--file", str(img)])
    assert result.exit_code == 0, result.output
    logo_ref = json.loads(result.output)["logo"]
    assert logo_ref.startswith(f"{company_id}/") and logo_ref.endswith(".png")
    assert _store(state_path).get_company_profile(company_id).logo == logo_ref

    cleared = _invoke(["company", "clear-logo", company_id])
    assert cleared.exit_code == 0, cleared.output
    assert json.loads(cleared.output)["logo"] == ""
    assert _store(state_path).get_company_profile(company_id).logo == ""


def test_company_set_logo_rejects_bad_image(state_path, tmp_path):
    company_id = _seed_company(state_path)
    bad = tmp_path / "fake.png"
    bad.write_bytes(b"not really an image")

    result = _invoke(["company", "set-logo", company_id, "--file", str(bad)])
    assert result.exit_code != 0
    assert "unsupported" in result.output.lower()


def test_company_set_logo_unknown_company(state_path, tmp_path):
    img = tmp_path / "logo.png"
    img.write_bytes(_PNG)
    result = _invoke(["company", "set-logo", "company_missing", "--file", str(img)])
    assert result.exit_code != 0
    assert "unknown company" in result.output.lower()
