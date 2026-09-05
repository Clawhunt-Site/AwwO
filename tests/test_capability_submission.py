from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.capability_submission import (
    DeveloperCapabilitySubmissionError,
    get_developer_capability_submission,
    record_capability_distribution_decision,
    sanitize_capability_distribution_payload,
    submit_developer_capability_upload,
)
from superclaw.plugins import compute_package_digest, load_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _write_skill_fixture(tmp_path: Path, *, description: str = "Use this when turning PRs into release notes.") -> Path:
    skill_dir = tmp_path / f"release-notes-skill-{abs(hash(description))}"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: Release Notes
description: {description}
version: 0.2.0
---

# Release Notes

Summarize merged changes into user-facing release notes.
""",
        encoding="utf-8",
    )
    return skill_dir


def _write_company_fixture(tmp_path: Path, *, summary: str = "A delivery company blueprint.") -> Path:
    company_dir = tmp_path / f"delivery-company-{abs(hash(summary))}"
    company_dir.mkdir()
    manifest = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery",
        "version": "1.0.0",
        "summary": summary,
        "kind": "company",
        "source": {"type": "developer", "developer_id": "dev_acme"},
        "commerce": {"pricing_model": "free"},
        "roles": [
            {"name": "lead", "charter": "Plan and review delivery."},
            {"name": "impl", "charter": "Implement scoped changes.", "reports_to": "lead"},
        ],
        "equipment_requirements": {"impl": {"skills": ["release-notes"], "plugins": ["dev.superclaw.hello-world"]}},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "developer", "package_digest": "", "signature": ""},
    }
    (company_dir / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    return company_dir


def _copy_plugin_fixture(tmp_path: Path, *, plugin_id: str = "dev.superclaw.capability-upload") -> Path:
    target = tmp_path / plugin_id.replace(".", "-")
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", target)
    manifest_path = target / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["id"] = plugin_id
    manifest["name"] = "Capability Upload"
    manifest["source"] = {
        "type": "developer_upload",
        "clawhunt_problem_id": None,
        "developer_id": "dev_123",
    }
    manifest["provenance"] = {
        "build_type": "developer_upload",
        "source_digest": None,
        "package_digest": "sha256:" + ("0" * 64),
        "signature": "ed25519:unsigned",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _write_mcp_metadata(target, manifest)
    (target / "SUPPORT.md").write_text("Support contact: dev-support@example.com\n", encoding="utf-8")
    (target / "LICENSE").write_text("Fixture license: MIT-compatible test fixture.\n", encoding="utf-8")
    (target / "PERMISSIONS.md").write_text("No elevated permissions are required for this fixture.\n", encoding="utf-8")
    (target / "SECURITY.md").write_text("No secrets, runtime downloads, or root LLM keys are required.\n", encoding="utf-8")
    (target / "CHANGELOG.md").write_text("## 0.1.0\n\n- Initial developer-upload fixture.\n", encoding="utf-8")
    return target


def _write_mcp_metadata(plugin_dir: Path, manifest: dict) -> None:
    metadata = {
        "schema_version": "0.1.0",
        "plugin_id": manifest["id"],
        "plugin_version": manifest["version"],
        "transport": manifest["runtime"]["transport"],
        "entrypoint": manifest["runtime"]["entrypoint"],
        "args": manifest["runtime"].get("args", []),
        "proxy_required": True,
        "tools": [
            {
                "name": tool["name"],
                "input_schema": tool["input_schema"],
                "output_schema": tool["output_schema"],
            }
            for tool in manifest["tools"]
        ],
    }
    mcp_dir = plugin_dir / "mcp"
    mcp_dir.mkdir(exist_ok=True)
    (mcp_dir / "server.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _package_digest(package_path: Path) -> str:
    package = load_plugin_package(package_path)
    try:
        return compute_package_digest(package)
    finally:
        package.cleanup()


def _public_key_ref() -> str:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    return f"signer:ed25519:{public_key[:24]}"


@pytest.mark.parametrize(
    ("kind", "fixture_factory"),
    [
        ("plugin", _copy_plugin_fixture),
        ("skill", _write_skill_fixture),
        ("company", _write_company_fixture),
    ],
)
def test_distribution_publish_binds_each_capability_kind_to_digest_version_and_opaque_ref(
    tmp_path: Path,
    kind: str,
    fixture_factory,
):
    artifact = fixture_factory(tmp_path)
    submission_root = tmp_path / "submissions"
    result = submit_developer_capability_upload(kind, artifact, submission_root=submission_root)

    decision = record_capability_distribution_decision(
        result.submission_id,
        submission_root=submission_root,
        decision="publish",
        actor_ref="authority:publisher",
        entitlement_ref="entitlement:public",
    )

    assert decision.kind == kind
    assert decision.capability_id == result.capability_id
    assert decision.version == result.version
    assert decision.artifact_blob_digest == result.artifact_blob_digest
    assert decision.artifact_ref.startswith("superclaw-object://capabilities/")
    rendered = json.dumps(decision.record, sort_keys=True)
    assert str(tmp_path) not in rendered
    assert "/Users/leongong" not in rendered
    assert "private_key" not in rendered
    assert decision.status_path.exists()
    assert decision.audit_path.read_text(encoding="utf-8").count("\n") == 1


def test_distribution_publish_rejects_same_capability_version_with_changed_digest(tmp_path: Path):
    submission_root = tmp_path / "submissions"
    first = submit_developer_capability_upload("skill", _write_skill_fixture(tmp_path, description="Original description."), submission_root=submission_root)
    record_capability_distribution_decision(
        first.submission_id,
        submission_root=submission_root,
        decision="publish",
        actor_ref="authority:publisher",
    )

    second = submit_developer_capability_upload("skill", _write_skill_fixture(tmp_path, description="Changed description."), submission_root=submission_root)

    with pytest.raises(DeveloperCapabilitySubmissionError, match="different digest"):
        record_capability_distribution_decision(
            second.submission_id,
            submission_root=submission_root,
            decision="publish",
            actor_ref="authority:publisher",
        )


def test_distribution_sign_recomputes_stored_bytes_and_rejects_post_review_mutation(tmp_path: Path):
    submission_root = tmp_path / "submissions"
    result = submit_developer_capability_upload("skill", _write_skill_fixture(tmp_path), submission_root=submission_root)
    stored_skill = submission_root / result.submission_id / "artifact" / "SKILL.md"
    stored_skill.write_text(
        """---
name: Release Notes
description: Mutated after review.
version: 0.2.0
---

Changed bytes must not sign under the reviewed digest.
""",
        encoding="utf-8",
    )

    with pytest.raises(DeveloperCapabilitySubmissionError, match="digest"):
        record_capability_distribution_decision(
            result.submission_id,
            submission_root=submission_root,
            decision="sign",
            actor_ref="authority:publisher",
            signing_authority_ref=_public_key_ref(),
        )


def test_distribution_sign_rejects_mismatched_record_digest_for_plugin_ref(tmp_path: Path):
    submission_root = tmp_path / "submissions"
    plugin_dir = _copy_plugin_fixture(tmp_path)
    result = submit_developer_capability_upload("plugin", plugin_dir, submission_root=submission_root)
    record_path = submission_root / result.submission_id / "developer-upload-review.json"
    record = json.loads(record_path.read_text(encoding="utf-8"))
    record["artifact_blob_digest"] = "sha256:" + ("1" * 64)
    record["package_digest"] = _package_digest(plugin_dir)
    record_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(DeveloperCapabilitySubmissionError, match="artifact_blob_digest"):
        record_capability_distribution_decision(
            result.submission_id,
            submission_root=submission_root,
            decision="sign",
            actor_ref="authority:publisher",
            signing_authority_ref=_public_key_ref(),
        )


def test_distribution_rejects_signing_private_key_ingress_and_status_sanitizes_internal_paths(tmp_path: Path):
    submission_root = tmp_path / "submissions"
    result = submit_developer_capability_upload("skill", _write_skill_fixture(tmp_path), submission_root=submission_root)
    raw_status = get_developer_capability_submission(result.submission_id, submission_root=submission_root)
    assert "blob_path" in raw_status

    with pytest.raises(DeveloperCapabilitySubmissionError, match="private keys"):
        record_capability_distribution_decision(
            result.submission_id,
            submission_root=submission_root,
            decision="sign",
            actor_ref="authority:publisher",
            signing_authority_ref=_public_key_ref(),
            signing_private_key="SUPER_SECRET_PRODUCTION_KEY",
        )

    public_status = sanitize_capability_distribution_payload(raw_status)
    rendered = json.dumps(public_status, sort_keys=True)
    assert "blob_path" not in rendered
    assert str(tmp_path) not in rendered
    assert "SUPER_SECRET_PRODUCTION_KEY" not in rendered


def test_distribution_audit_records_publish_revoke_and_replace_decisions(tmp_path: Path):
    submission_root = tmp_path / "submissions"
    first = submit_developer_capability_upload("company", _write_company_fixture(tmp_path, summary="Original blueprint."), submission_root=submission_root)
    published = record_capability_distribution_decision(
        first.submission_id,
        submission_root=submission_root,
        decision="publish",
        actor_ref="authority:publisher",
    )
    revoked = record_capability_distribution_decision(
        first.submission_id,
        submission_root=submission_root,
        decision="revoke",
        actor_ref="authority:publisher",
    )

    second = submit_developer_capability_upload("company", _write_company_fixture(tmp_path, summary="Replacement blueprint."), submission_root=submission_root)
    replaced = record_capability_distribution_decision(
        second.submission_id,
        submission_root=submission_root,
        decision="replace",
        actor_ref="authority:publisher",
        replacement_for_digest=published.artifact_blob_digest,
    )

    assert revoked.decision == "revoke"
    assert replaced.decision == "replace"
    first_events = [json.loads(line) for line in published.audit_path.read_text(encoding="utf-8").splitlines()]
    assert [event["decision"] for event in first_events] == ["publish", "revoke"]
    second_events = [json.loads(line) for line in replaced.audit_path.read_text(encoding="utf-8").splitlines()]
    assert [event["decision"] for event in second_events] == ["replace"]
    index = json.loads((submission_root / "distribution-index.json").read_text(encoding="utf-8"))
    entry = index["entries"]["company:acme.delivery@1.0.0"]
    assert entry["artifact_blob_digest"] == replaced.artifact_blob_digest
