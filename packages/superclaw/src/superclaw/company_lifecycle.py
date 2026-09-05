"""Company lifecycle guards (contract B5: epoch fencing / archive defence).

This is the single definition point for "may this company host work right now?".

NOT YET ENFORCED ANYWHERE. This module defines an inert primitive only: the
guard has no callers in this increment. Later increments (contract B4's unified
write guard, contract E's archive flow) MUST call :func:`assert_company_active`
at the mutation / run-resume / tool-execution choke points so a frozen or
dissolved company cannot host new work from any surface (CLI / API / TUI /
daemon / direct kernel call). Until that wiring lands there is no behavioural
protection — do not treat the mere existence of this guard as enforcement.

Kept dependency-light (imports only :mod:`superclaw.models`) so the state,
kernel, and backend layers can all import it without a cycle. The full
artifact-epoch binding (each recoverable object carrying the epoch it was
issued under) also lands in later contract-B5 increments; this module owns the
status primitive those increments build on.

See docs/company-chat-management-design.md (contract B5).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from superclaw.models import CompanyProfile, CompanyStatus


class CompanyFrozenError(ValueError):
    """Raised when an operation targets a company that is not ACTIVE.

    Subclasses ``ValueError`` to match the kernel's governance-error
    convention (ReassignedError / ClaimChangedError / IssueHeldError), so
    existing callers that map ValueError to a 4xx keep working.
    """

    def __init__(self, company_profile_id: str, status: str) -> None:
        self.company_profile_id = company_profile_id
        self.status = status
        super().__init__(
            f"company {company_profile_id} is {status}, not active; "
            "frozen/dissolved companies cannot host new work (contract B5)"
        )


def assert_company_active(company: CompanyProfile) -> None:
    """Fail-closed guard: raise unless ``company`` is ACTIVE.

    The check is on the canonical status value, not a truthiness shortcut, so
    an unknown/garbled status is treated as non-active (fail-closed) rather
    than silently allowed.
    """

    if company.status != CompanyStatus.ACTIVE.value:
        raise CompanyFrozenError(company.company_profile_id, company.status)


# --- contract E: two-phase archive (freeze -> human approval -> dissolve) ----
#
# The archive command is the ONE HIGH-risk (irreversible) company operation. It
# runs in two phases so an in-flight "are you sure?" window cannot host new work:
#
#   1. ``freeze_company_for_archive`` — at REQUEST time (when the handler records
#      the PENDING approval) the company moves ACTIVE -> FROZEN (epoch++). From
#      that instant ``assert_company_active`` rejects every new mutation/run/tool
#      against the company (the gate already wired across the handler), so the
#      confirmation window is read-only.
#   2a. human GRANTS -> ``archive_company`` flips FROZEN -> DISSOLVED (epoch++) and
#       runs the cascade circuit-breaker (below).
#   2b. human REJECTS -> ``restore_company_from_freeze`` flips FROZEN -> ACTIVE
#       (epoch++): the company resumes normal work, no harm done.
#
# ``epoch`` is bumped on every transition so a later contract-B5 increment that
# binds recoverable artifacts (runs/tokens) to their issuing epoch can fence a
# stale continuation that straddles a freeze/restore. Today epoch is a monotonic
# version marker (no artifact carries an issued-epoch yet — see DEFERRED below).


def freeze_company_for_archive(
    store: "StateStore", company_profile_id: str
) -> CompanyProfile:
    """Phase 1: move an ACTIVE company to FROZEN (epoch++) for archive review.

    Called by the handler when it records the PENDING archive approval, so the
    company stops hosting new work for the duration of the human "are you sure?"
    window (``assert_company_active`` rejects FROZEN everywhere it is wired).

    Fail-closed and idempotent-safe:
      * unknown company -> ``KeyError`` (propagated).
      * already FROZEN -> no-op (returns it unchanged) so a duplicate request /
        retry does not double-bump the epoch or churn the row.
      * DISSOLVED -> ``CompanyFrozenError``: a terminal company can never re-enter
        the archive flow (the dissolve already happened).
    """
    company = store.get_company_profile(company_profile_id)  # KeyError -> unknown
    if company.status == CompanyStatus.FROZEN.value:
        return company  # already frozen for review — idempotent
    if company.status != CompanyStatus.ACTIVE.value:
        # DISSOLVED (or any non-active, non-frozen) cannot be frozen for archive.
        raise CompanyFrozenError(company.company_profile_id, company.status)
    company.status = CompanyStatus.FROZEN.value
    company.epoch += 1
    return store.save_company_profile(company)


def restore_company_from_freeze(
    store: "StateStore", company_profile_id: str
) -> CompanyProfile:
    """Phase 2b: move a FROZEN company back to ACTIVE (epoch++) on archive reject.

    Called from the approval REJECT path so a declined archive resumes normal
    operation. Fail-closed and idempotent-safe:
      * unknown company -> ``KeyError`` (propagated).
      * already ACTIVE -> no-op (a reject that races a manual restore converges).
      * DISSOLVED -> ``CompanyFrozenError``: a dissolved company is terminal and
        can never be restored by a reject (the grant already dissolved it).
    """
    company = store.get_company_profile(company_profile_id)  # KeyError -> unknown
    if company.status == CompanyStatus.ACTIVE.value:
        return company  # already active — idempotent
    if company.status != CompanyStatus.FROZEN.value:
        raise CompanyFrozenError(company.company_profile_id, company.status)
    company.status = CompanyStatus.ACTIVE.value
    company.epoch += 1
    return store.save_company_profile(company)


def assert_company_archivable(company: CompanyProfile) -> None:
    """Fail-closed guard for the archive GRANT path: company must be FROZEN.

    The two-phase flow guarantees the company is FROZEN by the time the grant
    applies (request froze it). Requiring FROZEN here — rather than ACTIVE —
    is why the generic ``assert_company_active`` lifecycle gate is BYPASSED for
    the archive command's own target at grant time: archiving a frozen company
    is exactly the intended transition, and a still-ACTIVE company at grant time
    means the freeze was lost (a corrupted flow), so we refuse it.

    An already-DISSOLVED company is idempotent at the archive level (handled by
    ``archive_company`` returning early), so this guard only fires for the
    genuinely-wrong ACTIVE / unknown states.
    """
    if company.status not in (
        CompanyStatus.FROZEN.value,
        CompanyStatus.DISSOLVED.value,
    ):
        raise CompanyFrozenError(company.company_profile_id, company.status)


if TYPE_CHECKING:  # pragma: no cover - typing only
    from superclaw.state import StateStore
