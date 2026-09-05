"""Slice 1: the local review gate for Paperclip CompanyPortability company bundles.

These are pure, in-process unit tests — the Node ``previewImport`` boundary is injected as
a fake ``preview_fn`` so the gate is testable without a live server and immune to load.
Coverage is adversarial (digest collision, limit short-circuit, symlink-before-read,
malformed preview, missing identity, large-text secret), not just branch coverage.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest

import superclaw.company_portability_review as mod
from superclaw.company_portability_review import (
    CompanyPortabilityPreviewError,
    build_portability_inline_files,
    compute_portability_digest,
    find_company_md,
    is_company_portability_bundle,
    review_company_portability_bundle,
)

# A real secret pattern recognised by superclaw.secrets_scan.contains_secret.
_SECRET_LINE = "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEABCD1234567890abcdEF\n"


def _ok_preview(_request: dict) -> dict:
    """A fake Node preview that approves a one-agent new company."""
    return {
        "errors": [],
        "warnings": [],
        "plan": {"companyAction": "create", "agentPlans": [{"slug": "ceo", "action": "create"}]},
    }


def _make_bundle(root: Path, *, nested: str | None = None, agents: int = 1) -> Path:
    base = root / nested if nested else root
    base.mkdir(parents=True, exist_ok=True)
    (base / "COMPANY.md").write_text("---\nname: Acme\n---\nAcme corp.\n", encoding="utf-8")
    agents_dir = base / "agents"
    agents_dir.mkdir(exist_ok=True)
    for i in range(agents):
        (agents_dir / f"agent-{i}.md").write_text(f"---\nname: Agent {i}\n---\n", encoding="utf-8")
    return root


def _gate(record: dict, name: str) -> dict:
    matches = [g for g in record["gates"] if g["name"] == name]
    assert matches, f"gate {name!r} not in {[g['name'] for g in record['gates']]}"
    return matches[0]


def _has_gate(record: dict, name: str) -> bool:
    return any(g["name"] == name for g in record["gates"])


# ---------------------------------------------------------------- recognition


def test_find_company_md_at_root(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    found = find_company_md(tmp_path)
    assert found is not None and found.name == "COMPANY.md"


def test_find_company_md_nested_under_rootpath(tmp_path: Path) -> None:
    _make_bundle(tmp_path, nested="acme-corp")
    found = find_company_md(tmp_path)
    assert found is not None and found.parent.name == "acme-corp"


def test_find_company_md_deeper_than_one_level(tmp_path: Path) -> None:
    _make_bundle(tmp_path, nested="export/acme-corp")
    found = find_company_md(tmp_path)
    assert found is not None  # arbitrary depth, mirrors Node endsWith("/COMPANY.md")


def test_is_company_portability_bundle_true_false(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    assert is_company_portability_bundle(tmp_path) is True
    empty = tmp_path / "empty"
    empty.mkdir()
    assert is_company_portability_bundle(empty) is False


# ---------------------------------------------------------------- happy path


def test_clean_bundle_all_gates_pass(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path, preview_fn=_ok_preview, capability_id="acme-corp", version="1.0.0"
    )
    assert rec["company_source_format"] == "portability"
    assert rec["capability_id"] == "acme-corp"
    assert rec["package_digest"].startswith("sha256:")
    assert all(g["passed"] for g in rec["gates"]), [g for g in rec["gates"] if not g["passed"]]


def test_inline_files_shape_sent_to_preview(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    captured: dict = {}

    def capture(request: dict) -> dict:
        captured.update(request)
        return _ok_preview(request)

    review_company_portability_bundle(tmp_path, preview_fn=capture, capability_id="x", version="1.0.0")
    assert captured["source"]["type"] == "inline"
    assert captured["target"] == {"mode": "new_company"}
    assert "COMPANY.md" in captured["source"]["files"]
    assert isinstance(captured["source"]["files"]["COMPANY.md"], str)


# ---------------------------------------------------------------- identity gate


def test_missing_identity_fails(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview)
    assert _gate(rec, "company_publish_identity")["passed"] is False


def test_bad_semver_fails_identity(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="v1")
    assert _gate(rec, "company_publish_identity")["passed"] is False


# ---------------------------------------------------------------- symlink pre-scan (fail-closed, no follow)


def test_review_rejects_symlink_and_short_circuits(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    _make_bundle(bundle)
    outside = tmp_path / "secret.txt"
    outside.write_text(_SECRET_LINE, encoding="utf-8")
    try:
        os.symlink(outside, bundle / "link.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    rec = review_company_portability_bundle(bundle, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_no_symlink")["passed"] is False
    # short-circuited: never reached secret scan / preview / digest (never followed the link)
    assert not _has_gate(rec, "company_portability_preview")
    assert rec["package_digest"] is None


# ---------------------------------------------------------------- structure gate


def test_missing_company_md_fails_structure(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("not a company", encoding="utf-8")
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_structure")["passed"] is False


def test_binary_company_md_fails_structure(tmp_path: Path) -> None:
    (tmp_path / "COMPANY.md").write_bytes(b"\x00\x01\x02\xff\xfe")
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_structure")["passed"] is False


# ---------------------------------------------------------------- preview gate (fail-closed)


def test_no_preview_fn_fails_closed(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(tmp_path, preview_fn=None, capability_id="x", version="1.0.0")
    gate = _gate(rec, "company_portability_preview")
    assert gate["passed"] is False
    assert "fail-closed" in gate["detail"]


def test_preview_errors_block(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda _r: {
            "errors": ["bad manifest"],
            "warnings": [],
            "plan": {"companyAction": "create", "agentPlans": [{"slug": "ceo"}]},
        },
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_preview")["passed"] is False


def test_preview_warnings_block_official(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda _r: {
            "errors": [],
            "warnings": ["skipped a terminated agent"],
            "plan": {"companyAction": "create", "agentPlans": [{"slug": "ceo"}]},
        },
        capability_id="x",
        version="1.0.0",
    )
    gate = _gate(rec, "company_portability_preview")
    assert gate["passed"] is False
    assert "warning" in gate["detail"].lower()


def test_preview_non_create_action_fails(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda _r: {
            "errors": [],
            "warnings": [],
            "plan": {"companyAction": "update", "agentPlans": [{"slug": "ceo"}]},
        },
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_preview")["passed"] is False


def test_preview_zero_agents_fails(tmp_path: Path) -> None:
    _make_bundle(tmp_path, agents=0)
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda _r: {"errors": [], "warnings": [], "plan": {"companyAction": "create", "agentPlans": []}},
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_preview")["passed"] is False


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        "nope",
        {"errors": {}, "warnings": [], "plan": {}},  # errors not a list
        {"errors": [], "warnings": [], "plan": {"companyAction": "create", "agentPlans": {"a": 1}}},  # agentPlans dict
    ],
)
def test_malformed_preview_response_rejected(tmp_path: Path, bad) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path, preview_fn=lambda _r, b=bad: b, capability_id="x", version="1.0.0"
    )
    assert _gate(rec, "company_portability_preview")["passed"] is False


def test_preview_transport_failure_is_caught(tmp_path: Path) -> None:
    _make_bundle(tmp_path)

    def boom(_request: dict) -> dict:
        raise CompanyPortabilityPreviewError("loopback connection refused")

    rec = review_company_portability_bundle(tmp_path, preview_fn=boom, capability_id="x", version="1.0.0")
    gate = _gate(rec, "company_portability_preview")
    assert gate["passed"] is False
    assert "unavailable" in gate["detail"]


# ---------------------------------------------------------------- secret scan + limits


def test_secret_in_bundle_fails_scan(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    (tmp_path / "config.env").write_text(_SECRET_LINE, encoding="utf-8")
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_secret_scan")["passed"] is False


def test_large_text_secret_is_caught(tmp_path: Path) -> None:
    # >2MB text file: the legacy reused scanner skipped these; the hardened streaming scan must not.
    _make_bundle(tmp_path)
    big = "x" * (2 * 1024 * 1024 + 10) + "\n" + _SECRET_LINE
    (tmp_path / "big.txt").write_text(big, encoding="utf-8")
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_secret_scan")["passed"] is False


def test_too_many_files_fails_limits_and_skips_preview(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mod, "MAX_PORTABILITY_FILES", 3)
    _make_bundle(tmp_path, agents=10)
    called: list = []
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda r: called.append(r) or _ok_preview(r),
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_limits")["passed"] is False
    assert called == []  # short-circuited: preview never invoked on an over-budget bundle
    assert not _has_gate(rec, "company_portability_preview")
    assert rec["package_digest"] is None


def test_too_large_fails_limits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "MAX_PORTABILITY_BYTES", 16)
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_limits")["passed"] is False


# ---------------------------------------------------------------- digest stability + collision


def test_digest_deterministic_for_identical_content(tmp_path: Path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    _make_bundle(a)
    _make_bundle(b)
    assert compute_portability_digest(a) == compute_portability_digest(b)


def test_digest_changes_with_content(tmp_path: Path) -> None:
    a = tmp_path / "a"
    _make_bundle(a)
    before = compute_portability_digest(a)
    (a / "COMPANY.md").write_text("---\nname: Acme\n---\nchanged\n", encoding="utf-8")
    assert compute_portability_digest(a) != before


def test_digest_no_collision_across_framings(tmp_path: Path) -> None:
    # Under a naive `rel + NUL + data + NUL` framing these collide; length-prefixing must not.
    a = tmp_path / "a"
    a.mkdir()
    (a / "x").write_bytes(b"P")
    (a / "y").write_bytes(b"Q")
    b = tmp_path / "b"
    b.mkdir()
    (b / "x").write_bytes(b"P\x00y\x00Q")
    assert compute_portability_digest(a) != compute_portability_digest(b)


# ---------------------------------------------------------------- inline builder


def test_inline_builder_text_and_binary(tmp_path: Path) -> None:
    (tmp_path / "COMPANY.md").write_text("hello", encoding="utf-8")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\x00\x01\x02")
    files = build_portability_inline_files(tmp_path)
    assert files["COMPANY.md"] == "hello"
    entry = files["logo.png"]
    assert entry["encoding"] == "base64"
    assert base64.b64decode(entry["data"]) == b"\x89PNG\x00\x01\x02"


def _review_recording(bundle: Path, **kw) -> tuple[dict, list]:
    """Run the review with a preview_fn that records every call, so a test can prove the
    early-gate short-circuit never reached (and never sent the bundle to) the Node preview."""
    called: list = []
    rec = review_company_portability_bundle(
        bundle, preview_fn=lambda r: called.append(r) or _ok_preview(r), **kw
    )
    return rec, called


def test_bad_identity_short_circuits_before_preview(tmp_path: Path) -> None:
    rec, called = _review_recording(_make_bundle(tmp_path), capability_id="Bad Id", version="1.0.0")
    assert _gate(rec, "company_publish_identity")["passed"] is False
    assert called == [] and not _has_gate(rec, "company_portability_preview") and rec["package_digest"] is None


def test_bad_semver_short_circuits_before_preview(tmp_path: Path) -> None:
    rec, called = _review_recording(_make_bundle(tmp_path), capability_id="acme", version="1.0")
    assert _gate(rec, "company_publish_identity")["passed"] is False
    assert called == [] and not _has_gate(rec, "company_portability_preview") and rec["package_digest"] is None


def test_missing_company_md_short_circuits_before_preview(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("not a company", encoding="utf-8")
    rec, called = _review_recording(tmp_path, capability_id="acme", version="1.0.0")
    assert _gate(rec, "company_portability_structure")["passed"] is False
    assert called == [] and not _has_gate(rec, "company_portability_preview") and rec["package_digest"] is None


def test_binary_company_md_short_circuits_before_preview(tmp_path: Path) -> None:
    (tmp_path / "COMPANY.md").write_bytes(b"\x00\x01\xff")
    rec, called = _review_recording(tmp_path, capability_id="acme", version="1.0.0")
    assert _gate(rec, "company_portability_structure")["passed"] is False
    assert called == [] and not _has_gate(rec, "company_portability_preview") and rec["package_digest"] is None


def test_multiple_company_md_reaches_preview_via_shallowest(tmp_path: Path) -> None:
    # multiple COMPANY.md is no longer a short-circuit reject — structure passes (shallowest)
    # and the bundle reaches the authoritative Node preview.
    (tmp_path / "COMPANY.md").write_text("---\nname: A\n---\n", encoding="utf-8")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "COMPANY.md").write_text("---\nname: B\n---\n", encoding="utf-8")
    rec, called = _review_recording(tmp_path, capability_id="acme", version="1.0.0")
    assert _gate(rec, "company_portability_structure")["passed"] is True
    assert len(called) == 1 and _has_gate(rec, "company_portability_preview")


def test_inline_builder_rejects_symlink(tmp_path: Path) -> None:
    (tmp_path / "COMPANY.md").write_text("hello", encoding="utf-8")
    try:
        os.symlink(tmp_path / "COMPANY.md", tmp_path / "link.md")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(CompanyPortabilityPreviewError):
        build_portability_inline_files(tmp_path)


# ---------------------------------------------------------------- round-2 hardening


@pytest.mark.parametrize("bad_id", ["a b", "a/b", "a\nb", "Acme", " acme", "-acme", "../x", ""])
def test_unsafe_capability_id_fails_identity(tmp_path: Path, bad_id: str) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id=bad_id, version="1.0.0")
    assert _gate(rec, "company_publish_identity")["passed"] is False


def test_root_symlink_rejected_and_short_circuits(tmp_path: Path) -> None:
    real = tmp_path / "real"
    _make_bundle(real)
    link_root = tmp_path / "link_root"
    try:
        os.symlink(real, link_root, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    rec = review_company_portability_bundle(link_root, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
    assert _gate(rec, "company_portability_no_symlink")["passed"] is False
    assert not _has_gate(rec, "company_portability_preview")
    assert rec["package_digest"] is None


def test_secret_failure_skips_preview(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    (tmp_path / "leak.env").write_text(_SECRET_LINE, encoding="utf-8")
    called: list = []
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda r: called.append(r) or _ok_preview(r),
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_secret_scan")["passed"] is False
    assert called == []  # a secret-bearing bundle is never sent to the Node loopback
    assert not _has_gate(rec, "company_portability_preview")
    assert rec["package_digest"] is None


@pytest.mark.parametrize(
    "agent_plans",
    [
        [None],
        ["ceo"],
        [{"action": "create"}],  # missing slug
        [{"slug": "", "action": "create"}],  # empty slug
        [{"slug": "ceo", "action": "skip"}],  # not a create into a new company
        [{"slug": "ceo", "action": "update"}],
    ],
)
def test_agent_plan_element_validation(tmp_path: Path, agent_plans) -> None:
    _make_bundle(tmp_path)
    rec = review_company_portability_bundle(
        tmp_path,
        preview_fn=lambda _r: {"errors": [], "warnings": [], "plan": {"companyAction": "create", "agentPlans": agent_plans}},
        capability_id="x",
        version="1.0.0",
    )
    assert _gate(rec, "company_portability_preview")["passed"] is False


def test_multiple_company_md_picks_shallowest(tmp_path: Path) -> None:
    # The surface no longer hard-rejects multiple COMPANY.md (that would be a surface-only
    # rule the kernel lacks). It reports the shallowest and lets the Node preview decide.
    (tmp_path / "COMPANY.md").write_text("---\nname: A\n---\n", encoding="utf-8")
    sub = tmp_path / "nested"
    sub.mkdir()
    (sub / "COMPANY.md").write_text("---\nname: B\n---\n", encoding="utf-8")
    rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="acme", version="1.0.0")
    gate = _gate(rec, "company_portability_structure")
    assert gate["passed"] is True
    assert "COMPANY.md present: COMPANY.md" in gate["detail"]  # shallowest = root
    assert "2 COMPANY.md present" in gate["detail"]


def test_unreadable_file_fails_scan(tmp_path: Path) -> None:
    _make_bundle(tmp_path)
    locked = tmp_path / "locked.txt"
    locked.write_text("data", encoding="utf-8")
    os.chmod(locked, 0o000)
    try:
        if os.access(locked, os.R_OK):  # running as root or perms not enforced
            pytest.skip("cannot make a file unreadable in this environment")
        rec = review_company_portability_bundle(tmp_path, preview_fn=_ok_preview, capability_id="x", version="1.0.0")
        assert _gate(rec, "company_portability_secret_scan")["passed"] is False
    finally:
        os.chmod(locked, 0o644)
