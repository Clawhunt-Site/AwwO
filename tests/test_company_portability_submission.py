"""Slice 2: submit_company_portability_upload orchestration (store → review → record)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from superclaw.capability_submission import (
    DeveloperCapabilitySubmissionError,
    record_capability_distribution_decision,
    submit_company_portability_upload,
)


def _ok_preview(_request: dict) -> dict:
    return {
        "errors": [],
        "warnings": [],
        "plan": {"companyAction": "create", "agentPlans": [{"slug": "ceo", "action": "create"}]},
    }


def _make_bundle(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "COMPANY.md").write_text("---\nname: Acme\n---\nAcme.\n", encoding="utf-8")
    agents = root / "agents"
    agents.mkdir()
    (agents / "ceo.md").write_text("---\nname: CEO\n---\n", encoding="utf-8")
    return root


def test_portability_submission_ready(tmp_path: Path) -> None:
    bundle = _make_bundle(tmp_path / "bundle")
    root = tmp_path / "store"
    result = submit_company_portability_upload(
        bundle, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=_ok_preview
    )
    assert result.kind == "company"
    assert result.capability_id == "acme-corp"
    assert result.ready_for_review is True
    assert result.status == "ready_for_review"
    assert result.record["company_source_format"] == "portability"
    # the frozen artifact was copied into the submission store
    assert (root / result.submission_id / "artifact").is_dir()
    assert Path(result.review_path).is_file()


def test_portability_submission_rejected_when_preview_unavailable(tmp_path: Path) -> None:
    bundle = _make_bundle(tmp_path / "bundle")
    root = tmp_path / "store"
    result = submit_company_portability_upload(
        bundle, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=None
    )
    assert result.ready_for_review is False
    assert result.status == "rejected"


def test_portability_submission_rejected_on_bad_identity(tmp_path: Path) -> None:
    bundle = _make_bundle(tmp_path / "bundle")
    root = tmp_path / "store"
    result = submit_company_portability_upload(
        bundle, capability_id="Bad Id", version="1.0.0", submission_root=root, preview_fn=_ok_preview
    )
    assert result.ready_for_review is False


def test_portability_submission_rejected_on_missing_company_md(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "README.md").write_text("not a company", encoding="utf-8")
    root = tmp_path / "store"
    result = submit_company_portability_upload(
        bundle, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=_ok_preview
    )
    assert result.ready_for_review is False


def test_portability_submission_flows_through_distribution_publish(tmp_path: Path) -> None:
    # Slice 3: a ready portability company submission must be accepted by the EXISTING,
    # kind-generic distribution/publish path (no parallel company implementation). The
    # recorded artifact_blob_digest matches what the distribution path recomputes, so the
    # publish decision succeeds and binds the same immutable bytes → ready for R2 publish.
    bundle = _make_bundle(tmp_path / "bundle")
    root = tmp_path / "store"
    submission = submit_company_portability_upload(
        bundle, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=_ok_preview
    )
    assert submission.ready_for_review is True
    decision = record_capability_distribution_decision(
        submission.submission_id,
        submission_root=root,
        decision="publish",
        actor_ref="authority:publisher",
    )
    assert decision.kind == "company"
    assert decision.capability_id == "acme-corp"
    assert decision.version == "1.0.0"
    # the publish decision binds the SAME stored bytes the review recorded
    assert decision.artifact_blob_digest == submission.artifact_blob_digest


def test_portability_submission_rejects_root_symlink_before_copy(tmp_path: Path) -> None:
    real = _make_bundle(tmp_path / "real")
    link = tmp_path / "link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    root = tmp_path / "store"
    with pytest.raises(DeveloperCapabilitySubmissionError):
        submit_company_portability_upload(
            link, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=_ok_preview
        )


def test_portability_submission_rejects_over_limit_before_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import superclaw.company_portability_review as review

    monkeypatch.setattr(review, "MAX_PORTABILITY_FILES", 1)
    bundle = _make_bundle(tmp_path / "bundle")  # COMPANY.md + agents/ceo.md = 2 files
    root = tmp_path / "store"
    with pytest.raises(DeveloperCapabilitySubmissionError):
        submit_company_portability_upload(
            bundle, capability_id="acme-corp", version="1.0.0", submission_root=root, preview_fn=_ok_preview
        )
    assert not root.exists() or not any(root.iterdir())  # nothing copied into the store
