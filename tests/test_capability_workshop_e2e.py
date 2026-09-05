from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from apps.api.main import create_app


ROOT = Path(__file__).resolve().parents[1]


def _copy_developer_plugin(tmp_path: Path) -> Path:
    target = tmp_path / "hello-world"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", target)
    manifest_path = target / "superclaw-plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["id"] = "dev.superclaw.e2e-plugin"
    manifest["name"] = "E2E Plugin"
    manifest["source"] = {"type": "developer_upload", "clawhunt_problem_id": None, "developer_id": "dev_e2e"}
    manifest["provenance"] = {
        "build_type": "developer_upload",
        "source_digest": None,
        "package_digest": "sha256:" + ("0" * 64),
        "signature": "ed25519:unsigned",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    mcp_dir = target / "mcp"
    mcp_dir.mkdir(exist_ok=True)
    (mcp_dir / "server.json").write_text(
        json.dumps(
            {
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
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (target / "SUPPORT.md").write_text("Support contact: e2e@example.com\n", encoding="utf-8")
    (target / "LICENSE").write_text("Fixture license.\n", encoding="utf-8")
    (target / "PERMISSIONS.md").write_text("No elevated permissions.\n", encoding="utf-8")
    (target / "SECURITY.md").write_text("No secrets or runtime downloads.\n", encoding="utf-8")
    (target / "CHANGELOG.md").write_text("## 0.1.0\n\n- Initial fixture.\n", encoding="utf-8")
    return target


def _write_skill(tmp_path: Path) -> Path:
    skill_dir = tmp_path / "release-notes-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        """---
name: E2E Release Notes
description: Use this when turning approved capability changes into release notes.
version: 0.2.0
---

# E2E Release Notes

Summarize approved capability changes.
""",
        encoding="utf-8",
    )
    return skill_dir


def _write_company(tmp_path: Path) -> Path:
    company_dir = tmp_path / "delivery-company"
    company_dir.mkdir()
    manifest = {
        "schema_version": 1,
        "id": "acme.e2e-delivery",
        "name": "Acme E2E Delivery",
        "version": "1.0.0",
        "summary": "A local mock delivery company blueprint.",
        "kind": "company",
        "source": {"type": "developer", "developer_id": "dev_e2e"},
        "commerce": {"pricing_model": "free"},
        "roles": [
            {"name": "lead", "charter": "Plan and review delivery."},
            {"name": "impl", "charter": "Implement scoped changes.", "reports_to": "lead"},
        ],
        "equipment_requirements": {"impl": {"skills": ["release-notes"], "plugins": ["dev.superclaw.e2e-plugin"]}},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "developer", "package_digest": "", "signature": ""},
    }
    (company_dir / "superclaw-company.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return company_dir


def _upload_and_publish(client: TestClient, *, kind: str, artifact: Path) -> dict[str, object]:
    created = client.post("/v1/developer/capabilities", json={"kind": kind, "developer_id": "dev_e2e"})
    assert created.status_code == 200, created.text
    submission_id = created.json()["submission_id"]
    uploaded = client.post(f"/v1/developer/capabilities/{submission_id}/artifact", json={"package_path": str(artifact)})
    assert uploaded.status_code == 200, uploaded.text
    upload_payload = uploaded.json()
    assert upload_payload["ready_for_review"] is True
    reviewed = client.post(
        f"/api/admin/capabilities/submissions/{submission_id}/review",
        json={"decision": "publish", "actor_ref": "authority:e2e"},
    )
    assert reviewed.status_code == 200, reviewed.text
    review_payload = reviewed.json()
    assert review_payload["submission"]["published"] is True
    download = client.get(
        f"/api/admin/capabilities/{kind}/{upload_payload['capability_id']}/versions/{upload_payload['version']}/download"
    )
    assert download.status_code == 200, download.text
    return {
        "submission_id": submission_id,
        "upload": upload_payload,
        "review": review_payload,
        "download": download.json(),
    }


def test_capability_workshop_local_mock_e2e_upload_publish_download_and_sync(tmp_path: Path, monkeypatch):
    cloud_root = tmp_path / "cloud"
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CLOUD_PATH", str(cloud_root))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    flows = {
        "plugin": _upload_and_publish(client, kind="plugin", artifact=_copy_developer_plugin(tmp_path / "plugin")),
        "skill": _upload_and_publish(client, kind="skill", artifact=_write_skill(tmp_path)),
        "company": _upload_and_publish(client, kind="company", artifact=_write_company(tmp_path)),
    }
    sync = client.get("/api/admin/capabilities/registry/sync")
    assert sync.status_code == 200, sync.text
    grouped = sync.json()["capabilities"]
    assert {kind: len(grouped[kind]) for kind in ("plugin", "skill", "company")} == {"plugin": 1, "skill": 1, "company": 1}

    for kind, flow in flows.items():
        upload = flow["upload"]
        download = flow["download"]
        digest = upload["artifact_blob_digest"]
        assert download["package_digest"] == digest
        assert download["artifact_ref"].startswith("superclaw-object://capabilities/")
        assert download["download_url"].startswith(f"superclaw-local://capabilities/{kind}/")
        artifact_store = cloud_root / "artifacts" / "capabilities" / digest.removeprefix("sha256:") / "artifact"
        assert artifact_store.exists()

    pending = client.post(
        "/v1/capabilities/submissions",
        json={
            "schema_version": "superclaw.capability_review_submission.v1",
            "kind": "skill",
            "capability_id": "skill.remote-only",
            "skill_id": "skill.remote-only",
            "version": "0.3.0",
            "artifact_digest": "sha256:" + "c" * 64,
            "package_digest": "sha256:" + "c" * 64,
            "artifact_ref": "superclaw-object://capabilities/skill/remote-only/0.3.0/artifact",
            "artifact_filename": "remote-only-0.3.0.scskill",
            "package_format": "scskill",
            "name": "Remote Only",
            "summary": "Object-store-backed metadata review.",
            "auto_approve": False,
        },
    )
    assert pending.status_code == 200, pending.text
    assert pending.json()["status"] == "pending_review"
    assert client.get("/api/admin/capabilities/registry/sync").json()["count"] == 3
