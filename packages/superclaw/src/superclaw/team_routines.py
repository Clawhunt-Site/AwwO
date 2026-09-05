from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from time import time
from typing import Any, Iterable, Mapping

from superclaw.models import TeamRoutineSchedule


MIN_INTERVAL_SEC = 60
MAX_INTERVAL_SEC = 366 * 24 * 60 * 60

_DURATION_RE = re.compile(r"^\s*(?P<count>\d+)\s*(?P<unit>s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?\s*$")
_HIGH_RISK_FLAGS = {
    "browser_login",
    "destructive_write",
    "external_api",
    "network_access",
    "network_scan",
    "payment",
    "persistent_side_effect",
    "public_publish",
    "secret_access",
    "workspace_write",
}
_UNSAFE_BYPASS_FLAGS = {
    "approval_bypass",
    "auto_approve",
    "bypass_approval",
    "self_approve",
}
_RISK_ALIASES = {
    "active_network": "network_access",
    "network": "network_access",
    "network_egress": "network_access",
    "network_open": "network_access",
    "scan_network": "network_scan",
    "secret": "secret_access",
    "secrets": "secret_access",
    "side_effect": "persistent_side_effect",
    "side_effects": "persistent_side_effect",
    "write": "workspace_write",
    "writes": "workspace_write",
}


@dataclass(frozen=True)
class RoutineCadence:
    kind: str
    interval_sec: int
    expression: str
    timezone: str = "UTC"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutineReferences:
    owner_id: str
    company_profile_id: str
    workspace_id: str
    agent_profile_id: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutineIssueSeed:
    title: str
    description: str = ""
    priority: str = "medium"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutineContextSelection:
    """Per-fire equipment selection (Paperclip ``routine.context``).

    Each axis narrows the materialized run's equipment to a subset of what the
    routine's agent is *already* granted — it can only NARROW, never widen (the
    authoritative intersection happens at fire time against the agent's live
    grants). Three states per axis, preserved through serialization:

    * ``None`` (axis absent) — do NOT narrow this axis; the run inherits the
      agent's full granted set (matches Paperclip's "no context" = agent default,
      and keeps legacy routines without a context block unchanged).
    * ``[]`` (axis present, empty) — narrow to NOTHING on this axis (an explicit
      "this routine uses zero plugins"). Must stay distinct from ``None`` — a
      falsy collapse of ``[]`` into "inherit full" would be an equipment
      AMPLIFICATION bug.
    * ``[ids…]`` — narrow to exactly this subset (∩ the agent's live grants).

    NOTE on ``skill_ids``: skills are currently delivered only as prompt text
    (agent_prompt), not as a callable runtime surface, so a skill narrowing today
    only trims the prompt's skill listing. The selection is modeled + snapshotted
    now (so routines materialized before skill delivery do NOT silently default to
    full skill access once it lands), but real per-fire skill enforcement awaits
    the skill runtime. ``plugin_ids`` narrowing IS fully effective (MCP projection).
    """

    plugin_ids: list[str] | None = None
    skill_ids: list[str] | None = None

    @property
    def is_empty(self) -> bool:
        """True when NEITHER axis is specified (no per-fire narrowing at all)."""
        return self.plugin_ids is None and self.skill_ids is None

    def to_dict(self) -> dict[str, Any]:
        return {"plugin_ids": self.plugin_ids, "skill_ids": self.skill_ids}


@dataclass(frozen=True)
class RoutineGovernance:
    risk_flags: list[str] = field(default_factory=list)
    approval_grants: list[str] = field(default_factory=list)
    requested_budget_seconds: int = 0
    max_budget_seconds: int = 0
    requested_token_budget: int = 0
    max_token_budget: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutineApprovalRequirement:
    type: str
    reason: str
    requested_permission: dict[str, Any]
    affects: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoutineProposal:
    title: str
    enabled: bool
    cadence: RoutineCadence
    references: RoutineReferences
    issue_seed: RoutineIssueSeed
    governance: RoutineGovernance
    idempotency_key: str
    context: RoutineContextSelection = field(default_factory=RoutineContextSelection)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "enabled": self.enabled,
            "cadence": self.cadence.to_dict(),
            "references": self.references.to_dict(),
            "issue_seed": self.issue_seed.to_dict(),
            "governance": self.governance.to_dict(),
            "context": self.context.to_dict(),
            "idempotency_key": self.idempotency_key,
            "metadata": self.metadata,
        }

    def to_schedule_payload(self) -> dict[str, Any]:
        return {
            "agent_profile_id": self.references.agent_profile_id,
            "company_profile_id": self.references.company_profile_id,
            "title": self.title,
            "enabled": self.enabled,
            "interval_sec": self.cadence.interval_sec,
            "idempotency_key": self.idempotency_key,
            "context_snapshot": {
                "routine": {
                    "title": self.title,
                    "cadence": self.cadence.to_dict(),
                    "references": self.references.to_dict(),
                    "issue_seed": self.issue_seed.to_dict(),
                    "governance": self.governance.to_dict(),
                    # Per-fire equipment selection. Always emitted (even when both
                    # axes are None) so the schedule's shape is stable; the
                    # materializer only stamps a routine_context onto the issue
                    # when at least one axis actually narrows.
                    "context": self.context.to_dict(),
                    "metadata": self.metadata,
                }
            },
        }

    def to_team_routine_schedule(self, *, now: float | None = None) -> TeamRoutineSchedule:
        """Materialize a validated authoring proposal into durable schedule state."""
        started_at = time() if now is None else float(now)
        return TeamRoutineSchedule(
            agent_profile_id=self.references.agent_profile_id,
            company_profile_id=self.references.company_profile_id,
            title=self.title,
            enabled=self.enabled,
            interval_sec=self.cadence.interval_sec,
            next_run_at=started_at + self.cadence.interval_sec,
            idempotency_key=self.idempotency_key,
            context_snapshot=self.to_schedule_payload()["context_snapshot"],
            created_at=started_at,
            updated_at=started_at,
        )


@dataclass(frozen=True)
class RoutineAuthoringResult:
    status: str
    proposal: RoutineProposal | None
    errors: list[str] = field(default_factory=list)
    approvals_required: list[RoutineApprovalRequirement] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return self.status != "invalid"

    @property
    def schedule_ready(self) -> bool:
        return self.status in {"ready", "disabled"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "valid": self.valid,
            "schedule_ready": self.schedule_ready,
            "proposal": self.proposal.to_dict() if self.proposal else None,
            "errors": list(self.errors),
            "approvals_required": [approval.to_dict() for approval in self.approvals_required],
            "warnings": list(self.warnings),
        }

    def to_team_routine_schedule(self, *, now: float | None = None) -> TeamRoutineSchedule:
        if not self.schedule_ready or self.proposal is None:
            raise ValueError("routine authoring result is not schedule-ready")
        return self.proposal.to_team_routine_schedule(now=now)


def author_routine(
    spec: Mapping[str, Any],
    *,
    known_companies: Iterable[str] | None = None,
    known_workspaces: Iterable[str] | None = None,
    known_agents: Iterable[str] | None = None,
    agent_company_map: Mapping[str, str] | None = None,
    workspace_company_map: Mapping[str, str] | None = None,
    default_max_budget_seconds: int = 0,
    default_max_token_budget: int = 0,
) -> RoutineAuthoringResult:
    """Normalize a Paperclip-style routine spec into a guarded proposal.

    The helper is deliberately pure: it validates IDs and policy metadata that
    callers supply, but it does not read or write durable schedules itself.
    """

    errors: list[str] = []
    warnings: list[str] = []

    title = _text(spec.get("title") or spec.get("name"))
    if not title:
        errors.append("routine title is required")

    enabled = _bool(spec.get("enabled"), default=True)
    cadence, cadence_error = _normalize_cadence(spec.get("cadence") or spec.get("schedule"))
    if cadence_error:
        errors.append(cadence_error)

    references = _normalize_references(spec)
    _validate_references(
        references,
        errors,
        known_companies=known_companies,
        known_workspaces=known_workspaces,
        known_agents=known_agents,
        agent_company_map=agent_company_map,
        workspace_company_map=workspace_company_map,
    )

    issue_seed = _normalize_issue_seed(spec.get("issue_seed") or spec.get("issue") or {})
    if not issue_seed.title:
        errors.append("issue seed title is required")

    governance = _normalize_governance(
        spec.get("governance") or {},
        default_max_budget_seconds=default_max_budget_seconds,
        default_max_token_budget=default_max_token_budget,
    )
    errors.extend(_unsafe_governance_errors(governance))
    approvals = _required_approvals(governance, references, title)
    raw_context = spec.get("context")
    if raw_context is not None and not isinstance(raw_context, Mapping):
        # A present-but-malformed context (not an object) is dropped to "no
        # narrowing" — surface it so a wiring bug is visible at authoring rather
        # than silently inheriting the agent's full equipment.
        warnings.append("context must be an object with plugin_ids/skill_ids; ignored")
    context = _normalize_context(raw_context)

    if errors or cadence is None:
        return RoutineAuthoringResult(status="invalid", proposal=None, errors=errors)

    metadata = _stable_mapping(spec.get("metadata") or {})
    proposal_basis = {
        "title": title,
        "enabled": enabled,
        "cadence": cadence.to_dict(),
        "references": references.to_dict(),
        "issue_seed": issue_seed.to_dict(),
        "governance": governance.to_dict(),
        "context": context.to_dict(),
        "metadata": metadata,
    }
    idempotency_key = f"routine:{_stable_digest(proposal_basis)}"
    proposal = RoutineProposal(
        title=title,
        enabled=enabled,
        cadence=cadence,
        references=references,
        issue_seed=issue_seed,
        governance=governance,
        idempotency_key=idempotency_key,
        context=context,
        metadata=metadata,
    )
    if approvals:
        return RoutineAuthoringResult(
            status="requires_approval",
            proposal=proposal,
            approvals_required=approvals,
            warnings=warnings,
        )
    return RoutineAuthoringResult(
        status="ready" if enabled else "disabled",
        proposal=proposal,
        warnings=warnings,
    )


def _normalize_cadence(raw: Any) -> tuple[RoutineCadence | None, str | None]:
    if raw is None:
        return None, "cadence is required"
    if isinstance(raw, Mapping):
        timezone = _text(raw.get("timezone") or "UTC") or "UTC"
        if "cron" in raw or raw.get("kind") == "cron":
            expression = _text(raw.get("cron") or raw.get("expression"))
            interval, error = _parse_simple_cron(expression)
            if error:
                return None, error
            return RoutineCadence(kind="cron", interval_sec=interval, expression=expression, timezone=timezone), None
        interval_raw = raw.get("interval_sec", raw.get("every", raw.get("interval")))
        interval, error = _parse_interval(interval_raw)
        if error:
            return None, error
        return RoutineCadence(kind="interval", interval_sec=interval, expression=f"every {interval}s", timezone=timezone), None
    if isinstance(raw, int):
        interval, error = _parse_interval(raw)
        if error:
            return None, error
        return RoutineCadence(kind="interval", interval_sec=interval, expression=f"every {interval}s"), None
    text = _text(raw)
    if len(text.split()) == 5:
        interval, error = _parse_simple_cron(text)
        if error:
            return None, error
        return RoutineCadence(kind="cron", interval_sec=interval, expression=text), None
    interval, error = _parse_interval(text)
    if error:
        return None, error
    return RoutineCadence(kind="interval", interval_sec=interval, expression=f"every {interval}s"), None


def _parse_interval(raw: Any) -> tuple[int, str | None]:
    if isinstance(raw, bool) or raw is None:
        return 0, "interval cadence must be a positive duration"
    if isinstance(raw, int):
        seconds = raw
    else:
        match = _DURATION_RE.match(str(raw))
        if not match:
            return 0, f"invalid interval cadence: {raw!r}"
        seconds = int(match.group("count"))
        unit = match.group("unit") or "s"
        if unit.startswith("m"):
            seconds *= 60
        elif unit.startswith("h"):
            seconds *= 60 * 60
        elif unit.startswith("d"):
            seconds *= 24 * 60 * 60
    if seconds < MIN_INTERVAL_SEC:
        return seconds, f"routine interval must be at least {MIN_INTERVAL_SEC} seconds"
    if seconds > MAX_INTERVAL_SEC:
        return seconds, f"routine interval must be at most {MAX_INTERVAL_SEC} seconds"
    return seconds, None


def _parse_simple_cron(expression: str) -> tuple[int, str | None]:
    parts = expression.split()
    if len(parts) != 5:
        return 0, "cron cadence must have five fields"
    minute, hour, day, month, weekday = parts
    if day != "*" or month != "*" or weekday != "*":
        return 0, "cron cadence only supports minute/hour schedules"
    if minute.startswith("*/") and hour == "*":
        return _parse_interval(f"{minute[2:]}m")
    if minute == "0" and hour.startswith("*/"):
        return _parse_interval(f"{hour[2:]}h")
    if _is_int(minute) and hour == "*":
        return 60 * 60, None
    if _is_int(minute) and _is_int(hour):
        return 24 * 60 * 60, None
    return 0, f"unsupported cron cadence: {expression!r}"


def _normalize_references(spec: Mapping[str, Any]) -> RoutineReferences:
    refs = spec.get("references") or {}
    if not isinstance(refs, Mapping):
        refs = {}
    return RoutineReferences(
        owner_id=_text(refs.get("owner_id") or spec.get("owner_id")),
        company_profile_id=_text(refs.get("company_profile_id") or spec.get("company_profile_id")),
        workspace_id=_text(refs.get("workspace_id") or spec.get("workspace_id")),
        agent_profile_id=_text(refs.get("agent_profile_id") or spec.get("agent_profile_id")),
    )


def _validate_references(
    references: RoutineReferences,
    errors: list[str],
    *,
    known_companies: Iterable[str] | None,
    known_workspaces: Iterable[str] | None,
    known_agents: Iterable[str] | None,
    agent_company_map: Mapping[str, str] | None,
    workspace_company_map: Mapping[str, str] | None,
) -> None:
    for field_name, value in references.to_dict().items():
        if not value:
            errors.append(f"{field_name} is required")
    if errors:
        return
    if known_companies is not None and references.company_profile_id not in set(known_companies):
        errors.append(f"unknown company_profile_id: {references.company_profile_id}")
    if known_workspaces is not None and references.workspace_id not in set(known_workspaces):
        errors.append(f"unknown workspace_id: {references.workspace_id}")
    if known_agents is not None and references.agent_profile_id not in set(known_agents):
        errors.append(f"unknown agent_profile_id: {references.agent_profile_id}")
    if agent_company_map is not None:
        company = agent_company_map.get(references.agent_profile_id)
        if company != references.company_profile_id:
            errors.append("agent_profile_id does not belong to company_profile_id")
    if workspace_company_map is not None:
        company = workspace_company_map.get(references.workspace_id)
        if company != references.company_profile_id:
            errors.append("workspace_id does not belong to company_profile_id")


def _normalize_issue_seed(raw: Any) -> RoutineIssueSeed:
    if not isinstance(raw, Mapping):
        raw = {}
    return RoutineIssueSeed(
        title=_text(raw.get("title")),
        description=_text(raw.get("description")),
        priority=_text(raw.get("priority") or "medium") or "medium",
        metadata=_stable_mapping(raw.get("metadata") or {}),
    )


def _normalize_context(raw: Any) -> RoutineContextSelection:
    """Normalize the per-fire equipment selection, preserving None vs [].

    Returns axes as ``None`` (key absent → inherit/no-narrow), or a cleaned,
    order-preserving, de-duplicated list (key present → narrow to that subset,
    ``[]`` included = narrow to nothing). A non-mapping ``context`` (or absent)
    yields both axes ``None`` (no narrowing) — never a falsy collapse that would
    amplify equipment.
    """
    if not isinstance(raw, Mapping):
        return RoutineContextSelection()

    def _axis(*keys: str) -> list[str] | None:
        for key in keys:
            if key in raw:
                value = raw.get(key)
                # An explicit ``null`` is treated like an ABSENT axis (inherit) —
                # both mean "not specified". This also keeps the None→null→None
                # round-trip stable through to_dict()/from-dict re-authoring.
                if value is None:
                    return None
                # A present, non-null value is an explicit selection (``[]``
                # included = narrow to nothing). Clean + de-dupe but KEEP [] as [];
                # never turn a present-empty list into None (that would amplify).
                return list(dict.fromkeys(_string_items(value)))
        return None  # key absent on every alias → do not narrow this axis

    return RoutineContextSelection(
        plugin_ids=_axis("plugin_ids", "pluginIds", "plugins"),
        skill_ids=_axis("skill_ids", "skillIds", "skills"),
    )


def _normalize_governance(
    raw: Mapping[str, Any],
    *,
    default_max_budget_seconds: int,
    default_max_token_budget: int,
) -> RoutineGovernance:
    risk_flags = _risk_flags(raw)
    approval_grants = sorted(_canonical_flag(item) for item in _string_items(raw.get("approval_grants")))
    requested_budget_seconds = _non_negative_int(
        raw.get("requested_budget_seconds", raw.get("budget_seconds", 0))
    )
    max_budget_seconds = _non_negative_int(raw.get("max_budget_seconds", default_max_budget_seconds))
    requested_token_budget = _non_negative_int(raw.get("requested_token_budget", raw.get("token_budget", 0)))
    max_token_budget = _non_negative_int(raw.get("max_token_budget", default_max_token_budget))
    return RoutineGovernance(
        risk_flags=sorted(risk_flags),
        approval_grants=approval_grants,
        requested_budget_seconds=requested_budget_seconds,
        max_budget_seconds=max_budget_seconds,
        requested_token_budget=requested_token_budget,
        max_token_budget=max_token_budget,
        metadata=_stable_mapping(raw.get("metadata") or {}),
    )


def _risk_flags(raw: Mapping[str, Any]) -> set[str]:
    flags = {_canonical_flag(item) for item in _string_items(raw.get("risk_flags"))}
    flags.update(_canonical_flag(item) for item in _string_items(raw.get("requested_permissions")))
    side_effects = raw.get("side_effects") or {}
    if isinstance(side_effects, Mapping):
        for key, value in side_effects.items():
            if bool(value):
                flags.add(_canonical_flag(str(key)))
    if bool(raw.get("workspace_writes") or raw.get("workspace_write")):
        flags.add("workspace_write")
    if bool(raw.get("persistent_side_effects") or raw.get("persistent_side_effect")):
        flags.add("persistent_side_effect")
    network = _text(raw.get("network") or raw.get("network_policy") or raw.get("network_access"))
    if network and network not in {"none", "restricted", "false"}:
        flags.add("network_access")
    return flags


def _unsafe_governance_errors(governance: RoutineGovernance) -> list[str]:
    flags = set(governance.risk_flags)
    errors = []
    bypass = sorted(flags & _UNSAFE_BYPASS_FLAGS)
    if bypass:
        errors.append(f"unsafe approval bypass flags are forbidden: {', '.join(bypass)}")
    return errors


def _required_approvals(
    governance: RoutineGovernance,
    references: RoutineReferences,
    title: str,
) -> list[RoutineApprovalRequirement]:
    grants = set(governance.approval_grants)
    requirements: list[RoutineApprovalRequirement] = []
    for flag in sorted(set(governance.risk_flags) & _HIGH_RISK_FLAGS):
        if flag not in grants:
            requirements.append(_approval("permission_grant", flag, references, title))
    if (
        governance.max_budget_seconds
        and governance.requested_budget_seconds > governance.max_budget_seconds
        and "budget_override" not in grants
    ):
        requirements.append(_approval("budget_override", "budget_seconds", references, title))
    if (
        governance.max_token_budget
        and governance.requested_token_budget > governance.max_token_budget
        and "budget_override" not in grants
    ):
        requirements.append(_approval("budget_override", "token_budget", references, title))
    return requirements


def _approval(
    approval_type: str,
    reason: str,
    references: RoutineReferences,
    title: str,
) -> RoutineApprovalRequirement:
    return RoutineApprovalRequirement(
        type=approval_type,
        reason=f"routine {title!r} requests {reason}",
        requested_permission={"routine_authoring": reason},
        affects={
            "company_profile_id": references.company_profile_id,
            "workspace_id": references.workspace_id,
            "agent_profile_id": references.agent_profile_id,
        },
    )


def _text(value: Any) -> str:
    return str(value or "").strip()


def _bool(value: Any, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def _is_int(value: str) -> bool:
    try:
        int(value)
    except ValueError:
        return False
    return True


def _string_items(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Iterable) and not isinstance(value, Mapping):
        return [_text(item) for item in value if _text(item)]
    return [_text(value)]


def _canonical_flag(value: str) -> str:
    flag = _text(value).lower().replace("-", "_").replace(" ", "_")
    return _RISK_ALIASES.get(flag, flag)


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or value is None or value == "":
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def _stable_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return json.loads(json.dumps(dict(value), ensure_ascii=False, sort_keys=True, default=str))


def _stable_digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
