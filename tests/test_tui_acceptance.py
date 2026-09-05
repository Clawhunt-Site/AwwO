import json

from superclaw.tui_acceptance import run_tui_acceptance, tui_acceptance_report_path


def test_tui_acceptance_report_path_uses_env_override(tmp_path, monkeypatch):
    configured = tmp_path / "custom" / "tui-report.json"
    monkeypatch.setenv("SUPERCLAW_TUI_ACCEPTANCE_REPORT", str(configured))

    resolved = tui_acceptance_report_path(workspace_root=tmp_path)

    assert resolved == configured.resolve()


def test_run_tui_acceptance_writes_report_and_stops_after_failure(tmp_path):
    calls: list[str] = []

    def ok_step():
        calls.append("pytest")
        return {
            "name": "pytest",
            "command": "pytest tests/test_tui.py",
            "started_at": "2026-06-04T08:00:00Z",
            "duration_ms": 100,
            "code": 0,
            "signal": None,
            "ok": True,
            "stdout_tail": ["ok"],
            "stderr_tail": [],
        }

    def fail_step():
        calls.append("launch_smoke")
        return {
            "name": "launch_smoke",
            "command": "python -m superclaw.cli tui",
            "started_at": "2026-06-04T08:00:01Z",
            "duration_ms": 200,
            "code": 1,
            "signal": None,
            "ok": False,
            "stdout_tail": [],
            "stderr_tail": ["failed"],
        }

    def skipped_step():
        calls.append("snapshot_export")
        return {
            "name": "snapshot_export",
            "command": "python -m superclaw.cli tui --snapshot-file",
            "started_at": "2026-06-04T08:00:02Z",
            "duration_ms": 100,
            "code": 0,
            "signal": None,
            "ok": True,
            "stdout_tail": ["ok"],
            "stderr_tail": [],
        }

    report_path = tmp_path / "reports" / "tui-acceptance.json"
    snapshot_path = tmp_path / "snapshots" / "tui-snapshot.json"
    report = run_tui_acceptance(
        workspace_root=tmp_path,
        report_file=report_path,
        snapshot_file=snapshot_path,
        step_runners=[
            ("pytest", ok_step),
            ("launch_smoke", fail_step),
            ("snapshot_export", skipped_step),
        ],
    )

    assert report["success"] is False
    assert report["failed_step"] == "launch_smoke"
    assert report["snapshot_path"] == str(snapshot_path.resolve())
    assert [step["name"] for step in report["steps"]] == ["pytest", "launch_smoke"]
    assert calls == ["pytest", "launch_smoke"]
    persisted = json.loads(report_path.read_text(encoding="utf-8"))
    assert persisted["failed_step"] == "launch_smoke"
    assert persisted["snapshot_path"] == str(snapshot_path.resolve())
    assert persisted["steps"][1]["stderr_tail"] == ["failed"]
