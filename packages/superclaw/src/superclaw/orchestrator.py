from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

from superclaw import trace_context
from superclaw.adversarial import VerificationStrategy, default_verification_strategies
from superclaw.backends import WorkerBackend, WorkerLimits, backend_supports_containment, default_backends, select_backends
from superclaw.environment import default_artifact_dir
from superclaw.budget_policy import BudgetScopeCheck, budget_limit_has_value, hard_budget_preflight
from superclaw.containment import ContainmentPolicy, containment_denies_tool, resolve_containment_policy, resolve_for_workspace
from superclaw.context_pointers import ContextPointersCapture, capture_baseline, capture_context_pointers
from superclaw.cross_runtime_delegation import DelegationRequested, authorize_delegation_for_parent
from superclaw.harness import get_harness_profile
from superclaw.liveness import (
    EXECUTING_RUN_STATUSES,
    RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS,
    RUN_MUTATION_LEASE_TTL_SECONDS,  # noqa: F401 - re-exported; tests and callers patch/read it here
    effective_run_state,
    lease_stale_reason,
    lease_worker_process_is_dead,
)
from superclaw.diagnostics_owners import record_governance_decision
from superclaw.escalation import (
    EscalationDenied,
    EscalationPending,
    StoreNativeApprovalBroker,
    make_permission_escalation,
    native_approval_broker_enabled,
)
from superclaw.models import ArtifactRef, ChainVerdict, ChildAggregationPolicy, ChildExecution, CostEvent, EvidenceBundle, GoalSpec, NON_VERIFICATION_FINDING_NAMES, RunMutationLease, RunMutationMode, RunSession, RunStatus, TERMINAL_RUN_STATUSES, TaskGraph, TaskNode, TaskTopology, VerificationFinding, WorkerLease, WorkerResult, WorkerRole, _id
from superclaw.permissions import posture_denies_tool, posture_for_mode
from superclaw.prompt_contracts import PromptProjectionError
from superclaw.run_cancel import CancelResult, cancel_run_in_store
from superclaw.runtime import PermissionPolicy, runtime_manifest
from superclaw.runtime_config import delegation_enabled
from superclaw.state import StateStore
from superclaw.ui_contracts import build_agent_inventory

if TYPE_CHECKING:  # typing-only import; the runtime use is a lazy import inside the method
    from superclaw.company_scope import CompanyScope

# Logger for fail-open paths (e.g. the cost recorder and context-pointers
# capture) that must never abort a run but must also never swallow errors
# silently (project rule: no `except: pass`). A dropped CostEvent is lost
# billing/audit data, and a swallowed pointer/capture error hides real state.
_LOGGER = logging.getLogger("superclaw.orchestrator")


def _superclaw_runtime_version() -> str:
    """The installed runtime version, with the same fallback as the gate default."""
    from importlib.metadata import PackageNotFoundError, version

    from superclaw.plugin_proxy import DEFAULT_RUNTIME_VERSION

    try:
        return version("superclaw")
    except PackageNotFoundError:
        return DEFAULT_RUNTIME_VERSION


def _issue_equipment_constraints(
    issue: Any,
) -> tuple[frozenset[str] | None, frozenset[str] | None]:
    """Per-fire equipment narrowing carried by an issue (Paperclip routine.context).

    Reads ``issue.metadata.routine_context`` (snapshotted at routine
    materialization) and returns ``(plugin_constraint, skill_constraint)`` as the
    independent narrowing caps for :func:`team_kernel.build_agent_run_context`.
    Tri-state per axis, faithfully preserved:

    * axis absent (key missing) or explicit ``null`` → ``None`` — do NOT narrow
      (the run inherits the agent's full governed grants; legacy / no-context issues).
    * axis present and empty (``[]``) → an EMPTY frozenset — narrow to nothing
      (an explicit "zero"); never collapsed back to ``None`` (that would AMPLIFY).
    * axis present with ids → a frozenset of those ids — narrow to that subset.
    * axis present but MALFORMED (a non-list, non-null value) → an EMPTY frozenset
      (fail-CLOSED to nothing) — a garbled scoping directive must never widen back
      to the full grants.

    Fail-closed by construction: the caps only ever feed an ``∩`` downstream, so a
    routine can never name a plugin/skill its agent was not already granted — the
    intersection silently drops it. When there is NO ``routine_context`` at all the
    result is ``(None, None)`` (inherit — legacy / no-context issues); but a
    ``routine_context`` that IS present yet garbled (not an object) fails CLOSED to
    ``(empty, empty)`` rather than inheriting — a present-but-corrupt scoping
    directive is treated as "scope to nothing", never "scope to everything".
    """
    metadata = getattr(issue, "metadata", None)
    if not isinstance(metadata, dict) or "routine_context" not in metadata:
        return None, None  # no scoping directive at all → inherit
    routine_context = metadata.get("routine_context")
    if not isinstance(routine_context, dict):
        # A directive IS present but corrupt (not an object) → fail-closed to
        # nothing on both axes, not inherit-everything.
        return frozenset(), frozenset()

    def _axis(present: bool, value: Any) -> frozenset[str] | None:
        # Absent key (or explicit null) → inherit: a legitimate "no narrowing here".
        if not present or value is None:
            return None
        # Present list → narrow to it ([] = narrow to nothing).
        if isinstance(value, list):
            return frozenset(str(item) for item in value)
        # Present but MALFORMED (a non-list, non-null axis — a string / int / dict
        # from corrupt or tampered state) → fail-CLOSED to an empty set (narrow to
        # nothing), NOT inherit. A routine carrying a context block clearly meant to
        # scope; a garbled axis must never silently widen back to the full grants.
        return frozenset()

    return (
        _axis("plugin_ids" in routine_context, routine_context.get("plugin_ids")),
        _axis("skill_ids" in routine_context, routine_context.get("skill_ids")),
    )


def _permission_prompt(tool_name: str, args: dict, reserved_path: str | None) -> str:
    """Human-facing prompt for a permission escalation. Content is redacted/truncated
    so the durable record + surfaces never carry an unbounded tool payload."""
    if tool_name == "run_shell":
        command = str(args.get("command", "")).strip()
        if len(command) > 300:
            command = command[:300] + "…"
        return f"The agent requests to run a shell command:\n{command}"
    if tool_name == "write_file":
        target = reserved_path or str(args.get("path", ""))
        size = len(str(args.get("content", "")))
        kind = "a reserved/sensitive file" if reserved_path else "a file"
        return f"The agent requests to write {kind}: {target} ({size} bytes)"
    return f"The agent requests to use the tool '{tool_name}'."


def _metadata_hard_limits(metadata: dict[str, Any]) -> dict[str, Any]:
    raw = metadata.get("budget_policy") or metadata.get("budget")
    if not isinstance(raw, dict):
        return {}
    hard_limits = raw.get("hard_limits")
    return dict(hard_limits) if isinstance(hard_limits, dict) else {}


def _metadata_budget_policy(metadata: dict[str, Any]) -> dict[str, Any] | None:
    raw = metadata.get("budget_policy") or metadata.get("budget")
    if not isinstance(raw, dict):
        return None
    hard_limits = raw.get("hard_limits")
    if not isinstance(hard_limits, dict):
        hard_limits = raw
    soft_limits = raw.get("soft_limits") if isinstance(raw.get("soft_limits"), dict) else None
    limit_layers = raw.get("limit_layers") if isinstance(raw.get("limit_layers"), list) else ()
    return {
        "cost_governed": bool(raw.get("cost_governed", budget_limit_has_value(hard_limits))),
        "hard_limits": dict(hard_limits),
        "soft_limits": soft_limits,
        "limit_layers": tuple(limit_layers),
    }


# RUN_MUTATION_LEASE_TTL_SECONDS and the renew interval live in superclaw.liveness
# (re-exported above) so every surface judges lease freshness identically.


class ResourceLockManager:
    def __init__(self) -> None:
        self._locks: dict[str, WorkerLease] = {}
        self._guard = threading.Lock()

    def try_acquire(self, resource: str, *, owner: str) -> WorkerLease | None:
        with self._guard:
            if resource in self._locks:
                return None
            lease = WorkerLease(resource=resource, owner=owner)
            self._locks[resource] = lease
            return lease

    def release(self, lease: WorkerLease) -> None:
        with self._guard:
            current = self._locks.get(lease.resource)
            if current and current.lease_id == lease.lease_id:
                self._locks.pop(lease.resource, None)

    @contextmanager
    def acquire(self, resource: str, *, owner: str) -> Iterator[WorkerLease]:
        lease = self.try_acquire(resource, owner=owner)
        if lease is None:
            raise RuntimeError(f"resource already locked: {resource}")
        try:
            yield lease
        finally:
            self.release(lease)


class _DelegationSuspended(Exception):
    def __init__(self, result: "RunResult") -> None:
        super().__init__("cross-runtime delegation suspended parent run")
        self.result = result


class RunMutationLeaseRenewer:
    """Heartbeat the run-mutation lease while its owner is executing.

    A daemon thread bumps last_renewed_at at a fraction of the lease TTL (with
    jitter so concurrent runs don't write in lockstep). If the lease is lost to
    another writer the renewer stops silently — the owner's next CAS assert
    fails closed, which is the designed takeover signal.
    """

    def __init__(self, store: StateStore, run_id: str, lease: RunMutationLease) -> None:
        self._store = store
        self._run_id = run_id
        self._lease = lease
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "RunMutationLeaseRenewer":
        self._thread = threading.Thread(target=self._loop, name=f"lease-renew:{self._run_id}", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    def _loop(self) -> None:
        import random

        while not self._stop.wait(RUN_MUTATION_LEASE_RENEW_INTERVAL_SECONDS * random.uniform(0.8, 1.2)):
            try:
                self._store.renew_run_mutation_lease(
                    self._run_id,
                    lease_id=self._lease.lease_id,
                    owner=self._lease.owner,
                )
            except ValueError:
                return
            except Exception:
                # Transient storage hiccup: keep trying; staleness only sets in
                # after the full TTL elapses without a successful renewal.
                continue


@dataclass
class RunResult:
    session: RunSession
    task_graph: TaskGraph
    evidence: EvidenceBundle
    events: list[dict]


@dataclass
class ReconcileResult:
    run_id: str
    previous_status: str
    status: str
    classification: str
    resumable: bool
    detail: str


@dataclass
class ChildFanoutResult:
    parent_run_id: str
    parent_task_id: str
    policy: str
    succeeded: bool
    total: int
    completed: int
    failed: int
    children: list[dict[str, Any]]
    detail: str
    conflict: bool = False


class SuperClawOrchestrator:
    def __init__(
        self,
        store: StateStore,
        backends: dict[str, WorkerBackend] | None = None,
        *,
        max_subagent_depth: int = 1,
        verification_strategies: dict[str, VerificationStrategy] | None = None,
    ) -> None:
        self.store = store
        self.locks = ResourceLockManager()
        self.backends = backends or default_backends()
        # Injectable verification policy -> strategy registry (kept in-core).
        self.verification_strategies = verification_strategies or default_verification_strategies()
        self._threads: dict[str, threading.Thread] = {}
        self._threads_guard = threading.Lock()
        # Serializes parent run/evidence read-modify-writes when concurrent
        # fan-out children sync their outcome back to the parent.
        self._child_sync_guard = threading.RLock()
        # Maximum subagent nesting depth. Default 1 (one level of children);
        # raise it to controllably allow deeper subagent trees.
        self.max_subagent_depth = max(1, int(max_subagent_depth))

    @classmethod
    def from_path(cls, path: str | Path) -> "SuperClawOrchestrator":
        return cls(StateStore(path))

    # Backends that can consume a SuperClaw MCP proxy config. Others (bobo,
    # hermes-cli, openclaw) reject mcp_configs, so we must not inject into them.
    _MCP_CAPABLE_BACKENDS = {"codex", "codex-app-server", "claude"}

    def _team_bound_surface_stripped(self, permission_policy, allowed_plugin_ids, reason):
        """Fail-closed early-exit for a team-bound plugin projection.

        Every projection early-exit (disabled / non-MCP backend / failed / empty
        grant) must NOT leave a team-bound run with a pre-existing, un-narrowed
        plugin surface — its only legitimate surface is the granted-narrowed
        aggregate. For a team-bound run (``allowed_plugin_ids is not None``) strip
        any pre-existing ``mcp_configs``/``plugin_dirs``. A non-team run
        (``None``) is unchanged passthrough (zero behavioural change off the team
        path).
        """
        if allowed_plugin_ids is not None:
            base = permission_policy
            if base is not None and (base.mcp_configs or base.plugin_dirs):
                return replace(base, mcp_configs=[], plugin_dirs=[]), reason
            return base, None
        return permission_policy, None

    def _project_plugins_into_policy(
        self, permission_policy, selected_backends, artifact_dir, containment_policy=None, allowed_plugin_ids=None
    ):
        """Auto-project available plugins into the run's permission policy.

        Returns ``(policy, capabilities_note)``. Only injects when every selected
        backend can consume an MCP config; otherwise returns the policy unchanged
        so non-MCP backends (bobo/hermes/openclaw) are never broken. Gated by env
        ``SUPERCLAW_AUTO_PROJECT_PLUGINS`` (default on); fail-closed on any error.

        T11: under a low-trust review fence, plugin/MCP projection is SUPPRESSED and
        any pre-existing ``mcp_configs``/``plugin_dirs`` are stripped — the read-only
        sandbox flags do not bound an MCP/plugin tool surface (it can reach the
        data-plane network the fence denies), so admitting the run must also remove
        that surface, not just the built-in shell/write tools.

        ``allowed_plugin_ids`` (Agent Team Kernel §2.6 item 4 "装备投影"): when not
        None it narrows the projection to the team-bound agent's ``equipment.granted``
        plugin ids — an empty set projects nothing (fail-closed). None = non-team run,
        full entitled set as before (zero change for plain chat / generic delivery).
        """
        if containment_policy is not None and getattr(containment_policy, "is_low_trust", False):
            base = permission_policy
            if base is not None and (base.mcp_configs or base.plugin_dirs):
                base = replace(base, mcp_configs=[], plugin_dirs=[])
                return base, "containment: plugin/MCP tool surface suppressed under low-trust review fence"
            return base, None
        if os.environ.get("SUPERCLAW_AUTO_PROJECT_PLUGINS", "1").lower() not in {"1", "true", "yes", "on"}:
            # Projection disabled: a team-bound run must still not retain a
            # pre-existing un-narrowed plugin surface (fail-closed).
            return self._team_bound_surface_stripped(
                permission_policy,
                allowed_plugin_ids,
                "equipment: plugin projection disabled — pre-existing surface stripped for team-bound run",
            )
        if not selected_backends or not all(getattr(b, "name", "") in self._MCP_CAPABLE_BACKENDS for b in selected_backends):
            return self._team_bound_surface_stripped(
                permission_policy,
                allowed_plugin_ids,
                "equipment: selected backend cannot consume MCP — pre-existing surface stripped for team-bound run",
            )
        try:
            from superclaw.plugin_runtime_projection import build_runtime_plugin_policy_addition

            mode = os.environ.get("SUPERCLAW_PLUGIN_PROJECTION_MODE", "dispatch")
            mcp_path, note = build_runtime_plugin_policy_addition(
                artifact_dir=Path(artifact_dir),
                mode=mode if mode in {"dispatch", "full"} else "dispatch",
                public_key=os.environ.get("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"),
                # Project under the actual runtime version so the projection gate
                # and the proxy execution gate decide identically (release hygiene:
                # don't let them silently drift apart when the package is bumped).
                runtime_version=_superclaw_runtime_version(),
                allowed_plugin_ids=allowed_plugin_ids,
            )
        except Exception:
            # Projection failed: fail-closed. A team-bound run must not fall back to
            # a pre-existing un-narrowed surface (Codex R2 blocker).
            return self._team_bound_surface_stripped(
                permission_policy,
                allowed_plugin_ids,
                "equipment: plugin projection failed — pre-existing surface stripped (fail-closed)",
            )
        if not mcp_path:
            # Team-bound run with NO granted plugins (or projection produced nothing):
            # strip any pre-existing/injected MCP config + plugin_dirs so an un-granted
            # plugin cannot be reached through a leftover single-plugin config either.
            # Non-team run keeps today's behaviour (unchanged).
            return self._team_bound_surface_stripped(
                permission_policy,
                allowed_plugin_ids,
                "equipment: no granted plugins — pre-existing MCP/plugin surface stripped",
            )
        base = permission_policy or PermissionPolicy()
        if allowed_plugin_ids is not None:
            # Team-bound: the run's ONLY plugin surface is its granted-narrowed
            # aggregate. Replace mcp_configs (don't append) and drop plugin_dirs so a
            # pre-existing/injected single-plugin config cannot re-expose an un-granted
            # plugin alongside the narrowed aggregate.
            return replace(base, mcp_configs=[mcp_path], plugin_dirs=[]), note
        if mcp_path in base.mcp_configs:
            return base, note
        return replace(base, mcp_configs=[*base.mcp_configs, mcp_path]), note

    @staticmethod
    def _granted_plugin_ids(session: RunSession) -> frozenset[str] | None:
        """The plugin ids a TEAM-BOUND run is allowed to project (its agent's
        ``equipment.granted``), or None for a non-team run.

        Returns None when the run is not team-bound — a plain chat / generic
        delivery has no agent profile, so the full entitled plugin set is
        projected as before (zero behavioural change off the team path). A team-bound
        run returns its granted set, EMPTY INCLUDED: a CEO with no granted equipment
        gets ``frozenset()`` → the projection yields no plugins (fail-closed), instead
        of silently inheriting every entitled plugin. Malformed context fails closed
        to an empty set rather than None so a corrupt team run cannot widen itself."""
        ec = session.execution_context or {}
        # Priority 1: agent_run_context.equipment.granted — a team-bound run or a
        # profile cross-runtime delegation (already capped to parent ∩ profile by
        # _create_linked_child, so it is the SINGLE source). Present-but-malformed
        # fails closed.
        ctx = ec.get("agent_run_context")
        if isinstance(ctx, dict) and ctx:
            equipment = ctx.get("equipment")
            if not isinstance(equipment, dict):
                return frozenset()
            granted = equipment.get("granted")
            if not isinstance(granted, (list, tuple, set, frozenset)):
                return frozenset()
            # A mixed-malformed collection (any dirty element) fails closed — never
            # silently filter dirty/corrupt state into a usable grant (laundering).
            if not all(isinstance(pid, str) and pid.strip() for pid in granted):
                return frozenset()
            # A tool-skill (a skill-origin package equipped via skill_allowlist)
            # executes through the SAME aggregate MCP proxy as a plugin, so its id
            # must ALSO be projected — otherwise a team-bound agent granted a
            # tool-skill could never call it (the projection narrows strictly to this
            # set). Union in equipment.skills.granted: a tool-skill is in
            # available_plugins and gets projected; a prose skill is absent from
            # available_plugins so it is a harmless no-op at the narrow. The plugin
            # grant itself still EXCLUDES skill-origin ids (resolve_equipment), so a
            # skill is never granted AS plugin equipment — it is projected only for
            # its own skill_allowlist-granted execution. Same fail-closed rules.
            allowed = set(granted)
            skills = equipment.get("skills")
            if skills is not None:
                if not isinstance(skills, dict):
                    return frozenset()
                skills_granted = skills.get("granted")
                if not isinstance(skills_granted, (list, tuple, set, frozenset)):
                    return frozenset()
                if not all(isinstance(sid, str) and sid.strip() for sid in skills_granted):
                    return frozenset()
                allowed |= set(skills_granted)
            return frozenset(allowed)
        # A PROFILE/TEAM signal (agent_profile_id or agent_run_context) without a
        # valid equipment.granted above MUST fail closed — never fall through to
        # delegated_plugin_grants. That cap is parent∩profile (WIDER than the
        # resolved equipment.granted = resolve∩cap) and is reserved for NO-PROFILE
        # delegation only. This guards the except-swallowed build_agent_run_context
        # path (a profile child whose agent_run_context is missing/empty/malformed
        # must get NOTHING, not the broader cap). [Codex R2 blocker]
        if "agent_profile_id" in ec or "agent_run_context" in ec:
            return frozenset()
        # Priority 2 (layer 3): delegated_plugin_grants — a NO-PROFILE cross-runtime
        # delegation's plugin cap (plugin_id semantics; NEVER read delegated_tools,
        # which is core-tool names, as plugin ids). None = inherited from a non-team
        # parent (no narrowing, non-team parity); a collection = narrow to it;
        # malformed = fail-closed.
        if "delegated_plugin_grants" in ec:
            cap = ec.get("delegated_plugin_grants")
            if cap is None:
                return None
            if isinstance(cap, (list, tuple, set, frozenset)):
                # Mixed-malformed collection fails closed (no laundering of dirty grant).
                if not all(isinstance(p, str) and p.strip() for p in cap):
                    return frozenset()
                return frozenset(cap)
            return frozenset()
        # Priority 3: a team/delegation SIGNAL with no usable grant → fail-closed
        # (a corrupt team/delegated run — e.g. an empty/malformed agent_run_context,
        # or a delegation with no plugin grant — must never widen to the full set).
        if (
            "agent_profile_id" in ec
            or "agent_run_context" in ec
            or "delegation_depth" in ec
            or "origin_run_id" in ec
        ):
            return frozenset()
        # Priority 4: a plain non-team / non-delegated run → None (full entitled set,
        # zero behavioural change off the team path).
        return None

    def _run_principal(self, session: RunSession) -> str:
        """The principal a run's escalations are bound to (and resolvable by). For
        the local single-user instance this is the bootstrapped admin ``local_user``;
        a team-bound run may carry an explicit principal in its execution context."""
        return str((session.execution_context or {}).get("principal") or "local_user")

    def _runtime_budget_checks(self, session: RunSession, context: dict[str, Any]) -> list[BudgetScopeCheck]:
        checks = self._explicit_budget_checks(session, context)
        company_id = context.get("company_profile_id")
        profile_id = context.get("agent_profile_id")
        if profile_id:
            try:
                profile = self.store.get_agent_profile(str(profile_id))
            except KeyError:
                profile = None
            if profile is not None:
                company_id = company_id or profile.company_profile_id
                hard_limits = {
                    "token_budget": profile.token_budget,
                    "run_count_budget": profile.run_count_budget,
                    "external_tool_budget": profile.external_tool_budget,
                }
                hard_limits.update(_metadata_hard_limits(profile.metadata))
                if budget_limit_has_value(hard_limits):
                    checks.append(
                        BudgetScopeCheck(
                            scope="agent",
                            scope_id=profile.profile_id,
                            cost_governed=True,
                            hard_limits=hard_limits,
                        )
                    )
        if company_id:
            try:
                company = self.store.get_company_profile(str(company_id))
            except KeyError:
                company = None
            if company is not None:
                hard_limits = {"token_budget": company.default_token_budget}
                hard_limits.update(_metadata_hard_limits(company.metadata))
                if budget_limit_has_value(hard_limits):
                    checks.append(
                        BudgetScopeCheck(
                            scope="company",
                            scope_id=company.company_profile_id,
                            cost_governed=True,
                            hard_limits=hard_limits,
                        )
                    )
        issue_id = context.get("issue_id")
        if issue_id:
            try:
                issue = self.store.get_issue(str(issue_id))
            except KeyError:
                issue = None
            if issue is not None:
                policy = _metadata_budget_policy(issue.metadata)
                if policy is not None:
                    checks.append(
                        BudgetScopeCheck(
                            scope="issue",
                            scope_id=issue.issue_id,
                            cost_governed=policy["cost_governed"],
                            hard_limits=policy["hard_limits"],
                            soft_limits=policy["soft_limits"],
                            limit_layers=policy["limit_layers"],
                        )
                    )
        return checks

    def _explicit_budget_checks(self, session: RunSession, context: dict[str, Any]) -> list[BudgetScopeCheck]:
        raw_policy = context.get("budget_policy")
        if not isinstance(raw_policy, dict):
            return []
        raw_scopes = raw_policy.get("scopes") or ()
        checks: list[BudgetScopeCheck] = []
        for raw_scope in raw_scopes:
            if not isinstance(raw_scope, dict) or raw_scope.get("scope") not in {"company", "agent", "issue", "chat"}:
                continue
            scope = raw_scope["scope"]
            hard_limits = raw_scope.get("hard_limits")
            if not isinstance(hard_limits, dict):
                hard_limits = raw_scope
            soft_limits = raw_scope.get("soft_limits") if isinstance(raw_scope.get("soft_limits"), dict) else None
            limit_layers = raw_scope.get("limit_layers") if isinstance(raw_scope.get("limit_layers"), list) else ()
            checks.append(
                BudgetScopeCheck(
                    scope=scope,
                    scope_id=raw_scope.get("scope_id") or self._budget_scope_id_from_context(session, context, scope),
                    cost_governed=bool(raw_scope.get("cost_governed", budget_limit_has_value(hard_limits))),
                    hard_limits=dict(hard_limits),
                    soft_limits=soft_limits,
                    limit_layers=tuple(limit_layers),
                )
            )
        return checks

    @staticmethod
    def _budget_scope_id_from_context(session: RunSession, context: dict[str, Any], scope: str) -> str | None:
        if scope == "company":
            return context.get("company_profile_id")
        if scope == "agent":
            return context.get("agent_profile_id")
        if scope == "issue":
            return context.get("issue_id")
        if scope == "chat":
            return session.chat_session_id or context.get("chat_session_id")
        return None

    @staticmethod
    def _delegation_request_key(pending: DelegationRequested) -> str:
        if pending.parent_tool_call_id:
            return f"tool:{pending.parent_tool_call_id}"
        payload = {
            "request": pending.request.__dict__,
            "parent_tool_call_id": pending.parent_tool_call_id,
        }
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        return f"request:{digest}"

    @staticmethod
    def _delegation_waits(session: RunSession) -> list[dict[str, Any]]:
        raw = (session.execution_context or {}).get("child_delegation_waits")
        return [dict(item) for item in raw] if isinstance(raw, list) else []

    @staticmethod
    def _delegation_tool_results(session: RunSession) -> list[dict[str, Any]]:
        raw = (session.execution_context or {}).get("delegate_tool_results")
        return [dict(item) for item in raw] if isinstance(raw, list) else []

    def _register_run_thread(self, run_id: str, thread: threading.Thread) -> None:
        with self._threads_guard:
            self._threads[run_id] = thread

    def _run_thread(self, run_id: str) -> threading.Thread | None:
        with self._threads_guard:
            return self._threads.get(run_id)

    def _build_delegate_tool_result(
        self,
        *,
        parent_session: RunSession,
        wait: dict[str, Any],
        child_execution: ChildExecution,
        child_session: RunSession,
    ) -> dict[str, Any]:
        output_parts: list[str] = []
        try:
            child_evidence = self.store.get_evidence(child_session.run_id)
        except (KeyError, json.JSONDecodeError, TypeError, ValueError):
            child_evidence = None
        if child_evidence is not None:
            for worker_result in child_evidence.worker_results[-3:]:
                if worker_result.output:
                    output_parts.append(str(worker_result.output))
        output = "\n".join(output_parts)
        if len(output) > 4000:
            # Keep the tail: child workers usually finish with the actionable
            # summary/error, while the evidence artifact preserves the full body.
            output = output[-4000:]
        # Surface the child's changed-file pointers so the resuming parent LLM can
        # integrate incrementally instead of re-reading the whole tree (§2.7 ②).
        raw_pointers = (child_evidence.backend_summary or {}).get("context_pointers") if child_evidence else None
        pointers = ContextPointersCapture.from_dict(raw_pointers)
        summary = (
            f"Delegated child {child_session.run_id} finished with status "
            f"{child_session.status} and chain verdict {child_execution.chain_verdict or 'unknown'}."
        )
        # Only annotate when pointers were actually captured for this child; an
        # absent record must not render a misleading "UNKNOWN, re-scan".
        pointer_brief = pointers.render_brief() if raw_pointers is not None else None
        if pointer_brief:
            summary = f"{summary} {pointer_brief}"
        content_pointers = pointers.to_dict() if raw_pointers is not None else None
        return {
            "tool_name": "delegate",
            "tool_call_id": wait.get("parent_tool_call_id"),
            "request_key": wait.get("request_key"),
            "status": "pending_review",
            "parent_run_id": parent_session.run_id,
            "parent_task_id": wait.get("parent_task_id"),
            "child_run_id": child_session.run_id,
            "child_task_id": wait.get("child_task_id") or child_execution.child_task_id,
            "child_status": child_session.status,
            "chain_verdict": child_execution.chain_verdict,
            "evidence_artifact_id": child_execution.evidence_artifact_id,
            "evidence_path": child_execution.evidence_path,
            "content": {
                "summary": summary,
                "output": output,
                "context_pointers": content_pointers,
            },
            "review": None,
        }

    def _upsert_delegate_tool_result(self, session: RunSession, result: dict[str, Any]) -> list[dict[str, Any]]:
        request_key = result.get("request_key")
        results = self._delegation_tool_results(session)
        for index, existing in enumerate(results):
            if existing.get("request_key") == request_key:
                # Preserve an already reviewed decision. Child terminal re-sync may
                # happen more than once, but it must not reopen a human decision.
                if existing.get("status") in {"approved", "rejected"}:
                    return results
                merged = {**existing, **result}
                results[index] = merged
                return results
        results.append(result)
        return results

    def _pending_delegate_result_reviews(self, session: RunSession) -> list[dict[str, Any]]:
        return [
            result
            for result in self._delegation_tool_results(session)
            if result.get("status") == "pending_review"
        ]

    def _active_delegate_waits(self, session: RunSession) -> list[dict[str, Any]]:
        active: list[dict[str, Any]] = []
        for wait_record in self._delegation_waits(session):
            if wait_record.get("tool_result_status") in {"approved", "rejected"}:
                continue
            child_run_id = wait_record.get("child_run_id")
            if not isinstance(child_run_id, str) or not child_run_id:
                active.append(wait_record)
                continue
            try:
                child = self.store.get_run(child_run_id)
            except KeyError:
                active.append(wait_record)
                continue
            if child.status not in TERMINAL_RUN_STATUSES:
                active.append(wait_record)
        return active

    def review_child_delegation_result(
        self,
        run_id: str,
        request_key: str,
        *,
        approved: bool,
        reviewed_by: str = "local_user",
    ) -> dict[str, Any]:
        """Human review gate for a completed delegated child result.

        Child completion only creates a pending delegate tool-result. A human (or
        a future API/CLI surface acting for one) must call this before the parent
        run can resume with that result in context.
        """
        status = "approved" if approved else "rejected"
        review = {"reviewed_by": reviewed_by, "approved": approved, "reviewed_at": time.time()}
        target_holder: dict[str, Any] = {}
        already_reviewed = False

        def ensure_rejection_evidence(target: dict[str, Any]) -> None:
            if target.get("status") != "rejected":
                return
            target_review = target.get("review") if isinstance(target.get("review"), dict) else {}
            target_reviewed_by = str(target_review.get("reviewed_by") or reviewed_by)
            try:
                evidence = self.store.get_evidence(run_id)
            except KeyError:
                evidence = self.store.create_evidence(run_id)
            evidence.add_finding(
                "cross_runtime_delegation_review",
                False,
                f"delegate result {request_key} rejected by {target_reviewed_by}",
                "high",
            )
            self.store.save_evidence(evidence)

        def mutate(session: RunSession) -> RunSession:
            nonlocal already_reviewed
            waits = self._delegation_waits(session)
            results = self._delegation_tool_results(session)
            target = next((item for item in results if item.get("request_key") == request_key), None)
            if target is None:
                raise ValueError(f"no delegate tool result awaiting review for {request_key}")
            if target.get("status") not in {"pending_review", "approved", "rejected"}:
                raise ValueError(f"delegate tool result has invalid status {target.get('status')!r}")
            if target.get("status") in {"approved", "rejected"}:
                already_reviewed = True
                target_holder.update(target)
                return session
            if session.status != RunStatus.WAITING_FOR_CHILD_DELEGATION.value:
                raise ValueError(f"cannot review delegate result for run in status {session.status!r}")

            reviewed_target = {**target, "status": status, "review": review}
            results = [reviewed_target if item.get("request_key") == request_key else item for item in results]
            for wait_record in waits:
                if wait_record.get("request_key") == request_key:
                    wait_record["tool_result_status"] = status
                    wait_record["status"] = "review_approved" if approved else "review_rejected"
                    wait_record["reviewed_by"] = reviewed_by
                    wait_record["reviewed_at"] = review["reviewed_at"]
            context = dict(session.execution_context or {})
            context["delegate_tool_results"] = results
            context["child_delegation_waits"] = waits
            session.execution_context = context
            if not approved:
                session.status = RunStatus.FAILED.value
            target_holder.update(reviewed_target)
            return session

        self.store.mutate_run(run_id, mutate)
        target = dict(target_holder)
        ensure_rejection_evidence(target)
        if already_reviewed:
            return target

        self.store.add_event(
            run_id,
            f"delegation.tool_result.{status}",
            {
                "request_key": request_key,
                "child_run_id": target.get("child_run_id"),
                "reviewed_by": reviewed_by,
            },
        )
        return target

    def _parent_effective_delegate_tools(
        self,
        *,
        permission_policy: PermissionPolicy | None,
        containment_policy: ContainmentPolicy | None,
    ) -> frozenset[str]:
        mode = permission_policy.mode if permission_policy else None
        posture = posture_for_mode(mode)
        candidates = {"read_file", "list_files", "write_file", "run_shell"}
        allowed = {
            tool
            for tool in candidates
            if not posture_denies_tool(posture, tool)
            and not containment_denies_tool(containment_policy, tool, mode=mode)
        }
        return frozenset(allowed)

    def _is_pay_scan_sensitive(self, subtask: str) -> bool:
        text = subtask.casefold()
        sensitive_markers = (
            "pay",
            "payment",
            "purchase",
            "credit card",
            "card number",
            "scan",
            "ssn",
            "passport",
            "credential",
            "secret",
            "token",
        )
        return any(marker in text for marker in sensitive_markers)

    def _profile_or_none(self, profile_id: str):
        try:
            return self.store.get_agent_profile(profile_id)
        except KeyError:
            return None

    def _start_child_async(
        self,
        goal: GoalSpec,
        child_session: RunSession,
        exec_kwargs: dict[str, Any],
    ) -> None:
        # copy_context so the child thread inherits the parent trace context
        # (ContextVars don't cross threads); the choke point binds the child run_id.
        ctx = contextvars.copy_context()
        thread = threading.Thread(
            target=ctx.run,
            args=(self._execute_existing_session_guarded,),
            kwargs={"goal": goal, "session": child_session, **exec_kwargs},
            daemon=True,
        )
        self._register_run_thread(child_session.run_id, thread)
        thread.start()

    def _build_escalation_gate(self, session: RunSession):
        """Build the B-class tool escalation gate bound to this run's id + principal.

        The gate consumes an approved single-use grant for an exact action and
        returns (proceed), or records a durable PENDING escalation and raises
        EscalationPending so the run suspends for human review. This is the wiring
        of the roadmap §8.2 hard gate into the in-process tool layer."""
        run_id = session.run_id
        principal = self._run_principal(session)
        store = self.store

        def gate(tool_name: str, args: dict, reserved_path: str | None) -> None:
            # ONE atomic decision (consume approved grant / refuse sticky deny / reuse
            # or open a pending) under a single write lock — no races between a
            # standalone consume and opening a pending. Raises EscalationDenied for a
            # sticky human deny (the tool layer turns that into a fail-closed denial).
            request = make_permission_escalation(
                tool_name=tool_name,
                args=args,
                prompt_text=_permission_prompt(tool_name, args, reserved_path),
                principal=principal,
                run_id=run_id,
                reserved_path=reserved_path,
            )
            # §5④ governance-decision owner (P0b-2): project the gate verdict into the
            # telemetry view AFTER it is committed to state.db. The receipt carries the
            # AUTHORITATIVE row's request_id (the consumed grant / reused-or-new pending /
            # denied envelope) — NOT the freshly-minted request — so it joins back to the
            # state.db ledger. Recording never changes the verdict (see diagnostics_owners).
            try:
                decision, envelope = store.resolve_gate_decision(request)
            except EscalationDenied as exc:
                denied = exc.envelope
                record_governance_decision(
                    decision="denied",
                    tool_name=tool_name,
                    args_digest=denied.args_digest,
                    reason="sticky_human_deny",
                    request_id=denied.request_id,
                    principal=denied.principal,
                )
                raise
            record_governance_decision(
                decision=decision,
                tool_name=tool_name,
                args_digest=envelope.args_digest,
                request_id=envelope.request_id,
                principal=envelope.principal,
            )
            if decision == "allow":
                return  # an approved grant authorized this exact action — proceed
            raise EscalationPending(envelope)

        return gate

    def _respond_grant_issue_id(self, session: RunSession, company_id: str) -> str | None:
        """Compute the run-scoped respond grant for a CONFINED team run (#2).

        Returns the issue id this run may post a SINGLE non-owned comment on, or
        None when no grant applies. The grant is minted ONLY when ALL hold:

          * ``respond_mode`` is exactly True in the run's execution_context — the
            daemon's ``_respond`` path is the ONLY writer of this flag (injected
            via execution_context_extra); an agent cannot forge it from a tool arg.
          * ``issue_id`` is a non-blank string in execution_context (RunSession has
            no ``issue_id`` attribute — it is always read from execution_context).
          * That issue exists AND belongs to ``company_id`` (the run's confined
            home company). A cross-company issue id yields NO grant (fail-closed),
            so a respond run can never reach across the company boundary.

        Callers MUST gate this on the run being a confined team scope (NOT
        admin/operator): the grant is meaningless for the operator (who already
        owns everything) and minting one there would be a needless widening. The
        binding is derived here from trusted server state, never from a command
        body."""
        ec = session.execution_context or {}
        if ec.get("respond_mode") is not True:
            return None
        if not (isinstance(company_id, str) and company_id):
            return None
        issue_id = ec.get("issue_id")
        if not (isinstance(issue_id, str) and issue_id):
            return None
        try:
            issue = self.store.get_issue(issue_id)
        except KeyError:
            return None
        if issue.company_profile_id != company_id:
            return None
        return issue_id

    def _company_scope_for_run(self, session: RunSession) -> "CompanyScope":
        """Derive the server-injected company scope for THIS run (PR-F).

        Authority is NEVER taken from the model's tool args — it is derived here
        from the run's trusted execution context (design B8):

          * A TEAM/sub-agent run is CONFINED to its OWN company: ``is_admin=False``
            + ``allowed_company_ids = {home}``. A compromised/buggy sub-agent in
            company A therefore cannot target, mutate, or archive company B — the
            scope gate forbids cross-company targets for a non-admin.
          * The DIRECT user chat is the OPERATOR acting for the single owner of all
            companies, so it gets ``is_admin=True`` (design B8: "仅 operator 具
            admin scope 才可跨界"). The scope gate still enforces entity existence +
            same-origin correctness even for an admin.

        Team-signal detection is fail-closed and mirrors the equipment-projection
        guard (`_granted_plugin_ids`, orchestrator.py): the mere PRESENCE of an
        ``agent_run_context`` OR ``agent_profile_id`` KEY marks the run team-bound —
        regardless of the value. So an empty/malformed ``agent_run_context`` (``{}``
        / a non-dict / one with no usable profile id) can NEVER fall through to the
        operator-admin path; it stays a confined, fail-closed team scope (advisor
        finding #2 + its edge case).

        For a team run the home company is resolved AUTHORITATIVELY from the bound
        agent PROFILE (its persisted ``company_profile_id``) — NOT from an
        ``execution_context["company_profile_id"]`` that the run could carry for a
        different company (advisor finding #1, the cross-company fail-open). If the
        profile (or its company) cannot be resolved, the scope FAILS CLOSED to a
        sentinel that matches no real company, so an unresolved sub-agent can touch
        nothing at all."""
        from superclaw.company_scope import CompanyScope

        ec = session.execution_context or {}
        principal = self._run_principal(session)
        ctx = ec.get("agent_run_context")
        # Fail-closed team detection: KEY PRESENCE alone (any value) is a team
        # signal — matches _granted_plugin_ids so a malformed/empty context cannot
        # launder into operator-admin.
        is_team_run = "agent_run_context" in ec or "agent_profile_id" in ec
        profile_id = None
        if isinstance(ctx, dict):
            profile_id = ctx.get("agent_profile_id")
        if not (isinstance(profile_id, str) and profile_id):
            profile_id = ec.get("agent_profile_id")

        if is_team_run:
            # Home company resolves from the agent PROFILE — the only trusted
            # binding. An explicit execution_context company id is NOT used here:
            # it could name a DIFFERENT company than the agent's, which would scope
            # a company-A agent to company B (a cross-company write hole).
            home: str | None = None
            if isinstance(profile_id, str) and profile_id:
                try:
                    resolved = self.store.get_agent_profile(profile_id).company_profile_id
                except KeyError:
                    resolved = None
                if isinstance(resolved, str) and resolved:
                    home = resolved
            if home is None:
                # Fail-closed: an unresolved sub-agent company → a scope that
                # matches nothing (the gate forbids every concrete target).
                home = "__unresolved_company__"
            # The acting agent's identity is server-injected from the bound profile
            # id (柱子 1b autonomy门 reads it to enforce org-subtree confinement and
            # attribute comments). It is NEVER self-reported: only a profile id we
            # resolved above is passed; a blank/unresolved one degrades to None in
            # CompanyScope.__post_init__, which the autonomy门 fails closed on.
            acting_agent = profile_id if (isinstance(profile_id, str) and profile_id) else None
            # Run-scoped respond grant (#2): a respond run may comment ONCE on a
            # non-owned issue in its OWN company. Computed from trusted server
            # state (respond_mode + issue ownership-by-company), never self-reported.
            # Mirrors the A-class MCP ticket binding so B-class (in-loop) and
            # A-class (proxy) derive the SAME grant. Only minted for this confined
            # team scope — the operator branch below never gets one.
            respond_issue_id = self._respond_grant_issue_id(session, home)
            return CompanyScope(
                principal_id=principal,
                actor_company_id=home,
                allowed_company_ids=frozenset({home}),
                is_admin=False,
                actor_agent_profile_id=acting_agent,
                respond_issue_id=respond_issue_id,
                # Bind the scope to THIS run so the respond grant is single-use:
                # the autonomy门 consumes it in the store keyed by (run_id,
                # issue_id), capping a respond run at ONE non-owned comment.
                run_id=session.run_id,
            )

        # Direct user chat = the operator (single-user owns all companies).
        explicit_company = ec.get("company_profile_id")
        actor_company = (
            explicit_company if isinstance(explicit_company, str) and explicit_company else "local"
        )
        return CompanyScope(
            principal_id=principal,
            actor_company_id=actor_company,
            is_admin=True,
        )

    def _build_company_command_resolver(self, session: RunSession):
        """Build the in-loop company-command resolver bound to this run (PR-F).

        Mirrors ``_build_escalation_gate``'s shape: a closure capturing the store +
        the run's derived company scope + principal, injected into
        ``WorkerLimits.company_command_resolver`` so the B-class tool layer — which
        has no StateStore — can execute a company command SYNCHRONOUSLY in the
        agent loop and return a model-facing result string.

        It NEVER raises into the agent loop: every outcome (executed /
        pending_approval / validation error / scope or lifecycle denial / kernel
        error) is mapped to a string. Malformed args (unknown fields rejected by
        the command model's fail-closed ``from_dict``) become an ``error:`` string,
        not a crashed run. The HARD governance (scope gate, lifecycle gate, and the
        risk gate that routes archive to a persisted human approval) lives in
        ``execute_company_command`` and runs unchanged here."""
        from superclaw.company_commands import get_command_model
        from superclaw.company_handler import execute_company_command
        from superclaw.company_lifecycle import CompanyFrozenError
        from superclaw.company_scope import CompanyScopeError

        store = self.store
        scope = self._company_scope_for_run(session)
        principal = self._run_principal(session)

        def resolver(command_type: str, args: dict) -> str:
            # Rebuild the typed command from the model's args (fail-closed on
            # unknown fields). A bad command_type / bad payload is a tool-level
            # error returned to the agent, never a run crash.
            try:
                model = get_command_model(command_type)
                command = model.from_dict(args)
            except (KeyError, ValueError, TypeError) as exc:
                return f"error: invalid company command ({command_type}): {exc}; do not retry"

            try:
                result = execute_company_command(
                    command, scope=scope, store=store, requested_by=principal
                )
            except CompanyScopeError as exc:
                return (
                    f"error: forbidden: {exc.reason}; this target is outside the "
                    f"current scope; do not retry"
                )
            except CompanyFrozenError as exc:
                return f"error: company is frozen/archived: {exc}; do not retry"
            except NotImplementedError as exc:
                return f"error: not supported yet: {exc}; do not retry"
            except (ValueError, KeyError) as exc:
                return f"error: company command failed: {type(exc).__name__}: {exc}; do not retry"
            except Exception as exc:  # noqa: BLE001 — never raise into the agent loop
                # Final catch-all (parity with the A-class proxy's outer guard): a
                # store/SQLite error or any unforeseen escape must read back as a
                # refusal string, never crash the run. Fail-closed.
                return f"error: company command failed: {type(exc).__name__}: {exc}; do not retry"

            if result.outcome == "executed":
                return json.dumps({"status": "executed", "detail": result.detail})
            # pending_approval (HIGH = archive): the handler has ALREADY recorded a
            # durable, human-decidable approval (surfaced via the existing
            # Web/CLI/SSE approval loop). The actual mutation has NOT happened. Tell
            # the agent UNAMBIGUOUSLY to STOP and not assume the company changed.
            approval_id = result.detail.get("approval_id")
            return json.dumps(
                {
                    "status": "pending_approval",
                    "approval_id": approval_id,
                    "executed": False,
                    "message": (
                        f"This is an irreversible action and was NOT executed. It "
                        f"has been queued for human approval (approval_id={approval_id}). "
                        f"STOP: do not assume the company was changed. Tell the user "
                        f"they must approve it in the Web UI or CLI approvals queue."
                    ),
                }
            )

        return resolver

    def _build_company_read_resolver(self, session: RunSession):
        """Build the in-loop company READ resolver bound to this run (roadmap P0).

        Mirrors ``_build_company_command_resolver`` but for the read half: a closure
        over the store + the run's derived company scope, injected into
        ``WorkerLimits.company_read_resolver`` so the B-class tool layer can run a
        discovery/snapshot read SYNCHRONOUSLY and return the DTO as a JSON string.

        It NEVER raises into the agent loop: a scope denial, an unknown company, a
        bad payload, or any kernel error all map to an ``error:`` string. Reads do
        NOT mutate — no risk gate, no approval, no lifecycle freeze — so the only
        hard gate is the SAME ``scope`` the mutation resolver uses (reused inside
        ``execute_company_read`` via ``scope.permits``), keeping read authority
        identical to write authority (no read-privilege bypass)."""
        from superclaw.company_read import execute_company_read, get_company_read_model
        from superclaw.company_scope import CompanyScopeError

        store = self.store
        scope = self._company_scope_for_run(session)

        def resolver(command_type: str, args: dict) -> str:
            try:
                model = get_company_read_model(command_type)
                read = model.from_dict(args)
            except (KeyError, ValueError, TypeError) as exc:
                return f"error: invalid company read ({command_type}): {exc}; do not retry"

            try:
                payload = execute_company_read(read, scope=scope, store=store)
            except CompanyScopeError as exc:
                return (
                    f"error: forbidden: {exc.reason}; this company is outside the "
                    f"current scope; do not retry"
                )
            except KeyError as exc:
                return f"error: company read failed: unknown entity {exc}; do not retry"
            except (ValueError, TypeError) as exc:
                return f"error: company read failed: {type(exc).__name__}: {exc}; do not retry"
            except Exception as exc:  # noqa: BLE001 — never raise into the agent loop
                # Final catch-all (parity with the A-class proxy's outer guard): a
                # store/SQLite error or any unforeseen escape must read back as a
                # refusal string, never crash the run. Fail-closed.
                return f"error: company read failed: {type(exc).__name__}: {exc}; do not retry"

            return json.dumps({"status": "ok", "data": payload})

        return resolver

    def _build_marketplace_command_resolver(self, session: RunSession):
        """Build the in-loop ClawHunt marketplace resolver bound to this run (P3).

        Mirrors ``_build_company_command_resolver``: a closure over the store + the
        run's derived company scope + principal, injected into
        ``WorkerLimits.marketplace_command_resolver`` so the B-class tool layer can
        run a marketplace command synchronously and return a model-facing string.

        It NEVER raises into the agent loop. Reads (browse/inspect) execute in-loop
        and return their result; writes return a pending-approval string (the remote
        ClawHunt action runs ONLY at human grant, never here). A missing agent key
        (``MarketplaceAuthError``), scope denial, or validation error all map to an
        ``error:`` string. The HARD governance (auth gate, scope gate, risk→approval)
        lives in ``execute_marketplace_command`` and runs unchanged."""
        from superclaw.company_scope import CompanyScopeError
        from superclaw.marketplace_commands import get_marketplace_command_model
        from superclaw.marketplace_handler import (
            MarketplaceAuthError,
            execute_marketplace_command,
        )

        store = self.store
        scope = self._company_scope_for_run(session)
        principal = self._run_principal(session)

        def resolver(command_type: str, args: dict) -> str:
            try:
                model = get_marketplace_command_model(command_type)
                command = model.from_dict(args)
            except (KeyError, ValueError, TypeError) as exc:
                return f"error: invalid marketplace command ({command_type}): {exc}; do not retry"

            try:
                result = execute_marketplace_command(
                    command, scope=scope, store=store, requested_by=principal
                )
            except MarketplaceAuthError as exc:
                return (
                    f"error: ClawHunt not connected: {exc}; connect a ClawHunt agent "
                    f"key first; do not retry"
                )
            except CompanyScopeError as exc:
                return f"error: forbidden: {exc.reason}; target outside scope; do not retry"
            except (ValueError, KeyError) as exc:
                return (
                    f"error: marketplace command failed: {type(exc).__name__}: {exc}; "
                    f"do not retry"
                )

            if result.outcome == "executed":
                return json.dumps({"status": "executed", "detail": result.detail})
            # pending_approval: the handler recorded a durable human approval; the
            # remote ClawHunt write has NOT happened. Tell the agent to STOP.
            approval_id = result.detail.get("approval_id")
            return json.dumps(
                {
                    "status": "pending_approval",
                    "approval_id": approval_id,
                    # Surface the reserved order id (claim/submit) so the agent can
                    # tell the user which order is queued; never the command payload.
                    "detail": result.detail,
                    "executed": False,
                    "message": (
                        f"This marketplace action crosses an external boundary and was "
                        f"NOT executed. It is queued for human approval "
                        f"(approval_id={approval_id}). STOP: do not assume it happened. "
                        f"Tell the user to approve it in the Web UI or CLI approvals queue."
                    ),
                }
            )

        return resolver

    def _build_native_approval_broker(self, session: RunSession, limits):
        """Build the codex native-approval broker for this run, or None when it should
        stay on the legacy static decision (P2/D5).

        Gated (opt-in, fail-safe): only when ``SUPERCLAW_NATIVE_APPROVAL_BROKER`` is on
        AND the posture is non-``full``. ``allow``/``bypass`` (full) use
        ``approvalPolicy=never`` so codex never raises requestApproval — no broker needed.
        Bound to this run's id + chat session + principal so a grant authorizes only this
        run's exact codex action; mirrors the B-class escalation gate's scoping."""
        if not native_approval_broker_enabled():
            return None
        policy = limits.permission_policy
        mode = policy.mode if policy is not None else None
        if posture_for_mode(mode) == "full":
            return None
        return StoreNativeApprovalBroker(
            store=self.store,
            run_id=session.run_id,
            session_id=session.chat_session_id,
            principal=self._run_principal(session),
        )

    def _bind_agent_identity(self, session, goal, limits):
        """Bind a team profile's identity to a worker invocation (charter consumption).

        When the run carries an ``agent_run_context`` (a team-bound run), the
        canonical prompt envelope is attached to ``WorkerLimits`` and the
        profile's model rides ``model_override`` — in memory only, so the stored
        goal stays clean. An explicit surface-level model selection (already
        present on ``limits``) wins over the profile preference.
        Degrades to the unbound pair on any error: identity binding guides the
        worker, it must never kill the run (the hard gates stay kernel-side).
        """
        # Attach the escalation gate FIRST, outside the best-effort identity try: a
        # missing gate makes the B-class tool layer fail-CLOSED (deny shell), never
        # fail-open, so gate wiring must be reliable rather than silently skipped.
        limits = replace(limits, escalation_gate=self._build_escalation_gate(session))
        # Company-management resolver (PR-F): bind the in-loop company-command
        # resolver so the B-class tool layer can execute the chat-projected
        # company tools against the kernel. Bound here (alongside the escalation
        # gate) so BOTH execution paths — parallel frontier and sequential — get
        # it. The projection toggle + posture/containment fence still decide
        # whether the tools are advertised + permitted; this just supplies the
        # store-bound execution seam.
        limits = replace(
            limits, company_command_resolver=self._build_company_command_resolver(session)
        )
        # Company READ resolver (roadmap P0): bind the in-loop discovery/snapshot
        # resolver so the B-class tool layer can SEE companies (list) + a company's
        # state (snapshot), not only mutate them. Same store + scope as the mutation
        # resolver (no read-privilege bypass); read-only, so it stays available even
        # under a read-only posture. Bound here alongside the mutation resolver so
        # both execution paths get it; the projection toggle still decides whether the
        # read tools are advertised.
        limits = replace(
            limits, company_read_resolver=self._build_company_read_resolver(session)
        )
        # Marketplace resolver (P3): bind the in-loop ClawHunt marketplace resolver so
        # the B-class tool layer can run the chat-projected marketplace tools
        # (browse/inspect read inline; post/bid/claim/submit/abandon → human approval).
        # Same gating as company tools (projection toggle + posture/containment fence)
        # decides whether they are advertised + permitted; this supplies the seam.
        limits = replace(
            limits,
            marketplace_command_resolver=self._build_marketplace_command_resolver(session),
        )
        # Codex native-approval broker (P2/D5): opt-in, non-full posture only. None keeps
        # the codex session on its legacy static decision (back-compat).
        native_broker = self._build_native_approval_broker(session, limits)
        if native_broker is not None:
            limits = replace(limits, native_approval_broker=native_broker)
        try:
            ctx = (session.execution_context or {}).get("agent_run_context")
            if not isinstance(ctx, dict) or not ctx:
                return goal, limits
            from superclaw.agent_prompt import build_agent_prompt_envelope

            envelope = build_agent_prompt_envelope(ctx, user_turn=goal.description)
            limits = replace(limits, prompt_envelope=envelope)
            # The ctx's model/effort are the profile's OWN values — build_agent_run_context
            # bakes them in UNCONDITIONALLY, so this is the single choke point that keeps
            # BOTH a forced root run and a cross-runtime child from inheriting a model id /
            # effort enum the run's actual backend cannot honor. Project ONLY when the run's
            # backend matches the profile's; a CONFIRMED mismatch (both known and different)
            # skips it and falls back to the backend's own default. Absent backend info
            # degrades to projecting as before (the hard guards stay kernel-side).
            run_backend = str((session.execution_context or {}).get("backend_policy") or "")
            ctx_backend = str(ctx.get("backend_policy") or "")
            backend_mismatch = bool(run_backend) and bool(ctx_backend) and run_backend != ctx_backend
            if not backend_mismatch:
                profile_model = str(ctx.get("model") or "").strip()
                if profile_model and not (limits.model_override or "").strip():
                    limits = replace(limits, model_override=profile_model)
                # Same governed channel for reasoning effort: the role's configured
                # effort becomes the run default unless the caller already pinned one.
                profile_effort = str(ctx.get("effort") or "").strip()
                if profile_effort and not (limits.effort_override or "").strip():
                    limits = replace(limits, effort_override=profile_effort)
            return goal, limits
        except Exception as exc:  # guidance must not break execution
            # A silently unbound identity is a debugging trap (the run looks
            # team-bound but the charter never reached the prompt) — leave a
            # durable trace, best-effort.
            try:
                self.store.add_event(
                    session.run_id,
                    "agent.identity_binding_failed",
                    {"run_id": session.run_id, "error": str(exc)},
                )
            except Exception:  # pragma: no cover
                pass
            return goal, limits

    def _run_backend(self, backend, task, goal, session, limits):
        """Single delivery dispatch for ``backend.run`` — used by BOTH the
        sequential and the parallel-frontier execution paths.

        BATCH runtime honesty (Display Protocol DL4): for a non-streaming backend,
        disclose "batch, no live tools" UP FRONT — before the (possibly long)
        backend.run executes — so the surface isn't blank while an API/agent
        backend works. Routing every delivery backend.run through this one method
        means the disclosure is call-site agnostic: it cannot be bypassed by a new
        (or the existing parallel) execution path. Streaming backends
        (surfaces_live_tools=True) surface real tool.* via their projector and must
        never be mislabelled batch, so they are skipped here. Best-effort: the
        diagnostic helper guards its own sink + swallows failures, so display never
        breaks the run.
        """
        if not getattr(backend, "surfaces_live_tools", False):
            backend._emit_batch_diagnostic(limits, task=task, session=session)
        # PR-4 (柱子 2): for an A-class team run (codex/claude — no in-loop company
        # resolver), mint a run-bound ticket and inject the team MCP proxy config so
        # the native backend can call the SAME company commands the B-class in-loop
        # resolver exposes. Bound HERE (the single delivery dispatch shared by both
        # the sequential and parallel paths) so it is call-site agnostic. A B-class
        # backend (surfaces_company_tools_in_loop=True) is skipped — it would double
        # stack the same vocabulary.
        limits = self._maybe_bind_team_mcp(backend, session, limits)
        try:
            return backend.run(task, goal, session, limits)
        except PromptProjectionError as exc:
            started_at = time.time()
            return backend._synthetic_result(
                task=task,
                session=session,
                limits=limits,
                command_repr="prompt envelope projection",
                output=f"{exc.code}: {exc}",
                exit_code=1,
                started_at=started_at,
                finished_at=time.time(),
                duration=0.0,
            )

    def _maybe_bind_team_mcp(self, backend, session, limits):
        """Mint a run ticket + inject the company-command MCP config for an A-class run.

        Wires the MCP company-command channel for an A-class native backend on BOTH
        the confined TEAM run and the admin OPERATOR (direct user chat) — so the
        company tools the B-class in-loop resolver already exposes are available
        UNIFORMLY across every runtime (closing the asymmetry where only A-class
        operator chat had none). Returns ``limits`` unchanged unless ALL hold
        (fail-closed otherwise):
          * the backend can consume an MCP config (codex/codex-app-server/claude);
          * the backend executes company commands via MCP, NOT in-loop
            (``surfaces_company_tools_in_loop`` is False — a B-class backend is
            skipped so the two paths never double-stack the same vocabulary);
          * company tools are enabled (the same env toggle the B-class layer reads);
          * the posture/containment fence does not deny mutating tools;
          * the run is identifiable — an OPERATOR (admin) chat always is; a TEAM run
            needs a resolved acting agent + a concrete, non-sentinel company.

        The channel is chosen from the derived scope: an admin (operator) scope mints
        an OPERATOR-audience ticket and launches the proxy with ``--operator-scope``
        (admin re-derivation); a team scope mints a confined team-audience ticket. A
        team ticket can never be replayed on an operator-mode proxy (and vice versa) —
        ``verify_run_ticket``'s audience match enforces the seam, so a confined team
        agent cannot escalate to admin by rewriting argv. Both channels delegate the
        mint + sidecar + config projection to ``_inject_company_mcp``; the token
        travels only via the 0600 sidecar PATH in argv (never the token itself, never
        in the secret-free MCP config)."""
        from superclaw.runtime_config import company_tools_enabled

        # Only MCP-capable native backends that do NOT execute company tools in-loop.
        # NOTE on codex-app-server: it shares ``_codex_mcp_config_overrides`` with the
        # codex CLI, so the same secret-free config (with the --ticket-file argv) is
        # projected; the proxy reads the sidecar by path (env-independent), so the
        # app-server path is wired identically — no env threading needed (advisor B1).
        if getattr(backend, "name", "") not in self._MCP_CAPABLE_BACKENDS:
            return limits
        if getattr(backend, "surfaces_company_tools_in_loop", False):
            return limits
        if not company_tools_enabled():
            return limits

        # Posture / containment parity with the B-class in-loop path (advisor R2
        # blocker): WRITE company tools are MUTATING, so a read-only posture
        # (mode=plan) or a low-trust containment fence DENIES them for B-class
        # (``posture_denies_tool`` / ``containment_denies_tool`` in
        # ``_RealToolExecution._exec_tool``). The A-class MCP projection must apply the
        # SAME fence — but ONLY to the writes. The READ tools (company_list /
        # company_snapshot) are NOT mutating and B-class keeps them under a read-only
        # posture, so the A-class proxy must keep them too (else a plan-mode A-class
        # run loses discovery/snapshot the equivalent B-class run still has — the
        # parity gap codex flagged). So we no longer project NOTHING: we project the
        # proxy with the ticket's allowed_actions narrowed to READS only when writes
        # are denied. A write call then fails ticket verification (action not
        # permitted) — the same refuse-the-write/keep-the-read shape as B-class. We
        # probe a representative write tool (all share the _MUTATING_TOOLS class).
        from superclaw.containment import containment_denies_tool
        from superclaw.permissions import posture_denies_tool, posture_for_mode
        from superclaw.ui_contracts import COMPANY_COMMAND_TOOLS

        _policy = limits.permission_policy
        _mode = _policy.mode if _policy is not None else None
        _posture = posture_for_mode(_mode)
        _probe_tool = str(COMPANY_COMMAND_TOOLS[0]["name"])
        writes_denied = posture_denies_tool(_posture, _probe_tool) or containment_denies_tool(
            limits.containment_policy, _probe_tool, mode=_mode
        )

        # Derive the scope for THIS run and pick the channel. The OPERATOR (direct
        # user chat) gets is_admin=True → the operator-scope MCP channel, so the
        # A-class native backend (claude/codex) manages companies with the SAME admin
        # authority the B-class in-loop resolver and the CLI already grant the
        # operator (parity — closes the asymmetry where only A-class operator chat had
        # no company tools). A TEAM run gets the confined channel; a team run with an
        # unresolved company (sentinel) or no acting agent cannot be safely identified
        # → no ticket (fail-closed).
        scope = self._company_scope_for_run(session)
        if scope.is_admin:
            from superclaw.team_mcp_proxy import OPERATOR_MCP_AUDIENCE

            actor_company = (
                scope.actor_company_id
                if isinstance(scope.actor_company_id, str) and scope.actor_company_id
                else "local"
            )
            # Pin the operator ticket to the SAME audit principal the B-class in-loop
            # resolver uses for THIS session: ``scope.principal_id`` is exactly
            # ``_run_principal(session)`` (the operator branch of
            # ``_company_scope_for_run`` sets it), and the proxy re-derives
            # ``CompanyScope.principal_id`` / ``requested_by`` from it. So owner_id,
            # approval ``requested_by`` and audit attribution are ZERO-DRIFT between the
            # A-class operator chat and the B-class one — not the CLI's ``local_user``
            # constant, which would diverge from a direct chat carrying an explicit
            # principal (advisor codex R2).
            return self._inject_company_mcp(
                session,
                limits,
                agent_profile_id=scope.principal_id,
                company_id=actor_company,
                audience=OPERATOR_MCP_AUDIENCE,
                operator_scope=True,
                writes_denied=writes_denied,
            )
        company_id = scope.actor_company_id
        agent_profile_id = scope.actor_agent_profile_id
        if (
            not isinstance(company_id, str)
            or not company_id
            or company_id == "__unresolved_company__"
            or not isinstance(agent_profile_id, str)
            or not agent_profile_id
        ):
            return limits
        from superclaw.team_mcp_proxy import TEAM_MCP_AUDIENCE

        return self._inject_company_mcp(
            session,
            limits,
            agent_profile_id=agent_profile_id,
            company_id=company_id,
            audience=TEAM_MCP_AUDIENCE,
            operator_scope=False,
            writes_denied=writes_denied,
        )

    def _inject_company_mcp(
        self,
        session,
        limits,
        *,
        agent_profile_id: str,
        company_id: str,
        audience: str,
        operator_scope: bool,
        writes_denied: bool = False,
    ):
        """Mint a run-bound ticket + inject the company-command MCP proxy config.

        The shared projection tail for BOTH channels: the confined TEAM channel
        (operator_scope=False) and the admin OPERATOR channel (operator_scope=True).
        The two differ ONLY in the ticket ``audience`` (a team ticket can never be
        replayed on the operator-mode proxy, and vice versa — ``verify_run_ticket``'s
        audience match enforces it), the sidecar / config file NAMES, the proxy
        ``server_name``, and the ``--operator-scope`` flag. Every guard
        (MCP-capability, in-loop double-stack, company-tools toggle, posture /
        containment fence) has already run in the caller, so this is pure projection.
        Any failure leaves ``limits`` unchanged (fail-closed: the company tools are
        simply not offered, never a half-wired surface).
        """
        channel = "operator" if operator_scope else "team"
        server_name = f"superclaw-{channel}"
        try:
            import math

            from superclaw.company_ticket import issue_run_ticket
            from superclaw.team_mcp_proxy import (
                TEAM_COMMAND_ACTIONS,
                TEAM_READ_ACTIONS,
                build_team_mcp_config,
                write_ticket_file,
            )

            # ttl: the run budget plus a margin so the ticket cannot expire mid-run;
            # floored so a tiny budget still yields a usable lifetime, capped so a huge
            # budget cannot mint a near-immortal ticket. A non-finite/non-positive
            # budget is sanitized to the floor (a NaN budget would otherwise yield a
            # NaN ttl; issue_run_ticket already rejects that, but normalize up front).
            raw_budget = getattr(limits, "budget_seconds", 0)
            try:
                budget = float(raw_budget)
            except (TypeError, ValueError):
                budget = 0.0
            if not math.isfinite(budget) or budget <= 0:
                budget = 0.0
            ttl_seconds = min(max(budget, 60.0) + 300.0, 86_400.0)
            # Run-scoped respond grant (#2): ONLY for the confined TEAM channel
            # (operator_scope is False). The OPERATOR channel is admin and never
            # needs a non-owned-comment grant; this block is shared by both, so we
            # use the operator_scope signal to exclude operator (mirrors how the
            # whole admin-ness rides operator_scope, not a ticket field). The
            # binding (respond_mode + same-company issue) is derived from trusted
            # server state, never from a command body.
            respond_issue_id = (
                None if operator_scope else self._respond_grant_issue_id(session, company_id)
            )
            # READS are always permitted (non-mutating, kept under a read-only
            # posture for parity with B-class); WRITES only when the posture /
            # containment fence allows them. Under a read-only / low-trust run the
            # ticket carries READ actions only, so a write call fails ticket
            # verification — refuse-the-write/keep-the-read, mirroring B-class.
            allowed_actions = (
                list(TEAM_READ_ACTIONS)
                if writes_denied
                else [*TEAM_COMMAND_ACTIONS, *TEAM_READ_ACTIONS]
            )
            token, _ticket = issue_run_ticket(
                self.store,
                run_id=session.run_id,
                agent_profile_id=agent_profile_id,
                company_id=company_id,
                audience=audience,
                allowed_actions=allowed_actions,
                ttl_seconds=ttl_seconds,
                respond_issue_id=respond_issue_id,
            )
            # The token lands in a 0600 sidecar NEXT TO the state DB (alongside
            # state.db), NOT in the artifact dir. When the state dir is the default
            # ``~/.superclaw``, the credential_guard ``superclaw-{team,operator}-ticket-*``
            # / ``*.key`` blacklist blocks the B-class agent's own File/Command tools
            # from reading it. HONEST RESIDUAL — the 0600 sidecar is NOT a cross-privilege
            # wall (see team_mcp_proxy module docstring): its PATH is in the MCP-config
            # argv the agent can see, and an A-class native backend's own tools do NOT
            # pass through credential_guard, so a same-user shell can read it. This is
            # acceptable only under the single-user threat model (the operator already
            # owns the whole state DB); the (0) operator/audience BINDING in the proxy
            # is what stops a CONFINED team agent from reaching admin via its own
            # least-privilege sidecar. The OPERATOR sidecar is admin authority, so the
            # name-blacklist matters more, not less — but it is leakage-reduction, not
            # the boundary. The boundary is the single-user trust model + the binding.
            # ABSOLUTE paths in the config: the proxy child may run with a different
            # cwd than this process, so a relative state-path / ticket-file would
            # resolve wrong (→ fail-closed "no ticket" / "cannot open state").
            state_path = Path(self.store.path).resolve()
            ticket_path = state_path.parent / f"superclaw-{channel}-ticket-{session.run_id}.key"
            write_ticket_file(ticket_path, token)
            artifact_dir = Path(limits.artifact_dir or default_artifact_dir())
            artifact_dir.mkdir(parents=True, exist_ok=True)
            mcp_config = build_team_mcp_config(
                run_id=session.run_id,
                agent_profile_id=agent_profile_id,
                company_id=company_id,
                state_path=state_path,
                ticket_file=ticket_path,
                audience=audience,
                server_name=server_name,
                operator_scope=operator_scope,
            )
            mcp_path = (artifact_dir / f"superclaw-{channel}.mcp.json").resolve()
            mcp_path.write_text(
                json.dumps(mcp_config, ensure_ascii=False, sort_keys=True), encoding="utf-8"
            )
        except Exception as exc:  # noqa: BLE001 — never break the run; fail-closed (no tools)
            self.store.add_event(
                session.run_id,
                "team_mcp.projection_failed",
                {"run_id": session.run_id, "channel": channel, "error": f"{type(exc).__name__}: {exc}"},
            )
            return limits

        # APPEND (never replace) so the plugin aggregate MCP config stays. A
        # duplicate path (re-dispatch on the same run) is collapsed.
        base = limits.permission_policy or PermissionPolicy()
        mcp_path_str = str(mcp_path)
        new_configs = (
            base.mcp_configs
            if mcp_path_str in base.mcp_configs
            else [*base.mcp_configs, mcp_path_str]
        )
        effective_policy = replace(base, mcp_configs=new_configs)
        self.store.add_event(
            session.run_id,
            "team_mcp.projected",
            {
                "run_id": session.run_id,
                "channel": channel,
                "company_id": company_id,
                "agent_profile_id": agent_profile_id,
            },
        )
        return replace(limits, permission_policy=effective_policy)

    def _make_worker_event_sink(self, run_id: str):
        """Build a run-bound live event sink for streaming-capable backends.

        The sink persists the event (which rings the StateStore event bus, so SSE
        subscribers wake immediately). It is best-effort: a sink failure must
        never break the worker turn, so persistence is the source of truth and
        any error here is swallowed.
        """

        def sink(event_type: str, payload: dict[str, object]) -> None:
            try:
                self.store.add_event(run_id, event_type, payload)
                run = self.store.get_run(run_id)
                if run.parent_run_id:
                    self.store.add_event(
                        run.parent_run_id,
                        "child_run.event",
                        {
                            "child_run_id": run.run_id,
                            "child_task_id": run.execution_context.get("child_task_id"),
                            "parent_task_id": run.parent_task_id,
                            "parent_tool_call_id": run.execution_context.get("parent_tool_call_id"),
                            "event_type": event_type,
                            "payload": payload,
                        },
                    )
            except Exception:
                pass

        return sink

    def run_goal(
        self,
        *,
        title: str,
        description: str,
        dry_run: bool = False,
        source: str = "direct",
        backend_policy: str = "claude",
        model: str | None = None,
        effort: str | None = None,
        repo_path: str | Path = ".",
        concurrency: int = 1,
        budget_seconds: int = 60,
        artifact_dir: str | Path | None = None,
        verification_policy: str = "adversarial",
        harness_policy: str = "codex",
        permission_policy: PermissionPolicy | None = None,
        chat_session_id: str | None = None,
        task_topology: TaskTopology = TaskTopology.LINEAR,
        agent_profile_id: str | None = None,
        execution_context_extra: dict[str, Any] | None = None,
    ) -> RunResult:
        goal = self.store.create_goal(GoalSpec(title=title, description=description, source=source))  # type: ignore[arg-type]
        return self.run_existing_goal(
            goal,
            dry_run=dry_run,
            backend_policy=backend_policy,
            model=model,
            effort=effort,
            repo_path=repo_path,
            concurrency=concurrency,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            verification_policy=verification_policy,
            harness_policy=harness_policy,
            permission_policy=permission_policy,
            chat_session_id=chat_session_id,
            task_topology=task_topology,
            agent_profile_id=agent_profile_id,
            execution_context_extra=execution_context_extra,
        )

    def spawn_child_run(
        self,
        *,
        parent_run_id: str,
        parent_task_id: str,
        title: str,
        description: str,
        backend_policy: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        dry_run: bool | None = None,
        budget_seconds: int | None = None,
        artifact_dir: str | Path | None = None,
        verification_policy: str | None = None,
        harness_policy: str | None = None,
        permission_policy: PermissionPolicy | None = None,
    ) -> RunResult:
        parent_session = self.store.get_run(parent_run_id)
        self._validate_spawn_parent(parent_session, parent_task_id)
        child_goal, child_session, exec_kwargs = self._create_linked_child(
            parent_session,
            parent_task_id,
            title=title,
            description=description,
            backend_policy=backend_policy,
            model=model,
            effort=effort,
            dry_run=dry_run,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            verification_policy=verification_policy,
            harness_policy=harness_policy,
            permission_policy=permission_policy,
        )
        return self.execute_existing_session(child_goal, child_session, **exec_kwargs)

    def _validate_spawn_parent(self, parent_session: RunSession, parent_task_id: str) -> None:
        if parent_session.depth >= self.max_subagent_depth:
            raise ValueError("subagent depth limit exceeded for parent run")
        if parent_session.status in TERMINAL_RUN_STATUSES:
            raise ValueError(f"cannot spawn child run from terminal parent status {parent_session.status}")
        if not parent_session.task_graph:
            raise ValueError("parent run task graph is missing")
        parent_task = self._task_by_id(parent_session.task_graph, parent_task_id)
        if parent_task is None:
            raise ValueError(f"unknown parent task: {parent_task_id}")
        if parent_task.status not in {"running", "completed"}:
            raise ValueError(f"parent task {parent_task_id} is not in a child-spawnable status: {parent_task.status}")
        if not parent_session.execution_context:
            raise ValueError("parent run execution context is missing")

    def _create_linked_child(
        self,
        parent_session: RunSession,
        parent_task_id: str,
        *,
        title: str,
        description: str,
        backend_policy: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        dry_run: bool | None = None,
        budget_seconds: int | None = None,
        artifact_dir: str | Path | None = None,
        verification_policy: str | None = None,
        harness_policy: str | None = None,
        permission_policy: PermissionPolicy | None = None,
        agent_profile_id: str | None = None,
        execution_context_extra: dict[str, Any] | None = None,
    ) -> tuple[GoalSpec, RunSession, dict[str, Any]]:
        parent_run_id = parent_session.run_id
        context = parent_session.execution_context
        # When a child is bound to an Agent Team profile, the profile supplies
        # role defaults (backend, budget) unless the spec overrides them. An
        # unknown profile id degrades to inherited parent context rather than
        # failing the fan-out.
        profile = None
        if agent_profile_id:
            try:
                profile = self.store.get_agent_profile(agent_profile_id)
            except KeyError:
                profile = None
        profile_backend = profile.backend_policy if profile else None
        profile_budget = profile.budget_seconds if profile and profile.budget_seconds > 0 else None
        child_backend_policy = backend_policy or profile_backend or str(context.get("backend_policy") or "claude")
        # Model precedence: explicit spec > the bound profile's own model > the
        # parent's selection — and parent inheritance only applies when the
        # child also inherits the parent's backend (a different backend cannot
        # be assumed to speak the same model ids).
        profile_model = (profile.model or "").strip() if profile else ""
        profile_effort = (profile.effort or "").strip() if profile else ""
        # A bound profile's model/effort are valid only on the profile's OWN backend.
        # When an explicit backend override re-runs the role on a DIFFERENT runtime
        # (cross-runtime delegation passes target_runtime + the bound profile), neither
        # the model id nor the effort enum is portable, so gate BOTH on a matching
        # backend — the same runtime-specificity rule the parent-context inheritance
        # below already applies. The normal profile fan-out (no backend override) has
        # child_backend_policy == profile_backend, so the profile's values still apply;
        # only a mismatched override falls back to the new runtime's own default rather
        # than inheriting a level/id it cannot honor. An explicit spec value still wins.
        profile_on_own_backend = bool(profile_backend) and child_backend_policy == profile_backend
        child_model = model or (profile_model if profile_on_own_backend else "") or (str(context.get("model") or "") if child_backend_policy == str(context.get("backend_policy") or "claude") else "") or None
        child_effort = effort or (profile_effort if profile_on_own_backend else "") or (str(context.get("effort") or "") if child_backend_policy == str(context.get("backend_policy") or "claude") else "") or None
        child_dry_run = bool(parent_session.dry_run if dry_run is None else dry_run)
        child_budget_seconds = int(
            budget_seconds
            if budget_seconds is not None
            else profile_budget
            if profile_budget is not None
            else context.get("budget_seconds") or 60
        )
        child_artifact_dir = artifact_dir or str(context.get("artifact_dir") or default_artifact_dir())
        child_verification_policy = str(verification_policy or context.get("verification_policy") or "adversarial")
        child_harness_policy = str(harness_policy or context.get("harness_policy") or "codex")
        child_permission_policy = permission_policy
        if child_permission_policy is None:
            permission_policy_data = context.get("permission_policy")
            child_permission_policy = PermissionPolicy(**permission_policy_data) if isinstance(permission_policy_data, dict) else None

        child_task_id = _id("childtask")
        child_goal = self.store.create_goal(
            GoalSpec(
                title=title,
                description=description,
                metadata={
                    "parent_run_id": parent_run_id,
                    "parent_task_id": parent_task_id,
                    "child_task_id": child_task_id,
                },
            )
        )
        child_session = self.create_run_session(
            child_goal,
            dry_run=child_dry_run,
            chat_session_id=parent_session.chat_session_id,
            backend_policy=child_backend_policy,
            model=child_model,
            effort=child_effort,
            repo_path=str(context.get("repo_path") or "."),
            concurrency=1,
            budget_seconds=child_budget_seconds,
            artifact_dir=child_artifact_dir,
            verification_policy=child_verification_policy,
            harness_policy=child_harness_policy,
            permission_policy=child_permission_policy,
        )
        child_session.parent_run_id = parent_run_id
        child_session.parent_task_id = parent_task_id
        child_session.depth = parent_session.depth + 1
        if execution_context_extra:
            child_session.execution_context.update(dict(execution_context_extra))
        child_session.execution_context["child_task_id"] = child_task_id
        child_session.execution_context["parent_run_id"] = parent_run_id
        child_session.execution_context["parent_task_id"] = parent_task_id
        if agent_profile_id and profile is None:
            # Fail-soft for automation (a stale profile must not kill the
            # parent's fan-out), but never *claim* the identity: leaving
            # agent_profile_id in the context would attribute cost to a ghost
            # while no charter ever reached the worker. Trace it durably.
            try:
                self.store.add_event(
                    parent_run_id,
                    "agent.profile_missing",
                    {"requested_profile": agent_profile_id, "child_task_id": child_task_id},
                )
            except Exception:  # pragma: no cover
                pass
        if profile is not None:
            child_session.execution_context["agent_profile_id"] = agent_profile_id
            # Gap C injection: the bound profile's charter + governed equipment +
            # reporting chain become run context. A backend prompt is synthesized
            # from these kernel fields; tools come only from equipment.granted.
            from superclaw import team_kernel as _team_kernel

            # layer 3: a cross-runtime delegation carries a per-agent plugin cap in
            # ``delegated_plugin_grants`` (authorizer computed parent ∩ profile). Apply
            # it so ``equipment.granted = resolve(profile).granted ∩ cap`` is the SINGLE
            # source of truth — prevents a child exceeding the parent (no escalation)
            # and keeps the synthesized prompt's claimed plugins == what the projection
            # layer actually grants (no observable contract drift). Absent the key (a
            # plain fan-out, not a cross-runtime delegation) → no cap, keep prior
            # behaviour. Malformed → fail-closed empty cap.
            _ec = child_session.execution_context
            plugin_constraint: frozenset[str] | None
            if "delegated_plugin_grants" not in _ec:
                plugin_constraint = None
            else:
                _raw_cap = _ec.get("delegated_plugin_grants")
                if isinstance(_raw_cap, (list, tuple, set, frozenset)):
                    # Mixed-malformed cap fails closed (empty cap = no plugins),
                    # never silently filter dirty elements into a usable constraint.
                    if all(isinstance(p, str) and p.strip() for p in _raw_cap):
                        plugin_constraint = frozenset(_raw_cap)
                    else:
                        plugin_constraint = frozenset()
                elif _raw_cap is None:
                    plugin_constraint = None
                else:
                    plugin_constraint = frozenset()
            try:
                child_session.execution_context["agent_run_context"] = _team_kernel.build_agent_run_context(
                    self.store, profile, parent_plugin_constraint=plugin_constraint
                )
            except Exception:  # pragma: no cover - injection is best-effort
                pass
        # T11: a child run INHERITS the parent's containment fence and may only be
        # fenced TIGHTER by its own scope — a low-trust parent's fan-out can never
        # escape into an uncontained child. (Fan-out creates the run directly via
        # create_run_session, which does not resolve containment, so it is
        # inherited explicitly here. The child re-enforces it at execute time.)
        parent_containment_data = context.get("containment_policy")
        child_containment = (
            ContainmentPolicy.from_dict(parent_containment_data)
            if isinstance(parent_containment_data, dict)
            else resolve_containment_policy(self.store)  # standard baseline
        )
        if profile is not None:
            own_containment = resolve_containment_policy(
                self.store,
                workspace_id=profile.workspace_id,
                company_profile_id=profile.company_profile_id,
            )
            if own_containment.strictness > child_containment.strictness:
                child_containment = own_containment
        child_session.execution_context["containment_policy"] = child_containment.to_dict()
        self.store.save_run(child_session)

        child_execution = ChildExecution(
            child_task_id=child_task_id,
            child_run_id=child_session.run_id,
            parent_run_id=parent_run_id,
            parent_task_id=parent_task_id,
            backend=child_backend_policy,
            status=child_session.status,
            depth=child_session.depth,
            timeout_seconds=child_budget_seconds,
        )

        def append_child_execution(parent: RunSession) -> RunSession:
            if not any(child.child_run_id == child_session.run_id for child in parent.child_executions):
                parent.child_executions.append(child_execution)
            return parent

        self.store.mutate_run(parent_run_id, append_child_execution)
        self._sync_child_execution_to_parent(child_session)
        self.store.add_event(
            parent_run_id,
            "child_run.spawned",
            {
                "parent_run_id": parent_run_id,
                "parent_task_id": parent_task_id,
                "child_task_id": child_task_id,
                "child_run_id": child_session.run_id,
                "backend": child_backend_policy,
                "depth": child_session.depth,
                # Identity is only *claimed* when the profile actually resolved;
                # a ghost request stays visible as requested_* (paired with the
                # agent.profile_missing event) without polluting attribution.
                "agent_profile_id": agent_profile_id if profile is not None else None,
                "requested_agent_profile_id": agent_profile_id,
            },
        )
        exec_kwargs: dict[str, Any] = {
            "dry_run": child_dry_run,
            "backend_policy": child_backend_policy,
            "model": child_model,
            "effort": child_effort,
            "repo_path": str(context.get("repo_path") or "."),
            "concurrency": 1,
            "budget_seconds": child_budget_seconds,
            "artifact_dir": child_artifact_dir,
            "verification_policy": child_verification_policy,
            "harness_policy": child_harness_policy,
            "permission_policy": child_permission_policy,
        }
        return child_goal, child_session, exec_kwargs

    def _fanout_child_specs(
        self, task: TaskNode, goal: GoalSpec, session: RunSession | None = None
    ) -> list[dict[str, Any]]:
        spec = task.fanout or {}
        branches = max(1, int(spec.get("branches") or 2))
        role = str(spec.get("role") or task.role.value)
        # Bind the goal roster's runtime for THIS fan-out role (PR4/PR9) so a consensus
        # group runs on the role's agent (e.g. the review-bound reviewer), not the lead.
        # Empty for a non-goal run (no goal_slot_runtimes) — the children then inherit the
        # parent runtime as before, so company/clawhunt fan-outs are unchanged.
        slot_runtimes = self._goal_slot_runtimes(session) if session is not None else {}
        rt = slot_runtimes.get(role) if isinstance(slot_runtimes, dict) else None
        bound: dict[str, Any] = {}
        if isinstance(rt, dict):
            if rt.get("backend"):
                bound["backend_policy"] = rt["backend"]
            if rt.get("model"):
                bound["model"] = rt["model"]
            if rt.get("effort"):
                bound["effort"] = rt["effort"]
        return [
            {
                "title": f"{role} fan-out {index + 1}: {goal.title}",
                "description": goal.description,
                "dry_run": spec.get("dry_run"),
                **bound,
            }
            for index in range(branches)
        ]

    def _execute_fanout_task(
        self,
        task: TaskNode,
        goal: GoalSpec,
        graph: TaskGraph,
        session: RunSession,
        evidence: EvidenceBundle,
        run_lease: RunMutationLease,
    ) -> tuple[RunSession, EvidenceBundle, bool]:
        """Expand a topology fan-out node into a parallel subagent group mid-run.

        Persists the running node + current evidence before spawning so
        spawn_child_runs has authoritative parent state, then re-syncs the
        child links and evidence it wrote so the execute loop does not clobber
        them on subsequent saves.
        """
        spec = task.fanout or {}
        task.status = "running"
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session, attempt_index = self._advance_task_attempt(session, task.task_id)
        session = self._sync_session_status(session)
        self.store.save_run(session)
        self.store.save_evidence(evidence)
        self.store.add_event(
            session.run_id,
            "task.started",
            {"task_id": task.task_id, "role": task.role.value, "mode": "fanout", "attempt_index": attempt_index},
        )
        specs = self._fanout_child_specs(task, goal, session)
        result = self.spawn_child_runs(
            parent_run_id=session.run_id,
            parent_task_id=task.task_id,
            children=specs,
            aggregation=ChildAggregationPolicy(str(spec.get("aggregation") or "all_succeed")),
            max_concurrency=int(spec.get("max_concurrency") or len(specs)),
            quorum=spec.get("quorum"),
        )
        # Re-sync the parent state that spawn_child_runs persisted.
        session.child_executions = self.store.get_run(session.run_id).child_executions
        evidence = self.store.get_evidence(session.run_id)
        task.status = "completed" if result.succeeded else "failed"
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session = self._sync_session_status(session)
        self.store.save_run(session)
        self.store.add_event(
            session.run_id,
            "task.completed" if result.succeeded else "task.failed",
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "mode": "fanout",
                "fanout_policy": result.policy,
                "succeeded": result.succeeded,
                "completed": result.completed,
                "total": result.total,
            },
        )
        return session, evidence, result.succeeded

    @staticmethod
    def _synthesize_child_findings(child_results: list[Any]) -> list[dict[str, Any]]:
        """Dedup the union of child findings by name into a parent-level view."""
        severity_order = {"info": 0, "warning": 1, "high": 2, "critical": 3}
        merged: dict[str, dict[str, Any]] = {}
        for result in child_results:
            if result is None:
                continue
            for finding in result.evidence.findings:
                entry = merged.setdefault(
                    finding.name,
                    {"name": finding.name, "passed": True, "severity": "info", "failing_children": 0, "child_count": 0},
                )
                entry["child_count"] += 1
                if not finding.passed:
                    entry["passed"] = False
                    entry["failing_children"] += 1
                if severity_order.get(finding.severity, 0) > severity_order.get(entry["severity"], 0):
                    entry["severity"] = finding.severity
        return sorted(merged.values(), key=lambda item: item["name"])

    @staticmethod
    def _resolve_fanout_success(
        aggregation: ChildAggregationPolicy, *, completed: int, total: int, quorum: int | None
    ) -> bool:
        if aggregation == ChildAggregationPolicy.ALL_SUCCEED:
            return completed == total
        if aggregation == ChildAggregationPolicy.ANY_SUCCEEDS:
            return completed > 0
        if aggregation == ChildAggregationPolicy.CONSENSUS:
            return completed * 2 > total
        if aggregation == ChildAggregationPolicy.QUORUM:
            return quorum is not None and completed >= quorum
        return True  # BEST_EFFORT

    def spawn_child_runs(
        self,
        *,
        parent_run_id: str,
        parent_task_id: str,
        children: list[dict[str, Any]],
        aggregation: ChildAggregationPolicy = ChildAggregationPolicy.ALL_SUCCEED,
        max_concurrency: int = 4,
        quorum: int | None = None,
    ) -> ChildFanoutResult:
        """Spawn multiple child subagents for one parent task and run them concurrently.

        Children are created serially (each linked to the parent), executed in
        parallel under a bounded worker pool, then their outcomes are aggregated
        into one parent-visible verdict per ``aggregation`` policy. Child evidence
        is synthesized into the parent's unified report (backend_summary).
        """
        if not children:
            raise ValueError("spawn_child_runs requires at least one child spec")
        if aggregation == ChildAggregationPolicy.QUORUM and (quorum is None or quorum < 1):
            raise ValueError("quorum aggregation requires a positive quorum threshold")
        parent_session = self.store.get_run(parent_run_id)
        self._validate_spawn_parent(parent_session, parent_task_id)

        # PR9 goal-budget admission (a strict no-op for any spawn WITHOUT a goal
        # reservation — company delegation, etc.): a fan-out-node group of a budgeted
        # goal run reserves one slice per branch UP FRONT, all-or-nothing. A budget that
        # cannot cover the full approved group fails closed (no degraded consensus) so
        # concurrent branches can never collectively overspend the goal budget.
        reservation = (parent_session.execution_context or {}).get("goal_budget_reservation")
        budget_goal_id = reservation.get("goal_id") if isinstance(reservation, dict) else None
        per_worker = int(reservation.get("per_worker_tokens") or 0) if isinstance(reservation, dict) else 0
        reserved_branches = 0
        if budget_goal_id and per_worker > 0:
            for _ in children:
                if self.store.reserve_goal_budget(budget_goal_id, per_worker):
                    reserved_branches += 1
                else:
                    break
            if reserved_branches < len(children):
                for _ in range(reserved_branches):
                    self.store.settle_goal_reservation(budget_goal_id, per_worker, 0)
                return ChildFanoutResult(
                    parent_run_id=parent_run_id,
                    parent_task_id=parent_task_id,
                    policy=aggregation.value,
                    succeeded=False,
                    total=len(children),
                    completed=0,
                    failed=len(children),
                    children=[],
                    detail=f"fan-out denied: goal budget cannot cover {len(children)} branches",
                )

        prepared: list[tuple[GoalSpec, RunSession, dict[str, Any]]] = []
        results: dict[str, Any] = {}
        try:
            for spec in children:
                if not spec.get("title") or not spec.get("description"):
                    raise ValueError("each child spec requires a title and description")
                prepared.append(
                    self._create_linked_child(
                        parent_session,
                        parent_task_id,
                        title=str(spec["title"]),
                        description=str(spec["description"]),
                        backend_policy=spec.get("backend_policy"),
                        model=spec.get("model"),
                        effort=spec.get("effort"),
                        dry_run=spec.get("dry_run"),
                        budget_seconds=spec.get("budget_seconds"),
                        artifact_dir=spec.get("artifact_dir"),
                        verification_policy=spec.get("verification_policy"),
                        harness_policy=spec.get("harness_policy"),
                        agent_profile_id=spec.get("agent_profile_id"),
                        execution_context_extra=spec.get("execution_context"),
                    )
                )

            workers = max(1, min(int(max_concurrency), len(prepared)))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                # copy_context so each worker thread inherits the parent's trace
                # context (ContextVars don't cross threads automatically); the choke
                # point in execute_existing_session then binds the per-run run_id.
                future_to_run = {}
                for goal, session, kwargs in prepared:
                    ctx = contextvars.copy_context()
                    future = pool.submit(ctx.run, self.execute_existing_session, goal, session, **kwargs)
                    future_to_run[future] = session.run_id
                for future in as_completed(future_to_run):
                    results[future_to_run[future]] = future.result()
        finally:
            # Settle each reserved slice to the branch's ACTUAL spend (leak-safe: this
            # runs even if creation/execution raised). A branch with no recorded tokens
            # books the conservative reserved amount; a reserved slice with no created
            # child (an early raise) releases with 0.
            if budget_goal_id and per_worker > 0:
                settled = 0
                for _goal, _session, _kwargs in prepared:
                    tokens = self._run_token_total(_session.run_id)
                    actual = per_worker if tokens is None else tokens
                    self.store.settle_goal_reservation(budget_goal_id, per_worker, actual)
                    settled += 1
                for _ in range(max(0, reserved_branches - settled)):
                    self.store.settle_goal_reservation(budget_goal_id, per_worker, 0)

        child_summaries: list[dict[str, Any]] = []
        completed = 0
        failed = 0
        for _, session, _ in prepared:
            result = results.get(session.run_id)
            status = result.session.status if result else "unknown"
            verdict = result.evidence.chain_verdict.value if result else ChainVerdict.FAIL.value
            child_ok = status == RunStatus.COMPLETED.value and verdict != ChainVerdict.FAIL.value
            completed += 1 if child_ok else 0
            failed += 0 if child_ok else 1
            child_summaries.append(
                {
                    "child_run_id": session.run_id,
                    "child_task_id": session.execution_context.get("child_task_id"),
                    "status": status,
                    "chain_verdict": verdict,
                    "succeeded": child_ok,
                }
            )

        total = len(prepared)
        succeeded = self._resolve_fanout_success(aggregation, completed=completed, total=total, quorum=quorum)
        threshold_note = f", quorum={quorum}" if aggregation == ChildAggregationPolicy.QUORUM else ""
        detail = f"{completed}/{total} child subagents succeeded under {aggregation.value}{threshold_note}"

        # Cross-subagent synthesis: verdict distribution, conflict detection, and a
        # deduped union of child findings folded into the parent's unified report
        # (backend_summary), supporting multiple fan-outs per parent.
        child_results = [results.get(session.run_id) for _, session, _ in prepared]
        verdict_distribution: dict[str, int] = {}
        for summary in child_summaries:
            verdict_distribution[summary["chain_verdict"]] = verdict_distribution.get(summary["chain_verdict"], 0) + 1
        conflict = (
            any(summary["chain_verdict"] == ChainVerdict.FAIL.value for summary in child_summaries)
            and any(summary["chain_verdict"] != ChainVerdict.FAIL.value for summary in child_summaries)
        )
        merged_findings = self._synthesize_child_findings(child_results)

        fanout_report = {
            "policy": aggregation.value,
            "quorum": quorum,
            "parent_task_id": parent_task_id,
            "total": total,
            "completed": completed,
            "failed": failed,
            "succeeded": succeeded,
            "conflict": conflict,
            "verdict_distribution": verdict_distribution,
            "merged_findings": merged_findings,
            "children": child_summaries,
        }
        parent_evidence = (
            self.store.get_evidence(parent_run_id)
            if self._has_evidence(parent_run_id)
            else self.store.create_evidence(parent_run_id)
        )
        merged_summary = dict(parent_evidence.backend_summary or {})
        fanouts = list(merged_summary.get("subagent_fanouts") or [])
        fanouts.append(fanout_report)
        merged_summary["subagent_fanouts"] = fanouts
        parent_evidence.set_backend_summary(merged_summary)
        parent_evidence.add_finding("subagent_fanout", succeeded, detail, "info" if succeeded else "high")
        self.store.save_evidence(parent_evidence)
        self.store.add_event(
            parent_run_id,
            "child_fanout.completed",
            {
                "parent_run_id": parent_run_id,
                "parent_task_id": parent_task_id,
                "policy": aggregation.value,
                "quorum": quorum,
                "total": total,
                "completed": completed,
                "failed": failed,
                "succeeded": succeeded,
                "conflict": conflict,
                "max_concurrency": workers,
            },
        )
        return ChildFanoutResult(
            parent_run_id=parent_run_id,
            parent_task_id=parent_task_id,
            policy=aggregation.value,
            succeeded=succeeded,
            total=total,
            completed=completed,
            failed=failed,
            children=child_summaries,
            detail=detail,
            conflict=conflict,
        )

    def expand_task_graph(self, run_id: str, new_tasks: list[TaskNode]) -> RunSession:
        """Dynamically add discovered subtasks to a live run's task graph.

        Validates the merged graph (no cycles, dangling, or duplicate ids) and
        persists it so the added nodes join the frontier on the next execution
        or resume. Rejected for terminal runs or runs with a live worker thread.
        """
        if not new_tasks:
            raise ValueError("expand_task_graph requires at least one task")
        session = self.store.get_run(run_id)
        if session.status in TERMINAL_RUN_STATUSES:
            raise ValueError(f"cannot expand task graph of terminal run status {session.status}")
        if not session.task_graph:
            raise ValueError("run has no task graph to expand")
        thread = self._run_thread(run_id)
        if thread and thread.is_alive():
            raise ValueError("cannot expand the task graph of a run with a live worker thread")
        existing_ids = {task.task_id for task in session.task_graph.tasks}
        for task in new_tasks:
            if task.task_id in existing_ids:
                raise ValueError(f"duplicate task id in expansion: {task.task_id}")
            existing_ids.add(task.task_id)
        merged = TaskGraph(
            goal_id=session.task_graph.goal_id,
            tasks=list(session.task_graph.tasks) + list(new_tasks),
        )
        merged.validate()  # rejects cycles and dangling dependencies before persisting
        session.task_graph = merged
        self.store.save_run(session)
        for task in new_tasks:
            self.store.add_event(
                run_id,
                "task.added",
                {
                    "task_id": task.task_id,
                    "role": task.role.value,
                    "title": task.title,
                    "depends_on": task.depends_on,
                },
            )
        return session

    @staticmethod
    def _discovered_task_node(spec: dict[str, Any]) -> TaskNode:
        return TaskNode(
            task_id=str(spec.get("task_id") or _id("task")),
            role=WorkerRole(str(spec.get("role") or WorkerRole.IMPLEMENT.value)),
            title=str(spec.get("title") or "discovered task"),
            depends_on=[str(dep) for dep in (spec.get("depends_on") or [])],
        )

    def _apply_discovered_tasks(
        self, session: RunSession, graph: TaskGraph, evidence: EvidenceBundle, result: Any
    ) -> None:
        """Merge a worker's discovered subtasks into the live graph mid-run.

        Validates the candidate merged graph and, on success, extends the live
        graph in place so the new nodes join the next frontier. On invalid
        expansion it fails soft: records a high finding and drops the nodes.
        """
        specs = getattr(result, "discovered_tasks", None) or []
        if not specs:
            return
        try:
            new_nodes = [self._discovered_task_node(spec) for spec in specs]
            existing_ids = {task.task_id for task in graph.tasks}
            for node in new_nodes:
                if node.task_id in existing_ids:
                    raise ValueError(f"duplicate discovered task id: {node.task_id}")
                existing_ids.add(node.task_id)
            TaskGraph(goal_id=graph.goal_id, tasks=list(graph.tasks) + new_nodes).validate()
        except ValueError as exc:
            evidence.add_finding("task_expansion", False, f"rejected discovered tasks: {exc}", "high")
            self.store.save_evidence(evidence)
            return
        graph.tasks.extend(new_nodes)  # graph is session.task_graph; in-place keeps the loop ref valid
        self.store.save_run(session)
        for node in new_nodes:
            self.store.add_event(
                session.run_id,
                "task.added",
                {
                    "task_id": node.task_id,
                    "role": node.role.value,
                    "title": node.title,
                    "depends_on": node.depends_on,
                    "source": "discovered",
                },
            )

    def run_existing_goal(
        self,
        goal: GoalSpec,
        *,
        dry_run: bool = False,
        backend_policy: str = "claude",
        model: str | None = None,
        effort: str | None = None,
        repo_path: str | Path = ".",
        concurrency: int = 1,
        budget_seconds: int = 60,
        artifact_dir: str | Path | None = None,
        verification_policy: str = "adversarial",
        harness_policy: str = "codex",
        permission_policy: PermissionPolicy | None = None,
        chat_session_id: str | None = None,
        task_topology: TaskTopology = TaskTopology.LINEAR,
        agent_profile_id: str | None = None,
        execution_context_extra: dict[str, Any] | None = None,
    ) -> RunResult:
        # A root run explicitly bound to a team profile fails closed on an
        # unknown id (operator intent — unlike fan-out, where a stale profile
        # degrades rather than killing the parent). The profile's model and
        # effort become the run defaults unless the caller passed one explicitly.
        profile = None
        if agent_profile_id:
            profile = self.store.get_agent_profile(agent_profile_id)  # raises KeyError
            # Inherit the profile's model/effort ONLY when this run uses the profile's
            # OWN backend (the normal path — the daemon/CLI pass backend_policy=
            # profile.backend_policy). A run FORCED onto a different backend cannot
            # honor a model id / effort enum specific to the profile's runtime, so it
            # falls back to the new backend's own default instead of leaking a
            # non-portable value (mirrors the _create_linked_child / _bind_agent_identity
            # backend gates). Only a CONFIRMED mismatch is gated; an absent profile
            # backend degrades to inheriting as before.
            profile_backend_mismatch = bool(profile.backend_policy) and backend_policy != profile.backend_policy
            if not profile_backend_mismatch:
                model = model or (profile.model or "").strip() or None
                effort = effort or (profile.effort or "").strip() or None
        session = self.create_run_session(
            goal,
            dry_run=dry_run,
            chat_session_id=chat_session_id,
            backend_policy=backend_policy,
            model=model,
            effort=effort,
            repo_path=repo_path,
            concurrency=concurrency,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            verification_policy=verification_policy,
            harness_policy=harness_policy,
            permission_policy=permission_policy,
            task_topology=task_topology,
            execution_context_extra=execution_context_extra,
        )
        context_dirty = False
        if execution_context_extra:
            # Caller-scoped attribution keys (issue_id / company_profile_id /
            # workspace_id …) — they ride the context so the cost recorder and
            # evidence can anchor the run to its organizational scope.
            session.execution_context.update(dict(execution_context_extra))
            context_dirty = True
        # Read the bound issue ONCE, up front — both the equipment projection
        # (per-fire routine.context narrowing) and the T11 containment fence below
        # derive from it, so it must be resolved before build_agent_run_context.
        ctx = session.execution_context
        review_issue = None
        issue_id = ctx.get("issue_id")
        if issue_id:
            try:
                review_issue = self.store.get_issue(issue_id)
            except KeyError:
                review_issue = None
        if profile is not None:
            from superclaw import team_kernel as _team_kernel

            # Per-fire equipment scoping is an INTRINSIC property of the issue
            # (snapshotted by routine materialization), so deriving it here — not
            # from a caller-passed argument — means a manual rerun / requeue of the
            # same issue cannot bypass the narrowing (fail-closed against
            # call-path escalation).
            issue_plugins, issue_skills = _issue_equipment_constraints(review_issue)
            session.execution_context["agent_profile_id"] = profile.profile_id
            session.execution_context["agent_run_context"] = _team_kernel.build_agent_run_context(
                self.store,
                profile,
                issue_plugin_constraint=issue_plugins,
                issue_skill_constraint=issue_skills,
            )
            context_dirty = True
        # T11: resolve the runtime containment fence from this run's org scope
        # (company floor → workspace boundary → issue override, strictest wins,
        # risk-based default) and PERSIST it so execution + resume + fan-out all
        # re-read and re-enforce the same fence — it can never be relaxed later.
        ws_id = ctx.get("workspace_id") or (profile.workspace_id if profile is not None else None)
        co_id = ctx.get("company_profile_id") or (profile.company_profile_id if profile is not None else None)
        containment = resolve_containment_policy(
            self.store, workspace_id=ws_id, company_profile_id=co_id, issue=review_issue
        )
        session.execution_context["containment_policy"] = containment.to_dict()
        context_dirty = True
        if context_dirty:
            self.store.save_run(session)
        return self.execute_existing_session(
            goal,
            session,
            dry_run=dry_run,
            backend_policy=backend_policy,
            model=model,
            effort=effort,
            repo_path=repo_path,
            concurrency=concurrency,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            verification_policy=verification_policy,
            harness_policy=harness_policy,
            permission_policy=permission_policy,
            task_topology=task_topology,
        )

    def create_run_session(
        self,
        goal: GoalSpec,
        *,
        dry_run: bool = False,
        chat_session_id: str | None = None,
        backend_policy: str = "claude",
        model: str | None = None,
        effort: str | None = None,
        repo_path: str | Path = ".",
        concurrency: int = 1,
        budget_seconds: int = 60,
        artifact_dir: str | Path | None = None,
        verification_policy: str = "adversarial",
        harness_policy: str = "codex",
        permission_policy: PermissionPolicy | None = None,
        task_topology: TaskTopology = TaskTopology.LINEAR,
        roles: list[WorkerRole] | None = None,
        execution_context_extra: dict[str, Any] | None = None,
    ) -> RunSession:
        # Stamp the attribution keys (wakeup_id / issue_id …) on the FIRST persisted
        # run row so the orphaned-checkout reaper always finds a run for a live
        # checkout — never mis-reaping a worker that stalled before a later stamp save.
        _initial_ctx = (
            {k: v for k, v in execution_context_extra.items() if v is not None}
            if execution_context_extra
            else None
        )
        session = self.store.create_run(
            goal.goal_id, dry_run=dry_run, execution_context=_initial_ctx or None
        )
        session.chat_session_id = chat_session_id
        # Light tasks pass a minimal role set (e.g. a single IMPLEMENT turn);
        # verifiable delivery uses the full EXPLORE→PLAN→IMPLEMENT→VERIFY→REVIEW pipeline.
        session.task_graph = TaskGraph.from_goal(
            goal,
            roles=roles or [WorkerRole.EXPLORE, WorkerRole.PLAN, WorkerRole.IMPLEMENT, WorkerRole.VERIFY, WorkerRole.REVIEW],
            topology=task_topology,
        )
        session.execution_context = {
            **session.execution_context,
            "backend_policy": backend_policy,
            "model": model,
            "effort": effort,
            "repo_path": str(Path(repo_path).resolve()),
            "concurrency": concurrency,
            "budget_seconds": budget_seconds,
            "artifact_dir": str(Path(artifact_dir or default_artifact_dir()).resolve()),
            "verification_policy": verification_policy,
            "harness_policy": harness_policy,
            "permission_policy": permission_policy.to_dict() if permission_policy else None,
            "task_topology": task_topology.value,
        }
        if execution_context_extra:
            # Caller-scoped context (e.g. the chat-selected company_profile_id that
            # HOMES the operator scope so issue_create / agent_hire land in the right
            # company). Additive over the structural keys; None values are dropped so a
            # caller that simply didn't select a company never clobbers anything.
            session.execution_context.update(
                {k: v for k, v in execution_context_extra.items() if v is not None}
            )
        session.status = RunStatus.QUEUED.value
        self.store.save_run(session)
        self.store.add_event(
            session.run_id,
            "run.queued",
            {
                "goal_id": goal.goal_id,
                "dry_run": dry_run,
                "chat_session_id": chat_session_id,
                "execution_context": session.execution_context,
                "task_topology": task_topology.value,
            },
        )
        return session

    def start_existing_goal(
        self,
        goal: GoalSpec,
        *,
        dry_run: bool = False,
        backend_policy: str = "claude",
        model: str | None = None,
        effort: str | None = None,
        repo_path: str | Path = ".",
        concurrency: int = 1,
        budget_seconds: int = 60,
        artifact_dir: str | Path | None = None,
        verification_policy: str = "adversarial",
        harness_policy: str = "codex",
        permission_policy: PermissionPolicy | None = None,
        chat_session_id: str | None = None,
        task_topology: TaskTopology = TaskTopology.LINEAR,
        roles: list[WorkerRole] | None = None,
        execution_context_extra: dict[str, Any] | None = None,
    ) -> RunSession:
        session = self.create_run_session(
            goal,
            dry_run=dry_run,
            chat_session_id=chat_session_id,
            backend_policy=backend_policy,
            model=model,
            effort=effort,
            repo_path=repo_path,
            concurrency=concurrency,
            budget_seconds=budget_seconds,
            artifact_dir=artifact_dir,
            verification_policy=verification_policy,
            harness_policy=harness_policy,
            permission_policy=permission_policy,
            task_topology=task_topology,
            roles=roles,
            execution_context_extra=execution_context_extra,
        )
        # copy_context so the async run thread inherits the parent trace context.
        ctx = contextvars.copy_context()
        thread = threading.Thread(
            target=ctx.run,
            args=(self._execute_existing_session_guarded,),
            kwargs={
                "goal": goal,
                "session": session,
                "dry_run": dry_run,
                "backend_policy": backend_policy,
                "model": model,
                "effort": effort,
                "repo_path": repo_path,
                "concurrency": concurrency,
                "budget_seconds": budget_seconds,
                "artifact_dir": artifact_dir,
                "verification_policy": verification_policy,
                "harness_policy": harness_policy,
                "permission_policy": permission_policy,
                "task_topology": task_topology,
            },
            daemon=True,
        )
        self._register_run_thread(session.run_id, thread)
        thread.start()
        return session

    def reconcile_run(self, run_id: str) -> ReconcileResult:
        session = self.store.get_run(run_id)
        previous_status = session.status
        if session.status not in {RunStatus.QUEUED.value, RunStatus.RUNNING.value, RunStatus.VERIFYING.value}:
            return ReconcileResult(
                run_id=run_id,
                previous_status=previous_status,
                status=session.status,
                classification="not_stale",
                resumable=False,
                detail="run is not in a stale-eligible active status",
            )
        thread = self._run_thread(run_id)
        if thread and thread.is_alive():
            return ReconcileResult(
                run_id=run_id,
                previous_status=previous_status,
                status=session.status,
                classification="active",
                resumable=False,
                detail="run still has a live worker thread",
            )
        acquired = self._try_acquire_run_mutation(session, mode=RunMutationMode.RECONCILE)
        if acquired is None:
            latest = self.store.get_run(run_id)
            return ReconcileResult(
                run_id=run_id,
                previous_status=previous_status,
                status=latest.status,
                classification="active_writer",
                resumable=False,
                detail="run mutation authority is already held by another writer",
            )
        session, runtime_lease, run_lease = acquired
        try:
            graph = session.task_graph
            if graph:
                for task in graph.tasks:
                    if task.status == "running":
                        task.status = "pending"
            cancel_detail = self._stale_cancel_detail(run_id)
            if cancel_detail:
                session.status = RunStatus.CANCELLED.value
                session.task_graph = graph
                self.store.save_run(session)
                self.store.add_event(
                    run_id,
                    "run.reconciled",
                    {
                        "run_id": run_id,
                        "previous_status": previous_status,
                        "status": session.status,
                        "classification": "cancelled",
                    },
                )
                self.store.add_event(
                    run_id,
                    "run.cancelled",
                    {"run_id": run_id, "previous_status": previous_status, "status": session.status, "detail": cancel_detail},
                )
                return ReconcileResult(
                    run_id=run_id,
                    previous_status=previous_status,
                    status=session.status,
                    classification="cancelled",
                    resumable=False,
                    detail=cancel_detail,
                )
            resume_evidence_error = self._resume_evidence_unavailable_detail(run_id)
            resumable = (
                bool(session.execution_context)
                and graph is not None
                and self._resume_frontier(graph) is not None
                and resume_evidence_error is None
            )
            session.status = RunStatus.QUEUED.value if resumable else RunStatus.FAILED.value
            session.task_graph = graph
            self.store.save_run(session)
            if resumable:
                detail = "stale run marked queued for deterministic resume"
            elif resume_evidence_error:
                detail = resume_evidence_error
            elif not session.execution_context:
                detail = "stale run failed closed because execution context is missing"
            elif graph is None:
                detail = "stale run failed closed because task graph is missing"
            else:
                detail = "stale run failed closed because resume frontier is not reconstructable"
            if resumable:
                self.store.add_event(
                    run_id,
                    "run.reconciled",
                    {"run_id": run_id, "previous_status": previous_status, "status": session.status, "classification": "resumable"},
                )
            else:
                if resume_evidence_error is None:
                    evidence = self.store.get_evidence(run_id)
                    evidence.add_finding("stale_run_unrecoverable", False, detail, "high")
                    self.store.save_evidence(evidence)
                self.store.add_event(
                    run_id,
                    "run.failed",
                    {"run_id": run_id, "previous_status": previous_status, "status": session.status, "detail": detail},
                )
            return ReconcileResult(
                run_id=run_id,
                previous_status=previous_status,
                status=session.status,
                classification="resumable" if resumable else "failed_closed",
                resumable=resumable,
                detail=detail,
            )
        finally:
            self._release_run_mutation(run_id, runtime_lease=runtime_lease, lease=run_lease)

    def list_stale_runs(self) -> list[RunSession]:
        """Runs whose stored status claims execution that liveness cannot back.

        Pending statuses (created/queued) and human gates are not stale — they
        make no claim that a worker is alive — so sweeping them would only spam
        reconcile events.
        """
        stale: list[RunSession] = []
        for run in self.store.list_runs():
            if run.status not in EXECUTING_RUN_STATUSES:
                continue
            thread = self._run_thread(run.run_id)
            if thread and thread.is_alive():
                continue
            if effective_run_state(run)["is_live"]:
                continue
            stale.append(run)
        return stale

    def reconcile_stale_runs(self, *, limit: int | None = None) -> list[ReconcileResult]:
        """Converge every stale executing run through reconcile_run.

        This is the automation entry point used at API startup, by the periodic
        sweeper and by `superclaw reconcile --all`. Each run goes through the
        full reconcile state machine (resume frontier => queued, otherwise
        failed closed) — never a bare status overwrite.
        """
        results: list[ReconcileResult] = []
        for run in self.list_stale_runs()[: limit if limit is not None else None]:
            try:
                results.append(self.reconcile_run(run.run_id))
            except KeyError:
                continue
            except Exception as exc:
                self.store.add_event(
                    run.run_id,
                    "run.reconcile.error",
                    {"run_id": run.run_id, "detail": str(exc) or type(exc).__name__},
                )
                continue
        return results

    def resume_run(self, run_id: str) -> RunResult | RunSession:
        session = self.store.get_run(run_id)
        goal = self.store.get_goal(session.goal_id)
        thread = self._run_thread(run_id)
        if thread and thread.is_alive():
            self.store.add_event(
                run_id,
                "run.resume.ignored",
                {
                    "run_id": run_id,
                    "status": session.status,
                    "detail": "run still has a live worker thread",
                },
            )
            return session
        previous_pause_status = self._latest_pause_status(run_id)
        if session.status == RunStatus.WAITING_FOR_HUMAN_GATE.value and previous_pause_status in {
            RunStatus.COMPLETED.value,
            RunStatus.FAILED.value,
            RunStatus.CANCELLED.value,
        }:
            session.status = previous_pause_status
            self.store.save_run(session)
            self.store.add_event(run_id, "run.resumed", {"run_id": run_id, "status": session.status, "mode": "terminal_restore"})
            return session
        if session.status in {RunStatus.RUNNING.value, RunStatus.VERIFYING.value, RunStatus.QUEUED.value}:
            reconcile = self.reconcile_run(run_id)
            if reconcile.classification == "active_writer":
                self.store.add_event(
                    run_id,
                    "run.resume.ignored",
                    {
                        "run_id": run_id,
                        "status": reconcile.status,
                        "detail": reconcile.detail,
                    },
                )
                return self.store.get_run(run_id)
            session = self.store.get_run(run_id)
        if session.status not in {
            RunStatus.QUEUED.value,
            RunStatus.WAITING_FOR_HUMAN_GATE.value,
            RunStatus.WAITING_FOR_CHILD_DELEGATION.value,
        }:
            raise ValueError(f"run is not resumable from status {session.status}")
        context = session.execution_context
        if not context:
            raise ValueError("run execution context is missing")
        if session.status == RunStatus.WAITING_FOR_CHILD_DELEGATION.value:
            active_waits = self._active_delegate_waits(session)
            if active_waits:
                self.store.add_event(
                    run_id,
                    "run.resume.blocked",
                    {
                        "run_id": run_id,
                        "status": session.status,
                        "reason": "delegated child is still running",
                        "pending_request_keys": [item.get("request_key") for item in active_waits],
                    },
                )
                return session
            pending_reviews = self._pending_delegate_result_reviews(session)
            if pending_reviews:
                self.store.add_event(
                    run_id,
                    "run.resume.blocked",
                    {
                        "run_id": run_id,
                        "status": session.status,
                        "reason": "delegate tool result awaits human review",
                        "pending_request_keys": [item.get("request_key") for item in pending_reviews],
                    },
                )
                return session
        if session.status in {RunStatus.WAITING_FOR_HUMAN_GATE.value, RunStatus.WAITING_FOR_CHILD_DELEGATION.value}:
            session.status = RunStatus.QUEUED.value
            self.store.save_run(session)
        self.store.add_event(run_id, "run.resumed", {"run_id": run_id, "status": session.status, "mode": "execution_resume"})
        permission_policy_data = context.get("permission_policy")
        permission_policy = PermissionPolicy(**permission_policy_data) if isinstance(permission_policy_data, dict) else None
        return self.execute_existing_session(
            goal,
            session,
            dry_run=bool(session.dry_run),
            backend_policy=str(context.get("backend_policy") or "claude"),
            model=str(context.get("model") or "") or None,
            effort=str(context.get("effort") or "") or None,
            repo_path=str(context.get("repo_path") or "."),
            concurrency=int(context.get("concurrency") or 1),
            budget_seconds=int(context.get("budget_seconds") or 60),
            artifact_dir=str(context.get("artifact_dir") or default_artifact_dir()),
            verification_policy=str(context.get("verification_policy") or "adversarial"),
            harness_policy=str(context.get("harness_policy") or "codex"),
            permission_policy=permission_policy,
            task_topology=TaskTopology(str(context.get("task_topology") or TaskTopology.LINEAR.value)),
            mutation_mode=RunMutationMode.RESUME,
        )

    def cancel_run(self, run_id: str) -> CancelResult:
        # Delegate the store-essential cancellation (status flip + event + recursive
        # child-run propagation) to the single source ``cancel_run_in_store`` — the
        # same path the A-class proxy / CLI / company tree commands use — then layer
        # this orchestrator's IN-PROCESS refinement on top: the child-evidence sync
        # safety net (covers terminal/cancel paths that skip the normal finalizer).
        # ``active_thread`` lets the store function pick the richer event type
        # (requested vs cancelled) only this in-process caller can know.
        thread = self._run_thread(run_id)
        active_thread = bool(thread and thread.is_alive())
        # recurse=False: this orchestrator does its OWN per-child recursion below via
        # cancel_run, which ALSO runs the in-process child-evidence sync a store-only
        # caller cannot — preserving the exact prior behavior (each cancelled child
        # gets its child_executions/evidence synced, not just the root).
        result = cancel_run_in_store(self.store, run_id, active_thread=active_thread, recurse=False)
        if result.accepted:
            session = self.store.get_run(run_id)
            self._cancel_linked_child_runs(session)
            self._sync_child_execution_to_parent(session)
        return result

    def _latest_pause_status(self, run_id: str) -> str | None:
        events = self.store.list_events_snapshot(run_id)
        for event in reversed(events):
            if event["type"] == "run.paused":
                previous = event["payload"].get("previous_status")
                return str(previous) if previous else None
        return None

    def _stale_cancel_detail(self, run_id: str) -> str | None:
        events = self.store.list_events_snapshot(run_id)
        for event in reversed(events):
            if event["type"] == "run.cancelled":
                return "stale run finalized as cancelled from persisted terminal cancellation event"
            if event["type"] in {"run.cancel.requested", "run.cancel.propagated", "worker.cancelled"}:
                return "stale run finalized as cancelled from persisted cancellation evidence"
            if event["type"] in {"run.completed", "run.failed"}:
                break
        try:
            evidence = self.store.get_evidence(run_id)
        except (KeyError, json.JSONDecodeError, TypeError, ValueError):
            return None
        if any(result.cancelled for result in evidence.worker_results):
            return "stale run finalized as cancelled from persisted worker cancellation evidence"
        return None

    def _resume_evidence_unavailable_detail(self, run_id: str) -> str | None:
        try:
            self.store.get_evidence(run_id)
        except KeyError:
            return "stale run failed closed because evidence bundle is missing or unreadable"
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            return f"stale run failed closed because evidence bundle is missing or unreadable: {exc}"
        return None

    def _run_mutation_lease_is_stale(self, lease: RunMutationLease) -> bool:
        return self._run_mutation_lease_stale_reason(lease) is not None

    def _run_mutation_lease_stale_reason(self, lease: RunMutationLease) -> str | None:
        return lease_stale_reason(lease)

    def _run_mutation_lease_worker_process_is_dead(self, lease: RunMutationLease) -> bool:
        return lease_worker_process_is_dead(lease)

    def _try_acquire_run_mutation(
        self,
        session: RunSession,
        *,
        mode: RunMutationMode,
    ) -> tuple[RunSession, WorkerLease, RunMutationLease] | None:
        latest = self.store.get_run(session.run_id)
        existing = latest.active_mutation_lease
        stale_reason = self._run_mutation_lease_stale_reason(existing) if existing is not None else None
        # A fresh persisted lease means another writer holds mutation authority.
        # An expired lease may be abandoned, but we only reclaim it after proving
        # no live in-process writer holds the runtime lock (acquired below).
        if existing is not None and stale_reason is None:
            self.store.add_event(
                session.run_id,
                f"run.{mode.value}.ignored",
                {
                    "run_id": session.run_id,
                    "mode": mode.value,
                    "active_lease_id": existing.lease_id,
                    "active_owner": existing.owner,
                },
            )
            return None
        runtime_lease = self.locks.try_acquire(f"run:{session.run_id}", owner=f"{mode.value}:{session.run_id}")
        if runtime_lease is None:
            self.store.add_event(
                session.run_id,
                f"run.{mode.value}.ignored",
                {
                    "run_id": session.run_id,
                    "mode": mode.value,
                    "detail": "run mutation authority already held in this process",
                },
            )
            return None
        # We hold the runtime lock, so no live in-process writer exists. If a
        # stale persisted lease remained, reclaim it explicitly before taking over.
        if existing is not None:
            self.store.add_event(
                session.run_id,
                "run.lease.stale",
                {
                    "run_id": session.run_id,
                    "lease_id": existing.lease_id,
                    "mode": existing.mode.value,
                    "owner": existing.owner,
                    "age_seconds": round(time.time() - existing.acquired_at, 3),
                    "worker_pid": existing.worker_pid,
                    "worker_host": existing.worker_host,
                    "stale_reason": stale_reason or "lease stale",
                    "detail": "abandoned run mutation lease reclaimed",
                },
            )
            latest.active_mutation_lease = None
            self.store.save_run(latest)
        try:
            lease = self.store.acquire_run_mutation_lease(
                session.run_id,
                owner=f"{mode.value}:{session.run_id}",
                mode=mode,
            )
        except ValueError:
            self.locks.release(runtime_lease)
            self.store.add_event(
                session.run_id,
                f"run.{mode.value}.ignored",
                {
                    "run_id": session.run_id,
                    "mode": mode.value,
                    "detail": "run mutation authority already held in persisted state",
                },
            )
            return None
        latest = self.store.get_run(session.run_id)
        return latest, runtime_lease, lease

    def _release_run_mutation(
        self,
        run_id: str,
        *,
        runtime_lease: WorkerLease | None,
        lease: RunMutationLease | None,
    ) -> None:
        if runtime_lease is not None:
            self.locks.release(runtime_lease)
        if lease is None:
            return
        try:
            self.store.release_run_mutation_lease(run_id, lease_id=lease.lease_id, owner=lease.owner)
        except ValueError:
            # StateStore has already persisted the rejected-release audit event.
            return

    def _assert_run_mutation_lease(
        self,
        session: RunSession,
        evidence: EvidenceBundle,
        lease: RunMutationLease,
    ) -> RunSession:
        try:
            current = self.store.require_run_mutation_lease(
                session.run_id,
                lease_id=lease.lease_id,
                owner=lease.owner,
                mode=lease.mode,
            )
        except ValueError:
            detail = f"run mutation lease lost during {lease.mode.value}"
            evidence.add_finding("run_mutation_lease", False, detail, "critical")
            self.store.save_evidence(evidence)
            raise RuntimeError(detail)
        session.active_mutation_lease = current
        return session

    def _advance_task_attempt(self, session: RunSession, task_id: str) -> tuple[RunSession, int]:
        attempts = dict(session.task_attempts)
        attempt_index = int(attempts.get(task_id, 0)) + 1
        attempts[task_id] = attempt_index
        session.task_attempts = dict(attempts)
        return session, attempt_index

    def _pending_frontier(self, graph: TaskGraph) -> list:
        graph.validate()
        completed = {task.task_id for task in graph.tasks if task.status == "completed"}
        return [
            task
            for task in graph.tasks
            if task.status == "pending" and all(dependency in completed for dependency in task.depends_on)
        ]

    def _resume_frontier(self, graph: TaskGraph) -> list[str] | None:
        completed = {task.task_id for task in graph.tasks if task.status == "completed"}
        frontier: list[str] = []
        for task in graph.tasks:
            if task.status == "pending" and all(dep in completed for dep in task.depends_on):
                frontier.append(task.task_id)
            elif task.status not in {"pending", "completed"}:
                return None
        return frontier

    def _has_evidence(self, run_id: str) -> bool:
        try:
            self.store.get_evidence(run_id)
            return True
        except KeyError:
            return False

    def _task_by_id(self, graph: TaskGraph, task_id: str):
        for task in graph.tasks:
            if task.task_id == task_id:
                return task
        return None

    def _cancel_linked_child_runs(self, session: RunSession) -> None:
        # Per-child cancellation through self.cancel_run so each child gets the FULL
        # treatment (store flip + its own child recursion + child-evidence sync),
        # not just a store-only flip. This is the in-process sync semantics the
        # store-portable canceller deliberately omits.
        for child in session.child_executions:
            try:
                child_session = self.store.get_run(child.child_run_id)
            except KeyError:
                continue
            if child_session.status in TERMINAL_RUN_STATUSES:
                continue
            child_result = self.cancel_run(child.child_run_id)
            self.store.add_event(
                session.run_id,
                "run.cancel.propagated",
                {
                    "run_id": session.run_id,
                    "child_run_id": child.child_run_id,
                    "child_task_id": child.child_task_id,
                    "accepted": child_result.accepted,
                    "status": child_result.status,
                },
            )

    def _find_evidence_artifact(self, evidence: EvidenceBundle) -> ArtifactRef | None:
        for artifact in evidence.artifacts:
            if artifact.kind == "evidence-json":
                return artifact
        return None

    def _record_context_pointers(self, session: RunSession, evidence: EvidenceBundle, repo: Path) -> None:
        """Capture this run's changed files into evidence.backend_summary (fail-open).

        The canonical record lives on the child run's evidence; the parent's reflow
        paths (A2A delegate tool result, issue completion payload) read it from
        there. Idempotent — a record already present is never recomputed, so the
        normal finalizer and the sync-path safety net (cancel, etc.) cannot double-
        capture or disagree. Never raises (a capture hiccup must not abort finalize)
        but is recorded with an explicit status, never a silent empty set.
        """
        try:
            if (evidence.backend_summary or {}).get("context_pointers") is not None:
                return  # already captured for this run
            baseline = (session.execution_context or {}).get("git_pointer_baseline")
            capture = capture_context_pointers(repo, baseline, dry_run=bool(session.dry_run))
            summary = dict(evidence.backend_summary or {})
            summary["context_pointers"] = capture.to_dict()
            evidence.backend_summary = summary
            self.store.save_evidence(evidence)
        except Exception:
            # Fail-open: pointers are an aid, not a gate. Surface, never abort.
            _LOGGER.warning(
                "context-pointers capture failed (fail-open) run_id=%s", session.run_id, exc_info=True
            )

    def _ensure_context_pointers_recorded(self, session: RunSession) -> None:
        """Safety-net capture for terminal paths that sync to a parent WITHOUT going
        through the normal finalizer (e.g. cancel_run). Idempotent and fail-open:
        if the normal path already recorded, this is a no-op."""
        try:
            if not self._has_evidence(session.run_id):
                return
            evidence = self.store.get_evidence(session.run_id)
            if (evidence.backend_summary or {}).get("context_pointers") is not None:
                return
            repo_path = (session.execution_context or {}).get("repo_path")
            if not repo_path:
                return
            self._record_context_pointers(session, evidence, Path(str(repo_path)))
        except Exception:
            _LOGGER.warning(
                "context-pointers sync-path capture failed (fail-open) run_id=%s", session.run_id, exc_info=True
            )

    def _sync_child_execution_to_parent(self, session: RunSession) -> None:
        # Safety net: guarantee the child's pointers are on its evidence before any
        # parent reads them, covering terminal paths (cancel) that skip the normal
        # finalizer. No-op when the finalizer already captured (idempotent).
        self._ensure_context_pointers_recorded(session)
        if not session.parent_run_id:
            return
        # Keep evidence aggregation locally serialized while the parent run row
        # itself is protected by StateStore.mutate_run's SQLite write lock.
        with self._child_sync_guard:
            self._sync_child_execution_to_parent_locked(session)

    def _sync_child_execution_to_parent_locked(self, session: RunSession) -> None:
        matching_holder: dict[str, ChildExecution | RunSession] = {}

        def mutate_parent(parent_session: RunSession) -> RunSession:
            matching = None
            for child in parent_session.child_executions:
                if child.child_run_id == session.run_id:
                    matching = child
                    break
            if matching is None:
                return parent_session
            matching.status = session.status
            matching.backend = str(session.execution_context.get("backend_policy") or matching.backend)
            matching.depth = session.depth
            budget_seconds = session.execution_context.get("budget_seconds")
            if budget_seconds is not None:
                matching.timeout_seconds = int(budget_seconds)
            evidence = self.store.get_evidence(session.run_id) if self._has_evidence(session.run_id) else None
            if evidence is not None:
                matching.chain_verdict = evidence.chain_verdict.value
                evidence_artifact = self._find_evidence_artifact(evidence)
                if evidence_artifact is not None:
                    matching.evidence_artifact_id = evidence_artifact.artifact_id
                    matching.evidence_path = evidence_artifact.path
            if session.status in TERMINAL_RUN_STATUSES:
                waits = self._delegation_waits(parent_session)
                context = dict(parent_session.execution_context or {})
                parent_session.execution_context = context
                for wait in waits:
                    if wait.get("child_run_id") == session.run_id:
                        wait["child_status"] = session.status
                        wait["chain_verdict"] = matching.chain_verdict
                        wait["evidence_artifact_id"] = matching.evidence_artifact_id
                        wait["evidence_path"] = matching.evidence_path
                        result = self._build_delegate_tool_result(
                            parent_session=parent_session,
                            wait=wait,
                            child_execution=matching,
                            child_session=session,
                        )
                        upserted_results = self._upsert_delegate_tool_result(
                            parent_session,
                            result,
                        )
                        parent_session.execution_context["delegate_tool_results"] = upserted_results
                        stored_result = next(
                            (item for item in upserted_results if item.get("request_key") == result.get("request_key")),
                            result,
                        )
                        stored_status = str(stored_result.get("status") or result["status"])
                        wait["tool_result_status"] = stored_status
                        if stored_status in {"approved", "rejected"}:
                            wait["status"] = "review_approved" if stored_status == "approved" else "review_rejected"
                            review = stored_result.get("review")
                            if isinstance(review, dict):
                                if review.get("reviewed_by") is not None:
                                    wait["reviewed_by"] = review.get("reviewed_by")
                                if review.get("reviewed_at") is not None:
                                    wait["reviewed_at"] = review.get("reviewed_at")
                        else:
                            wait["status"] = "child_completed"
                if waits:
                    parent_session.execution_context["child_delegation_waits"] = waits
            matching_holder["matching"] = replace(matching)
            matching_holder["parent_session"] = parent_session
            return parent_session

        try:
            self.store.mutate_run(session.parent_run_id, mutate_parent)
        except KeyError:
            return
        matching = matching_holder.get("matching")
        parent_session = matching_holder.get("parent_session")
        if not isinstance(matching, ChildExecution) or not isinstance(parent_session, RunSession):
            return

        parent_evidence = self.store.get_evidence(parent_session.run_id) if self._has_evidence(parent_session.run_id) else self.store.create_evidence(parent_session.run_id)
        parent_evidence.add_child_execution(matching)
        if matching.evidence_artifact_id and matching.evidence_path:
            had_artifact = any(artifact.artifact_id == matching.evidence_artifact_id for artifact in parent_evidence.artifacts)
            parent_evidence.add_artifact(
                ArtifactRef(
                    kind="child-evidence",
                    path=matching.evidence_path,
                    sensitivity="internal",
                    artifact_id=matching.evidence_artifact_id,
                    metadata={
                        "child_run_id": matching.child_run_id,
                        "child_task_id": matching.child_task_id,
                        "parent_run_id": matching.parent_run_id,
                        "parent_task_id": matching.parent_task_id,
                    },
                )
            )
            if not had_artifact:
                self.store.add_event(
                    parent_session.run_id,
                    "child_evidence.added",
                    {
                        "child_run_id": matching.child_run_id,
                        "child_task_id": matching.child_task_id,
                        "artifact_id": matching.evidence_artifact_id,
                        "path": matching.evidence_path,
                    },
                )
        self.store.save_evidence(parent_evidence)
        if session.status in TERMINAL_RUN_STATUSES:
            self.store.add_event(
                parent_session.run_id,
                f"child_run.{session.status}",
                    {
                        "child_run_id": matching.child_run_id,
                        "child_task_id": matching.child_task_id,
                        "parent_tool_call_id": session.execution_context.get("parent_tool_call_id"),
                        "status": matching.status,
                        "chain_verdict": matching.chain_verdict,
                    },
                )
            for result in self._pending_delegate_result_reviews(parent_session):
                if result.get("child_run_id") == session.run_id:
                    self.store.add_event(
                        parent_session.run_id,
                        "delegation.tool_result.pending_review",
                        {
                            "request_key": result.get("request_key"),
                            "child_run_id": result.get("child_run_id"),
                            "parent_tool_call_id": result.get("tool_call_id"),
                        },
                    )

    def _sync_session_status(self, session: RunSession) -> RunSession:
        try:
            latest = self.store.get_run(session.run_id)
        except KeyError:
            return session
        if latest.status == RunStatus.CANCELLED.value and session.status in {RunStatus.RUNNING.value, RunStatus.QUEUED.value, RunStatus.VERIFYING.value}:
            session.status = latest.status
        return session

    def _permission_policy_for_session(self, session: RunSession) -> PermissionPolicy:
        policy = session.execution_context.get("permission_policy") if session.execution_context else None
        if isinstance(policy, dict):
            return PermissionPolicy(**policy)
        return PermissionPolicy()

    def _emit_permission_events(self, session: RunSession, task: TaskNode, backend: Any, attempt_index: int) -> None:
        policy = self._permission_policy_for_session(session)
        payload = {
            "task_id": task.task_id,
            "role": task.role.value,
            "backend": backend.name,
            "attempt_index": attempt_index,
            "permission_policy": policy.to_dict(),
            "interactive": False,
        }
        self.store.add_event(
            session.run_id,
            "permission.requested",
            {**payload, "request_source": "worker_execution"},
        )
        self.store.add_event(
            session.run_id,
            "permission.decided",
            {**payload, "decision": "allowed", "decision_source": "execution_context"},
        )

    def _emit_context_usage_event(self, session: RunSession, task: TaskNode, backend: Any, result: WorkerResult, evidence: EvidenceBundle) -> None:
        self.store.add_event(
            session.run_id,
            "context.usage",
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "backend": backend.name,
                "attempt_index": result.attempt_index,
                "primary_output_chars": len(str(result.output or "")),
                "output_truncated": result.output_truncated,
                "output_original_length": result.output_original_length,
                "command_count": len(evidence.commands),
                "worker_result_count": len(evidence.worker_results),
                "artifact_count": len(evidence.artifacts),
                "finding_count": len(evidence.findings),
                "probe_count": len(evidence.probes),
            },
        )

    def _metadata_finding_event_key(self, finding: VerificationFinding) -> str:
        return json.dumps(
            {
                "name": finding.name,
                "passed": finding.passed,
                "detail": finding.detail,
                "severity": finding.severity,
                "input_fields": finding.input_fields,
                "fail_mode": finding.fail_mode,
                "remediation": finding.remediation,
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def _metadata_finding_keys(self, evidence: EvidenceBundle) -> set[str]:
        return {
            self._metadata_finding_event_key(finding)
            for finding in evidence.findings
            if finding.name in NON_VERIFICATION_FINDING_NAMES
        }

    def _emit_new_evidence_metadata_finding_events(
        self,
        session: RunSession,
        previous_keys: set[str],
        evidence: EvidenceBundle,
    ) -> None:
        for finding in evidence.findings:
            if finding.name not in NON_VERIFICATION_FINDING_NAMES:
                continue
            key = self._metadata_finding_event_key(finding)
            if key in previous_keys:
                continue
            self.store.add_event(
                session.run_id,
                "evidence.finding",
                {**finding.__dict__, "finding_kind": "metadata"},
            )

    def _execute_existing_session_guarded(self, **kwargs: object) -> None:
        session = kwargs["session"]
        assert isinstance(session, RunSession)
        try:
            self.execute_existing_session(**kwargs)  # type: ignore[arg-type]
        except Exception as exc:  # pragma: no cover - defensive background safety
            try:
                evidence = self.store.get_evidence(session.run_id)
            except KeyError:
                evidence = self.store.create_evidence(session.run_id)
            evidence.add_finding(
                "orchestrator_execution",
                False,
                f"{type(exc).__name__}: {str(exc)[:400]}",
                "critical",
            )
            self.store.save_evidence(evidence)
            latest = self.store.get_run(session.run_id)
            if latest.status != RunStatus.CANCELLED.value:
                latest.status = RunStatus.FAILED.value
                self.store.save_run(latest)
                self.store.add_event(session.run_id, "run.failed", {"detail": str(exc)[:400]})
            if latest.status == RunStatus.COMPLETED.value:
                self.store.add_event(
                    session.run_id,
                    "run.completed",
                    {"chain_verdict": evidence.chain_verdict.value, "status": latest.status},
                )
            if latest.status == RunStatus.CANCELLED.value:
                self.store.add_event(
                    session.run_id,
                    "run.cancelled",
                    {"chain_verdict": evidence.chain_verdict.value, "status": latest.status},
                )

    def _emit_task_start(
        self, task: TaskNode, backend: Any, graph: TaskGraph, session: RunSession, evidence: EvidenceBundle, run_lease: RunMutationLease
    ) -> tuple[RunSession, int]:
        """Mark a task running, advance its attempt, persist, and emit start events.

        Mirrors the sequential worker path's pre-run steps so the parallel
        frontier path stays behavior-identical per task.
        """
        task.status = "running"
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session, attempt_index = self._advance_task_attempt(session, task.task_id)
        session = self._sync_session_status(session)
        self.store.save_run(session)
        self.store.add_event(
            session.run_id,
            "task.started",
            {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "depends_on": task.depends_on, "attempt_index": attempt_index},
        )
        self.store.add_event(
            session.run_id,
            "worker.leased",
            {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "attempt_index": attempt_index},
        )
        self._emit_permission_events(session, task, backend, attempt_index)
        self.store.add_event(
            session.run_id,
            "command.started",
            {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "attempt_index": attempt_index},
        )
        return session, attempt_index

    def _record_worker_cost(self, session: RunSession, result: Any) -> None:
        """Emit one idempotent CostEvent for a finished worker turn (fail-open).

        Single recorder for both the serial and parallel-frontier paths so cost
        is never double-counted nor dropped. Cost tracking must never block a
        run: any failure here is logged (fail-open, not silent). Idempotency key
        folds run/task/attempt/backend/invocation so retries and fallbacks
        collapse to one ledger row.
        """
        try:
            snapshot = result.cost
            if not snapshot:
                not_applicable = bool(session.dry_run) or result.backend == "local"
                snapshot = {
                    "backend": result.backend,
                    "provider": "local" if result.backend == "local" else "unknown",
                    "duration_seconds": float(result.duration_seconds or 0.0),
                    "meter_kind": "wall_clock",
                    "usage_status": "not_applicable" if not_applicable else "unavailable",
                    "usage_source": "local_timer",
                }
            invocation = snapshot.get("invocation_id") or result.transcript_artifact_id or "na"
            idem = f"{session.run_id}:{result.task_id}:{result.attempt_index}:{result.backend}:{invocation}"
            context = session.execution_context or {}
            event = CostEvent.from_snapshot(
                snapshot,
                idempotency_key=idem,
                source="team_member" if context.get("agent_profile_id") else "delivery",
                run_id=session.run_id,
                task_id=result.task_id,
                attempt_index=result.attempt_index,
                agent_profile_id=context.get("agent_profile_id"),
                issue_id=context.get("issue_id"),
                company_profile_id=context.get("company_profile_id"),
                workspace_id=context.get("workspace_id"),
                chat_session_id=session.chat_session_id,
                status="failed" if int(getattr(result, "exit_code", 0) or 0) != 0 else "completed",
            )
            # byo pricing needs a model. Prefer the one the backend actually
            # reported; fall back to the role's configured model, which the team
            # kernel injects into execution_context ("button-press" parity: a
            # role's USD is computed from the model the human configured it with).
            if not event.model:
                ctx_model = str(context.get("model") or "").strip()
                if ctx_model:
                    event.model = ctx_model
            self.store.record_cost_event(event)
        except Exception:
            # Cost tracking is fail-open — a ledger hiccup must never abort the
            # run — but NOT silent: a dropped CostEvent is lost billing/audit
            # data, so surface it with full context for ops.
            _LOGGER.warning(
                "worker cost event not recorded (fail-open) run_id=%s task_id=%s backend=%s",
                getattr(session, "run_id", None),
                getattr(result, "task_id", None),
                getattr(result, "backend", None),
                exc_info=True,
            )

    def _record_task_result(
        self, task: TaskNode, backend: Any, result: Any, graph: TaskGraph, session: RunSession, evidence: EvidenceBundle, run_lease: RunMutationLease
    ) -> RunSession:
        """Record a worker result into evidence + task status + events (serial).

        Mirrors the sequential worker path's post-run steps so the parallel
        frontier path records identically.
        """
        metadata_finding_keys = self._metadata_finding_keys(evidence)
        evidence.add_worker_result(result)
        self._record_worker_cost(session, result)
        evidence.add_command(result.command, result.exit_code, result.output)
        self._emit_new_evidence_metadata_finding_events(session, metadata_finding_keys, evidence)
        if result.artifact_path and result.artifact_id:
            artifact = ArtifactRef(
                kind="worker-log",
                path=result.artifact_path,
                sensitivity="internal",
                artifact_id=result.artifact_id,
                metadata={"backend": result.backend, "role": result.role, "task_id": result.task_id},
            )
            evidence.add_artifact(artifact)
            self.store.add_event(session.run_id, "artifact.added", {"artifact_id": artifact.artifact_id, "kind": artifact.kind, "path": artifact.path})
        if result.transcript_path and result.transcript_artifact_id:
            transcript = ArtifactRef(
                kind="worker-transcript",
                path=result.transcript_path,
                sensitivity="internal",
                artifact_id=result.transcript_artifact_id,
                metadata={"backend": result.backend, "role": result.role, "task_id": result.task_id},
            )
            evidence.add_artifact(transcript)
            self.store.add_event(session.run_id, "transcript.added", {"artifact_id": transcript.artifact_id, "kind": transcript.kind, "path": transcript.path})
        self._emit_context_usage_event(session, task, backend, result, evidence)
        task.status = "completed" if result.exit_code == 0 else "failed"
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session = self._sync_session_status(session)
        self.store.save_run(session)
        if result.exit_code == 0:
            self._apply_discovered_tasks(session, graph, evidence, result)
        self.store.add_event(
            session.run_id,
            "command.completed",
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "backend": backend.name,
                "attempt_index": result.attempt_index,
                "exit_code": result.exit_code,
                "timed_out": result.timed_out,
                "cancelled": result.cancelled,
                "forced_kill": result.forced_kill,
            },
        )
        if result.forced_kill:
            self.store.add_event(session.run_id, "worker.forced_kill", {"task_id": result.task_id, "role": result.role, "backend": result.backend, "exit_code": result.exit_code})
        if result.cancelled:
            task.status = "cancelled"
            session.task_graph = graph
            session = self._assert_run_mutation_lease(session, evidence, run_lease)
            session = self._sync_session_status(session)
            self.store.save_run(session)
            self.store.add_event(session.run_id, "task.failed", {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "status": task.status, "attempt_index": result.attempt_index})
            self.store.add_event(session.run_id, "worker.cancelled", {"task_id": result.task_id, "role": result.role, "backend": result.backend, "exit_code": result.exit_code, "forced_kill": result.forced_kill})
            evidence.add_finding(
                "worker_cancelled",
                False,
                f"{backend.name} cancelled {task.role.value} with exit code {result.exit_code}" + (" after forced kill" if result.forced_kill else ""),
                "warning",
            )
        elif result.exit_code != 0:
            self.store.add_event(session.run_id, "task.failed", {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "status": task.status, "attempt_index": result.attempt_index})
            evidence.add_finding("worker_execution", False, f"{backend.name} failed {task.role.value} with exit code {result.exit_code}", "high")
        else:
            self.store.add_event(session.run_id, "task.completed", {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "status": task.status, "attempt_index": result.attempt_index})
        self.store.save_evidence(evidence)
        return session

    @staticmethod
    def _goal_slot_runtimes(session: RunSession) -> dict[str, Any]:
        """The Goal Mode (PR4) per-slot agent map ``{role: {backend, model, effort}}``
        a goal run binds to its plan slots (set by ``start_confirmed_goal_run`` via
        ``execution_context['goal_slot_runtimes']``). Empty for every normal
        company/issue run — both execution paths then keep the round-robin default."""
        rt = (session.execution_context or {}).get("goal_slot_runtimes")
        return rt if isinstance(rt, dict) else {}

    @staticmethod
    def _slot_runtime_for(task: TaskNode, slot_runtimes: dict[str, Any]) -> dict[str, Any] | None:
        """The per-slot runtime bound to ``task``'s role, or None. Role is read
        defensively (a task without a role — never a goal slot — short-circuits to
        None), so this is a strict no-op for any run that has no goal_slot_runtimes."""
        if not isinstance(slot_runtimes, dict) or not slot_runtimes:
            return None
        role = task.role.value if task.role else None
        if not role:
            return None
        rt = slot_runtimes.get(role)
        return rt if isinstance(rt, dict) else None

    def _slot_backend(self, task: TaskNode, slot_runtimes: dict[str, Any], fallback: Any) -> Any:
        """Resolve the backend bound to ``task``'s role, falling back to ``fallback``
        (the round-robin pick). Fail-safe: an unknown/unavailable bound backend
        degrades to the fallback rather than crashing the run — it only changes WHICH
        agent runs, never a governance gate (and confirm already validates names
        fail-closed; this is the defense-in-depth backstop for a backend that went
        away between confirm and run). Shared by the serial and parallel execution
        paths so a LINEAR (concurrency=1) goal binds per-slot agents identically."""
        rt = self._slot_runtime_for(task, slot_runtimes)
        name = rt.get("backend") if isinstance(rt, dict) else None
        if name:
            try:
                resolved = select_backends(str(name), self.backends)
            except ValueError:
                resolved = []  # unknown backend name → degrade to the fallback, never crash
            if resolved:
                return resolved[0]
        return fallback

    @staticmethod
    def _slot_limits(task: TaskNode, slot_runtimes: dict[str, Any], base_limits: Any, run_backend: str = "") -> Any:
        """Per-slot ``model``/``effort`` override layered onto ``base_limits`` (the
        run/lead limits). Shared by both execution paths.

        An explicit per-slot value always wins. An EMPTY per-slot value behaves like
        the rest of the runtime contract: it means "this slot's runtime default". When
        the slot runs on the SAME backend as the run, that default is the run/lead
        override (kept). When the slot runs on a DIFFERENT backend, the lead's
        model/effort is non-portable (a model id / effort enum specific to the lead's
        runtime), so an empty value CLEARS the override to the slot backend's own
        default — never leaks the lead's model onto another agent (mirrors the
        backend-mismatch gate in ``_bind_agent_identity`` / ``run_existing_goal``)."""
        rt = SuperClawOrchestrator._slot_runtime_for(task, slot_runtimes)
        if not isinstance(rt, dict):
            return base_limits
        slot_backend = str(rt.get("backend") or "").strip()
        model = str(rt.get("model") or "").strip()
        effort = str(rt.get("effort") or "").strip()
        different_backend = bool(slot_backend) and bool(run_backend) and slot_backend != run_backend
        if not (model or effort) and not different_backend:
            return base_limits  # same backend, nothing explicit → keep the run default
        if different_backend:
            # Non-portable lead override is dropped unless this slot set its own.
            new_model = model or None
            new_effort = effort or None
        else:
            new_model = model or base_limits.model_override
            new_effort = effort or base_limits.effort_override
        return replace(base_limits, model_override=new_model, effort_override=new_effort)

    @staticmethod
    def _worker_tokens(result: Any) -> int | None:
        """The token spend a worker actually reported — read from its ``cost`` snapshot
        (the CostSnapshot dict, where backend metering lives), or None if the backend
        reported no token counts. Used to settle a goal budget reservation to ACTUAL
        spend (a worker that overspent its slice books the higher real number, never the
        smaller reservation); None means the caller books the conservative reserved
        amount instead, so a normal worker is never under-counted."""
        cost = getattr(result, "cost", None)
        if not isinstance(cost, dict):
            return None
        # Use the SAME token metric the rest of the budget system uses for
        # ``total_tokens`` (input + output only — see state.cost_summary), so a PR7
        # reservation never exhausts on a different number than company/agent budgets.
        nums = [
            int(cost[key])
            for key in ("input_tokens", "output_tokens")
            if isinstance(cost.get(key), int)
        ]
        return max(0, sum(nums)) if nums else None

    def _run_token_total(self, run_id: str) -> int | None:
        """A child run's total token spend (input + output across its cost events, the
        same metric as ``total_tokens``), or None if it recorded none — used to settle a
        fan-out-node branch's goal-budget reservation to actual spend (PR9)."""
        try:
            events = self.store.list_cost_events(run_id=run_id)
        except Exception:  # noqa: BLE001 - settlement must never break the fan-out
            return None
        nums = [
            int(e.input_tokens or 0) + int(e.output_tokens or 0)
            for e in events
            if isinstance(getattr(e, "input_tokens", None), int) or isinstance(getattr(e, "output_tokens", None), int)
        ]
        return sum(nums) if nums else None

    def _execute_frontier_parallel(
        self, frontier: list[TaskNode], goal: GoalSpec, graph: TaskGraph, session: RunSession, evidence: EvidenceBundle,
        run_lease: RunMutationLease, selected_backends: list[Any], limits: Any, concurrency: int, is_cancel_requested,
    ) -> tuple[RunSession, EvidenceBundle, bool]:
        """Run an independent frontier's regular tasks concurrently.

        Bounded WAVE submission: at most ``workers`` tasks are submitted at a time,
        and ``task.started`` is emitted only at submission. The moment one task
        raises EscalationPending we stop submitting — tasks still queued are NEVER
        started (no side effects, no ghost start events). In-flight tasks (≤ workers)
        cannot be killed, so we drain them: completed siblings are recorded (not lost,
        not re-run on resume); the escalated task is left without a result so it stays
        "running" → reset to pending on suspend. This is "suspend = stop" as far as a
        thread pool allows. Fan-out nodes run sequentially afterward.
        """
        regular = [task for task in frontier if not task.fanout]
        fanout = [task for task in frontier if task.fanout]
        # Goal Mode (PR4) per-slot multi-agent: a goal run may bind a different agent
        # to each plan slot via execution_context["goal_slot_runtimes"]. The resolution
        # is shared with the serial path (_slot_backend / _slot_limits) so a LINEAR
        # concurrency=1 goal binds identically. Empty for normal runs (no-op).
        slot_runtimes = self._goal_slot_runtimes(session)
        run_backend = str((session.execution_context or {}).get("backend_policy") or "")
        # Goal Mode (PR7) concurrent budget reservation: when a fan-out goal passes a
        # reservation config, a worker is ADMITTED only after reserving its slice from
        # the goal's budget (an atomic store op), and the slice is settled to actual
        # spend when it finishes. Two concurrent admissions cannot both pass without
        # headroom, so a fan-out can never collectively overspend the goal budget. A
        # denied admission stops the wave and fails the frontier (budget exhausted).
        reservation = (session.execution_context or {}).get("goal_budget_reservation")
        budget_goal_id = reservation.get("goal_id") if isinstance(reservation, dict) else None
        per_worker = int(reservation.get("per_worker_tokens") or 0) if isinstance(reservation, dict) else 0
        reserved_tasks: dict[str, int] = {}
        budget_denied = False

        assigned: list[tuple[TaskNode, Any]] = [
            (task, self._slot_backend(task, slot_runtimes, selected_backends[index % len(selected_backends)]))
            for index, task in enumerate(regular)
        ]

        def _settle(task_id: str, result: Any) -> None:
            amount = reserved_tasks.pop(task_id, None)
            if amount is None or not budget_goal_id:
                return
            tokens = self._worker_tokens(result) if result is not None else 0
            # Unknown token spend on a completed worker books the conservative reserved
            # amount (never under-counts the budget); a suspended/failed worker releases
            # with 0 spend so a resume can re-reserve.
            actual = amount if (tokens is None and result is not None) else (tokens or 0)
            self.store.settle_goal_reservation(budget_goal_id, amount, actual)

        results: dict[str, Any] = {}
        escalation: EscalationPending | None = None
        delegation: tuple[DelegationRequested, TaskNode, Any] | None = None
        worker_crashed = False
        if assigned:
            workers = max(1, min(int(concurrency), len(assigned)))
            bound_goal, bound_limits = self._bind_agent_identity(session, goal, limits)
            queue = iter(assigned)
            future_task: dict[Any, tuple[TaskNode, Any]] = {}

            def _submit_next() -> bool:
                nonlocal session, budget_denied
                item = next(queue, None)
                if item is None:
                    return False
                task, backend = item
                # Admission FIRST (before any task.start side effect): reserve this
                # worker's budget slice; a denied reservation means the goal budget
                # is exhausted — stop dispatching, fail the frontier.
                if budget_goal_id and per_worker > 0:
                    if not self.store.reserve_goal_budget(budget_goal_id, per_worker):
                        budget_denied = True
                        return False
                    reserved_tasks[task.task_id] = per_worker
                session, _ = self._emit_task_start(task, backend, graph, session, evidence, run_lease)
                # Route through _run_backend so the DL4 batch diagnostic is emitted
                # up front for non-streaming backends on the parallel path too.
                future_task[pool.submit(self._run_backend, backend, task, bound_goal, session, self._slot_limits(task, slot_runtimes, bound_limits, run_backend))] = (task, backend)
                return True

            try:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    for _ in range(workers):
                        if not _submit_next():
                            break
                    while future_task:
                        done, _ = wait(list(future_task), return_when=FIRST_COMPLETED)
                        for future in done:
                            task, _backend = future_task.pop(future)
                            try:
                                results[task.task_id] = future.result()
                                _settle(task.task_id, results[task.task_id])
                            except EscalationPending as exc:
                                _settle(task.task_id, None)  # release; a resume re-reserves
                                if escalation is None:
                                    escalation = exc  # stop refilling — queued tasks never start
                            except DelegationRequested as exc:
                                _settle(task.task_id, None)
                                if delegation is None:
                                    delegation = (exc, task, _backend)
                            except Exception:  # noqa: BLE001 — a crashed worker must not
                                # abort settlement of its already-finished siblings (which
                                # would book them at 0 and undercount). Settle THIS task's
                                # reservation, mark the wave failed, and keep draining the
                                # rest so every sibling settles to its real spend.
                                _settle(task.task_id, None)
                                worker_crashed = True
                        # Refill ONLY while nothing has stopped the wave (no escalation,
                        # delegation, or crashed worker).
                        while (
                            escalation is None
                            and delegation is None
                            and not worker_crashed
                            and len(future_task) < workers
                            and _submit_next()
                        ):
                            pass
            finally:
                # Leak-free: release any reservation that did not settle through the
                # normal paths above — a worker that crashed with a generic exception
                # (which propagates out of the pool) must not strand its budget slice.
                for _leaked in list(reserved_tasks):
                    _settle(_leaked, None)

        failed = budget_denied or worker_crashed
        for task, backend in assigned:
            if task.task_id not in results:
                continue  # escalated / crashed / never-submitted — leave for resume
            session = self._record_task_result(task, backend, results[task.task_id], graph, session, evidence, run_lease)
            if results[task.task_id].exit_code != 0:
                failed = True

        if budget_denied or worker_crashed:
            # Either the goal budget could not admit a fan-out worker, or a worker
            # crashed: a fan-out task can no longer complete. Mark the run failed +
            # record a finding so the outcome is auditable; the goal then projects to
            # blocked, never complete.
            reason = (
                "fan-out worker denied: the goal token budget is exhausted"
                if budget_denied
                else "a fan-out worker crashed"
            )
            evidence.add_finding("goal_budget" if budget_denied else "worker_execution", False, reason, "high")
            session.status = RunStatus.FAILED.value

        if escalation is not None:
            # Completed siblings are now durably recorded; suspend the run so the
            # escalated task can be approved + resumed without re-running the rest.
            raise escalation
        if delegation is not None:
            pending, task, backend = delegation
            result = self._suspend_for_child_delegation(
                session,
                graph,
                evidence,
                run_lease,
                pending,
                task=task,
                source_backend=backend.name,
                permission_policy=bound_limits.permission_policy,
                containment_policy=bound_limits.containment_policy,
            )
            raise _DelegationSuspended(result)

        if not failed:
            for task in fanout:
                if is_cancel_requested():
                    break
                session, evidence, fanout_ok = self._execute_fanout_task(task, goal, graph, session, evidence, run_lease)
                if not fanout_ok:
                    failed = True
                    break
        return session, evidence, failed

    def _resolve_run_containment(self, session: RunSession) -> ContainmentPolicy:
        """Resolve (and persist) a run's containment fence — the SINGLE choke point
        every execution path reaches via ``execute_existing_session``.

        If a prior path already resolved + persisted the policy it is re-used (the
        preset name is authoritative, so a stale dict cannot relax it). Otherwise
        it is resolved NOW from whatever organizational scope the run carries —
        an explicit ``workspace_id``/``company_profile_id`` in the execution
        context, else the bound agent profile's workspace, else the chat session's
        workspace — so a run created by ANY path (start_existing_goal, /api/chat,
        ClawHunt autorun, …) is fenced, not just ``run_existing_goal``."""
        ctx = session.execution_context or {}
        # Collect EVERY workspace scope the run touches — explicit, bound profile,
        # chat session, AND the execution repo_path. A run whose chat session is a
        # standard workspace but whose execution repo IS a low-trust workspace must
        # be fenced by the STRICTER of the two; resolving from a single "winning"
        # source let that mismatch escape.
        candidate_ws: list[str] = []
        company_hint = ctx.get("company_profile_id")
        if ctx.get("workspace_id"):
            candidate_ws.append(ctx["workspace_id"])
        profile_id = ctx.get("agent_profile_id")
        if profile_id:
            try:
                profile = self.store.get_agent_profile(profile_id)
                candidate_ws.append(profile.workspace_id)
                company_hint = company_hint or profile.company_profile_id
            except KeyError:
                pass
        if session.chat_session_id:
            try:
                chat = self.store.get_chat_session(session.chat_session_id)
                if getattr(chat, "workspace_id", None):
                    candidate_ws.append(chat.workspace_id)
            except KeyError:
                pass
        repo_path = ctx.get("repo_path")
        repo_lookup_failed = False
        if repo_path:
            try:
                from superclaw import workspace_resolver

                matched = workspace_resolver.find_workspace_for_path(self.store, repo_path)
                if matched is not None:
                    candidate_ws.append(matched.workspace_id)
            except Exception:
                # Cannot determine the repo's trust state — fail-closed (same as the
                # API/CLI chat guards): a run whose only low-trust signal could come
                # from repo_path must not fall back to standard on an unknown.
                repo_lookup_failed = True
        review_issue = None
        issue_id = ctx.get("issue_id")
        if issue_id:
            try:
                review_issue = self.store.get_issue(issue_id)
            except KeyError:
                review_issue = None
        # Resolve a policy per candidate workspace (each derives its OWN company
        # floor + risk default via resolve_for_workspace) plus a company/issue-only
        # baseline; STRICTEST wins.
        candidates = [
            resolve_containment_policy(self.store, company_profile_id=company_hint, issue=review_issue)
        ]
        if repo_lookup_failed:
            from superclaw.containment import get_preset

            candidates.append(get_preset("low_trust_review"))
        seen: set[str] = set()
        for ws in candidate_ws:
            if not ws or ws in seen:
                continue
            seen.add(ws)
            candidates.append(resolve_for_workspace(self.store, ws, issue=review_issue))
        fresh = max(candidates, key=lambda p: p.strictness)
        # STRICTEST of any persisted policy and the freshly-resolved current scope
        # — NOT an early return. A run persisted as standard before its
        # workspace/company/issue was tightened to low-trust picks the fence up on
        # (re-)execution/resume; a persisted low-trust is never relaxed. Tighten-only.
        existing = ctx.get("containment_policy")
        if isinstance(existing, dict):
            persisted = ContainmentPolicy.from_dict(existing)
            policy = persisted if persisted.strictness >= fresh.strictness else fresh
        else:
            policy = fresh
        session.execution_context["containment_policy"] = policy.to_dict()
        return policy

    def execute_existing_session(self, goal: GoalSpec, session: RunSession, **kwargs: Any) -> RunResult:
        """Trace choke point: bind run_id (+ inherit-or-generate trace_id) for the
        whole execution, then delegate. Every execution path reaches here, so this
        is the single place correlation is set. Cross-thread workers inherit the
        parent context via copy_context at submit; a direct call with no ambient
        trace_id generates a fresh one here."""
        with trace_context.bind(
            trace_id=trace_context.get("trace_id") or trace_context.new_id("trace"),
            run_id=session.run_id,
        ):
            return self._execute_existing_session_impl(goal, session, **kwargs)

    def _execute_existing_session_impl(
        self,
        goal: GoalSpec,
        session: RunSession,
        *,
        dry_run: bool = False,
        backend_policy: str = "claude",
        model: str | None = None,
        effort: str | None = None,
        repo_path: str | Path = ".",
        concurrency: int = 1,
        budget_seconds: int = 60,
        artifact_dir: str | Path | None = None,
        verification_policy: str = "adversarial",
        harness_policy: str = "codex",
        permission_policy: PermissionPolicy | None = None,
        task_topology: TaskTopology = TaskTopology.LINEAR,
        mutation_mode: RunMutationMode = RunMutationMode.EXECUTE,
    ) -> RunResult:
        repo = Path(repo_path).resolve()
        # Execution choke point (single kernel gate for every run_goal-based run):
        # if `repo` is a real-folder managed project, re-verify its pinned inode
        # before any backend uses it as a cwd — a deleted/swapped directory is
        # WorkspaceDirCompromised, never silently re-created. No-op otherwise.
        from . import workspace_resolver as _wsr

        _wsr.assert_execution_repo_safe(self.store, repo)
        _repo_protected = _wsr.is_protected_project_repo(self.store, repo)
        artifact_root = Path(artifact_dir or default_artifact_dir()).resolve() / session.run_id
        graph = session.task_graph or TaskGraph.from_goal(
            goal,
            roles=[WorkerRole.EXPLORE, WorkerRole.PLAN, WorkerRole.IMPLEMENT, WorkerRole.VERIFY, WorkerRole.REVIEW],
            topology=task_topology,
        )
        graph.validate()
        # Context-pointers baseline (Paperclip §2.7): snapshot HEAD + already-dirty
        # paths ONCE at run start so the terminal capture can diff "what THIS run
        # changed". Idempotent across resume — never reset an existing baseline, or
        # a resumed run would attribute pre-resume changes to nothing.
        if "git_pointer_baseline" in session.execution_context:
            # Idempotent across resume: the baseline is captured exactly ONCE, at
            # the first run start. Keyed on PRESENCE, not truthiness — a fail-open
            # None is a real, sticky baseline ("unknown"); re-capturing on resume
            # would reset it to the resume-time HEAD and swallow pre-resume changes
            # (the terminal would then falsely report no_changes instead of UNKNOWN).
            git_pointer_baseline = session.execution_context.get("git_pointer_baseline")
        else:
            try:
                git_pointer_baseline = capture_baseline(repo)
            except Exception:
                # Fail-open: the pointer baseline must NEVER abort a run start. A
                # missing baseline simply makes the terminal capture "unavailable".
                _LOGGER.warning(
                    "context-pointers baseline capture failed (fail-open) run_id=%s", session.run_id, exc_info=True
                )
                git_pointer_baseline = None
        effective_context = {
            **session.execution_context,
            "git_pointer_baseline": git_pointer_baseline,
            "backend_policy": backend_policy,
            "model": model,
            "effort": effort,
            "repo_path": str(repo),
            "concurrency": concurrency,
            "budget_seconds": budget_seconds,
            "artifact_dir": str(artifact_root.parent),
            "verification_policy": verification_policy,
            "harness_policy": harness_policy,
            "permission_policy": permission_policy.to_dict() if permission_policy else None,
            "task_topology": task_topology.value,
        }
        try:
            evidence = self.store.get_evidence(session.run_id)
        except KeyError:
            evidence = self.store.create_evidence(session.run_id)
        acquired = self._try_acquire_run_mutation(session, mode=mutation_mode)
        if acquired is None:
            latest = self.store.get_run(session.run_id)
            latest.task_graph = latest.task_graph or graph
            return RunResult(
                session=latest,
                task_graph=latest.task_graph,
                evidence=evidence,
                events=self.store.list_events_snapshot(session.run_id),
            )
        session, runtime_lease, run_lease = acquired
        lease_renewer = RunMutationLeaseRenewer(self.store, session.run_id, run_lease).start()
        try:
            budget_preflight = hard_budget_preflight(
                self.store,
                self._runtime_budget_checks(session, effective_context),
                action="run_start",
            )
            if not budget_preflight.allowed:
                payload = budget_preflight.to_dict()
                session.task_graph = graph
                session.execution_context = {
                    **effective_context,
                    "budget_preflight": payload,
                }
                session.status = RunStatus.FAILED.value
                self.store.save_run(session)
                evidence.add_probe("budget_preflight", 409, payload)
                evidence.add_finding(
                    "budget_preflight",
                    False,
                    str(payload["message"]),
                    "critical",
                    input_fields=["execution_context.budget_policy"],
                    remediation="Raise the hard budget or clear the governed scope before starting more work.",
                )
                evidence.set_backend_summary({"budget_preflight": payload})
                self.store.save_evidence(evidence)
                self.store.add_event(session.run_id, "run.budget_blocked", payload)
                return RunResult(
                    session=session,
                    task_graph=graph,
                    evidence=evidence,
                    events=self.store.list_events_snapshot(session.run_id),
                )
            session.task_graph = graph
            session.execution_context = effective_context
            session.status = RunStatus.RUNNING.value
            self.store.save_run(session)
            self.store.add_event(
                session.run_id,
                "run.started",
                {
                    "goal_id": goal.goal_id,
                    "dry_run": dry_run,
                    "backend_policy": backend_policy,
                    "model": model,
                    "effort": effort,
                    "repo_path": str(repo),
                    "concurrency": concurrency,
                    "budget_seconds": budget_seconds,
                    "verification_policy": verification_policy,
                    "harness_policy": harness_policy,
                    "permission_policy": permission_policy.to_dict() if permission_policy else None,
                    "task_topology": task_topology.value,
                    "mutation_mode": mutation_mode.value,
                },
            )
            session = self._assert_run_mutation_lease(session, evidence, run_lease)
            session.task_graph = graph

            backend_summary: dict[str, object] = {name: backend.available().to_dict() for name, backend in self.backends.items()}
            backend_summary["runtime"] = runtime_manifest()
            if permission_policy:
                backend_summary["permission_policy"] = permission_policy.to_dict()
            try:
                harness_profile = get_harness_profile(harness_policy)
                backend_summary["harness"] = harness_profile.to_dict()
                evidence.add_probe("harness_profile", 200, harness_profile.to_dict())
            except KeyError as exc:
                backend_summary["harness"] = {"harness_id": harness_policy, "available": False, "reason": str(exc)}
                evidence.add_probe("harness_profile", 404, backend_summary["harness"])
                evidence.add_finding("harness_profile", False, str(exc), "high")
            evidence.set_backend_summary(backend_summary)
            evidence.add_probe("control_plane", 200, {"ok": True, "mode": "dry" if dry_run else "local"})
            evidence.add_probe("protected_api_unauthorized", 401, {"detail": "missing auth probe"})

            selected_backends = select_backends(backend_policy, self.backends)

            # T11: resolve + enforce the containment fence HERE — the single choke
            # point EVERY run-execution path reaches (run_existing_goal,
            # start_existing_goal, /api/chat, autorun, resume, fan-out). If a prior
            # path already resolved + persisted the policy it is re-used (never
            # relaxed); otherwise it is resolved now from whatever scope the run
            # carries, so NO execution path can run uncontained. Then every selected
            # backend must prove it enforces the fence — a low-trust run on a
            # backend that cannot is REFUSED, not downgraded.
            containment_policy = self._resolve_run_containment(session)
            containment_unsupported: list[str] = []
            if containment_policy.is_low_trust:
                containment_unsupported = [
                    b.name for b in selected_backends if not backend_supports_containment(b, containment_policy)
                ]

            def is_cancel_requested() -> bool:
                try:
                    latest = self.store.get_run(session.run_id)
                except KeyError:  # pragma: no cover - defensive state deletion guard
                    return True
                if latest.status == RunStatus.CANCELLED.value:
                    return True
                if session.parent_run_id:
                    try:
                        parent = self.store.get_run(session.parent_run_id)
                    except KeyError:
                        return False
                    if parent.status == RunStatus.CANCELLED.value:
                        latest.status = RunStatus.CANCELLED.value
                        self.store.save_run(latest)
                        self.store.add_event(
                            session.run_id,
                            "run.cancel.propagated",
                            {
                                "run_id": session.run_id,
                                "parent_run_id": session.parent_run_id,
                                "parent_task_id": session.parent_task_id,
                            },
                        )
                        return True
                return False

            if dry_run:
                evidence.add_command("superclaw capability-plan", 0, f"planned {len(graph.tasks)} tasks with {backend_policy}")
                while True:
                    frontier = self._pending_frontier(graph)
                    if not frontier:
                        break
                    for task in frontier:
                        task.status = "completed"
                        session.task_graph = graph
                        session = self._assert_run_mutation_lease(session, evidence, run_lease)
                        session = self._sync_session_status(session)
                        self.store.save_run(session)
                        self.store.add_event(
                            session.run_id,
                            "worker.planned",
                            {
                                "task_id": task.task_id,
                                "role": task.role.value,
                                "dry_run": dry_run,
                                "depends_on": task.depends_on,
                            },
                        )
            elif not selected_backends:
                session.status = RunStatus.FAILED.value
                evidence.add_finding("worker_backend_available", False, f"no available backend for policy {backend_policy}", "critical")
            elif containment_unsupported:
                # Fail-closed: a low-trust review must not run on a backend that
                # cannot prove the read-only, no-data-plane-egress fence.
                session.status = RunStatus.FAILED.value
                evidence.add_finding(
                    "containment_enforced",
                    False,
                    f"backend(s) {containment_unsupported} cannot enforce containment "
                    f"'{containment_policy.preset}'; refusing to run untrusted-review work "
                    "uncontained (resolve a containment-capable backend or lift the fence)",
                    "critical",
                )
            else:
                effective_policy, plugin_note = self._project_plugins_into_policy(
                    permission_policy,
                    selected_backends,
                    artifact_root,
                    containment_policy,
                    allowed_plugin_ids=self._granted_plugin_ids(session),
                )
                if plugin_note:
                    self.store.add_event(
                        session.run_id,
                        "plugins.projected",
                        {"run_id": session.run_id, "note": plugin_note},
                    )
                limits = WorkerLimits(
                    repo_path=repo,
                    artifact_dir=artifact_root,
                    budget_seconds=budget_seconds,
                    permission_policy=effective_policy,
                    cancel_check=is_cancel_requested,
                    event_sink=self._make_worker_event_sink(session.run_id),
                    plugin_capabilities_note=plugin_note,
                    model_override=(model or "").strip() or None,
                    effort_override=(effort or "").strip() or None,
                    containment_policy=containment_policy,
                    protected_cwd=_repo_protected,
                )
                backend_index = 0
                while True:
                    if is_cancel_requested():
                        break
                    for task in graph.tasks:
                        if task.status == "running":
                            task.status = "pending"
                    invalid_status = next((task for task in graph.tasks if task.status not in {"pending", "completed"}), None)
                    if invalid_status is not None:
                        session.status = RunStatus.FAILED.value
                        evidence.add_finding(
                            "resume_frontier",
                            False,
                            f"task {invalid_status.task_id} is in non-resumable status {invalid_status.status}",
                            "high",
                        )
                        break
                    frontier = self._pending_frontier(graph)
                    if not frontier:
                        if any(task.status == "pending" for task in graph.tasks):
                            session.status = RunStatus.FAILED.value
                            evidence.add_finding(
                                "dag_frontier",
                                False,
                                "pending tasks remain without a satisfiable dependency frontier",
                                "high",
                            )
                        break
                    if concurrency > 1 and len([task for task in frontier if not task.fanout]) > 1:
                        # Parallel frontier: independent tasks run concurrently (opt-in
                        # via concurrency>1). concurrency<=1 keeps the sequential path below.
                        session, evidence, frontier_failed = self._execute_frontier_parallel(
                            frontier, goal, graph, session, evidence, run_lease,
                            selected_backends, limits, concurrency, is_cancel_requested,
                        )
                        if frontier_failed:
                            break
                        continue
                    for task in frontier:
                        if is_cancel_requested():
                            break
                        if task.fanout:
                            session, evidence, fanout_ok = self._execute_fanout_task(
                                task, goal, graph, session, evidence, run_lease
                            )
                            if not fanout_ok:
                                break  # fail closed; the failed node blocks the frontier
                            continue
                        # Goal Mode (PR4) per-slot multi-agent on the SERIAL path —
                        # the path a LINEAR concurrency=1 goal (Goal Mode's only shape)
                        # always takes. The bound backend for this task's role wins over
                        # the round-robin default; no-op + round-robin for normal runs.
                        slot_runtimes = self._goal_slot_runtimes(session)
                        slot_run_backend = str((session.execution_context or {}).get("backend_policy") or "")
                        backend = self._slot_backend(
                            task, slot_runtimes, selected_backends[backend_index % len(selected_backends)]
                        )
                        backend_index += 1
                        with self.locks.acquire(f"worker:{session.run_id}:{backend.name}:{task.role.value}", owner=session.run_id):
                            task.status = "running"
                            session.task_graph = graph
                            session = self._assert_run_mutation_lease(session, evidence, run_lease)
                            session, attempt_index = self._advance_task_attempt(session, task.task_id)
                            session = self._sync_session_status(session)
                            self.store.save_run(session)
                            self.store.add_event(
                                session.run_id,
                                "task.started",
                                {
                                    "task_id": task.task_id,
                                    "role": task.role.value,
                                    "backend": backend.name,
                                    "depends_on": task.depends_on,
                                    "attempt_index": attempt_index,
                                },
                            )
                            self.store.add_event(
                                session.run_id,
                                "worker.leased",
                                {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "attempt_index": attempt_index},
                            )
                            self._emit_permission_events(session, task, backend, attempt_index)
                            self.store.add_event(
                                session.run_id,
                                "command.started",
                                {"task_id": task.task_id, "role": task.role.value, "backend": backend.name, "attempt_index": attempt_index},
                            )
                            bound_goal, bound_limits = self._bind_agent_identity(session, goal, limits)
                            # Layer this slot's per-agent model/effort override (PR4) on
                            # top of the identity-bound limits, same as the parallel path.
                            bound_limits = self._slot_limits(task, slot_runtimes, bound_limits, slot_run_backend)
                            # DL4 batch disclosure happens inside _run_backend (the single
                            # delivery dispatch shared with the parallel-frontier path).
                            try:
                                result = self._run_backend(backend, task, bound_goal, session, bound_limits)
                            except DelegationRequested as pending:
                                raise _DelegationSuspended(
                                    self._suspend_for_child_delegation(
                                        session,
                                        graph,
                                        evidence,
                                        run_lease,
                                        pending,
                                        task=task,
                                        source_backend=backend.name,
                                        permission_policy=bound_limits.permission_policy,
                                        containment_policy=bound_limits.containment_policy,
                                    )
                                )
                            metadata_finding_keys = self._metadata_finding_keys(evidence)
                            evidence.add_worker_result(result)
                            self._record_worker_cost(session, result)
                            evidence.add_command(result.command, result.exit_code, result.output)
                            self._emit_new_evidence_metadata_finding_events(session, metadata_finding_keys, evidence)
                            if result.artifact_path and result.artifact_id:
                                artifact = ArtifactRef(
                                    kind="worker-log",
                                    path=result.artifact_path,
                                    sensitivity="internal",
                                    artifact_id=result.artifact_id,
                                    metadata={"backend": result.backend, "role": result.role, "task_id": result.task_id},
                                )
                                evidence.add_artifact(artifact)
                                self.store.add_event(
                                    session.run_id,
                                    "artifact.added",
                                    {"artifact_id": artifact.artifact_id, "kind": artifact.kind, "path": artifact.path},
                                )
                            if result.transcript_path and result.transcript_artifact_id:
                                transcript = ArtifactRef(
                                    kind="worker-transcript",
                                    path=result.transcript_path,
                                    sensitivity="internal",
                                    artifact_id=result.transcript_artifact_id,
                                    metadata={"backend": result.backend, "role": result.role, "task_id": result.task_id},
                                )
                                evidence.add_artifact(transcript)
                                self.store.add_event(
                                    session.run_id,
                                    "transcript.added",
                                    {"artifact_id": transcript.artifact_id, "kind": transcript.kind, "path": transcript.path},
                                )
                            self._emit_context_usage_event(session, task, backend, result, evidence)
                            task.status = "completed" if result.exit_code == 0 else "failed"
                            session.task_graph = graph
                            session = self._assert_run_mutation_lease(session, evidence, run_lease)
                            session = self._sync_session_status(session)
                            self.store.save_run(session)
                            if result.exit_code == 0:
                                # Self-expansion: a worker may grow the live graph mid-run.
                                self._apply_discovered_tasks(session, graph, evidence, result)
                            self.store.add_event(
                                session.run_id,
                                "command.completed",
                                {
                                    "task_id": task.task_id,
                                    "role": task.role.value,
                                    "backend": backend.name,
                                    "attempt_index": result.attempt_index,
                                    "exit_code": result.exit_code,
                                    "timed_out": result.timed_out,
                                    "cancelled": result.cancelled,
                                    "forced_kill": result.forced_kill,
                                },
                            )
                            if result.forced_kill:
                                self.store.add_event(
                                    session.run_id,
                                    "worker.forced_kill",
                                    {
                                        "task_id": result.task_id,
                                        "role": result.role,
                                        "backend": result.backend,
                                        "exit_code": result.exit_code,
                                    },
                                )
                            if result.cancelled:
                                task.status = "cancelled"
                                session.task_graph = graph
                                session = self._assert_run_mutation_lease(session, evidence, run_lease)
                                session = self._sync_session_status(session)
                                self.store.save_run(session)
                                self.store.add_event(
                                    session.run_id,
                                    "task.failed",
                                    {
                                        "task_id": task.task_id,
                                        "role": task.role.value,
                                        "backend": backend.name,
                                        "status": task.status,
                                        "attempt_index": result.attempt_index,
                                    },
                                )
                                self.store.add_event(
                                    session.run_id,
                                    "worker.cancelled",
                                    {
                                        "task_id": result.task_id,
                                        "role": result.role,
                                        "backend": result.backend,
                                        "exit_code": result.exit_code,
                                        "forced_kill": result.forced_kill,
                                    },
                                )
                                evidence.add_finding(
                                    "worker_cancelled",
                                    False,
                                    (
                                        f"{backend.name} cancelled {task.role.value} with exit code {result.exit_code}"
                                        + (" after forced kill" if result.forced_kill else "")
                                    ),
                                    "warning",
                                )
                            elif result.exit_code != 0:
                                self.store.add_event(
                                    session.run_id,
                                    "task.failed",
                                    {
                                        "task_id": task.task_id,
                                        "role": task.role.value,
                                        "backend": backend.name,
                                        "status": task.status,
                                        "attempt_index": result.attempt_index,
                                    },
                                )
                                evidence.add_finding(
                                    "worker_execution",
                                    False,
                                    f"{backend.name} failed {task.role.value} with exit code {result.exit_code}",
                                    "high",
                                )
                            else:
                                self.store.add_event(
                                    session.run_id,
                                    "task.completed",
                                    {
                                        "task_id": task.task_id,
                                        "role": task.role.value,
                                        "backend": backend.name,
                                        "status": task.status,
                                        "attempt_index": result.attempt_index,
                                    },
                                )
                            self.store.save_evidence(evidence)
                            if result.exit_code != 0:
                                break

            artifact_root.mkdir(parents=True, exist_ok=True)
            evidence_artifact = ArtifactRef(
                kind="evidence-json",
                path=str(artifact_root / "evidence.json"),
                sensitivity="internal",
                artifact_id=f"{session.run_id}_evidence",
                metadata={"run_id": session.run_id},
            )
            if not any(artifact.artifact_id == evidence_artifact.artifact_id for artifact in evidence.artifacts):
                evidence.add_artifact(evidence_artifact)
                self.store.add_event(
                    session.run_id,
                    "artifact.added",
                    {"artifact_id": evidence_artifact.artifact_id, "kind": evidence_artifact.kind, "path": evidence_artifact.path},
                )
            encountered_failure = session.status == RunStatus.FAILED.value or any(task.status == "failed" for task in graph.tasks)
            latest_status = self.store.get_run(session.run_id).status
            if latest_status != RunStatus.CANCELLED.value:
                session.status = RunStatus.VERIFYING.value
                session.task_graph = graph
                session = self._assert_run_mutation_lease(session, evidence, run_lease)
                self.store.save_run(session)
                self.store.add_event(
                    session.run_id,
                    "run.verifying",
                    {"run_id": session.run_id, "verification_policy": verification_policy},
                )
                verification_findings = []
                strategy = self.verification_strategies.get(str(verification_policy or ""))
                if strategy is not None:
                    verification_findings = strategy.verify(evidence)
                self.store.save_evidence(evidence)
                for finding in verification_findings:
                    self.store.add_event(session.run_id, "verification.finding", finding.__dict__)
                self.store.add_event(
                    session.run_id,
                    "verification.completed",
                    {"run_id": session.run_id, "verification_policy": verification_policy, "chain_verdict": evidence.chain_verdict.value},
                )
            # Capture changed-file pointers BEFORE freezing the evidence artifact so
            # the on-disk JSON and the store row agree (the parent reads the store
            # row; the artifact is the immutable audit copy). Idempotent + fail-open.
            self._record_context_pointers(session, evidence, repo)
            Path(evidence_artifact.path).write_text(json.dumps(evidence.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            self.store.save_evidence(evidence)

            latest_status = self.store.get_run(session.run_id).status
            if latest_status == RunStatus.CANCELLED.value:
                session.status = RunStatus.CANCELLED.value
            else:
                session.status = RunStatus.FAILED.value if encountered_failure or any(task.status == "failed" for task in graph.tasks) else RunStatus.COMPLETED.value
            session.task_graph = graph
            session = self._assert_run_mutation_lease(session, evidence, run_lease)
            self.store.save_run(session)
            # Run-scoped ticket teardown (#2): the run has reached a terminal
            # status, so eagerly revoke any RunTicket bound to it (incl. a respond
            # grant) — a leaked token must not outlive its run. Best-effort: the
            # verify-time terminal gate (company_ticket) is the hard guarantee, so a
            # revoke failure here must never crash the terminal path.
            try:
                self.store.revoke_run_tickets_for_run(session.run_id)
            except Exception:
                pass
            if session.status == RunStatus.FAILED.value:
                self.store.add_event(
                    session.run_id,
                    "run.failed",
                    {"chain_verdict": evidence.chain_verdict.value, "status": session.status},
                )
            if session.status == RunStatus.COMPLETED.value:
                self.store.add_event(
                    session.run_id,
                    "run.completed",
                    {"chain_verdict": evidence.chain_verdict.value, "status": session.status},
                )
            if session.status == RunStatus.CANCELLED.value:
                self.store.add_event(
                    session.run_id,
                    "run.cancelled",
                    {"chain_verdict": evidence.chain_verdict.value, "status": session.status},
                )
            self._sync_child_execution_to_parent(session)
            return RunResult(
                session=session,
                task_graph=graph,
                evidence=evidence,
                events=self.store.list_events_snapshot(session.run_id),
            )
        except _DelegationSuspended as suspended:
            return suspended.result
        except EscalationPending as pending:
            # A B-class tool needs human approval. Suspend (NOT fail): the run holds
            # at WAITING_FOR_HUMAN_GATE with a durable PENDING escalation; resume
            # re-enters and consumes the grant once approved. Must precede the
            # generic BaseException handler, which would otherwise mark it FAILED.
            return self._suspend_for_escalation(session, graph, evidence, run_lease, pending.envelope)
        except BaseException as exc:
            # No execution error may leave the run claiming to be in progress:
            # close out to a terminal status here, then let non-lease errors
            # propagate to the caller.
            lease_lost = isinstance(exc, RuntimeError) and str(exc).startswith("run mutation lease lost during")
            latest = self._fail_closed_after_execution_error(session.run_id, graph, run_lease, exc, lease_lost=lease_lost)
            if lease_lost:
                return RunResult(
                    session=latest,
                    task_graph=graph,
                    evidence=evidence,
                    events=self.store.list_events_snapshot(session.run_id),
                )
            raise
        finally:
            lease_renewer.stop()
            self._release_run_mutation(session.run_id, runtime_lease=runtime_lease, lease=run_lease)

    def _suspend_for_escalation(self, session, graph, evidence, run_lease, envelope) -> RunResult:
        """Suspend a run into WAITING_FOR_HUMAN_GATE pending an approval decision.

        Running tasks are reset to pending so resume re-runs them (the B-class worker
        re-enters its turn; once the grant is approved+consumed it proceeds). The
        PENDING escalation is already durable (the gate created it); here we record
        the run-level transition + notify surfaces (SSE only notifies — the store is
        the authority)."""
        for task in graph.tasks:
            if task.status == "running":
                task.status = "pending"
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session.status = RunStatus.WAITING_FOR_HUMAN_GATE.value
        self.store.save_run(session)
        # Surface EVERY open pending for this run, not just the one carried by the
        # exception: under a parallel frontier several siblings may have escalated.
        # The durable store is the authority; these events are notifications only.
        pendings = self.store.list_escalations(status="pending", run_id=session.run_id)
        if all(p.request_id != envelope.request_id for p in pendings):
            pendings = [envelope, *pendings]
        for pending in pendings:
            self.store.add_event(
                session.run_id,
                "escalation.requested",
                {
                    "request_id": pending.request_id,
                    "kind": pending.kind,
                    "tool_name": pending.tool_name,
                    "run_id": session.run_id,
                },
            )
        self.store.add_event(
            session.run_id,
            "run.waiting_for_human_gate",
            {
                "run_id": session.run_id,
                "request_ids": [p.request_id for p in pendings],
                "pending_count": len(pendings),
            },
        )
        return RunResult(
            session=session,
            task_graph=graph,
            evidence=evidence,
            events=self.store.list_events(session.run_id),
        )

    def _suspend_for_child_delegation(
        self,
        session: RunSession,
        graph: TaskGraph,
        evidence: EvidenceBundle,
        run_lease: RunMutationLease,
        pending: DelegationRequested,
        *,
        task: TaskNode,
        source_backend: str,
        permission_policy: PermissionPolicy | None,
        containment_policy: ContainmentPolicy | None,
    ) -> RunResult:
        """Authorize a delegate tool call, spawn one linked child, and park parent.

        This is P1-2a's durable broker seam: the backend only raises a structured
        intent; the orchestrator owns admission, child creation, the waiting state,
        and duplicate suppression keyed by the model's tool-call id.
        """
        request_key = self._delegation_request_key(pending)
        latest = self.store.get_run(session.run_id)
        waits = self._delegation_waits(latest)
        existing = next((item for item in waits if item.get("request_key") == request_key), None)
        child_start: tuple[GoalSpec, RunSession, dict[str, Any]] | None = None
        if existing is not None and existing.get("child_run_id"):
            child_run_id = str(existing["child_run_id"])
            self.store.add_event(
                session.run_id,
                "delegation.wait.reused",
                {
                    "request_key": request_key,
                    "child_run_id": child_run_id,
                    "parent_tool_call_id": pending.parent_tool_call_id,
                },
            )
        else:
            inventory = {
                str(item.get("name")): item
                for item in build_agent_inventory(backends=self.backends)
                if item.get("name")
            }
            trace_id = str((latest.execution_context or {}).get("trace_id") or _id("trace"))
            decision = authorize_delegation_for_parent(
                pending.request,
                parent_session=latest,
                source_backend=source_backend,
                enabled=delegation_enabled(),
                inventory=inventory,
                profile_loader=self._profile_or_none,
                pay_scan_classifier=self._is_pay_scan_sensitive,
                parent_effective_tools=self._parent_effective_delegate_tools(
                    permission_policy=permission_policy,
                    containment_policy=containment_policy,
                ),
                # layer 3:父的 granted plugins(None=非 team 父=不收窄)。child_plugin_grants
                # 由 authorize 算成 parent ∩ profile(no-profile 继承),强制 child ⊆ parent。
                parent_effective_plugins=self._granted_plugin_ids(latest),
                parent_allows_privileged=(permission_policy.mode if permission_policy else None)
                in {"bypassPermissions", "dontAsk"},
                parent_budget_remaining_seconds=int((latest.execution_context or {}).get("budget_seconds") or 60),
                trace_id=trace_id,
                parent_tool_call_id=pending.parent_tool_call_id,
            )
            if not decision.authorized or not decision.child_spec:
                task.status = "failed"
                session.task_graph = graph
                session = self._assert_run_mutation_lease(session, evidence, run_lease)
                session.status = RunStatus.FAILED.value
                evidence.add_finding(
                    "cross_runtime_delegation",
                    False,
                    f"delegate request denied: {decision.reason}",
                    "high",
                )
                self.store.save_evidence(evidence)
                self.store.save_run(session)
                self.store.add_event(
                    session.run_id,
                    "delegation.denied",
                    {
                        "request_key": request_key,
                        "reason": decision.reason,
                        "parent_tool_call_id": pending.parent_tool_call_id,
                    },
                )
                return RunResult(
                    session=session,
                    task_graph=graph,
                    evidence=evidence,
                    events=self.store.list_events(session.run_id),
                )
            child_spec = dict(decision.child_spec)
            if not child_spec.get("backend_policy"):
                task.status = "failed"
                session.task_graph = graph
                session = self._assert_run_mutation_lease(session, evidence, run_lease)
                session.status = RunStatus.FAILED.value
                evidence.add_finding(
                    "cross_runtime_delegation",
                    False,
                    "delegate request denied: target runtime must be explicit for P1-2 broker execution",
                    "high",
                )
                self.store.save_evidence(evidence)
                self.store.save_run(session)
                self.store.add_event(
                    session.run_id,
                    "delegation.denied",
                    {
                        "request_key": request_key,
                        "reason": "target runtime required",
                        "parent_tool_call_id": pending.parent_tool_call_id,
                    },
                )
                return RunResult(
                    session=session,
                    task_graph=graph,
                    evidence=evidence,
                    events=self.store.list_events(session.run_id),
                )
            child_goal, child_session, exec_kwargs = self._create_linked_child(
                latest,
                task.task_id,
                title=str(child_spec["title"]),
                description=str(child_spec["description"]),
                backend_policy=str(child_spec["backend_policy"]),
                model=child_spec.get("model"),
                budget_seconds=int(child_spec["budget_seconds"]),
                agent_profile_id=child_spec.get("agent_profile_id"),
                execution_context_extra=child_spec.get("execution_context"),
            )
            latest = self.store.get_run(session.run_id)
            waits = self._delegation_waits(latest)
            existing = {
                "request_key": request_key,
                "status": "waiting",
                "child_run_id": child_session.run_id,
                "child_task_id": child_session.execution_context.get("child_task_id"),
                "parent_task_id": task.task_id,
                "parent_tool_call_id": pending.parent_tool_call_id,
                "source_backend": source_backend,
                "requested_runtime": pending.request.runtime,
                "trace_id": child_session.execution_context.get("trace_id"),
            }
            waits.append(existing)
            latest.execution_context["child_delegation_waits"] = waits
            self.store.save_run(latest)
            self.store.add_event(
                session.run_id,
                "delegation.child_spawned",
                existing,
            )
            self.store.add_event(
                session.run_id,
                "child_run.event",
                {
                    "child_run_id": child_session.run_id,
                    "child_task_id": child_session.execution_context.get("child_task_id"),
                    "parent_task_id": task.task_id,
                    "parent_tool_call_id": pending.parent_tool_call_id,
                    "event_type": "child_run.spawned",
                    "payload": {
                        "child_run_id": child_session.run_id,
                        "backend": child_session.execution_context.get("backend_policy"),
                    },
                },
            )
            child_start = (child_goal, child_session, exec_kwargs)

        for node in graph.tasks:
            if node.status == "running":
                node.status = "pending"
        persisted_parent = self.store.get_run(session.run_id)
        session.child_executions = persisted_parent.child_executions
        merged_context = dict(persisted_parent.execution_context or {})
        merged_context.update(session.execution_context or {})
        session.execution_context = merged_context
        session.task_graph = graph
        session = self._assert_run_mutation_lease(session, evidence, run_lease)
        session.status = RunStatus.WAITING_FOR_CHILD_DELEGATION.value
        session.execution_context["child_delegation_waits"] = self._delegation_waits(persisted_parent)
        self.store.save_run(session)
        self.store.add_event(
            session.run_id,
            "run.waiting_for_child_delegation",
            {
                "run_id": session.run_id,
                "request_key": request_key,
                "parent_tool_call_id": pending.parent_tool_call_id,
            },
        )
        if child_start is not None:
            child_goal, child_session, exec_kwargs = child_start
            self._start_child_async(child_goal, child_session, exec_kwargs)
        return RunResult(
            session=session,
            task_graph=graph,
            evidence=evidence,
            events=self.store.list_events(session.run_id),
        )

    def _fail_closed_after_execution_error(
        self,
        run_id: str,
        graph: TaskGraph,
        run_lease: RunMutationLease,
        exc: BaseException,
        *,
        lease_lost: bool,
    ) -> RunSession:
        detail = str(exc) or type(exc).__name__
        latest = self.store.get_run(run_id)
        if latest.status in TERMINAL_RUN_STATUSES:
            return latest
        if lease_lost:
            latest.status = RunStatus.FAILED.value
            latest.task_graph = latest.task_graph or graph
            self.store.save_run(latest)
            self.store.add_event(run_id, "run.failed", {"detail": detail, "status": latest.status})
            return latest
        current = latest.active_mutation_lease
        if current is None or current.lease_id != run_lease.lease_id:
            # Mutation authority moved to another writer; the close-out is its
            # responsibility now and fighting it would corrupt state.
            return latest
        # Interrupted while we own the run: close out with the same semantics as
        # reconcile_run — never leave a stored in-progress claim behind, but keep
        # deterministic resume alive when the frontier is reconstructable.
        work_graph = latest.task_graph or graph
        for task in work_graph.tasks:
            if task.status == "running":
                task.status = "pending"
        resume_evidence_error = self._resume_evidence_unavailable_detail(run_id)
        resumable = (
            bool(latest.execution_context)
            and self._resume_frontier(work_graph) is not None
            and resume_evidence_error is None
        )
        latest.status = RunStatus.QUEUED.value if resumable else RunStatus.FAILED.value
        latest.task_graph = work_graph
        self.store.save_run(latest)
        self.store.add_event(
            run_id,
            "run.interrupted",
            {
                "detail": detail,
                "error_type": type(exc).__name__,
                "status": latest.status,
                "resumable": resumable,
            },
        )
        if not resumable:
            self.store.add_event(run_id, "run.failed", {"detail": detail, "status": latest.status})
        return latest
