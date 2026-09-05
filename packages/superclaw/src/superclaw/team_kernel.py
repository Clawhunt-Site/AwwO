"""Agent Team Kernel — organization semantics over the single-run harness.

This module is the single source of truth for how a team of agents takes on a
complex task: roles carry equipment (plugins), issues are delegated with atomic
checkout locks, and completion passes through a human approval gate. Every
surface (CLI / API / Web / Desktop) must call through here rather than
re-implementing any of these rules, so behaviour can never diverge between the
kernel and a client.

Design invariants (all fail-closed):

- Equipment can only *narrow* the governed plugin projection. A profile never
  grants a plugin that ``plugin_runtime_projection.available_plugins`` withheld.
- An issue has at most one assignee.
- Checkout takes a durable workspace lock; a second checkout of the same
  workspace fails rather than silently sharing the repo.
- ``done`` is only reachable from ``in_review`` via an approved approval record.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Any, Callable

from superclaw.budget_policy import (
    BudgetGateError,
    BudgetScopeCheck,
    budget_limit_has_value,
    hard_budget_preflight,
)
from superclaw.models import (
    AgentProfile,
    AgentWakeupRequest,
    Approval,
    ApprovalStatus,
    ApprovalType,
    CompanyStatus,
    ContinuationPolicy,
    DECIDER_TYPES,
    DeciderType,
    Issue,
    IssueComment,
    IssueHold,
    IssueInteractionKind,
    IssueKind,
    IssueStatus,
    IssueThreadInteraction,
    ReviewPolicy,
    TERMINAL_ISSUE_STATUSES,
    TERMINAL_RUN_STATUSES,
    WakeupSource,
    WorkProduct,
    is_valid_approval_status_transition,
)
from superclaw.models import _WORK_PRODUCT_STATUSES, _WORK_PRODUCT_TYPES, _id
from superclaw.liveness import ACTIVE_RUN_STATUSES
from superclaw.plugin_runtime_projection import available_plugins, gate_passing_plugins
from superclaw.state import StateStore


class ReassignedError(ValueError):
    """Raised when a checkout's expected assignee no longer matches the issue.

    A distinct type so the daemon can tell "the issue was reassigned out from
    under me" (skip cleanly — the new assignee's wakeup will claim it) apart
    from a genuine workspace-lock conflict (defer + retry)."""


class ClaimChangedError(ValueError):
    """Raised when a submit-for-review's expected claim token no longer owns the
    issue (a requeue + re-checkout happened mid-flight). A distinct type so the
    daemon can tell "my claim is stale, do not submit someone else's work" apart
    from a genuine invalid-transition error."""


class IssueHeldError(ValueError):
    """Raised when an operation that would ADVANCE or SPAWN work runs into an
    administrative hold (checkout / delegate / submit-for-review). A distinct
    type so the daemon can tell "this issue is frozen, finish cleanly without
    submitting" apart from a genuine invalid-transition error. A hold freezes
    governance progress: held work cannot start, branch, or reach review until
    the hold is released."""


@dataclass(frozen=True)
class EquipmentResolution:
    """The plugins and skills a profile may actually carry right now.

    ``granted`` is ``allowlist ∩ governed-projection``. ``dropped`` is what the
    profile asked for but the projection withheld (uninstalled, unsigned,
    revoked, un-entitled, or policy-blocked) — surfaced so the operator can see
    *why* a requested tool is absent rather than silently losing it. Skills
    resolve through the same fail-closed gate (a skill is the projection of a
    governed plugin), tracked as a separate dimension because skills sync into
    native runtime directories rather than projecting MCP tools.
    """

    profile_id: str
    granted: tuple[str, ...]
    dropped: tuple[str, ...]
    available: tuple[str, ...]
    skills_granted: tuple[str, ...] = ()
    skills_dropped: tuple[str, ...] = ()
    skills_available: tuple[str, ...] = ()


def available_skill_ids(
    *,
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
) -> list[str]:
    """The governed skill universe: gate-passing plugins marked ``skill_origin``.

    Enumeration goes through :func:`gate_passing_plugins` — the same fail-closed
    governance gate as ``available_plugins`` — and *not* a bare cache listing,
    so a revoked or unsigned skill can never enter a profile's equipment. The
    gate is tools-agnostic on purpose: a native skill may project zero MCP
    tools and must still be equippable.
    """
    from superclaw.plugin_proxy import load_cached_package
    from superclaw.plugins import is_skill_origin_plugin

    ids: list[str] = []
    for plugin_id, version in gate_passing_plugins(
        cache_root=cache_root,
        entitlement_file=entitlement_file,
        revocation_file=revocation_file,
        policy_file=policy_file,
        public_key=public_key,
    ):
        package = None
        try:
            package = load_cached_package(plugin_id, version=version, cache_root=cache_root)
            if package is None:
                continue
            if is_skill_origin_plugin(plugin_id, package.manifest.get("skill_origin")):
                ids.append(plugin_id)
        except Exception:  # fail closed: an unreadable package is not a skill
            continue
        finally:
            if package is not None:
                package.cleanup()
    return ids


def resolve_equipment(
    profile: AgentProfile,
    *,
    cache_root: Path | None = None,
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    policy_file: Path | None = None,
    public_key: str | None = None,
    available_ids: list[str] | None = None,
    available_skill_ids_override: list[str] | None = None,
) -> EquipmentResolution:
    """Intersect a profile's allowlists with the governed runtime projection.

    The intersection is the security boundary: the profile chooses *from* what
    governance already permits and can never widen it. ``available_ids`` /
    ``available_skill_ids_override`` are injection seams for tests; production
    resolves them from ``available_plugins`` / ``available_skill_ids``.
    """
    if available_ids is None:
        # A skill-origin package appears in available_plugins ONLY so a tool-skill can
        # be MCP-projected (superclaw__call_tool / _skill_overlay_lines); it is NEVER
        # grantable as PLUGIN equipment. Exclude the skill universe from the plugin
        # grant HERE — not in available_plugins, which the MCP projection and the
        # @skill overlay both read — so a skill is equipped solely via skill_allowlist
        # below. Red line: a skill is never equipped as a plugin.
        available = [
            p.plugin_id
            for p in available_plugins(
                cache_root=cache_root,
                entitlement_file=entitlement_file,
                revocation_file=revocation_file,
                policy_file=policy_file,
                public_key=public_key,
            )
            if not p.skill_origin
        ]
    else:
        available = list(available_ids)
    available_set = set(available)
    requested = list(dict.fromkeys(profile.plugin_allowlist))  # de-dupe, keep order
    granted = tuple(pid for pid in requested if pid in available_set)
    dropped = tuple(pid for pid in requested if pid not in available_set)

    requested_skills = list(dict.fromkeys(profile.skill_allowlist))
    if available_skill_ids_override is None:
        # Only pay the enumeration cost when the profile actually asks for skills.
        skills_available = available_skill_ids(
            cache_root=cache_root,
            entitlement_file=entitlement_file,
            revocation_file=revocation_file,
            policy_file=policy_file,
            public_key=public_key,
        ) if requested_skills else []
    else:
        # Pure injection seam for unit tests: the caller passes the ALREADY-GATED
        # universe. Production callers (build_bootstrap_proposal, §3.8) must
        # compute this from the gated available_skill_ids and intersect any
        # request-supplied hint BEFORE handing it here — never forward a raw
        # request list as authority.
        skills_available = list(available_skill_ids_override)
    skills_available_set = set(skills_available)
    skills_granted = tuple(sid for sid in requested_skills if sid in skills_available_set)
    skills_dropped = tuple(sid for sid in requested_skills if sid not in skills_available_set)

    return EquipmentResolution(
        profile_id=profile.profile_id,
        granted=granted,
        dropped=dropped,
        available=tuple(available),
        skills_granted=skills_granted,
        skills_dropped=skills_dropped,
        skills_available=tuple(skills_available),
    )


# Fields a profile config-edit may move. Identity/scope (profile_id,
# workspace_id, company_profile_id, owner_id, created_at) is immutable here — it
# re-scopes governance and is set once at creation — and the charter has its own
# revisioned path (update_agent_charter), so both are intentionally excluded.
EDITABLE_PROFILE_FIELDS = (
    "name",
    "role",
    "title",
    "backend_policy",
    "model",
    "effort",
    "plugin_allowlist",
    "skill_allowlist",
    "permission_policy",
    "budget_seconds",
    "token_budget",
    "run_count_budget",
    "external_tool_budget",
    "context_mode",
    "reports_to",
    "runtime_config",
    "persona",
    "default_instructions",
)

_VALID_PERMISSION_MODES = {
    "plan",
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
}

_MAX_MANAGER_CHAIN = 64


def _validate_permission_policy(policy: Any) -> None:
    """Raise ValueError if a non-empty permission_policy carries an invalid mode.

    The single permission-mode gate, reused by every kernel entry that stores a
    policy (profile edit and hire) so the CLI can never be the only check.
    """
    if not policy:
        return
    mode = policy.get("mode") if isinstance(policy, dict) else None
    if not isinstance(policy, dict) or str(mode or "") not in _VALID_PERMISSION_MODES:
        raise ValueError(f"invalid permission_policy: {policy!r}")


def default_company_runtime_policy() -> dict[str, str]:
    """Runtime tool posture for an agent CONFIRMED to be in a company's kernel-
    governance domain.

    Per the max-permission doctrine the runtime is a pure execution engine handed
    max permission; governance lives ABOVE it (the hire human-gate, the
    company_autonomy ownership / reports_to subtree gates, pay/scan fail-closed,
    is_admin kernel-derived False, workspace writable_paths / network_policy). So a
    governed company agent with NO explicit policy should run at ``bypassPermissions``
    rather than the read-only ``plan`` floor that would stop a CEO from doing its job
    (hiring, delegating, commenting).

    This is NOT a security-boundary downgrade: it is only ever applied at a creation
    point where the company membership is a confirmed structural fact (a real,
    persisted company — see :func:`_is_governed_company_id` — or a company role inside
    a template build). The fail-closed floor in ``daemon._permission_policy_for`` is
    deliberately LEFT UNCHANGED, so config loss / a stripped policy still falls to
    read-only ``plan`` — never silently to max (advisor review: keep the floor
    fail-safe, make max an explicit stored fact).
    """
    return {"mode": "bypassPermissions"}


def _is_governed_company_id(store: StateStore, company_id: Any) -> bool:
    """True only for a real, persisted company (the positive structural check that a
    creation-time default to ``bypassPermissions`` is sound). The ``local`` home
    company and any unknown / missing id are NOT governed companies — they stay on the
    read-only floor (never default a non-company / corrupt id up to max)."""
    if not company_id or not isinstance(company_id, str) or company_id == "local":
        return False
    try:
        store.get_company_profile(company_id)
    except KeyError:
        return False
    return True


def apply_heartbeat(
    runtime_config: dict[str, Any] | None,
    *,
    enabled: bool,
    interval_sec: int = 300,
) -> dict[str, Any]:
    """Return ``runtime_config`` with the heartbeat policy toggled, siblings kept.

    The single definition of heartbeat-merge semantics: every surface (CLI, API,
    Web) builds the new ``runtime_config`` through this, so a heartbeat toggle can
    never clobber another runtime setting and no surface re-implements the merge.
    """
    merged = dict(runtime_config or {})
    if enabled:
        merged["heartbeat"] = {"enabled": True, "interval_sec": interval_sec}
    else:
        merged.pop("heartbeat", None)
    return merged


def update_agent_profile(
    store: StateStore,
    profile_id: str,
    *,
    patch: dict[str, Any],
    expected_revision_id: str | None = None,
) -> tuple[AgentProfile, EquipmentResolution]:
    """Apply a partial config change to an existing agent profile (human-edit path).

    Mirrors Paperclip's per-agent settings edit. Only :data:`EDITABLE_PROFILE_FIELDS`
    move; identity/scope and the charter are rejected. The change passes the same
    gates the creation path uses — permission mode, ``reports_to`` acyclicity, and
    the governance-scope assertion in :meth:`StateStore.save_agent_profile` — so a
    surface cannot edit around a fail-closed rule. ``revision_id`` bumps on every
    apply; pass ``expected_revision_id`` for optimistic concurrency (reject a stale
    edit instead of clobbering a concurrent one). Returns the saved profile plus a
    fresh :class:`EquipmentResolution` so a caller sees the new granted/dropped
    skills immediately.
    """
    profile = store.get_agent_profile(profile_id)  # KeyError -> unknown profile
    if expected_revision_id is not None and profile.revision_id != expected_revision_id:
        raise ValueError(
            f"profile {profile_id} was modified (revision {profile.revision_id}, "
            f"expected {expected_revision_id}); reload before editing"
        )
    if not patch:
        raise ValueError("empty patch: pass at least one field to update")
    unknown = [k for k in patch if k not in EDITABLE_PROFILE_FIELDS]
    if unknown:
        raise ValueError(
            f"fields not editable: {sorted(unknown)} "
            "(charter uses update_agent_charter; workspace/company/ids are immutable)"
        )

    if "permission_policy" in patch:
        _validate_permission_policy(patch["permission_policy"])

    if "reports_to" in patch:
        new_manager = patch["reports_to"]
        if new_manager == profile_id:
            raise ValueError("an agent cannot report to itself")
        # Walk the proposed manager's chain up to the root; the edited profile
        # reappearing means this edit would close a management cycle. A dangling
        # manager reference is allowed (the creation path permits it too).
        cursor = new_manager
        seen = {profile_id}
        depth = 0
        while cursor:
            if depth >= _MAX_MANAGER_CHAIN:
                # A chain deeper than the bound cannot be proven acyclic — fail
                # closed rather than walk off the end and silently allow it.
                raise ValueError(
                    f"reports_to chain exceeds {_MAX_MANAGER_CHAIN} levels; refusing "
                    "(cannot prove it is acyclic)"
                )
            if cursor in seen:
                raise ValueError(
                    f"reports_to would create a management cycle through {cursor}"
                )
            seen.add(cursor)
            try:
                manager = store.get_agent_profile(cursor)
            except KeyError:
                break  # dangling manager ref is allowed (matches creation)
            cursor = manager.reports_to
            depth += 1

    for field_name, value in patch.items():
        setattr(profile, field_name, value)
    profile.revision_id = f"rev_{uuid.uuid4().hex[:12]}"
    store.save_agent_profile(profile)  # re-asserts the governance scope
    return profile, resolve_equipment(profile)


def update_agent_charter(
    store: StateStore,
    profile_id: str,
    *,
    charter: str | None = None,
    persona: str | None = None,
) -> AgentProfile:
    """Update an agent's behavioral charter and/or persona (the revisioned path).

    The charter is the role's behavior contract — distinct from the scalar/allowlist
    fields ``update_agent_profile`` edits, which deliberately REJECT charter
    (``EDITABLE_PROFILE_FIELDS`` excludes it). Setting a charter marks its source
    ``manual`` (a human authored it, not a template/import) and bumps
    ``charter_revision_id`` so a consumer can detect the change. A blank/None charter
    leaves the existing charter untouched (only persona, if provided, moves); persona
    is set whenever provided (including to an empty string to clear it). The save
    re-asserts the governance scope. The SINGLE charter-write entry shared by the
    REST endpoint and the chat ``agent.charter`` command (no second write path).

    Fail-closed on a no-op: a call that would change NOTHING (no charter and no
    persona) is rejected rather than silently bumping ``charter_revision_id`` for
    nothing — so the REST endpoint and the command reject an empty edit identically."""
    if not charter and persona is None:
        raise ValueError("nothing to update: provide a charter and/or persona")
    profile = store.get_agent_profile(profile_id)  # KeyError -> unknown profile
    if charter:
        profile.charter = charter
        profile.charter_source = "manual"
    if persona is not None:
        profile.persona = persona
    profile.charter_revision_id = _id("charterrev")
    return store.save_agent_profile(profile)


_ASSIGNABLE_ISSUE_STATUSES = {IssueStatus.BACKLOG.value, IssueStatus.TODO.value}


def assign_issue(store: StateStore, issue_id: str, profile_id: str) -> Issue:
    """Assign an issue to exactly one agent profile (single-assignee invariant).

    Fail-closed across the governance namespace: an issue can only be assigned
    to a profile of the same company, so work never silently crosses a company
    boundary. Reassignment is only legal before work starts (backlog/todo) —
    once an issue is checked out, its lock and review flow are anchored to the
    in-flight execution and a silent assignee swap would corrupt them.
    """
    issue = store.get_issue(issue_id)
    profile = store.get_agent_profile(profile_id)  # raises KeyError if unknown
    if profile.company_profile_id != issue.company_profile_id:
        raise ValueError(
            f"cross-company assignment: issue {issue_id} belongs to company "
            f"{issue.company_profile_id}, profile {profile_id} to {profile.company_profile_id}"
        )
    if issue.status not in _ASSIGNABLE_ISSUE_STATUSES:
        raise ValueError(
            f"issue {issue_id} cannot be reassigned while {issue.status}; "
            "only backlog/todo issues take a new assignee"
        )
    issue.assignee_agent_profile_id = profile.profile_id
    if issue.status == IssueStatus.BACKLOG.value:
        issue.status = IssueStatus.TODO.value
    issue.updated_at = time()
    saved = store.save_issue(issue)
    # Assignment is an event, not a fact someone has to poll for. Built through
    # the SINGLE constructor ``assignment_wakeup_request`` so the bootstrap seed
    # path and this runtime path can never drift in wakeup shape (柱子 3). Enqueue
    # is best-effort: a failed continuation never fails the assignment mutation
    # (the heartbeat timer backstops heartbeat-enabled roles).
    request = assignment_wakeup_request(saved)
    if request is not None:
        try:
            store.enqueue_wakeup(request)
        except Exception:  # pragma: no cover - continuation is best-effort
            pass
    return saved


# --- board escalation inbox -------------------------------------------------
#
# The board inbox is the human-escalation queue: durable ``ESCALATE_TO_BOARD``
# interactions awaiting an operator's decision. These are the SINGLE source the
# CLI (``team board-inbox``), REST (``/api/team/board-inbox``) and chat
# (``board_inbox.resolve`` / ``board_inbox.assign`` company commands) all drive,
# so the "only a board item, only when pending, assign through the same gate"
# rules can never drift between surfaces.


def _board_inbox_item_or_raise(
    store: StateStore, interaction_id: str
) -> IssueThreadInteraction:
    """Load a board-inbox interaction or fail closed.

    ``KeyError`` (propagated from the store) → unknown id; ``ValueError`` → the
    interaction exists but is NOT an ``ESCALATE_TO_BOARD`` item, so a caller can
    never resolve/assign a non-board thread event by guessing its id."""
    interaction = store.get_issue_interaction(interaction_id)  # KeyError -> unknown
    if interaction.continuation_policy != ContinuationPolicy.ESCALATE_TO_BOARD.value:
        raise ValueError("interaction is not a board inbox item")
    return interaction


def resolve_board_inbox_item(
    store: StateStore, interaction_id: str
) -> IssueThreadInteraction:
    """Mark a board-inbox escalation resolved without touching its issue.

    Idempotent: an already-resolved item is returned unchanged (no error), so a
    double-resolve is a no-op rather than a failure. A non-board interaction →
    ``ValueError`` (fail-closed)."""
    interaction = _board_inbox_item_or_raise(store, interaction_id)
    if interaction.status == "resolved":
        return interaction
    return store.resolve_issue_interaction(interaction_id)


def assign_board_inbox_item(
    store: StateStore,
    interaction_id: str,
    profile_id: str,
    *,
    resolve: bool = True,
) -> tuple[Issue, IssueThreadInteraction]:
    """Assign the board item's issue through the assignment gate, then (optionally)
    resolve the escalation. Returns ``(issue, interaction)``.

    Requires the item be PENDING — an already-handled escalation is not
    re-assignable through the inbox (its decision was already made). The actual
    assignment goes through :func:`assign_issue`, which enforces the same-company
    and assignable-status invariants, so the inbox path adds no second assignment
    rule to drift from."""
    interaction = _board_inbox_item_or_raise(store, interaction_id)
    if interaction.status != "pending":
        raise ValueError(f"board inbox item is {interaction.status}, not pending")
    issue = assign_issue(store, interaction.issue_id, profile_id)
    resolved = (
        store.resolve_issue_interaction(interaction_id) if resolve else interaction
    )
    return issue, resolved


def validate_workspace_concurrency(repo_path: str, concurrency: str) -> None:
    """Fail closed on an unisolatable per_issue declaration.

    ``per_issue`` checkout locks are only safe when execution can isolate per
    issue, which today means a git repo (worktrees). Creating a per_issue
    workspace on a non-git path is refused at the source instead of being
    discovered as a guard-serialized surprise at run time.
    """
    if concurrency not in {"serial", "per_issue"}:
        raise ValueError(f"unknown workspace concurrency: {concurrency!r} (serial | per_issue)")
    if concurrency == "per_issue":
        repo = Path(repo_path or ".")
        if not repo.is_absolute():
            raise ValueError(
                "per_issue concurrency requires an absolute repo_path — the "
                "isolation proof must not depend on whichever cwd validated it"
            )
        if not (repo / ".git").exists():
            raise ValueError(
                f"per_issue concurrency requires a git repo at {repo_path!r} "
                "(execution isolates via git worktrees); use serial instead"
            )


def issue_release_key(issue: Issue, *, store: StateStore | None = None) -> str:
    """The key to RELEASE for this issue: the pinned checkout key, else derived.

    Acquisition derives the key from the live governance declaration; release
    must free what was actually taken — the pin makes the pair immune to a
    concurrency flip (or a profile read failure) between the two moments.
    """
    return issue.lock_key or workspace_lock_key(issue, store=store)


def workspace_lock_key(issue: Issue, *, store: StateStore | None = None) -> str:
    """The resource an issue checkout locks.

    Granularity is a durable governance declaration on the WorkspaceProfile:
    - "serial" (default, fail-safe): the whole workspace — two agents never
      write the same repo at once.
    - "per_issue": the issue itself — legal only because execution isolates
      per issue (git worktrees); enabling it is gated at workspace creation.
    Unknown/missing workspace profiles fall back to serial (fail-closed).
    """
    if store is not None:
        try:
            workspace = store.get_workspace_profile(issue.workspace_id)
            if workspace.concurrency == "per_issue":
                return f"issue:{issue.issue_id}"
        except Exception:
            pass
    return f"workspace:{issue.workspace_id}"


def issue_start_budget_preflight(store: StateStore, issue: Issue, *, action: str = "checkout") -> Any:
    return hard_budget_preflight(store, _issue_start_budget_checks(store, issue), action=action)


def checkout_issue(
    store: StateStore, issue_id: str, *, run_id: str, holder: str | None = None,
    expected_assignee: str | None = None,
) -> Issue:
    """Take the workspace lock and move an assigned issue into ``in_progress``.

    Note: this is the kernel claim primitive. The daemon additionally holds a
    per-agent claim lock (single flight per agent); calling checkout directly
    (CLI/API) is an OPERATOR action and may claim several issues for one
    holder under per_issue workspaces — by design, not a scheduler path.

    Fails closed if the issue is unassigned or the workspace is already checked
    out by someone else. ``checkout_run_id`` records the ownership lock and
    ``execution_run_id`` the live run — kept distinct so recovery can tell who
    *owns* the issue from which run is *running* it.
    """
    issue = store.get_issue(issue_id)
    # Hold gate (fail-closed, kernel-side so NO surface can start work on a held
    # issue — the daemon's skip is defense-in-depth, not the only line).
    if store.issue_is_held(issue_id):
        raise IssueHeldError(
            f"issue {issue_id} is on hold; release the hold before checkout"
        )
    if not issue.assignee_agent_profile_id:
        raise ValueError(f"issue {issue_id} has no assignee; assign before checkout")
    # Reassignment guard (fail-closed): a caller that claims on behalf of a
    # specific agent (the daemon passes the profile it woke for) must not lock
    # an issue that was reassigned to someone else in the meantime. Operators
    # who checkout directly omit ``expected_assignee`` and keep their freedom.
    if expected_assignee is not None and issue.assignee_agent_profile_id != expected_assignee:
        raise ReassignedError(
            f"issue {issue_id} reassigned to {issue.assignee_agent_profile_id}, "
            f"not {expected_assignee}; the new assignee will claim it"
        )
    # Secrets invokability gate (fail-closed, Paperclip §6 semantics): an agent
    # whose REQUIRED secret bindings cannot resolve must not take work — refusing
    # at checkout beats failing mid-run with a half-claimed workspace.
    from superclaw.secrets_store import check_invokability

    invokability = check_invokability(
        store,
        target_type="agent_profile",
        target_id=issue.assignee_agent_profile_id,
        company_profile_id=issue.company_profile_id,
    )
    if not invokability.ok:
        raise ValueError(
            f"agent {issue.assignee_agent_profile_id} is not invokable: {invokability.reason()}"
            " (restore or rebind the secret, or mark the binding optional)"
        )
    budget_preflight = issue_start_budget_preflight(store, issue, action="checkout")
    if not budget_preflight.allowed:
        raise BudgetGateError(budget_preflight)
    lock_holder = holder or issue.assignee_agent_profile_id
    # Acquire the durable workspace lock first; if this raises, no state changed.
    acquired_key = workspace_lock_key(issue, store=store)
    store.acquire_workspace_lock(
        acquired_key,
        workspace_id=issue.workspace_id,
        holder=lock_holder,
        issue_id=issue.issue_id,
        run_id=run_id,
    )
    try:
        issue.checkout_run_id = run_id
        issue.execution_run_id = run_id
        issue.lock_key = acquired_key  # pin: release always frees THIS key
        issue.status = IssueStatus.IN_PROGRESS.value
        issue.updated_at = time()
        # commit_checkout re-checks the hold INSIDE the in_progress write's
        # transaction (not just the pre-check above), so a hold landing between
        # the pre-check and this commit — e.g. a concurrent tree pause — cannot
        # leak a newly in_progress run onto a held issue.
        return store.commit_checkout(issue)
    except Exception:
        # Never strand the lock if the status write fails.
        store.release_workspace_lock(acquired_key, holder=lock_holder)
        raise


def _issue_start_budget_checks(store: StateStore, issue: Issue) -> list[BudgetScopeCheck]:
    checks: list[BudgetScopeCheck] = []
    try:
        company = store.get_company_profile(issue.company_profile_id)
    except KeyError:
        company = None
    if company is not None:
        hard_limits = {"token_budget": company.default_token_budget}
        hard_limits.update(_hard_limits_from_metadata(company.metadata))
        if budget_limit_has_value(hard_limits):
            checks.append(
                BudgetScopeCheck(
                    scope="company",
                    scope_id=company.company_profile_id,
                    cost_governed=True,
                    hard_limits=hard_limits,
                )
            )
    if issue.assignee_agent_profile_id:
        profile = store.get_agent_profile(issue.assignee_agent_profile_id)
        hard_limits = {
            "token_budget": profile.token_budget,
            "run_count_budget": profile.run_count_budget,
            "external_tool_budget": profile.external_tool_budget,
        }
        hard_limits.update(_hard_limits_from_metadata(profile.metadata))
        if budget_limit_has_value(hard_limits):
            checks.append(
                BudgetScopeCheck(
                    scope="agent",
                    scope_id=profile.profile_id,
                    cost_governed=True,
                    hard_limits=hard_limits,
                )
            )
    issue_policy = _scope_budget_policy(issue.metadata)
    if issue_policy is not None:
        checks.append(
            BudgetScopeCheck(
                scope="issue",
                scope_id=issue.issue_id,
                cost_governed=issue_policy["cost_governed"],
                hard_limits=issue_policy["hard_limits"],
                soft_limits=issue_policy["soft_limits"],
                limit_layers=issue_policy["limit_layers"],
            )
        )
    return checks


def _hard_limits_from_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    raw = metadata.get("budget_policy") or metadata.get("budget")
    if not isinstance(raw, dict):
        return {}
    hard_limits = raw.get("hard_limits")
    return dict(hard_limits) if isinstance(hard_limits, dict) else {}


def _scope_budget_policy(metadata: dict[str, Any]) -> dict[str, Any] | None:
    raw = metadata.get("budget_policy") or metadata.get("budget")
    if not isinstance(raw, dict):
        return None
    hard_limits = raw.get("hard_limits")
    if not isinstance(hard_limits, dict):
        hard_limits = raw
    soft_limits = raw.get("soft_limits") if isinstance(raw.get("soft_limits"), dict) else None
    limit_layers = raw.get("limit_layers") if isinstance(raw.get("limit_layers"), list) else ()
    cost_governed = bool(raw.get("cost_governed", budget_limit_has_value(hard_limits)))
    return {
        "cost_governed": cost_governed,
        "hard_limits": dict(hard_limits),
        "soft_limits": soft_limits,
        "limit_layers": tuple(limit_layers),
    }


# --- issue thread: comments, mentions, and deterministic continuations -------

_MENTION_RE = re.compile(r"@([A-Za-z0-9_\-\.]+)")


def _wake_agent(
    store: StateStore,
    profile: AgentProfile,
    *,
    source: str,
    reason: str,
    snapshot: dict[str, Any],
    idempotency_key: str | None = None,
) -> None:
    """Best-effort kernel-side wakeup enqueue (the daemon drains it).

    Lives here — not in the daemon — so every surface that calls a kernel
    mutation produces the same continuation, CLI parity included. Failure to
    enqueue never fails the mutation (the heartbeat timer is the safety net
    for heartbeat-enabled roles).
    """
    try:
        store.enqueue_wakeup(
            AgentWakeupRequest(
                agent_profile_id=profile.profile_id,
                company_profile_id=profile.company_profile_id,
                source=source,
                reason=reason,
                idempotency_key=idempotency_key,
                context_snapshot=snapshot,
            )
        )
    except Exception:  # pragma: no cover - continuation is best-effort
        pass


def assignment_wakeup_request(issue: Issue) -> AgentWakeupRequest | None:
    """Build the canonical assignment-wakeup request for an ALREADY-assigned issue.

    Single-sources the wakeup shape (source / reason / idempotency key / snapshot)
    that :func:`assign_issue` emits, so a path that lands an assigned issue WITHOUT
    going through ``assign_issue`` — in particular the bootstrap-commit seed path,
    which materializes seed issues in one transaction — produces a byte-identical
    wakeup. Identical shape means the daemon claim gate cannot tell a seed wakeup
    from a runtime assignment and a re-fire coalesces (same idempotency key)
    instead of duplicating.

    Returns ``None`` (not a request) for an unassigned issue, so the caller skips
    enqueuing rather than waking nobody. Building the request does NOT touch the
    store; the caller decides how to persist it (e.g. atomically inside the
    bootstrap transaction via ``_enqueue_wakeup_in_conn``).
    """
    profile_id = issue.assignee_agent_profile_id
    if not profile_id:
        return None
    return AgentWakeupRequest(
        agent_profile_id=profile_id,
        company_profile_id=issue.company_profile_id,
        source=WakeupSource.ASSIGNMENT.value,
        reason=f"issue_assigned:{issue.issue_id}",
        idempotency_key=f"assignment:{profile_id}:{issue.issue_id}",
        context_snapshot={"issue_id": issue.issue_id},
    )


def post_issue_comment(
    store: StateStore,
    issue_id: str,
    *,
    body: str,
    author_type: str = "user",
    author_id: str = "local_user",
    wake_assignee: bool = True,
) -> tuple[IssueComment, list[IssueThreadInteraction]]:
    """Post a comment on an issue's thread and fire its continuations.

    Two deterministic continuations (the "comment is how you call for help"
    rule): every ``@name`` / ``@profile_id`` mention wakes the mentioned agent,
    and a comment from anyone who is NOT the assignee wakes the assignee —
    which is exactly how a blocked issue's unblock message reaches its owner.
    Mention resolution is company-scoped: a name can never address another
    company's agent.
    """
    if not body.strip():
        raise ValueError("comment body must not be empty")
    issue = store.get_issue(issue_id)
    comment = IssueComment(
        issue_id=issue.issue_id,
        company_profile_id=issue.company_profile_id,
        body=body,
        author_type=author_type,
        author_id=author_id,
    )
    store.add_issue_comment(comment)

    profiles = store.list_agent_profiles(company_profile_id=issue.company_profile_id)
    by_id = {p.profile_id: p for p in profiles}
    # Fail-closed name resolution: a duplicated display name is AMBIGUOUS and
    # resolves to nobody (waking the wrong agent silently is worse than not
    # waking) — an ambiguous mention must use the profile_id form instead.
    name_counts: dict[str, int] = {}
    for p in profiles:
        name_counts[p.name] = name_counts.get(p.name, 0) + 1
    by_name = {p.name: p for p in profiles if name_counts[p.name] == 1}
    interactions: list[IssueThreadInteraction] = []
    woken: set[str] = set()
    for token in dict.fromkeys(_MENTION_RE.findall(body)):
        target = by_id.get(token) or by_name.get(token)
        # Never wake the comment's own author for self-@mention (mirrors the
        # assignee rule below): you don't get pinged by your own message, and a
        # self-mention must not drive a thread respond run (self-loop guard).
        if target is None or target.profile_id in woken or target.profile_id == author_id:
            continue
        interaction = IssueThreadInteraction(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            kind=IssueInteractionKind.MENTION.value,
            continuation_policy=ContinuationPolicy.WAKE_ASSIGNEE.value,
            target_agent_profile_id=target.profile_id,
            source_comment_id=comment.comment_id,
            created_by_type=author_type,
            created_by_id=author_id,
            payload={"mention": token},
        )
        store.save_issue_interaction(interaction)
        _wake_agent(
            store,
            target,
            source=WakeupSource.ON_DEMAND.value,
            reason=f"mention:{issue.issue_id}",
            snapshot={"issue_id": issue.issue_id, "comment_id": comment.comment_id},
        )
        woken.add(target.profile_id)
        interactions.append(interaction)

    assignee_id = issue.assignee_agent_profile_id
    if wake_assignee and assignee_id and assignee_id != author_id and assignee_id not in woken:
        assignee = by_id.get(assignee_id)
        if assignee is not None:
            _wake_agent(
                store,
                assignee,
                source=WakeupSource.ON_DEMAND.value,
                reason=f"comment:{issue.issue_id}",
                snapshot={"issue_id": issue.issue_id, "comment_id": comment.comment_id},
            )
    return comment, interactions


def block_issue(
    store: StateStore,
    issue_id: str,
    *,
    reason: str,
    by: str = "local_user",
    unblock_owner: str | None = None,
) -> Issue:
    """Mark an issue blocked with a durable reason and (optionally) who can unblock.

    A blocked issue is invisible to the scheduler (only ``todo`` is claimable),
    so the reason + owner on the thread is what keeps it from being a silent
    dead end — the unblock owner gets woken to act on it.
    """
    if not reason.strip():
        raise ValueError("a blocked issue must say why (reason required)")
    issue = store.get_issue(issue_id)
    issue.status = IssueStatus.BLOCKED.value
    # Blocking returns the claim: holding the workspace lock across an
    # arbitrarily long external wait would starve the whole workspace, and a
    # lock that outlives its claim would deadlock the re-checkout after
    # unblock. The lock release is conditional on still belonging to this
    # issue (atomic inside the release transaction).
    release_key = issue_release_key(issue, store=store)
    issue.checkout_run_id = None
    issue.execution_run_id = None
    issue.lock_key = None
    issue.updated_at = time()
    store.save_issue(issue)
    store.release_workspace_lock(release_key, expected_issue_id=issue.issue_id)
    body = f"[blocked] {reason}" + (f" (unblock owner: @{unblock_owner})" if unblock_owner else "")
    comment, _ = post_issue_comment(store, issue_id, body=body, author_type="system", author_id=by)
    interaction = IssueThreadInteraction(
        issue_id=issue.issue_id,
        company_profile_id=issue.company_profile_id,
        kind=IssueInteractionKind.STATUS_CHANGE.value,
        continuation_policy=ContinuationPolicy.WAKE_ASSIGNEE.value,
        source_comment_id=comment.comment_id,
        created_by_type="system",
        created_by_id=by,
        payload={"status": IssueStatus.BLOCKED.value, "reason": reason, "unblock_owner": unblock_owner},
    )
    store.save_issue_interaction(interaction)
    return issue


def unblock_issue(store: StateStore, issue_id: str, *, by: str = "local_user", note: str = "") -> Issue:
    """Return a blocked issue to the claimable queue and wake its assignee."""
    issue = store.get_issue(issue_id)
    if issue.status != IssueStatus.BLOCKED.value:
        raise ValueError(f"issue {issue_id} is not blocked (is {issue.status})")
    issue.status = IssueStatus.TODO.value
    issue.updated_at = time()
    store.save_issue(issue)
    # Defensive sweep: a lock this issue somehow still owns (legacy data, a
    # block that raced) would make every future checkout fail — clear it.
    store.release_workspace_lock(issue_release_key(issue, store=store), expected_issue_id=issue.issue_id)
    post_issue_comment(
        store,
        issue_id,
        body=f"[unblocked] {note}".strip(),
        author_type="system",
        author_id=by,
    )
    return issue


def find_issue_live_run(store: StateStore, issue: Issue) -> str | None:
    """The id of the issue's currently-live run, or None if no run is executing.

    Robust against the daemon's checkout window: a fresh checkout first writes its
    ``wakeup_id`` as the checkout token and only later anchors the REAL ``run_id``
    onto ``execution_run_id`` (``daemon.anchor_run_on_issue``). So:

      * ``execution_run_id`` (the anchored live run) is authoritative when present
        and still non-terminal;
      * otherwise, in the pre-anchor window, the live run is the one the daemon
        stamped with this issue's checkout ``wakeup_id`` in its
        ``execution_context`` (mirrors ``daemon._find_run_for_wakeup``) — found by
        scanning for a non-terminal run carrying that wakeup id.

    Returns None when nothing is executing (a genuine "claimed but no run" — the
    recovery case ``abort_checkout`` is for). Never returns a checkout TOKEN
    (wakeup id) as if it were a run id."""
    exec_run = getattr(issue, "execution_run_id", None)
    if isinstance(exec_run, str) and exec_run:
        try:
            session = store.get_run(exec_run)
        except KeyError:
            session = None
        if session is not None and session.status not in TERMINAL_RUN_STATUSES:
            return exec_run
    token = getattr(issue, "checkout_run_id", None)
    if isinstance(token, str) and token:
        # Newest-first (matches daemon._find_run_for_wakeup) so a (normally unique)
        # wakeup id that somehow maps to more than one live run resolves to the most
        # recent — deterministic regardless of list_runs() ordering.
        candidates = [
            session
            for session in store.list_runs()
            if session.status not in TERMINAL_RUN_STATUSES
            and (session.execution_context or {}).get("wakeup_id") == token
        ]
        if candidates:
            candidates.sort(key=lambda s: getattr(s, "created_at", 0.0) or 0.0, reverse=True)
            return candidates[0].run_id
    return None


def abort_checkout(store: StateStore, issue_id: str, *, holder: str | None = None) -> Issue:
    """Undo a checkout whose run never established: release lock, back to todo.

    Only legal while the issue is ``in_progress`` and still assigned; the lock
    release is conditioned on the lock belonging to THIS issue so a concurrent
    re-checkout is never clobbered. This is the recovery primitive for "claimed
    the workspace, then failed before any run existed" — real wreckage (a run
    that started and failed) should keep the lock for inspection instead.
    """
    issue = store.get_issue(issue_id)
    if issue.status != IssueStatus.IN_PROGRESS.value:
        raise ValueError(f"issue {issue_id} is not in_progress (is {issue.status})")
    lock_holder = holder or issue.assignee_agent_profile_id
    release_key = issue_release_key(issue, store=store)
    issue.status = IssueStatus.TODO.value
    issue.checkout_run_id = None
    issue.execution_run_id = None
    issue.lock_key = None
    issue.updated_at = time()
    store.save_issue(issue)
    store.release_workspace_lock(
        release_key, holder=lock_holder, expected_issue_id=issue.issue_id
    )
    return issue


def _auto_complete_no_gate_issue(
    store: StateStore,
    issue: Issue,
    *,
    requested_by: str | None,
    summary: str,
    expected_checkout_run_id: str | None,
) -> Issue:
    """Close a ``no_completion_gate`` issue with no human and no approval.

    The atomic close FIRST (``auto_complete_issue`` does the claim/hold CAS and
    releases the lock in one transaction). Only AFTER it commits do we write the
    audit — the system completion interaction on the child, the child-done
    flow-back on the parent, and the parent wakeup. So if the close is refused
    (held / claim changed) nothing is recorded: no phantom completion, no parent
    pending-fact for work that never finished. The save_issue parent guard ensures
    this issue has a real in-scope parent, so it can never close a root delivery.
    """
    author = requested_by or issue.assignee_agent_profile_id or "kernel"
    release_key = issue_release_key(issue, store=store)
    child_run_id = issue.execution_run_id  # capture before the clear below (§2.7② pointers)
    issue.status = IssueStatus.DONE.value
    issue.execution_run_id = None
    issue.lock_key = None
    issue.updated_at = time()
    store.auto_complete_issue(
        issue, release_lock_key=release_key, expected_checkout_run_id=expected_checkout_run_id
    )
    # Post-success audit (recoverable facts; the done flip above is the durable one).
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            kind=IssueInteractionKind.COMPLETION.value,
            status="resolved",
            created_by_type="system",
            created_by_id=author,
            payload={"review_policy": issue.review_policy, "note": summary or ""},
        )
    )
    _record_child_done_on_parent(store, issue, decided_by=author, child_run_id=child_run_id)
    _wake_parent_on_child_done(store, issue)
    return issue


def submit_for_review(
    store: StateStore,
    issue_id: str,
    *,
    requested_by: str | None = None,
    summary: str = "",
    expected_checkout_run_id: str | None = None,
) -> tuple[Issue, Approval | None]:
    """Move an in-progress issue to ``in_review`` and open a completion approval.

    This is the bridge from agent work to the human gate: the agent cannot mark
    its own work ``done``; it can only request review. The one exception is a
    ``no_completion_gate`` issue (machine sub-work): there is no human gate, so the
    kernel auto-completes it and returns ``(issue, None)`` — no approval is opened.
    """
    issue = store.get_issue(issue_id)
    # Hold freezes governance progress: a held issue must not advance to review,
    # even if a run that was in flight when the hold landed has since completed.
    # A hold can be placed AFTER checkout (the issue status stays in_progress, so
    # the anchor CAS does not catch it) — this is the gate that does.
    if store.issue_is_held(issue_id):
        raise IssueHeldError(
            f"issue {issue_id} is on hold; release the hold before requesting review"
        )
    if issue.status != IssueStatus.IN_PROGRESS.value:
        raise ValueError(
            f"issue {issue_id} must be in_progress to request review (is {issue.status})"
        )
    # no_completion_gate: machine sub-work closes without a human gate or approval.
    if issue.review_policy == ReviewPolicy.NO_COMPLETION_GATE.value:
        completed = _auto_complete_no_gate_issue(
            store,
            issue,
            requested_by=requested_by,
            summary=summary,
            expected_checkout_run_id=expected_checkout_run_id,
        )
        return completed, None
    issue.status = IssueStatus.IN_REVIEW.value
    issue.updated_at = time()
    approval = Approval(
        type=ApprovalType.ISSUE_COMPLETION.value,
        issue_id=issue.issue_id,
        workspace_id=issue.workspace_id,
        requested_by=requested_by or issue.assignee_agent_profile_id or "local_user",
        requested_permission={"action": "complete_issue", "issue_id": issue.issue_id},
        affects={
            "issue_id": issue.issue_id,
            "run_id": issue.execution_run_id,
            "workspace_id": issue.workspace_id,
            "assignee_agent_profile_id": issue.assignee_agent_profile_id,
        },
        resume_action={"kernel": "issue.complete", "issue_id": issue.issue_id},
        decision_note=summary or None,
    )
    # Resume, don't duplicate: if this issue already has a completion approval the
    # reviewer sent back for revision, the agent's re-submit reopens THAT approval
    # (revision_requested -> pending) by carrying its id, so the inbox shows one
    # tracked item across the revise/resubmit loop, not a fresh pile.
    for existing in store.list_approvals(status=ApprovalStatus.REVISION_REQUESTED.value):
        if existing.issue_id == issue.issue_id and existing.type == ApprovalType.ISSUE_COMPLETION.value:
            approval.approval_id = existing.approval_id
            approval.created_at = existing.created_at
            break
    # One transaction: the issue flip and the approval commit together (so a
    # crash can never strand the issue in_review with no approval to grant) AND
    # the flip is bound to the claim token, so a requeue + re-checkout that
    # lands between anchor and submit cannot submit someone else's new claim.
    store.submit_issue_for_review(issue, approval, expected_checkout_run_id=expected_checkout_run_id)
    return issue, approval


# Whitelisted fields a hire request may set on the new role (the create-time
# surface). name + role are required; the rest mirror create-profile.
_HIRE_SPEC_FIELDS = (
    "name",
    "role",
    "title",
    "workspace_id",
    "company_profile_id",
    "backend_policy",
    "model",
    "effort",
    "permission_policy",
    "plugin_allowlist",
    "skill_allowlist",
    "budget_seconds",
    "token_budget",
    "context_mode",
    "reports_to",
    "runtime_config",
    "persona",
    "charter",
    "default_instructions",
)


def request_agent_config_change(
    store: StateStore,
    *,
    target_profile_id: str,
    patch: dict[str, Any],
    requested_by: str,
    note: str | None = None,
) -> Approval:
    """Open a human-gated approval for an agent to reconfigure a role.

    The agent-facing half of config editing: a running agent can *request* a
    change to its own or another role's config, but the kernel NEVER applies it
    here. It checks the target exists and the patch is well-formed against the
    same whitelist :func:`update_agent_profile` uses (fast feedback), then records
    a PENDING approval. A human grant — the same gate that ships issues — is what
    applies it, through ``update_agent_profile``, so every authoritative gate
    (permission, reports_to acyclicity, governance scope, skill projection) still
    runs at apply time. Mirrors Paperclip's approval-gated org changes.
    """
    target = store.get_agent_profile(target_profile_id)  # KeyError -> unknown
    if not patch:
        raise ValueError("empty patch: pass at least one field to change")
    unknown = [k for k in patch if k not in EDITABLE_PROFILE_FIELDS]
    if unknown:
        raise ValueError(
            f"fields not editable: {sorted(unknown)} "
            "(charter and workspace/company/ids cannot be changed this way)"
        )
    approval = Approval(
        type=ApprovalType.AGENT_CONFIG_CHANGE.value,
        workspace_id=target.workspace_id,
        requested_by=requested_by,
        requested_permission={"action": "update_agent_profile", "profile_id": target_profile_id},
        # Issue-less approval: scope it to the target role's company so it lands in
        # that company's message-center inbox (the company/workspace fields are not
        # editable here, so this attribution is stable for the approval's lifetime).
        affects={
            "company_profile_id": target.company_profile_id,
            "profile_id": target_profile_id,
            "patch": dict(patch),
        },
        resume_action={
            "kernel": "agent.update_profile",
            "profile_id": target_profile_id,
            "patch": dict(patch),
        },
        decision_note=note,
    )
    store.save_approval(approval)
    return approval


def _validate_hire_spec(spec: dict[str, Any]) -> None:
    """Validate a hire spec's shape — the SINGLE definition of a valid spec.

    Reused by every path that consumes a hire spec (``request_hire``'s up-front
    check and the direct ``create_agent_from_spec`` creation point) so the rules
    — only whitelisted fields, ``name`` + ``role`` required, a kernel-gated
    permission mode — can never diverge between the approval flow and the direct
    creation flow.
    """
    unknown = [k for k in spec if k not in _HIRE_SPEC_FIELDS]
    if unknown:
        raise ValueError(f"unknown hire spec fields: {sorted(unknown)}")
    if not spec.get("name") or not spec.get("role"):
        raise ValueError("hire spec requires at least name and role")
    # The kernel — not just the CLI — gates the permission mode, so a direct call
    # cannot store an illegal policy that save_agent_profile would not catch.
    _validate_permission_policy(spec.get("permission_policy"))


def create_agent_from_spec(
    store: StateStore, spec: dict[str, Any], *, requested_by: str
) -> AgentProfile:
    """Validate a hire spec and create + persist the agent profile — single point.

    The ONE place a hire spec becomes a saved :class:`AgentProfile`. Both the
    approval-grant path (``_apply_agent_approval``'s ``agent.hire`` branch, the
    actor-requests-a-hire flow that waits for a human grant) and the direct
    user-triggered hire (``company_handler``'s LOW path, where the re-ratified
    threat model lets a user-triggered hire run straight through) call this, so
    the two flows cannot drift in how they validate or construct the profile.

    Validation matches ``request_hire`` (whitelisted fields, name + role
    required, kernel-gated permission mode). The governance-scope assertion runs
    inside ``store.save_agent_profile``. ``requested_by`` is accepted for call-site
    symmetry / future provenance; the profile shape is derived solely from the
    whitelisted spec fields.
    """
    _validate_hire_spec(spec)
    # Max-permission doctrine: a hire confirmed to land in a real (kernel-governed)
    # company defaults to bypassPermissions when the spec sets NO explicit policy, so a
    # newly hired company agent can actually act (run tools, deliver) rather than being
    # stuck on the read-only ``plan`` floor. An explicit spec policy still wins
    # (a deliberately read-only role stays read-only). A non-company / unknown-company
    # hire is unaffected — it keeps the fail-closed floor.
    spec = dict(spec)
    if not spec.get("permission_policy") and _is_governed_company_id(
        store, spec.get("company_profile_id")
    ):
        spec["permission_policy"] = default_company_runtime_policy()
    profile = AgentProfile(**{k: v for k, v in spec.items() if k in _HIRE_SPEC_FIELDS})
    return store.save_agent_profile(profile)


def request_hire(
    store: StateStore,
    *,
    spec: dict[str, Any],
    requested_by: str,
    note: str | None = None,
) -> Approval:
    """Open a human-gated approval for an agent to hire (create) a new role.

    Fail-closed: records a PENDING approval; the new profile is created only when
    a human grants it (via the same gate). Validates the spec shape up front
    (name + role required, no unknown fields); the governance-scope assertion
    runs when the profile is actually saved at grant time.
    """
    _validate_hire_spec(spec)
    approval = Approval(
        type=ApprovalType.AGENT_HIRE.value,
        workspace_id=spec.get("workspace_id", "local"),
        requested_by=requested_by,
        requested_permission={"action": "hire_agent", "role": spec.get("role")},
        # Top-level affects.company_profile_id is the message-center / approval-scope
        # attribution key for an issue-less approval (this hire creates no issue yet).
        # The hire spec's company_profile_id is the company the new role lands in, so
        # the request belongs to that company's inbox. Defaults to the "local" home
        # company when the spec omits it (matching AgentProfile's default), never
        # guessed. The full spec is still carried for the grant-time create.
        affects={
            "company_profile_id": spec.get("company_profile_id", "local"),
            "spec": dict(spec),
        },
        resume_action={"kernel": "agent.hire", "spec": dict(spec)},
        decision_note=note,
    )
    store.save_approval(approval)
    return approval


def _apply_agent_approval(store: StateStore, approval: Approval) -> None:
    """Apply an approved organizational approval (config change / hire).

    Raises on failure so the caller leaves the approval PENDING (re-decidable)
    instead of recording a grant whose effect never landed.
    """
    action = approval.resume_action or {}
    kernel = action.get("kernel")
    if kernel == "agent.update_profile":
        update_agent_profile(store, action["profile_id"], patch=dict(action.get("patch") or {}))
    elif kernel == "agent.hire":
        # Single creation point shared with the direct user-triggered hire
        # (company_handler LOW path): re-validate the persisted spec and create.
        create_agent_from_spec(
            store, dict(action.get("spec") or {}), requested_by=approval.requested_by
        )
    elif kernel == "team.bootstrap.commit":
        from pathlib import Path

        from superclaw.team_bootstrap import (
            BootstrapCommitError,
            _claims_company_source,
            apply_bootstrap_commit_payload,
        )

        # The local-opt-in decision AND the revocation source were captured into this
        # approval's resume_action by the TRUSTED server-side commit path that created
        # the approval (not from a caller-supplied commit payload). Honor them on grant
        # so a --trust local company that parked at a human approval can be materialized
        # and the resume re-verify reads the SAME revocation list used at proposal time
        # (closing the approval-resume revocation TOCTOU). Absent the opt-in, fail-closed.
        revocation_ref = action.get("company_revocation_file")
        proposal_payload = dict(action.get("proposal") or {})
        # Defense in depth: the trusted commit path now persists a CONCRETE resolved
        # revocation path for every approval. A missing/None source on a COMPANY proposal
        # therefore means a legacy/malformed approval whose source we cannot trust — and
        # the default is a runtime resolver that could drift to a different revocation list
        # than the proposal used. Fail closed (leave the approval PENDING) and require it
        # to be re-created so it binds a concrete source. Non-company bootstraps never read
        # the revocation file, so a missing source there is harmless.
        if not revocation_ref and _claims_company_source(proposal_payload):
            raise BootstrapCommitError(
                "company bootstrap approval is missing a bound revocation source; "
                "re-create the approval so the grant re-verifies against the same "
                "revocation list used at proposal time (fail-closed)"
            )
        apply_bootstrap_commit_payload(
            store,
            proposal_payload,
            allow_local_opt_in=bool(action.get("allow_local_opt_in")),
            company_revocation_file=Path(str(revocation_ref)) if revocation_ref else None,
        )
    elif kernel == "company.command":
        # A granted chat-driven company-management command. The handler re-runs
        # the hard scope + company-active gates (TOCTOU defence) against the
        # ORIGINAL actor scope persisted in the approval, then dispatches it
        # through the SAME execution point the LOW path uses. Imported lazily to
        # avoid an import cycle (company_handler imports the risk gate / state /
        # this module).
        from superclaw.company_handler import apply_company_command

        apply_company_command(store, action, approval_id=approval.approval_id)
    elif kernel == "marketplace.command":
        # A granted chat/CLI/API-driven ClawHunt marketplace command. The handler
        # re-runs validate + auth + scope (TOCTOU / tamper defence) against the
        # ORIGINAL actor scope, then performs the remote ClawHunt action and
        # advances the marketplace order ledger. This is the ONLY place a
        # marketplace write hits the wire — payment/commitment never runs on the
        # default path (项目铁律). Imported lazily (the handler imports state /
        # clawhunt / this module).
        from superclaw.marketplace_handler import apply_marketplace_command

        apply_marketplace_command(store, action, approval_id=approval.approval_id)
    else:
        raise ValueError(f"approval {approval.approval_id} has no applicable resume action")


def _restore_company_on_archive_reject(store: StateStore, approval: Approval) -> None:
    """Phase 2b: unfreeze a company whose archive approval was rejected.

    A two-phase archive freezes its company at REQUEST time. If the human rejects
    the archive, the company must return to ACTIVE — otherwise a declined archive
    would leave the company permanently frozen (unable to host new work) with no
    pending approval to drive it forward. Only fires for a company.command archive
    approval; ``restore_company_from_freeze`` is idempotent (a no-op on an
    already-active company), so a duplicate/raced reject converges safely.

    Best-effort and fail-soft: the rejection itself is already durable, so a
    restore failure (e.g. company concurrently dissolved) must not turn a clean
    reject into an exception. A genuinely-corrupt state is left for an operator.
    """
    from superclaw.company_commands import CompanyArchiveCommand

    action = approval.resume_action or {}
    if action.get("kernel") != "company.command":
        return
    if action.get("command_type") != CompanyArchiveCommand.command_type:
        return
    command = action.get("command")
    company_id = command.get("company_profile_id") if isinstance(command, dict) else None
    if not isinstance(company_id, str) or not company_id:
        return
    from superclaw.company_lifecycle import (
        CompanyFrozenError,
        restore_company_from_freeze,
    )

    try:
        restore_company_from_freeze(store, company_id)
    except (KeyError, CompanyFrozenError):
        # Company vanished or is no longer freeze-restorable (e.g. already
        # dissolved by a racing grant). The reject is still valid; leave the
        # anomalous lifecycle state for an operator rather than 500-ing.
        return


def _authorize_completion_decision(
    store: StateStore,
    issue: Issue,
    *,
    decided_by_type: str,
    deciding_agent_profile_id: str | None,
    deciding_run_id: str | None,
) -> None:
    """Fail-closed gate: may this actor decide THIS issue's completion approval?

    The completion gate the execution plan reserves: a human may always decide
    (the universal "对外人审" boundary). An ``agent`` decision — an autonomous
    close with no human — is honoured ONLY when the issue's ``review_policy`` is
    ``parent_accept`` AND the deciding agent is the *live* owner of the issue's
    direct parent. Everything else (``human_final`` / ``qa_accept`` /
    ``no_completion_gate`` decided by an agent, a stale run, a non-parent agent,
    a held or finished parent) raises — the kernel never trusts a surface-supplied
    capability label, so an unauthorized caller cannot forge a final ``done``.
    """
    if decided_by_type not in DECIDER_TYPES:
        raise ValueError(
            f"invalid decided_by_type {decided_by_type!r} (one of {sorted(DECIDER_TYPES)})"
        )
    if decided_by_type == DeciderType.HUMAN.value:
        return  # a person is the universal completion authority

    # decided_by_type == agent from here: only parent_accept is agent-closeable.
    if issue.review_policy != ReviewPolicy.PARENT_ACCEPT.value:
        raise ValueError(
            f"agent may not decide completion of a {issue.review_policy!r} issue "
            "(only parent_accept closes without a human)"
        )
    if not deciding_agent_profile_id or not deciding_run_id:
        raise ValueError(
            "agent completion decision requires deciding_agent_profile_id and deciding_run_id"
        )
    if store.issue_is_held(issue.issue_id):
        raise ValueError(f"issue {issue.issue_id} is on hold; an agent may not close a held issue")
    if not issue.parent_id:
        raise ValueError("parent_accept issue has no parent to authorize its completion")
    try:
        parent = store.get_issue(issue.parent_id)
    except KeyError as exc:
        raise ValueError(f"parent issue {issue.parent_id} not found") from exc
    # The parent must be ACTIVELY worked (in_progress), not merely non-terminal: a
    # parent that has itself moved to in_review/done still carries its checkout
    # token, so "non-terminal + token match" would let a stale run through. Requiring
    # in_progress is the tighter live-work proof (re-checked in the write txn).
    if parent.status != IssueStatus.IN_PROGRESS.value:
        raise ValueError(
            f"parent issue {parent.issue_id} is {parent.status}, not in_progress; "
            "an agent may only accept a child while actively working the parent"
        )
    if store.issue_is_held(parent.issue_id):
        raise ValueError(f"parent issue {parent.issue_id} is on hold; cannot accept a child")
    # Authority follows the CURRENT assignee, and binds to the parent's LIVE
    # ownership run (checkout_run_id) — not just the profile. A stale/preempted run
    # whose profile is still the assignee cannot authorize the close (zombie-run
    # bypass): only the run that currently holds the parent's checkout may.
    if deciding_agent_profile_id != parent.assignee_agent_profile_id:
        raise ValueError(
            "only the parent issue's current assignee may accept this child"
        )
    if not parent.checkout_run_id or deciding_run_id != parent.checkout_run_id:
        raise ValueError(
            "agent completion decision must come from the run that currently holds "
            "the parent's checkout (stale run rejected)"
        )


def _record_child_done_on_parent(
    store: StateStore, child: Issue, *, decided_by: str, child_run_id: str | None = None
) -> None:
    """Write the child-done flow-back on the PARENT: a best-effort ``[child done]``
    comment plus a durable PENDING completion interaction the parent's
    manager-continuation pass consumes. With no parent assignee it escalates to the
    board instead of waking nobody. No-op when the child has no resolvable parent.
    Shared by the human-approval close, the agent parent_accept close and the
    no_completion_gate auto-close so all three notify the delegator identically.

    ``child_run_id`` is the child's execution run id captured by the caller BEFORE
    the completion flow clears ``child.execution_run_id`` (it is reset to None on
    the agent/auto-close paths before this runs); pass it so the §2.7② context
    pointers survive. Falls back to ``child.execution_run_id`` for the pre-flip
    human path where the field is still populated."""
    if not child.parent_id:
        return
    try:
        parent = store.get_issue(child.parent_id)
    except KeyError:
        return
    try:
        post_issue_comment(
            store,
            parent.issue_id,
            body=f"[child done] {child.title} ({child.issue_id}) completed.",
            author_type="system",
            author_id=decided_by,
            wake_assignee=False,  # the explicit child_done wakeup is the continuation
        )
    except Exception:  # pragma: no cover - comment is best-effort
        pass
    # Carry the child's changed-file pointers (captured on its run evidence) into
    # the parent's notification so the parent can integrate incrementally (§2.7 ②).
    # Best-effort — never block the completion handoff on a missing/unreadable row.
    completion_payload: dict[str, Any] = {
        "child_issue_id": child.issue_id,
        "child_title": child.title,
    }
    run_id = child_run_id or child.execution_run_id
    if run_id:
        try:
            child_ev = store.get_evidence(run_id)
            child_pointers = (child_ev.backend_summary or {}).get("context_pointers")
        except (KeyError, ValueError, TypeError):
            child_pointers = None
        if child_pointers is not None:
            completion_payload["context_pointers"] = child_pointers
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=parent.issue_id,
            company_profile_id=parent.company_profile_id,
            kind=IssueInteractionKind.COMPLETION.value,
            continuation_policy=(
                ContinuationPolicy.NOTIFY_PARENT.value
                if parent.assignee_agent_profile_id
                else ContinuationPolicy.ESCALATE_TO_BOARD.value
            ),
            status="pending",
            target_agent_profile_id=parent.assignee_agent_profile_id,
            created_by_type="system",
            created_by_id=decided_by,
            payload=completion_payload,
        )
    )


def _wake_parent_on_child_done(store: StateStore, child: Issue) -> None:
    """Post-flip continuation: wake the parent's assignee so its manager loop
    resumes with the finished child. Best-effort — the durable pending interaction
    (written pre-flip) + the parent's next timer heartbeat recover a lost wakeup.
    No-op when the parent is unresolvable or has no assignee."""
    if not child.parent_id:
        return
    try:
        parent = store.get_issue(child.parent_id)
    except KeyError:
        return
    if not parent.assignee_agent_profile_id:
        return
    try:
        parent_assignee = store.get_agent_profile(parent.assignee_agent_profile_id)
    except KeyError:
        return
    _wake_agent(
        store,
        parent_assignee,
        source=WakeupSource.AUTOMATION.value,
        reason=f"child_done:{child.issue_id}",
        snapshot={"issue_id": parent.issue_id, "child_issue_id": child.issue_id},
    )


def decide_approval(
    store: StateStore,
    approval_id: str,
    *,
    approved: bool,
    decided_by: str = "local_user",
    decided_by_type: str = DeciderType.HUMAN.value,
    deciding_agent_profile_id: str | None = None,
    deciding_run_id: str | None = None,
    note: str | None = None,
) -> tuple[Approval, Issue | None]:
    """Decide a completion approval and apply its kernel resume action.

    Approve: the linked issue moves ``in_review`` -> ``done`` and its workspace
    lock is released. Reject: the issue returns to ``in_progress`` for another
    pass and the approval is marked ``rejected``. Fail-closed: a non-pending
    approval cannot be re-decided.

    ``decided_by_type`` defaults to ``human`` (every CLI/API decision is a human
    grant — the surfaces never pass ``agent``). An ``agent`` decision is only
    reachable through internal kernel/daemon callers that derive the deciding
    agent/run from a trusted execution context, and is authorized by
    :func:`_authorize_completion_decision`.
    """
    approval = store.get_approval(approval_id)
    target = ApprovalStatus.APPROVED.value if approved else ApprovalStatus.REJECTED.value
    if not is_valid_approval_status_transition(approval.status, target):
        raise ValueError(
            f"approval {approval_id} cannot move {approval.status} -> {target}"
        )

    # Crash-ordering: thread artifacts are written while the approval is still
    # PENDING, then the core state (issue + approval + lock release) flips in
    # ONE transaction. A crash before the flip leaves a re-decidable pending
    # approval (worst case: a duplicate comment on retry); a crash can never
    # leave a decided approval whose issue/lock/thread disagree with it.
    issue: Issue | None = None
    # Audit honesty: an agent-driven decision must be recorded as authored by an
    # agent, never silently as "user" (otherwise the thread lies about who closed
    # the work). Human is the default for every CLI/API decision.
    decider_author_type = "agent" if decided_by_type == DeciderType.AGENT.value else "user"
    if approval.issue_id:
        issue = store.get_issue(approval.issue_id)
        # Capture the child's run id now: the agent path's apply transaction clears
        # issue.execution_run_id before the deferred audit runs, so the §2.7②
        # context pointers would otherwise be lost on that path.
        child_run_id = issue.execution_run_id
        # Completion is the protected boundary: gate WHO may decide it before any
        # state moves. A human is the universal authority; an agent is honoured
        # only for an authorized parent_accept close (fail-closed otherwise).
        is_completion = approval.type == ApprovalType.ISSUE_COMPLETION.value
        if is_completion:
            _authorize_completion_decision(
                store,
                issue,
                decided_by_type=decided_by_type,
                deciding_agent_profile_id=deciding_agent_profile_id,
                deciding_run_id=deciding_run_id,
            )

        # Thread audit for the decision. For a HUMAN decision it is written pre-flip
        # (the approval is still pending, so a crash here is re-decidable and the
        # flow-back can never be silently lost — the established crash-safe order).
        # For an AGENT decision the authoritative authz runs INSIDE the apply
        # transaction and may roll the close back, so the audit must wait until AFTER
        # apply succeeds — otherwise a raced rejection would leave a phantom "done"
        # record. ``_emit_decision_audit`` is therefore called at the right time below.
        def _emit_decision_audit() -> None:
            if not approved:
                comment, _ = post_issue_comment(
                    store,
                    issue.issue_id,
                    body=f"[review rejected] {note or 'sent back for rework'}",
                    author_type=decider_author_type,
                    author_id=decided_by,
                )
                store.save_issue_interaction(
                    IssueThreadInteraction(
                        issue_id=issue.issue_id,
                        company_profile_id=issue.company_profile_id,
                        kind=IssueInteractionKind.QA_REJECTION.value,
                        continuation_policy=ContinuationPolicy.WAKE_ASSIGNEE.value,
                        target_agent_profile_id=issue.assignee_agent_profile_id,
                        source_comment_id=comment.comment_id,
                        created_by_type=decider_author_type,
                        created_by_id=decided_by,
                        payload={"approval_id": approval.approval_id, "reason": note or ""},
                    )
                )
            else:
                store.save_issue_interaction(
                    IssueThreadInteraction(
                        issue_id=issue.issue_id,
                        company_profile_id=issue.company_profile_id,
                        kind=IssueInteractionKind.COMPLETION.value,
                        status="resolved",
                        created_by_type=decider_author_type,
                        created_by_id=decided_by,
                        payload={"approval_id": approval.approval_id, "note": note or ""},
                    )
                )
                _record_child_done_on_parent(
                    store, issue, decided_by=decided_by, child_run_id=child_run_id
                )

        audit_after_flip = is_completion and decided_by_type == DeciderType.AGENT.value
        if not audit_after_flip:
            _emit_decision_audit()

    # For a non-issue approval being granted, apply the resume action FIRST —
    # before any decision state is set — so an unrecognized or failing apply
    # aborts cleanly (the approval stays pending, re-decidable) instead of being
    # recorded as approved with no effect. _apply_agent_approval raises on an
    # unknown/missing action, so a non-issue grant can never resolve to a no-op.
    if issue is None and approved:
        _apply_agent_approval(store, approval)

    approval.status = target
    approval.decided_by = decided_by
    approval.decided_by_type = decided_by_type
    approval.deciding_agent_profile_id = (
        deciding_agent_profile_id if decided_by_type == DeciderType.AGENT.value else None
    )
    approval.decided_at = time()
    if note is not None:
        approval.decision_note = note

    if issue is not None:
        release_key: str | None = None
        if approved:
            issue.status = IssueStatus.DONE.value
            issue.execution_run_id = None
            # The lock release rides the SAME transaction, conditioned on the
            # lock still belonging to this issue — a done issue can never be
            # left holding its workspace. Always the PINNED key.
            release_key = issue_release_key(issue, store=store)
            issue.lock_key = None
        else:
            # Reject sends the work back for another pass (claim + lock stay).
            issue.status = IssueStatus.IN_PROGRESS.value
        issue.updated_at = time()
        # For an agent decision the authorization is re-validated INSIDE the write
        # transaction (authoritative gate): the pre-check above is a fast fail, but a
        # hold / re-assignment / parent-finish that races the commit must still roll
        # it back. Human decisions are not run-bound (the person is the override).
        require_agent_authz = (
            (deciding_agent_profile_id, deciding_run_id)
            if decided_by_type == DeciderType.AGENT.value
            and approval.type == ApprovalType.ISSUE_COMPLETION.value
            and deciding_agent_profile_id
            and deciding_run_id
            else None
        )
        store.apply_approval_decision(
            issue, approval, release_lock_key=release_key, require_agent_authz=require_agent_authz
        )
        # Agent decision: the audit was deferred until the authoritative in-txn authz
        # passed, so write it now (no phantom record if the close was rolled back).
        if audit_after_flip:
            _emit_decision_audit()
    else:
        # The non-issue grant was already applied above (before any decision
        # state was set); here we only persist the decision.
        store.save_approval(approval)
        # Phase 2b of the two-phase archive (contract E): a REJECTED archive must
        # unfreeze the company it froze at request time, so a declined archive
        # resumes normal work. Done AFTER the approval is durably rejected so a
        # crash can never leave an active company with a still-pending archive.
        # Idempotent + scoped to the archive command only (restore is a no-op on
        # an already-active company).
        if not approved:
            _restore_company_on_archive_reject(store, approval)
            # A rejected marketplace command settles its ledger order: a declined
            # CLAIM frees the reserved (base_url, problem_id) slot; a declined
            # SUBMIT re-arms the order to ready_to_submit. Best-effort + fail-soft
            # (the rejection is already durable) — same posture as the archive
            # restore above. Only fires for a marketplace.command approval.
            from superclaw.marketplace_handler import free_marketplace_order_on_reject

            free_marketplace_order_on_reject(store, approval)

    # Post-flip continuation: wake the delegator (the durable pending
    # completion interaction was written pre-flip; a lost wakeup is recovered
    # by the parent's next timer heartbeat).
    if issue is not None and approved:
        _wake_parent_on_child_done(store, issue)

    # Post-flip continuation: the rework wakeup. Best-effort — if it is lost,
    # the pending qa_rejection + the assignee's next timer heartbeat recover
    # the loop (the interaction, written pre-flip, is the durable fact).
    if issue is not None and not approved and issue.assignee_agent_profile_id:
        try:
            assignee = store.get_agent_profile(issue.assignee_agent_profile_id)
        except KeyError:
            assignee = None
        if assignee is not None:
            _wake_agent(
                store,
                assignee,
                source=WakeupSource.AUTOMATION.value,
                reason=f"qa_rejection:{issue.issue_id}",
                snapshot={
                    "issue_id": issue.issue_id,
                    "approval_id": approval.approval_id,
                    "rejection_note": note or "",
                },
            )

    # NOTE (PR-5 scope): waking the REQUESTING agent to *resume its blocked issue*
    # after a granted organizational approval (an autonomous agent's hire) is NOT
    # wired here. That loop only closes if the requester's originating issue is
    # still claimable rework on grant — which requires the hire-requesting run to
    # park the issue (``WAITING_FOR_HUMAN_GATE``) instead of completing it, plus an
    # origin-issue → continuation link. A bare wake-the-requester here would be a
    # hollow no-op (its issue is already in_review/done, so the daemon idles), so
    # it is deliberately omitted rather than faked. Tracked as the "blocked-
    # dependency autonomous resume" follow-up. Today the loop is carried across the
    # completion-review gate by the existing qa_rejection continuation (rework),
    # and the hire's NEW agent is woken when work is delegated/assigned to it.
    return approval, issue


def request_revision(
    store: StateStore,
    approval_id: str,
    *,
    note: str | None = None,
    requested_by: str = "local_user",
) -> tuple[Approval, Issue | None]:
    """Send a pending completion approval back for revision (NON-terminal).

    Unlike reject (terminal), this keeps the approval open as
    ``revision_requested``: the linked issue returns to ``in_progress`` for
    another pass (the claim + lock stay), the assignee is woken with the
    revision note, and the agent's next ``submit_for_review`` resumes the SAME
    approval instead of opening a duplicate. Fail-closed: only a pending
    approval can be sent for revision.
    """
    approval = store.get_approval(approval_id)
    target = ApprovalStatus.REVISION_REQUESTED.value
    if not is_valid_approval_status_transition(approval.status, target):
        raise ValueError(f"approval {approval_id} cannot move {approval.status} -> {target}")
    # Revision is a COMPLETION-review semantic — it bounces an issue back for
    # rework. Narrow it here (kernel), not just the surface: a hire/config/permission
    # approval has no rework loop, so it must never enter revision_requested.
    if approval.type != ApprovalType.ISSUE_COMPLETION.value:
        raise ValueError(
            f"approval {approval_id} is type {approval.type}, not an issue completion; "
            "only completion approvals can be sent for revision"
        )
    # A completion approval always carries its issue; a missing one is malformed
    # data, and "revise with nothing to rework" is meaningless — refuse it.
    if not approval.issue_id:
        raise ValueError(f"completion approval {approval_id} has no linked issue to revise")

    issue: Issue | None = None
    if approval.issue_id:
        issue = store.get_issue(approval.issue_id)
        # Validate the issue is actually under review BEFORE writing any thread
        # artifact, so a state mismatch fails closed without leaving a dirty
        # comment/interaction behind.
        if issue.status != IssueStatus.IN_REVIEW.value:
            raise ValueError(
                f"issue {issue.issue_id} is {issue.status}, not in_review; cannot request revision"
            )
        # Same rework channel as reject (wake the assignee with the note), but the
        # interaction is tagged ``revision`` so the thread reads as "please revise"
        # rather than a terminal rejection.
        comment, _ = post_issue_comment(
            store,
            issue.issue_id,
            body=f"[revision requested] {note or 'please revise and resubmit'}",
            author_type="user",
            author_id=requested_by,
        )
        store.save_issue_interaction(
            IssueThreadInteraction(
                issue_id=issue.issue_id,
                company_profile_id=issue.company_profile_id,
                kind=IssueInteractionKind.QA_REJECTION.value,
                continuation_policy=ContinuationPolicy.WAKE_ASSIGNEE.value,
                target_agent_profile_id=issue.assignee_agent_profile_id,
                source_comment_id=comment.comment_id,
                created_by_type="user",
                created_by_id=requested_by,
                payload={"approval_id": approval.approval_id, "reason": note or "", "revision": True},
            )
        )

    # revision_requested is not terminal: record the note + who asked, but never
    # stamp decided_at (the approval can still be approved/rejected later).
    approval.status = target
    if note is not None:
        approval.decision_note = note

    if issue is not None:
        issue.status = IssueStatus.IN_PROGRESS.value
        issue.updated_at = time()
        store.apply_approval_decision(issue, approval, release_lock_key=None)
    else:
        store.save_approval(approval)

    if issue is not None and issue.assignee_agent_profile_id:
        try:
            assignee = store.get_agent_profile(issue.assignee_agent_profile_id)
        except KeyError:
            assignee = None
        if assignee is not None:
            _wake_agent(
                store,
                assignee,
                source=WakeupSource.AUTOMATION.value,
                reason=f"revision_requested:{issue.issue_id}",
                snapshot={
                    "issue_id": issue.issue_id,
                    "approval_id": approval.approval_id,
                    "revision_note": note or "",
                },
            )
    return approval, issue


# --- Work products: structured delivery facts attached to an issue ----------


def attach_work_product(
    store: StateStore,
    issue_id: str,
    *,
    type: str,
    title: str = "",
    url: str | None = None,
    provider: str = "local",
    external_id: str | None = None,
    status: str | None = None,
    summary: str = "",
    is_primary: bool = False,
    created_by_run_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> WorkProduct:
    """Attach a delivery fact (PR / commit / preview / artifact / …) to an issue.

    Fail-closed: the issue must exist, the type must be a known work-product
    type, and the company scope is taken from the ISSUE — never from the caller —
    so a delivery fact can never be filed under a company it does not belong to.
    Audit-only: attaching never moves the issue or touches the approval gate.
    """
    issue = store.get_issue(issue_id)  # KeyError if missing → fail-closed
    if type not in _WORK_PRODUCT_TYPES:
        raise ValueError(f"unknown work product type: {type!r}; one of {sorted(_WORK_PRODUCT_TYPES)}")
    effective_status = status if status is not None else WorkProduct.__dataclass_fields__["status"].default
    if effective_status not in _WORK_PRODUCT_STATUSES:
        raise ValueError(f"unknown work product status: {effective_status!r}; one of {sorted(_WORK_PRODUCT_STATUSES)}")
    wp = WorkProduct(
        issue_id=issue.issue_id,
        company_profile_id=issue.company_profile_id,  # scope from the issue, never the caller
        type=type,
        title=title,
        url=url,
        provider=provider,
        external_id=external_id,
        status=effective_status,
        summary=summary,
        is_primary=is_primary,
        created_by_run_id=created_by_run_id,
        metadata=dict(metadata or {}),
    )
    return store.save_work_product(wp)


def list_work_products(store: StateStore, issue_id: str) -> list[WorkProduct]:
    """The delivery ledger for an issue (primary first, then oldest-first).

    Fail-closed like every other issue-scoped read: the issue must exist
    (KeyError otherwise), and the company filter is taken from the ISSUE so the
    read can never surface another company's facts or an orphaned row.
    """
    issue = store.get_issue(issue_id)  # KeyError if missing → fail-closed (404 at the API)
    return store.list_work_products(issue_id=issue.issue_id, company_profile_id=issue.company_profile_id)


def update_work_product(
    store: StateStore,
    work_product_id: str,
    *,
    status: str | None = None,
    title: str | None = None,
    url: str | None = None,
    summary: str | None = None,
    is_primary: bool | None = None,
) -> WorkProduct:
    """Patch a delivery fact's mutable fields (status/title/url/summary/primary).
    Scope/issue/type/id are immutable; an unknown status fails closed. An update
    with no fields is rejected here (not at a surface) so the CLI and the API
    reject it identically — zero divergence."""
    if status is None and title is None and url is None and summary is None and is_primary is None:
        raise ValueError("no work product fields to update")
    wp = store.get_work_product(work_product_id)
    if status is not None:
        if status not in _WORK_PRODUCT_STATUSES:
            raise ValueError(f"unknown work product status: {status!r}; one of {sorted(_WORK_PRODUCT_STATUSES)}")
        wp.status = status
    if title is not None:
        wp.title = title
    if url is not None:
        wp.url = url
    if summary is not None:
        wp.summary = summary
    if is_primary is not None:
        wp.is_primary = is_primary
    wp.updated_at = time()
    return store.save_work_product(wp)


def remove_work_product(store: StateStore, work_product_id: str) -> bool:
    """Detach a delivery fact. Returns False if it was already gone."""
    return store.delete_work_product(work_product_id)


# One parent can break work into at most this many ACTIVE children (Paperclip's
# MAX_CHILD_ISSUES_CREATED_BY_HELPER): a runaway delegating agent must hit a
# wall before it floods the board. Finished/cancelled children free their slot.
MAX_CHILD_ISSUES_PER_PARENT = 25

# And a delegation chain can go at most this deep (parent → child → …): width
# alone does not stop an A→B→C→… relay (or an A↔B ping-pong of fresh issues)
# from burning budget forever.
MAX_DELEGATION_DEPTH = 8

# Depth × width caps still allow an exponential tree on paper, so the whole
# delegation TREE is also bounded by active (non-terminal) descendants. The
# budget hard stop is the money gate; this is the board-flooding gate.
MAX_ACTIVE_ISSUES_PER_TREE = 100


def _delegation_root(store: StateStore, issue: Issue, *, _max_walk: int = 64) -> Issue:
    """The root of an issue's delegation tree (cycle-safe)."""
    current = issue
    seen = {issue.issue_id}
    steps = 0
    while current.parent_id and steps < _max_walk:
        if current.parent_id in seen:
            break
        seen.add(current.parent_id)
        try:
            current = store.get_issue(current.parent_id)
        except KeyError:
            break
        steps += 1
    return current


def _active_tree_size(store: StateStore, root: Issue) -> int:
    """Active (non-terminal) issues in the tree rooted at ``root``."""
    issues = store.list_issues(company_profile_id=root.company_profile_id)
    children_of: dict[str, list[Issue]] = {}
    for candidate in issues:
        if candidate.parent_id:
            children_of.setdefault(candidate.parent_id, []).append(candidate)
    count = 0 if root.status in TERMINAL_ISSUE_STATUSES else 1
    frontier = [root.issue_id]
    seen = {root.issue_id}
    while frontier:
        node = frontier.pop()
        for child in children_of.get(node, []):
            if child.issue_id in seen:
                continue
            seen.add(child.issue_id)
            if child.status not in TERMINAL_ISSUE_STATUSES:
                count += 1
            frontier.append(child.issue_id)
    return count


def _delegation_depth(store: StateStore, issue: Issue, *, _max_walk: int = 64) -> int:
    """How deep ``issue`` sits in its delegation tree (root = 0). Cycle-safe."""
    depth = 0
    seen = {issue.issue_id}
    current = issue.parent_id
    while current and depth < _max_walk:
        if current in seen:
            break  # defensive: a corrupted parent loop must not hang the kernel
        seen.add(current)
        try:
            parent = store.get_issue(current)
        except KeyError:
            break
        depth += 1
        current = parent.parent_id
    return depth


def delegate_sub_issue(
    store: StateStore,
    parent_id: str,
    *,
    assignee_agent_profile_id: str,
    title: str,
    description: str = "",
    requested_by: str | None = None,
    priority: str = "medium",
    origin_run_id: str | None = None,
) -> Issue:
    """Create a child issue under ``parent_id``, assign it, and wake the assignee.

    This is how an agent breaks long/parallel work down to a direct report
    instead of polling. Fail-closed: parent and assignee must exist, the child
    inherits the parent's workspace (same execution boundary), and a parent can
    carry at most ``MAX_CHILD_ISSUES_PER_PARENT`` children. The delegation is a
    thread fact on the parent, and the assignee gets an assignment wakeup — the
    delegate starts working without anyone polling.
    """
    parent = store.get_issue(parent_id)
    # A held parent is paused — spawning fresh, UN-held children under it would
    # leak right past the pause (the daemon would happily pick the new child up).
    # Fail closed: no new work branches off a paused issue until it resumes.
    if store.issue_is_held(parent_id):
        raise IssueHeldError(
            f"parent issue {parent_id} is on hold; resume it before delegating new work"
        )
    profile = store.get_agent_profile(assignee_agent_profile_id)  # raises KeyError if unknown
    if profile.company_profile_id != parent.company_profile_id:
        raise ValueError(
            f"cross-company delegation: issue {parent_id} belongs to company "
            f"{parent.company_profile_id}, profile {assignee_agent_profile_id} "
            f"to {profile.company_profile_id}"
        )
    depth = _delegation_depth(store, parent)
    # T11: a low-trust review fences the delegation TREE tighter than the global
    # blast-radius cap (containment.max_delegation_depth ≤ MAX_DELEGATION_DEPTH).
    # The child inherits the parent's workspace, so it inherits the same fence —
    # an untrusted review cannot fan out a deep agent tree to amplify itself.
    from superclaw.containment import resolve_containment_policy

    containment = resolve_containment_policy(
        store,
        workspace_id=parent.workspace_id,
        company_profile_id=parent.company_profile_id,
        issue=parent,
    )
    depth_cap = min(MAX_DELEGATION_DEPTH, containment.max_delegation_depth)
    if depth + 1 > depth_cap:
        fence = f" under containment '{containment.preset}'" if containment.is_low_trust else ""
        raise ValueError(
            f"delegation too deep: issue {parent_id} sits at depth {depth} "
            f"(cap {depth_cap}{fence}); break the chain instead of relaying"
        )
    active_children = [
        i for i in store.list_issues(company_profile_id=parent.company_profile_id)
        if i.parent_id == parent.issue_id and i.status not in TERMINAL_ISSUE_STATUSES
    ]
    if len(active_children) >= MAX_CHILD_ISSUES_PER_PARENT:
        raise ValueError(
            f"issue {parent_id} already has {len(active_children)} active children "
            f"(cap {MAX_CHILD_ISSUES_PER_PARENT}); finish or cancel some first"
        )
    root = _delegation_root(store, parent)
    tree_size = _active_tree_size(store, root)
    if tree_size >= MAX_ACTIVE_ISSUES_PER_TREE:
        raise ValueError(
            f"delegation tree {root.issue_id} already has {tree_size} active issues "
            f"(cap {MAX_ACTIVE_ISSUES_PER_TREE}); the tree must converge before it grows"
        )
    child = Issue(
        title=title,
        description=description,
        workspace_id=parent.workspace_id,
        company_profile_id=parent.company_profile_id,
        priority=priority,
        # A delegated sub-issue IS a delegation (business kind), not a root delivery —
        # so it reads/links correctly and can later carry delegation-specific
        # completion semantics. (origin_kind below is separate audit-only provenance.)
        kind=IssueKind.DELEGATION.value,
        # Per execution-plan §2.7: a delegated child does NOT default to human final
        # approval — it is accepted/closed by the requesting (parent) agent or QA.
        # Defaulting to human_final would contradict the plan and the existing Web
        # contract (the Web company surface expects delegation children to be parent_accept).
        review_policy=ReviewPolicy.PARENT_ACCEPT.value,
        parent_id=parent.issue_id,
        goal_id=parent.goal_id,
        assignee_agent_profile_id=profile.profile_id,
        status=IssueStatus.TODO.value,
        origin_kind="delegation" if origin_run_id or requested_by else "manual",
        origin_run_id=origin_run_id,
        created_by=requested_by or "local_user",
    )
    # T11: EXPLICITLY stamp the child with the parent's fence. The child inherits
    # the parent's workspace (so a workspace-level fence already carries over), but
    # an ISSUE-level low-trust override would NOT — stamping it here makes the
    # child carry the fence regardless of where the parent's came from, so an
    # untrusted-review subtree can never relax mid-chain.
    if containment.is_low_trust:
        child.metadata = {**child.metadata, "containment_preset": containment.preset}
    # Atomic gate: the child only lands if the parent is STILL un-held at write
    # time (the early IssueHeldError check above is a fast fail; this closes the
    # check->create race where a hold lands mid-delegate).
    store.save_delegated_child(child, parent_id=parent.issue_id)
    # The delegation is a durable thread fact on the PARENT (who asked whom).
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=parent.issue_id,
            company_profile_id=parent.company_profile_id,
            kind=IssueInteractionKind.DELEGATION.value,
            status="resolved",
            target_agent_profile_id=profile.profile_id,
            source_run_id=origin_run_id,
            created_by_type="agent" if requested_by else "user",
            created_by_id=requested_by or "local_user",
            payload={"child_issue_id": child.issue_id, "title": title},
        )
    )
    _wake_agent(
        store,
        profile,
        source=WakeupSource.ASSIGNMENT.value,
        reason=f"delegated:{child.issue_id}",
        snapshot={"issue_id": child.issue_id, "parent_issue_id": parent.issue_id},
        idempotency_key=f"assignment:{profile.profile_id}:{child.issue_id}",
    )
    return child


# --- issue tree control: hold ledger + subtree pause/resume/cancel -----------
#
# A "hold" is an administrative pause MARKER (a hold-ledger row), never an issue
# status — so the status transition graph stays clean and a paused issue keeps
# its real lane. The kernel refuses to start work on a held issue (checkout) and
# the daemon skips it. Tree operations walk the delegation subtree (parent_id)
# under the SAME fail-closed guards delegation uses (company scope, cycle-safe
# walk) and reuse the existing checkout/lock/cancel primitives rather than
# inventing parallel ones.


def _issue_subtree(store: StateStore, root: Issue, *, include_terminal: bool = False) -> list[Issue]:
    """Root + all descendants by parent_id (company-scoped, cycle-safe, BFS).

    Mirrors ``_active_tree_size``'s walk: one company-scoped read, an in-memory
    children index, and a ``seen`` set so a corrupted parent loop can never hang
    the kernel. Terminal issues are excluded by default (governance acts on live
    work); pass ``include_terminal`` to enumerate the whole tree.
    """
    issues = store.list_issues(company_profile_id=root.company_profile_id)
    by_id = {i.issue_id: i for i in issues}
    by_id[root.issue_id] = root
    children_of: dict[str, list[Issue]] = {}
    for candidate in issues:
        if candidate.parent_id:
            children_of.setdefault(candidate.parent_id, []).append(candidate)
    out: list[Issue] = []
    frontier = [root.issue_id]
    seen = {root.issue_id}
    while frontier:
        node = frontier.pop()
        issue = by_id.get(node)
        if issue is not None and (include_terminal or issue.status not in TERMINAL_ISSUE_STATUSES):
            out.append(issue)
        for child in children_of.get(node, []):
            if child.issue_id in seen:
                continue
            seen.add(child.issue_id)
            frontier.append(child.issue_id)
    return out


def _issue_active_run_id(store: StateStore, issue: Issue) -> str | None:
    """The issue's execution run id IF that run is still active (non-terminal)."""
    if not issue.execution_run_id:
        return None
    try:
        run = store.get_run(issue.execution_run_id)
    except KeyError:
        return None
    return run.run_id if run.status in ACTIVE_RUN_STATUSES else None


def _release_issue_lock(store: StateStore, issue: Issue) -> None:
    """Best-effort release of the issue's pinned workspace lock, matching the
    lock's actual holder (an operator pausing/cancelling is not the assignee, so
    we release as whoever holds it). No-op when the issue holds no lock."""
    if not issue.lock_key:
        return
    release_key = issue_release_key(issue, store=store)
    lock = store.get_workspace_lock(release_key)
    if lock is None:
        return
    store.release_workspace_lock(
        release_key, holder=lock.holder, expected_issue_id=issue.issue_id
    )


def hold_issue(
    store: StateStore, issue_id: str, *, reason: str = "", by: str = "local_user"
) -> IssueHold:
    """Place a single-issue administrative hold (fail-closed).

    A terminal issue cannot be held (nothing to pause), and an issue already
    held is rejected rather than silently double-held — the pre-check plus the
    DB-level partial unique index make the single-active-hold invariant robust
    against a concurrent racer.
    """
    issue = store.get_issue(issue_id)
    if issue.status in TERMINAL_ISSUE_STATUSES:
        raise ValueError(f"issue {issue_id} is {issue.status}; terminal issues cannot be held")
    if store.issue_is_held(issue_id):
        raise ValueError(f"issue {issue_id} is already held")
    return store.save_issue_hold(
        IssueHold(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            scope="single",
            reason=reason,
            created_by=by,
        )
    )


def release_issue_hold(store: StateStore, issue_id: str, *, by: str = "local_user") -> IssueHold:
    """Release an issue's active hold (fail-closed: there must be one)."""
    active = store.get_active_issue_hold(issue_id)
    if active is None:
        raise ValueError(f"issue {issue_id} has no active hold")
    active.status = "released"
    active.released_at = time()
    active.released_by = by
    return store.update_issue_hold(active)


def preview_issue_tree(store: StateStore, root_id: str) -> dict[str, Any]:
    """Read-only summary of the delegation subtree under ``root_id`` — the
    "this will affect N issues" confirmation source. Never mutates."""
    root = store.get_issue(root_id)
    subtree = _issue_subtree(store, root, include_terminal=False)
    issues = []
    active_runs = 0
    held = 0
    for issue in subtree:
        run_id = _issue_active_run_id(store, issue)
        is_held = store.issue_is_held(issue.issue_id)
        if run_id:
            active_runs += 1
        if is_held:
            held += 1
        issues.append(
            {
                "issue_id": issue.issue_id,
                "title": issue.title,
                "status": issue.status,
                "parent_id": issue.parent_id,
                "active_run_id": run_id,
                "held": is_held,
            }
        )
    return {
        "root_id": root.issue_id,
        "count": len(subtree),
        "active_run_count": active_runs,
        "held_count": held,
        "issues": issues,
    }


def _try_stop_active_run(
    store: StateStore,
    issue: Issue,
    run_canceller: "Callable[[str], Any] | None",
) -> tuple[str | None, bool]:
    """Try to stop the issue's active run. Returns ``(run_id, stopped)``:

    - ``(None, True)``  — no active run; nothing to stop.
    - ``(run_id, True)`` — the run was cancelled via the injected canceller.
    - ``(run_id, False)`` — an active run exists but NO canceller was supplied,
      so it could NOT be stopped. The caller MUST NOT release the lock or change
      the issue's status in this case: re-queuing or terminating an issue whose
      run is still executing is a governance hole (the run could still write the
      workspace and its result land afterwards). The issue stays FROZEN under its
      hold instead — fail-closed without refusing the whole tree op.
    """
    run_id = _issue_active_run_id(store, issue)
    if run_id is None:
        return None, True
    if run_canceller is None:
        return run_id, False
    try:
        run_canceller(run_id)
    except Exception:
        # A canceller that throws must NOT abort the whole tree op mid-pass (that
        # would partially mutate the tree). Degrade to "could not stop" — the
        # issue stays frozen in place under its hold, same as the no-canceller
        # case, and the operator can retry.
        return run_id, False
    return run_id, True


def _ensure_tree_hold(
    store: StateStore, issue: Issue, *, operation_id: str, reason: str, by: str
) -> None:
    """Hold an issue for a tree pause, idempotently. The pre-check covers the
    common case; the IntegrityError catch covers a concurrent racer that held it
    between check and insert — either way the end state (issue held) is what we
    want, so the tree pause converges instead of aborting half-done."""
    if store.issue_is_held(issue.issue_id):
        return
    try:
        store.save_issue_hold(
            IssueHold(
                issue_id=issue.issue_id,
                company_profile_id=issue.company_profile_id,
                scope="tree",
                operation_id=operation_id,
                reason=reason,
                created_by=by,
            )
        )
    except sqlite3.IntegrityError:
        # A concurrent hold won the active-hold slot; the issue is held, which is
        # the desired post-condition. Idempotent — keep going.
        pass


def pause_issue_tree(
    store: StateStore,
    root_id: str,
    *,
    by: str = "local_user",
    reason: str = "",
    run_canceller: "Callable[[str], Any] | None" = None,
) -> dict[str, Any]:
    """Pause a whole delegation subtree: hold every live issue, stop its active
    run, and release its workspace lock so the pause is reversible and frees the
    workspace. Reuses ``abort_checkout`` semantics (in_progress -> todo, lock
    released) so resume is a clean re-pickup — NO new issue status is invented.

    Two passes make the operation TOCTOU-safe and fail-closed:
    - PASS 1 FREEZE: hold every live issue first. A held issue refuses checkout,
      so once pass 1 completes NO concurrent actor can start a new run anywhere in
      the subtree — closing the race a write-time snapshot pre-scan cannot.
    - PASS 2 STOP: cancel each frozen issue's run (via the injected canceller) and
      release its lock + re-queue it to ``todo`` (resume = clean re-pickup). An
      issue whose run CANNOT be stopped (no canceller) is left ``in_progress`` +
      held — FROZEN in place; we never re-queue or unlock an issue whose run is
      still executing. The op never raises and never partially mutates the tree.
    """
    root = store.get_issue(root_id)
    subtree = _issue_subtree(store, root, include_terminal=False)
    operation_id = f"hold_op_{uuid.uuid4().hex[:12]}"
    # PASS 1 — FREEZE: hold every live issue so no concurrent checkout can
    # introduce a new run while pass 2 stops the existing ones.
    held_ids: list[str] = []
    for issue in subtree:
        fresh = store.get_issue(issue.issue_id)
        # TOCTOU: the issue may have reached a terminal status between the subtree
        # snapshot and now. A terminal issue must never be held (zombie marker).
        if fresh.status in TERMINAL_ISSUE_STATUSES:
            continue
        _ensure_tree_hold(store, fresh, operation_id=operation_id, reason=reason, by=by)
        held_ids.append(fresh.issue_id)
    # PASS 2 — STOP runs + free locks on the now-frozen subtree.
    paused: list[str] = []
    cancelled_runs: list[str] = []
    frozen_in_place: list[str] = []
    for issue_id in held_ids:
        fresh = store.get_issue(issue_id)
        run_id, stopped = _try_stop_active_run(store, fresh, run_canceller)
        if not stopped:
            # An active run we could not stop → leave the issue in_progress + held
            # (frozen). Never re-queue/unlock while its run is still executing.
            frozen_in_place.append(fresh.issue_id)
            paused.append(fresh.issue_id)
            continue
        if run_id is not None:
            cancelled_runs.append(run_id)
        if fresh.status == IssueStatus.IN_PROGRESS.value:
            _release_issue_lock(store, fresh)
            fresh.status = IssueStatus.TODO.value
            fresh.checkout_run_id = None
            fresh.execution_run_id = None
            fresh.lock_key = None
            fresh.updated_at = time()
            store.save_issue(fresh)
        paused.append(fresh.issue_id)
    return {
        "operation_id": operation_id,
        "paused": paused,
        "cancelled_runs": cancelled_runs,
        "frozen_in_place": frozen_in_place,
    }


def resume_issue_tree(
    store: StateStore,
    root_id: str,
    *,
    by: str = "local_user",
    operation_id: str | None = None,
) -> dict[str, Any]:
    """Resume a subtree: release the TREE-scoped holds a pause set, leaving a
    deliberate single-issue ``hold`` (scope ``single``) untouched — resuming the
    tree must never silently lift an operator's targeted freeze on one issue.
    Pass ``operation_id`` to release only one specific pause's holds (when several
    pauses overlap a subtree)."""
    root = store.get_issue(root_id)
    released: list[str] = []
    for issue in _issue_subtree(store, root, include_terminal=True):
        active = store.get_active_issue_hold(issue.issue_id)
        if active is None or active.scope != "tree":
            continue
        if operation_id is not None and active.operation_id != operation_id:
            continue
        active.status = "released"
        active.released_at = time()
        active.released_by = by
        store.update_issue_hold(active)
        released.append(issue.issue_id)
    return {"root_id": root.issue_id, "released": released}


def cancel_issue_tree(
    store: StateStore,
    root_id: str,
    *,
    by: str = "local_user",
    reason: str = "",
    run_canceller: "Callable[[str], Any] | None" = None,
) -> dict[str, Any]:
    """Cancel a whole delegation subtree: stop active runs, release locks, and
    transition every live issue to ``cancelled`` (a legal terminal edge from
    every non-terminal status).

    Same freeze-first discipline as ``pause``: PASS 1 holds the whole subtree (so
    no concurrent checkout introduces a new run mid-cancel), PASS 2 terminates
    each issue whose run could be stopped (the hold is then released — moot once
    the issue is terminal). A live issue whose run CANNOT be stopped (no
    canceller) is NOT forced to ``cancelled`` — terminating an issue whose run is
    still executing is a governance hole — it is left FROZEN (held + in_progress)
    and reported in ``frozen_in_place`` for a retry with an engine."""
    root = store.get_issue(root_id)
    subtree = _issue_subtree(store, root, include_terminal=False)
    operation_id = f"hold_op_{uuid.uuid4().hex[:12]}"
    # PASS 1 — FREEZE the subtree (holds) so no new run can start mid-cancel.
    frozen_held: list[str] = []
    for issue in subtree:
        fresh = store.get_issue(issue.issue_id)
        if fresh.status in TERMINAL_ISSUE_STATUSES:
            continue
        _ensure_tree_hold(store, fresh, operation_id=operation_id, reason=reason, by=by)
        frozen_held.append(fresh.issue_id)
    # PASS 2 — terminate what we can stop; leave the rest frozen in place.
    cancelled: list[str] = []
    cancelled_runs: list[str] = []
    frozen_in_place: list[str] = []
    for issue_id in frozen_held:
        fresh = store.get_issue(issue_id)
        if fresh.status in TERMINAL_ISSUE_STATUSES:
            continue
        run_id, stopped = _try_stop_active_run(store, fresh, run_canceller)
        if not stopped:
            # Uncancellable live run → stays held + in_progress (frozen), not
            # forced to a terminal status while its run still executes.
            frozen_in_place.append(fresh.issue_id)
            continue
        if run_id is not None:
            cancelled_runs.append(run_id)
        _release_issue_lock(store, fresh)
        fresh.status = IssueStatus.CANCELLED.value
        fresh.checkout_run_id = None
        fresh.execution_run_id = None
        fresh.lock_key = None
        fresh.updated_at = time()
        store.save_issue(fresh)
        active = store.get_active_issue_hold(fresh.issue_id)
        if active is not None:
            active.status = "released"
            active.released_at = time()
            active.released_by = by
            store.update_issue_hold(active)
        cancelled.append(fresh.issue_id)
    return {
        "root_id": root.issue_id,
        "cancelled": cancelled,
        "cancelled_runs": cancelled_runs,
        "frozen_in_place": frozen_in_place,
    }


def archive_company(
    store: StateStore,
    company_profile_id: str,
    *,
    requested_by: str = "local_user",
    reason: str | None = None,
    run_canceller: "Callable[[str], Any] | None" = None,
    excluded_approval_ids: "frozenset[str] | set[str] | None" = None,
) -> dict[str, Any]:
    """Phase 2a of two-phase archive: dissolve a company + cascade circuit-breaker.

    Contract E (docs/company-chat-management-design.md §3). Applied at GRANT time
    from the company-command approval (see company_handler.apply_company_command),
    after request-time ``freeze_company_for_archive`` already moved the company to
    FROZEN. This is the irreversible step: ACTIVE/FROZEN -> DISSOLVED (epoch++) and
    a fail-soft cascade that severs the company's live work.

    Idempotent / re-entrant safe (a grant may be retried): an already-DISSOLVED
    company returns the terminal state with an EMPTY cascade summary (and
    ``already_dissolved=True``) WITHOUT re-running the cascade, so a double-grant
    never double-cancels or double-supersedes. (The first apply's cascade results
    are not re-reported — the summary is reconstructed empty, which is enough for
    the idempotency contract.)

    The cascade does ONLY what real kernel primitives support today; everything
    the design names but has no primitive for is recorded under ``deferred`` and
    documented in the module/function (NO silent pretend-success):

      * **pending approvals -> superseded.** Every PENDING/REVISION_REQUESTED
        approval scoped to the company (``list_approvals(company_profile_id=...)``)
        is moved to ``cancelled`` (the terminal "superseded" edge on the approval
        state machine). The CURRENTLY-GRANTING archive approval is EXCLUDED
        (``excluded_approval_ids``) so we never cancel the very approval whose
        grant is driving us here — that would deadlock the grant
        (``decide_approval`` would try to flip an already-cancelled approval to
        approved and the state machine would refuse).
      * **running runs / live issues -> cancelled.** Each non-terminal ROOT issue
        in the company is run through the existing ``cancel_issue_tree`` circuit
        breaker (freeze subtree -> stop runs -> terminate). With no ``run_canceller``
        injected (the kernel grant path has no orchestrator handle) a still-executing
        run cannot be force-stopped, so its issue is left FROZEN-in-place and
        reported in ``frozen_in_place`` rather than terminated under a live run
        (same governance discipline as ``cancel_issue_tree``).
      * **agent runtime token / equipment lease -> revoked.** DEFERRED: there is
        NO persisted runtime-token or equipment-lease primitive to revoke — agent
        equipment is resolved on demand (``resolve_equipment``) and every new run /
        tool execution is already gated by ``assert_company_active``, so a DISSOLVED
        company can host no further equipped work. The DISSOLVED status IS the
        revocation; an explicit token ledger is a future increment.
      * **agent tombstone.** DEFERRED: ``AgentProfile`` has no lifecycle/status
        field, so there is no per-agent tombstone to set. The agents are retained
        read-only under the dissolved company (the company status fences them).
      * **issues / work products / cost events / audit log -> read-only retained.**
        NOTHING is deleted (soft-archive): they remain queryable; the company
        status + the cascade above prevent any NEW work.
      * **company_id never reused.** The DISSOLVED row is the permanent anchor — we
        soft-archive, never delete, so the id can never be handed to a new company.

    Returns a summary dict (status transition + cascade results + ``deferred``).
    Raises on a genuinely-wrong state (e.g. still ACTIVE — freeze was lost) so the
    grant leaves the approval re-decidable rather than recording a phantom dissolve.
    """
    from superclaw.company_lifecycle import assert_company_archivable

    company = store.get_company_profile(company_profile_id)  # KeyError -> unknown

    # Idempotent: a re-applied grant on an already-dissolved company must NOT
    # re-run the cascade. Report the terminal state without touching anything.
    if company.status == CompanyStatus.DISSOLVED.value:
        return {
            "archived": company.company_profile_id,
            "status": company.status,
            "epoch": company.epoch,
            "already_dissolved": True,
            "superseded_approvals": [],
            "cancelled_issues": [],
            "cancelled_runs": [],
            "frozen_in_place": [],
            "deferred": _ARCHIVE_DEFERRED,
        }

    # Grant-time invariant: the request froze the company. A still-ACTIVE company
    # here means the freeze was lost (corrupted flow) -> refuse (re-decidable).
    assert_company_archivable(company)

    excluded = frozenset(excluded_approval_ids or ())

    # (1) Supersede the company's other pending approvals (cancel = superseded
    # edge), EXCLUDING the archive approval that is driving this grant.
    superseded: list[str] = []
    for approval in store.list_approvals(company_profile_id=company_profile_id):
        if approval.approval_id in excluded:
            continue
        if approval.status not in (
            ApprovalStatus.PENDING.value,
            ApprovalStatus.REVISION_REQUESTED.value,
        ):
            continue
        approval.status = ApprovalStatus.CANCELLED.value
        approval.decided_by = requested_by
        approval.decided_at = time()
        approval.decision_note = (
            f"superseded by company archive ({reason})" if reason else "superseded by company archive"
        )
        store.save_approval(approval)
        superseded.append(approval.approval_id)

    # (2) Cascade-cancel live work: run each non-terminal ROOT issue through the
    # existing tree circuit breaker. Roots only (cancel_issue_tree walks the
    # subtree), so a parent + its children are handled once.
    cancelled_issues: list[str] = []
    cancelled_runs: list[str] = []
    frozen_in_place: list[str] = []
    company_issues = store.list_issues(company_profile_id=company_profile_id)
    issue_ids = {issue.issue_id for issue in company_issues}
    for issue in company_issues:
        if issue.status in TERMINAL_ISSUE_STATUSES:
            continue
        # A root within THIS company: no parent, or a parent outside the company
        # set (defensive — a cross-company parent is forbidden elsewhere).
        if issue.parent_id and issue.parent_id in issue_ids:
            continue
        result = cancel_issue_tree(
            store,
            issue.issue_id,
            by=requested_by,
            reason=reason or "company archived",
            run_canceller=run_canceller,
        )
        cancelled_issues.extend(result.get("cancelled", []))
        cancelled_runs.extend(result.get("cancelled_runs", []))
        frozen_in_place.extend(result.get("frozen_in_place", []))

    # (3) Terminal transition LAST: only after the cascade has severed live work
    # do we record the irreversible dissolve (epoch++). Doing it last means a
    # crash mid-cascade leaves a FROZEN company (re-archivable) rather than a
    # DISSOLVED one whose cascade never finished.
    company.status = CompanyStatus.DISSOLVED.value
    company.epoch += 1
    store.save_company_profile(company)

    return {
        "archived": company.company_profile_id,
        "status": company.status,
        "epoch": company.epoch,
        "already_dissolved": False,
        "superseded_approvals": superseded,
        "cancelled_issues": cancelled_issues,
        "cancelled_runs": cancelled_runs,
        "frozen_in_place": frozen_in_place,
        "deferred": _ARCHIVE_DEFERRED,
    }


# Cascade items the design (§3) names but the kernel has NO primitive for yet —
# surfaced honestly in archive_company's result instead of pretend-done.
_ARCHIVE_DEFERRED: tuple[str, ...] = (
    "agent_runtime_token_revocation",  # no persisted token; DISSOLVED status fences new work
    "agent_equipment_lease_revocation",  # equipment is resolved on demand, not leased
    "agent_tombstone",  # AgentProfile has no lifecycle/status field
)


def build_agent_run_context(
    store: StateStore,
    profile: AgentProfile,
    *,
    available_ids: list[str] | None = None,
    available_skill_ids_override: list[str] | None = None,
    parent_plugin_constraint: frozenset[str] | None = None,
    issue_plugin_constraint: frozenset[str] | None = None,
    issue_skill_constraint: frozenset[str] | None = None,
) -> dict[str, Any]:
    """Assemble the kernel fields a run must carry for a profile (gap C).

    The orchestrator injects this into the child run's ``execution_context`` and
    synthesizes the system prompt from it: identity + charter + reporting chain +
    *governed* equipment. Tools come only from ``resolve_equipment().granted`` —
    the profile/template can never widen beyond the governed projection.

    layer 3: ``parent_plugin_constraint`` (a cross-runtime delegation's plugin cap
    = parent_granted ∩ profile, computed by the authorizer) further narrows
    ``equipment.granted`` so a delegated child never exceeds the parent (no
    escalation). ``None`` = no cap (a top-level team run, or absent on a plain
    fan-out). Capped-out plugins move to ``dropped`` (kept observable so the
    synthesized prompt and the projection layer agree — no contract drift).

    per-fire scoping: ``issue_plugin_constraint`` / ``issue_skill_constraint`` are
    an INDEPENDENT narrowing axis carried by the issue itself (Paperclip
    ``routine.context`` — a routine's per-fire equipment subset), kept separate
    from the delegation cap so the two sources never blur (a future routine issue
    that also delegates keeps both caps distinct). Tri-state, matching the snapshot
    on the issue: ``None`` = this axis does not narrow (inherit); an EMPTY frozenset
    = narrow to nothing (an explicit "zero" — never collapsed to "inherit"); a
    non-empty set = narrow to that subset. All narrowing is ``∩`` only — it can
    never widen beyond what governance already granted. Unlike the delegation cap,
    this axis ALSO narrows skills (the routine may scope skills per fire); skill
    narrowing currently only trims the prompt listing until the skill runtime
    delivers callable skills (see RoutineContextSelection).
    """
    resolution = resolve_equipment(
        profile,
        available_ids=available_ids,
        available_skill_ids_override=available_skill_ids_override,
    )
    granted = list(resolution.granted)
    cap_dropped: list[str] = []
    if parent_plugin_constraint is not None:
        cap_dropped = [pid for pid in granted if pid not in parent_plugin_constraint]
        granted = [pid for pid in granted if pid in parent_plugin_constraint]
    # Per-fire plugin scoping is a SEPARATE ∩ (None = do not narrow; an empty set
    # narrows to nothing — distinct from None). Its drops join ``dropped`` so the
    # prompt and the projection layer stay in agreement (the agent is shown which
    # plugins were withheld, never silently blinded).
    if issue_plugin_constraint is not None:
        cap_dropped = cap_dropped + [pid for pid in granted if pid not in issue_plugin_constraint]
        granted = [pid for pid in granted if pid in issue_plugin_constraint]
    skills_granted = list(resolution.skills_granted)
    skills_cap_dropped: list[str] = []
    if issue_skill_constraint is not None:
        skills_cap_dropped = [sid for sid in skills_granted if sid not in issue_skill_constraint]
        skills_granted = [sid for sid in skills_granted if sid in issue_skill_constraint]
    manager_chain = _manager_chain(store, profile)
    return {
        "agent_profile_id": profile.profile_id,
        "agent_name": profile.name,
        "agent_role": profile.role,
        "agent_title": profile.title,
        "agent_persona": profile.persona,
        "agent_charter": profile.charter,
        "agent_default_instructions": profile.default_instructions,
        "charter_revision_id": profile.charter_revision_id,
        "reports_to": profile.reports_to,
        "manager_chain": manager_chain,
        # Identity-bound runtime preferences: the orchestrator feeds ``model``
        # into WorkerLimits.model_override (the same governed channel chat
        # uses), so a role's runs carry the role's model — never a surface's.
        # ``effort`` rides the parallel effort_override channel the same way.
        "backend_policy": profile.backend_policy,
        "model": profile.model,
        "effort": profile.effort,
        "equipment": {
            "requested": list(profile.plugin_allowlist),
            "granted": granted,
            "dropped": [*resolution.dropped, *cap_dropped],
            "skills": {
                "requested": list(profile.skill_allowlist),
                "granted": skills_granted,
                "dropped": [*resolution.skills_dropped, *skills_cap_dropped],
            },
        },
    }


def _manager_chain(store: StateStore, profile: AgentProfile, *, _max_depth: int = 16) -> list[str]:
    """Walk reports_to up to the root (cycle-safe). Visualization + prompt only."""
    chain: list[str] = []
    seen: set[str] = {profile.profile_id}
    current = profile.reports_to
    depth = 0
    while current and depth < _max_depth and current not in seen:
        chain.append(current)
        seen.add(current)
        try:
            mgr = store.get_agent_profile(current)
        except KeyError:
            break
        current = mgr.reports_to
        depth += 1
    return chain


def team_inventory(
    store: StateStore,
    *,
    workspace_id: str | None = None,
    company_profile_id: str | None = None,
) -> dict[str, Any]:
    """A read model of the team: profiles, issue counts by status, open approvals.

    Pure projection over the kernel's own tables — surfaces render this; they do
    not compute organization state themselves. ``company_profile_id`` scopes the
    whole inventory (including the open-approval count, resolved through each
    approval's issue) to one governance namespace.
    """
    profiles = store.list_agent_profiles(
        workspace_id=workspace_id, company_profile_id=company_profile_id
    )
    issues = store.list_issues(
        workspace_id=workspace_id, company_profile_id=company_profile_id
    )
    status_counts: dict[str, int] = {}
    for issue in issues:
        status_counts[issue.status] = status_counts.get(issue.status, 0) + 1
    # The same scope applies to every figure in the payload: an inventory's
    # approval count must never be broader than its agent/issue lists.
    open_approvals = store.list_approvals(
        status=ApprovalStatus.PENDING.value,
        company_profile_id=company_profile_id,
        workspace_id=workspace_id,
    )
    return {
        "workspace_id": workspace_id,
        "company_profile_id": company_profile_id,
        "agents": [
            {
                "profile_id": p.profile_id,
                "name": p.name,
                "role": p.role,
                "title": p.title,
                "reports_to": p.reports_to,
                "backend_policy": p.backend_policy,
                "plugin_allowlist": list(p.plugin_allowlist),
                "budget_seconds": p.budget_seconds,
                "context_mode": p.context_mode,
            }
            for p in profiles
        ],
        "issue_status_counts": status_counts,
        "issue_total": len(issues),
        "open_approval_count": len(open_approvals),
    }
