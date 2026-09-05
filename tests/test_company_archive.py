"""Tests for the two-phase company archive (contract E).

Covers the kernel ``archive_company`` cascade circuit-breaker directly, the
two-phase lifecycle (freeze on request -> dissolve on grant / restore on reject),
and the end-to-end flow through the company-command handler + ``decide_approval``.

Uses a real :class:`StateStore` on ``tmp_path`` so the lifecycle transitions and
the cascade are checked against persisted state.
"""

from __future__ import annotations

import pytest

from superclaw import team_kernel
from superclaw.company_commands import CompanyArchiveCommand, CreateIssueCommand
from superclaw.company_handler import execute_company_command
from superclaw.company_lifecycle import (
    CompanyFrozenError,
    assert_company_archivable,
    freeze_company_for_archive,
    restore_company_from_freeze,
)
from superclaw.company_scope import CompanyScope
from superclaw.models import (
    ApprovalStatus,
    CompanyProfile,
    CompanyStatus,
    Issue,
    IssueStatus,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store: StateStore, *, name="Acme", status=CompanyStatus.ACTIVE.value):
    company = CompanyProfile(name=name, status=status)
    store.save_company_profile(company)
    return company


def _scope(company_id: str, *, principal_id="op_1") -> CompanyScope:
    # Archive flows are operator-driven (admin scope): archive is HIGH/operator-only
    # and the post-restore CreateIssueCommand here models the operator creating a
    # root issue (a confined agent is gated separately — see test_company_autonomy.py).
    return CompanyScope(principal_id=principal_id, actor_company_id=company_id, is_admin=True)


# --- phase 1: freeze for archive -------------------------------------------


def test_freeze_moves_active_to_frozen_bumps_epoch(store):
    company = _company(store)
    out = freeze_company_for_archive(store, company.company_profile_id)
    assert out.status == CompanyStatus.FROZEN.value
    assert out.epoch == company.epoch + 1
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.FROZEN.value
    )


def test_freeze_is_idempotent_on_already_frozen(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    before_epoch = store.get_company_profile(company.company_profile_id).epoch
    out = freeze_company_for_archive(store, company.company_profile_id)
    assert out.status == CompanyStatus.FROZEN.value
    # No double-bump on a re-freeze.
    assert out.epoch == before_epoch


def test_freeze_rejects_dissolved(store):
    company = _company(store, status=CompanyStatus.DISSOLVED.value)
    with pytest.raises(CompanyFrozenError):
        freeze_company_for_archive(store, company.company_profile_id)


def test_freeze_unknown_company_raises_keyerror(store):
    with pytest.raises(KeyError):
        freeze_company_for_archive(store, "company_does_not_exist")


# --- phase 2b: restore on reject -------------------------------------------


def test_restore_moves_frozen_to_active_bumps_epoch(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    before = store.get_company_profile(company.company_profile_id)
    out = restore_company_from_freeze(store, company.company_profile_id)
    assert out.status == CompanyStatus.ACTIVE.value
    assert out.epoch == before.epoch + 1


def test_restore_idempotent_on_active(store):
    company = _company(store)
    before_epoch = store.get_company_profile(company.company_profile_id).epoch
    out = restore_company_from_freeze(store, company.company_profile_id)
    assert out.status == CompanyStatus.ACTIVE.value
    assert out.epoch == before_epoch


def test_restore_rejects_dissolved(store):
    company = _company(store, status=CompanyStatus.DISSOLVED.value)
    with pytest.raises(CompanyFrozenError):
        restore_company_from_freeze(store, company.company_profile_id)


def test_assert_archivable_allows_frozen_and_dissolved_rejects_active(store):
    frozen = CompanyProfile(name="f", status=CompanyStatus.FROZEN.value)
    dissolved = CompanyProfile(name="d", status=CompanyStatus.DISSOLVED.value)
    active = CompanyProfile(name="a", status=CompanyStatus.ACTIVE.value)
    assert_company_archivable(frozen)  # no raise
    assert_company_archivable(dissolved)  # no raise (idempotent at archive level)
    with pytest.raises(CompanyFrozenError):
        assert_company_archivable(active)


# --- archive_company: dissolve + cascade -----------------------------------


def test_archive_dissolves_frozen_company_bumps_epoch(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    before = store.get_company_profile(company.company_profile_id)
    result = team_kernel.archive_company(store, company.company_profile_id)
    assert result["status"] == CompanyStatus.DISSOLVED.value
    assert result["already_dissolved"] is False
    persisted = store.get_company_profile(company.company_profile_id)
    assert persisted.status == CompanyStatus.DISSOLVED.value
    assert persisted.epoch == before.epoch + 1


def test_archive_refuses_still_active_company(store):
    # A still-ACTIVE company at archive time means the request-time freeze was
    # lost (corrupted flow) — refuse rather than dissolve.
    company = _company(store)
    with pytest.raises(CompanyFrozenError):
        team_kernel.archive_company(store, company.company_profile_id)
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.ACTIVE.value
    )


def test_archive_is_idempotent_on_dissolved(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    first = team_kernel.archive_company(store, company.company_profile_id)
    epoch_after_first = store.get_company_profile(company.company_profile_id).epoch
    # A re-applied grant must NOT re-run the cascade or re-bump the epoch.
    second = team_kernel.archive_company(store, company.company_profile_id)
    assert first["already_dissolved"] is False
    assert second["already_dissolved"] is True
    assert store.get_company_profile(company.company_profile_id).epoch == epoch_after_first


def test_archive_supersedes_pending_company_approvals_except_excluded(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    # A sibling pending company approval (another archive request) on the same
    # company — should be superseded by the dissolve.
    sibling = execute_company_command(
        CompanyArchiveCommand(company_profile_id=company.company_profile_id),
        scope=scope,
        store=store,
        requested_by="op_1",
    )
    sibling_id = sibling.detail["approval_id"]
    # The company is now FROZEN (sibling froze it). Archive it, excluding a
    # hypothetical "driving" approval id (none here) -> sibling is superseded.
    result = team_kernel.archive_company(
        store, company.company_profile_id, excluded_approval_ids=frozenset()
    )
    assert sibling_id in result["superseded_approvals"]
    assert store.get_approval(sibling_id).status == ApprovalStatus.CANCELLED.value


def test_archive_excludes_the_driving_approval(store):
    # The approval whose grant drives the archive must NOT be cancelled by the
    # cascade (that would deadlock the grant).
    company = _company(store)
    scope = _scope(company.company_profile_id)
    req = execute_company_command(
        CompanyArchiveCommand(company_profile_id=company.company_profile_id),
        scope=scope,
        store=store,
        requested_by="op_1",
    )
    driving_id = req.detail["approval_id"]
    result = team_kernel.archive_company(
        store,
        company.company_profile_id,
        excluded_approval_ids=frozenset({driving_id}),
    )
    assert driving_id not in result["superseded_approvals"]
    # Still PENDING — decide_approval is what flips it to approved.
    assert store.get_approval(driving_id).status == ApprovalStatus.PENDING.value


def test_archive_cancels_live_issues_with_no_active_run(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    # An in-progress issue with no active run: the tree breaker can terminate it.
    issue = store.save_issue(
        Issue(
            title="live work",
            company_profile_id=company.company_profile_id,
            status=IssueStatus.IN_PROGRESS.value,
        )
    )
    result = team_kernel.archive_company(store, company.company_profile_id)
    assert issue.issue_id in result["cancelled_issues"]
    assert store.get_issue(issue.issue_id).status == IssueStatus.CANCELLED.value


def test_archive_retains_records_read_only(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    issue = store.save_issue(
        Issue(
            title="keep me",
            company_profile_id=company.company_profile_id,
            status=IssueStatus.DONE.value,
        )
    )
    team_kernel.archive_company(store, company.company_profile_id)
    # Soft archive: the dissolved company and its records remain queryable.
    assert store.get_company_profile(company.company_profile_id) is not None
    assert store.get_issue(issue.issue_id).title == "keep me"


def test_archive_reports_deferred_cascade_items(store):
    company = _company(store, status=CompanyStatus.FROZEN.value)
    result = team_kernel.archive_company(store, company.company_profile_id)
    # Honest deferral: cascade items with no kernel primitive are surfaced, not
    # silently pretended-done.
    assert "agent_runtime_token_revocation" in result["deferred"]
    assert "agent_tombstone" in result["deferred"]


# --- end-to-end: handler + decide_approval ---------------------------------


def test_e2e_archive_grant_dissolves_and_no_deadlock(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    # Phase 1: request -> FROZEN + pending approval.
    req = execute_company_command(
        CompanyArchiveCommand(company_profile_id=company.company_profile_id),
        scope=scope,
        store=store,
        requested_by="op_1",
    )
    approval_id = req.detail["approval_id"]
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.FROZEN.value
    )
    # Phase 2a: grant -> the archive approval itself is approved (NOT superseded:
    # excluded from its own cascade), and the company is dissolved.
    approval, _ = team_kernel.decide_approval(store, approval_id, approved=True)
    assert approval.status == ApprovalStatus.APPROVED.value
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.DISSOLVED.value
    )


def test_e2e_archive_reject_restores_company(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    req = execute_company_command(
        CompanyArchiveCommand(company_profile_id=company.company_profile_id),
        scope=scope,
        store=store,
        requested_by="op_1",
    )
    approval_id = req.detail["approval_id"]
    assert store.get_company_profile(company.company_profile_id).status == (
        CompanyStatus.FROZEN.value
    )
    # Reject -> company restored to ACTIVE, resumes normal work.
    approval, _ = team_kernel.decide_approval(store, approval_id, approved=False)
    assert approval.status == ApprovalStatus.REJECTED.value
    restored = store.get_company_profile(company.company_profile_id)
    assert restored.status == CompanyStatus.ACTIVE.value
    # After restore, the company can host new work again (lifecycle gate passes).
    result = execute_company_command(
        CreateIssueCommand(title="post-restore work"),
        scope=_scope(company.company_profile_id),
        store=store,
        requested_by="op_1",
    )
    assert result.outcome == "executed"


def test_frozen_company_blocks_new_work_during_review(store):
    company = _company(store)
    scope = _scope(company.company_profile_id)
    execute_company_command(
        CompanyArchiveCommand(company_profile_id=company.company_profile_id),
        scope=scope,
        store=store,
        requested_by="op_1",
    )
    # The company is FROZEN during the confirmation window -> new work is refused.
    with pytest.raises(CompanyFrozenError):
        execute_company_command(
            CreateIssueCommand(title="should be blocked"),
            scope=_scope(company.company_profile_id),
            store=store,
            requested_by="op_1",
        )
