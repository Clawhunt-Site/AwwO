"""Company verify-before-instantiate security gate (PR-1 / design §3).

These tests pin the load-bearing security boundary: a ``kind=company`` template
must pass signature/digest/revocation/namespace verification BEFORE it can be
turned into a bootstrap proposal, the gate is re-run at commit time (TOCTOU), and
every fail-closed path (unsigned / revoked / untrusted / reserved-namespace /
inline-dict) rejects without writing any state.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from superclaw.company_template import _COMPANY_VERIFIER, CompanyTemplate
from superclaw.state import StateStore
from superclaw.team_bootstrap import BootstrapCommitError, commit_bootstrap_proposal
from superclaw.team_templates import (
    CompanyBootstrapVerification,
    CompanyTrustGateError,
    build_bootstrap_proposal,
    resolve_company_template_for_bootstrap,
)

ROOT_KEY_ENV = "SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY"
LOCAL_DEV_ENV = "SUPERCLAW_COMPANY_LOCAL_DEV_TRUST"


def _keypair():
    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, "ed25519:" + base64.b64encode(raw).decode()


def _manifest(**overrides):
    m = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery Co",
        "version": "1.0.0",
        "summary": "A delivery company blueprint",
        "kind": "company",
        # Default fixture is provenance-honest LOCAL/self (no remote channel claim),
        # so it is admissible through the local lane under explicit opt-in. Tests that
        # exercise the remote-claim RED LINE override source/provenance explicitly.
        "source": {"type": "local", "developer_id": "self"},
        "commerce": {"pricing_model": "free"},
        "roles": [
            {"name": "lead", "charter": "Lead the team"},
            {"name": "impl", "charter": "Implement", "reports_to": "lead"},
        ],
        "equipment_requirements": {"impl": {"skills": [], "plugins": []}},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "local", "package_digest": "", "signature": ""},
    }
    m.update(overrides)
    return m


def _write(base: Path, manifest: dict) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


def _sign(base: Path, manifest: dict, priv: Ed25519PrivateKey) -> Path:
    _write(base, manifest)
    template = CompanyTemplate(source=base, root=base, manifest=manifest)
    digest = _COMPANY_VERIFIER.compute_digest(template)
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode("utf-8"))).decode()
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


def _private_tmp(tmp_path: Path) -> Path:
    """A 0700 sub-root so trust/permission checks never depend on /tmp's mode."""
    root = tmp_path / "private"
    root.mkdir(mode=0o700, exist_ok=True)
    return root


# --- gate: trust admission --------------------------------------------------


def test_official_company_passes_gate_and_builds_proposal(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    proposal = build_bootstrap_proposal(str(base))
    assert proposal.company_verification is not None
    assert proposal.company_verification.trust_state == "official"
    assert proposal.company_verification.artifact_id == "acme.delivery"
    assert not proposal.blocked


def test_gate_returns_none_for_legacy_team_template(tmp_path):
    # A non-company (agentcompanies/v1) directory must NOT trip the company gate.
    base = _private_tmp(tmp_path) / "team"
    base.mkdir()
    (base / "agentcompany.json").write_text(
        json.dumps(
            {
                "metadata": {"source": "local", "revision": "1", "digest": "d"},
                "company": {"company_profile_id": "c", "name": "C"},
                "workspace": {"workspace_id": "local", "name": "ws"},
                "roles": [{"id": "r1", "name": "r1", "charter": "do work"}],
            }
        ),
        encoding="utf-8",
    )
    assert resolve_company_template_for_bootstrap(str(base)) is None
    proposal = build_bootstrap_proposal(str(base))
    assert proposal.company_verification is None


def test_unsigned_local_company_fails_closed_without_opt_in(tmp_path, monkeypatch):
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base))


def test_local_company_admitted_only_with_opt_in(tmp_path, monkeypatch):
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")  # local_dev trust available
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    # Even with local_dev trust available, the bootstrap gate still requires an
    # explicit opt-in (allow_local_opt_in) — fail closed by default.
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base))
    proposal = build_bootstrap_proposal(str(base), allow_local_opt_in=True)
    assert proposal.company_verification.trust_state == "local"


def test_remote_claimed_unsigned_company_rejected_even_under_opt_in(tmp_path, monkeypatch):
    """Owner trust-model RED LINE: an UNSIGNED template that SELF-CLAIMS a remote/
    higher-tier provenance (developer/official/registry/market) must NOT be admitted
    through the local lane even under --trust local — it must verify under that claim
    or be rejected. Only a provenance-honest local/self template may use the local lane."""
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    # The company schema constrains source.type to {official, developer, local}; the
    # remote-claim values that reach the provenance guard are developer/official.
    for claimed in ("developer", "official"):
        m = _manifest(source={"type": claimed, "developer_id": "dev_x"})
        base = _sign(_private_tmp(tmp_path) / f"co_{claimed}", m, priv)
        with pytest.raises(CompanyTrustGateError, match="provenance"):
            build_bootstrap_proposal(str(base), allow_local_opt_in=True)
    # Build-type claim alone (with a local source.type) also trips the guard — the
    # provenance.build_type field has no schema enum, so it is the broader vector.
    m = _manifest(provenance={"build_type": "developer", "package_digest": "", "signature": ""})
    base = _sign(_private_tmp(tmp_path) / "co_bt", m, priv)
    with pytest.raises(CompanyTrustGateError, match="provenance"):
        build_bootstrap_proposal(str(base), allow_local_opt_in=True)


def test_official_signed_company_with_source_claim_still_passes(tmp_path, monkeypatch):
    """A ROOT-signed (official) company is admitted regardless of its source claim —
    the remote-provenance guard only gates the unverified local lane, never a template
    that actually verified."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest(source={"type": "official", "developer_id": "first_party"})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    proposal = build_bootstrap_proposal(str(base))
    assert proposal.company_verification.trust_state == "official"


def test_caller_supplied_key_cannot_masquerade_as_official(tmp_path, monkeypatch):
    """SECURITY (Codex R3): a company signed with an ARBITRARY (non-root) key, with that
    key passed as public_key, must NOT be classified official/root. Root identity is
    re-derived via the root-only classifier (configured SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY),
    never a caller-supplied key. A reserved-namespace company signed this way hard-fails;
    a non-reserved one is at most LOCAL (and only under opt-in)."""
    priv, pub = _keypair()  # an arbitrary, NON-root keypair
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)  # no configured root key
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    # (a) reserved namespace signed by a caller key + key passed in: must hard-fail,
    # never be elevated to official/root.
    m_reserved = _manifest(id="superclaw.evil")
    base_r = _sign(_private_tmp(tmp_path) / "r", m_reserved, priv)
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base_r), public_key=pub, allow_local_opt_in=True)

    # (b) non-reserved, local-honest provenance, caller key passed: NOT official; admits
    # only as local AND only under opt-in (fails closed without it).
    base_ok = _sign(_private_tmp(tmp_path) / "ok", _manifest(), priv)
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base_ok), public_key=pub)  # no opt-in -> rejected
    proposal = build_bootstrap_proposal(str(base_ok), public_key=pub, allow_local_opt_in=True)
    assert proposal.company_verification.trust_state == "local"  # NOT official
    assert proposal.company_verification.trust_class != "official"


def test_reserved_namespace_always_hard_fails(tmp_path, monkeypatch):
    # A non-root-signed reserved-namespace company must fail EVEN under opt-in.
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    m = _manifest(id="superclaw.evil")
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    with pytest.raises(CompanyTrustGateError, match="reserved"):
        build_bootstrap_proposal(str(base), allow_local_opt_in=True)


def test_revoked_company_fails_closed(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    revfile = _private_tmp(tmp_path) / "revocations.json"
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base), company_revocation_file=revfile)


def test_bad_signature_fails_closed(tmp_path, monkeypatch):
    priv, _ = _keypair()
    _, other_pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, other_pub)  # wrong root key
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    with pytest.raises(CompanyTrustGateError):
        build_bootstrap_proposal(str(base))


# --- gate: inline-dict bypass closed ---------------------------------------


def test_inline_company_dict_rejected(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest()
    with pytest.raises(CompanyTrustGateError, match="inline"):
        build_bootstrap_proposal(m)


def test_inline_company_json_string_rejected(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest()
    with pytest.raises(CompanyTrustGateError, match="inline"):
        build_bootstrap_proposal(json.dumps(m))


def test_inline_non_company_dict_still_works():
    # The inline-dict closure is company-scoped: legacy team dicts still flow.
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": "c", "name": "C"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [{"id": "r1", "name": "r1", "charter": "do work"}],
    }
    proposal = build_bootstrap_proposal(spec)
    assert proposal.company_verification is None


# --- proposal mode writes nothing ------------------------------------------


def test_company_proposal_mode_writes_nothing(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    build_bootstrap_proposal(str(base))  # proposal only — no store touched
    assert store.list_company_profiles() == []
    assert store.list_agent_profiles() == []


# --- commit-time re-verify (TOCTOU) ----------------------------------------


def test_commit_reverifies_and_rejects_digest_swap(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    proposal = build_bootstrap_proposal(str(base))
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    # Swap the on-disk template AFTER proposal: re-sign a different manifest.
    swapped = _manifest(name="Swapped After Proposal")
    _sign(base, swapped, priv)
    with pytest.raises(BootstrapCommitError, match="digest|re-verif"):
        commit_bootstrap_proposal(store, proposal)
    assert store.list_company_profiles() == []


def test_commit_reverifies_and_rejects_revoke_after_proposal(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    revfile = _private_tmp(tmp_path) / "rev.json"
    revfile.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    proposal = build_bootstrap_proposal(str(base), company_revocation_file=revfile)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    # Revoke AFTER the proposal was built.
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    with pytest.raises(BootstrapCommitError):
        commit_bootstrap_proposal(store, proposal, company_revocation_file=revfile)
    assert store.list_company_profiles() == []


def test_commit_succeeds_when_unchanged(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    proposal = build_bootstrap_proposal(str(base))
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    result = commit_bootstrap_proposal(store, proposal)
    assert result["committed"] is True
    assert len(store.list_company_profiles()) == 1


def test_apply_payload_reverifies_for_approval_resume(tmp_path, monkeypatch):
    # The approval-grant apply path reaches apply_bootstrap_commit_payload directly;
    # re-verify must live there too (arbitrary wall-clock time may pass).
    from superclaw.team_bootstrap import apply_bootstrap_commit_payload

    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    proposal = build_bootstrap_proposal(str(base))
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    payload = proposal.to_dict()
    # Swap on disk, then drive the durable apply path used by approval resume.
    _sign(base, _manifest(name="Swapped"), priv)
    with pytest.raises(BootstrapCommitError):
        apply_bootstrap_commit_payload(store, payload)
    assert store.list_company_profiles() == []


def test_approval_resume_uses_captured_revocation_source_not_default(tmp_path, monkeypatch):
    """Approval-resume revocation TOCTOU (Codex R4): a high-risk company that parks at
    an approval under a CUSTOM revocation file must, on grant, re-verify against that
    SAME file — not the default. If the custom file revokes the template after the
    approval is created, the grant must fail closed (no write)."""
    from superclaw.team_kernel import decide_approval

    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    custom_rev = _private_tmp(tmp_path) / "custom_rev.json"
    custom_rev.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    proposal = build_bootstrap_proposal(str(base), company_revocation_file=custom_rev)
    result = commit_bootstrap_proposal(store, proposal, company_revocation_file=custom_rev)
    assert result["approval_required"] is True
    # The trusted revocation source is captured into the approval artifact.
    assert result["approval"]["resume_action"]["company_revocation_file"] == str(custom_rev)

    # Revoke in the CUSTOM file after the approval exists. On grant, resume re-verifies
    # against that captured custom file and must refuse.
    custom_rev.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    with pytest.raises(Exception):  # noqa: PT011 - resume raises through decide_approval
        decide_approval(store, result["approval"]["approval_id"], approved=True)
    assert store.list_company_profiles() == []


def test_proposal_is_built_from_verified_manifest_not_a_reread(tmp_path, monkeypatch):
    """Verify-read == normalize-read binding (closes the TOCTOU between the gate's
    read and the proposal's read): the proposal must be built from the EXACT
    verified manifest. We simulate a swap by mutating the file's on-disk bytes
    AFTER the gate captures the verified manifest but the proposal must still
    reflect the verified content (because build_bootstrap_proposal consumes the
    captured manifest, not a fresh re-read)."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(name="Verified Name"), priv)

    real_resolve = resolve_company_template_for_bootstrap

    def swapping_resolve(source, **kwargs):
        verification = real_resolve(source, **kwargs)
        # Attacker swaps the on-disk template right after verification.
        _sign(Path(source), _manifest(name="SWAPPED Unverified"), priv)
        return verification

    monkeypatch.setattr("superclaw.team_templates.resolve_company_template_for_bootstrap", swapping_resolve)
    proposal = build_bootstrap_proposal(str(base))
    # The proposal reflects the VERIFIED content, never the post-verify swap.
    assert proposal.would_create["company_profile"]["name"] == "Verified Name"
    assert proposal.company_verification.verified_manifest["name"] == "Verified Name"


def test_crafted_company_dict_without_verification_is_refused_at_write(tmp_path, monkeypatch):
    """A caller cannot skip build_bootstrap_proposal and hand commit/apply a
    company-shaped proposal dict that strips company_verification while keeping
    source_kind=company — the durable write boundary refuses it (fail-closed)."""
    from superclaw.team_bootstrap import apply_bootstrap_commit_payload

    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    legit = build_bootstrap_proposal(str(base)).to_dict()
    assert legit["source_kind"] == "company"
    assert legit["would_create"]["company_profile"]["metadata"]["template_source_kind"] == "company"
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    # (a) strip verification + top-level marker, but KEEP the company record marker:
    # the write boundary still refuses (trigger is the record-level claim too).
    tampered_a = json.loads(json.dumps(legit))
    tampered_a["company_verification"] = None
    tampered_a["source_kind"] = "team_template"
    with pytest.raises(BootstrapCommitError, match="verification"):
        commit_bootstrap_proposal(store, tampered_a)
    with pytest.raises(BootstrapCommitError, match="verification"):
        apply_bootstrap_commit_payload(store, tampered_a)

    # (b) strip verification but keep the top-level company marker: also refused.
    tampered_b = json.loads(json.dumps(legit))
    tampered_b["company_verification"] = None
    tampered_b["would_create"]["company_profile"]["metadata"].pop("template_source_kind", None)
    with pytest.raises(BootstrapCommitError, match="verification"):
        commit_bootstrap_proposal(store, tampered_b)
    assert store.list_company_profiles() == []


def test_commit_rejects_valid_verification_with_tampered_records(tmp_path, monkeypatch):
    """Gemini's attack: a VALID company_verification block (for the real on-disk
    template) paired with maliciously-injected would_create records. The commit
    path rebuilds would_create from the verified manifest and refuses the mismatch
    — the durable write never trusts caller-supplied records for a company source."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    legit = build_bootstrap_proposal(str(base)).to_dict()
    tampered = json.loads(json.dumps(legit))  # keeps the valid verification block
    # Inject a malicious company record (e.g. a different company id / extra budget).
    tampered["would_create"]["company_profile"]["company_profile_id"] = "evil.injected"
    tampered["would_create"]["company_profile"]["default_budget_seconds"] = 999999
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    with pytest.raises(BootstrapCommitError, match="do not match the verified template"):
        commit_bootstrap_proposal(store, tampered)
    assert store.list_company_profiles() == []


def test_commit_rejects_tampered_extra_agent_record(tmp_path, monkeypatch):
    """A valid verification block + an extra injected agent profile is refused."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    legit = build_bootstrap_proposal(str(base)).to_dict()
    tampered = json.loads(json.dumps(legit))
    injected = json.loads(json.dumps(tampered["would_create"]["agent_profiles"][0]))
    injected["profile_id"] = "pending_agent_injected"
    tampered["would_create"]["agent_profiles"].append(injected)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    with pytest.raises(BootstrapCommitError, match="do not match the verified template"):
        commit_bootstrap_proposal(store, tampered)
    assert store.list_agent_profiles() == []


def test_approval_artifact_uses_verified_rebuild_not_tampered_payload(tmp_path, monkeypatch):
    """The human approval surface must be bound to the verified template: a tampered
    template/equipment/role_proposals copy must NOT reach the persisted Approval.
    The commit path builds the approval from the rebuilt-verified payload."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    # High-risk policy triggers approvals_required (commit parks at an approval).
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    legit = build_bootstrap_proposal(str(base)).to_dict()
    assert legit["approvals_required"], "expected a high-risk approval gate"

    tampered = json.loads(json.dumps(legit))
    # Tamper the REVIEW surface (provenance + equipment), keeping would_create and
    # approvals_required consistent so the records check passes.
    tampered["template"]["source"] = "catalog://trusted-looking-but-fake"
    if tampered["equipment_resolution"]:
        tampered["equipment_resolution"][0]["granted"] = {"plugins": ["evil.tool"], "skills": []}

    store = StateStore(_private_tmp(tmp_path) / "state.db")
    result = commit_bootstrap_proposal(store, tampered)
    assert result["approval_required"] is True
    approval = result["approval"]
    perm = approval["requested_permission"]
    # The persisted approval artifact reflects the VERIFIED template, not the tamper.
    assert perm["template"]["source"] == legit["template"]["source"]
    assert perm["template"]["source"] != "catalog://trusted-looking-but-fake"
    assert perm["equipment_resolution"] == legit["equipment_resolution"]
    assert store.list_company_profiles() == []  # parked, nothing written


def test_two_distinct_company_proposals_sharing_default_id_do_not_alias_approval(tmp_path, monkeypatch):
    """Two DIFFERENT high-risk company proposals sharing the default proposal_id must
    not dedupe onto one pending approval (which would replay the first's records on
    grant). The second commit raises a collision error instead of silently aliasing."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    hr = {"high_risk_policies": {"allow_external_network": True}}
    base_a = _sign(_private_tmp(tmp_path) / "a", _manifest(id="acme.alpha", policies=hr), priv)
    base_b = _sign(_private_tmp(tmp_path) / "b", _manifest(id="acme.beta", policies=hr), priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    p_a = build_bootstrap_proposal(str(base_a))  # default proposal_id
    p_b = build_bootstrap_proposal(str(base_b))  # SAME default proposal_id
    r_a = commit_bootstrap_proposal(store, p_a)
    assert r_a["approval_required"] is True
    with pytest.raises(BootstrapCommitError, match="proposal_id"):
        commit_bootstrap_proposal(store, p_b)
    # Same proposal re-committed (idempotent) reuses its own approval, no error.
    r_a2 = commit_bootstrap_proposal(store, p_a)
    assert r_a2["approval_required"] is True
    assert r_a2["approval"]["approval_id"] == r_a["approval"]["approval_id"]


def test_approval_dedupe_distinguishes_revocation_source(tmp_path, monkeypatch):
    """Two proposals with identical records/digest/opt-in but DIFFERENT revocation
    sources must NOT alias the same pending approval — otherwise the grant would
    re-verify under the first request's (looser) revocation list. The dedupe compares
    the trusted revocation source too."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    hr = {"high_risk_policies": {"allow_external_network": True}}
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(policies=hr), priv)
    rev_a = _private_tmp(tmp_path) / "rev_a.json"
    rev_b = _private_tmp(tmp_path) / "rev_b.json"
    rev_a.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    rev_b.write_text(json.dumps({"revoked": []}), encoding="utf-8")
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    p_a = build_bootstrap_proposal(str(base), company_revocation_file=rev_a)
    r_a = commit_bootstrap_proposal(store, p_a, company_revocation_file=rev_a)
    assert r_a["approval_required"] is True
    # Same content + same opt-in, DIFFERENT revocation source -> must not alias.
    p_b = build_bootstrap_proposal(str(base), company_revocation_file=rev_b)
    with pytest.raises(BootstrapCommitError, match="proposal_id"):
        commit_bootstrap_proposal(store, p_b, company_revocation_file=rev_b)
    # Re-committing with the SAME source reuses the same approval (idempotent).
    r_a2 = commit_bootstrap_proposal(store, p_a, company_revocation_file=rev_a)
    assert r_a2["approval"]["approval_id"] == r_a["approval"]["approval_id"]


def test_approval_dedupe_distinguishes_local_optin_from_official_only(tmp_path, monkeypatch):
    """Two proposals with identical records/digest but DIFFERENT trust semantics
    (one local-opted, one official-only) must NOT alias the same pending approval —
    otherwise the first approval's stored opt-in would govern the second's grant.
    The dedupe compares the security-relevant opt-in bit + derived trust_state."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    hr = {"high_risk_policies": {"allow_external_network": True}}
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(policies=hr), priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    # First: official (root-signed) high-risk proposal parks at an approval.
    p_official = build_bootstrap_proposal(str(base))
    assert p_official.company_verification.trust_state == "official"
    r1 = commit_bootstrap_proposal(store, p_official)
    assert r1["approval_required"] is True
    assert r1["approval"]["resume_action"]["allow_local_opt_in"] is False

    # Second: SAME template but committed with local opt-in. Even though the root key
    # is set (so it still verifies official), an opt-in request with a different stored
    # opt-in must not silently reuse the official-only approval. We force a local
    # derivation by dropping the root key so the same bytes verify as local under opt-in.
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    p_local = build_bootstrap_proposal(str(base), allow_local_opt_in=True)
    assert p_local.company_verification.trust_state == "local"
    with pytest.raises(BootstrapCommitError, match="proposal_id"):
        commit_bootstrap_proposal(store, p_local, allow_local_opt_in=True)


def test_crafted_payload_cannot_inject_opt_in_or_revocation_source(tmp_path, monkeypatch):
    """Gemini R6: a crafted dict must not be able to inject allow_local_opt_in=True
    or a bogus company_revocation_file via the captured block to bypass --trust /
    revocation. Those are trusted server-side params; re-verify ignores the payload."""
    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")  # local_dev available for the verify primitive
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    # Build a LOCAL proposal legitimately (opt-in true), then commit WITHOUT the
    # server passing allow_local_opt_in: the kernel must refuse (opt-in is not taken
    # from the payload).
    local_proposal = build_bootstrap_proposal(str(base), allow_local_opt_in=True).to_dict()
    assert local_proposal["company_verification"]["trust_state"] == "local"
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    # commit() default allow_local_opt_in=False → local not admitted at the boundary.
    with pytest.raises(BootstrapCommitError):
        commit_bootstrap_proposal(store, local_proposal)
    assert store.list_company_profiles() == []

    # And a payload that points revocation at an empty file cannot dodge a real
    # revocation: re-verify uses the server's revocation source, not the payload's.
    revfile = _private_tmp(tmp_path) / "rev.json"
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    tampered = json.loads(json.dumps(local_proposal))
    tampered["company_verification"]["company_revocation_file"] = str(_private_tmp(tmp_path) / "empty.json")
    (_private_tmp(tmp_path) / "empty.json").write_text(json.dumps({"revoked": []}), encoding="utf-8")
    with pytest.raises(BootstrapCommitError):
        commit_bootstrap_proposal(store, tampered, company_revocation_file=revfile, allow_local_opt_in=True)
    assert store.list_company_profiles() == []


def test_commit_rejects_trust_downgrade_between_proposal_and_commit(tmp_path, monkeypatch):
    """If the on-disk template's trust changes (e.g. official→local) between
    proposal and commit, the trust_state mismatch is refused."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(_private_tmp(tmp_path) / "co", _manifest(), priv)
    proposal = build_bootstrap_proposal(str(base))  # official
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    # Drop the root key + enable local-dev so the SAME bytes now verify as local.
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    with pytest.raises(BootstrapCommitError):
        commit_bootstrap_proposal(store, proposal)
    assert store.list_company_profiles() == []


def test_non_company_to_company_race_is_refused(tmp_path, monkeypatch):
    """Closes the non-company→company TOCTOU: if the source looks non-company to
    the gate (returns None) but is swapped to a company before normalization, the
    post-condition guard refuses — an unverified company never becomes a proposal
    (and would otherwise carry company_verification=None, skipping commit re-verify)."""
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _private_tmp(tmp_path) / "co"
    # Start as a legacy (non-company) team template so the gate returns None.
    base.mkdir()
    (base / "agentcompany.json").write_text(
        json.dumps(
            {
                "metadata": {"source": "local", "revision": "1", "digest": "d"},
                "company": {"company_profile_id": "c", "name": "C"},
                "workspace": {"workspace_id": "local", "name": "ws"},
                "roles": [{"id": "r1", "name": "r1", "charter": "do work"}],
            }
        ),
        encoding="utf-8",
    )

    real_resolve = resolve_company_template_for_bootstrap

    def racing_resolve(source, **kwargs):
        verification = real_resolve(source, **kwargs)  # sees non-company → None
        # Attacker swaps the SAME file the loader reads first to company-kind bytes
        # before normalization re-reads it.
        (Path(source) / "agentcompany.json").write_text(json.dumps(_manifest()), encoding="utf-8")
        return verification

    monkeypatch.setattr("superclaw.team_templates.resolve_company_template_for_bootstrap", racing_resolve)
    with pytest.raises(CompanyTrustGateError, match="verify-before-instantiate"):
        build_bootstrap_proposal(str(base))


def test_verification_to_dict_roundtrip():
    v = CompanyBootstrapVerification(
        source_ref="/p",
        artifact_id="a",
        version="1",
        digest="d",
        trust_class="official",
        trust_state="official",
        allow_local_opt_in=False,
    )
    assert v.to_dict()["trust_state"] == "official"


def test_local_optin_high_risk_company_grant_resumes_and_materializes(tmp_path, monkeypatch):
    """A --trust local (opt-in) company that parks at a human approval must still
    be materializable on GRANT: the opt-in decision is captured into the approval's
    resume_action by the trusted commit path and honored by the resume path. Closes
    the 'local opt-in lost across the approval boundary' fail-closed-too-hard bug."""
    from superclaw.team_kernel import decide_approval

    priv, _ = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")  # local_dev available to the verify primitive
    # High-risk policy forces the commit to park at a human approval.
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")

    proposal = build_bootstrap_proposal(str(base), allow_local_opt_in=True)
    assert proposal.company_verification.trust_state == "local"
    result = commit_bootstrap_proposal(store, proposal, allow_local_opt_in=True)
    assert result["approval_required"] is True
    approval_id = result["approval"]["approval_id"]
    # The trusted commit path persisted the opt-in into the approval artifact.
    assert result["approval"]["resume_action"]["allow_local_opt_in"] is True
    assert store.list_company_profiles() == []  # nothing written yet

    # Granting the approval resumes and materializes the local company.
    decide_approval(store, approval_id, approved=True)
    assert [c.company_profile_id for c in store.list_company_profiles()] == ["acme.delivery"]


def test_high_risk_company_grant_fails_closed_without_captured_optin(tmp_path, monkeypatch):
    """If the approval did NOT capture a local opt-in (e.g. official-only), a local
    template whose trust later degrades cannot be smuggled in on resume: the resume
    re-verify defaults opt-in False. Here an official approval whose root key is gone
    at grant time fails closed rather than silently downgrading to local."""
    from superclaw.team_kernel import decide_approval

    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    proposal = build_bootstrap_proposal(str(base))  # official, no opt-in
    result = commit_bootstrap_proposal(store, proposal)
    assert result["approval_required"] is True
    assert result["approval"]["resume_action"]["allow_local_opt_in"] is False
    approval_id = result["approval"]["approval_id"]
    # Root key disappears + only local_dev available before grant: official no longer
    # verifies and local is not opted-in at the resume boundary → grant must fail closed.
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    with pytest.raises(Exception):  # noqa: PT011 - resume raises through decide_approval
        decide_approval(store, approval_id, approved=True)
    assert store.list_company_profiles() == []


def test_pending_approval_persists_resolved_default_revocation_path_not_none(tmp_path, monkeypatch):
    """Approval-resume revocation TOCTOU guard (default source).

    When an approval is created with the DEFAULT company-revocation source (None), it
    MUST persist a concrete ABSOLUTE path — not None. ``default_company_revocation_file()``
    is now a runtime resolver that can drift between the HOME data root and a legacy cwd
    path as files appear/disappear; persisting None would let grant/resume re-resolve to a
    DIFFERENT effective revocation list than the proposal used, reopening the TOCTOU.
    """
    from superclaw.company_template import default_company_revocation_file

    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    # High-risk official company parks at a human approval (no opt-in needed for official).
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    proposal = build_bootstrap_proposal(str(base))  # no explicit revocation file (default)
    result = commit_bootstrap_proposal(store, proposal)  # company_revocation_file defaults to None

    assert result["approval_required"] is True
    stored = result["approval"]["resume_action"]["company_revocation_file"]
    assert stored is not None, "default revocation source must be persisted, not stored as None"
    assert Path(stored).is_absolute()
    assert stored == str(default_company_revocation_file().resolve())


def test_grant_fails_closed_on_company_approval_missing_revocation_source(tmp_path, monkeypatch):
    """Defense-in-depth for the approval-resume revocation TOCTOU: a COMPANY bootstrap
    approval whose persisted revocation source is missing/None (legacy/malformed — the
    trusted path no longer produces these) must FAIL CLOSED at grant, not silently
    re-resolve the now-dynamic default revocation list and write the company."""
    from superclaw.team_kernel import decide_approval

    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest(policies={"high_risk_policies": {"allow_external_network": True}})
    base = _sign(_private_tmp(tmp_path) / "co", m, priv)
    store = StateStore(_private_tmp(tmp_path) / "state.db")
    proposal = build_bootstrap_proposal(str(base))
    result = commit_bootstrap_proposal(store, proposal)
    approval_id = result["approval"]["approval_id"]

    # Simulate a legacy/malformed pending approval: drop the bound revocation source.
    approval = store.get_approval(approval_id)
    approval.resume_action["company_revocation_file"] = None
    store.save_approval(approval)

    with pytest.raises(Exception):  # noqa: PT011 - fail-closed raises through decide_approval
        decide_approval(store, approval_id, approved=True)
    assert store.list_company_profiles() == []
