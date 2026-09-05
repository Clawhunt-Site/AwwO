from __future__ import annotations

import base64
import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.catalog_resolver import resolve_catalog
from superclaw.plugin_cloud import MAX_OFFLINE_GRACE_SECONDS, copy_package_into_fake_registry
from superclaw.plugins import compute_package_digest, load_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _parse_z(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _copy_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / name
    shutil.copytree(ROOT / "examples" / "plugins" / name, target)
    return target


def _sign_plugin(plugin_dir: Path) -> tuple[str, str]:
    private_key = Ed25519PrivateKey.generate()
    public_key = base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    manifest_path = plugin_dir / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"]["package_digest"] = ""
    manifest["provenance"]["signature"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package = load_plugin_package(plugin_dir)
    digest = compute_package_digest(package)
    signature = base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = f"ed25519:{signature}"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return public_key, digest


def _developer_signing_key() -> str:
    private_key = Ed25519PrivateKey.generate()
    private_bytes = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return base64.b64encode(private_bytes).decode("ascii")


def _write_developer_mcp_metadata(plugin_dir: Path, manifest: dict[str, object]) -> None:
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


def _copy_developer_upload_fixture(tmp_path: Path) -> Path:
    target = _copy_fixture(tmp_path, "hello-world")
    manifest_path = target / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["id"] = "dev.superclaw.developer-rest"
    manifest["name"] = "Developer REST Upload"
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
    _write_developer_mcp_metadata(target, manifest)
    (target / "SUPPORT.md").write_text("Support contact: dev-support@example.com\n", encoding="utf-8")
    (target / "LICENSE").write_text("Fixture license: MIT-compatible test fixture.\n", encoding="utf-8")
    (target / "PERMISSIONS.md").write_text("No elevated permissions are required for this fixture.\n", encoding="utf-8")
    (target / "SECURITY.md").write_text("No secrets, runtime downloads, or root LLM keys are required.\n", encoding="utf-8")
    (target / "CHANGELOG.md").write_text("## 0.1.0\n\n- Initial developer-upload fixture.\n", encoding="utf-8")
    return target


def _write_skill_submission_fixture(tmp_path: Path) -> Path:
    skill_dir = tmp_path / "skill-fixture"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        """---
name: Release Notes
description: Use this when turning merged pull requests into release notes.
version: 0.2.0
---

# Release Notes

Summarize merged changes into user-facing release notes.
""",
        encoding="utf-8",
    )
    return skill_dir


def _write_named_skill_submission_fixture(tmp_path: Path, name: str, description: str) -> Path:
    skill_dir = tmp_path / name
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


def _write_company_submission_fixture(tmp_path: Path) -> Path:
    company_dir = tmp_path / "company-fixture"
    company_dir.mkdir()
    manifest = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery",
        "version": "1.0.0",
        "summary": "A delivery company blueprint.",
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


def _write_registry(cloud_root: Path, plugin_dir: Path, digest: str, *, category: str = "utility") -> None:
    manifest = json.loads((plugin_dir / "superclaw-plugin.json").read_text(encoding="utf-8"))
    package_path = copy_package_into_fake_registry(plugin_dir, cloud_root, manifest["id"], manifest["version"])
    (package_path.parent / "metadata.json").write_text(
        json.dumps(
            {
                "plugin_id": manifest["id"],
                "version": manifest["version"],
                "name": manifest["name"],
                "summary": manifest["summary"],
                "category": category,
                "runtime": manifest["runtime"]["type"],
                "platforms": manifest["runtime"]["platforms"],
                "acceptance_level": manifest["acceptance"]["level"],
                "verified": True,
                "pricing_model": manifest["commerce"]["pricing_model"],
                "package_digest": digest,
                "package_path": "package",
                "compatibility": {"superclaw": ">=0.1.0"},
                "entitlement_required": manifest["commerce"]["pricing_model"] != "free",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _write_governance(cloud_root: Path, digest: str) -> None:
    governance = cloud_root / "governance"
    governance.mkdir(parents=True)
    expires = (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
    (governance / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_cloud_api",
                        "subject": "user_fixture",
                        "expires_at": expires,
                        "offline_grace_seconds": MAX_OFFLINE_GRACE_SECONDS * 10,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance / "revocations.json").write_text(
        json.dumps({"revoked": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0", "package_digest": digest, "reason": "broken_runtime"}]}),
        encoding="utf-8",
    )
    (governance / "runtime-policy.json").write_text(
        json.dumps(
            {
                "policies": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "max_model_output_bytes": 1024,
                        "denylisted_permissions": ["network:*"],
                        "secret_descriptors": [{"name": "GITHUB_TOKEN", "required": True}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


def _safe_invocation_summary() -> dict[str, object]:
    return {
        "run_id": "run_1",
        "plugin_id": "dev.superclaw.hello-world",
        "plugin_version": "0.1.0",
        "package_digest": "sha256:" + "1" * 64,
        "tool_name": "hello_world",
        "started_at": "2026-05-31T00:00:00Z",
        "finished_at": "2026-05-31T00:00:01Z",
        "status": "ok",
        "entitlement_id": None,
        "input_digest": "sha256:" + "2" * 64,
        "output_digest": "sha256:" + "3" * 64,
        "evidence_artifact_id": "artifact_1",
    }


def _write_reusable_clawhunt_delivery(root: Path) -> Path:
    (root / "bin").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "evidence-fixtures").mkdir()
    (root / "evidence").mkdir()
    (root / "bin" / "repo-report").write_text(
        "#!/usr/bin/env sh\nset -eu\nprintf '%s\\n' '{\"text\":\"ok\",\"artifacts\":[]}'\n",
        encoding="utf-8",
    )
    (root / "bin" / "repo-report").chmod(0o755)
    (root / "tests" / "smoke.sh").write_text("#!/usr/bin/env sh\nset -eu\nexit 0\n", encoding="utf-8")
    (root / "tests" / "smoke.sh").chmod(0o755)
    (root / "evidence-fixtures" / "replay.json").write_text('{"ok":true}\n', encoding="utf-8")
    (root / "evidence" / "bundle.json").write_text('{"run_id":"run_clawhunt","artifacts":[]}\n', encoding="utf-8")
    manifest = {
        "accepted": True,
        "problem_id": "problem_123",
        "title": "Reusable delivery",
        "summary": "Reusable ClawHunt delivery for local API tests.",
        "submitter_id": "dev_123",
        "package_owner_id": "owner_123",
        "evidence_bundle_ref": "evidence/bundle.json",
        "acceptance_tests": ["tests/smoke.sh"],
        "evidence_fixtures": ["evidence-fixtures/replay.json"],
        "replay_input": {"path": "."},
        "source_artifacts": [{"kind": "wrapper", "path": "bin/repo-report"}],
        "wrapper": {
            "plugin_id": "dev.superclaw.clawhunt-rest",
            "name": "ClawHunt REST Fixture",
            "version": "0.1.0",
            "tool_name": "repo_report",
            "entrypoint": "bin/repo-report",
            "description": "Run a reusable ClawHunt wrapper.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            "output_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}, "artifacts": {"type": "array"}},
                "required": ["text", "artifacts"],
                "additionalProperties": False,
            },
            "permissions": {"filesystem": [{"mode": "read", "scope": "workspace"}], "network": [], "environment": []},
        },
    }
    (root / "delivery-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return root


def test_v1_developer_submission_contract_uploads_artifact_and_returns_sanitized_verification(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    plugin_dir = _copy_developer_upload_fixture(tmp_path)
    signing_key = _developer_signing_key()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    created = client.post(
        "/v1/developer/plugins",
        json={"developer_id": "dev_123", "plugin_id": "dev.superclaw.developer-rest", "requested_acceptance_level": "L1"},
    )

    assert created.status_code == 200
    submission_id = created.json()["submission_id"]
    assert submission_id.startswith("plugsub_")

    # Submit NEVER signs (decoupled): artifact upload yields ready_for_signing,
    # NOT verified. A submit-time signing key is rejected (see the 400 test below).
    uploaded = client.post(
        f"/v1/developer/plugins/{submission_id}/artifact",
        json={"package_path": str(plugin_dir)},
    )

    assert uploaded.status_code == 200
    payload = uploaded.json()
    assert payload["submission_id"] == submission_id
    assert payload["status"] == "ready_for_signing"
    assert payload["plugin_id"] == "dev.superclaw.developer-rest"
    assert payload["version"] == "0.1.0"
    assert payload["ready_for_signing"] is True
    assert payload["listing_review_level"] == "Unlisted"  # not signed yet
    assert payload["acceptance_recommendation"] == "L1"
    assert payload["signature_issued"] is False
    assert payload["artifact_uploaded"] is True
    joined = json.dumps(payload, sort_keys=True)
    assert str(tmp_path) not in joined
    assert "/Users/leongong" not in joined
    assert signing_key not in joined
    assert "SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY" not in joined

    verification = client.get(f"/v1/developer/plugins/{submission_id}/verification")
    assert verification.status_code == 200
    assert verification.json() == payload
    record = json.loads((cloud_root / "developer-submissions" / "jobs" / f"{submission_id}.json").read_text(encoding="utf-8"))
    assert record == payload
    assert not any("/" in str(gate.get("detail", "")) for gate in payload["gates"])


def test_v1_developer_submission_artifact_rejects_signing_key(tmp_path: Path, monkeypatch):
    # Fail-closed: a submit-time signing key is refused (closes "any key → verified").
    cloud_root = tmp_path / "cloud"
    plugin_dir = _copy_developer_upload_fixture(tmp_path)
    signing_key = _developer_signing_key()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    created = client.post("/v1/developer/plugins", json={"developer_id": "dev_123"})
    submission_id = created.json()["submission_id"]
    rejected = client.post(
        f"/v1/developer/plugins/{submission_id}/artifact",
        json={"package_path": str(plugin_dir), "signing_private_key": signing_key},
    )
    assert rejected.status_code == 400
    assert "must not carry a signing key" in rejected.json()["detail"]


def test_v1_developer_skill_submission_upload_status_and_digest_immutability(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    skill_dir = _write_skill_submission_fixture(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    created = client.post("/v1/developer/skills", json={"developer_id": "dev_123"})
    assert created.status_code == 200
    submission_id = created.json()["submission_id"]
    assert submission_id.startswith("skillsub_")
    assert created.json()["status"] == "draft"

    uploaded = client.post(
        f"/v1/developer/skills/{submission_id}/artifact",
        json={"package_path": str(skill_dir)},
    )

    assert uploaded.status_code == 200
    payload = uploaded.json()
    assert payload["submission_id"] == submission_id
    assert payload["kind"] == "skill"
    assert payload["status"] == "ready_for_review"
    assert payload["capability_id"] == "skill.release-notes"
    assert payload["skill_id"] == "skill.release-notes"
    assert payload["version"] == "0.2.0"
    assert payload["ready_for_review"] is True
    assert payload["artifact_blob_digest"].startswith("sha256:")
    assert payload["signature_issued"] is False
    assert str(tmp_path) not in json.dumps(payload, sort_keys=True)

    original_digest = payload["artifact_blob_digest"]
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Release Notes\ndescription: Changed after upload.\nversion: 0.2.0\n---\n\nChanged.\n",
        encoding="utf-8",
    )
    status = client.get(f"/v1/developer/skills/{submission_id}/status")
    assert status.status_code == 200
    assert status.json()["artifact_blob_digest"] == original_digest


def test_v1_developer_company_submission_upload_validates_template(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    company_dir = _write_company_submission_fixture(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    created = client.post("/v1/developer/capabilities", json={"kind": "company", "developer_id": "dev_123"})
    assert created.status_code == 200
    submission_id = created.json()["submission_id"]
    assert submission_id.startswith("cosub_")

    uploaded = client.post(
        f"/v1/developer/capabilities/{submission_id}/artifact",
        json={"package_path": str(company_dir)},
    )

    assert uploaded.status_code == 200
    payload = uploaded.json()
    assert payload["kind"] == "company"
    assert payload["status"] == "ready_for_review"
    assert payload["capability_id"] == "acme.delivery"
    assert payload["company_id"] == "acme.delivery"
    assert payload["version"] == "1.0.0"
    assert payload["package_digest"].startswith("sha256:")
    gates = {gate["name"]: gate for gate in payload["gates"]}
    assert gates["company_template_loadable"]["passed"] is True
    assert gates["company_contract_valid"]["passed"] is True
    assert gates["company_digest_stable"]["passed"] is True


def test_v1_developer_capability_artifact_rejects_signing_key_for_skill(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    skill_dir = _write_skill_submission_fixture(tmp_path)
    signing_key = _developer_signing_key()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    created = client.post("/v1/developer/capabilities", json={"kind": "skill", "developer_id": "dev_123"})
    submission_id = created.json()["submission_id"]

    rejected = client.post(
        f"/v1/developer/capabilities/{submission_id}/artifact",
        json={"package_path": str(skill_dir), "signing_private_key": signing_key},
    )

    assert rejected.status_code == 400
    assert "must not carry a signing key" in rejected.json()["detail"]


def test_v1_capability_review_submission_accepts_devtool_contract_without_auto_approval(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    artifact_ref = "superclaw-object://capabilities/skill/release-notes/0.2.0/artifact"
    digest = "sha256:" + "a" * 64

    submitted = client.post(
        "/v1/capabilities/submissions",
        json={
            "schema_version": "superclaw.capability_review_submission.v1",
            "kind": "skill",
            "capability_id": "skill.release-notes",
            "skill_id": "skill.release-notes",
            "version": "0.2.0",
            "artifact_digest": digest,
            "package_digest": digest,
            "artifact_ref": artifact_ref,
            "artifact_filename": "release-notes-0.2.0.scskill",
            "package_format": "scskill",
            "name": "Release Notes",
            "summary": "Write release notes.",
            "requested_status": "review_requested",
            "developer_ref": "developer:acme",
            "auto_approve": False,
        },
    )

    assert submitted.status_code == 200
    payload = submitted.json()
    assert payload["ok"] is True
    assert payload["kind"] == "skill"
    assert payload["capability_id"] == "skill.release-notes"
    assert payload["status"] == "pending_review"
    assert payload["ready_for_review"] is True
    assert payload["artifact_ref"] == artifact_ref
    status = client.get(f"/v1/capabilities/submissions/{payload['submission_id']}")
    pending = client.get("/api/admin/capabilities/submissions")
    rejected = client.post(
        "/v1/capabilities/submissions",
        json={
            "kind": "skill",
            "capability_id": "skill.release-notes",
            "version": "0.2.0",
            "package_digest": digest,
            "artifact_ref": artifact_ref,
            "auto_approve": True,
        },
    )
    joined = json.dumps({"submitted": submitted.json(), "status": status.json(), "pending": pending.json()}, sort_keys=True)

    assert status.status_code == 200
    assert status.json()["status"] == "pending_review"
    assert pending.status_code == 200
    assert pending.json()["count"] == 1
    assert rejected.status_code == 400
    assert "auto-approve" in rejected.json()["detail"]
    assert str(tmp_path) not in joined
    assert "/Users/leongong" not in joined
    assert "private_key" not in joined


def test_api_admin_capability_review_publishes_sync_and_download_ref(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    skill_dir = _write_skill_submission_fixture(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    created = client.post("/v1/developer/capabilities", json={"kind": "skill", "developer_id": "dev_123"})
    submission_id = created.json()["submission_id"]
    uploaded = client.post(
        f"/v1/developer/capabilities/{submission_id}/artifact",
        json={"package_path": str(skill_dir)},
    )

    pending = client.get("/api/admin/capabilities/submissions")
    reviewed = client.post(
        f"/api/admin/capabilities/submissions/{submission_id}/review",
        json={"decision": "publish", "actor_ref": "authority:publisher"},
    )
    sync = client.get("/api/admin/capabilities/registry/sync")
    download = client.get("/api/admin/capabilities/skill/skill.release-notes/versions/0.2.0/download")

    assert uploaded.status_code == 200
    assert pending.status_code == 200
    assert pending.json()["count"] == 1
    assert reviewed.status_code == 200
    payload = reviewed.json()
    assert payload["ok"] is True
    assert payload["submission"]["published"] is True
    assert payload["decision"]["decision"] == "publish"
    assert payload["decision"]["artifact_ref"].startswith("superclaw-object://capabilities/")
    assert payload["download"]["url"] == "/api/admin/capabilities/skill/skill.release-notes/versions/0.2.0/download"
    assert sync.status_code == 200
    skill_manifest = sync.json()["capabilities"]["skill"][0]
    assert skill_manifest["capability_id"] == "skill.release-notes"
    assert skill_manifest["version"] == "0.2.0"
    assert skill_manifest["package_digest"] == uploaded.json()["artifact_blob_digest"]
    assert download.status_code == 200
    assert download.json()["download_url"] == "superclaw-local://capabilities/skill/skill.release-notes/versions/0.2.0/artifact"
    joined = json.dumps({"reviewed": reviewed.json(), "sync": sync.json(), "download": download.json()}, sort_keys=True)
    assert str(tmp_path) not in joined
    assert "/Users/leongong" not in joined
    assert "private_key" not in joined

    revoked = client.post(
        f"/api/admin/capabilities/submissions/{submission_id}/review",
        json={"decision": "revoke", "actor_ref": "authority:publisher"},
    )
    sync_after_revoke = client.get("/api/admin/capabilities/registry/sync")

    assert revoked.status_code == 200
    assert revoked.json()["decision"]["decision"] == "revoke"
    assert sync_after_revoke.status_code == 200
    assert sync_after_revoke.json()["capabilities"]["skill"] == []
    audit_path = cloud_root / "developer-submissions" / "reviews" / submission_id / "distribution-audit.jsonl"
    assert [json.loads(line)["decision"] for line in audit_path.read_text(encoding="utf-8").splitlines()] == ["publish", "revoke"]


def test_api_admin_capability_registry_sync_groups_plugin_skill_and_company(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    fixtures = {
        "plugin": _copy_developer_upload_fixture(tmp_path / "plugin"),
        "skill": _write_named_skill_submission_fixture(tmp_path, "skill-sync-fixture", "Use this when syncing release notes."),
        "company": _write_company_submission_fixture(tmp_path),
    }

    for kind, artifact in fixtures.items():
        created = client.post("/v1/developer/capabilities", json={"kind": kind, "developer_id": "dev_123"})
        submission_id = created.json()["submission_id"]
        uploaded = client.post(
            f"/v1/developer/capabilities/{submission_id}/artifact",
            json={"package_path": str(artifact)},
        )
        reviewed = client.post(
            f"/api/admin/capabilities/submissions/{submission_id}/review",
            json={"decision": "publish", "actor_ref": "authority:publisher"},
        )
        assert uploaded.status_code == 200
        assert reviewed.status_code == 200

    sync = client.get("/api/admin/capabilities/registry/sync")

    assert sync.status_code == 200
    payload = sync.json()
    assert {item["kind"] for item in payload["items"]} == {"plugin", "skill", "company"}
    assert payload["capabilities"]["plugin"][0]["capability_id"] == "dev.superclaw.developer-rest"
    assert payload["capabilities"]["skill"][0]["capability_id"] == "skill.release-notes"
    assert payload["capabilities"]["company"][0]["capability_id"] == "acme.delivery"
    assert payload["count"] == 3


def test_api_admin_capability_publish_rejects_same_version_changed_digest(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    first_artifact = _write_named_skill_submission_fixture(tmp_path, "skill-original", "Original description.")
    first = client.post("/v1/developer/capabilities", json={"kind": "skill", "developer_id": "dev_123"}).json()["submission_id"]
    client.post(f"/v1/developer/capabilities/{first}/artifact", json={"package_path": str(first_artifact)})
    first_review = client.post(
        f"/api/admin/capabilities/submissions/{first}/review",
        json={"decision": "publish", "actor_ref": "authority:publisher"},
    )

    second_artifact = _write_named_skill_submission_fixture(tmp_path, "skill-changed", "Changed description.")
    second = client.post("/v1/developer/capabilities", json={"kind": "skill", "developer_id": "dev_123"}).json()["submission_id"]
    client.post(f"/v1/developer/capabilities/{second}/artifact", json={"package_path": str(second_artifact)})
    second_review = client.post(
        f"/api/admin/capabilities/submissions/{second}/review",
        json={"decision": "publish", "actor_ref": "authority:publisher"},
    )

    assert first_review.status_code == 200
    assert second_review.status_code == 400
    assert "different digest" in second_review.json()["detail"]


def test_v1_developer_submission_contract_returns_rejected_review_without_signed_ref(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    plugin_dir = _copy_developer_upload_fixture(tmp_path)
    (plugin_dir / "SUPPORT.md").unlink()
    signing_key = _developer_signing_key()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    created = client.post("/v1/developer/plugins", json={"developer_id": "dev_123"})
    submission_id = created.json()["submission_id"]

    uploaded = client.post(
        f"/v1/developer/plugins/{submission_id}/artifact",
        json={"package_path": str(plugin_dir)},
    )

    assert uploaded.status_code == 200
    payload = uploaded.json()
    assert payload["status"] == "rejected"
    assert payload["listing_review_level"] == "Unlisted"
    assert payload["signature_issued"] is False
    assert "signed_package_ref" not in payload
    gates = {gate["name"]: gate for gate in payload["gates"]}
    assert gates["support_contact_present"]["passed"] is False
    assert str(tmp_path) not in json.dumps(payload, sort_keys=True)
    assert signing_key not in json.dumps(payload, sort_keys=True)


def test_v1_developer_submission_contract_sanitizes_invalid_artifact_path_errors(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    created = client.post("/v1/developer/plugins", json={"developer_id": "dev_123"})
    submission_id = created.json()["submission_id"]

    response = client.post(
        f"/v1/developer/plugins/{submission_id}/artifact",
        json={"package_path": str(tmp_path / "missing-package")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "developer submission request failed validation"
    assert str(tmp_path) not in json.dumps(response.json(), sort_keys=True)


def test_v1_developer_submission_contract_unknown_submission_returns_404(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    plugin_dir = _copy_developer_upload_fixture(tmp_path)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    upload = client.post("/v1/developer/plugins/plugsub_missing/artifact", json={"package_path": str(plugin_dir)})
    verification = client.get("/v1/developer/plugins/plugsub_missing/verification")

    assert upload.status_code == 404
    assert verification.status_code == 404


def test_v1_clawhunt_ingestion_contract_stages_reusable_delivery_without_path_leakage(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    delivery_root = _write_reusable_clawhunt_delivery(tmp_path / "delivery")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post("/v1/clawhunt/ingestions", json={"delivery_root": str(delivery_root)})

    assert response.status_code == 200
    payload = response.json()
    assert payload["ingestion_id"].startswith("ing_")
    assert payload["status"] == "staged"
    assert payload["plugin_id"] == "dev.superclaw.clawhunt-rest"
    assert payload["version"] == "0.1.0"
    assert payload["package_digest"].startswith("sha256:")
    assert payload["source_digest"].startswith("sha256:")
    assert payload["package_ref"] == "superclaw-local://clawhunt-ingestions/packages/dev.superclaw.clawhunt-rest/0.1.0"
    assert payload["requires_signing"] is True
    joined = json.dumps(payload, sort_keys=True)
    assert str(tmp_path) not in joined
    assert "/Users/leongong" not in joined
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in joined
    job_record = next((cloud_root / "clawhunt-ingestions" / "jobs").glob("ing_*.json"))
    assert json.loads(job_record.read_text(encoding="utf-8"))["package_ref"] == payload["package_ref"]
    assert (cloud_root / "clawhunt-ingestions" / "packages" / "dev.superclaw.clawhunt-rest" / "0.1.0" / "superclaw-plugin.json").exists()


def test_v1_clawhunt_ingestion_contract_rejects_missing_evidence_without_package(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    delivery_root = _write_reusable_clawhunt_delivery(tmp_path / "delivery")
    (delivery_root / "evidence" / "bundle.json").unlink()
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post("/v1/clawhunt/ingestions", json={"delivery_root": str(delivery_root)})

    assert response.status_code == 400
    assert response.json()["detail"] == "clawhunt ingestion request failed validation"
    assert str(tmp_path) not in json.dumps(response.json(), sort_keys=True)
    assert not (cloud_root / "clawhunt-ingestions" / "packages").exists()


def test_v1_clawhunt_ingestion_contract_rejects_non_reusable_wrapper_without_leaking_paths(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    delivery_root = _write_reusable_clawhunt_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["wrapper"]["requires_private_account_state"] = True
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post("/v1/clawhunt/ingestions", json={"delivery_root": str(delivery_root)})

    assert response.status_code == 400
    assert "private account state" in response.json()["detail"]
    assert str(tmp_path) not in json.dumps(response.json(), sort_keys=True)


def test_v1_clawhunt_ingestion_contract_sanitizes_unsafe_path_errors(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    delivery_root = _write_reusable_clawhunt_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["wrapper"]["entrypoint"] = str(tmp_path / "secret-tool")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post("/v1/clawhunt/ingestions", json={"delivery_root": str(delivery_root)})

    assert response.status_code == 400
    assert response.json()["detail"] == "clawhunt ingestion request failed validation"
    assert str(tmp_path) not in json.dumps(response.json(), sort_keys=True)


def test_v1_plugin_registry_contract_returns_sanitized_metadata(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    _public_key, digest = _sign_plugin(plugin_dir)
    _write_registry(cloud_root, plugin_dir, digest)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    listed = client.get("/v1/plugins", params={"runtime": "mcp_sidecar", "platform": "darwin-arm64", "verified": "true"})
    version = client.get("/v1/plugins/dev.superclaw.hello-world/versions/0.1.0")
    download = client.get("/v1/plugins/dev.superclaw.hello-world/versions/0.1.0/download")

    assert listed.status_code == 200
    assert listed.json()["plugins"][0]["plugin_id"] == "dev.superclaw.hello-world"
    assert version.status_code == 200
    assert version.json()["package_digest"] == digest
    assert download.status_code == 200
    assert download.json()["download_url"].startswith("superclaw-local://")
    joined = json.dumps({"listed": listed.json(), "version": version.json(), "download": download.json()}, sort_keys=True)
    assert str(cloud_root) not in joined
    assert "package_path" not in joined
    assert "bin/hello-world" not in joined


def test_v1_catalog_wraps_resolver_and_backfills_plugin_trust(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    cache_root = tmp_path / "cache"
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    public_key, digest = _sign_plugin(plugin_dir)
    _write_registry(cloud_root, plugin_dir, digest)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    catalog_resp = client.get("/v1/catalog", params={"kind": "plugin"})
    plugins_resp = client.get("/v1/plugins", params={"runtime": "mcp_sidecar", "platform": "darwin-arm64", "verified": "true"})
    trust_resp = client.get("/v1/catalog/trust/dev.superclaw.hello-world/0.1.0")
    contract_resp = client.get("/api/contracts/catalog")

    assert catalog_resp.status_code == 200
    api_payload = catalog_resp.json()
    local_payload = resolve_catalog(kind="plugin", cache_root=cache_root, cloud_root=cloud_root).to_dict()
    assert {k: v for k, v in api_payload.items() if k != "resolved_at"} == {
        k: v for k, v in local_payload.items() if k != "resolved_at"
    }
    catalog_item = api_payload["items"][0]
    assert catalog_item["plugin_id"] == "dev.superclaw.hello-world"
    assert catalog_item["trust"] == "official"
    assert catalog_item["signer_class"] == "root"
    assert catalog_item["sources"] == ["registry"]

    assert plugins_resp.status_code == 200
    plugin_row = plugins_resp.json()["plugins"][0]
    assert plugin_row["plugin_id"] == "dev.superclaw.hello-world"
    assert plugin_row["package_digest"] == digest
    assert plugin_row["acceptance_level"] == "L1"
    assert plugin_row["verified"] is True
    assert plugin_row["trust"] == "official"
    assert plugin_row["signer_class"] == "root"
    assert plugin_row["catalog_kind"] == "plugin"
    assert plugin_row["sources"] == ["registry"]
    assert plugins_resp.json()["conflicts"] == []

    assert trust_resp.status_code == 200
    trust_payload = trust_resp.json()
    assert trust_payload["trust"] == "official"
    assert trust_payload["signer_class"] == "root"

    assert contract_resp.status_code == 200
    contract = contract_resp.json()
    assert contract["capability"] == "capability-catalog"
    assert contract["status_url"] == "/v1/catalog"
    assert contract["refresh_url"] == "/v1/catalog/refresh"
    assert contract["trust_state_url_template"] == "/v1/catalog/trust/{plugin_id}/{version}"
    assert contract["legacy_views"]["plugins_url"] == "/v1/plugins"
    assert contract["legacy_views"]["skills_url"] == "/v1/skills"
    assert set(contract["kinds"]) == {"plugin", "skill", "company"}
    assert "catalog_kind" in contract["plugin_view_backfill_fields"]
    assert any(reason["id"] == "same_id_different_signer" for reason in contract["conflict_reasons"])


def test_v1_skills_uses_native_store_not_skill_origin_plugins(tmp_path: Path, monkeypatch):
    from superclaw.skill_import import import_skill_as_plugin

    cloud_root = tmp_path / "cloud"
    # A plain tool plugin and a legacy skill-origin plugin produced by import-skill.
    hello = _copy_fixture(tmp_path, "hello-world")
    public_key, hello_digest = _sign_plugin(hello)
    _write_registry(cloud_root, hello, hello_digest)

    skill_src = tmp_path / "skill-src"
    skill_src.mkdir()
    (skill_src / "SKILL.md").write_text(
        "---\nname: Changelog Formatter\ndescription: Turn raw commits into grouped markdown.\n---\n\nGroup commits, then render.\n",
        encoding="utf-8",
    )
    skill_pkg = import_skill_as_plugin(skill_src, output_dir=tmp_path / "skill-pkg").package_root
    _skill_key, skill_digest = _sign_plugin(skill_pkg)
    # The registry metadata deliberately omits skill_origin, so this also proves the
    # classifier falls back to the signed manifest flag.
    _write_registry(cloud_root, skill_pkg, skill_digest)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    plugins_resp = client.get("/v1/plugins")
    skills_resp = client.get("/v1/skills")

    assert plugins_resp.status_code == 200
    assert skills_resp.status_code == 200
    plugin_ids = {row["plugin_id"] for row in plugins_resp.json()["plugins"]}
    assert {"dev.superclaw.hello-world", "skill.changelog-formatter"} <= plugin_ids
    # Native `/v1/skills` now reads the native skill store. Legacy skill-origin
    # plugin packages remain visible to plugin/catalog compatibility surfaces,
    # but they no longer back the user-facing skill list.
    assert skills_resp.json()["skills"] == []
    assert skills_resp.json()["conflicts"] == []


def test_v1_catalog_refresh_fails_closed_and_keeps_cached_state(tmp_path: Path, monkeypatch):
    registry_root = tmp_path / ".superclaw" / "registry"
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    public_key, digest = _sign_plugin(plugin_dir)
    cloud_root = tmp_path / "cloud"
    cache_root = tmp_path / "cache"
    _write_registry(cloud_root, plugin_dir, digest)
    monkeypatch.chdir(tmp_path)
    # registry root now resolves under the HOME data root; pin it to this tmp so the
    # default lands at tmp/.superclaw/registry (= registry_root).
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    cached_catalog = client.get("/v1/catalog", params={"kind": "plugin"})

    def fail_if_cache_is_cleared(*_args, **_kwargs):
        raise ValueError("resolver should not be called after a failed refresh")

    monkeypatch.setattr("apps.api.main.resolve_catalog", fail_if_cache_is_cleared)
    response = client.post("/v1/catalog/refresh", json={"source_url": "https://example.invalid/tuf"})
    after = client.get("/v1/catalog", params={"kind": "plugin"})

    assert cached_catalog.status_code == 200
    assert response.status_code == 503
    payload = response.json()
    assert payload["ok"] is False
    assert payload["kept_cached"] is True
    assert payload["registry_root"] == str(registry_root)
    assert after.status_code == 200
    assert after.json() == cached_catalog.json()


def test_v1_catalog_cache_invalidates_after_plugin_install(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    cache_root = tmp_path / "cache"
    plugin_dir = _copy_fixture(tmp_path, "hello-world")
    public_key, digest = _sign_plugin(plugin_dir)
    _write_registry(cloud_root, plugin_dir, digest)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", public_key)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    before = client.get("/v1/catalog", params={"kind": "plugin"})
    install = client.post("/api/plugins/install", json={"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0"})
    after = client.get("/v1/catalog", params={"kind": "plugin"})

    assert before.status_code == 200
    assert before.json()["items"][0]["install_state"]["installed"] is False
    assert install.status_code == 200
    assert after.status_code == 200
    assert after.json()["items"][0]["install_state"]["installed"] is True


def test_v1_governance_contract_syncs_entitlements_revocations_and_policy(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    hello = _copy_fixture(tmp_path, "hello-world")
    _public_key, digest = _sign_plugin(hello)
    _write_registry(cloud_root, hello, digest)
    scanner = _copy_fixture(tmp_path / "scanner", "github-scanner")
    _sign_plugin(scanner)
    _write_registry(cloud_root, scanner, json.loads((scanner / "superclaw-plugin.json").read_text(encoding="utf-8"))["provenance"]["package_digest"], category="developer")
    _write_governance(cloud_root, digest)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    entitlements = client.post(
        "/v1/entitlements/sync",
        json={"device_id": "device_1", "runtime_version": "0.1.0", "plugin_ids": ["dev.superclaw.github-scanner"]},
    )
    revocations = client.get("/v1/plugins/revocations")
    policy = client.get("/v1/policies/runtime")

    assert entitlements.status_code == 200
    entitlement = entitlements.json()["entitlements"][0]
    assert entitlement["plugin_id"] == "dev.superclaw.github-scanner"
    assert entitlement["device_id"] == "device_1"
    assert entitlement["runtime_version"] == "0.1.0"
    assert entitlement["version_range"] == "=0.1.0"
    assert entitlement["token"].startswith("local-entitlement.")
    grace_window = _parse_z(entitlement["offline_grace_expires_at"]) - _parse_z(entitlement["synced_at"])
    assert grace_window <= timedelta(seconds=MAX_OFFLINE_GRACE_SECONDS)
    assert grace_window > timedelta(hours=71)
    assert revocations.status_code == 200
    assert revocations.json()["revoked"][0]["reason"] == "broken_runtime"
    assert policy.status_code == 200
    assert policy.json()["policies"][0]["secret_descriptors"] == [{"name": "GITHUB_TOKEN", "required": True}]
    joined = json.dumps({"entitlements": entitlements.json(), "revocations": revocations.json(), "policy": policy.json()}, sort_keys=True)
    assert "ghp_" not in joined
    assert "private_key" not in joined
    assert str(cloud_root) not in joined


def test_v1_revocations_reject_unknown_reason_code(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    governance = cloud_root / "governance"
    governance.mkdir(parents=True)
    (governance / "revocations.json").write_text(
        json.dumps({"revoked": [{"plugin_id": "dev.superclaw.hello-world", "version": "0.1.0", "reason": "unknown"}]}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.get("/v1/plugins/revocations")

    assert response.status_code == 400
    assert "revocation reason" in response.json()["detail"]


def test_v1_entitlement_sync_disables_offline_grace_for_high_risk_policy(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    governance = cloud_root / "governance"
    governance.mkdir(parents=True)
    (governance / "entitlements.json").write_text(
        json.dumps(
            {
                "entitlements": [
                    {
                        "plugin_id": "dev.superclaw.github-scanner",
                        "version": "0.1.0",
                        "entitlement_id": "ent_high_risk_api",
                        "subject": "user_fixture",
                        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                        "offline_grace_seconds": MAX_OFFLINE_GRACE_SECONDS,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (governance / "runtime-policy.json").write_text(
        json.dumps({"policies": [{"plugin_id": "dev.superclaw.github-scanner", "version": "0.1.0", "risk_level": "high"}]}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post(
        "/v1/entitlements/sync",
        json={"device_id": "device_1", "runtime_version": "0.1.0", "plugin_ids": ["dev.superclaw.github-scanner"]},
    )

    assert response.status_code == 200
    entitlement = response.json()["entitlements"][0]
    assert entitlement["offline_grace_disabled_reason"] == "policy_high_risk"
    assert entitlement["offline_grace_expires_at"] == entitlement["synced_at"]
    assert entitlement["token"].startswith("local-entitlement.")


def test_v1_evidence_upload_accepts_summary_and_rejects_raw_leakage(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    safe_summary = _safe_invocation_summary()

    accepted = client.post("/v1/evidence/plugin-invocations", json={"summary": safe_summary})
    rejected = client.post(
        "/v1/evidence/plugin-invocations",
        json={"summary": {**safe_summary, "output": "raw workspace /Users/leongong/Documents/superClaw ghp_abcdefghijklmnop"}},
    )

    assert accepted.status_code == 200
    assert accepted.json()["ok"] is True
    saved = next((cloud_root / "evidence").glob("*.json")).read_text(encoding="utf-8")
    assert "output_digest" in saved
    assert "/Users/leongong" not in saved
    assert rejected.status_code == 400
    assert "raw output" in rejected.json()["detail"]


def test_v1_evidence_upload_rejects_incomplete_or_invalid_invocation_summary(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    missing = _safe_invocation_summary()
    missing.pop("started_at")

    missing_response = client.post("/v1/evidence/plugin-invocations", json={"summary": missing})
    digest_response = client.post(
        "/v1/evidence/plugin-invocations",
        json={"summary": {**_safe_invocation_summary(), "output_digest": "sha256:not-a-digest"}},
    )
    time_response = client.post(
        "/v1/evidence/plugin-invocations",
        json={
            "summary": {
                **_safe_invocation_summary(),
                "started_at": "2026-05-31T00:00:02Z",
                "finished_at": "2026-05-31T00:00:01Z",
            }
        },
    )

    assert missing_response.status_code == 400
    assert "missing required fields: started_at" in missing_response.json()["detail"]
    assert digest_response.status_code == 400
    assert "output_digest" in digest_response.json()["detail"]
    assert time_response.status_code == 400
    assert "finished_at" in time_response.json()["detail"]


def test_v1_cloud_contract_rejects_path_traversal_segments(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    unsafe_version = client.get("/v1/plugins/dev.superclaw.hello-world/versions/%2e%2e")
    unsafe_upload = client.post(
        "/v1/evidence/plugin-invocations",
        json={
            "summary": {
                "upload_id": "../../../evil",
                "run_id": "run_1",
                "input_digest": "sha256:" + "1" * 64,
                "output_digest": "sha256:" + "2" * 64,
            }
        },
    )

    assert unsafe_version.status_code == 400
    assert unsafe_upload.status_code == 400
    assert not (tmp_path / "evil.json").exists()
