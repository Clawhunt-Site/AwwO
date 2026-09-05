"""Domain-only agentcompanies/v1 bootstrap proposal builder.

Templates are untrusted blueprints. This module parses and normalizes a small
agentcompanies/v1-compatible shape into a proposal payload that later API/CLI
surfaces can review and commit through the real Team Kernel. It never writes to
StateStore and never grants equipment directly; all plugin/skill narrowing goes
through :func:`superclaw.team_kernel.resolve_equipment`.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

from typing import Callable

from superclaw.company_template import (
    _COMPANY_VERIFIER,
    default_company_revocation_file,
    CompanyTemplate,
    CompanyTemplateError,
    load_company_template,
    verify_company_template,
)
from superclaw.models import AgentProfile, IssueStatus
from superclaw.plugins import is_skill_origin_plugin
from superclaw.team_kernel import default_company_runtime_policy, resolve_equipment
from superclaw.trust import PackageTrustVerdict
from superclaw.trust_state import TrustState, derive_trust_state


def _kernel_available_plugins() -> list[Any]:
    from superclaw.team_kernel import available_plugins

    return available_plugins()


def _kernel_available_skill_ids() -> list[str]:
    from superclaw.team_kernel import available_skill_ids

    return available_skill_ids()


def _intersect_hint_with_gated(
    *,
    hint: list[str] | None,
    gated: list[str] | None,
    derive: Callable[[], list[Any]],
) -> list[str]:
    """Resolve the candidate id set the resolver may see (design §3.8).

    The GATED universe is authoritative — injected via ``gated`` (tests) or
    derived from the fail-closed kernel enumerator. A request ``hint`` only
    narrows it (``hint ∩ gated``); it can never widen it. With no hint, the full
    gated set is the candidate. So an ungated / unknown id in the request hint is
    silently dropped before the resolver ever sees it.
    """
    gated_universe = list(gated) if gated is not None else [str(item) for item in derive()]
    gated_set = set(gated_universe)
    if hint is None:
        return gated_universe
    return [sid for sid in hint if sid in gated_set]

AGENTCOMPANY_FILENAMES = (
    "agentcompany.json",
    "agentcompanies.json",
    "agentcompanies-v1.json",
    "superclaw-company.json",
)


class TeamTemplateError(ValueError):
    """Raised when a template source cannot be read or parsed as JSON."""


class CompanyTrustGateError(TeamTemplateError):
    """Raised when a ``kind=company`` template fails the verify-before-instantiate gate.

    This is the load-bearing security boundary: an unsigned / unverifiable / revoked
    / untrusted / reserved-namespace company template is rejected (fail-closed) BEFORE
    any bootstrap proposal is built, and re-checked at commit time (TOCTOU). It is a
    subclass of :class:`TeamTemplateError` so existing surfaces (CLI/API) keep their
    400/exit-1 handling, but callers that want to distinguish a trust rejection can.
    """


# Default admitted trust states for a company-sourced bootstrap. ``official`` is the
# only trust state admitted without an explicit local-dev opt-in; ``developer`` is
# deliberately EXCLUDED until the company verify primitive can validate registered
# developer keys on the raising path (design §3.4 — fail-closed, badge↔gate parity).
_DEFAULT_COMPANY_ALLOW_TRUST: frozenset[TrustState] = frozenset({TrustState.OFFICIAL})


@dataclass(frozen=True)
class CompanyBootstrapVerification:
    """The captured result of the company verify-before-instantiate gate.

    Recorded into the proposal so the commit path can re-run the SAME gate against
    the SAME source and assert the digest / trust / revocation have not changed
    between proposal and commit (closes the proposal→commit TOCTOU, design §3.7).
    """

    source_ref: str
    artifact_id: str
    version: str
    digest: str
    trust_class: str
    trust_state: str
    allow_local_opt_in: bool
    company_revocation_file: str | None = None
    # The proposal-build inputs that (with the verified manifest) deterministically
    # reproduce ``would_create``. Captured so the commit path can REBUILD the records
    # from the re-verified manifest and reject if the payload's records were tampered
    # (a valid verification block paired with malicious would_create). Serialized.
    runtime_budget_seconds: int = 0
    runtime_token_budget: int = 0
    available_plugin_ids: tuple[str, ...] | None = None
    available_skill_ids: tuple[str, ...] | None = None
    proposal_id: str = "bootstrap_template_proposal"
    # The EXACT verified manifest, bound to ``digest`` above. Normalization MUST
    # consume this — never a fresh re-read of ``source_ref`` — so the bytes that
    # were trust-verified are the bytes that become the proposal (closes the
    # verify-read vs normalize-read TOCTOU). Excluded from the serialized form.
    verified_manifest: dict[str, Any] | None = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("verified_manifest", None)
        if self.available_plugin_ids is not None:
            data["available_plugin_ids"] = list(self.available_plugin_ids)
        if self.available_skill_ids is not None:
            data["available_skill_ids"] = list(self.available_skill_ids)
        return data


@dataclass(frozen=True)
class TemplateMetadata:
    source: str
    revision: str
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BudgetClamp:
    requested: int
    effective: int
    company_limit: int
    runtime_limit: int
    clamped: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EquipmentResolutionSummary:
    profile_id: str
    role_id: str
    requested: dict[str, list[str]]
    granted: dict[str, list[str]]
    dropped: dict[str, list[dict[str, str]]]
    pending: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RoleTemplateProposal:
    role_id: str
    profile_id: str
    name: str
    role: str
    reports_to_role_id: str | None
    agent_profile: dict[str, Any]
    budget_clamp: dict[str, BudgetClamp]
    charter_policy_findings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["budget_clamp"] = {k: v.to_dict() for k, v in self.budget_clamp.items()}
        return data


@dataclass(frozen=True)
class BootstrapProposal:
    proposal_id: str
    template: TemplateMetadata
    blocked: bool
    rejections: tuple[dict[str, str], ...]
    would_create: dict[str, Any]
    role_proposals: tuple[RoleTemplateProposal, ...]
    equipment_resolution: tuple[EquipmentResolutionSummary, ...]
    approvals_required: tuple[dict[str, Any], ...] = ()
    company_verification: CompanyBootstrapVerification | None = None
    # Tamper-evident marker of the SOURCE kind. "company" iff the proposal was
    # built from a verified company template. The durable write boundary refuses a
    # "company"-sourced proposal that lacks a valid verification, so a caller cannot
    # strip company_verification while keeping the company semantics (fail-closed).
    source_kind: str = "team_template"

    def to_dict(self) -> dict[str, Any]:
        return {
            "proposal_id": self.proposal_id,
            "template": self.template.to_dict(),
            "blocked": self.blocked,
            "rejections": list(self.rejections),
            "would_create": self.would_create,
            "role_proposals": [role.to_dict() for role in self.role_proposals],
            "equipment_resolution": [resolution.to_dict() for resolution in self.equipment_resolution],
            "approvals_required": list(self.approvals_required),
            "company_verification": self.company_verification.to_dict() if self.company_verification else None,
            "source_kind": self.source_kind,
        }


@dataclass(frozen=True)
class _NormalizedRole:
    role_id: str
    name: str
    role: str
    title: str | None
    charter: str
    persona: str
    default_instructions: str
    reports_to: str | None
    backend_policy: str
    model: str
    effort: str
    company_profile_id: str
    workspace_id: str
    plugin_allowlist: list[str]
    skill_allowlist: list[str]
    required_capabilities: list[str]
    required_plugins: list[str]
    required_skills: list[str]
    budget_seconds: int
    token_budget: int
    run_count_budget: int
    external_tool_budget: int
    permission_policy: dict[str, Any]
    runtime_config: dict[str, Any]


@dataclass(frozen=True)
class _NormalizedTemplate:
    metadata: TemplateMetadata
    company: dict[str, Any]
    workspace: dict[str, Any]
    roles: tuple[_NormalizedRole, ...]
    seed_issue: dict[str, Any] | None
    high_risk_policies: dict[str, Any]


def load_template_spec(source: dict[str, Any] | str | Path) -> dict[str, Any]:
    """Load a template from a dict, JSON text/file, or package directory."""
    if isinstance(source, dict):
        return json.loads(json.dumps(source))

    if isinstance(source, Path):
        return _load_template_path(source)

    text = str(source)
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            loaded = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise TeamTemplateError(f"template JSON is invalid: {exc}") from exc
        if not isinstance(loaded, dict):
            raise TeamTemplateError("template JSON root must be an object")
        return loaded
    return _load_template_path(Path(text))


def _is_company_kind(raw: dict[str, Any]) -> bool:
    return raw.get("kind") == "company"


# Provenance claims that assert a template arrived through a VERIFIED remote channel
# (and therefore must verify, never be re-labeled into the unsigned-local lane). A
# genuine local/self template claims one of the local markers or makes no claim.
_REMOTE_PROVENANCE_CLAIMS: frozenset[str] = frozenset(
    {"developer", "official", "registry", "remote", "market", "marketplace", "cloud", "root"}
)
_LOCAL_PROVENANCE_CLAIMS: frozenset[str] = frozenset({"", "local", "self", "local_dev", "hand_authored", "import"})


def _claims_remote_provenance(manifest: dict[str, Any]) -> bool:
    """Whether a company manifest SELF-DECLARES a remote/higher-tier provenance.

    Inspects the self-declared ``source.type`` / ``source.channel`` and
    ``provenance.build_type``. Returns True if any claim names a verified remote
    channel (developer/official/registry/market/...). The local lane must refuse such
    a template unless it actually verified — otherwise a manifest could self-label a
    higher provenance and be smuggled in as ``local`` (owner trust-model RED LINE).
    Unknown/non-local claims are treated as remote (fail-closed)."""
    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    provenance = manifest.get("provenance") if isinstance(manifest.get("provenance"), dict) else {}
    claims = [
        str(source.get("type") or "").strip().lower(),
        str(source.get("channel") or "").strip().lower(),
        str(provenance.get("build_type") or "").strip().lower(),
    ]
    for claim in claims:
        if claim in _REMOTE_PROVENANCE_CLAIMS:
            return True
        if claim and claim not in _LOCAL_PROVENANCE_CLAIMS:
            # An unrecognized non-local claim is treated as remote (fail-closed).
            return True
    return False


def resolve_company_template_for_bootstrap(
    source: dict[str, Any] | str | Path,
    *,
    public_key: str | None = None,
    company_revocation_file: Path | None = None,
    allow_local_opt_in: bool = False,
    schema_path: Path | None = None,
) -> CompanyBootstrapVerification | None:
    """Verify-before-instantiate choke point for ``kind=company`` templates.

    The SINGLE place that decides whether a company template may be turned into a
    bootstrap proposal. Returns ``None`` for non-company (legacy agentcompanies/v1)
    templates, which pass through unchanged. For a company template it:

    1. rejects an inline ``dict`` (no file → no digest/signature → unverifiable),
    2. runs the raising :func:`verify_company_template` (load → contract → digest →
       signature trust → revocation) against the SAME ``company_revocation_file``
       the catalog/trust endpoints use (design G6),
    3. derives the authoritative :class:`TrustState` and asserts it is admitted —
       default ``{official}``; ``local`` only when ``allow_local_opt_in`` is set;
       ``developer`` / ``untrusted`` are never admitted (design §3.4/§3.6),
    4. asserts namespace hard-isolation — a non-root-signed reserved-namespace
       (``superclaw.*`` / ``first_party.*``) company is ALWAYS a hard conflict,
       even under ``--trust local`` (design §3.3 step 3).

    fail-closed: any failure raises :class:`CompanyTrustGateError`; nothing is
    instantiated. The returned verification is recorded into the proposal so the
    commit path can re-verify against the same source+digest (design §3.7).
    """
    if isinstance(source, dict):
        if _is_company_kind(source):
            raise CompanyTrustGateError(
                "inline company templates are not accepted; submit a signed .sccompany "
                "package or a path to a verifiable company directory"
            )
        return None

    # A JSON-string source (text starting with '{') is an inline dict in disguise:
    # it has no file on disk, so a company kind cannot be verified — reject it too.
    if isinstance(source, str) and source.strip().startswith("{"):
        try:
            inline = load_template_spec(source)
        except TeamTemplateError:
            return None
        if _is_company_kind(inline):
            raise CompanyTrustGateError(
                "inline company templates are not accepted; submit a signed .sccompany "
                "package or a path to a verifiable company directory"
            )
        return None

    template_path = Path(source).expanduser()
    # Peek at the manifest kind WITHOUT trusting it yet: a non-company path is a
    # legacy team template and must keep flowing through unchanged. A .sccompany
    # archive is always treated as a company candidate (it is the company package
    # format) so the verify gate runs on it.
    if template_path.is_file() and template_path.suffix == ".sccompany":
        is_company = True
    else:
        try:
            raw = _load_template_path(template_path)
        except TeamTemplateError:
            # Unreadable / missing path: let build_bootstrap_proposal raise the same
            # TeamTemplateError it always has (no behavior change for non-company).
            return None
        is_company = _is_company_kind(raw)
    if not is_company:
        return None

    revocation_file = company_revocation_file or default_company_revocation_file()
    template: CompanyTemplate | None = None
    try:
        template, trust_class = verify_company_template(
            template_path,
            public_key=public_key,
            revocation_file=revocation_file,
            schema_path=schema_path,
            allow_local_dev=allow_local_opt_in,
        )
    except CompanyTemplateError as exc:
        raise CompanyTrustGateError(f"company template failed verification: {exc}") from exc
    try:
        # SECURITY: `trust_class == "official"` from verify_company_template can mean a
        # CALLER-SUPPLIED public_key verified — NOT necessarily the configured root key.
        # Mapping that straight to signer_class="root" would let an arbitrary key
        # masquerade as official (and pass the reserved-namespace gate). So we RE-DERIVE
        # root identity with the NON-RAISING, ROOT-ONLY classifier (classify_signer only
        # returns "root" for the configured SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY, never a
        # caller key — mirrors the plugin discovery path). digest == package_digest here
        # because verify_company_template already asserted integrity.
        digest = template.package_digest
        root_classified = _COMPANY_VERIFIER.classify_signer(digest, template.signature)
        if trust_class == "official" and root_classified == "root":
            signer_class = "root"
        elif trust_class == "official":
            # Verified under a non-root (caller-supplied) key: NOT official. It only
            # admits through the local lane, and only if local trust is actually
            # available (opt-in) — otherwise fail closed. Never elevate to root.
            signer_class = "local_dev"
        else:
            signer_class = trust_class  # "local_dev"
        # Re-derive the authoritative TrustState so namespace hijack / revocation are
        # folded in identically to discovery (single derived authority, design §3.3).
        derivation = derive_trust_state(
            plugin_id=template.artifact_id,
            verdict=PackageTrustVerdict(signer_class=signer_class, integrity_ok=True),
            revoked=False,  # verify_company_template already raised on revocation.
            source_is_local=True,
            rollback_ok=True,
            freshness_ok=True,
            high_risk=False,
            developer_keyids=None,
        )
        # Namespace hard-isolation is unconditional — a reserved-namespace company
        # that is not root-signed is a hard conflict regardless of any local opt-in.
        if derivation.namespace_reserved and signer_class != "root":
            raise CompanyTrustGateError(
                f"company namespace is reserved and may only be root-signed: {template.artifact_id!r}"
            )
        # Provenance honesty (owner trust model RED LINE): the LOCAL lane is only for
        # genuinely local/self-authored templates. Anything that did NOT verify under the
        # configured ROOT key (signer_class != "root" — i.e. unsigned-local OR a
        # caller-supplied non-root key) but whose manifest CLAIMS a remote/higher-tier
        # provenance (developer / official / registry / market / remote) must NOT be
        # re-labeled into the local lane — it must verify under that claimed channel or be
        # rejected. Keyed on the RE-DERIVED root identity (not the raw trust_class, which
        # can read "official" for a caller-supplied key), so a non-root key cannot dodge
        # this guard. A genuine local template claims local/self/none.
        if signer_class != "root" and _claims_remote_provenance(template.manifest):
            raise CompanyTrustGateError(
                "company template claims remote/developer/official provenance but did not verify; "
                "it cannot be admitted through the local lane (sign it or import it as a local template "
                "without a remote source claim)"
            )
        allowed = set(_DEFAULT_COMPANY_ALLOW_TRUST)
        if allow_local_opt_in:
            allowed.add(TrustState.LOCAL)
        if derivation.state not in allowed:
            allowed_names = ", ".join(sorted(state.value for state in allowed))
            raise CompanyTrustGateError(
                f"company trust {derivation.state.value!r} is not admitted for instantiation "
                f"(allowed: {allowed_names}); reasons={list(derivation.reasons)}"
            )
        return CompanyBootstrapVerification(
            source_ref=str(template_path),
            artifact_id=template.artifact_id,
            version=template.version,
            digest=template.package_digest,
            # Record the RE-DERIVED signer class (root-only authority), not the raw
            # verify trust_class which can read "official" for a caller-supplied key.
            trust_class="official" if signer_class == "root" else signer_class,
            trust_state=derivation.state.value,
            allow_local_opt_in=allow_local_opt_in,
            company_revocation_file=str(revocation_file) if company_revocation_file is not None else None,
            # Bind the verified bytes: deep-copy the manifest the digest was
            # computed over, so build_bootstrap_proposal normalizes THIS, not a
            # fresh (swappable) re-read of the path.
            verified_manifest=json.loads(json.dumps(template.manifest)),
        )
    finally:
        template.cleanup()


def build_bootstrap_proposal(
    source: dict[str, Any] | str | Path,
    *,
    available_plugin_ids: list[str] | None = None,
    available_skill_ids: list[str] | None = None,
    gated_plugin_ids: list[str] | None = None,
    gated_skill_ids: list[str] | None = None,
    runtime_budget_seconds: int = 0,
    runtime_token_budget: int = 0,
    proposal_id: str = "bootstrap_template_proposal",
    public_key: str | None = None,
    company_revocation_file: Path | None = None,
    allow_local_opt_in: bool = False,
    company_schema_path: Path | None = None,
) -> BootstrapProposal:
    """Build a side-effect-free bootstrap proposal from a template source.

    Rejections are embedded in the proposal and set ``blocked=True`` so callers
    can show a reviewable fail-closed result without accidentally committing any
    live state.

    A ``kind=company`` source is routed through
    :func:`resolve_company_template_for_bootstrap` FIRST (verify-before-instantiate
    gate); an untrusted / unsigned / revoked / reserved-namespace / inline company
    raises :class:`CompanyTrustGateError` before any normalization. The captured
    verification is recorded on the proposal so commit can re-verify (TOCTOU).

    Override-drift closure (design §3.8): a request-supplied
    ``available_plugin_ids`` / ``available_skill_ids`` is at most an *intersection
    hint*, NEVER the authority. The authoritative universe is the GATED one
    (``gated_plugin_ids`` / ``gated_skill_ids`` — injected by tests, or derived
    here from the fail-closed kernel enumerators ``available_plugins`` /
    ``available_skill_ids`` when not injected). The resolver only ever sees
    ``hint ∩ gated`` (or the full gated set when no hint is given), so an
    ungated / unknown id handed in the request can never appear as ``granted``.
    """
    # Verify-before-instantiate gate FIRST (fail-closed before any work).
    company_verification = resolve_company_template_for_bootstrap(
        source,
        public_key=public_key,
        company_revocation_file=company_revocation_file,
        allow_local_opt_in=allow_local_opt_in,
        schema_path=company_schema_path,
    )
    if company_verification is not None:
        # Record the proposal-build inputs on the verification so the commit path can
        # deterministically REBUILD would_create from the re-verified manifest and
        # reject a payload whose records were tampered (valid verification block +
        # malicious would_create).
        company_verification = replace(
            company_verification,
            runtime_budget_seconds=runtime_budget_seconds,
            runtime_token_budget=runtime_token_budget,
            available_plugin_ids=tuple(available_plugin_ids) if available_plugin_ids is not None else None,
            available_skill_ids=tuple(available_skill_ids) if available_skill_ids is not None else None,
            proposal_id=proposal_id,
        )
    if company_verification is not None and company_verification.verified_manifest is not None:
        # Normalize the EXACT verified manifest (the bytes the digest covered), not
        # a fresh re-read of the path — otherwise a swap between the verify-read and
        # this read would put unverified content into the proposal (TOCTOU).
        raw = company_verification.verified_manifest
    else:
        raw = load_template_spec(source)
    # Fail-closed post-condition guard: if the bytes we are about to normalize are
    # company-kind but the verify gate did NOT produce a verification for them, a
    # source was swapped from non-company/unreadable to company BETWEEN the gate's
    # kind-peek and this read. Refuse — an unverified company must never become a
    # proposal (a proposal with company_verification=None would also skip the
    # commit-time re-verify). This binds the gate to the EXACT normalized bytes,
    # closing the non-company→company race.
    if _is_company_kind(raw) and company_verification is None:
        raise CompanyTrustGateError(
            "company template did not pass the verify-before-instantiate gate "
            "(source kind changed after verification or could not be verified); refusing to build proposal"
        )
    # The plugin universe a template role's plugin_allowlist resolves against NEVER
    # includes a skill — a skill is equipped via skill_allowlist (resolver_skill_ids
    # below). Exclude skill ids on the kernel single source, covering BOTH the kernel
    # derive (gated_plugin_ids is None) AND an explicit gated_plugin_ids override
    # (_intersect_hint_with_gated returns a caller-supplied gated set VERBATIM — the
    # override hole the derive lambda alone misses). Three complementary filters so no
    # skill variant survives an injected gated_plugin_ids:
    #   • _plugin_skill_origin_ids — skill-origin packages WITH tools (available_plugins).
    #   • _skill_universe — the FULL governed skill set (available_skill_ids does NOT
    #     drop no-tool packages, so it also catches a field-only skill_origin:true id
    #     with a non-"skill." id and zero tools, which available_plugins omits).
    #   • is_skill_origin_plugin(pid) — any reserved "skill." id, even one not installed.
    _kernel_plugins = _kernel_available_plugins()
    _plugin_skill_origin_ids = {p.plugin_id for p in _kernel_plugins if p.skill_origin}
    _skill_universe = set(_kernel_available_skill_ids())
    resolver_plugin_ids = [
        pid
        for pid in _intersect_hint_with_gated(
            hint=available_plugin_ids,
            gated=gated_plugin_ids,
            derive=lambda: [p.plugin_id for p in _kernel_plugins if not p.skill_origin],
        )
        if pid not in _plugin_skill_origin_ids
        and pid not in _skill_universe
        and not is_skill_origin_plugin(pid)
    ]
    resolver_skill_ids = _intersect_hint_with_gated(
        hint=available_skill_ids,
        gated=gated_skill_ids,
        derive=_kernel_available_skill_ids,
    )
    normalized = _normalize_template(raw)
    rejections = _validate_normalized_template(normalized)
    role_ids = {role.role_id for role in normalized.roles}
    role_to_profile_id = {role_id: _pending_profile_id(role_id) for role_id in role_ids}

    company_limit_seconds = _int_value(normalized.company.get("default_budget_seconds"))
    company_limit_tokens = _int_value(normalized.company.get("default_token_budget"))

    role_proposals: list[RoleTemplateProposal] = []
    equipment_resolution: list[EquipmentResolutionSummary] = []
    agent_profiles: list[dict[str, Any]] = []

    for role in normalized.roles:
        profile_id = role_to_profile_id[role.role_id]
        reports_to_profile = role_to_profile_id.get(role.reports_to or "")
        budget_clamp = {
            "budget_seconds": _clamp_budget(
                role.budget_seconds or company_limit_seconds,
                company_limit_seconds,
                runtime_budget_seconds,
            ),
            "token_budget": _clamp_budget(
                role.token_budget or company_limit_tokens,
                company_limit_tokens,
                runtime_token_budget,
            ),
        }
        profile = AgentProfile(
            profile_id=profile_id,
            name=role.name,
            role=role.role,
            title=role.title,
            workspace_id=role.workspace_id,
            company_profile_id=role.company_profile_id,
            backend_policy=role.backend_policy,
            model=role.model,
            effort=role.effort,
            plugin_allowlist=list(dict.fromkeys(role.plugin_allowlist + role.required_plugins)),
            skill_allowlist=list(dict.fromkeys(role.skill_allowlist + role.required_skills)),
            # Max-permission doctrine: a company role with no explicit policy defaults to
            # bypassPermissions so a bootstrapped CEO/agent can act, not sit on the
            # read-only ``plan`` floor. An explicit role policy still wins. The company
            # membership here is a confirmed structural fact (a template builds exactly
            # one company; a non-"local" company_profile_id is that company), so no store
            # lookup is needed. Non-company (local) roles keep the fail-closed floor.
            permission_policy=(
                dict(role.permission_policy)
                if role.permission_policy
                else (
                    default_company_runtime_policy()
                    if role.company_profile_id and role.company_profile_id != "local"
                    else {}
                )
            ),
            budget_seconds=budget_clamp["budget_seconds"].effective,
            token_budget=budget_clamp["token_budget"].effective,
            run_count_budget=role.run_count_budget,
            external_tool_budget=role.external_tool_budget,
            reports_to=reports_to_profile,
            runtime_config=dict(role.runtime_config),
            persona=role.persona,
            charter=role.charter,
            default_instructions=role.default_instructions,
            charter_source="template",
            metadata={
                "template_source": normalized.metadata.source,
                "template_revision": normalized.metadata.revision,
                "template_digest": normalized.metadata.digest,
                "template_role_id": role.role_id,
            },
        )
        resolution = resolve_equipment(
            profile,
            available_ids=resolver_plugin_ids,
            available_skill_ids_override=resolver_skill_ids,
        )
        pending = [{"id": capability, "reason": "capability_resolution_not_available"} for capability in role.required_capabilities]
        dropped_plugins = [{"id": plugin_id, "reason": "not_available_or_not_governed"} for plugin_id in resolution.dropped]
        dropped_skills = [{"id": skill_id, "reason": "not_available_or_not_governed"} for skill_id in resolution.skills_dropped]
        missing_required_plugins = set(role.required_plugins).intersection(resolution.dropped)
        missing_required_skills = set(role.required_skills).intersection(resolution.skills_dropped)
        for plugin_id in sorted(missing_required_plugins):
            rejections.append(_rejection("missing_required_plugin", role.role_id, plugin_id))
        for skill_id in sorted(missing_required_skills):
            rejections.append(_rejection("missing_required_skill", role.role_id, skill_id))
        for capability in role.required_capabilities:
            rejections.append(_rejection("missing_required_capability", role.role_id, capability))

        summary = EquipmentResolutionSummary(
            profile_id=profile_id,
            role_id=role.role_id,
            requested={
                "plugins": list(profile.plugin_allowlist),
                "skills": list(profile.skill_allowlist),
            },
            granted={
                "plugins": list(resolution.granted),
                "skills": list(resolution.skills_granted),
            },
            dropped={
                "plugins": dropped_plugins,
                "skills": dropped_skills,
            },
            pending=pending,
        )
        equipment_resolution.append(summary)

        profile_dict = profile.to_dict()
        agent_profiles.append(profile_dict)
        role_proposals.append(
            RoleTemplateProposal(
                role_id=role.role_id,
                profile_id=profile_id,
                name=role.name,
                role=role.role,
                reports_to_role_id=role.reports_to,
                agent_profile=profile_dict,
                budget_clamp=budget_clamp,
                charter_policy_findings=tuple(_lint_charter(role.charter)),
            )
        )

    approval_items = _approval_diff(normalized.high_risk_policies, proposal_id)
    if normalized.workspace.get("network_policy") == "open":
        approval_items.append(
            {
                "type": "permission_grant",
                "reason": "high_risk_policy:workspace_network_open",
                "requested_permission": {"policy": "workspace_network_policy", "value": "open"},
                "affects": {"proposal_id": proposal_id},
                "resume_action": {"kernel": "team.bootstrap.commit", "proposal_id": proposal_id},
            }
        )
    approvals_required = tuple(approval_items)
    company_profile_payload = _company_profile_payload(normalized.company, normalized.metadata)
    if company_verification is not None:
        # Stamp the source-kind marker INTO the persisted company record (not only
        # the top-level proposal field), so a proposal whose records describe a
        # signed-company instantiation carries that claim with the records. The
        # write boundary refuses such a record without a matching verification —
        # a caller cannot keep company-template semantics while dropping the gate.
        company_profile_payload["metadata"]["template_source_kind"] = "company"
    would_create = {
        "company_profile": company_profile_payload,
        "workspace_profile": _workspace_profile_payload(normalized.workspace, normalized.company, normalized.metadata),
        "agent_profiles": agent_profiles,
        "issues": [
            _seed_issue_payload(
                normalized.seed_issue,
                normalized.company,
                normalized.workspace,
                normalized.metadata,
                assignee_profile_id=_resolve_seed_assignee(
                    normalized.seed_issue, role_to_profile_id, rejections
                ),
                rejections=rejections,
            )
        ]
        if normalized.seed_issue
        else [],
    }
    return BootstrapProposal(
        proposal_id=proposal_id,
        template=normalized.metadata,
        blocked=bool(rejections),
        rejections=tuple(rejections),
        would_create=would_create,
        role_proposals=tuple(role_proposals),
        equipment_resolution=tuple(equipment_resolution),
        approvals_required=approvals_required,
        company_verification=company_verification,
        source_kind="company" if company_verification is not None else "team_template",
    )


def _load_template_path(path: Path) -> dict[str, Any]:
    source = path.expanduser().resolve()
    if source.is_dir():
        for name in AGENTCOMPANY_FILENAMES:
            candidate = source / name
            if candidate.exists():
                return _read_json(candidate)
        raise TeamTemplateError(
            f"template package {source} is missing one of {', '.join(AGENTCOMPANY_FILENAMES)}"
        )
    if source.is_file() and source.suffix == ".sccompany":
        # A signed company archive: extract the manifest through the company loader
        # (zip-slip / symlink defended). The verify gate has already trust-checked
        # it before normalization; this only reads its shape.
        template = load_company_template(source)
        try:
            return dict(template.manifest)
        finally:
            template.cleanup()
    if source.is_file():
        return _read_json(source)
    raise TeamTemplateError(f"template source does not exist: {source}")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TeamTemplateError(f"template file {path} is invalid: {exc}") from exc
    if not isinstance(loaded, dict):
        raise TeamTemplateError(f"template file {path} root must be an object")
    return loaded


def _normalize_template(raw: dict[str, Any]) -> _NormalizedTemplate:
    if raw.get("kind") == "company" and "roles" in raw:
        return _normalize_superclaw_company(raw)
    return _normalize_agentcompanies(raw)


def _normalize_superclaw_company(raw: dict[str, Any]) -> _NormalizedTemplate:
    provenance = _dict_value(raw.get("provenance"))
    source = _dict_value(raw.get("source"))
    metadata = TemplateMetadata(
        source=_source_string(source),
        revision=str(raw.get("version") or ""),
        digest=str(provenance.get("package_digest") or provenance.get("source_digest") or ""),
    )
    company_id = str(raw.get("company_profile_id") or raw.get("id") or "pending_company")
    workspace = {
        "workspace_id": str(raw.get("workspace_id") or "local"),
        "name": str(raw.get("name") or company_id),
        "repo_path": ".",
        "writable_paths": ["."],
        "network_policy": "restricted",
    }
    company = {
        "company_profile_id": company_id,
        "name": str(raw.get("name") or company_id),
        "goal": str(raw.get("summary") or ""),
        "default_budget_seconds": _int_value(_dict_value(raw.get("budgets")).get("default_budget_seconds")),
        "default_token_budget": _int_value(_dict_value(raw.get("budgets")).get("default_token_budget")),
        "allowed_plugins": [],
    }
    equipment = _dict_value(raw.get("equipment_requirements"))
    roles = tuple(
        _normalize_role(
            role,
            company_id=company["company_profile_id"],
            workspace_id=workspace["workspace_id"],
            equipment=_dict_value(equipment.get(str(role.get("name") or ""))),
        )
        for role in _list_of_dicts(raw.get("roles"))
    )
    return _NormalizedTemplate(
        metadata=metadata,
        company=company,
        workspace=workspace,
        roles=roles,
        seed_issue=None,
        high_risk_policies=_dict_value(_dict_value(raw.get("policies")).get("high_risk_policies")),
    )


def _normalize_agentcompanies(raw: dict[str, Any]) -> _NormalizedTemplate:
    metadata_raw = _dict_value(raw.get("metadata") or raw.get("template") or {})
    source_raw = raw.get("source")
    metadata = TemplateMetadata(
        source=str(metadata_raw.get("source") or _source_string(_dict_value(source_raw)) or ""),
        revision=str(metadata_raw.get("revision") or raw.get("revision") or raw.get("version") or ""),
        digest=str(metadata_raw.get("digest") or metadata_raw.get("package_digest") or raw.get("digest") or ""),
    )
    company_raw = _dict_value(raw.get("company"))
    workspace_raw = _dict_value(raw.get("workspace"))
    company_id = str(company_raw.get("company_profile_id") or company_raw.get("id") or "pending_company")
    workspace_id = str(workspace_raw.get("workspace_id") or workspace_raw.get("id") or "local")
    company = {
        "company_profile_id": company_id,
        "name": str(company_raw.get("name") or company_id),
        "goal": str(company_raw.get("goal") or ""),
        "default_budget_seconds": _int_value(company_raw.get("default_budget_seconds")),
        "default_token_budget": _int_value(company_raw.get("default_token_budget")),
        "allowed_plugins": _string_list(company_raw.get("allowed_plugins")),
    }
    workspace = {
        "workspace_id": workspace_id,
        "name": str(workspace_raw.get("name") or workspace_id),
        "repo_path": str(workspace_raw.get("repo_path") or "."),
        "writable_paths": _string_list(workspace_raw.get("writable_paths")) or ["."],
        "network_policy": str(workspace_raw.get("network_policy") or "restricted"),
    }
    roles = tuple(
        _normalize_role(role, company_id=company_id, workspace_id=workspace_id, equipment={})
        for role in _list_of_dicts(raw.get("roles") or raw.get("agents"))
    )
    return _NormalizedTemplate(
        metadata=metadata,
        company=company,
        workspace=workspace,
        roles=roles,
        seed_issue=_dict_value(raw.get("seed_issue") or raw.get("task")) or None,
        high_risk_policies=_dict_value(raw.get("high_risk_policies")),
    )


def _normalize_role(
    role: dict[str, Any],
    *,
    company_id: str,
    workspace_id: str,
    equipment: dict[str, Any],
) -> _NormalizedRole:
    role_id = str(role.get("id") or role.get("role_id") or role.get("name") or "").strip()
    budgets = _dict_value(role.get("budgets"))
    equipment = {**equipment, **_dict_value(role.get("equipment"))}
    return _NormalizedRole(
        role_id=role_id,
        name=str(role.get("name") or role_id),
        role=str(role.get("role") or role_id),
        title=str(role["title"]) if role.get("title") is not None else None,
        charter=str(role.get("charter") or ""),
        persona=str(role.get("persona") or ""),
        default_instructions=str(role.get("default_instructions") or role.get("instructions") or ""),
        reports_to=str(role["reports_to"]) if role.get("reports_to") is not None else None,
        backend_policy=str(role.get("backend_policy") or "claude"),
        model=str(role.get("model") or ""),
        effort=str(role.get("effort") or ""),
        company_profile_id=str(role.get("company_profile_id") or company_id),
        workspace_id=str(role.get("workspace_id") or workspace_id),
        plugin_allowlist=_string_list(role.get("plugin_allowlist"))
        + _string_list(role.get("plugins"))
        + _string_list(equipment.get("plugins")),
        skill_allowlist=_string_list(role.get("skill_allowlist"))
        + _string_list(role.get("skills"))
        + _string_list(equipment.get("skills")),
        required_capabilities=_string_list(role.get("required_capabilities")) + _string_list(equipment.get("capabilities")),
        required_plugins=_string_list(role.get("required_plugins")) + _string_list(equipment.get("required_plugins")),
        required_skills=_string_list(role.get("required_skills")) + _string_list(equipment.get("required_skills")),
        budget_seconds=_int_value(role.get("budget_seconds") or budgets.get("budget_seconds")),
        token_budget=_int_value(role.get("token_budget") or budgets.get("token_budget")),
        run_count_budget=_int_value(role.get("run_count_budget") or budgets.get("run_count_budget")),
        external_tool_budget=_int_value(role.get("external_tool_budget") or budgets.get("external_tool_budget")),
        permission_policy=_dict_value(role.get("permission_policy")),
        runtime_config=_dict_value(role.get("runtime_config")),
    )


def _validate_normalized_template(template: _NormalizedTemplate) -> list[dict[str, str]]:
    rejections: list[dict[str, str]] = []
    if not template.metadata.source:
        rejections.append(_rejection("missing_template_source", "template", "source is required"))
    if not template.metadata.revision:
        rejections.append(_rejection("missing_template_revision", "template", "revision is required"))
    if not template.metadata.digest:
        rejections.append(_rejection("missing_template_digest", "template", "digest is required"))
    if not template.roles:
        rejections.append(_rejection("missing_roles", "template", "at least one role is required"))
    workspace_policy = str(template.workspace.get("network_policy") or "")
    if workspace_policy not in {"restricted", "none", "open"}:
        rejections.append(_rejection("unsafe_workspace_policy", "workspace.network_policy", workspace_policy))
    writable_paths = template.workspace.get("writable_paths") or []
    if not writable_paths:
        rejections.append(_rejection("unsafe_workspace_policy", "workspace.writable_paths", "at least one path is required"))
    for writable_path in writable_paths:
        path_text = str(writable_path)
        if "\x00" in path_text or path_text.startswith("/") or ".." in Path(path_text).parts:
            rejections.append(_rejection("unsafe_workspace_policy", "workspace.writable_paths", path_text))

    role_ids: list[str] = []
    for role in template.roles:
        if not role.role_id:
            rejections.append(_rejection("missing_role_id", role.name or "role", "role id is required"))
        role_ids.append(role.role_id)
        if role.company_profile_id != template.company["company_profile_id"]:
            rejections.append(_rejection("company_reference_mismatch", role.role_id, role.company_profile_id))
        if role.workspace_id != template.workspace["workspace_id"]:
            rejections.append(_rejection("workspace_reference_mismatch", role.role_id, role.workspace_id))
        for finding in _lint_charter(role.charter):
            rejections.append(_rejection("unsafe_charter_policy", role.role_id, finding))

    duplicates = sorted({role_id for role_id in role_ids if role_ids.count(role_id) > 1})
    for role_id in duplicates:
        rejections.append(_rejection("duplicate_role_id", role_id, "role ids must be unique"))

    role_set = set(role_ids)
    reports_to: dict[str, str] = {}
    for role in template.roles:
        if not role.reports_to:
            continue
        if role.reports_to not in role_set:
            rejections.append(_rejection("missing_manager", role.role_id, role.reports_to))
            continue
        reports_to[role.role_id] = role.reports_to

    for role_id in reports_to:
        cycle = _reports_to_cycle(role_id, reports_to)
        if cycle:
            rejections.append(_rejection("reports_to_cycle", role_id, " -> ".join(cycle)))
    return rejections


def _reports_to_cycle(start: str, reports_to: dict[str, str]) -> list[str]:
    seen: list[str] = []
    cursor: str | None = start
    while cursor is not None:
        if cursor in seen:
            return seen[seen.index(cursor):] + [cursor]
        seen.append(cursor)
        cursor = reports_to.get(cursor)
    return []


_UNSAFE_CHARTER_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bbypass\b.{0,40}\bapproval", re.I), "charter may not bypass approval"),
    (re.compile(r"\b(skip|ignore)\b.{0,40}\bapproval", re.I), "charter may not skip approval"),
    (re.compile(r"\bauto(?:matically)?[- ]?approve\b", re.I), "charter may not auto-approve work"),
    (re.compile(r"\bself[- ]?approve\b", re.I), "charter may not self-approve work"),
    (re.compile(r"\bbypass\b.{0,40}\bpermission", re.I), "charter may not bypass permissions"),
    (re.compile(r"\bgrant\b.{0,40}\b(self|yourself)\b", re.I), "charter may not self-grant tools"),
    (re.compile(r"\b(auto(?:matically)?[- ]?pay|payment without approval)\b", re.I), "charter may not auto-pay"),
)


def _lint_charter(charter: str) -> list[str]:
    return [message for pattern, message in _UNSAFE_CHARTER_PATTERNS if pattern.search(charter or "")]


def _clamp_budget(requested: int, company_limit: int, runtime_limit: int) -> BudgetClamp:
    requested = max(0, int(requested or 0))
    company_limit = max(0, int(company_limit or 0))
    runtime_limit = max(0, int(runtime_limit or 0))
    limits = [value for value in (requested, company_limit, runtime_limit) if value > 0]
    effective = min(limits) if limits else 0
    return BudgetClamp(
        requested=requested,
        effective=effective,
        company_limit=company_limit,
        runtime_limit=runtime_limit,
        clamped=bool(requested and effective != requested),
    )


def _company_profile_payload(company: dict[str, Any], metadata: TemplateMetadata) -> dict[str, Any]:
    return {
        "company_profile_id": company["company_profile_id"],
        "name": company["name"],
        "goal": company["goal"],
        "default_budget_seconds": company["default_budget_seconds"],
        "default_token_budget": company["default_token_budget"],
        "allowed_plugins": list(company.get("allowed_plugins") or []),
        "metadata": {
            "template_source": metadata.source,
            "template_revision": metadata.revision,
            "template_digest": metadata.digest,
        },
    }


def _workspace_profile_payload(
    workspace: dict[str, Any],
    company: dict[str, Any],
    metadata: TemplateMetadata,
) -> dict[str, Any]:
    return {
        "workspace_id": workspace["workspace_id"],
        "company_profile_id": company["company_profile_id"],
        "name": workspace["name"],
        "repo_path": workspace["repo_path"],
        "writable_paths": list(workspace["writable_paths"]),
        "network_policy": workspace["network_policy"],
        "metadata": {
            "template_company_profile_id": company["company_profile_id"],
            "template_source": metadata.source,
            "template_revision": metadata.revision,
            "template_digest": metadata.digest,
        },
    }


def _seed_assignee_role(seed_issue: dict[str, Any] | None) -> str | None:
    """The role id a seed issue declares it should be assigned to, if any."""
    seed_issue = seed_issue or {}
    raw = seed_issue.get("assignee") or seed_issue.get("assignee_role_id")
    role = str(raw).strip() if raw else ""
    return role or None


def _resolve_seed_assignee(
    seed_issue: dict[str, Any] | None,
    role_to_profile_id: dict[str, str],
    rejections: list[dict[str, str]],
) -> str | None:
    """Resolve a seed issue's declared ``assignee`` ROLE id to a created PROFILE id.

    Fail-closed (柱子 3 + advisor review): an ``assignee`` that names a role NOT in
    this template is a configuration error that would silently strand a company
    (an issue assigned to a profile that was never created, waking nobody). It is
    therefore recorded as a BLOCKING rejection — the proposal is blocked, never
    quietly turned into an unassigned issue. Resolution is through the SAME
    role→profile map the agent profiles use, so a seed assignee can only ever be
    one of this company's OWN seeded roles (no arbitrary / cross-company id).
    """
    role = _seed_assignee_role(seed_issue)
    if role is None:
        return None
    resolved = role_to_profile_id.get(role)
    if resolved is None:
        rejections.append(
            _rejection(
                "unknown_seed_assignee_role",
                "seed_issue.assignee",
                f"seed issue assignee role {role!r} is not a role in this template",
            )
        )
        return None
    return resolved


# An ASSIGNED seed issue may only start in an actionable state — the whole point
# of assigning it is to enqueue an assignment wakeup the daemon can turn into a
# run. ``backlog`` (promoted to ``todo``) and ``todo`` are the only coherent
# starts; seeding an assigned issue as e.g. ``done`` / ``in_review`` would enqueue
# a wakeup that finds no claimable work (a stranded no-op startup). An UNassigned
# seed issue is unconstrained (it wakes nobody), so this does not limit template
# expressiveness for non-actionable seed states.
_ACTIONABLE_SEED_STATUSES = frozenset({IssueStatus.BACKLOG.value, IssueStatus.TODO.value})


def _seed_issue_payload(
    seed_issue: dict[str, Any] | None,
    company: dict[str, Any],
    workspace: dict[str, Any],
    metadata: TemplateMetadata,
    *,
    assignee_profile_id: str | None = None,
    rejections: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    seed_issue = seed_issue or {}
    payload: dict[str, Any] = {
        "issue_id": str(seed_issue.get("issue_id") or f"bootstrap_issue_{_safe_id(company['company_profile_id'])}"),
        "title": str(seed_issue.get("title") or "Bootstrap company"),
        "description": str(seed_issue.get("description") or ""),
        "company_profile_id": company["company_profile_id"],
        "workspace_id": workspace["workspace_id"],
        "metadata": {
            "template_seed_issue": True,
            "template_company_profile_id": company["company_profile_id"],
            "template_source": metadata.source,
            "template_revision": metadata.revision,
            "template_digest": metadata.digest,
        },
    }
    # 柱子 3 (PR-5): an assigned seed issue hands the seed work to a role (the
    # CEO/lead) so the bootstrap commit can fire its assignment wakeup and the
    # daemon drives that agent's first run. The profile id is already resolved +
    # validated (see ``_resolve_seed_assignee``).
    if assignee_profile_id:
        payload["assignee_agent_profile_id"] = assignee_profile_id
        declared = str(seed_issue.get("status") or IssueStatus.BACKLOG.value)
        if declared not in _ACTIONABLE_SEED_STATUSES:
            # Fail-closed: an assigned seed in a non-actionable state would wake an
            # agent for work it can never claim. Block the proposal instead.
            if rejections is not None:
                rejections.append(
                    _rejection(
                        "non_actionable_assigned_seed",
                        "seed_issue.status",
                        f"an assigned seed issue may only start backlog/todo, not {declared!r}",
                    )
                )
        # Mirror ``team_kernel.assign_issue``: promote backlog -> todo (ready to be
        # claimed); an explicit ``todo`` is kept. The daemon's work picker considers
        # only todo/in_progress, so an assigned seed left in the default ``backlog``
        # would make the wakeup a no-op.
        payload["status"] = IssueStatus.TODO.value
    return payload


def _approval_diff(high_risk_policies: dict[str, Any], proposal_id: str) -> list[dict[str, Any]]:
    approvals: list[dict[str, Any]] = []
    for key, value in sorted(high_risk_policies.items()):
        if value:
            approvals.append(
                {
                    "type": "permission_grant",
                    "reason": f"high_risk_policy:{key}",
                    "requested_permission": {"policy": key, "value": value},
                    "affects": {"proposal_id": proposal_id},
                    "resume_action": {"kernel": "team.bootstrap.commit", "proposal_id": proposal_id},
                }
            )
    return approvals


def _pending_profile_id(role_id: str) -> str:
    safe = _safe_id(role_id) or "role"
    return f"pending_agent_{safe}"


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_")


def _rejection(code: str, path: str, message: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def _dict_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list_of_dicts(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item]


def _int_value(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _source_string(source: dict[str, Any]) -> str:
    if not source:
        return ""
    if source.get("uri"):
        return str(source["uri"])
    source_type = str(source.get("type") or "").strip()
    developer = str(source.get("developer_id") or "").strip()
    if source_type and developer:
        return f"{source_type}:{developer}"
    return source_type or developer
