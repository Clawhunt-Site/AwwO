import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from apps.api.main import create_app
from superclaw.cli import app


ROOT = Path(__file__).resolve().parents[1]


def _native_report_payload(*, ok: bool, results: list[dict[str, object]], **extra: object) -> dict[str, object]:
    from superclaw.fusion import fusion_source_fingerprint

    payload: dict[str, object] = {
        "schema_version": "0.1.0",
        "ok": ok,
        "source_fingerprint": fusion_source_fingerprint(root=ROOT),
        "results": results,
    }
    payload.update(extra)
    return payload


def test_fusion_third_party_sources_and_notices_are_pinned():
    notices = ROOT / "THIRD_PARTY_NOTICES.md"

    assert (ROOT / "third_party" / "osiris" / "README.md").exists()
    assert (ROOT / "third_party" / "open-design" / "README.md").exists()
    assert (ROOT / "third_party" / "openpencil" / "README.md").exists()
    assert "21c3dde7d4e48154aa3918829f86965f4e646e67" in (
        ROOT / "third_party" / "osiris" / "UPSTREAM_COMMIT"
    ).read_text(encoding="utf-8")
    assert "324e9fd909d005f5d1d86982d3f15d39d747bc34" in (
        ROOT / "third_party" / "open-design" / "UPSTREAM_COMMIT"
    ).read_text(encoding="utf-8")
    assert "e8ed1985b94ba954c22441a68539ef3cd3be8e6f" in (
        ROOT / "third_party" / "openpencil" / "UPSTREAM_COMMIT"
    ).read_text(encoding="utf-8")
    assert "e1f90cab9658e6c215b48bccfc3489412c8788a5" in (
        ROOT / "third_party" / "openpencil" / "packages" / "agent-native" / "UPSTREAM_COMMIT"
    ).read_text(encoding="utf-8")
    text = notices.read_text(encoding="utf-8")
    assert "simplifaisoul/osiris" in text
    assert "nexu-io/open-design" in text
    assert "ZSeven-W/openpencil" in text
    assert "ZSeven-W/agent" in text
    assert "21c3dde7d4e48154aa3918829f86965f4e646e67" in text
    assert "324e9fd909d005f5d1d86982d3f15d39d747bc34" in text
    assert "e8ed1985b94ba954c22441a68539ef3cd3be8e6f" in text


def test_fusion_doctor_reports_profiles_and_source_status(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    result = CliRunner().invoke(app, ["fusion", "doctor", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema_version"] == "0.1.0"
    assert payload["network_policy"]["active_probe_default"] == "human_gate_required"
    assert set(payload["profiles"]) == {"all", "osiris", "design", "pencil"}
    assert payload["components"]["osiris"]["present"] is True
    assert "source_path" in payload["components"]["osiris"]
    assert payload["components"]["open-design"]["toolchain"] == "pnpm"
    assert payload["components"]["openpencil"]["toolchain"] == "bun"
    assert "secret" not in json.dumps(payload).lower()


def test_fusion_component_urls_fall_back_to_local_only_when_running_from_source(monkeypatch):
    from superclaw import fusion
    import superclaw.environment as environment

    monkeypatch.delenv("SUPERCLAW_FUSION_OSIRIS_URL", raising=False)

    # Running from source (not a frozen bundle) -> localhost preview default.
    assert fusion._component_url("osiris") == "http://127.0.0.1:3000"

    # A frozen distributed bundle must not leak a localhost URL (even if its
    # build-profile.json is missing/corrupt — sys.frozen is the authoritative marker).
    monkeypatch.setattr(environment.sys, "frozen", True, raising=False)
    assert fusion._component_url("osiris") is None

    # An explicit override always wins, source or bundle.
    monkeypatch.setenv("SUPERCLAW_FUSION_OSIRIS_URL", "https://osiris.example/")
    assert fusion._component_url("osiris") == "https://osiris.example"


def test_fusion_status_cli_uses_operator_safe_api_shape(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    runner = CliRunner()

    result = runner.invoke(app, ["fusion", "status", "--json"])
    text = runner.invoke(app, ["fusion", "status"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    serialized = json.dumps(payload)
    assert payload["schema_version"] == "0.1.0"
    assert payload["components"]["osiris"]["present"] is True
    assert payload["network_policy"]["active_probe_default"] == "human_gate_required"
    assert "source_path" not in payload["components"]["osiris"]
    assert "source_dir" not in payload["components"]["osiris"]
    assert "root" not in payload
    assert str(ROOT) not in serialized
    assert "third_party" not in serialized
    assert text.exit_code == 0, text.output
    assert "Fusion status" in text.output
    assert "third_party" not in text.output
    assert str(ROOT) not in text.output


def test_fusion_capability_catalog_and_audit_cover_imported_sources(monkeypatch):
    from superclaw.fusion import fusion_capability_audit, fusion_capability_catalog

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(ROOT / ".superclaw" / "missing-native-report-for-test.json"))
    catalog = fusion_capability_catalog(root=ROOT)
    audit = fusion_capability_audit(root=ROOT)

    assert catalog["summary"]["capability_count"] >= 12
    assert catalog["summary"]["gated_capability_count"] >= 3
    assert catalog["source_inventory"]["osiris"]["api_route_count"] >= 25
    assert catalog["source_inventory"]["open-design"]["skills_count"] >= 100
    assert catalog["source_inventory"]["open-design"]["design_systems_count"] >= 100
    assert "codegen_plan" in catalog["source_inventory"]["openpencil"]["mcp_tool_names"]
    assert "batch_design" in catalog["source_inventory"]["openpencil"]["mcp_tool_names"]
    assert "debug_screenshot" in catalog["source_inventory"]["openpencil"]["mcp_tool_names"]
    assert catalog["source_inventory"]["openpencil"]["agent_native_present"] is True
    assert catalog["source_inventory"]["openpencil"]["agent_native_commit"] == "e1f90cab9658e6c215b48bccfc3489412c8788a5"
    assert audit["ok"] is True, audit["findings"]
    assert audit["native_verification"]["report_present"] is False
    assert all(item["passed"] for item in audit["findings"])
    assert "source_path" not in json.dumps(catalog)


def test_fusion_native_report_is_loaded_separately_from_projection_audit(tmp_path, monkeypatch):
    from superclaw.fusion import fusion_capability_audit, load_fusion_native_report

    report = tmp_path / "fusion-native-report.json"
    report.write_text(
        json.dumps(
            {
                "schema_version": "0.1.0",
                "generated_at": "2026-06-02T18:30:00Z",
                "ok": False,
                "results": [
                    {"component": "osiris", "command_id": "npm_build", "status": "passed"},
                    {"component": "openpencil", "command_id": "bun_test", "status": "failed", "detail": "upstream test failures"},
                    {"component": "openpencil", "command_id": "agent_native", "status": "blocked", "detail": "zig missing"},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(report))

    native = load_fusion_native_report(root=ROOT)
    audit = fusion_capability_audit(root=ROOT)

    assert native["report_present"] is True
    assert native["ok"] is False
    assert native["summary"] == {"total": 3, "passed": 1, "failed": 1, "blocked": 1}
    assert audit["ok"] is True
    assert audit["native_verification"]["ok"] is False


def test_fusion_cli_capabilities_and_audit_are_json(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    runner = CliRunner()

    capabilities = runner.invoke(app, ["fusion", "capabilities", "--json"])
    audit = runner.invoke(app, ["fusion", "audit", "--json"])

    assert capabilities.exit_code == 0, capabilities.output
    assert audit.exit_code == 0, audit.output
    capabilities_payload = json.loads(capabilities.output)
    audit_payload = json.loads(audit.output)
    assert capabilities_payload["summary"]["components"]["osiris"] >= 4
    assert capabilities_payload["summary"]["components"]["open-design"] >= 4
    assert capabilities_payload["summary"]["components"]["openpencil"] >= 4
    assert audit_payload["ok"] is True
    assert "third_party" in json.dumps(capabilities_payload)
    assert str(ROOT) not in json.dumps(capabilities_payload)


def test_fusion_start_and_test_return_orchestration_plans(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    native_report = tmp_path / "fusion-native-report.json"
    native_report.write_text(
        json.dumps(
            _native_report_payload(
                ok=True,
                results=[
                    {
                        "component": "openpencil",
                        "command": ["bun", "run", "test"],
                        "status": "passed",
                        "detail": "unit tests passed",
                    },
                    {
                        "component": "openpencil",
                        "command": ["bun", "run", "build"],
                        "status": "passed",
                    },
                    {
                        "component": "openpencil",
                        "command": ["bun", "run", "mcp:compile"],
                        "status": "passed",
                    },
                    {
                        "component": "osiris",
                        "command": ["npm", "run", "build"],
                        "status": "passed",
                    },
                ],
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(native_report))
    runner = CliRunner()

    start = runner.invoke(app, ["fusion", "start", "--profile", "all", "--json"])
    test = runner.invoke(app, ["fusion", "test", "--profile", "pencil", "--json"])

    assert start.exit_code == 0, start.output
    start_payload = json.loads(start.output)
    assert start_payload["profile"] == "all"
    assert start_payload["execute"] is False
    assert {step["component"] for step in start_payload["steps"]} >= {"superclaw", "osiris", "open-design", "openpencil"}
    assert test.exit_code == 0, test.output
    test_payload = json.loads(test.output)
    assert test_payload["steps"][0]["command"][0] == "bun"
    assert test_payload["steps"][0]["cwd"].endswith("third_party/openpencil")
    assert test_payload["steps"][0]["status"] == "passed"
    assert test_payload["steps"][0]["native_detail"] == "unit tests passed"
    assert test_payload["summary"]["reported"] == 3
    assert test_payload["summary"]["passed"] == 3
    assert test_payload["summary"]["not_reported_steps"] == 0
    assert test_payload["summary"]["ok"] is True
    assert test_payload["summary"]["native_report_present"] is True
    assert test_payload["native_verification"]["results"][0]["component"] == "openpencil"


def test_fusion_start_execute_runs_docker_compose_profile(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    calls: list[dict[str, object]] = []

    class Completed:
        returncode = 0
        stdout = "started fusion stack"
        stderr = ""

    def fake_run(command, *, cwd, capture_output, text, timeout, check):  # noqa: ANN001
        calls.append(
            {
                "command": command,
                "cwd": cwd,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return Completed()

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "start", "--profile", "all", "--execute", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["execute"] is True
    assert payload["execution"]["ok"] is True
    assert payload["execution"]["status"] == "started"
    assert payload["execution"]["command"] == ["docker", "compose", "--profile", "all", "up", "--build", "-d"]
    assert payload["execution"]["cwd"] == str(ROOT)
    assert payload["execution"]["stdout"] == "started fusion stack"
    assert {step["component"] for step in payload["steps"]} >= {"superclaw", "osiris", "open-design", "openpencil"}
    assert calls == [
        {
            "command": ["docker", "compose", "--profile", "all", "up", "--build", "-d"],
            "cwd": str(ROOT),
            "capture_output": True,
            "text": True,
            "timeout": 120,
            "check": False,
        }
    ]


def test_fusion_start_execute_fails_closed_when_docker_compose_fails(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 17
        stdout = ""
        stderr = "compose failed with ghp_0123456789abcdefghijklmnop"

    def fake_run(command, *, cwd, capture_output, text, timeout, check):  # noqa: ANN001
        return Completed()

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "start", "--profile", "pencil", "--execute", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["execution"]["ok"] is False
    assert payload["execution"]["status"] == "failed"
    assert payload["execution"]["returncode"] == 17
    assert payload["execution"]["command"] == ["docker", "compose", "--profile", "pencil", "up", "--build", "-d"]
    serialized = json.dumps(payload)
    assert "ghp_0123456789abcdefghijklmnop" not in serialized
    assert str(ROOT) not in payload["execution"]["stderr"]


def test_fusion_start_execute_fails_closed_when_compose_file_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(tmp_path))

    result = CliRunner().invoke(app, ["fusion", "start", "--profile", "design", "--execute", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["execution"]["ok"] is False
    assert payload["execution"]["status"] == "compose_file_missing"
    assert payload["execution"]["command"] == ["docker", "compose", "--profile", "design", "up", "--build", "-d"]


def test_fusion_stop_plan_emits_compose_down_without_executing(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    result = CliRunner().invoke(app, ["fusion", "stop", "--profile", "osiris", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["profile"] == "osiris"
    assert payload["execute"] is False
    assert payload["components"] == ["osiris"]
    assert payload["command"] == ["docker", "compose", "--profile", "osiris", "down"]
    assert "execution" not in payload


def test_fusion_stop_execute_runs_compose_down(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    calls: list[list[str]] = []

    class Completed:
        returncode = 0
        stdout = "stopped fusion stack"
        stderr = ""

    def fake_run(command, *, cwd, capture_output, text, timeout, check):  # noqa: ANN001
        calls.append(command)
        return Completed()

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "stop", "--profile", "all", "--execute", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["execute"] is True
    assert payload["execution"]["ok"] is True
    assert payload["execution"]["status"] == "stopped"
    assert calls == [["docker", "compose", "--profile", "all", "down"]]


def test_fusion_stop_execute_fails_closed_when_compose_file_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(tmp_path))

    result = CliRunner().invoke(app, ["fusion", "stop", "--profile", "design", "--execute", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["execution"]["ok"] is False
    assert payload["execution"]["status"] == "compose_file_missing"


def test_fusion_run_status_parses_compose_ps_and_maps_components(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    monkeypatch.setenv("SUPERCLAW_FUSION_OSIRIS_URL", "http://127.0.0.1:3000")

    class Completed:
        returncode = 0
        stdout = json.dumps(
            [
                {"Service": "fusion-osiris", "State": "running", "Health": "healthy"},
                {"Service": "fusion-openpencil", "State": "exited", "Health": ""},
            ]
        )
        stderr = ""

    def fake_run(command, *, cwd, capture_output, text, timeout, check):  # noqa: ANN001
        assert command == ["docker", "compose", "--profile", "all", "ps", "--format", "json", "--all"]
        return Completed()

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "ps", "--profile", "all", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["status"] == "queried"
    by_service = {service["service"]: service for service in payload["services"]}
    assert by_service["fusion-osiris"]["component"] == "osiris"
    assert by_service["fusion-osiris"]["running"] is True
    assert by_service["fusion-osiris"]["health"] == "healthy"
    assert by_service["fusion-osiris"]["url"] == "http://127.0.0.1:3000"
    assert by_service["fusion-openpencil"]["running"] is False
    assert by_service["fusion-openpencil"]["health"] is None
    assert "stdout" not in payload


def test_fusion_run_status_parses_newline_delimited_json(monkeypatch):
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stdout = (
            '{"Service": "fusion-osiris", "State": "running"}\n'
            '{"Service": "fusion-open-design", "State": "running"}\n'
        )
        stderr = ""

    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is True
    assert {service["component"] for service in payload["services"]} == {"osiris", "open-design"}


def test_fusion_run_status_recovers_array_line_after_warning_text(monkeypatch):
    # docker may print a stray warning line, breaking whole-text JSON parse; the
    # per-line fallback must still recover an array-shaped JSON line instead of
    # silently dropping it (fail-open: reporting nothing running).
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stdout = (
            "WARN[0000] a stray docker warning line\n"
            + json.dumps([{"Service": "fusion-osiris", "State": "running"}])
        )
        stderr = ""

    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is True
    assert [service["component"] for service in payload["services"]] == ["osiris"]
    assert payload["services"][0]["running"] is True


def test_fusion_stop_plan_does_not_leak_host_root_path(monkeypatch):
    from superclaw.fusion import fusion_stop_plan

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    payload = fusion_stop_plan("all", root=ROOT)

    assert "cwd" not in payload
    assert str(ROOT) not in json.dumps(payload)


def test_fusion_run_status_fails_closed_on_unparsable_nonempty_output(monkeypatch):
    # Compose exits 0 but emits non-empty unparsable text: must fail closed
    # rather than report ok=True with an empty (looks-idle) service list.
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stdout = "this is not compose json at all"
        stderr = ""

    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is False
    assert payload["status"] == "parse_failed"
    assert payload["services"] == []


@pytest.mark.parametrize(
    "stdout",
    [
        "null",
        "123",
        '"oops"',
        "[1, 2, 3]",
        '{"foo": "bar"}',
        '{"State": "running"}',  # dict without Service/Name is not a real record
    ],
)
def test_fusion_run_status_fails_closed_on_valid_but_wrong_shape_json(stdout, monkeypatch):
    # Valid JSON that is not a compose-ps service shape must fail closed, not be
    # reported as ok=True with an empty (looks-idle) or junk service list.
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stderr = ""

    Completed.stdout = stdout
    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is False
    assert payload["status"] == "parse_failed"
    assert payload["services"] == []


@pytest.mark.parametrize(
    "stdout",
    [
        '123\n{"Service": "fusion-osiris", "State": "running"}',
        '{"State": "running"}\n{"Service": "fusion-osiris", "State": "running"}',
        '{"Service": "fusion-osiris", "State": "running"}\n123',
    ],
)
def test_fusion_run_status_fails_closed_on_mixed_ndjson_wrong_shape(stdout, monkeypatch):
    # NDJSON where some line is JSON-parseable but the wrong shape must fail
    # closed, not silently drop the bad line and report the survivors as truth.
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stderr = ""

    Completed.stdout = stdout
    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is False
    assert payload["status"] == "parse_failed"
    assert payload["services"] == []


def test_fusion_redactor_scrubs_bare_and_prefixed_token_assignments():
    # Regression: both bare `token=` and prefixed `session_token=` must stay
    # redacted via the canonical scanner; benign "token: disabled" must not.
    from superclaw.fusion import _redact_execution_text

    redacted = _redact_execution_text(
        "compose failed token=secret-value-12345678 session_token=other-value-87654321 token: disabled",
        root=ROOT,
    )

    assert "secret-value-12345678" not in redacted
    assert "other-value-87654321" not in redacted
    assert "[REDACTED]" in redacted
    assert "disabled" in redacted


def test_fusion_start_unknown_profile_fails_closed_structured(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    result = CliRunner().invoke(app, ["fusion", "start", "--profile", "bogus", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["status"] == "unknown_profile"
    assert payload["steps"] == []


def test_fusion_run_status_treats_empty_array_as_nothing_running(monkeypatch):
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 0
        stdout = "[]"
        stderr = ""

    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    assert payload["ok"] is True
    assert payload["status"] == "queried"
    assert payload["services"] == []


def test_fusion_run_status_fails_closed_on_permission_error(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    def fake_run(*args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        raise PermissionError("docker permission denied")

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "ps", "--profile", "all", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["status"] == "exec_error"
    assert payload["services"] == []


def test_fusion_run_status_unknown_profile_fails_closed_structured(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    result = CliRunner().invoke(app, ["fusion", "ps", "--profile", "bogus", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["status"] == "unknown_profile"
    assert payload["services"] == []


def test_fusion_stop_unknown_profile_fails_closed_structured(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    result = CliRunner().invoke(app, ["fusion", "stop", "--profile", "bogus", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["status"] == "unknown_profile"


def test_fusion_redactor_routes_through_canonical_secret_scanner():
    # The execution redactor must defer to the canonical scanner (single source
    # of truth) so it covers the same formats — github_pat, JWT, bare AWS access
    # key ids, PEM markers, Bearer, Google keys — instead of a drifting regex.
    from superclaw.fusion import _redact_execution_text

    secrets = {
        "bearer": "Bearer abcdEFGH1234ijklMNOP5678",
        "github_pat": "github_pat_11ABCDEFG0123456789abcdefABCDEF",
        "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w",
        "aws_id": "AKIAIOSFODNN7EXAMPLE",
        "google": "AIzaSyA1234567890abcdefghijklmnopqrstuv",
        "pem": "-----BEGIN PRIVATE KEY-----",
    }
    raw = "\n".join(secrets.values())
    redacted = _redact_execution_text(raw, root=ROOT)

    for label, secret in secrets.items():
        if label == "pem":
            assert "BEGIN PRIVATE KEY" not in redacted
        else:
            assert secret not in redacted, label
    assert "[REDACTED]" in redacted


def test_fusion_redactor_masks_home_directory_paths():
    from pathlib import Path

    from superclaw.fusion import _redact_execution_text

    home = Path.home()
    raw = f"failed reading {home / 'private' / 'creds.json'}"
    redacted = _redact_execution_text(raw, root=ROOT)

    assert str(home) not in redacted
    assert "[HOME]" in redacted


def test_fusion_run_status_fails_closed_when_docker_unavailable(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    def fake_run(*args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        raise FileNotFoundError("docker")

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)

    result = CliRunner().invoke(app, ["fusion", "ps", "--profile", "all", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["status"] == "docker_unavailable"
    assert payload["services"] == []


def test_fusion_run_status_redacts_secrets_and_root_on_failure(monkeypatch):
    from superclaw.fusion import fusion_run_status

    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))

    class Completed:
        returncode = 1
        stdout = ""
        stderr = f"ps failed in {ROOT} ghp_0123456789abcdefghijklmnop"

    monkeypatch.setattr("superclaw.fusion.subprocess.run", lambda *a, **k: Completed())

    payload = fusion_run_status("all", root=ROOT)

    serialized = json.dumps(payload)
    assert payload["ok"] is False
    assert payload["status"] == "failed"
    assert payload["services"] == []
    assert "ghp_0123456789abcdefghijklmnop" not in serialized
    assert str(ROOT) not in serialized


def test_fusion_changelog_describes_execute_runner_not_legacy_placeholder():
    changelog = Path("CHANGELOG.md").read_text(encoding="utf-8")
    unreleased = changelog.split("## [Unreleased]", 1)[1]

    assert "execution.status=not_supported" not in unreleased
    assert "docker compose --profile <all|osiris|design|pencil> up --build -d" in unreleased
    assert "docker_unavailable" in unreleased


def test_fusion_test_cli_fails_closed_when_native_report_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(tmp_path / "missing-fusion-native-report.json"))

    result = CliRunner().invoke(app, ["fusion", "test", "--profile", "pencil", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["summary"]["native_report_present"] is False
    assert payload["summary"]["not_reported_steps"] == 3
    assert payload["summary"]["failed"] == 0
    assert payload["summary"]["ok"] is False
    assert all(step["status"] == "not_reported" for step in payload["steps"])


def test_fusion_test_cli_fails_closed_when_native_report_is_stale(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    native_report = tmp_path / "fusion-native-report.json"
    native_report.write_text(
        json.dumps(
            {
                "schema_version": "0.1.0",
                "ok": True,
                "source_fingerprint": {"digest": "sha256:stale-native-report"},
                "results": [
                    {"component": "openpencil", "command": ["bun", "run", "test"], "status": "passed"},
                    {"component": "openpencil", "command": ["bun", "run", "build"], "status": "passed"},
                    {"component": "openpencil", "command": ["bun", "run", "mcp:compile"], "status": "passed"},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(native_report))

    result = CliRunner().invoke(app, ["fusion", "test", "--profile", "pencil", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["summary"]["native_ok"] is False
    assert payload["summary"]["ok"] is False
    assert payload["native_verification"]["source_fingerprint_ok"] is False


def test_fusion_test_profile_gate_ignores_unselected_native_failures(tmp_path, monkeypatch):
    native_report = tmp_path / "fusion-native-report.json"
    native_report.write_text(
        json.dumps(
            _native_report_payload(
                ok=False,
                results=[
                    {"component": "openpencil", "command": ["bun", "run", "test"], "status": "passed"},
                    {"component": "openpencil", "command": ["bun", "run", "build"], "status": "passed"},
                    {"component": "openpencil", "command": ["bun", "run", "mcp:compile"], "status": "passed"},
                    {"component": "osiris", "command": ["npm", "run", "build"], "status": "failed", "detail": "unrelated profile failure"},
                ],
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(native_report))

    result = CliRunner().invoke(app, ["fusion", "test", "--profile", "pencil", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["summary"]["native_ok"] is True
    assert payload["summary"]["ok"] is True
    assert payload["summary"]["reported"] == 3
    assert payload["summary"]["failed"] == 0
    assert {item["component"] for item in payload["native_verification"]["results"]} == {"openpencil"}


def test_fusion_test_reports_superclaw_self_check_when_all_native_steps_exist(tmp_path, monkeypatch):
    from superclaw.fusion import FUSION_COMPONENTS, fusion_test_plan

    native_report = tmp_path / "fusion-native-report.json"
    native_report.write_text(
        json.dumps(
            _native_report_payload(
                ok=True,
                results=[
                    {"component": component.key, "command": command, "status": "passed"}
                    for component in FUSION_COMPONENTS.values()
                    for command in component.test_commands
                ],
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SUPERCLAW_FUSION_NATIVE_REPORT", str(native_report))

    payload = fusion_test_plan("all", root=ROOT)

    superclaw_step = next(step for step in payload["steps"] if step["component"] == "superclaw")
    assert superclaw_step["status"] == "passed"
    assert superclaw_step["command"] == ["python", "-m", "superclaw.cli", "fusion", "audit", "--json"]
    assert payload["summary"]["not_reported_steps"] == 0
    assert payload["summary"]["reported"] == len(payload["steps"])
    assert payload["summary"]["passed"] == len(payload["steps"])
    assert payload["summary"]["ok"] is True


def test_fusion_plugin_manifests_are_valid_and_sanitized():
    from superclaw.fusion import FUSION_COMPONENTS

    schema = json.loads((ROOT / "schemas" / "superclaw-plugin.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    plugin_roots = {
        "osiris": ROOT / "examples" / "plugins" / "fusion-osiris",
        "open-design": ROOT / "examples" / "plugins" / "fusion-open-design",
        "openpencil": ROOT / "examples" / "plugins" / "fusion-openpencil",
    }

    for component_key, plugin_root in plugin_roots.items():
        manifest = json.loads((plugin_root / "superclaw-plugin.json").read_text(encoding="utf-8"))
        errors = sorted(validator.iter_errors(manifest), key=lambda error: list(error.path))
        assert errors == []
        manifest_tools = {tool["name"] for tool in manifest["tools"]}
        component = FUSION_COMPONENTS[component_key]
        assert set(component.passive_tools + component.active_tools).issubset(manifest_tools)
        projected_text = json.dumps(manifest["tools"], ensure_ascii=False).lower()
        assert "third_party" not in projected_text
        assert "entitlement" not in projected_text
        assert "signature" not in projected_text
        assert "secret" not in projected_text


def test_fusion_active_network_actions_fail_closed_without_gate(tmp_path):
    from superclaw.fusion import FusionPermissionError, record_fusion_action

    with pytest.raises(FusionPermissionError):
        record_fusion_action(
            component="osiris",
            action="tool_call",
            tool_name="port_scan",
            payload={"target": "example.com"},
            artifact_dir=tmp_path,
            human_gate_approved=False,
        )


def test_fusion_scan_like_actions_fail_closed_even_with_unknown_tool_name(tmp_path):
    from superclaw.fusion import FusionPermissionError, record_fusion_action

    with pytest.raises(FusionPermissionError):
        record_fusion_action(
            component="osiris",
            action="external_probe",
            tool_name="nmap_scan",
            payload={"target": "example.com", "ports": [80, 443]},
            artifact_dir=tmp_path,
            human_gate_approved=False,
        )


def test_fusion_nested_scan_payload_keys_fail_closed_even_with_passive_tool_name(tmp_path):
    from superclaw.fusion import FusionPermissionError, record_fusion_action

    with pytest.raises(FusionPermissionError):
        record_fusion_action(
            component="osiris",
            action="lookup",
            tool_name="dns_lookup",
            payload={
                "target": "example.com",
                "options": {
                    "scanType": "tcp",
                    "targetPorts": [80, 443],
                },
            },
            artifact_dir=tmp_path,
            human_gate_approved=False,
        )


def test_fusion_passive_osint_target_lookup_remains_ungated(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    result = record_fusion_action(
        component="osiris",
        action="lookup",
        tool_name="dns_lookup",
        payload={"target": "example.com"},
        artifact_dir=tmp_path,
    )

    record = load_fusion_artifact(result["artifact_id"], artifact_dir=tmp_path)
    assert record["status"] == "recorded"
    assert record["tool_name"] == "dns_lookup"
    assert record["human_gate_approved"] is False


def test_fusion_active_network_actions_require_permission_result(tmp_path):
    from superclaw.fusion import FusionPermissionError, record_fusion_action

    with pytest.raises(FusionPermissionError):
        record_fusion_action(
            component="osiris",
            action="tool_call",
            tool_name="port_scan",
            payload={"target": "example.com"},
            artifact_dir=tmp_path,
            human_gate_approved=True,
        )


def test_fusion_active_network_action_records_sanitized_permission_result(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    leaked_token = "ghp_should_not_be_recorded"
    result = record_fusion_action(
        component="osiris",
        action="tool_call",
        tool_name="port_scan",
        payload={"target": "example.com"},
        artifact_dir=tmp_path,
        human_gate_approved=True,
        permission_result={
            "decision": "approved",
            "artifact_id": "permission-log-001",
            "policy_id": "fusion-active-network",
            "secret": leaked_token,
            "path": str(tmp_path / "private-permission.json"),
        },
    )

    record = load_fusion_artifact(result["artifact_id"], artifact_dir=tmp_path)
    serialized = json.dumps(record)
    assert record["permission_result"] == {
        "decision": "approved",
        "artifact_id": "permission-log-001",
        "policy_id": "fusion-active-network",
    }
    assert leaked_token not in serialized
    assert str(tmp_path) not in serialized
    assert "secret" not in serialized.lower()


def test_fusion_action_records_artifact_for_passive_work(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    result = record_fusion_action(
        component="openpencil",
        action="export",
        tool_name="codegen_export",
        payload={"format": "html"},
        artifact_refs=[{"artifact_id": "artifact_demo", "kind": "html"}],
        artifact_dir=tmp_path,
    )

    assert result["status"] == "recorded"
    record = load_fusion_artifact(result["artifact_id"], artifact_dir=tmp_path)
    assert record["component"] == "openpencil"
    assert record["artifact_refs"][0]["kind"] == "html"
    assert "payload_digest" in record
    assert "payload" not in record


def test_fusion_action_artifacts_are_append_only_for_repeated_payloads(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    first = record_fusion_action(
        component="openpencil",
        action="export",
        tool_name="codegen_export",
        payload={"format": "html"},
        artifact_dir=tmp_path,
    )
    second = record_fusion_action(
        component="openpencil",
        action="export",
        tool_name="codegen_export",
        payload={"format": "html"},
        artifact_dir=tmp_path,
    )

    assert first["artifact_id"] != second["artifact_id"]
    assert (tmp_path / f"{first['artifact_id']}.json").exists()
    assert (tmp_path / f"{second['artifact_id']}.json").exists()
    assert load_fusion_artifact(first["artifact_id"], artifact_dir=tmp_path)["payload_digest"] == load_fusion_artifact(
        second["artifact_id"], artifact_dir=tmp_path
    )["payload_digest"]


def test_fusion_action_artifact_refs_are_sanitized(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    leaked_token = "sk_live_should_not_appear"
    result = record_fusion_action(
        component="open-design",
        action="artifact_create",
        tool_name="design_artifact",
        payload={"name": "landing"},
        artifact_refs=[
            {
                "artifact_id": "demo-html",
                "kind": "html",
                "path": str(ROOT / "third_party" / "open-design" / "secret-output.html"),
                "url": f"https://preview.example.test/demo?token={leaked_token}",
                "secret": leaked_token,
                "metadata": {"absolute_path": str(tmp_path / "private" / "report.html")},
            }
        ],
        artifact_dir=tmp_path,
    )

    record = load_fusion_artifact(result["artifact_id"], artifact_dir=tmp_path)
    ref = record["artifact_refs"][0]
    serialized = json.dumps(record)
    assert ref == {"artifact_id": "demo-html", "kind": "html"}
    assert leaked_token not in serialized
    assert "third_party" not in serialized
    assert str(tmp_path) not in serialized
    assert "secret" not in serialized.lower()


def test_fusion_action_refs_and_permission_ids_redact_secret_like_values(tmp_path):
    from superclaw.fusion import load_fusion_artifact, record_fusion_action

    leaked_token = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    result = record_fusion_action(
        component="osiris",
        action="tool_call",
        tool_name="port_scan",
        payload={"target": "example.com"},
        artifact_refs=[
            {
                "artifact_id": f"preview-{leaked_token}",
                "kind": f"html-{leaked_token}",
            }
        ],
        artifact_dir=tmp_path,
        human_gate_approved=True,
        permission_result={
            "decision": "approved",
            "artifact_id": f"permission-{leaked_token}",
            "policy_id": f"policy-{leaked_token}",
        },
    )

    record = load_fusion_artifact(result["artifact_id"], artifact_dir=tmp_path)
    serialized = json.dumps(record)
    assert leaked_token not in serialized
    assert "sk-proj" not in serialized
    assert record["artifact_refs"] == [{"artifact_id": "artifact", "kind": "artifact"}]
    assert record["permission_result"] == {
        "decision": "approved",
        "artifact_id": "permission",
        "policy_id": "policy",
    }


def test_fusion_api_status_action_and_artifact_flow(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(tmp_path / "fusion-artifacts"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    status = client.get("/api/fusion/status")
    assert status.status_code == 200
    assert status.json()["components"]["osiris"]["present"] is True
    assert "source_path" not in status.json()["components"]["osiris"]
    assert "source_dir" not in status.json()["components"]["osiris"]
    assert "root" not in status.json()
    assert "third_party" not in json.dumps(status.json())

    capabilities = client.get("/api/fusion/capabilities")
    audit = client.get("/api/fusion/audit")
    assert capabilities.status_code == 200
    assert audit.status_code == 200
    assert capabilities.json()["summary"]["capability_count"] >= 12
    assert audit.json()["ok"] is True
    assert str(ROOT) not in json.dumps(capabilities.json())

    denied = client.post(
        "/api/fusion/actions",
        json={"component": "osiris", "action": "tool_call", "tool_name": "vulnerability_scan", "payload": {"target": "example.com"}},
    )
    assert denied.status_code == 403
    assert denied.json()["code"] == "FUSION_HUMAN_GATE_REQUIRED"

    alias_denied = client.post(
        "/api/fusion/actions",
        json={
            "component": "osiris",
            "action": "external_probe",
            "tool_name": "nmap_scan",
            "payload": {"target": "example.com", "ports": [80, 443]},
        },
    )
    assert alias_denied.status_code == 403
    assert alias_denied.json()["code"] == "FUSION_HUMAN_GATE_REQUIRED"

    missing_permission = client.post(
        "/api/fusion/actions",
        json={
            "component": "osiris",
            "action": "tool_call",
            "tool_name": "port_scan",
            "payload": {"target": "example.com"},
            "human_gate_approved": True,
        },
    )
    assert missing_permission.status_code == 403
    assert missing_permission.json()["code"] == "FUSION_HUMAN_GATE_REQUIRED"

    active_accepted = client.post(
        "/api/fusion/actions",
        json={
            "component": "osiris",
            "action": "tool_call",
            "tool_name": "port_scan",
            "payload": {"target": "example.com"},
            "human_gate_approved": True,
            "permission_result": {
                "decision": "approved",
                "artifact_id": "permission-api-log",
                "policy_id": "fusion-active-network",
                "secret": "secret-api-token",
            },
        },
    )
    assert active_accepted.status_code == 200
    active_artifact = client.get(f"/api/fusion/artifacts/{active_accepted.json()['artifact_id']}")
    assert active_artifact.status_code == 200
    active_artifact_text = json.dumps(active_artifact.json())
    assert active_artifact.json()["permission_result"] == {
        "decision": "approved",
        "artifact_id": "permission-api-log",
        "policy_id": "fusion-active-network",
    }
    assert "secret-api-token" not in active_artifact_text

    accepted = client.post(
        "/api/fusion/actions",
        json={
            "component": "open-design",
            "action": "artifact_create",
            "tool_name": "design_artifact",
            "payload": {"name": "demo"},
            "artifact_refs": [
                {
                    "artifact_id": "demo-html",
                    "kind": "html",
                    "path": str(ROOT / "third_party" / "open-design" / "demo.html"),
                    "url": "https://preview.example.test/demo?token=secret",
                }
            ],
        },
    )
    assert accepted.status_code == 200
    assert "path" not in accepted.json()
    artifact = client.get(f"/api/fusion/artifacts/{accepted.json()['artifact_id']}")
    assert artifact.status_code == 200
    assert artifact.json()["component"] == "open-design"
    artifact_text = json.dumps(artifact.json())
    assert artifact.json()["artifact_refs"] == [{"artifact_id": "demo-html", "kind": "html"}]
    assert "third_party" not in artifact_text
    assert "token" not in artifact_text.lower()
    assert "secret" not in artifact_text.lower()


def test_fusion_api_run_lifecycle_endpoints(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    calls: list[list[str]] = []

    class Completed:
        returncode = 0
        stdout = json.dumps([{"Service": "fusion-osiris", "State": "running", "Health": "healthy"}])
        stderr = ""

    def fake_run(command, *, cwd, capture_output, text, timeout, check):  # noqa: ANN001
        calls.append(command)
        return Completed()

    monkeypatch.setattr("superclaw.fusion.subprocess.run", fake_run)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    start = client.post("/api/fusion/start", json={"profile": "all"})
    assert start.status_code == 200
    assert start.json()["execute"] is False
    assert {step["component"] for step in start.json()["steps"]} >= {"osiris", "open-design", "openpencil"}

    stop = client.post("/api/fusion/stop", json={"profile": "all", "execute": True})
    assert stop.status_code == 200
    assert stop.json()["execution"]["status"] == "stopped"
    assert ["docker", "compose", "--profile", "all", "down"] in calls

    run_status = client.get("/api/fusion/run-status", params={"profile": "all"})
    assert run_status.status_code == 200
    body = run_status.json()
    assert body["ok"] is True
    osiris = next(svc for svc in body["services"] if svc["component"] == "osiris")
    assert osiris["running"] is True
    assert "stdout" not in body


def test_fusion_api_run_endpoints_reject_unknown_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    for response in (
        client.post("/api/fusion/start", json={"profile": "bogus/sk_live_should_not_echo"}),
        client.post("/api/fusion/stop", json={"profile": "bogus/sk_live_should_not_echo"}),
        client.get("/api/fusion/run-status", params={"profile": "bogus/sk_live_should_not_echo"}),
    ):
        assert response.status_code == 400, response.text
        assert response.json()["detail"] == "unknown fusion profile"
        assert "sk_live_should_not_echo" not in json.dumps(response.json())


def test_api_request_validation_422_strips_echoed_input(tmp_path):
    # App-wide: the request-validation handler keeps 422 + loc/msg/type but never
    # reflects submitted input. Exercised here via the pre-existing actions
    # endpoint (wrong-typed + missing required field).
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    wrong_type = client.post(
        "/api/fusion/actions",
        json={"component": ["sk_live_should_not_echo"], "action": "lookup"},
    )
    missing_field = client.post("/api/fusion/actions", json={"action": "lookup"})

    for response in (wrong_type, missing_field):
        assert response.status_code == 422
        body = response.json()
        assert isinstance(body["detail"], list)
        assert all({"loc", "msg", "type"} >= set(item) for item in body["detail"])
        serialized = json.dumps(body)
        assert "input" not in serialized
    assert "sk_live_should_not_echo" not in json.dumps(wrong_type.json())


def test_fusion_api_malformed_body_422_does_not_echo_input(tmp_path, monkeypatch):
    # A wrong-typed profile bypasses the 400 unknown_profile branch and hits
    # request validation; the 422 body must not reflect the submitted value.
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post("/api/fusion/start", json={"profile": ["sk_live_should_not_echo"]})

    assert response.status_code == 422
    serialized = json.dumps(response.json())
    assert "sk_live_should_not_echo" not in serialized
    assert "input" not in serialized


def test_fusion_api_run_endpoints_are_control_token_gated(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ROOT", str(ROOT))
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    assert client.post("/api/fusion/start", json={"profile": "all"}).status_code == 401
    assert client.post("/api/fusion/stop", json={"profile": "all"}).status_code == 401
    assert client.get("/api/fusion/run-status").status_code == 401

    headers = {"X-SuperClaw-Token": "secret-control"}
    assert client.post("/api/fusion/start", json={"profile": "all"}, headers=headers).status_code == 200


def test_fusion_api_rejects_noncanonical_artifact_id_alias(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(tmp_path / "fusion-artifacts"))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    accepted = client.post(
        "/api/fusion/actions",
        json={
            "component": "open-design",
            "action": "artifact_create",
            "tool_name": "design_artifact",
            "payload": {"name": "demo"},
        },
    )

    assert accepted.status_code == 200
    artifact_id = accepted.json()["artifact_id"]
    alias = artifact_id.replace("_", ":", 1)
    assert alias != artifact_id

    response = client.get(f"/api/fusion/artifacts/{alias}")

    assert response.status_code == 404
    assert response.json()["detail"] == "fusion artifact not found"


def test_fusion_api_action_with_run_id_attaches_artifact_to_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(tmp_path / "fusion-artifacts"))
    app_instance = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app_instance)
    goal = client.post("/api/goals", json={"title": "Fusion evidence", "description": "Attach action artifact"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()

    accepted = client.post(
        "/api/fusion/actions",
        json={
            "component": "open-design",
            "action": "artifact_create",
            "tool_name": "design_artifact",
            "payload": {"name": "delivery-shell"},
            "artifact_refs": [{"artifact_id": "demo-html", "kind": "html"}],
            "run_id": run["run_id"],
        },
    )

    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    evidence = client.get(f"/api/runs/{run['run_id']}/evidence").json()
    matching = [item for item in evidence["artifacts"] if item["artifact_id"] == body["artifact_id"]]
    serialized_response = json.dumps(body)

    assert body["evidence_attached"] is True
    assert body["run_id"] == run["run_id"]
    assert "fusion-artifacts" not in serialized_response
    assert str(tmp_path) not in serialized_response
    assert matching
    assert matching[0]["kind"] == "fusion-action-json"
    assert matching[0]["path"] == f"superclaw-local://fusion/artifacts/{body['artifact_id']}"
    assert matching[0]["sensitivity"] == "internal"
    assert str(tmp_path) not in json.dumps(matching[0])

    artifact = client.get(f"/api/fusion/artifacts/{body['artifact_id']}")
    run_artifact = client.get(f"/api/runs/{run['run_id']}/artifacts/{body['artifact_id']}")
    event_types = [event["type"] for event in app_instance.state.store.list_events(run["run_id"])]
    assert artifact.status_code == 200
    assert artifact.json()["run_id"] == run["run_id"]
    assert run_artifact.status_code == 200
    assert run_artifact.json()["artifact_id"] == body["artifact_id"]
    assert run_artifact.json()["component"] == "open-design"
    assert str(tmp_path) not in json.dumps(run_artifact.json())
    assert "fusion.action.recorded" in event_types


def test_fusion_api_action_rejects_missing_run_id_without_orphan_artifact(tmp_path, monkeypatch):
    fusion_artifact_dir = tmp_path / "fusion-artifacts"
    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(fusion_artifact_dir))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post(
        "/api/fusion/actions",
        json={
            "component": "openpencil",
            "action": "export",
            "tool_name": "codegen_export",
            "payload": {"format": "html"},
            "run_id": "run_missing",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "run evidence not found"
    assert list(fusion_artifact_dir.glob("*.json")) == []


def test_fusion_api_rejects_invalid_component_with_sanitized_error_without_orphan_artifact(tmp_path, monkeypatch):
    fusion_artifact_dir = tmp_path / "fusion-artifacts"
    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(fusion_artifact_dir))
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    response = client.post(
        "/api/fusion/actions",
        json={
            "component": "unknown/sk_live_should_not_echo",
            "action": "lookup",
            "tool_name": "dns_lookup",
            "payload": {"target": "example.com"},
        },
    )

    body = response.json()
    serialized = json.dumps(body).lower()
    assert response.status_code == 400
    assert body["code"] == "FUSION_INVALID_ACTION"
    assert body["detail"] == "invalid fusion action"
    assert "sk_live_should_not_echo" not in serialized
    assert "secret" not in serialized
    assert list(fusion_artifact_dir.glob("*.json")) == []


def test_fusion_run_artifact_rejects_mismatched_local_fusion_ref(tmp_path, monkeypatch):
    from superclaw.models import ArtifactRef

    monkeypatch.setenv("SUPERCLAW_FUSION_ARTIFACT_DIR", str(tmp_path / "fusion-artifacts"))
    app_instance = create_app(state_path=tmp_path / "state.db")
    client = TestClient(app_instance)
    goal = client.post("/api/goals", json={"title": "Fusion mismatch", "description": "Reject confused refs"}).json()
    run = client.post("/api/runs", json={"goal_id": goal["goal_id"], "dry_run": True}).json()
    evidence = app_instance.state.store.get_evidence(run["run_id"])
    evidence.add_artifact(
        ArtifactRef(
            kind="fusion-action-json",
            artifact_id="artifact_visible",
            path="superclaw-local://fusion/artifacts/artifact_other",
        )
    )
    app_instance.state.store.save_evidence(evidence)

    response = client.get(f"/api/runs/{run['run_id']}/artifacts/artifact_visible")

    assert response.status_code == 404
    assert response.json()["detail"] == "artifact reference mismatch"
