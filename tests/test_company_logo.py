"""Tests for company custom-logo storage (core harness).

Exercises the single fail-closed gate ``set_company_logo`` (size / magic-byte /
existence), resolution with path-traversal defence, clearing, and persistence
round-trip — all against a real :class:`StateStore` on ``tmp_path``.
"""

from __future__ import annotations

import json

import pytest

from superclaw.company_logo import (
    COMPANY_LOGO_MAX_BYTES,
    CompanyLogoError,
    clear_company_logo,
    company_logos_dir,
    resolve_company_logo,
    set_company_logo,
)
from superclaw.models import CompanyProfile
from superclaw.state import StateStore

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 16


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


@pytest.fixture
def company(store):
    return store.save_company_profile(CompanyProfile(name="Acme"))


def test_set_and_resolve_roundtrip(store, company):
    profile = set_company_logo(store, company.company_profile_id, PNG)
    # Reference is "<company-id>/<unique>.png" (per-company subdir, unique name).
    assert profile.logo.startswith(f"{company.company_profile_id}/")
    assert profile.logo.endswith(".png")

    resolved = resolve_company_logo(store, company.company_profile_id)
    assert resolved is not None
    path, mime = resolved
    assert mime == "image/png"
    assert path.read_bytes() == PNG


def test_set_replaces_prior_logo_across_extensions(store, company):
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    set_company_logo(store, cid, JPEG)

    company_dir = company_logos_dir(store) / cid
    files = sorted(p.suffix for p in company_dir.iterdir() if p.is_file())
    assert files == [".jpg"]  # exactly one file; stale .png dropped
    resolved = resolve_company_logo(store, cid)
    assert resolved is not None and resolved[1] == "image/jpeg"


def test_webp_accepted(store, company):
    profile = set_company_logo(store, company.company_profile_id, WEBP)
    assert profile.logo.endswith(".webp")


def test_clear_removes_file_and_reference(store, company):
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    profile = clear_company_logo(store, cid)
    assert profile.logo == ""
    assert resolve_company_logo(store, cid) is None
    company_dir = company_logos_dir(store) / cid
    assert not company_dir.is_dir() or not any(p.is_file() for p in company_dir.iterdir())


def test_clear_is_idempotent_without_logo(store, company):
    profile = clear_company_logo(store, company.company_profile_id)
    assert profile.logo == ""


def test_reject_empty(store, company):
    with pytest.raises(CompanyLogoError) as exc:
        set_company_logo(store, company.company_profile_id, b"")
    assert exc.value.code == "empty"


def test_reject_too_large(store, company):
    oversized = PNG + b"\x00" * (COMPANY_LOGO_MAX_BYTES + 1)
    with pytest.raises(CompanyLogoError) as exc:
        set_company_logo(store, company.company_profile_id, oversized)
    assert exc.value.code == "too_large"


def test_reject_bad_magic_bytes(store, company):
    # Looks like text / a GIF — no accepted signature → fail-closed.
    with pytest.raises(CompanyLogoError) as exc:
        set_company_logo(store, company.company_profile_id, b"GIF89a not an image")
    assert exc.value.code == "unsupported_type"


def test_set_unknown_company_raises(store):
    with pytest.raises(KeyError):
        set_company_logo(store, "company_does_not_exist", PNG)


def test_resolve_unknown_company_returns_none(store):
    assert resolve_company_logo(store, "company_does_not_exist") is None


def test_resolve_none_when_no_logo(store, company):
    assert resolve_company_logo(store, company.company_profile_id) is None


def test_persistence_roundtrip_across_store_instances(store, company, tmp_path):
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    # Fresh store over the same db file: the logo reference survives.
    reopened = StateStore(tmp_path / "state.db")
    ref = reopened.get_company_profile(cid).logo
    assert ref.startswith(f"{cid}/") and ref.endswith(".png")


def test_legacy_profile_without_logo_field_loads_empty(store):
    # Simulate a row persisted before the ``logo`` field existed.
    payload = CompanyProfile(name="Legacy").to_dict()
    payload.pop("logo")
    with store._connect() as conn:  # noqa: SLF001 — test reaches into persistence
        conn.execute(
            "INSERT OR REPLACE INTO company_profiles(company_profile_id, payload) VALUES(?, ?)",
            ("company_legacy", json.dumps(payload, ensure_ascii=False)),
        )
    profile = store.get_company_profile("company_legacy")
    assert profile.logo == ""


def test_resolve_blocks_path_traversal(store, company):
    # A tampered reference must never escape the logos dir.
    cid = company.company_profile_id
    profile = store.get_company_profile(cid)
    profile.logo = "../../etc/passwd"
    store.save_company_profile(profile)
    assert resolve_company_logo(store, cid) is None


def test_resolve_blocks_sibling_company_escape(store):
    """A tampered reference into ANOTHER company's subdir must not resolve — no
    cross-company logo read via a swapped pointer."""
    store.save_company_profile(CompanyProfile(name="A", company_profile_id="company_a"))
    store.save_company_profile(CompanyProfile(name="B", company_profile_id="company_b"))
    set_company_logo(store, "company_b", PNG)
    b_ref = store.get_company_profile("company_b").logo  # "company_b/<file>"
    pa = store.get_company_profile("company_a")
    pa.logo = b_ref  # point A at B's file
    store.save_company_profile(pa)
    assert resolve_company_logo(store, "company_a") is None


def test_set_failure_keeps_prior_logo(store, company, monkeypatch):
    """If the DB save fails mid-replace, the prior logo stays fully readable
    (fail-closed) — the new file never takes effect via a swapped pointer."""
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    first_ref = store.get_company_profile(cid).logo

    def boom(_profile):
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(store, "save_company_profile", boom)
    with pytest.raises(RuntimeError):
        set_company_logo(store, cid, JPEG)
    monkeypatch.undo()
    # Prior PNG logo unchanged and still served (the JPEG never committed).
    assert store.get_company_profile(cid).logo == first_ref
    resolved = resolve_company_logo(store, cid)
    assert resolved is not None and resolved[1] == "image/png"


def test_membership_step_failure_never_dangles(store, company, monkeypatch):
    """The store's save is not a single transaction (profile row, then a
    separate membership step). Even if that second step fails AFTER the profile
    row committed, the invariant holds: whatever the DB references has a file on
    disk — never a dangling pointer / 404 (we never unlink on the error path)."""
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)

    def boom(*_a, **_k):
        raise RuntimeError("membership boom")

    monkeypatch.setattr(store, "ensure_company_membership", boom)
    with pytest.raises(RuntimeError):
        set_company_logo(store, cid, JPEG)
    monkeypatch.undo()
    # Whichever step failed, the DB pointer (if any) still resolves to a real file.
    if store.get_company_profile(cid).logo:
        assert resolve_company_logo(store, cid) is not None


def test_set_deletes_only_its_own_predecessor(store, company):
    """A replace removes ONLY the prior file it referenced — never another file
    in the dir (e.g. one a concurrent set just wrote). This is what keeps a
    racing set's committed logo from being deleted (no 404)."""
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    company_dir = company_logos_dir(store) / cid
    intruder = company_dir / "logo.concurrent.webp"
    intruder.write_bytes(WEBP)  # stand-in for a concurrent op's freshly-written file
    set_company_logo(store, cid, JPEG)  # replaces the PNG
    assert intruder.exists()  # the foreign file is untouched


def test_clear_deletes_only_referenced_file(store, company):
    """Clear removes ONLY the file it dereferenced — a concurrent set's file is
    left intact so its committed logo never dangles."""
    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    company_dir = company_logos_dir(store) / cid
    intruder = company_dir / "logo.concurrent.webp"
    intruder.write_bytes(WEBP)
    clear_company_logo(store, cid)
    assert intruder.exists()


def test_replace_does_not_delete_other_company_logo(store):
    """Regression: the stale-file sweep is scoped to the company's own subdir,
    so replacing company ``ab``'s logo must never touch ``ab.cd``'s file even
    though one id is a dotted prefix of the other."""
    a = store.save_company_profile(CompanyProfile(name="A", company_profile_id="ab"))
    b = store.save_company_profile(CompanyProfile(name="B", company_profile_id="ab.cd"))
    set_company_logo(store, a.company_profile_id, PNG)
    set_company_logo(store, b.company_profile_id, PNG)
    bref = store.get_company_profile("ab.cd").logo
    # Replace A's logo with a different format (forces the stale-sweep path).
    set_company_logo(store, a.company_profile_id, JPEG)
    # B's logo must survive untouched (reference and file).
    assert resolve_company_logo(store, "ab.cd") is not None
    assert store.get_company_profile("ab.cd").logo == bref


def test_invalid_company_id_for_logo_path_is_rejected(store):
    """A company id carrying a path separator must fail closed, not write into
    a subdirectory of the logo dir."""
    store.save_company_profile(CompanyProfile(name="Evil", company_profile_id="a/b"))
    with pytest.raises(CompanyLogoError) as exc:
        set_company_logo(store, "a/b", PNG)
    assert exc.value.code == "unsupported_type"


def test_logo_is_excluded_from_company_as_code_export(store, company):
    """铁律: a logo is an instance-level visual asset and must NEVER appear in
    the company-as-code export bundle — neither its filename nor its bytes."""
    from superclaw.ui_contracts import build_company_export_payload

    cid = company.company_profile_id
    set_company_logo(store, cid, PNG)
    logo_name = store.get_company_profile(cid).logo
    assert logo_name  # sanity: a logo really is set

    payload = build_company_export_payload(store, cid, include_files=True)
    blob = json.dumps(payload, ensure_ascii=False)
    # The logo filename never leaks into manifest/roster/file tree.
    assert logo_name not in blob
    assert "company-logos" not in blob
    # No bundle file path or body carries the logo or its image bytes.
    for path, content in (payload.get("files") or {}).items():
        assert "logo" not in path.lower()
        body = content if isinstance(content, bytes) else str(content).encode()
        assert PNG not in body
