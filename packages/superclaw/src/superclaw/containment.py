"""Runtime containment policy — the low-trust review fence (T11).

When an agent reviews UNTRUSTED external code (a fork's PR, an imported diff,
a remote-sourced checkout), it must run inside a fail-closed runtime fence, not
the standard "can write + can shell + can reach the network" posture. This module
is the single kernel source of truth for that fence:

- ``ContainmentPolicy`` is the resolved, first-class policy a run carries — NOT
  free-form metadata. It rides into ``RunSession.execution_context`` and
  ``WorkerLimits`` and is re-enforced on resume/fanout (never relaxed).
- ``resolve_containment_policy`` composes company floor + workspace boundary +
  issue override, STRICTEST WINS, with a RISK-BASED DEFAULT: a remote /
  untrusted-source / high-risk workspace floors to ``low_trust_review`` instead
  of opting in. "未声明 = standard" is only safe for a user's own trusted repo.
- The real fence bites at the backend adapter: a backend that cannot PROVE it
  runs the policy (readonly + no data-plane egress) declares
  ``supports_containment(policy) == False`` and the run is REFUSED — never
  silently downgraded. (Per-backend native-sandbox mappings land in PR-B; in
  PR-A only the B-class in-process runtime can prove the readonly fence, so
  low-trust runs on uncontainable backends fail closed.)

Design rule mirrors permissions.py: this stays a POLICY module — it resolves and
declares, it does not implement a decision engine or an action taxonomy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

from superclaw.permissions import posture_denies_tool, posture_for_mode

if TYPE_CHECKING:  # avoid import cycles (state imports models, not containment)
    from superclaw.models import Issue
    from superclaw.state import StateStore


class ContainmentPreset(str, Enum):
    """The named containment fences. Two, deliberately — same minimal-surface
    discipline as the two permission presets (ask/allow)."""

    STANDARD = "standard"
    LOW_TRUST_REVIEW = "low_trust_review"


# Standard delegation depth (mirrors team_kernel.MAX_DELEGATION_DEPTH; defined
# here to avoid a containment <-> team_kernel import cycle — kept equal by the
# test_containment parity assertion).
STANDARD_MAX_DELEGATION_DEPTH = 8


@dataclass(frozen=True)
class ContainmentPolicy:
    """A resolved runtime fence. ``permission_mode_floor`` is the LEAST-privileged
    mode a run must execute at (a run's effective mode = strictest of its own mode
    and this floor). ``network_egress`` is about the UNTRUSTED-CODE data plane —
    never the backend's own model control-plane connection. ``strictness`` gives a
    total order so "strictest wins" is well-defined across resolution sources."""

    preset: str
    permission_mode_floor: str  # canonical PermissionPolicy.mode (e.g. "plan")
    network_egress: str  # "allow" | "deny" (data-plane only)
    max_delegation_depth: int
    filesystem: str  # "workspace" | "read_only"
    strictness: int  # higher = stricter; total order for strictest-wins resolution

    def to_dict(self) -> dict[str, Any]:
        return {
            "preset": self.preset,
            "permission_mode_floor": self.permission_mode_floor,
            "network_egress": self.network_egress,
            "max_delegation_depth": self.max_delegation_depth,
            "filesystem": self.filesystem,
            "strictness": self.strictness,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContainmentPolicy":
        # Canonicalize through the preset table so a tampered/partial dict can
        # never widen the fence: the preset name is authoritative.
        return get_preset(str(data.get("preset", ContainmentPreset.STANDARD.value)))

    @property
    def is_low_trust(self) -> bool:
        return self.preset == ContainmentPreset.LOW_TRUST_REVIEW.value


_STANDARD = ContainmentPolicy(
    preset=ContainmentPreset.STANDARD.value,
    permission_mode_floor="acceptEdits",  # today's default; no extra tightening
    network_egress="allow",
    max_delegation_depth=STANDARD_MAX_DELEGATION_DEPTH,
    filesystem="workspace",
    strictness=0,
)

_LOW_TRUST_REVIEW = ContainmentPolicy(
    preset=ContainmentPreset.LOW_TRUST_REVIEW.value,
    permission_mode_floor="plan",  # posture_for_mode("plan") == "readonly"
    network_egress="deny",
    max_delegation_depth=1,  # a reviewer may fan out one analysis layer, no deeper
    filesystem="read_only",
    strictness=10,
)

CONTAINMENT_PRESETS: dict[str, ContainmentPolicy] = {
    _STANDARD.preset: _STANDARD,
    _LOW_TRUST_REVIEW.preset: _LOW_TRUST_REVIEW,
}


def get_preset(name: str | None) -> ContainmentPolicy:
    """The policy for a preset name. Unknown/empty → standard (a preset name we
    don't understand must not silently become a *weaker* fence than the caller
    intended; risk-based resolution adds the strict floor where it matters)."""
    return CONTAINMENT_PRESETS.get((name or "").strip(), _STANDARD)


def _workspace_risk_floor(workspace: Any) -> ContainmentPolicy:
    """Risk-based DEFAULT floor for a workspace (fail-closed, not opt-in): a
    workspace that is remote-anchored or flagged untrusted-source is treated as
    low-trust EVEN IF it never set containment_preset. A user's own trusted repo
    (kind=repo, no risk flag) keeps the standard floor."""
    from superclaw.models import WorkspaceKind

    kind = getattr(workspace, "kind", WorkspaceKind.REPO.value)
    meta = getattr(workspace, "metadata", {}) or {}
    risky_source = str(meta.get("source_risk", "")).lower() in {"external", "fork", "untrusted"}
    if kind == WorkspaceKind.REMOTE.value or risky_source:
        return _LOW_TRUST_REVIEW
    return _STANDARD


def _strictest(*policies: ContainmentPolicy) -> ContainmentPolicy:
    return max(policies, key=lambda p: p.strictness)


def resolve_for_workspace(
    store: "StateStore", workspace_id: str, *, issue: "Issue | None" = None
) -> ContainmentPolicy:
    """Resolve the fence for a SINGLE workspace, deriving its company floor so a
    workspace whose own preset is ``standard`` but whose company declares a
    low-trust ``high_risk_policies.containment_preset`` is still fenced. Every
    candidate-workspace call site (run choke point, API chat guard, CLI guard)
    must go through this so the company floor is never silently dropped."""
    company_id = None
    try:
        company_id = store.get_workspace_profile(workspace_id).company_profile_id
    except KeyError:
        company_id = None
    return resolve_containment_policy(
        store, workspace_id=workspace_id, company_profile_id=company_id, issue=issue
    )


def workspace_effective_containment(workspace: Any) -> ContainmentPolicy:
    """The fence a workspace imposes on its own, store-free (for projections):
    the stricter of its declared preset and its risk-based floor. Does NOT add a
    company/issue source — those need a store and are layered in
    ``resolve_containment_policy`` for actual run dispatch."""
    return _strictest(
        get_preset(getattr(workspace, "containment_preset", None)),
        _workspace_risk_floor(workspace),
    )


def resolve_containment_policy(
    store: "StateStore",
    *,
    workspace_id: str | None = None,
    company_profile_id: str | None = None,
    issue: "Issue | None" = None,
) -> ContainmentPolicy:
    """Resolve the effective fence for a run: company floor + workspace boundary
    + issue override, STRICTEST WINS. A run can only ever be fenced TIGHTER by an
    additional source, never relaxed — so resume/fanout re-resolving cannot widen
    it. Workspace is the primary boundary (it is the trust container); the issue
    is the specific review fact; the company is the policy floor."""
    candidates: list[ContainmentPolicy] = [_STANDARD]

    if workspace_id and workspace_id != "local":
        try:
            workspace = store.get_workspace_profile(workspace_id)
        except KeyError:
            workspace = None
        if workspace is not None:
            candidates.append(get_preset(getattr(workspace, "containment_preset", None)))
            candidates.append(_workspace_risk_floor(workspace))

    if company_profile_id and company_profile_id != "local":
        try:
            company = store.get_company_profile(company_profile_id)
        except KeyError:
            company = None
        if company is not None:
            policies = getattr(company, "high_risk_policies", {}) or {}
            # A company can declare a containment floor for all its work.
            candidates.append(get_preset(policies.get("containment_preset")))

    if issue is not None:
        marked = (getattr(issue, "metadata", {}) or {}).get("containment_preset")
        if marked:
            candidates.append(get_preset(marked))

    return _strictest(*candidates)


# --- B-class (in-process) enforcement helper --------------------------------


# Secret-bearing files an untrusted-review run must never read: reviewing means
# reading the DIFF, not the workspace's credentials. Blocking shell + writes is
# not enough — an attacker could prompt the reviewer to read .env / a key and
# exfiltrate it through the legitimate review-comment channel (egress deny does
# not cover that channel). Matched case-insensitively against the /-normalized
# relative path.
_SENSITIVE_READ_PATTERNS = [
    re.compile(p)
    for p in (
        r"(^|/)\.env($|[./])",  # .env, .env.local, .env.production …
        r"(^|/)\.envrc$",
        r"(^|/)\.git/config$",
        r"(^|/)secrets?($|[/.])",
        r"\.(pem|key|p12|pfx|keystore|jks|ppk)$",
        r"(^|/)id_(rsa|dsa|ecdsa|ed25519)($|\.)",
        r"private[_-]?key",
        r"(^|/)\.(netrc|npmrc|pypirc|pgpass)$",
        r"(^|/)\.aws/credentials$",
        r"(^|/)\.kube/config$",
        r"(^|/)\.docker/config\.json$",
        r"(^|/)\.config/gcloud/",
        r"application_default_credentials\.json$",
        r"service[_-]?account.*\.json$",
        r"(^|/)credentials?($|[/.])",
        r"(^|/)\.ssh/",
        r"[_.-]token($|[._-])",  # *_token, .token, access-token …
        r"[_.-]secret($|[._-])",
    )
]


def containment_denies_read_path(policy: ContainmentPolicy | None, rel_path: str) -> bool:
    """Whether a read-only fence forbids READING this path because it is a
    secret-bearing file. Only bites under a ``read_only`` filesystem (low-trust
    review); standard runs read anything. Reviewing untrusted source is fine —
    reading its workspace's credentials and echoing them out is the exfiltration
    we prevent."""
    if policy is None or policy.filesystem != "read_only":
        return False
    norm = str(rel_path or "").replace("\\", "/").lower()
    return any(pattern.search(norm) for pattern in _SENSITIVE_READ_PATTERNS)


def containment_denies_tool(
    policy: ContainmentPolicy | None, tool_name: str, *, mode: str | None
) -> bool:
    """Whether the resolved fence forbids an in-process (B-class) tool. The
    effective posture is the STRICTEST of the run's own mode and the policy's
    floor — so a low-trust run is read-only even under an ``allow`` preset, and
    mutating tools (run_shell, write_file) are denied. Returns False with no
    policy so standard runs are byte-for-byte unchanged."""
    if policy is None:
        return False
    floor_posture = posture_for_mode(policy.permission_mode_floor)
    mode_posture = posture_for_mode(mode)
    # Take the STRICTEST of (run mode, floor): readonly > workspace > full, so
    # the computed posture matches this function's docstring. The old
    # `"readonly" in (...)` returned mode_posture verbatim otherwise, dropping a
    # `workspace` floor when the run mode was `full` (the max-permission
    # `bypassPermissions` preset). NOTE on scope: today only `readonly` actually
    # denies a tool in posture_denies_tool (workspace/full deny nothing here), and
    # the only live floor is read-only low-trust review — so this primarily
    # hardens the readonly path and FAILS CLOSED on an unknown posture (KeyError
    # rather than silent downgrade). A future workspace-deny semantics would then
    # be honored by construction. The B-class workspace ESCALATION gate keys on
    # the run's own posture, not on this effective posture — that is a separate,
    # pre-existing path, not something this floor drives.
    _RANK = {"readonly": 0, "workspace": 1, "full": 2}
    effective = min((floor_posture, mode_posture), key=lambda p: _RANK[p])
    return posture_denies_tool(effective, tool_name)
