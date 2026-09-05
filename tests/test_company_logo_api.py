"""API surface tests for the company custom-logo capability.

Proves the REST endpoints are a thin transport over the SAME fail-closed kernel
gate the CLI uses (zero divergence, 铁律2): the sniffed magic bytes are
authoritative, oversized/empty/spoofed uploads are rejected with the right HTTP
status, the serve endpoint is ungated (so a Web <img> can render it) yet leaks
no enumeration oracle, and the contract re-exports the kernel limits verbatim.
"""

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.company_logo import (
    COMPANY_LOGO_ERROR_CODES,
    COMPANY_LOGO_MAX_BYTES,
    COMPANY_LOGO_MIME_TYPES,
)
from superclaw.models import CompanyProfile
from superclaw.state import StateStore
from superclaw.ui_contracts import build_company_logo_contract

# Minimal blobs whose LEADING magic bytes are what the kernel sniffs.
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
_JPEG = b"\xff\xd8\xff" + b"\x00" * 64
_NOT_AN_IMAGE = b"GIF89a" + b"\x00" * 64  # real magic, but an unsupported format


def _client(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.save_company_profile(
        CompanyProfile(name="Acme", company_profile_id="company_acme", goal="Ship.")
    )
    return TestClient(create_app(state_path=tmp_path / "state.db")), store


def _png(client, company="company_acme", *, headers=None):
    h = {"Content-Type": "image/png"}
    if headers:
        h.update(headers)
    return client.post(f"/api/companies/{company}/logo", content=_PNG, headers=h)


def test_upload_then_serve_roundtrip(tmp_path):
    client, store = _client(tmp_path)
    r = _png(client)
    assert r.status_code == 200, r.text
    # The mutation is reflected in the persisted profile, not just echoed.
    assert r.json()["logo"].endswith(".png")
    assert store.get_company_profile("company_acme").logo.endswith(".png")

    served = client.get("/api/companies/company_acme/logo")
    assert served.status_code == 200, served.text
    assert served.headers["content-type"].startswith("image/png")
    assert served.headers["x-content-type-options"] == "nosniff"
    assert served.content == _PNG


def test_serve_unset_is_404(tmp_path):
    client, _ = _client(tmp_path)
    assert client.get("/api/companies/company_acme/logo").status_code == 404


def test_clear_logo_reverts_to_404(tmp_path):
    client, _ = _client(tmp_path)
    assert _png(client).status_code == 200
    assert client.delete("/api/companies/company_acme/logo").status_code == 200
    assert client.get("/api/companies/company_acme/logo").status_code == 404
    # Idempotent: clearing again is still a clean 200.
    assert client.delete("/api/companies/company_acme/logo").status_code == 200


def test_replacing_logo_keeps_one_file(tmp_path):
    client, store = _client(tmp_path)
    assert _png(client).status_code == 200
    r = client.post(
        "/api/companies/company_acme/logo", content=_JPEG,
        headers={"Content-Type": "image/jpeg"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo"].endswith(".jpg")
    from superclaw.company_logo import company_logos_dir

    company_dir = company_logos_dir(store) / "company_acme"
    suffixes = sorted(p.suffix for p in company_dir.iterdir() if p.is_file())
    assert suffixes == [".jpg"]  # exactly one file; stale .png was dropped


def test_oversized_upload_is_413(tmp_path):
    client, _ = _client(tmp_path)
    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (COMPANY_LOGO_MAX_BYTES + 10)
    r = client.post(
        "/api/companies/company_acme/logo", content=big,
        headers={"Content-Type": "image/png"},
    )
    assert r.status_code == 413, r.text


def test_spoofed_content_type_is_415(tmp_path):
    """A lying Content-Type cannot smuggle a non-image: the sniffed bytes win."""
    client, _ = _client(tmp_path)
    r = client.post(
        "/api/companies/company_acme/logo", content=_NOT_AN_IMAGE,
        headers={"Content-Type": "image/png"},
    )
    assert r.status_code == 415, r.text


def test_empty_upload_is_400(tmp_path):
    client, _ = _client(tmp_path)
    r = client.post(
        "/api/companies/company_acme/logo", content=b"",
        headers={"Content-Type": "image/png"},
    )
    assert r.status_code == 400, r.text


def test_unknown_company_is_404(tmp_path):
    client, _ = _client(tmp_path)
    assert _png(client, company="nope").status_code == 404
    assert client.delete("/api/companies/nope/logo").status_code == 404
    # GET on an unknown company is the SAME 404 as an unset logo — no oracle.
    assert client.get("/api/companies/nope/logo").status_code == 404


def test_mutations_require_control_token_but_serve_does_not(tmp_path, monkeypatch):
    """POST/DELETE are gated when a control token is configured; GET stays
    ungated so a Web <img src> can load the logo (plugin-logo precedent)."""
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    client, _ = _client(tmp_path)
    assert _png(client).status_code in (401, 403)
    assert client.delete("/api/companies/company_acme/logo").status_code in (401, 403)

    headers = {"X-SuperClaw-Token": "secret-control"}
    assert _png(client, headers={**headers, "Content-Type": "image/png"}).status_code == 200
    # Serving needs no token even while one is configured.
    assert client.get("/api/companies/company_acme/logo").status_code == 200
    assert client.delete("/api/companies/company_acme/logo", headers=headers).status_code == 200


def test_contract_reexports_kernel_limits_verbatim(tmp_path):
    """铁律3: surfaces render FROM the contract; it must mirror the kernel's
    single source of truth, never a re-hardcoded copy."""
    c = build_company_logo_contract()
    assert c["max_bytes"] == COMPANY_LOGO_MAX_BYTES
    assert c["accepted_mime_types"] == list(COMPANY_LOGO_MIME_TYPES)
    assert c["error_codes"] == list(COMPANY_LOGO_ERROR_CODES)
    assert c["posture"]["svg_accepted"] is False
    assert c["posture"]["magic_byte_sniff_authoritative"] is True
    assert c["posture"]["excluded_from_export"] is True
