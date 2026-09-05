"""Contract tests for the local developer capability-upload surface.

These lock the Web/Desktop "developer upload" panel to the kernel so the surface
can never drift on the kind vocabulary, the plugin document checklist, or the
hard rule that signing/publishing are excluded from the upload path.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.capability_submission import CAPABILITY_KINDS
from superclaw.plugin_submission import REQUIRED_SUBMISSION_DOCS
from superclaw.ui_contracts import build_capability_upload_contract


def test_capability_upload_contract_kinds_track_kernel():
    contract = build_capability_upload_contract()
    assert contract["capability"] == "capability-upload"
    assert contract["artifact_source"] == "local_path"

    kinds = {entry["value"] for entry in contract["kinds"]}
    # The contract's kind vocabulary must equal the kernel's — no surface-only kind,
    # no kernel kind missing its guidance.
    assert kinds == set(CAPABILITY_KINDS)

    for entry in contract["kinds"]:
        assert entry["label"]
        assert entry["id_field"]
        assert entry["id_placeholder"]
        assert entry["contents"], f"{entry['value']} needs a contents checklist"
        assert entry["review"]


def test_capability_upload_plugin_checklist_tracks_required_docs():
    contract = build_capability_upload_contract()
    plugin = next(entry for entry in contract["kinds"] if entry["value"] == "plugin")
    listed = {item["path"] for item in plugin["contents"]}

    # Every required developer doc the kernel enforces must appear in the checklist
    # (canonical spelling = the first candidate of each gate).
    canonical_docs = {candidates[0] for candidates in REQUIRED_SUBMISSION_DOCS.values()}
    assert canonical_docs.issubset(listed)
    # The manifest is always the first thing a developer must ship.
    assert "superclaw-plugin.json" in listed


def test_capability_upload_acceptance_levels_are_l1_l2_l3():
    contract = build_capability_upload_contract()
    levels = [entry["value"] for entry in contract["acceptance_levels"]]
    assert levels == ["L1", "L2", "L3"]
    for entry in contract["acceptance_levels"]:
        assert entry["label"]
        assert entry["detail"]


def test_capability_upload_excludes_signing_and_publishing():
    contract = build_capability_upload_contract()
    excludes = set(contract["excludes"])
    # Signing key must never be collected on the upload surface (the API rejects it),
    # and publishing/listing are out-of-scope post-review steps.
    assert "signing_private_key" in excludes
    assert "publish" in excludes
    assert "marketplace_listing" in excludes
    assert contract["copy"]["signing_excluded"]


def test_capability_upload_contract_endpoint_matches_kernel(tmp_path):
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    resp = client.get("/api/contracts/capability-upload")
    assert resp.status_code == 200
    assert resp.json() == build_capability_upload_contract()
