"""Durable commit path for agentcompanies/v1 bootstrap proposals.

The template builder remains side-effect free. This module is the narrow bridge
from a validated proposal into the local Team Kernel tables. High-risk proposals
stop at a durable approval; clean proposals apply in one transaction.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from superclaw.models import (
    AgentProfile,
    Approval,
    ApprovalStatus,
    ApprovalType,
    CompanyMembership,
    CompanyProfile,
    Issue,
    IssueStatus,
    WorkspaceProfile,
    assert_valid_issue_typed_fields,
)
from superclaw.state import StateStore
from superclaw.team_kernel import assignment_wakeup_request
from superclaw.team_templates import (
    BootstrapProposal,
    CompanyTrustGateError,
    TeamTemplateError,
    build_bootstrap_proposal,
)


class BootstrapCommitError(ValueError):
    """Raised when a proposal cannot be committed safely."""


# An ASSIGNED seed issue drives an assignment wakeup, so it must start in a state
# the daemon's work picker can claim (mirrors team_templates._ACTIONABLE_SEED_STATUSES;
# duplicated here so the DURABLE write boundary enforces it even for a payload that
# never went through the template builder).
_ACTIONABLE_SEED_STATUSES = frozenset({IssueStatus.BACKLOG.value, IssueStatus.TODO.value})


def commit_bootstrap_proposal(
    store: StateStore,
    proposal: BootstrapProposal | dict[str, Any],
    *,
    requested_by: str = "local_user",
    approved_resume: bool = False,
    company_revocation_file: Path | None = None,
    company_public_key: str | None = None,
    allow_local_opt_in: bool = False,
) -> dict[str, Any]:
    """Commit a bootstrap proposal or create the required human approval.

    ``approved_resume`` is used only by the approval decision path. Normal CLI
    and API commits must not pass it: high-risk proposals then create a pending
    approval and write no live company/agent/issue records.

    For a company-sourced proposal the verify-before-instantiate gate is RE-RUN
    here (before BEGIN IMMEDIATE) against the proposal's captured source+digest:
    if the template was revoked / re-signed / swapped / its trust changed between
    proposal and commit, this raises :class:`BootstrapCommitError` and writes
    nothing (closes the proposal→commit TOCTOU, design §3.7).
    """
    payload = _proposal_payload(proposal)
    _reject_blocked(payload)
    # For a company source this returns the proposal REBUILT from the verified
    # on-disk manifest (the authoritative copy). Everything downstream — the human
    # approval artifact AND the durable write — uses this rebuilt payload, never the
    # caller-supplied one, so a tampered review surface (template / equipment /
    # role_proposals / would_create) can neither be shown to the approver nor
    # written. For a legacy team template it returns the payload unchanged.
    payload = _reverify_company_source(
        payload,
        company_revocation_file=company_revocation_file,
        company_public_key=company_public_key,
        allow_local_opt_in=allow_local_opt_in,
    )
    approvals_required = list(payload.get("approvals_required") or [])
    if approvals_required and not approved_resume:
        approval = _ensure_pending_bootstrap_approval(
            store,
            payload,
            requested_by=requested_by,
            allow_local_opt_in=allow_local_opt_in,
            company_revocation_file=company_revocation_file,
        )
        return {
            "mode": "commit",
            "committed": False,
            "approval_required": True,
            "approval": approval.to_dict(),
            "proposal": payload,
        }
    apply_result = apply_bootstrap_commit_payload(
        store,
        payload,
        company_revocation_file=company_revocation_file,
        company_public_key=company_public_key,
        allow_local_opt_in=allow_local_opt_in,
        _already_reverified=True,
    )
    return {
        "mode": "commit",
        "committed": bool(apply_result["created"]),
        "approval_required": False,
        "approval": None,
        "proposal": payload,
        **apply_result,
    }


# Auto-generated, per-build tracking fields that carry no template-derived content;
# stripped before the commit-time records comparison so two builds of the SAME
# verified manifest compare equal (their identity/charter/policy/budget content is
# what matters, not the random revision ids / wall-clock timestamps).
_VOLATILE_RECORD_KEYS = frozenset({"revision_id", "charter_revision_id", "created_at", "updated_at"})


def _canonical_records(value: Any) -> Any:
    """Recursively drop volatile tracking fields so semantically-identical record
    sets compare equal regardless of per-build revision ids / timestamps."""
    if isinstance(value, dict):
        return {k: _canonical_records(v) for k, v in value.items() if k not in _VOLATILE_RECORD_KEYS}
    if isinstance(value, list):
        return [_canonical_records(item) for item in value]
    return value


def _claims_company_source(payload: dict[str, Any]) -> bool:
    """Whether a proposal claims to be a signed-company instantiation.

    True if the top-level ``source_kind`` is ``company`` OR the company record's
    ``metadata.template_source_kind`` is ``company``. Either claim obliges the
    write boundary to require a matching verification (fail-closed)."""
    if str(payload.get("source_kind") or "") == "company":
        return True
    would_create = payload.get("would_create")
    if isinstance(would_create, dict):
        company = would_create.get("company_profile")
        if isinstance(company, dict):
            metadata = company.get("metadata")
            if isinstance(metadata, dict) and str(metadata.get("template_source_kind") or "") == "company":
                return True
    return False


def _reverify_company_source(
    payload: dict[str, Any],
    *,
    company_revocation_file: Path | None,
    company_public_key: str | None,
    allow_local_opt_in: bool,
) -> dict[str, Any]:
    """Re-run the verify-before-instantiate gate at commit time (TOCTOU close).

    A proposal is a snapshot: between proposal and commit a company template can
    be revoked, re-signed, swapped on disk, or its trust can change. For a
    company-sourced proposal we re-run the same kernel gate against the captured
    source and assert the recomputed digest/trust still pass AND that the payload's
    records match those rebuilt from the verified manifest.

    Returns the AUTHORITATIVE payload: for a company source, the proposal REBUILT
    from the verified on-disk manifest (so the approval artifact and the durable
    write both use verified records, never the caller-supplied copy). For a legacy
    team template the payload is returned unchanged. Any mismatch ⇒ raises, no write.
    """
    captured = payload.get("company_verification")
    if _claims_company_source(payload) and not isinstance(captured, dict):
        # A proposal that claims a signed-company source — via the top-level
        # source_kind marker OR the company record's template_source_kind metadata —
        # MUST carry its verification. A caller that strips company_verification to
        # skip the gate while keeping company-template semantics is refused at the
        # durable write boundary (fail-closed).
        #
        # NOTE on scope: a from-scratch dict that produces a company_profile while
        # claiming NEITHER marker is, by definition, the legacy unsigned team-template
        # instantiation path (pre-existing semantics; the *signed* kind=="company"
        # source is gated at the verify choke point and the API rejects inline company
        # dicts at the edge). This boundary makes the SIGNED-company claim
        # non-repudiable: you cannot present records as a verified company without a
        # verification that re-derives the same digest+trust from the on-disk source.
        raise BootstrapCommitError(
            "company-sourced proposal is missing its verification; refusing to write (fail-closed)"
        )
    if not isinstance(captured, dict):
        return payload  # non-company (legacy team template) — nothing to re-verify.
    source_ref = str(captured.get("source_ref") or "")
    if not source_ref:
        raise BootstrapCommitError("company proposal missing source reference; cannot re-verify before commit")
    # SECURITY: the revocation source and the local-opt-in decision are TRUSTED
    # parameters supplied by the server-side caller — they are NEVER read from the
    # (caller-controllable) payload, otherwise a crafted dict could point revocation
    # at /dev/null or assert allow_local_opt_in=True to bypass the --trust gate.
    # company_revocation_file=None falls back to the authoritative default inside the
    # gate; allow_local_opt_in defaults to False at the resume boundary (fail-closed).
    revocation_file = company_revocation_file
    # The build-shape inputs (available ids / budgets / proposal id) are not a
    # security boundary: budgets only clamp downward and allowlists derive from the
    # verified manifest, so a tampered build input yields a would_create that simply
    # fails the records match below. They are read from the captured proposal only to
    # reproduce the same would_create shape for the comparison.
    available_plugin_ids = captured.get("available_plugin_ids")
    available_skill_ids = captured.get("available_skill_ids")
    try:
        # Deterministically REBUILD the proposal from the (re-verified) on-disk
        # source plus the captured build inputs. build_bootstrap_proposal re-runs
        # the full verify gate (digest / trust / revocation / namespace) AND derives
        # would_create from the verified manifest — so the rebuilt records are the
        # authoritative ones. We then compare to the payload's records and refuse on
        # any divergence. This closes the "valid verification block + tampered
        # would_create" bypass: the durable write never trusts caller-supplied
        # records for a company-sourced proposal; it trusts only what the verified
        # manifest reproduces.
        rebuilt = build_bootstrap_proposal(
            source_ref,
            available_plugin_ids=list(available_plugin_ids) if isinstance(available_plugin_ids, list) else None,
            available_skill_ids=list(available_skill_ids) if isinstance(available_skill_ids, list) else None,
            runtime_budget_seconds=int(captured.get("runtime_budget_seconds") or 0),
            runtime_token_budget=int(captured.get("runtime_token_budget") or 0),
            proposal_id=str(captured.get("proposal_id") or payload.get("proposal_id") or "bootstrap_template_proposal"),
            public_key=company_public_key,
            company_revocation_file=revocation_file,
            allow_local_opt_in=allow_local_opt_in,
        )
    except CompanyTrustGateError as exc:
        raise BootstrapCommitError(f"company template re-verification failed at commit: {exc}") from exc
    except TeamTemplateError as exc:
        raise BootstrapCommitError(f"company template could not be rebuilt at commit: {exc}") from exc
    rebuilt_payload = rebuilt.to_dict()
    rebuilt_verification = rebuilt_payload.get("company_verification")
    if not isinstance(rebuilt_verification, dict):
        raise BootstrapCommitError(
            "company source no longer resolves as a company template at commit; refusing to write"
        )
    if rebuilt_verification.get("digest") != captured.get("digest"):
        raise BootstrapCommitError(
            "company template digest changed between proposal and commit; refusing to write"
        )
    if rebuilt_verification.get("trust_state") != captured.get("trust_state"):
        raise BootstrapCommitError(
            "company template trust changed between proposal and commit; refusing to write"
        )
    # The records and human-gate set MUST be exactly what the verified manifest
    # reproduces — never the caller-supplied copy. Compare on the content-bearing
    # fields, ignoring auto-generated per-build tracking ids/timestamps (revision_id,
    # charter_revision_id, created_at, updated_at) which differ on every build and
    # carry no template-derived authority.
    if _canonical_records(rebuilt_payload.get("would_create")) != _canonical_records(payload.get("would_create")):
        raise BootstrapCommitError(
            "company would_create records do not match the verified template; refusing to write"
        )
    if list(rebuilt_payload.get("approvals_required") or []) != list(payload.get("approvals_required") or []):
        raise BootstrapCommitError(
            "company approvals_required does not match the verified template; refusing to write"
        )
    if bool(rebuilt_payload.get("blocked")) or rebuilt_payload.get("rejections"):
        raise BootstrapCommitError(
            "company template no longer builds a clean proposal at commit; refusing to write"
        )
    # Return the AUTHORITATIVE rebuilt payload — downstream (approval artifact + write)
    # uses verified records, never the caller-supplied ones.
    return rebuilt_payload


def apply_bootstrap_commit_payload(
    store: StateStore,
    payload: dict[str, Any],
    *,
    company_revocation_file: Path | None = None,
    company_public_key: str | None = None,
    allow_local_opt_in: bool = False,
    _already_reverified: bool = False,
) -> dict[str, Any]:
    """Materialize a clean or approved proposal in one transaction.

    The company verify-before-instantiate gate is re-run here too: this is the
    durable write boundary reached by BOTH the direct commit path and the
    approval-grant resume path (arbitrary wall-clock time may pass while an
    approval is pending — design §3.7), so the TOCTOU close must live here. The
    re-verify returns the proposal rebuilt from the verified manifest; the durable
    write materializes THOSE records, never the caller-supplied copy.

    ``_already_reverified`` is an internal optimization for the direct commit path,
    which has just re-verified and rebuilt; the approval-resume path (and any
    external caller) leaves it False so the boundary always re-verifies.
    """
    _reject_blocked(payload)
    if not _already_reverified:
        payload = _reverify_company_source(
            payload,
            company_revocation_file=company_revocation_file,
            company_public_key=company_public_key,
            allow_local_opt_in=allow_local_opt_in,
        )
    records = _records_from_payload(payload)
    _validate_records(records)

    with store._connect() as conn:  # noqa: SLF001 - one transaction is the invariant here.
        conn.execute("BEGIN IMMEDIATE")
        existing = _existing_records(conn, records)
        if any(existing.values()):
            _assert_idempotent_existing(existing, records)
            return {
                "created": False,
                "idempotent": True,
                "created_records": {"company_profile": None, "workspace_profile": None, "agent_profiles": [], "issues": []},
                "existing_records": _existing_payload(existing),
            }

        company: CompanyProfile = records["company"]
        workspace: WorkspaceProfile = records["workspace"]
        profiles: list[AgentProfile] = records["profiles"]
        issues: list[Issue] = records["issues"]

        conn.execute(
            "INSERT INTO company_profiles(company_profile_id, payload) VALUES(?, ?)",
            (company.company_profile_id, json.dumps(company.to_dict(), ensure_ascii=False)),
        )
        owner_membership = CompanyMembership(
            company_profile_id=company.company_profile_id,
            principal_type="user",
            principal_id=company.owner_id,
            membership_role="owner",
        )
        conn.execute(
            "INSERT OR IGNORE INTO company_memberships"
            "(membership_id, company_profile_id, principal_type, principal_id, payload)"
            " VALUES(?, ?, ?, ?, ?)",
            (
                owner_membership.membership_id,
                owner_membership.company_profile_id,
                owner_membership.principal_type,
                owner_membership.principal_id,
                json.dumps(owner_membership.to_dict(), ensure_ascii=False),
            ),
        )
        conn.execute(
            "INSERT INTO workspace_profiles(workspace_id, company_profile_id, payload) VALUES(?, ?, ?)",
            (
                workspace.workspace_id,
                workspace.company_profile_id,
                json.dumps(workspace.to_dict(), ensure_ascii=False),
            ),
        )
        for profile in profiles:
            conn.execute(
                "INSERT INTO agent_profiles(profile_id, workspace_id, payload) VALUES(?, ?, ?)",
                (
                    profile.profile_id,
                    profile.workspace_id,
                    json.dumps(profile.to_dict(), ensure_ascii=False),
                ),
            )
            agent_membership = CompanyMembership(
                company_profile_id=profile.company_profile_id,
                principal_type="agent",
                principal_id=profile.profile_id,
            )
            conn.execute(
                "INSERT OR IGNORE INTO company_memberships"
                "(membership_id, company_profile_id, principal_type, principal_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (
                    agent_membership.membership_id,
                    agent_membership.company_profile_id,
                    agent_membership.principal_type,
                    agent_membership.principal_id,
                    json.dumps(agent_membership.to_dict(), ensure_ascii=False),
                ),
            )
        for issue in issues:
            # Same fail-closed typed-field gate the StateStore write paths use, so
            # the bootstrap seed path cannot persist an invalid kind/review_policy.
            assert_valid_issue_typed_fields(issue)
            conn.execute(
                "INSERT INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    issue.issue_id,
                    issue.workspace_id,
                    issue.status,
                    issue.assignee_agent_profile_id,
                    json.dumps(issue.to_dict(), ensure_ascii=False),
                ),
            )
            # 柱子 3 (PR-5): an assigned seed issue must drive the daemon's first
            # run with no human click. ``team_kernel.assign_issue`` emits that
            # assignment wakeup in its own mutation, but the seed path lands the
            # issue via this raw INSERT, so we enqueue the IDENTICAL wakeup here.
            # Crucially it goes on the SAME open transaction (``_enqueue_wakeup_in_conn``,
            # not ``enqueue_wakeup`` — a nested BEGIN IMMEDIATE would dead-lock) so
            # the issue and its wakeup are ONE atomic unit: a crash either keeps
            # both (committed) or neither (rolled back). There is no commit-then-
            # lose window that would strand an assigned-but-never-woken seed issue.
            wakeup = assignment_wakeup_request(issue)
            if wakeup is not None:
                store._enqueue_wakeup_in_conn(conn, wakeup)  # noqa: SLF001 - shared tx

    return {
        "created": True,
        "idempotent": False,
        "created_records": {
            "company_profile": company.to_dict(),
            "workspace_profile": workspace.to_dict(),
            "agent_profiles": [profile.to_dict() for profile in profiles],
            "issues": [issue.to_dict() for issue in issues],
        },
        "existing_records": {"company_profile": None, "workspace_profile": None, "agent_profiles": [], "issues": []},
    }


def _proposal_payload(proposal: BootstrapProposal | dict[str, Any]) -> dict[str, Any]:
    return proposal.to_dict() if isinstance(proposal, BootstrapProposal) else json.loads(json.dumps(proposal))


def _reject_blocked(payload: dict[str, Any]) -> None:
    if payload.get("blocked") or payload.get("rejections"):
        raise BootstrapCommitError("bootstrap proposal is blocked; resolve rejections before commit")


def _same_bootstrap_proposal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two bootstrap proposals describe the same instantiation (ignoring
    per-build tracking ids/timestamps). Compares the records, the human-gate set,
    and the company verification digest so a default-proposal_id collision between
    two DIFFERENT proposals is detected rather than silently aliased."""
    if _canonical_records(a.get("would_create")) != _canonical_records(b.get("would_create")):
        return False
    if list(a.get("approvals_required") or []) != list(b.get("approvals_required") or []):
        return False
    av = a.get("company_verification") if isinstance(a.get("company_verification"), dict) else {}
    bv = b.get("company_verification") if isinstance(b.get("company_verification"), dict) else {}
    av = av or {}
    bv = bv or {}
    return av.get("digest") == bv.get("digest") and av.get("trust_state") == bv.get("trust_state")


def _same_revocation_source(stored: Any, current: Path | None) -> bool:
    """Whether two revocation-source references resolve to the SAME effective file.

    ``None`` normalizes to the gate's default so a request that passes the default
    explicitly equals one that passes ``None``. The revocation source is a trusted,
    security-relevant input: a later request with a different source must NOT alias an
    older pending approval (whose grant would re-verify under the older source)."""
    from superclaw.company_template import default_company_revocation_file

    # A pending approval created by the trusted commit path now ALWAYS persists a
    # concrete resolved revocation path (never None). So a stored None/"" is a legacy or
    # malformed approval whose effective source can't be trusted to equal the current
    # default (which is a runtime resolver that can drift between the HOME data root and a
    # legacy cwd path). Refuse to alias onto it — force a fresh approval that binds a
    # concrete source. (The grant path additionally fails closed on such an approval.)
    if stored is None or stored == "":
        return False

    def _norm(value: Any) -> str:
        # Compare RESOLVED absolute paths so two spellings of the same effective file
        # (and a concrete stored path vs a None that re-resolves to the same default)
        # alias correctly. default_company_revocation_file() is a runtime resolver, so
        # resolve both sides consistently.
        if value is None or value == "":
            return str(default_company_revocation_file().resolve())
        return str(Path(str(value)).resolve())

    return _norm(stored) == _norm(current)


def _ensure_pending_bootstrap_approval(
    store: StateStore,
    payload: dict[str, Any],
    *,
    requested_by: str,
    allow_local_opt_in: bool = False,
    company_revocation_file: Path | None = None,
) -> Approval:
    from superclaw.company_template import default_company_revocation_file

    proposal_id = str(payload.get("proposal_id") or "")
    for approval in store.list_approvals(status=ApprovalStatus.PENDING.value):
        action = approval.resume_action or {}
        if action.get("kernel") == "team.bootstrap.commit" and action.get("proposal_id") == proposal_id:
            # Only dedupe onto an existing pending approval if it carries the SAME
            # proposal AND the same trust semantics. Two DIFFERENT proposals sharing
            # the default proposal_id must not alias one approval — otherwise granting
            # it would replay the first proposal's records (and the first's stored
            # local-opt-in bit) for the second request (governance binding failure).
            # The opt-in is security-relevant: a later official-only request must not
            # alias an earlier local-opted approval (whose grant would resume as local).
            # The revocation SOURCE is equally security-relevant: a later request with a
            # different (e.g. stricter) revocation file must not be rebound onto an
            # older approval that will grant under the first request's looser source.
            existing_proposal = dict(action.get("proposal") or {})
            existing_opt_in = bool(action.get("allow_local_opt_in"))
            if (
                _same_bootstrap_proposal(existing_proposal, payload)
                and existing_opt_in == bool(allow_local_opt_in)
                and _same_revocation_source(action.get("company_revocation_file"), company_revocation_file)
            ):
                return approval
            raise BootstrapCommitError(
                f"a different pending bootstrap approval already exists for proposal_id {proposal_id!r}; "
                "use a unique --proposal-id"
            )
    provenance = dict(payload.get("template") or {})
    equipment = list(payload.get("equipment_resolution") or [])
    budget_clamps = [
        {"role_id": role.get("role_id"), "profile_id": role.get("profile_id"), "budget_clamp": role.get("budget_clamp")}
        for role in payload.get("role_proposals") or []
    ]
    would_create = dict(payload.get("would_create") or {})
    company = dict(would_create.get("company_profile") or {})
    workspace = dict(would_create.get("workspace_profile") or {})
    approval = Approval(
        type=ApprovalType.PERMISSION_GRANT.value,
        workspace_id=str(workspace.get("workspace_id") or "local"),
        requested_by=requested_by,
        requested_permission={
            "action": "team.bootstrap.commit",
            "proposal_id": proposal_id,
            "template": provenance,
            "equipment_resolution": equipment,
            "budget_clamps": budget_clamps,
        },
        affects={
            "company_profile_id": company.get("company_profile_id"),
            "workspace_id": workspace.get("workspace_id"),
            "agent_profile_ids": [
                profile.get("profile_id")
                for profile in would_create.get("agent_profiles") or []
            ],
            "issue_ids": [issue.get("issue_id") for issue in would_create.get("issues") or []],
            "approvals_required": list(payload.get("approvals_required") or []),
        },
        resume_action={
            "kernel": "team.bootstrap.commit",
            "proposal_id": proposal_id,
            "proposal": payload,
            # The operator's verified local-opt-in decision, captured by the TRUSTED
            # server-side commit path that created this approval. The grant/resume path
            # reads it from HERE (a kernel-authored approval artifact), never from a
            # caller-supplied commit payload — so a --trust local company that parks at
            # a human approval can still be materialized on grant, while a crafted commit
            # dict can never inject opt-in (it has no bearing on this stored value).
            "allow_local_opt_in": bool(allow_local_opt_in),
            # Likewise persist the TRUSTED revocation source so the grant/resume re-verify
            # reads the SAME revocation list used at proposal time — closing the
            # approval-resume revocation TOCTOU. The default is RESOLVED to a concrete
            # ABSOLUTE path here (never stored as None): default_company_revocation_file()
            # is a runtime resolver whose result can drift between the HOME data root and a
            # legacy cwd path as files appear/disappear, so persisting None (and
            # re-resolving at grant/resume) would reopen exactly that TOCTOU.
            "company_revocation_file": str(
                (
                    company_revocation_file
                    if company_revocation_file is not None
                    else default_company_revocation_file()
                ).resolve()
            ),
        },
    )
    store.save_approval(approval)
    return approval


def _records_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    would_create = dict(payload.get("would_create") or {})
    try:
        company = CompanyProfile.from_dict(dict(would_create["company_profile"]))
        workspace = WorkspaceProfile.from_dict(dict(would_create["workspace_profile"]))
    except KeyError as exc:
        raise BootstrapCommitError(f"bootstrap proposal missing {exc.args[0]}") from exc
    profiles = [AgentProfile.from_dict(dict(item)) for item in would_create.get("agent_profiles") or []]
    issues = [Issue.from_dict(dict(item)) for item in would_create.get("issues") or []]
    return {"company": company, "workspace": workspace, "profiles": profiles, "issues": issues}


def _validate_records(records: dict[str, Any]) -> None:
    company: CompanyProfile = records["company"]
    workspace: WorkspaceProfile = records["workspace"]
    profiles: list[AgentProfile] = records["profiles"]
    issues: list[Issue] = records["issues"]
    if workspace.company_profile_id != company.company_profile_id:
        raise BootstrapCommitError("workspace belongs to a different company")
    _validate_workspace_policy(workspace)
    profile_ids = [profile.profile_id for profile in profiles]
    duplicate_profiles = sorted({profile_id for profile_id in profile_ids if profile_ids.count(profile_id) > 1})
    if duplicate_profiles:
        raise BootstrapCommitError(f"duplicate agent profile ids: {duplicate_profiles}")
    issue_ids = [issue.issue_id for issue in issues]
    duplicate_issues = sorted({issue_id for issue_id in issue_ids if issue_ids.count(issue_id) > 1})
    if duplicate_issues:
        raise BootstrapCommitError(f"duplicate issue ids: {duplicate_issues}")
    profile_set = set(profile_ids)
    reports_to: dict[str, str] = {}
    for profile in profiles:
        if profile.company_profile_id != company.company_profile_id:
            raise BootstrapCommitError(f"agent {profile.profile_id} crosses company boundary")
        if profile.workspace_id != workspace.workspace_id:
            raise BootstrapCommitError(f"agent {profile.profile_id} crosses workspace boundary")
        if profile.reports_to:
            if profile.reports_to not in profile_set:
                raise BootstrapCommitError(f"agent {profile.profile_id} reports to unknown profile {profile.reports_to}")
            reports_to[profile.profile_id] = profile.reports_to
    for profile_id in reports_to:
        cycle = _reports_to_cycle(profile_id, reports_to)
        if cycle:
            raise BootstrapCommitError(f"reports_to cycle: {' -> '.join(cycle)}")
    for issue in issues:
        if issue.company_profile_id != company.company_profile_id:
            raise BootstrapCommitError(f"issue {issue.issue_id} crosses company boundary")
        if issue.workspace_id != workspace.workspace_id:
            raise BootstrapCommitError(f"issue {issue.issue_id} crosses workspace boundary")
        # Seed-issue assignee gate (PR-5): the raw-SQL commit path bypasses
        # ``team_kernel.assign_issue``'s same-company assignee check, so enforce the
        # SAME invariant at the durable boundary. A seed issue may only be assigned
        # to a profile being CREATED in this same company — a crafted / stale
        # proposal cannot persist an issue pointed at a foreign (or non-existent)
        # profile (which would otherwise enqueue a cross-company wakeup). Fail-closed.
        assignee = issue.assignee_agent_profile_id
        if assignee and assignee not in profile_set:
            raise BootstrapCommitError(
                f"issue {issue.issue_id} is assigned to {assignee}, which is not a "
                "profile created in this company"
            )
        # Assigned-seed actionable-status gate at the DURABLE boundary (mirrors the
        # template builder's ``non_actionable_assigned_seed`` rejection, but here it
        # also catches a crafted/stale payload that skips the builder): an ASSIGNED
        # seed issue enqueues an assignment wakeup, so it must start in a claimable
        # state (backlog/todo). A non-actionable assigned seed (done/in_review/…)
        # would wake an agent for work it can never claim. Fail-closed.
        if assignee and issue.status not in _ACTIONABLE_SEED_STATUSES:
            raise BootstrapCommitError(
                f"issue {issue.issue_id} is assigned but starts {issue.status!r}; an "
                "assigned seed issue must start backlog/todo (it drives a wakeup)"
            )


def _validate_workspace_policy(workspace: WorkspaceProfile) -> None:
    if workspace.network_policy not in {"restricted", "none", "open"}:
        raise BootstrapCommitError(f"unsafe workspace network_policy: {workspace.network_policy}")
    if not workspace.writable_paths:
        raise BootstrapCommitError("unsafe workspace writable_paths: at least one path is required")
    for writable_path in workspace.writable_paths:
        path_text = str(writable_path)
        if "\x00" in path_text or path_text.startswith("/") or ".." in _path_parts(path_text):
            raise BootstrapCommitError(f"unsafe workspace writable_path: {path_text}")


def _path_parts(path_text: str) -> tuple[str, ...]:
    return tuple(part for part in re.split(r"[\\/]+", path_text) if part)


def _reports_to_cycle(start: str, reports_to: dict[str, str]) -> list[str]:
    seen: list[str] = []
    cursor: str | None = start
    while cursor is not None:
        if cursor in seen:
            return seen[seen.index(cursor):] + [cursor]
        seen.append(cursor)
        cursor = reports_to.get(cursor)
    return []


def _existing_records(conn: Any, records: dict[str, Any]) -> dict[str, Any]:
    company: CompanyProfile = records["company"]
    workspace: WorkspaceProfile = records["workspace"]
    profiles: list[AgentProfile] = records["profiles"]
    issues: list[Issue] = records["issues"]
    existing: dict[str, Any] = {"company": None, "workspace": None, "profiles": {}, "issues": {}}
    row = conn.execute(
        "SELECT payload FROM company_profiles WHERE company_profile_id = ?",
        (company.company_profile_id,),
    ).fetchone()
    if row:
        existing["company"] = CompanyProfile.from_dict(json.loads(row["payload"]))
    row = conn.execute(
        "SELECT payload FROM workspace_profiles WHERE workspace_id = ?",
        (workspace.workspace_id,),
    ).fetchone()
    if row:
        existing["workspace"] = WorkspaceProfile.from_dict(json.loads(row["payload"]))
    for profile in profiles:
        row = conn.execute(
            "SELECT payload FROM agent_profiles WHERE profile_id = ?",
            (profile.profile_id,),
        ).fetchone()
        if row:
            existing["profiles"][profile.profile_id] = AgentProfile.from_dict(json.loads(row["payload"]))
    for issue in issues:
        row = conn.execute(
            "SELECT payload FROM issues WHERE issue_id = ?",
            (issue.issue_id,),
        ).fetchone()
        if row:
            existing["issues"][issue.issue_id] = Issue.from_dict(json.loads(row["payload"]))
    return existing


def _assert_idempotent_existing(existing: dict[str, Any], records: dict[str, Any]) -> None:
    company: CompanyProfile = records["company"]
    workspace: WorkspaceProfile = records["workspace"]
    profiles: list[AgentProfile] = records["profiles"]
    issues: list[Issue] = records["issues"]
    if existing["company"] is None or existing["company"].company_profile_id != company.company_profile_id:
        raise BootstrapCommitError("bootstrap id collision: company is missing while other records exist")
    if existing["workspace"] is None or existing["workspace"].workspace_id != workspace.workspace_id:
        raise BootstrapCommitError("bootstrap id collision: workspace is missing while other records exist")
    missing_profiles = [profile.profile_id for profile in profiles if profile.profile_id not in existing["profiles"]]
    missing_issues = [issue.issue_id for issue in issues if issue.issue_id not in existing["issues"]]
    if missing_profiles or missing_issues:
        raise BootstrapCommitError(
            "bootstrap id collision: partial existing records "
            f"(missing profiles={missing_profiles}, missing issues={missing_issues})"
        )
    _assert_matching_template_metadata("company", company.metadata, existing["company"].metadata)
    _assert_matching_template_metadata("workspace", workspace.metadata, existing["workspace"].metadata)
    for profile in profiles:
        _assert_matching_template_metadata(
            f"agent {profile.profile_id}",
            profile.metadata,
            existing["profiles"][profile.profile_id].metadata,
        )
    for issue in issues:
        _assert_matching_template_metadata(
            f"issue {issue.issue_id}",
            issue.metadata,
            existing["issues"][issue.issue_id].metadata,
        )


def _assert_matching_template_metadata(
    label: str,
    expected: dict[str, Any],
    existing: dict[str, Any],
) -> None:
    for key in ("template_source", "template_revision", "template_digest"):
        if (expected or {}).get(key) != (existing or {}).get(key):
            raise BootstrapCommitError(
                f"bootstrap id collision: existing {label} has different {key}"
            )


def _existing_payload(existing: dict[str, Any]) -> dict[str, Any]:
    return {
        "company_profile": _maybe_dict(existing["company"]),
        "workspace_profile": _maybe_dict(existing["workspace"]),
        "agent_profiles": [_maybe_dict(profile) for profile in existing["profiles"].values()],
        "issues": [_maybe_dict(issue) for issue in existing["issues"].values()],
    }


def _maybe_dict(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return asdict(value)
