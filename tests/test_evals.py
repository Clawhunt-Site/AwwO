import json
import os
import sys
from pathlib import Path

import pytest

from superclaw.evals import (
    FUSION_CASE_ID,
    EvalRunner,
    FAKE_AGENT_API_KEY,
    FakeClawHunt,
    _run_command,
)


def _fake_executable(tmp_path: Path, name: str, body: str) -> Path:
    script = tmp_path / f"{name}_helper.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        path = tmp_path / f"{name}.cmd"
        path.write_text(f"@echo off\n\"{sys.executable}\" \"{script}\" %*\n", encoding="utf-8")
    else:
        path = tmp_path / name
        path.write_text(f"#!/bin/sh\n'{sys.executable}' '{script}' \"$@\"\n", encoding="utf-8")
        path.chmod(0o755)
    return path


def test_fake_clawhunt_accepts_complete_evidence():
    fake = FakeClawHunt()
    claim = fake.claim("superclaw", FAKE_AGENT_API_KEY)
    submission = fake.submit(
        "superclaw",
        {
            "commands": [{"command": "python -m unittest", "exit_code": 0}],
            "changed_files": ["app.py"],
            "verifier_findings": [{"name": "bad_signature_probe", "passed": True}],
        },
    )

    assert claim["ok"] is True
    assert submission["body"]["accepted"] is True
    assert fake.status()["body"]["state"] == "accepted"
    assert fake.wallet()["body"]["settled"] == 1


def test_fake_clawhunt_rejected_submit_does_not_settle_wallet():
    fake = FakeClawHunt()
    fake.claim("codex", FAKE_AGENT_API_KEY)
    submission = fake.submit("codex", {"commands": [], "changed_files": [], "verifier_findings": []})

    assert submission["body"]["accepted"] is False
    assert fake.status()["body"]["state"] == "claimed"
    assert fake.wallet()["body"]["settled"] == 0


def test_eval_runner_rejects_external_eval_id_paths(tmp_path):
    eval_root = tmp_path / "evals"
    external_eval = tmp_path / "external_eval"
    external_eval.mkdir()
    (external_eval / "report.json").write_text(
        json.dumps(
            {
                "eval_id": "external_eval",
                "case_id": "mini-pay-webhook",
                "status": "completed",
                "verdict": "E2E_PROVEN",
                "agents": [],
                "score_summary": {},
                "artifacts": [],
            }
        ),
        encoding="utf-8",
    )
    runner = EvalRunner(eval_root)

    with pytest.raises(FileNotFoundError):
        runner.get_report(str(external_eval))
    with pytest.raises(FileNotFoundError):
        runner.report_pdf_path(str(external_eval))
    assert not (external_eval / "report.pdf").exists()


def test_eval_run_command_bootstraps_active_python_for_wrapped_helpers(tmp_path):
    fake = _fake_executable(tmp_path, "helper", "import httpx\nprint('helper-ok')\n")

    result = _run_command([str(fake)], tmp_path, timeout_seconds=10)

    assert result["exit_code"] == 0
    assert "helper-ok" in result["output"]


def test_delivery_gap_superclaw_lane_reaches_e2e_proven(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(agent="superclaw", output=tmp_path / "eval")
    lane = report["agents"][0]

    assert report["verdict"] == "E2E_PROVEN"
    assert lane["agent"] == "superclaw"
    assert lane["score"] == 100
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True
    assert lane["fake_clawhunt"]["status"]["body"]["state"] == "accepted"
    assert (tmp_path / "eval" / "superclaw" / "workspace" / "clawhunt_problem.json").exists()
    assert (tmp_path / "eval" / "superclaw" / "workspace" / "delivery_contract.json").exists()
    assert (tmp_path / "eval" / "report.md").exists()
    assert (tmp_path / "eval" / "report.pdf").exists()
    assert (tmp_path / "eval" / "report.pdf").read_bytes().startswith(b"%PDF")


def test_delivery_gap_order_ledger_superclaw_lane_reaches_e2e_proven(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(
        agent="superclaw",
        case_id="mini-order-ledger",
        output=tmp_path / "eval-order",
    )
    lane = report["agents"][0]
    evidence = (tmp_path / "eval-order" / "superclaw" / "evidence.json").read_text(encoding="utf-8")

    assert report["case_id"] == "mini-order-ledger"
    assert report["verdict"] == "E2E_PROVEN"
    assert lane["score"] == 100
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True
    assert "dashboard_render_probe" in evidence
    assert (tmp_path / "eval-order" / "superclaw" / "workspace" / "migrations" / "001_create_orders.sql").exists()


def test_delivery_gap_awd_arena_superclaw_lane_reaches_e2e_proven(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(
        agent="superclaw",
        case_id="mini-awd-arena",
        output=tmp_path / "eval-arena",
    )
    lane = report["agents"][0]
    evidence = (tmp_path / "eval-arena" / "superclaw" / "evidence.json").read_text(encoding="utf-8")
    scorecard = tmp_path / "eval-arena" / "superclaw" / "workspace" / "arena_scorecard.json"

    assert report["case_id"] == "mini-awd-arena"
    assert report["verdict"] == "E2E_PROVEN"
    assert lane["score"] == 100
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True
    assert "arena_attack_effectiveness_probe" in evidence
    assert "arena_defense_resilience_probe" in evidence
    assert "arena_sla_probe" in evidence
    assert scorecard.exists()
    assert (tmp_path / "eval-arena" / "superclaw" / "workspace" / "attack_plan.json").exists()


def test_delivery_gap_fusion_delivery_chain_reaches_e2e_proven(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(
        agent="superclaw",
        case_id=FUSION_CASE_ID,
        output=tmp_path / "eval-fusion",
    )
    lane = report["agents"][0]
    evidence = (tmp_path / "eval-fusion" / "superclaw" / "evidence.json").read_text(encoding="utf-8")
    delivery = tmp_path / "eval-fusion" / "superclaw" / "workspace" / "fusion_delivery.json"

    assert report["case_id"] == FUSION_CASE_ID
    assert report["verdict"] == "E2E_PROVEN"
    assert lane["score"] == 100
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True
    assert delivery.exists()
    assert "fusion_active_gate_probe" in evidence
    assert "fusion_capability_catalog_probe" in evidence
    assert {"osiris_passive_intel", "active_network_gate", "open_design_artifact", "openpencil_export", "capability_catalog_coverage"}.issubset(
        {item["phase"] for item in lane["phase_scores"]}
    )
    assert any(item["kind"] == "fusion-delivery-json" for item in lane["artifacts"])


def test_delivery_gap_fusion_delivery_chain_reports_real_export_artifacts(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(
        agent="superclaw",
        case_id=FUSION_CASE_ID,
        output=tmp_path / "eval-fusion-artifacts",
    )
    lane = report["agents"][0]
    workspace = tmp_path / "eval-fusion-artifacts" / "superclaw" / "workspace"
    expected_files = {
        "artifacts/osiris-passive-intel.json": "dns_lookup",
        "artifacts/open-design-preview.html": "design-system-catalog",
        "artifacts/openpencil-canvas.op": "openpencil_canvas",
        "artifacts/openpencil-export.html": "react-tailwind",
    }

    assert report["verdict"] == "E2E_PROVEN"
    for relative_path, marker in expected_files.items():
        path = workspace / relative_path
        assert path.exists(), relative_path
        assert marker in path.read_text(encoding="utf-8")
    assert "fusion_artifact_files_probe" in (workspace.parent / "evidence.json").read_text(encoding="utf-8")
    assert {"fusion-osiris-intel-json", "fusion-open-design-preview-html", "fusion-openpencil-document-op", "fusion-openpencil-export-html"}.issubset(
        {item["kind"] for item in lane["artifacts"]}
    )


def test_delivery_gap_awd_arena_report_has_detailed_phase_scoring(tmp_path):
    report = EvalRunner(tmp_path).run_delivery_gap(
        agent="superclaw",
        case_id="mini-awd-arena",
        output=tmp_path / "eval-arena-detail",
    )
    lane = report["agents"][0]
    markdown = (tmp_path / "eval-arena-detail" / "report.md").read_text(encoding="utf-8")
    phase_scores = lane["phase_scores"]

    assert sum(item["max_score"] for item in phase_scores) == 100
    assert sum(item["score"] for item in phase_scores) == lane["score"]
    assert {item["category"] for item in phase_scores} == {
        "delivery_chain",
        "evidence_quality",
        "verification_depth",
        "runtime_reliability",
        "operator_ux",
    }
    assert {"attack_plan_validity", "attack_effectiveness", "defense_resilience", "sla_preservation"}.issubset(
        {item["phase"] for item in phase_scores}
    )
    assert lane["flow_trace"][0]["phase"] == "problem_browse"
    assert "## Detailed Phase Matrix" in markdown
    assert "attack_plan_validity" in markdown


def test_delivery_gap_awd_arena_accepts_endpoint_attack_plan_alias(tmp_path, monkeypatch):
    fake = _fake_executable(
        tmp_path,
        "claude",
        (
            "import json\n"
            "from pathlib import Path\n"
            "from superclaw.evals import ARENA_FIXED_APP\n"
            "Path('app.py').write_text(ARENA_FIXED_APP.strip() + '\\n', encoding='utf-8')\n"
            "Path('attack_plan.json').write_text(json.dumps({'attacks': [\n"
            "  {'name': 'sql', 'method': 'GET', 'endpoint': '/profile', 'params': {'user': \"' OR '1'='1\"}, 'expected_flag_slot': 'database_flag'},\n"
            "  {'name': 'path', 'method': 'GET', 'endpoint': '/download', 'params': {'name': '../../arena_flags/admin_notes.txt'}, 'expected_flag_slot': 'admin_notes'},\n"
            "  {'name': 'preview', 'method': 'GET', 'endpoint': '/preview', 'params': {'url': 'internal://flag/credentials'}, 'expected_flag_slot': 'credentials_flag'},\n"
            "]}, indent=2), encoding='utf-8')\n"
        ),
    )
    monkeypatch.setenv("SUPERCLAW_EVAL_CLAUDE_EXECUTABLE", str(fake))

    report = EvalRunner(tmp_path / "root").run_delivery_gap(
        agent="claude",
        case_id="mini-awd-arena",
        output=tmp_path / "eval-arena-endpoint",
    )
    lane = report["agents"][0]

    assert lane["verdict"] == "E2E_PROVEN"
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True


def test_delivery_gap_agent_commands_use_isolated_write_flags(tmp_path, monkeypatch):
    runner = EvalRunner(tmp_path)
    claude = _fake_executable(tmp_path, "claude", "print('noop')\n")
    codex = _fake_executable(tmp_path, "codex", "print('noop')\n")
    monkeypatch.setenv("SUPERCLAW_EVAL_CLAUDE_EXECUTABLE", str(claude))
    monkeypatch.setenv("SUPERCLAW_EVAL_CODEX_EXECUTABLE", str(codex))

    workspace = tmp_path / "workspace"
    claude_command = runner._agent_command("claude", workspace)
    codex_command = runner._agent_command("codex", workspace)

    assert "--permission-mode" in claude_command
    assert "bypassPermissions" in claude_command
    assert "--dangerously-skip-permissions" in claude_command
    assert "--tools" in claude_command
    assert "default" in claude_command
    assert "--add-dir" in claude_command
    assert str(workspace) in claude_command
    assert "--full-auto" in codex_command
    assert "--dangerously-auto-approve-everything" in codex_command
    assert "--writable-root" in codex_command
    assert str(workspace) in codex_command
    assert runner._agent_readiness("codex")["auth_status"] in {
        "env_api_key_present",
        "interactive_login_or_api_key_required",
        "auth_json_api_key_present",
        "desktop_login_present",
    }


def test_delivery_gap_codex_exec_mode_uses_desktop_noninteractive_flags(tmp_path, monkeypatch):
    runner = EvalRunner(tmp_path)
    codex = _fake_executable(tmp_path, "codex", "print('noop')\n")
    monkeypatch.setenv("SUPERCLAW_EVAL_CODEX_EXECUTABLE", str(codex))
    monkeypatch.setenv("SUPERCLAW_EVAL_CODEX_MODE", "exec")

    workspace = tmp_path / "workspace"
    codex_command = runner._agent_command("codex", workspace)

    assert codex_command[:2] == [str(codex), "exec"]
    assert "--skip-git-repo-check" in codex_command
    assert "--ephemeral" in codex_command
    assert "--sandbox" in codex_command
    assert "workspace-write" in codex_command
    assert "--cd" in codex_command
    assert str(workspace) in codex_command
    assert "--writable-root" not in codex_command


def test_delivery_gap_fake_claude_lane_can_pass(tmp_path, monkeypatch):
    fake = _fake_executable(
        tmp_path,
        "claude",
        "from pathlib import Path\nfrom superclaw.evals import FIXED_APP\nPath('app.py').write_text(FIXED_APP.strip() + '\\n', encoding='utf-8')\nprint('fixed')\n",
    )
    monkeypatch.setenv("SUPERCLAW_EVAL_CLAUDE_EXECUTABLE", str(fake))

    report = EvalRunner(tmp_path / "root").run_delivery_gap(agent="claude", output=tmp_path / "eval")
    lane = report["agents"][0]

    assert lane["verdict"] == "E2E_PROVEN"
    assert lane["score_breakdown"]["runtime_reliability"] == 15
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is True


def test_delivery_gap_contract_secret_mismatch_is_not_accepted(tmp_path, monkeypatch):
    fake = _fake_executable(
        tmp_path,
        "claude",
        (
            "from pathlib import Path\n"
            "from superclaw.evals import FIXED_APP\n"
            "Path('app.py').write_text(FIXED_APP.replace('\"mini-pay-secret\"', '\"test-secret\"', 1).strip() + '\\n', encoding='utf-8')\n"
            "print('fixed with wrong secret')\n"
        ),
    )
    monkeypatch.setenv("SUPERCLAW_EVAL_CLAUDE_EXECUTABLE", str(fake))

    report = EvalRunner(tmp_path / "root").run_delivery_gap(agent="claude", output=tmp_path / "eval")
    lane = report["agents"][0]
    markdown = (tmp_path / "eval" / "report.md").read_text(encoding="utf-8")

    assert lane["verdict"] != "E2E_PROVEN"
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is False
    assert "failed verifier probes" in markdown


def test_delivery_gap_codex_auth_prompt_fails_closed(tmp_path, monkeypatch):
    fake = _fake_executable(
        tmp_path,
        "codex",
        "print('Sign in with ChatGPT to generate an API key')\nprint('Raw mode is not supported')\n",
    )
    monkeypatch.setenv("SUPERCLAW_EVAL_CODEX_EXECUTABLE", str(fake))

    report = EvalRunner(tmp_path / "root").run_delivery_gap(agent="codex", output=tmp_path / "eval")
    lane = report["agents"][0]

    assert lane["verdict"] == "FAIL"
    assert lane["status"] == "blocked"
    assert lane["score_scope"] == "runtime_readiness_only"
    assert lane["model_delivery_score"] is None
    assert lane["runtime_blocked"]["code"] == "AUTH_REQUIRED"
    assert "requires authentication" in lane["failure_reason"]
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is False


def test_delivery_gap_claude_usage_limit_fails_closed(tmp_path, monkeypatch):
    fake = _fake_executable(
        tmp_path,
        "claude",
        "print(\"You're out of extra usage · resets 4:20pm (Asia/Shanghai)\")\nraise SystemExit(1)\n",
    )
    monkeypatch.setenv("SUPERCLAW_EVAL_CLAUDE_EXECUTABLE", str(fake))

    report = EvalRunner(tmp_path / "root").run_delivery_gap(agent="claude", case_id="mini-awd-arena", output=tmp_path / "eval")
    lane = report["agents"][0]

    assert lane["verdict"] == "FAIL"
    assert lane["status"] == "blocked"
    assert lane["score_scope"] == "runtime_readiness_only"
    assert lane["model_delivery_score"] is None
    assert "did not enter the task-solving phase" in lane["score_explanation"]
    assert lane["runtime_blocked"]["code"] == "USAGE_QUOTA_EXHAUSTED"
    assert "usage quota is exhausted" in lane["failure_reason"]
    assert lane["fake_clawhunt"]["submission"]["body"]["accepted"] is False
