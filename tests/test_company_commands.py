"""Tests for the single-source company-management command models + registry.

Covers contracts B6/B7 of docs/company-chat-management-design.md:
  * per-model ``validate()`` accept/reject (missing/blank required fields,
    unknown enum values fail-closed, unknown hire-spec fields rejected,
    permission-mode + allowlist list-of-str checks single-sourced from kernel),
  * ``to_dict`` / ``from_dict`` round-trip and FAIL-CLOSED unknown-field
    rejection (the command layer rejects, it does not silently filter),
  * ``COMMAND_REGISTRY`` completeness + ``get_command_model`` fail-closed.

There is intentionally no canonical_payload / action-digest in this layer (see
company_commands module docstring): canonicalisation is schema-aware and belongs
with its consumer (PR-C signing increment), not in this vocabulary layer.
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import (
    COMMAND_REGISTRY,
    AssignBoardInboxCommand,
    AssignIssueCommand,
    AttachWorkProductCommand,
    AuthorRoutineCommand,
    BlockIssueCommand,
    CancelIssueTreeCommand,
    CompanyArchiveCommand,
    CompanyCreateCommand,
    CompanyUpdateCommand,
    CreateIssueCommand,
    DelegateIssueCommand,
    HireAgentCommand,
    HoldIssueCommand,
    PauseIssueTreeCommand,
    PostIssueCommentCommand,
    RequeueIssueCommand,
    ResolveBoardInboxCommand,
    ResumeIssueTreeCommand,
    SubmitReviewCommand,
    UnblockIssueCommand,
    UnholdIssueCommand,
    UpdateAgentCharterCommand,
    UpdateAgentCommand,
    UpdateWorkProductCommand,
    get_command_model,
)
from superclaw.models import ISSUE_KINDS, REVIEW_POLICIES
from superclaw.team_kernel import _HIRE_SPEC_FIELDS


# --------------------------------------------------------------------------- #
# validate(): accept paths                                                     #
# --------------------------------------------------------------------------- #


def test_company_create_validate_ok():
    CompanyCreateCommand(name="Acme", allowed_plugins=["a", "b"]).validate()


def test_company_update_validate_ok():
    CompanyUpdateCommand(company_profile_id="company_x", goal="ship").validate()


def test_hire_validate_ok():
    HireAgentCommand(spec={"name": "Dev", "role": "engineer"}).validate()


def test_hire_validate_ok_with_policy_and_allowlists():
    HireAgentCommand(
        spec={
            "name": "Dev",
            "role": "engineer",
            "permission_policy": {"mode": "acceptEdits"},
            "plugin_allowlist": ["p1", "p2"],
            "skill_allowlist": ["s1"],
        }
    ).validate()


def test_update_agent_validate_ok():
    UpdateAgentCommand(profile_id="agent_x", patch={"title": "Lead"}).validate()


def test_create_issue_validate_ok_minimal():
    CreateIssueCommand(title="Fix bug").validate()


def test_create_issue_validate_ok_with_enums():
    CreateIssueCommand(
        title="Ship feature",
        kind="delivery",
        review_policy="human_final",
    ).validate()


def test_assign_issue_validate_ok():
    AssignIssueCommand(issue_id="issue_x", profile_id="agent_x").validate()


def test_delegate_issue_validate_ok():
    DelegateIssueCommand(
        parent_id="issue_p",
        assignee_agent_profile_id="agent_c",
        title="Sub task",
    ).validate()


def test_company_archive_validate_ok():
    CompanyArchiveCommand(company_profile_id="company_x", reason="done").validate()


# --------------------------------------------------------------------------- #
# validate(): reject paths (fail-closed)                                       #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("bad", ["", "   ", None])
def test_company_create_rejects_blank_name(bad):
    with pytest.raises(ValueError):
        CompanyCreateCommand(name=bad).validate()


def test_company_create_rejects_non_str_allowlist():
    with pytest.raises(ValueError):
        CompanyCreateCommand(name="Acme", allowed_plugins=[1]).validate()  # type: ignore[list-item]


def test_company_update_rejects_missing_id():
    with pytest.raises(ValueError):
        CompanyUpdateCommand(company_profile_id="", name="x").validate()


def test_company_update_rejects_empty_patch():
    with pytest.raises(ValueError):
        CompanyUpdateCommand(company_profile_id="company_x").validate()


def test_company_update_rejects_blank_name_patch():
    with pytest.raises(ValueError):
        CompanyUpdateCommand(company_profile_id="company_x", name="  ").validate()


def test_company_update_rejects_non_str_allowlist():
    with pytest.raises(ValueError):
        CompanyUpdateCommand(
            company_profile_id="company_x", allowed_plugins=["ok", 2]  # type: ignore[list-item]
        ).validate()


def test_hire_rejects_missing_name():
    with pytest.raises(ValueError):
        HireAgentCommand(spec={"role": "engineer"}).validate()


def test_hire_rejects_missing_role():
    with pytest.raises(ValueError):
        HireAgentCommand(spec={"name": "Dev"}).validate()


def test_hire_rejects_unknown_spec_field():
    with pytest.raises(ValueError) as exc:
        HireAgentCommand(
            spec={"name": "Dev", "role": "engineer", "bogus": 1}
        ).validate()
    assert "bogus" in str(exc.value)


def test_hire_rejects_non_mapping_spec():
    with pytest.raises(ValueError):
        HireAgentCommand(spec=["name", "role"]).validate()  # type: ignore[arg-type]


def test_hire_rejects_invalid_permission_policy():
    with pytest.raises(ValueError):
        HireAgentCommand(
            spec={
                "name": "Dev",
                "role": "engineer",
                "permission_policy": {"mode": "bogus"},
            }
        ).validate()


def test_hire_rejects_non_str_plugin_allowlist():
    with pytest.raises(ValueError):
        HireAgentCommand(
            spec={"name": "Dev", "role": "engineer", "plugin_allowlist": [1]}
        ).validate()


def test_hire_rejects_non_str_skill_allowlist():
    with pytest.raises(ValueError):
        HireAgentCommand(
            spec={"name": "Dev", "role": "engineer", "skill_allowlist": [object()]}
        ).validate()


def test_update_agent_rejects_missing_id():
    with pytest.raises(ValueError):
        UpdateAgentCommand(profile_id="", patch={"title": "x"}).validate()


def test_update_agent_rejects_empty_patch():
    with pytest.raises(ValueError):
        UpdateAgentCommand(profile_id="agent_x", patch={}).validate()


def test_update_agent_rejects_non_editable_field():
    with pytest.raises(ValueError) as exc:
        UpdateAgentCommand(profile_id="agent_x", patch={"bogus": 1}).validate()
    assert "bogus" in str(exc.value)


def test_update_agent_rejects_charter_field_not_editable():
    # charter is NOT in EDITABLE_PROFILE_FIELDS (changed via a separate path).
    with pytest.raises(ValueError):
        UpdateAgentCommand(
            profile_id="agent_x", patch={"charter": "new"}
        ).validate()


def test_update_agent_rejects_invalid_permission_policy():
    with pytest.raises(ValueError):
        UpdateAgentCommand(
            profile_id="agent_x", patch={"permission_policy": {"mode": "bogus"}}
        ).validate()


def test_update_agent_rejects_non_str_allowlist():
    with pytest.raises(ValueError):
        UpdateAgentCommand(
            profile_id="agent_x", patch={"plugin_allowlist": [1]}
        ).validate()


def test_update_agent_accepts_valid_patch():
    UpdateAgentCommand(profile_id="agent_x", patch={"title": "X"}).validate()


def test_create_issue_rejects_blank_title():
    with pytest.raises(ValueError):
        CreateIssueCommand(title="").validate()


def test_create_issue_rejects_unknown_kind():
    with pytest.raises(ValueError):
        CreateIssueCommand(title="t", kind="not_a_kind").validate()


def test_create_issue_rejects_unknown_review_policy():
    with pytest.raises(ValueError):
        CreateIssueCommand(title="t", review_policy="auto_yes").validate()


def test_assign_issue_rejects_missing_fields():
    with pytest.raises(ValueError):
        AssignIssueCommand(issue_id="issue_x", profile_id="").validate()
    with pytest.raises(ValueError):
        AssignIssueCommand(issue_id="", profile_id="agent_x").validate()


def test_delegate_issue_rejects_missing_fields():
    with pytest.raises(ValueError):
        DelegateIssueCommand(
            parent_id="", assignee_agent_profile_id="a", title="t"
        ).validate()
    with pytest.raises(ValueError):
        DelegateIssueCommand(
            parent_id="p", assignee_agent_profile_id="", title="t"
        ).validate()
    with pytest.raises(ValueError):
        DelegateIssueCommand(
            parent_id="p", assignee_agent_profile_id="a", title=""
        ).validate()


def test_company_archive_rejects_missing_id():
    with pytest.raises(ValueError):
        CompanyArchiveCommand(company_profile_id="").validate()


def test_every_known_issue_kind_and_policy_accepted():
    # Fail-closed must reject *unknown* values but accept every real enum value.
    for kind in ISSUE_KINDS:
        CreateIssueCommand(title="t", kind=kind).validate()
    for policy in REVIEW_POLICIES:
        CreateIssueCommand(title="t", review_policy=policy).validate()


# --------------------------------------------------------------------------- #
# to_dict / from_dict round-trip + fail-closed unknown-field rejection        #
# --------------------------------------------------------------------------- #


_ROUNDTRIP_SAMPLES = [
    CompanyCreateCommand(name="Acme", goal="g", allowed_plugins=["a", "b"]),
    CompanyUpdateCommand(company_profile_id="c1", name="New", default_token_budget=10),
    HireAgentCommand(spec={"name": "Dev", "role": "engineer", "model": "x"}),
    UpdateAgentCommand(profile_id="a1", patch={"title": "Lead"}),
    CreateIssueCommand(title="t", kind="bug", review_policy="human_final"),
    AssignIssueCommand(issue_id="i1", profile_id="a1"),
    DelegateIssueCommand(parent_id="p", assignee_agent_profile_id="a", title="t"),
    PostIssueCommentCommand(issue_id="i1", body="hello"),
    AttachWorkProductCommand(issue_id="i1", type="pull_request", title="PR #1", is_primary=True),
    SubmitReviewCommand(issue_id="i1", expected_checkout_run_id="run_1", summary="done"),
    CompanyArchiveCommand(company_profile_id="c1", reason="done"),
]


@pytest.mark.parametrize("cmd", _ROUNDTRIP_SAMPLES, ids=lambda c: type(c).__name__)
def test_to_dict_from_dict_roundtrip(cmd):
    restored = type(cmd).from_dict(cmd.to_dict())
    assert restored == cmd


@pytest.mark.parametrize("cmd", _ROUNDTRIP_SAMPLES, ids=lambda c: type(c).__name__)
def test_from_dict_rejects_unknown_field_fail_closed(cmd):
    # The command layer is a security-sensitive mutation contract: an unknown
    # key is an error, NOT silently filtered (deliberate deviation from models).
    data = dict(cmd.to_dict())
    data["totally_unknown"] = 1
    with pytest.raises(ValueError) as exc:
        type(cmd).from_dict(data)
    assert "totally_unknown" in str(exc.value)


def test_to_dict_excludes_class_var_command_type():
    # command_type is a ClassVar, not an instance field -> must not be in to_dict.
    assert "command_type" not in CompanyCreateCommand(name="Acme").to_dict()


# --------------------------------------------------------------------------- #
# COMMAND_REGISTRY + get_command_model                                         #
# --------------------------------------------------------------------------- #


_ALL_MODELS = [
    CompanyCreateCommand,
    CompanyUpdateCommand,
    HireAgentCommand,
    UpdateAgentCommand,
    UpdateAgentCharterCommand,
    CreateIssueCommand,
    AssignIssueCommand,
    DelegateIssueCommand,
    PostIssueCommentCommand,
    AttachWorkProductCommand,
    SubmitReviewCommand,
    CompanyArchiveCommand,
    BlockIssueCommand,
    UnblockIssueCommand,
    HoldIssueCommand,
    UnholdIssueCommand,
    RequeueIssueCommand,
    UpdateWorkProductCommand,
    PauseIssueTreeCommand,
    ResumeIssueTreeCommand,
    CancelIssueTreeCommand,
    AuthorRoutineCommand,
    ResolveBoardInboxCommand,
    AssignBoardInboxCommand,
]


def test_registry_covers_every_model():
    assert set(COMMAND_REGISTRY.values()) == set(_ALL_MODELS)


def test_registry_keys_match_class_command_type():
    for ctype, cls in COMMAND_REGISTRY.items():
        assert cls.command_type == ctype


def test_registry_command_types_are_unique():
    types = [cls.command_type for cls in _ALL_MODELS]
    assert len(types) == len(set(types))


@pytest.mark.parametrize("cls", _ALL_MODELS, ids=lambda c: c.__name__)
def test_get_command_model_resolves(cls):
    assert get_command_model(cls.command_type) is cls


def test_get_command_model_unknown_fail_closed():
    with pytest.raises(KeyError):
        get_command_model("company.nuke")


# --------------------------------------------------------------------------- #
# single-source guard: hire fields stay pinned to the kernel whitelist        #
# --------------------------------------------------------------------------- #


def test_hire_every_kernel_field_accepted():
    # Every kernel-accepted hire field must pass the command's validate(); list
    # fields get a valid list-of-str so the allowlist check is exercised too.
    spec: dict = {"name": "Dev", "role": "engineer"}
    for f in _HIRE_SPEC_FIELDS:
        if f in spec:
            continue
        if f in ("plugin_allowlist", "skill_allowlist"):
            spec[f] = ["x"]
        elif f == "permission_policy":
            spec[f] = {}
        elif f == "runtime_config":
            spec[f] = {}
        else:
            spec[f] = ""
    HireAgentCommand(spec=spec).validate()


# --------------------------------------------------------------------------- #
# fail-closed type guards: required strings + falsy-but-wrong allowlists       #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("bad_name", [123, [], {}, 0, False])
def test_required_string_field_rejects_non_string(bad_name):
    # A non-None, non-str required field must be rejected, not slip through the
    # old `value is None or (isinstance str and blank)` fail-open hole.
    with pytest.raises(ValueError):
        CompanyCreateCommand(name=bad_name).validate()


@pytest.mark.parametrize("bad_plugins", ["", 0, False, "abc", 5])
def test_company_create_allowlist_rejects_falsy_or_wrong_type(bad_plugins):
    # A falsy-but-wrong allowed_plugins (""/0/False) must not bypass the
    # list-of-str check via a truthiness guard, nor must a wrong type.
    with pytest.raises(ValueError):
        CompanyCreateCommand(name="Acme", allowed_plugins=bad_plugins).validate()


def test_company_create_empty_allowlist_is_valid():
    # The legitimate default (empty list) still passes.
    CompanyCreateCommand(name="Acme", allowed_plugins=[]).validate()
