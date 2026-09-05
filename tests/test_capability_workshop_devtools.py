from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
from typer.testing import CliRunner

import superclaw.capability_devtools as devtools
from superclaw.cli import app


ROOT = Path(__file__).resolve().parents[1]


def _write_skill(tmp_path: Path, *, body: str = "Use this to write release notes.") -> Path:
    skill_dir = tmp_path / "release-notes"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: Release Notes
description: Turn merged changes into clear release notes.
version: 0.2.0
---

# Release Notes

{body}
""",
        encoding="utf-8",
    )
    return skill_dir


def _write_company(tmp_path: Path) -> Path:
    company_dir = tmp_path / "delivery-company"
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
    (company_dir / "superclaw-company.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return company_dir


def _copy_plugin(tmp_path: Path) -> Path:
    plugin_dir = tmp_path / "hello-world"
    shutil.copytree(ROOT / "examples" / "plugins" / "hello-world", plugin_dir)
    return plugin_dir


def test_workshop_validate_covers_plugin_skill_and_company(tmp_path: Path):
    runner = CliRunner()

    plugin = runner.invoke(app, ["capabilities", "workshop", "validate", "plugin", str(_copy_plugin(tmp_path)), "--json"])
    assert plugin.exit_code == 0, plugin.output
    plugin_payload = json.loads(plugin.output)
    assert plugin_payload["kind"] == "plugin"
    assert plugin_payload["capability_id"] == "dev.superclaw.hello-world"
    assert plugin_payload["artifact_digest"].startswith("sha256:")

    skill = runner.invoke(app, ["capabilities", "workshop", "validate", "skill", str(_write_skill(tmp_path)), "--json"])
    assert skill.exit_code == 0, skill.output
    skill_payload = json.loads(skill.output)
    assert skill_payload["kind"] == "skill"
    assert skill_payload["capability_id"] == "skill.release-notes"
    assert skill_payload["version"] == "0.2.0"

    company = runner.invoke(app, ["capabilities", "workshop", "validate", "company", str(_write_company(tmp_path)), "--json"])
    assert company.exit_code == 0, company.output
    company_payload = json.loads(company.output)
    assert company_payload["kind"] == "company"
    assert company_payload["capability_id"] == "acme.delivery"


def test_workshop_build_skill_is_deterministic_and_rejects_secrets(tmp_path: Path):
    runner = CliRunner()
    skill_dir = _write_skill(tmp_path)
    dist = tmp_path / "dist"

    first = runner.invoke(app, ["capabilities", "workshop", "build", "skill", str(skill_dir), "--dist-dir", str(dist), "--json"])
    second = runner.invoke(app, ["capabilities", "workshop", "build", "skill", str(skill_dir), "--dist-dir", str(dist), "--json"])

    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output
    first_payload = json.loads(first.output)
    second_payload = json.loads(second.output)
    assert first_payload["artifact_digest"] == second_payload["artifact_digest"]
    assert Path(first_payload["package_path"]).suffix == ".scskill"

    (skill_dir / "SKILL.md").write_text(
        """---
name: Secret Skill
description: Bad package.
version: 0.1.0
api_key: ghp_abcdefghijklmnop
---

# Bad

Body.
""",
        encoding="utf-8",
    )
    rejected = runner.invoke(app, ["capabilities", "workshop", "validate", "skill", str(skill_dir), "--json"])
    assert rejected.exit_code == 1
    assert "secret" in json.loads(rejected.output)["error"].lower()


def test_workshop_submit_review_and_status_use_api_contract_without_auto_approval(tmp_path: Path, monkeypatch):
    runner = CliRunner()
    skill_dir = _write_skill(tmp_path)
    captured: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *, timeout: float):
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url: str, *, json: dict):
            captured["post_url"] = url
            captured["request"] = json
            return httpx.Response(
                200,
                json={"ok": True, "submission_id": "sub_123", "status": "pending_review"},
                request=httpx.Request("POST", url),
            )

        def get(self, url: str):
            captured["get_url"] = url
            return httpx.Response(
                200,
                json={
                    "schema_version": "superclaw.capability_review_status.v1",
                    "submission_id": "sub_123",
                    "kind": "skill",
                    "capability_id": "skill.release-notes",
                    "version": "0.2.0",
                    "status": "pending_review",
                },
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(devtools.httpx, "Client", FakeClient)

    submitted = runner.invoke(
        app,
        [
            "capabilities",
            "workshop",
            "submit-review",
            "skill",
            str(skill_dir),
            "--api-url",
            "https://review.example.test",
            "--artifact-ref",
            "superclaw-object://capabilities/skill/release-notes/0.2.0/artifact",
            "--developer-ref",
            "developer:acme",
            "--no-sign",
            "--json",
        ],
    )
    assert submitted.exit_code == 0, submitted.output
    payload = json.loads(submitted.output)
    request = captured["request"]
    assert payload["submission_id"] == "sub_123"
    assert captured["post_url"] == "https://review.example.test/v1/capabilities/submissions"
    assert request["schema_version"] == "superclaw.capability_review_submission.v1"
    assert request["kind"] == "skill"
    assert request["package_digest"].startswith("sha256:")
    assert request["artifact_ref"].startswith("superclaw-object://")
    assert request["auto_approve"] is False
    assert str(tmp_path) not in json.dumps(request)

    status = runner.invoke(
        app,
        [
            "capabilities",
            "workshop",
            "review-status",
            "sub_123",
            "--api-url",
            "https://review.example.test",
            "--json",
        ],
    )
    assert status.exit_code == 0, status.output
    assert captured["get_url"] == "https://review.example.test/v1/capabilities/submissions/sub_123"
    assert json.loads(status.output)["submission"]["status"] == "pending_review"


def test_workshop_registry_sync_lists_approved_metadata_and_feeds_catalog(tmp_path: Path):
    runner = CliRunner()
    registry = tmp_path / "approved.json"
    registry.write_text(
        json.dumps(
            {
                "schema_version": "clawhunt.admin.capability_registry.v1",
                "entries": [
                    {
                        "kind": "skill",
                        "capability_id": "skill.release-notes",
                        "version": "0.2.0",
                        "package_digest": "sha256:" + "a" * 64,
                        "status": "approved",
                        "name": "Release Notes",
                        "summary": "Write release notes.",
                    },
                    {
                        "kind": "company",
                        "company_id": "acme.delivery",
                        "version": "1.0.0",
                        "package_digest": "sha256:" + "b" * 64,
                        "status": "published",
                        "name": "Acme Delivery",
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    cloud_root = tmp_path / "cloud"

    listed = runner.invoke(app, ["capabilities", "workshop", "list-registry", str(registry), "--json"])
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["count"] == 2

    synced = runner.invoke(
        app,
        ["capabilities", "workshop", "sync-registry", str(registry), "--cloud-root", str(cloud_root), "--json"],
    )
    assert synced.exit_code == 0, synced.output
    assert json.loads(synced.output)["count"] == 2

    catalog = runner.invoke(
        app,
        ["catalog", "list", "--kind", "skill", "--cloud-root", str(cloud_root), "--json"],
    )
    assert catalog.exit_code == 0, catalog.output
    items = json.loads(catalog.output)["items"]
    assert items[0]["id"] == "skill.release-notes"
    assert items[0]["pinned_digest"] == "sha256:" + "a" * 64
