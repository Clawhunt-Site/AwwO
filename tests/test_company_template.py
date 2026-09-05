"""Company template standard protocol (Capability Workshop 方向一): schema +
trust-verified domain model + relational contract + CLI validate."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.company_template import (
    CompanyTemplateError,
    _COMPANY_VERIFIER,
    company_local_dev_trust_enabled,
    load_company_template,
    validate_company_template_contract,
    verify_company_template,
)
from superclaw.company_template import CompanyTemplate

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
        "source": {"type": "developer", "developer_id": "dev_acme"},
        "commerce": {"pricing_model": "free"},
        "roles": [
            {"name": "lead", "charter": "Lead the team"},
            {"name": "impl", "charter": "Implement", "reports_to": "lead"},
        ],
        "equipment_requirements": {"impl": {"skills": ["s1"], "plugins": ["p1"]}},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "developer", "package_digest": "", "signature": ""},
    }
    m.update(overrides)
    return m


def _write(base: Path, manifest: dict) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


def _sign(base: Path, manifest: dict, priv: Ed25519PrivateKey) -> Path:
    """Write, compute the canonical digest, fill+sign provenance, rewrite."""
    _write(base, manifest)
    template = CompanyTemplate(source=base, root=base, manifest=manifest)
    digest = _COMPANY_VERIFIER.compute_digest(template)
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode("utf-8"))).decode()
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


# --- contract validation ---------------------------------------------------


def test_validate_accepts_valid(tmp_path):
    base = _write(tmp_path / "co", _manifest())
    template = load_company_template(base)
    validate_company_template_contract(template.manifest)  # no raise
    assert template.role_names == ["lead", "impl"]
    assert template.equipment_requirements == {"impl": {"skills": ["s1"], "plugins": ["p1"]}}


def test_reports_to_cycle_rejected(tmp_path):
    m = _manifest(roles=[
        {"name": "a", "charter": "x", "reports_to": "b"},
        {"name": "b", "charter": "y", "reports_to": "a"},
    ], equipment_requirements={})
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError, match="cycle"):
        validate_company_template_contract(load_company_template(base).manifest)


def test_reports_to_unknown_role_rejected(tmp_path):
    m = _manifest(roles=[{"name": "a", "charter": "x", "reports_to": "ghost"}], equipment_requirements={})
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError, match="unknown role"):
        validate_company_template_contract(load_company_template(base).manifest)


def test_equipment_unknown_role_rejected(tmp_path):
    m = _manifest(equipment_requirements={"ghost": {"skills": []}})
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError, match="unknown role"):
        validate_company_template_contract(load_company_template(base).manifest)


def test_duplicate_role_names_rejected(tmp_path):
    m = _manifest(roles=[{"name": "a", "charter": "x"}, {"name": "a", "charter": "y"}], equipment_requirements={})
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError, match="unique"):
        validate_company_template_contract(load_company_template(base).manifest)


def test_acceptance_field_rejected(tmp_path):
    # 护栏 / Q1.6: company protocol must NOT carry plugin acceptance; schema is
    # additionalProperties:false so an extra field is refused.
    m = _manifest()
    m["acceptance"] = {"tests": []}
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError):
        validate_company_template_contract(load_company_template(base).manifest)


def test_missing_roles_rejected(tmp_path):
    m = _manifest(roles=[], equipment_requirements={})
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError):
        validate_company_template_contract(load_company_template(base).manifest)


# --- full trust chain ------------------------------------------------------


def test_verify_full_chain_official(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(tmp_path / "co", _manifest(), priv)
    template, trust_class = verify_company_template(base)
    assert trust_class == "official"
    assert template.artifact_id == "acme.delivery"


def test_verify_digest_mismatch_rejected(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(tmp_path / "co", _manifest(), priv)
    (base / "extra.txt").write_text("tampered after signing", encoding="utf-8")  # changes digest
    with pytest.raises(CompanyTemplateError, match="digest mismatch"):
        verify_company_template(base)


def test_verify_bad_signature_fail_closed(tmp_path, monkeypatch):
    priv, _ = _keypair()
    _, other_pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, other_pub)  # wrong root key
    monkeypatch.delenv(LOCAL_DEV_ENV, raising=False)
    base = _sign(tmp_path / "co", _manifest(), priv)
    with pytest.raises(CompanyTemplateError):
        verify_company_template(base)


def test_kind_scoped_env(monkeypatch):
    # company trust reads SUPERCLAW_COMPANY_* — never the plugin env.
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "")
    assert company_local_dev_trust_enabled() is True
    assert _COMPANY_VERIFIER.root_key_env == "SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY"


# --- CLI -------------------------------------------------------------------


def test_cli_company_template_validate(tmp_path):
    runner = CliRunner()
    base = _write(tmp_path / "co", _manifest())
    res = runner.invoke(app, ["company", "template", "validate", str(base)])
    assert res.exit_code == 0, res.output
    payload = json.loads(res.output)
    assert payload["valid"] is True and payload["signature_checked"] is False
    assert payload["roles"] == ["lead", "impl"]


def test_cli_company_template_validate_rejects_bad(tmp_path):
    runner = CliRunner()
    m = _manifest(roles=[
        {"name": "a", "charter": "x", "reports_to": "b"},
        {"name": "b", "charter": "y", "reports_to": "a"},
    ], equipment_requirements={})
    base = _write(tmp_path / "co", m)
    res = runner.invoke(app, ["company", "template", "validate", str(base)])
    assert res.exit_code == 1
    assert "cycle" in res.output


def test_cli_company_template_validate_with_signature(tmp_path, monkeypatch):
    runner = CliRunner()
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(tmp_path / "co", _manifest(), priv)
    res = runner.invoke(app, ["company", "template", "validate", str(base), "--verify-signature"])
    assert res.exit_code == 0, res.output
    payload = json.loads(res.output)
    assert payload["signature_checked"] is True
    assert payload["trust_class"] == "official" and payload["signature_verified"] is True


# --- extra coverage (Codex CW-1 verification gaps) -------------------------


def test_commerce_required(tmp_path):
    m = _manifest()
    del m["commerce"]
    base = _write(tmp_path / "co", m)
    with pytest.raises(CompanyTemplateError):
        validate_company_template_contract(load_company_template(base).manifest)


def test_sccompany_archive_roundtrip(tmp_path, monkeypatch):
    import zipfile
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    src = _sign(tmp_path / "co", _manifest(), priv)
    archive = tmp_path / "acme.sccompany"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(src / "superclaw-company.json", "superclaw-company.json")
    template, trust_class = verify_company_template(archive)
    try:
        assert trust_class == "official" and template.artifact_id == "acme.delivery"
    finally:
        template.cleanup()


def test_archive_zip_slip_rejected(tmp_path):
    import zipfile
    archive = tmp_path / "evil.sccompany"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("superclaw-company.json", json.dumps(_manifest()))
        zf.writestr("../escape.txt", "zip slip")
    with pytest.raises(CompanyTemplateError, match="escapes"):
        load_company_template(archive)


def test_revocation_rejects(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    base = _sign(tmp_path / "co", _manifest(), priv)
    revfile = tmp_path / "revocations.json"
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery"}]}), encoding="utf-8")
    with pytest.raises(CompanyTemplateError, match="revoked"):
        verify_company_template(base, revocation_file=revfile)


def test_revocation_version_and_digest_precision(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest()
    base = _sign(tmp_path / "co", m, priv)
    digest = m["provenance"]["package_digest"]
    revfile = tmp_path / "revocations.json"

    # wrong version → NOT revoked (verifies clean)
    revfile.write_text(json.dumps({"revoked": [{"id": "acme.delivery", "version": "9.9.9"}]}), encoding="utf-8")
    template, _ = verify_company_template(base, revocation_file=revfile)
    template.cleanup()

    # exact version + exact digest → revoked
    revfile.write_text(
        json.dumps({"revoked": [{"id": "acme.delivery", "version": "1.0.0", "package_digest": digest}]}),
        encoding="utf-8",
    )
    with pytest.raises(CompanyTemplateError, match="revoked"):
        verify_company_template(base, revocation_file=revfile)


def test_archive_symlink_rejected(tmp_path):
    import stat
    import zipfile
    archive = tmp_path / "evil.sccompany"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("superclaw-company.json", json.dumps(_manifest()))
        info = zipfile.ZipInfo("link")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16  # mark entry as a symlink
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(CompanyTemplateError, match="symlink"):
        load_company_template(archive)


def test_malformed_signature_is_company_error(tmp_path, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setenv(ROOT_KEY_ENV, pub)
    m = _manifest()
    base = _write(tmp_path / "co", m)
    digest = _COMPANY_VERIFIER.compute_digest(CompanyTemplate(source=base, root=base, manifest=m))
    m["provenance"]["package_digest"] = digest
    m["provenance"]["signature"] = "ed25519:@@@not-base64@@@"
    (base / "superclaw-company.json").write_text(json.dumps(m), encoding="utf-8")
    with pytest.raises(CompanyTemplateError):  # not a raw binascii.Error / stacktrace
        verify_company_template(base)


def test_local_dev_trust_admits_but_not_official(tmp_path, monkeypatch):
    priv, _pub = _keypair()
    monkeypatch.delenv(ROOT_KEY_ENV, raising=False)  # no root key available
    monkeypatch.setenv(LOCAL_DEV_ENV, "1")
    base = _sign(tmp_path / "co", _manifest(), priv)
    template, trust_class = verify_company_template(base)
    try:
        assert trust_class == "local_dev"  # admitted, but NOT signature-verified
    finally:
        template.cleanup()
