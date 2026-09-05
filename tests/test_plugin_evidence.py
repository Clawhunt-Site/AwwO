from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.plugin_evidence import clear_plugin_evidence, diagnose_plugin_runtime, list_plugin_evidence, prune_plugin_evidence


def _write_record(root: Path, artifact_id: str, *, status: str, finished_at: datetime, **extra: object) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    record = {
        "run_id": "run_plugin_retention",
        "plugin_id": "dev.superclaw.retention",
        "plugin_version": "0.1.0",
        "package_digest": "sha256:" + ("1" * 64),
        "tool_name": "retention_check",
        "started_at": (finished_at - timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
        "finished_at": finished_at.isoformat().replace("+00:00", "Z"),
        "status": status,
        "entitlement_id": "ent_123",
        "input_digest": "sha256:" + ("2" * 64),
        "output_digest": "sha256:" + ("3" * 64),
        "evidence_artifact_id": artifact_id,
        "policy_decision": "allowed" if status == "ok" else "PLUGIN_RUNTIME_ERROR",
        "sandbox_exit_status": 0 if status == "ok" else 1,
        **extra,
    }
    path = root / f"{artifact_id}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def test_plugin_evidence_lists_sanitized_summaries(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime(2026, 6, 1, tzinfo=UTC)
    _write_record(root, "plugininv_ok", status="ok", finished_at=now)
    _write_record(root, "plugininv_denied", status="denied", finished_at=now)

    rows = list_plugin_evidence(root)

    assert [row["artifact_id"] for row in rows] == ["plugininv_denied", "plugininv_ok"]
    assert rows[0]["locked"] is True
    assert rows[0]["lock_reason"] == "denied"
    assert rows[0]["relative_path"] == "plugininv_denied.json"
    assert "output_digest" not in rows[0]
    assert str(root) not in json.dumps(rows, ensure_ascii=False)


def test_plugin_evidence_prunes_only_expired_success_records(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime(2026, 6, 1, tzinfo=UTC)
    expired_ok = _write_record(root, "plugininv_expired_ok", status="ok", finished_at=now - timedelta(days=8))
    recent_ok = _write_record(root, "plugininv_recent_ok", status="ok", finished_at=now - timedelta(days=1))
    failed = _write_record(root, "plugininv_failed", status="error", finished_at=now - timedelta(days=30))
    locked = _write_record(
        root,
        "plugininv_disputed",
        status="ok",
        finished_at=now - timedelta(days=30),
        retention_lock={"active": True, "reason": "dispute"},
    )

    result = prune_plugin_evidence(root, retention_days=7, now=now)

    assert result.deleted == ["plugininv_expired_ok"]
    assert sorted(result.kept) == ["plugininv_recent_ok"]
    assert sorted(result.locked) == ["plugininv_disputed", "plugininv_failed"]
    assert not expired_ok.exists()
    assert recent_ok.exists()
    assert failed.exists()
    assert locked.exists()


def test_plugin_evidence_clear_refuses_locked_or_unsafe_ids(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime(2026, 6, 1, tzinfo=UTC)
    clearable = _write_record(root, "plugininv_clearable", status="ok", finished_at=now)
    locked = _write_record(root, "plugininv_locked", status="denied", finished_at=now)

    result = clear_plugin_evidence(["plugininv_clearable", "plugininv_locked", "plugininv_missing"], root)

    assert result.deleted == ["plugininv_clearable"]
    assert result.locked == ["plugininv_locked"]
    assert result.missing == ["plugininv_missing"]
    assert not clearable.exists()
    assert locked.exists()
    with pytest.raises(ValueError, match="unsafe evidence artifact id"):
        clear_plugin_evidence(["../plugininv_escape"], root)


def test_plugin_evidence_cli_lists_and_prunes_without_raw_paths(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime.now(UTC)
    _write_record(root, "plugininv_old", status="ok", finished_at=now - timedelta(days=8))
    _write_record(root, "plugininv_locked", status="timeout", finished_at=now - timedelta(days=8))

    runner = CliRunner()
    listed = runner.invoke(app, ["plugin", "evidence-list", "--artifact-dir", str(root), "--json"])
    assert listed.exit_code == 0, listed.output
    listed_payload = json.loads(listed.output)
    assert {row["artifact_id"] for row in listed_payload["evidence"]} == {"plugininv_old", "plugininv_locked"}
    assert str(root) not in listed.output

    pruned = runner.invoke(app, ["plugin", "evidence-prune", "--artifact-dir", str(root), "--retention-days", "7", "--json"])
    assert pruned.exit_code == 0, pruned.output
    pruned_payload = json.loads(pruned.output)
    assert pruned_payload["deleted"] == ["plugininv_old"]
    assert pruned_payload["locked"] == ["plugininv_locked"]
    assert not (root / "plugininv_old.json").exists()
    assert (root / "plugininv_locked.json").exists()


def test_plugin_evidence_cli_clear_deletes_only_unlocked_ids(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime.now(UTC)
    _write_record(root, "plugininv_clearable", status="ok", finished_at=now)
    _write_record(root, "plugininv_locked", status="timeout", finished_at=now)

    result = CliRunner().invoke(
        app,
        [
            "plugin",
            "evidence-clear",
            "plugininv_clearable",
            "plugininv_locked",
            "plugininv_missing",
            "--artifact-dir",
            str(root),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["deleted"] == ["plugininv_clearable"]
    assert payload["locked"] == ["plugininv_locked"]
    assert payload["missing"] == ["plugininv_missing"]
    assert not (root / "plugininv_clearable.json").exists()
    assert (root / "plugininv_locked.json").exists()
    assert str(root) not in result.output


def test_plugin_runtime_diagnostics_reports_slow_failures_and_sandbox_kills_without_raw_leaks(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime(2026, 6, 1, tzinfo=UTC)
    secret = "cph_" + "secret1234567890123"
    _write_record(
        root,
        "plugininv_slow",
        status="ok",
        finished_at=now,
        started_at=(now - timedelta(seconds=35)).isoformat().replace("+00:00", "Z"),
        raw_stderr=f"do not leak {secret}",
    )
    _write_record(root, "plugininv_fail_1", status="error", finished_at=now, raw_output=f"do not leak {secret}")
    _write_record(root, "plugininv_fail_2", status="timeout", finished_at=now)
    _write_record(root, "plugininv_sandbox_1", status="denied", finished_at=now, policy_decision="PLUGIN_SANDBOX_VIOLATION")
    _write_record(root, "plugininv_sandbox_2", status="denied", finished_at=now, policy_decision="PLUGIN_SANDBOX_VIOLATION")

    report = diagnose_plugin_runtime(root, slow_call_ms=30_000, failure_rate_threshold=0.5, failure_rate_min_invocations=3)

    codes = {finding["code"] for finding in report["findings"]}
    assert report["ok"] is False
    assert report["artifact_count"] == 5
    assert report["summary"]["failures"] == 4
    assert report["summary"]["slow_calls"] == 1
    assert report["summary"]["sandbox_kills"] == 2
    assert "PLUGIN_RUNTIME_SLOW_CALL" in codes
    assert "PLUGIN_RUNTIME_HIGH_FAILURE_RATE" in codes
    assert "PLUGIN_RUNTIME_REPEATED_SANDBOX_KILLS" in codes
    assert "plugininv_slow" in json.dumps(report)
    assert secret not in json.dumps(report)
    assert str(root) not in json.dumps(report)


def test_plugin_runtime_diagnostics_ignores_invalid_records_and_validates_thresholds(tmp_path: Path):
    root = tmp_path / "artifacts"
    root.mkdir(parents=True)
    (root / "broken.json").write_text("{not-json", encoding="utf-8")

    report = diagnose_plugin_runtime(root)

    assert report["ok"] is True
    assert report["artifact_count"] == 0
    assert report["findings"] == []
    with pytest.raises(ValueError, match="slow_call_ms"):
        diagnose_plugin_runtime(root, slow_call_ms=-1)
    with pytest.raises(ValueError, match="failure_rate_threshold"):
        diagnose_plugin_runtime(root, failure_rate_threshold=1.1)


def test_plugin_diagnostics_cli_outputs_sanitized_runtime_report(tmp_path: Path):
    root = tmp_path / "artifacts"
    now = datetime.now(UTC)
    secret = "cph_" + "secret1234567890123"
    _write_record(root, "plugininv_ok", status="ok", finished_at=now)
    _write_record(root, "plugininv_fail", status="error", finished_at=now, raw_output=secret)

    result = CliRunner().invoke(
        app,
        [
            "plugin",
            "diagnostics",
            "--artifact-dir",
            str(root),
            "--failure-rate-threshold",
            "0.5",
            "--failure-rate-min-invocations",
            "1",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["summary"]["failures"] == 1
    assert payload["findings"][0]["code"] == "PLUGIN_RUNTIME_HIGH_FAILURE_RATE"
    assert secret not in result.output
    assert str(root) not in result.output
