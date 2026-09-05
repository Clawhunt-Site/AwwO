"""Slice 2: the loopback bridge (export / freeze / preview_fn) to the co-launched Node.

The httpx boundary is faked, so these are pure in-process unit tests.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest

import superclaw.company_portability_loopback as mod
from superclaw.company_portability_loopback import (
    CompanyExportLoopbackError,
    export_company_portability,
    freeze_export_to_dir,
    make_preview_fn,
    resolve_node_base_url,
)
from superclaw.company_portability_review import CompanyPortabilityPreviewError


class _FakeResponse:
    def __init__(self, status_code: int, *, json_data=None, text: str = ""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        if self._json is None:
            import json as _json

            raise _json.JSONDecodeError("no json", "", 0)
        return self._json


class _FakeClient:
    def __init__(self, response=None, *, raise_exc=None, record=None):
        self._response = response
        self._raise = raise_exc
        self._record = record if record is not None else []

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def post(self, url, json=None):  # noqa: A002 - mirrors httpx.Client.post signature
        self._record.append((url, json))
        if self._raise is not None:
            raise self._raise
        return self._response


def _patch_client(monkeypatch, response=None, *, raise_exc=None, record=None):
    monkeypatch.setattr(mod, "_client", lambda base_url, timeout: _FakeClient(response, raise_exc=raise_exc, record=record))


# ---------------------------------------------------------------- resolve_node_base_url


def test_resolve_base_url_explicit_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(mod.NODE_BASE_URL_ENV, "http://127.0.0.1:9/")
    assert resolve_node_base_url("http://127.0.0.1:1/") == "http://127.0.0.1:1"


def test_resolve_base_url_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(mod.NODE_BASE_URL_ENV, "http://127.0.0.1:9/")
    assert resolve_node_base_url() == "http://127.0.0.1:9"


def test_resolve_base_url_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(mod.NODE_BASE_URL_ENV, raising=False)
    monkeypatch.setattr(mod, "read_node_base_url", lambda _run: "http://127.0.0.1:3100/")
    assert resolve_node_base_url() == "http://127.0.0.1:3100"


def test_resolve_base_url_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(mod.NODE_BASE_URL_ENV, raising=False)
    monkeypatch.setattr(mod, "read_node_base_url", lambda _run: None)
    assert resolve_node_base_url() is None


# ---------------------------------------------------------------- loopback enforcement


@pytest.mark.parametrize(
    "url,ok",
    [
        ("http://127.0.0.1:3100", True),
        ("http://localhost:3100", True),
        ("http://[::1]:3100", True),
        ("https://127.0.0.1", True),
        ("http://example.com", False),
        ("https://prod.internal:443", False),
        ("http://8.8.8.8", False),
        ("ftp://127.0.0.1", False),
        ("not a url", False),
    ],
)
def test_is_loopback_url(url: str, ok: bool) -> None:
    assert mod._is_loopback_url(url) is ok


def test_resolve_rejects_non_loopback_explicit() -> None:
    with pytest.raises(CompanyExportLoopbackError):
        resolve_node_base_url("https://prod.internal")


def test_resolve_rejects_non_loopback_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(mod.NODE_BASE_URL_ENV, "https://prod.internal")
    with pytest.raises(CompanyExportLoopbackError):
        resolve_node_base_url()


def test_resolve_rejects_non_loopback_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(mod.NODE_BASE_URL_ENV, raising=False)
    monkeypatch.setattr(mod, "read_node_base_url", lambda _run: "https://prod.internal")
    with pytest.raises(CompanyExportLoopbackError):
        resolve_node_base_url()


def test_real_client_rejects_non_loopback() -> None:
    # the REAL _client (not the test fake) must refuse a non-loopback target
    with pytest.raises(CompanyExportLoopbackError):
        mod._client("http://example.com", 1.0)


@pytest.mark.parametrize("bad_id", ["a/b", " x", "x ", "a\x00b", ""])
def test_export_invalid_company_id(monkeypatch: pytest.MonkeyPatch, bad_id: str) -> None:
    _patch_client(monkeypatch, _FakeResponse(200, json_data={"files": {"COMPANY.md": "x"}}))
    with pytest.raises(CompanyExportLoopbackError):
        export_company_portability(bad_id, base_url="http://127.0.0.1")


# ---------------------------------------------------------------- export


def test_export_success(monkeypatch: pytest.MonkeyPatch) -> None:
    rec: list = []
    _patch_client(monkeypatch, _FakeResponse(200, json_data={"files": {"COMPANY.md": "x"}}), record=rec)
    out = export_company_portability("co_1", base_url="http://n")
    assert out["files"]["COMPANY.md"] == "x"
    assert rec[0][0] == "/api/companies/co_1/export"


def test_export_non_200(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeResponse(403, text="forbidden"))
    with pytest.raises(CompanyExportLoopbackError):
        export_company_portability("co_1", base_url="http://n")


def test_export_non_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeResponse(200, json_data=None))
    with pytest.raises(CompanyExportLoopbackError):
        export_company_portability("co_1", base_url="http://n")


def test_export_transport_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    _patch_client(monkeypatch, raise_exc=httpx.ConnectError("refused"))
    with pytest.raises(CompanyExportLoopbackError):
        export_company_portability("co_1", base_url="http://n")


def test_export_non_object_body(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeResponse(200, json_data=["not", "an", "object"]))
    with pytest.raises(CompanyExportLoopbackError):
        export_company_portability("co_1", base_url="http://n")


# ---------------------------------------------------------------- freeze


def test_freeze_writes_text_and_binary(tmp_path: Path) -> None:
    export = {
        "files": {
            "COMPANY.md": "hello",
            "assets/logo.png": {"encoding": "base64", "data": base64.b64encode(b"\x89PNG").decode("ascii")},
        },
        "manifest": {"generatedAt": "2026-01-01"},  # must NOT be written into the bundle
        "warnings": ["something"],
    }
    out = freeze_export_to_dir(export, tmp_path / "bundle")
    assert (out / "COMPANY.md").read_text(encoding="utf-8") == "hello"
    assert (out / "assets/logo.png").read_bytes() == b"\x89PNG"
    assert not (out / "manifest.json").exists()  # envelope excluded


def test_freeze_rejects_empty(tmp_path: Path) -> None:
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {}}, tmp_path / "b")


@pytest.mark.parametrize(
    "bad",
    [
        "../escape.md",
        "/abs.md",
        "a/../../escape",
        "a/../b.md",  # contained traversal must still be rejected, not collapsed
        "a/./b.md",
        "a\\b.md",  # backslash
        " leading.md",
        "trailing.md ",
        "nul\x00.md",
        "a//b.md",  # empty segment
    ],
)
def test_freeze_rejects_unsafe_paths(tmp_path: Path, bad: str) -> None:
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {bad: "x"}}, tmp_path / "b")


def test_freeze_rejects_non_empty_dest(tmp_path: Path) -> None:
    dest = tmp_path / "b"
    dest.mkdir()
    (dest / "stale.txt").write_text("old", encoding="utf-8")
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"COMPANY.md": "x"}}, dest)


def test_freeze_bounds_too_many_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import superclaw.company_portability_review as review

    monkeypatch.setattr(review, "MAX_PORTABILITY_FILES", 1)
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"COMPANY.md": "x", "b.md": "y"}}, tmp_path / "b")


def test_freeze_bounds_too_large(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import superclaw.company_portability_review as review

    monkeypatch.setattr(review, "MAX_PORTABILITY_BYTES", 4)
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"COMPANY.md": "way too long"}}, tmp_path / "b")


def test_freeze_rejects_unsupported_entry(tmp_path: Path) -> None:
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"COMPANY.md": {"encoding": "gzip", "data": "x"}}}, tmp_path / "b")


def test_freeze_rejects_bad_base64(tmp_path: Path) -> None:
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"x.bin": {"encoding": "base64", "data": "!!!notbase64!!!"}}}, tmp_path / "b")


# ---------------------------------------------------------------- preview_fn


def test_preview_fn_success(monkeypatch: pytest.MonkeyPatch) -> None:
    rec: list = []
    _patch_client(monkeypatch, _FakeResponse(200, json_data={"errors": [], "warnings": [], "plan": {}}), record=rec)
    fn = make_preview_fn("http://n")
    out = fn({"source": {"type": "inline", "files": {}}, "target": {"mode": "new_company"}})
    assert out["errors"] == []
    assert rec[0][0] == "/api/companies/import/preview"


def test_preview_fn_500_wraps_preview_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # a 5xx is an infra failure → raise (gate fails closed as "unavailable")
    _patch_client(monkeypatch, _FakeResponse(500, text="boom"))
    fn = make_preview_fn("http://n")
    with pytest.raises(CompanyPortabilityPreviewError):
        fn({})


def test_preview_fn_400_is_business_rejection(monkeypatch: pytest.MonkeyPatch) -> None:
    # a 400 is a clean bundle rejection → return Node's reason as a preview error (not infra)
    _patch_client(monkeypatch, _FakeResponse(400, json_data={"error": "Company package is missing COMPANY.md"}))
    fn = make_preview_fn("http://n")
    out = fn({})
    assert out["warnings"] == []
    assert out["errors"] and "COMPANY.md" in out["errors"][0]


def test_preview_fn_400_non_json_falls_back_to_text(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeResponse(400, json_data=None, text="bad request"))
    fn = make_preview_fn("http://n")
    out = fn({})
    assert out["errors"] and "bad request" in out["errors"][0]


def test_preview_fn_422_unprocessable_is_business_rejection(monkeypatch: pytest.MonkeyPatch) -> None:
    # Node's `unprocessable(...)` is HTTP 422 — a bad bundle, not infra. Must be a business
    # rejection (errors), not a raised "unavailable".
    _patch_client(monkeypatch, _FakeResponse(422, json_data={"error": "Import preview has errors: bad agent"}))
    fn = make_preview_fn("http://n")
    out = fn({})
    assert out["errors"] and "bad agent" in out["errors"][0]


def test_preview_fn_403_still_raises_as_infra(monkeypatch: pytest.MonkeyPatch) -> None:
    # an access/auth status is NOT a bundle business-rejection → raise (gate fails closed)
    _patch_client(monkeypatch, _FakeResponse(403, text="forbidden"))
    fn = make_preview_fn("http://n")
    with pytest.raises(CompanyPortabilityPreviewError):
        fn({})


def test_preview_fn_transport_wraps_preview_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    _patch_client(monkeypatch, raise_exc=httpx.ConnectError("refused"))
    fn = make_preview_fn("http://n")
    with pytest.raises(CompanyPortabilityPreviewError):
        fn({})


def test_preview_fn_non_json_wraps_preview_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeResponse(200, json_data=None))
    fn = make_preview_fn("http://n")
    with pytest.raises(CompanyPortabilityPreviewError):
        fn({})


def test_preview_fn_non_loopback_wraps_preview_error() -> None:
    # the real _client (not faked) raises CompanyExportLoopbackError; make_preview_fn must
    # surface it as CompanyPortabilityPreviewError so the review gate fails closed.
    fn = make_preview_fn("http://example.com")
    with pytest.raises(CompanyPortabilityPreviewError):
        fn({"source": {"type": "inline", "files": {}}, "target": {"mode": "new_company"}})


def test_freeze_rejects_symlink_dest(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(CompanyExportLoopbackError):
        freeze_export_to_dir({"files": {"COMPANY.md": "x"}}, link)
