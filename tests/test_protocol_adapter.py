from superclaw.models import ArtifactRef, ChildExecution, EvidenceBundle, WorkerResult
from superclaw.protocol_adapter import (
    DELIVERY_PROTOCOL_ADAPTER_NAME,
    build_clawhunt_delivery_protocol_payload,
    build_clawhunt_submission_payload,
    default_solution_text,
)


def test_protocol_adapter_builds_v1_payload_without_mutating_evidence_bundle():
    bundle = EvidenceBundle(run_id="run_proto")
    long_output = "prefix-" + ("x" * 5005)
    bundle.probes.append({"name": "control_plane", "status_code": 200, "body": {"ok": True}})
    bundle.probes.append({"name": "control_plane", "status_code": 200, "body": {"ok": True}})
    bundle.commands.append({"command": "pytest -q", "exit_code": 0, "output": long_output})
    bundle.commands.append({"command": "pytest -q", "exit_code": 0, "output": long_output})
    bundle.worker_results.append(
        WorkerResult(
            task_id="task_1",
            role="verify",
            backend="local",
            command="pytest -q",
            exit_code=0,
            output=long_output,
            duration_seconds=0.5,
        )
    )
    bundle.artifacts.append(ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"))
    original_commands = list(bundle.commands)
    original_probes = list(bundle.probes)
    original_output = bundle.worker_results[0].output

    payload = build_clawhunt_submission_payload(
        solution_text=default_solution_text(bundle.run_id),
        evidence=bundle,
        attachments=["superclaw-run:run_proto"],
        package_manifest={"version": 1},
        cost_tracking={"tokens": 321},
    )

    assert payload.request_json["solution_text"].startswith("SuperClaw completed run run_proto")
    assert payload.request_json["attachments"] == ["superclaw-run:run_proto"]
    assert len(payload.request_json["evidence"]["commands"]) == 1
    assert payload.request_json["evidence"]["commands"][0]["output"] == long_output[-4000:]
    assert payload.evidence_summary["command_count"] == 1
    assert payload.unsupported_fields == {
        "agent_package_manifest": {"version": 1},
        "cost_tracking": {"tokens": 321},
    }
    assert bundle.commands == original_commands
    assert bundle.probes == original_probes
    assert bundle.worker_results[0].output == original_output


def test_protocol_adapter_handles_prebuilt_evidence_dict():
    payload = build_clawhunt_submission_payload(
        solution_text="done",
        evidence={"run_id": "run_dict", "commands": [], "probes": [], "artifacts": [], "findings": [], "worker_results": [], "chain_verdict": "CHAIN_PARTIAL"},
    )

    assert payload.request_json["solution_text"] == "done"
    assert payload.request_json["evidence"]["run_id"] == "run_dict"
    assert payload.evidence_summary["chain_verdict"] == "CHAIN_PARTIAL"


def test_protocol_adapter_builds_delivery_protocol_payload_without_mutating_evidence_bundle():
    bundle = EvidenceBundle(run_id="run_proto")
    bundle.add_probe("control_plane", 200, {"ok": True})
    bundle.add_command("python -m pytest -q", 0, "12 passed")
    bundle.add_worker_result(
        WorkerResult(
            task_id="task_1",
            role="verify",
            backend="local",
            command="python -m pytest -q",
            exit_code=0,
            output="12 passed",
            duration_seconds=0.5,
        )
    )
    bundle.add_artifact(ArtifactRef(kind="worker-log", path="artifacts/run.log", artifact_id="artifact_1"))
    original_commands = list(bundle.commands)
    original_output = bundle.worker_results[0].output

    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(bundle.run_id),
        name="SuperClaw delivery",
        summary="Machine-readable delivery package export",
        evidence=bundle,
        github_pr_url="https://github.com/example/repo/pull/7",
        github_pr_number=7,
        attachments=["superclaw-run:run_proto"],
        cost_tracking={"tokens": 321},
    )

    manifest = payload.request_json["agent_package_manifest"]

    assert payload.adapter_name == DELIVERY_PROTOCOL_ADAPTER_NAME
    assert payload.request_json["solution_text"].startswith("SuperClaw completed run run_proto")
    assert payload.request_json["github_pr_url"] == "https://github.com/example/repo/pull/7"
    assert payload.request_json["github_pr_number"] == 7
    assert manifest["name"] == "SuperClaw delivery"
    assert manifest["version"] == "0.1.0"
    assert manifest["interface"]["type"] == "workflow"
    assert manifest["runtime"]["language"] == "python"
    assert manifest["standardization"]["level"] == "L2"
    assert manifest["acceptance"]["tests"] == ["python -m pytest -q"]
    assert "plugin_evidence" not in manifest
    assert manifest["examples"][0]["name"] == "control_plane"
    assert payload.unsupported_fields["attachments"] == ["superclaw-run:run_proto"]
    assert payload.unsupported_fields["cost_tracking"] == {"tokens": 321}
    assert payload.unsupported_fields["evidence"]["run_id"] == "run_proto"
    assert bundle.commands == original_commands
    assert bundle.worker_results[0].output == original_output


def test_delivery_protocol_manifest_exports_sanitized_plugin_invocation_summaries():
    bundle = EvidenceBundle(run_id="run_plugin_proto")
    bundle.add_probe(
        "plugin_invocation",
        200,
        {
            "plugin_id": "dev.superclaw.hello-world",
            "plugin_version": "1.2.3",
            "package_digest": "sha256:" + ("a" * 64),
            "tool_name": "hello",
            "status": "ok",
            "started_at": "2026-06-01T00:00:00Z",
            "finished_at": "2026-06-01T00:00:01Z",
            "entitlement_id": "ent_local_123",
            "input_digest": "sha256:" + ("b" * 64),
            "output_digest": "sha256:" + ("c" * 64),
            "evidence_artifact_id": "plugininv_123",
            "policy_decision": "PLUGIN_OK: secret-like cph_secret1234567890123 should not be exported",
            "sandbox_exit_status": 0,
            "output_payload": {"secret": "cph_secret1234567890123"},
            "stdout": "raw stdout",
            "stderr": "raw stderr",
        },
    )
    bundle.add_artifact(
        ArtifactRef(
            kind="plugin-invocation",
            path="/private/tmp/protected-cache/plugininv_123.json",
            artifact_id="plugininv_123",
            metadata={"plugin_id": "dev.superclaw.hello-world", "tool_name": "hello", "status": "ok"},
        )
    )
    original_probe_body = dict(bundle.probes[0]["body"])

    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(bundle.run_id),
        name="Plugin delivery",
        summary="Plugin evidence export",
        evidence=bundle,
    )

    manifest = payload.request_json["agent_package_manifest"]
    invocation = manifest["plugin_evidence"]["invocations"][0]
    manifest_text = str(manifest)

    assert len(manifest["plugin_evidence"]["invocations"]) == 1
    assert invocation == {
        "plugin_id": "dev.superclaw.hello-world",
        "plugin_version": "1.2.3",
        "package_digest": "sha256:" + ("a" * 64),
        "tool_name": "hello",
        "status": "ok",
        "started_at": "2026-06-01T00:00:00Z",
        "finished_at": "2026-06-01T00:00:01Z",
        "entitlement_id": "ent_local_123",
        "input_digest": "sha256:" + ("b" * 64),
        "output_digest": "sha256:" + ("c" * 64),
        "evidence_artifact_id": "plugininv_123",
        "policy_decision_code": "PLUGIN_OK",
        "sandbox_exit_status": 0,
    }
    assert manifest["observability"]["plugin_invocation_count"] == 1
    assert manifest["security"]["plugin_package_digests"] == ["sha256:" + ("a" * 64)]
    assert manifest["examples"] == []
    assert "output_payload" not in manifest_text
    assert "raw stdout" not in manifest_text
    assert "raw stderr" not in manifest_text
    assert "cph_secret1234567890123" not in manifest_text
    assert "/private/tmp/protected-cache" not in manifest_text
    assert bundle.probes[0]["body"] == original_probe_body


def test_delivery_protocol_manifest_exports_artifact_only_plugin_evidence_fallback():
    bundle = EvidenceBundle(run_id="run_artifact_only")
    bundle.add_artifact(
        ArtifactRef(
            kind="plugin-invocation",
            path="/private/tmp/protected-cache/plugininv_artifact.json",
            artifact_id="plugininv_artifact",
            metadata={"plugin_id": "dev.superclaw.repo-scan", "tool_name": "scan", "status": "denied"},
        )
    )

    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(bundle.run_id),
        name="Artifact-only plugin delivery",
        summary="Plugin evidence export",
        evidence=bundle,
    )

    manifest = payload.request_json["agent_package_manifest"]

    assert manifest["plugin_evidence"]["invocations"] == [
        {
            "plugin_id": "dev.superclaw.repo-scan",
            "tool_name": "scan",
            "status": "denied",
            "evidence_artifact_id": "plugininv_artifact",
        }
    ]
    assert manifest["observability"]["plugin_invocation_count"] == 1
    assert "/private/tmp/protected-cache" not in str(manifest)


def test_delivery_protocol_manifest_exports_sanitized_child_execution_summaries():
    bundle = EvidenceBundle(run_id="run_child_proto")
    bundle.add_child_execution(
        ChildExecution(
            child_task_id="childtask_1",
            child_run_id="run_child_1",
            parent_run_id="run_child_proto",
            parent_task_id="task_parent",
            backend="local",
            status="completed",
            depth=1,
            timeout_seconds=30,
            chain_verdict="E2E_PROVEN",
            evidence_artifact_id="child_evidence_1",
            evidence_path="/private/tmp/superclaw/run_child_1/evidence.json",
        )
    )

    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(bundle.run_id),
        name="Child execution delivery",
        summary="Subagent evidence export",
        evidence=bundle,
    )

    manifest = payload.request_json["agent_package_manifest"]
    execution = manifest["child_evidence"]["executions"][0]
    manifest_text = str(manifest)

    assert execution == {
        "child_task_id": "childtask_1",
        "child_run_id": "run_child_1",
        "parent_task_id": "task_parent",
        "backend": "local",
        "status": "completed",
        "depth": 1,
        "cancellation_mode": "linked",
        "timeout_seconds": 30,
        "evidence_owner": "child",
        "chain_verdict": "E2E_PROVEN",
        "evidence_artifact_id": "child_evidence_1",
    }
    assert manifest["interface"]["outputs"]["child_execution_count"] == 1
    assert "/private/tmp/superclaw" not in manifest_text
    assert "evidence_path" not in manifest_text


def test_delivery_protocol_manifest_surfaces_finding_aggregates_without_leaking_detail():
    bundle = EvidenceBundle(run_id="run_findings")
    bundle.add_finding(
        "secret_redaction",
        False,
        "LEAKED cph_secret_xyz at /private/tmp/protected-cache/x.json",
        "critical",
        remediation="rotate the exposed credential immediately",
    )
    bundle.add_finding("backend_readiness", True, "all backends ready", "info")
    bundle.add_finding("command_backed_verification", True, "ok", "info")

    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text(bundle.run_id),
        name="Findings delivery",
        summary="finding aggregate export",
        evidence=bundle,
    )
    manifest = payload.request_json["agent_package_manifest"]
    security = manifest["security"]

    # 纯数字聚合 surface 进 manifest（回应"findings 看似漏接 wiring"的疑点）
    assert security["finding_count"] == 3
    assert security["findings_by_severity"] == {"critical": 1, "info": 2}
    assert security["failed_finding_count"] == 1

    # fail-closed：finding 的自由文本（detail/remediation）与 name 绝不进外发 manifest
    manifest_text = str(manifest)
    assert "LEAKED" not in manifest_text
    assert "cph_secret_xyz" not in manifest_text
    assert "/private/tmp/protected-cache" not in manifest_text
    assert "rotate the exposed credential" not in manifest_text
    assert "secret_redaction" not in manifest_text
    assert "backend_readiness" not in manifest_text
    assert "command_backed_verification" not in manifest_text


def test_delivery_protocol_manifest_clamps_malformed_finding_severity_failclosed():
    # prebuilt dict evidence 路径：finding 不受 add_finding() 约束，可能 malformed/被污染。
    # severity 必须 clamp 到固定枚举，非 dict item 不得崩——否则任意文本会外发或整链崩溃。
    evidence = {
        "run_id": "run_malformed",
        "commands": [],
        "probes": [],
        "artifacts": [],
        "worker_results": [],
        "findings": [
            {"severity": "critical SECRET_LEAK_xyz", "passed": False},  # 被污染的 severity 文本
            "not-a-dict-finding",  # malformed：根本不是 dict
            {"severity": "high", "passed": True},
        ],
    }
    payload = build_clawhunt_delivery_protocol_payload(
        solution_text=default_solution_text("run_malformed"),
        name="Malformed findings",
        summary="fail-closed severity clamp",
        evidence=evidence,
    )
    manifest = payload.request_json["agent_package_manifest"]
    security = manifest["security"]

    # 被污染的 severity 文本 clamp 成 unknown，绝不原样外发；malformed 非 dict 也归 unknown 且不崩
    assert security["findings_by_severity"] == {"unknown": 2, "high": 1}
    assert "SECRET_LEAK_xyz" not in str(manifest)
    # 只有合法 dict 且 passed=False 计 failed（第一个）；malformed 非 dict 无法判定 passed，不计
    assert security["failed_finding_count"] == 1
    assert security["finding_count"] == 3
