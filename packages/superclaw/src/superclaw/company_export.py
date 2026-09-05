"""Company-as-code export (Capability Workshop · portability).

Serialize a governed company — its :class:`CompanyProfile`, the
:class:`AgentProfile` roster, and the anchoring :class:`WorkspaceProfile`
(optionally the issue ledger) — into a portable, markdown-first bundle that
**round-trips** with the bootstrap importer
(:func:`superclaw.team_templates.build_bootstrap_proposal`).

The kernel surface here is intentionally pure: :func:`build_company_export`
reads the :class:`~superclaw.state.StateStore` and returns an in-memory
:class:`CompanyExportBundle` (a ``path -> text`` file map plus the manifest).
The CLI / API / Web surfaces own the actual disk/zip writing and the HTTP/JSON
projection — no business logic leaks into a surface, mirroring how the bootstrap
*import* contract keeps its proposal/commit split.

Round-trip contract (stated honestly — no overclaim)
----------------------------------------------------
``manifest.json`` is emitted in the ``agentcompanies`` shape that
:func:`superclaw.team_templates._normalize_agentcompanies` consumes, so::

    bundle = build_company_export(store, company_id)
    proposal = build_bootstrap_proposal(bundle.manifest)

recreates each role's name / role / title / charter / persona /
default_instructions / equipment allowlists / permission_policy /
runtime_config, with ``reports_to`` re-expressed as the manager's *role slug*
(never a live ``profile_id``, which the importer regenerates).

The promise stops exactly where the importer's behaviour stops — we record every
divergence as an export ``warning`` rather than pretend otherwise:

* **Budgets are governance-managed, not copied.** The importer clamps a role's
  budget to the company ceiling AND substitutes the company default for a ``0``
  (unbounded/inherit) budget. Export records the role's *actual* budget and WARNS
  in both cases — over-ceiling (will clamp down) and ``0`` (will inherit the
  default) — so a re-import's budget is never a silent surprise.
* **Fields the importer does not consume ride the sidecar.** ``context_mode`` and
  ``charter_source`` are carried in ``.superclaw.yaml`` for a future richer
  importer; the bootstrap importer ignores them today.
* **Multi-workspace companies collapse to the primary.** The bootstrap importer
  creates a single workspace, so a company whose roster spans several workspaces
  is exported against the primary one with a warning naming the dropped boundary.
* **Issues, comments, work products are documentation-only.** They render as
  markdown context and ride a ``manifest["issues"]`` key the importer ignores by
  construction (it reads ``seed_issue``/``task``) — fail-safe, never a silent
  re-import of the ledger.

Security boundary (precise — no overclaim)
------------------------------------------
The export strips the **machine-DERIVED, system-populated** fields that a user
never authored and that a shared package must not carry: ``repo_path`` and
``repo_identity`` (absolute checkout paths, remote URLs that may embed tokens)
are normalized away by construction (``repo_path`` → ``"."``, ``repo_identity``
never serialized); raw company/agent ``metadata`` (an open dict the harness may
stuff with machine-specific data) is dropped WITH a warning so its omission is
visible. The one deliberate exception is a single optional *scalar*
``metadata["version"]`` (non-scalars are ignored), surfaced as the package
revision.

It does **NOT** scrub **user/operator-authored governance payload** — ``name``,
``goal``, ``charter``, ``persona``, ``default_instructions``,
``permission_policy``, ``runtime_config`` are the portable *payload* (the whole
point of company-as-code is to share the charter and its governance), so they
are exported verbatim. Free-text secret scanning is explicitly out of scope and
unreliable; an operator must not embed credentials in a charter or a policy,
exactly as they must not commit one to a README.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from time import time
from typing import Any

import yaml

from .models import AgentProfile, CompanyProfile, Issue, WorkProduct, WorkspaceProfile
from .state import StateStore

__all__ = [
    "CompanyExportBundle",
    "CompanyExportError",
    "CompanyExportTooLarge",
    "DEFAULT_MAX_EXPORT_BYTES",
    "build_company_export",
    "manifest_self_digest",
    "is_safe_bundle_path",
]

# The portable spec version this exporter emits. Mirrors the agentcompanies/v1
# family the bootstrap importer normalizes; bumped only on a breaking change to
# the manifest shape.
EXPORT_SCHEMA = "agentcompanies/v1"

# Network policies the bootstrap importer accepts (anything else is rejected at
# import). We clamp to a safe default on export rather than emitting a manifest
# that would fail its own re-import.
_SAFE_NETWORK_POLICIES = frozenset({"restricted", "none", "open"})


class CompanyExportError(ValueError):
    """Raised when a company cannot be exported (e.g. unknown company id)."""


class CompanyExportTooLarge(CompanyExportError):
    """Raised when an export would exceed its byte budget. A subclass so a surface
    can map it to a distinct status (the API → 413) while a bare CompanyExportError
    still means "not found" (404)."""


# A generous default ceiling on the total exported FILE-BODY bytes. Enforced as
# the file bodies (charters, issue/sidecar docs — the dominant payload) are
# accumulated, so an over-budget export never fully materializes its file map and
# never hands a surface an unbounded archive. The lighter roster/manifest metadata
# is built first (its size is O(roster + issues)); truly bounding that too would
# require a streaming kernel and is out of scope for this single-tenant,
# control-token-gated export. Surfaces map the overflow to 413.
DEFAULT_MAX_EXPORT_BYTES = 200 * 1024 * 1024


def is_safe_bundle_path(rel: str) -> bool:
    """True only for a clean POSIX-relative bundle path (``agents/ceo/AGENTS.md``).

    The exporter only ever produces such paths (slug segments are ``[a-z0-9-]``),
    but every surface that WRITES a bundle — the CLI to disk, the API into a zip —
    re-validates with this single predicate as an explicit second line of defense
    before a path reaches a filesystem or an archive extractor. Rejects empty /
    absolute / drive-letter / backslash / NUL / ``.`` / ``..`` / empty segments."""
    if not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
        return False
    if re.match(r"^[A-Za-z]:", rel):  # windows drive
        return False
    return all(seg not in ("", ".", "..") for seg in rel.split("/"))


@dataclass(frozen=True)
class CompanyExportBundle:
    """The in-memory result of exporting a company.

    ``files`` maps POSIX-relative paths to UTF-8 text; a surface writes them to a
    directory or zips them. ``manifest`` is the round-trippable dict (also present
    in ``files["manifest.json"]``). ``warnings`` records every lossy normalization
    (e.g. a dropped absolute path, a dangling ``reports_to``) so the export never
    silently discards fidelity.
    """

    company_profile_id: str
    company_name: str
    manifest: dict[str, Any]
    files: dict[str, str]
    includes: dict[str, bool]
    warnings: tuple[str, ...] = ()
    # Stable counts for surface summaries without re-parsing the manifest.
    agent_count: int = 0
    issue_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "company_profile_id": self.company_profile_id,
            "company_name": self.company_name,
            "schema": EXPORT_SCHEMA,
            "includes": dict(self.includes),
            "warnings": list(self.warnings),
            "agent_count": self.agent_count,
            "issue_count": self.issue_count,
            "manifest": self.manifest,
            "files": dict(self.files),
        }

    def file_tree(self) -> list[dict[str, Any]]:
        """A lightweight ``[{path, bytes}]`` listing for a preview surface."""
        return [
            {"path": path, "bytes": len(content.encode("utf-8"))}
            for path, content in sorted(self.files.items())
        ]

    def surface_payload(self, *, include_files: bool = True) -> dict[str, Any]:
        """The ONE projection every surface (CLI / API / Web) emits, so the export
        JSON shape never forks between surfaces.

        Always carries the ``file_tree`` (path + byte size). ``include_files=True``
        adds the full file bodies (for a download/zip surface); ``False`` is the
        preview shape (a CLI that already wrote to disk, or an API preview).
        """
        payload = self.to_dict()
        payload["file_tree"] = self.file_tree()
        if not include_files:
            payload.pop("files", None)
        return payload


def build_company_export(
    store: StateStore,
    company_profile_id: str,
    *,
    include_issues: bool = False,
    include_work_products: bool = False,
    revision: str | None = None,
    generated_at: float | None = None,
    max_bytes: int | None = DEFAULT_MAX_EXPORT_BYTES,
) -> CompanyExportBundle:
    """Build a portable export bundle for ``company_profile_id``.

    ``include_issues`` adds documentation-only issue pages (and an importer-ignored
    ``issues`` manifest key). ``include_work_products`` nests delivery facts inside
    those issue pages; it only takes effect when ``include_issues`` is also set
    (work products are attached to issues), and a warning is recorded otherwise.

    ``revision``/``generated_at`` are injectable for deterministic output (tests
    pin them); in production they default to the company's recorded version and
    wall-clock time.
    """
    try:
        company = store.get_company_profile(company_profile_id)
    except Exception as exc:  # narrow: StateStore raises ValueError/KeyError-likes
        raise CompanyExportError(f"unknown company '{company_profile_id}': {exc}") from exc

    warnings: list[str] = []

    if include_work_products and not include_issues:
        include_work_products = False
        warnings.append(
            "work products are attached to issues; --include work-products was "
            "ignored without --include issues"
        )

    stamp = time() if generated_at is None else float(generated_at)
    resolved_revision = _resolve_revision(company, revision)

    agents = _ordered_agents(store, company_profile_id)
    slug_map = _assign_slugs(agents)
    workspace = _primary_workspace(store, company, agents)
    _warn_collapsed_workspaces(store, company, agents, workspace, warnings)
    _warn_dropped_metadata(company, agents, warnings)

    issues: list[Issue] = []
    work_products_by_issue: dict[str, list[WorkProduct]] = {}
    if include_issues:
        issues = sorted(
            store.list_issues(company_profile_id=company_profile_id),
            key=lambda issue: (issue.created_at, issue.issue_id),
        )
        if include_work_products:
            for issue in issues:
                wps = store.list_work_products(issue_id=issue.issue_id)
                if wps:
                    work_products_by_issue[issue.issue_id] = wps

    role_entries = [
        _role_entry(
            agent,
            slug_map,
            warnings,
            company_default_seconds=company.default_budget_seconds,
            company_default_tokens=company.default_token_budget,
        )
        for agent in agents
    ]
    issue_slug_map = _assign_issue_slugs(issues)

    manifest = _build_manifest(
        company=company,
        workspace=workspace,
        role_entries=role_entries,
        issues=issues,
        issue_slug_map=issue_slug_map,
        slug_map=slug_map,
        revision=resolved_revision,
        warnings=warnings,
    )

    includes = {
        "company": True,
        "agents": True,
        "workspace": True,
        "issues": include_issues,
        "work_products": include_work_products,
    }

    files: dict[str, str] = {}
    running_bytes = 0

    def _add(path: str, content: str) -> None:
        # Budget the file-body map: abort AS SOON AS the accumulated file bytes
        # exceed the budget, so the dominant payload (charters, per-issue/sidecar
        # docs — the unbounded O(N) growth) is never fully materialized on an
        # over-budget export. The roster/manifest metadata built above is lighter
        # (O(roster + issues)); bounding that too would need a streaming kernel.
        nonlocal running_bytes
        running_bytes += len(content.encode("utf-8"))
        if max_bytes is not None and running_bytes > max_bytes:
            raise CompanyExportTooLarge(
                f"export for '{company.company_profile_id}' exceeds the "
                f"{max_bytes}-byte budget"
            )
        files[path] = content

    _add("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
    _add("COMPANY.md", _company_markdown(company, manifest["metadata"]))
    _add(
        ".superclaw.yaml",
        _sidecar_yaml(
            company=company,
            workspace=workspace,
            agents=agents,
            slug_map=slug_map,
            includes=includes,
            revision=resolved_revision,
            generated_at=stamp,
        ),
    )
    for agent in agents:
        slug = slug_map[agent.profile_id]
        reports_to_slug = slug_map.get(agent.reports_to or "")
        _add(f"agents/{slug}/AGENTS.md", _agent_markdown(agent, slug, reports_to_slug))

    if include_issues:
        for issue in issues:
            islug = issue_slug_map[issue.issue_id]
            _add(
                f"issues/{islug}.md",
                _issue_markdown(
                    issue,
                    slug_map=slug_map,
                    comments=store.list_issue_comments(issue.issue_id) if include_issues else [],
                    work_products=work_products_by_issue.get(issue.issue_id, []),
                ),
            )

    _add(
        "README.md",
        _readme(
            company=company,
            agents=agents,
            slug_map=slug_map,
            includes=includes,
            issue_count=len(issues),
        ),
    )

    return CompanyExportBundle(
        company_profile_id=company.company_profile_id,
        company_name=company.name,
        manifest=manifest,
        files=files,
        includes=includes,
        warnings=tuple(warnings),
        agent_count=len(agents),
        issue_count=len(issues),
    )


# --- ordering & slugs -------------------------------------------------------


def _ordered_agents(store: StateStore, company_profile_id: str) -> list[AgentProfile]:
    """Deterministic agent order (created_at, profile_id) so slug assignment and
    file output are stable across exports of an unchanged company."""
    agents = store.list_agent_profiles(company_profile_id=company_profile_id)
    return sorted(agents, key=lambda a: (a.created_at, a.profile_id))


def _slugify(text: str, fallback: str) -> str:
    """Return a path-safe ``[a-z0-9-]+`` slug.

    BOTH ``text`` and ``fallback`` are sanitized — never return an unsanitized
    id, or a hostile ``profile_id`` like ``../../evil`` would escape the bundle's
    ``agents/<slug>/`` path. The final ``"item"`` guarantees a non-empty,
    traversal-free result even when every input sanitizes to empty.
    """
    base = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    if base:
        return base
    safe_fallback = re.sub(r"[^a-z0-9]+", "-", (fallback or "").strip().lower()).strip("-")
    return safe_fallback or "item"


def _assign_slugs(agents: list[AgentProfile]) -> dict[str, str]:
    """Map each agent ``profile_id`` to a unique, filesystem-safe role slug.

    Slugs are derived from ``role`` (falling back to ``name`` then ``profile_id``)
    and deduped with a numeric suffix, so they survive re-import as stable
    ``role_id`` references — including ``reports_to`` edges.
    """
    taken: set[str] = set()
    slug_map: dict[str, str] = {}
    for agent in agents:
        base = _slugify(agent.role or agent.name, agent.profile_id)
        slug = base
        index = 2
        while slug in taken:
            slug = f"{base}-{index}"
            index += 1
        taken.add(slug)
        slug_map[agent.profile_id] = slug
    return slug_map


def _assign_issue_slugs(issues: list[Issue]) -> dict[str, str]:
    taken: set[str] = set()
    slug_map: dict[str, str] = {}
    for issue in issues:
        base = _slugify(issue.title, issue.issue_id)
        slug = base
        index = 2
        while slug in taken:
            slug = f"{base}-{index}"
            index += 1
        taken.add(slug)
        slug_map[issue.issue_id] = slug
    return slug_map


# --- workspace & revision ---------------------------------------------------


def _primary_workspace(
    store: StateStore, company: CompanyProfile, agents: list[AgentProfile]
) -> WorkspaceProfile:
    """Pick the workspace that anchors this company's roster.

    Prefer the workspace the agents actually reference; fall back to the first
    company-scoped workspace, then to a synthesized ``local`` default so a
    workspace-less company still exports a re-importable manifest.
    """
    workspaces = {w.workspace_id: w for w in store.list_workspace_profiles(company_profile_id=company.company_profile_id)}
    for agent in agents:
        if agent.workspace_id in workspaces:
            return workspaces[agent.workspace_id]
    if workspaces:
        # Deterministic pick: lowest workspace_id.
        return workspaces[min(workspaces)]
    # No workspace saved: synthesize one with a STABLE, company-derived id. A
    # random default_factory id here would make the export non-deterministic
    # (the digest would mutate every run).
    return WorkspaceProfile(
        name=company.name or "local",
        workspace_id=f"{company.company_profile_id}-workspace",
        company_profile_id=company.company_profile_id,
    )


def _warn_collapsed_workspaces(
    store: StateStore,
    company: CompanyProfile,
    agents: list[AgentProfile],
    primary: WorkspaceProfile,
    warnings: list[str],
) -> None:
    """The bootstrap importer creates ONE workspace. If the ROSTER actually spans
    several real execution boundaries, exporting against the primary silently
    collapses them — so we name every boundary a role will be folded out of.

    The signal is what AGENTS reference (the roster), intersected with real saved
    workspaces — not merely how many workspace rows exist. So a saved-but-unused
    second workspace does not warn (no role collapses), and the default ``"local"``
    id of a workspace-less company does not warn (not a real boundary)."""
    saved_ids = {
        w.workspace_id for w in store.list_workspace_profiles(company_profile_id=company.company_profile_id)
    }
    roster_boundaries = {a.workspace_id for a in agents if a.workspace_id in saved_ids}
    spanned = roster_boundaries - {primary.workspace_id}
    if spanned:
        warnings.append(
            f"roster spans {len(spanned) + 1} workspaces; only the primary "
            f"'{primary.workspace_id}' is exported — roles on "
            f"{sorted(spanned)} collapse onto it on re-import"
        )


def _warn_budget_drift(
    warnings: list[str], name: str, slug: str, field_name: str, value: int, company_default: int
) -> None:
    if not company_default:
        return
    if value > company_default:
        warnings.append(
            f"agent '{name}' ({slug}) {field_name} {value} exceeds the company "
            f"default {company_default}; it will be clamped to {company_default} on re-import"
        )
    elif value == 0:
        warnings.append(
            f"agent '{name}' ({slug}) {field_name} 0 (unbounded) will inherit the "
            f"company default {company_default} on re-import"
        )


def _warn_dropped_metadata(
    company: CompanyProfile, agents: list[AgentProfile], warnings: list[str]
) -> None:
    """Raw ``metadata`` is deliberately excluded from the portable package (it may
    embed secrets / machine-specific data). Tell the operator when such data
    existed so its omission is a visible decision, not a silent loss. Only a
    SCALAR ``metadata['version']`` is exempt (it IS surfaced, as the package
    revision); a non-scalar ``version`` is dropped like any other key and so must
    still trigger the warning."""
    company_extra = {
        k for k in company.metadata if not (k == "version" and _is_scalar(company.metadata[k]))
    }
    if company_extra:
        warnings.append(
            "company.metadata was not exported (may contain machine-specific or "
            "sensitive data); re-create it on the target if needed"
        )
    if any(agent.metadata for agent in agents):
        warnings.append(
            "agent metadata was not exported (may contain machine-specific or "
            "sensitive data); re-create it on the target if needed"
        )


def _is_scalar(value: Any) -> bool:
    """A plain str/int/float — the only shape safe to surface verbatim. ``bool``
    is an ``int`` subclass, so it is excluded explicitly."""
    return isinstance(value, (str, int, float)) and not isinstance(value, bool)


def _resolve_revision(company: CompanyProfile, revision: str | None) -> str:
    if revision and revision.strip():
        return revision.strip()
    # The metadata['version'] convenience is a SCALAR-only contract: a non-scalar
    # (e.g. a nested dict) would otherwise be str()'d into the revision and leak
    # whatever it holds into the package. Anything not a plain scalar is ignored.
    raw_version = (company.metadata or {}).get("version")
    if _is_scalar(raw_version):
        meta_version = str(raw_version).strip()
        if meta_version:
            return meta_version
    return "1.0.0"


# --- manifest (round-trip target) -------------------------------------------


def _role_entry(
    agent: AgentProfile,
    slug_map: dict[str, str],
    warnings: list[str],
    *,
    company_default_seconds: int,
    company_default_tokens: int,
) -> dict[str, Any]:
    slug = slug_map[agent.profile_id]
    reports_to_slug: str | None = None
    if agent.reports_to:
        reports_to_slug = slug_map.get(agent.reports_to)
        if reports_to_slug is None:
            warnings.append(
                f"agent '{agent.name}' ({slug}) reports_to an agent outside this "
                f"company; the edge was dropped on export"
            )
    # The bootstrap importer governs a role's budget two ways: it CLAMPS a budget
    # above the company ceiling down to it, and SUBSTITUTES the company default
    # for a 0 (unbounded/inherit) budget. Warn on both so the re-imported budget
    # is never a silent surprise.
    _warn_budget_drift(
        warnings, agent.name, slug, "budget_seconds", agent.budget_seconds, company_default_seconds
    )
    _warn_budget_drift(
        warnings, agent.name, slug, "token_budget", agent.token_budget, company_default_tokens
    )
    return {
        "id": slug,
        "name": agent.name,
        "role": agent.role,
        "title": agent.title,
        "charter": agent.charter,
        "persona": agent.persona,
        "default_instructions": agent.default_instructions,
        "reports_to": reports_to_slug,
        "backend_policy": agent.backend_policy,
        "model": agent.model,
        "effort": agent.effort,
        "plugin_allowlist": list(agent.plugin_allowlist),
        "skill_allowlist": list(agent.skill_allowlist),
        "permission_policy": dict(agent.permission_policy),
        "runtime_config": dict(agent.runtime_config),
        "budgets": {
            "budget_seconds": agent.budget_seconds,
            "token_budget": agent.token_budget,
            "run_count_budget": agent.run_count_budget,
            "external_tool_budget": agent.external_tool_budget,
        },
    }


def _is_portable_relative_path(path: str) -> bool:
    """True only for a safe, portable relative path.

    Rejects (defense in depth, cross-platform): NUL bytes, POSIX/UNC absolute
    paths, Windows drive-letter paths (``C:\\...``), and any ``..`` traversal
    segment under either separator. An unsafe path left in the manifest would
    either leak a machine boundary or blow up the importer's own validation.
    """
    if not path or "\x00" in path:
        return False
    if path.startswith("/") or path.startswith("\\"):
        return False
    if re.match(r"^[A-Za-z]:", path):  # windows drive (C:\, D:/, ...)
        return False
    segments = re.split(r"[\\/]+", path)
    return ".." not in segments


def _portable_workspace(workspace: WorkspaceProfile, warnings: list[str]) -> dict[str, Any]:
    """Strip machine-local paths from the workspace so the manifest is portable
    and survives its own re-import validation."""
    network_policy = workspace.network_policy
    if network_policy not in _SAFE_NETWORK_POLICIES:
        warnings.append(
            f"workspace network_policy '{network_policy}' is not portable; "
            f"clamped to 'restricted' on export"
        )
        network_policy = "restricted"

    safe_paths: list[str] = []
    for raw in workspace.writable_paths or ["."]:
        path = str(raw)
        if not _is_portable_relative_path(path):
            warnings.append(f"writable_path '{path}' is not portable and was dropped on export")
            continue
        safe_paths.append(path)
    if not safe_paths:
        safe_paths = ["."]

    return {
        "workspace_id": workspace.workspace_id,
        "name": workspace.name,
        # repo_path is intentionally normalized to "." — the local checkout path
        # is machine-specific and is dropped entirely (NOT carried anywhere); the
        # operator rebinds the workspace to a local repo on import.
        "repo_path": ".",
        "writable_paths": safe_paths,
        "network_policy": network_policy,
    }


def _digest_payload(
    company_block: dict[str, Any],
    workspace_block: dict[str, Any],
    roles: list[dict[str, Any]],
    high_risk: dict[str, Any],
) -> str:
    """The canonical export digest: sha256 over the round-trippable payload with
    sorted keys. The single definition used both to STAMP a manifest and to
    VERIFY one (see :func:`manifest_self_digest`)."""
    payload = {
        "company": company_block,
        "workspace": workspace_block,
        "roles": roles,
        "high_risk_policies": high_risk,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def manifest_self_digest(manifest: dict[str, Any]) -> str | None:
    """Recompute the digest from a manifest's OWN ``company``/``workspace``/
    ``roles``/``high_risk_policies`` payload, so a caller can verify the manifest
    is a genuine, internally-consistent exporter product (its recorded digest
    matches its content). Returns None if the manifest is structurally unfit to
    digest. This is what lets a destructive ``--force`` overwrite trust that a
    directory is really a prior export and not a look-alike."""
    if not isinstance(manifest, dict):
        return None
    company_block = manifest.get("company")
    workspace_block = manifest.get("workspace")
    roles = manifest.get("roles")
    high_risk = manifest.get("high_risk_policies", {})
    if not (isinstance(company_block, dict) and isinstance(workspace_block, dict)):
        return None
    if not isinstance(roles, list) or not isinstance(high_risk, dict):
        return None
    try:
        return _digest_payload(company_block, workspace_block, roles, high_risk)
    except (TypeError, ValueError):
        return None


def _build_manifest(
    *,
    company: CompanyProfile,
    workspace: WorkspaceProfile,
    role_entries: list[dict[str, Any]],
    issues: list[Issue],
    issue_slug_map: dict[str, str],
    slug_map: dict[str, str],
    revision: str,
    warnings: list[str],
) -> dict[str, Any]:
    company_block = {
        "company_profile_id": company.company_profile_id,
        "name": company.name,
        "goal": company.goal,
        "default_budget_seconds": company.default_budget_seconds,
        "default_token_budget": company.default_token_budget,
        "allowed_plugins": list(company.allowed_plugins),
    }
    workspace_block = _portable_workspace(workspace, warnings)
    high_risk = dict(company.high_risk_policies)

    # The digest covers the round-trippable payload (NOT metadata itself, which
    # carries the digest) so the same company always exports the same digest.
    digest = _digest_payload(company_block, workspace_block, role_entries, high_risk)

    manifest: dict[str, Any] = {
        # NOTE: deliberately NO top-level "kind": "company". The bootstrap
        # importer routes ``kind == "company" and "roles" in raw`` to the
        # *superclaw-company* normalizer (which reads raw["summary"]/provenance
        # and hardcodes the workspace, dropping our metadata/digest). Omitting
        # ``kind`` routes to the *agentcompanies* normalizer, which consumes the
        # explicit metadata/company/workspace blocks below — the round-trip target.
        "schema": EXPORT_SCHEMA,
        "metadata": {
            # All three are REQUIRED-non-empty by the bootstrap importer; we set
            # stable, meaningful values so a re-import is never blocked.
            "source": f"superclaw:company:{company.company_profile_id}",
            "revision": revision,
            "digest": digest,
        },
        "company": company_block,
        "workspace": workspace_block,
        "high_risk_policies": high_risk,
        "roles": role_entries,
    }
    if issues:
        # Documentation-only: the importer reads ``seed_issue``/``task`` (single),
        # so this list is ignored on re-import by construction (fail-safe context).
        manifest["issues"] = [
            {
                "id": issue_slug_map[issue.issue_id],
                "title": issue.title,
                "status": issue.status,
                "priority": issue.priority,
                "assignee": slug_map.get(issue.assignee_agent_profile_id or ""),
                "origin_kind": issue.origin_kind,
            }
            for issue in issues
        ]
    return manifest


# --- markdown & sidecar renderers -------------------------------------------


def _yaml_frontmatter(data: dict[str, Any]) -> str:
    body = yaml.safe_dump(data, sort_keys=False, allow_unicode=True, default_flow_style=False)
    return f"---\n{body}---\n"


def _company_markdown(company: CompanyProfile, metadata: dict[str, Any]) -> str:
    front = _yaml_frontmatter(
        {
            "schema": EXPORT_SCHEMA,
            "kind": "company",
            "name": company.name,
            "company_profile_id": company.company_profile_id,
            "revision": metadata["revision"],
            "default_budget_seconds": company.default_budget_seconds,
            "default_token_budget": company.default_token_budget,
            "allowed_plugins": list(company.allowed_plugins),
        }
    )
    goal = company.goal.strip() or "_No company goal recorded._"
    return f"{front}\n# {company.name}\n\n{goal}\n\nSee `agents/` for the team roster and `manifest.json` for the machine-readable, re-importable definition.\n"


def _agent_markdown(agent: AgentProfile, slug: str, reports_to_slug: str | None) -> str:
    front = _yaml_frontmatter(
        {
            "schema": EXPORT_SCHEMA,
            "kind": "agent",
            "name": agent.name,
            "role": agent.role,
            "id": slug,
            "title": agent.title or "",
            "reports_to": reports_to_slug or "",
            "backend_policy": agent.backend_policy,
            "model": agent.model,
            "effort": agent.effort,
            "skills": list(agent.skill_allowlist),
            "plugins": list(agent.plugin_allowlist),
        }
    )
    sections = [front, f"\n# {agent.name}\n"]
    if agent.title:
        sections.append(f"\n_{agent.title}_\n")
    charter = agent.charter.strip()
    sections.append("\n## Charter\n\n" + (charter or "_No charter recorded._") + "\n")
    if agent.persona.strip():
        sections.append("\n## Persona\n\n" + agent.persona.strip() + "\n")
    if agent.default_instructions.strip():
        sections.append("\n## Default instructions\n\n" + agent.default_instructions.strip() + "\n")
    return "".join(sections)


def _issue_markdown(
    issue: Issue,
    *,
    slug_map: dict[str, str],
    comments: list[Any],
    work_products: list[WorkProduct],
) -> str:
    front = _yaml_frontmatter(
        {
            "schema": EXPORT_SCHEMA,
            "kind": "issue",
            "title": issue.title,
            "status": issue.status,
            "priority": issue.priority,
            "assignee": slug_map.get(issue.assignee_agent_profile_id or "") or "",
            "origin_kind": issue.origin_kind,
        }
    )
    out = [front, f"\n# {issue.title}\n\n", (issue.description.strip() or "_No description._"), "\n"]
    if work_products:
        out.append("\n## Deliverables\n\n")
        for wp in work_products:
            label = wp.title or wp.url or wp.external_id or wp.work_product_id
            primary = " (primary)" if wp.is_primary else ""
            target = f" — {wp.url}" if wp.url else ""
            out.append(f"- **{wp.type}** [{wp.status}]{primary}: {label}{target}\n")
    if comments:
        out.append("\n## Thread\n\n")
        for comment in comments:
            out.append(f"- **{comment.author_type}** ({comment.author_id}): {comment.body}\n")
    out.append(
        "\n> Documentation-only: re-importing this company recreates the team "
        "roster, not this issue.\n"
    )
    return "".join(out)


def _sidecar_yaml(
    *,
    company: CompanyProfile,
    workspace: WorkspaceProfile,
    agents: list[AgentProfile],
    slug_map: dict[str, str],
    includes: dict[str, bool],
    revision: str,
    generated_at: float,
) -> str:
    """Vendor sidecar holding portable *governance* fidelity the base markdown
    omits — and NO machine-DERIVED fields.

    Deliberately excluded (a company-as-code package is shareable, so it must
    never carry machine-derived data): ``repo_path`` / ``repo_identity``
    (absolute paths, remote URLs that may embed tokens) and raw company/agent
    ``metadata`` (an open dict that can hold anything). What stays is the
    operator-authored governance payload — ``permission_policy``,
    ``runtime_config``, budgets, containment posture — carried verbatim under the
    same boundary as the charter (it is authored config, not a machine-derived
    leak, and is not secret-scanned). A future richer importer can restore it.
    """
    payload = {
        "schema_version": 1,
        # A format descriptor for THIS sidecar file (not a kernel business kind).
        "sidecar_format": "superclaw-company-fidelity/v1",
        "generated_at": generated_at,
        "revision": revision,
        "includes": includes,
        "company": {
            "high_risk_policies": dict(company.high_risk_policies),
        },
        "workspace": {
            "workspace_id": workspace.workspace_id,
            "kind": workspace.kind,
            "concurrency": workspace.concurrency,
            "containment_preset": workspace.containment_preset,
            "trust_status": workspace.trust_status,
            "default_permission_policy": dict(workspace.default_permission_policy),
        },
        "agents": {
            slug_map[agent.profile_id]: {
                "permission_policy": dict(agent.permission_policy),
                "runtime_config": dict(agent.runtime_config),
                # Governance fidelity the bootstrap importer does NOT consume —
                # carried here for a future richer importer, never machine-local.
                "context_mode": agent.context_mode,
                "charter_source": agent.charter_source,
                "budgets": {
                    "budget_seconds": agent.budget_seconds,
                    "token_budget": agent.token_budget,
                    "run_count_budget": agent.run_count_budget,
                    "external_tool_budget": agent.external_tool_budget,
                },
            }
            for agent in agents
        },
    }
    return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _readme(
    *,
    company: CompanyProfile,
    agents: list[AgentProfile],
    slug_map: dict[str, str],
    includes: dict[str, bool],
    issue_count: int,
) -> str:
    # NOTE: export warnings are NEVER written into a bundle file. A warning's text
    # can echo a dropped raw path (e.g. an absolute /Users/.../secret writable
    # path), and the bundle is shareable — so warnings stay in
    # CompanyExportBundle.warnings for the operator only, never shipped.
    lines = [
        f"# {company.name} — company export\n",
        "",
        company.goal.strip() or "_No company goal recorded._",
        "",
        "## Contents",
        "",
        f"- **{len(agents)}** agents (`agents/<role>/AGENTS.md`)",
        "- `manifest.json` — machine-readable, **re-importable** definition (`superclaw team bootstrap`)",
        "- `.superclaw.yaml` — vendor sidecar with full-fidelity governance fields",
    ]
    if includes.get("issues"):
        lines.append(f"- **{issue_count}** issue pages (`issues/`) — documentation-only context")
    lines += ["", "## Org chart", "", _mermaid_org_chart(agents, slug_map)]
    lines += [
        "",
        "## Round-trip",
        "",
        "Re-importing this package recreates the **team roster** (roles, charters, "
        "budgets, reporting lines, equipment allowlists). Budgets are governed on "
        "import — a budget above the company ceiling is clamped down, and a 0 "
        "(unbounded) budget inherits the company default. Issues, comments, and "
        "work products are exported as documentation only — they are **not** "
        "recreated on import.",
        "",
        "## Security note",
        "",
        "This package strips machine-derived local fields (checkout paths, repo "
        "identity, raw metadata). It does **not** scan user-authored text "
        "(charters, instructions) — that is the intended payload, so do not embed "
        "credentials in a charter, just as you would not commit one to a README.",
    ]
    return "\n".join(lines) + "\n"


def _mermaid_org_chart(agents: list[AgentProfile], slug_map: dict[str, str]) -> str:
    if not agents:
        return "_No agents._"
    out = ["```mermaid", "graph TD"]
    for agent in agents:
        slug = slug_map[agent.profile_id]
        label = agent.name.replace('"', "'")
        role = (agent.role or "").replace('"', "'")
        out.append(f'  {slug}["{label}<br/>{role}"]')
    for agent in agents:
        parent = slug_map.get(agent.reports_to or "")
        if parent:
            out.append(f"  {parent} --> {slug_map[agent.profile_id]}")
    out.append("```")
    return "\n".join(out)
