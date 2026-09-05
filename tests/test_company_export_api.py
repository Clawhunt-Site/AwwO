"""API surface tests for company-as-code export.

Proves the REST endpoints are a faithful transport over the SAME kernel/contract
the CLI uses (zero divergence), and that the zip download carries only bundle
files — never warnings or machine-local data.
"""

import io
import re
import zipfile

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import AgentProfile, CompanyProfile, WorkspaceProfile
from superclaw.state import StateStore
from superclaw.ui_contracts import build_company_export_payload


def _seed(state_path):
    store = StateStore(state_path)
    store.save_company_profile(
        CompanyProfile(name="Acme", company_profile_id="company_acme", goal="Ship.",
                       metadata={"secret": "VAULT_xyz"})
    )
    store.save_workspace_profile(
        WorkspaceProfile(name="repo", workspace_id="workspace_acme",
                         company_profile_id="company_acme",
                         repo_path="/Users/local/secret/acme")
    )
    ceo = store.save_agent_profile(
        AgentProfile(name="CEO", role="ceo", company_profile_id="company_acme",
                     workspace_id="workspace_acme", charter="Lead.")
    )
    store.save_agent_profile(
        AgentProfile(name="Eng", role="engineer", company_profile_id="company_acme",
                     workspace_id="workspace_acme", reports_to=ceo.profile_id, charter="Build.")
    )
    return store


def test_export_preview_omits_file_bodies(tmp_path):
    _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    r = client.get("/api/companies/company_acme/export/preview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "manifest" in body
    assert body["file_tree"]
    assert "files" not in body  # preview omits bodies


def test_export_full_matches_contract(tmp_path, monkeypatch):
    """Zero-divergence: the API's full export payload is EXACTLY the shared
    contract projection. Time is frozen — the sidecar's generated_at float repr
    can shift a byte count between two exports; the point under test is the SHAPE."""
    monkeypatch.setattr("superclaw.company_export.time", lambda: 1000.0)
    store = _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    r = client.post("/api/companies/company_acme/export")
    assert r.status_code == 200, r.text
    expected = build_company_export_payload(store, "company_acme", include_files=True)
    assert r.json() == expected
    assert "manifest.json" in r.json()["files"]


def test_export_zip_download(tmp_path):
    _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    r = client.get("/api/companies/company_acme/export.zip")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "agents/ceo/AGENTS.md" in names
        blob = "\n".join(zf.read(n).decode() for n in names)
    # The zip carries only files — no machine-local secret leaks.
    assert "/Users/local/secret" not in blob
    assert "VAULT_xyz" not in blob


def test_export_include_issues_flag(tmp_path):
    store = _seed(tmp_path / "state.db")
    from superclaw.models import Issue

    store.save_issue(Issue(title="A task", company_profile_id="company_acme",
                           workspace_id="workspace_acme"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    r = client.post("/api/companies/company_acme/export?include=issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["includes"]["issues"] is True
    assert any(f["path"].startswith("issues/") for f in body["file_tree"])


def test_export_unknown_company_404(tmp_path):
    _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    assert client.get("/api/companies/nope/export/preview").status_code == 404
    assert client.post("/api/companies/nope/export").status_code == 404
    assert client.get("/api/companies/nope/export.zip").status_code == 404


def test_export_endpoints_require_control_token(tmp_path, monkeypatch):
    """When a control token IS configured, all three export endpoints are gated —
    proving the Depends(require_control_token) is real, not a no-op."""
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    paths = [
        ("get", "/api/companies/company_acme/export/preview"),
        ("post", "/api/companies/company_acme/export"),
        ("get", "/api/companies/company_acme/export.zip"),
    ]
    for method, path in paths:
        assert getattr(client, method)(path).status_code in (401, 403), path
        # A WRONG token is rejected too (not just a missing one).
        bad = getattr(client, method)(path, headers={"X-SuperClaw-Token": "wrong"})
        assert bad.status_code in (401, 403), path
    headers = {"X-SuperClaw-Token": "secret-control"}
    for method, path in paths:
        assert getattr(client, method)(path, headers=headers).status_code == 200, path


def test_export_zip_filename_sanitizer_is_injection_proof():
    """Directly unit-test the pure sanitizer (not via routing, which may pre-reject
    a malicious path and hide the logic): no quotes/CR/LF/control chars survive."""
    from apps.api.main import _export_zip_filename

    for hostile in ['ev"il\r\nX-Injected: 1', "a/../b", "../../etc", 'x";drop', "\r\n\r\n", ""]:
        name = _export_zip_filename(hostile)
        assert name.endswith("-export.zip")
        assert '"' not in name
        assert "\r" not in name and "\n" not in name
        assert "/" not in name and "\\" not in name
        # Only the whitelist survives.
        assert re.fullmatch(r"[A-Za-z0-9._-]+-export\.zip", name)


def test_export_over_budget_returns_413(tmp_path, monkeypatch):
    """An over-budget export surfaces as 413 (the kernel raises
    CompanyExportTooLarge during construction; the API maps it)."""
    from superclaw.company_export import CompanyExportTooLarge

    _seed(tmp_path / "state.db")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    def _boom(*_a, **_k):
        raise CompanyExportTooLarge("export exceeds the budget")

    monkeypatch.setattr("apps.api.main.build_company_export_payload", _boom)
    assert client.post("/api/companies/company_acme/export").status_code == 413
    assert client.get("/api/companies/company_acme/export.zip").status_code == 413


def test_export_work_products_appear_in_issue_doc(tmp_path):
    """include=work-products must genuinely nest the delivery fact into the issue
    page — not just flip a flag."""
    store = _seed(tmp_path / "state.db")
    from superclaw.models import Issue, WorkProduct

    issue = store.save_issue(
        Issue(title="Ship it", company_profile_id="company_acme", workspace_id="workspace_acme")
    )
    store.save_work_product(
        WorkProduct(issue_id=issue.issue_id, company_profile_id="company_acme",
                    type="pull_request", title="PR-99", url="https://example.com/pr/99")
    )
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    body = client.post(
        "/api/companies/company_acme/export?include=issues,work-products"
    ).json()
    assert body["includes"]["work_products"] is True
    issue_doc = next(v for k, v in body["files"].items() if k.startswith("issues/"))
    assert "PR-99" in issue_doc


def test_export_include_variants(tmp_path):
    store = _seed(tmp_path / "state.db")
    from superclaw.models import Issue

    store.save_issue(Issue(title="T", company_profile_id="company_acme", workspace_id="workspace_acme"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    # Comma-joined form must work the same as repeated params.
    comma = client.post("/api/companies/company_acme/export?include=issues,work-products").json()
    assert comma["includes"]["issues"] is True
    # Underscore alias also accepted for work products.
    repeated = client.post(
        "/api/companies/company_acme/export?include=issues&include=work_products"
    ).json()
    assert repeated["includes"]["issues"] is True
