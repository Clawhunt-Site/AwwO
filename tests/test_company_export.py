"""Tests for company-as-code export (superclaw.company_export).

The central guarantee is the round-trip: a company exported to a manifest must
re-import cleanly through the bootstrap proposal builder, recreating the same
roster (roles, charters, budgets, reporting lines, equipment).
"""

import re

import pytest

from superclaw.company_export import CompanyExportError, build_company_export
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    Issue,
    WorkProduct,
    WorkspaceProfile,
)
from superclaw.state import StateStore
from superclaw.team_templates import build_bootstrap_proposal


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _seed_company(store, *, company_id="company_acme"):
    store.save_company_profile(
        CompanyProfile(
            name="Acme",
            company_profile_id=company_id,
            goal="Ship a scoped feature safely.",
            default_budget_seconds=120,
            default_token_budget=1000,
            high_risk_policies={},
            metadata={"internal_note": "PROVISIONED_FROM_VAULT_abc"},  # must NOT leak
        )
    )
    store.save_workspace_profile(
        WorkspaceProfile(
            name="Acme Repo",
            workspace_id="workspace_acme",
            company_profile_id=company_id,
            repo_path="/Users/local/secret/acme",  # machine-local; must NOT leak
            writable_paths=["."],
            network_policy="restricted",
            # remote_url with an embedded token is the canonical leak vector.
            repo_identity={
                "canonical_path": "/Users/local/secret/acme",
                "remote_url": "https://x-token:ghp_SECRETTOKEN123@github.com/acme/repo.git",
            },
        )
    )
    ceo = store.save_agent_profile(
        AgentProfile(
            name="CEO",
            role="ceo",
            company_profile_id=company_id,
            workspace_id="workspace_acme",
            charter="Coordinate work, delegate implementation, request review.",
            plugin_allowlist=["inventory.viewer"],
            skill_allowlist=["planning"],
            budget_seconds=90,
        )
    )
    engineer = store.save_agent_profile(
        AgentProfile(
            name="Engineer",
            role="engineer",
            company_profile_id=company_id,
            workspace_id="workspace_acme",
            reports_to=ceo.profile_id,
            charter="Implement scoped changes and report risks.",
            persona="Pragmatic senior engineer.",
            default_instructions="Always open a PR, never push to main.",
            model="claude-opus-4-8",
            plugin_allowlist=["repo.writer"],
            skill_allowlist=["coding"],
            permission_policy={"mode": "ask"},
            runtime_config={"heartbeat": {"enabled": True, "interval_sec": 300}},
            budget_seconds=100,
            token_budget=500,
        )
    )
    return ceo, engineer


def test_export_emits_expected_files(store):
    _seed_company(store)
    bundle = build_company_export(store, "company_acme", revision="1.0.0", generated_at=1000.0)

    assert "manifest.json" in bundle.files
    assert "COMPANY.md" in bundle.files
    assert "README.md" in bundle.files
    assert ".superclaw.yaml" in bundle.files
    assert "agents/ceo/AGENTS.md" in bundle.files
    assert "agents/engineer/AGENTS.md" in bundle.files
    assert bundle.agent_count == 2

    meta = bundle.manifest["metadata"]
    # All three are REQUIRED-non-empty by the bootstrap importer.
    assert meta["source"]
    assert meta["revision"] == "1.0.0"
    assert len(meta["digest"]) == 64  # sha256 hex


def test_export_round_trips_through_bootstrap(store):
    """The load-bearing guarantee: export → manifest → bootstrap proposal,
    not blocked, with the roster preserved."""
    _seed_company(store)
    bundle = build_company_export(store, "company_acme", revision="1.0.0", generated_at=1000.0)

    proposal = build_bootstrap_proposal(
        bundle.manifest,
        available_plugin_ids=["inventory.viewer", "repo.writer"],
        available_skill_ids=["planning", "coding"],
    )

    assert proposal.blocked is False, proposal.rejections
    payload = proposal.to_dict()
    assert payload["would_create"]["company_profile"]["company_profile_id"] == "company_acme"

    roles = [p["role"] for p in payload["would_create"]["agent_profiles"]]
    assert roles == ["ceo", "engineer"]

    # The reporting edge survives as a slug reference, re-expressed as the
    # importer's pending profile id (proof reports_to is NOT a stale profile_id).
    engineer = next(p for p in payload["would_create"]["agent_profiles"] if p["role"] == "engineer")
    assert engineer["reports_to"] == "pending_agent_ceo"

    # The full governed role definition round-trips — not just the headline fields.
    assert "Implement scoped changes" in engineer["charter"]
    assert engineer["budget_seconds"] == 100
    assert engineer["token_budget"] == 500
    assert engineer["persona"] == "Pragmatic senior engineer."
    assert engineer["default_instructions"] == "Always open a PR, never push to main."
    assert engineer["model"] == "claude-opus-4-8"
    assert engineer["permission_policy"] == {"mode": "ask"}
    assert engineer["runtime_config"] == {"heartbeat": {"enabled": True, "interval_sec": 300}}
    assert engineer["skill_allowlist"] == ["coding"]
    assert engineer["plugin_allowlist"] == ["repo.writer"]


def test_manifest_has_no_top_level_kind_company(store):
    """Regression: a top-level kind=="company" would misroute the importer to the
    superclaw-company normalizer and drop our metadata/workspace blocks."""
    _seed_company(store)
    bundle = build_company_export(store, "company_acme", revision="1.0.0", generated_at=1000.0)
    assert bundle.manifest.get("kind") != "company"


def test_machine_derived_local_fields_are_stripped(store):
    """The precise security boundary: SYSTEM-populated machine-derived fields
    (checkout path, repo identity + embedded token, raw metadata) appear in NO
    exported file. This does NOT claim to scrub user-authored content — see
    test_user_authored_content_is_exported_verbatim for that intentional boundary."""
    _seed_company(store)
    bundle = build_company_export(store, "company_acme", revision="1.0.0", generated_at=1000.0)
    assert bundle.manifest["workspace"]["repo_path"] == "."
    blob = "\n".join(bundle.files.values())
    for leaked in (
        "/Users/local/secret",          # repo_path / canonical_path
        "ghp_SECRETTOKEN123",           # token embedded in remote_url
        "x-token",
        "PROVISIONED_FROM_VAULT_abc",   # company.metadata value
        "canonical_path",               # repo_identity key
        "remote_url",
    ):
        assert leaked not in blob, f"machine-derived field leaked: {leaked}"
    # The drop is surfaced as warnings, not silent.
    assert any("metadata" in w for w in bundle.warnings)


def test_user_authored_content_is_exported_verbatim(store):
    """Honesty boundary: charter / persona / instructions ARE the portable payload
    and are exported as-authored — export does not (and must not) scrub them. A
    path-looking string a user wrote into a charter is intentionally carried."""
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    store.save_agent_profile(
        AgentProfile(
            name="Writer",
            role="writer",
            company_profile_id="c1",
            charter="Deploy via /opt/app/run.sh and read configs there.",
        )
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    blob = "\n".join(bundle.files.values())
    # The user-authored path IS exported (it is content, not a machine-derived leak).
    assert "/opt/app/run.sh" in blob
    # And it round-trips as the charter.
    proposal = build_bootstrap_proposal(bundle.manifest)
    role = proposal.to_dict()["would_create"]["agent_profiles"][0]
    assert "/opt/app/run.sh" in role["charter"]


def test_metadata_version_surfaced_as_revision_other_keys_dropped(store):
    """metadata['version'] is the one scalar surfaced (as the package revision);
    every other metadata key is dropped (and warned), value never leaking."""
    store.save_company_profile(
        CompanyProfile(
            name="C",
            company_profile_id="c1",
            metadata={"version": "3.2.1", "vault_ref": "SECRET_VALUE_xyz"},
        )
    )
    store.save_agent_profile(AgentProfile(name="A", role="a", company_profile_id="c1"))
    # No explicit revision → falls back to metadata['version'].
    bundle = build_company_export(store, "c1", generated_at=1000.0)
    assert bundle.manifest["metadata"]["revision"] == "3.2.1"
    blob = "\n".join(bundle.files.values())
    assert "SECRET_VALUE_xyz" not in blob
    assert "vault_ref" not in blob
    assert any("company.metadata was not exported" in w for w in bundle.warnings)


def test_nonscalar_metadata_version_is_ignored_not_leaked(store):
    """A non-scalar metadata['version'] (e.g. a nested dict) must NOT be str()'d
    into the revision — that would leak whatever it holds into the package."""
    store.save_company_profile(
        CompanyProfile(
            name="C",
            company_profile_id="c1",
            metadata={"version": {"vault_ref": "SECRET_NESTED_xyz"}},
        )
    )
    store.save_agent_profile(AgentProfile(name="A", role="a", company_profile_id="c1"))
    bundle = build_company_export(store, "c1", generated_at=1000.0)
    assert bundle.manifest["metadata"]["revision"] == "1.0.0"  # ignored, safe default
    blob = "\n".join(bundle.files.values())
    assert "SECRET_NESTED_xyz" not in blob
    assert "vault_ref" not in blob


def test_single_workspace_company_does_not_falsely_warn_collapse(store):
    """No saved workspace (agents carry the default 'local' id) is ONE boundary,
    not two — the collapse warning must not fire."""
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    store.save_agent_profile(AgentProfile(name="A", role="a", company_profile_id="c1"))
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert not any("spans" in w for w in bundle.warnings)
    # Exactly one saved workspace also must not warn.
    store.save_company_profile(CompanyProfile(name="D", company_profile_id="c2"))
    store.save_workspace_profile(
        WorkspaceProfile(name="w", workspace_id="w1", company_profile_id="c2")
    )
    store.save_agent_profile(
        AgentProfile(name="B", role="b", company_profile_id="c2", workspace_id="w1")
    )
    bundle2 = build_company_export(store, "c2", revision="1.0.0", generated_at=1000.0)
    assert not any("spans" in w for w in bundle2.warnings)


def test_zero_budget_inherits_company_default_with_warning(store):
    """A 0 (unbounded) budget is substituted by the company default on re-import;
    export warns so the inheritance is not a silent surprise."""
    store.save_company_profile(
        CompanyProfile(
            name="C",
            company_profile_id="c1",
            default_budget_seconds=100,
            default_token_budget=1000,
        )
    )
    store.save_agent_profile(
        AgentProfile(name="A", role="a", company_profile_id="c1")  # budgets default to 0
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert any("budget_seconds 0" in w and "inherit" in w for w in bundle.warnings)
    assert any("token_budget 0" in w and "inherit" in w for w in bundle.warnings)
    reimported = build_bootstrap_proposal(bundle.manifest).to_dict()["would_create"]["agent_profiles"][0]
    assert reimported["budget_seconds"] == 100  # inherited, as warned
    assert reimported["token_budget"] == 1000


def test_unsafe_writable_path_dropped_with_warning(store):
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    store.save_workspace_profile(
        WorkspaceProfile(
            name="W",
            workspace_id="w1",
            company_profile_id="c1",
            # POSIX-absolute, traversal, Windows drive, and backslash traversal
            # must all be dropped; only the clean relative path survives.
            writable_paths=["/etc", "../escape", r"C:\Windows", r"..\\win", "src"],
            network_policy="restricted",
        )
    )
    store.save_agent_profile(
        AgentProfile(name="Solo", role="solo", company_profile_id="c1", workspace_id="w1")
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert bundle.manifest["workspace"]["writable_paths"] == ["src"]
    for bad in ("/etc", "../escape", "C:", "win"):
        assert any(bad in w for w in bundle.warnings)
    # The raw dropped paths live in warnings (operator feedback) but must NEVER
    # be written into a shippable bundle file (warning text would leak them).
    blob = "\n".join(bundle.files.values())
    for bad in ("/etc", "../escape", r"C:\Windows"):
        assert bad not in blob, f"warning text leaked dropped path into bundle: {bad}"
    # Still round-trips after sanitization.
    assert build_bootstrap_proposal(bundle.manifest).blocked is False


def test_warnings_are_never_written_into_bundle_files(store):
    """A warning can echo a dropped absolute path; the bundle is shareable, so no
    warning text may appear in any exported file — warnings are operator-only."""
    store.save_company_profile(
        CompanyProfile(name="C", company_profile_id="c1", metadata={"leak": "X"})
    )
    store.save_workspace_profile(
        WorkspaceProfile(
            name="W",
            workspace_id="w1",
            company_profile_id="c1",
            writable_paths=["/Users/secret/abs", "ok"],
        )
    )
    store.save_agent_profile(
        AgentProfile(name="A", role="a", company_profile_id="c1", workspace_id="w1")
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert bundle.warnings  # there ARE warnings to surface
    blob = "\n".join(bundle.files.values())
    for w in bundle.warnings:
        assert w not in blob, f"warning written into bundle: {w}"
    assert "/Users/secret/abs" not in blob


def test_slug_fallback_is_path_safe(store):
    """A hostile/empty role+name must never produce a traversal path via the
    unsanitized profile_id fallback."""
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    store.save_agent_profile(
        AgentProfile(
            name="",
            role="",
            profile_id="../../evil",  # hostile id
            company_profile_id="c1",
        )
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    agent_files = [p for p in bundle.files if p.startswith("agents/")]
    assert agent_files, "an agent page should still be emitted"
    for path in agent_files:
        # The slug is forced to ^[a-z0-9-]+$, so the path can never escape
        # agents/<slug>/ — no traversal, no separator injection.
        slug = path[len("agents/"):].split("/")[0]
        assert re.fullmatch(r"[a-z0-9-]+", slug), slug
        assert ".." not in path.split("/")
        assert not path.startswith("agents//")


def test_budget_exceeding_company_default_warns_and_clamps_on_reimport(store):
    """Export records the role's ACTUAL budget but warns that re-import will clamp
    it to the company ceiling — the round-trip is honest about the governance."""
    store.save_company_profile(
        CompanyProfile(
            name="C",
            company_profile_id="c1",
            default_budget_seconds=100,
            default_token_budget=1000,
        )
    )
    store.save_agent_profile(
        AgentProfile(
            name="Greedy",
            role="greedy",
            company_profile_id="c1",
            budget_seconds=500,   # exceeds company default 100
            token_budget=5000,    # exceeds company default 1000
        )
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert any("budget_seconds 500" in w and "clamped" in w for w in bundle.warnings)
    assert any("token_budget 5000" in w and "clamped" in w for w in bundle.warnings)
    # Manifest records the actual (un-clamped) values...
    assert bundle.manifest["roles"][0]["budgets"]["budget_seconds"] == 500
    # ...and re-import clamps them to the company ceiling (governance, expected).
    proposal = build_bootstrap_proposal(bundle.manifest)
    reimported = proposal.to_dict()["would_create"]["agent_profiles"][0]
    assert reimported["budget_seconds"] == 100
    assert reimported["token_budget"] == 1000


def test_multi_workspace_company_warns_of_collapse(store):
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    for wid in ("w1", "w2"):
        store.save_workspace_profile(
            WorkspaceProfile(name=wid, workspace_id=wid, company_profile_id="c1")
        )
    store.save_agent_profile(
        AgentProfile(name="A", role="a", company_profile_id="c1", workspace_id="w1")
    )
    store.save_agent_profile(
        AgentProfile(name="B", role="b", company_profile_id="c1", workspace_id="w2")
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    assert any("spans" in w and "collapse" in w for w in bundle.warnings)


def test_deterministic_digest_with_multi_element_allowlists(store):
    """Allowlists are list[str] (ordered), so the digest is stable — proven with
    MULTI-element lists, not a single element that could mask an ordering bug."""
    store.save_company_profile(
        CompanyProfile(
            name="C",
            company_profile_id="c1",
            allowed_plugins=["p.alpha", "p.bravo", "p.charlie"],
        )
    )
    store.save_agent_profile(
        AgentProfile(
            name="Multi",
            role="multi",
            company_profile_id="c1",
            plugin_allowlist=["repo.writer", "test.runner", "inventory.viewer"],
            skill_allowlist=["coding", "testing", "planning"],
        )
    )
    a = build_company_export(store, "c1", revision="2.0.0", generated_at=1000.0)
    b = build_company_export(store, "c1", revision="2.0.0", generated_at=2000.0)
    # Digest covers the round-trippable payload, NOT the timestamp.
    assert a.manifest["metadata"]["digest"] == b.manifest["metadata"]["digest"]
    # The whole manifest is byte-stable too (order preserved end to end).
    assert a.files["manifest.json"] == b.files["manifest.json"]


def test_dangling_reports_to_dropped_with_warning(store):
    store.save_company_profile(CompanyProfile(name="C", company_profile_id="c1"))
    store.save_agent_profile(
        AgentProfile(
            name="Solo",
            role="solo",
            company_profile_id="c1",
            reports_to="agent_does_not_exist",  # dangling refs are allowed by the store
        )
    )
    bundle = build_company_export(store, "c1", revision="1.0.0", generated_at=1000.0)
    role = bundle.manifest["roles"][0]
    assert role["reports_to"] is None
    assert any("reports_to" in w for w in bundle.warnings)
    assert build_bootstrap_proposal(bundle.manifest).blocked is False


def test_include_issues_emits_docs_but_does_not_reimport(store):
    _seed_company(store)
    issue = store.save_issue(
        Issue(
            title="Build login flow",
            description="Start with a narrow plan.",
            company_profile_id="company_acme",
            workspace_id="workspace_acme",
            status="done",
            priority="high",
        )
    )
    store.save_work_product(
        WorkProduct(
            issue_id=issue.issue_id,
            company_profile_id="company_acme",
            type="pull_request",
            title="PR #1",
            url="https://example.com/pr/1",
            is_primary=True,
        )
    )
    bundle = build_company_export(
        store,
        "company_acme",
        include_issues=True,
        include_work_products=True,
        revision="1.0.0",
        generated_at=1000.0,
    )
    assert bundle.includes["issues"] is True
    assert bundle.issue_count == 1
    issue_files = [p for p in bundle.files if p.startswith("issues/")]
    assert len(issue_files) == 1
    issue_doc = bundle.files[issue_files[0]]
    assert "Build login flow" in issue_doc
    assert "PR #1" in issue_doc  # work product nested
    # The manifest carries issues as documentation context...
    assert "issues" in bundle.manifest
    # ...but the bootstrap importer ignores it (reads seed_issue/task), so a
    # re-import recreates ONLY the roster — never the issue ledger.
    proposal = build_bootstrap_proposal(bundle.manifest)
    assert proposal.blocked is False
    created_issues = proposal.to_dict()["would_create"].get("issues") or []
    assert created_issues == []


def test_work_products_without_issues_is_ignored_with_warning(store):
    _seed_company(store)
    bundle = build_company_export(
        store, "company_acme", include_work_products=True, revision="1.0.0", generated_at=1000.0
    )
    assert bundle.includes["work_products"] is False
    assert any("work products" in w.lower() for w in bundle.warnings)


def test_unknown_company_raises(store):
    with pytest.raises(CompanyExportError):
        build_company_export(store, "nope")


def test_byte_budget_aborts_during_construction(store):
    """The export byte budget is enforced in the kernel AS files are built, so a
    too-large export raises CompanyExportTooLarge instead of materializing an
    unbounded files map."""
    from superclaw.company_export import CompanyExportTooLarge

    _seed_company(store)
    # A budget smaller than even the manifest forces an early abort.
    with pytest.raises(CompanyExportTooLarge):
        build_company_export(store, "company_acme", max_bytes=10)
    # A generous budget exports fine.
    bundle = build_company_export(store, "company_acme", max_bytes=10_000_000, generated_at=1000.0)
    assert bundle.agent_count == 2
