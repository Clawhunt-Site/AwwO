"""Operator-facing local export (P0c, Tier A cost): formats, allowlist, redaction,
window, manifest, local-path enforcement."""
from __future__ import annotations

import csv
import json
import sqlite3

import pytest

from superclaw import operator_export as oe
from superclaw.models import CostEvent
from superclaw.state import StateStore


def _store_with_costs(tmp_path, n=3):
    store = StateStore(tmp_path / "state.db")
    for i in range(n):
        store.record_cost_event(
            CostEvent(
                idempotency_key=f"idem_{i}",
                run_id=f"run_{i}",
                model="claude-opus-4-8",
                input_tokens=10 + i,
                output_tokens=20,
                duration_seconds=1.5,
                cost_cents=5,
                billing_lane="byo",
                occurred_at=1000.0 + i,
            )
        )
    return store


def test_export_jsonl_roundtrip_and_manifest(tmp_path):
    store = _store_with_costs(tmp_path, 3)
    out = tmp_path / "cost.jsonl"
    manifest = oe.export(store, kind="cost", out=str(out), fmt="jsonl", now=42.0)

    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").strip().splitlines()]
    assert len(rows) == 3
    assert {r["run_id"] for r in rows} == {"run_0", "run_1", "run_2"}
    assert rows[0]["model"] == "claude-opus-4-8"
    assert "raw_usage" not in rows[0]  # allowlist drops the non-scalar provider payload

    assert manifest["schema_version"] == oe.EXPORT_SCHEMA_VERSION
    assert manifest["kind"] == "cost"
    assert manifest["format"] == "jsonl"
    assert manifest["row_count"] == 3
    assert manifest["redaction"] == "allowlist"
    assert manifest["exported_at"] == 42.0
    assert len(manifest["content_sha256"]) == 64

    sidecar = tmp_path / "cost.jsonl.manifest.json"
    assert json.loads(sidecar.read_text(encoding="utf-8"))["row_count"] == 3


def test_export_csv(tmp_path):
    store = _store_with_costs(tmp_path, 2)
    out = tmp_path / "cost.csv"
    oe.export(store, kind="cost", out=str(out), fmt="csv")
    with out.open(encoding="utf-8") as fh:
        reader = list(csv.DictReader(fh))
    assert len(reader) == 2
    assert "run_id" in reader[0]
    assert "raw_usage" not in reader[0]


def test_export_sqlite(tmp_path):
    store = _store_with_costs(tmp_path, 2)
    out = tmp_path / "cost.db"
    oe.export(store, kind="cost", out=str(out), fmt="sqlite")
    conn = sqlite3.connect(str(out))
    try:
        rows = conn.execute("SELECT run_id, model FROM cost ORDER BY run_id").fetchall()
    finally:
        conn.close()
    assert len(rows) == 2
    assert all(r[1] == "claude-opus-4-8" for r in rows)


def test_out_rejects_url():
    for bad in ("https://evil.example/x.jsonl", "s3://bucket/x", "file:///etc/passwd"):
        with pytest.raises(oe.ExportError):
            oe.resolve_out_path(bad)


def test_unknown_kind_and_format(tmp_path):
    store = _store_with_costs(tmp_path, 1)
    with pytest.raises(oe.ExportError):
        oe.export(store, kind="bogus", out=str(tmp_path / "x.jsonl"), fmt="jsonl")
    with pytest.raises(oe.ExportError):
        oe.export(store, kind="cost", out=str(tmp_path / "x.parquet"), fmt="parquet")


def test_scrub_redacts_secret_and_drops_nonscalar():
    scrubbed = oe._scrub("token=ghp_" + "a" * 20)
    assert "ghp_" not in scrubbed and "[REDACTED]" in scrubbed
    assert oe._scrub({"k": "v"}) == "<non-scalar>"
    assert oe._scrub(["x"]) == "<non-scalar>"
    assert oe._scrub(123) == 123
    assert oe._scrub(None) is None
    assert oe._scrub(True) is True


def test_export_has_no_redaction_off_switch():
    # Contract: redaction is unconditional. The public surface must not expose a
    # way to disable it, and the manifest never reports "none".
    import inspect

    params = inspect.signature(oe.export).parameters
    assert "redact" not in params
    assert inspect.signature(oe._scrub).parameters.keys() == {"value"}


def test_io_error_is_wrapped_as_export_error(tmp_path):
    store = _store_with_costs(tmp_path, 1)
    # --out points at an existing directory -> the write raises IsADirectoryError
    # (an OSError); it must surface as ExportError, never a raw traceback.
    target_dir = tmp_path / "adir"
    target_dir.mkdir()
    with pytest.raises(oe.ExportError):
        oe.export(store, kind="cost", out=str(target_dir), fmt="jsonl")


def test_time_window_filters(tmp_path):
    store = _store_with_costs(tmp_path, 3)  # occurred_at 1000, 1001, 1002
    out = tmp_path / "win.jsonl"
    manifest = oe.export(store, kind="cost", out=str(out), fmt="jsonl", since=1001.0, until=1002.0)
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").strip().splitlines()]
    assert len(rows) == 1  # half-open [1001, 1002) -> only run_1
    assert rows[0]["run_id"] == "run_1"
    assert manifest["window"] == {"since": 1001.0, "until": 1002.0}


# -- run-condition export (P1) ---------------------------------------------


def _store_with_run(tmp_path):
    store = StateStore(tmp_path / "state.db")
    session = store.create_run("goal_rc")
    session.execution_context = {"backend_policy": "claude", "model": "claude-opus-4-8", "budget_seconds": 60}
    store.save_run(session)
    return store, session.run_id


def test_export_run_condition_writes_json_and_envelope(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    out = tmp_path / "cond.json"
    envelope = oe.export_run_condition(
        store, run_id=run_id, out=str(out), telemetry_path=tmp_path / "absent.db",
        probe_external_tools=False, now=99.0,
    )
    assert envelope["kind"] == "run_condition"
    assert envelope["run_id"] == run_id
    assert envelope["exported_at"] == 99.0
    assert envelope["completeness"] == "incomplete"  # telemetry absent
    assert len(envelope["content_sha256"]) == 64

    manifest = json.loads(out.read_text(encoding="utf-8"))
    assert manifest["_meta"]["kind"] == "run_condition"
    assert manifest["run"]["run_id"] == run_id
    assert manifest["execution_parameters"]["model"] == "claude-opus-4-8"

    sidecar = tmp_path / "cond.json.manifest.json"
    assert json.loads(sidecar.read_text(encoding="utf-8"))["run_id"] == run_id
    # both file + sidecar hardened to 0600
    assert (out.stat().st_mode & 0o777) == 0o600
    assert (sidecar.stat().st_mode & 0o777) == 0o600


def test_export_run_condition_unknown_run_fails_closed(tmp_path):
    store, _ = _store_with_run(tmp_path)
    out = tmp_path / "cond.json"
    with pytest.raises(oe.ExportError):
        oe.export_run_condition(store, run_id="run_nope", out=str(out), probe_external_tools=False)
    assert not out.exists()  # nothing written on a failed build


def test_export_run_condition_rejects_url(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    with pytest.raises(oe.ExportError):
        oe.export_run_condition(store, run_id=run_id, out="https://evil.example/c.json", probe_external_tools=False)


def test_export_run_condition_require_complete_fails_on_missing_telemetry(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    out = tmp_path / "cond.json"
    with pytest.raises(oe.ExportError):
        oe.export_run_condition(
            store, run_id=run_id, out=str(out), telemetry_path=tmp_path / "absent.db",
            require_complete=True, probe_external_tools=False,
        )
    assert not out.exists()


def test_cli_export_run_condition_dispatch(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_PATH", str(tmp_path / "telemetry.db"))
    store = StateStore(state_path)
    session = store.create_run("goal_cli")
    session.execution_context = {"backend_policy": "claude", "model": "claude-opus-4-8"}
    store.save_run(session)

    out = tmp_path / "cond.json"
    result = CliRunner().invoke(
        app,
        ["export", "--kind", "run-condition", "--run-id", session.run_id, "--out", str(out), "--no-probe-tools"],
    )
    assert result.exit_code == 0, result.output
    manifest = json.loads(out.read_text(encoding="utf-8"))
    assert manifest["_meta"]["kind"] == "run_condition"
    assert manifest["run"]["run_id"] == session.run_id


def test_cli_export_run_condition_requires_run_id(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    result = CliRunner().invoke(
        app, ["export", "--kind", "run-condition", "--out", str(tmp_path / "x.json")]
    )
    assert result.exit_code == 1
    # A pure parameter error must fail-closed WITHOUT initializing the state store.
    assert not state_path.exists()


def test_export_files_are_0600(tmp_path):
    store = _store_with_costs(tmp_path, 1)
    out = tmp_path / "perm.jsonl"
    oe.export(store, kind="cost", out=str(out), fmt="jsonl")
    assert (out.stat().st_mode & 0o777) == 0o600
    assert ((tmp_path / "perm.jsonl.manifest.json").stat().st_mode & 0o777) == 0o600


def test_empty_export(tmp_path):
    store = StateStore(tmp_path / "state.db")
    out = tmp_path / "empty.jsonl"
    manifest = oe.export(store, kind="cost", out=str(out), fmt="jsonl")
    assert manifest["row_count"] == 0
    assert out.read_text(encoding="utf-8") == ""


# -- diagnostic bundle export + diagnose CLI (P2a) --------------------------


def test_export_diagnostic_bundle_writes_json_and_envelope(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    out = tmp_path / "diag.json"
    envelope = oe.export_diagnostic_bundle(
        store, run_id=run_id, out=str(out), telemetry_path=tmp_path / "absent.db", now=7.0
    )
    assert envelope["kind"] == "run_diagnostic"
    assert envelope["decision_replay"] == "unavailable"
    assert envelope["completeness"] == "incomplete"  # telemetry absent
    assert len(envelope["content_sha256"]) == 64
    bundle = json.loads(out.read_text(encoding="utf-8"))
    assert bundle["_meta"]["mode"] == "diagnostic_context"
    assert bundle["run"]["run_id"] == run_id
    assert (out.stat().st_mode & 0o777) == 0o600
    sidecar = tmp_path / "diag.json.manifest.json"
    assert (sidecar.stat().st_mode & 0o777) == 0o600


def test_export_diagnostic_bundle_unknown_run_fails_closed(tmp_path):
    store, _ = _store_with_run(tmp_path)
    out = tmp_path / "diag.json"
    with pytest.raises(oe.ExportError):
        oe.export_diagnostic_bundle(store, run_id="run_nope", out=str(out))
    assert not out.exists()


def test_export_diagnostic_bundle_rejects_url(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    with pytest.raises(oe.ExportError):
        oe.export_diagnostic_bundle(store, run_id=run_id, out="https://evil.example/d.json")


def test_cli_diagnose_stdout(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_PATH", str(tmp_path / "telemetry.db"))
    store = StateStore(state_path)
    session = store.create_run("goal_cli_diag")
    session.execution_context = {"backend_policy": "claude", "model": "claude-opus-4-8"}
    store.save_run(session)

    result = CliRunner().invoke(app, ["diagnose", session.run_id])
    assert result.exit_code == 0, result.output
    bundle = json.loads(result.output)
    assert bundle["_meta"]["mode"] == "diagnostic_context"
    assert bundle["_meta"]["decision_replay"] == "unavailable"
    assert bundle["run"]["run_id"] == session.run_id


def test_cli_diagnose_out_exports_file(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_PATH", str(tmp_path / "telemetry.db"))
    store = StateStore(state_path)
    session = store.create_run("goal_cli_diag2")
    store.save_run(session)

    out = tmp_path / "d.json"
    result = CliRunner().invoke(app, ["diagnose", session.run_id, "--out", str(out)])
    assert result.exit_code == 0, result.output
    envelope = json.loads(result.output)
    assert envelope["kind"] == "run_diagnostic"
    assert json.loads(out.read_text(encoding="utf-8"))["_meta"]["mode"] == "diagnostic_context"


def test_cli_diagnose_unknown_run_fails_closed(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    result = CliRunner().invoke(app, ["diagnose", "run_does_not_exist"])
    assert result.exit_code == 1


def test_cli_diagnose_require_complete_propagates(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    state_path = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(state_path))
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_PATH", str(tmp_path / "absent.db"))
    store = StateStore(state_path)
    session = store.create_run("goal_rc_diag")
    store.save_run(session)
    # --require-complete with absent telemetry must fail-closed (exit 1), proving
    # the flag is threaded through to the builder.
    result = CliRunner().invoke(app, ["diagnose", session.run_id, "--require-complete"])
    assert result.exit_code == 1
    # without the flag the same run diagnoses fine (incomplete, but exit 0).
    ok = CliRunner().invoke(app, ["diagnose", session.run_id])
    assert ok.exit_code == 0


def test_export_diagnostic_envelope_carries_replay_reason(tmp_path):
    store, run_id = _store_with_run(tmp_path)
    out = tmp_path / "diag2.json"
    envelope = oe.export_diagnostic_bundle(
        store, run_id=run_id, out=str(out), telemetry_path=tmp_path / "absent.db"
    )
    assert envelope["decision_replay"] == "unavailable"
    assert envelope["decision_replay_reason"] == "tier_c_recording_absent"
