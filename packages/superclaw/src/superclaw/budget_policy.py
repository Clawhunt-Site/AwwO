from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Literal

from superclaw.models import CostMeterKind
from superclaw.state import StateStore

BudgetScope = Literal["company", "agent", "issue", "chat"]

_METRIC_TO_SUMMARY_KEY = {
    "token_budget": "total_tokens",
    "run_count_budget": "event_count",
    "external_tool_budget": "external_tool_count",
    "cost_cents_budget": "total_cost_cents",
}


def _non_negative_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(parsed, 0)


@dataclass(frozen=True)
class BudgetLimit:
    """One budget layer. Zero means unbounded for that metric."""

    token_budget: int = 0
    run_count_budget: int = 0
    external_tool_budget: int = 0
    cost_cents_budget: int = 0
    source: str = "manual"

    @classmethod
    def from_mapping(cls, data: dict[str, Any] | None, *, source: str = "manual") -> "BudgetLimit":
        raw = dict(data or {})
        return cls(
            token_budget=_non_negative_int(raw.get("token_budget", raw.get("default_token_budget"))),
            run_count_budget=_non_negative_int(raw.get("run_count_budget")),
            external_tool_budget=_non_negative_int(raw.get("external_tool_budget")),
            cost_cents_budget=_non_negative_int(raw.get("cost_cents_budget")),
            source=str(raw.get("source") or source),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BudgetUsage:
    metric: str
    used: int
    limit: int
    remaining: int
    ratio: float
    exceeded: bool
    source: str = "effective"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BudgetSnapshot:
    scope: BudgetScope
    scope_id: str
    cost_governed: bool
    summary: dict[str, Any]
    hard_limit: BudgetLimit = field(default_factory=BudgetLimit)
    soft_limit: BudgetLimit = field(default_factory=BudgetLimit)
    limit_layers: tuple[BudgetLimit, ...] = ()
    soft_warning_threshold: float = 0.8

    def burn_down(self, *, hard: bool = True) -> list[BudgetUsage]:
        limit = self.hard_limit if hard else self.soft_limit
        source = "hard" if hard else "soft"
        rows: list[BudgetUsage] = []
        for metric, summary_key in _METRIC_TO_SUMMARY_KEY.items():
            configured = getattr(limit, metric)
            if configured <= 0:
                continue
            used = _non_negative_int(self.summary.get(summary_key))
            remaining = max(configured - used, 0)
            rows.append(
                BudgetUsage(
                    metric=metric,
                    used=used,
                    limit=configured,
                    remaining=remaining,
                    ratio=used / configured,
                    exceeded=used >= configured,
                    source=source,
                )
            )
        return rows

    def soft_warnings(self) -> list[BudgetUsage]:
        warnings: list[BudgetUsage] = []
        for row in self.burn_down(hard=False):
            if row.exceeded or row.ratio >= self.soft_warning_threshold:
                warnings.append(row)
        if warnings:
            return warnings
        for row in self.burn_down(hard=True):
            if row.ratio >= self.soft_warning_threshold:
                warnings.append(row)
        return warnings

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "scope_id": self.scope_id,
            "cost_governed": self.cost_governed,
            "summary": dict(self.summary),
            "hard_limit": self.hard_limit.to_dict(),
            "soft_limit": self.soft_limit.to_dict(),
            "limit_layers": [layer.to_dict() for layer in self.limit_layers],
            "soft_warning_threshold": self.soft_warning_threshold,
            "burn_down": [row.to_dict() for row in self.burn_down()],
            "soft_warnings": [row.to_dict() for row in self.soft_warnings()],
        }


@dataclass(frozen=True)
class BudgetDecision:
    allowed: bool
    scope: BudgetScope
    scope_id: str
    reason_code: str
    message: str
    hard_gate: bool = True
    cost_governed: bool = False
    exceeded: tuple[BudgetUsage, ...] = ()
    warnings: tuple[BudgetUsage, ...] = ()
    burn_down: tuple[BudgetUsage, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "scope": self.scope,
            "scope_id": self.scope_id,
            "reason_code": self.reason_code,
            "message": self.message,
            "hard_gate": self.hard_gate,
            "cost_governed": self.cost_governed,
            "exceeded": [row.to_dict() for row in self.exceeded],
            "warnings": [row.to_dict() for row in self.warnings],
            "burn_down": [row.to_dict() for row in self.burn_down],
        }


@dataclass(frozen=True)
class BudgetScopeCheck:
    scope: BudgetScope
    scope_id: str | None
    cost_governed: bool = False
    hard_limits: BudgetLimit | dict[str, Any] | None = None
    soft_limits: BudgetLimit | dict[str, Any] | None = None
    limit_layers: tuple[BudgetLimit | dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "scope_id": self.scope_id,
            "cost_governed": self.cost_governed,
            "hard_limits": _limit_to_dict(self.hard_limits),
            "soft_limits": _limit_to_dict(self.soft_limits),
            "limit_layers": [_limit_to_dict(layer) for layer in self.limit_layers],
        }


@dataclass(frozen=True)
class BudgetPreflight:
    allowed: bool
    action: str
    decisions: tuple[BudgetDecision, ...] = ()

    @property
    def blocked(self) -> tuple[BudgetDecision, ...]:
        return tuple(decision for decision in self.decisions if not decision.allowed)

    def to_dict(self) -> dict[str, Any]:
        blocked = self.blocked
        return {
            "allowed": self.allowed,
            "action": self.action,
            "reason_code": blocked[0].reason_code if blocked else "within_budget",
            "message": blocked[0].message if blocked else f"{self.action} allowed by budget preflight",
            "decisions": [decision.to_dict() for decision in self.decisions],
            "blocked": [decision.to_dict() for decision in blocked],
        }


class BudgetGateError(ValueError):
    def __init__(self, preflight: BudgetPreflight) -> None:
        self.preflight = preflight
        payload = preflight.to_dict()
        super().__init__(str(payload["message"]))


class BudgetPolicy:
    """Lightweight budget policy over the existing cost ledger summary."""

    def __init__(self, *, soft_warning_threshold: float = 0.8) -> None:
        if not 0 < soft_warning_threshold <= 1:
            raise ValueError("soft_warning_threshold must be in (0, 1]")
        self.soft_warning_threshold = soft_warning_threshold

    def build_snapshot(
        self,
        *,
        scope: BudgetScope,
        scope_id: str,
        summary: dict[str, Any],
        hard_limits: BudgetLimit | dict[str, Any] | None = None,
        soft_limits: BudgetLimit | dict[str, Any] | None = None,
        limit_layers: list[BudgetLimit | dict[str, Any]] | tuple[BudgetLimit | dict[str, Any], ...] = (),
        cost_governed: bool = False,
    ) -> BudgetSnapshot:
        hard_limit = self.effective_limit(limit_layers)
        if isinstance(hard_limits, BudgetLimit):
            hard_limit = hard_limits
        elif hard_limits is not None:
            hard_limit = BudgetLimit.from_mapping(hard_limits, source="hard")
        normalized_layers = tuple(self._coerce_limit(layer) for layer in limit_layers)
        soft_limit = self._coerce_limit(soft_limits, source="soft") if soft_limits is not None else BudgetLimit()
        return BudgetSnapshot(
            scope=scope,
            scope_id=scope_id,
            cost_governed=cost_governed,
            summary=dict(summary),
            hard_limit=hard_limit,
            soft_limit=soft_limit,
            limit_layers=normalized_layers,
            soft_warning_threshold=self.soft_warning_threshold,
        )

    def snapshot_from_store(
        self,
        store: StateStore,
        *,
        scope: BudgetScope,
        scope_id: str,
        hard_limits: BudgetLimit | dict[str, Any] | None = None,
        soft_limits: BudgetLimit | dict[str, Any] | None = None,
        limit_layers: list[BudgetLimit | dict[str, Any]] | tuple[BudgetLimit | dict[str, Any], ...] = (),
        cost_governed: bool = False,
    ) -> BudgetSnapshot:
        summary = _summarize_scope(store, scope=scope, scope_id=scope_id)
        return self.build_snapshot(
            scope=scope,
            scope_id=scope_id,
            summary=summary,
            hard_limits=hard_limits,
            soft_limits=soft_limits,
            limit_layers=limit_layers,
            cost_governed=cost_governed,
        )

    def summary(self, snapshot: BudgetSnapshot) -> dict[str, Any]:
        return snapshot.to_dict()

    def hard_gate(self, snapshot: BudgetSnapshot, *, action: str = "start") -> BudgetDecision:
        burn_down = tuple(snapshot.burn_down(hard=True))
        exceeded = tuple(row for row in burn_down if row.exceeded)
        warnings = tuple(snapshot.soft_warnings())
        if snapshot.cost_governed and not snapshot.scope_id:
            return BudgetDecision(
                allowed=False,
                scope=snapshot.scope,
                scope_id=snapshot.scope_id,
                reason_code="invalid_budget_scope",
                message=f"{action} blocked: missing {snapshot.scope} scope id for cost-governed action",
                cost_governed=True,
                exceeded=exceeded,
                warnings=warnings,
                burn_down=burn_down,
            )
        if snapshot.cost_governed and exceeded:
            metrics = ", ".join(f"{row.metric} {row.used}/{row.limit}" for row in exceeded)
            return BudgetDecision(
                allowed=False,
                scope=snapshot.scope,
                scope_id=snapshot.scope_id,
                reason_code="budget_limit_exceeded",
                message=f"{action} blocked: {snapshot.scope} {snapshot.scope_id} exceeded {metrics}",
                cost_governed=True,
                exceeded=exceeded,
                warnings=warnings,
                burn_down=burn_down,
            )
        return BudgetDecision(
            allowed=True,
            scope=snapshot.scope,
            scope_id=snapshot.scope_id,
            reason_code="within_budget",
            message=f"{action} allowed: {snapshot.scope} {snapshot.scope_id} is within configured budget",
            cost_governed=snapshot.cost_governed,
            warnings=warnings,
            burn_down=burn_down,
        )

    def effective_limit(
        self,
        layers: list[BudgetLimit | dict[str, Any]] | tuple[BudgetLimit | dict[str, Any], ...],
    ) -> BudgetLimit:
        normalized = [self._coerce_limit(layer) for layer in layers]
        if not normalized:
            return BudgetLimit(source="effective")
        values: dict[str, int] = {}
        for metric in _METRIC_TO_SUMMARY_KEY:
            candidates = [getattr(layer, metric) for layer in normalized if getattr(layer, metric) > 0]
            values[metric] = min(candidates) if candidates else 0
        return BudgetLimit(**values, source="effective")

    def _coerce_limit(self, value: BudgetLimit | dict[str, Any] | None, *, source: str = "manual") -> BudgetLimit:
        if isinstance(value, BudgetLimit):
            return value
        return BudgetLimit.from_mapping(value, source=source)


def hard_budget_preflight(
    store: StateStore,
    checks: Iterable[BudgetScopeCheck | dict[str, Any]],
    *,
    action: str = "start",
    policy: BudgetPolicy | None = None,
) -> BudgetPreflight:
    budget_policy = policy or BudgetPolicy()
    decisions: list[BudgetDecision] = []
    for raw in checks:
        check = _coerce_scope_check(raw)
        snapshot = budget_policy.snapshot_from_store(
            store,
            scope=check.scope,
            scope_id=str(check.scope_id or ""),
            hard_limits=check.hard_limits,
            soft_limits=check.soft_limits,
            limit_layers=check.limit_layers,
            cost_governed=check.cost_governed,
        )
        decision = budget_policy.hard_gate(snapshot, action=action)
        decisions.append(decision)
        if not decision.allowed:
            break
    return BudgetPreflight(
        allowed=all(decision.allowed for decision in decisions),
        action=action,
        decisions=tuple(decisions),
    )


def budget_limit_has_value(value: BudgetLimit | dict[str, Any] | None) -> bool:
    limit = value if isinstance(value, BudgetLimit) else BudgetLimit.from_mapping(value)
    return any(getattr(limit, metric) > 0 for metric in _METRIC_TO_SUMMARY_KEY)


def _coerce_scope_check(raw: BudgetScopeCheck | dict[str, Any]) -> BudgetScopeCheck:
    if isinstance(raw, BudgetScopeCheck):
        return raw
    limit_layers = raw.get("limit_layers") or ()
    return BudgetScopeCheck(
        scope=raw["scope"],
        scope_id=raw.get("scope_id"),
        cost_governed=bool(raw.get("cost_governed", False)),
        hard_limits=raw.get("hard_limits"),
        soft_limits=raw.get("soft_limits"),
        limit_layers=tuple(limit_layers),
    )


def _limit_to_dict(value: BudgetLimit | dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, BudgetLimit):
        return value.to_dict()
    return dict(value)


def _summarize_scope(store: StateStore, *, scope: BudgetScope, scope_id: str) -> dict[str, Any]:
    if scope == "company":
        return _with_external_tool_count(
            store.summarize_cost(company_profile_id=scope_id),
            store.list_cost_events(company_profile_id=scope_id),
        )
    if scope == "agent":
        return _with_external_tool_count(
            store.summarize_cost(agent_profile_id=scope_id),
            store.list_cost_events(agent_profile_id=scope_id),
        )
    if scope == "issue":
        return _with_external_tool_count(
            store.summarize_cost(issue_id=scope_id),
            store.list_cost_events(issue_id=scope_id),
        )
    if scope == "chat":
        return _with_external_tool_count(
            store.summarize_cost(chat_session_id=scope_id),
            store.list_cost_events(chat_session_id=scope_id),
        )
    raise ValueError(f"unknown budget scope: {scope!r}")


def _with_external_tool_count(summary: dict[str, Any], events: list[Any]) -> dict[str, Any]:
    enriched = dict(summary)
    enriched["external_tool_count"] = sum(
        1 for event in events if event.meter_kind == CostMeterKind.EXTERNAL_TOOL.value
    )
    return enriched
