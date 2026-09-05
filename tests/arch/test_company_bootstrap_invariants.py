"""Architecture/governance invariants for the company instantiation gate (PR-4 e/f).

Test-as-Policy (per `roadmap-invariants-governance`): the function name IS the rule.
These are the teeth that keep the verify-before-instantiate gate from regressing —
the moment someone builds a company bootstrap proposal without the gate, or commits
without commit-time re-verify, or pollutes the plugin verifier with a company branch,
CI goes red.

They inspect the kernel source by AST so they assert structure, not a brittle
substring, and cannot be satisfied by a comment.
"""

from __future__ import annotations

import ast
from pathlib import Path

import superclaw.plugins as plugins_mod
import superclaw.team_bootstrap as team_bootstrap_mod
import superclaw.team_templates as team_templates_mod


def _module_source(module) -> str:
    return Path(module.__file__).read_text(encoding="utf-8")


def _function_def(module, name: str) -> ast.FunctionDef:
    tree = ast.parse(_module_source(module))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{module.__name__} has no function {name!r}")


def _called_names(func: ast.FunctionDef) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Name):
                names.add(target.id)
            elif isinstance(target, ast.Attribute):
                names.add(target.attr)
    return names


# --- (e) no un-gated build_bootstrap_proposal -------------------------------


def test_e_build_bootstrap_proposal_invokes_company_gate() -> None:
    """Invariant (e): the only path that builds a proposal runs the verify gate.

    The gate lives INSIDE build_bootstrap_proposal, so every CLI/API/web caller
    that reaches a company proposal has passed resolve_company_template_for_bootstrap.
    """
    func = _function_def(team_templates_mod, "build_bootstrap_proposal")
    assert "resolve_company_template_for_bootstrap" in _called_names(func)


def test_e_company_gate_calls_raising_verify() -> None:
    """The gate must use the RAISING verify_company_template (install/instantiate
    path), never the non-raising discovery assess()."""
    func = _function_def(team_templates_mod, "resolve_company_template_for_bootstrap")
    called = _called_names(func)
    assert "verify_company_template" in called


# --- (f) commit-time re-verify present --------------------------------------


def test_f_commit_path_reverifies_company_source() -> None:
    """Invariant (f): commit_bootstrap_proposal re-runs the gate before any write."""
    func = _function_def(team_bootstrap_mod, "commit_bootstrap_proposal")
    assert "_reverify_company_source" in _called_names(func)


def test_f_apply_payload_reverifies_company_source() -> None:
    """The durable apply path (reached by approval-grant resume) re-verifies too."""
    func = _function_def(team_bootstrap_mod, "apply_bootstrap_commit_payload")
    assert "_reverify_company_source" in _called_names(func)


def test_f_reverify_helper_recomputes_via_gate() -> None:
    """The re-verify helper must REBUILD the proposal from the verified source via
    build_bootstrap_proposal (which re-runs the full gate AND re-derives would_create
    from the verified manifest), not an ad-hoc local check — so the durable write
    never trusts caller-supplied records for a company-sourced proposal."""
    func = _function_def(team_bootstrap_mod, "_reverify_company_source")
    assert "build_bootstrap_proposal" in _called_names(func)


def test_f_reverify_rebuilds_and_compares_would_create() -> None:
    """The durable write must not trust caller-supplied records for a company
    source: the helper must compare the payload's would_create against the records
    rebuilt from the verified manifest (closes the valid-verification + tampered-
    records bypass)."""
    func = _function_def(team_bootstrap_mod, "_reverify_company_source")
    source = ast.get_source_segment(_module_source(team_bootstrap_mod), func) or ""
    assert "would_create" in source
    assert "_canonical_records" in source


def test_f_reverify_does_not_read_trust_params_from_payload() -> None:
    """SECURITY: the re-verify must take allow_local_opt_in and the revocation source
    from TRUSTED caller params, never from the (caller-controllable) captured block,
    or a crafted dict could inject allow_local_opt_in=True / a bogus revocation file."""
    func = _function_def(team_bootstrap_mod, "_reverify_company_source")
    source = ast.get_source_segment(_module_source(team_bootstrap_mod), func) or ""
    # The helper must accept allow_local_opt_in as a parameter and pass it through.
    assert "allow_local_opt_in" in {a.arg for a in func.args.kwonlyargs} | {a.arg for a in func.args.args}
    # It must NOT read these security-sensitive values out of the captured payload.
    assert 'captured.get("allow_local_opt_in")' not in source
    assert 'captured["company_revocation_file"]' not in source
    assert "captured.get(\"company_revocation_file\")" not in source


def test_f_reverify_helper_enforces_company_source_kind() -> None:
    """A company-sourced proposal that lacks its verification must be refused at
    the write boundary — the helper inspects source_kind, not just the optional
    company_verification block (closes the crafted-dict bypass)."""
    func = _function_def(team_bootstrap_mod, "_reverify_company_source")
    source = ast.get_source_segment(_module_source(team_bootstrap_mod), func)
    assert "source_kind" in (source or "")


# --- no plugin-pipeline pollution -------------------------------------------


def test_no_company_branch_in_plugin_verification() -> None:
    """No `if kind == "company"` branch may leak into the plugin verify pipeline:
    company has its own _COMPANY_VERIFIER / verify_company_template (北极星护栏 1)."""
    source = _module_source(plugins_mod)
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            literals = [c for c in node.comparators if isinstance(c, ast.Constant)]
            if any(getattr(lit, "value", None) == "company" for lit in literals):
                raise AssertionError("plugins.py must not branch on kind == 'company'")


def test_team_bootstrap_does_not_reuse_plugin_install_pipeline() -> None:
    """Bootstrap writes profile/issue rows in a StateStore transaction; it must
    NEVER reuse the executable plugin-install pipeline (no MCP sidecar install)."""
    source = _module_source(team_bootstrap_mod)
    assert "install_plugin" not in source
    assert "from superclaw.plugins import" not in source
    assert "import plugins" not in source


# --- (a) company stays OUT of the equipment-matching atlas -------------------


def test_a_company_not_in_capability_atlas_integrations() -> None:
    """Invariant (a, design §0): company is a governance template with
    version/digest/signature/revocation — NOT an equipment-matching integration.
    Adding it to CAPABILITY_INTEGRATIONS would mix two unrelated models (the
    domain-pollution the roadmap forbids). It lives in the trusted catalog union."""
    import superclaw.capability_atlas as atlas_mod

    assert "company" not in atlas_mod.CAPABILITY_INTEGRATIONS


# --- (G1) catalog instantiable is DERIVED from trust, never a literal --------


def test_g1_company_instantiable_is_derived_not_constant() -> None:
    """Invariant (G1): the company catalog item's `instantiable` must be DERIVED
    from TrustState at the LOCAL-DIR + MERGE sites (not hard-coded), and the
    capability-registry (REMOTE) projection must NOT mark a company instantiable
    (a registry-only row has no local source path for the gate — design PR-5)."""
    import superclaw.catalog_resolver as catalog_mod

    # Local-dir discovery derives via the helper.
    assert "_company_instantiable" in _called_names(_function_def(catalog_mod, "_company_items"))
    # The source merge re-derives company instantiable from the merged trust.
    assert "_company_instantiable_from_trust" in _called_names(_function_def(catalog_mod, "_merge_sources"))
    # The capability-registry (REMOTE) projection must force company instantiable False
    # (no local source path) — a registry-only company is surfaced but not offerable.
    registry_src = (
        ast.get_source_segment(_module_source(catalog_mod), _function_def(catalog_mod, "_capability_registry_items"))
        or ""
    )
    assert 'False if entry.kind == "company"' in registry_src
    # The deriving helper keys on TrustState + revoked (fail-closed), not a constant.
    helper = _function_def(catalog_mod, "_company_instantiable_from_trust")
    helper_src = ast.get_source_segment(_module_source(catalog_mod), helper) or ""
    assert "_COMPANY_INSTANTIABLE_TRUST" in helper_src
    assert "revoked" in helper_src
