from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_ingestion import ClawHuntPluginIngestionError, ingest_clawhunt_delivery_plugin
from superclaw.plugin_proxy import invoke_cached_plugin_tool
from superclaw.plugins import compute_package_digest, load_plugin_package, verify_plugin_package


ROOT = Path(__file__).resolve().parents[1]


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_key, base64.b64encode(public_bytes).decode("ascii")


def _sign_plugin(plugin_dir: Path, private_key: Ed25519PrivateKey) -> None:
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


def _write_reusable_delivery(root: Path) -> Path:
    (root / "bin").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "evidence-fixtures").mkdir()
    (root / "evidence").mkdir()
    (root / "bin" / "repo-report").write_text(
        "#!/usr/bin/env sh\nset -eu\nprintf '%s\\n' '{\"text\":\"clawhunt reusable plugin ok\",\"artifacts\":[]}'\n",
        encoding="utf-8",
    )
    (root / "bin" / "repo-report").chmod(0o755)
    (root / "tests" / "smoke.sh").write_text("#!/usr/bin/env sh\nset -eu\nexit 0\n", encoding="utf-8")
    (root / "tests" / "smoke.sh").chmod(0o755)
    (root / "evidence-fixtures" / "clawhunt-replay.json").write_text('{"ok":true}\n', encoding="utf-8")
    (root / "evidence" / "bundle.json").write_text(
        json.dumps({"run_id": "run_clawhunt", "artifacts": [{"kind": "worker-log", "path": "public.log"}]}),
        encoding="utf-8",
    )
    manifest = {
        "accepted": True,
        "problem_id": "problem_123",
        "title": "Reusable repository report",
        "summary": "Turns a reusable ClawHunt delivery wrapper into a SuperClaw plugin.",
        "submitter_id": "dev_123",
        "maintainer_id": "maintainer_456",
        "package_owner_id": "owner_789",
        "bounty_sponsor_id": "sponsor_001",
        "evidence_bundle_ref": "evidence/bundle.json",
        "acceptance_tests": ["tests/smoke.sh"],
        "evidence_fixtures": ["evidence-fixtures/clawhunt-replay.json"],
        "replay_input": {"path": "."},
        "source_artifacts": [{"kind": "wrapper", "path": "bin/repo-report"}],
        "wrapper": {
            "plugin_id": "dev.superclaw.clawhunt-repo-report",
            "name": "ClawHunt Repo Report",
            "version": "0.1.0",
            "tool_name": "repo_report",
            "entrypoint": "bin/repo-report",
            "description": "Run the reusable ClawHunt repository report wrapper.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            "output_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "artifacts": {"type": "array", "items": {"type": "object"}},
                },
                "required": ["text", "artifacts"],
                "additionalProperties": False,
            },
            "permissions": {"filesystem": [{"mode": "read", "scope": "workspace"}], "network": [], "environment": []},
        },
    }
    (root / "delivery-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return root


def test_clawhunt_ingestion_builds_signable_plugin_package_and_runs_through_proxy(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    output_root = tmp_path / "out"

    result = ingest_clawhunt_delivery_plugin(delivery_root, output_root=output_root)

    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    schema = json.loads((ROOT / "schemas" / "superclaw-plugin.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(manifest)
    assert manifest["source"] == {
        "type": "clawhunt_delivery",
        "clawhunt_problem_id": "problem_123",
        "developer_id": "dev_123",
    }
    assert manifest["runtime"]["entrypoint"] == "bin/repo-report"
    assert "replay/plugin-invocation.json" in manifest["acceptance"]["evidence_fixtures"]
    assert manifest["resource_profile"] == {
        "latency_class": "standard",
        "expected_p95_latency_ms": 10000,
        "cpu_class": "medium",
        "memory_class": "high",
        "io_profile": "filesystem_read",
    }
    assert manifest["provenance"]["build_type"] == "clawhunt_delivery"
    assert manifest["provenance"]["source_digest"].startswith("sha256:")
    assert metadata["problem_id"] == "problem_123"
    assert metadata["evidence_bundle_ref"] == "evidence/bundle.json"
    assert metadata["mcp_server_config"] == "mcp/server.json"
    assert metadata["replay_fixture"] == "replay/plugin-invocation.json"
    assert metadata["revenue_attribution"] == {
        "schema_version": "0.1.0",
        "source": "clawhunt_delivery",
        "policy": "attribution_only",
        "settlement_status": "not_settled",
        "problem_id": "problem_123",
        "pricing_model": "free",
        "metering": "per_invocation",
        "original_submitter_id": "dev_123",
        "package_owner_id": "owner_789",
        "maintainer_id": "maintainer_456",
        "bounty_sponsor_id": "sponsor_001",
    }
    assert "revenue_attribution" not in manifest
    assert str(delivery_root) not in json.dumps([manifest, metadata], ensure_ascii=False)
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in json.dumps([manifest, metadata], ensure_ascii=False)

    mcp_config = json.loads((result.package_root / "mcp" / "server.json").read_text(encoding="utf-8"))
    replay = json.loads((result.package_root / "replay" / "plugin-invocation.json").read_text(encoding="utf-8"))
    assert mcp_config == {
        "schema_version": "0.1.0",
        "plugin_id": "dev.superclaw.clawhunt-repo-report",
        "plugin_version": "0.1.0",
        "transport": "stdio",
        "entrypoint": "bin/repo-report",
        "args": [],
        "proxy_required": True,
        "tools": [
            {
                "name": "repo_report",
                "input_schema": manifest["tools"][0]["input_schema"],
                "output_schema": manifest["tools"][0]["output_schema"],
            }
        ],
    }
    assert replay["plugin_id"] == "dev.superclaw.clawhunt-repo-report"
    assert replay["tool_name"] == "repo_report"
    assert replay["input"] == {"path": "."}
    assert replay["evidence_bundle_ref"] == "evidence/bundle.json"
    assert replay["requires_superclaw_proxy"] is True
    assert str(delivery_root) not in json.dumps([mcp_config, replay], ensure_ascii=False)
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in json.dumps([mcp_config, replay], ensure_ascii=False)

    private_key, public_key = _keypair()
    _sign_plugin(result.package_root, private_key)
    shutil.rmtree(delivery_root)
    verify_result = verify_plugin_package(result.package_root, public_key=public_key, cache_root=tmp_path / "cache")
    proxy_result = invoke_cached_plugin_tool(
        verify_result.plugin_id,
        "repo_report",
        {"path": "."},
        cache_root=tmp_path / "cache",
        public_key=public_key,
        artifact_dir=tmp_path / "artifacts",
    )

    assert proxy_result.ok is True
    assert proxy_result.model_response == {"text": "clawhunt reusable plugin ok", "artifacts": []}


@pytest.mark.parametrize("evil_id", ["../escaped-victim", "..", "../../escaped-victim"])
def test_clawhunt_ingestion_rejects_path_traversing_plugin_id(tmp_path: Path, evil_id: str):
    """A malicious delivery manifest must not be able to rmtree/write outside
    output_root via plugin_id/version path traversal (regression for the
    arbitrary directory-delete primitive)."""
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    output_root = tmp_path / "out"
    output_root.mkdir()
    victim = tmp_path / "escaped-victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious", encoding="utf-8")

    mpath = delivery_root / "delivery-manifest.json"
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    manifest["wrapper"]["plugin_id"] = evil_id
    manifest["wrapper"]["version"] = "."
    mpath.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(ClawHuntPluginIngestionError):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=output_root)
    assert (victim / "keep.txt").read_text(encoding="utf-8") == "precious"  # untouched


def test_clawhunt_ingestion_rejects_absolute_plugin_id(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    output_root = tmp_path / "out"
    output_root.mkdir()
    victim = tmp_path / "abs-victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious", encoding="utf-8")

    mpath = delivery_root / "delivery-manifest.json"
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    manifest["wrapper"]["plugin_id"] = str(victim)  # absolute path
    manifest["wrapper"]["version"] = "."
    mpath.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(ClawHuntPluginIngestionError):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=output_root)
    assert (victim / "keep.txt").read_text(encoding="utf-8") == "precious"


def test_clawhunt_ingestion_cli_emits_package_candidate(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")

    result = CliRunner().invoke(app, ["plugin", "ingest-clawhunt", str(delivery_root), "--output-root", str(tmp_path / "out"), "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["plugin_id"] == "dev.superclaw.clawhunt-repo-report"
    assert payload["requires_signing"] is True
    assert Path(payload["manifest_path"]).exists()


def test_clawhunt_ingestion_generates_replay_input_from_schema(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["replay_input"]
    manifest["wrapper"]["input_schema"] = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "recursive": {"type": "boolean"},
            "limit": {"type": "integer"},
        },
        "required": ["path", "recursive", "limit"],
        "additionalProperties": False,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    result = ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")

    replay = json.loads((result.package_root / "replay" / "plugin-invocation.json").read_text(encoding="utf-8"))
    assert replay["input"] == {"path": ".", "recursive": False, "limit": 0}
    assert replay["expected_output_schema"] == manifest["wrapper"]["output_schema"]


def test_clawhunt_ingestion_requires_paid_revenue_attribution_ids(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["wrapper"]["pricing_model"] = "paid_per_invocation"
    del manifest["submitter_id"]
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    with pytest.raises(ClawHuntPluginIngestionError, match="requires submitter_id"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")

    manifest["submitter_id"] = "dev_123"
    del manifest["package_owner_id"]
    del manifest["maintainer_id"]
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with pytest.raises(ClawHuntPluginIngestionError, match="requires package_owner_id or maintainer_id"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")


def test_clawhunt_ingestion_rejects_missing_evidence_bundle(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    (delivery_root / "evidence" / "bundle.json").unlink()

    with pytest.raises(ClawHuntPluginIngestionError, match="declared delivery file missing"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")

    assert not (tmp_path / "out").exists()


def test_clawhunt_ingestion_rejects_one_off_delivery_without_wrapper(tmp_path: Path):
    delivery_root = tmp_path / "delivery"
    delivery_root.mkdir()
    (delivery_root / "delivery-manifest.json").write_text(
        json.dumps({"accepted": True, "problem_id": "problem_123", "evidence_bundle_ref": "evidence.json"}),
        encoding="utf-8",
    )

    with pytest.raises(ClawHuntPluginIngestionError, match="missing reusable wrapper"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")


def test_clawhunt_ingestion_rejects_wrapper_without_stable_output_schema(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["wrapper"]["output_schema"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ClawHuntPluginIngestionError, match="output_schema"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")


def test_clawhunt_ingestion_rejects_unsafe_or_private_runtime_contracts(tmp_path: Path):
    delivery_root = _write_reusable_delivery(tmp_path / "delivery")
    manifest_path = delivery_root / "delivery-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["wrapper"]["entrypoint"] = "../outside"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ClawHuntPluginIngestionError, match="unsafe delivery path"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")

    manifest["wrapper"]["entrypoint"] = "bin/repo-report"
    manifest["wrapper"]["requires_private_account_state"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ClawHuntPluginIngestionError, match="private account state"):
        ingest_clawhunt_delivery_plugin(delivery_root, output_root=tmp_path / "out")
