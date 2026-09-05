"""Typed command models + central registry for chat-driven company management.

Single source of truth for the company-management mutation contract (contracts
B6 / B7 of docs/company-chat-management-design.md). Each command is a typed
dataclass with up-front, fail-closed, *stateless* business validation plus the
project's standard ``to_dict`` and a fail-closed ``from_dict`` (no Pydantic).

Consumers: ``company_handler.execute_company_command`` dispatches these models
(validate -> scope -> lifecycle -> risk -> execute/confirm), and is itself called
by the chat tool projection (PR-F) / CLI (PR-D). The CLI argparser / API payloads
/ tool JSON schemas derive from these models (single source). ``validate()`` is
the single source of STATELESS business validation, invoked by the handler before
any kernel mutation; stateful checks (reports_to cycle/depth, manager same-company)
stay at apply time in the kernel.

No canonical_payload / action-digest here (deliberately). The canonical
normalisation an action digest needs (contract B3 / the PR-C signing increment)
is SCHEMA-AWARE: which list fields are order-insensitive sets vs. order-
sensitive sequences depends on each field's meaning. These commands carry open
blobs (``permission_policy`` / ``runtime_config``) whose nested lists may be
order-sensitive — blindly sorting them would corrupt the data the digest is
meant to protect. So canonicalisation belongs with its consumer (which knows
the schema), not in this vocabulary layer; shipping a naive ``canonical_payload``
here would be a half-built digest foundation. It is intentionally omitted.

The field sets here deliberately mirror the kernel operations these commands
will eventually drive (e.g. ``HireAgentCommand.spec`` mirrors
``team_kernel._HIRE_SPEC_FIELDS``); the registry / handler increment is what
makes a single handler enforce them across every surface.

Kept dependency-light at MODULE level (imports only :mod:`superclaw.models`) so
the kernel, state, backend, CLI, and API layers can all import it without a
cycle. The few kernel constants/helpers reused for single-source validation
(``_HIRE_SPEC_FIELDS`` / ``EDITABLE_PROFILE_FIELDS`` / ``_validate_permission_policy``)
are imported LAZILY inside ``validate()`` — importing ``team_kernel`` (which
pulls in state/backends) at module load would create an import cycle.

See docs/company-chat-management-design.md (contracts B6, B7).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar

from superclaw.models import ISSUE_KINDS, REVIEW_POLICIES


def _require_nonempty(value: Any, field_name: str) -> None:
    """Fail-closed: raise ValueError unless ``value`` is a non-blank ``str``.

    The required identity/title fields are all strings, so a non-string value
    (e.g. ``123`` or ``[]`` arriving via a malformed payload) is rejected here
    rather than slipping through — checking ``str`` membership FIRST closes the
    fail-open hole where a non-None, non-str value satisfied neither branch.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} is required and must be a non-empty string")


def _validate_str_list(value: Any, field_name: str) -> None:
    """Fail-closed: a list-of-strings allowlist must be a list of ``str``.

    Rejects non-list and any non-``str`` element rather than coercing — a
    coerced ``str(1)`` would silently change the semantics of a security-
    sensitive allowlist (which plugins/skills a role may carry).
    """
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list of strings")
    bad = [v for v in value if not isinstance(v, str)]
    if bad:
        raise ValueError(f"{field_name} must contain only strings; got {bad!r}")


def _strict_from_dict(cls: type, data: dict[str, Any]) -> Any:
    """Construct ``cls`` from ``data``, rejecting unknown keys (fail-closed).

    DELIBERATE DEVIATION from the models.py convention of *filtering* unknown
    fields. The command layer is a security-sensitive mutation contract: a
    command instance is what gets approved / summarised / (later) digested, so
    silently dropping an unrecognised key would let the action that is approved
    diverge from the request that was sent. Here an unknown key is an error.
    """
    known = set(cls.__dataclass_fields__)  # type: ignore[attr-defined]
    unknown = [k for k in data if k not in known]
    if unknown:
        raise ValueError(
            f"unknown fields for {cls.__name__}: {sorted(unknown)} "
            f"(known: {sorted(known)})"
        )
    return cls(**data)


@dataclass
class CompanyCreateCommand:
    """Create a company governance namespace (drives ``save_company_profile``)."""

    command_type: ClassVar[str] = "company.create"

    name: str
    goal: str | None = None
    owner_id: str | None = None
    default_budget_seconds: int | None = None
    default_token_budget: int | None = None
    allowed_plugins: list[str] = field(default_factory=list)

    def validate(self) -> None:
        _require_nonempty(self.name, "name")
        # Validate the type unconditionally (default is []): a falsy-but-wrong
        # value like "" / 0 / False must not slip past a truthiness guard.
        _validate_str_list(self.allowed_plugins, "allowed_plugins")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyCreateCommand":
        return _strict_from_dict(cls, data)


@dataclass
class CompanyUpdateCommand:
    """Patch a company profile (drives ``save_company_profile`` re-save)."""

    command_type: ClassVar[str] = "company.update"

    company_profile_id: str
    name: str | None = None
    goal: str | None = None
    owner_id: str | None = None
    default_budget_seconds: int | None = None
    default_token_budget: int | None = None
    allowed_plugins: list[str] | None = None

    def validate(self) -> None:
        _require_nonempty(self.company_profile_id, "company_profile_id")
        # A patch must change something; an empty patch is a no-op the handler
        # should reject so callers do not mistake it for a successful mutation.
        if all(
            getattr(self, f) is None
            for f in (
                "name",
                "goal",
                "owner_id",
                "default_budget_seconds",
                "default_token_budget",
                "allowed_plugins",
            )
        ):
            raise ValueError("empty patch: pass at least one field to change")
        if self.name is not None:
            _require_nonempty(self.name, "name")
        if self.allowed_plugins is not None:
            _validate_str_list(self.allowed_plugins, "allowed_plugins")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyUpdateCommand":
        return _strict_from_dict(cls, data)


@dataclass
class HireAgentCommand:
    """Hire (create) a new agent role.

    User-triggered, so the handler creates the agent directly via
    ``team_kernel.create_agent_from_spec`` (no approval). ``spec`` mirrors
    ``team_kernel._HIRE_SPEC_FIELDS`` exactly — the same whitelist the kernel
    validates against — rather than re-listing each field, so this command can
    never drift from what the kernel accepts.

    ``validate()`` runs the kernel's own *stateless* checks (field whitelist,
    name+role required, permission-mode validity via ``_validate_permission_policy``,
    allowlist list-of-str). STATEFUL checks (governance scope, reports_to
    acyclicity) depend on the DB and stay at apply time in the kernel
    (``save_agent_profile``) — that is the layering boundary, not drift.
    """

    command_type: ClassVar[str] = "agent.hire"

    spec: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        from superclaw.team_kernel import _HIRE_SPEC_FIELDS, _validate_permission_policy

        if not isinstance(self.spec, dict):
            raise ValueError("hire spec must be a mapping")
        unknown = [k for k in self.spec if k not in _HIRE_SPEC_FIELDS]
        if unknown:
            raise ValueError(f"unknown hire spec fields: {sorted(unknown)}")
        # Same minimum the kernel requires: a role needs a name and a role.
        _require_nonempty(self.spec.get("name"), "spec.name")
        _require_nonempty(self.spec.get("role"), "spec.role")
        # Single-source the permission-mode gate with the kernel.
        _validate_permission_policy(self.spec.get("permission_policy"))
        for f in ("plugin_allowlist", "skill_allowlist"):
            if f in self.spec:
                _validate_str_list(self.spec[f], f"spec.{f}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "HireAgentCommand":
        return _strict_from_dict(cls, data)


@dataclass
class UpdateAgentCommand:
    """Patch an existing agent role (drives ``team_kernel.update_agent_profile``).

    Reversible + user-triggered, so the handler applies it directly (LOW).

    ``validate()`` runs the kernel's *stateless* checks: the patch keys must be
    a subset of ``team_kernel.EDITABLE_PROFILE_FIELDS`` (the authoritative edit
    whitelist), any ``permission_policy`` must carry a valid mode, and any
    plugin/skill allowlist must be a list-of-str. STATEFUL checks (reports_to
    cycle detection, manager-chain depth, manager same-company) depend on the
    DB and stay at apply time in the kernel (``update_agent_profile``) — that is
    the layering boundary, not drift.
    """

    command_type: ClassVar[str] = "agent.update"

    profile_id: str
    patch: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        from superclaw.team_kernel import EDITABLE_PROFILE_FIELDS, _validate_permission_policy

        _require_nonempty(self.profile_id, "profile_id")
        if not isinstance(self.patch, dict):
            raise ValueError("patch must be a mapping")
        if not self.patch:
            raise ValueError("empty patch: pass at least one field to change")
        unknown = [k for k in self.patch if k not in EDITABLE_PROFILE_FIELDS]
        if unknown:
            raise ValueError(
                f"fields not editable: {sorted(unknown)} "
                f"(one of {sorted(EDITABLE_PROFILE_FIELDS)})"
            )
        if "permission_policy" in self.patch:
            _validate_permission_policy(self.patch["permission_policy"])
        for f in ("plugin_allowlist", "skill_allowlist"):
            if f in self.patch:
                _validate_str_list(self.patch[f], f)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UpdateAgentCommand":
        return _strict_from_dict(cls, data)


@dataclass
class UpdateAgentCharterCommand:
    """Set an agent's behavioral charter — the role's behavior contract.

    Charter ONLY (deliberately not persona): the charter is the revisioned behavior
    contract and is excluded from ``agent.update``'s ``EDITABLE_PROFILE_FIELDS``, so
    this is its single command-vocabulary write path. ``persona`` is intentionally
    NOT carried here — it stays a scalar editable field owned by ``agent.update``
    (where the Web agent editor writes it), so persona keeps ONE command path
    (avoiding a split-brain where two commands bump different revision ids for the
    same field). Reversible (revisioned) → LOW; operator-only (the autonomy gate
    default-denies it for a confined agent, like ``agent.update``).
    """

    command_type: ClassVar[str] = "agent.charter"

    profile_id: str
    charter: str

    def validate(self) -> None:
        _require_nonempty(self.profile_id, "profile_id")
        _require_nonempty(self.charter, "charter")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UpdateAgentCharterCommand":
        return _strict_from_dict(cls, data)


@dataclass
class CreateIssueCommand:
    """Create an issue (drives ``save_issue``).

    ``kind`` / ``review_policy`` are validated against the closed model enums
    (``ISSUE_KINDS`` / ``REVIEW_POLICIES``) — fail-closed: an unknown value is
    rejected here, never silently coerced.
    """

    command_type: ClassVar[str] = "issue.create"

    title: str
    description: str | None = None
    kind: str | None = None
    review_policy: str | None = None
    workspace_id: str | None = None
    assignee_agent_profile_id: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.title, "title")
        if self.kind is not None and self.kind not in ISSUE_KINDS:
            raise ValueError(
                f"invalid issue kind: {self.kind!r} (one of {sorted(ISSUE_KINDS)})"
            )
        if self.review_policy is not None and self.review_policy not in REVIEW_POLICIES:
            raise ValueError(
                f"invalid review_policy: {self.review_policy!r} "
                f"(one of {sorted(REVIEW_POLICIES)})"
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CreateIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class AssignIssueCommand:
    """Assign an issue to an agent profile (drives ``assign_issue``)."""

    command_type: ClassVar[str] = "issue.assign"

    issue_id: str
    profile_id: str

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")
        _require_nonempty(self.profile_id, "profile_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AssignIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class DelegateIssueCommand:
    """Delegate a child issue under a parent (drives ``delegate_sub_issue``).

    Field set mirrors ``team_kernel.delegate_sub_issue``'s signature
    (parent_id + keyword args: assignee_agent_profile_id, title, description,
    priority, origin_run_id; ``requested_by`` is injected server-side, not part
    of the model).
    """

    command_type: ClassVar[str] = "issue.delegate"

    parent_id: str
    assignee_agent_profile_id: str
    title: str
    description: str | None = None
    priority: str | None = None
    origin_run_id: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.parent_id, "parent_id")
        _require_nonempty(self.assignee_agent_profile_id, "assignee_agent_profile_id")
        _require_nonempty(self.title, "title")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DelegateIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class PostIssueCommentCommand:
    """Post a comment on an issue's thread (drives ``post_issue_comment``).

    The mention/assignee wakeups are kernel continuations the dispatcher fires;
    the ``author_type`` / ``author_id`` are SERVER-injected by the handler from
    the acting scope (agent vs operator), NEVER from the command body — the body
    carries the target + content, not the actor's identity (contract B8).
    """

    command_type: ClassVar[str] = "issue.comment"

    issue_id: str
    body: str

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")
        _require_nonempty(self.body, "body")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PostIssueCommentCommand":
        return _strict_from_dict(cls, data)


@dataclass
class AttachWorkProductCommand:
    """Attach a delivery fact to an issue (drives ``attach_work_product``).

    Field set mirrors ``team_kernel.attach_work_product``'s create surface. The
    issue's company is taken from the issue by the kernel (never the caller), so
    a delivery fact can never be filed under a foreign company. ``type`` /
    ``status`` are validated against the closed work-product enums at apply time
    in the kernel (the single source); stateless validation here only enforces
    the required identity fields, mirroring the other command models' split.
    """

    command_type: ClassVar[str] = "work_product.attach"

    issue_id: str
    type: str
    title: str = ""
    url: str | None = None
    provider: str = "local"
    external_id: str | None = None
    status: str | None = None
    summary: str = ""
    is_primary: bool = False

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")
        _require_nonempty(self.type, "type")
        # is_primary is a security-irrelevant flag, but a non-bool is malformed
        # data: reject it rather than letting a truthy string flip the primary
        # delivery fact (fail-closed, mirrors the str-list guards above).
        if not isinstance(self.is_primary, bool):
            raise ValueError("is_primary must be a boolean")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttachWorkProductCommand":
        return _strict_from_dict(cls, data)


@dataclass
class SubmitReviewCommand:
    """Submit an in-progress issue for review (drives ``submit_for_review``).

    ``expected_checkout_run_id`` is OPTIONAL in this *stateless* model but its
    requirement is ACTOR-AWARE at apply time (柱子 1b, enforced in
    ``company_autonomy``): a CONFINED agent MUST supply a non-empty value so the
    kernel binds the in_review flip to the issue's live checkout run (an agent that
    merely knows an ``issue_id`` cannot submit a different run's work); the trusted
    OPERATOR may omit it (the kernel treats ``None`` as "do not bind" — a force-
    submit only safe for the operator). Making it required UNCONDITIONALLY here
    would have added a layer-only restriction the kernel does not have, breaking
    the operator's CLI/API force-submit — so the binding requirement lives in the
    actor-aware autonomy gate, not in stateless validation.

    When provided, it must still be a non-empty string (a blank string is a
    malformed value, distinct from "absent / do not bind").
    """

    command_type: ClassVar[str] = "issue.submit_review"

    issue_id: str
    expected_checkout_run_id: str | None = None
    summary: str = ""

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")
        # Absent (None) is legal here (operator force-submit); but a PROVIDED value
        # must be a non-empty string — a blank string is malformed, not "absent".
        if self.expected_checkout_run_id is not None:
            _require_nonempty(self.expected_checkout_run_id, "expected_checkout_run_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SubmitReviewCommand":
        return _strict_from_dict(cls, data)


@dataclass
class CompanyArchiveCommand:
    """Soft-archive a company (drives the future two-phase archive flow)."""

    command_type: ClassVar[str] = "company.archive"

    company_profile_id: str
    reason: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.company_profile_id, "company_profile_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompanyArchiveCommand":
        return _strict_from_dict(cls, data)


# --- P2 issue-lifecycle commands (operational write surface) ------------------
# All are ISSUE-ANCHORED (the only target is the issue's own company) and, under
# the autonomy gate's default-deny, OPERATOR-ONLY (a confined agent signals
# blockers via comments / does work via submit; it does not manage the board). The
# kernel primitives they dispatch to already exist (team_kernel); these add the
# typed command-vocabulary + tool projection so chat can drive them.


@dataclass
class BlockIssueCommand:
    """Mark an issue blocked with a reason (drives ``team_kernel.block_issue``)."""

    command_type: ClassVar[str] = "issue.block"

    issue_id: str
    reason: str
    unblock_owner: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")
        _require_nonempty(self.reason, "reason")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BlockIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class UnblockIssueCommand:
    """Clear an issue's blocked state (drives ``team_kernel.unblock_issue``)."""

    command_type: ClassVar[str] = "issue.unblock"

    issue_id: str
    note: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnblockIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class HoldIssueCommand:
    """Pause a single issue with an optional reason (drives ``team_kernel.hold_issue``)."""

    command_type: ClassVar[str] = "issue.hold"

    issue_id: str
    reason: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "HoldIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class UnholdIssueCommand:
    """Release a single issue's active hold (drives ``team_kernel.release_issue_hold``)."""

    command_type: ClassVar[str] = "issue.unhold"

    issue_id: str

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnholdIssueCommand":
        return _strict_from_dict(cls, data)


@dataclass
class UpdateWorkProductCommand:
    """Patch a delivery fact's mutable fields (drives ``team_kernel.update_work_product``).

    WORK-PRODUCT-anchored: the only company target is the work product's own
    (resolved via the store). Reversible edit → LOW. At least one mutable field
    must be set (the kernel also rejects an empty update — single source)."""

    command_type: ClassVar[str] = "work_product.update"

    work_product_id: str
    status: str | None = None
    title: str | None = None
    url: str | None = None
    summary: str | None = None
    is_primary: bool | None = None

    def validate(self) -> None:
        _require_nonempty(self.work_product_id, "work_product_id")
        for f in ("status", "title", "url", "summary"):
            v = getattr(self, f)
            if v is not None and not isinstance(v, str):
                raise ValueError(f"{f} must be a string")
        if self.is_primary is not None and not isinstance(self.is_primary, bool):
            raise ValueError("is_primary must be a boolean")
        if all(
            getattr(self, f) is None
            for f in ("status", "title", "url", "summary", "is_primary")
        ):
            raise ValueError("provide at least one field to update")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UpdateWorkProductCommand":
        return _strict_from_dict(cls, data)


# NOTE: work_product.delete (irreversible HIGH) is DELIBERATELY NOT in this
# increment: it would need the existing direct-delete routes (DELETE
# /api/team/work-products/{id} and the legacy `issue work-product-remove` CLI) to
# ALSO route through the human-approval gate — otherwise the HIGH "are you sure?"
# is trivially bypassed by the direct route. Closing that bypass is its own
# governance-consolidation follow-up. This increment ships only the reversible
# work_product.update.
#
# --- P2 issue-TREE commands (manage a whole delegated work subtree) -----------
# The kernel tree primitives need a ``run_canceller`` to actually stop active runs.
# It is built from the store INSIDE the dispatcher (``run_cancel.cancel_run_in_store``
# is store-portable), so every surface — chat / A-class proxy / CLI / REST / grant —
# cancels runs the SAME way without threading a runtime handle. Operator-only (the
# autonomy gate default-denies them for a confined agent).


@dataclass
class PauseIssueTreeCommand:
    """Pause a whole issue subtree (drives ``team_kernel.pause_issue_tree``). LOW."""

    command_type: ClassVar[str] = "issue.tree_pause"

    issue_id: str
    reason: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PauseIssueTreeCommand":
        return _strict_from_dict(cls, data)


@dataclass
class ResumeIssueTreeCommand:
    """Resume a paused issue subtree (drives ``team_kernel.resume_issue_tree``). LOW."""

    command_type: ClassVar[str] = "issue.tree_resume"

    issue_id: str

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ResumeIssueTreeCommand":
        return _strict_from_dict(cls, data)


@dataclass
class CancelIssueTreeCommand:
    """Cancel a whole issue subtree — IRREVERSIBLE (drives
    ``team_kernel.cancel_issue_tree``). HIGH-risk: pauses for human confirmation."""

    command_type: ClassVar[str] = "issue.tree_cancel"

    issue_id: str
    reason: str | None = None

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CancelIssueTreeCommand":
        return _strict_from_dict(cls, data)


@dataclass
class RequeueIssueCommand:
    """Recover a stuck issue: cancel its live run (if any) and return it to the queue.

    The kernel ``abort_checkout`` only releases the lock + resets to ``todo`` — it
    does NOT stop a live run, so calling it alone would orphan one. The dispatcher
    therefore cancels the issue's active run FIRST (via the store-portable canceller)
    and then aborts the checkout, so a requeue never leaves a worker running against a
    re-queued issue. Reversible (the issue can be re-claimed) → LOW; operator-only.
    """

    command_type: ClassVar[str] = "issue.requeue"

    issue_id: str

    def validate(self) -> None:
        _require_nonempty(self.issue_id, "issue_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RequeueIssueCommand":
        return _strict_from_dict(cls, data)


def _routine_spec_ref(spec: Any, key: str) -> str:
    """One entity ref from a routine spec, looked up under references then top-level."""
    if not isinstance(spec, dict):
        return ""
    refs = spec.get("references") if isinstance(spec.get("references"), dict) else {}
    value = refs.get(key) or spec.get(key)
    return value if isinstance(value, str) and value else ""


def routine_spec_company_id(spec: Any) -> str:
    """The company a routine spec targets (for the scope gate), or "" if absent.

    Mirrors ``team_routines._normalize_references``: the company is read from
    ``spec["references"]["company_profile_id"]`` or the top-level
    ``spec["company_profile_id"]``. Returns "" (→ fail-closed at the scope gate)
    when neither is a non-empty ``str``."""
    return _routine_spec_ref(spec, "company_profile_id")


def routine_spec_refs(spec: Any) -> dict[str, str]:
    """The entity refs a routine spec names — company, workspace, agent.

    The scope / lifecycle gates resolve the NESTED refs (workspace + agent), not
    just the routine's company, so a routine can never name a foreign-company
    workspace or agent (contract B8 nested-ref same-origin) and the lifecycle gate
    checks EVERY company the routine touches is active (contract B5). Each value is
    "" when absent. Mirrors ``team_routines._normalize_references``."""
    return {
        "company_profile_id": _routine_spec_ref(spec, "company_profile_id"),
        "workspace_id": _routine_spec_ref(spec, "workspace_id"),
        "agent_profile_id": _routine_spec_ref(spec, "agent_profile_id"),
    }


@dataclass
class AuthorRoutineCommand:
    """Author a recurring routine schedule for a company (drives
    ``team_routines.author_routine`` + ``save_team_routine_schedule``).

    Company-scoped (the routine's ``company_profile_id``). Reversible (a schedule can
    be disabled/removed) → LOW; operator-only (creating recurring autonomous
    execution is a governance action, default-denied for a confined agent). A spec
    that the authoring helper marks ``requires_approval`` is REFUSED here and routed
    to the dedicated routine-approval flow — chat authors only the no-approval-needed
    (``ready``/``disabled``) routines, so the company command gate is not layered on
    top of the routine's own governance approval.
    """

    command_type: ClassVar[str] = "routine.author"

    spec: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if not isinstance(self.spec, dict) or not self.spec:
            raise ValueError("spec must be a non-empty mapping")
        if not routine_spec_company_id(self.spec):
            raise ValueError(
                "routine spec must name a company_profile_id (top-level or under "
                "references) so the scope gate can verify it"
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AuthorRoutineCommand":
        return _strict_from_dict(cls, data)


@dataclass
class ResolveBoardInboxCommand:
    """Resolve a board-inbox escalation without changing its issue (drives
    ``team_kernel.resolve_board_inbox_item``).

    INTERACTION-anchored: the only company target is the escalation's issue's own
    company (resolved via the store). Reversible queue-state only (it flips an
    escalation to resolved; it touches no issue/agent/permission) → LOW.
    Operator-only by construction: it is NOT enumerated in the autonomy gate's
    confined-allowed set, so a confined agent is default-denied — an agent must
    not clear its own escalation to the human board."""

    command_type: ClassVar[str] = "board_inbox.resolve"

    interaction_id: str

    def validate(self) -> None:
        _require_nonempty(self.interaction_id, "interaction_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ResolveBoardInboxCommand":
        return _strict_from_dict(cls, data)


@dataclass
class AssignBoardInboxCommand:
    """Assign a board item's issue through the assignment gate, then (by default)
    resolve the escalation (drives ``team_kernel.assign_board_inbox_item``).

    INTERACTION + assignee anchored: BOTH the escalation's issue company and the
    target agent's company are resolved and must be same-origin (the underlying
    ``assign_issue`` also refuses a cross-company assignee). Reversible
    (re-assignable before checkout) → LOW. Operator-only by construction (not in
    the autonomy confined-allowed set). ``resolve=False`` keeps the item open."""

    command_type: ClassVar[str] = "board_inbox.assign"

    interaction_id: str
    profile_id: str
    resolve: bool = True

    def validate(self) -> None:
        _require_nonempty(self.interaction_id, "interaction_id")
        _require_nonempty(self.profile_id, "profile_id")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AssignBoardInboxCommand":
        return _strict_from_dict(cls, data)


# NOTE: work_product.delete stays deferred — its "remove/hide a company's output"
# need is already met by company.archive (HIGH, human-reviewed) per the owner; a
# per-work-product delete would additionally need the direct-delete REST/CLI routes
# routed through the approval gate (see the work-product NOTE above).
#
# NOTE: workspace create/trust/containment is DELIBERATELY not a company command —
# trust/containment decide an agent's filesystem reach + sandbox tier, so "move the
# boundary" must stay a human ceremony (CLI ``workspace trust`` + the desktop trust
# dialog), outside the agent-reachable command set (owner governance ruling 2026-06-26).


# Central command registry (contract B6): the single map from a stable
# command_type string to its model class. The future handler / CLI / API / tool
# schema derivation all index this one map so no surface hand-copies a command
# list. NOT YET CONSUMED — defined here as the single source the wiring
# increments will read from.
COMMAND_REGISTRY: dict[str, type] = {
    cls.command_type: cls
    for cls in (
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
    )
}


# Canonical chat-tool NAME for each command_type (PR-F tool projection). Kept
# here — the light vocabulary module — so BOTH the tool-schema source
# (``ui_contracts.COMPANY_COMMAND_TOOLS``) AND the mutating-tool taxonomy
# (``permissions._MUTATING_TOOLS``) derive from ONE map and can never drift.
# permissions.py can import this (it imports only ``models`` here), so the
# read-only-posture / low-trust-containment fence covers every company tool by
# construction rather than by a hand-maintained second list.
COMMAND_TYPE_TO_TOOL_NAME: dict[str, str] = {
    "company.create": "company_create",
    "company.update": "company_update",
    "company.archive": "company_archive",
    "agent.hire": "agent_hire",
    "agent.update": "agent_update",
    "agent.charter": "agent_charter",
    "issue.create": "issue_create",
    "issue.assign": "issue_assign",
    "issue.delegate": "issue_delegate",
    "issue.comment": "issue_comment",
    "work_product.attach": "work_product_attach",
    "issue.submit_review": "issue_submit_review",
    "issue.block": "issue_block",
    "issue.unblock": "issue_unblock",
    "issue.hold": "issue_hold",
    "issue.unhold": "issue_unhold",
    "issue.requeue": "issue_requeue",
    "work_product.update": "work_product_update",
    "issue.tree_pause": "issue_tree_pause",
    "issue.tree_resume": "issue_tree_resume",
    "issue.tree_cancel": "issue_tree_cancel",
    "routine.author": "routine_author",
    "board_inbox.resolve": "board_inbox_resolve",
    "board_inbox.assign": "board_inbox_assign",
}

# Defence against drift: every registered command_type MUST have a tool name and
# vice-versa. A mismatch is a programming error caught at import time.
assert set(COMMAND_TYPE_TO_TOOL_NAME) == set(COMMAND_REGISTRY), (
    "COMMAND_TYPE_TO_TOOL_NAME drifted from COMMAND_REGISTRY"
)

# The closed set of chat tool names that are company-management MUTATIONS. The
# permission/containment fence and the backend dispatch both key off this.
COMPANY_TOOL_NAMES: frozenset[str] = frozenset(COMMAND_TYPE_TO_TOOL_NAME.values())


def get_command_model(command_type: str) -> type:
    """Return the command model class for ``command_type``.

    Fail-closed: an unknown command_type raises ``KeyError`` rather than
    returning a default, so a surface can never dispatch an unrecognised
    mutation.
    """
    try:
        return COMMAND_REGISTRY[command_type]
    except KeyError as exc:
        raise KeyError(
            f"unknown command_type: {command_type!r} "
            f"(one of {sorted(COMMAND_REGISTRY)})"
        ) from exc
